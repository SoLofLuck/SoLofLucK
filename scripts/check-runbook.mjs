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

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const kok = fileURLToPath(new URL('..', import.meta.url))
const kilavuzYolu = `${kok}TGE-KILAVUZU.md`

if (!existsSync(kilavuzYolu)) {
  console.error('TGE-KILAVUZU.md bulunamadı.')
  process.exit(1)
}

const kilavuz = readFileSync(kilavuzYolu, 'utf8')
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

for (const c of kontroller) console.log(`${c.ok ? '✓' : '✗'} ${c.ad}`)

if (hatalar.length > 0) {
  console.error(
    `\n${hatalar.length} referans kılavuzda var ama projede YOK. Kılavuz ` +
      'çürümüş — TGE günü bu komutlar çalışmayacak.',
  )
  process.exit(1)
}
console.log(`\n${kontroller.length} referansın hepsi yerinde.`)
