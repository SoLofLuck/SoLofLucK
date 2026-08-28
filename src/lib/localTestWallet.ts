import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import type { TxSigner } from './luckGame'

// For devnet debugging only: when Phantom's mobile deep-link approval flow is
// slow or fails (see the blockhash-expiry problem in luckGame.ts), this lets the
// user try the game without a real wallet, with a local "test wallet" that signs
// instantly, and confirm that the game logic itself works. The private key is
// stored ONLY in the browser's localStorage and is never sent anywhere — real
// money or coins MUST NOT be deposited on it; it is for a small amount of devnet
// test SOL only.
const STORAGE_KEY = 'luckGame.testWalletSecretKeyV1'

export function loadOrCreateTestWallet(): Keypair {
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
    // If localStorage cannot be written (a private tab etc.) that is fine; a
    // new test wallet is simply generated on refresh.
  }
  return kp
}

export function toTxSigner(kp: Keypair): TxSigner {
  return {
    publicKey: kp.publicKey,
    // Signing with a local keypair is fully synchronous and instant — there is
    // no wallet app switch or deep-link delay, so the risk of the blockhash
    // expiring is almost zero.
    signTransaction: async (tx: Transaction) => {
      tx.sign(kp)
      return tx
    },
  }
}

/** Requests a devnet airdrop if the balance is below the target; the devnet faucet may be rate-limited. */
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
