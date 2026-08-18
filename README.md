# SoLofLuck

Solana ağında **kod yazmadan token oluşturma, likidite havuzu kurma ve gizli
(confidential) transfer yapma** aracı — tamamen istemci tarafında çalışan,
backend gerektirmeyen bir web arayüzü. Tasarım ve akış Raydium'un araç
sayfalarından ilham alır.

Bu araç kutusunun yanında, siteye adanmış kendi coin'imiz **SoLofLuck
($LUCK)** için ayrı bir sekme bulunur: arka planında dijital yağmur, arada
geçen 🍀 dört yapraklı yoncalar ve **777** figürleriyle "şans" temalı bir
deneyim; Hakkında, Tokenomics ve Presale alt sekmeleriyle.

> ⚠️ Proje şu anda **Devnet (test ağı)** üzerinde geliştiriliyor. Presale ve
> çekiliş mekaniği olgunlaştığında Mainnet'e taşınacak.

## Özellikler

### Genel araç kutusu (0nRCoin tabanlı)

- Cüzdan bağlantısı (Phantom, Solflare), Devnet/Mainnet ağ seçimi.
- **Token Oluştur**: SPL Mint, logo yükleme (Irys/Arweave), on-chain
  metadata, mint/freeze yetkisi kaldırma, immutable metadata, Satış Kilidi
  (anti-snipe).
- **Likidite Havuzu**: Raydium CPMM havuzu arama/oluşturma, likidite
  ekleme/çıkarma, Streamflow ile likidite kilitleme.
- **Gizli Miktar Transferi**: Token-2022 Confidential Transfer ile miktarı
  zincirde şifreli tutan transferler.

### $LUCK sekmesi

- **Hakkında**: Proje teması ve önemli uyarılar.
- **Tokenomics**: 777.000.000 $LUCK toplam arzın presale/likidite/topluluk/
  ekip/pazarlama dağılımı (bkz. `src/config.ts` → `TOKENOMICS`).
- **Presale** — iki mod:
  1. **Serbest Katkı**: İstediğin kadar SOL gönder, çekiliş yok; katkı
     karşılığı $LUCK presale sonunda dağıtılır.
  2. **Sabit Paket + Çekiliş**: 0.5 / 1 / 3 / 5 / 10 / 15 / 20 / 25 / 50 /
     100 / 200 / 250 / 500 SOL'luk hazır paketlerden seç; her 0.5 SOL için
     1 çekiliş bileti kazanırsın (777 temalı topluluk çekilişlerine katılım
     hakkı).
  Her iki mod da tek bir SOL transferi + izlenebilirlik için bir memo
  talimatıyla, kullanıcının kendi cüzdanında imzalanan gerçek bir Devnet/
  Mainnet işlemi olarak gönderilir.

## Yerel geliştirme

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
npm run preview
```

## Yapılandırma (`src/config.ts`)

| Ayar | Açıklama |
| --- | --- |
| `DEFAULT_NETWORK` | Varsayılan ağ (`devnet` / `mainnet-beta`). |
| `FEE_WALLET` / `FEE_AMOUNT_SOL` | Token oluşturma işleminden opsiyonel hizmet ücreti. |
| `LUCK_TOKEN.mint` | $LUCK coin'i oluşturduktan sonra mint adresini buraya girin. |
| `PRESALE_WALLET` | Presale katkılarının toplandığı cüzdan — boşken presale butonları devre dışıdır (yanlışlıkla SOL gönderimini önlemek için kasıtlı güvenlik freni). |
| `PRESALE_TICKET_UNIT_SOL` | Sabit paket modunda 1 bilet için gereken SOL (varsayılan 0.5). |
| `PRESALE_TIERS` | Sabit paket sekmesindeki hazır tutarlar. |
| `TOKENOMICS` | Tokenomics sekmesinde gösterilen arz dağılımı planı. |

## Yol haritası

1. **Devnet'te doğrula**: Token Oluştur → coin'i devnet'te bas, mint
   adresini `LUCK_TOKEN.mint`'e ve presale cüzdanını `PRESALE_WALLET`'a gir.
2. Presale akışını gerçek kullanıcılarla devnet'te test et (serbest katkı +
   sabit paket/çekiliş bileti sayımı).
3. Likidite Havuzu sekmesinden Raydium havuzunu aç, likiditeyi kilitle.
4. Olgunluğa ulaşınca `DEFAULT_NETWORK`'ü `mainnet-beta` yapıp süreci
   mainnet'te tekrarla; bu README'deki "Devnet" uyarılarını kaldır.

## GitHub Pages / özel alan adı

`.github/workflows/deploy.yml` `main` dalına her push'ta siteyi build edip
GitHub Pages'e dağıtır. Kendi alan adınızı (solofluck.xyz vb.) bağlamak
için `public/CNAME` dosyası oluşturup içine alan adını yazın ve DNS'te
GitHub Pages'in belgelediği kayıtları ekleyin; `vite.config.ts` içindeki
`base: '/'` değeri kök alan adı için zaten doğru ayardır.

## Önemli uyarılar

- Mint/freeze yetkisi kaldırma, metadata immutable yapma, likidite
  havuzu/kilitleme işlemleri **geri alınamaz**.
- Presale'e yalnızca kaybetmeyi göze alabileceğiniz miktarda katılın; $LUCK
  bir yatırım tavsiyesi değildir.
- Kripto varlık oluşturmak ve dağıtmak, bulunduğunuz yargı bölgesine göre
  yasal sorumluluklar doğurabilir.

## Kullanılan teknolojiler

- [Vite](https://vite.dev/) + React + TypeScript
- [@solana/web3.js](https://github.com/solana-labs/solana-web3.js),
  [@solana/spl-token](https://github.com/solana-labs/solana-program-library)
- [@solana/wallet-adapter](https://github.com/anza-xyz/wallet-adapter)
- [@metaplex-foundation/mpl-token-metadata](https://github.com/metaplex-foundation/mpl-token-metadata)
- [Irys](https://irys.xyz/) (logo/metadata için kalıcı depolama)
- [@raydium-io/raydium-sdk-v2](https://github.com/raydium-io/raydium-sdk-V2) (likidite havuzu)
- [Streamflow](https://streamflow.finance) (likidite kilitleme)
