// The luck-game initialize() caller.
//
// Usage (through env variables):
//   PROGRAM_ID=...        (required)
//   TREASURY_WALLET=...   (required — the wallet the 20% fee share goes to)
//   KEYPAIR_PATH=~/.config/solana/id.json  (default)
//   RPC_URL=https://api.devnet.solana.com  (default)
//   FREE_PLAYS=3
//   SMALL_PRIZE_SOL=0.5  BIG_PRIZE_SOL=1  BIG_PRIZE_BPS=3000  VAULT_THRESHOLD_SOL=2
//   NORMAL_WIN_BPS=50  EASY_WIN_BPS=1000  TREASURY_FEE_BPS=2000
//   REVEAL_DELAY_SLOTS=5
//   SPIN_TIER_COUNTS=1,5,10,20,50,100  SPIN_TIER_PRICES_SOL=0.1,0.3,0.5,0.8,1.5,2.5
//   VAULT_BOOTSTRAP_SOL=0.05
//
// The defaults for these values match GAME_CONFIG in src/config.ts exactly. If
// the program has already been initialized (the config PDA exists), the
// initialize() call is skipped rather than failing — but the vault bootstrap
// step still runs (it is idempotent and safe to run again).

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`
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
const revealDelaySlots = BigInt(envInt('REVEAL_DELAY_SLOTS', 5))

// The spin package tariff: N spins for X SOL. The defaults match the tariff the
// user set exactly: 1/0.1, 5/0.3, 10/0.5, 20/0.8, 50/1.5, 100/2.5 SOL.
const DEFAULT_SPIN_TIER_COUNTS = [1, 5, 10, 20, 50, 100]
const DEFAULT_SPIN_TIER_PRICES_SOL = [0.1, 0.3, 0.5, 0.8, 1.5, 2.5]
const spinTierCounts = (process.env.SPIN_TIER_COUNTS
  ? process.env.SPIN_TIER_COUNTS.split(',').map((s) => Number.parseInt(s.trim(), 10))
  : DEFAULT_SPIN_TIER_COUNTS)
const spinTierPricesLamports = (process.env.SPIN_TIER_PRICES_SOL
  ? process.env.SPIN_TIER_PRICES_SOL.split(',').map((s) => Number.parseFloat(s.trim()))
  : DEFAULT_SPIN_TIER_PRICES_SOL
).map((sol) => BigInt(Math.round(sol * LAMPORTS_PER_SOL)))

if (spinTierCounts.length !== 6 || spinTierPricesLamports.length !== 6) {
  console.error('SPIN_TIER_COUNTS and SPIN_TIER_PRICES_SOL have to contain exactly 6 values')
  process.exit(1)
}

// When a new player calls register_delegate() for the first time, the program
// sponsors the delegate's gas balance OUT OF THE VAULT (see
// DELEGATE_GAS_SPONSOR_LAMPORTS in lib.rs) — so that the free spin really is
// free. But in a freshly installed game the vault holds 0 SOL because nothing
// has been bought yet, so there is nothing to sponsor with. That is why we
// "seed" the vault here with a small initial reserve, out of the program owner's
// wallet. This is a plain SOL transfer (PDAs can accept SOL without a
// signature); it has nothing to do with the program itself.
const vaultBootstrapLamports = BigInt(Math.round(envFloat('VAULT_BOOTSTRAP_SOL', 0.05) * LAMPORTS_PER_SOL))

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
  if (existing) {
    console.log('GameConfig already exists, skipping initialize:', configPda.toBase58())
  } else {
    const data = Buffer.concat([
      anchorDiscriminator('initialize'),
      u8(freePlays),
      u64(smallPrizeLamports),
      u64(bigPrizeLamports),
      u16(bigPrizeBps),
      u64(vaultThresholdLamports),
      u16(normalWinBps),
      u16(easyWinBps),
      u16(treasuryFeeBps),
      u64(revealDelaySlots),
      // [u16; 6] and [u64; 6] — fixed-size arrays, which unlike Vec<T>
      // serialize as raw values one after another, WITHOUT a length prefix.
      ...spinTierCounts.map((n) => u16(n)),
      ...spinTierPricesLamports.map((n) => u64(n)),
    ])

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: TREASURY_WALLET, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    })

    const tx = new Transaction().add(ix)
    const sig = await sendAndConfirmTransaction(connection, tx, [authority])
    console.log('initialize() succeeded, signature:', sig)
    console.log('GameConfig PDA:', configPda.toBase58())
  }

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), configPda.toBuffer()],
    PROGRAM_ID,
  )
  const vaultBalance = BigInt(await connection.getBalance(vaultPda))
  if (vaultBalance < vaultBootstrapLamports) {
    const topUp = vaultBootstrapLamports - vaultBalance
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: vaultPda,
        lamports: topUp,
      }),
    )
    const sig = await sendAndConfirmTransaction(connection, tx, [authority])
    console.log(
      `The vault was seeded with ${Number(topUp) / LAMPORTS_PER_SOL} SOL, signature:`,
      sig,
    )
  } else {
    console.log('The vault already holds a sufficient balance, skipping the seeding:', vaultPda.toBase58())
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
