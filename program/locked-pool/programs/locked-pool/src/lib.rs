use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer as TokenTransfer};

declare_id!("11111111111111111111111111111111");

const POOL_SEED: &[u8] = b"pool";
const AUTHORITY_SEED: &[u8] = b"authority";
const LP_MINT_SEED: &[u8] = b"lp_mint";

// Uniswap-v2 tarzı %0.3 işlem ücreti (havuzda kalır, LP sağlayıcılarına gider).
const FEE_NUMERATOR: u128 = 997;
const FEE_DENOMINATOR: u128 = 1000;

#[program]
pub mod locked_pool {
    use super::*;

    /// Havuzu oluşturur ve ilk likiditeyi yatırır. `duration_seconds`,
    /// satışın ne kadar süre kilitli kalacağını belirler — bu değer havuz
    /// hesabına yazıldıktan sonra bir daha ASLA değiştirilemez; bunu
    /// değiştirecek hiçbir instruction bu programda yok.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        duration_seconds: i64,
        sol_amount: u64,
        token_amount: u64,
    ) -> Result<()> {
        require!(duration_seconds > 0, PoolError::InvalidDuration);
        require!(sol_amount > 0 && token_amount > 0, PoolError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        let unlock_ts = now.checked_add(duration_seconds).ok_or(PoolError::MathOverflow)?;

        // SOL'u pool_authority PDA'sına aktar.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.pool_authority.to_account_info(),
                },
            ),
            sol_amount,
        )?;

        // Token'ı vault'a aktar.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.creator_token_account.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            token_amount,
        )?;

        // İlk LP miktarı = sqrt(sol_amount * token_amount) (Uniswap v2 kuralı).
        let lp_amount = integer_sqrt(
            (sol_amount as u128)
                .checked_mul(token_amount as u128)
                .ok_or(PoolError::MathOverflow)?,
        ) as u64;
        require!(lp_amount > 0, PoolError::InvalidAmount);

        let pool_key = ctx.accounts.pool.key();
        let authority_bump = ctx.bumps.pool_authority;
        let signer_seeds: &[&[u8]] = &[AUTHORITY_SEED, pool_key.as_ref(), &[authority_bump]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.creator_lp_account.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            lp_amount,
        )?;

        let pool = &mut ctx.accounts.pool;
        pool.token_mint = ctx.accounts.token_mint.key();
        pool.token_vault = ctx.accounts.token_vault.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.creator = ctx.accounts.creator.key();
        pool.unlock_ts = unlock_ts;
        pool.manually_unlocked = false;
        pool.bump = ctx.bumps.pool;
        pool.authority_bump = authority_bump;

        Ok(())
    }

    /// Mevcut havuz oranına göre likidite ekler. Alım/satım kısıtlamasıyla
    /// hiç ilgisi yok — likidite her zaman eklenip çekilebilir.
    pub fn add_liquidity(ctx: Context<AddLiquidity>, sol_amount: u64, max_token_amount: u64) -> Result<()> {
        require!(sol_amount > 0, PoolError::InvalidAmount);

        let rent_exempt = Rent::get()?.minimum_balance(0);
        let sol_reserve = ctx
            .accounts
            .pool_authority
            .lamports()
            .checked_sub(rent_exempt)
            .ok_or(PoolError::MathOverflow)?;
        let token_reserve = ctx.accounts.token_vault.amount;
        require!(sol_reserve > 0 && token_reserve > 0, PoolError::EmptyPool);

        let token_amount = (sol_amount as u128)
            .checked_mul(token_reserve as u128)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(sol_reserve as u128)
            .ok_or(PoolError::MathOverflow)? as u64;
        require!(token_amount > 0 && token_amount <= max_token_amount, PoolError::SlippageExceeded);

        let lp_supply = ctx.accounts.lp_mint.supply;
        let lp_amount = (sol_amount as u128)
            .checked_mul(lp_supply as u128)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(sol_reserve as u128)
            .ok_or(PoolError::MathOverflow)? as u64;
        require!(lp_amount > 0, PoolError::InvalidAmount);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.pool_authority.to_account_info(),
                },
            ),
            sol_amount,
        )?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            token_amount,
        )?;

        let pool_key = ctx.accounts.pool.key();
        let authority_bump = ctx.accounts.pool.authority_bump;
        let signer_seeds: &[&[u8]] = &[AUTHORITY_SEED, pool_key.as_ref(), &[authority_bump]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.user_lp_account.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            lp_amount,
        )?;

        Ok(())
    }

    /// LP payını yakıp karşılığında orantılı SOL + token geri çeker.
    /// Bu instruction'ın da satış kilidiyle hiç ilgisi yok.
    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_sol_out: u64,
        min_token_out: u64,
    ) -> Result<()> {
        require!(lp_amount > 0, PoolError::InvalidAmount);

        let rent_exempt = Rent::get()?.minimum_balance(0);
        let sol_reserve = ctx
            .accounts
            .pool_authority
            .lamports()
            .checked_sub(rent_exempt)
            .ok_or(PoolError::MathOverflow)?;
        let token_reserve = ctx.accounts.token_vault.amount;
        let lp_supply = ctx.accounts.lp_mint.supply;
        require!(lp_supply > 0, PoolError::EmptyPool);

        let sol_out = (sol_reserve as u128)
            .checked_mul(lp_amount as u128)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(lp_supply as u128)
            .ok_or(PoolError::MathOverflow)? as u64;
        let token_out = (token_reserve as u128)
            .checked_mul(lp_amount as u128)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(lp_supply as u128)
            .ok_or(PoolError::MathOverflow)? as u64;

        require!(sol_out >= min_sol_out && token_out >= min_token_out, PoolError::SlippageExceeded);

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    from: ctx.accounts.user_lp_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            lp_amount,
        )?;

        let pool_key = ctx.accounts.pool.key();
        let authority_bump = ctx.accounts.pool.authority_bump;
        let signer_seeds: &[&[u8]] = &[AUTHORITY_SEED, pool_key.as_ref(), &[authority_bump]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.pool_authority.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                &[signer_seeds],
            ),
            sol_out,
        )?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            token_out,
        )?;

        Ok(())
    }

    /// SOL -> Token. Kilit süresinden bağımsız olarak HER ZAMAN serbesttir.
    pub fn swap_buy(ctx: Context<Swap>, sol_in: u64, min_token_out: u64) -> Result<()> {
        require!(sol_in > 0, PoolError::InvalidAmount);

        let rent_exempt = Rent::get()?.minimum_balance(0);
        let sol_reserve = ctx
            .accounts
            .pool_authority
            .lamports()
            .checked_sub(rent_exempt)
            .ok_or(PoolError::MathOverflow)?;
        let token_reserve = ctx.accounts.token_vault.amount;
        require!(sol_reserve > 0 && token_reserve > 0, PoolError::EmptyPool);

        let sol_in_after_fee = (sol_in as u128)
            .checked_mul(FEE_NUMERATOR)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(FEE_DENOMINATOR)
            .ok_or(PoolError::MathOverflow)?;
        let k = (sol_reserve as u128)
            .checked_mul(token_reserve as u128)
            .ok_or(PoolError::MathOverflow)?;
        let new_sol_reserve = (sol_reserve as u128)
            .checked_add(sol_in_after_fee)
            .ok_or(PoolError::MathOverflow)?;
        let new_token_reserve = k.checked_div(new_sol_reserve).ok_or(PoolError::MathOverflow)?;
        let token_out = (token_reserve as u128)
            .checked_sub(new_token_reserve)
            .ok_or(PoolError::MathOverflow)? as u64;

        require!(token_out >= min_token_out, PoolError::SlippageExceeded);
        require!(token_out < token_reserve, PoolError::InsufficientLiquidity);

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.pool_authority.to_account_info(),
                },
            ),
            sol_in,
        )?;

        let pool_key = ctx.accounts.pool.key();
        let authority_bump = ctx.accounts.pool.authority_bump;
        let signer_seeds: &[&[u8]] = &[AUTHORITY_SEED, pool_key.as_ref(), &[authority_bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            token_out,
        )?;

        Ok(())
    }

    /// Token -> SOL. Kilit açık sayılır ancak ve ancak: `pool.unlock_ts`
    /// dolduysa OTOMATİK OLARAK, YA DA kurucu `unlock_now` ile erken açtıysa.
    /// İkisi de tek, global `pool` hesabından okunur — bu instruction'ı
    /// gönderen herkes (kim, ne zaman gönderirse göndersin) aynı anda aynı
    /// sonucu görür; hiçbir hesap diğerinden önce/sonra açılmaz.
    pub fn swap_sell(ctx: Context<Swap>, token_in: u64, min_sol_out: u64) -> Result<()> {
        require!(token_in > 0, PoolError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        let unlocked = now >= ctx.accounts.pool.unlock_ts || ctx.accounts.pool.manually_unlocked;
        require!(unlocked, PoolError::SellLocked);

        let rent_exempt = Rent::get()?.minimum_balance(0);
        let sol_reserve = ctx
            .accounts
            .pool_authority
            .lamports()
            .checked_sub(rent_exempt)
            .ok_or(PoolError::MathOverflow)?;
        let token_reserve = ctx.accounts.token_vault.amount;
        require!(sol_reserve > 0 && token_reserve > 0, PoolError::EmptyPool);

        let token_in_after_fee = (token_in as u128)
            .checked_mul(FEE_NUMERATOR)
            .ok_or(PoolError::MathOverflow)?
            .checked_div(FEE_DENOMINATOR)
            .ok_or(PoolError::MathOverflow)?;
        let k = (sol_reserve as u128)
            .checked_mul(token_reserve as u128)
            .ok_or(PoolError::MathOverflow)?;
        let new_token_reserve = (token_reserve as u128)
            .checked_add(token_in_after_fee)
            .ok_or(PoolError::MathOverflow)?;
        let new_sol_reserve = k.checked_div(new_token_reserve).ok_or(PoolError::MathOverflow)?;
        let sol_out = (sol_reserve as u128)
            .checked_sub(new_sol_reserve)
            .ok_or(PoolError::MathOverflow)? as u64;

        require!(sol_out >= min_sol_out, PoolError::SlippageExceeded);
        require!(sol_out < sol_reserve, PoolError::InsufficientLiquidity);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            token_in,
        )?;

        let pool_key = ctx.accounts.pool.key();
        let authority_bump = ctx.accounts.pool.authority_bump;
        let signer_seeds: &[&[u8]] = &[AUTHORITY_SEED, pool_key.as_ref(), &[authority_bump]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.pool_authority.to_account_info(),
                    to: ctx.accounts.user.to_account_info(),
                },
                &[signer_seeds],
            ),
            sol_out,
        )?;

        Ok(())
    }

    /// Kilidi süresinden ÖNCE, tek seferde ve KALICI olarak açar. Sadece
    /// `pool.creator` çağırabilir. Bir kere `true` olduktan sonra bunu
    /// `false`'a geri döndürecek hiçbir instruction yok — yani ne kurucu
    /// ne de başka biri kilidi yeniden kapatamaz, seçici (bazı hesaplar
    /// için evet bazıları için hayır) davranamaz. `swap_sell` bu bayrağı
    /// tek, global kaynak olarak okuduğu için etkisi tüm satıcılar için
    /// aynı anda başlar.
    pub fn unlock_now(ctx: Context<UnlockNow>) -> Result<()> {
        require!(!ctx.accounts.pool.manually_unlocked, PoolError::AlreadyUnlocked);
        ctx.accounts.pool.manually_unlocked = true;
        Ok(())
    }
}

/// Newton yöntemiyle tamsayı karekök (Uniswap v2'deki ile aynı yaklaşım).
fn integer_sqrt(value: u128) -> u128 {
    if value == 0 {
        return 0;
    }
    let mut x = value;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + value / x) / 2;
    }
    x
}

#[account]
pub struct Pool {
    pub token_mint: Pubkey,
    pub token_vault: Pubkey,
    pub lp_mint: Pubkey,
    pub creator: Pubkey,
    /// Unix zaman damgası — bu andan itibaren satış serbest. Havuz
    /// oluşturulduktan sonra bunu değiştirecek hiçbir instruction yok.
    pub unlock_ts: i64,
    /// `unlock_now` ile tek seferlik, kalıcı erken açma. `false` -> `true`
    /// yönünde tek yönlü; geri kapatan hiçbir instruction yok.
    pub manually_unlocked: bool,
    pub bump: u8,
    pub authority_bump: u8,
}

impl Pool {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 1 + 1 + 1;
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        space = Pool::LEN,
        seeds = [POOL_SEED, token_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    /// CHECK: Sadece SOL tutan ve CPI'larda imza için kullanılan bir PDA;
    /// hiç veri içermiyor, bu yüzden Anchor tip kontrolü gerektirmiyor.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED, pool.key().as_ref()],
        bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = token_mint,
        associated_token::authority = pool_authority,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
        bump,
        mint::decimals = 9,
        mint::authority = pool_authority,
    )]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut)]
    pub creator_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = lp_mint,
        associated_token::authority = creator,
    )]
    pub creator_lp_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [POOL_SEED, pool.token_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// CHECK: pool.authority_bump ile doğrulanan PDA.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, address = pool.token_vault)]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = lp_mint,
        associated_token::authority = user,
    )]
    pub user_lp_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [POOL_SEED, pool.token_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// CHECK: pool.authority_bump ile doğrulanan PDA.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, address = pool.token_vault)]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Account<'info, Mint>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_lp_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [POOL_SEED, pool.token_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// CHECK: pool.authority_bump ile doğrulanan PDA.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED, pool.key().as_ref()],
        bump = pool.authority_bump,
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(mut, address = pool.token_vault)]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnlockNow<'info> {
    /// Havuzu oluşturan cüzdan olmalı — `pool.creator` ile eşleşme
    /// Anchor'ın `has_one` kısıtıyla zorunlu kılınıyor.
    pub creator: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_SEED, pool.token_mint.as_ref()],
        bump = pool.bump,
        has_one = creator,
    )]
    pub pool: Account<'info, Pool>,
}

#[error_code]
pub enum PoolError {
    #[msg("Süre 0'dan büyük olmalı.")]
    InvalidDuration,
    #[msg("Geçersiz miktar.")]
    InvalidAmount,
    #[msg("Havuzda likidite yok.")]
    EmptyPool,
    #[msg("Slippage payı aşıldı.")]
    SlippageExceeded,
    #[msg("Havuzda yeterli likidite yok.")]
    InsufficientLiquidity,
    #[msg("Matematik taşması.")]
    MathOverflow,
    #[msg("Satış kilidi hâlâ aktif — belirlenen süre dolmadan satış yapılamaz.")]
    SellLocked,
    #[msg("Kilit zaten manuel olarak açılmış.")]
    AlreadyUnlocked,
}
