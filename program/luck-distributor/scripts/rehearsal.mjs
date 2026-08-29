// ---------------------------------------------------------------------------
// Devnet end-to-end rehearsal
// ---------------------------------------------------------------------------
// The tests run without ever connecting to a chain (solana-program-test) and
// cover 16 scenarios. But those tests are not what runs on TGE day: a real mint,
// a real RPC, real ATAs and the initialize-round.mjs script itself are. The gap
// between the two can only be closed by running on a real chain.
//
// This script rehearses TGE day exactly:
//   1. Creates a throwaway mint and mints the supply
//   2. Produces a merkle list from three fake buyers
//   3. REALLY runs initialize-round.mjs (opens the round, locks the tokens)
//   4. Claims as one of the buyers
//   5. Verifies that the amount claimed is EXACTLY what the schedule predicts
//   6. Verifies that a second claim attempt pays nothing
//
// Usage (env):
//   PROGRAM_ID=...   the luck-distributor address
//   KEYPAIR_PATH=... the deploy/payer wallet
//   RPC_URL=https://api.devnet.solana.com
//   ROUND_ID=900     a rehearsal-only number that does not collide with real rounds

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const MINT_LEN = 82
const DECIMALS = 9

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? (() => { throw new Error('PROGRAM_ID is required') })())
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const ROUND_ID = BigInt(process.env.ROUND_ID || '900')

const connection = new Connection(RPC_URL, 'confirmed')
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))),
)

const step = (n, t) => console.log(`\n[${n}] ${t}`)
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const disc = (n) => createHash('sha256').update(`global:${n}`).digest().subarray(0, 8)
const ata = (owner, mint) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0]

async function tokenBalance(account) {
  const info = await connection.getAccountInfo(account)
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : null
}


// --- Sweep the leftover SOL back --------------------------------------------
// The rehearsal sends SOL to single-use wallets. Without a sweep that SOL STAYS
// THERE and the keys are lost when the process ends — so every run empties the
// deploy wallet a little further. Which it did: the next program upgrade failed
// because it could not find the 0.11 SOL for the buffer rent, and the devnet
// faucet would not provide it because of the rate limit.
//
// We empty the account completely (balance minus the transaction fee). An
// account that drops below the rent-exempt floor is deleted anyway and its
// lamports are returned.
async function sweep(sources, target) {
  let total = 0n
  for (const kp of sources) {
    try {
      const balance = await connection.getBalance(kp.publicKey)
      const fee = 5_000
      if (balance <= fee) continue
      const amount = balance - fee
      // RETRY. The first version made a single attempt, failed on devnet with
      // "Blockhash not found" and recovered ZERO SOL — since the sweep's only
      // job is to not empty the wallet, failing silently makes it entirely
      // pointless. The error is transient (blockhash propagation delay), so
      // retrying fixes it.
      let sent = false
      let lastError = null
      for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        try {
          await sendAndConfirmTransaction(
            connection,
            new Transaction().add(SystemProgram.transfer({
              fromPubkey: kp.publicKey, toPubkey: target, lamports: amount,
            })),
            [kp],
            { commitment: 'confirmed' },
          )
          sent = true
        } catch (err) {
          lastError = err
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        }
      }
      if (!sent) throw lastError
      total += BigInt(amount)
    } catch (err) {
      console.log(`    could not sweep ${kp.publicKey.toBase58().slice(0, 8)}…: ${err.message}`)
    }
  }
  console.log(`    recovered: ${Number(total) / 1_000_000_000} SOL`)
}

// --- 1) Mint --------------------------------------------------------------
step(1, 'Creating a throwaway mint')
const mintKp = Keypair.generate()
const rent = await connection.getMinimumBalanceForRentExemption(MINT_LEN)
{
  const initMint = Buffer.alloc(67)
  initMint.writeUInt8(0, 0) // InitializeMint
  initMint.writeUInt8(DECIMALS, 1)
  payer.publicKey.toBuffer().copy(initMint, 2)
  initMint.writeUInt8(0, 34) // no freeze authority
  const tx = new Transaction()
    .add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKp.publicKey,
      lamports: rent,
      space: MINT_LEN,
      programId: TOKEN_PROGRAM_ID,
    }))
    .add(new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: mintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: initMint.subarray(0, 35),
    }))
  await sendAndConfirmTransaction(connection, tx, [payer, mintKp], { commitment: 'confirmed' })
}
const MINT = mintKp.publicKey
console.log(`    mint: ${MINT.toBase58()}`)

// --- 2) Buyers and the merkle list -----------------------------------------
step(2, 'Producing a fake buyer list and the merkle tree')
const buyers = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
const ALLOCATION = 1_110_000_000_000_000n // 1,110,000 tokens, 9 decimals
const tmp = mkdtempSync(join(tmpdir(), 'rehearsal-'))
const listFile = join(tmp, 'buyers.txt')
writeFileSync(listFile, buyers.map((k) => k.publicKey.toBase58()).join('\n'))

const merkleFile = join(tmp, 'round.json')
writeFileSync(
  merkleFile,
  execFileSync(process.execPath, [
    'scripts/build-merkle.mjs', '--amount', ALLOCATION.toString(), listFile,
  ], { encoding: 'utf8' }),
)
const merkle = JSON.parse(readFileSync(merkleFile, 'utf8'))
const TOTAL = BigInt(merkle.total)
console.log(`    ${merkle.count} buyers · total ${TOTAL} · root ${merkle.root.slice(0, 16)}...`)

// --- 3) Mint the supply -----------------------------------------------------
step(3, 'Minting the supply (into the source account)')
const source = ata(payer.publicKey, MINT)
{
  const createAta = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  })
  const mintTo = Buffer.alloc(9)
  mintTo.writeUInt8(7, 0) // MintTo
  mintTo.writeBigUInt64LE(TOTAL, 1)
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(createAta).add(new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: MINT, isSigner: false, isWritable: true },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: mintTo,
    })),
    [payer],
    { commitment: 'confirmed' },
  )
}
console.log(`    in the source account: ${await tokenBalance(source)}`)

// --- 4) Open the round — THE VERY script that runs on TGE day --------------
step(4, 'Running initialize-round.mjs (a real lock)')
// We put the start IN THE PAST so the TGE slice is already unlocked and we can
// exercise the claim in the same run. The schedule is byte-for-byte the real
// presale schedule: 9% + 13 x 7%.
const START = new Date(Date.now() - 60_000)
console.log(
  execFileSync(process.execPath, ['program/luck-distributor/scripts/initialize-round.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROGRAM_ID: PROGRAM_ID.toBase58(),
      MINT: MINT.toBase58(),
      ROUND_ID: ROUND_ID.toString(),
      MERKLE_FILE: merkleFile,
      START_ISO: START.toISOString(),
      CLIFF_BPS: '900', PERIOD_BPS: '700', PERIODS: '13',
      SOURCE_TOKEN_ACCOUNT: source.toBase58(),
      KEYPAIR_PATH,
      RPC_URL,
      DRY_RUN: '0',
    },
  }),
)

const [distributor] = PublicKey.findProgramAddressSync(
  [Buffer.from('distributor'), MINT.toBuffer(), u64le(ROUND_ID)], PROGRAM_ID)
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from('vault'), distributor.toBuffer()], PROGRAM_ID)

// --- 5) Claim ---------------------------------------------------------------
step(5, 'The buyer claims their allocation')
const buyer = buyers[0]
const entry = merkle.claims.find((c) => c.address === buyer.publicKey.toBase58())
if (!entry) throw new Error('the buyer was not found in the merkle list')

// The buyer needs a little SOL for the transaction fee.
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: buyer.publicKey, lamports: 20_000_000,
  })),
  [payer],
  { commitment: 'confirmed' },
)

const destination = ata(buyer.publicKey, MINT)
const [claimStatus] = PublicKey.findProgramAddressSync(
  [Buffer.from('claim'), distributor.toBuffer(), buyer.publicKey.toBuffer()], PROGRAM_ID)

function claimIx() {
  const proof = entry.proof.map((h) => Buffer.from(h, 'hex'))
  const data = Buffer.alloc(8 + 8 + 4 + proof.length * 32)
  let o = 0
  disc('claim').copy(data, o); o += 8
  data.writeBigUInt64LE(BigInt(entry.amount), o); o += 8
  data.writeUInt32LE(proof.length, o); o += 4
  for (const n of proof) { n.copy(data, o); o += 32 }
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
      { pubkey: distributor, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: claimStatus, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

await sendAndConfirmTransaction(connection, new Transaction().add(claimIx()), [buyer], {
  commitment: 'confirmed',
})

// --- 6) Verification --------------------------------------------------------
step(6, 'Verifying the result')
const claimed = (await tokenBalance(destination)) ?? 0n
const expected = (ALLOCATION * 900n) / 10_000n // the TGE slice: 9%
console.log(`    claimed : ${claimed}`)
console.log(`    expected: ${expected} (9% of the allocation)`)
if (claimed !== expected) {
  console.error('VERIFICATION FAILED: the amount claimed does not equal what the schedule predicts.')
  process.exit(1)
}

const vaultRemaining = await tokenBalance(vault)
if (vaultRemaining !== TOTAL - expected) {
  console.error(`VERIFICATION FAILED: the vault holds ${vaultRemaining}, it should hold ${TOTAL - expected}.`)
  process.exit(1)
}

// A second claim must NOT pay the same slice again.
step(7, 'A second claim attempt (the same slice must not be paid twice)')
try {
  await sendAndConfirmTransaction(connection, new Transaction().add(claimIx()), [buyer], {
    commitment: 'confirmed',
  })
} catch {
  // The program may reject it with "there is nothing to claim" — that is fine too.
  console.log('    the second attempt was rejected (expected)')
}
const after = (await tokenBalance(destination)) ?? 0n
if (after !== claimed) {
  console.error(`VERIFICATION FAILED: the second claim paid another ${after - claimed} tokens.`)
  process.exit(1)
}

step(8, 'Sweeping the leftover SOL back')
await sweep(buyers, payer.publicKey)

console.log('\n=========================================================')
console.log(' THE REHEARSAL SUCCEEDED')
console.log(` mint         : ${MINT.toBase58()}`)
console.log(` distributor  : ${distributor.toBase58()}`)
console.log(` vault        : ${vault.toBase58()}`)
console.log(` claimed      : ${claimed} (exactly 9% of the allocation)`)
console.log(` in the vault : ${vaultRemaining}`)
console.log(' double claim : prevented')
console.log('=========================================================')
