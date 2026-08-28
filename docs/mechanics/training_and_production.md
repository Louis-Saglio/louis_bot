# Unit training and the production queue (0 A.D. 0.28.0)

Grounded in `public/simulation/components/ProductionQueue.js`, `Trainer.js`, `Researcher.js`, `RallyPoint.js`, `Cost.js`, `TrainingRestrictions.js`, `EntityLimits.js`, `Player.js`, `TechnologyManager.js`, `public/simulation/helpers/Commands.js`, `public/simulation/helpers/RallyPointCommands.js`, `public/simulation/helpers/Transform.js` and `source/simulation2/components/CCmpFootprint.cpp` (all paths relative to `/home/ubuntu/0ad-reference`). Template examples from `public/simulation/templates/`.

## Architecture: one queue per production building

- Each production building owns **one** `ProductionQueue` component holding a single FIFO array (`this.queue = []`, `ProductionQueue.js:220`). Multiple buildings produce fully independently and in parallel.
- A queue item is either a **unit batch** (a template + a `count`, handled by the building's `Trainer` component) or a **technology** (handled by `Researcher`); units and techs share the same queue and block each other (`ProductionQueue.js:29-39`).
- Max **16 items** per queue (`MaxQueueSize`, `ProductionQueue.js:8`); adding to a full queue fails with a "production queue is full" notification (`ProductionQueue.js:318-331`).
- Queues are processed strictly front-to-back: only the head item progresses (leftover time within one tick rolls over to following items, see below). There is no parallel training inside one building.

## Queueing an item: the `train` command flow

The GUI/AI sends a `{"type": "train", "entities": [...], "template", "count", "metadata", "pushFront"}` command (`Commands.js:278-335`, AI wrapper `ai/common-api/entity.js:932-955`). Per building:

1. `count` must be a positive integer (`Commands.js:280-284`, re-checked in `Trainer.js:49-53`).
2. Entity-limit pre-check (see "Training restrictions" below) (`Commands.js:300-311`).
3. `TechnologyManager.CanProduce(template)` — the template's required tech (from `Identity/Requirements`) must be researched (`Commands.js:313-319`).
4. For AI players only, the template name is first upgraded via `GetUpgradedTemplate` (auto-promotion fix, `Commands.js:327-330`).
5. `cmpTrainer.CanTrain(templateName)` — the template must be in the building's resolved trainer list (`Commands.js:332`, `Trainer.js:599-602`).
6. `ProductionQueue.AddItem(...)` → `Trainer.QueueBatch` → `Item.Queue` (`ProductionQueue.js:295-351`, `Trainer.js:611-620`).

If the building has an `Upgrade` component currently upgrading, adding an item is rejected **only when the queue is empty** ("Entity is being upgraded", `ProductionQueue.js:300-317`).

## Costs: paid in full up front

Resource costs are subtracted from the player **at queue time**, not at completion:

- Per-unit cost of resource `res`: `trainCostMultiplier[res] × Cost/Resources/res` (with technology/aura modifications applied via `ApplyValueModificationsToTemplate`) (`Trainer.js:67-74`).
- `trainCostMultiplier` comes from the trainer template's `Trainer/TrainCostMultiplier/<res>` (default 1 per resource and for `time`) (`Trainer.js:566-573`).
- Total charged for the batch: `floor(count × perUnitCost)` per resource (`Trainer.js:76`).
- If the player cannot pay the full batch, `TrySubtractResources` fails, the player gets an "Insufficient resources" notification listing the missing amounts (`Player.js:286-339`), and **the item is not queued** (`Trainer.js:79-80`, `ProductionQueue.js:334-335`). There is no "waiting for resources" state — unaffordable batches simply never enter the queue.

Base values come from the unit template's `Cost` component: `Population` (integer), `BuildTime` (**seconds**), `Resources` (integers) (`Cost.js:15-23`).

## Batch training: exact time formula

Total batch training time in milliseconds (`Trainer.js:103-107`, `Trainer.js:586-593`):

```
batchTime(ms) = count^BatchTimeModifier × trainCostMultiplier.time × BuildTime(s) × 1000
```

- `BatchTimeModifier` is a property of the **trainer building** (default 1 = no batch discount, `Trainer.js:12-15`). Common values: 0.8 for barracks, stable, dock, fortress, temple, civil centre (`template_structure_military_barracks.xml:57`, `template_structure_civic_civil_centre.xml:140`); 0.7 for market, kennel, corral, arsenal (`template_structure_economic_market.xml:69`, `template_structure_military_kennel.xml:69`).
- Example: barracks (0.8), batch of 5 spearmen (BuildTime 10 s) → 10 × 5^0.8 ≈ 36.2 s total, i.e. ≈ 7.24 s/unit instead of 10 s.
- Technologies can modify it: `barracks_batch_training` ("Conscription") does `{ "value": "Trainer/BatchTimeModifier", "add": -0.1 }` on Barracks, i.e. batch time gets divided by `batchSize^0.1` (`simulation/data/technologies/barracks_batch_training.json`).
- The resource cost does **not** scale with the modifier — a batch of N always costs N × unit cost (`Trainer.js:76`).

## Population: reserved when the item starts

- Population slots for the whole batch (`Cost/Population × count`, tech-modified) are reserved on the **first progress tick** of the item, via `TryReservePopulationSlots` (`Trainer.js:168-193`).
- If free population is insufficient, `TryReservePopulationSlots` returns the number of missing slots, the player is flagged `BlockTraining()`, and the item retries on every tick without consuming time (`Trainer.js:181-186`, `Trainer.js:343-344`, `Player.js:138-145`). The batch sits at the head of the queue at 0% progress until houses/CCs free up.
- Reservation is released when units spawn (`Trainer.js:303-304`) or the item is cancelled (`Trainer.js:150-151`). Ownership changes reset the queue precisely so reserved slots don't leak (`ProductionQueue.js:513-521`).

## Progress timer

- A repeating timer fires every **1000 ms of game time** while the queue is non-empty (`ProgressInterval`, `ProductionQueue.js:7`, `ProductionQueue.js:480-493`); timer lateness is added to the tick budget (`ProductionQueue.js:414`).
- Per tick, the time budget (`1000 + lateness` ms) is spent on the head item; if the item finishes, leftover time rolls over to the next item in the same tick (`ProductionQueue.js:416-435`). A batch with `timeRemaining ≤ budget` finishes mid-tick.
- Per item: `timeRemaining` counts down; `progress = 1 − timeRemaining/timeTotal` (`Trainer.js:338-353`, `Trainer.js:374-385`). Note progress is for the **whole batch**: all `count` units spawn at once when the batch timer completes (they are not trickled out).
- The AI sees the queue as `entity.trainingQueue`, an array of `{id, unitTemplate, count (remaining), neededSlots, progress, timeRemaining, paused, metadata}` (or `technologyTemplate` for techs), refreshed on `MT_ProductionQueueChanged` (`AIProxy.js:158-163`, `AIProxy.js:273-277`, `Trainer.js:374-385`).

## Cancellation and refunds

- Removal is by item id: `stop-production` command → `ProductionQueue.RemoveItem(id)` → `Item.Stop()` (`Commands.js:352-357`, `ProductionQueue.js:356-368`); AI: `entity.stopProduction(id)` (`ai/common-api/entity.js:987-990`).
- A unit batch cancel (`Trainer.js:124-162`):
  - destroys any cached unspawned entity instances;
  - refunds **100% of the cost of the unspawned units** (`floor(count_remaining × perUnitCost)` per resource) — no partial-progress penalty, time invested is simply lost;
  - frees reserved population and entity-limit counts for the remaining count.
- Cancelling a technology refunds its full cost too (`TechnologyManager.js:55-68`).
- Removing the head item does not pause the queue; the next item starts on the next tick. Emptying the queue stops the timer (`ProductionQueue.js:366-368`).
- `ResetQueue()` removes everything and disables auto-queue; it runs on **ownership change** (captured buildings refund the previous owner's items and start empty) (`ProductionQueue.js:393-399`, `ProductionQueue.js:513-521`).

## Spawning, rally points and rally point commands

When a batch timer completes, `Item.Spawn()` runs (`Trainer.js:214-332`):

- Entities are created once (lazily, `Engine.AddEntity`, initially ownerless) and reused across spawn attempts (`Trainer.js:221-226`).
- **Auto-garrison:** if the first rally point targets the trainer itself with command `"garrison"`, units are garrisoned directly into the building instead of spawning (`Trainer.js:228-235`).
- Otherwise each unit is placed at `Footprint.PickSpawnPoint`: a free tile searched in rows around the building footprint, spacing `3 × unit obstruction radius`, up to `MaxSpawnDistance` (default 7 m) from the edge (`CCmpFootprint.cpp:156-230`, default at `CCmpFootprint.cpp:131`). Units face away from the building (`Trainer.js:270-271`).
- **Spawn failure:** if no free spot exists (`pos.y < 0`), spawning stops mid-batch; remaining units stay cached, the batch keeps its remaining `count`, the player is `BlockTraining()`-flagged and gets a one-time "Can't find free space to spawn trained units" notification (`Trainer.js:263-265`, `Trainer.js:313-326`). The item then **finishes only when all units have spawned** — `Finish` marks it finished only at `count == 0`, so the queue head retries spawning on subsequent ticks (`Trainer.js:195-200`). A walled-in building will block its queue indefinitely.
- Rally points are set with `{"type": "set-rallypoint", "entities", "x", "z", "data": {"command", "target", ...}, "queued"}`; without `queued` the existing rally point is replaced, with `queued` waypoints are appended (`Commands.js:418-432`, `RallyPoint.js:12-18`, `RallyPoint.js:76-79`). `unset-rallypoint` clears it (`Commands.js:434-442`).
- On spawn, `GetRallyPointCommands` converts each waypoint into an order given to all spawned units (`Trainer.js:296-298`, `helpers/RallyPointCommands.js:3-172`):
  - supported commands: `walk` (default), `gather`, `gather-near-position`, `repair`/`build` (mapped to `repair`, with `autocontinue` on the last waypoint), `garrison`, `occupy-turret`, `attack`, `attack-walk`, `patrol`, `trade` (→ `setup-trade-route`), `collect-treasure`, `collect-treasure-near-position`;
  - if the waypoint's target entity no longer exists/has no position, the command degrades: `gather` → `gather-near-position`, `collect-treasure` → `collect-treasure-near-position`, `attack` → `attack-walk`, everything else → `walk` (`RallyPointCommands.js:15-29`);
  - special case: several `walk` waypoints followed by a `trade` waypoint are merged into one trade route with waypoints (`RallyPointCommands.js:148-169`);
  - a rally point on a **moving target** tracks the target's current position, but only while the target is alive and visible to the owner (`RallyPoint.js:30-72`);
  - rally points are reset on ownership change (`RallyPoint.js:156-163`).
- AI wrappers: `entity.setRallyPoint(target, command)` / `entity.unsetRallyPoint()` (`ai/common-api/entity.js:921-930`).

## Trainer entity lists: `{civ}` / `{native}` substitution and live updates

- The trainable list is the building template's `Trainer/Entities` token list (`Trainer.js:16-23`, e.g. `template_structure_military_barracks.xml:58-64`).
- Resolution (`Trainer.CalculateEntitiesMap`, `Trainer.js:477-564`): `{civ}` → the **owner's** civ code, `{native}` → the **building's own** civ code (`Trainer.js:525-526`, `Trainer.js:544-548`).
- Tokens are dropped if the template file does not exist (`TemplateExists`) or is disabled for the player — this is how civ restrictions work in practice: `units/{civ}/infantry_pikeman_b` silently vanishes for civs without that file (`Trainer.js:550-555`). Technologies/auras can add or remove tokens via `ApplyValueModificationsToEntity("Trainer/Entities/_string", ...)` (`Trainer.js:485-489`).
- `GetUpgradedTemplate` then walks each template's `Promotion` chain and substitutes the promotion target whenever its `RequiredXp` is 0 (i.e. auto-promoting units, e.g. after a tech zeroes the XP requirement) (`Trainer.js:557`, `Transform.js:309-326`).
- **Queued items are updated in place:** when the entities map is recalculated (value modification on `Trainer/Entities` or `Promotion`, disabled-templates change, ownership change), items in the queue whose template was renamed get their `templateName` rewritten; items whose template was removed/disabled are stopped (with refund) (`Trainer.js:505-519`, `Trainer.js:678-704`). So a queued unit *can* be "promoted" (its template swapped) while still in the queue.
- AI caveat: the AI-side `trainableEntities(civ)` reads the raw template string and does its own `{civ}`/`{native}` replacement — it does **not** apply tech token modifications, disabled templates, or promotion upgrades (`ai/common-api/entity.js:326-331`; the simulation compensates for promotion only, `Commands.js:327-330`).

## Training restrictions and entity limits

- A unit template may carry `TrainingRestrictions` with a `Category` and an optional per-match `MatchLimit` (`TrainingRestrictions.js:3-17`). Schema-listed categories: Animal, Centurion, Gladiator, Hero, Mercenary, Minister, Juggernaut, ScoutShip, WarDog. Example: all heroes are `Category Hero, MatchLimit 1` (`template_unit_hero.xml:65-68`).
- Limits per category are defined on the **player entity** (`EntityLimits` in `template_player.xml:20-62`): e.g. `Hero 1`, `Animal 50`, `Centurion 8`, `WarDog 0`, `Gladiator 0`. `LimitChangers` raise a limit per owned building class (each Kennel adds +10 WarDog, `template_player.xml:43-56`); `LimitRemovers` lift a limit when techs/classes are met (e.g. `phase_town` removes the `CivilCentre 1` limit, `template_player.xml:57-61`).
- Check: `count[category] + count > limit[category]` → rejected with a "training limit reached" notification; similarly `matchTemplateCount[template] + count > MatchLimit` (`EntityLimits.js:165-182`, called at queue time from `Trainer.js:84-101`; on rejection the just-subtracted resources are refunded, `Trainer.js:93-94`). A batch that would exceed the limit is rejected **whole** — queue a smaller batch instead.
- The category count includes **both alive units and units currently in training queues** (incremented at queue, decremented at spawn where the ownership-change handler re-adds it, `Trainer.js:97`, `Trainer.js:280-285`, `EntityLimits.js:263-273`). Queued-then-cancelled batches free their count (`Trainer.js:139-146`).

## Technologies in the same queue (Researcher)

- Techs share the building's `ProductionQueue` with unit batches; `count` is ignored (`ProductionQueue.js:34-35`).
- Researchable list: building's `Researcher/Technologies` tokens; `{civ}` → owner civ if that tech file exists, else `generic`; filtered by requirements (`CheckTechnologyRequirements`), player-disabled techs, and already-researched/in-progress items (with `supersedes` chains collapsed); `top`/`bottom` pairs returned as pair objects (`Researcher.js:177-267`).
- Cost: `floor(techCostMultiplier[res] × tech.cost[res])` paid up front; research time `techCostMultiplier.time × researchTime × 1000` ms; `TechCostMultiplier` defaults to 1 per resource/time (`TechnologyManager.js:24-53`, `Researcher.js:272-282`).
- Actual progress state lives in the player's `TechnologyManager` (`researchQueued` map keyed by tech name — a given tech can only be researched by one building at a time) (`TechnologyManager.js:462-470`).
- Cancelling a tech refunds everything; pausing propagates to the `TechnologyManager` (`Researcher.js:59-63`, `Researcher.js:95-104`, `TechnologyManager.js:55-68`).
- The `research` command checks `CanResearch` (requirements met) before queueing (`Commands.js:337-350`).

## Auto-queue

Exists in 0.28.0:

- `EnableAutoQueue` / `DisableAutoQueue` per building, via `autoqueue-on` / `autoqueue-off` commands (`ProductionQueue.js:264-283`, `Commands.js:862-880`).
- When the head item finishes and auto-queue is on, the **original item** (template, count, metadata) is re-appended to the back of the queue (`ProductionQueue.js:438-460`).
- Deliberate inefficiency: the re-added item does not start until the next tick (`break`, `ProductionQueue.js:459`), so auto-queue is slightly slower than manual re-queueing and can never finish two batches in one tick.
- If re-queueing fails (insufficient resources, entity limit, …), auto-queue turns itself off with a "Could not auto-queue unit, de-activating." notification (`ProductionQueue.js:449-458`). Costs are charged at each re-queue, not once up front.
- `ResetQueue()` (e.g. on capture) also disables auto-queue (`ProductionQueue.js:398`).

## Pause conditions

- `pushFront: true` on AddItem inserts at the head and **pauses** the current head item; it resumes automatically when it becomes head again (`ProductionQueue.js:338-342`, `ProductionQueue.js:123-124`).
- Garrisoning the production building inside something (e.g. a ship) pauses the whole queue; ungarrisoning resumes it (`ProductionQueue.js:523-529`).
- `PauseProduction` / `UnpauseProduction` stop/start the timer and pause the head item (`ProductionQueue.js:467-478`).
- A batch that cannot start (population) or cannot finish spawning (no free space) does not consume time but also never yields the head position — the whole queue stalls behind it.

## Bot-relevant edge cases (summary)

- You pay for the full batch when queueing; you get a full refund of the unspawned remainder when cancelling — cancelling a 99%-done batch loses only time.
- One queue per building, 16 items max, strictly sequential head processing.
- Population is checked when the item *starts*, resources when it is *queued*, entity limits at *both* command handling and queueing.
- A blocked head (no pop / no spawn space) stalls the entire queue — watch `neededSlots` and `progress` in `trainingQueue`.
- Batch discount only affects time, never resources: `time ∝ count^BatchTimeModifier`.
- Auto-queue re-charges resources each cycle and self-disables on failure.
- Captured buildings lose their queue (with refunds to the previous owner) and their rally points.
- The AI-side trainable list can lie about tech-modified/disabled templates; the simulation is authoritative (queueing simply fails).
