# Güvenlik

SoLofLuck'ın iki Solana programı var ve ikisi de gerçek para tutuyor. Bu
belge saldırı yüzeyini, her birini neyin koruduğunu ve **neyin
korumadığını** açıkça yazıyor.

Amacı iki taraflı: kod okuyan birinin nereye bakacağını bilmesi, ve bizim
"her şey güvenli" gibi doğrulanamaz bir cümle kurmak zorunda kalmamamız.

---

## Denetim durumu — dürüst hâli

**Bu programlar bağımsız bir güvenlik denetiminden GEÇMEDİ.**

Yapılanlar:

| Katman | Kapsam |
|---|---|
| Birim + senaryo testleri | luck-game 33, luck-distributor 20 test |
| Kaos testi (oyun) | 8 tohum × 400 rastgele adım, her adımda 7 değişmez kontrolü |
| Kaos testi (dağıtım) | 4 tohum, her adımda 8 değişmez + sahte çekim denemeleri |
| Sabotaj testi | Her kontrolün, kaldırıldığında GERÇEKTEN düştüğü kanıtlandı |
| ABI denetimi | 213 kontrol — istemci ile programın aynı baytları konuştuğu |
| Tokenomics denetimi | 73 kontrol — ilan edilen sayılarla zincirdeki kuralların uyumu |
| Uçtan uca prova | Devnet'te katkı → liste → merkle → dağıtıcı → claim |
| `clippy` (sıkı) | Her PR'da, uyarılar hata sayılıyor |
| `cargo-audit` / `cargo-deny` | Her PR'da + haftalık — bağımlılık açıkları |
| Zincire giren paket kümesi | Sabitlenmiş; açıklar bu kümeye karşı denetleniyor |
| Zincir-kaynak eşleşmesi | Her deploy'da bytecode sha256 karşılaştırması |

> Test sayıları **bizim yazdığımız** testleri sayıyor. `cargo test` bunlara
> ek olarak Anchor'ın `declare_id!` makrosunun ürettiği bir testi de koşturur,
> yani çıktıda her programda bir fazla görünür.

Yapılmayanlar:

- Bağımsız üçüncü taraf denetimi
- Resmî bug bounty programı
- Formal doğrulama

Yukarıdaki katmanlar **mekanik** hataları arıyor. **Tasarım** hatalarını —
"bu kural ekonomik olarak sömürülebilir mi" — bir insanın bakması gerekir.
Bu belge o insana yardım etmek için var.

---

## Bağımlılıklar — hangi soruyu soruyoruz

`cargo audit` `Cargo.lock`'u tarıyor. Ama `Cargo.lock`, testler için gelen
**tüm Solana validator/TLS yığınını** içeriyor: `h2`, `quinn` (QUIC),
`rustls-webpki`, `ring`, `tokio`, `curve25519-dalek`… İlk denetim koşusunda
10 "güvenlik açığı" çıktı ve **hiçbiri** zincire yüklenen programın içinde
değildi.

`Cargo.lock`'u zincirdeki programmış gibi denetlemek bir kategori hatası.
Doğru soru: **SBF derlemesine hangi paketler giriyor?**

Bu, tahminle değil hesapla cevaplanıyor. `cargo metadata` her bağımlılık
kenarında o kenarın hangi hedef koşuluyla geçerli olduğunu veriyor
(ör. `cfg(not(target_os = "solana"))`). Bu koşullar SBF hedefi için
değerlendirilip grafik yürünüyor:

| | paket sayısı |
|---|---|
| `Cargo.lock`'un tamamı (luck-game) | 204 |
| **SBF derlemesine giren** | **96** |

Aradaki 108 paket test makinesinde çalışıyor, zincirde değil.

İki kapı var:

1. **Zincire giren küme sabitlenmiş.** Yeni bir paket girerse denetim düşer
   ve birinin "bu paket ne, denetimden temiz mi" sorusunu sorması gerekir.
2. **Açıklar bu kümeye karşı kontrol edilir.** Kümedeki bir pakette açık
   çıkarsa CI durur. Yalnızca test yığınındaki açıklar görünür kalır ama
   engellemez — engelleseydi, düzeltemeyeceğimiz yukarı akış uyarıları
   yüzünden CI sürekli kırmızı olurdu ve kırmızı bir CI kısa sürede
   görmezden gelinen bir CI'ya dönüşür.

`cargo tree --target sbf-solana-solana` kullanılamıyor: standart `rustc` bu
hedefi tanımıyor (Solana kendi `rustc` çatalını gönderiyor).

---

## Kaos testi neyi garanti ediyor

Rastgele senaryo dizileri üretilip **her işlemden sonra** değişmezler
kontrol ediliyor. Tohumlar sabit: düşen bir koşu birebir tekrar
üretilebiliyor.

**Oyun (7 değişmez):** kasa kira tabanının altına düşmüyor · kazanma sayısı
oynama sayısını geçmiyor · ödenen toplam kazanma sayısıyla tutarlı ·
pencere kapandıysa oyuncu **mutlaka** iptal edebiliyor · penceresi açık
bekleyen oyun **mutlaka** sonuçlandırılabiliyor · spin muhasebesi birebir.

**Dağıtım (8 değişmez):** kasa + tüm alıcı hesapları = basılan toplam ·
kimse hakkından fazlasını alamıyor · çekilen tutar hiç azalmıyor ·
`ClaimStatus` ile gerçek bakiye birebir eşit · dağıtıcı sayacı bireysel
kayıtların toplamına eşit · çekilen, o anda açılmış olanı geçemiyor
(takvim **bağımsız** hesaplanıyor, programın kendi fonksiyonu
çağrılmıyor) · yanlış miktarla ya da **başkasının kanıtıyla** çekim
reddediliyor · takvim bitince herkes payının tamamını alıyor ve kasada
toz kalmıyor.

Her kontrolün gerçekten iş yaptığı **sabotajla** kanıtlandı: program
bilerek bozuluyor ve ilgili değişmezin düştüğü görülüyor. Bir sabotaj
(kasadaki kira payını yok sayan sürüm) hiçbir kontrol tarafından
yakalanamadı — o boşluk için ayrı, hedefli bir regresyon testi yazıldı.

---

## Yapısal güvenceler

Bunlar kod incelemesiyle doğrulanabilir, teste bağlı değil.

### Çekme (withdraw) talimatı YOK

Her iki programın da talimat listesi tam olarak şu:

```
luck-game       : initialize · update_config · buy_spins ·
                  register_delegate · play · resolve · forfeit_stuck_play
luck-distributor: initialize · claim
```

**Hiçbirinde kasayı boşaltan bir talimat yok.** Program yetkilisi (authority)
bile kilitli tokenları çekemez. Dağıtıcıdaki tokenlar yalnızca geçerli bir
merkle kanıtıyla, hak edilen miktar kadar çıkabilir.

Bu bilinçli ve **geri alınamaz** bir tasarım kararı: acil durumda bile
müdahale edemeyiz. Karşılığında, kimsenin "ekip fonu çekti" endişesi
taşıması gerekmiyor.

### Ödül her zaman oyuncunun kendi cüzdanına gider

`resolve()` izinsiz (permissionless) — herkes çağırabilir. Ama ödül
`player_state.player`'a ödenir, çağırana değil. Başkasının turunu
sonuçlandırmak yalnızca ona iyilik yapmaktır.

### Claim başkasının cüzdanına yönlendirilemez

```rust
#[account(
    init_if_needed,
    payer = claimant,
    associated_token::mint = mint,
    associated_token::authority = claimant,   // <-- imzalayanın kendi ATA'sı
)]
pub destination: Account<'info, TokenAccount>,
```

Anchor'ın `associated_token::authority` kısıtı, hedef hesabın mutlaka
imzalayanın kendi ATA'sı olmasını zorunlu kılıyor.

### Merkle kökü ve takvim değiştirilemez

`initialize()` bir kez çalışır, sonrasında kökü ya da vesting takvimini
değiştiren bir yol yoktur. Liste yayınlandıktan sonra kimse kimsenin payını
değiştiremez.

---

## Rastgelelik — commit / reveal

Slot makinesinin sonucu şöyle belirleniyor:

```
digest = sha256( slot_hash ‖ entropy_slot ‖ oyuncu ‖ oyun_sayaci )
zar    = u64_le(digest[0..8])  % 10000     -> kazandı mı
katman = u64_le(digest[8..16]) % 10000     -> küçük ödül mü, jackpot mu
```

| alan | boyut | biçim |
|---|---|---|
| `slot_hash` | 32 | kullanılan bloğun hash'i, ham bayt |
| `entropy_slot` | 8 | o bloğun slot numarası, little-endian |
| `oyuncu` | 32 | oyuncunun cüzdan adresi, ham bayt |
| `oyun_sayaci` | 4 | `plays_count`, little-endian |

**`sha256`, keccak değil.** Oyun `solana_program::hash::hash` kullanıyor
(SHA-256); dağıtıcı ise merkle ağacında keccak kullanıyor. İkisi farklı ve
karıştırılırsa doğrulama tutmaz.

**Kendiniz doğrulayın** — bu vektörü herkes tekrar üretebilir:

```python
import hashlib
pre = bytes(range(32)) + (488_699_073).to_bytes(8,'little') \
    + bytes([7])*32   + (5).to_bytes(4,'little')
d = hashlib.sha256(pre).digest()
assert d.hex() == '3d54d1715c5d05dcfc12bb5dd95b197b078f3135b04aab6ead91103c1233cc6d'
assert int.from_bytes(d[0:8],'little')  % 10000 == 7597   # zar
assert int.from_bytes(d[8:16],'little') % 10000 == 4556   # katman
```

Aynı vektör hem Rust testinde (`altin_zar_vektoru`) hem ABI denetiminde
(`check-abi`) koşuyor. Yani buradaki tarif, programın gerçekte yaptığı işten
sapamaz — saparsa CI düşer.

`play()` anında `commit_slot` yazılıyor; sonuç ise
`commit_slot + reveal_delay_slots` slotunun hash'inden üretiliyor. O slot
henüz oluşmadığı için hash'ini **kimse** — biz dahil — bilemez.

**Neden gerekliydi:** aynı anın hash'i kullanılsaydı, oyuncu işlemi
imzalamadan önce cüzdanının `simulateTransaction`'ıyla sonucu ücretsiz
önizleyip yalnızca kazandığında gönderebilirdi.

**Atlanan slot:** hedef slot atlanmış olabilir (lideri blok üretmemiştir).
Program bu durumda ondan **sonraki ilk var olan** bloğu kullanıyor
(`find_slot_hash_at_or_after`) ve `entropy_slot`'u da hash girdisine
katıyor. Eskiden birebir eşleşme aranıyordu ve atlanan slot oyuncunun
spin'ini sessizce yakıyordu.

**Modulo yanlılığı:** zar 2 bayttan değil **8 bayttan** üretiliyor.
65.536, 10.000'in tam katı olmadığı için 2 baytlık zar ilan edilen tüm
oranları kasa aleyhine ~%6,8 kaydırıyordu (%0,5 → %0,534). 8 baytta bu
yanlılık ~5×10⁻¹⁶ mertebesine iniyor.

### Bilinen sınır: lider etkisi

Slot hash'ini üreten taraf o slotun **lideridir**. Teorik olarak bir lider,
kendi slotunda hangi işlemleri dahil edeceğini seçerek hash'i bir miktar
etkileyebilir. Bu, tüm blockhash tabanlı zincir rastgeleliklerinin ortak
sınırı.

Bizim durumumuzda sömürü ekonomik olarak anlamsız: hedef slot commit anında
belli, ödül üst sınırı 1 SOL, ve bir liderin slot programını kendi lehine
kurgulamasının maliyeti bunun çok üzerinde. Yine de "gerçek rastgelelik"
iddiasında bulunmuyoruz — VRF (ör. Switchboard) daha güçlü bir garanti
verirdi, karşılığında dış bir bağımlılık ve ek maliyet getirirdi.

---

## Merkezî noktalar — bunlar bize güvenmenizi gerektiriyor

Dürüst olmak gerekirse üç tane var.

### 1. `update_config` — oyun parametreleri

Yetkili; ödül tutarlarını, kazanma oranlarını, ev payını ve paket
fiyatlarını değiştirebiliyor. Bu, tarife ayarlaması için gerekli ama aynı
zamanda oranları kötüleştirme yetkisi de demek.

**Bekleyen bahisleri etkilemez.** `play()` anında ödemeyi belirleyen tüm
parametreler `PlayerState`'e kopyalanıyor ve `resolve()` config'i değil
onları okuyor. Yani bahsinizi koyduğunuz andaki oranlarla sonuçlanırsınız;
yetkilinin bekleyen bir bahsi görüp oranını değiştirmesi mümkün değil.

> Bu böyle **değildi**. `resolve()` güncel config'i okuyordu ve koddaki
> yorum "bekleyen oyunları etkilemez" deyip hemen ardından "resolve GÜNCEL
> config'ten okur" diye kendini yalanlıyordu. Doğrulanabilir adalet
> iddiasında bulunan bir oyunda "bahsi koyduktan sonra oranı
> değiştirmeyeceğimize güvenin" kabul edilemez bir boşluktu. Kodu
> dışarıdan inceleyen biri işaret etti; yayın öncesinde, düzeltmenin
> bedava olduğu son anda kapatıldı.

Kasa **bakiyesi** dondurulmuyor ve dondurulmamalı: "kolay mod" kasanın o
anki doluluğuna bağlı ve bu kasıtlı — kasa doldukça oranlar herkes için
iyileşiyor. Dondurulan şey **eşik**, bakiye değil.

Sınırları: tüm oranlar ≤ %100, kolay mod zor moddan kolay olmak zorunda,
eşik jackpot + payını karşılamak zorunda, hazine sıfır adres olamaz.
**Değiştiremediği şey:** kasadaki paranın nereye gideceği. Ödül hep
oyuncuya, pay hep hazineye gider.

Değişiklikler zincirde açık — `GameConfig` hesabını herkes okuyabilir.

### 2. Presale alıcı listesi

Liste zincirden okunuyor (`scripts/presale-buyers.mjs`) ama **derleyen
biziz**. Merkle kökü zincire yazıldıktan sonra da değişmiyor.

Karşı önlem: aynı script'i herkes çalıştırıp aynı listeyi kendi başına
üretebiliyor — bize güvenmek zorunda değil. Script ayrıca taradığı
geçmişin kasanın bugünkü bakiyesini **açıkladığını** doğruluyor; RPC
geçmişi budanmışsa duruyor (aksi halde ilk katkı yapanlar listeden sessizce
düşerdi).

### 3. Upgrade authority

Programlar yükseltilebilir durumda. Yükseltme yetkisi bizde.

Bu, hata düzeltebilmek için gerekli — ama aynı zamanda programın davranışını
değiştirebilmek demek. Yükseltmeyi kalıcı olarak kapatmak (authority'yi
`None` yapmak) bu riski sıfırlar ve karşılığında hata düzeltme imkânını da
sıfırlar. Bu karar TGE sonrası, kod bir süre gerçek kullanımda kaldıktan
sonra verilecek.

Her deploy'da zincirdeki bytecode ile derlemenin sha256'sı karşılaştırılıyor
ve log'a yazılıyor; yani "zincirdeki program bu kaynaktan mı çıktı" sorusu
doğrulanabiliyor.

---

## Bulduğunuz bir şey varsa

Açık bir güvenlik açığı bulduysanız **önce herkese duyurmayın**. Sorunu
`GUVENLIK.md` içindeki iletişim kanalından bildirin; düzeltildikten sonra
birlikte duyuralım.

> İletişim adresi TGE öncesinde buraya eklenecek.

Ödül programı (bug bounty) yayın öncesinde ilan edilecek. Tutar ve kapsam
duyurulduğunda bu bölüm güncellenecek.

**Uyarı:** Telegram/X üzerinden gelen "projenizi ücretsiz denetleyelim"
mesajları neredeyse istisnasız oltalama girişimidir. Hiç kimseye repo yazma
yetkisi, private key ya da deploy cüzdanı erişimi verilmeyecek.

---

## Kendiniz doğrulamak isterseniz

```bash
# Tüm testler
cd program/luck-game        && cargo test
cd program/luck-distributor && cargo test

# Kaos testi ayrıntılı çıktıyla
cd program/luck-game && cargo test kaos -- --nocapture

# ABI + tokenomics + tx-yolu + hata kodları denetimleri
npm run verify

# Zincirdeki programın kaynakla aynı olduğu (deploy loglarında)
solana program dump H6gnAvLa5o2JtjfdgyKdZy2eC9bjnMerCcbxjYZeKdnf zincir.so
```

Alıcı listesini bizden bağımsız üretmek:

```bash
RPC_URL=<arşiv-rpc> node scripts/presale-buyers.mjs > kendi-listem.json
node scripts/build-merkle.mjs kendi-listem.json | head -3   # kök aynı çıkmalı
```
