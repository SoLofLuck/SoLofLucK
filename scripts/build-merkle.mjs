#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The merkle tree builder — the claim program's input
// ---------------------------------------------------------------------------
// Takes the recipient list and produces the 32-byte root that goes on chain,
// plus the "proof" with which each recipient proves their own share.
//
// THE WHOLE OUTPUT IS PUBLISHED. The value of merkle here is not privacy but
// VERIFIABILITY: a single root sits on chain and the recipient brings their
// proof. Because the list is published, everyone can see their own share,
// nobody can be added to the list afterwards (the root would change), and we
// cannot silently alter anyone's share either.
//
// THE HASHING must be byte-for-byte identical to the logic in the program
// (program/luck-distributor/src/lib.rs). A single byte of difference means
// everyone's proof is rejected on TGE day. That is why the `--selftest` mode
// below exists: the root produced from fixed inputs is also checked in the Rust
// test (see merkle_matches_javascript_builder). If the two independent
// implementations disagree, the tests catch it before TGE.
//
// Usage:
//   # presale (buyers.json -> presale-merkle.json)
//   node scripts/build-merkle.mjs buyers.json > presale-merkle.json
//
//   # a raffle round (winner addresses, an equal prize for everyone)
//   # CAREFUL: --amount is in THE SMALLEST UNIT, not whole tokens.
//   # 1,110,000 $LUCK at 9 decimals = 1110000 x 10^9 = 1110000000000000
//   node scripts/build-merkle.mjs --amount 1110000000000000 winners.txt > round-1.json
//
//   # verify that the two implementations agree
//   node scripts/build-merkle.mjs --selftest

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { keccak_256 } from '@noble/hashes/sha3'
import { PublicKey } from '@solana/web3.js'

const LEAF_PREFIX = Uint8Array.from([0x00])
const NODE_PREFIX = Uint8Array.from([0x01])

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function u64le(value) {
  const out = new Uint8Array(8)
  let v = BigInt(value)
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** keccak(0x00 || recipient(32) || amount_le(8)) */
export function leafHash(address, amount) {
  const key = new PublicKey(address).toBytes()
  return keccak_256(concat(LEAF_PREFIX, key, u64le(amount)))
}

/** keccak(0x01 || smaller || larger) — a "sorted pair", so the proof carries no direction. */
function nodeHash(a, b) {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a]
  return keccak_256(concat(NODE_PREFIX, lo, hi))
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

const hex = (bytes) => Buffer.from(bytes).toString('hex')

/**
 * Builds the tree. If a level is left with an odd node, it is promoted to the
 * level above as it is — duplicating it and pairing it with itself is a common
 * mistake and can lead to the same leaf being counted twice.
 */
export function buildTree(leaves) {
  if (leaves.length === 0) throw new Error('Empty list — a tree cannot be built.')
  const levels = [leaves]
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1]
    const next = []
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? nodeHash(prev[i], prev[i + 1]) : prev[i])
    }
    levels.push(next)
  }
  return levels
}

export function proofFor(levels, index) {
  const proof = []
  let idx = index
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l]
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1
    if (sibling < level.length) proof.push(level[sibling])
    idx = Math.floor(idx / 2)
  }
  return proof
}

/** Verifies that the produced proof really does lead to the root. */
export function verify(proof, root, leaf) {
  let computed = leaf
  for (const sibling of proof) computed = nodeHash(computed, sibling)
  return compare(computed, root) === 0
}

// ---------------------------------------------------------------------------

function parseEntries(argv) {
  const amountFlagIdx = argv.indexOf('--amount')
  const fixedAmount = amountFlagIdx >= 0 ? argv[amountFlagIdx + 1] : null
  // `--amount` YOKKEN indeks -1 oluyordu ve `amountFlagIdx + 1` de 0 —
  // so the filter removed EXACTLY the file name when it was the only
  // argument. The result: "No input file was given". That is why the
  // presale path (JSON, without --amount) never worked; only the raffle
  // path, which passes --amount, did.
  const amountValueIdx = amountFlagIdx >= 0 ? amountFlagIdx + 1 : -1
  const file = argv.filter((a, i) => !a.startsWith('--') && i !== amountValueIdx).at(-1)
  if (!file) throw new Error('No input file was given.')

  const raw = readFileSync(file, 'utf8')

  // Is this presale-buyers.mjs output (JSON) or a plain address list?
  if (raw.trimStart().startsWith('{')) {
    const parsed = JSON.parse(raw)

    // draw-raffle.mjs output: the winner addresses, with the prize given
    // through --amount (equal for everyone).
    //
    // Without this path, addresses had to be extracted BY HAND at TGE: the
    // raffle produces JSON while build-merkle expected a plain address
    // list. Leaving that conversion to a human is an open door to a
    // copy-paste mistake on exactly the day everyone is in a hurry.
    if (Array.isArray(parsed.winners)) {
      if (!fixedAmount) {
        throw new Error(
          'For a raffle result you must pass --amount <smallest unit> ' +
            '(e.g. 1,110,000 $LUCK at 9 decimals = 1110000000000000).',
        )
      }
      return parsed.winners.map((w) => ({ address: w.address, amount: BigInt(fixedAmount) }))
    }

    if (!Array.isArray(parsed.buyers)) {
      throw new Error('The JSON contains neither a "buyers" (presale) nor a "winners" (raffle) array.')
    }
    // `baseUnits` IS USED, NOT `tokens` — and that distinction is critical.
    //
    // `tokens` is for humans: the whole token count (e.g. 350000).
    // `baseUnits` is for the chain: the smallest unit, i.e. tokens x
    // 10^decimals. The number that enters the merkle leaf goes straight into
    // the claim instruction, and the SPL token program expects THE SMALLEST
    // UNIT.
    //
    // `b.tokens` was once read here. At 9 decimals the difference is a factor
    // of 1,000,000,000: every recipient would have received A BILLIONTH of
    // what they were owed. The transactions succeed, no error appears, and
    // the only people who would notice are the recipients looking at their
    // wallets.
    return parsed.buyers.map((b) => {
      if (b.baseUnits === undefined) {
        throw new Error(
          `The recipient record has no "baseUnits" (${b.address}). The list may have ` +
            'been produced by an older version of presale-buyers.mjs — rebuild it. ' +
            'The "tokens" field is a WHOLE TOKEN count and cannot go into a merkle leaf.',
        )
      }
      return { address: b.address, amount: BigInt(b.baseUnits) }
    })
  }

  if (!fixedAmount) {
    throw new Error('For a plain address list you must pass --amount <amount>.')
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((address) => ({ address, amount: BigInt(fixedAmount) }))
}

export function build(entries) {
  // If the same address appeared twice there would be two separate leaves, but
  // because the claim_status account is unique PER RECIPIENT the second could
  // never be claimed — money would be silently locked up. We error out
  // instead.
  const seen = new Set()
  for (const e of entries) {
    if (seen.has(e.address)) throw new Error(`The address appears twice in the list: ${e.address}`)
    seen.add(e.address)
    if (e.amount <= 0n) throw new Error(`The amount is zero or negative: ${e.address}`)
  }

  const leaves = entries.map((e) => leafHash(e.address, e.amount))
  const levels = buildTree(leaves)
  const root = levels[levels.length - 1][0]

  const claims = entries.map((e, i) => {
    const proof = proofFor(levels, i)
    // Every proof is verified here, the moment it is produced. Discovering a
    // broken proof on a user's screen on TGE day is not acceptable.
    if (!verify(proof, root, leaves[i])) {
      throw new Error(`The proof could not be verified: ${e.address}`)
    }
    return {
      address: e.address,
      amount: e.amount.toString(),
      proof: proof.map(hex),
    }
  })

  const total = entries.reduce((s, e) => s + e.amount, 0n)
  return { root: hex(root), total: total.toString(), count: claims.length, claims }
}

// --- selftest ---------------------------------------------------------------
// The fixed vectors the Rust-side test expects. If they change, the constant in
// program/luck-distributor/tests/distributor.rs has to be updated too — and if
// they disagree the test fails anyway, so nothing drifts silently.
const SELFTEST = [
  { address: 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36', amount: 1n },
  { address: '2Lzc6jorznu7zQKny79topGTE7V837oiV3j53zPH4Qh9', amount: 271_950_137n },
  { address: 'AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA', amount: 1_110_000n },
  { address: '3fBhNn8BEoFyQVAXasWj1xcNrcc2FRpLVQexFhZTnw6F', amount: 999_999_999n },
  { address: 'BiWqNZzCPCfJtVPNhoCrvEb9s6unpCFXXf38GR3WnPWX', amount: 70_007n },
]

// What follows runs only when the script is executed DIRECTLY. This file is
// also a module: the claim screen and the tests import the `leafHash`,
// `buildTree` and `verify` functions, and the CLI must not fire while they do.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain && process.argv.includes('--selftest')) {
  // --- Input parsing and unit tests --------------------------------------
  // Both come from REAL bugs; both were silent.
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmpDir = mkdtempSync(join(tmpdir(), 'merkle-selftest-'))

  // 1) Can the file name be read WITHOUT `--amount`?
  //    With the flag absent the index is -1, so the parser computed
  //    `-1 + 1 = 0` and removed the FIRST argument — exactly the file name
  //    when it was the only one. That is why the presale path never worked.
  const presaleFile = join(tmpDir, 'buyers.json')
  writeFileSync(
    presaleFile,
    JSON.stringify({
      buyers: [
        { address: SELFTEST[0].address, tokens: 350_000, baseUnits: '350000000000000' },
        { address: SELFTEST[1].address, tokens: 175_000, baseUnits: '175000000000000' },
      ],
    }),
  )
  let presaleEntries
  try {
    presaleEntries = parseEntries([presaleFile])
  } catch (err) {
    console.error(
      `SELFTEST FAILED: the input file could not be read without --amount — ${err.message}`,
    )
    process.exit(1)
  }
  if (presaleEntries.length !== 2) {
    console.error(
      `SELFTEST FAILED: ${presaleEntries.length} recipient(s) read, it should have been 2.`,
    )
    process.exit(1)
  }

  // 2) Does THE SMALLEST UNIT enter the merkle leaf rather than whole tokens?
  //    At 9 decimals the difference is a factor of 1,000,000,000: getting it
  //    wrong would pay every recipient a billionth of what they were owed,
  //    and no error would appear.
  if (presaleEntries[0].amount !== 350_000_000_000_000n) {
    console.error(
      `SELFTEST FAILED: the leaf amount is ${presaleEntries[0].amount}, ` +
        'it should be 350000000000000 (the smallest unit).',
    )
    process.exit(1)
  }

  // 3) Is an OLD-format list without `baseUnits` rejected?
  const oldFile = join(tmpDir, 'old.json')
  writeFileSync(oldFile, JSON.stringify({ buyers: [{ address: SELFTEST[0].address, tokens: 350_000 }] }))
  let rejected = false
  try {
    parseEntries([oldFile])
  } catch {
    rejected = true
  }
  if (!rejected) {
    console.error('SELFTEST FAILED: a list without baseUnits was silently accepted.')
    process.exit(1)
  }
  console.log('Input parsing and unit checks: PASSED\n')

  const out = build(SELFTEST)
  console.log('The fixed-vector root (the Rust test must expect this value):')
  console.log(out.root)
  console.log('\nTotal:', out.total, '· leaves:', out.count)
  for (const c of out.claims) {
    console.log(`  ${c.address}  ${c.amount}  proof=${c.proof.length}`)
  }
  process.exit(0)
}

if (isMain) {
  const entries = parseEntries(process.argv.slice(2))
  process.stderr.write(`${entries.length} recipient(s) read, building the tree...\n`)
  const result = build(entries)
  process.stderr.write(`Root: ${result.root}\nTotal: ${result.total}\n`)
  console.log(JSON.stringify(result, null, 2))
}
