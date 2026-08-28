Every variable declaration must carry a comment stating its type, e.g.
`// dict: worker id -> assignment record`.

Editing anything in `docs/` is forbidden. If a file there is found to have
inconsistencies, errors, or to have become stale, point it out but never edit
it without explicit approval.

## Layout

- `mod/` — the 0 A.D. mod:
  - `mod.json` — mod manifest.
  - `simulation/ai/louis_bot/` — the bot (`data.json`, `louis_bot.js` as the entry point, and one module per concern: `gathering_strategy.js`, `dropoffs_strategy.js`, `budget_allocation.js`, `construction_execution.js`).
- `docs/pyrogenesis_cli.md` — the 0 A.D. engine command line (headless usage).
- `docs/ai_engine_api.md` — reference of the AI scripting API the bot uses.
- `docs/on_update_design.md`
