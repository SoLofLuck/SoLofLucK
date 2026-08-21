import slotMachineImg from '../../assets/slot-machine.png'

// Saf görsel katman — gerçek kazanma/kaybetme sonucu her zaman zincirden
// (parsePlayResolvedFromTx) okunuyor. Arka plan, kullanıcının kendi
// ürettiği altın slot makinesi resmi (src/assets/slot-machine.png); resmin
// makaraları gerçekten dönmüyor (tek parça görsel). Bu yüzden dönüş
// hissini vermek için resmin üstüne, makara penceresinin YAKLAŞIK
// konumuna hizalanmış 3 ayrı sahte makara şeridi bindiriliyor — yalnızca
// "spinning" durumundayken görünür (aksi halde 0 opaklık, altındaki
// gerçek "7 7 7" görseli olduğu gibi görünür).
export type SlotResult = 'idle' | 'win' | 'lose'

interface Props {
  spinning: boolean
  result: SlotResult
}

const REEL_SYMBOLS = ['7', '🍒', '🍋', '🔔', '💎', '🍀']

function ReelStrip() {
  const symbols = [...REEL_SYMBOLS, ...REEL_SYMBOLS]
  return (
    <div className="luck-slot__reel-strip">
      {symbols.map((sym, i) => (
        <span key={i} className={sym === '7' ? 'luck-slot__sym luck-slot__sym--seven' : 'luck-slot__sym'}>
          {sym}
        </span>
      ))}
    </div>
  )
}

export function SlotMachine({ spinning, result }: Props) {
  return (
    <div className={`luck-slot luck-slot--${result} ${spinning ? 'luck-slot--spinning' : ''}`}>
      <div className="luck-slot__frame">
        <img src={slotMachineImg} alt="777 Jackpot slot makinesi" className="luck-slot__img" />
        <div className="luck-slot__reels" aria-hidden="true">
          <div className="luck-slot__reel luck-slot__reel--1">
            <ReelStrip />
          </div>
          <div className="luck-slot__reel luck-slot__reel--2">
            <ReelStrip />
          </div>
          <div className="luck-slot__reel luck-slot__reel--3">
            <ReelStrip />
          </div>
        </div>
      </div>
    </div>
  )
}
