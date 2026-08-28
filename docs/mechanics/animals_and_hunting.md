# Animals and hunting (0 A.D. 0.28.0)

How fauna entities behave: their categories and stances, the `FLEEING` order
that makes huntable animals run away, the speeds involved, and what happens
when an animal dies (the meat corpse). Grounded in `public/simulation/components/UnitAI.js`
(stance table, the `FLEEING`/`Flee` orders, `Run()`), the fauna templates
`public/simulation/templates/template_unit_fauna*.xml` and
`public/simulation/templates/gaia/fauna_*.xml`, the base unit template
`public/simulation/templates/template_unit.xml`, the corpse filter
`public/simulation/templates/special/filter/resource.xml`, and
`public/simulation/components/Health.js` (corpse creation). Paths below are
relative to `/home/ubuntu/0ad-reference`.

## Fauna categories

The template chain starts at `template_unit_fauna` (parent `template_unit`),
with three branches:

| Branch | Templates | Examples |
|---|---|---|
| Herd | `template_unit_fauna_herd` → `..._herd_domestic` | chicken, peacock, sheep, goat, pig, cattle |
| Hunt | `template_unit_fauna_hunt` → `..._hunt_passive`, `..._hunt_skittish`, `..._hunt_passive-defensive`, `..._hunt_defensive` | skittish: deer, gazelle, horse, rabbit, camel; passive-defensive: boar, elephant; defensive: bear |
| Wild | `template_unit_fauna_wild` → `..._wild_aggressive`, `..._wild_defensive` | aggressive: dogs; defensive: wolf, lion |

`template_unit_fauna.xml` sets: population cost 0, footprint 2×4 m,
`UnitAI/DefaultStance` `passive`, `UnitAI/FleeDistance` 24.0, `Vision/Range`
90, `UnitMotion/WalkSpeed` ×0.7 (base 9 m/s from `template_unit.xml:127`),
and disables Guard/Loot. `template_unit_fauna_herd.xml` and
`template_unit_fauna_hunt.xml` add the meat supply:
`ResourceSupply` with `KillBeforeGather true`, `Type food.meat`, `Max 100`,
`MaxGatherers 8`. `_herd_domestic` adds the `Domestic` class and narrows
`Vision/Range` to 6; `_hunt_skittish` sets `Vision/Range` to **0**.

## Stances and which animals flee

The stance table is `g_Stances` (`UnitAI.js:75-170`). The fauna stances in
use:

| Stance | `respondFlee` | `respondFleeOnSight` | Fauna using it |
|---|---|---|---|
| `passive` | true | false | herd and `hunt_passive` (DefaultStance from `template_unit_fauna.xml:32-35`) |
| `skittish` | true | true | `hunt_skittish` (`template_unit_fauna_hunt_skittish.xml`) |
| `aggressive` | false | false | `wild_aggressive` (dogs: `template_unit_fauna_wild_aggressive_dog.xml`) |
| `defensive` | false | false | `hunt_defensive` (bear), `wild_defensive` (wolf, lion) |
| `passive-defensive` | false | false | `hunt_passive-defensive` (boar, elephant) |

Only `passive` and `skittish` animals flee. The others have an `Attack`
component (`gaia/fauna_boar.xml`, `fauna_bear_brown.xml`, `fauna_wolf.xml`,
`fauna_lion.xml`, `fauna_elephant_african_bush.xml`) and retaliate instead:
`aggressive`/`defensive` attack visible enemies, `passive-defensive` attacks
attackers inside its hold-ground zone (`UnitAI.js:5095-5107`).

Note the skittish contradiction: `respondFleeOnSight` is true but
`Vision/Range` is 0 (`template_unit_fauna_hunt_skittish.xml:6-8`), so a
skittish animal can never *see* an enemy — the only thing that makes it flee
is being attacked.

## The flee order (`FLEEING`)

Trigger: on the `"Attacked"` message, `RespondToTargetedEntities`
(`UnitAI.js:5095-5107`) pushes a `"Flee"` order at the front of the queue
targeting the first attacker, when the stance has `respondFlee`. (The
sight-based path `respondFleeOnSight` → `Flee` is in `RespondToSightedEntities`,
`UnitAI.js:5114-5125`.)

`FLEEING` enter (`UnitAI.js:2013-2026`):

- `distanceToFlee = DistanceBetweenEntities(animal, attacker) + template.FleeDistance` — computed **once at enter** and never recomputed. `FleeDistance` is 24.0 for most fauna (`template_unit_fauna.xml:36`); the chicken overrides it to 12.0 (`gaia/fauna_chicken.xml`).
- The animal is ordered with `MoveToTargetRange(attacker, distanceToFlee, -1)`: it runs until it is `distanceToFlee` away from the attacker. `MoveToTargetRange` keeps the animal at the requested distance from the target, i.e. it runs **directly away** from it.
- `this.Run()` (`UnitAI.js:6193-6196`) sets the speed multiplier to `UnitMotion/RunMultiplier` — 1.67 from the base unit template (`template_unit.xml:128`) — so flee speed = WalkSpeed × 1.67.
- The order finishes (`FinishOrder`) when `CheckTargetRangeExplicit(attacker, distanceToFlee)` passes (`UnitAI.js:2035-2036`, re-checked every movement tick, `UnitAI.js:2057-2058`). Both the movement target and the finish check are evaluated against the attacker's **live** position, so a fleeing animal keeps running away from wherever the attacker currently is.

While fleeing, a new `"Attacked"` message from a *closer* attacker replaces
the flee target (`UnitAI.js:2049-2058`). A fleeing animal therefore always
runs away from the nearest thing hitting it.

## Flee speeds

Walk speeds are inherited from `template_unit.xml` (`WalkSpeed` 9,
`RunMultiplier` 1.67, lines 127-128) through the ×0.7 fauna multiplier
(`template_unit_fauna.xml:48`) and per-animal overrides. Flee speed = walk ×
1.67.

| Animal | WalkSpeed modifiers | Walk (m/s) | Flee (m/s) | Source |
|---|---|---|---|---|
| Chicken | ×0.7 (fauna), ×0.15 (chicken) | 0.95 | 1.58 | `gaia/fauna_chicken.xml` |
| Peacock | ×0.7, ×0.3 | 1.89 | 3.16 | `gaia/fauna_peacock.xml:45` |
| Sheep / goat / pig / camel | ×0.7, ×0.45 | 2.84 | 4.73 | `gaia/fauna_sheep.xml:43`, `fauna_goat.xml:43`, `fauna_pig.xml:43`, `fauna_camel.xml:35` |
| Deer / gazelle | ×0.7, ×0.6 | 3.78 | 6.31 | `gaia/fauna_deer.xml`, `fauna_gazelle.xml` |
| Horse | ×0.7, ×0.8 | 5.04 | 8.42 | `gaia/fauna_horse.xml:36` |
| Rabbit | ×0.7 only | 6.30 | 10.52 | `gaia/fauna_rabbit.xml` (no override) |
| Cattle | ×0.7, ×0.4, RunMultiplier 1.4 | 2.52 | 3.53 | `template_unit_fauna_herd_domestic_cattle.xml:17-18` |

For reference, the gaul cavalry javelineer walks at 16.2 m/s and runs at
22.68 m/s — faster than every fleeing animal, so a horse can always chase
one down.

## Meat amounts, health and gatherers

Meat supply values (`ResourceSupply/Max`, `food.meat`, `KillBeforeGather`):

| Animal | Meat | Health | MaxGatherers | Source |
|---|---|---|---|---|
| Chicken | 40 | 5 | 5 | `gaia/fauna_chicken.xml` |
| Rabbit | 50 | 5 | 8 | `gaia/fauna_rabbit.xml` |
| Sheep | 100 | 50 | 3 | `gaia/fauna_sheep.xml` |
| Goat | 70 | 35 | 2 | `gaia/fauna_goat.xml` |
| Pig | 150 | 75 | 4 | `gaia/fauna_pig.xml` |
| Deer / gazelle | 100 | 25 | 8 | `template_unit_fauna_hunt.xml` |
| Horse | 200 | 50 | 8 | `gaia/fauna_horse.xml` |
| Camel | 200 | 50 | 8 | `gaia/fauna_camel.xml` |
| Boar | 150 | 50 | 8 | `gaia/fauna_boar.xml` |
| Elephant (african bush) | 800 | 300 | 8 | `gaia/fauna_elephant_african_bush.xml` |

`KillBeforeGather true` means a gather order on a living animal is converted
into an attack order; the meat only becomes gatherable once the animal is
dead.

## The corpse

On death, `Health.js` replaces the animal with a **new** entity named
`resource|fauna_<template>` (`Health.js:351-354`), built by applying the
filter `special/filter/resource.xml` to the animal template. The filter
keeps only: AIProxy, Footprint, Identity, Minimap, Obstruction,
OverlayRenderer, Ownership, Position, ResourceSupply, Selectable,
StatusBars, VisualActor — so the corpse:

- keeps the `ResourceSupply` (the meat amount) but has **no `Health`**, no
  `UnitMotion`, no `Vision`/`Visibility` and no `Attack`;
- does not block movement or pathfinding (`Obstruction/BlockMovement` and
  `BlockPathfinding` false) but **blocks construction** and is deleted when a
  building is placed on it (`BlockConstruction true`, `DeleteUponConstruction
  true`);
- never decays: no fauna template defines `<ResourceSupply><Change>`, and the
  corpse keeps that component unchanged — the meat amount is fixed until
  gathered. When the amount reaches 0 the entity is destroyed
  (`ResourceSupply.js:240-241`).

## Edge cases a bot should know

- The fleeing animal's target is the **first** attacker, but a closer new
  attacker steals the flee — and the flee direction is always away from the
  attacker's current position, so where the animal ends up depends on where
  the attacker stands.
- A stopped skittish animal will not move again unless attacked anew
  (`Vision/Range` 0).
- The corpse is a different entity id from the living animal: an order
  targeting the living animal's id is lost on death; the corpse must be
  found again (by position or entity query).
- `MaxGatherers` counts approaching units, so queuing more than the cap on
  one carcass sends the extras to the find-another-supply fallback.
- Animals with `Attack` (boar, bear, wolf, lion, elephant, …) never flee and
  will kill gatherers — they are not safe hunting targets.
