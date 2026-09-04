# TGE Runbook

This file describes what to do on token generation day (TGE), **in order**.

Why it exists: even when the code is correct, getting the order of the steps
wrong is just as bad. This knowledge used to be scattered across commit
messages; on a day when everyone is in a hurry, nobody reads commit history.

**The general rule:** every step has a VERIFY line. Do not move to the next step
until the verification passes. Irreversible steps are marked
`⚠️ IRREVERSIBLE`.

---

## 0. Readiness check

```bash
npm run check:launch
```

Lists the missing fields. Do not launch until they are all ✓. The hard gate:

```bash
npm run launch-gate    # exit code 1 if anything is missing
```

---

## 1. Create the $LUCK mint

From the site (the "Create Token" tab) or with your own tooling.

- **Decimals: 9.** Every calculation assumes this. If you change it,
  `DEFAULT_DECIMALS` and the distribution amounts have to change too.
- Total supply: **777,000,000**

Write the mint address into `src/config.ts` -> `LUCK_TOKEN.mint`.

**Verify:** `npm run check:launch` -> "$LUCK mint address" ✓

---

## 2. Announce the presale date

`src/config.ts` -> `PRESALE_START_ISO` (UTC, e.g. `2026-09-01T12:00:00Z`).

> If left empty the presale stays **open indefinitely**: no countdown appears
> and it never closes when the time comes. A silent error — nobody notices.

**Verify:** does the countdown appear on the site's Presale tab?

---

## 3. Extract the buyer list once the presale ends

```bash
RPC_URL=<mainnet-rpc> node scripts/presale-buyers.mjs > buyers.json
```

The list is read **from the chain**; we hold no separate record, and we do not
need to. Buyers can run the same command and verify their own share
independently of us.

**Verify:**
- Does `totals.sol` in `buyers.json` match the total received by the presale
  wallet?
- Does every record have both `tokens` (whole tokens) and `baseUnits` (the
  smallest unit)? If `baseUnits` is missing, the list was produced by an older
  version.

The presale ending IS TGE. Write the exact moment into `src/config.ts` ->
`TGE_ISO`, then run:

```bash
node scripts/raffle-schedule.mjs --generate --out public/raffle-schedule.json
```

This computes all 14 raffle rounds' due dates from `TGE_ISO` and
`RAFFLE.firstRoundDay`/`intervalDays`, and publishes them on the Tokenomics
tab under "Raffle Schedule" — each with a ready-to-copy public-announcement
line for that round, ahead of picking its slot. Commit and push
`public/raffle-schedule.json` together with the config change.

---

## 4. Build the merkle tree

```bash
node scripts/build-merkle.mjs buyers.json > public/merkle/round-0.json
```

**Verify:**
- Does `total` in the output match `totals.baseUnits` in `buyers.json`?
- Does `count` match the number of buyers?

Publish the file together with the site — the Claim tab reads it from there and
compares its root against the one on chain.

---

## 5. Open the distribution round ⚠️ IRREVERSIBLE

A **REHEARSAL** first:

```bash
DRY_RUN=1 \
PROGRAM_ID=<claim-program> MINT=<luck-mint> ROUND_ID=0 \
MERKLE_FILE=public/merkle/round-0.json \
START_ISO=<TGE-time> CLIFF_BPS=900 PERIOD_BPS=700 PERIODS=13 \
node program/luck-distributor/scripts/initialize-round.mjs
```

Read **every printed line**: the total amount, the root, the start time, the
schedule. Once these values are written to the chain they **cannot be changed**
— the program deliberately has no update instruction.

If they are right, drop `DRY_RUN=1` and run it.

The script ends by verifying that the vault balance is **exactly equal** to the
total in the list. If it is short, the last claimants cannot withdraw; if it is
over, the excess stays locked forever.

**Verify:** the line "Done. Exactly N tokens are locked in the vault." must
appear.

---

## 6. The weekly raffles

For each round, announce a slot number **before** the draw — and word the
announcement like this:

> *"Round 18 will be drawn with the hash of **the first block at or after slot
> 412,900,000**."*

The "**at or after**" part is mandatory. On Solana a slot **can be skipped**: if
that slot's leader produces no block, there is no block at that number and no
hash for it (1-5% on mainnet, 5-15% on devnet). If you bind the announcement to
a single slot, a skip leaves you unable to run the draw and forces you to
**pick a new slot** — that is, you gain a choice that could influence the
result, and your "we did not interfere" claim collapses exactly there.

The script already enforces this as a rule: if the announced slot was skipped it
uses the first real block after it, prints which one it used, and puts both
`announcedSlot` (announced) and `slot` (actually used) separately into the
output. **Do not change the slot choice by hand** — changing the rule destroys
the verifiability.

Before the draw, fill this round's 3 hand-picked winners from that week's
Twitter/X campaign into `data/twitter-winners.json` (see `data/README.md`) —
this file is meant to be editable directly on GitHub, by whoever is running
the raffle that week, without needing the codebase or an AI session open.

**The whole rest of this step — draw, merge, publish, lock — runs as one
GitHub Actions workflow:** *Actions → Raffle — Draw, Publish and Lock a
Weekly Round → Run workflow*. Fill in the round id and the slot you already
announced; leave `dry_run` at its default (`true`) first. A rehearsal draws
the round and attaches the result as a downloadable Artifact on the run,
without publishing it to the site or writing anything to chain. Once you have
checked it, run the workflow again with `dry_run: false` — that run publishes
`round-N.json` to the site and, immediately after, locks the round on chain
with `initialize-round.mjs`, using the `LUCK_GAME_DEPLOY_KEY` secret so the
key never has to leave GitHub.

The equivalent by hand, if the workflow is ever unavailable:

```bash
RPC_URL=<mainnet-rpc> node scripts/presale-buyers.mjs > buyers.json
node scripts/draw-raffle.mjs --buyers buyers.json --slot <slot> --winners 7 > winners-ticket-1.json
node scripts/combine-raffle-winners.mjs --ticket-winners winners-ticket-1.json --round 1 > winners-1.json
node scripts/build-merkle.mjs --amount $(node scripts/raffle-amount.mjs) winners-1.json > public/merkle/round-1.json
```

`combine-raffle-winners.mjs` merges the 7 on-chain ticket winners with the 3
Twitter winners from `data/twitter-winners.json`, and refuses to run if that
round is not exactly 3 valid, unique addresses that did not already win the
ticket half — catching a hand-entry mistake here, not after it is locked
on-chain. `raffle-amount.mjs` prints the per-winner prize in **the smallest
unit** (1,110,000 $LUCK x 10⁹) straight from `RAFFLE.perWinnerTokens` and
`DEFAULT_DECIMALS`, so this command can't drift from the config the way a
hardcoded number could.

Then commit and push the published `public/merkle/round-1.json`, and open the
round as in step 5 — except that a raffle schedule is a single item:
`CLIFF_BPS=10000 PERIOD_BPS=0 PERIODS=0`.

**Verify:** with the same `buyers.json` and the same **announced** slot, anyone
must be able to reproduce the same winners — even if the announced slot was
skipped, because the "first block at or after" rule is deterministic. Publish
the `howToVerify` line from `winners-1.json` together with the `announcedSlot`
and `slot` fields.

---

## 7. Switch to mainnet

Flipping the site to mainnet is NOT one line. A Solana program address is per
network: the IDs in `src/config.ts` hold programs on devnet and **nothing at all
on mainnet**. Point the site at mainnet without redeploying and every game and
claim transaction fails — for everyone, on TGE day, with nothing in the build or
the tests complaining. The order below is what stops that.

**7a. Deploy both programs to mainnet.** Run `luck-game — Build and Deploy` and
`luck-distributor — Build and Deploy` with `network: mainnet-beta`,
`first_deploy: true`, and `confirm_mainnet` typed out in full. This spends real
SOL: about 2.3 SOL of permanent rent per program, plus the same again as a
buffer while the deploy runs. The deploy wallet needs roughly 5 SOL per program
— there is no faucet on mainnet.

> The deploy key used so far is a devnet key (see `LUCK_GAME_DEPLOY_KEY`). Put a
> real key in that secret before this step, and treat its upgrade authority as
> what it is: whoever holds it can replace both programs.

**7b. Write the printed Program IDs into the repository.** Each first deploy
prints a new ID. It has to go into `declare_id!()`, `Anchor.toml`,
`GAME_CONFIG.programId` / `CLAIM_CONFIG.programId` in `src/config.ts`, and the
two checkers that pin it (`check-tokenomics`, `check-abi`) — all in one commit.
`npm run verify` fails if any of them is left behind.

**7c. Initialize both programs on mainnet.** Run the two Initialize workflows
with `network: mainnet-beta` and the new Program IDs.

**7d. Only now move the two network constants** in `src/config.ts`:

```
DEFAULT_NETWORK            = 'mainnet-beta'
PROGRAM_DEPLOYMENT_NETWORK = 'mainnet-beta'
```

The spelling is `'mainnet-beta'`, not `'mainnet'` — the latter is not a
`NetworkId` and `tsc -b` fails the build on it.

**Verify:** `npm run launch-gate` exits with code 0. It refuses while the two
constants disagree, which is what a half-finished move looks like.

---

## If something goes wrong

| Symptom | Cause | What to do |
|---|---|---|
| Claim says "distribution has not started yet" | `LUCK_TOKEN.mint` or `CLAIM_CONFIG.programId` is empty | Step 1 and `check:launch` |
| The Claim screen says "the list does not match the chain" | `public/merkle/round-N.json` differs from the root on chain | The published file is stale; repeat step 4 and update the file |
| Everyone's claim is rejected | The client and the program speak different ABIs | `npm run check:abi` |
| Buyers received a billionth of their tokens | Whole tokens were used in the merkle leaf | `baseUnits` must be used; `build-merkle --selftest` catches this |
| A program upgrade says "account data too small" | The on-chain space is insufficient | The deploy workflow extends it automatically; check the balance is enough |
| Deploy says "insufficient funds for spend" | No money for the buffer rent (roughly the program's size) | Send SOL to the deploy wallet |

---

## Decisions that will not change

These are deliberate; do not mistake them for gaps and "fix" them:

- **The claim program has NO "withdraw the money back" instruction.**
  Unclaimed tokens stay locked forever, which effectively burns them. A buyer
  being able to say "nobody can take this back from us" is worth more than the
  team being able to collect the remainder.
- **There is NO withdraw instruction on the game vault.** The team cannot empty
  the game vault.
- **The root, the schedule and the total cannot be changed after initialize.**
- **The ticket count is computed from the real amount reaching the wallet, not
  from the memo.** A memo is text written by the sender and can be faked.
