import { useCallback, useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { CLAIM_CONFIG, LUCK_TOKEN, RAFFLE, type NetworkId } from '../../config'
import { NETWORKS } from '../../config'
import {
  bytesToHex,
  claim,
  fetchChainTime,
  fetchClaimed,
  fetchDistributor,
  fetchMerkleFile,
  findEntry,
  formatLuck,
  isClaimConfigured,
  nextUnlockTs,
  unlockedAmount,
  type ClaimEntry,
  type DistributorState,
} from '../../lib/luckClaim'

interface Props {
  network: NetworkId
}

interface RoundView {
  id: number
  label: string
  entry: ClaimEntry
  state: DistributorState
  claimed: bigint
  unlocked: bigint
  claimable: bigint
  nextUnlock: number | null
  /** Does the published file's root match the one on chain? */
  rootMatches: boolean
}

function roundLabel(id: number): string {
  return id === CLAIM_CONFIG.presaleRoundId ? 'Your presale share' : `Week ${id} raffle`
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'now'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function ClaimTab({ network }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const configured = isClaimConfigured()

  const [rounds, setRounds] = useState<RoundView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busyRound, setBusyRound] = useState<number | null>(null)
  const [lastSignature, setLastSignature] = useState('')
  // The clock comes FROM THE CHAIN, not from the browser. The unlock schedule
  // runs on chain time, so a user whose clock runs fast would see a slice that
  // has not unlocked yet as "claimable" and have the transaction rejected —
  // precisely in the minute when everybody is trying to claim.
  //
  // We do not ask the chain once a second: the offset is measured once, then
  // the counter ticks on browser time and adds that offset. The countdown
  // stays smooth while the number stays anchored to the chain.
  const [clockOffset, setClockOffset] = useState(0)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    let cancelled = false
    fetchChainTime(connection).then((chainTime) => {
      if (cancelled || chainTime === null) return
      setClockOffset(chainTime - Math.floor(Date.now() / 1000))
    })
    return () => {
      cancelled = true
    }
  }, [connection])

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(id)
  }, [])

  const chainNow = now + clockOffset

  const refresh = useCallback(async () => {
    if (!configured || !wallet.publicKey) {
      setRounds([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const address = wallet.publicKey.toBase58()
      const ids = [CLAIM_CONFIG.presaleRoundId, ...Array.from({ length: RAFFLE.rounds }, (_, i) => i + 1)]
      const found: RoundView[] = []

      for (const id of ids) {
        // Rounds that have not happened yet have no file — skip them quietly.
        let file
        try {
          file = await fetchMerkleFile(id)
        } catch {
          continue
        }
        const entry = findEntry(file, address)
        if (!entry) continue

        const state = await fetchDistributor(connection, id)
        if (!state) continue

        const total = BigInt(entry.amount)
        const claimedSoFar = await fetchClaimed(connection, id, wallet.publicKey)
        const unlocked = unlockedAmount(state, total, chainNow)
        found.push({
          id,
          label: roundLabel(id),
          entry,
          state,
          claimed: claimedSoFar,
          unlocked,
          claimable: unlocked > claimedSoFar ? unlocked - claimedSoFar : BigInt(0),
          nextUnlock: nextUnlockTs(state, chainNow),
          rootMatches: bytesToHex(state.merkleRoot) === file.root,
        })
      }
      setRounds(found)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Could not read the distribution data.')
    } finally {
      setLoading(false)
    }
  }, [configured, wallet.publicKey, connection, chainNow])

  useEffect(() => {
    void refresh()
    // `chainNow` changes every 30 seconds, but re-querying the chain on every
    // change would be pointless load; we deliberately refresh only when the
    // wallet or the connection changes. The countdown text already updates from
    // `chainNow` during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, wallet.publicKey, connection])

  async function handleClaim(round: RoundView) {
    if (!wallet.publicKey || !wallet.signTransaction) return
    setError('')
    setStatus('')
    setLastSignature('')
    setBusyRound(round.id)
    try {
      const sig = await claim(
        connection,
        { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction },
        round.id,
        round.entry,
        setStatus,
      )
      setLastSignature(sig)
      setStatus('')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'The claim transaction failed.')
      setStatus('')
    } finally {
      setBusyRound(null)
    }
  }

  if (!configured) {
    return (
      <div className="luck-claim">
        <div className="alert alert--info">
          🔒 Distribution has not started yet. Once the presale closes and $LUCK goes live you
          will be able to claim your share from this tab.
        </div>
      </div>
    )
  }

  const explorer = NETWORKS[network].explorerCluster

  return (
    <div className="luck-claim">
      <p className="subtab-desc">
        Your presale share and any raffle rewards you won sit on chain, in a program nobody can
        intervene in by hand. You claim the unlocked part yourself from here — the team does not
        send anything on your behalf, and could not if it wanted to.
      </p>

      {!wallet.connected && (
        <div className="luck-presale__connect">
          <p>Connect your wallet to see your share.</p>
          <WalletMultiButton />
        </div>
      )}

      {error && <div className="alert alert--error">{error}</div>}
      {status && <div className="alert alert--info">{status}</div>}

      {lastSignature && (
        <div className="alert alert--success">
          ✅ The tokens were sent to your wallet.{' '}
          <a
            href={`https://solscan.io/tx/${lastSignature}${explorer}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View the transaction
          </a>
        </div>
      )}

      {wallet.connected && loading && (
        <div className="alert alert--info">Calculating your share...</div>
      )}

      {wallet.connected && !loading && rounds.length === 0 && (
        <div className="alert alert--info">
          No share was found for this wallet. If you joined the presale with a different wallet,
          connect that one.
        </div>
      )}

      {rounds.map((r) => (
        <div key={r.id} className="result-card luck-claim__round">
          <h3>{r.label}</h3>

          {!r.rootMatches && (
            <div className="alert alert--error">
              ⚠️ The published list does not match the record on chain. A claim attempt would be
              rejected — please refresh the page, and tell us if the problem persists.
            </div>
          )}

          <div className="result-card__row">
            <span>Your total share</span>
            <strong>{formatLuck(BigInt(r.entry.amount))} {LUCK_TOKEN.symbol}</strong>
          </div>
          <div className="result-card__row">
            <span>Unlocked so far</span>
            <strong>{formatLuck(r.unlocked)} {LUCK_TOKEN.symbol}</strong>
          </div>
          <div className="result-card__row">
            <span>Already claimed</span>
            <strong>{formatLuck(r.claimed)} {LUCK_TOKEN.symbol}</strong>
          </div>
          <div className="result-card__row">
            <span>Claimable now</span>
            <strong className="luck-claim__claimable">
              {formatLuck(r.claimable)} {LUCK_TOKEN.symbol}
            </strong>
          </div>

          {r.nextUnlock !== null && (
            <div className="result-card__row">
              <span>Next unlock</span>
              <strong>{formatCountdown(r.nextUnlock - chainNow)}</strong>
            </div>
          )}

          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => handleClaim(r)}
            disabled={busyRound !== null || r.claimable === BigInt(0) || !r.rootMatches}
          >
            {busyRound === r.id
              ? 'Claiming...'
              : r.claimable > BigInt(0)
                ? `Claim ${formatLuck(r.claimable)} ${LUCK_TOKEN.symbol}`
                : 'Nothing to claim right now'}
          </button>
        </div>
      ))}
    </div>
  )
}
