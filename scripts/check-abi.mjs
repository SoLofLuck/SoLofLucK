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
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
      'src/lib/sendTx.ts',
      'src/lib/presale.ts',
      'src/lib/deepLink.ts',
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
//
// Düzeltme, derlenen TÜM dosyalara uygulanıyor — elle tutulan bir listeye
// değil. Liste sabitken yeni bir kaynak eklemek denetimi kırıyordu:
// presale.ts eklendiğinde onun `./sendTx` import'u düzeltilmedi ve
// ERR_MODULE_NOT_FOUND ile patladı. Bir sonraki dosyada aynı şeyin
// yaşanmaması için özyinelemeli.
const jsDosyalari = (dizin) =>
  readdirSync(dizin, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? jsDosyalari(join(dizin, e.name))
      : e.name.endsWith('.js')
        ? [join(dizin, e.name)]
        : [],
  )
for (const yol of jsDosyalari(out)) {
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


// --- Adres çubuğu yönlendirmesi (derin bağlantı) ---------------------------
//
// Sekmeler yalnızca React state'indeydi; presale linki paylaşılamıyordu.
// Bir presale için bu ciddi bir eksik: duyuruda verilen adres kullanıcıyı
// "Token Oluştur" sekmesine düşürüyordu.
//
// Kullanıcı adres çubuğuna ne yazarsa yazsın site AÇILMALI — bozuk bir
// hash boş ekran vermemeli. Onun için burada bilinmeyen/bozuk girdiler de
// sınanıyor.
{
  const dl = await import(pathToFileURL(join(out, 'lib/deepLink.js')).href)
  const ROTA = {
    pages: ['create', 'liquidity', 'privacy', 'solofluck'],
    defaultPage: 'create',
    subTabs: ['about', 'tokenomics', 'presale', 'claim', 'game'],
    defaultSubTab: 'about',
    subTabPage: 'solofluck',
  }
  const r = (h) => dl.routeFromHash(h, ROTA)

  kontrol('rota: #solofluck/presale', JSON.stringify(r('#solofluck/presale')),
    JSON.stringify({ page: 'solofluck', subTab: 'presale' }))
  kontrol('rota: #liquidity', JSON.stringify(r('#liquidity')),
    JSON.stringify({ page: 'liquidity', subTab: 'about' }))
  kontrol('rota: boş hash -> varsayılan', JSON.stringify(r('')),
    JSON.stringify({ page: 'create', subTab: 'about' }))
  // Bilinmeyen girdiler site'yi kırmamalı.
  kontrol('rota: bilinmeyen sayfa -> varsayılan', r('#yokboyle').page, 'create')
  kontrol('rota: bilinmeyen alt sekme -> varsayılan',
    r('#solofluck/yokboyle').subTab, 'about')
  kontrol('rota: büyük harf toleranslı', r('#SOLOFLUCK/PRESALE').page, 'solofluck')
  kontrol('rota: fazladan eğik çizgi', r('##solofluck//presale/').page, 'solofluck')
  // Alt sekme yalnızca kendi sayfasında anlamlı olmalı.
  kontrol('rota: başka sayfada alt sekme yok sayılıyor',
    r('#liquidity/presale').subTab, 'about')

  // Gidiş-dönüş: yazdığımız hash'i tekrar okuyunca aynı yere düşmeli.
  let bozuk = []
  for (const page of ROTA.pages) {
    for (const subTab of ROTA.subTabs) {
      const h = dl.hashFromRoute(page, subTab, ROTA)
      const geri = r(h)
      const beklenenAlt = page === 'solofluck' ? subTab : 'about'
      if (geri.page !== page || geri.subTab !== beklenenAlt) {
        bozuk.push(`${page}/${subTab} -> ${h} -> ${geri.page}/${geri.subTab}`)
      }
    }
  }
  kontrol('rota: gidiş-dönüş tutarlı',
    bozuk.length === 0 ? true : `bozuk: ${bozuk.join(' · ')}`, true)

  // App.tsx ile SoLofLuckPage.tsx aynı rota tanımını taşıyor; ayrışırlarsa
  // sekme adres çubuğuyla uyumsuz hale gelir.
  const appSrc = readFileSync(`${repoRoot}src/App.tsx`, 'utf8')
  const sayfaSrc = readFileSync(
    `${repoRoot}src/components/solofluck/SoLofLuckPage.tsx`, 'utf8')
  const cikar = (src) => {
    const m = src.match(/const ROTA = \{([\s\S]*?)\n\}/)
    return m ? m[1].replace(/\s+/g, ' ').trim() : null
  }
  kontrol('rota: App.tsx ve SoLofLuckPage.tsx aynı tanımı kullanıyor',
    cikar(appSrc) !== null && cikar(appSrc) === cikar(sayfaSrc), true)
}

// --- Presale para kapısı ---------------------------------------------------
//
// Presale düz bir cüzdan transferi: zincirde katkıyı engelleyecek bir
// program YOK. Yani sitedeki bu tek karar, presale'in açık mı kapalı mı
// olduğunu belirleyen TEK şey. Bileşenin içinde, sınanamaz halde durmamalı.
//
// `unscheduled` -> KAPALI olması kasıtlı bir değişiklik. Önceden takvim
// ilan edilmemişken presale AÇIK bırakılıyordu ("test aşamasındayız"
// gerekçesiyle). Sonucu şuydu: yayın günü "Yakında" kapısını kaldırıp
// tarihi doldurmayı unutmak, tarihi olmayan ve karşılığında henüz basılmış
// token bulunmayan bir presale'i herkese açmak demekti. İki ayrı kontrol
// listesi maddesinin birbirine bu şekilde bağlı olması kabul edilemez.
{
  const presale = await import(pathToFileURL(join(out, 'lib/presale.js')).href)
  const k = (ad, args, beklenen) =>
    kontrol(`presale kapısı: ${ad}`, presale.presaleClosedReason(args), beklenen)

  const acik = { configured: true, targetReached: false, phase: 'live' }
  k('canlı ve hedef dolmamış -> AÇIK', acik, null)
  k('cüzdan yapılandırılmamış -> kapalı', { ...acik, configured: false }, 'unconfigured')
  k('hedef doldu (hard cap) -> kapalı', { ...acik, targetReached: true }, 'reached')
  k('takvim ilan edilmedi -> kapalı', { ...acik, phase: 'unscheduled' }, 'unscheduled')
  k('henüz başlamadı -> kapalı', { ...acik, phase: 'upcoming' }, 'upcoming')
  k('süre doldu -> kapalı', { ...acik, phase: 'ended' }, 'ended')

  // Öncelik sırası: birden fazla sebep varsa en ciddisi kazanmalı.
  k(
    'yapılandırılmamış + hedef dolu -> yapılandırma önce',
    { configured: false, targetReached: true, phase: 'live' },
    'unconfigured',
  )
  k(
    'hedef dolu + takvim yok -> hedef önce',
    { configured: true, targetReached: true, phase: 'unscheduled' },
    'reached',
  )

  // Kapının GERÇEKTEN kapalı kaldığını, yani hiçbir kombinasyonun kazara
  // açılmadığını da sınıyoruz.
  let kazaraAcik = []
  for (const configured of [true, false]) {
    for (const targetReached of [true, false]) {
      for (const phase of ['unscheduled', 'upcoming', 'live', 'ended']) {
        const r = presale.presaleClosedReason({ configured, targetReached, phase })
        if (r === null && !(configured && !targetReached && phase === 'live')) {
          kazaraAcik.push(`${configured}/${targetReached}/${phase}`)
        }
      }
    }
  }
  kontrol(
    'presale kapısı: yalnızca (yapılandırılmış + hedef dolmamış + canlı) açık',
    kazaraAcik.length === 0 ? true : `kazara açık: ${kazaraAcik.join(', ')}`,
    true,
  )
}

// --- PlayerState'in bayt düzeni: sitenin GERÇEK okuyucusu ------------------
//
// Site bu hesabı IDL kullanmadan, sabit ofsetlerle okuyor. Araya bir alan
// eklemek yeter: TypeScript aynı ofsetlerden okumaya devam eder ve hiçbir
// hata vermeden yanlış spin sayısı, yanlış kazanç gösterir.
//
// Düzen "bahsin koyulduğu andaki kurallar" alanlarıyla genişledi. Yeni
// alanlar bilerek SONA eklendi ki mevcut ofsetler kaymasın — bu kontrol
// tam olarak onu doğruluyor.
{
  const HEX = '38033c56ae10f4c309090909090909090909090909090909090909090909090909090909090909090b0000000300000001c1f4201d00000000fe0101110000000404040404040404040404040404040404040404040404040404040404040404002f685900000000010065cd1d0000000000ca9a3b00000000008c864700000000b80b3200e803d007'
  const sahteHesap = {
    getAccountInfo: async () => ({ data: Buffer.from(HEX, 'hex') }),
  }
  const oyuncuKey = new PublicKey(Buffer.alloc(32, 9))
  let ps = null
  let psHata = null
  try {
    ps = await oyun.fetchPlayerState(sahteHesap, oyuncuKey)
  } catch (e) {
    psHata = e instanceof Error ? e.message : String(e)
  }
  kontrol(
    'PlayerState: okuma hata vermiyor',
    psHata === null ? true : `HATA: ${psHata}`,
    true,
  )
  kontrol('PlayerState: okunabildi', ps !== null, true)
  kontrol('PlayerState: plays_count', ps?.playsCount, 11)
  kontrol('PlayerState: wins_count', ps?.winsCount, 3)
  kontrol('PlayerState: pending', ps?.pending, true)
  kontrol('PlayerState: commit_slot', ps?.commitSlot, 488_699_073n)
  kontrol('PlayerState: spins_remaining', ps?.spinsRemaining, 17)
  kontrol('PlayerState: total_won', ps?.totalWonLamports, 1_500_000_000n)
  kontrol('PlayerState: bonus_granted', ps?.bonusGranted, true)
  kontrol(
    'PlayerState: delegate',
    ps?.delegate?.toBase58?.(),
    new PublicKey(Buffer.alloc(32, 4)).toBase58(),
  )
}

// --- Zarın altın vektörü: BELGE ile KOD aynı şeyi mi söylüyor -------------
//
// GUVENLIK.md, oyuncuların sonucu kendi başlarına doğrulayabilmesi için
// zarın nasıl üretildiğini anlatıyor. O tarif yanlışsa belge işe yaramaz
// olmaktan da kötüsü ZARARLI olur: doğrulamaya çalışan kişi farklı bir sayı
// bulur ve "oyun hileli" sonucuna varır.
//
// Nitekim tarif YANLIŞTI. Belgede `keccak` yazıyordu; oysa oyun
// `solana_program::hash::hash` yani SHA-256 kullanıyor. (Dağıtıcı merkle
// ağacında gerçekten keccak kullanıyor — ikisi karıştırılmış.) Hatayı
// dışarıdan kodu okuyan biri buldu, benim denetimlerim değil: komut ve sayı
// denetliyordum, FORMÜL denetlemiyordum.
//
// Artık aynı vektör üç yerde birden koşuyor — belgede (Python), Rust
// testinde (altin_zar_vektoru) ve burada. Üçü ayrışırsa CI düşer.
{
  const { sha256 } = await import('@noble/hashes/sha2')

  const preimage = Buffer.concat([
    Buffer.from([...Array(32).keys()]), // slot_hash
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(488_699_073n); return b })(), // entropy_slot
    Buffer.alloc(32, 7), // oyuncu
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(5); return b })(), // plays_count
  ])
  kontrol('zar vektörü: preimage uzunluğu', preimage.length, 76)

  const digest = Buffer.from(sha256(preimage))
  kontrol(
    'zar vektörü: digest',
    digest.toString('hex'),
    '3d54d1715c5d05dcfc12bb5dd95b197b078f3135b04aab6ead91103c1233cc6d',
  )
  kontrol('zar vektörü: zar', Number(digest.readBigUInt64LE(0) % 10_000n), 7_597)
  kontrol('zar vektörü: katman', Number(digest.readBigUInt64LE(8) % 10_000n), 4_556)

  // Belgedeki tarif ile kodun kullandığı hash fonksiyonu aynı mı.
  const guvenlik = readFileSync(`${repoRoot}GUVENLIK.md`, 'utf8')
  const rust = readFileSync(
    `${repoRoot}program/luck-game/programs/luck-game/src/lib.rs`,
    'utf8',
  )
  const belgeSha = /digest\s*=\s*sha256\(/.test(guvenlik)
  const kodSha = /hash::hash\(&preimage\)/.test(rust)
  kontrol('zar vektörü: belge sha256 diyor', belgeSha, true)
  kontrol('zar vektörü: kod sha256 kullanıyor', kodSha, true)
  // Belgenin içindeki doğrulama vektörü de belgeden okunuyor: biri
  // güncellenip diğeri unutulursa yakalanır.
  kontrol(
    'zar vektörü: belgedeki digest kodunkiyle aynı',
    guvenlik.includes(digest.toString('hex')),
    true,
  )
}

// --- Compute limit kararı ---------------------------------------------------
//
// Öncelik ücreti İSTENEN compute limitiyle çarpıldığı için limiti körlemesine
// tavana çekmek her küçük işlemi pahalılaştırır; ama ölçüm yapılamadığında
// küçük bir limite düşmek de yanlış — "bakiyemi spin'e dönüştür" akışı tek
// işleme 20 adede kadar buy_spins koyabiliyor ve 300.000'i aşabiliyor. O
// durumda işlem zincirde "exceeded CUs" ile düşer ve kullanıcının gördüğü
// hata sebebi hiç anlatmaz.
//
// Bu kararı bir kez YANLIŞ vermiştim (ölçüm başarısızsa 300.000'e
// düşüyordu), yani RPC'nin salladığı anda düzeltmek için var olduğu hata
// geri geliyordu. Karar artık saf bir fonksiyonda ve burada gerçek kod
// çağrılarak sınanıyor.
{
  const gonder = await import(pathToFileURL(join(out, 'lib/sendTx.js')).href)
  const TAVAN = 1_400_000
  const TABAN = 300_000
  kontrol('compute: ölçüm yok → TAVAN', gonder.hesaplaComputeLimit(null), TAVAN)
  kontrol('compute: ölçüm 0 → TAVAN', gonder.hesaplaComputeLimit(0), TAVAN)
  kontrol('compute: küçük işlem tabanın altında kalmıyor', gonder.hesaplaComputeLimit(10_000), TABAN)
  // 400.000 × 1,3 = 520.000 — pay ekleniyor.
  kontrol('compute: ölçüme %30 pay ekleniyor', gonder.hesaplaComputeLimit(400_000), 520_000)
  kontrol('compute: tavan aşılmıyor', gonder.hesaplaComputeLimit(1_300_000), TAVAN)
}

// --- Hesapların bayt düzeni: Claim sekmesinin GERÇEK okuyucuları ------------
//
// Claim sekmesi zincirdeki Distributor hesabını IDL kullanmadan, sabit
// ofsetlerle okuyor. Struct'a araya bir alan eklemek yeter: TypeScript aynı
// ofsetlerden okumaya devam eder ve HİÇBİR HATA VERMEDEN yanlış değerler
// gösterir — merkle_root kayarsa herkese "listede değilsin", start_ts
// kayarsa yanlış takvim, total_allocated kayarsa saçma yüzdeler. Hepsi TGE
// gününde, düzeltme şansının en dar olduğu anda.
//
// Vektörler Anchor'ın kurallarından bağımsız türetildi (ayırıcı =
// sha256("account:<İsim>")[0..8], gövde = Borsh) ve Rust tarafında
// `hesap_baytlari_altin_vektore_uyuyor` ile sabitlendi.
{
  const sahteHesap = (hex) => ({
    getAccountInfo: async () => ({ data: Buffer.from(hex, 'hex') }),
  })

  const DAGITICI_HEX = '5a5ad993062087040700000000000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303040404040404040404040404040404040404040404040404040404040404040400c8d99bbf2f00000052f21f4c04000000d2496b000000008403bc02803a0900000000000d00fe'
  const DURUM_HEX = '16b7f99df75f96600052f21f4c040000fd'

  // Ofset kayması hesabın sonunu aşarsa okuma ATAR (ERR_OUT_OF_RANGE).
  // Bu da bir başarısızlık ama sebebi anlatmayan bir çökme; yakalayıp
  // düzgün bir kontrol satırına çeviriyoruz.
  let dag = null
  let dagHata = null
  try {
    dag = await claim.fetchDistributor(sahteHesap(DAGITICI_HEX), 0)
  } catch (e) {
    dagHata = e instanceof Error ? e.message : String(e)
  }
  kontrol(
    'hesap Distributor: okuma hata vermiyor',
    dagHata === null ? true : `HATA: ${dagHata}`,
    true,
  )
  kontrol('hesap Distributor: okunabildi', dag !== null, true)
  kontrol(
    'hesap Distributor: merkle_root',
    Buffer.from(dag?.merkleRoot ?? []).toString('hex'),
    '04'.repeat(32),
  )
  kontrol('hesap Distributor: total_allocated', dag?.totalAllocated, 52_500_000_000_000n)
  kontrol('hesap Distributor: total_claimed', dag?.totalClaimed, 4_725_000_000_000n)
  kontrol('hesap Distributor: start_ts', dag?.startTs, 1_800_000_000)
  kontrol('hesap Distributor: cliff_bps', dag?.cliffBps, 900)
  kontrol('hesap Distributor: period_bps', dag?.periodBps, 700)
  kontrol('hesap Distributor: period_seconds', dag?.periodSeconds, 604_800)
  kontrol('hesap Distributor: periods', dag?.periods, 13)
  // Okunan takvim gerçekten %100'e kapanıyor mu — zincirden gelen sayılarla.
  kontrol(
    'hesap Distributor: cliff + kademe × oran = %100',
    (dag?.cliffBps ?? 0) + (dag?.periods ?? 0) * (dag?.periodBps ?? 0),
    10_000,
  )

  let cekilen = null
  let cekilenHata = null
  try {
    cekilen = await claim.fetchClaimed(sahteHesap(DURUM_HEX), 0, claimant)
  } catch (e) {
    cekilenHata = e instanceof Error ? e.message : String(e)
  }
  kontrol(
    'hesap ClaimStatus: okuma hata vermiyor',
    cekilenHata === null ? true : `HATA: ${cekilenHata}`,
    true,
  )
  kontrol('hesap ClaimStatus: claimed', cekilen, 4_725_000_000_000n)
}

// --- Olayların bayt düzeni: sitenin GERÇEK ayrıştırıcıları ------------------
//
// Oyunun sonucunu site zincirden okumuyor; işlemin loglarındaki olayı
// ayrıştırıyor. Olayın alan SIRASI kayarsa — araya bir alan eklemek yeter —
// TypeScript aynı ofsetlerden okumaya devam eder ve HİÇBİR HATA VERMEDEN
// yanlış değerleri gösterir: kaybeden tura "kazandın", ödüle başka bir
// rakam. İşlem reddedilmediği için ne zincirde ne logda bir iz kalır.
//
// Vektörler Anchor'ın kurallarından bağımsız türetildi (ayırıcı =
// sha256("event:<İsim>")[0..8], gövde = Borsh) ve Rust tarafında
// `olay_baytlari_altin_vektore_uyuyor` testiyle sabitlendi. Burada aynı
// baytları GERÇEK ayrıştırıcılara verip geri okuyoruz — kopya bir
// ayrıştırıcı yazmak, kopyanın kendisiyle uyuştuğunu kanıtlardı.
{
  // Ayrıştırıcılar bir Connection'dan işlem çekiyor; sahte bir bağlantı
  // yeterli, çünkü sınadığımız şey ağ değil bayt okuma.
  const sahteBaglanti = (hex) => ({
    getTransaction: async () => ({
      meta: {
        logMessages: [
          'Program H6gnAvLa5o2JtjfdgyKdZy2eC9bjnMerCcbxjYZeKdnf invoke [1]',
          `Program data: ${Buffer.from(hex, 'hex').toString('base64')}`,
          'Program H6gnAvLa5o2JtjfdgyKdZy2eC9bjnMerCcbxjYZeKdnf success',
        ],
      },
    }),
  })

  const OYUNCU_HEX = '07'.repeat(32)

  const cozuldu = await oyun.parsePlayResolvedFromTx(
    sahteBaglanti(
      `8cb617b4df501e9d${OYUNCU_HEX}01d20296490000000000012a9ab70e00000000`,
    ),
    'sahte-imza',
  )
  kontrol('olay PlayResolved: okunabildi', cozuldu !== null, true)
  kontrol('olay PlayResolved: won', cozuldu?.won, true)
  kontrol('olay PlayResolved: prize_paid', cozuldu?.prizePaidLamports, 1_234_567_890n)
  kontrol('olay PlayResolved: is_big_win', cozuldu?.isBigWin, false)
  kontrol('olay PlayResolved: easy_mode', cozuldu?.easyMode, true)
  kontrol('olay PlayResolved: ops_fee_paid', cozuldu?.opsFeePaidLamports, 246_913_578n)

  const baslatildi = await oyun.parsePlayCommittedFromTx(
    sahteBaglanti(`0f6a7973baf30b2c${OYUNCU_HEX}0b0000001600000001cedf201d00000000`),
    'sahte-imza',
  )
  kontrol('olay PlayCommitted: okunabildi', baslatildi !== null, true)
  kontrol('olay PlayCommitted: plays_count', baslatildi?.playsCount, 11)
  kontrol('olay PlayCommitted: spins_remaining', baslatildi?.spinsRemaining, 22)
  kontrol('olay PlayCommitted: bonus_granted', baslatildi?.bonusGranted, true)
  kontrol('olay PlayCommitted: commit_slot', baslatildi?.commitSlot, 488_693_710n)

  const satin = await oyun.parseSpinsPurchasedFromTx(
    sahteBaglanti(`c39218f3ce200ed2${OYUNCU_HEX}03140000000008af2f0000000017000000`),
    'sahte-imza',
  )
  kontrol('olay SpinsPurchased: okunabildi', satin !== null, true)
  kontrol('olay SpinsPurchased: tier_index', satin?.tierIndex, 3)
  kontrol('olay SpinsPurchased: spin_count', satin?.spinCount, 20)
  kontrol('olay SpinsPurchased: price_lamports', satin?.priceLamports, 800_000_000n)
  kontrol('olay SpinsPurchased: spins_remaining', satin?.spinsRemaining, 23)

  // Ayırıcı EŞLEŞMEZSE olay okunmamalı — yoksa başka bir olayın baytları
  // PlayResolved sanılıp yanlış çözülür.
  const yanlisAyirici = await oyun.parsePlayResolvedFromTx(
    sahteBaglanti(`0f6a7973baf30b2c${OYUNCU_HEX}01d20296490000000000012a9ab70e00000000`),
    'sahte-imza',
  )
  kontrol('olay PlayResolved: yabancı ayırıcı reddediliyor', yanlisAyirici, null)
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
