// The smallest test that confirms the harness really works in this environment.
// The actual scenarios live in distributor.rs.
//
// It used to assert something that was ALWAYS true, and therefore verified
// nothing. When it was green we said "the harness works", but all we had
// actually said was "it did not panic". Turning clippy to strict mode exposed
// it.
//
// It now asks the real question: WAS THE PROGRAM actually loaded into the test
// bank? If it was not, every other test would fail with meaningless errors, and
// the reason would be visible here.
mod common;

use solana_sdk::pubkey::Pubkey;

#[tokio::test]
async fn the_harness_starts_and_the_program_is_loaded() {
    let mut ctx = common::program_test().start_with_context().await;

    let hesap = ctx
        .banks_client
        .get_account(luck_distributor::ID)
        .await
        .unwrap()
        .expect("the program account is not in the test bank — the program was never loaded");

    assert!(
        hesap.executable,
        "the program account exists but is not executable"
    );
    assert_ne!(
        hesap.owner,
        Pubkey::default(),
        "the program account has no owner — the load was left half-finished"
    );

    // The system program must be in place too; without it every test that creates
    // an account fails with an incomprehensible error.
    assert!(
        ctx.banks_client
            .get_account(solana_sdk::system_program::ID)
            .await
            .unwrap()
            .is_some(),
        "the system program is not in the test bank"
    );
}
