import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { GAME_CONFIG } from '../../config'
import { SlotMachine } from './SlotMachine'
import {
  buyBestFitSpins,
  buySpins,
  computeBestFitSpinPurchase,
  fetchGameConfig,
  fetchVaultBalanceLamports,
  getConfigPda,
  fetchLeaderboard,
  fetchPlayerState,
  forfeitStuckPlay,
  isLuckGameConfigured,
  lamportsToSol,
  loadFreeSpinsState,
  maskWalletForLeaderboard,
  parsePlayCommittedFromTx,
  parsePlayResolvedFromTx,
  parseSpinsPurchasedFromTx,
  playFreeSpin,
  playGame,
  delegateRentReserveLamports,
  delegateSpendableLamports,
  resolveGame,
  saveFreeSpinsState,
  solToLamports,
  topUpDelegateGas,
  type FreeSpinsState,
  type LeaderboardEntry,
  type OnChainGameConfig,
  type OnChainPlayerState,
  type PlayResolvedResult,
  type SpinTier,
  type TxSigner,
} from '../../lib/luckGame'
import { ensureTestWalletFunded, loadOrCreateTestWallet, toTxSigner } from '../../lib/localTestWallet'
import { delegateToTxSigner, loadOrCreateDelegate } from '../../lib/gameDelegate'

// Test cüzdanının minimum devnet bakiyesi: ~birkaç işlem ücreti + PlayerState
// hesabının ilk kayıt (rent) maliyeti için yeterli küçük bir tampon.
const TEST_WALLET_MIN_LAMPORTS = 50_000_000 // 0.05 SOL

// Public devnet RPC'si (api.devnet.solana.com) IP başına sıkı hız sınırı
// uyguluyor — arka plan polling'i çok sık olursa gerçek bir işlem
// gönderirken (Oyna/Sonucu Gör) 429'a takılma ihtimali artıyor.
const POLL_MS = 8000
// Liderlik tablosu getProgramAccounts kullanıyor (tüm PlayerState
// hesaplarını tarar) — bu POLL_MS'den daha ağır, o yüzden daha seyrek.
const LEADERBOARD_POLL_MS = 30_000
function fmtSol(n: number): string {
  return n.toLocaleString('tr-TR', { maximumFractionDigits: 3 })
}

// Gaz bakiyesi binde birin çok altında (0,0002 SOL mertebesinde) olduğu için
// fmtSol onu "0" diye gösteriyordu. Bu ölçek için ayrı bir biçimlendirici.
function fmtGas(n: number): string {
  return n.toLocaleString('tr-TR', { maximumFractionDigits: 6 })
}

// Solana'nın çiğ İngilizce RPC hatalarını anlaşılır Türkçe mesajlara çevirir.
function friendlyErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : ''
  if (/block height exceeded/i.test(message)) {
    return 'İşlem çok uzun sürdüğü için blockhash süresi doldu (muhtemelen cüzdanda onaylamak biraz uzun sürdü) — tekrar dene ve cüzdan onayını mümkün olduğunca hızlı ver.'
  }
  if (/429|rate limit/i.test(message)) {
    return 'RPC sunucusu şu an yoğun, birkaç saniye sonra tekrar dene.'
  }
  // DİKKAT: burada bir zamanlar `insufficient` de eşleşiyordu. Fazla genişti —
  // "insufficient funds" / "insufficient lamports" (yani cüzdanda SOL yok)
  // hataları da "spin hakkın kalmadı" diye gösteriliyordu. Gerçek sebebi
  // gizleyen bir eşleşmeydi; artık yalnızca programın kendi hata koduna
  // bakıyoruz.
  if (/NoSpinsRemaining|0x1776/i.test(message)) {
    return 'Spin hakkın kalmadı — önce bir paket satın al.'
  }
  // Sonuç açma zamanlamasıyla ilgili üç hata. İlk ikisi geçici: zincir
  // birkaç saniye içinde ilerleyince kendiliğinden düzeliyor ve otomatik
  // açma zaten tekrar deniyor. Kullanıcıya "bir şeyler bozuldu" gibi
  // görünmemeleri gerekiyor.
  if (/TooEarlyToResolve|0x1777/i.test(message)) {
    return 'Sonuç için zincirin birkaç saniye daha ilerlemesi gerekiyor — birazdan kendiliğinden açılacak.'
  }
  if (/SlotHashNotFound|0x177b/i.test(message)) {
    return 'Sonucun dayandığı blok henüz zincire yazılmadı — birazdan kendiliğinden açılacak.'
  }
  if (/ResolveWindowExpired|0x1778/i.test(message)) {
    return 'Bu denemenin sonuç açma süresi doldu. "Denemeyi Temizle" ile devam edebilirsin (spin hakkı kullanılmış sayılır).'
  }
  // Zincir düzeyinde kira (rent) reddi: bir hesap, 0 baytlık hesaplar için
  // ~0,00089 SOL olan kira muafiyeti tabanının ALTINDA bakiyeyle
  // bırakılamaz. Bu hatada program genelde hatasız çalışmış olur
  // (loglarda "success" görünür), işlem yine de düşer — bu yüzden ayrı ve
  // açık bir mesajı hak ediyor.
  if (/InsufficientFundsForRent|insufficient funds for rent/i.test(message)) {
    return 'İşlem, Solana\'nın kira (rent) kuralı yüzünden reddedildi: bir hesap ~0,00089 SOL\'lük tabanın altında bakiyeyle bırakılamıyor. Sayfayı yenileyip tekrar dene — sorun sürerse bize bildir.'
  }
  if (/insufficient funds|insufficient lamports|InsufficientFundsForFee/i.test(message)) {
    return 'Cüzdanında yeterli SOL yok — işlem ücreti ve paket bedeli için biraz SOL gerekiyor.'
  }
  return message || 'İşlem başarısız oldu.'
}

export function GameTab() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const configured = isLuckGameConfigured()

  const [gameConfig, setGameConfig] = useState<OnChainGameConfig | null>(null)
  const [playerState, setPlayerState] = useState<OnChainPlayerState | null>(null)
  const [currentSlot, setCurrentSlot] = useState<number | null>(null)
  const [initialized, setInitialized] = useState<boolean | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [delegateBalance, setDelegateBalance] = useState<number | null>(null)
  // Delege hesabının kira depozitosu (0 baytlık hesabın rent-exempt tabanı).
  // Bu tutar zincirde durmak zorunda — harcanabilir gaz DEĞİL, bu yüzden
  // bakiyeyi kullanıcıya gösterirken düşüyoruz (bkz. lib/luckGame.ts).
  const [delegateRentReserve, setDelegateRentReserve] = useState<number | null>(null)
  // Kasa bakiyesi ARTIK okunuyor. Eskiden "kullanıcıya gösterilmiyor" diye
  // sorgulanmıyordu; ama oyunun en belirleyici kuralı buna bağlı: kasa
  // jackpot'u karşılayamıyorsa hiçbir tur kazanç yazmıyor. Bunu oyuncudan
  // saklamak, parasını ödediği bir oyunda gerçek şansını gizlemek olurdu.
  const [vaultLamports, setVaultLamports] = useState<number | null>(null)

  const [busy, setBusy] = useState<string | null>(null)
  // İşlem ilerleme metni artık ekranda GÖSTERİLMİYOR (kullanıcı geri
  // bildirimi: "Ücretsiz oyun oynandı — ekranda slot döndü yazısını
  // kaldır, oyuncu gerçek çevirme deneyimini yaşamalı"). Alt katman
  // fonksiyonları (playGame/buySpins/...) yine bir ilerleme callback'i
  // bekliyor, bu yüzden setter duruyor, değeri okunmuyor.
  const [, setStatus] = useState('')
  const [error, setError] = useState('')
  const [lastResult, setLastResult] = useState<PlayResolvedResult | null>(null)
  // Slot animasyonu bitmeden sonucu yazıyla açıklamıyoruz — makaralar
  // 15-20sn dönüp tek tek durduktan SONRA SlotMachine onLanded ile
  // haber veriyor, kazandın/kaybettin metni ancak o an görünüyor.
  const [revealedResult, setRevealedResult] = useState<PlayResolvedResult | null>(null)
  const [spinAnimating, setSpinAnimating] = useState(false)
  const [bonusNotice, setBonusNotice] = useState(false)
  // Sonuç normalde OTOMATİK açılıyor (aşağıdaki useEffect). Bu bayrak
  // yalnızca otomatik deneme hata verdiğinde true oluyor ve elle
  // "Sonucu Gör" butonunu geri getiriyor — yani buton bir yedek, akışın
  // normal parçası değil.
  const [autoResolveFailed, setAutoResolveFailed] = useState(false)
  const [purchaseNotice, setPurchaseNotice] = useState('')
  const [convertAmount, setConvertAmount] = useState('')

  // Devnet-only hata ayıklama modu: gerçek cüzdan olmadan, anında imzalayan
  // yerel bir cüzdanla oyunu tamamlayıp oyun mantığının kendisinin
  // çalıştığını doğrulamayı sağlar. Bu modda ayrıca oyuncu == imzalayıcı
  // olduğundan delegate kaydına hiç gerek yok.
  // Ücretsiz spinler: blockchain yok, tamamen istemci tarafında,
  // localStorage'da CÜZDAN BAŞINA tutulur (aşağıdaki effect, cüzdan
  // değiştikçe o cüzdanın haklarını yükler).
  const [freeSpinsState, setFreeSpinsState] = useState<FreeSpinsState>(() => loadFreeSpinsState(null))

  const [testKeypair] = useState(() => loadOrCreateTestWallet())
  const [testWalletOn, setTestWalletOn] = useState(false)
  const [testBalance, setTestBalance] = useState<number | null>(null)
  const [testFunding, setTestFunding] = useState(false)
  const [testFundError, setTestFundError] = useState('')

  // Gerçek cüzdan modunda kullanılan yerel "oyun cüzdanı" (delegate/
  // session-key) — bir kez zincirde yetkilendirildikten sonra tüm
  // play()/resolve() çağrılarını onaysız imzalar. Kazanç her zaman gerçek
  // cüzdana gider (bkz. lib/gameDelegate.ts, program/luck-game/src/lib.rs).
  const [delegateKeypair] = useState(() => loadOrCreateDelegate())

  const activeOwnerPublicKey = testWalletOn ? testKeypair.publicKey : wallet.publicKey
  const isActive = testWalletOn || wallet.connected
  const freeSpinsOwnerKey = activeOwnerPublicKey ? activeOwnerPublicKey.toBase58() : null

  // Bağlı cüzdan değiştiğinde o cüzdanın ücretsiz haklarını yükle —
  // haklar cüzdan başına ("her cüzdana 3 ücretsiz deneme"), tarayıcı
  // geneline değil.
  useEffect(() => {
    setFreeSpinsState(loadFreeSpinsState(freeSpinsOwnerKey))
  }, [freeSpinsOwnerKey])

  const realWalletSigner: TxSigner | null =
    wallet.publicKey && wallet.signTransaction
      ? { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction }
      : null

  const delegateActive =
    !testWalletOn && playerState !== null && playerState.delegate.equals(delegateKeypair.publicKey)

  // play()/resolve() imzalayıcısı — HER ZAMAN yerel bir anahtar (test
  // cüzdanı ya da etkin delegate), asla gerçek cüzdan popup'ı açmaz.
  const spinAuthoritySigner: TxSigner | null = testWalletOn
    ? toTxSigner(testKeypair)
    : delegateActive
      ? delegateToTxSigner(delegateKeypair)
      : null

  // Para hareketi olan işlemler (paket satın alma, delegate kaydı/gaz
  // doldurma) — gerçek modda GERÇEK cüzdan onayı gerekir.
  const paymentSigner: TxSigner | null = testWalletOn ? toTxSigner(testKeypair) : realWalletSigner

  // forfeit_stuck_play program tarafında `has_one = player` ile GERÇEK
  // oyuncunun (test modunda test cüzdanının) imzasını zorunlu kılıyor.
  const forfeitSigner: TxSigner | null = testWalletOn ? toTxSigner(testKeypair) : realWalletSigner

  const effectiveSpinTiers: SpinTier[] = useMemo(
    () =>
      gameConfig?.spinTiers ??
      GAME_CONFIG.spinTiers.map((t) => ({ count: t.count, priceLamports: solToLamports(t.priceSol) })),
    [gameConfig],
  )

  const refresh = useCallback(async () => {
    if (!configured) return
    try {
      const [cfg, slot] = await Promise.all([fetchGameConfig(connection), connection.getSlot()])
      setGameConfig(cfg)
      setInitialized(cfg !== null)
      setCurrentSlot(slot)
      if (cfg) {
        setVaultLamports(await fetchVaultBalanceLamports(connection, getConfigPda()))
      }
      // Kasa bakiyesi kullanıcıya gösterilmiyor, bu yüzden sorgulanmıyor da
      // (her polling turunda gereksiz bir RPC çağrısıydı).
      if (activeOwnerPublicKey) {
        const ps = await fetchPlayerState(connection, activeOwnerPublicKey)
        setPlayerState(ps)
        if (testWalletOn) {
          setTestBalance(await connection.getBalance(activeOwnerPublicKey))
        } else {
          const [balance, reserve] = await Promise.all([
            connection.getBalance(delegateKeypair.publicKey),
            delegateRentReserveLamports(connection),
          ])
          setDelegateBalance(balance)
          setDelegateRentReserve(reserve)
        }
      } else {
        setPlayerState(null)
      }
    } catch (err) {
      console.error('Oyun durumu okunamadı:', err)
    }
  }, [connection, activeOwnerPublicKey, testWalletOn, configured, delegateKeypair])

  const refreshLeaderboard = useCallback(async () => {
    if (!configured) return
    try {
      setLeaderboard(await fetchLeaderboard(connection, 10))
    } catch (err) {
      console.error('Liderlik tablosu okunamadı:', err)
    }
  }, [connection, configured])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    refreshLeaderboard()
    const id = setInterval(refreshLeaderboard, LEADERBOARD_POLL_MS)
    return () => clearInterval(id)
  }, [refreshLeaderboard])

  async function handleEnableTestWallet() {
    setTestFundError('')
    setTestWalletOn(true)
    setTestFunding(true)
    try {
      const balance = await ensureTestWalletFunded(connection, testKeypair.publicKey, TEST_WALLET_MIN_LAMPORTS)
      setTestBalance(balance)
    } catch (err) {
      console.error(err)
      setTestFundError(
        `Otomatik devnet airdrop başarısız oldu (muhtemelen faucet hız sınırına takıldı). Test cüzdanı adresine (${testKeypair.publicKey.toBase58()}) https://faucet.solana.com üzerinden elle biraz devnet SOL gönderebilirsin, ya da birkaç dakika sonra tekrar dene.`,
      )
    } finally {
      setTestFunding(false)
    }
  }

  function handleDisableTestWallet() {
    setTestWalletOn(false)
    setTestFundError('')
    setLastResult(null)
    setError('')
    setStatus('')
  }

  // Delegenin gaz bakiyesi normalde satın alımlarla (bkz. handleBuySpins/
  // handleConvert) kasadan otomatik tazeleniyor — bu, oyuncunun kendi
  // cüzdanından yaptığı gerçek bir transfer gerektiren, yalnızca çok uzun
  // süre hiç satın alım yapmadan oynanmışsa gerekebilecek nadir bir yedek.
  async function handleTopUpDelegate() {
    if (!realWalletSigner) return
    setError('')
    setBusy('topup')
    try {
      const lamports = Number(solToLamports(GAME_CONFIG.delegateTopUpSol))
      await topUpDelegateGas(connection, realWalletSigner, delegateKeypair.publicKey, lamports, setStatus)
      setStatus('Oyun cüzdanı bakiyesi dolduruldu.')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
    } finally {
      setBusy(null)
    }
  }

  async function handlePlay() {
    setError('')
    setLastResult(null)
    setRevealedResult(null)
    setBonusNotice(false)
    // "+N spin eklendi!" bildirimi satın almadan kalmıştı ve hiç
    // temizlenmediği için her çevirişten sonra ekranda duruyordu —
    // kullanıcı bunu "her spinde bana spin ekleniyor" diye okudu.
    setPurchaseNotice('')
    setAutoResolveFailed(false)
    setSpinAnimating(true)
    setBusy('play')
    try {
      // Ücretsiz spinler mevcut mu?
      if (freeSpinsState.spinsRemaining > 0) {
        // Blockchain yok, tamamen istemci tarafında
        const { newState } = playFreeSpin(freeSpinsState)
        setFreeSpinsState(newState)
        saveFreeSpinsState(newState, freeSpinsOwnerKey)

        // Bonus spin verildi mi?
        if (newState.bonusGranted && newState.spinsRemaining > 0 && newState.playsCount === GAME_CONFIG.freePlays + 1) {
          setBonusNotice(true)
        }

        // Sonuç anında belli (ücretsiz spin hep kaybeder) ama EKRANDA
        // hemen gösterilmiyor: SlotMachine makaraları 15-20sn döndürüp
        // tek tek durduruyor, sonuç metni ancak o zaman açılıyor.
        setLastResult({
          won: false,
          prizePaidLamports: BigInt(0),
          isBigWin: false,
          easyMode: false,
          opsFeePaidLamports: BigInt(0),
        })

        await refresh()
      } else {
        // Satın alınan spinler için blockchain oyunu
        if (!spinAuthoritySigner || !activeOwnerPublicKey) return
        const sig = await playGame(connection, activeOwnerPublicKey, spinAuthoritySigner, setStatus, {
          confirmMessage: null,
        })
        const committed = await parsePlayCommittedFromTx(connection, sig)
        if (committed?.bonusGranted) setBonusNotice(true)
        setStatus('Oyun başladı — sonuç birkaç saniye içinde açığa çıkacak.')
        await refresh()
      }
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
      setSpinAnimating(false)
    } finally {
      setBusy(null)
    }
  }

  async function handleResolve() {
    // `gameConfig` de şart: resolve(), kazanılan turlarda ödülün üstüne
    // eklenen operasyon payını hazineye aktardığı için hesap listesinde
    // zincirdeki `config.treasury` adresini bekliyor.
    if (!spinAuthoritySigner || !activeOwnerPublicKey || !gameConfig) return
    setError('')
    setBusy('resolve')
    try {
      const sig = await resolveGame(
        connection,
        activeOwnerPublicKey,
        spinAuthoritySigner,
        gameConfig.treasury,
        setStatus,
        { confirmMessage: null },
      )
      setStatus('Sonuç okunuyor...')
      const result = await parsePlayResolvedFromTx(connection, sig)
      // Sonuç zincirden geldi ama ekranda hemen yazılmıyor — makaralar
      // sırayla durup animasyon bitince (onLanded) açıklanıyor.
      setLastResult(result)
      setStatus('')
      setAutoResolveFailed(false)
      await refresh()
      if (result?.won) refreshLeaderboard()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
      setSpinAnimating(false)
      // Otomatik açma başarısız oldu — elle deneyebilmesi için butonu geri
      // getiriyoruz (ve otomatik denemeyi bir daha tetiklemiyoruz ki aynı
      // hatayı sonsuz döngüde tekrarlamayalım).
      setAutoResolveFailed(true)
    } finally {
      setBusy(null)
    }
  }

  async function handleForfeit() {
    if (!forfeitSigner) return
    setError('')
    setBusy('forfeit')
    try {
      await forfeitStuckPlay(connection, forfeitSigner, setStatus)
      setStatus('Sıkışan deneme temizlendi, tekrar oynayabilirsin.')
      setSpinAnimating(false)
      setLastResult(null)
      setRevealedResult(null)
      await refresh()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
    } finally {
      setBusy(null)
    }
  }

  async function handleBuySpins(tierIndex: number) {
    if (!paymentSigner || !gameConfig) return
    setError('')
    setPurchaseNotice('')
    setBusy(`buy-${tierIndex}`)
    try {
      // Delege kaydı (ilk satın alma) ARTIK AYRI BİR İŞLEM DEĞİL: kurulum
      // talimatları satın alma talimatının önüne ekleniyor ve hepsi TEK
      // imzayla, TEK işlemde gidiyor. Eskiden iki ayrı onay isteniyordu;
      // mobil cüzdanda iki kez uygulama değiştirmek hem yavaştı hem de
      // aradaki işlem başarısız olursa yarım kalmış bir kuruluma yol
      // açıyordu.
      const needsDelegate = !playerState || !playerState.delegate.equals(delegateKeypair.publicKey)
      console.log('[BuySpins] Spin satın alınıyor...', {
        tierIndex,
        treasury: gameConfig.treasury.toBase58(),
        needsDelegate,
      })
      const sig = await buySpins(
        connection,
        paymentSigner,
        tierIndex,
        gameConfig.treasury,
        delegateKeypair.publicKey,
        setStatus,
        needsDelegate,
      )
      console.log('[BuySpins] Satın alma tx başarılı:', sig)
      const purchased = await parseSpinsPurchasedFromTx(connection, sig)
      console.log('[BuySpins] Parsed spin count:', purchased?.spinCount)
      setPurchaseNotice(purchased ? `+${purchased.spinCount} spin eklendi!` : 'Paket satın alındı.')
      setStatus('')
      await refresh()
    } catch (err) {
      console.error('[BuySpins] Hata:', err)
      const friendlyMsg = friendlyErrorMessage(err)
      setError(friendlyMsg)
      setStatus('')
      // Hata mesajını göster
      if (err instanceof Error) {
        console.error('[BuySpins] Error details:', err.message, err.stack)
      }
    } finally {
      setBusy(null)
    }
  }

  const convertPreview = useMemo(() => {
    const amountSol = Number.parseFloat(convertAmount)
    if (!Number.isFinite(amountSol) || amountSol <= 0 || effectiveSpinTiers.length === 0) return null
    const budget = solToLamports(amountSol)
    const combo = computeBestFitSpinPurchase(budget, effectiveSpinTiers)
    if (combo.purchases.length === 0) return null
    const totalSpins = combo.purchases.reduce(
      (sum, p) => sum + effectiveSpinTiers[p.tierIndex].count * p.count,
      0,
    )
    return { ...combo, totalSpins }
  }, [convertAmount, effectiveSpinTiers])

  async function handleConvert() {
    if (!paymentSigner || !gameConfig || !convertPreview) return
    setError('')
    setPurchaseNotice('')
    setBusy('convert')
    try {
      const budget = solToLamports(Number.parseFloat(convertAmount))
      const needsDelegate = !playerState || !playerState.delegate.equals(delegateKeypair.publicKey)
      const result = await buyBestFitSpins(
        connection,
        paymentSigner,
        budget,
        effectiveSpinTiers,
        gameConfig.treasury,
        delegateKeypair.publicKey,
        setStatus,
        needsDelegate,
      )
      const totalSpins = result.purchases.reduce(
        (sum, p) => sum + effectiveSpinTiers[p.tierIndex].count * p.count,
        0,
      )
      setPurchaseNotice(
        `${totalSpins} spin eklendi (${fmtSol(lamportsToSol(result.totalCostLamports))} SOL kullanıldı${
          result.leftoverLamports > 0n
            ? `, ${fmtSol(lamportsToSol(result.leftoverLamports))} SOL küçük kaldığı için kullanılamadı`
            : ''
        }).`,
      )
      setConvertAmount('')
      setStatus('')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
    } finally {
      setBusy(null)
    }
  }

  // ---------------------------------------------------------------------
  // Sonucu otomatik aç
  // ---------------------------------------------------------------------
  // Oyun iki adımlı: play() "şu slot'ta oynadım" diye zincire yazıyor,
  // resolve() birkaç slot sonra sonucu açıyor (neden böyle olmak zorunda
  // olduğu program/luck-game/src/lib.rs'te resolve()'un başında anlatılıyor).
  // Bu ikinci adım için kullanıcıya "Sonucu Gör" butonu gösteriliyordu —
  // ama imzayı zaten oyun cüzdanı atıyor, yani onay penceresi hiç açılmıyor:
  // kullanıcı için bu buton, makaralar zaten dönerken basılması gereken
  // gereksiz bir adımdı. Artık hazır olur olmaz kendiliğinden çağrılıyor;
  // buton yalnızca otomatik deneme hata verirse geri geliyor.
  //
  // Hook'un koşullu olmaması için (aşağıdaki "yapılandırılmadı" erken
  // return'ünden ÖNCE duruyor) türetilmiş değerler burada yeniden
  // hesaplanıyor.
  // Otomatik açmanın DENEME SAYACI — tek seferlik bayrak değil.
  //
  // Eskiden her oyun için yalnızca BİR kez tetikleniyordu ve hedef slot'a
  // ULAŞILDIĞI anda (slotsLeft <= 0). Ama o anda hedef slot'un hash'i
  // SlotHashes sysvar'ına henüz girmiş olmuyor: sysvar yalnızca ÖNCEKİ
  // slot'ları içeriyor. Sonuç SlotHashNotFound ile düşüyor ve bayrak zaten
  // set edildiği için bir daha DENENMİYORDU — kullanıcı hata görüp yedek
  // butona basmak zorunda kalıyordu.
  //
  // İki değişiklik: (1) hedef slot GEÇENE kadar bekliyoruz, (2) düşerse
  // sonraki slot yoklamasında tekrar deniyor. Deneme sayısı sınırlı:
  // gerçekten çözülemeyen bir oyunda sonsuz döngüye girmemek için.
  const autoResolveTriesRef = useRef<{ key: string; tries: number }>({ key: '', tries: 0 })
  const AUTO_RESOLVE_MAX_TRIES = 5
  useEffect(() => {
    if (busy !== null) return
    if (!spinAuthoritySigner || !activeOwnerPublicKey || !gameConfig || !playerState) return
    if (!playerState.pending || currentSlot === null) return

    const slotsLeft = Number(playerState.commitSlot + gameConfig.revealDelaySlots) - currentSlot
    // `> -1`: hedef slot'un GEÇMİŞ olması gerekiyor, ulaşılmış olması değil.
    // Hash sysvar'a ancak slot üretildikten SONRA giriyor.
    if (slotsLeft > -1) return
    // Resolve penceresi kaçtıysa artık açılamaz — "Denemeyi Temizle"
    // akışına bırakıyoruz.
    if (-slotsLeft > GAME_CONFIG.maxResolveWindowSlots) return

    const key = `${activeOwnerPublicKey.toBase58()}:${playerState.commitSlot}`
    const durum = autoResolveTriesRef.current
    if (durum.key !== key) {
      autoResolveTriesRef.current = { key, tries: 0 }
    }
    if (autoResolveTriesRef.current.tries >= AUTO_RESOLVE_MAX_TRIES) return
    autoResolveTriesRef.current.tries += 1
    void handleResolve()
  }, [busy, spinAuthoritySigner, activeOwnerPublicKey, gameConfig, playerState, currentSlot])

  if (!configured) {
    return (
      <div className="luck-game">
        <div className="alert alert--warning">
          ⚠️ Oyun programı henüz yapılandırılmadı ({`src/config.ts`} içindeki{' '}
          <code>GAME_CONFIG.programId</code>). Önce program/luck-game deploy edilip ID buraya
          girilmeli — bkz. <code>program/luck-game/README.md</code>.
        </div>
      </div>
    )
  }

  const revealDelaySlots = gameConfig?.revealDelaySlots ?? BigInt(GAME_CONFIG.revealDelaySlots)
  // Ücretsiz denemeler TAMAMEN istemci tarafında (localStorage) veriliyor —
  // zincire hiç yazılmadıkları için hesap/işlem ücreti doğurmuyorlar.
  // Zincirdeki `GameConfig.free_plays` bu yüzden 0'a çekildi (bkz.
  // scripts/update-config.mjs): ikisi birden verilince oyuncu 3 yerel + 3
  // zincir üstü + bonuslar kadar bedava çevirebiliyordu.
  const freePlays = GAME_CONFIG.freePlays
  const smallPrizeSol = gameConfig ? lamportsToSol(gameConfig.smallPrizeLamports) : GAME_CONFIG.smallPrizeSol
  const bigPrizeSol = gameConfig ? lamportsToSol(gameConfig.bigPrizeLamports) : GAME_CONFIG.bigPrizeSol

  const winsCount = playerState?.winsCount ?? 0
  const totalWonSol = playerState ? lamportsToSol(playerState.totalWonLamports) : 0
  // Ücretsiz denemeler istemci tarafında (freeSpinsState), satın alınan
  // spinler zincirde tutuluyor; toplam deneme sayısı ikisinin toplamı.
  const playsCount = (playerState?.playsCount ?? 0) + freeSpinsState.playsCount
  // Zincirdeki spin bakiyesi YALNIZCA delegate (oyun cüzdanı) kayıtlıyken
  // oynanabilir — imzayı o atıyor. Delegate ilk satın alma sırasında
  // kuruluyor, yani henüz hiç paket almamış bir oyuncunun zincirdeki
  // bakiyesi (hesap yokken varsayılan olarak görünen ücretsiz haklar
  // dahil) pratikte kullanılamaz.
  //
  // Önceki sürüm bu kullanılamaz bakiyeyi yine de sayaçta ve buton
  // etiketinde gösteriyordu: buton "Kalan: 3 spin" yazarken canPlay
  // istemci tarafındaki (tükenmiş) ücretsiz haklara bakıp false
  // döndürüyor, buton pasif kalıyordu. Artık her iki yer de GERÇEKTEN
  // oynanabilir hakları gösteriyor.
  const purchasedSpins = spinAuthoritySigner !== null ? (playerState?.spinsRemaining ?? 0) : 0
  const playableSpins = freeSpinsState.spinsRemaining + purchasedSpins
  const pending = playerState?.pending ?? false
  const needsDelegateSetup = isActive && !testWalletOn && !delegateActive
  // Cüzdan bağlı olmalı ve gerçekten oynanabilir bir hak bulunmalı.
  const canPlay = isActive && playableSpins > 0
  // "Harcanabilir" bakiye: ham bakiyeden kira depozitosu düşülmüş hali.
  // Ham bakiyeye bakmak yanıltıcıydı — 0,00089 SOL'lük taban hiçbir zaman
  // işlem ücretine gidemez.
  const delegateGasLamports =
    delegateBalance !== null && delegateRentReserve !== null
      ? delegateSpendableLamports(delegateBalance, delegateRentReserve)
      : null
  const delegateLowBalance =
    delegateActive &&
    delegateGasLamports !== null &&
    lamportsToSol(delegateGasLamports) < GAME_CONFIG.delegateLowBalanceSol

  // Kasanın jackpot + hazine payını karşılayıp karşılayamadığı — programın
  // resolve() içinde uyguladığı kontrolün AYNISI. Karşılayamıyorsa zar ne
  // gelirse gelsin tur kayıp sayılıyor.
  const jackpotCost =
    gameConfig
      ? gameConfig.bigPrizeLamports +
        (gameConfig.bigPrizeLamports * BigInt(gameConfig.treasuryFeeBps)) / BigInt(10_000)
      : BigInt(0)
  const spendableVault =
    vaultLamports !== null && delegateRentReserve !== null
      ? BigInt(Math.max(0, vaultLamports - delegateRentReserve))
      : null
  const canPayJackpot = spendableVault === null ? true : spendableVault >= jackpotCost
  const easyMode =
    gameConfig !== null &&
    spendableVault !== null &&
    spendableVault >= gameConfig.vaultEasyThresholdLamports

  const targetSlot = playerState ? playerState.commitSlot + revealDelaySlots : null
  const slotsRemaining =
    targetSlot !== null && currentSlot !== null ? Number(targetSlot) - currentSlot : null
  const readyToResolve = slotsRemaining !== null && slotsRemaining <= 0
  const windowExpired =
    slotsRemaining !== null && -slotsRemaining > GAME_CONFIG.maxResolveWindowSlots

  // Animasyon süresini SlotMachine yönetiyor: bir tur başladıktan sonra
  // spinAnimating, makaralar tek tek durup sonuç açıklanana kadar
  // (onLanded) true kalıyor — ücretsiz spinde zincir işi olmadığı için
  // busy anında bitse bile makaralar 15-20sn dönmeye devam ediyor.
  const spinning = spinAnimating || busy === 'play' || busy === 'resolve' || (pending && !windowExpired)
  const slotResult = lastResult ? (lastResult.won ? 'win' : 'lose') : 'idle'

  return (
    <div className="luck-game">
      <p className="subtab-desc">
        Solana ağında çalışan bir şans oyunu. Her cüzdana <strong>{freePlays} ücretsiz deneme</strong>{' '}
        (bitince <strong>+1 bonus deneme</strong> hediye), sonrası paket satın alarak. Kazananların çoğu{' '}
        <strong>{fmtSol(smallPrizeSol)} SOL</strong> küçük ödül alır, şanslı bir azınlık ise{' '}
        <strong>{fmtSol(bigPrizeSol)} SOL</strong> büyük ödülü/jackpot'u kazanır — kazanç her zaman doğrudan
        cüzdanına gönderilir.
      </p>

      {initialized === false && (
        <div className="alert alert--warning">
          ⚠️ Program deploy edilmiş görünüyor ama henüz <code>initialize()</code> çağrılmamış —
          oyun henüz kurulmadı.
        </div>
      )}

      {!isActive ? (
        <div className="luck-presale__connect">
          <p>Oynamak için önce cüzdanını bağla.</p>
          <WalletMultiButton />
        </div>
      ) : (
        <>
          {testWalletOn && (
            <div className="alert alert--info luck-game__test-banner">
              🧪 Devnet test cüzdanı aktif — imzalama anında ve onaysız yapılıyor, cüzdan uygulamasına hiç geçmiyor.
              Bu, gerçek para/coin İÇERMEZ, sadece devnet SOL. Adres:{' '}
              <code>{testKeypair.publicKey.toBase58()}</code>{' '}
              {testBalance !== null && <>({fmtSol(lamportsToSol(testBalance))} SOL)</>}
              <div>
                <button type="button" className="btn btn--secondary" onClick={handleEnableTestWallet} disabled={testFunding}>
                  {testFunding ? 'Airdrop isteniyor...' : 'Airdrop iste'}
                </button>{' '}
                <button type="button" className="btn btn--secondary" onClick={handleDisableTestWallet}>
                  Gerçek cüzdana dön
                </button>
              </div>
              {testFundError && <div className="alert alert--warning">{testFundError}</div>}
            </div>
          )}

          {/* Bu bant eskiden oyun cüzdanı aktifken SÜREKLİ duruyordu ve
              "Gaz bakiyesi: 0 SOL" yazıyordu — fmtSol 3 basamağa yuvarladığı
              için 0,0002 SOL "0" görünüyordu, yani hem gereksiz hem
              yanıltıcıydı (oyun gayet çalışıyordu). Kasa her satın alımda
              gazı zaten kendisi tazeliyor; bu yüzden bant artık yalnızca
              GERÇEKTEN işlem gerektiğinde, yani gaz tükenmek üzereyken
              görünüyor. */}
          {delegateLowBalance && (
            <div className="luck-game__delegate-status">
              ⛽ Oyun cüzdanının gazı azaldı ({fmtGas(lamportsToSol(delegateGasLamports ?? 0))} SOL) —{' '}
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={handleTopUpDelegate}
                disabled={busy !== null || !realWalletSigner}
              >
                {busy === 'topup' ? 'Dolduruluyor...' : 'Doldur'}
              </button>
            </div>
          )}

          {/* ---------------------------------------------------------------
              Oyunun kuralları — ZİNCİRDEN okunan gerçek değerlerle
              ---------------------------------------------------------------
              Bu panel eklenene kadar site oyunun oranlarını HİÇBİR YERDE
              söylemiyordu: oyuncu 0,1 SOL ödüyor ama kazanma şansını,
              ödülleri, ev payını ya da "kasa jackpot'u karşılayamazsa
              hiçbir tur kazanamaz" kuralını göremiyordu. Parasını ödediği
              bir oyunda gerçek şansını bilmemek kabul edilebilir değil.

              Sayılar bilerek config.ts'ten DEĞİL, zincirdeki GameConfig'ten
              geliyor: ekranda yazan oran, programın gerçekten uyguladığı
              oranın ta kendisi. İkisi ayrışırsa ekran yalan söylerdi. */}
          {gameConfig && (
            <details className="luck-game__rules">
              <summary>📋 Oranlar ve kurallar (zincirden okunuyor)</summary>
              <div className="luck-game__rules-body">
                <div className="result-card__row">
                  <span>Kazanma şansı</span>
                  <strong>
                    {easyMode
                      ? `%${(gameConfig.easyWinBps / 100).toFixed(2)} (kolay mod açık)`
                      : `%${(gameConfig.normalWinBps / 100).toFixed(2)}`}
                  </strong>
                </div>
                <div className="result-card__row">
                  <span>Küçük ödül</span>
                  <strong>{fmtSol(lamportsToSol(gameConfig.smallPrizeLamports))} SOL</strong>
                </div>
                <div className="result-card__row">
                  <span>Büyük ödül (jackpot)</span>
                  <strong>{fmtSol(lamportsToSol(gameConfig.bigPrizeLamports))} SOL</strong>
                </div>
                <div className="result-card__row">
                  <span>Kazananların jackpot oranı</span>
                  <strong>%{(gameConfig.bigPrizeBps / 100).toFixed(0)}</strong>
                </div>
                <div className="result-card__row">
                  <span>Kolay moda geçiş eşiği</span>
                  <strong>
                    {fmtSol(lamportsToSol(gameConfig.vaultEasyThresholdLamports))} SOL kasa
                  </strong>
                </div>
                <div className="result-card__row">
                  <span>Kasa bakiyesi</span>
                  <strong>
                    {vaultLamports === null ? '—' : `${fmtSol(lamportsToSol(vaultLamports))} SOL`}
                  </strong>
                </div>
                <div className="result-card__row">
                  <span>Ev payı</span>
                  <strong>%{(gameConfig.treasuryFeeBps / 100).toFixed(0)}</strong>
                </div>
                <p className="luck-game__rules-note">
                  Ödediğin paketin %{(gameConfig.treasuryFeeBps / 100).toFixed(0)}'i hazineye,
                  kalanı ödüllerin ödendiği kasaya gider. Kazandığında ödülünden kesinti
                  YAPILMAZ — hazine payı kasadan ayrıca çıkar.
                </p>
                {!canPayJackpot && (
                  <div className="alert alert--warning">
                    ⚠️ Kasa şu an jackpot'u ödeyemiyor. Program, ödeyemeyeceği bir ödülü
                    kazanç saymıyor — yani kasa{' '}
                    {fmtSol(lamportsToSol(jackpotCost))} SOL'a ulaşana kadar hiçbir tur
                    kazanç yazmaz. Paket almadan önce bunu bil.
                  </div>
                )}
              </div>
            </details>
          )}

          <SlotMachine
            spinning={spinning}
            result={slotResult}
            bigWin={lastResult?.isBigWin ?? false}
            onLanded={() => {
              setSpinAnimating(false)
              setRevealedResult(lastResult)
              if (lastResult?.won) refreshLeaderboard()
            }}
          />

          {error && <div className="alert alert--error">{error}</div>}
          {bonusNotice && (
            <div className="alert alert--success">
              🎁 Tebrikler! Ücretsiz denemelerini tamamladın, <strong>+1 bonus deneme hakkı</strong> kazandın!
            </div>
          )}
          {purchaseNotice && <div className="alert alert--success">{purchaseNotice}</div>}

          {revealedResult && (
            <div
              className={`luck-game__result ${revealedResult.won ? 'luck-game__result--win' : 'luck-game__result--lose'}`}
            >
              {revealedResult.won ? (
                revealedResult.isBigWin ? (
                  <>🎉🏆 BÜYÜK ÖDÜL / JACKPOT! {fmtSol(lamportsToSol(revealedResult.prizePaidLamports))} SOL cüzdanına gönderildi.</>
                ) : (
                  <>🎉 Küçük ödül kazandın! {fmtSol(lamportsToSol(revealedResult.prizePaidLamports))} SOL cüzdanına gönderildi.</>
                )
              ) : (
                <>Bu sefer olmadı — tekrar dene! 🍀</>
              )}
            </div>
          )}

          {!pending && (
            <button
              type="button"
              className="btn btn--primary btn--block luck-game__play-btn"
              onClick={handlePlay}
              disabled={busy !== null || spinAnimating || !canPlay}
            >
              {spinAnimating
                ? '🎰 Makaralar dönüyor...'
                : !isActive
                  ? '🔒 Cüzdanını bağla'
                  : playableSpins > 0
                    ? `🎰 Çevir (Kalan: ${playableSpins} spin)`
                    : needsDelegateSetup
                      ? '🔒 Oyun cüzdanını etkinleştir (spin satın al)'
                      : '🔒 Spin hakkın kalmadı — paket satın al'}
            </button>
          )}

          {/* Çeviriş sırasında ARA DURUM METNİ GÖSTERMİYORUZ ("Sonuç
              hazırlanıyor...", "Sonuç açılıyor..."). Makaralar zaten dönüyor,
              butonun kendisi "Makaralar dönüyor..." diyor ve sonuç iki-üç
              saniye içinde kendiliğinden açılıyor — araya giren kutular
              kazanç/kayıp mesajının yerini kapatıp gürültü yaratıyordu.
              Ekranda yalnızca gerçekten yeni bilgi olan kazandın/kaybettin
              mesajı kalıyor.

              Tek istisna: otomatik açma HATA verirse elle deneyebilmek için
              buton geri geliyor. Bu bir bildirim değil, kullanıcının
              sıkışmasını önleyen bir çıkış yolu. */}
          {pending && !windowExpired && readyToResolve && autoResolveFailed && (
            <div className="luck-game__pending">
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={handleResolve}
                disabled={busy !== null || !gameConfig}
              >
                {busy === 'resolve' ? 'Sonuç okunuyor...' : '🎲 Sonucu Gör (tekrar dene)'}
              </button>
            </div>
          )}

          {pending && windowExpired && (
            <div className="luck-game__pending">
              <div className="alert alert--warning">
                Bu deneme resolve penceresini kaçırdı ve artık sonuçlandırılamaz.
              </div>
              <button
                type="button"
                className="btn btn--secondary btn--block"
                onClick={handleForfeit}
                disabled={busy !== null || !forfeitSigner}
              >
                {busy === 'forfeit' ? 'Temizleniyor...' : 'Denemeyi Temizle ve Tekrar Oyna'}
              </button>
            </div>
          )}

          <div className="luck-tokenomics__summary luck-game__stats">
            <div className="luck-tokenomics__stat">
              <span>Kalan Spin</span>
              <strong>{playableSpins}</strong>
            </div>
            <div className="luck-tokenomics__stat">
              <span>Toplam Deneme</span>
              <strong>{playsCount}</strong>
            </div>
            <div className="luck-tokenomics__stat">
              <span>Toplam Kazanım</span>
              <strong>{winsCount}</strong>
            </div>
            <div className="luck-tokenomics__stat">
              <span>Oyun Bakiyesi (Toplam Kazanç)</span>
              <strong>{fmtSol(totalWonSol)} SOL</strong>
            </div>
          </div>

          <div className="luck-game__tariff">
            <h3>Spin Paketleri</h3>
            <div className="luck-game__tariff-grid">
              {GAME_CONFIG.spinTiers.map((tier, i) => (
                <button
                  key={i}
                  type="button"
                  className="luck-game__tariff-card"
                  onClick={() => handleBuySpins(i)}
                  disabled={busy !== null || !paymentSigner || !gameConfig}
                >
                  <strong>{tier.count} Spin</strong>
                  <span>{fmtSol(tier.priceSol)} SOL</span>
                  {busy === `buy-${i}` && <em>Satın alınıyor...</em>}
                </button>
              ))}
            </div>

            <div className="luck-game__convert">
              <label htmlFor="luck-convert-amount">Bakiyemi Spin'e Dönüştür</label>
              <div className="luck-game__convert-row">
                <input
                  id="luck-convert-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="SOL miktarı (ör. 0.4)"
                  value={convertAmount}
                  onChange={(e) => setConvertAmount(e.target.value)}
                  disabled={busy !== null}
                />
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={handleConvert}
                  disabled={busy !== null || !convertPreview || !paymentSigner || !gameConfig}
                >
                  {busy === 'convert' ? 'Dönüştürülüyor...' : 'Dönüştür'}
                </button>
              </div>
              {convertPreview && (
                <p className="luck-game__convert-preview">
                  ≈ <strong>{convertPreview.totalSpins} spin</strong> (
                  {convertPreview.purchases
                    .map((p) => `${p.count}× ${GAME_CONFIG.spinTiers[p.tierIndex].count}-spin paketi`)
                    .join(' + ')}
                  ), toplam {fmtSol(lamportsToSol(convertPreview.totalCostLamports))} SOL
                  {convertPreview.leftoverLamports > 0n && (
                    <> (kalan {fmtSol(lamportsToSol(convertPreview.leftoverLamports))} SOL en küçük pakete yetmiyor)</>
                  )}
                </p>
              )}
              <p className="luck-game__convert-hint">
                Girdiğin miktar, paketlerimizin en iyi eşleşen kombinasyonuna bölünüp tek işlemde satın alınır.
              </p>
            </div>
          </div>

          {leaderboard.length > 0 && (
            <div className="luck-game__leaderboard">
              <h3>🏆 Liderlik Tablosu</h3>
              <table className="luck-game__leaderboard-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Cüzdan</th>
                    <th>Toplam Kazanç</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((entry, i) => (
                    <tr key={entry.player.toBase58()}>
                      <td>{i + 1}</td>
                      <td>{maskWalletForLeaderboard(entry.player)}</td>
                      <td>{fmtSol(lamportsToSol(entry.totalWonLamports))} SOL</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="alert alert--warning luck-game__disclaimer">
        ⚠️ Rastgelelik zincir üstü blockhash tabanlı bir şans oyunu. $LUCK gibi bu oyun da eğlence
        amaçlıdır, sadece kaybetmeyi göze alabileceğin miktarla oyna. "Oyun cüzdanı", yalnızca satın
        aldığın spin bakiyeni harcayabilir — gerçek cüzdanına veya kasaya asla erişemez.
      </div>
    </div>
  )
}
