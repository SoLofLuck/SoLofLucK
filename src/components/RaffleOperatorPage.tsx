import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { CLAIM_CONFIG, LUCK_TOKEN, OPERATOR_WALLET, PROGRAM_DEPLOYMENT_NETWORK, RAFFLE } from '../config'
import { fetchRaffleSchedule, type RaffleScheduleEntry } from '../lib/raffleSchedule'
import {
  dispatchRaffleRun,
  estimateSlotAt,
  findDispatchedRun,
  formatCountdown,
  loadStoredPat,
  nextPendingRound,
  storePat,
  updateTwitterWinners,
  validateRoundId,
  verifyPatAccess,
  type WorkflowRunSummary,
} from '../lib/raffleOperator'

function isValidAddress(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(value.trim())
    return true
  } catch {
    return false
  }
}

type Step = 'idle' | 'dry-run-running' | 'dry-run-done' | 'confirm-running' | 'confirm-done'

export function RaffleOperatorPage() {
  const { connection } = useConnection()
  const wallet = useWallet()

  const isOperator = Boolean(wallet.connected && wallet.publicKey && wallet.publicKey.toBase58() === OPERATOR_WALLET)

  const [pat, setPat] = useState(() => loadStoredPat())
  const [patInput, setPatInput] = useState(() => loadStoredPat())
  const [patStatus, setPatStatus] = useState<string>('')
  const [patVerifying, setPatVerifying] = useState(false)
  const [patError, setPatError] = useState('')

  const [schedule, setSchedule] = useState<RaffleScheduleEntry[] | null>(null)
  const [scheduleError, setScheduleError] = useState('')
  const [currentSlot, setCurrentSlot] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const [addr1, setAddr1] = useState('')
  const [addr2, setAddr2] = useState('')
  const [addr3, setAddr3] = useState('')
  const [announcedSlot, setAnnouncedSlot] = useState('')
  const [startIso, setStartIso] = useState('')

  const [step, setStep] = useState<Step>('idle')
  const [runError, setRunError] = useState('')
  const [dryRunResult, setDryRunResult] = useState<WorkflowRunSummary | null>(null)
  const [confirmResult, setConfirmResult] = useState<WorkflowRunSummary | null>(null)
  const [confirmArmed, setConfirmArmed] = useState(false)

  useEffect(() => {
    if (!isOperator) return
    fetchRaffleSchedule()
      .then(setSchedule)
      .catch((err) => setScheduleError(err instanceof Error ? err.message : 'Could not load the raffle schedule.'))
    connection.getSlot().then(setCurrentSlot).catch(() => {})
  }, [isOperator, connection])

  useEffect(() => {
    if (!isOperator) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isOperator])

  const nextRound = useMemo(() => (schedule ? nextPendingRound(schedule) : null), [schedule])

  useEffect(() => {
    if (nextRound?.dueIso && currentSlot !== null && !announcedSlot) {
      setAnnouncedSlot(String(estimateSlotAt(currentSlot, nextRound.dueIso)))
    }
    if (nextRound?.dueIso && !startIso) {
      setStartIso(nextRound.dueIso)
    }
    // Only seed these once when the round first becomes known — the operator
    // is expected to overwrite the slot with the real publicly-announced one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextRound])

  if (!wallet.connected) {
    return (
      <div className="form-section">
        <div className="alert alert--info">Connect the operator wallet to open the Raffle Operator page.</div>
      </div>
    )
  }

  if (!isOperator) {
    return (
      <div className="form-section">
        <div className="alert alert--error">
          This wallet is not authorized for the Raffle Operator page. Connect the designated operator wallet.
        </div>
      </div>
    )
  }

  async function handleVerifyPat() {
    setPatError('')
    setPatStatus('')
    setPatVerifying(true)
    try {
      const { login } = await verifyPatAccess(patInput)
      setPat(patInput)
      storePat(patInput)
      setPatStatus(`Token verified — signed in as ${login} with access to the repository.`)
    } catch (err) {
      setPatError(err instanceof Error ? err.message : 'The token could not be verified.')
    } finally {
      setPatVerifying(false)
    }
  }

  function handleClearPat() {
    setPat('')
    setPatInput('')
    storePat('')
    setPatStatus('')
    setPatError('')
  }

  function resetRunState() {
    setStep('idle')
    setRunError('')
    setDryRunResult(null)
    setConfirmResult(null)
    setConfirmArmed(false)
  }

  function validateInputs(): string | null {
    if (!nextRound) return 'No pending round found.'
    const roundErr = validateRoundId(nextRound.round)
    if (roundErr) return roundErr
    if (!announcedSlot.trim() || !/^\d+$/.test(announcedSlot.trim())) {
      return 'Enter the publicly-announced slot number (digits only).'
    }
    if (!startIso.trim()) return "Enter this round's unlock time (UTC ISO)."
    const addresses = [addr1, addr2, addr3].map((a) => a.trim())
    if (addresses.some((a) => !a)) return 'All 3 Twitter winner addresses are required.'
    if (addresses.some((a) => !isValidAddress(a))) return 'One of the 3 addresses is not a valid Solana address.'
    if (new Set(addresses).size !== addresses.length) return 'The 3 addresses must be different from each other.'
    return null
  }

  async function handleDryRun() {
    setRunError('')
    const validationError = validateInputs()
    if (validationError) {
      setRunError(validationError)
      return
    }
    if (!nextRound) return
    setStep('dry-run-running')
    setDryRunResult(null)
    try {
      const addresses = [addr1.trim(), addr2.trim(), addr3.trim()]
      await updateTwitterWinners(pat, nextRound.round, addresses)
      const dispatchedAt = new Date().toISOString()
      await dispatchRaffleRun(pat, {
        round_id: String(nextRound.round),
        announced_slot: announcedSlot.trim(),
        program_id: CLAIM_CONFIG.programId,
        mint: LUCK_TOKEN.mint,
        start_iso: startIso.trim(),
        network: PROGRAM_DEPLOYMENT_NETWORK,
        dry_run: true,
      })
      const run = await findDispatchedRun(pat, dispatchedAt)
      setDryRunResult(run)
      setStep('dry-run-done')
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'The rehearsal run failed to start.')
      setStep('idle')
    }
  }

  async function handleConfirm() {
    setRunError('')
    if (!nextRound) return
    setStep('confirm-running')
    setConfirmResult(null)
    try {
      const dispatchedAt = new Date().toISOString()
      await dispatchRaffleRun(pat, {
        round_id: String(nextRound.round),
        announced_slot: announcedSlot.trim(),
        program_id: CLAIM_CONFIG.programId,
        mint: LUCK_TOKEN.mint,
        start_iso: startIso.trim(),
        network: PROGRAM_DEPLOYMENT_NETWORK,
        dry_run: false,
      })
      const run = await findDispatchedRun(pat, dispatchedAt)
      setConfirmResult(run)
      setStep('confirm-done')
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'The real run failed to start.')
      setStep('dry-run-done')
    }
  }

  return (
    <div className="form-section form-section--wide raffle-operator">
      <h2>🎟️ Raffle Operator</h2>
      <p className="subtab-desc">
        Visible only to the operator wallet. Runs the weekly raffle round directly from this browser using your own
        GitHub token — no dependency on anyone else being available.
      </p>

      {!pat && (
        <div className="raffle-operator__pat-setup">
          <h3>1. GitHub Token</h3>
          <p className="subtab-desc">
            Create a fine-grained Personal Access Token at github.com → Settings → Developer settings, scoped ONLY to
            the SoLofLuck/SoLofLuck repository, with "Contents: Read and write" and "Actions: Read and write"
            permissions and nothing else. It is stored only in this browser (localStorage) and used only to call
            api.github.com directly.
          </p>
          <label className="field">
            <span>GitHub Personal Access Token</span>
            <input
              type="password"
              placeholder="github_pat_..."
              value={patInput}
              onChange={(e) => setPatInput(e.target.value)}
            />
          </label>
          {patError && <div className="alert alert--error">{patError}</div>}
          {patStatus && !patError && <div className="alert alert--info">{patStatus}</div>}
          <button type="button" className="btn btn--primary" onClick={handleVerifyPat} disabled={patVerifying}>
            {patVerifying ? 'Verifying...' : 'Verify & Save Token'}
          </button>
        </div>
      )}

      {pat && (
        <>
          <div className="raffle-operator__pat-bar">
            <span>✅ GitHub token saved in this browser.</span>
            <button type="button" className="btn btn--secondary btn--small" onClick={handleClearPat}>
              Forget Token
            </button>
          </div>

          <h3>2. Next Round</h3>
          {scheduleError && <div className="alert alert--error">{scheduleError}</div>}
          {!scheduleError && !schedule && <div className="alert alert--info">Loading the raffle schedule...</div>}
          {schedule && !nextRound && (
            <div className="alert alert--info">All {RAFFLE.rounds} rounds have already been drawn.</div>
          )}

          {nextRound && (
            <div className="raffle-operator__round">
              <div className="raffle-operator__round-summary">
                <div>
                  <strong>Round {nextRound.round}</strong> of {RAFFLE.rounds}
                </div>
                {nextRound.dueIso && (
                  <div>
                    Due: {new Date(nextRound.dueIso).toLocaleString()} — countdown:{' '}
                    <strong>{formatCountdown(nextRound.dueIso, now)}</strong>
                  </div>
                )}
                {currentSlot !== null && <div>Current slot (live): {currentSlot.toLocaleString()}</div>}
              </div>

              <label className="field">
                <span>Publicly-announced slot *</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={announcedSlot}
                  onChange={(e) => setAnnouncedSlot(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="e.g. 123456789"
                />
                <small>
                  Must already be publicly announced (e.g. on Twitter) before you press Rehearse below — this is only
                  pre-filled with a rough estimate from the due date.
                </small>
              </label>

              <label className="field">
                <span>Round unlock time (UTC ISO) *</span>
                <input
                  type="text"
                  value={startIso}
                  onChange={(e) => setStartIso(e.target.value)}
                  placeholder="2026-10-07T12:00:00Z"
                />
              </label>

              <h3>3. Twitter Winner Addresses (3)</h3>
              <label className="field">
                <span>Winner address 1 *</span>
                <input type="text" value={addr1} onChange={(e) => setAddr1(e.target.value)} />
              </label>
              <label className="field">
                <span>Winner address 2 *</span>
                <input type="text" value={addr2} onChange={(e) => setAddr2(e.target.value)} />
              </label>
              <label className="field">
                <span>Winner address 3 *</span>
                <input type="text" value={addr3} onChange={(e) => setAddr3(e.target.value)} />
              </label>

              {runError && <div className="alert alert--error">{runError}</div>}

              {step === 'idle' && (
                <button type="button" className="btn btn--primary btn--block" onClick={handleDryRun}>
                  Step 1: Rehearse (dry run)
                </button>
              )}
              {step === 'dry-run-running' && (
                <div className="alert alert--info">Writing winners and starting the rehearsal run...</div>
              )}
              {dryRunResult && (step === 'dry-run-done' || step === 'confirm-running') && (
                <div className="raffle-operator__run-result">
                  <div className="alert alert--info">
                    Rehearsal run started —{' '}
                    <a href={dryRunResult.html_url} target="_blank" rel="noreferrer">
                      view it on GitHub
                    </a>
                    . Check its result (winners + merkle file, in the run's Artifacts) before locking anything for
                    real.
                  </div>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={confirmArmed}
                      onChange={(e) => setConfirmArmed(e.target.checked)}
                    />
                    <div>
                      <strong>I reviewed the rehearsal and confirm it's correct.</strong>
                      <small>This cannot be undone once you lock the round for real — the claim program has no
                      "give it back" instruction.</small>
                    </div>
                  </label>
                  <button
                    type="button"
                    className="btn btn--primary btn--block"
                    onClick={handleConfirm}
                    disabled={!confirmArmed || step === 'confirm-running'}
                  >
                    {step === 'confirm-running' ? 'Locking...' : 'Step 2: Confirm & Lock For Real'}
                  </button>
                  <button type="button" className="btn btn--secondary" onClick={resetRunState}>
                    Start Over
                  </button>
                </div>
              )}
              {confirmResult && step === 'confirm-done' && (
                <div className="alert alert--info">
                  Round {nextRound.round} is being locked on chain —{' '}
                  <a href={confirmResult.html_url} target="_blank" rel="noreferrer">
                    view the run on GitHub
                  </a>
                  . Refresh the schedule after it finishes.
                  <div>
                    <button type="button" className="btn btn--secondary" onClick={resetRunState}>
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
