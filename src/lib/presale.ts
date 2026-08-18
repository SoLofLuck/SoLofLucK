import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import type { NetworkId } from '../config'
import { PRESALE_TICKET_UNIT_SOL, PRESALE_WALLET } from '../config'

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

/**
 * Presale'e SOL gönderir. `flex` modda çekiliş bileti kazandırmaz (serbest
 * katkı); `fixed` modda her PRESALE_TICKET_UNIT_SOL (0.5 SOL) için 1 bilet
 * kazandırır. Katkı, PRESALE_WALLET adresine tek bir SystemProgram.transfer
 * ile ve izlenebilirlik için bir memo talimatıyla birlikte gönderilir.
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
  const tickets = mode === 'fixed' ? calcTickets(amountSol) : 0

  const tx = new Transaction()
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: new PublicKey(PRESALE_WALLET),
      lamports: Math.round(amountSol * LAMPORTS_PER_SOL),
    }),
  )
  tx.add(
    buildMemoIx(
      payer,
      JSON.stringify({ app: 'solofluck-presale', mode, sol: amountSol, tickets }),
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
