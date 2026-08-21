import { useEffect, useRef, useState } from 'react'
import slotMachineImg from '../../assets/slot-machine.png'

// Saf görsel katman — gerçek kazanma/kaybetme/ödül tutarı her zaman
// zincirden (parsePlayResolvedFromTx) okunuyor, burada sadece HANGİ
// kombinasyonun gösterileceğine karar veriliyor. Arka plan, kullanıcının
// kendi ürettiği altın slot makinesi resmi (src/assets/slot-machine.png).
//
// Önceki sürüm, makara şeridini "spinning" prop'u true olduğu SÜRECE
// (yani cüzdan onayı + zincir bekleme süresi boyunca, dakikalarca sürebilir)
// kesintisiz döndürüyordu — kullanıcı geri bildirimi: "sürekli çalışıyor
// gibi duruyor". Bunun yerine burada sınırlı süreli, gerçek bir "duruş"
// animasyonu var: kısa bir başlangıç dönüşü (~4-7sn) → sonuç henüz
// gelmediyse duraklamış/parıldayan bekleme karesi (dönmüyor) → sonuç
// gelince kısa bir "açılış" dönüşü (~3-5sn) → önceden tanımlı 10
// kombinasyondan (5 kaybetme, 3 küçük ödül, 2 büyük ödül/jackpot) birine
// iniş. Toplam hareketli animasyon süresi en kötü ihtimalle ~12sn, 15-20sn
// üst sınırının altında.
export type SlotResult = 'idle' | 'win' | 'lose'

interface Props {
  spinning: boolean
  result: SlotResult
  /** result 'win' olduğunda: büyük (jackpot) ödül mü, küçük ödül mü. */
  bigWin?: boolean
}

type Combo = [string, string, string]

const LOSE_COMBOS: Combo[] = [
  ['7', '🍒', '🍋'],
  ['💎', '7', '🍀'],
  ['🍋', '🔔', '🍒'],
  ['🍀', '💎', '7'],
  ['🔔', '🍋', '🍒'],
]
const SMALL_WIN_COMBOS: Combo[] = [
  ['🍒', '🍒', '🍒'],
  ['🍋', '🍋', '🍋'],
  ['🔔', '🔔', '🔔'],
]
const BIG_WIN_COMBOS: Combo[] = [
  ['7', '7', '7'],
  ['💎', '💎', '💎'],
]

const REEL_SYMBOLS = ['7', '🍒', '🍋', '🔔', '💎', '🍀']

function pickCombo(result: SlotResult, bigWin: boolean): Combo {
  const pool = result === 'lose' ? LOSE_COMBOS : bigWin ? BIG_WIN_COMBOS : SMALL_WIN_COMBOS
  return pool[Math.floor(Math.random() * pool.length)]
}

function randMs(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

// "held" (bekleme) karesi için 3 FARKLI sembol seçer — asla üçü aynı
// olmaz. Önceki sürüm üç makarada da AYNI tek sembolü gösteriyordu,
// bu da (gerçek sonuç henüz gelmediği hâlde) her seferinde sanki
// kazanılmış gibi görünüyordu ("hepsinde 3 şekil yan yana geliyor,
// kazanmış gibi" kullanıcı geri bildirimi). Gerçek sonuç sadece
// "landed" karesinde, zincirden gelen won/lose'a göre gösteriliyor.
function pickWaitingCombo(): Combo {
  const shuffled = [...REEL_SYMBOLS].sort(() => Math.random() - 0.5)
  return [shuffled[0], shuffled[1], shuffled[2]]
}

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

// Bir makaranın üstünde tek, sabit bir sembol gösterir — hem "held"
// (sonuç henüz gelmedi, bekleme) hem "landed" (gerçek sonuç) durumunda
// kullanılıyor. .luck-slot__sym'in KENDİSİ (scroll şeridindeki ile
// birebir aynı kutu modeli: height:100%, flex, ortalanmış) burada da
// doğrudan kullanılıyor ki üç makara, hangi sembol/glif olursa olsun
// (emoji ile stilize "7" arasında yazı tipi metrikleri farklı olabiliyor)
// tam olarak aynı yatay çizgide hizalı dursun.
function StaticSym({ sym }: { sym: string }) {
  return <span className={sym === '7' ? 'luck-slot__sym luck-slot__sym--seven' : 'luck-slot__sym'}>{sym}</span>
}

type Phase = 'idle' | 'scrolling' | 'held' | 'revealing' | 'landed'

export function SlotMachine({ spinning, result, bigWin = false }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [combo, setCombo] = useState<Combo | null>(null)
  // "held" (bekleme) karesinde gösterilen 3 sembol — hizalı ama ASLA
  // üçü aynı değil (bkz. pickWaitingCombo), ki gerçek sonuç henüz
  // gelmeden "kazanmış" izlenimi vermesin.
  const [waitingCombo, setWaitingCombo] = useState<Combo>(() => pickWaitingCombo())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // Yeni bir oyun başladığında (result tekrar 'idle' olur) baştan başla.
  useEffect(() => {
    if (result === 'idle') {
      if (spinning) {
        setPhase('scrolling')
        setCombo(null)
        clearTimer()
        timerRef.current = setTimeout(() => {
          // Sonuç hâlâ gelmediyse (zincir/cüzdan onayı sürüyor) dönmeyi
          // durdurup bekleme karesine geç — "sürekli dönüyor" hissini
          // burada kesiyoruz.
          setWaitingCombo(pickWaitingCombo())
          setPhase((p) => (p === 'scrolling' ? 'held' : p))
        }, randMs(4000, 7000))
      } else {
        setPhase('idle')
        setCombo(null)
        clearTimer()
      }
    }
    return clearTimer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinning, result])

  // Sonuç geldiğinde (win/lose) kısa bir "açılış" dönüşünden sonra ilgili
  // kombinasyona iniyoruz.
  useEffect(() => {
    if (result === 'win' || result === 'lose') {
      setPhase('revealing')
      clearTimer()
      timerRef.current = setTimeout(() => {
        setCombo(pickCombo(result, bigWin))
        setPhase('landed')
      }, randMs(3000, 5000))
    }
    return clearTimer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, bigWin])

  const isScrollingVisual = phase === 'scrolling' || phase === 'revealing'
  const overlayVisible = phase !== 'idle'
  const phaseClass =
    phase === 'scrolling' || phase === 'revealing'
      ? 'luck-slot__reels--scrolling'
      : phase === 'held'
        ? 'luck-slot__reels--held'
        : phase === 'landed'
          ? 'luck-slot__reels--landed'
          : ''

  return (
    <div className={`luck-slot luck-slot--${result} ${isScrollingVisual ? 'luck-slot--spinning' : ''}`}>
      <div className="luck-slot__frame">
        <img src={slotMachineImg} alt="777 Jackpot slot makinesi" className="luck-slot__img" />
        <div
          className={`luck-slot__reels ${overlayVisible ? 'luck-slot__reels--visible' : ''} ${phaseClass}`}
          aria-hidden="true"
        >
          {[0, 1, 2].map((i) => (
            <div className="luck-slot__reel" key={i}>
              {phase === 'landed' && combo ? (
                <StaticSym sym={combo[i]} />
              ) : phase === 'held' ? (
                <StaticSym sym={waitingCombo[i]} />
              ) : isScrollingVisual ? (
                <ReelStrip />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
