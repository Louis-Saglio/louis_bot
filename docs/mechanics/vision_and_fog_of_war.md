# Vision, line of sight, fog of war and mirages (mechanic) — 0 A.D. 0.28.0

How the engine decides what each player sees. Grounded in `source/source/simulation2/components/CCmpRangeManager.cpp` (the system `RangeManager`: LOS grids, per-entity visibility), `source/source/simulation2/components/CCmpVision.cpp` (the `Vision` component), `source/source/simulation2/helpers/Los.h` (LOS state encoding), and the scripted components `public/simulation/components/Visibility.js`, `Fogging.js`, `Mirage.js`, `VisionSharing.js`. Game-settings wiring: `public/simulation/helpers/Setup.js`, `InitGame.js`, `public/simulation/components/Diplomacy.js`, `Player.js`. Paths below are relative to `/home/ubuntu/0ad-reference`.

## Overview

- The map is discretized into an LOS grid with one vertex every **4 m** (`LOS_TILE_SIZE = 4`, `source/source/simulation2/helpers/Los.h:32`). 4 m is the minimal meaningful resolution of any vision-range change.
- Each vertex stores a 2-bit state **per player**: `UNEXPLORED = 0`, `EXPLORED = 1`, `VISIBLE = 2` (`LosState`, `Los.h:34-40`), packed 2 bits per player into a `u32` grid, players 1–16 only (`MAX_LOS_PLAYER_ID = 16`, `CCmpRangeManager.cpp:422,446-447`). Visible implies explored (`VISIBLE|EXPLORED` are set together, `CCmpRangeManager.cpp:2187`).
- A vertex becomes `EXPLORED` the first time it enters any of the player's vision circles and **stays explored forever** (removing vision only clears the `VISIBLE` bit, `LosRemoveStripHelper`, `CCmpRangeManager.cpp:2201-2220`).
- An entity (not a vertex) is in one of three states per player: `HIDDEN` (0), `FOGGED` (1), `VISIBLE` (2) (`Visibility.js:1-3`; string forms `"hidden"/"fogged"/"visible"` via the script interface, `source/source/simulation2/components/ICmpRangeManager.cpp:37-44`). `FOGGED` = in explored but not currently visible territory.

## Vision range (`Vision` component)

Engine component (`CCmpVision.cpp`), not a script. Template schema: `Range` (non-negative integer, **metres**), optional `RevealShore` boolean (`CCmpVision.cpp:50-61`).

- Every entity with a `Vision` component adds a vision circle for its owner: exact circle rasterized onto the 4 m LOS grid, with sub-tile precision so moving units don't jump a whole tile at once (`LosUpdateHelper`, `CCmpRangeManager.cpp:2252-2333`). Vertices within `Range` of the position get a per-player reference count incremented (`LosAddStripHelper`, `CCmpRangeManager.cpp:2173-2196`); overlapping vision from several units stacks and a vertex stays visible until the count returns to 0.
- `Range = 0` gives no vision at all (`LosAdd` early-returns, `CCmpRangeManager.cpp:2463-2469`); entities with no `Vision` component give no vision either.
- Technologies and auras modify the range through the standard value-modification path `Vision/Range`; on change the component broadcasts `MT_VisionRangeChanged` and the range manager re-rasterizes the circle (`CCmpVision.cpp:118-133`, `CCmpRangeManager.cpp:717-756`). Examples in 0.28.0 data: `simulation/data/technologies/tower_range.json` (+8 to towers), `outpost_vision.json` (×1.333), `ship_vision.json` (×1.1, ×1.25 scout ships), `heal_range.json` (+5 for healers), `exploration.json` (×1.2, traders and ships, cart/han only).
- `RevealShore`: an entity with `RevealShore=true` permanently reveals (while owned/alive) all shore vertices within 10 LOS tiles of water for its owner (`RevealShore`, `CCmpRangeManager.cpp:2111-2139`). **Unused in 0.28.0 data** — no shipped template sets it true; the only occurrence is `special/filter/foundation.xml:46` explicitly disabling it on foundations.
- Vision is **not blocked by obstacles, elevation, forests or walls** — it is purely radial ("would be nice to make it cleverer, so e.g. mountains and walls can block vision", `CCmpRangeManager.cpp:377-378`).

### Verified template values

| Template | Vision/Range |
|---|---|
| `template_unit.xml:139-141` (fallback default, usually overridden deeper) | 12 |
| `template_unit_infantry.xml` | 80 |
| `template_unit_cavalry.xml` | 80 |
| `template_structure.xml:162-164` (fallback for buildings) | 4 |
| `template_structure_civic_civil_centre.xml` | 90 |
| `template_structure_military_stable.xml` | 32 |
| `template_structure_defensive_outpost.xml` | 90 |
| `template_structure_defensive_tower.xml` | 80 |
| `template_gaia.xml` | 0 |

## Update timing

- The counts grids are updated **immediately** when an entity moves, changes owner, is created/destroyed or changes vision range (`MT_PositionChanged`/`MT_OwnershipChanged`/`MT_VisionRangeChanged` handlers, `CCmpRangeManager.cpp:591-756`).
- Per-entity **visibility recomputation is batched**: dirty LOS regions are marked, and `UpdateVisibilityData` runs **once per simulation turn** from the `MT_Update` handler (`CCmpRangeManager.cpp:796-801,1883-1915`), posting `MT_VisibilityChanged` messages per entity whose state changed (`CCmpRangeManager.cpp:1923-1939`). `MT_Update` is broadcast once per turn (`source/source/simulation2/Simulation2.cpp:547-552`); the default turn length is **200 ms** (`source/source/simulation2/system/TurnManager.h:62`, used by the local/single-player turn manager `LocalTurnManager.cpp:31`). So visibility transitions (and mirage creation) can lag reality by up to one turn.

## Per-entity visibility rules (`Visibility` component + `ComputeLosVisibility`)

`ComputeLosVisibility` (`CCmpRangeManager.cpp:1681-1776`) decides an entity's state for a player, in order:

1. No position in world → `HIDDEN`.
2. Mirage entities are `HIDDEN` for every player except the mirage's own player (`CCmpRangeManager.cpp:1690-1693`).
3. If the player has reveal-all: everything positioned is `VISIBLE`, mirages `HIDDEN` (`CCmpRangeManager.cpp:1699-1705`).
4. If the entity has *scripted visibility* activated (see below), the script result wins (`CCmpRangeManager.cpp:1716-1723`).
5. On a currently visible vertex → `VISIBLE` (mirages stay `HIDDEN`).
6. On an unexplored vertex → `HIDDEN`.
7. On an explored-but-not-visible vertex (fog): entities whose template has `Visibility/RetainInFog = false` → `HIDDEN` — this is the case for all units (`template_unit.xml:134`). With `RetainInFog = true`, see the fog/mirage rules below.

`Visibility` template fields (`Visibility.js:7-19`):

- `RetainInFog` — whether the entity (or its mirage) remains shown in explored fog. True for structures (`template_structure.xml:157`), gaia entities (`template_gaia.xml:44`), fauna, rubble, obstructors; false for units.
- `AlwaysVisible` — **does not affect LOS computation**. It only sets the `IGNORE_LOS` rendering flag so the model is drawn even in fog (`CCmpVisualActor.cpp:636-638`, `source/source/simulation2/components/CCmpUnitRenderer.cpp:459`). Used by local helper entities (rally points, previews, target markers). Do not rely on it for game logic.
- `Corpse` / `Preview` — set *scripted visibility* on (`Visibility.js:21-32`), letting `GetVisibility` override the range manager (`Visibility.js:61-85`): previews are visible only to their owner, corpses mimic `RetainInFog` for the owner and behave like normal entities for others.

## Fog of war and mirages

Fog-of-war "memory" of enemy/gaia entities is implemented by **mirage entities** (`public/simulation/components/Fogging.js`, `Mirage.js`).

- Only entities with a `Fogging` component can be miraged: structures and gaia entities (`template_structure.xml:32`, `template_gaia.xml:4`). Fogging is *activated* when the entity first gets a non-gaia owner (`Fogging.js:172-176`).
- When a fogging-enabled entity a player has **already seen** leaves that player's vision (`VIS_FOGGED` transition), a per-player mirage entity is created/updated at the entity's current position (`Fogging.js:201-214`, `LoadMirage` `Fogging.js:63-132`). The real entity then reads `HIDDEN` for that player and the mirage reads `FOGGED` (`CCmpRangeManager.cpp:1751-1775`). An entity never scouted stays fully `HIDDEN` (`WasSeen` check, `CCmpRangeManager.cpp:1770-1773`).
- The mirage is a **separate entity** built from template `"mirage|" + <current template name>` (`Fogging.js:74`); the `mirage` template filter (`public/simulation/templates/special/filter/mirage.xml`) keeps only `Footprint`, a stripped `Identity`, `Minimap`, `Mirage`, a non-blocking `Obstruction`, `OverlayRenderer`, `Ownership`, `Position`, `Selectable`, `StatusBars`, `Visibility`, `VisualActor`. Mirages have **no `AIProxy`, no `Health`, no `UnitAI`, etc.** — they cannot fight, be attacked as themselves, or produce events.
- Snapshot content: owner, position/rotation and actor seed are copied at creation (`Fogging.js:88-121`), plus a frozen copy of a fixed list of components — `Capturable`, `Foundation`, `Health`, `Identity`, `Market`, `Repairable`, `Resistance`, `ResourceSupply` (`Fogging.js:15-24,124-125`). Each snapshot holds scalars only: e.g. `HealthMirage` keeps max/current HP, repairable/injured/unhealable flags (`Health.js:494-507`); `ResourceSupplyMirage` keeps amount/type/max gatherers (`ResourceSupply.js:471-480`); `CapturableMirage` keeps capture points (`Capturable.js:384-392`); `IdentityMirage` keeps the class list (`Identity.js:298-307`). **The snapshot is only refreshed when the real entity is visible again and re-fogs** — a mirage's HP, position and capture points are the last-known values and can be arbitrarily stale (the real building may be damaged, captured or destroyed; a destroyed parent's mirage self-destructs next time it becomes hidden, `Fogging.js:172-199`, `Mirage.js:73-74`).
- Lifecycle: when the real entity becomes visible to the player, the mirage goes `HIDDEN` and posts `MT_EntityRenamed` pointing back to the real entity (`Mirage.js:64-77`); it is kept alive (hidden) for reuse and reloaded with fresh data on the next fogging (`Fogging.js:71-74`).
- Entities with `RetainInFog = true` but **no `Fogging` component** (e.g. fauna, rubble) stay `FOGGED` directly — the *real* entity, at its *live* position, remains visible in fog (`CCmpRangeManager.cpp:1754-1775`). So animals are trackable through fog.

## Vision sharing

- **Allied shared LOS** is player-level: when a player has researched the tech named by `Diplomacy/SharedLosTech` (`unlock_shared_los`, "Cartography", `template_player.xml:17`, `simulation/data/technologies/unlock_shared_los.json`), the range manager ORs the LOS masks of all **mutual allies** into the player's visibility (`Diplomacy.js:310-324`, `CCmpRangeManager.cpp:1666-1672,1986-2011`). Fog/mirage bookkeeping then treats allied vision as the player's own. The `AllyView` gamesetting auto-researches this tech at game start (`InitGame.js:63-64`).
- **Entity-level sharing** (`VisionSharing.js`): an entity's vision can be shared with specific players beyond its owner —
  - *Garrisoning*: a unit garrisoned in a foreign holder adds its owner to the holder's vision sharing (`VisionSharing.js:56-72`).
  - *Spies/bribes*: `AddSpy(player, duration)` on a `Bribable` entity gives that player the entity's vision; cost from the `special/spy` template (500 metal, `public/simulation/templates/special/spy.xml`), duration from the template (15 s) scaled by the target's vision range as `duration × 60 / max(30, visionRange)`, or permanent if no duration (`VisionSharing.js:112-158`). Requires the `unlock_spies` tech (`special/spy.xml` requirements).
  - Sharing changes post `MT_VisionSharingChanged`; the range manager adds/removes the entity's vision circle for the extra players (`CCmpRangeManager.cpp:757-795`).

## Game settings and special states

- `RevealMap` (map exploration setting "revealed"): `SetLosRevealAll(-1, true)` — every vertex visible for every player; mirages never shown (`Setup.js:18-23`, `CCmpRangeManager.cpp:1699-1705,1947-1972`).
- `ExploreMap` (setting "explored"): `ExploreMap(i)` marks the whole map `EXPLORED` (not visible) for every player at game start, then force-mirages all fogging entities in explored territory (`InitGame.js:37-42`, `CCmpRangeManager.cpp:2013-2026,2075-2109`).
- **Default start of every game**: `PreInitGame` calls `ExploreTerritories` — each player's own starting territory is explored, and entities inside it are force-miraged (`InitGame.js:22-25`, `CCmpRangeManager.cpp:2028-2068`).
- Winning a game grants the winner reveal-all (`Player.js:488-491`). Gaia always has reveal-all (`CCmpRangeManager.cpp:483-485`). The "reveal map" cheat toggles reveal-all for everyone (`public/simulation/helpers/Commands.js:102`).
- On circular maps (`CircularMap` setting) the corners are off-world and never explorable (`Setup.js:31`, `LosIsOffWorld`, `CCmpRangeManager.cpp:2145-2168`).

## What the AI API sees

- **The AI is omniscient about entity state.** `AIInterface` ships every entity that has an `AIProxy` component to the AI scripts each turn, with **no visibility filtering** (`AIInterface.js:110-159`); `AIProxy` has no fog/visibility logic at all (`public/simulation/components/AIProxy.js`). Enemy unit positions, HP, orders etc. are all readable regardless of fog.
- **Mirages are invisible to the AI as entities** — the mirage filter includes no `AIProxy` (`special/filter/mirage.xml`), so mirages never appear in `state.entities`. Mirage-related `EntityRenamed` events are filtered out (`AIInterface.js:188-192`).
- Visibility itself is queryable in simulation scripts through the range manager: `GetLosVisibility(ent, player)` → `"hidden"|"fogged"|"visible"` and `GetLosVisibilityPosition(x, z, player)` (`ICmpRangeManager.cpp:37-44,70-71`); the GUI-facing entity state includes it (`GuiInterface.js:472-473`).
- Visibility gates unit behaviour even if the AI can read the state: `UnitAI.CheckTargetVisible` refuses targets that are `HIDDEN` for the owner — but explicitly accepts targets that are currently miraged (`UnitAI.js:4935-4944`), so ordering an attack on a fogged (miraged) building works, while attacking a unit lost in fog does not. `CheckPositionVisible` (attack-ground) requires a currently `"visible"` position (`UnitAI.js:4950-4961`). Miraged targets are resolved to the real entity when damage lands (`DelayedDamage.js:58-61`).

## Edge cases a bot should know

- Enemy **units** (RetainInFog=false) vanish completely in fog — no ghost, no last-known marker. Enemy **structures** leave a stale mirage ghost only after being scouted once.
- A mirage's reported HP/capture points/position are last-known values: a "full-HP enemy CC" in fog may be damaged, captured or gone. Its entity ID also differs from the real entity's.
- Animals and gaia resources remain live-visible in fog (`RetainInFog`, no real-entity hiding for non-fogging entities).
- Visibility changes (including mirage swaps) apply at most once per 200 ms turn, batched — not instantly on movement.
- LOS is circular and unblocked: hills, walls and forests do not hide anything; being inside vision range is all that matters.
- Players beyond ID 16 have no LOS tracking at all (`MAX_LOS_PLAYER_ID = 16`).
