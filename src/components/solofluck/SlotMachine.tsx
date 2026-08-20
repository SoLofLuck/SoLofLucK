import { useEffect, useState } from 'react'

// Saf görsel katman — gerçek kazanma/kaybetme sonucu her zaman zincirden
// (parsePlayResolvedFromTx) okunuyor. Bu bileşen sadece o sonucu 3 makaralı
// bir slot animasyonuyla gösteriyor, oyunun adilliğiyle hiçbir ilgisi yok.
const SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣']

function randomSymbol(): string {
  return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]
}

// Kaybedilen bir denemede üç makaranın da tesadüfen 7️⃣7️⃣7️⃣ gösterip
// kazanma görseliyle karışmasını engeller.
function randomLoseSymbols(): [string, string, string] {
  let symbols: [string, string, string]
  do {
    symbols = [randomSymbol(), randomSymbol(), randomSymbol()]
  } while (symbols.every((s) => s === '7️⃣'))
  return symbols
}

export type SlotResult = 'idle' | 'win' | 'lose'

interface Props {
  spinning: boolean
  result: SlotResult
}

export function SlotMachine({ spinning, result }: Props) {
  const [symbols, setSymbols] = useState<[string, string, string]>(['7️⃣', '7️⃣', '7️⃣'])

  useEffect(() => {
    if (!spinning) return
    const id = setInterval(() => setSymbols([randomSymbol(), randomSymbol(), randomSymbol()]), 90)
    return () => clearInterval(id)
  }, [spinning])

  useEffect(() => {
    if (spinning) return
    if (result === 'win') setSymbols(['7️⃣', '7️⃣', '7️⃣'])
    else if (result === 'lose') setSymbols(randomLoseSymbols())
  }, [spinning, result])

  return (
    <div className={`luck-slot luck-slot--${result}`}>
      <div className="luck-slot__marquee">
        <span className="luck-slot__bulb" />
        <span className="luck-slot__marquee-text">777 SoLofLuck</span>
        <span className="luck-slot__bulb" />
      </div>
      <div className="luck-slot__reels">
        {symbols.map((symbol, i) => (
          <div key={i} className={`luck-slot__reel ${spinning ? 'luck-slot__reel--spin' : ''}`}>
            <span className="luck-slot__symbol">{symbol}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
