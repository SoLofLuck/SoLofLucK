# sell-lock — the Anti-Snipe Sell Lock (a Token-2022 Transfer Hook)

This is a Solana program (a smart contract) that runs on the chain,
**separately** from the main website. Its purpose: once a token pool
has been created, **nobody** (the creator of the pool included) can **sell** into
that pool for a chosen period (15 min / 1 hour / 5 hours / 24 hours) — buying
stays open the whole time. When the period is over, selling opens up for everyone
automatically, with no transaction needed.

## Status: deployed to Devnet, but STALE — redeploy required before further testing ⚠️

**Program ID (Devnet):** `3SgfMbBMbsaB21QaZgcGmRYbUTGGEyErJipxM8u2Uqy5`

It was built and deployed to Devnet step by step together with the user through
Solana Playground (beta.solpg.io) — with no local computer or Rust/Anchor/Solana
CLI installation, entirely from a phone browser.

**The bytecode currently live at that address predates several fixes now in
this source file** (the `NotMintAuthority`/`NoMintAuthority` front-running
guard on `register_launch`, the `pool_vault_b` mint check, and the corrected
`fallback` doc comment) — a Meteora reviewer confirmed this by inspecting the
on-chain binary's error strings. **Redeploy from this source before running
any further devnet tests or reapplying for a Token Badge.** Steps: repeat the
Solana Playground flow below with the current `lib.rs`, or build+deploy
locally with the Anchor CLI (same program ID, since it is a redeploy of the
same upgradeable program, not a fresh one).

It has **not been deployed to mainnet**.

### The upgrade authority

This program is upgradeable, and unlike `luck-game`/`luck-distributor` (see
the root `SECURITY.md`), it was NOT deployed through the CI pipeline that
records a source→bytecode sha256 match on every deploy — it was deployed
by hand through Solana Playground, so there is currently no way for a third
party to verify the live bytecode matches this source at all (this is
exactly the gap the Meteora review above caught). Until this is folded into
the same CI-verified deploy path as the other two programs, treat the
upgrade authority as an open, undocumented centralization risk: whoever
holds it can replace this program's logic for every token that uses it —
revoking a token's own Transfer Hook authority does NOT protect against
this, since the program ID (and therefore what every mint's hook points to)
stays the same while the code behind it changes. This must be resolved
(either verifiable CI deploys, or the authority set to `None` once the code
is trusted) before mainnet.

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

- `register_launch` requires the signer to be the mint's own mint authority
  (fixed — see the "gate initialize()/register_launch() to their real owner"
  commit), so a third party can no longer front-run it. It is still a
  **trust-based** vault check: the program verifies `pool_vault_a`/
  `pool_vault_b` belong to the right mint, not that they are cryptographically
  proven to be one specific DEX's real pool accounts (that would require
  hardcoding one DEX's PDA derivation here). The real guarantee is that only
  this mint's own mint authority can call it, and the website always calls it
  with the addresses the pool-creation call itself just returned — never from
  free-form user input.
- A second pool for the same mint on any venue (including a second Meteora
  pool) is **not covered** by the lock — `LaunchConfig` is a one-shot,
  per-mint account tied to the ONE pair of vaults it was registered with.
- Whether Meteora DLMM's swap path triggers our Transfer Hook correctly has
  **not been tested end to end yet** — blocked on the Meteora Token Badge
  approval for this mint's TransferHook extension (see the root project's
  Meteora application).
- The devnet deploy is currently stale — see "Status" above. Redeploy before
  any further testing.
- It has not been deployed to mainnet.

## The next step

Integration into the website: a lock-duration option in the Create Token form,
and adding the `initialize_extra_account_meta_list` / `register_launch` calls to
the Create Pool flow.
