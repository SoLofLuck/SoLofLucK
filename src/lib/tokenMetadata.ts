import { Connection, PublicKey } from '@solana/web3.js'
import { PROGRAM_ID as METADATA_PROGRAM_ID, Metadata } from '@metaplex-foundation/mpl-token-metadata'

export interface TokenMeta {
  name: string
  symbol: string
  image?: string
}

// A simple cache, so the same mint is not read from the chain over and over.
const cache = new Map<string, TokenMeta | null>()

function findMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )
  return pda
}

/**
 * Reads the name and symbol from a mint's on-chain Metaplex Token Metadata.
 * Returns `null` if there is no metadata (e.g. a token created without any).
 */
export async function getTokenMetadata(connection: Connection, mint: PublicKey): Promise<TokenMeta | null> {
  const key = mint.toBase58()
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  try {
    const pda = findMetadataPda(mint)
    const metadata = await Metadata.fromAccountAddress(connection, pda)
    const meta: TokenMeta = {
      name: metadata.data.name.replace(/\0/g, '').trim(),
      symbol: metadata.data.symbol.replace(/\0/g, '').trim(),
    }
    const uri = metadata.data.uri.replace(/\0/g, '').trim()
    if (uri) {
      try {
        const res = await fetch(uri)
        const json = await res.json()
        if (typeof json?.image === 'string' && json.image) meta.image = json.image
      } catch {
        // If the image cannot be fetched we continue with the name and symbol —
        // a logo is not required.
      }
    }
    cache.set(key, meta)
    return meta
  } catch {
    cache.set(key, null)
    return null
  }
}
