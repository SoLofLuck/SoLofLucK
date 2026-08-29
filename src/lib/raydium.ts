import {
  Raydium,
  TxVersion,
  Percent,
  PoolFetchType,
  DEVNET_PROGRAM_ID,
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  getCpmmPdaAmmConfigId,
  getCreatePoolKeys,
  type ApiV3PoolInfoStandardItemCpmm,
  type CpmmKeys,
  type ApiV3Token,
} from '@raydium-io/raydium-sdk-v2'
import { Connection, PublicKey } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import type { NetworkId } from '../config'

export const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112'

export interface MintRef {
  address: string
  decimals: number
  programId: string
}

// Raydium's own token list mostly recognises mints registered with (known to)
// Raydium; for a freshly created token it usually comes back empty. So we read
// the decimals and program directly from the chain — which also works fine for
// a token created with this site moments ago.
export async function getMintInfo(connection: Connection, mintAddress: string): Promise<MintRef> {
  const mintPubkey = new PublicKey(mintAddress)
  const accountInfo = await connection.getAccountInfo(mintPubkey)
  if (!accountInfo) throw new Error('The mint address was not found. Check the address.')

  const programId = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID

  const mint = await getMint(connection, mintPubkey, undefined, programId)
  return {
    address: mintAddress,
    decimals: mint.decimals,
    programId: programId.toBase58(),
  }
}

// Reads how much of a token (e.g. the LP token, or the pool's A side) the
// wallet holds. If the account was never created (i.e. the balance is "0") it
// returns 0 rather than throwing.
export async function getWalletTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mintAddress: string,
  programId: string,
): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(mintAddress),
      owner,
      false,
      new PublicKey(programId),
    )
    const balance = await connection.getTokenAccountBalance(ata)
    return balance.value.uiAmount ?? 0
  } catch {
    return 0
  }
}

function toApiToken(mint: MintRef): Pick<ApiV3Token, 'address' | 'decimals' | 'programId'> {
  return { address: mint.address, decimals: mint.decimals, programId: mint.programId }
}

// The Raydium SDK's `execute({ sendAndConfirm: true })` can return a txId
// without throwing even when the transaction FAILED on chain (e.g. when the
// program itself returned an error) — "confirm" here only guarantees that the
// transaction was processed by the chain, not that the instructions succeeded.
// So after every execute() we read the transaction back from the chain and check
// whether it really succeeded.
async function verifyTxSuccess(connection: Connection, txId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const tx = await connection.getTransaction(txId, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    if (tx) {
      if (tx.meta?.err) {
        throw new Error(
          `The transaction failed on chain: ${JSON.stringify(tx.meta.err)}. Transaction signature: ${txId}`,
        )
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

// Read-only operations such as searching or viewing pools need no wallet; only
// the functions that sign transactions (creating a pool, adding or removing
// liquidity) require a connected wallet.
export async function loadRaydium(
  connection: Connection,
  wallet: WalletContextState,
  network: NetworkId,
): Promise<Raydium> {
  return Raydium.load({
    connection,
    owner: wallet.publicKey ?? undefined,
    signAllTransactions: wallet.signAllTransactions,
    cluster: network === 'devnet' ? 'devnet' : 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: 'confirmed',
  })
}

export interface PoolSummary {
  id: string
  type: string
  mintA: { address: string; symbol: string; decimals: number }
  mintB: { address: string; symbol: string; decimals: number }
  price: number
  tvl: number
  feeRatePct: number
  mintAmountA: number
  mintAmountB: number
}

function toSummary(pool: {
  id: string
  type: string
  mintA: ApiV3Token
  mintB: ApiV3Token
  price: number
  tvl: number
  feeRate: number
  mintAmountA: number
  mintAmountB: number
}): PoolSummary {
  return {
    id: pool.id,
    type: pool.type,
    mintA: { address: pool.mintA.address, symbol: pool.mintA.symbol || '?', decimals: pool.mintA.decimals },
    mintB: { address: pool.mintB.address, symbol: pool.mintB.symbol || '?', decimals: pool.mintB.decimals },
    price: pool.price,
    tvl: pool.tvl,
    feeRatePct: pool.feeRate * 100,
    mintAmountA: pool.mintAmountA,
    mintAmountB: pool.mintAmountB,
  }
}

// Raydium's pool search/listing API indexes Mainnet data only.
export async function searchPoolsByMint(
  raydium: Raydium,
  mint1: string,
  mint2?: string,
): Promise<PoolSummary[]> {
  const res = await raydium.api.fetchPoolByMints({
    mint1,
    mint2: mint2 || undefined,
    type: PoolFetchType.All,
  })
  return res.data.map(toSummary)
}

export async function getPoolById(
  raydium: Raydium,
  poolId: string,
  network: NetworkId,
): Promise<{ poolInfo: ApiV3PoolInfoStandardItemCpmm; poolKeys?: CpmmKeys }> {
  if (network === 'mainnet-beta') {
    const data = await raydium.api.fetchPoolById({ ids: poolId })
    const poolInfo = data[0] as ApiV3PoolInfoStandardItemCpmm
    if (!poolInfo) throw new Error('The pool was not found.')
    return { poolInfo }
  }
  const data = await raydium.cpmm.getPoolInfoFromRpc(poolId)
  return { poolInfo: data.poolInfo, poolKeys: data.poolKeys }
}

async function getCpmmFeeConfig(raydium: Raydium, network: NetworkId) {
  const feeConfigs = await raydium.api.getCpmmConfigs()
  if (network === 'devnet') {
    feeConfigs.forEach((config) => {
      config.id = getCpmmPdaAmmConfigId(
        DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
        config.index,
      ).publicKey.toBase58()
    })
  }
  return feeConfigs[0]
}

export interface CreatePoolResult {
  txId: string
  poolId: string
  vaultA: string
  vaultB: string
}

export async function createCpmmPool(
  raydium: Raydium,
  network: NetworkId,
  mintA: MintRef,
  mintB: MintRef,
  uiAmountA: string,
  uiAmountB: string,
  onStatus?: (status: string) => void,
): Promise<CreatePoolResult> {
  onStatus?.('Fetching the fee settings...')
  const feeConfig = await getCpmmFeeConfig(raydium, network)

  const programId =
    network === 'devnet' ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : CREATE_CPMM_POOL_PROGRAM
  const poolFeeAccount =
    network === 'devnet' ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC : CREATE_CPMM_POOL_FEE_ACC

  const mintAAmount = new BN(new Decimal(uiAmountA).mul(10 ** mintA.decimals).toFixed(0))
  const mintBAmount = new BN(new Decimal(uiAmountB).mul(10 ** mintB.decimals).toFixed(0))

  onStatus?.('Preparing the pool transaction...')
  const { execute } = await raydium.cpmm.createPool({
    programId,
    poolFeeAccount,
    mintA: toApiToken(mintA),
    mintB: toApiToken(mintB),
    mintAAmount,
    mintBAmount,
    startTime: new BN(0),
    feeConfig,
    associatedOnly: false,
    addSupportMintExt: true,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  })

  onStatus?.('Waiting for approval in your wallet...')
  const { txId } = await execute({ sendAndConfirm: true })

  onStatus?.('Verifying the transaction result...')
  await verifyTxSuccess(raydium.connection, txId)

  // `extInfo.address` is an object the SDK returns before the transaction is
  // executed — in practice some of its fields turned out unreliable (e.g. a
  // temporary account opened and closed inside the transaction instead of the
  // real pool address). Instead we run THE SAME deterministic PDA derivation the
  // pool's own program uses (getCreatePoolKeys) ourselves and find the real
  // addresses.
  const poolKeys = getCreatePoolKeys({
    programId,
    configId: new PublicKey(feeConfig.id),
    mintA: new PublicKey(mintA.address),
    mintB: new PublicKey(mintB.address),
  })

  return {
    txId,
    poolId: poolKeys.poolId.toBase58(),
    vaultA: poolKeys.vaultA.toBase58(),
    vaultB: poolKeys.vaultB.toBase58(),
  }
}

export async function addCpmmLiquidity(
  raydium: Raydium,
  poolInfo: ApiV3PoolInfoStandardItemCpmm,
  poolKeys: CpmmKeys | undefined,
  uiAmount: string,
  baseIn: boolean,
  onStatus?: (status: string) => void,
): Promise<string> {
  const decimals = baseIn ? poolInfo.mintA.decimals : poolInfo.mintB.decimals
  const inputAmount = new BN(new Decimal(uiAmount).mul(10 ** decimals).toFixed(0))

  onStatus?.('Preparing the add-liquidity transaction...')
  const { execute } = await raydium.cpmm.addLiquidity({
    poolInfo,
    poolKeys,
    inputAmount,
    baseIn,
    slippage: new Percent(1, 100),
    txVersion: TxVersion.V0,
  })

  onStatus?.('Waiting for approval in your wallet...')
  const { txId } = await execute({ sendAndConfirm: true })
  onStatus?.('Verifying the transaction result...')
  await verifyTxSuccess(raydium.connection, txId)
  return txId
}

export async function withdrawCpmmLiquidity(
  raydium: Raydium,
  poolInfo: ApiV3PoolInfoStandardItemCpmm,
  poolKeys: CpmmKeys | undefined,
  lpUiAmount: string,
  onStatus?: (status: string) => void,
): Promise<string> {
  const lpAmount = new BN(new Decimal(lpUiAmount).mul(10 ** poolInfo.lpMint.decimals).toFixed(0))

  onStatus?.('Preparing the remove-liquidity transaction...')
  const { execute } = await raydium.cpmm.withdrawLiquidity({
    poolInfo,
    poolKeys,
    lpAmount,
    slippage: new Percent(1, 100),
    txVersion: TxVersion.V0,
  })

  onStatus?.('Waiting for approval in your wallet...')
  const { txId } = await execute({ sendAndConfirm: true })
  onStatus?.('Verifying the transaction result...')
  await verifyTxSuccess(raydium.connection, txId)
  return txId
}
