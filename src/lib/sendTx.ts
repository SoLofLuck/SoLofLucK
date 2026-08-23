import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'

// ---------------------------------------------------------------------------
// Ortak işlem gönderme katmanı
// ---------------------------------------------------------------------------
// Bu dosyadaki mantık önce oyun tarafında (luckGame.ts) yazıldı ve gerçek
// kullanımda üç ayrı hata sınıfına karşı sertleştirildi. Aynı korumalar
// yakma gibi başka akışlarda da gerektiği için buraya taşındı — düz bir
// `getLatestBlockhash → sign → sendRawTransaction` dizisi, mobil cüzdan +
// paylaşımlı RPC koşullarında güvenilir DEĞİL.

/** Gerçek cüzdan adaptörü (Phantom vb.) ve yerel anahtarlar için ortak arayüz. */
export interface TxSigner {
  publicKey: PublicKey
  signTransaction: (tx: Transaction) => Promise<Transaction>
}

export interface SendOptions {
  /**
   * Cüzdan onayı beklenirken gösterilecek durum mesajı. `null` verilirse bu
   * adım hiç gösterilmez — yerel bir anahtarla (delegate/test cüzdanı)
   * imzalanan işlemler ANINDA ve onaysız tamamlandığından, kullanıcıya
   * yanlışlıkla "cüzdanınızda onay bekleniyor" gibi bir mesaj gösterilmemesi
   * için. Sadece GERÇEK cüzdan imzası gerektiren adımlarda varsayılan mesaj
   * kullanılmalı.
   */
  confirmMessage?: string | null
}

/**
 * Bir promise'i, verilen süre içinde ne sonuçlanır ne de hata verirse
 * belirtilen mesajla reddeden bir zaman aşımına bağlar. Mobil cüzdanlarda
 * (özellikle Phantom'ın deep-link ile uygulama arasında geçiş yapan onay
 * akışında) uygulama geçişi başarısız olursa `wallet.signTransaction()`
 * SONSUZA KADAR ne çözülüyor ne reddediliyor — bu da ekranı "İşlem
 * bekleniyor" durumunda kalıcı olarak kilitliyordu. Her ağ/cüzdan adımını
 * bu sarmalayıcıyla sınırlıyoruz ki en kötü ihtimalle net bir hata
 * mesajıyla sonuçlansın, sonsuza dek donmasın.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * İki bilinen geçici RPC hatası sınıfına karşı kısa backoff'lu tekrar
 * deneme: (1) public/paylaşımlı RPC'lerin IP başına hız sınırı; (2) yük
 * dengelemeli sağlayıcılarda getLatestBlockhash() bir düğümden, ardından
 * gönderilen işlemin preflight simülasyonu henüz o blockhash'i görmemiş
 * farklı bir düğümden yanıt alabiliyor ("Blockhash not found"). Her
 * deneme ayrıca bir zaman aşımına bağlı.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, baseDelayMs = 800): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn(), 20_000, 'RPC isteği zaman aşımına uğradı.')
    } catch (err) {
      const isTransient =
        err instanceof Error && /429|rate limit|blockhash not found|zaman aşımına uğradı/i.test(err.message)
      if (!isTransient || i === attempts - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i))
    }
  }
  throw new Error('unreachable')
}

/**
 * Talimatları imzalatıp gönderir ve onaylanmasını bekler.
 *
 * Cüzdan onayı uzun sürerse (mobilde uygulama geçişi + kullanıcının okuma
 * süresi kolayca bir dakikayı bulabiliyor) blockhash'in ömrü dolar;
 * imzalanmış işlem artık geçersiz bir blockhash taşıdığı için AYNI imzayı
 * tekrar göndermek işe yaramaz. Böyle bir durumda tüm hazırla→imzala→gönder
 * döngüsü YENİ bir blockhash ve YENİ bir cüzdan onayıyla en baştan
 * tekrarlanıyor (en fazla birkaç kez).
 */
export async function sendInstructions(
  connection: Connection,
  signer: TxSigner,
  ixs: TransactionInstruction[],
  onStatus?: (status: string) => void,
  options?: SendOptions,
): Promise<string> {
  const confirmMessage =
    options?.confirmMessage === undefined ? 'Cüzdanınızda onay bekleniyor...' : options.confirmMessage

  const maxCycles = 3
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const tx = new Transaction().add(...ixs)

    onStatus?.(cycle === 0 ? 'İşlem hazırlanıyor...' : `İşlem yeniden hazırlanıyor (${cycle + 1}. deneme)...`)
    const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash())
    tx.recentBlockhash = blockhash
    tx.feePayer = signer.publicKey

    if (confirmMessage) onStatus?.(confirmMessage)
    const signedTx = await withTimeout(
      signer.signTransaction(tx),
      75_000,
      'Cüzdan onayı 75 saniye içinde tamamlanmadı. Cüzdan uygulamanızı kontrol edin (onay isteği hâlâ açık olabilir) ve tekrar deneyin.',
    )

    try {
      // skipPreflight: yük dengelemeli RPC düğümleri arasında kısa süreli
      // state gecikmesi yüzünden preflight simülasyonu, gönderilen düğümde
      // henüz görünmeyen (ama geçerli) bir blockhash'i reddedebiliyor
      // ("Blockhash not found"). Preflight'ı atlayıp gerçek sonucu
      // confirmTransaction'ın döndürdüğü err alanından okuyoruz.
      onStatus?.('İşlem ağa gönderiliyor...')
      const signature = await withRetry(() =>
        connection.sendRawTransaction(signedTx.serialize(), { skipPreflight: true, maxRetries: 5 }),
      )

      onStatus?.('Onay bekleniyor...')
      const confirmation = await withRetry(() =>
        connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed'),
      )
      if (confirmation.value.err) {
        throw new Error(`İşlem zincirde başarısız oldu: ${JSON.stringify(confirmation.value.err)}`)
      }

      return signature
    } catch (err) {
      const isBlockhashExpiry =
        err instanceof Error && /block height exceeded|blockhash not found/i.test(err.message)
      if (!isBlockhashExpiry || cycle === maxCycles - 1) throw err
      onStatus?.('Onay çok uzun sürdü, blockhash süresi doldu — yeni bir onay isteniyor...')
    }
  }
  throw new Error('unreachable')
}
