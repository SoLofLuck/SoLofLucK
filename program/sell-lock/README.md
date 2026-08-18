# sell-lock — Anti-Snipe Satış Kilidi (Token-2022 Transfer Hook)

Bu, ana `0nRCoin` web sitesinden **ayrı**, zincir üzerinde çalışan bir Solana
programıdır (akıllı kontrat). Amaç: bir token havuzu kurulduktan sonra
seçilen bir süre boyunca (15 dk / 1 saat / 5 saat / 24 saat) **hiç kimsenin**
(havuzu kuran dahil) o havuza **satış** yapamaması — alım her zaman serbest
kalır. Süre dolunca hiçbir işlem gerekmeden otomatik olarak herkes için
satış açılır.

## Durum: Devnet'e deploy edildi ✅

**Program ID (Devnet):** `3SgfMbBMbsaB21QaZgcGmRYbUTGGEyErJipxM8u2Uqy5`

Solana Playground (beta.solpg.io) üzerinden, kullanıcıyla birlikte adım adım
derlenip Devnet'e deploy edildi (yerel bir bilgisayar/Rust-Anchor-Solana CLI
kurulumu olmadan, tamamen telefon tarayıcısından). Henüz web sitesine
(TokenForm / Havuz Oluştur akışlarına) entegre edilmedi — sıradaki adım bu.

Mainnet'e **henüz deploy edilmedi**.

## Derleme sürecinde çözülen sorunlar (ileride tekrar deploy gerekirse)

- `#[interface(spl_transfer_hook_interface::execute)]` diye bir Anchor
  attribute'u **yok** — `fallback` isimli ve doğru imzalı bir fonksiyon
  Anchor tarafından otomatik özel işleyici olarak tanınıyor, ekstra attribute
  gerekmiyor.
- `fallback` içinde Anchor'ın gizli/dahili `__private::__global::<instruction>`
  çağrı yoluna güvenmek, Solana Playground'un kullandığı Anchor sürümüyle
  uyuşmadı ve derlemeyi "length limit exceeded" gibi anlamsız bir hatayla
  bozdu. Çözüm: o özel yola hiç güvenmeden, `fallback` içinde CPI ile gelen
  ham hesap listesini doğrudan okuyup asıl mantığı orada uygulamak (bkz.
  `lib.rs`'teki `fallback` fonksiyonu).
- Solana Playground'da kod değişikliklerini **her zaman dosyanın tamamını
  silip yeniden yapıştırarak** yapmak, mobilde parça-parça düzenlemekten çok
  daha güvenilir oldu (kısmi düzenlemeler birkaç kez eşleşmeyen kapanış
  parantezi hatasına yol açtı).

## Gerekli araçlar (yerel/Anchor CLI ile tekrar derlemek isterseniz)

1. **Rust**: https://www.rust-lang.org/tools/install
2. **Solana CLI**: https://docs.solanalabs.com/cli/install
3. **Anchor CLI**:
   ```bash
   cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
   avm install latest
   avm use latest
   ```
4. Devnet'te SOL'ü olan bir cüzdan:
   ```bash
   solana config set --url devnet
   solana-keygen new
   solana airdrop 2
   ```
5. Derleme:
   ```bash
   cd program/sell-lock
   anchor build
   anchor deploy
   ```

## Instruction'lar

- `initialize_extra_account_meta_list` — Token-2022 mint'i Transfer Hook
  uzantısıyla oluşturduktan hemen sonra bir kez çağrılır.
- `register_launch(duration_seconds)` — havuz kurulduktan hemen sonra bir kez
  çağrılır; havuzun kasa adreslerini ve kilit süresini zincire kalıcı olarak
  yazar (aynı mint için ikinci çağrı başarısız olur — süre değiştirilemez).
  `duration_seconds` yalnızca 900 (15dk) / 3600 (1sa) / 18000 (5sa) / 86400
  (24sa) olabilir.
- `fallback` — Token-2022'nin her transferde otomatik çağırdığı asıl kilit
  mantığı: hedef, kayıtlı havuz kasalarından biriyse (yani bu bir satışsa) ve
  süre dolmadıysa reddeder.

## Bilinen, henüz ele alınmamış konular (v1 sınırlamaları)

- `register_launch` şu an **imza sahibi kim olursa olsun** çağrılabilir
  (yalnızca süre + kasa adresi doğrulaması var). Teorik olarak biri, gerçek
  havuz kurulmadan hemen önce/sonra bu çağrıyı sizin yerinize (ör. daha kısa
  bir süreyle) yapmaya çalışabilir. Web sitesi entegrasyonunda bu, aynı
  işlem/akış içinde (havuz oluşturma ile arka arkaya) yapılacağı için pratik
  risk düşük, ama ileride sıkılaştırılabilir.
- Raydium CPMM'in bizim Transfer Hook'umuzu swap işlemlerinde doğru şekilde
  tetikleyip tetiklemediği **henüz test edilmedi** — bu, web sitesi
  entegrasyonu + gerçek bir mint/havuz/swap denemesiyle doğrulanacak.
- Mainnet'e deploy edilmedi.

## Sıradaki adım

Web sitesine entegrasyon: Token Oluştur formuna kilit süresi seçeneği, Havuz
Oluştur akışına `initialize_extra_account_meta_list` / `register_launch`
çağrılarının eklenmesi.
