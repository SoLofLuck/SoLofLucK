import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { listAllWalletTokens, listWalletToken2022Accounts, type WalletTokenBalance } from '../lib/walletTokens'
import { getTokenMetadata } from '../lib/tokenMetadata'
import { NATIVE_SOL_MINT } from '../lib/raydium'
import { TokenIcon, SOL_ICON } from './TokenIcon'

interface Props {
  /** true ise yalnızca Token-2022 hesapları listelenir (ör. gizli transfer). */
  token2022Only?: boolean
  /** true ise listenin başında hızlı "SOL" seçeneği gösterilir. */
  allowSol?: boolean
  /** Explorer linki için ağ eki, ör. "?cluster=devnet". Boş bırakılırsa Mainnet varsayılır. */
  explorerCluster?: string
  onSelect: (mintAddress: string) => void
}

interface DisplayToken extends WalletTokenBalance {
  name?: string
  symbol?: string
  image?: string
}

const SOL_ENTRY: DisplayToken = {
  mint: NATIVE_SOL_MINT,
  tokenAccount: '',
  programId: '',
  uiAmount: '',
  decimals: 9,
  name: 'Solana',
  symbol: 'SOL',
  image: SOL_ICON,
}

function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : mint
}

function copyToClipboard(e: MouseEvent, text: string) {
  e.stopPropagation()
  navigator.clipboard?.writeText(text).catch(() => {})
}

/**
 * Cüzdandaki coin'leri, Raydium'un "Select a token" penceresine benzer bir
 * tasarımla listeleyip seçtiren, sayfalar arası paylaşılan bir seçici.
 * Kalabalık görünmesin diye liste varsayılan olarak kapalıdır; kompakt bir
 * düğmeye tıklanınca aranabilir/kaydırılabilir bir panel açılır. Seçim
 * yapıldığında sadece mint adresini bildirir — seçildikten sonra ne
 * yapılacağına (havuz oluşturma, gizli transfer vb.) çağıran sayfa karar verir.
 */
export function CoinPicker({ token2022Only = false, allowSol = false, explorerCluster = '', onSelect }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()

  const [tokens, setTokens] = useState<DisplayToken[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [manualMint, setManualMint] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<DisplayToken | null>(null)

  useEffect(() => {
    if (!wallet.publicKey) {
      setTokens(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    const list = token2022Only
      ? listWalletToken2022Accounts(connection, wallet.publicKey)
      : listAllWalletTokens(connection, wallet.publicKey)

    list
      .then(async (result) => {
        if (cancelled) return
        setTokens(result)
        // İsim/sembol/logoyu arka planda tek tek doldur — liste hemen görünsün,
        // metadata geldikçe güncellensin.
        result.forEach((t, i) => {
          getTokenMetadata(connection, new PublicKey(t.mint)).then((meta) => {
            if (cancelled || !meta) return
            setTokens((prev) => {
              if (!prev) return prev
              const next = [...prev]
              next[i] = { ...next[i], name: meta.name, symbol: meta.symbol, image: meta.image }
              return next
            })
          })
        })
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Token listesi alınamadı.'))
      .finally(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [connection, wallet.publicKey, token2022Only])

  const fullList = allowSol ? [SOL_ENTRY, ...(tokens ?? [])] : tokens

  const displayList = useMemo(() => {
    if (!fullList) return fullList
    const q = query.trim().toLowerCase()
    if (!q) return fullList
    return fullList.filter(
      (t) =>
        (t.name && t.name.toLowerCase().includes(q)) ||
        (t.symbol && t.symbol.toLowerCase().includes(q)) ||
        t.mint.toLowerCase().includes(q),
    )
  }, [fullList, query])

  function openPicker() {
    setQuery('')
    setIsOpen(true)
  }

  function choose(t: DisplayToken) {
    setSelected(t)
    setIsOpen(false)
    onSelect(t.mint)
  }

  function chooseManual() {
    const mint = manualMint.trim()
    if (!mint) return
    setSelected({ mint, tokenAccount: '', programId: '', uiAmount: '', decimals: 0 })
    setManualMint('')
    setIsOpen(false)
    onSelect(mint)
  }

  return (
    <div className="coin-picker-field">
      <button type="button" className="coin-picker__trigger" onClick={openPicker}>
        {selected ? (
          <span className="coin-picker__trigger-selected">
            <TokenIcon image={selected.image} symbol={selected.symbol} size={24} />
            <span>{selected.symbol || shortMint(selected.mint)}</span>
          </span>
        ) : (
          <span className="coin-picker__trigger-placeholder">Coin Seçin</span>
        )}
        <span className="coin-picker__trigger-chevron">▾</span>
      </button>

      {isOpen && (
        <div className="coin-picker__overlay" onClick={() => setIsOpen(false)}>
          <div className="coin-picker__modal" onClick={(e) => e.stopPropagation()}>
            <div className="coin-picker__modal-header">
              <h3>Coin Seçin</h3>
              <button type="button" className="coin-picker__close" onClick={() => setIsOpen(false)} aria-label="Kapat">
                ✕
              </button>
            </div>
            <div className="coin-picker__search">
              <span className="coin-picker__search-icon">⌕</span>
              <input
                type="text"
                placeholder="İsim, sembol ya da mint adresiyle ara"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
            <div className="coin-picker__modal-body">
              {loading && <p className="subtab-desc">Cüzdanınızdaki token'lar yükleniyor...</p>}
              {error && <div className="alert alert--error">{error}</div>}
              {!wallet.connected && <p className="subtab-desc">Devam etmek için önce cüzdanınızı bağlayın.</p>}
              {displayList && displayList.length === 0 && (
                <p className="subtab-desc">Eşleşen coin bulunamadı.</p>
              )}
              {displayList && displayList.length > 0 && (
                <div className="coin-picker__list">
                  {displayList.map((t) => (
                    <div
                      key={t.mint + t.tokenAccount}
                      className="coin-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => choose(t)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') choose(t)
                      }}
                    >
                      <TokenIcon image={t.image} symbol={t.symbol} size={32} />
                      <span className="coin-row__info">
                        <span className="coin-row__symbol">{t.symbol || 'İsimsiz Token'}</span>
                        <span className="coin-row__name">{t.name || shortMint(t.mint)}</span>
                      </span>
                      <span className="coin-row__right">
                        {t.uiAmount !== '' && <span className="coin-row__balance">{t.uiAmount}</span>}
                        <span className="coin-row__addr">
                          <code>{shortMint(t.mint)}</code>
                          <button
                            type="button"
                            className="coin-row__icon-btn"
                            onClick={(e) => copyToClipboard(e, t.mint)}
                            aria-label="Adresi kopyala"
                            title="Adresi kopyala"
                          >
                            ⧉
                          </button>
                          <a
                            className="coin-row__icon-btn"
                            href={`https://explorer.solana.com/address/${t.mint}${explorerCluster}`}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Explorer'da görüntüle"
                            title="Explorer'da görüntüle"
                          >
                            ↗
                          </a>
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  chooseManual()
                }}
                style={{ marginTop: 12 }}
              >
                <label className="field">
                  <span>Ya da mint adresini yapıştırın</span>
                  <input
                    type="text"
                    placeholder="Token mint adresi"
                    value={manualMint}
                    onChange={(e) => setManualMint(e.target.value)}
                  />
                </label>
                <button type="submit" className="btn btn--secondary">
                  Bu Mint'i Kullan
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
