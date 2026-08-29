// ---------------------------------------------------------------------------
// luck-game test harness
// ---------------------------------------------------------------------------
// The tests never touch a chain: solana-program-test builds the whole runtime
// (BanksClient) in memory.
//
// The real gain here is being able to set up, directly, the situations that on
// devnet only come up BY CHANCE:
//   - the target slot was skipped (its leader failed to produce a block)
//   - the resolve window closed
//   - the vault is too empty to cover the jackpot
// Waiting for these on devnet takes hours and cannot be repeated; here they can
// be exercised on every run, as often as you like.
#![allow(dead_code)]

use anchor_lang::{InstructionData, ToAccountMetas};
use solana_program_test::*;
use solana_sdk::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    slot_hashes::SlotHashes,
    sysvar::slot_hashes as slot_hashes_sysvar,
    transaction::Transaction,
    transport::TransportError,
};

/// The `entry` Anchor generates assumes the account slice and the AccountInfos
/// share the same lifetime ('info), while solana-program-test calls the two
/// with independent lifetimes. The standard fix: copy the slice and leak it so
/// it lives for the whole test process.
pub fn entry_shim(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let accounts = Box::leak(Box::new(accounts.to_vec()));
    luck_game::entry(program_id, accounts, data)
}

// --- Default game parameters ------------------------------------------------
// Close to the real values on the site, but rounded so the tests stay readable.
pub const SOL: u64 = 1_000_000_000;
pub const SMALL_PRIZE: u64 = SOL / 2; // 0.5 SOL
pub const BIG_PRIZE: u64 = SOL; // 1 SOL
pub const BIG_PRIZE_BPS: u16 = 3_000; // 30% of winners hit the jackpot
pub const TREASURY_FEE_BPS: u16 = 2_000; // 20% house share
pub const REVEAL_DELAY: u64 = 5;
pub const EASY_THRESHOLD: u64 = BIG_PRIZE + BIG_PRIZE / 5; // jackpot + its fee
pub const NORMAL_WIN_BPS: u16 = 50; // 0.5%
pub const EASY_WIN_BPS: u16 = 1_000; // 10%
pub const TIER_COUNTS: [u16; 6] = [1, 5, 10, 20, 50, 100];
pub const TIER_PRICES: [u64; 6] = [
    SOL / 10,
    SOL * 3 / 10,
    SOL / 2,
    SOL * 8 / 10,
    SOL * 3 / 2,
    SOL * 5 / 2,
];

pub struct Game {
    pub ctx: ProgramTestContext,
    pub authority: Keypair,
    pub treasury: Pubkey,
    pub config: Pubkey,
    pub vault: Pubkey,
}

pub fn config_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"config"], &luck_game::ID)
}

pub fn vault_pda(config: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", config.as_ref()], &luck_game::ID)
}

pub fn player_pda(player: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"player", player.as_ref()], &luck_game::ID)
}

pub fn program_test() -> ProgramTest {
    ProgramTest::new("luck_game", luck_game::ID, processor!(entry_shim))
}

impl Game {
    /// Loads the program, calls initialize() and seeds the vault with
    /// `vault_lamports`. The vault balance is the main lever in these tests:
    /// whether "easy mode" kicks in and whether the prize can be paid both hang
    /// off it.
    pub async fn start(vault_lamports: u64) -> Self {
        Self::start_with(vault_lamports, NORMAL_WIN_BPS, EASY_WIN_BPS, 0).await
    }

    pub async fn start_with(
        vault_lamports: u64,
        normal_win_bps: u16,
        easy_win_bps: u16,
        free_plays: u8,
    ) -> Self {
        let mut ctx = program_test().start_with_context().await;
        let authority = Keypair::new();
        let treasury = Pubkey::new_unique();
        let (config, _) = config_pda();
        let (vault, _) = vault_pda(&config);

        fund(&mut ctx, &authority.pubkey(), 100 * SOL).await;

        let ix = Instruction {
            program_id: luck_game::ID,
            accounts: luck_game::accounts::Initialize {
                authority: authority.pubkey(),
                config,
                treasury,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: luck_game::instruction::Initialize {
                free_plays,
                small_prize_lamports: SMALL_PRIZE,
                big_prize_lamports: BIG_PRIZE,
                big_prize_bps: BIG_PRIZE_BPS,
                vault_easy_threshold_lamports: EASY_THRESHOLD,
                normal_win_bps,
                easy_win_bps,
                treasury_fee_bps: TREASURY_FEE_BPS,
                reveal_delay_slots: REVEAL_DELAY,
                spin_tier_counts: TIER_COUNTS,
                spin_tier_prices: TIER_PRICES,
            }
            .data(),
        };
        send(&mut ctx, &[ix], &[&authority]).await.unwrap();

        if vault_lamports > 0 {
            fund(&mut ctx, &vault, vault_lamports).await;
        }

        Game {
            ctx,
            authority,
            treasury,
            config,
            vault,
        }
    }

    pub async fn lamports(&mut self, key: &Pubkey) -> u64 {
        self.ctx
            .banks_client
            .get_account(*key)
            .await
            .unwrap()
            .map(|a| a.lamports)
            .unwrap_or(0)
    }

    pub async fn player_state(&mut self, player: &Pubkey) -> Option<luck_game::PlayerState> {
        let (pda, _) = player_pda(player);
        let acc = self.ctx.banks_client.get_account(pda).await.unwrap()?;
        Some(anchor_lang::AccountDeserialize::try_deserialize(&mut acc.data.as_slice()).unwrap())
    }

    pub async fn slot(&mut self) -> u64 {
        self.ctx
            .banks_client
            .get_sysvar::<solana_sdk::clock::Clock>()
            .await
            .unwrap()
            .slot
    }

    // --- Talimatlar ---------------------------------------------------------

    pub fn buy_spins_ix(&self, player: &Pubkey, delegate: &Pubkey, tier: u8) -> Instruction {
        let (player_state, _) = player_pda(player);
        Instruction {
            program_id: luck_game::ID,
            accounts: luck_game::accounts::BuySpins {
                player: *player,
                config: self.config,
                player_state,
                vault: self.vault,
                treasury: self.treasury,
                delegate: *delegate,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: luck_game::instruction::BuySpins { tier_index: tier }.data(),
        }
    }

    pub fn register_delegate_ix(&self, player: &Pubkey, delegate: &Pubkey) -> Instruction {
        let (player_state, _) = player_pda(player);
        Instruction {
            program_id: luck_game::ID,
            accounts: luck_game::accounts::RegisterDelegate {
                player: *player,
                config: self.config,
                player_state,
                vault: self.vault,
                delegate: *delegate,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: luck_game::instruction::RegisterDelegate {}.data(),
        }
    }

    pub fn play_ix(&self, owner: &Pubkey, authority: &Pubkey) -> Instruction {
        let (player_state, _) = player_pda(owner);
        Instruction {
            program_id: luck_game::ID,
            accounts: luck_game::accounts::Play {
                owner: *owner,
                authority: *authority,
                config: self.config,
                player_state,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: luck_game::instruction::Play {}.data(),
        }
    }

    pub fn resolve_ix(&self, player: &Pubkey) -> Instruction {
        let (player_state, _) = player_pda(player);
        Instruction {
            program_id: luck_game::ID,
            accounts: luck_game::accounts::Resolve {
                player: *player,
                config: self.config,
                player_state,
                vault: self.vault,
                treasury: self.treasury,
                slot_hashes: slot_hashes_sysvar::ID,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: luck_game::instruction::Resolve {}.data(),
        }
    }

    pub fn forfeit_ix(&self, player: &Pubkey) -> Instruction {
        let (player_state, _) = player_pda(player);
        Instruction {
            program_id: luck_game::ID,
            accounts: luck_game::accounts::ForfeitStuckPlay {
                player: *player,
                config: self.config,
                player_state,
            }
            .to_account_metas(None),
            data: luck_game::instruction::ForfeitStuckPlay {}.data(),
        }
    }

    pub async fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(), TransportError> {
        send(&mut self.ctx, ixs, signers).await
    }

    /// Sets the SlotHashes sysvar directly.
    ///
    /// The backbone of the resolve() tests: we decide here which slots PRODUCED a
    /// block, so the "target slot was skipped" scenario can be set up the same way
    /// on every run instead of being left to chance.
    pub fn set_slot_hashes(&mut self, entries: &[(u64, [u8; 32])]) {
        let mut list: Vec<(u64, solana_sdk::hash::Hash)> = entries
            .iter()
            .map(|(s, h)| (*s, solana_sdk::hash::Hash::new_from_array(*h)))
            .collect();
        // The sysvar is kept ordered from newest to oldest.
        list.sort_by_key(|a| std::cmp::Reverse(a.0));
        let slot_hashes = SlotHashes::new(&list);
        self.ctx.set_sysvar(&slot_hashes);
    }

    /// Measures the compute units an instruction spends.
    ///
    /// The client puts a fixed CU limit on every transaction (sendTx.ts,
    /// COMPUTE_UNIT_LIMIT). If an instruction goes past that limit the transaction
    /// fails ON MAINNET, and only users would notice. Tying the measurement to a
    /// test catches a change that breaches the limit here instead.
    pub async fn compute_units(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> u64 {
        let blockhash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let mut all: Vec<&Keypair> = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&self.ctx.payer.pubkey()),
            &all,
            blockhash,
        );
        let sim = self
            .ctx
            .banks_client
            .simulate_transaction(tx)
            .await
            .unwrap();
        sim.simulation_details
            .expect("no simulation details")
            .units_consumed
    }

    /// `warp_to_slot` SKIPS EVERY SLOT IN BETWEEN — that is, it produces a real
    /// "skipped slot" situation. Because the tests usually set SlotHashes by hand,
    /// this is mostly used to move the clock forward.
    pub fn warp(&mut self, slot: u64) {
        self.ctx.warp_to_slot(slot).unwrap();
    }
}

/// Makes every transaction UNIQUE — a detail that was quietly turning the tests
/// into liars.
///
/// If the same signer sends the same instruction with the same blockhash, the
/// result is a byte-identical transaction (the same signature). The chain does
/// NOT process it again, and process_transaction does not raise an error either
/// — the caller sees "success" while NOTHING HAPPENS ON CHAIN.
/// `no_rent_refund_on_a_second_purchase` fell victim to exactly this: because
/// the second purchase never ran, the balance change came out as 0 and the test
/// failed on 8 runs out of 10. The reverse was more dangerous: a genuinely
/// broken check could also look like it "passed", because the second
/// transaction never ran at all.
///
/// The fix is to add a compute-budget limit with an increasing counter to every
/// transaction. The message changes, so the signature changes too; the limit is
/// high enough never to bind in practice and costs nothing extra, so it touches
/// none of the balances we measure.
///
/// Advancing the slot (warp) instead looks more natural, but it does not work:
/// warp produces a new bank and recomputes SlotHashes, whereas the resolve
/// tests rest entirely on setting that sysvar by hand.
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

/// Sends lamports to an account — with a real transfer, NOT with
/// `set_account`.
///
/// The distinction matters enough to break the tests silently:
/// `set_account` conjures lamports out of nothing, which breaks the chain's
/// total-supply invariant. Because `warp_to_slot` verifies that invariant on
/// every jump, EVERY test that moved the clock forward crashed with
/// "calculate_accounts_hash_with_verify mismatch". A transfer keeps the books
/// balanced, because it takes the money from the test payer, which already has
/// an enormous balance.
pub async fn fund(ctx: &mut ProgramTestContext, key: &Pubkey, lamports: u64) {
    let ix = solana_sdk::system_instruction::transfer(&ctx.payer.pubkey(), key, lamports);
    send(ctx, &[ix], &[]).await.unwrap();
}

/// A new player wallet: a key plus a balance.
pub async fn new_player(ctx: &mut ProgramTestContext, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    fund(ctx, &kp.pubkey(), lamports).await;
    kp
}

/// Asserts that the transaction failed with EXACTLY the expected program error.
///
/// "It got some error" is not enough: a transaction that fails for the wrong
/// reason also passes the test and hides the fact that the real check is not
/// working. The error code is derived from the enum itself rather than written
/// out by hand — if the order in the enum changes, the tests move with it.
pub fn assert_game_error(err: &TransportError, expected: luck_game::GameError) {
    let code = expected as u32 + anchor_lang::error::ERROR_CODE_OFFSET;
    let text = format!("{err:?}");
    let needle = format!("Custom({code})");
    assert!(
        text.contains(&needle),
        "expected error {expected:?} ({needle}), got: {text}"
    );
}

// --- An independent derivation of the dice ----------------------------------
/// Computes the remainder modulo 10000 by walking BYTE BY BYTE.
///
/// It gives the same result as `u64::from_le_bytes(b) % 10000` but by a wholly
/// different route: without ever assembling the number, starting from the most
/// significant byte and stepping
/// `remaining = (remaining * 256 + byte) % 10000` each time. Because it is not
/// a copy of the expression in the program, this test would catch that
/// expression being written wrong.
pub fn remainder_10000(bytes: &[u8]) -> u32 {
    let mut remaining: u64 = 0;
    for b in bytes.iter().rev() {
        remaining = (remaining * 256 + *b as u64) % 10_000;
    }
    remaining as u32
}

/// Reproduces the dice from the specification:
///   digest = sha256(slot_hash ‖ slot_le ‖ player ‖ plays_count_le)
///   roll   = digest[0..8]  (little-endian u64) mod 10000
pub fn expected_dice(slot_hash: &[u8; 32], slot: u64, player: &Pubkey, plays_count: u32) -> u32 {
    let mut preimage = Vec::new();
    preimage.extend_from_slice(slot_hash);
    preimage.extend_from_slice(&slot.to_le_bytes());
    preimage.extend_from_slice(player.as_ref());
    preimage.extend_from_slice(&plays_count.to_le_bytes());
    let digest = solana_sdk::hash::hash(&preimage).to_bytes();
    remainder_10000(&digest[0..8])
}

/// Hashes that are deterministic in the round number but independent of one another.
pub fn round_hash(round: u32) -> [u8; 32] {
    solana_sdk::hash::hash(&round.to_le_bytes()).to_bytes()
}
