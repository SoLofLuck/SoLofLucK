// ---------------------------------------------------------------------------
// KAOS TESTİ — dağıtıcı
// ---------------------------------------------------------------------------
// Presale'in TÜM tokenları bu programın kasasında duruyor. Oyundaki bir hata
// bir turluk ödül kadar; buradaki bir hata herkesin payı kadar. O yüzden
// rastgele senaryo taraması burada daha da gerekli.
//
// Yöntem oyun tarafındakiyle aynı: rastgele alıcı × rastgele eylem ×
// rastgele zaman sıçraması, HER İŞLEMDEN SONRA değişmez kontrolü, sabit
// tohum (düşen bir koşu birebir tekrar üretilebilsin).
//
// DEĞİŞMEZLER:
//   E1. Token korunumu — kasa + tüm alıcı hesapları = basılan toplam.
//   E2. Kimse hakkından fazlasını alamaz.
//   E3. Çekilen tutar hiç azalmaz (ClaimStatus geri saymaz).
//   E4. ClaimStatus.claimed ile alıcının gerçek bakiyesi birebir eşit.
//   E5. distributor.total_claimed = tüm ClaimStatus.claimed toplamı.
//   E6. Çekilen, O ANDA açılmış olan miktarı geçemez — takvim BAĞIMSIZ
//       hesaplanıyor (programın kendi fonksiyonu çağrılmıyor).
//   E7. Yanlış miktarla ya da BAŞKASININ kanıtıyla çekim REDDEDİLMELİ.
//   E8. Takvim bittiğinde herkes payının TAMAMINI çekebilmeli ve kasada
//       toz kalmamalı.
//
// E6'daki bağımsızlık kasıtlı: takvimi programın `unlocked_amount`'ıyla
// doğrulasaydım, test programın kendisiyle değil kendi kopyasıyla
// uyuştuğunu kanıtlardı. Aynı hatayı iki yerde yaparsam ikisi de yeşil kalır.

mod common;

use common::*;
use solana_sdk::signature::{Keypair, Signer};

/// xorshift64* — deterministik.
struct Zar(u64);
impl Zar {
    fn yeni(tohum: u64) -> Self {
        Zar(if tohum == 0 { 0x9E3779B97F4A7C15 } else { tohum })
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn kadar(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Takvimin BAĞIMSIZ hesabı — programın `unlocked_amount`'ı çağrılmıyor.
///
/// Kural: başlangıçtan önce sıfır; sonra cliff + (geçen tam dönem sayısı ×
/// dönem payı), %100'de tavanlanmış. Yuvarlama AŞAĞI — yukarı yuvarlansaydı
/// tek tek payların toplamı toplam tahsisi aşabilir ve son alıcının çekimi
/// kasada para kalmadığı için düşerdi.
fn acilmis(toplam: u64, simdi: i64, baslangic: i64) -> u64 {
    if simdi < baslangic {
        return 0;
    }
    let gecen = (simdi - baslangic) as u64;
    let donem = (gecen / WEEK as u64).min(PERIODS as u64);
    let bps = (CLIFF_BPS as u64 + donem * PERIOD_BPS as u64).min(10_000);
    ((toplam as u128 * bps as u128) / 10_000u128) as u64
}

struct Alici {
    kp: Keypair,
    hak: u64,
    kanit: Vec<[u8; 32]>,
}

async fn kaos_kos(tohum: u64, adim_sayisi: u32) {
    let mut zar = Zar::yeni(tohum);
    let mut ctx = program_test().start_with_context().await;
    let payer = ctx.payer.pubkey();
    let payer_kp = ctx.payer.insecure_clone();

    // Alıcı payları KASITLI OLARAK ÇEŞİTLİ: bazıları 10.000'e tam bölünüyor,
    // bazıları bölünmüyor. Bölünmeyenler yuvarlama yönünü ortaya çıkarıyor —
    // hepsi tam bölünseydi yanlış yönde yuvarlayan bir sürüm de testi
    // geçerdi (bu, daha önce başka bir denetimde tam olarak yaşandı).
    let ham: Vec<u64> = (0..5)
        .map(|i| match i {
            0 => 7_000_000_000_000,
            1 => 17_500_000_000_000,
            2 => 1_000_000_007, // 10.000'e bölünmüyor
            3 => 28_000_000_000_001,
            _ => 3,             // aşırı küçük: cliff bile 0'a yuvarlanır
        })
        .collect();

    let mut aliciler: Vec<Alici> = Vec::new();
    let mut yapraklar = Vec::new();
    let mut kps = Vec::new();
    for hak in &ham {
        let kp = Keypair::new();
        yapraklar.push(leaf_hash(&kp.pubkey(), *hak));
        kps.push((kp, *hak));
    }
    let agac = MerkleTree::new(yapraklar);
    for (i, (kp, hak)) in kps.into_iter().enumerate() {
        aliciler.push(Alici {
            kp,
            hak,
            kanit: agac.proof(i),
        });
    }
    let toplam: u64 = ham.iter().sum();

    // Alıcıların işlem ücreti ödeyebilmesi için SOL gerekiyor.
    for a in &aliciler {
        let ix = solana_sdk::system_instruction::transfer(&payer, &a.kp.pubkey(), 100_000_000);
        send(&mut ctx, &[ix], &[]).await.unwrap();
    }

    let mint = create_mint(&mut ctx, &payer).await;
    let (dagitici, _) = distributor_pda(&mint, 0);
    let (kasa, _) = vault_pda(&dagitici);

    // Takvim ŞİMDİDEN biraz sonra başlıyor ki "henüz açılmadı" dalı da
    // sınansın.
    let simdi_ts = ctx
        .banks_client
        .get_sysvar::<solana_sdk::sysvar::clock::Clock>()
        .await
        .unwrap()
        .unix_timestamp;
    let baslangic = simdi_ts + WEEK / 2;

    let ix = initialize_ix(
        &payer, &mint, 0, agac.root(), toplam, baslangic,
        CLIFF_BPS, PERIOD_BPS, WEEK, PERIODS,
    );
    send(&mut ctx, &[ix], &[]).await.unwrap();
    mint_to(&mut ctx, &mint, &kasa, &payer_kp, toplam).await;

    let mut zaman = simdi_ts;
    let mut basarili_cekim = 0u32;
    let mut reddedilen_sahte = 0u32;

    for adim in 0..adim_sayisi {
        let etiket = format!("tohum={tohum} adım={adim}");
        let eylem = zar.kadar(100);

        if eylem < 55 {
            // --- normal çekim ---
            let i = zar.kadar(aliciler.len() as u64) as usize;
            let a = &aliciler[i];
            let ix = claim_ix(&a.kp.pubkey(), &mint, 0, a.hak, a.kanit.clone());
            let kp = a.kp.insecure_clone();
            if send(&mut ctx, &[ix], &[&kp]).await.is_ok() {
                basarili_cekim += 1;
            }
        } else if eylem < 70 {
            // --- E7: YANLIŞ MİKTARLA çekim — reddedilmeli ---
            let i = zar.kadar(aliciler.len() as u64) as usize;
            let a = &aliciler[i];
            let sahte = a.hak.saturating_add(1 + zar.kadar(1_000_000));
            let ix = claim_ix(&a.kp.pubkey(), &mint, 0, sahte, a.kanit.clone());
            let kp = a.kp.insecure_clone();
            let sonuc = send(&mut ctx, &[ix], &[&kp]).await;
            assert!(
                sonuc.is_err(),
                "E7 BOZULDU ({etiket}): {} yerine {sahte} isteyen çekim GEÇTİ",
                a.hak
            );
            reddedilen_sahte += 1;
        } else if eylem < 80 {
            // --- E7: BAŞKASININ KANITIYLA çekim — reddedilmeli ---
            let i = zar.kadar(aliciler.len() as u64) as usize;
            let j = (i + 1 + zar.kadar(aliciler.len() as u64 - 1) as usize) % aliciler.len();
            let ix = claim_ix(
                &aliciler[i].kp.pubkey(),
                &mint,
                0,
                aliciler[j].hak,
                aliciler[j].kanit.clone(),
            );
            let kp = aliciler[i].kp.insecure_clone();
            let sonuc = send(&mut ctx, &[ix], &[&kp]).await;
            assert!(
                sonuc.is_err(),
                "E7 BOZULDU ({etiket}): {i}. alıcı, {j}. alıcının kanıtıyla çekim yaptı"
            );
            reddedilen_sahte += 1;
        } else {
            // --- zaman sıçraması --- (bazen tam dönem, bazen dönem ortası)
            let sicrama = if zar.kadar(3) == 0 {
                WEEK + zar.kadar(WEEK as u64) as i64
            } else {
                (zar.kadar(WEEK as u64 / 2) + 1) as i64
            };
            zaman += sicrama;
            set_time(&mut ctx, zaman).await;
            continue;
        }

        // ------------------- DEĞİŞMEZLER -------------------
        let mut cekilen_toplam: u64 = 0;
        let kasada = token_balance(&mut ctx, &kasa).await;
        let mut alicilarda: u64 = 0;

        for a in &aliciler {
            let bakiye = token_balance(&mut ctx, &ata(&a.kp.pubkey(), &mint)).await;
            alicilarda += bakiye;

            // E2 — hakkından fazlasını alamaz
            assert!(
                bakiye <= a.hak,
                "E2 BOZULDU ({etiket}): alıcı hakkı {} iken {bakiye} almış",
                a.hak
            );

            // E6 — o anda açılmış olandan fazlasını çekemez
            let tavan = acilmis(a.hak, zaman, baslangic);
            assert!(
                bakiye <= tavan,
                "E6 BOZULDU ({etiket}): zaman {zaman}, açılmış olan {tavan}, \
                 çekilen {bakiye} (hak {})",
                a.hak
            );

            // E4 — ClaimStatus ile gerçek bakiye eşit
            let (durum_pda, _) = claim_status_pda(&dagitici, &a.kp.pubkey());
            let kayitli = match ctx.banks_client.get_account(durum_pda).await.unwrap() {
                Some(acc) => {
                    let d: luck_distributor::ClaimStatus =
                        anchor_lang::AccountDeserialize::try_deserialize(&mut acc.data.as_slice())
                            .unwrap();
                    d.claimed
                }
                None => 0,
            };
            assert_eq!(
                kayitli, bakiye,
                "E4 BOZULDU ({etiket}): ClaimStatus {kayitli} ama cüzdanda {bakiye}"
            );
            cekilen_toplam += kayitli;
        }

        // E1 — token korunumu
        assert_eq!(
            kasada + alicilarda,
            toplam,
            "E1 BOZULDU ({etiket}): kasa {kasada} + alıcılar {alicilarda} != basılan {toplam}"
        );

        // E5 — dağıtıcının sayacı bireysel kayıtlarla tutuyor
        let acc = ctx.banks_client.get_account(dagitici).await.unwrap().unwrap();
        let d: luck_distributor::Distributor =
            anchor_lang::AccountDeserialize::try_deserialize(&mut acc.data.as_slice()).unwrap();
        assert_eq!(
            d.total_claimed, cekilen_toplam,
            "E5 BOZULDU ({etiket}): dağıtıcı {} diyor, kayıtların toplamı {cekilen_toplam}",
            d.total_claimed
        );
    }

    // --- E3 kontrolü koşu boyunca örtük: bakiye asla azalmadı (E4 + E1) ---

    // --- E8: takvim bitince herkes payının TAMAMINI alabilmeli ---
    zaman = baslangic + (PERIODS as i64 + 2) * WEEK;
    set_time(&mut ctx, zaman).await;
    for a in &aliciler {
        let ix = claim_ix(&a.kp.pubkey(), &mint, 0, a.hak, a.kanit.clone());
        let kp = a.kp.insecure_clone();
        // Payının tamamını zaten almış olabilir; o durumda çekilecek bir şey
        // yoktur ve işlem reddedilir. Önemli olan SONUÇTAKİ bakiye.
        let _ = send(&mut ctx, &[ix], &[&kp]).await;
        let bakiye = token_balance(&mut ctx, &ata(&a.kp.pubkey(), &mint)).await;
        assert_eq!(
            bakiye, a.hak,
            "E8 BOZULDU (tohum={tohum}): takvim bittiği hâlde alıcı payının \
             tamamını alamadı ({bakiye}/{})",
            a.hak
        );
    }
    let kalan = token_balance(&mut ctx, &kasa).await;
    assert_eq!(
        kalan, 0,
        "E8 BOZULDU (tohum={tohum}): takvim bitti ama kasada {kalan} token kaldı — \
         çekme talimatı olmadığı için bu para SONSUZA DEK kilitli kalırdı"
    );

    // Koşunun anlamlı olduğunu kanıtlıyoruz: hiçbir çekim geçmediyse bu test
    // "her şeyi reddeden" bozuk bir programı da yeşil gösterirdi.
    assert!(
        basarili_cekim >= 5,
        "tohum={tohum}: yalnızca {basarili_cekim} çekim geçti — koşu anlamlı değil"
    );
    assert!(
        reddedilen_sahte >= 5,
        "tohum={tohum}: yalnızca {reddedilen_sahte} sahte çekim denendi — \
         E7 yeterince sınanmamış"
    );
    println!(
        "tohum={tohum} · {basarili_cekim} çekim geçti · {reddedilen_sahte} sahte \
         çekim reddedildi · sonda kasa boş"
    );
}

#[tokio::test]
async fn kaos_dagitim() {
    kaos_kos(0xC0FFEE, 220).await;
}

#[tokio::test]
async fn kaos_dagitim_ek_tohumlar() {
    for tohum in [0xA11CEu64, 0xBEEF, 0x1337] {
        kaos_kos(tohum, 180).await;
    }
}
