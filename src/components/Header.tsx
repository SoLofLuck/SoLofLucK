import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import type { NetworkId } from '../config'
import { NETWORKS } from '../config'

interface Props {
  network: NetworkId
  onNetworkChange: (network: NetworkId) => void
}

export function Header({ network, onNetworkChange }: Props) {
  return (
    <header className="site-header">
      <div className="site-header__brand">
        <span className="logo-mark">🍀</span>
        <span className="logo-text">
          SoLofLuck <small>Token Creator &amp; $LUCK</small>
        </span>
      </div>

      <div className="site-header__actions">
        <select
          className="network-select"
          value={network}
          onChange={(e) => onNetworkChange(e.target.value as NetworkId)}
          aria-label="Ağ seçimi"
        >
          {Object.values(NETWORKS).map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
        <WalletMultiButton />
      </div>
    </header>
  )
}
