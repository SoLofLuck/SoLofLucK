import { useEffect, useState } from 'react'
import { hourIndex } from './luckValue'

// ---------------------------------------------------------------------------
// Live token prices
// ---------------------------------------------------------------------------
// One polling loop per mint, shared by every component that asks for that mint,
// so ten places showing the SOL price still make one request every 30 seconds.
//
// SEVERAL SOURCES, TRIED IN ORDER. The first version asked one endpoint —
// Jupiter's price v2 — and when that host started refusing the request the
// whole page lost its dollar figures with nothing on screen explaining why. A
// price feed with a single source is a page that goes blank the day that
// source changes its terms, and public crypto endpoints change their terms
// often. So the sources are a LIST, each is tried until one answers, and the
// list is per mint: SOL is quoted by every exchange on earth, while an
// arbitrary mint is only known to the Solana aggregators.
//
// The status matters as much as the number. A missing price has three
// different causes and they are NOT the same thing to a visitor:
//
//   'unlisted'    — a source answered and has no price for this mint. Before
//                   launch that is the normal state, not an error.
//   'unavailable' — no source could be reached at all. The price may well
//                   exist; we just do not know it. Saying "not trading yet"
//                   here would be a lie every time the network hiccups.
//   'loading'     — the first round of requests has not come back yet.
//
// Collapsing these into a bare `number | null` is what made the earlier version
// unable to say anything truthful on the value page, where "there is no price"
// is the normal state right up until TGE.

const REFRESH_MS = 30_000
const TIMEOUT_MS = 8_000

export const SOL_MINT = 'So11111111111111111111111111111111111111112'

export type PriceStatus = 'loading' | 'live' | 'unlisted' | 'unavailable'

export interface PriceSnapshot {
  price: number | null
  status: PriceStatus
}

interface Source {
  name: string
  /** Only usable for SOL — these endpoints do not take a mint address. */
  solOnly?: boolean
  url: (mint: string) => string
  read: (json: unknown, mint: string) => number | null
}

const num = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

const at = (o: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>((v, k) => (v == null ? undefined : (v as Record<string, unknown>)[k]), o)

const SOURCES: Source[] = [
  {
    // Jupiter's free tier. `api.jup.ag` is the keyed host; `lite-api` is the
    // one that answers an anonymous browser, and v3 is the live version — v2,
    // which this file used to call, is retired.
    name: 'jupiter',
    url: (mint) => `https://lite-api.jup.ag/price/v3?ids=${mint}`,
    read: (json, mint) => num(at(json, mint, 'usdPrice')),
  },
  {
    // Knows any Solana mint that has a pool, which is exactly the case where
    // $LUCK starts having a price at all. The pair list is not ordered, so the
    // deepest pool is chosen rather than the first: a thin pool can quote a
    // price that no real trade could get.
    name: 'dexscreener',
    url: (mint) => `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    read: (json) => {
      const pairs = at(json, 'pairs')
      if (!Array.isArray(pairs)) return null
      let best: number | null = null
      let bestLiquidity = -1
      for (const pair of pairs) {
        const price = num(at(pair, 'priceUsd'))
        const liquidity = Number(at(pair, 'liquidity', 'usd')) || 0
        if (price !== null && liquidity > bestLiquidity) {
          best = price
          bestLiquidity = liquidity
        }
      }
      return best
    },
  },
  {
    name: 'coingecko',
    solOnly: true,
    url: () => 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    read: (json) => num(at(json, 'solana', 'usd')),
  },
  {
    name: 'binance',
    solOnly: true,
    url: () => 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
    read: (json) => num(at(json, 'price')),
  },
]

interface Feed {
  snapshot: PriceSnapshot
  lastFetchedAt: number
  inFlight: Promise<void> | null
  polling: boolean
  listeners: Set<(s: PriceSnapshot) => void>
}

const feeds = new Map<string, Feed>()

function getFeed(mint: string): Feed {
  let feed = feeds.get(mint)
  if (!feed) {
    feed = {
      snapshot: { price: null, status: 'loading' },
      lastFetchedAt: 0,
      inFlight: null,
      polling: false,
      listeners: new Set(),
    }
    feeds.set(mint, feed)
  }
  return feed
}

/**
 * Walks the sources until one answers with a price.
 *
 * `reached` says whether ANY source answered at all — that is what separates
 * "there is no market for this mint" from "we could not ask anybody", and the
 * two get different words on screen.
 */
async function fetchPrice(mint: string): Promise<{ reached: boolean; price: number | null }> {
  let reached = false
  for (const source of SOURCES) {
    if (source.solOnly && mint !== SOL_MINT) continue
    try {
      const res = await fetch(source.url(mint), { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) continue
      reached = true
      const price = source.read(await res.json(), mint)
      if (price !== null) return { reached: true, price }
    } catch {
      // This source is unreachable, refusing us, or too slow. Try the next
      // one; only running out of sources is a failure.
      continue
    }
  }
  return { reached, price: null }
}

function emit(feed: Feed) {
  const snapshot = feed.snapshot
  feed.listeners.forEach((listener) => listener(snapshot))
}

function refresh(mint: string): Promise<void> {
  const feed = getFeed(mint)
  if (feed.inFlight) return feed.inFlight
  if (Date.now() - feed.lastFetchedAt < REFRESH_MS && feed.snapshot.status !== 'loading') {
    return Promise.resolve()
  }
  feed.inFlight = (async () => {
    const { reached, price } = await fetchPrice(mint)
    feed.lastFetchedAt = Date.now()
    if (price !== null) {
      feed.snapshot = { price, status: 'live' }
    } else {
      // A price fetched earlier is kept: one empty round is not evidence that
      // trading stopped, and blanking a number that was right a minute ago is
      // worse than showing it a minute stale.
      const kept = feed.snapshot.price
      feed.snapshot = {
        price: kept,
        status: kept !== null ? 'live' : reached ? 'unlisted' : 'unavailable',
      }
    }
    emit(feed)
  })().finally(() => {
    feed.inFlight = null
  })
  return feed.inFlight
}

function startPolling(mint: string) {
  const feed = getFeed(mint)
  if (feed.polling) return
  feed.polling = true
  void refresh(mint)
  setInterval(() => void refresh(mint), REFRESH_MS)
}

const NO_MINT: PriceSnapshot = { price: null, status: 'unlisted' }

/**
 * The live USD price of one mint. An empty mint is not an error: before the
 * coin exists there is nothing to price, and the hook reports 'unlisted'
 * without making a request.
 */
export function useTokenUsdPrice(mint: string | null | undefined): PriceSnapshot {
  const [snapshot, setSnapshot] = useState<PriceSnapshot>(() =>
    mint ? getFeed(mint).snapshot : NO_MINT,
  )

  useEffect(() => {
    if (!mint) {
      setSnapshot(NO_MINT)
      return
    }
    const feed = getFeed(mint)
    setSnapshot(feed.snapshot)
    feed.listeners.add(setSnapshot)
    startPolling(mint)
    return () => {
      feed.listeners.delete(setSnapshot)
    }
  }, [mint])

  return snapshot
}

/**
 * Pins a value once an hour and reports when it was taken.
 *
 * Used for the dollar figure of the presale price. The underlying SOL price
 * refreshes every 30 seconds, which is right for anything quoting a live
 * market, and wrong for a price we describe as fixed: the number changed
 * under the reader's eyes while the text beside it said it never moves.
 *
 * The first non-null value is pinned immediately rather than waiting for the
 * next hour — otherwise the card would sit empty for up to an hour after the
 * page loaded.
 */
export function useHourlySnapshot(value: number | null): {
  value: number | null
  takenAt: number | null
} {
  const [snapshot, setSnapshot] = useState<{
    value: number | null
    takenAt: number | null
    hour: number | null
  }>({ value: null, takenAt: null, hour: null })

  useEffect(() => {
    const tick = () => {
      if (value === null) return
      const now = Date.now()
      const hour = hourIndex(now)
      setSnapshot((prev) =>
        prev.value !== null && prev.hour === hour ? prev : { value, takenAt: now, hour },
      )
    }
    tick()
    // Checked every minute rather than scheduled for the exact turn of the
    // hour: a timer set an hour ahead does not survive a phone locking the
    // tab, and being a minute late with an hourly figure costs nothing.
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [value])

  return { value: snapshot.value, takenAt: snapshot.takenAt }
}
