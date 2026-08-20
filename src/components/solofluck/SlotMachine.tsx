import { useEffect, useState } from 'react'

// Saf görsel katman — gerçek kazanma/kaybetme sonucu her zaman zincirden
// (parsePlayResolvedFromTx) okunuyor. Bu bileşen sadece o sonucu gerçek bir
// slot makinesi kabini gibi (altın metal gövde, kalın kırmızı 7'ler, dikey
// kayan makara şeritleri, ödeme çizgisi, kol) gösteriyor, oyunun
// adilliğiyle hiçbir ilgisi yok.
const SEVEN = '7'
// Emoji "7️⃣" küçük bir uygulama simgesi gibi göründüğü için klasik slot
// makinelerindeki gibi kalın, kırmızı/altın stilize bir "7" harfi çiziyoruz;
// diğer semboller emoji olarak kalıyor.
const SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '💎', SEVEN]
// CSS'teki dönen şerit görselinde kullanılan sembol havuzu — şerit iki kez
// art arda dizilip yarısı kadar kayınca sorunsuzca döngüye giriyor.
const REEL_STRIP = [...SYMBOLS, ...SYMBOLS]

function randomSymbol(): string {
  return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)]
}

// Kaybedilen bir denemede üç makaranın da tesadüfen 777 gösterip kazanma
// görseliyle karışmasını engeller.
function randomLoseSymbols(): [string, string, string] {
  let symbols: [string, string, string]
  do {
    symbols = [randomSymbol(), randomSymbol(), randomSymbol()]
  } while (symbols.every((s) => s === SEVEN))
  return symbols
}

function renderSymbol(symbol: string) {
  return symbol === SEVEN ? <span className="luck-slot__seven">7</span> : symbol
}

export type SlotResult = 'idle' | 'win' | 'lose'

interface Props {
  spinning: boolean
  result: SlotResult
}

export function SlotMachine({ spinning, result }: Props) {
  const [symbols, setSymbols] = useState<[string, string, string]>([SEVEN, SEVEN, SEVEN])

  useEffect(() => {
    if (spinning) return
    if (result === 'win') setSymbols([SEVEN, SEVEN, SEVEN])
    else if (result === 'lose') setSymbols(randomLoseSymbols())
  }, [spinning, result])

  return (
    <div className={`luck-slot luck-slot--${result} ${spinning ? 'luck-slot--spinning' : ''}`}>
      <div className="luck-slot__marquee">
        <span className="luck-slot__bulb" />
        <span className="luck-slot__marquee-text">777 JACKPOT</span>
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
                      {renderSymbol(s)}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="luck-slot__symbol">{renderSymbol(symbol)}</span>
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
