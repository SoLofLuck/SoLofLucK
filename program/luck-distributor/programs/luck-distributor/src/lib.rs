// ---------------------------------------------------------------------------
// luck-distributor — the $LUCK distribution
// ---------------------------------------------------------------------------
// ONE ACCOUNT TYPE does two jobs at once:
//
//   * PRESALE VESTING — a recipient claims their share in stages according to
//     the published schedule rather than all at once (9% at TGE, then 7% a week
//     for 13 weeks).
//   * RAFFLE PAYOUTS — the weekly raffle winners claim their share immediately.
//
// These are NOT two code paths: a raffle is simply "a distributor whose vesting
// is 100% up front" (cliff_bps = 10000). That leaves a single piece of logic to
// test, to review, and to get wrong. This program will hold 271 million tokens
// on TGE day; the biggest risk here is complexity itself.
//
// WHY MERKLE: there will be a few hundred recipients. Opening an on-chain
// account for each of them would be both expensive and slow. Instead a single
// 32-byte root sits on chain and the recipient brings the list of sibling nodes
// (the proof) that proves their share. The list and the tree are published on
// the site, so anyone can produce and verify their own proof.
//
// DELIBERATE: THERE IS NO INSTRUCTION TO WITHDRAW THE MONEY BACK.
// Tokens that are never claimed stay locked here forever — that is, they are
// effectively burned. Adding an instruction saying "the team can take the
// remainder back" would make the whole distribution depend on a single
// signature; a recipient being able to say "nobody can take this back from us"
// is worth more than that. The price is this: if the locked amount is computed
// wrongly, the excess stays locked too. Which is why the total check inside
// `initialize` is strict.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// A placeholder address — the real program ID is written according to the
// keypair by `anchor keys sync` during deploy (see the deploy workflow).
// Leaving the system program's address (111...) here would clash in the tests,
// so a valid but unused address sits here instead.
declare_id!("8hUZNdjHPR6jtKMwH2U28pHeNZfEgKdJ7x4CDsjuBzwJ");

const DISTRIBUTOR_SEED: &[u8] = b"distributor";
const VAULT_SEED: &[u8] = b"vault";
const CLAIM_SEED: &[u8] = b"claim";

/// The basis-point base (10000 = 100%).
const BPS_DENOMINATOR: u64 = 10_000;

/// The prefixes that separate a leaf from an inner node in the merkle tree.
///
/// If the same hash function were used without a prefix for both leaves and
/// nodes, an attacker could present an existing inner node as a "leaf" and get
/// their own invented (recipient, amount) pair verified (a second-preimage
/// attack). The prefix separates the two domains.
const LEAF_PREFIX: &[u8] = &[0x00];
const NODE_PREFIX: &[u8] = &[0x01];

/// The maximum number of sibling nodes accepted in a proof.
///
/// 32 levels covers 2^32 (more than four billion) recipients — so in practice it
/// never binds. The limit itself is an upper bound against a call that
/// deliberately inflates the transaction size and the compute budget.
const MAX_PROOF_LEN: usize = 32;

#[program]
pub mod luck_distributor {
    use super::*;

    /// Opens a new distribution round and creates its vault.
    ///
    /// `id` distinguishes several rounds for the same mint: 0 = the presale,
    /// 1..14 = the weekly raffles. Once a round is open its root, schedule and
    /// total CANNOT BE CHANGED — there is deliberately no update instruction. A
    /// round opened with the wrong root is abandoned and a new one opened rather
    /// than corrected; that way the possibility of "the team changed the root and
    /// rewrote the shares" never arises.
    pub fn initialize(
        ctx: Context<Initialize>,
        id: u64,
        merkle_root: [u8; 32],
        total_allocated: u64,
        start_ts: i64,
        cliff_bps: u16,
        period_bps: u16,
        period_seconds: i64,
        periods: u16,
    ) -> Result<()> {
        require!(total_allocated > 0, DistributorError::InvalidParam);
        require!(start_ts > 0, DistributorError::InvalidParam);
        require!(merkle_root != [0u8; 32], DistributorError::InvalidParam);

        // The schedule MUST reach exactly 100%. Without this check a configuration
        // such as 7% x 14 = 98% would be accepted silently and the recipients' last
        // 2% would stay locked in the vault forever — a loss, and one nobody would
        // notice until months later.
        let total_bps = (cliff_bps as u64)
            .checked_add((periods as u64).checked_mul(period_bps as u64).ok_or(DistributorError::MathOverflow)?)
            .ok_or(DistributorError::MathOverflow)?;
        require!(total_bps == BPS_DENOMINATOR, DistributorError::ScheduleNotComplete);

        // If there are tiers the interval cannot be zero; otherwise the "elapsed /
        // interval" computation would divide by zero and every tier would unlock in
        // the first second.
        if periods > 0 {
            require!(period_seconds > 0, DistributorError::InvalidParam);
        }

        let d = &mut ctx.accounts.distributor;
        d.id = id;
        d.authority = ctx.accounts.authority.key();
        d.mint = ctx.accounts.mint.key();
        d.vault = ctx.accounts.vault.key();
        d.merkle_root = merkle_root;
        d.total_allocated = total_allocated;
        d.total_claimed = 0;
        d.start_ts = start_ts;
        d.cliff_bps = cliff_bps;
        d.period_bps = period_bps;
        d.period_seconds = period_seconds;
        d.periods = periods;
        d.bump = ctx.bumps.distributor;

        emit!(DistributorInitialized {
            id,
            mint: d.mint,
            merkle_root,
            total_allocated,
            start_ts,
            cliff_bps,
            period_bps,
            period_seconds,
            periods,
        });

        Ok(())
    }

    /// Claims the part of the recipient's share that has unlocked.
    ///
    /// `total_amount` is the total the recipient is owed across the WHOLE round —
    /// the number written in the merkle leaf. The program computes "how much has
    /// unlocked so far" from it and sends the difference against what has already
    /// been claimed. So the recipient can claim every week or once at the end; the
    /// result is the same.
    ///
    /// It is NOT permissionless: the recipient has to sign themselves and the token
    /// account is theirs. Calling it on somebody else's behalf and redirecting the
    /// money elsewhere is not possible.
    pub fn claim(ctx: Context<Claim>, total_amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        require!(proof.len() <= MAX_PROOF_LEN, DistributorError::ProofTooLong);
        require!(total_amount > 0, DistributorError::InvalidParam);

        let claimant = ctx.accounts.claimant.key();
        let distributor = &ctx.accounts.distributor;

        // 1) Is this (recipient, amount) pair really in the tree?
        let leaf = leaf_hash(&claimant, total_amount);
        require!(
            verify_proof(&proof, distributor.merkle_root, leaf),
            DistributorError::InvalidProof
        );

        // 2) How much has unlocked so far?
        let now = Clock::get()?.unix_timestamp;
        let unlocked = unlocked_amount(distributor, total_amount, now)?;

        // 3) Send the difference against what was already claimed.
        let status = &mut ctx.accounts.claim_status;
        require!(unlocked > status.claimed, DistributorError::NothingToClaim);
        let amount = unlocked
            .checked_sub(status.claimed)
            .ok_or(DistributorError::MathOverflow)?;

        // Is it really in the vault? We look BEFORE the transfer so we never mark
        // money as "claimed" when it is not there — otherwise an insufficient
        // balance error would revert the whole transaction, but with a confusing
        // message.
        require!(
            ctx.accounts.vault.amount >= amount,
            DistributorError::InsufficientVaultBalance
        );

        status.claimed = unlocked;
        status.bump = ctx.bumps.claim_status;

        let d = &mut ctx.accounts.distributor;
        d.total_claimed = d
            .total_claimed
            .checked_add(amount)
            .ok_or(DistributorError::MathOverflow)?;
        // No more than the round's total may be distributed. If the merkle root was
        // built correctly this is already impossible; we check anyway, because we
        // produce the root ourselves and a production mistake has to be stopped here,
        // not after the vault has been emptied.
        require!(
            d.total_claimed <= d.total_allocated,
            DistributorError::ExceedsAllocation
        );

        let id_bytes = d.id.to_le_bytes();
        let mint_key = d.mint;
        let signer_seeds: &[&[u8]] = &[
            DISTRIBUTOR_SEED,
            mint_key.as_ref(),
            id_bytes.as_ref(),
            &[d.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.distributor.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;

        emit!(Claimed {
            id: ctx.accounts.distributor.id,
            claimant,
            amount,
            total_claimed: status.claimed,
            total_amount,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The vesting calculation
// ---------------------------------------------------------------------------

/// The total amount unlocked as of a given moment.
///
/// Because the tier count is capped and `initialize` forces the total bps to be
/// exactly 10000, the result is EXACTLY equal to `total` once the schedule ends.
///
/// It is `pub` purely for verifiability: the same formula is rewritten in the
/// interface (src/lib/luckClaim.ts), and the tests pin the two to a golden
/// vector to show they give identical results. If they drift apart, a user sees
/// something as "claimable" and has their transaction rejected.
pub fn unlocked_amount(d: &Distributor, total: u64, now: i64) -> Result<u64> {
    if now < d.start_ts {
        return Ok(0);
    }

    let periods_elapsed: u64 = if d.periods == 0 || d.period_seconds <= 0 {
        0
    } else {
        let elapsed = now.saturating_sub(d.start_ts) as u64;
        (elapsed / (d.period_seconds as u64)).min(d.periods as u64)
    };

    let bps = (d.cliff_bps as u64)
        .checked_add(
            periods_elapsed
                .checked_mul(d.period_bps as u64)
                .ok_or(DistributorError::MathOverflow)?,
        )
        .ok_or(DistributorError::MathOverflow)?
        .min(BPS_DENOMINATOR);

    // Computed in u128: even with total close to 64 bits the product cannot overflow.
    let unlocked = (total as u128)
        .checked_mul(bps as u128)
        .ok_or(DistributorError::MathOverflow)?
        / (BPS_DENOMINATOR as u128);

    Ok(unlocked as u64)
}

// ---------------------------------------------------------------------------
// Merkle verification
// ---------------------------------------------------------------------------

/// The leaf hash: keccak(0x00 || recipient || amount_le).
///
/// These three functions are deliberately `pub`: the tests hand the REAL bytes
/// produced by the site's proof builder (scripts/build-merkle.mjs) straight to
/// this verifier and check that they agree. Otherwise a divergence between the
/// two implementations would only be noticed on TGE day, on a user's screen.
pub fn leaf_hash(claimant: &Pubkey, amount: u64) -> [u8; 32] {
    keccak::hashv(&[LEAF_PREFIX, claimant.as_ref(), &amount.to_le_bytes()]).0
}

/// The inner-node hash. The two children are sorted by byte order before
/// hashing (a "sorted pair"), which removes the need to carry which sibling was
/// on the left and which on the right in the proof.
pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    if a <= b {
        keccak::hashv(&[NODE_PREFIX, a, b]).0
    } else {
        keccak::hashv(&[NODE_PREFIX, b, a]).0
    }
}

pub fn verify_proof(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed = leaf;
    for sibling in proof {
        computed = node_hash(&computed, sibling);
    }
    computed == root
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = Distributor::LEN,
        seeds = [DISTRIBUTOR_SEED, mint.key().as_ref(), id.to_le_bytes().as_ref()],
        bump,
    )]
    pub distributor: Account<'info, Distributor>,

    /// The vault holding the round's tokens. Its owner is the distributor PDA
    /// itself — so the ONLY way tokens leave here is `claim`. The team holds no key
    /// that could empty this account.
    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = distributor,
        seeds = [VAULT_SEED, distributor.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(
        mut,
        seeds = [DISTRIBUTOR_SEED, distributor.mint.as_ref(), distributor.id.to_le_bytes().as_ref()],
        bump = distributor.bump,
        has_one = mint,
        has_one = vault,
    )]
    pub distributor: Account<'info, Distributor>,

    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// One account per recipient: the full share cannot be claimed twice from the
    /// same round. `init_if_needed` — created on the first claim, read afterwards.
    #[account(
        init_if_needed,
        payer = claimant,
        space = ClaimStatus::LEN,
        seeds = [CLAIM_SEED, distributor.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub claim_status: Account<'info, ClaimStatus>,

    /// The token account the payment goes to. Thanks to the
    /// `associated_token::authority` constraint this account MUST be the signer's
    /// own ATA — redirecting somebody else's share into your own wallet is not
    /// possible.
    #[account(
        init_if_needed,
        payer = claimant,
        associated_token::mint = mint,
        associated_token::authority = claimant,
    )]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Distributor {
    pub id: u64,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub merkle_root: [u8; 32],
    pub total_allocated: u64,
    pub total_claimed: u64,
    pub start_ts: i64,
    pub cliff_bps: u16,
    pub period_bps: u16,
    pub period_seconds: i64,
    pub periods: u16,
    pub bump: u8,
}

impl Distributor {
    // 8 (disc) + 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 2 + 2 + 8 + 2 + 1
    pub const LEN: usize = 8 + 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 2 + 2 + 8 + 2 + 1;
}

#[account]
pub struct ClaimStatus {
    /// The TOTAL this recipient has claimed from this round to date.
    pub claimed: u64,
    pub bump: u8,
}

impl ClaimStatus {
    // 8 (disc) + 8 + 1
    pub const LEN: usize = 8 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Olaylar
// ---------------------------------------------------------------------------

#[event]
pub struct DistributorInitialized {
    pub id: u64,
    pub mint: Pubkey,
    pub merkle_root: [u8; 32],
    pub total_allocated: u64,
    pub start_ts: i64,
    pub cliff_bps: u16,
    pub period_bps: u16,
    pub period_seconds: i64,
    pub periods: u16,
}

#[event]
pub struct Claimed {
    pub id: u64,
    pub claimant: Pubkey,
    pub amount: u64,
    pub total_claimed: u64,
    pub total_amount: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum DistributorError {
    #[msg("Invalid parameter.")]
    InvalidParam,
    #[msg("The unlock schedule does not reach 100% — cliff_bps + periods * period_bps must be exactly 10000.")]
    ScheduleNotComplete,
    #[msg("The merkle proof is too long.")]
    ProofTooLong,
    #[msg("The merkle proof is invalid — this address and amount are not in the list.")]
    InvalidProof,
    #[msg("There is nothing new to claim right now.")]
    NothingToClaim,
    #[msg("Kasada yeterli token yok.")]
    InsufficientVaultBalance,
    #[msg("No more than the total allocated to the round may be distributed.")]
    ExceedsAllocation,
    #[msg("Numeric overflow.")]
    MathOverflow,
}
