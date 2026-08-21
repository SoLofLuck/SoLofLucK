use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::slot_hashes;
use anchor_lang::system_program::{self, Transfer as SolTransfer};

// Solana Playground üzerinden Devnet'e deploy edildikten sonra bu placeholder
// gerçek program ID'siyle değiştirilmeli (bkz. program/luck-game/README.md).
declare_id!("6oxR8J5QhV2RvQzVB2kNKQ8XrZJt7AZF3eCnQXuGuydp");

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
        require!(
            vault_easy_threshold_lamports >= big_prize_lamports,
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

    /// Parametreleri sonradan ayarlamak için (ör. paket tarifesini/oranları
    /// güncelleme). Yalnızca `config.authority` çağırabilir. Devam eden
    /// (pending) oyunları etkilemez — onlar zaten commit anındaki kurallara
    /// göre resolve olur çünkü resolve() ihtimalleri GÜNCEL config'ten
    /// okur; bu kasıtlı basit bir tasarım, kritik değilse (ör. sadece
    /// tarife güncellemesi) sorun değil, ama oran değişikliklerinin
    /// bekleyen oyunları etkileyebileceğini unutmayın.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
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
        require!(
            vault_easy_threshold_lamports >= big_prize_lamports,
            GameError::InvalidParam
        );
        for i in 0..SPIN_TIERS {
            require!(
                spin_tier_counts[i] > 0 && spin_tier_prices[i] > 0,
                GameError::InvalidParam
            );
        }

        let config = &mut ctx.accounts.config;
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
    pub fn buy_spins(ctx: Context<BuySpins>, tier_index: u8) -> Result<()> {
        let config = &ctx.accounts.config;
        require!((tier_index as usize) < SPIN_TIERS, GameError::InvalidParam);
        let spin_count = config.spin_tier_counts[tier_index as usize] as u32;
        let price = config.spin_tier_prices[tier_index as usize];

        let treasury_amount = (price as u128)
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
    pub fn register_delegate(ctx: Context<RegisterDelegate>, delegate: Pubkey) -> Result<()> {
        let owner = ctx.accounts.player.key();
        let player_state = &mut ctx.accounts.player_state;
        ensure_owner(player_state, owner)?;
        player_state.delegate = delegate;
        player_state.bump = ctx.bumps.player_state;
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
            player_state.spins_remaining = config.free_plays as u32;
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
        let mut bonus_granted = false;
        if player_state.spins_remaining == 0
            && !player_state.bonus_granted
            && player_state.plays_count == config.free_plays as u32
        {
            player_state.spins_remaining = 1;
            player_state.bonus_granted = true;
            bonus_granted = true;
        }

        player_state.pending = true;
        player_state.commit_slot = Clock::get()?.slot;
        player_state.bump = ctx.bumps.player_state;

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
        let target_hash =
            find_slot_hash(&sysvar_data, target_slot).ok_or(GameError::SlotHashNotFound)?;
        drop(sysvar_data);

        // Rastgelelik: hedef slot'un hash'i + oyuncunun pubkey'i + oyun
        // sayacı (nonce). Nonce eklemek, aynı oyuncunun aynı slot'ta yanlışlıkla
        // iki kez resolve edilmeye çalışılmasını (olmaması gerekir ama) veya
        // farklı oyuncuların aynı hash'i paylaşmasını (pubkey zaten bunu
        // engelliyor ama nonce ekstra güvenlik) anlamsız kılar.
        let mut preimage = Vec::with_capacity(32 + 32 + 4);
        preimage.extend_from_slice(&target_hash);
        preimage.extend_from_slice(ctx.accounts.player.key.as_ref());
        preimage.extend_from_slice(&player_state.plays_count.to_le_bytes());
        let digest = anchor_lang::solana_program::hash::hash(&preimage).to_bytes();
        let roll = (u16::from_le_bytes([digest[0], digest[1]]) as u32) % BPS_DENOMINATOR;
        // İkinci, bağımsız bir zar: SADECE kazanıldığında hangi ödül
        // katmanının (küçük/büyük) ödeneceğine karar verir. Aynı digest'in
        // farklı baytlarını kullanmak (0-1 win/lose için, 2-3 burada) ayrı
        // bir hash hesaplamaya gerek bırakmıyor.
        let tier_roll = (u16::from_le_bytes([digest[2], digest[3]]) as u32) % BPS_DENOMINATOR;

        let rent_exempt = Rent::get()?.minimum_balance(0);
        let vault_balance = ctx
            .accounts
            .vault
            .lamports()
            .saturating_sub(rent_exempt);
        let easy_mode = vault_balance >= config.vault_easy_threshold_lamports;
        let win_bps = if easy_mode {
            config.easy_win_bps
        } else {
            config.normal_win_bps
        };
        // `normal_win_bps` sıfırdan büyük ayarlanırsa (yani "zor modda" da
        // küçük bir kazanma ihtimali varsa), kasa henüz `big_prize_lamports`
        // kadar dolmamışken bile nadiren kazanma şartı tutabilir. Bu durumda
        // ödemeyi REDDEDİP TÜM İŞLEMİ GERİ ALMAK yerine (ki bu, oyuncuyu
        // kalıcı olarak `pending = true` durumunda, forfeit_stuck_play
        // penceresi açılana kadar sıkıştırırdı) sessizce kayıp say —
        // oyuncu parasını kaybeder ama en azından tekrar oynayabilir.
        // Kasanın en büyük olası ödülü (jackpot) karşılayabildiğini burada
        // kontrol ediyoruz ki hangi katman tutarsa tutsun ödeme garantili
        // olsun; `vault_easy_threshold_lamports >= big_prize_lamports` zaten
        // initialize/update_config'te zorunlu kılındığı için "kolay modda"
        // bu dala hiç girilmemesi beklenir; bu tamamen savunma amaçlı.
        let won = roll < win_bps as u32 && vault_balance >= config.big_prize_lamports;

        let mut prize_paid: u64 = 0;
        let mut is_big_win = false;
        if won {
            is_big_win = tier_roll < config.big_prize_bps as u32;
            let prize_amount = if is_big_win {
                config.big_prize_lamports
            } else {
                config.small_prize_lamports
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

/// SlotHashes sysvar'ının ham hesap verisini elle çözümler. Bu sysvar
/// "büyük" sysvar'lardan biri olduğu için (Clock/Rent gibi hızlı syscall'la
/// değil) hesap verisi olarak geçirilip bincode formatına göre okunmalı:
/// ilk 8 bayt = kayıt sayısı (u64, little-endian), ardından her kayıt için
/// 8 bayt slot numarası + 32 bayt hash, en yeni slot en başta olacak şekilde
/// azalan sırada. Kütüphanenin kendi `SlotHashes` tipini kullanmak yerine
/// elle çözümlüyoruz çünkü bu ortamda `anchor build` çalıştırıp API'yi
/// doğrulayamıyoruz (bkz. program/sell-lock/programs/sell-lock/Cargo.toml'daki
/// aynı uyarı) — ham bayt formatı ise Solana runtime'ının dokümante edilmiş,
/// kararlı bir parçası.
fn find_slot_hash(sysvar_data: &[u8], target_slot: u64) -> Option<[u8; 32]> {
    if sysvar_data.len() < 8 {
        return None;
    }
    let len = u64::from_le_bytes(sysvar_data[0..8].try_into().ok()?) as usize;
    let mut offset = 8usize;
    for _ in 0..len {
        if offset + 40 > sysvar_data.len() {
            break;
        }
        let slot = u64::from_le_bytes(sysvar_data[offset..offset + 8].try_into().ok()?);
        if slot == target_slot {
            let mut hash = [0u8; 32];
            hash.copy_from_slice(&sysvar_data[offset + 8..offset + 40]);
            return Some(hash);
        }
        offset += 40;
    }
    None
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
}

impl PlayerState {
    // 8 (disc) + 32 + 4 + 4 + 1 + 8 + 1 + 1 + 1 + 4 + 32 + 8 + 1
    pub const LEN: usize = 8 + 32 + 4 + 4 + 1 + 8 + 1 + 1 + 1 + 4 + 32 + 8 + 1;
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

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterDelegate<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        init_if_needed,
        payer = player,
        space = PlayerState::LEN,
        seeds = [PLAYER_SEED, player.key().as_ref()],
        bump,
    )]
    pub player_state: Account<'info, PlayerState>,

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
