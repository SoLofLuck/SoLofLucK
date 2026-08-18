import { useState } from 'react'
import type { NetworkId } from '../../config'
import { MatrixBackground } from './MatrixBackground'
import { AboutTab } from './AboutTab'
import { TokenomicsTab } from './TokenomicsTab'
import { PresaleTab } from './PresaleTab'

type SubTab = 'about' | 'tokenomics' | 'presale'

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: 'about', label: 'Hakkında' },
  { id: 'tokenomics', label: 'Tokenomics' },
  { id: 'presale', label: 'Presale' },
]

interface Props {
  network: NetworkId
}

export function SoLofLuckPage({ network }: Props) {
  const [tab, setTab] = useState<SubTab>('about')

  return (
    <div className="luck-page">
      <MatrixBackground />
      <div className="luck-page__content">
        <section className="luck-hero">
          <div className="luck-hero__badge">🍀 777 · Solana'da Şansını Dene 🍀</div>
          <h1>
            <span className="luck-gradient-text">SoLofLuck</span> ($LUCK)
          </h1>
          <p className="luck-hero__subtitle">
            Bu siteye adanmış, Solana ağında yaşayan bir şans coin'i. Presale'e katıl, çekiliş
            biletlerini topla, tokenomics'i incele — hepsi tek sekmede.
          </p>
        </section>

        <nav className="subtabs luck-subtabs">
          {SUBTABS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`subtab ${tab === s.id ? 'subtab--active' : ''}`}
              onClick={() => setTab(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="luck-panel">
          {tab === 'about' && <AboutTab />}
          {tab === 'tokenomics' && <TokenomicsTab />}
          {tab === 'presale' && <PresaleTab network={network} />}
        </div>

        <footer className="luck-footer">
          <p>
            $LUCK dahil bu sitedeki hiçbir içerik yatırım tavsiyesi değildir. Testnet (Devnet)
            aşamasındayız — gerçek değeri olan varlıkları göndermeden önce ağın Devnet olduğundan
            emin olun.
          </p>
        </footer>
      </div>
    </div>
  )
}
