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
