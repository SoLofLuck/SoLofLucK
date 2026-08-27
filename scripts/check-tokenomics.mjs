#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Tokenomics tutarlılık denetimi
// ---------------------------------------------------------------------------
// config.ts'teki sayılar birbirine bağlı: presale kovası hedefle fiyatın
// çarpımına, çekiliş kovası tur × kazanan × ödüle, pazarlama kırılımı kendi
// toplamına eşit olmak ZORUNDA. Bunlardan biri elle değiştirilip diğeri
// unutulursa, sitede birbiriyle çelişen iki sayı yayınlanır — ve bunu
// yatırımcı fark eder, biz etmeyiz.
//
// Bu denetim tam olarak bunu engelliyor: her derlemede koşuyor (npm run
// build öncesi) ve tutarsızlık varsa derlemeyi DÜŞÜRÜYOR.
//
// Kullanım: node scripts/check-tokenomics.mjs

import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'

const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')

const fails = []
const checks = []
function check(name, actual, expected) {
  const ok = actual === expected
  checks.push({ name, ok, actual, expected })
  if (!ok) fails.push(name)
}

const int = (re, label) => {
  const m = src.match(re)
  if (!m) throw new Error(`config.ts içinde bulunamadı: ${label}`)
  return Number(m[1].replace(/_/g, ''))
}

// --- Temel sayılar -----------------------------------------------------------
const supply = int(/totalSupply:\s*([0-9_]+)/, 'totalSupply')
const target = int(/export const PRESALE_TARGET_SOL\s*=\s*([0-9_]+)/, 'PRESALE_TARGET_SOL')
const perSol = int(/export const PRESALE_TOKENS_PER_SOL\s*=\s*([0-9_]+)/, 'PRESALE_TOKENS_PER_SOL')

// --- Kova yüzdeleri ----------------------------------------------------------
const buckets = {}
for (const m of src.matchAll(/key: '(\w+)',\s*\n\s*label: '[^']*',\s*\n\s*percent: (\d+)/g)) {
  buckets[m[1]] = Number(m[2])
}
const pctTotal = Object.values(buckets).reduce((a, b) => a + b, 0)
check('kova yüzdeleri toplamı %100', pctTotal, 100)

const tokensOf = (key) => (supply * buckets[key]) / 100
for (const [key, pct] of Object.entries(buckets)) {
  check(`${key} kovası tam sayı token`, Number.isInteger((supply * pct) / 100), true)
}

// --- Presale: hedef × fiyat = kova ------------------------------------------
check('presale kovası = hedef × fiyat', tokensOf('presale'), target * perSol)

// --- Çekiliş -----------------------------------------------------------------
const rounds = int(/RAFFLE\s*=\s*\{[\s\S]*?rounds:\s*(\d+)/, 'RAFFLE.rounds')
const perRound = int(/perRoundTokens:\s*([0-9_]+)/, 'perRoundTokens')
const perWinner = int(/perWinnerTokens:\s*([0-9_]+)/, 'perWinnerTokens')
const ticketBlock = src.match(/ticket:\s*\{([\s\S]*?)\}/)[1]
const twitterBlock = src.match(/twitter:\s*\{([\s\S]*?)\}/)[1]
const sub = (block, name) => Number(block.match(new RegExp(name + ':\\s*([0-9_]+)'))[1].replace(/_/g, ''))

const tWin = sub(ticketBlock, 'winnersPerRound')
const tTotalWin = sub(ticketBlock, 'totalWinners')
const tTokens = sub(ticketBlock, 'totalTokens')
const xWin = sub(twitterBlock, 'winnersPerRound')
const xTotalWin = sub(twitterBlock, 'totalWinners')
const xTokens = sub(twitterBlock, 'totalTokens')

check('çekiliş: tur × tur-ödülü = topluluk kovası', rounds * perRound, tokensOf('community'))
check('çekiliş: biletli + twitter = topluluk kovası', tTokens + xTokens, tokensOf('community'))
check('çekiliş: kazanan sayısı × ödül = tur ödülü', (tWin + xWin) * perWinner, perRound)
check('çekiliş: biletli toplam kazanan', tWin * rounds, tTotalWin)
check('çekiliş: twitter toplam kazanan', xWin * rounds, xTotalWin)
check('çekiliş: biletli toplam token', tTotalWin * perWinner, tTokens)
check('çekiliş: twitter toplam token', xTotalWin * perWinner, xTokens)

// --- Presale vesting: %100'e ulaşmalı ---------------------------------------
// Aynı kural claim programında da zorunlu (initialize içindeki
// ScheduleNotComplete kontrolü) — burada sitedeki takvimin onunla
// uyuştuğunu doğruluyoruz.
const presaleVesting = src.match(/key: 'presale',\s*\n\s*label: 'Presale',\s*\n\s*steps: \[([\s\S]*?)\]/)
if (presaleVesting) {
  const amounts = [...presaleVesting[1].matchAll(/amount: ([0-9_]+)/g)].map((m) =>
    Number(m[1].replace(/_/g, '')),
  )
  const stepCounts = [...presaleVesting[1].matchAll(/\((\d+) adım\)/g)].map((m) => Number(m[1]))
  // İlk adım TGE (1 kez), ikinci adım N kez tekrarlanıyor.
  const repeats = stepCounts[0] ?? 1
  const total = amounts[0] + amounts[1] * repeats
  check('presale vesting toplamı = presale kovası', total, tokensOf('presale'))
}

// --- Pazarlama kırılımı ------------------------------------------------------
const cexTotal = int(/cexReserve:\s*\{\s*\n\s*total:\s*([0-9_]+)/, 'cexReserve.total')
const cexWallets = int(/cexReserve:[\s\S]*?wallets:\s*(\d+)/, 'cexReserve.wallets')
const cexPer = int(/perWallet:\s*([0-9_]+)/, 'cexReserve.perWallet')
const flowTotal = int(/flow:\s*\{\s*\n\s*total:\s*([0-9_]+)/, 'flow.total')
check('pazarlama: CEX + akan = pazarlama kovası', cexTotal + flowTotal, tokensOf('marketing'))
check('pazarlama: CEX kasa başına × adet = CEX toplamı', cexPer * cexWallets, cexTotal)

// --- Presale SOL dağılımı ----------------------------------------------------
const solPcts = src.match(/PRESALE_SOL_ALLOCATION[\s\S]*?\]/)[0]
const solTotal = [...solPcts.matchAll(/percent: (\d+)/g)].reduce((a, m) => a + Number(m[1]), 0)
check('presale SOL dağılımı toplamı %100', solTotal, 100)

// --- Yayınlanan cüzdanlar ----------------------------------------------------
const addresses = [...src.matchAll(/address: '([1-9A-HJ-NP-Za-km-z]{32,44})'/g)].map((m) => m[1])
const walletConsts = [...src.matchAll(/export const \w*WALLET\w*\s*=\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'/g)].map(
  (m) => m[1],
)
const all = [...addresses, ...walletConsts]
let allValid = true
for (const a of all) {
  try {
    new PublicKey(a)
  } catch {
    allValid = false
    fails.push(`geçersiz adres: ${a}`)
  }
}
check('yayınlanan adreslerin hepsi geçerli', allValid, true)
check('yayınlanan adresler benzersiz', new Set(all).size, all.length)

// --- Para giden cüzdanlar: sabitlenmiş liste --------------------------------
// Bir adreste tek harf değişse bile base58 hâlâ geçerli 32 bayt üretir; yani
// "adres geçerli mi" kontrolü yazım hatasını YAKALAYAMAZ. Parayı alan her
// cüzdanı bu yüzden buraya sabitliyoruz: config.ts'te biri sessizce
// değişirse derleme düşer. Adres gerçekten değişecekse iki dosyayı da
// bilerek düzenlemek gerekir — kaza ile olmaz.
const PINNED = {
  PRESALE_WALLET: 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36',
  PRESALE_OPS_WALLET: '2Lzc6jorznu7zQKny79topGTE7V837oiV3j53zPH4Qh9',
  'GAME_CONFIG.programId': 'H6gnAvLa5o2JtjfdgyKdZy2eC9bjnMerCcbxjYZeKdnf',
  'CLAIM_CONFIG.programId': 'G8hKTeAbpMCwNTn7WzKnT6PFxnVfLJuvQFg5XBTX2E8e',
  'GAME_CONFIG.treasuryWallet': '5Zvz25PheDtC9PaMzwDRcnb3xKS6CU8d98PfEnKkgp9m',
  'PUBLIC_WALLETS.team': 'AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA',
  'PUBLIC_WALLETS.community': '3fBhNn8BEoFyQVAXasWj1xcNrcc2FRpLVQexFhZTnw6F',
  'PUBLIC_WALLETS.marketing': 'BiWqNZzCPCfJtVPNhoCrvEb9s6unpCFXXf38GR3WnPWX',
  'cexReserve.1': 'CZ639Mx6MFiZfwpVFLecyMTecGp2Cv6HErdoWqgZG6HS',
  'cexReserve.2': '3cCqgaj4QzKQUFvSNnz1yqrqcPt7xiKsbh29AfVoGM8B',
  'cexReserve.3': 'DmdePMQyuKEX9Hwaytx6tEfPxx5utBVxSJ5bgWrKghmh',
}
const foundAddrs = new Set([
  ...all,
  ...[...src.matchAll(/(?:treasuryWallet|programId):\s*'([1-9A-HJ-NP-Za-km-z]{32,44})'/g)].map((m) => m[1]),
])
for (const [label, addr] of Object.entries(PINNED)) {
  check(`sabit cüzdan yerinde: ${label}`, foundAddrs.has(addr), true)
}

// --- Çekiliş ödülünün EN KÜÇÜK BİRİM karşılığı ------------------------------
// Çekiliş turlarında merkle ağacı `--amount <en küçük birim>` ile
// kuruluyor ve o sayı belgelerde/örneklerde ELLE yazılı. config.ts'teki
// perWinnerTokens değişip bu sabit unutulursa, kazananlara yanlış miktar
// dağıtılır — hem de tam olarak hangi yönde olduğu belli olmadan.
//
// Aynı sınıftan bir hata zaten yaşandı: presale yolunda tam token ile en
// küçük birim karışmıştı ve fark 10^9 kattı.
const decimals = int(/export const DEFAULT_DECIMALS\s*=\s*(\d+)/, 'DEFAULT_DECIMALS')
const perWinnerBase = BigInt(perWinner) * BigInt(10) ** BigInt(decimals)
const merkleSrc = readFileSync(new URL('./build-merkle.mjs', import.meta.url), 'utf8')
const belgelenenler = [...merkleSrc.matchAll(/\b(1110000000000000)\b/g)].map((m) => m[1])
check(
  'build-merkle örnekleri kazanan başına ödülle tutuyor',
  belgelenenler.every((v) => BigInt(v) === perWinnerBase) && belgelenenler.length > 0,
  true,
)

// --- Sitedeki ANLATIM metni sayılarla tutuyor mu ----------------------------
// Tokenomics sekmesi sayıları config'ten okuyor, ama AboutTab'daki SSS
// cevabı onları ELLE YAZIYOR. Config değişip metin unutulursa aynı sitede
// iki farklı sayı yayınlanmış olur — ve bunu okuyan yatırımcı, "bunlar
// kendi sayılarını bile tutturamamış" diye düşünür.
//
// Metnin tamamını doğrulamıyoruz (üslup değişebilir); yalnızca İÇİNDE
// GEÇEN sayıların config'le aynı olduğunu.
const about = readFileSync(new URL('../src/components/solofluck/AboutTab.tsx', import.meta.url), 'utf8')
const sssCevabi = about.match(/a: 'Tokenomics sekmesindeki dağılıma göre:([\s\S]*?)',\n/)
if (!sssCevabi) {
  fails.push('AboutTab SSS cevabı bulunamadı (metin yeniden yazılmış olabilir)')
} else {
  const metin = sssCevabi[1]
  const metindekiYuzdeler = [...metin.matchAll(/%(\d+)\s+(presale|likidite|topluluk|kilitli|pazarlama)/g)]
    .map((m) => [m[2], Number(m[1])])
  const configYuzdeler = {
    presale: buckets.presale,
    likidite: buckets.liquidity,
    topluluk: buckets.community,
    kilitli: buckets.team,
    pazarlama: buckets.marketing,
  }
  for (const [ad, deger] of metindekiYuzdeler) {
    check(`SSS metni: ${ad} yüzdesi`, deger, configYuzdeler[ad])
  }
  check('SSS metni: beş kovanın hepsi geçiyor', metindekiYuzdeler.length, 5)

  // Çekiliş toplamları (nokta ayraçlı yazılıyor)
  const sayilar = [...metin.matchAll(/([\d.]{7,})/g)].map((m) => Number(m[1].replace(/\./g, '')))
  check('SSS metni: biletli çekiliş toplamı', sayilar.includes(tTokens), true)
  check('SSS metni: twitter çekilişi toplamı', sayilar.includes(xTokens), true)

  // Vesting takvimi
  // Kaynakta kesme işareti kaçırılmış geçiyor (TGE\'de), deseni buna
  // toleranslı tutuyoruz.
  const tge = metin.match(/TGE\\?'de %(\d+)/)
  const hafta = metin.match(/(\d+) hafta boyunca haftalık %(\d+)/)
  check('SSS metni: TGE açılış yüzdesi', tge ? Number(tge[1]) : null, 9)
  check('SSS metni: haftalık kademe sayısı', hafta ? Number(hafta[1]) : null, 13)
  check('SSS metni: haftalık açılış yüzdesi', hafta ? Number(hafta[2]) : null, 7)
}

// --- Oyun ekonomisi ----------------------------------------------------------
// GAME_CONFIG'teki sayılar doğrudan `initialize.mjs`e gidiyor ve zincirdeki
// programın kabul ettiği kurallara uymak ZORUNDA. Uymazlarsa iki farklı
// şekilde patlıyorlar ve ikisi de geç fark ediliyor:
//
//   1. initialize() `InvalidParam` (0x1771) ile düşüyor — TGE günü, oyunu
//      açmaya çalışırken. Hata mesajı hangi parametrenin bozuk olduğunu
//      söylemiyor.
//   2. Daha kötüsü: initialize GEÇİYOR ama çalışma anında bir transfer
//      Solana'nın kira tabanının (0 baytlık hesap için 890.880 lamport)
//      altında kalıyor ve İŞLEMİN TAMAMI `InsufficientFundsForRent` ile
//      geri alınıyor. Program hatasız, oyuncu ekranında anlamsız bir hata.
//      Prova sırasında tam olarak bu yaşandı (0,02 SOL'ün %10'u tabanın
//      altında kalmıştı).
//
// Bu yüzden programın `require!` satırlarını burada da kuruyoruz.
{
  const g = src.match(/export const GAME_CONFIG\s*=\s*\{([\s\S]*?)\n\}/)
  if (!g) throw new Error('config.ts içinde GAME_CONFIG bulunamadı')
  const blok = g[1]
  const oku = (re, etiket) => {
    const m = blok.match(re)
    if (!m) throw new Error(`GAME_CONFIG içinde bulunamadı: ${etiket}`)
    return Number(m[1].replace(/_/g, ''))
  }

  const LAMPORT = 1_000_000_000
  // Solana'da 0 baytlık bir hesabın var olabilmesi için gereken taban.
  // Programdaki `Rent::get()?.minimum_balance(0)` ile aynı sayı.
  const KIRA_TABANI = 890_880

  const kucukOdul = oku(/smallPrizeSol:\s*([\d.]+)/, 'smallPrizeSol')
  const buyukOdul = oku(/bigPrizeSol:\s*([\d.]+)/, 'bigPrizeSol')
  const buyukBps = oku(/bigPrizeBps:\s*(\d+)/, 'bigPrizeBps')
  const esik = oku(/vaultEasyThresholdSol:\s*([\d.]+)/, 'vaultEasyThresholdSol')
  const payBps = oku(/treasuryFeeBps:\s*(\d+)/, 'treasuryFeeBps')
  const zorBps = oku(/normalWinBps:\s*(\d+)/, 'normalWinBps')
  const kolayBps = oku(/easyWinBps:\s*(\d+)/, 'easyWinBps')
  const gecikme = oku(/revealDelaySlots:\s*(\d+)/, 'revealDelaySlots')

  const tiers = [...blok.matchAll(/\{\s*count:\s*(\d+),\s*priceSol:\s*([\d.]+)\s*\}/g)].map(
    (m) => ({ count: Number(m[1]), priceSol: Number(m[2]) }),
  )
  check('spin paketi sayısı > 0', tiers.length > 0, true)

  // --- programın initialize() require!'ları ---
  check('küçük ödül > 0', kucukOdul > 0, true)
  check('büyük ödül >= küçük ödül', buyukOdul >= kucukOdul, true)
  check('reveal gecikmesi > 0', gecikme > 0, true)
  for (const [ad, v] of [
    ['zor mod', zorBps], ['kolay mod', kolayBps], ['ev payı', payBps], ['büyük ödül', buyukBps],
  ]) {
    check(`${ad} bps <= 10000`, v <= 10000, true)
  }
  check('kolay mod zor moddan kolay', kolayBps >= zorBps, true)
  // Kolay mod eşiği, jackpot'u VE onun üstüne eklenen ev payını
  // karşılamalı; aksi halde eşiği geçmiş bir kasa, jackpot çıktığında ödülü
  // ödeyip payı ödeyemez ve tüm işlem geri alınır — oyuncu `pending`
  // durumunda sıkışır.
  const jackpotToplam = buyukOdul + (buyukOdul * payBps) / 10000
  check('kolay mod eşiği >= jackpot + ev payı', esik >= jackpotToplam, true)
  for (const t of tiers) {
    check(`paket (${t.count} spin) sayısı > 0`, t.count > 0, true)
    check(`paket (${t.count} spin) fiyatı > 0`, t.priceSol > 0, true)
  }

  // --- kira tabanı: hazineye giden HER tutar tabanın üstünde olmalı ---
  // Hazine cüzdanı zincirde henüz yoksa (0 lamport), ona kira tabanının
  // ALTINDA bir tutar göndermek işlemin TAMAMINI düşürür.
  const enUcuz = Math.min(...tiers.map((t) => t.priceSol))
  const enKucukPaketPayi = Math.floor((enUcuz * LAMPORT * payBps) / 10000)
  check(
    `en ucuz paketin (${enUcuz} SOL) hazine payı kira tabanının üstünde`,
    enKucukPaketPayi > KIRA_TABANI,
    true,
  )
  const enKucukOdulPayi = Math.floor((kucukOdul * LAMPORT * payBps) / 10000)
  check(
    `en küçük ödülün (${kucukOdul} SOL) hazine payı kira tabanının üstünde`,
    enKucukOdulPayi > KIRA_TABANI,
    true,
  )
  // Kasaya giren pay da aynı sebeple tabanın üstünde olmalı: kasa PDA'sı
  // ilk satın alımda yaratılıyor.
  const enKucukKasaPayi = Math.floor(enUcuz * LAMPORT) - enKucukPaketPayi
  check(
    `en ucuz paketin kasa payı kira tabanının üstünde`,
    enKucukKasaPayi > KIRA_TABANI,
    true,
  )

  // --- config.ts ile Rust sabitleri aynı mı ---
  const rust = readFileSync(
    new URL('../program/luck-game/programs/luck-game/src/lib.rs', import.meta.url),
    'utf8',
  )
  const rustSabit = (re, etiket) => {
    const m = rust.match(re)
    if (!m) throw new Error(`lib.rs içinde bulunamadı: ${etiket}`)
    return Number(m[1].replace(/_/g, ''))
  }
  check(
    'maxResolveWindowSlots = MAX_RESOLVE_WINDOW_SLOTS',
    oku(/maxResolveWindowSlots:\s*(\d+)/, 'maxResolveWindowSlots'),
    rustSabit(/const MAX_RESOLVE_WINDOW_SLOTS:\s*u64\s*=\s*([0-9_]+)/, 'MAX_RESOLVE_WINDOW_SLOTS'),
  )
  const spinTiersRust = rustSabit(/const SPIN_TIERS:\s*usize\s*=\s*([0-9_]+)/, 'SPIN_TIERS')
  check('spin paketi sayısı = SPIN_TIERS', tiers.length, spinTiersRust)
  // Delegenin gaz payı, kira tabanının ÜSTÜNE ekleniyor; sıfır olursa
  // delege hesabı yaratılır ama hiç işlem ücreti ödeyemez ve oyuncu
  // "ücretsiz" turlarını oynayamaz.
  check(
    'delege gaz payı > 0',
    rustSabit(/const DELEGATE_GAS_SPONSOR_LAMPORTS:\s*u64\s*=\s*([0-9_]+)/, 'DELEGATE_GAS') > 0,
    true,
  )

  // --- initialize.mjs varsayılanları config.ts ile aynı mı ---
  // Oyun zincirde bu betikle açılıyor. Varsayılanları config.ts'ten
  // kayarsa, site bir tarifeyi gösterir, zincir başka bir tarifeyi uygular
  // ve oyuncu ödediğinden farklı sayıda spin alır.
  const initSrc = readFileSync(
    new URL('../program/luck-game/scripts/initialize.mjs', import.meta.url),
    'utf8',
  )
  const dizi = (re, etiket) => {
    const m = initSrc.match(re)
    if (!m) throw new Error(`initialize.mjs içinde bulunamadı: ${etiket}`)
    return m[1].split(',').map((x) => Number(x.trim().replace(/_/g, ''))).filter((x) => !Number.isNaN(x))
  }
  check(
    'initialize.mjs paket adetleri = config.ts',
    dizi(/SPIN_TIER_COUNTS\s*=\s*\[([^\]]*)\]/, 'SPIN_TIER_COUNTS').join(','),
    tiers.map((t) => t.count).join(','),
  )
  check(
    'initialize.mjs paket fiyatları = config.ts',
    dizi(/SPIN_TIER_PRICES_SOL\s*=\s*\[([^\]]*)\]/, 'SPIN_TIER_PRICES_SOL').join(','),
    tiers.map((t) => t.priceSol).join(','),
  )
}

// --- Sonuç -------------------------------------------------------------------
for (const c of checks) {
  const mark = c.ok ? '✓' : '✗'
  const detail = c.ok ? '' : `  (beklenen ${c.expected}, gelen ${c.actual})`
  console.log(`${mark} ${c.name}${detail}`)
}

if (fails.length > 0) {
  console.error(`\n${fails.length} TUTARSIZLIK bulundu — derleme durduruluyor.`)
  process.exit(1)
}
console.log(`\n${checks.length} kontrolün hepsi geçti.`)
