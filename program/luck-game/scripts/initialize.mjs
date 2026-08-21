// luck-game initialize() çağırıcısı.
//
// Kullanım (env değişkenleriyle):
//   PROGRAM_ID=...        (zorunlu)
//   TREASURY_WALLET=...   (zorunlu — %20 ücret payının gideceği cüzdan)
//   KEYPAIR_PATH=~/.config/solana/id.json  (varsayılan)
//   RPC_URL=https://api.devnet.solana.com  (varsayılan)
//   FREE_PLAYS=3
//   SMALL_PRIZE_SOL=0.5  BIG_PRIZE_SOL=1  BIG_PRIZE_BPS=3000  VAULT_THRESHOLD_SOL=2
//   NORMAL_WIN_BPS=50  EASY_WIN_BPS=1000  TREASURY_FEE_BPS=2000
//   REVEAL_DELAY_SLOTS=5
//   SPIN_TIER_COUNTS=1,5,10,20,50,100  SPIN_TIER_PRICES_SOL=0.1,0.3,0.5,0.8,1.5,2.5
//   VAULT_BOOTSTRAP_SOL=0.05
//
// Bu değerlerin varsayılanları src/config.ts içindeki GAME_CONFIG ile
// birebir eşleşir. Program zaten initialize edilmişse (config PDA'sı
// mevcutsa) initialize() çağrısı atlanır, hata vermez — ama kasa (vault)
// bootstrap adımı yine de çalışır (idempotent, güvenle tekrar çalıştırılabilir).

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
const revealDelaySlots = BigInt(envInt('REVEAL_DELAY_SLOTS', 5))

// Spin paket tarifesi: N adet spin, X SOL karşılığında. Varsayılanlar
// kullanıcının belirlediği tarifeyle birebir eşleşir: 1/0.1, 5/0.3,
// 10/0.5, 20/0.8, 50/1.5, 100/2.5 SOL.
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
  console.error('SPIN_TIER_COUNTS ve SPIN_TIER_PRICES_SOL tam olarak 6 değer içermeli')
  process.exit(1)
}

// Yeni bir oyuncu ilk kez register_delegate() çağırdığında, program
// delegenin gaz bakiyesini KASADAN (vault) sponsor eder (bkz. lib.rs
// DELEGATE_GAS_SPONSOR_LAMPORTS) — ücretsiz deneme gerçekten ücretsiz
// olsun diye. Ama taze kurulmuş bir oyunda kasada henüz hiç satın alma
// olmadığı için 0 SOL var — sponsor edilecek bir şey yok. Bu yüzden kasayı
// burada, program sahibinin cüzdanından, küçük bir başlangıç rezerviyle
// "tohumluyoruz". Bu düz bir SOL transferi (PDA'lar imza olmadan SOL kabul
// edebilir), programın kendisiyle bir ilgisi yok.
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
    console.log('GameConfig zaten var, initialize atlanıyor:', configPda.toBase58())
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
      // [u16; 6] ve [u64; 6] — sabit boyutlu diziler, Vec<T>'nin aksine
      // uzunluk ön eki OLMADAN art arda ham değerler olarak serileşir.
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
    console.log('initialize() başarılı, imza:', sig)
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
      `Kasa (vault) ${Number(topUp) / LAMPORTS_PER_SOL} SOL ile tohumlandı, imza:`,
      sig,
    )
  } else {
    console.log('Kasa (vault) zaten yeterli bakiyeye sahip, tohumlama atlanıyor:', vaultPda.toBase58())
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
