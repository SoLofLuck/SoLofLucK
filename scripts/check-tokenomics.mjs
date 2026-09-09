#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Tokenomics consistency check
// ---------------------------------------------------------------------------
// The numbers in config.ts depend on each other: the presale bucket MUST equal
// target x price, the raffle bucket MUST equal rounds x winners x prize, and
// the marketing breakdown MUST equal its own total. If one of them is edited by
// hand and another is forgotten, the site publishes two numbers that contradict
// each other — and an investor notices that, not us.
//
// This check prevents exactly that: it runs on every build (before npm run
// build) and FAILS the build on any inconsistency.
//
// Usage: node scripts/check-tokenomics.mjs

import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'

const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')

const fails = []
const checks = []
function check(name, actual, expected) {
  const ok = actual === expected
  checks.push({ name, ok, actual, expected })
  if (!ok) fails.push(name)
}

const int = (re, label) => {
  const m = src.match(re)
  if (!m) throw new Error(`not found in config.ts: ${label}`)
  return Number(m[1].replace(/_/g, ''))
}

// --- Base numbers ------------------------------------------------------------
const supply = int(/totalSupply:\s*([0-9_]+)/, 'totalSupply')
const target = int(/export const PRESALE_TARGET_SOL\s*=\s*([0-9_]+)/, 'PRESALE_TARGET_SOL')
const perSol = int(/export const PRESALE_TOKENS_PER_SOL\s*=\s*([0-9_]+)/, 'PRESALE_TOKENS_PER_SOL')

// --- Bucket percentages ------------------------------------------------------
const buckets = {}
for (const m of src.matchAll(/key: '(\w+)',\s*\n\s*label: '[^']*',\s*\n\s*percent: (\d+)/g)) {
  buckets[m[1]] = Number(m[2])
}
const pctTotal = Object.values(buckets).reduce((a, b) => a + b, 0)
check('bucket percentages add up to 100%', pctTotal, 100)

const tokensOf = (key) => (supply * buckets[key]) / 100
for (const [key, pct] of Object.entries(buckets)) {
  check(`${key} bucket is a whole number of tokens`, Number.isInteger((supply * pct) / 100), true)
}

// --- Presale: target x price = bucket ----------------------------------------
check('presale bucket = target x price', tokensOf('presale'), target * perSol)

// --- Raffle ------------------------------------------------------------------
const rounds = int(/RAFFLE\s*=\s*\{[\s\S]*?rounds:\s*(\d+)/, 'RAFFLE.rounds')
const perRound = int(/perRoundTokens:\s*([0-9_]+)/, 'perRoundTokens')
const perWinner = int(/perWinnerTokens:\s*([0-9_]+)/, 'perWinnerTokens')
const ticketBlock = src.match(/ticket:\s*\{([\s\S]*?)\}/)[1]
const twitterBlock = src.match(/twitter:\s*\{([\s\S]*?)\}/)[1]
const sub = (block, name) => Number(block.match(new RegExp(name + ':\\s*([0-9_]+)'))[1].replace(/_/g, ''))

const tWin = sub(ticketBlock, 'winnersPerRound')
const tTotalWin = sub(ticketBlock, 'totalWinners')
const tTokens = sub(ticketBlock, 'totalTokens')
const xWin = sub(twitterBlock, 'winnersPerRound')
const xTotalWin = sub(twitterBlock, 'totalWinners')
const xTokens = sub(twitterBlock, 'totalTokens')

check('raffle: rounds x per-round prize = community bucket', rounds * perRound, tokensOf('community'))
check('raffle: ticket + twitter = community bucket', tTokens + xTokens, tokensOf('community'))
check('raffle: winner count x prize = per-round prize', (tWin + xWin) * perWinner, perRound)
check('raffle: ticket total winners', tWin * rounds, tTotalWin)
check('raffle: twitter total winners', xWin * rounds, xTotalWin)
check('raffle: ticket total tokens', tTotalWin * perWinner, tTokens)
check('raffle: twitter total tokens', xTotalWin * perWinner, xTokens)

// --- Presale vesting: must reach 100% ----------------------------------------
// The same rule is enforced in the claim program (the ScheduleNotComplete check
// inside initialize) — here we verify that the schedule on the site agrees
// with it.
const presaleVesting = src.match(/key: 'presale',\s*\n\s*label: 'Presale',\s*\n\s*steps: \[([\s\S]*?)\]/)
if (presaleVesting) {
  const amounts = [...presaleVesting[1].matchAll(/amount: ([0-9_]+)/g)].map((m) =>
    Number(m[1].replace(/_/g, '')),
  )
  const stepCounts = [...presaleVesting[1].matchAll(/\((\d+) steps\)/g)].map((m) => Number(m[1]))
  // The first step is TGE (once); the second step repeats N times.
  const repeats = stepCounts[0] ?? 1
  const total = amounts[0] + amounts[1] * repeats
  check('presale vesting total = presale bucket', total, tokensOf('presale'))
}

// --- Marketing breakdown -----------------------------------------------------
const cexTotal = int(/cexReserve:\s*\{\s*\n\s*total:\s*([0-9_]+)/, 'cexReserve.total')
const cexWallets = int(/cexReserve:[\s\S]*?wallets:\s*(\d+)/, 'cexReserve.wallets')
const cexPer = int(/perWallet:\s*([0-9_]+)/, 'cexReserve.perWallet')
const flowTotal = int(/flow:\s*\{\s*\n\s*total:\s*([0-9_]+)/, 'flow.total')
check('marketing: CEX + flowing = marketing bucket', cexTotal + flowTotal, tokensOf('marketing'))
check('marketing: per-vault x count = CEX total', cexPer * cexWallets, cexTotal)

// --- Presale SOL allocation --------------------------------------------------
const solPcts = src.match(/PRESALE_SOL_ALLOCATION[\s\S]*?\]/)[0]
const solTotal = [...solPcts.matchAll(/percent: (\d+)/g)].reduce((a, m) => a + Number(m[1]), 0)
check('presale SOL allocation adds up to 100%', solTotal, 100)

// --- Published wallets -------------------------------------------------------
const addresses = [...src.matchAll(/address: '([1-9A-HJ-NP-Za-km-z]{32,44})'/g)].map((m) => m[1])
const walletConsts = [...src.matchAll(/export const \w*WALLET\w*\s*=\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'/g)].map(
  (m) => m[1],
)
const all = [...addresses, ...walletConsts]
let allValid = true
for (const a of all) {
  try {
    new PublicKey(a)
  } catch {
    allValid = false
    fails.push(`invalid address: ${a}`)
  }
}
check('every published address is valid', allValid, true)
check('published addresses are unique', new Set(all).size, all.length)

// --- Wallets that receive money: a pinned list -------------------------------
// Changing a single letter in an address still produces a valid 32-byte base58
// value; so an "is the address valid" check CANNOT catch a typo. That is why
// every wallet that receives money is pinned here: if one of them changes
// silently in config.ts, the build fails. Changing an address for real means
// deliberately editing two files — it cannot happen by accident.
const PINNED = {
  PRESALE_WALLET: 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36',
  PRESALE_OPS_WALLET: '2Lzc6jorznu7zQKny79topGTE7V837oiV3j53zPH4Qh9',
  FEE_WALLET: '3fBhNn8BEoFyQVAXasWj1xcNrcc2FRpLVQexFhZTnw6F',
  'GAME_CONFIG.programId': '37Hxwu9LYYyEBiB4peAaJVm1mD5gk7CKmeXiobDuv2iu',
  'CLAIM_CONFIG.programId': '8hUZNdjHPR6jtKMwH2U28pHeNZfEgKdJ7x4CDsjuBzwJ',
  'GAME_CONFIG.treasuryWallet': '5Zvz25PheDtC9PaMzwDRcnb3xKS6CU8d98PfEnKkgp9m',
  'PUBLIC_WALLETS.team': 'AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA',
  'PUBLIC_WALLETS.marketing': 'BiWqNZzCPCfJtVPNhoCrvEb9s6unpCFXXf38GR3WnPWX',
  'cexReserve.1': 'CZ639Mx6MFiZfwpVFLecyMTecGp2Cv6HErdoWqgZG6HS',
  'cexReserve.2': '3cCqgaj4QzKQUFvSNnz1yqrqcPt7xiKsbh29AfVoGM8B',
  'cexReserve.3': 'DmdePMQyuKEX9Hwaytx6tEfPxx5utBVxSJ5bgWrKghmh',
}
const foundAddrs = new Set([
  ...all,
  ...[...src.matchAll(/(?:treasuryWallet|programId):\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'/g)].map((m) => m[1]),
])
for (const [label, addr] of Object.entries(PINNED)) {
  check(`pinned wallet in place: ${label}`, foundAddrs.has(addr), true)
}

// --- The raffle prize in SMALLEST UNITS --------------------------------------
// The merkle tree for a raffle round is built with `--amount <smallest unit>`
// and that number is written BY HAND in the docs and examples. If
// perWinnerTokens changes in config.ts and this constant is forgotten, the
// winners are paid the wrong amount — without it even being obvious in which
// direction.
//
// A bug of exactly this class already happened once: whole tokens and smallest
// units were mixed up on the presale path, and the difference was a factor of
// 10^9.
const decimals = int(/export const DEFAULT_DECIMALS\s*=\s*(\d+)/, 'DEFAULT_DECIMALS')
const perWinnerBase = BigInt(perWinner) * BigInt(10) ** BigInt(decimals)
const merkleSrc = readFileSync(new URL('./build-merkle.mjs', import.meta.url), 'utf8')
const documented = [...merkleSrc.matchAll(/\b(1110000000000000)\b/g)].map((m) => m[1])
check(
  'build-merkle examples agree with the per-winner prize',
  documented.every((v) => BigInt(v) === perWinnerBase) && documented.length > 0,
  true,
)

// --- Does the PROSE on the site agree with the numbers -----------------------
// The Tokenomics tab reads its numbers from the config, but the FAQ answer in
// AboutTab WRITES THEM BY HAND. If the config changes and the text is
// forgotten, the same site publishes two different numbers — and a reader
// thinks "these people cannot even get their own numbers to agree".
//
// We do not verify the whole text (the wording may change); only that the
// numbers INSIDE it match the config.
const about = readFileSync(new URL('../src/components/solofluck/AboutTab.tsx', import.meta.url), 'utf8')
const faqAnswer = about.match(/a: 'According to the split on the Tokenomics tab:([\s\S]*?)',\n/)
if (!faqAnswer) {
  fails.push('AboutTab FAQ answer not found (the text may have been rewritten)')
} else {
  const text = faqAnswer[1]
  const textPercents = [
    ...text.matchAll(/(\d+)% to (?:the )?(presale|liquidity|community|locked team|marketing)/g),
  ].map((m) => [m[2], Number(m[1])])
  const configPercents = {
    presale: buckets.presale,
    liquidity: buckets.liquidity,
    community: buckets.community,
    'locked team': buckets.team,
    marketing: buckets.marketing,
  }
  for (const [name, value] of textPercents) {
    check(`FAQ text: ${name} percentage`, value, configPercents[name])
  }
  check('FAQ text: all five buckets appear', textPercents.length, 5)

  // Raffle totals (written with comma separators)
  const numbers = [...text.matchAll(/([\d,]{7,})/g)].map((m) => Number(m[1].replace(/,/g, '')))
  check('FAQ text: ticket raffle total', numbers.includes(tTokens), true)
  check('FAQ text: twitter raffle total', numbers.includes(xTokens), true)

  // Vesting schedule
  const tge = text.match(/(\d+)% at TGE/)
  const weekly = text.match(/(\d+)% weekly for (\d+) weeks/)
  check('FAQ text: TGE unlock percentage', tge ? Number(tge[1]) : null, 9)
  check('FAQ text: number of weekly steps', weekly ? Number(weekly[2]) : null, 13)
  check('FAQ text: weekly unlock percentage', weekly ? Number(weekly[1]) : null, 7)
}

// --- Game economy ------------------------------------------------------------
// The numbers in GAME_CONFIG go straight into `initialize.mjs` and MUST obey
// the rules the on-chain program accepts. If they do not, they blow up in two
// different ways and both are noticed late:
//
//   1. initialize() fails with `InvalidParam` (0x1771) — on TGE day, while
//      trying to open the game. The error message does not say which parameter
//      is wrong.
//   2. Worse: initialize PASSES but at runtime a transfer leaves an account
//      below Solana's rent floor (890,880 lamports for a 0-byte account) and
//      THE WHOLE TRANSACTION is reverted with `InsufficientFundsForRent`. The
//      program is faultless, the player sees a meaningless error. Exactly this
//      happened during the rehearsal (10% of 0.02 SOL fell below the floor).
//
// So we reconstruct the program's `require!` lines here as well.
{
  const g = src.match(/export const GAME_CONFIG\s*=\s*\{([\s\S]*?)\n\}/)
  if (!g) throw new Error('GAME_CONFIG not found in config.ts')
  const block = g[1]
  const read = (re, label) => {
    const m = block.match(re)
    if (!m) throw new Error(`not found in GAME_CONFIG: ${label}`)
    return Number(m[1].replace(/_/g, ''))
  }

  const LAMPORT = 1_000_000_000
  // The floor a 0-byte account needs in order to exist on Solana. The same
  // number as `Rent::get()?.minimum_balance(0)` in the program.
  const RENT_FLOOR = 890_880

  const smallPrize = read(/smallPrizeSol:\s*([\d.]+)/, 'smallPrizeSol')
  const bigPrize = read(/bigPrizeSol:\s*([\d.]+)/, 'bigPrizeSol')
  const bigBps = read(/bigPrizeBps:\s*(\d+)/, 'bigPrizeBps')
  const threshold = read(/vaultEasyThresholdSol:\s*([\d.]+)/, 'vaultEasyThresholdSol')
  const feeBps = read(/treasuryFeeBps:\s*(\d+)/, 'treasuryFeeBps')
  const hardBps = read(/normalWinBps:\s*(\d+)/, 'normalWinBps')
  const easyBps = read(/easyWinBps:\s*(\d+)/, 'easyWinBps')
  const delay = read(/revealDelaySlots:\s*(\d+)/, 'revealDelaySlots')

  const tiers = [...block.matchAll(/\{\s*count:\s*(\d+),\s*priceSol:\s*([\d.]+)\s*\}/g)].map(
    (m) => ({ count: Number(m[1]), priceSol: Number(m[2]) }),
  )
  check('spin package count > 0', tiers.length > 0, true)

  // --- the program's initialize() require!s ---
  check('small prize > 0', smallPrize > 0, true)
  check('big prize >= small prize', bigPrize >= smallPrize, true)
  check('reveal delay > 0', delay > 0, true)
  for (const [name, v] of [
    ['hard mode', hardBps], ['easy mode', easyBps], ['house share', feeBps], ['big prize', bigBps],
  ]) {
    check(`${name} bps <= 10000`, v <= 10000, true)
  }
  check('easy mode is easier than hard mode', easyBps >= hardBps, true)
  // The easy-mode threshold must cover the jackpot AND the house share added on
  // top of it; otherwise a vault that has passed the threshold could pay the
  // prize but not the share when the jackpot lands, and the whole transaction
  // reverts — leaving the player stuck in `pending`.
  const jackpotTotal = bigPrize + (bigPrize * feeBps) / 10000
  check('easy-mode threshold >= jackpot + house share', threshold >= jackpotTotal, true)
  for (const t of tiers) {
    check(`package (${t.count} spins) count > 0`, t.count > 0, true)
    check(`package (${t.count} spins) price > 0`, t.priceSol > 0, true)
  }

  // --- rent floor: EVERY amount going to the treasury must exceed it ---
  // If the treasury wallet does not exist on chain yet (0 lamports), sending it
  // an amount BELOW the rent floor fails THE ENTIRE transaction.
  const cheapest = Math.min(...tiers.map((t) => t.priceSol))
  const cheapestTreasuryShare = Math.floor((cheapest * LAMPORT * feeBps) / 10000)
  check(
    `treasury share of the cheapest package (${cheapest} SOL) is above the rent floor`,
    cheapestTreasuryShare > RENT_FLOOR,
    true,
  )
  const smallestPrizeShare = Math.floor((smallPrize * LAMPORT * feeBps) / 10000)
  check(
    `treasury share of the smallest prize (${smallPrize} SOL) is above the rent floor`,
    smallestPrizeShare > RENT_FLOOR,
    true,
  )
  // The share entering the vault must clear the floor for the same reason: the
  // vault PDA is created on the first purchase.
  const cheapestVaultShare = Math.floor(cheapest * LAMPORT) - cheapestTreasuryShare
  check(
    `vault share of the cheapest package is above the rent floor`,
    cheapestVaultShare > RENT_FLOOR,
    true,
  )

  // --- do config.ts and the Rust constants agree ---
  const rust = readFileSync(
    new URL('../program/luck-game/programs/luck-game/src/lib.rs', import.meta.url),
    'utf8',
  )
  const rustConst = (re, label) => {
    const m = rust.match(re)
    if (!m) throw new Error(`not found in lib.rs: ${label}`)
    return Number(m[1].replace(/_/g, ''))
  }
  check(
    'maxResolveWindowSlots = MAX_RESOLVE_WINDOW_SLOTS',
    read(/maxResolveWindowSlots:\s*(\d+)/, 'maxResolveWindowSlots'),
    rustConst(/const MAX_RESOLVE_WINDOW_SLOTS:\s*u64\s*=\s*([0-9_]+)/, 'MAX_RESOLVE_WINDOW_SLOTS'),
  )
  const spinTiersRust = rustConst(/const SPIN_TIERS:\s*usize\s*=\s*([0-9_]+)/, 'SPIN_TIERS')
  check('spin package count = SPIN_TIERS', tiers.length, spinTiersRust)
  // The delegate's gas share is added ON TOP of the rent floor; if it were zero
  // the delegate account would be created but could never pay a transaction
  // fee, and the player could not play their "free" rounds.
  check(
    'delegate gas share > 0',
    rustConst(/const DELEGATE_GAS_SPONSOR_LAMPORTS:\s*u64\s*=\s*([0-9_]+)/, 'DELEGATE_GAS') > 0,
    true,
  )

  // --- do the initialize.mjs defaults match config.ts ---
  // The game is opened on chain with that script. If its defaults drift from
  // config.ts, the site shows one tariff, the chain applies another, and the
  // player receives a different number of spins than they paid for.
  const initSrc = readFileSync(
    new URL('../program/luck-game/scripts/initialize.mjs', import.meta.url),
    'utf8',
  )
  const array = (re, label) => {
    const m = initSrc.match(re)
    if (!m) throw new Error(`not found in initialize.mjs: ${label}`)
    return m[1].split(',').map((x) => Number(x.trim().replace(/_/g, ''))).filter((x) => !Number.isNaN(x))
  }
  check(
    'initialize.mjs package counts = config.ts',
    array(/SPIN_TIER_COUNTS\s*=\s*\[([^\]]*)\]/, 'SPIN_TIER_COUNTS').join(','),
    tiers.map((t) => t.count).join(','),
  )
  check(
    'initialize.mjs package prices = config.ts',
    array(/SPIN_TIER_PRICES_SOL\s*=\s*\[([^\]]*)\]/, 'SPIN_TIER_PRICES_SOL').join(','),
    tiers.map((t) => t.priceSol).join(','),
  )
}

// --- Result ------------------------------------------------------------------
for (const c of checks) {
  const mark = c.ok ? '✓' : '✗'
  const detail = c.ok ? '' : `  (expected ${c.expected}, got ${c.actual})`
  console.log(`${mark} ${c.name}${detail}`)
}

if (fails.length > 0) {
  console.error(`\n${fails.length} INCONSISTENCIES found — stopping the build.`)
  for (const f of fails) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`\nAll ${checks.length} checks passed.`)
