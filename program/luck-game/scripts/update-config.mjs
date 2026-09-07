// The luck-game update_config() caller.
//
// initialize() runs only ONCE; this instruction is the only way to change the
// game's parameters (the prizes, the odds, the package tariff) and THE TREASURY
// WALLET afterwards. Only `config.authority` (the deploy key) can call it.
//
// CAREFUL: update_config rewrites EVERY field it is given from scratch — there
// is no partial "just change this one thing" update. Earlier versions of this
// script defaulted every unset field to a HARDCODED constant (matching
// GAME_CONFIG in src/config.ts at the time it was written) — so running it to
// change just one field (say, only TREASURY_WALLET) would silently REVERT
// every other field an earlier update_config call had already changed, the
// moment this script's constants drifted out of step with the live chain.
//
// Instead, every field this script does not receive through env now defaults
// to WHATEVER IS CURRENTLY ON CHAIN (read from GameConfig before building the
// instruction) — so "change just the treasury" really does leave everything
// else exactly as it is, regardless of what has happened on chain since.
//
// Usage (through env variables):
//   PROGRAM_ID=...        (required)
//   TREASURY_WALLET=...   (default: unchanged)
//   KEYPAIR_PATH=~/.config/solana/id.json  (default)
//   RPC_URL=https://api.devnet.solana.com  (default)
//   FREE_PLAYS, SMALL_PRIZE_SOL, BIG_PRIZE_SOL, BIG_PRIZE_BPS, VAULT_THRESHOLD_SOL,
//   NORMAL_WIN_BPS, EASY_WIN_BPS, TREASURY_FEE_BPS   (default: unchanged)
//   SPIN_TIER_COUNTS=1,5,10,20,50,100        (default: unchanged)
//   SPIN_TIER_PRICES_SOL=0.1,0.3,0.5,0.8,1.5,2.5  (default: unchanged)
//
// Note: `reveal_delay_slots` is NOT in update_config — the commit/reveal window
// stays at the value it had at initialize (deliberate, so that the rules of
// pending games are not changed).

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'

const SPIN_TIERS = 6
const LAMPORTS_PER_SOL = 1_000_000_000

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing environment variable: ${name}`)
    process.exit(1)
  }
  return v
}

function envFloatSol(name, fallbackLamports) {
  const v = process.env[name]
  return v !== undefined ? BigInt(Math.round(Number.parseFloat(v) * LAMPORTS_PER_SOL)) : fallbackLamports
}

function envInt(name, fallback) {
  const v = process.env[name]
  return v !== undefined ? Number.parseInt(v, 10) : fallback
}

const PROGRAM_ID = new PublicKey(requireEnv('PROGRAM_ID'))
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'

function anchorDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
}

function u8(n) {
  const b = Buffer.alloc(1)
  b.writeUInt8(n)
  return b
}
function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
function u64(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}

// The exact GameConfig account layout (program/luck-game/src/lib.rs) — Borsh
// serializes struct fields in declaration order with no padding, so these
// offsets are a direct read of what update_config() itself would produce.
// `reveal_delay_slots` is included here (it is part of the account) but never
// read out for use as a default — update_config's instruction data has no
// field for it at all, so it always stays whatever initialize() set.
function parseGameConfig(data) {
  let o = 8 // discriminator
  const authority = new PublicKey(data.subarray(o, o + 32)); o += 32
  const treasury = new PublicKey(data.subarray(o, o + 32)); o += 32
  const freePlays = data.readUInt8(o); o += 1
  const smallPrizeLamports = data.readBigUInt64LE(o); o += 8
  const bigPrizeLamports = data.readBigUInt64LE(o); o += 8
  const bigPrizeBps = data.readUInt16LE(o); o += 2
  const vaultThresholdLamports = data.readBigUInt64LE(o); o += 8
  const normalWinBps = data.readUInt16LE(o); o += 2
  const easyWinBps = data.readUInt16LE(o); o += 2
  const treasuryFeeBps = data.readUInt16LE(o); o += 2
  o += 8 // reveal_delay_slots — not settable through update_config, skipped
  const spinTierCounts = []
  for (let i = 0; i < SPIN_TIERS; i++) { spinTierCounts.push(data.readUInt16LE(o)); o += 2 }
  const spinTierPricesLamports = []
  for (let i = 0; i < SPIN_TIERS; i++) { spinTierPricesLamports.push(data.readBigUInt64LE(o)); o += 8 }
  return {
    authority, treasury, freePlays, smallPrizeLamports, bigPrizeLamports, bigPrizeBps,
    vaultThresholdLamports, normalWinBps, easyWinBps, treasuryFeeBps,
    spinTierCounts, spinTierPricesLamports,
  }
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')
  const secret = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))
  const authority = Keypair.fromSecretKey(Uint8Array.from(secret))

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)
  const existingAccount = await connection.getAccountInfo(configPda)
  if (!existingAccount) {
    console.error(
      `GameConfig was not found (${configPda.toBase58()}) — initialize.mjs has to be run first.`,
    )
    process.exit(1)
  }
  const current = parseGameConfig(existingAccount.data)

  const treasuryWallet = process.env.TREASURY_WALLET
    ? new PublicKey(process.env.TREASURY_WALLET)
    : current.treasury
  const freePlays = envInt('FREE_PLAYS', current.freePlays)
  const smallPrizeLamports = envFloatSol('SMALL_PRIZE_SOL', current.smallPrizeLamports)
  const bigPrizeLamports = envFloatSol('BIG_PRIZE_SOL', current.bigPrizeLamports)
  const bigPrizeBps = envInt('BIG_PRIZE_BPS', current.bigPrizeBps)
  const vaultThresholdLamports = envFloatSol('VAULT_THRESHOLD_SOL', current.vaultThresholdLamports)
  const normalWinBps = envInt('NORMAL_WIN_BPS', current.normalWinBps)
  const easyWinBps = envInt('EASY_WIN_BPS', current.easyWinBps)
  const treasuryFeeBps = envInt('TREASURY_FEE_BPS', current.treasuryFeeBps)

  const spinTierCounts = process.env.SPIN_TIER_COUNTS
    ? process.env.SPIN_TIER_COUNTS.split(',').map((s) => Number.parseInt(s.trim(), 10))
    : current.spinTierCounts
  const spinTierPricesLamports = process.env.SPIN_TIER_PRICES_SOL
    ? process.env.SPIN_TIER_PRICES_SOL.split(',').map((s) => BigInt(Math.round(Number.parseFloat(s.trim()) * LAMPORTS_PER_SOL)))
    : current.spinTierPricesLamports

  if (spinTierCounts.length !== SPIN_TIERS || spinTierPricesLamports.length !== SPIN_TIERS) {
    console.error(`SPIN_TIER_COUNTS and SPIN_TIER_PRICES_SOL have to contain exactly ${SPIN_TIERS} values`)
    process.exit(1)
  }

  // The same rule the program itself enforces: the vault threshold has to cover
  // the jackpot plus the operations fee added on top of it. We verify it here too,
  // without sending a pointless transaction to the chain, so the error comes out
  // with a clear message here rather than as an opaque "InvalidParam".
  const jackpotWithFee =
    bigPrizeLamports + (bigPrizeLamports * BigInt(treasuryFeeBps)) / BigInt(10_000)
  if (vaultThresholdLamports < jackpotWithFee) {
    console.error(
      `VAULT_THRESHOLD_SOL is too low: the jackpot + the ${treasuryFeeBps / 100}% share = ` +
        `${Number(jackpotWithFee) / LAMPORTS_PER_SOL} SOL, while the threshold is ` +
        `${Number(vaultThresholdLamports) / LAMPORTS_PER_SOL} SOL.`,
    )
    process.exit(1)
  }

  // Print every field that is ACTUALLY CHANGING — silence on the rest confirms
  // this run is leaving everything else exactly where it was.
  const changes = []
  const fmtSol = (l) => `${Number(l) / LAMPORTS_PER_SOL} SOL`
  if (!treasuryWallet.equals(current.treasury)) changes.push(`treasury: ${current.treasury.toBase58()} -> ${treasuryWallet.toBase58()}`)
  if (freePlays !== current.freePlays) changes.push(`free_plays: ${current.freePlays} -> ${freePlays}`)
  if (smallPrizeLamports !== current.smallPrizeLamports) changes.push(`small_prize: ${fmtSol(current.smallPrizeLamports)} -> ${fmtSol(smallPrizeLamports)}`)
  if (bigPrizeLamports !== current.bigPrizeLamports) changes.push(`big_prize: ${fmtSol(current.bigPrizeLamports)} -> ${fmtSol(bigPrizeLamports)}`)
  if (bigPrizeBps !== current.bigPrizeBps) changes.push(`big_prize_bps: ${current.bigPrizeBps} -> ${bigPrizeBps}`)
  if (vaultThresholdLamports !== current.vaultThresholdLamports) changes.push(`vault_threshold: ${fmtSol(current.vaultThresholdLamports)} -> ${fmtSol(vaultThresholdLamports)}`)
  if (normalWinBps !== current.normalWinBps) changes.push(`normal_win_bps: ${current.normalWinBps} -> ${normalWinBps}`)
  if (easyWinBps !== current.easyWinBps) changes.push(`easy_win_bps: ${current.easyWinBps} -> ${easyWinBps}`)
  if (treasuryFeeBps !== current.treasuryFeeBps) changes.push(`treasury_fee_bps: ${current.treasuryFeeBps} -> ${treasuryFeeBps}`)
  if (JSON.stringify(spinTierCounts) !== JSON.stringify(current.spinTierCounts)) changes.push(`spin_tier_counts: ${current.spinTierCounts} -> ${spinTierCounts}`)
  if (JSON.stringify(spinTierPricesLamports) !== JSON.stringify(current.spinTierPricesLamports)) changes.push(`spin_tier_prices: changed`)

  if (changes.length === 0) {
    console.log('No field differs from the current on-chain config — nothing to send.')
    return
  }
  console.log('Changing:')
  for (const c of changes) console.log(`  ${c}`)

  const data = Buffer.concat([
    anchorDiscriminator('update_config'),
    treasuryWallet.toBuffer(),
    u8(freePlays),
    u64(smallPrizeLamports),
    u64(bigPrizeLamports),
    u16(bigPrizeBps),
    u64(vaultThresholdLamports),
    u16(normalWinBps),
    u16(easyWinBps),
    u16(treasuryFeeBps),
    ...spinTierCounts.map((n) => u16(n)),
    ...spinTierPricesLamports.map((n) => u64(n)),
  ])

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data,
  })

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority])
  console.log('update_config() succeeded, signature:', sig)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
