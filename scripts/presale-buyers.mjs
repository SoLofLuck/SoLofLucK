#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The presale buyer list — from the chain
// ---------------------------------------------------------------------------
// Reads EVERY transfer into the presale wallet, aggregates them by sending
// address, and computes how many $LUCK and how many raffle tickets each buyer
// has earned.
//
// WHY THIS SCRIPT EXISTS: on the site the contribution history is kept only in
// the user's own browser (localStorage) — so we hold no record, and we do not
// need to. The only source of truth is the chain itself. Buyers can run the same
// script and verify their own share independently of us; we never have to say
// "we kept the list, trust us".
//
// THE CONTRIBUTION IS SPLIT IN TWO — we MUST count both parts:
// the site splits a contribution in one transaction; 90% to the presale wallet
// and 10% to the operations wallet (see splitContributionLamports in
// src/lib/presale.ts). But the announced price is on THE FULL AMOUNT SENT:
// "1 SOL = 350,000 $LUCK" and "the share does not reduce your ticket count". If
// we counted only what reaches the presale wallet we would give EVERY BUYER 10%
// TOO FEW tokens — a silent shortfall of 27,195,000 $LUCK at the 777 SOL target.
//
// So on every transaction we add up the balance increase of BOTH wallets. The
// operations share is counted only on transactions where the presale wallet was
// also credited — so money arriving in that wallet for some other reason is not
// mistaken for a contribution.
//
// WHAT WE DO NOT TRUST: the memo we write into the transactions. A memo is free
// text written by the sender — anyone building a transaction by hand could write
// whatever ticket count they liked. So both the amount and the tickets are
// computed ONLY from the account's real balance change.
//
// Usage:
//   node scripts/presale-buyers.mjs > buyers.json
//
// Environment variables:
//   RPC_URL      Solana RPC (default: the public mainnet-beta endpoint)
//   WALLET       The presale wallet (default: PRESALE_WALLET in src/config.ts)
//   START_ISO    Transactions BEFORE this date are ignored (the presale opening)
//   END_ISO      Transactions AFTER this date are ignored (the presale close)
//   FORMAT       json (default) | csv
//
// NOTE: public RPC endpoints are rate-limited and return 429 while thousands of
// transactions are being scanned. For the real distribution, pass your own
// endpoint (Helius, QuickNode or similar) through RPC_URL.

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { readFileSync } from 'node:fs'

// --- read the constants from config.ts (a simple regex, without running TS) --
function readConfigValue(name, fallback) {
  try {
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
    const m = src.match(new RegExp(`export const ${name}\\s*=\\s*'([^']*)'`))
    if (m) return m[1]
    const n = src.match(new RegExp(`export const ${name}\\s*=\\s*([0-9_.]+)`))
    if (n) return Number(n[1].replace(/_/g, ''))
  } catch {
    /* config okunamazsa fallback */
  }
  return fallback
}

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
const WALLET = process.env.WALLET || readConfigValue('PRESALE_WALLET', '')
const OPS_WALLET = process.env.OPS_WALLET ?? readConfigValue('PRESALE_OPS_WALLET', '')
const TOKENS_PER_SOL = Number(process.env.TOKENS_PER_SOL || readConfigValue('PRESALE_TOKENS_PER_SOL', 350000))
const TICKET_UNIT_SOL = Number(process.env.TICKET_UNIT_SOL || readConfigValue('PRESALE_TICKET_UNIT_SOL', 0.5))
const FORMAT = (process.env.FORMAT || 'json').toLowerCase()
// The $LUCK decimals — for converting into the smallest on-chain unit.
const DECIMALS = Number(process.env.DECIMALS || readConfigValue('DEFAULT_DECIMALS', 9))

const startMs = process.env.START_ISO ? Date.parse(process.env.START_ISO) : null
const endMs = process.env.END_ISO ? Date.parse(process.env.END_ISO) : null

if (!WALLET) {
  console.error('The presale wallet was not found. Pass WALLET=<address>.')
  process.exit(1)
}
if (process.env.START_ISO && Number.isNaN(startMs)) {
  console.error('START_ISO is invalid (e.g. 2026-09-01T18:00:00Z).')
  process.exit(1)
}
if (process.env.END_ISO && Number.isNaN(endMs)) {
  console.error('END_ISO is invalid.')
  process.exit(1)
}

const connection = new Connection(RPC_URL, 'confirmed')
const wallet = new PublicKey(WALLET)

/**
 * Extracts the contribution from a transaction. A pure function: it never looks
 * at the chain and works only from the account list and the balance changes —
 * which is what makes it testable with synthetic data (the --selftest below).
 *
 * The `delta` it returns is the WHOLE contribution: the part reaching the
 * presale wallet plus the share going to the operations wallet in the same
 * transaction. Adding both is essential, because the announced price is on the
 * full amount sent.
 */
export function extractContribution(keys, preBalances, postBalances, poolWallet, opsWallet) {
  const idx = keys.indexOf(poolWallet)
  if (idx < 0) return null

  const poolDelta = (postBalances[idx] ?? 0) - (preBalances[idx] ?? 0)
  // If NO money entered the presale wallet this is not a contribution (an
  // outflow, or a transaction that did not touch the wallet at all).
  if (poolDelta <= 0) return null

  let opsDelta = 0
  if (opsWallet) {
    const opsIdx = keys.indexOf(opsWallet)
    if (opsIdx >= 0) {
      const d = (postBalances[opsIdx] ?? 0) - (preBalances[opsIdx] ?? 0)
      if (d > 0) opsDelta = d
    }
  }

  // The sender: the first signer, who pays the transaction fee. In the presale
  // flow the wallet sending the money and the one signing are the same.
  const sender = keys[0]
  if (sender === poolWallet) return null

  return { sender, delta: poolDelta + opsDelta, poolDelta, opsDelta }
}

/**
 * COMPLETENESS: does the history we scanned account for the wallet's balance
 * TODAY?
 *
 * `getSignaturesForAddress` returns only the history the RPC node KEEPS. Public
 * endpoints prune history (they are not archive nodes). If the presale runs for
 * weeks, the transactions of the earliest contributors can fall outside that
 * window — and that RAISES NO ERROR: the script runs fine, produces a shorter
 * list, those buyers never enter the merkle tree, and at TGE they see "you are
 * not on the list". Once the root is written to the chain it cannot be fixed.
 *
 * The cross-check is simple: if we add up the SIGNED balance change of the
 * wallet across every transaction we scanned, the result must equal the wallet's
 * current balance (the wallet was born empty). If the balance is MORE than what
 * we added up, money entered the wallet from somewhere we cannot see — the
 * history is incomplete.
 *
 * The other direction (our sum being larger) is not a problem: we may have taken
 * money out, and we scan the outflows too.
 */
export function completenessCheck(scanned, current, tolerance) {
  const gap = current - scanned
  return { complete: gap <= tolerance, gap }
}

// --- selftest ----------------------------------------------------------------
if (process.argv.includes('--selftest')) {
  const POOL = 'POOL_WALLET'
  const OPS = 'OPS_WALLET'
  const USER = 'USER_WALLET'
  const L = 1_000_000_000
  let failed = 0
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) failed++
    console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}`)
    if (!ok) console.log(`   expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }

  // 1) An ordinary contribution: 1 SOL, 90% to the wallet + 10% to operations
  check(
    'a split contribution -> the full amount is counted',
    extractContribution([USER, POOL, OPS], [10 * L, 0, 0], [9 * L, 0.9 * L, 0.1 * L], POOL, OPS)?.delta,
    L,
  )

  // 2) Sent straight to the wallet (no operations share)
  check(
    'an unsplit contribution -> counted as it is',
    extractContribution([USER, POOL], [10 * L, 0], [9 * L, L], POOL, OPS)?.delta,
    L,
  )

  // 3) An OUTFLOW from the wallet — not a contribution
  check(
    'an outflow from the wallet -> not counted',
    extractContribution([POOL, USER], [10 * L, 0], [9 * L, L], POOL, OPS),
    null,
  )

  // 4) Money to the operations wallet only — not a contribution
  check(
    'the operations wallet only -> not counted',
    extractContribution([USER, OPS], [10 * L, 0], [9 * L, L], POOL, OPS),
    null,
  )

  // 5) With no operations wallet configured, only the presale wallet counts
  check(
    'no operations wallet -> the presale wallet only',
    extractContribution([USER, POOL, OPS], [10 * L, 0, 0], [9 * L, 0.9 * L, 0.1 * L], POOL, '')?.delta,
    0.9 * L,
  )

  // 6) The real price check: someone sending 1 SOL must receive 350,000 $LUCK
  const d = extractContribution([USER, POOL, OPS], [10 * L, 0, 0], [9 * L, 0.9 * L, 0.1 * L], POOL, OPS)
  check('1 SOL -> 350,000 $LUCK', Math.floor((d.delta / L) * 350_000), 350_000)

  // 7-10) Completeness: does the scanned history account for today's balance
  check(
    'completeness: scanned = current -> fine',
    completenessCheck(100 * L, 100 * L, L).complete,
    true,
  )
  check(
    'completeness: the balance exceeds the scan -> incomplete history',
    completenessCheck(90 * L, 100 * L, L).complete,
    false,
  )
  check(
    'completeness: the missing amount is reported correctly',
    completenessCheck(90 * L, 100 * L, L).gap,
    10 * L,
  )
  check(
    'completeness: money went OUT (the scan is larger) -> not a problem',
    completenessCheck(100 * L, 40 * L, L).complete,
    true,
  )
  check(
    'completeness: a difference within tolerance passes',
    completenessCheck(100 * L, 100 * L + 500, L).complete,
    true,
  )

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Retries with increasing backoff when it hits the rate limit (429). */
async function withRetry(fn, label) {
  let delay = 500
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= 6) throw new Error(`${label} failed: ${err.message}`)
      process.stderr.write(`  ${label}: error (${err.message}), retrying in ${delay}ms...\n`)
      await sleep(delay)
      delay *= 2
    }
  }
}

// --- 1) The wallet's complete signature history ----------------------------
process.stderr.write(
  `Presale wallet    : ${WALLET}\n` +
    `Operations share  : ${OPS_WALLET || '(not configured — only the presale wallet will count)'}\n` +
    `RPC               : ${RPC_URL}\n\nScanning signatures...\n`,
)

const signatures = []
let before
for (;;) {
  const page = await withRetry(
    () => connection.getSignaturesForAddress(wallet, { before, limit: 1000 }),
    'getSignaturesForAddress',
  )
  if (page.length === 0) break
  signatures.push(...page)
  before = page[page.length - 1].signature
  process.stderr.write(`  ${signatures.length} signature(s)...\n`)
  if (page.length < 1000) break
}

// Failed transactions move no money — we filter them out up front.
const candidates = signatures.filter((s) => !s.err)
process.stderr.write(`\n${signatures.length} signatures in total, ${candidates.length} of them successful.\nReading the transactions...\n`)

// --- 2) Find the wallet's balance increase and the sender per transaction ---
const buyers = new Map()
const skipped = []
let processed = 0
// The SIGNED total balance change of the presale wallet across the scanned
// transactions.
let scannedNet = 0

for (let i = 0; i < candidates.length; i += 100) {
  const batch = candidates.slice(i, i + 100)
  const txs = await withRetry(
    () =>
      connection.getParsedTransactions(
        batch.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 },
      ),
    'getParsedTransactions',
  )

  for (let j = 0; j < txs.length; j++) {
    const tx = txs[j]
    const sig = batch[j].signature
    if (!tx || tx.meta?.err) continue

    // THE COMPLETENESS COUNTER — BEFORE the time-window filter, because the
    // question we are asking is not "should this contribution count" but "does
    // the history we scanned account for the wallet's balance today".
    // Transactions outside the window changed the balance too.
    {
      const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58())
      const walletIdx = accountKeys.indexOf(WALLET)
      if (walletIdx >= 0) {
        scannedNet += (tx.meta.postBalances[walletIdx] ?? 0) - (tx.meta.preBalances[walletIdx] ?? 0)
      }
    }

    const blockMs = (tx.blockTime ?? 0) * 1000
    if (startMs !== null && blockMs < startMs) continue
    if (endMs !== null && blockMs > endMs) continue

    const contribution = extractContribution(
      tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58()),
      tx.meta.preBalances,
      tx.meta.postBalances,
      WALLET,
      OPS_WALLET,
    )
    if (!contribution) continue
    const { sender, delta } = contribution

    // We do not count internal transfers coming from an account the wallet
    // owns itself.
    const entry = buyers.get(sender) ?? { lamports: 0, txCount: 0, signatures: [], firstAt: null, lastAt: null }
    entry.lamports += delta
    entry.txCount += 1
    entry.signatures.push(sig)
    const at = tx.blockTime ? new Date(blockMs).toISOString() : null
    if (at) {
      if (!entry.firstAt || at < entry.firstAt) entry.firstAt = at
      if (!entry.lastAt || at > entry.lastAt) entry.lastAt = at
    }
    buyers.set(sender, entry)
    processed += 1
  }
  process.stderr.write(`  ${Math.min(i + 100, candidates.length)}/${candidates.length}\n`)
}

// --- 2b) THE COMPLETENESS GATE ---------------------------------------------
// Without this gate the script runs fine even when the RPC history has been
// pruned, and produces A SHORTER list. Those buyers never enter the merkle tree,
// at TGE they see "you are not on the list", and once the root is written to the
// chain it cannot be fixed. So rather than continuing silently, we stop here.
{
  const TOLERANCE = Math.round(Number(process.env.COMPLETENESS_TOLERANCE_SOL ?? '0.01') * LAMPORTS_PER_SOL)
  const current = await withRetry(() => connection.getBalance(wallet), 'getBalance')
  const { complete, gap } = completenessCheck(scannedNet, current, TOLERANCE)
  process.stderr.write(
    `\nCompleteness: scanned net ${(scannedNet / LAMPORTS_PER_SOL).toFixed(4)} SOL · ` +
      `in the wallet ${(current / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`,
  )
  if (!complete) {
    process.stderr.write(
      `\nINCOMPLETE HISTORY — the list cannot be used.\n\n` +
        `The wallet holds ${(gap / LAMPORTS_PER_SOL).toFixed(4)} SOL that the ` +
        `transactions we scanned cannot account for.\n` +
        `The most likely cause: this RPC endpoint prunes history (it is not an\n` +
        `archive node), so the earliest contributors' transactions are invisible.\n` +
        `If a merkle tree is built from this list, those buyers see "you are not on\n` +
        `the list" at TGE, and once the root is on chain it CANNOT BE FIXED.\n\n` +
        `What to do: point RPC_URL at an archive node that keeps the full history\n` +
        `and run again.\n\n` +
        `(If you KNOW the difference is genuinely harmless — e.g. a non-presale\n` +
        `transfer was made into the wallet — you can raise the threshold with\n` +
        `COMPLETENESS_TOLERANCE_SOL. The default is 0.01 SOL.)\n`,
    )
    process.exit(1)
  }
}

// --- 3) The share and ticket calculation ------------------------------------
const rows = [...buyers.entries()]
  .map(([address, e]) => {
    const sol = e.lamports / LAMPORTS_PER_SOL
    return {
      address,
      lamports: e.lamports,
      sol: Number(sol.toFixed(9)),
      // `tokens` is FOR HUMANS: the whole token count (e.g. 350000).
      tokens: Math.floor(sol * TOKENS_PER_SOL),
      // `baseUnits` is FOR THE CHAIN: the SPL token's smallest unit, i.e.
      // tokens x 10^decimals. This is the number that ENTERS the merkle leaf
      // and the claim instruction.
      //
      // That distinction was once silently lost: build-merkle.mjs took the
      // `tokens` field for the smallest unit, and at 9 decimals the difference
      // is a factor of 1,000,000,000. Every buyer would have received A
      // BILLIONTH of what they were owed — the transactions succeed and nobody
      // sees an error.
      //
      // Putting the unit in the field name makes the same mistake harder to
      // repeat. The arithmetic uses BigInt: 271,950,000 x 10^9 exceeds
      // Number's safe range (2^53).
      baseUnits: (
        (BigInt(e.lamports) * BigInt(TOKENS_PER_SOL) * BigInt(10) ** BigInt(DECIMALS)) /
        BigInt(LAMPORTS_PER_SOL)
      ).toString(),
      tickets: Math.floor((sol + 1e-9) / TICKET_UNIT_SOL),
      txCount: e.txCount,
      firstAt: e.firstAt,
      lastAt: e.lastAt,
      signatures: e.signatures,
    }
  })
  .sort((a, b) => b.lamports - a.lamports)

const totals = rows.reduce(
  (acc, r) => ({
    lamports: acc.lamports + r.lamports,
    tokens: acc.tokens + r.tokens,
    baseUnits: acc.baseUnits + BigInt(r.baseUnits),
    tickets: acc.tickets + r.tickets,
  }),
  { lamports: 0, tokens: 0, baseUnits: 0n, tickets: 0 },
)

process.stderr.write(
  `\n${rows.length} buyer(s), ${processed} contribution transaction(s).\n` +
    `Total: ${(totals.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL · ` +
    `${totals.tokens.toLocaleString('en-US')} $LUCK · ${totals.tickets} ticket(s)\n` +
    (skipped.length ? `Skipped: ${skipped.length}\n` : ''),
)

// --- 4) Output --------------------------------------------------------------
if (FORMAT === 'csv') {
  console.log('address,sol,tokens,baseUnits,tickets,txCount,firstAt,lastAt')
  for (const r of rows) {
    console.log([r.address, r.sol, r.tokens, r.baseUnits, r.tickets, r.txCount, r.firstAt ?? '', r.lastAt ?? ''].join(','))
  }
} else {
  console.log(
    JSON.stringify(
      {
        wallet: WALLET,
        opsWallet: OPS_WALLET || null,
        rpc: RPC_URL,
        window: { start: process.env.START_ISO ?? null, end: process.env.END_ISO ?? null },
        tokensPerSol: TOKENS_PER_SOL,
        ticketUnitSol: TICKET_UNIT_SOL,
        generatedAt: new Date().toISOString(),
        totals: {
          buyers: rows.length,
          sol: Number((totals.lamports / LAMPORTS_PER_SOL).toFixed(9)),
          tokens: totals.tokens,
          baseUnits: totals.baseUnits.toString(),
          tickets: totals.tickets,
        },
        buyers: rows,
      },
      null,
      2,
    ),
  )
}
