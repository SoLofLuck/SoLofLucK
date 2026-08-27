#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TGE kılavuzu denetimi — belgedeki komutlar hâlâ var mı
// ---------------------------------------------------------------------------
// Belge çürümesi sessizdir: bir script yeniden adlandırılır, bir npm
// betiği kaldırılır, kılavuz olduğu gibi kalır. Sorun ancak TGE günü,
// komut "not found" verdiğinde ortaya çıkar — yani tam olarak yanlış
// zamanda.
//
// Bu denetim kılavuzdaki her `npm run X` ve `node scripts/X.mjs`
// referansının gerçekten var olduğunu doğruluyor. Komutların DOĞRU
// çalıştığını değil (o testlerin işi), var olduğunu.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const kok = fileURLToPath(new URL('..', import.meta.url))

// İki belge de komut ve dosya referansı taşıyor; ikisi de çürüyebilir.
const belgeler = ['TGE-KILAVUZU.md', 'GUVENLIK.md']
let kilavuz = ''
for (const ad of belgeler) {
  const yol = `${kok}${ad}`
  if (!existsSync(yol)) {
    console.error(`${ad} bulunamadı.`)
    process.exit(1)
  }
  kilavuz += readFileSync(yol, 'utf8') + '\n'
}
const paket = JSON.parse(readFileSync(`${kok}package.json`, 'utf8'))

const hatalar = []
const kontroller = []

// npm run <ad>
const npmAdlari = new Set(
  [...kilavuz.matchAll(/npm run ([a-z0-9:-]+)/g)].map((m) => m[1]),
)
for (const ad of npmAdlari) {
  const var_ = Object.hasOwn(paket.scripts ?? {}, ad)
  kontroller.push({ ad: `npm run ${ad}`, ok: var_ })
  if (!var_) hatalar.push(`npm run ${ad}`)
}

// node <yol>.mjs
const yollar = new Set(
  [...kilavuz.matchAll(/node ((?:scripts|program)\/[^\s\\`]+\.mjs)/g)].map((m) => m[1]),
)
for (const yol of yollar) {
  const var_ = existsSync(`${kok}${yol}`)
  kontroller.push({ ad: `node ${yol}`, ok: var_ })
  if (!var_) hatalar.push(yol)
}

// Kılavuzda adı geçen config alanları gerçekten config.ts'te mi?
const src = readFileSync(`${kok}src/config.ts`, 'utf8')
for (const alan of ['PRESALE_START_ISO', 'LUCK_TOKEN', 'CLAIM_CONFIG', 'DEFAULT_NETWORK', 'DEFAULT_DECIMALS']) {
  if (!kilavuz.includes(alan)) continue
  const var_ = src.includes(alan)
  kontroller.push({ ad: `config.ts: ${alan}`, ok: var_ })
  if (!var_) hatalar.push(alan)
}

// --- GUVENLIK.md'deki sayılar hâlâ doğru mu -------------------------------
//
// Belgede "luck-game 29 test", "177 kontrol" gibi somut sayılar var ve
// bunlar dışarıya bir güvence olarak sunuluyor. Yanlış bir sayı yayınlamak,
// hiç sayı yayınlamamaktan kötü: okuyan kişi belgenin geri kalanına da
// güvenmeyi bırakır.
//
// Sayılar kaynaktan SAYILARAK doğrulanıyor; elle yazılmış bir kopyayla
// karşılaştırılmıyor (o, kopyanın kendisiyle uyuştuğunu kanıtlardı).
{
  const guvenlik = readFileSync(`${kok}GUVENLIK.md`, 'utf8')

  const testSay = (dizin) => {
    let n = 0
    for (const dosya of readdirSync(dizin)) {
      if (!dosya.endsWith('.rs')) continue
      const src = readFileSync(`${dizin}/${dosya}`, 'utf8')
      n += (src.match(/#\[(?:tokio::)?test\]/g) ?? []).length
    }
    return n
  }
  const oyunTest = testSay(`${kok}program/luck-game/programs/luck-game/tests`)
  const dagiticiTest = testSay(
    `${kok}program/luck-distributor/programs/luck-distributor/tests`,
  )

  const sayi = (re, etiket) => {
    const m = guvenlik.match(re)
    if (!m) {
      hatalar.push(etiket)
      kontroller.push({ ad: `GUVENLIK.md: ${etiket} satırı bulunamadı`, ok: false })
      return null
    }
    return Number(m[1])
  }

  const belgeOyun = sayi(/luck-game (\d+),/, 'luck-game test sayısı')
  const belgeDagitici = sayi(/luck-distributor (\d+) test/, 'luck-distributor test sayısı')
  const belgeTohum = sayi(/(\d+) tohum × \d+ rastgele adım/, 'kaos tohum sayısı')

  // Kaos tohumları: adı geçen testler + kaos_ek_tohumlar dizisi.
  const kaosSrc = readFileSync(
    `${kok}program/luck-game/programs/luck-game/tests/chaos.rs`,
    'utf8',
  )
  const tekTohum = (kaosSrc.match(/kaos_kos\(0x[0-9A-Fa-f_]+,/g) ?? []).length
  const dizi = kaosSrc.match(/for tohum in \[([^\]]*)\]/)
  const diziTohum = dizi ? dizi[1].split(',').filter((x) => x.trim()).length : 0

  const karsilastir = (ad, belgedeki, gercek) => {
    if (belgedeki === null) return
    const ok = belgedeki === gercek
    kontroller.push({ ad: `GUVENLIK.md: ${ad} (${belgedeki})`, ok })
    if (!ok) hatalar.push(`${ad}: belgede ${belgedeki}, gerçekte ${gercek}`)
  }
  karsilastir('luck-game test sayısı', belgeOyun, oyunTest)
  karsilastir('luck-distributor test sayısı', belgeDagitici, dagiticiTest)
  karsilastir('kaos tohum sayısı', belgeTohum, tekTohum + diziTohum)

  // Denetim sayıları: ilgili script'ler çalıştırılıp çıktıdan okunuyor.
  for (const [etiket, komut, re] of [
    ['ABI kontrol sayısı', 'check:abi', /\| ABI denetimi \| (\d+) kontrol/],
    ['tokenomics kontrol sayısı', 'check:tokenomics', /\| Tokenomics denetimi \| (\d+) kontrol/],
  ]) {
    const belgedeki = sayi(re, etiket)
    if (belgedeki === null) continue
    let gercek = null
    try {
      const cikti = execFileSync('npm', ['run', '--silent', komut], {
        cwd: kok,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const m = cikti.match(/^(\d+) kontrolün/m)
      gercek = m ? Number(m[1]) : null
    } catch {
      gercek = null
    }
    if (gercek === null) {
      kontroller.push({ ad: `GUVENLIK.md: ${etiket} — ${komut} okunamadı`, ok: false })
      hatalar.push(etiket)
    } else {
      karsilastir(etiket, belgedeki, gercek)
    }
  }
}

for (const c of kontroller) console.log(`${c.ok ? '✓' : '✗'} ${c.ad}`)

if (hatalar.length > 0) {
  console.error(
    `\n${hatalar.length} tutarsızlık: belgede yazan ile projedeki farklı.\n` +
      hatalar.map((h) => `  - ${h}`).join('\n') +
      '\nBelge çürümüş — TGE günü bu komutlar çalışmayacak ya da ' +
      'yayınlanan sayılar yanlış olacak.',
  )
  process.exit(1)
}
console.log(`\n${kontroller.length} referansın hepsi yerinde.`)
