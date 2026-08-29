// ---------------------------------------------------------------------------
// luck-game davranış testleri
// ---------------------------------------------------------------------------
// Öncelik sırası, paranın kaybolabileceği yerler:
//   1. Oyuncu published edilen package fiyatından FAZLA ödüyor mu
//   2. Kasadan izinsiz para çıkabiliyor mu
//   3. Bir spin hakkı sessizce yanabiliyor mu
//   4. İlan edilen kazanma oranı gerçekleşen oranla tutuyor mu
mod common;

use common::*;
use luck_game::GameError;
use solana_sdk::{pubkey::Pubkey, signature::Signer, signer::keypair::Keypair};

// ---------------------------------------------------------------------------
// 1. Satın alma: oyuncunun cebinden çıkan tutar
// ---------------------------------------------------------------------------

/// Kullanıcının bildirdiği asıl şikâyet buydu: 0,1 SOL'lük pakette Phantom
/// -0,101622 SOL gösteriyordu. Fazlalık, player_state hesabının kira
/// depozitosuydu. Artık kasa bunu geri ödüyor; oyuncunun cebinden çıkan
/// TAM OLARAK package fiyatı olmalı (işlem ücreti hariç — onu Solana alıyor,
/// biz değil).
#[tokio::test]
async fn the_first_purchase_charges_exactly_the_package_price() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    let before = g.lamports(&player.pubkey()).await;
    let ix = g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 0);
    g.send(&[ix], &[&player]).await.unwrap();
    let after = g.lamports(&player.pubkey()).await;

    // İşlem ücretini payer (ctx.payer) ödüyor, player değil — dolayısıyla
    // oyuncunun bakiyesindeki değişim tam olarak package fiyatı olmalı.
    assert_eq!(
        before - after,
        TIER_PRICES[0],
        "oyuncudan package fiyatından farklı bir tutar çıktı"
    );
}

/// Kira iadesi YALNIZCA ilk satın alımda olmalı. Olmazsa kasa her satın
/// alımda 0,0016 SOL sızdırır.
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

    assert_eq!(before - after, TIER_PRICES[0], "ikinci alımda tutar farklı");
}

/// Kasa, oyuncuya iade ettiği ve delegeye gönderdiği tutarı KENDİ payından
/// karşılamalı; player her zaman tam fiyatı ödediği için, kasa + hazine
/// toplamı package fiyatından katılım maliyeti kadar az artar.
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
    // Ev payı, paketin TAMAMI üzerinden hesaplansaydı bu değer olurdu:
    let naive = TIER_PRICES[0] * TREASURY_FEE_BPS as u64 / 10_000;
    assert!(
        fee < naive,
        "ev payı hâlâ paketin tamamı üzerinden alınıyor: {fee} >= {naive}"
    );
    // ...ve katılım maliyeti kadar (ve yalnızca o kadar) düşük olmalı.
    let onboarding = naive - fee;
    let onboarding = onboarding * 10_000 / TREASURY_FEE_BPS as u64;
    assert!(
        onboarding > 0 && onboarding < TIER_PRICES[0],
        "katılım maliyeti mantıksız: {onboarding}"
    );
}

/// register_delegate KASADAN HİÇ PARA ÇIKARMAMALI. Eskiden çıkarıyordu ve
/// izinsiz çağrılabildiği için boş cüzdanlarla art arda kayıt olup kasayı
/// boşaltmak KÂRLI bir saldırıydı.
#[tokio::test]
async fn registration_takes_no_money_out_of_the_vault() {
    let mut g = Game::start(50 * SOL).await;
    let vault_before = g.lamports(&g.vault.clone()).await;

    // Yüz ayrı boş cüzdanla kayıt: old davranışta bu 100 × 200_000 lamport
    // sızdırırdı.
    for _ in 0..25 {
        let attacker = new_player(&mut g.ctx, SOL).await;
        let delegate = Keypair::new();
        let ix = g.register_delegate_ix(&attacker.pubkey(), &delegate.pubkey());
        g.send(&[ix], &[&attacker]).await.unwrap();
    }

    let vault_after = g.lamports(&g.vault.clone()).await;
    assert_eq!(vault_before, vault_after, "kasadan para sızdı");
}

// ---------------------------------------------------------------------------
// 2. Spin muhasebesi
// ---------------------------------------------------------------------------

/// Kullanıcı 0,1 SOL'e 8 kere çevirebilmişti: zincir üstü free_plays,
/// tarayıcıdaki ücretsiz denemelerin ÜSTÜNE ekleniyordu. free_plays = 0
/// olduğunda 1 spinlik package TAM OLARAK 1 spin vermeli.
#[tokio::test]
async fn a_one_spin_package_gives_exactly_one_spin() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    let ix = g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 0);
    g.send(&[ix], &[&player]).await.unwrap();

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert_eq!(st.spins_remaining, 1, "package beklenenden farklı spin verdi");

    // Bir kez play → 0 kalmalı, ikincisi reddedilmeli.
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

/// Bekleyen bir oyun varken ikinci kez oynanamaz — aksi halde player
/// kaybettiğini gördüğü turu resolve etmeyip yenisini başlatabilirdi.
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

/// Kayıtlı olmayan bir anahtar başkasının spinini harcayamaz.
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
// 3. Resolve: zamanlama ve atlanan slot
// ---------------------------------------------------------------------------

/// Bir oyuncuyu "bekleyen oyun" durumuna getirir ve target slot'u döner.
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

/// ASIL DÜZELTME. Hedef slot atlanmışsa (lideri blok üretememişse) o slot
/// SlotHashes'e hiç girmez. Eskiden burada TAM EŞLEŞME aranıyordu, yani
/// böyle bir oyun SONSUZA DEK sonuçlandırılamıyor, player spinini
/// kaybediyordu. Devnet'te atlanma oranı yer yer %5-15 — yani her 10-20
/// spinde bir sessizce yaşanan gerçek bir para kaybı.
#[tokio::test]
async fn a_skipped_target_slot_settles_with_the_next_slot() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 0).await;

    g.warp(target + 3);
    // Hedef slot ve ondan sonraki iki slot ATLANMIŞ; ilk üretilen slot
    // target + 3.
    g.set_slot_hashes(&[(target - 1, [1u8; 32]), (target + 3, [9u8; 32])]);

    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .expect("atlanan target slot yüzünden resolve düştü");

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "oyun hâlâ bekliyor");
}

/// Pencerenin İÇİNDE hiç üretilmiş slot yoksa (gerçekte olmaz ama) resolve
/// düşer ve player forfeit'e yönlendirilir — sessizce yanlış bir sonuç
/// üretilmez.
#[tokio::test]
async fn resolve_fails_when_the_window_holds_no_slot() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 0).await;

    g.warp(target + 2);
    // Yalnızca hedeften ÖNCEKİ slot'lar var.
    g.set_slot_hashes(&[(target - 2, [1u8; 32]), (target - 1, [2u8; 32])]);

    let err = g
        .send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::SlotHashNotFound);
}

/// Aynı oyun iki kez sonuçlandırılamaz — aksi halde kazanan bir tur
/// tekrar tekrar ödenirdi.
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

/// Pencere kapanmadan forfeit edilemez — aksi halde player kaybettiğini
/// gördüğü turu forfeit edip yeniden oynayabilirdi. (Spin iadesi
/// olmadığı için kâr etmezdi ama kural yine de kapalı olmalı.)
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

/// Forfeit spini İADE ETMEZ. Etseydi, kaybettiğini önceden hesaplayan bir
/// player resolve etmeyip forfeit ederek bedava yeniden dice atardı —
/// commit-reveal'ın tüm anlamı buradan kaçardı.
#[tokio::test]
async fn forfeit_does_not_refund_the_spin() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    // 5 spinlik package: oynadıktan sonra 4 kalmalı, forfeit sonrası da 4.
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 1).await;
    let before = g.player_state(&player.pubkey()).await.unwrap().spins_remaining;
    assert_eq!(before, 4);

    g.warp(target + 301);
    g.send(&[g.forfeit_ix(&player.pubkey())], &[&player])
        .await
        .unwrap();

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "forfeit sonrası hâlâ bekliyor");
    assert_eq!(
        st.spins_remaining, before,
        "forfeit spini iade etti — bedava yeniden dice atma açığı"
    );
}

/// Ödül HER ZAMAN oyuncuya gider, resolve'u çağırana değil. resolve
/// izinsiz (permissionless) olduğu için bu kritik: aksi halde bir
/// "keeper" başkalarının kazançlarını kendi cüzdanına toplardı.
#[tokio::test]
async fn the_prize_is_paid_to_the_player_not_the_caller() {
    // easy_win_bps = 10000: bu kurulumda her tur kazanır, ödemeyi
    // gözlemleyebiliyoruz.
    let mut g = Game::start_with(50 * SOL, 10_000, 10_000, 0).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    // resolve() izinsiz olduğu için imzacı listesine hiç girmiyor: işlemi
    // gönderen taraf test payer'ı, yani oyuncudan tamamen başka biri.
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
        "oyuncuya ödeme yapılmadı ({player_before} -> {player_after})"
    );
    assert!(
        keeper_after < keeper_before,
        "resolve'u çağıran taraf para kazandı ({keeper_before} -> {keeper_after})          — yalnızca işlem ücreti ödemeliydi"
    );
    let winnings = player_after - player_before;
    assert!(
        winnings == SMALL_PRIZE || winnings == BIG_PRIZE,
        "ödenen tutar published edilen ödüllerden biri değil: {winnings}"
    );
}

/// Kasa en büyük olası ÖDEMEYİ (jackpot + operasyon payı) karşılayamıyorsa
/// kazanan tur bile ödenmez — ama işlem GERİ ALINMAZ, player sessizce
/// loses ve tekrar oynayabilir. Aksi halde player `pending = true`
/// durumunda pencere kapanana kadar sıkışırdı.
#[tokio::test]
async fn the_player_is_not_stuck_when_the_vault_cannot_pay() {
    // Kasa jackpot + payını karşılayamayacak kadar boş; kazanma oranı %100.
    let mut g = Game::start_with(BIG_PRIZE / 2, 10_000, 10_000, 0).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;

    let target = play(&mut g, &player, &Keypair::new().pubkey(), 1).await;
    g.warp(target + 1);
    g.set_slot_hashes(&[(target, [5u8; 32])]);

    let before = g.lamports(&player.pubkey()).await;
    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .expect("kasa boşken resolve tüm işlemi geri aldı — player sıkışırdı");

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "player bekleyen durumda kaldı");
    assert_eq!(
        g.lamports(&player.pubkey()).await,
        before,
        "kasa ödeyemezken yine de ödeme yapıldı"
    );
}

// ---------------------------------------------------------------------------
// 4. Dolu sysvar'da doğru slot seçimi
// ---------------------------------------------------------------------------

/// SlotHashes gerçekte 512 kayıt tutuyor. Yukarıdaki testler sysvar'ı bir
/// iki kayıtla kurduğu için tarama mantığının asıl koşullarını
/// zorlamıyorlar: penceremizin ÜSTÜNDE remaining (daha yeni) kayıtların
/// atlanması, hedefin ALTINA düşünce durulması ve birden çok uygun aday
/// varken hedefe EN YAKIN olanın seçilmesi.
///
/// Hedefe en yakını seçmek keyfi bir tercih değil: o slot bir kez ortaya
/// çıktıktan sonra bir daha değişmiyor (sonradan eklenen slot'lar hep daha
/// büyük). "En yeni uygun slot" seçilseydi, sonuç resolve'un NE ZAMAN
/// çağrıldığına göre değişirdi ve player kazanana kadar bekleyerek dice
/// çevirebilirdi.
#[tokio::test]
async fn the_slot_closest_to_the_target_is_chosen_in_a_full_sysvar() {
    // Kazanma eşiği %50: iki aday slot'tan birinin kazandırdığı, diğerinin
    // kaybettirdiği bir hash çifti bulmak böylece kolay.
    let mut g = Game::start_with(50 * SOL, 5_000, 5_000, 0).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    // Önce ileri sarıyoruz: sysvar'ı hedefin ALTINDA 509 kayıtla
    // doldurabilmek için slot numarasının o kadar büyük olması gerekiyor.
    g.warp(1_000);
    let target = play(&mut g, &player, &Keypair::new().pubkey(), 1).await;

    let st = g.player_state(&player.pubkey()).await.unwrap();
    let plays_count = st.plays_count;

    // İki aday: hedefe YAKIN olan ve DAHA YENİ olan. Sonuçları ZITLAŞACAK
    // şekilde hash arıyoruz — ancak o zaman "hangisi seçildi" sorusunun
    // gözlenebilir bir cevabı oluyor. Aksi halde iki seçim de aynı sonucu
    // verir ve test hiçbir şey ayırt etmez.
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
    assert!(found, "zıt sonuç veren hash çifti bulunamadı");

    g.warp(target + 250);

    // 512 kayıtlık gerçekçi bir sysvar:
    //  - hedefin altında 509 kayıt (taramanın durması gereken bölge)
    //  - pencerenin içinde 2 aday: near_slot ve new_slot
    //  - pencerenin üstünde 1 kayıt (atlanması gereken)
    let mut entries: Vec<(u64, [u8; 32])> = (1..=509u64)
        .map(|i| (target - i, [(i % 251) as u8; 32]))
        .collect();
    entries.push((near_slot, near_hash));
    entries.push((new_slot, new_hash));
    entries.push((target + MAX_RESOLVE_WINDOW_SLOTS_TEST + 1, [99u8; 32]));
    g.set_slot_hashes(&entries);

    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .expect("dolu sysvar'da resolve düştü");

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "oyun sonuçlanmadı");
    assert_eq!(
        st.wins_count, 1,
        "sonuç, hedefe en yakın slot ({near_slot}) yerine daha yeni bir slot \
         ({new_slot}) kullanılarak üretilmiş — resolve'un NE ZAMAN çağrıldığı \
         sonucu değiştirebilir demektir, player kazanana kadar bekleyebilirdi"
    );
}

/// resolve penceresinin uzunluğu (lib.rs'teki MAX_RESOLVE_WINDOW_SLOTS ile
/// aynı olmalı). Sabit programda `pub` değil; testte kopyası tutuluyor ve
/// `resolve_fails_when_the_window_holds_no_slot` ile
/// `forfeit_does_not_refund_the_spin` testleri ikisinin uyuştuğunu dolaylı olarak
/// doğruluyor.
const MAX_RESOLVE_WINDOW_SLOTS_TEST: u64 = 300;

// ---------------------------------------------------------------------------
// 5. ABI altın vektörü — istemci ile programın aynı baytları konuşması
// ---------------------------------------------------------------------------
// Oyunun beş talimatını da SİTE (TypeScript) kuruyor, program (Rust)
// doğruluyor. Ayırıcı (discriminator) ya da hesap sırası kayarsa işlem
// reddedilir — ve bu, oyunun tamamen durması demek.
//
// Ayırıcılar sha256("global:<isim>")[0..8]'den geliyor, yani bir talimatın
// ADI değişirse sessizce değişirler. Hesap sırası da struct field sırasına
// bağlı; araya field eklemek yeter.
//
// Aynı vektörler scripts/check-abi.mjs içinde, istemcinin GERÇEK
// kurucuları çağrılarak yeniden üretiliyor.
#[test]
fn game_instruction_discriminators_match_the_golden_vector() {
    use anchor_lang::InstructionData;

    let hex = |d: Vec<u8>| d.iter().map(|b| format!("{b:02x}")).collect::<String>();

    // buy_spins(tier_index: u8)
    let buy = hex(luck_game::instruction::BuySpins { tier_index: 3 }.data());
    println!("buy_spins    : {buy}");
    assert_eq!(&buy[0..16], "1e71e289a75d2984", "buy_spins ayırıcısı değişti");
    assert_eq!(buy, "1e71e289a75d298403", "buy_spins verisi değişti (u8 tier)");

    let registration = hex(luck_game::instruction::RegisterDelegate {}.data());
    println!("register     : {registration}");
    assert_eq!(registration, "da2d0c21c35959d0", "register_delegate ayırıcısı değişti");

    let play = hex(luck_game::instruction::Play {}.data());
    println!("play         : {play}");
    assert_eq!(play, "d59dc18ee438f896", "play ayırıcısı değişti");

    let decode = hex(luck_game::instruction::Resolve {}.data());
    println!("resolve      : {decode}");
    assert_eq!(decode, "f696ecce6c3f3a0a", "resolve ayırıcısı değişti");

    let forfeit = hex(luck_game::instruction::ForfeitStuckPlay {}.data());
    println!("forfeit      : {forfeit}");
    assert_eq!(forfeit, "46f69baf8c6f6989", "forfeit_stuck_play ayırıcısı değişti");
}

/// OLAYLARIN BAYT DÜZENİ de ABI'nin bir parçası — ve en sessiz kayan yeri.
///
/// Oyunun sonucunu site zincirden OKUMUYOR; işlemin loglarındaki
/// `PlayResolved` olayını ayrıştırıyor (parsePlayResolvedFromTx). Olayın
/// field SIRASI değişirse — araya bir field eklemek yeter — TypeScript
/// tarafı aynı ofsetlerden okumaya devam eder ve hiçbir hata vermeden
/// YANLIŞ değerleri gösterir: kaybeden tura "kazandın", 0,5 SOL ödüle
/// başka bir rakam. İşlem reddedilmediği için ne zincirde ne logda bir
/// iz kalır.
///
/// Bu yüzden üç olayın da tam baytlarını sabitliyoruz. Vektörler
/// programın çıktısı KOPYALANARAK değil, Anchor'ın kurallarından bağımsız
/// olarak türetildi:
///   ayırıcı = sha256("event:<İsim>")[0..8]
///   gövde   = Borsh: alanlar sırayla, sayılar little-endian, bool = 1 bayt
///
/// Aynı vektörler scripts/check-abi.mjs içinde SİTENİN GERÇEK
/// ayrıştırıcılarına verilip geri okunuyor — yani iki taraf da aynı
/// bağımsız gerçeğe bağlanmış oluyor.
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
        "PlayResolved olayının bayt düzeni değişti — site sonucu YANLIŞ okur"
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
        "PlayCommitted olayının bayt düzeni değişti"
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
        "SpinsPurchased olayının bayt düzeni değişti"
    );
}

/// Hesap ayırıcıları da sabit: istemci zincirden okuduğu hesabın gerçekten
/// beklediği tip olduğunu bu 8 baytla doğruluyor. Kayarsa istemci
/// "yapılandırılmamış" der ve oyun hiç açılmaz.
#[test]
fn account_discriminators_match_the_golden_vector() {
    use anchor_lang::Discriminator;

    let hex = |d: &[u8]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(
        hex(&luck_game::GameConfig::discriminator()),
        "2d929221aa456085",
        "GameConfig hesap ayırıcısı değişti"
    );
    assert_eq!(
        hex(&luck_game::PlayerState::discriminator()),
        "38033c56ae10f4c3",
        "PlayerState hesap ayırıcısı değişti"
    );
}

/// ZARIN ALTIN VEKTÖRÜ — belge ile kod aynı şeyi mi söylüyor.
///
/// GUVENLIK.md, oyuncuların sonucu kendi başlarına doğrulayabilmesi için
/// zarın nasıl üretildiğini anlatıyor. O tarif yanlışsa belge işe yaramaz
/// olmaktan da kötüsü ZARARLI olur: doğrulamaya çalışan kişi farklı bir sayı
/// bulur ve "oyun hileli" sonucuna varır.
///
/// Nitekim tarif YANLIŞTI — belgede keccak yazıyordu, oysa program
/// `solana_program::hash::hash` yani SHA-256 kullanıyor. (Dağıtıcı merkle
/// ağacında gerçekten keccak kullanıyor; ikisi karıştırılmış.) Dışarıdan
/// bakan biri farkı gördü.
///
/// Bu test o tarifi koda bağlıyor. Aynı vektör scripts/check-abi.mjs
/// içinde JS tarafında da üretiliyor.
#[test]
fn golden_dice_vector() {
    let mut preimage = Vec::with_capacity(76);
    preimage.extend_from_slice(&(0u8..32).collect::<Vec<u8>>()); // slot_hash
    preimage.extend_from_slice(&488_699_073u64.to_le_bytes()); // entropy_slot
    preimage.extend_from_slice(&[7u8; 32]); // player
    preimage.extend_from_slice(&5u32.to_le_bytes()); // plays_count
    assert_eq!(preimage.len(), 76, "preimage düzeni değişti");

    // Programın resolve()'da kullandığı hash fonksiyonunun AYNISI.
    let digest = anchor_lang::solana_program::hash::hash(&preimage).to_bytes();
    let hex = digest.iter().map(|b| format!("{b:02x}")).collect::<String>();
    println!("digest: {hex}");
    assert_eq!(
        hex, "3d54d1715c5d05dcfc12bb5dd95b197b078f3135b04aab6ead91103c1233cc6d",
        "dice hash'i değişti — GUVENLIK.md'deki tarif artık yanlış"
    );

    let dice = u64::from_le_bytes(digest[0..8].try_into().unwrap()) % 10_000;
    let tier = u64::from_le_bytes(digest[8..16].try_into().unwrap()) % 10_000;
    assert_eq!(dice, 7_597, "dice türetimi değişti");
    assert_eq!(tier, 4_556, "tier zarı türetimi değişti");
}

/// Ücretsiz haklarını kullanmadan ÖNCE package field player da bonus spin'i
/// alabilmeli.
///
/// Eskiden alamıyordu ve bu bir eşitlik hatasıydı: koşul
/// `plays_count == free_plays` idi, ama satın alınan spinler de aynı
/// bakiyeye eklendiği için bakiye 3'te değil 4'te sıfırlanıyor ve eşitlik
/// hiç tutmuyordu. Yani "önce package al" davranışı bonusu sessizce yakıyordu.
#[tokio::test]
async fn the_bonus_is_granted_even_if_a_package_was_bought_first() {
    let mut g = Game::start_with(50 * SOL, NORMAL_WIN_BPS, EASY_WIN_BPS, 3).await;
    let o = Keypair::new();
    let d = Keypair::new();
    fund(&mut g.ctx, &o.pubkey(), 20 * SOL).await;
    let k = o.pubkey();

    // ÖNCE 1 spinlik paketi al, SONRA play: toplam 1 + 3 = 4 spin.
    let ix = g.buy_spins_ix(&k, &d.pubkey(), 0);
    g.send(&[ix], &[&o]).await.unwrap();

    let mut slot = g.slot().await.max(1_000) + 100;
    for _ in 0..4 {
        g.warp(slot);
        slot += 20;
        let ix = g.play_ix(&k, &k);
        g.send(&[ix], &[&o]).await.unwrap();
        // Sonuçlandırmadan tekrar oynanamaz; pencereyi geçip iptal ediyoruz.
        slot += MAX_RESOLVE_WINDOW_SLOTS_TEST + REVEAL_DELAY + 10;
        g.warp(slot);
        slot += 20;
        let ix = g.forfeit_ix(&k);
        g.send(&[ix], &[&o]).await.unwrap();
    }

    let s = g.player_state(&k).await.unwrap();
    assert_eq!(s.plays_count, 4, "4 spin oynanmalıydı");
    assert!(
        s.bonus_granted,
        "önce package field player bonus spin'i alamadı — eşitlik hatası geri gelmiş"
    );
    assert_eq!(s.spins_remaining, 1, "bonus spin bakiyeye eklenmedi");
}

/// Ücretsiz hak YOKKEN kimse bonus almamalı.
///
/// Bonus koşulu eşitlikten ">="e çevrildi; `free_plays > 0` şartı olmasaydı
/// bu değişiklik HERKESE ilk oyunundan sonra bedava bir spin verirdi.
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
    assert!(!s.bonus_granted, "ücretsiz hak yokken bonus verilmiş");
    assert_eq!(s.spins_remaining, 0, "bedava spin eklenmiş");
}

/// YETKİLİ, BEKLEYEN BİR BAHSİN KURALLARINI DEĞİŞTİREMEZ.
///
/// Bu, doğrulanabilir adalet iddiasının temel taşı. Oyuncu bahsini
/// koyduğunda oranlar donuyor; `update_config` sonradan ne yaparsa yapsın o
/// bahis ilk kurallarla sonuçlanıyor.
///
/// Eskiden böyle DEĞİLDİ: `resolve()` güncel config'i okuyordu, yani
/// yetkili bekleyen bir bahsi gördükten sonra kazanma oranını sıfıra
/// çekebilirdi. Kodu dışarıdan inceleyen biri bu tasarım riskini işaret
/// etti; yayın öncesinde kapatıldı.
///
/// Test şöyle kuruyor: oranlar %100 (her tur kazanır) iken player oynuyor,
/// SONRA yetkili oranı %0'a çekiyor. Bahis yine de KAZANMALI.
#[tokio::test]
async fn the_authority_cannot_change_the_odds_of_a_pending_bet() {
    // Her tur kazansın: normal ve kolay mod %100.
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

    // --- BAHİS KOYULDU. Şimdi yetkili oranı SIFIRA çekiyor. ---
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
            normal_win_bps: 0, // <-- kimse kazanamasın
            easy_win_bps: 0,   // <--
            treasury_fee_bps: TREASURY_FEE_BPS,
            spin_tier_counts: TIER_COUNTS,
            spin_tier_prices: TIER_PRICES,
        }),
    };
    let auth = g.authority.insecure_clone();
    g.send(&[ix], &[&auth]).await.unwrap();

    // --- Bekleyen bahis sonuçlansın. ---
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
        "bahis koyulduğunda oran %100'dü ama yetkili sonradan %0 yapınca tur \
         kaybedildi — bekleyen bahis korunmuyor"
    );
    assert!(s.total_won_lamports > 0, "kazanç ödenmemiş");
    assert!(!s.pending, "resolve sonrası hâlâ bekliyor");
}

/// PlayerState'in TAM BAYT DÜZENİ.
///
/// Bu hesabı site sabit ofsetlerle okuyor (decodePlayerState). Araya bir
/// field eklemek yeter: TypeScript aynı ofsetlerden okumaya devam eder ve
/// hiçbir hata vermeden yanlış spin sayısı, yanlış kazanç gösterir.
///
/// Düzen az önce genişledi (bahis anındaki kurallar eklendi). Yeni alanlar
/// bilerek SONA eklendi ki mevcut ofsetler kaymasın; bu vektör de bunu
/// kanıtlıyor. Aynı bytes scripts/check-abi.mjs içinde SİTENİN GERÇEK
/// okuyucusuna verilip geri okunuyor.
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
        "PlayerState::LEN gerçek boyutla uyuşmuyor — hesap ya taşar ya yer israf eder"
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
        "PlayerState bayt düzeni değişti — site YANLIŞ okur"
    );
}
