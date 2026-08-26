# louis_bot

An in-engine JavaScript AI bot for [0 A.D.](https://play0ad.com/) (0.28.0), shipped as a mod.

At the start of the game, the bot finds the food cluster (a 20 m circle with at least 500 food) closest to the civic centre and builds a farmstead minimizing the walking distance to every source in the cluster.

## Layout

- `mod/` — the 0 A.D. mod:
  - `mod.json` — mod manifest.
  - `simulation/ai/louis_bot/` — the bot (`data.json` + `louis_bot.js`).
- `docs/pyrogenesis_cli.md` — the 0 A.D. engine command line (headless usage).
- `docs/ai_engine_api.md` — reference of the AI scripting API the bot uses.

## Usage

Copy the `mod/` directory into your 0 A.D. mods folder (e.g. `~/.local/share/0ad/mods/louis_bot`), enable the mod, and select the "Louis — bot" AI for a player in the game setup.
