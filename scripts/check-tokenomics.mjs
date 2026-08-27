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
