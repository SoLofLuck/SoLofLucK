import { useEffect, useState } from 'react'

// Saf görsel katman — gerçek kazanma/kaybetme sonucu her zaman zincirden
// (parsePlayResolvedFromTx) okunuyor. Bu bileşen sadece o sonucu gerçek bir
// slot makinesi kabini gibi (dikey kayan makara şeritleri, ödeme çizgisi,
// kol) gösteriyor, oyunun adilliğiyle hiçbir ilgisi yok.
const SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣']
// CSS'teki dönen şerit görselinde kullanılan sembol havuzu — şerit iki kez
// art arda dizilip yarısı kadar kayınca sorunsuzca döngüye giriyor.
const REEL_STRIP = [...SYMBOLS, ...SYMBOLS]

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
    if (spinning) return
    if (result === 'win') setSymbols(['7️⃣', '7️⃣', '7️⃣'])
    else if (result === 'lose') setSymbols(randomLoseSymbols())
  }, [spinning, result])

  return (
    <div className={`luck-slot luck-slot--${result} ${spinning ? 'luck-slot--spinning' : ''}`}>
      <div className="luck-slot__marquee">
        <span className="luck-slot__bulb" />
        <span className="luck-slot__marquee-text">777 SoLofLuck</span>
        <span className="luck-slot__bulb" />
      </div>

      <div className="luck-slot__cabinet">
        <div className="luck-slot__reels">
          {symbols.map((symbol, i) => (
            <div key={i} className="luck-slot__reel">
              {spinning ? (
                <div className="luck-slot__strip">
                  {REEL_STRIP.map((s, j) => (
                    <span key={j} className="luck-slot__strip-symbol">
                      {s}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="luck-slot__symbol">{symbol}</span>
              )}
            </div>
          ))}
          <div className="luck-slot__payline" />
        </div>
        <div className="luck-slot__lever" aria-hidden="true">
          <span className="luck-slot__lever-knob" />
        </div>
      </div>
    </div>
  )
}
