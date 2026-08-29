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
import { FEE_WALLET, FEE_AMOUNT_SOL } from '../config'
import { sendInstructions } from './sendTx'
import { buildInitializeConfidentialTransferMintIx } from './confidentialTransfer'

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
}

export interface CreateTokenResult {
  mint: string
  signature: string
  tokenAccount: string
  confidentialTransferEnabled: boolean
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

  // If Confidential Transfer was chosen the mint is created with Token-2022 plus
  // that extension (see src/lib/confidentialTransfer.ts); otherwise the ordinary
  // (legacy) SPL Token program is used.
  const confidentialTransferEnabled = data.confidentialTransferEnabled
  const tokenProgramId = confidentialTransferEnabled ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID

  onStatus?.('Calculating the rent...')
  let mintSpace: number
  let rentLamports: number
  if (confidentialTransferEnabled) {
    mintSpace = getMintLen([ExtensionType.ConfidentialTransferMint])
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

  // The Confidential Transfer extension must be set BEFORE the mint itself is
  // initialized (a Token-2022 extension rule).
  if (confidentialTransferEnabled) {
    tx.add(buildInitializeConfidentialTransferMintIx(mint, payer))
  }

  tx.add(createInitializeMintInstruction(mint, decimals, payer, payer, tokenProgramId))

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
  // Confidential Transfer — the old CreateMetadataAccountV3 instruction assumes
  // the mint is a "Programmable NFT" and rejects it (error 0x99). Instead we use
  // the newer, unified "Create" instruction, where we can name the token program
  // explicitly and mark the token standard as "Fungible" — that works correctly
  // with both legacy SPL Token and Token-2022 mints.
  if (confidentialTransferEnabled) {
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

  // 7) The optional service fee (added only if the site owner has set FEE_WALLET)
  if (FEE_WALLET && FEE_AMOUNT_SOL > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey(FEE_WALLET),
        lamports: Math.round(FEE_AMOUNT_SOL * LAMPORTS_PER_SOL),
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
  }
}
