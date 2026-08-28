import { Connection, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'

export interface WalletTokenBalance {
  mint: string
  tokenAccount: string
  programId: string
  uiAmount: string
  decimals: number
}

async function listForProgram(
  connection: Connection,
  owner: PublicKey,
  programId: PublicKey,
): Promise<WalletTokenBalance[]> {
  const { value } = await connection.getParsedTokenAccountsByOwner(owner, { programId })
  return value
    .map(({ pubkey, account }) => {
      const info = account.data.parsed?.info
      if (!info) return null
      return {
        mint: info.mint as string,
        tokenAccount: pubkey.toBase58(),
        programId: programId.toBase58(),
        uiAmount: (info.tokenAmount?.uiAmountString as string) ?? '0',
        decimals: (info.tokenAmount?.decimals as number) ?? 0,
      }
    })
    .filter((x): x is WalletTokenBalance => x !== null)
}

/** Lists the connected wallet's accounts, both legacy SPL Token and Token-2022. */
export async function listAllWalletTokens(connection: Connection, owner: PublicKey): Promise<WalletTokenBalance[]> {
  const [legacy, token2022] = await Promise.all([
    listForProgram(connection, owner, TOKEN_PROGRAM_ID),
    listForProgram(connection, owner, TOKEN_2022_PROGRAM_ID),
  ])
  return [...legacy, ...token2022]
}

/** Lists only the Token-2022 accounts (e.g. for a confidential transfer). */
export async function listWalletToken2022Accounts(
  connection: Connection,
  owner: PublicKey,
): Promise<WalletTokenBalance[]> {
  return listForProgram(connection, owner, TOKEN_2022_PROGRAM_ID)
}
