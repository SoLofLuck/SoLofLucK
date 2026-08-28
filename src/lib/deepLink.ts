// ---------------------------------------------------------------------------
// Tab state in the address bar
// ---------------------------------------------------------------------------
// Tabs used to live only in React state. The consequences were:
//
//   * A presale link could not be shared. For a presale that is a serious gap —
//     the address given in an announcement dropped the user on the "Create
//     Token" tab and they had to find the presale themselves.
//   * Refreshing the page always went back to the start.
//   * The browser's back button did not work between tabs.
//
// The fix is hash-based: `#presale`, `#luck/presale` and so on. The hash never
// reaches the server, so there is no need to deal with GitHub Pages path
// routing, and the existing 404.html copy arrangement keeps working unchanged.
//
// The logic lives here rather than in the components so that it is testable.

/**
 * `#a/b` -> ['a', 'b'] · an empty or malformed hash -> []
 *
 * Tolerant of extra separators: `##a//b/` also gives `['a','b']`. Only a single
 * hash was being trimmed and a test caught that — whatever the user types into
 * the address bar, the site must open on the right tab.
 */
export function parseHash(hash: string): string[] {
  return hash
    .replace(/^#+/, '')
    .split('/')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Extracts (page, sub-tab) from the hash.
 *
 * Unknown values are ignored and fall back to the default — whatever the user
 * types into the address bar, the site must open rather than show a blank
 * screen.
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
  // The sub-tab only means anything on its own page.
  const subTab =
    page === opts.subTabPage && (opts.subTabs as readonly string[]).includes(parts[1])
      ? (parts[1] as S)
      : opts.defaultSubTab
  return { page, subTab }
}

/** (page, sub-tab) -> a hash in the form `#luck/presale`. */
export function hashFromRoute<P extends string, S extends string>(
  page: P,
  subTab: S,
  opts: { subTabPage: P; defaultPage: P },
): string {
  if (page === opts.subTabPage) return `#${page}/${subTab}`
  return `#${page}`
}
