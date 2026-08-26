// ---------------------------------------------------------------------------
// luck-distributor: bir dağıtım turu açar ve tokenleri kilitler
// ---------------------------------------------------------------------------
// TGE günü çalışacak script bu. Yaptığı iş sırayla:
//   1. Dağıtıcı (distributor) hesabını ve kasasını (vault) oluşturur —
//      merkle kökü, toplam miktar ve vesting takvimi burada SABİTLENİR.
//   2. Tokenleri kasaya aktarır.
//   3. Kasadaki bakiyenin merkle listesindeki toplama TAM eşit olduğunu
//      doğrular.
//
// Adım 3 kritik: program "parayı geri çek" talimatı içermiyor (bilerek).
// Kasaya eksik token konursa son alıcılar çekemez; fazla konursa fazlası
// sonsuza kadar kilitli kalır. İkisi de geri alınamaz, o yüzden script
// eksik ya da fazla gördüğü anda duruyor.
//
// Kullanım (env):
//   PROGRAM_ID=...            (zorunlu) luck-distributor program adresi
//   MINT=...                  (zorunlu) $LUCK mint adresi
//   ROUND_ID=0                (zorunlu) 0 = presale, 1..14 = haftalık çekiliş
//   MERKLE_FILE=public/merkle/round-0.json   (zorunlu)
//   START_ISO=2026-09-01T12:00:00Z           (zorunlu) TGE / tur başlangıcı
//   CLIFF_BPS=900 PERIOD_BPS=700 PERIODS=13 PERIOD_SECONDS=604800
//   SOURCE_TOKEN_ACCOUNT=...  (varsayılan: imzalayanın ATA'sı)
//   KEYPAIR_PATH=~/.config/solana/id.json
//   RPC_URL=https://api.devnet.solana.com
//   DRY_RUN=1                 hiçbir işlem göndermeden ne yapacağını yazar
//
// Çekiliş turları için takvim tek kalemdir: CLIFF_BPS=10000, PERIODS=0.

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
    console.error(`Eksik ortam değişkeni: ${name}`)
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
  console.error('START_ISO geçerli bir tarih değil.')
  process.exit(1)
}

// Takvim kontrolü — program da aynısını zorunlu kılıyor (ScheduleNotComplete)
// ama hatayı zincire para göndermeden ÖNCE görmek istiyoruz.
const totalBps = CLIFF_BPS + PERIODS * PERIOD_BPS
if (totalBps !== 10_000) {
  console.error(
    `Takvim %100'e ulaşmıyor: ${CLIFF_BPS} + ${PERIODS} × ${PERIOD_BPS} = ${totalBps} bps.\n` +
      'Program bunu zaten reddederdi; burada durmak, boşuna işlem ücreti ödememek için.',
  )
  process.exit(1)
}

// --- Merkle dosyası ---------------------------------------------------------
const merkle = JSON.parse(readFileSync(MERKLE_FILE, 'utf8'))
if (!merkle.root || !Array.isArray(merkle.claims)) {
  console.error(`${MERKLE_FILE} beklenen biçimde değil (root + claims).`)
  process.exit(1)
}
const totalFromClaims = merkle.claims.reduce((a, c) => a + BigInt(c.amount), 0n)
if (merkle.total !== undefined && BigInt(merkle.total) !== totalFromClaims) {
  console.error(
    `Merkle dosyasındaki toplam (${merkle.total}) tek tek payların toplamıyla ` +
      `(${totalFromClaims}) uyuşmuyor.`,
  )
  process.exit(1)
}
const TOTAL_ALLOCATED = totalFromClaims
const MERKLE_ROOT = Buffer.from(merkle.root, 'hex')
if (MERKLE_ROOT.length !== 32) {
  console.error('Merkle kökü 32 bayt değil.')
  process.exit(1)
}

// --- PDA'lar ----------------------------------------------------------------
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

// --- Anchor talimat ayırıcısı ----------------------------------------------
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

/** SPL Token `Transfer` (talimat 3): u8 etiket + u64 miktar. */
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
  // SPL token hesabında miktar 64. bayttan itibaren, u64 little-endian.
  return Buffer.from(info.data).readBigUInt64LE(64)
}

// --- Çalıştır ---------------------------------------------------------------
// DRY_RUN, ANAHTAR OLMADAN da çalışmalı: bu modun asıl işi, TGE'den önce
// "hangi sayılarla, hangi takvimle, hangi kökle kilitleyeceğiz" sorusunu
// zincire hiç dokunmadan yanıtlamak. İmza anahtarı gerektirseydi bu
// kontrolü ancak deploy makinesinde yapabilirdik.
// Anahtar YALNIZCA gerçekten işlem gönderirken zorunlu. DRY_RUN ve
// PRINT_IX, TGE'den önce her yerden koşturulabilmeli.
const anahtarGerekli = !DRY_RUN && process.env.PRINT_IX !== '1'
let payer = null
if (anahtarGerekli || existsSync(KEYPAIR_PATH)) {
  const secret = JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))
  payer = Keypair.fromSecretKey(Uint8Array.from(secret))
}
const source = process.env.SOURCE_TOKEN_ACCOUNT
  ? new PublicKey(process.env.SOURCE_TOKEN_ACCOUNT)
  : payer
    ? ata(payer.publicKey, MINT)
    : null

const sessiz = process.env.PRINT_IX === '1'
const yaz = (...a) => { if (!sessiz) console.log(...a) }
yaz('=========================================================')
yaz(` Tur              : ${ROUND_ID}`)
yaz(` Program          : ${PROGRAM_ID.toBase58()}`)
yaz(` Mint             : ${MINT.toBase58()}`)
yaz(` Dağıtıcı         : ${distributor.toBase58()}`)
yaz(` Kasa             : ${vault.toBase58()}`)
yaz(` Kaynak hesap     : ${source ? source.toBase58() : '(imzalayanın ATA’sı — anahtar verilmedi)'}`)
yaz(` Alıcı sayısı     : ${merkle.claims.length}`)
yaz(` Toplam miktar    : ${TOTAL_ALLOCATED}`)
yaz(` Merkle kökü      : ${merkle.root}`)
yaz(` Başlangıç        : ${new Date(Number(START_TS) * 1000).toISOString()}`)
yaz(` Takvim           : TGE %${CLIFF_BPS / 100} + ${PERIODS} × %${PERIOD_BPS / 100}`)
yaz(` Aralık           : ${PERIOD_SECONDS} sn`)
yaz('=========================================================')

// PRINT_IX, bu script'in ÜRETTİĞİ initialize talimatını (bayt bayt) dışarı
// veriyor. scripts/check-abi.mjs onu programın kendi ürettiği altın
// vektörle karşılaştırıyor.
//
// Talimatı kontrol script'inde yeniden yazmak yerine BURADAN okumamızın
// sebebi: TGE günü çalışacak kod tam olarak bu — env okuması, takvim
// hesabı, hesap sırası dahil. Kopyasını sınamak, kopyanın kendisiyle
// uyuştuğunu kanıtlardı.
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
  console.log('DRY_RUN=1 — hiçbir işlem gönderilmedi.')
  process.exit(0)
}

const connection = new Connection(RPC_URL, 'confirmed')

const existing = await connection.getAccountInfo(distributor)
if (existing) {
  console.log('Dağıtıcı zaten mevcut — initialize atlanıyor.')
} else {
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(buildInitializeIx(payer.publicKey)),
    [payer],
    { commitment: 'confirmed' },
  )
  console.log(`initialize gönderildi: ${sig}`)
}

const vaultBalance = (await tokenBalance(connection, vault)) ?? 0n
const eksik = TOTAL_ALLOCATED - vaultBalance
if (eksik > 0n) {
  console.log(`Kasaya ${eksik} token aktarılıyor...`)
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(buildTransferIx(source, vault, payer.publicKey, eksik)),
    [payer],
    { commitment: 'confirmed' },
  )
  console.log(`transfer gönderildi: ${sig}`)
} else if (eksik < 0n) {
  console.error(
    `Kasada FAZLA token var (${vaultBalance} > ${TOTAL_ALLOCATED}). Fazlası ` +
      'sonsuza kadar kilitli kalır — programda geri çekme talimatı yok.',
  )
  process.exit(1)
}

// Son doğrulama: kasadaki bakiye listedeki toplama TAM eşit olmalı.
const son = (await tokenBalance(connection, vault)) ?? 0n
if (son !== TOTAL_ALLOCATED) {
  console.error(`DOĞRULAMA DÜŞTÜ: kasada ${son}, olması gereken ${TOTAL_ALLOCATED}.`)
  process.exit(1)
}
console.log(`\nTamam. Kasada tam ${son} token kilitli.`)
console.log(`Dağıtıcı: ${distributor.toBase58()}`)
