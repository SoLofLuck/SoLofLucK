export function Footer() {
  return (
    <footer className="site-footer">
      <p>
        SoLofLuck, Solana ağı üzerinde SPL Token oluşturmak, likidite havuzu kurmak ve gizli transfer
        yapmak için tamamen istemci tarafında (client-side) çalışır. Özel anahtarlarınız hiçbir zaman
        bu siteye veya bir sunucuya gönderilmez; tüm işlemler cüzdanınızda imzalanır.
      </p>
      <p className="site-footer__disclaimer">
        ⚠️ Kripto varlık oluşturmak ve dağıtmak yasal sorumluluklar doğurabilir. Mainnet'te işlem
        yapmadan önce Devnet (test ağı) üzerinde deneyin. $LUCK presale'i de dahil bu sitedeki hiçbir
        içerik yatırım tavsiyesi değildir.
      </p>
    </footer>
  )
}
