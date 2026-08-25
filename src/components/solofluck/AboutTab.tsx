import { LUCK_TOKEN } from '../../config'
import { CopyButton } from '../CopyButton'

const PILLARS = [
  {
    icon: '🍀',
    title: 'Şans Herkese Açık',
    text: 'Presale\'e küçük ya da büyük katkı fark etmeksizin herkes katılabilir; gönderilen her 0.5 SOL bir çekiliş bileti kazandırır.',
  },
  {
    icon: '🎰',
    title: '777 Teması',
    text: 'Toplam arz 777.000.000 $LUCK — jackpot temasına adanmış, topluluk çekilişleriyle canlı tutulan bir coin.',
  },
  {
    icon: '🔥',
    title: 'Yakılan Likidite',
    text: 'Presale sonrası Raydium\'da havuz açılır ve LP token\'ları YAKILIR — kilitlenmez. Havuzdaki likiditeyi ekip dahil hiç kimse, hiçbir tarihte çekemez; yakma işleminin linki yayınlanır.',
  },
  {
    icon: '🔍',
    title: 'Şeffaf Kasalar',
    text: 'Presale, operasyon, ekip, topluluk, pazarlama ve CEX kasalarının adresleri yayınlanır. Her hareket Solscan üzerinden takip edilebilir — söze değil zincire bakılır.',
  },
]

const ROADMAP = [
  {
    phase: 'Faz 1',
    title: 'Hazırlık & Test',
    status: 'active' as const,
    text: 'Token oluşturma, presale, çekiliş ve oyun akışları uçtan uca test ediliyor; kasalar açılıyor ve adresleri yayınlanıyor.',
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
    text: 'Presale\'de toplanan fonlarla Raydium\'da (CPMM) havuz açılır ve LP token\'ları yakılır — likidite kalıcı olarak havuzda kalır.',
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
    a: 'SoLofLuck ($LUCK), Solana ağında bu siteye özel oluşturulan, şans esintili temaya sahip bir SPL token\'dır. Presale ve topluluk çekilişleri etrafında kurgulanmıştır.',
  },
  {
    q: 'Presale\'e nasıl katılırım?',
    a: 'Presale sekmesinden istediğin kadar SOL gönderirsin; fiyat sabittir ve her 0.5 SOL sana 1 çekiliş bileti kazandırır. "Serbest katkı" ile "hazır paketler" arasındaki tek fark tutarı elle mi yazdığın yoksa hazır bir seçenekten mi seçtiğin — bilet oranı ikisinde de aynı. ÖNEMLİ: borsa hesabından göndermeyin, tokenler gönderen adrese dağıtılır.',
  },
  {
    q: 'Çekiliş nasıl işliyor?',
    a: 'İki ayrı çekiliş var. (1) BİLETLİ ÇEKİLİŞ: presale\'de gönderdiğin her 0.5 SOL = 1 bilet. TGE\'den sonra 14 hafta boyunca her hafta 7 biletli kazanan çıkar, her biri 1.110.000 $LUCK alır. Kazananlar gelecekteki bir Solana slot\'unun blockhash\'iyle seçilir — sonucu kimse önceden bilemez, herkes sonradan doğrulayabilir; ödemeler otomatik dağıtılır. (2) TWITTER/X ÇEKİLİŞİ: aynı haftalarda 3 kazanan daha, sosyal medya kampanyalarından. Toplam 14 hafta × 10 kazanan = 140 kazanan.',
  },
  {
    q: 'Fonlar nereye gidiyor?',
    a: 'Tokenomics sekmesindeki dağılıma göre: %35 presale katılımcılarına (claim programı üzerinden, TGE\'de %9 + 13 hafta boyunca haftalık %7), %20 likidite havuzuna (TGE\'de LP yakılır), %20 topluluk/çekiliş ödüllerine (108.780.000 biletli çekiliş + 46.620.000 Twitter çekilişi), %10 kilitli ekip payına, %15 pazarlama & CEX giderlerine ayrılır.',
  },
]

export function AboutTab() {
  return (
    <div className="luck-about">
      <p className="luck-about__lead">
        <strong>{LUCK_TOKEN.name}</strong> ({LUCK_TOKEN.symbol}), bu sitenin kendi kimliğine
        adanmış Solana SPL token'ıdır. Sayfanın arka planında akan dijital yağmur ve arada geçen
        dört yapraklı yoncalar ile "777" figürleri, projenin şans esintili temasını
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
        miktarda katılın.
      </div>
    </div>
  )
}
