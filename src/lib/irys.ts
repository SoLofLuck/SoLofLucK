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

// Polls irys.getLoadedBalance() instead of asking for a second signature.
// irys.fund() itself already waits for the SOL transfer to confirm on-chain
// before returning, so a thrown error from it almost always means Irys's OWN
// bundler node (Devnet's are the less-maintained, less reliable ones) has not
// yet indexed a payment that in fact landed — not that the money never
// arrived. We ask the wallet to sign the fee transfer EXACTLY ONCE per
// attempt (matching how other token launchpads behave — never 2-3 prompts
// for one fee) and, if confirmation is slow, wait it out here with no new
// transaction rather than firing a second, separately-charged payment.
type IrysUploader = Awaited<ReturnType<typeof getIrysUploader>>
type IrysPrice = Awaited<ReturnType<IrysUploader['getPrice']>>

async function pollForBalance(
  irys: IrysUploader,
  price: IrysPrice,
  onStatus?: (status: string) => void,
): Promise<boolean> {
  const delaysMs = [3000, 3000, 5000, 5000, 8000, 8000, 8000, 8000, 8000, 8000, 8000, 8000]
  for (const delay of delaysMs) {
    await sleep(delay)
    const balance = await irys.getLoadedBalance()
    if (!price.isGreaterThan(balance)) return true
    onStatus?.('Still waiting for the storage network to catch up with your payment...')
  }
  return false
}

// IMPORTANT: every call to irys.fund() creates a NEW SOL transfer and asks for
// a NEW approval in the wallet. We only ever call it ONCE here — if it throws,
// we spend up to ~90s polling the balance (see pollForBalance above) instead
// of quietly sending a second, separately-charged transfer. If the balance
// still has not shown up after that, we give up and tell the user to simply
// retry: because the money may well be sitting there already, the price check
// at the top of this function will see it on the next attempt and skip
// funding entirely — so retrying costs at most zero extra signatures, never a
// silent double-charge.
async function ensureFunded(
  irys: Awaited<ReturnType<typeof getIrysUploader>>,
  connection: Connection,
  walletPubkey: import('@solana/web3.js').PublicKey,
  bytes: number,
  onStatus?: (status: string) => void,
) {
  const price = await irys.getPrice(bytes)
  const balance = await irys.getLoadedBalance()
  if (!price.isGreaterThan(balance)) {
    onStatus?.('The storage fee is already covered, moving on to the upload...')
    return
  }

  const topUp = price.minus(balance).multipliedBy(1.15).integerValue()

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
  try {
    await irys.fund(topUp)
    onStatus?.('The storage fee was confirmed.')
    return
  } catch (err) {
    onStatus?.('The storage network did not confirm right away — waiting for it to catch up (no new transaction is sent)...')
    if (await pollForBalance(irys, price, onStatus)) {
      onStatus?.('The fee was confirmed in the meantime, continuing...')
      return
    }

    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `the storage network did not respond — ${detail}. Your payment may still be on its way; ` +
        'please wait a moment and try creating the token again before paying a second time — ' +
        'if the fee already landed, it will be detected automatically and you will not be charged again.',
    )
  }
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
