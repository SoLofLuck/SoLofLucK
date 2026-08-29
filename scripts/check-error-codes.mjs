#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Error-code check — is each message in the interface bound to the right error
// ---------------------------------------------------------------------------
// The interface turns the raw errors coming from the chain into messages a user
// can understand, and it does so by looking at the error CODE (e.g. 0x1776 =
// NoSpinsRemaining). In Anchor those codes are derived from the ORDER of the
// enum: 6000 + the variant's index.
//
// So if a variant is inserted in the middle of the enum, EVERY code after it
// shifts and the interface silently shows the WRONG message: it says "you have
// no spins left" when the truth is "the reveal window expired". Because the
// code keeps working, we would only learn about it from a user complaint.
//
// This check compares every `/Name|0xNNNN/` pair in the interface against the
// order of the enum in the program.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const ANCHOR_ERROR_OFFSET = 6000

function enumCodes(file, enumName) {
  const src = readFileSync(file, 'utf8')
  const start = src.indexOf(`pub enum ${enumName} {`)
  if (start === -1) throw new Error(`${enumName} not found: ${file}`)
  const end = src.indexOf('\n}', start)
  const body = src.slice(start, end)
  const variants = [...body.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/gm)].map((m) => m[1])
  const codes = new Map()
  variants.forEach((name, i) => codes.set(name, ANCHOR_ERROR_OFFSET + i))
  return codes
}

const failures = []
const checks = []

function inspect(interfaceFile, programFile, enumName) {
  const codes = enumCodes(`${root}${programFile}`, enumName)
  const ui = readFileSync(`${root}${interfaceFile}`, 'utf8')
  // Matches of the form `/Name|0xNNNN/i`.
  const pairs = [...ui.matchAll(/\/([A-Z][A-Za-z0-9]*)\|(0x[0-9a-fA-F]+)\/i/g)]
  if (pairs.length === 0) {
    failures.push(`${interfaceFile}: no error-code match found — the pattern may have changed`)
    return
  }
  for (const [, name, hex] of pairs) {
    const expected = codes.get(name)
    const actual = parseInt(hex, 16)
    if (expected === undefined) {
      failures.push(`${interfaceFile}: "${name}" is not in ${enumName}`)
      checks.push({ name: `${name} exists in the enum`, ok: false })
      continue
    }
    const ok = expected === actual
    checks.push({
      name: `${name} = ${hex} (${actual})`,
      ok,
      detail: ok ? '' : `by the enum order it should be ${expected} (0x${expected.toString(16)})`,
    })
    if (!ok) failures.push(name)
  }
}

inspect(
  'src/components/solofluck/GameTab.tsx',
  'program/luck-game/programs/luck-game/src/lib.rs',
  'GameError',
)

for (const c of checks) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `  — ${c.detail}` : ''}`)
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length} error code(s) do not match. The interface would translate an error ` +
      'from the chain into the WRONG message — the code keeps working and we would only learn ' +
      'about it from a user complaint.',
  )
  process.exit(1)
}
console.log(`\nAll ${checks.length} error codes agree with the enum order.`)
