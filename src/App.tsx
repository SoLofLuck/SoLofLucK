import { Suspense, lazy, useMemo, useState } from 'react'
import { WalletContextProvider } from './context/WalletContextProvider'
import { Header } from './components/Header'
import { Hero } from './components/Hero'
import { TokenForm } from './components/TokenForm'
import { Footer } from './components/Footer'
import { NETWORKS, DEFAULT_NETWORK, type NetworkId } from './config'

// Raydium SDK oldukça büyük olduğu için bu sekmeyi yalnızca kullanıcı
// gerçekten ziyaret ettiğinde ayrı bir parça (chunk) olarak yüklüyoruz —
// Token Oluştur sayfasının ilk açılışını yavaşlatmasın diye.
const LiquidityPage = lazy(() =>
  import('./components/LiquidityPage').then((m) => ({ default: m.LiquidityPage })),
)

// zk-sdk (WASM tabanlı zero-knowledge kanıt kütüphanesi) oldukça büyük
// olduğu için bu sekmeyi de yalnızca ziyaret edildiğinde ayrı parça olarak yüklüyoruz.
const ConfidentialTransferPage = lazy(() =>
  import('./components/ConfidentialTransferPage').then((m) => ({ default: m.ConfidentialTransferPage })),
)

// Matrix arka plan animasyonu + presale sekmesi bu sitenin kendi coin'ine
// özel olduğu için diğer araçların ilk yüklemesini etkilememesi adına ayrı
// parça olarak yükleniyor.
const SoLofLuckPage = lazy(() =>
  import('./components/solofluck/SoLofLuckPage').then((m) => ({ default: m.SoLofLuckPage })),
)

type Page = 'create' | 'liquidity' | 'privacy' | 'solofluck'

function App() {
  const [network, setNetwork] = useState<NetworkId>(DEFAULT_NETWORK)
  const [page, setPage] = useState<Page>('create')
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
            Token Oluştur
          </button>
          <button
            type="button"
            className={`page-tab ${page === 'liquidity' ? 'page-tab--active' : ''}`}
            onClick={() => setPage('liquidity')}
          >
            Likidite Havuzu
          </button>
          <button
            type="button"
            className={`page-tab ${page === 'privacy' ? 'page-tab--active' : ''}`}
            onClick={() => setPage('privacy')}
          >
            Gizli Miktar Transferi
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
              <Suspense fallback={<div className="alert alert--info">Yükleniyor...</div>}>
                <LiquidityPage network={network} />
              </Suspense>
            </div>
          )}
          {page === 'privacy' && (
            <div className="form-section">
              <Suspense fallback={<div className="alert alert--info">Yükleniyor...</div>}>
                <ConfidentialTransferPage network={network} />
              </Suspense>
            </div>
          )}
          {page === 'solofluck' && (
            <Suspense fallback={<div className="alert alert--info">Yükleniyor...</div>}>
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
