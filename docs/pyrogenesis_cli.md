# `pyrogenesis` command-line reference (0 A.D. 0.28.0)

## Source basis

This documents `pyrogenesis` **0.28.0** (the 0 A.D. engine executable), grounded in the
pinned reference source tree at `/home/ubuntu/0ad-reference/` (engine version confirmed via
`source/source/lib/build_version.h:34-36`) and cross-checked against the installed Debian
binary `/usr/games/pyrogenesis` (0ad 0.28.0-3, 0ad-data 0.28.0-1) on this machine.

Flags are marked:

- **[run]** — verified by actually executing `/usr/games/pyrogenesis` on this machine (headless).
- **[src]** — read from the source only; not execution-verified here.

Inline citations are relative to `/home/ubuntu/0ad-reference/`, e.g.
`source/source/ps/GameSetup/GameSetup.cpp:568`.

### Headless gotcha (verified)

This machine has no display/GL. Any invocation that reaches video init aborts:

```
WARNING: Failed to set the video mode ... ("Could not load EGL library"), falling back to windowed mode
ERROR: SetVideoMode failed in SDL_CreateWindow: 1024x768:24 0 ("No GL driver has been loaded")
terminate called after throwing an instance of 'PSERROR_System_VmodeFailed'
```

Consequences **[run]**:

- **There is no `--help` text.** Unknown flags are silently ignored by the parser
  (`source/source/ps/GameSetup/CmdLineArgs.cpp:57-89`) and the game proceeds to normal
  (visual) startup, which dies with `System_VmodeFailed`. The authoritative "help" is
  `source/binaries/system/readme.txt` plus this document.
- Flags that work headless: `-version`, `-dumpSchema`, `-replay`, `-archivebuild*`, and the
  whole `-autostart-nonvisual` path. Everything else requires GL.
- To get "help" headless, read the source or run `-dumpSchema` / `-version`.

## 1. Invocation basics

```
pyrogenesis [-flag[=value]]... [modfile.pyromod|modfile.zip]...
```

- `-flag` and `--flag` are equivalent; values use `-flag=value` (no space form).
  Repeating a flag yields multiple values (`GetMultiple`), e.g. several `-mod=` / `-conf=` /
  `-autostart-ai=`. Arguments not starting with `-` are treated as mod archives to install
  (`source/source/main.cpp:606-626`).
- `pyrogenesis` refuses to run as root (`source/source/main.cpp:811-821`).

### Filesystem paths (Linux/XDG) **[run]**

Computed in `source/source/ps/GameSetup/Paths.cpp:147-164`. With default XDG variables:

| Purpose | Path |
|---|---|
| Game data / user data / mods | `~/.local/share/0ad/` (incl. `mods/`, `saves/`, `replays/`, `screenshots/`) |
| Config | `~/.config/0ad/config/` (`user.cfg`) |
| Cache | `~/.cache/0ad/` |
| Logs | `~/.local/state/0ad/log/` (`mainlog.html`, `interestinglog.html`, `oos_dump.txt`, `oos_logs/…`) |

Notes:

- `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME` are honored; a
  non-absolute value is interpreted relative to `$HOME` (non-standard quirk,
  `Paths.cpp:224-234`). Redirecting `HOME` (e.g. `HOME=/tmp/run1/home`) cleanly relocates
  everything **[run]**.
- Logs: `mainlog.html` (full) and `interestinglog.html` (warnings/errors) are written every
  run **[run]**. `-unique-logs` appends `_<unixtime>_<pid>` to log and `oos_dump.txt` file
  names so concurrent runs don't clobber each other **[run]**
  (`source/source/main.cpp:578-579`).

### `-writableRoot` **[src]**

`Paths.cpp:51-62`: switches from the XDG layout to storing **all** runtime data (config,
cache, user data) inside the install/root data directory, logs in `<root>/logs/`. Only
useful for portable/dev builds with write access to the game directory. For per-run
isolation on a system install, prefer `HOME=` redirection (verified) over `-writableRoot`
(not writable here).

## 2. Full option table

Canonical list: `source/binaries/system/readme.txt` ("keep synchronized with
`autostart/cmd_line_args.js`"); C++ consumers in `source/source/main.cpp`,
`source/source/ps/GameSetup/{GameSetup,Config,Paths,Atlas}.cpp`; JS-side autostart parsing
in `source/binaries/data/mods/public/autostart/cmd_line_args.js`.

### General

| Flag | Effect | Source | Status |
|---|---|---|---|
| `-version` | Print `Pyrogenesis 0.28.0` and exit | `main.cpp:564-570` | **[run]** |
| `-mod=NAME` (repeatable) | Enable mod NAME (see §5) | `GameSetup.cpp:568-576`, `source/source/ps/Mod.cpp:157-178` | **[run]** |
| `-writableRoot` | Store runtime data in install dir | `Paths.cpp:51` | **[src]** |
| `-quickstart` | Faster startup; disables audio + some system-info logging | `Config.cpp:69-73` | **[src]** |
| `-dumpSchema` | Write `entity.rng` (entity XML schema) to the **current working directory** and exit; with `-editor`, dumps Atlas schemas instead | `GameSetup.cpp:595-610`, `Atlas.cpp:80-86` | **[run]** |
| `-archivebuild=PATH` | Build/precache a mod archive from dir PATH | `main.cpp:662-683` | **[src]** |
| `-archivebuild-output=PATH` | Output `.zip` path for archivebuild | `main.cpp:668-671` | **[src]** |
| `-archivebuild-compress` | Deflate-compress the archive (default uncompressed) | `main.cpp:681` | **[src]** |
| `PATHS...` (bare args) | Install `.pyromod`/`.zip` mod files into the user mods dir | `main.cpp:606-626` | **[src]** |

Not present in 0.28.0 (do not use): `-oosdump`, `-dumpFiles`, `-dumpConfig*`, `-g`.
`-entgraph`, `-listfiles`, `-profile=NAME` exist but are disabled stubs (readme.txt).

### Video / audio / display (all require GL; useless headless)

`-xres=N`, `-yres=N`, `-vsync`, `-shadows`, `-nosound` — set config keys of the same name
(`Config.cpp:75-88`) **[src]**. `-fixed-frame-frequency=F` fixes simulated frame time to
1/F s (visual mode only, `main.cpp:585-586`) **[src]**.

### Autostart (single-player / offline)

Parsed in JS (`autostart/cmd_line_args.js:65-191`), enabled by `-autostart` in C++
(`GameSetup.cpp:772-877`).

| Flag | Syntax / default |
|---|---|
| `-autostart=TYPEDIR/MAPNAME` | TYPEDIR ∈ `skirmishes`, `scenarios`, `random`; map path is `maps/<value>` (e.g. `-autostart=skirmishes/acropolis_bay_2p`, no `.xml`, no `maps/` prefix) **[run]** |
| `-autostart-nonvisual` | No graphics/sound; runs the sim flat-out (see §3) **[run]** |
| `-autostart-seed=SEED` | Map RNG seed (default 0; `-1` = random) **[run]** |
| `-autostart-aiseed=AISEED` | AI RNG seed (default 0; `-1` = random) **[src]** |
| `-autostart-ai=PLAYER:AI` | Set AI bot for player N, e.g. `2:petra`; repeatable **[run]** |
| `-autostart-aidiff=PLAYER:DIFF` | AI difficulty 0–5 (0 sandbox, 3 default, 5 very hard) **[src]** |
| `-autostart-aibehavior=PLAYER:BEHAVIOR` | AI behavior (default `balanced`) **[src]** |
| `-autostart-civ=PLAYER:CIV` | Civ per player (`random` allowed; skirmish/random only) **[src]** |
| `-autostart-team=PLAYER:TEAM` | Team per player **[src]** |
| `-autostart-player=NUMBER` | Local player ID (default 1; `-1` = observer) **[run]** |
| `-autostart-ceasefire=NUM` | Ceasefire minutes (default 0) **[src]** |
| `-autostart-victory=SCRIPTNAME` | Victory condition script(s) from `simulation/data/settings/victory_conditions/`; `endless` = none; repeatable |
| `-autostart-wonderduration=NUM` / `-autostart-relicduration=NUM` / `-autostart-reliccount=NUM` | Defaults 10 / 10 / 2 **[src]** |
| `-autostart-visibility=TYPE` | `explored` / `hidden` / `revealed` / `allied` / `allied-explored` **[src]** |
| `-autostart-speed=SPEED` | Sim-rate multiplier; **visual mode only** — ignored in nonvisual (see §3) **[src]** |
| `-autostart-disable-replay` | Do not write a replay for this run **[src]** |

Random-map only (`autostart/cmd_line_args.js:114-125`) **[src]**:

| Flag | Syntax / default |
|---|---|
| `-autostart-players=NUMBER` | Number of players (default 2) **[run]** |
| `-autostart-size=TILES` | Map size in tiles (default 192) **[run]** |
| `-autostart-biome=BIOME` | Biome ID (e.g. `generic/temperate`); default `random` — **breaks determinism, always pin** (see §4) **[run]** |
| `-autostart-placement=PLACEMENT` | Player placement pattern (e.g. `circle`); default `random` — **breaks determinism, always pin** (see §4) **[run]** |

Note: the correct seed flag is `-autostart-seed` (there is **no** `-autostart-random-seed`,
`-autostart-hostname`, or `-autostart-aitype` in 0.28.0).

### Multiplayer autostart

C++ entry: `GameSetup.cpp:844-861`; JS: `autostart/autostart_host.js`, `autostart_client.js`.

| Flag | Effect |
|---|---|
| `-autostart-host` | Host a networked game with autostart settings **[src]** |
| `-autostart-host-players=N` | Number of human players (default 2) **[src]** |
| `-autostart-client=IP` | Join host at IP **[src]** |
| `-autostart-playername=NAME` | Local player name (default `anonymous`) **[src]** |
| `-autostart-port=N` | Net port (default 20595, `PS_DEFAULT_PORT`) **[src]** |

### Testing / debugging

| Flag | Effect | Status |
|---|---|---|
| `-replay=PATH` | **Non-visual** replay of `.../commands.txt`; headless-safe; exits when done (see §4) | **[run]** |
| `-replay-visual=PATH` | Visual replay (needs GL) | **[src]** |
| `-ooslog` | Dump full sim state every turn to `<logs>/oos_logs/<date-index>/` — drastically slower (readme.txt; `source/source/simulation2/Simulation2.cpp:92`) | **[src]** (run started but too slow to observe output here) |
| `-serializationtest` | Serialize/deserialize sim state every turn and compare (with `-replay` or live) | **[src]** |
| `-rejointest=N` | Simulate a client rejoin at turn N; cheaper OOS debugging | **[src]** |
| `-hashtest-full=BOOL` / `-hashtest-quick=BOOL` | Enable full (default true) / quick (default false) state-hash checks in replay mode (`main.cpp:653-654`) | **[src]** |
| `-unique-logs` | Per-process log file names | **[run]** |
| `-profile=NAME` | Disabled stub in 0.28.0 | **[src]** |
| `-rl-interface[=ADDR]` | Reinforcement-learning interface (see `source/tools/rlclient`; config `[rlinterface]`) | **[src]** |

There is no `-oosdump` flag: on an out-of-sync error in a networked game the client
automatically writes `oos_dump[_<ts>_<pid>].txt` + `.dat` into the log dir
(`source/source/network/NetClientTurnManager.cpp:124-153`).

### Editor (Atlas)

`-editor` launches the Atlas scenario editor (`Atlas.cpp:76-86`); needs GL. `-dumpSchema`
with `-editor` dumps Atlas schemas. No other Atlas CLI flags exist in 0.28.0. **[src]**

### Generic engine overrides

- `-conf=KEY:VALUE` (repeatable) — set any config value at priority `CFG_COMMAND`
  (`Config.cpp:53-64`), e.g. `-conf=profiler2.autoenable:true`.
  **[src]** (mechanism read in source; keys verified only for `profiler2.autoenable` in
  `source/binaries/data/config/default.cfg:191-196`).
- Profiler2 HTTP server: `profiler2.autoenable`, `profiler2.server` (default `127.0.0.1`),
  `profiler2.server.port` (default `8000`) — serves profiling pages while running.
  **[src]**

## 3. Headless AI testing

### Verified command **[run]**

```bash
mkdir -p tmp/smoke-home/.local/share/0ad/mods
cp -r bot tmp/smoke-home/.local/share/0ad/mods/brennus
HOME=$PWD/tmp/smoke-home timeout 150 /usr/games/pyrogenesis \
    -autostart=random/mainland -autostart-seed=1 \
    -autostart-biome=generic/temperate -autostart-placement=circle \
    -autostart-nonvisual -autostart-players=2 -autostart-size=192 \
    -autostart-victory=conquest_civic_centers \
    -autostart-ai=1:brennus -autostart-ai=2:petra -autostart-aidiff=2:3 \
    -autostart-civ=1:gaul -autostart-civ=2:rome -autostart-player=-1 \
    -unique-logs -nosound -mod=public -mod=brennus
```

- This exact command was run to completion on this machine: 7,047 turns, exit 0,
  per-player statistics JSON on stdout, replay + `metadata.json` written, zero `ERROR`
  lines in the interesting log. It is the project smoke test (see `AGENTS.md`).
- **Never use `HOME=/tmp/...` for real matches**: `/tmp` is a small tmpfs here; use a
  persistent directory (e.g. `tmp/` in the repo). The earlier minimal probe
  (`-autostart=skirmishes/acropolis_bay_2p`, petra vs petra, `HOME=/tmp/0ad-run1/home`)
  also verified the mechanism but is not the recommended working directory.

- Map names are VFS paths minus `maps/` and extension; list available ones with
  `unzip -l /usr/share/games/0ad/mods/public/public.zip | grep 'maps/skirmishes/.*\.xml$'`
  (loose copies: `/home/ubuntu/0ad-reference/source/binaries/data/mods/public/maps/`).
- `-autostart-player=-1` = observer (all players AI-driven).
- `-autostart-nonvisual` **alone is rejected**: `ERROR: -autostart-nonvisual can't be used
  alone. A map with -autostart="TYPEDIR/MAPNAME" is needed.` (`main.cpp:572-576`) **[run]**.
- No `-nosound` needed: audio init is skipped automatically in nonvisual mode
  (`GameSetup.cpp:614-617`) **[src, consistent with run]**.

### Runtime behavior **[run + src]**

- Nonvisual mode executes **one turn per main-loop iteration as fast as the CPU allows**
  (`main.cpp:493-511`: `Update(DEFAULT_TURN_LENGTH, 1)` with a constant 200 ms step,
  `DEFAULT_TURN_LENGTH` at `source/source/simulation2/system/TurnManager.h:62`). Observed ~113 turns/s on
  this machine (i.e. ~22× real time). `-autostart-speed` has **no effect** here.
- Turns are logged to stdout: `Turn <n> (200)...` **[run]**.
- **Exit behavior:** the process exits by itself with `EXIT_SUCCESS` only when the game is
  *finished* (victory conditions met — `main.cpp:509-510`: `if (g_Game->IsGameFinished())
  QuitEngine(EXIT_SUCCESS);`) **[src]**. With `endless` victory or while the game is
  undecided it runs forever; kill it with `timeout`/`SIGTERM` (timeout exit code 124)
  **[run]**. SIGTERM kills immediately — no clean shutdown, so `metadata.json` is **not**
  written in that case **[run]**.
- On game end, `maps/scripts/NonVisualTrigger.js` prints each player's statistics as JSON
  to stdout **[src]**.
- To stop after N turns there is no built-in flag; use wall-clock `timeout` and calibrate
  against the observed turns/sec, or have the mod itself end the game / quit.

### Files produced **[run]**

- Logs: `$HOME/.local/state/0ad/log/mainlog.html`, `interestinglog.html`
  (`-unique-logs` for per-run names).
- Replay: `$HOME/.local/share/0ad/replays/0.28.0/YYYY-MM-DD_NNNN/` — directory named by
  date plus a per-day counter (`source/source/ps/Util.cpp:92-117`), containing:
  - `commands.txt` — full simulation log (see §4),
  - `metadata.json` — written only on **clean** game shutdown
    (`source/source/ps/Game.cpp:115-123` in `~CGame`, `source/source/ps/Replay.cpp:116-145`).
- Cache: `$HOME/.cache/0ad/`.

Per-run isolation: set `HOME=<persistent-dir>/<run>/home` (verified — all engine state,
mods dir included, lands under it). Do **not** use `/tmp` (small tmpfs on this machine).
Alternatively `-writableRoot` on a writable dev checkout **[src]**.

## 4. Determinism and replays

- **Seeds:** fix `-autostart-seed` (map) and `-autostart-aiseed` (AI); both default to 0
  (fixed) and `-1` means "pick randomly" (`source/binaries/data/mods/public/autostart/cmd_line_args.js:161-166`).
- **Pin `-autostart-biome` and `-autostart-placement` too.** Both default to the string
  `"random"` (`autostart/cmd_line_args.js:124-125`), and "random" values are resolved at
  game launch by `GameSettings.pickRandomItems()`
  (`source/binaries/data/mods/public/gamesettings/GameSettings.js:116-131`, called from
  `launchGame` at `:143`) via `pickRandom` in the GUI realm
  (`attributes/Biome.js:82-88`, `attributes/PlayerPlacement.js:47-53`) — i.e. outside the
  seeded map RNG. Empirically verified by the previous project: same seed, replay
  manifests show different placement patterns (`circle` vs `randomGroup`) across runs.
  Same-seed reproducibility requires pinning both on the command line.
- **Replay file format** (`source/source/ps/Replay.cpp:75-114`): first line
  `start {json init attributes, incl. seeds, players, mods, engine_serialization_version, timestamp}`,
  then per turn `turn <n> <turnLength>`, `cmd <player> {json}`, `end`, plus `hash` /
  `hash-quick <hex>` state-hash lines (only present in networked/recorded-with-hashes games;
  a plain offline nonvisual run records **no** hash lines **[run]**).
- **Replaying:** `pyrogenesis -replay=<abs path to commands.txt>` — fully headless, loads
  the mods recorded in the replay, re-simulates every turn, prints `# Final state: <hash>`
  and exits 0 **[run]**. Pass a *file*, not the directory (`main.cpp:592-604`). Use the
  host's `commands.txt` for multiplayer games (`source/source/ps/Game.cpp:161`).
- **OOS debugging:** `-replay ... -ooslog` (per-turn state dumps under
  `<logs>/oos_logs/`), `-serializationtest`, `-rejointest=N`, `-hashtest-quick=true`
  (`main.cpp:647-655`). In live multiplayer, OOS errors auto-dump `oos_dump.txt`/`.dat`
  to the log dir.
- **Turn length / speed:** single-player turn length is fixed at 200 ms
  (`source/source/simulation2/system/TurnManager.h:62`); it is not CLI-configurable. Game speed (`-autostart-speed`) only
  scales visual-mode frame stepping; nonvisual runs always go flat-out.

## 5. Mod loading

- Discovery (`source/source/ps/Mod.cpp:248-292`): mods are directories (or `.zip`/`.pyromod`) with a
  `mod.json` (must contain at least `name`, `version`, `dependencies`) under
  `<install>/mods/` (here `/usr/share/games/0ad/mods/`) or the user dir
  `~/.local/share/0ad/mods/`. A mod present in both places is taken from the install dir
  (`GameSetup.cpp:181-184`).
- Enablement (`source/source/ps/Mod.cpp:157-178`):
  - No `-mod` flag: uses config `mod.enabledmods` (default `"mod public"`,
    `source/binaries/data/config/default.cfg:547`).
  - With `-mod=NAME` (repeatable): the list is exactly what you pass, with the base `mod`
    mod always prepended. **`public` is NOT implicit** — `-mod=mybot` alone mounts only
    `mod`+`mybot` and autostart fails with
    `ERROR: JavaScript error: autostart/entrypoint.js ... Autostart is not implemented in
    the 'mod' mod` **[run]**. Always use:
    ```bash
    pyrogenesis -mod=public -mod=mybot -autostart-nonvisual -autostart=...
    ```
    **[run]**
  - Mount priority increases with list order, so a later `-mod` overrides earlier files;
    the `user` mod (`~/.local/share/0ad/mods/user/`) is mounted last
    (`GameSetup.cpp:167-197`).
- Dev mod: drop a plain directory like `~/.local/share/0ad/mods/mybot/` containing
  `mod.json` (e.g. `{"name":"mybot","version":"0.1","label":"My Bot","description":"…",
  "dependencies":["public-0.28.0"]}`) plus your files mirroring the VFS layout
  (`simulation/ai/...`, `autostart/...`, etc.). No archive build needed for loose
  directories **[run]**.
- In nonvisual mode, incompatible/missing mods are a hard startup error
  (`GameSetup.cpp:578-584`) **[src]**.
