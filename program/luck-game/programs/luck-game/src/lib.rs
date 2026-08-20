use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::slot_hashes;
use anchor_lang::system_program::{self, Transfer as SolTransfer};

// Solana Playground üzerinden Devnet'e deploy edildikten sonra bu placeholder
// gerçek program ID'siyle değiştirilmeli (bkz. program/luck-game/README.md).
declare_id!("11111111111111111111111111111111");

const CONFIG_SEED: &[u8] = b"config";
const VAULT_SEED: &[u8] = b"vault";
const PLAYER_SEED: &[u8] = b"player";

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

    /// Oyunu bir kez kurar: ücret/ödül/ihtimal parametrelerini ve hazine
    /// (treasury) cüzdanını GameConfig PDA'sına yazar. Kasa (vault) için ayrı
    /// bir "oluşturma" adımı yok — locked-pool'daki pool_authority'de olduğu
    /// gibi, ilk `play()` çağrısındaki transfer onu zaten var edecek.
    pub fn initialize(
        ctx: Context<Initialize>,
        entry_fee_lamports: u64,
        free_plays: u8,
        prize_lamports: u64,
        vault_easy_threshold_lamports: u64,
        normal_win_bps: u16,
        easy_win_bps: u16,
        treasury_fee_bps: u16,
        reveal_delay_slots: u64,
    ) -> Result<()> {
        require!(entry_fee_lamports > 0, GameError::InvalidParam);
        require!(prize_lamports > 0, GameError::InvalidParam);
        require!(reveal_delay_slots > 0, GameError::InvalidParam);
        require!(
            (normal_win_bps as u32) <= BPS_DENOMINATOR
                && (easy_win_bps as u32) <= BPS_DENOMINATOR
                && (treasury_fee_bps as u32) <= BPS_DENOMINATOR,
            GameError::InvalidParam
        );
        // "Kolay mod" normal moddan daha kolay olmalı, yoksa eşiğin hiç
        // anlamı kalmaz.
        require!(easy_win_bps >= normal_win_bps, GameError::InvalidParam);
        // Kasa eşiği, ödülü ödeyebilecek kadar büyük olmalı — aksi halde
        // "kolay mod" tetiklenip de kasada ödül için para olmayan bir durum
        // tasarım hatası olurdu.
        require!(
            vault_easy_threshold_lamports >= prize_lamports,
            GameError::InvalidParam
        );

        // Vault PDA'sının bump'ını burada bir kez hesaplayıp saklıyoruz ki
        // sonraki her play()/resolve() çağrısında tekrar tekrar
        // `find_program_address` aramasıyla (göreceli olarak pahalı) yeniden
        // hesaplamak yerine doğrudan kullanılabilsin — locked-pool'daki
        // `authority_bump` ile aynı optimizasyon.
        let config_key = ctx.accounts.config.key();
        let (_vault_pda, vault_bump) =
            Pubkey::find_program_address(&[VAULT_SEED, config_key.as_ref()], ctx.program_id);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = ctx.accounts.treasury.key();
        config.entry_fee_lamports = entry_fee_lamports;
        config.free_plays = free_plays;
        config.prize_lamports = prize_lamports;
        config.vault_easy_threshold_lamports = vault_easy_threshold_lamports;
        config.normal_win_bps = normal_win_bps;
        config.easy_win_bps = easy_win_bps;
        config.treasury_fee_bps = treasury_fee_bps;
        config.reveal_delay_slots = reveal_delay_slots;
        config.vault_bump = vault_bump;
        config.bump = ctx.bumps.config;

        Ok(())
    }

    /// Parametreleri sonradan ayarlamak için (ör. ücreti/oranları güncelleme).
    /// Yalnızca `config.authority` çağırabilir. Devam eden (pending) oyunları
    /// etkilemez — onlar zaten commit anındaki kurallara göre resolve olur
    /// çünkü resolve() ihtimalleri GÜNCEL config'ten okur; bu kasıtlı basit
    /// bir tasarım, kritik değilse (ör. sadece ücret güncellemesi) sorun
    /// değil, ama oran değişikliklerinin bekleyen oyunları etkileyebileceğini
    /// unutmayın.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        entry_fee_lamports: u64,
        free_plays: u8,
        prize_lamports: u64,
        vault_easy_threshold_lamports: u64,
        normal_win_bps: u16,
        easy_win_bps: u16,
        treasury_fee_bps: u16,
    ) -> Result<()> {
        require!(entry_fee_lamports > 0, GameError::InvalidParam);
        require!(prize_lamports > 0, GameError::InvalidParam);
        require!(
            (normal_win_bps as u32) <= BPS_DENOMINATOR
                && (easy_win_bps as u32) <= BPS_DENOMINATOR
                && (treasury_fee_bps as u32) <= BPS_DENOMINATOR,
            GameError::InvalidParam
        );
        require!(easy_win_bps >= normal_win_bps, GameError::InvalidParam);
        require!(
            vault_easy_threshold_lamports >= prize_lamports,
            GameError::InvalidParam
        );

        let config = &mut ctx.accounts.config;
        config.entry_fee_lamports = entry_fee_lamports;
        config.free_plays = free_plays;
        config.prize_lamports = prize_lamports;
        config.vault_easy_threshold_lamports = vault_easy_threshold_lamports;
        config.normal_win_bps = normal_win_bps;
        config.easy_win_bps = easy_win_bps;
        config.treasury_fee_bps = treasury_fee_bps;

        Ok(())
    }

    /// Oyuna katılır ("commit" adımı). İlk `config.free_plays` deneme
    /// ücretsizdir (yalnızca ağ işlem ücreti); sonrasında `entry_fee_lamports`
    /// SOL gerekir ve aynı işlemde ikiye bölünerek gönderilir: bir payı
    /// hazineye (treasury), kalanı oyun kasasına (vault).
    ///
    /// Sonuç burada BELLİ OLMAZ — yalnızca "şu an bu oyuncu, şu slot'ta bir
    /// oyun başlattı" diye zincire yazılır. Kazanıp kazanmadığı, henüz var
    /// olmayan (gelecekteki) bir slot'un hash'ine bağlı olacak şekilde
    /// `resolve()`'da belirlenir — bkz. o fonksiyonun açıklaması, bunun
    /// neden gerekli olduğunu (simülasyonla "önizleyip" hile yapmayı
    /// engellemek için) anlatıyor.
    pub fn play(ctx: Context<Play>) -> Result<()> {
        let player_state = &mut ctx.accounts.player_state;
        require!(!player_state.pending, GameError::PlayAlreadyPending);

        let config = &ctx.accounts.config;
        let is_paid = player_state.plays_count >= config.free_plays as u32;

        if is_paid {
            let treasury_amount = (config.entry_fee_lamports as u128)
                .checked_mul(config.treasury_fee_bps as u128)
                .ok_or(GameError::MathOverflow)?
                .checked_div(BPS_DENOMINATOR as u128)
                .ok_or(GameError::MathOverflow)? as u64;
            let vault_amount = config
                .entry_fee_lamports
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
        }

        player_state.player = ctx.accounts.player.key();
        player_state.plays_count = player_state
            .plays_count
            .checked_add(1)
            .ok_or(GameError::MathOverflow)?;
        player_state.pending = true;
        player_state.commit_slot = Clock::get()?.slot;
        player_state.bump = ctx.bumps.player_state;

        emit!(PlayCommitted {
            player: ctx.accounts.player.key(),
            plays_count: player_state.plays_count,
            is_paid,
            commit_slot: player_state.commit_slot,
        });

        Ok(())
    }

    /// Bekleyen oyunu sonuçlandırır ("reveal" adımı). İzinsiz (permissionless)
    /// — oyuncunun kendisi ya da başka biri/bir "keeper" çağırabilir; sonucu
    /// kimin gönderdiği önemli değil çünkü sonuç zaten `commit_slot +
    /// reveal_delay_slots` slot'unun hash'iyle DETERMİNİSTİK olarak belirli,
    /// çağıran taraf hiçbir şeyi etkileyemez.
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
        // küçük bir kazanma ihtimali varsa), kasa henüz `prize_lamports`
        // kadar dolmamışken bile nadiren kazanma şartı tutabilir. Bu durumda
        // ödemeyi REDDEDİP TÜM İŞLEMİ GERİ ALMAK yerine (ki bu, oyuncuyu
        // kalıcı olarak `pending = true` durumunda, forfeit_stuck_play
        // penceresi açılana kadar sıkıştırırdı) sessizce kayıp say —
        // oyuncu parasını kaybeder ama en azından tekrar oynayabilir.
        // `vault_easy_threshold_lamports >= prize_lamports` zaten
        // initialize/update_config'te zorunlu kılındığı için "kolay modda"
        // bu dala hiç girilmemesi beklenir; bu tamamen savunma amaçlı.
        let won = roll < win_bps as u32 && vault_balance >= config.prize_lamports;

        let mut prize_paid: u64 = 0;
        if won {
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
                config.prize_lamports,
            )?;

            prize_paid = config.prize_lamports;
            player_state.wins_count = player_state
                .wins_count
                .checked_add(1)
                .ok_or(GameError::MathOverflow)?;
        }

        player_state.pending = false;

        emit!(PlayResolved {
            player: ctx.accounts.player.key(),
            won,
            prize_paid,
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
    /// denemeyi kaybedilmiş sayıp (ücret iadesi yok — normal bir kayıp gibi
    /// muamele) `pending`'i temizler ve oyuncunun tekrar oynamasına izin
    /// verir.
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
    pub entry_fee_lamports: u64,
    pub free_plays: u8,
    pub prize_lamports: u64,
    pub vault_easy_threshold_lamports: u64,
    pub normal_win_bps: u16,
    pub easy_win_bps: u16,
    pub treasury_fee_bps: u16,
    pub reveal_delay_slots: u64,
    pub vault_bump: u8,
    pub bump: u8,
}

impl GameConfig {
    // 8 (disc) + 32*2 (pubkeys) + 8 + 1 + 8 + 8 + 2*3 + 8 + 1 + 1
    pub const LEN: usize = 8 + 32 * 2 + 8 + 1 + 8 + 8 + 2 * 3 + 8 + 1 + 1;
}

#[account]
pub struct PlayerState {
    pub player: Pubkey,
    pub plays_count: u32,
    pub wins_count: u32,
    pub pending: bool,
    pub commit_slot: u64,
    pub bump: u8,
}

impl PlayerState {
    // 8 (disc) + 32 + 4 + 4 + 1 + 8 + 1
    pub const LEN: usize = 8 + 32 + 4 + 4 + 1 + 8 + 1;
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
pub struct Play<'info> {
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
pub struct PlayCommitted {
    pub player: Pubkey,
    pub plays_count: u32,
    pub is_paid: bool,
    pub commit_slot: u64,
}

#[event]
pub struct PlayResolved {
    pub player: Pubkey,
    pub won: bool,
    pub prize_paid: u64,
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
