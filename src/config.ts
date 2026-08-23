import { clusterApiUrl } from '@solana/web3.js'

export type NetworkId = 'devnet' | 'mainnet-beta'

export interface NetworkOption {
  id: NetworkId
  label: string
  endpoint: string
  explorerCluster: string
}

// Solana Vakfı'nın resmi public RPC'leri (clusterApiUrl) tüm dünyadan gelen
// dapp trafiğiyle dolu ve IP başına sert hız sınırı uyguluyor — özellikle
// mobil operatör NAT'ı gibi paylaşımlı IP'lerin arkasından "429 Connection
// rate limits exceeded" sık tetikleniyor. Ankr'ın anahtarsız public devnet
// RPC'si de denendi ama @solana/web3.js'in RPC yanıt şeması doğrulamasıyla
// uyumsuz çıktı (kalıcı bir hata, hız sınırıyla ilgisiz). Build sırasında
// bir Helius API anahtarı sağlanırsa (VITE_HELIUS_API_KEY, GitHub Actions
// secret'ı HELIUS_API_KEY'den geliyor — bkz. .github/workflows/deploy.yml)
// onu kullanıyoruz; yoksa resmi public endpoint'e düşüyoruz. Hız sınırına
// karşı ayrıca lib/luckGame.ts'te retry/backoff var (bkz. withRetry).
const heliusApiKey: string | undefined = import.meta.env.VITE_HELIUS_API_KEY

export const NETWORKS: Record<NetworkId, NetworkOption> = {
  devnet: {
    id: 'devnet',
    label: 'Devnet (Test Ağı)',
    endpoint: heliusApiKey
      ? `https://devnet.helius-rpc.com/?api-key=${heliusApiKey}`
      : clusterApiUrl('devnet'),
    explorerCluster: '?cluster=devnet',
  },
  'mainnet-beta': {
    id: 'mainnet-beta',
    label: 'Mainnet (Gerçek Ağ)',
    endpoint: heliusApiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
      : clusterApiUrl('mainnet-beta'),
    explorerCluster: '',
  },
}

// ---------------------------------------------------------------------------
// Hizmet ücreti (opsiyonel)
// ---------------------------------------------------------------------------
// Bu siteyi kendi ürününüz olarak yayınlarsanız, token oluşturma işleminden
// küçük bir ücret almak isteyebilirsiniz (smithii.io gibi araçların iş modeli
// budur). Ücret, kullanıcı cüzdanından SİZİN belirlediğiniz cüzdana, aynı
// işlem (transaction) içinde şeffaf biçimde gönderilir; kullanıcı cüzdanında
// alıcı adresini ve tutarı imzalamadan önce görür.
//
// Ücret almak istemiyorsanız FEE_WALLET değerini boş bırakın, otomatik
// olarak devre dışı kalır.
export const FEE_WALLET = '' // ör: 'YourSolanaWalletAddressHere...'
export const FEE_AMOUNT_SOL = 0.1

export const DEFAULT_DECIMALS = 9
export const DEFAULT_NETWORK: NetworkId = 'devnet'

// ---------------------------------------------------------------------------
// Test aşaması: "Stay Tuned" kapısı
// ---------------------------------------------------------------------------
// Site test/geliştirme aşamasındayken solofluck.com kök adresine gelen
// herkese düz siyah "Stay Tuned" sayfası gösterilir (bkz. src/main.tsx,
// src/components/StayTuned.tsx). Gerçek uygulamaya yalnızca bu değerle
// eşleşen gizli yoldan ulaşılır, ör. https://solofluck.com/1 .
//
// Bu GERÇEK bir güvenlik/erişim kontrolü DEĞİLDİR — site tamamen istemci
// tarafında (static) çalıştığı için herkes tarayıcı geliştirici araçlarından
// veya bu genel-kaynaklı (public) repodan gerçek yolu görebilir. Sadece
// arama motorlarını ve meraklı gündelik ziyaretçileri test aşamasında
// yavaşlatan bir gizleme (obscurity) katmanıdır. Site yayına hazır olunca
// bu satırı silip App'i doğrudan render etmek yeterli (bkz. src/main.tsx).
export const PREVIEW_ACCESS_PATH = '/1'

// ---------------------------------------------------------------------------
// $LUCK / SoLofLuck — bu siteye adanmış coin
// ---------------------------------------------------------------------------
// Coin, "Token Oluştur" sekmesinden bu sitenin sahibi tarafından oluşturulup
// mint adresi aşağıya girildikten sonra presale/tokenomics sekmeleri gerçek
// zincir verisiyle çalışmaya başlar. Mint adresi boşken sayfa "yakında"
// bilgisiyle görüntülenir.
export const LUCK_TOKEN = {
  name: 'SoLofLuck',
  symbol: '$LUCK',
  // Coin oluşturulduktan sonra mint adresini buraya girin.
  mint: '', // ör: 'ELuCKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  // "777" temasına uygun toplam arz.
  totalSupply: 777_000_000,
  decimals: DEFAULT_DECIMALS,
}

// Presale katkılarının (hem serbest hem sabit paket) toplandığı cüzdan.
// Boş bırakılırsa presale sekmesi "yapılandırılmadı" uyarısı gösterir ve
// gönderim butonları devre dışı kalır — yanlışlıkla kimsenin coin'siz SOL
// göndermesini önlemek için kasıtlı bir güvenlik freni.
export const PRESALE_WALLET = 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36'

// ---------------------------------------------------------------------------
// Operasyon (gider) payı
// ---------------------------------------------------------------------------
// Token yayınlanana kadar oluşan giderleri (Raydium havuz açma ücreti, token
// mint + metadata, RPC aboneliği, alan adı, pazarlama) karşılamak için her
// presale katkısından ayrılan pay: 7.770 / 100.000 = %7.77 — projenin 777
// temasıyla uyumlu. Piyasa normunun altında: launchpad'ler (PinkSale, DxSale
// vb.) zaten toplanan fonun %2-5'ini platform ücreti alıyor, üstüne ekipler
// genelde %10-30'unu pazarlama/operasyona ayırıyor.
//
// ÖNEMLİ — bu pay PRESALE_WALLET'a HİÇ GİRMEZ: katkının içinden AYNI işlemde
// ayrı bir transfer olarak doğrudan bu cüzdana gider. Böylece TGE'de likidite
// havuzuna konacak tutar, presale cüzdanının bakiyesinin ta kendisi olur —
// elle bir ayıklama/çıkarma yapmak gerekmez ve pay yanlışlıkla havuza
// karışamaz. Katkıda bulunan kişi, imzalamadan önce cüzdanında her iki
// alıcıyı ve tutarı da görür.
//
// Boş bırakılırsa pay hiç alınmaz, katkının %100'ü presale cüzdanına gider.
export const PRESALE_OPS_WALLET = '2Lzc6jorznu7zQKny79topGTE7V837oiV3j53zPH4Qh9'
export const PRESALE_OPS_FEE_NUM = 7770
export const PRESALE_OPS_FEE_DEN = 100_000

// Sabit paket seçeneklerinde her 0.5 SOL için kazanılan çekiliş bileti.
export const PRESALE_TICKET_UNIT_SOL = 0.5

// Sabit paket sekmesindeki hazır tutar seçenekleri (SOL).
export const PRESALE_TIERS = [0.5, 1, 3, 5, 10, 15, 20, 25, 50, 100, 200, 250, 500]

// Tokenomics sekmesinde gösterilen arz dağılımı (yüzdeler toplamı 100 olmalı).
export const TOKENOMICS = [
  {
    key: 'presale',
    label: 'Presale',
    percent: 35,
    color: '#22d3ee',
    desc: 'İki modlu presale (serbest katkı + çekilişli sabit paketler) ile topluluğa dağıtılır. TGE\'de %7 açılır, sonra her 7 günde bir %7 daha; 98. günde (14. hafta) tamamı serbest.',
  },
  {
    key: 'liquidity',
    label: 'Likidite Havuzu',
    percent: 20,
    color: '#8b5cf6',
    desc: 'TGE günü Raydium (CPMM) havuzuna konur ve LP token\'ları YAKILIR — likidite kalıcı olarak havuzda kalır, ekip dahil kimse çekemez. Yakma işleminin linki bu sayfada yayınlanır.',
  },
  {
    key: 'community',
    label: 'Topluluk / Çekiliş Ödülleri',
    percent: 20,
    color: '#facc15',
    desc: '7. günden itibaren her 7 günde bir çekiliş, toplam 14 çekiliş. Her çekilişte 7 cüzdan kazanır — 14 haftada toplam 98 kazanan. Katılım, çekiliş anındaki $LUCK bakiyesine göre (snapshot) belirlenir.',
  },
  {
    key: 'team',
    label: 'Ekip (Kilitli)',
    percent: 10,
    color: '#f87171',
    desc: 'İlk 7 ay boyunca tam kilitli — hiç açılmaz. Ardından 7 ay boyunca aylık eşit dilimlerle dağıtılır (14. ayda tamamlanır).',
  },
  {
    key: 'marketing',
    label: 'Pazarlama & CEX',
    percent: 15,
    color: '#34d399',
    desc: 'İki bölüm: CEX listeleme rezervi (77.700.000, üç ayrı kasada, adresleri yayınlanır) ve akan kısım (38.850.000; 7 hafta kilit, sonra 7 ay boyunca aylık).',
  },
] as const

// Kilit / açılış takvimi — Tokenomics sekmesindeki zaman çizelgesi.
// Tasarım ilkesi: hiçbir açılış, likidite havuzunun emebileceğinden büyük
// olmamalı. Bu yüzden her kova kademeli açılıyor ve büyük kilitlerin
// bitiş günleri birbirinden ayrı.
export const VESTING_SCHEDULE = [
  {
    key: 'presale',
    label: 'Presale',
    steps: [
      { when: 'TGE', what: '%7 açılır', amount: 19_036_500 },
      { when: '7. – 91. gün', what: 'her 7 günde bir %7 (13 adım)', amount: 19_036_500 },
      { when: '98. gün', what: 'son %2 — tamamı serbest', amount: 5_439_000 },
    ],
  },
  {
    key: 'liquidity',
    label: 'Likidite Havuzu',
    steps: [{ when: 'TGE', what: 'havuza konur, LP yakılır — hiç açılmaz', amount: 155_400_000 }],
  },
  {
    key: 'community',
    label: 'Topluluk / Çekiliş',
    steps: [
      { when: '7. gün', what: 'ilk çekiliş — 7 cüzdan', amount: 11_100_000 },
      { when: 'her 7 günde bir', what: '14 çekiliş, çekiliş başına 7 kazanan', amount: 11_100_000 },
      { when: '98. gün', what: 'son çekiliş — toplam 98 kazanan', amount: 11_100_000 },
    ],
  },
  {
    key: 'team',
    label: 'Ekip',
    steps: [
      { when: '0 – 7. ay', what: 'tam kilit, hiç açılmaz', amount: 0 },
      { when: '8. – 14. ay', what: 'aylık eşit dilim (7 ay)', amount: 11_100_000 },
    ],
  },
  {
    key: 'marketing',
    label: 'Pazarlama akan kısım',
    steps: [
      { when: '0 – 7. hafta', what: 'kilitli', amount: 0 },
      { when: 'sonraki 7 ay', what: 'aylık eşit dilim', amount: 5_550_000 },
    ],
  },
] as const

// Pazarlama kovasının (116.550.000) iç kırılımı.
export const MARKETING_BREAKDOWN = {
  // Üç ayrı kasa; her biri bir borsa listelemesi için. Kilitli DEĞİL —
  // kasıtlı olarak öyle, çünkü hızlı gelen bir listeleme fırsatında
  // kırmak zorunda kalacağımız bir kilit sözü vermek istemiyoruz.
  // Kasa adresleri yayınlanır, her kullanım kanıtlanır.
  cexReserve: {
    total: 77_700_000,
    wallets: 3,
    perWallet: 25_900_000,
    // Yayınlanan kasa adresleri — her hareket zincirde izlenebilir.
    addresses: [
      { label: 'CEX kasa 1', address: 'CZ639Mx6MFiZfwpVFLecyMTecGp2Cv6HErdoWqgZG6HS' },
      { label: 'CEX kasa 2', address: '3cCqgaj4QzKQUFvSNnz1yqrqcPt7xiKsbh29AfVoGM8B' },
      { label: 'CEX kasa 3', address: 'DmdePMQyuKEX9Hwaytx6tEfPxx5utBVxSJ5bgWrKghmh' },
    ],
  },
  // 6 birime bölünen akan kısım (1 birim = 6.475.000).
  flow: {
    total: 38_850_000,
    unit: 6_475_000,
    items: [
      { label: 'İşbirliği / influencer / topluluk kampanyası', units: 5, amount: 32_375_000 },
      { label: 'Rezerv', units: 1, amount: 6_475_000 },
    ],
  },
} as const

// ---------------------------------------------------------------------------
// Açık cüzdan listesi
// ---------------------------------------------------------------------------
// Tokenomics sekmesinde yayınlanan cüzdanlar. Amaç: kilit/dağıtım sözlerinin
// zincirde tek tek doğrulanabilmesi — her bakiye ve her hareket bu adresler
// üzerinden Solscan'de takip edilebilir. Buradaki adreslerin hiçbiri özel
// anahtar içermez, sadece herkese açık (public) adreslerdir.
export const PUBLIC_WALLETS = [
  { key: 'presale', label: 'Presale kasası', address: PRESALE_WALLET },
  { key: 'ops', label: 'Operasyon payı', address: PRESALE_OPS_WALLET },
  { key: 'team', label: 'Ekip', address: 'AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA' },
  { key: 'community', label: 'Topluluk / çekiliş', address: '3fBhNn8BEoFyQVAXasWj1xcNrcc2FRpLVQexFhZTnw6F' },
  { key: 'marketing', label: 'Pazarlama (akan kısım)', address: 'BiWqNZzCPCfJtVPNhoCrvEb9s6unpCFXXf38GR3WnPWX' },
] as const

// Presale'de toplanan SOL'un (operasyon payı düşüldükten sonra kalan
// %92,23'ün) nereye gittiği. Token dağılımından (TOKENOMICS) AYRI bir
// tablodur: biri token, bu ise para.
export const PRESALE_SOL_ALLOCATION = [
  { key: 'liquidity', label: 'Likidite havuzu', percent: 85 },
  { key: 'marketing', label: 'Pazarlama & CEX', percent: 10 },
  { key: 'reserve', label: 'Rezerv / operasyon', percent: 5 },
] as const

// Topluluk sosyal medya linkleri — boş bırakılan bir alan SoLofLuck
// sayfasının alt kısmında hiç gösterilmez, kırık/placeholder link olmaz.
export const SOCIAL_LINKS = {
  twitter: '', // ör: 'https://twitter.com/soloflucksol'
  telegram: '', // ör: 'https://t.me/soloflucksol'
  discord: '', // ör: 'https://discord.gg/xxxxxxx'
}

// ---------------------------------------------------------------------------
// Oyun: 777 Şans Çarkı (program/luck-game)
// ---------------------------------------------------------------------------
// Bu, ayrı bir Solana programı (akıllı kontrat) gerektirir — bkz.
// program/luck-game/README.md. Program deploy edilip `initialize()`
// çağrılana kadar `programId` boş kalmalı; Oyun sekmesi bu durumda
// "yapılandırılmadı" uyarısı gösterir ve oynama butonu devre dışı kalır
// (PRESALE_WALLET ile aynı güvenlik freni deseni).
//
// Buradaki ekonomi değerleri (ücret/ödül/eşik) yalnızca EKRANDA GÖSTERMEK
// içindir — asıl geçerli/bağlayıcı değerler her zaman zincirdeki GameConfig
// hesabından okunur (bkz. src/lib/luckGame.ts). `initialize()`'ı
// çağırırken aynı değerleri kullanmayı unutmayın, aksi halde ekranda
// gösterilen ile zincirdeki gerçek kurallar birbirini tutmaz.
export const GAME_CONFIG = {
  // Devnet. Hazine cüzdanı operasyon cüzdanına taşınıp resolve()'a ödül
  // payı eklendiğinde yeniden deploy edildi; CI önbelleği program
  // keypair'ini koruyamadığı için adres de yenilendi (bkz. lib.rs'teki
  // declare_id notu).
  programId: '3JytBSxbz7W71VyTc44ZLMqP9PC3oBvquPxNkSRxuUJJ',
  freePlays: 3,
  // Spin-kredisi tarifesi: 3 ücretsiz deneme bitince (+1 bonus spin
  // hediye), her paket bir defada satın alınıp bakiyeye eklenir. Sırayla
  // GameConfig.spin_tier_counts / spin_tier_prices ile birebir eşleşmeli
  // (initialize.mjs'teki SPIN_TIER_COUNTS/SPIN_TIER_PRICES_SOL varsayılanları).
  spinTiers: [
    { count: 1, priceSol: 0.1 },
    { count: 5, priceSol: 0.3 },
    { count: 10, priceSol: 0.5 },
    { count: 20, priceSol: 0.8 },
    { count: 50, priceSol: 1.5 },
    { count: 100, priceSol: 2.5 },
  ],
  // İki katmanlı ödül: kazanan denemelerin %(bigPrizeBps/100)'i büyük
  // ödülü (jackpot), geri kalanı küçük ödülü kazanır — hangisi tutacağı
  // resolve() içinde ikinci, bağımsız bir zarla belirleniyor.
  smallPrizeSol: 0.5,
  bigPrizeSol: 1,
  bigPrizeBps: 3000, // kazananların %30'u büyük ödül alır
  vaultEasyThresholdSol: 2,
  // Tek bir "ev payı" oranı, iki yerde birden uygulanıyor:
  //   1. Paket satın alımlarında ödenen tutarın %20'si hazineye, %80'i
  //      oyun kasasına (vault) girer.
  //   2. Kazanılan turlarda, ödülün %20'si KADAR EK bir tutar kasadan
  //      hazineye aktarılır — oyuncunun ödülünden kesilmez. 0,5 SOL
  //      kazanan tam 0,5 SOL alır, hazineye ayrıca 0,1 SOL gider
  //      (kasadan toplam 0,6 SOL çıkar).
  treasuryFeeBps: 2000,
  normalWinBps: 50, // zor mod: %0.5
  easyWinBps: 1000, // kolay mod (kasa ≥ eşik): %10
  // `initialize()`'a verilecek reveal_delay_slots ile aynı olmalı.
  revealDelaySlots: 5,
  // Program sabiti MAX_RESOLVE_WINDOW_SLOTS ile aynı olmalı — yalnızca
  // "sıkışan oyunu ne zaman iptal edebilirsin" mesajı için kullanılıyor.
  maxResolveWindowSlots: 300,
  // Ev payının (hem paket satışlarından hem ödüllerden) gönderildiği
  // hazine cüzdanı = operasyon cüzdanı, presale operasyon payıyla AYNI
  // adres (PRESALE_OPS_WALLET). Böylece token yayınlanana kadarki tüm
  // gelir tek bir cüzdanda toplanıyor.
  //
  // ÖNEMLİ: bu değer yalnızca kurulum/dokümantasyon içindir. Oyun
  // sekmesi hazine adresini HER ZAMAN zincirdeki GameConfig'ten okur
  // (gameConfig.treasury). Buradaki adresi değiştirmek tek başına
  // yetmez — zincirdeki değeri de update_config() ile güncellemek
  // gerekir (bkz. .github/workflows/update-luck-game-config.yml).
  treasuryWallet: '2Lzc6jorznu7zQKny79topGTE7V837oiV3j53zPH4Qh9',
  // "Oyun cüzdanı" (delegate) artık GERÇEKTEN ücretsiz etkinleştiriliyor:
  // gaz bakiyesi oyuncudan değil, ilk register_delegate() çağrısında
  // zincirin kendisi tarafından kasadan (vault) sponsor ediliyor (bkz.
  // program/luck-game/src/lib.rs DELEGATE_GAS_SPONSOR_LAMPORTS), her
  // buy_spins() çağrısında da sessizce tazeleniyor
  // (DELEGATE_GAS_TOPUP_LAMPORTS). Aşağıdaki değer SADECE nadir bir yedek
  // için: eğer delegate hiç satın alım yapılmadan çok uzun süre oynanıp
  // gazı biterse, oyuncunun kendi cüzdanından elle doldurabileceği miktar
  // (bkz. handleTopUpDelegate / topUpDelegateGas).
  delegateTopUpSol: 0.001,
  // Delegate bakiyesi bunun altına düşünce "gaz doldur" uyarısı gösterilir.
  delegateLowBalanceSol: 0.0002,
}
