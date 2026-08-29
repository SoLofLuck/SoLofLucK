// ---------------------------------------------------------------------------
// Zar doğru üretiliyor mu — published edilen oran gerçek mi
// ---------------------------------------------------------------------------
// İki farklı yoldan sınıyoruz, çünkü tek başına ikisi de yetmiyor.
//
// 1) BAĞIMSIZ TÜRETME (asıl kanıt). Test, zarı programın kaynağına HİÇ
//    bakmadan, spesifikasyondan yeniden hesaplıyor ve her turda zincirin
//    aynı sonuca varıp varmadığına bakıyor. Eski hatalı uygulama (zarı 2
//    baytlık bir sayıdan üretmek) ile doğru uygulama farklı sonuçlar
//    verdiği için bu, hatayı ilk birkaç turda yakalıyor.
//
//    Ayrıca modülo işlemini bilerek BAŞKA bir yoldan yapıyoruz (bayt bayt
//    remaining yürütme). Programdaki `u64::from_le_bytes(..) % 10000` ifadesini
//    aynen kopyalasaydık test, uygulamayı doğru kabul edip tekrarlamış
//    olurdu.
//
// 2) İSTATİSTİK (ikinci savunma hattı). Bağımsız türetme yanlış bir
//    spesifikasyonu yakalayamaz — ikimiz de aynı şekilde yanılıyor
//    olabiliriz. Kazanma oranını sayıp published edilene oturduğunu görmek bunu
//    kapatıyor.
//
// KARARSIZLIK YOK: rastgeleliğin kaynağı olan SlotHashes'i testin kendisi
// kuruyor ve hash'ler tur numarasından türüyor, yani sonuç her koşuda
// birebir aynı.
mod common;

use common::*;
use solana_sdk::{pubkey::Pubkey, signature::Signer, signer::keypair::Keypair};

/// Bu eşik, old hatanın sapmayı EN ÇOK büyüttüğü nokta. 65536, 10000'in
/// tam katı değil (65536 = 6 × 10000 + 5536), dolayısıyla 2 baytlık zarda
/// 0..5535 aralığı 7 kez, kalanı 6 kez temsil ediliyordu. win_bps = 5536'da:
///   published edilen : %55,36
///   gerçekleşen : 5536 × 7 / 65536 = %59,13   (+3,77 puan)
const WIN_BPS: u16 = 5_536;

const TURLAR: u32 = 200;

#[tokio::test]
async fn the_dice_matches_the_spec_and_the_rate_matches_what_is_published() {
    // Kasa her turda ödeyebilecek kadar dolu olmalı; aksi halde "kasa
    // ödeyemiyor" dalı devreye girip kazançları kayba çevirir ve ölçtüğümüz
    // şey dice değil kasa bakiyesi olurdu.
    let mut g = Game::start_with(500_000 * SOL, WIN_BPS, WIN_BPS, 0).await;
    let player = new_player(&mut g.ctx, 10_000 * SOL).await;
    let delegate = Keypair::new();

    let mut winnings = 0u32;
    let mut spins_left = 0u32;

    for tur in 0..TURLAR {
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
        let hash = round_hash(tur);
        g.set_slot_hashes(&[(target, hash)]);

        g.send(&[g.resolve_ix(&player.pubkey())], &[]).await.unwrap();

        let st = g.player_state(&player.pubkey()).await.unwrap();
        let chain_won = st.wins_count > previous_winnings;

        // 1) Bağımsız türetme.
        let dice = expected_dice(&hash, target, &player.pubkey(), plays_count);
        let expected_won = dice < WIN_BPS as u32;
        assert_eq!(
            chain_won, expected_won,
            "tur {tur}: dice {dice} (eşik {WIN_BPS}) → beklenen kazandı={expected_won}, \
             zincir kazandı={chain_won}"
        );

        if chain_won {
            winnings += 1;
        }
    }

    // Zincir uyumu kanıtlandı; kaç kez kazandığı burada yalnızca
    // bilgilendirme amaçlı yazdırılıyor. Oranın GERÇEKTEN yansız olduğu
    // aşağıdaki ayrı testte, çok daha fazla örnekle sınanıyor.
    println!(
        "zincir uyumu: {TURLAR}/{TURLAR} tur · kazanma {winnings}/{TURLAR}"
    );
}

/// Zarın YANSIZ olduğunu çok sayıda örnekle sınar.
///
/// Neden çevrimdışı: yukarıdaki test zincirin spesifikasyona harfiyen
/// uyduğunu zaten kanıtladı. Dolayısıyla spesifikasyonun kendisini burada,
/// zincire hiç uğramadan yüz binlerce örnekle sınayabiliyoruz — zincir
/// üstünde bu kadar tur koşturmak dakikalar sürerdi ve 400 turluk bir
/// örneklem old hatayı güvenilir şekilde ayırt edemiyordu (gözlenen sapma
/// gürültünün içinde kalıyordu).
///
/// Test kendi gücünü de kanıtlıyor: aynı ölçüm ESKİ (2 baytlık) türetmeye
/// uygulandığında sapmayı YAKALAMALI. Yakalamazsa ölçüm işe yaramıyor
/// demektir ve o zaman bu test de düşer.
#[test]
fn the_dice_is_unbiased_and_the_measurement_catches_the_old_bug() {
    const ORNEK: u32 = 200_000;
    const ESIK: u32 = WIN_BPS as u32;

    let mut correct_winnings = 0u32;
    let mut old_winnings = 0u32;
    let player = Pubkey::new_from_array([9u8; 32]);

    for i in 0..ORNEK {
        let mut preimage = Vec::new();
        preimage.extend_from_slice(&round_hash(i));
        preimage.extend_from_slice(&(i as u64).to_le_bytes());
        preimage.extend_from_slice(player.as_ref());
        preimage.extend_from_slice(&i.to_le_bytes());
        let digest = solana_sdk::hash::hash(&preimage).to_bytes();

        // Şimdiki (doğru) türetme: 8 bayt.
        if remainder_10000(&digest[0..8]) < ESIK {
            correct_winnings += 1;
        }
        // Eski (hatalı) türetme: 2 bayt.
        if (u16::from_le_bytes([digest[0], digest[1]]) as u32) % 10_000 < ESIK {
            old_winnings += 1;
        }
    }

    let published = ESIK as f64 / 10_000.0;
    let correct = correct_winnings as f64 / ORNEK as f64;
    let old = old_winnings as f64 / ORNEK as f64;
    println!(
        "published %{:.2} · 8 baytlık dice %{:.2} (sapma {:.3} puan) · 2 baytlık dice %{:.2} (sapma {:.3} puan)",
        published * 100.0,
        correct * 100.0,
        (correct - published).abs() * 100.0,
        old * 100.0,
        (old - published).abs() * 100.0
    );

    // n = 200.000, p ≈ 0,55 için standart sapma ≈ %0,111; 4 sigma ≈ %0,45.
    assert!(
        (correct - published).abs() < 0.0045,
        "8 baytlık dice published edilen orandan {:.3} puan sapıyor",
        (correct - published).abs() * 100.0
    );

    // Ölçümün gücü: old türetme +3,77 puan sapmalıydı. Bu kontrol
    // düşerse, yukarıdaki kontrolün geçmesi hiçbir şey kanıtlamıyor
    // demektir.
    assert!(
        (old - published) > 0.03,
        "ölçüm old hatayı yakalayamadı (old sapma yalnızca {:.3} puan) —          bu testin geçmesi bir şey kanıtlamıyor",
        (old - published) * 100.0
    );
}
