// ---------------------------------------------------------------------------
// Devnet uçtan uca prova
// ---------------------------------------------------------------------------
// Testler zincire hiç bağlanmadan koşuyor (solana-program-test) ve 16
// senaryoyu kapsıyor. Ama TGE günü çalışacak olan şey o testler değil:
// gerçek bir mint, gerçek bir RPC, gerçek ATA'lar ve initialize-round.mjs
// script'inin kendisi. Aradaki farkı ancak gerçek bir zincirde koşarak
// kapatabiliriz.
//
// Bu script tam olarak TGE gününün provasını yapıyor:
//   1. Atılabilir bir mint oluşturur ve arz basar
//   2. Üç sahte alıcıdan bir merkle listesi üretir
//   3. initialize-round.mjs'i GERÇEKTEN çalıştırır (turu açar, kilitler)
//   4. Alıcılardan biri olarak claim eder
//   5. Çekilen miktarın takvimin öngördüğü tutara TAM eşit olduğunu
//      doğrular
//   6. İkinci kez claim denemesinin hiçbir şey ödemediğini doğrular
//
// Kullanım (env):
//   PROGRAM_ID=...   luck-distributor adresi
//   KEYPAIR_PATH=... deploy/ödeme cüzdanı
//   RPC_URL=https://api.devnet.solana.com
//   ROUND_ID=900     provaya özel, gerçek turlarla çakışmayan bir numara

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
import { keccak_256 } from '@noble/hashes/sha3'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const MINT_LEN = 82
const DECIMALS = 9

const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID ?? (() => { throw new Error('PROGRAM_ID gerekli') })())
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com'
const ROUND_ID = BigInt(process.env.ROUND_ID || '900')

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

async function tokenBalance(account) {
  const info = await connection.getAccountInfo(account)
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : null
}


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
      // TEKRAR DENEME. İlk sürüm tek deneme yapıyordu ve devnet'te
      // "Blockhash not found" ile düşüp SIFIR SOL geri aldı — süpürmenin
      // tek işi cüzdanı boşaltmamak olduğu için sessizce başarısız olması
      // onu tümüyle işlevsiz kılıyor. Hata geçici (blockhash yayılma
      // gecikmesi), yani tekrar denemek çözüyor.
      let gonderildi = false
      let sonHata = null
      for (let deneme = 0; deneme < 3 && !gonderildi; deneme++) {
        try {
          await sendAndConfirmTransaction(
            connection,
            new Transaction().add(SystemProgram.transfer({
              fromPubkey: kp.publicKey, toPubkey: hedef, lamports: gonder,
            })),
            [kp],
            { commitment: 'confirmed' },
          )
          gonderildi = true
        } catch (err) {
          sonHata = err
          await new Promise((r) => setTimeout(r, 1500 * (deneme + 1)))
        }
      }
      if (!gonderildi) throw sonHata
      toplam += BigInt(gonder)
    } catch (err) {
      console.log(`    süpürülemedi ${kp.publicKey.toBase58().slice(0, 8)}…: ${err.message}`)
    }
  }
  console.log(`    geri alınan: ${Number(toplam) / 1_000_000_000} SOL`)
}

// --- 1) Mint --------------------------------------------------------------
adim(1, 'Atılabilir mint oluşturuluyor')
const mintKp = Keypair.generate()
const rent = await connection.getMinimumBalanceForRentExemption(MINT_LEN)
{
  const initMint = Buffer.alloc(67)
  initMint.writeUInt8(0, 0) // InitializeMint
  initMint.writeUInt8(DECIMALS, 1)
  payer.publicKey.toBuffer().copy(initMint, 2)
  initMint.writeUInt8(0, 34) // freeze authority yok
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

// --- 2) Alıcılar ve merkle listesi -----------------------------------------
adim(2, 'Sahte alıcı listesi ve merkle ağacı üretiliyor')
const alicilar = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
const PAY = 1_110_000_000_000_000n // 1.110.000 token, 9 ondalık
const tmp = mkdtempSync(join(tmpdir(), 'prova-'))
const listeDosyasi = join(tmp, 'alicilar.txt')
writeFileSync(listeDosyasi, alicilar.map((k) => k.publicKey.toBase58()).join('\n'))

const merkleDosyasi = join(tmp, 'round.json')
writeFileSync(
  merkleDosyasi,
  execFileSync(process.execPath, [
    'scripts/build-merkle.mjs', '--amount', PAY.toString(), listeDosyasi,
  ], { encoding: 'utf8' }),
)
const merkle = JSON.parse(readFileSync(merkleDosyasi, 'utf8'))
const TOPLAM = BigInt(merkle.total)
console.log(`    ${merkle.count} alıcı · toplam ${TOPLAM} · kök ${merkle.root.slice(0, 16)}...`)

// --- 3) Arz bas -------------------------------------------------------------
adim(3, 'Arz basılıyor (kaynak hesaba)')
const kaynak = ata(payer.publicKey, MINT)
{
  const createAta = new TransactionInstruction({
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
  })
  const mintTo = Buffer.alloc(9)
  mintTo.writeUInt8(7, 0) // MintTo
  mintTo.writeBigUInt64LE(TOPLAM, 1)
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(createAta).add(new TransactionInstruction({
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
}
console.log(`    kaynak hesapta: ${await tokenBalance(kaynak)}`)

// --- 4) Turu aç — TGE günü çalışacak script'in TA KENDİSİ ------------------
adim(4, 'initialize-round.mjs çalıştırılıyor (gerçek kilitleme)')
// Başlangıcı GEÇMİŞE alıyoruz ki TGE dilimi hemen açılmış olsun ve
// claim'i aynı koşuda sınayabilelim. Takvim gerçek presale takvimiyle
// birebir aynı: %9 + 13 × %7.
const BASLANGIC = new Date(Date.now() - 60_000)
console.log(
  execFileSync(process.execPath, ['program/luck-distributor/scripts/initialize-round.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROGRAM_ID: PROGRAM_ID.toBase58(),
      MINT: MINT.toBase58(),
      ROUND_ID: ROUND_ID.toString(),
      MERKLE_FILE: merkleDosyasi,
      START_ISO: BASLANGIC.toISOString(),
      CLIFF_BPS: '900', PERIOD_BPS: '700', PERIODS: '13',
      SOURCE_TOKEN_ACCOUNT: kaynak.toBase58(),
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
adim(5, 'Alıcı kendi payını çekiyor')
const alici = alicilar[0]
const giris = merkle.claims.find((c) => c.address === alici.publicKey.toBase58())
if (!giris) throw new Error('alıcı merkle listesinde bulunamadı')

// Alıcının işlem ücreti için birazcık SOL'e ihtiyacı var.
await sendAndConfirmTransaction(
  connection,
  new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey, toPubkey: alici.publicKey, lamports: 20_000_000,
  })),
  [payer],
  { commitment: 'confirmed' },
)

const hedef = ata(alici.publicKey, MINT)
const [claimStatus] = PublicKey.findProgramAddressSync(
  [Buffer.from('claim'), distributor.toBuffer(), alici.publicKey.toBuffer()], PROGRAM_ID)

function claimIx() {
  const kanit = giris.proof.map((h) => Buffer.from(h, 'hex'))
  const data = Buffer.alloc(8 + 8 + 4 + kanit.length * 32)
  let o = 0
  disc('claim').copy(data, o); o += 8
  data.writeBigUInt64LE(BigInt(giris.amount), o); o += 8
  data.writeUInt32LE(kanit.length, o); o += 4
  for (const n of kanit) { n.copy(data, o); o += 32 }
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: alici.publicKey, isSigner: true, isWritable: true },
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
  })
}

await sendAndConfirmTransaction(connection, new Transaction().add(claimIx()), [alici], {
  commitment: 'confirmed',
})

// --- 6) Doğrulama -----------------------------------------------------------
adim(6, 'Sonuç doğrulanıyor')
const cekilen = (await tokenBalance(hedef)) ?? 0n
const beklenen = (PAY * 900n) / 10_000n // TGE dilimi: %9
console.log(`    çekilen : ${cekilen}`)
console.log(`    beklenen: ${beklenen} (payın %9'u)`)
if (cekilen !== beklenen) {
  console.error('DOĞRULAMA DÜŞTÜ: çekilen tutar takvimin öngördüğüne eşit değil.')
  process.exit(1)
}

const kasaKalan = await tokenBalance(vault)
if (kasaKalan !== TOPLAM - beklenen) {
  console.error(`DOĞRULAMA DÜŞTÜ: kasada ${kasaKalan}, olması gereken ${TOPLAM - beklenen}.`)
  process.exit(1)
}

// İkinci claim aynı dilimi TEKRAR ödememeli.
adim(7, 'İkinci claim denemesi (aynı dilim tekrar ödenmemeli)')
try {
  await sendAndConfirmTransaction(connection, new Transaction().add(claimIx()), [alici], {
    commitment: 'confirmed',
  })
} catch {
  // Program "çekilecek bir şey yok" diyerek reddedebilir — bu da kabul.
  console.log('    ikinci deneme reddedildi (beklenen)')
}
const sonra = (await tokenBalance(hedef)) ?? 0n
if (sonra !== cekilen) {
  console.error(`DOĞRULAMA DÜŞTÜ: ikinci claim ${sonra - cekilen} token daha ödedi.`)
  process.exit(1)
}

adim(8, 'Kalan SOL geri süpürülüyor')
await suepuer(alicilar, payer.publicKey)

console.log('\n=========================================================')
console.log(' PROVA BAŞARILI')
console.log(` mint       : ${MINT.toBase58()}`)
console.log(` dağıtıcı   : ${distributor.toBase58()}`)
console.log(` kasa       : ${vault.toBase58()}`)
console.log(` çekilen    : ${cekilen} (payın tam %9'u)`)
console.log(` kasada     : ${kasaKalan}`)
console.log(' çifte çekim: engellendi')
console.log('=========================================================')
