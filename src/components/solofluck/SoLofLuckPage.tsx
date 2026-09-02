import { useEffect, useState } from 'react'
import { SOCIAL_LINKS, type NetworkId } from '../../config'
import { hashFromRoute, routeFromHash } from '../../lib/deepLink'
import { MatrixBackground } from './MatrixBackground'
import { AboutTab } from './AboutTab'
import { TokenomicsTab } from './TokenomicsTab'
import { ValueTab } from './ValueTab'
import { PresaleTab } from './PresaleTab'
import { GameTab } from './GameTab'
import { ClaimTab } from './ClaimTab'

type SubTab = 'about' | 'tokenomics' | 'value' | 'presale' | 'claim' | 'game'

// The same routing definition as in App.tsx. The two must not drift apart;
// check-abi verifies that.
const ROUTES = {
  pages: ['create', 'liquidity', 'privacy', 'solofluck'] as const,
  defaultPage: 'create' as const,
  subTabs: ['about', 'tokenomics', 'value', 'presale', 'claim', 'game'] as const,
  defaultSubTab: 'about' as const,
  subTabPage: 'solofluck' as const,
}

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: 'about', label: 'About' },
  { id: 'tokenomics', label: 'Tokenomics' },
  { id: 'value', label: '📈 Value' },
  { id: 'presale', label: 'Presale' },
  { id: 'claim', label: '🎁 My Share' },
  { id: 'game', label: '🎰 Game' },
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
  // The sub-tab lives in the address bar too, so #solofluck/presale can be
  // shared. For a presale that matters on its own — the address given in an
  // announcement must take the user straight to the presale.
  const [tab, setTab] = useState<SubTab>(
    () => routeFromHash(window.location.hash, ROUTES).subTab,
  )

  useEffect(() => {
    const apply = () => setTab(routeFromHash(window.location.hash, ROUTES).subTab)
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  useEffect(() => {
    const next = hashFromRoute('solofluck', tab, ROUTES)
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next)
    }
  }, [tab])

  return (
    <div className="luck-page">
      <MatrixBackground />
      <div className="luck-page__content">
        <section className="luck-hero">
          <div className="luck-hero__badge">🍀 777 · Try Your Luck On Solana 🍀</div>
          <h1>
            <span className="luck-gradient-text">SoLofLuck</span> ($LUCK)
          </h1>
          <p className="luck-hero__subtitle">
            A luck coin dedicated to this site, living on the Solana network. Join the presale,
            collect raffle tickets, study the tokenomics — all in one tab.
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
          {tab === 'value' && <ValueTab />}
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
          <p>Nothing on this site, $LUCK included, is investment advice.</p>
        </footer>
      </div>
    </div>
  )
}
