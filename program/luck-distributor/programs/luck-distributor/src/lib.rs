// ---------------------------------------------------------------------------
// luck-distributor — $LUCK dağıtımı
// ---------------------------------------------------------------------------
// TEK BİR HESAP TİPİ iki işi birden yapıyor:
//
//   * PRESALE VESTING — alıcı payını tek seferde değil, ilan edilen takvime
//     göre kademeli çeker (TGE'de %9, sonra 13 hafta boyunca haftada %7).
//   * ÇEKİLİŞ ÖDEMELERİ — haftalık çekiliş kazananları paylarını hemen çeker.
//
// İkisi ayrı kod yolu DEĞİL: çekiliş, "vesting'i %100 peşin olan bir
// dağıtıcı"dan ibaret (cliff_bps = 10000). Böylece test edilecek, gözden
// geçirilecek ve hata yapılabilecek tek bir mantık var. Bu program TGE günü
// 271 milyon token tutacak; buradaki en büyük risk karmaşıklığın kendisi.
//
// NEDEN MERKLE: alıcı sayısı birkaç yüz olacak. Her alıcı için zincirde
// hesap açmak hem pahalı hem yavaş olurdu. Bunun yerine zincirde tek bir
// 32 baytlık kök duruyor; alıcı, payını kanıtlayan "kardeş düğüm" listesini
// (proof) getiriyor. Liste ve ağaç sitede yayınlanıyor, herkes kendi
// kanıtını üretip doğrulayabiliyor.
//
// KASIT: PARAYI GERİ ÇEKME TALİMATI YOK.
// Hiç talep edilmeyen tokenler sonsuza kadar burada kilitli kalır — yani
// fiilen yakılmış olur. "Ekip kalanı geri alabilir" diyen bir talimat
// eklemek, dağıtımın tamamını tek bir imzaya bağımlı hale getirirdi;
// alıcının "bunu bizden kimse geri alamaz" diyebilmesi bundan daha
// değerli. Bunun bedeli şu: kilitlenen miktar yanlış hesaplanırsa fazlası
// da kilitli kalır. Bu yüzden `initialize` içindeki toplam kontrolü sıkı.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// Geçici adres — gerçek Program ID, deploy sırasında `anchor keys sync`
// tarafından keypair'e göre yazılıyor (bkz. deploy workflow'u). Burada
// sistem programının adresini (111...) bırakmak testlerde çakışma
// yaratırdı, o yüzden geçerli ama kullanılmayan bir adres duruyor.
declare_id!("A4aN3aL2ZTLYBwAfECbh75g51cJfVd7r9tN8k6qvXGYL");

const DISTRIBUTOR_SEED: &[u8] = b"distributor";
const VAULT_SEED: &[u8] = b"vault";
const CLAIM_SEED: &[u8] = b"claim";

/// Basis point tabanı (10000 = %100).
const BPS_DENOMINATOR: u64 = 10_000;

/// Merkle ağacında yaprak ile iç düğümü ayıran ön ekler.
///
/// Aynı hash fonksiyonu hem yaprak hem düğüm için ön eksiz kullanılsaydı,
/// bir saldırgan var olan bir iç düğümü "yaprak" gibi sunup kendi
/// uydurduğu (alıcı, miktar) çiftini doğrulatabilirdi (ikinci ön görüntü
/// saldırısı). Ön ek, iki alan adını birbirinden ayırıyor.
const LEAF_PREFIX: &[u8] = &[0x00];
const NODE_PREFIX: &[u8] = &[0x01];

/// Bir proof'ta kabul edilen en fazla kardeş düğüm sayısı.
///
/// 32 seviye, 2^32 (dört milyardan fazla) alıcıyı kapsar — yani pratikte
/// hiç bağlayıcı değil. Sınırın kendisi, işlem boyutunu ve hesaplama
/// birimini kasıtlı olarak şişiren bir çağrıya karşı üst sınır koyuyor.
const MAX_PROOF_LEN: usize = 32;

#[program]
pub mod luck_distributor {
    use super::*;

    /// Yeni bir dağıtım turu açar ve kasasını oluşturur.
    ///
    /// `id`, aynı mint için birden çok turu ayırt ediyor: 0 = presale,
    /// 1..14 = haftalık çekilişler. Tur açıldıktan sonra kökü, takvimi ve
    /// toplamı DEĞİŞTİRİLEMEZ — güncelleme talimatı bilerek yok. Yanlış bir
    /// kökle açılan tur, düzeltilmek yerine terk edilip yenisi açılır;
    /// böylece "ekip kökü değiştirip payları yeniden yazabilir" diye bir
    /// ihtimal hiç doğmuyor.
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

        // Takvim MUTLAKA tam %100'e ulaşmalı. Bu kontrol olmasaydı, ör.
        // %7 × 14 = %98 gibi bir yapılandırma sessizce kabul edilir ve
        // alıcıların son %2'si sonsuza kadar kasada kilitli kalırdı — hem
        // de kimse fark etmeden, aylar sonra.
        let total_bps = (cliff_bps as u64)
            .checked_add((periods as u64).checked_mul(period_bps as u64).ok_or(DistributorError::MathOverflow)?)
            .ok_or(DistributorError::MathOverflow)?;
        require!(total_bps == BPS_DENOMINATOR, DistributorError::ScheduleNotComplete);

        // Kademe varsa aralık sıfır olamaz; yoksa "geçen süre / aralık"
        // hesabı sıfıra bölme olurdu ve tüm kademeler ilk saniyede açılırdı.
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

    /// Alıcının, o an açılmış olan payını çeker.
    ///
    /// `total_amount`, alıcının TÜM tur boyunca hak ettiği toplam — merkle
    /// yaprağında yazan sayı. Program bundan "şu ana kadar açılan"ı
    /// hesaplayıp, daha önce çekilenin farkını gönderiyor. Yani alıcı
    /// isterse her hafta, isterse en sonda tek seferde çeker; sonuç aynı.
    ///
    /// İzinsiz (permissionless) DEĞİL: imzayı alıcının kendisi atmak
    /// zorunda ve token hesabı da onun. Başkası adına çağırıp parayı
    /// başka yere yönlendirmek mümkün değil.
    pub fn claim(ctx: Context<Claim>, total_amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        require!(proof.len() <= MAX_PROOF_LEN, DistributorError::ProofTooLong);
        require!(total_amount > 0, DistributorError::InvalidParam);

        let claimant = ctx.accounts.claimant.key();
        let distributor = &ctx.accounts.distributor;

        // 1) Bu (alıcı, miktar) çifti gerçekten ağaçta mı?
        let leaf = leaf_hash(&claimant, total_amount);
        require!(
            verify_proof(&proof, distributor.merkle_root, leaf),
            DistributorError::InvalidProof
        );

        // 2) Şu ana kadar ne kadarı açıldı?
        let now = Clock::get()?.unix_timestamp;
        let unlocked = unlocked_amount(distributor, total_amount, now)?;

        // 3) Daha önce çekilenin farkı kadar gönder.
        let status = &mut ctx.accounts.claim_status;
        require!(unlocked > status.claimed, DistributorError::NothingToClaim);
        let amount = unlocked
            .checked_sub(status.claimed)
            .ok_or(DistributorError::MathOverflow)?;

        // Kasada gerçekten var mı? Olmayan parayı "çekildi" diye
        // işaretlememek için transferden ÖNCE bakıyoruz — aksi halde
        // yetersiz bakiye hatası tüm işlemi geri alır ama kafa karıştırıcı
        // bir hata mesajıyla.
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
        // Turun tamamından fazlası dağıtılamaz. Merkle kökü doğru
        // kurulduysa bu zaten imkânsız; yine de kontrol ediyoruz çünkü
        // kökü biz üretiyoruz ve bir üretim hatası burada durdurulmalı,
        // kasa boşaldıktan sonra değil.
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
// Vesting hesabı
// ---------------------------------------------------------------------------

/// Verilen ana kadar açılmış toplam miktar.
///
/// Kademe sayısı tavanlandığı ve `initialize` toplam bps'in tam 10000
/// olmasını zorladığı için, takvim bittiğinde sonuç `total`'a TAM eşit
/// olur — yuvarlamadan artan toz kalmaz.
fn unlocked_amount(d: &Distributor, total: u64, now: i64) -> Result<u64> {
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

    // u128 üzerinden: total 64 bit'e yakın olsa bile çarpım taşmaz.
    let unlocked = (total as u128)
        .checked_mul(bps as u128)
        .ok_or(DistributorError::MathOverflow)?
        / (BPS_DENOMINATOR as u128);

    Ok(unlocked as u64)
}

// ---------------------------------------------------------------------------
// Merkle doğrulama
// ---------------------------------------------------------------------------

/// Yaprak hash'i: keccak(0x00 || alıcı || miktar_le).
///
/// Bu üç fonksiyon bilerek `pub`: testler, sitenin kanıt üreticisinin
/// (scripts/build-merkle.mjs) ürettiği GERÇEK baytları doğrudan bu
/// doğrulayıcıya verip uyuştuklarını sınıyor. Aksi halde iki uygulamanın
/// ayrışması ancak TGE günü, kullanıcının ekranında fark edilirdi.
pub fn leaf_hash(claimant: &Pubkey, amount: u64) -> [u8; 32] {
    keccak::hashv(&[LEAF_PREFIX, claimant.as_ref(), &amount.to_le_bytes()]).0
}

/// İç düğüm hash'i. İki çocuğu bayt sırasına göre sıralayıp hash'liyoruz
/// ("sorted pair"): böylece proof'ta hangi kardeşin sağda hangisinin solda
/// olduğunu ayrıca taşımaya gerek kalmıyor.
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
// Hesaplar
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

    /// Turun tokenlarını tutan kasa. Sahibi dağıtıcı PDA'sının kendisi —
    /// yani buradan token çıkarmanın TEK yolu `claim`. Ekibin elinde bu
    /// hesabı boşaltabilecek bir anahtar yok.
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

    /// Alıcı başına tek hesap: aynı turdan iki kez tam pay çekilemez.
    /// `init_if_needed` — ilk çekişte oluşur, sonrakilerde okunur.
    #[account(
        init_if_needed,
        payer = claimant,
        space = ClaimStatus::LEN,
        seeds = [CLAIM_SEED, distributor.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub claim_status: Account<'info, ClaimStatus>,

    /// Ödemenin gideceği token hesabı. `associated_token::authority`
    /// kısıtı sayesinde bu hesap MUTLAKA imzalayanın kendi ATA'sı —
    /// başkasının payını kendi cüzdanına yönlendirmek mümkün değil.
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
// Durum
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
    /// Bu alıcının bu turdan bugüne kadar çektiği TOPLAM.
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
// Hatalar
// ---------------------------------------------------------------------------

#[error_code]
pub enum DistributorError {
    #[msg("Geçersiz parametre.")]
    InvalidParam,
    #[msg("Açılış takvimi %100'e ulaşmıyor — cliff_bps + periods * period_bps tam 10000 olmalı.")]
    ScheduleNotComplete,
    #[msg("Merkle kanıtı çok uzun.")]
    ProofTooLong,
    #[msg("Merkle kanıtı geçersiz — bu adres ve miktar listede yok.")]
    InvalidProof,
    #[msg("Şu an çekilebilecek yeni bir miktar yok.")]
    NothingToClaim,
    #[msg("Kasada yeterli token yok.")]
    InsufficientVaultBalance,
    #[msg("Tur için ayrılan toplamdan fazlası dağıtılamaz.")]
    ExceedsAllocation,
    #[msg("Sayısal taşma.")]
    MathOverflow,
}
