// Kullanıcının seçtiği görsel (bir telefon fotoğrafı gibi) birkaç MB
// olabilir. Token logoları küçük olmalı — bu yüzden yüklemeden önce
// tarayıcıda küçük bir kareye indirip yeniden sıkıştırıyoruz. Bu, hem
// Irys'e ödenecek depolama ücretini hem de yükleme süresini (ve
// dolayısıyla ağ zaman aşımı riskini) belirgin şekilde azaltır.
const MAX_DIMENSION = 256
const JPEG_QUALITY = 0.85

export async function resizeImageFile(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file)

  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Tarayıcınız görsel işlemeyi desteklemiyor.')
    ctx.drawImage(bitmap, 0, 0, width, height)

    const keepPng = file.type === 'image/png'
    const mimeType = keepPng ? 'image/png' : 'image/jpeg'

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Görsel sıkıştırılamadı.'))),
        mimeType,
        keepPng ? undefined : JPEG_QUALITY,
      )
    })

    const baseName = file.name.replace(/\.[^./]+$/, '') || 'logo'
    return new File([blob], `${baseName}.${keepPng ? 'png' : 'jpg'}`, { type: mimeType })
  } finally {
    bitmap.close()
  }
}
