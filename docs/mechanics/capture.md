# Capture

How buildings (and a few other entities) change ownership without being destroyed in 0 A.D. 0.28.0. Grounded in `public/simulation/components/Capturable.js`, the Capture attack handling in `public/simulation/components/Attack.js` and `public/simulation/helpers/Attack.js`, `public/simulation/components/GarrisonHolder.js`, `public/simulation/components/TerritoryDecay.js`, `public/simulation/components/ProductionQueue.js`, `public/simulation/components/Trainer.js` and the simulation templates (paths below relative to `/home/ubuntu/0ad-reference`).

## Capture points model

- An entity is capturable iff its template carries the `Capturable` component (`public/simulation/components/Capturable.js:3`). It holds three template values: `CapturePoints` (maximum CP), `RegenRate` (CP/s regenerated for the owner), `GarrisonRegenRate` (per-garrisoned-unit regen factor).
- At runtime the entity stores an array `capturePoints[playerID]`, one entry per player (index 0 = gaia), whose sum is always `maxCapturePoints` (`public/simulation/components/Capturable.js:19`, `:126`). On creation the owner gets all points (`public/simulation/components/Capturable.js:336-347`).
- Default structure values (`public/simulation/templates/template_structure.xml:9-13`): **500 CP, RegenRate 5, GarrisonRegenRate 1.0**. Notable overrides: civil centre 2500 CP / RegenRate 30 (`public/simulation/templates/template_structure_civic_civil_centre.xml:46-49`), wonder 500×4 = 2000 CP (`public/simulation/templates/template_structure_wonder.xml:9-11`), farmstead 300 CP (`public/simulation/templates/template_structure_economic_farmstead.xml:10`), army camp tent 25 CP (`public/simulation/templates/structures/tent_rome.xml:7`).

## Which units can capture

A unit captures via the `Capture` attack type (`public/simulation/components/Attack.js:3`). Generic template values (all with range 4 m, repeat time 1000 ms, restricted classes `Field Palisade Wall`):

| Unit template | Capture strength |
|---|---|
| `template_unit_infantry` | 2.5 |
| `template_unit_cavalry` | 1.75 |
| `template_unit_champion` | 5 |
| `template_unit_champion_cavalry` | 3.5 |
| `template_unit_hero` | 10 |
| `template_unit_support_civilian` | 1.0 |

Siege engines and ships have no `Capture` attack section (no match in `template_unit_siege*` / `template_unit_ship*`), so they cannot capture; elephants explicitly disable it (`public/simulation/templates/template_unit_champion_elephant_melee.xml:4`).

Eligibility checks per attack (`public/simulation/components/Attack.js:285-301`): the target must have a `Capturable` component, `Capturable.CanCapture(attackerOwner)` must hold — i.e. some enemy of the attacker still holds CP in the target (`public/simulation/components/Capturable.js:139-151`) — and the target must not match the attack's `RestrictedClasses`. Walls and palisades therefore can never be captured by units even though they inherit the component; gaia-owned entities are capturable (gaia is enemy of everyone).

## Effective capture strength

Each capturer attacks independently on its own repeat timer; per hit the applied CP amount is (`public/simulation/helpers/Attack.js:164-185`):

```
effectiveCapture = Capture × 0.9^(captureResistance) × bonusMultiplier / (0.1 + 0.9 × HP/maxHP)
```

- No structure template defines a `Capture` resistance (`public/simulation/templates/template_structure.xml:97-124` only lists Damage and ApplyStatus), so the `0.9^x` factor is 1 in practice.
- The health factor means a damaged building is captured **faster**: at full HP the divisor is 1, at near-zero HP it approaches 0.1 → up to 10× faster capture. A building at 50% HP is captured ~1.82× faster.
- `bonusMultiplier` comes from the attacker's attack `Bonuses` vs the target's classes (`public/simulation/helpers/Attack.js:309`).
- Multiple capturers stack linearly: N identical units deliver N × effectiveCapture CP/s. Each hit removes CP equally from **all** enemy-held pools of the captor and credits the total to the captor's own pool (`public/simulation/components/Capturable.js:95-131`).

Worked example (default structure, 500 CP, full HP, no garrison): one infantry spearman (2.5 CP/s) vs RegenRate 5/s makes **no progress at all** — the building regenerates faster than one unit captures. Net capture rate = Σ effectiveCapture − regenRate − Σ garrisoned contributions. 20 spearmen (50 CP/s) net 45/s → ~11 s to flip, ignoring decay.

## Ownership flip threshold

Ownership flips the moment the owner's CP pool reaches 0 (`public/simulation/components/Capturable.js:167-176`): the new owner is the player holding the **most** CP (strict `>` over the array, so on ties the lowest player ID wins; gaia at index 0 can become owner). The old owner's `StatisticsTracker.LostEntity` and the new owner's `CapturedEntity` are called. There is no intermediate "neutral" state and no minimum-CP threshold — a single CP more than every other player is enough.

## Regeneration and decay

- A 1-second timer runs whenever regen or decay is active and stops itself when a tick changes nothing (`public/simulation/components/Capturable.js:254-268`, `:239-246`).
- Per tick the owner's pool is refilled by `GetRegenRate()` = `RegenRate` + Σ over garrisoned units of (their **raw** Capture attack strength × `GarrisonRegenRate`) (`public/simulation/components/Capturable.js:183-201`). Garrisoned units without a Capture attack contribute nothing. Regen removes points from the owner's enemies and credits the owner (`Reduce(regenRate, owner)`, `:237`) — it cannot exceed maxCapturePoints.
- **Territory decay**: structures decay in `neutral` or `enemy` territory (`Territory` list) at `DecayRate` 20 CP/s (`public/simulation/templates/template_structure.xml:152-155`) whenever their position is not connected to their owner's (or a mutual ally's) territory (`public/simulation/components/TerritoryDecay.js:26-116`). Each tick, up to `DecayRate` CP are moved from the owner's pool to the connected neighbour players' pools, weighted by shared border length, or to gaia if there are no neighbours (`public/simulation/components/Capturable.js:212-231`). Decay and regen both apply in the same tick, decay first. This is the mechanic that makes isolated forward buildings flip to gaia/enemies on their own — no attacker needed. This is also how walls "decay": they inherit `Capturable`, no unit can capture them, but disconnected walls lose 20 CP/s vs RegenRate 5/s and eventually flip.

## Consequences of a capture

- **Garrisoned units**: on ownership change, garrisoned entities not owned by a mutual ally of the new owner are `EjectOrKill`ed (`public/simulation/components/GarrisonHolder.js:395-409`): those matching the holder's `EjectClassesOnDestroy` are ejected next to the building, the rest are destroyed (`public/simulation/components/GarrisonHolder.js:446-498`). Typical garrisonable structures (civil centre, house, temple, wonder) use `EjectClassesOnDestroy = "Unit"` (e.g. `public/simulation/templates/template_structure_civic_civil_centre.xml:65`), so in practice enemy garrisoned units are **ejected alive** around the captured building, not killed.
- **Technology queue** (`ProductionQueue` component): the whole queue is reset on any ownership change — queued and in-progress research is removed and autoqueue disabled (`public/simulation/components/ProductionQueue.js:513-521`).
- **Training queue** (`Trainer` component): **not** cleared on capture — only the trainable-entities map is recomputed for the new owner's civ (`public/simulation/components/Trainer.js:672-676`). Batches already in the queue keep the player who queued them (stored at queue time, `public/simulation/components/Trainer.js:59-62`) and will spawn units for the **previous** owner from the captured building.
- **Health**: untouched. A captured building keeps its current hitpoints — capture does not repair it.
- The building's territory influence, auras, trainer list (`{civ}` tokens re-resolve to the new owner's civ) and garrison heal all start working for the new owner immediately.

## What cannot be captured

- Any entity without a `Capturable` component: units, animals, resource entities, treasures.
- Structures that explicitly disable it: the Ishtar gate, iber monument, maur Ashoka pillar, rome arch, han Laozi gate, germ totem, decorative columns and all `fence_*` segments, `mill_field_wheat`, plus the `special/filter/uncapturable` template (all via `<Capturable disable=""/>`, e.g. `public/simulation/templates/structures/ishtar_gate.xml:6`).
- Effectively-uncapturable-by-units: walls, palisades and fields (RestrictedClasses on every unit's Capture attack) — but they still decay territorially.
- Entities whose `Resistance` is invulnerable reject all attack effects including capture (`public/simulation/helpers/Attack.js:305-307`).

## Capture vs destroy

- **Capture grants no loot**: `Capturable.Capture` has an explicit `// TODO: implement loot` (`public/simulation/components/Capturable.js:65`). No resources, no XP.
- **Destroying** grants the killer's `Looter` component the target's `Loot` resources (`public/simulation/components/Health.js:230-232`) and XP proportional to damage dealt if the target's `Loot/xp` > 0 (`public/simulation/components/Health.js:195-197`). The generic structure template sets all loot values to 0 (`public/simulation/templates/template_structure.xml:51-57`); specific templates may override.
- Trade-off for a bot: capturing preserves the building at its current (possibly low) HP, flips its territory/attack/trainer to you instantly once the owner's pool hits 0, and ejects defenders; it is slowed by the building's regen and garrison and gives no XP. Destroying ignores capture regen entirely, is faster against high-CP targets with siege (crush damage), denies the enemy the building permanently, and feeds promotion XP — but you must rebuild yourself. Because damaged buildings capture faster (up to 10×), a mixed approach — siege damages, infantry captures — is the fastest way to take a high-CP building like a civil centre (2500 CP, 30 CP/s regen) intact.
