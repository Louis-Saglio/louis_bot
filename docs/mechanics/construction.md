# Construction and repair

How buildings are placed and built in 0 A.D. 0.28.0, and how damaged structures are repaired. Grounded in `public/simulation/components/Foundation.js`, `Builder.js`, `Repairable.js`, `AutoBuildable.js`, `Cost.js`, `BuildRestrictions.js`, `Health.js`, `UnitAI.js`, `public/simulation/helpers/Commands.js` (`TryConstructBuilding`, `"repair"` command), `public/simulation/helpers/Transform.js` (`ChangeEntityTemplate`), the template filter `public/simulation/templates/special/filter/foundation.xml`, and `source/source/simulation2/system/ParamNode.cpp` (filter semantics). Paths below are relative to `/home/ubuntu/0ad-reference`.

## Overview: the two-step process

Construction is always two distinct steps (`public/simulation/helpers/Commands.js:1122-1129`):

1. **Placement** — a `"construct"` command creates a *foundation entity* (template `foundation|<building template>`) with 1 HP and 0 % progress, and the full resource cost is paid immediately.
2. **Building** — builders work on the foundation; each work tick raises its hitpoints. Build progress *is* the health ratio. At 100 % the foundation is replaced by the real building via `ChangeEntityTemplate` (`Foundation.js:334-354`).

Building on a foundation and repairing a damaged building are the same order: the `"repair"` command "covers both repairing damaged buildings, and constructing unfinished foundations" (`public/simulation/helpers/Commands.js:200-209`).

## Step 1 — placing a foundation (`construct` command)

`TryConstructBuilding` (`public/simulation/helpers/Commands.js:1101-1281`) does, in order:

1. Filters `cmd.entities` to units the player controls; aborts if empty (`Commands.js:1132-1134`).
2. Creates the entity with template `"foundation|" + cmd.template` at `(cmd.x, cmd.z)` with rotation `cmd.angle` (`Commands.js:1136-1160`). For `PlacementType == "shore"` (docks) the angle is recomputed automatically to face water (`Commands.js:1147-1155`).
3. Sets ownership to the player (`Commands.js:1181-1182`).
4. Runs `BuildRestrictions.CheckPlacement()` — on failure the foundation is destroyed and the command returns false, **before any resources are taken** (`Commands.js:1185-1204`). See "Placement rules" below.
5. Checks category build limits via `EntityLimits.AllowedToBuild(category)` (`Commands.js:1208-1219`).
6. Checks technology requirements (`TechnologyManager.CanProduce`); on failure the foundation is destroyed but the function does **not** return — see source (`Commands.js:1221-1238`).
7. Subtracts the full resource cost immediately: `cmpPlayer.TrySubtractResources(costs)`, using tech/aura-modified costs (`Commands.js:1240-1252`, `Cost.js:41-60`). On failure the foundation is destroyed.
8. Calls `Foundation.InitialiseConstruction(cmd.template)`, which stores the final template name and snapshots the resource costs (used later for the destruction refund) (`Commands.js:1259-1260`, `Foundation.js:44-59`).
9. If `cmd.autorepair` is true, internally issues a `"repair"` command on the new foundation for `cmd.entities` (`Commands.js:1267-1278`).

Note: the command does **not** check the builders' `Builder/Entities` list or even that the units have a `Builder` component — those constraints only shape what the GUI/AI offers. A unit without `Builder` given a repair order just finishes the order immediately (`UnitAI.js:3093-3100`).

### The foundation template

`foundation|foo` is built by applying the filter `public/simulation/templates/special/filter/foundation.xml` on top of template `foo` (engine: `source/source/ps/TemplateLoader.cpp:61-70` — `A|B` loads B then applies A; filters are looked up in `special/filter/`). The filter keeps only a whitelist of components — the `filtered=""` attribute drops every child not listed (`source/source/simulation2/system/ParamNode.cpp:125-128,232-248`). Kept: `AIProxy, AutoBuildable, BuildRestrictions, Cost, Decay, Fogging, Footprint, Foundation, Health, Identity, Market, Minimap, Obstruction, OverlayRenderer, Ownership, Population, Position, RallyPoint, RallyPointRenderer, Resistance, Selectable, Sound, StatusBars, StatusEffectsReceiver, Visibility, Vision, VisualActor`. Dropped (relevant for a bot): **`Capturable`, `TerritoryDecay`, `TerritoryInfluence`, `Attack`, `ProductionQueue`, `GarrisonHolder`, `ResourceDropsite`** — foundations cannot be captured, do not decay in enemy/neutral territory, and project **no** territory (no `TerritoryInfluence`) until the building completes.

The filter also sets (`foundation.xml`):

- `<Foundation><BuildTimeModifier>0.7</BuildTimeModifier></Foundation>` — the multi-builder penalty exponent (line 11-13).
- `<Health><Initial>1</Initial></Health>` — foundations start at 1 HP (line 14-16).
- `<Obstruction><DisableBlockMovement>true</DisableBlockMovement><DisableBlockPathfinding>true</DisableBlockPathfinding></Obstruction>` — uncommitted foundations don't block units (line 23-26).
- `<Population><Bonus>0</Bonus></Population>` — no population bonus until completed (line 30-32).
- `<Vision><Range>0</Range></Vision>` — foundations have no vision (line 44-47).
- Adds the `Foundation` class to `Identity/Classes` (line 17-19).

## Step 2 — building the foundation

### Commit on first contact

A new foundation is *uncommitted*: it does not block movement at all ("to prevent players exploiting free foundations", `Foundation.js:10-15`). The first `Build()` call triggers `Commit()` (`Foundation.js:249-300`):

- Entities flagged `DeleteUponConstruction` under the footprint are destroyed; units standing in the way receive a `LeaveFoundation` order (they walk out to 4 m, `Foundation.js:260-270`, `UnitAI.js:184`); if anything still blocks, `Commit` returns false and no progress happens this tick.
- Once clear, movement/pathfinding blocking is enabled and the `OnConstructionStarted` trigger event fires.

### Build rate — exact formulas

Build progress is the foundation's health ratio: `GetBuildProgress() = HP / MaxHP` (`Foundation.js:77-84`). Raising HP raises progress.

Each builder with a `Builder` component runs a timer every **1000 ms** (`BUILD_INTERVAL`, `Builder.js:24,110`). Each tick calls `Foundation.Build(builder, rate)` with `rate = Builder.Rate` (tech/aura-modified, `Builder.js:65-68,171-176`), and:

```
deltaHP = rate × (MaxHP / BuildTime) × buildMultiplier          (Foundation.js:323, 357-363)
buildMultiplier = 1                        if N < 2
                = N^0.7 / N                if N ≥ 2 builders     (Foundation.js:223-227; 0.7 from foundation.xml:12)
```

So with N builders of rate 1, HP gain per second is `N^0.7 × MaxHP / BuildTime`, and the ideal build time is:

```
time(N) = BuildTime / N^0.7
```

The diminishing returns are per-foundation: `10^0.7 ≈ 5.01`, i.e. 10 builders finish in ~5.01× less time than 1, not 10× (`Foundation.js:220-221`). Builders with different rates contribute `rate_i × multiplier` each; the multiplier only depends on N.

`BuildTime` is the entity's `Cost/BuildTime` in seconds, tech/aura-modified, queried live each tick (`Cost.js:36-39`). Examples: house `BuildTime` 30 s, 800 HP (`public/simulation/templates/template_structure_civic_house.xml:4,22`) → 26.67 HP/s per rate-1 builder; barracks 150 s, 2000 HP (`template_structure_military_barracks.xml:7,22`) → 13.33 HP/s.

`Foundation.GetBuildTime()` (what the AI/GUI can read) returns `timeRemaining = (1 − progress) × BuildTime / (totalBuilderRate × buildMultiplier)` plus `timeRemainingNew`, the estimate if one more rate-1 builder joined (`Foundation.js:234-244`).

### Completion

When progress reaches 1.0, `ChangeEntityTemplate(this.entity, finalTemplateName)` swaps the foundation for the real building, copying position, rotation, ownership and the health ratio (100 % → full HP of the new template) (`Foundation.js:334-354`, `Transform.js:4-86`). All builders are notified via `UnitAI.ConstructionFinished` (`Foundation.js:348-353`). With `autocontinue` set, a finishing builder gathers from the new building (e.g. fields), finds nearby resources, or picks up the nearest other unfinished own foundation within 64 m and keeps building (`UnitAI.js:3187-3231,4551-4571`).

### Builder mechanics

- Who can build: units with a `Builder` component. Infantry (`template_unit_infantry.xml:2`, parent `builder|template_unit`) and female citizens (`template_unit_support_civilian.xml:2`) get `Rate 1.0` from `mixins/builder.xml`; pers slaves have `Rate 0.5` (`template_unit_support_slave.xml:3-5`). Healers and cavalry have no `Builder`.
- `Builder/Entities` lists which templates a unit may *place*; even with an empty list it "can still repair existing buildings" (and continue foundations) (`Builder.js:14`).
- Build/repair range: `max = 2 + builder's obstruction size`, `min = 0` (`Builder.js:55-63`). Checked every tick; out of range → builder stops and re-approaches (`Builder.js:162-166,190-195`, `UnitAI.js:3140-3142`).
- Target must be owned by an ally of the builder's owner (`Builder.js:81-82`) — you cannot build/repair enemy foundations or buildings.

## Repairing damaged buildings

Finished buildings have a `Repairable` component instead of `Foundation` (schema: `Repairable.js:3-10`; all structures inherit `<Repairable><RepairTimeRatio>2.0</RepairTimeRatio></Repairable>` from `template_structure.xml:94-96`). The same builder tick calls `Repairable.Repair(builder, rate)` (`Builder.js:178-183`):

```
repairRate = MaxHP / (RepairTimeRatio × BuildTime)   HP/s per unit of builder rate   (Repairable.js:159-165)
deltaHP per tick = min(remainingDamage, rate × buildMultiplier × repairRate)         (Repairable.js:130-137)
buildMultiplier = 1 if N < 2 else N^0.7 / N   (same formula, exponent hardcoded 0.7, Repairable.js:17,99-103)
```

So with the default `RepairTimeRatio = 2.0`, fully repairing a building from near 0 HP takes **2× its BuildTime** with one rate-1 builder, and `2 × BuildTime / N^0.7` with N.

- **Repairing costs no resources** — the code has a `// TODO: should we have resource costs?` (`Repairable.js:123`).
- Repair clamps at remaining damage; when full HP is reached, `MT_ConstructionFinished` fires with `entity == newentity` and builders stop (`Repairable.js:143-156`).
- A structure can be flagged unrepairable via `Repairable.SetRepairability` (`Repairable.js:39-47`).

## AutoBuildable

`AutoBuildable` lets a foundation build itself with no workers (`AutoBuildable.js`): if its `Rate` (tech/aura-modified) is non-zero, the entity registers itself as a builder of its own `Foundation` and ticks `Build` every 1000 ms (`AutoBuildable.js:23-35,51-66`). It counts as one builder in N for the `N^0.7` multiplier. In vanilla 0.28.0 **no shipped template uses `AutoBuildable`** (the only occurrence is the `merge=""` keep-rule in `special/filter/foundation.xml:4`); it exists for mods/special maps.

## What happens when builders stop mid-way

- **No decay.** There is no decay logic in `Foundation.js`, and foundations drop the `TerritoryDecay` component (see filter above), so an abandoned foundation keeps its progress forever.
- Progress simply freezes at the current HP. Any allied builder can resume it later with a `repair` order.
- Foundations can be attacked: damage lowers HP and therefore build progress (`Foundation.js:77-84`); the construction preview sinks as it takes damage (`Foundation.js:61-72`). A foundation damaged to 0 HP is destroyed.

## Destruction of a foundation and refunds

When an unfinished foundation is destroyed (killed or deleted), ownership changes to `INVALID_PLAYER` and the owner is refunded per resource (`Foundation.js:109-147`):

```
refund_r = ceil(cost_r × (1 − maxProgress))
```

- `cost_r` are the costs snapshotted at `InitialiseConstruction`, so later tech/aura cost changes don't affect the refund (`Foundation.js:48-54`).
- `maxProgress` is the **highest** progress ever reached (`Foundation.js:331-332`), not the current one — a foundation that was 80 % built and then damaged back to 10 % still refunds only 20 % of the cost.
- A finished foundation (progress 1.0) refunds nothing.

## Placement rules (`BuildRestrictions.CheckPlacement`)

Run at placement time on the foundation entity (`public/simulation/components/BuildRestrictions.js:94-322`), in this order:

1. **Visibility** — the spot must be explored (not "hidden") for the owner. **Skipped for AI players** (`BuildRestrictions.js:113-128`).
2. **Obstruction and terrain** — engine `Obstruction.CheckFoundation(passClassName)`; the pass class comes from `PlacementType`: `land` → `building-land`, `shore` → `building-shore`, `land-shore` → `default-terrain-only` (`BuildRestrictions.js:131-147`). Failure codes: `fail_obstructs_foundation` (overlaps a building-blocking entity or resource) or `fail_terrain_class` (invalid terrain) (`BuildRestrictions.js:165-184`). For `Category == "Wall"` only the center point is tested (`BuildRestrictions.js:155-159`).
3. **Territory** — based on the territory owner at the position and the template's `<Territory>` token list (default `own`, `template_structure.xml:6`):
   - own territory → needs `own`; if the territory is *blinking* (not connected), needs `neutral` (`BuildRestrictions.js:205-213`);
   - mutual ally → needs `ally`; unconnected ally territory → needs `neutral` (`BuildRestrictions.js:214-222`);
   - neutral (owner 0) → needs `neutral` (`BuildRestrictions.js:223-228`);
   - anything else → needs `enemy` (`BuildRestrictions.js:229-235`).
4. **Shore** — `PlacementType == "shore"` additionally requires `Obstruction.CheckShorePlacement()` (building must sit on a shoreline facing water) (`BuildRestrictions.js:249-256`).
5. **Distance** — optional `<Distance><FromClass>…</FromClass><MinDistance/>/<MaxDistance/></Distance>`: among the player's own entities having class `FromClass`, none may be closer than `MinDistance` and at least one must be within `MaxDistance` (`BuildRestrictions.js:264-316`). Values are tech/aura-modified per-template.

After placement, entity-category build limits (`EntityLimits.AllowedToBuild`) and technology requirements are checked (`Commands.js:1208-1238`).

## Bot-facing summary

- To build: send `{"type": "construct", "entities", "template", "x", "z", "angle", "autorepair", "autocontinue", "queued", "metadata"}` (`Commands.js:1103-1120`). The API helper `entity.construct(...)` sets `autorepair: false`, so the bot must then send `{"type": "repair", "entities", "target": <foundation id>, "autocontinue", "queued"}` itself (`public/simulation/ai/common-api/entity.js:957-975,896-899`).
- Own unfinished foundations are visible as entities with template name `foundation|<template>` and class `Foundation` (`public/simulation/ai/common-api/gamestate.js:638-654`).
- Wall construction uses a separate `"construct-wall"` command placing all pieces with obstruction control groups so segments may overlap during construction (`Commands.js:1283-1419`+).
- Cheapest estimates: one builder → `BuildTime` seconds; each extra builder multiplies speed by `N^0.7/(N-1)^0.7`, i.e. less and less — going 1→2 builders is ×1.62, 4→5 is only ×1.17.
