#!/usr/bin/env node
// ---------------------------------------------------------------------------
// İşlem gönderme yolu denetimi
// ---------------------------------------------------------------------------
// Sitedeki her zincir işlemi ortak, sertleştirilmiş yoldan (sendTx.ts →
// sendInstructions) geçmeli. Düz bir
// `getLatestBlockhash → sign → sendRawTransaction → confirmTransaction`
// dizisi mobil cüzdan + paylaşımlı RPC koşullarında güvenilir değil ve en
// kötü sonucu para kaybı değil ÇİFT ÖDEME:
//
//   confirmTransaction bir websocket aboneliği açıyor. Mobilde cüzdan onayı
//   için uygulama değiştirilince tarayıcı sayfayı arka plana alıyor ve
//   abonelik sessizce kopuyor. Bildirim hiç gelmediği için işlem ZİNCİRE
//   YAZILMIŞ olsa bile hata görünüyor. Kullanıcının yapacağı ilk şey tekrar
//   göndermek.
//
// Bu tam olarak yaşandı (önce yakma akışında, sonra presale'de). sendTx.ts
// o yüzden yazıldı — ama yazılmış olması, sonradan eklenen bir akışın onu
// kullanacağını garanti etmiyor. Bu denetim garantiyi veriyor.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../src', import.meta.url))

// Ortak yolu KURAN dosya ve gerekçeli istisnalar.
const MUAF = new Map([
  ['lib/sendTx.ts', 'ortak yolun kendisi'],
  [
    'lib/localTestWallet.ts',
    'yalnızca devnet airdrop onayı — kullanıcı parası taşımıyor ve airdrop ' +
      'tekrarlanırsa çift ödeme oluşmuyor',
  ],
])

const YASAK = [
  { desen: /\.sendRawTransaction\s*\(/, ad: 'sendRawTransaction' },
  { desen: /\.confirmTransaction\s*\(/, ad: 'confirmTransaction' },
]

function* dosyalar(dizin) {
  for (const ad of readdirSync(dizin)) {
    const yol = join(dizin, ad)
    if (statSync(yol).isDirectory()) yield* dosyalar(yol)
    else if (/\.(ts|tsx)$/.test(ad)) yield yol
  }
}

const bulgular = []
const satirMuafiyetleri = []
let taranan = 0

for (const yol of dosyalar(src)) {
  const goreli = yol.slice(src.length + 1)
  if (MUAF.has(goreli)) continue
  taranan++
  const satirlar = readFileSync(yol, 'utf8').split('\n')
  for (let i = 0; i < satirlar.length; i++) {
    const satir = satirlar[i]
    // Yorum satırlarını atlıyoruz: bu dosyalarda düzeltmenin GEREKÇESİ
    // yorumlarda anlatılıyor ve o yorumlar yasak isimleri içeriyor.
    if (/^\s*(\/\/|\*|\/\*)/.test(satir)) continue
    for (const { desen, ad } of YASAK) {
      if (!desen.test(satir)) continue
      // Satır düzeyinde, GEREKÇELİ istisna. Dosyanın tamamını muaf tutmak
      // yerine tek satırı muaf tutuyoruz ki aynı dosyaya sonradan eklenen
      // bir akış yine yakalansın.
      //
      // İşaret, hemen ÖNCEKİ kesintisiz yorum bloğunda aranıyor: gerekçe
      // genelde birkaç satır sürüyor ve sabit bir pencere onu kaçırırdı.
      let bas = i
      while (bas > 0 && /^\s*(\/\/|\*|\/\*)/.test(satirlar[bas - 1])) bas--
      const oncekiler = satirlar.slice(bas, i).join('\n')
      const muafiyet = oncekiler.match(/tx-path-muaf:\s*(.+)/)
      if (muafiyet) {
        satirMuafiyetleri.push({ dosya: goreli, satir: i + 1, ad, gerekce: muafiyet[1].trim() })
        continue
      }
      bulgular.push({ dosya: goreli, satir: i + 1, ad, metin: satir.trim() })
    }
  }
}

console.log(`${taranan} dosya tarandı, ${MUAF.size} dosya muaf.`)
for (const [dosya, gerekce] of MUAF) console.log(`  muaf: ${dosya} — ${gerekce}`)
for (const m of satirMuafiyetleri) {
  console.log(`  muaf: ${m.dosya}:${m.satir} (${m.ad}) — ${m.gerekce}`)
}

if (bulgular.length > 0) {
  console.error('\nOrtak gönderim yolunu atlayan kod bulundu:')
  for (const b of bulgular) {
    console.error(`  ${b.dosya}:${b.satir}  ${b.ad}\n      ${b.metin}`)
  }
  console.error(
    '\nBu akışlar sendTx.ts\'teki sendInstructions üzerinden gitmeli. Aksi halde\n' +
      'mobilde zincire yazılmış bir işlem "başarısız" görünür ve kullanıcı\n' +
      'tekrar ödeme yapar. Gerçekten istisna gerekiyorsa MUAF listesine\n' +
      'GEREKÇESİYLE eklenmeli.',
  )
  process.exit(1)
}
console.log('\nTüm zincir işlemleri ortak, sertleştirilmiş yoldan geçiyor.')
