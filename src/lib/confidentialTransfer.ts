import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getAccount,
  getExtensionData,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import {
  ConfidentialKeys,
  AeCiphertext,
  ElGamalCiphertext,
  ElGamalPubkey,
  PedersenOpening,
  GroupedElGamalCiphertext3Handles,
  BatchedGroupedCiphertext3HandlesValidityProofData,
  BatchedRangeProofU128Data,
  CiphertextCommitmentEqualityProofData,
  type AeKey,
  type ElGamalKeypair,
} from '@solana/zk-sdk/bundler'
import { RistrettoPoint } from '@noble/curves/ed25519.js'

// Token-2022's "Confidential Transfer" extension (it encrypts the amount, NOT
// the sender or recipient address). The instruction encoders in this file were
// ported by hand from the Rust source of the spl-token-2022-interface crate
// (extension/confidential_transfer/instruction.rs), because they are not yet in
// the official @solana/spl-token package (0.4.15, the latest release).
// Source: https://github.com/solana-program/token-2022 (spl-token-2022-interface v3.1.1)

export const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
  'ZkE1Gama1Proof11111111111111111111111111111',
)

// The discriminant of ConfidentialTransferExtension in the TokenInstruction enum (instruction.rs:1116)
const TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION = 27

// The discriminant of Reallocate in the TokenInstruction enum (instruction.rs:923)
const TOKEN_INSTRUCTION_REALLOCATE = 29

// The ConfidentialTransferInstruction sub-discriminants (instruction.rs, enum order)
const CT_IX = {
  InitializeMint: 0,
  ConfigureAccount: 2,
  Deposit: 5,
  Transfer: 7,
  ApplyPendingBalance: 8,
} as const

// The ProofInstruction discriminants (the zk_elgamal_proof program)
const PROOF_IX = {
  CloseContextState: 0,
  VerifyCiphertextCommitmentEquality: 3,
  VerifyPubkeyValidity: 4,
  VerifyBatchedRangeProofU128: 7,
  VerifyBatchedGroupedCiphertext3HandlesValidity: 12,
} as const

// The `ProofContextState<T>` account layout (solana-zk-elgamal-proof-interface
// state.rs): context_state_authority (32B) + proof_type (1B) + proof_context (T).
// The lengths of T (fixed per proof type) were verified locally against zk-sdk's
// `.context().toBytes().length` output.
const PROOF_CONTEXT_STATE_HEADER_LEN = 33 // 32 (authority) + 1 (proof_type)
const EQUALITY_PROOF_CONTEXT_LEN = 128
const VALIDITY_PROOF_CONTEXT_LEN = 352
const RANGE_PROOF_CONTEXT_LEN = 264

const AE_CIPHERTEXT_LEN = 36 // solana-zk-sdk-pod encryption/mod.rs
const ELGAMAL_CIPHERTEXT_LEN = 64 // solana-zk-sdk-pod encryption/mod.rs
const ELGAMAL_PUBKEY_LEN = 32
// spl-token-confidential-transfer-proof-generation: the transfer amount is split
// into a low (16-bit) and a high (32-bit) part so each can be encrypted and
// proven separately.
const TRANSFER_AMOUNT_LO_BITS = 16
const TRANSFER_AMOUNT_HI_BITS = 32
const REMAINING_BALANCE_BIT_LENGTH = 64
const RANGE_PROOF_PADDING_BIT_LENGTH = 16

function u64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(value)
  return buf
}

/**
 * The `TokenInstruction::ConfidentialTransferExtension` wrapper:
 * data = [27, subInstructionByte, ...fields] — see `encode_instruction` in
 * instruction.rs.
 */
function buildInstruction(
  subInstruction: number,
  data: Buffer,
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys,
    data: Buffer.concat([
      Buffer.from([TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION, subInstruction]),
      data,
    ]),
  })
}

/**
 * Initializes the mint with the Confidential Transfer extension. In
 * `createToken.ts` it has to be added IMMEDIATELY after
 * `SystemProgram.createAccount` and BEFORE `createInitializeMintInstruction`
 * (the Token-2022 extension rule — the same as for TransferHook).
 *
 * `InitializeMintData` (instruction.rs:504): authority: MaybeNull<Address> (32B,
 * None when all zero), auto_approve_new_accounts: Bool (1B),
 * auditor_elgamal_pubkey: MaybeNull<PodElGamalPubkey> (32B, None when all zero).
 * 65 bytes in total.
 */
export function buildInitializeConfidentialTransferMintIx(
  mint: PublicKey,
  authority: PublicKey | null,
): TransactionInstruction {
  const data = Buffer.concat([
    authority ? authority.toBuffer() : Buffer.alloc(32), // authority (None = all zero)
    // auto_approve_new_accounts = true: with it off, every new account would
    // additionally have to be approved by the mint authority with
    // `ApproveAccount` (for KYC/compliance scenarios) — in our simple, public
    // use case that is a pointless barrier, so we approve everyone
    // automatically.
    Buffer.from([1]),
    Buffer.alloc(32), // auditor_elgamal_pubkey = None (no auditor)
  ])
  return buildInstruction(CT_IX.InitializeMint, data, [{ pubkey: mint, isSigner: false, isWritable: true }])
}

/**
 * Grows the token account's data area so the `ConfidentialTransferAccount`
 * extension's data fits. It MUST be sent as a separate instruction BEFORE
 * `ConfigureAccount` — otherwise `ConfigureAccount` fails with
 * "InvalidAccountData" (it would be writing to the account without room having
 * been allocated for the new extension). See `TokenInstruction::Reallocate`
 * (instruction.rs:618) — data: [29, ...a 2-byte LE u16 per extension].
 */
export function buildReallocateForConfidentialTransferIx(
  tokenAccount: PublicKey,
  payer: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  const extensionTypeLE = Buffer.alloc(2)
  extensionTypeLE.writeUInt16LE(ExtensionType.ConfidentialTransferAccount)
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([TOKEN_INSTRUCTION_REALLOCATE]), extensionTypeLE]),
  })
}

/**
 * Configures the account for confidential transfers. It must be preceded, in the
 * same transaction, by `buildReallocateForConfidentialTransferIx` and then a
 * `VerifyPubkeyValidity` proof instruction (see `buildVerifyPubkeyValidityIx`)
 * — `proofInstructionOffset` is that proof's position relative to this
 * instruction (a constant `-1`, since we always place it in the immediately
 * preceding instruction).
 *
 * `ConfigureAccountInstructionData` (instruction.rs:534):
 * decryptable_zero_balance (AeCiphertext, 36B),
 * maximum_pending_balance_credit_counter (u64, 8B), proof_instruction_offset
 * (i8, 1B). 45 bytes in total.
 */
export function buildConfigureAccountIx(
  tokenAccount: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  decryptableZeroBalance: Uint8Array,
  maximumPendingBalanceCreditCounter: bigint,
): TransactionInstruction {
  if (decryptableZeroBalance.length !== AE_CIPHERTEXT_LEN) {
    throw new Error(`decryptableZeroBalance must be ${AE_CIPHERTEXT_LEN} bytes`)
  }
  const offsetByte = Buffer.alloc(1)
  offsetByte.writeInt8(-1) // proof_instruction_offset = -1 (the proof sits immediately before this instruction)
  const data = Buffer.concat([
    Buffer.from(decryptableZeroBalance),
    u64LE(maximumPendingBalanceCreditCounter),
    offsetByte,
  ])
  return buildInstruction(CT_IX.ConfigureAccount, data, [
    { pubkey: tokenAccount, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: true, isWritable: false },
  ])
}

/**
 * Moves funds from the public balance into the confidential ("pending") balance
 * — NO proof is needed, because the deposited amount is already public on chain
 * (only the destination balance is kept encrypted).
 *
 * `DepositInstructionData` (instruction.rs:565): amount (u64, 8B), decimals
 * (u8, 1B). 9 bytes in total.
 */
export function buildDepositIx(
  tokenAccount: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  const data = Buffer.concat([u64LE(amount), Buffer.from([decimals])])
  return buildInstruction(CT_IX.Deposit, data, [
    { pubkey: tokenAccount, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: true, isWritable: false },
  ])
}

/**
 * Applies the pending balance to the available balance — no proof is needed; it
 * only updates the locally AES-encrypted cache.
 *
 * `ApplyPendingBalanceData` (instruction.rs:632):
 * expected_pending_balance_credit_counter (u64, 8B),
 * new_decryptable_available_balance (AeCiphertext, 36B). 44 bytes in total.
 */
export function buildApplyPendingBalanceIx(
  tokenAccount: PublicKey,
  owner: PublicKey,
  expectedPendingBalanceCreditCounter: bigint,
  newDecryptableAvailableBalance: Uint8Array,
): TransactionInstruction {
  if (newDecryptableAvailableBalance.length !== AE_CIPHERTEXT_LEN) {
    throw new Error(`newDecryptableAvailableBalance must be ${AE_CIPHERTEXT_LEN} bytes`)
  }
  const data = Buffer.concat([
    u64LE(expectedPendingBalanceCreditCounter),
    Buffer.from(newDecryptableAvailableBalance),
  ])
  return buildInstruction(CT_IX.ApplyPendingBalance, data, [
    { pubkey: tokenAccount, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ])
}

/**
 * The verification instruction that sends the proof to the `zk_elgamal_proof`
 * program DIRECTLY inside the instruction data (without opening a context state
 * account). It must be added immediately BEFORE `ConfigureAccount` (see
 * `proofInstructionOffset = -1`).
 *
 * Format (`encode_verify_proof` in instruction.rs, context_state_info=None):
 * data = [4, ...proofBytes], with no accounts needed.
 */
export function buildVerifyPubkeyValidityIx(proofBytes: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
    keys: [],
    data: Buffer.concat([Buffer.from([PROOF_IX.VerifyPubkeyValidity]), Buffer.from(proofBytes)]),
  })
}

/** The Token-2022 ATA address used for confidential transfers. */
export function getConfidentialTokenAccount(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
}

export interface DerivedConfidentialKeys {
  elgamal: ElGamalKeypair
  ae: AeKey
}

/**
 * Derives the ElGamal + AES keys DETERMINISTICALLY from the wallet signing a
 * message (`@solana/zk-sdk`'s HKDF chain) — there is no separate private key to
 * store or back up, and the same wallet always produces the same keys.
 *
 * zk-sdk's own `ConfidentialKeys.signerMessage()` output consists of raw
 * (unreadable) bytes — wallets such as Phantom REJECT bytes like that in
 * `signMessage`, on the grounds that they might be a disguised transaction they
 * cannot show the user ("You cannot sign solana transactions using sign
 * message"). `ConfidentialKeys.fromSignature()` uses only the signature itself
 * (64 bytes) as the HKDF input and does not verify which message was signed —
 * so instead of zk-sdk's raw-byte message we have a fully readable (UTF-8) text
 * signed, unique per account. The only requirement is that the same (wallet,
 * token account) pair always produces the same text.
 */
export async function deriveConfidentialKeys(
  wallet: WalletContextState,
  tokenAccount: PublicKey,
): Promise<DerivedConfidentialKeys> {
  if (!wallet.signMessage) {
    throw new Error(
      'The connected wallet does not support message signing (signMessage), which is required to derive the confidential-transfer keys.',
    )
  }
  const message = new TextEncoder().encode(
    `SoLofLuck Confidential Transfer key derivation\nToken account: ${tokenAccount.toBase58()}`,
  )
  const signature = await wallet.signMessage(message)
  const keys = ConfidentialKeys.fromSignature(signature)
  return { elgamal: keys.elgamal(), ae: keys.ae() }
}

// ============================================================================
// Peer-to-peer confidential transfer (phase 2)
//
// Token-2022's Transfer instruction requires 3 separate zk-proofs, showing that
// the sender's "new balance" is not negative and that the encrypted amounts are
// encrypted correctly. The official recipe for producing these proofs (the
// `spl-token-confidential-transfer-proof-generation` crate, transfer.rs)
// subtracts the transfer amount from the existing encrypted balance on chain
// HOMOMORPHICALLY — but @solana/zk-sdk (v0.5.1, the latest release) does not
// expose that subtraction yet (ElGamal ciphertext arithmetic); it only exposes
// Pedersen commitment arithmetic.
//
// We fill that missing piece with a well-audited elliptic-curve library
// (@noble/curves, Ristretto255 — THE SAME curve Solana uses): a ciphertext's
// commitment and decrypt-handle components are each just a Ristretto point, and
// both are handled with standard point addition, subtraction and scalar
// multiplication — nothing exotic. The approach was verified end to end
// locally: the result produced by the manual subtraction passes zk-sdk's own
// proof.verify() functions.
// ============================================================================

function pointFromBytes(bytes: Uint8Array) {
  return RistrettoPoint.fromBytes(bytes)
}

function point32Sub(a: Uint8Array, b: Uint8Array): Uint8Array {
  return pointFromBytes(a).subtract(pointFromBytes(b)).toBytes()
}

function point32Add(a: Uint8Array, b: Uint8Array): Uint8Array {
  return pointFromBytes(a).add(pointFromBytes(b)).toBytes()
}

function point32Mul(a: Uint8Array, scalar: bigint): Uint8Array {
  return pointFromBytes(a).multiply(scalar).toBytes()
}

/**
 * Subtracts one 64-byte ElGamal ciphertext (a 32-byte commitment plus a 32-byte
 * decrypt handle) from another — handling both components as separate Ristretto
 * point subtractions.
 */
function ciphertextSubtract(a: Uint8Array, b: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from(point32Sub(a.slice(0, 32), b.slice(0, 32))),
    Buffer.from(point32Sub(a.slice(32, 64), b.slice(32, 64))),
  ])
}

function ciphertextAdd(a: Uint8Array, b: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from(point32Add(a.slice(0, 32), b.slice(0, 32))),
    Buffer.from(point32Add(a.slice(32, 64), b.slice(32, 64))),
  ])
}

function ciphertextMultiplyByU64(a: Uint8Array, scalar: bigint): Uint8Array {
  return Buffer.concat([
    Buffer.from(point32Mul(a.slice(0, 32), scalar)),
    Buffer.from(point32Mul(a.slice(32, 64), scalar)),
  ])
}

/** `ciphertext_lo + ciphertext_hi * 2^bitLength` (bkz. `try_combine_lo_hi_ciphertexts`). */
function combineLoHiCiphertext(lo: Uint8Array, hi: Uint8Array, bitLength: number): Uint8Array {
  return ciphertextAdd(lo, ciphertextMultiplyByU64(hi, 1n << BigInt(bitLength)))
}

export interface ConfidentialAccountState {
  approved: boolean
  elgamalPubkey: Uint8Array
  availableBalance: Uint8Array
  decryptableAvailableBalance: Uint8Array
  pendingBalanceCreditCounter: bigint
}

/** Decrypts an AE (AES) encrypted balance such as `decryptableAvailableBalance` or `decryptableZeroBalance`. */
export function decryptAeBalance(aeKey: AeKey, bytes: Uint8Array): bigint {
  const ciphertext = AeCiphertext.fromBytes(bytes)
  if (!ciphertext) throw new Error('The encrypted balance could not be decrypted (corrupt data).')
  const amount = ciphertext.decrypt(aeKey)
  if (amount === undefined) throw new Error('The encrypted balance could not be decrypted — the derived key may not belong to this account.')
  return amount
}

/**
 * Reads a token account's Confidential Transfer extension state from the chain
 * (the `ConfidentialTransferAccount` struct, mod.rs:66 — fixed-size fields, with
 * offsets verified byte by byte).
 */
export async function getConfidentialAccountState(
  connection: Connection,
  tokenAccount: PublicKey,
): Promise<ConfidentialAccountState> {
  const account = await getAccount(connection, tokenAccount, 'confirmed', TOKEN_2022_PROGRAM_ID)
  const ext = getExtensionData(ExtensionType.ConfidentialTransferAccount, account.tlvData)
  if (!ext) {
    throw new Error('This account is not configured for confidential transfers (run the "Configure Account" step first).')
  }
  let o = 0
  const approved = ext[o] === 1
  o += 1
  const elgamalPubkey = ext.subarray(o, o + ELGAMAL_PUBKEY_LEN)
  o += ELGAMAL_PUBKEY_LEN
  o += ELGAMAL_CIPHERTEXT_LEN // pending_balance_lo (unused)
  o += ELGAMAL_CIPHERTEXT_LEN // pending_balance_hi (unused)
  const availableBalance = ext.subarray(o, o + ELGAMAL_CIPHERTEXT_LEN)
  o += ELGAMAL_CIPHERTEXT_LEN
  const decryptableAvailableBalance = ext.subarray(o, o + AE_CIPHERTEXT_LEN)
  o += AE_CIPHERTEXT_LEN
  o += 1 // allow_confidential_credits (unused)
  o += 1 // allow_non_confidential_credits (unused)
  const pendingBalanceCreditCounter = ext.readBigUInt64LE(o)
  return { approved, elgamalPubkey, availableBalance, decryptableAvailableBalance, pendingBalanceCreditCounter }
}

/**
 * The verification instruction that sends a proof DIRECTLY inside the
 * instruction data and writes the verified "context" data (the part that
 * contains NO secret, such as the public commitment and pubkeys) into a
 * previously created account. `encode_verify_proof(Some(context_state_info),
 * ...)` (instruction.rs) — `context_state_account` is writable and
 * `context_state_authority` is read-only (no signature is needed; a pubkey match
 * is enough to close the account later).
 */
function buildVerifyProofWithContextIx(
  discriminant: number,
  proofBytes: Uint8Array,
  contextStateAccount: PublicKey,
  contextStateAuthority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
    keys: [
      { pubkey: contextStateAccount, isSigner: false, isWritable: true },
      { pubkey: contextStateAuthority, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([discriminant]), Buffer.from(proofBytes)]),
  })
}

/**
 * The instruction that closes a proof context account and reclaims the rent SOL
 * (`close_context_state`, instruction.rs). `authority` must be the same pubkey
 * that was given as `contextStateAuthority` in the account's `Verify...`
 * instruction, and it MUST SIGN this instruction.
 */
function buildCloseContextStateIx(
  contextStateAccount: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
    keys: [
      { pubkey: contextStateAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([PROOF_IX.CloseContextState]),
  })
}

/**
 * `TransferInstructionData` (instruction.rs:601): new_source_decryptable_available_balance
 * (AeCiphertext, 36B), transfer_amount_auditor_ciphertext_lo (64B),
 * transfer_amount_auditor_ciphertext_hi (64B), equality/validity/range proof
 * offsets (an i8 each). 167 bytes in total.
 *
 * IMPORTANT: ALL 3 proofs (especially the range proof, ~1000 bytes) plus the
 * transfer instruction itself never fit into ONE transaction (Solana's 1232-byte
 * transaction limit prevents it — verified locally). So the proofs are not
 * verified INLINE (via an offset) but BEFOREHAND, in separate transactions, and
 * written into a "context state" account; this instruction only references the
 * PUBKEYS of those 3 accounts (all-zero offset fields mean "use the context
 * state account", see the Rust documentation).
 */
function buildTransferInstruction(
  sourceTokenAccount: PublicKey,
  mint: PublicKey,
  destinationTokenAccount: PublicKey,
  owner: PublicKey,
  newSourceDecryptableBalance: Uint8Array,
  auditorCiphertextLo: Uint8Array,
  auditorCiphertextHi: Uint8Array,
  equalityContext: PublicKey,
  validityContext: PublicKey,
  rangeContext: PublicKey,
): TransactionInstruction {
  const offsets = Buffer.alloc(3) // all zero = use the context state account
  const data = Buffer.concat([
    Buffer.from(newSourceDecryptableBalance),
    Buffer.from(auditorCiphertextLo),
    Buffer.from(auditorCiphertextHi),
    offsets,
  ])
  return buildInstruction(CT_IX.Transfer, data, [
    { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
    { pubkey: equalityContext, isSigner: false, isWritable: false },
    { pubkey: validityContext, isSigner: false, isWritable: false },
    { pubkey: rangeContext, isSigner: false, isWritable: false },
    { pubkey: owner, isSigner: true, isWritable: false },
  ])
}

/** A single transaction step that must be signed and sent in order. */
export interface ConfidentialTransferStep {
  label: string
  instructions: TransactionInstruction[]
  /** Any temporary keys that must sign this transaction alongside the wallet. */
  extraSigners: Keypair[]
}

export interface ConfidentialTransferPlan {
  steps: ConfidentialTransferStep[]
  newDecryptedBalance: bigint
}

/**
 * Produces all the proofs for a confidential transfer and prepares, in order,
 * the transaction steps that have to be sent. The recipe is identical to the
 * `transfer_split_proof_data` function of the
 * `spl-token-confidential-transfer-proof-generation` crate — the only difference
 * is that we perform the step of subtracting the amount from the existing
 * on-chain balance (not exposed in `@solana/zk-sdk`) with `ciphertextSubtract`
 * above.
 *
 * The `connection` parameter is used only to compute the rent-exempt lamport
 * amount for the proof "context" accounts (see below).
 */
export async function planConfidentialTransfer(
  connection: Connection,
  sourceTokenAccount: PublicKey,
  mint: PublicKey,
  destinationTokenAccount: PublicKey,
  owner: PublicKey,
  sourceKeys: DerivedConfidentialKeys,
  currentAvailableBalanceCiphertext: Uint8Array,
  currentDecryptableAvailableBalance: Uint8Array,
  destinationElGamalPubkeyBytes: Uint8Array,
  transferAmount: bigint,
): Promise<ConfidentialTransferPlan> {
  const currentDecryptableCt = AeCiphertext.fromBytes(currentDecryptableAvailableBalance)
  if (!currentDecryptableCt) throw new Error('The current balance could not be decrypted (corrupt AE ciphertext).')
  const currentBalance = currentDecryptableCt.decrypt(sourceKeys.ae)
  if (currentBalance === undefined) {
    throw new Error('The current balance could not be decrypted — the derived key may not belong to this account.')
  }
  if (transferAmount > currentBalance) {
    throw new Error(
      `Insufficient confidential balance: you hold ${currentBalance} units and are trying to send ${transferAmount}.`,
    )
  }
  const newBalance = currentBalance - transferAmount

  const sourcePubkey = sourceKeys.elgamal.pubkey()
  const destPubkey = ElGamalPubkey.fromBytes(destinationElGamalPubkeyBytes)
  // No auditor is defined on the mint — we use the all-zero "empty" ElGamal
  // public key, which matches `ElGamalPubkey::default()` on the Rust side (see
  // the protocol's MaybeNull sentinel rule — verified locally: the zero bytes
  // decode validly).
  const auditorPubkey = ElGamalPubkey.fromBytes(new Uint8Array(ELGAMAL_PUBKEY_LEN))

  const loMask = (1n << BigInt(TRANSFER_AMOUNT_LO_BITS)) - 1n
  const amountLo = transferAmount & loMask
  const amountHi = transferAmount >> BigInt(TRANSFER_AMOUNT_LO_BITS)

  const openingLo = new PedersenOpening()
  const openingHi = new PedersenOpening()
  const newOpening = new PedersenOpening()
  const paddingOpening = new PedersenOpening()

  const groupedLo = GroupedElGamalCiphertext3Handles.encryptWith(
    sourcePubkey,
    destPubkey,
    auditorPubkey,
    amountLo,
    openingLo,
  )
  const groupedHi = GroupedElGamalCiphertext3Handles.encryptWith(
    sourcePubkey,
    destPubkey,
    auditorPubkey,
    amountHi,
    openingHi,
  )

  // The lo/hi ciphertexts from the sender's own view (they use the same
  // commitment/opening pair as the grouped ciphertext — the commitment is
  // independent of which recipient key it was encrypted with).
  const sourceCtLo = sourcePubkey.encryptWith(amountLo, openingLo)
  const sourceCtHi = sourcePubkey.encryptWith(amountHi, openingHi)
  const combinedSourceCt = combineLoHiCiphertext(
    sourceCtLo.toBytes(),
    sourceCtHi.toBytes(),
    TRANSFER_AMOUNT_LO_BITS,
  )
  const newBalanceCtBytes = ciphertextSubtract(currentAvailableBalanceCiphertext, combinedSourceCt)
  const newBalanceCt = ElGamalCiphertext.fromBytes(newBalanceCtBytes)
  if (!newBalanceCt) throw new Error('The new balance ciphertext could not be created.')

  const newCommitment = sourcePubkey.encryptWith(newBalance, newOpening).commitment()

  const equalityProof = new CiphertextCommitmentEqualityProofData(
    sourceKeys.elgamal,
    newBalanceCt,
    newCommitment,
    newOpening,
    newBalance,
  )
  const validityProof = new BatchedGroupedCiphertext3HandlesValidityProofData(
    sourcePubkey,
    destPubkey,
    auditorPubkey,
    groupedLo,
    groupedHi,
    amountLo,
    amountHi,
    openingLo,
    openingHi,
  )
  // IMPORTANT: the `openings` ARRAY parameter of `BatchedRangeProofU128Data`
  // TAKES OWNERSHIP of the `PedersenOpening` objects passed to it (invalidating
  // the JS-side wrapper), unlike the singular (non-array) parameters in zk-sdk's
  // wasm-bindgen bindings — so EVERYTHING that uses `openingLo`/`openingHi` must
  // be finished BEFORE rangeProof is created. Changing this order produces a
  // "null pointer passed to rust" error (verified locally: reordering the object
  // reuse reproduced the error).
  const newSourceDecryptableBalance = sourceKeys.ae.encrypt(newBalance).toBytes()
  const auditorCiphertextLo = auditorPubkey.encryptWith(amountLo, openingLo).toBytes()
  const auditorCiphertextHi = auditorPubkey.encryptWith(amountHi, openingHi).toBytes()

  const paddingCommitment = sourcePubkey.encryptWith(0n, paddingOpening).commitment()
  const rangeProof = new BatchedRangeProofU128Data(
    [newCommitment, sourceCtLo.commitment(), sourceCtHi.commitment(), paddingCommitment],
    new BigUint64Array([newBalance, amountLo, amountHi, 0n]),
    new Uint8Array([
      REMAINING_BALANCE_BIT_LENGTH,
      TRANSFER_AMOUNT_LO_BITS,
      TRANSFER_AMOUNT_HI_BITS,
      RANGE_PROOF_PADDING_BIT_LENGTH,
    ]),
    [newOpening, openingLo, openingHi, paddingOpening],
  )

  // IMPORTANT: putting ALL 3 proofs (especially the ~1000-byte range proof) plus
  // the transfer instruction into ONE transaction exceeds Solana's 1232-byte
  // transaction limit (verified locally — on a real device it produced "Index out
  // of range" / "null pointer passed to rust" errors). Instead we move to the
  // "proof context account" method the official reference clients (the spl-token
  // CLI and others) use: each proof is verified in its own transaction and writes
  // a small "context" summary into a temporary account; the actual Transfer
  // instruction references the pubkeys of those 3 accounts (not the proof bytes
  // themselves) and therefore stays very small. Because the range proof alone
  // (create + verify together) also exceeds the limit, creating the account and
  // verifying it were split into separate transactions.
  const eqCtxKeypair = Keypair.generate()
  const validityCtxKeypair = Keypair.generate()
  const rangeCtxKeypair = Keypair.generate()

  const [eqRent, validityRent, rangeRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(PROOF_CONTEXT_STATE_HEADER_LEN + EQUALITY_PROOF_CONTEXT_LEN),
    connection.getMinimumBalanceForRentExemption(PROOF_CONTEXT_STATE_HEADER_LEN + VALIDITY_PROOF_CONTEXT_LEN),
    connection.getMinimumBalanceForRentExemption(PROOF_CONTEXT_STATE_HEADER_LEN + RANGE_PROOF_CONTEXT_LEN),
  ])

  function createContextAccountIx(newAccount: PublicKey, space: number, lamports: number): TransactionInstruction {
    return SystemProgram.createAccount({
      fromPubkey: owner,
      newAccountPubkey: newAccount,
      lamports,
      space,
      programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
    })
  }

  const steps: ConfidentialTransferStep[] = [
    {
      label: 'Verifying the equality proof',
      instructions: [
        createContextAccountIx(
          eqCtxKeypair.publicKey,
          PROOF_CONTEXT_STATE_HEADER_LEN + EQUALITY_PROOF_CONTEXT_LEN,
          eqRent,
        ),
        buildVerifyProofWithContextIx(
          PROOF_IX.VerifyCiphertextCommitmentEquality,
          equalityProof.toBytes(),
          eqCtxKeypair.publicKey,
          owner,
        ),
      ],
      extraSigners: [eqCtxKeypair],
    },
    {
      label: 'Verifying the validity proof',
      instructions: [
        createContextAccountIx(
          validityCtxKeypair.publicKey,
          PROOF_CONTEXT_STATE_HEADER_LEN + VALIDITY_PROOF_CONTEXT_LEN,
          validityRent,
        ),
        buildVerifyProofWithContextIx(
          PROOF_IX.VerifyBatchedGroupedCiphertext3HandlesValidity,
          validityProof.toBytes(),
          validityCtxKeypair.publicKey,
          owner,
        ),
      ],
      extraSigners: [validityCtxKeypair],
    },
    {
      label: 'Creating the account for the range proof',
      instructions: [
        createContextAccountIx(
          rangeCtxKeypair.publicKey,
          PROOF_CONTEXT_STATE_HEADER_LEN + RANGE_PROOF_CONTEXT_LEN,
          rangeRent,
        ),
      ],
      extraSigners: [rangeCtxKeypair],
    },
    {
      // The range proof (~1000 bytes) on its own plus creating the account is
      // already at or above the 1232-byte limit, hence a separate step.
      label: 'Verifying the range proof',
      instructions: [
        buildVerifyProofWithContextIx(
          PROOF_IX.VerifyBatchedRangeProofU128,
          rangeProof.toBytes(),
          rangeCtxKeypair.publicKey,
          owner,
        ),
      ],
      extraSigners: [],
    },
    {
      label: 'Sending the confidential transfer',
      instructions: [
        buildTransferInstruction(
          sourceTokenAccount,
          mint,
          destinationTokenAccount,
          owner,
          newSourceDecryptableBalance,
          auditorCiphertextLo,
          auditorCiphertextHi,
          eqCtxKeypair.publicKey,
          validityCtxKeypair.publicKey,
          rangeCtxKeypair.publicKey,
        ),
        // As soon as the transfer succeeds we close the context accounts, which
        // are no longer needed, and reclaim the rent SOL — inside the same
        // transaction (atomically: if the transfer fails, the closes are not
        // applied either).
        buildCloseContextStateIx(eqCtxKeypair.publicKey, owner, owner),
        buildCloseContextStateIx(validityCtxKeypair.publicKey, owner, owner),
        buildCloseContextStateIx(rangeCtxKeypair.publicKey, owner, owner),
      ],
      extraSigners: [],
    },
  ]

  return { steps, newDecryptedBalance: newBalance }
}

// The wallet token listing now lives in src/lib/walletTokens.ts (shared between
// legacy SPL and Token-2022, and with LiquidityPage's coin picker).
