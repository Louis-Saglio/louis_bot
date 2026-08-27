# louis_bot

An in-engine JavaScript AI bot for [0 A.D.](https://play0ad.com/) (0.28.0), shipped as a mod.

## Layout

- `mod/` — the 0 A.D. mod:
  - `mod.json` — mod manifest.
  - `simulation/ai/louis_bot/` — the bot (`data.json`, `louis_bot.js` as the entry point, and one module per concern: `gathering_strategy.js`, `dropoffs_strategy.js`, `budget_allocation.js`, `construction_execution.js`).
- `docs/pyrogenesis_cli.md` — the 0 A.D. engine command line (headless usage).
- `docs/ai_engine_api.md` — reference of the AI scripting API the bot uses.

## Usage

Copy the `mod/` directory into your 0 A.D. mods folder (e.g. `~/.local/share/0ad/mods/louis_bot`), enable the mod, and select the "Louis — bot" AI for a player in the game setup.
