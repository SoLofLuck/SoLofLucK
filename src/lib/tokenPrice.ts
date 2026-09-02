import { useEffect, useState } from 'react'
import { hourIndex } from './luckValue'

// ---------------------------------------------------------------------------
// Live token prices (Jupiter)
// ---------------------------------------------------------------------------
// One polling loop per mint, shared by every component that asks for that mint,
// so ten places showing the SOL price still make one request every 30 seconds.
//
// The status matters as much as the number. A missing price has three
// different causes and they are NOT the same thing to a visitor:
//
//   'unlisted'    — the mint is not tradeable (or, before launch, does not
//                   exist yet). Jupiter answered; there is simply no market.
//                   Correct answer: "not trading yet", not "error".
//   'unavailable' — we could not reach Jupiter. The price may well exist; we
//                   just do not know it. Showing "not trading yet" here would
//                   be a lie the moment the network hiccups.
//   'loading'     — the first request has not come back yet.
//
// Collapsing these into a bare `number | null` is what made the earlier version
// unable to say anything truthful on the value page, where "there is no price"
// is the normal state right up until TGE.

const PRICE_ENDPOINT = 'https://api.jup.ag/price/v2?ids='
const REFRESH_MS = 30_000

export const SOL_MINT = 'So11111111111111111111111111111111111111112'

export type PriceStatus = 'loading' | 'live' | 'unlisted' | 'unavailable'

export interface PriceSnapshot {
  price: number | null
  status: PriceStatus
}

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
 * Asks Jupiter for one mint's USD price.
 *
 * `reached` separates "Jupiter said there is no price" from "we never got an
 * answer" — the two cases the UI has to word differently.
 */
async function fetchPrice(mint: string): Promise<{ reached: boolean; price: number | null }> {
  try {
    const res = await fetch(`${PRICE_ENDPOINT}${mint}`)
    if (!res.ok) return { reached: false, price: null }
    const json = await res.json()
    const price = Number(json?.data?.[mint]?.price)
    return { reached: true, price: Number.isFinite(price) && price > 0 ? price : null }
  } catch {
    return { reached: false, price: null }
  }
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
    } else if (reached) {
      // Jupiter answered and has no price for this mint: there is no market.
      // A price we fetched earlier is kept — a single empty answer is not
      // evidence that trading stopped.
      feed.snapshot = { price: feed.snapshot.price, status: feed.snapshot.price === null ? 'unlisted' : 'live' }
    } else {
      feed.snapshot = { price: feed.snapshot.price, status: feed.snapshot.price === null ? 'unavailable' : 'live' }
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
