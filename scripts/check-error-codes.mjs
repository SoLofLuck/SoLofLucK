#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Hata kodu denetimi — arayüzdeki mesajlar doğru hataya mı bağlı
// ---------------------------------------------------------------------------
// Arayüz, zincirden gelen ham hataları kullanıcıya anlaşılır mesajlara
// çeviriyor ve bunu hata KODUNA bakarak yapıyor (ör. 0x1776 =
// NoSpinsRemaining). Kodlar Anchor'da enum SIRASINDAN türüyor:
// 6000 + varyantın sırası.
//
// Yani enum'a ortadan bir varyant eklenirse ondan sonraki HER kod kayar ve
// arayüz sessizce YANLIŞ mesajı gösterir: "spin hakkın kalmadı" derken
// aslında "sonuç açma süresi doldu" olur. Kod çalışmaya devam ettiği için
// bunu ancak kullanıcı şikâyetinden öğrenirdik.
//
// Bu denetim, arayüzdeki her `/Ad|0xNNNN/` çiftini programdaki enum
// sırasıyla karşılaştırıyor.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const kok = fileURLToPath(new URL('..', import.meta.url))
const ANCHOR_ERROR_OFFSET = 6000

function enumKodlari(dosya, enumAdi) {
  const src = readFileSync(dosya, 'utf8')
  const bas = src.indexOf(`pub enum ${enumAdi} {`)
  if (bas === -1) throw new Error(`${enumAdi} bulunamadı: ${dosya}`)
  const son = src.indexOf('\n}', bas)
  const govde = src.slice(bas, son)
  const varyantlar = [...govde.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/gm)].map((m) => m[1])
  const kodlar = new Map()
  varyantlar.forEach((ad, i) => kodlar.set(ad, ANCHOR_ERROR_OFFSET + i))
  return kodlar
}

const hatalar = []
const kontroller = []

function denetle(arayuzDosyasi, programDosyasi, enumAdi) {
  const kodlar = enumKodlari(`${kok}${programDosyasi}`, enumAdi)
  const arayuz = readFileSync(`${kok}${arayuzDosyasi}`, 'utf8')
  // `/Ad|0xNNNN/i` biçimindeki eşleşmeler.
  const ciftler = [...arayuz.matchAll(/\/([A-Z][A-Za-z0-9]*)\|(0x[0-9a-fA-F]+)\/i/g)]
  if (ciftler.length === 0) {
    hatalar.push(`${arayuzDosyasi}: hiç hata kodu eşleşmesi bulunamadı — desen değişmiş olabilir`)
    return
  }
  for (const [, ad, hex] of ciftler) {
    const beklenen = kodlar.get(ad)
    const gercek = parseInt(hex, 16)
    if (beklenen === undefined) {
      hatalar.push(`${arayuzDosyasi}: "${ad}" ${enumAdi} içinde yok`)
      kontroller.push({ ad: `${ad} enum'da var`, ok: false })
      continue
    }
    const ok = beklenen === gercek
    kontroller.push({
      ad: `${ad} = ${hex} (${gercek})`,
      ok,
      detay: ok ? '' : `enum sırasına göre ${beklenen} (0x${beklenen.toString(16)}) olmalı`,
    })
    if (!ok) hatalar.push(ad)
  }
}

denetle(
  'src/components/solofluck/GameTab.tsx',
  'program/luck-game/programs/luck-game/src/lib.rs',
  'GameError',
)

for (const c of kontroller) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.ad}${c.detay ? `  — ${c.detay}` : ''}`)
}

if (hatalar.length > 0) {
  console.error(
    `\n${hatalar.length} hata kodu uyuşmuyor. Arayüz, zincirden gelen hatayı YANLIŞ ` +
      'mesaja çevirir — kod çalışmaya devam eder ve bunu ancak kullanıcı şikâyetinden öğreniriz.',
  )
  process.exit(1)
}
console.log(`\n${kontroller.length} hata kodunun hepsi enum sırasıyla tutuyor.`)
