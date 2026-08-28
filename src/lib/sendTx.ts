import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'

// ---------------------------------------------------------------------------
// The shared transaction-sending layer
// ---------------------------------------------------------------------------
// The logic in this file was first written on the game side (luckGame.ts) and
// hardened in real use against three separate classes of failure. The same
// protections are needed in other flows such as burning, so it moved here — a
// plain `getLatestBlockhash -> sign -> sendRawTransaction` sequence is NOT
// reliable under mobile-wallet + shared-RPC conditions.

/** The common interface for a real wallet adapter (Phantom etc.) and local keys. */
export interface TxSigner {
  publicKey: PublicKey
  signTransaction: (tx: Transaction) => Promise<Transaction>
}

// NOTE: the wallet adapter's own `sendTransaction` method is DELIBERATELY not
// used. It saves a round trip on mobile, but it broadcasts the transaction to
// THE WALLET'S selected network — not to the one we are connected to. If the
// wallet is on a different network (e.g. Testnet instead of Devnet in Phantom)
// the transaction silently goes to the wrong network. Taking the signature and
// sending it over our own connection guarantees the transaction always goes to
// the network the site selected; the speed gain is not worth losing that
// guarantee.

// The small priority fee added to transactions. Under load, transactions
// without priority are silently dropped by the leader and the blockhash
// expires — that was one of the causes of the "the transaction did not land"
// error users saw.
const PRIORITY_FEE_MICRO_LAMPORTS = 5_000

// The compute-unit limit is determined by MEASUREMENT, not by a constant.
//
// A fixed 300,000 was used, which is more than enough for a single-package
// purchase but NOT for the "convert my balance into spins" flow: that flow can
// put up to 20 buy_spins into one transaction and each of them makes several
// CPI transfers. If the total silently exceeds 300,000 the transaction fails on
// chain with "exceeded CUs" — and the error the user sees explains none of it.
//
// Raising the limit blindly is not right either: the priority fee is multiplied
// by the REQUESTED limit, so asking for 1.4 million would needlessly inflate the
// fee of every small transaction.
//
// The solution: simulate first with a high limit, read how many units were
// actually consumed, then add headroom and set the limit from that. Small
// transactions stay cheap and large batches still go through.
//
// WHAT HAPPENS IF THE SIMULATION GIVES NO ANSWER — I got this wrong once. It
// used to fall back to 300,000 on a failed measurement; so the moment the RPC
// wobbled (a simulation can return "BlockhashNotFound", and does) the very
// 20-instruction batch this change exists to fix would fail with "exceeded CUs"
// again. The "safe side" is not the small limit but the LARGE one: when we
// cannot measure, we ask for the ceiling.
//
// The cost is negligible: the priority fee is multiplied by the requested limit,
// so the ceiling is 1,400,000 x 5,000 microlamports / 10^6 = 7,000 lamports
// (0.000007 SOL). The cost of a dropped transaction is both the base fee and the
// user having to try again.
const COMPUTE_UNIT_LIMIT_FALLBACK = 300_000
const COMPUTE_UNIT_LIMIT_MAX = 1_400_000
/** The headroom left above the measured consumption — the on-chain state can
 *  differ slightly from the moment of simulation (e.g. an account may have just
 *  been created). */
const COMPUTE_UNIT_HEADROOM = 1.3

/**
 * Computes the compute limit to request from the consumption the simulation
 * read.
 *
 * If `consumed === null` (no measurement was possible) or 0, the CEILING is
 * requested — see the explanation above. When there is a measurement, headroom
 * is added and the result is clamped between the floor and the ceiling.
 *
 * It is a separate function for testability: scripts/check-abi.mjs verifies this
 * decision by calling the real code.
 */
export function computeUnitLimitFor(consumed: number | null): number {
  if (consumed === null || consumed <= 0) return COMPUTE_UNIT_LIMIT_MAX
  return Math.min(
    COMPUTE_UNIT_LIMIT_MAX,
    Math.max(COMPUTE_UNIT_LIMIT_FALLBACK, Math.ceil(consumed * COMPUTE_UNIT_HEADROOM)),
  )
}

export interface SendOptions {
  /**
   * Extra keys that must sign alongside the wallet — e.g. the mint keypair when
   * a new mint account is being created.
   *
   * These are added with `partialSign` BEFORE the transaction goes to the
   * wallet. Retry cycles use THE SAME keys: the mint address does not change.
   * This flow used to write its own send code, so on an "it actually did land"
   * case the user would retry and A SECOND MINT would be created.
   */
  extraSigners?: Keypair[]

  /**
   * The status message shown while waiting for wallet approval. Passing `null`
   * skips that step entirely — transactions signed with a local key (the
   * delegate or test wallet) complete INSTANTLY and without approval, so the
   * user must not mistakenly be shown something like "waiting for approval in
   * your wallet". The default message should be used only on steps that
   * genuinely require a REAL wallet signature.
   */
  confirmMessage?: string | null
}

/**
 * Binds a promise to a timeout that rejects with the given message if it
 * neither resolves nor rejects within that time. On mobile wallets (especially
 * Phantom's approval flow, which switches between apps over a deep link), if the
 * app switch fails then `wallet.signTransaction()` NEVER resolves or rejects —
 * which left the screen permanently locked on "waiting for transaction". Every
 * network/wallet step is bounded by this wrapper so that at worst it ends in a
 * clear error rather than freezing forever.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Retry with a short backoff against two known classes of transient RPC error:
 * (1) the per-IP rate limit on public/shared RPCs; (2) on load-balanced
 * providers, getLatestBlockhash() can be answered by one node while the
 * preflight simulation of the transaction sent afterwards is answered by a
 * different node that has not seen that blockhash yet ("Blockhash not found").
 * Each attempt is also bounded by a timeout.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseDelayMs = 800): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn(), 20_000, 'The RPC request timed out.')
    } catch (err) {
      const isTransient =
        err instanceof Error && /429|rate limit|blockhash not found|timed out/i.test(err.message)
      if (!isTransient || i === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i))
    }
  }
  throw new Error('unreachable')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type ConfirmOutcome =
  | { kind: 'ok' }
  | { kind: 'failed'; err: unknown }
  | { kind: 'expired' }

/**
 * Fetches the on-chain logs of a failed transaction.
 *
 * `getSignatureStatuses` returns only a bare error code (e.g.
 * `{"InstructionError":[0,{"Custom":6003}]}`) — which tells neither the user nor
 * us anything. The program's own `msg!` output states the real cause. We show
 * those alongside the error so diagnosis is not left to guesswork.
 */
async function fetchFailureLogs(connection: Connection, signature: string): Promise<string> {
  try {
    const tx = await withTimeout(
      connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
      15_000,
      'the log query timed out',
    )
    const logs = tx?.meta?.logMessages ?? []
    if (logs.length === 0) return ''
    // The last lines contain the error; there is no need to take the
    // "invoke/success" noise from the start.
    return logs.slice(-6).join('\n')
  } catch {
    return ''
  }
}

/**
 * Waits for the transaction to land by HTTP polling — NOT with
 * `confirmTransaction`.
 *
 * `sendInstructions` uses this internally. It is also exported, because some
 * flows (e.g. the confidential transfer plan) have to sign several transactions
 * under ONE wallet approval and send them in sequence — those do not fit
 * sendInstructions' single-transaction model but suffer the same confirmation
 * problem.
 *
 * The reason: `confirmTransaction` opens a websocket subscription. On mobile,
 * when the user switches apps to approve in the wallet, the browser backgrounds
 * the page and that subscription silently drops. Because the notification never
 * arrives, a "block height exceeded" error was reported even when the
 * transaction HAD LANDED — the user thought the burn had failed while the tokens
 * may well have been burned. HTTP polling survives being backgrounded.
 *
 * In the same loop the signed transaction is periodically REBROADCAST: shared
 * devnet/mainnet RPCs can drop transactions under load and a single send is
 * often not enough.
 */
export async function confirmBySignature(
  connection: Connection,
  signature: string,
  rawTx: Uint8Array,
  lastValidBlockHeight: number,
  onStatus?: (status: string) => void,
): Promise<ConfirmOutcome> {
  const deadline = Date.now() + 120_000
  let lastResendAt = Date.now()

  while (Date.now() < deadline) {
    const status = await connection
      .getSignatureStatuses([signature])
      .then((r) => r.value[0])
      .catch(() => null)

    if (status) {
      if (status.err) return { kind: 'failed', err: status.err }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { kind: 'ok' }
      }
    }

    const height = await connection.getBlockHeight().catch(() => null)
    if (height !== null && height > lastValidBlockHeight) {
      // The blockhash window has closed. In case it landed just before it did,
      // we look one more time — rushing to return "expired" here would mean
      // asking the user for a second signature for the same transaction (i.e.
      // the risk of burning twice).
      await sleep(2000)
      const finalStatus = await connection
        .getSignatureStatuses([signature])
        .then((r) => r.value[0])
        .catch(() => null)
      if (finalStatus && !finalStatus.err) return { kind: 'ok' }
      if (finalStatus?.err) return { kind: 'failed', err: finalStatus.err }
      return { kind: 'expired' }
    }

    if (Date.now() - lastResendAt > 3000) {
      // Rebroadcast: the same signature, the same transaction — it creates no
      // duplicate, it only re-sends a packet that may have been dropped.
      connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 }).catch(() => {})
      lastResendAt = Date.now()
      onStatus?.('Waiting for confirmation (resending the transaction to the network)...')
    }

    await sleep(1500)
  }

  return { kind: 'expired' }
}

/**
 * Simulates the transaction BEFORE asking for a signature and stops with a
 * clear message if there is a definite error.
 *
 * Why this is needed: on the real send we use `skipPreflight: true` (to skip
 * spurious "Blockhash not found" errors caused by blockhash propagation delay).
 * But the price of skipping preflight is that REAL errors are hidden too: when
 * the wallet has no SOL left for the network fee the transaction is rejected by
 * the leader, never lands, and we were reporting that as "the blockhash
 * expired". The user signed over and over without being able to see why it
 * failed.
 *
 * A simulation needs no signature, costs nothing and is fast — which is why we
 * run it before bothering the wallet at all.
 */
async function assertSimulationPasses(
  connection: Connection,
  tx: Transaction,
): Promise<number | null> {
  let result
  try {
    result = await withRetry(
      () => connection.simulateTransaction(tx),
      2,
      600,
    )
  } catch {
    // If the SIMULATION ITSELF failed (an RPC error, a timeout) we do not block
    // the path — it may be transient and we do not want to stop the user when
    // there is no real problem.
    return null
  }

  const err = result.value.err
  const consumed = result.value.unitsConsumed ?? null
  if (!err) return consumed

  const raw = JSON.stringify(err)
  const logs = (result.value.logs ?? []).join('\n')

  // Clear problems the user can fix — for these we stop without ever opening
  // the wallet.
  if (/InsufficientFundsForFee/i.test(raw) || /insufficient lamports/i.test(logs)) {
    throw new Error(
      'Your wallet does not have enough SOL to pay the network fee. On Devnet you can get free ' +
        'SOL from faucet.solana.com; on Mainnet you need to send some SOL to your wallet.',
    )
  }
  if (/insufficient funds/i.test(logs)) {
    throw new Error('Insufficient balance — your wallet does not hold the amount this transaction requires.')
  }
  // The program's own rejection (an Anchor/SPL error code): a real and
  // reproducible error, worth showing.
  if (/InstructionError/i.test(raw)) {
    throw new Error(`The transaction simulation failed: ${raw}${logs ? `\n${logs.slice(-400)}` : ''}`)
  }

  // Everything else counts as INCONCLUSIVE and does not block the path.
  // "BlockhashNotFound" in particular: simulateTransaction fetches its own
  // blockhash, and on load-balanced RPCs the node running the simulation may not
  // have seen that blockhash yet. That is NOT a problem with the transaction —
  // indeed, when this check was first added, buying spins failed before it could
  // even start for exactly this reason. The job of a pre-check is to catch
  // early the clear problems a user can fix, not to stop the transaction on
  // every suspicion.
  console.warn('The simulation was inconclusive, continuing with the transaction:', raw, logs)
  return consumed
}

/**
 * Checks the fee payer's balance ON THE NETWORK THE SITE IS CONNECTED TO.
 *
 * This check looks at our RPC connection rather than the balance the wallet
 * shows on its own screen — and that is precisely what makes it valuable: if the
 * wallet is set to a different network (e.g. Testnet instead of Devnet inside
 * Phantom's "Testnet Mode") the user sees a healthy balance in their wallet
 * while on our network the transactions have no fee cover and never land. The
 * message states both the real balance and the network name so a
 * wrong-network situation is recognisable.
 */
async function assertFeePayerFunded(connection: Connection, feePayer: PublicKey): Promise<void> {
  let lamports: number
  try {
    lamports = await withTimeout(connection.getBalance(feePayer), 15_000, 'The balance query timed out.')
  } catch {
    return // A transient RPC problem — no reason to stop the user.
  }

  // The base transaction fee (5,000) + the priority fee ceiling + a small margin.
  const needed = 5_000 + (COMPUTE_UNIT_LIMIT_MAX * PRIORITY_FEE_MICRO_LAMPORTS) / 1_000_000 + 5_000
  if (lamports >= needed) return

  const sol = (lamports / 1_000_000_000).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')
  throw new Error(
    `Your wallet holds ${sol} SOL on this network, which is not enough for the transaction fee. ` +
      'If you can see a healthy balance in your wallet, your wallet may be set to A DIFFERENT ' +
      'NETWORK — make sure your wallet is on the same network as the site (the menu at the top ' +
      'left). Free SOL for Devnet: faucet.solana.com',
  )
}

/** Has any of the previously sent signatures landed on chain? */
async function findLandedSignature(
  connection: Connection,
  signatures: string[],
): Promise<string | null> {
  if (signatures.length === 0) return null
  const statuses = await connection
    .getSignatureStatuses(signatures)
    .then((r) => r.value)
    .catch(() => null)
  if (!statuses) return null
  for (let i = 0; i < signatures.length; i++) {
    const st = statuses[i]
    if (st && !st.err) return signatures[i]
  }
  return null
}

/**
 * Signs and sends the instructions, then waits for them to land on chain.
 *
 * Under normal conditions it asks for ONE wallet approval. A new signature with
 * a fresh blockhash is only requested when the transaction genuinely did not
 * land (the blockhash window closed and the signature appears in no status).
 * BEFORE each new cycle the previous signatures are checked again: if one of
 * them actually did land, the loop ends there — so the same transaction is never
 * sent twice.
 */
export async function sendInstructions(
  connection: Connection,
  signer: TxSigner,
  ixs: TransactionInstruction[],
  onStatus?: (status: string) => void,
  options?: SendOptions,
): Promise<string> {
  const confirmMessage =
    options?.confirmMessage === undefined ? 'Waiting for approval in your wallet...' : options.confirmMessage

  const attempted: string[] = []
  const maxCycles = 3
  // Measured on the first cycle and reused on later ones.
  // The ceiling until a measurement exists; see the computeUnitLimitFor note.
  let computeUnitLimit = COMPUTE_UNIT_LIMIT_MAX

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const alreadyLanded = await findLandedSignature(connection, attempted)
    if (alreadyLanded) return alreadyLanded

    // The priority-fee instructions go first: under load, transactions without
    // priority are silently dropped by the leader and the blockhash expires.
    // On the first cycle we start FROM THE CEILING in order to measure the
    // limit: simulating with a low limit would fail a transaction that actually
    // fits with "exceeded CUs" and give a false diagnosis.
    const buildTx = (units: number) =>
      new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units }))
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }))
        .add(...ixs)

    let tx = buildTx(cycle === 0 ? COMPUTE_UNIT_LIMIT_MAX : computeUnitLimit)

    onStatus?.(
      cycle === 0 ? 'Preparing the transaction...' : `Preparing the transaction again (attempt ${cycle + 1})...`,
    )
    // We take the FRESHEST possible blockhash with 'confirmed'; an older
    // (finalized) blockhash would already have spent part of the validity
    // window, which is short to begin with.
    const { blockhash, lastValidBlockHeight } = await withRetry(() =>
      connection.getLatestBlockhash('confirmed'),
    )
    tx.recentBlockhash = blockhash
    tx.feePayer = signer.publicKey

    // Catch definite errors (insufficient balance etc.) before asking for a
    // signature. Only on the first cycle: later cycles carry the same
    // instructions.
    if (cycle === 0) {
      onStatus?.('Checking the transaction...')
      await assertFeePayerFunded(connection, signer.publicKey)
      const consumed = await assertSimulationPasses(connection, tx)
      computeUnitLimit = computeUnitLimitFor(consumed)
      // Rebuild with the measured limit: sending with the ceiling would not drop
      // the transaction, but because the priority fee is multiplied by the
      // REQUESTED limit it would needlessly make every transaction more
      // expensive.
      tx = buildTx(computeUnitLimit)
      tx.recentBlockhash = blockhash
      tx.feePayer = signer.publicKey
    }

    // Extra signers must sign BEFORE the wallet: wallet adapters preserve
    // existing signatures and add their own, but not the other way around.
    if (options?.extraSigners?.length) {
      tx.partialSign(...options.extraSigners)
    }

    if (confirmMessage) onStatus?.(confirmMessage)

    // On mobile, the app switch plus the user's reading time easily reaches a
    // minute, so we leave a wide window for approval. Still not infinite: if the
    // deep link never comes back we give a clear error rather than leaving the
    // screen locked.
    //
    // skipPreflight: because of brief state lag between load-balanced RPC nodes,
    // the preflight simulation can reject a blockhash that is valid but not yet
    // visible on the node it lands on ("Blockhash not found"). We read the real
    // outcome from the signature status instead.
    const signedTx = await withTimeout(
      signer.signTransaction(tx),
      120_000,
      'The wallet approval did not complete within 2 minutes. Check your wallet app (the approval request may still be open) and try again.',
    )
    const rawTx = signedTx.serialize()

    onStatus?.('Sending the transaction to the network...')
    const signature = await withRetry(() =>
      // maxRetries makes the RPC node forward the transaction to the leader
      // REPEATEDLY. I once set this to 0 (reasoning "we do our own
      // rebroadcast") — but a send every 3s from the client does not replace the
      // node forwarding it on every slot.
      connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 }),
    )
    attempted.push(signature)

    onStatus?.('Waiting for confirmation...')
    const outcome = await confirmBySignature(connection, signature, rawTx, lastValidBlockHeight, onStatus)

    if (outcome.kind === 'ok') return signature
    if (outcome.kind === 'failed') {
      onStatus?.('Reading the error details...')
      const logs = await fetchFailureLogs(connection, signature)
      throw new Error(
        `The transaction failed on chain: ${JSON.stringify(outcome.err)}${logs ? `\n\n${logs}` : ''}`,
      )
    }
    if (cycle === maxCycles - 1) {
      throw new Error(
        'The transaction did not land (the blockhash expired). The network may be busy — wait a ' +
          'moment and try again. If your wallet balance has not changed, nothing happened.',
      )
    }
    onStatus?.('The transaction did not land in time — retrying with a new approval...')
  }
  throw new Error('unreachable')
}
