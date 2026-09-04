#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Combines a round's ticket-raffle winners with its Twitter/X winners
// ---------------------------------------------------------------------------
// A round has 10 winners: 7 drawn on-chain from presale tickets
// (draw-raffle.mjs), 3 entered by hand from that week's Twitter/X campaign
// (data/twitter-winners.json — see data/README.md). This script merges the
// two into the single { winners: [...] } shape build-merkle.mjs already reads
// from draw-raffle.mjs's output, so the rest of the TGE-RUNBOOK.md pipeline
// does not change.
//
// It exists so that a mistake in the hand-entered half — the wrong count, a
// typo'd address, a wallet that already won the ticket half — is caught HERE,
// before build-merkle.mjs locks an amount into an irreversible on-chain round.
//
// Usage:
//   node scripts/combine-raffle-winners.mjs \
//     --ticket-winners winners-ticket-1.json --round 1 \
//     [--twitter-file data/twitter-winners.json] > winners-1.json
//
//   node scripts/combine-raffle-winners.mjs --selftest

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { PublicKey } from '@solana/web3.js'

const configSrc = () => readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')

const int = (src, re, label) => {
  const m = src.match(re)
  if (!m) throw new Error(`not found in config.ts: ${label}`)
  return Number(m[1].replace(/_/g, ''))
}

export function raffleShape(src = configSrc()) {
  return {
    ticketPerRound: int(src, /ticket:\s*\{\s*winnersPerRound:\s*(\d+)/, 'RAFFLE.ticket.winnersPerRound'),
    twitterPerRound: int(src, /twitter:\s*\{\s*winnersPerRound:\s*(\d+)/, 'RAFFLE.twitter.winnersPerRound'),
  }
}

function isValidAddress(address) {
  try {
    new PublicKey(address)
    return true
  } catch {
    return false
  }
}

/**
 * @param {{winners: {address: string}[]}} ticketResult  draw-raffle.mjs's output
 * @param {string[]} twitterAddresses  this round's hand-entered winners
 * @param {{ticketPerRound: number, twitterPerRound: number}} shape
 */
export function combine(ticketResult, twitterAddresses, shape) {
  const ticketWinners = ticketResult?.winners
  if (!Array.isArray(ticketWinners)) {
    throw new Error('The ticket-winners file has no "winners" array — is this draw-raffle.mjs\'s output?')
  }
  if (ticketWinners.length !== shape.ticketPerRound) {
    throw new Error(
      `Expected ${shape.ticketPerRound} ticket winners (RAFFLE.ticket.winnersPerRound), got ${ticketWinners.length}.`,
    )
  }

  if (!Array.isArray(twitterAddresses)) {
    throw new Error('This round is not an array in data/twitter-winners.json.')
  }
  if (twitterAddresses.length !== shape.twitterPerRound) {
    throw new Error(
      `Expected ${shape.twitterPerRound} Twitter winners for this round (RAFFLE.twitter.winnersPerRound), ` +
        `got ${twitterAddresses.length}. Fill data/twitter-winners.json for this round first.`,
    )
  }

  for (const address of twitterAddresses) {
    if (!isValidAddress(address)) {
      throw new Error(`Not a valid Solana address in data/twitter-winners.json: "${address}"`)
    }
  }

  const seen = new Set()
  for (const address of [...ticketWinners.map((w) => w.address), ...twitterAddresses]) {
    if (seen.has(address)) {
      throw new Error(`The same address wins twice in this round: ${address}`)
    }
    seen.add(address)
  }

  return {
    winners: [
      ...ticketWinners.map((w) => ({ address: w.address, source: 'ticket' })),
      ...twitterAddresses.map((address) => ({ address, source: 'twitter' })),
    ],
  }
}

// --- CLI ---------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain && process.argv.includes('--selftest')) {
  const shape = { ticketPerRound: 7, twitterPerRound: 3 }
  const ticketResult = {
    winners: Array.from({ length: 7 }, (_, i) => ({ address: `Ticket${i}11111111111111111111111111` })),
  }
  const twitter = ['So11111111111111111111111111111111111111112', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPks6M', 'Vote111111111111111111111111111111111111111']

  let ok = true
  const test = (name, fn) => {
    try {
      fn()
      console.log(`✓ ${name}`)
    } catch (err) {
      ok = false
      console.log(`✗ ${name}: ${err.message}`)
    }
  }

  test('happy path merges 7 + 3 into 10', () => {
    const out = combine(ticketResult, twitter, shape)
    if (out.winners.length !== 10) throw new Error(`got ${out.winners.length} winners`)
  })

  test('wrong Twitter count is rejected', () => {
    let threw = false
    try {
      combine(ticketResult, twitter.slice(0, 2), shape)
    } catch {
      threw = true
    }
    if (!threw) throw new Error('accepted only 2 Twitter winners')
  })

  test('an invalid address is rejected', () => {
    let threw = false
    try {
      combine(ticketResult, ['not-a-real-address', ...twitter.slice(1)], shape)
    } catch {
      threw = true
    }
    if (!threw) throw new Error('accepted an invalid address')
  })

  test('a Twitter winner already won by ticket is rejected', () => {
    let threw = false
    try {
      combine(ticketResult, [ticketResult.winners[0].address, ...twitter.slice(1)], shape)
    } catch {
      threw = true
    }
    if (!threw) throw new Error('let the same wallet win twice in one round')
  })

  test('RAFFLE.ticket.winnersPerRound / RAFFLE.twitter.winnersPerRound parse from config.ts', () => {
    const real = raffleShape()
    if (real.ticketPerRound !== 7 || real.twitterPerRound !== 3) {
      throw new Error(`got ${JSON.stringify(real)}`)
    }
  })

  console.log(ok ? '\nAll checks passed.' : '\nSome checks FAILED.')
  process.exit(ok ? 0 : 1)
}

if (isMain && !process.argv.includes('--selftest')) {
  const ticketWinnersPath = arg('ticket-winners')
  const round = arg('round')
  const twitterFile = arg('twitter-file', 'data/twitter-winners.json')

  if (!ticketWinnersPath || !round) {
    console.error(
      'Usage: node scripts/combine-raffle-winners.mjs --ticket-winners <file> --round <n> [--twitter-file data/twitter-winners.json]',
    )
    process.exit(1)
  }

  const ticketResult = JSON.parse(readFileSync(ticketWinnersPath, 'utf8'))
  const twitterAll = JSON.parse(readFileSync(twitterFile, 'utf8'))
  if (!Object.hasOwn(twitterAll, round)) {
    console.error(`Round "${round}" is not in ${twitterFile}.`)
    process.exit(1)
  }

  const shape = raffleShape()
  const combined = combine(ticketResult, twitterAll[round], shape)
  console.log(JSON.stringify(combined, null, 2))
}
