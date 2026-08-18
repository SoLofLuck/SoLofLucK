import { SolanaStreamClient, buildLockParams, ICluster, type ICreateLockParams } from '@streamflow/stream'
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import type { Connection } from '@solana/web3.js'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import type { NetworkId } from '../config'

// LP kilidi, Streamflow'un zaten Devnet ve Mainnet'te dağıtılmış, denetlenmiş
// ve yaygın kullanılan zincir-üstü kilit/vesting programını çağırır — bu
// sitenin kendi yazıp deploy ettiği bir program değildir. Kilit "iptal
// edilemez / üstüne ekleme yapılamaz / devredilemez" olacak şekilde
// oluşturulur, yani süre dolmadan biz dahil kimse LP'yi geri çekemez.
export const LOCK_DURATION_OPTIONS: { label: string; seconds: number }[] = [
  { label: '1 Saat', seconds: 60 * 60 },
  { label: '5 Saat', seconds: 5 * 60 * 60 },
  { label: '24 Saat', seconds: 24 * 60 * 60 },
  { label: '48 Saat', seconds: 48 * 60 * 60 },
]

export interface LockResult {
  txId: string
  contractId: string
  unlockDate: Date
}

function getStreamflowClient(connection: Connection, network: NetworkId): SolanaStreamClient {
  const cluster = network === 'devnet' ? ICluster.Devnet : ICluster.Mainnet
  return new SolanaStreamClient(connection.rpcEndpoint, cluster)
}

export async function lockLpTokens(
  connection: Connection,
  network: NetworkId,
  wallet: WalletContextState,
  lpMintAddress: string,
  lpDecimals: number,
  lpTokenProgramId: string,
  uiAmount: string,
  durationSeconds: number,
  onStatus?: (status: string) => void,
): Promise<LockResult> {
  if (!wallet.publicKey) throw new Error('Devam etmek için önce cüzdanınızı bağlayın.')

  const adapter = wallet.wallet?.adapter as SignerWalletAdapter | undefined
  if (!adapter || typeof adapter.signTransaction !== 'function') {
    throw new Error('Bağlı cüzdan işlem imzalamayı desteklemiyor.')
  }

  const amount = new BN(new Decimal(uiAmount).mul(10 ** lpDecimals).toFixed(0))
  if (amount.lten(0)) throw new Error('Kilitlenecek miktar sıfırdan büyük olmalı.')

  const unlockDate = Math.floor(Date.now() / 1000) + durationSeconds

  const lockParams: ICreateLockParams = {
    recipient: wallet.publicKey.toBase58(),
    tokenId: lpMintAddress,
    amount,
    unlockDate,
    name: `LP Kilidi (${Math.round(durationSeconds / 3600)} saat)`,
    tokenProgramId: lpTokenProgramId,
  }

  const streamData = buildLockParams(lockParams)
  const client = getStreamflowClient(connection, network)

  onStatus?.('Cüzdanınızda onay bekleniyor...')
  const result = await client.create(streamData, { sender: adapter })

  return {
    txId: result.txId,
    contractId: result.metadataId,
    unlockDate: new Date(unlockDate * 1000),
  }
}
