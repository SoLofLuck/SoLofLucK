#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Çekiliş kazananlarını seçer — doğrulanabilir şekilde
// ---------------------------------------------------------------------------
// PROBLEM: "çekilişi biz yaptık, kazananlar bunlar" demek hiçbir şey kanıtlamaz.
// Ekibin sonucu kendi lehine seçmediğini kimse bilemez.
//
// ÇÖZÜM: rastgeleliği ZİNCİRDEN, hem de GELECEKTEN alıyoruz. Çekilişten önce
// bir slot numarası ilan ediliyor ("18. tur, 412.900.000. slot'tan İTİBAREN
// ilk bloğun hash'iyle çekilecek"). O slot henüz oluşmadığı için hash'ini
// kimse — biz dahil — bilemez ya da etkileyemez. Slot geçtikten sonra ise
// hash herkese açık: aynı bilet listesi + aynı ilan edilen slot ile bu
// script'i çalıştıran herkes AYNI kazananları bulur.
//
// "SLOT'TAN İTİBAREN İLK BLOK" — tek bir slot değil. Solana'da bir slot
// ATLANABİLİR: o slotun lideri blok üretmezse o numarada hiç blok olmaz ve
// hash'i de yoktur. İlan edilen tek bir slota bağlansaydık, o slot
// atlandığında çekiliş yapılamaz ve operatör YENİ BİR SLOT SEÇMEK zorunda
// kalırdı — yani sonucu etkileyebileceği bir seçim kazanırdı ve "biz
// karışmadık" iddiası tam da orada çökerdi. Mainnet'te atlanma oranı
// %1-5, devnet'te %5-15; yani bu er ya da geç olur.
//
// Kural bunun yerine deterministik: ilan edilen slottan başlayarak İLERİ
// doğru ilk GERÇEKTEN VAR OLAN blok kullanılıyor. Kimsenin seçimi yok,
// herkes aynı sonucu bulur. (Oyundaki find_slot_hash_at_or_after ile aynı
// düzeltme.)
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

/**
 * İlan edilen slottan İTİBAREN ilk gerçekten var olan bloğun slot numarası.
 * Atlanan slotları geçer; hiçbiri yoksa null döner.
 *
 * `getBlocks(baslangic, bitis)` yerine bir geri çağırım alıyor ki ağ
 * olmadan da sınanabilsin.
 */
export async function cekilisSlotunuBul(getBlocks, ilanEdilen, pencere = 500) {
  const bloklar = await getBlocks(ilanEdilen, ilanEdilen + pencere)
  if (!Array.isArray(bloklar)) return null
  let enKucuk = null
  for (const s of bloklar) {
    if (s < ilanEdilen) continue
    if (enKucuk === null || s < enKucuk) enKucuk = s
  }
  return enKucuk
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

  // --- Atlanan slot kuralı ---
  // İlan edilen slot atlanmışsa çekiliş DURMAMALI ve operatöre slot seçme
  // fırsatı VERMEMELİ; kural gereği sonraki ilk blok kullanılmalı.
  let slotOk = true
  const slotKontrol = async (ad, bloklar, ilan, beklenen) => {
    const g = await cekilisSlotunuBul(async () => bloklar, ilan, 500)
    const gecti = g === beklenen
    if (!gecti) slotOk = false
    console.log(`  ${gecti ? 'GEÇTİ' : 'DÜŞTÜ'}  ${ad}` + (gecti ? '' : ` (beklenen ${beklenen}, gelen ${g})`))
  }
  console.log('Atlanan slot kuralı:')
  await slotKontrol('ilan edilen slot var → aynısı', [1000, 1001, 1002], 1000, 1000)
  await slotKontrol('ilan edilen atlanmış → sonraki ilk blok', [1003, 1004], 1000, 1003)
  await slotKontrol('arada boşluklar → EN KÜÇÜK olan', [1009, 1005, 1007], 1000, 1005)
  await slotKontrol('sıra karışık gelse de en küçük', [1200, 1002, 1100], 1000, 1002)
  await slotKontrol('ilan edilenden ÖNCEKİ bloklar sayılmaz', [998, 999, 1004], 1000, 1004)
  await slotKontrol('hiç blok yok → null', [], 1000, null)
  console.log('Atlanan slot kuralı:', slotOk ? 'GEÇTİ' : 'DÜŞTÜ')
  if (!slotOk) process.exit(1)

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
  const PENCERE = Number(process.env.CEKILIS_PENCERESI ?? '500')
  const cekilisSlotu = await cekilisSlotunuBul(
    (a, b) => connection.getBlocks(a, b),
    slot,
    PENCERE,
  )
  if (cekilisSlotu === null) {
    console.error(
      `${slot}. slottan itibaren ${PENCERE} slot içinde hiç blok bulunamadı.\n` +
        'Slot henüz oluşmamış olabilir, ya da bu RPC o kadar geriye bakmıyordur\n' +
        '(arşiv düğümü gerekebilir). Slot seçimini DEĞİŞTİRMEYİN — kuralı\n' +
        'değiştirmek çekilişin doğrulanabilirliğini bozar.',
    )
    process.exit(1)
  }
  if (cekilisSlotu !== slot) {
    process.stderr.write(
      `İlan edilen ${slot}. slot atlanmış (o slotta blok üretilmemiş).\n` +
        `Kural gereği ondan sonraki ilk blok kullanılıyor: ${cekilisSlotu}\n\n`,
    )
  }
  const block = await connection.getBlock(cekilisSlotu, {
    maxSupportedTransactionVersion: 0,
    transactionDetails: 'none',
    rewards: false,
  })
  if (!block) {
    console.error(`${cekilisSlotu}. slot getBlocks'ta göründü ama okunamadı — RPC tutarsız.`)
    process.exit(1)
  }

  // Blockhash base58; baytlarına çevirip tohum olarak kullanıyoruz.
  const { PublicKey } = await import('@solana/web3.js')
  const seed = new PublicKey(block.blockhash).toBytes()

  const winners = drawWinners(entries, seed, winnerCount)

  process.stderr.write(
    `İlan edilen slot: ${slot}\nÇekiliş slotu: ${cekilisSlotu}\n` +
      `Blockhash: ${block.blockhash}\n` +
      `Katılımcı: ${entries.length} · toplam bilet: ${totalTickets}\n` +
      `Kazanan: ${winners.length}\n\n`,
  )

  console.log(
    JSON.stringify(
      {
        // İlan edilen slot: çekilişten ÖNCE duyurulan sayı.
        announcedSlot: slot,
        // Gerçekten kullanılan blok: ilan edilenden itibaren ilk var olan.
        // Eşitse ilan edilen slot atlanmamış demektir.
        slot: cekilisSlotu,
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
