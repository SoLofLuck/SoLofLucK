# luck-game — 777 Şans Çarkı (Zincir Üstü)

Bu, ana web sitesinden **ayrı**, zincir üzerinde çalışan bir Solana programı
(akıllı kontrat). SoLofLuck sayfasındaki mini oyunun tüm para/olasılık
mantığını (kim ne kadar öder, kim ne zaman kazanır, kasadan ne zaman ödeme
çıkar) barındırır — tarayıcı tarafında hiçbir "kazandım" iddiası tek başına
geçerli değildir, her şey burada, zincirde doğrulanır.

## Durum: Henüz deploy edilmedi ⏳

`sell-lock` ve `locked-pool` gibi, bu da Solana Playground (beta.solpg.io)
üzerinden derlenip Devnet'e deploy edilmeli. Deploy ettikten sonra:

1. Gerçek program ID'sini `programs/luck-game/src/lib.rs`'teki
   `declare_id!(...)` satırına ve bu klasördeki `Anchor.toml`'a yazın.
2. Bu README'yi ve `src/config.ts`'teki `GAME_CONFIG.programId`'yi
   güncelleyin ki web sitesi doğru programa bağlansın.

## Nasıl çalışır

### Ekonomi

- **İlk 3 deneme ücretsiz** (yalnızca ağ işlem ücreti — ~0.000005 SOL).
- **Sonraki her deneme 0.1 SOL** — aynı işlemde otomatik olarak ikiye
  bölünür: **%20'si hazine cüzdanına** (site işletme geliri), **%80'i oyun
  kasasına (vault)**.
- **Ödül her zaman tam 1 SOL** — ödülden kesinti yapılmaz.
- Kasa **≥ 2 SOL** olduğunda oyun "kolay mod"a geçer (kazanma ihtimali
  yükselir); kasa 2 SOL'un altına düşerse otomatik olarak "zor mod"a geri
  döner. Bu eşik her `resolve()` çağrısında anlık kasa bakiyesine göre
  yeniden değerlendirilir — sabit bir "devir" mantığı yok.
- Kazanılan 1 SOL kasadan çıkınca kalan bakiye silinmez, kasa tekrar 2 SOL'a
  ulaşana kadar zor mod geçerli olur.

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
  ödül, olasılık ve hazine cüzdanı parametrelerini ayarlar.
- `update_config(...)` — yalnızca `authority` çağırabilir; parametreleri
  sonradan günceller.
- `play()` — oyuncu çağırır; ücretsiz hakkı varsa bedava, yoksa 0.1 SOL
  (bölünerek) alınır, "commit" adımını zincire yazar.
- `resolve()` — izinsiz; commit'ten `reveal_delay_slots` sonra çağrılabilir,
  sonucu belirler ve kazanıldıysa öder.
- `forfeit_stuck_play()` — yalnızca oyuncunun kendisi, resolve penceresi
  kapandıktan sonra; sıkışan denemeyi temizler.

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

## Gerekli araçlar (yerel/Anchor CLI ile derlemek isterseniz)

`program/sell-lock/README.md`'deki adımlarla birebir aynı:

```bash
cd program/luck-game
anchor build
anchor deploy
```

## Sıradaki adım

Devnet'e deploy edip program ID'sini `src/config.ts`'e işledikten sonra,
SoLofLuck sayfasındaki "Oyun" sekmesi gerçek zincir verisiyle çalışmaya
başlar (bkz. `src/lib/luckGame.ts`, `src/components/solofluck/GameTab.tsx`).
