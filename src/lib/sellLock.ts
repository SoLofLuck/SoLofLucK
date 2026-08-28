import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { getExtraAccountMetaAddress, getMint, getTransferHook, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import BN from 'bn.js'
import { sendInstructions } from './sendTx'

// The "sell lock" (anti-snipe) program deployed to Devnet. Source code and
// deploy history: the program/sell-lock/ folder. This is a separate Solana
// program written by this site that implements the Token-2022 Transfer Hook
// interface — it was built and verified on Devnet independently of the token
// creation and pool flows.
export const SELL_LOCK_PROGRAM_ID = new PublicKey(
  '3SgfMbBMbsaB21QaZgcGmRYbUTGGEyErJipxM8u2Uqy5',
)

// Anchor discriminators = sha256("global:<instruction_name>")[0..8].
const INITIALIZE_EXTRA_ACCOUNT_META_LIST_DISCRIMINATOR = Buffer.from([
  0x5c, 0xc5, 0xae, 0xc5, 0x29, 0x7c, 0x13, 0x03,
])
const REGISTER_LAUNCH_DISCRIMINATOR = Buffer.from([
  0x72, 0x72, 0x43, 0x17, 0x29, 0x46, 0x00, 0xe1,
])

export interface SellLockDurationOption {
  label: string
  seconds: number
}

// seconds: 0 = no lock (disabled).
export const SELL_LOCK_DURATION_OPTIONS: SellLockDurationOption[] = [
  { label: 'Disabled (no sell lock)', seconds: 0 },
  { label: '15 Dakika', seconds: 900 },
  { label: '1 Saat', seconds: 3600 },
  { label: '5 Saat', seconds: 18_000 },
  { label: '24 Saat', seconds: 86_400 },
]

export function formatSellLockDuration(seconds: number): string {
  const match = SELL_LOCK_DURATION_OPTIONS.find((o) => o.seconds === seconds)
  return match?.label ?? `${seconds} saniye`
}

function getLaunchConfigPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('launch-config'), mint.toBuffer()],
    SELL_LOCK_PROGRAM_ID,
  )
  return pda
}

export function buildInitializeExtraAccountMetaListIx(
  payer: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const extraAccountMetaList = getExtraAccountMetaAddress(mint, SELL_LOCK_PROGRAM_ID)
  return new TransactionInstruction({
    programId: SELL_LOCK_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: extraAccountMetaList, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: INITIALIZE_EXTRA_ACCOUNT_META_LIST_DISCRIMINATOR,
  })
}

export function buildRegisterLaunchIx(
  signer: PublicKey,
  mint: PublicKey,
  poolVaultA: PublicKey,
  poolVaultB: PublicKey,
  durationSeconds: number,
): TransactionInstruction {
  const launchConfig = getLaunchConfigPda(mint)
  const data = Buffer.concat([
    REGISTER_LAUNCH_DISCRIMINATOR,
    new BN(durationSeconds).toArrayLike(Buffer, 'le', 8),
  ])
  return new TransactionInstruction({
    programId: SELL_LOCK_PROGRAM_ID,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: launchConfig, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: poolVaultA, isSigner: false, isWritable: false },
      { pubkey: poolVaultB, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

// Called once immediately after the pool is created — it writes the duration
// and the pool's vault addresses permanently to the chain (see
// program/sell-lock).
export async function registerLaunch(
  connection: Connection,
  wallet: WalletContextState,
  mint: PublicKey,
  poolVaultA: PublicKey,
  poolVaultB: PublicKey,
  durationSeconds: number,
  onStatus?: (status: string) => void,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Connect your wallet first to continue.')
  }

  // The shared, hardened send path (see sendTx.ts) — the same as every other
  // on-chain transaction on the site. This flow is not as risky as the presale
  // on its own (the registration can be repeated), but the spurious "failed"
  // messages a plain send produces on mobile were pushing the user to sign a
  // second time here too, for no reason.
  const signature = await sendInstructions(
    connection,
    { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction },
    [buildRegisterLaunchIx(wallet.publicKey, mint, poolVaultA, poolVaultB, durationSeconds)],
    onStatus,
  )

  return signature
}

// Reads from the chain whether a mint has a Transfer Hook extension bound to our
// sell-lock program (returns false for non-Token-2022 mints, and for mints whose
// hook belongs to another program).
export async function hasSellLockHook(connection: Connection, mint: PublicKey): Promise<boolean> {
  try {
    const mintInfo = await getMint(connection, mint, undefined, TOKEN_2022_PROGRAM_ID)
    const hook = getTransferHook(mintInfo)
    return hook !== null && hook.programId.equals(SELL_LOCK_PROGRAM_ID)
  } catch {
    return false
  }
}
