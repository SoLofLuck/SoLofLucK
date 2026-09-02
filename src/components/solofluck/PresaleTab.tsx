import { useEffect, useState, type FormEvent } from 'react'
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  NETWORKS,
  PRESALE_DURATION_WEEKS,
  PRESALE_SOFT_CAP_SOL,
  PRESALE_TARGET_SOL,
  PRESALE_TICKET_UNIT_SOL,
  RAFFLE,
  PRESALE_TIERS,
  PRESALE_TOKENS_PER_SOL,
  PRESALE_WALLET,
  type NetworkId,
} from '../../config'
import {
  calcTickets,
  computePresaleProgress,
  formatRemaining,
  getLocalContributions,
  presaleEndsAt,
  presalePhaseAt,
  sendPresaleContribution,
  tokensForSol,
  presaleClosedReason,
} from '../../lib/presale'
import { useSolUsdPrice } from '../../lib/solPrice'

function formatUsd(sol: number, solUsd: number | null): string {
  if (!solUsd || !Number.isFinite(sol) || sol <= 0) return ''
  return `≈ $${(sol * solUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/** SOL amount as readable text — used in the remaining-quota warnings. */
function fmtSol(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 3 })
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

/**
 * Live progress read from the presale wallet's balance. Contributions are plain
 * SOL transfers, so no separate indexer is needed — the wallet's balance IS the
 * amount raised. The operations share never enters this wallet, so the gross
 * amount is derived back inside computePresaleProgress.
 */
function usePresaleProgress(connection: { getBalance: (k: PublicKey) => Promise<number> }) {
  const [poolSol, setPoolSol] = useState<number | null>(null)

  useEffect(() => {
    if (!PRESALE_WALLET) return
    let cancelled = false
    let key: PublicKey
    try {
      key = new PublicKey(PRESALE_WALLET)
    } catch {
      return
    }
    const read = async () => {
      try {
        const lamports = await connection.getBalance(key)
        if (!cancelled) setPoolSol(lamports / LAMPORTS_PER_SOL)
      } catch {
        // If the RPC is temporarily unreachable, keep the previous value —
        // zeroing the bar would falsely suggest the raised money vanished.
      }
    }
    read()
    const id = setInterval(read, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [connection])

  return poolSol
}

/** A "now" that refreshes once a minute — keeps the countdown live. */
function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

interface Props {
  network: NetworkId
}

export function PresaleTab({ network }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const cluster = NETWORKS[network].explorerCluster
  const solUsd = useSolUsdPrice()

  const [flexAmount, setFlexAmount] = useState('')
  const [selectedTier, setSelectedTier] = useState<number | null>(null)

  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState<'flex' | 'fixed' | null>(null)
  const [lastSignature, setLastSignature] = useState('')

  // getLocalContributions performs a small localStorage read, so there is no
  // need to memoize it per render; after a new contribution the
  // setLastSignature call already triggers a re-render.
  const history = getLocalContributions(network)

  const configured = Boolean(PRESALE_WALLET)
  const totalTickets = history.reduce((sum, h) => sum + h.tickets, 0)

  const poolSol = usePresaleProgress(connection)
  const now = useNow()
  const progress = computePresaleProgress(poolSol ?? 0)
  const phase = presalePhaseAt(now)
  const endsAt = presaleEndsAt()
  // A contribution is only accepted while the presale is genuinely open. The
  // decision lives in a pure function (presaleClosedReason) that has its own
  // test — this is the site's only money gate, so the logic must not sit
  // untestable inside the component.
  const closedReason = presaleClosedReason({
    configured,
    targetReached: progress.targetReached,
    phase,
  })
  const canContribute = wallet.connected && closedReason === null

  // REMAINING QUOTA. The site says "no contribution above 777 SOL is accepted
  // (hard cap)" but nothing enforced it: at 770 SOL, someone sending 100 SOL
  // would go through and push the total to 870 — we would have broken our own
  // promise. The presale is a plain wallet transfer, so there is no on-chain
  // program to stop it; the barrier MUST live in the interface.
  //
  // Note: this still cannot stop someone who sends straight to the wallet
  // without ever using the site. For that case the policy is stated explicitly
  // in the rules: anything above the target is refunded.
  const remainingSol = Math.max(0, PRESALE_TARGET_SOL - progress.grossSol)
  const exceedsQuota = (amount: number) => amount > remainingSol + 1e-9

  async function handleFlexSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const amount = Number(flexAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter a valid SOL amount.')
      return
    }
    if (exceedsQuota(amount)) {
      setError(
        `Remaining quota is ${fmtSol(remainingSol)} SOL. Contributions above the target ` +
          `(${PRESALE_TARGET_SOL} SOL) are not accepted — please lower the amount.`,
      )
      return
    }
    setLoading('flex')
    try {
      const res = await sendPresaleContribution(connection, wallet, network, 'flex', amount, setStatus)
      setLastSignature(res.signature)
      setFlexAmount('')
      setStatus(`Your contribution was received: ${amount} SOL sent.`)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'The transaction failed.')
      setStatus('')
    } finally {
      setLoading(null)
    }
  }

  async function handleFixedSubmit() {
    setError('')
    if (!selectedTier) {
      setError('Pick a package first.')
      return
    }
    if (exceedsQuota(selectedTier)) {
      setError(
        `Remaining quota is ${fmtSol(remainingSol)} SOL. This package exceeds the target — pick a ` +
          'smaller one, or send the remaining amount as a free contribution.',
      )
      return
    }
    setLoading('fixed')
    try {
      const res = await sendPresaleContribution(connection, wallet, network, 'fixed', selectedTier, setStatus)
      setLastSignature(res.signature)
      setStatus(`${selectedTier} SOL sent, you earned ${res.tickets} raffle tickets! 🍀`)
      setSelectedTier(null)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'The transaction failed.')
      setStatus('')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="luck-presale">
      {!configured && (
        <div className="alert alert--warning">
          ⚠️ The presale is not open yet. Contributions cannot be sent until the presale wallet
          is announced.
        </div>
      )}

      <div className="luck-presale__meter">
        <div className="luck-presale__meter-head">
          <span className="luck-presale__meter-label">Presale Target</span>
          <span className="luck-presale__meter-value">
            {poolSol === null ? '—' : progress.grossSol.toLocaleString('en-US', { maximumFractionDigits: 2 })}{' '}
            / {PRESALE_TARGET_SOL} SOL
          </span>
        </div>
        <div
          className="luck-presale__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={PRESALE_TARGET_SOL}
          aria-valuenow={poolSol === null ? 0 : Math.round(progress.grossSol)}
        >
          <div className="luck-presale__bar-fill" style={{ width: `${progress.percent}%` }} />
          <div
            className="luck-presale__bar-softcap"
            style={{ left: `${(PRESALE_SOFT_CAP_SOL / PRESALE_TARGET_SOL) * 100}%` }}
            title={`Floor: ${PRESALE_SOFT_CAP_SOL} SOL`}
          />
        </div>
        <div className="luck-presale__meter-foot">
          <span>
            <strong>1 SOL = {formatTokens(PRESALE_TOKENS_PER_SOL)} $LUCK</strong>
          </span>
          <span>
            {phase === 'live' && endsAt
              ? `${formatRemaining(endsAt.getTime() - now.getTime())} left`
              : phase === 'upcoming'
                ? 'Not started yet'
                : phase === 'ended'
                  ? 'The presale has ended'
                  : `${PRESALE_DURATION_WEEKS} weeks — date coming soon`}
          </span>
        </div>
      </div>

      {closedReason === 'reached' && (
        <div className="alert alert--info">
          🎉 The target was reached — the presale is closed. Next up is TGE: the liquidity pool is
          opened and the LP tokens are burned.
        </div>
      )}
      {closedReason === 'ended' && (
        <div className="alert alert--info">
          The presale period is over. The supply is scaled to the amount raised and the remaining
          tokens are burned.
        </div>
      )}
      {closedReason === 'upcoming' && (
        <div className="alert alert--info">
          The presale has not started yet — contributions are not accepted.
        </div>
      )}
      {closedReason === 'unscheduled' && (
        <div className="alert alert--info">
          The presale date has not been announced yet — contributions are not accepted. Once the
          date is announced a countdown appears here.
        </div>
      )}

      {!wallet.connected && (
        <div className="luck-presale__connect">
          <p>Connect your wallet first to join the presale.</p>
          <WalletMultiButton />
        </div>
      )}

      {/* This warning sits DIRECTLY ABOVE the send forms and in red on
          purpose: the presale distribution goes to the address that SENT the
          money. Someone sending from an exchange account is effectively asking
          us to send the tokens to the exchange's collection address — those
          tokens are practically lost and cannot be recovered. Buried in the
          rules list at the bottom of the page it would be missed. */}
      <div className="alert alert--error luck-presale__exchange-warning">
        <strong>⚠️ DO NOT send from an exchange account.</strong> Tokens are distributed only to
        the address that sent the SOL. If you send from an exchange such as Binance, OKX or Bybit,
        the tokens go to the exchange's address and <strong>cannot be recovered</strong>. Send from
        a wallet where you hold the keys yourself, such as Phantom or Solflare.
      </div>

      {closedReason === null && poolSol !== null && (
        <div className="alert alert--info luck-presale__quota">
          Remaining quota: <strong>{fmtSol(remainingSol)} SOL</strong> — the presale closes once the{' '}
          {PRESALE_TARGET_SOL} SOL target is filled.
        </div>
      )}

      <div className="luck-presale__grid">
        <form className="token-form luck-presale__card" onSubmit={handleFlexSubmit}>
          <h2>Free Contribution</h2>
          <p className="subtab-desc">
            Send as much SOL as you like. The price is fixed:{' '}
            <strong>1 SOL = {formatTokens(PRESALE_TOKENS_PER_SOL)} $LUCK</strong>. Every{' '}
            {PRESALE_TICKET_UNIT_SOL} SOL {'—'} whichever mode you use {'—'} earns{' '}
            <strong>1 raffle ticket</strong>.
          </p>
          <label className="field">
            <span>Amount (SOL)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="e.g. 2.5"
              value={flexAmount}
              onChange={(e) => setFlexAmount(e.target.value)}
              disabled={!canContribute}
            />
            {Number(flexAmount) > 0 && (
              <small>
                <strong>{formatTokens(tokensForSol(Number(flexAmount)))} $LUCK</strong>
                {solUsd ? ` · ${formatUsd(Number(flexAmount), solUsd)}` : ''}
              </small>
            )}
          </label>
          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={!canContribute || loading !== null}
          >
            {loading === 'flex' ? 'Sending...' : 'Contribute'}
          </button>
        </form>

        <div className="token-form luck-presale__card">
          <h2>Ready-Made Packages</h2>
          <p className="subtab-desc">
            Pick one of the preset amounts — <strong>1 raffle ticket</strong> for every{' '}
            {PRESALE_TICKET_UNIT_SOL} SOL. The rate is identical to the free contribution; this tab
            is only a shortcut.
          </p>
          <div className="luck-tier-grid">
            {PRESALE_TIERS.map((tier) => (
              <button
                key={tier}
                type="button"
                className={`luck-tier-btn ${selectedTier === tier ? 'luck-tier-btn--active' : ''}`}
                onClick={() => setSelectedTier(tier)}
                disabled={!canContribute}
              >
                <span className="luck-tier-btn__amount">{tier} SOL</span>
                <span className="luck-tier-btn__tokens">{formatTokens(tokensForSol(tier))} $LUCK</span>
                {solUsd && <span className="luck-tier-btn__usd">{formatUsd(tier, solUsd)}</span>}
                <span className="luck-tier-btn__tickets">🎟 {calcTickets(tier)}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={handleFixedSubmit}
            disabled={!canContribute || loading !== null || !selectedTier}
          >
            {loading === 'fixed'
              ? 'Sending...'
              : selectedTier
                ? `Send ${selectedTier} SOL (${calcTickets(selectedTier)} tickets)`
                : 'Pick a package'}
          </button>
        </div>
      </div>

      <ul className="luck-presale__rules">
        <li>
          <strong>Fixed price.</strong> 1 SOL = {formatTokens(PRESALE_TOKENS_PER_SOL)} $LUCK. That
          rate does not change no matter how much is raised; you know exactly what you get as you
          send it.
        </li>
        <li>
          <strong>Target {PRESALE_TARGET_SOL} SOL, duration {PRESALE_DURATION_WEEKS} weeks.</strong>{' '}
          If the target is reached early the presale closes right there and TGE follows.
        </li>
        <li>
          <strong>If the target is not reached, the supply is scaled down.</strong> If X% of the
          target was collected, only X% is minted out of every bucket (presale, liquidity,
          community, team, marketing) and the rest <strong>is burned</strong>. The percentage split
          is preserved exactly and the pool's opening price does not change — whatever level it
          closes at, it opens above the presale price.
        </li>
        <li>
          <strong>The floor is {PRESALE_SOFT_CAP_SOL} SOL.</strong> If that amount is not reached
          there is no TGE and contributions are refunded. The refund transactions can be followed on
          chain.
        </li>
        <li>
          <strong>Anything above the target is refunded.</strong> This page will not let you send a
          contribution larger than the remaining quota. But because the presale is a plain wallet
          transfer, no on-chain program can stop someone who sends straight to the wallet without
          ever using the site — any amount above the target is refunded to the sending address and
          the refund is visible on chain.
        </li>
        <li>
          <strong>Distribution happens through claim.</strong> At TGE the tokens are locked in a
          claim program and you withdraw the unlocked part from this page yourself. 9% unlocks at
          TGE and a further 7% every week for the next 13 weeks — everything is free on day 91.
        </li>
        <li>
          <strong>The recipient list comes out of the chain.</strong> Who sent how much is public in
          the presale wallet's transaction history. You can build the list independently of us and
          verify your own share — you do not have to trust us.
        </li>
        <li>
          <strong>Raffle tickets.</strong> Every {PRESALE_TICKET_UNIT_SOL} SOL = 1 ticket. In the
          weekly raffles {RAFFLE.ticket.winnersPerRound} ticket winners are drawn each week and each
          receives {formatTokens(RAFFLE.perWinnerTokens)} $LUCK. Winners are picked with the
          blockhash of a future Solana slot: because that slot does not exist yet, nobody (us
          included) can know the result in advance, and once it does everybody can verify it.
        </li>
      </ul>

      {error && <div className="alert alert--error">{error}</div>}
      {!error && status && <div className="alert alert--info">{status}</div>}

      {lastSignature && (
        <a
          className="btn btn--secondary"
          href={`https://explorer.solana.com/tx/${lastSignature}${cluster}`}
          target="_blank"
          rel="noreferrer"
        >
          View the last transaction on Explorer
        </a>
      )}

      {history.length > 0 && (
        <div className="luck-presale__history">
          <div className="luck-presale__history-head">
            <h3>Your contribution history on this device</h3>
            <span className="luck-presale__ticket-total">🎟 Total tickets: {totalTickets}</span>
          </div>
          <ul>
            {[...history].reverse().map((h) => (
              <li key={h.signature}>
                <span>{h.mode === 'fixed' ? 'Fixed package' : 'Free contribution'}</span>
                <span>{h.amountSol} SOL</span>
                <span>🎟 {h.tickets}</span>
                <a
                  href={`https://explorer.solana.com/tx/${h.signature}${cluster}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  transaction
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
