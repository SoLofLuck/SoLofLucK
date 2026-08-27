// ---------------------------------------------------------------------------
// KAOS TESTİ — rastgele senaryo dizileri + her adımda değişmez kontrolü
// ---------------------------------------------------------------------------
// Diğer testler BİLDİĞİM senaryoları sınıyor. Bu test bilmediklerimi arıyor.
//
// Ücretli bir denetimin bulduğu hataların büyük kısmı "şu üç şey şu sırayla
// olursa" tipinde: tek başına doğru olan adımlar, belirli bir sırada
// birleşince bir değişmezi bozuyor. Elle yazılan testler bu kombinasyonları
// göremez çünkü test yazan kişi zaten aklına geleni yazar.
//
// Burada onun yerine rastgele oyuncu × rastgele eylem × rastgele zaman
// atlaması üretip HER İŞLEMDEN SONRA değişmezleri kontrol ediyoruz.
//
// DEĞİŞMEZLERİN ÇOĞU MODELDEN BAĞIMSIZ — yani programın ne yapması
// gerektiğini burada yeniden yazmıyorum. Programın mantığını teste kopyalarsam
// test, programın kendisiyle değil kopyamla uyuştuğunu kanıtlar; kopyada da
// aynı hatayı yaparsam ikisi birden yanlış olur ve test yeşil kalır.
// Onun yerine dışarıdan doğru olması GEREKEN şeylere bakıyorum:
//
//   D1. Lamport korunumu — takip edilen hesapların TOPLAMI hiç değişmemeli.
//       İşlem ücretlerini ctx.payer ödüyor (bkz. common::send), yani
//       oyuncular/kasa/hazine arasında para sadece YER DEĞİŞTİREBİLİR.
//
//       DÜRÜSTÇE: bu, sandığım kadar güçlü bir kontrol DEĞİL. Solana zaten
//       işlem düzeyinde lamport korunumunu kendisi zorluyor — bir talimat
//       yoktan lamport üretemez ya da yok edemez, denerse işlem düşer. Bunu
//       sabotaj denerken öğrendim: parayı yok etmeye çalışan sürümler D1'e
//       hiç ulaşamadan zincir tarafından reddedildi.
//
//       D1'in gerçek değeri daha dar ama yine de gerçek: paranın TAKİP
//       ETTİĞİMİZ hesap kümesinin DIŞINA çıkmadığını doğruluyor. Bugün
//       programın para gönderebileceği her adres bu kümede; yarın biri
//       yeni bir hedef hesap eklerse (ör. saldırganın verdiği bir adrese
//       ödeme yapan bir talimat) D1 bunu yakalar. Yani ileriye dönük bir
//       regresyon emniyeti, bugünkü kodun kanıtı değil.
//   D2. Kasa kira tabanının altına düşmemeli — düşerse Solana İŞLEMİN
//       TAMAMINI geri alır ve oyuncu bekleyen oyunda sıkışır.
//   D3. Kazanma sayısı oynama sayısını geçemez.
//   D4. Ödenen toplam ödül, kazanma sayısı × [küçük ödül, jackpot]
//       aralığında olmalı.
//   D5. Pencere kapandıysa oyuncu MUTLAKA forfeit edebilmeli — yani hiçbir
//       oyuncu kalıcı olarak "bekleyen oyun" durumunda sıkışmamalı.
//   D6. (yalnızca ücretsiz hak KAPALI koşuda) spin muhasebesi birebir:
//       satın alma tam paket kadar artırır, oynama tam 1 azaltır.
//
// Tohum sabit: bir hata bulunduğunda AYNI dizi tekrar üretilebilsin.
// KAOS_TOHUM ortam değişkeniyle başka tohumlar da koşturulabiliyor;
// CI birkaç farklı tohumla çalıştırıyor.

mod common;

use common::*;
use solana_sdk::signature::{Keypair, Signer};

/// xorshift64* — deterministik, tohumdan tekrar üretilebilir.
/// Testin rastgeleliği ASLA gerçek rastgelelik olmamalı: düşen bir koşuyu
/// tekrar edemezsek hata ayıklayamayız.
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

struct Oyuncu {
    kp: Keypair,
    delege: Keypair,
    delege_kayitli: bool,
}

/// Takip edilen tüm hesapların lamport toplamı.
///
/// İşlem ücretlerini ctx.payer ödediği için bu toplam SABİT kalmalı —
/// para yalnızca bu hesaplar arasında yer değiştirebilir.
async fn toplam_lamport(oyun: &mut Game, oyuncular: &[Oyuncu]) -> u128 {
    let mut t: u128 = 0;
    t += oyun.lamports(&oyun.vault.clone()).await as u128;
    t += oyun.lamports(&oyun.treasury.clone()).await as u128;
    for o in oyuncular {
        t += oyun.lamports(&o.kp.pubkey()).await as u128;
        t += oyun.lamports(&o.delege.pubkey()).await as u128;
        let (pda, _) = player_pda(&o.kp.pubkey());
        t += oyun.lamports(&pda).await as u128;
    }
    t
}

/// 0 baytlık bir hesabın var olabilmesi için gereken taban.
async fn kira_tabani(oyun: &mut Game) -> u64 {
    oyun.ctx
        .banks_client
        .get_sysvar::<solana_sdk::sysvar::rent::Rent>()
        .await
        .unwrap()
        .minimum_balance(0)
}

/// SlotHashes sysvar'ını "gerçekçi" doldurur: son `pencere` slot'un bir
/// kısmı ATLANMIŞ (blok üretilmemiş) olacak şekilde.
///
/// Atlanan slot, bu programda gerçek bir para kaybı hatasına yol açmıştı;
/// kaos koşusunda da sürekli üretilmesi kasıtlı.
fn slot_hashlerini_kur(
    oyun: &mut Game,
    su_an: u64,
    pencere: u64,
    zar: &mut Zar,
    zorunlu: Option<u64>,
) {
    let mut girdiler: Vec<(u64, [u8; 32])> = Vec::new();
    let baslangic = su_an.saturating_sub(pencere);
    for s in baslangic..=su_an {
        // ~%12 slot atlanıyor — devnet'teki orana yakın.
        // `zorunlu` slot hiç atlanmıyor: D7 değişmezini sınarken
        // "hash yoktu" mazeretini ortadan kaldırmak için.
        if Some(s) != zorunlu && zar.kadar(100) < 12 {
            continue;
        }
        let mut h = [0u8; 32];
        let v = zar.next().to_le_bytes();
        for (i, b) in h.iter_mut().enumerate() {
            *b = v[i % 8] ^ (i as u8);
        }
        girdiler.push((s, h));
    }
    oyun.set_slot_hashes(&girdiler);
}

async fn kaos_kos(
    tohum: u64,
    adim_sayisi: u32,
    free_plays: u8,
    spin_muhasebesi: bool,
    kasa_lamports: u64,
) {
    let mut zar = Zar::yeni(tohum);
    let mut oyun =
        Game::start_with(kasa_lamports, NORMAL_WIN_BPS, EASY_WIN_BPS, free_plays).await;

    let mut oyuncular: Vec<Oyuncu> = Vec::new();
    for _ in 0..4 {
        let kp = Keypair::new();
        let delege = Keypair::new();
        fund(&mut oyun.ctx, &kp.pubkey(), 30 * SOL).await;
        oyuncular.push(Oyuncu { kp, delege, delege_kayitli: false });
    }

    let taban = kira_tabani(&mut oyun).await;
    let baslangic_toplam = toplam_lamport(&mut oyun, &oyuncular).await;

    // warp_to_slot geriye gidemez; slotu hep ileri taşıyoruz.
    let mut slot = oyun.slot().await.max(1_000) + 1_000;
    oyun.warp(slot);

    let mut basarili = 0u32;
    let mut cozulen = 0u32;
    let mut kazanan = 0u32;
    let mut forfeit_edilen = 0u32;

    for adim in 0..adim_sayisi {
        // ZAMAN HER ADIMDA AKIYOR. İlk sürümde slot yalnızca ara sıra
        // ilerliyordu ve resolve neredeyse hiç başaramıyordu (260 adımda 2
        // kez) — yani ödeme yolu, testin en çok baktığı yer, aslında hiç
        // sınanmıyordu. Gerçek zincirde slotlar sürekli üretiliyor; onu
        // modellemek resolve'u anlamlı sıklıkta çalıştırıyor.
        slot += 1 + zar.kadar(6);
        oyun.warp(slot);

        let eylem = zar.kadar(100);

        // OYUNCU SEÇİMİ EYLEME GÖRE.
        //
        // İlk sürümde oyuncu tamamen rastgele seçiliyordu ve resolve
        // çağrılarının neredeyse tamamı bekleyen oyunu OLMAYAN bir oyuncuya
        // denk gelip NoPendingPlay ile düşüyordu: 400 adımda yalnızca 18
        // oyun sonuçlanıyordu, yani ödeme yolu — testin en çok baktığı yer —
        // aslında sınanmıyordu.
        //
        // Gerçek hayatta resolve'u çağıran taraf (oyuncu ya da bir keeper)
        // bekleyen oyunu HEDEFLER. Onu modelliyoruz: resolve/forfeit
        // eylemlerinde çoğunlukla bekleyen bir oyuncu seçiliyor. Yine de
        // dörtte bir olasılıkla rastgele seçim yapılıyor ki "bekleyen oyunu
        // olmayan oyuncuyu sonuçlandırmaya çalış" hata yolu da sınansın.
        // Tarama yalnızca resolve/forfeit adımlarında yapılıyor; her adımda
        // dört hesabı okumak koşuyu gereksiz yere üç kat yavaşlatıyordu.
        let mut bekleyenler: Vec<usize> = Vec::new();
        if (65..97).contains(&eylem) {
            for (idx, o) in oyuncular.iter().enumerate() {
                if oyun
                    .player_state(&o.kp.pubkey())
                    .await
                    .map(|s| s.pending)
                    .unwrap_or(false)
                {
                    bekleyenler.push(idx);
                }
            }
        }
        let hedefli = !bekleyenler.is_empty() && zar.kadar(4) != 0;
        let i = if hedefli {
            bekleyenler[zar.kadar(bekleyenler.len() as u64) as usize]
        } else {
            zar.kadar(oyuncular.len() as u64) as usize
        };
        let oyuncu_key = oyuncular[i].kp.pubkey();
        let delege_key = oyuncular[i].delege.pubkey();

        // Eylemden ÖNCEKİ durum — deltaları buna göre kontrol edeceğiz.
        let once = oyun.player_state(&oyuncu_key).await;
        let once_spin = once.as_ref().map(|s| s.spins_remaining).unwrap_or(0);
        let once_oyun = once.as_ref().map(|s| s.plays_count).unwrap_or(0);
        let sonuc: Result<(), solana_sdk::transport::TransportError>;
        let mut secilen_paket: Option<u8> = None;

        if eylem < 25 {
            // --- paket satın al ---
            let paket = zar.kadar(TIER_COUNTS.len() as u64) as u8;
            secilen_paket = Some(paket);
            let ix = oyun.buy_spins_ix(&oyuncu_key, &delege_key, paket);
            let kp = oyuncular[i].kp.insecure_clone();
            sonuc = oyun.send(&[ix], &[&kp]).await;
        } else if eylem < 33 {
            // --- delege kaydet ---
            let ix = oyun.register_delegate_ix(&oyuncu_key, &delege_key);
            let kp = oyuncular[i].kp.insecure_clone();
            sonuc = oyun.send(&[ix], &[&kp]).await;
            if sonuc.is_ok() {
                oyuncular[i].delege_kayitli = true;
            }
        } else if eylem < 65 {
            // --- oyna --- (bazen delege ile, bazen cüzdanın kendisiyle)
            let delegeyle = oyuncular[i].delege_kayitli && zar.kadar(2) == 0;
            if delegeyle {
                fund(&mut oyun.ctx, &delege_key, 0).await; // no-op güvenlik
                let ix = oyun.play_ix(&oyuncu_key, &delege_key);
                let d = oyuncular[i].delege.insecure_clone();
                sonuc = oyun.send(&[ix], &[&d]).await;
            } else {
                let ix = oyun.play_ix(&oyuncu_key, &oyuncu_key);
                let kp = oyuncular[i].kp.insecure_clone();
                sonuc = oyun.send(&[ix], &[&kp]).await;
            }
        } else if eylem < 93 {
            // --- sonuçlandır --- (izinsiz: ctx.payer çağırıyor)
            // D7 ÖN KOŞULLARI. Bekleyen bir oyunun penceresi AÇIKSA ve hedef
            // slotun hash'i sysvar'da varsa, resolve'un başarısız olması için
            // hiçbir meşru sebep yok — kasa ödeyemiyorsa program bunu zaten
            // "kaybetti" sayıyor, işlemi düşürmüyor.
            let hedef_slot = once
                .as_ref()
                .filter(|s| s.pending)
                .map(|s| s.commit_slot + REVEAL_DELAY);
            let pencere_acik = hedef_slot
                .map(|t| slot > t && slot <= t + MAX_RESOLVE_WINDOW_TEST)
                .unwrap_or(false);
            slot_hashlerini_kur(&mut oyun, slot, 400, &mut zar, hedef_slot);
            let ix = oyun.resolve_ix(&oyuncu_key);
            let kazanc_once = once.as_ref().map(|s| s.wins_count).unwrap_or(0);
            sonuc = oyun.send(&[ix], &[]).await;
            if pencere_acik {
                // D7 — sıkışmanın SESSİZ hâli.
                //
                // Bu değişmez, D5'in kaçırdığı bir hatayı yakalamak için var:
                // kasa kira tabanına yakınken kazanan bir tur, ödeme kasayı
                // tabanın altına düşürdüğü için İŞLEMİN TAMAMINI geri
                // aldırıyordu. Oyuncu kalıcı olarak sıkışmıyor (pencere
                // kapanınca forfeit edebiliyor) — ama kazandığı ödülü
                // alamıyor, sadece spin'ini kaybediyor. Yani D5 haklı olarak
                // susuyordu ve hata görünmüyordu.
                //
                // Bu sabotajla ortaya çıktı: kasadaki kira payını hesaba
                // katmayan bir sürüm, o zamanki testlerin HEPSİNİ geçiyordu.
                assert!(
                    sonuc.is_ok(),
                    "D7 BOZULDU (tohum={tohum} adım={adim}): bekleyen oyunun penceresi \
                     açık (slot {slot}, hedef {:?}) ve hedef slotun hash'i sysvar'da, \
                     ama resolve düştü: {:?}",
                    hedef_slot,
                    sonuc.err()
                );
            }
            if sonuc.is_ok() {
                cozulen += 1;
                if let Some(s) = oyun.player_state(&oyuncu_key).await {
                    if s.wins_count > kazanc_once {
                        kazanan += 1;
                    }
                }
            }
        } else if eylem < 97 {
            // --- sıkışan oyunu iptal et ---
            let ix = oyun.forfeit_ix(&oyuncu_key);
            let kp = oyuncular[i].kp.insecure_clone();
            sonuc = oyun.send(&[ix], &[&kp]).await;
            if sonuc.is_ok() {
                forfeit_edilen += 1;
            }
        } else {
            // --- büyük zaman atlaması --- resolve penceresini AŞACAK kadar,
            // yani "sıkışan oyun" durumunu bilerek üretiyor.
            //
            // SEYREK olmalı (%3): bu atlama BEKLEYEN TÜM oyunların penceresini
            // birden kapatıyor. İlk sürümde %8'di ve her ~12 adımda bir
            // havuzu süpürdüğü için resolve neredeyse hiç çalışamıyordu.
            slot += 350 + zar.kadar(200);
            oyun.warp(slot);
            slot_hashlerini_kur(&mut oyun, slot, 400, &mut zar, None);
            continue;
        }

        if sonuc.is_ok() {
            basarili += 1;
        }

        // ---------------- DEĞİŞMEZLER ----------------
        let etiket = format!("tohum={tohum} adım={adim}");

        // D1 — lamport korunumu
        let simdi_toplam = toplam_lamport(&mut oyun, &oyuncular).await;
        assert_eq!(
            simdi_toplam, baslangic_toplam,
            "D1 BOZULDU ({etiket}): takip edilen hesapların lamport toplamı değişti \
             (başlangıç {baslangic_toplam}, şimdi {simdi_toplam}). \
             Para ya yoktan üretildi ya buharlaştı."
        );

        // D2 — kasa kira tabanının altına düşmedi
        let kasa = oyun.lamports(&oyun.vault.clone()).await;
        assert!(
            kasa == 0 || kasa >= taban,
            "D2 BOZULDU ({etiket}): kasa {kasa} lamport — kira tabanı {taban}. \
             Bu seviyenin altında Solana işlemin TAMAMINI geri alır ve oyuncu sıkışır."
        );

        let sonra = oyun.player_state(&oyuncu_key).await;
        if let Some(s) = sonra.as_ref() {
            // D3 — kazanma ≤ oynama
            assert!(
                s.wins_count <= s.plays_count,
                "D3 BOZULDU ({etiket}): kazanma {} > oynama {}",
                s.wins_count,
                s.plays_count
            );

            // D4 — ödül toplamı kazanma sayısıyla tutarlı
            let alt = s.wins_count as u128 * SMALL_PRIZE as u128;
            let ust = s.wins_count as u128 * BIG_PRIZE as u128;
            let odul = s.total_won_lamports as u128;
            assert!(
                odul >= alt && odul <= ust,
                "D4 BOZULDU ({etiket}): {} kazanç için ödenen {odul}, \
                 beklenen aralık [{alt}, {ust}]",
                s.wins_count
            );

            // D6 — spin muhasebesi (yalnızca ücretsiz hak kapalıyken birebir)
            if spin_muhasebesi && sonuc.is_ok() {
                if let Some(paket) = secilen_paket {
                    assert_eq!(
                        s.spins_remaining,
                        once_spin + TIER_COUNTS[paket as usize] as u32,
                        "D6 BOZULDU ({etiket}): {} spinlik paket alındı ama bakiye \
                         {once_spin} -> {}",
                        TIER_COUNTS[paket as usize],
                        s.spins_remaining
                    );
                } else if s.plays_count == once_oyun + 1 {
                    // Başarılı bir oynama: tam olarak 1 spin harcanmalı.
                    assert_eq!(
                        s.spins_remaining,
                        once_spin.saturating_sub(1),
                        "D6 BOZULDU ({etiket}): bir oynama {once_spin} -> {} spin",
                        s.spins_remaining
                    );
                }
            }
        }
    }

    // D5 — hiçbir oyuncu kalıcı olarak sıkışmamalı.
    //
    // Pencereyi kesin olarak kapatıp bekleyen HER oyunun iptal
    // EDİLEBİLDİĞİNİ kanıtlıyoruz. Bu, oyuncunun parasını değil ama
    // oynayabilirliğini koruyan son emniyet valfi.
    slot += MAX_RESOLVE_WINDOW_TEST + REVEAL_DELAY + 50;
    oyun.warp(slot);
    let mut iptal_edilen = 0;
    let anahtarlar: Vec<(Keypair, _)> = oyuncular
        .iter()
        .map(|o| (o.kp.insecure_clone(), o.kp.pubkey()))
        .collect();
    for (kp, key) in &anahtarlar {
        let key = *key;
        let durum = oyun.player_state(&key).await;
        if durum.map(|s| s.pending).unwrap_or(false) {
            let ix = oyun.forfeit_ix(&key);
            let kp = kp.insecure_clone();
            oyun.send(&[ix], &[&kp]).await.unwrap_or_else(|e| {
                panic!(
                    "D5 BOZULDU (tohum={tohum}): pencere kapalı ama bekleyen oyun \
                     iptal edilemedi — oyuncu KALICI olarak sıkıştı: {e:?}"
                )
            });
            let sonra = oyun.player_state(&key).await.unwrap();
            assert!(
                !sonra.pending,
                "D5 BOZULDU (tohum={tohum}): forfeit geçti ama pending hâlâ true"
            );
            iptal_edilen += 1;
        }
    }

    // Koşunun GERÇEKTEN iş yaptığını kanıtlıyoruz. Bu olmadan, her şeyi
    // reddeden bozuk bir program da bu testi "geçerdi".
    assert!(
        basarili > adim_sayisi / 6,
        "tohum={tohum}: yalnızca {basarili}/{adim_sayisi} işlem geçti — \
         kaos koşusu anlamlı bir yol katetmemiş"
    );
    assert!(
        cozulen >= 15,
        "tohum={tohum}: yalnızca {cozulen} oyun sonuçlandı — resolve yolu yeterince \
         sınanmamış, koşu anlamlı değil"
    );
    // Kasa doluyken ödeme dalının GERÇEKTEN çalıştığını kanıtlıyoruz.
    // Bu olmadan "hiç kimseye ödeme yapmayan" bozuk bir program da bu testi
    // geçerdi — ve D1..D4'ün hepsi yine tutardı.
    if kasa_lamports >= EASY_THRESHOLD {
        assert!(
            kazanan > 0,
            "tohum={tohum}: {cozulen} sonuçlanan turda hiç kazanan çıkmadı — \
             ödeme dalı hiç çalışmamış olabilir"
        );
    }

    println!(
        "tohum={tohum} · {basarili}/{adim_sayisi} işlem · {cozulen} sonuçlandı \
         ({kazanan} kazanan) · {forfeit_edilen} iptal · sonda {iptal_edilen} kurtarıldı"
    );
}

/// Program sabitiyle aynı olmak zorunda (bkz. MAX_RESOLVE_WINDOW_SLOTS).
/// check-tokenomics config.ts ile lib.rs arasındaki eşitliği ayrıca
/// doğruluyor.
const MAX_RESOLVE_WINDOW_TEST: u64 = 300;

#[tokio::test]
async fn kaos_ucretsiz_hak_kapali() {
    // Ücretsiz hak kapalıyken spin muhasebesi birebir doğrulanabiliyor.
    kaos_kos(0xA11CE, 400, 0, true, 50 * SOL).await;
}

#[tokio::test]
async fn kaos_ucretsiz_hak_acik() {
    // Ücretsiz haklar + bonus spin yolu: muhasebe modeli kurmak yerine
    // modelden bağımsız değişmezlere güveniyoruz.
    kaos_kos(0xB0B, 400, 3, false, 50 * SOL).await;
}

#[tokio::test]
async fn kaos_kasa_bos_baslarken() {
    // Kasa jackpot'u ödeyemeyecek kadar boş başlıyor: "kazandı ama kasada
    // para yok" dalının oyuncuyu sıkıştırmadığını kanıtlıyor. Kasa satın
    // alımlarla dolduğu için koşu ilerledikçe ödeme dalı da devreye girer.
    kaos_kos(0xDEAD, 400, 0, true, 0).await;
}

#[tokio::test]
async fn kaos_kasa_odeme_esiginde() {
    // Kasa, jackpot + payını ancak ancak karşılayacak kadar dolu başlıyor.
    //
    // ÖNEMLİ KOŞU: ödeme kasayı kira tabanına yaklaştırdığı için, "kazandı
    // ama ödeme kasayı tabanın altına düşürüyor" dalı burada gerçekten
    // üretiliyor. Diğer koşularda kasa 50 SOL'le başlıyor ve bu seviyeye
    // hiç inmiyordu — sabotaj testi bu boşluğu ortaya çıkardı.
    kaos_kos(0x5AFE, 400, 0, true, EASY_THRESHOLD + 2_000_000).await;
}

// Aynı kod farklı tohumlarla farklı diziler üretiyor. Tek tohum "şanslı"
// olabilir; birkaçını birden koşturmak kapsamı ucuza genişletiyor.
#[tokio::test]
async fn kaos_ek_tohumlar() {
    for tohum in [0x1234_5678u64, 0xFEED_FACE, 0x0BAD_C0DE, 0xC0FF_EE00] {
        kaos_kos(tohum, 400, 0, true, 50 * SOL).await;
    }
}

// ---------------------------------------------------------------------------
// KASA KİRA TABANINA YAKINKEN — hedefli regresyon testi
// ---------------------------------------------------------------------------
// Bu test, kaos koşusunun BULAMADIĞI bir hatayı yakalamak için var; varlığı
// da sabotaj testine borçlu.
//
// Sabotaj şuydu: resolve(), kasadaki kira payını hesaba katmadan
// "ödeyebilir miyim" diye baksın —
//     let vault_balance = ctx.accounts.vault.lamports();          // kira YOK
//   yerine doğrusu
//     let vault_balance = ctx.accounts.vault.lamports() - rent;
//
// O sürüm, o zamanki testlerin HEPSİNİ geçiyordu. Yaptığı şey şu: kasa
// ödülü ancak ancak karşılayabilecek kadar doluyken tur KAZANMIŞ sayılıyor,
// ödeme kasayı 0 baytlık hesabın kira tabanının ALTINA düşürüyor ve Solana
// İŞLEMİN TAMAMINI geri alıyor. Sonuç: oyuncu kazandığı ödülü alamıyor,
// yalnızca spin'ini kaybediyor. Ne zincirde ne logda bir iz kalıyor.
//
// Kaos koşusu bunu neden bulamadı: kasanın tam olarak
// [max_payout, max_payout + kira) bandına düşmesi gerekiyor — 890.880
// lamportluk bir pencere. Rastgele bir dizide oraya isabet etmek pratikte
// imkânsız. O yüzden burada senaryoyu DOĞRUDAN kuruyoruz.
//
// Kazanmayı şansa bırakmamak için oranlar %100'e çekiliyor (her tur kazanır,
// her kazanan jackpot alır) — böylece test tek koşuda kesin sonuç veriyor.
#[tokio::test]
async fn kasa_tabana_yakinken_kazanan_tur_islemi_dusurmez() {
    let mut oyun = Game::start_with(0, 10_000, 10_000, 0).await;
    let taban = kira_tabani(&mut oyun).await;

    // Her kazanan jackpot alsın: ödeme tam olarak max_payout olsun.
    let ix = solana_sdk::instruction::Instruction {
        program_id: luck_game::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &luck_game::accounts::UpdateConfig {
                authority: oyun.authority.pubkey(),
                config: oyun.config,
            },
            None,
        ),
        data: anchor_lang::InstructionData::data(&luck_game::instruction::UpdateConfig {
            new_treasury: oyun.treasury,
            free_plays: 0,
            small_prize_lamports: SMALL_PRIZE,
            big_prize_lamports: BIG_PRIZE,
            big_prize_bps: 10_000, // kazananların %100'ü jackpot
            vault_easy_threshold_lamports: EASY_THRESHOLD,
            normal_win_bps: 10_000,
            easy_win_bps: 10_000,
            treasury_fee_bps: TREASURY_FEE_BPS,
            spin_tier_counts: TIER_COUNTS,
            spin_tier_prices: TIER_PRICES,
        }),
    };
    let auth = oyun.authority.insecure_clone();
    oyun.send(&[ix], &[&auth]).await.unwrap();

    // Ödeme = jackpot + üstüne eklenen ev payı.
    let max_odeme = BIG_PRIZE + BIG_PRIZE * TREASURY_FEE_BPS as u64 / 10_000;

    // KRİTİK SEVİYE: kasa ödemeyi karşılıyor ama ödeme sonrası kira tabanının
    // ALTINDA kalacak. Doğru kod burada "kazanmadı" demeli; kira payını yok
    // sayan kod ödemeye kalkışıp işlemin tamamını düşürür.
    let kritik = max_odeme + taban - 1;

    let oyuncu = Keypair::new();
    let delege = Keypair::new();
    fund(&mut oyun.ctx, &oyuncu.pubkey(), 10 * SOL).await;
    let oyuncu_key = oyuncu.pubkey();

    // En ucuz paketi al (kasaya para girer, o yüzden kasayı SONRA ayarlıyoruz).
    let ix = oyun.buy_spins_ix(&oyuncu_key, &delege.pubkey(), 0);
    oyun.send(&[ix], &[&oyuncu]).await.unwrap();

    // Kasayı tam kritik seviyeye getir.
    let simdi = oyun.lamports(&oyun.vault.clone()).await;
    assert!(
        simdi < kritik,
        "kasa zaten kritik seviyenin üstünde ({simdi} >= {kritik}) — test kurulumu bozuk"
    );
    let vault = oyun.vault;
    fund(&mut oyun.ctx, &vault, kritik - simdi).await;
    assert_eq!(oyun.lamports(&vault).await, kritik);

    // Oyna, hedef slotu geç, sonuçlandır.
    let ix = oyun.play_ix(&oyuncu_key, &oyuncu_key);
    oyun.send(&[ix], &[&oyuncu]).await.unwrap();
    let commit = oyun.player_state(&oyuncu_key).await.unwrap().commit_slot;
    let hedef = commit + REVEAL_DELAY;
    let simdi_slot = hedef + 3;
    oyun.warp(simdi_slot);
    let mut zar = Zar::yeni(0xF10);
    slot_hashlerini_kur(&mut oyun, simdi_slot, 50, &mut zar, Some(hedef));

    let ix = oyun.resolve_ix(&oyuncu_key);
    oyun.send(&[ix], &[]).await.unwrap_or_else(|e| {
        panic!(
            "Kasa kritik seviyedeyken ({kritik} lamport, kira tabanı {taban}) resolve \
             DÜŞTÜ: {e:?}\nBu, oyuncunun kazandığı turu alamadan spin'ini kaybetmesi \
             demek — hiçbir hata mesajı görmeden."
        )
    });

    let durum = oyun.player_state(&oyuncu_key).await.unwrap();
    assert!(!durum.pending, "resolve geçti ama oyun hâlâ bekliyor");
    // Doğru davranış: ödeme YAPILMAMALI (kasa yetmiyor), tur kayıp sayılmalı.
    assert_eq!(
        durum.wins_count, 0,
        "kasa ödemeyi karşılayamayacakken kazanç yazıldı — kasa {}",
        oyun.lamports(&vault).await
    );
    assert_eq!(
        oyun.lamports(&vault).await,
        kritik,
        "kasa yetmediği hâlde kasadan para çıkmış"
    );

    // Şimdi TAM YETERLİ seviye: bir lamport daha. Bu kez ödeme yapılmalı.
    fund(&mut oyun.ctx, &vault, 1).await;
    let ix = oyun.buy_spins_ix(&oyuncu_key, &delege.pubkey(), 0);
    oyun.send(&[ix], &[&oyuncu]).await.unwrap();
    // Satın alma kasaya para eklediği için seviyeyi tekrar sabitlemek yerine
    // yalnızca ödemenin GERÇEKLEŞTİĞİNİ doğruluyoruz.
    let kasa_once = oyun.lamports(&vault).await;
    let ix = oyun.play_ix(&oyuncu_key, &oyuncu_key);
    oyun.send(&[ix], &[&oyuncu]).await.unwrap();
    let commit = oyun.player_state(&oyuncu_key).await.unwrap().commit_slot;
    let hedef = commit + REVEAL_DELAY;
    let simdi_slot = hedef + 3;
    oyun.warp(simdi_slot);
    slot_hashlerini_kur(&mut oyun, simdi_slot, 50, &mut zar, Some(hedef));
    let ix = oyun.resolve_ix(&oyuncu_key);
    oyun.send(&[ix], &[]).await.unwrap();

    let durum = oyun.player_state(&oyuncu_key).await.unwrap();
    assert_eq!(
        durum.wins_count, 1,
        "kasa yeterliyken kazanç yazılmadı — oran %100 olmasına rağmen"
    );
    assert_eq!(
        oyun.lamports(&vault).await,
        kasa_once - max_odeme,
        "ödeme tutarı beklenenden farklı"
    );
    println!(
        "kritik seviye {kritik} lamport (kira tabanı {taban}) · ödeme {max_odeme} · \
         yetersizken ödenmedi, yeterliyken ödendi"
    );
}
