# Victory, defeat and diplomacy (0 A.D. 0.28.0)

How a game ends: victory conditions, what counts as defeat, the wonder/regicide/relic modes, ceasefire, and the diplomacy model. Grounded in the pinned 0.28.0 copy at `/home/ubuntu/0ad-reference/` — all paths below are relative to it. Main sources: `public/simulation/components/EndGameManager.js`, `Player.js`, `Diplomacy.js`, `CeasefireManager.js`, `Attack.js`, `public/simulation/helpers/Setup.js`, the victory-condition definitions `public/simulation/data/settings/victory_conditions/*.json`, their trigger scripts `public/maps/scripts/*.js`, and the gamesettings attributes `public/gamesettings/attributes/*.js`.

## Player states and what "defeat" does

Each player entity has a `Player` component with a state: `"active"`, `"won"` or `"defeated"` (`public/simulation/components/Player.js:26`, initial state active at `Player.js:63`).

`Player.SetState(newState, message)` (`Player.js:469-527`):

- Only an **active** player can change state; gaia (player 0) can never change state (`Player.js:471-484`).
- On **won**: the winner gets the whole map revealed (`SetLosRevealAll`, `Player.js:490-491`).
- On **defeated**: **every entity of the player is reassigned to gaia** — ownership set to 0 quietly, then `MT_OwnershipChanged` messages are broadcast with `from = playerID, to = 0` (`Player.js:494-512`). The units/structures stay on the map as neutral gaia objects; they are not destroyed.
- A `MT_PlayerWon` / `MT_PlayerDefeated` message is posted (`Player.js:515-516`).

Defeat is normally triggered by trigger scripts via `TriggerHelper.DefeatPlayer(playerID, reason)`, which just calls `cmpPlayer.SetState("defeated", reason)` (`public/maps/scripts/TriggerHelper.js:314-319`).

## EndGameManager: victory conditions, allied victory, last man standing

System component (`public/simulation/components/EndGameManager.js`).

- **Settings**: `SetGameSettings` stores `{ victoryConditions, wonderDuration?, relicCount?, relicDuration?, regicideGarrison? }` (`EndGameManager.js:39-46`). If `victoryConditions` is empty the game is **endless** — no allied-victory checks at all (`EndGameManager.js:43`, `136`).
- **Allied victory flag**: `alliedVictory` (default `true`, `EndGameManager.js:18`). Set at game start to `settings.LockTeams || !settings.LastManStanding` (`public/simulation/helpers/Setup.js:63`). So "last man standing" is simply allied victory turned off, and it is only available with unlocked teams (`Setup.js:64-65`; `public/gamesettings/attributes/LastManStanding.js`).
- **Winning a player**: `MarkPlayerAndAlliesAsWon(playerID, ...)` wins the given player plus — if allied victory is on — all its **active mutual allies** (`EndGameManager.js:58-73`). `MarkPlayersAsWon(winningPlayers, ...)` wins exactly the listed players and **defeats every other active player** (`EndGameManager.js:85-122`).
- **Automatic "last players alive" check**: `AlliedVictoryCheck` (`EndGameManager.js:134-180`) runs on game init, on every diplomacy change and on every player defeat (`EndGameManager.js:182-195`). If all remaining active players are mutual allies of each other:
  - allied victory on, or only one player left → they all win immediately (`EndGameManager.js:160-174`);
  - allied victory off and several non-ally players remain → nothing happens except a "Last remaining player wins." reminder shown every 12 hours (`EndGameManager.js:175-179`).
  - If **no** active players remain, nothing happens (`EndGameManager.js:157-158`).

## How victory conditions are wired

- Definitions live in `public/simulation/data/settings/victory_conditions/*.json`. Each lists trigger `Scripts` (e.g. `scripts/ConquestCommon.js`) which the engine loads as `maps/` + name, i.e. `public/maps/scripts/*.js` (`source/source/simulation2/Simulation2.cpp:219-242`, `LoadTriggerScripts`).
- The active set is passed as `settings.VictoryConditions` (array of names). In the GUI, `conquest` is the only default (`conquest.json` has `"Default": true`; `public/gamesettings/attributes/VictoryConditions.js`). Some conditions mutually exclude each other via `DisabledWhenChecked` (e.g. `conquest` excludes the three other conquest flavours and vice versa, `conquest.json` / `conquest_civic_centers.json`).
- Multiple conditions can be active at once (e.g. `conquest` + `wonder`); each contributes its own defeat/victory logic.
- The autostart CLI flag is `-autostart-victory=SCRIPTNAME` (repeatable; the special value `endless` disables all conditions) (`public/autostart/cmd_line_args.js:19-23`, `177-184`). **The harness runs with `-autostart-victory=conquest_civic_centers`** by default (`harness/src/main.rs:103`, `250`).

All victory-condition timers use simulation time (the `Timer` component advances by the turn length each turn, `public/simulation/components/Timer.js:108-111`), so durations are in **in-game milliseconds**, independent of the game-speed setting. Durations are configured in **minutes** and converted with `* 60 * 1000` in `LoadMapSettings` (`Setup.js:54-58`, `68-69`).

## Class filters

The conquest scripts use class-filter strings evaluated by `MatchesClassList` (`public/globalscripts/Templates.js:84`): space = OR, `+` = AND, `!` = NOT. So `"ConquestCritical CivilCentre+!Foundation"` matches entities that are `ConquestCritical` **or** are a non-foundation `CivilCentre`.

## Conquest family

Common machinery in `public/maps/scripts/ConquestCommon.js`:

- Each condition registers one or more **queries** `{ classFilter, defeatReason }` (`ConquestCommon.js:51-54`).
- On game start the matching entities per player are counted (`ConquestCommon.js:31-49`).
- On every `OnOwnershipChanged` (kill, capture, or gaia-reassignment after a defeat), the entity is moved between per-player lists; **when a player's list for a query becomes empty, that player is defeated** with the query's reason (`ConquestCommon.js:1-29`). Note the check is ownership-based: losing your last matching entity by **capture** defeats you exactly like losing it by destruction.

The four flavours and their filters:

| Condition | Queries (classFilter) | Defeat when |
|---|---|---|
| `conquest` (`public/maps/scripts/Conquest.js`) | `ConquestCritical+!Foundation` | all critical units and structures gone |
| `conquest_structures` (`ConquestStructures.js`) | `Structure` and `ConquestCritical Structure` | all structures gone, or all structures + critical units gone |
| `conquest_units` (`ConquestUnits.js`) | `Unit+!Animal` and `ConquestCritical Unit+!Animal` | all units gone, or all units + critical structures gone |
| `conquest_civic_centers` (`ConquestCivicCentres.js`) | `CivilCentre+!Foundation` and `ConquestCritical CivilCentre+!Foundation` | **all fully built civic centres gone**, or all critical entities + civic centres gone |

### conquest_civic_centers exactly (the harness's mode)

A player is defeated as soon as it owns **zero entities matching `CivilCentre+!Foundation`** — i.e. all its fully built civic centres were destroyed **or captured** (`ConquestCivicCentres.js:3-6`, logic in `ConquestCommon.js:22-27`). Army size, other structures and CC **foundations** are irrelevant (foundations are excluded: foundation entities carry the `Foundation` class, `public/simulation/templates/special/filter/foundation.xml`). The second query (`ConquestCritical CivilCentre+!Foundation`, space = OR) also defeats a player that loses all civic centres **and** all ConquestCritical units/structures — in practice the first query fires first, since civic centres are themselves ConquestCritical.

After the defeat, the player's remaining entities pass to gaia (`Player.js:494-512`), and with only two players the survivor wins via the allied-victory check (`EndGameManager.js:134-180`).

### ConquestCritical classes

`ConquestCritical` comes from templates (`grep -r ConquestCritical public/simulation/templates/`):

- **Added:** `template_unit.xml:39` (all units), `template_structure_civic.xml:4` (civic structures), `template_structure_military.xml:14` (military structures), `template_structure_wonder.xml:41` (wonders), `template_structure_military_kennel.xml:35`, plus specific civ structures (`athen/gymnasium`, `athen/prytaneion`, `cart/super_dock`, `gaul/assembly`, `germ/great_hall`, `kush/pyramid_large`, `kush/pyramid_small`, `maur/palace`, `pers/tachara`, `rome/army_camp`, `spart/gerousia`, `spart/syssiton`).
- **Removed** (`-ConquestCritical`): `template_unit_fauna.xml:12` (animals), `template_unit_catafalque.xml:15` (relics), `template_unit_ship_fishing.xml:31`, `template_unit_ship_merchant.xml:20`, `template_unit_support_healer.xml:26`, `template_unit_support_trader.xml:14`, `template_structure_military_forge.xml:25` (forge/blacksmith).

So under plain `conquest`, economic/defense structures (houses, farmsteads, storehouses, fields, docks, markets, temples, walls, towers) do **not** keep a player alive; a lone healer, trader, fishing or merchant ship does not either.

## Wonder victory

Definition `victory_conditions/wonder.json`; script `public/maps/scripts/WonderVictory.js`; the `Wonder` component itself is an empty marker (`public/simulation/components/Wonder.js`, present on wonder templates via `template_structure_wonder.xml:100`).

- When a Wonder entity's ownership changes to a player `> 0` (construction completed, or capture), a timer of `wonderDuration` ms is started for that player (`WonderVictory.js:16-25`, `52-112`). `wonderDuration = (settings.WonderDuration ?? 1) * 60 * 1000` (`Setup.js:57-58`); GUI default 20 min, range 0–60 (`public/gui/gamesetup/.../Sliders/WonderDuration.js:49-53`).
- If the timer elapses, the owner (and its active mutual allies if allied victory is on) win; everyone else is defeated (`WonderVictory.js:134-147` via `MarkPlayerAndAlliesAsWon`).
- **Timer reset:** ownership change (wonder captured by another player → new timer for the new owner; destroyed → timer deleted) (`WonderVictory.js:16-25`, `114-126`). With allied victory on, the timer also resets when the owner's set of mutual allies changes (`WonderVictory.js:27-47`).
- A promotion/renamed wonder keeps the old timer (`WonderVictory.js:1-14`). Once any player has won, all wonder timers are deleted (`WonderVictory.js:128-132`).

## Regicide

Definition `victory_conditions/regicide.json`; script `public/maps/scripts/Regicide.js`.

- At game start, each player gets one randomly chosen **hero of its own civ** (any `units/` template with the `Hero` class, `Regicide.js:11-33`) spawned at its "best" starting entity — preference order: CivilCentre > Structure > Ship (`Regicide.js:36-49`, `80-116`). With `regicideGarrison` off, the template is prefixed `ungarrisonable|` and the hero spawns on land (if the best spawn point is a ship, the hero spawns at the gaia land spawn point nearest the ship, `Regicide.js:59-68`).
- The player is defeated when the hero's ownership changes away from them (killed; message "lost hero") (`Regicide.js:125-131`). Template renames (promotion) are tracked so the hero identity survives (`Regicide.js:118-123`).
- Everything else (civic centres, army) is irrelevant to defeat unless combined with a conquest condition.

## Capture the Relic

Definition `victory_conditions/capture_the_relic.json`; script `public/maps/scripts/CaptureTheRelic.js`.

- At game start, `relicCount` relics (catafalque templates, class `Relic`, `template_unit_catafalque.xml:16`) spawn at random gaia land spawn points, owned by gaia (`CaptureTheRelic.js:1-26`). Relics are capturable (`Capturable` 250 capture points, regen 10, `template_unit_catafalque.xml:3-7`), not `ConquestCritical`, undeletable, and have no `Health` (they can be "destroyed" only in the sense of ownership going to `-1`; the script warns and drops them from the list, `CaptureTheRelic.js:36-40`).
- Victory check (on every ownership change of a `Relic` entity, on diplomacy change and on player defeat): if gaia owns no relics and the relics are all held by a group of **mutually allied** players, a countdown of `relicDuration` ms starts (`CaptureTheRelic.js:53-87`, `103-164`). `relicDuration = (settings.RelicDuration ?? 1) * 60 * 1000`, `relicCount = settings.RelicCount ?? 1` (`Setup.js:52-56`); GUI ranges: count 1–15, duration 0–60 min, 0 = immediate victory (`RelicCount.js`, `RelicDuration.js:52-56`).
- With allied victory on, the winning group is "all active players that are mutual allies of every relic owner"; with it off, only the first relic owner wins (`CaptureTheRelic.js:69-71`). If the winning group changes mid-countdown, the timer restarts (`CaptureTheRelic.js:81-86`).
- On expiry the winning players win and all others are defeated (`CaptureTheRelic.js:166-179` via `MarkPlayersAsWon`).

## Ceasefire

System component `public/simulation/components/CeasefireManager.js`; started from `LoadMapSettings` as `StartCeasefire((settings.Ceasefire ?? 1) * 60 * 1000)` when `settings.Ceasefire` is set (`Setup.js:67-69`). GUI: 0–45 minutes, default 0 (no ceasefire) (`.../Sliders/Ceasefire.js:38-44`). **The harness passes no ceasefire flag, so matches have none.**

Mechanics (`CeasefireManager.js:46-93`):

- On start, the current diplomacy matrix of every player is saved, then **every enemy relation between non-gaia players is set to neutral** (`CeasefireManager.js:69-81`).
- After `ceasefireTime` ms, `StopCeasefire` restores the saved diplomacy exactly (`CeasefireManager.js:104-132`). A countdown notification appears 10 s before the end (`CeasefireManager.js:20`, `91-92`).
- While active, diplomacy-change commands are rejected (`public/simulation/helpers/Commands.js:36-38`) and team-locked players can never change diplomacy anyway (`Commands.js:40-41`).
- Why no attacks are possible: damage attacks require the target's owner to be an **enemy** (`Attack.CanAttack`, `public/simulation/components/Attack.js:286`), and capture progress only accrues from capture points held by **enemies** (`Capturable.CanCapture`, `public/simulation/components/Capturable.js:139-151`). Since all former enemies are neutral during ceasefire, neither works. (Ceasefire is *not* checked inside `Attack.js`/`Commands.js` attack paths — the block is entirely a consequence of neutrality.)

## Diplomacy model

Component `public/simulation/components/Diplomacy.js` on each player entity.

- **Stances** are stored per other player (including gaia and self) in an array; values: `1` ally, `0` neutral, `-1` enemy. Predicates: `IsAlly` = `> 0`, `IsEnemy` = `< 0`, `IsNeutral` = `=== 0` (`Diplomacy.js:192-205`, `258-271`, `284-297`).
- **Stances are one-directional.** `IsMutualAlly(id)` checks both directions (`Diplomacy.js:230-234`). However, **worsening is auto-reciprocated**: if player A lowers its stance towards B, B's stance towards A is automatically lowered to the same value (`Diplomacy.js:334-348`). Allying is *not* auto-reciprocated.
- `SetDiplomacyIndex` refuses changes involving non-active players (`Diplomacy.js:156-173`).
- **Teams**: each player has a `team` number, `-1` = no team (`Diplomacy.js:37-38`). `ChangeTeam` auto-allies all players on the new team both ways (`Diplomacy.js:71-106`); it is a no-op when the team is locked. `LockTeam` sets `teamLocked` (`Diplomacy.js:108-111`), which also blocks in-game diplomacy commands (`Commands.js:40-41`).
- **Shared LOS / dropsites**: the player template names two technologies — `unlock_shared_los` and `unlock_shared_dropsites` (`public/simulation/templates/template_player.xml:16-19`). Shared LOS is computed via the RangeManager over **mutual allies** and refreshed on every diplomacy change (`Diplomacy.js:310-324`, `334-336`).

## What a bot can observe

`GuiInterface.GetSimulationState` exposes to the AI (`public/simulation/components/GuiInterface.js`):

- `victoryConditions` (active condition names) and `alliedVictory` (`GuiInterface.js:160-162`).
- `ceasefireActive` and `ceasefireTimeRemaining` (ms) (`GuiInterface.js:149-154`).
- Per player: `state` ("active"/"won"/"defeated"), `team`, `teamLocked`, and boolean arrays `isAlly`, `isMutualAlly`, `isNeutral`, `isEnemy` (`GuiInterface.js:112-124`).

The AI shared state mirrors these (`public/simulation/ai/common-api/shared.js:80-83`): `victoryConditions` as a `Set`, `alliedVictory`, `ceasefireActive`, `ceasefireTimeRemaining` (converted to **seconds**). A `CeasefireEnded` event is pushed to AIs (`public/simulation/components/AIInterface.js:204-207`).

## Edge cases a bot should know

- **Defeat is permanent and ownership-based**: your defeated opponent's base does not vanish — it becomes gaia (neutral) and keeps standing; gaia-owned leftovers can still obstruct, and gaia units may still be hostile per gaia's own stances.
- Under `conquest_civic_centers`, **capturing** the last enemy CC wins exactly like destroying it — and a CC under construction (foundation) does not count for either side.
- A player with zero matching entities is defeated on the *first* ownership change after the initial count; the initial count happens on a 0-delay trigger at game start (`ConquestCommon.js:60-61`), so starting with no civic centre at all (nomad without CC) defeats you immediately under `conquest_civic_centers`.
- `MarkPlayersAsWon` defeats **all** non-winning active players — a wonder or relic victory ends the game for everyone, including players who would otherwise still be fighting.
- Diplomacy worsening is reciprocated automatically but allying is not; a one-sided "ally" stance does not make you mutual allies (no shared LOS, no allied-victory coupling).
- All victory timers (wonder, relic, ceasefire) are in simulation time; the `-autostart-speed`/game-speed setting only changes real-time pacing (`public/gamesettings/attributes/GameSpeed.js:1-12`, speeds listed in `public/simulation/data/settings/game_speeds.json`).
