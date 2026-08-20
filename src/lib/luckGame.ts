import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import { GAME_CONFIG } from '../config'

// Kaynak kodu ve deploy talimatları: program/luck-game/README.md.
// `GAME_CONFIG.programId` boşken bu modülün fonksiyonları çağrılmamalı —
// çağıran taraf (GameTab.tsx) önce `isLuckGameConfigured()` ile kontrol eder.
export function isLuckGameConfigured(): boolean {
  return Boolean(GAME_CONFIG.programId)
}

/**
 * İki bilinen geçici RPC hatası sınıfına karşı kısa backoff'lu tekrar
 * deneme: (1) public/paylaşımlı RPC'lerin IP başına hız sınırı ("429
 * Connection rate limits exceeded"); (2) yük dengelemeli sağlayıcılarda
 * (Helius dahil) getLatestBlockhash() bir düğümden, ardından gönderilen
 * işlemin preflight simülasyonu farklı, henüz o blockhash'i görmemiş bir
 * düğümden yanıt alabiliyor ("Blockhash not found") — birkaç yüz ms
 * içinde düğümler arası state senkronize oluyor, aynı imzalı işlemi
 * tekrar göndermek genelde yeterli. İkisi de kullanıcıya çiğ RPC hatası
 * göstermek yerine burada sessizce tekrar deneniyor.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseDelayMs = 800): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const isTransient = err instanceof Error && /429|rate limit|blockhash not found/i.test(err.message)
      if (!isTransient || i === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i))
    }
  }
  throw new Error('unreachable')
}

function programId(): PublicKey {
  if (!GAME_CONFIG.programId) {
    throw new Error('Oyun programı henüz yapılandırılmadı (GAME_CONFIG.programId boş).')
  }
  return new PublicKey(GAME_CONFIG.programId)
}

// Anchor discriminator'ları = sha256("global:<instruction_adi>")[0..8]
// / sha256("account:<AccountName>")[0..8]. Bu ortamda Anchor/Rust
// derleyicisi çalıştırılamadığı için IDL üretilemiyor — sell-lock'taki gibi
// bu değerler Node'un crypto modülüyle elle hesaplandı.
// initialize/update_config, sitenin herkese açık arayüzünden değil, program
// sahibi tarafından bir kez (kurulum) veya seyrek (parametre güncelleme)
// olarak elle çağrılması gereken yönetici işlemleridir — bu yüzden burada
// yalnızca referans olarak dışa aktarılıyorlar, aşağıdaki oyuncu-yönelimli
// fonksiyonlarda kullanılmıyorlar.
export const IX_INITIALIZE = Buffer.from([0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed])
export const IX_UPDATE_CONFIG = Buffer.from([0x1d, 0x9e, 0xfc, 0xbf, 0x0a, 0x53, 0xdb, 0x63])
const IX_PLAY = Buffer.from([0xd5, 0x9d, 0xc1, 0x8e, 0xe4, 0x38, 0xf8, 0x96])
const IX_RESOLVE = Buffer.from([0xf6, 0x96, 0xec, 0xce, 0x6c, 0x3f, 0x3a, 0x0a])
const IX_FORFEIT_STUCK_PLAY = Buffer.from([0x46, 0xf6, 0x9b, 0xaf, 0x8c, 0x6f, 0x69, 0x89])

const ACCOUNT_GAME_CONFIG = Buffer.from([0x2d, 0x92, 0x92, 0x21, 0xaa, 0x45, 0x60, 0x85])
const ACCOUNT_PLAYER_STATE = Buffer.from([0x38, 0x03, 0x3c, 0x56, 0xae, 0x10, 0xf4, 0xc3])
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

export interface OnChainGameConfig {
  authority: PublicKey
  treasury: PublicKey
  entryFeeLamports: bigint
  freePlays: number
  prizeLamports: bigint
  vaultEasyThresholdLamports: bigint
  normalWinBps: number
  easyWinBps: number
  treasuryFeeBps: number
  revealDelaySlots: bigint
  vaultBump: number
  bump: number
}

/** GameConfig hesabını zincirden okur; program henüz initialize edilmediyse null döner. */
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
  const entryFeeLamports = d.readBigUInt64LE(o)
  o += 8
  const freePlays = d.readUInt8(o)
  o += 1
  const prizeLamports = d.readBigUInt64LE(o)
  o += 8
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
  const vaultBump = d.readUInt8(o)
  o += 1
  const bump = d.readUInt8(o)

  return {
    authority,
    treasury,
    entryFeeLamports,
    freePlays,
    prizeLamports,
    vaultEasyThresholdLamports,
    normalWinBps,
    easyWinBps,
    treasuryFeeBps,
    revealDelaySlots,
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
}

/** PlayerState hesabını zincirden okur; oyuncu hiç oynamadıysa null döner. */
export async function fetchPlayerState(
  connection: Connection,
  player: PublicKey,
): Promise<OnChainPlayerState | null> {
  const info = await connection.getAccountInfo(getPlayerStatePda(player))
  if (!info || info.data.length < 8 || !info.data.subarray(0, 8).equals(ACCOUNT_PLAYER_STATE)) {
    return null
  }
  const d = info.data
  let o = 8
  const playerKey = new PublicKey(d.subarray(o, o + 32))
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

  return { player: playerKey, playsCount, winsCount, pending, commitSlot, bump }
}

/** Kasa (vault) PDA'sının SOL bakiyesini döner. */
export async function fetchVaultBalanceLamports(
  connection: Connection,
  config: PublicKey,
): Promise<number> {
  return connection.getBalance(getVaultPda(config))
}

function buildPlayIx(player: PublicKey, treasury: PublicKey): TransactionInstruction {
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
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_PLAY,
  })
}

// `resolve()` izinsizdir (permissionless) — program hangi cüzdanın
// gönderdiğini hiç kontrol etmiyor, bu yüzden instruction'ın hesap
// listesinde bir "caller" alanı yok. İşlemin ücretini ödeyen imzacı
// (feePayer), aşağıdaki `sendSingleIx` içinde ayarlanıyor.
function buildResolveIx(player: PublicKey): TransactionInstruction {
  const config = getConfigPda()
  const vault = getVaultPda(config)
  const playerState = getPlayerStatePda(player)
  return new TransactionInstruction({
    programId: programId(),
    keys: [
      { pubkey: player, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: playerState, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_RESOLVE,
  })
}

function buildForfeitStuckPlayIx(player: PublicKey): TransactionInstruction {
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

// Bir blockhash yalnızca ~60-90 saniye (150 blok) geçerli. Cüzdan onayı
// (özellikle mobilde uygulama geçişleriyle) bu süreyi aşarsa, o ana kadar
// imzalanmış işlem artık geçersiz bir blockhash taşıyor — withRetry ile
// AYNI imzayı tekrar göndermek işe yaramaz, çünkü sorun ağ gecikmesi değil,
// blockhash'in gerçekten süresinin dolmuş olması. Böyle bir durumda tüm
// hazırla→imzala→gönder döngüsünü YENİ bir blockhash ve YENİ bir cüzdan
// onayıyla en baştan tekrarlıyoruz (en fazla birkaç kez) — bu, kullanıcının
// "block height exceeded" hatasıyla karşılaşıp elle "tekrar dene"ye
// basmasından daha güvenilir.
async function sendSingleIx(
  connection: Connection,
  wallet: WalletContextState,
  ix: TransactionInstruction,
  onStatus?: (status: string) => void,
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Devam etmek için önce cüzdanınızı bağlayın.')
  }

  const maxCycles = 3
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const tx = new Transaction().add(ix)

    onStatus?.(cycle === 0 ? 'İşlem hazırlanıyor...' : `İşlem yeniden hazırlanıyor (${cycle + 1}. deneme)...`)
    const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash())
    tx.recentBlockhash = blockhash
    tx.feePayer = wallet.publicKey

    onStatus?.('Cüzdanınızda onay bekleniyor...')
    const signedTx = await wallet.signTransaction(tx)

    try {
      // skipPreflight: Helius'un yük dengelemeli düğümleri arasında kısa
      // süreli state gecikmesi yüzünden preflight simülasyonu, gönderilen
      // düğümde henüz görünmeyen (ama geçerli) bir blockhash'i
      // reddedebiliyor ("Blockhash not found") — withRetry ile tekrar
      // denemek bazen düğüm gecikmesinin süresini aşamıyor. Preflight'ı
      // atlayıp gerçek sonucu confirmTransaction'ın döndürdüğü err
      // alanından okuyoruz; maxRetries ağın kendi ilettiği işlemi birkaç
      // kez yeniden yayınlamasını sağlıyor.
      onStatus?.('İşlem ağa gönderiliyor...')
      const signature = await withRetry(() =>
        connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true, maxRetries: 5 }),
      )

      onStatus?.('Onay bekleniyor...')
      const confirmation = await withRetry(() =>
        connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed'),
      )
      if (confirmation.value.err) {
        throw new Error(`İşlem zincirde başarısız oldu: ${JSON.stringify(confirmation.value.err)}`)
      }

      return signature
    } catch (err) {
      const isBlockhashExpiry =
        err instanceof Error && /block height exceeded|blockhash not found/i.test(err.message)
      if (!isBlockhashExpiry || cycle === maxCycles - 1) throw err
      onStatus?.('Onay çok uzun sürdü, blockhash süresi doldu — yeni bir onay isteniyor...')
    }
  }
  throw new Error('unreachable')
}

/** Oyuna katılır ("commit" adımı) — bkz. program/luck-game/README.md. */
export async function playGame(
  connection: Connection,
  wallet: WalletContextState,
  onStatus?: (status: string) => void,
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Devam etmek için önce cüzdanınızı bağlayın.')
  }
  const config = await withRetry(() => fetchGameConfig(connection))
  if (!config) {
    throw new Error('Oyun henüz kurulmadı (GameConfig bulunamadı).')
  }
  return sendSingleIx(connection, wallet, buildPlayIx(wallet.publicKey, config.treasury), onStatus)
}

/** Bekleyen oyunu sonuçlandırır ("resolve" adımı) — kendi oyununuz için çağrılır. */
export async function resolveGame(
  connection: Connection,
  wallet: WalletContextState,
  onStatus?: (status: string) => void,
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Devam etmek için önce cüzdanınızı bağlayın.')
  }
  return sendSingleIx(connection, wallet, buildResolveIx(wallet.publicKey), onStatus)
}

/** Resolve penceresi kapandıktan sonra sıkışan denemeyi temizler. */
export async function forfeitStuckPlay(
  connection: Connection,
  wallet: WalletContextState,
  onStatus?: (status: string) => void,
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('Devam etmek için önce cüzdanınızı bağlayın.')
  }
  return sendSingleIx(connection, wallet, buildForfeitStuckPlayIx(wallet.publicKey), onStatus)
}

export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / LAMPORTS_PER_SOL
}

export interface PlayResolvedResult {
  won: boolean
  prizePaidLamports: bigint
  easyMode: boolean
}

/**
 * `resolve()` işleminin sonucunu, cüzdan/state'ten tahmin etmek yerine
 * doğrudan aynı işlemin loglarındaki `PlayResolved` olayından okur — bu,
 * eşzamanlı başka bir işlemin player_state'i değiştirmesi gibi bir yarış
 * durumunda bile her zaman doğru sonucu verir. Anchor, `emit!` ile
 * yayınlanan olayları "Program data: <base64>" satırı olarak loglar; veri
 * borsh formatında (8 bayt event discriminator + alanlar sırayla) kodlanır.
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

  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue
    const raw = Buffer.from(line.slice('Program data: '.length), 'base64')
    if (raw.length < 8 || !raw.subarray(0, 8).equals(EVENT_PLAY_RESOLVED)) continue

    let o = 8
    o += 32 // player: Pubkey
    const won = raw.readUInt8(o) !== 0
    o += 1
    const prizePaidLamports = raw.readBigUInt64LE(o)
    o += 8
    const easyMode = raw.readUInt8(o) !== 0

    return { won, prizePaidLamports, easyMode }
  }
  return null
}
