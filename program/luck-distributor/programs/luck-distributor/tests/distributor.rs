// ---------------------------------------------------------------------------
// luck-distributor scenarios
// ---------------------------------------------------------------------------
// On TGE day 271 million tokens will be locked into this program and there will
// be no chance to correct it. So the tests here do not target the "happy path"
// but mainly the situations WHERE MONEY COULD BE LOST or OVER-DISTRIBUTED: a
// schedule that never reaches 100%, a double claim, claiming somebody else's
// share, a forged proof, dust left over from rounding.
mod common;

use common::*;
use solana_sdk::{
    signature::{Keypair, Signer},
    signer::signers::Signers,
};

const TGE: i64 = 1_800_000_000; // a fixed, realistic future timestamp

/// Sets up the presale round, funds the vault and returns the (recipient, amount) list.
async fn setup_presale(
    ctx: &mut solana_program_test::ProgramTestContext,
    allocations: &[(Keypair, u64)],
    cliff_bps: u16,
    period_bps: u16,
    periods: u16,
) -> (solana_sdk::pubkey::Pubkey, Keypair, MerkleTree, u64) {
    let mint_authority = Keypair::new();
    let mint = create_mint(ctx, &mint_authority.pubkey()).await;

    let leaves: Vec<[u8; 32]> = allocations
        .iter()
        .map(|(kp, amt)| leaf_hash(&kp.pubkey(), *amt))
        .collect();
    let tree = MerkleTree::new(leaves);
    let total: u64 = allocations.iter().map(|(_, a)| *a).sum();

    send(
        ctx,
        &[initialize_ix(
            &ctx.payer.pubkey(),
            &mint,
            0,
            tree.root(),
            total,
            TGE,
            cliff_bps,
            period_bps,
            WEEK,
            periods,
        )],
        &[],
    )
    .await
    .unwrap();

    let (distributor, _) = distributor_pda(&mint, 0);
    let (vault, _) = vault_pda(&distributor);
    mint_to(ctx, &mint, &vault, &mint_authority, total).await;

    (mint, mint_authority, tree, total)
}

/// Gives the recipient a little SOL for transaction fees — a claim has to pay
/// rent, because it opens their own ATA and the claim_status account.
async fn fund(ctx: &mut solana_program_test::ProgramTestContext, who: &Keypair) {
    let ix = solana_sdk::system_instruction::transfer(
        &ctx.payer.pubkey(),
        &who.pubkey(),
        50_000_000,
    );
    send(ctx, &[ix], &[]).await.unwrap();
}

async fn claim(
    ctx: &mut solana_program_test::ProgramTestContext,
    who: &Keypair,
    mint: &solana_sdk::pubkey::Pubkey,
    amount: u64,
    proof: Vec<[u8; 32]>,
) -> Result<(), solana_sdk::transport::TransportError> {
    let ix = claim_ix(&who.pubkey(), mint, 0, amount, proof);
    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = solana_sdk::transaction::Transaction::new_signed_with_payer(
        &[ix],
        Some(&who.pubkey()),
        &[who] as &dyn Signers,
        blockhash,
    );
    ctx.banks_client.process_transaction(tx).await.map_err(Into::into)
}

// -- 1 ----------------------------------------------------------------------
/// When the schedule ends completely, can the recipient claim the LAST UNIT of
/// their share? If rounding left a few units in the vault, those tokens would be
/// locked there forever.
#[tokio::test]
async fn full_schedule_pays_exactly_total() {
    let mut ctx = program_test().start_with_context().await;
    let alice = Keypair::new();
    // A number that does not divide by 7, to force the rounding.
    let amount = 271_950_137u64;
    let allocs = vec![(alice.insecure_clone(), amount)];
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx, &alice).await;

    set_time(&mut ctx, TGE + WEEK * (PERIODS as i64)).await;
    claim(&mut ctx, &alice, &mint, amount, tree.proof(0)).await.unwrap();

    assert_eq!(token_balance(&mut ctx, &ata(&alice.pubkey(), &mint)).await, amount);
    let (distributor, _) = distributor_pda(&mint, 0);
    let (vault, _) = vault_pda(&distributor);
    assert_eq!(token_balance(&mut ctx, &vault).await, 0, "no dust may be left in the vault");
}

// -- 2 ----------------------------------------------------------------------
/// Nothing can be claimed before TGE.
#[tokio::test]
async fn nothing_before_tge() {
    let mut ctx = program_test().start_with_context().await;
    let alice = Keypair::new();
    let allocs = vec![(alice.insecure_clone(), 1_000_000u64)];
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx, &alice).await;

    set_time(&mut ctx, TGE - 1).await;
    assert!(claim(&mut ctx, &alice, &mint, 1_000_000, tree.proof(0)).await.is_err());
}

// -- 3 ----------------------------------------------------------------------
/// Does exactly 9% unlock at the moment of TGE?
#[tokio::test]
async fn tge_unlocks_nine_percent() {
    let mut ctx = program_test().start_with_context().await;
    let alice = Keypair::new();
    let amount = 1_000_000u64;
    let allocs = vec![(alice.insecure_clone(), amount)];
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx, &alice).await;

    set_time(&mut ctx, TGE).await;
    claim(&mut ctx, &alice, &mint, amount, tree.proof(0)).await.unwrap();
    assert_eq!(token_balance(&mut ctx, &ata(&alice.pubkey(), &mint)).await, 90_000);
}

// -- 4 ----------------------------------------------------------------------
/// Claiming every week separately must give THE SAME total as claiming once at
/// the end. Otherwise there would be a sneaky "claiming early loses you money"
/// bug.
#[tokio::test]
async fn weekly_claims_equal_single_final_claim() {
    let amount = 271_950_137u64;

    // (a) claiming every week
    let mut ctx = program_test().start_with_context().await;
    let alice = Keypair::new();
    let allocs = vec![(alice.insecure_clone(), amount)];
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx, &alice).await;
    for week in 0..=PERIODS as i64 {
        set_time(&mut ctx, TGE + WEEK * week).await;
        claim(&mut ctx, &alice, &mint, amount, tree.proof(0)).await.unwrap();
    }
    let weekly_total = token_balance(&mut ctx, &ata(&alice.pubkey(), &mint)).await;

    // (b) claiming only at the end
    let mut ctx2 = program_test().start_with_context().await;
    let bob = Keypair::new();
    let allocs2 = vec![(bob.insecure_clone(), amount)];
    let (mint2, _, tree2, _) =
        setup_presale(&mut ctx2, &allocs2, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx2, &bob).await;
    set_time(&mut ctx2, TGE + WEEK * (PERIODS as i64)).await;
    claim(&mut ctx2, &bob, &mint2, amount, tree2.proof(0)).await.unwrap();
    let single_total = token_balance(&mut ctx2, &ata(&bob.pubkey(), &mint2)).await;

    assert_eq!(weekly_total, single_total);
    assert_eq!(weekly_total, amount);
}

// -- 5 ----------------------------------------------------------------------
/// A second claim within the same week must come to nothing (no double payment).
#[tokio::test]
async fn double_claim_same_week_fails() {
    let mut ctx = program_test().start_with_context().await;
    let alice = Keypair::new();
    let amount = 1_000_000u64;
    let allocs = vec![(alice.insecure_clone(), amount)];
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx, &alice).await;

    set_time(&mut ctx, TGE).await;
    claim(&mut ctx, &alice, &mint, amount, tree.proof(0)).await.unwrap();
    assert!(claim(&mut ctx, &alice, &mint, amount, tree.proof(0)).await.is_err());
    assert_eq!(token_balance(&mut ctx, &ata(&alice.pubkey(), &mint)).await, 90_000);
}

// -- 6 ----------------------------------------------------------------------
/// Writing more than they are owed must invalidate the proof.
#[tokio::test]
async fn inflated_amount_rejected() {
    let mut ctx = program_test().start_with_context().await;
    let alice = Keypair::new();
    let amount = 1_000_000u64;
    let allocs = vec![(alice.insecure_clone(), amount)];
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx, &alice).await;

    set_time(&mut ctx, TGE).await;
    assert!(claim(&mut ctx, &alice, &mint, amount * 1000, tree.proof(0)).await.is_err());
}

// -- 7 ----------------------------------------------------------------------
/// Trying to claim somebody else's share into your own wallet with their proof.
#[tokio::test]
async fn cannot_claim_someone_elses_allocation() {
    let mut ctx = program_test().start_with_context().await;
    let alice = Keypair::new();
    let mallory = Keypair::new();
    let allocs = vec![
        (alice.insecure_clone(), 5_000_000u64),
        (mallory.insecure_clone(), 1_000u64),
    ];
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx, &mallory).await;

    set_time(&mut ctx, TGE).await;
    // Alice's proof and Alice's amount, but Mallory signs.
    assert!(claim(&mut ctx, &mallory, &mint, 5_000_000, tree.proof(0)).await.is_err());
}

// -- 8 ----------------------------------------------------------------------
/// A made-up proof.
#[tokio::test]
async fn forged_proof_rejected() {
    let mut ctx = program_test().start_with_context().await;
    let alice = Keypair::new();
    let bob = Keypair::new();
    let allocs = vec![
        (alice.insecure_clone(), 5_000_000u64),
        (bob.insecure_clone(), 5_000_000u64),
    ];
    let (mint, _, _tree, _) = setup_presale(&mut ctx, &allocs, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx, &alice).await;

    set_time(&mut ctx, TGE).await;
    assert!(claim(&mut ctx, &alice, &mint, 5_000_000, vec![[0x42u8; 32]]).await.is_err());
    assert!(claim(&mut ctx, &alice, &mint, 5_000_000, vec![]).await.is_err());
}

// -- 9 ----------------------------------------------------------------------
/// A raffle round: no vesting, everything at once.
#[tokio::test]
async fn raffle_round_pays_in_full_immediately() {
    let mut ctx = program_test().start_with_context().await;
    let winner = Keypair::new();
    let prize = 1_110_000u64;
    let allocs = vec![(winner.insecure_clone(), prize)];
    // A 100% cliff and no tiers — that is all a raffle round is.
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, 10_000, 0, 0).await;
    fund(&mut ctx, &winner).await;

    set_time(&mut ctx, TGE).await;
    claim(&mut ctx, &winner, &mint, prize, tree.proof(0)).await.unwrap();
    assert_eq!(token_balance(&mut ctx, &ata(&winner.pubkey(), &mint)).await, prize);
}

// -- 10 ---------------------------------------------------------------------
/// A schedule that never reaches 100% must be rejected up front. Without this
/// check, a configuration such as 7% x 14 = 98% would be accepted silently and
/// the recipients' last 2% would stay locked forever.
#[tokio::test]
async fn incomplete_schedule_rejected() {
    let mut ctx = program_test().start_with_context().await;
    let mint_authority = Keypair::new();
    let mint = create_mint(&mut ctx, &mint_authority.pubkey()).await;
    let alice = Keypair::new();
    let tree = MerkleTree::new(vec![leaf_hash(&alice.pubkey(), 1_000)]);

    // 7% x 14 = 98% — short.
    let payer = ctx.payer.pubkey();
    let res = send(
        &mut ctx,
        &[initialize_ix(
            &payer,
            &mint,
            0,
            tree.root(),
            1_000,
            TGE,
            700,
            700,
            WEEK,
            13,
        )],
        &[],
    )
    .await;
    assert!(res.is_err(), "an incomplete schedule must not be accepted");
}

// -- 11 ---------------------------------------------------------------------
/// A round with many recipients: once everyone has claimed, the vault must empty
/// EXACTLY — neither short nor over.
#[tokio::test]
async fn many_buyers_drain_vault_exactly() {
    let mut ctx = program_test().start_with_context().await;
    // Deliberately irregular amounts that do not divide by 7.
    let amounts = [1u64, 2, 333, 4_999, 70_007, 271_950_137, 999_999_999];
    let buyers: Vec<(Keypair, u64)> =
        amounts.iter().map(|a| (Keypair::new(), *a)).collect();
    let (mint, _, tree, total) =
        setup_presale(&mut ctx, &buyers, CLIFF_BPS, PERIOD_BPS, PERIODS).await;

    set_time(&mut ctx, TGE + WEEK * (PERIODS as i64)).await;
    for (i, (kp, amt)) in buyers.iter().enumerate() {
        fund(&mut ctx, kp).await;
        claim(&mut ctx, kp, &mint, *amt, tree.proof(i)).await.unwrap();
        assert_eq!(token_balance(&mut ctx, &ata(&kp.pubkey(), &mint)).await, *amt);
    }

    let (distributor, _) = distributor_pda(&mint, 0);
    let (vault, _) = vault_pda(&distributor);
    assert_eq!(token_balance(&mut ctx, &vault).await, 0, "the vault must empty exactly");
    assert_eq!(total, amounts.iter().sum::<u64>());
}

// -- 12 ---------------------------------------------------------------------
/// DO THE JAVASCRIPT BUILDER AND THE RUST VERIFIER PRODUCE THE SAME TREE?
///
/// `scripts/build-merkle.mjs` will produce the proofs for the site, and this
/// program will verify them. A single byte of difference between the two
/// implementations means EVERYONE's proof is rejected on TGE day — and at that
/// point there is no chance to fix it (the root cannot be changed). So the root
/// produced from fixed inputs is pinned here: if either side changes, the test
/// fails rather than production.
///
/// The expected value is the output of `node scripts/build-merkle.mjs --selftest`.
#[tokio::test]
async fn merkle_matches_javascript_builder() {
    use std::str::FromStr;

    let vectors: [(&str, u64); 5] = [
        ("BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36", 1),
        ("2Lzc6jorznu7zQKny79topGTE7V837oiV3j53zPH4Qh9", 271_950_137),
        ("AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA", 1_110_000),
        ("3fBhNn8BEoFyQVAXasWj1xcNrcc2FRpLVQexFhZTnw6F", 999_999_999),
        ("BiWqNZzCPCfJtVPNhoCrvEb9s6unpCFXXf38GR3WnPWX", 70_007),
    ];

    let leaves: Vec<[u8; 32]> = vectors
        .iter()
        .map(|(addr, amt)| {
            leaf_hash(&solana_sdk::pubkey::Pubkey::from_str(addr).unwrap(), *amt)
        })
        .collect();
    let tree = MerkleTree::new(leaves);

    const EXPECTED_ROOT_HEX: &str =
        "abff8a1bd922224e6f527248403472af927f30ba5dd3f30769631674efaa039f";
    let root_hex: String = tree.root().iter().map(|b| format!("{:02x}", b)).collect();

    assert_eq!(
        root_hex, EXPECTED_ROOT_HEX,
        "the JS builder and the Rust verifier produce different roots — \
         the hash logic in scripts/build-merkle.mjs and lib.rs may have drifted apart"
    );
}

// -- 13 ---------------------------------------------------------------------
/// The END-TO-END check between the builder and the verifier.
///
/// Test 12 only compared the roots; this test goes one step further: it hands
/// the REAL proof bytes produced by `scripts/build-merkle.mjs` to the program's
/// OWN `verify_proof` function. That is, the two pieces of code that will run in
/// production are wired together here, before TGE.
#[tokio::test]
async fn program_accepts_javascript_generated_proof() {
    use std::str::FromStr;

    fn unhex(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    // From the output of node scripts/build-merkle.mjs --selftest, index 1.
    let claimant =
        solana_sdk::pubkey::Pubkey::from_str("2Lzc6jorznu7zQKny79topGTE7V837oiV3j53zPH4Qh9")
            .unwrap();
    let amount: u64 = 271_950_137;
    let proof = [
        unhex("973fffe1c6fe2c5801b62021cda3a674fc708014b3d4c997f1c18a9082ab0d28"),
        unhex("65b198e67a01daddac4cffed406cc2a898a70568366077f946431bc99ad5d7b6"),
        unhex("283ea9f56969f680bef82092ad970dbaafd3f92fb7653ec4ad3e526478533bf9"),
    ];
    let root = unhex("abff8a1bd922224e6f527248403472af927f30ba5dd3f30769631674efaa039f");

    // The program's OWN leaf hash and its OWN verifier.
    let leaf = luck_distributor::leaf_hash(&claimant, amount);
    assert!(
        luck_distributor::verify_proof(&proof, root, leaf),
        "the program rejected the JS builder's proof — the two sides have drifted apart"
    );

    // If the amount moves by even one unit, the proof must be invalid.
    let tampered = luck_distributor::leaf_hash(&claimant, amount + 1);
    assert!(!luck_distributor::verify_proof(&proof, root, tampered));

    // It must be invalid for another address too.
    let other = solana_sdk::pubkey::Pubkey::new_unique();
    assert!(!luck_distributor::verify_proof(
        &proof,
        root,
        luck_distributor::leaf_hash(&other, amount)
    ));
}

// ---------------------------------------------------------------------------
// 14. The ABI golden vector — the client and the program speaking the same bytes
// ---------------------------------------------------------------------------
// THE SITE (TypeScript) builds the claim instruction and THE PROGRAM (Rust)
// verifies it. A single byte of difference between them — a wrong
// discriminator, a swapped account order, a bad length field — means EVERYONE's
// claim is rejected on TGE day. At that point the chance to fix it is limited
// and the reputation is already gone.
//
// This test pins the instruction bytes the program itself produces to a fixed
// vector. The same vector is reproduced on the client side inside
// scripts/check-abi.mjs. If the two drift apart, it is caught here, before TGE.
#[test]
fn claim_instruction_bytes_match_golden_vector() {
    use anchor_lang::InstructionData;

    let proof: Vec<[u8; 32]> = vec![[0x11u8; 32], [0x22u8; 32]];
    let data = luck_distributor::instruction::Claim {
        total_amount: 271_950_000_000_000_000u64,
        proof,
    }
    .data();

    let hex: String = data.iter().map(|b| format!("{b:02x}")).collect();
    println!("claim ix bytes: {hex}");

    // discriminator = sha256("global:claim")[0..8]
    assert_eq!(
        &hex[0..16],
        "3ec6d6c1d59f6cd2",
        "the claim discriminator changed — the client and the program now call \
         different instructions"
    );
    // The u64 amount (little-endian) + the Vec length (u32 LE) + 2 x 32-byte nodes
    assert_eq!(data.len(), 8 + 8 + 4 + 64, "the instruction data length changed");
    assert_eq!(
        &hex[16..32],
        "00e0aa8a1529c603",
        "the amount encoding changed (it must be u64 little-endian)"
    );
    assert_eq!(&hex[32..40], "02000000", "the proof length must be u32 little-endian");
    assert!(hex.ends_with(&"22".repeat(32)), "the order of the proof nodes changed");
}

// ---------------------------------------------------------------------------
// 15. The initialize ABI golden vector
// ---------------------------------------------------------------------------
// This is the instruction that opens the round and LOCKS the tokens. If it is
// encoded wrongly, one of two bad outcomes follows: either the transaction is
// rejected (we notice), or a wrong schedule/root is silently written to the
// chain — and because the program contains no update instruction, there is no
// way back from that point.
//
// The same vector is reproduced inside scripts/check-abi.mjs by running the
// REAL script that will run on TGE day.
#[test]
fn initialize_instruction_bytes_match_golden_vector() {
    use anchor_lang::InstructionData;

    let merkle_root = [
        0x9b, 0x4c, 0x1b, 0xb9, 0xc4, 0x0f, 0xe4, 0xfe, 0x3d, 0x4e, 0xe9, 0xe1, 0x72, 0xc6, 0x31,
        0x84, 0x02, 0x50, 0x34, 0x21, 0xb3, 0x4f, 0x26, 0xe7, 0x4c, 0xa9, 0x75, 0x49, 0x38, 0xbb,
        0xce, 0x84,
    ];
    let data = luck_distributor::instruction::Initialize {
        id: 0,
        merkle_root,
        total_allocated: 3_330_000_000_000_000u64,
        start_ts: 1_788_264_000i64, // 2026-09-01T12:00:00Z
        cliff_bps: 900,
        period_bps: 700,
        period_seconds: 604_800i64,
        periods: 13,
    }
    .data();

    let hex: String = data.iter().map(|b| format!("{b:02x}")).collect();
    println!("initialize ix bytes: {hex}");

    assert_eq!(
        &hex[0..16],
        "afaf6d1f0d989bed",
        "the initialize discriminator changed"
    );
    // 8 disc + 8 id + 32 root + 8 total + 8 time + 2 + 2 + 8 + 2
    assert_eq!(data.len(), 8 + 8 + 32 + 8 + 8 + 2 + 2 + 8 + 2);
    assert_eq!(
        hex,
        "afaf6d1f0d989bed\
         0000000000000000\
         9b4c1bb9c40fe4fe3d4ee9e172c6318402503421b34f26e74ca9754938bbce84\
         00201a0b9ed40b00\
         40be966a00000000\
         8403\
         bc02\
         803a090000000000\
         0d00",
        "the initialize field encoding changed"
    );
}

// ---------------------------------------------------------------------------
// 16. The unlock-schedule golden vector — the interface and the program agreeing
// ---------------------------------------------------------------------------
// The `unlocked_amount` formula is written TWICE: here (Rust) and in the
// interface (src/lib/luckClaim.ts). That is deliberate — the interface has to be
// able to show the right number without asking the chain. But if the two drift
// apart, a user sees something as "claimable", signs, and the transaction is
// rejected; or conversely never sees the amount they are owed.
//
// The table below also appears verbatim inside scripts/check-abi.mjs, where it
// is produced with the interface's own function.
#[test]
fn unlock_schedule_matches_golden_vector() {
    use luck_distributor::Distributor;
    use solana_sdk::pubkey::Pubkey;

    const START: i64 = 1_788_264_000; // 2026-09-01T12:00:00Z
    const WEEK: i64 = 604_800;
    // The presale share: 271,950,000 $LUCK at 9 decimals.
    const TOTAL: u64 = 271_950_000_000_000_000;

    let d = Distributor {
        id: 0,
        authority: Pubkey::default(),
        mint: Pubkey::default(),
        vault: Pubkey::default(),
        merkle_root: [1u8; 32],
        total_allocated: TOTAL,
        total_claimed: 0,
        start_ts: START,
        cliff_bps: 900,
        period_bps: 700,
        period_seconds: WEEK,
        periods: 13,
        bump: 255,
    };

    // (seconds, the expected unlocked amount)
    let vector: &[(i64, u64)] = &[
        (START - 1, 0),                          // 1 s before TGE
        (START, 24_475_500_000_000_000),         // TGE: 9%
        (START + WEEK - 1, 24_475_500_000_000_000), // the last second of week 1
        (START + WEEK, 43_512_000_000_000_000), // week 1: 16%
        (START + 6 * WEEK, 138_694_500_000_000_000), // week 6: 51%
        (START + 13 * WEEK, TOTAL),            // week 13: 100%
        (START + 99 * WEEK, TOTAL),            // long afterwards: still 100%
    ];

    for (t, expected) in vector {
        let actual = luck_distributor::unlocked_amount(&d, TOTAL, *t).unwrap();
        assert_eq!(
            actual, *expected,
            "t = start + {} s: expected {expected}, got {actual}",
            t - START
        );
    }

    // THE ROUNDING DIRECTION. Because every step in the vector above divides
    // exactly, it never tests the direction of the rounding — that blind spot came
    // to light when the formula was deliberately broken to round up and the test
    // STILL PASSED.
    //
    // The direction is critical: rounding up, the sum of the individual shares
    // could exceed total_allocated and THE LAST RECIPIENT's claim would fail
    // because the vault had run out. Rounding down, at worst a few units stay in
    // the vault.
    let indivisible: u64 = 1_000_000_007;
    for (bps_target, expected) in [(900u64, 90_000_000u64), (1_600, 160_000_001), (5_100, 510_000_003)] {
        let tier = ((bps_target - 900) / 700) as i64;
        let actual =
            luck_distributor::unlocked_amount(&d, indivisible, START + tier * WEEK).unwrap();
        assert_eq!(
            actual, expected,
            "the rounding direction changed on an indivisible amount (bps {bps_target})"
        );
    }

    // At the end of the schedule NO DUST may be left in the vault. Because the
    // rounding is down, intermediate steps can fall a few units short; closing
    // exactly at the end is what makes the "no withdraw instruction" design work.
    assert_eq!(
        luck_distributor::unlocked_amount(&d, TOTAL, START + 13 * WEEK).unwrap(),
        TOTAL
    );
}

// ---------------------------------------------------------------------------
// THE ACCOUNTS' BYTE LAYOUT — every number the Claim tab reads comes from here
// ---------------------------------------------------------------------------
// The Claim tab reads the on-chain Distributor account with fixed offsets,
// without an IDL (fetchDistributor). Inserting one field into the struct is
// enough: TypeScript keeps reading from the same offsets and shows wrong values
// WITHOUT ANY ERROR —
//   * if merkle_root shifts, everyone is told "you are not on the list",
//   * if total_allocated shifts, the percentages are nonsense,
//   * if start_ts shifts, the schedule comes out wrong and it says either "not
//     started yet" or "everything has unlocked".
// All of it on TGE day, at the moment when the chance to fix it is narrowest.
//
// The vectors were derived independently of Anchor's rules rather than copied
// from the program's output:
//   the discriminator = sha256("account:<Name>")[0..8]
//   the body          = Borsh: fields in order, numbers little-endian
// The same bytes are handed to THE SITE'S REAL readers inside
// scripts/check-abi.mjs and read back.
#[test]
fn account_bytes_match_the_golden_vector() {
    use anchor_lang::{AnchorSerialize, Discriminator};

    let hex = |d: &[u8]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();

    let distributor_out = luck_distributor::Distributor {
        id: 7,
        authority: anchor_lang::prelude::Pubkey::new_from_array([1u8; 32]),
        mint: anchor_lang::prelude::Pubkey::new_from_array([2u8; 32]),
        vault: anchor_lang::prelude::Pubkey::new_from_array([3u8; 32]),
        merkle_root: [4u8; 32],
        total_allocated: 52_500_000_000_000,
        total_claimed: 4_725_000_000_000,
        start_ts: 1_800_000_000,
        cliff_bps: 900,
        period_bps: 700,
        period_seconds: 604_800,
        periods: 13,
        bump: 254,
    };
    let mut bytes = luck_distributor::Distributor::DISCRIMINATOR.to_vec();
    distributor_out.serialize(&mut bytes).unwrap();
    println!("Distributor : {}", hex(&bytes));
    assert_eq!(
        hex(&bytes),
        "5a5ad99306208704\
         0700000000000000\
         0101010101010101010101010101010101010101010101010101010101010101\
         0202020202020202020202020202020202020202020202020202020202020202\
         0303030303030303030303030303030303030303030303030303030303030303\
         0404040404040404040404040404040404040404040404040404040404040404\
         00c8d99bbf2f0000\
         0052f21f4c040000\
         00d2496b00000000\
         8403\
         bc02\
         803a090000000000\
         0d00\
         fe",
        "the Distributor account's byte layout changed — the Claim tab would read it WRONG"
    );

    let state = luck_distributor::ClaimStatus {
        claimed: 4_725_000_000_000,
        bump: 253,
    };
    let mut bytes = luck_distributor::ClaimStatus::DISCRIMINATOR.to_vec();
    state.serialize(&mut bytes).unwrap();
    println!("ClaimStatus : {}", hex(&bytes));
    assert_eq!(
        hex(&bytes),
        "16b7f99df75f9660\
         0052f21f4c040000\
         fd",
        "the ClaimStatus account's byte layout changed — the claimed amount would be read WRONG"
    );
}
