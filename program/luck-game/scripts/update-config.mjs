// The luck-game update_config() caller.
//
// initialize() runs only ONCE; this instruction is the only way to change the
// game's parameters (the prizes, the odds, the package tariff) and THE TREASURY
// WALLET afterwards. Only `config.authority` (the deploy key) can call it.
//
// CAREFUL: update_config rewrites EVERY field it is given from scratch — there
// is no partial "just change this one thing" update. So the defaults below have
// to be kept exactly in step with GAME_CONFIG in src/config.ts; pass only the
// value you want to change through env, and the rest is rewritten as it was.
//
// Usage (through env variables):
//   PROGRAM_ID=...        (required)
//   TREASURY_WALLET=...   (required — the wallet the 20% share and the prize share go to)
//   KEYPAIR_PATH=~/.config/solana/id.json  (default)
//   RPC_URL=https://api.devnet.solana.com  (default)
//   FREE_PLAYS=3
//   SMALL_PRIZE_SOL=0.5  BIG_PRIZE_SOL=1  BIG_PRIZE_BPS=3000  VAULT_THRESHOLD_SOL=2
//   NORMAL_WIN_BPS=50  EASY_WIN_BPS=1000  TREASURY_FEE_BPS=2000
//   SPIN_TIER_COUNTS=1,5,10,20,50,100  SPIN_TIER_PRICES_SOL=0.1,0.3,0.5,0.8,1.5,2.5
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

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing environment variable: ${name}`)
    process.exit(1)
  }
  return v
}

function envFloat(name, fallback) {
  const v = process.env[name]
  return v ? Number.parseFloat(v) : fallback
}

function envInt(name, fallback) {
  const v = process.env[name]
  return v ? Number.parseInt(v, 10) : fallback
}

const PROGRAM_ID = new PublicKey(requireEnv('PROGRAM_ID'))
const TREASURY_WALLET = new PublicKey(requireEnv('TREASURY_WALLET'))
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'

const LAMPORTS_PER_SOL = 1_000_000_000
// On-chain free spins: 0.
//
// The free spins (3 + 1 bonus) are granted ENTIRELY in the browser, in
// localStorage (see src/lib/luckGame.ts) — because they are never written to the
// chain they incur neither a transaction fee nor account rent. The program also
// used to load `free_plays` credits on the first play() call; with both in
// effect, a player who bought 1 spin for 0.1 SOL could spin 8 times in total.
// Pulling the on-chain side to 0 closes that (at 0 the one-off +1 bonus
// condition inside the program never fires either).
const freePlays = envInt('FREE_PLAYS', 0)
const smallPrizeLamports = BigInt(Math.round(envFloat('SMALL_PRIZE_SOL', 0.5) * LAMPORTS_PER_SOL))
const bigPrizeLamports = BigInt(Math.round(envFloat('BIG_PRIZE_SOL', 1) * LAMPORTS_PER_SOL))
const bigPrizeBps = envInt('BIG_PRIZE_BPS', 3000)
const vaultThresholdLamports = BigInt(
  Math.round(envFloat('VAULT_THRESHOLD_SOL', 2) * LAMPORTS_PER_SOL),
)
const normalWinBps = envInt('NORMAL_WIN_BPS', 50)
const easyWinBps = envInt('EASY_WIN_BPS', 1000)
const treasuryFeeBps = envInt('TREASURY_FEE_BPS', 2000)

const DEFAULT_SPIN_TIER_COUNTS = [1, 5, 10, 20, 50, 100]
const DEFAULT_SPIN_TIER_PRICES_SOL = [0.1, 0.3, 0.5, 0.8, 1.5, 2.5]
const spinTierCounts = process.env.SPIN_TIER_COUNTS
  ? process.env.SPIN_TIER_COUNTS.split(',').map((s) => Number.parseInt(s.trim(), 10))
  : DEFAULT_SPIN_TIER_COUNTS
const spinTierPricesLamports = (process.env.SPIN_TIER_PRICES_SOL
  ? process.env.SPIN_TIER_PRICES_SOL.split(',').map((s) => Number.parseFloat(s.trim()))
  : DEFAULT_SPIN_TIER_PRICES_SOL
).map((sol) => BigInt(Math.round(sol * LAMPORTS_PER_SOL)))

if (spinTierCounts.length !== 6 || spinTierPricesLamports.length !== 6) {
  console.error('SPIN_TIER_COUNTS and SPIN_TIER_PRICES_SOL have to contain exactly 6 values')
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

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')
  const secret = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))
  const authority = Keypair.fromSecretKey(Uint8Array.from(secret))

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)
  const existing = await connection.getAccountInfo(configPda)
  if (!existing) {
    console.error(
      `GameConfig was not found (${configPda.toBase58()}) — initialize.mjs has to be run first.`,
    )
    process.exit(1)
  }

  // Print the current treasury address so the change is on the record: the
  // GameConfig layout is 8 (disc) + 32 (authority) + 32 (treasury) ...
  const currentTreasury = new PublicKey(existing.data.subarray(40, 72))
  console.log('Current treasury:', currentTreasury.toBase58())
  console.log('New treasury    :', TREASURY_WALLET.toBase58())

  const data = Buffer.concat([
    anchorDiscriminator('update_config'),
    TREASURY_WALLET.toBuffer(),
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
