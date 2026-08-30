# sell-lock — the Anti-Snipe Sell Lock (a Token-2022 Transfer Hook)

This is a Solana program (a smart contract) that runs on the chain,
**separately** from the main `0nRCoin` website. Its purpose: once a token pool
has been created, **nobody** (the creator of the pool included) can **sell** into
that pool for a chosen period (15 min / 1 hour / 5 hours / 24 hours) — buying
stays open the whole time. When the period is over, selling opens up for everyone
automatically, with no transaction needed.

## Status: deployed to Devnet ✅

**Program ID (Devnet):** `3SgfMbBMbsaB21QaZgcGmRYbUTGGEyErJipxM8u2Uqy5`

It was built and deployed to Devnet step by step together with the user through
Solana Playground (beta.solpg.io) — with no local computer or Rust/Anchor/Solana
CLI installation, entirely from a phone browser. It has not been integrated into
the website yet (the TokenForm / Create Pool flows) — that is the next step.

It has **not been deployed to mainnet**.

## Problems solved during the build (in case a redeploy is ever needed)

- There is **no** Anchor attribute called
  `#[interface(spl_transfer_hook_interface::execute)]` — Anchor recognizes a
  function named `fallback` with the right signature as the custom handler
  automatically, and no extra attribute is needed.
- Relying on Anchor's hidden, internal `__private::__global::<instruction>` call
  path inside `fallback` did not match the Anchor version Solana Playground uses,
  and broke the build with a meaningless error like "length limit exceeded". The
  fix: without relying on that special path at all, read the raw account list that
  arrives through the CPI directly inside `fallback` and apply the real logic there
  (see the `fallback` function in `lib.rs`).
- On Solana Playground, making code changes by **always deleting the whole file
  and pasting it again** turned out to be far more reliable than editing it piece
  by piece on mobile (partial edits led to a mismatched-closing-brace error
  several times).

## The tools you need (if you want to rebuild it locally with the Anchor CLI)

1. **Rust**: https://www.rust-lang.org/tools/install
2. **The Solana CLI**: https://docs.solanalabs.com/cli/install
3. **The Anchor CLI**:
   ```bash
   cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
   avm install latest
   avm use latest
   ```
4. A wallet with SOL on Devnet:
   ```bash
   solana config set --url devnet
   solana-keygen new
   solana airdrop 2
   ```
5. The build:
   ```bash
   cd program/sell-lock
   anchor build
   anchor deploy
   ```

## The instructions

- `initialize_extra_account_meta_list` — called once, right after the Token-2022
  mint is created with the Transfer Hook extension.
- `register_launch(duration_seconds)` — called once, right after the pool is
  created; it writes the pool's vault addresses and the lock duration to the chain
  permanently (a second call for the same mint fails — the duration cannot be
  changed). `duration_seconds` can only be 900 (15 min) / 3600 (1 h) / 18000
  (5 h) / 86400 (24 h).
- `fallback` — the actual lock logic, which Token-2022 calls automatically on
  every transfer: if the destination is one of the registered pool vaults (that
  is, this is a sale) and the period has not elapsed, it rejects the transfer.

## Known, not yet addressed matters (v1 limitations)

- `register_launch` can currently be called **whoever the signer is** (there is
  only a duration and vault address check). In theory somebody could try to make
  that call in your place (with a shorter duration, say) just before or after the
  real pool is created. In the website integration this will be done inside the
  same transaction/flow (back to back with creating the pool), so the practical
  risk is low, but it can be tightened up later.
- Whether Raydium CPMM triggers our Transfer Hook correctly on swaps has **not
  been tested yet** — this will be verified with the website integration plus a
  real mint/pool/swap attempt.
- It has not been deployed to mainnet.

## The next step

Integration into the website: a lock-duration option in the Create Token form,
and adding the `initialize_extra_account_meta_list` / `register_launch` calls to
the Create Pool flow.
