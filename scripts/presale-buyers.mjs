#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Presale alıcı listesi — zincirden
// ---------------------------------------------------------------------------
// Presale kasasına gelen HER transferi okuyup gönderen adrese göre toplar ve
// her alıcının kaç $LUCK ile kaç çekiliş bileti hak ettiğini hesaplar.
//
// NEDEN BU SCRIPT VAR: sitede katkı geçmişi yalnızca kullanıcının kendi
// tarayıcısında (localStorage) tutuluyor — yani bizde hiçbir kayıt yok, olması
// da gerekmiyor. Tek doğru kaynak zincirin kendisi. Aynı script'i alıcılar da
// çalıştırıp kendi paylarını bizden bağımsız doğrulayabilir; "listeyi biz
// tuttuk, bize güvenin" demek zorunda kalmıyoruz.
//
// NEYE GÜVENMİYORUZ: işlemlere yazdığımız memo'ya. Memo, gönderenin kendi
// yazdığı serbest metindir — elle işlem oluşturan biri oraya istediği bilet
// sayısını yazabilir. Bu yüzden tutar da bilet de YALNIZCA hesabın gerçek
// bakiye değişiminden hesaplanıyor.
//
// Kullanım:
//   node scripts/presale-buyers.mjs > buyers.json
//
// Ortam değişkenleri:
//   RPC_URL      Solana RPC (varsayılan: mainnet-beta genel uç nokta)
//   WALLET       Presale kasası (varsayılan: src/config.ts'teki PRESALE_WALLET)
//   START_ISO    Bu tarihten ÖNCEKİ işlemler yok sayılır (presale açılışı)
//   END_ISO      Bu tarihten SONRAKİ işlemler yok sayılır (presale kapanışı)
//   FORMAT       json (varsayılan) | csv
//
// NOT: genel (public) RPC uç noktaları hız sınırlıdır ve binlerce işlem
// taranırken 429 döndürür. Gerçek dağıtımda Helius/QuickNode gibi kendi
// uç noktanızı RPC_URL ile verin.

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { readFileSync } from 'node:fs'

// --- config.ts'ten sabitleri oku (TS'i çalıştırmadan, basit regex ile) -------
function readConfigValue(name, fallback) {
  try {
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
    const m = src.match(new RegExp(`export const ${name}\\s*=\\s*'([^']*)'`))
    if (m) return m[1]
    const n = src.match(new RegExp(`export const ${name}\\s*=\\s*([0-9_.]+)`))
    if (n) return Number(n[1].replace(/_/g, ''))
  } catch {
    /* config okunamazsa fallback */
  }
  return fallback
}

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
const WALLET = process.env.WALLET || readConfigValue('PRESALE_WALLET', '')
const TOKENS_PER_SOL = Number(process.env.TOKENS_PER_SOL || readConfigValue('PRESALE_TOKENS_PER_SOL', 350000))
const TICKET_UNIT_SOL = Number(process.env.TICKET_UNIT_SOL || readConfigValue('PRESALE_TICKET_UNIT_SOL', 0.5))
const FORMAT = (process.env.FORMAT || 'json').toLowerCase()

const startMs = process.env.START_ISO ? Date.parse(process.env.START_ISO) : null
const endMs = process.env.END_ISO ? Date.parse(process.env.END_ISO) : null

if (!WALLET) {
  console.error('Presale cüzdanı bulunamadı. WALLET=<adres> verin.')
  process.exit(1)
}
if (process.env.START_ISO && Number.isNaN(startMs)) {
  console.error('START_ISO geçersiz (ör. 2026-09-01T18:00:00Z).')
  process.exit(1)
}
if (process.env.END_ISO && Number.isNaN(endMs)) {
  console.error('END_ISO geçersiz.')
  process.exit(1)
}

const connection = new Connection(RPC_URL, 'confirmed')
const wallet = new PublicKey(WALLET)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Hız sınırına (429) takılınca artan bekleme ile tekrar dener. */
async function withRetry(fn, label) {
  let delay = 500
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= 6) throw new Error(`${label} başarısız: ${err.message}`)
      process.stderr.write(`  ${label}: hata (${err.message}), ${delay}ms sonra tekrar...\n`)
      await sleep(delay)
      delay *= 2
    }
  }
}

// --- 1) Kasanın tüm imza geçmişi -------------------------------------------
process.stderr.write(`Presale kasası: ${WALLET}\nRPC: ${RPC_URL}\n\nİmzalar taranıyor...\n`)

const signatures = []
let before
for (;;) {
  const page = await withRetry(
    () => connection.getSignaturesForAddress(wallet, { before, limit: 1000 }),
    'getSignaturesForAddress',
  )
  if (page.length === 0) break
  signatures.push(...page)
  before = page[page.length - 1].signature
  process.stderr.write(`  ${signatures.length} imza...\n`)
  if (page.length < 1000) break
}

// Başarısız işlemler para taşımaz — baştan eliyoruz.
const candidates = signatures.filter((s) => !s.err)
process.stderr.write(`\nToplam ${signatures.length} imza, ${candidates.length} tanesi başarılı.\nİşlemler okunuyor...\n`)

// --- 2) Her işlemde kasanın bakiye artışını ve göndereni bul ---------------
const buyers = new Map()
const skipped = []
let processed = 0

for (let i = 0; i < candidates.length; i += 100) {
  const batch = candidates.slice(i, i + 100)
  const txs = await withRetry(
    () =>
      connection.getParsedTransactions(
        batch.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 },
      ),
    'getParsedTransactions',
  )

  for (let j = 0; j < txs.length; j++) {
    const tx = txs[j]
    const sig = batch[j].signature
    if (!tx || tx.meta?.err) continue

    const blockMs = (tx.blockTime ?? 0) * 1000
    if (startMs !== null && blockMs < startMs) continue
    if (endMs !== null && blockMs > endMs) continue

    // Kasanın bu işlemdeki NET bakiye artışı — tek doğru kaynak bu.
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58())
    const idx = keys.indexOf(WALLET)
    if (idx < 0) continue
    const delta = (tx.meta.postBalances[idx] ?? 0) - (tx.meta.preBalances[idx] ?? 0)
    if (delta <= 0) continue // çıkış ya da değişim yok

    // Gönderen: işlemin ücretini ödeyen ilk imzacı. Presale akışında parayı
    // gönderen ile imzalayan aynı cüzdan.
    const sender = keys[0]
    if (sender === WALLET) continue

    // Kasanın kendisine ait bir hesaptan gelen iç transferleri saymıyoruz.
    const entry = buyers.get(sender) ?? { lamports: 0, txCount: 0, signatures: [], firstAt: null, lastAt: null }
    entry.lamports += delta
    entry.txCount += 1
    entry.signatures.push(sig)
    const at = tx.blockTime ? new Date(blockMs).toISOString() : null
    if (at) {
      if (!entry.firstAt || at < entry.firstAt) entry.firstAt = at
      if (!entry.lastAt || at > entry.lastAt) entry.lastAt = at
    }
    buyers.set(sender, entry)
    processed += 1
  }
  process.stderr.write(`  ${Math.min(i + 100, candidates.length)}/${candidates.length}\n`)
}

// --- 3) Pay ve bilet hesabı -------------------------------------------------
const rows = [...buyers.entries()]
  .map(([address, e]) => {
    const sol = e.lamports / LAMPORTS_PER_SOL
    return {
      address,
      lamports: e.lamports,
      sol: Number(sol.toFixed(9)),
      tokens: Math.floor(sol * TOKENS_PER_SOL),
      tickets: Math.floor((sol + 1e-9) / TICKET_UNIT_SOL),
      txCount: e.txCount,
      firstAt: e.firstAt,
      lastAt: e.lastAt,
      signatures: e.signatures,
    }
  })
  .sort((a, b) => b.lamports - a.lamports)

const totals = rows.reduce(
  (acc, r) => ({
    lamports: acc.lamports + r.lamports,
    tokens: acc.tokens + r.tokens,
    tickets: acc.tickets + r.tickets,
  }),
  { lamports: 0, tokens: 0, tickets: 0 },
)

process.stderr.write(
  `\n${rows.length} alıcı, ${processed} katkı işlemi.\n` +
    `Toplam: ${(totals.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL · ` +
    `${totals.tokens.toLocaleString('tr-TR')} $LUCK · ${totals.tickets} bilet\n` +
    (skipped.length ? `Atlanan: ${skipped.length}\n` : ''),
)

// --- 4) Çıktı ---------------------------------------------------------------
if (FORMAT === 'csv') {
  console.log('address,sol,tokens,tickets,txCount,firstAt,lastAt')
  for (const r of rows) {
    console.log([r.address, r.sol, r.tokens, r.tickets, r.txCount, r.firstAt ?? '', r.lastAt ?? ''].join(','))
  }
} else {
  console.log(
    JSON.stringify(
      {
        wallet: WALLET,
        rpc: RPC_URL,
        window: { start: process.env.START_ISO ?? null, end: process.env.END_ISO ?? null },
        tokensPerSol: TOKENS_PER_SOL,
        ticketUnitSol: TICKET_UNIT_SOL,
        generatedAt: new Date().toISOString(),
        totals: {
          buyers: rows.length,
          sol: Number((totals.lamports / LAMPORTS_PER_SOL).toFixed(9)),
          tokens: totals.tokens,
          tickets: totals.tickets,
        },
        buyers: rows,
      },
      null,
      2,
    ),
  )
}
