use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::slot_hashes;
use anchor_lang::system_program::{self, Transfer as SolTransfer};

// Devnet adresi. Hesap düzeni değişmese bile her redeploy'da yenileniyor:
// rust-cache CI önbelleği `target/deploy/luck_game-keypair.json`'ı run'lar
// arasında korumuyor, `anchor keys sync` de her seferinde taze bir keypair
// üretiyor. Bunun pratik sonucu: her redeploy'dan sonra oyun yeniden
// initialize edilmeli ve eski kasadaki bakiye orada kalır (devnet test
// SOL'ü olduğu için şimdilik önemsiz — mainnet'e çıkmadan önce keypair'i
// bir GitHub secret'ında saklayacak şekilde düzeltilmeli).
// NOT: rust-cache CI önbelleği program keypair'ini run'lar arasında
// korumadı, bu yüzden fresh-keypair redeploy'lar `anchor keys sync`
// adımıyla (bkz. deploy-luck-game.yml) bu satırı CI checkout'unda otomatik
// güncelledi — gerçek deploy edilen ve kendi içinde tutarlı adres bu.
declare_id!("H6gnAvLa5o2JtjfdgyKdZy2eC9bjnMerCcbxjYZeKdnf");

const CONFIG_SEED: &[u8] = b"config";
const VAULT_SEED: &[u8] = b"vault";
const PLAYER_SEED: &[u8] = b"player";
const SPIN_TIERS: usize = 6;

// resolve() en erken commit_slot + reveal_delay_slots'ta, en geç
// commit_slot + reveal_delay_slots + MAX_RESOLVE_WINDOW_SLOTS'ta çağrılabilir.
// Bu üst sınır, SlotHashes sysvar'ının yalnızca son ~512 slot'u tuttuğu
// gerçeğinden kaynaklanıyor — çok geç kalınırsa hedef slot'un hash'i sysvar'dan
// düşmüş olur ve sonuç asla belirlenemez hale gelirdi. 300 slot (~2 dakika),
// normal kullanımda (frontend gecikmeden resolve'u otomatik tetikler) bolca
// pay bırakırken sysvar'ın 512 slot'luk penceresinin epey içinde kalıyor.
const MAX_RESOLVE_WINDOW_SLOTS: u64 = 300;

// Basis points taban değeri (10000 = %100). Olasılıklar ve ücret payı bu
// birimle ifade ediliyor — ör. 200 bps = %2.
const BPS_DENOMINATOR: u32 = 10_000;

// Delegenin ("oyun cüzdanı") play()/resolve() işlem ücretlerini ödeyebilmesi
// için gereken, GERÇEKTEN HARCANABİLİR gaz payı — oyuncudan değil, KASADAN
// karşılanır. Kasa zaten her satın alımın büyük kısmını topladığından bu,
// oynanan oyunların doğal bir maliyeti sayılabilir.
//
// DİKKAT — bu tutar tek başına bir hesabı ayakta TUTMAZ: Solana'da 0 baytlık
// bir hesabın kira muafiyeti (rent-exempt) tabanı ~890_880 lamport ve bir
// hesap bu tabanın altında bakiyeyle bırakılamaz. Bu yüzden delegeye
// gönderilen tutar her zaman `Rent::minimum_balance(0) + bu sabit` olarak
// hesaplanıyor (bkz. buy_spins içindeki `delegate_target`); bu sabit yalnızca
// tabanın ÜSTÜNE binen, harcanabilir kısmı ifade ediyor.
//
// Kasadan çıktığı için ödemesi bilerek `buy_spins()`'e bağlandı: izinsiz
// çağrılabilen `register_delegate()` içinde olsaydı, boş cüzdanlarla art arda
// kayıt olup kasayı boşaltmak kârlı bir saldırı olurdu.
const DELEGATE_GAS_SPONSOR_LAMPORTS: u64 = 200_000; // ~0.0002 SOL, ~30 tur

#[program]
pub mod luck_game {
    use super::*;

    /// Oyunu bir kez kurar: ödül/ihtimal parametrelerini, spin paket
    /// tarifesini ve hazine (treasury) cüzdanını GameConfig PDA'sına yazar.
    /// Kasa (vault) için ayrı bir "oluşturma" adımı yok — locked-pool'daki
    /// pool_authority'de olduğu gibi, ilk `buy_spins()` çağrısındaki
    /// transfer onu zaten var edecek.
    pub fn initialize(
        ctx: Context<Initialize>,
        free_plays: u8,
        small_prize_lamports: u64,
        big_prize_lamports: u64,
        big_prize_bps: u16,
        vault_easy_threshold_lamports: u64,
        normal_win_bps: u16,
        easy_win_bps: u16,
        treasury_fee_bps: u16,
        reveal_delay_slots: u64,
        spin_tier_counts: [u16; SPIN_TIERS],
        spin_tier_prices: [u64; SPIN_TIERS],
    ) -> Result<()> {
        require!(small_prize_lamports > 0, GameError::InvalidParam);
        // Büyük ödül küçük ödülden az olamaz — "büyük" adının bir anlamı
        // kalmalı (eşit olması, yani tek katmanlı davranış, buna izin verilir).
        require!(big_prize_lamports >= small_prize_lamports, GameError::InvalidParam);
        require!(reveal_delay_slots > 0, GameError::InvalidParam);
        require!(
            (normal_win_bps as u32) <= BPS_DENOMINATOR
                && (easy_win_bps as u32) <= BPS_DENOMINATOR
                && (treasury_fee_bps as u32) <= BPS_DENOMINATOR
                && (big_prize_bps as u32) <= BPS_DENOMINATOR,
            GameError::InvalidParam
        );
        // "Kolay mod" normal moddan daha kolay olmalı, yoksa eşiğin hiç
        // anlamı kalmaz.
        require!(easy_win_bps >= normal_win_bps, GameError::InvalidParam);
        // Kasa eşiği, en büyük olası ödülü (jackpot) ödeyebilecek kadar
        // büyük olmalı — aksi halde "kolay mod" tetiklenip de kasada ödül
        // için para olmayan bir durum tasarım hatası olurdu.
        // Eşik yalnızca jackpot'u değil, onun üstüne eklenecek operasyon
        // payını da karşılamalı — aksi halde "kolay mod"a geçmiş bir kasa,
        // jackpot çıktığında ödülü ödeyip payı ödeyemeyecek duruma düşerdi.
        require!(
            vault_easy_threshold_lamports
                >= big_prize_lamports
                    .checked_add(ops_fee_lamports(big_prize_lamports, treasury_fee_bps)?)
                    .ok_or(GameError::MathOverflow)?,
            GameError::InvalidParam
        );
        for i in 0..SPIN_TIERS {
            require!(
                spin_tier_counts[i] > 0 && spin_tier_prices[i] > 0,
                GameError::InvalidParam
            );
        }

        // Vault PDA'sının bump'ını burada bir kez hesaplayıp saklıyoruz ki
        // sonraki her buy_spins()/resolve() çağrısında tekrar tekrar
        // `find_program_address` aramasıyla (göreceli olarak pahalı) yeniden
        // hesaplamak yerine doğrudan kullanılabilsin — locked-pool'daki
        // `authority_bump` ile aynı optimizasyon.
        let config_key = ctx.accounts.config.key();
        let (_vault_pda, vault_bump) =
            Pubkey::find_program_address(&[VAULT_SEED, config_key.as_ref()], ctx.program_id);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = ctx.accounts.treasury.key();
        config.free_plays = free_plays;
        config.small_prize_lamports = small_prize_lamports;
        config.big_prize_lamports = big_prize_lamports;
        config.big_prize_bps = big_prize_bps;
        config.vault_easy_threshold_lamports = vault_easy_threshold_lamports;
        config.normal_win_bps = normal_win_bps;
        config.easy_win_bps = easy_win_bps;
        config.treasury_fee_bps = treasury_fee_bps;
        config.reveal_delay_slots = reveal_delay_slots;
        config.spin_tier_counts = spin_tier_counts;
        config.spin_tier_prices = spin_tier_prices;
        config.vault_bump = vault_bump;
        config.bump = ctx.bumps.config;

        Ok(())
    }

    /// Parametreleri sonradan ayarlamak için (ör. paket tarifesini
    /// güncelleme). Yalnızca `config.authority` çağırabilir.
    ///
    /// BEKLEYEN OYUNLARI ETKİLEMEZ. `play()` anında ödemeyi belirleyen tüm
    /// parametreler `PlayerState`'e KOPYALANIYOR ve `resolve()` onları
    /// okuyor. Yani oyuncu bahsini koyduğu andaki kurallarla sonuçlanır;
    /// yetkilinin bekleyen bir bahsin oranını sonradan değiştirmesi
    /// mümkün değil.
    ///
    /// Bu böyle DEĞİLDİ. Önceden `resolve()` güncel config'i okuyordu ve
    /// buradaki yorum "bekleyen oyunları etkilemez" diyip hemen ardından
    /// "resolve GÜNCEL config'ten okur" diye kendini yalanlıyordu.
    /// Doğrulanabilir adalet iddiasında bulunan bir oyunda "bahsi
    /// koyduktan sonra oranı değiştirmeyeceğimize güvenin" kabul edilemez
    /// bir boşluktu. Yayın öncesinde, düzeltmenin bedava olduğu son anda
    /// kapatıldı.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_treasury: Pubkey,
        free_plays: u8,
        small_prize_lamports: u64,
        big_prize_lamports: u64,
        big_prize_bps: u16,
        vault_easy_threshold_lamports: u64,
        normal_win_bps: u16,
        easy_win_bps: u16,
        treasury_fee_bps: u16,
        spin_tier_counts: [u16; SPIN_TIERS],
        spin_tier_prices: [u64; SPIN_TIERS],
    ) -> Result<()> {
        require!(small_prize_lamports > 0, GameError::InvalidParam);
        require!(big_prize_lamports >= small_prize_lamports, GameError::InvalidParam);
        require!(
            (normal_win_bps as u32) <= BPS_DENOMINATOR
                && (easy_win_bps as u32) <= BPS_DENOMINATOR
                && (treasury_fee_bps as u32) <= BPS_DENOMINATOR
                && (big_prize_bps as u32) <= BPS_DENOMINATOR,
            GameError::InvalidParam
        );
        require!(easy_win_bps >= normal_win_bps, GameError::InvalidParam);
        // Eşik yalnızca jackpot'u değil, onun üstüne eklenecek operasyon
        // payını da karşılamalı — aksi halde "kolay mod"a geçmiş bir kasa,
        // jackpot çıktığında ödülü ödeyip payı ödeyemeyecek duruma düşerdi.
        require!(
            vault_easy_threshold_lamports
                >= big_prize_lamports
                    .checked_add(ops_fee_lamports(big_prize_lamports, treasury_fee_bps)?)
                    .ok_or(GameError::MathOverflow)?,
            GameError::InvalidParam
        );
        for i in 0..SPIN_TIERS {
            require!(
                spin_tier_counts[i] > 0 && spin_tier_prices[i] > 0,
                GameError::InvalidParam
            );
        }

        // Hazine cüzdanı sonradan değiştirilebilir: hem buy_spins()'teki
        // %20 pay hem resolve()'daki ödül payı bu adrese gider. Sıfır
        // adres kabul edilmiyor — yanlışlıkla boş bırakılan bir alan tüm
        // geliri yakılmış bir adrese gönderirdi.
        require_keys_neq!(new_treasury, Pubkey::default(), GameError::InvalidParam);

        let config = &mut ctx.accounts.config;
        config.treasury = new_treasury;
        config.free_plays = free_plays;
        config.small_prize_lamports = small_prize_lamports;
        config.big_prize_lamports = big_prize_lamports;
        config.big_prize_bps = big_prize_bps;
        config.vault_easy_threshold_lamports = vault_easy_threshold_lamports;
        config.normal_win_bps = normal_win_bps;
        config.easy_win_bps = easy_win_bps;
        config.treasury_fee_bps = treasury_fee_bps;
        config.spin_tier_counts = spin_tier_counts;
        config.spin_tier_prices = spin_tier_prices;

        Ok(())
    }

    /// Bir spin paketi satın alır — İSTER İSTEMEZ oyuncunun GERÇEK
    /// cüzdanıyla imzalanmalı (delege burada kullanılamaz, çünkü delege
    /// yalnızca küçük bir gaz bakiyesi taşır, gerçek ödeme SOL'u değil).
    /// Tutar aynı `play()`'in eski davranışındaki gibi ikiye bölünüyor:
    /// bir payı hazineye (treasury), kalanı oyun kasasına (vault). Satın
    /// alınan spin sayısı `player_state.spins_remaining`'e ekleniyor.
    ///
    /// İLK satın alımda ayrıca "katılım depozitosu" geri ödemesi yapılır —
    /// bkz. aşağıdaki `onboarding_cost` açıklaması.
    pub fn buy_spins(ctx: Context<BuySpins>, tier_index: u8) -> Result<()> {
        let config = &ctx.accounts.config;
        require!((tier_index as usize) < SPIN_TIERS, GameError::InvalidParam);
        let spin_count = config.spin_tier_counts[tier_index as usize] as u32;
        let price = config.spin_tier_prices[tier_index as usize];

        // -------------------------------------------------------------------
        // Katılım maliyeti: oyuncudan değil, KASADAN
        // -------------------------------------------------------------------
        // Solana'da hesap açmak ücretsiz değil: bir hesap, "rent-exempt"
        // (kira muafiyeti) tabanının altında bakiyeyle var olamaz. Yeni bir
        // oyuncu zincire girerken iki hesap doğuyor:
        //   * `player_state` PDA'sı (spin kredisi, bekleyen oyun, delege
        //     kaydı burada tutuluyor) — rent(PlayerState::LEN), ~0,00162 SOL.
        //     Bunu Anchor'ın `init_if_needed`'i OYUNCUYA ödetiyor.
        //   * delege / "oyun cüzdanı" (0 baytlık sıradan bir hesap) —
        //     rent(0) + gaz payı. Bunu doğrudan kasadan gönderiyoruz.
        //
        // İkisi de bize gelir olarak kalmıyor (oyuncunun kendi hesaplarında
        // duruyorlar) ama oyuncu açısından "ilan edilen paket fiyatının
        // üstüne çıkan sürpriz masraf" gibi görünüyordu. Artık:
        //   - player_state kirası oyuncuya AYNEN geri ödeniyor,
        //   - delegenin kirası + gazı zaten kasadan gidiyor,
        // yani oyuncunun cebinden çıkan net tutar = ilan edilen paket
        // fiyatı + Solana'nın kaçınılmaz işlem ücreti (~0,0000065 SOL).
        //
        // Maliyeti bizim payımızdan düşürüyoruz: ev payı (treasury_fee_bps)
        // paketin TAMAMI üzerinden değil, bu katılım maliyeti düşüldükten
        // sonraki tutar üzerinden hesaplanıyor.
        //
        // NEDEN `register_delegate()` İÇİNDE DEĞİL DE BURADA: kasadan çıkan
        // her kuruşun ücretli bir satın alıma bağlı olması şart. Kayıt
        // sırasında yapılsaydı, bir saldırgan binlerce boş cüzdanla art arda
        // kayıt olup kasayı kuru kuruya boşaltabilirdi — üstelik bu yalnızca
        // teorik değil, kârlı bir saldırı olurdu (işlem ücreti, çekilen
        // tutardan çok daha küçük). Satın almaya bağlıyken "sömürmek" için
        // her seferinde katılım maliyetinden onlarca kat büyük bir paket
        // bedeli ödemek gerekiyor.
        let rent = Rent::get()?;

        // "İlk satın alım" tespiti: hiç oynanmamış VE elde hiç spin yok.
        // Bu ikisi yalnızca player_state'in ömründe BİR KEZ aynı anda
        // doğru olabilir — ilk satın alımdan sonra spins_remaining > 0,
        // spinler tükendiğinde ise plays_count > 0 olur.
        //
        // Burada bilerek `initialized` bayrağına BAKMIYORUZ: delege kaydı
        // artık satın almayla AYNI işlemde, ondan hemen önce gidiyor ve
        // `register_delegate()` bayrağı çoktan set ediyor. `initialized`
        // kullanıldığında geri ödeme hiç tetiklenmiyordu — oyuncudan
        // 0,00162 SOL fazladan çıkıyordu.
        let is_first_purchase = ctx.accounts.player_state.plays_count == 0
            && ctx.accounts.player_state.spins_remaining == 0;

        let player_refund = if is_first_purchase {
            rent.minimum_balance(PlayerState::LEN)
        } else {
            0
        };

        // Delegenin hedef bakiyesi: kira tabanı (hesabın var olabilmesi
        // için asla harcanamaz) + harcanabilir gaz payı. Her satın alımda
        // bu seviyeye geri dolduruluyor, yani oynadıkça eriyen gaz, oyuncu
        // zaten imzaladığı ödemenin İÇİNDE sessizce tazeleniyor — ayrı bir
        // "doldur" onayı istemeye gerek kalmıyor.
        //
        // Yalnızca oyuncunun GERÇEKTEN kayıtlı delegesi fonlanıyor; hesap
        // listesine rastgele bir adres koyup kasadan oraya para
        // göndertilemesin diye.
        let delegate_target = rent
            .minimum_balance(0)
            .checked_add(DELEGATE_GAS_SPONSOR_LAMPORTS)
            .ok_or(GameError::MathOverflow)?;
        let delegate_funding = if ctx.accounts.player_state.delegate == ctx.accounts.delegate.key()
            && ctx.accounts.player_state.delegate != Pubkey::default()
        {
            delegate_target.saturating_sub(ctx.accounts.delegate.lamports())
        } else {
            0
        };

        let mut onboarding_cost = player_refund
            .checked_add(delegate_funding)
            .ok_or(GameError::MathOverflow)?;
        // Katılım maliyeti paket bedelinden büyük olamaz — aksi halde kasa
        // her yeni oyuncuda para kaybederdi. Tarifedeki en ucuz paket bile
        // bunun onlarca katı, bu yüzden pratikte hiç tetiklenmiyor; yine de
        // ileride çok ucuz bir paket eklenirse sessizce zarar etmek yerine
        // kasadan çıkışı tamamen kapatıyoruz.
        let (player_refund, delegate_funding) = if onboarding_cost >= price {
            onboarding_cost = 0;
            (0, 0)
        } else {
            (player_refund, delegate_funding)
        };

        // Ev payı, katılım maliyeti DÜŞÜLDÜKTEN SONRAKİ tutar üzerinden.
        let fee_base = price
            .checked_sub(onboarding_cost)
            .ok_or(GameError::MathOverflow)?;
        let treasury_amount = (fee_base as u128)
            .checked_mul(config.treasury_fee_bps as u128)
            .ok_or(GameError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(GameError::MathOverflow)? as u64;
        let vault_amount = price
            .checked_sub(treasury_amount)
            .ok_or(GameError::MathOverflow)?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            treasury_amount,
        )?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            vault_amount,
        )?;

        // Katılım maliyetini kasadan öde (yukarıdaki uzun açıklamaya
        // bakınız): player_state kirası oyuncuya geri, delegenin kirası +
        // gazı delegeye. Kasa bu satırlardan hemen önce `vault_amount`
        // aldığı için karşılığı her zaman var; yine de kasanın kendi kira
        // tabanının altına düşmemesi için tavanlıyoruz — karşılayamazsa
        // ödeme sessizce atlanır, satın alma yine de tamamlanır (bir gaz
        // tamponu eksikliği asıl ödemeyi düşürmemeli).
        if onboarding_cost > 0 {
            let config_key = ctx.accounts.config.key();
            let vault_bump = ctx.accounts.config.vault_bump;
            let signer_seeds: &[&[u8]] = &[VAULT_SEED, config_key.as_ref(), &[vault_bump]];
            let vault_floor = rent.minimum_balance(0);

            if player_refund > 0 {
                let available = ctx.accounts.vault.lamports().saturating_sub(vault_floor);
                let amount = player_refund.min(available);
                if amount > 0 {
                    system_program::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.system_program.to_account_info(),
                            SolTransfer {
                                from: ctx.accounts.vault.to_account_info(),
                                to: ctx.accounts.player.to_account_info(),
                            },
                            &[signer_seeds],
                        ),
                        amount,
                    )?;
                }
            }

            if delegate_funding > 0 {
                let available = ctx.accounts.vault.lamports().saturating_sub(vault_floor);
                let amount = delegate_funding.min(available);
                // Delege hesabı zincirde YOKSA, kira tabanının ALTINDA bir
                // tutar göndermek işlemin tamamını `InsufficientFundsForRent`
                // ile düşürür. Bu yüzden ya tam yeter, ya hiç göndermiyoruz.
                let creates_account = ctx.accounts.delegate.lamports() == 0;
                let would_be_rent_exempt =
                    ctx.accounts.delegate.lamports().saturating_add(amount) >= vault_floor;
                if amount > 0 && (!creates_account || would_be_rent_exempt) {
                    system_program::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.system_program.to_account_info(),
                            SolTransfer {
                                from: ctx.accounts.vault.to_account_info(),
                                to: ctx.accounts.delegate.to_account_info(),
                            },
                            &[signer_seeds],
                        ),
                        amount,
                    )?;
                }
            }
        }

        let owner = ctx.accounts.player.key();
        let player_state = &mut ctx.accounts.player_state;
        ensure_owner(player_state, owner)?;
        player_state.spins_remaining = player_state
            .spins_remaining
            .checked_add(spin_count)
            .ok_or(GameError::MathOverflow)?;
        player_state.bump = ctx.bumps.player_state;

        emit!(SpinsPurchased {
            player: owner,
            tier_index,
            spin_count,
            price_lamports: price,
            spins_remaining: player_state.spins_remaining,
        });

        Ok(())
    }

    /// Oyuncunun tarayıcıda tuttuğu, tek seferlik (bir kez) gerçek
    /// cüzdanla yetkilendirilmiş yerel bir "delege" anahtarını kaydeder —
    /// bundan sonraki `play()` çağrıları bu delege ile de imzalanabilir,
    /// böylece her çevirişte cüzdan uygulamasına geçmeye gerek kalmaz.
    /// Delege sadece bu oyuncunun ÖNCEDEN SATIN ALDIĞI spin kredisini
    /// harcayabilir; kazanç her zaman `player_state.player`'a (gerçek
    /// cüzdana) gider, delegenin kendisine asla gitmez.
    ///
    /// Delegenin play()/resolve() işlem ücretlerini ödeyebilmesi için
    /// gereken küçük gaz bakiyesi, OYUNCUDAN DEĞİL, bu ilk kayıtta bir
    /// kereliğine KASADAN (vault) sponsor edilir — ücretsiz deneme
    /// gerçekten ücretsiz kalsın diye (bkz. DELEGATE_GAS_SPONSOR_LAMPORTS).
    pub fn register_delegate(ctx: Context<RegisterDelegate>) -> Result<()> {
        let owner = ctx.accounts.player.key();
        let delegate_key = ctx.accounts.delegate.key();

        let player_state = &mut ctx.accounts.player_state;
        ensure_owner(player_state, owner)?;
        player_state.delegate = delegate_key;
        player_state.bump = ctx.bumps.player_state;

        // Bu çağrı KASADAN HİÇ PARA ÇIKARMIYOR — sadece defter tutuyor.
        //
        // Eskiden burada delegeye bir kereliğine gaz sponsorluğu yapılıyordu.
        // İki sorunu vardı:
        //   1. Sponsorluk (200_000 lamport) 0 baytlık bir hesabın kira
        //      tabanının (~890_880) ALTINDA kaldığı için, delege hesabı
        //      zincirde yeni doğduğunda işlemin tamamı
        //      `InsufficientFundsForRent` ile düşüyordu.
        //   2. Çağrı izinsiz (permissionless): bir saldırgan binlerce boş
        //      cüzdanla art arda kayıt olup kasayı 200_000'er 200_000'er
        //      boşaltabilirdi — işlem ücretinden daha çok çektiği için
        //      KÂRLI bir saldırı.
        //
        // Bu yüzden delegenin kirası da gazı da artık `buy_spins()` içinde,
        // yani ÜCRETLİ bir satın almaya bağlı olarak gönderiliyor. Kayıt ile
        // satın alma zaten tek işlemde birlikte gittiği için (bkz.
        // src/lib/luckGame.ts buySpins/setupDelegate) oyuncu açısından
        // hiçbir şey değişmiyor: tek imza, delege dolu.
        Ok(())
    }

    /// Oyuna katılır ("commit" adımı) — bir spin kredisi harcar. İlk
    /// çağrıda `config.free_plays` kadar ücretsiz kredi otomatik yükleniyor;
    /// bitince (ve daha önce hiç bonus verilmediyse) tek seferlik +1 bonus
    /// spin ekleniyor. Kredi biterse `NoSpinsRemaining` hatası döner —
    /// oyuncu `buy_spins()` ile paket almalı.
    ///
    /// Oyuncunun kendisi (`owner` == imzalayan) VEYA `register_delegate()`
    /// ile kaydedilmiş yerel delege anahtarı imzalayabilir — böylece
    /// oyuncu bir kez cüzdanıyla onay verip spin paketini/delegeyi
    /// kaydettikten sonra, her çevirişte tekrar cüzdan onayı gerekmez.
    ///
    /// Sonuç burada BELLİ OLMAZ — yalnızca "şu an bu oyuncu, şu slot'ta bir
    /// oyun başlattı" diye zincire yazılır. Kazanıp kazanmadığı, henüz var
    /// olmayan (gelecekteki) bir slot'un hash'ine bağlı olacak şekilde
    /// `resolve()`'da belirlenir — bkz. o fonksiyonun açıklaması, bunun
    /// neden gerekli olduğunu (simülasyonla "önizleyip" hile yapmayı
    /// engellemek için) anlatıyor.
    pub fn play(ctx: Context<Play>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        let authority = ctx.accounts.authority.key();

        let player_state = &mut ctx.accounts.player_state;
        require!(!player_state.pending, GameError::PlayAlreadyPending);

        ensure_owner(player_state, owner)?;
        require!(
            authority == player_state.player || authority == player_state.delegate,
            GameError::UnauthorizedSigner
        );

        let config = &ctx.accounts.config;
        if !player_state.spins_seeded {
            // Toplama (ADD) — üzerine YAZMA: oyuncu ilk hiç oynamadan önce
            // paket satın almış olabilir (buy_spins zaten spins_remaining'i
            // artırır), bu durumda ücretsiz hakları o bakiyenin ÜZERİNE
            // eklemek gerekir, üzerine yazıp satın alınan spinleri
            // silmemek gerekir. `spins_seeded` bayrağı bu eklemenin yalnızca
            // bir kez olmasını garanti eder.
            player_state.spins_remaining = player_state
                .spins_remaining
                .checked_add(config.free_plays as u32)
                .ok_or(GameError::MathOverflow)?;
            player_state.spins_seeded = true;
        }
        require!(player_state.spins_remaining > 0, GameError::NoSpinsRemaining);

        player_state.spins_remaining -= 1;
        player_state.plays_count = player_state
            .plays_count
            .checked_add(1)
            .ok_or(GameError::MathOverflow)?;

        // Ücretsiz haklar tam bitince (ve daha önce bonus verilmediyse) tek
        // seferlik +1 bonus deneme veriyoruz — frontend bunu bildirimle
        // gösterir (bkz. PlayCommitted.bonus_granted).
        //
        // Koşul EŞİTLİK değil, ">=" olmak zorunda. Eşitlikken
        // (`plays_count == free_plays`) ücretsiz haklarını kullanmadan ÖNCE
        // paket alan oyuncu bonusu HİÇ ALAMIYORDU: satın alınan spinler de
        // aynı bakiyeye eklendiği için bakiye 3'te değil 4'te sıfırlanıyor
        // ve eşitlik hiç tutmuyordu. Testle doğrulandı (bkz.
        // `paket_once_alinsa_da_bonus_veriliyor`).
        //
        // `free_plays > 0` şartı da gerekli: ücretsiz hak yokken hiç kimse
        // bonus almamalı, yoksa ">=" herkese ilk oyundan sonra bedava spin
        // verirdi.
        let mut bonus_granted = false;
        if player_state.spins_remaining == 0
            && !player_state.bonus_granted
            && config.free_plays > 0
            && player_state.plays_count >= config.free_plays as u32
        {
            player_state.spins_remaining = 1;
            player_state.bonus_granted = true;
            bonus_granted = true;
        }

        player_state.pending = true;
        player_state.commit_slot = Clock::get()?.slot;
        player_state.bump = ctx.bumps.player_state;

        // BAHSİN KOYULDUĞU ANDAKİ KURALLARI DONDUR.
        // resolve() bunları okuyacak; update_config bu bahsi artık
        // etkileyemez.
        player_state.bet_small_prize_lamports = config.small_prize_lamports;
        player_state.bet_big_prize_lamports = config.big_prize_lamports;
        player_state.bet_vault_easy_threshold_lamports = config.vault_easy_threshold_lamports;
        player_state.bet_big_prize_bps = config.big_prize_bps;
        player_state.bet_normal_win_bps = config.normal_win_bps;
        player_state.bet_easy_win_bps = config.easy_win_bps;
        player_state.bet_treasury_fee_bps = config.treasury_fee_bps;

        emit!(PlayCommitted {
            player: owner,
            plays_count: player_state.plays_count,
            spins_remaining: player_state.spins_remaining,
            bonus_granted,
            commit_slot: player_state.commit_slot,
        });

        Ok(())
    }

    /// Bekleyen oyunu sonuçlandırır ("reveal" adımı). İzinsiz (permissionless)
    /// — oyuncunun kendisi, delegesi ya da başka biri/bir "keeper"
    /// çağırabilir; sonucu kimin gönderdiği önemli değil çünkü sonuç zaten
    /// `commit_slot + reveal_delay_slots` slot'unun hash'iyle DETERMİNİSTİK
    /// olarak belirli, çağıran taraf hiçbir şeyi etkileyemez. Kazanç HER
    /// ZAMAN `player_state.player`'a (gerçek cüzdana) ödenir, çağırana değil.
    ///
    /// Neden commit'ten `reveal_delay_slots` sonraki bir slot'un hash'i
    /// kullanılıyor: `play()` anında bu slot henüz gerçekleşmediği için
    /// hash'i kimse (biz dahil) bilemez/tahmin edemez. Eğer bunun yerine
    /// `play()` anındaki GÜNCEL slot'un hash'i kullanılsaydı, bir oyuncu
    /// işlemi imzalamadan önce cüzdanının/RPC'nin `simulateTransaction`
    /// özelliğiyle sonucu ücretsiz önizleyip yalnızca kazandığında
    /// gönderebilirdi — bu "commit sonra reveal" yapısı tam olarak bunu
    /// engellemek için var (Onurproje'deki `reveal_winner`'ın "10 slot
    /// sonra" yaklaşımıyla aynı mantık).
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        // `player` hesabının gerçekten bu player_state'in sahibi olduğunu
        // burada, fonksiyon gövdesinde doğruluyoruz — `#[account(address =
        // player_state.player)]` gibi bir makro kısıtı, seeds'i player'ın
        // kendisine bağlı olan player_state'in (bkz. Resolve struct'ı)
        // player'dan SONRA bildirilmiş olmasını gerektiriyor, bu da ters
        // yönlü bir referansı imkansız kılıyor; bu yüzden sell-lock'taki
        // `RegisterLaunch`'ın yaptığı gibi çalışma zamanı kontrolü kullanıyoruz.
        require_keys_eq!(
            ctx.accounts.player.key(),
            ctx.accounts.player_state.player,
            GameError::PlayerMismatch
        );

        let player_state = &mut ctx.accounts.player_state;
        require!(player_state.pending, GameError::NoPendingPlay);

        let config = &ctx.accounts.config;
        let target_slot = player_state
            .commit_slot
            .checked_add(config.reveal_delay_slots)
            .ok_or(GameError::MathOverflow)?;
        let current_slot = Clock::get()?.slot;

        require!(current_slot >= target_slot, GameError::TooEarlyToResolve);
        require!(
            current_slot <= target_slot.saturating_add(MAX_RESOLVE_WINDOW_SLOTS),
            GameError::ResolveWindowExpired
        );

        require_keys_eq!(
            ctx.accounts.slot_hashes.key(),
            slot_hashes::ID,
            GameError::InvalidSlotHashesAccount
        );
        let sysvar_data = ctx.accounts.slot_hashes.try_borrow_data()?;
        // Hedef slot atlanmış olabilir (lideri blok üretememiş olabilir); o
        // durumda ondan SONRAKİ ilk üretilmiş slot kullanılıyor. Üst sınır
        // resolve penceresinin kendisi — arama pencerenin dışına taşamaz.
        let (entropy_slot, target_hash) = find_slot_hash_at_or_after(
            &sysvar_data,
            target_slot,
            target_slot.saturating_add(MAX_RESOLVE_WINDOW_SLOTS),
        )
        .ok_or(GameError::SlotHashNotFound)?;
        drop(sysvar_data);

        // Rastgelelik: kullanılan slot'un hash'i + slot numarası + oyuncunun
        // pubkey'i + oyun sayacı (nonce). Slot numarası preimage'a dahil:
        // hangi slot'un kullanıldığı artık sabit değil (atlanma durumunda
        // kayabiliyor), dolayısıyla sonucun hangi slot'a dayandığı da
        // hash'in içinde kayıtlı olsun — böylece dışarıdan doğrulayan biri
        // yanlış slot'la aynı sonucu üretemez. Nonce eklemek, aynı oyuncunun aynı slot'ta yanlışlıkla
        // iki kez resolve edilmeye çalışılmasını (olmaması gerekir ama) veya
        // farklı oyuncuların aynı hash'i paylaşmasını (pubkey zaten bunu
        // engelliyor ama nonce ekstra güvenlik) anlamsız kılar.
        let mut preimage = Vec::with_capacity(32 + 8 + 32 + 4);
        preimage.extend_from_slice(&target_hash);
        preimage.extend_from_slice(&entropy_slot.to_le_bytes());
        preimage.extend_from_slice(ctx.accounts.player.key.as_ref());
        preimage.extend_from_slice(&player_state.plays_count.to_le_bytes());
        let digest = anchor_lang::solana_program::hash::hash(&preimage).to_bytes();
        // Zarı 8 BAYTTAN üretiyoruz, 2 bayttan değil — sebebi modulo
        // yanlılığı (modulo bias):
        //
        // 2 bayt = 0..65535 arası 65536 değer. 65536, 10000'in tam katı
        // değil (65536 = 6 × 10000 + 5536), dolayısıyla 0..5535 arası her
        // sonuç 7 kez, 5536..9999 arası her sonuç 6 kez temsil ediliyordu.
        // Kazanma eşiği hep aralığın BAŞINDA olduğu için (roll < win_bps)
        // bu, ilan edilen oranların hepsini kasa aleyhine kaydırıyordu:
        //   zor mod  %0,50 → %0,534   (göreli +%6,8)
        //   kolay    %10,00 → %10,681 (göreli +%6,8)
        //   jackpot  %30,00 → %32,043 (göreli +%6,8)
        // Tek bir turda fark edilmez ama binlerce turda kasadan sistematik
        // olarak sızar ve ilan ettiğimiz oranlar gerçeği yansıtmaz.
        //
        // 8 baytta (0..2^64-1) aynı yanlılık ~5×10^-16 mertebesine düşüyor,
        // yani ölçülemez hale geliyor.
        let roll = (u64::from_le_bytes(
            digest[0..8].try_into().map_err(|_| GameError::MathOverflow)?,
        ) % BPS_DENOMINATOR as u64) as u32;
        // İkinci, bağımsız bir zar: SADECE kazanıldığında hangi ödül
        // katmanının (küçük/büyük) ödeneceğine karar verir. Aynı digest'in
        // AYRI baytlarını kullanmak (0-7 win/lose için, 8-15 burada) ayrı
        // bir hash hesaplamaya gerek bırakmıyor.
        let tier_roll = (u64::from_le_bytes(
            digest[8..16].try_into().map_err(|_| GameError::MathOverflow)?,
        ) % BPS_DENOMINATOR as u64) as u32;

        // BAHSİN KOYULDUĞU ANDAKİ KURALLAR — config'ten DEĞİL, player_state'ten.
        //
        // Eskiden burada güncel config okunuyordu; yani yetkili, bekleyen bir
        // bahsi gördükten sonra oranı düşürüp o bahsi etkileyebilirdi.
        // Doğrulanabilir adalet iddiasında bulunan bir oyunda bu kabul
        // edilemezdi. play() artık bu değerleri donduruyor.
        //
        // Kasa BAKİYESİ dondurulmuyor ve dondurulmamalı: "kolay mod" kasanın
        // o anki doluluğuna bağlı ve bu kasıtlı — kasa doldukça oranlar
        // herkes için iyileşiyor. Dondurulan şey EŞİK, bakiye değil.
        let rent_exempt = Rent::get()?.minimum_balance(0);
        let vault_balance = ctx
            .accounts
            .vault
            .lamports()
            .saturating_sub(rent_exempt);
        let easy_mode = vault_balance >= player_state.bet_vault_easy_threshold_lamports;
        let win_bps = if easy_mode {
            player_state.bet_easy_win_bps
        } else {
            player_state.bet_normal_win_bps
        };
        // `normal_win_bps` sıfırdan büyük ayarlanırsa (yani "zor modda" da
        // küçük bir kazanma ihtimali varsa), kasa henüz `big_prize_lamports`
        // kadar dolmamışken bile nadiren kazanma şartı tutabilir. Bu durumda
        // ödemeyi REDDEDİP TÜM İŞLEMİ GERİ ALMAK yerine (ki bu, oyuncuyu
        // kalıcı olarak `pending = true` durumunda, forfeit_stuck_play
        // penceresi açılana kadar sıkıştırırdı) sessizce kayıp say —
        // oyuncu parasını kaybeder ama en azından tekrar oynayabilir.
        // Kasanın en büyük olası ÖDEMEYİ karşılayabildiğini burada kontrol
        // ediyoruz ki hangi katman tutarsa tutsun ödeme garantili olsun:
        // jackpot + onun üstüne eklenen operasyon payı. Payı bu hesaba dahil
        // etmezsek, kasa tam jackpot kadar doluyken kazanan bir tur ödülü
        // öder ama payı ödeyemez, TÜM işlem geri alınır ve oyuncu
        // `pending = true` durumunda sıkışırdı. Eşik kontrolü
        // (`vault_easy_threshold_lamports >= jackpot + pay`) zaten
        // initialize/update_config'te zorunlu kılındığı için "kolay modda"
        // bu dala hiç girilmemesi beklenir; bu tamamen savunma amaçlı.
        let max_payout = player_state
            .bet_big_prize_lamports
            .checked_add(ops_fee_lamports(
                player_state.bet_big_prize_lamports,
                player_state.bet_treasury_fee_bps,
            )?)
            .ok_or(GameError::MathOverflow)?;
        let won = roll < win_bps as u32 && vault_balance >= max_payout;

        let mut prize_paid: u64 = 0;
        let mut ops_fee_paid: u64 = 0;
        let mut is_big_win = false;
        if won {
            is_big_win = tier_roll < player_state.bet_big_prize_bps as u32;
            let prize_amount = if is_big_win {
                player_state.bet_big_prize_lamports
            } else {
                player_state.bet_small_prize_lamports
            };

            let config_key = ctx.accounts.config.key();
            let vault_bump = config.vault_bump;
            let signer_seeds: &[&[u8]] = &[VAULT_SEED, config_key.as_ref(), &[vault_bump]];

            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    SolTransfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.player.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                prize_amount,
            )?;

            // Operasyon payı: ödülün `treasury_fee_bps` kadarı, ödülden
            // KESİLMEDEN, kasadan ayrıca hazineye. Oyuncu ilan edilen ödülün
            // tamamını alır (0,5 SOL ödülde tam 0,5 SOL); kasadan çıkan
            // toplam 0,6 SOL olur.
            ops_fee_paid = ops_fee_lamports(prize_amount, player_state.bet_treasury_fee_bps)?;
            if ops_fee_paid > 0 {
                system_program::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.to_account_info(),
                        SolTransfer {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.treasury.to_account_info(),
                        },
                        &[signer_seeds],
                    ),
                    ops_fee_paid,
                )?;
            }

            prize_paid = prize_amount;
            player_state.wins_count = player_state
                .wins_count
                .checked_add(1)
                .ok_or(GameError::MathOverflow)?;
            player_state.total_won_lamports = player_state
                .total_won_lamports
                .checked_add(prize_paid)
                .ok_or(GameError::MathOverflow)?;
        }

        player_state.pending = false;

        emit!(PlayResolved {
            player: ctx.accounts.player.key(),
            won,
            prize_paid,
            is_big_win,
            easy_mode,
            ops_fee_paid,
        });

        Ok(())
    }

    /// Bir oyuncu `resolve()`'u zamanında (kendi ya da bir başkası)
    /// çağırtmayı unutur/başaramazsa ve `MAX_RESOLVE_WINDOW_SLOTS` penceresi
    /// kapanırsa, hedef slot'un hash'i artık SlotHashes sysvar'ında
    /// bulunamayacağı için o oyun SONSUZA DEK resolve edilemez hale gelir —
    /// bu da oyuncunun `pending = true` durumunda sıkışıp bir daha
    /// oynayamamasına yol açardı. Bu fonksiyon SADECE oyuncunun kendisi
    /// tarafından, pencere gerçekten kapandıktan SONRA çağrılabilir; o
    /// denemeyi kaybedilmiş sayıp (harcanan spin kredisi iade edilmez —
    /// normal bir kayıp gibi muamele) `pending`'i temizler ve oyuncunun
    /// tekrar oynamasına izin verir.
    pub fn forfeit_stuck_play(ctx: Context<ForfeitStuckPlay>) -> Result<()> {
        let player_state = &mut ctx.accounts.player_state;
        require!(player_state.pending, GameError::NoPendingPlay);

        let config = &ctx.accounts.config;
        let target_slot = player_state
            .commit_slot
            .checked_add(config.reveal_delay_slots)
            .ok_or(GameError::MathOverflow)?;
        let current_slot = Clock::get()?.slot;
        require!(
            current_slot > target_slot.saturating_add(MAX_RESOLVE_WINDOW_SLOTS),
            GameError::ResolveWindowStillOpen
        );

        player_state.pending = false;

        Ok(())
    }
}

/// Bir PlayerState PDA'sının ilk kez dokunulduğu anda `player` alanını
/// yazar; sonraki her çağrıda o alanın gerçekten aynı sahibe ait olduğunu
/// doğrular. `play()`, `buy_spins()` ve `register_delegate()` arasından
/// hangisi PDA'ya önce dokunursa dokunsun aynı davranışı garantiler.
fn ensure_owner(player_state: &mut PlayerState, owner: Pubkey) -> Result<()> {
    if !player_state.initialized {
        player_state.player = owner;
        player_state.initialized = true;
    } else {
        require_keys_eq!(player_state.player, owner, GameError::PlayerMismatch);
    }
    Ok(())
}

/// SlotHashes sysvar'ında `target_slot`'tan itibaren blok ÜRETMİŞ ilk
/// slot'un hash'ini bulur.
///
/// Neden "tam olarak target_slot" değil: Solana'da slot'lar atlanabilir —
/// o slot'un lideri blok üretemezse o slot SlotHashes'e hiç girmez.
/// Eskiden burada tam eşleşme aranıyordu, dolayısıyla hedef slot
/// atlandığında o oyun SONSUZA DEK sonuçlandırılamıyordu: oyuncu
/// pencerenin kapanmasını bekleyip forfeit etmek ve spinini kaybetmek
/// zorunda kalıyordu. Devnet'te atlanma oranı yer yer %5-15 olduğu için
/// bu, her 10-20 spinde bir sessizce yaşanan gerçek bir para kaybıydı.
///
/// İleri doğru arama rastgeleliği zayıflatmıyor: hangi slot'un
/// atlanacağını oyuncu ne bilebiliyor ne etkileyebiliyor, ve seçilen slot
/// bir kez ortaya çıktıktan sonra DEĞİŞMİYOR (daha büyük slot'lar
/// eklendikçe "target'tan büyük en küçük slot" aynı kalır) — yani sonuç
/// hâlâ deterministik ve herkesçe doğrulanabilir.
///
/// Ham hesap verisini elle çözümler. Bu sysvar
/// "büyük" sysvar'lardan biri olduğu için (Clock/Rent gibi hızlı syscall'la
/// değil) hesap verisi olarak geçirilip bincode formatına göre okunmalı:
/// ilk 8 bayt = kayıt sayısı (u64, little-endian), ardından her kayıt için
/// 8 bayt slot numarası + 32 bayt hash, en yeni slot en başta olacak şekilde
/// azalan sırada. Kütüphanenin kendi `SlotHashes` tipini kullanmak yerine
/// elle çözümlüyoruz çünkü bu ortamda `anchor build` çalıştırıp API'yi
/// doğrulayamıyoruz (bkz. program/sell-lock/programs/sell-lock/Cargo.toml'daki
/// aynı uyarı) — ham bayt formatı ise Solana runtime'ının dokümante edilmiş,
/// kararlı bir parçası.
/// Bir ödül ödemesinin üstüne eklenen operasyon payını hesaplar.
///
/// Oyunun para akışında TEK bir "ev payı" oranı var: `treasury_fee_bps`
/// (varsayılan 2000 = %20). İki yerde birden uygulanıyor —
///   1. `buy_spins()`: ödenen paketin %20'si doğrudan hazineye gider,
///      %80'i kasaya (vault) girer.
///   2. `resolve()`: kazanılan her ödülde, ödülün %20'si KADAR EK bir tutar
///      kasadan hazineye aktarılır — oyuncunun ödülünden KESİLMEZ. Yani
///      0,5 SOL'luk bir ödülde oyuncu tam 0,5 SOL alır, hazineye ayrıca
///      0,1 SOL gider; kasadan toplam 0,6 SOL çıkar.
///
/// İkisinin tek orana bağlı olması kasıtlı: "biz %20 alıyoruz" cümlesi hem
/// yatırmada hem ödülde aynı anlama gelsin, iki ayrı sayı takip etmek
/// gerekmesin.
fn ops_fee_lamports(prize_lamports: u64, fee_bps: u16) -> Result<u64> {
    Ok((prize_lamports as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(GameError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(GameError::MathOverflow)? as u64)
}

fn find_slot_hash_at_or_after(
    sysvar_data: &[u8],
    target_slot: u64,
    max_slot: u64,
) -> Option<(u64, [u8; 32])> {
    if sysvar_data.len() < 8 {
        return None;
    }
    let len = u64::from_le_bytes(sysvar_data[0..8].try_into().ok()?) as usize;
    let mut offset = 8usize;
    let mut best: Option<(u64, [u8; 32])> = None;
    for _ in 0..len {
        if offset + 40 > sysvar_data.len() {
            break;
        }
        let slot = u64::from_le_bytes(sysvar_data[offset..offset + 8].try_into().ok()?);
        offset += 40;

        // Sysvar en yeniden eskiye sıralı. Baştaki kayıtlar penceremizin
        // ÜSTÜNDE kalıyor, atlıyoruz.
        if slot > max_slot {
            continue;
        }
        // Hedefin altına düştük: sıralama azalan olduğu için bundan
        // sonrakiler daha da küçük, bakmaya gerek yok. Bu erken çıkış
        // taramayı kısa tutuyor — hedef her zaman yakın geçmişte olduğundan
        // pratikte birkaç kayıt sonra duruyoruz. 512 kaydın tamamını her
        // seferinde taramak, resolve() gibi her spinde çağrılan bir
        // talimatta gereksiz işlem birimi (compute unit) maliyeti olurdu.
        if slot < target_slot {
            break;
        }
        // Pencerenin içindeyiz. Azalan sırada ilerlediğimiz için her yeni
        // eşleşme bir öncekinden KÜÇÜK; döngü bittiğinde elimizde hedefe en
        // yakın (en küçük uygun) slot kalıyor. Hedefe en yakını seçmek
        // önemli: o slot bir kez ortaya çıktıktan sonra bir daha değişmiyor,
        // dolayısıyla sonuç deterministik kalıyor.
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&sysvar_data[offset - 32..offset]);
        best = Some((slot, hash));
    }
    best
}

#[account]
pub struct GameConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub free_plays: u8,
    pub small_prize_lamports: u64,
    pub big_prize_lamports: u64,
    // Kazanılan bir oyunda büyük (jackpot) ödülün ödenme ihtimali (bps);
    // geri kalanı küçük ödül olarak ödenir.
    pub big_prize_bps: u16,
    pub vault_easy_threshold_lamports: u64,
    pub normal_win_bps: u16,
    pub easy_win_bps: u16,
    pub treasury_fee_bps: u16,
    pub reveal_delay_slots: u64,
    // Spin paketi tarifesi: spin_tier_counts[i] adet spin, spin_tier_prices[i]
    // lamport karşılığında satın alınır (bkz. buy_spins). Örn. varsayılan:
    // 1/0.1 SOL, 5/0.3, 10/0.5, 20/0.8, 50/1.5, 100/2.5.
    pub spin_tier_counts: [u16; SPIN_TIERS],
    pub spin_tier_prices: [u64; SPIN_TIERS],
    pub vault_bump: u8,
    pub bump: u8,
}

impl GameConfig {
    // 8 (disc) + 32*2 (pubkeys) + 1 + 8 + 8 + 2 + 8 + 2*3 + 8 + (2*6) + (8*6) + 1 + 1
    pub const LEN: usize =
        8 + 32 * 2 + 1 + 8 + 8 + 2 + 8 + 2 * 3 + 8 + (2 * SPIN_TIERS) + (8 * SPIN_TIERS) + 1 + 1;
}

#[account]
pub struct PlayerState {
    pub player: Pubkey,
    pub plays_count: u32,
    pub wins_count: u32,
    pub pending: bool,
    pub commit_slot: u64,
    pub bump: u8,
    // `player` alanı yazıldı mı (play/buy_spins/register_delegate'tan hangisi
    // önce dokunursa).
    pub initialized: bool,
    // Ücretsiz haklar spins_remaining'e yüklendi mi (ilk play() çağrısında).
    pub spins_seeded: bool,
    pub spins_remaining: u32,
    // Tarayıcıda saklanan, bu oyuncunun spin kredisini onun adına harcamaya
    // yetkili yerel anahtar (bkz. register_delegate). Kayıtlı değilse
    // Pubkey::default().
    pub delegate: Pubkey,
    pub total_won_lamports: u64,
    // Ücretsiz haklar bitince verilen tek seferlik +1 bonus spin kullanıldı mı.
    pub bonus_granted: bool,

    // --- BAHSİN KOYULDUĞU ANDAKİ KURALLAR ---------------------------------
    // `play()` bunları config'ten kopyalıyor, `resolve()` config yerine
    // bunları okuyor. Böylece oyuncu bahsini koyduğu andaki oranlarla
    // sonuçlanıyor ve yetkilinin bekleyen bir bahsin kurallarını sonradan
    // değiştirmesi mümkün olmuyor.
    //
    // Sıfır olmaları "henüz oynanmadı" demek; resolve zaten `pending`
    // olmadan çalışmıyor, yani bu alanlar okunduğunda hep doludur.
    pub bet_small_prize_lamports: u64,
    pub bet_big_prize_lamports: u64,
    pub bet_vault_easy_threshold_lamports: u64,
    pub bet_big_prize_bps: u16,
    pub bet_normal_win_bps: u16,
    pub bet_easy_win_bps: u16,
    pub bet_treasury_fee_bps: u16,
}

impl PlayerState {
    // 8 (disc) + 32 + 4 + 4 + 1 + 8 + 1 + 1 + 1 + 4 + 32 + 8 + 1
    //   + bahis anındaki kurallar: 8 + 8 + 8 + 2 + 2 + 2 + 2 = 32 bayt
    pub const LEN: usize =
        8 + 32 + 4 + 4 + 1 + 8 + 1 + 1 + 1 + 4 + 32 + 8 + 1 + 8 + 8 + 8 + 2 + 2 + 2 + 2;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = GameConfig::LEN,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, GameConfig>,

    /// CHECK: yalnızca adres olarak GameConfig'e kaydediliyor; ücret payı
    /// buraya gönderilecek, tipi önemli değil (herhangi bir cüzdan olabilir).
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, GameConfig>,
}

#[derive(Accounts)]
pub struct BuySpins<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        init_if_needed,
        payer = player,
        space = PlayerState::LEN,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_state: Account<'info, PlayerState>,

    /// CHECK: Sadece SOL tutan, veri içermeyen bir PDA (locked-pool'daki
    /// pool_authority ile aynı desen) — ilk transferde kendiliğinden var olur.
    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: yalnızca config.treasury ile eşleştiği doğrulanan, ücret
    /// payının gönderildiği adres.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// Arayanın kayıtlı delegesi (varsa) — sadece gaz tamponunu tazelemek
    /// için gövdede `player_state.delegate` ile karşılaştırılıyor, kayıtlı
    /// delege yoksa/eşleşmiyorsa top-up sessizce atlanır. Client, oyuncunun
    /// yerel delege anahtarını her zaman buraya geçirir.
    /// CHECK: kimliği gövdede karşılaştırılıyor, olası bir uyuşmazlıkta
    /// sadece top-up atlanır, işlem başarısız olmaz.
    #[account(mut)]
    pub delegate: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterDelegate<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        init_if_needed,
        payer = player,
        space = PlayerState::LEN,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_state: Account<'info, PlayerState>,

    /// CHECK: Sadece SOL tutan, veri içermeyen bir PDA — ilk kasa
    /// sponsorluğunun (ücretsiz denemenin gerçekten ücretsiz olması için)
    /// kaynağı.
    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// Yetkilendirilecek yerel delege anahtarı — ilk kayıtta kasa
    /// sponsorluğunun hedefi.
    /// CHECK: sadece SOL transferinin hedefi, program tarafından ayrıca
    /// doğrulanmıyor (oyuncunun kendi seçimi, kendi imzasıyla).
    #[account(mut)]
    pub delegate: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    /// Gerçek oyuncunun adresi — PlayerState PDA'sı bu adresten türetilir.
    /// İmzalamak ZORUNDA değil; aşağıdaki `authority` (kendisi ya da
    /// kayıtlı delegesi) imzalar. Gerçek kimlik eşleşmesi gövdede
    /// (`ensure_owner`) ve `player_state.delegate` karşılaştırmasıyla
    /// sağlanıyor.
    /// CHECK: yalnızca PDA türetmek için kullanılan bir adres.
    pub owner: UncheckedAccount<'info>,

    /// Bu işlemi gerçekten imzalayan taraf — oyuncunun kendisi ya da
    /// `register_delegate()` ile kaydedilmiş yerel delegesi olabilir
    /// (gövdede doğrulanıyor). PlayerState ilk kez bu çağrıda
    /// oluşturuluyorsa (daha önce hiç buy_spins/register_delegate
    /// çağrılmadıysa) rent bedelini de bu hesap öder.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = PlayerState::LEN,
        seeds = [PLAYER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub player_state: Account<'info, PlayerState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    /// Ücretsiz (permissionless) çağrı — kazanan/kaybeden zaten hedef
    /// slot'un hash'iyle belirlendiği için burada imza kontrolü gerekmiyor.
    /// Yine de ödül SADECE bu hesaba (oyunu başlatan cüzdana) gidiyor;
    /// çağıranın kendisi olması şart değil. Bu hesabın gerçekten
    /// `player_state.player` ile eşleştiği, seeds sırası yüzünden burada
    /// makro kısıtıyla ifade edilemiyor — bkz. `resolve()` gövdesindeki
    /// `require_keys_eq!` kontrolü.
    /// CHECK: kimliği fonksiyon gövdesinde doğrulanıyor.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_state.bump,
    )]
    pub player_state: Account<'info, PlayerState>,

    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// Kazanılan turlarda, ödülün üstüne eklenen operasyon payının gittiği
    /// adres — `buy_spins()`'teki %20 payla aynı cüzdan.
    /// CHECK: yalnızca `config.treasury` ile eşleştiği doğrulanan bir adres.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: adresi elle `slot_hashes::ID` ile karşılaştırılıyor (require_keys_eq!).
    pub slot_hashes: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ForfeitStuckPlay<'info> {
    pub player: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GameConfig>,

    #[account(
        mut,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump = player_state.bump,
        has_one = player,
    )]
    pub player_state: Account<'info, PlayerState>,
}

#[event]
pub struct SpinsPurchased {
    pub player: Pubkey,
    pub tier_index: u8,
    pub spin_count: u32,
    pub price_lamports: u64,
    pub spins_remaining: u32,
}

#[event]
pub struct PlayCommitted {
    pub player: Pubkey,
    pub plays_count: u32,
    pub spins_remaining: u32,
    pub bonus_granted: bool,
    pub commit_slot: u64,
}

#[event]
pub struct PlayResolved {
    pub player: Pubkey,
    pub won: bool,
    pub prize_paid: u64,
    pub is_big_win: bool,
    pub easy_mode: bool,
    // Ödülün üstüne, kasadan hazineye ayrıca aktarılan operasyon payı.
    // Alanın SONA eklenmesi kasıtlı: önceki alanların bayt konumları
    // değişmediği için eski istemciler olayı okumaya devam edebilir.
    pub ops_fee_paid: u64,
}

#[error_code]
pub enum GameError {
    #[msg("Geçersiz parametre.")]
    InvalidParam,
    #[msg("Matematik taşması.")]
    MathOverflow,
    #[msg("Bu cüzdanın zaten sonuçlanmamış bir oyunu var — önce onu resolve edin.")]
    PlayAlreadyPending,
    #[msg("Bekleyen bir oyun yok.")]
    NoPendingPlay,
    #[msg("player hesabı bu player_state'in sahibiyle eşleşmiyor.")]
    PlayerMismatch,
    #[msg("Bu işlemi imzalayan ne oyuncunun kendisi ne de kayıtlı delegesi.")]
    UnauthorizedSigner,
    #[msg("Kalan spin kredisi yok — önce buy_spins() ile paket satın alın.")]
    NoSpinsRemaining,
    #[msg("Henüz resolve edilemez — hedef slot'a ulaşılmadı.")]
    TooEarlyToResolve,
    #[msg("Resolve penceresi kapandı, bkz. forfeit_stuck_play.")]
    ResolveWindowExpired,
    #[msg("Resolve penceresi henüz kapanmadı — önce resolve() deneyin.")]
    ResolveWindowStillOpen,
    #[msg("Geçersiz SlotHashes sysvar hesabı.")]
    InvalidSlotHashesAccount,
    #[msg("Hedef slot'un hash'i SlotHashes sysvar'ında bulunamadı.")]
    SlotHashNotFound,
}
