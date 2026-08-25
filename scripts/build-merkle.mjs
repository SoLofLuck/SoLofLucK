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
  const file = argv.filter((a, i) => !a.startsWith('--') && i !== amountFlagIdx + 1).at(-1)
  if (!file) throw new Error('Girdi dosyası verilmedi.')

  const raw = readFileSync(file, 'utf8')

  // presale-buyers.mjs çıktısı (JSON) mı, düz adres listesi mi?
  if (raw.trimStart().startsWith('{')) {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.buyers)) throw new Error('JSON içinde "buyers" dizisi yok.')
    return parsed.buyers.map((b) => ({ address: b.address, amount: BigInt(b.tokens) }))
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
