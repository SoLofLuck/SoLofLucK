// ---------------------------------------------------------------------------
// TAM AKIŞ PROVASI — presale'den claim'e, gerçek zincirde
// ---------------------------------------------------------------------------
// rehearsal.mjs dağıtım tarafını kanıtlıyor (tur açma + claim). Ama TGE
// gününün zinciri daha uzun ve halkalardan biri kopsa diğerleri işe
// yaramaz:
//
//   katkı → alıcı listesi → merkle → dağıtıcı → claim
//
// Ortadaki iki halka bugüne kadar GERÇEK ZİNCİRDE hiç koşmadı:
// presale-buyers.mjs'in zincir okuma kısmı (yalnızca saf fonksiyonu
// --selftest ile sınanmıştı) ve build-merkle.mjs'in o çıktıyı okuması.
// Alıcı listesi yanlışsa herkesin payı yanlış olur ve bunu ancak TGE günü
// öğreniriz.
//
// Bu prova zincirin TAMAMINI koşuyor: üç sahte alıcı gerçekten SOL
// gönderiyor (sitenin yaptığı gibi %90/%10 bölünmüş, memo'lu), sonra
// presale-buyers.mjs bu katkıları zincirden okuyor, build-merkle.mjs
// ağacı kuruyor, initialize-round.mjs turu açıyor ve alıcılardan biri
// payını çekiyor.
//
// Kullanım (env):
//   PROGRAM_ID / KEYPAIR_PATH / RPC_URL / ROUND_ID (varsayılan 901)

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
  process.env.PROGRAM_ID ?? (() => { throw new Error('PROGRAM_ID gerekli') })(),
)
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const ROUND_ID = BigInt(process.env.ROUND_ID || '901')

// Bölünme oranı ve fiyat sitedeki gerçek değerler.
//
// KATKI TUTARLARI KÜÇÜLTÜLDÜ. Önce sitedeki gerçek ölçekle
// (0,5 / 1,25 / 2,0 SOL, bilet birimi 0,5) koşuyordu ve tek prova 3,75
// SOL harcıyordu — devnet cüzdanını boşalttı, faucet de rate limit
// yüzünden doldurmadı. Prova "tekrar tekrar" koşturulamıyorsa işe
// yaramaz.
//
// Bilet birimi de aynı oranda küçültüldüğü için sınanan MANTIK
// değişmiyor: tam bölünen katkı, artan bırakan katkı ve katı bir kat.
// Bilet hesabının doğruluğu oranlara bağlı, mutlak tutara değil.
const TOKENS_PER_SOL = 350_000
const TICKET_UNIT_SOL = 0.02
/** Alıcı başına işlem ücreti + ATA kirası payı. Fazlası sonda geri süpürülüyor. */
const ALICI_GAZ_LAMPORT = 10_000_000
const OPS_NUM = 10
const OPS_DEN = 100
const DECIMALS = 9

const connection = new Connection(RPC_URL, 'confirmed')
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(KEYPAIR_PATH, 'utf8'))),
)

const adim = (n, t) => console.log(`\n[${n}] ${t}`)
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

const tmp = mkdtempSync(join(tmpdir(), 'tam-prova-'))

// --- Kalan SOL'ü geri süpür -------------------------------------------------
// Prova, tek kullanımlık cüzdanlara SOL gönderiyor. Süpürülmezse o SOL
// ORADA KALIYOR ve anahtarlar süreç bitince kayboluyor — yani her koşu
// deploy cüzdanını biraz daha boşaltıyor. Nitekim boşalttı: bir sonraki
// program yükseltmesi, buffer kirası için 0,11 SOL bulamadığı ve devnet
// faucet'i de rate limit yüzünden vermediği için düştü.
//
// Hesabı tamamen boşaltıyoruz (bakiye - işlem ücreti). Rent-exempt taban
// altına düşen hesap zaten silinip lamport'ları iade ediliyor.
async function suepuer(kaynaklar, hedef) {
  let toplam = 0n
  for (const kp of kaynaklar) {
    try {
      const bakiye = await connection.getBalance(kp.publicKey)
      const ucret = 5_000
      if (bakiye <= ucret) continue
      const gonder = bakiye - ucret
      await sendAndConfirmTransaction(
        connection,
        new Transaction().add(SystemProgram.transfer({
          fromPubkey: kp.publicKey, toPubkey: hedef, lamports: gonder,
        })),
        [kp],
        { commitment: 'confirmed' },
      )
      toplam += BigInt(gonder)
    } catch (err) {
      console.log(`    süpürülemedi ${kp.publicKey.toBase58().slice(0, 8)}…: ${err.message}`)
    }
  }
  console.log(`    geri alınan: ${Number(toplam) / 1_000_000_000} SOL`)
}


// --- 1) Atılabilir presale ve operasyon cüzdanları --------------------------
adim(1, 'Atılabilir presale/operasyon cüzdanları ve üç alıcı')
const presaleWallet = Keypair.generate()
const opsWallet = Keypair.generate()
// 0,02 → tam 1 bilet · 0,05 → 2 bilet (0,01 artıyor) · 0,08 → 4 bilet
const alicilar = [
  { kp: Keypair.generate(), sol: 0.02 },
  { kp: Keypair.generate(), sol: 0.05 },
  { kp: Keypair.generate(), sol: 0.08 },
]
for (const a of alicilar) {
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: a.kp.publicKey,
      lamports: Math.round(a.sol * LAMPORTS) + ALICI_GAZ_LAMPORT,
    })),
    [payer],
    { commitment: 'confirmed' },
  )
  console.log(`    alıcı ${a.kp.publicKey.toBase58().slice(0, 8)}… → ${a.sol} SOL katkı yapacak`)
}

// --- 2) Katkılar — sitenin yaptığı işlemin AYNISI ---------------------------
adim(2, 'Katkılar gönderiliyor (%90 kasa / %10 operasyon, memo ile)')
for (const a of alicilar) {
  const toplam = Math.round(a.sol * LAMPORTS)
  const ops = Math.floor((toplam * OPS_NUM) / OPS_DEN)
  const havuz = toplam - ops
  const bilet = Math.floor((a.sol + 1e-9) / TICKET_UNIT_SOL)
  await sendAndConfirmTransaction(
    connection,
    new Transaction()
      .add(SystemProgram.transfer({
        fromPubkey: a.kp.publicKey, toPubkey: presaleWallet.publicKey, lamports: havuz,
      }))
      .add(SystemProgram.transfer({
        fromPubkey: a.kp.publicKey, toPubkey: opsWallet.publicKey, lamports: ops,
      }))
      .add(new TransactionInstruction({
        keys: [{ pubkey: a.kp.publicKey, isSigner: true, isWritable: false }],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(JSON.stringify({
          app: 'solofluck-presale', mode: 'flex', sol: a.sol, tickets: bilet,
          pool: havuz, ops,
        }), 'utf-8'),
      })),
    [a.kp],
    { commitment: 'confirmed' },
  )
  // İKİ ALAN, İKİ AYRI BİRİM — ikisi de ayrı ayrı doğrulanıyor.
  // `tokens` insan için (tam token), `baseUnits` zincir için (en küçük
  // birim). Merkle yaprağına ve claim'e giren `baseUnits`.
  a.beklenenTamToken = Math.round(a.sol * TOKENS_PER_SOL)
  a.beklenenToken = BigInt(a.beklenenTamToken) * BigInt(10) ** BigInt(DECIMALS)
  a.beklenenBilet = bilet
  console.log(`    ${a.sol} SOL gönderildi (${havuz} kasa + ${ops} operasyon)`)
}

// --- 3) Alıcı listesi — ZİNCİRDEN okunuyor ---------------------------------
adim(3, 'presale-buyers.mjs zincirden okuyor')
const alicilarJson = join(tmp, 'alicilar.json')
writeFileSync(
  alicilarJson,
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
const liste = JSON.parse(readFileSync(alicilarJson, 'utf8'))
const kayitlar = liste.buyers ?? liste.rows ?? liste
console.log(`    ${Array.isArray(kayitlar) ? kayitlar.length : '?'} alıcı bulundu`)

// ASIL KONTROL: script her alıcıya TAM doğru tutarı verdi mi?
// Operasyon payı sayılmasaydı herkes %10 eksik alırdı — bu kontrol tam
// olarak o hatayı yakalar.
let hata = 0
for (const a of alicilar) {
  const adres = a.kp.publicKey.toBase58()
  const kayit = (Array.isArray(kayitlar) ? kayitlar : []).find(
    (r) => (r.address ?? r.wallet ?? r.buyer) === adres,
  )
  if (!kayit) {
    console.error(`    HATA: ${adres} listede yok`)
    hata++
    continue
  }
  // `baseUnits` alanı ZORUNLU: merkle yaprağına giren sayı bu. Yoksa
  // liste eski sürümle üretilmiş demektir ve sessizce 10^9 kat yanlış
  // bir ağaç kurulurdu.
  if (kayit.baseUnits === undefined) {
    console.error(`    HATA: ${adres} kaydında "baseUnits" yok`)
    hata++
    continue
  }
  const tamToken = Number(kayit.tokens ?? -1)
  const enKucukBirim = BigInt(kayit.baseUnits)
  const bilet = Number(kayit.tickets ?? -1)
  const tamOk = tamToken === a.beklenenTamToken
  const birimOk = enKucukBirim === a.beklenenToken
  const biletOk = bilet === a.beklenenBilet
  console.log(
    `    ${adres.slice(0, 8)}…` +
      ` tam token ${tamToken}/${a.beklenenTamToken} ${tamOk ? 'OK' : 'HATA'}` +
      ` · en küçük birim ${enKucukBirim}/${a.beklenenToken} ${birimOk ? 'OK' : 'HATA'}` +
      ` · bilet ${bilet}/${a.beklenenBilet} ${biletOk ? 'OK' : 'HATA'}`,
  )
  if (!tamOk || !birimOk || !biletOk) hata++
}
if (hata > 0) {
  console.error(`\nDOĞRULAMA DÜŞTÜ: ${hata} alıcının payı yanlış hesaplandı.`)
  process.exit(1)
}

// --- 4) Merkle ağacı — alıcı listesinden --------------------------------
adim(4, 'build-merkle.mjs alıcı listesinden ağacı kuruyor')
const merkleDosyasi = join(tmp, 'round.json')
writeFileSync(
  merkleDosyasi,
  execFileSync(process.execPath, ['scripts/build-merkle.mjs', alicilarJson], { encoding: 'utf8' }),
)
const merkle = JSON.parse(readFileSync(merkleDosyasi, 'utf8'))
const TOPLAM = BigInt(merkle.total)
console.log(`    ${merkle.count} yaprak · toplam ${TOPLAM} · kök ${merkle.root.slice(0, 16)}…`)
const beklenenToplam = alicilar.reduce((s, a) => s + a.beklenenToken, 0n)
if (TOPLAM !== beklenenToplam) {
  console.error(`DOĞRULAMA DÜŞTÜ: merkle toplamı ${TOPLAM}, olması gereken ${beklenenToplam}.`)
  process.exit(1)
}

// --- 5) Mint + arz ----------------------------------------------------------
adim(5, 'Mint oluşturuluyor ve arz basılıyor')
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
const kaynak = ata(payer.publicKey, MINT)
const mintTo = Buffer.alloc(9)
mintTo.writeUInt8(7, 0)
mintTo.writeBigUInt64LE(TOPLAM, 1)
await sendAndConfirmTransaction(
  connection,
  new Transaction()
    .add(new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: kaynak, isSigner: false, isWritable: true },
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
        { pubkey: kaynak, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: mintTo,
    })),
  [payer],
  { commitment: 'confirmed' },
)
console.log(`    mint ${MINT.toBase58()} · basılan ${await tokenBalance(kaynak)}`)

// --- 6) Turu aç -------------------------------------------------------------
adim(6, 'initialize-round.mjs turu açıyor (gerçek presale takvimi)')
console.log(
  execFileSync(process.execPath, ['program/luck-distributor/scripts/initialize-round.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROGRAM_ID: PROGRAM_ID.toBase58(),
      MINT: MINT.toBase58(),
      ROUND_ID: ROUND_ID.toString(),
      MERKLE_FILE: merkleDosyasi,
      START_ISO: new Date(Date.now() - 60_000).toISOString(),
      CLIFF_BPS: '900', PERIOD_BPS: '700', PERIODS: '13',
      SOURCE_TOKEN_ACCOUNT: kaynak.toBase58(),
      KEYPAIR_PATH, RPC_URL, DRY_RUN: '0',
    },
  }),
)

// --- 7) Claim ---------------------------------------------------------------
adim(7, 'Her alıcı payını çekiyor')
const [distributor] = PublicKey.findProgramAddressSync(
  [Buffer.from('distributor'), MINT.toBuffer(), u64le(ROUND_ID)], PROGRAM_ID)
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from('vault'), distributor.toBuffer()], PROGRAM_ID)

let toplamCekilen = 0n
for (const a of alicilar) {
  const adres = a.kp.publicKey.toBase58()
  const giris = merkle.claims.find((c) => c.address === adres)
  if (!giris) { console.error(`HATA: ${adres} merkle'da yok`); process.exit(1) }

  const hedef = ata(a.kp.publicKey, MINT)
  const [claimStatus] = PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), distributor.toBuffer(), a.kp.publicKey.toBuffer()], PROGRAM_ID)
  const kanit = giris.proof.map((h) => Buffer.from(h, 'hex'))
  const data = Buffer.alloc(8 + 8 + 4 + kanit.length * 32)
  let o = 0
  disc('claim').copy(data, o); o += 8
  data.writeBigUInt64LE(BigInt(giris.amount), o); o += 8
  data.writeUInt32LE(kanit.length, o); o += 4
  for (const n of kanit) { n.copy(data, o); o += 32 }

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: a.kp.publicKey, isSigner: true, isWritable: true },
        { pubkey: distributor, isSigner: false, isWritable: true },
        { pubkey: MINT, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: claimStatus, isSigner: false, isWritable: true },
        { pubkey: hedef, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    })),
    [a.kp],
    { commitment: 'confirmed' },
  )

  const cekilen = (await tokenBalance(hedef)) ?? 0n
  const beklenen = (a.beklenenToken * 900n) / 10_000n
  console.log(`    ${adres.slice(0, 8)}… çekti ${cekilen} (bekl. ${beklenen})`)
  if (cekilen !== beklenen) {
    console.error(`DOĞRULAMA DÜŞTÜ: ${adres} yanlış tutar çekti.`)
    process.exit(1)
  }
  toplamCekilen += cekilen
}

const kasa = await tokenBalance(vault)
if (kasa !== TOPLAM - toplamCekilen) {
  console.error(`DOĞRULAMA DÜŞTÜ: kasada ${kasa}, olması gereken ${TOPLAM - toplamCekilen}.`)
  process.exit(1)
}

adim(8, 'Kalan SOL geri süpürülüyor')
await suepuer([...alicilar.map((a) => a.kp), presaleWallet, opsWallet], payer.publicKey)

console.log('\n=========================================================')
console.log(' TAM AKIŞ PROVASI BAŞARILI')
console.log(' katkı → alıcı listesi → merkle → dağıtıcı → claim')
console.log(` alıcı sayısı  : ${alicilar.length}`)
console.log(` toplam pay    : ${TOPLAM}`)
console.log(` çekilen (TGE) : ${toplamCekilen}`)
console.log(` kasada kalan  : ${kasa}`)
console.log('=========================================================')
