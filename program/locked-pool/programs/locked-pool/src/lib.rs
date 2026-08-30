use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SolTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer as TokenTransfer};

declare_id!("11111111111111111111111111111111");

const POOL_SEED: &[u8] = b"pool";
const AUTHORITY_SEED: &[u8] = b"authority";
const LP_MINT_SEED: &[u8] = b"lp_mint";

// A Uniswap-v2 style 0.3% trading fee (it stays in the pool and goes to the LPs).
const FEE_NUMERATOR: u128 = 997;
const FEE_DENOMINATOR: u128 = 1000;

#[program]
pub mod locked_pool {
    use super::*;

    /// Creates the pool and deposits the initial liquidity. `duration_seconds`
    /// sets how long selling stays locked — once written to the pool account that
    /// value can NEVER be changed again; there is no instruction in this program
    /// that would change it.
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

        // Move the SOL into the pool_authority PDA.
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

        // Move the token into the vault.
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

        // The initial LP amount = sqrt(sol_amount * token_amount) (the Uniswap v2 rule).
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

    /// Adds liquidity at the pool's current ratio. It has nothing to do with the
    /// buy/sell restriction — liquidity can always be added and removed.
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

    /// Burns the LP share and withdraws the proportional SOL + token in return.
    /// This instruction has nothing to do with the sell lock either.
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

    /// SOL -> Token. ALWAYS open, regardless of the lock period.
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

    /// Token -> SOL. The lock counts as open if and only if: `pool.unlock_ts`
    /// has elapsed, AUTOMATICALLY, OR the creator opened it early with
    /// `unlock_now`. Both are read from the single, global `pool` account — so
    /// everyone who sends this instruction (whoever they are, whenever they send
    /// it) sees the same result at the same moment; no account opens before or
    /// after another.
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

    /// Opens the lock BEFORE its time, once and PERMANENTLY. Only
    /// `pool.creator` can call it. Once it is `true` there is no instruction that
    /// would set it back to `false` — so neither the creator nor anybody else can
    /// close the lock again, or act selectively (yes for some accounts, no for
    /// others). Because `swap_sell` reads this flag as its single, global source,
    /// its effect starts for every seller at the same moment.
    pub fn unlock_now(ctx: Context<UnlockNow>) -> Result<()> {
        require!(!ctx.accounts.pool.manually_unlocked, PoolError::AlreadyUnlocked);
        ctx.accounts.pool.manually_unlocked = true;
        Ok(())
    }
}

/// An integer square root by Newton's method (the same approach as in Uniswap v2).
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
    /// A Unix timestamp — selling is open from this moment on. There is no
    /// instruction that would change it after the pool is created.
    pub unlock_ts: i64,
    /// The one-off, permanent early opening done by `unlock_now`. It is one-way,
    /// `false` -> `true`; there is no instruction that closes it again.
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

    /// CHECK: a PDA that only holds SOL and is used to sign in CPIs; it carries
    /// no data, so it needs no Anchor type check.
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

    /// CHECK: a PDA verified with pool.authority_bump.
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

    /// CHECK: a PDA verified with pool.authority_bump.
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

    /// CHECK: a PDA verified with pool.authority_bump.
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
    /// Has to be the wallet that created the pool — the match against
    /// `pool.creator` is enforced by Anchor's `has_one` constraint.
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
    #[msg("The duration has to be greater than 0.")]
    InvalidDuration,
    #[msg("Invalid amount.")]
    InvalidAmount,
    #[msg("The pool has no liquidity.")]
    EmptyPool,
    #[msg("The slippage tolerance was exceeded.")]
    SlippageExceeded,
    #[msg("The pool does not have enough liquidity.")]
    InsufficientLiquidity,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("The sell lock is still active — you cannot sell before the set period elapses.")]
    SellLocked,
    #[msg("The lock has already been opened manually.")]
    AlreadyUnlocked,
}
