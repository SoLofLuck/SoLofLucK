// ---------------------------------------------------------------------------
// CHAOS TEST — random scenario sequences + invariant checks at every step
// ---------------------------------------------------------------------------
// The other tests exercise the scenarios I KNOW ABOUT. This one looks for the
// ones I do not.
//
// Most of the bugs a paid audit finds are of the form "if these three things
// happen in this order": steps that are each correct on their own break an
// invariant when combined in a particular sequence. Hand-written tests cannot
// see those combinations, because whoever writes the test writes down what
// already occurred to them.
//
// Instead, this generates random player x random action x random time jump and
// checks the invariants AFTER EVERY TRANSACTION.
//
// MOST OF THE INVARIANTS ARE MODEL-FREE — that is, I do not rewrite here what
// the program is supposed to do. If I copy the program's logic into the test,
// the test proves that the program agrees with my copy rather than with itself;
// and if I make the same mistake in the copy, both are wrong together and the
// test stays green. Instead I look at things that MUST be true from the
// outside:
//
//   D1. Lamport conservation — the SUM of the tracked accounts must never
//       change. ctx.payer pays the transaction fees (see common::send), so
//       money can only MOVE between the players, the vault and the treasury.
//
//       HONESTLY: this is NOT as strong a check as I thought. Solana already
//       enforces lamport conservation at the transaction level — an
//       instruction cannot create or destroy lamports out of nothing, and the
//       transaction fails if it tries. I learned this while attempting
//       sabotage: versions that tried to destroy money were rejected by the
//       chain before they ever reached D1.
//
//       D1's real value is narrower but still real: it verifies that money
//       does not leave the set of accounts WE TRACK. Every address the program
//       can send money to today is in that set; if somebody adds a new
//       destination account tomorrow (an instruction paying an
//       attacker-supplied address, say), D1 catches it. So it is a
//       forward-looking regression guard, not proof about today's code.
//   D2. The vault must not fall below the rent floor — if it does, Solana
//       reverts THE WHOLE TRANSACTION and the player is stuck on a pending
//       game.
//   D3. The win count cannot exceed the play count.
//   D4. The total prize paid must lie in the range
//       win count x [small prize, jackpot].
//   D5. Once the window has closed the player must ALWAYS be able to forfeit —
//       that is, no player may be permanently stuck in the "pending game"
//       state.
//   D6. (only on the run with free spins OFF) exact spin accounting: a
//       purchase increases the balance by exactly the package, a play
//       decreases it by exactly 1.
//
// The seed is fixed, so that when a bug is found THE SAME sequence can be
// reproduced. Other seeds can be run through the CHAOS_SEED environment
// variable; CI runs a few different ones.

mod common;

use common::*;
use solana_sdk::signature::{Keypair, Signer};

/// xorshift64* — deterministic, reproducible from the seed.
/// A test's randomness must NEVER be real randomness: if we cannot repeat a
/// failing run, we cannot debug it.
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self {
        Rng(if seed == 0 { 0x9E3779B97F4A7C15 } else { seed })
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct Player {
    kp: Keypair,
    delegate: Keypair,
    delegate_registered: bool,
}

/// The total lamports across every tracked account.
///
/// Because ctx.payer pays the transaction fees, this total must stay CONSTANT —
/// money can only move between these accounts.
async fn total_lamports(game: &mut Game, players: &[Player]) -> u128 {
    let mut t: u128 = 0;
    t += game.lamports(&game.vault.clone()).await as u128;
    t += game.lamports(&game.treasury.clone()).await as u128;
    for o in players {
        t += game.lamports(&o.kp.pubkey()).await as u128;
        t += game.lamports(&o.delegate.pubkey()).await as u128;
        let (pda, _) = player_pda(&o.kp.pubkey());
        t += game.lamports(&pda).await as u128;
    }
    t
}

/// The floor a 0-byte account needs in order to exist.
async fn rent_floor(game: &mut Game) -> u64 {
    game.ctx
        .banks_client
        .get_sysvar::<solana_sdk::sysvar::rent::Rent>()
        .await
        .unwrap()
        .minimum_balance(0)
}

/// Fills the SlotHashes sysvar "realistically": with some of the last `window`
/// slots SKIPPED (no block produced).
///
/// A skipped slot once caused a real money-losing bug in this program;
/// producing them constantly in the chaos run is deliberate.
fn set_up_slot_hashes(
    game: &mut Game,
    now: u64,
    window: u64,
    rng: &mut Rng,
    required: Option<u64>,
) {
    let mut entries: Vec<(u64, [u8; 32])> = Vec::new();
    let start = now.saturating_sub(window);
    for s in start..=now {
        // ~12% of slots are skipped — close to the devnet rate.
        // The `required` slot is never skipped: while testing the D7 invariant,
        // this removes the "there was no hash" excuse.
        if Some(s) != required && rng.below(100) < 12 {
            continue;
        }
        let mut h = [0u8; 32];
        let v = rng.next().to_le_bytes();
        for (i, b) in h.iter_mut().enumerate() {
            *b = v[i % 8] ^ (i as u8);
        }
        entries.push((s, h));
    }
    game.set_slot_hashes(&entries);
}

async fn run_chaos(
    seed: u64,
    step_count: u32,
    free_plays: u8,
    exact_spin_accounting: bool,
    vault_lamports: u64,
) {
    let mut rng = Rng::new(seed);
    let mut game =
        Game::start_with(vault_lamports, NORMAL_WIN_BPS, EASY_WIN_BPS, free_plays).await;

    let mut players: Vec<Player> = Vec::new();
    for _ in 0..4 {
        let kp = Keypair::new();
        let delegate = Keypair::new();
        fund(&mut game.ctx, &kp.pubkey(), 30 * SOL).await;
        players.push(Player { kp, delegate, delegate_registered: false });
    }

    let floor = rent_floor(&mut game).await;
    let initial_total = total_lamports(&mut game, &players).await;

    // warp_to_slot cannot go backwards; we always move the slot forward.
    let mut slot = game.slot().await.max(1_000) + 1_000;
    game.warp(slot);

    let mut successful = 0u32;
    let mut resolved = 0u32;
    let mut winner = 0u32;
    let mut forfeited = 0u32;

    for step in 0..step_count {
        // TIME FLOWS AT EVERY STEP. In the first version the slot only advanced
        // occasionally and resolve almost never succeeded (twice in 260 steps) — so
        // the payout path, the very thing the test looks at hardest, was not being
        // exercised at all. On the real chain slots are produced continuously;
        // modelling that runs resolve at a meaningful rate.
        slot += 1 + rng.below(6);
        game.warp(slot);

        let action = rng.below(100);

        // THE PLAYER IS CHOSEN ACCORDING TO THE ACTION.
        //
        // In the first version the player was chosen entirely at random, and nearly
        // every resolve call landed on a player with NO pending game and failed with
        // NoPendingPlay: only 18 games settled in 400 steps, so the payout path — the
        // very thing the test looks at hardest — was not being exercised.
        //
        // In real life whoever calls resolve (the player or a keeper) knows which
        // game is pending, so these actions mostly pick a player who has one. Even
        // so, a quarter of the time the choice is random, so that the "try to settle
        // a player with no pending game" error path is exercised too. The scan only
        // happens on resolve/forfeit steps; reading four accounts on every step made
        // the run three times slower for nothing.
        let mut pending: Vec<usize> = Vec::new();
        if (65..97).contains(&action) {
            for (idx, o) in players.iter().enumerate() {
                if game
                    .player_state(&o.kp.pubkey())
                    .await
                    .map(|s| s.pending)
                    .unwrap_or(false)
                {
                    pending.push(idx);
                }
            }
        }
        let targeted = !pending.is_empty() && rng.below(4) != 0;
        let i = if targeted {
            pending[rng.below(pending.len() as u64) as usize]
        } else {
            rng.below(players.len() as u64) as usize
        };
        let player_key = players[i].kp.pubkey();
        let delegate_key = players[i].delegate.pubkey();

        // The state BEFORE the action — the deltas are checked against it.
        let before = game.player_state(&player_key).await;
        let spins_before = before.as_ref().map(|s| s.spins_remaining).unwrap_or(0);
        let plays_before = before.as_ref().map(|s| s.plays_count).unwrap_or(0);
        let result: Result<(), solana_sdk::transport::TransportError>;
        let mut chosen_package: Option<u8> = None;

        if action < 25 {
            // --- buy a package ---
            let package = rng.below(TIER_COUNTS.len() as u64) as u8;
            chosen_package = Some(package);
            let ix = game.buy_spins_ix(&player_key, &delegate_key, package);
            let kp = players[i].kp.insecure_clone();
            result = game.send(&[ix], &[&kp]).await;
        } else if action < 33 {
            // --- delegate kaydet ---
            let ix = game.register_delegate_ix(&player_key, &delegate_key);
            let kp = players[i].kp.insecure_clone();
            result = game.send(&[ix], &[&kp]).await;
            if result.is_ok() {
                players[i].delegate_registered = true;
            }
        } else if action < 65 {
            // --- play --- (sometimes with the delegate, sometimes with the wallet itself)
            let with_delegate = players[i].delegate_registered && rng.below(2) == 0;
            if with_delegate {
                fund(&mut game.ctx, &delegate_key, 0).await; // a no-op safety net
                let ix = game.play_ix(&player_key, &delegate_key);
                let d = players[i].delegate.insecure_clone();
                result = game.send(&[ix], &[&d]).await;
            } else {
                let ix = game.play_ix(&player_key, &player_key);
                let kp = players[i].kp.insecure_clone();
                result = game.send(&[ix], &[&kp]).await;
            }
        } else if action < 93 {
            // --- settle --- (permissionless: ctx.payer calls it)
            // D7'S PRECONDITIONS. If a pending game's window is OPEN and the target
            // slot's hash is in the sysvar, there is no legitimate reason for resolve to
            // fail — if the vault cannot pay, the program already counts that as a loss
            // rather than failing the transaction.
            let target_slot = before
                .as_ref()
                .filter(|s| s.pending)
                .map(|s| s.commit_slot + REVEAL_DELAY);
            let window_open = target_slot
                .map(|t| slot > t && slot <= t + MAX_RESOLVE_WINDOW_TEST)
                .unwrap_or(false);
            set_up_slot_hashes(&mut game, slot, 400, &mut rng, target_slot);
            let ix = game.resolve_ix(&player_key);
            let winnings_before = before.as_ref().map(|s| s.wins_count).unwrap_or(0);
            result = game.send(&[ix], &[]).await;
            if window_open {
                // D7 — the SILENT form of being stuck.
                //
                // This invariant exists to catch a bug D5 missed: with the vault near
                // the rent floor, a winning round made the payout take the vault below
                // the floor and so reverted THE WHOLE TRANSACTION. The player is not
                // permanently stuck (once the window closes they can forfeit) — but
                // they never receive the prize they won and simply lose their spin. So
                // D5 was rightly silent and the bug was invisible.
                //
                // It came to light through sabotage: a version that ignored the rent
                // share in the vault passed ALL the tests of the time.
                assert!(
                    result.is_ok(),
                    "D7 BROKEN (seed={seed} step={step}): a pending game's window is \
                     open (slot {slot}, target {:?}) and the target slot's hash is in the \
                     sysvar, but resolve failed: {:?}",
                    target_slot,
                    result.err()
                );
            }
            if result.is_ok() {
                resolved += 1;
                if let Some(s) = game.player_state(&player_key).await {
                    if s.wins_count > winnings_before {
                        winner += 1;
                    }
                }
            }
        } else if action < 97 {
            // --- cancel a stuck game ---
            let ix = game.forfeit_ix(&player_key);
            let kp = players[i].kp.insecure_clone();
            result = game.send(&[ix], &[&kp]).await;
            if result.is_ok() {
                forfeited += 1;
            }
        } else {
            // --- a big time jump --- far enough to OVERSHOOT the resolve window,
            // deliberately producing the "stuck game" state.
            //
            // It has to be RARE (3%): this jump closes the window of EVERY pending game
            // at once. In the first version it was 8%, and because it swept the pool
            // roughly every 12 steps resolve could hardly ever run.
            slot += 350 + rng.below(200);
            game.warp(slot);
            set_up_slot_hashes(&mut game, slot, 400, &mut rng, None);
            continue;
        }

        if result.is_ok() {
            successful += 1;
        }

        // ---------------- THE INVARIANTS ----------------
        let label = format!("seed={seed} step={step}");

        // D1 — lamport korunumu
        let now_total = total_lamports(&mut game, &players).await;
        assert_eq!(
            now_total, initial_total,
            "D1 BROKEN ({label}): the lamport total of the tracked accounts changed \
             (initially {initial_total}, now {now_total}). \
             Money was either created from nothing or evaporated."
        );

        // D2 — the vault did not fall below the rent floor
        let vault = game.lamports(&game.vault.clone()).await;
        assert!(
            vault == 0 || vault >= floor,
            "D2 BROKEN ({label}): the vault holds {vault} lamports — the rent floor is \
             {floor}. Below that level Solana reverts THE WHOLE transaction and the \
             player gets stuck."
        );

        let after = game.player_state(&player_key).await;
        if let Some(s) = after.as_ref() {
            // D3 — kazanma ≤ oynama
            assert!(
                s.wins_count <= s.plays_count,
                "D3 BOZULDU ({label}): kazanma {} > oynama {}",
                s.wins_count,
                s.plays_count
            );

            // D4 — the prize total is consistent with the win count
            let lower = s.wins_count as u128 * SMALL_PRIZE as u128;
            let upper = s.wins_count as u128 * BIG_PRIZE as u128;
            let prize = s.total_won_lamports as u128;
            assert!(
                prize >= lower && prize <= upper,
                "D4 BROKEN ({label}): {} paid for {prize} wins, \
                 expected range [{lower}, {upper}]",
                s.wins_count
            );

            // D6 — spin accounting (exact only when free spins are off)
            if exact_spin_accounting && result.is_ok() {
                if let Some(package) = chosen_package {
                    assert_eq!(
                        s.spins_remaining,
                        spins_before + TIER_COUNTS[package as usize] as u32,
                        "D6 BROKEN ({label}): a package of {} spins was bought but the balance \
                         {spins_before} -> {}",
                        TIER_COUNTS[package as usize],
                        s.spins_remaining
                    );
                } else if s.plays_count == plays_before + 1 {
                    // A successful play: exactly 1 spin must be spent.
                    assert_eq!(
                        s.spins_remaining,
                        spins_before.saturating_sub(1),
                        "D6 BOZULDU ({label}): bir oynama {spins_before} -> {} spin",
                        s.spins_remaining
                    );
                }
            }
        }
    }

    // D5 — no player may be permanently stuck.
    //
    // We close the window for certain and prove that EVERY pending game CAN be
    // cancelled. This is the last safety valve — it protects not the player's
    // money but their ability to keep playing.
    slot += MAX_RESOLVE_WINDOW_TEST + REVEAL_DELAY + 50;
    game.warp(slot);
    let mut cancelled = 0;
    let keys: Vec<(Keypair, _)> = players
        .iter()
        .map(|o| (o.kp.insecure_clone(), o.kp.pubkey()))
        .collect();
    for (kp, key) in &keys {
        let key = *key;
        let state = game.player_state(&key).await;
        if state.map(|s| s.pending).unwrap_or(false) {
            let ix = game.forfeit_ix(&key);
            let kp = kp.insecure_clone();
            game.send(&[ix], &[&kp]).await.unwrap_or_else(|e| {
                panic!(
                    "D5 BROKEN (seed={seed}): the window is closed but a pending game \
                     could not be cancelled — the player is PERMANENTLY stuck: {e:?}"
                )
            });
            let after = game.player_state(&key).await.unwrap();
            assert!(
                !after.pending,
                "D5 BROKEN (seed={seed}): forfeit succeeded but pending is still true"
            );
            cancelled += 1;
        }
    }

    // We prove the run REALLY did some work. Without this, a broken program that
    // rejected everything would also "pass" this test.
    assert!(
        successful > step_count / 6,
        "seed={seed}: only {successful}/{step_count} transactions went through — \
         the chaos run covered no meaningful ground"
    );
    assert!(
        resolved >= 15,
        "seed={seed}: only {resolved} games settled — the resolve path was not \
         exercised enough, the run is not meaningful"
    );
    // We prove the payout branch REALLY runs while the vault is full. Without
    // this, a broken program that "never pays anyone" would also pass this test —
    // and D1 through D4 would all still hold.
    if vault_lamports >= EASY_THRESHOLD {
        assert!(
            winner > 0,
            "seed={seed}: not a single winner came out of {resolved} settled rounds — \
             the payout branch may never have run"
        );
    }

    println!(
        "seed={seed} · {successful}/{step_count} transactions · {resolved} settled \
         ({winner} winners) · {forfeited} cancelled · {cancelled} recovered at the end"
    );
}

/// Must match the program constant (see MAX_RESOLVE_WINDOW_SLOTS).
/// check-tokenomics separately verifies that config.ts and lib.rs agree.
const MAX_RESOLVE_WINDOW_TEST: u64 = 300;

#[tokio::test]
async fn chaos_free_spins_off() {
    // With free spins off, spin accounting can be verified exactly.
    run_chaos(0xA11CE, 400, 0, true, 50 * SOL).await;
}

#[tokio::test]
async fn chaos_free_spins_on() {
    // The free spins + bonus spin path: instead of building an accounting model
    // we rely on the model-free invariants.
    run_chaos(0xB0B, 400, 3, false, 50 * SOL).await;
}

#[tokio::test]
async fn chaos_vault_starts_empty() {
    // The vault starts too empty to pay the jackpot: this proves the "won but
    // there is no money in the vault" branch does not leave the player stuck.
    // Because purchases fill the vault, the payout branch comes into play as the
    // run progresses.
    run_chaos(0xDEAD, 400, 0, true, 0).await;
}

#[tokio::test]
async fn chaos_vault_at_payout_threshold() {
    // The vault starts just barely full enough to cover the jackpot plus its share.
    //
    // AN IMPORTANT RUN: because the payout brings the vault close to the rent
    // floor, the "won but the payout would take the vault below the floor" branch
    // is genuinely produced here. In the other runs the vault starts with 50 SOL
    // and never came down to this level — the sabotage test exposed that gap.
    run_chaos(0x5AFE, 400, 0, true, EASY_THRESHOLD + 2_000_000).await;
}

// The same code produces different sequences from different seeds. A single
// seed may be "lucky"; running several widens the coverage cheaply.
#[tokio::test]
async fn chaos_extra_seeds() {
    for seed in [0x1234_5678u64, 0xFEED_FACE, 0x0BAD_C0DE, 0xC0FF_EE00] {
        run_chaos(seed, 400, 0, true, 50 * SOL).await;
    }
}

// ---------------------------------------------------------------------------
// THE VAULT NEAR THE RENT FLOOR — a targeted regression test
// ---------------------------------------------------------------------------
// This test exists to catch a bug the chaos run COULD NOT FIND; its existence
// is owed to the sabotage test as well.
//
// The sabotage was this: let resolve() ask "can I pay?" without accounting for
// the rent share in the vault —
//     let vault_balance = ctx.accounts.vault.lamports();          // NO rent
//   instead of the correct
//     let vault_balance = ctx.accounts.vault.lamports() - rent;
//
// That version passed ALL the tests of the time. What it does is this: while
// the vault is only just full enough to cover the prize, the round counts as
// WON, the payout takes the vault BELOW a 0-byte account's rent floor, and
// Solana reverts THE WHOLE TRANSACTION. The result: the player never receives
// the prize they won and simply loses their spin. No trace is left on the chain
// or in the logs.
//
// Why the chaos run could not find it: the vault has to land exactly in the
// [max_payout, max_payout + rent) band — a window of 890,880 lamports. Hitting
// that in a random sequence is practically impossible. So the scenario is set
// up DIRECTLY here.
//
// To leave nothing about winning to chance, the rates are set to 100% (every
// round wins, every winner takes the jackpot) — so the test gives a definite
// answer in a single run.
#[tokio::test]
async fn winning_round_does_not_fail_when_vault_is_near_the_floor() {
    let mut game = Game::start_with(0, 10_000, 10_000, 0).await;
    let floor = rent_floor(&mut game).await;

    // Let every winner take the jackpot: the payout is exactly max_payout.
    let ix = solana_sdk::instruction::Instruction {
        program_id: luck_game::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &luck_game::accounts::UpdateConfig {
                authority: game.authority.pubkey(),
                config: game.config,
            },
            None,
        ),
        data: anchor_lang::InstructionData::data(&luck_game::instruction::UpdateConfig {
            new_treasury: game.treasury,
            free_plays: 0,
            small_prize_lamports: SMALL_PRIZE,
            big_prize_lamports: BIG_PRIZE,
            big_prize_bps: 10_000, // 100% of winners take the jackpot
            vault_easy_threshold_lamports: EASY_THRESHOLD,
            normal_win_bps: 10_000,
            easy_win_bps: 10_000,
            treasury_fee_bps: TREASURY_FEE_BPS,
            spin_tier_counts: TIER_COUNTS,
            spin_tier_prices: TIER_PRICES,
        }),
    };
    let auth = game.authority.insecure_clone();
    game.send(&[ix], &[&auth]).await.unwrap();

    // The payout = the jackpot plus the house share added on top.
    let max_payout = BIG_PRIZE + BIG_PRIZE * TREASURY_FEE_BPS as u64 / 10_000;

    // THE CRITICAL LEVEL: the vault covers the payout, but after paying it would
    // be BELOW the rent floor. Correct code must say "did not win" here; code that
    // ignores the rent share attempts the payout and fails the whole transaction.
    let critical = max_payout + floor - 1;

    let player = Keypair::new();
    let delegate = Keypair::new();
    fund(&mut game.ctx, &player.pubkey(), 10 * SOL).await;
    let player_key = player.pubkey();

    // Buy the cheapest package (money enters the vault, so we set the vault AFTER).
    let ix = game.buy_spins_ix(&player_key, &delegate.pubkey(), 0);
    game.send(&[ix], &[&player]).await.unwrap();

    // Bring the vault to exactly the critical level.
    let now = game.lamports(&game.vault.clone()).await;
    assert!(
        now < critical,
        "the vault is already above the critical level ({now} >= {critical}) — the test setup is broken"
    );
    let vault = game.vault;
    fund(&mut game.ctx, &vault, critical - now).await;
    assert_eq!(game.lamports(&vault).await, critical);

    // Play, pass the target slot, settle.
    let ix = game.play_ix(&player_key, &player_key);
    game.send(&[ix], &[&player]).await.unwrap();
    let commit = game.player_state(&player_key).await.unwrap().commit_slot;
    let target = commit + REVEAL_DELAY;
    let now_slot = target + 3;
    game.warp(now_slot);
    let mut rng = Rng::new(0xF10);
    set_up_slot_hashes(&mut game, now_slot, 50, &mut rng, Some(target));

    let ix = game.resolve_ix(&player_key);
    game.send(&[ix], &[]).await.unwrap_or_else(|e| {
        panic!(
            "With the vault at the critical level ({critical} lamports, rent floor \
             {floor}) resolve FAILED: {e:?}\nThat means the player loses their spin \
             without receiving the round they won — and sees no error message."
        )
    });

    let state = game.player_state(&player_key).await.unwrap();
    assert!(!state.pending, "resolve succeeded but the game is still pending");
    // The correct behaviour: NO payout (the vault is short) and the round counts as a loss.
    assert_eq!(
        state.wins_count, 0,
        "a win was recorded while the vault could not cover the payout — vault {}",
        game.lamports(&vault).await
    );
    assert_eq!(
        game.lamports(&vault).await,
        critical,
        "money left the vault even though it was short"
    );

    // Now the level that is JUST ENOUGH: one lamport more. This time it must pay.
    fund(&mut game.ctx, &vault, 1).await;
    let ix = game.buy_spins_ix(&player_key, &delegate.pubkey(), 0);
    game.send(&[ix], &[&player]).await.unwrap();
    // Because the purchase adds money to the vault, rather than pinning the level
    // again we only verify that the payout DID HAPPEN.
    let vault_before = game.lamports(&vault).await;
    let ix = game.play_ix(&player_key, &player_key);
    game.send(&[ix], &[&player]).await.unwrap();
    let commit = game.player_state(&player_key).await.unwrap().commit_slot;
    let target = commit + REVEAL_DELAY;
    let now_slot = target + 3;
    game.warp(now_slot);
    set_up_slot_hashes(&mut game, now_slot, 50, &mut rng, Some(target));
    let ix = game.resolve_ix(&player_key);
    game.send(&[ix], &[]).await.unwrap();

    let state = game.player_state(&player_key).await.unwrap();
    assert_eq!(
        state.wins_count, 1,
        "no win was recorded while the vault was sufficient — despite a 100% rate"
    );
    assert_eq!(
        game.lamports(&vault).await,
        vault_before - max_payout,
        "the payout amount differs from what was expected"
    );
    println!(
        "critical level {critical} lamports (rent floor {floor}) · payout {max_payout} · \
         not paid when short, paid when sufficient"
    );
}
