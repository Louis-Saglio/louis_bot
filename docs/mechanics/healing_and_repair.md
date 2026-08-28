# Healing and repair (0 A.D. 0.28.0)

How damaged entities recover hitpoints: active healing by healer units, passive health regeneration, garrison healing, and repair of structures/siege/ships by builder units. Grounded in `public/simulation/components/Heal.js`, `Health.js`, `GarrisonHolder.js`, `Repairable.js`, `Builder.js`, `Upkeep.js`, `UnitAI.js` and the referenced templates/auras/technologies of the pinned 0.28.0 copy at `/home/ubuntu/0ad-reference/`. Paths below are relative to that root.

## Healer units (`Heal` component)

Only entities whose template carries a `Heal` component can heal. In practice that is the Healer support unit (`simulation/templates/template_unit_support_healer.xml`), trainable by all 15 civs at the temple from Town Phase.

### Parameters (basic healer)

| Field | Value | Meaning |
|---|---|---|
| `Range` | 12 m | max distance to the target (min range is 0) |
| `Health` | 5 HP | healed per tick |
| `Interval` | 2000 ms | time between ticks |
| `HealableClasses` | `Human` | target must have one of these classes |
| `UnhealableClasses` | (empty) | target with any of these can never be healed |

(`public/simulation/templates/template_unit_support_healer.xml`; schema at `public/simulation/components/Heal.js:17-46`.)

So a basic healer heals **2.5 HP/s**, only on `Human` targets. Advanced and Elite ranks each add **+3 m range and +5 HP per tick** (auto-researched rank techs: `public/simulation/data/technologies/unit_advanced.json`, `unit_elite.json` — both list `Heal/Range +3`, `Heal/Health +5`, `affects: Healer`), i.e. 10 HP / 2 s at 15 m (Advanced), 15 HP / 2 s at 18 m (Elite).

### Eligibility — `Heal.CanHeal`

A target can be healed only if all of the following hold (`public/simulation/components/Heal.js:94-111`):

- it has a `Health` component, is **injured** (0 < HP < max) and not flagged unhealable;
- it is **owned by the healer's player or an ally** (`IsOwnedByAllyOfPlayer`);
- its classes match `HealableClasses` and do **not** match `UnhealableClasses` (`UnhealableClasses` wins if both match — `Heal.js:35`).

`Health.IsUnhealable()` returns true when the template has `<Unhealable>true</Unhealable>`, when the entity is dead, or when it is at full HP (`public/simulation/components/Health.js:116-120`). Templates with `Unhealable=true` include **all structures, siege engines and ships** (`template_structure.xml`, `template_unit_siege.xml`, `template_unit_ship.xml`) and the slave (`template_unit_support_slave.xml`). Those can only regain HP via repair or regen auras (below), never from healers. Non-`Human` organic units (cavalry mounts are still `Human`-classed riders; e.g. dogs, elephants, fauna are not `Human`) are excluded by the healer's `HealableClasses`.

### Timing and execution

- A heal order starts a timer: first tick after a fixed **prepare of 1000 ms**, then every `Interval` ms (`public/simulation/components/Heal.js:52-58`, `:163`).
- Anti-burst: if the healer healed something less than `Interval` ago, the first tick is delayed so ticks never come faster than `Interval` (`Heal.js:142-149`).
- Each tick adds `Health` HP, capped at max HP (`public/simulation/components/Health.js:324`). Overheal is lost.
- Healing stops when the target reaches full HP, becomes invalid, or leaves range; UnitAI then looks for a new target (`Heal.js:204-240`).
- Range is checked with the obstruction manager (center distance vs. obstruction sizes): `public/simulation/components/Heal.js:259-264`.

### XP reward

The healer gains promotion XP from healing: per tick, `XP += (HP actually healed / target max HP) × target Loot XP` (`public/simulation/components/Heal.js:226-231`). Healing a high-loot target (champions, heroes) levels healers fast.

### UnitAI behavior (automatic healing)

- Healers **cannot heal themselves**: an order targeting self is dropped (`public/simulation/components/UnitAI.js:475-477`).
- Idle healers auto-acquire injured allies via an active range query over entities with the `injured` flag (`UnitAI.js:3817-3840`); on the idle timer a healer looks for heal targets *before* looking for enemies to attack (`UnitAI.js:1693-1698`). The query range depends on stance: `min(heal range, vision range)` on stand ground, `vision range` on chase/aggressive (`UnitAI.js:6135-6159`).
- A healer guarding an entity pushes a `Heal` order on its guard target when it is injured (`UnitAI.js:1566`, `:1999`).
- When a heal target leaves range mid-heal, the healer chases it unless the order was non-forced and stance forbids it (`UnitAI.js:2793-2803`).
- Newly injured allies entering the query trigger `LosHealRangeUpdate`-style responses; the query is re-created when `Heal/Range` is modified (`public/simulation/components/Heal.js:266-275`).

## Passive regeneration (`Health.RegenRate` / `Health.IdleRegenRate`)

Two per-second HP rates on every entity's `Health` component (`public/simulation/components/Health.js:32-36`):

- `RegenRate` — always applies (may be negative);
- `IdleRegenRate` — added **only while the unit is idle** (`Health.js:132-146`; the schema help says "idle or garrisoned", `Health.js:35`, but the code path tests `UnitAI.IsIdle()`, `Health.js:137-139`).

Mechanics (`Health.js:132-174`):

- A 1 Hz timer runs only when needed: no timer if both rates are 0, if the entity is dead, or if it is at full HP with non-negative rates.
- Each second: `regen = RegenRate (+ IdleRegenRate if idle)`; positive → `Increase(regen)`, negative → `Reduce(-regen)` — **negative regen can kill the entity** (`Health.js:142-145`, `Reduce` kills at 0 HP, `Health.js:255-260`).

### What exists in 0.28 templates

- **Default: no regen.** `template_unit.xml` sets `RegenRate 0`, `IdleRegenRate 0`; `template_structure.xml` sets 0/0 plus `Unhealable true`. No unit regenerates out of the box.
- **Slave** (`template_unit_support_slave.xml`): `RegenRate -0.25` — decays 0.25 HP/s, and is `Unhealable`, so it slowly dies on its own.
- Fire ships (`mixins/fireship.xml`): `RegenRate -200` (burn down quickly after unpacking).

### Technologies and auras that grant regen

- **Battlefield Medicine** (temple tech, City Phase): `Health/IdleRegenRate +0.5` for `Unit Organic` — idle organic units regen 0.5 HP/s (`public/simulation/data/technologies/health_regen_units.json`; researchable at the temple, listed in `template_structure_civic_temple.xml`).
- **Pharaonic Cult** (ptol, City Phase): `Health/RegenRate +2` for `Hero` (`public/simulation/data/technologies/pharaonic_cult.json`).
- **Temple aura "Medical Treatment"**: every temple emits `Health/RegenRate +1` to `Human` units within **40 m** (`public/simulation/data/auras/structures/temple_heal.json`; aura listed in `template_structure_civic_temple.xml`). The kushite Temple of Amun has the same aura at **70 m** (`data/auras/structures/kush_temple_amun_heal.json`).
- Other regen auras exist (e.g. athen hero Hippocrates: +0.5 to `Human` in 35 m, `data/auras/units/heroes/athen_hero_hippocrates_1.json`; germanic seer debuff: −1 to enemy `Human` in 15 m after a tech, `data/auras/units/germ_seer_1_buff.json`).
- **Arsenal "Arsenal Repairs"**: garrisoned `Siege` engines get `Health/RegenRate +3` (`data/auras/structures/arsenal_repair.json`; the arsenal garrisons up to 5 `Siege`, `template_structure_military_arsenal.xml`). This is the only way siege engines self-repair without builders.
- **Cart super dock "Dockyard Repairs"**: garrisoned `Ship`s get `Health/RegenRate +10` (`data/auras/structures/cart_super_dock_repair.json`).

Note: regen from auras is a `Health` modification, so it also works on entities flagged `Unhealable` (the flag only blocks healer units and garrison `BuffHeal`).

## Garrison healing (`GarrisonHolder.BuffHeal`)

Any garrison holder with `BuffHeal > 0` heals each garrisoned entity by `BuffHeal` HP **once per second** (`HEAL_TIMEOUT = 1000` ms), skipping entities whose `Health.IsUnhealable()` is true — i.e. full-HP, dead, or `Unhealable` entities (`public/simulation/components/GarrisonHolder.js:19-21`, `:39`, `:333`, `:348-361`). The heal timer only runs while the holder is above its `EjectHealth` threshold (`GarrisonHolder.js:187-190`); a holder that falls below `EjectHealth` × max HP stops accepting garrison and ejects its occupants (`GarrisonHolder.js:309-325`).

Values in 0.28 (HP/s):

- **Temple: 3** (`template_structure_civic_temple.xml`) — combines with the 40 m +1 HP/s aura; units do not need to be garrisoned for the aura.
- **Civil centre: 1** (`template_structure_civic_civil_centre.xml`), wonder: 5, corral: 1, han ministry: 1.
- Everything else with a `GarrisonHolder` — houses, towers, fortresses, army camps, ships, siege towers/rams — has `BuffHeal 0`: garrisoning there does **not** heal.

Garrison healing stacks with a unit's own regen/auras (they are independent `Health.Increase` calls).

## Repair (`Repairable` + `Builder`)

### What can be repaired

Templates with a `Repairable` component and their `RepairTimeRatio`:

- Structures: **2.0** (`template_structure.xml`), defensive walls: **4.5** (`template_structure_defensive_wall.xml`);
- Siege engines: **4.0** (`template_unit_siege.xml`);
- Ships: **4.0** (`template_unit_ship.xml`).

These are exactly the entities that are `Unhealable` — healers for organic units, builders for everything else.

### Who repairs

Any unit with a `Builder` component can repair any **allied** `Repairable` entity (or foundation): the `Builder.Entities` token list only restricts placing *new* foundations, not repairing (`public/simulation/components/Builder.js:74-83`; schema help at `Builder.js:14`). In practice: all infantry (`template_unit_infantry.xml`, parent `builder|template_unit`), female citizens, support elephants (via the `builder` mixin, rate 1.0 — `public/simulation/templates/mixins/builder.xml`) and slaves (rate **0.5**, `template_unit_support_slave.xml`). Cavalry has no `Builder`.

### Rate and formulas

- Repair ticks every **1000 ms** per builder (`Builder.js:24`, `:110`), each tick adding `min(missingHP, work)` HP, where `work = builderRate × buildMultiplier × repairRate` (`public/simulation/components/Repairable.js:124-137`).
- `repairRate = maxHP / (RepairTimeRatio × buildTime)` HP per second per unit of builder rate (`Repairable.js:159-165`). So one rate-1.0 builder fully repairs an entity in `RepairTimeRatio × buildTime` seconds (e.g. a house with 30 s build time takes 60 s for one woman; a ram, 4 × its build/train time).
- **Diminishing returns** for n builders: `buildMultiplier = n^0.7 / n` for n ≥ 2, else 1 (`Repairable.js:99-103`). Combined HP/s of n equal builders = `rate × repairRate × n^0.7` (10 builders ≈ 5.01× one, `Repairable.js:95-97`).
- Estimated remaining time: `(1 − HP/maxHP) × buildTime × RepairTimeRatio / (totalBuilderRate × buildMultiplier)` (`Repairable.js:110-121`).
- **Repair costs no resources** (`Repairable.js:123`, "TODO: should we have resource costs?") — unlike construction, which drains resources via the foundation.
- Builders must stand within **2 m + their obstruction size** of the target (`Builder.js:55-63`); leaving range or an invalid target stops the repair (`Builder.js:154-166`). When HP is full, all builders are notified and stop (`Repairable.js:144-156`).
- A target can be made unrepairable at runtime (`Repairable.SetRepairability`, `Repairable.js:44-47`).

## Upkeep (`Upkeep` component) — unused in 0.28

`public/simulation/components/Upkeep.js` implements a periodic resource drain: every `Interval` ms the owner pays `Rates` resources (`Upkeep.js:58-68`); if the player cannot pay, the entity becomes **uncontrollable** (`Identity.SetControllable(false)`) until a payment succeeds again (`Upkeep.js:73-96`). However, **no 0.28 template includes an `Upkeep` element** (verified: no match for `Upkeep` under `public/simulation/templates/`), so the mechanic is dead code for skirmish games — do not plan around population/health drain; there is none.

## Edge cases for a bot

- Target selection for heal orders must filter: ally-owned, `Human` class (generic healer), injured, not `Unhealable`. Siege/ships/structures need builders, not healers.
- A healer at full HP targets nothing: `IsUnhealable()` is true at full HP, so "nearest injured ally" queries use the `injured` range-manager flag.
- Healing throughput is per-target: one healer heals one entity at a time; n healers on one target stack linearly (no diminishing returns, unlike repair).
- Healing grants the healer XP — healers can be leveled by healing between fights.
- Repairing is usually cheaper than rebuilding: it is free and proportional to missing HP, but `RepairTimeRatio × buildTime` can be long for big structures with one builder; adding builders suffers the n^0.7 penalty.
- Garrisoning wounded `Human` units in a temple (3 HP/s) or CC (1 HP/s) is free healing; towers/fortresses heal nothing in 0.28.
