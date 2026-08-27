# TGE Kılavuzu

Bu dosya, token çıkış günü (TGE) yapılacakları **sırayla** anlatıyor.

Neden var: kod doğru olsa bile adımların sırası yanlış olursa sonuç aynı
derecede kötü. Bu bilgi şimdiye kadar commit mesajlarına dağılmıştı;
acele edilen bir günde commit geçmişi okunmaz.

**Genel kural:** her adımın bir DOĞRULAMA satırı var. Doğrulama geçmeden
sonraki adıma geçme. Geri alınamayan adımlar `⚠️ GERİ ALINAMAZ` ile
işaretli.

---

## 0. Hazırlık kontrolü

```bash
npm run check:launch
```

Eksik alanları listeler. Hepsi ✓ olana kadar yayına çıkma. Kesin kapı:

```bash
npm run launch-gate    # eksik varsa çıkış kodu 1
```

---

## 1. $LUCK mint'ini oluştur

Siteden ("Token Oluştur" sekmesi) ya da kendi aracınla.

- **Ondalık: 9.** Tüm hesaplar buna göre. Değiştirirsen
  `DEFAULT_DECIMALS` ve dağıtım miktarları da değişmeli.
- Toplam arz: **777.000.000**

Mint adresini `src/config.ts` → `LUCK_TOKEN.mint` içine yaz.

**Doğrulama:** `npm run check:launch` → "$LUCK mint adresi" ✓

---

## 2. Presale tarihini ilan et

`src/config.ts` → `PRESALE_START_ISO` (UTC, ör. `2026-09-01T12:00:00Z`).

> Boş bırakılırsa presale **süresiz açık** kalır: geri sayım görünmez ve
> zamanı gelince kapanmaz. Sessiz bir hata — kimse fark etmez.

**Doğrulama:** Sitede Presale sekmesinde geri sayım görünüyor mu?

---

## 3. Presale bitince alıcı listesini çıkar

```bash
RPC_URL=<mainnet-rpc> node scripts/presale-buyers.mjs > buyers.json
```

Liste **zincirden** okunuyor; bizde ayrı bir kayıt yok ve olması da
gerekmiyor. Alıcılar aynı komutu çalıştırıp kendi paylarını bizden
bağımsız doğrulayabilir.

**Doğrulama:**
- `buyers.json` içindeki `totals.sol`, presale cüzdanına gelen toplamla
  uyuşuyor mu?
- Her kayıtta hem `tokens` (tam token) hem `baseUnits` (en küçük birim)
  var mı? `baseUnits` yoksa liste eski bir sürümle üretilmiş demektir.

---

## 4. Merkle ağacını kur

```bash
node scripts/build-merkle.mjs buyers.json > public/merkle/round-0.json
```

**Doğrulama:**
- Çıktıdaki `total`, `buyers.json` içindeki `totals.baseUnits` ile aynı mı?
- `count`, alıcı sayısıyla aynı mı?

Dosyayı siteyle birlikte yayınla — Claim sekmesi buradan okuyor ve kökü
zincirdekiyle karşılaştırıyor.

---

## 5. Dağıtım turunu aç ⚠️ GERİ ALINAMAZ

Önce **PROVA**:

```bash
DRY_RUN=1 \
PROGRAM_ID=<claim-program> MINT=<luck-mint> ROUND_ID=0 \
MERKLE_FILE=public/merkle/round-0.json \
START_ISO=<TGE-zamanı> CLIFF_BPS=900 PERIOD_BPS=700 PERIODS=13 \
node program/luck-distributor/scripts/initialize-round.mjs
```

Yazdırılan **her satırı** oku: toplam miktar, kök, başlangıç zamanı,
takvim. Bu değerler zincire yazıldıktan sonra **değiştirilemez** —
programda güncelleme talimatı bilerek yok.

Doğruysa `DRY_RUN=1`'i kaldırıp çalıştır.

Script kasadaki bakiyenin listedeki toplama **tam eşit** olduğunu
doğrulayıp bitiyor. Eksikse son alıcılar çekemez; fazlaysa fazlası
sonsuza kadar kilitli kalır.

**Doğrulama:** "Tamam. Kasada tam N token kilitli." satırı görünmeli.

---

## 6. Haftalık çekilişler

Her tur için, çekilişten **önce** bir slot numarası ilan et — ve ilanı şu
cümleyle yap:

> *"18. tur, **412.900.000. slottan itibaren ilk bloğun** hash'iyle
> çekilecek."*

"…**itibaren ilk blok**" kısmı zorunlu. Solana'da bir slot **atlanabilir**:
o slotun lideri blok üretmezse o numarada hiç blok olmaz ve hash'i de
yoktur (mainnet'te %1-5, devnet'te %5-15). İlanı tek bir slota
bağlarsan, o slot atlandığında çekilişi yapamazsın ve **yeni bir slot
seçmek** zorunda kalırsın — yani sonucu etkileyebileceğin bir seçim
kazanırsın ve "biz karışmadık" iddian tam da orada çöker.

Script bunu zaten kural olarak uyguluyor: ilan edilen slot atlanmışsa
ondan sonraki ilk gerçek bloğu kullanıyor, hangisini kullandığını
ekrana yazıyor ve çıktıya `announcedSlot` (ilan edilen) ile `slot`
(gerçekten kullanılan) olarak ayrı ayrı koyuyor. **Slot seçimini elle
değiştirme** — kuralı değiştirmek doğrulanabilirliği bozar.

Slot geçtikten sonra:

```bash
node scripts/draw-raffle.mjs --buyers buyers.json --slot <slot> --winners 7 > winners-1.json
node scripts/build-merkle.mjs --amount 1110000000000000 winners-1.json > public/merkle/round-1.json
```

> `--amount` **en küçük birim**: 1.110.000 $LUCK × 10⁹.
> `npm run check:tokenomics` bu sayının config'le tuttuğunu doğruluyor.

Sonra 5. adımdaki gibi turu aç — ama çekiliş takvimi tek kalem:
`CLIFF_BPS=10000 PERIOD_BPS=0 PERIODS=0`.

**Doğrulama:** Aynı `buyers.json` ve aynı **ilan edilen** slot ile herkes
aynı kazananları üretebilmeli — ilan edilen slot atlanmış olsa bile, çünkü
"sonraki ilk blok" kuralı deterministik. `winners-1.json` içindeki
`howToVerify` satırını, `announcedSlot` ve `slot` alanlarıyla birlikte
yayınla.

---

## 7. Mainnet'e geç

`src/config.ts` → `DEFAULT_NETWORK = 'mainnet'`

**Doğrulama:** `npm run launch-gate` çıkış kodu 0.

---

## Sorun çıkarsa

| Belirti | Sebep | Ne yapmalı |
|---|---|---|
| Claim "dağıtım henüz başlamadı" diyor | `LUCK_TOKEN.mint` ya da `CLAIM_CONFIG.programId` boş | 1. ve `check:launch` |
| Claim ekranı "liste zincirdekiyle uyuşmuyor" diyor | `public/merkle/round-N.json` zincirdeki kökten farklı | Yayınlanan dosya eski; 4. adımı tekrarla ve dosyayı güncelle |
| Herkesin claim'i reddediliyor | İstemci ile program farklı ABI konuşuyor | `npm run check:abi` — 142 kontrol |
| Alıcılara milyarda bir kadar token gitti | Merkle yaprağında tam token kullanılmış | `baseUnits` kullanılmalı; `build-merkle --selftest` bunu yakalıyor |
| Program yükseltmesi "account data too small" | Zincirdeki alan yetersiz | Deploy workflow'u otomatik genişletiyor; bakiye yetiyor mu bak |
| Deploy "insufficient funds for spend" | Buffer kirası için para yok (~program boyutu kadar) | Deploy cüzdanına SOL gönder |

---

## Değişmeyecek kararlar

Bunlar bilerek böyle; "eksik" sanıp değiştirme:

- **Claim programında "parayı geri çek" talimatı YOK.** Talep edilmeyen
  token sonsuza kadar kilitli kalır, yani fiilen yanar. Alıcının "bunu
  bizden kimse geri alamaz" diyebilmesi, ekibin kalanı toplayabilmesinden
  daha değerli.
- **Oyun kasasından çekme talimatı YOK.** Ekip oyun kasasını boşaltamaz.
- **Kök, takvim ve toplam initialize'dan sonra değiştirilemez.**
- **Bilet sayısı memo'dan değil, kasaya ulaşan gerçek tutardan
  hesaplanıyor.** Memo gönderenin kendi yazdığı metin, taklit edilebilir.
