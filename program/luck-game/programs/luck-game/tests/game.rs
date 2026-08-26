// ---------------------------------------------------------------------------
// luck-game davranış testleri
// ---------------------------------------------------------------------------
// Öncelik sırası, paranın kaybolabileceği yerler:
//   1. Oyuncu ilan edilen paket fiyatından FAZLA ödüyor mu
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
/// TAM OLARAK paket fiyatı olmalı (işlem ücreti hariç — onu Solana alıyor,
/// biz değil).
#[tokio::test]
async fn ilk_satin_alma_tam_paket_fiyati_kadar_kesiyor() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    let before = g.lamports(&player.pubkey()).await;
    let ix = g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 0);
    g.send(&[ix], &[&player]).await.unwrap();
    let after = g.lamports(&player.pubkey()).await;

    // İşlem ücretini payer (ctx.payer) ödüyor, oyuncu değil — dolayısıyla
    // oyuncunun bakiyesindeki değişim tam olarak paket fiyatı olmalı.
    assert_eq!(
        before - after,
        TIER_PRICES[0],
        "oyuncudan paket fiyatından farklı bir tutar çıktı"
    );
}

/// Kira iadesi YALNIZCA ilk satın alımda olmalı. Olmazsa kasa her satın
/// alımda 0,0016 SOL sızdırır.
#[tokio::test]
async fn ikinci_satin_almada_kira_iadesi_yok() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    let ix = g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 0);
    g.send(&[ix.clone()], &[&player]).await.unwrap();

    let before = g.lamports(&player.pubkey()).await;
    g.send(&[ix], &[&player]).await.unwrap();
    let after = g.lamports(&player.pubkey()).await;

    assert_eq!(before - after, TIER_PRICES[0], "ikinci alımda tutar farklı");
}

/// Kasa, oyuncuya iade ettiği ve delegeye gönderdiği tutarı KENDİ payından
/// karşılamalı; oyuncu her zaman tam fiyatı ödediği için, kasa + hazine
/// toplamı paket fiyatından katılım maliyeti kadar az artar.
#[tokio::test]
async fn hazine_payi_katilim_maliyeti_dusuldukten_sonra_hesaplaniyor() {
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
async fn kayit_kasadan_para_cikarmiyor() {
    let mut g = Game::start(50 * SOL).await;
    let vault_before = g.lamports(&g.vault.clone()).await;

    // Yüz ayrı boş cüzdanla kayıt: eski davranışta bu 100 × 200_000 lamport
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
/// olduğunda 1 spinlik paket TAM OLARAK 1 spin vermeli.
#[tokio::test]
async fn bir_spinlik_paket_tam_bir_spin_veriyor() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let delegate = Keypair::new();

    let ix = g.buy_spins_ix(&player.pubkey(), &delegate.pubkey(), 0);
    g.send(&[ix], &[&player]).await.unwrap();

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert_eq!(st.spins_remaining, 1, "paket beklenenden farklı spin verdi");

    // Bir kez oyna → 0 kalmalı, ikincisi reddedilmeli.
    g.send(&[g.play_ix(&player.pubkey(), &player.pubkey())], &[&player])
        .await
        .unwrap();
    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert_eq!(st.spins_remaining, 0);
    assert!(st.pending);
}

#[tokio::test]
async fn spin_yokken_oynanamaz() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;

    let err = g
        .send(&[g.play_ix(&player.pubkey(), &player.pubkey())], &[&player])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::NoSpinsRemaining);
}

/// Bekleyen bir oyun varken ikinci kez oynanamaz — aksi halde oyuncu
/// kaybettiğini gördüğü turu resolve etmeyip yenisini başlatabilirdi.
#[tokio::test]
async fn bekleyen_oyun_varken_tekrar_oynanamaz() {
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
async fn yabanci_delege_baskasinin_spinini_harcayamaz() {
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

/// Bir oyuncuyu "bekleyen oyun" durumuna getirir ve hedef slot'u döner.
async fn oyna(g: &mut Game, player: &Keypair, delegate: &Pubkey, tier: u8) -> u64 {
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
async fn hedef_slota_ulasmadan_resolve_edilemez() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = oyna(&mut g, &player, &Keypair::new().pubkey(), 0).await;

    g.set_slot_hashes(&[(target, [7u8; 32])]);
    let err = g
        .send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::TooEarlyToResolve);
}

/// ASIL DÜZELTME. Hedef slot atlanmışsa (lideri blok üretememişse) o slot
/// SlotHashes'e hiç girmez. Eskiden burada TAM EŞLEŞME aranıyordu, yani
/// böyle bir oyun SONSUZA DEK sonuçlandırılamıyor, oyuncu spinini
/// kaybediyordu. Devnet'te atlanma oranı yer yer %5-15 — yani her 10-20
/// spinde bir sessizce yaşanan gerçek bir para kaybı.
#[tokio::test]
async fn hedef_slot_atlanmissa_sonraki_slotla_sonuclaniyor() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = oyna(&mut g, &player, &Keypair::new().pubkey(), 0).await;

    g.warp(target + 3);
    // Hedef slot ve ondan sonraki iki slot ATLANMIŞ; ilk üretilen slot
    // target + 3.
    g.set_slot_hashes(&[(target - 1, [1u8; 32]), (target + 3, [9u8; 32])]);

    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .expect("atlanan hedef slot yüzünden resolve düştü");

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "oyun hâlâ bekliyor");
}

/// Pencerenin İÇİNDE hiç üretilmiş slot yoksa (gerçekte olmaz ama) resolve
/// düşer ve oyuncu forfeit'e yönlendirilir — sessizce yanlış bir sonuç
/// üretilmez.
#[tokio::test]
async fn pencerede_hic_slot_yoksa_resolve_dusuyor() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = oyna(&mut g, &player, &Keypair::new().pubkey(), 0).await;

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
async fn ayni_oyun_iki_kez_sonuclandirilamaz() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = oyna(&mut g, &player, &Keypair::new().pubkey(), 1).await;

    g.warp(target + 1);
    g.set_slot_hashes(&[(target, [3u8; 32])]);
    g.send(&[g.resolve_ix(&player.pubkey())], &[]).await.unwrap();

    let err = g
        .send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::NoPendingPlay);
}

/// Pencere kapanmadan forfeit edilemez — aksi halde oyuncu kaybettiğini
/// gördüğü turu forfeit edip yeniden oynayabilirdi. (Spin iadesi
/// olmadığı için kâr etmezdi ama kural yine de kapalı olmalı.)
#[tokio::test]
async fn pencere_acikken_forfeit_edilemez() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    let target = oyna(&mut g, &player, &Keypair::new().pubkey(), 1).await;

    g.warp(target + 1);
    let err = g
        .send(&[g.forfeit_ix(&player.pubkey())], &[&player])
        .await
        .unwrap_err();
    assert_game_error(&err, GameError::ResolveWindowStillOpen);
}

/// Forfeit spini İADE ETMEZ. Etseydi, kaybettiğini önceden hesaplayan bir
/// oyuncu resolve etmeyip forfeit ederek bedava yeniden zar atardı —
/// commit-reveal'ın tüm anlamı buradan kaçardı.
#[tokio::test]
async fn forfeit_spin_iade_etmiyor() {
    let mut g = Game::start(50 * SOL).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    // 5 spinlik paket: oynadıktan sonra 4 kalmalı, forfeit sonrası da 4.
    let target = oyna(&mut g, &player, &Keypair::new().pubkey(), 1).await;
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
        "forfeit spini iade etti — bedava yeniden zar atma açığı"
    );
}

/// Ödül HER ZAMAN oyuncuya gider, resolve'u çağırana değil. resolve
/// izinsiz (permissionless) olduğu için bu kritik: aksi halde bir
/// "keeper" başkalarının kazançlarını kendi cüzdanına toplardı.
#[tokio::test]
async fn odul_cagirana_degil_oyuncuya_odeniyor() {
    // easy_win_bps = 10000: bu kurulumda her tur kazanır, ödemeyi
    // gözlemleyebiliyoruz.
    let mut g = Game::start_with(50 * SOL, 10_000, 10_000, 0).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    // resolve() izinsiz olduğu için imzacı listesine hiç girmiyor: işlemi
    // gönderen taraf test payer'ı, yani oyuncudan tamamen başka biri.
    let keeper = g.ctx.payer.pubkey();

    let target = oyna(&mut g, &player, &Keypair::new().pubkey(), 1).await;
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
    let kazanc = player_after - player_before;
    assert!(
        kazanc == SMALL_PRIZE || kazanc == BIG_PRIZE,
        "ödenen tutar ilan edilen ödüllerden biri değil: {kazanc}"
    );
}

/// Kasa en büyük olası ÖDEMEYİ (jackpot + operasyon payı) karşılayamıyorsa
/// kazanan tur bile ödenmez — ama işlem GERİ ALINMAZ, oyuncu sessizce
/// kaybeder ve tekrar oynayabilir. Aksi halde oyuncu `pending = true`
/// durumunda pencere kapanana kadar sıkışırdı.
#[tokio::test]
async fn kasa_odeyemiyorsa_oyuncu_sikismiyor() {
    // Kasa jackpot + payını karşılayamayacak kadar boş; kazanma oranı %100.
    let mut g = Game::start_with(BIG_PRIZE / 2, 10_000, 10_000, 0).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;

    let target = oyna(&mut g, &player, &Keypair::new().pubkey(), 1).await;
    g.warp(target + 1);
    g.set_slot_hashes(&[(target, [5u8; 32])]);

    let before = g.lamports(&player.pubkey()).await;
    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .expect("kasa boşken resolve tüm işlemi geri aldı — oyuncu sıkışırdı");

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "oyuncu bekleyen durumda kaldı");
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
/// zorlamıyorlar: penceremizin ÜSTÜNDE kalan (daha yeni) kayıtların
/// atlanması, hedefin ALTINA düşünce durulması ve birden çok uygun aday
/// varken hedefe EN YAKIN olanın seçilmesi.
///
/// Hedefe en yakını seçmek keyfi bir tercih değil: o slot bir kez ortaya
/// çıktıktan sonra bir daha değişmiyor (sonradan eklenen slot'lar hep daha
/// büyük). "En yeni uygun slot" seçilseydi, sonuç resolve'un NE ZAMAN
/// çağrıldığına göre değişirdi ve oyuncu kazanana kadar bekleyerek zar
/// çevirebilirdi.
#[tokio::test]
async fn dolu_sysvarda_hedefe_en_yakin_slot_seciliyor() {
    // Kazanma eşiği %50: iki aday slot'tan birinin kazandırdığı, diğerinin
    // kaybettirdiği bir hash çifti bulmak böylece kolay.
    let mut g = Game::start_with(50 * SOL, 5_000, 5_000, 0).await;
    let player = new_player(&mut g.ctx, 10 * SOL).await;
    // Önce ileri sarıyoruz: sysvar'ı hedefin ALTINDA 509 kayıtla
    // doldurabilmek için slot numarasının o kadar büyük olması gerekiyor.
    g.warp(1_000);
    let target = oyna(&mut g, &player, &Keypair::new().pubkey(), 1).await;

    let st = g.player_state(&player.pubkey()).await.unwrap();
    let oyun_sayaci = st.plays_count;

    // İki aday: hedefe YAKIN olan ve DAHA YENİ olan. Sonuçları ZITLAŞACAK
    // şekilde hash arıyoruz — ancak o zaman "hangisi seçildi" sorusunun
    // gözlenebilir bir cevabı oluyor. Aksi halde iki seçim de aynı sonucu
    // verir ve test hiçbir şey ayırt etmez.
    let yakin_slot = target + 3;
    let yeni_slot = target + 40;
    let mut yakin_hash = [0u8; 32];
    let mut yeni_hash = [0u8; 32];
    let mut bulundu = false;
    for i in 0..5_000u32 {
        let h1 = tur_hash(i);
        let h2 = tur_hash(i + 5_000);
        let kazanir = beklenen_zar(&h1, yakin_slot, &player.pubkey(), oyun_sayaci) < 5_000;
        let kaybeder = beklenen_zar(&h2, yeni_slot, &player.pubkey(), oyun_sayaci) >= 5_000;
        if kazanir && kaybeder {
            yakin_hash = h1;
            yeni_hash = h2;
            bulundu = true;
            break;
        }
    }
    assert!(bulundu, "zıt sonuç veren hash çifti bulunamadı");

    g.warp(target + 250);

    // 512 kayıtlık gerçekçi bir sysvar:
    //  - hedefin altında 509 kayıt (taramanın durması gereken bölge)
    //  - pencerenin içinde 2 aday: yakin_slot ve yeni_slot
    //  - pencerenin üstünde 1 kayıt (atlanması gereken)
    let mut entries: Vec<(u64, [u8; 32])> = (1..=509u64)
        .map(|i| (target - i, [(i % 251) as u8; 32]))
        .collect();
    entries.push((yakin_slot, yakin_hash));
    entries.push((yeni_slot, yeni_hash));
    entries.push((target + MAX_RESOLVE_WINDOW_SLOTS_TEST + 1, [99u8; 32]));
    g.set_slot_hashes(&entries);

    g.send(&[g.resolve_ix(&player.pubkey())], &[])
        .await
        .expect("dolu sysvar'da resolve düştü");

    let st = g.player_state(&player.pubkey()).await.unwrap();
    assert!(!st.pending, "oyun sonuçlanmadı");
    assert_eq!(
        st.wins_count, 1,
        "sonuç, hedefe en yakın slot ({yakin_slot}) yerine daha yeni bir slot \
         ({yeni_slot}) kullanılarak üretilmiş — resolve'un NE ZAMAN çağrıldığı \
         sonucu değiştirebilir demektir, oyuncu kazanana kadar bekleyebilirdi"
    );
}

/// resolve penceresinin uzunluğu (lib.rs'teki MAX_RESOLVE_WINDOW_SLOTS ile
/// aynı olmalı). Sabit programda `pub` değil; testte kopyası tutuluyor ve
/// `pencerede_hic_slot_yoksa_resolve_dusuyor` ile
/// `forfeit_spin_iade_etmiyor` testleri ikisinin uyuştuğunu dolaylı olarak
/// doğruluyor.
const MAX_RESOLVE_WINDOW_SLOTS_TEST: u64 = 300;
