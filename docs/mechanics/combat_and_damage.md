# Combat and damage (0 A.D. 0.28.0)

How attacks, armor and damage work in 0 A.D. 0.28.0. Grounded in `public/simulation/components/Attack.js`, `Resistance.js`, `Health.js`, `DelayedDamage.js`, `DeathDamage.js`, `BuildingAI.js`, `TurretHolder.js`, the damage-application helper `public/simulation/helpers/Attack.js`, the effect receiver registry `public/simulation/data/attack_effects/*.json`, and the templates `template_unit_infantry_melee_spearman.xml`, `template_unit_infantry_ranged_archer.xml`, `template_structure_defensive_tower.xml`, `template_unit_siege_stonethrower.xml` and `mixins/fireship.xml`. All paths below are relative to `/home/ubuntu/0ad-reference` (the pinned 0.28.0 copy). Template times are stored in **milliseconds**, ranges in **meters**.

## Attack types

The engine knows three ordinary attack types — `Melee`, `Ranged`, `Capture` (`g_AttackTypes`, `public/simulation/components/Attack.js:3`) — plus `Slaughter`, which is handled specially (see below). An entity can have several types at once; the `Attack` component holds one block per type (`Attack.js:104-209`).

- **Melee / Ranged** — deal `Damage` (health loss). Ranged attacks launch a projectile; melee attacks hit the target directly.
- **Capture** — deals `Capture` points instead of health damage (see "Capture" below). Only usable on targets whose `Capturable` component allows it (`Attack.js:290`).
- **Slaughter** — used to kill `Domestic` animals. `CanAttack` short-circuits to true for a `Domestic` target when the attacker has a `Slaughter` block (`Attack.js:265-267`), and `GetBestAttackAgainst` always prefers it against `Domestic` targets (`Attack.js:378-380`). Generic infantry gets 1000 hack, range 2, prepare 900 ms, repeat 1000 ms (`template_unit_infantry.xml:11-21`).

Non-capture attacks require the target to be an **enemy** with **health > 0** (`Attack.js:287`): you cannot attack allies, corpses, or gaia trees with Melee/Ranged. A vertical height difference larger than the attack's max range also makes the target unattackable (`Attack.js:283-294`).

## Damage types and the exact damage formula

Damage comes in three types, declared per attack: **hack**, **pierce**, **crush** (template elements `Damage/Hack|Pierce|Crush`). The defender's armor values are `Resistance/Entity/Damage/{Hack,Pierce,Crush}` (or `Resistance/Foundation/...` while the entity is an unfinished foundation — `Resistance.js:122`).

The exact formula (`public/simulation/helpers/Attack.js:172-174`, multiplied by the bonus at line 185):

```
totalDamage = bonusMultiplier × Σ_type  Damage[type] × 0.9 ^ armor[type]
```

- Each point of armor multiplies the incoming damage of that type by 0.9, independently per type. E.g. 10 hack armor → hack damage ×0.9^10 ≈ ×0.349; 20 armor → ×0.122.
- Armor 0 against a type → that type lands at full strength. There is no armor floor or subtraction: damage is purely exponential in armor.
- `bonusMultiplier` is the product of all matching attack bonuses (see below) and, for splash damage, the distance falloff multiplier.
- The result is handed to `Health.TakeDamage` (`helpers/Attack.js:312-321` via the receiver registry: `Damage` → `IID_Health.TakeDamage`, `public/simulation/data/attack_effects/damage.json`). `Health.Reduce` clamps at 0 HP and returns the HP actually lost (`public/simulation/components/Health.js:239-274`).
- An invulnerable target (`Resistance.IsInvulnerable`) takes nothing at all (`helpers/Attack.js:305-307`).

## Capture

Capture attacks reduce a target's capture points. Formula (`helpers/Attack.js:176-183`):

```
captureStrength = bonusMultiplier × Capture × 0.9 ^ captureResistance
                  / (0.1 + 0.9 × targetHP / targetMaxHP)
```

The lower the target's health, the faster it captures — at full health the divisor is 1.0, near death it approaches 0.1 (×10 capture speed). Capture resistance works like armor (0.9 per point). The points are applied by `Capturable.Capture` (`public/simulation/components/Capturable.js:60-68`). Typical capture strength: infantry 2.5 (`template_unit_infantry.xml:4-10`), cavalry 1.75 (`template_unit_cavalry.xml:4-6`), repeat 1 s, range 4 m.

## Attack bonuses vs classes

An attack block may carry `Bonuses`: named entries with `Classes`, an optional `Civ`, and a `Multiplier` (schema at `helpers/Attack.js:70-85`). At damage time every bonus whose class list matches the target's classes (and whose `Civ`, if given, equals the target's civ) **multiplies** the total — bonuses stack multiplicatively (`helpers/Attack.js:357-378`, applied at line 309). Example: the generic spearman has ×2.5 vs `Cavalry` on its melee attack (`template_unit_infantry_melee_spearman.xml:13-18`).

Class matching semantics (`MatchesClassList`, `public/globalscripts/Templates.js:84-103`): within one string, space-separated tokens are **OR**-ed, tokens joined by `+` are **AND**-ed, and a leading `!` negates a class. So `Cavalry Melee` matches targets that are Cavalry *or* Melee; `Unit+!Ship` matches units that are not ships.

## Preferred and restricted classes

Per attack type (`Attack.js:5-23`):

- `PreferredClasses` — ordered list, most preferred first. `GetPreference(target)` returns the lowest matching index (0 = most preferred), `undefined` if no match (`Attack.js:310-334`). Used for automatic target choice: auto-acquired targets with no preference match are dropped after the first hit (`Attack.js:609-614`), and buildings sort candidate targets by preference then by proximity (`BuildingAI.js:350-358`).
- `RestrictedClasses` — if the target matches **any** restricted class (same OR/AND/NOT syntax), this attack type cannot be used against it (`Attack.js:296-301`). E.g. Slaughter is restricted to `!Domestic` read via the negation semantics, i.e. only usable on Domestic animals (`template_unit_infantry.xml:19`).

`GetBestAttackAgainst` picks the attack type per target: matching preferred classes and the capture-vs-damage allowance bias the choice (`Attack.js:367-398`).

## Timings: prepare, repeat, effect delay

Per attack type (`GetTimers`, `Attack.js:429-435`):

- `PrepareTime` (default 0) — delay from starting the attack until the first hit lands.
- `RepeatTime` — interval between subsequent hits. The attack loop is a timer firing once after `prepare`, then every `repeat` (`Attack.js:534`).
- `EffectDelay` (default 0) — extra delay between the attack animation "landing" and the effects being applied (`Attack.js:660`); for projectiles the flight time is added on top (see below).

Edge cases a bot should know:

- **Attack speed is conserved across target switches**: if less than `repeat` ms elapsed since the last attack, the new attack's prepare phase is stretched to the remaining repeat time (`Attack.js:498-505`).
- While attacking, range is re-checked `ceil(repeat/1000)` times per repeat cycle, and once right after each hit; if the target left range the attack stops (`Attack.js:471-474`, `516-527`, `602-607`).
- Damage is applied through the system component `DelayedDamage`: with no delay it fires immediately, otherwise via a timeout (`Attack.js:760-766`, `public/simulation/components/DelayedDamage.js`).

## Range

`MaxRange` (required) and `MinRange` (default 0) per attack type, modifiable by techs/auras (`Attack.js:450-462`). Range checks use `ObstructionManager.IsInTargetParabolicRange`, which accounts for the projectile arc (`YOrigin`) and the target's obstruction size (`Attack.js:773-783`). Units with `MinRange > 0` (e.g. towers, min range 10 m) have a dead zone — enemies closer than `MinRange` cannot be shot.

## Projectiles: speed, spread, misses, friendly fire

Ranged attacks with a `Projectile` block launch a real projectile (`Attack.js:662-754`):

- **Flight time**: the target's velocity is extrapolated from its movement during the last turn (`Attack.js:677`), and an intercept time is computed (`PositionHelper.PredictTimeToTarget`, called at `Attack.js:679`). With probability `max(0, 0.75 − timeToTarget/1.333)` the shooter "cheats" and asks the target's `UnitMotion` for its planned future position; otherwise the dumb linear prediction is used (`Attack.js:690-706`). Long-range shots therefore always use linear prediction and miss zigzagging targets more often.
- **Spread**: `Spread` is the standard deviation of a bivariate normal error at 100 m distance; the actual deviation scales linearly with distance: `distanceModifiedSpread = Spread × distance / 100` (`Attack.js:711-716`; normal from `public/globalscripts/random.js:5`). Per the schema help, a disk of radius 1×/2×/3× the modified spread catches 39.3 % / 86.5 % / 98.9 % of shots (`Attack.js:177`).
- **Delay**: `EffectDelay + flightTime` ms after the animation point, `DelayedDamage.Hit` resolves the impact (`Attack.js:720-722`, `DelayedDamage.js:36-93`).
- **Hit resolution** (`DelayedDamage.js:63-92`): if the intended target's footprint (circle or rotated square) contains the impact point — tested against its interpolated position (`public/simulation/helpers/Position.js:75-100`) — it takes the full damage. On a **miss**, entities within `MISSILE_HIT_RADIUS = 2` m of the impact point are tested; the first one hit absorbs the projectile and takes the damage.
- **Friendly fire**: when `Projectile/FriendlyFire` is `false` (the norm), only enemies of the shooter are considered for stray hits (`Attack.js:753`, `helpers/Attack.js:218-224`); a missed arrow can still hit a *different enemy*. With `FriendlyFire true`, all players' entities can be hit. Melee (non-projectile) attacks always hit exactly the intended target — there is no friendly fire in melee.

## Splash damage

An attack type may add a `Splash` block (shape, range, friendly-fire flag, its own damage). On impact, every entity of a damageable player within the radius takes damage scaled by distance (`helpers/Attack.js:239-289`):

- **Circular**: `multiplier = 1 − distance²/radius²` (quadratic falloff, 0 at the edge).
- **Linear** (missiles only): a strip of width `radius/5` extending `radius` meters past the impact point along the flight direction; quadratic falloff in both directions.

The splash attack type string gets a `.Splash` suffix (matters for bonus lookup paths). The fireship's and stonethrower's blocks illustrate the data: stonethrower splash = 120 crush, circular, range 1.5, no friendly fire (`template_unit_siege_stonethrower.xml`). Splash `FriendlyFire` is independent of the projectile's flag.

## Building and turret fire (BuildingAI)

Buildings that shoot use `BuildingAI`, which fires the building's own `Ranged` attack (`BuildingAI.js:3`):

- **Arrow count** per cycle: `DefaultArrowCount + round(garrisonedMatchingUnits × GarrisonArrowMultiplier)`, capped at `MaxArrowCount` if defined (`BuildingAI.js:256-262`). Only garrisoned units matching `GarrisonArrowClasses` add arrows (`BuildingAI.js:34-49`). Examples: defense tower — 2 base arrows, +1 per garrisoned `Infantry` (`template_structure_defensive_tower.xml`); civil centre — 6 base, +1 per garrisoned `Soldier` (`template_structure_civic_civil_centre.xml`).
- **Fire rhythm**: the repeat time is divided into `roundCount = 20` rounds; the timer fires every `repeat/20` ms after an initial `prepare` delay (`BuildingAI.js:1-2`, `216-220`). Each round fires `min(arrowCount/5, arrowsLeft)` arrows, and the last round fires the remainder — so a fifth of the arrows go out per round in a burst-ish pattern (`BuildingAI.js:308-322`). Each arrow is a full independent projectile via `Attack.PerformAttack("Ranged", target)` (`BuildingAI.js:384`).
- **Target acquisition**: an active parabolic range query (min–max range, enemies with `Resistance`, plus dangerous gaia animals) maintains the target list (`BuildingAI.js:103-166`, `171-204`). Targets must be visible through FoW/SoD (`BuildingAI.js:399-413`). Without a player focus target, arrows go to the targets sorted by attack preference, then proximity (`BuildingAI.js:345-358`).
- Buildings have **no prepare per arrow**: `Attack.Attack` delegates to BuildingAI instead of calling `PerformAttack` directly (`Attack.js:595-597`).

**Turrets**: `TurretHolder.js` contains no firing logic at all — it only positions occupants on turret points (offsets, allowed classes, ejectability; `TurretHolder.js:421-472`). A turreted entity (e.g. a soldier on a wall segment or in a siege tower) keeps its own `Attack`/`UnitAI` components and fires its own weapons independently. "Arrows per garrisoned unit" as described above applies only to garrisoned (not visibly turreted) units via `GarrisonArrowClasses`.

## Death damage

An entity with a `DeathDamage` component damages an area when it dies: `Health.HandleDeath` calls `DeathDamage.CauseDeathDamage` (`Health.js:279-283`, `DeathDamage.js:32-54`), which runs the same `CauseDamageOverArea` as splash with type `"Death"` and its own radius/falloff/friendly-fire flag. Example — fire ships: circular, range 22, 500 crush, ×3 vs `Ship`/`Building`, no friendly fire (`public/simulation/templates/mixins/fireship.xml`).

## Delayed damage summary

All damage lands through `DelayedDamage.Hit` (`DelayedDamage.js:36-93`): melee/capture with zero or `EffectDelay` ms delay, projectiles with `EffectDelay + flight time`. Order inside `Hit`: splash area damage first, then the direct hit test on the intended target, then the 2 m stray-hit search. Miraged targets are resolved to their real entity before damage (`DelayedDamage.js:58-61`).

## Health, death and XP edge cases

- Damage reduces HP; at exactly 0 the entity dies immediately (`Health.Reduce`, `Health.js:255-261`). `healthChange` reports HP actually lost, so overkill is discarded.
- The attacker gains promotion XP proportional to damage dealt: `targetLootXP × HPlost / targetMaxHP` (`Health.js:195-197`, awarded at `helpers/Attack.js:342-344`). Damage from active status effects grants no XP (`helpers/Attack.js:338-340`).
- On death: `DeathDamage` fires, an optional `SpawnEntityOnDeath` entity is created, then per `DeathType` a corpse is spawned (`corpse`), the entity stays at 0 HP (`remain`) or vanishes (`vanish`), and the entity is destroyed (`Health.js:279-307`).
- Health regenerates via a 1 s timer at `RegenRate` HP/s, plus `IdleRegenRate` when idle or garrisoned (`Health.js:132-174`).
- Every processed attack posts an `MT_Attacked` message to the target with type, attacker, damage and capture amounts (`helpers/Attack.js:327-336`) — this is what UnitAI reacts to (retaliation).

## Status effects (brief)

Attacks may also carry `ApplyStatus` effects (burning, poison, …) with duration, tick interval, per-tick damage and a `Stackability` mode (`Ignore`/`Extend`/`Replace`/`Stack`) (schema at `helpers/Attack.js:19-52`; receiver `IID_StatusEffectsReceiver.ApplyStatus`, `data/attack_effects/applystatus.json`). Resistance against a status effect gives a `BlockChance` (probability to fully block) and a duration multiplier (`helpers/Attack.js:187-208`, `Resistance.js:164-172`).

## Worked example

Generic archer (`template_unit_infantry_ranged_archer.xml`) vs generic spearman (armor 3 hack / 3 pierce / 15 crush, `template_unit_infantry_melee_spearman.xml` chain — pierce armor 3):

- Archer: 7.2 pierce, range 60, prepare 800 ms, repeat 1250 ms, projectile speed 100 m/s, spread 2.25.
- Damage per hit: `7.2 × 0.9³ = 7.2 × 0.729 ≈ 5.25` HP (no bonus matches — spearman is not Cavalry).
- At 60 m the spread standard deviation is `2.25 × 60/100 = 1.35` m; the shot is placed at the predicted position plus a 2D-normal offset with that deviation, lands after `EffectDelay(0) + flight time ≈ 0.6 s`, and hits if the impact point falls inside the spearman's footprint — otherwise a 2 m stray-hit search runs.
