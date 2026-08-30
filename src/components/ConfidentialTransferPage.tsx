import { useEffect, useState, type FormEvent } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token'
import { PubkeyValidityProofData } from '@solana/zk-sdk/bundler'
import { getMintInfo } from '../lib/raydium'
import { getTokenMetadata, type TokenMeta } from '../lib/tokenMetadata'
import { CoinPicker } from './CoinPicker'
import { TokenIcon } from './TokenIcon'
import { confirmBySignature, sendInstructions } from '../lib/sendTx'
import {
  buildApplyPendingBalanceIx,
  buildConfigureAccountIx,
  buildDepositIx,
  buildReallocateForConfidentialTransferIx,
  buildVerifyPubkeyValidityIx,
  decryptAeBalance,
  deriveConfidentialKeys,
  getConfidentialAccountState,
  getConfidentialTokenAccount,
  planConfidentialTransfer,
  type ConfidentialTransferPlan,
  type DerivedConfidentialKeys,
} from '../lib/confidentialTransfer'
import { NETWORKS, type NetworkId } from '../config'

interface Props {
  network: NetworkId
}

// The maximum number of pending deposits/transfers that can be accepted after an
// account is configured and before `ApplyPendingBalance` is called. We pick a
// high constant; the real limit is enforced on chain by the protocol.
const MAX_PENDING_BALANCE_CREDIT_COUNTER = 65536n

function fmtAmount(raw: bigint, decimals: number): string {
  return (Number(raw) / 10 ** decimals).toLocaleString('en-US')
}

async function sendTx(
  connection: Connection,
  wallet: WalletContextState,
  tx: Transaction,
  extraSigners: Keypair[] = [],
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error('The wallet is not connected.')
  // The shared, hardened path (see lib/sendTx.ts): a priority fee, periodic
  // rebroadcast, confirmation by HTTP polling, and timeouts.
  return sendInstructions(
    connection,
    { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction },
    tx.instructions,
    undefined,
    { extraSigners },
  )
}

/**
 * Sends every step of the confidential-transfer plan (several transactions).
 * If the wallet supports `signAllTransactions` (most wallets do, Phantom
 * included), ALL the transactions are signed under ONE wallet approval — the
 * user does not have to approve several times in a row. On wallets that do not
 * support it (rare), a signature is requested for each step separately.
 *
 * The transactions share the same blockhash and are sent in order (waiting for
 * the previous one to confirm), because later steps reference accounts the
 * earlier ones created on chain (the proof context accounts).
 */
async function sendConfidentialTransferPlan(
  connection: Connection,
  wallet: WalletContextState,
  plan: ConfidentialTransferPlan,
  onStatus: (msg: string) => void,
): Promise<string> {
  if (!wallet.publicKey) throw new Error('The wallet is not connected.')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()

  const txs = plan.steps.map((step) => {
    const tx = new Transaction().add(...step.instructions)
    tx.recentBlockhash = blockhash
    tx.feePayer = wallet.publicKey!
    if (step.extraSigners.length > 0) tx.partialSign(...step.extraSigners)
    return tx
  })

  let signedTxs: Transaction[]
  if (wallet.signAllTransactions) {
    onStatus('Waiting for approval in your wallet...')
    signedTxs = await wallet.signAllTransactions(txs)
  } else {
    if (!wallet.signTransaction) throw new Error('The wallet does not support signing transactions.')
    signedTxs = []
    for (let i = 0; i < txs.length; i++) {
      onStatus(`Step ${i + 1}/${txs.length}: waiting for wallet approval...`)
      signedTxs.push(await wallet.signTransaction(txs[i]))
    }
  }

  let lastSig = ''
  for (let i = 0; i < signedTxs.length; i++) {
    onStatus(`Step ${i + 1}/${signedTxs.length}: ${plan.steps[i].label}...`)
    const raw = signedTxs[i].serialize()
    // tx-path-exempt: every step is signed under ONE wallet approval
    // (signAllTransactions) and shares a common blockhash; because
    // sendInstructions is a single-transaction model, it would ask for a
    // separate approval per step. Confirmation still goes through the shared
    // HTTP polling (confirmBySignature) — the websocket subscription, which is
    // the real mobile risk, is not used here either.
    const signature = await connection.sendRawTransaction(raw, {
      skipPreflight: true,
      maxRetries: 5,
    })
    // Confirmation uses the shared HTTP polling, NOT `confirmTransaction`
    // (see lib/sendTx.ts). confirmTransaction opens a websocket subscription,
    // and on mobile, when the user switches apps to approve in the wallet,
    // that subscription silently drops — an error was shown even when the
    // transaction had landed. The polling also rebroadcasts the transaction
    // periodically.
    //
    // This flow cannot be moved to sendInstructions wholesale: every step is
    // signed under ONE wallet approval (signAllTransactions) and shares a
    // common blockhash. Because sendInstructions is a single-transaction
    // model, it would ask for a separate approval per step.
    const outcome = await confirmBySignature(
      connection,
      signature,
      raw,
      lastValidBlockHeight,
      (s) => onStatus(`Step ${i + 1}/${signedTxs.length}: ${s}`),
    )
    if (outcome.kind === 'failed') {
      throw new Error(
        `Step ${i + 1} failed on chain: ${JSON.stringify(outcome.err)}`,
      )
    }
    if (outcome.kind === 'expired') {
      throw new Error(
        `Step ${i + 1} did not land in time. If the earlier steps completed, check ` +
          'your balance before starting the operation over.',
      )
    }
    lastSig = signature
  }
  return lastSig
}

/**
 * A standalone section for the receiving side: someone preparing to receive
 * tokens confidentially sets up their account here with THEIR OWN wallet. It is
 * deliberately kept apart from the "Sender" flow below — the two used to share
 * the same state (Select Coin -> Use Coin -> a conditional Configure Account ->
 * immediately followed by a "Send" form), which was confusing for users who only
 * wanted to receive.
 */
function RecipientAccountSetup({ network }: { network: NetworkId }) {
  const { connection } = useConnection()
  const wallet = useWallet()

  const [mintAddr, setMintAddr] = useState('')
  const [meta, setMeta] = useState<TokenMeta | null>(null)
  const [busy, setBusy] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [txSig, setTxSig] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!mintAddr) {
      setMeta(null)
      return
    }
    let cancelled = false
    try {
      getTokenMetadata(connection, new PublicKey(mintAddr)).then((m) => {
        if (!cancelled) setMeta(m)
      })
    } catch {
      setMeta(null)
    }
    return () => {
      cancelled = true
    }
  }, [connection, mintAddr])

  function selectMint(addr: string) {
    setMintAddr(addr)
    setConfigured(false)
    setTxSig('')
    setError('')
  }

  async function handleSetup() {
    if (!wallet.connected || !wallet.publicKey) {
      setError('Connect your wallet first to continue.')
      return
    }
    const addr = mintAddr.trim()
    if (!addr) {
      setError('Select a coin or enter a mint address.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const mintInfo = await getMintInfo(connection, addr)
      if (mintInfo.programId !== TOKEN_2022_PROGRAM_ID.toBase58()) {
        throw new Error(
          'This mint is not Token-2022. Confidential amount transfers only work with tokens created using the "Confidential Amount Transfer" option.',
        )
      }
      const mint = new PublicKey(addr)
      const ata = getConfidentialTokenAccount(mint, wallet.publicKey)
      const keys = await deriveConfidentialKeys(wallet, ata)

      let alreadyConfigured = false
      try {
        const state = await getConfidentialAccountState(connection, ata)
        alreadyConfigured = state.approved
      } catch {
        alreadyConfigured = false
      }

      if (alreadyConfigured) {
        setConfigured(true)
        return
      }

      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        ata,
        wallet.publicKey,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )
      const reallocIx = buildReallocateForConfidentialTransferIx(ata, wallet.publicKey, wallet.publicKey)
      const proofData = new PubkeyValidityProofData(keys.elgamal)
      const proofIx = buildVerifyPubkeyValidityIx(proofData.toBytes())
      const decryptableZeroBalance = keys.ae.encrypt(0n).toBytes()
      const configureIx = buildConfigureAccountIx(
        ata,
        mint,
        wallet.publicKey,
        decryptableZeroBalance,
        MAX_PENDING_BALANCE_CREDIT_COUNTER,
      )
      const tx = new Transaction().add(createAtaIx, reallocIx, proofIx, configureIx)
      const sig = await sendTx(connection, wallet, tx)
      setTxSig(sig)
      setConfigured(true)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Something went wrong while configuring the account.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pool-manage__section" style={{ marginTop: 20 }}>
      <div className="pool-manage__section-title">Receiver: Configure Account</div>
      <p className="subtab-desc">
        If you are preparing to receive tokens confidentially, you first have to set up your
        account for that token with YOUR OWN wallet. Just select the token you will receive and
        press "Configure Account" — you do not need to enter an amount or already hold the token.
      </p>
      <CoinPicker token2022Only explorerCluster={NETWORKS[network].explorerCluster} onSelect={selectMint} />
      {mintAddr && (
        <div className="selected-coin" style={{ marginBottom: 12 }}>
          <TokenIcon image={meta?.image} symbol={meta?.symbol} size={28} />
          <div className="selected-coin__info">
            <span className="selected-coin__symbol">{meta ? `${meta.name} (${meta.symbol})` : 'Selected Coin'}</span>
            <code className="selected-coin__addr">{mintAddr}</code>
          </div>
        </div>
      )}
      {error && <div className="alert alert--error">{error}</div>}
      {configured ? (
        <div className="alert alert--info">
          ✅ Your account is ready to receive confidential transfers.{txSig && <> Transaction: <code>{txSig}</code></>}
        </div>
      ) : (
        mintAddr && (
          <button type="button" className="btn btn--primary" onClick={handleSetup} disabled={busy}>
            {busy ? 'Configuring...' : 'Configure Account'}
          </button>
        )
      )}
    </div>
  )
}

export function ConfidentialTransferPage({ network }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()

  const [mintAddr, setMintAddr] = useState('')
  const [selectedMeta, setSelectedMeta] = useState<TokenMeta | null>(null)

  // The account status for the selected coin
  const [decimals, setDecimals] = useState<number | null>(null)
  const [tokenAccount, setTokenAccount] = useState<PublicKey | null>(null)
  const [keys, setKeys] = useState<DerivedConfidentialKeys | null>(null)
  const [accountConfigured, setAccountConfigured] = useState<boolean | null>(null)
  const [currentBalance, setCurrentBalance] = useState<bigint | null>(null)
  const [checkingAccount, setCheckingAccount] = useState(false)

  const [configureBusy, setConfigureBusy] = useState(false)
  const [configureTx, setConfigureTx] = useState('')

  const [depositAmount, setDepositAmount] = useState('')
  const [depositBusy, setDepositBusy] = useState(false)
  const [depositTx, setDepositTx] = useState('')
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyTx, setApplyTx] = useState('')

  const [sendAmount, setSendAmount] = useState('')
  const [recipientAddr, setRecipientAddr] = useState('')
  const [sendBusy, setSendBusy] = useState(false)
  const [sendStatus, setSendStatus] = useState('')
  const [sendTxSig, setSendTxSig] = useState('')

  const [error, setError] = useState('')

  useEffect(() => {
    if (!mintAddr) {
      setSelectedMeta(null)
      return
    }
    let cancelled = false
    try {
      getTokenMetadata(connection, new PublicKey(mintAddr)).then((meta) => {
        if (!cancelled) setSelectedMeta(meta)
      })
    } catch {
      setSelectedMeta(null)
    }
    return () => {
      cancelled = true
    }
  }, [connection, mintAddr])

  function resetMintState() {
    setDecimals(null)
    setTokenAccount(null)
    setKeys(null)
    setAccountConfigured(null)
    setCurrentBalance(null)
    setConfigureTx('')
    setDepositAmount('')
    setDepositTx('')
    setApplyTx('')
    setSendAmount('')
    setRecipientAddr('')
    setSendTxSig('')
    setError('')
  }

  function selectMint(addr: string) {
    resetMintState()
    setMintAddr(addr)
  }

  async function refreshBalance(ata: PublicKey, derivedKeys: DerivedConfidentialKeys) {
    try {
      const state = await getConfidentialAccountState(connection, ata)
      setAccountConfigured(state.approved)
      if (state.approved) {
        setCurrentBalance(decryptAeBalance(derivedKeys.ae, state.decryptableAvailableBalance))
      }
    } catch {
      setAccountConfigured(false)
      setCurrentBalance(null)
    }
  }

  async function handleCheckAccount(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!wallet.connected || !wallet.publicKey) {
      setError('Connect your wallet first to continue.')
      return
    }
    const addr = mintAddr.trim()
    if (!addr) {
      setError('Select a coin or enter a mint address.')
      return
    }
    setCheckingAccount(true)
    try {
      const mintInfo = await getMintInfo(connection, addr)
      if (mintInfo.programId !== TOKEN_2022_PROGRAM_ID.toBase58()) {
        throw new Error(
          'This mint is not Token-2022. Confidential amount transfers only work with tokens created using the "Confidential Amount Transfer" option.',
        )
      }
      setDecimals(mintInfo.decimals)

      const mint = new PublicKey(addr)
      const ata = getConfidentialTokenAccount(mint, wallet.publicKey)
      setTokenAccount(ata)

      const derivedKeys = await deriveConfidentialKeys(wallet, ata)
      setKeys(derivedKeys)

      await refreshBalance(ata, derivedKeys)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Something went wrong while checking the account.')
    } finally {
      setCheckingAccount(false)
    }
  }

  async function handleConfigure() {
    if (!keys || !tokenAccount || !wallet.publicKey) return
    setError('')
    setConfigureBusy(true)
    try {
      const mint = new PublicKey(mintAddr.trim())
      // The "idempotent" version: if the account already exists it does nothing
      // and does not error — and for someone who has never held this token (e.g.
      // a receiver only preparing to receive) it creates the account here.
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        tokenAccount,
        wallet.publicKey,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      )
      const reallocIx = buildReallocateForConfidentialTransferIx(tokenAccount, wallet.publicKey, wallet.publicKey)
      const proofData = new PubkeyValidityProofData(keys.elgamal)
      const proofIx = buildVerifyPubkeyValidityIx(proofData.toBytes())
      const decryptableZeroBalance = keys.ae.encrypt(0n).toBytes()
      const configureIx = buildConfigureAccountIx(
        tokenAccount,
        mint,
        wallet.publicKey,
        decryptableZeroBalance,
        MAX_PENDING_BALANCE_CREDIT_COUNTER,
      )
      // The order matters: proofIx must come immediately before configureIx.
      const tx = new Transaction().add(createAtaIx, reallocIx, proofIx, configureIx)
      const sig = await sendTx(connection, wallet, tx)
      setConfigureTx(sig)
      setAccountConfigured(true)
      setCurrentBalance(0n)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Something went wrong while configuring the account.')
    } finally {
      setConfigureBusy(false)
    }
  }

  async function handleDeposit() {
    if (!keys || !tokenAccount || decimals === null || !wallet.publicKey) return
    setError('')
    if (!depositAmount || Number(depositAmount) <= 0) {
      setError('Enter a valid amount.')
      return
    }
    setDepositBusy(true)
    try {
      const mint = new PublicKey(mintAddr.trim())
      const amountRaw = BigInt(Math.round(Number(depositAmount) * 10 ** decimals))
      const ix = buildDepositIx(tokenAccount, mint, wallet.publicKey, amountRaw, decimals)
      const tx = new Transaction().add(ix)
      const sig = await sendTx(connection, wallet, tx)
      setDepositTx(sig)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'The deposit failed.')
    } finally {
      setDepositBusy(false)
    }
  }

  async function handleApplyPendingBalance() {
    if (!keys || !tokenAccount || !wallet.publicKey) return
    setError('')
    setApplyBusy(true)
    try {
      const state = await getConfidentialAccountState(connection, tokenAccount)
      const currentDecrypted = decryptAeBalance(keys.ae, state.decryptableAvailableBalance)
      const depositedRaw =
        decimals !== null && depositAmount ? BigInt(Math.round(Number(depositAmount) * 10 ** decimals)) : 0n
      const newBalance = currentDecrypted + depositedRaw
      const newDecryptableBalance = keys.ae.encrypt(newBalance).toBytes()
      const ix = buildApplyPendingBalanceIx(
        tokenAccount,
        wallet.publicKey,
        state.pendingBalanceCreditCounter,
        newDecryptableBalance,
      )
      const tx = new Transaction().add(ix)
      const sig = await sendTx(connection, wallet, tx)
      setApplyTx(sig)
      setCurrentBalance(newBalance)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Something went wrong while applying the pending balance.')
    } finally {
      setApplyBusy(false)
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault()
    if (!keys || !tokenAccount || decimals === null || !wallet.publicKey) return
    setError('')
    if (!sendAmount || Number(sendAmount) <= 0) {
      setError('Enter a valid amount.')
      return
    }
    let recipientPubkey: PublicKey
    try {
      recipientPubkey = new PublicKey(recipientAddr.trim())
    } catch {
      setError('Invalid recipient wallet address.')
      return
    }
    setSendBusy(true)
    try {
      const mint = new PublicKey(mintAddr.trim())
      const recipientAta = getConfidentialTokenAccount(mint, recipientPubkey)

      let recipientState
      try {
        recipientState = await getConfidentialAccountState(connection, recipientAta)
      } catch {
        throw new Error(
          'The recipient has no account for this token, or it is not configured for confidential transfers. They first have to run the "Use Coin" + "Configure Account" steps for this mint address with their own wallet.',
        )
      }
      if (!recipientState.approved) {
        throw new Error('The recipient\'s account has not been approved yet.')
      }

      const sourceState = await getConfidentialAccountState(connection, tokenAccount)
      const amountRaw = BigInt(Math.round(Number(sendAmount) * 10 ** decimals))

      setSendStatus('Preparing the confidential-transfer proofs...')
      const plan = await planConfidentialTransfer(
        connection,
        tokenAccount,
        mint,
        recipientAta,
        wallet.publicKey,
        keys,
        sourceState.availableBalance,
        sourceState.decryptableAvailableBalance,
        recipientState.elgamalPubkey,
        amountRaw,
      )

      // Each proof is verified in its own transaction (see the note in
      // planConfidentialTransfer — they do not all fit in one) — but they are all
      // signed under ONE wallet approval (see sendConfidentialTransferPlan).
      const lastSig = await sendConfidentialTransferPlan(connection, wallet, plan, setSendStatus)

      setSendTxSig(lastSig)
      setCurrentBalance(plan.newDecryptedBalance)
      setSendAmount('')
      setSendStatus('')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'The confidential transfer failed.')
      setSendStatus('')
    } finally {
      setSendBusy(false)
    }
  }

  return (
    <div className="token-form">
      <h2>Confidential Amount Transfer (Confidential Transfer)</h2>
      <p className="subtab-desc">
        Uses Token-2022's official <strong>Confidential Transfer</strong> extension: the AMOUNT
        transferred is kept encrypted on chain and is not visible on explorers such as Solscan.{' '}
        <strong>The sender and recipient addresses are always public</strong> — this is not an
        identity-hiding mixer, it only hides the amount.
      </p>
      <div className="alert alert--warning">
        ⚠️ Test only on <strong>Devnet</strong>, with a token created using the "Confidential Amount
        Transfer" option. The recipient you want to send to confidentially must also have configured
        their own account for the same token from this page beforehand.
      </div>

      <RecipientAccountSetup network={network} />

      <hr className="pool-manage__divider" />

      {!mintAddr && (
        <div className="pool-manage__section" style={{ marginTop: 20 }}>
          <div className="pool-manage__section-title">Sender: Select Coin</div>
          <p className="subtab-desc">
            Select the coin you want to send — this is the case where you already hold the token and
            want to send it to someone confidentially.
          </p>
          <CoinPicker
            token2022Only
            explorerCluster={NETWORKS[network].explorerCluster}
            onSelect={selectMint}
          />
        </div>
      )}

      {mintAddr && (
        <div className="pool-manage__section" style={{ marginTop: 20 }}>
          <div className="selected-coin">
            <TokenIcon image={selectedMeta?.image} symbol={selectedMeta?.symbol} size={28} />
            <div className="selected-coin__info">
              <span className="selected-coin__symbol">
                {selectedMeta ? `${selectedMeta.name} (${selectedMeta.symbol})` : 'Selected Coin'}
              </span>
              <code className="selected-coin__addr">{mintAddr}</code>
            </div>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                resetMintState()
                setMintAddr('')
              }}
            >
              Change
            </button>
          </div>

          {!keys && (
            <form onSubmit={handleCheckAccount} style={{ marginTop: 12 }}>
              <button type="submit" className="btn btn--primary" disabled={checkingAccount}>
                {checkingAccount ? 'Checking...' : 'Use Coin'}
              </button>
            </form>
          )}
        </div>
      )}

      {error && (
        <div className="alert alert--error" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}

      {keys && tokenAccount && accountConfigured === false && (
        <div className="pool-manage__section" style={{ marginTop: 20 }}>
          <div className="pool-manage__section-title">Configure Account</div>
          <p className="subtab-desc">
            Your account for this token is not configured for confidential transfers yet. A one-off
            configuration is needed before you can continue.
          </p>
          <button type="button" className="btn btn--primary" onClick={handleConfigure} disabled={configureBusy}>
            {configureBusy ? 'Configuring...' : 'Configure Account'}
          </button>
          {configureTx && <div className="alert alert--info">Configured ✓ Transaction: {configureTx}</div>}
        </div>
      )}

      {keys && tokenAccount && accountConfigured && (
        <>
          <div className="pool-manage__section" style={{ marginTop: 20 }}>
            <div className="pool-manage__section-title">
              Your Confidential Balance
              <small className="pool-manage__balance-hint">
                {' '}
                {currentBalance !== null && decimals !== null ? fmtAmount(currentBalance, decimals) : '...'} token
              </small>
            </div>
          </div>

          <form onSubmit={handleSend} className="pool-manage__section" style={{ marginTop: 20 }}>
            <div className="pool-manage__section-title">Send Confidentially</div>
            <p className="subtab-desc">
              The recipient must have configured their account for this token from this page beforehand.
            </p>
            <label className="field">
              <span>Recipient Wallet Address</span>
              <input
                type="text"
                placeholder="The recipient's Solana wallet address"
                value={recipientAddr}
                onChange={(e) => setRecipientAddr(e.target.value)}
              />
            </label>
            <div className="pool-manage__amount-row">
              <input
                type="text"
                inputMode="decimal"
                placeholder="The amount to send"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value.replace(/[^\d.]/g, ''))}
              />
            </div>
            <p className="subtab-desc">
              Because of Solana's transaction size limit this operation consists of several separate
              transactions behind the scenes — on most wallets (Phantom included) a single approval is
              enough.
            </p>
            <button type="submit" className="btn btn--primary pool-manage__action-btn" disabled={sendBusy}>
              {sendBusy ? 'Sending...' : 'Send Confidentially'}
            </button>
            {sendStatus && <div className="alert alert--info" style={{ marginTop: 12 }}>{sendStatus}</div>}
            {sendTxSig && (
              <div className="alert alert--info" style={{ marginTop: 12 }}>
                🔒 Sent. Transaction: <code>{sendTxSig}</code>
              </div>
            )}
          </form>

          <div className="pool-manage__section" style={{ marginTop: 20 }}>
            <div className="pool-manage__section-title">Deposit From Your Public Balance</div>
            <p className="subtab-desc">
              If you want to move more from your ordinary (public) balance into your confidential balance.
            </p>
            <div className="pool-manage__amount-row">
              <input
                type="text"
                inputMode="decimal"
                placeholder="e.g. 100"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value.replace(/[^\d.]/g, ''))}
              />
            </div>
            <button
              type="button"
              className="btn btn--secondary pool-manage__action-btn"
              onClick={handleDeposit}
              disabled={depositBusy || !!depositTx}
            >
              {depositBusy ? 'Depositing...' : depositTx ? 'Deposited ✓' : 'Deposit'}
            </button>
            {depositTx && (
              <button
                type="button"
                className="btn btn--primary pool-manage__action-btn"
                onClick={handleApplyPendingBalance}
                disabled={applyBusy || !!applyTx}
                style={{ marginTop: 8 }}
              >
                {applyBusy ? 'Applying...' : applyTx ? 'Pending Balance Applied ✓' : 'Apply Pending Balance'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
