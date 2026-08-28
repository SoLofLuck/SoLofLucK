import { Connection, PublicKey } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createBurnCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import { sendInstructions, withRetry } from './sendTx'

// ---------------------------------------------------------------------------
// Token yakma (burn)
// ---------------------------------------------------------------------------
// "Burning" is not SENDING tokens to a dead address — with the SPL Token
// program's own `burn` instruction the tokens are PERMANENTLY removed both from
// the account in the wallet and from the mint's `supply` field. On explorers
// such as Solscan the total supply is seen to drop directly; no balance remains
// that anyone could point at and say "it is actually sitting in that wallet".
//
// It is needed in two separate places in the project:
//   1. Burning the LP token — after the pool is opened this makes it impossible
//      for anyone, the team included, to withdraw the liquidity (the "liquidity
//      is burned" commitment).
//   2. If the presale target is not reached, burning the $LUCK that will not be
//      minted proportionally (see the presale rules in config.ts).
//
// So the function is not LP-specific: it works for ANY SPL / Token-2022 token in
// the wallet.

export interface BurnResult {
  signature: string
  /** The amount burned (in user units, e.g. 1.5). */
  amount: string
  mint: string
  /** The mint's total supply after the burn (in user units). */
  remainingSupply: string
}

/** Finds the right program id for `getMint` (legacy SPL or Token-2022). */
async function resolveTokenProgramId(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint)
  if (!info) throw new Error('The mint address was not found on chain.')
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID
  throw new Error('This address is not an SPL Token mint account.')
}

/**
 * Converts an amount in user units (e.g. "1.5") into the token's smallest unit.
 * We do not go through Number: at 9 decimals and large amounts, floating-point
 * error could silently change the amount burned.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim().replace(',', '.')
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error('Enter a valid amount.')
  }
  const [whole, frac = ''] = trimmed.split('.')
  if (frac.length > decimals) {
    throw new Error(`This token supports at most ${decimals} decimal places.`)
  }
  const padded = frac.padEnd(decimals, '0')
  return BigInt(whole || '0') * BigInt(10) ** BigInt(decimals) + BigInt(padded || '0')
}

/** Converts an amount in the smallest unit into readable text. */
export function fromBaseUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString()
  const base = BigInt(10) ** BigInt(decimals)
  const whole = amount / base
  const frac = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

/**
 * Permanently burns tokens held in the wallet.
 *
 * IRREVERSIBLE: a burned token cannot be re-minted (and if the mint authority
 * has been revoked, cannot be minted at all). The caller must show an explicit
 * confirmation step.
 */
export async function burnTokens(
  connection: Connection,
  wallet: WalletContextState,
  mintAddress: string,
  amount: string,
  onStatus?: (status: string) => void,
): Promise<BurnResult> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Connect your wallet first to continue.')
  }

  const owner = wallet.publicKey
  let mint: PublicKey
  try {
    mint = new PublicKey(mintAddress.trim())
  } catch {
    throw new Error('Invalid mint address.')
  }

  onStatus?.('Token bilgisi okunuyor...')
  const programId = await withRetry(() => resolveTokenProgramId(connection, mint))
  const mintInfo = await withRetry(() => getMint(connection, mint, undefined, programId))
  const decimals = mintInfo.decimals

  const baseAmount = toBaseUnits(amount, decimals)
  if (baseAmount <= BigInt(0)) throw new Error('The amount to burn must be greater than zero.')

  const ata = getAssociatedTokenAddressSync(mint, owner, false, programId)

  onStatus?.('Checking the balance...')
  let held: bigint
  try {
    const balance = await withRetry(() => connection.getTokenAccountBalance(ata))
    held = BigInt(balance.value.amount)
  } catch {
    throw new Error('No account for this token was found in your wallet.')
  }
  if (baseAmount > held) {
    throw new Error(
      `Insufficient balance: you hold ${fromBaseUnits(held, decimals)} and are trying to burn ${amount}.`,
    )
  }

  // The send goes through the shared path hardened on the game side
  // (src/lib/sendTx.ts): if wallet approval takes long enough for the blockhash
  // to expire it re-signs with a fresh one, it cuts off with a timeout when a
  // mobile wallet never comes back, and it skips the preflight simulation. Not
  // doing this in the first version is what made burning fail with "Blockhash
  // not found" on the shared devnet RPC.
  const signature = await sendInstructions(
    connection,
    { publicKey: owner, signTransaction: wallet.signTransaction },
    [createBurnCheckedInstruction(ata, mint, owner, baseAmount, decimals, [], programId)],
    onStatus,
  )

  // We read the supply again AFTER the transaction — the proof that it
  // "really did drop" is shown to the user by reading the chain, not by
  // guessing.
  onStatus?.('Reading the new total supply...')
  const after = await withRetry(() => getMint(connection, mint, 'confirmed', programId))

  return {
    signature,
    amount,
    mint: mint.toBase58(),
    remainingSupply: fromBaseUnits(after.supply, decimals),
  }
}
