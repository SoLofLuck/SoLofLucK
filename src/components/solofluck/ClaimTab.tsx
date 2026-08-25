import { useCallback, useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { CLAIM_CONFIG, LUCK_TOKEN, RAFFLE, type NetworkId } from '../../config'
import { NETWORKS } from '../../config'
import {
  bytesToHex,
  claim,
  fetchClaimed,
  fetchDistributor,
  fetchMerkleFile,
  findEntry,
  formatLuck,
  isClaimConfigured,
  nextUnlockTs,
  unlockedAmount,
  type ClaimEntry,
  type DistributorState,
} from '../../lib/luckClaim'

interface Props {
  network: NetworkId
}

interface RoundView {
  id: number
  label: string
  entry: ClaimEntry
  state: DistributorState
  claimed: bigint
  unlocked: bigint
  claimable: bigint
  nextUnlock: number | null
  /** Yayınlanan dosyanın kökü zincirdekiyle uyuşuyor mu? */
  rootMatches: boolean
}

function roundLabel(id: number): string {
  return id === CLAIM_CONFIG.presaleRoundId ? 'Presale payın' : `${id}. hafta çekilişi`
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'şimdi'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} gün ${h} saat`
  if (h > 0) return `${h} saat ${m} dk`
  return `${m} dk`
}

export function ClaimTab({ network }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const configured = isClaimConfigured()

  const [rounds, setRounds] = useState<RoundView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busyRound, setBusyRound] = useState<number | null>(null)
  const [lastSignature, setLastSignature] = useState('')
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(id)
  }, [])

  const refresh = useCallback(async () => {
    if (!configured || !wallet.publicKey) {
      setRounds([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const address = wallet.publicKey.toBase58()
      const ids = [CLAIM_CONFIG.presaleRoundId, ...Array.from({ length: RAFFLE.rounds }, (_, i) => i + 1)]
      const found: RoundView[] = []

      for (const id of ids) {
        // Henüz yapılmamış turların dosyası yok — sessizce atlıyoruz.
        let file
        try {
          file = await fetchMerkleFile(id)
        } catch {
          continue
        }
        const entry = findEntry(file, address)
        if (!entry) continue

        const state = await fetchDistributor(connection, id)
        if (!state) continue

        const total = BigInt(entry.amount)
        const claimedSoFar = await fetchClaimed(connection, id, wallet.publicKey)
        const unlocked = unlockedAmount(state, total, now)
        found.push({
          id,
          label: roundLabel(id),
          entry,
          state,
          claimed: claimedSoFar,
          unlocked,
          claimable: unlocked > claimedSoFar ? unlocked - claimedSoFar : BigInt(0),
          nextUnlock: nextUnlockTs(state, now),
          rootMatches: bytesToHex(state.merkleRoot) === file.root,
        })
      }
      setRounds(found)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Dağıtım bilgisi okunamadı.')
    } finally {
      setLoading(false)
    }
  }, [configured, wallet.publicKey, connection, now])

  useEffect(() => {
    void refresh()
    // `now` her 30 saniyede değişiyor ama her değişimde zinciri yeniden
    // sorgulamak gereksiz yük olurdu; bilerek yalnızca cüzdan/bağlantı
    // değişince yeniliyoruz. Geri sayım metni zaten `now` ile render'da
    // güncelleniyor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, wallet.publicKey, connection])

  async function handleClaim(round: RoundView) {
    if (!wallet.publicKey || !wallet.signTransaction) return
    setError('')
    setStatus('')
    setLastSignature('')
    setBusyRound(round.id)
    try {
      const sig = await claim(
        connection,
        { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction },
        round.id,
        round.entry,
        setStatus,
      )
      setLastSignature(sig)
      setStatus('')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Çekme işlemi başarısız oldu.')
      setStatus('')
    } finally {
      setBusyRound(null)
    }
  }

  if (!configured) {
    return (
      <div className="luck-claim">
        <div className="alert alert--info">
          🔒 Dağıtım henüz başlamadı. Presale kapandıktan ve $LUCK yayınlandıktan sonra payını bu
          sekmeden çekebileceksin.
        </div>
      </div>
    )
  }

  const explorer = NETWORKS[network].explorerCluster

  return (
    <div className="luck-claim">
      <p className="subtab-desc">
        Presale payın ve kazandığın çekiliş ödülleri zincirde, kimsenin elle müdahale edemeyeceği
        bir programda duruyor. Açılan kısmı buradan sen çekiyorsun — ekip senin adına bir şey
        göndermiyor, gönderemiyor da.
      </p>

      {!wallet.connected && (
        <div className="luck-presale__connect">
          <p>Payını görmek için cüzdanını bağla.</p>
          <WalletMultiButton />
        </div>
      )}

      {error && <div className="alert alert--error">{error}</div>}
      {status && <div className="alert alert--info">{status}</div>}

      {lastSignature && (
        <div className="alert alert--success">
          ✅ Tokenler cüzdanına gönderildi.{' '}
          <a
            href={`https://solscan.io/tx/${lastSignature}${explorer}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            İşlemi gör
          </a>
        </div>
      )}

      {wallet.connected && loading && <div className="alert alert--info">Payın hesaplanıyor...</div>}

      {wallet.connected && !loading && rounds.length === 0 && (
        <div className="alert alert--info">
          Bu cüzdan için bir pay bulunamadı. Presale'e başka bir cüzdanla katıldıysan onu bağla.
        </div>
      )}

      {rounds.map((r) => (
        <div key={r.id} className="result-card luck-claim__round">
          <h3>{r.label}</h3>

          {!r.rootMatches && (
            <div className="alert alert--error">
              ⚠️ Yayınlanan liste zincirdeki kayıtla uyuşmuyor. Çekme denemesi reddedilir — lütfen
              sayfayı yenile, sorun sürerse bize bildir.
            </div>
          )}

          <div className="result-card__row">
            <span>Toplam payın</span>
            <strong>{formatLuck(BigInt(r.entry.amount))} {LUCK_TOKEN.symbol}</strong>
          </div>
          <div className="result-card__row">
            <span>Bugüne kadar açılan</span>
            <strong>{formatLuck(r.unlocked)} {LUCK_TOKEN.symbol}</strong>
          </div>
          <div className="result-card__row">
            <span>Çektiğin</span>
            <strong>{formatLuck(r.claimed)} {LUCK_TOKEN.symbol}</strong>
          </div>
          <div className="result-card__row">
            <span>Şimdi çekebileceğin</span>
            <strong className="luck-claim__claimable">
              {formatLuck(r.claimable)} {LUCK_TOKEN.symbol}
            </strong>
          </div>

          {r.nextUnlock !== null && (
            <div className="result-card__row">
              <span>Sonraki açılış</span>
              <strong>{formatCountdown(r.nextUnlock - now)}</strong>
            </div>
          )}

          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => handleClaim(r)}
            disabled={busyRound !== null || r.claimable === BigInt(0) || !r.rootMatches}
          >
            {busyRound === r.id
              ? 'Çekiliyor...'
              : r.claimable > BigInt(0)
                ? `${formatLuck(r.claimable)} ${LUCK_TOKEN.symbol} çek`
                : 'Şu an çekilebilecek bir şey yok'}
          </button>
        </div>
      ))}
    </div>
  )
}
