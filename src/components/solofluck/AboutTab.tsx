import { LUCK_TOKEN } from '../../config'
import { CopyButton } from '../CopyButton'

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

const ROADMAP = [
  {
    phase: 'Faz 1',
    title: 'Devnet Testi',
    status: 'active' as const,
    text: 'Token oluşturma, presale ve çekiliş akışları Devnet üzerinde uçtan uca test ediliyor.',
  },
  {
    phase: 'Faz 2',
    title: '$LUCK Mint & Presale',
    status: 'upcoming' as const,
    text: 'Coin Mainnet\'te oluşturulur, mint adresi yayınlanır ve presale (serbest katkı + sabit paket/çekiliş) açılır.',
  },
  {
    phase: 'Faz 3',
    title: 'Likidite & Raydium',
    status: 'upcoming' as const,
    text: 'Presale\'de toplanan fonlarla Raydium\'da havuz açılır, likidite belirli bir süre kilitlenir.',
  },
  {
    phase: 'Faz 4',
    title: '777 Çekilişleri & Büyüme',
    status: 'upcoming' as const,
    text: 'Periyodik topluluk çekilişleri, pazarlama ve (varsa) borsa listeleme çalışmaları başlar.',
  },
]

const FAQ = [
  {
    q: '$LUCK nedir?',
    a: 'SoLofLuck ($LUCK), Solana ağında bu siteye özel oluşturulan, şans/kumarhane esintili temaya sahip bir SPL token\'dır. Presale ve topluluk çekilişleri etrafında kurgulanmıştır.',
  },
  {
    q: 'Presale\'e nasıl katılırım?',
    a: 'Presale sekmesinde iki seçenek var: istediğin kadar SOL gönderdiğin "Serbest Katkı" (çekilişsiz) ya da hazır tutarlardan seçtiğin "Sabit Paket" (her 0.5 SOL için 1 çekiliş bileti). Her ikisi de cüzdanından imzaladığın gerçek bir Solana işlemidir.',
  },
  {
    q: 'Çekiliş nasıl işliyor?',
    a: 'Sabit paket modunda gönderdiğin her 0.5 SOL, 777 temalı topluluk çekilişleri için 1 bilet kazandırır. Bilet sayın presale sekmesinde, cihazındaki katkı geçmişinde görünür.',
  },
  {
    q: 'Fonlar nereye gidiyor?',
    a: 'Tokenomics sekmesindeki dağılıma göre: %35 likidite havuzuna (kilitli), %30 presale katılımcılarına, %15 topluluk/çekiliş ödüllerine, %10 kilitli ekip payına, %10 pazarlama & borsa giderlerine ayrılır.',
  },
  {
    q: 'Ne zaman Mainnet\'e geçilecek?',
    a: 'Presale ve çekiliş mekaniği Devnet\'te sorunsuz çalıştığı doğrulandıktan sonra Mainnet\'e taşınacak. Kesin bir tarih henüz belirlenmedi — güncellemeler için topluluk kanallarını takip et.',
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

      <div className="luck-ca">
        <div className="luck-ca__label">Resmi Kontrat Adresi (CA)</div>
        {LUCK_TOKEN.mint ? (
          <div className="luck-ca__row">
            <code className="luck-ca__value">{LUCK_TOKEN.mint}</code>
            <CopyButton value={LUCK_TOKEN.mint} />
          </div>
        ) : (
          <div className="luck-ca__pending">
            Coin henüz oluşturulmadı — mint adresi burada yayınlanınca yalnızca bu adrese güvenin.
          </div>
        )}
        <p className="luck-ca__warning">
          ⚠️ $LUCK adında sahte token'lar oluşturulabilir. İşlem yapmadan önce mint adresini
          mutlaka bu sayfadaki resmi adresle karşılaştırın.
        </p>
      </div>

      <div className="luck-about__grid">
        {PILLARS.map((p) => (
          <div className="feature-card luck-about__card" key={p.title}>
            <div className="feature-card__icon">{p.icon}</div>
            <div className="feature-card__title">{p.title}</div>
            <div className="feature-card__text">{p.text}</div>
          </div>
        ))}
      </div>

      <h3 className="luck-section-title">Yol Haritası</h3>
      <ol className="luck-roadmap">
        {ROADMAP.map((r) => (
          <li key={r.phase} className={`luck-roadmap__item luck-roadmap__item--${r.status}`}>
            <div className="luck-roadmap__marker" />
            <div className="luck-roadmap__body">
              <div className="luck-roadmap__head">
                <span className="luck-roadmap__phase">{r.phase}</span>
                {r.status === 'active' && <span className="luck-roadmap__badge">Şu an burada</span>}
              </div>
              <div className="luck-roadmap__title">{r.title}</div>
              <p className="luck-roadmap__text">{r.text}</p>
            </div>
          </li>
        ))}
      </ol>

      <h3 className="luck-section-title">Sıkça Sorulan Sorular</h3>
      <div className="luck-faq">
        {FAQ.map((f) => (
          <details className="luck-faq__item" key={f.q}>
            <summary className="luck-faq__q">{f.q}</summary>
            <p className="luck-faq__a">{f.a}</p>
          </details>
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
