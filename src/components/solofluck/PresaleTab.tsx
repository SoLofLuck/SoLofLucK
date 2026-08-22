import { useState, type FormEvent } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { NETWORKS, PRESALE_TIERS, PRESALE_TICKET_UNIT_SOL, PRESALE_WALLET, type NetworkId } from '../../config'
import {
  PRESALE_OPS_FEE_PERCENT,
  calcTickets,
  getLocalContributions,
  presaleOpsFeeActive,
  sendPresaleContribution,
} from '../../lib/presale'
import { useSolUsdPrice } from '../../lib/solPrice'

function formatUsd(sol: number, solUsd: number | null): string {
  if (!solUsd || !Number.isFinite(sol) || sol <= 0) return ''
  return `≈ $${(sol * solUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
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

  async function handleFlexSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const amount = Number(flexAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Geçerli bir SOL miktarı girin.')
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

      {!wallet.connected && (
        <div className="luck-presale__connect">
          <p>Presale'e katılmak için önce cüzdanını bağla.</p>
          <WalletMultiButton />
        </div>
      )}

      <div className="luck-presale__grid">
        <form className="token-form luck-presale__card" onSubmit={handleFlexSubmit}>
          <h2>Serbest Katkı</h2>
          <p className="subtab-desc">
            İstediğin kadar SOL gönder. Bu seçenekte çekiliş bileti yoktur; katkın karşılığında
            $LUCK, presale sonunda cüzdanına transfer edilir.
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
              disabled={!configured || !wallet.connected}
            />
            {solUsd && Number(flexAmount) > 0 && (
              <small>{formatUsd(Number(flexAmount), solUsd)}</small>
            )}
          </label>
          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={!configured || !wallet.connected || loading !== null}
          >
            {loading === 'flex' ? 'Gönderiliyor...' : 'Katkıda Bulun'}
          </button>
        </form>

        <div className="token-form luck-presale__card">
          <h2>Sabit Paket + Çekiliş</h2>
          <p className="subtab-desc">
            Aşağıdan bir tutar seç ve gönder — her {PRESALE_TICKET_UNIT_SOL} SOL için{' '}
            <strong>1 çekiliş bileti</strong> kazanırsın. 777 temalı topluluk çekilişlerine
            otomatik katılırsın.
          </p>
          <div className="luck-tier-grid">
            {PRESALE_TIERS.map((tier) => (
              <button
                key={tier}
                type="button"
                className={`luck-tier-btn ${selectedTier === tier ? 'luck-tier-btn--active' : ''}`}
                onClick={() => setSelectedTier(tier)}
                disabled={!configured || !wallet.connected}
              >
                <span className="luck-tier-btn__amount">{tier} SOL</span>
                {solUsd && <span className="luck-tier-btn__usd">{formatUsd(tier, solUsd)}</span>}
                <span className="luck-tier-btn__tickets">🎟 {calcTickets(tier)}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={handleFixedSubmit}
            disabled={!configured || !wallet.connected || loading !== null || !selectedTier}
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
                <span>{h.mode === 'fixed' ? `🎟 ${h.tickets}` : '—'}</span>
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
