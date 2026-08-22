import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_SLOT_HASHES_PUBKEY,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { GAME_CONFIG } from '../config'

// Gerçek cüzdan adaptörü (Phantom vb.) ve yerel anahtarlar (delegate/test
// cüzdanı) için ortak, minimal imzalama arayüzü — sendIxs ve oyun
// fonksiyonları hangi imzalayıcıyı kullandığını bilmek zorunda değil.
export interface TxSigner {
  publicKey: PublicKey
  signTransaction: (tx: Transaction) => Promise<Transaction>
}

// Kaynak kodu ve deploy talimatları: program/luck-game/README.md.
// `GAME_CONFIG.programId` boşken bu modülün fonksiyonları çağrılmamalı —
// çağıran taraf (GameTab.tsx) önce `isLuckGameConfigured()` ile kontrol eder.
export function isLuckGameConfigured(): boolean {
  return Boolean(GAME_CONFIG.programId)
}

export const SPIN_TIERS = 6

/**
 * Bir promise'i, verilen süre içinde ne sonuçlanır ne de hata verirse
 * belirtilen mesajla reddeden bir zaman aşımına bağlar. Mobil cüzdanlarda
 * (özellikle Phantom'ın deep-link ile uygulama arasında geçiş yapan onay
 * akışında) uygulama geçişi başarısız olursa `wallet.signTransaction()`
 * SONSUZA KADAR ne çözülüyor ne reddediliyor — bu da tüm oyun ekranını
 * "İşlem bekleniyor" durumunda kalıcı olarak kilitliyordu. Her ağ/cüzdan
 * adımını bu sarmalayıcıyla sınırlıyoruz ki en kötü ihtimalle net bir hata
 * mesajıyla sonuçlansın, sonsuza dek donmasın.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * İki bilinen geçici RPC hatası sınıfına karşı kısa backoff'lu tekrar
 * deneme: (1) public/paylaşımlı RPC'lerin IP başına hız sınırı; (2) yük
 * dengelemeli sağlayıcılarda getLatestBlockhash() bir düğümden, ardından
 * gönderilen işlemin preflight simülasyonu henüz o blockhash'i görmemiş
 * farklı bir düğümden yanıt alabiliyor ("Blockhash not found"). Her
 * deneme ayrıca bir zaman aşımına bağlı.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseDelayMs = 800): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn(), 20_000, 'RPC isteği zaman aşımına uğradı.')
    } catch (err) {
      const isTransient =
        err instanceof Error && /429|rate limit|blockhash not found|zaman aşımına uğradı/i.test(err.message)
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

// base58 kodlayıcı — yalnızca getProgramAccounts memcmp filtresi için 8
// baytlık discriminator'ları kodlamakta kullanılıyor. Bağımlılık eklemek
// yerine (bs58, @solana/web3.js'in yalnızca DOLAYLI/transitive bir
// bağımlılığı — doğrudan import etmek kırılgan) küçük, standart bir
// uygulama burada elle yazıldı.
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

// Anchor discriminator'ları = sha256("global:<instruction_adi>")[0..8] /
// sha256("account:<AccountName>")[0..8] / sha256("event:<EventName>")[0..8].
// Bu ortamda Anchor/Rust derleyicisi çalıştırılamadığı için IDL
// üretilemiyor — bu değerler Node'un crypto modülüyle elle hesaplandı.
// initialize/update_config, sitenin herkese açık arayüzünden değil, program
// sahibi tarafından bir kez (kurulum) veya seyrek (parametre güncelleme)
// olarak elle çağrılması gereken yönetici işlemleridir — bu yüzden burada
// yalnızca referans olarak dışa aktarılıyorlar.
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

/** PlayerState hesabını zincirden okur; oyuncu hiç dokunmadıysa null döner. */
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

/** Kasa (vault) PDA'sının SOL bakiyesini döner. */
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
 * Tüm PlayerState hesaplarını tarayıp en çok kazanana göre sıralar.
 * Ayrı bir indexer gerektirmiyor — devnet/erken aşama için oyuncu sayısı
 * az olduğundan getProgramAccounts + client-side sıralama yeterli.
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

/** Liderlik tablosunda cüzdanı gizlemek için: ilk 3 hane + 5 yıldız. */
export function maskWalletForLeaderboard(player: PublicKey): string {
  const base58 = player.toBase58()
  return `${base58.slice(0, 3)}*****`
}

// `delegate` her zaman verilir (kayıtlı olsun ya da olmasın) — program,
// arayanın kayıtlı delegesiyle eşleşmiyorsa gaz top-up'ını sessizce
// atlıyor (bkz. lib.rs buy_spins). Bu sayede oyuncu her satın alımda,
// zaten imzaladığı ödeme işleminin İÇİNDE, kasadan gelen küçük bir gaz
// tazelemesi de almış oluyor — ayrı bir "doldur" onayına gerek kalmadan.
function buildBuySpinsIx(
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

// Delegenin gaz bakiyesi artık oyuncudan DEĞİL, ilk kayıtta kasadan
// (vault) sponsor ediliyor (bkz. lib.rs register_delegate) — bu yüzden
// burada oyuncudan hiçbir SOL transferi istenmiyor, tek imza gerçekten
// ücretsiz bir işlem. `delegate` artık instruction verisinde değil, bir
// hesap olarak veriliyor (program `ctx.accounts.delegate.key()`'i okuyor).
function buildRegisterDelegateIx(player: PublicKey, delegate: PublicKey): TransactionInstruction {
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

function buildPlayIx(owner: PublicKey, authority: PublicKey): TransactionInstruction {
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

// `resolve()` izinsizdir (permissionless) — program hangi cüzdanın
// gönderdiğini hiç kontrol etmiyor, bu yüzden instruction'ın hesap
// listesinde bir "caller" alanı yok. İşlemin ücretini ödeyen imzacı
// (feePayer), aşağıdaki `sendIxs` içinde ayarlanıyor — delegate anahtarıyla
// da imzalanabilir, kazanç her zaman `owner`'a (gerçek cüzdana) gider.
function buildResolveIx(owner: PublicKey): TransactionInstruction {
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
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: IX_RESOLVE,
  })
}

// forfeit_stuck_play, PlayerState.has_one=player ile GERÇEK cüzdanın
// imzasını zorunlu kılıyor (delegate ile çağrılamaz) — bu, çok nadir
// görülen bir "resolve penceresi kaçtı" kurtarma işlemi olduğundan kabul
// edilebilir bir istisna.
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

export interface SendOptions {
  /**
   * Cüzdan onayı beklenirken gösterilecek durum mesajı. `null` verilirse bu
   * adım hiç gösterilmez — yerel bir anahtarla (delegate/test cüzdanı)
   * imzalanan işlemler ANINDA ve onaysız tamamlandığından, kullanıcıya
   * yanlışlıkla "cüzdanınızda onay bekleniyor" gibi bir mesaj gösterilmemesi
   * için. Sadece GERÇEK cüzdan imzası gerektiren adımlarda (ödeme, delegate
   * kaydı, sıkışan denemeyi temizleme) varsayılan mesaj kullanılmalı.
   */
  confirmMessage?: string | null
}

// Bir blockhash yalnızca ~60-90 saniye (150 blok) geçerli. Cüzdan onayı
// (özellikle mobilde uygulama geçişleriyle) bu süreyi aşarsa, o ana kadar
// imzalanmış işlem artık geçersiz bir blockhash taşıyor — withRetry ile
// AYNI imzayı tekrar göndermek işe yaramaz, çünkü sorun ağ gecikmesi değil,
// blockhash'in gerçekten süresinin dolmuş olması. Böyle bir durumda tüm
// hazırla→imzala→gönder döngüsünü YENİ bir blockhash ve YENİ bir cüzdan
// onayıyla en baştan tekrarlıyoruz (en fazla birkaç kez).
async function sendIxs(
  connection: Connection,
  signer: TxSigner,
  ixs: TransactionInstruction[],
  onStatus?: (status: string) => void,
  options?: SendOptions,
): Promise<string> {
  const confirmMessage = options?.confirmMessage === undefined ? 'Cüzdanınızda onay bekleniyor...' : options.confirmMessage

  const maxCycles = 3
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const tx = new Transaction().add(...ixs)

    onStatus?.(cycle === 0 ? 'İşlem hazırlanıyor...' : `İşlem yeniden hazırlanıyor (${cycle + 1}. deneme)...`)
    const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash())
    tx.recentBlockhash = blockhash
    tx.feePayer = signer.publicKey

    if (confirmMessage) onStatus?.(confirmMessage)
    // Mobil cüzdanlarda uygulama geçişi (deep link) bazen hiç geri
    // dönmüyor — bu durumda signTransaction sonsuza dek asılı kalırdı.
    // 75sn içinde onay gelmezse net bir hatayla bırakıyoruz. Yerel
    // anahtarlarda (delegate/test cüzdanı) bu zaten anında çözülür.
    const signedTx = await withTimeout(
      signer.signTransaction(tx),
      75_000,
      'Cüzdan onayı 75 saniye içinde tamamlanmadı. Cüzdan uygulamanızı kontrol edin (onay isteği hâlâ açık olabilir) ve tekrar deneyin.',
    )

    try {
      // skipPreflight: Helius'un yük dengelemeli düğümleri arasında kısa
      // süreli state gecikmesi yüzünden preflight simülasyonu, gönderilen
      // düğümde henüz görünmeyen (ama geçerli) bir blockhash'i
      // reddedebiliyor ("Blockhash not found"). Preflight'ı atlayıp gerçek
      // sonucu confirmTransaction'ın döndürdüğü err alanından okuyoruz.
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

/**
 * Oyuncunun yerel delegate anahtarını zincirde yetkilendirir — bundan
 * sonraki tüm play()/resolve() çağrılarını bu anahtar imzalayabilir.
 * Delegenin işlem-ücreti gaz bakiyesi OYUNCUDAN DEĞİL, ilk kayıtta
 * (yeni oyuncu) kasadan (vault) sponsor edilir (bkz. lib.rs
 * register_delegate) — bu yüzden burada oyuncudan HİÇBİR SOL transferi
 * istenmiyor; TEK bir gerçek cüzdan onayı, gerçekten ücretsiz.
 */
export async function registerAndFundDelegate(
  connection: Connection,
  ownerSigner: TxSigner,
  delegate: PublicKey,
  onStatus?: (status: string) => void,
): Promise<string> {
  return sendIxs(connection, ownerSigner, [buildRegisterDelegateIx(ownerSigner.publicKey, delegate)], onStatus)
}

/** Delegate'in gaz bakiyesini gerçek cüzdandan küçük bir transferle doldurur. */
export async function topUpDelegateGas(
  connection: Connection,
  ownerSigner: TxSigner,
  delegate: PublicKey,
  lamports: number,
  onStatus?: (status: string) => void,
): Promise<string> {
  const ix = SystemProgram.transfer({ fromPubkey: ownerSigner.publicKey, toPubkey: delegate, lamports })
  return sendIxs(connection, ownerSigner, [ix], onStatus)
}

/**
 * Spin paketi satın alır — her zaman GERÇEK cüzdan onayı gerektirir (bu bir
 * ödeme işlemidir). `tierIndex`, GAME_CONFIG.spinTiers dizisindeki sıraya
 * karşılık gelir. `delegate`, oyuncunun yerel delege anahtarı — kayıtlıysa
 * program bu işlemin İÇİNDE kasadan küçük bir gaz tazelemesi de yapar
 * (bkz. lib.rs buy_spins), kayıtlı değilse/eşleşmiyorsa sessizce atlanır.
 */
export async function buySpins(
  connection: Connection,
  ownerSigner: TxSigner,
  tierIndex: number,
  treasury: PublicKey,
  delegate: PublicKey,
  onStatus?: (status: string) => void,
): Promise<string> {
  return sendIxs(
    connection,
    ownerSigner,
    [buildBuySpinsIx(ownerSigner.publicKey, tierIndex, treasury, delegate)],
    onStatus,
  )
}

export interface BestFitTierPurchase {
  tierIndex: number
  count: number
}

/**
 * Verilen bütçeyi (lamports), elimizdeki 6 sabit pakete göre AÇGÖZLÜ
 * (greedy) biçimde en iyi eşleşen kombinasyona böler: en pahalı paketten
 * başlayarak bütçeye sığdığı kadarını alır, kalanla bir sonraki pakete
 * geçer. Bu, en küçük artığı (kullanılamayan bakiyeyi) hedefler — matematik
 * olarak kanıtlanmış en uygun çözüm garantisi vermez (klasik "coin change"
 * problemi) ama sabit 6 paketlik bu tarife için pratikte en iyiye çok
 * yakın/en iyi sonucu verir.
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

// Tek bir işlemde makul sayıda instruction — Solana işlem boyutu (~1232
// bayt) ve hesap listesi sınırlarını aşmamak için.
const MAX_PURCHASE_IXS = 20

/**
 * "Bakiyemi spin'e dönüştür": kullanıcının girdiği rastgele bir SOL
 * miktarını, sabit paketlerimizin en iyi eşleşen kombinasyonuna bölüp TEK
 * bir işlemde (ve TEK bir gerçek cüzdan onayıyla) satın alır.
 *
 * Kombinasyon MAX_PURCHASE_IXS'i aşarsa (çok büyük bir miktar için tek
 * işlemde sığmıyorsa) burada SESSİZCE kısmi satın alma YAPILMIYOR — bunun
 * yerine açık bir hata fırlatılıyor, çünkü kısmen gönderip tam miktarı
 * "satın alındı" gibi göstermek yanıltıcı olurdu. Kullanıcı bu durumda
 * miktarı birkaç parçaya bölerek tekrar denemeli.
 */
export async function buyBestFitSpins(
  connection: Connection,
  ownerSigner: TxSigner,
  budgetLamports: bigint,
  tiers: SpinTier[],
  treasury: PublicKey,
  delegate: PublicKey,
  onStatus?: (status: string) => void,
): Promise<{ signature: string; purchases: BestFitTierPurchase[]; totalCostLamports: bigint; leftoverLamports: bigint }> {
  const { purchases, totalCostLamports, leftoverLamports } = computeBestFitSpinPurchase(budgetLamports, tiers)
  if (purchases.length === 0) {
    throw new Error('Bu miktar, en küçük paketimizi bile karşılamıyor.')
  }
  const totalIxs = purchases.reduce((sum, p) => sum + p.count, 0)
  if (totalIxs > MAX_PURCHASE_IXS) {
    throw new Error(
      `Bu miktar tek işlemde satın alınamayacak kadar çok paket gerektiriyor (${totalIxs} paket, üst sınır ${MAX_PURCHASE_IXS}) — daha küçük bir miktarla dene ya da birkaç kez dönüştür.`,
    )
  }
  const ixs: TransactionInstruction[] = []
  for (const { tierIndex, count } of purchases) {
    for (let i = 0; i < count; i++) {
      ixs.push(buildBuySpinsIx(ownerSigner.publicKey, tierIndex, treasury, delegate))
    }
  }
  const signature = await sendIxs(connection, ownerSigner, ixs, onStatus)
  return { signature, purchases, totalCostLamports, leftoverLamports }
}

/**
 * Oyuna katılır ("commit" adımı). `owner`, gerçek cüzdanın adresi (kazanç
 * ve PlayerState PDA'sı buna bağlı); `authoritySigner`, işlemi kimin
 * imzaladığı — delegate aktifse yerel delegate anahtarı (anında, onaysız),
 * değilse gerçek cüzdanın kendisi.
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

/** Bekleyen oyunu sonuçlandırır ("resolve" adımı) — izinsiz, delegate ile de imzalanabilir. */
export async function resolveGame(
  connection: Connection,
  owner: PublicKey,
  feePayerSigner: TxSigner,
  onStatus?: (status: string) => void,
  options?: SendOptions,
): Promise<string> {
  return sendIxs(connection, feePayerSigner, [buildResolveIx(owner)], onStatus, options)
}

/** Resolve penceresi kapandıktan sonra sıkışan denemeyi temizler — GERÇEK cüzdan imzası şart. */
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

// Ücretsiz spinler için istemci tarafında tutulan state — blockchain'le hiç ilgisi yok
export interface FreeSpinsState {
  spinsRemaining: number
  playsCount: number
  bonusGranted: boolean
}

// Ücretsiz haklar CÜZDAN BAŞINA tutuluyor ("her cüzdana 3 ücretsiz
// deneme"). Önceki sürüm tek bir genel anahtar kullanıyordu; bu yüzden
// tarayıcıda daha önce deneme yapılmışsa YENİ bağlanan cüzdan da hakları
// tükenmiş görüyor ve Çevir butonu hiç açılmıyordu.
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
      // Bozuk/eksik kayıt gelirse hakları yok saymak yerine sıfırdan başla.
      if (typeof parsed?.spinsRemaining === 'number') {
        return {
          spinsRemaining: parsed.spinsRemaining,
          playsCount: parsed.playsCount ?? 0,
          bonusGranted: parsed.bonusGranted ?? false,
        }
      }
    }
  } catch {
    // Hata varsa baştan başla
  }
  return freshFreeSpinsState()
}

export function saveFreeSpinsState(state: FreeSpinsState, owner?: string | null): void {
  try {
    localStorage.setItem(freeSpinsKey(owner), JSON.stringify(state))
  } catch {
    // Depolama kullanılamıyorsa (gizli sekme vb.) oyun yine oynanabilsin.
  }
}

/** Ücretsiz spinleri oynat (istemci tarafında, blockchain yok). Sonuç HER ZAMAN kayıp'tır. */
export function playFreeSpin(state: FreeSpinsState): { newState: FreeSpinsState; won: boolean } {
  if (state.spinsRemaining <= 0) {
    throw new Error('Ücretsiz spin kalmadı')
  }

  const newState = { ...state }
  newState.spinsRemaining -= 1
  newState.playsCount += 1

  // Bonus spin: ilk set tükenince +1 bonus (sadece bir kez)
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
 * `resolve()` işleminin sonucunu, cüzdan/state'ten tahmin etmek yerine
 * doğrudan aynı işlemin loglarındaki `PlayResolved` olayından okur — bu,
 * eşzamanlı başka bir işlemin player_state'i değiştirmesi gibi bir yarış
 * durumunda bile her zaman doğru sonucu verir.
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

  return { won, prizePaidLamports, isBigWin, easyMode }
}

/** `play()` işleminin `PlayCommitted` olayını okur — bonus spin bildirimi için gerekli. */
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

/** `buy_spins()` işleminin `SpinsPurchased` olayını okur. */
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
