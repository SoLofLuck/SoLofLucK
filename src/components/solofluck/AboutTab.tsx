import { LUCK_TOKEN } from '../../config'
import { CopyButton } from '../CopyButton'

const PILLARS = [
  {
    icon: '🍀',
    title: 'Open To Everyone',
    text: 'Anyone can join the presale, whether the contribution is small or large; every 0.5 SOL sent earns one raffle ticket.',
  },
  {
    icon: '🎰',
    title: 'The 777 Theme',
    text: 'Total supply is 777,000,000 $LUCK — a coin built around the jackpot theme and kept alive by community raffles.',
  },
  {
    icon: '🔥',
    title: 'Burned Liquidity',
    text: 'After the presale a pool is opened on Raydium and the LP tokens are BURNED — not locked. Nobody, the team included, can ever withdraw the liquidity from that pool on any date; the burn transaction link is published.',
  },
  {
    icon: '🔍',
    title: 'Transparent Wallets',
    text: 'The addresses of the presale, operations, team, community, marketing and CEX wallets are all published. Every movement can be followed on Solscan — look at the chain, not at promises.',
  },
]

const ROADMAP = [
  {
    phase: 'Phase 1',
    title: 'Preparation & Testing',
    status: 'active' as const,
    text: 'Token creation, presale, raffle and game flows are being tested end to end; wallets are opened and their addresses published.',
  },
  {
    phase: 'Phase 2',
    title: '$LUCK Mint & Presale',
    status: 'upcoming' as const,
    text: 'The coin is created on Mainnet, the mint address is published, and the presale opens (free contribution + fixed packages/raffle).',
  },
  {
    phase: 'Phase 3',
    title: 'Liquidity & Raydium',
    status: 'upcoming' as const,
    text: 'The funds raised in the presale open a Raydium (CPMM) pool and the LP tokens are burned — the liquidity stays in the pool permanently.',
  },
  {
    phase: 'Phase 4',
    title: '777 Raffles & Growth',
    status: 'upcoming' as const,
    text: 'Recurring community raffles, marketing, and exchange listing work (if any) begin.',
  },
]

const FAQ = [
  {
    q: 'What is $LUCK?',
    a: 'SoLofLuck ($LUCK) is an SPL token created on Solana specifically for this site, built around a luck theme. Everything is arranged around the presale and the community raffles.',
  },
  {
    q: 'How do I join the presale?',
    a: 'Send as much SOL as you want from the Presale tab; the price is fixed and every 0.5 SOL earns you 1 raffle ticket. The only difference between "free contribution" and "ready-made packages" is whether you type the amount yourself or pick a preset — the ticket rate is identical. IMPORTANT: do not send from an exchange account, tokens are distributed to the sending address.',
  },
  {
    q: 'How do the raffles work?',
    a: 'There are two separate raffles. (1) TICKET RAFFLE: every 0.5 SOL you send in the presale = 1 ticket. For 14 weeks after TGE, 7 ticket winners are drawn every week and each receives 1,110,000 $LUCK. Winners are picked using the blockhash of a future Solana slot — nobody can know the result in advance and everybody can verify it afterwards; payouts are distributed automatically. (2) TWITTER/X RAFFLE: 3 more winners in the same weeks, from social media campaigns. In total 14 weeks x 10 winners = 140 winners.',
  },
  {
    q: 'Where do the funds go?',
    a: 'According to the split on the Tokenomics tab: 35% to presale participants (through the claim program, 9% at TGE + 7% weekly for 13 weeks), 20% to the liquidity pool (LP burned at TGE), 20% to community/raffle rewards (108,780,000 ticket raffle + 46,620,000 Twitter raffle), 10% to the locked team share, 15% to marketing & CEX costs.',
  },
]

export function AboutTab() {
  return (
    <div className="luck-about">
      <p className="luck-about__lead">
        <strong>{LUCK_TOKEN.name}</strong> ({LUCK_TOKEN.symbol}) is the Solana SPL token dedicated
        to this site's own identity. The digital rain flowing behind the page, and the four-leaf
        clovers and "777" figures that drift past, represent the project's luck-themed character —
        while the coin itself is a real SPL token, fully on chain, transparent, and controlled from
        your own wallet.
      </p>

      <div className="luck-ca">
        <div className="luck-ca__label">Official Contract Address (CA)</div>
        {LUCK_TOKEN.mint ? (
          <div className="luck-ca__row">
            <code className="luck-ca__value">{LUCK_TOKEN.mint}</code>
            <CopyButton value={LUCK_TOKEN.mint} />
          </div>
        ) : (
          <div className="luck-ca__pending">
            The coin has not been created yet — once the mint address is published here, trust only
            that address.
          </div>
        )}
        <p className="luck-ca__warning">
          ⚠️ Fake tokens named $LUCK can be created. Before you transact, always compare the mint
          address against the official one on this page.
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

      <h3 className="luck-section-title">Roadmap</h3>
      <ol className="luck-roadmap">
        {ROADMAP.map((r) => (
          <li key={r.phase} className={`luck-roadmap__item luck-roadmap__item--${r.status}`}>
            <div className="luck-roadmap__marker" />
            <div className="luck-roadmap__body">
              <div className="luck-roadmap__head">
                <span className="luck-roadmap__phase">{r.phase}</span>
                {r.status === 'active' && <span className="luck-roadmap__badge">You are here</span>}
              </div>
              <div className="luck-roadmap__title">{r.title}</div>
              <p className="luck-roadmap__text">{r.text}</p>
            </div>
          </li>
        ))}
      </ol>

      <h3 className="luck-section-title">Frequently Asked Questions</h3>
      <div className="luck-faq">
        {FAQ.map((f) => (
          <details className="luck-faq__item" key={f.q}>
            <summary className="luck-faq__q">{f.q}</summary>
            <p className="luck-faq__a">{f.a}</p>
          </details>
        ))}
      </div>

      <div className="alert alert--warning luck-about__disclaimer">
        ⚠️ $LUCK is an experimental community coin made for entertainment. It is not an investment
        vehicle and carries no promise of any return. Only contribute what you can afford to lose.
      </div>
    </div>
  )
}
