import { useEffect, useState } from 'react'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const PRICE_URL = `https://api.jup.ag/price/v2?ids=${SOL_MINT}`
const REFRESH_MS = 30_000

let cachedPrice: number | null = null
let lastFetchedAt = 0
let inFlight: Promise<number | null> | null = null
let intervalStarted = false
const listeners = new Set<(price: number | null) => void>()

async function fetchSolPrice(): Promise<number | null> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const res = await fetch(PRICE_URL)
      const json = await res.json()
      const price = Number(json?.data?.[SOL_MINT]?.price)
      return Number.isFinite(price) ? price : null
    } catch {
      return null
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

async function refresh() {
  const now = Date.now()
  if (now - lastFetchedAt < REFRESH_MS && cachedPrice !== null) return
  const price = await fetchSolPrice()
  lastFetchedAt = Date.now()
  if (price !== null) cachedPrice = price
  listeners.forEach((l) => l(cachedPrice))
}

function ensureInterval() {
  if (intervalStarted) return
  intervalStarted = true
  refresh()
  setInterval(refresh, REFRESH_MS)
}

/**
 * Canlı SOL/USD fiyatını döner (yaklaşık 30 saniyede bir güncellenir).
 * Birden çok bileşen aynı polling döngüsünü paylaşır, gereksiz istek yapılmaz.
 */
export function useSolUsdPrice(): number | null {
  const [price, setPrice] = useState<number | null>(cachedPrice)

  useEffect(() => {
    ensureInterval()
    listeners.add(setPrice)
    if (cachedPrice !== null) setPrice(cachedPrice)
    return () => {
      listeners.delete(setPrice)
    }
  }, [])

  return price
}
