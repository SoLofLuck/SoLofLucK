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
import { burnTokens, type BurnResult } from '../lib/burnToken'
import { listAllWalletTokens, type WalletTokenBalance } from '../lib/walletTokens'
import { getTokenMetadata, type TokenMeta } from '../lib/tokenMetadata'
import { useSolUsdPrice } from '../lib/solPrice'
import { CoinPicker } from './CoinPicker'
import { TokenIcon, SOL_ICON } from './TokenIcon'
import { NETWORKS, type NetworkId } from '../config'

interface Props {
  network: NetworkId
}

type SubTab = 'create' | 'manage' | 'lock' | 'burn' | 'search'

function fmtNum(n: number, digits = 6): string {
  if (!Number.isFinite(n)) return '-'
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '-'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}

/** An "X SOL (~$Y)" row — shows only the SOL part if the SOL/USD price has not arrived yet. */
function PoolValueRow({ sol }: { sol: number }) {
  const solUsd = useSolUsdPrice()
  return (
    <div className="pool-card__row">
      <span>Pool Value</span>
      <span>
        {fmtNum(sol, 4)} SOL{solUsd !== null && <span className="pool-card__usd"> (~{fmtUsd(sol * solUsd)})</span>}
      </span>
    </div>
  )
}

/**
 * Computes the pool's total value in SOL — only possible when one side of the
 * pool is SOL (in a constant-product pool the two sides are always equal in
 * value, so twice the SOL side gives the total). If the pool contains no SOL
 * (e.g. a pairing of two different tokens), the SOL equivalent cannot be
 * computed without price data.
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
  // The tab order follows the natural order of what a user does with a pool:
  // create the pool first, then add or remove liquidity, then lock it. The
  // read-only "Find Pool" moved to the end — it is a lookup tool rather than an
  // operation, so it should not be the first tab that greets the page.
  const [subTab, setSubTab] = useState<SubTab>('create')

  return (
    <div className="liquidity-page">
      <div className="subtabs">
        <button
          type="button"
          className={`subtab ${subTab === 'create' ? 'subtab--active' : ''}`}
          onClick={() => setSubTab('create')}
        >
          Create Pool
        </button>
        <button
          type="button"
          className={`subtab ${subTab === 'manage' ? 'subtab--active' : ''}`}
          onClick={() => setSubTab('manage')}
        >
          Add / Remove Liquidity
        </button>
        <button
          type="button"
          className={`subtab ${subTab === 'lock' ? 'subtab--active' : ''}`}
          onClick={() => setSubTab('lock')}
        >
          Lock Liquidity
        </button>
        <button
          type="button"
          className={`subtab ${subTab === 'burn' ? 'subtab--active' : ''}`}
          onClick={() => setSubTab('burn')}
        >
          Burn Liquidity
        </button>
        <button
          type="button"
          className={`subtab ${subTab === 'search' ? 'subtab--active' : ''}`}
          onClick={() => setSubTab('search')}
        >
          Find Pool
        </button>
      </div>

      {subTab === 'create' && <PoolCreate network={network} connection={connection} wallet={wallet} />}
      {subTab === 'manage' && <PoolManage network={network} connection={connection} wallet={wallet} />}
      {subTab === 'lock' && <PoolLock network={network} connection={connection} wallet={wallet} />}
      {subTab === 'burn' && <TokenBurn network={network} connection={connection} wallet={wallet} />}
      {subTab === 'search' && <PoolSearch network={network} />}
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
        'Pool search runs through Raydium\'s public indexing service and covers Mainnet data only. To search for pools on Devnet, switch to Mainnet from the network selector.',
      )
      return
    }
    if (!mint1.trim()) {
      setError('Enter at least one token mint address.')
      return
    }

    setLoading(true)
    try {
      const raydium = await loadRaydium(connection, wallet, network)
      const results = await searchPoolsByMint(raydium, mint1.trim(), mint2.trim() || undefined)
      setPools(results)
      if (results.length === 0) setError('No pool was found for this token (or these tokens).')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Something went wrong while searching for pools.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="token-form">
      <h2>Find / Inspect A Pool</h2>
      <p className="subtab-desc">
        View a token's existing Raydium pools, its price and its liquidity. This section is
        read-only — it performs no transaction and you do not need to connect a wallet.
      </p>

      <form onSubmit={handleSearch}>
        <div className="form-grid">
          <label className="field">
            <span>Token Mint Address *</span>
            <input
              type="text"
              placeholder="e.g. your token's mint address"
              value={mint1}
              onChange={(e) => setMint1(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Second Token To Pair (optional)</span>
            <input
              type="text"
              placeholder="leave empty for all pools"
              value={mint2}
              onChange={(e) => setMint2(e.target.value)}
            />
          </label>
        </div>
        <button type="button" className="btn btn--secondary" style={{ marginBottom: 16 }} onClick={() => setMint2(NATIVE_SOL_MINT)}>
          Use SOL as the second token
        </button>
        {error && <div className="alert alert--error">{error}</div>}
        <button type="submit" className="btn btn--primary btn--block" disabled={loading}>
          {loading ? 'Searching...' : 'Search'}
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
                <span>Total Liquidity (TVL)</span>
                <span>${fmtNum(p.tvl, 2)}</span>
              </div>
              <div className="pool-card__row">
                <span>Reserves</span>
                <span>
                  {fmtNum(p.mintAmountA, 4)} {p.mintA.symbol} / {fmtNum(p.mintAmountB, 4)}{' '}
                  {p.mintB.symbol}
                </span>
              </div>
              {poolValueInSol(p) !== null && <PoolValueRow sol={poolValueInSol(p)!} />}
              <div className="pool-card__row">
                <span>Trading Fee</span>
                <span>%{fmtNum(p.feeRatePct, 3)}</span>
              </div>
              <div className="pool-card__row">
                <span>Pool ID</span>
                <code className="pool-card__id">{p.id}</code>
              </div>
              <a
                className="btn btn--secondary"
                href={`https://raydium.io/liquidity-pools/?token=${p.mintA.address}`}
                target="_blank"
                rel="noreferrer"
              >
                View on Raydium
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
      setError('Connect your wallet first to continue.')
      return
    }
    if (!mintAAddr.trim() || !mintBAddr.trim()) {
      setError('Enter both token mint addresses.')
      return
    }
    const amtA = Number(amountA)
    const amtB = Number(amountB)
    if (!amountA || !amountB || amtA <= 0 || amtB <= 0) {
      setError('Enter an initial amount greater than zero for both tokens.')
      return
    }

    setLoading(true)
    try {
      setStatus('Reading the token details from the chain...')
      let mintA: MintRef
      let mintB: MintRef
      try {
        mintA = await getMintInfo(connection, mintAAddr.trim())
      } catch {
        throw new Error('The token A mint address is invalid or was not found.')
      }
      try {
        mintB = await getMintInfo(connection, mintBAddr.trim())
      } catch {
        throw new Error('The token B mint address is invalid or was not found.')
      }

      const raydium = await loadRaydium(connection, wallet, network)
      const res = await createCpmmPool(raydium, network, mintA, mintB, amountA, amountB, setStatus)
      setResult(res)
      setStatus('')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Something went wrong while creating the pool.')
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
        <h2>Pool Created!</h2>
        <p>Your liquidity pool was created on chain and the amounts you entered were deposited.</p>
        <div className="result-card__row">
          <span>Pool ID</span>
          <code>{result.poolId}</code>
        </div>
        <div className="result-card__row">
          <span>Transaction Signature</span>
          <code>{result.txId}</code>
        </div>
        <div className="result-card__links">
          <a
            className="btn btn--secondary"
            href={`https://explorer.solana.com/address/${result.poolId}${cluster}`}
            target="_blank"
            rel="noreferrer"
          >
            View on Explorer
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
          Create Another Pool
        </button>
      </div>
    )
  }

  return (
    <form className="token-form" onSubmit={handleCreate}>
      <h2>Create A New Liquidity Pool</h2>
      <p className="subtab-desc">
        Creates a constant-product (CPMM) pool for two tokens. The amounts you enter set the
        pool's opening price and are deposited into it from your wallet.
      </p>

      <div className="alert alert--warning">
        ⚠️ This operation is irreversible and requires depositing real tokens and SOL. Entering
        the wrong amount can set the pool's opening price incorrectly.
      </div>

      <div className="token-pair-picker">
        <div className="field">
          <span>Select The Token You Want A Pool For *</span>
          {mintAAddr ? (
            <div className="selected-coin" style={{ marginTop: 4 }}>
              <TokenIcon image={mintAMeta?.image} symbol={mintAMeta?.symbol} size={28} />
              <div className="selected-coin__info">
                <span className="selected-coin__symbol">{mintAMeta ? mintAMeta.symbol : 'Selected'}</span>
                {mintAAddr !== NATIVE_SOL_MINT && <code className="selected-coin__addr">{mintAAddr}</code>}
              </div>
              <button type="button" className="btn btn--secondary" onClick={() => setMintAAddr('')}>
                Change
              </button>
            </div>
          ) : (
            <CoinPicker allowSol explorerCluster={NETWORKS[network].explorerCluster} onSelect={setMintAAddr} />
          )}
        </div>

        <div className="token-pair-picker__plus">+</div>

        <div className="field">
          <span>Select The Liquidity Coin (e.g. SOL) *</span>
          {mintBAddr ? (
            <div className="selected-coin" style={{ marginTop: 4 }}>
              <TokenIcon image={mintBMeta?.image} symbol={mintBMeta?.symbol} size={28} />
              <div className="selected-coin__info">
                <span className="selected-coin__symbol">{mintBMeta ? mintBMeta.symbol : 'Selected'}</span>
                {mintBAddr !== NATIVE_SOL_MINT && <code className="selected-coin__addr">{mintBAddr}</code>}
              </div>
              <button type="button" className="btn btn--secondary" onClick={() => setMintBAddr('')}>
                Change
              </button>
            </div>
          ) : (
            <CoinPicker allowSol explorerCluster={NETWORKS[network].explorerCluster} onSelect={setMintBAddr} />
          )}
        </div>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>Token Amount To Deposit Into The Pool *</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="e.g. 1000000"
            value={amountA}
            onChange={(e) => setAmountA(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </label>
        <label className="field">
          <span>Liquidity Coin Amount *</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="e.g. 10"
            value={amountB}
            onChange={(e) => setAmountB(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </label>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {status && !error && <div className="alert alert--info">{status}</div>}

      <button type="submit" className="btn btn--primary btn--block" disabled={loading}>
        {loading ? 'Creating...' : wallet.connected ? 'Create Pool' : 'Connect A Wallet First'}
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
      setError('Enter a pool ID.')
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
      setError(err instanceof Error ? err.message : 'The pool was not found.')
    } finally {
      setLoadingPool(false)
    }
  }

  async function handleAdd() {
    if (!poolInfo) return
    setError('')
    setTxResult('')
    if (!wallet.connected) {
      setError('Connect your wallet first to continue.')
      return
    }
    if (!addAmount || Number(addAmount) <= 0) {
      setError('Enter a valid amount.')
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
      setError(err instanceof Error ? err.message : 'Something went wrong while adding liquidity.')
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
      setError('Connect your wallet first to continue.')
      return
    }
    if (withdrawLpAmount <= 0) {
      setError('Set a percentage to withdraw (your balance may be 0).')
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
      setError(err instanceof Error ? err.message : 'Something went wrong while removing liquidity.')
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="token-form">
      <h2>Add / Remove Liquidity</h2>
      <p className="subtab-desc">
        Add liquidity to a pool ID you know, or withdraw your LP tokens.
      </p>

      <form onSubmit={handleLoadPool}>
        <label className="field">
          <span>Pool ID *</span>
          <input
            type="text"
            placeholder="e.g. the Pool ID you got when creating the pool"
            value={poolId}
            onChange={(e) => setPoolId(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--secondary" disabled={loadingPool}>
          {loadingPool ? 'Fetching...' : 'Fetch Pool'}
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
            <span>Reserves</span>
            <span>
              {fmtNum(poolInfo.mintAmountA, 4)} {poolInfo.mintA.symbol} /{' '}
              {fmtNum(poolInfo.mintAmountB, 4)} {poolInfo.mintB.symbol}
            </span>
          </div>
          {poolValueInSol(poolInfo) !== null && <PoolValueRow sol={poolValueInSol(poolInfo)!} />}

          <hr className="pool-manage__divider" />

          <div className="pool-manage__section">
            <div className="pool-manage__section-title">Add Liquidity</div>
            <label className="field">
              <span>
                {poolInfo.mintA.symbol} Amount To Add
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
                ≈ {fmtNum(Number(addAmount) * poolInfo.price)} {poolInfo.mintB.symbol} will be paired
                (the exact amount is computed during the transaction)
              </small>
            )}
            <button
              type="button"
              className="btn btn--primary pool-manage__action-btn"
              onClick={handleAdd}
              disabled={busy}
            >
              {busy ? 'Processing...' : 'Add Liquidity'}
            </button>
          </div>

          <hr className="pool-manage__divider" />

          <div className="pool-manage__section">
            <div className="pool-manage__section-title">
              Remove Liquidity
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
                To withdraw: {fmtNum(withdrawLpAmount, 6)} LP ≈ {fmtNum(withdrawEstimatedA, 4)}{' '}
                {poolInfo.mintA.symbol} + {fmtNum(withdrawEstimatedB, 4)} {poolInfo.mintB.symbol}
              </small>
            )}

            <button
              type="button"
              className="btn btn--secondary pool-manage__action-btn"
              onClick={handleWithdraw}
              disabled={busy || lpBalance <= 0}
            >
              {busy ? 'Processing...' : 'Remove Liquidity'}
            </button>
          </div>

          {status && <div className="alert alert--info">{status}</div>}
          {txResult && (
            <div className="alert alert--info">
              Transaction succeeded: <code>{txResult}</code>
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
      setError('Enter a pool ID.')
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
      setError(err instanceof Error ? err.message : 'The pool was not found.')
    } finally {
      setLoadingPool(false)
    }
  }

  async function handleLock() {
    if (!poolInfo) return
    setError('')
    setLockResult(null)
    if (!wallet.connected || !wallet.publicKey) {
      setError('Connect your wallet first to continue.')
      return
    }
    if (!lockAmount || Number(lockAmount) <= 0) {
      setError('Enter a valid LP amount to lock.')
      return
    }
    if (Number(lockAmount) > lpBalance) {
      setError('The amount you want to lock exceeds your LP balance.')
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
      setError(err instanceof Error ? err.message : 'Something went wrong while locking the liquidity.')
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const cluster = NETWORKS[network].explorerCluster

  return (
    <div className="token-form">
      <h2>Lock Liquidity</h2>
      <p className="subtab-desc">
        Lock your LP tokens for a period you choose, so that nobody, you included, can withdraw
        them — a way of proving on chain to buyers that you will not pull the liquidity
        yolu.
      </p>

      <div className="alert alert--warning">
        ⚠️ This lock only prevents <strong>withdrawing the liquidity</strong> —{' '}
        <strong>it does not block trading</strong>; buying and selling continue normally in the
        pool. Nobody, you included, can open or cancel the lock early before it expires; that is
        where the lock's value as a trust signal comes from — there is no way back.
      </div>

      <form onSubmit={handleLoadPool}>
        <label className="field">
          <span>Pool ID *</span>
          <input
            type="text"
            placeholder="e.g. the Pool ID you got when creating the pool"
            value={poolId}
            onChange={(e) => setPoolId(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn--secondary" disabled={loadingPool}>
          {loadingPool ? 'Fetching...' : 'Fetch Pool'}
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
            <span>Your LP Balance</span>
            <span>{fmtNum(lpBalance, 6)}</span>
          </div>

          <hr className="pool-manage__divider" />

          <label className="field">
            <span>LP Amount To Lock</span>
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
            <span>Lock Duration</span>
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
            {fmtNum(Number(lockAmount) || 0, 6)} LP, until roughly{' '}
            {new Date(Date.now() + durationSeconds * 1000).toLocaleString('en-US')}
            kilitlenecek.
          </small>

          {status && <div className="alert alert--info">{status}</div>}

          <button
            type="button"
            className="btn btn--primary pool-manage__action-btn"
            onClick={handleLock}
            disabled={busy || lpBalance <= 0}
          >
            {busy ? 'Processing...' : 'Lock The Liquidity'}
          </button>
        </div>
      )}

      {lockResult && (
        <div className="result-card" style={{ marginTop: 20 }}>
          <div className="result-card__icon">🔒</div>
          <h2>Liquidity Locked!</h2>
          <p>
            {fmtNum(Number(lockAmount), 6)} LP, {lockResult.unlockDate.toLocaleString('en-US')}{' '}
            . Before that date nobody, you included, can withdraw it.
          </p>
          <div className="result-card__row">
            <span>Lock (Contract) ID</span>
            <code>{lockResult.contractId}</code>
          </div>
          <div className="result-card__row">
            <span>Transaction Signature</span>
            <code>{lockResult.txId}</code>
          </div>
          <div className="result-card__row">
            <span>Unlock Date</span>
            <code>{lockResult.unlockDate.toLocaleString('en-US')}</code>
          </div>
          <div className="result-card__links">
            <a
              className="btn btn--secondary"
              href={`https://explorer.solana.com/tx/${lockResult.txId}${cluster}`}
              target="_blank"
              rel="noreferrer"
            >
              View on Explorer
            </a>
          </div>
          <p className="subtab-desc">
            Add this information (the lock ID plus the unlock date) to your token description or
            announcement, so buyers can verify independently on Solana Explorer that the liquidity is
            locked.
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Burning liquidity
// ---------------------------------------------------------------------------
// One step beyond locking: a burned LP token never comes back, so the pool's
// liquidity is locked INDEFINITELY. Unlike a lock there is no end date — so no
// countdown forms that buyers wait on, thinking "it unlocks on that date".
//
// The tool is deliberately NOT LP-specific: any SPL/Token-2022 token in the
// wallet can be burned. The proportional burn of the $LUCK that will not be
// minted if the presale target is missed will also be done from here (see the
// presale rules in config.ts).
function TokenBurn({
  network,
  connection,
  wallet,
}: {
  network: NetworkId
  connection: ReturnType<typeof useConnection>['connection']
  wallet: ReturnType<typeof useWallet>
}) {
  const [tokens, setTokens] = useState<WalletTokenBalance[]>([])
  const [mint, setMint] = useState('')
  const [mintMeta, setMintMeta] = useState<TokenMeta | null>(null)
  const [amount, setAmount] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<BurnResult | null>(null)

  const owner = wallet.publicKey

  // The token is chosen with CoinPicker (the same component as the create-pool
  // tab); this list is kept only to show the selected token's BALANCE and to fill
  // in the "burn all of it" shortcut.
  useEffect(() => {
    if (!owner) {
      setTokens([])
      return
    }
    let cancelled = false
    listAllWalletTokens(connection, owner)
      .then((list) => !cancelled && setTokens(list))
      .catch(() => !cancelled && setTokens([]))
    return () => {
      cancelled = true
    }
  }, [connection, owner])

  // The selected token's name, symbol and logo — so we can reuse exactly the
  // "selected-coin" presentation from the create-pool tab.
  useEffect(() => {
    if (!mint) {
      setMintMeta(null)
      return
    }
    let cancelled = false
    try {
      getTokenMetadata(connection, new PublicKey(mint)).then((meta) => !cancelled && setMintMeta(meta))
    } catch {
      setMintMeta(null)
    }
    return () => {
      cancelled = true
    }
  }, [connection, mint])

  const selected = tokens.find((t) => t.mint === mint) ?? null
  const balance = selected ? selected.uiAmount : null
  // The confirmation box: the last barrier against burning by accident. A
  // "disabled" button is not enough — the user has to type it deliberately.
  const confirmed = confirmText.trim().toUpperCase() === 'BURN'
  const canBurn =
    wallet.connected && Boolean(mint) && Number(amount) > 0 && confirmed && !busy

  async function handleBurn() {
    setError('')
    setResult(null)
    if (!wallet.connected) {
      setError('Connect your wallet first to continue.')
      return
    }
    setBusy(true)
    try {
      const res = await burnTokens(connection, wallet, mint, amount.trim(), setStatus)
      setResult(res)
      setStatus('')
      setAmount('')
      setConfirmText('')
      // The balances changed — refresh the list.
      if (owner) {
        setTokens(await listAllWalletTokens(connection, owner))
      }
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Something went wrong during the burn.')
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const cluster = NETWORKS[network].explorerCluster

  if (result) {
    return (
      // The same card pattern as the create-pool result (result-card): label
      // above value, with long addresses breaking at the end of a line.
      // Classes that were not defined here were used at first, which made the
      // label and value run into each other and pushed the mint address off
      // the screen.
      <div className="result-card">
        <div className="result-card__icon">🔥</div>
        <h2>Burn Complete</h2>
        <p>
          <strong>{result.amount}</strong> tokens were burned permanently. The total supply dropped
          on chain — the value below was read directly from the mint account after the transaction.
        </p>
        <div className="result-card__row">
          <span>Amount burned</span>
          <code>{result.amount}</code>
        </div>
        <div className="result-card__row">
          <span>Remaining total supply</span>
          <code>{result.remainingSupply}</code>
        </div>
        <div className="result-card__row">
          <span>Mint</span>
          <code>{result.mint}</code>
        </div>
        <div className="result-card__links">
          <a
            className="btn btn--secondary"
            href={`https://explorer.solana.com/tx/${result.signature}${cluster}`}
            target="_blank"
            rel="noreferrer"
          >
            View the transaction on Explorer
          </a>
          <button type="button" className="btn btn--secondary" onClick={() => setResult(null)}>
            Burn Something Else
          </button>
        </div>
        <p className="subtab-desc">
          Share this transaction link with your community — it is the proof of your burn commitment.
        </p>
      </div>
    )
  }

  return (
    <div className="token-form">
      <h2>Burn Liquidity</h2>
      <p className="subtab-desc">
        Burn your LP tokens to lock the pool's liquidity <strong>indefinitely</strong>. A burned LP
        token never comes back, so nobody, you included, can ever withdraw the money in the pool.
      </p>

      <div className="alert alert--warning">
        ⚠️ <strong>This operation is irreversible.</strong> A burned token cannot be re-minted;
        unlike a lock there is no way to get it back after a period. Make sure you have chosen the
        correct mint and amount.
      </div>

      <p className="subtab-desc">
        <strong>Which token should I choose?</strong> The tokens INSIDE the pool are not burned —
        they belong to the pool now, nobody has authority over them, and burning them would break
        the pool's balance. What gets burned is the <strong>LP token</strong>: the "receipt" that
        arrives in your wallet when you open the pool. Only whoever holds that receipt can
        withdraw the money in the pool; once the receipt is burned there is nobody left to
        withdraw it. The tokens in the pool stay where they are and keep being traded.
      </p>
      <p className="subtab-desc">
        So for a pool: choose the <strong>LP token</strong> from the list (it appears in your
        wallet after you create the pool), not your own project's token. You can also burn your
        own unsold or unused tokens with the same tool — in that case select your own token
        directly.
      </p>
      <p className="subtab-desc">
        <strong>Lock or burn?</strong> A lock has an end date — as it approaches it turns into a
        countdown for buyers and creates selling pressure. A burn has no such date, but the
        liquidity stays in the pool permanently: you will not be able to withdraw your share of
        the pool later either.
      </p>

      {!wallet.connected && (
        <div className="alert alert--info">Connect your wallet first to burn anything.</div>
      )}

      <div className="field">
        <span>Token To Burn *</span>
        {mint ? (
          <div className="selected-coin" style={{ marginTop: 4 }}>
            <TokenIcon image={mintMeta?.image} symbol={mintMeta?.symbol} size={28} />
            <div className="selected-coin__info">
              <span className="selected-coin__symbol">{mintMeta ? mintMeta.symbol : 'Selected'}</span>
              <code className="selected-coin__addr">{mint}</code>
            </div>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                setMint('')
                setAmount('')
                setConfirmText('')
                setError('')
              }}
              disabled={busy}
            >
              Change
            </button>
          </div>
        ) : (
          // SOL cannot be burned (it is native and has no mint account) — which is
          // why, unlike the create-pool tab, allowSol is not passed here.
          <CoinPicker
            explorerCluster={NETWORKS[network].explorerCluster}
            onSelect={(m) => {
              setMint(m)
              setAmount('')
              setConfirmText('')
              setError('')
            }}
          />
        )}
      </div>

      <label className="field">
        <span>Amount To Burn *</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="e.g. 1250.5"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy || !mint}
        />
        {balance !== null && (
          <small>
            Your balance: {balance}{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => setAmount(balance)}
              disabled={busy}
            >
              burn all of it
            </button>
          </small>
        )}
      </label>

      <label className="field">
        <span>
          Confirmation — type <strong>BURN</strong> in the box *
        </span>
        <input
          type="text"
          placeholder="BURN"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          disabled={busy || !mint}
        />
      </label>

      <button
        type="button"
        className="btn btn--primary btn--block"
        onClick={handleBurn}
        disabled={!canBurn}
      >
        {busy
          ? 'Burning...'
          : wallet.connected
            ? '🔥 Burn The Tokens Permanently'
            : 'Connect A Wallet First'}
      </button>

      {error && <div className="alert alert--error">{error}</div>}
      {!error && status && <div className="alert alert--info">{status}</div>}
    </div>
  )
}
