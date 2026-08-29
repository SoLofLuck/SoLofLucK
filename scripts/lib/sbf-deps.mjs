// ---------------------------------------------------------------------------
// Computes the set of dependencies that enter the on-chain (SBF) build
// ---------------------------------------------------------------------------
// THE PROBLEM: `cargo audit` scans Cargo.lock, and Cargo.lock contains the
// ENTIRE Solana validator/TLS stack pulled in for tests — h2, quinn (QUIC),
// rustls-webpki, ring, tokio and so on. None of that ENTERS the program
// uploaded to the chain, yet it shows up in the audit output. On the first run
// 10 "advisories" appeared and every one of them came from that stack.
//
// Auditing Cargo.lock as if it were the on-chain program is a category error.
// The right question is: which packages enter the SBF build?
//
// WHY NOT `cargo tree --target sbf-solana-solana`: standard rustc does not know
// that target (Solana ships its own rustc fork), so cargo tree cannot resolve it
// and fails. The Solana toolchain is not available in CI.
//
// THE SOLUTION: `cargo metadata` states, on every dependency edge, the target
// condition under which that edge applies (e.g. cfg(not(target_os = "solana"))).
// We evaluate those conditions for the SBF target here and walk the graph
// ourselves. No rustc needed.

import { execFileSync } from 'node:child_process'

/** The cfg values of the SBF target. */
const SBF = {
  target_os: 'solana',
  target_arch: 'sbf',
  target_pointer_width: '64',
  target_endian: 'little',
  target_env: '',
  target_vendor: 'unknown',
}

/**
 * Evaluates a `cfg(...)` expression for the SBF target.
 *
 * cfg names it does not know (build flags such as rustix_use_libc, miri or
 * getrandom_backend) count as FALSE — they do not apply unless switched on
 * explicitly, and they are not switched on in our build.
 */
export function cfgIsTrue(expr) {
  const s = expr.trim()

  if (s.startsWith('not(')) return !cfgIsTrue(inner(s, 'not'))
  if (s.startsWith('any(')) return split(inner(s, 'any')).some(cfgIsTrue)
  if (s.startsWith('all(')) return split(inner(s, 'all')).every(cfgIsTrue)

  // key = "value"
  const m = s.match(/^([a-z_0-9]+)\s*=\s*"([^"]*)"$/)
  if (m) {
    const [, key, value] = m
    if (key in SBF) return SBF[key] === value
    // Keys we do not know, such as target_family: SBF is neither unix nor windows.
    if (key === 'target_family') return false
    return false
  }

  // Bare names
  if (s === 'unix' || s === 'windows') return false
  // Unknown flags count as off.
  return false
}

function inner(s, name) {
  const start = name.length + 1
  return s.slice(start, s.lastIndexOf(')'))
}

/** Split on commas — but not on commas inside parentheses. */
function split(s) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

/**
 * Does an edge's `target` field apply to SBF?
 *
 * `null`   -> unconditional, applies to every target.
 * `cfg(…)` -> evaluate the expression.
 * a plain triple (such as "aarch64-linux-android") -> not our target.
 */
export function edgeApplies(target) {
  if (target === null || target === undefined) return true
  const s = String(target).trim()
  if (s.startsWith('cfg(')) return cfgIsTrue(s.slice(4, s.lastIndexOf(')')))
  return false
}

/**
 * The set of packages (name@version) that enter the program's SBF build.
 *
 * Only NORMAL dependencies are followed: dev-dependencies run on the test
 * machine and build-dependencies run during the build — neither ends up inside
 * the bytecode uploaded to the chain.
 */
export function sbfDependencies(workingDir, packageName) {
  const raw = execFileSync('cargo', ['metadata', '--format-version', '1'], {
    cwd: workingDir,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  const meta = JSON.parse(raw)

  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
  const packages = new Map(meta.packages.map((p) => [p.id, p]))

  const root = meta.resolve.nodes.find((n) => {
    const p = packages.get(n.id)
    return p && p.name === packageName
  })
  if (!root) throw new Error(`package not found: ${packageName}`)

  const seen = new Set()
  const queue = [root.id]
  while (queue.length) {
    const id = queue.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodes.get(id)
    if (!node) continue
    for (const dep of node.deps) {
      // An edge can be of more than one kind (normal + dev). We follow only
      // the NORMAL ones (kind === null) whose target applies to SBF.
      const applies = dep.dep_kinds.some(
        (dk) => (dk.kind === null || dk.kind === undefined) && edgeApplies(dk.target),
      )
      if (applies) queue.push(dep.pkg)
    }
  }

  seen.delete(root.id)
  return [...seen]
    .map((id) => {
      const p = packages.get(id)
      return p ? `${p.name}@${p.version}` : id
    })
    .sort()
}
