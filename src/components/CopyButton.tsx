import { useState } from 'react'

interface Props {
  value: string
  label?: string
  className?: string
}

export function CopyButton({ value, label = 'Copy', className = '' }: Props) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API yoksa (izin verilmedi, http vb.) sessizce yut —
      // the user can select and copy the text by hand.
    }
  }

  return (
    <button type="button" className={`copy-btn ${className}`} onClick={handleCopy}>
      {copied ? '✓ Copied' : label}
    </button>
  )
}
