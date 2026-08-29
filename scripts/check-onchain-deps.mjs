#!/usr/bin/env node
// ---------------------------------------------------------------------------
// On-chain dependencies — the pinned set plus an advisory check
// ---------------------------------------------------------------------------
// `cargo audit` scans Cargo.lock. Cargo.lock contains the ENTIRE Solana
// validator/TLS stack pulled in for tests: h2, quinn (QUIC), rustls-webpki,
// ring, tokio, curve25519-dalek and so on. On the first CI run 10
// "vulnerabilities" appeared and every one of them came from that stack. None
// of them is inside the program uploaded to the chain.
//
// Auditing Cargo.lock as if it were the on-chain program is a CATEGORY ERROR.
// The right question is: which packages enter the SBF build?
//
// This check answers that question (see scripts/lib/sbf-deps.mjs — the cfg
// conditions are evaluated for the SBF target and the graph is walked) and does
// two things:
//
//   1. Is the on-chain set identical to the PINNED list? If a new package
//      enters, the check fails and somebody has to ask "what is this package,
//      and is it clean?".
//
//   2. If AUDIT_JSON is provided (CI provides it), is NONE of the advisories
//      cargo-audit found in that set? If a package in the set has an advisory,
//      the check fails — this is the hard gate.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cfgIsTrue, edgeApplies, sbfDependencies } from './lib/sbf-deps.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const PROGRAMS = ['luck-game', 'luck-distributor']
const PIN_FILE = `${root}scripts/onchain-dependencies.json`

// --- selftest: the cfg evaluator -------------------------------------------
// This evaluator carries a SECURITY decision: if it is wrong we either miss a
// package that is on chain (dangerous) or believe in a package that is not
// (noise). So it has its own tests.
if (process.argv.includes('--selftest')) {
  let failed = 0
  const t = (name, actual, expected) => {
    const ok = actual === expected
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) console.log(`   expected ${expected}, got ${actual}`)
  }

  t('target_os = "solana" is true', cfgIsTrue('target_os = "solana"'), true)
  t('not(target_os = "solana") is false', cfgIsTrue('not(target_os = "solana")'), false)
  t('target_os = "linux" is false', cfgIsTrue('target_os = "linux"'), false)
  t('unix is false', cfgIsTrue('unix'), false)
  t('windows is false', cfgIsTrue('windows'), false)
  t('any(unix, windows) is false', cfgIsTrue('any(unix, windows)'), false)
  t('not(any(unix, windows)) is true', cfgIsTrue('not(any(unix, windows))'), true)
  t('target_pointer_width = "64" is true', cfgIsTrue('target_pointer_width = "64"'), true)
  t('target_arch = "wasm32" is false', cfgIsTrue('target_arch = "wasm32"'), false)
  t(
    'all(target_os = "solana", target_endian = "little") is true',
    cfgIsTrue('all(target_os = "solana", target_endian = "little")'),
    true,
  )
  t(
    'nested: not(all(any(unix, windows), target_os = "linux")) is true',
    cfgIsTrue('not(all(any(unix, windows), target_os = "linux"))'),
    true,
  )
  // Unknown build flags must count as off; counting them as on would surface
  // packages that should not be in the graph.
  t('an unknown flag (miri) is false', cfgIsTrue('miri'), false)
  t('rustix_use_libc is false', cfgIsTrue('rustix_use_libc'), false)

  t('an unconditional edge applies', edgeApplies(null), true)
  t('a plain triple does not apply', edgeApplies('aarch64-linux-android'), false)
  t('cfg(not(target_os="solana")) does not apply', edgeApplies('cfg(not(target_os = "solana"))'), false)
  t('cfg(target_os="solana") applies', edgeApplies('cfg(target_os = "solana")'), true)

  // A sanity check against reality: is the computed set plausible?
  const set = new Set(sbfDependencies(`${root}program/luck-game`, 'luck-game'))
  const has = (x) => [...set].some((p) => p.startsWith(x + '@'))
  t('solana-program is in the set', has('solana-program'), true)
  t('anchor-lang is in the set', has('anchor-lang'), true)
  t('blake3 is in the set', has('blake3'), true)
  // NONE of these should enter the chain. If they do, either the evaluator is
  // broken or there is a real problem — both need looking at.
  for (const outside of ['tokio', 'h2', 'quinn-proto', 'rustls-webpki', 'ring', 'im', 'sized-chunks', 'curve25519-dalek', 'ed25519-dalek']) {
    t(`${outside} is NOT in the set`, has(outside), false)
  }

  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`)
  process.exit(failed === 0 ? 0 : 1)
}

// --- the check itself -------------------------------------------------------
const problems = []
const checks = []

const update = process.argv.includes('--update')
const pinned = existsSync(PIN_FILE)
  ? JSON.parse(readFileSync(PIN_FILE, 'utf8'))
  : {}

const computed = {}
for (const program of PROGRAMS) {
  computed[program] = sbfDependencies(`${root}program/${program}`, program)
}

if (update) {
  writeFileSync(PIN_FILE, JSON.stringify(computed, null, 2) + '\n')
  console.log('onchain-dependencies.json was updated. REVIEW the change:')
  for (const p of PROGRAMS) console.log(`  ${p}: ${computed[p].length} package(s)`)
  process.exit(0)
}

for (const program of PROGRAMS) {
  const actual = computed[program]
  const expected = pinned[program]
  if (!expected) {
    problems.push(`${program}: no pinned list — run 'node scripts/check-onchain-deps.mjs --update'`)
    checks.push({ name: `${program}: has a pinned list`, ok: false })
    continue
  }
  const missing = expected.filter((d) => !actual.includes(d))
  const added = actual.filter((d) => !expected.includes(d))
  const ok = missing.length === 0 && added.length === 0
  checks.push({ name: `${program}: ${actual.length} package(s) enter the chain`, ok })
  if (added.length) {
    problems.push(
      `${program}: package(s) NEWLY entering the chain: ${added.join(', ')}\n` +
        "      These packages go inside the deployed bytecode. Check their RustSec\n" +
        '      record and refresh the list deliberately with --update.',
    )
  }
  if (missing.length) {
    problems.push(`${program}: in the list but no longer entering: ${missing.join(', ')} — refresh with --update`)
  }
}

// --- cross-check against the cargo-audit output ----------------------------
// AUDIT_JSON is the path to the `cargo audit --json` output. CI provides it;
// without it this section is skipped (the sandbox has no crates.io access).
const auditPath = process.env.AUDIT_JSON
if (auditPath) {
  if (!existsSync(auditPath)) {
    problems.push(`AUDIT_JSON was given but the file does not exist: ${auditPath}`)
    checks.push({ name: 'the audit output could be read', ok: false })
  } else {
    let report
    try {
      report = JSON.parse(readFileSync(auditPath, 'utf8'))
    } catch (e) {
      problems.push(`the audit JSON could not be parsed: ${e.message}`)
      report = null
    }
    // PASSING SILENTLY when the schema has changed is the worst outcome: the
    // check would not have run at all, yet it would look green.
    const list = report?.vulnerabilities?.list
    if (!Array.isArray(list)) {
      problems.push(
        'vulnerabilities.list was not found in the audit JSON — the cargo-audit schema may have changed',
      )
      checks.push({ name: 'the audit schema was recognised', ok: false })
    } else {
      checks.push({ name: `audit report read (${list.length} advisories, whole lockfile)`, ok: true })
      const wholeSet = new Set(PROGRAMS.flatMap((p) => computed[p]))
      const onChain = list.filter((v) =>
        wholeSet.has(`${v.package?.name}@${v.package?.version}`),
      )
      const ok = onChain.length === 0
      checks.push({ name: 'no advisories in the packages that enter the chain', ok })
      if (!ok) {
        problems.push(
          'A SECURITY ADVISORY IN THE ON-CHAIN PROGRAM:\n' +
            onChain
              .map(
                (v) =>
                  `      - ${v.package.name} ${v.package.version}: ` +
                  `${v.advisory?.id} — ${v.advisory?.title}`,
              )
              .join('\n'),
        )
      }
      const offChain = list.length - onChain.length
      if (offChain > 0) {
        console.log(
          `  (${offChain} advisories are in the test/host stack only — they do not enter the chain)`,
        )
      }
    }
  }
}

for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}`)

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join('\n'))
  process.exit(1)
}
console.log('\nThe dependencies entering the chain match the pinned list.')
