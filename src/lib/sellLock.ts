import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { getExtraAccountMetaAddress, getMint, getTransferHook, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import BN from 'bn.js'

// Devnet'e deploy edilmiş "satış kilidi" (anti-snipe) programı. Kaynak kodu
// ve deploy geçmişi: program/sell-lock/ klasöründe. Bu, sitenin kendi
// yazdığı, Token-2022 Transfer Hook arayüzünü uygulayan ayrı bir Solana
// programıdır — token oluşturma/havuz akışlarından bağımsız olarak
// oluşturulup Devnet'te doğrulandı.
export const SELL_LOCK_PROGRAM_ID = new PublicKey(
  '3SgfMbBMbsaB21QaZgcGmRYbUTGGEyErJipxM8u2Uqy5',
)

// Anchor discriminator'ları = sha256("global:<instruction_adi>")[0..8].
const INITIALIZE_EXTRA_ACCOUNT_META_LIST_DISCRIMINATOR = Buffer.from([
  0x5c, 0xc5, 0xae, 0xc5, 0x29, 0x7c, 0x13, 0x03,
])
const REGISTER_LAUNCH_DISCRIMINATOR = Buffer.from([
  0x72, 0x72, 0x43, 0x17, 0x29, 0x46, 0x00, 0xe1,
])

export interface SellLockDurationOption {
  label: string
  seconds: number
}

// seconds: 0 = kilit yok (kapalı).
export const SELL_LOCK_DURATION_OPTIONS: SellLockDurationOption[] = [
  { label: 'Kapalı (satış kilidi yok)', seconds: 0 },
  { label: '15 Dakika', seconds: 900 },
  { label: '1 Saat', seconds: 3600 },
  { label: '5 Saat', seconds: 18_000 },
  { label: '24 Saat', seconds: 86_400 },
]

export function formatSellLockDuration(seconds: number): string {
  const match = SELL_LOCK_DURATION_OPTIONS.find((o) => o.seconds === seconds)
  return match?.label ?? `${seconds} saniye`
}

function getLaunchConfigPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('launch-config'), mint.toBuffer()],
    SELL_LOCK_PROGRAM_ID,
  )
  return pda
}

export function buildInitializeExtraAccountMetaListIx(
  payer: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const extraAccountMetaList = getExtraAccountMetaAddress(mint, SELL_LOCK_PROGRAM_ID)
  return new TransactionInstruction({
    programId: SELL_LOCK_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: extraAccountMetaList, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: INITIALIZE_EXTRA_ACCOUNT_META_LIST_DISCRIMINATOR,
  })
}

export function buildRegisterLaunchIx(
  signer: PublicKey,
  mint: PublicKey,
  poolVaultA: PublicKey,
  poolVaultB: PublicKey,
  durationSeconds: number,
): TransactionInstruction {
  const launchConfig = getLaunchConfigPda(mint)
  const data = Buffer.concat([
    REGISTER_LAUNCH_DISCRIMINATOR,
    new BN(durationSeconds).toArrayLike(Buffer, 'le', 8),
  ])
  return new TransactionInstruction({
    programId: SELL_LOCK_PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: launchConfig, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: poolVaultA, isSigner: false, isWritable: false },
      { pubkey: poolVaultB, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

// Havuz oluşturulduktan hemen sonra bir kez çağrılır — süreyi ve havuzun
// kasa adreslerini zincire kalıcı olarak yazar (bkz. program/sell-lock).
export async function registerLaunch(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey,
  poolVaultA: PublicKey,
  poolVaultB: PublicKey,
  durationSeconds: number,
  onStatus?: (status: string) => void,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Devam etmek için önce cüzdanınızı bağlayın.')
  }

  const tx = new Transaction().add(
    buildRegisterLaunchIx(wallet.publicKey, mint, poolVaultA, poolVaultB, durationSeconds),
  )

  onStatus?.('Satış kilidi işlemi hazırlanıyor...')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = wallet.publicKey

  onStatus?.('Cüzdanınızda onay bekleniyor...')
  const signedTx = await wallet.signTransaction(tx)

  onStatus?.('İşlem ağa gönderiliyor...')
  const signature = await connection.sendRawTransaction(signedTx.serialize())

  onStatus?.('Onay bekleniyor...')
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')

  return signature
}

// Bir mint'in, bizim satış kilidi programımıza bağlı bir Transfer Hook
// uzantısı olup olmadığını zincirden okur (Token-2022 olmayan mint'ler
// veya hook'u başka bir programa ait mint'ler için false döner).
export async function hasSellLockHook(connection: Connection, mint: PublicKey): Promise<boolean> {
  try {
    const mintInfo = await getMint(connection, mint, undefined, TOKEN_2022_PROGRAM_ID)
    const hook = getTransferHook(mintInfo)
    return hook !== null && hook.programId.equals(SELL_LOCK_PROGRAM_ID)
  } catch {
    return false
  }
}
