#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Merkle ağacı üreticisi — claim programının girdisi
// ---------------------------------------------------------------------------
// Alıcı listesini alır, zincire yazılacak 32 baytlık kökü ve her alıcının
// kendi payını kanıtlayan "proof"u üretir.
//
// ÇIKTININ TAMAMI YAYINLANIR. Merkle'ın buradaki değeri gizlilik değil,
// DOĞRULANABİLİRLİK: zincirde tek bir kök duruyor, alıcı da kanıtını
// getiriyor. Liste yayınlandığı için herkes kendi payını görebiliyor,
// kimse listeye sonradan eklenemiyor (kök değişirdi) ve biz de kimsenin
// payını sessizce değiştiremiyoruz.
//
// HASH'LEME, programdaki (program/luck-distributor/src/lib.rs) mantığın
// birebir aynısı olmak ZORUNDA. Bir baytlık fark, TGE günü herkesin
// kanıtının reddedilmesi demek. Bu yüzden aşağıdaki `--selftest` modu var:
// sabit girdilerle üretilen kök, Rust tarafındaki testte de kontrol
// ediliyor (bkz. merkle_matches_javascript_builder). İki bağımsız
// uygulama aynı sonucu vermezse testler bunu TGE'den önce yakalar.
//
// Kullanım:
//   # presale (buyers.json → presale-merkle.json)
//   node scripts/build-merkle.mjs buyers.json > presale-merkle.json
//
//   # çekiliş turu (kazanan adresleri, herkese eşit ödül)
//   # DİKKAT: --amount EN KÜÇÜK BİRİM, tam token değil.
//   # 1.110.000 $LUCK, 9 ondalıkta = 1110000 × 10^9 = 1110000000000000
//   node scripts/build-merkle.mjs --amount 1110000000000000 winners.txt > round-1.json
//
//   # iki uygulamanın uyuştuğunu doğrula
//   node scripts/build-merkle.mjs --selftest

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { keccak_256 } from '@noble/hashes/sha3'
import { PublicKey } from '@solana/web3.js'

const LEAF_PREFIX = Uint8Array.from([0x00])
const NODE_PREFIX = Uint8Array.from([0x01])

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function u64le(value) {
  const out = new Uint8Array(8)
  let v = BigInt(value)
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** keccak(0x00 || alıcı(32) || miktar_le(8)) */
export function leafHash(address, amount) {
  const key = new PublicKey(address).toBytes()
  return keccak_256(concat(LEAF_PREFIX, key, u64le(amount)))
}

/** keccak(0x01 || küçük || büyük) — "sorted pair", proof'ta yön taşımaya gerek yok. */
function nodeHash(a, b) {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a]
  return keccak_256(concat(NODE_PREFIX, lo, hi))
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

const hex = (bytes) => Buffer.from(bytes).toString('hex')

/**
 * Ağacı kurar. Bir seviyede tek düğüm artarsa olduğu gibi bir üst seviyeye
 * taşınıyor ("promote") — kopyalayıp kendisiyle eşlemek yaygın bir hatadır
 * ve aynı yaprağın iki kez sayılmasına yol açabilir.
 */
export function buildTree(leaves) {
  if (leaves.length === 0) throw new Error('Boş liste — ağaç kurulamaz.')
  const levels = [leaves]
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1]
    const next = []
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? nodeHash(prev[i], prev[i + 1]) : prev[i])
    }
    levels.push(next)
  }
  return levels
}

export function proofFor(levels, index) {
  const proof = []
  let idx = index
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l]
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1
    if (sibling < level.length) proof.push(level[sibling])
    idx = Math.floor(idx / 2)
  }
  return proof
}

/** Üretilen kanıtın gerçekten köke çıktığını doğrular. */
export function verify(proof, root, leaf) {
  let computed = leaf
  for (const sibling of proof) computed = nodeHash(computed, sibling)
  return compare(computed, root) === 0
}

// ---------------------------------------------------------------------------

function parseEntries(argv) {
  const amountFlagIdx = argv.indexOf('--amount')
  const fixedAmount = amountFlagIdx >= 0 ? argv[amountFlagIdx + 1] : null
  // `--amount` YOKKEN indeks -1 oluyordu ve `amountFlagIdx + 1` de 0 —
  // yani filtre, dosya adı tek argümansa TAM ONU eliyordu. Sonuç:
  // "Girdi dosyası verilmedi". Presale yolu (JSON, --amount'suz) bu
  // yüzden hiç çalışmamış; yalnızca --amount verilen çekiliş yolu
  // çalışıyordu.
  const amountValueIdx = amountFlagIdx >= 0 ? amountFlagIdx + 1 : -1
  const file = argv.filter((a, i) => !a.startsWith('--') && i !== amountValueIdx).at(-1)
  if (!file) throw new Error('Girdi dosyası verilmedi.')

  const raw = readFileSync(file, 'utf8')

  // presale-buyers.mjs çıktısı (JSON) mı, düz adres listesi mi?
  if (raw.trimStart().startsWith('{')) {
    const parsed = JSON.parse(raw)

    // draw-raffle.mjs çıktısı: kazanan adresleri + ödül --amount ile
    // veriliyor (herkese eşit).
    //
    // Bu yol olmadan TGE'de ELLE adres ayıklamak gerekiyordu: çekiliş
    // JSON üretiyor, build-merkle ise düz adres listesi bekliyordu.
    // Aradaki dönüşümü insana bırakmak, tam da acele edilen bir günde
    // kopyala-yapıştır hatasına açık kapı demek.
    if (Array.isArray(parsed.winners)) {
      if (!fixedAmount) {
        throw new Error(
          'Çekiliş sonucu için --amount <en küçük birim> vermelisiniz ' +
            '(ör. 1.110.000 $LUCK, 9 ondalıkta = 1110000000000000).',
        )
      }
      return parsed.winners.map((w) => ({ address: w.address, amount: BigInt(fixedAmount) }))
    }

    if (!Array.isArray(parsed.buyers)) {
      throw new Error('JSON içinde "buyers" (presale) ya da "winners" (çekiliş) dizisi yok.')
    }
    // `baseUnits` KULLANILIYOR, `tokens` DEĞİL — ve bu ayrım kritik.
    //
    // `tokens` insan için: tam token sayısı (ör. 350000). `baseUnits`
    // zincir için: en küçük birim, yani tokens × 10^decimals. Merkle
    // yaprağına giren sayı doğrudan claim talimatına gidiyor ve SPL token
    // programı EN KÜÇÜK BİRİM bekliyor.
    //
    // Burada bir zamanlar `b.tokens` okunuyordu. 9 ondalıkta aradaki fark
    // 1.000.000.000 kat: her alıcı hak ettiğinin MİLYARDA BİRİNİ alırdı.
    // İşlemler başarıyla geçer, hiçbir hata görünmez, ve bunu ancak
    // alıcılar cüzdanlarına bakınca fark ederdi.
    return parsed.buyers.map((b) => {
      if (b.baseUnits === undefined) {
        throw new Error(
          `Alıcı kaydında "baseUnits" yok (${b.address}). Alıcı listesi eski ` +
            'sürüm presale-buyers.mjs ile üretilmiş olabilir — yeniden üretin. ' +
            '"tokens" alanı TAM TOKEN sayısıdır ve merkle yaprağına konamaz.',
        )
      }
      return { address: b.address, amount: BigInt(b.baseUnits) }
    })
  }

  if (!fixedAmount) {
    throw new Error('Düz adres listesi için --amount <miktar> vermelisiniz.')
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((address) => ({ address, amount: BigInt(fixedAmount) }))
}

export function build(entries) {
  // Aynı adres iki kez geçerse iki ayrı yaprak olurdu ama claim_status
  // hesabı alıcı başına TEK olduğu için ikincisi asla çekilemezdi — yani
  // sessizce para kilitlenirdi. Baştan hata veriyoruz.
  const seen = new Set()
  for (const e of entries) {
    if (seen.has(e.address)) throw new Error(`Adres listede iki kez var: ${e.address}`)
    seen.add(e.address)
    if (e.amount <= 0n) throw new Error(`Miktar sıfır veya negatif: ${e.address}`)
  }

  const leaves = entries.map((e) => leafHash(e.address, e.amount))
  const levels = buildTree(leaves)
  const root = levels[levels.length - 1][0]

  const claims = entries.map((e, i) => {
    const proof = proofFor(levels, i)
    // Her kanıtı burada, üretir üretmez doğruluyoruz. Bozuk bir kanıtın
    // TGE günü kullanıcının ekranında keşfedilmesi kabul edilemez.
    if (!verify(proof, root, leaves[i])) {
      throw new Error(`Kanıt doğrulanamadı: ${e.address}`)
    }
    return {
      address: e.address,
      amount: e.amount.toString(),
      proof: proof.map(hex),
    }
  })

  const total = entries.reduce((s, e) => s + e.amount, 0n)
  return { root: hex(root), total: total.toString(), count: claims.length, claims }
}

// --- selftest ---------------------------------------------------------------
// Rust tarafındaki testin beklediği sabit vektörler. Değiştirilirse
// program/luck-distributor/tests/distributor.rs'teki sabit de güncellenmeli
// — zaten uyuşmazsa test düşer, sessizce kaymaz.
const SELFTEST = [
  { address: 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36', amount: 1n },
  { address: '2Lzc6jorznu7zQKny79topGTE7V837oiV3j53zPH4Qh9', amount: 271_950_137n },
  { address: 'AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA', amount: 1_110_000n },
  { address: '3fBhNn8BEoFyQVAXasWj1xcNrcc2FRpLVQexFhZTnw6F', amount: 999_999_999n },
  { address: 'BiWqNZzCPCfJtVPNhoCrvEb9s6unpCFXXf38GR3WnPWX', amount: 70_007n },
]

// Aşağısı yalnızca script DOĞRUDAN çalıştırıldığında koşuyor. Bu dosya aynı
// zamanda bir modül: claim ekranı ve testler `leafHash`/`buildTree`/`verify`
// fonksiyonlarını import ediyor, o sırada CLI'nin devreye girmemesi gerek.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain && process.argv.includes('--selftest')) {
  // --- Girdi ayrıştırma ve birim testleri --------------------------------
  // İkisi de GERÇEK hatalardan geliyor; ikisi de sessizdi.
  const { mkdtempSync, writeFileSync: yaz } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const gecici = mkdtempSync(join(tmpdir(), 'merkle-selftest-'))

  // 1) `--amount` YOKKEN dosya adı okunabiliyor mu?
  //    Ayrıştırıcı, bayrak yokken indeks -1 olduğu için `-1 + 1 = 0`
  //    hesabıyla İLK argümanı eliyordu — tek argüman dosya adı olduğunda
  //    tam onu. Presale yolu bu yüzden hiç çalışmamıştı.
  const presaleDosyasi = join(gecici, 'buyers.json')
  yaz(
    presaleDosyasi,
    JSON.stringify({
      buyers: [
        { address: SELFTEST[0].address, tokens: 350_000, baseUnits: '350000000000000' },
        { address: SELFTEST[1].address, tokens: 175_000, baseUnits: '175000000000000' },
      ],
    }),
  )
  let presaleGirdileri
  try {
    presaleGirdileri = parseEntries([presaleDosyasi])
  } catch (err) {
    console.error(
      `SELFTEST DÜŞTÜ: --amount olmadan girdi dosyası okunamadı — ${err.message}`,
    )
    process.exit(1)
  }
  if (presaleGirdileri.length !== 2) {
    console.error(
      `SELFTEST DÜŞTÜ: ${presaleGirdileri.length} alıcı okundu, 2 olmalıydı.`,
    )
    process.exit(1)
  }

  // 2) Merkle yaprağına EN KÜÇÜK BİRİM giriyor mu, tam token değil?
  //    9 ondalıkta aradaki fark 1.000.000.000 kat: yanlış olan her
  //    alıcıya hak ettiğinin milyarda birini öderdi ve hiçbir hata
  //    görünmezdi.
  if (presaleGirdileri[0].amount !== 350_000_000_000_000n) {
    console.error(
      `SELFTEST DÜŞTÜ: yaprak miktarı ${presaleGirdileri[0].amount}, ` +
        'olması gereken 350000000000000 (en küçük birim).',
    )
    process.exit(1)
  }

  // 3) `baseUnits` içermeyen ESKİ biçimli liste reddediliyor mu?
  const eskiDosya = join(gecici, 'eski.json')
  yaz(eskiDosya, JSON.stringify({ buyers: [{ address: SELFTEST[0].address, tokens: 350_000 }] }))
  let reddedildi = false
  try {
    parseEntries([eskiDosya])
  } catch {
    reddedildi = true
  }
  if (!reddedildi) {
    console.error('SELFTEST DÜŞTÜ: baseUnits içermeyen liste sessizce kabul edildi.')
    process.exit(1)
  }
  console.log('Girdi ayrıştırma ve birim kontrolleri: GEÇTİ\n')

  const out = build(SELFTEST)
  console.log('Sabit vektör kökü (Rust testi bu değeri beklemeli):')
  console.log(out.root)
  console.log('\nToplam:', out.total, '· yaprak:', out.count)
  for (const c of out.claims) {
    console.log(`  ${c.address}  ${c.amount}  proof=${c.proof.length}`)
  }
  process.exit(0)
}

if (isMain) {
  const entries = parseEntries(process.argv.slice(2))
  process.stderr.write(`${entries.length} alıcı okundu, ağaç kuruluyor...\n`)
  const result = build(entries)
  process.stderr.write(`Kök: ${result.root}\nToplam: ${result.total}\n`)
  console.log(JSON.stringify(result, null, 2))
}
