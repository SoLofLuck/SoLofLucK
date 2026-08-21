import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { GAME_CONFIG } from '../../config'
import { SlotMachine } from './SlotMachine'
import {
  buyBestFitSpins,
  buySpins,
  computeBestFitSpinPurchase,
  fetchGameConfig,
  fetchLeaderboard,
  fetchPlayerState,
  fetchVaultBalanceLamports,
  forfeitStuckPlay,
  getConfigPda,
  isLuckGameConfigured,
  lamportsToSol,
  loadFreeSpinsState,
  maskWalletForLeaderboard,
  parsePlayCommittedFromTx,
  parsePlayResolvedFromTx,
  parseSpinsPurchasedFromTx,
  playFreeSpin,
  playGame,
  registerAndFundDelegate,
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
// Solana'da ortalama slot süresi ~400-500ms — bu yalnızca kullanıcıya
// kabaca bir bekleme süresi göstermek için, kesin bir taahhüt değil.
const APPROX_SECONDS_PER_SLOT = 0.45

function fmtSol(n: number): string {
  return n.toLocaleString('tr-TR', { maximumFractionDigits: 3 })
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
  if (/NoSpinsRemaining|0x1776|insufficient/i.test(message)) {
    return 'Spin hakkın kalmadı — önce bir paket satın al.'
  }
  return message || 'İşlem başarısız oldu.'
}

export function GameTab() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const configured = isLuckGameConfigured()

  const [gameConfig, setGameConfig] = useState<OnChainGameConfig | null>(null)
  const [vaultLamports, setVaultLamports] = useState<number | null>(null)
  const [playerState, setPlayerState] = useState<OnChainPlayerState | null>(null)
  const [currentSlot, setCurrentSlot] = useState<number | null>(null)
  const [initialized, setInitialized] = useState<boolean | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [delegateBalance, setDelegateBalance] = useState<number | null>(null)

  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [lastResult, setLastResult] = useState<PlayResolvedResult | null>(null)
  const [bonusNotice, setBonusNotice] = useState(false)
  const [purchaseNotice, setPurchaseNotice] = useState('')
  const [convertAmount, setConvertAmount] = useState('')

  // Devnet-only hata ayıklama modu: gerçek cüzdan olmadan, anında imzalayan
  // yerel bir cüzdanla oyunu tamamlayıp oyun mantığının kendisinin
  // çalıştığını doğrulamayı sağlar. Bu modda ayrıca oyuncu == imzalayıcı
  // olduğundan delegate kaydına hiç gerek yok.
  // Ücretsiz spinler: blockchain yok, tamamen istemci tarafında, localStorage'da tutulur
  const [freeSpinsState, setFreeSpinsState] = useState<FreeSpinsState>(() => loadFreeSpinsState())

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
        const vault = await fetchVaultBalanceLamports(connection, getConfigPda())
        setVaultLamports(vault)
      }
      if (activeOwnerPublicKey) {
        const ps = await fetchPlayerState(connection, activeOwnerPublicKey)
        setPlayerState(ps)
        if (testWalletOn) {
          setTestBalance(await connection.getBalance(activeOwnerPublicKey))
        } else {
          setDelegateBalance(await connection.getBalance(delegateKeypair.publicKey))
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
    setBonusNotice(false)
    setBusy('play')
    try {
      // Ücretsiz spinler mevcut mu?
      if (freeSpinsState.spinsRemaining > 0) {
        // Blockchain yok, tamamen istemci tarafında
        const { newState } = playFreeSpin(freeSpinsState)
        setFreeSpinsState(newState)
        saveFreeSpinsState(newState)

        // Bonus spin verildi mi?
        if (newState.bonusGranted && newState.spinsRemaining > 0 && newState.playsCount === GAME_CONFIG.freePlays + 1) {
          setBonusNotice(true)
        }

        setStatus('Ücretsiz oyun oynandı — ekranda slot döndü!')
        setLastResult({ won: false, prizePaidLamports: BigInt(0), isBigWin: false, easyMode: false })
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
    } finally {
      setBusy(null)
    }
  }

  async function handleResolve() {
    if (!spinAuthoritySigner || !activeOwnerPublicKey) return
    setError('')
    setBusy('resolve')
    try {
      const sig = await resolveGame(connection, activeOwnerPublicKey, spinAuthoritySigner, setStatus, {
        confirmMessage: null,
      })
      setStatus('Sonuç okunuyor...')
      const result = await parsePlayResolvedFromTx(connection, sig)
      setLastResult(result)
      setStatus('')
      await refresh()
      if (result?.won) refreshLeaderboard()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
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
      // Delegate henüz register değilse (ilk satın alma), önce register et
      const needsDelegate = !playerState || !playerState.delegate.equals(delegateKeypair.publicKey)
      if (needsDelegate) {
        console.log('[BuySpins] Delegate kaydı gerekli, register ediliyor...', {
          delegateKeypair: delegateKeypair.publicKey.toBase58(),
          playerStateDelegate: playerState?.delegate?.toBase58(),
        })
        setStatus('Oyun cüzdanı kuruluyor (1/2)...')
        await registerAndFundDelegate(connection, paymentSigner, delegateKeypair.publicKey, setStatus)
        console.log('[BuySpins] Delegate kayıt tamamlandı')
        setStatus('Spinler satın alınıyor (2/2)...')
      }

      console.log('[BuySpins] Spin satın alınıyor...', { tierIndex, treasury: gameConfig.treasury.toBase58() })
      const sig = await buySpins(
        connection,
        paymentSigner,
        tierIndex,
        gameConfig.treasury,
        delegateKeypair.publicKey,
        setStatus,
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
      const result = await buyBestFitSpins(
        connection,
        paymentSigner,
        budget,
        effectiveSpinTiers,
        gameConfig.treasury,
        delegateKeypair.publicKey,
        setStatus,
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
  const freePlays = gameConfig?.freePlays ?? GAME_CONFIG.freePlays
  const smallPrizeSol = gameConfig ? lamportsToSol(gameConfig.smallPrizeLamports) : GAME_CONFIG.smallPrizeSol
  const bigPrizeSol = gameConfig ? lamportsToSol(gameConfig.bigPrizeLamports) : GAME_CONFIG.bigPrizeSol
  const thresholdSol = gameConfig
    ? lamportsToSol(gameConfig.vaultEasyThresholdLamports)
    : GAME_CONFIG.vaultEasyThresholdSol
  const vaultSol = vaultLamports !== null ? lamportsToSol(vaultLamports) : null
  const easyMode = vaultSol !== null && vaultSol >= thresholdSol

  const playsCount = playerState?.playsCount ?? 0
  const winsCount = playerState?.winsCount ?? 0
  const totalWonSol = playerState ? lamportsToSol(playerState.totalWonLamports) : 0
  // Zincirde spins_remaining, ücretsiz haklar henüz "seed" edilmediyse
  // (ilk play() çağrılmadan önce) satın alınmış bakiyeyi İÇERİR ama
  // ücretsiz hakları henüz İÇERMEZ (bunlar play()'de eklenir) — ekranda
  // doğru toplamı göstermek için burada aynı toplamayı client tarafında
  // yapıyoruz.
  const spinsRemaining = playerState
    ? playerState.spinsRemaining + (playerState.spinsSeeded ? 0 : freePlays)
    : freePlays
  const pending = playerState?.pending ?? false
  const needsDelegateSetup = isActive && !testWalletOn && !delegateActive
  const canPlay = spinAuthoritySigner !== null && spinsRemaining > 0
  const delegateLowBalance =
    delegateActive && delegateBalance !== null && lamportsToSol(delegateBalance) < GAME_CONFIG.delegateLowBalanceSol

  const targetSlot = playerState ? playerState.commitSlot + revealDelaySlots : null
  const slotsRemaining =
    targetSlot !== null && currentSlot !== null ? Number(targetSlot) - currentSlot : null
  const readyToResolve = slotsRemaining !== null && slotsRemaining <= 0
  const windowExpired =
    slotsRemaining !== null && -slotsRemaining > GAME_CONFIG.maxResolveWindowSlots

  const spinning = busy === 'play' || busy === 'resolve' || (pending && !windowExpired)
  const slotResult = lastResult ? (lastResult.won ? 'win' : 'lose') : 'idle'

  return (
    <div className="luck-game">
      <p className="subtab-desc">
        Zincir üzerinde çalışan gerçekten zor bir şans çarkı — kaynak kodu ve nasıl adil olduğu{' '}
        <code>program/luck-game</code> içinde. Her cüzdana <strong>{freePlays} ücretsiz deneme</strong>{' '}
        (bitince <strong>+1 bonus deneme</strong> hediye), sonrası paket satın alarak. Kasa{' '}
        <strong>{fmtSol(thresholdSol)} SOL'a</strong> ulaşınca oyun biraz kolaylaşır. Kazananların çoğu{' '}
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
          <p className="luck-game__test-hint">
            Cüzdan onayında sorun mu yaşıyorsun?{' '}
            <button type="button" className="btn btn--secondary" onClick={handleEnableTestWallet} disabled={testFunding}>
              {testFunding ? 'Test cüzdanı hazırlanıyor...' : '🧪 Devnet test cüzdanı ile dene (onaysız, hızlı)'}
            </button>
          </p>
          {testFundError && <div className="alert alert--warning">{testFundError}</div>}
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

          {delegateActive && (
            <div className="luck-game__delegate-status">
              🔑 Oyun cüzdanı aktif — spinler onaysız oynanıyor.{' '}
              {delegateBalance !== null && <>Gaz bakiyesi: {fmtSol(lamportsToSol(delegateBalance))} SOL.</>}
              {delegateLowBalance && (
                <>
                  {' '}
                  Bakiye düşük —{' '}
                  <button
                    type="button"
                    className="btn btn--secondary btn--small"
                    onClick={handleTopUpDelegate}
                    disabled={busy !== null || !realWalletSigner}
                  >
                    {busy === 'topup' ? 'Dolduruluyor...' : 'Doldur'}
                  </button>
                </>
              )}
            </div>
          )}

          <SlotMachine spinning={spinning} result={slotResult} bigWin={lastResult?.isBigWin ?? false} />

          {error && <div className="alert alert--error">{error}</div>}
          {!error && status && <div className="alert alert--info">{status}</div>}
          {bonusNotice && (
            <div className="alert alert--success">
              🎁 Tebrikler! Ücretsiz denemelerini tamamladın, <strong>+1 bonus deneme hakkı</strong> kazandın!
            </div>
          )}
          {purchaseNotice && <div className="alert alert--success">{purchaseNotice}</div>}

          {lastResult && (
            <div
              className={`luck-game__result ${lastResult.won ? 'luck-game__result--win' : 'luck-game__result--lose'}`}
            >
              {lastResult.won ? (
                lastResult.isBigWin ? (
                  <>🎉🏆 BÜYÜK ÖDÜL / JACKPOT! {fmtSol(lamportsToSol(lastResult.prizePaidLamports))} SOL cüzdanına gönderildi.</>
                ) : (
                  <>🎉 Küçük ödül kazandın! {fmtSol(lamportsToSol(lastResult.prizePaidLamports))} SOL cüzdanına gönderildi.</>
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
              disabled={busy !== null || !canPlay}
            >
              {busy === 'play'
                ? 'Gönderiliyor...'
                : spinsRemaining > 0
                  ? `🎰 Çevir (Kalan: ${spinsRemaining} spin)`
                  : needsDelegateSetup
                    ? '🔒 Oyun cüzdanını etkinleştir (spin satın al)'
                    : '🔒 Spin hakkın kalmadı — paket satın al'}
            </button>
          )}

          {pending && !windowExpired && (
            <div className="luck-game__pending">
              {readyToResolve ? (
                <button
                  type="button"
                  className="btn btn--primary btn--block"
                  onClick={handleResolve}
                  disabled={busy !== null}
                >
                  {busy === 'resolve' ? 'Sonuç okunuyor...' : '🎲 Sonucu Gör'}
                </button>
              ) : (
                <div className="alert alert--info">
                  Sonuç hazırlanıyor... (~{Math.max(0, Math.round((slotsRemaining ?? 0) * APPROX_SECONDS_PER_SLOT))} sn)
                </div>
              )}
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
              <strong>{spinsRemaining}</strong>
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
            <div className="luck-tokenomics__stat">
              <span>Kasa</span>
              <strong>
                {vaultSol !== null ? `${fmtSol(vaultSol)} SOL` : '...'}{' '}
                <span className={`luck-game__mode luck-game__mode--${easyMode ? 'easy' : 'hard'}`}>
                  {easyMode ? 'Kolay Mod' : 'Zor Mod'}
                </span>
              </strong>
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
        ⚠️ Rastgelelik zincir üstü blockhash tabanlı (denetlenmemiş bir sözde-VRF) — ayrıntı için{' '}
        <code>program/luck-game/README.md</code>. $LUCK gibi bu oyun da eğlence amaçlıdır, sadece
        kaybetmeyi göze alabileceğin miktarla oyna. "Oyun cüzdanı" (delegate), yalnızca satın aldığın
        spin bakiyeni harcayabilir — gerçek cüzdanına veya kasaya asla erişemez.
      </div>
    </div>
  )
}
