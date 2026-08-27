// ---------------------------------------------------------------------------
// Zincire (SBF) giren bağımlılık kümesini hesaplar
// ---------------------------------------------------------------------------
// PROBLEM: `cargo audit` Cargo.lock'u tarıyor ve Cargo.lock, testler için
// gelen TÜM Solana validator/TLS yığınını içeriyor — h2, quinn (QUIC),
// rustls-webpki, ring, tokio... Bunlar zincire yüklenen programın içine
// GİRMİYOR ama audit çıktısında görünüyor. İlk koşuda 10 "açık" çıktı ve
// hepsi bu yığındandı.
//
// Cargo.lock'u zincirdeki programmış gibi denetlemek bir kategori hatası.
// Doğru soru: SBF derlemesine hangi paketler giriyor?
//
// NİYE `cargo tree --target sbf-solana-solana` DEĞİL: standart rustc bu
// hedefi tanımıyor (Solana kendi rustc çatalını gönderiyor), dolayısıyla
// cargo tree hedefi çözemeyip düşüyor. CI'da Solana araç zinciri yok.
//
// ÇÖZÜM: `cargo metadata` her bağımlılık kenarında o kenarın hangi hedef
// koşuluyla geçerli olduğunu veriyor (ör. cfg(not(target_os = "solana"))).
// Bu koşulları SBF hedefi için burada değerlendirip grafiği kendimiz
// yürüyoruz. rustc'ye ihtiyaç yok.

import { execFileSync } from 'node:child_process'

/** SBF hedefinin cfg değerleri. */
const SBF = {
  target_os: 'solana',
  target_arch: 'sbf',
  target_pointer_width: '64',
  target_endian: 'little',
  target_env: '',
  target_vendor: 'unknown',
}

/**
 * `cfg(...)` ifadesini SBF hedefi için değerlendirir.
 *
 * Tanımadığı cfg adları (rustix_use_libc, miri, getrandom_backend gibi
 * derleme bayrakları) FALSE sayılıyor — bunlar özel olarak açılmadıkça
 * geçerli değil ve bizim derlememizde açılmıyorlar.
 */
export function cfgDogruMu(ifade) {
  const s = ifade.trim()

  if (s.startsWith('not(')) return !cfgDogruMu(icerik(s, 'not'))
  if (s.startsWith('any(')) return parcala(icerik(s, 'any')).some(cfgDogruMu)
  if (s.startsWith('all(')) return parcala(icerik(s, 'all')).every(cfgDogruMu)

  // anahtar = "değer"
  const m = s.match(/^([a-z_0-9]+)\s*=\s*"([^"]*)"$/)
  if (m) {
    const [, anahtar, deger] = m
    if (anahtar in SBF) return SBF[anahtar] === deger
    // target_family gibi bilmediğimiz anahtarlar: SBF ne unix ne windows.
    if (anahtar === 'target_family') return false
    return false
  }

  // Çıplak adlar
  if (s === 'unix' || s === 'windows') return false
  // Bilinmeyen bayraklar kapalı sayılıyor.
  return false
}

function icerik(s, ad) {
  const bas = ad.length + 1
  return s.slice(bas, s.lastIndexOf(')'))
}

/** Virgülle ayır — ama parantez içindeki virgülleri bölme. */
function parcala(s) {
  const parcalar = []
  let derinlik = 0
  let bas = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') derinlik++
    else if (c === ')') derinlik--
    else if (c === ',' && derinlik === 0) {
      parcalar.push(s.slice(bas, i))
      bas = i + 1
    }
  }
  parcalar.push(s.slice(bas))
  return parcalar.map((p) => p.trim()).filter(Boolean)
}

/**
 * Bir kenarın `target` alanı SBF için geçerli mi.
 *
 * `null`  → koşulsuz, her hedefte geçerli.
 * `cfg(…)`→ ifadeyi değerlendir.
 * düz üçlü ("aarch64-linux-android" gibi) → bizim hedefimiz değil.
 */
export function kenarGecerli(target) {
  if (target === null || target === undefined) return true
  const s = String(target).trim()
  if (s.startsWith('cfg(')) return cfgDogruMu(s.slice(4, s.lastIndexOf(')')))
  return false
}

/**
 * Programın SBF derlemesine giren paket kümesi (ad@sürüm).
 *
 * Yalnızca NORMAL bağımlılıklar izleniyor: dev-dependencies test
 * makinesinde çalışıyor, build-dependencies derleme sırasında — ikisi de
 * zincire yüklenen bytecode'un içinde değil.
 */
export function sbfBagimliliklari(calismaDizini, paketAdi) {
  const ham = execFileSync('cargo', ['metadata', '--format-version', '1'], {
    cwd: calismaDizini,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  const meta = JSON.parse(ham)

  const dugumler = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
  const paketler = new Map(meta.packages.map((p) => [p.id, p]))

  const kok = meta.resolve.nodes.find((n) => {
    const p = paketler.get(n.id)
    return p && p.name === paketAdi
  })
  if (!kok) throw new Error(`paket bulunamadı: ${paketAdi}`)

  const gorulen = new Set()
  const kuyruk = [kok.id]
  while (kuyruk.length) {
    const id = kuyruk.pop()
    if (gorulen.has(id)) continue
    gorulen.add(id)
    const dugum = dugumler.get(id)
    if (!dugum) continue
    for (const dep of dugum.deps) {
      // Bir kenar birden fazla türde olabilir (normal + dev). Yalnızca
      // NORMAL (kind === null) ve hedefi SBF'ye uyan olanları izliyoruz.
      const gecerli = dep.dep_kinds.some(
        (dk) => (dk.kind === null || dk.kind === undefined) && kenarGecerli(dk.target),
      )
      if (gecerli) kuyruk.push(dep.pkg)
    }
  }

  gorulen.delete(kok.id)
  return [...gorulen]
    .map((id) => {
      const p = paketler.get(id)
      return p ? `${p.name}@${p.version}` : id
    })
    .sort()
}
