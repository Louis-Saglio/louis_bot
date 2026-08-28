# Territory

How the map is divided into per-player territory, how borders are computed, what buildings may be placed where, and how buildings decay in hostile or unconnected territory. Grounded in 0 A.D. 0.28.0: engine `source/source/simulation2/components/CCmpTerritoryManager.cpp` and `CCmpTerritoryInfluence.cpp`, JS components `public/simulation/components/TerritoryDecay.js`, `TerritoryDecayManager.js`, `BuildRestrictions.js`, `Capturable.js`, config `mod/simulation/data/territorymanager.xml`, and templates under `public/simulation/templates/`.

## Territory grid

- The map is discretised into **territory tiles of 8 × 8 metres**: `NAVCELLS_PER_TERRITORY_TILE = 8` (`source/source/simulation2/components/ICmpTerritoryManager.h:52`) and a navcell is 1 m (`source/source/simulation2/helpers/Pathfinding.h:146`). A 128-tile random map (512 m side) is a 64 × 64 territory grid.
- Each tile stores one `u8`: owner player ID in bits 0–4 (`TERRITORY_PLAYER_MASK = 0x1F`), connected flag in bit 5 (`0x20`), blinking flag in bit 6 (`0x40`) (`ICmpTerritoryManager.h:54-57`). Owner 0 = neutral (gaia).
- Per-tile traversal cost comes from the pathfinder passability grid, downsampled to territory tiles (`CCmpTerritoryManager.cpp:424-465`):
  - passable for `default-terrain-only` → cost **1**,
  - impassable (steep terrain, deep water, …) → cost **4** (`ImpassableCost` in `mod/simulation/data/territorymanager.xml:3`),
  - off the world → cost **255**.

## Influence: how territory is generated

Buildings carry a `TerritoryInfluence` component with three fields (`source/source/simulation2/components/CCmpTerritoryInfluence.cpp:41-55`):

- `Root` (boolean) — roots are the anchors of "connected" territory (civil centres, colonies, wonders).
- `Weight` (0–65535) — influence strength at the building's tile.
- `Radius` (metres) — maximum reach.

All three pass through the technology/value-modification system (`CCmpTerritoryInfluence.cpp:77-103`), so techs can change them.

The computation (`CCmpTerritoryManager.cpp:467-592`):

1. Every entity with `IID_TerritoryInfluence`, an `Ownership` of a real player (gaia and invalid owners are skipped, lines 506-507), `Position.IsInWorld()`, `Weight > 0` and `Radius > 0` participates. **Foundations never participate**: the foundation template filter `public/simulation/templates/special/filter/foundation.xml` keeps only a whitelist of components and `TerritoryInfluence` is not among them, so a placed foundation projects **no** territory — only the completed building (the `ChangeEntityTemplate` swap) starts generating influence. There is no foundation special-case in the C++ manager either; the filters listed here are the only ones (lines 493-540).
2. Per entity, an 8-directional floodfill spreads weight outward from its tile (lines 553-589). The weight decreases per tile crossed by:
   - `relativeFalloff = Weight × 8 / Radius` per orthogonal tile, i.e. **linear falloff reaching 0 at exactly `Radius` metres** (lines 541-543);
   - multiplied by the entered tile's cost (1 passable, 4 impassable, 255 off-world) — mountains and water shrink territory (lines 558-559);
   - diagonal steps cost × 362/256 ≈ √2 (line 561).
3. The entity's weight map is added into its **player's combined weight map** (multiple buildings' influences sum, lines 576-581), and the tile's owner is whichever player's combined weight is highest there (`totalWeight > bestWeight`, lines 583-587). Ties (equal weights, including 0 = 0) stay neutral / with the first claimant, so exact midpoints between two players are effectively decided by player-ID iteration order.
4. **Connected flag**: a second floodfill starts from each root influence and marks all tiles of the root's owner as connected (`CCmpTerritoryManager.cpp:594-618`). Territory of a player that cannot be reached from any of that player's roots is "unconnected" (and gets the blinking flag, see Decay below).

Note: influence is per-player, **not** per-team — allied territories do not merge; they just don't cause decay for each other.

### Influence values of the generic structures (templates)

| Template | Root | Radius (m) | Weight |
|---|---|---|---|
| `template_structure_civic_civil_centre.xml:134` | true | 140 | 10000 |
| `template_structure_civic_civil_centre_military_colony.xml:53` (inherits CC) | true | 75 | 10000 |
| `template_structure_military.xml:26` (barracks etc.) | false | 50 | 40000 |
| `template_structure_military_fortress.xml:106` (inherits military) | false | 80 | 40000 |
| `template_structure_wonder.xml:89` | true | 100 | 65535 |
| `template_structure_civic_temple.xml:66` | false | 40 | 30000 |
| `template_structure_economic_market.xml:63` | false | 40 | 30000 |
| `template_structure_economic_storehouse.xml:70`, `..._farmstead.xml:68`, `..._resource_corral.xml:66` | false | 20 | 30000 |
| `template_structure_defensive_tower_sentry.xml:53` | false | 16 | 30000 |
| `template_structure_defensive_tower_stone.xml:59` | false | 32 | 30000 |
| `template_structure_civic_house.xml:62` | false | 16 | 65535 |
| `template_structure_defensive_wall.xml:33` | false | 20 | 65535 |

High weight + small radius (house, wall) means: strong claim on its immediate surroundings but no reach. A lone house 16 m from the border can hold a small pocket against a civil centre only right next to it; the CC's 140 m reach wins everywhere else.

## Update cadence

- Recomputation is **lazy**: any ownership/position change of an influence entity, any `TerritoryInfluence` value modification, or any terrain/water/obstruction-map change calls `MakeDirty()`, which discards the grid (`CCmpTerritoryManager.cpp:201-237, 295-301`). The next query (`GetOwner`, `IsConnected`, `GetTerritoryGrid`, …) recomputes the whole map in one pass (`CCmpTerritoryManager.cpp:271-276, 467-469`).
- After a change, a `TerritoriesChanged` message is broadcast on the next simulation `MT_Update` (`CCmpTerritoryManager.cpp:238-246`). `TerritoryDecay` components refresh their decay state on this message (`public/simulation/components/TerritoryDecay.js:131-137`).
- The AI receives the updated grid only when it changed (`NeedUpdateAI` dirty-ID check, `source/source/simulation2/components/CCmpAIManager.cpp:1026-1033`).

## Building placement restrictions

`BuildRestrictions.CheckPlacement()` (`public/simulation/components/BuildRestrictions.js:94-322`) classifies the target position:

- `tileOwner = TerritoryManager.GetOwner(x, z)`; `own` if owner == builder, `ally` if mutual (exclusive) ally, `neutral` if owner == 0, everything else `enemy` (lines 197-235).
- "Connected" is approximated as `!IsTerritoryBlinking(x, z)` (line 199).
- The template's `<Territory>` list (values: `own ally neutral enemy`, schema lines 23-34) must contain the matching class. **Extra rule: in *unconnected* own or allied territory, a building is only placeable if its template also allows `neutral`** (lines 210-213, 219-222).
- Template defaults: generic structures are `own` only (`public/simulation/templates/template_structure.xml:3-8`); civil centres and colonies are `own neutral` (i.e. they can be planted in neutral territory to found new roots); docks are `own ally neutral`.
- Placement checks ignore visibility for AI players (lines 114-128) and require a `preview|` entity for correct territory checks when the building itself has influence (comment lines 90-93).

## Territory decay

Component: `TerritoryDecay` (`public/simulation/components/TerritoryDecay.js`). Schema: `DecayRate` (capture points per second, or `Infinity`) and `Territory` (a list of `neutral`/`enemy`) (lines 3-17).

### Which buildings decay

- All structures inherit `<DecayRate>20</DecayRate><Territory>neutral enemy</Territory>` from `template_structure.xml:152-155`.
- Fortresses double it: `<DecayRate op="mul">2</DecayRate>` → 40 CP/s (`template_structure_military_fortress.xml:103-105`).
- Outposts decay only in enemy territory (`<Territory>enemy</Territory>`, `template_structure_defensive_outpost.xml:64-66`).
- Docks never decay (`<TerritoryDecay disable=""/>`, `template_structure_military_dock.xml:79`).

### When a building is decaying

`TerritoryDecay.IsConnected()` (`TerritoryDecay.js:26-85`) is evaluated on every `TerritoriesChanged` / position / diplomacy change (`TerritoryDecay.js:131-152`). A building decays (`decaying = true`) when:

- it stands on **neutral** territory and its `Territory` list contains `neutral` (decay CP go to gaia) — lines 48-52;
- it stands on **enemy-connected** territory (connected to a root of the tile's owner) and its list contains `enemy` (decay CP go to that enemy) — lines 54-59;
- it stands on **unconnected territory it doesn't own** → decays towards gaia (special case, lines 64-70);
- it stands on **its own player's unconnected territory** (own territory cut off from every own root): decays, CP go to the connected neighbouring regions; the tile region is flagged *blinking* — lines 72-84. Exception: if the unconnected region borders a *connected allied* region of a mutual ally, the building does **not** decay and blinking is disabled (lines 75-81).
- Standing on **allied connected** territory never causes decay (lines 55-62).

Allied territory therefore protects your buildings; gaia (neutral) territory does not.

### What decay does

Decay does not touch hitpoints. It drains **capture points** (`public/simulation/components/Capturable.js:203-247`):

- Once decaying, a 1-second interval timer starts (`Capturable.js:254-268`).
- Each tick: `decay = min(DecayRate, ownerCP)` is subtracted from the owner's capture points and redistributed to the connected neighbours proportionally to their bordering tile counts — or to gaia if there are none (`Capturable.js:214-231`).
- The owner's natural regen (`RegenRate`, default 5 CP/s on `template_structure.xml:10-13`, plus garrison bonuses) still applies in the same tick, so the net drain is `DecayRate − RegenRate` while the owner still has points.
- When the owner's capture points reach 0, ownership flips to the player with the most capture points (possibly gaia) (`Capturable.js:167-176`).

With the defaults (500 max CP, decay 20/s, regen 5/s) a full building in enemy territory flips after ~33 s; a fortress (40/s) after ~14 s. Garrisoned units with a Capture attack add `captureStrength × GarrisonRegenRate` to the owner's regen (`Capturable.js:190-200`), slowing decay.

### `DecayRate = Infinity`: territory-owned entities

If the decay rate is not finite, the component instead makes the entity's **owner follow the tile owner** on every territory change — the entity has no decay logic at all (`TerritoryDecay.js:23, 118-129, 171-174`). No standard skirmish template uses this (only the atlas/scenario `territory_pulls/` flag props exist, and they use a finite rate with `Root=false` influence to tug borders, e.g. `public/simulation/templates/territory_pulls/territory_pull_20.xml`).

### The blinking flag

Set per contiguous region by `SetTerritoryBlinking` floodfill (`CCmpTerritoryManager.cpp:840-870`) from `TerritoryDecayManager.SetBlinkingEntities()` (`public/simulation/components/TerritoryDecayManager.js:21-25`), which re-runs `IsConnected()` on every registered decaying-capable entity after each territory recomputation (`CCmpTerritoryManager.cpp:620-627`). Blinking marks territory about to be lost (unconnected, no connected ally neighbour). It is also the "unconnected" signal used by `BuildRestrictions` (see above) and is exposed to the AI in the territory grid (bit 6).

## How a bot queries territory

The bot (AI realm) cannot call the simulation directly; it gets:

- **`this.territoryMap`** (raw `Grid<u8>`: `{width, height, data}`): the full territory grid including connected/blinking flags, refreshed each turn when dirty (`CCmpAIManager.cpp:964-970, 1026-1033`; `public/simulation/ai/common-api/shared.js:89-92`; `baseAI.js:33,53`). Decode with `data[i] & 0x1F` for the owner, `& 0x20` for connected, `& 0x40` for blinking (masks from `ICmpTerritoryManager.h:54-57`; the same `0x1F` decode is used by Petra, `public/simulation/ai/petra/mapModule.js:9,51,126-127`). Convert world position (x, z) to tile index: `i = floor(x / cellSize)`, `cellSize = mapSize / territoryMap.width` = 8 m (`shared.js:90-92`; `CCmpTerritoryManager.cpp:417-422`). The grid is full-information: no fog-of-war masking.
- **Per-entity `decaying` flag** on entities with `TerritoryDecay` in the entity representation, plus a `TerritoryDecayChanged` event (`public/simulation/components/AIProxy.js:203-209, 308-310`).
- A `TerritoriesChanged` event in `state.events` whenever borders moved (`public/simulation/components/AIInterface.js:21-22, 199-201`).
- **Territory percentage** (share of passable territory tiles connected to the player's roots): engine `GetTerritoryPercentage` (`CCmpTerritoryManager.cpp:640-654`) = `connectedPassableCells[player] × 100 / totalPassableCells`, counted only over connected, passable tiles (`CCmpTerritoryManager.cpp:608-617`). In the sim it is exposed on the player entity as `StatisticsTracker.GetPercentMapControlled()` (`public/simulation/components/StatisticsTracker.js:443-450`) and `GetTeamPercentMapControlled()` (lines 452-475). There is no direct AI-realm accessor for it; a bot can compute the same number by counting `territoryMap` cells with `owner == self && connected` over all passable cells, or read it from the player statistics if exposed through the shared script.

## Edge cases a bot should know

- **Unconnected own territory is hostile to you**: buildings there decay and most buildings can't be placed (need `neutral` in their territory list). Reconnect by chaining buildings or a new root toward it.
- Only roots (CC, colony, wonder) create connected territory; everything else only expands it. Losing your last root makes *all* your territory unconnected.
- Borders react to the *sum* of a player's building weights; dense building clusters push borders further than spaced ones, and impassable terrain (cost 4) and off-world (255) shrink influence.
- Enemy buildings already standing in territory you take over decay automatically at 20 CP/s (40 for fortresses) — no units needed to flip them; docks are immune. Foundations neither generate territory nor decay: the foundation filter drops `TerritoryInfluence`, `Capturable` and `TerritoryDecay` (`special/filter/foundation.xml`), so an unfinished building in neutral or enemy territory just sits there until completed.
- Gaia-owned influence is impossible: gaia buildings never generate territory (`CCmpTerritoryManager.cpp:506-507`).
- `Settlement.js` is an empty stub with a TODO comment (`public/simulation/components/Settlement.js:1-15`) — no settlement mechanic is implemented; ignore it.
