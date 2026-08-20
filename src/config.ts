import { clusterApiUrl } from '@solana/web3.js'

export type NetworkId = 'devnet' | 'mainnet-beta'

export interface NetworkOption {
  id: NetworkId
  label: string
  endpoint: string
  explorerCluster: string
}

// Kendi RPC sağlayıcınız varsa (Helius, QuickNode, Alchemy vb.) buradaki
// public endpoint'leri kendi URL'lerinizle değiştirmeniz önerilir; public
// RPC'ler hız sınırlıdır.
export const NETWORKS: Record<NetworkId, NetworkOption> = {
  devnet: {
    id: 'devnet',
    label: 'Devnet (Test Ağı)',
    endpoint: clusterApiUrl('devnet'),
    explorerCluster: '?cluster=devnet',
  },
  'mainnet-beta': {
    id: 'mainnet-beta',
    label: 'Mainnet (Gerçek Ağ)',
    endpoint: clusterApiUrl('mainnet-beta'),
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
export const PRESALE_WALLET = '' // ör: 'YourPresaleWalletAddressHere...'

// Sabit paket seçeneklerinde her 0.5 SOL için kazanılan çekiliş bileti.
export const PRESALE_TICKET_UNIT_SOL = 0.5

// Sabit paket sekmesindeki hazır tutar seçenekleri (SOL).
export const PRESALE_TIERS = [0.5, 1, 3, 5, 10, 15, 20, 25, 50, 100, 200, 250, 500]

// Tokenomics sekmesinde gösterilen arz dağılımı (yüzdeler toplamı 100 olmalı).
export const TOKENOMICS = [
  {
    key: 'presale',
    label: 'Presale',
    percent: 30,
    color: '#22d3ee',
    desc: 'İki modlu presale (serbest katkı + çekilişli sabit paketler) ile topluluğa dağıtılır.',
  },
  {
    key: 'liquidity',
    label: 'Likidite Havuzu',
    percent: 35,
    color: '#8b5cf6',
    desc: 'Presale sonunda Raydium üzerinde havuz açılır ve likidite kilitlenir.',
  },
  {
    key: 'community',
    label: 'Topluluk / Çekiliş Ödülleri',
    percent: 15,
    color: '#facc15',
    desc: '777 temalı periyodik çekilişler ve topluluk ödülleri için ayrılır.',
  },
  {
    key: 'team',
    label: 'Ekip (Kilitli)',
    percent: 10,
    color: '#f87171',
    desc: 'Satış Kilidi / Likidite Kilitleme programlarıyla belirli bir süre kilitli tutulur.',
  },
  {
    key: 'marketing',
    label: 'Pazarlama & CEX',
    percent: 10,
    color: '#34d399',
    desc: 'Pazarlama, işbirlikleri ve borsa listeleme giderleri için ayrılır.',
  },
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
  programId: 'FoQuLzFc4r6r778SEsb65kAfqTsHrnj5Rj6Q6MQ5bXUw', // Devnet'te deploy edildi ve initialize() çağrıldı
  freePlays: 3,
  entryFeeSol: 0.1,
  prizeSol: 1,
  vaultEasyThresholdSol: 2,
  treasuryFeeBps: 2000, // %20 hazineye, %80 kasaya
  normalWinBps: 50, // zor mod: %0.5
  easyWinBps: 1000, // kolay mod (kasa ≥ eşik): %10
  // `initialize()`'a verilecek reveal_delay_slots ile aynı olmalı.
  revealDelaySlots: 5,
  // Program sabiti MAX_RESOLVE_WINDOW_SLOTS ile aynı olmalı — yalnızca
  // "sıkışan oyunu ne zaman iptal edebilirsin" mesajı için kullanılıyor.
  maxResolveWindowSlots: 300,
  // Ücret payının gönderildiği hazine cüzdanı.
  treasuryWallet: '5Zvz25PheDtC9PaMzwDRcnb3xKS6CU8d98PfEnKkgp9m',
}
