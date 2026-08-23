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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type ConfirmOutcome =
  | { kind: 'ok' }
  | { kind: 'failed'; err: unknown }
  | { kind: 'expired' }

/**
 * İşlemin zincire yazılmasını HTTP yoklamasıyla bekler — `confirmTransaction`
 * ile DEĞİL.
 *
 * Sebep: `confirmTransaction` bir websocket aboneliği açıyor. Mobilde cüzdan
 * onayı için uygulama değiştirildiğinde tarayıcı sayfayı arka plana alıyor ve
 * bu abonelik sessizce kopuyor. Bildirim hiç gelmediği için işlem ZİNCİRE
 * YAZILMIŞ olsa bile "block height exceeded" hatası veriliyordu — kullanıcı
 * yakma başarısız sandı, oysa tokenlar yanmış olabilirdi. HTTP yoklaması
 * arka plana alınmaya dayanıklı.
 *
 * Aynı döngüde imzalı işlem periyodik olarak YENİDEN yayınlanıyor: paylaşımlı
 * devnet/mainnet RPC'leri yoğunlukta işlem düşürebiliyor ve tek gönderim
 * çoğu zaman yetmiyor.
 */
async function confirmBySignature(
  connection: Connection,
  signature: string,
  rawTx: Uint8Array,
  lastValidBlockHeight: number,
  onStatus?: (status: string) => void,
): Promise<ConfirmOutcome> {
  const deadline = Date.now() + 120_000
  let lastResendAt = Date.now()

  while (Date.now() < deadline) {
    const status = await connection
      .getSignatureStatuses([signature])
      .then((r) => r.value[0])
      .catch(() => null)

    if (status) {
      if (status.err) return { kind: 'failed', err: status.err }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { kind: 'ok' }
      }
    }

    const height = await connection.getBlockHeight().catch(() => null)
    if (height !== null && height > lastValidBlockHeight) {
      // Blockhash penceresi kapandı. Kapanmadan hemen önce yazılmış olma
      // ihtimaline karşı son bir kez daha bakıyoruz — burada acele edip
      // "expired" dönmek, kullanıcıdan aynı işlem için ikinci bir imza
      // istemek demek olurdu (yani çift yakma riski).
      await sleep(2000)
      const finalStatus = await connection
        .getSignatureStatuses([signature])
        .then((r) => r.value[0])
        .catch(() => null)
      if (finalStatus && !finalStatus.err) return { kind: 'ok' }
      if (finalStatus?.err) return { kind: 'failed', err: finalStatus.err }
      return { kind: 'expired' }
    }

    if (Date.now() - lastResendAt > 3000) {
      // Yeniden yayın: aynı imza, aynı işlem — mükerrer bir işlem
      // oluşturmaz, yalnızca düşürülmüş olabilecek paketi tekrar gönderir.
      connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => {})
      lastResendAt = Date.now()
      onStatus?.('Onay bekleniyor (işlem ağa tekrar gönderiliyor)...')
    }

    await sleep(1500)
  }

  return { kind: 'expired' }
}

/** Daha önce gönderilmiş imzalardan zincire yazılmış olan var mı? */
async function findLandedSignature(
  connection: Connection,
  signatures: string[],
): Promise<string | null> {
  if (signatures.length === 0) return null
  const statuses = await connection
    .getSignatureStatuses(signatures)
    .then((r) => r.value)
    .catch(() => null)
  if (!statuses) return null
  for (let i = 0; i < signatures.length; i++) {
    const st = statuses[i]
    if (st && !st.err) return signatures[i]
  }
  return null
}

/**
 * Talimatları imzalatıp gönderir ve zincire yazılmasını bekler.
 *
 * Normal koşulda TEK bir cüzdan onayı ister. Yalnızca işlem gerçekten
 * zincire yazılmadıysa (blockhash penceresi kapandı ve imza hiçbir durumda
 * görünmüyor) yeni bir blockhash'le yeniden imza istenir. Her yeni turdan
 * ÖNCE önceki imzalar tekrar kontrol edilir: biri aslında yazılmışsa döngü
 * orada biter — aynı işlemi iki kez göndermemek için.
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

  const attempted: string[] = []
  const maxCycles = 3

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const alreadyLanded = await findLandedSignature(connection, attempted)
    if (alreadyLanded) return alreadyLanded

    const tx = new Transaction().add(...ixs)

    onStatus?.(cycle === 0 ? 'İşlem hazırlanıyor...' : `İşlem yeniden hazırlanıyor (${cycle + 1}. deneme)...`)
    const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash())
    tx.recentBlockhash = blockhash
    tx.feePayer = signer.publicKey

    if (confirmMessage) onStatus?.(confirmMessage)
    // Mobilde uygulama geçişi + kullanıcının okuma süresi rahatlıkla bir
    // dakikayı buluyor; bu yüzden onay için geniş bir pencere bırakıyoruz.
    // Yine de sonsuz değil: deep-link hiç geri dönmezse net bir hata verip
    // ekranı kilitli bırakmıyoruz.
    const signedTx = await withTimeout(
      signer.signTransaction(tx),
      120_000,
      'Cüzdan onayı 2 dakika içinde tamamlanmadı. Cüzdan uygulamanızı kontrol edin (onay isteği hâlâ açık olabilir) ve tekrar deneyin.',
    )
    const rawTx = signedTx.serialize()

    // skipPreflight: yük dengelemeli RPC düğümleri arasında kısa süreli
    // state gecikmesi yüzünden preflight simülasyonu, gönderilen düğümde
    // henüz görünmeyen (ama geçerli) bir blockhash'i reddedebiliyor
    // ("Blockhash not found"). Gerçek sonucu imza durumundan okuyoruz.
    onStatus?.('İşlem ağa gönderiliyor...')
    const signature = await withRetry(() =>
      connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }),
    )
    attempted.push(signature)

    onStatus?.('Onay bekleniyor...')
    const outcome = await confirmBySignature(connection, signature, rawTx, lastValidBlockHeight, onStatus)

    if (outcome.kind === 'ok') return signature
    if (outcome.kind === 'failed') {
      throw new Error(`İşlem zincirde başarısız oldu: ${JSON.stringify(outcome.err)}`)
    }
    if (cycle === maxCycles - 1) {
      throw new Error(
        'İşlem zincire yazılmadı (blockhash süresi doldu). Ağ yoğun olabilir — biraz bekleyip tekrar deneyin. ' +
          'Cüzdanınızdaki bakiye değişmediyse hiçbir işlem gerçekleşmemiştir.',
      )
    }
    onStatus?.('İşlem zamanında zincire yazılmadı — yeni bir onayla tekrar deneniyor...')
  }
  throw new Error('unreachable')
}
