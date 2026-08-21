import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import type { TxSigner } from './luckGame'

// Her cüzdanın kendi "oyun cüzdanı" (delegate/session-key) — gerçek cüzdan
// TEK bir işlemle bu yerel anahtarı zincirde yetkilendirdikten sonra (bkz.
// registerAndFundDelegate), tüm spin (play/resolve) işlemleri bu anahtarla
// ANINDA ve onaysız imzalanır; kazanç yine de her zaman gerçek cüzdana
// gider (owner/authority ayrımı için program/luck-game/src/lib.rs'e bkz.).
//
// Güvenlik notu: bu anahtar tarayıcı localStorage'ında saklanır — gerçek
// cüzdana göre daha az güvenli, ama etki alanı SINIRLI: yalnızca önceden
// satın alınmış spin bakiyesini harcayabilir, gerçek cüzdana veya kasaya
// asla erişemez (program bunu zorunlu kılıyor).
const STORAGE_KEY = 'luckGame.delegateSecretKeyV1'

export function loadOrCreateDelegate(): Keypair {
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
    // localStorage yazılamıyorsa (gizli sekme vb.) sorun değil — sayfa
    // yenilenince yeni bir delegate üretilecek (o zaman tekrar 1 kerelik
    // gerçek cüzdan onayıyla yetkilendirilmesi gerekir).
  }
  return kp
}

export function delegateToTxSigner(kp: Keypair): TxSigner {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.sign(kp)
      return tx
    },
  }
}

export async function fetchDelegateBalance(connection: Connection, delegate: PublicKey): Promise<number> {
  return connection.getBalance(delegate)
}
