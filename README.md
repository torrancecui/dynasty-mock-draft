# Dynasty Mock Draft Simulator

https://torrancecui.github.io/dynasty-mock-draft/

A Sleeper-style dynasty startup mock draft web app. You draft against CPU teams
that pick from real dynasty rankings — **superflex, 0.5 TE premium** across the board.

## Run it

```sh
node scripts/serve.js        # serves at http://localhost:8642
```

(Any static file server works — it's plain HTML/CSS/JS, no build step.)

## Features

- **CPU ranking sources** (selectable on the setup screen):
  - **KeepTradeCut** — LIVE: scraped superflex values with KTC's native 0.5 TE premium (TEP)
  - **FantasyPros** — LIVE: dynasty superflex expert consensus rankings, with a +9% TE value
    adjustment applied to approximate 0.5 TE premium (FP doesn't publish a TEP variant)
  - **FantasyCalc** — LIVE: dynasty 2QB market values computed from real trades
    (public API), same +9% TE-premium adjustment
  - **ESPN** — APPROX: ESPN has no machine-readable dynasty SF rankings, so this is a
    labeled approximation blended from the live sources (35% KTC / 65% FP) with a
    proven-production lean and deterministic jitter
  - **Sleeper** — APPROX: Sleeper has no public rankings API; approximation blended
    60% KTC / 40% FP with a youth/rookie lean
  - **Mixed** — each CPU team is randomly assigned one of the four sources
- League settings: 8/10/12/14 teams, 5–30 rounds, snake / linear / 3rd-round-reversal (default),
  pick your slot or randomize, CPU speed (instant / fast / realistic)
- Sleeper-style draft room: pick ticker, color-coded draft board, searchable/filterable
  player pool (view any source's board), My Team + All Teams roster views
- CPU AI: value-based picks with randomness, per-team positional tendencies, and
  superflex-aware roster construction (every CPU lands 2–3 QBs, capped TE/RB/WR depth)
- Autopick toggle for your own picks
- End-of-draft summary ranked by total KTC market value + CSV export

## Refreshing the rankings

Player data is baked into `rankings-data.js` (generated 2026-07-12). To refresh
KTC + FantasyPros to today's values:

```sh
node scripts/build-data.js
```

This re-scrapes both sites, re-derives the ESPN/Sleeper approximations, and
rewrites `rankings-data.js`. If either site changes its page structure, the
script fails loudly rather than writing bad data.

## Files

- `index.html` / `styles.css` / `app.js` — the app (no dependencies)
- `rankings-data.js` — generated player pool (574 players incl. 2026 rookies)
- `scripts/build-data.js` — data pipeline (fetch + merge + rank)
- `scripts/serve.js` — tiny static server for local play
