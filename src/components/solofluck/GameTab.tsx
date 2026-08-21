import { useCallback, useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { GAME_CONFIG } from '../../config'
import { SlotMachine } from './SlotMachine'
import {
  fetchGameConfig,
  fetchPlayerState,
  fetchVaultBalanceLamports,
  forfeitStuckPlay,
  getConfigPda,
  isLuckGameConfigured,
  lamportsToSol,
  parsePlayResolvedFromTx,
  playGame,
  resolveGame,
  type OnChainGameConfig,
  type OnChainPlayerState,
  type PlayResolvedResult,
  type TxSigner,
} from '../../lib/luckGame'
import { ensureTestWalletFunded, loadOrCreateTestWallet, toTxSigner } from '../../lib/localTestWallet'

// Test cüzdanının minimum devnet bakiyesi: ~birkaç işlem ücreti + PlayerState
// hesabının ilk kayıt (rent) maliyeti için yeterli küçük bir tampon.
const TEST_WALLET_MIN_LAMPORTS = 50_000_000 // 0.05 SOL

// Public devnet RPC'si (api.devnet.solana.com) IP başına sıkı hız sınırı
// uyguluyor — arka plan polling'i çok sık olursa gerçek bir işlem
// gönderirken (Oyna/Sonucu Gör) 429'a takılma ihtimali artıyor.
const POLL_MS = 8000
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

  const [busy, setBusy] = useState<'play' | 'resolve' | 'forfeit' | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [lastResult, setLastResult] = useState<PlayResolvedResult | null>(null)

  // Devnet-only hata ayıklama modu: Phantom'ın mobil onay/deep-link akışı
  // yavaş kaldığında (blockhash süresi dolmasına yol açıyor) kullanıcının
  // gerçek cüzdan olmadan, anında imzalayan yerel bir cüzdanla oyunu
  // tamamlayıp oyun mantığının kendisinin çalıştığını doğrulamasını sağlar.
  const [testKeypair] = useState(() => loadOrCreateTestWallet())
  const [testWalletOn, setTestWalletOn] = useState(false)
  const [testBalance, setTestBalance] = useState<number | null>(null)
  const [testFunding, setTestFunding] = useState(false)
  const [testFundError, setTestFundError] = useState('')

  const activePublicKey = testWalletOn ? testKeypair.publicKey : wallet.publicKey
  const activeSigner: TxSigner | null = testWalletOn
    ? toTxSigner(testKeypair)
    : wallet.publicKey && wallet.signTransaction
      ? { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction }
      : null
  const isActive = testWalletOn || wallet.connected

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
      if (activePublicKey) {
        const ps = await fetchPlayerState(connection, activePublicKey)
        setPlayerState(ps)
        if (testWalletOn) {
          setTestBalance(await connection.getBalance(activePublicKey))
        }
      } else {
        setPlayerState(null)
      }
    } catch (err) {
      console.error('Oyun durumu okunamadı:', err)
    }
  }, [connection, activePublicKey, testWalletOn, configured])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

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

  async function handlePlay() {
    if (!activeSigner) return
    setError('')
    setLastResult(null)
    setBusy('play')
    try {
      await playGame(connection, activeSigner, setStatus)
      setStatus('Oyun başladı — sonuç birkaç saniye içinde açığa çıkacak.')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
    } finally {
      setBusy(null)
    }
  }

  async function handleResolve() {
    if (!activeSigner) return
    setError('')
    setBusy('resolve')
    try {
      const sig = await resolveGame(connection, activeSigner, setStatus)
      setStatus('Sonuç okunuyor...')
      const result = await parsePlayResolvedFromTx(connection, sig)
      setLastResult(result)
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

  async function handleForfeit() {
    if (!activeSigner) return
    setError('')
    setBusy('forfeit')
    try {
      await forfeitStuckPlay(connection, activeSigner, setStatus)
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
  const entryFeeSol = gameConfig ? lamportsToSol(gameConfig.entryFeeLamports) : GAME_CONFIG.entryFeeSol
  const smallPrizeSol = gameConfig ? lamportsToSol(gameConfig.smallPrizeLamports) : GAME_CONFIG.smallPrizeSol
  const bigPrizeSol = gameConfig ? lamportsToSol(gameConfig.bigPrizeLamports) : GAME_CONFIG.bigPrizeSol
  const thresholdSol = gameConfig
    ? lamportsToSol(gameConfig.vaultEasyThresholdLamports)
    : GAME_CONFIG.vaultEasyThresholdSol
  const vaultSol = vaultLamports !== null ? lamportsToSol(vaultLamports) : null
  const easyMode = vaultSol !== null && vaultSol >= thresholdSol

  const playsCount = playerState?.playsCount ?? 0
  const winsCount = playerState?.winsCount ?? 0
  const freeLeft = Math.max(0, freePlays - playsCount)
  const pending = playerState?.pending ?? false

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
        <code>program/luck-game</code> içinde. Her cüzdana <strong>{freePlays} ücretsiz deneme</strong>,
        sonrası <strong>{fmtSol(entryFeeSol)} SOL</strong>. Kasa{' '}
        <strong>{fmtSol(thresholdSol)} SOL'a</strong> ulaşınca oyun biraz kolaylaşır. Kazananların çoğu{' '}
        <strong>{fmtSol(smallPrizeSol)} SOL</strong> küçük ödül alır, şanslı bir azınlık ise{' '}
        <strong>{fmtSol(bigPrizeSol)} SOL</strong> büyük ödülü/jackpot'u kazanır.
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

          <SlotMachine spinning={spinning} result={slotResult} bigWin={lastResult?.isBigWin ?? false} />

          {error && <div className="alert alert--error">{error}</div>}
          {!error && status && <div className="alert alert--info">{status}</div>}

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
              disabled={busy !== null}
            >
              {busy === 'play'
                ? 'Gönderiliyor...'
                : freeLeft > 0
                  ? `🎰 Oyna (Ücretsiz, ${freeLeft} hakkın kaldı)`
                  : `🎰 Oyna (${entryFeeSol} SOL)`}
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
                disabled={busy !== null}
              >
                {busy === 'forfeit' ? 'Temizleniyor...' : 'Denemeyi Temizle ve Tekrar Oyna'}
              </button>
            </div>
          )}

          <div className="luck-tokenomics__summary luck-game__stats">
            <div className="luck-tokenomics__stat">
              <span>Ücretsiz Deneme</span>
              <strong>
                {freeLeft} / {freePlays}
              </strong>
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
              <span>Kasa</span>
              <strong>
                {vaultSol !== null ? `${fmtSol(vaultSol)} SOL` : '...'}{' '}
                <span className={`luck-game__mode luck-game__mode--${easyMode ? 'easy' : 'hard'}`}>
                  {easyMode ? 'Kolay Mod' : 'Zor Mod'}
                </span>
              </strong>
            </div>
          </div>
        </>
      )}

      <div className="alert alert--warning luck-game__disclaimer">
        ⚠️ Rastgelelik zincir üstü blockhash tabanlı (denetlenmemiş bir sözde-VRF) — ayrıntı için{' '}
        <code>program/luck-game/README.md</code>. $LUCK gibi bu oyun da eğlence amaçlıdır, sadece
        kaybetmeyi göze alabileceğin miktarla oyna.
      </div>
    </div>
  )
}
