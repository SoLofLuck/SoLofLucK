#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ABI check — do the client/scripts and the program speak the same bytes
// ---------------------------------------------------------------------------
// THE SITE (TypeScript) builds the claim instruction and THE PROGRAM (Rust)
// verifies it. A single byte of difference between them — a wrong
// discriminator, a swapped account order, a bad length field — means EVERYONE's
// claim is rejected on TGE day. Because the merkle root cannot be changed on
// chain, the chance to fix it at that point is limited.
//
// This check compiles and runs the client's REAL code (src/lib/luckClaim.ts)
// and compares the bytes it produces against the fixed vector the program
// itself produced. The vector is pinned on the Rust side by the
// `claim_instruction_bytes_match_golden_vector` test; if either side drifts, it
// is caught here.
//
// We do not rewrite the instruction here — a copy would prove that the copy
// agrees with itself, not that the two sides agree.

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PublicKey } from '@solana/web3.js'

// --- The golden vector the program produced (see distributor.rs, test 14) --
const DISCRIMINATOR = '3ec6d6c1d59f6cd2'
const AMOUNT = 271_950_000_000_000_000n
const AMOUNT_LE = '00e0aa8a1529c603'
const PROOF_LEN_LE = '02000000'
const DATA_LEN = 8 + 8 + 4 + 64

// The field order of the Claim<'info> struct in Rust. Anchor expects the
// accounts in this order; if the order shifts, the program sees the wrong
// account in the wrong role and the instruction is rejected.
const ACCOUNT_ORDER = [
  'claimant',
  'distributor',
  'mint',
  'vault',
  'claim_status',
  'destination',
  'token_program',
  'associated_token_program',
  'system_program',
]

const failures = []
const checks = []
function check(name, actual, expected) {
  const ok = String(actual) === String(expected)
  checks.push({ name, ok, actual, expected })
  if (!ok) failures.push(name)
}

// --- Compile the client code ------------------------------------------------
// The output is written INSIDE THE REPO, not to /tmp: the compiled module
// imports @solana/web3.js, and Node's package resolution cannot find
// node_modules from outside the repo.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(repoRoot, 'node_modules', '.claim-abi-'))
let tscCiktisi = ''
try {
  execFileSync(
    'npx',
    [
      'tsc',
      'src/lib/luckClaim.ts',
      'src/lib/luckGame.ts',
      'src/lib/sendTx.ts',
      'src/lib/presale.ts',
      'src/lib/deepLink.ts',
      '--outDir', out,
      '--module', 'esnext',
      '--target', 'es2022',
      '--moduleResolution', 'bundler',
      '--skipLibCheck',
      '--ignoreConfig',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  tscCiktisi = ''
} catch (err) {
  // Because we compile a single file without the project tsconfig, tsc
  // reports type errors here that are NOT real (Buffer types, Vite's
  // import.meta.env). The real type check already happens with `tsc -b`
  // inside `npm run build`, with the right configuration.
  //
  // So we swallow the output but do not DISCARD it: if the emit really did
  // fail, the import below blows up and we print the reason at that point.
  // Printing spurious errors on every build would hide a real one in the
  // noise.
  tscCiktisi = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim()
}

// Two mechanical fixups applied to the COMPILED output (the source files are
// NOT touched):
//
// 1. tsc leaves extensionless relative imports such as `from '../config'` as
//    they are (bundler resolution). Node ESM wants an extension.
// 2. config.ts reads Vite's `import.meta.env`; that is undefined in Node, so
//    the module blows up while loading. The RPC endpoint is not the subject of
//    this check.
//
// The fixup is applied to EVERY compiled file, not to a hand-maintained list.
// With a fixed list, adding a new source broke the check: when presale.ts was
// added, its `./sendTx` import was not fixed and it blew up with
// ERR_MODULE_NOT_FOUND. It is recursive so the same thing does not happen with
// the next file.
const jsFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? jsFiles(join(dir, e.name))
      : e.name.endsWith('.js')
        ? [join(dir, e.name)]
        : [],
  )
for (const yol of jsFiles(out)) {
  writeFileSync(
    yol,
    readFileSync(yol, 'utf8')
      .replace(/from '(\.[^']*)'/g, (m, p) => (p.endsWith('.js') ? m : `from '${p}.js'`))
      .replace(/import\.meta\.env/g, '({})'),
  )
}

let config
let claim
try {
  config = await import(pathToFileURL(join(out, 'config.js')).href)
  claim = await import(pathToFileURL(join(out, 'lib/luckClaim.js')).href)
} catch (err) {
  console.error('The client code could not be compiled — the ABI comparison could not run.')
  if (tscCiktisi) console.error(tscCiktisi)
  console.error(err)
  rmSync(out, { recursive: true, force: true })
  process.exit(1)
}

// The mint has not been created yet; the ABI's correctness does not depend on
// the mint's VALUE, only on there being a mint at all. We pass a fixed address
// for the test and leave the production configuration alone.
config.LUCK_TOKEN.mint = 'So11111111111111111111111111111111111111112'

const claimant = new PublicKey('BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36')
const entry = {
  address: claimant.toBase58(),
  amount: AMOUNT.toString(),
  proof: ['11'.repeat(32), '22'.repeat(32)],
}

const ix = claim.buildClaimIx(claimant, 0, entry)
const hex = Buffer.from(ix.data).toString('hex')

check('instruction data length', ix.data.length, DATA_LEN)
check('discriminator', hex.slice(0, 16), DISCRIMINATOR)
check('amount (u64 little-endian)', hex.slice(16, 32), AMOUNT_LE)
check('proof length (u32 little-endian)', hex.slice(32, 40), PROOF_LEN_LE)
check('proof node 1', hex.slice(40, 104), '11'.repeat(32))
check('proof node 2', hex.slice(104, 168), '22'.repeat(32))

check('account count', ix.keys.length, ACCOUNT_ORDER.length)
// We verify the accounts' IDENTITY as well as their count: an order shift is
// the most likely error and a count check would not catch it.
const distributor = claim.distributorPda(0)
const expectedAccounts = [
  claimant,
  distributor,
  new PublicKey(config.LUCK_TOKEN.mint),
  claim.vaultPda(distributor),
  claim.claimStatusPda(distributor, claimant),
  claim.associatedTokenAddress(claimant, new PublicKey(config.LUCK_TOKEN.mint)),
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  new PublicKey('11111111111111111111111111111111'),
]
for (let i = 0; i < ACCOUNT_ORDER.length; i++) {
  check(
    `account ${i}: ${ACCOUNT_ORDER[i]}`,
    ix.keys[i]?.pubkey?.toBase58(),
    expectedAccounts[i].toBase58(),
  )
}
// The claimant must be the only signer; if another account demanded a
// signature, the wallet would either never open or grant the wrong authority.
check('the claimant is the only signer', ix.keys.filter((k) => k.isSigner).length, 1)
check('the claimant signs', ix.keys[0].isSigner, true)
// The accounts the program writes to must be marked writable.
for (const [i, name] of [[1, 'distributor'], [3, 'vault'], [4, 'claim_status'], [5, 'destination']]) {
  check(`${name} is writable`, ix.keys[i].isWritable, true)
}

check('program adresi', ix.programId.toBase58(), config.CLAIM_CONFIG.programId)

// ---------------------------------------------------------------------------
// The initialize ABI — the instruction that opens the round and LOCKS the tokens
// ---------------------------------------------------------------------------
// If it is encoded wrongly, one of two bad outcomes follows: either the
// transaction is rejected (we notice), or a wrong schedule/root is silently
// written to the chain — and because the program contains no update
// instruction, there is no way back from that point.
//
// We run the REAL script that will run on TGE day (in PRINT_IX mode) and
// compare the bytes it produces against the program's golden vector. Rebuilding
// the instruction here would prove that the copy agrees with itself.
const INIT_EXPECTED =
  'afaf6d1f0d989bed' +
  '0000000000000000' +
  '9b4c1bb9c40fe4fe3d4ee9e172c6318402503421b34f26e74ca9754938bbce84' +
  '00201a0b9ed40b00' +
  '40be966a00000000' +
  '8403' +
  'bc02' +
  '803a090000000000' +
  '0d00'

// The field order of the Initialize<'info> struct in Rust.
const INIT_ACCOUNT_ORDER = [
  'authority',
  'mint',
  'distributor',
  'vault',
  'token_program',
  'system_program',
  'rent',
]

const fixedMerkle = join(out, 'round-abi.json')
writeFileSync(
  fixedMerkle,
  JSON.stringify({
    root: '9b4c1bb9c40fe4fe3d4ee9e172c6318402503421b34f26e74ca9754938bbce84',
    total: '3330000000000000',
    count: 3,
    claims: [
      { address: 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36', amount: '1110000000000000', proof: [] },
      { address: 'AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA', amount: '1110000000000000', proof: [] },
      { address: '3fBhNn8BEoFyQVAXasWj1xcNrcc2FRpLVQexFhZTnw6F', amount: '1110000000000000', proof: [] },
    ],
  }),
)

let initOutput
try {
  initOutput = execFileSync(
    process.execPath,
    ['program/luck-distributor/scripts/initialize-round.mjs'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PRINT_IX: '1',
        PROGRAM_ID: config.CLAIM_CONFIG.programId,
        MINT: config.LUCK_TOKEN.mint,
        ROUND_ID: '0',
        MERKLE_FILE: fixedMerkle,
        START_ISO: '2026-09-01T12:00:00Z',
        CLIFF_BPS: '900',
        PERIOD_BPS: '700',
        PERIODS: '13',
        AUTHORITY: 'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36',
      },
    },
  )
} catch (err) {
  console.error('initialize-round.mjs could not be run:')
  console.error(`${err.stdout ?? ''}${err.stderr ?? ''}`)
  rmSync(out, { recursive: true, force: true })
  process.exit(1)
}

const init = JSON.parse(initOutput)
check('initialize: instruction bytes', init.data, INIT_EXPECTED)
check('initialize: account count', init.keys.length, INIT_ACCOUNT_ORDER.length)
const initExpectedAccounts = [
  'BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36',
  config.LUCK_TOKEN.mint,
  init.distributor,
  init.vault,
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  '11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
]
for (let i = 0; i < INIT_ACCOUNT_ORDER.length; i++) {
  check(
    `initialize: account ${i}: ${INIT_ACCOUNT_ORDER[i]}`,
    init.keys[i]?.pubkey,
    initExpectedAccounts[i],
  )
}
check('initialize: the authority is the only signer', init.keys.filter((k) => k.isSigner).length, 1)
check('initialize: distributor is writable', init.keys[2].isWritable, true)
check('initialize: vault is writable', init.keys[3].isWritable, true)
check('initialize: program adresi', init.programId, config.CLAIM_CONFIG.programId)


// ---------------------------------------------------------------------------
// The unlock schedule — do the interface and the program give the same number
// ---------------------------------------------------------------------------
// The `unlockedAmount` formula is written TWICE: in the program (Rust) and in
// the interface (src/lib/luckClaim.ts). That is deliberate — the interface has
// to be able to show the right number without asking the chain. But if the two
// drift apart, a user sees something as "claimable", signs, and the transaction
// is rejected; or conversely never sees the amount they are owed.
//
// The table below is IDENTICAL to `unlock_schedule_matches_golden_vector` in
// the luck-distributor tests. The numbers were computed separately from the
// percentages rather than read off the program's output:
// 271,950,000 x 9% = 24,475,500 · 16% = 43,512,000 · 51% = 138,694,500.
const TGE = 1_788_264_000 // 2026-09-01T12:00:00Z
const WEEK = 604_800
const PRESALE_TOTAL = 271_950_000_000_000_000n

const schedule = {
  merkleRoot: new Uint8Array(32),
  totalAllocated: PRESALE_TOTAL,
  totalClaimed: 0n,
  startTs: TGE,
  cliffBps: 900,
  periodBps: 700,
  periodSeconds: WEEK,
  periods: 13,
}

const scheduleVector = [
  [TGE - 1, 0n, '1 s before TGE'],
  [TGE, 24_475_500_000_000_000n, 'TGE (%9)'],
  [TGE + WEEK - 1, 24_475_500_000_000_000n, 'the last second of week 1'],
  [TGE + WEEK, 43_512_000_000_000_000n, '1. hafta (%16)'],
  [TGE + 6 * WEEK, 138_694_500_000_000_000n, '6. hafta (%51)'],
  [TGE + 13 * WEEK, PRESALE_TOTAL, '13. hafta (%100)'],
  [TGE + 99 * WEEK, PRESALE_TOTAL, 'long afterwards (still 100%)'],
]

for (const [t, expected, name] of scheduleVector) {
  check(
    `schedule: ${name}`,
    claim.unlockedAmount(schedule, PRESALE_TOTAL, t).toString(),
    expected.toString(),
  )
}

// THE ROUNDING DIRECTION. Because every step in the vector above divides
// exactly, it never tested the direction of the rounding — that blind spot came
// to light when the interface's formula was deliberately broken to round up and
// the check STILL PASSED.
//
// The direction is critical: rounding up, the sum of the individual shares
// could exceed the total allocation and THE LAST CLAIMANT's withdrawal would
// fail because the vault had run out. Rounding down, at worst a few units stay
// in the vault.
const INDIVISIBLE = 1_000_000_007n
for (const [tier, expected, name] of [
  [0, 90_000_000n, '%9'],
  [1, 160_000_001n, '%16'],
  [6, 510_000_003n, '%51'],
]) {
  check(
    `schedule: rounding down on an indivisible amount (${name})`,
    claim.unlockedAmount(schedule, INDIVISIBLE, TGE + tier * WEEK).toString(),
    expected.toString(),
  )
}

// A raffle round: the schedule is a single item, 100% at TGE.
const raffle = { ...schedule, cliffBps: 10_000, periodBps: 0, periods: 0 }
check(
  'schedule: a raffle round unlocks fully at TGE',
  claim.unlockedAmount(raffle, 1_110_000_000_000_000n, TGE).toString(),
  (1_110_000_000_000_000n).toString(),
)
check(
  'schedule: a raffle round is closed before TGE',
  claim.unlockedAmount(raffle, 1_110_000_000_000_000n, TGE - 1).toString(),
  '0',
)

// ---------------------------------------------------------------------------
// The game instructions — discriminators and account orders
// ---------------------------------------------------------------------------
// The site builds all five of the game's instructions and the program verifies
// them. If a discriminator or an account order shifts, the transaction is
// rejected — that is, the game stops completely.
//
// The discriminators come from sha256("global:<name>")[0..8]: if an
// instruction's NAME changes they change silently. The account order depends on
// the struct's field order too; inserting one field is enough.
//
// The vectors are pinned in the luck-game tests
// (oyun_talimat_ayiricilari_altin_vektore_uyuyor).
const game = await import(pathToFileURL(join(out, 'lib/luckGame.js')).href)

const OYUN_SISTEM = '11111111111111111111111111111111'
const OYUN_SLOTHASHES = 'SysvarS1otHashes111111111111111111111111111'
const player = new PublicKey('BDuECRxzgUQagisgJ8LAUx4zp1uH2ccouusK15sfvY36')
const treasury = new PublicKey('5Zvz25PheDtC9PaMzwDRcnb3xKS6CU8d98PfEnKkgp9m')
const delegate = new PublicKey('AHGDn3qqRyShYURf9qriMpVPHT8W6LwVTKUBXYMzuMxA')
const gameConfig = game.getConfigPda()
const gameVault = game.getVaultPda(gameConfig)
const playerState = game.getPlayerStatePda(player)

const oyunVektorleri = [
  {
    name: 'buy_spins',
    ix: game.buildBuySpinsIx(player, 3, treasury, delegate),
    data: '1e71e289a75d298403',
    accounts: [
      ['player', player.toBase58(), true, true],
      ['config', gameConfig.toBase58(), false, false],
      ['player_state', playerState.toBase58(), false, true],
      ['vault', gameVault.toBase58(), false, true],
      ['treasury', treasury.toBase58(), false, true],
      ['delegate', delegate.toBase58(), false, true],
      ['system_program', OYUN_SISTEM, false, false],
    ],
  },
  {
    name: 'register_delegate',
    ix: game.buildRegisterDelegateIx(player, delegate),
    data: 'da2d0c21c35959d0',
    accounts: [
      ['player', player.toBase58(), true, true],
      ['config', gameConfig.toBase58(), false, false],
      ['player_state', playerState.toBase58(), false, true],
      ['vault', gameVault.toBase58(), false, true],
      ['delegate', delegate.toBase58(), false, true],
      ['system_program', OYUN_SISTEM, false, false],
    ],
  },
  {
    name: 'play',
    ix: game.buildPlayIx(player, delegate),
    data: 'd59dc18ee438f896',
    accounts: [
      ['owner', player.toBase58(), false, false],
      ['authority', delegate.toBase58(), true, true],
      ['config', gameConfig.toBase58(), false, false],
      ['player_state', playerState.toBase58(), false, true],
      ['system_program', OYUN_SISTEM, false, false],
    ],
  },
  {
    name: 'resolve',
    ix: game.buildResolveIx(player, treasury),
    data: 'f696ecce6c3f3a0a',
    accounts: [
      ['player', player.toBase58(), false, true],
      ['config', gameConfig.toBase58(), false, false],
      ['player_state', playerState.toBase58(), false, true],
      ['vault', gameVault.toBase58(), false, true],
      ['treasury', treasury.toBase58(), false, true],
      ['slot_hashes', OYUN_SLOTHASHES, false, false],
      ['system_program', OYUN_SISTEM, false, false],
    ],
  },
  {
    name: 'forfeit_stuck_play',
    ix: game.buildForfeitStuckPlayIx(player),
    data: '46f69baf8c6f6989',
    accounts: [
      // `player` is NOT WRITABLE — on the program side there is no
      // `#[account(mut)]` on the `Signer<'info>`, because forfeit moves no
      // lamports at all (it only clears the pending flag). The account paying
      // the transaction fee already counts as writable at the transaction
      // level and does not need marking again in the instruction metadata.
      //
      // I first wrote `true` on this line; the check caught it, and looking at
      // the source showed that it was MY EXPECTATION that was wrong.
      ['player', player.toBase58(), true, false],
      ['config', gameConfig.toBase58(), false, false],
      ['player_state', playerState.toBase58(), false, true],
    ],
  },
]

for (const v of oyunVektorleri) {
  check(`game ${v.name}: instruction bytes`, Buffer.from(v.ix.data).toString('hex'), v.data)
  check(`game ${v.name}: account count`, v.ix.keys.length, v.accounts.length)
  for (let i = 0; i < v.accounts.length; i++) {
    const [name, address, isSigner, isWritable] = v.accounts[i]
    const k = v.ix.keys[i]
    check(`game ${v.name}: account ${i} ${name}`, k?.pubkey?.toBase58(), address)
    check(`game ${v.name}: account ${i} ${name} isSigner`, k?.isSigner, isSigner)
    check(`game ${v.name}: account ${i} ${name} isWritable`, k?.isWritable, isWritable)
  }
}


// --- Address-bar routing (deep linking) ------------------------------------
//
// The tabs lived only in React state and a presale link could not be shared.
// For a presale that is a serious gap: the address given in an announcement
// dropped the user on the "Create Token" tab.
//
// Whatever the user types into the address bar, the site MUST OPEN — a
// malformed hash must not give a blank screen. That is why unknown and
// malformed inputs are tested here too.
{
  const dl = await import(pathToFileURL(join(out, 'lib/deepLink.js')).href)
  const ROUTES = {
    pages: ['create', 'liquidity', 'privacy', 'solofluck'],
    defaultPage: 'create',
    subTabs: ['about', 'tokenomics', 'presale', 'claim', 'game'],
    defaultSubTab: 'about',
    subTabPage: 'solofluck',
  }
  const r = (h) => dl.routeFromHash(h, ROUTES)

  check('route: #solofluck/presale', JSON.stringify(r('#solofluck/presale')),
    JSON.stringify({ page: 'solofluck', subTab: 'presale' }))
  check('route: #liquidity', JSON.stringify(r('#liquidity')),
    JSON.stringify({ page: 'liquidity', subTab: 'about' }))
  check('route: an empty hash -> the default', JSON.stringify(r('')),
    JSON.stringify({ page: 'create', subTab: 'about' }))
  // Unknown inputs must not break the site.
  check('route: an unknown page -> the default', r('#yokboyle').page, 'create')
  check('route: an unknown sub-tab -> the default',
    r('#solofluck/yokboyle').subTab, 'about')
  check('route: tolerant of upper case', r('#SOLOFLUCK/PRESALE').page, 'solofluck')
  check('route: extra slashes', r('##solofluck//presale/').page, 'solofluck')
  // The sub-tab should only mean anything on its own page.
  check('route: a sub-tab on another page is ignored',
    r('#liquidity/presale').subTab, 'about')

  // Round trip: reading back the hash we wrote must land in the same place.
  let broken = []
  for (const page of ROUTES.pages) {
    for (const subTab of ROUTES.subTabs) {
      const h = dl.hashFromRoute(page, subTab, ROUTES)
      const back = r(h)
      const expectedSubTab = page === 'solofluck' ? subTab : 'about'
      if (back.page !== page || back.subTab !== expectedSubTab) {
        broken.push(`${page}/${subTab} -> ${h} -> ${back.page}/${back.subTab}`)
      }
    }
  }
  check('route: the round trip is consistent',
    broken.length === 0 ? true : `broken: ${broken.join(' · ')}`, true)

  // App.tsx and SoLofLuckPage.tsx carry the same routing definition; if they
  // drift apart, the tab and the address bar stop agreeing.
  const appSrc = readFileSync(`${repoRoot}src/App.tsx`, 'utf8')
  const sayfaSrc = readFileSync(
    `${repoRoot}src/components/solofluck/SoLofLuckPage.tsx`, 'utf8')
  const cikar = (src) => {
    const m = src.match(/const ROUTES = \{([\s\S]*?)\n\}/)
    return m ? m[1].replace(/\s+/g, ' ').trim() : null
  }
  check('route: App.tsx and SoLofLuckPage.tsx use the same definition',
    cikar(appSrc) !== null && cikar(appSrc) === cikar(sayfaSrc), true)
}

// --- The presale money gate ------------------------------------------------
//
// The presale is a plain wallet transfer: there is NO on-chain program to stop
// a contribution. So this single decision on the site is the ONLY thing that
// determines whether the presale is open or closed. It must not sit inside a
// component, untestable.
//
// `unscheduled` -> CLOSED is a deliberate change. Previously, with no schedule
// announced, the presale was left OPEN (on the grounds that "we are still
// testing"). The consequence was this: on launch day, removing the "Stay Tuned"
// gate while forgetting to fill in the date meant opening a presale to everyone
// with no date and no minted token behind it. Two separate checklist items
// being coupled like that is not acceptable.
{
  const presale = await import(pathToFileURL(join(out, 'lib/presale.js')).href)
  const k = (name, args, expected) =>
    check(`presale gate: ${name}`, presale.presaleClosedReason(args), expected)

  const open = { configured: true, targetReached: false, phase: 'live' }
  k('live and the target not filled -> OPEN', open, null)
  k('the wallet is not configured -> closed', { ...open, configured: false }, 'unconfigured')
  k('the target is filled (hard cap) -> closed', { ...open, targetReached: true }, 'reached')
  k('no schedule announced -> closed', { ...open, phase: 'unscheduled' }, 'unscheduled')
  k('not started yet -> closed', { ...open, phase: 'upcoming' }, 'upcoming')
  k('the period is over -> closed', { ...open, phase: 'ended' }, 'ended')

  // Precedence: when several reasons apply, the most serious must win.
  k(
    'not configured + target filled -> configuration wins',
    { configured: false, targetReached: true, phase: 'live' },
    'unconfigured',
  )
  k(
    'target filled + no schedule -> the target wins',
    { configured: true, targetReached: true, phase: 'unscheduled' },
    'reached',
  )

  // We also test that the gate REALLY does stay closed — that no combination
  // opens it by accident.
  let accidentallyOpen = []
  for (const configured of [true, false]) {
    for (const targetReached of [true, false]) {
      for (const phase of ['unscheduled', 'upcoming', 'live', 'ended']) {
        const r = presale.presaleClosedReason({ configured, targetReached, phase })
        if (r === null && !(configured && !targetReached && phase === 'live')) {
          accidentallyOpen.push(`${configured}/${targetReached}/${phase}`)
        }
      }
    }
  }
  check(
    'presale gate: only (configured + target not filled + live) is open',
    accidentallyOpen.length === 0 ? true : `accidentally open: ${accidentallyOpen.join(', ')}`,
    true,
  )
}

// --- PlayerState's byte layout: the site's REAL reader ---------------------
//
// The site reads this account with fixed offsets, without an IDL. Inserting one
// field is enough: TypeScript keeps reading from the same offsets and, without
// raising any error, shows the wrong spin count and the wrong winnings.
//
// The layout grew with the "rules at the moment the bet was placed" fields. The
// new fields were deliberately appended at THE END so the existing offsets do
// not shift — and that is exactly what this check verifies.
{
  const HEX = '38033c56ae10f4c309090909090909090909090909090909090909090909090909090909090909090b0000000300000001c1f4201d00000000fe0101110000000404040404040404040404040404040404040404040404040404040404040404002f685900000000010065cd1d0000000000ca9a3b00000000008c864700000000b80b3200e803d007'
  const fakeAccount = {
    getAccountInfo: async () => ({ data: Buffer.from(HEX, 'hex') }),
  }
  const playerKey = new PublicKey(Buffer.alloc(32, 9))
  let ps = null
  let playerStateError = null
  try {
    ps = await game.fetchPlayerState(fakeAccount, playerKey)
  } catch (e) {
    playerStateError = e instanceof Error ? e.message : String(e)
  }
  check(
    'PlayerState: the read raises no error',
    playerStateError === null ? true : `ERROR: ${playerStateError}`,
    true,
  )
  check('PlayerState: could be read', ps !== null, true)
  check('PlayerState: plays_count', ps?.playsCount, 11)
  check('PlayerState: wins_count', ps?.winsCount, 3)
  check('PlayerState: pending', ps?.pending, true)
  check('PlayerState: commit_slot', ps?.commitSlot, 488_699_073n)
  check('PlayerState: spins_remaining', ps?.spinsRemaining, 17)
  check('PlayerState: total_won', ps?.totalWonLamports, 1_500_000_000n)
  check('PlayerState: bonus_granted', ps?.bonusGranted, true)
  check(
    'PlayerState: delegate',
    ps?.delegate?.toBase58?.(),
    new PublicKey(Buffer.alloc(32, 4)).toBase58(),
  )
}

// --- The dice golden vector: do THE DOC and THE CODE say the same thing ----
//
// SECURITY.md describes how the dice is produced, so that players can verify a
// result for themselves. If that description is wrong, the document is worse
// than useless — it is HARMFUL: someone trying to verify finds a different
// number and concludes that "the game is rigged".
//
// And the description WAS wrong. The doc said `keccak`, while the game uses
// `solana_program::hash::hash`, i.e. SHA-256. (The distributor's merkle tree
// really does use keccak — the two had been conflated.) The error was found by
// someone reading the code from outside, not by my checks: I was checking
// commands and numbers, but not FORMULAS.
//
// The same vector now runs in three places at once — in the document (Python),
// in the Rust test (golden_dice_vector) and here. If the three disagree, CI
// fails.
{
  const { sha256 } = await import('@noble/hashes/sha2')

  const preimage = Buffer.concat([
    Buffer.from([...Array(32).keys()]), // slot_hash
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(488_699_073n); return b })(), // entropy_slot
    Buffer.alloc(32, 7), // player
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(5); return b })(), // plays_count
  ])
  check('dice vector: preimage length', preimage.length, 76)

  const digest = Buffer.from(sha256(preimage))
  check(
    'dice vector: digest',
    digest.toString('hex'),
    '3d54d1715c5d05dcfc12bb5dd95b197b078f3135b04aab6ead91103c1233cc6d',
  )
  check('dice vector: the dice', Number(digest.readBigUInt64LE(0) % 10_000n), 7_597)
  check('dice vector: the tier', Number(digest.readBigUInt64LE(8) % 10_000n), 4_556)

  // Does the description in the document use the same hash function as the code.
  const guvenlik = readFileSync(`${repoRoot}SECURITY.md`, 'utf8')
  const rust = readFileSync(
    `${repoRoot}program/luck-game/programs/luck-game/src/lib.rs`,
    'utf8',
  )
  const docSaysSha = /digest\s*=\s*sha256\(/.test(guvenlik)
  const codeUsesSha = /hash::hash\(&preimage\)/.test(rust)
  check('dice vector: the document says sha256', docSaysSha, true)
  check('dice vector: the code uses sha256', codeUsesSha, true)
  // The verification vector inside the document is read from the document too:
  // if one is updated and the other forgotten, it is caught.
  check(
    'dice vector: the digest in the document matches the code',
    guvenlik.includes(digest.toString('hex')),
    true,
  )
}

// --- The compute-limit decision ---------------------------------------------
//
// Because the priority fee is multiplied by the REQUESTED compute limit,
// blindly raising it to the ceiling makes every small transaction more
// expensive; but falling back to a small limit when no measurement is possible
// is wrong too — the "convert my balance into spins" flow can put up to 20
// buy_spins into one transaction and exceed 300,000. In that case the
// transaction fails on chain with "exceeded CUs" and the error the user sees
// explains none of it.
//
// I once got this decision WRONG (it fell back to 300,000 when the measurement
// failed), so the moment the RPC wobbled, the very bug it exists to fix came
// back. The decision now lives in a pure function and is tested here by calling
// the real code.
{
  const sendTx = await import(pathToFileURL(join(out, 'lib/sendTx.js')).href)
  const CEILING = 1_400_000
  const FLOOR = 300_000
  check('compute: no measurement -> THE CEILING', sendTx.computeUnitLimitFor(null), CEILING)
  check('compute: a measurement of 0 -> THE CEILING', sendTx.computeUnitLimitFor(0), CEILING)
  check('compute: a small transaction does not fall below the floor', sendTx.computeUnitLimitFor(10_000), FLOOR)
  // 400.000 × 1,3 = 520.000 — pay ekleniyor.
  check('compute: 30% headroom is added to the measurement', sendTx.computeUnitLimitFor(400_000), 520_000)
  check('compute: the ceiling is not exceeded', sendTx.computeUnitLimitFor(1_300_000), CEILING)
}

// --- The accounts' byte layout: the Claim tab's REAL readers ----------------
//
// The Claim tab reads the on-chain Distributor account with fixed offsets,
// without an IDL. Inserting one field into the struct is enough: TypeScript
// keeps reading from the same offsets and shows wrong values WITHOUT ANY ERROR
// — if merkle_root shifts, everyone gets "you are not on the list"; if start_ts
// shifts, the wrong schedule; if total_allocated shifts, nonsensical
// percentages. All of it on TGE day, at the moment when the chance to fix it is
// narrowest.
//
// The vectors were derived independently of Anchor's rules (the discriminator =
// sha256("account:<Name>")[0..8], the body = Borsh) and pinned on the Rust side
// `hesap_baytlari_altin_vektore_uyuyor` ile sabitlendi.
{
  const fakeAccount = (hex) => ({
    getAccountInfo: async () => ({ data: Buffer.from(hex, 'hex') }),
  })

  const DAGITICI_HEX = '5a5ad993062087040700000000000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303040404040404040404040404040404040404040404040404040404040404040400c8d99bbf2f00000052f21f4c04000000d2496b000000008403bc02803a0900000000000d00fe'
  const DURUM_HEX = '16b7f99df75f96600052f21f4c040000fd'

  // If an offset shift runs past the end of the account, the read THROWS
  // (ERR_OUT_OF_RANGE). That is a failure too, but a crash that explains
  // nothing; we catch it and turn it into a proper check line.
  let distributor = null
  let distributorError = null
  try {
    distributor = await claim.fetchDistributor(fakeAccount(DAGITICI_HEX), 0)
  } catch (e) {
    distributorError = e instanceof Error ? e.message : String(e)
  }
  check(
    'account Distributor: the read raises no error',
    distributorError === null ? true : `ERROR: ${distributorError}`,
    true,
  )
  check('account Distributor: could be read', distributor !== null, true)
  check(
    'account Distributor: merkle_root',
    Buffer.from(distributor?.merkleRoot ?? []).toString('hex'),
    '04'.repeat(32),
  )
  check('account Distributor: total_allocated', distributor?.totalAllocated, 52_500_000_000_000n)
  check('account Distributor: total_claimed', distributor?.totalClaimed, 4_725_000_000_000n)
  check('account Distributor: start_ts', distributor?.startTs, 1_800_000_000)
  check('account Distributor: cliff_bps', distributor?.cliffBps, 900)
  check('account Distributor: period_bps', distributor?.periodBps, 700)
  check('account Distributor: period_seconds', distributor?.periodSeconds, 604_800)
  check('account Distributor: periods', distributor?.periods, 13)
  // Does the schedule we read really close at 100% — with the numbers from the chain.
  check(
    'account Distributor: cliff + tier x rate = 100%',
    (distributor?.cliffBps ?? 0) + (distributor?.periods ?? 0) * (distributor?.periodBps ?? 0),
    10_000,
  )

  let claimed = null
  let claimStatusError = null
  try {
    claimed = await claim.fetchClaimed(fakeAccount(DURUM_HEX), 0, claimant)
  } catch (e) {
    claimStatusError = e instanceof Error ? e.message : String(e)
  }
  check(
    'account ClaimStatus: the read raises no error',
    claimStatusError === null ? true : `ERROR: ${claimStatusError}`,
    true,
  )
  check('account ClaimStatus: claimed', claimed, 4_725_000_000_000n)
}

// --- The events' byte layout: the site's REAL parsers -----------------------
//
// The site does not read the game's result from the chain; it parses the event
// in the transaction's logs. If the event's field ORDER shifts — inserting one
// field is enough — TypeScript keeps reading from the same offsets and shows
// wrong values WITHOUT ANY ERROR: "you won" on a losing round, a different
// figure for the prize. Because the transaction is not rejected, no trace is
// left on the chain or in the logs.
//
// The vectors were derived independently of Anchor's rules (the discriminator =
// sha256("event:<Name>")[0..8], the body = Borsh) and pinned on the Rust side by
// the `event_bytes_match_golden_vector` test. Here we hand the same bytes to the
// REAL parsers and read them back — writing a copy of a parser would prove that
// the copy agrees with itself.
{
  // The parsers fetch a transaction from a Connection; a fake connection is
  // enough, because what we are testing is byte reading, not the network.
  const sahteBaglanti = (hex) => ({
    getTransaction: async () => ({
      meta: {
        logMessages: [
          'Program H6gnAvLa5o2JtjfdgyKdZy2eC9bjnMerCcbxjYZeKdnf invoke [1]',
          `Program data: ${Buffer.from(hex, 'hex').toString('base64')}`,
          'Program H6gnAvLa5o2JtjfdgyKdZy2eC9bjnMerCcbxjYZeKdnf success',
        ],
      },
    }),
  })

  const OYUNCU_HEX = '07'.repeat(32)

  const resolved = await game.parsePlayResolvedFromTx(
    sahteBaglanti(
      `8cb617b4df501e9d${OYUNCU_HEX}01d20296490000000000012a9ab70e00000000`,
    ),
    'forged-signature',
  )
  check('event PlayResolved: could be read', resolved !== null, true)
  check('event PlayResolved: won', resolved?.won, true)
  check('event PlayResolved: prize_paid', resolved?.prizePaidLamports, 1_234_567_890n)
  check('event PlayResolved: is_big_win', resolved?.isBigWin, false)
  check('event PlayResolved: easy_mode', resolved?.easyMode, true)
  check('event PlayResolved: ops_fee_paid', resolved?.opsFeePaidLamports, 246_913_578n)

  const committed = await game.parsePlayCommittedFromTx(
    sahteBaglanti(`0f6a7973baf30b2c${OYUNCU_HEX}0b0000001600000001cedf201d00000000`),
    'forged-signature',
  )
  check('event PlayCommitted: could be read', committed !== null, true)
  check('event PlayCommitted: plays_count', committed?.playsCount, 11)
  check('event PlayCommitted: spins_remaining', committed?.spinsRemaining, 22)
  check('event PlayCommitted: bonus_granted', committed?.bonusGranted, true)
  check('event PlayCommitted: commit_slot', committed?.commitSlot, 488_693_710n)

  const purchased = await game.parseSpinsPurchasedFromTx(
    sahteBaglanti(`c39218f3ce200ed2${OYUNCU_HEX}03140000000008af2f0000000017000000`),
    'forged-signature',
  )
  check('event SpinsPurchased: could be read', purchased !== null, true)
  check('event SpinsPurchased: tier_index', purchased?.tierIndex, 3)
  check('event SpinsPurchased: spin_count', purchased?.spinCount, 20)
  check('event SpinsPurchased: price_lamports', purchased?.priceLamports, 800_000_000n)
  check('event SpinsPurchased: spins_remaining', purchased?.spinsRemaining, 23)

  // If the discriminator does NOT match, the event must not be read — otherwise
  // another event's bytes would be taken for PlayResolved and misdecoded.
  const foreignDiscriminator = await game.parsePlayResolvedFromTx(
    sahteBaglanti(`0f6a7973baf30b2c${OYUNCU_HEX}01d20296490000000000012a9ab70e00000000`),
    'forged-signature',
  )
  check('event PlayResolved: a foreign discriminator is rejected', foreignDiscriminator, null)
}

rmSync(out, { recursive: true, force: true })

for (const c of checks) {
  const mark = c.ok ? '✓' : '✗'
  const detail = c.ok ? '' : `  (expected ${c.expected}, gelen ${c.actual})`
  console.log(`${mark} ${c.name}${detail}`)
}
if (failures.length > 0) {
  console.error(
    `\n${failures.length} MISMATCH(ES) — the client and the program speak different bytes. ` +
      'As it stands, no claim would go through on TGE day.',
  )
  process.exit(1)
}
console.log(`\nAll ${checks.length} checks passed — the client and the program speak the same ABI.`)
