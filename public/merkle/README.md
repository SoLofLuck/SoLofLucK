# Distribution lists

The `round-<id>.json` files in this folder are the public counterpart of the
merkle root the claim program has written to the chain:

| id | What |
|----|----|
| 0 | The presale allocations (9% at TGE, then 7% weekly for 13 weeks) |
| 1–14 | The winners of the weekly ticketed raffles |

## Why are these public?

The point of the merkle tree here is not privacy but **verifiability**. Only a
32-byte root sits on the chain; the buyer brings the proof of their allocation.
Because the list is public:

- Everyone can see their own allocation
- Nobody can be added to the list after the fact (the root would change and would
  no longer match the one on chain — the site notices that and blocks the claim)
- And we cannot quietly change anyone's allocation either

## How is it produced / how can you verify it?

```bash
# 1) Extract the buyer list from the chain (the presale vault's transaction history)
RPC_URL=<rpc> START_ISO=<presale start> END_ISO=<presale end> \
  node scripts/presale-buyers.mjs > buyers.json

# 2) Build the merkle tree
node scripts/build-merkle.mjs buyers.json > public/merkle/round-0.json
```

You can run those same two commands yourself and compare the result with the file
here — if the root matches, the list is correct. You do not have to trust us.

For raffle rounds the winning addresses are put into a plain text file:

```bash
node scripts/build-merkle.mjs --amount <amount per winner> winners.txt \
  > public/merkle/round-1.json
```
