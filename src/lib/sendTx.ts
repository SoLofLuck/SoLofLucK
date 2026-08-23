import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'

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

// NOT: cüzdan adaptörünün kendi `sendTransaction` metodu BİLEREK
// kullanılmıyor. Mobilde bir tur gidiş-geliş kazandırıyor, ama işlemi
// CÜZDANIN seçili olduğu ağa yayınlıyor — bizim bağlandığımız ağa değil.
// Cüzdan başka bir ağdayken (ör. Phantom'da Devnet yerine Testnet seçili)
// işlem sessizce yanlış ağa gidiyor. İmzayı alıp kendi bağlantımızdan
// göndermek, işlemin her zaman sitenin seçtiği ağa gitmesini garanti
// ediyor; hız kazancı bu garantiden vazgeçmeye değmez.

// İşlemlere eklenen küçük öncelik ücreti. Ağ yoğunken önceliksiz işlemler
// lider tarafından sessizce düşürülüyor ve blockhash süresi doluyor —
// kullanıcının gördüğü "işlem zincire yazılmadı" hatasının sebeplerinden
// biri buydu. Sınır tanımlı olduğu için maliyet üst sınırı belli:
// 300.000 CU x 5.000 microLamport = 1.500 lamport (~0,0000015 SOL).
const COMPUTE_UNIT_LIMIT = 300_000
const PRIORITY_FEE_MICRO_LAMPORTS = 5_000

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
      connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 }).catch(() => {})
      lastResendAt = Date.now()
      onStatus?.('Onay bekleniyor (işlem ağa tekrar gönderiliyor)...')
    }

    await sleep(1500)
  }

  return { kind: 'expired' }
}

/**
 * İmza istemeden ÖNCE işlemi simüle eder ve kesin bir hata varsa net bir
 * mesajla durur.
 *
 * Neden gerekli: gerçek gönderimde `skipPreflight: true` kullanıyoruz
 * (blockhash yayılma gecikmesi yüzünden sahte "Blockhash not found"
 * hatalarını atlamak için). Ama preflight'ı atlamanın bedeli, GERÇEK
 * hataların da gizlenmesi: cüzdanda ağ ücreti için SOL kalmadığında işlem
 * lider tarafından reddediliyor, hiç zincire yazılmıyor ve biz bunu
 * "blockhash süresi doldu" diye raporluyorduk. Kullanıcı defalarca imza
 * atıp neden başarısız olduğunu göremiyordu.
 *
 * Simülasyon imza gerektirmiyor, ücretsiz ve hızlı — bu yüzden cüzdanı
 * hiç rahatsız etmeden önce çalıştırıyoruz.
 */
async function assertSimulationPasses(connection: Connection, tx: Transaction): Promise<void> {
  let result
  try {
    result = await withRetry(
      () => connection.simulateTransaction(tx),
      2,
      600,
    )
  } catch {
    // Simülasyonun KENDİSİ başarısız olduysa (RPC hatası, zaman aşımı) yolu
    // tıkamıyoruz — geçici olabilir ve kullanıcıyı gerçek bir sorun olmadan
    // durdurmak istemeyiz.
    return
  }

  const err = result.value.err
  if (!err) return

  const raw = JSON.stringify(err)
  const logs = (result.value.logs ?? []).join('\n')

  // Kullanıcının düzeltebileceği, net sorunlar — bunlarda cüzdanı hiç
  // açmadan duruyoruz.
  if (/InsufficientFundsForFee/i.test(raw) || /insufficient lamports/i.test(logs)) {
    throw new Error(
      'Cüzdanınızda ağ ücretini ödeyecek kadar SOL yok. Devnet\'te ücretsiz SOL için ' +
        'faucet.solana.com adresini kullanabilir, Mainnet\'te cüzdanınıza biraz SOL göndermeniz gerekir.',
    )
  }
  if (/insufficient funds/i.test(logs)) {
    throw new Error('Bakiye yetersiz — işlemin gerektirdiği tutar cüzdanınızda yok.')
  }
  // Programın kendi reddi (Anchor/SPL hata kodu): gerçek ve tekrarlanabilir
  // bir hata, göstermeye değer.
  if (/InstructionError/i.test(raw)) {
    throw new Error(`İşlem simülasyonu başarısız: ${raw}${logs ? `\n${logs.slice(-400)}` : ''}`)
  }

  // Geri kalan her şey SONUÇSUZ sayılıyor ve yolu tıkamıyor. Özellikle
  // "BlockhashNotFound": simulateTransaction kendi blockhash'ini çekiyor ve
  // yük dengelemeli RPC'lerde simülasyonu yapan düğüm o blockhash'i henüz
  // görmemiş olabiliyor. Bu, işlemle ilgili bir sorun DEĞİL — nitekim bu
  // kontrolü ilk eklediğimde spin satın alma tam da bu yüzden hiç
  // başlayamadan hata veriyordu. Ön kontrolün işi, kullanıcının
  // düzeltebileceği net sorunları erken yakalamak; şüpheli her durumda
  // işlemi durdurmak değil.
  console.warn('Simülasyon sonuçsuz, işleme devam ediliyor:', raw)
}

/**
 * Ücreti ödeyecek hesabın SİTENİN BAĞLI OLDUĞU ağdaki bakiyesini kontrol
 * eder.
 *
 * Bu kontrol, cüzdanın kendi ekranında gösterdiği bakiyeye değil, bizim
 * RPC bağlantımıza bakıyor — ve tam da bu yüzden değerli: cüzdan başka bir
 * ağa ayarlıysa (ör. Phantom "Testnet Mode" içinde Devnet yerine Testnet
 * seçiliyse) kullanıcı cüzdanında dolu bir bakiye görüyor ama işlemler
 * bizim ağımızda ücretsiz kalıyor ve hiç zincire yazılmıyor. Mesajda hem
 * gerçek bakiyeyi hem de ağ adını veriyoruz ki yanlış ağ durumu anlaşılsın.
 */
async function assertFeePayerFunded(connection: Connection, feePayer: PublicKey): Promise<void> {
  let lamports: number
  try {
    lamports = await withTimeout(connection.getBalance(feePayer), 15_000, 'Bakiye sorgusu zaman aşımı.')
  } catch {
    return // Geçici RPC sorunu — kullanıcıyı boşuna durdurmuyoruz.
  }

  // Taban işlem ücreti (5.000) + öncelik ücreti üst sınırı + küçük bir pay.
  const needed = 5_000 + (COMPUTE_UNIT_LIMIT * PRIORITY_FEE_MICRO_LAMPORTS) / 1_000_000 + 5_000
  if (lamports >= needed) return

  const sol = (lamports / 1_000_000_000).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')
  throw new Error(
    `Bu ağda cüzdanınızda ${sol} SOL var; işlem ücreti için yeterli değil. ` +
      'Cüzdanınızda dolu bir bakiye görüyorsanız cüzdanınız BAŞKA BİR AĞA ayarlı olabilir — ' +
      'sitedeki ağ seçimiyle (üst soldaki menü) cüzdanınızın ağının aynı olduğundan emin olun. ' +
      'Devnet için ücretsiz SOL: faucet.solana.com',
  )
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

    // Öncelik ücreti talimatları en başa: ağ yoğunken önceliksiz işlemler
    // lider tarafından sessizce düşürülüyor ve blockhash süresi doluyor.
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }))
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICRO_LAMPORTS }))
      .add(...ixs)

    onStatus?.(cycle === 0 ? 'İşlem hazırlanıyor...' : `İşlem yeniden hazırlanıyor (${cycle + 1}. deneme)...`)
    // 'confirmed' ile mümkün olan en TAZE blockhash'i alıyoruz; daha eski
    // (finalized) bir blockhash, zaten kısa olan geçerlilik penceresinin
    // bir kısmını daha baştan harcamış olurdu.
    const { blockhash, lastValidBlockHeight } = await withRetry(() =>
      connection.getLatestBlockhash('confirmed'),
    )
    tx.recentBlockhash = blockhash
    tx.feePayer = signer.publicKey

    // İmza istemeden önce kesin hataları yakala (yetersiz bakiye vb.).
    // Yalnızca ilk turda: sonraki turlar aynı talimatları taşıyor.
    if (cycle === 0) {
      onStatus?.('İşlem kontrol ediliyor...')
      await assertFeePayerFunded(connection, signer.publicKey)
      await assertSimulationPasses(connection, tx)
    }

    if (confirmMessage) onStatus?.(confirmMessage)

    // Mobilde uygulama geçişi + kullanıcının okuma süresi rahatlıkla bir
    // dakikayı buluyor; bu yüzden onay için geniş bir pencere bırakıyoruz.
    // Yine de sonsuz değil: deep-link hiç geri dönmezse net bir hata verip
    // ekranı kilitli bırakmıyoruz.
    //
    // skipPreflight: yük dengelemeli RPC düğümleri arasında kısa süreli
    // state gecikmesi yüzünden preflight simülasyonu, gönderilen düğümde
    // henüz görünmeyen (ama geçerli) bir blockhash'i reddedebiliyor
    // ("Blockhash not found"). Gerçek sonucu imza durumundan okuyoruz.
    const signedTx = await withTimeout(
      signer.signTransaction(tx),
      120_000,
      'Cüzdan onayı 2 dakika içinde tamamlanmadı. Cüzdan uygulamanızı kontrol edin (onay isteği hâlâ açık olabilir) ve tekrar deneyin.',
    )
    const rawTx = signedTx.serialize()

    onStatus?.('İşlem ağa gönderiliyor...')
    const signature = await withRetry(() =>
      // maxRetries, RPC düğümünün işlemi lidere TEKRAR TEKRAR iletmesini
      // sağlıyor. Bir ara bunu 0'a çekmiştim ("kendi yeniden yayınımız var"
      // diye) — ama istemciden 3sn'de bir gönderim, düğümün her slot başında
      // yeniden iletmesinin yerini tutmuyor.
      connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 }),
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
