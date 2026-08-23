// luck-game update_config() çağırıcısı.
//
// initialize() yalnızca BİR KEZ çalışır; oyunun parametrelerini (ödüller,
// oranlar, paket tarifesi) ve HAZİNE CÜZDANINI sonradan değiştirmenin tek
// yolu bu instruction. Yalnızca `config.authority` (deploy anahtarı)
// çağırabilir.
//
// DİKKAT: update_config, verilen TÜM alanları baştan yazar — "sadece şunu
// değiştir" gibi kısmi bir güncelleme yok. Bu yüzden aşağıdaki
// varsayılanlar src/config.ts içindeki GAME_CONFIG ile birebir aynı
// tutulmalı; sadece değiştirmek istediğiniz değeri env ile geçin, gerisi
// olduğu gibi yeniden yazılır.
//
// Kullanım (env değişkenleriyle):
//   PROGRAM_ID=...        (zorunlu)
//   TREASURY_WALLET=...   (zorunlu — %20 payın ve ödül payının gideceği cüzdan)
//   KEYPAIR_PATH=~/.config/solana/id.json  (varsayılan)
//   RPC_URL=https://api.devnet.solana.com  (varsayılan)
//   FREE_PLAYS=3
//   SMALL_PRIZE_SOL=0.5  BIG_PRIZE_SOL=1  BIG_PRIZE_BPS=3000  VAULT_THRESHOLD_SOL=2
//   NORMAL_WIN_BPS=50  EASY_WIN_BPS=1000  TREASURY_FEE_BPS=2000
//   SPIN_TIER_COUNTS=1,5,10,20,50,100  SPIN_TIER_PRICES_SOL=0.1,0.3,0.5,0.8,1.5,2.5
//
// Not: `reveal_delay_slots` update_config'te YOK — commit/reveal penceresi
// initialize anındaki değerde kalır (bekleyen oyunların kurallarını
// değiştirmemek için kasıtlı).

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
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'

const LAMPORTS_PER_SOL = 1_000_000_000
const freePlays = envInt('FREE_PLAYS', 3)
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
  console.error('SPIN_TIER_COUNTS ve SPIN_TIER_PRICES_SOL tam olarak 6 değer içermeli')
  process.exit(1)
}

// Programın kendi kontrolüyle aynı kural: kasa eşiği, jackpot + onun
// üstüne eklenen operasyon payını karşılayabilmeli. Zincire boşuna bir
// işlem göndermeden burada da doğruluyoruz ki hata, anlaşılmaz bir
// "InvalidParam" yerine burada net bir mesajla çıksın.
const jackpotWithFee =
  bigPrizeLamports + (bigPrizeLamports * BigInt(treasuryFeeBps)) / BigInt(10_000)
if (vaultThresholdLamports < jackpotWithFee) {
  console.error(
    `VAULT_THRESHOLD_SOL çok düşük: jackpot + %${treasuryFeeBps / 100} pay = ` +
      `${Number(jackpotWithFee) / LAMPORTS_PER_SOL} SOL, eşik ise ` +
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
      `GameConfig bulunamadı (${configPda.toBase58()}) — önce initialize.mjs çalıştırılmalı.`,
    )
    process.exit(1)
  }

  // Mevcut hazine adresini yazdır ki değişiklik kayda geçsin: GameConfig
  // düzeni = 8 (disc) + 32 (authority) + 32 (treasury) ...
  const currentTreasury = new PublicKey(existing.data.subarray(40, 72))
  console.log('Mevcut hazine:', currentTreasury.toBase58())
  console.log('Yeni hazine  :', TREASURY_WALLET.toBase58())

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
  console.log('update_config() başarılı, imza:', sig)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
