import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import type { NetworkId } from '../config'
import {
  PRESALE_DURATION_WEEKS,
  PRESALE_OPS_FEE_DEN,
  PRESALE_OPS_FEE_NUM,
  PRESALE_OPS_WALLET,
  PRESALE_SOFT_CAP_SOL,
  PRESALE_START_ISO,
  PRESALE_TARGET_SOL,
  PRESALE_TICKET_UNIT_SOL,
  PRESALE_TOKENS_PER_SOL,
  PRESALE_WALLET,
} from '../config'

// Solana Memo programı — presale katkısının modunu/tutarını, hiçbir özel
// program yazmadan doğrudan işlem içinde, herkesin görebileceği şekilde
// zincire not düşmek için kullanılıyor. Böylece ileride bir indexer/backend
// eklendiğinde bilet sayımı bu memo kayıtlarından da doğrulanabilir.
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

export type PresaleMode = 'flex' | 'fixed'

export interface PresaleContributionResult {
  signature: string
  tickets: number
  amountSol: number
  mode: PresaleMode
}

function buildMemoIx(payer: PublicKey, text: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(text, 'utf-8'),
  })
}

export function calcTickets(amountSol: number): number {
  if (amountSol <= 0) return 0
  return Math.floor((amountSol + 1e-9) / PRESALE_TICKET_UNIT_SOL)
}

/** Operasyon payının yüzde karşılığı (ör. 0.777) — arayüzde göstermek için. */
export const PRESALE_OPS_FEE_PERCENT = (PRESALE_OPS_FEE_NUM / PRESALE_OPS_FEE_DEN) * 100

/** Operasyon payı yapılandırıldı mı (cüzdan boşsa pay hiç alınmaz). */
export const presaleOpsFeeActive = Boolean(PRESALE_OPS_WALLET) && PRESALE_OPS_FEE_NUM > 0

// ---------------------------------------------------------------------------
// Sabit fiyat, hedef ve ilerleme
// ---------------------------------------------------------------------------

/** Verilen SOL karşılığında alınacak $LUCK miktarı (sabit fiyat). */
export function tokensForSol(amountSol: number): number {
  if (!Number.isFinite(amountSol) || amountSol <= 0) return 0
  return amountSol * PRESALE_TOKENS_PER_SOL
}

/**
 * Presale cüzdanında hedefe ulaşıldığında bulunması gereken bakiye.
 *
 * Operasyon payı katkının içinden AYNI işlemde ayrıldığı için presale
 * cüzdanına yalnızca kalan kısım giriyor — yani 777 SOL'lük hedef, presale
 * cüzdanında 777 değil, 777 × (1 − pay) SOL demek. İlerleme çubuğu bu yüzden
 * ham bakiyeyi değil, bu eşiği referans alıyor.
 */
export const PRESALE_TARGET_POOL_SOL =
  PRESALE_TARGET_SOL * (1 - PRESALE_OPS_FEE_NUM / PRESALE_OPS_FEE_DEN)

/** Presale cüzdanındaki bakiyeden, toplanan BRÜT katkıyı geri hesaplar. */
export function grossRaisedFromPoolSol(poolSol: number): number {
  const keepRatio = 1 - PRESALE_OPS_FEE_NUM / PRESALE_OPS_FEE_DEN
  if (keepRatio <= 0) return 0
  return poolSol / keepRatio
}

export interface PresaleProgress {
  /** Presale cüzdanındaki bakiye (SOL). */
  poolSol: number
  /** Buradan geri hesaplanan brüt katkı toplamı (SOL). */
  grossSol: number
  /** Hedefe göre doluluk, 0-1 arası (1'i aşabilir). */
  ratio: number
  /** Doluluk yüzdesi, 0-100 arasına sıkıştırılmış (çubuğun genişliği). */
  percent: number
  /** Hedef doldu mu — dolduysa katkı kabul edilmez. */
  targetReached: boolean
  /** Taban (soft cap) aşıldı mı. */
  softCapReached: boolean
}

export function computePresaleProgress(poolSol: number): PresaleProgress {
  const grossSol = grossRaisedFromPoolSol(poolSol)
  const ratio = PRESALE_TARGET_SOL > 0 ? grossSol / PRESALE_TARGET_SOL : 0
  return {
    poolSol,
    grossSol,
    ratio,
    percent: Math.max(0, Math.min(100, ratio * 100)),
    targetReached: grossSol >= PRESALE_TARGET_SOL,
    softCapReached: grossSol >= PRESALE_SOFT_CAP_SOL,
  }
}

/** Presale bitiş anı — başlangıç ilan edilmediyse null. */
export function presaleEndsAt(): Date | null {
  if (!PRESALE_START_ISO) return null
  const start = new Date(PRESALE_START_ISO)
  if (Number.isNaN(start.getTime())) return null
  return new Date(start.getTime() + PRESALE_DURATION_WEEKS * 7 * 24 * 60 * 60 * 1000)
}

export type PresalePhase = 'unscheduled' | 'upcoming' | 'live' | 'ended'

export function presalePhaseAt(now: Date = new Date()): PresalePhase {
  if (!PRESALE_START_ISO) return 'unscheduled'
  const start = new Date(PRESALE_START_ISO)
  const end = presaleEndsAt()
  if (Number.isNaN(start.getTime()) || !end) return 'unscheduled'
  if (now < start) return 'upcoming'
  if (now >= end) return 'ended'
  return 'live'
}

/** Kalan süreyi "12g 4s 30d" gibi kısa bir metne çevirir. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return '0d'
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}g ${hours}s ${minutes}d`
  if (hours > 0) return `${hours}s ${minutes}d`
  return `${minutes}d`
}

/**
 * Bir katkıyı, havuza gidecek kısım ile operasyon payına böler. Bölme
 * lamport (tam sayı) üzerinden yapılır ve pay AŞAĞI yuvarlanır — yani
 * yuvarlama farkı her zaman havuzun lehine kalır, katkıda bulunanın
 * aleyhine değil.
 */
export function splitContributionLamports(totalLamports: number): {
  poolLamports: number
  opsLamports: number
} {
  if (!presaleOpsFeeActive) return { poolLamports: totalLamports, opsLamports: 0 }
  const opsLamports = Math.floor((totalLamports * PRESALE_OPS_FEE_NUM) / PRESALE_OPS_FEE_DEN)
  return { poolLamports: totalLamports - opsLamports, opsLamports }
}

/**
 * Presale'e SOL gönderir. `flex` modda çekiliş bileti kazandırmaz (serbest
 * katkı); `fixed` modda her PRESALE_TICKET_UNIT_SOL (0.5 SOL) için 1 bilet
 * kazandırır.
 *
 * Katkı tek bir işlemde iki transfere bölünür: havuza gidecek kısım
 * PRESALE_WALLET'a, operasyon payı (bkz. PRESALE_OPS_WALLET) ayrı bir
 * cüzdana. İzlenebilirlik için her iki tutarı da içeren bir memo eklenir.
 * Operasyon cüzdanı yapılandırılmamışsa pay alınmaz ve katkının tamamı
 * PRESALE_WALLET'a gider.
 */
export async function sendPresaleContribution(
  connection: Connection,
  wallet: WalletContextState,
  network: NetworkId,
  mode: PresaleMode,
  amountSol: number,
  onStatus?: (status: string) => void,
): Promise<PresaleContributionResult> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Cüzdan bağlı değil.')
  }
  if (!PRESALE_WALLET) {
    throw new Error('Presale henüz yapılandırılmadı (PRESALE_WALLET boş).')
  }
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error('Geçersiz miktar.')
  }

  const payer = wallet.publicKey
  // Biletler HER ZAMAN gönderilen brüt tutar üzerinden hesaplanır —
  // operasyon payı bilet sayısını düşürmez.
  const tickets = mode === 'fixed' ? calcTickets(amountSol) : 0

  const totalLamports = Math.round(amountSol * LAMPORTS_PER_SOL)
  const { poolLamports, opsLamports } = splitContributionLamports(totalLamports)

  const tx = new Transaction()
  // Havuza gidecek kısım presale cüzdanına...
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: new PublicKey(PRESALE_WALLET),
      lamports: poolLamports,
    }),
  )
  // ...operasyon payı ise AYNI işlemde ayrı bir cüzdana. Presale cüzdanına
  // hiç uğramadığı için TGE'de havuza konacak tutar presale cüzdanının
  // bakiyesine eşit olur; elle ayıklama gerekmez.
  if (opsLamports > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey(PRESALE_OPS_WALLET),
        lamports: opsLamports,
      }),
    )
  }
  tx.add(
    buildMemoIx(
      payer,
      JSON.stringify({
        app: 'solofluck-presale',
        mode,
        sol: amountSol,
        tickets,
        pool: poolLamports,
        ops: opsLamports,
      }),
    ),
  )

  onStatus?.('İşlem hazırlanıyor...')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = payer

  onStatus?.('Cüzdanınızda onay bekleniyor...')
  const signedTx = await wallet.signTransaction(tx)

  onStatus?.('İşlem ağa gönderiliyor...')
  const signature = await connection.sendRawTransaction(signedTx.serialize())

  onStatus?.('Onay bekleniyor...')
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')

  recordContribution(network, { signature, tickets, amountSol, mode })

  return { signature, tickets, amountSol, mode }
}

// ---------------------------------------------------------------------------
// Yerel (tarayıcı) geçmiş — gerçek bir indexer/backend gelene kadar,
// kullanıcının bu cüzdanla yaptığı katkıları ve topladığı bilet sayısını
// anında gösterebilmek için localStorage'a da yazılır. Kaynak doğruluk her
// zaman zincirdeki işlem + memo'dur.
// ---------------------------------------------------------------------------

export interface StoredContribution extends PresaleContributionResult {
  at: number
}

function storageKey(network: NetworkId) {
  return `solofluck_presale_${network}`
}

function recordContribution(network: NetworkId, entry: PresaleContributionResult) {
  try {
    const key = storageKey(network)
    const raw = window.localStorage.getItem(key)
    const list: StoredContribution[] = raw ? JSON.parse(raw) : []
    list.push({ ...entry, at: Date.now() })
    window.localStorage.setItem(key, JSON.stringify(list))
  } catch {
    // localStorage yoksa (ör. gizli sekme kısıtlaması) sessizce yut —
    // bu, geçmiş görüntülemeyi etkiler ama katkı işlemini etkilemez.
  }
}

export function getLocalContributions(network: NetworkId): StoredContribution[] {
  try {
    const raw = window.localStorage.getItem(storageKey(network))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}
