#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ABI kontrolü — istemci/script ile program aynı baytları konuşuyor mu
// ---------------------------------------------------------------------------
// Claim talimatını SİTE (TypeScript) kuruyor, doğrulamayı PROGRAM (Rust)
// yapıyor. Aradaki tek baytlık bir fark — yanlış discriminator, ters hesap
// sırası, hatalı uzunluk alanı — TGE günü HERKESİN claim'inin reddedilmesi
// demek. Merkle kökü zincirde değiştirilemediği için o noktada düzeltme
// şansı sınırlı.
//
// Bu kontrol istemcinin GERÇEK kodunu (src/lib/luckClaim.ts) derleyip
// çalıştırıyor ve ürettiği baytları, programın kendi ürettiği sabit
// vektörle karşılaştırıyor. Vektör Rust tarafında
// `claim_talimat_baytlari_altin_vektore_uyuyor` testiyle sabitlenmiş;
// ikisinden biri kayarsa burada yakalanıyor.
//
// Talimatı burada yeniden yazmıyoruz — kopya, iki tarafın uyuştuğunu değil
// kopyanın kendisiyle uyuştuğunu kanıtlardı.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PublicKey } from '@solana/web3.js'

// --- Programın ürettiği altın vektör (bkz. distributor.rs, test 14) --------
const DISCRIMINATOR = '3ec6d6c1d59f6cd2'
const MIKTAR = 271_950_000_000_000_000n
const MIKTAR_LE = '00e0aa8a1529c603'
const KANIT_UZUNLUGU_LE = '02000000'
const VERI_UZUNLUGU = 8 + 8 + 4 + 64

// Rust'taki Claim<'info> struct'ının alan sırası. Anchor hesapları bu
// sırayla bekliyor; sıra kaydığında program yanlış hesabı yanlış rolde
// görür ve talimat reddedilir.
const HESAP_SIRASI = [
  'claimant',
  'distributor',
  'mint',
  'vault',
  'claim_status',
  'destination',
  'token_program',
  'associated_token_program',
  'system_program',
]

const hatalar = []
const kontroller = []
function kontrol(ad, gercek, beklenen) {
  const ok = String(gercek) === String(beklenen)
  kontroller.push({ ad, ok, gercek, beklenen })
  if (!ok) hatalar.push(ad)
}

// --- İstemci kodunu derle ---------------------------------------------------
// Çıktı REPO İÇİNE yazılıyor, /tmp'e değil: derlenen modül
// @solana/web3.js'i import ediyor ve Node paket çözümlemesi repo dışından
// node_modules'ı bulamıyor.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(repoRoot, 'node_modules', '.claim-abi-'))
let tscCiktisi = ''
try {
  execFileSync(
    'npx',
    [
      'tsc',
      'src/lib/luckClaim.ts',
      'src/lib/luckGame.ts',
      '--outDir', out,
      '--module', 'esnext',
      '--target', 'es2022',
      '--moduleResolution', 'bundler',
      '--skipLibCheck',
      '--ignoreConfig',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  tscCiktisi = ''
} catch (err) {
  // Tek dosyayı proje tsconfig'i olmadan derlediğimiz için tsc burada
  // gerçek OLMAYAN tip hataları bildiriyor (Buffer tipleri, Vite'ın
  // import.meta.env'i). Gerçek tip denetimi zaten `npm run build`
  // içindeki `tsc -b` ile, doğru yapılandırmayla yapılıyor.
  //
  // Bu yüzden çıktıyı yutuyoruz ama ATMIYORUZ: emit gerçekten
  // başarısız olduysa aşağıdaki import patlar ve o an sebebi
  // yazdırıyoruz. Her derlemede sahte hata basmak, gerçek bir hatayı
  // gürültünün içinde gizlerdi.
  tscCiktisi = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
}

// config.ts, Vite'ın `import.meta.env`'ini okuyor; Node'da bu tanımsız
// olduğu için modül yüklenirken patlıyor. DERLENMİŞ çıktıda boş bir
// nesneyle değiştiriyoruz — kaynak dosyaya dokunmuyoruz ve RPC uç noktası
// zaten bu kontrolün konusu değil.
// Derlenmiş çıktıya iki mekanik düzeltme (kaynak dosyalara DOKUNULMUYOR):
//
// 1. tsc, `from '../config'` gibi uzantısız göreli import'ları olduğu gibi
//    bırakıyor (bundler çözümlemesi). Node ESM uzantı istiyor.
// 2. config.ts, Vite'ın `import.meta.env`'ini okuyor; Node'da tanımsız
//    olduğu için modül yüklenirken patlıyor. RPC uç noktası bu kontrolün
//    konusu değil.
for (const dosya of ['config.js', 'lib/luckClaim.js', 'lib/luckGame.js', 'lib/sendTx.js']) {
  const yol = join(out, dosya)
  if (!existsSync(yol)) continue
  writeFileSync(
    yol,
    readFileSync(yol, 'utf8')
      .replace(/from '(\.[^']*)'/g, (m, p) => (p.endsWith('.js') ? m : `from '${p}.js'`))
      .replace(/import\.meta\.env/g, '({})'),
  )
}

let config
let claim
try {
  config = await import(pathToFileURL(join(out, 'config.js')).href)
  claim = await import(pathToFileURL(join(out, 'lib/luckClaim.js')).href)
} catch (err) {
  console.error('İstemci kodu derlenemedi — ABI karşılaştırması yapılamadı.')
  if (tscCiktisi) console.error(tscCiktisi)
  console.error(err)
  rmSync(out, { recursive: true, force: true })
  process.exit(1)
}

// Mint henüz oluşturulmadı; ABI'nin doğruluğu mint'in DEĞERİNE bağlı
// değil, yalnızca bir mint bulunmasına. Test için sabit bir adres
// veriyoruz — üretim yapılandırmasına dokunmuyoruz.
config.LUCK_TOKEN.mint = 'So11111111111111111111111111111111111111112'

const claimant = new PublicKey('BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36')
const entry = {
  address: claimant.toBase58(),
  amount: MIKTAR.toString(),
  proof: ['11'.repeat(32), '22'.repeat(32)],
}

const ix = claim.buildClaimIx(claimant, 0, entry)
const hex = Buffer.from(ix.data).toString('hex')

kontrol('talimat verisi uzunluğu', ix.data.length, VERI_UZUNLUGU)
kontrol('discriminator', hex.slice(0, 16), DISCRIMINATOR)
kontrol('miktar (u64 little-endian)', hex.slice(16, 32), MIKTAR_LE)
kontrol('kanıt uzunluğu (u32 little-endian)', hex.slice(32, 40), KANIT_UZUNLUGU_LE)
kontrol('kanıt düğüm 1', hex.slice(40, 104), '11'.repeat(32))
kontrol('kanıt düğüm 2', hex.slice(104, 168), '22'.repeat(32))

kontrol('hesap sayısı', ix.keys.length, HESAP_SIRASI.length)
// Hesapların KİMLİĞİNİ de doğruluyoruz, yalnızca sayısını değil: sıra
// kayması en olası hata ve sayı kontrolü onu yakalamaz.
const distributor = claim.distributorPda(0)
const beklenenHesaplar = [
  claimant,
  distributor,
  new PublicKey(config.LUCK_TOKEN.mint),
  claim.vaultPda(distributor),
  claim.claimStatusPda(distributor, claimant),
  claim.associatedTokenAddress(claimant, new PublicKey(config.LUCK_TOKEN.mint)),
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  new PublicKey('11111111111111111111111111111111'),
]
for (let i = 0; i < HESAP_SIRASI.length; i++) {
  kontrol(
    `hesap ${i}: ${HESAP_SIRASI[i]}`,
    ix.keys[i]?.pubkey?.toBase58(),
    beklenenHesaplar[i].toBase58(),
  )
}
// Yalnızca imzalayan alıcı olmalı; başka bir hesap imza isterse cüzdan
// hiç açılmaz ya da yanlış yetki verilir.
kontrol('yalnızca claimant imzalıyor', ix.keys.filter((k) => k.isSigner).length, 1)
kontrol('imzalayan claimant', ix.keys[0].isSigner, true)
// Programın yazdığı hesaplar yazılabilir işaretli olmalı.
for (const [i, ad] of [[1, 'distributor'], [3, 'vault'], [4, 'claim_status'], [5, 'destination']]) {
  kontrol(`${ad} yazılabilir`, ix.keys[i].isWritable, true)
}

kontrol('program adresi', ix.programId.toBase58(), config.CLAIM_CONFIG.programId)

// ---------------------------------------------------------------------------
// initialize ABI — turu açan ve tokenleri KİLİTLEYEN talimat
// ---------------------------------------------------------------------------
// Yanlış kodlanırsa iki kötü sonuçtan biri: ya işlem reddedilir (fark
// ederiz), ya da yanlış bir takvim/kök sessizce zincire yazılır — ve
// program güncelleme talimatı içermediği için o noktada geri dönüş yok.
//
// TGE günü çalışacak GERÇEK script'i (PRINT_IX modunda) çalıştırıp
// ürettiği baytları programın altın vektörüyle karşılaştırıyoruz. Talimatı
// burada yeniden kurmak, kopyanın kendisiyle uyuştuğunu kanıtlardı.
const INIT_BEKLENEN =
  'afaf6d1f0d989bed' +
  '0000000000000000' +
  '9b4c1bb9c40fe4fe3d4ee9e172c6318402503421b34f26e74ca9754938bbce84' +
  '00201a0b9ed40b00' +
  '40be966a00000000' +
  '8403' +
  'bc02' +
  '803a090000000000' +
  '0d00'

// Rust'taki Initialize<'info> struct'ının alan sırası.
const INIT_HESAP_SIRASI = [
  'authority',
  'mint',
  'distributor',
  'vault',
  'token_program',
  'system_program',
  'rent',
]

const sabitMerkle = join(out, 'round-abi.json')
writeFileSync(
  sabitMerkle,
  JSON.stringify({
    root: '9b4c1bb9c40fe4fe3d4ee9e172c6318402503421b34f26e74ca9754938bbce84',
    total: '3330000000000000',
    count: 3,
    claims: [
      { address: 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36', amount: '1110000000000000', proof: [] },
      { address: 'AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA', amount: '1110000000000000', proof: [] },
      { address: '3fBhNn8BEoFyQVAXasWj1xcNrcc2FRpLVQexFhZTnw6F', amount: '1110000000000000', proof: [] },
    ],
  }),
)

let initCikti
try {
  initCikti = execFileSync(
    process.execPath,
    ['program/luck-distributor/scripts/initialize-round.mjs'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PRINT_IX: '1',
        PROGRAM_ID: config.CLAIM_CONFIG.programId,
        MINT: config.LUCK_TOKEN.mint,
        ROUND_ID: '0',
        MERKLE_FILE: sabitMerkle,
        START_ISO: '2026-09-01T12:00:00Z',
        CLIFF_BPS: '900',
        PERIOD_BPS: '700',
        PERIODS: '13',
        AUTHORITY: 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36',
      },
    },
  )
} catch (err) {
  console.error('initialize-round.mjs çalıştırılamadı:')
  console.error(`${err.stdout ?? ''}${err.stderr ?? ''}`)
  rmSync(out, { recursive: true, force: true })
  process.exit(1)
}

const init = JSON.parse(initCikti)
kontrol('initialize: talimat baytları', init.data, INIT_BEKLENEN)
kontrol('initialize: hesap sayısı', init.keys.length, INIT_HESAP_SIRASI.length)
const initBeklenenHesaplar = [
  'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36',
  config.LUCK_TOKEN.mint,
  init.distributor,
  init.vault,
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  '11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
]
for (let i = 0; i < INIT_HESAP_SIRASI.length; i++) {
  kontrol(
    `initialize: hesap ${i}: ${INIT_HESAP_SIRASI[i]}`,
    init.keys[i]?.pubkey,
    initBeklenenHesaplar[i],
  )
}
kontrol('initialize: yalnızca authority imzalıyor', init.keys.filter((k) => k.isSigner).length, 1)
kontrol('initialize: distributor yazılabilir', init.keys[2].isWritable, true)
kontrol('initialize: vault yazılabilir', init.keys[3].isWritable, true)
kontrol('initialize: program adresi', init.programId, config.CLAIM_CONFIG.programId)


// ---------------------------------------------------------------------------
// Açılma takvimi — arayüz ile program aynı sayıyı veriyor mu
// ---------------------------------------------------------------------------
// `unlockedAmount` formülü İKİ KEZ yazılmış: programda (Rust) ve arayüzde
// (src/lib/luckClaim.ts). Bu bilinçli — arayüzün zincire sormadan doğru
// sayıyı gösterebilmesi gerekiyor. Ama ikisi ayrışırsa kullanıcı
// "çekilebilir" görüp imza atar ve işlem reddedilir; ya da tersine hak
// ettiği tutarı hiç göremez.
//
// Aşağıdaki tablo, luck-distributor testlerindeki
// `acilma_takvimi_altin_vektore_uyuyor` ile BİREBİR aynı. Sayılar
// programın çıktısına bakarak değil, yüzdelerden ayrıca hesaplandı:
// 271.950.000 × %9 = 24.475.500 · %16 = 43.512.000 · %51 = 138.694.500.
const TGE = 1_788_264_000 // 2026-09-01T12:00:00Z
const HAFTA = 604_800
const PRESALE_TOPLAM = 271_950_000_000_000_000n

const takvim = {
  merkleRoot: new Uint8Array(32),
  totalAllocated: PRESALE_TOPLAM,
  totalClaimed: 0n,
  startTs: TGE,
  cliffBps: 900,
  periodBps: 700,
  periodSeconds: HAFTA,
  periods: 13,
}

const takvimVektoru = [
  [TGE - 1, 0n, 'TGE’den 1 sn önce'],
  [TGE, 24_475_500_000_000_000n, 'TGE (%9)'],
  [TGE + HAFTA - 1, 24_475_500_000_000_000n, '1. haftanın son saniyesi'],
  [TGE + HAFTA, 43_512_000_000_000_000n, '1. hafta (%16)'],
  [TGE + 6 * HAFTA, 138_694_500_000_000_000n, '6. hafta (%51)'],
  [TGE + 13 * HAFTA, PRESALE_TOPLAM, '13. hafta (%100)'],
  [TGE + 99 * HAFTA, PRESALE_TOPLAM, 'çok sonra (hâlâ %100)'],
]

for (const [t, beklenen, ad] of takvimVektoru) {
  kontrol(
    `takvim: ${ad}`,
    claim.unlockedAmount(takvim, PRESALE_TOPLAM, t).toString(),
    beklenen.toString(),
  )
}

// YUVARLAMA YÖNÜ. Yukarıdaki vektörde her adım tam bölündüğü için
// yuvarlamanın yönünü hiç sınamıyordu — bu körlük, arayüzdeki formülü
// bilerek yukarı yuvarlayacak şekilde bozup kontrolün GEÇMESİYLE ortaya
// çıktı.
//
// Yön kritik: yukarı yuvarlansaydı tek tek payların toplamı toplam
// tahsisatı aşabilir ve SON ALICININ çekimi kasada para kalmadığı için
// düşerdi. Aşağı yuvarlamada en kötü ihtimalle birkaç birim kasada kalır.
const BOLUNMEYEN = 1_000_000_007n
for (const [kademe, beklenen, ad] of [
  [0, 90_000_000n, '%9'],
  [1, 160_000_001n, '%16'],
  [6, 510_000_003n, '%51'],
]) {
  kontrol(
    `takvim: bölünmeyen miktarda aşağı yuvarlama (${ad})`,
    claim.unlockedAmount(takvim, BOLUNMEYEN, TGE + kademe * HAFTA).toString(),
    beklenen.toString(),
  )
}

// Çekiliş turu: takvim tek kalem, TGE'de %100.
const cekilis = { ...takvim, cliffBps: 10_000, periodBps: 0, periods: 0 }
kontrol(
  'takvim: çekiliş turu TGE’de tamamı açılıyor',
  claim.unlockedAmount(cekilis, 1_110_000_000_000_000n, TGE).toString(),
  (1_110_000_000_000_000n).toString(),
)
kontrol(
  'takvim: çekiliş turu TGE’den önce kapalı',
  claim.unlockedAmount(cekilis, 1_110_000_000_000_000n, TGE - 1).toString(),
  '0',
)

// ---------------------------------------------------------------------------
// Oyun talimatları — ayırıcılar ve hesap sıraları
// ---------------------------------------------------------------------------
// Oyunun beş talimatını da site kuruyor, program doğruluyor. Ayırıcı ya da
// hesap sırası kayarsa işlem reddedilir — yani oyun tamamen durur.
//
// Ayırıcılar sha256("global:<isim>")[0..8]'den geliyor: bir talimatın ADI
// değişirse sessizce değişirler. Hesap sırası da struct alan sırasına
// bağlı; araya bir alan eklemek yeter.
//
// Vektörler luck-game testlerinde sabitlenmiş
// (oyun_talimat_ayiricilari_altin_vektore_uyuyor).
const oyun = await import(pathToFileURL(join(out, 'lib/luckGame.js')).href)

const OYUN_SISTEM = '11111111111111111111111111111111'
const OYUN_SLOTHASHES = 'SysvarS1otHashes111111111111111111111111111'
const oyuncu = new PublicKey('BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36')
const hazine = new PublicKey('5Zvz25PheDtC9PaMzwDRcnb3xKS6CU8d98PfEnKkgp9m')
const delege = new PublicKey('AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA')
const oyunConfig = oyun.getConfigPda()
const oyunVault = oyun.getVaultPda(oyunConfig)
const oyuncuState = oyun.getPlayerStatePda(oyuncu)

const oyunVektorleri = [
  {
    ad: 'buy_spins',
    ix: oyun.buildBuySpinsIx(oyuncu, 3, hazine, delege),
    veri: '1e71e289a75d298403',
    hesaplar: [
      ['player', oyuncu.toBase58(), true, true],
      ['config', oyunConfig.toBase58(), false, false],
      ['player_state', oyuncuState.toBase58(), false, true],
      ['vault', oyunVault.toBase58(), false, true],
      ['treasury', hazine.toBase58(), false, true],
      ['delegate', delege.toBase58(), false, true],
      ['system_program', OYUN_SISTEM, false, false],
    ],
  },
  {
    ad: 'register_delegate',
    ix: oyun.buildRegisterDelegateIx(oyuncu, delege),
    veri: 'da2d0c21c35959d0',
    hesaplar: [
      ['player', oyuncu.toBase58(), true, true],
      ['config', oyunConfig.toBase58(), false, false],
      ['player_state', oyuncuState.toBase58(), false, true],
      ['vault', oyunVault.toBase58(), false, true],
      ['delegate', delege.toBase58(), false, true],
      ['system_program', OYUN_SISTEM, false, false],
    ],
  },
  {
    ad: 'play',
    ix: oyun.buildPlayIx(oyuncu, delege),
    veri: 'd59dc18ee438f896',
    hesaplar: [
      ['owner', oyuncu.toBase58(), false, false],
      ['authority', delege.toBase58(), true, true],
      ['config', oyunConfig.toBase58(), false, false],
      ['player_state', oyuncuState.toBase58(), false, true],
      ['system_program', OYUN_SISTEM, false, false],
    ],
  },
  {
    ad: 'resolve',
    ix: oyun.buildResolveIx(oyuncu, hazine),
    veri: 'f696ecce6c3f3a0a',
    hesaplar: [
      ['player', oyuncu.toBase58(), false, true],
      ['config', oyunConfig.toBase58(), false, false],
      ['player_state', oyuncuState.toBase58(), false, true],
      ['vault', oyunVault.toBase58(), false, true],
      ['treasury', hazine.toBase58(), false, true],
      ['slot_hashes', OYUN_SLOTHASHES, false, false],
      ['system_program', OYUN_SISTEM, false, false],
    ],
  },
  {
    ad: 'forfeit_stuck_play',
    ix: oyun.buildForfeitStuckPlayIx(oyuncu),
    veri: '46f69baf8c6f6989',
    hesaplar: [
      // `player` YAZILABİLİR DEĞİL — program tarafında `Signer<'info>`
      // üzerinde `#[account(mut)]` yok, çünkü forfeit hiçbir lamport
      // hareketi yapmıyor (yalnızca pending bayrağını temizliyor).
      // İşlem ücretini ödeyen hesap zaten işlem düzeyinde yazılabilir
      // sayılıyor, talimat meta'sında ayrıca işaretlenmesi gerekmiyor.
      //
      // Bu satırı önce `true` yazmıştım; denetim yakaladı ve kaynağa
      // bakınca hatalı olanın BEKLENTİM olduğu ortaya çıktı.
      ['player', oyuncu.toBase58(), true, false],
      ['config', oyunConfig.toBase58(), false, false],
      ['player_state', oyuncuState.toBase58(), false, true],
    ],
  },
]

for (const v of oyunVektorleri) {
  kontrol(`oyun ${v.ad}: talimat baytları`, Buffer.from(v.ix.data).toString('hex'), v.veri)
  kontrol(`oyun ${v.ad}: hesap sayısı`, v.ix.keys.length, v.hesaplar.length)
  for (let i = 0; i < v.hesaplar.length; i++) {
    const [ad, adres, imzaci, yazilabilir] = v.hesaplar[i]
    const k = v.ix.keys[i]
    kontrol(`oyun ${v.ad}: hesap ${i} ${ad}`, k?.pubkey?.toBase58(), adres)
    kontrol(`oyun ${v.ad}: hesap ${i} ${ad} imzacı`, k?.isSigner, imzaci)
    kontrol(`oyun ${v.ad}: hesap ${i} ${ad} yazılabilir`, k?.isWritable, yazilabilir)
  }
}


rmSync(out, { recursive: true, force: true })

for (const c of kontroller) {
  const mark = c.ok ? '✓' : '✗'
  const detay = c.ok ? '' : `  (beklenen ${c.beklenen}, gelen ${c.gercek})`
  console.log(`${mark} ${c.ad}${detay}`)
}
if (hatalar.length > 0) {
  console.error(
    `\n${hatalar.length} UYUŞMAZLIK — istemci ile program farklı baytlar konuşuyor. ` +
      'Bu haliyle TGE günü hiçbir claim geçmez.',
  )
  process.exit(1)
}
console.log(`\n${kontroller.length} kontrolün hepsi geçti — istemci ve program aynı ABI'yi konuşuyor.`)
