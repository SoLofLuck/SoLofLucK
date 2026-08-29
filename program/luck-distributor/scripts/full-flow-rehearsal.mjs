// ---------------------------------------------------------------------------
// THE FULL-FLOW REHEARSAL — from the presale to the claim, on a real chain
// ---------------------------------------------------------------------------
// rehearsal.mjs proves the distribution side (opening a round + claiming). But
// TGE day's chain is longer than that, and if one link breaks the others are
// useless:
//
//   contribution -> buyer list -> merkle -> distributor -> claim
//
// The two links in the middle have never run ON A REAL CHAIN until now: the
// chain-reading part of presale-buyers.mjs (only its pure function had been
// exercised with --selftest) and build-merkle.mjs reading that output. If the
// buyer list is wrong then everyone's allocation is wrong, and we would only
// find out on TGE day.
//
// This rehearsal runs the WHOLE chain: three fake buyers really send SOL (split
// 90%/10% with a memo, exactly as the site does), then presale-buyers.mjs reads
// those contributions off the chain, build-merkle.mjs builds the tree,
// initialize-round.mjs opens the round, and each buyer claims their allocation.
//
// Usage (env):
//   PROGRAM_ID / KEYPAIR_PATH / RPC_URL / ROUND_ID (default 901)

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
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const MINT_LEN = 82
const LAMPORTS = 1_000_000_000

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID ?? (() => { throw new Error('PROGRAM_ID is required') })(),
)
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const ROUND_ID = BigInt(process.env.ROUND_ID || '901')

// The split ratio and the price are the real values from the site.
//
// THE CONTRIBUTION AMOUNTS WERE SCALED DOWN. It used to run at the site's real
// scale (0.5 / 1.25 / 2.0 SOL, with a 0.5 ticket unit) and a single rehearsal
// spent 3.75 SOL — it emptied the devnet wallet, and the faucet would not refill
// it because of the rate limit. A rehearsal that cannot be run over and over is
// useless.
//
// Because the ticket unit was scaled down by the same factor, the LOGIC under
// test does not change: a contribution that divides exactly, one that leaves a
// remainder, and a strict multiple. The correctness of the ticket calculation
// depends on the ratios, not on the absolute amounts.
const TOKENS_PER_SOL = 350_000
const TICKET_UNIT_SOL = 0.02
/** Transaction fees plus a share of the ATA rent, per buyer. The excess is swept back at the end. */
const BUYER_GAS_LAMPORTS = 10_000_000
/** The contribution amounts (SOL). The balance pre-check is computed from these too. */
const BUYER_AMOUNTS = [0.02, 0.05, 0.08]
const OPS_NUM = 10
const OPS_DEN = 100
const DECIMALS = 9

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
async function tokenBalance(a) {
  const i = await connection.getAccountInfo(a)
  return i ? Buffer.from(i.data).readBigUInt64LE(64) : null
}

const tmp = mkdtempSync(join(tmpdir(), 'full-rehearsal-'))

// --- Pre-check: is the balance sufficient -----------------------------------
// If it is not, the rehearsal dies halfway through with a raw Solana error
// ("Transfer: insufficient lamports ...") whose cause can only be worked out by
// reading the logs and doing the arithmetic. Stopping up front, naming the
// amount and the wallet, is more honest.
//
// THE CONTRIBUTION AMOUNTS CANNOT BE SCALED DOWN FURTHER, and the reason is
// instructive: a contribution is split 90%/10%, so on a 0.02 SOL contribution
// 2,000,000 lamports go to the operations wallet. Below that, the operations
// share drops UNDER Solana's rent-exemption floor (~890,880 lamports) and the
// transaction is rejected with "InsufficientFundsForRent" — the very same error
// this project hit at the start. So making the rehearsal cheaper would break the
// flow it is meant to test.
{
  const neededLamports =
    BUYER_AMOUNTS.reduce((t, sol) => t + Math.round(sol * LAMPORTS) + BUYER_GAS_LAMPORTS, 0) +
    60_000_000 // the mint, distributor, vault and ATA rents + a share of the transaction fees
  const current = await connection.getBalance(payer.publicKey)
  if (current < neededLamports) {
    console.error(
      'Insufficient balance.\n' +
        `  wallet  : ${payer.publicKey.toBase58()}\n` +
        `  current : ${(current / LAMPORTS).toFixed(4)} SOL\n` +
        `  needed  : ~${(neededLamports / LAMPORTS).toFixed(4)} SOL\n\n` +
        'The devnet faucet rate-limits GitHub runner IPs. Devnet SOL has to be ' +
        'sent to this wallet by hand (faucet.solana.com).',
    )
    process.exit(1)
  }
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


// --- 1) Throwaway presale and operations wallets ----------------------------
step(1, 'Throwaway presale/operations wallets and three buyers')
const presaleWallet = Keypair.generate()
const opsWallet = Keypair.generate()
// 0.02 -> exactly 1 ticket · 0.05 -> 2 tickets (0.01 left over) · 0.08 -> 4 tickets
const buyers = BUYER_AMOUNTS.map((sol) => ({ kp: Keypair.generate(), sol }))
for (const b of buyers) {
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: b.kp.publicKey,
      lamports: Math.round(b.sol * LAMPORTS) + BUYER_GAS_LAMPORTS,
    })),
    [payer],
    { commitment: 'confirmed' },
  )
  console.log(`    buyer ${b.kp.publicKey.toBase58().slice(0, 8)}… will contribute ${b.sol} SOL`)
}

// --- 2) The contributions — EXACTLY the transaction the site sends ----------
step(2, 'Sending the contributions (90% vault / 10% operations, with a memo)')
for (const b of buyers) {
  const total = Math.round(b.sol * LAMPORTS)
  const ops = Math.floor((total * OPS_NUM) / OPS_DEN)
  const pool = total - ops
  const tickets = Math.floor((b.sol + 1e-9) / TICKET_UNIT_SOL)
  await sendAndConfirmTransaction(
    connection,
    new Transaction()
      .add(SystemProgram.transfer({
        fromPubkey: b.kp.publicKey, toPubkey: presaleWallet.publicKey, lamports: pool,
      }))
      .add(SystemProgram.transfer({
        fromPubkey: b.kp.publicKey, toPubkey: opsWallet.publicKey, lamports: ops,
      }))
      .add(new TransactionInstruction({
        keys: [{ pubkey: b.kp.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(JSON.stringify({
          app: 'solofluck-presale', mode: 'flex', sol: b.sol, tickets,
          pool, ops,
        }), 'utf-8'),
      })),
    [b.kp],
    { commitment: 'confirmed' },
  )
  // TWO FIELDS, TWO DIFFERENT UNITS — each is verified separately.
  // `tokens` is for humans (whole tokens), `baseUnits` is for the chain (the
  // smallest unit). What goes into the merkle leaf and the claim is `baseUnits`.
  b.expectedWholeTokens = Math.round(b.sol * TOKENS_PER_SOL)
  b.expectedBaseUnits = BigInt(b.expectedWholeTokens) * BigInt(10) ** BigInt(DECIMALS)
  b.expectedTickets = tickets
  console.log(`    sent ${b.sol} SOL (${pool} vault + ${ops} operations)`)
}

// --- 3) The buyer list — read FROM THE CHAIN -------------------------------
step(3, 'presale-buyers.mjs reads from the chain')
const buyersJson = join(tmp, 'buyers.json')
writeFileSync(
  buyersJson,
  execFileSync(process.execPath, ['scripts/presale-buyers.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RPC_URL,
      WALLET: presaleWallet.publicKey.toBase58(),
      OPS_WALLET: opsWallet.publicKey.toBase58(),
      TOKENS_PER_SOL: String(TOKENS_PER_SOL),
      TICKET_UNIT_SOL: String(TICKET_UNIT_SOL),
      FORMAT: 'json',
    },
  }),
)
const list = JSON.parse(readFileSync(buyersJson, 'utf8'))
const records = list.buyers ?? list.rows ?? list
console.log(`    found ${Array.isArray(records) ? records.length : '?'} buyer(s)`)

// THE REAL CHECK: did the script give every buyer EXACTLY the right amount?
// If the operations share were not accounted for, everyone would be 10% short —
// this check catches precisely that bug.
let errors = 0
for (const b of buyers) {
  const address = b.kp.publicKey.toBase58()
  const record = (Array.isArray(records) ? records : []).find(
    (r) => (r.address ?? r.wallet ?? r.buyer) === address,
  )
  if (!record) {
    console.error(`    ERROR: ${address} is not in the list`)
    errors++
    continue
  }
  // The `baseUnits` field is REQUIRED: it is the number that goes into the
  // merkle leaf. Without it the list was produced by an older version, and the
  // tree would silently be built with a factor of 10^9 wrong.
  if (record.baseUnits === undefined) {
    console.error(`    ERROR: the record for ${address} has no "baseUnits"`)
    errors++
    continue
  }
  const wholeTokens = Number(record.tokens ?? -1)
  const baseUnits = BigInt(record.baseUnits)
  const tickets = Number(record.tickets ?? -1)
  const wholeOk = wholeTokens === b.expectedWholeTokens
  const unitsOk = baseUnits === b.expectedBaseUnits
  const ticketsOk = tickets === b.expectedTickets
  console.log(
    `    ${address.slice(0, 8)}…` +
      ` whole tokens ${wholeTokens}/${b.expectedWholeTokens} ${wholeOk ? 'OK' : 'ERROR'}` +
      ` · base units ${baseUnits}/${b.expectedBaseUnits} ${unitsOk ? 'OK' : 'ERROR'}` +
      ` · tickets ${tickets}/${b.expectedTickets} ${ticketsOk ? 'OK' : 'ERROR'}`,
  )
  if (!wholeOk || !unitsOk || !ticketsOk) errors++
}
if (errors > 0) {
  console.error(`\nVERIFICATION FAILED: the allocation of ${errors} buyer(s) was computed wrong.`)
  process.exit(1)
}

// --- 4) The merkle tree — from the buyer list ------------------------------
step(4, 'build-merkle.mjs builds the tree from the buyer list')
const merkleFile = join(tmp, 'round.json')
writeFileSync(
  merkleFile,
  execFileSync(process.execPath, ['scripts/build-merkle.mjs', buyersJson], { encoding: 'utf8' }),
)
const merkle = JSON.parse(readFileSync(merkleFile, 'utf8'))
const TOTAL = BigInt(merkle.total)
console.log(`    ${merkle.count} leaves · total ${TOTAL} · root ${merkle.root.slice(0, 16)}…`)
const expectedTotal = buyers.reduce((s, b) => s + b.expectedBaseUnits, 0n)
if (TOTAL !== expectedTotal) {
  console.error(`VERIFICATION FAILED: the merkle total is ${TOTAL}, it should be ${expectedTotal}.`)
  process.exit(1)
}

// --- 5) Mint + supply -------------------------------------------------------
step(5, 'Creating the mint and minting the supply')
const mintKp = Keypair.generate()
const rent = await connection.getMinimumBalanceForRentExemption(MINT_LEN)
const initMint = Buffer.alloc(35)
initMint.writeUInt8(0, 0)
initMint.writeUInt8(DECIMALS, 1)
payer.publicKey.toBuffer().copy(initMint, 2)
initMint.writeUInt8(0, 34)
await sendAndConfirmTransaction(
  connection,
  new Transaction()
    .add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey,
      lamports: rent, space: MINT_LEN, programId: TOKEN_PROGRAM_ID,
    }))
    .add(new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: mintKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: initMint,
    })),
  [payer, mintKp],
  { commitment: 'confirmed' },
)
const MINT = mintKp.publicKey
const source = ata(payer.publicKey, MINT)
const mintTo = Buffer.alloc(9)
mintTo.writeUInt8(7, 0)
mintTo.writeBigUInt64LE(TOTAL, 1)
await sendAndConfirmTransaction(
  connection,
  new Transaction()
    .add(new TransactionInstruction({
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
    }))
    .add(new TransactionInstruction({
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
console.log(`    mint ${MINT.toBase58()} · minted ${await tokenBalance(source)}`)

// --- 6) Open the round ------------------------------------------------------
step(6, 'initialize-round.mjs opens the round (the real presale schedule)')
console.log(
  execFileSync(process.execPath, ['program/luck-distributor/scripts/initialize-round.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROGRAM_ID: PROGRAM_ID.toBase58(),
      MINT: MINT.toBase58(),
      ROUND_ID: ROUND_ID.toString(),
      MERKLE_FILE: merkleFile,
      START_ISO: new Date(Date.now() - 60_000).toISOString(),
      CLIFF_BPS: '900', PERIOD_BPS: '700', PERIODS: '13',
      SOURCE_TOKEN_ACCOUNT: source.toBase58(),
      KEYPAIR_PATH, RPC_URL, DRY_RUN: '0',
    },
  }),
)

// --- 7) Claim ---------------------------------------------------------------
step(7, 'Every buyer claims their allocation')
const [distributor] = PublicKey.findProgramAddressSync(
  [Buffer.from('distributor'), MINT.toBuffer(), u64le(ROUND_ID)], PROGRAM_ID)
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from('vault'), distributor.toBuffer()], PROGRAM_ID)

let totalClaimed = 0n
for (const b of buyers) {
  const address = b.kp.publicKey.toBase58()
  const entry = merkle.claims.find((c) => c.address === address)
  if (!entry) { console.error(`ERROR: ${address} is not in the merkle tree`); process.exit(1) }

  const destination = ata(b.kp.publicKey, MINT)
  const [claimStatus] = PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), distributor.toBuffer(), b.kp.publicKey.toBuffer()], PROGRAM_ID)
  const proof = entry.proof.map((h) => Buffer.from(h, 'hex'))
  const data = Buffer.alloc(8 + 8 + 4 + proof.length * 32)
  let o = 0
  disc('claim').copy(data, o); o += 8
  data.writeBigUInt64LE(BigInt(entry.amount), o); o += 8
  data.writeUInt32LE(proof.length, o); o += 4
  for (const n of proof) { n.copy(data, o); o += 32 }

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: b.kp.publicKey, isSigner: true, isWritable: true },
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
    })),
    [b.kp],
    { commitment: 'confirmed' },
  )

  const claimed = (await tokenBalance(destination)) ?? 0n
  const expected = (b.expectedBaseUnits * 900n) / 10_000n
  console.log(`    ${address.slice(0, 8)}… claimed ${claimed} (expected ${expected})`)
  if (claimed !== expected) {
    console.error(`VERIFICATION FAILED: ${address} claimed the wrong amount.`)
    process.exit(1)
  }
  totalClaimed += claimed
}

const vaultBalance = await tokenBalance(vault)
if (vaultBalance !== TOTAL - totalClaimed) {
  console.error(`VERIFICATION FAILED: the vault holds ${vaultBalance}, it should hold ${TOTAL - totalClaimed}.`)
  process.exit(1)
}

step(8, 'Sweeping the leftover SOL back')
await sweep([...buyers.map((b) => b.kp), presaleWallet, opsWallet], payer.publicKey)

console.log('\n=========================================================')
console.log(' THE FULL-FLOW REHEARSAL SUCCEEDED')
console.log(' contribution -> buyer list -> merkle -> distributor -> claim')
console.log(` buyers          : ${buyers.length}`)
console.log(` total allocated : ${TOTAL}`)
console.log(` claimed (TGE)   : ${totalClaimed}`)
console.log(` left in vault   : ${vaultBalance}`)
console.log('=========================================================')
