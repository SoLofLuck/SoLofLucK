#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Runbook check — do the commands in the documents still exist
// ---------------------------------------------------------------------------
// Documentation rot is silent: a script is renamed, an npm script is removed,
// and the runbook stays as it was. The problem only surfaces on TGE day, when
// the command says "not found" — that is, at exactly the wrong moment.
//
// This check verifies that every `npm run X`, `node scripts/X.mjs` and
// `cargo test X` reference in the documents actually exists. Not that the
// commands work CORRECTLY (that is the tests' job) — that they exist.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// Both documents carry command and file references; both can rot.
const DOCS = ['TGE-RUNBOOK.md', 'SECURITY.md']
let runbook = ''
for (const name of DOCS) {
  const path = `${root}${name}`
  if (!existsSync(path)) {
    console.error(`${name} was not found.`)
    process.exit(1)
  }
  runbook += readFileSync(path, 'utf8') + '\n'
}
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))

const failures = []
const checks = []

// npm run <name>
const npmNames = new Set(
  [...runbook.matchAll(/npm run ([a-z0-9:-]+)/g)].map((m) => m[1]),
)
for (const name of npmNames) {
  const exists = Object.hasOwn(pkg.scripts ?? {}, name)
  checks.push({ name: `npm run ${name}`, ok: exists })
  if (!exists) failures.push(`npm run ${name}`)
}

// node <path>.mjs
const paths = new Set(
  [...runbook.matchAll(/node ((?:scripts|program)\/[^\s\\`]+\.mjs)/g)].map((m) => m[1]),
)
for (const path of paths) {
  const exists = existsSync(`${root}${path}`)
  checks.push({ name: `node ${path}`, ok: exists })
  if (!exists) failures.push(path)
}

// --- cargo test <name> ------------------------------------------------------
// SECURITY.md invites the reader to run a specific test by name ("cargo test
// chaos"). If a test is renamed and the document is not, the reader runs a
// command that quietly matches nothing: cargo reports "0 tests" and exits 0, so
// it looks like it passed. A verification instruction that silently verifies
// nothing is worse than none at all.
{
  const testSources = []
  for (const dir of [
    `${root}program/luck-game/programs/luck-game/tests`,
    `${root}program/luck-distributor/programs/luck-distributor/tests`,
  ]) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.rs')) testSources.push(readFileSync(`${dir}/${file}`, 'utf8'))
    }
  }
  const allTests = testSources.join('\n')
  const filters = new Set(
    [...runbook.matchAll(/cargo test ([a-z0-9_]+)/g)].map((m) => m[1]),
  )
  for (const filter of filters) {
    // cargo's filter is a substring match on the test path, which is exactly
    // what we reproduce here.
    const matches = [...allTests.matchAll(/fn\s+([a-z0-9_]+)\s*\(/g)]
      .map((m) => m[1])
      .filter((fn) => fn.includes(filter))
    checks.push({ name: `cargo test ${filter} (${matches.length} test(s))`, ok: matches.length > 0 })
    if (matches.length === 0) failures.push(`cargo test ${filter} matches no test`)
  }
}

// Are the config fields named in the documents really in config.ts?
const src = readFileSync(`${root}src/config.ts`, 'utf8')
for (const field of ['PRESALE_START_ISO', 'LUCK_TOKEN', 'CLAIM_CONFIG', 'DEFAULT_NETWORK', 'DEFAULT_DECIMALS']) {
  if (!runbook.includes(field)) continue
  const exists = src.includes(field)
  checks.push({ name: `config.ts: ${field}`, ok: exists })
  if (!exists) failures.push(field)
}

// --- are the numbers in SECURITY.md still right ----------------------------
//
// The document contains concrete numbers such as "luck-game 33 tests" and "213
// checks", and they are offered outward as an assurance. Publishing a wrong
// number is worse than publishing none: a reader stops trusting the rest of the
// document too.
//
// The numbers are verified by COUNTING them from the source; they are not
// compared against a hand-written copy (that would prove the copy agrees with
// itself).
{
  const security = readFileSync(`${root}SECURITY.md`, 'utf8')

  const countTests = (dir) => {
    let n = 0
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.rs')) continue
      const src = readFileSync(`${dir}/${file}`, 'utf8')
      n += (src.match(/#\[(?:tokio::)?test\]/g) ?? []).length
    }
    return n
  }
  const gameTests = countTests(`${root}program/luck-game/programs/luck-game/tests`)
  const distributorTests = countTests(
    `${root}program/luck-distributor/programs/luck-distributor/tests`,
  )

  const number = (re, label) => {
    const m = security.match(re)
    if (!m) {
      failures.push(label)
      checks.push({ name: `SECURITY.md: the ${label} line was not found`, ok: false })
      return null
    }
    return Number(m[1])
  }

  const docGame = number(/luck-game (\d+),/, 'luck-game test count')
  const docDistributor = number(/luck-distributor (\d+) tests/, 'luck-distributor test count')
  const docSeeds = number(/(\d+) seeds x \d+ random steps/, 'chaos seed count')

  // The chaos seeds: the tests named individually plus the extra-seed array.
  const chaosSrc = readFileSync(
    `${root}program/luck-game/programs/luck-game/tests/chaos.rs`,
    'utf8',
  )
  const namedSeeds = (chaosSrc.match(/run_chaos\(0x[0-9A-Fa-f_]+,/g) ?? []).length
  const seedArray = chaosSrc.match(/for seed in \[([^\]]*)\]/)
  const arraySeeds = seedArray ? seedArray[1].split(',').filter((x) => x.trim()).length : 0

  const compare = (label, inDoc, actual) => {
    if (inDoc === null) return
    const ok = inDoc === actual
    checks.push({ name: `SECURITY.md: ${label} (${inDoc})`, ok })
    if (!ok) failures.push(`${label}: the document says ${inDoc}, the project has ${actual}`)
  }
  compare('luck-game test count', docGame, gameTests)
  compare('luck-distributor test count', docDistributor, distributorTests)
  compare('chaos seed count', docSeeds, namedSeeds + arraySeeds)

  // The check counts: the relevant scripts are run and the number read from
  // their output.
  for (const [label, command, re] of [
    ['ABI check count', 'check:abi', /\| ABI check \| (\d+) checks/],
    ['tokenomics check count', 'check:tokenomics', /\| Tokenomics check \| (\d+) checks/],
  ]) {
    const inDoc = number(re, label)
    if (inDoc === null) continue
    let actual = null
    try {
      const output = execFileSync('npm', ['run', '--silent', command], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const m = output.match(/^All (\d+) checks passed/m)
      actual = m ? Number(m[1]) : null
    } catch {
      actual = null
    }
    if (actual === null) {
      checks.push({ name: `SECURITY.md: ${label} — ${command} could not be read`, ok: false })
      failures.push(label)
    } else {
      compare(label, inDoc, actual)
    }
  }
}

for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}`)

if (failures.length > 0) {
  console.error(
    `\n${failures.length} inconsistencies: the documents and the project disagree.\n` +
      failures.map((f) => `  - ${f}`).join('\n') +
      '\nThe documentation has rotted — on TGE day these commands will not run, ' +
      'or the published numbers will be wrong.',
  )
  process.exit(1)
}
console.log(`\nAll ${checks.length} references are in place.`)
