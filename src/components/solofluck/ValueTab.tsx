import { useMemo, useState } from 'react'
import { LUCK_TOKEN, PRESALE_TICKET_UNIT_SOL, PRESALE_TOKENS_PER_SOL } from '../../config'
import { useSolUsdPrice } from '../../lib/solPrice'
import { useHourlySnapshot, useTokenUsdPrice } from '../../lib/tokenPrice'
import {
  MULTIPLE_MARKS,
  MULTIPLE_MAX,
  TGE_FDV_SOL,
  multipleFromSlider,
  projectValue,
  sliderFromMultiple,
  tgePriceUsd,
} from '../../lib/luckValue'

// A token price is a very small number and the usual currency formatter, which
// stops at two decimals, renders every one of them as "$0.00". Significant
// digits are what carries the information here.
function formatUsdPrice(n: number | null): string {
  if (n === null) return '—'
  return `$${n.toLocaleString('en-US', { maximumSignificantDigits: 3 })}`
}

function formatUsd(n: number | null): string {
  if (n === null) return '—'
  const abs = Math.abs(n)
  const digits = abs === 0 || abs >= 100 ? (abs === 0 ? 2 : 0) : abs >= 1 ? 2 : 4
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

function formatSol(n: number): string {
  const abs = Math.abs(n)
  const digits = abs === 0 ? 2 : abs >= 1000 ? 0 : abs >= 1 ? 2 : 4
  return `${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} SOL`
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function formatMultiple(m: number): string {
  return `${m.toLocaleString('en-US', { maximumFractionDigits: m < 10 ? 2 : 1 })}×`
}

function formatClock(ms: number | null): string {
  if (ms === null) return ''
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatPercent(p: number): string {
  const sign = p >= 0 ? '+' : ''
  return `${sign}${p.toLocaleString('en-US', { maximumFractionDigits: p > -10 && p < 10 ? 1 : 0 })}%`
}

const MARKS = MULTIPLE_MARKS
const QUICK_AMOUNTS = [0.5, 1, 5, 10, 25]

export function ValueTab() {
  const solUsd = useSolUsdPrice()
  const live = useTokenUsdPrice(LUCK_TOKEN.mint || null)

  const [amountText, setAmountText] = useState('1')
  // The MULTIPLE is the state, not the thumb position. Storing the position
  // instead put the range input's 0.001 step between a clicked mark and the
  // number it prints: clicking "2×" landed on 1.9998, which rounded to "2×" in
  // the heading while the rows below quietly showed a gain of 0.9998 SOL.
  const [multiple, setMultiple] = useState(2)

  const amountSol = Number(amountText)

  // The presale price in dollars, read once an hour. See useHourlySnapshot:
  // the price is fixed in SOL, so re-deriving the dollar figure every 30
  // seconds made a price we call fixed visibly move on screen.
  const hourly = useHourlySnapshot(solUsd)
  const tgeUsdHourly = tgePriceUsd(hourly.value)

  // The calculator keeps the live rate: those figures are conversions of a
  // number the visitor just typed, and there is nothing fixed about them.
  const tgeUsd = tgePriceUsd(solUsd)
  const projection = useMemo(
    () => projectValue(amountSol, multiple, solUsd),
    [amountSol, multiple, solUsd],
  )

  // Where the live price sits against the presale price. Only meaningful once
  // the coin actually trades — before that it is not "1x", it is nothing.
  const liveMultiple =
    live.price !== null && tgeUsd !== null && tgeUsd > 0 ? live.price / tgeUsd : null

  const liveLabel =
    live.status === 'live'
      ? formatUsdPrice(live.price)
      : live.status === 'loading'
        ? 'Loading...'
        : live.status === 'unavailable'
          ? 'Cannot be read'
          : 'Not trading yet'

  const liveNote =
    live.status === 'live'
      ? liveMultiple === null
        ? 'Live market price.'
        : `${formatMultiple(liveMultiple)} the presale price (${formatPercent((liveMultiple - 1) * 100)}).`
      : live.status === 'unavailable'
        ? 'The price service could not be reached. This says nothing about the price itself — try again shortly.'
        : live.status === 'loading'
          ? 'Asking the price service.'
          : 'The coin has no market yet, so it has no market price. It gets one when the liquidity pool opens at TGE.'

  const breakEven = Math.abs(projection.profitSol) < 1e-9
  const profitPositive = projection.profitSol >= 0

  return (
    <div className="luck-value">
      <p className="subtab-desc">
        The presale price is fixed and known. A market price is not, and does not exist until the
        pool opens. This page keeps the two apart: what $LUCK costs in the presale, what it trades
        at once it trades, and a calculator where <strong>you</strong> pick a price and see what it
        would mean.
      </p>

      <div className="luck-value__cards">
        <div className="luck-value__card">
          <span className="luck-value__card-label">Presale price — fixed</span>
          <strong className="luck-value__card-value">
            {/* Without a SOL price there is no dollar figure at all, and a dash
                where the price goes reads as "the price is nothing" rather
                than "we have not got it yet". */}
            1 $LUCK = {tgeUsdHourly === null ? '...' : formatUsdPrice(tgeUsdHourly)}
          </strong>
          <span className="luck-value__card-note">
            1 SOL = {formatTokens(PRESALE_TOKENS_PER_SOL)} $LUCK, and that rate never changes.{' '}
            {hourly.value === null
              ? 'The dollar figure is waiting for the SOL price.'
              : `The dollar figure is read once an hour — last at ${formatClock(
                  hourly.takenAt,
                )}, with SOL at ${formatUsd(hourly.value)}.`}
          </span>
        </div>

        <div className="luck-value__card">
          <span className="luck-value__card-label">Market price — live</span>
          <strong className="luck-value__card-value">
            1 $LUCK = {liveLabel}
          </strong>
          <span className="luck-value__card-note">{liveNote}</span>
        </div>

        <div className="luck-value__card">
          <span className="luck-value__card-label">Valuation at the presale price</span>
          <strong className="luck-value__card-value">
            {hourly.value === null
              ? formatSol(TGE_FDV_SOL)
              : formatUsd(TGE_FDV_SOL * hourly.value)}
          </strong>
          <span className="luck-value__card-note">
            {hourly.value === null ? '' : `${formatSol(TGE_FDV_SOL)}. `}
            All {formatTokens(LUCK_TOKEN.totalSupply)} $LUCK priced at what the presale charges.
            This is the number a multiplier multiplies.
          </span>
        </div>
      </div>

      <div className="luck-value__calc">
        <h3 className="luck-value__calc-head">If the price ends up here, what is it worth?</h3>

        <label className="field luck-value__amount">
          <span>What you put into the presale (SOL)</span>
          <input
            type="number"
            min="0"
            step="0.1"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
          />
          {amountSol > 0 && projection.valueAtTgeUsd !== null && (
            <small>{formatUsd(projection.valueAtTgeUsd)}</small>
          )}
        </label>
        <div className="luck-value__quick">
          {QUICK_AMOUNTS.map((a) => (
            <button
              key={a}
              type="button"
              className={`luck-value__chip ${amountSol === a ? 'luck-value__chip--on' : ''}`}
              onClick={() => setAmountText(String(a))}
            >
              {a} SOL
            </button>
          ))}
        </div>

        <div className="luck-value__slider-block">
          <div className="luck-value__slider-head">
            <span>Price, as a multiple of the presale price</span>
            <strong className={breakEven ? '' : 'is-up'}>
              {`${formatMultiple(multiple)} · ${formatPercent(projection.percentChange)}`}
            </strong>
          </div>
          <input
            className="luck-value__slider"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={sliderFromMultiple(multiple)}
            onChange={(e) => setMultiple(multipleFromSlider(Number(e.target.value)))}
            aria-label="Price as a multiple of the presale price"
          />
          <div className="luck-value__marks">
            {MARKS.map((m) => (
              <button
                key={m}
                type="button"
                className="luck-value__mark"
                style={{
                  left: `${sliderFromMultiple(m) * 100}%`,
                  transform:
                    m === MARKS[0]
                      ? 'none'
                      : m === MARKS[MARKS.length - 1]
                        ? 'translateX(-100%)'
                        : 'translateX(-50%)',
                }}
                onClick={() => setMultiple(m)}
              >
                {m}×
              </button>
            ))}
          </div>
          <p className="luck-value__slider-foot">
            The bar starts at the presale price and runs to {MULTIPLE_MAX}×. It moves in ratios
            rather than steps, so every equal slide is an equal ratio. The multiple applies to the
            price in SOL and in dollars alike.
          </p>
        </div>

        <div className="luck-value__result">
          <div className="luck-value__result-main">
            <span>Your {formatSol(amountSol > 0 ? amountSol : 0)} would be worth</span>
            <strong>
              {projection.valueUsd === null
                ? formatSol(projection.valueSol)
                : formatUsd(projection.valueUsd)}
            </strong>
            {projection.valueUsd !== null && <small>{formatSol(projection.valueSol)}</small>}
          </div>
          <div
            className={`luck-value__result-delta ${
              breakEven ? '' : profitPositive ? 'is-up' : 'is-down'
            }`}
          >
            <span>{breakEven ? 'Break even' : profitPositive ? 'Gain' : 'Loss'}</span>
            <strong>
              {breakEven ? '' : profitPositive ? '+' : ''}
              {projection.profitUsd === null
                ? formatSol(projection.profitSol)
                : formatUsd(projection.profitUsd)}
            </strong>
            {projection.profitUsd !== null && (
              <small>
                {breakEven ? '' : profitPositive ? '+' : ''}
                {formatSol(projection.profitSol)}
              </small>
            )}
          </div>
        </div>

        <ul className="luck-value__rows">
          <li>
            <span>$LUCK you receive</span>
            <strong>{formatTokens(projection.tokens)} $LUCK</strong>
          </li>
          <li>
            <span>Worth at the TGE price</span>
            <strong>
              {projection.valueAtTgeUsd === null
                ? formatSol(projection.valueAtTgeSol)
                : `${formatUsd(projection.valueAtTgeUsd)} · ${formatSol(projection.valueAtTgeSol)}`}
            </strong>
          </li>
          <li>
            <span>$LUCK price here</span>
            <strong>{formatUsdPrice(projection.priceUsd)}</strong>
          </li>
          <li>
            <span>Raffle tickets</span>
            <strong>
              {amountSol > 0 ? Math.floor((amountSol + 1e-9) / PRESALE_TICKET_UNIT_SOL) : 0}
            </strong>
          </li>
          <li className="luck-value__rows-emph">
            <span>The whole coin at this price</span>
            <strong>
              {projection.fdvUsd === null
                ? formatSol(projection.fdvSol)
                : `${formatUsd(projection.fdvUsd)} · ${formatSol(projection.fdvSol)}`}
            </strong>
          </li>
        </ul>
      </div>
    </div>
  )
}
