import { LUCK_TOKEN, PRESALE_TOKENS_PER_SOL } from '../config'

// ---------------------------------------------------------------------------
// The value maths behind the Value tab
// ---------------------------------------------------------------------------
// Kept out of the component so the numbers can be read, checked and reused
// without going through JSX. Everything here is arithmetic on the presale
// price; nothing predicts anything.
//
// The multiplier is an input the VISITOR chooses with a slider. It is not a
// forecast, and the page has to keep saying so — a calculator that only shows
// "10x = this much money" and never shows what 10x would imply is the shape of
// every presale page that ends badly. That is why projectValue also returns the
// fully diluted valuation: it turns "10x" from a wish into a number a person
// can weigh against the market they already know.

/** SOL per $LUCK at the fixed presale price. */
export const TGE_PRICE_SOL = 1 / PRESALE_TOKENS_PER_SOL

/**
 * The fully diluted valuation at the presale price, in SOL: every token that
 * will ever exist, priced at what the presale charges for it.
 */
export const TGE_FDV_SOL = LUCK_TOKEN.totalSupply / PRESALE_TOKENS_PER_SOL

/**
 * The share of a presale allocation that can actually be claimed on TGE day.
 * The rest unlocks weekly (see VESTING_SCHEDULE) — so "what it is worth at
 * TGE" and "what you can sell at TGE" are two different numbers, and showing
 * only the first would overstate the day-one position by more than ten times.
 */
export const TGE_UNLOCK_FRACTION = 0.09

/** The slider's range, in multiples of the presale price. */
export const MULTIPLE_MIN = 0.1
export const MULTIPLE_MAX = 100

/**
 * The slider is logarithmic. On a linear 0.1x-100x bar, everything from a total
 * loss up to 5x would be squeezed into the first 5% of the track and be
 * unusable — while the far end, which is the least likely part, would get all
 * the room. In log space each equal step is an equal RATIO, so 1x lands at
 * exactly one third of the track and the downside stays reachable.
 */
export function multipleFromSlider(t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  return MULTIPLE_MIN * Math.pow(MULTIPLE_MAX / MULTIPLE_MIN, clamped)
}

/** The inverse — where a given multiple sits on the track, as 0..1. */
export function sliderFromMultiple(multiple: number): number {
  const clamped = Math.min(MULTIPLE_MAX, Math.max(MULTIPLE_MIN, multiple))
  return Math.log(clamped / MULTIPLE_MIN) / Math.log(MULTIPLE_MAX / MULTIPLE_MIN)
}

/** The $LUCK price at the presale rate, in USD, given a SOL price. */
export function tgePriceUsd(solUsd: number | null): number | null {
  return solUsd === null ? null : solUsd / PRESALE_TOKENS_PER_SOL
}

export interface Projection {
  /** Tokens bought with `amountSol` at the fixed presale price. */
  tokens: number
  /** Of those, the part claimable on TGE day. */
  tokensAtTge: number
  /** The chosen price as a multiple of the presale price. */
  multiple: number
  /** The same thing as a percentage change: 2x is +100%. */
  percentChange: number
  /** The $LUCK price at that multiple, in USD (null without a SOL price). */
  priceUsd: number | null
  /** What the whole allocation would be worth at that price. */
  valueSol: number
  valueUsd: number | null
  /** Profit or loss against what was paid. */
  profitSol: number
  profitUsd: number | null
  /** What the day-one claimable part would be worth. */
  tgeClaimableValueSol: number
  /** The fully diluted valuation that price implies. */
  fdvSol: number
  fdvUsd: number | null
}

/**
 * What `amountSol` spent in the presale turns into if the price ends up at
 * `multiple` times the presale price.
 *
 * The multiple applies to the price in USD and in SOL alike — the page states
 * that, because "10x" against a moving SOL price would otherwise mean two
 * different things and the difference would be ours to hide.
 */
export function projectValue(
  amountSol: number,
  multiple: number,
  solUsd: number | null,
): Projection {
  const spent = Number.isFinite(amountSol) && amountSol > 0 ? amountSol : 0
  const tokens = spent * PRESALE_TOKENS_PER_SOL
  const valueSol = spent * multiple
  const priceUsd = solUsd === null ? null : (solUsd / PRESALE_TOKENS_PER_SOL) * multiple
  const fdvSol = TGE_FDV_SOL * multiple

  return {
    tokens,
    tokensAtTge: tokens * TGE_UNLOCK_FRACTION,
    multiple,
    percentChange: (multiple - 1) * 100,
    priceUsd,
    valueSol,
    valueUsd: solUsd === null ? null : valueSol * solUsd,
    profitSol: valueSol - spent,
    profitUsd: solUsd === null ? null : (valueSol - spent) * solUsd,
    tgeClaimableValueSol: valueSol * TGE_UNLOCK_FRACTION,
    fdvSol,
    fdvUsd: solUsd === null ? null : fdvSol * solUsd,
  }
}
