// Test altyapısının bu ortamda gerçekten çalıştığını doğrulayan en küçük
// test. Asıl senaryolar distributor.rs içinde.
mod common;

#[tokio::test]
async fn harness_boots() {
    let mut ctx = common::program_test().start_with_context().await;
    let slot: u64 = ctx.banks_client.get_root_slot().await.unwrap();
    assert!(slot > 0 || slot == 0);
}
