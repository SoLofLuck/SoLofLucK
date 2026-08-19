import { useCallback, useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { GAME_CONFIG } from '../../config'
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
} from '../../lib/luckGame'

const POLL_MS = 3000
// Solana'da ortalama slot süresi ~400-500ms — bu yalnızca kullanıcıya
// kabaca bir bekleme süresi göstermek için, kesin bir taahhüt değil.
const APPROX_SECONDS_PER_SLOT = 0.45

function fmtSol(n: number): string {
  return n.toLocaleString('tr-TR', { maximumFractionDigits: 3 })
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
      if (wallet.publicKey) {
        const ps = await fetchPlayerState(connection, wallet.publicKey)
        setPlayerState(ps)
      } else {
        setPlayerState(null)
      }
    } catch (err) {
      console.error('Oyun durumu okunamadı:', err)
    }
  }, [connection, wallet.publicKey, configured])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  async function handlePlay() {
    setError('')
    setLastResult(null)
    setBusy('play')
    try {
      await playGame(connection, wallet, setStatus)
      setStatus('Oyun başladı — sonuç birkaç saniye içinde açığa çıkacak.')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'İşlem başarısız oldu.')
      setStatus('')
    } finally {
      setBusy(null)
    }
  }

  async function handleResolve() {
    setError('')
    setBusy('resolve')
    try {
      const sig = await resolveGame(connection, wallet, setStatus)
      setStatus('Sonuç okunuyor...')
      const result = await parsePlayResolvedFromTx(connection, sig)
      setLastResult(result)
      setStatus('')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'İşlem başarısız oldu.')
      setStatus('')
    } finally {
      setBusy(null)
    }
  }

  async function handleForfeit() {
    setError('')
    setBusy('forfeit')
    try {
      await forfeitStuckPlay(connection, wallet, setStatus)
      setStatus('Sıkışan deneme temizlendi, tekrar oynayabilirsin.')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'İşlem başarısız oldu.')
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
  const prizeSol = gameConfig ? lamportsToSol(gameConfig.prizeLamports) : GAME_CONFIG.prizeSol
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

  return (
    <div className="luck-game">
      <p className="subtab-desc">
        Zincir üzerinde çalışan gerçekten zor bir şans çarkı — kaynak kodu ve nasıl adil olduğu{' '}
        <code>program/luck-game</code> içinde. Her cüzdana <strong>{freePlays} ücretsiz deneme</strong>,
        sonrası <strong>{fmtSol(entryFeeSol)} SOL</strong>. Kasa{' '}
        <strong>{fmtSol(thresholdSol)} SOL'a</strong> ulaşınca oyun biraz kolaylaşır ve kazanan{' '}
        <strong>{fmtSol(prizeSol)} SOL</strong> kazanır.
      </p>

      {initialized === false && (
        <div className="alert alert--warning">
          ⚠️ Program deploy edilmiş görünüyor ama henüz <code>initialize()</code> çağrılmamış —
          oyun henüz kurulmadı.
        </div>
      )}

      {!wallet.connected ? (
        <div className="luck-presale__connect">
          <p>Oynamak için önce cüzdanını bağla.</p>
          <WalletMultiButton />
        </div>
      ) : (
        <>
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

          {error && <div className="alert alert--error">{error}</div>}
          {!error && status && <div className="alert alert--info">{status}</div>}

          {lastResult && (
            <div
              className={`luck-game__result ${lastResult.won ? 'luck-game__result--win' : 'luck-game__result--lose'}`}
            >
              {lastResult.won ? (
                <>🎉 KAZANDIN! {fmtSol(lamportsToSol(lastResult.prizePaidLamports))} SOL cüzdanına gönderildi.</>
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
