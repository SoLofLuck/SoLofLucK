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

// Token-2022'nin "Confidential Transfer" extension'ı (miktarı şifreler,
// gönderen/alıcı adresini DEĞİL). Bu dosyadaki instruction encoder'lar,
// resmi @solana/spl-token paketinde (0.4.15, en güncel sürüm) henüz
// bulunmadığı için spl-token-2022-interface crate'inin Rust kaynağından
// (extension/confidential_transfer/instruction.rs) elle port edildi.
// Kaynak: https://github.com/solana-program/token-2022 (spl-token-2022-interface v3.1.1)

export const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
  'ZkE1Gama1Proof11111111111111111111111111111',
)

// TokenInstruction enum'unda ConfidentialTransferExtension'ın discriminant'ı (instruction.rs:1116)
const TOKEN_INSTRUCTION_CONFIDENTIAL_TRANSFER_EXTENSION = 27

// TokenInstruction enum'unda Reallocate'in discriminant'ı (instruction.rs:923)
const TOKEN_INSTRUCTION_REALLOCATE = 29

// ConfidentialTransferInstruction alt-discriminant'ları (instruction.rs, enum sırası)
const CT_IX = {
  InitializeMint: 0,
  ConfigureAccount: 2,
  Deposit: 5,
  Transfer: 7,
  ApplyPendingBalance: 8,
} as const

// ProofInstruction (zk_elgamal_proof programı) discriminant'ları
const PROOF_IX = {
  CloseContextState: 0,
  VerifyCiphertextCommitmentEquality: 3,
  VerifyPubkeyValidity: 4,
  VerifyBatchedRangeProofU128: 7,
  VerifyBatchedGroupedCiphertext3HandlesValidity: 12,
} as const

// `ProofContextState<T>` hesap düzeni (solana-zk-elgamal-proof-interface
// state.rs): context_state_authority (32B) + proof_type (1B) + proof_context (T).
// T'nin (her proof tipi için sabit boyutlu) uzunlukları zk-sdk'nin
// `.context().toBytes().length` çıktısıyla yerel olarak doğrulandı.
const PROOF_CONTEXT_STATE_HEADER_LEN = 33 // 32 (authority) + 1 (proof_type)
const EQUALITY_PROOF_CONTEXT_LEN = 128
const VALIDITY_PROOF_CONTEXT_LEN = 352
const RANGE_PROOF_CONTEXT_LEN = 264

const AE_CIPHERTEXT_LEN = 36 // solana-zk-sdk-pod encryption/mod.rs
const ELGAMAL_CIPHERTEXT_LEN = 64 // solana-zk-sdk-pod encryption/mod.rs
const ELGAMAL_PUBKEY_LEN = 32
// spl-token-confidential-transfer-proof-generation: transfer miktarı, ayrı ayrı
// şifrelenip ispatlanabilmesi için düşük (16 bit) ve yüksek (32 bit) parçalara bölünüyor.
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
 * `TokenInstruction::ConfidentialTransferExtension` sarmalayıcısı:
 * data = [27, altInstructionByte, ...alanlar] — bkz. instruction.rs `encode_instruction`.
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
 * Mint'i Confidential Transfer extension'ıyla başlatır. `createToken.ts`'te
 * `SystemProgram.createAccount`'tan HEMEN sonra, `createInitializeMintInstruction`'dan
 * ÖNCE eklenmesi gerekir (Token-2022 extension kuralı — TransferHook'ta olduğu gibi).
 *
 * `InitializeMintData` (instruction.rs:504): authority: MaybeNull<Address> (32B, hepsi
 * sıfırsa None), auto_approve_new_accounts: Bool (1B), auditor_elgamal_pubkey:
 * MaybeNull<PodElGamalPubkey> (32B, hepsi sıfırsa None). Toplam 65 byte.
 */
export function buildInitializeConfidentialTransferMintIx(
  mint: PublicKey,
  authority: PublicKey | null,
): TransactionInstruction {
  const data = Buffer.concat([
    authority ? authority.toBuffer() : Buffer.alloc(32), // authority (None = tüm sıfır)
    // auto_approve_new_accounts = true: kapalı olursa her yeni hesabın mint
    // yetkilisi tarafından ayrıca `ApproveAccount` ile onaylanması gerekir
    // (KYC/uyum senaryoları için) — bizim basit, herkese açık kullanım
    // senaryomuzda bu gereksiz bir engel, o yüzden herkesi otomatik onaylıyoruz.
    Buffer.from([1]),
    Buffer.alloc(32), // auditor_elgamal_pubkey = None (denetçi yok)
  ])
  return buildInstruction(CT_IX.InitializeMint, data, [{ pubkey: mint, isSigner: false, isWritable: true }])
}

/**
 * Token hesabının veri alanını, `ConfidentialTransferAccount` extension'ının
 * verisini sığdıracak şekilde büyütür. `ConfigureAccount`'tan ÖNCE, ayrı bir
 * instruction olarak gönderilmesi ZORUNLU — aksi halde `ConfigureAccount`
 * "InvalidAccountData" hatasıyla başarısız olur (hesap, yeni extension için
 * yer ayrılmadan yazılmaya çalışılıyor). Bkz. `TokenInstruction::Reallocate`
 * (instruction.rs:618) — data: [29, ...her extension için 2 byte LE u16].
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
 * Hesabı confidential transfer için yapılandırır. ÖNCESİNDE aynı
 * transaction'da sırasıyla `buildReallocateForConfidentialTransferIx` ve bir
 * `VerifyPubkeyValidity` proof instruction'ı olmalı (bkz.
 * `buildVerifyPubkeyValidityIx`) — `proofInstructionOffset` bu instruction'a
 * göre o proof'un göreli konumu (biz her zaman bir önceki instruction'a
 * koyduğumuz için sabit `-1`).
 *
 * `ConfigureAccountInstructionData` (instruction.rs:534): decryptable_zero_balance
 * (AeCiphertext, 36B), maximum_pending_balance_credit_counter (u64, 8B),
 * proof_instruction_offset (i8, 1B). Toplam 45 byte.
 */
export function buildConfigureAccountIx(
  tokenAccount: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  decryptableZeroBalance: Uint8Array,
  maximumPendingBalanceCreditCounter: bigint,
): TransactionInstruction {
  if (decryptableZeroBalance.length !== AE_CIPHERTEXT_LEN) {
    throw new Error(`decryptableZeroBalance ${AE_CIPHERTEXT_LEN} byte olmalı`)
  }
  const offsetByte = Buffer.alloc(1)
  offsetByte.writeInt8(-1) // proof_instruction_offset = -1 (proof bu instruction'dan hemen önce)
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
 * Herkese açık bakiyeden gizli ("pending") bakiyeye aktarır — proof
 * GEREKMEZ, çünkü yatırılan miktar zaten zincirde açık (yalnızca hedef
 * bakiye şifreli tutulur).
 *
 * `DepositInstructionData` (instruction.rs:565): amount (u64, 8B), decimals (u8, 1B). Toplam 9 byte.
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
 * Bekleyen (pending) bakiyeyi kullanılabilir (available) bakiyeye işler —
 * proof gerekmez, salt yerel AES-şifreli önbelleği günceller.
 *
 * `ApplyPendingBalanceData` (instruction.rs:632): expected_pending_balance_credit_counter
 * (u64, 8B), new_decryptable_available_balance (AeCiphertext, 36B). Toplam 44 byte.
 */
export function buildApplyPendingBalanceIx(
  tokenAccount: PublicKey,
  owner: PublicKey,
  expectedPendingBalanceCreditCounter: bigint,
  newDecryptableAvailableBalance: Uint8Array,
): TransactionInstruction {
  if (newDecryptableAvailableBalance.length !== AE_CIPHERTEXT_LEN) {
    throw new Error(`newDecryptableAvailableBalance ${AE_CIPHERTEXT_LEN} byte olmalı`)
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
 * `zk_elgamal_proof` programına, proof'u DOĞRUDAN instruction data içinde
 * (context state hesabı açmadan) gönderen doğrulama instruction'ı.
 * `ConfigureAccount`'tan hemen ÖNCE eklenmeli (bkz. `proofInstructionOffset = -1`).
 *
 * Format (instruction.rs `encode_verify_proof`, context_state_info=None):
 * data = [4, ...proofBytes], hiç hesap gerekmiyor.
 */
export function buildVerifyPubkeyValidityIx(proofBytes: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({
    programId: ZK_ELGAMAL_PROOF_PROGRAM_ID,
    keys: [],
    data: Buffer.concat([Buffer.from([PROOF_IX.VerifyPubkeyValidity]), Buffer.from(proofBytes)]),
  })
}

/** Confidential transfer için kullanılan Token-2022 ATA adresi. */
export function getConfidentialTokenAccount(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
}

export interface DerivedConfidentialKeys {
  elgamal: ElGamalKeypair
  ae: AeKey
}

/**
 * ElGamal + AES anahtarlarını, cüzdanın bir mesajı imzalamasından
 * DETERMİNİSTİK olarak türetir (`@solana/zk-sdk`'nin HKDF zinciri) — ayrı
 * bir private key saklamaya/yedeklemeye gerek yok, aynı cüzdanla her zaman
 * aynı anahtarlar üretilir.
 *
 * zk-sdk'nin kendi `ConfidentialKeys.signerMessage()` çıktısı ham (okunamaz)
 * baytlardan oluşuyor — Phantom gibi cüzdanlar, kullanıcıya gösteremediği
 * bu tür baytları "gizlenmiş bir işlem olabilir" diye `signMessage`'da
 * REDDEDİYOR ("You cannot sign solana transactions using sign message").
 * `ConfidentialKeys.fromSignature()` yalnızca imzanın kendisini (64 byte)
 * HKDF girdisi olarak kullanıyor, hangi mesajın imzalandığını doğrulamıyor
 * — bu yüzden zk-sdk'nin ham-bayt mesajı yerine, her hesap için benzersiz,
 * tamamen okunabilir (UTF-8) bir metin imzalatıyoruz. Tek şart: aynı
 * (cüzdan, token hesabı) çifti için her zaman aynı metnin üretilmesi.
 */
export async function deriveConfidentialKeys(
  wallet: WalletContextState,
  tokenAccount: PublicKey,
): Promise<DerivedConfidentialKeys> {
  if (!wallet.signMessage) {
    throw new Error(
      'Bağlı cüzdan mesaj imzalamayı (signMessage) desteklemiyor — gizli transfer anahtarlarını türetmek için bu gerekli.',
    )
  }
  const message = new TextEncoder().encode(
    `0nRCoin Confidential Transfer key derivation\nToken account: ${tokenAccount.toBase58()}`,
  )
  const signature = await wallet.signMessage(message)
  const keys = ConfidentialKeys.fromSignature(signature)
  return { elgamal: keys.elgamal(), ae: keys.ae() }
}

// ============================================================================
// Kişiden kişiye gizli transfer (Faz 2)
//
// Token-2022'nin Transfer instruction'ı, göndericinin "yeni bakiyesi"nin
// negatif olmadığını ve şifreli tutarların doğru şekilde şifrelendiğini
// kanıtlayan 3 ayrı zk-proof gerektiriyor. Bu proof'ları üretmenin resmi
// tarifi (`spl-token-confidential-transfer-proof-generation` crate,
// transfer.rs) zincirdeki mevcut şifreli bakiyeden transfer tutarını
// HOMOMORFİK OLARAK ÇIKARMAYI gerektiriyor — ama @solana/zk-sdk (v0.5.1,
// en güncel sürüm) bu çıkarma işlemini (ElGamal şifreli metin aritmetiği)
// henüz dışa açmıyor, sadece Pedersen taahhüdü aritmetiğini açıyor.
//
// Bu eksik parçayı, iyi denetlenmiş bir eliptik eğri kütüphanesiyle
// (@noble/curves, Ristretto255 — Solana'nın kullandığı AYNI eğri)
// dolduruyoruz: şifreli metnin taahhüt (commitment) ve çözme tutamacı
// (decrypt handle) bileşenleri sadece birer Ristretto noktası, ikisi de
// standart nokta toplama/çıkarma/skaler çarpma ile işleniyor — egzotik bir
// şey değil. Bu yaklaşım yerel olarak uçtan uca doğrulandı: manuel çıkarma
// ile üretilen sonuç, zk-sdk'nin kendi proof.verify() fonksiyonlarını
// başarıyla geçiyor.
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
 * 64 byte'lık bir ElGamal şifreli metni (32 byte taahhüt + 32 byte çözme
 * tutamacı) diğer bir şifreli metinden çıkarır — her iki bileşeni de ayrı
 * ayrı Ristretto nokta çıkarması olarak işler.
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

/** `decryptableAvailableBalance`/`decryptableZeroBalance` gibi AE (AES) şifreli bir bakiyeyi çözer. */
export function decryptAeBalance(aeKey: AeKey, bytes: Uint8Array): bigint {
  const ciphertext = AeCiphertext.fromBytes(bytes)
  if (!ciphertext) throw new Error('Şifreli bakiye çözülemedi (bozuk veri).')
  const amount = ciphertext.decrypt(aeKey)
  if (amount === undefined) throw new Error('Şifreli bakiye çözülemedi — türetilen anahtar bu hesaba ait olmayabilir.')
  return amount
}

/**
 * Bir token hesabının Confidential Transfer extension durumunu zincirden
 * okur (`ConfidentialTransferAccount` struct, mod.rs:66 — sabit boyutlu
 * alanlar, byte byte doğrulanmış offsetler).
 */
export async function getConfidentialAccountState(
  connection: Connection,
  tokenAccount: PublicKey,
): Promise<ConfidentialAccountState> {
  const account = await getAccount(connection, tokenAccount, 'confirmed', TOKEN_2022_PROGRAM_ID)
  const ext = getExtensionData(ExtensionType.ConfidentialTransferAccount, account.tlvData)
  if (!ext) {
    throw new Error('Bu hesap gizli transfer için yapılandırılmamış (önce "Hesabı Yapılandır" adımını çalıştırın).')
  }
  let o = 0
  const approved = ext[o] === 1
  o += 1
  const elgamalPubkey = ext.subarray(o, o + ELGAMAL_PUBKEY_LEN)
  o += ELGAMAL_PUBKEY_LEN
  o += ELGAMAL_CIPHERTEXT_LEN // pending_balance_lo (kullanılmıyor)
  o += ELGAMAL_CIPHERTEXT_LEN // pending_balance_hi (kullanılmıyor)
  const availableBalance = ext.subarray(o, o + ELGAMAL_CIPHERTEXT_LEN)
  o += ELGAMAL_CIPHERTEXT_LEN
  const decryptableAvailableBalance = ext.subarray(o, o + AE_CIPHERTEXT_LEN)
  o += AE_CIPHERTEXT_LEN
  o += 1 // allow_confidential_credits (kullanılmıyor)
  o += 1 // allow_non_confidential_credits (kullanılmıyor)
  const pendingBalanceCreditCounter = ext.readBigUInt64LE(o)
  return { approved, elgamalPubkey, availableBalance, decryptableAvailableBalance, pendingBalanceCreditCounter }
}

/**
 * Bir proof'u DOĞRUDAN instruction data içinde gönderirip, doğrulanan
 * "context" verisini (public commitment/pubkey gibi, secret İÇERMEYEN
 * kısmını) önceden oluşturulmuş bir hesaba yazdıran doğrulama instruction'ı.
 * `encode_verify_proof(Some(context_state_info), ...)` (instruction.rs) —
 * `context_state_account` yazılabilir, `context_state_authority` salt okunur
 * (imza gerekmez, hesabı daha sonra kapatmak için sadece pubkey eşleşmesi
 * yeterli).
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
 * Bir proof context hesabını kapatıp kiralanmış SOL'u geri alan instruction
 * (`close_context_state`, instruction.rs). `authority`, hesap `Verify...`
 * instruction'ında `contextStateAuthority` olarak belirtilen aynı pubkey
 * olmalı ve bu instruction'ı İMZALAMALI.
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
 * offset'leri (her biri i8). Toplam 167 byte.
 *
 * ÖNEMLİ: 3 proof'un TAMAMI (özellikle range proof, ~1000 byte) + transfer
 * instruction'ının kendisi TEK bir transaction'a asla sığmıyor (Solana'nın
 * 1232 byte transaction limiti bunu engelliyor — yerel olarak doğrulandı).
 * Bu yüzden proof'lar INLINE (offset ile) değil, ÖNCEDEN ayrı transaction'larda
 * doğrulanıp bir "context state" hesabına yazılıyor; bu instruction sadece o
 * 3 hesabın PUBKEY'ini referans alıyor (offset alanlarının hepsi 0 = "context
 * state hesabı kullan" anlamına geliyor, bkz. Rust dokümantasyonu).
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
  const offsets = Buffer.alloc(3) // hepsi 0 = context state hesabı kullan
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

/** Sırayla imzalanıp gönderilmesi gereken tek bir transaction adımı. */
export interface ConfidentialTransferStep {
  label: string
  instructions: TransactionInstruction[]
  /** Cüzdan imzasına ek olarak bu transaction'ı imzalaması gereken (varsa) geçici anahtarlar. */
  extraSigners: Keypair[]
}

export interface ConfidentialTransferPlan {
  steps: ConfidentialTransferStep[]
  newDecryptedBalance: bigint
}

/**
 * Bir gizli transferin tüm proof'larını üretir ve gönderilmesi gereken
 * transaction adımlarını (sırayla) hazırlar. Tarif `spl-token-confidential-
 * transfer-proof-generation` crate'inin `transfer_split_proof_data`
 * fonksiyonuyla birebir aynı — tek fark, zincirdeki mevcut bakiyeden tutarı
 * çıkarma adımını (`@solana/zk-sdk`'de dışa açılmamıyor) yukarıdaki
 * `ciphertextSubtract` ile yapıyoruz.
 *
 * `connection` parametresi yalnızca proof "context" hesaplarının
 * (aşağıya bakınız) kira-muafiyeti (rent-exempt) lamport miktarını
 * hesaplamak için kullanılıyor.
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
  if (!currentDecryptableCt) throw new Error('Mevcut bakiye çözülemedi (bozuk AE şifreli metin).')
  const currentBalance = currentDecryptableCt.decrypt(sourceKeys.ae)
  if (currentBalance === undefined) {
    throw new Error('Mevcut bakiye çözülemedi — türetilen anahtar bu hesaba ait olmayabilir.')
  }
  if (transferAmount > currentBalance) {
    throw new Error(
      `Yetersiz gizli bakiye: ${currentBalance} birim var, ${transferAmount} birim göndermeye çalışıyorsunuz.`,
    )
  }
  const newBalance = currentBalance - transferAmount

  const sourcePubkey = sourceKeys.elgamal.pubkey()
  const destPubkey = ElGamalPubkey.fromBytes(destinationElGamalPubkeyBytes)
  // Mint'te denetçi (auditor) tanımlı değil — Rust tarafındaki
  // `ElGamalPubkey::default()` ile eşleşen, tüm sıfırlardan oluşan
  // "boş" ElGamal public key kullanılıyor (bkz. protokolün MaybeNull
  // sentinel kuralı — yerel olarak doğrulandı: sıfır baytlar geçerli
  // şekilde decode oluyor).
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

  // Göndericinin kendi görüşünden lo/hi şifreli metinler (grouped ciphertext
  // ile aynı taahhüt/opening çiftini kullanır — taahhüt hangi alıcı
  // anahtarıyla şifrelendiğinden bağımsızdır).
  const sourceCtLo = sourcePubkey.encryptWith(amountLo, openingLo)
  const sourceCtHi = sourcePubkey.encryptWith(amountHi, openingHi)
  const combinedSourceCt = combineLoHiCiphertext(
    sourceCtLo.toBytes(),
    sourceCtHi.toBytes(),
    TRANSFER_AMOUNT_LO_BITS,
  )
  const newBalanceCtBytes = ciphertextSubtract(currentAvailableBalanceCiphertext, combinedSourceCt)
  const newBalanceCt = ElGamalCiphertext.fromBytes(newBalanceCtBytes)
  if (!newBalanceCt) throw new Error('Yeni bakiye şifreli metni oluşturulamadı.')

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
  // ÖNEMLİ: `BatchedRangeProofU128Data`'nın `openings` DİZİ parametresi,
  // zk-sdk'nin wasm-bindgen bağlamalarında tekil (dizi olmayan) parametrelerin
  // aksine, verilen `PedersenOpening` nesnelerinin SAHİPLİĞİNİ ALIYOR (JS
  // tarafındaki wrapper'ı geçersiz kılıyor) — bu yüzden `openingLo`/`openingHi`
  // kullanan HER ŞEY, rangeProof oluşturulmadan ÖNCE bitmiş olmalı. Bu sıra
  // değiştirilirse "null pointer passed to rust" hatasıyla karşılaşılır
  // (yerel olarak doğrulandı: obje reuse sırası değiştirilince hata tekrar üretildi).
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

  // ÖNEMLİ: 3 proof'un (özellikle ~1000 byte'lık range proof) TAMAMINI +
  // transfer instruction'ını TEK bir transaction'a koymak Solana'nın 1232
  // byte transaction limitini aşıyor (yerel olarak doğrulandı — gerçek
  // cihazda "Index out of range" / "null pointer passed to rust" hatalarına
  // yol açtı). Bunun yerine, resmi referans istemcilerin (spl-token CLI vb.)
  // kullandığı "proof context hesabı" yöntemine geçiyoruz: her proof, kendi
  // transaction'ında doğrulanıp küçük bir "context" özetini geçici bir
  // hesaba yazıyor; asıl Transfer instruction'ı bu 3 hesabın pubkey'ini
  // referans alıyor (proof baytlarının kendisini değil) — bu yüzden çok
  // küçük kalıyor. Range proof tek başına da (create + verify birlikte)
  // limiti aştığı için, hesabı oluşturma ile doğrulama ayrı transaction'lara
  // bölündü.
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
      label: 'Eşitlik ispatı doğrulanıyor',
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
      label: 'Geçerlilik ispatı doğrulanıyor',
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
      label: 'Aralık ispatı için hesap oluşturuluyor',
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
      // Range proof (~1000 byte) tek başına + hesap oluşturma bile 1232
      // byte limitine çok yakın/üstünde olduğu için ayrı bir adımda.
      label: 'Aralık ispatı doğrulanıyor',
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
      label: 'Gizli transfer gönderiliyor',
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
        // Transfer başarılı olur olmaz, artık ihtiyaç kalmayan context
        // hesaplarını kapatıp kiralanmış SOL'u geri alıyoruz — aynı
        // transaction içinde (atomik: transfer başarısız olursa kapatma da
        // uygulanmaz).
        buildCloseContextStateIx(eqCtxKeypair.publicKey, owner, owner),
        buildCloseContextStateIx(validityCtxKeypair.publicKey, owner, owner),
        buildCloseContextStateIx(rangeCtxKeypair.publicKey, owner, owner),
      ],
      extraSigners: [],
    },
  ]

  return { steps, newDecryptedBalance: newBalance }
}

// Cüzdan token listesi artık src/lib/walletTokens.ts'te (hem legacy SPL hem
// Token-2022 için ortak, LiquidityPage'in coin seçicisiyle de paylaşılıyor).
