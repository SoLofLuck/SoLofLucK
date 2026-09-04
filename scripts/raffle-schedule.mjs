#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The raffle schedule — a due date per round, and a permanent record of the
// announced/actual slot once each round is really drawn
// ---------------------------------------------------------------------------
// Two needs, one file (public/raffle-schedule.json):
//
//   1. BEFORE a round is drawn, the operator needs its calendar due date to
//      make the public "round N draws on <date>" announcement
//      TGE-RUNBOOK.md requires (step 6) — computed from TGE_ISO,
//      RAFFLE.firstRoundDay and RAFFLE.intervalDays, so nobody has to work it
//      out by hand or keep it somewhere off the record.
//
//   2. AFTER a round is drawn for real, the slot that was announced and the
//      block that was actually used (see draw-raffle.mjs's `announcedSlot` /
//      `slot` output) become a permanent public record on the same page —
//      the proof that the announcement really did happen before the result
//      was known.
//
// The file is public (site-served, like public/merkle/round-N.json) and
// read-only from the client's point of view; only this script and the
// run-raffle-round.yml workflow write to it.
//
// Usage:
//   node scripts/raffle-schedule.mjs --generate --out public/raffle-schedule.json
//   node scripts/raffle-schedule.mjs --record --out public/raffle-schedule.json \
//     --round 1 --announced-slot 412900000 --actual-slot 412900003 --drawn-at 2026-10-07T12:00:00Z
//   node scripts/raffle-schedule.mjs --selftest

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const configSrc = () => readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')

const int = (src, re, label) => {
  const m = src.match(re)
  if (!m) throw new Error(`not found in config.ts: ${label}`)
  return Number(m[1].replace(/_/g, ''))
}
const str = (src, re, label) => {
  const m = src.match(re)
  if (!m) throw new Error(`not found in config.ts: ${label}`)
  return m[1]
}

export function raffleTiming(src = configSrc()) {
  return {
    tgeIso: str(src, /export const TGE_ISO\s*=\s*'([^']*)'/, 'TGE_ISO'),
    rounds: int(src, /RAFFLE\s*=\s*\{[\s\S]*?rounds:\s*(\d+)/, 'RAFFLE.rounds'),
    firstRoundDay: int(src, /firstRoundDay:\s*(\d+)/, 'RAFFLE.firstRoundDay'),
    intervalDays: int(src, /intervalDays:\s*(\d+)/, 'RAFFLE.intervalDays'),
  }
}

/** Round N is due `firstRoundDay + (N-1) * intervalDays` days after TGE. */
export function dueDateIso(tgeIso, round, timing) {
  if (!tgeIso) return null
  const tge = new Date(tgeIso)
  if (Number.isNaN(tge.getTime())) throw new Error(`TGE_ISO is not a valid date: "${tgeIso}"`)
  const days = timing.firstRoundDay + (round - 1) * timing.intervalDays
  return new Date(tge.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
}

export function generateSchedule(timing, existing = []) {
  const byRound = new Map(existing.map((e) => [e.round, e]))
  const rows = []
  for (let round = 1; round <= timing.rounds; round++) {
    const prev = byRound.get(round)
    rows.push({
      round,
      dueIso: dueDateIso(timing.tgeIso, round, timing),
      announcedSlot: prev?.announcedSlot ?? null,
      actualSlot: prev?.actualSlot ?? null,
      drawnAtIso: prev?.drawnAtIso ?? null,
    })
  }
  return rows
}

export function recordDraw(schedule, { round, announcedSlot, actualSlot, drawnAtIso }) {
  const row = schedule.find((e) => e.round === round)
  if (!row) throw new Error(`Round ${round} is not in the schedule (1..${schedule.length}).`)
  return schedule.map((e) =>
    e.round === round ? { ...e, announcedSlot, actualSlot, drawnAtIso } : e,
  )
}

function readExisting(path) {
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return Array.isArray(parsed) ? parsed : []
}

// --- CLI ---------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
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

  const timing = { tgeIso: '2026-10-01T00:00:00.000Z', rounds: 14, firstRoundDay: 7, intervalDays: 7 }

  test('round 1 is due 7 days after TGE', () => {
    const got = dueDateIso(timing.tgeIso, 1, timing)
    if (got !== '2026-10-08T00:00:00.000Z') throw new Error(`got ${got}`)
  })

  test('round 2 is due 14 days after TGE', () => {
    const got = dueDateIso(timing.tgeIso, 2, timing)
    if (got !== '2026-10-15T00:00:00.000Z') throw new Error(`got ${got}`)
  })

  test('an empty TGE_ISO gives null due dates, not a crash', () => {
    const got = dueDateIso('', 1, timing)
    if (got !== null) throw new Error(`got ${got}`)
  })

  test('generateSchedule makes 14 rows, all undrawn, when there is no existing file', () => {
    const rows = generateSchedule(timing, [])
    if (rows.length !== 14) throw new Error(`got ${rows.length} rows`)
    if (rows.some((r) => r.announcedSlot !== null)) throw new Error('a fresh schedule already has a slot recorded')
  })

  test('regenerating preserves an already-recorded round', () => {
    const recorded = [{ round: 3, dueIso: 'stale', announcedSlot: 111, actualSlot: 112, drawnAtIso: 'x' }]
    const rows = generateSchedule(timing, recorded)
    const round3 = rows.find((r) => r.round === 3)
    if (round3.announcedSlot !== 111 || round3.actualSlot !== 112) {
      throw new Error('recorded slot data was lost on regenerate')
    }
    // the due date is still recomputed fresh, not left stale
    if (round3.dueIso === 'stale') throw new Error('due date was not recomputed')
  })

  test('recordDraw fills in exactly the named round', () => {
    const rows = generateSchedule(timing, [])
    const updated = recordDraw(rows, { round: 5, announcedSlot: 1, actualSlot: 2, drawnAtIso: 'now' })
    if (updated.find((r) => r.round === 5).actualSlot !== 2) throw new Error('round 5 was not updated')
    if (updated.find((r) => r.round === 4).actualSlot !== null) throw new Error('a different round was touched')
  })

  test('recordDraw rejects a round outside the schedule', () => {
    let threw = false
    try {
      recordDraw(generateSchedule(timing, []), { round: 99, announcedSlot: 1, actualSlot: 1, drawnAtIso: 'x' })
    } catch {
      threw = true
    }
    if (!threw) throw new Error('accepted round 99 of a 14-round schedule')
  })

  test('RAFFLE.firstRoundDay / RAFFLE.intervalDays / RAFFLE.rounds parse from config.ts', () => {
    const real = raffleTiming()
    if (real.rounds !== 14 || real.firstRoundDay !== 7 || real.intervalDays !== 7) {
      throw new Error(`got ${JSON.stringify(real)}`)
    }
  })

  console.log(ok ? '\nAll checks passed.' : '\nSome checks FAILED.')
  process.exit(ok ? 0 : 1)
}

if (isMain && process.argv.includes('--generate')) {
  const out = arg('out')
  if (!out) {
    console.error('Usage: node scripts/raffle-schedule.mjs --generate --out <path>')
    process.exit(1)
  }
  const timing = raffleTiming()
  const rows = generateSchedule(timing, readExisting(out))
  writeFileSync(out, JSON.stringify(rows, null, 2) + '\n')
  console.log(`Wrote ${rows.length} round(s) to ${out}.`)
}

if (isMain && process.argv.includes('--record')) {
  const out = arg('out')
  const round = Number(arg('round'))
  const announcedSlot = Number(arg('announced-slot'))
  const actualSlot = Number(arg('actual-slot'))
  const drawnAtIso = arg('drawn-at')
  if (!out || !Number.isFinite(round) || !Number.isFinite(announcedSlot) || !Number.isFinite(actualSlot) || !drawnAtIso) {
    console.error(
      'Usage: node scripts/raffle-schedule.mjs --record --out <path> --round <n> ' +
        '--announced-slot <n> --actual-slot <n> --drawn-at <iso>',
    )
    process.exit(1)
  }
  const schedule = readExisting(out)
  if (schedule.length === 0) {
    console.error(`${out} does not exist or is empty — run --generate first.`)
    process.exit(1)
  }
  const updated = recordDraw(schedule, { round, announcedSlot, actualSlot, drawnAtIso })
  writeFileSync(out, JSON.stringify(updated, null, 2) + '\n')
  console.log(`Recorded round ${round} in ${out}.`)
}
