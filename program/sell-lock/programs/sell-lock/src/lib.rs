use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

// The real program ID deployed to Devnet through Solana Playground.
declare_id!("3SgfMbBMbsaB21QaZgcGmRYbUTGGEyErJipxM8u2Uqy5");

// The durations allowed for the anti-snipe lock: 15 min / 1 hour / 5 hours /
// 24 hours. Any other duration is rejected — which removes the risk of "the lock
// period can be extended or shortened arbitrarily".
const ALLOWED_DURATIONS_SECONDS: [i64; 4] = [900, 3600, 18_000, 86_400];

#[program]
pub mod sell_lock {
    use super::*;

    /// Creates the "extra account meta list" account that Token-2022's Transfer
    /// Hook extension requires for every mint. That account defines which extra
    /// accounts (in our case: this mint's LaunchConfig PDA) are passed to our
    /// program automatically on every transfer.
    ///
    /// In the token creation flow it is called once, right after the mint is
    /// created with the Token-2022 + TransferHook extension.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let account_metas = vec![
            // Index 4 = the LaunchConfig PDA's position in the account list
            // during execute (see the fallback function: source, mint,
            // destination, owner, extra_account_meta_list, launch_config).
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

    /// Called once right after the pool is created, as part of the same flow. It
    /// is what actually switches the sell lock on for this mint: it writes the
    /// pool's two vault addresses and the chosen duration to the chain.
    ///
    /// `duration_seconds` can only be one of the values in
    /// ALLOWED_DURATIONS_SECONDS. `unlock_timestamp` is computed from the current
    /// time (from the on-chain Clock) and is not sent by the client — so nobody
    /// (us included) can manipulate it.
    ///
    /// This account is created with the `init` constraint: a second call for the
    /// same mint fails with "account already in use" — that is, once set, the
    /// duration can never be changed again.
    pub fn register_launch(ctx: Context<RegisterLaunch>, duration_seconds: i64) -> Result<()> {
        require!(
            ALLOWED_DURATIONS_SECONDS.contains(&duration_seconds),
            SellLockError::InvalidDuration
        );

        // Only the mint's own mint authority may register its launch lock.
        // Without this check ANYONE could call register_launch() first —
        // `launch_config` is `init`-only per mint, so a pre-emptive call
        // (with the real pool's vault addresses, to shorten the lock to the
        // minimum 15 minutes; or with throwaway accounts of the right mint,
        // to disable the lock entirely since `fallback` would then never
        // match the real pool's vaults) permanently neuters the anti-snipe
        // protection for that mint — the PDA can never be re-initialized.
        // Tying it to mint authority rather than a hardcoded wallet keeps
        // this correct for whichever token creates a pool, without risking a
        // wrong hardcoded address locking legitimate use out forever.
        match ctx.accounts.mint.mint_authority {
            anchor_lang::solana_program::program_option::COption::Some(authority) => {
                require_keys_eq!(authority, ctx.accounts.signer.key(), SellLockError::NotMintAuthority);
            }
            anchor_lang::solana_program::program_option::COption::None => {
                return err!(SellLockError::NoMintAuthority);
            }
        }

        // Verify that the vaults really belong to this mint and to the
        // Token-2022/Token program — this stops a fake or random "vault" address
        // being passed in and leaving the lock blocking nothing at all.
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

    /// The Token-2022 program calls this function (through `fallback`) by CPI on
    /// EVERY transfer involving this mint. The logic:
    ///
    /// - If the destination account is one of the pool vaults recorded in
    ///   LaunchConfig (that is, this is a "sale" / a deposit into the pool) AND
    ///   the period has not elapsed -> reject the transaction.
    /// - Otherwise (a purchase, or a wallet-to-wallet transfer) -> allow it.
    ///
    /// If the LaunchConfig account has not been created yet (the pool has not
    /// been set up), this function is never called at all, because the
    /// extra_account_meta_list resolution fails; in that case the transfer
    /// proceeds normally (unrestricted) — so this does not affect ordinary token
    /// transfers made before the pool exists (a gift between wallets, say).
    ///
    /// Token-2022's transfer hook interface uses its own raw discriminator format
    /// rather than Anchor's standard 8-byte sighash discriminator. That is why
    /// calls land in `fallback` first.
    ///
    /// When Anchor sees a function named exactly "fallback" with this signature
    /// inside a `#[program]` block, it automatically treats it as the custom
    /// handler — no extra attribute is needed.
    ///
    /// We implement the logic directly here (reading the accounts by hand)
    /// instead of relying on Anchor's normally hidden internal
    /// (`__private::__global::...`) call path — that internal path broke the
    /// build because it did not match the Anchor version Solana Playground
    /// uses.
    pub fn fallback<'info>(
        _program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)
            .map_err(|_| error!(SellLockError::InvalidInstruction))?;

        match instruction {
            TransferHookInstruction::Execute { .. } => {
                // The account order Token-2022 passes through the CPI:
                // [0] source_token, [1] mint, [2] destination_token,
                // [3] owner, [4] extra_account_meta_list, [5] launch_config
                // (our single "extra" account).
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

    /// CHECK: the seed-derived PDA the Token-2022 specification expects; its
    /// contents are written only by this program.
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
    /// CHECK: stored only as an address; because the B side is usually a
    /// SOL/WSOL vault it can be of a different type.
    pub pool_vault_b: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum SellLockError {
    #[msg("The lock duration can only be 15 minutes, 1 hour, 5 hours or 24 hours.")]
    InvalidDuration,
    #[msg("The pool vault does not belong to this token mint.")]
    VaultMintMismatch,
    #[msg("The sell lock has not expired yet — you cannot sell into this pool.")]
    SellLocked,
    #[msg("The extra account meta list could not be created.")]
    ExtraAccountMetaError,
    #[msg("Invalid transfer hook instruction.")]
    InvalidInstruction,
    #[msg("Only this mint's mint authority may register its launch lock.")]
    NotMintAuthority,
    #[msg("This mint has no mint authority (it was revoked) — its launch lock can no longer be registered.")]
    NoMintAuthority,
}
