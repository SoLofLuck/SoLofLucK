#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Zincire giren bağımlılıklar — sabitlenmiş küme + açık kontrolü
// ---------------------------------------------------------------------------
// `cargo audit` Cargo.lock'u tarıyor. Cargo.lock ise testler için gelen TÜM
// Solana validator/TLS yığınını içeriyor: h2, quinn (QUIC), rustls-webpki,
// ring, tokio, curve25519-dalek... İlk CI koşusunda 10 "güvenlik açığı"
// çıktı ve hepsi bu yığındandı. Hiçbiri zincire yüklenen programın içinde
// değil.
//
// Cargo.lock'u zincirdeki programmış gibi denetlemek bir KATEGORİ HATASI.
// Doğru soru: SBF derlemesine hangi paketler giriyor?
//
// Bu denetim o soruyu cevaplıyor (bkz. scripts/lib/sbf-deps.mjs — cfg
// koşulları SBF hedefi için değerlendirilip grafik yürünüyor) ve iki şey
// yapıyor:
//
//   1. Zincire giren küme SABİTLENMİŞ listeyle aynı mı. Yeni bir paket
//      girerse denetim düşüyor ve birinin "bu paket ne, denetimden temiz
//      mi" sorusunu sorması gerekiyor.
//
//   2. AUDIT_JSON verilmişse (CI veriyor), cargo-audit'in bulduğu açıkların
//      hiçbiri bu kümede DEĞİL mi. Kümedeki bir paketin açığı çıkarsa
//      denetim düşüyor — asıl sert kapı burası.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cfgDogruMu, kenarGecerli, sbfBagimliliklari } from './lib/sbf-deps.mjs'

const kok = fileURLToPath(new URL('..', import.meta.url))
const PROGRAMLAR = ['luck-game', 'luck-distributor']
const KILIT_DOSYASI = `${kok}scripts/zincir-bagimliliklari.json`

// --- selftest: cfg değerlendiricisi ----------------------------------------
// Bu değerlendirici bir GÜVENLİK kararını taşıyor: yanlış çalışırsa ya
// zincirdeki bir paketi gözden kaçırırız (tehlikeli), ya da olmayan bir
// paketi varmış sanarız (gürültü). O yüzden kendi testleri var.
if (process.argv.includes('--selftest')) {
  let dustu = 0
  const k = (ad, gercek, beklenen) => {
    const ok = gercek === beklenen
    if (!ok) dustu++
    console.log(`${ok ? 'GEÇTİ' : 'DÜŞTÜ'}  ${ad}`)
    if (!ok) console.log(`   beklenen ${beklenen}, gelen ${gercek}`)
  }

  k('target_os = "solana" doğru', cfgDogruMu('target_os = "solana"'), true)
  k('not(target_os = "solana") yanlış', cfgDogruMu('not(target_os = "solana")'), false)
  k('target_os = "linux" yanlış', cfgDogruMu('target_os = "linux"'), false)
  k('unix yanlış', cfgDogruMu('unix'), false)
  k('windows yanlış', cfgDogruMu('windows'), false)
  k('any(unix, windows) yanlış', cfgDogruMu('any(unix, windows)'), false)
  k('not(any(unix, windows)) doğru', cfgDogruMu('not(any(unix, windows))'), true)
  k('target_pointer_width = "64" doğru', cfgDogruMu('target_pointer_width = "64"'), true)
  k('target_arch = "wasm32" yanlış', cfgDogruMu('target_arch = "wasm32"'), false)
  k(
    'all(target_os = "solana", target_endian = "little") doğru',
    cfgDogruMu('all(target_os = "solana", target_endian = "little")'),
    true,
  )
  k(
    'iç içe: not(all(any(unix, windows), target_os = "linux")) doğru',
    cfgDogruMu('not(all(any(unix, windows), target_os = "linux"))'),
    true,
  )
  // Bilinmeyen derleme bayrakları kapalı sayılmalı; açık sayılırsa
  // grafikte olmaması gereken paketler görünür.
  k('bilinmeyen bayrak (miri) yanlış', cfgDogruMu('miri'), false)
  k('rustix_use_libc yanlış', cfgDogruMu('rustix_use_libc'), false)

  k('koşulsuz kenar geçerli', kenarGecerli(null), true)
  k('düz üçlü geçersiz', kenarGecerli('aarch64-linux-android'), false)
  k('cfg(not(target_os="solana")) geçersiz', kenarGecerli('cfg(not(target_os = "solana"))'), false)
  k('cfg(target_os="solana") geçerli', kenarGecerli('cfg(target_os = "solana")'), true)

  // Gerçeklikle sağlama: hesaplanan küme mantıklı mı.
  const kume = new Set(sbfBagimliliklari(`${kok}program/luck-game`, 'luck-game'))
  const ad = (x) => [...kume].some((p) => p.startsWith(x + '@'))
  k('solana-program kümede', ad('solana-program'), true)
  k('anchor-lang kümede', ad('anchor-lang'), true)
  k('blake3 kümede', ad('blake3'), true)
  // Bunların HİÇBİRİ zincire girmemeli. Girerlerse ya değerlendirici
  // bozuk, ya gerçekten bir sorun var — ikisi de bakılmalı.
  for (const disarida of ['tokio', 'h2', 'quinn-proto', 'rustls-webpki', 'ring', 'im', 'sized-chunks', 'curve25519-dalek', 'ed25519-dalek']) {
    k(`${disarida} kümede DEĞİL`, ad(disarida), false)
  }

  console.log(dustu === 0 ? '\nTüm kontroller geçti.' : `\n${dustu} kontrol DÜŞTÜ.`)
  process.exit(dustu === 0 ? 0 : 1)
}

// --- asıl denetim -----------------------------------------------------------
const hatalar = []
const kontroller = []

const guncelle = process.argv.includes('--guncelle')
const sabit = existsSync(KILIT_DOSYASI)
  ? JSON.parse(readFileSync(KILIT_DOSYASI, 'utf8'))
  : {}

const hesaplanan = {}
for (const program of PROGRAMLAR) {
  hesaplanan[program] = sbfBagimliliklari(`${kok}program/${program}`, program)
}

if (guncelle) {
  writeFileSync(KILIT_DOSYASI, JSON.stringify(hesaplanan, null, 2) + '\n')
  console.log('zincir-bagimliliklari.json güncellendi. Değişikliği GÖZDEN GEÇİRİN:')
  for (const p of PROGRAMLAR) console.log(`  ${p}: ${hesaplanan[p].length} paket`)
  process.exit(0)
}

for (const program of PROGRAMLAR) {
  const gercek = hesaplanan[program]
  const bek = sabit[program]
  if (!bek) {
    hatalar.push(`${program}: sabitlenmiş liste yok — 'node scripts/check-onchain-deps.mjs --guncelle' çalıştırın`)
    kontroller.push({ ad: `${program}: sabitlenmiş liste var`, ok: false })
    continue
  }
  const eksik = bek.filter((d) => !gercek.includes(d))
  const fazla = gercek.filter((d) => !bek.includes(d))
  const ok = eksik.length === 0 && fazla.length === 0
  kontroller.push({ ad: `${program}: zincire giren ${gercek.length} paket`, ok })
  if (fazla.length) {
    hatalar.push(
      `${program}: zincire YENİ giren paket(ler): ${fazla.join(', ')}\n` +
        '      Bu paketler deploy edilen bytecode\'un içine giriyor. RustSec\n' +
        '      kaydını kontrol edip listeyi --guncelle ile bilerek tazeleyin.',
    )
  }
  if (eksik.length) {
    hatalar.push(`${program}: listede olup artık girmeyen: ${eksik.join(', ')} — --guncelle ile tazeleyin`)
  }
}

// --- cargo-audit çıktısıyla çapraz kontrol ---------------------------------
// AUDIT_JSON, `cargo audit --json` çıktısının yolu. CI veriyor; yerelde
// yoksa bu bölüm atlanıyor (sandbox'ta crates.io'ya erişim yok).
const auditYolu = process.env.AUDIT_JSON
if (auditYolu) {
  if (!existsSync(auditYolu)) {
    hatalar.push(`AUDIT_JSON verildi ama dosya yok: ${auditYolu}`)
    kontroller.push({ ad: 'audit çıktısı okunabildi', ok: false })
  } else {
    let rapor
    try {
      rapor = JSON.parse(readFileSync(auditYolu, 'utf8'))
    } catch (e) {
      hatalar.push(`audit JSON ayrıştırılamadı: ${e.message}`)
      rapor = null
    }
    // Şema değişmişse SESSİZCE GEÇMEK en kötü sonuç: denetim koşmamış olur
    // ama yeşil görünür.
    const liste = rapor?.vulnerabilities?.list
    if (!Array.isArray(liste)) {
      hatalar.push(
        'audit JSON içinde vulnerabilities.list bulunamadı — cargo-audit şeması değişmiş olabilir',
      )
      kontroller.push({ ad: 'audit şeması tanındı', ok: false })
    } else {
      kontroller.push({ ad: `audit raporu okundu (${liste.length} açık, tüm kilit dosyası)`, ok: true })
      const tumKume = new Set(PROGRAMLAR.flatMap((p) => hesaplanan[p]))
      const zincirdekiler = liste.filter((v) =>
        tumKume.has(`${v.package?.name}@${v.package?.version}`),
      )
      const ok = zincirdekiler.length === 0
      kontroller.push({ ad: 'zincire giren paketlerde açık yok', ok })
      if (!ok) {
        hatalar.push(
          'ZİNCİRDEKİ PROGRAMDA GÜVENLİK AÇIĞI:\n' +
            zincirdekiler
              .map(
                (v) =>
                  `      - ${v.package.name} ${v.package.version}: ` +
                  `${v.advisory?.id} — ${v.advisory?.title}`,
              )
              .join('\n'),
        )
      }
      const disaridakiler = liste.length - zincirdekiler.length
      if (disaridakiler > 0) {
        console.log(
          `  (${disaridakiler} açık yalnızca test/ana-makine yığınında — zincire girmiyor)`,
        )
      }
    }
  }
}

for (const c of kontroller) console.log(`${c.ok ? '✓' : '✗'} ${c.ad}`)

if (hatalar.length > 0) {
  console.error(`\n${hatalar.length} sorun:\n` + hatalar.map((h) => `  - ${h}`).join('\n'))
  process.exit(1)
}
console.log('\nZincire giren bağımlılıklar sabitlenmiş listeyle aynı.')
