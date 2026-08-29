#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Picks the raffle winners — verifiably
// ---------------------------------------------------------------------------
// THE PROBLEM: saying "we ran the raffle, here are the winners" proves nothing.
// Nobody can know the team did not pick the result in its own favour.
//
// THE SOLUTION: the randomness comes FROM THE CHAIN, and from THE FUTURE. A
// slot number is announced before the draw ("round 18 will be drawn with the
// hash of the first block AT OR AFTER slot 412,900,000"). Because that slot does
// not exist yet, nobody — us included — can know or influence its hash. Once the
// slot has passed the hash is public: anyone running this script with the same
// ticket list and the same announced slot finds THE SAME winners.
//
// "THE FIRST BLOCK AT OR AFTER THE SLOT" — not a single slot. On Solana a slot
// can be SKIPPED: if that slot's leader produces no block, there is no block at
// that number and no hash for it. Had we bound ourselves to one announced slot,
// a skip would make the draw impossible and force the operator to PICK A NEW
// SLOT — that is, to gain a choice that could influence the result, and the "we
// did not interfere" claim would collapse exactly there. The skip rate is 1-5%
// on mainnet and 5-15% on devnet, so this happens sooner or later.
//
// The rule is deterministic instead: starting from the announced slot, the first
// block going FORWARD that ACTUALLY EXISTS is used. Nobody gets a choice and
// everyone finds the same result. (The same fix as find_slot_hash_at_or_after in
// the game.)
//
// The same idea as the game's commit-reveal (see resolve() in
// program/luck-game).
//
// THE SELECTION: proportional to the ticket count, WITHOUT REPLACEMENT. When a
// wallet wins, all of its tickets leave the pool — it cannot win twice in the
// same round.
//
// Usage:
//   node scripts/draw-raffle.mjs --buyers buyers.json --slot 412900000 --winners 7
//   node scripts/draw-raffle.mjs --selftest

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { keccak_256 } from '@noble/hashes/sha3'
import { Connection } from '@solana/web3.js'

/**
 * Picks the winners from the ticket list. FULLY DETERMINISTIC: the same input
 * always gives the same output, and there is no Math.random anywhere.
 *
 * @param {{address: string, tickets: number}[]} entries
 * @param {Uint8Array} seed  the blockhash of the draw slot
 * @param {number} winnerCount
 */
export function drawWinners(entries, seed, winnerCount) {
  // We fix the ordering: if the input file's order changed, so would the
  // result, and the "I got the same result with the same list" claim would
  // collapse.
  const pool = entries
    .filter((e) => e.tickets > 0)
    .map((e) => ({ address: e.address, tickets: e.tickets }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))

  const winners = []
  for (let draw = 0; winners.length < winnerCount && pool.length > 0; draw++) {
    const total = pool.reduce((s, e) => s + e.tickets, 0)
    if (total <= 0) break

    // A separate number per draw: keccak(seed || round_index)
    const drawBytes = new Uint8Array(4)
    new DataView(drawBytes.buffer).setUint32(0, draw, true)
    const merged = new Uint8Array(seed.length + 4)
    merged.set(seed)
    merged.set(drawBytes, seed.length)
    const digest = keccak_256(merged)

    // We turn the 32 bytes into a single integer and take it modulo the
    // ticket total. BigInt is used because Number loses precision beyond
    // 2^53 and the selection would be biased invisibly.
    let value = 0n
    for (const b of digest) value = (value << 8n) | BigInt(b)
    let pick = Number(value % BigInt(total))

    let idx = 0
    while (idx < pool.length && pick >= pool[idx].tickets) {
      pick -= pool[idx].tickets
      idx++
    }
    if (idx >= pool.length) idx = pool.length - 1

    winners.push({ address: pool[idx].address, tickets: pool[idx].tickets, draw })
    // Without replacement: a winner leaves the pool entirely.
    pool.splice(idx, 1)
  }
  return winners
}

/**
 * The slot number of the first block that actually exists AT OR AFTER the
 * announced slot. It skips over skipped slots; if there is none it returns null.
 *
 * It takes a callback rather than calling `getBlocks(start, end)` directly, so
 * it can be tested without a network.
 */
export async function findDrawSlot(getBlocks, announced, window = 500) {
  const blocks = await getBlocks(announced, announced + window)
  if (!Array.isArray(blocks)) return null
  let smallest = null
  for (const s of blocks) {
    if (s < announced) continue
    if (smallest === null || s < smallest) smallest = s
  }
  return smallest
}

// --- CLI ---------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

// --- selftest ---------------------------------------------------------------
// Proves determinism and proportionality. If one person's tickets are half the
// total, their win rate across many different seeds should also be close to a
// half — this is the part that shows the selection is not merely repeatable but
// also FAIR.
if (isMain && process.argv.includes('--selftest')) {
  const entries = [
    { address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', tickets: 50 },
    { address: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', tickets: 25 },
    { address: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', tickets: 15 },
    { address: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', tickets: 10 },
  ]

  const seed = keccak_256(new TextEncoder().encode('sabit-tohum'))
  const a = drawWinners(entries, seed, 2)
  const b = drawWinners(entries, seed, 2)
  console.log('Determinism:', JSON.stringify(a) === JSON.stringify(b) ? 'PASSED' : 'FAILED')
  console.log('  kazananlar:', a.map((w) => w.address.slice(0, 4)).join(', '))

  // Can the same wallet win twice?
  const uniq = new Set(a.map((w) => w.address))
  console.log('No repeats:', uniq.size === a.length ? 'PASSED' : 'FAILED')

  // Proportionality
  const counts = Object.fromEntries(entries.map((e) => [e.address, 0]))
  const N = 20000
  for (let i = 0; i < N; i++) {
    const s = keccak_256(new TextEncoder().encode(`tohum-${i}`))
    counts[drawWinners(entries, s, 1)[0].address]++
  }
  console.log('Proportionality (expected / observed):')
  let ok = true
  for (const e of entries) {
    const expected = e.tickets / 100
    const actual = counts[e.address] / N
    const drift = Math.abs(expected - actual)
    if (drift > 0.02) ok = false
    console.log(
      `  ${e.address.slice(0, 4)}  ${(expected * 100).toFixed(1)}% / ${(actual * 100).toFixed(1)}%`,
    )
  }
  console.log('Proportionality:', ok ? 'PASSED' : 'FAILED (deviation greater than 2%)')

  // --- The skipped-slot rule ---
  // If the announced slot was skipped the draw must NOT stop and must NOT give
  // the operator a chance to pick a slot; by the rule, the next existing block
  // is used.
  let slotOk = true
  const slotCase = async (name, blocks, announcedSlot, expected) => {
    const got = await findDrawSlot(async () => blocks, announcedSlot, 500)
    const passed = got === expected
    if (!passed) slotOk = false
    console.log(`  ${passed ? 'PASSED' : 'FAILED'}  ${name}` + (passed ? '' : ` (expected ${expected}, got ${got})`))
  }
  console.log('The skipped-slot rule:')
  await slotCase('the announced slot exists -> the same one', [1000, 1001, 1002], 1000, 1000)
  await slotCase('the announced slot was skipped -> the next block', [1003, 1004], 1000, 1003)
  await slotCase('gaps in between -> the SMALLEST one', [1009, 1005, 1007], 1000, 1005)
  await slotCase('unordered input -> still the smallest', [1200, 1002, 1100], 1000, 1002)
  await slotCase('blocks BEFORE the announced slot do not count', [998, 999, 1004], 1000, 1004)
  await slotCase('no blocks at all -> null', [], 1000, null)
  console.log('The skipped-slot rule:', slotOk ? 'PASSED' : 'FAILED')
  if (!slotOk) process.exit(1)

  process.exit(0)
}

if (isMain) {
  const buyersPath = arg('buyers')
  const slot = Number(arg('slot'))
  const winnerCount = Number(arg('winners', '7'))
  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'

  if (!buyersPath || !Number.isFinite(slot)) {
    console.error('Usage: node scripts/draw-raffle.mjs --buyers buyers.json --slot <slot> [--winners 7]')
    process.exit(1)
  }

  const parsed = JSON.parse(readFileSync(buyersPath, 'utf8'))
  const entries = (parsed.buyers ?? []).map((b) => ({ address: b.address, tickets: b.tickets }))
  const totalTickets = entries.reduce((s, e) => s + e.tickets, 0)
  if (totalTickets === 0) {
    console.error('There are no tickets in the list.')
    process.exit(1)
  }

  const connection = new Connection(rpcUrl, 'confirmed')
  const WINDOW = Number(process.env.RAFFLE_SLOT_WINDOW ?? '500')
  const drawSlot = await findDrawSlot(
    (a, b) => connection.getBlocks(a, b),
    slot,
    WINDOW,
  )
  if (drawSlot === null) {
    console.error(
      `No block was found within ${WINDOW} slots at or after slot ${slot}.\n` +
        'The slot may not exist yet, or this RPC may not look back that far\n' +
        '(an archive node may be needed). Do NOT change the slot choice — changing\n' +
        'the rule destroys the verifiability of the draw.',
    )
    process.exit(1)
  }
  if (drawSlot !== slot) {
    process.stderr.write(
      `The announced slot ${slot} was skipped (no block was produced in it).\n` +
        `By the rule, the first block after it is used: ${drawSlot}\n\n`,
    )
  }
  const block = await connection.getBlock(drawSlot, {
    maxSupportedTransactionVersion: 0,
    transactionDetails: 'none',
    rewards: false,
  })
  if (!block) {
    console.error(`Slot ${drawSlot} appeared in getBlocks but could not be read — the RPC is inconsistent.`)
    process.exit(1)
  }

  // The blockhash is base58; we convert it to bytes and use it as the seed.
  const { PublicKey } = await import('@solana/web3.js')
  const seed = new PublicKey(block.blockhash).toBytes()

  const winners = drawWinners(entries, seed, winnerCount)

  process.stderr.write(
    `Announced slot: ${slot}\nDraw slot: ${drawSlot}\n` +
      `Blockhash: ${block.blockhash}\n` +
      `Participants: ${entries.length} · total tickets: ${totalTickets}\n` +
      `Kazanan: ${winners.length}\n\n`,
  )

  console.log(
    JSON.stringify(
      {
        // The announced slot: the number published BEFORE the draw.
        announcedSlot: slot,
        // The block actually used: the first existing one at or after the
        // announced slot. If they are equal, the announced slot was not skipped.
        slot: drawSlot,
        blockhash: block.blockhash,
        totalTickets,
        participants: entries.length,
        winnerCount,
        winners,
        // For verification: with these three pieces anyone can reproduce the result.
        howToVerify:
          'node scripts/draw-raffle.mjs --buyers <the same buyers.json> --slot ' +
          slot +
          ' --winners ' +
          winnerCount,
      },
      null,
      2,
    ),
  )
}
