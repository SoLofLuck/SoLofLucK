import { WebUploader } from '@irys/web-upload'
import { WebSolana } from '@irys/web-upload-solana'
import type { WalletContextState } from '@solana/wallet-adapter-react'
import type { Connection } from '@solana/web3.js'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { NETWORKS, type NetworkId } from '../config'

// Logoyu ve metadata JSON'unu üçüncü taraf bir hesap/servise ihtiyaç
// duymadan, doğrudan kullanıcının bağlı Solana cüzdanıyla ödeyerek Irys/
// Arweave ağına kalıcı olarak yazıyoruz. Kayıt, API anahtarı ya da başka
// bir siteye gitmeye gerek yok — küçük bir görsel için ücret genellikle
// bir SOL'un binde birinden azdır ve cüzdanda normal bir işlem olarak
// onaylanır.

export interface OnChainMetadataInput {
  name: string
  symbol: string
  description: string
  website: string
  twitter: string
  telegram: string
}

// Metadata JSON'unun (image URL'i doldurulduktan sonra) gerçek boyutunu
// önceden tam bilemesek de birkaç yüz bayttan büyük olmaz; ücreti tek
// seferde ve fazlasıyla karşılayacak cömert bir tampon payı bırakıyoruz.
const METADATA_JSON_BUFFER_BYTES = 2048
// İşlem ücreti + hesap kirası için ayrılan tampon (lamports).
const WALLET_FEE_BUFFER_LAMPORTS = 20_000

function sol(lamports: number | string): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)
}

async function getIrysUploader(wallet: WalletContextState, network: NetworkId) {
  const builder = WebUploader(WebSolana)
    .withProvider(wallet)
    .withRpc(NETWORKS[network].endpoint)
    // Irys varsayılan olarak "finalized" onayını bekliyor; bu Solana'da
    // "confirmed"a göre çok daha yavaş (bazen 15-30+ sn) ve iç zaman
    // aşımı süresini (30 sn) çoğu zaman aşıp gereksiz yere başarısız
    // oluyordu. "confirmed" çok daha hızlı ve pratikte aynı derecede
    // güvenilir.
    .withTokenOptions({ finality: 'confirmed' })

  if (network === 'devnet') {
    builder.devnet()
  }

  // UploadBuilder "thenable"dır (await edildiğinde .build() çalışır ve
  // gerçek getPrice/fund/uploadFile metodlarına sahip Irys örneğini
  // döndürür) — bu yüzden burada açıkça await ediyoruz.
  return await builder
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ÖNEMLİ: irys.fund() her çağrıldığında YENİ bir SOL transferi oluşturur ve
// cüzdanda YENİ bir onay ister — bu yüzden burada "başarısız oldu, tekrar
// dene" mantığını fund()'ı tekrar tekrar çağırarak kurmuyoruz (bu, arka
// arkaya birden fazla cüzdan onayı istemesine ve dakikalarca sürmesine
// sebep olurdu). Bunun yerine: ilk denemeden sonra hiçbir yeni işlem
// göndermeden bakiyenin güncellenip güncellenmediğini kontrol ediyoruz
// (SOL çoğu zaman gönderilmiş oluyor, sadece Irys'in onu görmesi
// gecikiyor); yalnızca bakiye hâlâ yetersizse EN FAZLA bir kez daha
// (toplam 2 cüzdan onayı) deniyoruz.
async function ensureFunded(
  irys: Awaited<ReturnType<typeof getIrysUploader>>,
  connection: Connection,
  walletPubkey: import('@solana/web3.js').PublicKey,
  bytes: number,
  onStatus?: (status: string) => void,
) {
  const price = await irys.getPrice(bytes)
  let balance = await irys.getLoadedBalance()
  if (!price.isGreaterThan(balance)) {
    onStatus?.('Depolama ücreti zaten karşılanmış, yüklemeye geçiliyor...')
    return
  }

  let topUp = price.minus(balance).multipliedBy(1.15).integerValue()

  // Cüzdanda gerçekten bu kadar SOL var mı? Yoksa cüzdan zaten
  // "yetersiz bakiye" diyerek işlemi reddedecek — bunu önceden
  // tespit edip anlaşılır bir mesaj vermek, gizemli bir ağ hatası
  // beklemekten çok daha iyi.
  const walletLamports = await connection.getBalance(walletPubkey)
  const needed = topUp.toNumber() + WALLET_FEE_BUFFER_LAMPORTS
  if (walletLamports < needed) {
    throw new Error(
      `cüzdanınızda yeterli SOL yok (gerekli: ~${sol(needed)} SOL, mevcut: ${sol(walletLamports)} SOL). ` +
        'Devnet\'te faucet.solana.com üzerinden ücretsiz SOL alabilirsiniz.',
    )
  }

  onStatus?.(`Depolama ücreti (~${sol(topUp.toNumber())} SOL) için cüzdanınızda onay bekleniyor...`)
  let lastError: unknown
  try {
    await irys.fund(topUp)
    onStatus?.('Depolama ücreti onaylandı.')
    return
  } catch (err) {
    lastError = err
  }

  onStatus?.('Depolama ağı yanıt vermedi, birkaç saniye bekleniyor (yeni işlem gönderilmiyor)...')
  await sleep(8000)
  balance = await irys.getLoadedBalance()
  if (!price.isGreaterThan(balance)) {
    onStatus?.('Ücret bu arada onaylanmış, devam ediliyor...')
    return
  }

  onStatus?.('Cüzdanınızda bir onay isteği daha görünecek...')
  try {
    topUp = price.minus(balance).multipliedBy(1.15).integerValue()
    await irys.fund(topUp)
    onStatus?.('Depolama ücreti onaylandı.')
    return
  } catch (err) {
    lastError = err
  }

  throw new Error(
    lastError instanceof Error
      ? `depolama ağı yanıt vermedi — ${lastError.message}`
      : 'depolama ağı yanıt vermedi',
  )
}

export async function uploadLogoAndMetadata(
  file: File,
  input: OnChainMetadataInput,
  connection: Connection,
  wallet: WalletContextState,
  network: NetworkId,
  onStatus?: (status: string) => void,
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error('cüzdan bağlı değil')
  }

  onStatus?.('Depolama ağına bağlanılıyor...')
  let irys: Awaited<ReturnType<typeof getIrysUploader>>
  try {
    irys = await getIrysUploader(wallet, network)
  } catch (err) {
    throw stageError('Ağa bağlanılamadı', err)
  }

  // Logo + metadata JSON için gereken ücreti TEK seferde önceden
  // karşılıyoruz. Böylece ayrı ayrı iki kez ücret gönderip her birinde
  // ayrı bir cüzdan onayı ve onay bekleme süresi yaşamak yerine, tüm
  // yükleme boyunca en fazla bir kez (gerekirse bir kez daha) ücret
  // gönderiyoruz.
  onStatus?.('Depolama ücreti hesaplanıyor...')
  try {
    await ensureFunded(
      irys,
      connection,
      wallet.publicKey,
      file.size + METADATA_JSON_BUFFER_BYTES,
      onStatus,
    )
  } catch (err) {
    throw stageError('Depolama ücreti gönderilemedi', err)
  }

  onStatus?.(`Logo (${(file.size / 1024).toFixed(0)} KB) kalıcı olarak ağa yükleniyor...`)
  let imageReceipt: Awaited<ReturnType<typeof irys.uploadFile>>
  try {
    imageReceipt = await irys.uploadFile(file)
  } catch (err) {
    throw stageError('Logo yüklenemedi', err)
  }
  const imageUrl = `https://gateway.irys.xyz/${imageReceipt.id}`
  onStatus?.('Logo yüklendi, metadata hazırlanıyor...')

  const metadataJson = {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: imageUrl,
    external_url: input.website || undefined,
    extensions: {
      website: input.website || undefined,
      twitter: input.twitter || undefined,
      telegram: input.telegram || undefined,
    },
    properties: {
      files: [{ uri: imageUrl, type: file.type || 'image/png' }],
      category: 'image',
    },
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataJson))
  const metadataFile = new File([metadataBytes], 'metadata.json', {
    type: 'application/json',
  })

  onStatus?.('Metadata kalıcı olarak ağa yükleniyor...')
  try {
    const metadataReceipt = await irys.uploadFile(metadataFile)
    onStatus?.('Metadata yüklendi.')
    return `https://gateway.irys.xyz/${metadataReceipt.id}`
  } catch (err) {
    throw stageError('Metadata yüklenemedi', err)
  }
}

function stageError(prefix: string, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err)
  return new Error(`${prefix}: ${detail}`)
}
