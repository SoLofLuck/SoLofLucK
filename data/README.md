# `twitter-winners.json`

The 3 Twitter/X raffle winners for each of the 14 weekly rounds, entered by
hand — this is the one part of the raffle that cannot be verified from the
chain (see the comment on `RAFFLE.twitter` in `src/config.ts` for why it is
kept separate from the 7 on-chain ticket winners).

This file is meant to be editable **directly on GitHub**, without a working
copy of the project and without Claude: open the file in the GitHub web
editor, fill in a round's array, commit. That is deliberate — the round can
still be run even if nobody who knows the codebase is reachable that week.

## Format

```json
{
  "1": ["<wallet address>", "<wallet address>", "<wallet address>"],
  "2": []
}
```

- Keys are round numbers as strings, `"1"` through `"14"` (`RAFFLE.rounds` in
  `src/config.ts`).
- Each value is an array of **exactly 3** Solana wallet addresses
  (`RAFFLE.twitter.winnersPerRound`) once that round's winners are picked from
  the week's Twitter/X campaign — base58, the same format shown in a wallet or
  on Solscan. Leave a round as `[]` until it is ready.
- No duplicate addresses within the same round, and none that also won that
  round's ticket raffle — `scripts/combine-raffle-winners.mjs` rejects both
  before anything reaches the chain.

## How it is used

Before building a round's merkle file (`TGE-RUNBOOK.md`, step 6), the 3
addresses here are combined with the 7 ticket-raffle winners:

```bash
node scripts/draw-raffle.mjs --buyers buyers.json --slot <slot> --winners 7 > winners-ticket-1.json
node scripts/combine-raffle-winners.mjs --ticket-winners winners-ticket-1.json --round 1 > winners-1.json
node scripts/build-merkle.mjs --amount 1110000000000000 winners-1.json > public/merkle/round-1.json
```

`combine-raffle-winners.mjs` refuses to run if a round's array does not have
exactly 3 valid, unique addresses — better to fail here than to lock the
wrong amount into an irreversible on-chain round.
