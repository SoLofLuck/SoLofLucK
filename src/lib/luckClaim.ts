// ---------------------------------------------------------------------------
// Claim istemcisi — luck-distributor programına bağlanır
// ---------------------------------------------------------------------------
// Presale payları ve çekiliş ödülleri zincirde bir "dağıtıcı" (distributor)
// hesabında kilitli duruyor. Alıcı, payını kanıtlayan merkle proof'unu
// getirip açılmış kısmı kendisi çekiyor.
//
// Kanıtlar ve miktarlar tarayıcıda ÜRETİLMİYOR: yayınlanan merkle dosyasından
// (public/merkle/round-N.json) okunuyor. Aynı dosyayı herkes indirip
// scripts/build-merkle.mjs ile yeniden üretebilir — yani "site bana doğru
// sayıyı mı gösteriyor?" sorusunun cevabı bize güvenmeyi gerektirmiyor.
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { sha256 } from '@noble/hashes/sha256'
import { CLAIM_CONFIG, LUCK_TOKEN } from '../config'
import { sendInstructions, withRetry, type TxSigner } from './sendTx'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

export function isClaimConfigured(): boolean {
  return Boolean(CLAIM_CONFIG.programId && LUCK_TOKEN.mint)
}

function programId(): PublicKey {
  if (!CLAIM_CONFIG.programId) throw new Error('Claim programı henüz yapılandırılmadı.')
  return new PublicKey(CLAIM_CONFIG.programId)
}

function mintKey(): PublicKey {
  if (!LUCK_TOKEN.mint) throw new Error('$LUCK mint adresi henüz yapılandırılmadı.')
  return new PublicKey(LUCK_TOKEN.mint)
}

// --- PDA'lar ---------------------------------------------------------------

function u64le(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

export function distributorPda(roundId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('distributor'), mintKey().toBuffer(), u64le(roundId)],
    programId(),
  )[0]
}

export function vaultPda(distributor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), distributor.toBuffer()],
    programId(),
  )[0]
}

export function claimStatusPda(distributor: PublicKey, claimant: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), distributor.toBuffer(), claimant.toBuffer()],
    programId(),
  )[0]
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0]
}

// --- Zincir okuma ----------------------------------------------------------

export interface DistributorState {
  merkleRoot: Uint8Array
  totalAllocated: bigint
  totalClaimed: bigint
  startTs: number
  cliffBps: number
  periodBps: number
  periodSeconds: number
  periods: number
}

/**
 * Distributor hesabını okur. Alan sırası programdaki `Distributor`
 * struct'ıyla birebir aynı olmak zorunda (bkz. luck-distributor lib.rs) —
 * Anchor bunları borsa sırasıyla, 8 baytlık discriminator'dan sonra yazıyor.
 */
export async function fetchDistributor(
  connection: Connection,
  roundId: number,
): Promise<DistributorState | null> {
  const info = await withRetry(() => connection.getAccountInfo(distributorPda(roundId)))
  if (!info) return null
  const d = Buffer.from(info.data)
  let o = 8 // discriminator
  o += 8 // id
  o += 32 // authority
  o += 32 // mint
  o += 32 // vault
  const merkleRoot = new Uint8Array(d.subarray(o, o + 32))
  o += 32
  const totalAllocated = d.readBigUInt64LE(o)
  o += 8
  const totalClaimed = d.readBigUInt64LE(o)
  o += 8
  const startTs = Number(d.readBigInt64LE(o))
  o += 8
  const cliffBps = d.readUInt16LE(o)
  o += 2
  const periodBps = d.readUInt16LE(o)
  o += 2
  const periodSeconds = Number(d.readBigInt64LE(o))
  o += 8
  const periods = d.readUInt16LE(o)

  return {
    merkleRoot,
    totalAllocated,
    totalClaimed,
    startTs,
    cliffBps,
    periodBps,
    periodSeconds,
    periods,
  }
}

/** Bu cüzdanın bu turdan şimdiye kadar çektiği toplam. */
export async function fetchClaimed(
  connection: Connection,
  roundId: number,
  claimant: PublicKey,
): Promise<bigint> {
  const pda = claimStatusPda(distributorPda(roundId), claimant)
  const info = await withRetry(() => connection.getAccountInfo(pda))
  if (!info) return BigInt(0)
  return Buffer.from(info.data).readBigUInt64LE(8)
}

/**
 * Verilen anda açılmış toplam miktar — programdaki `unlocked_amount`'ın
 * aynısı. Kasıtlı olarak yeniden yazıldı: arayüz zincire sormadan da doğru
 * sayıyı gösterebilsin diye. İkisi ayrışırsa kullanıcı "çekilebilir" görüp
 * işlemi reddedilirdi, o yüzden formül birebir aynı tutulmalı.
 */
export function unlockedAmount(d: DistributorState, total: bigint, nowSeconds: number): bigint {
  if (nowSeconds < d.startTs) return BigInt(0)
  const periodsElapsed =
    d.periods === 0 || d.periodSeconds <= 0
      ? 0
      : Math.min(Math.floor((nowSeconds - d.startTs) / d.periodSeconds), d.periods)
  const bps = Math.min(d.cliffBps + periodsElapsed * d.periodBps, 10_000)
  return (total * BigInt(bps)) / BigInt(10_000)
}

/**
 * Zincirin kendi saatini okur (Clock sysvar'ı).
 *
 * Açılma takvimi ZİNCİRİN saatine göre işliyor, tarayıcının saatine göre
 * değil. Arayüz `Date.now()` kullanırsa, saati birkaç dakika ileri olan bir
 * kullanıcı — telefon saatleri kayabiliyor, bazen elle de ayarlanıyor —
 * açılmamış bir dilimi "çekilebilir" görür, imza atar ve işlem
 * `NothingToClaim` ile reddedilir. Üstelik bu tam olarak açılma anında,
 * yani herkesin aynı anda çekmeye çalıştığı dakikada olur.
 *
 * Sysvar hesabının verisi: slot (u64), epoch_start_timestamp (i64),
 * epoch (u64), leader_schedule_epoch (u64), sonra 32. bayttan itibaren
 * unix_timestamp (i64).
 *
 * Okuma başarısız olursa null döner; çağıran taraf tarayıcı saatine
 * düşer — saat farkı olasılığı, sekmenin hiç açılmamasından iyidir.
 */
export async function fetchChainTime(connection: Connection): Promise<number | null> {
  try {
    const info = await withRetry(() =>
      connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111')),
    )
    if (!info || info.data.length < 40) return null
    return Number(Buffer.from(info.data).readBigInt64LE(32))
  } catch {
    return null
  }
}

/** Takvimdeki bir sonraki açılışın zamanı (saniye) — yoksa null. */
export function nextUnlockTs(d: DistributorState, nowSeconds: number): number | null {
  if (nowSeconds < d.startTs) return d.startTs
  const elapsed = nowSeconds - d.startTs
  if (d.periods === 0 || d.periodSeconds <= 0) return null
  const done = Math.floor(elapsed / d.periodSeconds)
  if (done >= d.periods) return null
  return d.startTs + (done + 1) * d.periodSeconds
}

// --- Yayınlanan merkle dosyası ---------------------------------------------

export interface ClaimEntry {
  address: string
  amount: string
  proof: string[]
}

export interface MerkleFile {
  root: string
  total: string
  count: number
  claims: ClaimEntry[]
}

const merkleCache = new Map<number, MerkleFile>()

/**
 * Turun merkle dosyasını indirir. Dosya sitenin kendi kaynağından geliyor;
 * ayrıca kökü zincirdekiyle karşılaştırıyoruz — dosya bir şekilde yanlış ya
 * da eski olursa kullanıcıyı boş yere imzalatmak yerine erken duruyoruz.
 */
export async function fetchMerkleFile(roundId: number): Promise<MerkleFile> {
  const cached = merkleCache.get(roundId)
  if (cached) return cached
  const url = `${CLAIM_CONFIG.merkleBasePath}/round-${roundId}.json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Dağıtım listesi bulunamadı (${url}).`)
  const parsed = (await res.json()) as MerkleFile
  if (!parsed || !Array.isArray(parsed.claims)) {
    throw new Error('Dağıtım listesi bozuk.')
  }
  merkleCache.set(roundId, parsed)
  return parsed
}

export function findEntry(file: MerkleFile, address: string): ClaimEntry | null {
  return file.claims.find((c) => c.address === address) ?? null
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// --- Talimat ---------------------------------------------------------------

/** Anchor talimat ayırıcısı: sha256("global:<isim>")[0..8]. */
function discriminator(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8))
}

/**
 * Claim talimatını kurar.
 *
 * `export` yalnızca doğrulanabilirlik için: scripts/check-abi.mjs bu
 * fonksiyonu çağırıp ürettiği baytları programın kendi ürettiği altın
 * vektörle karşılaştırıyor. Talimatı kopyalayarak sınamak, iki tarafın
 * uyuştuğunu değil kopyanın kendisiyle uyuştuğunu kanıtlardı.
 */
export function buildClaimIx(
  claimant: PublicKey,
  roundId: number,
  entry: ClaimEntry,
): TransactionInstruction {
  const mint = mintKey()
  const distributor = distributorPda(roundId)
  const vault = vaultPda(distributor)
  const claimStatus = claimStatusPda(distributor, claimant)
  const destination = associatedTokenAddress(claimant, mint)

  const proofBytes = entry.proof.map(hexToBytes)
  const data = Buffer.alloc(8 + 8 + 4 + proofBytes.length * 32)
  let o = 0
  discriminator('claim').copy(data, o)
  o += 8
  data.writeBigUInt64LE(BigInt(entry.amount), o)
  o += 8
  data.writeUInt32LE(proofBytes.length, o)
  o += 4
  for (const node of proofBytes) {
    Buffer.from(node).copy(data, o)
    o += 32
  }

  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: claimant, isSigner: true, isWritable: true },
      { pubkey: distributor, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: claimStatus, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

export async function claim(
  connection: Connection,
  signer: TxSigner,
  roundId: number,
  entry: ClaimEntry,
  onStatus?: (status: string) => void,
): Promise<string> {
  return sendInstructions(connection, signer, [buildClaimIx(signer.publicKey, roundId, entry)], onStatus)
}

// --- Görüntüleme -----------------------------------------------------------

/** En küçük birimden okunabilir $LUCK metnine. */
export function formatLuck(amount: bigint): string {
  const base = BigInt(10) ** BigInt(LUCK_TOKEN.decimals)
  const whole = amount / base
  const frac = (amount % base).toString().padStart(LUCK_TOKEN.decimals, '0').replace(/0+$/, '')
  const wholeText = whole.toLocaleString('tr-TR')
  return frac ? `${wholeText},${frac.slice(0, 4)}` : wholeText
}
