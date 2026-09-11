#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Language gate: the repository must contain no Turkish
// ---------------------------------------------------------------------------
// The project is a public, international token launch. Everything a reader
// can encounter — UI copy, warnings, error messages, code comments,
// identifiers, documentation, CI step names — has to be in English, so that
// anyone reviewing the code or using the site can follow it.
//
// "No Turkish is left" is a claim that must be MEASURABLE, not something
// verified by eyeballing 95 files. This check makes it a build gate:
//
//   1. Turkish-specific letters (ğ ü ş ı ö ç and their capitals). This is the
//      strongest signal and catches almost everything.
//   2. Common Turkish words that survive without those letters ("kontrol",
//      "hata", "sonuc"...). Without this list, ASCII-only Turkish would slip
//      through.
//   3. Turkish locales (`toLocaleString('tr-TR')`), which contain no Turkish
//      word at all yet render every number the Turkish way for the reader.
//
// Rules 1-3 are the HARD GATE. A word list is reactive by nature, though: it
// only ever knows the words somebody already found. Five separate sweeps of
// this repository each turned up remnants the list at the time did not have —
// "Token Bilgileri" was a heading on the Create Token page, and "Adresi
// kopyala" an aria-label invisible even in a screenshot.
//
// So `--deep` adds a rule that needs no list: it pulls every comment and string
// literal out and reports the ones containing no common English word. That is a
// HEURISTIC — it flags code fragments and CSS class names too, so it is not a
// build gate; it is the sweep to run when you want to go looking rather than
// wait to be told.
//
// False positives are handled by the allow-list below, and every entry there
// has to state WHY — a silent exception makes the whole check worthless.
//
// Usage:
//   node scripts/check-language.mjs              scan the whole repository
//   node scripts/check-language.mjs src/lib      scan only those paths
//   node scripts/check-language.mjs --deep       also run the list-free sweep
//
// The filtered form exists because the full report is truncated to keep it
// readable, so grepping it for one file can wrongly look clean. When paths are
// given, every finding under them is printed.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'target', '.claude', 'coverage'])
const SCANNED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mjs', '.js', '.rs', '.md', '.yml', '.yaml',
  '.json', '.html', '.css', '.toml',
])
// Extensionless dotfiles carry comments too, and the extension list alone
// skipped them silently — .gitignore held a Turkish comment for exactly that
// reason.
const SCANNED_NAMES = new Set(['.gitignore', '.gitattributes', '.npmrc', '.nvmrc', 'Dockerfile', 'Makefile'])

// Turkish-specific letters.
const TURKISH_LETTERS = /[ğüşıöçĞÜŞİÖÇ]/

// Turkish words that contain no Turkish-specific letter, so the letter test
// alone would miss them. Matched as whole words, case-insensitively.
const TURKISH_WORDS = [
  'kontrol', 'hata', 'hatalar', 'sonuc', 'sonuclar', 'test edildi',
  'dosya', 'deger', 'degerler', 'adres', 'adresler', 'bakiye', 'cuzdan',
  'islem', 'islemler', 'zincir', 'kasa', 'odul', 'oyuncu', 'oyun',
  'katkida', 'katilim', 'toplam', 'gerekli', 'gerekiyor', 'olmali',
  'yapilir', 'yapilan', 'calisir', 'calismiyor', 'baslangic', 'bitis',
  'kaynak', 'ornek', 'yeni', 'eski', 'once', 'sonra', 'icin', 've',
  'veya', 'ama', 'ancak', 'cunku', 'yani', 'ile', 'olarak', 'kadar',
  'sadece', 'yalnizca', 'her', 'hic', 'bir', 'bu', 'su', 'o',
  // A second pass added after the first "everything is English" claim turned
  // out to be wrong: these are ASCII-only Turkish words that the letter test
  // and the list above both missed, found by sweeping the repository by hand.
  // Every one of them was a real remnant somewhere.
  'kazanan', 'kazananlar', 'kazanma', 'oynama', 'kaydet', 'kayit',
  'bozuldu', 'sembol', 'gizli', 'imza', 'imzalar', 'imzalayan', 'miktar',
  'hesap', 'hesaplar', 'hesaplama', 'durum', 'durumu', 'bilet', 'biletler',
  'kilit', 'kilidi', 'kilitli', 'havuz', 'havuzu', 'likidite', 'saat',
  'dakika', 'saniye', 'tutar', 'sahte', 'olamaz', 'karakterden',
  'transferi', 'prova', 'kontrat', 'rezerv', 'rezervler', 'anahtar',
  'kural', 'kurallar', 'adim', 'adimlar', 'paket', 'paketi', 'paketler',
  'zorunlu', 'varsayilan', 'liste', 'listesi', 'uyari', 'baslik',
  'tarih', 'zaman', 'ayar', 'ayarlar', 'sayfa', 'iptal', 'burada',
  'neden', 'hangi', 'katki', 'katkilar', 'oran', 'orani',
  // A third pass. Same lesson again: each sweep with a wider list found more.
  'geri', 'bozuk', 'beklenen', 'eksik', 'fazla', 'takvim', 'kabul',
  'mimari', 'mimarisi', 'tohum', 'sabit', 'atlanan', 'olan', 'olmayan',
  'degildir', 'gerekir', 'edildi', 'edilir', 'yapildi', 'basarili',
  'basarisiz', 'gecerli', 'gecersiz', 'hazir', 'dolu', 'tum', 'diger',
  'baska', 'ayni', 'farkli', 'kendi', 'kendisi', 'uzerinde', 'altinda',
  'icinde', 'arasinda', 'boyunca', 'sirasinda', 'yukleniyor',
  'bekleniyor', 'gonderildi', 'tamamlandi', 'secildi', 'alindi',
  'verildi', 'kazandi', 'kaybetti', 'oynadi', 'karakter',
  // A fourth pass, this one found by RENDERING the site and reading the text a
  // visitor actually sees: "Token Bilgileri" was a heading on the Create Token
  // page the whole time, and no static list had it.
  'bilgi', 'bilgiler', 'bilgileri', 'detay', 'detaylar', 'aciklama',
  'secenek', 'secenekler', 'islemler', 'ozet', 'baglanti', 'goster',
  'gizle', 'kapat', 'devam', 'vazgec', 'onayla', 'sec', 'gonder',
  // A fifth pass, from extracting every string literal and JSX text node in
  // src/ and flagging the ones containing no common English word:
  // "Adresi kopyala" (an aria-label, so invisible even in a screenshot) and
  // "createImageBitmap desteklenmiyor." were the last two.
  'adresi', 'kopyala', 'desteklenmiyor', 'destekleniyor', 'bulunamadi',
  'yuklenemedi', 'okunamadi', 'yazilamadi', 'olusturulamadi', 'silinemedi',
  // A sixth pass. Two remnants survived all five: "yolu" dangling at the end
  // of an otherwise English sentence on the Lock Liquidity page, and "gelen"
  // in the line every failing ABI check printed. Neither had a Turkish letter
  // and neither word was listed, so both files scanned clean for months. The
  // lesson each pass repeats: a single Turkish word inside an English sentence
  // is invisible to a letter test AND to the deep sweep, which only flags
  // paragraphs with no English in them at all. Only the list catches those, so
  // the list has to keep growing.
  'yol', 'yolu', 'yollar', 'gelen', 'giden', 'sayi', 'sayisi', 'tane',
  'boyut', 'boyutu', 'uzun', 'kisa', 'buyuk', 'kucuk', 'yuksek', 'dusuk',
  'artis', 'azalis', 'fiyat', 'fiyati', 'satis', 'carpan', 'kar', 'zarar',
  'yatirim', 'ucret', 'komisyon', 'guncel', 'guncelleme', 'simdi',
  'gunluk', 'haftalik', 'aylik', 'ilk', 'kez', 'defa', 'asagida',
  'yukarida', 'soldan', 'sagdan', 'ortalama', 'toplami', 'birim',
]

// Turkish LOCALES. `toLocaleString('tr-TR')` contains no Turkish word at all,
// but it renders every number on the site in Turkish notation ("1.234,56"). It
// is Turkish that the reader sees and no word list would ever catch it, so it
// is matched as a pattern of its own.
const TURKISH_LOCALES = /\btr-TR\b|\btr_TR\b|lang\s*=\s*["']tr["']/
// Very short words ("ve", "bir", "bu", "o") collide with English and other
// languages, so they are matched only when they appear alongside a longer
// Turkish word on the same line — handled below.
const SHORT_WORDS = new Set(['ve', 'veya', 'ama', 'ile', 'her', 'hic', 'bir', 'bu', 'su', 'o', 'once', 'sonra', 'yeni', 'eski'])
const STRONG_WORDS = TURKISH_WORDS.filter((w) => !SHORT_WORDS.has(w))

// Allow-list. Every entry states WHY it is allowed.
const ALLOWED = [
  {
    // This file itself lists Turkish words in order to detect them.
    path: 'scripts/check-language.mjs',
    why: 'the detector has to contain the words it looks for',
  },
  {
    path: 'package-lock.json',
    why: 'generated by npm; not authored text',
  },
]

function isAllowed(relPath) {
  return ALLOWED.some((a) => relPath === a.path)
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (SCANNED_EXTENSIONS.has(extname(name)) || SCANNED_NAMES.has(name)) out.push(full)
  }
  return out
}

// The list-free sweep (--deep). A line of prose in English almost always
// contains at least one of these; a line of prose in Turkish contains none.
const COMMON_ENGLISH = new Set(`the a an and or but if then else of to in on at by for with from into
over under is are was were be been being do does did done have has had can could will would shall
should may might must not no yes this that these those it its you your we our they their them us as
so than too very just only also more most less least much many few all some any each every other
another same different new old first last next previous back up down out off about after before
during while until since between within without across through against toward per via when where
what which who why how here there because though although however than instead rather once already
still yet even ever never always often sometimes again both either neither such own upon
click enter select choose send receive create make set get put add remove delete update change
open close start stop run wait retry copy paste show hide sign signed connect connected disconnect
wallet wallets token tokens amount amounts balance address addresses transaction transactions
fee fees pool pools liquidity supply mint burn lock locked unlock claim claimed presale raffle
ticket tickets prize prizes spin spins game play player players win wins won lose lost
error errors failed fails success ok cancel confirm try please note warning warnings info required
optional name symbol decimals description logo website twitter telegram image file link url
page tab tabs solana devnet mainnet phantom solflare raydium streamflow pinata ipfs metadata authority
day days week weeks month months hour hours minute minutes second seconds time date
total left remaining available used spent paid free bonus small big jackpot house share shares
program programs account accounts vault treasury owner delegate signer slot hash block chain
number count list lists item items row rows value values data field fields form input output
loading ready pending active inactive enabled disabled valid invalid empty full check checks
node scripts test tests build deploy version file files config script npm cargo run runs
tge claim vesting merkle proof root leaf schedule unlocks buyer buyers winner winners`
  .split(/\s+/).filter(Boolean))

// Lines that are code rather than prose produce noise, so they are skipped.
const looksLikeCode = (text) =>
  /[{}();=<>[\]|&]|=>|::|\.\w+\(|^\W*$/.test(text) || /^[\w./#@:-]+$/.test(text)

function deepScan(rel, lines) {
  const out = []
  lines.forEach((line, i) => {
    const pieces = []
    const comment = line.match(/(?:\/\/|#|\/\*|\*)\s*(.+)$/)
    if (comment) pieces.push(comment[1])
    for (const m of line.matchAll(/'([^'\\\n]{8,})'|"([^"\\\n]{8,})"/g)) {
      pieces.push(m[1] ?? m[2])
    }
    for (const m of line.matchAll(/>([^<>{}\n]{8,})</g)) pieces.push(m[1])
    for (const raw of pieces) {
      const text = raw.trim()
      if (!text || looksLikeCode(text)) continue
      const words = text.toLowerCase().match(/[a-z]{2,}/g) ?? []
      if (words.length < 4) continue
      if (words.some((w) => COMMON_ENGLISH.has(w))) continue
      out.push({ file: rel, line: i + 1, text: text.slice(0, 100), why: 'no common English word' })
    }
  })
  return out
}

// Optional path filters (repo-relative), for checking one file or directory.
const argv = process.argv.slice(2)
const deep = argv.includes('--deep')
const filters = argv.filter((a) => a !== '--deep').map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''))
const matchesFilter = (relPath) =>
  filters.length === 0 || filters.some((f) => relPath === f || relPath.startsWith(`${f}/`))

const findings = []
for (const file of walk(root)) {
  const rel = relative(root, file)
  if (isAllowed(rel)) continue
  if (!matchesFilter(rel)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  if (deep) findings.push(...deepScan(rel, lines))
  lines.forEach((line, i) => {
    const hits = []
    if (TURKISH_LETTERS.test(line)) hits.push('Turkish letters')
    if (TURKISH_LOCALES.test(line)) hits.push('Turkish locale')
    for (const word of STRONG_WORDS) {
      if (new RegExp(`\\b${word}\\b`, 'i').test(line)) {
        hits.push(`word "${word}"`)
        break
      }
    }
    if (hits.length) {
      findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 100), why: hits[0] })
    }
  })
}

if (findings.length === 0) {
  console.log(
    filters.length === 0
      ? 'No Turkish found. Every scanned file is English-only.'
      : `No Turkish found under: ${filters.join(', ')}`,
  )
  process.exit(0)
}

// Group by file so the report is readable when there is a lot left.
const byFile = new Map()
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, [])
  byFile.get(f.file).push(f)
}
const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)

// Filtered runs print every finding; a full-repo run is truncated so the report
// stays readable while a lot is still outstanding.
const fileLimit = filters.length > 0 ? sorted.length : 40
const lineLimit = filters.length > 0 ? Infinity : 2

console.error(`Turkish found in ${byFile.size} file(s), ${findings.length} line(s):\n`)
for (const [file, list] of sorted.slice(0, fileLimit)) {
  console.error(`  ${String(list.length).padStart(5)}  ${file}`)
  for (const f of list.slice(0, lineLimit)) {
    console.error(`         line ${f.line} (${f.why}): ${f.text}`)
  }
}
if (sorted.length > fileLimit) console.error(`  ... and ${sorted.length - fileLimit} more file(s)`)
console.error('\nEverything in this repository must be in English.')
process.exit(1)
