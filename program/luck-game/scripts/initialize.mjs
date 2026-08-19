// luck-game initialize() çağırıcısı.
//
// Kullanım (env değişkenleriyle):
//   PROGRAM_ID=...        (zorunlu)
//   TREASURY_WALLET=...   (zorunlu — %20 ücret payının gideceği cüzdan)
//   KEYPAIR_PATH=~/.config/solana/id.json  (varsayılan)
//   RPC_URL=https://api.devnet.solana.com  (varsayılan)
//   ENTRY_FEE_SOL=0.1  FREE_PLAYS=3  PRIZE_SOL=1  VAULT_THRESHOLD_SOL=2
//   NORMAL_WIN_BPS=50  EASY_WIN_BPS=1000  TREASURY_FEE_BPS=2000
//   REVEAL_DELAY_SLOTS=5
//
// Bu değerlerin varsayılanları src/config.ts içindeki GAME_CONFIG ile
// birebir eşleşir. Program zaten initialize edilmişse (config PDA'sı
// mevcutsa) işlem atlanır, hata vermez.

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
    console.error(`Eksik ortam değişkeni: ${name}`)
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
const entryFeeLamports = BigInt(Math.round(envFloat('ENTRY_FEE_SOL', 0.1) * LAMPORTS_PER_SOL))
const freePlays = envInt('FREE_PLAYS', 3)
const prizeLamports = BigInt(Math.round(envFloat('PRIZE_SOL', 1) * LAMPORTS_PER_SOL))
const vaultThresholdLamports = BigInt(
  Math.round(envFloat('VAULT_THRESHOLD_SOL', 2) * LAMPORTS_PER_SOL),
)
const normalWinBps = envInt('NORMAL_WIN_BPS', 50)
const easyWinBps = envInt('EASY_WIN_BPS', 1000)
const treasuryFeeBps = envInt('TREASURY_FEE_BPS', 2000)
const revealDelaySlots = BigInt(envInt('REVEAL_DELAY_SLOTS', 5))

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
    console.log('GameConfig zaten var, initialize atlanıyor:', configPda.toBase58())
    return
  }

  const data = Buffer.concat([
    anchorDiscriminator('initialize'),
    u64(entryFeeLamports),
    u8(freePlays),
    u64(prizeLamports),
    u64(vaultThresholdLamports),
    u16(normalWinBps),
    u16(easyWinBps),
    u16(treasuryFeeBps),
    u64(revealDelaySlots),
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
  console.log('initialize() başarılı, imza:', sig)
  console.log('GameConfig PDA:', configPda.toBase58())
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
