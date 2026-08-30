# luck-game — the 777 Wheel of Fortune (On Chain)

This is a Solana program (a smart contract) that runs on the chain, **separately**
from the main website. It holds all the money and probability logic of the mini
game on the SoLofLuck page (who pays what, who wins when, when a payout leaves
the vault) — no "I won" claim from the browser side is valid on its own;
everything is verified here, on the chain.

## Status: deployed on Devnet ✅

The deploy and `initialize()` go through GitHub Actions (see
`.github/workflows/deploy-luck-game.yml` and `init-luck-game.yml`), because the
sandbox has no access to the Solana network. When the account layout
(GameConfig/PlayerState) changes, `deploy-luck-game.yml` has to be triggered by
hand with `first_deploy=true` and the new Program ID written into:

1. `declare_id!(...)` in `programs/luck-game/src/lib.rs`
2. `Anchor.toml` in this folder (`[programs.devnet]`)
3. `GAME_CONFIG.programId` in `src/config.ts`

## How it works

### The economics: spin credit + a delegate (session key)

- **The first 3 spins are free** (only the network transaction fee — about
  0.000005 SOL). When the free spins run out completely, a **+1 bonus spin** is
  given as a one-off.
- After that the player accumulates a "spin balance" by buying one of the fixed
  packages (`buy_spins`, `GameConfig.spin_tier_counts`/`spin_tier_prices`):
  1 spin/0.1 SOL, 5 spins/0.3 SOL, 10 spins/0.5 SOL, 20 spins/0.8 SOL,
  50 spins/1.5 SOL, 100 spins/2.5 SOL. An arbitrary SOL amount can also be
  entered and bought in a single transaction, split into the best-fitting
  combination of those packages (see `computeBestFitSpinPurchase` / "Convert My
  Balance to Spins").
- Every package payment is split automatically in the same transaction: **20% to
  the treasury wallet** (the site's operating income), **80% into the game vault**.
- On every winning round, an **EXTRA amount equal to 20% of the prize** is moved
  from the vault to the treasury — it is **not deducted** from the player's prize.
  Someone who wins 0.5 SOL receives the full 0.5 SOL, and the treasury separately
  receives 0.1 SOL; 0.6 SOL leaves the vault in total. The same
  `treasury_fee_bps` rate is used in both places, so there is only one "house
  share" to keep track of.
- **Two prize tiers**: `big_prize_bps`/100 percent of the winners take the big
  prize (the jackpot, 1 SOL by default) and the rest take the small prize (0.5 SOL
  by default) — which one comes up is decided by a second, independent dice inside
  `resolve()`. The prize is always sent straight to the player's real wallet.
- When the vault holds **≥ 2 SOL** the game switches to "easy mode" (the chance of
  winning goes up); if the vault drops below 2 SOL it automatically falls back to
  "hard mode". This threshold is re-evaluated against the live vault balance on
  every `resolve()` call — there is no fixed "epoch" logic.

### The delegate (game wallet) — spinning without a wallet approval

Asking for an approval in the real wallet on every spin was a bad experience,
especially on mobile. Instead, a "delegate/session-key" pattern is used that stays
entirely non-custodial:

1. With ONE real wallet signature the player calls `register_delegate()` — this
   authorizes a local key generated in the browser's `localStorage` (see
   `src/lib/gameDelegate.ts`) on their own `PlayerState`, and sends it a small
   transaction-fee buffer in the same transaction.
2. From then on `play()`/`resolve()` are signed INSTANTLY by that local key,
   without an approval — the `Play` account struct separates `owner` (the real
   wallet, used only to derive the PDA) from `authority` (the party that actually
   signs — the real wallet OR the registered delegate).
3. The prize always goes to `owner` (the real wallet) — the delegate key can never
   reach the vault or the real wallet; all it can do is spend a spin balance that
   was bought in advance. `resolve()` was already permissionless, so the delegate
   can call that too, paying its own fee.
4. Anything that involves a payment (buying a package, registering a delegate or
   topping up its gas, clearing a stuck spin) ALWAYS asks for the real wallet's
   signature.

The default probabilities (passed as parameters to `initialize()` at deploy time,
changeable later with `update_config()`):

| Mode | Chance of winning | When |
|---|---|---|
| Hard (default) | low (0.5%, say) | the vault holds < 2 SOL |
| Easy | higher (10%, say) | the vault holds ≥ 2 SOL |

### Why commit → resolve rather than "spin and see the result" in one transaction?

Without an externally supplied source of randomness (a VRF), the best that can be
done safely on Solana is to use the hash of a slot that has not happened yet. If
the outcome depended on the hash of the CURRENT slot at `play()` time, a player
could **preview the result for free with their wallet's or RPC's
`simulateTransaction` before signing, and only submit when they won** — an obvious
way to cheat.

Instead:

1. **`play()`** — the fee is paid if there is one, and "this player started a game
   at this slot" is written to the chain. The result is not decided yet.
2. **`resolve()`** — can be called `reveal_delay_slots` later (5 slots by default,
   about 2-3 seconds); the result is computed deterministically from the hash of
   the target slot, which is now in the past, plus the player's pubkey, and if it
   is a win the prize is sent from the vault immediately. It is permissionless —
   the web interface calls it automatically, but anybody can trigger it, and
   nobody can influence the outcome.

### Stuck-game protection

If nobody calls `resolve()` (the player closes the tab, say) and the `resolve()`
window (300 slots by default, about 2 minutes) closes, the target slot's hash
falls out of the SlotHashes sysvar and that game can never be resolved again. In
that case the player can call `forfeit_stuck_play()` **themselves**, counting that
attempt as a loss (there is no refund) and becoming able to play again.

## The instructions

- `initialize(...)` — called once by the program owner; it sets the fee, prize,
  probability, spin package tariff and treasury wallet parameters.
- `update_config(new_treasury, ...)` — only `authority` can call it; it updates
  every parameter afterwards, the treasury wallet included. It rewrites EVERY
  field from scratch (there is no partial update) — see `scripts/update-config.mjs`
  and `.github/workflows/update-luck-game-config.yml`.
- `buy_spins(tier_index)` — called by the player (a real wallet signature); it
  splits the chosen package's price (20% treasury / 80% vault) and adds to the
  spin balance.
- `register_delegate(delegate)` — called by the player (a real wallet signature);
  it authorizes the local key that will be able to sign the next
  `play()`/`resolve()` calls without an approval.
- `play()` — called by the player OR the registered delegate; free if they have a
  free spin left (with a +1 bonus the first time those run out), otherwise
  deducted from the spin balance, and writes the "commit" step to the chain.
- `resolve()` — permissionless; can be called `reveal_delay_slots` after the
  commit, decides the result, pays if it is a win and updates
  `total_won_lamports`. On winning rounds it also moves the operations fee on top
  of the prize from the vault to the treasury — which is why it expects a
  `treasury` account in the account list, one that has to match `config.treasury`.
- `forfeit_stuck_play()` — only the player themselves (the real wallet), after the
  resolve window has closed; it clears the stuck attempt.

## Known limitations (v1)

1. **The randomness is an unaudited pseudo-VRF** (based on SlotHashes) — in theory
   it can be influenced slightly by a well-resourced validator. Moving to an
   audited solution such as Switchboard or ORAO VRF should be considered before
   going to mainnet with real money.
2. **Unaudited.** It has not been through any independent security audit.
3. **The `vault_easy_threshold_lamports >= big_prize_lamports + the prize fee`
   constraint has to hold** — a combination passed to `update_config` that would
   break that relationship is rejected, but be careful updating the parameters
   anyway.
4. **The delegate key is kept in the browser's `localStorage`** — less secure than
   a real wallet (it can be stolen through XSS and so on), but its blast radius is
   LIMITED: all it can spend is a spin balance bought in advance, and thanks to the
   `owner`/`authority` separation in the `Play`/`Resolve` account structs it can
   never reach the real wallet or the vault.

## The tools you need (if you want to build it locally with the Anchor CLI)

Exactly the same steps as in `program/sell-lock/README.md`:

```bash
cd program/luck-game
anchor build
anchor deploy
```

In this repository these steps are done automatically through GitHub Actions — see
`.github/workflows/deploy-luck-game.yml` and `init-luck-game.yml`.
