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

// Bir hesap yapılandırıldıktan sonra, `ApplyPendingBalance` çağrılmadan önce
// kabul edilebilecek azami bekleyen (pending) yatırım/transfer sayısı.
// Yüksek bir sabit seçiyoruz; asıl sınır zincirde protokol tarafından kontrol ediliyor.
const MAX_PENDING_BALANCE_CREDIT_COUNTER = 65536n

function fmtAmount(raw: bigint, decimals: number): string {
  return (Number(raw) / 10 ** decimals).toLocaleString('tr-TR')
}

async function sendTx(
  connection: Connection,
  wallet: WalletContextState,
  tx: Transaction,
  extraSigners: Keypair[] = [],
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) throw new Error('Cüzdan bağlı değil.')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = wallet.publicKey
  if (extraSigners.length > 0) tx.partialSign(...extraSigners)
  const signed = await wallet.signTransaction(tx)
  const signature = await connection.sendRawTransaction(signed.serialize())
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  return signature
}

/**
 * Gizli transfer planındaki (birden çok transaction) tüm adımları gönderir.
 * Cüzdan `signAllTransactions` destekliyorsa (Phantom dahil çoğu cüzdan),
 * TÜM transaction'lar TEK bir cüzdan onayında imzalanır — kullanıcı art
 * arda birden çok kez onay vermek zorunda kalmaz. Desteklemeyen cüzdanlarda
 * (nadir), her adım için ayrı ayrı imza istenir.
 *
 * Transaction'lar aynı blockhash'i paylaşır ve sırayla (bir öncekinin
 * onaylanmasını bekleyerek) gönderilir — çünkü sonraki adımlar bir öncekinin
 * zincirde oluşturduğu hesaplara (proof context hesapları) referans verir.
 */
async function sendConfidentialTransferPlan(
  connection: Connection,
  wallet: WalletContextState,
  plan: ConfidentialTransferPlan,
  onStatus: (msg: string) => void,
): Promise<string> {
  if (!wallet.publicKey) throw new Error('Cüzdan bağlı değil.')
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
    onStatus('Cüzdanınızda onay bekleniyor...')
    signedTxs = await wallet.signAllTransactions(txs)
  } else {
    if (!wallet.signTransaction) throw new Error('Cüzdan işlem imzalamayı desteklemiyor.')
    signedTxs = []
    for (let i = 0; i < txs.length; i++) {
      onStatus(`Adım ${i + 1}/${txs.length}: cüzdan onayı bekleniyor...`)
      signedTxs.push(await wallet.signTransaction(txs[i]))
    }
  }

  let lastSig = ''
  for (let i = 0; i < signedTxs.length; i++) {
    onStatus(`Adım ${i + 1}/${signedTxs.length}: ${plan.steps[i].label}...`)
    const signature = await connection.sendRawTransaction(signedTxs[i].serialize())
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    lastSig = signature
  }
  return lastSig
}

/**
 * Alıcı tarafı için bağımsız bir bölüm: birinden gizlice token almaya
 * hazırlanan biri, KENDİ cüzdanıyla bu bölümden hesabını hazırlar. Aşağıdaki
 * "Gönderici" akışından kasıtlı olarak ayrı tutuluyor — daha önce ikisi aynı
 * state'i paylaştığı için (Coin Seç → Coin'i Kullan → koşullu Hesabı
 * Yapılandır → hemen ardından bir "Gönder" formu) yalnızca almak isteyen
 * kullanıcılar için kafa karıştırıcıydı.
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
      setError('Devam etmek için önce cüzdanınızı bağlayın.')
      return
    }
    const addr = mintAddr.trim()
    if (!addr) {
      setError('Bir coin seçin ya da mint adresi girin.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const mintInfo = await getMintInfo(connection, addr)
      if (mintInfo.programId !== TOKEN_2022_PROGRAM_ID.toBase58()) {
        throw new Error(
          'Bu mint Token-2022 değil. Gizli miktar transferi yalnızca "Gizli Miktar Transferi" seçeneğiyle oluşturulmuş token\'larda çalışır.',
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
      setError(err instanceof Error ? err.message : 'Hesap yapılandırılırken bir hata oluştu.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pool-manage__section" style={{ marginTop: 20 }}>
      <div className="pool-manage__section-title">Alıcı: Hesap Yapılandırma</div>
      <p className="subtab-desc">
        Birinden gizlice token almaya hazırlanıyorsanız, önce KENDİ cüzdanınızla bu token için
        hesabınızı hazırlamanız gerekir. Alacağınız token'ı seçip "Hesabı Yapılandır"a basmanız
        yeterli — miktar belirtmenize ya da bu token'dan sahip olmanıza gerek yok.
      </p>
      <CoinPicker token2022Only explorerCluster={NETWORKS[network].explorerCluster} onSelect={selectMint} />
      {mintAddr && (
        <div className="selected-coin" style={{ marginBottom: 12 }}>
          <TokenIcon image={meta?.image} symbol={meta?.symbol} size={28} />
          <div className="selected-coin__info">
            <span className="selected-coin__symbol">{meta ? `${meta.name} (${meta.symbol})` : 'Seçili Coin'}</span>
            <code className="selected-coin__addr">{mintAddr}</code>
          </div>
        </div>
      )}
      {error && <div className="alert alert--error">{error}</div>}
      {configured ? (
        <div className="alert alert--info">
          ✅ Hesabınız gizli transfer almaya hazır.{txSig && <> İşlem: <code>{txSig}</code></>}
        </div>
      ) : (
        mintAddr && (
          <button type="button" className="btn btn--primary" onClick={handleSetup} disabled={busy}>
            {busy ? 'Yapılandırılıyor...' : 'Hesabı Yapılandır'}
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

  // Seçilen coin için hesap durumu
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
      setError('Devam etmek için önce cüzdanınızı bağlayın.')
      return
    }
    const addr = mintAddr.trim()
    if (!addr) {
      setError('Bir coin seçin ya da mint adresi girin.')
      return
    }
    setCheckingAccount(true)
    try {
      const mintInfo = await getMintInfo(connection, addr)
      if (mintInfo.programId !== TOKEN_2022_PROGRAM_ID.toBase58()) {
        throw new Error(
          'Bu mint Token-2022 değil. Gizli miktar transferi yalnızca "Gizli Miktar Transferi" seçeneğiyle oluşturulmuş token\'larda çalışır.',
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
      setError(err instanceof Error ? err.message : 'Hesap kontrol edilirken bir hata oluştu.')
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
      // "idempotent" versiyon: hesap zaten varsa hiçbir şey yapmaz, hata
      // vermez — bu token'dan daha önce hiç sahip olmamış biri (ör. sadece
      // gizlice almaya hazırlanan bir alıcı) için de hesabı burada oluşturur.
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
      // Sıra önemli: proofIx, configureIx'ten hemen önce olmalı.
      const tx = new Transaction().add(createAtaIx, reallocIx, proofIx, configureIx)
      const sig = await sendTx(connection, wallet, tx)
      setConfigureTx(sig)
      setAccountConfigured(true)
      setCurrentBalance(0n)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Hesap yapılandırılırken bir hata oluştu.')
    } finally {
      setConfigureBusy(false)
    }
  }

  async function handleDeposit() {
    if (!keys || !tokenAccount || decimals === null || !wallet.publicKey) return
    setError('')
    if (!depositAmount || Number(depositAmount) <= 0) {
      setError('Geçerli bir miktar girin.')
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
      setError(err instanceof Error ? err.message : 'Yatırma işlemi başarısız oldu.')
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
      setError(err instanceof Error ? err.message : 'Bekleyen bakiye uygulanırken bir hata oluştu.')
    } finally {
      setApplyBusy(false)
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault()
    if (!keys || !tokenAccount || decimals === null || !wallet.publicKey) return
    setError('')
    if (!sendAmount || Number(sendAmount) <= 0) {
      setError('Geçerli bir miktar girin.')
      return
    }
    let recipientPubkey: PublicKey
    try {
      recipientPubkey = new PublicKey(recipientAddr.trim())
    } catch {
      setError('Geçersiz alıcı cüzdan adresi.')
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
          'Alıcının bu token için hesabı yok ya da gizli transfere yapılandırılmamış. Alıcının önce kendi cüzdanıyla bu mint adresi için "Coin\'i Kullan" + "Hesabı Yapılandır" adımlarını çalıştırması gerekiyor.',
        )
      }
      if (!recipientState.approved) {
        throw new Error('Alıcının hesabı henüz onaylanmamış.')
      }

      const sourceState = await getConfidentialAccountState(connection, tokenAccount)
      const amountRaw = BigInt(Math.round(Number(sendAmount) * 10 ** decimals))

      setSendStatus('Gizli transfer ispatları hazırlanıyor...')
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

      // Her ispat kendi transaction'ında doğrulanıyor (bkz. planConfidentialTransfer'daki
      // açıklama — hepsi tek transaction'a sığmıyor) — ama hepsi TEK bir cüzdan
      // onayında imzalanıyor (bkz. sendConfidentialTransferPlan).
      const lastSig = await sendConfidentialTransferPlan(connection, wallet, plan, setSendStatus)

      setSendTxSig(lastSig)
      setCurrentBalance(plan.newDecryptedBalance)
      setSendAmount('')
      setSendStatus('')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Gizli transfer başarısız oldu.')
      setSendStatus('')
    } finally {
      setSendBusy(false)
    }
  }

  return (
    <div className="token-form">
      <h2>Gizli Miktar Transferi (Confidential Transfer)</h2>
      <p className="subtab-desc">
        Token-2022'nin resmi <strong>Confidential Transfer</strong> uzantısını kullanır: transfer
        edilen MİKTAR zincirde şifreli tutulur, Solscan gibi gezginlerde görünmez.{' '}
        <strong>Gönderen/alıcı adresleri her zaman açıktır</strong> — bu, kimlik gizleyen bir mixer
        değildir, sadece tutarı gizler.
      </p>
      <div className="alert alert--warning">
        ⚠️ Yalnızca <strong>Devnet</strong>'te, "Gizli Miktar Transferi" seçeneğiyle oluşturulmuş bir
        token ile test edin. Gizli göndermek istediğiniz alıcının da, aynı token için önceden bu
        sayfadan kendi hesabını yapılandırmış olması gerekir.
      </div>

      <RecipientAccountSetup network={network} />

      <hr className="pool-manage__divider" />

      {!mintAddr && (
        <div className="pool-manage__section" style={{ marginTop: 20 }}>
          <div className="pool-manage__section-title">Gönderici: Coin Seç</div>
          <p className="subtab-desc">
            Göndermek istediğiniz coin'i seçin — bu, halihazırda bu token'dan sahip olduğunuz ve
            gizlice birine göndermek istediğiniz durumdur.
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
                {selectedMeta ? `${selectedMeta.name} (${selectedMeta.symbol})` : 'Seçili Coin'}
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
              Değiştir
            </button>
          </div>

          {!keys && (
            <form onSubmit={handleCheckAccount} style={{ marginTop: 12 }}>
              <button type="submit" className="btn btn--primary" disabled={checkingAccount}>
                {checkingAccount ? 'Kontrol Ediliyor...' : "Coin'i Kullan"}
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
          <div className="pool-manage__section-title">Hesabı Yapılandır</div>
          <p className="subtab-desc">
            Bu token hesabınız henüz gizli transfer için yapılandırılmamış. Devam etmeden önce bir
            kerelik yapılandırma gerekiyor.
          </p>
          <button type="button" className="btn btn--primary" onClick={handleConfigure} disabled={configureBusy}>
            {configureBusy ? 'Yapılandırılıyor...' : 'Hesabı Yapılandır'}
          </button>
          {configureTx && <div className="alert alert--info">Yapılandırıldı ✓ İşlem: {configureTx}</div>}
        </div>
      )}

      {keys && tokenAccount && accountConfigured && (
        <>
          <div className="pool-manage__section" style={{ marginTop: 20 }}>
            <div className="pool-manage__section-title">
              Gizli Bakiyeniz
              <small className="pool-manage__balance-hint">
                {' '}
                {currentBalance !== null && decimals !== null ? fmtAmount(currentBalance, decimals) : '...'} token
              </small>
            </div>
          </div>

          <form onSubmit={handleSend} className="pool-manage__section" style={{ marginTop: 20 }}>
            <div className="pool-manage__section-title">Gizlice Gönder</div>
            <p className="subtab-desc">
              Alıcının, bu token için hesabını daha önce bu sayfadan yapılandırmış olması gerekir.
            </p>
            <label className="field">
              <span>Alıcı Cüzdan Adresi</span>
              <input
                type="text"
                placeholder="Alıcının Solana cüzdan adresi"
                value={recipientAddr}
                onChange={(e) => setRecipientAddr(e.target.value)}
              />
            </label>
            <div className="pool-manage__amount-row">
              <input
                type="text"
                inputMode="decimal"
                placeholder="Gönderilecek miktar"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value.replace(/[^\d.]/g, ''))}
              />
            </div>
            <p className="subtab-desc">
              Bu işlem, Solana'nın işlem boyutu sınırı nedeniyle arka planda birkaç ayrı
              transaction'dan oluşur — çoğu cüzdanda (Phantom dahil) tek bir onay yeterlidir.
            </p>
            <button type="submit" className="btn btn--primary pool-manage__action-btn" disabled={sendBusy}>
              {sendBusy ? 'Gönderiliyor...' : 'Gizlice Gönder'}
            </button>
            {sendStatus && <div className="alert alert--info" style={{ marginTop: 12 }}>{sendStatus}</div>}
            {sendTxSig && (
              <div className="alert alert--info" style={{ marginTop: 12 }}>
                🔒 Gönderildi. İşlem: <code>{sendTxSig}</code>
              </div>
            )}
          </form>

          <div className="pool-manage__section" style={{ marginTop: 20 }}>
            <div className="pool-manage__section-title">Herkese Açık Bakiyeden Yatır</div>
            <p className="subtab-desc">
              Normal (herkese açık) bakiyenizden gizli bakiyeye ek yatırım yapmak isterseniz.
            </p>
            <div className="pool-manage__amount-row">
              <input
                type="text"
                inputMode="decimal"
                placeholder="ör. 100"
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
              {depositBusy ? 'Yatırılıyor...' : depositTx ? 'Yatırıldı ✓' : 'Yatır'}
            </button>
            {depositTx && (
              <button
                type="button"
                className="btn btn--primary pool-manage__action-btn"
                onClick={handleApplyPendingBalance}
                disabled={applyBusy || !!applyTx}
                style={{ marginTop: 8 }}
              >
                {applyBusy ? 'Uygulanıyor...' : applyTx ? 'Bekleyen Bakiye Uygulandı ✓' : 'Bekleyen Bakiyeyi Uygula'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
