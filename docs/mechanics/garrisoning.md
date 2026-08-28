# Garrisoning

How units take shelter inside structures, siege engines and ships, and how they stand on walls. Grounded in 0 A.D. 0.28.0 sources: `public/simulation/components/GarrisonHolder.js`, `Garrisonable.js`, `TurretHolder.js`, `Turretable.js`, `BuildingAI.js`, `Gate.js`, `Capturable.js`, `Health.js`, `UnitAI.js`, `public/simulation/helpers/Position.js`, `public/globalscripts/Templates.js`, and the entity templates under `public/simulation/templates/`. Template paths below are relative to `public/simulation/templates/`.

## Two distinct mechanisms

0 A.D. has **two** "garrisoning-like" mechanisms, driven by different components:

1. **Garrison (inside):** the unit is stored inside a holder with a `GarrisonHolder` component. The unit is moved out of the world (`Garrisonable.js:98-100`), cannot act or be attacked, and only contributes passive effects (healing received, extra arrows, capture-point regen). The unit must have a `Garrisonable` component.
2. **Turret (on top):** the unit stands visibly on a named turret point of a holder with a `TurretHolder` component. It stays in the world, keeps its own attack, and is set to an immobile stand-ground stance (`UnitAI.js:5982-5996`). This is how units man walls and gates. The unit must have a `Turretable` component (present on all units via `template_unit.xml`).

A unit that is garrisoned or turreted cannot be ordered to garrison elsewhere (`UnitAI.js:5594-5601`).

## Who can garrison what

A unit may garrison a holder only if all of the following hold (`GarrisonHolder.js:157-176`):

- The holder's garrisoning is not blocked by `AllowGarrisoning(false, ...)` (`GarrisonHolder.js:117-131`).
- The unit is owned by the holder's owner **or a mutual ally** (`GarrisonHolder.js:171`). You can garrison allied buildings.
- The unit's `Identity` classes match the holder's `GarrisonHolder/List` class expression.
- Capacity: `OccupiedSlots() + unit's TotalSize() ≤ Max` (`GarrisonHolder.js:163`). `OccupiedSlots` sums the `Garrisonable/Size` of each garrisoned unit (`GarrisonHolder.js:145-155`); `TotalSize` additionally counts anything garrisoned *inside the garrisoned unit itself* (nested garrisoning, e.g. a loaded siege tower inside a ship — `Garrisonable.js:41-48`).
- The holder's health is strictly above `floor(EjectHealth × MaxHitpoints)` (`GarrisonHolder.js:318-326`); holders without `EjectHealth` always pass.

**Class list syntax** (`public/globalscripts/Templates.js:84-102`): the list is whitespace-separated alternatives; matching any alternative is enough. Within one alternative, `+` joins required classes (AND) and `!` negates. Example: houses use `Support+!Elephant` (support units except elephants). When a child template overrides a `datatype="tokens"` value, the tokens are **merged** with the parent's (union; `-Token` removes one) unless `replace=""` is given — engine merge semantics in `source/source/simulation2/system/ParamNode.cpp:151-193`.

**Size:** every unit inherits `Garrisonable/Size = 1` from `template_unit.xml:26-28`; no template in the game overrides it, so **1 unit = 1 slot** everywhere in 0.28.0.

### Capacities and allowed classes (generic templates)

| Holder | Max | Allowed classes | Heal (HP/s) | EjectHealth | LoadingRange |
|---|---|---|---|---|---|
| Civil Centre (`template_structure_civic_civil_centre.xml:62-69`) | 20 | Support Infantry Cavalry | 1 | 0.1 | 1 |
| House (`template_structure_civic_house.xml:13-20`) | 3 | Support+!Elephant | 0 | 0.1 | 1 |
| Temple (`template_structure_civic_temple.xml:19-26`) | 20 | Support Infantry Cavalry | 3 | 0.1 | 2 |
| Defense Tower (`template_structure_defensive_tower.xml:43-49`) | per civ | Support Infantry | 0 | 0.1 | 2 |
| Wall Tower (`template_structure_defensive_wall_tower.xml:9-16`) | 4 | Infantry | 0 | 0.1 | 2 |
| Barracks (`template_structure_military_barracks.xml:17-20`) | 10 | Infantry | 0 | 0.1 | 2 |
| Arsenal (`template_structure_military_arsenal.xml:16-19`) | 5 | Siege | 0 | 0.1 | 2 |
| Fortress (`template_structure_military_fortress.xml:55-60`) | 20 | Support Infantry Cavalry Siege | 0 | 0.075 | 6 |
| Wonder (`template_structure_wonder.xml:24-31`) | 50 | Support Soldier | 5 | 0.1 | 2 |
| Ship — base (`template_unit_ship.xml:15-23`) | 10 | Civilian Infantry Healer Dog | 0 | 0 | 10 |
| Warship (`template_unit_ship_warship.xml:27-29`) | 10 | Support Soldier Dog Relic | 0 | 0 | 10 |
| Arrow Ship (`template_unit_ship_warship_arrow.xml:37-40`) | 30 | Civilian Infantry Healer Dog **Siege** (merged) | 0 | 0 | 10 |
| Merchant Ship (`template_unit_ship_merchant.xml:9-12`) | 15 | Support Cavalry Relic | 0 | 0 | 10 |
| Battering Ram (`template_unit_siege_ram.xml:27-34`) | 10 | Support Infantry | 0 | 0.1 | 2 |
| Siege Tower (`template_unit_siege_tower.xml:50-57`) | 20 | Support Infantry | 0 | 0.1 | 2 |

(`EjectHealth`, `BuffHeal`, `LoadingRange` not shown on a child template are inherited from its parent, e.g. military structures from `template_structure_military.xml:6-11`.)

## Entering

- The garrison order makes the unit move within the holder's `LoadingRange` (max; min is 0 — `GarrisonHolder.js:64-67`, `Garrisonable.js:21-25`), then enter the `GARRISONING` state which calls `Garrison()` immediately (`UnitAI.js:1197-1237`, `3235-3310`). **There is no enter timer or animation delay in the simulation** — entry is instant once in range.
- On entering, the unit is moved out of the world and its `UnitAI` is flagged garrisoned (`Garrisonable.js:92-105`).
- **Pickup:** holders with `<Pickup>true</Pickup>` (all ships, `template_unit_ship.xml:22`) move toward the unit to pick it up when the unit requests it (`GarrisonHolder.js:69-75`, `UnitAI.js:1211-1216`).

## Leaving

- Ungarrisoning needs a free spawn position adjacent to the holder's footprint (`PositionHelper.GetSpawnPosition`, `public/simulation/helpers/Position.js:142-169`); if none exists the unit **stays inside** (`Garrisonable.js:119-121`). For a sinking ship (0 HP) the spawn point must be passable by both ship and unit (`Position.js:151-157`); for forced ejects with no valid point the holder's centre is used (`Position.js:159-167`).
- The unit is placed at that position, facing away from the holder, and is then ordered to the holder's rally point if any (`Garrisonable.js:127-158`). `UnloadAll` / "unload by owner/template" all go through the same path (`GarrisonHolder.js:234-306`).
- If `AllowGarrisoning(false)` was set by any component, units can neither enter nor leave until re-allowed (`GarrisonHolder.js:106-131`); forced ejects bypass this (`GarrisonHolder.js:209-212`).

## Healing while garrisoned

- A holder with `BuffHeal > 0` runs a 1-second interval timer (`GarrisonHolder.js:39`, `328-334`) that heals **every** garrisoned unit by `BuffHeal` HP per tick — i.e. `BuffHeal` is in **HP/second** (`GarrisonHolder.js:348-363`). Unhealable units (ships, siege) are skipped (`GarrisonHolder.js:360`).
- The timer runs only while the holder has garrisoned units and a positive heal rate (`GarrisonHolder.js:350-355`).
- Independently, a unit's own `Health/IdleRegenRate` also applies "when idle or garrisoned" (`Health.js:35`); it is 0 for generic units.
- Reference rates: Civil Centre 1 HP/s, Temple 3 HP/s, Wonder 5 HP/s; towers, houses, fortresses, ships and siege heal 0 (table above).

## Extra arrows from garrisoned units (BuildingAI)

Structures with a `BuildingAI` component fire arrows automatically at enemies in range. Garrisoned units increase the volley:

```
arrowCount = min( DefaultArrowCount + round(garrisonedMatching × GarrisonArrowMultiplier), MaxArrowCount )
```

(`BuildingAI.js:256-262`; `MaxArrowCount` defaults to ∞ if absent — `BuildingAI.js:228-235`.)

- `garrisonedMatching` = number of garrisoned units whose classes match `GarrisonArrowClasses` (`BuildingAI.js:34-49`). The unit's own attack stats are **irrelevant** — only its class membership and the count matter.
- Firing cycle: one volley of `arrowCount` arrows per `Attack/Ranged/RepeatTime`, spread over 20 sub-rounds (`repeat/20` interval, `BuildingAI.js:1-3`, `206-220`, `287-322`); the first quarter of rounds fire in a burst, and targets are chosen by attack preference then proximity (`BuildingAI.js:330-358`).
- Values: Defense Tower 2 + 1×Infantry (`template_structure_defensive_tower.xml:28-32`); Civil Centre 6 + 1×Soldier (`template_structure_civic_civil_centre.xml:41-45`); Fortress 10 + 1×Soldier (`template_structure_military_fortress.xml:35-39`); Sentry Tower caps at 6 arrows (`template_structure_defensive_tower_sentry.xml:12-14`); Siege Tower has `DefaultArrowCount 0`, `MaxArrowCount 10`, +1×Infantry — it **only shoots when garrisoned** (`template_unit_siege_tower.xml:33-38`). Artillery and bolt towers have `GarrisonArrowMultiplier 0` — garrisoning adds nothing (`template_structure_defensive_tower_artillery.xml:34`, `template_structure_defensive_tower_bolt.xml:31`).
- **Wall Towers have no `BuildingAI`** (verified: `template_structure_defensive_wall_tower.xml` has none) — garrisoning infantry in a wall tower is purely protective; they add no arrows.

## Walls and gates (turrets, not garrison)

Wall segments and gates do **not** have a `GarrisonHolder`. Units stand on them via `TurretHolder` turret points:

- Each turret point has an XYZ offset, optional `AllowedClasses` and `Ejectable` flag (default true — `TurretHolder.js:12-25`). A unit can occupy a free point if owned by the holder's owner or a mutual ally (`TurretHolder.js:80-93`); approach range is `LoadingRange` (default **2** when unspecified — `TurretHolder.js:264-267`).
- Turreted units stay in the world: their obstruction is disabled for pathing, they are immobilised and switched to a stand-ground stance (`Turretable.js:77-93`, `UnitAI.js:5982-5996`), so they **fight with their own attack stats** from the wall. Ranged soldiers on walls are the wall's only armament.
- Capacities (rome example): long wall 16 points (`structures/rome/wall_long.xml`), medium wall 8 points, gate 10 points (`structures/rome/wall_gate.xml`); counts are per-civ template data.
- **Wall Protection aura:** wall long/medium/gate templates carry `structures/wall_garrisoned` (`template_structure_defensive_wall_long.xml:3-5`, `template_structure_defensive_wall_gate.xml:3-5`), a `turretedUnits`-type aura giving every **turreted Soldier +3 hack/pierce/crush resistance and +20 vision range** (`public/simulation/data/auras/structures/wall_garrisoned.json`). It does not apply to units garrisoned *inside* wall towers.
- **Gates** are separate: the `Gate` component opens the pass when a mobile allied unit is within `PassRange` (2 m — `template_structure_defensive_wall_gate.xml:14-16`, `Gate.js:67-114`) and closes when none remain (and nothing blocks the doorway, retried every turn — `Gate.js:247-283`). Locking forbids opening entirely (`Gate.js:171-193`). Only allies trigger opening; enemies must capture or destroy the gate.
- A long wall can be converted into a gate in-game via the `Upgrade` component (`template_structure_defensive_wall_long.xml:24-30`).

## Ships and siege

- Ships are `GarrisonHolder`s with large `LoadingRange` (10) and `Pickup=true` (they sail to the unit). Garrisoned units are cargo: no arrows, no healing. Siege ships/warships are `Unhealable` themselves but that does not block healing of their cargo (n/a here since `BuffHeal` is 0).
- Rams (10 slots) and siege towers (20 slots) carry Support/Infantry (`template_unit_siege_ram.xml:27-34`, `template_unit_siege_tower.xml:50-57`); the siege tower converts garrisoned Infantry into arrows (above). Arsenals can store 5 `Siege` units (`template_structure_military_arsenal.xml:16-19`).

## Capture interaction

Full capture mechanics are documented in `capture.md`; only the garrison interplay is stated here:

- Each garrisoned unit that has a `Capture` attack adds `captureStrength × Capturable/GarrisonRegenRate` capture points per second to the **owner's** capture-point regeneration of the holder (`Capturable.js:183-200`). Generic structures use `GarrisonRegenRate 1.0` (`template_structure.xml:12`). Garrisoning defenders therefore actively resists capture.
- When the holder changes owner (captured), every garrisoned unit that is not a mutual ally of the new owner is ejected or killed (see below) — they never change hands with the building (`GarrisonHolder.js:393-410`).
- The same applies to turreted units: on ownership change, non-allied turreted units leave their turret; units occupying `Ejectable=false` turret points instead switch owner with the holder (`TurretHolder.js:384-418`).

## Destruction of the holder

- Whenever the holder's hitpoints drop to `≤ floor(EjectHealth × MaxHitpoints)` (checked on every health change), **all** garrisoned units are ejected-or-killed (`GarrisonHolder.js:312-326`, `446-482`):
  - units whose classes match `EjectClassesOnDestroy` (typically `Unit`, i.e. everything) are unloaded at a spawn point;
  - all others are killed.
- Destruction is just the HP = 0 case of the same path, so with the usual `EjectClassesOnDestroy = Unit` and `EjectHealth 0.1`, garrisoned units **survive** the building's destruction, popping out once it falls below 10% HP.
- Exception — nested holders: if the holder itself is not in the world (e.g. a loaded ship inside a transport), ejection is skipped and the units are killed outright (`GarrisonHolder.js:447-456`).
- Turreted units on a destroyed holder: forced `LeaveTurret`, falling back to kill if leaving fails (`TurretHolder.js:284-305`, `Turretable.js:186-187` on owner change to `INVALID_PLAYER`).
- Diplomacy change (ally → enemy) also ejects-or-kills now-foreign garrisoned units (`GarrisonHolder.js:437-440`).

## Edge cases for a bot

- Garrisoned units are out of the world: they cannot attack, be attacked, gather or be seen; use the holder's `GarrisonedUnitsChanged` messages / `GetEntities()` to track them.
- `EjectHealth` means a battered building (≤10% HP for most structures, 7.5% for fortresses) refuses new garrison orders and dumps its contents — do not plan a "hide in the CC" retreat for a nearly-dead CC.
- Ungarrison can silently fail (no free spawn point); the order then does nothing and the unit stays inside.
- The unit's identity classes — not its attack type — decide both garrison permission and arrow contribution: a melee spearman garrisoned in a tower adds an arrow just like an archer (both are `Infantry`).
- A garrisoned unit that is itself carrying units (loaded siege tower) occupies `1 + its load` slots.
- `TurretHolder.IsFull()` is inverted in 0.28.0 — it returns true when a *free* point exists (`TurretHolder.js:256-259`); it only gates `CanPickup`, which walls/gates never use (no `Pickup` in their templates), so it is harmless in practice but do not rely on it.
- Healing while garrisoned stacks with any regeneration the unit already has, but never exceeds its max HP.
