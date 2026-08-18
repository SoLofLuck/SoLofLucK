import { LUCK_TOKEN } from '../../config'

const PILLARS = [
  {
    icon: '🍀',
    title: 'Şans Herkese Açık',
    text: 'Presale\'e küçük ya da büyük katkı fark etmeksizin herkes katılabilir; sabit paketlerde her 0.5 SOL bir çekiliş bileti kazandırır.',
  },
  {
    icon: '🎰',
    title: '777 Teması',
    text: 'Toplam arz 777.000.000 $LUCK — jackpot temasına adanmış, topluluk çekilişleriyle canlı tutulan bir coin.',
  },
  {
    icon: '🔒',
    title: 'Kilitli Likidite',
    text: 'Presale sonrası Raydium\'da açılan havuzun likiditesi, bu sitedeki Likidite Kilitleme aracıyla belirli bir süre kilitlenir.',
  },
  {
    icon: '🧪',
    title: 'Önce Testnet',
    text: 'Presale ve çekiliş mekaniği önce Devnet üzerinde test ediliyor; olgunlaştığında Mainnet\'e taşınacak.',
  },
]

export function AboutTab() {
  return (
    <div className="luck-about">
      <p className="luck-about__lead">
        <strong>{LUCK_TOKEN.name}</strong> ({LUCK_TOKEN.symbol}), bu sitenin kendi kimliğine
        adanmış Solana SPL token'ıdır. Sayfanın arka planında akan dijital yağmur ve arada geçen
        dört yapraklı yoncalar ile "777" figürleri, projenin şans/kumarhane esintili temasını
        temsil eder — coin'in kendisi ise tamamen zincir üzerinde, şeffaf ve cüzdanınızdan
        yönetilen gerçek bir SPL token'dır.
      </p>

      <div className="luck-about__grid">
        {PILLARS.map((p) => (
          <div className="feature-card luck-about__card" key={p.title}>
            <div className="feature-card__icon">{p.icon}</div>
            <div className="feature-card__title">{p.title}</div>
            <div className="feature-card__text">{p.text}</div>
          </div>
        ))}
      </div>

      <div className="alert alert--warning luck-about__disclaimer">
        ⚠️ $LUCK deneysel/eğlence amaçlı bir topluluk coin'idir, bir yatırım aracı değildir ve
        herhangi bir getiri vaadi içermez. Presale'e yalnızca kaybetmeyi göze alabileceğiniz
        miktarda katılın. Şu an Devnet (test ağı) üzerindeyiz; gerçek SOL göndermeden önce ağ
        seçiminizi mutlaka kontrol edin.
      </div>
    </div>
  )
}
