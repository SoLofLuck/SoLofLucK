import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import type { TxSigner } from './luckGame'

// Each wallet's own "game wallet" (delegate / session key) — once the real
// wallet has authorised this local key on chain in a SINGLE transaction (see
// registerAndFundDelegate), every spin (play/resolve) transaction is signed with
// it INSTANTLY and without approval; the winnings still always go to the real
// wallet (see program/luck-game/src/lib.rs for the owner/authority split).
//
// Security note: this key is stored in the browser's localStorage — less secure
// than a real wallet, but its blast radius is LIMITED: it can only spend the
// spin balance that was already bought, and can never reach the real wallet or
// the vault (the program enforces that).
const STORAGE_KEY = 'luckGame.delegateSecretKeyV1'

export function loadOrCreateDelegate(): Keypair {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)))
    }
  } catch {
    // Corrupt or unreadable data — generate a new one.
  }
  const kp = Keypair.generate()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(kp.secretKey)))
  } catch {
    // If localStorage cannot be written (a private tab etc.) that is fine — a
    // new delegate is generated on refresh (which then needs authorising once
    // more with a single real wallet approval).
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
