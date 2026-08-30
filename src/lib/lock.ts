import { SolanaStreamClient, buildLockParams, ICluster, type ICreateLockParams } from '@streamflow/stream'
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import type { Connection } from '@solana/web3.js'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import type { NetworkId } from '../config'

// The LP lock calls Streamflow's on-chain lock/vesting program, which is already
// deployed on Devnet and Mainnet, audited and widely used — it is not a program
// this site wrote and deployed itself. The lock is created as
// "non-cancelable / non-topupable / non-transferable", so nobody, us included,
// can withdraw the LP before it expires.
export const LOCK_DURATION_OPTIONS: { label: string; seconds: number }[] = [
  { label: '1 Hour', seconds: 60 * 60 },
  { label: '5 Hours', seconds: 5 * 60 * 60 },
  { label: '24 Hours', seconds: 24 * 60 * 60 },
  { label: '48 Hours', seconds: 48 * 60 * 60 },
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
  if (!wallet.publicKey) throw new Error('Connect your wallet first to continue.')

  const adapter = wallet.wallet?.adapter as SignerWalletAdapter | undefined
  if (!adapter || typeof adapter.signTransaction !== 'function') {
    throw new Error('The connected wallet does not support signing transactions.')
  }

  const amount = new BN(new Decimal(uiAmount).mul(10 ** lpDecimals).toFixed(0))
  if (amount.lten(0)) throw new Error('The amount to lock must be greater than zero.')

  const unlockDate = Math.floor(Date.now() / 1000) + durationSeconds

  const lockParams: ICreateLockParams = {
    recipient: wallet.publicKey.toBase58(),
    tokenId: lpMintAddress,
    amount,
    unlockDate,
    name: `LP Lock (${Math.round(durationSeconds / 3600)} hours)`,
    tokenProgramId: lpTokenProgramId,
  }

  const streamData = buildLockParams(lockParams)
  const client = getStreamflowClient(connection, network)

  onStatus?.('Waiting for approval in your wallet...')
  const result = await client.create(streamData, { sender: adapter })

  return {
    txId: result.txId,
    contractId: result.metadataId,
    unlockDate: new Date(unlockDate * 1000),
  }
}
