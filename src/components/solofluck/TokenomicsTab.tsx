import {
  LUCK_TOKEN,
  MARKETING_BREAKDOWN,
  PRESALE_SOL_ALLOCATION,
  TOKENOMICS,
  VESTING_SCHEDULE,
} from '../../config'
import { PRESALE_OPS_FEE_PERCENT } from '../../lib/presale'

function formatSupply(n: number) {
  return n.toLocaleString('tr-TR')
}

export function TokenomicsTab() {
  return (
    <div className="luck-tokenomics">
      <div className="luck-tokenomics__summary">
        <div className="luck-tokenomics__stat">
          <span>Toplam Arz</span>
          <strong>{formatSupply(LUCK_TOKEN.totalSupply)} $LUCK</strong>
        </div>
        <div className="luck-tokenomics__stat">
          <span>Decimals</span>
          <strong>{LUCK_TOKEN.decimals}</strong>
        </div>
        <div className="luck-tokenomics__stat">
          <span>Ağ</span>
          <strong>Solana (SPL Token)</strong>
        </div>
      </div>

      <div className="luck-tokenomics__bar" role="img" aria-label="Tokenomics dağılım grafiği">
        {TOKENOMICS.map((t) => (
          <div
            key={t.key}
            className="luck-tokenomics__bar-segment"
            style={{ width: `${t.percent}%`, background: t.color }}
            title={`${t.label} — %${t.percent}`}
          />
        ))}
      </div>

      <ul className="luck-tokenomics__list">
        {TOKENOMICS.map((t) => (
          <li key={t.key} className="luck-tokenomics__row">
            <span className="luck-tokenomics__dot" style={{ background: t.color }} />
            <div className="luck-tokenomics__row-body">
              <div className="luck-tokenomics__row-head">
                <strong>{t.label}</strong>
                <span className="luck-tokenomics__percent">%{t.percent}</span>
              </div>
              <div className="luck-tokenomics__row-supply">
                {formatSupply(Math.round((LUCK_TOKEN.totalSupply * t.percent) / 100))} $LUCK
              </div>
              <p className="luck-tokenomics__row-desc">{t.desc}</p>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="luck-tokenomics__subhead">Kilit ve Açılış Takvimi</h3>
      <p className="subtab-desc">
        Tasarım ilkesi şu: <strong>hiçbir açılış, likidite havuzunun emebileceğinden büyük
        olmamalı.</strong> Bu yüzden her kova kademeli açılıyor ve büyük kilitlerin bitiş günleri
        birbirinden ayrı — takvimde tek bir "herkesin sattığı gün" yok.
      </p>
      <div className="luck-tokenomics__timeline">
        {VESTING_SCHEDULE.map((v) => (
          <div key={v.key} className="luck-tokenomics__timeline-group">
            <h4>{v.label}</h4>
            <ul>
              {v.steps.map((st, i) => (
                <li key={i}>
                  <span className="luck-tokenomics__when">{st.when}</span>
                  <span className="luck-tokenomics__what">{st.what}</span>
                  {st.amount > 0 && (
                    <span className="luck-tokenomics__amount">{formatSupply(st.amount)}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <h3 className="luck-tokenomics__subhead">Pazarlama Kovasının İçi</h3>
      <p className="subtab-desc">
        <strong>CEX listeleme rezervi — {formatSupply(MARKETING_BREAKDOWN.cexReserve.total)}</strong>{' '}
        (toplam arzın %10'u), {MARKETING_BREAKDOWN.cexReserve.wallets} ayrı kasada,
        her biri {formatSupply(MARKETING_BREAKDOWN.cexReserve.perWallet)}. Her kasa bir borsa
        listelemesi içindir; kasa adresleri yayınlanır ve her kullanım borsa duyurusu + işlem
        linkiyle kanıtlanır. Bu rezerv <strong>kilitli değildir</strong> — kasıtlı olarak öyle,
        çünkü hızlı gelen bir listeleme fırsatında kırmak zorunda kalacağımız bir kilit sözü
        vermek istemiyoruz.
      </p>
      <ul className="luck-tokenomics__sol-list">
        {MARKETING_BREAKDOWN.flow.items.map((it) => (
          <li key={it.label}>
            <span>
              {it.label} ({it.units} birim)
            </span>
            <strong>{formatSupply(it.amount)}</strong>
          </li>
        ))}
      </ul>
      <p className="subtab-desc">
        Akan kısım toplam {formatSupply(MARKETING_BREAKDOWN.flow.total)} (1 birim ={' '}
        {formatSupply(MARKETING_BREAKDOWN.flow.unit)}): <strong>7 hafta kilitli</strong>, sonra{' '}
        <strong>7 ay</strong> boyunca aylık eşit dilimlerle kullanılır.
      </p>

      <h3 className="luck-tokenomics__subhead">Toplanan SOL Nereye Gidiyor?</h3>
      <p className="subtab-desc">
        Yukarıdaki tablo <strong>token</strong> dağılımıdır. Bu tablo ise presale'de toplanan{' '}
        <strong>parayı</strong> gösterir — ikisi ayrı şeylerdir. Katkının{' '}
        <strong>%{PRESALE_OPS_FEE_PERCENT.toLocaleString('tr-TR')}</strong>'lik kısmı, token
        yayınlanana kadarki giderler için aynı işlemde ayrı bir cüzdana gider ve havuza eklenmez.
        Kalan tutar şöyle kullanılır:
      </p>
      <ul className="luck-tokenomics__sol-list">
        {PRESALE_SOL_ALLOCATION.map((a) => (
          <li key={a.key}>
            <span>{a.label}</span>
            <strong>%{a.percent}</strong>
          </li>
        ))}
      </ul>

      <h3 className="luck-tokenomics__subhead">Lansman Taahhütleri</h3>
      <ul className="luck-tokenomics__pledges">
        <li>
          <strong>Likidite yakılır.</strong> Havuz açıldıktan sonra LP token'ları yakılır; havuzdaki
          likiditeyi ekip dahil kimse çekemez. Yakma işleminin linki burada yayınlanır.
        </li>
        <li>
          <strong>Mint yetkisi iptal edilir.</strong> Lansmandan sonra yeni $LUCK basılamaz, toplam
          arz {formatSupply(LUCK_TOKEN.totalSupply)} olarak sabitlenir.
        </li>
        <li>
          <strong>Freeze yetkisi iptal edilir.</strong> Hiçbir cüzdan dondurulamaz — token satışı
          teknik olarak engellenemez.
        </li>
        <li>
          <strong>$LUCK standart bir SPL token'dır.</strong> Gizli transfer, transfer vergisi veya
          kara liste gibi bir uzantı içermez; bakiyeler herkese açık ve doğrulanabilir.
        </li>
        <li>
          <strong>CEX kasalarının adresleri yayınlanır.</strong> Üç kasanın her hareketi zincirde
          izlenebilir; kullanılmayan kasa, takvim sonunda yakılır veya çekiliş kovasına aktarılır.
        </li>
        <li>
          <strong>Ekip 7 ay boyunca hiçbir token alamaz.</strong> Kilit bittikten sonra da tek
          seferde değil, 7 ay boyunca aylık dilimlerle açılır.
        </li>
      </ul>

      <div className="alert alert--info">
        Bu dağılım ve taahhütler henüz zincire yazılmamış bir plandır ({`src/config.ts`} dosyasındaki{' '}
        <code>TOKENOMICS</code> listesi) — coin, "Token Oluştur" sekmesinden gerçekten
        oluşturulduğunda mint/freeze yetkileri ve kilit süreleri bu plana göre ayarlanmalıdır.
      </div>
    </div>
  )
}
