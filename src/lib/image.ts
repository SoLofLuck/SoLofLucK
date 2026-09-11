// The image a user picks (a phone photo, say) can be several MB. Token logos
// should be small — so before uploading we scale it down to a small square in
// the browser and recompress it. That noticeably reduces the upload time (and
// with it the risk of a network timeout).
//
// On mobile this is harder than it looks: on Android a file chosen from the
// gallery is backed by a `content://` URI, and `createImageBitmap()` can fail
// erratically on those files (progressive JPEG, EXIF rotation, certain WebView
// versions). That was exactly the symptom the user saw: on two out of three
// attempts the preview came out broken and creating the token gave an "the image
// could not be processed" error.
//
// So we do not rely on a SINGLE path here:
//   1. The file's bytes are read into memory IMMEDIATELY (so we still hold the
//      data even if the content:// URI becomes unreadable later).
//   2. For decoding we try createImageBitmap first and fall back to a classic
//      <img> element — the latter uses the browser's normal image decoder and
//      therefore handles a far wider range, SVG and EXIF-bearing JPEG included.
//   3. For compression, if canvas.toBlob is missing or returns empty we fall
//      back to toDataURL.
const MAX_DIMENSION = 256
const JPEG_QUALITY = 0.85

/** A decoded image — its source may be either an ImageBitmap or an <img>. */
interface DecodedImage {
  width: number
  height: number
  drawTo: (ctx: CanvasRenderingContext2D, width: number, height: number) => void
  // Draws only the (sx, sy, sSize x sSize) natural-pixel square region,
  // scaled to fill a dSize x dSize destination — the crop tool's draw path.
  drawCropTo: (ctx: CanvasRenderingContext2D, sx: number, sy: number, sSize: number, dSize: number) => void
  release: () => void
}

async function decodeWithImageBitmap(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('createImageBitmap is not supported.')
  }
  const bitmap = await createImageBitmap(blob)
  return {
    width: bitmap.width,
    height: bitmap.height,
    drawTo: (ctx, width, height) => ctx.drawImage(bitmap, 0, 0, width, height),
    drawCropTo: (ctx, sx, sy, sSize, dSize) =>
      ctx.drawImage(bitmap, sx, sy, sSize, sSize, 0, 0, dSize, dSize),
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
      img.onerror = () => reject(new Error('The image could not be decoded.'))
      img.src = url
    })
    // In some browsers onload does not guarantee the image is ready to be
    // drawn; if decode() exists we await that too. Where it is unsupported,
    // onload is enough on its own.
    if (typeof img.decode === 'function') {
      try {
        await img.decode()
      } catch {
        /* onload yeterli */
      }
    }
    // For images with no intrinsic size, such as SVG, this can return 0 — we
    // pull it to a sensible default so the division and scaling do not break.
    const width = img.naturalWidth || img.width || MAX_DIMENSION
    const height = img.naturalHeight || img.height || MAX_DIMENSION
    return {
      width,
      height,
      drawTo: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      drawCropTo: (ctx, sx, sy, sSize, dSize) => ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, dSize, dSize),
      // We revoke the URL AFTER the drawing is done: revoking early leaves
      // drawImage silently blank in some browsers.
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
  // toBlob is missing or returned null (some Android WebView versions) — we
  // convert to a Blob by hand via the data URL.
  const dataUrl = canvas.toDataURL(mimeType, quality)
  const base64 = dataUrl.split(',')[1]
  if (!base64) throw new Error('The image could not be compressed.')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

// Reads a File's bytes into memory immediately (see the Android content://
// note above), independent of what happens to it afterwards.
async function readAsStableBlob(file: File): Promise<Blob> {
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength === 0) {
    throw new Error('The selected file could not be read (it came back empty).')
  }
  return new Blob([buffer], { type: file.type || 'image/jpeg' })
}

function canvasBlobToFile(blob: Blob, file: File, keepPng: boolean): File {
  const baseName = file.name.replace(/\.[^./]+$/, '') || 'logo'
  return new File([blob], `${baseName}.${keepPng ? 'png' : 'jpg'}`, { type: blob.type })
}

export async function resizeImageFile(file: File): Promise<File> {
  const sourceBlob = await readAsStableBlob(file)
  const decoded = await decodeImage(sourceBlob)
  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Your browser does not support image processing.')
    decoded.drawTo(ctx, width, height)

    // PNG is kept as PNG (so transparency is not lost); everything else, SVG
    // included, is converted to JPEG — more than good enough for a logo and it
    // keeps the uploaded size small.
    const keepPng = file.type === 'image/png'
    const mimeType = keepPng ? 'image/png' : 'image/jpeg'
    const blob = await canvasToBlob(canvas, mimeType, keepPng ? undefined : JPEG_QUALITY)
    if (blob.size === 0) throw new Error('The image could not be compressed.')

    return canvasBlobToFile(blob, file, keepPng)
  } finally {
    decoded.release()
  }
}

// The fixed output size for a cropped logo. Square, and generous enough for
// how a logo actually gets shown (explorer pages, this site's own coin
// picker, wallet lists) without producing a needlessly large upload — a
// token logo is decoration, not a photograph.
export const LOGO_OUTPUT_SIZE = 512

/** Reads just the natural width/height of an image file, for the crop tool to
 *  size its viewport before the user starts dragging anything. Cheap: it
 *  decodes the image once and immediately releases it without drawing. */
export async function readImageNaturalSize(file: File): Promise<{ width: number; height: number }> {
  const sourceBlob = await readAsStableBlob(file)
  const decoded = await decodeImage(sourceBlob)
  const size = { width: decoded.width, height: decoded.height }
  decoded.release()
  return size
}

/**
 * Crops a file down to a single square region and resizes that region to
 * LOGO_OUTPUT_SIZE x LOGO_OUTPUT_SIZE — the crop tool's actual output step.
 * `region` is in the image's own natural pixels (not the crop UI's on-screen
 * pixels): `x`/`y` is the square's top-left corner, `size` is its side length.
 * Goes through the exact same decode path as resizeImageFile (ImageBitmap
 * first, <img> fallback), so it inherits the same mobile-format robustness.
 */
export async function cropImageFile(
  file: File,
  region: { x: number; y: number; size: number },
): Promise<File> {
  const sourceBlob = await readAsStableBlob(file)
  const decoded = await decodeImage(sourceBlob)
  try {
    // Clamp defensively — the crop UI keeps the region inside the image by
    // construction, but a stale/rounded value should never be able to ask the
    // canvas to read outside the source and throw an IndexSizeError.
    const size = Math.max(1, Math.min(region.size, decoded.width, decoded.height))
    const x = Math.max(0, Math.min(region.x, decoded.width - size))
    const y = Math.max(0, Math.min(region.y, decoded.height - size))

    const canvas = document.createElement('canvas')
    canvas.width = LOGO_OUTPUT_SIZE
    canvas.height = LOGO_OUTPUT_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Your browser does not support image processing.')
    decoded.drawCropTo(ctx, x, y, size, LOGO_OUTPUT_SIZE)

    const keepPng = file.type === 'image/png'
    const mimeType = keepPng ? 'image/png' : 'image/jpeg'
    const blob = await canvasToBlob(canvas, mimeType, keepPng ? undefined : JPEG_QUALITY)
    if (blob.size === 0) throw new Error('The image could not be compressed.')

    return canvasBlobToFile(blob, file, keepPng)
  } finally {
    decoded.release()
  }
}
