# Dağıtım listeleri

Bu klasördeki `round-<id>.json` dosyaları, claim programının zincire yazılmış
merkle kökünün açık karşılığıdır:

| id | Ne |
|----|----|
| 0 | Presale payları (TGE'de %9, sonra 13 hafta boyunca haftalık %7) |
| 1–14 | Haftalık biletli çekiliş kazananları |

## Bunlar neden herkese açık?

Merkle'ın buradaki amacı gizlilik değil, **doğrulanabilirlik**. Zincirde
yalnızca 32 baytlık bir kök duruyor; alıcı payını kanıtlayan proof'u
getiriyor. Liste açık olduğu için:

- Herkes kendi payını görebilir
- Kimse listeye sonradan eklenemez (kök değişirdi ve zincirdekiyle
  uyuşmazdı — site bunu fark edip çekmeyi engelliyor)
- Biz de kimsenin payını sessizce değiştiremeyiz

## Nasıl üretiliyor / nasıl doğrularsınız?

```bash
# 1) Alıcı listesini zincirden çıkar (presale kasasının işlem geçmişi)
RPC_URL=<rpc> START_ISO=<presale başlangıcı> END_ISO=<presale bitişi> \
  node scripts/presale-buyers.mjs > buyers.json

# 2) Merkle ağacını kur
node scripts/build-merkle.mjs buyers.json > public/merkle/round-0.json
```

Aynı iki komutu siz de çalıştırıp buradaki dosyayla karşılaştırabilirsiniz —
kök tutuyorsa liste doğrudur. Bize güvenmeniz gerekmiyor.

Çekiliş turları için kazanan adresleri düz bir metin dosyasına konur:

```bash
node scripts/build-merkle.mjs --amount <kazanan başına miktar> winners.txt \
  > public/merkle/round-1.json
```
