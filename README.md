# thread-usage-client-plugin

A standalone example [MindRoom Chat](https://github.com/mindroom-ai/mindroom-chat) client plugin that surfaces per-thread AI run telemetry (`io.mindroom.ai_run`) on Compact thread cards and thread details, with zero runtime dependencies beyond MindRoom Chat's shared packages and `@mindroom/client-sdk/*`.

## What it shows

- **Compact thread card (`threadCardBadges`)**: a quiet, non-interactive inline telemetry strip in the card's metadata row:
  - Total thread cost (`$1.42`, or `≥ $0.08` when partial)
  - Total tokens (`420k`, or `≥ 48k` when partial)
  - Most recently used model plus additional distinct model count (`Opus 5.5` or `Opus 5.5 +1`)
  - Latest context window fill as a micro progress ring + percentage (`64%`), tinted at warning (`≥ 75%`) and critical (`≥ 90%`) thresholds
- **Thread details (`threadDetails`)**: read-only rows shown in the Compact card hover card, the thread actions menu, and the sidebar THREADS hover card:
  - **Cost**: total spend, `+$X subagents` note when subagent spend is present, and `At least $X` when the sum is a lower bound
  - **Tokens**: localized total plus compact breakdown (cache read, cache write, uncached/new input, output)
  - **Models**: all distinct models used in the thread, most recent first
  - **Context**: `128k / 200k · 64%` with a subtle 2-part progress bar and cached/new input breakdown line (`96k cached · 32k new`) when cached tokens are present

Only messages from trusted MindRoom agents on the viewer's homeserver (and not ignored by the viewer) are counted.

## Configuration (`config.json`)

Configure the plugin under `plugins["thread-usage"]` in MindRoom Chat's `config.json`. All card display toggles default to `true`:

```json
{
  "plugins": {
    "thread-usage": {
      "enabled": true,
      "showCost": true,
      "showTokens": true,
      "showModels": true,
      "showContext": true
    }
  }
}
```

- Setting `enabled: false` disables both the card strip and thread details.
- Toggling `showCost`, `showTokens`, `showModels`, or `showContext` hides the corresponding segment on the Compact card while keeping the full breakdown available in thread details.

## Partial history and lower bounds (`≥`)

Threads in a room overview may not have every older page loaded in memory yet, and an agent reply that ended as `cancelled`, `error`, or `interrupted` may omit `cost.usd`.

- When full thread history back to the root is loaded (`thread.initialEventsFetched === true`, the oldest linked timeline begins at `thread.id`, and it has no backward pagination token) and every terminal reply has known cost, totals render as exact values.
- Otherwise, cost renders with a lower-bound indicator (`≥ $0.08` on cards, `At least $0.08` in details), and partial-history token totals floor at their displayed compact precision (`≥ 48k`) so a lower bound never rounds up past what was actually counted.
- Context window fill and latest model always reflect the latest agent reply that reported them.

## Development

Link a MindRoom Chat checkout with installed `node_modules` at `.mindroom-chat` in this directory:

```bash
ln -s /path/to/mindroom-chat .mindroom-chat
```

### Typecheck & lint (from this repository)

```bash
npm run typecheck
npm run strict
npm run lint
```

### Unit tests & production build (from `.mindroom-chat`)

```bash
MINDROOM_CLIENT_PLUGINS=/abs/path/to/thread-usage-client-plugin \
  MINDROOM_CLIENT_PLUGIN_TESTS_ONLY=1 npx vitest run

MINDROOM_CLIENT_PLUGINS=/abs/path/to/thread-usage-client-plugin \
  npx vite build
```

### End-to-end tests (from `.mindroom-chat`)

```bash
E2E_PLUGIN_DIRS=/abs/path/to/thread-usage-client-plugin \
MINDROOM_CLIENT_PLUGINS=/abs/path/to/thread-usage-client-plugin \
  just e2e-slot 3 --preview npx playwright test --project=thread-usage-client-plugin
```

Set `MRTU_SHOTS=/abs/path/to/dir` to save desktop/phone and light/dark screenshots during the E2E run.
