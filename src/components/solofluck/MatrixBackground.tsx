import { useEffect, useRef } from 'react'

// SoLofLuck sayfasına özel arka plan: klasik "matrix" dijital yağmuru, ama
// sütunların bir kısmı zaman zaman (ara ara) dört yapraklı yonca 🍀 ya da
// "777" temalı altın rakamlar dökerek şans/kumarhane temasını hissettiriyor.
// Performans için karakterler her animasyon karesinde değil, aralıklı
// (throttled) olarak güncelleniyor; kullanıcı azaltılmış hareket istiyorsa
// (prefers-reduced-motion) animasyon hiç başlamıyor, yerine tek bir statik
// kare çiziliyor.

const FONT_SIZE = 18
const GLYPHS = '01'
const TICK_MS = 70

type ColumnMode = 'normal' | 'clover' | '777'

function pickMode(): ColumnMode {
  const r = Math.random()
  if (r < 0.08) return '777'
  if (r < 0.2) return 'clover'
  return 'normal'
}

export function MatrixBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let width = 0
    let height = 0
    let columns = 0
    let drops: number[] = []
    let modes: ColumnMode[] = []
    let dpr = Math.min(window.devicePixelRatio || 1, 2)

    function resize() {
      const canvasEl = canvasRef.current
      if (!canvasEl) return
      width = canvasEl.clientWidth
      height = canvasEl.clientHeight
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvasEl.width = Math.floor(width * dpr)
      canvasEl.height = Math.floor(height * dpr)
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      columns = Math.ceil(width / FONT_SIZE)
      drops = Array.from({ length: columns }, () => Math.floor((Math.random() * height) / FONT_SIZE) * -1)
      modes = Array.from({ length: columns }, () => pickMode())
    }

    resize()
    window.addEventListener('resize', resize)

    ctx.font = `${FONT_SIZE}px ui-monospace, "SFMono-Regular", Menlo, monospace`
    ctx.textBaseline = 'top'

    if (reducedMotion) {
      // Tek statik kare: hafif, göz yormayan bir doku.
      ctx.fillStyle = '#050710'
      ctx.fillRect(0, 0, width, height)
      ctx.globalAlpha = 0.35
      for (let i = 0; i < columns; i++) {
        const y = Math.random() * height
        ctx.fillStyle = i % 11 === 0 ? '#facc15' : '#1fbf6b'
        ctx.fillText(i % 13 === 0 ? '🍀' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)], i * FONT_SIZE, y)
      }
      ctx.globalAlpha = 1
      return () => window.removeEventListener('resize', resize)
    }

    let raf = 0
    let last = 0

    function draw(t: number) {
      raf = requestAnimationFrame(draw)
      if (t - last < TICK_MS) return
      last = t

      // Yarı saydam dolgu: önceki karakterleri tamamen silmek yerine iz
      // bırakarak "düşme" hissi veriyor.
      ctx!.fillStyle = 'rgba(4, 6, 12, 0.16)'
      ctx!.fillRect(0, 0, width, height)

      for (let i = 0; i < columns; i++) {
        const mode = modes[i]
        const x = i * FONT_SIZE
        const y = drops[i] * FONT_SIZE

        if (mode === 'clover') {
          ctx!.fillStyle = 'rgba(255, 255, 255, 0.9)'
          ctx!.fillText('🍀', x, y)
        } else if (mode === '777') {
          ctx!.fillStyle = '#facc15'
          ctx!.shadowColor = 'rgba(250, 204, 21, 0.55)'
          ctx!.shadowBlur = 6
          ctx!.fillText('7', x, y)
          ctx!.shadowBlur = 0
        } else {
          const isHead = Math.random() < 0.15
          ctx!.fillStyle = isHead ? '#c9ffe0' : '#18b464'
          ctx!.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], x, y)
        }

        if (y > height && Math.random() > 0.975) {
          drops[i] = 0
          modes[i] = pickMode()
        } else {
          drops[i] += 1
        }
      }
    }

    raf = requestAnimationFrame(draw)

    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(raf)
    }
  }, [])

  return <canvas ref={canvasRef} className="matrix-bg" aria-hidden="true" />
}
