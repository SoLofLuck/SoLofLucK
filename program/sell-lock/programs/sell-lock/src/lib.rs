use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

// Solana Playground üzerinden Devnet'e deploy edilen gerçek program ID'si.
declare_id!("3SgfMbBMbsaB21QaZgcGmRYbUTGGEyErJipxM8u2Uqy5");

// Anti-snipe kilidi için izin verilen süreler: 15 dk / 1 saat / 5 saat / 24 saat.
// Başka bir süre denemesi reddedilir — bu, "kilit süresi keyfi uzatılabilir/
// kısaltılabilir" riskini ortadan kaldırır.
const ALLOWED_DURATIONS_SECONDS: [i64; 4] = [900, 3600, 18_000, 86_400];

#[program]
pub mod sell_lock {
    use super::*;

    /// Token-2022'nin Transfer Hook uzantısının her mint için zorunlu tuttuğu
    /// "extra account meta list" hesabını oluşturur. Bu hesap, her transferde
    /// bizim programımıza hangi ek hesapların (bizim durumumuzda: bu mint'in
    /// LaunchConfig PDA'sı) otomatik olarak iletileceğini tanımlar.
    ///
    /// Token oluşturma akışında, mint Token-2022 + TransferHook uzantısıyla
    /// oluşturulduktan hemen sonra bir kez çağrılır.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let account_metas = vec![
            // Index 4 = LaunchConfig PDA'nın execute sırasında account listesindeki
            // sırası (bkz. fallback fonksiyonu: source, mint, destination,
            // owner, extra_account_meta_list, launch_config).
            ExtraAccountMeta::new_with_seeds(
                &[
                    spl_tlv_account_resolution::seeds::Seed::Literal {
                        bytes: b"launch-config".to_vec(),
                    },
                    spl_tlv_account_resolution::seeds::Seed::AccountKey { index: 1 },
                ],
                false,
                false,
            )
            .map_err(|_| error!(SellLockError::ExtraAccountMetaError))?,
        ];

        let account_size = ExtraAccountMetaList::size_of(account_metas.len())
            .map_err(|_| error!(SellLockError::ExtraAccountMetaError))? as u64;
        let lamports_required = Rent::get()?.minimum_balance(account_size as usize);

        let mint_key = ctx.accounts.mint.key();
        let bump = ctx.bumps.extra_account_meta_list;
        let signer_seeds: &[&[u8]] = &[b"extra-account-metas", mint_key.as_ref(), &[bump]];

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.payer.key,
                ctx.accounts.extra_account_meta_list.key,
                lamports_required,
                account_size,
                ctx.program_id,
            ),
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.extra_account_meta_list.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &account_metas,
        )
        .map_err(|_| error!(SellLockError::ExtraAccountMetaError))?;

        Ok(())
    }

    /// Havuz oluşturulduktan hemen sonra, aynı akışın bir parçası olarak bir
    /// kez çağrılır. Bu mint için satış kilidini fiilen etkinleştirir:
    /// havuzun iki kasa adresini ve seçilen süreyi zincire yazar.
    ///
    /// `duration_seconds` yalnızca ALLOWED_DURATIONS_SECONDS içindeki
    /// değerlerden biri olabilir. `unlock_timestamp` şu andan (zincirdeki
    /// Clock'tan) hesaplanır, istemci tarafından gönderilmez — böylece hiç
    /// kimse (biz dahil) manipüle edemez.
    ///
    /// Bu hesap `init` kısıtıyla oluşturulur: aynı mint için ikinci bir
    /// çağrı "account already in use" hatasıyla başarısız olur — yani bir
    /// kez ayarlandıktan sonra süre bir daha değiştirilemez.
    pub fn register_launch(ctx: Context<RegisterLaunch>, duration_seconds: i64) -> Result<()> {
        require!(
            ALLOWED_DURATIONS_SECONDS.contains(&duration_seconds),
            SellLockError::InvalidDuration
        );

        // Kasaların gerçekten bu mint'e ait ve Token-2022/Token programına
        // ait olduğunu doğrula — sahte/rastgele bir "kasa" adresi verilip
        // kilidin fiilen hiçbir işlemi engellemez hale getirilmesini önler.
        require_keys_eq!(
            ctx.accounts.pool_vault_a.mint,
            ctx.accounts.mint.key(),
            SellLockError::VaultMintMismatch
        );

        let config = &mut ctx.accounts.launch_config;
        config.mint = ctx.accounts.mint.key();
        config.pool_vault_a = ctx.accounts.pool_vault_a.key();
        config.pool_vault_b = ctx.accounts.pool_vault_b.key();
        config.unlock_timestamp = Clock::get()?.unix_timestamp + duration_seconds;
        config.creator = ctx.accounts.signer.key();
        config.bump = ctx.bumps.launch_config;

        Ok(())
    }

    /// Token-2022 programı, bu mint'i ilgilendiren HER transferde bu
    /// fonksiyonu (`fallback` üzerinden) CPI ile çağırır. Mantık:
    ///
    /// - Hedef hesap, LaunchConfig'te kayıtlı havuz kasalarından biriyse
    ///   (yani bu bir "satış" / havuza para yatırma işlemiyse) VE süre
    ///   dolmadıysa → işlemi reddet.
    /// - Aksi halde (alım, ya da cüzdandan cüzdana transfer) → izin ver.
    ///
    /// LaunchConfig hesabı henüz oluşturulmamışsa (havuz henüz kurulmadıysa)
    /// bu fonksiyon hiç çağrılmaz çünkü extra_account_meta_list çözümlemesi
    /// başarısız olur; bu durumda transfer normal şekilde (kısıtlamasız)
    /// devam eder — bu, havuz kurulmadan önceki sıradan token transferlerini
    /// (ör. cüzdanlar arası hediye) etkilemez.
    ///
    /// Token-2022'nin transfer hook arayüzü, Anchor'ın standart 8-byte
    /// sighash discriminator'ı yerine kendi ham discriminator formatını
    /// kullanır. Bu yüzden çağrılar önce `fallback`'e düşer.
    ///
    /// Anchor, `#[program]` bloğu içinde tam "fallback" isminde ve bu
    /// imzada bir fonksiyon gördüğünde onu otomatik olarak özel işleyici
    /// kabul eder — ekstra bir attribute gerekmez.
    ///
    /// Mantığı, Anchor'ın normalde gizli tuttuğu dahili
    /// (`__private::__global::...`) çağrı yoluna güvenmek yerine burada
    /// doğrudan (hesapları elle okuyarak) uyguluyoruz — o dahili yol,
    /// Solana Playground'un kullandığı Anchor sürümüyle uyuşmadığı için
    /// derlemeyi bozuyordu.
    pub fn fallback<'info>(
        _program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)
            .map_err(|_| error!(SellLockError::InvalidInstruction))?;

        match instruction {
            TransferHookInstruction::Execute { .. } => {
                // Token-2022'nin CPI ile ilettiği hesap sırası:
                // [0] source_token, [1] mint, [2] destination_token,
                // [3] owner, [4] extra_account_meta_list, [5] launch_config
                // (bizim tek "extra" hesabımız).
                let destination_token_info = accounts
                    .get(2)
                    .ok_or_else(|| error!(SellLockError::InvalidInstruction))?;
                let launch_config_info = accounts
                    .get(5)
                    .ok_or_else(|| error!(SellLockError::InvalidInstruction))?;

                let config_data = launch_config_info.try_borrow_data()?;
                let mut config_slice: &[u8] = &config_data;
                let config = LaunchConfig::try_deserialize(&mut config_slice)?;

                let is_sell_into_pool = *destination_token_info.key == config.pool_vault_a
                    || *destination_token_info.key == config.pool_vault_b;

                if is_sell_into_pool {
                    let now = Clock::get()?.unix_timestamp;
                    require!(now >= config.unlock_timestamp, SellLockError::SellLocked);
                }

                Ok(())
            }
            _ => Err(SellLockError::InvalidInstruction.into()),
        }
    }
}

#[account]
pub struct LaunchConfig {
    pub mint: Pubkey,
    pub pool_vault_a: Pubkey,
    pub pool_vault_b: Pubkey,
    pub unlock_timestamp: i64,
    pub creator: Pubkey,
    pub bump: u8,
}

impl LaunchConfig {
    // 8 (discriminator) + 32*4 (pubkeys) + 8 (i64) + 1 (bump)
    pub const SIZE: usize = 8 + 32 * 4 + 8 + 1;
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Token-2022 spesifikasyonunun beklediği, seed'lerle türetilen
    /// PDA; içeriği yalnızca bu program tarafından yazılır.
    #[account(
        mut,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterLaunch<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = LaunchConfig::SIZE,
        seeds = [b"launch-config", mint.key().as_ref()],
        bump,
    )]
    pub launch_config: Account<'info, LaunchConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    pub pool_vault_a: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: yalnızca adres olarak saklanıyor, B tarafı genelde SOL/WSOL
    /// kasası olduğu için ayrı tipte olabilir.
    pub pool_vault_b: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum SellLockError {
    #[msg("Kilit süresi yalnızca 15 dakika, 1 saat, 5 saat veya 24 saat olabilir.")]
    InvalidDuration,
    #[msg("Havuz kasası bu token mint'ine ait değil.")]
    VaultMintMismatch,
    #[msg("Satış kilidi süresi henüz dolmadı — bu havuza satış yapılamaz.")]
    SellLocked,
    #[msg("Extra account meta listesi oluşturulamadı.")]
    ExtraAccountMetaError,
    #[msg("Geçersiz transfer hook instruction'ı.")]
    InvalidInstruction,
}
