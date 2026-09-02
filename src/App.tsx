import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { WalletContextProvider } from './context/WalletContextProvider'
import { hashFromRoute, routeFromHash } from './lib/deepLink'
import { Header } from './components/Header'
import { Hero } from './components/Hero'
import { TokenForm } from './components/TokenForm'
import { Footer } from './components/Footer'
import { NETWORKS, DEFAULT_NETWORK, type NetworkId } from './config'

// The Raydium SDK is fairly large, so this tab is loaded as a separate chunk
// only when the user actually visits it — it must not slow down the first paint
// of the Create Token page.
const LiquidityPage = lazy(() =>
  import('./components/LiquidityPage').then((m) => ({ default: m.LiquidityPage })),
)

// zk-sdk (the WASM-based zero-knowledge proof library) is also large, so this
// tab too is loaded as a separate chunk only when it is visited.
const ConfidentialTransferPage = lazy(() =>
  import('./components/ConfidentialTransferPage').then((m) => ({ default: m.ConfidentialTransferPage })),
)

// The matrix background animation and the presale tab are specific to this
// site's own coin, so they load as a separate chunk to keep the other tools'
// first load unaffected.
const SoLofLuckPage = lazy(() =>
  import('./components/solofluck/SoLofLuckPage').then((m) => ({ default: m.SoLofLuckPage })),
)

type Page = 'create' | 'liquidity' | 'privacy' | 'solofluck'

// Tab routing in the address bar. An unknown hash falls back to the default:
// whatever the user types, the site must still open.
const ROUTES = {
  pages: ['create', 'liquidity', 'privacy', 'solofluck'] as const,
  defaultPage: 'create' as const,
  subTabs: ['about', 'tokenomics', 'value', 'presale', 'claim', 'game'] as const,
  defaultSubTab: 'about' as const,
  subTabPage: 'solofluck' as const,
}

function App() {
  const [network, setNetwork] = useState<NetworkId>(DEFAULT_NETWORK)

  // The tab state lives in the address bar: so a presale link can be shared, so
  // a refresh keeps you on the same tab, and so the back button works. The logic
  // is in src/lib/deepLink.ts and has its own test.
  const [page, setPage] = useState<Page>(
    () => routeFromHash(window.location.hash, ROUTES).page,
  )

  // Back/forward buttons and a manually edited address.
  useEffect(() => {
    const apply = () => setPage(routeFromHash(window.location.hash, ROUTES).page)
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  // Update the address bar when the tab changes. On the SoLofLuck page the
  // sub-tab is in the hash too, so we leave it alone — SoLofLuckPage owns it.
  useEffect(() => {
    if (page === 'solofluck') return
    const next = hashFromRoute(page, 'about', ROUTES)
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next)
    }
  }, [page])
  const endpoint = useMemo(() => NETWORKS[network].endpoint, [network])

  return (
    <WalletContextProvider endpoint={endpoint}>
      <div className="app-shell">
        <Header network={network} onNetworkChange={setNetwork} />
        <nav className="page-tabs">
          <button
            type="button"
            className={`page-tab ${page === 'create' ? 'page-tab--active' : ''}`}
            onClick={() => setPage('create')}
          >
            Create Token
          </button>
          <button
            type="button"
            className={`page-tab ${page === 'liquidity' ? 'page-tab--active' : ''}`}
            onClick={() => setPage('liquidity')}
          >
            Liquidity Pool
          </button>
          <button
            type="button"
            className={`page-tab ${page === 'privacy' ? 'page-tab--active' : ''}`}
            onClick={() => setPage('privacy')}
          >
            Confidential Amount Transfer
          </button>
          <button
            type="button"
            className={`page-tab page-tab--luck ${page === 'solofluck' ? 'page-tab--active' : ''}`}
            onClick={() => setPage('solofluck')}
          >
            🍀 SoLofLuck ($LUCK)
          </button>
        </nav>
        <main>
          {page === 'create' && (
            <>
              <Hero />
              <div className="form-section">
                <TokenForm network={network} />
              </div>
            </>
          )}
          {page === 'liquidity' && (
            <div className="form-section form-section--wide">
              <Suspense fallback={<div className="alert alert--info">Loading...</div>}>
                <LiquidityPage network={network} />
              </Suspense>
            </div>
          )}
          {page === 'privacy' && (
            <div className="form-section">
              <Suspense fallback={<div className="alert alert--info">Loading...</div>}>
                <ConfidentialTransferPage network={network} />
              </Suspense>
            </div>
          )}
          {page === 'solofluck' && (
            <Suspense fallback={<div className="alert alert--info">Loading...</div>}>
              <SoLofLuckPage network={network} />
            </Suspense>
          )}
        </main>
        {page !== 'solofluck' && <Footer />}
      </div>
    </WalletContextProvider>
  )
}

export default App
