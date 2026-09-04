#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The per-winner raffle prize, in the smallest unit
// ---------------------------------------------------------------------------
// TGE-RUNBOOK.md's example command hardcodes 1110000000000000 (1,110,000
// $LUCK at 9 decimals) next to a comment explaining where it comes from. That
// is fine for a human reading the runbook, but a script that builds a round
// automatically (see .github/workflows/run-raffle-round.yml) should not carry
// its own copy of that number — if RAFFLE.perWinnerTokens or DEFAULT_DECIMALS
// ever changed, a second hardcoded copy is exactly the kind of drift
// check-tokenomics.mjs and check-runbook.mjs exist to catch. This script
// computes it from config.ts instead, once.
//
// Usage:
//   node scripts/raffle-amount.mjs           # prints the smallest-unit amount
//   node scripts/raffle-amount.mjs --selftest

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const int = (src, re, label) => {
  const m = src.match(re)
  if (!m) throw new Error(`not found in config.ts: ${label}`)
  return BigInt(m[1].replace(/_/g, ''))
}

export function perWinnerBaseUnits(src) {
  const perWinnerTokens = int(src, /perWinnerTokens:\s*([0-9_]+)/, 'RAFFLE.perWinnerTokens')
  const decimals = int(src, /DEFAULT_DECIMALS\s*=\s*(\d+)/, 'DEFAULT_DECIMALS')
  return perWinnerTokens * 10n ** decimals
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain && process.argv.includes('--selftest')) {
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

  test('1,110,000 $LUCK at 9 decimals = 1,110,000,000,000,000', () => {
    const src = 'export const RAFFLE = { perWinnerTokens: 1_110_000 }\nexport const DEFAULT_DECIMALS = 9'
    const got = perWinnerBaseUnits(src)
    if (got !== 1_110_000_000_000_000n) throw new Error(`got ${got}`)
  })

  test('scales with decimals', () => {
    const src = 'export const RAFFLE = { perWinnerTokens: 1_110_000 }\nexport const DEFAULT_DECIMALS = 6'
    const got = perWinnerBaseUnits(src)
    if (got !== 1_110_000_000_000n) throw new Error(`got ${got}`)
  })

  test('computes from the real config.ts without throwing', () => {
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
    perWinnerBaseUnits(src)
  })

  console.log(ok ? '\nAll checks passed.' : '\nSome checks FAILED.')
  process.exit(ok ? 0 : 1)
}

if (isMain && !process.argv.includes('--selftest')) {
  const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
  console.log(perWinnerBaseUnits(src).toString())
}
