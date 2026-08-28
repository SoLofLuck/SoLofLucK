#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Yayına hazırlık denetimi
// ---------------------------------------------------------------------------
// "Kod doğru" ile "yayına hazır" aynı şey değil. Bazı alanlar bilerek boş
// bırakıldı ve doldurulmadan yayına çıkmak sessiz sonuçlar doğuruyor —
// hata vermiyor, sadece yanlış davranıyor:
//
//   PRESALE_START_ISO boşsa presale SÜRESİZ açık kalıyor. Takvim
//   ilan edilmemiş sayıldığı için ne geri sayım görünüyor ne de zamanı
//   gelince kapanıyor.
//
//   LUCK_TOKEN.mint boşsa Claim sekmesi "dağıtım başlamadı" diyor ve
//   hiçbir buton çalışmıyor — TGE günü herkesin gördüğü şey bu olurdu.
//
// Bu denetim BİLEREK derlemeyi düşürmüyor: alanların çoğu geliştirme
// sırasında boş olmak ZORUNDA. `--strict` ile çalıştırıldığında ise
// yayın kapısı gibi davranıyor.
//
// Kullanım:
//   node scripts/check-launch-readiness.mjs           # rapor
//   node scripts/check-launch-readiness.mjs --strict  # eksik varsa düşer

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const kok = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(`${kok}src/config.ts`, 'utf8')
const strict = process.argv.includes('--strict')

const oku = (re) => {
  const m = src.match(re)
  return m ? m[1] : ''
}

const maddeler = []
const madde = (ad, deger, aciklama) =>
  maddeler.push({ ad, hazir: Boolean(deger), deger, aciklama })

madde(
  '$LUCK mint adresi',
  oku(/export const LUCK_TOKEN = \{[\s\S]*?mint: '([^']*)'/),
  'Boşken Claim sekmesi "dağıtım henüz başlamadı" der ve hiçbir buton çalışmaz.',
)
madde(
  'Presale başlangıç tarihi',
  oku(/export const PRESALE_START_ISO\s*=\s*'([^']*)'/),
  'Boşken presale SÜRESİZ açık kalır: geri sayım görünmez ve zamanı gelince kapanmaz.',
)
madde(
  'Claim programı',
  oku(/export const CLAIM_CONFIG = \{[\s\S]*?programId: '([^']*)'/),
  'Boşken kimse payını çekemez.',
)
madde(
  'Oyun programı',
  oku(/export const GAME_CONFIG[\s\S]*?programId: '([^']*)'/),
  'Boşken Oyun sekmesi kapalı kalır.',
)
madde(
  'Presale cüzdanı',
  oku(/export const PRESALE_WALLET\s*=\s*'([^']*)'/),
  'Boşken presale gönderim butonları devre dışı.',
)

// Sosyal bağlantılar: eksikse yalnızca footer'da o bağlantı görünmüyor.
// Yayın engeli değil ama "proje terk edilmiş" izlenimi veriyor.
const sosyal = ['twitter', 'telegram', 'discord'].map((k) => ({
  k,
  v: oku(new RegExp(`${k}: '([^']*)'`)),
}))
for (const s of sosyal) {
  madde(
    `Sosyal bağlantı: ${s.k}`,
    s.v,
    'Yayın engeli değil; eksikse footer\'da o bağlantı hiç görünmüyor.',
  )
}

// Merkle dosyaları: hangi turlar yayınlanmış?
const merkleDizin = `${kok}public/merkle`
const turlar = existsSync(merkleDizin)
  ? readdirSync(merkleDizin).filter((f) => /^round-\d+\.json$/.test(f))
  : []
maddeler.push({
  ad: 'Yayınlanan dağıtım listeleri',
  hazir: turlar.length > 0,
  deger: turlar.length ? turlar.join(', ') : '',
  aciklama:
    'TGE günü en az presale turu (round-0.json) yayınlanmış olmalı; Claim ' +
    'sekmesi listeyi buradan okuyor ve kökü zincirdekiyle karşılaştırıyor.',
})

// Ağ: mainnet'e geçildi mi?
const varsayilanAg = oku(/export const DEFAULT_NETWORK[^=]*=\s*'([^']+)'/)
maddeler.push({
  ad: 'Varsayılan ağ',
  hazir: varsayilanAg === 'mainnet',
  deger: varsayilanAg,
  aciklama: 'Yayında mainnet olmalı. Devnet\'te kalırsa kimse gerçek katkı yapamaz.',
})

// --- "Stay Tuned" kapısı kaldırıldı mı --------------------------------------
//
// Site test aşamasındayken kök adrese gelen HERKESE düz siyah bir "yakında"
// sayfası gösteriliyor; gerçek uygulama yalnızca PREVIEW_ACCESS_PATH
// üzerinden açılıyor (bkz. src/main.tsx).
//
// Bu, yayın günü unutulmaya en müsait maddelerden biri ve unutulursa sonucu
// tam bir felaket: presale açılır, duyuru yapılır, gelen herkes BOŞ SİYAH
// EKRAN görür. Hiçbir hata çıkmaz, hiçbir log yazılmaz — site "çalışıyor"
// görünür.
//
// Kapının kaldırılması PREVIEW_ACCESS_PATH'i boş string yapmak demek;
// main.tsx boş yolda uygulamayı doğrudan açıyor.
{
  const m = src.match(/export const PREVIEW_ACCESS_PATH\s*=\s*'([^']*)'/)
  const yol = m ? m[1] : null
  maddeler.push({
    ad: '"Yakında" kapısı kaldırıldı',
    hazir: yol === '',
    deger: yol === null ? 'okunamadı' : yol === '' ? 'kapalı' : `gizli yol ${yol}`,
    aciklama:
      'Kapı açıkken siteye gelen HERKES boş siyah "Stay Tuned" ekranı görür. ' +
      'Yayın günü unutulursa hiçbir hata çıkmaz, site çalışıyor görünür ama ' +
      'kimse presale sayfasına ulaşamaz. Kaldırmak için ' +
      "PREVIEW_ACCESS_PATH = '' yapın.",
  })
}

const eksikler = maddeler.filter((m) => !m.hazir)

console.log('YAYINA HAZIRLIK\n')
for (const m of maddeler) {
  const isaret = m.hazir ? '✓' : '○'
  // Mevcut değeri hazır olmasa da gösteriyoruz: "○ Varsayılan ağ" tek
  // başına eksik mi yanlış mı olduğunu söylemiyor, "○ Varsayılan ağ
  // (şu an: devnet)" söylüyor.
  const deger = m.deger ? (m.hazir ? ` — ${m.deger}` : ` (şu an: ${m.deger})`) : ''
  console.log(`${isaret} ${m.ad}${deger}`)
  if (!m.hazir) console.log(`    ${m.aciklama}`)
}

console.log(`\n${maddeler.length - eksikler.length}/${maddeler.length} hazır.`)
if (eksikler.length > 0 && strict) {
  console.error(`\n${eksikler.length} madde eksik — yayına çıkılamaz.`)
  process.exit(1)
}
if (eksikler.length > 0) {
  console.log('(Bu denetim derlemeyi düşürmüyor. Yayın kapısı için --strict kullanın.)')
}
