#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Transaction send-path check
// ---------------------------------------------------------------------------
// Every on-chain transaction on the site must go through the shared, hardened
// path (sendTx.ts -> sendInstructions). A plain
// `getLatestBlockhash -> sign -> sendRawTransaction -> confirmTransaction`
// sequence is not reliable under mobile-wallet + shared-RPC conditions, and its
// worst outcome is not lost money but a DOUBLE PAYMENT:
//
//   confirmTransaction opens a websocket subscription. On mobile, switching
//   apps to approve in the wallet backgrounds the page and the subscription
//   silently drops. Because the notification never arrives, an error is shown
//   even when the transaction HAS LANDED. The first thing the user will do is
//   send it again.
//
// This happened exactly like that (first in the burn flow, then in the
// presale). That is why sendTx.ts was written — but its existence does not
// guarantee that a flow added later will use it. This check provides that
// guarantee.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../src', import.meta.url))

// The file that DEFINES the shared path, plus justified exceptions.
const EXEMPT = new Map([
  ['lib/sendTx.ts', 'the shared path itself'],
  [
    'lib/localTestWallet.ts',
    'only the devnet airdrop confirmation — it carries no user money, and a ' +
      'repeated airdrop cannot cause a double payment',
  ],
])

const FORBIDDEN = [
  { pattern: /\.sendRawTransaction\s*\(/, name: 'sendRawTransaction' },
  { pattern: /\.confirmTransaction\s*\(/, name: 'confirmTransaction' },
]

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (/\.(ts|tsx)$/.test(name)) yield path
  }
}

const findings = []
const lineExemptions = []
let scanned = 0

for (const path of files(src)) {
  const rel = path.slice(src.length + 1)
  if (EXEMPT.has(rel)) continue
  scanned++
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Comment lines are skipped: in these files the REASON for the fix is
    // explained in comments, and those comments contain the forbidden names.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    for (const { pattern, name } of FORBIDDEN) {
      if (!pattern.test(line)) continue
      // A line-level, JUSTIFIED exception. Rather than exempting the whole
      // file we exempt the single line, so that a flow added to the same file
      // later is still caught.
      //
      // The marker is looked for in the uninterrupted comment block
      // immediately ABOVE: the justification usually runs to several lines and
      // a fixed window would miss it.
      let start = i
      while (start > 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[start - 1])) start--
      const preceding = lines.slice(start, i).join('\n')
      const exemption = preceding.match(/tx-path-exempt:\s*(.+)/)
      if (exemption) {
        lineExemptions.push({ file: rel, line: i + 1, name, reason: exemption[1].trim() })
        continue
      }
      findings.push({ file: rel, line: i + 1, name, text: line.trim() })
    }
  }
}

console.log(`${scanned} file(s) scanned, ${EXEMPT.size} file(s) exempt.`)
for (const [file, reason] of EXEMPT) console.log(`  exempt: ${file} — ${reason}`)
for (const e of lineExemptions) {
  console.log(`  exempt: ${e.file}:${e.line} (${e.name}) — ${e.reason}`)
}

if (findings.length > 0) {
  console.error('\nFound code that bypasses the shared send path:')
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.name}\n      ${f.text}`)
  }
  console.error(
    '\nThese flows must go through sendInstructions in sendTx.ts. Otherwise a\n' +
      'transaction that landed on chain looks "failed" on mobile and the user\n' +
      'pays again. If an exception is genuinely needed, it has to be added to\n' +
      'the EXEMPT list WITH ITS REASON.',
  )
  process.exit(1)
}
console.log('\nEvery on-chain transaction goes through the shared, hardened path.')
