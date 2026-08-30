// ---------------------------------------------------------------------------
// luck-game behaviour tests
// ---------------------------------------------------------------------------
// Ordered by where money can go missing:
//   1. Does the player pay MORE than the published package price
//   2. Can money leave the vault without permission
//   3. Can a spin credit be burnt silently
//   4. Does the advertised win rate match the rate that actually happens
mod common;

use common::*;
use luck_game::GameError;
use solana_sdk::{pubkey::Pubkey, signature::Signer, signer::keypair::Keypair};

// ---------------------------------------------------------------------------
// 1. Buying: the amount that leaves the player's pocket
// ---------------------------------------------------------------------------

/// This was the actual complaint the user reported: on the 0.1 SOL package
/// Phantom showed -0.101622 SOL. The excess was the rent deposit for the
/// player_state account. The vault now pays that back; what leaves the player's
/// pocket has to be EXACTLY the package price (excluding the transaction fee —
/// Solana takes that, not us).
#[tokio::test]
async fn the_first_purchase_charges_exactly_the_package_price() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    let before = g.lamports(&player.pubkey()).await;
    let ix = g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 0);
    g.send(&[ix], &[&player]).await.unwrap();
    let after = g.lamports(&player.pubkey()).await;

    // The transaction fee is paid by the payer (ctx.payer), not by the player — so
    // the change in the player's balance has to be exactly the package price.
    assert_eq!(
        before - after,
        TIER_PRICES[0],
        "an amount other than the package price left the player"
    );
}

/// The rent refund must happen ONLY on the first purchase. Otherwise the vault
/// leaks 0.0016 SOL on every purchase.
#[tokio::test]
async fn no_rent_refund_on_a_second_purchase() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    let ix = g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 0);
    g.send(std::slice::from_ref(&ix), &[&player]).await.unwrap();

    let before = g.lamports(&player.pubkey()).await;
    g.send(&[ix], &[&player]).await.unwrap();
    let after = g.lamports(&player.pubkey()).await;

    assert_eq!(before - after, TIER_PRICES[0], "the amount differs on the second purchase");
}

/// The vault has to cover the refund to the player and the transfer to the
/// delegate out of ITS OWN share; because the player always pays the full price,
/// the vault + treasury total grows by the package price less the onboarding
/// cost.
#[tokio::test]
async fn the_house_share_is_computed_after_the_onboarding_cost_is_deducted() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    let treasury_before = g.lamports(&g.treasury.clone()).await;
    let ix = g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 0);
    g.send(&[ix], &[&player]).await.unwrap();
    let treasury_after = g.lamports(&g.treasury.clone()).await;

    let fee = treasury_after - treasury_before;
    // This is what the house share would be if it were taken on the WHOLE package:
    let naive = TIER_PRICES[0] * TREASURY_FEE_BPS as u64 / 10_000;
    assert!(
        fee < naive,
        "the house share is still taken on the whole package: {fee} >= {naive}"
    );
    // ...and it has to be lower by the onboarding cost, and only by that much.
    let onboarding = naive - fee;
    let onboarding = onboarding * 10_000 / TREASURY_FEE_BPS as u64;
    assert!(
        onboarding > 0 && onboarding < TIER_PRICES[0],
        "the onboarding cost makes no sense: {onboarding}"
    );
}

/// register_delegate MUST NOT TAKE ANY MONEY OUT OF THE VAULT. It used to, and
/// because it can be called without permission, registering over and over with
/// empty wallets to drain the vault was a PROFITABLE attack.
#[tokio::test]
async fn registration_takes_no_money_out_of_the_vault() {
    let mut g = Game::start(50 * SOL).await;
    let vault_before = g.lamports(&g.vault.clone()).await;

    // Registering with a hundred separate empty wallets: under the old behaviour
    // this would have leaked 100 x 200_000 lamports.
    for _ in 0..25 {
        let attacker = new_player(&mut g.ctx, SOL).await;
        let delegate = Keypair::new();
        let ix = g.register_delegate_ix(&attacker.pubkey(), &delegate.pubkey());
        g.send(&[ix], &[&attacker]).await.unwrap();
    }

    let vault_after = g.lamports(&g.vault.clone()).await;
    assert_eq!(vault_before, vault_after, "money leaked out of the vault");
}

// ---------------------------------------------------------------------------
// 2. Spin muhasebesi
// ---------------------------------------------------------------------------

/// The user managed to spin 8 times for 0.1 SOL: the on-chain free_plays were
/// being added ON TOP of the free spins held in the browser. With free_plays = 0
/// a 1-spin package has to give EXACTLY 1 spin.
#[tokio::test]
async fn a_one_spin_package_gives_exactly_one_spin() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    let ix = g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 0);
    g.send(&[ix], &[&player]).await.unwrap();

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert_eq!(st.spins_remaining, 1, "the package gave a different number of spins than expected");

    // One play -> 0 left, and the second one has to be rejected.
    g.send(&[g.play_ix(&player.pubkey(), &player.pubkey())], &[&player])
        .await
        .unwrap();
    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert_eq!(st.spins_remaining, 0);
    assert!(st.pending);
}

#[tokio::test]
async fn cannot_play_without_a_spin() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;

    let err = g
        .send(&[g.play_ix(&player.pubkey(), &player.pubkey())], &[&player])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::NoSpinsRemaining);
}

/// A second game cannot be played while one is pending — otherwise a player
/// could skip resolving a round they saw themselves lose and start a new one.
#[tokio::test]
async fn cannot_play_again_while_a_game_is_pending() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    g.send(
        &[g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 1)],
        &[&player],
    )
    .await
    .unwrap();
    g.send(&[g.play_ix(&player.pubkey(), &player.pubkey())], &[&player])
        .await
        .unwrap();

    let next = g.slot().await + 1;
    g.warp(next);
    let err = g
        .send(&[g.play_ix(&player.pubkey(), &player.pubkey())], &[&player])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::PlayAlreadyPending);
}

/// A key that is not registered cannot spend somebody else's spin.
#[tokio::test]
async fn a_foreign_delegate_cannot_spend_somebody_elses_spin() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();
    let stranger = new_player(&mut g.ctx, SOL).await;

    g.send(
        &[g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 1)],
        &[&player],
    )
    .await
    .unwrap();

    let err = g
        .send(
            &[g.play_ix(&player.pubkey(), &stranger.pubkey())],
            &[&stranger],
        )
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::UnauthorizedSigner);
}

// ---------------------------------------------------------------------------
// 3. Resolve: the timing and a skipped slot
// ---------------------------------------------------------------------------

/// Puts a player into the "pending game" state and returns the target slot.
async fn play(g: &mut Game, player: &Keypair, delegate: &Pubkey, tier: u8) -> u64 {
    g.send(&[g.buy_spins_ix(&player.pubkey(), delegate, tier)], &[player])
        .await
        .unwrap();
    g.send(&[g.play_ix(&player.pubkey(), &player.pubkey())], &[player])
        .await
        .unwrap();
    let st = g.player_state(&player.pubkey()).await.unwrap();
    st.commit_slot + REVEAL_DELAY
}

#[tokio::test]
async fn cannot_resolve_before_reaching_the_target_slot() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 0).await;

    g.set_slot_hashes(&[(target, [7u8; 32])]);
    let err = g
        .send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::TooEarlyToResolve);
}

/// THE ACTUAL FIX. If the target slot was skipped (its leader failed to produce
/// a block) it never enters SlotHashes at all. This used to look for an EXACT
/// MATCH, so such a game could never be settled and the player lost their spin.
/// The skip rate on devnet reaches 5-15% at times — a real loss of money,
/// happening silently every 10-20 spins.
#[tokio::test]
async fn a_skipped_target_slot_settles_with_the_next_slot() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 0).await;

    g.warp(target + 3);
    // The target slot and the two slots after it were SKIPPED; the first slot
    // target + 3.
    g.set_slot_hashes(&[(target - 1, [1u8; 32]), (target + 3, [9u8; 32])]);

    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .expect("resolve failed because the target slot was skipped");

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "the game is still pending");
}

/// If there is no produced slot INSIDE the window at all (it does not really
/// happen, but still) resolve fails and the player is steered towards forfeit —
/// a wrong result is never produced silently.
#[tokio::test]
async fn resolve_fails_when_the_window_holds_no_slot() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 0).await;

    g.warp(target + 2);
    // Only slots BEFORE the target exist.
    g.set_slot_hashes(&[(target - 2, [1u8; 32]), (target - 1, [2u8; 32])]);

    let err = g
        .send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::SlotHashNotFound);
}

/// The same game cannot be settled twice — otherwise a winning round would be
/// paid over and over.
#[tokio::test]
async fn the_same_game_cannot_be_settled_twice() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 1).await;

    g.warp(target + 1);
    g.set_slot_hashes(&[(target, [3u8; 32])]);
    g.send(&[g.resolve_ix(&player.pubkey())], &[]).await.unwrap();

    let err = g
        .send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::NoPendingPlay);
}

/// A game cannot be forfeited before the window closes — otherwise a player
/// could forfeit a round they saw themselves lose and play it again. (They would
/// not profit, since the spin is not refunded, but the rule still has to be
/// closed.)
#[tokio::test]
async fn cannot_forfeit_while_the_window_is_open() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 1).await;

    g.warp(target + 1);
    let err = g
        .send(&[g.forfeit_ix(&player.pubkey())], &[&player])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::ResolveWindowStillOpen);
}

/// Forfeit DOES NOT REFUND the spin. If it did, a player who worked out in
/// advance that they had lost could skip resolve, forfeit, and re-roll the dice
/// for free — the whole point of commit-reveal would escape through there.
#[tokio::test]
async fn forfeit_does_not_refund_the_spin() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    // A 5-spin package: 4 should be left after playing, and 4 after the forfeit too.
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 1).await;
    let before = g.player_state(&player.pubkey()).await.unwrap().spins_remaining;
    assert_eq!(before, 4);

    g.warp(target + 301);
    g.send(&[g.forfeit_ix(&player.pubkey())], &[&player])
        .await
        .unwrap();

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "still pending after the forfeit");
    assert_eq!(
        st.spins_remaining, before,
        "the forfeit refunded the spin — a free dice re-roll hole"
    );
}

/// The prize ALWAYS goes to the player, never to whoever calls resolve. That
/// matters because resolve is permissionless: otherwise a "keeper" would collect
/// other people's winnings into their own wallet.
#[tokio::test]
async fn the_prize_is_paid_to_the_player_not_the_caller() {
    // easy_win_bps = 10000: with this setup every round wins, so we can observe the
    // payout.
    let mut g = Game::start_with(50 * SOL, 10_000, 10_000, 0).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    // Because resolve() is permissionless it never appears in the signer list: the
    // party sending the transaction is the test payer, someone else entirely.
    let keeper = g.ctx.payer.pubkey();

    let target = play(&mut g, &player, &Keypair::new().pubkey(), 1).await;
    g.warp(target + 1);
    g.set_slot_hashes(&[(target, [42u8; 32])]);

    let player_before = g.lamports(&player.pubkey()).await;
    let keeper_before = g.lamports(&keeper).await;

    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .unwrap();

    let player_after = g.lamports(&player.pubkey()).await;
    let keeper_after = g.lamports(&keeper).await;

    assert!(
        player_after > player_before,
        "the player was not paid ({player_before} -> {player_after})"
    );
    assert!(
        keeper_after < keeper_before,
        "the party that called resolve made money ({keeper_before} -> {keeper_after}) \
         — they should only have paid the transaction fee"
    );
    let winnings = player_after - player_before;
    assert!(
        winnings == SMALL_PRIZE || winnings == BIG_PRIZE,
        "the amount paid is not one of the published prizes: {winnings}"
    );
}

/// If the vault cannot cover the largest possible PAYOUT (the jackpot plus the
/// operations fee), even a winning round is not paid — but the transaction is
/// NOT REVERTED, the player silently loses and can play again. Otherwise the
/// player would be stuck at `pending = true` until the window closed.
#[tokio::test]
async fn the_player_is_not_stuck_when_the_vault_cannot_pay() {
    // The vault is too empty to cover the jackpot plus its fee; the win rate is 100%.
    let mut g = Game::start_with(BIG_PRIZE / 2, 10_000, 10_000, 0).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;

    let target = play(&mut g, &player, &Keypair::new().pubkey(), 1).await;
    g.warp(target + 1);
    g.set_slot_hashes(&[(target, [5u8; 32])]);

    let before = g.lamports(&player.pubkey()).await;
    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .expect("resolve reverted the whole transaction with an empty vault — the player would be stuck");

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "the player was left in the pending state");
    assert_eq!(
        g.lamports(&player.pubkey()).await,
        before,
        "a payout happened even though the vault could not pay"
    );
}

// ---------------------------------------------------------------------------
// 4. Choosing the right slot in a full sysvar
// ---------------------------------------------------------------------------

/// SlotHashes really holds 512 records. Because the tests above set the sysvar up
/// with one or two records, they do not exercise the real conditions of the scan
/// logic: skipping the records that remain ABOVE our window (the newer ones),
/// stopping once it drops BELOW the target, and choosing the CLOSEST one to the
/// target when several candidates qualify.
///
/// Choosing the closest one is not an arbitrary preference: once that slot has
/// appeared it never changes again (slots added later are always larger). Had
/// "the newest qualifying slot" been chosen, the result would change depending on
/// WHEN resolve was called, and a player could keep rolling the dice by waiting
/// until they won.
#[tokio::test]
async fn the_slot_closest_to_the_target_is_chosen_in_a_full_sysvar() {
    // A 50% win threshold: that makes it easy to find a hash pair where one of the
    // two candidate slots wins and the other loses.
    let mut g = Game::start_with(50 * SOL, 5_000, 5_000, 0).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    // First we fast-forward: the slot number has to be that large before the sysvar
    // can be filled with 509 records BELOW the target.
    g.warp(1_000);
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 1).await;

    let st = g.player_state(&player.pubkey()).await.unwrap();
    let plays_count = st.plays_count;

    // Two candidates: the one CLOSE to the target and the NEWER one. We look for
    // hashes whose results are OPPOSED — only then does "which one was chosen" have
    // an observable answer. Otherwise both choices give the same result and the test
    // distinguishes nothing.
    let near_slot = target + 3;
    let new_slot = target + 40;
    let mut near_hash = [0u8; 32];
    let mut new_hash = [0u8; 32];
    let mut found = false;
    for i in 0..5_000u32 {
        let h1 = round_hash(i);
        let h2 = round_hash(i + 5_000);
        let wins = expected_dice(&h1, near_slot, &player.pubkey(), plays_count) < 5_000;
        let loses = expected_dice(&h2, new_slot, &player.pubkey(), plays_count) >= 5_000;
        if wins && loses {
            near_hash = h1;
            new_hash = h2;
            found = true;
            break;
        }
    }
    assert!(found, "no hash pair with opposing results was found");

    g.warp(target + 250);

    // A realistic sysvar of 512 records:
    //  - 509 records below the target (the region where the scan has to stop)
    //  - 2 candidates inside the window: near_slot and new_slot
    //  - 1 record above the window (the one that has to be skipped)
    let mut entries: Vec<(u64, [u8; 32])> = (1..=509u64)
        .map(|i| (target - i, [(i % 251) as u8; 32]))
        .collect();
    entries.push((near_slot, near_hash));
    entries.push((new_slot, new_hash));
    entries.push((target + MAX_RESOLVE_WINDOW_SLOTS_TEST + 1, [99u8; 32]));
    g.set_slot_hashes(&entries);

    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .expect("resolve failed on a full sysvar");

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "the game was not settled");
    assert_eq!(
        st.wins_count, 1,
        "the result was produced using a newer slot ({new_slot}) instead of the slot \
         closest to the target ({near_slot}) — that would mean WHEN resolve is \
         called can change the result, and a player could wait until they won"
    );
}

/// The length of the resolve window (it has to match MAX_RESOLVE_WINDOW_SLOTS in
/// lib.rs). The constant is not `pub` in the program, so a copy is kept in the
/// test, and the `resolve_fails_when_the_window_holds_no_slot` and
/// `forfeit_does_not_refund_the_spin` tests verify indirectly that the two
/// agree.
const MAX_RESOLVE_WINDOW_SLOTS_TEST: u64 = 300;

// ---------------------------------------------------------------------------
// 5. The ABI golden vector — the client and the program speaking the same bytes
// ---------------------------------------------------------------------------
// All five of the game's instructions are built by the SITE (TypeScript) and
// verified by the program (Rust). If a discriminator or an account order shifts,
// the transaction is rejected — and that means the game stops entirely.
//
// The discriminators come from sha256("global:<name>")[0..8], so they change
// silently if an instruction's NAME changes. The account order depends on the
// struct field order too; inserting a field in the middle is enough.
//
// The same vectors are reproduced in scripts/check-abi.mjs by calling the
// client's REAL builders.
#[test]
fn game_instruction_discriminators_match_the_golden_vector() {
    use anchor_lang::InstructionData;

    let hex = |d: Vec<u8>| d.iter().map(|b| format!("{b:02x}")).collect::<String>();

    // buy_spins(tier_index: u8)
    let buy = hex(luck_game::instruction::BuySpins { tier_index: 3 }.data());
    println!("buy_spins    : {buy}");
    assert_eq!(&buy[0..16], "1e71e289a75d2984", "the buy_spins discriminator changed");
    assert_eq!(buy, "1e71e289a75d298403", "the buy_spins data changed (u8 tier)");

    let registration = hex(luck_game::instruction::RegisterDelegate {}.data());
    println!("register     : {registration}");
    assert_eq!(registration, "da2d0c21c35959d0", "the register_delegate discriminator changed");

    let play = hex(luck_game::instruction::Play {}.data());
    println!("play         : {play}");
    assert_eq!(play, "d59dc18ee438f896", "the play discriminator changed");

    let decode = hex(luck_game::instruction::Resolve {}.data());
    println!("resolve      : {decode}");
    assert_eq!(decode, "f696ecce6c3f3a0a", "the resolve discriminator changed");

    let forfeit = hex(luck_game::instruction::ForfeitStuckPlay {}.data());
    println!("forfeit      : {forfeit}");
    assert_eq!(forfeit, "46f69baf8c6f6989", "the forfeit_stuck_play discriminator changed");
}

/// THE BYTE LAYOUT OF THE EVENTS is part of the ABI too — and the place where it
/// shifts most silently.
///
/// The site does NOT read the game's result from the chain; it parses the
/// `PlayResolved` event out of the transaction logs (parsePlayResolvedFromTx). If
/// the event's field ORDER changes — inserting one field is enough — the
/// TypeScript side keeps reading from the same offsets and, without raising any
/// error, shows the WRONG values: "you won" on a losing round, some other number
/// for a 0.5 SOL prize. Because the transaction is not rejected, no trace is
/// left, on the chain or in the logs.
///
/// That is why the exact bytes of all three events are pinned. The vectors were
/// not COPIED from the program's output; they were derived from Anchor's rules
/// independently:
///   discriminator = sha256("event:<Name>")[0..8]
///   body          = Borsh: fields in order, numbers little-endian, bool = 1 byte
///
/// The same vectors are fed to the SITE'S REAL parsers in scripts/check-abi.mjs
/// and read back — so both sides are pinned to the same independent truth.
#[test]
fn event_bytes_match_the_golden_vector() {
    use anchor_lang::Event;

    let hex = |d: Vec<u8>| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let player = anchor_lang::prelude::Pubkey::new_from_array([7u8; 32]);

    let resolved = hex(
        luck_game::PlayResolved {
            player: player,
            won: true,
            prize_paid: 1_234_567_890,
            is_big_win: false,
            easy_mode: true,
            ops_fee_paid: 246_913_578,
        }
        .data(),
    );
    println!("PlayResolved   : {resolved}");
    assert_eq!(
        resolved,
        "8cb617b4df501e9d\
         0707070707070707070707070707070707070707070707070707070707070707\
         01\
         d202964900000000\
         00\
         01\
         2a9ab70e00000000",
        "the byte layout of the PlayResolved event changed — the site would read the result WRONG"
    );

    let committed = hex(
        luck_game::PlayCommitted {
            player: player,
            plays_count: 11,
            spins_remaining: 22,
            bonus_granted: true,
            commit_slot: 488_693_710,
        }
        .data(),
    );
    println!("PlayCommitted  : {committed}");
    assert_eq!(
        committed,
        "0f6a7973baf30b2c\
         0707070707070707070707070707070707070707070707070707070707070707\
         0b000000\
         16000000\
         01\
         cedf201d00000000",
        "the byte layout of the PlayCommitted event changed"
    );

    let purchase = hex(
        luck_game::SpinsPurchased {
            player: player,
            tier_index: 3,
            spin_count: 20,
            price_lamports: 800_000_000,
            spins_remaining: 23,
        }
        .data(),
    );
    println!("SpinsPurchased : {purchase}");
    assert_eq!(
        purchase,
        "c39218f3ce200ed2\
         0707070707070707070707070707070707070707070707070707070707070707\
         03\
         14000000\
         0008af2f00000000\
         17000000",
        "the byte layout of the SpinsPurchased event changed"
    );
}

/// The account discriminators are pinned too: the client uses these 8 bytes to
/// verify that an account it read from the chain really is the type it expects.
/// If they shift, the client says "not configured" and the game never opens.
#[test]
fn account_discriminators_match_the_golden_vector() {
    use anchor_lang::Discriminator;

    let hex = |d: &[u8]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(
        hex(&luck_game::GameConfig::discriminator()),
        "2d929221aa456085",
        "the GameConfig account discriminator changed"
    );
    assert_eq!(
        hex(&luck_game::PlayerState::discriminator()),
        "38033c56ae10f4c3",
        "the PlayerState account discriminator changed"
    );
}

/// THE GOLDEN VECTOR OF THE DICE — do the document and the code say the same thing.
///
/// SECURITY.md explains how the dice is produced so that players can verify the
/// result for themselves. If that description is wrong, the document is worse
/// than useless — it is HARMFUL: somebody trying to verify gets a different
/// number and concludes "the game is rigged".
///
/// And the description WAS wrong — the document said keccak, while the program
/// uses `solana_program::hash::hash`, that is SHA-256. (The distributor's merkle
/// tree really does use keccak; the two had been mixed up.) An outside reader
/// spotted the difference.
///
/// This test pins that description to the code. The same vector is produced on
/// the JS side too, in scripts/check-abi.mjs.
#[test]
fn golden_dice_vector() {
    let mut preimage = Vec::with_capacity(76);
    preimage.extend_from_slice(&(0u8..32).collect::<Vec<u8>>()); // slot_hash
    preimage.extend_from_slice(&488_699_073u64.to_le_bytes()); // entropy_slot
    preimage.extend_from_slice(&[7u8; 32]); // player
    preimage.extend_from_slice(&5u32.to_le_bytes()); // plays_count
    assert_eq!(preimage.len(), 76, "the preimage layout changed");

    // EXACTLY the hash function the program uses in resolve().
    let digest = anchor_lang::solana_program::hash::hash(&preimage).to_bytes();
    let hex = digest.iter().map(|b| format!("{b:02x}")).collect::<String>();
    println!("digest: {hex}");
    assert_eq!(
        hex, "3d54d1715c5d05dcfc12bb5dd95b197b078f3135b04aab6ead91103c1233cc6d",
        "the dice hash changed — the description in SECURITY.md is now wrong"
    );

    let dice = u64::from_le_bytes(digest[0..8].try_into().unwrap()) % 10_000;
    let tier = u64::from_le_bytes(digest[8..16].try_into().unwrap()) % 10_000;
    assert_eq!(dice, 7_597, "the dice derivation changed");
    assert_eq!(tier, 4_556, "the tier dice derivation changed");
}

/// A player who bought a package BEFORE using up their free spins also gets the
/// bonus spin.
///
/// They used not to, and it was an equality bug: the condition was
/// `plays_count == free_plays`, but because purchased spins land in the same
/// balance, the balance hits zero at 4 rather than at 3 and the equality never
/// held. So "buy a package first" silently burnt the bonus.
#[tokio::test]
async fn the_bonus_is_granted_even_if_a_package_was_bought_first() {
    let mut g = Game::start_with(50 * SOL, NORMAL_WIN_BPS, EASY_WIN_BPS, 3).await;
    let o = Keypair::new();
    let d = Keypair::new();
    fund(&mut g.ctx, &o.pubkey(), 20 * SOL).await;
    let k = o.pubkey();

    // Buy the 1-spin package FIRST, THEN play: 1 + 3 = 4 spins in total.
    let ix = g.buy_spins_ix(&k, &d.pubkey(), 0);
    g.send(&[ix], &[&o]).await.unwrap();

    let mut slot = g.slot().await.max(1_000) + 100;
    for _ in 0..4 {
        g.warp(slot);
        slot += 20;
        let ix = g.play_ix(&k, &k);
        g.send(&[ix], &[&o]).await.unwrap();
        // It cannot be played again without settling; we pass the window and forfeit.
        slot += MAX_RESOLVE_WINDOW_SLOTS_TEST + REVEAL_DELAY + 10;
        g.warp(slot);
        slot += 20;
        let ix = g.forfeit_ix(&k);
        g.send(&[ix], &[&o]).await.unwrap();
    }

    let s = g.player_state(&k).await.unwrap();
    assert_eq!(s.plays_count, 4, "4 spins should have been played");
    assert!(
        s.bonus_granted,
        "a player who bought a package first did not get the bonus spin — the equality bug is back"
    );
    assert_eq!(s.spins_remaining, 1, "bonus spin bakiyeye eklenmedi");
}

/// Nobody should get a bonus when there are NO free spins.
///
/// The bonus condition was changed from equality to ">="; without the
/// `free_plays > 0` condition that change would give EVERYONE a free spin after
/// their first game.
#[tokio::test]
async fn no_bonus_is_granted_when_there_are_no_free_spins() {
    let mut g = Game::start_with(50 * SOL, NORMAL_WIN_BPS, EASY_WIN_BPS, 0).await;
    let o = Keypair::new();
    let d = Keypair::new();
    fund(&mut g.ctx, &o.pubkey(), 20 * SOL).await;
    let k = o.pubkey();

    let ix = g.buy_spins_ix(&k, &d.pubkey(), 0); // 1 spin
    g.send(&[ix], &[&o]).await.unwrap();

    let slot = g.slot().await.max(1_000) + 100;
    g.warp(slot);
    let ix = g.play_ix(&k, &k);
    g.send(&[ix], &[&o]).await.unwrap();

    let s = g.player_state(&k).await.unwrap();
    assert!(!s.bonus_granted, "a bonus was granted even though there are no free spins");
    assert_eq!(s.spins_remaining, 0, "a free spin was added");
}

/// THE AUTHORITY CANNOT CHANGE THE RULES OF A PENDING BET.
///
/// This is the cornerstone of the verifiable-fairness claim. The odds freeze
/// when the player places their bet; whatever `update_config` does afterwards,
/// that bet settles under the original rules.
///
/// That was NOT the case before: `resolve()` read the live config, so the
/// authority could see a pending bet and then pull the win rate down to zero. An
/// outside reviewer of the code pointed out this design risk; it was closed
/// before launch.
///
/// The test sets it up like this: the player plays while the odds are 100% (every
/// round wins), and THEN the authority pulls the rate to 0%. The bet has to WIN
/// anyway.
#[tokio::test]
async fn the_authority_cannot_change_the_odds_of_a_pending_bet() {
    // Make every round a win: 100% in both normal and easy mode.
    let mut g = Game::start_with(50 * SOL, 10_000, 10_000, 0).await;
    let o = Keypair::new();
    let d = Keypair::new();
    fund(&mut g.ctx, &o.pubkey(), 20 * SOL).await;
    let k = o.pubkey();

    let ix = g.buy_spins_ix(&k, &d.pubkey(), 0);
    g.send(&[ix], &[&o]).await.unwrap();

    let mut slot = g.slot().await.max(1_000) + 100;
    g.warp(slot);
    let ix = g.play_ix(&k, &k);
    g.send(&[ix], &[&o]).await.unwrap();

    // --- THE BET IS PLACED. Now the authority pulls the rate to ZERO. ---
    let ix = solana_sdk::instruction::Instruction {
        program_id: luck_game::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &luck_game::accounts::UpdateConfig {
                authority: g.authority.pubkey(),
                config: g.config,
            },
            None,
        ),
        data: anchor_lang::InstructionData::data(&luck_game::instruction::UpdateConfig {
            new_treasury: g.treasury,
            free_plays: 0,
            small_prize_lamports: SMALL_PRIZE,
            big_prize_lamports: BIG_PRIZE,
            big_prize_bps: BIG_PRIZE_BPS,
            vault_easy_threshold_lamports: EASY_THRESHOLD,
            normal_win_bps: 0, // <-- so that nobody can win
            easy_win_bps: 0,   // <--
            treasury_fee_bps: TREASURY_FEE_BPS,
            spin_tier_counts: TIER_COUNTS,
            spin_tier_prices: TIER_PRICES,
        }),
    };
    let auth = g.authority.insecure_clone();
    g.send(&[ix], &[&auth]).await.unwrap();

    // --- Let the pending bet settle. ---
    let commit = g.player_state(&k).await.unwrap().commit_slot;
    let target = commit + REVEAL_DELAY;
    slot = target + 3;
    g.warp(slot);
    let mut h = [0u8; 32];
    h[0] = 42;
    g.set_slot_hashes(&[(target, h)]);

    let ix = g.resolve_ix(&k);
    g.send(&[ix], &[]).await.unwrap();

    let s = g.player_state(&k).await.unwrap();
    assert_eq!(
        s.wins_count, 1,
        "the odds were 100% when the bet was placed, but the round was lost after \
         the authority set them to 0% — a pending bet is not protected"
    );
    assert!(s.total_won_lamports > 0, "the winnings were not paid");
    assert!(!s.pending, "still pending after resolve");
}

/// The EXACT BYTE LAYOUT of PlayerState.
///
/// The site reads this account at fixed offsets (decodePlayerState). Inserting a
/// single field is enough: TypeScript keeps reading from the same offsets and,
/// without raising any error, shows the wrong spin count and the wrong winnings.
///
/// The layout has just been extended (the rules at bet time were added). The new
/// fields were deliberately appended at the END so the existing offsets do not
/// shift, and this vector proves that too. The same bytes are fed to the SITE'S
/// REAL reader in scripts/check-abi.mjs and read back.
#[test]
fn player_state_byte_layout_matches_the_golden_vector() {
    use anchor_lang::{AnchorSerialize, Discriminator};

    let state = luck_game::PlayerState {
        player: anchor_lang::prelude::Pubkey::new_from_array([9u8; 32]),
        plays_count: 11,
        wins_count: 3,
        pending: true,
        commit_slot: 488_699_073,
        bump: 254,
        initialized: true,
        spins_seeded: true,
        spins_remaining: 17,
        delegate: anchor_lang::prelude::Pubkey::new_from_array([4u8; 32]),
        total_won_lamports: 1_500_000_000,
        bonus_granted: true,
        bet_small_prize_lamports: 500_000_000,
        bet_big_prize_lamports: 1_000_000_000,
        bet_vault_easy_threshold_lamports: 1_200_000_000,
        bet_big_prize_bps: 3_000,
        bet_normal_win_bps: 50,
        bet_easy_win_bps: 1_000,
        bet_treasury_fee_bps: 2_000,
    };
    let mut bytes = luck_game::PlayerState::DISCRIMINATOR.to_vec();
    state.serialize(&mut bytes).unwrap();

    let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    println!("PlayerState: {hex}");
    assert_eq!(
        bytes.len(),
        luck_game::PlayerState::LEN,
        "PlayerState::LEN does not match the real size — the account will either overflow or waste space"
    );
    assert_eq!(
        hex,
        "38033c56ae10f4c3\
         0909090909090909090909090909090909090909090909090909090909090909\
         0b000000\
         03000000\
         01\
         c1f4201d00000000\
         fe\
         01\
         01\
         11000000\
         0404040404040404040404040404040404040404040404040404040404040404\
         002f685900000000\
         01\
         0065cd1d00000000\
         00ca9a3b00000000\
         008c864700000000\
         b80b\
         3200\
         e803\
         d007",
        "the PlayerState byte layout changed — the site would read it WRONG"
    );
}
