// ---------------------------------------------------------------------------
// luck-game test altyapısı
// ---------------------------------------------------------------------------
// Testler zincire HİÇ bağlanmıyor: solana-program-test tüm çalışma zamanını
// (BanksClient) belleğe kuruyor.
//
// Buradaki asıl kazanç, devnet'te ancak ŞANSA BAĞLI olarak karşılaşılan
// durumları doğrudan kurabilmek:
//   - hedef slot atlanmış (lideri blok üretememiş)
//   - resolve penceresi kapanmış
//   - kasa jackpot'u karşılayamayacak kadar boş
// Devnet'te bunları beklemek saatler sürer ve tekrarlanamaz; burada her
// koşuda, istendiği kadar sınanabiliyorlar.
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

/// Anchor'ın ürettiği `entry`, hesap dilimiyle AccountInfo'ların ömrünü
/// aynı ('info) kabul ediyor; solana-program-test ise ikisini bağımsız
/// ömürlerle çağırıyor. Standart çözüm: dilimi kopyalayıp test süreci
/// boyunca yaşayacak şekilde sızdırmak.
pub fn entry_shim(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let accounts = Box::leak(Box::new(accounts.to_vec()));
    luck_game::entry(program_id, accounts, data)
}

// --- Varsayılan oyun parametreleri ------------------------------------------
// Sitedeki gerçek değerlere yakın ama testlerde okunabilir olsun diye yuvarlak.
pub const SOL: u64 = 1_000_000_000;
pub const SMALL_PRIZE: u64 = SOL / 2; // 0,5 SOL
pub const BIG_PRIZE: u64 = SOL; // 1 SOL
pub const BIG_PRIZE_BPS: u16 = 3_000; // kazananların %30'u jackpot
pub const TREASURY_FEE_BPS: u16 = 2_000; // %20 ev payı
pub const REVEAL_DELAY: u64 = 5;
pub const EASY_THRESHOLD: u64 = BIG_PRIZE + BIG_PRIZE / 5; // jackpot + payı
pub const NORMAL_WIN_BPS: u16 = 50; // %0,5
pub const EASY_WIN_BPS: u16 = 1_000; // %10
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
    /// Programı kurar, initialize() çağırır ve kasayı `vault_lamports` ile
    /// tohumlar. Kasa bakiyesi testin ana kaldıracı: "kolay mod"a geçip
    /// geçmediği, ödülü ödeyip ödeyemediği hep buna bakıyor.
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
        Some(
            anchor_lang::AccountDeserialize::try_deserialize(&mut acc.data.as_slice()).unwrap(),
        )
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

    /// SlotHashes sysvar'ını doğrudan kurar.
    ///
    /// resolve() testlerinin bel kemiği: hangi slot'ların blok ÜRETTİĞİNİ
    /// burada biz belirliyoruz, dolayısıyla "hedef slot atlanmış" senaryosu
    /// şansa bırakılmadan, her koşuda aynı şekilde kurulabiliyor.
    pub fn set_slot_hashes(&mut self, entries: &[(u64, [u8; 32])]) {
        let mut list: Vec<(u64, solana_sdk::hash::Hash)> = entries
            .iter()
            .map(|(s, h)| (*s, solana_sdk::hash::Hash::new_from_array(*h)))
            .collect();
        // Sysvar en yeniden eskiye sıralı tutulur.
        list.sort_by(|a, b| b.0.cmp(&a.0));
        let slot_hashes = SlotHashes::new(&list);
        self.ctx.set_sysvar(&slot_hashes);
    }

    /// Bir talimatın harcadığı işlem birimini (compute unit) ölçer.
    ///
    /// İstemci her işleme sabit bir CU limiti koyuyor (sendTx.ts,
    /// COMPUTE_UNIT_LIMIT). Bir talimat o limiti aşarsa işlem MAINNET'TE
    /// düşer ve bunu ancak kullanıcılar fark eder. Ölçümü teste bağlamak,
    /// limiti aşan bir değişikliği burada yakalıyor.
    pub async fn compute_units(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> u64 {
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
            .expect("simülasyon ayrıntısı yok")
            .units_consumed
    }

    /// `warp_to_slot`, ARADAKİ TÜM SLOT'LARI ATLAR — yani gerçek bir
    /// "atlanan slot" durumu üretir. Testlerde SlotHashes'i genelde elle
    /// kurduğumuz için bu daha çok saatin ilerlemesi için kullanılıyor.
    pub fn warp(&mut self, slot: u64) {
        self.ctx.warp_to_slot(slot).unwrap();
    }
}

/// Her işlemi BENZERSİZ yapar — bu ayrıntı testleri sessizce yalancı
/// yapıyordu.
///
/// Aynı imzacı, aynı talimatı, aynı blockhash'le gönderirse ortaya birebir
/// aynı işlem (aynı imza) çıkıyor. Zincir bunu tekrar İŞLEMİYOR ve
/// process_transaction hata da vermiyor — çağıran taraf "başarılı" görüyor
/// ama ZİNCİRDE HİÇBİR ŞEY OLMUYOR. `ikinci_satin_almada_kira_iadesi_yok`
/// tam olarak buna kurban gitti: ikinci satın alma hiç koşmadığı için
/// bakiye değişimi 0 çıkıyor, test 10 koşunun 8'inde düşüyordu. Tersi daha
/// tehlikeliydi: gerçekten bozuk bir kontrol de, ikinci işlem hiç
/// koşmadığı için "geçmiş" görünebilirdi.
///
/// Çözüm olarak her işleme, sayacı artan bir compute-budget limiti
/// ekliyoruz. Mesaj değişiyor, dolayısıyla imza da değişiyor; limit
/// gerçekte hiç bağlayıcı olmayacak kadar yüksek ve ek ücreti yok, yani
/// ölçtüğümüz hiçbir bakiyeye dokunmuyor.
///
/// Bunun yerine slot ilerletmek (warp) daha doğal görünüyor ama olmuyor:
/// warp yeni bir banka üretip SlotHashes'i yeniden hesaplıyor, oysa
/// resolve testlerinin tamamı o sysvar'ı elle kurmaya dayanıyor.
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

/// Bir hesaba lamport gönderir — `set_account` ile DEĞİL, gerçek bir
/// transferle.
///
/// Bu ayrım testleri sessizce bozacak kadar önemli: `set_account` lamport'u
/// yoktan var ediyor, dolayısıyla zincirin toplam arz değişmezi bozuluyor.
/// `warp_to_slot` her sıçramada bu değişmezi doğruladığı için, zamanı
/// ilerleten HER test "calculate_accounts_hash_with_verify mismatch" ile
/// çöküyordu. Transfer, parayı zaten devasa bakiyesi olan test payer'ından
/// aldığı için denge korunuyor.
pub async fn fund(ctx: &mut ProgramTestContext, key: &Pubkey, lamports: u64) {
    let ix = solana_sdk::system_instruction::transfer(&ctx.payer.pubkey(), key, lamports);
    send(ctx, &[ix], &[]).await.unwrap();
}

/// Yeni bir oyuncu cüzdanı: anahtar + bakiye.
pub async fn new_player(ctx: &mut ProgramTestContext, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    fund(ctx, &kp.pubkey(), lamports).await;
    kp
}

/// İşlemin TAM OLARAK beklenen program hatasıyla düştüğünü doğrular.
///
/// "herhangi bir hata aldı" demek yetmez: yanlış sebeple düşen bir işlem
/// de testi geçirir ve asıl kontrolün çalışmadığını gizler. Hata kodu
/// enum'ın kendisinden türetiliyor, elle yazılmıyor — enum'da sıra
/// değişirse testler de onunla birlikte kayar.
pub fn assert_game_error(err: &TransportError, expected: luck_game::GameError) {
    let code = expected as u32 + anchor_lang::error::ERROR_CODE_OFFSET;
    let text = format!("{err:?}");
    let needle = format!("Custom({code})");
    assert!(
        text.contains(&needle),
        "beklenen hata {expected:?} ({needle}) değil, gelen: {text}"
    );
}

// --- Zarın bağımsız türetimi ------------------------------------------------
/// 10000'e göre kalanı BAYT BAYT yürüterek hesaplar.
///
/// `u64::from_le_bytes(b) % 10000` ile aynı sonucu verir ama bambaşka bir
/// yoldan: sayıyı hiç kurmadan, en anlamlı bayttan başlayarak her adımda
/// `kalan = (kalan * 256 + bayt) % 10000` yürütüyor. Programdaki ifadenin
/// kopyası olmadığı için, o ifade yanlış yazılmış olsaydı bu test
/// yakalardı.
pub fn kalan_10000(bytes: &[u8]) -> u32 {
    let mut kalan: u64 = 0;
    for b in bytes.iter().rev() {
        kalan = (kalan * 256 + *b as u64) % 10_000;
    }
    kalan as u32
}

/// Zarı spesifikasyondan yeniden üretir:
///   digest = sha256(slot_hash ‖ slot_le ‖ oyuncu ‖ oyun_sayaci_le)
///   roll   = digest[0..8]  (little-endian u64) mod 10000
pub fn beklenen_zar(slot_hash: &[u8; 32], slot: u64, oyuncu: &Pubkey, oyun_sayaci: u32) -> u32 {
    let mut preimage = Vec::new();
    preimage.extend_from_slice(slot_hash);
    preimage.extend_from_slice(&slot.to_le_bytes());
    preimage.extend_from_slice(oyuncu.as_ref());
    preimage.extend_from_slice(&oyun_sayaci.to_le_bytes());
    let digest = solana_sdk::hash::hash(&preimage).to_bytes();
    kalan_10000(&digest[0..8])
}

/// Tur numarasından deterministik ama birbirinden bağımsız hash'ler.
pub fn tur_hash(tur: u32) -> [u8; 32] {
    solana_sdk::hash::hash(&tur.to_le_bytes()).to_bytes()
}


