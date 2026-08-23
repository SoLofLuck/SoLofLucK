// Kullanıcının seçtiği görsel (bir telefon fotoğrafı gibi) birkaç MB
// olabilir. Token logoları küçük olmalı — bu yüzden yüklemeden önce
// tarayıcıda küçük bir kareye indirip yeniden sıkıştırıyoruz. Bu, hem
// Irys'e ödenecek depolama ücretini hem de yükleme süresini (ve
// dolayısıyla ağ zaman aşımı riskini) belirgin şekilde azaltır.
//
// Mobilde bu iş göründüğünden zor: Android'de galeriden seçilen dosya bir
// `content://` URI'sine dayanıyor ve `createImageBitmap()` bu dosyalarda
// düzensiz şekilde başarısız olabiliyor (ilerlemeli JPEG, EXIF döndürme,
// bazı WebView sürümleri). Kullanıcının gördüğü belirti tam olarak buydu:
// üç denemenin ikisinde önizleme kırık çıkıyor ve token oluştururken
// "görsel işlenemedi" hatası alınıyordu.
//
// Bu yüzden burada TEK bir yola güvenmiyoruz:
//   1. Dosyanın baytları HEMEN belleğe alınıyor (content:// URI'si sonradan
//      okunamaz hale gelse bile elimizde veri kalsın diye).
//   2. Çözümleme için önce createImageBitmap, olmazsa klasik <img>
//      elemanı deneniyor — ikincisi tarayıcının normal görsel çözücüsünü
//      kullandığı için SVG ve EXIF'li JPEG dahil çok daha geniş bir
//      yelpazeyi kaldırıyor.
//   3. Sıkıştırmada canvas.toBlob yoksa/boş dönerse toDataURL'e düşülüyor.
const MAX_DIMENSION = 256
const JPEG_QUALITY = 0.85

/** Çözümlenmiş görsel — kaynağı ImageBitmap da olabilir <img> de. */
interface DecodedImage {
  width: number
  height: number
  drawTo: (ctx: CanvasRenderingContext2D, width: number, height: number) => void
  release: () => void
}

async function decodeWithImageBitmap(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap desteklenmiyor.')
  }
  const bitmap = await createImageBitmap(blob)
  return {
    width: bitmap.width,
    height: bitmap.height,
    drawTo: (ctx, width, height) => ctx.drawImage(bitmap, 0, 0, width, height),
    release: () => bitmap.close(),
  }
}

async function decodeWithImgElement(blob: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Görsel çözümlenemedi.'))
      img.src = url
    })
    // Bazı tarayıcılarda onload, görselin çizime hazır olduğunu garanti
    // etmiyor; decode() varsa onu da bekliyoruz. Desteklenmiyorsa onload
    // zaten yeterli.
    if (typeof img.decode === 'function') {
      try {
        await img.decode()
      } catch {
        /* onload yeterli */
      }
    }
    // SVG gibi içsel boyutu olmayan görsellerde 0 dönebiliyor — makul bir
    // varsayılana çekiyoruz ki bölme/ölçek hesabı bozulmasın.
    const width = img.naturalWidth || img.width || MAX_DIMENSION
    const height = img.naturalHeight || img.height || MAX_DIMENSION
    return {
      width,
      height,
      drawTo: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      // URL'i çizim bittikten SONRA iptal ediyoruz: erken iptal, bazı
      // tarayıcılarda drawImage'ı sessizce boş bırakıyor.
      release: () => URL.revokeObjectURL(url),
    }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  try {
    return await decodeWithImageBitmap(blob)
  } catch {
    return await decodeWithImgElement(blob)
  }
}

async function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  if (typeof canvas.toBlob === 'function') {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality))
    if (blob) return blob
  }
  // toBlob yok ya da null döndü (bazı Android WebView sürümleri) — veri
  // URL'i üzerinden elle Blob'a çeviriyoruz.
  const dataUrl = canvas.toDataURL(mimeType, quality)
  const base64 = dataUrl.split(',')[1]
  if (!base64) throw new Error('Görsel sıkıştırılamadı.')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

export async function resizeImageFile(file: File): Promise<File> {
  // Baytları hemen belleğe al. Android'de galeriden gelen File nesnesi bir
  // content:// URI'sine bakıyor ve bu URI kısa süre sonra okunamaz hale
  // gelebiliyor — o noktada hem önizleme kırılıyor hem de yükleme
  // başarısız oluyordu. Buffer'ı erken almak bu sınıf hatayı bitiriyor.
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength === 0) {
    throw new Error('Seçilen dosya okunamadı (boş geldi).')
  }
  const sourceBlob = new Blob([buffer], { type: file.type || 'image/jpeg' })

  const decoded = await decodeImage(sourceBlob)
  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Tarayıcınız görsel işlemeyi desteklemiyor.')
    decoded.drawTo(ctx, width, height)

    // PNG'yi PNG olarak koruyoruz (şeffaflık kaybolmasın); SVG dahil geri
    // kalan her şey JPEG'e çevriliyor — logo için fazlasıyla yeterli ve
    // yüklenen boyutu küçük tutuyor.
    const keepPng = file.type === 'image/png'
    const mimeType = keepPng ? 'image/png' : 'image/jpeg'
    const blob = await canvasToBlob(canvas, mimeType, keepPng ? undefined : JPEG_QUALITY)
    if (blob.size === 0) throw new Error('Görsel sıkıştırılamadı.')

    const baseName = file.name.replace(/\.[^./]+$/, '') || 'logo'
    return new File([blob], `${baseName}.${keepPng ? 'png' : 'jpg'}`, { type: mimeType })
  } finally {
    decoded.release()
  }
}
