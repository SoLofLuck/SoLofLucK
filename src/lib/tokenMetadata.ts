import { Connection, PublicKey } from '@solana/web3.js'
import { PROGRAM_ID as METADATA_PROGRAM_ID, Metadata } from '@metaplex-foundation/mpl-token-metadata'

export interface TokenMeta {
  name: string
  symbol: string
  image?: string
}

// Aynı mint için tekrar tekrar zincirden okumayı önlemek için basit bir önbellek.
const cache = new Map<string, TokenMeta | null>()

function findMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )
  return pda
}

/**
 * Bir mint'in on-chain Metaplex Token Metadata'sından isim/sembol okur.
 * Metadata yoksa (ör. metadata'sız oluşturulmuş bir token) `null` döner.
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
        // Görsel alınamazsa isim/sembolle devam edilir — logo zorunlu değil.
      }
    }
    cache.set(key, meta)
    return meta
  } catch {
    cache.set(key, null)
    return null
  }
}
