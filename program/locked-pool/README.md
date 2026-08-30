# locked-pool

A simple constant-product (x*y=k) liquidity pool program under our own control.
**The purpose:** to implement the rule "buying is always open, selling is closed
to everyone for a given period" — which no DEX such as Raydium, Orca or Meteora
will accept — in a program we wrote ourselves and control completely.

Why a separate program was needed (in short): Raydium, Orca and Meteora all
reject Token-2022's Transfer Hook extension at the pool creation stage — simply
because the extension type is present, regardless of what logic it contains. That
is an unavoidable restriction, proven at the code level. The detailed research is
in the conversation history.

## How it works

- `initialize_pool(duration_seconds, sol_amount, token_amount)`: creates the pool
  and deposits the initial liquidity. `duration_seconds` is added to the current
  time and recorded **permanently** as `unlock_ts`. There is no instruction that
  would change it — nobody, the creator included, can shorten, extend or cancel
  the period.
- `swap_buy`: SOL → Token. Always open, regardless of the lock state.
- `swap_sell`: Token → SOL. The lock counts as open if and only if `Clock::now >=
  pool.unlock_ts` (automatically) OR `pool.manually_unlocked == true` (an early
  opening) — whichever happens first. Both are read from the single, global `pool`
  account; whoever sends this instruction, and whenever they send it, sees the
  same result at the same moment.
- `unlock_now`: opens the lock before its time, once and **permanently**. Only
  `pool.creator` can call it (enforced with `has_one`). Once it is `true` there is
  no way back to `false` — a partial or selective opening (yes for some accounts,
  no for others) is impossible, because `swap_sell` reads it from that single
  global flag.
- `add_liquidity` / `remove_liquidity`: standard adding and removing of liquidity,
  independent of the lock (a proportional share in exchange for LP tokens).

Note: `unlock_now` reintroduces a trust dependency on the creator (if they never
press the button, the lock simply opens automatically at `unlock_ts` — there is no
risk of staying locked indefinitely, because the automatic period always runs in
the background). The creator may choose never to use it; it is an entirely
optional "open early" mechanism.

## Deploy status

Not deployed yet. As with the sell-lock program, it will be deployed to Devnet
through Solana Playground (https://beta.solpg.io) — network access to `crates.io`
and `release.anza.xyz` is blocked in this environment, so `anchor build` and
`solana program deploy` cannot be run locally.

After the deploy, the placeholder program ID in `declare_id!(...)` will be updated
with the real address and the `[programs.devnet]` entry in `Anchor.toml` will be
matched to it.
