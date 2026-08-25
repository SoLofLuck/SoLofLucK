// ---------------------------------------------------------------------------
// luck-distributor senaryoları
// ---------------------------------------------------------------------------
// TGE günü bu programa 271 milyon token kilitlenecek ve düzeltme şansı
// olmayacak. Buradaki testler o yüzden "mutlu yol"u değil, esas olarak
// PARANIN KAYBOLABİLECEĞİ ya da FAZLA DAĞITILABİLECEĞİ durumları hedefliyor:
// takvimin %100'e ulaşmaması, çifte çekim, başkasının payını çekme, sahte
// kanıt, yuvarlamadan artan toz.
mod common;

use common::*;
use solana_sdk::{
    signature::{Keypair, Signer},
    signer::signers::Signers,
};

const TGE: i64 = 1_800_000_000; // sabit, gerçekçi bir gelecek zaman damgası

/// Presale turunu kurar, kasayı fonlar ve (alıcı, miktar) listesini döndürür.
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

/// Alıcıya işlem ücreti için biraz SOL verir — claim, kendi ATA'sını ve
/// claim_status hesabını açtığı için kira ödemek zorunda.
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
/// Takvim tam bittiğinde alıcı payının SON KURUŞUNU alabiliyor mu?
/// Yuvarlama yüzünden birkaç birim kasada kalsaydı, kimse fark etmeden
/// tokenler sonsuza kadar kilitlenirdi.
#[tokio::test]
async fn full_schedule_pays_exactly_total() {
    let mut ctx = program_test().start_with_context().await;
    let alice = Keypair::new();
    // 7 ile bölünmeyen, yuvarlamayı zorlayan bir sayı.
    let amount = 271_950_137u64;
    let allocs = vec![(alice.insecure_clone(), amount)];
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, CLIFF_BPS, PERIOD_BPS, PERIODS).await;
    fund(&mut ctx, &alice).await;

    set_time(&mut ctx, TGE + WEEK * (PERIODS as i64)).await;
    claim(&mut ctx, &alice, &mint, amount, tree.proof(0)).await.unwrap();

    assert_eq!(token_balance(&mut ctx, &ata(&alice.pubkey(), &mint)).await, amount);
    let (distributor, _) = distributor_pda(&mint, 0);
    let (vault, _) = vault_pda(&distributor);
    assert_eq!(token_balance(&mut ctx, &vault).await, 0, "kasada toz kalmamalı");
}

// -- 2 ----------------------------------------------------------------------
/// TGE'den önce hiçbir şey çekilemez.
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
/// TGE anında tam %9 açılıyor mu?
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
/// Her hafta ayrı ayrı çekmekle sonda tek seferde çekmek AYNI toplamı
/// vermeli. Aksi halde "erken çeken kaybeder" gibi sinsi bir hata olurdu.
#[tokio::test]
async fn weekly_claims_equal_single_final_claim() {
    let amount = 271_950_137u64;

    // (a) her hafta çeken
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

    // (b) yalnızca sonda çeken
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
/// Aynı hafta içinde ikinci kez çekmek boşa çıkmalı (çifte ödeme yok).
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
/// Hak ettiğinden fazlasını yazmak kanıtı geçersiz kılmalı.
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
/// Başkasının payını, onun kanıtıyla kendi cüzdanına çekmeye çalışmak.
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
    // Alice'in kanıtı + Alice'in miktarı, ama imzayı Mallory atıyor.
    assert!(claim(&mut ctx, &mallory, &mint, 5_000_000, tree.proof(0)).await.is_err());
}

// -- 8 ----------------------------------------------------------------------
/// Uydurma kanıt.
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
/// Çekiliş turu: vesting yok, tamamı anında.
#[tokio::test]
async fn raffle_round_pays_in_full_immediately() {
    let mut ctx = program_test().start_with_context().await;
    let winner = Keypair::new();
    let prize = 1_110_000u64;
    let allocs = vec![(winner.insecure_clone(), prize)];
    // cliff %100, kademe yok — çekiliş turu bundan ibaret.
    let (mint, _, tree, _) = setup_presale(&mut ctx, &allocs, 10_000, 0, 0).await;
    fund(&mut ctx, &winner).await;

    set_time(&mut ctx, TGE).await;
    claim(&mut ctx, &winner, &mint, prize, tree.proof(0)).await.unwrap();
    assert_eq!(token_balance(&mut ctx, &ata(&winner.pubkey(), &mint)).await, prize);
}

// -- 10 ---------------------------------------------------------------------
/// %100'e ulaşmayan takvim baştan reddedilmeli. Bu kontrol olmasaydı
/// %7 × 14 = %98 gibi bir yapılandırma sessizce kabul edilir ve alıcıların
/// son %2'si sonsuza kadar kilitli kalırdı.
#[tokio::test]
async fn incomplete_schedule_rejected() {
    let mut ctx = program_test().start_with_context().await;
    let mint_authority = Keypair::new();
    let mint = create_mint(&mut ctx, &mint_authority.pubkey()).await;
    let alice = Keypair::new();
    let tree = MerkleTree::new(vec![leaf_hash(&alice.pubkey(), 1_000)]);

    // %7 × 14 = %98 — eksik.
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
    assert!(res.is_err(), "eksik takvim kabul edilmemeli");
}

// -- 11 ---------------------------------------------------------------------
/// Çok alıcılı tur: herkes payını çektiğinde kasa TAM olarak boşalmalı —
/// ne eksik ne fazla.
#[tokio::test]
async fn many_buyers_drain_vault_exactly() {
    let mut ctx = program_test().start_with_context().await;
    // Kasıtlı olarak düzensiz, 7'ye bölünmeyen miktarlar.
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
    assert_eq!(token_balance(&mut ctx, &vault).await, 0, "kasa tam boşalmalı");
    assert_eq!(total, amounts.iter().sum::<u64>());
}

// -- 12 ---------------------------------------------------------------------
/// JAVASCRIPT ÜRETİCİSİ İLE RUST DOĞRULAYICISI AYNI AĞACI Mİ ÜRETİYOR?
///
/// Kanıtları siteye `scripts/build-merkle.mjs` üretecek, doğrulamayı ise bu
/// program yapacak. İki uygulama arasında tek baytlık bir fark bile TGE günü
/// HERKESİN kanıtının reddedilmesi demek — ve o noktada düzeltme şansı yok
/// (kök değiştirilemiyor). Bu yüzden sabit girdilerle üretilmiş kökü buraya
/// çakıyoruz: iki taraftan biri değişirse test düşer, üretimde değil.
///
/// Beklenen değer `node scripts/build-merkle.mjs --selftest` çıktısıdır.
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
        "JS üreticisi ile Rust doğrulayıcısı farklı kök üretiyor — \
         scripts/build-merkle.mjs ile lib.rs'teki hash mantığı ayrışmış olabilir"
    );
}

// -- 13 ---------------------------------------------------------------------
/// Üretici ile doğrulayıcı arasındaki UÇTAN UCA kontrol.
///
/// Test 12 yalnızca köklerin eşitliğine bakıyordu; bu test bir adım öteye
/// gidiyor: `scripts/build-merkle.mjs`'in ürettiği GERÇEK kanıt baytlarını,
/// programın KENDİ `verify_proof` fonksiyonuna veriyor. Yani üretimde
/// çalışacak iki kod parçası birbirine burada, TGE'den önce bağlanıyor.
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

    // node scripts/build-merkle.mjs --selftest çıktısından, index 1.
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

    // Programın KENDİ yaprak hash'i ve KENDİ doğrulayıcısı.
    let leaf = luck_distributor::leaf_hash(&claimant, amount);
    assert!(
        luck_distributor::verify_proof(&proof, root, leaf),
        "program, JS üreticisinin kanıtını reddetti — iki taraf ayrışmış"
    );

    // Miktar bir birim bile oynarsa kanıt geçersiz olmalı.
    let tampered = luck_distributor::leaf_hash(&claimant, amount + 1);
    assert!(!luck_distributor::verify_proof(&proof, root, tampered));

    // Başka bir adres için de geçersiz olmalı.
    let other = solana_sdk::pubkey::Pubkey::new_unique();
    assert!(!luck_distributor::verify_proof(
        &proof,
        root,
        luck_distributor::leaf_hash(&other, amount)
    ));
}
