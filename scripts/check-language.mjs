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
//
// False positives are handled by the allow-list below, and every entry there
// has to state WHY — a silent exception makes the whole check worthless.
//
// Usage:
//   node scripts/check-language.mjs              scan the whole repository
//   node scripts/check-language.mjs src/lib      scan only those paths
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

// Optional path filters (repo-relative), for checking one file or directory.
const filters = process.argv.slice(2).map((p) => p.replace(/^\.\//, '').replace(/\/+$/, ''))
const matchesFilter = (relPath) =>
  filters.length === 0 || filters.some((f) => relPath === f || relPath.startsWith(`${f}/`))

const findings = []
for (const file of walk(root)) {
  const rel = relative(root, file)
  if (isAllowed(rel)) continue
  if (!matchesFilter(rel)) continue
  const lines = readFileSync(file, 'utf8').split('\n')
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
