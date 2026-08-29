// ---------------------------------------------------------------------------
// Is the dice produced correctly — is the published rate the real one
// ---------------------------------------------------------------------------
// We test this two different ways, because neither one is enough on its own.
//
// 1) INDEPENDENT DERIVATION (the real proof). The test recomputes the dice from
//    the specification WITHOUT ever looking at the program's source, and checks
//    on every round whether the chain arrives at the same result. Because the
//    old, buggy implementation (deriving the dice from a 2-byte number) and the
//    correct one give different results, this catches the bug within the first
//    few rounds.
//
//    We also do the modulo deliberately ANOTHER way (walking `remaining` byte
//    by byte). Had we copied the program's `u64::from_le_bytes(..) % 10000`
//    verbatim, the test would have taken the implementation to be correct and
//    merely repeated it.
//
// 2) STATISTICS (the second line of defence). An independent derivation cannot
//    catch a wrong specification — both of us could be wrong in the same way.
//    Counting the win rate and seeing that it matches the published one closes
//    that gap.
//
// NO FLAKINESS: SlotHashes, the source of the randomness, is set up by the test
// itself, and the hashes are derived from the round number, so the result is
// byte-identical on every run.
mod common;

use common::*;
use solana_sdk::{pubkey::Pubkey, signature::Signer, signer::keypair::Keypair};

/// This threshold is the point where the old bug inflated the deviation MOST.
/// 65536 is not an exact multiple of 10000 (65536 = 6 x 10000 + 5536), so with
/// a 2-byte dice the range 0..5535 was represented 7 times and the rest 6
/// times. At win_bps = 5536:
///   published : 55.36%
///   actual    : 5536 x 7 / 65536 = 59.13%   (+3.77 points)
const WIN_BPS: u16 = 5_536;

const ROUNDS: u32 = 200;

#[tokio::test]
async fn the_dice_matches_the_spec_and_the_rate_matches_what_is_published() {
    // The vault has to be full enough to pay on every round; otherwise the
    // "the vault cannot pay" branch kicks in and turns wins into losses, and
    // what we would be measuring is the vault balance, not the dice.
    let mut g = Game::start_with(500_000 * SOL, WIN_BPS, WIN_BPS, 0).await;
    let player = new_player(&mut g.ctx, 10_000 * SOL).await;
    let delegate = Keypair::new();

    let mut winnings = 0u32;
    let mut spins_left = 0u32;

    for round in 0..ROUNDS {
        if spins_left == 0 {
            g.send(
                &[g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 5)],
                &[&player],
            )
            .await
            .unwrap();
            spins_left = TIER_COUNTS[5] as u32;
        }

        g.send(&[g.play_ix(&player.pubkey(), &player.pubkey())], &[&player])
            .await
            .unwrap();
        spins_left -= 1;

        let st = g.player_state(&player.pubkey()).await.unwrap();
        let target = st.commit_slot + REVEAL_DELAY;
        let plays_count = st.plays_count;
        let previous_winnings = st.wins_count;

        g.warp(target + 1);
        let hash = round_hash(round);
        g.set_slot_hashes(&[(target, hash)]);

        g.send(&[g.resolve_ix(&player.pubkey())], &[]).await.unwrap();

        let st = g.player_state(&player.pubkey()).await.unwrap();
        let chain_won = st.wins_count > previous_winnings;

        // 1) The independent derivation.
        let dice = expected_dice(&hash, target, &player.pubkey(), plays_count);
        let expected_won = dice < WIN_BPS as u32;
        assert_eq!(
            chain_won, expected_won,
            "round {round}: dice {dice} (threshold {WIN_BPS}) -> expected won={expected_won}, \
             chain won={chain_won}"
        );

        if chain_won {
            winnings += 1;
        }
    }

    // Agreement with the chain is proven; how often it won is printed here for
    // information only. Whether the rate is REALLY unbiased is tested in the
    // separate test below, with far more samples.
    println!(
        "chain agreement: {ROUNDS}/{ROUNDS} rounds · wins {winnings}/{ROUNDS}"
    );
}

/// Tests that the dice is UNBIASED, with a large number of samples.
///
/// Why offline: the test above already proved that the chain follows the
/// specification to the letter. So we can test the specification itself here
/// with hundreds of thousands of samples without touching the chain at all —
/// running that many rounds on chain would take minutes, and a sample of 400
/// rounds could not reliably tell the old bug apart (the observed deviation
/// stayed inside the noise).
///
/// The test also proves its own power: the same measurement MUST catch the
/// deviation when applied to the OLD (2-byte) derivation. If it does not, the
/// measurement is worthless, and then this test fails too.
#[test]
fn the_dice_is_unbiased_and_the_measurement_catches_the_old_bug() {
    const SAMPLES: u32 = 200_000;
    const THRESHOLD: u32 = WIN_BPS as u32;

    let mut correct_winnings = 0u32;
    let mut old_winnings = 0u32;
    let player = Pubkey::new_from_array([9u8; 32]);

    for i in 0..SAMPLES {
        let mut preimage = Vec::new();
        preimage.extend_from_slice(&round_hash(i));
        preimage.extend_from_slice(&(i as u64).to_le_bytes());
        preimage.extend_from_slice(player.as_ref());
        preimage.extend_from_slice(&i.to_le_bytes());
        let digest = solana_sdk::hash::hash(&preimage).to_bytes();

        // The current (correct) derivation: 8 bytes.
        if remainder_10000(&digest[0..8]) < THRESHOLD {
            correct_winnings += 1;
        }
        // The old (buggy) derivation: 2 bytes.
        if (u16::from_le_bytes([digest[0], digest[1]]) as u32) % 10_000 < THRESHOLD {
            old_winnings += 1;
        }
    }

    let published = THRESHOLD as f64 / 10_000.0;
    let correct = correct_winnings as f64 / SAMPLES as f64;
    let old = old_winnings as f64 / SAMPLES as f64;
    println!(
        "published {:.2}% · 8-byte dice {:.2}% (deviation {:.3} points) · 2-byte dice {:.2}% (deviation {:.3} points)",
        published * 100.0,
        correct * 100.0,
        (correct - published).abs() * 100.0,
        old * 100.0,
        (old - published).abs() * 100.0
    );

    // For n = 200,000 and p ~ 0.55 the standard deviation is ~0.111%; 4 sigma
    // is ~0.45%.
    assert!(
        (correct - published).abs() < 0.0045,
        "the 8-byte dice deviates {:.3} points from the published rate",
        (correct - published).abs() * 100.0
    );

    // The power of the measurement: the old derivation should have deviated by
    // +3.77 points. If this check fails, then the check above passing proves
    // nothing.
    assert!(
        (old - published) > 0.03,
        "the measurement failed to catch the old bug (the old deviation is only {:.3} points) — \
         this test passing proves nothing",
        (old - published) * 100.0
    );
}
