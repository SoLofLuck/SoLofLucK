import { useState } from 'react'
import { SOCIAL_LINKS, type NetworkId } from '../../config'
import { MatrixBackground } from './MatrixBackground'
import { AboutTab } from './AboutTab'
import { TokenomicsTab } from './TokenomicsTab'
import { PresaleTab } from './PresaleTab'
import { GameTab } from './GameTab'

type SubTab = 'about' | 'tokenomics' | 'presale' | 'game'

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: 'about', label: 'Hakkında' },
  { id: 'tokenomics', label: 'Tokenomics' },
  { id: 'presale', label: 'Presale' },
  { id: 'game', label: '🎰 Oyun' },
]

interface Props {
  network: NetworkId
}

const SOCIAL_ITEMS = [
  { key: 'twitter', label: 'X / Twitter', icon: '𝕏', url: SOCIAL_LINKS.twitter },
  { key: 'telegram', label: 'Telegram', icon: '✈️', url: SOCIAL_LINKS.telegram },
  { key: 'discord', label: 'Discord', icon: '💬', url: SOCIAL_LINKS.discord },
].filter((s) => s.url)

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
          {tab === 'game' && <GameTab />}
        </div>

        <footer className="luck-footer">
          {SOCIAL_ITEMS.length > 0 && (
            <div className="luck-social">
              {SOCIAL_ITEMS.map((s) => (
                <a key={s.key} href={s.url} target="_blank" rel="noreferrer" className="luck-social__link">
                  <span aria-hidden="true">{s.icon}</span> {s.label}
                </a>
              ))}
            </div>
          )}
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
