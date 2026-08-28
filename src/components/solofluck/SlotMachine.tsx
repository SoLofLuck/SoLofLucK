import { useEffect, useRef, useState } from 'react'
import slotMachineImg from '../../assets/slot-machine.png'

// Purely a visual layer — the real win/lose outcome and prize amount are
// always read from the chain (parsePlayResolvedFromTx); this file only decides
// WHICH combination is shown and WHEN it is revealed. The backdrop is the gold
// slot-machine image the user produced themselves
// (src/assets/slot-machine.png).
//
// Timing (from user feedback: "the slot just spins forever, it looks nothing
// like the real thing" + "after 15-20 seconds it should land on 3 different
// symbols"): when a round starts, the total duration is chosen HERE at random
// between 15 and 20 seconds, and no matter how early the outcome becomes known
// (on free spins it is known instantly) the reels do not stop before that time
// is up. At the end the reels stop ONE BY ONE, left to right, ~1.4s apart —
// not all at once, exactly like a real slot machine.
//
// If the chain side is slow (on purchased spins the gap between play() and
// resolve() can stretch into minutes) the reels stop spinning after 10s and
// switch to a shimmering waiting frame; once the result arrives they spin up
// again for a short "reveal" (at least 2.2s) and then land in sequence.
export type SlotResult = 'idle' | 'win' | 'lose'

interface Props {
  spinning: boolean
  result: SlotResult
  /** When result is 'win': is this the big (jackpot) prize or the small one. */
  bigWin?: boolean
  /** Called once all three reels have stopped and the result is revealed. */
  onLanded?: () => void
}

type Combo = [string, string, string]

const LOSE_COMBOS: Combo[] = [
  ['7', '🍒', '🍋'],
  ['💎', '7', '🍀'],
  ['🍋', '🔔', '🍒'],
  ['🍀', '💎', '7'],
  ['🔔', '🍋', '🍒'],
]
const SMALL_WIN_COMBOS: Combo[] = [
  ['🍒', '🍒', '🍒'],
  ['🍋', '🍋', '🍋'],
  ['🔔', '🔔', '🔔'],
]
const BIG_WIN_COMBOS: Combo[] = [
  ['7', '7', '7'],
  ['💎', '💎', '💎'],
]

const REEL_SYMBOLS = ['7', '🍒', '🍋', '🔔', '💎', '🍀']

/** A round's total duration is picked at random from this range. */
const MIN_TOTAL_MS = 15000
const MAX_TOTAL_MS = 20000
/** When the reels switch to the waiting frame if the result still has not arrived. */
const HOLD_AFTER_MS = 10000
/** If the result arrives late: show at least this much "reveal" spin before
   landing. Kept above two stop gaps (2 x REEL_STOP_GAP_MS) so the first reel
   never stops instantly. */
const MIN_REVEAL_MS = 3600
/** The gap between one reel stopping and the next. */
const REEL_STOP_GAP_MS = 1400

function pickCombo(result: SlotResult, bigWin: boolean): Combo {
  const pool = result === 'lose' ? LOSE_COMBOS : bigWin ? BIG_WIN_COMBOS : SMALL_WIN_COMBOS
  return pool[Math.floor(Math.random() * pool.length)]
}

function randMs(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

// Picks 3 DIFFERENT symbols for the "held" (waiting) frame — never three of a
// kind, so it cannot suggest a win before the real result has arrived.
function pickWaitingCombo(): Combo {
  const shuffled = [...REEL_SYMBOLS].sort(() => Math.random() - 0.5)
  return [shuffled[0], shuffled[1], shuffled[2]]
}

function ReelStrip() {
  const symbols = [...REEL_SYMBOLS, ...REEL_SYMBOLS]
  return (
    <div className="luck-slot__reel-strip">
      {symbols.map((sym, i) => (
        <span key={i} className={sym === '7' ? 'luck-slot__sym luck-slot__sym--seven' : 'luck-slot__sym'}>
          {sym}
        </span>
      ))}
    </div>
  )
}

// Shows a single, fixed symbol on a reel — used both for "held" (the result
// has not arrived yet) and for reels that have stopped. The very same
// .luck-slot__sym class is used here (identical box model to the scrolling
// strip: height:100%, flex, centred) so that all three reels sit on exactly the
// same horizontal line whatever symbol or glyph they show — font metrics can
// differ between an emoji and the stylised "7".
function StaticSym({ sym }: { sym: string }) {
  return <span className={sym === '7' ? 'luck-slot__sym luck-slot__sym--seven' : 'luck-slot__sym'}>{sym}</span>
}

type Phase = 'idle' | 'spinning' | 'held' | 'landed'

export function SlotMachine({ spinning, result, bigWin = false, onLanded }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [combo, setCombo] = useState<Combo | null>(null)
  const [waitingCombo, setWaitingCombo] = useState<Combo>(() => pickWaitingCombo())
  // How many reels have stopped (0-3) — increments one at a time, left to right.
  const [stoppedReels, setStoppedReels] = useState(0)

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const startedAtRef = useRef(0)
  const totalMsRef = useRef(0)
  // Is a round in progress (true from the start until the third reel stops).
  const runningRef = useRef(false)
  // Has the landing already been scheduled this round (so a result is not
  // processed twice).
  const landingScheduledRef = useRef(false)
  const onLandedRef = useRef(onLanded)
  onLandedRef.current = onLanded

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
  }
  const addTimer = (fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, Math.max(0, ms)))
  }

  useEffect(() => clearTimers, [])

  // The plan for REVEALING the result on screen: the reels do not stop before
  // the total duration is up, then they land one by one, left to right. The
  // same function handles both "the result was known when the round started"
  // (free spin) and "the result arrived later" (chain).
  const scheduleLanding = (res: SlotResult) => {
    if (res === 'idle' || !runningRef.current || landingScheduledRef.current) return
    landingScheduledRef.current = true
    clearTimers()

    const now = Date.now()
    // Nothing lands before the total duration is up; and if the result arrived
    // very late, at least MIN_REVEAL_MS of reveal spin is still shown.
    const lastStopAt = Math.max(now + MIN_REVEAL_MS, startedAtRef.current + totalMsRef.current)
    const firstStopAt = lastStopAt - 2 * REEL_STOP_GAP_MS

    setPhase('spinning') // if we are on the waiting frame, start spinning again
    setCombo(pickCombo(res, bigWin))
    for (let i = 0; i < 3; i++) {
      addTimer(() => setStoppedReels(i + 1), firstStopAt + i * REEL_STOP_GAP_MS - now)
    }
    addTimer(() => {
      runningRef.current = false
      setPhase('landed')
      onLandedRef.current?.()
    }, lastStopAt - now + 120)
  }

  // --- Round start / cancel --------------------------------------------
  // A round starts when "spinning" goes false -> true. We do NOT rely on the
  // result being 'idle' at that moment: on a free spin GameTab sets both the
  // spin start and the result in the same synchronous block, React batches them
  // into a single render, and SlotMachine never sees result as 'idle'. (That is
  // why an earlier version never started the round at all: the reels stayed
  // hidden and the button stuck on "Reels are spinning...".) If the result is
  // already known at the start of the round we schedule the landing right away
  // — the total duration still governs the timing, knowing the result early
  // does not shorten the round.
  useEffect(() => {
    if (spinning && !runningRef.current) {
      clearTimers()
      runningRef.current = true
      landingScheduledRef.current = false
      startedAtRef.current = Date.now()
      totalMsRef.current = randMs(MIN_TOTAL_MS, MAX_TOTAL_MS)
      setCombo(null)
      setStoppedReels(0)
      setPhase('spinning')
      // If the result does not arrive within 10s (waiting on the chain), stop
      // spinning and switch to the waiting frame — this is where we cut off the
      // "it spins forever" feeling.
      addTimer(() => {
        setWaitingCombo(pickWaitingCombo())
        setPhase((ph) => (ph === 'spinning' ? 'held' : ph))
      }, HOLD_AFTER_MS)
      scheduleLanding(result)
    } else if (!spinning && runningRef.current) {
      // The game errored out, or a stuck attempt was cleared: cancel the round.
      clearTimers()
      runningRef.current = false
      landingScheduledRef.current = false
      setPhase('idle')
      setCombo(null)
      setStoppedReels(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinning, result])

  // --- The result arrived later (from the chain): schedule the landing -----
  useEffect(() => {
    scheduleLanding(result)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, bigWin])

  const allStopped = stoppedReels >= 3
  const reelsSpinning = (phase === 'spinning' || phase === 'held') && !allStopped
  const overlayVisible = phase !== 'idle'
  const containerPhaseClass =
    phase === 'held' ? 'luck-slot__reels--held' : phase === 'landed' ? 'luck-slot__reels--landed' : ''
  // The win/lose visuals (grey and dimmed on a loss, a gold pulse on a win) are
  // applied ONLY after the reels have landed. On a free spin the result is
  // already known when the round starts, so while this class was bound directly
  // to `result` the machine turned grey for the whole 15-20s and gave the
  // outcome away while the reels were still spinning.
  const shownResult = phase === 'landed' ? result : 'idle'

  return (
    <div className={`luck-slot luck-slot--${shownResult} ${phase === 'spinning' && !allStopped ? 'luck-slot--spinning' : ''}`}>
      <div className="luck-slot__frame">
        <img src={slotMachineImg} alt="777 Jackpot slot machine" className="luck-slot__img" />
        <div
          className={`luck-slot__reels ${overlayVisible ? 'luck-slot__reels--visible' : ''} ${containerPhaseClass}`}
          aria-hidden="true"
        >
          {[0, 1, 2].map((i) => {
            const stopped = combo !== null && i < stoppedReels
            return (
              <div
                className={`luck-slot__reel ${stopped ? 'luck-slot__reel--stopped' : reelsSpinning && phase !== 'held' ? 'luck-slot__reel--spinning' : ''}`}
                key={i}
              >
                {stopped && combo ? (
                  <StaticSym sym={combo[i]} />
                ) : phase === 'held' ? (
                  <StaticSym sym={waitingCombo[i]} />
                ) : phase !== 'idle' ? (
                  <ReelStrip />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
