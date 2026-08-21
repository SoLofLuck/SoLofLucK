import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import type { TxSigner } from './luckGame'

// Sadece devnet hata ayıklama içindir: Phantom'ın mobil deep-link onay
// akışı yavaş/başarısız olduğunda (bkz. luckGame.ts'teki blockhash
// süresi dolma sorunu) kullanıcının oyunu gerçek cüzdan olmadan, anında
// imzalayan yerel bir "test cüzdanı" ile deneyip oyun mantığının kendisinin
// çalıştığını doğrulamasını sağlar. Gizli anahtar SADECE tarayıcının
// localStorage'ında saklanır, hiçbir yere gönderilmez — üzerine gerçek
// para/coin YATIRILMAMALIDIR, sadece küçük miktarda devnet test SOL'u içindir.
const STORAGE_KEY = 'luckGame.testWalletSecretKeyV1'

export function loadOrCreateTestWallet(): Keypair {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)))
    }
  } catch {
    // Bozuk/okunamayan veri — yenisini üret.
  }
  const kp = Keypair.generate()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(kp.secretKey)))
  } catch {
    // localStorage yazılamıyorsa (gizli sekme vb.) sorun değil, sadece
    // sayfa yenilenince yeni bir test cüzdanı üretilecek.
  }
  return kp
}

export function toTxSigner(kp: Keypair): TxSigner {
  return {
    publicKey: kp.publicKey,
    // Yerel keypair ile imzalama tamamen senkron ve anında — cüzdan
    // uygulaması geçişi/deep-link gecikmesi yok, dolayısıyla blockhash
    // süresi dolma riski neredeyse sıfır.
    signTransaction: async (tx: Transaction) => {
      tx.sign(kp)
      return tx
    },
  }
}

/** Bakiye hedefin altındaysa devnet airdrop ister; devnet faucet'i hız sınırlı olabilir. */
export async function ensureTestWalletFunded(
  connection: Connection,
  publicKey: PublicKey,
  minLamports: number,
): Promise<number> {
  const balance = await connection.getBalance(publicKey)
  if (balance >= minLamports) return balance
  const sig = await connection.requestAirdrop(publicKey, minLamports - balance)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return connection.getBalance(publicKey)
}
