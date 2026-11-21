[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ShinoNC/token-radar-01-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ShinoNC/token-radar-01-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Radar — radar-7

A token launch radar for make.fun's token-radar-01: it ranks the 198
pre-token protocols in a sealed DefiLlama snapshot by implied value and gives
each a concrete farm plan. The board covers all 40 watchlist protocols.

radar-7 keeps radar-6's model and board exactly. The change is the
dashboard's presentation, per the judge's feedback on radar-6 ("B's
screenshots read worse than A's"): larger, brighter type, a tighter header
so the board shows three full rows in the first viewport, a model sandbox
that re-ranks the board live as you move the coefficients, and four
screenshots (the board, a detail view, the sandbox, a farm plan).

## The model

**Value.** A size curve fitted to the snapshot's own 87 live-token
comparables: `value = 10^(3.1502 + 0.4870 x log10(TVL) + offset(category))`,
with category offsets shrunk toward the board (k=8), a growth multiplier from
7d change, and a maturity multiplier from age. Leave-one-out median miss
x2.60, 5-fold x2.55, time-split x2.15; 51.7% of comparables within x3.

**Odds.** A logistic regression on the 442 rankable protocols, target
"records a token": log10 TVL, chain count, the category's token rate, and the
age bucket's token rate (each shrunk toward the base rate, k=8). The token
rate by age is not monotone — 31% under 90 days, 19% at 90–180 days, 86%
past 3 years — so the model reads the rate of the protocol's own age bucket,
not a linear age term. Leave-one-out accuracy **72.0%** against a 55.2% base
rate (every feature refit per fold).

**Implied value** is value x odds, with a prediction band per row. Out of
sample, 45% of comparables fall inside their row's P25–P75 band (nominal
50%) and the P10–P90 band holds 78% (nominal 80%).

**Farm plans.** Six steps per protocol, each with a cost and a time, derived
from the protocol's own record (category, chains, TVL, age) — never a
hand-written list, never a promised airdrop.

**Sandbox.** Five sliders (curve intercept, curve slope, growth weight, odds
shift, category offset scale) re-score all 198 rows through the same
valueOf/oddsOf that score the board and show the live top 10 with rank
moves. At offset scale 0 — category offsets removed — 147 of 198 rows move
5 or more ranks, and Veda takes the top spot from USDD.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22, stdlib only, no network. Writes `board.json`, `data.js`, a static
`dashboard/`, four screenshots and `dossier.json`. Two runs write identical
bytes. The dashboard recomputes the model from the snapshot figures and
checks every number `board.json` carries (198/198 match).

## Layout

- `main.ts` — entrypoint: reads the snapshot, scores the board, writes the output
- `lib/model.ts` — the value + odds models, the backtest, the farm plans
- `dashboard/` — the static page (index.html, app.css, app.js)
- `screenshots/` — the four board screenshots the judge reads
- `vendor/makefun-board.ts` — the dossier builder (from the kit)
