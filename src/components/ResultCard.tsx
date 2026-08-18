import type { CreateTokenResult } from '../lib/createToken'
import type { NetworkId } from '../config'
import { NETWORKS } from '../config'

interface Props {
  result: CreateTokenResult
  network?: NetworkId
  onReset: () => void
}

export function ResultCard({ result, network = 'devnet', onReset }: Props) {
  const cluster = NETWORKS[network].explorerCluster

  return (
    <div className="result-card">
      <div className="result-card__icon">✅</div>
      <h2>Token Başarıyla Oluşturuldu!</h2>
      <p>Token'ınız Solana ağında oluşturuldu ve toplam arz cüzdanınıza gönderildi.</p>

      <div className="result-card__row">
        <span>Mint Adresi</span>
        <code>{result.mint}</code>
      </div>
      <div className="result-card__row">
        <span>Token Hesabı</span>
        <code>{result.tokenAccount}</code>
      </div>
      <div className="result-card__row">
        <span>İşlem İmzası</span>
        <code>{result.signature}</code>
      </div>

      {result.confidentialTransferEnabled && (
        <div className="alert alert--info">
          🔒 Gizli Miktar Transferi etkin (Token-2022). Kullanmaya başlamak için üstteki "Gizli
          Miktar Transferi" sekmesinden bu mint adresiyle hesabınızı yapılandırın.
        </div>
      )}

      <div className="result-card__links">
        <a
          className="btn btn--secondary"
          href={`https://explorer.solana.com/address/${result.mint}${cluster}`}
          target="_blank"
          rel="noreferrer"
        >
          Explorer'da Görüntüle
        </a>
        <a
          className="btn btn--secondary"
          href={`https://solscan.io/token/${result.mint}${network === 'devnet' ? '?cluster=devnet' : ''}`}
          target="_blank"
          rel="noreferrer"
        >
          Solscan'de Görüntüle
        </a>
      </div>

      <button className="btn btn--primary" onClick={onReset}>
        Yeni Token Oluştur
      </button>
    </div>
  )
}
