// Uploads the token logo and its metadata JSON to IPFS via Pinata instead of
// paying for Arweave storage from the user's own wallet (see src/lib/irys.ts,
// removed): that path needed a separate signed SOL transfer per upload, and
// on Devnet especially Irys's own bundler node was slow/unreliable to
// register that payment — the user ended up asked for 2-3 wallet signatures
// and sometimes still got "the storage network did not respond". Pinata is a
// plain authenticated HTTP upload: no wallet interaction, no on-chain
// transaction, so the whole logo+metadata upload only takes as long as the
// HTTP requests themselves (typically a couple of seconds), and token
// creation is back down to the ONE signature users expect (the mint
// transaction itself).
//
// The JWT below only has the "Files: Write" permission (see the API key setup
// this was created with) — it can pin files to this Pinata account and
// nothing else (it cannot read, delete, or touch any wallet or funds), so
// shipping it in the client bundle carries no real risk beyond someone else
// using up this account's free storage quota.
const PINATA_JWT = import.meta.env.VITE_PINATA_JWT as string | undefined
const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files'
const PINATA_GATEWAY = 'https://gateway.pinata.cloud/ipfs/'

export interface OnChainMetadataInput {
  name: string
  symbol: string
  description: string
  website: string
  twitter: string
  telegram: string
}

async function pinFile(file: File | Blob, name: string): Promise<string> {
  if (!PINATA_JWT) {
    throw new Error('image hosting is not configured on this deployment (missing Pinata key)')
  }

  const formData = new FormData()
  formData.append('file', file, name)
  formData.append('name', name)
  formData.append('network', 'public')

  let res: Response
  try {
    res = await fetch(PINATA_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${PINATA_JWT}` },
      body: formData,
    })
  } catch (err) {
    throw new Error(err instanceof Error ? `network error: ${err.message}` : 'network error')
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`upload failed (${res.status}): ${detail || res.statusText}`)
  }

  const json = (await res.json()) as { data?: { cid?: string } }
  const cid = json.data?.cid
  if (!cid) {
    throw new Error('the upload succeeded but no file identifier was returned')
  }
  return `${PINATA_GATEWAY}${cid}`
}

export async function uploadLogoAndMetadata(
  file: File,
  input: OnChainMetadataInput,
  onStatus?: (status: string) => void,
): Promise<string> {
  onStatus?.(`Uploading the logo (${(file.size / 1024).toFixed(0)} KB)...`)
  let imageUrl: string
  try {
    imageUrl = await pinFile(file, file.name || 'logo')
  } catch (err) {
    throw stageError('The logo could not be uploaded', err)
  }
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
  const metadataBlob = new Blob([JSON.stringify(metadataJson)], { type: 'application/json' })

  onStatus?.('Uploading the metadata...')
  try {
    const metadataUrl = await pinFile(metadataBlob, 'metadata.json')
    onStatus?.('The metadata was uploaded.')
    return metadataUrl
  } catch (err) {
    throw stageError('The metadata could not be uploaded', err)
  }
}

function stageError(prefix: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err)
  return new Error(`${prefix}: ${detail}`)
}
