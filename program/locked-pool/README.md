# locked-pool

Kendi kontrolümüzdeki, basit bir sabit-çarpım (constant product / x*y=k)
likidite havuzu programı. **Amaç:** Raydium/Orca/Meteora gibi hiçbir DEX'in
kabul etmediği "alım her zaman serbest, satış belirli bir süre boyunca
herkes için kapalı" kuralını, kendi yazdığımız ve tam kontrolümüzde olan bir
programda gerçekleştirmek.

Neden ayrı bir program gerekti (özet): Raydium/Orca/Meteora'nın hepsi,
Token-2022'nin Transfer Hook uzantısını (hangi mantığı içerdiğine
bakmaksızın, sadece uzantı türü var diye) pool oluşturma aşamasında
reddediyor. Bu, kod seviyesinde kanıtlanmış, aşılamaz bir kısıtlama. Detaylı
araştırma sohbet geçmişinde mevcut.

## Nasıl çalışır

- `initialize_pool(duration_seconds, sol_amount, token_amount)`: Havuzu
  oluşturur, ilk likiditeyi yatırır. `duration_seconds` o anki zamana
  eklenerek `unlock_ts` olarak **kalıcı şekilde** kaydedilir. Bunu
  değiştirecek hiçbir instruction yok — kurucu dahil kimse süreyi
  kısaltamaz, uzatamaz ya da iptal edemez.
- `swap_buy`: SOL → Token. Kilit durumundan bağımsız, **her zaman** serbest.
- `swap_sell`: Token → SOL. Kilit açık sayılır ancak ve ancak: `Clock::now
  >= pool.unlock_ts` (otomatik) YA DA `pool.manually_unlocked == true`
  (erken açma) — ikisinden hangisi önce gerçekleşirse. Her iki durum da tek,
  global `pool` hesabından okunur; bu instruction'ı kim ne zaman gönderirse
  göndersin aynı anda aynı sonucu görür.
- `unlock_now`: Kilidi süresinden önce, tek seferde ve **kalıcı** olarak
  açar. Sadece `pool.creator` çağırabilir (`has_one` ile zorunlu). Bir kere
  `true` olduktan sonra `false`'a geri dönüş yok — kısmi/seçici açma
  (bazı hesaplar için evet, bazıları için hayır) mümkün değil, çünkü
  `swap_sell` bunu tek global bayraktan okuyor.
- `add_liquidity` / `remove_liquidity`: Standart, kilitten bağımsız likidite
  ekleme/çekme (LP token karşılığında orantılı pay).

Not: `unlock_now` kurucuya bir güven bağımlılığı geri katıyor (butona hiç
basmazsa kilit sadece `unlock_ts`'te otomatik açılır — süresiz kilitli
kalma riski yoktur, çünkü otomatik süre her zaman arka planda çalışır).
Kurucu isterse hiç kullanmayabilir; tamamen opsiyonel bir "erken aç"
mekanizması.

## Deploy durumu

Henüz deploy edilmedi. Sell-lock programında olduğu gibi Solana Playground
(https://beta.solpg.io) üzerinden Devnet'e deploy edilecek — bu ortamda
`crates.io` ve `release.anza.xyz` ağ erişimi engelli olduğu için yerel
`anchor build`/`solana program deploy` çalıştırılamıyor.

Deploy sonrası `declare_id!(...)` içindeki placeholder program ID gerçek
adresle güncellenecek ve `Anchor.toml`'daki `[programs.devnet]` girdisi de
eşleştirilecek.
