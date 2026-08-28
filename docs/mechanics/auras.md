# Auras (mechanic) — 0 A.D. 0.28.0

How auras work in the engine. This file documents the **mechanic only**; the list of concrete auras is data and is documented elsewhere. Grounded in `public/simulation/components/Auras.js` (the `Auras` component), `public/simulation/data/auras/**` (aura data files, JSON), `public/globalscripts/ModificationTemplates.js` (aura template loading and modification derivation), `public/globalscripts/Technologies.js` and `public/simulation/components/ModifiersManager.js` (value modification), `public/simulation/helpers/ValueModification.js`, and `source/source/simulation2/components/CCmpRangeManager.cpp` (range queries). Paths below are relative to `/home/ubuntu/0ad-reference`.

## Overview

An aura is a named set of stat modifications emitted by an entity (the *source*) and applied to other entities (the *targets*). The source's entity template lists its auras in the `Auras` component as a whitespace-separated list of aura file names (`Auras.js:3-7`, `GetAuraNames` splits `template._string` on whitespace, `Auras.js:46-49`). Aura files are JSON under `simulation/data/auras/`, loaded once into the global `AuraTemplates` cache (`public/globalscripts/ModificationTemplates.js:41-45`).

Application pipeline: `Auras.js` decides **which entities** an aura touches (type, radius, players, classes), then registers modifiers with the system `ModifiersManager` (`AddModifiers`, `Auras.js:444-446`). Whenever a component reads a stat, it passes the raw template value through `ApplyValueModificationsToEntity` / `ApplyValueModificationsToTemplate` (`public/simulation/helpers/ValueModification.js:3-21`), which returns the value with all registered modifiers applied. Auras never mutate templates; they are a lookup-time overlay.

## Aura JSON schema

Fields seen in the data files and read by `Auras.js`:

| Field | Meaning |
|---|---|
| `type` | One of `range`, `global`, `player`, `formation`, `garrison`, `garrisonedUnits`, `turretedUnits` (type predicates at `Auras.js:169-207`). No default — every file sets it. |
| `radius` | Range in metres for `type: "range"` auras only (`Auras.js:61-66`). Ignored otherwise. |
| `affects` | Array of class expressions selecting valid targets (`Auras.js:68-71`). See *Target selection*. |
| `affectedPlayers` | Which players' entities can be targets; default `["Player"]` (`Auras.js:116`). See *Affected players*. |
| `modifications` | Array of `{ "value": <path>, "add"|"multiply"|"replace"|"tokens": ... }`, optionally with a per-modification `affects` class expression (`public/globalscripts/ModificationTemplates.js:65-83`). `value` is a component property path, e.g. `Attack/Melee/Damage/Hack`, `ResourceGatherer/Rates/food.grain`, `Player/MaxPopulation`. |
| `requiredTechnology` | The aura is inert until the owner has researched this tech (`Auras.js:142-152`). Example: `structures/wonder_population_cap.json`. |
| `stackable` | If `true`, multiple sources of this aura stack (default: no stacking). See *Stacking*. |
| `auraName`, `auraDescription` | GUI text only. |
| `overlayIcon` | Status-bar icon shown on affected entities (`Auras.js:424-430`). Cosmetic. |
| `rangeOverlay` | `{lineTexture, lineTextureMask, lineThickness}` for the selection ring; defaults to `outline_border.png` / thickness 0.2 (`Auras.js:100-108`). Cosmetic. |

Examples: `simulation/data/auras/units/centurion.json` (range 30, `affects: ["Soldier"]`, four modifications), `simulation/data/auras/teambonuses/rome_player_teambonus.json` (global, `affectedPlayers: ["MutualAlly"]`), `simulation/data/auras/structures/farmstead_60.json` (range 60, `affects: ["Worker", "Field"]`, explicit `"stackable": false`).

## Aura types and how targets are found

- **`range`**: an active query is created on the `RangeManager`, centred on the source, min range 0, max range `radius`, restricted to entities with an `Identity` component, the `normal` entity flag, and an affected owner; entity footprints are **not** accounted for — distance is centre-to-centre (`Auras.js:279-293`). Every simulation turn, entities entering/leaving the circle produce `added`/`removed` lists handled by `OnRangeUpdate` → `ApplyAura`/`RemoveAura` (`Auras.js:317-324`).
- **`global`**: no per-entity lookup. Modifications are registered once on each affected **player entity** (`ApplyTemplateAura`, `Auras.js:356-374`) and therefore apply template-wide to all that player's matching entities, including future ones. Status-bar icons, if any, are applied per entity (`Auras.js:254-262`).
- **`player`**: modifications applied directly to the affected player entities via `ApplyAura` (`Auras.js:264-268`). Used for player-level stats such as `Player/MaxPopulation` (`structures/wonder_population_cap.json`).
- **`formation`**: applied/removed to formation members by the `Formation` component itself (`Formation.js:369,406,410,439,455`). No aura file in 0.28.0 uses this type.
- **`garrison`**: the aura lives on a **unit** and targets the structure it is garrisoned in, e.g. `units/heroes/hero_garrison.json`. Applied/removed on `MT_GarrisonedStateChanged` (`Auras.js:528-537`, message posted by `Garrisonable.js:102,145`).
- **`garrisonedUnits`**: the aura lives on a **holder** (structure/ship) and targets the entities garrisoned inside it, e.g. `structures/athen_prytaneion_hero_heal.json`. Applied/removed on `MT_GarrisonedUnitsChanged` (`Auras.js:326-333`, message posted by `GarrisonHolder.js:196,221,476`).
- **`turretedUnits`**: same as `garrisonedUnits` but for turreted entities, via `OnTurretsChanged` (`Auras.js:335-342`).

In 0.28.0 data the type counts are: 72 `range`, 63 `global`, 6 `garrison`, 4 `garrisonedUnits`, 3 `player`, 1 `turretedUnits`, 0 `formation`.

## Affected players

`affectedPlayers` is resolved per aura into a player-ID list (`CalculateAffectedPlayers`, `Auras.js:114-140`): the literal `"Player"` means the source's owner; any other value `X` is resolved by calling `cmpDiplomacy["Is" + X](i)`. The `Diplomacy` component provides `IsAlly`, `IsExclusiveAlly`, `IsMutualAlly`, `IsExclusiveMutualAlly`, `IsEnemy`, `IsNeutral` (`Diplomacy.js:202-294`). Values used in the 0.28.0 data: `Player`, `Ally`, `MutualAlly`, `ExclusiveMutualAlly`, `Enemy`. Defeated players are skipped both as sources and targets (`Auras.js:123-124,134-135`). The list is only recomputed in `Clean()`; diplomacy changes and ownership changes trigger a `Clean` (`Auras.js:487-499`).

## Target selection: class matching

An entity in range (or garrisoned, etc.) only becomes a target if its `Identity` classes match the aura's `affects` (`GiveMembersWithValidClass`, `Auras.js:308-315`). Matching uses `MatchesClassList` (`public/globalscripts/Templates.js:84-103`): `affects` is an **OR** of entries; within one entry, space- or `+`-separated tokens are **AND**ed; a leading `!` negates a class. So `["Worker", "Field"]` matches Workers or Fields, and `["Soldier !Ship"]` would match soldiers that are not ships.

Class filtering happens twice: once when the aura picks targets (`Auras.js:308-315`), and again at value-lookup time, because each derived modification carries its own `affects` (the aura-level classes, plus any per-modification `affects` appended — `public/globalscripts/ModificationTemplates.js:60-83`) and `DoesModificationApply` re-checks them against the reading entity's classes (`public/globalscripts/Technologies.js:93-98`).

## How a modification changes a value

Registered modifiers are stored per (property path, entity) in the `ModifiersManager` (`ModifiersManager.js:262-268`). When a component reads a stat through `ApplyValueModificationsToEntity`, the manager applies, in order, **player-wide modifiers first, then entity-local ones** (`ModifiersManager.js:162-172`). The arithmetic for a numeric value is (`public/globalscripts/Technologies.js:46-65`):

```
result = originalValue * (product of all matching "multiply") + (sum of all matching "add")
```

- Any matching `replace` modification short-circuits and wins immediately (`Technologies.js:55-56`).
- String values support `replace` and `tokens` (`"A>B"` replaces token A by B, `"-A"` removes, anything else adds — `Technologies.js:104-127`).
- Auras and technologies share this machinery: they differ only in the modifier identifier prefix (`aura/…` vs `tech/…`, `Auras.js:22-27` vs `TechnologyManager.js:102`), so a tech and an aura affecting the same path compose through the same formula.
- Results are cached and invalidated via `MT_ValueModification` messages when modifiers change (`ModifiersManager.js:51-64`).

## Stacking

**Two sources of the same aura do not stack, unless the aura file sets `"stackable": true`.** The modifier identifier is `aura/<name>` for normal auras and `aura/<name><entityID>` for stackable ones (`GetModifierIdentifier`, `Auras.js:21-27`). Since the `MultiKeyMap` storage keys modifiers by ID, a second source with the same ID only increments a reference count without adding a new value (`public/globalscripts/MultiKeyMap.js:177-188`). Consequences:

- Two identical heroes standing together give the bonus **once**. Two farmsteads covering the same field give the bonus once (`farmstead_60.json` sets `"stackable": false` explicitly).
- A stackable aura (e.g. `structures/wonder_population_cap.json`, several wonders) multiplies per source.
- **Different** auras (different files/names) affecting the same value always compose — their IDs differ, so both land in the formula above.
- Reference counting also means removal is symmetric: the bonus disappears only when the last non-stackable source leaves (`MultiKeyMap.js:193-218`).

## Timing and lifecycle

- **Recomputation (`Clean`)**: `Auras.prototype.Clean` removes every modifier, recomputes affected players, checks `requiredTechnology`, and recreates range queries (`Auras.js:212-306`). It runs at init, on ownership change, on diplomacy change, when the required tech finishes researching, and when an affected player is defeated (`Auras.js:487-526`).
- **Range application delay**: active queries are re-evaluated once per simulation turn (`MT_Update` → `ExecuteActiveQueries`, `CCmpRangeManager.cpp:796-800,1137`), and the default turn length is 200 ms (`source/source/simulation2/system/TurnManager.h:62`). A unit walking into an aura's radius gets the effect at the next turn boundary, not instantly.
- **`requiredTechnology` not yet researched**: the aura's targets are still tracked, but `isApplied` is false so no modifiers (and no range query) are registered (`Auras.js:248,279,358-359`). When the tech completes, `OnGlobalResearchFinished` triggers a `Clean` and the aura activates (`Auras.js:501-515`).
- **Defeated owner**: `CalculateAffectedPlayers` returns an empty list, so the aura does nothing (`Auras.js:123-124,251-252`).

## Garrison and formation interactions

- **Garrisoned targets are invisible to range auras.** Garrisoning moves the unit out of the world (`Garrisonable.js:100`), and range queries skip entities without the `InWorld` flag (`CCmpRangeManager.cpp:1202-1204`) — they are reported as `removed` on the next turn.
- **A garrisoned source's range aura switches off.** If the source entity has no in-world position, its query matches nothing, so all current targets receive a `removed` notification (`CCmpRangeManager.cpp:1156-1161`). Effects on other units return when the source ungarrisons. This is why garrison-conditional buffs are separate `garrison`-type auras rather than range auras.
- Formation controller entities are explicitly excluded from range auras by clearing their `normal` flag (`Formation.js:619-621`).

## Edge cases a bot should care about

- The aura **source never targets itself** (`CCmpRangeManager.cpp:1209-1210`); a hero does not buff itself with its own range aura.
- Because stacking is by aura name, one hero is enough for the whole army — extra copies add nothing (unless `stackable`).
- Multiplicative buffs compose multiplicatively: two different `×1.1` damage auras give `×1.21`, not `×1.2` (`Technologies.js:57-58,64`).
- Enemy auras exist (`affectedPlayers: ["Enemy"]`): standing near an enemy hero can *debuff* your units.
- AI-facing reads go through the same modified values, so entity stats already include active aura effects; the aura list of an entity is exposed by the `Auras` component itself (`GetAuraNames`, `GetModifications`, `GetAffectedEntities`).
