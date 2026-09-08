import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { createToken, type TokenFormData, type CreateTokenResult } from '../lib/createToken'
import { uploadLogoAndMetadata } from '../lib/irys'
import { resizeImageFile } from '../lib/image'
import { DEFAULT_DECIMALS, FEE_WALLET, FEE_AMOUNT_SOL, type NetworkId } from '../config'
import { ResultCard } from './ResultCard'

// The upper bound on the raw (unprocessed) size of the chosen file — the file
// actually uploaded will be far smaller than this, because it is automatically
// scaled down and recompressed below (see src/lib/image.ts).
const MAX_RAW_LOGO_BYTES = 15 * 1024 * 1024

const initialState: TokenFormData = {
  name: '',
  symbol: '',
  decimals: DEFAULT_DECIMALS,
  supply: '1000000000',
  description: '',
  imageUri: '',
  website: '',
  twitter: '',
  telegram: '',
  revokeMint: false,
  revokeFreeze: false,
  immutable: false,
  confidentialTransferEnabled: false,
  sellLockEnabled: false,
}

interface Props {
  network: NetworkId
}

export function TokenForm({ network }: Props) {
  const { connection } = useConnection()
  const wallet = useWallet()

  const [form, setForm] = useState<TokenFormData>(initialState)
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [logoWarning, setLogoWarning] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<CreateTokenResult | null>(null)

  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!logoFile) {
      setLogoPreview('')
      return
    }
    const url = URL.createObjectURL(logoFile)
    setLogoPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [logoFile])

  function update<K extends keyof TokenFormData>(key: K, value: TokenFormData[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleLogoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file (PNG, JPG, SVG...).')
      return
    }
    if (file.size > MAX_RAW_LOGO_BYTES) {
      setError('The logo file must be smaller than 15MB.')
      return
    }
    setError('')
    setStatus('Preparing the logo (scaling it down)...')
    try {
      // To make the upload faster and more reliable we scale the image down to
      // a small logo size and recompress it — the original photo's size never
      // goes to the network.
      const resized = await resizeImageFile(file)
      setLogoFile(resized)
    } catch (err) {
      console.error('Logo scaling error:', err)
      // There used to be a fallback path here: if the processing failed but
      // the file was small, the ORIGINAL file was accepted as-is. But if the
      // processing failed it means the browser cannot decode that image in
      // the first place — the result was a broken preview and an "the image
      // could not be uploaded" error when creating the token. We do not
      // accept a file we cannot verify: either the selection works and the
      // preview appears, or we give a clear error.
      setLogoFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      const isHeic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
      setError(
        isHeic
          ? 'This image is in HEIC/HEIF format, which browsers cannot open. Convert it from your phone\'s gallery with "share/save as JPG" and try again.'
          : 'The image could not be opened. Try a screenshot or a plain PNG/JPG file; you can also leave the logo empty and still create the token.',
      )
    } finally {
      setStatus('')
    }
  }

  function validate(): string | null {
    if (!form.name.trim()) return 'The token name is required.'
    if (form.name.length > 32) return 'The token name cannot be longer than 32 characters.'
    if (!form.symbol.trim()) return 'The symbol (ticker) is required.'
    if (form.symbol.length > 10) return 'The symbol cannot be longer than 10 characters.'
    if (form.decimals < 0 || form.decimals > 9) return 'Decimals must be between 0 and 9.'
    if (!/^\d+$/.test(form.supply) || BigInt(form.supply) <= 0n) return 'Enter a valid supply amount.'
    return null
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLogoWarning('')
    setResult(null)

    if (!wallet.connected || !wallet.publicKey) {
      setError('Connect your wallet first to continue.')
      return
    }

    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)
    try {
      let imageUri = form.imageUri

      if (logoFile) {
        try {
          imageUri = await uploadLogoAndMetadata(
            logoFile,
            {
              name: form.name,
              symbol: form.symbol,
              description: form.description,
              website: form.website,
              twitter: form.twitter,
              telegram: form.telegram,
            },
            connection,
            wallet,
            network,
            setStatus,
          )
        } catch (logoErr) {
          // A failed logo upload does not block the token creation — the user
          // should still get their token and can add the logo later.
          console.error('Logo upload error:', logoErr)
          setLogoWarning(
            logoErr instanceof Error
              ? `The logo could not be uploaded; the token will be created without one: ${logoErr.message}`
              : 'The logo could not be uploaded; the token will be created without one.',
          )
        }
      }

      const res = await createToken(connection, wallet, { ...form, imageUri }, setStatus)
      setResult(res)
      setStatus('')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Something went wrong while creating the token.')
      setStatus('')
    } finally {
      setLoading(false)
    }
  }

  if (result) {
    return (
      <>
        {logoWarning && <div className="alert alert--warning">{logoWarning}</div>}
        <ResultCard
          result={result}
          network={network}
          onReset={() => {
            setResult(null)
            setLogoWarning('')
            setForm(initialState)
          }}
        />
      </>
    )
  }

  return (
    <form className="token-form" onSubmit={handleSubmit}>
      <h2>Token Details</h2>

      <div className="form-grid">
        <label className="field">
          <span>Token Name *</span>
          <input
            type="text"
            placeholder="e.g. My Token"
            value={form.name}
            maxLength={32}
            onChange={(e) => update('name', e.target.value)}
            required
          />
        </label>

        <label className="field">
          <span>Symbol *</span>
          <input
            type="text"
            placeholder="e.g. MYTK"
            value={form.symbol}
            maxLength={10}
            onChange={(e) => update('symbol', e.target.value.toUpperCase())}
            required
          />
        </label>

        <label className="field">
          <span>Decimals</span>
          <input
            type="number"
            min={0}
            max={9}
            value={form.decimals}
            onChange={(e) => update('decimals', Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span>Total Supply *</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="e.g. 1000000000"
            value={form.supply}
            onChange={(e) => update('supply', e.target.value.replace(/[^\d]/g, ''))}
            required
          />
        </label>
      </div>

      <label className="field">
        <span>Description</span>
        <textarea
          placeholder="A short description of your token"
          value={form.description}
          onChange={(e) => update('description', e.target.value)}
          rows={3}
        />
      </label>

      <div className="field">
        <span>Logo</span>
        <div className="logo-upload" onClick={() => fileInputRef.current?.click()}>
          {logoPreview ? (
            <img src={logoPreview} alt="Logo preview" className="logo-upload__preview" />
          ) : (
            <div className="logo-upload__placeholder">🖼️</div>
          )}
          <div className="logo-upload__text">
            {logoFile ? logoFile.name : 'Click to choose an image (any size — it is scaled down automatically)'}
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleLogoChange}
          hidden
        />

        <small>
          The image you choose is written permanently to the network for a small fee you approve in
          your wallet alongside the token creation — no need to sign up to a third-party site. If you
          leave it empty the token is still created fine, just without a logo.
        </small>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>Website</span>
          <input
            type="text"
            placeholder="https://..."
            value={form.website}
            onChange={(e) => update('website', e.target.value)}
          />
        </label>
        <label className="field">
          <span>Twitter / X</span>
          <input
            type="text"
            placeholder="https://x.com/..."
            value={form.twitter}
            onChange={(e) => update('twitter', e.target.value)}
          />
        </label>
        <label className="field">
          <span>Telegram</span>
          <input
            type="text"
            placeholder="https://t.me/..."
            value={form.telegram}
            onChange={(e) => update('telegram', e.target.value)}
          />
        </label>
      </div>

      <fieldset className="authorities">
        <legend>Advanced Authorities</legend>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.revokeMint}
            onChange={(e) => update('revokeMint', e.target.checked)}
          />
          <div>
            <strong>Revoke Mint Authority</strong>
            <small>After creation nobody, you included, can mint new tokens — the supply is fixed.</small>
          </div>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.revokeFreeze}
            onChange={(e) => update('revokeFreeze', e.target.checked)}
          />
          <div>
            <strong>Revoke Freeze Authority</strong>
            <small>Token accounts can no longer be frozen.</small>
          </div>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.immutable}
            onChange={(e) => update('immutable', e.target.checked)}
          />
          <div>
            <strong>Make Metadata Immutable</strong>
            <small>The name, symbol and metadata can never be updated again.</small>
          </div>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.confidentialTransferEnabled}
            disabled={form.sellLockEnabled}
            onChange={(e) => update('confidentialTransferEnabled', e.target.checked)}
          />
          <div>
            <strong>Confidential Amount Transfer (Confidential Transfer)</strong>
            <small>
              With Token-2022's official extension the AMOUNT transferred is kept encrypted on chain —
              the sender and recipient addresses always stay visible, only the amount is hidden. If you
              enable it the token is created with the Token-2022 standard; to use it you also have to
              configure your account from the "Confidential Amount Transfer" tab.
              {form.sellLockEnabled && ' (Disabled while Anti-Snipe Lock is on — the two are not combined.)'}
            </small>
          </div>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.sellLockEnabled}
            disabled={form.confidentialTransferEnabled}
            onChange={(e) => update('sellLockEnabled', e.target.checked)}
          />
          <div>
            <strong>Anti-Snipe Sell Lock</strong>
            <small>
              Creates the token with Token-2022's Transfer Hook extension bound to this site's own
              sell-lock program: once you create a liquidity pool for this token you can lock selling
              INTO that pool for a chosen window (15 min – 24 h) from the Liquidity Pool tab, right after
              the pool exists — buying is never affected. Enabling it makes the token Token-2022; it is
              not combined with Confidential Transfer.
              {form.confidentialTransferEnabled &&
                ' (Disabled while Confidential Transfer is on — the two are not combined.)'}
            </small>
          </div>
        </label>
      </fieldset>

      {FEE_WALLET && (
        <div className="fee-note">
          Service fee: <strong>{FEE_AMOUNT_SOL} SOL</strong> plus the network transaction fee. The fee
          is shown as part of the transaction you approve in your wallet.
        </div>
      )}

      {error && <div className="alert alert--error">{error}</div>}
      {logoWarning && !error && <div className="alert alert--warning">{logoWarning}</div>}
      {status && !error && <div className="alert alert--info">{status}</div>}

      <button type="submit" className="btn btn--primary btn--block" disabled={loading}>
        {loading ? 'Creating...' : wallet.connected ? 'Create Token' : 'Connect A Wallet First'}
      </button>
    </form>
  )
}
