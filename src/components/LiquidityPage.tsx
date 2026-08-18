import { useEffect, useState, type FormEvent } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import type { ApiV3PoolInfoStandardItemCpmm, CpmmKeys } from '@raydium-io/raydium-sdk-v2'
import {
  NATIVE_SOL_MINT,
  addCpmmLiquidity,
  createCpmmPool,
  getMintInfo,
  getPoolById,
  getWalletTokenBalance,
  loadRaydium,
  searchPoolsByMint,
  withdrawCpmmLiquidity,
  type CreatePoolResult,
  type MintRef,
  type PoolSummary,
} from '../lib/raydium'
import { LOCK_DURATION_OPTIONS, lockLpTokens, type LockResult } from '../lib/lock'
import { getTokenMetadata, type TokenMeta } from '../lib/tokenMetadata'
import { useSolUsdPrice } from '../lib/solPrice'
import { CoinPicker } from './CoinPicker'
import { TokenIcon, SOL_ICON } from './TokenIcon'
import { NETWORKS, type NetworkId } from '../config'

interface Props {
  network: NetworkId
}

type SubTab = 'search' | 'create' | 'manage' | 'lock'

function fmtNum(n: number, digits = 6): string {
  if (!Number.isFinite(n)) return '-'
  return n.toLocaleString('tr-TR', { maximumFractionDigits: digits })
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '-'
  return n.toLocaleString('tr-TR', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

/** "X SOL (~$Y)" satırı — SOL/USD fiyatı henüz gelmediyse yalnızca SOL kısmını gösterir. */
function PoolValueRow({ sol }: { sol: number }) {
  const solUsd = useSolUsdPrice()
  return (
    <div className="pool-card__row">
      <span>Havuz Değeri</span>
      <span>
        {fmtNum(sol, 4)} SOL{solUsd !== null && <span className="pool-card__usd"> (~{fmtUsd(sol * solUsd)})</span>}
      </span>
    </div>
  )
}

/**
 * Havuzun toplam değerini SOL cinsinden hesaplar — yalnızca havuzun bir
 * tarafı SOL ise mümkün (sabit-çarpım havuzlarda iki taraf her zaman eşit
 * değerdedir, o yüzden SOL tarafının 2 katı toplam değeri verir). Havuz
 * SOL içermiyorsa (ör. iki farklı token eşleşmesi), fiyat verisi olmadan
 * SOL karşılığı hesaplanamaz.
 */
function poolValueInSol(poolInfo: {
  mintA: { address: string }
  mintB: { address: string }
  mintAmountA: number
  mintAmountB: number
}): number | null {
  if (poolInfo.mintA.address === NATIVE_SOL_MINT) return poolInfo.mintAmountA * 2
  if (poolInfo.mintB.address === NATIVE_SOL_MINT) return poolInfo.mintAmountB * 2
  return null
}

export function LiquidityPage({ network }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const [subTab, setSubTab] = useState<SubTab>('search')

  return (
    <div className="liquidity-page">
      <div className="subtabs">
        <button
          type="button"
          className={`subtab ${subTab === 'search' ? 'subtab--active' : ''}`}
          onClick={() => setSubTab('search')}
        >
          Havuz Ara
        </button>
        <button
          type="button"
          className={`subtab ${subTab === 'create' ? 'subtab--active' : ''}`}
          onClick={() => setSubTab('create')}
        >
          Havuz Oluştur
        </button>
        <button
          type="button"
          className={`subtab ${subTab === 'manage' ? 'subtab--active' : ''}`}
          onClick={() => setSubTab('manage')}
        >
          Likidite Ekle / Çıkar
        </button>
        <button
          type="button"
          className={`subtab ${subTab === 'lock' ? 'subtab--active' : ''}`}
          onClick={() => setSubTab('lock')}
        >
          Likidite Kilitle
        </button>
      </div>

      {subTab === 'search' && <PoolSearch network={network} />}
      {subTab === 'create' && <PoolCreate network={network} connection={connection} wallet={wallet} />}
      {subTab === 'manage' && <PoolManage network={network} connection={connection} wallet={wallet} />}
      {subTab === 'lock' && <PoolLock network={network} connection={connection} wallet={wallet} />}
    </div>
  )
}

function PoolSearch({ network }: { network: NetworkId }) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const [mint1, setMint1] = useState('')
  const [mint2, setMint2] = useState('')
  const [pools, setPools] = useState<PoolSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSearch(e: FormEvent) {
    e.preventDefault()
    setError('')
    setPools(null)

    if (network === 'devnet') {
      setError(
        'Havuz arama, Raydium\'un herkese açık indeksleme servisi üzerinden çalışır ve yalnızca Mainnet verisini kapsar. Devnet\'te havuz aramak için lütfen ağ seçiciden Mainnet\'e geçin.',
      )
      return
    }
    if (!mint1.trim()) {
      setError('En az bir token mint adresi girin.')
      return
    }

    setLoading(true)
    try {
      const raydium = await loadRaydium(connection, wallet, network)
      const results = await searchPoolsByMint(raydium, mint1.trim(), mint2.trim() || undefined)
      setPools(results)
      if (results.length === 0) setError('Bu token(lar) için havuz bulunamadı.')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Havuzlar aranırken bir hata oluştu.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="token-form">
      <h2>Havuz Ara / Kontrol Et</h2>
      <p className="subtab-desc">
        Bir token'ın mevcut Raydium havuzlarını, fiyatını ve likiditesini görüntüleyin. Bu bölüm
        salt okunurdur — hiçbir işlem yapmaz, cüzdan bağlamanıza gerek yoktur.
      </p>

      <form onSubmit={handleSearch}>
        <div className="form-grid">
          <label className="field">
            <span>Token Mint Adresi *</span>
            <input
              type="text"
              placeholder="ör. token mint adresiniz"
              value={mint1}
              onChange={(e) => setMint1(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Eşleşecek 2. Token (opsiyonel)</span>
            <input
              type="text"
              placeholder="boş bırakılırsa tüm havuzlar"
              value={mint2}
              onChange={(e) => setMint2(e.target.value)}
            />
          </label>
        </div>
        <button type="button" className="btn btn--secondary" style={{ marginBottom: 16 }} onClick={() => setMint2(NATIVE_SOL_MINT)}>
          2. token olarak SOL kullan
        </button>
        {error && <div className="alert alert--error">{error}</div>}
        <button type="submit" className="btn btn--primary btn--block" disabled={loading}>
          {loading ? 'Aranıyor...' : 'Ara'}
        </button>
      </form>

      {pools && pools.length > 0 && (
        <div className="pool-list">
          {pools.map((p) => (
            <div className="pool-card" key={p.id}>
              <div className="pool-card__header">
                <strong>
                  {p.mintA.symbol} / {p.mintB.symbol}
                </strong>
                <span className="pool-card__badge">{p.type === 'Concentrated' ? 'CLMM' : 'CPMM'}</span>
              </div>
              <div className="pool-card__row">
                <span>Fiyat</span>
                <span>
                  {fmtNum(p.price)} {p.mintB.symbol}
                </span>
              </div>
              <div className="pool-card__row">
                <span>Toplam Likidite (TVL)</span>
                <span>${fmtNum(p.tvl, 2)}</span>
              </div>
              <div className="pool-card__row">
                <span>Rezervler</span>
                <span>
                  {fmtNum(p.mintAmountA, 4)} {p.mintA.symbol} / {fmtNum(p.mintAmountB, 4)}{' '}
                  {p.mintB.symbol}
                </span>
              </div>
              {poolValueInSol(p) !== null && <PoolValueRow sol={poolValueInSol(p)!} />}
              <div className="pool-card__row">
                <span>İşlem Ücreti</span>
                <span>%{fmtNum(p.feeRatePct, 3)}</span>
              </div>
              <div className="pool-card__row">
                <span>Havuz ID</span>
                <code className="pool-card__id">{p.id}</code>
              </div>
              <a
                className="btn btn--secondary"
                href={`https://raydium.io/liquidity-pools/?token=${p.mintA.address}`}
                target="_blank"
                rel="noreferrer"
              >
                Raydium'da Görüntüle
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PoolCreate({
  network,
  connection,
  wallet,
}: {
  network: NetworkId
  connection: ReturnType<typeof useConnection>['connection']
  wallet: ReturnType<typeof useWallet>
}) {
  const [mintAAddr, setMintAAddr] = useState('')
  const [mintBAddr, setMintBAddr] = useState('')
  const [mintAMeta, setMintAMeta] = useState<TokenMeta | null>(null)
  const [mintBMeta, setMintBMeta] = useState<TokenMeta | null>(null)
  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<CreatePoolResult | null>(null)

  useEffect(() => {
    if (!mintAAddr) {
      setMintAMeta(null)
      return
    }
    if (mintAAddr === NATIVE_SOL_MINT) {
      setMintAMeta({ name: 'Solana', symbol: 'SOL', image: SOL_ICON })
      return
    }
    let cancelled = false
    try {
      getTokenMetadata(connection, new PublicKey(mintAAddr)).then((meta) => !cancelled && setMintAMeta(meta))
    } catch {
      setMintAMeta(null)
    }
    return () => {
      cancelled = true
    }
  }, [connection, mintAAddr])

  useEffect(() => {
    if (!mintBAddr) {
      setMintBMeta(null)
      return
    }
    if (mintBAddr === NATIVE_SOL_MINT) {
      setMintBMeta({ name: 'Solana', symbol: 'SOL', image: SOL_ICON })
      return
    }
    let cancelled = false
    try {
      getTokenMetadata(connection, new PublicKey(mintBAddr)).then((meta) => !cancelled && setMintBMeta(meta))
    } catch {
      setMintBMeta(null)
    }
    return () => {
      cancelled = true
    }
  }, [connection, mintBAddr])

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setError('')
    setResult(null)

    if (!wallet.connected || !wallet.publicKey) {
      setError('Devam etmek için önce cüzdanınızı bağlayın.')
      return
    }
    if (!mintAAddr.trim() || !mintBAddr.trim()) {
      setError('İki token mint adresini de girin.')
      return
    }
    const amtA = Number(amountA)
    const amtB = Number(amountB)
    if (!amountA || !amountB || amtA <= 0 || amtB <= 0) {
      setError('Her iki token için de sıfırdan büyük bir başlangıç miktarı girin.')
      return
    }

    setLoading(true)
    try {
      setStatus('Token bilgileri zincirden okunuyor...')
      let mintA: MintRef
      let mintB: MintRef
      try {
        mintA = await getMintInfo(connection, mintAAddr.trim())
      } catch {
        throw new Error('A token mint adresi geçersiz ya da bulunamadı.')
      }
      try {
        mintB = await getMintInfo(connection, mintBAddr.trim())
      } catch {
        throw new Error('B token mint adresi geçersiz ya da bulunamadı.')
      }

      const raydium = await loadRaydium(connection, wallet, network)
      const res = await createCpmmPool(raydium, network, mintA, mintB, amountA, amountB, setStatus)
      setResult(res)
      setStatus('')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Havuz oluşturulurken bir hata oluştu.')
      setStatus('')
    } finally {
      setLoading(false)
    }
  }

  if (result) {
    const cluster = NETWORKS[network].explorerCluster
    return (
      <div className="result-card">
        <div className="result-card__icon">✅</div>
        <h2>Havuz Oluşturuldu!</h2>
        <p>Likidite havuzunuz zincir üzerinde oluşturuldu ve belirttiğiniz miktarlar yatırıldı.</p>
        <div className="result-card__row">
          <span>Havuz ID</span>
          <code>{result.poolId}</code>
        </div>
        <div className="result-card__row">
          <span>İşlem İmzası</span>
          <code>{result.txId}</code>
        </div>
        <div className="result-card__links">
          <a
            className="btn btn--secondary"
            href={`https://explorer.solana.com/address/${result.poolId}${cluster}`}
            target="_blank"
            rel="noreferrer"
          >
            Explorer'da Görüntüle
          </a>
        </div>

        <button
          className="btn btn--primary"
          onClick={() => {
            setResult(null)
            setMintAAddr('')
            setMintBAddr('')
            setAmountA('')
            setAmountB('')
          }}
        >
          Yeni Havuz Oluştur
        </button>
      </div>
    )
  }

  return (
    <form className="token-form" onSubmit={handleCreate}>
      <h2>Yeni Likidite Havuzu Oluştur</h2>
      <p className="subtab-desc">
        İki token için sabit-çarpım (CPMM) havuzu oluşturur. Girdiğiniz miktarlar havuzun
        başlangıç fiyatını belirler ve cüzdanınızdan bu havuza yatırılır.
      </p>

      <div className="alert alert--warning">
        ⚠️ Bu işlem geri alınamaz ve gerçek token/SOL yatırmanızı gerektirir. Önce{' '}
        <strong>Devnet</strong>'te (test ağı) deneyin. Yanlış miktar girmek, havuzun başlangıç
        fiyatını yanlış ayarlayabilir.
      </div>

      <div className="token-pair-picker">
        <div className="field">
          <span>Havuz Oluşturmak İstediğiniz Token'i Seçin *</span>
          {mintAAddr ? (
            <div className="selected-coin" style={{ marginTop: 4 }}>
              <TokenIcon image={mintAMeta?.image} symbol={mintAMeta?.symbol} size={28} />
              <div className="selected-coin__info">
                <span className="selected-coin__symbol">{mintAMeta ? mintAMeta.symbol : 'Seçili'}</span>
                {mintAAddr !== NATIVE_SOL_MINT && <code className="selected-coin__addr">{mintAAddr}</code>}
              </div>
              <button type="button" className="btn btn--secondary" onClick={() => setMintAAddr('')}>
                Değiştir
              </button>
            </div>
          ) : (
            <CoinPicker allowSol explorerCluster={NETWORKS[network].explorerCluster} onSelect={setMintAAddr} />
          )}
        </div>

        <div className="token-pair-picker__plus">+</div>

        <div className="field">
          <span>Likidite Coin'ini Seçin (ör. SOL) *</span>
          {mintBAddr ? (
            <div className="selected-coin" style={{ marginTop: 4 }}>
              <TokenIcon image={mintBMeta?.image} symbol={mintBMeta?.symbol} size={28} />
              <div className="selected-coin__info">
                <span className="selected-coin__symbol">{mintBMeta ? mintBMeta.symbol : 'Seçili'}</span>
                {mintBAddr !== NATIVE_SOL_MINT && <code className="selected-coin__addr">{mintBAddr}</code>}
              </div>
              <button type="button" className="btn btn--secondary" onClick={() => setMintBAddr('')}>
                Değiştir
              </button>
            </div>
          ) : (
            <CoinPicker allowSol explorerCluster={NETWORKS[network].explorerCluster} onSelect={setMintBAddr} />
          )}
        </div>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>Havuza Yatırılacak Token Miktarı *</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="ör. 1000000"
            value={amountA}
            onChange={(e) => setAmountA(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </label>
        <label className="field">
          <span>Likidite Coin Miktarı *</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="ör. 10"
            value={amountB}
            onChange={(e) => setAmountB(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </label>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {status && !error && <div className="alert alert--info">{status}</div>}

      <button type="submit" className="btn btn--primary btn--block" disabled={loading}>
        {loading ? 'Oluşturuluyor...' : wallet.connected ? 'Havuz Oluştur' : 'Önce Cüzdan Bağlayın'}
      </button>
    </form>
  )
}

function PoolManage({
  network,
  connection,
  wallet,
}: {
  network: NetworkId
  connection: ReturnType<typeof useConnection>['connection']
  wallet: ReturnType<typeof useWallet>
}) {
  const [poolId, setPoolId] = useState('')
  const [poolInfo, setPoolInfo] = useState<ApiV3PoolInfoStandardItemCpmm | null>(null)
  const [poolKeys, setPoolKeys] = useState<CpmmKeys | undefined>(undefined)
  const [loadingPool, setLoadingPool] = useState(false)
  const [addAmount, setAddAmount] = useState('')
  const [withdrawPercent, setWithdrawPercent] = useState(0)
  const [lpBalance, setLpBalance] = useState(0)
  const [tokenABalance, setTokenABalance] = useState(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [txResult, setTxResult] = useState('')

  async function refreshBalances(pool: ApiV3PoolInfoStandardItemCpmm) {
    if (!wallet.publicKey) return
    const [lp, tokenA] = await Promise.all([
      getWalletTokenBalance(connection, wallet.publicKey, pool.lpMint.address, pool.lpMint.programId),
      getWalletTokenBalance(connection, wallet.publicKey, pool.mintA.address, pool.mintA.programId),
    ])
    setLpBalance(lp)
    setTokenABalance(tokenA)
  }

  async function handleLoadPool(e: FormEvent) {
    e.preventDefault()
    setError('')
    setTxResult('')
    setPoolInfo(null)
    setWithdrawPercent(0)
    if (!poolId.trim()) {
      setError('Havuz ID girin.')
      return
    }
    setLoadingPool(true)
    try {
      const raydium = await loadRaydium(connection, wallet, network)
      const { poolInfo, poolKeys } = await getPoolById(raydium, poolId.trim(), network)
      setPoolInfo(poolInfo)
      setPoolKeys(poolKeys)
      await refreshBalances(poolInfo)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Havuz bulunamadı.')
    } finally {
      setLoadingPool(false)
    }
  }

  async function handleAdd() {
    if (!poolInfo) return
    setError('')
    setTxResult('')
    if (!wallet.connected) {
      setError('Devam etmek için önce cüzdanınızı bağlayın.')
      return
    }
    if (!addAmount || Number(addAmount) <= 0) {
      setError('Geçerli bir miktar girin.')
      return
    }
    setBusy(true)
    try {
      const raydium = await loadRaydium(connection, wallet, network)
      const txId = await addCpmmLiquidity(raydium, poolInfo, poolKeys, addAmount, true, setStatus)
      setTxResult(txId)
      setStatus('')
      setAddAmount('')
      await refreshBalances(poolInfo)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Likidite eklenirken bir hata oluştu.')
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const withdrawLpAmount = (lpBalance * withdrawPercent) / 100
  const withdrawEstimatedA = poolInfo?.lpAmount
    ? (withdrawLpAmount / poolInfo.lpAmount) * poolInfo.mintAmountA
    : 0
  const withdrawEstimatedB = poolInfo?.lpAmount
    ? (withdrawLpAmount / poolInfo.lpAmount) * poolInfo.mintAmountB
    : 0

  async function handleWithdraw() {
    if (!poolInfo) return
    setError('')
    setTxResult('')
    if (!wallet.connected) {
      setError('Devam etmek için önce cüzdanınızı bağlayın.')
      return
    }
    if (withdrawLpAmount <= 0) {
      setError('Çekmek için yüzde belirleyin (bakiyeniz 0 olabilir).')
      return
    }
    setBusy(true)
    try {
      const raydium = await loadRaydium(connection, wallet, network)
      const txId = await withdrawCpmmLiquidity(
        raydium,
        poolInfo,
        poolKeys,
        withdrawLpAmount.toString(),
        setStatus,
      )
      setTxResult(txId)
      setStatus('')
      setWithdrawPercent(0)
      await refreshBalances(poolInfo)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Likidite çekilirken bir hata oluştu.')
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="token-form">
      <h2>Likidite Ekle / Çıkar</h2>
      <p className="subtab-desc">
        Bildiğiniz bir havuz ID'sine likidite ekleyin ya da LP token'ınızı geri çekin.
      </p>

      <form onSubmit={handleLoadPool}>
        <label className="field">
          <span>Havuz ID *</span>
          <input
            type="text"
            placeholder="ör. havuz oluşturunca aldığınız Pool ID"
            value={poolId}
            onChange={(e) => setPoolId(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--secondary" disabled={loadingPool}>
          {loadingPool ? 'Getiriliyor...' : 'Havuzu Getir'}
        </button>
      </form>

      {error && <div className="alert alert--error" style={{ marginTop: 16 }}>{error}</div>}

      {poolInfo && (
        <div className="pool-card" style={{ marginTop: 20 }}>
          <div className="pool-card__header">
            <strong>
              {poolInfo.mintA.symbol || '?'} / {poolInfo.mintB.symbol || '?'}
            </strong>
          </div>
          <div className="pool-card__row">
            <span>Fiyat</span>
            <span>
              {fmtNum(poolInfo.price)} {poolInfo.mintB.symbol}
            </span>
          </div>
          <div className="pool-card__row">
            <span>Rezervler</span>
            <span>
              {fmtNum(poolInfo.mintAmountA, 4)} {poolInfo.mintA.symbol} /{' '}
              {fmtNum(poolInfo.mintAmountB, 4)} {poolInfo.mintB.symbol}
            </span>
          </div>
          {poolValueInSol(poolInfo) !== null && <PoolValueRow sol={poolValueInSol(poolInfo)!} />}

          <hr className="pool-manage__divider" />

          <div className="pool-manage__section">
            <div className="pool-manage__section-title">Likidite Ekle</div>
            <label className="field">
              <span>
                Eklenecek {poolInfo.mintA.symbol} Miktarı
                <small className="pool-manage__balance-hint">
                  {' '}
                  (bakiyeniz: {fmtNum(tokenABalance, 6)} {poolInfo.mintA.symbol})
                </small>
              </span>
              <div className="pool-manage__amount-row">
                <input
                  type="text"
                  inputMode="decimal"
                  value={addAmount}
                  onChange={(e) => setAddAmount(e.target.value.replace(/[^\d.]/g, ''))}
                />
                <button
                  type="button"
                  className="btn btn--secondary pool-manage__max-btn"
                  onClick={() => setAddAmount(String(tokenABalance))}
                  disabled={tokenABalance <= 0}
                >
                  MAX
                </button>
              </div>
            </label>
            {addAmount && Number(addAmount) > 0 && (
              <small className="pool-manage__preview">
                ≈ {fmtNum(Number(addAmount) * poolInfo.price)} {poolInfo.mintB.symbol} eşleşecek
                (kesin miktar işlem sırasında hesaplanır)
              </small>
            )}
            <button
              type="button"
              className="btn btn--primary pool-manage__action-btn"
              onClick={handleAdd}
              disabled={busy}
            >
              {busy ? 'İşleniyor...' : 'Likidite Ekle'}
            </button>
          </div>

          <hr className="pool-manage__divider" />

          <div className="pool-manage__section">
            <div className="pool-manage__section-title">
              Likidite Çek
              <small className="pool-manage__balance-hint">
                {' '}
                (LP bakiyeniz: {fmtNum(lpBalance, 6)})
              </small>
            </div>

            <div className="pool-manage__percent-display">%{withdrawPercent}</div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={withdrawPercent}
              onChange={(e) => setWithdrawPercent(Number(e.target.value))}
              className="pool-manage__slider"
              disabled={lpBalance <= 0}
            />
            <div className="pool-manage__percent-buttons">
              {[25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  className="btn btn--secondary pool-manage__percent-btn"
                  onClick={() => setWithdrawPercent(pct)}
                  disabled={lpBalance <= 0}
                >
                  %{pct}
                </button>
              ))}
            </div>

            {withdrawPercent > 0 && (
              <small className="pool-manage__preview">
                Çekilecek: {fmtNum(withdrawLpAmount, 6)} LP ≈ {fmtNum(withdrawEstimatedA, 4)}{' '}
                {poolInfo.mintA.symbol} + {fmtNum(withdrawEstimatedB, 4)} {poolInfo.mintB.symbol}
              </small>
            )}

            <button
              type="button"
              className="btn btn--secondary pool-manage__action-btn"
              onClick={handleWithdraw}
              disabled={busy || lpBalance <= 0}
            >
              {busy ? 'İşleniyor...' : 'Likidite Çek'}
            </button>
          </div>

          {status && <div className="alert alert--info">{status}</div>}
          {txResult && (
            <div className="alert alert--info">
              İşlem başarılı: <code>{txResult}</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PoolLock({
  network,
  connection,
  wallet,
}: {
  network: NetworkId
  connection: ReturnType<typeof useConnection>['connection']
  wallet: ReturnType<typeof useWallet>
}) {
  const [poolId, setPoolId] = useState('')
  const [poolInfo, setPoolInfo] = useState<ApiV3PoolInfoStandardItemCpmm | null>(null)
  const [loadingPool, setLoadingPool] = useState(false)
  const [lpBalance, setLpBalance] = useState(0)
  const [lockAmount, setLockAmount] = useState('')
  const [durationSeconds, setDurationSeconds] = useState(LOCK_DURATION_OPTIONS[2].seconds)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [lockResult, setLockResult] = useState<LockResult | null>(null)

  async function handleLoadPool(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLockResult(null)
    setPoolInfo(null)
    if (!poolId.trim()) {
      setError('Havuz ID girin.')
      return
    }
    setLoadingPool(true)
    try {
      const raydium = await loadRaydium(connection, wallet, network)
      const { poolInfo } = await getPoolById(raydium, poolId.trim(), network)
      setPoolInfo(poolInfo)
      if (wallet.publicKey) {
        const lp = await getWalletTokenBalance(
          connection,
          wallet.publicKey,
          poolInfo.lpMint.address,
          poolInfo.lpMint.programId,
        )
        setLpBalance(lp)
        setLockAmount(String(lp))
      }
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Havuz bulunamadı.')
    } finally {
      setLoadingPool(false)
    }
  }

  async function handleLock() {
    if (!poolInfo) return
    setError('')
    setLockResult(null)
    if (!wallet.connected || !wallet.publicKey) {
      setError('Devam etmek için önce cüzdanınızı bağlayın.')
      return
    }
    if (!lockAmount || Number(lockAmount) <= 0) {
      setError('Kilitlenecek geçerli bir LP miktarı girin.')
      return
    }
    if (Number(lockAmount) > lpBalance) {
      setError('Kilitlemek istediğiniz miktar LP bakiyenizden fazla.')
      return
    }
    setBusy(true)
    try {
      const result = await lockLpTokens(
        connection,
        network,
        wallet,
        poolInfo.lpMint.address,
        poolInfo.lpMint.decimals,
        poolInfo.lpMint.programId,
        lockAmount,
        durationSeconds,
        setStatus,
      )
      setLockResult(result)
      setStatus('')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Likidite kilitlenirken bir hata oluştu.')
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const cluster = NETWORKS[network].explorerCluster

  return (
    <div className="token-form">
      <h2>Likidite Kilitle</h2>
      <p className="subtab-desc">
        LP token'ınızı, belirlediğiniz süre boyunca kimsenin (siz dahil) çekemeyeceği şekilde
        kilitleyin — alıcılara likiditeyi aniden çekmeyeceğinizi zincir üzerinde ispatlamanın bir
        yolu. Bu, <strong>Streamflow</strong>'un Devnet ve Mainnet'te halihazırda çalışan, yaygın
        kullanılan kilit/vesting programı üzerinden yapılır; bu sitenin kendi yazıp deploy ettiği
        bir program değildir.
      </p>

      <div className="alert alert--warning">
        ⚠️ Bu kilit yalnızca <strong>likiditenin çekilmesini</strong> engeller —{' '}
        <strong>alım/satım işlemlerini engellemez</strong>, havuzda normal şekilde alım-satım
        devam eder. Süre dolmadan siz dahil hiç kimse kilidi erken açamaz veya iptal edemez; bu,
        kilidin güven değerinin kaynağıdır — geri dönüşü yoktur.
      </div>

      <form onSubmit={handleLoadPool}>
        <label className="field">
          <span>Havuz ID *</span>
          <input
            type="text"
            placeholder="ör. havuz oluşturunca aldığınız Pool ID"
            value={poolId}
            onChange={(e) => setPoolId(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--secondary" disabled={loadingPool}>
          {loadingPool ? 'Getiriliyor...' : 'Havuzu Getir'}
        </button>
      </form>

      {error && (
        <div className="alert alert--error" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}

      {poolInfo && !lockResult && (
        <div className="pool-card" style={{ marginTop: 20 }}>
          <div className="pool-card__header">
            <strong>
              {poolInfo.mintA.symbol || '?'} / {poolInfo.mintB.symbol || '?'}
            </strong>
          </div>
          {poolValueInSol(poolInfo) !== null && <PoolValueRow sol={poolValueInSol(poolInfo)!} />}
          <div className="pool-card__row">
            <span>LP Bakiyeniz</span>
            <span>{fmtNum(lpBalance, 6)}</span>
          </div>

          <hr className="pool-manage__divider" />

          <label className="field">
            <span>Kilitlenecek LP Miktarı</span>
            <div className="pool-manage__amount-row">
              <input
                type="text"
                inputMode="decimal"
                value={lockAmount}
                onChange={(e) => setLockAmount(e.target.value.replace(/[^\d.]/g, ''))}
              />
              <button
                type="button"
                className="btn btn--secondary pool-manage__max-btn"
                onClick={() => setLockAmount(String(lpBalance))}
                disabled={lpBalance <= 0}
              >
                MAX
              </button>
            </div>
          </label>

          <div className="field">
            <span>Kilit Süresi</span>
            <div className="pool-manage__percent-buttons">
              {LOCK_DURATION_OPTIONS.map((opt) => (
                <button
                  key={opt.seconds}
                  type="button"
                  className={`btn pool-manage__percent-btn ${
                    durationSeconds === opt.seconds ? 'btn--primary' : 'btn--secondary'
                  }`}
                  onClick={() => setDurationSeconds(opt.seconds)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <small className="pool-manage__preview">
            {fmtNum(Number(lockAmount) || 0, 6)} LP, yaklaşık{' '}
            {new Date(Date.now() + durationSeconds * 1000).toLocaleString('tr-TR')} tarihine kadar
            kilitlenecek.
          </small>

          {status && <div className="alert alert--info">{status}</div>}

          <button
            type="button"
            className="btn btn--primary pool-manage__action-btn"
            onClick={handleLock}
            disabled={busy || lpBalance <= 0}
          >
            {busy ? 'İşleniyor...' : 'Likiditeyi Kilitle'}
          </button>
        </div>
      )}

      {lockResult && (
        <div className="result-card" style={{ marginTop: 20 }}>
          <div className="result-card__icon">🔒</div>
          <h2>Likidite Kilitlendi!</h2>
          <p>
            {fmtNum(Number(lockAmount), 6)} LP, {lockResult.unlockDate.toLocaleString('tr-TR')}{' '}
            tarihine kadar kilitli. Bu tarihten önce (siz dahil) kimse çekemez.
          </p>
          <div className="result-card__row">
            <span>Kilit (Kontrat) ID</span>
            <code>{lockResult.contractId}</code>
          </div>
          <div className="result-card__row">
            <span>İşlem İmzası</span>
            <code>{lockResult.txId}</code>
          </div>
          <div className="result-card__row">
            <span>Açılış Tarihi</span>
            <code>{lockResult.unlockDate.toLocaleString('tr-TR')}</code>
          </div>
          <div className="result-card__links">
            <a
              className="btn btn--secondary"
              href={`https://explorer.solana.com/tx/${lockResult.txId}${cluster}`}
              target="_blank"
              rel="noreferrer"
            >
              Explorer'da Görüntüle
            </a>
          </div>
          <p className="subtab-desc">
            Bu bilgiyi (Kilit ID + açılış tarihi) token açıklamanıza veya duyurunuza ekleyerek,
            alıcıların likiditenin kilitli olduğunu Solana Explorer üzerinden bağımsız şekilde
            doğrulayabilmesini sağlayabilirsiniz.
          </p>
        </div>
      )}
    </div>
  )
}
