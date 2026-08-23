import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import type { WalletContextState } from '@solana/wallet-adapter-react'

// ---------------------------------------------------------------------------
// Token yakma (burn)
// ---------------------------------------------------------------------------
// "Yakma", token'ları bir çöp adrese GÖNDERMEK değildir — SPL Token
// programının kendi `burn` talimatıyla tokenlar hem cüzdandaki hesaptan hem
// de mint'in `supply` alanından KALICI olarak silinir. Solscan gibi
// gezginlerde toplam arz doğrudan düşmüş görünür; kimsenin "aslında şu
// cüzdanda duruyor" diyebileceği bir bakiye kalmaz.
//
// Projede iki ayrı yerde gerekiyor:
//   1. LP token'ının yakılması — havuz açıldıktan sonra likiditeyi ekip
//      dahil kimsenin çekememesini sağlar ("likidite yakılır" taahhüdü).
//   2. Presale hedefi dolmazsa, oransal olarak basılmayacak $LUCK'ın
//      yakılması (bkz. config.ts'teki presale kuralları).
//
// Bu yüzden fonksiyon LP'ye özel değil: cüzdandaki HERHANGİ bir SPL /
// Token-2022 token'ı için çalışır.

export interface BurnResult {
  signature: string
  /** Yakılan miktar (kullanıcı birimi, ör. 1.5). */
  amount: string
  mint: string
  /** Yakma sonrası mint'in toplam arzı (kullanıcı birimi). */
  remainingSupply: string
}

/** `getMint` için doğru program id'sini bulur (legacy SPL mi, Token-2022 mi). */
async function resolveTokenProgramId(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint)
  if (!info) throw new Error('Mint adresi zincirde bulunamadı.')
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
  throw new Error('Bu adres bir SPL Token mint hesabı değil.')
}

/**
 * Kullanıcı birimindeki bir miktarı (ör. "1.5") token'ın en küçük birimine
 * çevirir. Number üzerinden geçmiyoruz: 9 ondalıklı büyük miktarlarda
 * kayan nokta hatası, yakılan miktarı sessizce değiştirebilirdi.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim().replace(',', '.')
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error('Geçerli bir miktar girin.')
  }
  const [whole, frac = ''] = trimmed.split('.')
  if (frac.length > decimals) {
    throw new Error(`Bu token en fazla ${decimals} ondalık basamak destekliyor.`)
  }
  const padded = frac.padEnd(decimals, '0')
  return BigInt(whole || '0') * BigInt(10) ** BigInt(decimals) + BigInt(padded || '0')
}

/** En küçük birimdeki bir miktarı okunabilir metne çevirir. */
export function fromBaseUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString()
  const base = BigInt(10) ** BigInt(decimals)
  const whole = amount / base
  const frac = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

/**
 * Cüzdandaki tokenları kalıcı olarak yakar.
 *
 * GERİ ALINAMAZ: yakılan token yeniden basılamaz (mint yetkisi iptal
 * edilmişse hiç basılamaz). Çağıran taraf mutlaka açık bir onay adımı
 * göstermelidir.
 */
export async function burnTokens(
  connection: Connection,
  wallet: WalletContextState,
  mintAddress: string,
  amount: string,
  onStatus?: (status: string) => void,
): Promise<BurnResult> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Devam etmek için önce cüzdanınızı bağlayın.')
  }

  const owner = wallet.publicKey
  let mint: PublicKey
  try {
    mint = new PublicKey(mintAddress.trim())
  } catch {
    throw new Error('Geçersiz mint adresi.')
  }

  onStatus?.('Token bilgisi okunuyor...')
  const programId = await resolveTokenProgramId(connection, mint)
  const mintInfo = await getMint(connection, mint, undefined, programId)
  const decimals = mintInfo.decimals

  const baseAmount = toBaseUnits(amount, decimals)
  if (baseAmount <= BigInt(0)) throw new Error('Yakılacak miktar sıfırdan büyük olmalı.')

  const ata = getAssociatedTokenAddressSync(mint, owner, false, programId)

  onStatus?.('Bakiye kontrol ediliyor...')
  let held: bigint
  try {
    const balance = await connection.getTokenAccountBalance(ata)
    held = BigInt(balance.value.amount)
  } catch {
    throw new Error('Bu token için cüzdanınızda bir hesap bulunamadı.')
  }
  if (baseAmount > held) {
    throw new Error(
      `Bakiyeniz yetersiz: elinizde ${fromBaseUnits(held, decimals)} var, ${amount} yakmaya çalışıyorsunuz.`,
    )
  }

  const tx = new Transaction().add(
    createBurnCheckedInstruction(ata, mint, owner, baseAmount, decimals, [], programId),
  )

  onStatus?.('İşlem hazırlanıyor...')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = owner

  onStatus?.('Cüzdanınızda onay bekleniyor...')
  const signed = await wallet.signTransaction(tx)

  onStatus?.('İşlem ağa gönderiliyor...')
  const signature = await connection.sendRawTransaction(signed.serialize())

  onStatus?.('Onay bekleniyor...')
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  if (confirmation.value.err) {
    throw new Error(`Yakma işlemi zincirde başarısız oldu: ${JSON.stringify(confirmation.value.err)}`)
  }

  // Arzı işlemden SONRA tekrar okuyoruz — "gerçekten düştü" kanıtını
  // kullanıcıya tahmin ederek değil, zincirden okuyarak gösteriyoruz.
  onStatus?.('Yeni toplam arz okunuyor...')
  const after = await getMint(connection, mint, 'confirmed', programId)

  return {
    signature,
    amount,
    mint: mint.toBase58(),
    remainingSupply: fromBaseUnits(after.supply, decimals),
  }
}
