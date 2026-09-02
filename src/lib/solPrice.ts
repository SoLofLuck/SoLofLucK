import { SOL_MINT, useTokenUsdPrice } from './tokenPrice'

/**
 * Returns the live SOL/USD price (refreshed roughly every 30 seconds).
 * Several components share the same polling loop, so no request is wasted.
 *
 * SOL always has a price, so callers here do not need the status the generic
 * feed carries: null means "we do not know yet", which is the only case a SOL
 * price display has to handle.
 */
export function useSolUsdPrice(): number | null {
  return useTokenUsdPrice(SOL_MINT).price
}
