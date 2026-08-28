import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { GAME_CONFIG } from '../config'
import { sendInstructions, withRetry, type SendOptions, type TxSigner } from './sendTx'

// The signing interface and the hardened send logic now live in the shared
// src/lib/sendTx.ts, so that non-game flows such as burning can use the same
// protections (re-signing when the blockhash expires, the mobile-wallet timeout,
// skipping preflight). They are re-exported from here so existing imports keep
// working.
export type { TxSigner, SendOptions } from './sendTx'

// Source code and deploy instructions: program/luck-game/README.md.
// While `GAME_CONFIG.programId` is empty this module's functions must not be
// called — the caller (GameTab.tsx) checks with `isLuckGameConfigured()` first.
export function isLuckGameConfigured(): boolean {
  return Boolean(GAME_CONFIG.programId)
}

export const SPIN_TIERS = 6

function programId(): PublicKey {
  if (!GAME_CONFIG.programId) {
    throw new Error('The game program is not configured yet (GAME_CONFIG.programId is empty).')
  }
  return new PublicKey(GAME_CONFIG.programId)
}

// A base58 encoder — used only to encode the 8-byte discriminators for the
// getProgramAccounts memcmp filter. Rather than adding a dependency (bs58 is
// only an INDIRECT/transitive dependency of @solana/web3.js, and importing it
// directly is fragile), a small standard implementation is written here by
// hand.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(bytes: Uint8Array): string {
  const digits = [0]
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let leadingZeros = 0
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) leadingZeros++
  return BASE58_ALPHABET[0].repeat(leadingZeros) + digits.reverse().map((d) => BASE58_ALPHABET[d]).join('')
}

// Anchor discriminators = sha256("global:<instruction_name>")[0..8] /
// sha256("account:<AccountName>")[0..8] / sha256("event:<EventName>")[0..8].
// The Anchor/Rust compiler cannot be run in this environment, so no IDL can be
// generated — these values were computed by hand with Node's crypto module.
// initialize/update_config are admin operations that are called by hand by the
// program owner, once (setup) or rarely (a parameter update), not from the
// site's public interface — which is why they are exported here for reference
// only.
export const IX_INITIALIZE = Buffer.from([0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed])
export const IX_UPDATE_CONFIG = Buffer.from([0x1d, 0x9e, 0xfc, 0xbf, 0x0a, 0x53, 0xdb, 0x63])
const IX_BUY_SPINS = Buffer.from([0x1e, 0x71, 0xe2, 0x89, 0xa7, 0x5d, 0x29, 0x84])
const IX_REGISTER_DELEGATE = Buffer.from([0xda, 0x2d, 0x0c, 0x21, 0xc3, 0x59, 0x59, 0xd0])
const IX_PLAY = Buffer.from([0xd5, 0x9d, 0xc1, 0x8e, 0xe4, 0x38, 0xf8, 0x96])
const IX_RESOLVE = Buffer.from([0xf6, 0x96, 0xec, 0xce, 0x6c, 0x3f, 0x3a, 0x0a])
const IX_FORFEIT_STUCK_PLAY = Buffer.from([0x46, 0xf6, 0x9b, 0xaf, 0x8c, 0x6f, 0x69, 0x89])

const ACCOUNT_GAME_CONFIG = Buffer.from([0x2d, 0x92, 0x92, 0x21, 0xaa, 0x45, 0x60, 0x85])
const ACCOUNT_PLAYER_STATE = Buffer.from([0x38, 0x03, 0x3c, 0x56, 0xae, 0x10, 0xf4, 0xc3])
const EVENT_SPINS_PURCHASED = Buffer.from([0xc3, 0x92, 0x18, 0xf3, 0xce, 0x20, 0x0e, 0xd2])
const EVENT_PLAY_COMMITTED = Buffer.from([0x0f, 0x6a, 0x79, 0x73, 0xba, 0xf3, 0x0b, 0x2c])
const EVENT_PLAY_RESOLVED = Buffer.from([0x8c, 0xb6, 0x17, 0xb4, 0xdf, 0x50, 0x1e, 0x9d])

export function getConfigPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId())
  return pda
}

export function getVaultPda(config: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), config.toBuffer()], programId())
  return pda
}

export function getPlayerStatePda(player: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('player'), player.toBuffer()],
    programId(),
  )
  return pda
}

export interface SpinTier {
  count: number
  priceLamports: bigint
}

export interface OnChainGameConfig {
  authority: PublicKey
  treasury: PublicKey
  freePlays: number
  smallPrizeLamports: bigint
  bigPrizeLamports: bigint
  bigPrizeBps: number
  vaultEasyThresholdLamports: bigint
  normalWinBps: number
  easyWinBps: number
  treasuryFeeBps: number
  revealDelaySlots: bigint
  spinTiers: SpinTier[]
  vaultBump: number
  bump: number
}

/** Reads the GameConfig account from the chain; returns null if the program has not been initialized. */
export async function fetchGameConfig(connection: Connection): Promise<OnChainGameConfig | null> {
  const info = await connection.getAccountInfo(getConfigPda())
  if (!info || info.data.length < 8 || !info.data.subarray(0, 8).equals(ACCOUNT_GAME_CONFIG)) {
    return null
  }
  const d = info.data
  let o = 8
  const authority = new PublicKey(d.subarray(o, o + 32))
  o += 32
  const treasury = new PublicKey(d.subarray(o, o + 32))
  o += 32
  const freePlays = d.readUInt8(o)
  o += 1
  const smallPrizeLamports = d.readBigUInt64LE(o)
  o += 8
  const bigPrizeLamports = d.readBigUInt64LE(o)
  o += 8
  const bigPrizeBps = d.readUInt16LE(o)
  o += 2
  const vaultEasyThresholdLamports = d.readBigUInt64LE(o)
  o += 8
  const normalWinBps = d.readUInt16LE(o)
  o += 2
  const easyWinBps = d.readUInt16LE(o)
  o += 2
  const treasuryFeeBps = d.readUInt16LE(o)
  o += 2
  const revealDelaySlots = d.readBigUInt64LE(o)
  o += 8

  const counts: number[] = []
  for (let i = 0; i < SPIN_TIERS; i++) {
    counts.push(d.readUInt16LE(o))
    o += 2
  }
  const prices: bigint[] = []
  for (let i = 0; i < SPIN_TIERS; i++) {
    prices.push(d.readBigUInt64LE(o))
    o += 8
  }
  const spinTiers: SpinTier[] = counts.map((count, i) => ({ count, priceLamports: prices[i] }))

  const vaultBump = d.readUInt8(o)
  o += 1
  const bump = d.readUInt8(o)

  return {
    authority,
    treasury,
    freePlays,
    smallPrizeLamports,
    bigPrizeLamports,
    bigPrizeBps,
    vaultEasyThresholdLamports,
    normalWinBps,
    easyWinBps,
    treasuryFeeBps,
    revealDelaySlots,
    spinTiers,
    vaultBump,
    bump,
  }
}

export interface OnChainPlayerState {
  player: PublicKey
  playsCount: number
  winsCount: number
  pending: boolean
  commitSlot: bigint
  bump: number
  initialized: boolean
  spinsSeeded: boolean
  spinsRemaining: number
  delegate: PublicKey
  totalWonLamports: bigint
  bonusGranted: boolean
}

function decodePlayerState(data: Buffer): OnChainPlayerState {
  const d = data
  let o = 8
  const player = new PublicKey(d.subarray(o, o + 32))
  o += 32
  const playsCount = d.readUInt32LE(o)
  o += 4
  const winsCount = d.readUInt32LE(o)
  o += 4
  const pending = d.readUInt8(o) !== 0
  o += 1
  const commitSlot = d.readBigUInt64LE(o)
  o += 8
  const bump = d.readUInt8(o)
  o += 1
  const initialized = d.readUInt8(o) !== 0
  o += 1
  const spinsSeeded = d.readUInt8(o) !== 0
  o += 1
  const spinsRemaining = d.readUInt32LE(o)
  o += 4
  const delegate = new PublicKey(d.subarray(o, o + 32))
  o += 32
  const totalWonLamports = d.readBigUInt64LE(o)
  o += 8
  const bonusGranted = d.readUInt8(o) !== 0

  return {
    player,
    playsCount,
    winsCount,
    pending,
    commitSlot,
    bump,
    initialized,
    spinsSeeded,
    spinsRemaining,
    delegate,
    totalWonLamports,
    bonusGranted,
  }
}

/** Reads the PlayerState account from the chain; returns null if the player has never touched it. */
export async function fetchPlayerState(
  connection: Connection,
  player: PublicKey,
): Promise<OnChainPlayerState | null> {
  const info = await connection.getAccountInfo(getPlayerStatePda(player))
  if (!info || info.data.length < 8 || !info.data.subarray(0, 8).equals(ACCOUNT_PLAYER_STATE)) {
    return null
  }
  return decodePlayerState(info.data)
}

/** Returns the SOL balance of the vault PDA. */
export async function fetchVaultBalanceLamports(
  connection: Connection,
  config: PublicKey,
): Promise<number> {
  return connection.getBalance(getVaultPda(config))
}

export interface LeaderboardEntry {
  player: PublicKey
  totalWonLamports: bigint
  winsCount: number
  playsCount: number
}

/**
 * Scans every PlayerState account and sorts by total winnings.
 * No separate indexer is needed — for devnet and the early stage the number of
 * players is small, so getProgramAccounts plus client-side sorting is enough.
 */
export async function fetchLeaderboard(connection: Connection, limit = 10): Promise<LeaderboardEntry[]> {
  const accounts = await connection.getProgramAccounts(programId(), {
    filters: [
      { dataSize: 8 + 32 + 4 + 4 + 1 + 8 + 1 + 1 + 1 + 4 + 32 + 8 + 1 },
      { memcmp: { offset: 0, bytes: base58Encode(ACCOUNT_PLAYER_STATE) } },
    ],
  })
  const entries = accounts.map(({ account }) => {
    const ps = decodePlayerState(account.data as Buffer)
    return {
      player: ps.player,
      totalWonLamports: ps.totalWonLamports,
      winsCount: ps.winsCount,
      playsCount: ps.playsCount,
    }
  })
  entries.sort((a, b) => (b.totalWonLamports > a.totalWonLamports ? 1 : b.totalWonLamports < a.totalWonLamports ? -1 : 0))
  return entries.slice(0, limit)
}

/** Masks a wallet for the leaderboard: the first 3 characters plus 5 asterisks. */
export function maskWalletForLeaderboard(player: PublicKey): string {
  const base58 = player.toBase58()
  return `${base58.slice(0, 3)}*****`
}

// `delegate` is always passed (registered or not) — if it does not match the
// caller's registered delegate the program silently skips the gas top-up (see
// buy_spins in lib.rs). That way, on every purchase, INSIDE the payment
// transaction they were signing anyway, the player also receives a small gas
// refresh from the vault — with no separate "top up" approval.
/**
 * The five instruction builders below are `export`ed for one reason only:
 * verifiability. scripts/check-abi.mjs calls them and compares the bytes they
 * produce and their account ordering against the program's own golden vectors.
 * Testing copies of them would only prove that the copy agrees with itself.
 */
export function buildBuySpinsIx(
  player: PublicKey,
  tierIndex: number,
  treasury: PublicKey,
  delegate: PublicKey,
): TransactionInstruction {
  const config = getConfigPda()
  const vault = getVaultPda(config)
  const playerState = getPlayerStatePda(player)
  const data = Buffer.concat([IX_BUY_SPINS, Buffer.from([tierIndex])])
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: playerState, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: delegate, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })
}

// The delegate's gas balance is NOT taken from the player any more; it is
// sponsored from the vault on the first registration (see register_delegate in
// lib.rs) — so no SOL transfer is asked of the player here, and the single
// signature really is a free transaction. `delegate` is no longer part of the
// instruction data but is passed as an account (the program reads
// `ctx.accounts.delegate.key()`).
export function buildRegisterDelegateIx(player: PublicKey, delegate: PublicKey): TransactionInstruction {
  const config = getConfigPda()
  const vault = getVaultPda(config)
  const playerState = getPlayerStatePda(player)
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: player, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: playerState, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: delegate, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_REGISTER_DELEGATE,
  })
}

export function buildPlayIx(owner: PublicKey, authority: PublicKey): TransactionInstruction {
  const config = getConfigPda()
  const playerState = getPlayerStatePda(owner)
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: playerState, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_PLAY,
  })
}

// `resolve()` is permissionless — the program never checks which wallet sent
// it, so the instruction's account list has no "caller" field. The `treasury`
// account is the destination of the house share added on top of the prize on a
// winning round; the program requires it to match `config.treasury` exactly, so
// a wrong address cannot be passed (the transaction fails). The signer that pays
// the fee (feePayer) is set inside `sendIxs` below — it can be signed with the
// delegate key too, and the winnings always go to `owner` (the real wallet).
export function buildResolveIx(owner: PublicKey, treasury: PublicKey): TransactionInstruction {
  const config = getConfigPda()
  const vault = getVaultPda(config)
  const playerState = getPlayerStatePda(owner)
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: playerState, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_RESOLVE,
  })
}

// forfeit_stuck_play requires the REAL wallet's signature via
// PlayerState.has_one=player (it cannot be called with the delegate) — an
// acceptable exception, since it is a very rare "the resolve window was missed"
// recovery operation.
export function buildForfeitStuckPlayIx(player: PublicKey): TransactionInstruction {
  const config = getConfigPda()
  const playerState = getPlayerStatePda(player)
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: player, isSigner: true, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: playerState, isSigner: false, isWritable: true },
    ],
    data: IX_FORFEIT_STUCK_PLAY,
  })
}

/**
 * The send path for the game flows — it delegates to the shared
 * `sendInstructions`. Re-signing when the blockhash expires, the mobile-wallet
 * timeout and the skip-preflight behaviour are all defined there.
 */
function sendIxs(
  connection: Connection,
  signer: TxSigner,
  ixs: TransactionInstruction[],
  onStatus?: (status: string) => void,
  options?: SendOptions,
): Promise<string> {
  return sendInstructions(connection, signer, ixs, onStatus, options)
}

// ---------------------------------------------------------------------------
// The delegate account's rent floor
// ---------------------------------------------------------------------------
// On Solana an account cannot be left with a balance BELOW the "rent-exempt"
// minimum. For an ordinary wallet account that holds no data (0 bytes) that
// minimum is ~0.00089 SOL. Sending an account that does not exist on chain less
// SOL than that makes the transaction be rejected AT THE CHAIN LEVEL with
// `InsufficientFundsForRent` — even when the program itself ran successfully
// (the logs say "Program ... success" and the transaction still fails).
//
// The delegate (the "game wallet") is exactly such an account: a key freshly
// generated in the browser that has never existed on chain. The vault's sponsor
// payment on the first registration (DELEGATE_GAS_SPONSOR_LAMPORTS = 200,000
// lamports in lib.rs) is on its own BELOW that minimum, so the
// `register_delegate()` transaction was being rejected — despite the program
// running without a fault. Since that registration is the first step of buying
// spins, a purchase could never complete either.
//
// The fix: when sending the registration we first top the delegate up to the
// rent floor in the SAME transaction. That amount is never spent — it is a
// deposit belonging to the player's OWN key, sitting there so the delegate
// account can stay open on chain. The vault's sponsorship rides ON TOP of it and
// remains as spendable gas.
const RENT_EXEMPT_ZERO_FALLBACK_LAMPORTS = 890_880

let rentReserveCache: number | null = null

/** The rent-exemption minimum for a 0-byte account (in lamports). */
export async function delegateRentReserveLamports(connection: Connection): Promise<number> {
  if (rentReserveCache !== null) return rentReserveCache
  try {
    rentReserveCache = await withRetry(() => connection.getMinimumBalanceForRentExemption(0))
  } catch {
    // If the RPC is unreachable we continue with the constant: the value has
    // been the same cluster-wide for years; sending too much is harmless (the
    // money stays in the player's own delegate account) while sending too
    // little fails the transaction.
    rentReserveCache = RENT_EXEMPT_ZERO_FALLBACK_LAMPORTS
  }
  return rentReserveCache
}

/**
 * The balance the delegate can ACTUALLY spend — the raw balance with the rent
 * deposit subtracted. Showing the raw balance would be misleading: the floor
 * amount can never go towards a transaction fee, because a transaction that
 * would take the balance below the floor is rejected with that same
 * `InsufficientFundsForRent` error.
 */
export function delegateSpendableLamports(balance: number, rentReserve: number): number {
  return Math.max(0, balance - rentReserve)
}

/** The delegate's current on-chain balance; 0 is assumed if it cannot be read. */
async function delegateBalanceOrZero(connection: Connection, delegate: PublicKey): Promise<number> {
  try {
    return await withRetry(() => connection.getBalance(delegate, 'confirmed'))
  } catch {
    // Lamports sent in excess stay in the player's own delegate account, while
    // sending too few fails the whole transaction. When in doubt, assuming
    // "the account does not exist at all" is the safe side.
    return 0
  }
}

/**
 * Authorises the player's local delegate key on chain — from then on that key
 * can sign every play()/resolve() call. The delegate's SPENDABLE gas balance is
 * not taken from the player but sponsored from the vault on the first
 * registration (a new player; see register_delegate in lib.rs); the only thing
 * asked of the player is the rent deposit the account needs in order to exist on
 * chain (see the note above). Both happen under ONE wallet approval, in one
 * transaction.
 */
export async function buildDelegateSetupIxs(
  _connection: Connection,
  owner: PublicKey,
  delegate: PublicKey,
): Promise<TransactionInstruction[]> {
  // Both the delegate's rent floor and its gas share are now sent FROM THE
  // VAULT, inside `buy_spins()` (see lib.rs). We ask for no transfer from the
  // player here: we used to, and it added 0.00089 SOL on top of the package
  // price. Because the registration instruction is prepended immediately BEFORE
  // the purchase instruction, the money from the vault arrives within the same
  // transaction — and since Solana's rent check looks at the balance at the END
  // of the transaction, that ordering causes no problem.
  return [buildRegisterDelegateIx(owner, delegate)]
}

export async function registerAndFundDelegate(
  connection: Connection,
  ownerSigner: TxSigner,
  delegate: PublicKey,
  onStatus?: (status: string) => void,
): Promise<string> {
  const ixs = await buildDelegateSetupIxs(connection, ownerSigner.publicKey, delegate)
  return sendIxs(connection, ownerSigner, ixs, onStatus)
}

/**
 * Tops up the delegate's gas balance with a small transfer from the real
 * wallet. If the amount sent would leave the account below the rent floor it is
 * raised to at least that floor — otherwise the transfer itself would be
 * rejected with `InsufficientFundsForRent`.
 */
export async function topUpDelegateGas(
  connection: Connection,
  ownerSigner: TxSigner,
  delegate: PublicKey,
  lamports: number,
  onStatus?: (status: string) => void,
): Promise<string> {
  const rentReserve = await delegateRentReserveLamports(connection)
  const balance = await delegateBalanceOrZero(connection, delegate)
  const ix = SystemProgram.transfer({
    fromPubkey: ownerSigner.publicKey,
    toPubkey: delegate,
    lamports: Math.max(lamports, rentReserve - balance),
  })
  return sendIxs(connection, ownerSigner, [ix], onStatus)
}

/**
 * Buys a spin package — this always requires a REAL wallet approval (it is a
 * payment). `tierIndex` corresponds to the position in the GAME_CONFIG.spinTiers
 * array. `delegate` is the player's local delegate key — if it is registered the
 * program also performs a small gas refresh from the vault INSIDE this
 * transaction (see buy_spins in lib.rs); if it is not registered or does not
 * match, that is skipped silently.
 */
export async function buySpins(
  connection: Connection,
  ownerSigner: TxSigner,
  tierIndex: number,
  treasury: PublicKey,
  delegate: PublicKey,
  onStatus?: (status: string) => void,
  setupDelegate = false,
): Promise<string> {
  const ixs = setupDelegate ? await buildDelegateSetupIxs(connection, ownerSigner.publicKey, delegate) : []
  ixs.push(buildBuySpinsIx(ownerSigner.publicKey, tierIndex, treasury, delegate))
  return sendIxs(connection, ownerSigner, ixs, onStatus)
}

export interface BestFitTierPurchase {
  tierIndex: number
  count: number
}

/**
 * Splits a given budget (in lamports) into the best-fitting combination of our 6
 * fixed packages, GREEDILY: starting from the most expensive package it takes as
 * many as fit in the budget, then moves to the next package with the remainder.
 * This targets the smallest leftover (unusable balance) — it does not guarantee
 * a mathematically proven optimum (the classic "coin change" problem), but for
 * this fixed 6-package tariff it gives the optimum, or very close to it, in
 * practice.
 */
export function computeBestFitSpinPurchase(
  budgetLamports: bigint,
  tiers: SpinTier[],
): { purchases: BestFitTierPurchase[]; totalCostLamports: bigint; leftoverLamports: bigint } {
  const order = tiers
    .map((tier, tierIndex) => ({ tier, tierIndex }))
    .filter((t) => t.tier.priceLamports > 0n)
    .sort((a, b) => (b.tier.priceLamports > a.tier.priceLamports ? 1 : b.tier.priceLamports < a.tier.priceLamports ? -1 : 0))

  let remaining = budgetLamports
  let totalCost = 0n
  const purchases: BestFitTierPurchase[] = []
  for (const { tier, tierIndex } of order) {
    if (tier.priceLamports > remaining) continue
    const count = remaining / tier.priceLamports
    if (count <= 0n) continue
    purchases.push({ tierIndex, count: Number(count) })
    const cost = tier.priceLamports * count
    remaining -= cost
    totalCost += cost
  }
  purchases.sort((a, b) => a.tierIndex - b.tierIndex)
  return { purchases, totalCostLamports: totalCost, leftoverLamports: remaining }
}

// A reasonable number of instructions in one transaction — so as not to exceed
// Solana's transaction size (~1232 bytes) and account-list limits.
const MAX_PURCHASE_IXS = 20

/**
 * "Convert my balance into spins": takes an arbitrary SOL amount entered by the
 * user, splits it into the best-fitting combination of our fixed packages, and
 * buys them in ONE transaction (under ONE real wallet approval).
 *
 * If the combination exceeds MAX_PURCHASE_IXS (an amount so large it does not
 * fit in a single transaction), NO partial purchase is made SILENTLY here — an
 * explicit error is thrown instead, because sending part of it while presenting
 * the full amount as "purchased" would be misleading. In that case the user
 * should split the amount and try again.
 */
export async function buyBestFitSpins(
  connection: Connection,
  ownerSigner: TxSigner,
  budgetLamports: bigint,
  tiers: SpinTier[],
  treasury: PublicKey,
  delegate: PublicKey,
  onStatus?: (status: string) => void,
  setupDelegate = false,
): Promise<{ signature: string; purchases: BestFitTierPurchase[]; totalCostLamports: bigint; leftoverLamports: bigint }> {
  const { purchases, totalCostLamports, leftoverLamports } = computeBestFitSpinPurchase(budgetLamports, tiers)
  if (purchases.length === 0) {
    throw new Error('This amount does not even cover our smallest package.')
  }
  const totalIxs = purchases.reduce((sum, p) => sum + p.count, 0)
  // If the delegate setup rides on the same transaction (the first purchase),
  // reserve its two instructions' worth of room up front.
  const maxIxs = setupDelegate ? MAX_PURCHASE_IXS - 2 : MAX_PURCHASE_IXS
  if (totalIxs > maxIxs) {
    throw new Error(
      `This amount requires more packages than fit in a single transaction (${totalIxs} packages, the limit is ${maxIxs}) — try a smaller amount, or convert in several goes.`,
    )
  }
  const ixs: TransactionInstruction[] = setupDelegate
    ? await buildDelegateSetupIxs(connection, ownerSigner.publicKey, delegate)
    : []
  for (const { tierIndex, count } of purchases) {
    for (let i = 0; i < count; i++) {
      ixs.push(buildBuySpinsIx(ownerSigner.publicKey, tierIndex, treasury, delegate))
    }
  }
  const signature = await sendIxs(connection, ownerSigner, ixs, onStatus)
  return { signature, purchases, totalCostLamports, leftoverLamports }
}

/**
 * Enters a round (the "commit" step). `owner` is the real wallet's address (the
 * winnings and the PlayerState PDA are tied to it); `authoritySigner` is who
 * signs the transaction — the local delegate key if the delegate is active
 * (instant, no approval), otherwise the real wallet itself.
 */
export async function playGame(
  connection: Connection,
  owner: PublicKey,
  authoritySigner: TxSigner,
  onStatus?: (status: string) => void,
  options?: SendOptions,
): Promise<string> {
  return sendIxs(connection, authoritySigner, [buildPlayIx(owner, authoritySigner.publicKey)], onStatus, options)
}

/** Settles a pending round (the "resolve" step) — permissionless, and can be signed with the delegate. */
export async function resolveGame(
  connection: Connection,
  owner: PublicKey,
  feePayerSigner: TxSigner,
  treasury: PublicKey,
  onStatus?: (status: string) => void,
  options?: SendOptions,
): Promise<string> {
  return sendIxs(connection, feePayerSigner, [buildResolveIx(owner, treasury)], onStatus, options)
}

/** Clears a stuck attempt after the resolve window has closed — the REAL wallet's signature is required. */
export async function forfeitStuckPlay(
  connection: Connection,
  ownerSigner: TxSigner,
  onStatus?: (status: string) => void,
): Promise<string> {
  return sendIxs(connection, ownerSigner, [buildForfeitStuckPlayIx(ownerSigner.publicKey)], onStatus)
}

export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / LAMPORTS_PER_SOL
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL))
}

export interface PlayResolvedResult {
  won: boolean
  prizePaidLamports: bigint
  isBigWin: boolean
  easyMode: boolean
  /** The house share moved separately from the vault to the treasury, on top of the prize. */
  opsFeePaidLamports: bigint
}

export interface PlayCommittedResult {
  playsCount: number
  spinsRemaining: number
  bonusGranted: boolean
  commitSlot: bigint
}

export interface SpinsPurchasedResult {
  tierIndex: number
  spinCount: number
  priceLamports: bigint
  spinsRemaining: number
}

// The client-side state for free spins — nothing to do with the blockchain
export interface FreeSpinsState {
  spinsRemaining: number
  playsCount: number
  bonusGranted: boolean
}

// Free spins are kept PER WALLET ("3 free attempts per wallet"). An earlier
// version used a single global key, so if any attempt had already been made in
// the browser, a NEWLY connected wallet also saw its spins as used up and the
// Spin button never became available.
const FREE_SPINS_STORAGE_PREFIX = 'solofluck_free_spins'

function freeSpinsKey(owner: string | null | undefined): string {
  return owner ? `${FREE_SPINS_STORAGE_PREFIX}:${owner}` : FREE_SPINS_STORAGE_PREFIX
}

export function freshFreeSpinsState(): FreeSpinsState {
  return { spinsRemaining: GAME_CONFIG.freePlays, playsCount: 0, bonusGranted: false }
}

export function loadFreeSpinsState(owner?: string | null): FreeSpinsState {
  try {
    const stored = localStorage.getItem(freeSpinsKey(owner))
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<FreeSpinsState>
      // On a corrupt or incomplete record, start from scratch rather than
      // treating the spins as gone.
      if (typeof parsed?.spinsRemaining === 'number') {
        return {
          spinsRemaining: parsed.spinsRemaining,
          playsCount: parsed.playsCount ?? 0,
          bonusGranted: parsed.bonusGranted ?? false,
        }
      }
    }
  } catch {
    // Start from scratch on any error
  }
  return freshFreeSpinsState()
}

export function saveFreeSpinsState(state: FreeSpinsState, owner?: string | null): void {
  try {
    localStorage.setItem(freeSpinsKey(owner), JSON.stringify(state))
  } catch {
    // If storage is unavailable (a private tab etc.) the game should still be
    // playable.
  }
}

/** Plays a free spin (client-side, no blockchain). The result is ALWAYS a loss. */
export function playFreeSpin(state: FreeSpinsState): { newState: FreeSpinsState; won: boolean } {
  if (state.spinsRemaining <= 0) {
    throw new Error('No free spins left')
  }

  const newState = { ...state }
  newState.spinsRemaining -= 1
  newState.playsCount += 1

  // Bonus spin: +1 once the first set runs out (only once)
  if (newState.spinsRemaining === 0 && !newState.bonusGranted && newState.playsCount === GAME_CONFIG.freePlays) {
    newState.spinsRemaining = 1
    newState.bonusGranted = true
  }

  return { newState, won: false }
}

function findEventData(logs: string[], discriminator: Buffer): Buffer | null {
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue
    const raw = Buffer.from(line.slice('Program data: '.length), 'base64')
    if (raw.length >= 8 && raw.subarray(0, 8).equals(discriminator)) return raw
  }
  return null
}

/**
 * Reads the outcome of a `resolve()` transaction directly from the
 * `PlayResolved` event in that same transaction's logs, rather than guessing it
 * from the wallet or the state — which gives the correct result even in a race,
 * such as another concurrent transaction changing player_state.
 */
export async function parsePlayResolvedFromTx(
  connection: Connection,
  signature: string,
): Promise<PlayResolvedResult | null> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  const logs = tx?.meta?.logMessages
  if (!logs) return null
  const raw = findEventData(logs, EVENT_PLAY_RESOLVED)
  if (!raw) return null

  let o = 8
  o += 32 // player: Pubkey
  const won = raw.readUInt8(o) !== 0
  o += 1
  const prizePaidLamports = raw.readBigUInt64LE(o)
  o += 8
  const isBigWin = raw.readUInt8(o) !== 0
  o += 1
  const easyMode = raw.readUInt8(o) !== 0
  o += 1
  // A field appended at the very end of the event; if a (shorter) log produced
  // by an older version of the program is read, it is taken as 0.
  const opsFeePaidLamports = raw.length >= o + 8 ? raw.readBigUInt64LE(o) : 0n

  return { won, prizePaidLamports, isBigWin, easyMode, opsFeePaidLamports }
}

/** Reads the `PlayCommitted` event of a `play()` transaction — needed for the bonus-spin notice. */
export async function parsePlayCommittedFromTx(
  connection: Connection,
  signature: string,
): Promise<PlayCommittedResult | null> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  const logs = tx?.meta?.logMessages
  if (!logs) return null
  const raw = findEventData(logs, EVENT_PLAY_COMMITTED)
  if (!raw) return null

  let o = 8
  o += 32 // player: Pubkey
  const playsCount = raw.readUInt32LE(o)
  o += 4
  const spinsRemaining = raw.readUInt32LE(o)
  o += 4
  const bonusGranted = raw.readUInt8(o) !== 0
  o += 1
  const commitSlot = raw.readBigUInt64LE(o)

  return { playsCount, spinsRemaining, bonusGranted, commitSlot }
}

/** Reads the `SpinsPurchased` event of a `buy_spins()` transaction. */
export async function parseSpinsPurchasedFromTx(
  connection: Connection,
  signature: string,
): Promise<SpinsPurchasedResult | null> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  const logs = tx?.meta?.logMessages
  if (!logs) return null
  const raw = findEventData(logs, EVENT_SPINS_PURCHASED)
  if (!raw) return null

  let o = 8
  o += 32 // player: Pubkey
  const tierIndex = raw.readUInt8(o)
  o += 1
  const spinCount = raw.readUInt32LE(o)
  o += 4
  const priceLamports = raw.readBigUInt64LE(o)
  o += 8
  const spinsRemaining = raw.readUInt32LE(o)

  return { tierIndex, spinCount, priceLamports, spinsRemaining }
}
