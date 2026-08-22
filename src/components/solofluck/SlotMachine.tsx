import { useEffect, useRef, useState } from 'react'
import slotMachineImg from '../../assets/slot-machine.png'

// Saf görsel katman — gerçek kazanma/kaybetme/ödül tutarı her zaman
// zincirden (parsePlayResolvedFromTx) okunuyor, burada sadece HANGİ
// kombinasyonun gösterileceğine ve NE ZAMAN açıklanacağına karar
// veriliyor. Arka plan, kullanıcının kendi ürettiği altın slot makinesi
// resmi (src/assets/slot-machine.png).
//
// Zamanlama (kullanıcı geri bildirimi: "slot sürekli dönüyor, gerçeğe hiç
// benzemiyor" + "15-20 saniye sonra sonuç olarak 3 farklı simge
// görünmeli"): bir tur başladığında toplam süre BURADA, 15-20sn arası
// rastgele seçiliyor ve sonuç ne kadar erken bilinirse bilinsin
// (ücretsiz spinlerde anında biliniyor) makaralar o süre dolmadan
// durmuyor. Bitişte gerçek slot makinelerindeki gibi makaralar TEK TEK,
// soldan sağa ~1,4sn arayla duruyor — hepsi aynı anda değil.
//
// Zincir tarafı yavaşsa (satın alınmış spinlerde play() → resolve()
// arası dakikaları bulabiliyor) 10sn sonra makaralar dönmeyi bırakıp
// parıldayan bir bekleme karesine geçiyor; sonuç gelince kısa bir
// "açılış" dönüşüyle (en az 2,2sn) tekrar dönüp sırayla iniyorlar.
export type SlotResult = 'idle' | 'win' | 'lose'

interface Props {
  spinning: boolean
  result: SlotResult
  /** result 'win' olduğunda: büyük (jackpot) ödül mü, küçük ödül mü. */
  bigWin?: boolean
  /** Üç makara da durup sonuç görsel olarak açıklandığında çağrılır. */
  onLanded?: () => void
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

/** Bir turun toplam süresi bu aralıktan rastgele seçilir. */
const MIN_TOTAL_MS = 15000
const MAX_TOTAL_MS = 20000
/** Sonuç hâlâ gelmediyse makaraların bekleme karesine geçtiği an. */
const HOLD_AFTER_MS = 10000
/** Sonuç geç gelirse: iniş öncesi en az bu kadar "açılış" dönüşü olsun.
   İlk makara hiçbir zaman anında durmasın diye iki durma arasının
   (2 x REEL_STOP_GAP_MS) üstünde tutuluyor. */
const MIN_REVEAL_MS = 3600
/** Makaraların birbiri ardına durma aralığı. */
const REEL_STOP_GAP_MS = 1400

function pickCombo(result: SlotResult, bigWin: boolean): Combo {
  const pool = result === 'lose' ? LOSE_COMBOS : bigWin ? BIG_WIN_COMBOS : SMALL_WIN_COMBOS
  return pool[Math.floor(Math.random() * pool.length)]
}

function randMs(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

// "held" (bekleme) karesi için 3 FARKLI sembol seçer — asla üçü aynı
// olmaz, ki gerçek sonuç henüz gelmeden "kazanmış" izlenimi vermesin.
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
// (sonuç henüz gelmedi) hem de durmuş makaralar için kullanılıyor.
// .luck-slot__sym'in KENDİSİ (kayan şeritteki ile birebir aynı kutu
// modeli: height:100%, flex, ortalanmış) burada da doğrudan kullanılıyor
// ki üç makara, hangi sembol/glif olursa olsun (emoji ile stilize "7"
// arasında yazı tipi metrikleri farklı olabiliyor) tam olarak aynı
// yatay çizgide hizalı dursun.
function StaticSym({ sym }: { sym: string }) {
  return <span className={sym === '7' ? 'luck-slot__sym luck-slot__sym--seven' : 'luck-slot__sym'}>{sym}</span>
}

type Phase = 'idle' | 'spinning' | 'held' | 'landed'

export function SlotMachine({ spinning, result, bigWin = false, onLanded }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [combo, setCombo] = useState<Combo | null>(null)
  const [waitingCombo, setWaitingCombo] = useState<Combo>(() => pickWaitingCombo())
  // Kaç makara durdu (0-3) — soldan sağa tek tek artıyor.
  const [stoppedReels, setStoppedReels] = useState(0)

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const startedAtRef = useRef(0)
  const totalMsRef = useRef(0)
  // Bir tur sürüyor mu (başlangıçtan üçüncü makara durana kadar true).
  const runningRef = useRef(false)
  // Bu turda iniş zaten planlandı mı (sonuç iki kez işlenmesin).
  const landingScheduledRef = useRef(false)
  const onLandedRef = useRef(onLanded)
  onLandedRef.current = onLanded

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
  }
  const addTimer = (fn: () => void, ms: number) => {
    timersRef.current.push(setTimeout(fn, Math.max(0, ms)))
  }

  useEffect(() => clearTimers, [])

  // Sonucu ekranda AÇMA planı: makaralar toplam süre dolmadan durmuyor,
  // sonra soldan sağa tek tek iniyorlar. Hem "sonuç tur başlarken zaten
  // belli" (ücretsiz spin) hem de "sonuç sonradan geldi" (zincir) durumu
  // için aynı fonksiyon kullanılıyor.
  const scheduleLanding = (res: SlotResult) => {
    if (res === 'idle' || !runningRef.current || landingScheduledRef.current) return
    landingScheduledRef.current = true
    clearTimers()

    const now = Date.now()
    // Toplam süre dolmadan inilmiyor; sonuç çok geç geldiyse de en az
    // MIN_REVEAL_MS'lik bir açılış dönüşü gösteriliyor.
    const lastStopAt = Math.max(now + MIN_REVEAL_MS, startedAtRef.current + totalMsRef.current)
    const firstStopAt = lastStopAt - 2 * REEL_STOP_GAP_MS

    setPhase('spinning') // bekleme karesindeysek tekrar dönmeye başla
    setCombo(pickCombo(res, bigWin))
    for (let i = 0; i < 3; i++) {
      addTimer(() => setStoppedReels(i + 1), firstStopAt + i * REEL_STOP_GAP_MS - now)
    }
    addTimer(() => {
      runningRef.current = false
      setPhase('landed')
      onLandedRef.current?.()
    }, lastStopAt - now + 120)
  }

  // --- Tur başlangıcı / iptali -----------------------------------------
  // Tur, "spinning" false -> true olduğunda başlar. Sonucun o anda 'idle'
  // olmasına GÜVENİLMİYOR: ücretsiz spinde GameTab, spin başlatma ve
  // sonucu aynı senkron blokta set ediyor, React bunları tek render'da
  // birleştiriyor ve SlotMachine result'ı hiçbir zaman 'idle' görmüyor.
  // (Önceki sürüm bu yüzden turu hiç başlatmıyordu: makaralar görünmüyor,
  // buton "Makaralar dönüyor..." durumunda kalıyordu.) Sonuç tur başında
  // zaten belliyse inişi hemen planlıyoruz — süreyi yine toplam süre
  // belirliyor, sonuç erken bilinmesi turu kısaltmıyor.
  useEffect(() => {
    if (spinning && !runningRef.current) {
      clearTimers()
      runningRef.current = true
      landingScheduledRef.current = false
      startedAtRef.current = Date.now()
      totalMsRef.current = randMs(MIN_TOTAL_MS, MAX_TOTAL_MS)
      setCombo(null)
      setStoppedReels(0)
      setPhase('spinning')
      // Sonuç 10sn içinde gelmezse (zincir bekleniyor) dönmeyi durdurup
      // bekleme karesine geç — "sonsuza dek dönüyor" hissini burada kesiyoruz.
      addTimer(() => {
        setWaitingCombo(pickWaitingCombo())
        setPhase((ph) => (ph === 'spinning' ? 'held' : ph))
      }, HOLD_AFTER_MS)
      scheduleLanding(result)
    } else if (!spinning && runningRef.current) {
      // Oyun hata verdi ya da sıkışan deneme temizlendi: turu iptal et.
      clearTimers()
      runningRef.current = false
      landingScheduledRef.current = false
      setPhase('idle')
      setCombo(null)
      setStoppedReels(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinning, result])

  // --- Sonuç sonradan geldi (zincirden): inişi planla -------------------
  useEffect(() => {
    scheduleLanding(result)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, bigWin])

  const allStopped = stoppedReels >= 3
  const reelsSpinning = (phase === 'spinning' || phase === 'held') && !allStopped
  const overlayVisible = phase !== 'idle'
  const containerPhaseClass =
    phase === 'held' ? 'luck-slot__reels--held' : phase === 'landed' ? 'luck-slot__reels--landed' : ''
  // Kazanma/kaybetme görselleri (kaybedince gri+sönük, kazanınca altın
  // nabız) YALNIZCA makaralar indikten sonra uygulanıyor. Ücretsiz spinde
  // sonuç tur başında zaten belli olduğu için, bu sınıf doğrudan result'a
  // bağlıyken makine 15-20sn boyunca griye çekiliyor ve sonucu daha
  // makaralar dönerken ele veriyordu.
  const shownResult = phase === 'landed' ? result : 'idle'

  return (
    <div className={`luck-slot luck-slot--${shownResult} ${phase === 'spinning' && !allStopped ? 'luck-slot--spinning' : ''}`}>
      <div className="luck-slot__frame">
        <img src={slotMachineImg} alt="777 Jackpot slot makinesi" className="luck-slot__img" />
        <div
          className={`luck-slot__reels ${overlayVisible ? 'luck-slot__reels--visible' : ''} ${containerPhaseClass}`}
          aria-hidden="true"
        >
          {[0, 1, 2].map((i) => {
            const stopped = combo !== null && i < stoppedReels
            return (
              <div
                className={`luck-slot__reel ${stopped ? 'luck-slot__reel--stopped' : reelsSpinning && phase !== 'held' ? 'luck-slot__reel--spinning' : ''}`}
                key={i}
              >
                {stopped && combo ? (
                  <StaticSym sym={combo[i]} />
                ) : phase === 'held' ? (
                  <StaticSym sym={waitingCombo[i]} />
                ) : phase !== 'idle' ? (
                  <ReelStrip />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
