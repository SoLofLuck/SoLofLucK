# SoLofLuck

A tool for **creating a token, setting up a liquidity pool and making
confidential transfers on Solana without writing any code** — a web interface
that runs entirely on the client and needs no backend. The design and the flow
are inspired by Raydium's tool pages.

Alongside that toolbox there is a separate tab for the site's own dedicated coin,
**SoLofLuck ($LUCK)**: a "luck"-themed experience with digital rain in the
background, 🍀 four-leaf clovers drifting past and **777** figures, with About,
Tokenomics and Presale sub-tabs.

> ⚠️ The project is currently being developed on **Devnet (the test network)**.
> It will move to Mainnet once the presale and raffle mechanics have matured.

## Features

### The general toolbox

- Wallet connection (Phantom, Solflare), Devnet/Mainnet network selection.
- **Create Token**: an SPL Mint, logo upload (Irys/Arweave), on-chain metadata,
  revoking mint/freeze authority, immutable metadata, and the Sell Lock
  (anti-snipe).
- **Liquidity Pool**: searching for and creating a Raydium CPMM pool, adding and
  removing liquidity, locking liquidity with Streamflow.
- **Confidential Amount Transfer**: transfers that keep the amount encrypted on
  chain, using Token-2022 Confidential Transfer.

### The $LUCK tab

- **About**: the project's theme and the important warnings.
- **Tokenomics**: how the total supply of 777,000,000 $LUCK is split across the
  presale, liquidity, community, team and marketing (see `src/config.ts` →
  `TOKENOMICS`).
- **Presale** — two modes:
  1. **Free Contribution**: send as much SOL as you like, with no raffle; the
     $LUCK for a contribution is distributed at the end of the presale.
  2. **Fixed Package + Raffle**: choose one of the ready-made packages of 0.5 / 1
     / 3 / 5 / 10 / 15 / 20 / 25 / 50 / 100 / 200 / 250 / 500 SOL; every 0.5 SOL
     earns one raffle ticket (an entry into the 777-themed community raffles).
  Both modes are sent as a real Devnet/Mainnet transaction, signed in the user's
  own wallet, with a single SOL transfer plus a memo instruction for traceability.

## Local development

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
npm run preview
```

## Configuration (`src/config.ts`)

| Setting | Description |
| --- | --- |
| `DEFAULT_NETWORK` | The default network (`devnet` / `mainnet-beta`). |
| `FEE_WALLET` / `FEE_AMOUNT_SOL` | An optional service fee on the token creation transaction. |
| `LUCK_TOKEN.mint` | Enter the mint address here once the $LUCK coin has been created. |
| `PRESALE_WALLET` | The wallet the presale contributions are collected in — while it is empty the presale buttons are disabled (a deliberate safety brake against sending SOL by accident). |
| `PRESALE_TICKET_UNIT_SOL` | The SOL needed for 1 ticket in fixed-package mode (0.5 by default). |
| `PRESALE_TIERS` | The ready-made amounts on the fixed-package tab. |
| `TOKENOMICS` | The supply distribution plan shown on the Tokenomics tab. |

## Roadmap

1. **Verify on Devnet**: Create Token → mint the coin on devnet, and enter the
   mint address into `LUCK_TOKEN.mint` and the presale wallet into
   `PRESALE_WALLET`.
2. Test the presale flow with real users on devnet (free contribution + fixed
   package / raffle ticket counting).
3. Open the Raydium pool from the Liquidity Pool tab and lock the liquidity.
4. Once it is mature, set `DEFAULT_NETWORK` to `mainnet-beta` and repeat the
   process on mainnet; remove the "Devnet" warnings in this README.

## GitHub Pages / a custom domain

`.github/workflows/deploy.yml` builds the site and deploys it to GitHub Pages on
every push to `main`. To attach your own domain (solofluck.xyz or similar),
create a `public/CNAME` file with the domain in it and add the records GitHub
Pages documents to your DNS; the `base: '/'` value in `vite.config.ts` is already
the right setting for a root domain.

## Important warnings

- Revoking mint/freeze authority, making metadata immutable, and liquidity pool
  and locking operations **cannot be undone**.
- Only take part in the presale with an amount you can afford to lose; $LUCK is
  not investment advice.
- Creating and distributing a crypto asset can carry legal obligations depending
  on your jurisdiction.

## The technologies used

- [Vite](https://vite.dev/) + React + TypeScript
- [@solana/web3.js](https://github.com/solana-labs/solana-web3.js),
  [@solana/spl-token](https://github.com/solana-labs/solana-program-library)
- [@solana/wallet-adapter](https://github.com/anza-xyz/wallet-adapter)
- [@metaplex-foundation/mpl-token-metadata](https://github.com/metaplex-foundation/mpl-token-metadata)
- [Irys](https://irys.xyz/) (permanent storage for the logo/metadata)
- [@raydium-io/raydium-sdk-v2](https://github.com/raydium-io/raydium-sdk-V2) (the liquidity pool)
- [Streamflow](https://streamflow.finance) (locking liquidity)
