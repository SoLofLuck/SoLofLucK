import { clusterApiUrl } from '@solana/web3.js'

export type NetworkId = 'devnet' | 'mainnet-beta'

export interface NetworkOption {
  id: NetworkId
  label: string
  endpoint: string
  explorerCluster: string
}

// The Solana Foundation's official public RPCs (clusterApiUrl) are saturated
// with dapp traffic from all over the world and rate-limit hard per IP —
// "429 Connection rate limits exceeded" fires often from behind shared IPs such
// as mobile carrier NAT. Ankr's keyless public devnet RPC was tried too but
// turned out incompatible with @solana/web3.js's RPC response schema validation
// (a permanent error, unrelated to rate limits). If a Helius API key is supplied
// at build time (VITE_HELIUS_API_KEY, sourced from the HELIUS_API_KEY GitHub
// Actions secret — see .github/workflows/deploy.yml) we use it; otherwise we
// fall back to the official public endpoint. There is also retry/backoff against
// rate limits in lib/luckGame.ts (see withRetry).
const heliusApiKey: string | undefined = import.meta.env.VITE_HELIUS_API_KEY

export const NETWORKS: Record<NetworkId, NetworkOption> = {
  devnet: {
    id: 'devnet',
    label: 'Devnet (Test Network)',
    endpoint: heliusApiKey
      ? `https://devnet.helius-rpc.com/?api-key=${heliusApiKey}`
      : clusterApiUrl('devnet'),
    explorerCluster: '?cluster=devnet',
  },
  'mainnet-beta': {
    id: 'mainnet-beta',
    label: 'Mainnet (Live Network)',
    endpoint: heliusApiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
      : clusterApiUrl('mainnet-beta'),
    explorerCluster: '',
  },
}

// ---------------------------------------------------------------------------
// Service fee (optional)
// ---------------------------------------------------------------------------
// If you publish this site as your own product, you may want to take a small fee
// on token creation (that is the business model of tools like smithii.io). The
// fee is sent transparently from the user's wallet to the wallet YOU choose,
// inside the same transaction; the user sees the recipient address and the
// amount in their wallet before signing.
//
// If you do not want to take a fee, leave FEE_WALLET empty and it is
// automatically disabled.
export const FEE_WALLET = '' // e.g. 'YourSolanaWalletAddressHere...'
export const FEE_AMOUNT_SOL = 0.1

export const DEFAULT_DECIMALS = 9
export const DEFAULT_NETWORK: NetworkId = 'devnet'

// The network the program IDs in this file are actually deployed on.
//
// A Solana program address is per network: the same address holds a program on
// devnet and nothing at all on mainnet. The IDs below (GAME_CONFIG.programId,
// CLAIM_CONFIG.programId) are single values, not one per network — so moving
// DEFAULT_NETWORK to 'mainnet' without redeploying the programs and writing
// their new addresses in here points the site at mainnet while it keeps calling
// devnet addresses. Nothing errors: the programs simply do not exist there, and
// every game and claim transaction fails, on TGE day, for everyone.
//
// So this constant records what the addresses below are worth. It moves ONLY
// after both programs really have been deployed to that network and their new
// IDs are written into this file. check-launch-readiness compares the two and
// launch-gate refuses to pass while they disagree — in either direction.
export const PROGRAM_DEPLOYMENT_NETWORK: NetworkId = 'devnet'

// ---------------------------------------------------------------------------
// Testing phase: the "Stay Tuned" gate
// ---------------------------------------------------------------------------
// While the site is in testing/development, everyone arriving at the
// solofluck.com root is shown a plain black "Stay Tuned" page (see src/main.tsx
// and src/components/StayTuned.tsx). The real app is reachable only through the
// hidden path matching this value, e.g. https://solofluck.com/1 .
//
// This is NOT a real security or access control — the site is fully client-side
// (static), so anyone can see the real path in the browser dev tools or in this
// public repository. It is only a layer of obscurity that slows down search
// engines and curious casual visitors during testing. Once the site is ready to
// launch, deleting this line and rendering App directly is enough (see
// src/main.tsx).
export const PREVIEW_ACCESS_PATH = '/1'

// ---------------------------------------------------------------------------
// $LUCK / SoLofLuck — the coin dedicated to this site
// ---------------------------------------------------------------------------
// Once the site owner has created the coin from the "Create Token" tab and
// entered its mint address below, the presale and tokenomics tabs start working
// with real chain data. While the mint address is empty the page is shown with a
// "coming soon" notice.
export const LUCK_TOKEN = {
  name: 'SoLofLuck',
  symbol: '$LUCK',
  // Enter the mint address here once the coin has been created.
  mint: '', // e.g. 'ELuCKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  // A total supply that fits the "777" theme.
  totalSupply: 777_000_000,
  decimals: DEFAULT_DECIMALS,
}

// The wallet that collects presale contributions (both free and fixed package).
// If left empty, the presale tab shows a "not configured" warning and the send
// buttons stay disabled — a deliberate safety brake so nobody accidentally sends
// SOL when there is no coin.
export const PRESALE_WALLET = 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36'

// ---------------------------------------------------------------------------
// Operations (expenses) share
// ---------------------------------------------------------------------------
// The share taken out of every presale contribution to cover the costs incurred
// until the token goes live (Raydium pool creation fee, token mint + metadata,
// RPC subscription, domain name, marketing): 10,000 / 100,000 = 10%. That is
// within — in fact below — the market norm: launchpads (PinkSale, DxSale etc.)
// already take 2-5% of the raise as a platform fee, on top of which teams
// typically set aside 10-30% for marketing and operations. At the 777 SOL target
// it comes to exactly 77.7 SOL.
//
// IMPORTANT — this share NEVER ENTERS PRESALE_WALLET: it goes straight to this
// wallet as a separate transfer inside the SAME transaction. That way the amount
// to be put into the liquidity pool at TGE is exactly the presale wallet's
// balance — no manual sorting or subtraction is needed and the share cannot
// accidentally end up in the pool. The contributor sees both recipients and both
// amounts in their wallet before signing.
//
// If left empty no share is taken and 100% of the contribution goes to the
// presale wallet.
export const PRESALE_OPS_WALLET = '2Lzc6jorznu7zQKny79topGTE7V837oiV3j53zPH4Qh9'
export const PRESALE_OPS_FEE_NUM = 10_000
export const PRESALE_OPS_FEE_DEN = 100_000

// ---------------------------------------------------------------------------
// Presale rules: fixed price, target, floor, duration
// ---------------------------------------------------------------------------
// The presale is FIXED PRICE — a contributor knows exactly how many $LUCK they
// will get at the moment they send the money. The price is derived from the
// target and comes out perfectly round:
//
//     271,950,000 presale tokens / 777 SOL = 350,000 $LUCK per SOL
//
// IF THE TARGET IS REACHED the presale closes immediately and TGE follows; no
// contribution above 777 SOL is accepted (hard cap).
//
// IF THE TARGET IS NOT REACHED (when the 7 weeks are up) TGE still happens — but
// the supply is SCALED DOWN in proportion to the amount raised: if X% of the
// target was collected, only X% is minted OUT OF EVERY BUCKET (presale,
// liquidity, community, team, marketing) and the remaining 100-X% is burned. The
// percentage split (35-20-20-10-15) is preserved exactly.
//
// This rule is critical: if we burned only the unsold presale tokens and left
// the liquidity bucket untouched, less SOL would go into the pool while the
// token side stayed the same, and the opening price would fall BELOW the presale
// price — buyers would be underwater in the very first second. Thanks to
// proportional burning the opening price always opens 34% above the presale
// price, INDEPENDENT of the amount raised.
//
// FLOOR (soft cap): if the raise stays below 77 SOL there is no TGE and
// contributions are refunded. Two reasons at once: (1) below that amount the
// operations share does not cover the launch costs, and (2) in a pool that
// shallow a single small buy moves the price too much and no healthy market
// forms.
export const PRESALE_TARGET_SOL = 777
export const PRESALE_SOFT_CAP_SOL = 77
export const PRESALE_TOKENS_PER_SOL = 350_000
export const PRESALE_DURATION_WEEKS = 7

// Presale start — ISO 8601 (e.g. '2026-09-01T18:00:00Z'). If left empty, the
// site says the start date will be announced soon and shows no countdown. The
// end is PRESALE_DURATION_WEEKS weeks after the start.
export const PRESALE_START_ISO = ''

// The real TGE timestamp — ISO 8601, filled in ONCE, on the day the presale
// actually closes (which may be earlier than PRESALE_START_ISO +
// PRESALE_DURATION_WEEKS, if the target is reached early). Left empty until
// then. scripts/raffle-schedule.mjs uses it, together with RAFFLE, to compute
// each of the 14 raffle rounds' due date — the dates the Tokenomics tab shows
// under "Raffle Schedule" for the operator to copy into a public announcement
// ahead of each draw.
export const TGE_ISO = ''

// 1 raffle ticket per 0.5 SOL — regardless of WHICH MODE it was sent with.
//
// Tickets used to be granted only in "fixed package" mode. That had two
// problems: (1) we read the mode from the memo written into the transaction, and
// a memo is free text written by the sender — anyone building a transaction by
// hand could write a mode they had not earned; (2) two people sending the same
// amount, one getting tickets and the other not, was a distinction that was hard
// to explain and unnecessary. The ticket count is now computed ONLY from the
// real amount that reaches the presale wallet — it cannot be faked and anyone
// can verify it themselves.
export const PRESALE_TICKET_UNIT_SOL = 0.5

// The preset amount options on the fixed-package tab (SOL).
export const PRESALE_TIERS = [0.5, 1, 3, 5, 10, 15, 20, 25, 50, 100, 200, 250, 500]

// The supply distribution shown on the Tokenomics tab (percentages must total 100).
export const TOKENOMICS = [
  {
    key: 'presale',
    label: 'Presale',
    percent: 35,
    color: '#22d3ee',
    desc: 'Distributed to the community through the fixed-price presale. 9% unlocks at TGE, then a further 7% every 7 days for 13 weeks; everything is free on day 91 (week 13). Distribution goes through the claim program — the buyer withdraws the unlocked part themselves, and until then the tokens sit in a program nobody can withdraw from.',
  },
  {
    key: 'liquidity',
    label: 'Liquidity Pool',
    percent: 20,
    color: '#8b5cf6',
    desc: 'Put into the Raydium (CPMM) pool on TGE day, and the LP tokens are BURNED — the liquidity stays in the pool permanently and nobody, the team included, can withdraw it. The link to the burn transaction is published on this page.',
  },
  {
    key: 'community',
    label: 'Community / Raffle Rewards',
    percent: 20,
    color: '#facc15',
    desc: 'A raffle every 7 days starting on day 7, 14 raffles in total. Each raffle has 10 winning wallets and every winner receives 1,110,000 $LUCK: 7 drawn from the presale tickets (computed from the chain, distributed automatically) and 3 from Twitter/X campaigns. 140 winners across 14 weeks.',
  },
  {
    key: 'team',
    label: 'Team (Locked)',
    percent: 10,
    color: '#f87171',
    desc: 'Fully locked for the first 7 months — nothing unlocks at all. After that it is distributed in equal monthly slices over 7 months (completing in month 14).',
  },
  {
    key: 'marketing',
    label: 'Marketing & CEX',
    percent: 15,
    color: '#34d399',
    desc: 'Two parts: the CEX listing reserve (77,700,000, in three separate vaults whose addresses are published) and the flowing part (38,850,000; locked for 7 weeks, then monthly over 7 months).',
  },
] as const

// ---------------------------------------------------------------------------
// The claim (distribution) program
// ---------------------------------------------------------------------------
// Presale shares and raffle rewards are locked into this program at TGE; the
// recipient withdraws the unlocked part themselves. The program has NO
// "withdraw the money back" instruction — a locked token can only leave to the
// rightful owner, and only on schedule (see
// program/luck-distributor/src/lib.rs).
//
// While `programId` is empty the Claim tab says "not configured yet" and no
// button works — the same safety-brake pattern as the presale wallet.
export const CLAIM_CONFIG = {
  programId: 'G8hKTeAbpMCwNTn7WzKnT6PFxnVfLJuvQFg5XBTX2E8e',
  /** Round ids: 0 = presale vesting, 1..14 = the weekly raffles. */
  presaleRoundId: 0,
  /**
   * The folder holding the published merkle files: `round-<id>.json` for each
   * round. These files are deliberately public, so that a recipient can rebuild
   * the number they see with scripts/build-merkle.mjs and verify it themselves.
   */
  merkleBasePath: '/merkle',
} as const

// ---------------------------------------------------------------------------
// Raffle rules
// ---------------------------------------------------------------------------
// The community bucket (155,400,000 $LUCK) is split into TWO SEPARATE raffles.
// They are kept apart because their verifiability differs:
//
//   * THE TICKET RAFFLE can be derived entirely from the chain. Every transfer
//     into the presale wallet is public, so anyone can build the "who bought how
//     many tickets" list independently of us. The winners are picked with the
//     blockhash of a future Solana slot: because that slot does not exist yet,
//     nobody (us included) can know the result in advance, and once it does
//     everybody can redo the same computation and verify it. The same source of
//     randomness we use in the game.
//
//   * THE TWITTER RAFFLE cannot be verified from the chain — participation
//     happens on Twitter/X and the team enters the winning addresses. That is
//     why we do not mix them in one bucket: the ticket raffle's claim that "you
//     do not have to trust anyone" would be weakened by a hand-entered list
//     sitting next to it.
//
// The numbers: 11,100,000 per raffle / 10 winners = exactly 1,110,000 $LUCK per
// winner. 14 raffles x 10 = 140 winners.
export const RAFFLE = {
  rounds: 14,
  intervalDays: 7,
  /** How many days after TGE the first raffle happens. */
  firstRoundDay: 7,
  perRoundTokens: 11_100_000,
  perWinnerTokens: 1_110_000,
  ticket: {
    winnersPerRound: 7,
    totalWinners: 98,
    totalTokens: 108_780_000,
  },
  twitter: {
    winnersPerRound: 3,
    totalWinners: 42,
    totalTokens: 46_620_000,
  },
} as const

// The lock / unlock schedule — the timeline on the Tokenomics tab.
// Design principle: no unlock should be larger than the liquidity pool can
// absorb. That is why every bucket unlocks in stages and the end dates of the
// large locks are spread apart.
export const VESTING_SCHEDULE = [
  {
    key: 'presale',
    label: 'Presale',
    steps: [
      { when: 'TGE', what: '9% unlocks', amount: 24_475_500 },
      { when: 'day 7 – 91', what: '7% every 7 days (13 steps)', amount: 19_036_500 },
    ],
  },
  {
    key: 'liquidity',
    label: 'Liquidity Pool',
    steps: [{ when: 'TGE', what: 'put into the pool, LP burned — never unlocks', amount: 155_400_000 }],
  },
  {
    key: 'community',
    label: 'Community / Raffle',
    steps: [
      { when: 'day 7', what: 'first raffle — 7 ticket + 3 Twitter winners', amount: 11_100_000 },
      { when: 'every 7 days', what: '14 raffles, 10 winners x 1,110,000 each', amount: 11_100_000 },
      { when: 'day 98', what: 'last raffle — 140 winners in total', amount: 11_100_000 },
    ],
  },
  {
    key: 'team',
    label: 'Team',
    steps: [
      { when: 'month 0 – 7', what: 'fully locked, nothing unlocks', amount: 0 },
      { when: 'month 8 – 14', what: 'equal monthly slices (7 months)', amount: 11_100_000 },
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing, flowing part',
    steps: [
      { when: 'week 0 – 7', what: 'locked', amount: 0 },
      { when: 'the following 7 months', what: 'equal monthly slices', amount: 5_550_000 },
    ],
  },
] as const

// The internal breakdown of the marketing bucket (116,550,000).
export const MARKETING_BREAKDOWN = {
  // Three separate vaults, each for one exchange listing. NOT locked —
  // deliberately so, because we do not want to make a lock promise we would have
  // to break the moment a listing opportunity arrives on short notice. The vault
  // addresses are published and every use is proven.
  cexReserve: {
    total: 77_700_000,
    wallets: 3,
    perWallet: 25_900_000,
    // The published vault addresses — every movement is traceable on chain.
    addresses: [
      { label: 'CEX vault 1', address: 'CZ639Mx6MFiZfwpVFLecyMTecGp2Cv6HErdoWqgZG6HS' },
      { label: 'CEX vault 2', address: '3cCqgaj4QzKQUFvSNnz1yqrqcPt7xiKsbh29AfVoGM8B' },
      { label: 'CEX vault 3', address: 'DmdePMQyuKEX9Hwaytx6tEfPxx5utBVxSJ5bgWrKghmh' },
    ],
  },
  // The flowing part, split into 6 units (1 unit = 6,475,000).
  flow: {
    total: 38_850_000,
    unit: 6_475_000,
    items: [
      { label: 'Partnerships / influencers / community campaigns', units: 5, amount: 32_375_000 },
      { label: 'Reserve', units: 1, amount: 6_475_000 },
    ],
  },
} as const

// ---------------------------------------------------------------------------
// The public wallet list
// ---------------------------------------------------------------------------
// The wallets published on the Tokenomics tab. The point is that every lock and
// distribution promise can be verified one by one on chain — every balance and
// every movement can be followed through these addresses on Solscan. None of the
// addresses here contains a private key; they are public addresses only.
export const PUBLIC_WALLETS = [
  { key: 'presale', label: 'Presale vault', address: PRESALE_WALLET },
  { key: 'ops', label: 'Operations share', address: PRESALE_OPS_WALLET },
  { key: 'team', label: 'Team', address: 'AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA' },
  { key: 'community', label: 'Community / raffle', address: '3fBhNn8BEoFyQVAXasWj1xcNrcc2FRpLVQexFhZTnw6F' },
  { key: 'marketing', label: 'Marketing (flowing part)', address: 'BiWqNZzCPCfJtVPNhoCrvEb9s6unpCFXXf38GR3WnPWX' },
] as const

// Where the SOL raised in the presale goes (the 90% left after the operations
// share). A SEPARATE table from the token distribution (TOKENOMICS): one is
// tokens, this one is money.
export const PRESALE_SOL_ALLOCATION = [
  { key: 'liquidity', label: 'Liquidity pool', percent: 85 },
  { key: 'marketing', label: 'Marketing & CEX', percent: 10 },
  { key: 'reserve', label: 'Reserve / operations', percent: 5 },
] as const

// Community social media links — a field left empty is simply not shown at the
// bottom of the SoLofLuck page, so there are no broken or placeholder links.
export const SOCIAL_LINKS = {
  twitter: '', // e.g. 'https://twitter.com/soloflucksol'
  telegram: '', // e.g. 'https://t.me/soloflucksol'
  discord: '', // e.g. 'https://discord.gg/xxxxxxx'
}

// ---------------------------------------------------------------------------
// The game: 777 Wheel of Luck (program/luck-game)
// ---------------------------------------------------------------------------
// This requires a separate Solana program (smart contract) — see
// program/luck-game/README.md. `programId` must stay empty until the program is
// deployed and `initialize()` has been called; in that state the Game tab shows
// a "not configured" warning and the play button is disabled (the same
// safety-brake pattern as PRESALE_WALLET).
//
// The economic values here (fee / prize / threshold) are only for DISPLAY — the
// values that actually apply and bind are always read from the on-chain
// GameConfig account (see src/lib/luckGame.ts). Remember to use the same values
// when calling `initialize()`, otherwise what the screen shows and the real
// rules on the chain will not agree.
export const GAME_CONFIG = {
  // Devnet.
  //
  // The program ID now comes FROM THE SOURCE CODE: `declare_id!()` is the single
  // source of truth. No keypair is NEEDED for an upgrade — the chain only looks
  // for the upgrade authority's (the deploy wallet's) signature. `anchor keys
  // sync` runs only when we deliberately open a new program
  // (first_deploy=true). See .github/workflows/deploy-luck-game.yml.
  //
  // There used to be a note here saying "the keypair is carried in the
  // rust-cache; if it is lost the program cannot be updated; it must be moved
  // into a secret for mainnet". THAT NOTE IS NOW WRONG: when the workflow was
  // rewritten the cache steps were removed entirely. I forgot to update the
  // note, and an outside reviewer of the code mistook a closed risk for an open
  // one and raised it — a stale comment is more harmful than no comment.
  //
  // The one thing that does stay open is not the keypair but the UPGRADE
  // AUTHORITY: the programs are upgradeable and we hold the authority. That is
  // deliberate (so bugs can be fixed) and is written down as a point of
  // centralisation in SECURITY.md.
  programId: 'Fr38cTAzyYJZTjHUsZXTVBCuA387j8vaQYir7Pr2FqC5',
  freePlays: 3,
  // The spin-credit tariff: once the 3 free attempts are used up (plus the +1
  // bonus spin), each package is bought in one go and added to the balance. In
  // order, it must match GameConfig.spin_tier_counts / spin_tier_prices exactly
  // (the SPIN_TIER_COUNTS / SPIN_TIER_PRICES_SOL defaults in initialize.mjs).
  spinTiers: [
    { count: 1, priceSol: 0.1 },
    { count: 5, priceSol: 0.3 },
    { count: 10, priceSol: 0.5 },
    { count: 20, priceSol: 0.8 },
    { count: 50, priceSol: 1.5 },
    { count: 100, priceSol: 2.5 },
  ],
  // A two-tier prize: (bigPrizeBps/100)% of the winning attempts take the big
  // prize (the jackpot) and the rest the small prize — which one lands is
  // decided by a second, independent dice roll inside resolve().
  smallPrizeSol: 0.5,
  bigPrizeSol: 1,
  bigPrizeBps: 3000, // 30% of winners take the big prize
  vaultEasyThresholdSol: 2,
  // A single "house share" rate, applied in two places at once:
  //   1. On a package purchase, 20% of the amount paid goes to the treasury and
  //      80% into the game vault.
  //   2. On a winning round, an EXTRA amount equal to 20% of the prize is moved
  //      from the vault to the treasury — it is not deducted from the player's
  //      prize. Someone winning 0.5 SOL receives the full 0.5 SOL, and a further
  //      0.1 SOL goes to the treasury (0.6 SOL leaves the vault in total).
  treasuryFeeBps: 2000,
  normalWinBps: 50, // hard mode: 0.5%
  easyWinBps: 1000, // easy mode (vault >= threshold): 10%
  // Must match the reveal_delay_slots passed to `initialize()`.
  revealDelaySlots: 5,
  // Must match the program constant MAX_RESOLVE_WINDOW_SLOTS — it is used only
  // for the "when can you cancel a stuck game" message.
  maxResolveWindowSlots: 300,
  // The treasury wallet the house share is sent to (both from package sales and
  // from prizes). Game revenue is kept SEPARATE from the presale operations
  // share: the presale share goes to the operations wallet
  // (PRESALE_OPS_WALLET), while game revenue goes to this separate game
  // treasury.
  //
  // IMPORTANT: this value is only for setup and documentation. The Game tab
  // ALWAYS reads the treasury address from the on-chain GameConfig
  // (gameConfig.treasury). Changing the address here is not enough on its own —
  // the on-chain value has to be updated with update_config() as well (see
  // .github/workflows/update-luck-game-config.yml).
  treasuryWallet: '5Zvz25PheDtC9PaMzwDRcnb3xKS6CU8d98PfEnKkgp9m',
  // When the "game wallet" (delegate) is activated, the only thing taken from
  // the player is the rent deposit the account needs in order to exist on chain
  // (~0.00089 SOL) — that amount is never spent and stays in the player's own
  // delegate account. The SPENDABLE gas balance does not come from the player at
  // all: it is sponsored from the vault on the first register_delegate() call
  // (see DELEGATE_GAS_SPONSOR_LAMPORTS in program/luck-game/src/lib.rs) and
  // quietly refreshed on every buy_spins() call
  // (DELEGATE_GAS_TOPUP_LAMPORTS). The value below is ONLY for a rare fallback:
  // if the delegate runs out of gas after playing for a very long time without
  // any purchase, this is the amount the player can top it up with by hand from
  // their own wallet (see handleTopUpDelegate / topUpDelegateGas).
  delegateTopUpSol: 0.001,
  // When the delegate's SPENDABLE gas balance (with the rent floor subtracted)
  // falls below this, the "top up gas" warning is shown. The vault refills the
  // delegate back to the full 0.0002 SOL gas share on every purchase (see
  // DELEGATE_GAS_SPONSOR_LAMPORTS in lib.rs); a spin (play + resolve) burns
  // ~0.000013 SOL, so this threshold means "roughly 3-4 spins of gas left".
  delegateLowBalanceSol: 0.00005,
}
