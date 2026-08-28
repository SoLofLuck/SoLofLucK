// ---------------------------------------------------------------------------
// Sekme durumu adres çubuğunda
// ---------------------------------------------------------------------------
// Sekmeler yalnızca React state'inde tutuluyordu. Sonucu şuydu:
//
//   * Presale linki paylaşılamıyordu. Bir presale için bu ciddi bir eksik —
//     duyuruda verilen adres kullanıcıyı "Token Oluştur" sekmesine düşürüyor
//     ve presale'i kendisi bulmak zorunda kalıyor.
//   * Sayfa yenilenince her zaman başa dönülüyordu.
//   * Tarayıcının geri tuşu sekmeler arasında çalışmıyordu.
//
// Çözüm hash tabanlı: `#presale`, `#luck/presale` gibi. Hash sunucuya hiç
// gitmediği için GitHub Pages'in yol yönlendirmesiyle uğraşmaya gerek yok
// ve mevcut 404.html kopyalama düzeni aynen çalışmaya devam ediyor.
//
// Mantık burada, bileşenlerde değil: sınanabilir olması için.

/**
 * `#a/b` -> ['a', 'b'] · boş/bozuk hash -> []
 *
 * Fazladan ayraçlara toleranslı: `##a//b/` da `['a','b']` veriyor. Tek
 * diyez kırpılıyordu ve test bunu yakaladı — kullanıcı adres çubuğuna ne
 * yazarsa yazsın site doğru sekmede açılmalı.
 */
export function parseHash(hash: string): string[] {
  return hash
    .replace(/^#+/, '')
    .split('/')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Hash'ten (sayfa, alt sekme) çıkarır.
 *
 * Bilinmeyen değerler yok sayılıp varsayılana düşülüyor — kullanıcı adres
 * çubuğuna ne yazarsa yazsın site açılmalı, boş ekran vermemeli.
 */
export function routeFromHash<P extends string, S extends string>(
  hash: string,
  opts: {
    pages: readonly P[]
    defaultPage: P
    subTabs: readonly S[]
    defaultSubTab: S
    subTabPage: P
  },
): { page: P; subTab: S } {
  const parts = parseHash(hash)
  const page = (opts.pages as readonly string[]).includes(parts[0])
    ? (parts[0] as P)
    : opts.defaultPage
  // Alt sekme yalnızca ilgili sayfada anlamlı.
  const subTab =
    page === opts.subTabPage && (opts.subTabs as readonly string[]).includes(parts[1])
      ? (parts[1] as S)
      : opts.defaultSubTab
  return { page, subTab }
}

/** (sayfa, alt sekme) -> `#luck/presale` biçiminde hash. */
export function hashFromRoute<P extends string, S extends string>(
  page: P,
  subTab: S,
  opts: { subTabPage: P; defaultPage: P },
): string {
  if (page === opts.subTabPage) return `#${page}/${subTab}`
  return `#${page}`
}
