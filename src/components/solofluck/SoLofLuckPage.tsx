import { useEffect, useState } from 'react'
import { SOCIAL_LINKS, type NetworkId } from '../../config'
import { hashFromRoute, routeFromHash } from '../../lib/deepLink'
import { MatrixBackground } from './MatrixBackground'
import { AboutTab } from './AboutTab'
import { TokenomicsTab } from './TokenomicsTab'
import { PresaleTab } from './PresaleTab'
import { GameTab } from './GameTab'
import { ClaimTab } from './ClaimTab'

type SubTab = 'about' | 'tokenomics' | 'presale' | 'claim' | 'game'

// App.tsx'tekiyle aynı yönlendirme tanımı. İkisinin ayrışmaması gerekiyor;
// check-abi bunu doğruluyor.
const ROTA = {
  pages: ['create', 'liquidity', 'privacy', 'solofluck'] as const,
  defaultPage: 'create' as const,
  subTabs: ['about', 'tokenomics', 'presale', 'claim', 'game'] as const,
  defaultSubTab: 'about' as const,
  subTabPage: 'solofluck' as const,
}

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: 'about', label: 'Hakkında' },
  { id: 'tokenomics', label: 'Tokenomics' },
  { id: 'presale', label: 'Presale' },
  { id: 'claim', label: '🎁 Payım' },
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
  // Alt sekme de adres çubuğunda: #solofluck/presale paylaşılabilir olsun.
  // Bir presale için bu tek başına önemli — duyuruda verilen adres
  // kullanıcıyı doğrudan presale'e götürmeli.
  const [tab, setTab] = useState<SubTab>(
    () => routeFromHash(window.location.hash, ROTA).subTab,
  )

  useEffect(() => {
    const uygula = () => setTab(routeFromHash(window.location.hash, ROTA).subTab)
    window.addEventListener('hashchange', uygula)
    return () => window.removeEventListener('hashchange', uygula)
  }, [])

  useEffect(() => {
    const yeni = hashFromRoute('solofluck', tab, ROTA)
    if (window.location.hash !== yeni) {
      window.history.replaceState(null, '', yeni)
    }
  }, [tab])

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
          {tab === 'claim' && <ClaimTab network={network} />}
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
          <p>$LUCK dahil bu sitedeki hiçbir içerik yatırım tavsiyesi değildir.</p>
        </footer>
      </div>
    </div>
  )
}
