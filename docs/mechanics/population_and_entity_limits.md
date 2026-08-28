# Population and entity limits (0 A.D. 0.28.0)

How population cost, population cap, and per-category entity limits work. Grounded in the pinned 0.28.0 copy at `/home/ubuntu/0ad-reference`: `public/simulation/components/Population.js`, `Player.js`, `PopulationCapManager.js`, `EntityLimits.js`, `Trainer.js`, `Cost.js`, `TrainingRestrictions.js`, `BuildRestrictions.js`, `GuiInterface.js`, `public/simulation/helpers/InitGame.js`, `public/simulation/helpers/Commands.js`, and the simulation templates under `public/simulation/templates/`. Paths below are relative to `/home/ubuntu/0ad-reference`.

## The three numbers

Each player entity tracks (`public/simulation/components/Player.js:56-58`):

- `popUsed` — population currently used. `GetPopulationCount()` returns it (`Player.js:152-155`).
- `popBonuses` — sum of the `Population/Bonus` of all owned entities. `AddPopulationBonuses()` (`Player.js:167-170`).
- `maxPop` — the game-setting population cap for this player, initialised to 300 (`Player.js:58`) and overwritten at game start by the `PopulationCapManager`. `GetMaxPopulation()` applies technology/aura modifications (`Player/MaxPopulation`) and rounds (`Player.js:182-185`).

The effective limit is (`Player.js:172-175`):

```
popLimit = min(GetMaxPopulation(), popBonuses)
```

So the usable population is bounded both by the game-setting cap and by the housing actually built. Example: with `maxPop = 300` and houses providing `popBonuses = 45`, training stops at 45 population.

## Population cost per unit

- Defined per template in `Cost/Population`. Defaults: 1 for all units (`public/simulation/templates/template_unit.xml:5`), 0 for structures (`public/simulation/templates/template_structure.xml:15`).
- Deviations: siege engines cost 3 (`public/simulation/templates/template_unit_siege.xml:4`), champion elephants cost 3 (`public/simulation/templates/template_unit_champion_elephant.xml:4`). Ram warships still cost 1 (`public/simulation/templates/template_unit_ship_warship_ram.xml:24`).
- Technologies can modify it via `Cost/Population`; on modification the difference is immediately added to/subtracted from `popUsed` (`public/simulation/components/Cost.js:73-82`).

### How `popUsed` changes

`popUsed` changes **only on ownership change** (`Player.js:607-642`): `+GetPopCost()` when an entity becomes owned by the player, `-GetPopCost()` when it leaves (death, capture by an enemy, deletion). Consequences:

- Garrisoning a unit does **not** free population (no ownership change).
- Losing a unit to capture transfers its population cost to the capturer.
- Units being trained also count: when a training batch starts, its full population is reserved in `popUsed` (see "Training blocked at the cap" below).

## Population provided by buildings

A structure template provides population via `Population/Bonus` (`public/simulation/components/Population.js:8-10`). The bonus is added to the owner's `popBonuses` when the entity gains an owner, removed when it loses one (`Population.js:30-45`), and can be modified by technologies (`Population/Bonus`, rounded — `Population.js:25-28`).

Values from the templates:

| Building | Bonus | Source |
|---|---|---|
| House (generic, incl. gaul) | 5 | `public/simulation/templates/template_structure_civic_house.xml:40-42` (gaul house inherits, `structures/gaul/house.xml:2`) |
| Big house | 10 | `public/simulation/templates/template_structure_civic_house_big.xml:25-26` |
| Civil centre | 20 | `public/simulation/templates/template_structure_civic_civil_centre.xml:94-96` |
| Celt hut | 2 | `public/simulation/templates/structures/celt_hut.xml:25-26` |
| Celt longhouse | 10 | `public/simulation/templates/structures/celt_longhouse.xml:25-26` |
| Gaul tavern | 10 | `public/simulation/templates/structures/gaul/tavern.xml:35-36` |

**Foundations give nothing**: the foundation filter template forces `Bonus 0` (`public/simulation/templates/special/filter/foundation.xml:30-31`); the bonus only appears once construction completes and the finished building entity exists. So planned/unfinished housing does not raise the limit.

Relevant technology: `pop_house_01` ("Home Garden", Town Phase) multiplies `Population/Bonus` by 1.2 for entities with class `House` (`public/simulation/data/technologies/pop_house_01.json:22-25`), followed by `pop_house_02`.

## The population cap game setting (`PopulationCapManager`)

Set once at game start in `public/simulation/helpers/InitGame.js:67-82`:

- `settings.PopulationCap || 300` is the cap; `settings.PopulationCapType` one of `"player"` (default fallback), `"team"`, `"world"` (`InitGame.js:68-80`, types in `public/simulation/components/PopulationCapManager.js:3-5`).
- Scenario maps can instead set a per-player `PopulationLimit` in `PlayerData`, which overrides cap and type (`InitGame.js:71-72`, `PopulationCapManager.SetPerPlayerPopulationCaps` at `PopulationCapManager.js:49-54`).

Distribution (`PopulationCapManager.js`):

- **player**: every non-gaia player gets the full cap (`InitializePlayerPopCaps`, lines 92-98).
- **team**: each team's members share the cap — each gets `round(cap / livingTeamMembers)`; players without a team (team −1) get the full cap (`RedistributeTeamPopCap`, lines 121-135).
- **world**: every living player gets `round(cap / activePlayers)` (`RedistributeWorldPopCap`, lines 140-149).

Caps are redistributed when a player is defeated (`OnGlobalPlayerDefeated`, lines 155-173: only for team/world types) and when teams change (`OnTeamChanged`, lines 181-188). With the default `"player"` type, caps are fixed for the whole match.

GUI option lists and defaults (`public/simulation/data/settings/population_capacities.json`): player — 50…300, default **300**; team — 100…1000, default 400; world — 100…2400, default 600. Every list ends with `10000`, displayed as "Unlimited" (`public/gui/gamesetup/Pages/GameSetupPage/GameSettings/Single/Dropdowns/PopulationCap.js:29-30`). Note: "unlimited" is a finite cap of 10000.

`maxPop` can also be modified in-game via `Player/MaxPopulation` (`Player.js:182-185`) — e.g. the wonder aura "Glorious Expansion" multiplies it by 1.2 per wonder (`public/simulation/data/auras/structures/wonder_population_cap.json:5`, enabled by `public/simulation/data/technologies/wonder_population_cap.json`).

## Training blocked at the cap

Training a batch goes through `Trainer.prototype.Item` (`public/simulation/components/Trainer.js`):

1. **Queue**: resources are subtracted immediately (`Trainer.js:79`). Population is *not* reserved yet.
2. **Start** (when the batch reaches the front of the queue): `TryReservePopulationSlots(population × count)` (`Trainer.js:181`). Reservation = directly adding to `popUsed`; it fails when `num > popLimit - popUsed`, returning the number of missing slots (`Player.js:138-145`).
3. If reservation fails: `BlockTraining()` sets the player's `trainingBlocked` flag and the item does not start (`Trainer.js:182-186`). The queue retries every progress tick (`if (!this.started && !this.Start()) return allocatedTime;` — `Trainer.js:342-344`). No error, no notification to an AI: the batch just waits until housing is built or units die.
4. **Spawn**: when each unit is placed, the reservation is released (`UnReservePopulationSlots`, `Trainer.js:303-304`) because the ownership change adds the real cost (`Player.js:627-630`) — no double counting.
5. **Stop/cancel**: reservation released and resources refunded (`Trainer.js:148-159`).

Edge cases a bot must handle:

- `popUsed` includes started, still-training batches — the visible `popCount` can therefore already be at the limit while units are still in the queue.
- `popUsed` can **exceed** `popLimit` (houses destroyed after units were trained). Nothing is killed, but `TryReservePopulationSlots` fails for any `num != 0` until `popUsed` drops below the limit again — training deadlocks until the bot rebuilds housing.
- Pausing a not-yet-started item clears the blocked flag (`Trainer.js:355-364`).

## Entity limits (per-category training/build limits)

Three pieces:

- **`TrainingRestrictions`** on unit templates: a `Category` (e.g. `Hero`) and an optional `MatchLimit` (`public/simulation/components/TrainingRestrictions.js:10-17`). Heroes have `Category Hero` + `MatchLimit 1` (`public/simulation/templates/template_unit_hero.xml:65-68`).
- **`BuildRestrictions`** on structure templates: a `Category` (e.g. `CivilCentre`, `Wonder`, `Fortress`) and optional `MatchLimit` (`public/simulation/components/BuildRestrictions.js:35-42`).
- **`EntityLimits`** on the player template, mapping categories to caps (`public/simulation/templates/template_player.xml:20-62`):
  - `Limits`: `Animal 50`, `CivilCentre 1`, `Hero 1`, `Juggernaut 1`, `Wonder 1`, `Monument 5`, `Palace 1`, `Centurion 8`, `Kennel 2`, `Library 1`, `Lighthouse 1`, `Theater 1`, `Yakhchal 5`, `PyramidLarge 2`, `TempleOfAmun/Isis/Vesta 1`, `Gladiator 0`, `Pillar 0`, `WarDog 0`. A limit of 0 means "cannot build/train until raised by a changer or removed by a remover". Categories without an entry are unlimited (e.g. ordinary houses, fortresses, siege — only categories with a `TrainingRestrictions`/`BuildRestrictions` category *and* a matching `Limits` entry are constrained; ordinary military units have no `TrainingRestrictions` at all).
  - `LimitChangers`: owning an entity of a class raises a category's limit — e.g. each `Kennel` adds 10 to `WarDog`, each `Amphitheater` adds 15 to `Gladiator` (`template_player.xml:43-56`; logic in `EntityLimits.js:284-293`). Foundations do not change limits until completed (`EntityLimits.js:280-283`).
  - `LimitRemovers`: a limit is lifted when requirements are met — the `CivilCentre` limit of 1 is removed once `phase_town` is researched (`template_player.xml:57-61`; logic in `EntityLimits.js:138-163`), i.e. additional civil centres can only be built from Town Phase on.

### Where limits are enforced

- **Training**: at queue time. `Trainer.prototype.Item.Queue` calls `AllowedToTrain(category, count, templateName, matchLimit)`; on failure the resources are refunded and the batch is not queued (`Trainer.js:84-95`). On success the category count is incremented immediately (`Trainer.js:97-99`), so queued-but-not-trained units count against the limit. On spawn the count is decremented then re-incremented by the ownership change, keeping `count = queued + alive` (`Trainer.js:276-286`, `EntityLimits.js:263-273`).
- **Building**: the foundation is placed first (its ownership change already increments the count), then `AllowedToBuild(category)` re-checks with count 0; if over the limit the foundation is destroyed and the command fails (`public/simulation/helpers/Commands.js:1208-1219`, `EntityLimits.js:207-212`).
- **Replacement/upgrades**: `AllowedToReplace` checks the target template's category, with count 0 when source and target share the category (`EntityLimits.js:224-243`, called from `Commands.js:752`).
- **Check formula** (`EntityLimits.js:165-182`): creation is allowed iff `count[category] + requested ≤ limit[category]`, and iff `matchTemplateCount[template] + requested ≤ MatchLimit` when the template has one.

**MatchLimit is per-match and survives death**: `matchTemplateCount` is only decremented when a queued batch is cancelled (`Trainer.js:144-145`), never when the entity dies. A hero that dies therefore cannot be retrained.

Hitting a limit only pushes a GUI notification ("%(category)s training limit of %(limit)s reached", `EntityLimits.js:184-205`) — for an AI the train/build command simply fails, so the bot must check limits itself before issuing commands.

## What a bot sees

Player state in `GetSimulationState` / the AI `playerData` (`public/simulation/components/GuiInterface.js:105-128`):

- `popCount` = `popUsed` (includes started training batches), `popLimit` = `min(maxPop, popBonuses)`, `popMax` = modified cap.
- `trainingBlocked` — true while any queue is stuck on population or spawn space.
- `entityLimits` (category → current limit, `undefined` entries are dropped/removed limits), `entityCounts` (category → queued + alive), `matchEntityCounts` (template → trained-this-match), `entityLimitChangers`.
- Match-level: `populationCapType`, `populationCap` (`GuiInterface.js:165-166`).

AI API wrappers (`public/simulation/ai/common-api/gamestate.js`): `gameState.getPopulation()` / `getPopulationLimit()` / `getPopulationMax()` (lines 314-325), `getEntityLimits()` / `getEntityCounts()` / `getEntityMatchCounts()` (lines 908-921), `isEntityLimitReached(category)` (lines 938-944). Per-template values come from the template data itself: `template.Cost.Population` and `template.Population.Bonus`.

Free population available for new training = `popLimit - popCount`; to raise it, build completed houses (each +5 for a generic/gaul house) or a civil centre (+20), up to `popMax`.
