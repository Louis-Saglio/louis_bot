# AI Engine API — 0 A.D. 0.28.0

Reference documentation for writing an in-engine JavaScript AI bot mod.

**Source basis.** Everything below is grounded in the pinned game copy at
`/home/ubuntu/0ad-reference/` (version 0.28.0). Citation paths are relative to
that root, in `path:line` form. Where this document and the source disagree,
the source wins. Petra's strategy code (`attackManager.js`, etc.) is out of
scope; `petra/_petrabot.js` is only used as the canonical example of how a bot
is wired to the engine.

The AI runs as SpiderMonkey JS inside the engine. The engine-side machinery is
`CCmpAIManager` (`source/source/simulation2/components/CCmpAIManager.cpp`) plus
two scripted system components, `AIInterface` and `AIProxy`
(`public/simulation/components/AIInterface.js`, `AIProxy.js`). The JS-facing
"common API" lives in `public/simulation/ai/common-api/`.

---

## 1. Declaring and loading a bot

### 1.1 Mod layout and `data.json`

A bot is a directory `simulation/ai/<botname>/` inside a mod. The engine
discovers bots by recursively scanning `simulation/ai/` for `*.json` files
(`source/source/simulation2/components/ICmpAIManager.cpp:66-89`); each found
JSON is exposed to the game setup UI as `{ "id": <dirname>, "data": <json> }`
(`source/source/simulation2/components/ICmpAIManager.cpp:85-86`).

The JSON (`data.json`) fields — example `public/simulation/ai/petra/data.json:1-7`:

- `name` — display name.
- `description` — display text.
- `constructor` — name of the exported constructor function, e.g. `"PetraBot"`.
- `filename` — ES module inside the bot directory that exports that
  constructor, e.g. `"_petrabot.js"`.
- `useShared` — boolean; if true, this bot's per-player instance receives the
  shared script (`SharedScript`) at init/update time.

Loading happens in `CAIPlayer::Initialise`: the engine reads
`simulation/ai/<botname>/data.json`, loads the module
`simulation/ai/<botname>/<filename>` via the module loader, fetches the
`constructor` export, and calls it with a settings object
(`source/source/simulation2/components/CCmpAIManager.cpp:131-204`).

### 1.2 Constructor signature and settings

```js
export function MyBot(settings)
{
	BaseAI.call(this, settings);
	...
}
MyBot.prototype = Object.create(BaseAI.prototype);
```

(`public/simulation/ai/petra/_petrabot.js:8-27`)

The `settings` object is built engine-side with exactly these properties
(`source/source/simulation2/components/CCmpAIManager.cpp:180-192`):

- `player` — the player ID this instance controls (`player_id_t`).
- `difficulty` — `u8`, from game settings `PlayerData[i].AIDiff`
  (`public/simulation/helpers/InitGame.js:58`). Petra interprets 0–5 as
  Sandbox…Very Hard (`public/simulation/ai/petra/difficultyLevel.js:3-9`).
- `behavior` — string, from game settings `PlayerData[i].AIBehavior`,
  defaulting to `"random"` (`public/simulation/helpers/InitGame.js:58`).
  Petra recognizes `"balanced"`, `"aggressive"`, `"defensive"`
  (`public/simulation/ai/petra/config.js:8-9`).
- `templates` — **only if `useShared` is false**: all used entity templates
  (`source/source/simulation2/components/CCmpAIManager.cpp:188-192`).

There is **no `customData` injection mechanism** in 0.28.0: the constructor
settings contain only the fields above. Custom per-bot configuration must be
hardcoded in the bot or read from files via `Engine.ReadJSONFile`.

### 1.3 Script sandboxing

All AI players run in one JS realm that shares the SpiderMonkey compartment
with the simulation, so the AI can read simulation objects directly
(`source/source/simulation2/components/CCmpAIManager.cpp:101-103`, `263-271`).
Module loading is restricted: only modules whose VFS path starts with
`simulation/ai/` may be imported from AI code
(`source/source/simulation2/components/CCmpAIManager.cpp:267-271`). The AI
script interface is named `Engine` — that object is the root of the native API
(§2). In addition, the simulation realm's global object and native scope are
exposed as the globals `Sim` and `SimEngine`
(`source/source/simulation2/components/CCmpAIManager.cpp:287-294`), which AI
code uses to query live components, e.g.
`SimEngine.QueryInterface(this.id(), Sim.IID_ResourceSupply)`
(`public/simulation/ai/common-api/entity.js:579`, `670`).

All `public/globalscripts/*.js` are loaded into the AI realm
(`source/source/simulation2/components/CCmpAIManager.cpp:312`;
`source/source/scriptinterface/ScriptInterface.cpp:450-467`), providing
globals such as `clone`, `deepfreeze`, `pickRandom`, `randFloat`,
`GetIdentityClasses`, `MatchesClassList`, `GetTechnologyBasicDataHelper`,
`UnravelPhases`, `TradeGainNormalization`, the `Resources` class and the
`TechnologyTemplates` cache
(`public/globalscripts/ModificationTemplates.js:44`).

### 1.4 Shared script (`useShared`)

If any AI player has `useShared: true`, the engine loads
`simulation/ai/common-api/shared.js` and constructs one `SharedScript`
instance shared by all such players
(`source/source/simulation2/components/CCmpAIManager.cpp:410-469`). Its
constructor receives `{ "players": {0: id, ...}, "templates": <all templates> }`
(`source/source/simulation2/components/CCmpAIManager.cpp:439-460`). The shared
script holds the entity wrappers, entity collections, terrain analysis and one
`GameState` per AI player (`public/simulation/ai/common-api/shared.js:7-28`,
`133-138`).

### 1.5 Lifecycle and turn model

- A simulation turn is 200 ms by default
  (`source/source/simulation2/system/TurnManager.h:62`).
- At the end of map generation, `InitGame` calls `AddPlayer` per AI player,
  then `TryLoadSharedComponent()` and `RunGamestateInit()`
  (`public/simulation/helpers/InitGame.js:44-91`). `RunGamestateInit` passes the
  full game representation plus the passability and territory grids to
  `SharedScript.init(state, deserialization)` and then calls each AI's
  `Init(state, playerID, sharedAI)`
  (`source/source/simulation2/components/CCmpAIManager.cpp:486-520`;
  `public/simulation/ai/common-api/baseAI.js:29-42`). `Init` stores
  `gameState`, `territoryMap`, `accessibility`, then calls the bot-overridable
  `CustomInit(gameState)` (`public/simulation/ai/common-api/baseAI.js:41-47`).
- At the **end of every simulation turn**, the engine runs
  `StartComputation()` + `PushCommands()`
  (`source/source/simulation2/Simulation2.cpp:580-586`). The computation calls
  `SharedScript.onUpdate(state)` first (apply entity/template deltas), then for
  each AI player `HandleMessage(state, playerID, sharedAI)` which delegates to
  the bot's `OnUpdate(sharedAI)`
  (`source/source/simulation2/components/CCmpAIManager.cpp:795-829`;
  `public/simulation/ai/common-api/baseAI.js:49-66`). `OnUpdate` is therefore
  invoked once per turn; bots self-throttle via `this.turn` (e.g. Petra plays
  one turn in eight, `public/simulation/ai/petra/_petrabot.js:108-132`).
- AI players see through fog of war: `AddPlayer` calls
  `cmpRangeManager->SetLosRevealAll(player, true)`
  (`source/source/simulation2/components/CCmpAIManager.cpp:926-931`).

### 1.6 Hotloading

AI bot modules are **not** hot-reloadable at runtime. `ReloadChangedFile` only
reloads files recorded in `m_LoadedScripts` (simulation component scripts);
AI modules are loaded through the module loader with no reload hook
(`source/source/simulation2/Simulation2.cpp:244-262`). Changing bot code
requires restarting the match. (The `Sim`/`SimEngine` globals are merely
marked *replaceable* so the AI realm survives hotloading of the simulation
side, `source/source/simulation2/components/CCmpAIManager.cpp:289-294`.)

---

## 2. The `Engine` API (native functions available to AI scripts)

`Engine` is the native scope of the AI's `ScriptInterface`
(`source/source/simulation2/components/CCmpAIManager.cpp:267`). Registered
functions:

- `Engine.PostCommand(playerID, cmd)` — queue a simulation command for the
  given player (§6). `cmd` is structured-cloned immediately
  (`source/source/simulation2/components/CCmpAIManager.cpp:299`, `318-331`).
  Logs an error if `playerID` has no AI player.
- `Engine.Exit(exitStatus)` — quit the whole engine process
  (`source/source/simulation2/components/CCmpAIManager.cpp:300`); wrapped by
  `exit()` in `public/simulation/ai/common-api/utils.js:12-15`.
- `Engine.ComputePath(position, goal, passClass)` — synchronous long-range
  pathfinding; `position`/`goal` are `{x, y}`-convertible objects, `passClass`
  is a passability-class mask (§7). Returns an array of `Vector2D` waypoints
  (objects with numeric `x`/`y`)
  (`source/source/simulation2/components/CCmpAIManager.cpp:302`, `333-358`;
  `source/source/simulation2/scripting/EngineScriptConversions.cpp:195-211`).
- `Engine.DumpImage(name, data, w, h, max)` — debug: write `data` (array of
  `w*h` values scaled by `max`) as an 8-bit greyscale PNG under
  `screenshots/aidump/`
  (`source/source/simulation2/components/CCmpAIManager.cpp:304`, `370-403`).
- `Engine.GetTemplate(name)` — return the raw template data of
  `simulation/templates/<name>.xml` as a plain object (XML attributes appear
  as `@attr` properties), or an empty/falsy value if the template does not
  exist (`source/source/simulation2/components/CCmpAIManager.cpp:305`,
  `360-365`; used as `Engine.GetTemplate(name) || null` in
  `public/simulation/ai/common-api/shared.js:58`). This is the **unmodified**
  template; tech/aura modifications are layered on by `Template.get` (§4).
- `Engine.ProfileStart(name)`, `Engine.ProfileStop()`,
  `Engine.ProfileAttribute(...)` — profiler markers, registered on every
  script interface's native scope
  (`source/source/scriptinterface/ScriptInterface.cpp:367-369`).
- Read-only VFS: `Engine.ListDirectoryFiles(path, filter, recursive)`,
  `Engine.FileExists(path)`, `Engine.ReadJSONFile(path)` — restricted to
  simulation-allowed paths
  (`source/source/ps/scripting/JSInterface_VFS.cpp:312-317`; registered at
  `source/source/simulation2/components/CCmpAIManager.cpp:309`).

Realm globals (defined on the global object, not on `Engine`): `print`,
`log`, `warn`, `error`, `clone`, `deepfreeze`
(`source/source/scriptinterface/ScriptInterface.cpp:355-361`), plus
everything from `public/globalscripts/` (§1.3) and the `PlayerID` global set
by `baseAI.js` before each call into the bot
(`public/simulation/ai/common-api/baseAI.js:1`, `31`, `51`).

**Not present in 0.28.0:** `Engine.GetEntityState`, `Engine.GetTemplateData`,
`Engine.GetEntities`, `Engine.GetPassabilityMap`, `Engine.GetTerrainTexture`,
`Engine.FlushEntitiesUpdates`, `Engine.SetHeuristic`. These names from older
AI-API documentation no longer exist; templates come from
`Engine.GetTemplate`/`gameState.getTemplate`, entities from the entity
collections, and the passability map from `gameState.getPassabilityMap()`.

---

## 3. The state object (per-turn delta representation)

The `state` argument of `init`/`onUpdate`/`HandleMessage` is built by
`AIInterface.GetRepresentation()` (incremental) or `GetFullRepresentation()`
(initial and post-load), which start from
`GuiInterface.GetSimulationState()` and add AI-specific fields
(`public/simulation/components/AIInterface.js:91-159`).

Top-level fields:

- `players` — array per player of the object built at
  `public/simulation/components/GuiInterface.js:97-135`: `name`, `civ`,
  `color`, `entity`, `controlsAll`, `popCount`, `popLimit`, `popMax`,
  `panelEntities`, `resourceCounts`, `resourceGatherers`, `trainingBlocked`,
  `state` (`"active"`, `"defeated"`, `"won"`), `team`, `teamLocked`,
  `disabledTemplates`, `disabledTechnologies`, `hasSharedDropsites`,
  `hasSharedLos`, `spyCostMultiplier`, `phase`, `isAlly` / `isMutualAlly` /
  `isNeutral` / `isEnemy` (arrays indexed by player), `entityLimits`,
  `entityCounts`, `matchEntityCounts`, `entityLimitChangers`,
  `researchQueued`, `researchedTechs`, `classCounts`, `typeCountsByClass`,
  `canBarter`, `barterPrices`, `statistics`.
- `timeElapsed` (ms), `circularMap`, `mapSize`, `victoryConditions`,
  `alliedVictory`, `ceasefireActive`, `ceasefireTimeRemaining` (ms),
  `cinemaPlaying`, `populationCapType`, `populationCap`
  (`public/simulation/components/GuiInterface.js:137-172`).
- `entities` — map entityID → state fragment. In the full representation each
  entry is the complete `AIProxy.GetFullRepresentation()` object
  (`public/simulation/components/AIProxy.js:213-317`); afterwards each entry
  contains only the properties that changed this turn
  (`AIInterface.js:110-132`, `AIProxy.js:47-62`). See §4.3 for the field list.
- `events` — per-turn event lists, keyed by the names in
  `AIInterface.EventNames` (`public/simulation/components/AIInterface.js:6-28`):
  `Create`, `Destroy`, `Attacked`, `ConstructionFinished`,
  `DiplomacyChanged`, `TrainingStarted`, `TrainingFinished`, `AIMetadata`,
  `PlayerDefeated`, `EntityRenamed`, `ValueModification`, `OwnershipChanged`,
  `Garrison`, `UnGarrison`, `TerritoriesChanged`, `TerritoryDecayChanged`,
  `TributeExchanged`, `AttackRequest`, `CeasefireEnded`, `DiplomacyRequest`,
  `TributeRequest`. Events are reset after being handed over
  (`AIInterface.js:100-105`). `AttackRequest` / `DiplomacyRequest` /
  `TributeRequest` are pushed by the corresponding player commands
  (`public/simulation/helpers/Commands.js:780-796`, `833-845`). There is **no
  chat event**: AI scripts cannot read player chat in 0.28.0 (§9).
- `changedTemplateInfo` — player → template → list of
  `{ "variable": "Path/In/Template", "value": newValue }` produced when a
  researched tech modifies template values
  (`public/simulation/components/AIInterface.js:215-273`).
- `changedEntityTemplateInfo` — entity → list of the same, for aura-like
  per-entity modifications (`public/simulation/components/AIInterface.js:275-320`).
- `passabilityClasses` — name → bitmask, e.g. `"default-terrain-only"`,
  `"ship-terrain-only"`, added by the AI manager
  (`source/source/simulation2/components/CCmpAIManager.cpp:1094-1112`).
- `passabilityMap` — `{ "width", "height", "data": Uint16Array }`
  (`Grid<NavcellData>`; `source/source/simulation2/scripting/EngineScriptConversions.cpp:233-250`),
  updated in place each turn when dirty
  (`source/source/simulation2/components/CCmpAIManager.cpp:529-566`).
  `SharedScript` adds `cellSize = mapSize / width`
  (`public/simulation/ai/common-api/shared.js:85-88`).
- `territoryMap` — `{ "width", "height", "data": Uint8Array }`
  (`source/source/simulation2/components/CCmpAIManager.cpp:568-594`), with
  `cellSize` added the same way (`shared.js:89-92`).

---

## 4. Common-API object model

### 4.1 `SharedScript` (`public/simulation/ai/common-api/shared.js`)

One instance for all `useShared` AIs. Key members:

- `SharedScript(settings)` — constructor (`shared.js:8-28`).
- `Serialize()` / `Deserialize(data)` — saved-game support (`shared.js:30-53`).
- `GetTemplate(name)` — cached wrapper around `Engine.GetTemplate`
  (`shared.js:55-61`).
- `init(state, deserialization)` — full (re)build: templates delta, maps,
  entities, `terrainAnalyzer`, `accessibility`, resource maps, one
  `GameState` per AI player (`shared.js:68-139`).
- `onUpdate(state)` — per-turn: `ApplyEntitiesDelta`, `ApplyTemplatesDelta`,
  refresh dynamic fields (`events`, `playersData`, `timeElapsed`,
  `barterPrices`, `ceasefire*`, `passabilityMap`, `territoryMap`), then update
  each `GameState` and the resource maps (`shared.js:145-180`).
- Public state: `playersData`, `timeElapsed`, `circularMap`, `mapSize`,
  `victoryConditions` (Set), `alliedVictory`, `ceasefireActive`,
  `ceasefireTimeRemaining` (seconds, `shared.js:83`), `passabilityClasses`,
  `passabilityMap`, `territoryMap`, `barterPrices`, `events`,
  `terrainAnalyzer`, `accessibility`, `resourceMaps`, `ccResourceMaps`,
  `gameState` (map player → GameState), `entities` (root `EntityCollection`
  of everything, `shared.js:113`).
- Entity metadata, arbitrary per-player annotations surviving saves:
  `setMetadata(player, ent, key, value)`, `getMetadata(player, ent, key)`,
  `deleteMetadata(player, ent, key)` (`shared.js:347-377`). Setting metadata
  notifies entity collections watching `metadata.<key>` (`shared.js:357-358`).
- Collection bookkeeping: `registerUpdatingEntityCollection(entCol)`,
  `removeUpdatingEntityCollection(entCol)`, `updateEntityCollections(prop, ent)`
  (`shared.js:313-345`).
- Resource influence maps: `createResourceMaps()`, `updateResourceMaps(events)`,
  `addEntityToResourceMap(ent)`, `removeEntityFromResourceMap(ent)`
  (`shared.js:391-459`).
- `copyPrototype(descendant, parent)` — prototype-copy helper used by
  terrain-analysis classes (`shared.js:379-389`).

### 4.2 `BaseAI` (`public/simulation/ai/common-api/baseAI.js`) — bot base class

- `BaseAI(settings)` — stores `this.player = settings.player` and
  `this.turn = 0` (`baseAI.js:3-12`).
- `Serialize()` / `Deserialize(data, sharedScript)` — return/receive a plain
  object persisted in saved games; `Deserialize` sets `this.isDeserialized`
  (`baseAI.js:14-27`). On the first update after a load, `HandleMessage`
  re-calls `Init` and clears the flag (`baseAI.js:55-59`).
- `Init(state, playerID, sharedAI)` — sets the `PlayerID` global, binds
  `territoryMap`, `accessibility`, `gameState`, `timeElapsed`, sets
  `gameState.ai = this`, then calls `CustomInit(gameState)`
  (`baseAI.js:29-42`). **Override `CustomInit`, not `Init`.**
- `HandleMessage(state, playerID, sharedAI)` — per-turn entry point called by
  the engine; updates `this.events`/`this.territoryMap`, then calls
  `OnUpdate(sharedAI)` (`baseAI.js:49-61`). **Override `OnUpdate`, not
  `HandleMessage`.**
- `chat(message)` — send a chat notification to human players
  (`baseAI.js:68-71`; §9).

There is no `OnGameFinished` hook in 0.28.0; Petra polls
`this.gameState.playerData.state == "defeated"` in `OnUpdate`
(`public/simulation/ai/petra/_petrabot.js:95`).

### 4.3 `GameState` (`public/simulation/ai/common-api/gamestate.js`)

One per AI player (`shared.js:133-138`), reachable as `this.gameState` in the
bot. Properties: `ai`, `sharedScript`, `player`, `playerData`, `entities`
(shared root collection), `timeElapsed`, `circularMap`, `victoryConditions`,
`alliedVictory`, `ceasefireActive`, `ceasefireTimeRemaining`, `phases`
(`gamestate.js:10-67`).

General:

- `getTimeElapsed()` — ms (`gamestate.js:119`); `getBarterPrices()`
  (`gamestate.js:124`); `getVictoryConditions()` (`:129`);
  `getAlliedVictory()` (`:134`); `isCeasefireActive()` (`:139`);
  `getPlayerID()` (`:327`); `getPlayerCiv(player?)` (`:171`);
  `applyCiv(str)` — replace `{civ}` (`:166`).

Templates and technologies:

- `getTemplate(type)` — `Template` wrapper, or `Technology` wrapper for tech
  names, or `null` (`gamestate.js:144-153`).
- `getBuiltTemplate(foundationName)` — template behind a `foundation|…` name
  (`:155-164`).
- `currentPhase()`, `getNumberOfPhases()`, `getPhaseName(i)`,
  `getPhaseEntityRequirements(i)` (`:176-211`).
- `isResearched(tech)`, `isResearching(tech)`, `canResearch(tech,
  noRequirementCheck?)`, `checkTechRequirements(reqs)` (`:213-295`).
- `isTemplateAvailable(name)`, `isTemplateDisabled(name)`,
  `isEntityLimitReached(category)` (`:923-944`).
- `getEntityLimits()`, `getEntityCounts()`, `getEntityMatchCounts()`
  (`:908-921`).
- `findAvailableTech()` — `[name, Technology]` pairs (`:768-802`);
  `findTrainableUnits(classes, anticlasses)` — `[name, Template]` pairs
  (`:726-761`); `hasTrainer(tpl)`, `findTrainers(tpl)`, `findBuilder(tpl)`,
  `hasResearchers(tech, noReq?)`, `findResearchers(tech, noReq?)`
  (`:807-906`).
- `getTraderTemplatesGains()` (`:946-958`).

Resources and population:

- `getResources()` — `ResourcesManager` over `playerData.resourceCounts`
  (`:309-312`); `getPopulation()`, `getPopulationLimit()`,
  `getPopulationMax()` (`:314-325`).

Diplomacy:

- `hasAllies()`, `hasEnemies()`, `hasNeutrals()`, `isPlayerNeutral(id)`,
  `isPlayerAlly(id)`, `isPlayerMutualAlly(id)`, `isPlayerEnemy(id)`,
  `getNumPlayerEnemies()`, `getEnemies()`, `getNeutrals()`, `getAllies()`,
  `getExclusiveAllies()`, `getMutualAllies()` (`:332-434`).
- `isEntityAlly(ent)`, `isEntityExclusiveAlly(ent)`, `isEntityEnemy(ent)`,
  `isEntityOwn(ent)` (`:436-462`).
- `resetOnDiplomacyChanged()` — drops cached diplo collections (`:112-117`).

Entities and collections (all return `EntityCollection` unless noted):

- `getEntityById(id)` — single `Entity` or undefined (`:464-467`).
- `getEntities(playerId?)` — all, or one player's (`:469-475`);
  `getStructures()` (`:477`); `getOwnEntities()` / `getOwnStructures()` /
  `getOwnUnits()` (`:482-498`); `getAllyEntities()` /
  `getExclusiveAllyEntities()` (`:500-508`); `getAllyStructures(allyID?)` /
  `getNeutralStructures()` / `getEnemyStructures(enemyID?)` /
  `getEnemyEntities()` / `getEnemyUnits(enemyID?)` (`:510-551`).
- `getOwnEntitiesByMetadata(key, value, maintain)`,
  `getOwnEntitiesByRole(role, maintain)`, `getOwnEntitiesByType(type,
  maintain)`, `getOwnEntitiesByClass(cls, maintain)`,
  `getOwnFoundationsByClass(cls, maintain)`, `getOwnFoundations()`,
  `getOwnTrainingFacilities()`, `getOwnResearchFacilities()`,
  `getOwnDropsites(resource?)`, `getAnyDropsites(resource?)`,
  `getResourceSupplies(resource)`, `getHuntableSupplies()`,
  `getFishableSupplies()` (`:553-723`). With `maintain` truthy the collection
  is kept and updated every turn; otherwise it is a one-shot filter.
- Counting: `countEntitiesByType`, `countEntitiesAndQueuedByType`,
  `countFoundationsByType`, `countOwnEntitiesByRole`,
  `countOwnEntitiesAndQueuedWithRole`, `countOwnQueuedEntitiesWithMetadata`
  (`:606-684`).
- Collection registry: `updatingCollection(id, filter, parentCollection)`,
  `destroyCollection(id)`, `updatingGlobalCollection(gid, filter,
  parentCollection)`, `destroyGlobalCollection(gid)` (`:77-107`).

Maps:

- `getPassabilityMap()` (`:297-300`); `getPassabilityClassMask(name)` —
  errors on unknown names (`:302-307`).

### 4.4 `Template` and `Entity` (`public/simulation/ai/common-api/entity.js`)

Both are declared with the `Class` helper (§8.1). `Entity` inherits from
`Template` (`entity.js:560-561`), so every template accessor also works on a
live entity.

**`Template`** wraps a template name plus its raw data
(`entity.js:5-16`). The core accessor:

- `get(path)` — template value at an XPath-like path (e.g.
  `"Health/Max"`, `"Obstruction/Static/@width"`). Lookup order: per-entity
  modifications (auras), then per-owner tech modifications, then the cached
  raw template value (`entity.js:19-43`). Raw values are cached per template
  (`_tpCache`); tech/aura deltas arrive each turn via
  `changedTemplateInfo`/`changedEntityTemplateInfo` and are applied by
  `SharedScript.ApplyTemplatesDelta`/`ApplyEntitiesDelta`
  (`shared.js:264-311`). Numbers in templates are strings — most accessors
  coerce with `+`.

Selected template accessors (all `entity.js`): `templateName()` `:45`,
`genericName()` `:47`, `civ()` `:49`, `matchLimit()` `:51`, `classes()` `:57`,
`hasClass(name)` `:64`, `hasClasses(array)` `:70`, `requirements()` `:76`,
`available(gameState)` `:80`, `cost()` `:85`, `costSum()` `:95`,
`techCostMultiplier(type)` `:105`, `obstructionRadius()` `:114`,
`footprintRadius()` `:147`, `maxHitpoints()` `:164`, `isHealable()` `:166`,
`isRepairable()` `:173`, `getPopulationBonus()` `:175`,
`resistanceStrengths()` `:182`, `attackTypes()` `:203`, `attackRange(type)`
`:214`, `attackStrengths(type)` `:224`, `captureStrength()` `:236`,
`attackTimes(type)` `:243`, `getCounteredClasses()` `:255`,
`counters(target)` `:278`, `getMultiplierAgainst(type, class)` `:299`,
`buildableEntities(civ)` `:319`, `trainableEntities(civ)` `:326`,
`researchableTechs(gameState, civ)` `:333`, `resourceSupplyType()` `:350`
(`{generic, specific}`), `getDiminishingReturns()` `:363`,
`resourceSupplyMax()` `:365`, `maxGatherers()` `:367`,
`resourceGatherRates()` `:369`, `resourceDropsiteTypes()` `:379`,
`isResourceDropsite(type?)` `:387`, `isTreasure()`/`treasureResources()`
`:392-394`, `garrisonableClasses()` `:404`, `garrisonMax()` `:406`,
`garrisonSize()` `:408`, `garrisonEjectHealth()` `:410`, `getDefaultArrow()`
`:412`, `getArrowMultiplier()` `:414`, `getGarrisonArrowClasses()` `:416`,
`buffHeal()` `:422`, `promotion()` `:424`, `isPackable()` `:426`,
`isHuntable()` `:428`, `walkSpeed()` `:435`, `trainingCategory()` `:437`,
`buildTime(researcher?)` `:439`, `buildCategory()` `:446`,
`buildDistance()` `:448`, `buildPlacementType()` `:458`,
`buildTerritories()`/`hasBuildTerritory(t)` `:460-470`,
`hasTerritoryInfluence()` `:472`, `hasDefensiveFire()` `:476`,
`territoryInfluenceRadius()`/`territoryInfluenceWeight()`/
`territoryDecayRate()` `:482-496`, `defaultRegenRate()` `:498`,
`garrisonRegenRate()` `:502`, `visionRange()` `:506`, `gainMultiplier()`
`:508`, `isBuilder()` `:510`, `isGatherer()` `:512`, `canGather(type)` `:514`,
`isGarrisonHolder()` `:524`, `isTurretHolder()` `:526`, `canCapture(target?)`
`:532`, `isCapturable()` `:544`, `canGuard()` `:546`, `canGarrison()` `:548`,
`canOccupyTurret()` `:550`, `isTreasureCollector()` `:552`, `hasUnitAI()`
`:554`.

**`Entity`** wraps the per-turn state fragment `this._entity`
(`entity.js:563-577`). Freshness model: `_entity` fields are updated **once
per turn** from the AIProxy delta (`shared.js:264-273`); within a turn they
are stale snapshots. A few accessors bypass the snapshot and query the live
simulation through `SimEngine`:

- `queryInterface(iid)` — `SimEngine.QueryInterface(this.id(), iid)`
  (`entity.js:579`). Used by the **live** accessors
  `resourceSupplyAmount()`, `resourceSupplyNumGatherers()`, `isFull()`,
  `resourceCarrying()` (`entity.js:669-689`).

Snapshot accessors (`entity.js`): `id()` `:583`, `position()` /
`angle()` — `undefined` when the entity is not in the world (garrisoned…)
`:601-602`, `isIdle()` `:604`, `getStance()` `:606`, `unitAIState()` `:607`,
`unitAIOrderData()` `:608`, `hitpoints()` `:610`, `isHurt()` /
`healthLevel()` / `needsHeal()` / `needsRepair()` `:611-614`, `decaying()`
`:615`, `capturePoints()` `:616`, `isInvulnerable()` `:617`,
`isSharedDropsite()` `:619`, `trainingQueue()` — items shaped
`{ "id", "template", "count", "progress", "metadata", "timeRemaining", … }`
`:625-627`, `trainingQueueTime()` `:629`, `foundationProgress()` `:639`,
`getBuilders()` / `getBuildersNb()` `:643-657`, `owner()` `:659`,
`isOwn(player)` `:663`, `currentGatherRate()` `:691`,
`garrisonHolderID()` `:721`, `garrisoned()` `:725`, `garrisonedSlots()`
`:727`, `canGarrisonInside()` `:737`, `canAttackClass(cls)` `:745`,
`canAttackTarget(target, allowCapture)` `:766`. Underlying state fields come
from `AIProxy.GetFullRepresentation`
(`public/simulation/components/AIProxy.js:213-317`).

Metadata (per-player, serialized, §4.1): `getMetadata(player, key)`,
`setMetadata(player, key, value)`, `deleteMetadata(player, key)`,
`deleteAllMetadata(player)` (`entity.js:590-599`).

Command helpers on a single entity — all are thin wrappers around
`Engine.PostCommand(PlayerID, …)` and return `this` (`entity.js:790-1010`):
`move(x, z, queued?, pushFront?)` `:790`, `moveToRange(x, z, min, max, …)`
`:795`, `attackMove(x, z, targetClasses, allowCapture?, …)` `:800`,
`setStance(stance)` `:806` (violent/aggressive/defensive/passive/
standground), `stopMoving()` `:813`, `unload(id)` `:817`, `unloadAll()`
`:825`, `garrison(target, …)` `:832`, `occupy-turret(target, …)` `:837`,
`attack(unitId, allowCapture?, …)` `:842`, `collectTreasure(target, …)`
`:847`, `moveApart(point, dist)` `:859`, `flee(unit)` `:877`,
`gather(target, …)` `:891`, `repair(target, autocontinue?, …)` `:896`,
`returnResources(target, …)` `:901`, `destroy()` `:906`,
`barter(buyType, sellType, amount)` `:911`, `tradeRoute(target, source)`
`:916`, `setRallyPoint(target, command)` `:921`, `unsetRallyPoint()` `:927`,
`train(civ, type, count, metadata, pushFront?)` `:932`,
`construct(template, x, z, angle, metadata)` `:957`,
`research(template, pushFront?)` `:977`, `stopProduction(id)` `:987`,
`stopAllProduction(percentToStopAt)` `:992`, `guard(target, …)` `:1002`,
`removeGuard()` `:1007`.

### 4.5 `EntityCollection` (`public/simulation/ai/common-api/entitycollection.js`)

Ordered map wrapper (entityID → `Entity`) with a filter chain. `length` is a
getter property (`entitycollection.js:13`).

Queries: `filter(filter, thisp?)` — accepts a filter object or a bare
function (`:80-91`); `filterNearest(targetPos, n?)` (`:96-118`);
`filter_raw(callback, thisp?)` over raw `_entity` state (`:120-130`);
`forEach(cb)` (`:132`); `hasEntities()` (`:139`); `values()` — iterator
(`:70`); `toIdArray()` / `toEntityArray()` (`:60-68`);
`getCentrePosition()` (`:255`); `getApproximatePosition(sample)` (`:276`);
`hasEntId(id)` (`:294`).

Mutation: `addEnt(ent)` / `removeEnt(ent)` / `updateEnt(ent, force)`
(`:300-338`); `freeze()` / `defreeze()` — a frozen collection auto-removes
dead entities but never auto-adds (`:44-58`, `:317-338`).

Auto-update registration: `registerUpdates()` / `unregister()` plus the
`dynamicProperties()`/`setUID`/`getUID` plumbing (`:340-363`). A registered
collection is re-evaluated each turn when one of its filters' dynamic
properties changes (`shared.js:313-345`).

Serialization: `Serialize()` / `Deserialize(data, sharedAI)` — filters are
persisted via `uneval`/`eval` (`entitycollection.js:17-42`).

Group commands (all `Engine.PostCommand` wrappers returning `this`):
`move(x, z, queued?, pushFront?)` `:144`, `moveToRange(x, z, min, max, …)`
`:157`, `attackMove(x, z, targetClasses, allowCapture?, …)` `:172`,
`moveIndiv(x, z, …)` `:187`, `garrison(target, …)` `:201`,
`occupyTurret(target, …)` `:213`, `destroy()` `:225`, `attack(unitId, …)`
`:231`, `setStance(stance)` `:244`.

### 4.6 Filters (`public/simulation/ai/common-api/filters.js`)

A filter is `{ "func": ent => bool, "dynamicProperties": [names] }`;
`dynamicProperties` tells the shared script which entity state changes should
re-evaluate collections using this filter (`filters.js:1-7`,
`entitycollection.js:9-11`). Combinators: `and(f1, f2)`, `or(f1, f2)`,
`not(f)` (`filters.js:41-63`).

Filters: `byType(type)` `:1`, `byClass(cls)` `:9`, `byClasses(list)` `:17`,
`byMetadata(player, key, value)` `:25`, `byHasMetadata(player, key)` `:33`,
`byOwner(owner)` `:65`, `byNotOwner(owner)` `:73`, `byOwners(owners)` `:81`,
`byCanGarrison()` `:89`, `byTrainingQueue()` `:97`,
`byResearchAvailable(gameState, civ)` `:105`, `byCanAttackClass(cls)` `:113`,
`byCanAttackTarget(target)` `:121`, `isGarrisoned()` `:129`, `isIdle()`
`:137`, `isFoundation()` `:145`, `isBuilt()` `:153`, `hasDefensiveFire()`
`:161`, `isDropsite(resourceType?)` `:169`, `isTreasure()` `:177`,
`byResource(resourceType)` `:194`, `isHuntable()` `:215`, `isFishable()`
`:225`.

---

## 5. Commands: how `PostCommand` reaches the simulation

1. AI code calls `Engine.PostCommand(playerID, cmd)`; the command is
   structured-cloned into that player's `m_Commands` vector
   (`source/source/simulation2/components/CCmpAIManager.cpp:318-331`).
2. At turn end, after the AI computation, `PushCommands()` moves them to
   `ICmpCommandQueue::PushLocalCommand`
   (`source/source/simulation2/components/CCmpAIManager.cpp:1040-1061`).
3. On the next turn's `FlushTurn`, local commands are processed together with
   player/network commands by the global `ProcessCommand` → the handlers in
   `g_Commands` (`source/source/simulation2/components/CCmpCommandQueue.cpp:95-100`,
   `112-126`; `public/simulation/helpers/Commands.js:5-7`).

Consequences:

- Commands take effect **one turn later** (single-player command delay is 1
  turn; multiplayer 4 — `source/source/simulation2/system/TurnManager.h:67`,
  `81`). Never command an entity created this turn; check `position()` etc.
  before ordering.
- Commands are plain objects with a `"type"` field matching a `g_Commands`
  key (`walk`, `attack`, `train`, `construct`, `research`, `barter`,
  `aichat`, …). The full set is the handler table in
  `public/simulation/helpers/Commands.js`; AI helpers in `entity.js` /
  `entitycollection.js` cover the common ones.
- Pending AI commands are part of the saved-game state
  (`source/source/simulation2/components/CCmpAIManager.cpp:679-685`), so
  commands queued right before a save survive a reload.

## 6. Determinism and the AI RNG

The AI realm's `Math.random` is replaced with a seeded generator:
`ReplaceNondeterministicRNG` installs a C++ `Math.random` backed by a
`boost::rand48` owned by the AI worker
(`source/source/simulation2/components/CCmpAIManager.cpp:281`;
`source/source/scriptinterface/ScriptInterface.cpp:469-489`). The seed comes
from the map settings' `AISeed` (`source/source/simulation2/Simulation2.cpp:356-366`)
and the RNG state is serialized into saved games
(`source/source/simulation2/components/CCmpAIManager.cpp:663-665`,
`713-717`). All the random helpers from `public/globalscripts/random.js`
(`pickRandom`, `randFloat`, `randIntInclusive`, `randomNormal2D`,
`shuffleArray` via `public/globalscripts/utility.js:4`) funnel through
`Math.random` and are therefore deterministic. **Do not** introduce other
entropy sources (`Date.now`, …) in bot code — it would break replay/MP
determinism.

---

## 7. Terrain analysis and maps

- Raw grids on the state/shared script: `passabilityMap` (Uint16 navcell
  bitmasks; test with `gameState.getPassabilityClassMask(name)`,
  `gamestate.js:302-307`) and `territoryMap` (Uint8 owner per tile). Both have
  `width`, `height`, `cellSize`; index is `x + y * width`
  (`shared.js:85-92`).
- `InfoMap` (`public/simulation/ai/common-api/map-module.js:5-30`) — generic
  8-bit grid: `width`, `height`, `cellSize`, `length`, `maxVal`, `map`.
  Methods: `setMaxVal` `:32`, `gamePosToMapPos(p)` `:37`, `point(p)` (clamped
  sample at game position) `:42`, `addInfluence(cx, cy, maxDist, strength?,
  type)` / `multiplyInfluence(…)` with type `"linear"` / `"quadratic"` /
  `"constant"` `:68-115`, `add(map)` `:118`, `set(i, value)` (clamped) `:125`,
  `findBestTile(radius, obstruction)` `:131`, `getNonObstructedTile(i, radius,
  obstruction)` `:150`, `isObstructedTile(kx, ky, radius)` `:177`,
  `dumpIm(name?, threshold?)` — via `Engine.DumpImage` `:209`.
- `TerrainAnalysis` (`public/simulation/ai/common-api/terrain-analysis.js:14-58`)
  — an `InfoMap` over the passability grid with cell values `IMPASSABLE=0`,
  `DEEP_WATER=200`, `SHALLOW_WATER=201`, `LAND=255` (`terrain-analysis.js:20-32`),
  derived from the `"default-terrain-only"` / `"ship-terrain-only"` masks.
  Non-player-specific; lives on the shared script as
  `sharedScript.terrainAnalyzer` (`shared.js:116-117`).
- `Accessibility` (`terrain-analysis.js:68-385`) — flood-fill region maps
  `landPassMap` / `navalPassMap` (Uint16 region IDs; 1 = inaccessible),
  `regionSize`, `regionType` (`"land"`/`"water"`/`"inaccessible"`),
  `regionLinks` (adjacency, incl. land↔water links), computed once at init
  (`terrain-analysis.js:74-147`) — **not updated when the passability map
  changes**. API: `getAccessValue(position, onWater?)` `:149`,
  `getTrajectTo(start, end)` `:173`, `getTrajectToIndex(istart, iend)` — a
  region-ID path, e.g. to find which sea zone connects two land regions
  `:201`, `getRegionSize(position, onWater?)` `:230`, `getRegionSizei(index,
  onWater?)` `:240`. Exposed to bots as `this.accessibility` via `BaseAI.Init`
  (`baseAI.js:34`).
- Resource influence maps: `sharedScript.resourceMaps[code]` and
  `ccResourceMaps[code]` (per resource with an `aiAnalysisInfluenceGroup`,
  updated on create/destroy events, `shared.js:121-131`, `391-459`). Resource
  codes/groups come from the `Resources` global
  (`public/globalscripts/Resources.js:4-48`).
- `Engine.ComputePath` for on-demand exact paths (§2).

---

## 8. Utilities

### 8.1 `Class` (`public/simulation/ai/common-api/class.js`)

`Class({ "_init": fn, "_super": Parent, "method": fn, … })` returns a
constructor whose prototype chains to `_super.prototype` (via `__proto__`)
and owns the remaining keys (`class.js:5-20`). This is how `Template` and
`Entity` are declared (`entity.js:5`, `560`). A separate helper
`copyPrototype(descendant, parent)` copies prototype entries (used by
terrain-analysis classes, `shared.js:379-389`).

### 8.2 `ResourcesManager` (`public/simulation/ai/common-api/resources.js`)

Resource-amount container with one numeric field per resource code plus
`population` (`resources.js:3-9`). Methods: `reset()` `:11`,
`canAfford(that)` `:18`, `add(that)` `:26`, `subtract(that)` `:33`,
`multiply(n)` `:40`, `Serialize()`/`Deserialize(data)` `:47-60`. Obtain the
player's current amounts via `gameState.getResources()`
(`gamestate.js:309-312`).

### 8.3 `Technology` (`public/simulation/ai/common-api/technology.js`)

Wrapper around a tech template from the `TechnologyTemplates` cache
(`technology.js:4-20`). Methods: `name(civ?)` — generic or civ-specific name
`:23`, `pairDef()` / `getPairedTechs()` / `pair()` / `pairedWith()` — tech
pairs `:33-62`, `cost(researcher?)` `:64`, `costSum(researcher?)` `:78`,
`researchTime()` `:89`, `requirements(civ)` `:94`, `autoResearch()` `:99`,
`supersedes()` `:106`, `modifications()` `:113`, `affects()` `:120`,
`isAffected(classes)` `:127`.

### 8.4 `utils.js` (`public/simulation/ai/common-api/utils.js`)

- `aiWarn(output)` — `warn` prefixed with the player ID (`utils.js:1-7`).
- `exit(exitStatus)` — `Engine.Exit` (`utils.js:12-15`).
- `VectorDistance(a, b)` / `SquareVectorDistance(a, b)` over `[x, z]` pairs
  (`utils.js:17-25`; backed by `Math.euclidDistance2D`,
  `public/globalscripts/Math.js:311-322`).
- `getMapIndices(i, map1, map2)` — indices of a finer map covered by cell `i`
  of a coarser one (`utils.js:50-60`).

---

## 9. Save/load and chat

### 9.1 Serialization

- The whole AI worker is serialized into saved games: RNG, turn number, the
  shared script object, pending commands, and each player's bot object
  (`source/source/simulation2/components/CCmpAIManager.cpp:656-697`).
  Deserialization reconstructs players from `data.json` and then assigns the
  saved objects (`CCmpAIManager.cpp:699-764`).
- Contract for bots: `Serialize()` must return a **plain structured-cloneable
  object** (no functions, no live `Entity` wrappers — Petra stores
  `evt.entityObj._entity`, the raw state, instead,
  `public/simulation/ai/petra/_petrabot.js:135-165`).
  `Deserialize(data, sharedScript)` is called right after the constructor when
  loading; it should only stash `data` and set `this.isDeserialized = true` —
  real restoration happens in `CustomInit` on the first post-load `Init`
  (`baseAI.js:20-27`, `55-59`; Petra's pattern at `_petrabot.js:167-171`,
  `29-72`).
- The shared script serializes its metadata/tech-modification state the same
  way (`shared.js:30-53`), and re-runs `init(state, true)` on the first
  post-load `onUpdate` (`shared.js:147-151`).

### 9.2 Chat

- **Outgoing:** `this.chat(message)` posts `{ "type": "aichat", "message" }`
  (`baseAI.js:68-71`); the `aichat` command handler turns it into a GUI
  notification for the AI's player slot
  (`public/simulation/helpers/Commands.js:7-14`). Petra's
  `chatHelper.js` shows richer variants (translated messages, targeted
  players) built on the same command
  (`public/simulation/ai/petra/chatHelper.js:156-259`).
- **Incoming:** there is no chat message channel to the AI in 0.28.0 — no
  chat entry exists in `AIInterface.EventNames`
  (`public/simulation/components/AIInterface.js:6-28`) and `BaseAI` has no
  `OnMessageReceived`. Human→AI communication is limited to the
  `AttackRequest`, `DiplomacyRequest` and `TributeRequest` events pushed by
  the corresponding commands
  (`public/simulation/helpers/Commands.js:780-796`, `833-845`), which Petra
  answers from its managers via `chatHelper`.

---

## 10. Minimal bot skeleton

```js
// mods/mymod/simulation/ai/mybot/data.json
{ "name": "My Bot", "description": "…", "constructor": "MyBot",
  "filename": "_mybot.js", "useShared": true }
```

```js
// mods/mymod/simulation/ai/mybot/_mybot.js
import { BaseAI } from "simulation/ai/common-api/baseAI.js";

export function MyBot(settings)
{
	BaseAI.call(this, settings);
}
MyBot.prototype = Object.create(BaseAI.prototype);

MyBot.prototype.CustomInit = function(gameState) { /* once per game */ };

MyBot.prototype.OnUpdate = function()
{
	if (this.gameState.playerData.state !== "active")
		return;
	// e.g. gameState.getOwnUnits().forEach(ent => …);
	this.turn++;
};

MyBot.prototype.Serialize = function() { return {}; };
MyBot.prototype.Deserialize = function(data, sharedScript)
{
	this.isDeserialized = true;
};
```

(Structure after `public/simulation/ai/petra/_petrabot.js:1-27` and
`public/simulation/ai/common-api/baseAI.js`.)

---

## 11. Scripting pitfalls

Gotchas verified while developing the bot. Each cross-references the section
that documents the underlying API; where a claim is not already cited there,
the source is given inline.

- **`BaseAI.this.timeElapsed` is stale.** It is set once in `Init` and never
  refreshed (`baseAI.js:41-47`); read live time via `gameState.getTimeElapsed()`
  (§4.3).
- **`currentPhase()` returns an integer index** — 1 = village, 2 = town,
  3 = city (§4.3, `gamestate.js:176-211`) — not a tech-name string. A
  `=== "phase_village"` comparison never matches.
- **`filters.byResource` / `getResourceSupplies(resource)` excludes huntable
  animals** (§4.6 `:194`, §4.3): use `getHuntableSupplies()` or the
  `isHuntable()` filter for meat. `isHuntable()` already excludes retaliating
  animals (lions/wolves), and the resource filter also excludes sea creatures.
- **`getOwnStructures()` includes foundations** — a foundation carries the
  built template's classes (§4.3 `:482-498`, §4.4). Exclude them with
  `foundationProgress() === undefined` (§4.4 `:639`); a fresh foundation
  reports progress `0`, so a falsy `!foundationProgress()` test lets it
  through.
- **`getEnemyEntities()` includes gaia** — gaia is a diplomatic enemy, so
  every tree/bush matches (§4.3 `:510-551`). Filter `ent.owner() === 0` out;
  keep gaia animals with an `Attack` component (they kill gatherers).
- **`playerData.statistics` is only `GetBasicStatistics()`** —
  `resourcesGathered` and `percentMapExplored` (§3,
  `GuiInterface.js:97-135`). There is no `tradeIncome`/`resourcesSold`: the bot
  must count its own barter deals; the full per-player statistics appear only
  in the end-of-game stdout JSON (§12).
- **Passability bits are inverted vs intuition** — a SET bit means IMPASSABLE
  for that class: `IS_PASSABLE(item, mask) = (item & mask) == 0`
  (`source/source/simulation2/helpers/Pathfinding.h:130`). An inverted check
  makes every building spot look blocked. Petra's `createObstructionMap`
  follows this convention.
- **`passabilityClasses` masks are assigned alphabetically** (std::map
  iteration), not in XML order (§3). Always use
  `gameState.getPassabilityClassMask(name)` (§4.3 `:302-307`), never a
  hardcoded bit.
- **`entity.construct(...)` posts `autorepair: false`** (§4.4 `:957`): the
  foundation is created instantly at command processing but NO builder is
  sent — order `repair(foundation)` separately the next cycle.
- **The `construct` command is validated at processing time** against
  BuildRestrictions + entity limits + tech requirements + the REAL stock cost
  (§5). A rejection is **silent** — the AI only learns via its own
  `pendingBuilds` timeout. Ordering a construct and a research/barter in the
  same block races the stock (both see the same snapshot): keep cost floors
  and a one-block `constructionHold`.
- **The AI territory grid can disagree with the engine's** for a few turns
  (dirty-ID updates, §3). Re-validate building spots against the live state
  right before ordering, and plan more spots than needed.
- **`stopMoving()` posts a `"stop"` command** (§4.4 `:813`) — it goes through
  the normal one-turn command delay (§5), it is not an instant state change.
- **`angle()` returns the yaw in radians** — `cmpPosition.GetRotation().y`
  (`public/simulation/components/AIProxy.js:233`; §4.4 `:601-602`).
- **`resourceCarrying()` returns `[{ type, amount, max }]`** (§4.4
  `:669-689`); a drop from `> 0` to `0` is a delivery. `amount /
  time-between-deliveries` = effective gather rate per gather-walk-drop cycle.

---

## 12. Trigger scripts and end-of-game output

Map/scenario JavaScript runs through the map **trigger** system, separate from
the AI API above. A bot mod uses it for per-match scripting and to end a
headless game cleanly.

### 12.1 Trigger scripts

- A map can ship a `maps/scripts/NonVisualTrigger.js`; the engine registers it
  as a custom trigger script in every `-autostart-nonvisual` game
  (`public/maps/scripts/NonVisualTrigger.js`). A mod copy mounted after
  `public` wins — the way a bot mod injects per-match scripting.
- `cmpTrigger.DoAfterDelay(ms, "MethodName", {})` schedules a call to
  `Trigger.prototype.MethodName` after `ms` of simulation time
  (`public/simulation/components/Trigger.js:287`); one turn = 200 ms.
- To end a match from a trigger:
  `EndGameManager.MarkPlayersAsWon([1], victoryString, defeatString)`
  (`public/simulation/components/EndGameManager.js:85`). The engine exits 0
  and writes `metadata.json` and the per-player statistics JSON. A wall-clock
  SIGTERM skips both.

### 12.2 End-of-game output

- The per-player statistics JSON on stdout comes from
  `StatisticsTracker.GetStatisticsJSON()`
  (`public/simulation/components/StatisticsTracker.js:170`). In 0.28.0 it has
  **no `timeElapsed` field** (simulation time is in the replay `metadata.json`,
  `timeElapsed` in ms), and it is **pretty-printed** (`"playerState": "won"`
  with a space) — account for both when grepping.
- The replay `metadata.json` `playerStates[]` carries `phase` (usable to
  verify phase goals), but `researchedTechs` is always `{}` — do not use it to
  verify researched techs; count them from the bot's own logs.
- The stats JSON's `unitsLost.total` can be `0` while the per-class breakdown
  is nonzero — read the breakdown.
