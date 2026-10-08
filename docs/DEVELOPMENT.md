# Development guide

Reference for running, configuring and extending JH AI Observatory. For an overview, see the [README](../README.md).

## Commands

| Command | What it does |
|---|---|
| `node observatory.js ingest [--source <name>] [--prune]` | Run all enabled sources (or just one) and merge into the store. `--prune` also drops stored turns those sources no longer produce — opt-in, because rotated-away local logs would otherwise be lost, and it forces a full re-scan |
| `node observatory.js serve [--port <n>] [--no-ingest]` | Start the local dashboard + JSON API. Auto-collects on start and on a timer; `--no-ingest` serves the stored snapshot as-is |
| `node observatory.js stats [--granularity daily\|weekly\|monthly]` | Terminal summary |
| `node observatory.js sources` | List registered sources |
| `--config <path>` | Use an alternate `config.json` |

## Configuration (`config.json`)

`config.json` is created from `config.example.json` the first time you run the
CLI or the launcher. It holds local paths, so it is git-ignored.

- `sources.<name>.enabled` — turn a source off.
- `sources.claude-code.projectsDir` — override the Claude Code transcript folder
  (`null` = auto-detect `~/.claude/projects`).
- `pricingOverrides` — override or add model prices, USD per 1M tokens. See
  `src/core/pricing.js` for the built-in table and shape.
- `server.port` / `server.host` / `server.autoIngestMinutes`.
- `projectRoots` — optional code-container folders to track for Claude Code and
  Codex. The root itself is excluded; its first child folder is the project name.

Paths may be absolute, relative to `config.json`, or start with `~`.

## Detection directories in Settings

Open Settings → Detection directories. Enter a project container path, click
**Add directory**, and repeat to build a list. Check one or more directories and
click **Save & collect**. Paths may be absolute, relative to the configuration
file, or start with `~/`. Selected directories must exist.

The first folder below each selected directory is treated as a project. Settings
persist in `projectRoots`; the complete list, including unchecked paths, persists
in `availableProjectRoots`. Saving applies without restarting and re-reads logs
when the selection changes. The dashboard statistics, records, and filter options show only projects under
the selected directories. Other history is retained in the store but hidden.
Without configured directories, collection is paused and the dashboard prompts
you to add directories. Existing history is hidden until a directory is selected. With
`--no-ingest`, saving updates configuration but does not collect usage.

## Codex

Nothing to set up — `ingest` reads `~/.codex/sessions` automatically (or
`$CODEX_HOME/sessions`). Override with `sources.codex.sessionsDir`.

Preview/internal model ids (e.g. `gpt-5.6-sol`) have no public price, so their
cost shows as **unpriced**. Add a rate to get cost:

```jsonc
"pricingOverrides": {
  "gpt-5.6-sol": { "input": 1.25, "output": 10, "cacheRead": 0.125 }
}
```

then re-run `ingest`.

## How API value* is computed

`API value* = measured tokens × configured rate`, from the table in
`src/core/pricing.js` (`pricingOverrides` wins). Anthropic cache tokens use the
standard multipliers (read 0.10×, 5-minute write 1.25×, 1-hour write 2.00× of the
input rate) and the 5m/1h split is read from the transcript when present; non-
Anthropic models are not charged an implicit cache-write premium.

- Only **measured + priced** turns contribute.
- A model **not in the table** → `Unpriced`, never `$0`.
- No token data → `—`, never `0`.
- Flat per-token rates only: large-request tiers (e.g. OpenAI's higher rate above
  272K input tokens in one request) are **not** modeled.
- These are reference API rates, not your subscription charge.

The dashboard's **Model pricing** card lists the effective rates (details behind
the ⓘ), and its **API cost calculator** (collapsed) prices a hypothetical request:
type token counts (`100k`, `1.5m`, `250000` all work), or hit *Use current usage*
to load the filtered totals. The **Breakdown** table is collapsed by default.

## Freshness and performance

Ingest is **incremental**: every source file is fingerprinted by `{ mtimeMs, size }`
in the store, and unchanged files are skipped entirely, so a refresh only parses
logs that changed since the last run. The server keeps the
parsed store in memory and re-reads it only when the file changes, so filtering
doesn't re-parse megabytes of JSON.

The fingerprints live **inside** `data/store.json`, so the two can never drift:
delete the store and the cache resets with it. A source that throws mid-run keeps
none of its fingerprints, and `--prune` forces a full re-scan.

Tune with `config.json → server.autoIngestMinutes` (`0` = off), or start with
`--no-ingest` to serve the stored snapshot untouched.

## Data model

`data/store.json` is a flat, human-readable list of `UsageRecord`s. One record =
one assistant turn:

A **measured** turn (CLI/API):

```jsonc
{
  "id": "claude-code:msg_01…",        // stable dedupe key "<source>:<nativeId>"
  "source": "claude-code",
  "timestamp": "2026-08-27T11:45:20.898Z",
  "model": "claude-sonnet-5",
  "modelMeasured": true,              // the model id came from the provider's logs
  "pricingModel": "claude-sonnet-5",  // whose rates produced `cost`
  "tokenAvailability": "measured",    // real counts, not a guess
  "session": "00000000-…",
  "tokens": { "input": 2, "output": 1328, "cacheRead": 24025, "cacheWrite": 9297, "total": 33652 },
  "cost": { "amount": 0.0721, "currency": "USD", "estimated": false },
  "measured": true,
  "meta": { "project": "side-project", "gitBranch": "HEAD", "thinkingTokens": 397 }
}
```

The schema contract is `src/core/schema.js`. Missing token data and unpriced
models remain distinct from measured zero usage.

## Architecture

```
observatory.js            CLI entry (ingest / serve / stats / sources)
config.example.json       template for config.json (paths, pricing overrides, server)
src/
  core/
    schema.js             UsageRecord shape + validation
    store.js              load / merge / prune / save the JSON store (swap point for SQLite)
    pricing.js            model → price table + cost math
    aggregate.js          filtering + daily/weekly/monthly rollups
    util.js               path / date helpers
  sources/
    index.js              source registry
    claude-code.js        Claude Code transcripts       (measured)
    codex.js              Codex rollout transcripts     (measured)
  ingest.js               orchestrates a collection run
  server.js               zero-dep HTTP: static dashboard + read-only JSON API
  settings.js             config bootstrap + Settings → detection directories
  insights.js             re-exports the browser insights client for tests/CLI
  mock.js                 generated demo data for --mock
test/                     node:test suite — run with `npm test`
web/                      dashboard (vanilla JS, hand-rolled SVG charts, no CDN)
```

Daily and weekly buckets use the **host machine's local timezone**.

### Tests

```bash
npm test        # node --test test/ — no dependencies
```

Covers the logic that fails silently rather than loudly: ISO-week bucketing across
a year boundary, the Codex cumulative-counter delta and its reset case, cache-tier
pricing for both providers, store dedupe/prune, and handling of missing token data.

### Adding a new platform

1. Create `src/sources/<platform>.js` exporting:

   ```js
   export const name = "my-platform";
   export async function collect(ctx) {
     // ctx = { sourceConfig, baseDir, pricing, log }
     return { records: [ /* makeRecord(...) */ ], warnings: [] };
   }
   ```

2. Register it in `src/sources/index.js`.
3. Add a block under `sources` in `config.example.json` (and your local `config.json`).

Everything downstream — dedupe, storage, pricing, rollups, charts, filters —
works with no further changes.

## API (read-only, served by `serve`)

| Endpoint | Purpose |
|---|---|
| `GET /api/meta` | store timestamp, freshness settings, model pricing, filter facets |
| `GET /api/summary?granularity=&from=&to=&source=&model=&project=` | totals, time buckets, per-source / per-model / per-project rollups |
| `GET /api/records?…&limit=&offset=` | filtered raw records, newest first |
| `POST /api/ingest` | collect new usage now (what the ⟳ button calls) |
