# Technologies, research and the modification system (0 A.D. 0.28.0)

How technologies are defined, researched and turned into stat changes, and how the same machinery carries auras, civ bonuses and team bonuses. Grounded in `public/simulation/components/TechnologyManager.js`, `public/simulation/components/Researcher.js`, `public/simulation/components/ModifiersManager.js`, `public/simulation/components/ValueModificationManager.js`, `public/simulation/components/Auras.js`, `public/simulation/helpers/Requirements.js`, `public/simulation/helpers/ValueModification.js`, `public/globalscripts/Technologies.js`, `public/globalscripts/ModificationTemplates.js`, `public/globalscripts/Templates.js`, the JSON data under `public/simulation/data/technologies/`, `public/simulation/data/auras/`, `public/simulation/data/civs/`, and the AI-facing wrappers in `public/simulation/ai/common-api/`. All paths below are relative to `/home/ubuntu/0ad-reference`.

## Technology templates

Technologies are JSON files under `public/simulation/data/technologies/` (recursively, so `technologies/civbonuses/` included). They are loaded once into the `TechnologyTemplates` cache (`public/globalscripts/ModificationTemplates.js:41-45`); the file path relative to `technologies/` without the `.json` suffix is the technology name (e.g. `civbonuses/celt_structures`).

Fields seen in the data (example: `public/simulation/data/technologies/phase_town_generic.json`):

- `genericName`, `specificName` (per-civ map), `description`, `tooltip`, `requirementsTooltip`, `icon`, `soundComplete` — presentation only.
- `cost` — object of resource amounts (`food`, `wood`, `stone`, `metal`). Paid in full when the tech is queued; refunded if the research is stopped (`TechnologyManager.js:30-39`, `TechnologyManager.js:55-59`).
- `researchTime` — seconds of work needed (`TechnologyManager.js:41`).
- `requirements` — see next section.
- `supersedes` — name of a cheaper tech this one replaces in a chain (e.g. `gather_capacity_wheelbarrow` supersedes `gather_capacity_basket`, `public/simulation/data/technologies/gather_capacity_wheelbarrow.json:8`).
- `replaces` — list of tech names marked as researched when this tech finishes, without applying their effects (`TechnologyManager.js:107-112`). Used so that civ-specific variants satisfy requirements written against a generic name (see phases below).
- `pair` / `top` / `bottom` — tech-pair mechanics, see "Tech pairs".
- `autoResearch` — researched instantly and for free as soon as its requirements are met, see "Auto-research".
- `modifications` — list of effects, see "Modifications".
- `affects` — top-level list of class expressions the modifications apply to.

## Requirements

A tech's `requirements` is a single object `{ <operator>: <value> }`; operators nest. Implemented by `InterpretTechRequirements` (`public/globalscripts/Technologies.js:199-365`):

- `{"civ": "maur"}` — only that civ can research it.
- `{"notciv": "athen"}` — every civ except that one.
- `{"tech": "phase_town"}` — that tech must be researched.
- `{"entity": {"class": "Village", "number": 5}}` — the player must own at least `number` entities carrying that class. `numberOfTypes` instead of `number` requires that many *distinct templates* of the class (`Technologies.js:211-223`). Counts come from `TechnologyManager`'s per-player `classCounts` / `typeCountsByClass`, maintained on ownership change; **foundations are excluded** (`TechnologyManager.js:376-429`).
- `{"all": [...]}` / `{"any": [...]}` — boolean combinators over sub-requirements.

The derived requirement list is an OR of ANDs: `CheckTechnologyRequirements` returns true if *any* requirement set has *all* of its `techs` researched and *all* of its `entities` specs satisfied (`TechnologyManager.js:332-374`). `DeriveTechnologyRequirements` additionally appends the superseded tech to every requirement set, so a superseding tech always requires its predecessor (`Technologies.js:137-162`).

**Gating of entities, not just techs.** Trainable/buildable entity templates carry their own requirements in `<Identity><Requirements>` (schema in `public/simulation/helpers/Requirements.js:36-83`): `<Techs>` (space-separated, `!` negates), `<Entities>` with `Count` or `Variants` per class, combinable with `<All>`/`<Any>`. `TechnologyManager.CanProduce` checks them before production (`TechnologyManager.js:277-286`). Example: all champion units require `phase_city` (`public/simulation/templates/template_unit_champion.xml:16-18`). This is how "unlock" techs with no `modifications` work — e.g. `unlock_champion_infantry.json` only carries requirements; the effect is that the tech name appears in some template's `<Techs>` list.

## Researching a tech

1. Only entities with a `Researcher` component can research. Its template lists `Technologies` (space-separated; `{civ}` is replaced by the owner's civ code if that tech exists, else by `generic`) and an optional `TechCostMultiplier` per resource plus `time` (schema: `public/simulation/components/Researcher.js:3-29`; `{civ}` resolution: `Researcher.js:199-210`).
2. `GetTechnologiesList` filters out techs disabled for the player and rewrites supersede chains: a tech whose predecessor was researched is shown in the predecessor's slot, and techs already researched or in progress are hidden (`Researcher.js:177-267`).
3. Queueing (`Researcher.QueueTechnology` → `TechnologyManager.QueuedResearch` → `Technology.Queue`) immediately subtracts the cost. Actual cost per resource is `floor(TechCostMultiplier[res] * cost[res])` and total time is `TechCostMultiplier.time * researchTime * 1000` ms (`TechnologyManager.js:30-43`). Both multipliers are themselves modifiable values (`Researcher/TechCostMultiplier/<res>`, `Researcher.js:272-282`), so techs and auras can make research cheaper/faster.
4. The item sits in the building's `ProductionQueue`, which advances it with allocated time on its timer (`public/simulation/components/ProductionQueue.js:121-143`). Progress is 1 ms of research per 1 ms allocated; no worker involvement.
5. Stopping a queued research refunds the full (multiplied) cost (`TechnologyManager.js:55-59`).
6. On finish (`TechnologyManager.js:88-129`): the tech's modifications are registered in the global `ModifiersManager` under the ID `"tech/<techName>"` as **player-wide** modifiers; every name in `replaces` is marked researched; the tech itself is marked researched; entity limits are updated; an `MT_ResearchFinished` message is posted.

Research is per-player, not per-building: the queue lives in the player entity's `TechnologyManager` (`researchQueued`, keyed by tech name, `TechnologyManager.js:203-204`), and the in-progress hiding in `GetTechnologiesList` plus the `IsInProgress` check in `CanResearch` prevent queuing the same tech twice through normal paths (`Researcher.js:241-245`, `TechnologyManager.js:316-317`).

## The modification system

### Deriving modifiers

`DeriveModificationsFromTech` (`public/globalscripts/ModificationTemplates.js:53-85`) turns a tech (or aura) JSON into `{ <valuePath>: [modifier, ...] }`:

- Each entry of `modifications` has `value` (a slash-separated property path, e.g. `Health/Max`, `ResourceGatherer/Rates/food.fruit`, `Attack/Melee/Damage/Hack`), exactly one effect key — `add`, `multiply`, `replace` or `tokens` — and an optional per-modification `affects` class string.
- The final `affects` of a modifier is the tech's top-level `affects` list (each entry split on whitespace) with the per-modification `affects` appended to every entry (`ModificationTemplates.js:58-83`). No `affects` at all means "applies to everything".

### Class matching

A modifier applies to an entity if `MatchesClassList(classes, affects)` passes (`public/globalscripts/Templates.js:84-103`): the affects list is an **OR** of entries; each entry is an **AND** of class tokens (split on whitespace or `+`); a token prefixed with `!` requires the class to be **absent**. Example: `"affects": ["Structure !Wonder"]` in `civbonuses/celt_structures.json:18` means "structures that are not wonders". An empty affects list applies to anything (`public/globalscripts/Technologies.js:93-98`).

### Combining values

All modifiers for a property path on a target are flattened into one list and applied by `GetTechModifiedProperty` (`Technologies.js:17-29`):

- **Numbers** (`Technologies.js:46-65`): `result = originalValue * Π(all multiply factors) + Σ(all add terms)`. All multiplies compound with each other; all adds happen **after** multiplication. The first applicable `replace` short-circuits and returns its value immediately, discarding everything else.
- **Strings** (`Technologies.js:67-86`): `replace` wins; otherwise `tokens` edits the whitespace-separated token list — `A>B` replaces token A by B, `-A` removes A, anything else is appended (`Technologies.js:104-127`). Used e.g. for `Researcher/Technologies/_string` and `Trainer/Entities/_string` edits.
- Other types: only `replace` is supported.

Example: a spearman (100 HP) with `unit_advanced` (Health/Max ×1.25) and `unit_elite` (×1.25) researched has `100 * (1.25*1.25) = 156.25` HP; the phase-town `Capturable/GarrisonRegenRate +0.5` adds after any multiplies.

### Where modifiers live and how they are applied

The system entity `ModifiersManager` stores every active modifier keyed by (property path, target entity) in a `MultiKeyMap` (`public/simulation/components/ModifiersManager.js:6-24`). Targets are either a **player entity** (player-wide modifiers: techs, global auras) or an **individual entity** (local auras). Every component that reads a modifiable stat passes its raw template value through `ApplyValueModificationsToEntity` (`public/simulation/helpers/ValueModification.js:3-12`), which calls `ModifiersManager.ApplyModifiers` (`ModifiersManager.js:137-176`):

1. Player-wide modifiers are applied first, then entity-local ones on top (`ModifiersManager.js:162-172`). Since numeric combination is multiply-then-add regardless of list order, this ordering only matters for `replace` (first applicable replace in the list wins).
2. Results are cached per (property, entity, original value) and invalidated when relevant modifiers change (`ModifiersManager.js:113-124`); a `MT_ValueModification` message is then posted to the entity, or `MT_TemplateModification` + a broadcast for player-wide changes (`ModifiersManager.js:51-75`).

`ValueModificationManager` (`public/simulation/components/ValueModificationManager.js:12-15`) is only a thin bridge giving C++ components access to the same helper.

## Tech pairs

Pairs model "choose one of two" research. Three files are involved; example in `public/simulation/data/technologies/`:

- A **pair definition** tech: `pair_gather_food_maur.json` = `{ "top": "gather_wicker_baskets_maur", "bottom": "gather_ahimsa", "requirements": {...} }`. It has no cost or effects.
- The two **member** techs each carry `"pair": "pair_gather_food_maur"` plus their own cost, requirements and modifications (`gather_wicker_baskets_maur.json`, `gather_ahimsa.json`).

Exclusion mechanics (`TechnologyManager.js:299-323`):

- A pair member cannot be queued while its sibling or the pair definition is in progress, and `CanResearch(member)` requires `CanResearch(pairDefinition)` to pass.
- The pair definition is auto-marked researched as soon as either member is researched (it is in the auto-research set because it has `top`; `TechnologyManager.js:213-216`, `261-274`). Once that happens `CanResearch(pairDefinition)` is false, so the sibling can never be researched — **the choice is permanent**.
- The GUI/AI list shows the pair as a single entry `{pair: true, top, bottom}` (`Researcher.js:259-264`).

## Supersede chains and auto-research

- **Supersede** models upgrade lines (wheelbarrow supersedes basket; `phase_town_generic` supersedes `phase_village`). Effects: the superseding tech automatically requires the superseded one (`Technologies.js:148-159`), and in `GetTechnologiesList` the better tech takes over the slot of the researched cheaper one (`Researcher.js:225-245`). Both techs' modifiers stay active — supersede does not remove the earlier tech's effects.
- **Auto-research**: at game start every tech with `autoResearch` or `top` goes into `unresearchedAutoResearchTechs` (`TechnologyManager.js:210-217`). On every update tick, any such tech whose requirements pass is researched instantly, for free, with no building involved (`TechnologyManager.js:255-274`, `446-452`). This implements:
  - **Civ bonuses**: techs under `technologies/civbonuses/` with `autoResearch: true` and a `civ`/`any`-civ requirement, e.g. `celt_structures.json` (gaul/brit: structures −20% build time, health and capture points). Note the `CivBonuses` block in `public/simulation/data/civs/gaul.json:30-35` is display text only; the actual mechanics live in these techs and in auras.
  - **Rank bonuses**: `unit_advanced.json` / `unit_elite.json` — `autoResearch` techs with **no requirements at all**, so they are researched for every player on the first update tick (`CheckTechnologyRequirements` passes on an empty requirement list, `TechnologyManager.js:339-340`). Their effects do nothing until units are promoted because `affects: ["Advanced Unit", "Elite Unit"]` restricts every modifier to those classes (`unit_advanced.json:22`).
  - **Pair definitions**, as described above.

## Phase techs

Three phases, all named `phase_*`:

- **Village** — `phase_village.json`: `autoResearch: true`, no cost, no requirements, no effects. Every player has it from the first update tick. It exists so techs/templates can require "the game has started".
- **Town** — `phase_town_generic.json` (civ variants: `phase_town_athen.json`, `phase_town_pers.json`; the civil centre's `Researcher` lists `phase_town_{civ}`, resolved per-civ): cost 500 food + 500 wood, 30 s, requirement `entity {class: "Village", number: 5}` (five owned structures with the `Village` class). Effects: `Capturable/GarrisonRegenRate` +0.5 (affects Structure), `Attack/Ranged/Damage/Pierce` ×1.2 (Structure), `TerritoryInfluence/Radius` ×1.25 (CivCentre). athen adds `ResourceGatherer/Rates/metal.ore` ×1.1 (Worker). It `supersedes: "phase_village"` and `replaces: ["phase_town"]`.
- **City** — `phase_city_generic.json` (variants `_athen`, `_pers`): cost 750 stone + 750 metal, 60 s, requirement `entity {class: "Town", number: 3}`. Effects: `Capturable/GarrisonRegenRate` +1 (Structure — adds on top of town's +0.5), `Attack/Ranged/Damage/Pierce` ×1.2 (Structure), `TerritoryInfluence/Radius` ×1.25 (CivCentre). Supersedes `phase_town_generic`, `replaces: ["phase_city"]`.

**Why `replaces` matters:** other data keys its requirements on the bare names `phase_town` / `phase_city` (e.g. `gather_capacity_wheelbarrow.json:9`, `template_unit_champion.xml:17`), which are dummy techs (`phase_town.json` is explicitly "Dummy technology ... replaced by phase_town_generic or phase_town_{civ}"). When the real phase tech finishes, the dummy is marked researched (`TechnologyManager.js:107-112`) and all those requirements pass. A bot should test `isResearched("phase_town")`-style names, or equivalently the concrete tech it queued.

Note: phase research sends GUI notifications keyed on the name starting with `"phase"` (`TechnologyManager.js:61-67`, `76-86`, `122-128`) — cosmetic, no gameplay effect.

## Auras, civ bonuses and team bonuses in the same pipeline

Auras are JSON under `public/simulation/data/auras/` loaded into `AuraTemplates` (`ModificationTemplates.js:43`) and use the exact same `modifications`/`affects` format; `Auras.js` derives them with the same `DeriveModificationsFromTech` (`Auras.js:364-367`, `439-442`). Differences from techs:

- Modifier IDs are `"aura/<name>"`, or `"aura/<name><sourceEntity>"` when the aura JSON has `"stackable": true` — non-stackable auras from several sources collapse into one modifier, stackable ones apply once per source (`Auras.js:21-26`).
- `"type": "global"` auras are added as **player-wide** modifiers on every affected player (`Auras.js:356-374`); range/formation/garrison auras are added as **entity-local** modifiers on each affected entity (`Auras.js:412-447`) and removed when the source leaves range/dies (`Auras.js:449-485`).
- `"affectedPlayers"` restricts who benefits (e.g. `"MutualAlly"` for team bonuses).

Examples: gaul's "Deas Celtica" is a range-10 aura on druids giving Soldiers ×1.05 all damage types (`auras/units/celtic_healer.json`); gaul's team bonus is a global aura giving allied Forges ×0.85 research cost and time (`auras/teambonuses/gaul_player_teambonus.json`); the mace Library gives all its owner's Structures ×0.85 research cost/time via the `Researcher/TechCostMultiplier/*` paths (`auras/structures/library.json`).

Because everything funnels into the same `GetTechModifiedProperty` formula, a stat a bot reads from a template is the base value; the effective value is `base * Πmultiplies + Σadds` over all researched techs and currently active auras whose affects match the entity's classes.

## How a bot sees all this

The AI API (`public/simulation/ai/common-api/`, available to the shared script) exposes:

- **Tech templates:** `TechnologyTemplates.Get/Has/GetAll` directly (`gamestate.js:146-147`); the `Technology` wrapper (`ai/common-api/technology.js:4-127`) gives `cost(researcher)` (multiplier-aware), `researchTime()`, `requirements(civ)`, `modifications()`, `affects()`, `supersedes()`, `pair()`/`pairedWith()`/`getPairedTechs()`, `autoResearch()`.
- **Per-building list:** `entity.researchableTechs(gameState, civ)` returns the raw `Researcher/Technologies/_string` with `{civ}` resolved (`ai/common-api/entity.js:333-348`) — note it does **not** hide already-researched techs or resolve supersede chains; use `gameState.canResearch` for that.
- **Player state:** `gameState.playerData.researchedTechs` (Set), `playerData.researchQueued` (Map), `playerData.classCounts`, `playerData.disabledTechnologies`, fed from the simulation each turn (`public/simulation/components/GuiInterface.js:116`, `129-130`). Helpers: `gameState.isResearched(name)`, `isResearching(name)`, `canResearch(name)` (checks disabled, queued/researched, pair sibling, and requirements — `gamestate.js:213-250`), and `gameState.phases` (ordered phase list with requirements, built from the civil centre template, `gamestate.js:30-67`).
- **Issuing research:** `entity.research(techName)` posts a `research` order on the entity's production queue (`ai/common-api/entity.js:977-979`).
- **Effective values:** the AI never computes modifiers itself. When a player-wide modifier changes, `AIInterface.OnTemplateModification` recomputes affected template values with `ApplyValueModificationsToTemplate` and pushes them into `changedTemplateInfo` (`public/simulation/components/AIInterface.js:209-273`); entity-local changes arrive as `ValueModification` events (`AIInterface.js:275+`). Population-related values are rounded to integers in this path (`AIInterface.js:258-260`).

## Edge cases worth knowing

- `cost` resources are floored **after** the multiplier (`TechnologyManager.js:33`); a tech with no `cost` is free, no `researchTime` finishes instantly.
- Multiplies of the same stat compound multiplicatively (two ×1.2 give ×1.44, not ×1.4); adds always apply after all multiplies.
- A `replace` modifier discards every other modifier on that path — first applicable one in the flattened list wins.
- Tech effects are never removed: there is no "un-research", and superseding stacks on top of the superseded tech's effects.
- Entity-requirement counts ignore foundations — buildings under construction do not count toward phase requirements (`TechnologyManager.js:391-402`).
- `CanProduce` requirements and tech requirements are different mechanisms reading the same per-player counters; an unlock tech works purely by making `<Techs>` requirements pass.
- Non-stackable auras from multiple identical sources give no extra effect; stackable ones multiply per source.
- The AI-side `researchableTechs` listing is rawer than the simulation's `GetTechnologiesList`: it skips the civ-requirement filter, the disabled-technology filter and the supersede/researched hiding — mirror `gameState.canResearch` before issuing an order.
