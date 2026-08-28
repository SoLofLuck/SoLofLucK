import { useEffect, useState, type FormEvent } from 'react'
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  NETWORKS,
  PRESALE_DURATION_WEEKS,
  PRESALE_SOFT_CAP_SOL,
  PRESALE_TARGET_SOL,
  PRESALE_TICKET_UNIT_SOL,
  RAFFLE,
  PRESALE_TIERS,
  PRESALE_TOKENS_PER_SOL,
  PRESALE_WALLET,
  type NetworkId,
} from '../../config'
import {
  PRESALE_OPS_FEE_PERCENT,
  calcTickets,
  computePresaleProgress,
  formatRemaining,
  getLocalContributions,
  presaleEndsAt,
  presaleOpsFeeActive,
  presalePhaseAt,
  sendPresaleContribution,
  tokensForSol,
  presaleClosedReason,
} from '../../lib/presale'
import { useSolUsdPrice } from '../../lib/solPrice'

function formatUsd(sol: number, solUsd: number | null): string {
  if (!solUsd || !Number.isFinite(sol) || sol <= 0) return ''
  return `≈ $${(sol * solUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/** SOL tutarını okunabilir metne — kalan kontenjan uyarılarında kullanılıyor. */
function fmtSol(n: number): string {
  return n.toLocaleString('tr-TR', { maximumFractionDigits: 3 })
}

function formatTokens(n: number): string {
  return n.toLocaleString('tr-TR', { maximumFractionDigits: 0 })
}

/**
 * Presale cüzdanının bakiyesinden canlı doluluk. Katkılar düz SOL transferi
 * olduğu için ayrı bir indexer'a gerek yok — cüzdanın bakiyesi toplananın
 * kendisi. Operasyon payı bu cüzdana hiç girmediğinden brüt tutar
 * computePresaleProgress içinde geri hesaplanıyor.
 */
function usePresaleProgress(connection: { getBalance: (k: PublicKey) => Promise<number> }) {
  const [poolSol, setPoolSol] = useState<number | null>(null)

  useEffect(() => {
    if (!PRESALE_WALLET) return
    let cancelled = false
    let key: PublicKey
    try {
      key = new PublicKey(PRESALE_WALLET)
    } catch {
      return
    }
    const read = async () => {
      try {
        const lamports = await connection.getBalance(key)
        if (!cancelled) setPoolSol(lamports / LAMPORTS_PER_SOL)
      } catch {
        // RPC geçici olarak cevap vermediyse eski değeri koru — çubuğu
        // sıfırlamak, "toplanan para kayboldu" gibi yanlış bir izlenim verir.
      }
    }
    read()
    const id = setInterval(read, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [connection])

  return poolSol
}

/** Dakikada bir yenilenen "şu an" — geri sayımı canlı tutar. */
function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

interface Props {
  network: NetworkId
}

export function PresaleTab({ network }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const cluster = NETWORKS[network].explorerCluster
  const solUsd = useSolUsdPrice()

  const [flexAmount, setFlexAmount] = useState('')
  const [selectedTier, setSelectedTier] = useState<number | null>(null)

  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState<'flex' | 'fixed' | null>(null)
  const [lastSignature, setLastSignature] = useState('')

  // getLocalContributions küçük bir localStorage okuması yaptığı için her
  // render'da yeniden hesaplamak yerine memoize etmeye gerek yok; yeni bir
  // katkı sonrası setLastSignature çağrısı zaten yeniden render tetikler.
  const history = getLocalContributions(network)

  const configured = Boolean(PRESALE_WALLET)
  const totalTickets = history.reduce((sum, h) => sum + h.tickets, 0)

  const poolSol = usePresaleProgress(connection)
  const now = useNow()
  const progress = computePresaleProgress(poolSol ?? 0)
  const phase = presalePhaseAt(now)
  const endsAt = presaleEndsAt()
  // Katkı yalnızca presale gerçekten açıkken kabul edilir. Karar saf bir
  // fonksiyonda (presaleClosedReason) ve testi var — bu, sitedeki tek para
  // kapısı olduğu için mantığın bileşenin içinde, sınanamaz halde durmaması
  // gerekiyor.
  const closedReason = presaleClosedReason({
    configured,
    targetReached: progress.targetReached,
    phase,
  })
  const canContribute = wallet.connected && closedReason === null

  // KALAN KONTENJAN. Site "777 SOL'den fazla katkı kabul edilmez (hard cap)"
  // diyor ama bunu hiçbir şey uygulamıyordu: 770 SOL'deyken 100 SOL gönderen
  // birinin işlemi geçer ve toplam 870'e çıkardı — verdiğimiz sözü tutmamış
  // olurduk. Presale düz bir cüzdan transferi olduğu için zincirde bunu
  // engelleyecek bir program yok; engelin arayüzde olması ŞART.
  //
  // Not: siteyi hiç kullanmadan doğrudan cüzdana gönderen birini bu da
  // durduramaz. Bu durum için politikayı kurallarda açıkça yazıyoruz:
  // hedefi aşan tutar iade edilir.
  const remainingSol = Math.max(0, PRESALE_TARGET_SOL - progress.grossSol)
  const exceedsQuota = (amount: number) => amount > remainingSol + 1e-9

  async function handleFlexSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const amount = Number(flexAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Geçerli bir SOL miktarı girin.')
      return
    }
    if (exceedsQuota(amount)) {
      setError(
        `Kalan kontenjan ${fmtSol(remainingSol)} SOL. Hedefi (${PRESALE_TARGET_SOL} SOL) aşan ` +
          'katkı kabul edilmiyor — lütfen miktarı düşür.',
      )
      return
    }
    setLoading('flex')
    try {
      const res = await sendPresaleContribution(connection, wallet, network, 'flex', amount, setStatus)
      setLastSignature(res.signature)
      setFlexAmount('')
      setStatus(`Katkın alındı: ${amount} SOL gönderildi.`)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'İşlem başarısız oldu.')
      setStatus('')
    } finally {
      setLoading(null)
    }
  }

  async function handleFixedSubmit() {
    setError('')
    if (!selectedTier) {
      setError('Önce bir paket seçin.')
      return
    }
    if (exceedsQuota(selectedTier)) {
      setError(
        `Kalan kontenjan ${fmtSol(remainingSol)} SOL. Bu paket hedefi aşıyor — daha küçük bir ` +
          'paket seç ya da serbest katkıdan kalan tutarı gönder.',
      )
      return
    }
    setLoading('fixed')
    try {
      const res = await sendPresaleContribution(connection, wallet, network, 'fixed', selectedTier, setStatus)
      setLastSignature(res.signature)
      setStatus(`${selectedTier} SOL gönderildi, ${res.tickets} çekiliş bileti kazandın! 🍀`)
      setSelectedTier(null)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'İşlem başarısız oldu.')
      setStatus('')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="luck-presale">
      {!configured && (
        <div className="alert alert--warning">
          ⚠️ Presale cüzdanı henüz yapılandırılmadı ({`src/config.ts`} içindeki{' '}
          <code>PRESALE_WALLET</code>). Katkı gönderme butonları, adres girilene kadar devre dışı.
        </div>
      )}

      <div className="luck-presale__meter">
        <div className="luck-presale__meter-head">
          <span className="luck-presale__meter-label">Presale Hedefi</span>
          <span className="luck-presale__meter-value">
            {poolSol === null ? '—' : progress.grossSol.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}{' '}
            / {PRESALE_TARGET_SOL} SOL
          </span>
        </div>
        <div
          className="luck-presale__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={PRESALE_TARGET_SOL}
          aria-valuenow={poolSol === null ? 0 : Math.round(progress.grossSol)}
        >
          <div className="luck-presale__bar-fill" style={{ width: `${progress.percent}%` }} />
          <div
            className="luck-presale__bar-softcap"
            style={{ left: `${(PRESALE_SOFT_CAP_SOL / PRESALE_TARGET_SOL) * 100}%` }}
            title={`Taban: ${PRESALE_SOFT_CAP_SOL} SOL`}
          />
        </div>
        <div className="luck-presale__meter-foot">
          <span>
            <strong>1 SOL = {formatTokens(PRESALE_TOKENS_PER_SOL)} $LUCK</strong>
          </span>
          <span>
            {phase === 'live' && endsAt
              ? `Bitişe ${formatRemaining(endsAt.getTime() - now.getTime())}`
              : phase === 'upcoming'
                ? 'Henüz başlamadı'
                : phase === 'ended'
                  ? 'Presale sona erdi'
                  : `${PRESALE_DURATION_WEEKS} hafta — tarih yakında`}
          </span>
        </div>
      </div>

      {closedReason === 'reached' && (
        <div className="alert alert--info">
          🎉 Hedefe ulaşıldı — presale kapandı. Sıradaki adım TGE: likidite havuzu açılır ve LP
          token'ları yakılır.
        </div>
      )}
      {closedReason === 'ended' && (
        <div className="alert alert--info">
          Presale süresi doldu. Toplanan tutara göre arz oranlanır, kalan tokenler yakılır.
        </div>
      )}
      {closedReason === 'upcoming' && (
        <div className="alert alert--info">Presale henüz başlamadı — katkı kabul edilmiyor.</div>
      )}
      {closedReason === 'unscheduled' && (
        <div className="alert alert--info">
          Presale tarihi henüz ilan edilmedi — katkı kabul edilmiyor. Tarih duyurulduğunda burada
          geri sayım görünecek.
        </div>
      )}

      {!wallet.connected && (
        <div className="luck-presale__connect">
          <p>Presale'e katılmak için önce cüzdanını bağla.</p>
          <WalletMultiButton />
        </div>
      )}

      {/* Bu uyarı bilerek gönderme formlarının HEMEN ÜSTÜNDE ve kırmızı
          tonda: presale dağıtımı, parayı GÖNDEREN adrese yapılıyor. Borsa
          hesabından gönderen biri, tokenleri borsanın toplama adresine
          göndermemizi istemiş oluyor — o tokenler pratikte kaybolur ve geri
          getirilemez. Sayfanın altındaki kurallar listesine gömülse
          kaçırılırdı. */}
      <div className="alert alert--error luck-presale__exchange-warning">
        <strong>⚠️ Borsa hesabından GÖNDERMEYİN.</strong> Tokenler yalnızca SOL'u gönderen
        adrese dağıtılır. Binance, OKX, Bybit gibi bir borsadan gönderirseniz tokenler
        borsanın adresine gider ve <strong>geri getirilemez</strong>. Phantom, Solflare gibi
        kendi anahtarınızın olduğu bir cüzdandan gönderin.
      </div>

      {closedReason === null && poolSol !== null && (
        <div className="alert alert--info luck-presale__quota">
          Kalan kontenjan: <strong>{fmtSol(remainingSol)} SOL</strong> — hedef{' '}
          {PRESALE_TARGET_SOL} SOL dolunca presale kapanır.
        </div>
      )}

      <div className="luck-presale__grid">
        <form className="token-form luck-presale__card" onSubmit={handleFlexSubmit}>
          <h2>Serbest Katkı</h2>
          <p className="subtab-desc">
            İstediğin kadar SOL gönder. Fiyat sabit:{' '}
            <strong>1 SOL = {formatTokens(PRESALE_TOKENS_PER_SOL)} $LUCK</strong>. Her{' '}
            {PRESALE_TICKET_UNIT_SOL} SOL {'\u2014'} hangi modu kullandığından bağımsız {'\u2014'}{' '}
            <strong>1 çekiliş bileti</strong> kazandırır.
          </p>
          <label className="field">
            <span>Miktar (SOL)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="ör. 2.5"
              value={flexAmount}
              onChange={(e) => setFlexAmount(e.target.value)}
              disabled={!canContribute}
            />
            {Number(flexAmount) > 0 && (
              <small>
                <strong>{formatTokens(tokensForSol(Number(flexAmount)))} $LUCK</strong>
                {solUsd ? ` · ${formatUsd(Number(flexAmount), solUsd)}` : ''}
              </small>
            )}
          </label>
          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={!canContribute || loading !== null}
          >
            {loading === 'flex' ? 'Gönderiliyor...' : 'Katkıda Bulun'}
          </button>
        </form>

        <div className="token-form luck-presale__card">
          <h2>Hazır Paketler</h2>
          <p className="subtab-desc">
            Hazır tutarlardan birini seç — her {PRESALE_TICKET_UNIT_SOL} SOL için{' '}
            <strong>1 çekiliş bileti</strong>. Serbest katkıyla aynı oran; bu sekme sadece
            hızlı seçim kolaylığı.
          </p>
          <div className="luck-tier-grid">
            {PRESALE_TIERS.map((tier) => (
              <button
                key={tier}
                type="button"
                className={`luck-tier-btn ${selectedTier === tier ? 'luck-tier-btn--active' : ''}`}
                onClick={() => setSelectedTier(tier)}
                disabled={!canContribute}
              >
                <span className="luck-tier-btn__amount">{tier} SOL</span>
                <span className="luck-tier-btn__tokens">{formatTokens(tokensForSol(tier))} $LUCK</span>
                {solUsd && <span className="luck-tier-btn__usd">{formatUsd(tier, solUsd)}</span>}
                <span className="luck-tier-btn__tickets">🎟 {calcTickets(tier)}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={handleFixedSubmit}
            disabled={!canContribute || loading !== null || !selectedTier}
          >
            {loading === 'fixed'
              ? 'Gönderiliyor...'
              : selectedTier
                ? `${selectedTier} SOL Gönder (${calcTickets(selectedTier)} bilet)`
                : 'Bir paket seç'}
          </button>
        </div>
      </div>

      {presaleOpsFeeActive && (
        <p className="luck-presale__ops-note">
          Katkının <strong>%{PRESALE_OPS_FEE_PERCENT.toLocaleString('tr-TR')}</strong>'lik kısmı
          operasyon payı olarak ayrılır — token yayınlanana kadarki giderleri (havuz açma ücreti, token
          metadata, RPC, alan adı, pazarlama) karşılar. Bu pay, aynı işlemde ayrı bir cüzdana gider
          ve <strong>likidite havuzuna eklenmez</strong>; kalan{' '}
          <strong>%{(100 - PRESALE_OPS_FEE_PERCENT).toLocaleString('tr-TR')}</strong> presale
          cüzdanında toplanır. Çekiliş biletlerin gönderdiğin <strong>tam tutar</strong> üzerinden
          hesaplanır, pay bilet sayını düşürmez. İmzalamadan önce cüzdanında her iki alıcıyı da
          görürsün.
        </p>
      )}

      <ul className="luck-presale__rules">
        <li>
          <strong>Sabit fiyat.</strong> 1 SOL = {formatTokens(PRESALE_TOKENS_PER_SOL)} $LUCK. Ne
          kadar toplanırsa toplansın bu oran değişmez; gönderirken tam olarak ne alacağını bilirsin.
        </li>
        <li>
          <strong>Hedef {PRESALE_TARGET_SOL} SOL, süre {PRESALE_DURATION_WEEKS} hafta.</strong>{' '}
          Hedefe erken ulaşılırsa presale o anda kapanır ve TGE'ye geçilir.
        </li>
        <li>
          <strong>Hedef dolmazsa arz oranlanır.</strong> Hedefin %X'i toplandıysa her kovadan
          (presale, likidite, topluluk, ekip, pazarlama) yalnızca %X'i basılır, kalanı{' '}
          <strong>yakılır</strong>. Yüzdelik dağılım aynen korunur ve havuz açılış fiyatı
          değişmez — hangi tutarda kapanırsa kapansın presale fiyatının üstünde açılır.
        </li>
        <li>
          <strong>Taban {PRESALE_SOFT_CAP_SOL} SOL.</strong> Bu tutara ulaşılmazsa TGE yapılmaz ve
          katkılar iade edilir. İade işlemleri zincirde takip edilebilir.
        </li>
        <li>
          <strong>Hedefi aşan katkı iade edilir.</strong> Bu sayfa, kalan kontenjandan büyük bir
          katkıyı göndermene izin vermez. Ama presale düz bir cüzdan transferi olduğu için,
          siteyi hiç kullanmadan doğrudan kasaya gönderen birini zincirde durduracak bir program
          yok — hedefi aşan tutar, gönderen adrese iade edilir ve iade işlemi zincirde
          görünür.
        </li>
        <li>
          <strong>Dağıtım claim ile.</strong> Tokenler TGE'de bir claim programına kilitlenir;
          açılan kısmı bu sayfadan sen çekersin. TGE'de %9, sonraki 13 hafta boyunca her hafta
          %7 daha açılır — 91. günde tamamı serbest.
        </li>
        <li>
          <strong>Alıcı listesi zincirden çıkar.</strong> Kim ne kadar gönderdiği presale
          kasasının işlem geçmişinde herkese açık. Listeyi bizden bağımsız olarak sen de
          üretip kendi payını doğrulayabilirsin — bize güvenmen gerekmiyor.
        </li>
        <li>
          <strong>Çekiliş biletleri.</strong> Her {PRESALE_TICKET_UNIT_SOL} SOL = 1 bilet.
          Haftalık çekilişlerde her hafta {RAFFLE.ticket.winnersPerRound} biletli kazanan
          çıkar, her biri {formatTokens(RAFFLE.perWinnerTokens)} $LUCK alır. Kazananlar,
          gelecekteki bir Solana slot'unun blockhash'iyle seçilir: o slot henüz oluşmadığı
          için sonucu kimse (biz dahil) önceden bilemez, oluştuktan sonra herkes doğrulayabilir.
        </li>
      </ul>

      {error && <div className="alert alert--error">{error}</div>}
      {!error && status && <div className="alert alert--info">{status}</div>}

      {lastSignature && (
        <a
          className="btn btn--secondary"
          href={`https://explorer.solana.com/tx/${lastSignature}${cluster}`}
          target="_blank"
          rel="noreferrer"
        >
          Son işlemi Explorer'da görüntüle
        </a>
      )}

      {history.length > 0 && (
        <div className="luck-presale__history">
          <div className="luck-presale__history-head">
            <h3>Bu cihazdaki katkı geçmişin</h3>
            <span className="luck-presale__ticket-total">🎟 Toplam bilet: {totalTickets}</span>
          </div>
          <ul>
            {[...history].reverse().map((h) => (
              <li key={h.signature}>
                <span>{h.mode === 'fixed' ? 'Sabit paket' : 'Serbest katkı'}</span>
                <span>{h.amountSol} SOL</span>
                <span>🎟 {h.tickets}</span>
                <a
                  href={`https://explorer.solana.com/tx/${h.signature}${cluster}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  işlem
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
