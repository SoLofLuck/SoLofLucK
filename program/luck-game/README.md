# luck-game — 777 Şans Çarkı (Zincir Üstü)

Bu, ana web sitesinden **ayrı**, zincir üzerinde çalışan bir Solana programı
(akıllı kontrat). SoLofLuck sayfasındaki mini oyunun tüm para/olasılık
mantığını (kim ne kadar öder, kim ne zaman kazanır, kasadan ne zaman ödeme
çıkar) barındırır — tarayıcı tarafında hiçbir "kazandım" iddiası tek başına
geçerli değildir, her şey burada, zincirde doğrulanır.

## Durum: Devnet'te deploy edildi ✅

Deploy ve `initialize()` GitHub Actions üzerinden yapılıyor (bkz.
`.github/workflows/deploy-luck-game.yml` ve `init-luck-game.yml`) — sandbox'ın
Solana ağına erişimi olmadığı için. Hesap düzeni (GameConfig/PlayerState)
değiştiğinde `deploy-luck-game.yml`'i `force_new_program_id=true` ile elle
tetikleyip yeni Program ID'yi şuraya işlemek gerekir:

1. `programs/luck-game/src/lib.rs`'teki `declare_id!(...)`
2. Bu klasördeki `Anchor.toml` (`[programs.devnet]`)
3. `src/config.ts`'teki `GAME_CONFIG.programId`

## Nasıl çalışır

### Ekonomi: spin-kredisi + delegate (session-key)

- **İlk 3 deneme ücretsiz** (yalnızca ağ işlem ücreti — ~0.000005 SOL).
  Ücretsiz haklar tam bitince (bir kereliğine) **+1 bonus deneme** hediye
  edilir.
- Sonrasında oyuncu, sabit paketlerden birini satın alarak "spin bakiyesi"
  biriktirir (`buy_spins`, `GameConfig.spin_tier_counts`/`spin_tier_prices`):
  1 spin/0.1 SOL, 5 spin/0.3 SOL, 10 spin/0.5 SOL, 20 spin/0.8 SOL,
  50 spin/1.5 SOL, 100 spin/2.5 SOL. Rastgele bir SOL miktarı da girilip bu
  paketlerin en iyi eşleşen kombinasyonuna bölünerek tek işlemde satın
  alınabilir (bkz. `computeBestFitSpinPurchase` / "Bakiyemi Spin'e
  Dönüştür").
- Her paket ödemesi aynı işlemde otomatik ikiye bölünür: **%20'si hazine
  cüzdanına** (site işletme geliri), **%80'i oyun kasasına (vault)**.
- **İki katmanlı ödül**: kazananların %(`big_prize_bps`/100)'i büyük ödülü
  (jackpot, varsayılan 1 SOL), geri kalanı küçük ödülü (varsayılan 0.5 SOL)
  kazanır — hangisi tutacağı `resolve()` içinde ikinci, bağımsız bir zarla
  belirlenir. Kazanç her zaman doğrudan oyuncunun gerçek cüzdanına gönderilir.
- Kasa **≥ 2 SOL** olduğunda oyun "kolay mod"a geçer (kazanma ihtimali
  yükselir); kasa 2 SOL'un altına düşerse otomatik olarak "zor mod"a geri
  döner. Bu eşik her `resolve()` çağrısında anlık kasa bakiyesine göre
  yeniden değerlendirilir — sabit bir "devir" mantığı yok.

### Delegate (oyun cüzdanı) — cüzdan onayı olmadan spin

Her spin için gerçek cüzdanda onay istemek (özellikle mobilde) kötü bir
deneyim yaratıyordu. Bunun yerine, tamamen non-custodial kalan bir
"delegate/session-key" deseni kullanılıyor:

1. Oyuncu, TEK bir gerçek cüzdan imzasıyla `register_delegate()` çağırır —
   tarayıcının `localStorage`'ında üretilmiş yerel bir anahtarı (bkz.
   `src/lib/gameDelegate.ts`) kendi `PlayerState`'ine yetkilendirir, aynı
   işlemde ona küçük bir işlem-ücreti tamponu da gönderir.
2. Bundan sonra `play()`/`resolve()` bu yerel anahtarla ANINDA, onaysız
   imzalanır — `Play` hesap yapısı `owner` (gerçek cüzdan, yalnızca PDA
   türetimi için) ile `authority`'yi (fiilen imzalayan — gerçek cüzdan YA DA
   kayıtlı delegate) ayırır.
3. Kazanç her zaman `owner`'a (gerçek cüzdana) gider — delegate anahtarı asla
   kasaya veya gerçek cüzdana erişemez, yalnızca önceden satın alınmış spin
   bakiyesini harcayabilir. `resolve()` zaten izinsizdi (permissionless), bu
   yüzden delegate onu da ücretini kendisi ödeyerek çağırabilir.
4. Ödeme gerektiren işlemler (paket satın alma, delegate kaydı/gaz doldurma,
   sıkışan denemeyi temizleme) HER ZAMAN gerçek cüzdan imzası ister.

Varsayılan olasılıklar (deploy sırasında `initialize()`'a parametre olarak
verilir, sonradan `update_config()` ile değiştirilebilir):

| Mod | Kazanma ihtimali | Ne zaman |
|---|---|---|
| Zor (varsayılan) | düşük (ör. %0.5) | kasa < 2 SOL |
| Kolay | daha yüksek (ör. %10) | kasa ≥ 2 SOL |

### Neden tek işlemde "oyna, hemen sonucu gör" değil de commit → resolve?

Solana'da güvenli, dışarıdan sağlanan (VRF gibi) bir rastgelelik kaynağı
kullanmadan yapılabilecek en iyi şey, henüz gerçekleşmemiş bir slot'un
hash'ini kullanmaktır. Eğer sonuç `play()` anındaki GÜNCEL slot'un hash'ine
bağlı olsaydı, bir oyuncu işlemi imzalamadan önce cüzdanının/RPC'nin
`simulateTransaction` özelliğiyle sonucu **ücretsiz önizleyip yalnızca
kazandığında gönderebilirdi** — bariz bir hile yolu.

Bunun yerine:

1. **`play()`** — ücret varsa ödenir, "şu oyuncu şu slot'ta bir oyun
   başlattı" diye zincire yazılır. Sonuç henüz belli değildir.
2. **`resolve()`** — `reveal_delay_slots` (varsayılan 5 slot, ~2-3 saniye)
   sonra çağrılabilir; artık geçmişte kalmış olan hedef slot'un hash'i +
   oyuncunun pubkey'i ile sonuç deterministik olarak hesaplanır ve kazanıldıysa
   ödül anında kasadan gönderilir. İzinsizdir (permissionless) — web arayüzü
   otomatik çağırır ama isteyen herkes de tetikleyebilir, sonucu kimse
   etkileyemez.

Bu, Onurproje'deki `reveal_winner`'ın "10 slot sonra" yaklaşımıyla birebir
aynı mantık.

### Sıkışma koruması

Biri `resolve()`'u hiç çağırmaz/çağırtamazsa (ör. sekmeyi kapatırsa) ve
`resolve()` penceresi (varsayılan 300 slot, ~2 dakika) kapanırsa, hedef
slot'un hash'i SlotHashes sysvar'ından düşer ve o oyun bir daha asla resolve
edilemez. Bu durumda oyuncu, **kendisi** `forfeit_stuck_play()` çağırarak o
denemeyi kayıp sayıp (ücret iadesi yok) tekrar oynayabilir hale gelir.

## Instruction'lar

- `initialize(...)` — bir kez, program sahibi tarafından çağrılır; ücret,
  ödül, olasılık, spin paketi tarifesi ve hazine cüzdanı parametrelerini
  ayarlar.
- `update_config(...)` — yalnızca `authority` çağırabilir; parametreleri
  sonradan günceller.
- `buy_spins(tier_index)` — oyuncu çağırır (gerçek cüzdan imzası); seçilen
  paketin ücretini böler (%20 hazine/%80 kasa), spin bakiyesine ekler.
- `register_delegate(delegate)` — oyuncu çağırır (gerçek cüzdan imzası); bir
  sonraki `play()`/`resolve()` çağrılarını onaysız imzalayabilecek yerel
  anahtarı yetkilendirir.
- `play()` — oyuncu YA DA kayıtlı delegate çağırır; ücretsiz hakkı varsa
  bedava (ilk kez bitince +1 bonus), yoksa spin bakiyesinden düşer,
  "commit" adımını zincire yazar.
- `resolve()` — izinsiz; commit'ten `reveal_delay_slots` sonra çağrılabilir,
  sonucu belirler ve kazanıldıysa öder, `total_won_lamports`'u günceller.
- `forfeit_stuck_play()` — yalnızca oyuncunun kendisi (gerçek cüzdan),
  resolve penceresi kapandıktan sonra; sıkışan denemeyi temizler.

## Bilinen sınırlamalar (v1)

1. **Rastgelelik, denetlenmemiş bir sözde-VRF'dir** (SlotHashes tabanlı) —
   Onurproje'deki `reveal_winner` ile aynı kategori uyarı geçerli: teorik
   olarak iyi kaynaklı bir validator tarafından hafifçe etkilenebilir.
   Gerçek parayla mainnet'e çıkmadan önce Switchboard/ORAO VRF gibi
   denetlenmiş bir çözüme geçmek düşünülmeli.
2. **Unaudited.** Hiçbir bağımsız güvenlik denetiminden geçmedi.
3. **`vault_easy_threshold_lamports >= big_prize_lamports` kısıtı korunmalı** —
   `update_config` ile bu ilişkiyi bozacak bir kombinasyon girilmeye
   çalışılırsa işlem reddedilir, ama parametreleri güncellerken yine de
   dikkatli olun.
4. **Delegate anahtarı tarayıcı `localStorage`'ında saklanır** — gerçek
   cüzdana göre daha az güvenli (XSS vb. ile çalınabilir), ama etki alanı
   SINIRLI: yalnızca önceden satın alınmış spin bakiyesini harcayabilir,
   `Play`/`Resolve` hesap yapısındaki `owner`/`authority` ayrımı sayesinde
   gerçek cüzdana veya kasaya asla erişemez.

## Gerekli araçlar (yerel/Anchor CLI ile derlemek isterseniz)

`program/sell-lock/README.md`'deki adımlarla birebir aynı:

```bash
cd program/luck-game
anchor build
anchor deploy
```

Bu depoda bu adımlar GitHub Actions üzerinden otomatik yapılıyor — bkz.
`.github/workflows/deploy-luck-game.yml` ve `init-luck-game.yml`.
