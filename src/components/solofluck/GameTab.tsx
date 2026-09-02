import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { GAME_CONFIG } from '../../config'
import { SlotMachine } from './SlotMachine'
import {
  buyBestFitSpins,
  buySpins,
  computeBestFitSpinPurchase,
  fetchGameConfig,
  fetchLeaderboard,
  fetchPlayerState,
  forfeitStuckPlay,
  isLuckGameConfigured,
  lamportsToSol,
  loadFreeSpinsState,
  maskWalletForLeaderboard,
  parsePlayCommittedFromTx,
  parsePlayResolvedFromTx,
  parseSpinsPurchasedFromTx,
  playFreeSpin,
  playGame,
  delegateRentReserveLamports,
  delegateSpendableLamports,
  resolveGame,
  saveFreeSpinsState,
  solToLamports,
  topUpDelegateGas,
  type FreeSpinsState,
  type LeaderboardEntry,
  type OnChainGameConfig,
  type OnChainPlayerState,
  type PlayResolvedResult,
  type SpinTier,
  type TxSigner,
} from '../../lib/luckGame'
import { ensureTestWalletFunded, loadOrCreateTestWallet, toTxSigner } from '../../lib/localTestWallet'
import { delegateToTxSigner, loadOrCreateDelegate } from '../../lib/gameDelegate'

// Minimum devnet balance for the test wallet: a small buffer, enough for a few
// transaction fees plus the initial rent cost of the PlayerState account.
const TEST_WALLET_MIN_LAMPORTS = 50_000_000 // 0.05 SOL

// The public devnet RPC (api.devnet.solana.com) rate-limits hard per IP — if
// the background polling is too frequent, the chance of hitting a 429 while
// sending a real transaction (Play / Reveal) goes up.
const POLL_MS = 8000
// The leaderboard uses getProgramAccounts (it scans every PlayerState account)
// — heavier than POLL_MS, so it runs less often.
const LEADERBOARD_POLL_MS = 30_000
function fmtSol(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 3 })
}

// The gas balance sits far below a thousandth of a SOL (around 0.0002 SOL), so
// fmtSol rendered it as "0". A separate formatter for that scale.
function fmtGas(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

// Turns Solana's raw RPC errors into messages a player can understand.
function friendlyErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : ''
  if (/block height exceeded/i.test(message)) {
    return 'The transaction took too long and the blockhash expired (approval in the wallet probably took a while) — try again and confirm in your wallet as quickly as you can.'
  }
  if (/429|rate limit/i.test(message)) {
    return 'The RPC server is busy right now, try again in a few seconds.'
  }
  // CAREFUL: this used to match `insufficient` as well. That was far too broad —
  // "insufficient funds" / "insufficient lamports" (i.e. no SOL in the wallet)
  // were also reported as "you have no spins left". It hid the real cause; now we
  // only look at the program's own error code.
  if (/NoSpinsRemaining|0x1776/i.test(message)) {
    return 'You have no spins left — buy a package first.'
  }
  // Three errors about reveal timing. The first two are transient: they clear
  // themselves once the chain advances a few seconds, and the automatic reveal
  // already retries. They must not read to the user as "something broke".
  if (/TooEarlyToResolve|0x1777/i.test(message)) {
    return 'The chain needs to advance a few more seconds before the result can be revealed — it will open on its own shortly.'
  }
  if (/SlotHashNotFound|0x177b/i.test(message)) {
    return 'The block the result rests on has not been written to the chain yet — it will open on its own shortly.'
  }
  if (/ResolveWindowExpired|0x1778/i.test(message)) {
    return 'The reveal window for this attempt has expired. You can continue with "Clear Attempt" (the spin counts as used).'
  }
  // A rent rejection at the chain level: an account cannot be left with a balance
  // BELOW the rent-exemption floor, which is ~0.00089 SOL for a 0-byte account.
  // On this error the program itself usually ran without a fault (the logs say
  // "success") and the transaction still fails — which is why it deserves its own
  // explicit message.
  if (/InsufficientFundsForRent|insufficient funds for rent/i.test(message)) {
    return 'The transaction was rejected by Solana\'s rent rule: an account cannot be left with a balance below the ~0.00089 SOL floor. Refresh the page and try again — tell us if the problem persists.'
  }
  if (/insufficient funds|insufficient lamports|InsufficientFundsForFee/i.test(message)) {
    return 'Your wallet does not have enough SOL — some is needed for the transaction fee and the package price.'
  }
  return message || 'The transaction failed.'
}

export function GameTab() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const configured = isLuckGameConfigured()

  const [gameConfig, setGameConfig] = useState<OnChainGameConfig | null>(null)
  const [playerState, setPlayerState] = useState<OnChainPlayerState | null>(null)
  const [currentSlot, setCurrentSlot] = useState<number | null>(null)
  const [initialized, setInitialized] = useState<boolean | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [delegateBalance, setDelegateBalance] = useState<number | null>(null)
  // The delegate account's rent deposit (the rent-exempt floor for a 0-byte
  // account). That amount must stay on chain — it is NOT spendable gas, so we
  // subtract it before showing the balance to the user (see lib/luckGame.ts).
  const [delegateRentReserve, setDelegateRentReserve] = useState<number | null>(null)

  const [busy, setBusy] = useState<string | null>(null)
  // The transaction progress text is NO LONGER shown on screen (user feedback:
  // "a free game was played — remove the 'the slot spun' text from the screen,
  // the player should live the real spinning experience"). The lower-level
  // functions (playGame/buySpins/...) still expect a progress callback, so the
  // setter stays while its value is never read.
  const [, setStatus] = useState('')
  const [error, setError] = useState('')
  const [lastResult, setLastResult] = useState<PlayResolvedResult | null>(null)
  // We do not state the result in words until the slot animation is over — the
  // reels spin for 15-20s and stop one by one, and only AFTER that does
  // SlotMachine call onLanded and the won/lost text appear.
  const [revealedResult, setRevealedResult] = useState<PlayResolvedResult | null>(null)
  const [spinAnimating, setSpinAnimating] = useState(false)
  const [bonusNotice, setBonusNotice] = useState(false)
  // The result is normally revealed AUTOMATICALLY (the useEffect below). This
  // flag only becomes true when the automatic attempt errors out, and brings back
  // the manual "Reveal Result" button — so the button is a fallback, not a normal
  // part of the flow.
  const [autoResolveFailed, setAutoResolveFailed] = useState(false)
  const [purchaseNotice, setPurchaseNotice] = useState('')
  const [convertAmount, setConvertAmount] = useState('')

  // Devnet-only debugging mode: it lets us complete the game with a local,
  // instantly-signing wallet — no real wallet — and verify that the game logic
  // itself works. In this mode player == signer, so no delegate registration is
  // needed at all.
  // Free spins: no blockchain, entirely client-side, kept in localStorage PER
  // WALLET (the effect below loads that wallet's spins as the wallet changes).
  const [freeSpinsState, setFreeSpinsState] = useState<FreeSpinsState>(() => loadFreeSpinsState(null))

  const [testKeypair] = useState(() => loadOrCreateTestWallet())
  const [testWalletOn, setTestWalletOn] = useState(false)
  const [testBalance, setTestBalance] = useState<number | null>(null)
  const [testFunding, setTestFunding] = useState(false)
  const [testFundError, setTestFundError] = useState('')

  // The local "game wallet" (delegate / session key) used in real-wallet mode —
  // once authorised on chain it signs every play()/resolve() call without a
  // prompt. Winnings always go to the real wallet (see lib/gameDelegate.ts and
  // program/luck-game/src/lib.rs).
  const [delegateKeypair] = useState(() => loadOrCreateDelegate())

  const activeOwnerPublicKey = testWalletOn ? testKeypair.publicKey : wallet.publicKey
  const isActive = testWalletOn || wallet.connected
  const freeSpinsOwnerKey = activeOwnerPublicKey ? activeOwnerPublicKey.toBase58() : null

  // When the connected wallet changes, load that wallet's free spins — they are
  // per wallet ("3 free attempts per wallet"), not per browser.
  useEffect(() => {
    setFreeSpinsState(loadFreeSpinsState(freeSpinsOwnerKey))
  }, [freeSpinsOwnerKey])

  const realWalletSigner: TxSigner | null =
    wallet.publicKey && wallet.signTransaction
      ? { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction }
      : null

  const delegateActive =
    !testWalletOn && playerState !== null && playerState.delegate.equals(delegateKeypair.publicKey)

  // The signer for play()/resolve() — ALWAYS a local key (the test wallet or the
  // active delegate); it never opens a real wallet popup.
  const spinAuthoritySigner: TxSigner | null = testWalletOn
    ? toTxSigner(testKeypair)
    : delegateActive
      ? delegateToTxSigner(delegateKeypair)
      : null

  // Transactions that move money (buying a package, delegate registration, gas
  // top-up) — in real mode these require a REAL wallet approval.
  const paymentSigner: TxSigner | null = testWalletOn ? toTxSigner(testKeypair) : realWalletSigner

  // On the program side, forfeit_stuck_play requires the REAL player's signature
  // via `has_one = player` (the test wallet in test mode).
  const forfeitSigner: TxSigner | null = testWalletOn ? toTxSigner(testKeypair) : realWalletSigner

  const effectiveSpinTiers: SpinTier[] = useMemo(
    () =>
      gameConfig?.spinTiers ??
      GAME_CONFIG.spinTiers.map((t) => ({ count: t.count, priceLamports: solToLamports(t.priceSol) })),
    [gameConfig],
  )

  const refresh = useCallback(async () => {
    if (!configured) return
    try {
      const [cfg, slot] = await Promise.all([fetchGameConfig(connection), connection.getSlot()])
      setGameConfig(cfg)
      setInitialized(cfg !== null)
      setCurrentSlot(slot)
      if (activeOwnerPublicKey) {
        const ps = await fetchPlayerState(connection, activeOwnerPublicKey)
        setPlayerState(ps)
        if (testWalletOn) {
          setTestBalance(await connection.getBalance(activeOwnerPublicKey))
        } else {
          const [balance, reserve] = await Promise.all([
            connection.getBalance(delegateKeypair.publicKey),
            delegateRentReserveLamports(connection),
          ])
          setDelegateBalance(balance)
          setDelegateRentReserve(reserve)
        }
      } else {
        setPlayerState(null)
      }
    } catch (err) {
      console.error('Could not read the game state:', err)
    }
  }, [connection, activeOwnerPublicKey, testWalletOn, configured, delegateKeypair])

  const refreshLeaderboard = useCallback(async () => {
    if (!configured) return
    try {
      setLeaderboard(await fetchLeaderboard(connection, 10))
    } catch (err) {
      console.error('Could not read the leaderboard:', err)
    }
  }, [connection, configured])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    refreshLeaderboard()
    const id = setInterval(refreshLeaderboard, LEADERBOARD_POLL_MS)
    return () => clearInterval(id)
  }, [refreshLeaderboard])

  async function handleEnableTestWallet() {
    setTestFundError('')
    setTestWalletOn(true)
    setTestFunding(true)
    try {
      const balance = await ensureTestWalletFunded(connection, testKeypair.publicKey, TEST_WALLET_MIN_LAMPORTS)
      setTestBalance(balance)
    } catch (err) {
      console.error(err)
      setTestFundError(
        `The automatic devnet airdrop failed (most likely the faucet rate limit). You can send some devnet SOL to the test wallet address (${testKeypair.publicKey.toBase58()}) by hand from https://faucet.solana.com, or try again in a few minutes.`,
      )
    } finally {
      setTestFunding(false)
    }
  }

  function handleDisableTestWallet() {
    setTestWalletOn(false)
    setTestFundError('')
    setLastResult(null)
    setError('')
    setStatus('')
  }

  // The delegate's gas balance is normally refilled from the vault on every
  // purchase (see handleBuySpins / handleConvert) — this is a rare fallback that
  // needs a real transfer from the player's own wallet, only relevant if they
  // have played for a very long time without buying anything.
  async function handleTopUpDelegate() {
    if (!realWalletSigner) return
    setError('')
    setBusy('topup')
    try {
      const lamports = Number(solToLamports(GAME_CONFIG.delegateTopUpSol))
      await topUpDelegateGas(connection, realWalletSigner, delegateKeypair.publicKey, lamports, setStatus)
      setStatus('The game wallet balance was topped up.')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
    } finally {
      setBusy(null)
    }
  }

  async function handlePlay() {
    setError('')
    setLastResult(null)
    setRevealedResult(null)
    setBonusNotice(false)
    // The "+N spins added!" notice was left over from the purchase and was never
    // cleared, so it stayed on screen after every spin — a user read that as "I get
    // extra spins on every spin".
    setPurchaseNotice('')
    setAutoResolveFailed(false)
    setSpinAnimating(true)
    setBusy('play')
    try {
      // Are there any free spins left?
      if (freeSpinsState.spinsRemaining > 0) {
        // No blockchain, entirely client-side
        const { newState } = playFreeSpin(freeSpinsState)
        setFreeSpinsState(newState)
        saveFreeSpinsState(newState, freeSpinsOwnerKey)

        // Was a bonus spin granted?
        if (newState.bonusGranted && newState.spinsRemaining > 0 && newState.playsCount === GAME_CONFIG.freePlays + 1) {
          setBonusNotice(true)
        }

        // The result is known instantly (a free spin always loses) but is NOT
        // shown on screen right away: SlotMachine spins the reels for 15-20s
        // and stops them one by one; only then does the result text appear.
        setLastResult({
          won: false,
          prizePaidLamports: BigInt(0),
          isBigWin: false,
          easyMode: false,
          opsFeePaidLamports: BigInt(0),
        })

        await refresh()
      } else {
        // The on-chain game, for purchased spins
        if (!spinAuthoritySigner || !activeOwnerPublicKey) return
        const sig = await playGame(connection, activeOwnerPublicKey, spinAuthoritySigner, setStatus, {
          confirmMessage: null,
        })
        const committed = await parsePlayCommittedFromTx(connection, sig)
        if (committed?.bonusGranted) setBonusNotice(true)
        setStatus('The round has started — the result will surface in a few seconds.')
        await refresh()
      }
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
      setSpinAnimating(false)
    } finally {
      setBusy(null)
    }
  }

  async function handleResolve() {
    // `gameConfig` is required too: on a winning round resolve() moves the house
    // share, added on top of the prize, to the treasury, so it expects the
    // on-chain `config.treasury` address in the account list.
    if (!spinAuthoritySigner || !activeOwnerPublicKey || !gameConfig) return
    setError('')
    setBusy('resolve')
    try {
      const sig = await resolveGame(
        connection,
        activeOwnerPublicKey,
        spinAuthoritySigner,
        gameConfig.treasury,
        setStatus,
        { confirmMessage: null },
      )
      setStatus('Reading the result...')
      const result = await parsePlayResolvedFromTx(connection, sig)
      // The result came from the chain but is not written on screen yet — it is
      // revealed once the reels have stopped in turn and the animation ends
      // (onLanded).
      setLastResult(result)
      setStatus('')
      setAutoResolveFailed(false)
      await refresh()
      if (result?.won) refreshLeaderboard()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
      setSpinAnimating(false)
      // The automatic reveal failed — bring the button back so the player can
      // retry by hand (and do not trigger the automatic attempt again, so we do
      // not repeat the same error in an endless loop).
      setAutoResolveFailed(true)
    } finally {
      setBusy(null)
    }
  }

  async function handleForfeit() {
    if (!forfeitSigner) return
    setError('')
    setBusy('forfeit')
    try {
      await forfeitStuckPlay(connection, forfeitSigner, setStatus)
      setStatus('The stuck attempt was cleared, you can play again.')
      setSpinAnimating(false)
      setLastResult(null)
      setRevealedResult(null)
      await refresh()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
    } finally {
      setBusy(null)
    }
  }

  async function handleBuySpins(tierIndex: number) {
    if (!paymentSigner || !gameConfig) return
    setError('')
    setPurchaseNotice('')
    setBusy(`buy-${tierIndex}`)
    try {
      // Delegate registration (on the first purchase) IS NO LONGER A SEPARATE
      // TRANSACTION: the setup instructions are prepended to the purchase
      // instruction and all of it goes out in ONE transaction with ONE
      // signature. It used to ask for two separate approvals; switching apps
      // twice on a mobile wallet was slow, and if the transaction in between
      // failed it left a half-finished setup behind.
      const needsDelegate = !playerState || !playerState.delegate.equals(delegateKeypair.publicKey)
      console.log('[BuySpins] Buying spins...', {
        tierIndex,
        treasury: gameConfig.treasury.toBase58(),
        needsDelegate,
      })
      const sig = await buySpins(
        connection,
        paymentSigner,
        tierIndex,
        gameConfig.treasury,
        delegateKeypair.publicKey,
        setStatus,
        needsDelegate,
      )
      console.log('[BuySpins] Purchase tx succeeded:', sig)
      const purchased = await parseSpinsPurchasedFromTx(connection, sig)
      console.log('[BuySpins] Parsed spin count:', purchased?.spinCount)
      setPurchaseNotice(
        purchased ? `+${purchased.spinCount} spins added!` : 'The package was purchased.',
      )
      setStatus('')
      await refresh()
    } catch (err) {
      console.error('[BuySpins] Error:', err)
      const friendlyMsg = friendlyErrorMessage(err)
      setError(friendlyMsg)
      setStatus('')
      // Surface the error message
      if (err instanceof Error) {
        console.error('[BuySpins] Error details:', err.message, err.stack)
      }
    } finally {
      setBusy(null)
    }
  }

  const convertPreview = useMemo(() => {
    const amountSol = Number.parseFloat(convertAmount)
    if (!Number.isFinite(amountSol) || amountSol <= 0 || effectiveSpinTiers.length === 0) return null
    const budget = solToLamports(amountSol)
    const combo = computeBestFitSpinPurchase(budget, effectiveSpinTiers)
    if (combo.purchases.length === 0) return null
    const totalSpins = combo.purchases.reduce(
      (sum, p) => sum + effectiveSpinTiers[p.tierIndex].count * p.count,
      0,
    )
    return { ...combo, totalSpins }
  }, [convertAmount, effectiveSpinTiers])

  async function handleConvert() {
    if (!paymentSigner || !gameConfig || !convertPreview) return
    setError('')
    setPurchaseNotice('')
    setBusy('convert')
    try {
      const budget = solToLamports(Number.parseFloat(convertAmount))
      const needsDelegate = !playerState || !playerState.delegate.equals(delegateKeypair.publicKey)
      const result = await buyBestFitSpins(
        connection,
        paymentSigner,
        budget,
        effectiveSpinTiers,
        gameConfig.treasury,
        delegateKeypair.publicKey,
        setStatus,
        needsDelegate,
      )
      const totalSpins = result.purchases.reduce(
        (sum, p) => sum + effectiveSpinTiers[p.tierIndex].count * p.count,
        0,
      )
      setPurchaseNotice(
        `${totalSpins} spins added (${fmtSol(lamportsToSol(result.totalCostLamports))} SOL used${
          result.leftoverLamports > 0n
            ? `, ${fmtSol(lamportsToSol(result.leftoverLamports))} SOL was too small to use`
            : ''
        }).`,
      )
      setConvertAmount('')
      setStatus('')
      await refresh()
    } catch (err) {
      console.error(err)
      setError(friendlyErrorMessage(err))
      setStatus('')
    } finally {
      setBusy(null)
    }
  }

  // ---------------------------------------------------------------------
  // Reveal the result automatically
  // ---------------------------------------------------------------------
  // The game has two steps: play() writes "I played on this slot" to the chain,
  // and resolve() opens the result a few slots later (why it has to work that
  // way is explained at the top of resolve() in
  // program/luck-game/src/lib.rs). A "Reveal Result" button used to be shown
  // for that second step — but the game wallet already provides the signature,
  // so no approval window ever opens: for the user that button was a pointless
  // extra step to press while the reels were already spinning. It is now called
  // on its own as soon as it is ready; the button only comes back if the
  // automatic attempt fails.
  //
  // Derived values are recomputed here so the hook is not conditional (it sits
  // BEFORE the "not configured" early return below).
  // The automatic reveal's ATTEMPT COUNTER — not a one-shot flag.
  //
  // It used to fire only ONCE per game, at the moment the target slot was
  // REACHED (slotsLeft <= 0). But at that moment the target slot's hash has not
  // yet entered the SlotHashes sysvar: the sysvar only contains PREVIOUS slots.
  // The reveal failed with SlotHashNotFound and, because the flag was already
  // set, was NEVER RETRIED — the user saw an error and had to press the fallback
  // button.
  //
  // Two changes: (1) we wait until the target slot has PASSED, and (2) if it
  // fails we retry on the next slot poll. The number of attempts is capped, so a
  // genuinely unresolvable game does not spin in an endless loop.
  const autoResolveTriesRef = useRef<{ key: string; tries: number }>({ key: '', tries: 0 })
  const AUTO_RESOLVE_MAX_TRIES = 5
  useEffect(() => {
    if (busy !== null) return
    if (!spinAuthoritySigner || !activeOwnerPublicKey || !gameConfig || !playerState) return
    if (!playerState.pending || currentSlot === null) return

    const slotsLeft = Number(playerState.commitSlot + gameConfig.revealDelaySlots) - currentSlot
    // `> -1`: the target slot must have PASSED, not merely been reached. The
    // hash only enters the sysvar AFTER the slot has been produced.
    if (slotsLeft > -1) return
    // If the resolve window was missed it can no longer be opened — we leave
    // that to the "Clear Attempt" flow.
    if (-slotsLeft > GAME_CONFIG.maxResolveWindowSlots) return

    const key = `${activeOwnerPublicKey.toBase58()}:${playerState.commitSlot}`
    const tracker = autoResolveTriesRef.current
    if (tracker.key !== key) {
      autoResolveTriesRef.current = { key, tries: 0 }
    }
    if (autoResolveTriesRef.current.tries >= AUTO_RESOLVE_MAX_TRIES) return
    autoResolveTriesRef.current.tries += 1
    void handleResolve()
  }, [busy, spinAuthoritySigner, activeOwnerPublicKey, gameConfig, playerState, currentSlot])

  if (!configured) {
    return (
      <div className="luck-game">
        <div className="alert alert--warning">
          ⚠️ The game is not live yet. It opens once the game program is published on chain.
        </div>
      </div>
    )
  }

  const revealDelaySlots = gameConfig?.revealDelaySlots ?? BigInt(GAME_CONFIG.revealDelaySlots)
  // Free attempts are granted ENTIRELY client-side (localStorage) — they are
  // never written to the chain, so they incur no account or transaction fee.
  // That is why the on-chain `GameConfig.free_plays` was set to 0 (see
  // scripts/update-config.mjs): granting both let a player spin 3 local + 3
  // on-chain + bonuses for free.
  const freePlays = GAME_CONFIG.freePlays
  const smallPrizeSol = gameConfig ? lamportsToSol(gameConfig.smallPrizeLamports) : GAME_CONFIG.smallPrizeSol
  const bigPrizeSol = gameConfig ? lamportsToSol(gameConfig.bigPrizeLamports) : GAME_CONFIG.bigPrizeSol

  const winsCount = playerState?.winsCount ?? 0
  const totalWonSol = playerState ? lamportsToSol(playerState.totalWonLamports) : 0
  // Free attempts live client-side (freeSpinsState), purchased spins live on
  // chain; the total attempt count is the sum of the two.
  const playsCount = (playerState?.playsCount ?? 0) + freeSpinsState.playsCount
  // The on-chain spin balance is only playable while the delegate (game wallet)
  // is registered — it is the one that signs. The delegate is set up during the
  // first purchase, so for a player who has never bought a package the on-chain
  // balance (including the free spins that show by default when no account
  // exists) is in practice unusable.
  //
  // An earlier version showed that unusable balance in the counter and the
  // button label anyway: the button read "3 spins left" while canPlay looked at
  // the (exhausted) client-side free spins, returned false, and the button
  // stayed disabled. Both places now show the spins that are ACTUALLY playable.
  const purchasedSpins = spinAuthoritySigner !== null ? (playerState?.spinsRemaining ?? 0) : 0
  const playableSpins = freeSpinsState.spinsRemaining + purchasedSpins
  const pending = playerState?.pending ?? false
  const needsDelegateSetup = isActive && !testWalletOn && !delegateActive
  // A wallet must be connected and there must be a genuinely playable spin.
  const canPlay = isActive && playableSpins > 0
  // The "spendable" balance: the raw balance minus the rent deposit. Looking at
  // the raw balance was misleading — the 0.00089 SOL floor can never go towards
  // a transaction fee.
  const delegateGasLamports =
    delegateBalance !== null && delegateRentReserve !== null
      ? delegateSpendableLamports(delegateBalance, delegateRentReserve)
      : null
  const delegateLowBalance =
    delegateActive &&
    delegateGasLamports !== null &&
    lamportsToSol(delegateGasLamports) < GAME_CONFIG.delegateLowBalanceSol

  // Whether the vault can cover the jackpot plus the treasury share — the SAME
  // How the two prizes split among WINNERS. `bigPrizeBps` is the share of
  // winners who get the jackpot rather than the small prize, so the other side
  // is simply the rest.
  //
  // Both come from the chain value rather than being written into a sentence: a
  // hardcoded "70% / 30%" would go on claiming that after someone moved
  // bigPrizeBps with update_config, and a wrong number about prizes is worse
  // than no number. Trailing '.0' is dropped so the common case reads "30%"
  // rather than "30.0%".
  //
  // Note this is NOT the chance of winning — that number is deliberately not on
  // this panel. This is only how a win, once it happens, divides between the
  // two prizes.
  const winnerSplit = (() => {
    if (!gameConfig || gameConfig.bigPrizeBps <= 0 || gameConfig.bigPrizeBps >= 10_000) return null
    const pct = (bps: number) => (bps / 100).toFixed(1).replace(/\.0$/, '')
    return { small: pct(10_000 - gameConfig.bigPrizeBps), big: pct(gameConfig.bigPrizeBps) }
  })()

  const targetSlot = playerState ? playerState.commitSlot + revealDelaySlots : null
  const slotsRemaining =
    targetSlot !== null && currentSlot !== null ? Number(targetSlot) - currentSlot : null
  const readyToResolve = slotsRemaining !== null && slotsRemaining <= 0
  const windowExpired =
    slotsRemaining !== null && -slotsRemaining > GAME_CONFIG.maxResolveWindowSlots

  // SlotMachine owns the animation duration: once a round starts, spinAnimating
  // stays true until the reels have stopped one by one and the result is
  // revealed (onLanded) — on a free spin there is no chain work, so even though
  // busy clears instantly the reels keep spinning for 15-20s.
  const spinning = spinAnimating || busy === 'play' || busy === 'resolve' || (pending && !windowExpired)
  const slotResult = lastResult ? (lastResult.won ? 'win' : 'lose') : 'idle'

  return (
    <div className="luck-game">
      <p className="subtab-desc">
        A game of chance running on the Solana network. Every wallet gets{' '}
        <strong>{freePlays} free attempts</strong> (plus a <strong>+1 bonus attempt</strong> once
        they run out), and after that you buy packages. Most winners take the{' '}
        <strong>{fmtSol(smallPrizeSol)} SOL</strong> small prize, while a lucky few land the{' '}
        <strong>{fmtSol(bigPrizeSol)} SOL</strong> big prize / jackpot — winnings are always sent
        straight to your wallet.
      </p>

      {initialized === false && (
        <div className="alert alert--warning">
          ⚠️ The program appears to be deployed but <code>initialize()</code> has not been called
          yet — the game is not set up.
        </div>
      )}

      {!isActive ? (
        <div className="luck-presale__connect">
          <p>Connect your wallet first to play.</p>
          <WalletMultiButton />
        </div>
      ) : (
        <>
          {testWalletOn && (
            <div className="alert alert--info luck-game__test-banner">
              🧪 Devnet test wallet active — signing happens instantly without approval and never
              switches to the wallet app. This involves NO real money or coins, only devnet SOL.
              Address:{' '}
              <code>{testKeypair.publicKey.toBase58()}</code>{' '}
              {testBalance !== null && <>({fmtSol(lamportsToSol(testBalance))} SOL)</>}
              <div>
                <button type="button" className="btn btn--secondary" onClick={handleEnableTestWallet} disabled={testFunding}>
                  {testFunding ? 'Requesting airdrop...' : 'Request airdrop'}
                </button>{' '}
                <button type="button" className="btn btn--secondary" onClick={handleDisableTestWallet}>
                  Back to the real wallet
                </button>
              </div>
              {testFundError && <div className="alert alert--warning">{testFundError}</div>}
            </div>
          )}

          {/* This banner used to sit there PERMANENTLY while the game wallet was
              active, reading "Gas balance: 0 SOL" — fmtSol rounds to 3 digits, so
              0.0002 SOL showed as "0", which was both pointless and misleading (the
              game worked perfectly well). The vault already refills the gas on every
              purchase, so the banner now appears only when action is GENUINELY needed,
              i.e. when the gas is about to run out. */}
          {delegateLowBalance && (
            <div className="luck-game__delegate-status">
              ⛽ The game wallet is low on gas ({fmtGas(lamportsToSol(delegateGasLamports ?? 0))} SOL) —{' '}
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={handleTopUpDelegate}
                disabled={busy !== null || !realWalletSigner}
              >
                {busy === 'topup' ? 'Topping up...' : 'Top up'}
              </button>
            </div>
          )}

          {/* ---------------------------------------------------------------
              What the player gets — with the real values READ FROM THE CHAIN
              ---------------------------------------------------------------
              This panel answers the player's questions and nothing else: what can I
              win, how do the two prizes compare, how many free goes do I get.

              What is deliberately NOT here: the vault balance, the house share, the
              win percentage and the easy-mode threshold. Those are our operating
              numbers, not the player's — a site is not the place for them. They stay
              readable by anyone who wants them, in the program source and in this
              repository, which is where a claim of fairness belongs anyway.

              The prizes come from the on-chain GameConfig, NOT from config.ts, so
              what is printed is what the program actually pays. If the two drifted
              apart, the screen would be lying. */}
          {gameConfig && (
            <details className="luck-game__rules">
              <summary>📋 Prizes and free attempts (read from the chain)</summary>
              <div className="luck-game__rules-body">
                <div className="result-card__row">
                  <span>Big prize (jackpot)</span>
                  <strong>{fmtSol(lamportsToSol(gameConfig.bigPrizeLamports))} SOL</strong>
                </div>
                <div className="result-card__row">
                  <span>Small prize</span>
                  <strong>{fmtSol(lamportsToSol(gameConfig.smallPrizeLamports))} SOL</strong>
                </div>
                {winnerSplit && (
                  <div className="result-card__row">
                    <span>Among winners</span>
                    <strong>
                      {winnerSplit.small}% small prize · {winnerSplit.big}% jackpot
                    </strong>
                  </div>
                )}
                <div className="result-card__row">
                  <span>Free attempts</span>
                  <strong>
                    {GAME_CONFIG.freePlays} per wallet, plus a +1 bonus when they run out
                  </strong>
                </div>
                <p className="luck-game__rules-note">
                  The prizes are read from the program on the chain, so what you see here is
                  what it actually pays. A prize goes straight to your wallet — nothing is
                  deducted from it.
                </p>
              </div>
            </details>
          )}

          <SlotMachine
            spinning={spinning}
            result={slotResult}
            bigWin={lastResult?.isBigWin ?? false}
            onLanded={() => {
              setSpinAnimating(false)
              setRevealedResult(lastResult)
              if (lastResult?.won) refreshLeaderboard()
            }}
          />

          {error && <div className="alert alert--error">{error}</div>}
          {bonusNotice && (
            <div className="alert alert--success">
              🎁 Congratulations! You finished your free attempts and earned{' '}
              <strong>+1 bonus attempt</strong>!
            </div>
          )}
          {purchaseNotice && <div className="alert alert--success">{purchaseNotice}</div>}

          {revealedResult && (
            <div
              className={`luck-game__result ${revealedResult.won ? 'luck-game__result--win' : 'luck-game__result--lose'}`}
            >
              {revealedResult.won ? (
                revealedResult.isBigWin ? (
                  <>🎉🏆 BIG PRIZE / JACKPOT! {fmtSol(lamportsToSol(revealedResult.prizePaidLamports))} SOL was sent to your wallet.</>
                ) : (
                  <>🎉 You won the small prize! {fmtSol(lamportsToSol(revealedResult.prizePaidLamports))} SOL was sent to your wallet.</>
                )
              ) : (
                <>Not this time — try again! 🍀</>
              )}
            </div>
          )}

          {/* `pending` is read from the chain and flips to true the moment play()
              lands, then back to false when resolve() finishes. Hiding the button on
              `pending` alone therefore unmounted it for the second or two in between,
              in the MIDDLE of the spin: the "Reels are spinning..." label appeared,
              vanished, and came back. Nothing was broken underneath — the reels kept
              turning — but the one piece of text telling the player the machine is
              working blinked out exactly when they were watching it.

              So while the animation runs the button stays put regardless of `pending`.
              It is disabled throughout (see `disabled` below), so keeping it mounted
              adds no action, only a label that does not flicker. */}
          {(!pending || spinAnimating) && (
            <button
              type="button"
              className="btn btn--primary btn--block luck-game__play-btn"
              onClick={handlePlay}
              disabled={busy !== null || spinAnimating || !canPlay}
            >
              {spinAnimating
                ? '🎰 Reels are spinning...'
                : !isActive
                  ? '🔒 Connect your wallet'
                  : playableSpins > 0
                    ? `🎰 Spin (${playableSpins} spins left)`
                    : needsDelegateSetup
                      ? '🔒 Activate the game wallet (buy spins)'
                      : '🔒 No spins left — buy a package'}
            </button>
          )}

          {/* We show NO INTERMEDIATE STATUS TEXT during a spin ("Preparing the
              result...", "Revealing the result..."). The reels are already spinning,
              the button itself says "Reels are spinning...", and the result opens on
              its own within two or three seconds — boxes appearing in between took the
              place of the win/lose message and created noise. Only the won/lost
              message, which is genuinely new information, stays on screen.

              One exception: if the automatic reveal ERRORS, the button comes back so
              it can be retried by hand. That is not a notification but an escape
              hatch that keeps the user from getting stuck. */}
          {pending && !windowExpired && readyToResolve && autoResolveFailed && (
            <div className="luck-game__pending">
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={handleResolve}
                disabled={busy !== null || !gameConfig}
              >
                {busy === 'resolve' ? 'Reading the result...' : '🎲 Reveal Result (retry)'}
              </button>
            </div>
          )}

          {pending && windowExpired && (
            <div className="luck-game__pending">
              <div className="alert alert--warning">
                This attempt missed the resolve window and can no longer be settled.
              </div>
              <button
                type="button"
                className="btn btn--secondary btn--block"
                onClick={handleForfeit}
                disabled={busy !== null || !forfeitSigner}
              >
                {busy === 'forfeit' ? 'Clearing...' : 'Clear Attempt and Play Again'}
              </button>
            </div>
          )}

          <div className="luck-tokenomics__summary luck-game__stats">
            <div className="luck-tokenomics__stat">
              <span>Spins Left</span>
              <strong>{playableSpins}</strong>
            </div>
            <div className="luck-tokenomics__stat">
              <span>Total Attempts</span>
              <strong>{playsCount}</strong>
            </div>
            <div className="luck-tokenomics__stat">
              <span>Total Wins</span>
              <strong>{winsCount}</strong>
            </div>
            <div className="luck-tokenomics__stat">
              <span>Game Balance (Total Winnings)</span>
              <strong>{fmtSol(totalWonSol)} SOL</strong>
            </div>
          </div>

          <div className="luck-game__tariff">
            <h3>Spin Packages</h3>
            <div className="luck-game__tariff-grid">
              {GAME_CONFIG.spinTiers.map((tier, i) => (
                <button
                  key={i}
                  type="button"
                  className="luck-game__tariff-card"
                  onClick={() => handleBuySpins(i)}
                  disabled={busy !== null || !paymentSigner || !gameConfig}
                >
                  <strong>{tier.count} Spins</strong>
                  <span>{fmtSol(tier.priceSol)} SOL</span>
                  {busy === `buy-${i}` && <em>Buying...</em>}
                </button>
              ))}
            </div>

            <div className="luck-game__convert">
              <label htmlFor="luck-convert-amount">Convert My Balance Into Spins</label>
              <div className="luck-game__convert-row">
                <input
                  id="luck-convert-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="SOL amount (e.g. 0.4)"
                  value={convertAmount}
                  onChange={(e) => setConvertAmount(e.target.value)}
                  disabled={busy !== null}
                />
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={handleConvert}
                  disabled={busy !== null || !convertPreview || !paymentSigner || !gameConfig}
                >
                  {busy === 'convert' ? 'Converting...' : 'Convert'}
                </button>
              </div>
              {convertPreview && (
                <p className="luck-game__convert-preview">
                  ≈ <strong>{convertPreview.totalSpins} spins</strong> (
                  {convertPreview.purchases
                    .map((p) => `${p.count}× ${GAME_CONFIG.spinTiers[p.tierIndex].count}-spin package`)
                    .join(' + ')}
                  ), {fmtSol(lamportsToSol(convertPreview.totalCostLamports))} SOL in total
                  {convertPreview.leftoverLamports > 0n && (
                    <> (the remaining {fmtSol(lamportsToSol(convertPreview.leftoverLamports))} SOL is not enough for the smallest package)</>
                  )}
                </p>
              )}
              <p className="luck-game__convert-hint">
                The amount you enter is split into the best-fitting combination of packages and bought in a single transaction.
              </p>
            </div>
          </div>

          {leaderboard.length > 0 && (
            <div className="luck-game__leaderboard">
              <h3>🏆 Leaderboard</h3>
              <table className="luck-game__leaderboard-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Wallet</th>
                    <th>Total Winnings</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((entry, i) => (
                    <tr key={entry.player.toBase58()}>
                      <td>{i + 1}</td>
                      <td>{maskWalletForLeaderboard(entry.player)}</td>
                      <td>{fmtSol(lamportsToSol(entry.totalWonLamports))} SOL</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="alert alert--warning luck-game__disclaimer">
        ⚠️ A game of chance whose randomness is based on an on-chain blockhash. Like $LUCK itself,
        this game is for entertainment — only play with an amount you can afford to lose. The "game
        wallet" can only spend the spin balance you bought; it can never reach your real wallet or
        the vault.
      </div>
    </div>
  )
}
