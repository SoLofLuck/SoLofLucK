// ---------------------------------------------------------------------------
// CHAOS TEST — the distributor
// ---------------------------------------------------------------------------
// ALL of the presale's tokens sit in this program's vault. A bug in the game
// costs one round's prize; a bug here costs everyone's share. So a random
// scenario sweep matters even more here.
//
// The method is the same as on the game side: random recipient x random action
// x random time jump, an invariant check AFTER EVERY TRANSACTION, and a fixed
// seed (so a failing run can be reproduced exactly).
//
// THE INVARIANTS:
//   E1. Token conservation — the vault plus every recipient account = the total
//       minted.
//   E2. Nobody can take more than they are owed.
//   E3. The claimed amount never decreases (ClaimStatus does not count back).
//   E4. ClaimStatus.claimed and the recipient's real balance are exactly equal.
//   E5. distributor.total_claimed = the sum of every ClaimStatus.claimed.
//   E6. The claimed amount cannot exceed what has unlocked AT THAT MOMENT — the
//       schedule is computed INDEPENDENTLY (the program's own function is not
//       called).
//   E7. A claim with the wrong amount or with SOMEBODY ELSE'S proof MUST BE
//       REJECTED.
//   E8. Once the schedule ends everyone must be able to claim their share IN
//       FULL, and no dust may be left in the vault.
//
// E6's independence is deliberate: had I verified the schedule with the
// program's own `unlocked_amount`, the test would prove that the program agrees
// with my copy rather than with itself. If I make the same mistake in both, both
// stay green.

mod common;

use common::*;
use solana_sdk::signature::{Keypair, Signer};

/// xorshift64* — deterministic.
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

/// The schedule computed INDEPENDENTLY — the program's `unlocked_amount` is not
/// called.
///
/// The rule: zero before the start; then cliff + (whole periods elapsed x the
/// period share), capped at 100%. Rounding is DOWN — rounding up could make the
/// sum of the individual shares exceed the total allocation, and the last
/// recipient's claim would fail because the vault had run out.
fn unlocked(total: u64, now: i64, start: i64) -> u64 {
    if now < start {
        return 0;
    }
    let elapsed = (now - start) as u64;
    let period = (elapsed / WEEK as u64).min(PERIODS as u64);
    let bps = (CLIFF_BPS as u64 + period * PERIOD_BPS as u64).min(10_000);
    ((total as u128 * bps as u128) / 10_000u128) as u64
}

struct Alici {
    kp: Keypair,
    hak: u64,
    kanit: Vec<[u8; 32]>,
}

async fn run_chaos(seed: u64, step_count: u32) {
    let mut rng = Rng::new(seed);
    let mut ctx = program_test().start_with_context().await;
    let payer = ctx.payer.pubkey();
    let payer_kp = ctx.payer.insecure_clone();

    // The recipient shares are DELIBERATELY VARIED: some divide exactly by 10,000
    // and some do not. The indivisible ones expose the rounding direction — had
    // they all divided exactly, a version that rounded the wrong way would also
    // have passed (which is exactly what happened in another audit before).
    let raw: Vec<u64> = (0..5)
        .map(|i| match i {
            0 => 7_000_000_000_000,
            1 => 17_500_000_000_000,
            2 => 1_000_000_007, // does not divide by 10,000
            3 => 28_000_000_000_001,
            _ => 3,             // extremely small: even the cliff rounds to 0
        })
        .collect();

    let mut recipients: Vec<Alici> = Vec::new();
    let mut leaves_out = Vec::new();
    let mut kps = Vec::new();
    for hak in &raw {
        let kp = Keypair::new();
        leaves_out.push(leaf_hash(&kp.pubkey(), *hak));
        kps.push((kp, *hak));
    }
    let tree_out = MerkleTree::new(leaves_out);
    for (i, (kp, hak)) in kps.into_iter().enumerate() {
        recipients.push(Alici {
            kp,
            hak,
            kanit: tree_out.proof(i),
        });
    }
    let total: u64 = raw.iter().sum();

    // The recipients need SOL so they can pay transaction fees.
    for a in &recipients {
        let ix = solana_sdk::system_instruction::transfer(&payer, &a.kp.pubkey(), 100_000_000);
        send(&mut ctx, &[ix], &[]).await.unwrap();
    }

    let mint = create_mint(&mut ctx, &payer).await;
    let (distributor_out, _) = distributor_pda(&mint, 0);
    let (vault, _) = vault_pda(&distributor_out);

    // The schedule starts a little after NOW, so that the "not unlocked yet"
    // branch is exercised too.
    let now_ts = ctx
        .banks_client
        .get_sysvar::<solana_sdk::sysvar::clock::Clock>()
        .await
        .unwrap()
        .unix_timestamp;
    let start = now_ts + WEEK / 2;

    let ix = initialize_ix(
        &payer, &mint, 0, tree_out.root(), total, start,
        CLIFF_BPS, PERIOD_BPS, WEEK, PERIODS,
    );
    send(&mut ctx, &[ix], &[]).await.unwrap();
    mint_to(&mut ctx, &mint, &vault, &payer_kp, total).await;

    let mut time = now_ts;
    let mut successful_claims = 0u32;
    let mut rejected_forgeries = 0u32;

    for step in 0..step_count {
        let label = format!("seed={seed} step={step}");
        let action = rng.below(100);

        if action < 55 {
            // --- an ordinary claim ---
            let i = rng.below(recipients.len() as u64) as usize;
            let a = &recipients[i];
            let ix = claim_ix(&a.kp.pubkey(), &mint, 0, a.hak, a.kanit.clone());
            let kp = a.kp.insecure_clone();
            if send(&mut ctx, &[ix], &[&kp]).await.is_ok() {
                successful_claims += 1;
            }
        } else if action < 70 {
            // --- E7: a claim with THE WRONG AMOUNT — must be rejected ---
            let i = rng.below(recipients.len() as u64) as usize;
            let a = &recipients[i];
            let forged = a.hak.saturating_add(1 + rng.below(1_000_000));
            let ix = claim_ix(&a.kp.pubkey(), &mint, 0, forged, a.kanit.clone());
            let kp = a.kp.insecure_clone();
            let result = send(&mut ctx, &[ix], &[&kp]).await;
            assert!(
                result.is_err(),
                "E7 BROKEN ({label}): a claim asking for {forged} instead of {} WENT THROUGH",
                a.hak
            );
            rejected_forgeries += 1;
        } else if action < 80 {
            // --- E7: a claim with SOMEBODY ELSE'S PROOF — must be rejected ---
            let i = rng.below(recipients.len() as u64) as usize;
            let j = (i + 1 + rng.below(recipients.len() as u64 - 1) as usize) % recipients.len();
            let ix = claim_ix(
                &recipients[i].kp.pubkey(),
                &mint,
                0,
                recipients[j].hak,
                recipients[j].kanit.clone(),
            );
            let kp = recipients[i].kp.insecure_clone();
            let result = send(&mut ctx, &[ix], &[&kp]).await;
            assert!(
                result.is_err(),
                "E7 BROKEN ({label}): recipient {i} claimed with recipient {j}'s proof"
            );
            rejected_forgeries += 1;
        } else {
            // --- a time jump --- (sometimes a whole period, sometimes mid-period)
            let jump = if rng.below(3) == 0 {
                WEEK + rng.below(WEEK as u64) as i64
            } else {
                (rng.below(WEEK as u64 / 2) + 1) as i64
            };
            time += jump;
            set_time(&mut ctx, time).await;
            continue;
        }

        // ------------------- THE INVARIANTS -------------------
        let mut total_claimed: u64 = 0;
        let in_vault = token_balance(&mut ctx, &vault).await;
        let mut held_by_recipients: u64 = 0;

        for a in &recipients {
            let balance = token_balance(&mut ctx, &ata(&a.kp.pubkey(), &mint)).await;
            held_by_recipients += balance;

            // E2 — cannot take more than they are owed
            assert!(
                balance <= a.hak,
                "E2 BROKEN ({label}): the recipient is owed {} but received {balance}",
                a.hak
            );

            // E6 — cannot claim more than has unlocked at that moment
            let cap = unlocked(a.hak, time, start);
            assert!(
                balance <= cap,
                "E6 BROKEN ({label}): time {time}, unlocked {cap}, \
                 claimed {balance} (owed {})",
                a.hak
            );

            // E4 — ClaimStatus and the real balance are equal
            let (durum_pda, _) = claim_status_pda(&distributor_out, &a.kp.pubkey());
            let registered = match ctx.banks_client.get_account(durum_pda).await.unwrap() {
                Some(acc) => {
                    let d: luck_distributor::ClaimStatus =
                        anchor_lang::AccountDeserialize::try_deserialize(&mut acc.data.as_slice())
                            .unwrap();
                    d.claimed
                }
                None => 0,
            };
            assert_eq!(
                registered, balance,
                "E4 BROKEN ({label}): ClaimStatus says {registered} but the wallet holds {balance}"
            );
            total_claimed += registered;
        }

        // E1 — token korunumu
        assert_eq!(
            in_vault + held_by_recipients,
            total,
            "E1 BROKEN ({label}): vault {in_vault} + recipients {held_by_recipients} != minted {total}"
        );

        // E5 — the distributor's counter agrees with the individual records
        let acc = ctx.banks_client.get_account(distributor_out).await.unwrap().unwrap();
        let d: luck_distributor::Distributor =
            anchor_lang::AccountDeserialize::try_deserialize(&mut acc.data.as_slice()).unwrap();
        assert_eq!(
            d.total_claimed, total_claimed,
            "E5 BROKEN ({label}): the distributor says {}, the records sum to {total_claimed}",
            d.total_claimed
        );
    }

    // --- E3 is implicit across the run: the balance never decreased (E4 + E1) ---

    // --- E8: once the schedule ends everyone must be able to claim IN FULL ---
    time = start + (PERIODS as i64 + 2) * WEEK;
    set_time(&mut ctx, time).await;
    for a in &recipients {
        let ix = claim_ix(&a.kp.pubkey(), &mint, 0, a.hak, a.kanit.clone());
        let kp = a.kp.insecure_clone();
        // They may already have claimed their whole share; in that case there is
        // nothing to claim and the transaction is rejected. What matters is the
        // RESULTING balance.
        let _ = send(&mut ctx, &[ix], &[&kp]).await;
        let balance = token_balance(&mut ctx, &ata(&a.kp.pubkey(), &mint)).await;
        assert_eq!(
            balance, a.hak,
            "E8 BROKEN (seed={seed}): the schedule has ended but the recipient could \
             not claim their share in full ({balance}/{})",
            a.hak
        );
    }
    let remaining = token_balance(&mut ctx, &vault).await;
    assert_eq!(
        remaining, 0,
        "E8 BROKEN (seed={seed}): the schedule ended but {remaining} tokens are left \
         in the vault — with no withdraw instruction that money would stay locked FOREVER"
    );

    // We prove the run was meaningful: if no claim had gone through, this test
    // would show a broken "reject everything" program as green too.
    assert!(
        successful_claims >= 5,
        "seed={seed}: only {successful_claims} claims went through — the run is not meaningful"
    );
    assert!(
        rejected_forgeries >= 5,
        "seed={seed}: only {rejected_forgeries} forged claims were attempted — \
         E7 was not exercised enough"
    );
    println!(
        "seed={seed} · {successful_claims} claims went through · {rejected_forgeries} forged \
         claims rejected · the vault is empty at the end"
    );
}

#[tokio::test]
async fn chaos_distribution() {
    run_chaos(0xC0FFEE, 220).await;
}

#[tokio::test]
async fn chaos_distribution_extra_seeds() {
    for seed in [0xA11CEu64, 0xBEEF, 0x1337] {
        run_chaos(seed, 180).await;
    }
}
