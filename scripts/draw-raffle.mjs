#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Çekiliş kazananlarını seçer — doğrulanabilir şekilde
// ---------------------------------------------------------------------------
// PROBLEM: "çekilişi biz yaptık, kazananlar bunlar" demek hiçbir şey kanıtlamaz.
// Ekibin sonucu kendi lehine seçmediğini kimse bilemez.
//
// ÇÖZÜM: rastgeleliği ZİNCİRDEN, hem de GELECEKTEN alıyoruz. Çekilişten önce
// bir slot numarası ilan ediliyor ("18. tur, 412.900.000. slot'un hash'iyle
// çekilecek"). O slot henüz oluşmadığı için hash'ini kimse — biz dahil —
// bilemez ya da etkileyemez. Slot geçtikten sonra ise hash herkese açık:
// aynı bilet listesi + aynı slot ile bu script'i çalıştıran herkes AYNI
// kazananları bulur.
//
// Oyundaki commit-reveal ile aynı fikir (bkz. program/luck-game resolve()).
//
// SEÇİM: bilet sayısıyla orantılı, İADESİZ. Bir cüzdan kazandığında tüm
// biletleri havuzdan çıkıyor — aynı turda iki kez kazanamıyor.
//
// Kullanım:
//   node scripts/draw-raffle.mjs --buyers buyers.json --slot 412900000 --winners 7
//   node scripts/draw-raffle.mjs --selftest

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { keccak_256 } from '@noble/hashes/sha3'
import { Connection } from '@solana/web3.js'

/**
 * Bilet listesinden kazananları seçer. TAMAMEN DETERMİNİSTİK: aynı girdi
 * her zaman aynı çıktıyı verir, hiçbir yerde Math.random yok.
 *
 * @param {{address: string, tickets: number}[]} entries
 * @param {Uint8Array} seed  çekiliş slot'unun blockhash'i
 * @param {number} winnerCount
 */
export function drawWinners(entries, seed, winnerCount) {
  // Sıralamayı sabitliyoruz: girdi dosyasının sırası değişirse sonuç da
  // değişirdi ve "aynı listeyle aynı sonucu aldım" iddiası çökerdi.
  const pool = entries
    .filter((e) => e.tickets > 0)
    .map((e) => ({ address: e.address, tickets: e.tickets }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))

  const winners = []
  for (let draw = 0; winners.length < winnerCount && pool.length > 0; draw++) {
    const total = pool.reduce((s, e) => s + e.tickets, 0)
    if (total <= 0) break

    // Her çekiliş için ayrı bir sayı: keccak(seed || tur_numarası)
    const drawBytes = new Uint8Array(4)
    new DataView(drawBytes.buffer).setUint32(0, draw, true)
    const merged = new Uint8Array(seed.length + 4)
    merged.set(seed)
    merged.set(drawBytes, seed.length)
    const digest = keccak_256(merged)

    // 32 baytı tek bir tamsayıya çevirip bilet toplamına göre modunu
    // alıyoruz. BigInt kullanmamızın sebebi: Number 2^53'ten sonra
    // hassasiyet kaybediyor ve seçim gözle görülmez şekilde yanlılaşırdı.
    let value = 0n
    for (const b of digest) value = (value << 8n) | BigInt(b)
    let pick = Number(value % BigInt(total))

    let idx = 0
    while (idx < pool.length && pick >= pool[idx].tickets) {
      pick -= pool[idx].tickets
      idx++
    }
    if (idx >= pool.length) idx = pool.length - 1

    winners.push({ address: pool[idx].address, tickets: pool[idx].tickets, draw })
    // İadesiz: kazanan havuzdan tamamen çıkıyor.
    pool.splice(idx, 1)
  }
  return winners
}

// --- CLI ---------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

// --- selftest ---------------------------------------------------------------
// Determinizmi ve orantılılığı kanıtlar. Bir kişinin biletleri toplamın
// yarısıysa, çok sayıda farklı tohumda kazanma oranı da yarıya yakın
// olmalı — seçimin sadece "tekrarlanabilir" değil, aynı zamanda ADİL
// olduğunu gösteren kısım bu.
if (isMain && process.argv.includes('--selftest')) {
  const entries = [
    { address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', tickets: 50 },
    { address: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', tickets: 25 },
    { address: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', tickets: 15 },
    { address: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', tickets: 10 },
  ]

  const seed = keccak_256(new TextEncoder().encode('sabit-tohum'))
  const a = drawWinners(entries, seed, 2)
  const b = drawWinners(entries, seed, 2)
  console.log('Determinizm:', JSON.stringify(a) === JSON.stringify(b) ? 'GEÇTİ' : 'DÜŞTÜ')
  console.log('  kazananlar:', a.map((w) => w.address.slice(0, 4)).join(', '))

  // Aynı cüzdan iki kez kazanabiliyor mu?
  const uniq = new Set(a.map((w) => w.address))
  console.log('Tekrarsızlık:', uniq.size === a.length ? 'GEÇTİ' : 'DÜŞTÜ')

  // Orantılılık
  const counts = Object.fromEntries(entries.map((e) => [e.address, 0]))
  const N = 20000
  for (let i = 0; i < N; i++) {
    const s = keccak_256(new TextEncoder().encode(`tohum-${i}`))
    counts[drawWinners(entries, s, 1)[0].address]++
  }
  console.log('Orantılılık (beklenen / gerçekleşen):')
  let ok = true
  for (const e of entries) {
    const expected = e.tickets / 100
    const actual = counts[e.address] / N
    const drift = Math.abs(expected - actual)
    if (drift > 0.02) ok = false
    console.log(
      `  ${e.address.slice(0, 4)}  %${(expected * 100).toFixed(1)} / %${(actual * 100).toFixed(1)}`,
    )
  }
  console.log('Orantılılık:', ok ? 'GEÇTİ' : 'DÜŞTÜ (sapma %2den büyük)')
  process.exit(0)
}

if (isMain) {
  const buyersPath = arg('buyers')
  const slot = Number(arg('slot'))
  const winnerCount = Number(arg('winners', '7'))
  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'

  if (!buyersPath || !Number.isFinite(slot)) {
    console.error('Kullanım: node scripts/draw-raffle.mjs --buyers buyers.json --slot <slot> [--winners 7]')
    process.exit(1)
  }

  const parsed = JSON.parse(readFileSync(buyersPath, 'utf8'))
  const entries = (parsed.buyers ?? []).map((b) => ({ address: b.address, tickets: b.tickets }))
  const totalTickets = entries.reduce((s, e) => s + e.tickets, 0)
  if (totalTickets === 0) {
    console.error('Listede hiç bilet yok.')
    process.exit(1)
  }

  const connection = new Connection(rpcUrl, 'confirmed')
  const block = await connection.getBlock(slot, {
    maxSupportedTransactionVersion: 0,
    transactionDetails: 'none',
    rewards: false,
  })
  if (!block) {
    console.error(`${slot}. slot bulunamadı. Slot henüz oluşmamış olabilir ya da RPC o kadar` +
      ' geriye bakmıyordur (arşiv düğümü gerekebilir).')
    process.exit(1)
  }

  // Blockhash base58; baytlarına çevirip tohum olarak kullanıyoruz.
  const { PublicKey } = await import('@solana/web3.js')
  const seed = new PublicKey(block.blockhash).toBytes()

  const winners = drawWinners(entries, seed, winnerCount)

  process.stderr.write(
    `Slot: ${slot}\nBlockhash: ${block.blockhash}\n` +
      `Katılımcı: ${entries.length} · toplam bilet: ${totalTickets}\n` +
      `Kazanan: ${winners.length}\n\n`,
  )

  console.log(
    JSON.stringify(
      {
        slot,
        blockhash: block.blockhash,
        totalTickets,
        participants: entries.length,
        winnerCount,
        winners,
        // Doğrulama için: bu üç bilgiyle herkes aynı sonucu üretebilir.
        howToVerify:
          'node scripts/draw-raffle.mjs --buyers <aynı buyers.json> --slot ' +
          slot +
          ' --winners ' +
          winnerCount,
      },
      null,
      2,
    ),
  )
}
