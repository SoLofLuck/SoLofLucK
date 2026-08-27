// Test altyapısının bu ortamda gerçekten çalıştığını doğrulayan en küçük
// test. Asıl senaryolar distributor.rs içinde.
//
// Eskiden buradaki tek iddia `assert!(slot > 0 || slot == 0)` idi — bir u64
// için HER ZAMAN doğru, yani hiçbir şey doğrulamıyordu. Test yeşil
// olduğunda "altyapı çalışıyor" diyorduk ama aslında yalnızca "panik
// olmadı" demiş oluyorduk. clippy'yi sıkı moda alınca ortaya çıktı.
//
// Şimdi asıl soruyu soruyor: PROGRAM test bankasına gerçekten yüklendi mi?
// Yüklenmediyse diğer testlerin hepsi anlamsız hatalarla düşerdi ve sebebi
// buradan görünürdü.
mod common;

use solana_sdk::pubkey::Pubkey;

#[tokio::test]
async fn altyapi_ayaga_kalkiyor_ve_program_yuklu() {
    let mut ctx = common::program_test().start_with_context().await;

    let hesap = ctx
        .banks_client
        .get_account(luck_distributor::ID)
        .await
        .unwrap()
        .expect("program hesabı test bankasında yok — program hiç yüklenmemiş");

    assert!(
        hesap.executable,
        "program hesabı var ama çalıştırılabilir değil"
    );
    assert_ne!(
        hesap.owner,
        Pubkey::default(),
        "program hesabının sahibi yok — yükleme yarım kalmış"
    );

    // Sistem programı da yerinde olmalı; olmazsa hesap oluşturan her test
    // sebebi anlaşılmaz bir hatayla düşer.
    assert!(
        ctx.banks_client
            .get_account(solana_sdk::system_program::ID)
            .await
            .unwrap()
            .is_some(),
        "sistem programı test bankasında yok"
    );
}
