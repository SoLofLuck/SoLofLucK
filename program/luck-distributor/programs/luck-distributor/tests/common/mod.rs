// ---------------------------------------------------------------------------
// The test harness
// ---------------------------------------------------------------------------
// The tests never connect to the chain: solana-program-test builds the whole
// runtime in memory. That is what lets a 91-day vesting schedule be exercised
// end to end in seconds, by moving the clock forward by hand.
#![allow(dead_code)]

use anchor_lang::{InstructionData, ToAccountMetas};
use solana_program_test::*;
use solana_sdk::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::Instruction,
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
    transport::TransportError,
};

/// The `entry` Anchor generates treats the account slice and the AccountInfos as
/// having the same ('info) lifetime; `solana-program-test` calls them with
/// independent lifetimes, so the signatures do not match exactly. The standard
/// solution: copy the slice and leak it so it lives for the duration of the test
/// process. Acceptable in tests (the process exits after every run) and far
/// safer than an `unsafe` transmute.
pub fn entry_shim(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let accounts = Box::leak(Box::new(accounts.to_vec()));
    luck_distributor::entry(program_id, accounts, data)
}

pub fn program_test() -> ProgramTest {
    ProgramTest::new(
        "luck_distributor",
        luck_distributor::ID,
        processor!(entry_shim),
    )
}

// --- Presale takvimi: TGE %9 + 13 hafta × %7 = %100 ------------------------
pub const CLIFF_BPS: u16 = 900;
pub const PERIOD_BPS: u16 = 700;
pub const PERIODS: u16 = 13;
pub const WEEK: i64 = 7 * 24 * 60 * 60;

// --- Merkle ------------------------------------------------------------------
// EXACTLY the same hashing as in the program. We deliberately do not call the
// program's functions: a test must not take the implementation's own code as
// correct and repeat it. Because the two are written independently, the tests
// catch a change in one that does not agree with the other.
pub fn leaf_hash(claimant: &Pubkey, amount: u64) -> [u8; 32] {
    solana_sdk::keccak::hashv(&[&[0x00], claimant.as_ref(), &amount.to_le_bytes()]).0
}

fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    if a <= b {
        solana_sdk::keccak::hashv(&[&[0x01], a, b]).0
    } else {
        solana_sdk::keccak::hashv(&[&[0x01], b, a]).0
    }
}

/// A simple merkle tree. If an odd node is left over, the last node is promoted
/// to the level above as it is (the common "promote" approach).
pub struct MerkleTree {
    levels: Vec<Vec<[u8; 32]>>,
}

impl MerkleTree {
    pub fn new(leaves: Vec<[u8; 32]>) -> Self {
        assert!(!leaves.is_empty(), "empty tree");
        let mut levels = vec![leaves];
        while levels.last().unwrap().len() > 1 {
            let prev = levels.last().unwrap();
            let mut next = Vec::with_capacity(prev.len().div_ceil(2));
            let mut i = 0;
            while i < prev.len() {
                if i + 1 < prev.len() {
                    next.push(node_hash(&prev[i], &prev[i + 1]));
                } else {
                    next.push(prev[i]);
                }
                i += 2;
            }
            levels.push(next);
        }
        Self { levels }
    }

    pub fn root(&self) -> [u8; 32] {
        self.levels.last().unwrap()[0]
    }

    pub fn proof(&self, mut index: usize) -> Vec<[u8; 32]> {
        let mut proof = Vec::new();
        for level in &self.levels[..self.levels.len() - 1] {
            let sibling = if index % 2 == 0 { index + 1 } else { index - 1 };
            if sibling < level.len() {
                proof.push(level[sibling]);
            }
            index /= 2;
        }
        proof
    }
}

// --- Chain helpers -----------------------------------------------------------

/// Makes every transaction UNIQUE (see the same helper in luck-game).
///
/// The same signer + the same instruction + the same blockhash = a byte-identical
/// transaction; the chain does NOT process it again but does not error either, so
/// the test sees "success" while nothing happened on chain. An incrementing
/// compute-budget limit changes the message; the limit is high enough never to
/// bind and carries no extra fee, so it does not touch the token balances we
/// measure.
static TX_NONCE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub async fn send(
    ctx: &mut ProgramTestContext,
    ixs: &[Instruction],
    signers: &[&Keypair],
) -> Result<(), TransportError> {
    let nonce = TX_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut all_ixs = vec![
        solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(
            600_000 + nonce % 100_000,
        ),
    ];
    all_ixs.extend_from_slice(ixs);

    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![&ctx.payer];
    all.extend_from_slice(signers);
    let tx =
        Transaction::new_signed_with_payer(&all_ixs, Some(&ctx.payer.pubkey()), &all, blockhash);
    ctx.banks_client
        .process_transaction(tx)
        .await
        .map_err(Into::into)
}

pub async fn create_mint(ctx: &mut ProgramTestContext, authority: &Pubkey) -> Pubkey {
    let mint = Keypair::new();
    let rent = ctx.banks_client.get_rent().await.unwrap();
    let ixs = [
        system_instruction::create_account(
            &ctx.payer.pubkey(),
            &mint.pubkey(),
            rent.minimum_balance(spl_token::state::Mint::LEN),
            spl_token::state::Mint::LEN as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_mint(&spl_token::ID, &mint.pubkey(), authority, None, 9)
            .unwrap(),
    ];
    send(ctx, &ixs, &[&mint]).await.unwrap();
    mint.pubkey()
}

pub async fn mint_to(
    ctx: &mut ProgramTestContext,
    mint: &Pubkey,
    dest: &Pubkey,
    authority: &Keypair,
    amount: u64,
) {
    let ix = spl_token::instruction::mint_to(
        &spl_token::ID,
        mint,
        dest,
        &authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send(ctx, &[ix], &[authority]).await.unwrap();
}

pub async fn token_balance(ctx: &mut ProgramTestContext, account: &Pubkey) -> u64 {
    let acc = ctx.banks_client.get_account(*account).await.unwrap();
    match acc {
        Some(a) => spl_token::state::Account::unpack(&a.data).unwrap().amount,
        None => 0,
    }
}

/// Sets the chain's clock to the requested moment. Waiting out a vesting
/// schedule in real time is impossible, so this is the backbone of the tests.
///
/// We read the current Clock and change ONLY the timestamp: zeroing the slot and
/// epoch fields could cause unexpected behaviour elsewhere in the runtime.
///
/// We advance a slot BEFORE the timestamp. The reason is subtle but important
/// enough to make the tests flaky: if the same signer sends the same instruction
/// with the same blockhash twice, the result is a BYTE-IDENTICAL transaction and
/// the chain rejects it as "already processed". That is exactly what happened in
/// the weekly claim loop — run on its own the test passed because a new block
/// slipped in between, and run in parallel with the others it did not and the
/// test failed. Advancing the slot by hand takes the outcome out of the hands of
/// timing.
pub async fn set_time(ctx: &mut ProgramTestContext, unix_timestamp: i64) {
    let current: Clock = ctx.banks_client.get_sysvar::<Clock>().await.unwrap();
    ctx.warp_to_slot(current.slot + 1).unwrap();

    let mut clock: Clock = ctx.banks_client.get_sysvar::<Clock>().await.unwrap();
    clock.unix_timestamp = unix_timestamp;
    ctx.set_sysvar(&clock);
}

// --- PDA'lar -----------------------------------------------------------------

pub fn distributor_pda(mint: &Pubkey, id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"distributor", mint.as_ref(), &id.to_le_bytes()],
        &luck_distributor::ID,
    )
}

pub fn vault_pda(distributor: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", distributor.as_ref()], &luck_distributor::ID)
}

pub fn claim_status_pda(distributor: &Pubkey, claimant: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"claim", distributor.as_ref(), claimant.as_ref()],
        &luck_distributor::ID,
    )
}

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    spl_associated_token_account::get_associated_token_address(owner, mint)
}

// --- Talimatlar --------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub fn initialize_ix(
    authority: &Pubkey,
    mint: &Pubkey,
    id: u64,
    merkle_root: [u8; 32],
    total_allocated: u64,
    start_ts: i64,
    cliff_bps: u16,
    period_bps: u16,
    period_seconds: i64,
    periods: u16,
) -> Instruction {
    let (distributor, _) = distributor_pda(mint, id);
    let (vault, _) = vault_pda(&distributor);
    Instruction {
        program_id: luck_distributor::ID,
        accounts: luck_distributor::accounts::Initialize {
            authority: *authority,
            mint: *mint,
            distributor,
            vault,
            token_program: spl_token::ID,
            system_program: solana_sdk::system_program::ID,
            rent: solana_sdk::sysvar::rent::ID,
        }
        .to_account_metas(None),
        data: luck_distributor::instruction::Initialize {
            id,
            merkle_root,
            total_allocated,
            start_ts,
            cliff_bps,
            period_bps,
            period_seconds,
            periods,
        }
        .data(),
    }
}

pub fn claim_ix(
    claimant: &Pubkey,
    mint: &Pubkey,
    id: u64,
    total_amount: u64,
    proof: Vec<[u8; 32]>,
) -> Instruction {
    let (distributor, _) = distributor_pda(mint, id);
    let (vault, _) = vault_pda(&distributor);
    let (claim_status, _) = claim_status_pda(&distributor, claimant);
    Instruction {
        program_id: luck_distributor::ID,
        accounts: luck_distributor::accounts::Claim {
            claimant: *claimant,
            distributor,
            mint: *mint,
            vault,
            claim_status,
            destination: ata(claimant, mint),
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: luck_distributor::instruction::Claim {
            total_amount,
            proof,
        }
        .data(),
    }
}
