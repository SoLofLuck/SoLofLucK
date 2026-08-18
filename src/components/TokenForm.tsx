import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { createToken, type TokenFormData, type CreateTokenResult } from '../lib/createToken'
import { uploadLogoAndMetadata } from '../lib/irys'
import { resizeImageFile } from '../lib/image'
import { DEFAULT_DECIMALS, FEE_WALLET, FEE_AMOUNT_SOL, type NetworkId } from '../config'
import { ResultCard } from './ResultCard'

// Seçilen dosyanın ham (işlenmemiş) boyutu için üst sınır — asıl yüklenen
// dosya bundan çok daha küçük olacak çünkü aşağıda otomatik olarak
// küçültülüp yeniden sıkıştırılıyor (bkz. src/lib/image.ts).
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
      setError('Lütfen bir görsel dosyası seçin (PNG, JPG, SVG...).')
      return
    }
    if (file.size > MAX_RAW_LOGO_BYTES) {
      setError('Logo dosyası 15MB\'tan küçük olmalıdır.')
      return
    }
    setError('')
    setStatus('Logo hazırlanıyor (küçültülüyor)...')
    try {
      // Yükleme hızını ve güvenilirliğini artırmak için görseli küçük bir
      // logo boyutuna indirip yeniden sıkıştırıyoruz — orijinal fotoğraf
      // boyutu ağa hiç gitmiyor.
      const resized = await resizeImageFile(file)
      setLogoFile(resized)
    } catch (err) {
      console.error('Logo küçültme hatası:', err)
      if (file.size <= 300 * 1024) {
        // Küçültme başarısız oldu ama dosya zaten küçük, olduğu gibi kullanılabilir.
        setLogoFile(file)
      } else {
        setError('Görsel işlenemedi. Lütfen daha küçük/basit bir görsel deneyin.')
      }
    } finally {
      setStatus('')
    }
  }

  function validate(): string | null {
    if (!form.name.trim()) return 'Token adı zorunludur.'
    if (form.name.length > 32) return 'Token adı 32 karakterden uzun olamaz.'
    if (!form.symbol.trim()) return 'Sembol (ticker) zorunludur.'
    if (form.symbol.length > 10) return 'Sembol 10 karakterden uzun olamaz.'
    if (form.decimals < 0 || form.decimals > 9) return 'Ondalık basamak 0-9 arasında olmalıdır.'
    if (!/^\d+$/.test(form.supply) || BigInt(form.supply) <= 0n) return 'Geçerli bir arz miktarı girin.'
    return null
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLogoWarning('')
    setResult(null)

    if (!wallet.connected || !wallet.publicKey) {
      setError('Devam etmek için önce cüzdanınızı bağlayın.')
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
          // Logo yükleme başarısız olsa bile token oluşturmayı engellemiyoruz —
          // kullanıcı yine de token'ını alsın, logoyu sonra ekleyebilir.
          console.error('Logo yükleme hatası:', logoErr)
          setLogoWarning(
            logoErr instanceof Error
              ? `Logo yüklenemedi, token logosuz oluşturulacak: ${logoErr.message}`
              : 'Logo yüklenemedi, token logosuz oluşturulacak.',
          )
        }
      }

      const res = await createToken(connection, wallet, { ...form, imageUri }, setStatus)
      setResult(res)
      setStatus('')
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Token oluşturulurken bir hata oluştu.')
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
      <h2>Token Bilgileri</h2>

      <div className="form-grid">
        <label className="field">
          <span>Token Adı *</span>
          <input
            type="text"
            placeholder="ör. 0nRCoin"
            value={form.name}
            maxLength={32}
            onChange={(e) => update('name', e.target.value)}
            required
          />
        </label>

        <label className="field">
          <span>Sembol *</span>
          <input
            type="text"
            placeholder="ör. 0NRC"
            value={form.symbol}
            maxLength={10}
            onChange={(e) => update('symbol', e.target.value.toUpperCase())}
            required
          />
        </label>

        <label className="field">
          <span>Ondalık Basamak (Decimals)</span>
          <input
            type="number"
            min={0}
            max={9}
            value={form.decimals}
            onChange={(e) => update('decimals', Number(e.target.value))}
          />
        </label>

        <label className="field">
          <span>Toplam Arz (Supply) *</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="ör. 1000000000"
            value={form.supply}
            onChange={(e) => update('supply', e.target.value.replace(/[^\d]/g, ''))}
            required
          />
        </label>
      </div>

      <label className="field">
        <span>Açıklama</span>
        <textarea
          placeholder="Token'ınız hakkında kısa bir açıklama"
          value={form.description}
          onChange={(e) => update('description', e.target.value)}
          rows={3}
        />
      </label>

      <div className="field">
        <span>Logo</span>
        <div className="logo-upload" onClick={() => fileInputRef.current?.click()}>
          {logoPreview ? (
            <img src={logoPreview} alt="Logo önizleme" className="logo-upload__preview" />
          ) : (
            <div className="logo-upload__placeholder">🖼️</div>
          )}
          <div className="logo-upload__text">
            {logoFile ? logoFile.name : 'Görsel seçmek için tıklayın (herhangi bir boyutta olabilir, otomatik küçültülür)'}
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
          Seçtiğiniz görsel, token oluşturma işlemiyle birlikte cüzdanınızdan onaylayacağınız küçük
          bir ücret karşılığında kalıcı olarak ağa yazılır — üçüncü taraf bir siteye üye olmanıza
          gerek yok. Boş bırakırsanız token yine sorunsuz oluşturulur, yalnızca logosuz olur.
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
        <legend>Gelişmiş Yetkiler</legend>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.revokeMint}
            onChange={(e) => update('revokeMint', e.target.checked)}
          />
          <div>
            <strong>Mint Yetkisini Kaldır</strong>
            <small>Oluşturduktan sonra kimse (siz dahil) yeni token basamaz — arz sabitlenir.</small>
          </div>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.revokeFreeze}
            onChange={(e) => update('revokeFreeze', e.target.checked)}
          />
          <div>
            <strong>Freeze Yetkisini Kaldır</strong>
            <small>Token hesapları artık dondurulamaz.</small>
          </div>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.immutable}
            onChange={(e) => update('immutable', e.target.checked)}
          />
          <div>
            <strong>Metadata'yı Sabitle (Immutable)</strong>
            <small>İsim, sembol ve metadata bir daha güncellenemez.</small>
          </div>
        </label>

        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.confidentialTransferEnabled}
            onChange={(e) => update('confidentialTransferEnabled', e.target.checked)}
          />
          <div>
            <strong>Gizli Miktar Transferi (Confidential Transfer)</strong>
            <small>
              Token-2022'nin resmi uzantısıyla, transfer edilen MİKTAR zincirde şifreli tutulur —
              gönderen/alıcı adresleri her zaman görünür kalır, sadece tutar gizlenir. Etkinleştirirseniz
              token Token-2022 standardıyla oluşturulur; kullanmak için "Gizli Miktar Transferi"
              sekmesinden hesabınızı ayrıca yapılandırmanız gerekir.
            </small>
          </div>
        </label>
      </fieldset>

      {FEE_WALLET && (
        <div className="fee-note">
          Hizmet ücreti: <strong>{FEE_AMOUNT_SOL} SOL</strong> + ağ işlem ücreti. Ücret, cüzdanınızda
          onayladığınız işlemin bir parçası olarak gösterilir.
        </div>
      )}

      {error && <div className="alert alert--error">{error}</div>}
      {logoWarning && !error && <div className="alert alert--warning">{logoWarning}</div>}
      {status && !error && <div className="alert alert--info">{status}</div>}

      <button type="submit" className="btn btn--primary btn--block" disabled={loading}>
        {loading ? 'Oluşturuluyor...' : wallet.connected ? 'Token Oluştur' : 'Önce Cüzdan Bağlayın'}
      </button>
    </form>
  )
}
