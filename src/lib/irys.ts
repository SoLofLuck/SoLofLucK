import { WebUploader } from '@irys/web-upload'
import { WebSolana } from '@irys/web-upload-solana'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import type { Connection } from '@solana/web3.js'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { NETWORKS, type NetworkId } from '../config'

// The logo and the metadata JSON are written permanently to the Irys/Arweave
// network, paid for directly with the user's connected Solana wallet, with no
// need for a third-party account or service. No sign-up, no API key, no visiting
// another site — for a small image the fee is usually less than a thousandth of
// a SOL and is approved in the wallet as an ordinary transaction.

export interface OnChainMetadataInput {
  name: string
  symbol: string
  description: string
  website: string
  twitter: string
  telegram: string
}

// We cannot know the exact size of the metadata JSON in advance (once the image
// URL has been filled in), but it will not exceed a few hundred bytes; we leave
// a generous buffer that covers the fee in one go with room to spare.
const METADATA_JSON_BUFFER_BYTES = 2048
// The buffer set aside for the transaction fee plus account rent (lamports).
const WALLET_FEE_BUFFER_LAMPORTS = 20_000

function sol(lamports: number | string): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)
}

async function getIrysUploader(wallet: WalletContextState, network: NetworkId) {
  const builder = WebUploader(WebSolana)
    .withProvider(wallet)
    .withRpc(NETWORKS[network].endpoint)
    // Irys waits for "finalized" confirmation by default; on Solana that is
    // far slower than "confirmed" (sometimes 15-30+ s) and would often exceed
    // the internal timeout (30 s) and fail for no good reason. "confirmed" is
    // much faster and in practice just as reliable.
    .withTokenOptions({ finality: 'confirmed' })

  if (network === 'devnet') {
    builder.devnet()
  }

  // UploadBuilder is "thenable" (awaiting it runs .build() and returns the real
  // Irys instance carrying the getPrice/fund/uploadFile methods) — which is why we
  // await it explicitly here.
  return await builder
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// IMPORTANT: every call to irys.fund() creates a NEW SOL transfer and asks for
// a NEW approval in the wallet — which is why we do not build the "it failed,
// try again" logic here by calling fund() repeatedly (that would ask for several
// wallet approvals back to back and take minutes). Instead: after the first
// attempt we check whether the balance has updated without sending any new
// transaction (the SOL has usually been sent, it is only Irys seeing it that
// lags); only if the balance is still short do we try AT MOST once more (2
// wallet approvals in total).
async function ensureFunded(
  irys: Awaited<ReturnType<typeof getIrysUploader>>,
  connection: Connection,
  walletPubkey: import('@solana/web3.js').PublicKey,
  bytes: number,
  onStatus?: (status: string) => void,
) {
  const price = await irys.getPrice(bytes)
  let balance = await irys.getLoadedBalance()
  if (!price.isGreaterThan(balance)) {
    onStatus?.('The storage fee is already covered, moving on to the upload...')
    return
  }

  let topUp = price.minus(balance).multipliedBy(1.15).integerValue()

  // Does the wallet actually hold that much SOL? If not, the wallet will
  // reject the transaction with "insufficient balance" anyway — detecting
  // that up front and giving a clear message is far better than waiting for
  // a mysterious network error.
  const walletLamports = await connection.getBalance(walletPubkey)
  const needed = topUp.toNumber() + WALLET_FEE_BUFFER_LAMPORTS
  if (walletLamports < needed) {
    throw new Error(
      `your wallet does not have enough SOL (needed: ~${sol(needed)} SOL, available: ${sol(walletLamports)} SOL). ` +
        'On Devnet you can get free SOL from faucet.solana.com.',
    )
  }

  onStatus?.(`Waiting for approval in your wallet for the storage fee (~${sol(topUp.toNumber())} SOL)...`)
  let lastError: unknown
  try {
    await irys.fund(topUp)
    onStatus?.('The storage fee was confirmed.')
    return
  } catch (err) {
    lastError = err
  }

  onStatus?.('The storage network did not respond, waiting a few seconds (no new transaction is sent)...')
  await sleep(8000)
  balance = await irys.getLoadedBalance()
  if (!price.isGreaterThan(balance)) {
    onStatus?.('The fee was confirmed in the meantime, continuing...')
    return
  }

  onStatus?.('One more approval request will appear in your wallet...')
  try {
    topUp = price.minus(balance).multipliedBy(1.15).integerValue()
    await irys.fund(topUp)
    onStatus?.('The storage fee was confirmed.')
    return
  } catch (err) {
    lastError = err
  }

  throw new Error(
    lastError instanceof Error
      ? `the storage network did not respond — ${lastError.message}`
      : 'the storage network did not respond',
  )
}

export async function uploadLogoAndMetadata(
  file: File,
  input: OnChainMetadataInput,
  connection: Connection,
  wallet: WalletContextState,
  network: NetworkId,
  onStatus?: (status: string) => void,
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('the wallet is not connected')
  }

  onStatus?.('Connecting to the storage network...')
  let irys: Awaited<ReturnType<typeof getIrysUploader>>
  try {
    irys = await getIrysUploader(wallet, network)
  } catch (err) {
    throw stageError('Could not connect to the network', err)
  }

  // We cover the fee needed for the logo plus the metadata JSON up front, in ONE
  // go. That way, instead of sending the fee twice separately with a wallet
  // approval and a confirmation wait for each, we send it at most once (twice if
  // necessary) across the whole upload.
  onStatus?.('Calculating the storage fee...')
  try {
    await ensureFunded(
      irys,
      connection,
      wallet.publicKey,
      file.size + METADATA_JSON_BUFFER_BYTES,
      onStatus,
    )
  } catch (err) {
    throw stageError('Could not send the storage fee', err)
  }

  onStatus?.(`Uploading the logo (${(file.size / 1024).toFixed(0)} KB) permanently to the network...`)
  let imageReceipt: Awaited<ReturnType<typeof irys.uploadFile>>
  try {
    imageReceipt = await irys.uploadFile(file)
  } catch (err) {
    throw stageError('The logo could not be uploaded', err)
  }
  const imageUrl = `https://gateway.irys.xyz/${imageReceipt.id}`
  onStatus?.('The logo was uploaded, preparing the metadata...')

  const metadataJson = {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: imageUrl,
    external_url: input.website || undefined,
    extensions: {
      website: input.website || undefined,
      twitter: input.twitter || undefined,
      telegram: input.telegram || undefined,
    },
    properties: {
      files: [{ uri: imageUrl, type: file.type || 'image/png' }],
      category: 'image',
    },
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataJson))
  const metadataFile = new File([metadataBytes], 'metadata.json', {
    type: 'application/json',
  })

  onStatus?.('Uploading the metadata permanently to the network...')
  try {
    const metadataReceipt = await irys.uploadFile(metadataFile)
    onStatus?.('The metadata was uploaded.')
    return `https://gateway.irys.xyz/${metadataReceipt.id}`
  } catch (err) {
    throw stageError('The metadata could not be uploaded', err)
  }
}

function stageError(prefix: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err)
  return new Error(`${prefix}: ${detail}`)
}
