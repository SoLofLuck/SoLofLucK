import slotMachineImg from '../../assets/slot-machine.png'

// Saf görsel katman — gerçek kazanma/kaybetme sonucu her zaman zincirden
// (parsePlayResolvedFromTx) okunuyor. Görsel, kullanıcının kendi ürettiği
// bir altın slot makinesi resmi (src/assets/slot-machine.png); makaralar
// gerçekten dönmüyor (tek parça görsel), durum CSS animasyonlarıyla
// (titreşim/parlaklık, kazanma nabzı, kaybetme solması) veriliyor.
export type SlotResult = 'idle' | 'win' | 'lose'

interface Props {
  spinning: boolean
  result: SlotResult
}

export function SlotMachine({ spinning, result }: Props) {
  return (
    <div className={`luck-slot luck-slot--${result} ${spinning ? 'luck-slot--spinning' : ''}`}>
      <img src={slotMachineImg} alt="777 Jackpot slot makinesi" className="luck-slot__img" />
    </div>
  )
}
