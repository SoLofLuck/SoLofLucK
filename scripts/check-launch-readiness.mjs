#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Launch-readiness check
// ---------------------------------------------------------------------------
// "The code is correct" and "we are ready to launch" are not the same thing.
// Some fields were deliberately left empty, and going live without filling them
// in has silent consequences — nothing errors, it just behaves wrongly:
//
//   With PRESALE_START_ISO empty the presale stays open INDEFINITELY. Because
//   no schedule counts as announced, no countdown appears and it never closes
//   when the time comes.
//
//   With LUCK_TOKEN.mint empty the Claim tab says "distribution has not
//   started" and no button works — and that is what everyone would see on TGE
//   day.
//
// This check DELIBERATELY does not fail the build: most of these fields MUST be
// empty during development. Run with `--strict` and it behaves as a launch gate
// instead.
//
// Usage:
//   node scripts/check-launch-readiness.mjs           # report
//   node scripts/check-launch-readiness.mjs --strict  # fails if anything is missing

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(`${root}src/config.ts`, 'utf8')
const strict = process.argv.includes('--strict')

const read = (re) => {
  const m = src.match(re)
  return m ? m[1] : ''
}

const items = []
const item = (name, value, note) =>
  items.push({ name, ready: Boolean(value), value, note })

item(
  '$LUCK mint address',
  read(/export const LUCK_TOKEN = \{[\s\S]*?mint: '([^']*)'/),
  'While empty, the Claim tab says "distribution has not started yet" and no button works.',
)
item(
  'Presale start date',
  read(/export const PRESALE_START_ISO\s*=\s*'([^']*)'/),
  'While empty the presale stays open INDEFINITELY: no countdown appears and it never closes.',
)
item(
  'Claim program',
  read(/export const CLAIM_CONFIG = \{[\s\S]*?programId: '([^']*)'/),
  'While empty nobody can claim their share.',
)
item(
  'Game program',
  read(/export const GAME_CONFIG[\s\S]*?programId: '([^']*)'/),
  'While empty the Game tab stays closed.',
)
item(
  'Presale wallet',
  read(/export const PRESALE_WALLET\s*=\s*'([^']*)'/),
  'While empty the presale send buttons are disabled.',
)

// Social links: a missing one only means that link is absent from the footer.
// Not a launch blocker, but it gives the impression of an abandoned project.
const social = ['twitter', 'telegram', 'discord'].map((k) => ({
  k,
  v: read(new RegExp(`${k}: '([^']*)'`)),
}))
for (const s of social) {
  item(
    `Social link: ${s.k}`,
    s.v,
    'Not a launch blocker; if missing, that link simply does not appear in the footer.',
  )
}

// The merkle files: which rounds have been published?
const merkleDir = `${root}public/merkle`
const rounds = existsSync(merkleDir)
  ? readdirSync(merkleDir).filter((f) => /^round-\d+\.json$/.test(f))
  : []
items.push({
  name: 'Published distribution lists',
  ready: rounds.length > 0,
  value: rounds.length ? rounds.join(', ') : '',
  note:
    'On TGE day at least the presale round (round-0.json) has to be published; the Claim ' +
    'tab reads the list from here and compares its root against the one on chain.',
})

// The network: have we moved to mainnet?
const defaultNetwork = read(/export const DEFAULT_NETWORK[^=]*=\s*'([^']+)'/)
items.push({
  name: 'Default network',
  ready: defaultNetwork === 'mainnet',
  value: defaultNetwork,
  note: 'It must be mainnet at launch. Left on devnet, nobody can make a real contribution.',
})

// --- has the "Stay Tuned" gate been removed --------------------------------
//
// While the site is in testing, EVERYONE arriving at the root address is shown
// a plain black "coming soon" page; the real app only opens through
// PREVIEW_ACCESS_PATH (see src/main.tsx).
//
// This is one of the items most easily forgotten on launch day, and forgetting
// it is a complete disaster: the presale opens, the announcement goes out, and
// everyone who arrives sees a BLANK BLACK SCREEN. Nothing errors, nothing is
// logged — the site looks like it is "working".
//
// Removing the gate means setting PREVIEW_ACCESS_PATH to an empty string;
// main.tsx opens the app directly on an empty path.
{
  const m = src.match(/export const PREVIEW_ACCESS_PATH\s*=\s*'([^']*)'/)
  const path = m ? m[1] : null
  items.push({
    name: 'The "coming soon" gate is removed',
    ready: path === '',
    value: path === null ? 'could not be read' : path === '' ? 'removed' : `hidden path ${path}`,
    note:
      'While the gate is up, EVERYONE arriving at the site sees the blank black "Stay Tuned" ' +
      'screen. If it is forgotten on launch day nothing errors and the site looks like it is ' +
      "working, but nobody can reach the presale page. To remove it, set " +
      "PREVIEW_ACCESS_PATH = ''.",
  })
}

const missing = items.filter((i) => !i.ready)

console.log('LAUNCH READINESS\n')
for (const i of items) {
  const mark = i.ready ? '✓' : '○'
  // The current value is shown even when the item is not ready: "○ Default
  // network" on its own does not say whether it is missing or wrong, whereas
  // "○ Default network (currently: devnet)" does.
  const value = i.value ? (i.ready ? ` — ${i.value}` : ` (currently: ${i.value})`) : ''
  console.log(`${mark} ${i.name}${value}`)
  if (!i.ready) console.log(`    ${i.note}`)
}

console.log(`\n${items.length - missing.length}/${items.length} ready.`)
if (missing.length > 0 && strict) {
  console.error(`\n${missing.length} item(s) missing — cannot launch.`)
  process.exit(1)
}
if (missing.length > 0) {
  console.log('(This check does not fail the build. Use --strict as a launch gate.)')
}
