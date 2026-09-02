import { useMemo, useState } from 'react'
import {
  LUCK_TOKEN,
  PRESALE_TARGET_SOL,
  PRESALE_TICKET_UNIT_SOL,
  PRESALE_TOKENS_PER_SOL,
} from '../../config'
import { useSolUsdPrice } from '../../lib/solPrice'
import { useHourlySnapshot, useTokenUsdPrice } from '../../lib/tokenPrice'
import {
  MULTIPLE_MARKS,
  MULTIPLE_MAX,
  MULTIPLE_MIN,
  TGE_FDV_SOL,
  multipleFromSlider,
  projectValue,
  sliderFromMultiple,
  tgePriceUsd,
} from '../../lib/luckValue'

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
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
  const digits = abs === 0 ? 2 : abs >= 100 ? 0 : abs >= 1 ? 2 : 4
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

function formatCompact(n: number): string {
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })
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

const QUICK_AMOUNTS = [0.5, 1, 5, 10, 25]

/** Which currency the calculator answers in. */
type Unit = 'usd' | 'sol'

export function ValueTab() {
  const solUsd = useSolUsdPrice()
  const live = useTokenUsdPrice(LUCK_TOKEN.mint || null)

  const [amountText, setAmountText] = useState('1')
  // The MULTIPLE is the state, not the thumb position. Storing the position
  // instead put the range input's 0.001 step between a clicked mark and the
  // number it prints: clicking "2×" landed on 1.9998, which rounded to "2×" in
  // the heading while the rows below quietly showed a gain of 0.9998 SOL.
  const [multiple, setMultiple] = useState(2)
  const [unit, setUnit] = useState<Unit>('usd')

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

  // With no SOL price there are no dollars to switch to, so the toggle is not
  // offered and every figure falls back to SOL. The page stays whole without
  // the price service rather than filling with dashes.
  const dollarsAvailable = solUsd !== null
  const shownUnit: Unit = dollarsAvailable ? unit : 'sol'
  const money = (sol: number, usd: number | null) =>
    shownUnit === 'usd' && usd !== null ? formatUsd(usd) : formatSol(sol)

  // Where the live price sits against the presale price. Only meaningful once
  // the coin actually trades — before that it is not "1x", it is nothing.
  const liveMultiple =
    live.price !== null && tgeUsd !== null && tgeUsd > 0 ? live.price / tgeUsd : null

  const liveState =
    live.status === 'live' ? 'on' : live.status === 'unavailable' ? 'off' : 'idle'
  const liveLabel =
    live.status === 'live'
      ? formatUsdPrice(live.price)
      : live.status === 'loading'
        ? 'Loading'
        : live.status === 'unavailable'
          ? 'Unavailable'
          : 'Not trading yet'
  const liveNote =
    live.status === 'live'
      ? liveMultiple === null
        ? 'Live market price.'
        : `${formatMultiple(liveMultiple)} the presale price · ${formatPercent((liveMultiple - 1) * 100)}`
      : live.status === 'unavailable'
        ? 'The price service could not be reached — this says nothing about the price itself.'
        : live.status === 'loading'
          ? 'Asking the price service.'
          : 'It gets a market price when the pool opens at TGE.'

  const breakEven = Math.abs(projection.profitSol) < 1e-9
  const profitPositive = projection.profitSol >= 0

  // The whole range at once. Dragging answers "what about 7x"; this answers
  // "what does the range look like", which is the question a slider cannot
  // show and the reason the table is here rather than a chart of it — value is
  // a straight multiple of the price, so a plot of it would draw a line the
  // reader already knows the shape of.
  const ladder = useMemo(
    () => MULTIPLE_MARKS.map((m) => ({ m, p: projectValue(amountSol, m, solUsd) })),
    [amountSol, solUsd],
  )
  // Which ladder row the slider is currently nearest, compared as a ratio so
  // "nearest" means the same thing at 2x as at 100x.
  const activeMark = MULTIPLE_MARKS.reduce((best, m) =>
    Math.abs(Math.log(m / multiple)) < Math.abs(Math.log(best / multiple)) ? m : best,
  )

  const fillPercent = sliderFromMultiple(multiple) * 100

  return (
    <div className="luck-value">
      <section className="luck-value__hero">
        <div className="luck-value__hero-main">
          <span className="luck-value__eyebrow">Presale price</span>
          <strong className="luck-value__hero-figure">
            {tgeUsdHourly === null
              ? formatTokens(PRESALE_TOKENS_PER_SOL)
              : formatUsdPrice(tgeUsdHourly)}
          </strong>
          <span className="luck-value__hero-unit">
            {tgeUsdHourly === null ? '$LUCK per 1 SOL' : 'per $LUCK'}
          </span>
          <p className="luck-value__hero-sub">
            <strong>1 SOL = {formatTokens(PRESALE_TOKENS_PER_SOL)} $LUCK</strong> for the whole
            presale.{' '}
            {hourly.value === null
              ? 'The dollar figure needs a live SOL price, which has not arrived yet.'
              : `The dollar figure follows SOL — read at ${formatClock(
                  hourly.takenAt,
                )}, SOL at ${formatUsd(hourly.value)}.`}
          </p>
        </div>

        <div className="luck-value__hero-side">
          <span className={`luck-value__pill luck-value__pill--${liveState}`}>
            <i aria-hidden="true" />
            Market price
          </span>
          <strong className="luck-value__hero-live">{liveLabel}</strong>
          <span className="luck-value__hero-livenote">{liveNote}</span>
        </div>
      </section>

      <ol className="luck-value__how">
        <li>
          <span className="luck-value__how-step">1</span>
          <div>
            <strong>One rate, for the whole presale.</strong> Every contribution is priced at 1 SOL
            = {formatTokens(PRESALE_TOKENS_PER_SOL)} $LUCK. It does not rise as more is raised, and
            the first day and the last day get the same tokens per SOL.
          </div>
        </li>
        <li>
          <span className="luck-value__how-step">2</span>
          <div>
            <strong>The dollar figure moves, the rate does not.</strong> The price is fixed in SOL,
            not in dollars, so what one $LUCK costs in dollars follows SOL. That is why the figure
            above is read from the market once an hour instead of written into the page.
          </div>
        </li>
        <li>
          <span className="luck-value__how-step">3</span>
          <div>
            <strong>At TGE the market takes over.</strong> The liquidity pool opens and buyers and
            sellers set the price from then on, so the presale rate stops being the price and
            becomes what you paid. Until then there is no market price at all.
          </div>
        </li>
      </ol>

      <div className="luck-value__stats">
        <div className="luck-value__stat">
          <span>Valuation at the presale price</span>
          <strong>
            {hourly.value === null
              ? formatSol(TGE_FDV_SOL)
              : formatUsd(TGE_FDV_SOL * hourly.value)}
          </strong>
          <small>{formatSol(TGE_FDV_SOL)} — every token that will ever exist</small>
        </div>
        <div className="luck-value__stat">
          <span>Total supply</span>
          <strong>{formatCompact(LUCK_TOKEN.totalSupply)}</strong>
          <small>{formatTokens(LUCK_TOKEN.totalSupply)} $LUCK, fixed at launch</small>
        </div>
        <div className="luck-value__stat">
          <span>Presale target</span>
          <strong>{PRESALE_TARGET_SOL} SOL</strong>
          <small>
            {hourly.value === null
              ? 'The pool opens once it is filled'
              : `${formatUsd(PRESALE_TARGET_SOL * hourly.value)} — the pool opens once it is filled`}
          </small>
        </div>
      </div>

      <section className="luck-value__calc">
        <div className="luck-value__calc-head">
          <h3>What would it be worth?</h3>
          {dollarsAvailable && (
            <div className="luck-value__toggle" role="group" aria-label="Currency">
              {(['usd', 'sol'] as Unit[]).map((u) => (
                <button
                  key={u}
                  type="button"
                  className={unit === u ? 'is-on' : ''}
                  aria-pressed={unit === u}
                  onClick={() => setUnit(u)}
                >
                  {u === 'usd' ? 'USD' : 'SOL'}
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="field luck-value__amount">
          <span>What you put into the presale</span>
          <div className="luck-value__amount-box">
            <input
              type="number"
              min="0"
              step="0.1"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
            <span className="luck-value__amount-unit">SOL</span>
          </div>
          {amountSol > 0 && projection.valueAtTgeUsd !== null && (
            <small>{formatUsd(projection.valueAtTgeUsd)} at today&apos;s SOL price</small>
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
            // The filled part of the track is painted from this, so the bar
            // reads as a level rather than as a bare groove with a dot on it.
            style={{ '--fill': `${fillPercent}%` } as React.CSSProperties}
            onChange={(e) => setMultiple(multipleFromSlider(Number(e.target.value)))}
            aria-label="Price as a multiple of the presale price"
          />
          <div className="luck-value__marks">
            {MULTIPLE_MARKS.map((m) => (
              <button
                key={m}
                type="button"
                className={`luck-value__mark ${m === activeMark ? 'is-on' : ''}`}
                style={{
                  left: `${sliderFromMultiple(m) * 100}%`,
                  transform:
                    m === MULTIPLE_MARKS[0]
                      ? 'none'
                      : m === MULTIPLE_MARKS[MULTIPLE_MARKS.length - 1]
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
            rather than steps, so every equal slide is an equal ratio.
          </p>
        </div>

        <div className="luck-value__result">
          <div className="luck-value__result-main">
            <span>Your {formatSol(amountSol > 0 ? amountSol : 0)} would be worth</span>
            <strong>{money(projection.valueSol, projection.valueUsd)}</strong>
          </div>
          <div
            className={`luck-value__result-delta ${
              breakEven ? '' : profitPositive ? 'is-up' : 'is-down'
            }`}
          >
            <span>{breakEven ? 'Break even' : profitPositive ? 'Gain' : 'Loss'}</span>
            <strong>
              {breakEven ? '' : profitPositive ? '+' : ''}
              {money(projection.profitSol, projection.profitUsd)}
            </strong>
          </div>
        </div>

        <ul className="luck-value__rows">
          <li>
            <span>$LUCK you receive</span>
            <strong>{formatTokens(projection.tokens)} $LUCK</strong>
          </li>
          <li>
            <span>Worth at the TGE price</span>
            <strong>{money(projection.valueAtTgeSol, projection.valueAtTgeUsd)}</strong>
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
            <strong>{money(projection.fdvSol, projection.fdvUsd)}</strong>
          </li>
        </ul>
      </section>

      <section className="luck-value__ladder">
        <h3>The whole range at a glance</h3>
        <p className="luck-value__ladder-sub">
          The same {formatSol(amountSol > 0 ? amountSol : 0)}, at every step of the bar. Tap a row
          to move the slider there.
        </p>
        <div className="luck-value__table-wrap">
          <table className="luck-value__table">
            <thead>
              <tr>
                <th scope="col">Price</th>
                <th scope="col">1 $LUCK</th>
                <th scope="col">Your stack</th>
              </tr>
            </thead>
            <tbody>
              {ladder.map(({ m, p }) => (
                <tr
                  key={m}
                  className={m === activeMark ? 'is-on' : ''}
                  onClick={() => setMultiple(m)}
                >
                  <th scope="row">{m}×</th>
                  <td>{formatUsdPrice(p.priceUsd)}</td>
                  <td>{money(p.valueSol, p.valueUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="luck-value__ladder-foot">
          Every multiple on this page is a number you picked, not a forecast. The bar starts at{' '}
          {MULTIPLE_MIN}× and only goes up; the price can also fall below the presale price.
        </p>
      </section>
    </div>
  )
}
