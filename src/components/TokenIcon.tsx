import { useState } from 'react'

// Basit, resmi Solana logomark'ına yakın bir simge — SOL için harici bir
// görsele bağımlı kalmamak adına gömülü tutuyoruz.
const SOL_ICON_DATA_URI =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="32" y2="32">
      <stop offset="0" stop-color="#9945FF"/>
      <stop offset="1" stop-color="#14F195"/>
    </linearGradient>
  </defs>
  <circle cx="16" cy="16" r="16" fill="#0a0b14"/>
  <g fill="url(#g)">
    <path d="M8.2 20.4a1 1 0 0 1 .7-.3h14.9a.5.5 0 0 1 .35.85l-2.9 2.9a1 1 0 0 1-.7.3H5.65a.5.5 0 0 1-.35-.85z"/>
    <path d="M8.2 8.4a1 1 0 0 1 .7-.3h14.9a.5.5 0 0 1 .35.85l-2.9 2.9a1 1 0 0 1-.7.3H5.65a.5.5 0 0 1-.35-.85z"/>
    <path d="M20.9 14.35a1 1 0 0 0-.7-.3H5.3a.5.5 0 0 0-.35.85l2.9 2.9a1 1 0 0 0 .7.3h14.9a.5.5 0 0 0 .35-.85z"/>
  </g>
</svg>
`.trim())

export const SOL_ICON = SOL_ICON_DATA_URI

interface Props {
  image?: string
  symbol?: string
  size?: number
}

/** Coin ikonu: metadata görseli varsa onu, yoksa sembolün ilk harfini gösteren bir yuvarlak. */
export function TokenIcon({ image, symbol, size = 28 }: Props) {
  const [failed, setFailed] = useState(false)
  const initial = (symbol || '?').trim().charAt(0).toUpperCase() || '?'

  if (image && !failed) {
    return (
      <img
        src={image}
        alt={symbol || 'token'}
        className="token-icon"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <span
      className="token-icon token-icon--fallback"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initial}
    </span>
  )
}
