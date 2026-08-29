use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::slot_hashes;
use anchor_lang::system_program::{self, Transfer as SolTransfer};

// The devnet address. The program ID comes from THE SOURCE CODE: this
// `declare_id!` is the single source of truth. No keypair is needed for an
// upgrade — the chain only looks for the upgrade authority's (the deploy
// wallet's) signature. `anchor keys sync` runs only when a new program is
// deliberately opened (first_deploy=true); see
// .github/workflows/deploy-luck-game.yml.
//
// An older note here said the keypair was carried in the rust-cache and that
// the program could not be updated if it were lost. That is no longer true:
// when the workflow was rewritten the cache steps were removed entirely.
declare_id!("H6gnAvLa5o2JtjfdgyKdZy2eC9bjnMerCcbxjYZeKdnf");

const CONFIG_SEED: &[u8] = b"config";
const VAULT_SEED: &[u8] = b"vault";
const PLAYER_SEED: &[u8] = b"player";
const SPIN_TIERS: usize = 6;

// resolve() can be called at the earliest at commit_slot + reveal_delay_slots
// and at the latest at
// commit_slot + reveal_delay_slots + MAX_RESOLVE_WINDOW_SLOTS.
// That upper bound comes from the fact that the SlotHashes sysvar only keeps
// the last ~512 slots — leave it too long and the target slot's hash has fallen
// out of the sysvar, making the result impossible to determine. 300 slots
// (~2 minutes) leaves plenty of room in normal use (the frontend triggers
// resolve automatically without delay) while staying well inside the sysvar's
// 512-slot window.
const MAX_RESOLVE_WINDOW_SLOTS: u64 = 300;

// The basis-point base (10000 = 100%). Probabilities and the fee share are
// expressed in this unit — e.g. 200 bps = 2%.
const BPS_DENOMINATOR: u32 = 10_000;

// The GENUINELY SPENDABLE gas share the delegate (the "game wallet") needs in
// order to pay the play()/resolve() transaction fees — it comes from THE VAULT,
// not from the player. Since the vault already collects the bulk of every
// purchase, this can be seen as a natural cost of the games being played.
//
// CAREFUL — this amount alone does NOT keep an account alive: on Solana the
// rent-exemption floor for a 0-byte account is ~890_880 lamports and an account
// cannot be left with a balance below it. So the amount sent to the delegate is
// always computed as `Rent::minimum_balance(0) + this constant` (see
// `delegate_target` inside buy_spins); this constant only expresses the
// spendable part that rides ON TOP of the floor.
//
// Because it leaves the vault, paying it is deliberately tied to `buy_spins()`:
// had it been inside `register_delegate()`, which can be called permissionlessly,
// registering repeatedly with empty wallets to drain the vault would be a
// profitable attack.
const DELEGATE_GAS_SPONSOR_LAMPORTS: u64 = 200_000; // ~0.0002 SOL, ~30 rounds

#[program]
pub mod luck_game {
    use super::*;

    /// Sets the game up once: writes the prize and probability parameters, the
    /// spin package tariff and the treasury wallet into the GameConfig PDA.
    /// There is no separate "create" step for the vault — as with pool_authority
    /// in locked-pool, the transfer in the first `buy_spins()` call brings it into
    /// existence.
    pub fn initialize(
        ctx: Context<Initialize>,
        free_plays: u8,
        small_prize_lamports: u64,
        big_prize_lamports: u64,
        big_prize_bps: u16,
        vault_easy_threshold_lamports: u64,
        normal_win_bps: u16,
        easy_win_bps: u16,
        treasury_fee_bps: u16,
        reveal_delay_slots: u64,
        spin_tier_counts: [u16; SPIN_TIERS],
        spin_tier_prices: [u64; SPIN_TIERS],
    ) -> Result<()> {
        require!(small_prize_lamports > 0, GameError::InvalidParam);
        // The big prize cannot be less than the small one — the name "big" has to
        // mean something (being equal, i.e. single-tier behaviour, is allowed).
        require!(big_prize_lamports >= small_prize_lamports, GameError::InvalidParam);
        require!(reveal_delay_slots > 0, GameError::InvalidParam);
        require!(
            (normal_win_bps as u32) <= BPS_DENOMINATOR
                && (easy_win_bps as u32) <= BPS_DENOMINATOR
                && (treasury_fee_bps as u32) <= BPS_DENOMINATOR
                && (big_prize_bps as u32) <= BPS_DENOMINATOR,
            GameError::InvalidParam
        );
        // "Easy mode" has to be easier than normal mode, otherwise the threshold
        // means nothing at all.
        require!(easy_win_bps >= normal_win_bps, GameError::InvalidParam);
        // The vault threshold has to be large enough to pay the largest possible
        // prize (the jackpot) — otherwise "easy mode" could trigger while the vault
        // had no money for the prize, which would be a design error.
        // The threshold must cover not only the jackpot but the house share added on
        // top of it — otherwise a vault that has switched to "easy mode" could end up
        // able to pay the prize but not the share when the jackpot lands.
        require!(
            vault_easy_threshold_lamports
                >= big_prize_lamports
                    .checked_add(ops_fee_lamports(big_prize_lamports, treasury_fee_bps)?)
                    .ok_or(GameError::MathOverflow)?,
            GameError::InvalidParam
        );
        for i in 0..SPIN_TIERS {
            require!(
                spin_tier_counts[i] > 0 && spin_tier_prices[i] > 0,
                GameError::InvalidParam
            );
        }

        // The vault PDA's bump is computed once here and stored, so that every
        // later buy_spins()/resolve() call can use it directly instead of
        // recomputing it with a (relatively expensive) `find_program_address`
        // search — the same optimisation as `authority_bump` in locked-pool.
        let config_key = ctx.accounts.config.key();
        let (_vault_pda, vault_bump) =
            Pubkey::find_program_address(&[VAULT_SEED, config_key.as_ref()], ctx.program_id);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = ctx.accounts.treasury.key();
        config.free_plays = free_plays;
        config.small_prize_lamports = small_prize_lamports;
        config.big_prize_lamports = big_prize_lamports;
        config.big_prize_bps = big_prize_bps;
        config.vault_easy_threshold_lamports = vault_easy_threshold_lamports;
        config.normal_win_bps = normal_win_bps;
        config.easy_win_bps = easy_win_bps;
        config.treasury_fee_bps = treasury_fee_bps;
        config.reveal_delay_slots = reveal_delay_slots;
        config.spin_tier_counts = spin_tier_counts;
        config.spin_tier_prices = spin_tier_prices;
        config.vault_bump = vault_bump;
        config.bump = ctx.bumps.config;

        Ok(())
    }

    /// For adjusting the parameters afterwards (updating the package tariff, say).
    /// Only `config.authority` can call it.
    ///
    /// IT DOES NOT AFFECT PENDING GAMES. Every parameter that determines the payout
    /// is COPIED into `PlayerState` at the moment of `play()`, and `resolve()` reads
    /// those. So a player's round settles under the rules that applied when they
    /// placed their bet; it is not possible for the authority to change the odds of
    /// a pending bet afterwards.
    ///
    /// That was NOT the case before. `resolve()` used to read the current config,
    /// and the comment here said "it does not affect pending games" and then
    /// contradicted itself one line later with "resolve reads from the CURRENT
    /// config". In a game that claims verifiable fairness, "trust us not to change
    /// the odds after you place your bet" was an unacceptable gap. It was closed
    /// before launch, at the last moment when the fix was still free.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_treasury: Pubkey,
        free_plays: u8,
        small_prize_lamports: u64,
        big_prize_lamports: u64,
        big_prize_bps: u16,
        vault_easy_threshold_lamports: u64,
        normal_win_bps: u16,
        easy_win_bps: u16,
        treasury_fee_bps: u16,
        spin_tier_counts: [u16; SPIN_TIERS],
        spin_tier_prices: [u64; SPIN_TIERS],
    ) -> Result<()> {
        require!(small_prize_lamports > 0, GameError::InvalidParam);
        require!(big_prize_lamports >= small_prize_lamports, GameError::InvalidParam);
        require!(
            (normal_win_bps as u32) <= BPS_DENOMINATOR
                && (easy_win_bps as u32) <= BPS_DENOMINATOR
                && (treasury_fee_bps as u32) <= BPS_DENOMINATOR
                && (big_prize_bps as u32) <= BPS_DENOMINATOR,
            GameError::InvalidParam
        );
        require!(easy_win_bps >= normal_win_bps, GameError::InvalidParam);
        // The threshold must cover not only the jackpot but the house share added on
        // top of it — otherwise a vault that has switched to "easy mode" could end up
        // able to pay the prize but not the share when the jackpot lands.
        require!(
            vault_easy_threshold_lamports
                >= big_prize_lamports
                    .checked_add(ops_fee_lamports(big_prize_lamports, treasury_fee_bps)?)
                    .ok_or(GameError::MathOverflow)?,
            GameError::InvalidParam
        );
        for i in 0..SPIN_TIERS {
            require!(
                spin_tier_counts[i] > 0 && spin_tier_prices[i] > 0,
                GameError::InvalidParam
            );
        }

        // The treasury wallet can be changed later: both the 20% share in
        // buy_spins() and the prize share in resolve() go to this address. The zero
        // address is not accepted — a field accidentally left empty would send all
        // the revenue to a burn address.
        require_keys_neq!(new_treasury, Pubkey::default(), GameError::InvalidParam);

        let config = &mut ctx.accounts.config;
        config.treasury = new_treasury;
        config.free_plays = free_plays;
        config.small_prize_lamports = small_prize_lamports;
        config.big_prize_lamports = big_prize_lamports;
        config.big_prize_bps = big_prize_bps;
        config.vault_easy_threshold_lamports = vault_easy_threshold_lamports;
        config.normal_win_bps = normal_win_bps;
        config.easy_win_bps = easy_win_bps;
        config.treasury_fee_bps = treasury_fee_bps;
        config.spin_tier_counts = spin_tier_counts;
        config.spin_tier_prices = spin_tier_prices;

        Ok(())
    }

    /// Buys a spin package — this MUST be signed with the player's REAL wallet
    /// (the delegate cannot be used here, because the delegate only carries a small
    /// gas balance, not the SOL for the actual payment). The amount is split in two
    /// exactly as `play()` used to do: a share to the treasury and the rest to the
    /// game vault. The number of spins bought is added to
    /// `player_state.spins_remaining`.
    ///
    /// On the FIRST purchase an "onboarding deposit" refund also happens — see the
    /// `onboarding_cost` explanation below.
    pub fn buy_spins(ctx: Context<BuySpins>, tier_index: u8) -> Result<()> {
        let config = &ctx.accounts.config;
        require!((tier_index as usize) < SPIN_TIERS, GameError::InvalidParam);
        let spin_count = config.spin_tier_counts[tier_index as usize] as u32;
        let price = config.spin_tier_prices[tier_index as usize];

        // -------------------------------------------------------------------
        // The onboarding cost: paid from THE VAULT, not by the player
        //
        // Opening an account on Solana is not free: an account cannot exist with a
        // balance below the "rent-exempt" floor. A new player entering the chain
        // brings two accounts into being:
        //   * the `player_state` PDA (the spin credit, the pending game and the
        //     delegate registration live here) — rent(PlayerState::LEN), ~0.00162
        //     SOL. Anchor's `init_if_needed` charges this TO THE PLAYER.
        //   * the delegate / "game wallet" (an ordinary 0-byte account) — rent(0)
        //     plus the gas share. We send this straight from the vault.
        //
        // Neither stays with us as revenue (both sit in the player's own accounts),
        // but from the player's point of view they looked like "a surprise cost on
        // top of the published package price". Now:
        //   - the player_state rent is refunded to the player in full,
        //   - the delegate's rent and gas already come from the vault,
        // so the net amount leaving the player's pocket = the published package
        // price plus Solana's unavoidable transaction fee (~0.0000065 SOL).
        //
        // We take the cost out of our own share: the house share
        // (treasury_fee_bps) is computed not on the WHOLE package but on the amount
        // left after this onboarding cost is deducted.
        //
        // WHY HERE AND NOT INSIDE `register_delegate()`: every lamport leaving the
        // vault must be tied to a paid purchase. Done during registration, an
        // attacker could register with thousands of empty wallets in a row and drain
        // the vault dry — and that would not merely be theoretical but profitable
        // (the transaction fee is far smaller than the amount withdrawn). Tied to a
        // purchase, "exploiting" it means paying a package price dozens of times the
        // onboarding cost every time.
        let rent = Rent::get()?;

        // Detecting the "first purchase": never played AND holding no spins. Those
        // two can only be true at the same time ONCE in a player_state's lifetime —
        // after the first purchase spins_remaining > 0, and once the spins run out
        // plays_count > 0.
        //
        // We deliberately do NOT look at the `initialized` flag here: the delegate
        // registration now goes in the SAME transaction as the purchase, immediately
        // before it, and `register_delegate()` has already set the flag. With
        // `initialized` the refund never triggered — and the player paid an extra
        // 0.00162 SOL.
        let is_first_purchase = ctx.accounts.player_state.plays_count == 0
            && ctx.accounts.player_state.spins_remaining == 0;

        let player_refund = if is_first_purchase {
            rent.minimum_balance(PlayerState::LEN)
        } else {
            0
        };

        // The delegate's target balance: the rent floor (which can never be spent,
        // so the account can exist) plus the spendable gas share. It is topped back
        // up to this level on every purchase, so the gas that melts away as the
        // player plays is quietly refreshed INSIDE the payment they were signing
        // anyway — with no need to ask for a separate "top up" approval.
        //
        // Only the player's ACTUALLY REGISTERED delegate is funded, so that nobody
        // can put an arbitrary address in the account list and have the vault send
        // money to it.
        let delegate_target = rent
            .minimum_balance(0)
            .checked_add(DELEGATE_GAS_SPONSOR_LAMPORTS)
            .ok_or(GameError::MathOverflow)?;
        let delegate_funding = if ctx.accounts.player_state.delegate == ctx.accounts.delegate.key()
            && ctx.accounts.player_state.delegate != Pubkey::default()
        {
            delegate_target.saturating_sub(ctx.accounts.delegate.lamports())
        } else {
            0
        };

        let mut onboarding_cost = player_refund
            .checked_add(delegate_funding)
            .ok_or(GameError::MathOverflow)?;
        // The onboarding cost cannot exceed the package price — otherwise the vault
        // would lose money on every new player. Even the cheapest package in the
        // tariff is dozens of times this, so in practice it never triggers; even so,
        // rather than silently making a loss if a very cheap package is added later,
        // we close the outflow from the vault entirely.
        let (player_refund, delegate_funding) = if onboarding_cost >= price {
            onboarding_cost = 0;
            (0, 0)
        } else {
            (player_refund, delegate_funding)
        };

        // The house share, on the amount left AFTER the onboarding cost is deducted.
        let fee_base = price
            .checked_sub(onboarding_cost)
            .ok_or(GameError::MathOverflow)?;
        let treasury_amount = (fee_base as u128)
            .checked_mul(config.treasury_fee_bps as u128)
            .ok_or(GameError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(GameError::MathOverflow)? as u64;
        let vault_amount = price
            .checked_sub(treasury_amount)
            .ok_or(GameError::MathOverflow)?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            treasury_amount,
        )?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            vault_amount,
        )?;

        // Pay the onboarding cost from the vault (see the long explanation above):
        // the player_state rent back to the player, the delegate's rent plus gas to
        // the delegate. Because the vault received `vault_amount` immediately
        // before these lines there is always cover for it; even so we cap it so the
        // vault does not fall below its own rent floor — if it cannot cover it, the
        // payment is skipped silently and the purchase still completes (a missing
        // gas buffer must not fail the actual payment).
        if onboarding_cost > 0 {
            let config_key = ctx.accounts.config.key();
            let vault_bump = ctx.accounts.config.vault_bump;
            let signer_seeds: &[&[u8]] = &[VAULT_SEED, config_key.as_ref(), &[vault_bump]];
            let vault_floor = rent.minimum_balance(0);

            if player_refund > 0 {
                let available = ctx.accounts.vault.lamports().saturating_sub(vault_floor);
                let amount = player_refund.min(available);
                if amount > 0 {
                    system_program::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.system_program.to_account_info(),
                            SolTransfer {
                                from: ctx.accounts.vault.to_account_info(),
                                to: ctx.accounts.player.to_account_info(),
                            },
                            &[signer_seeds],
                        ),
                        amount,
                    )?;
                }
            }

            if delegate_funding > 0 {
                let available = ctx.accounts.vault.lamports().saturating_sub(vault_floor);
                let amount = delegate_funding.min(available);
                // If the delegate account does NOT exist on chain, sending an amount
                // BELOW the rent floor fails the whole transaction with
                // `InsufficientFundsForRent`. So we send either enough or nothing.
                let creates_account = ctx.accounts.delegate.lamports() == 0;
                let would_be_rent_exempt =
                    ctx.accounts.delegate.lamports().saturating_add(amount) >= vault_floor;
                if amount > 0 && (!creates_account || would_be_rent_exempt) {
                    system_program::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.system_program.to_account_info(),
                            SolTransfer {
                                from: ctx.accounts.vault.to_account_info(),
                                to: ctx.accounts.delegate.to_account_info(),
                            },
                            &[signer_seeds],
                        ),
                        amount,
                    )?;
                }
            }
        }

        let owner = ctx.accounts.player.key();
        let player_state = &mut ctx.accounts.player_state;
        ensure_owner(player_state, owner)?;
        player_state.spins_remaining = player_state
            .spins_remaining
            .checked_add(spin_count)
            .ok_or(GameError::MathOverflow)?;
        player_state.bump = ctx.bumps.player_state;

        emit!(SpinsPurchased {
            player: owner,
            tier_index,
            spin_count,
            price_lamports: price,
            spins_remaining: player_state.spins_remaining,
        });

        Ok(())
    }

    /// Registers a local "delegate" key the player keeps in the browser, authorised
    /// once with the real wallet — from then on `play()` calls can also be signed
    /// with that delegate, so there is no need to switch to the wallet app on every
    /// spin. The delegate can only spend the spin credit this player has ALREADY
    /// BOUGHT; winnings always go to `player_state.player` (the real wallet) and
    /// never to the delegate itself.
    ///
    /// The small gas balance the delegate needs in order to pay the play()/resolve()
    /// transaction fees is sponsored ONCE, on this first registration, FROM THE
    /// VAULT rather than by the player — so that a free trial really stays free
    /// (see DELEGATE_GAS_SPONSOR_LAMPORTS).
    pub fn register_delegate(ctx: Context<RegisterDelegate>) -> Result<()> {
        let owner = ctx.accounts.player.key();
        let delegate_key = ctx.accounts.delegate.key();

        let player_state = &mut ctx.accounts.player_state;
        ensure_owner(player_state, owner)?;
        player_state.delegate = delegate_key;
        player_state.bump = ctx.bumps.player_state;

        // This call TAKES NO MONEY OUT OF THE VAULT — it only keeps the books.
        //
        // It used to sponsor the delegate's gas once here. That had two problems:
        //   1. The sponsorship (200_000 lamports) is BELOW the rent floor of a
        //      0-byte account (~890_880), so when the delegate account was newly
        //      born on chain the whole transaction failed with
        //      `InsufficientFundsForRent`.
        //   2. The call is permissionless: an attacker could register with thousands
        //      of empty wallets in a row and drain the vault 200_000 at a time — a
        //      PROFITABLE attack, since it withdraws more than the transaction fee.
        //
        // So both the delegate's rent and its gas are now sent inside `buy_spins()`,
        // tied to a PAID purchase. Because the registration and the purchase already
        // travel in a single transaction (see buySpins/setupDelegate in
        // src/lib/luckGame.ts), nothing changes from the player's point of view: one
        // signature, and the delegate is funded.
        Ok(())
    }

    /// Enters a round (the "commit" step) — spends one spin credit. On the first
    /// call, `config.free_plays` free credits are loaded automatically; once they
    /// run out (and if no bonus has ever been granted) a one-off +1 bonus spin is
    /// added. When the credit runs out it returns a `NoSpinsRemaining` error — the
    /// player has to buy a package with `buy_spins()`.
    ///
    /// The player themselves (`owner` == the signer) OR the local delegate key
    /// registered with `register_delegate()` may sign — so once the player has
    /// approved once with their wallet and registered the spin package and the
    /// delegate, no further wallet approval is needed on every spin.
    ///
    /// The outcome is NOT DECIDED here — all that is written on chain is "this
    /// player started a game at this slot". Whether they won is decided in
    /// `resolve()`, tied to the hash of a slot that does not exist yet (a future
    /// one) — see that function's comment, which explains why this is necessary
    /// (to stop a player from "previewing" the result by simulating it and
    /// cheating).
    pub fn play(ctx: Context<Play>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        let authority = ctx.accounts.authority.key();

        let player_state = &mut ctx.accounts.player_state;
        require!(!player_state.pending, GameError::PlayAlreadyPending);

        ensure_owner(player_state, owner)?;
        require!(
            authority == player_state.player || authority == player_state.delegate,
            GameError::UnauthorizedSigner
        );

        let config = &ctx.accounts.config;
        if !player_state.spins_seeded {
            // ADD, do not OVERWRITE: the player may have bought a package before ever
            // playing (buy_spins already increases spins_remaining), and in that case
            // the free spins have to be added ON TOP of that balance — overwriting
            // would erase the purchased spins. The `spins_seeded` flag guarantees this
            // addition happens only once.
            player_state.spins_remaining = player_state
                .spins_remaining
                .checked_add(config.free_plays as u32)
                .ok_or(GameError::MathOverflow)?;
            player_state.spins_seeded = true;
        }
        require!(player_state.spins_remaining > 0, GameError::NoSpinsRemaining);

        player_state.spins_remaining -= 1;
        player_state.plays_count = player_state
            .plays_count
            .checked_add(1)
            .ok_or(GameError::MathOverflow)?;

        // When the free spins run out completely (and no bonus has been granted
        // before) we hand out a one-off +1 bonus attempt — the frontend shows it
        // with a notification (see PlayCommitted.bonus_granted).
        //
        // The condition has to be ">=", not EQUALITY. With equality
        // (`plays_count == free_plays`) a player who bought a package BEFORE using
        // up their free spins would NEVER get the bonus: the purchased spins land
        // in the same balance, so it hits zero at 4 rather than at 3 and the
        // equality never holds. Verified by a test (see
        // `the_bonus_is_granted_even_if_a_package_was_bought_first`).
        //
        // The `free_plays > 0` condition is needed too: with no free spins nobody
        // should get a bonus, otherwise ">=" would hand everyone a free spin after
        // their first game.
        let mut bonus_granted = false;
        if player_state.spins_remaining == 0
            && !player_state.bonus_granted
            && config.free_plays > 0
            && player_state.plays_count >= config.free_plays as u32
        {
            player_state.spins_remaining = 1;
            player_state.bonus_granted = true;
            bonus_granted = true;
        }

        player_state.pending = true;
        player_state.commit_slot = Clock::get()?.slot;
        player_state.bump = ctx.bumps.player_state;

        // FREEZE THE RULES AS THEY STAND WHEN THE BET IS PLACED.
        // resolve() will read these; update_config can no longer affect this bet.
        player_state.bet_small_prize_lamports = config.small_prize_lamports;
        player_state.bet_big_prize_lamports = config.big_prize_lamports;
        player_state.bet_vault_easy_threshold_lamports = config.vault_easy_threshold_lamports;
        player_state.bet_big_prize_bps = config.big_prize_bps;
        player_state.bet_normal_win_bps = config.normal_win_bps;
        player_state.bet_easy_win_bps = config.easy_win_bps;
        player_state.bet_treasury_fee_bps = config.treasury_fee_bps;

        emit!(PlayCommitted {
            player: owner,
            plays_count: player_state.plays_count,
            spins_remaining: player_state.spins_remaining,
            bonus_granted,
            commit_slot: player_state.commit_slot,
        });

        Ok(())
    }

    /// Settles a pending game (the "reveal" step). Permissionless — the player
    /// themselves, their delegate, or anybody else (a "keeper") may call it; who
    /// submits the result does not matter, because the result is already
    /// DETERMINISTICALLY fixed by the hash of slot `commit_slot +
    /// reveal_delay_slots` and the caller cannot influence anything. The prize is
    /// ALWAYS paid to `player_state.player` (the real wallet), never to the caller.
    ///
    /// Why the hash of a slot `reveal_delay_slots` after the commit is used: at
    /// the moment of `play()` that slot has not happened yet, so nobody (us
    /// included) can know or predict its hash. If the hash of the CURRENT slot at
    /// `play()` time were used instead, a player could preview the outcome for
    /// free with their wallet's or RPC's `simulateTransaction` before signing, and
    /// only submit when they won — this "commit then reveal" structure exists
    /// precisely to prevent that.
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        // We verify here, in the function body, that the `player` account really is
        // the owner of this player_state — a macro constraint such as
        // `#[account(address = player_state.player)]` would require player_state
        // (whose seeds are bound to the player itself, see the Resolve struct) to be
        // declared AFTER player, which makes a backwards reference impossible; so we
        // use a runtime check, the same way `RegisterLaunch` does in sell-lock.
        require_keys_eq!(
            ctx.accounts.player.key(),
            ctx.accounts.player_state.player,
            GameError::PlayerMismatch
        );

        let player_state = &mut ctx.accounts.player_state;
        require!(player_state.pending, GameError::NoPendingPlay);

        let config = &ctx.accounts.config;
        let target_slot = player_state
            .commit_slot
            .checked_add(config.reveal_delay_slots)
            .ok_or(GameError::MathOverflow)?;
        let current_slot = Clock::get()?.slot;

        require!(current_slot >= target_slot, GameError::TooEarlyToResolve);
        require!(
            current_slot <= target_slot.saturating_add(MAX_RESOLVE_WINDOW_SLOTS),
            GameError::ResolveWindowExpired
        );

        require_keys_eq!(
            ctx.accounts.slot_hashes.key(),
            slot_hashes::ID,
            GameError::InvalidSlotHashesAccount
        );
        let sysvar_data = ctx.accounts.slot_hashes.try_borrow_data()?;
        // The target slot may have been skipped (its leader may have failed to
        // produce a block); in that case the first slot produced AFTER it is used.
        // The upper bound is the resolve window itself — the search cannot run past
        // the end of the window.
        let (entropy_slot, target_hash) = find_slot_hash_at_or_after(
            &sysvar_data,
            target_slot,
            target_slot.saturating_add(MAX_RESOLVE_WINDOW_SLOTS),
        )
        .ok_or(GameError::SlotHashNotFound)?;
        drop(sysvar_data);

        // Randomness: the hash of the slot used + the slot number + the player's
        // pubkey + the game counter (a nonce). The slot number is part of the
        // preimage because which slot gets used is no longer fixed (it can shift when
        // a slot is skipped), so the slot the result rests on is recorded inside the
        // hash too — that way an outside verifier cannot reproduce the same result
        // with the wrong slot. Adding the nonce makes it meaningless for the same
        // player to be resolved twice by accident at the same slot (it should not
        // happen, but still) or for different players to share the same hash (the
        // pubkey already prevents that, but the nonce is extra safety).
        let mut preimage = Vec::with_capacity(32 + 8 + 32 + 4);
        preimage.extend_from_slice(&target_hash);
        preimage.extend_from_slice(&entropy_slot.to_le_bytes());
        preimage.extend_from_slice(ctx.accounts.player.key.as_ref());
        preimage.extend_from_slice(&player_state.plays_count.to_le_bytes());
        let digest = anchor_lang::solana_program::hash::hash(&preimage).to_bytes();
        // The dice is derived from 8 BYTES, not 2 — the reason is modulo bias:
        //
        // 2 bytes = 65536 values in 0..65535. 65536 is not an exact multiple of
        // 10000 (65536 = 6 x 10000 + 5536), so every outcome in 0..5535 was
        // represented 7 times and every outcome in 5536..9999 only 6 times. Because
        // the winning threshold always sits at the START of the range (roll <
        // win_bps), this shifted every published rate against the house:
        //   hard mode 0.50%  -> 0.534%   (+6.8% relative)
        //   easy      10.00% -> 10.681%  (+6.8% relative)
        //   jackpot   30.00% -> 32.043%  (+6.8% relative)
        // Unnoticeable in a single round, but over thousands of rounds it leaks
        // systematically out of the vault and the rates we publish do not match
        // reality.
        //
        // With 8 bytes (0..2^64-1) the same bias drops to the order of 5x10^-16 —
        // that is, it becomes unmeasurable.
        let roll = (u64::from_le_bytes(
            digest[0..8].try_into().map_err(|_| GameError::MathOverflow)?,
        ) % BPS_DENOMINATOR as u64) as u32;
        // A second, independent dice: it decides ONLY which prize tier (small/big)
        // gets paid when the player wins. Using SEPARATE bytes of the same digest
        // (0-7 for win/lose, 8-15 here) saves computing another hash.
        let tier_roll = (u64::from_le_bytes(
            digest[8..16].try_into().map_err(|_| GameError::MathOverflow)?,
        ) % BPS_DENOMINATOR as u64) as u32;

        // THE RULES AS THEY STOOD WHEN THE BET WAS PLACED — from player_state, NOT
        // from config.
        //
        // This used to read the live config, meaning the authority could see a
        // pending bet and then lower the odds to affect it. In a game that claims
        // verifiable fairness that was unacceptable. play() now freezes these values.
        //
        // The vault BALANCE is not frozen and must not be: "easy mode" depends on how
        // full the vault is at that moment, and that is deliberate — as the vault
        // fills, the odds improve for everyone. What is frozen is the THRESHOLD, not
        // the balance.
        let rent_exempt = Rent::get()?.minimum_balance(0);
        let vault_balance = ctx
            .accounts
            .vault
            .lamports()
            .saturating_sub(rent_exempt);
        let easy_mode = vault_balance >= player_state.bet_vault_easy_threshold_lamports;
        let win_bps = if easy_mode {
            player_state.bet_easy_win_bps
        } else {
            player_state.bet_normal_win_bps
        };
        // If `normal_win_bps` is set greater than zero (that is, there is a small
        // chance of winning in "hard mode" too), the win condition can rarely hold
        // even while the vault has not yet filled up to `big_prize_lamports`. In that
        // case, rather than REFUSING to pay and REVERTING THE WHOLE TRANSACTION
        // (which would leave the player permanently stuck at `pending = true` until
        // the forfeit_stuck_play window opens), we quietly count it as a loss — the
        // player loses their money but at least they can play again. We check here
        // that the vault can cover the largest possible PAYOUT so that payment is
        // guaranteed whichever tier comes up: the jackpot plus the operations fee
        // added on top of it. If we left the fee out of this sum, a winning round
        // with the vault holding exactly the jackpot would pay the prize but fail to
        // pay the fee, the WHOLE transaction would revert and the player would be
        // stuck at `pending = true`. Because the threshold check
        // (`vault_easy_threshold_lamports >= jackpot + fee`) is already enforced in
        // initialize/update_config, this branch is not expected to be reached at all
        // in "easy mode"; it is purely defensive.
        let max_payout = player_state
            .bet_big_prize_lamports
            .checked_add(ops_fee_lamports(
                player_state.bet_big_prize_lamports,
                player_state.bet_treasury_fee_bps,
            )?)
            .ok_or(GameError::MathOverflow)?;
        let won = roll < win_bps as u32 && vault_balance >= max_payout;

        let mut prize_paid: u64 = 0;
        let mut ops_fee_paid: u64 = 0;
        let mut is_big_win = false;
        if won {
            is_big_win = tier_roll < player_state.bet_big_prize_bps as u32;
            let prize_amount = if is_big_win {
                player_state.bet_big_prize_lamports
            } else {
                player_state.bet_small_prize_lamports
            };

            let config_key = ctx.accounts.config.key();
            let vault_bump = config.vault_bump;
            let signer_seeds: &[&[u8]] = &[VAULT_SEED, config_key.as_ref(), &[vault_bump]];

            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    SolTransfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.player.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                prize_amount,
            )?;

            // Operations fee: `treasury_fee_bps` of the prize, NOT deducted from the
            // prize but sent separately from the vault to the treasury. The player
            // receives the full published prize (exactly 0.5 SOL on a 0.5 SOL prize);
            // the total leaving the vault is 0.6 SOL.
            ops_fee_paid = ops_fee_lamports(prize_amount, player_state.bet_treasury_fee_bps)?;
            if ops_fee_paid > 0 {
                system_program::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.to_account_info(),
                        SolTransfer {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.treasury.to_account_info(),
                        },
                        &[signer_seeds],
                    ),
                    ops_fee_paid,
                )?;
            }

            prize_paid = prize_amount;
            player_state.wins_count = player_state
                .wins_count
                .checked_add(1)
                .ok_or(GameError::MathOverflow)?;
            player_state.total_won_lamports = player_state
                .total_won_lamports
                .checked_add(prize_paid)
                .ok_or(GameError::MathOverflow)?;
        }

        player_state.pending = false;

        emit!(PlayResolved {
            player: ctx.accounts.player.key(),
            won,
            prize_paid,
            is_big_win,
            easy_mode,
            ops_fee_paid,
        });

        Ok(())
    }

    /// If a player forgets or fails to have `resolve()` called in time (by
    /// themselves or by anybody else) and the `MAX_RESOLVE_WINDOW_SLOTS` window
    /// closes, the target slot's hash can no longer be found in the SlotHashes
    /// sysvar, so that game becomes impossible to resolve FOREVER — which would
    /// leave the player stuck at `pending = true` and unable to play again. This
    /// function can be called ONLY by the player themselves, and only AFTER the
    /// window has really closed; it counts that attempt as lost (the spin credit
    /// spent is not refunded — it is treated like an ordinary loss), clears
    /// `pending` and lets the player play again.
    pub fn forfeit_stuck_play(ctx: Context<ForfeitStuckPlay>) -> Result<()> {
        let player_state = &mut ctx.accounts.player_state;
        require!(player_state.pending, GameError::NoPendingPlay);

        let config = &ctx.accounts.config;
        let target_slot = player_state
            .commit_slot
            .checked_add(config.reveal_delay_slots)
            .ok_or(GameError::MathOverflow)?;
        let current_slot = Clock::get()?.slot;
        require!(
            current_slot > target_slot.saturating_add(MAX_RESOLVE_WINDOW_SLOTS),
            GameError::ResolveWindowStillOpen
        );

        player_state.pending = false;

        Ok(())
    }
}

/// Writes the `player` field the first time a PlayerState PDA is touched;
/// on every later call it verifies that the field really belongs to the same
/// owner. It guarantees the same behaviour no matter which of `play()`,
/// `buy_spins()` and `register_delegate()` touches the PDA first.
fn ensure_owner(player_state: &mut PlayerState, owner: Pubkey) -> Result<()> {
    if !player_state.initialized {
        player_state.player = owner;
        player_state.initialized = true;
    } else {
        require_keys_eq!(player_state.player, owner, GameError::PlayerMismatch);
    }
    Ok(())
}

/// Computes the operations fee added on top of a prize payout.
///
/// The money flow of the game has a SINGLE "house share" rate:
/// `treasury_fee_bps` (2000 = 20% by default). It is applied in two places —
///   1. `buy_spins()`: 20% of the package paid goes straight to the treasury,
///      80% goes into the vault.
///   2. `resolve()`: on every prize won, an EXTRA amount equal to 20% of the
///      prize is moved from the vault to the treasury — it is NOT deducted
///      from the player's prize. So on a 0.5 SOL prize the player receives the
///      full 0.5 SOL and the treasury separately receives 0.1 SOL; 0.6 SOL
///      leaves the vault in total.
///
/// Tying both to a single rate is deliberate: "we take 20%" should mean the
/// same thing on a deposit and on a prize, with no second number to track.
fn ops_fee_lamports(prize_lamports: u64, fee_bps: u16) -> Result<u64> {
    Ok((prize_lamports as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(GameError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(GameError::MathOverflow)? as u64)
}

/// Finds the hash of the first slot at or after `target_slot` that actually
/// PRODUCED a block, in the SlotHashes sysvar.
///
/// Why not "exactly target_slot": slots can be skipped on Solana — if that
/// slot's leader fails to produce a block, the slot never enters SlotHashes at
/// all. This used to look for an exact match, so whenever the target slot was
/// skipped that game became impossible to settle FOREVER: the player had to
/// wait for the window to close, forfeit, and lose their spin. With a skip
/// rate that reaches 5-15% on devnet at times, that was a real loss of money,
/// happening silently every 10-20 spins.
///
/// Searching forward does not weaken the randomness: the player can neither
/// know nor influence which slot will be skipped, and once the chosen slot has
/// appeared it DOES NOT CHANGE (as larger slots are added, "the smallest slot
/// greater than the target" stays the same) — so the result is still
/// deterministic and verifiable by anyone.
///
/// Parses the raw account data by hand. Because this is one of the "large"
/// sysvars it has to be passed in as account data and read according to the
/// bincode format (rather than through a fast syscall like Clock/Rent): the
/// first 8 bytes are the record count (u64, little-endian), then, for each
/// record, an 8-byte slot number and a 32-byte hash, in descending order with
/// the newest slot first. We parse it by hand instead of using the library's
/// own `SlotHashes` type because we cannot run `anchor build` in this
/// environment to verify the API (see the same warning in
/// program/sell-lock/programs/sell-lock/Cargo.toml) — whereas the raw byte
/// format is a documented, stable part of the Solana runtime.
fn find_slot_hash_at_or_after(
    sysvar_data: &[u8],
    target_slot: u64,
    max_slot: u64,
) -> Option<(u64, [u8; 32])> {
    if sysvar_data.len() < 8 {
        return None;
    }
    let len = u64::from_le_bytes(sysvar_data[0..8].try_into().ok()?) as usize;
    let mut offset = 8usize;
    let mut best: Option<(u64, [u8; 32])> = None;
    for _ in 0..len {
        if offset + 40 > sysvar_data.len() {
            break;
        }
        let slot = u64::from_le_bytes(sysvar_data[offset..offset + 8].try_into().ok()?);
        offset += 40;

        // The sysvar is ordered newest to oldest. The leading records sit ABOVE our
        // window, so we skip them.
        if slot > max_slot {
            continue;
        }
        // We have dropped below the target: since the order is descending, everything
        // after this is smaller still, so there is nothing left to look at. This early
        // exit keeps the scan short — the target is always in the recent past, so in
        // practice we stop after a handful of records. Scanning all 512 records every
        // time would be a pointless compute-unit cost in an instruction like
        // resolve(), which is called on every single spin.
        if slot < target_slot {
            break;
        }
        // We are inside the window. Because we walk in descending order, every new
        // match is SMALLER than the previous one; when the loop ends we hold the slot
        // closest to the target (the smallest acceptable one). Picking the closest one
        // matters: once that slot has appeared it never changes again, so the result
        // stays deterministic.
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&sysvar_data[offset - 32..offset]);
        best = Some((slot, hash));
    }
    best
}

#[account]
pub struct GameConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub free_plays: u8,
    pub small_prize_lamports: u64,
    pub big_prize_lamports: u64,
    // The chance (in bps) that a won game pays the big (jackpot) prize; the
    // remainder is paid as the small prize.
    pub big_prize_bps: u16,
    pub vault_easy_threshold_lamports: u64,
    pub normal_win_bps: u16,
    pub easy_win_bps: u16,
    pub treasury_fee_bps: u16,
    pub reveal_delay_slots: u64,
    // The spin package tariff: spin_tier_counts[i] spins are bought for
    // spin_tier_prices[i] lamports (see buy_spins). The defaults, for example:
    // 1/0.1 SOL, 5/0.3, 10/0.5, 20/0.8, 50/1.5, 100/2.5.
    pub spin_tier_counts: [u16; SPIN_TIERS],
    pub spin_tier_prices: [u64; SPIN_TIERS],
    pub vault_bump: u8,
    pub bump: u8,
}

impl GameConfig {
    // 8 (disc) + 32*2 (pubkeys) + 1 + 8 + 8 + 2 + 8 + 2*3 + 8 + (2*6) + (8*6) + 1 + 1
    pub const LEN: usize =
        8 + 32 * 2 + 1 + 8 + 8 + 2 + 8 + 2 * 3 + 8 + (2 * SPIN_TIERS) + (8 * SPIN_TIERS) + 1 + 1;
}

#[account]
pub struct PlayerState {
    pub player: Pubkey,
    pub plays_count: u32,
    pub wins_count: u32,
    pub pending: bool,
    pub commit_slot: u64,
    pub bump: u8,
    // Has the `player` field been written yet (by whichever of
    // play/buy_spins/register_delegate touched it first).
    pub initialized: bool,
    // Have the free spins been loaded into spins_remaining (on the first play() call).
    pub spins_seeded: bool,
    pub spins_remaining: u32,
    // The local key held in the browser that is allowed to spend this player's
    // spin credit on their behalf (see register_delegate). Pubkey::default() when
    // none is registered.
    pub delegate: Pubkey,
    pub total_won_lamports: u64,
    // Has the one-off +1 bonus spin, granted when the free spins run out, been used.
    pub bonus_granted: bool,

    // --- THE RULES AS THEY STOOD WHEN THE BET WAS PLACED -------------------
    // `play()` copies these from the config and `resolve()` reads them instead
    // of the config. That way a game settles on the odds that applied when the
    // player placed their bet, and the authority cannot change the rules of a
    // pending bet after the fact.
    //
    // Zeros mean "not played yet"; resolve does not run without `pending`
    // anyway, so these fields are always populated by the time they are read.
    pub bet_small_prize_lamports: u64,
    pub bet_big_prize_lamports: u64,
    pub bet_vault_easy_threshold_lamports: u64,
    pub bet_big_prize_bps: u16,
    pub bet_normal_win_bps: u16,
    pub bet_easy_win_bps: u16,
    pub bet_treasury_fee_bps: u16,
}

impl PlayerState {
    // 8 (disc) + 32 + 4 + 4 + 1 + 8 + 1 + 1 + 1 + 4 + 32 + 8 + 1
    //   + the rules at bet time: 8 + 8 + 8 + 2 + 2 + 2 + 2 = 32 bytes
    pub const LEN: usize =
        8 + 32 + 4 + 4 + 1 + 8 + 1 + 1 + 1 + 4 + 32 + 8 + 1 + 8 + 8 + 8 + 2 + 2 + 2 + 2;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = GameConfig::LEN,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, GameConfig>,

    /// CHECK: only recorded into GameConfig as an address; the fee share will be
    /// sent here, and its type does not matter (it can be any wallet).
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, GameConfig>,
}

#[derive(Accounts)]
pub struct BuySpins<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        init_if_needed,
        payer = player,
        space = PlayerState::LEN,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_state: Account<'info, PlayerState>,

    /// CHECK: a PDA that only holds SOL and carries no data (the same pattern as
    /// pool_authority in locked-pool) — it comes into existence on the first
    /// transfer.
    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: the address the fee share is sent to, verified only by matching
    /// config.treasury.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// The caller's registered delegate (if any) — compared against
    /// `player_state.delegate` in the body purely to top the gas buffer back up;
    /// if no delegate is registered, or it does not match, the top-up is silently
    /// skipped. The client always passes the player's local delegate key here.
    /// CHECK: its identity is compared in the body; on a mismatch only the top-up
    /// is skipped, the transaction does not fail.
    #[account(mut)]
    pub delegate: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterDelegate<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        init_if_needed,
        payer = player,
        space = PlayerState::LEN,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_state: Account<'info, PlayerState>,

    /// CHECK: a PDA that only holds SOL and carries no data — the source of the
    /// first vault sponsorship (so that the free spin really is free).
    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// The local delegate key to be authorized — the target of the vault
    /// sponsorship on first registration.
    /// CHECK: only the destination of a SOL transfer, not otherwise verified by
    /// the program (it is the player's own choice, made with their own signature).
    #[account(mut)]
    pub delegate: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    /// The real player's address — the PlayerState PDA is derived from it. It does
    /// NOT have to sign; the `authority` below (the player themselves or their
    /// registered delegate) signs. The real identity match is enforced in the body
    /// (`ensure_owner`) and by the `player_state.delegate` comparison.
    /// CHECK: an address used only to derive the PDA.
    pub owner: UncheckedAccount<'info>,

    /// The party that actually signs this transaction — it can be the player
    /// themselves or the local delegate registered with `register_delegate()`
    /// (verified in the body). If PlayerState is created for the first time by
    /// this call (because buy_spins/register_delegate were never called before),
    /// this account also pays the rent.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = PlayerState::LEN,
        seeds = [PLAYER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub player_state: Account<'info, PlayerState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    /// A permissionless call — no signature check is needed here, because win or
    /// lose is already fixed by the target slot's hash. The prize still goes ONLY
    /// to this account (the wallet that started the game); the caller does not
    /// have to be the same party. That this account really matches
    /// `player_state.player` cannot be expressed with a macro constraint here
    /// because of the seed ordering — see the `require_keys_eq!` check in the
    /// body of `resolve()`.
    /// CHECK: its identity is verified in the function body.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_state.bump,
    )]
    pub player_state: Account<'info, PlayerState>,

    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// The address the operations fee added on top of the prize goes to on won
    /// rounds — the same wallet as the 20% share in `buy_spins()`.
    /// CHECK: an address verified only by matching `config.treasury`.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: its address is compared by hand against `slot_hashes::ID` (require_keys_eq!).
    pub slot_hashes: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ForfeitStuckPlay<'info> {
    pub player: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_state.bump,
        has_one = player,
    )]
    pub player_state: Account<'info, PlayerState>,
}

#[event]
pub struct SpinsPurchased {
    pub player: Pubkey,
    pub tier_index: u8,
    pub spin_count: u32,
    pub price_lamports: u64,
    pub spins_remaining: u32,
}

#[event]
pub struct PlayCommitted {
    pub player: Pubkey,
    pub plays_count: u32,
    pub spins_remaining: u32,
    pub bonus_granted: bool,
    pub commit_slot: u64,
}

#[event]
pub struct PlayResolved {
    pub player: Pubkey,
    pub won: bool,
    pub prize_paid: u64,
    pub is_big_win: bool,
    pub easy_mode: bool,
    // The operations fee moved separately from the vault to the treasury on top of
    // the prize. Appending the field at the END is deliberate: the byte positions
    // of the earlier fields do not change, so older clients can still read the event.
    pub ops_fee_paid: u64,
}

#[error_code]
pub enum GameError {
    #[msg("Invalid parameter.")]
    InvalidParam,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("This wallet already has an unsettled game — resolve it first.")]
    PlayAlreadyPending,
    #[msg("There is no pending game.")]
    NoPendingPlay,
    #[msg("The player account does not match the owner of this player_state.")]
    PlayerMismatch,
    #[msg("The signer of this transaction is neither the player nor their registered delegate.")]
    UnauthorizedSigner,
    #[msg("No spin credit left — buy a package with buy_spins() first.")]
    NoSpinsRemaining,
    #[msg("Too early to resolve — the target slot has not been reached.")]
    TooEarlyToResolve,
    #[msg("The resolve window has closed, see forfeit_stuck_play.")]
    ResolveWindowExpired,
    #[msg("The resolve window has not closed yet — try resolve() first.")]
    ResolveWindowStillOpen,
    #[msg("Invalid SlotHashes sysvar account.")]
    InvalidSlotHashesAccount,
    #[msg("The target slot hash was not found in the SlotHashes sysvar.")]
    SlotHashNotFound,
}
