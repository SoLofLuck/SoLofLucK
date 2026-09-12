import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  ExtensionType,
  getMintLen,
  getMinimumBalanceForRentExemptMint,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
} from '@solana/spl-token'
import {
  PROGRAM_ID as METADATA_PROGRAM_ID,
  createCreateMetadataAccountV3Instruction,
  createCreateInstruction,
  TokenStandard,
} from '@metaplex-foundation/mpl-token-metadata'
import { FEE_WALLET, FEE_AMOUNT_SOL, FEE_PER_AUTHORITY_SOL } from '../config'
import { sendInstructions } from './sendTx'
import { buildInitializeConfidentialTransferMintIx } from './confidentialTransfer'
import { SELL_LOCK_PROGRAM_ID, buildInitializeExtraAccountMetaListIx } from './sellLock'

export interface TokenFormData {
  name: string
  symbol: string
  decimals: number
  supply: string
  description: string
  imageUri: string
  website: string
  twitter: string
  telegram: string
  revokeMint: boolean
  revokeFreeze: boolean
  immutable: boolean
  // When true the mint is created with Token-2022 + the Confidential Transfer
  // extension (see src/lib/confidentialTransfer.ts) — the transfer amount is
  // kept encrypted on chain. 0 = an ordinary SPL Token.
  confidentialTransferEnabled: boolean
  // When true the mint is created with Token-2022 + a Transfer Hook bound to
  // this site's own sell-lock program (see src/lib/sellLock.ts,
  // program/sell-lock) — after a liquidity pool exists for this mint, its
  // creator can register an anti-snipe lock that rejects sales into the
  // pool's vaults for a chosen window. Mutually exclusive with confidential
  // transfer in the UI: combining a transfer hook with confidential amounts
  // is an unusual, effectively untested combination on Token-2022 and this
  // form does not attempt it.
  sellLockEnabled: boolean
}

export interface CreateTokenResult {
  mint: string
  signature: string
  tokenAccount: string
  confidentialTransferEnabled: boolean
  sellLockEnabled: boolean
}

/**
 * The total Create Token service fee: the flat base fee plus one
 * FEE_PER_AUTHORITY_SOL charge for each priced option the caller has turned
 * on. Exported so TokenForm.tsx can show the live total as the user toggles
 * checkboxes, using the exact same number this file will actually charge.
 */
export function computeTokenFeeSol(
  data: Pick<
    TokenFormData,
    'revokeMint' | 'revokeFreeze' | 'immutable' | 'confidentialTransferEnabled' | 'sellLockEnabled'
  >,
): number {
  let total = FEE_AMOUNT_SOL
  if (data.revokeMint) total += FEE_PER_AUTHORITY_SOL.revokeMint
  if (data.revokeFreeze) total += FEE_PER_AUTHORITY_SOL.revokeFreeze
  if (data.immutable) total += FEE_PER_AUTHORITY_SOL.immutable
  if (data.confidentialTransferEnabled) total += FEE_PER_AUTHORITY_SOL.confidentialTransferEnabled
  if (data.sellLockEnabled) total += FEE_PER_AUTHORITY_SOL.sellLockEnabled
  // Floating-point addition of decimals like 0.0777 + 0.1 can land on
  // 0.17770000000000002 — round to a sane precision so both the on-chain
  // lamport amount and the on-screen total are exact, round numbers.
  total = Math.round(total * 1e6) / 1e6
  return total
}

function findMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID,
  )
  return pda
}

/**
 * If the user supplies no metadata JSON URI we still create the on-chain
 * metadata with the name and symbol (uri may be an empty string); wallets and
 * explorers keep showing the name and symbol.
 */
export async function createToken(
  connection: Connection,
  wallet: WalletContextState,
  data: TokenFormData,
  onStatus?: (status: string) => void,
): Promise<CreateTokenResult> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('The wallet is not connected.')
  }

  const payer = wallet.publicKey
  const mintKeypair = Keypair.generate()
  const mint = mintKeypair.publicKey

  const decimals = data.decimals
  const supplyRaw = BigInt(data.supply) * BigInt(10) ** BigInt(decimals)

  // If Confidential Transfer or the sell-lock anti-snipe hook was chosen the
  // mint is created with Token-2022 plus that extension (see
  // src/lib/confidentialTransfer.ts / src/lib/sellLock.ts); otherwise the
  // ordinary (legacy) SPL Token program is used. The form keeps the two
  // mutually exclusive (see TokenFormData.sellLockEnabled), so at most one of
  // these is ever true.
  const confidentialTransferEnabled = data.confidentialTransferEnabled
  const sellLockEnabled = data.sellLockEnabled
  const tokenProgramId =
    confidentialTransferEnabled || sellLockEnabled ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID

  onStatus?.('Calculating the rent...')
  let mintSpace: number
  let rentLamports: number
  if (confidentialTransferEnabled) {
    mintSpace = getMintLen([ExtensionType.ConfidentialTransferMint])
    rentLamports = await connection.getMinimumBalanceForRentExemption(mintSpace)
  } else if (sellLockEnabled) {
    mintSpace = getMintLen([ExtensionType.TransferHook])
    rentLamports = await connection.getMinimumBalanceForRentExemption(mintSpace)
  } else {
    mintSpace = MINT_SIZE
    rentLamports = await getMinimumBalanceForRentExemptMint(connection)
  }

  const associatedTokenAccount = getAssociatedTokenAddressSync(
    mint,
    payer,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  const metadataPda = findMetadataPda(mint)

  const tx = new Transaction()

  // 1) Create the mint account
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      space: mintSpace,
      lamports: rentLamports,
      programId: tokenProgramId,
    }),
  )

  // The Confidential Transfer / Transfer Hook extension must be set BEFORE the
  // mint itself is initialized (a Token-2022 extension rule).
  if (confidentialTransferEnabled) {
    tx.add(buildInitializeConfidentialTransferMintIx(mint, payer))
  }
  if (sellLockEnabled) {
    tx.add(createInitializeTransferHookInstruction(mint, payer, SELL_LOCK_PROGRAM_ID, tokenProgramId))
  }

  tx.add(createInitializeMintInstruction(mint, decimals, payer, payer, tokenProgramId))

  // The sell-lock program's "extra account meta list" — the account that
  // tells Token-2022 which extra accounts (our LaunchConfig PDA) to resolve
  // and pass into the hook on every transfer. Without this the hook is never
  // actually invoked (see program/sell-lock's own comments), so it has to be
  // created now, in the same transaction as the mint itself — there is no
  // separate "finish setting up the hook" step later in this app.
  if (sellLockEnabled) {
    tx.add(buildInitializeExtraAccountMetaListIx(payer, mint))
  }

  // 2) Create the associated token account (ATA) for the wallet
  tx.add(
    createAssociatedTokenAccountInstruction(
      payer,
      associatedTokenAccount,
      payer,
      mint,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  // 3) Mint the total supply and send it to the wallet
  tx.add(createMintToInstruction(mint, associatedTokenAccount, payer, supplyRaw, [], tokenProgramId))

  // 4) The Metaplex Token Metadata account (the on-chain reference for the
  //    name, symbol, logo and description)
  //
  // For Token-2022 mints — especially those with "restrictive" extensions such as
  // Confidential Transfer or a Transfer Hook — the old CreateMetadataAccountV3
  // instruction assumes the mint is a "Programmable NFT" and rejects it (error
  // 0x99). Instead we use the newer, unified "Create" instruction, where we can
  // name the token program explicitly and mark the token standard as
  // "Fungible" — that works correctly with both legacy SPL Token and Token-2022
  // mints.
  if (confidentialTransferEnabled || sellLockEnabled) {
    tx.add(
      createCreateInstruction(
        {
          metadata: metadataPda,
          mint,
          authority: payer,
          payer,
          updateAuthority: payer,
          systemProgram: SystemProgram.programId,
          sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          splTokenProgram: tokenProgramId,
        },
        {
          createArgs: {
            __kind: 'V1',
            assetData: {
              name: data.name,
              symbol: data.symbol,
              uri: data.imageUri || '',
              sellerFeeBasisPoints: 0,
              creators: null,
              primarySaleHappened: false,
              isMutable: !data.immutable,
              tokenStandard: TokenStandard.Fungible,
              collection: null,
              uses: null,
              collectionDetails: null,
              ruleSet: null,
            },
            decimals,
            printSupply: null,
          },
        },
      ),
    )
  } else {
    tx.add(
      createCreateMetadataAccountV3Instruction(
        {
          metadata: metadataPda,
          mint,
          mintAuthority: payer,
          payer,
          updateAuthority: payer,
        },
        {
          createMetadataAccountArgsV3: {
            data: {
              name: data.name,
              symbol: data.symbol,
              uri: data.imageUri || '',
              sellerFeeBasisPoints: 0,
              creators: null,
              collection: null,
              uses: null,
            },
            isMutable: !data.immutable,
            collectionDetails: null,
          },
        },
      ),
    )
  }

  // 5) Optional: revoke the mint authority (the supply is fixed and no new
  //    tokens can be minted)
  if (data.revokeMint) {
    tx.add(createSetAuthorityInstruction(mint, payer, AuthorityType.MintTokens, null, [], tokenProgramId))
  }

  // 6) Optional: revoke the freeze authority
  if (data.revokeFreeze) {
    tx.add(
      createSetAuthorityInstruction(mint, payer, AuthorityType.FreezeAccount, null, [], tokenProgramId),
    )
  }

  // Anti-Snipe Sell Lock: permanently revoke the Transfer Hook's own
  // authority (never a user choice — this always happens when the hook is
  // enabled). This costs nothing: nothing in this app ever calls the "Update
  // Transfer Hook" instruction, so an unrevoked authority was never doing
  // anything for us. What it WAS doing is blocking every Meteora DLMM pool
  // creation attempt for the token: Meteora only allows a Transfer Hook
  // permissionlessly (no manual "token badge" approval from their team) when
  // its authority is revoked — confirmed by an on-chain
  // "UnsupportedMintExtension" rejection from a token created before this
  // fix (authority was left set to the creator's wallet), and by Meteora's
  // own docs. Revoking it here, in the very same transaction that creates
  // the hook, means every sell-lock token is Meteora-pool-eligible from the
  // moment it exists — no separate step, and no window where it is not yet
  // revoked.
  if (sellLockEnabled) {
    tx.add(
      createSetAuthorityInstruction(mint, payer, AuthorityType.TransferHookProgramId, null, [], tokenProgramId),
    )
  }

  // 7) The optional service fee (added only if the site owner has set FEE_WALLET) —
  // the base fee plus a per-authority charge for each checkbox turned on; see
  // computeTokenFeeSol above.
  const totalFeeSol = computeTokenFeeSol(data)
  if (FEE_WALLET && totalFeeSol > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey(FEE_WALLET),
        lamports: Math.round(totalFeeSol * LAMPORTS_PER_SOL),
      }),
    )
  }

  // The shared, hardened send path (see sendTx.ts). It matters especially here:
  // creating a token is a one-off and IRREVERSIBLE operation. A plain
  // `sendRawTransaction + confirmTransaction` was used before, and
  // confirmTransaction's websocket subscription can silently drop on mobile
  // during wallet approval. An error is shown even though the transaction landed,
  // the user retries — and because every attempt generated a NEW mint keypair, A
  // SECOND TOKEN appeared. Publishing the wrong mint address is a very expensive
  // mistake to correct for a project like $LUCK.
  //
  // With extraSigners the mint keypair stays THE SAME across retry cycles, so
  // retrying does not give birth to a new token.
  const signature = await sendInstructions(
    connection,
    { publicKey: payer, signTransaction: wallet.signTransaction },
    tx.instructions,
    onStatus,
    { extraSigners: [mintKeypair] },
  )

  return {
    mint: mint.toBase58(),
    signature,
    tokenAccount: associatedTokenAccount.toBase58(),
    confidentialTransferEnabled,
    sellLockEnabled,
  }
}
