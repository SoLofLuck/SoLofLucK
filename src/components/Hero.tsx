const FEATURES = [
  { icon: '⚡', title: 'Kod Yazmadan', text: 'Formu doldur, cüzdanını bağla, birkaç saniyede Solana token’ın hazır.' },
  { icon: '🔐', title: 'Güvenli & Açık Kaynak', text: 'Özel anahtarların asla siteden çıkmaz; her şey cüzdanında imzalanır.' },
  { icon: '🛠️', title: 'Tam Kontrol', text: 'Mint, freeze ve update yetkilerini istediğin an devretme/kaldırma imkânı.' },
  { icon: '🍀', title: '$LUCK Presale', text: 'Bu siteye adanmış coin SoLofLuck ($LUCK) için ayrı sekmede presale ve çekiliş.' },
]

export function Hero() {
  return (
    <section className="hero">
      <div className="hero__badge">Solana SPL Token Creator</div>
      <h1>
        Kendi <span className="gradient-text">Solana Token’ını</span> Dakikalar İçinde Oluştur
      </h1>
      <p className="hero__subtitle">
        İsim, sembol, arz ve logo bilgilerini gir; cüzdanını bağla ve zincir üzerinde gerçek bir SPL
        token oluştur. Ekstra kurulum ya da backend gerekmez — tamamen tarayıcıda çalışır.
      </p>
      <div className="hero__features">
        {FEATURES.map((f) => (
          <div className="feature-card" key={f.title}>
            <div className="feature-card__icon">{f.icon}</div>
            <div className="feature-card__title">{f.title}</div>
            <div className="feature-card__text">{f.text}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
