import { Connection, PublicKey, SystemProgram, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import type { NetworkId } from '../config'
import { sendInstructions } from './sendTx'
import {
  PRESALE_DURATION_WEEKS,
  PRESALE_OPS_FEE_DEN,
  PRESALE_OPS_FEE_NUM,
  PRESALE_OPS_WALLET,
  PRESALE_SOFT_CAP_SOL,
  PRESALE_START_ISO,
  PRESALE_TARGET_SOL,
  PRESALE_TICKET_UNIT_SOL,
  PRESALE_TOKENS_PER_SOL,
  PRESALE_WALLET,
} from '../config'

// The Solana Memo program — used to note the presale contribution's mode and
// amount onto the chain, publicly visible, directly inside the transaction and
// without writing any custom program. That way, if an indexer or backend is
// added later, the ticket count can also be verified from these memo records.
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

export type PresaleMode = 'flex' | 'fixed'

export interface PresaleContributionResult {
  signature: string
  tickets: number
  amountSol: number
  mode: PresaleMode
}

function buildMemoIx(payer: PublicKey, text: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(text, 'utf-8'),
  })
}

export function calcTickets(amountSol: number): number {
  if (amountSol <= 0) return 0
  return Math.floor((amountSol + 1e-9) / PRESALE_TICKET_UNIT_SOL)
}

/** The operations share as a percentage (e.g. 0.777) — for display in the UI. */
export const PRESALE_OPS_FEE_PERCENT = (PRESALE_OPS_FEE_NUM / PRESALE_OPS_FEE_DEN) * 100

/** Is the operations share configured (with an empty wallet no share is taken). */
export const presaleOpsFeeActive = Boolean(PRESALE_OPS_WALLET) && PRESALE_OPS_FEE_NUM > 0

// ---------------------------------------------------------------------------
// Fixed price, target and progress
// ---------------------------------------------------------------------------

/** The amount of $LUCK received for a given amount of SOL (fixed price). */
export function tokensForSol(amountSol: number): number {
  if (!Number.isFinite(amountSol) || amountSol <= 0) return 0
  return amountSol * PRESALE_TOKENS_PER_SOL
}

/**
 * The balance the presale wallet must hold once the target is reached.
 *
 * The operations share is split out of the contribution in the SAME
 * transaction, so only the remainder enters the presale wallet — meaning a
 * 777 SOL target is not 777 in the presale wallet but 777 x (1 - share) SOL.
 * That is why the progress bar uses this threshold rather than the raw balance.
 */
export const PRESALE_TARGET_POOL_SOL =
  PRESALE_TARGET_SOL * (1 - PRESALE_OPS_FEE_NUM / PRESALE_OPS_FEE_DEN)

/** Derives the GROSS contribution raised back from the presale wallet balance. */
export function grossRaisedFromPoolSol(poolSol: number): number {
  const keepRatio = 1 - PRESALE_OPS_FEE_NUM / PRESALE_OPS_FEE_DEN
  if (keepRatio <= 0) return 0
  return poolSol / keepRatio
}

export interface PresaleProgress {
  /** The balance in the presale wallet (SOL). */
  poolSol: number
  /** The gross contribution total derived from it (SOL). */
  grossSol: number
  /** Fill relative to the target, 0-1 (can exceed 1). */
  ratio: number
  /** Fill percentage, clamped to 0-100 (the bar's width). */
  percent: number
  /** Is the target filled — if so, no contribution is accepted. */
  targetReached: boolean
  /** Has the floor (soft cap) been passed. */
  softCapReached: boolean
}

export function computePresaleProgress(poolSol: number): PresaleProgress {
  const grossSol = grossRaisedFromPoolSol(poolSol)
  const ratio = PRESALE_TARGET_SOL > 0 ? grossSol / PRESALE_TARGET_SOL : 0
  return {
    poolSol,
    grossSol,
    ratio,
    percent: Math.max(0, Math.min(100, ratio * 100)),
    targetReached: grossSol >= PRESALE_TARGET_SOL,
    softCapReached: grossSol >= PRESALE_SOFT_CAP_SOL,
  }
}

/** The moment the presale ends — null if no start has been announced. */
export function presaleEndsAt(): Date | null {
  if (!PRESALE_START_ISO) return null
  const start = new Date(PRESALE_START_ISO)
  if (Number.isNaN(start.getTime())) return null
  return new Date(start.getTime() + PRESALE_DURATION_WEEKS * 7 * 24 * 60 * 60 * 1000)
}

export type PresalePhase = 'unscheduled' | 'upcoming' | 'live' | 'ended'

export function presalePhaseAt(now: Date = new Date()): PresalePhase {
  if (!PRESALE_START_ISO) return 'unscheduled'
  const start = new Date(PRESALE_START_ISO)
  const end = presaleEndsAt()
  if (Number.isNaN(start.getTime()) || !end) return 'unscheduled'
  if (now < start) return 'upcoming'
  if (now >= end) return 'ended'
  return 'live'
}

/**
 * Is the presale accepting contributions — and if not, WHY.
 *
 * This is the site's only money gate. The presale is a plain wallet transfer,
 * so there is NO on-chain program to stop it; the barrier exists only here.
 *
 * `unscheduled` IS INCLUDED, and that is a deliberate change. Previously, with
 * no schedule announced (`PRESALE_START_ISO = ''`), the presale was left OPEN,
 * on the grounds that "we are still testing". The consequence was this: on
 * launch day, removing the "Stay Tuned" gate while forgetting to fill in the
 * date meant opening a presale to everyone with no date and no minted token
 * behind it. Two separate checklist items being coupled like that is not
 * acceptable — forgetting one of them must not lead to accepting money.
 *
 * If it does need to be open during testing, the thing to do is explicit and
 * deliberate: write a past date into PRESALE_START_ISO.
 */
export type PresaleClosedReason = 'unconfigured' | 'unscheduled' | 'upcoming' | 'ended' | 'reached'

export function presaleClosedReason(args: {
  configured: boolean
  targetReached: boolean
  phase: PresalePhase
}): PresaleClosedReason | null {
  if (!args.configured) return 'unconfigured'
  if (args.targetReached) return 'reached'
  if (args.phase === 'unscheduled') return 'unscheduled'
  if (args.phase === 'upcoming') return 'upcoming'
  if (args.phase === 'ended') return 'ended'
  return null
}

/** Renders the remaining time as a short string such as "12d 4h 30m". */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return '0m'
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/**
 * Splits a contribution into the part going to the pool and the operations
 * share. The split is done in lamports (whole numbers) and the share is rounded
 * DOWN — so the rounding difference always falls in the pool's favour, never
 * against the contributor.
 */
export function splitContributionLamports(totalLamports: number): {
  poolLamports: number
  opsLamports: number
} {
  if (!presaleOpsFeeActive) return { poolLamports: totalLamports, opsLamports: 0 }
  const opsLamports = Math.floor((totalLamports * PRESALE_OPS_FEE_NUM) / PRESALE_OPS_FEE_DEN)
  return { poolLamports: totalLamports - opsLamports, opsLamports }
}

/**
 * Sends SOL to the presale. Tickets are granted from the amount alone, at 1
 * ticket per PRESALE_TICKET_UNIT_SOL (0.5 SOL), in both modes — `flex` (free
 * contribution) and `fixed` (a preset package) differ only in how the amount is
 * entered.
 *
 * The contribution is split into two transfers inside a single transaction: the
 * pool's part to PRESALE_WALLET and the operations share to a separate wallet
 * (see PRESALE_OPS_WALLET). A memo containing both amounts is added for
 * traceability. If the operations wallet is not configured, no share is taken
 * and the whole contribution goes to PRESALE_WALLET.
 */
export async function sendPresaleContribution(
  connection: Connection,
  wallet: WalletContextState,
  network: NetworkId,
  mode: PresaleMode,
  amountSol: number,
  onStatus?: (status: string) => void,
): Promise<PresaleContributionResult> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('The wallet is not connected.')
  }
  if (!PRESALE_WALLET) {
    throw new Error('The presale is not configured yet (PRESALE_WALLET is empty).')
  }
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error('Invalid amount.')
  }

  const payer = wallet.publicKey
  // Tickets are ALWAYS computed from the gross amount sent — the operations
  // share does not reduce the ticket count.
  // Tickets are now computed from the amount regardless of mode (see the
  // PRESALE_TICKET_UNIT_SOL note in config.ts): the mode was read from a memo
  // written by the sender and could be faked; and granting tickets to one of
  // two people who sent the same money but not the other was indefensible.
  const tickets = calcTickets(amountSol)

  const totalLamports = Math.round(amountSol * LAMPORTS_PER_SOL)
  const { poolLamports, opsLamports } = splitContributionLamports(totalLamports)

  const ixs: TransactionInstruction[] = []
  // The pool's part goes to the presale wallet...
  ixs.push(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: new PublicKey(PRESALE_WALLET),
      lamports: poolLamports,
    }),
  )
  // ...and the operations share goes to a separate wallet in the SAME
  // transaction. Because it never passes through the presale wallet, the amount
  // to be put into the pool at TGE equals the presale wallet's balance exactly;
  // no manual sorting is needed.
  if (opsLamports > 0) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey(PRESALE_OPS_WALLET),
        lamports: opsLamports,
      }),
    )
  }
  ixs.push(
    buildMemoIx(
      payer,
      JSON.stringify({
        app: 'solofluck-presale',
        mode,
        sol: amountSol,
        tickets,
        pool: poolLamports,
        ops: opsLamports,
      }),
    ),
  )

  // The shared, hardened send path (see sendTx.ts). This used to be a plain
  // `getLatestBlockhash -> sign -> sendRawTransaction -> confirmTransaction`
  // sequence, and since the presale is the first place a user touches with REAL
  // money, it was the riskiest point in the app:
  //
  // - confirmTransaction opens a websocket subscription. On mobile, switching
  //   apps to approve in the wallet puts the page in the background and the
  //   subscription silently drops. Because the notification never arrives, a
  //   "block height exceeded" error was reported even when the transaction HAD
  //   BEEN WRITTEN TO THE CHAIN. The first thing a user who cannot see their
  //   contribution land will do is SEND IT AGAIN — i.e. pay twice.
  // - There was no priority fee; under load the transaction is silently dropped
  //   by the leader and the blockhash expires.
  // - Only one send was made; on shared RPCs that is often not enough.
  // - signTransaction had no timeout; if Phantom's deep-link flow never came
  //   back, the screen stayed locked forever.
  //
  // sendInstructions closes all of these, and before asking for a new signature
  // it checks whether previously sent signatures have landed on chain — so it
  // retries without any risk of double payment.
  const signature = await sendInstructions(
    connection,
    { publicKey: payer, signTransaction: wallet.signTransaction },
    ixs,
    onStatus,
  )

  recordContribution(network, { signature, tickets, amountSol, mode })

  return { signature, tickets, amountSol, mode }
}

// ---------------------------------------------------------------------------
// Local (browser) history — until a real indexer or backend exists,
// contributions made with this wallet and the tickets collected are also
// written to localStorage so they can be shown instantly. The source of truth
// is always the on-chain transaction plus its memo.
// ---------------------------------------------------------------------------

export interface StoredContribution extends PresaleContributionResult {
  at: number
}

function storageKey(network: NetworkId) {
  return `solofluck_presale_${network}`
}

function recordContribution(network: NetworkId, entry: PresaleContributionResult) {
  try {
    const key = storageKey(network)
    const raw = window.localStorage.getItem(key)
    const list: StoredContribution[] = raw ? JSON.parse(raw) : []
    list.push({ ...entry, at: Date.now() })
    window.localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // If localStorage is unavailable (e.g. a private-tab restriction) swallow
    // it quietly — it affects the history view, not the contribution itself.
  }
}

export function getLocalContributions(network: NetworkId): StoredContribution[] {
  try {
    const raw = window.localStorage.getItem(storageKey(network))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}
