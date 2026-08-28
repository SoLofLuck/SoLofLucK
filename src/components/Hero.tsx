const FEATURES = [
  { icon: '⚡', title: 'No Code Needed', text: 'Fill in the form, connect your wallet, and your Solana token is ready in seconds.' },
  { icon: '🔐', title: 'Safe & Open Source', text: 'Your private keys never leave the site; everything is signed in your wallet.' },
  { icon: '🛠️', title: 'Full Control', text: 'Transfer or revoke the mint, freeze and update authorities whenever you like.' },
  { icon: '🍀', title: '$LUCK Presale', text: 'The presale and raffle for SoLofLuck ($LUCK), the coin dedicated to this site, in its own tab.' },
]

export function Hero() {
  return (
    <section className="hero">
      <div className="hero__badge">Solana SPL Token Creator</div>
      <h1>
        Create Your Own <span className="gradient-text">Solana Token</span> In Minutes
      </h1>
      <p className="hero__subtitle">
        Enter the name, symbol, supply and logo, connect your wallet, and create a real SPL token on
        chain. No extra setup and no backend — it all runs in the browser.
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
