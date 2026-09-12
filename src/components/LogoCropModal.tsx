import { useEffect, useRef, useState } from 'react'
import { cropImageFile, readAsStableBlob } from '../lib/image'

// A square-crop tool for the token logo — drag to reposition, the slider to
// zoom. Deliberately plain CSS transforms + pointer events rather than a
// cropping library: this is the one interaction on the page the user's
// finger moves continuously, so it has to feel instant, and a hand-rolled
// version keeps that off the bundle-size/dependency-risk budget entirely.
//
// The viewport is always square and the image always fully covers it (drawn
// larger than the viewport and dragged within it) — so whatever the user
// lands on when they press "Use This Crop" is, by construction, already a
// valid square region of the source image. See src/lib/image.ts for the
// actual pixel-cropping step this hands off to.
const VIEWPORT = 280

interface Props {
  file: File
  onCancel: () => void
  onConfirm: (cropped: File) => void
}

export function LogoCropModal({ file, onCancel, onConfirm }: Props) {
  const [previewUrl, setPreviewUrl] = useState('')
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(
    null,
  )

  useEffect(() => {
    let url = ''
    let cancelled = false
    setError('')
    // Building the object URL from the raw File directly (URL.createObjectURL(file))
    // is exactly the fragile path src/lib/image.ts's own comment warns about: on
    // Android, a file picked from the gallery can be backed by a content:// URI that
    // fails to render when handed to <img> this way, even though its bytes are
    // perfectly readable — which is what a live user hit ("This image could not be
    // opened") with a plain JPEG screenshot. Reading it into a stable, in-memory Blob
    // first (the same stabilization the actual crop/resize step already used) fixes it.
    ;(async () => {
      try {
        const stableBlob = await readAsStableBlob(file)
        if (cancelled) return
        url = URL.createObjectURL(stableBlob)
        setPreviewUrl(url)
      } catch {
        if (!cancelled) setError('This file could not be read. Try a different image.')
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [file])

  // baseScale: the zoom level at which the image's SHORTER side exactly fills
  // the viewport — the natural "cover" starting point, same idea as CSS
  // `object-fit: cover`.
  const baseScale = natural ? VIEWPORT / Math.min(natural.width, natural.height) : 1
  const dispW = natural ? natural.width * baseScale * zoom : VIEWPORT
  const dispH = natural ? natural.height * baseScale * zoom : VIEWPORT
  const minLeft = VIEWPORT - dispW
  const minTop = VIEWPORT - dispH

  function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value))
  }

  function handleImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget
    const width = img.naturalWidth || VIEWPORT
    const height = img.naturalHeight || VIEWPORT
    setNatural({ width, height })
    const scale = VIEWPORT / Math.min(width, height)
    const w = width * scale
    const h = height * scale
    setPos({ left: (VIEWPORT - w) / 2, top: (VIEWPORT - h) / 2 })
    setZoom(1)
  }

  function handleImageError() {
    const isHeic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
    setError(
      isHeic
        ? 'This image is in HEIC/HEIF format, which browsers cannot open. Convert it from your phone\'s gallery with "share/save as JPG" and try again.'
        : 'This image could not be opened. Try a screenshot or a plain PNG/JPG file.',
    )
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, left: pos.left, top: pos.top }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    setPos({
      left: clamp(drag.left + dx, minLeft, 0),
      top: clamp(drag.top + dy, minTop, 0),
    })
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null
  }

  function handleZoomChange(next: number) {
    if (!natural) {
      setZoom(next)
      return
    }
    // Keep the point currently at the viewport's center fixed while the zoom
    // level changes, so zooming feels like it happens "around" what the user
    // is looking at rather than snapping back to a corner.
    const oldDispW = natural.width * baseScale * zoom
    const oldDispH = natural.height * baseScale * zoom
    const centerFracX = (VIEWPORT / 2 - pos.left) / oldDispW
    const centerFracY = (VIEWPORT / 2 - pos.top) / oldDispH
    const newDispW = natural.width * baseScale * next
    const newDispH = natural.height * baseScale * next
    setZoom(next)
    setPos({
      left: clamp(VIEWPORT / 2 - centerFracX * newDispW, VIEWPORT - newDispW, 0),
      top: clamp(VIEWPORT / 2 - centerFracY * newDispH, VIEWPORT - newDispH, 0),
    })
  }

  async function handleConfirm() {
    if (!natural) return
    setError('')
    setBusy(true)
    try {
      // Displayed-pixel-to-natural-pixel scale, so the region we ask
      // cropImageFile for is exactly what is visible inside the square
      // viewport right now.
      const s = baseScale * zoom
      const region = {
        x: -pos.left / s,
        y: -pos.top / s,
        size: VIEWPORT / s,
      }
      const cropped = await cropImageFile(file, region)
      onConfirm(cropped)
    } catch (err) {
      console.error('Crop error:', err)
      setError(err instanceof Error ? err.message : 'The image could not be cropped.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="coin-picker__overlay" onClick={onCancel}>
      <div className="coin-picker__modal logo-crop__modal" onClick={(e) => e.stopPropagation()}>
        <div className="coin-picker__modal-header">
          <h3>Crop Your Logo</h3>
          <button type="button" className="coin-picker__close" onClick={onCancel} aria-label="Cancel">
            ✕
          </button>
        </div>
        <div className="coin-picker__modal-body logo-crop__body">
          {!error && (
            <>
              <p className="subtab-desc">
                Drag to reposition, use the slider to zoom. The square is exactly what gets uploaded.
              </p>
              <div
                className="logo-crop__viewport"
                style={{ width: VIEWPORT, height: VIEWPORT }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                {previewUrl && (
                  // eslint-disable-next-line jsx-a11y/alt-text
                  <img
                    src={previewUrl}
                    onLoad={handleImageLoad}
                    onError={handleImageError}
                    draggable={false}
                    style={{
                      position: 'absolute',
                      left: pos.left,
                      top: pos.top,
                      width: dispW,
                      height: dispH,
                      maxWidth: 'none',
                      userSelect: 'none',
                    }}
                  />
                )}
              </div>
              <label className="field logo-crop__zoom">
                <span>Zoom</span>
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => handleZoomChange(Number(e.target.value))}
                />
              </label>
            </>
          )}
          {error && <div className="alert alert--error">{error}</div>}
          <div className="logo-crop__actions">
            <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={handleConfirm} disabled={busy || !natural}>
              {busy ? 'Cropping...' : 'Use This Crop'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
