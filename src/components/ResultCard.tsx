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
      <h2>Token Created Successfully!</h2>
      <p>Your token was created on the Solana network and the full supply was sent to your wallet.</p>

      <div className="result-card__row">
        <span>Mint Adresi</span>
        <code>{result.mint}</code>
      </div>
      <div className="result-card__row">
        <span>Token Account</span>
        <code>{result.tokenAccount}</code>
      </div>
      <div className="result-card__row">
        <span>Transaction Signature</span>
        <code>{result.signature}</code>
      </div>

      {result.confidentialTransferEnabled && (
        <div className="alert alert--info">
          🔒 Confidential Amount Transfer is enabled (Token-2022). To start using it, configure your
          account with this mint address from the "Confidential Amount Transfer" tab above.
        </div>
      )}

      <div className="result-card__links">
        <a
          className="btn btn--secondary"
          href={`https://explorer.solana.com/address/${result.mint}${cluster}`}
          target="_blank"
          rel="noreferrer"
        >
          View on Explorer
        </a>
        <a
          className="btn btn--secondary"
          href={`https://solscan.io/token/${result.mint}${network === 'devnet' ? '?cluster=devnet' : ''}`}
          target="_blank"
          rel="noreferrer"
        >
          View on Solscan
        </a>
      </div>

      <button className="btn btn--primary" onClick={onReset}>
        Create Another Token
      </button>
    </div>
  )
}
