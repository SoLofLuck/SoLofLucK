// ---------------------------------------------------------------------------
// luck-distributor: opens a distribution round and locks the tokens
// ---------------------------------------------------------------------------
// This is the script that runs on TGE day. What it does, in order:
//   1. Creates the distributor account and its vault — the merkle root, the
//      total amount and the vesting schedule are FIXED here.
//   2. Moves the tokens into the vault.
//   3. Verifies that the vault balance is EXACTLY equal to the total in the
//      merkle list.
//
// Step 3 is critical: the program contains no "withdraw the money" instruction
// (deliberately). If too few tokens are put in the vault, the last buyers cannot
// claim; if too many, the excess stays locked forever. Neither can be undone, so
// the script stops the moment it sees a shortfall or an excess.
//
// Usage (env):
//   PROGRAM_ID=...            (required) the luck-distributor program address
//   MINT=...                  (required) the $LUCK mint address
//   ROUND_ID=0                (required) 0 = presale, 1..14 = weekly raffles
//   MERKLE_FILE=public/merkle/round-0.json   (required)
//   START_ISO=2026-09-01T12:00:00Z           (required) TGE / round start
//   CLIFF_BPS=900 PERIOD_BPS=700 PERIODS=13 PERIOD_SECONDS=604800
//   SOURCE_TOKEN_ACCOUNT=...  (default: the signer's ATA)
//   KEYPAIR_PATH=~/.config/solana/id.json
//   RPC_URL=https://api.devnet.solana.com
//   DRY_RUN=1                 prints what it would do without sending anything
//
// For raffle rounds the schedule is a single item: CLIFF_BPS=10000, PERIODS=0.

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

function requireEnv(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing environment variable: ${name}`)
    process.exit(1)
  }
  return v
}
const envInt = (name, fallback) =>
  process.env[name] ? Number.parseInt(process.env[name], 10) : fallback

const PROGRAM_ID = new PublicKey(requireEnv('PROGRAM_ID'))
const MINT = new PublicKey(requireEnv('MINT'))
const ROUND_ID = BigInt(requireEnv('ROUND_ID'))
const MERKLE_FILE = requireEnv('MERKLE_FILE')
const START_TS = BigInt(Math.floor(new Date(requireEnv('START_ISO')).getTime() / 1000))
const CLIFF_BPS = envInt('CLIFF_BPS', 900)
const PERIOD_BPS = envInt('PERIOD_BPS', 700)
const PERIODS = envInt('PERIODS', 13)
const PERIOD_SECONDS = BigInt(envInt('PERIOD_SECONDS', 7 * 24 * 60 * 60))
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const DRY_RUN = process.env.DRY_RUN === '1'

if (!Number.isFinite(Number(START_TS)) || START_TS <= 0n) {
  console.error('START_ISO is not a valid date.')
  process.exit(1)
}

// A typo'd year or a timezone slip in START_ISO would land this round's
// vesting clock in the past — and since there is no instruction to change
// the schedule after initialize() (see the file header), that mistake is
// PERMANENT: claimants could immediately withdraw far more than the cliff
// intends. A generous one-hour grace window covers the real gap between
// picking the timestamp and actually running this script; anything further
// in the past is almost certainly a mistake, not intent.
// Skipped under PRINT_IX: that mode only serialises the instruction bytes for
// the ABI golden-vector check (check-abi.mjs) against a fixed example date —
// it never touches a keypair or the chain, so there is nothing to protect.
const ONE_HOUR_S = 3600n
const nowTs = BigInt(Math.floor(Date.now() / 1000))
if (process.env.PRINT_IX !== '1' && START_TS < nowTs - ONE_HOUR_S) {
  console.error(
    `START_ISO (${new Date(Number(START_TS) * 1000).toISOString()}) is more than an hour in the past ` +
      `(now: ${new Date(Number(nowTs) * 1000).toISOString()}). This schedule can never be changed after ` +
      'initialize() — check for a typo (wrong year, timezone) before running this again.',
  )
  process.exit(1)
}

// Schedule check — the program enforces the same thing (ScheduleNotComplete),
// but we want to see the error BEFORE sending money to the chain.
const totalBps = CLIFF_BPS + PERIODS * PERIOD_BPS
if (totalBps !== 10_000) {
  console.error(
    `The schedule does not reach 100%: ${CLIFF_BPS} + ${PERIODS} x ${PERIOD_BPS} = ${totalBps} bps.\n` +
      'The program would reject this anyway; stopping here avoids paying a transaction fee for nothing.',
  )
  process.exit(1)
}

// --- The merkle file --------------------------------------------------------
const merkle = JSON.parse(readFileSync(MERKLE_FILE, 'utf8'))
if (!merkle.root || !Array.isArray(merkle.claims)) {
  console.error(`${MERKLE_FILE} is not in the expected format (root + claims).`)
  process.exit(1)
}
const totalFromClaims = merkle.claims.reduce((a, c) => a + BigInt(c.amount), 0n)
if (merkle.total !== undefined && BigInt(merkle.total) !== totalFromClaims) {
  console.error(
    `The total in the merkle file (${merkle.total}) does not match the sum of the ` +
      `individual allocations (${totalFromClaims}).`,
  )
  process.exit(1)
}
const TOTAL_ALLOCATED = totalFromClaims
const MERKLE_ROOT = Buffer.from(merkle.root, 'hex')
if (MERKLE_ROOT.length !== 32) {
  console.error('The merkle root is not 32 bytes.')
  process.exit(1)
}

// --- The PDAs ---------------------------------------------------------------
function u64le(v) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(v))
  return b
}
const [distributor] = PublicKey.findProgramAddressSync(
  [Buffer.from('distributor'), MINT.toBuffer(), u64le(ROUND_ID)],
  PROGRAM_ID,
)
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from('vault'), distributor.toBuffer()],
  PROGRAM_ID,
)

function ata(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0]
}

// --- The Anchor instruction discriminator ----------------------------------
const discriminator = (name) =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)

function buildInitializeIx(authority) {
  const data = Buffer.alloc(8 + 8 + 32 + 8 + 8 + 2 + 2 + 8 + 2)
  let o = 0
  discriminator('initialize').copy(data, o); o += 8
  data.writeBigUInt64LE(ROUND_ID, o); o += 8
  MERKLE_ROOT.copy(data, o); o += 32
  data.writeBigUInt64LE(TOTAL_ALLOCATED, o); o += 8
  data.writeBigInt64LE(START_TS, o); o += 8
  data.writeUInt16LE(CLIFF_BPS, o); o += 2
  data.writeUInt16LE(PERIOD_BPS, o); o += 2
  data.writeBigInt64LE(PERIOD_SECONDS, o); o += 8
  data.writeUInt16LE(PERIODS, o)

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: distributor, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  })
}

/** SPL Token `Transfer` (instruction 3): a u8 tag + a u64 amount. */
function buildTransferIx(source, destination, owner, amount) {
  const data = Buffer.alloc(9)
  data.writeUInt8(3, 0)
  data.writeBigUInt64LE(amount, 1)
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  })
}

async function tokenBalance(connection, account) {
  const info = await connection.getAccountInfo(account)
  if (!info) return null
  // In an SPL token account the amount starts at byte 64, as a little-endian u64.
  return Buffer.from(info.data).readBigUInt64LE(64)
}

// --- Run --------------------------------------------------------------------
// DRY_RUN has to work WITHOUT A KEY: the whole point of that mode is to answer,
// before TGE and without touching the chain, "which numbers, which schedule and
// which root are we going to lock with". If it required a signing key, that
// check could only be done on the deploy machine.
// A key is required ONLY when a transaction is actually sent. DRY_RUN and
// PRINT_IX have to be runnable from anywhere before TGE.
const keyRequired = !DRY_RUN && process.env.PRINT_IX !== '1'
let payer = null
if (keyRequired || existsSync(KEYPAIR_PATH)) {
  const secret = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))
  payer = Keypair.fromSecretKey(Uint8Array.from(secret))
}
const source = process.env.SOURCE_TOKEN_ACCOUNT
  ? new PublicKey(process.env.SOURCE_TOKEN_ACCOUNT)
  : payer
    ? ata(payer.publicKey, MINT)
    : null

const quiet = process.env.PRINT_IX === '1'
const say = (...a) => { if (!quiet) console.log(...a) }
say('=========================================================')
say(` Round            : ${ROUND_ID}`)
say(` Program          : ${PROGRAM_ID.toBase58()}`)
say(` Mint             : ${MINT.toBase58()}`)
say(` Distributor      : ${distributor.toBase58()}`)
say(` Vault            : ${vault.toBase58()}`)
say(` Source account   : ${source ? source.toBase58() : "(the signer's ATA — no key was given)"}`)
say(` Buyers           : ${merkle.claims.length}`)
say(` Total amount     : ${TOTAL_ALLOCATED}`)
say(` Merkle root      : ${merkle.root}`)
say(` Start            : ${new Date(Number(START_TS) * 1000).toISOString()}`)
say(` Schedule         : TGE ${CLIFF_BPS / 100}% + ${PERIODS} x ${PERIOD_BPS / 100}%`)
say(` Interval         : ${PERIOD_SECONDS} s`)
say('=========================================================')

// PRINT_IX exports the initialize instruction THIS SCRIPT PRODUCES, byte for
// byte. scripts/check-abi.mjs compares it against the golden vector the program
// itself produces.
//
// The reason we read the instruction FROM HERE rather than rewriting it in the
// check script: this is exactly the code that will run on TGE day — including
// the env reading, the schedule arithmetic and the account order. Testing a copy
// would only prove that the copy agrees with itself.
if (process.env.PRINT_IX === '1') {
  const authority = new PublicKey(
    process.env.AUTHORITY || 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36',
  )
  const ix = buildInitializeIx(authority)
  console.log(
    JSON.stringify({
      data: Buffer.from(ix.data).toString('hex'),
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      distributor: distributor.toBase58(),
      vault: vault.toBase58(),
    }),
  )
  process.exit(0)
}

if (DRY_RUN) {
  console.log('DRY_RUN=1 — no transaction was sent.')
  process.exit(0)
}

const connection = new Connection(RPC_URL, 'confirmed')

const existing = await connection.getAccountInfo(distributor)
if (existing) {
  console.log('The distributor already exists — skipping initialize.')
} else {
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(buildInitializeIx(payer.publicKey)),
    [payer],
    { commitment: 'confirmed' },
  )
  console.log(`initialize sent: ${sig}`)
}

const vaultBalance = (await tokenBalance(connection, vault)) ?? 0n
const shortfall = TOTAL_ALLOCATED - vaultBalance
if (shortfall > 0n) {
  console.log(`Moving ${shortfall} tokens into the vault...`)
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(buildTransferIx(source, vault, payer.publicKey, shortfall)),
    [payer],
    { commitment: 'confirmed' },
  )
  console.log(`transfer sent: ${sig}`)
} else if (shortfall < 0n) {
  console.error(
    `The vault holds TOO MANY tokens (${vaultBalance} > ${TOTAL_ALLOCATED}). The ` +
      'excess stays locked forever — the program has no withdraw instruction.',
  )
  process.exit(1)
}

// The final check: the vault balance has to be EXACTLY the total in the list.
const finalBalance = (await tokenBalance(connection, vault)) ?? 0n
if (finalBalance !== TOTAL_ALLOCATED) {
  console.error(`VERIFICATION FAILED: the vault holds ${finalBalance}, it should hold ${TOTAL_ALLOCATED}.`)
  process.exit(1)
}
console.log(`\nDone. Exactly ${finalBalance} tokens are locked in the vault.`)
console.log(`Distributor: ${distributor.toBase58()}`)
