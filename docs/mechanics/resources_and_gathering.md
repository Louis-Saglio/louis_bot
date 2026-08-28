# Resources and gathering

How resources are defined, how units gather them from supply entities, where they are dropped off, and how passive trickles work in 0 A.D. 0.28.0. Grounded in `public/globalscripts/Resources.js`, `public/simulation/helpers/Resources.js`, `public/simulation/data/resources/*.json`, `public/simulation/components/ResourceGatherer.js`, `ResourceSupply.js`, `ResourceDropsite.js`, `ResourceTrickle.js`, `UnitAI.js`, and the templates referenced inline (paths below are relative to `/home/ubuntu/0ad-reference`). Treasures and trade are out of scope (covered elsewhere).

## Resource types and subtypes

The resource catalogue is loaded at startup from `public/simulation/data/resources/*.json` (`public/globalscripts/Resources.js:12-14`) and frozen. There are exactly 4 generic types, each with fixed subtypes (`public/simulation/data/resources/food.json`, `wood.json`, `stone.json`, `metal.json`):

| Generic type | Subtypes | `truePrice` |
|---|---|---|
| `food` | `fish`, `fruit`, `grain`, `meat` | 100 |
| `wood` | `tree`, `ruins` | 100 |
| `stone` | `rock`, `ruins` | 100 |
| `metal` | `ore`, `ruins` | 100 |

- Every gatherable entity has a supply type of the form `<generic>.<specific>` (e.g. `food.fruit`, `wood.tree`); both parts are mandatory (`ResourceSupply.js:108-109`).
- All 4 types carry the properties `barterable`, `tradable`, `tributable` (the JSON `properties` arrays), used to build the barter/trade/tribute code lists (`public/globalscripts/Resources.js:28-33`).
- `truePrice` (100 for all four) is the barter reference price — barter/trade mechanics themselves are not covered here.

## Resource supplies (`ResourceSupply`)

Entities that can be gathered carry the `ResourceSupply` component (`public/simulation/components/ResourceSupply.js`):

- `Type` — `<generic>.<specific>` pair (schema line `ResourceSupply.js:47-49`).
- `Max` / `Initial` — supply capacity and starting amount; `Initial` defaults to `Max` (`ResourceSupply.js:102`). `Max` may be the literal `Infinity` (`ResourceSupply.js:40`).
- `KillBeforeGather` — if true, the entity's Health must be reduced to 0 before gathering; on death it is replaced by a `resource|`-prefixed entity that keeps the `ResourceSupply` (`Health.js:351-354`). This is how huntable/corralled animals work (gather orders on such targets are turned into attack orders, `UnitAI.js:544`).
- `MaxGatherers` — maximum simultaneous gatherers. The count includes units still walking toward the supply ("Includes the ones that are tasked but not here yet", `ResourceSupply.js:104-105`).
- `DiminishingReturns` — optional; see below.

### Supply amounts and exhaustion

- `TakeResources(n)` removes up to `n` units and returns the amount actually taken (clamped by what remains) plus an `exhausted` flag (`ResourceSupply.js:214-223`). Amounts are clamped to `[0, Max]` (`ResourceSupply.js:237`).
- When the amount reaches 0 the entity is **destroyed** (`Engine.DestroyEntity`, `ResourceSupply.js:240-241`). A tree disappears when fully chopped; there is no stump.
- Infinite supplies (`Max = Infinity`) never decrease and are never exhausted (`ResourceSupply.js:216-217`, `118-121`). Fields are infinite (see below).
- Optional `<Change>` entries make a supply regenerate or decay over time: `Value` per `Interval` ms, gated by `State` (`alive`/`dead`/`gathered`/`notGathered`) and optional `LowerLimit`/`UpperLimit` (`ResourceSupply.js:59-98`, timers at `ResourceSupply.js:324-416`). Berry bushes regrow at +1 food per 6000 ms (`public/simulation/templates/template_gaia_fruit.xml:26-31`). Trees have no `Change` entry — they never regrow.

### Typical supply entities

| Entity | Template | Type | Amount | MaxGatherers |
|---|---|---|---|---|
| Temperate tree | `gaia/tree/temperate.xml` + `template_gaia_tree.xml` | `wood.tree` | 200 | 8 |
| Berry bush | `gaia/fruit/berry_01.xml` + `template_gaia_fruit.xml` | `food.fruit` | 200 (regrows) | 8 |
| Metal mine | `template_gaia_ore.xml` | `metal.ore` | 1000 | 12 |
| Field | `template_structure_resource_field.xml` | `food.grain` | Infinity | 5 |

(`gaia/tree/temperate.xml:6-8`, `template_gaia_tree.xml:21-26`, `gaia/fruit/berry_01.xml:6-8`, `template_gaia_fruit.xml:21-32`, `template_gaia_ore.xml:23-28`, `template_structure_resource_field.xml:45-51`.)

### Diminishing returns

If a supply defines `DiminishingReturns` (`dr`), the effective rate of **every** gatherer on it is multiplied by (`ResourceSupply.js:194-208`):

```
multiplier(n) = (1 - dr^n) / (1 - dr) / n      for n > 1, dr ≠ 1
multiplier(n) = 1                               for n ≤ 1 or dr = 1
```

where `n` is the number of gatherers (including approaching ones). This is a geometric-series average: total output from `n` gatherers is `rate × (1 - dr^n)/(1 - dr)`. Fields use `dr = 0.90` (`template_structure_resource_field.xml:50`), so with 5 gatherers each works at ≈ 0.82× their base rate and the field yields ≈ 4.1× a single gatherer (not 5×). Supplies without the element (trees, mines, bushes) have no penalty — each gatherer works at full rate until `MaxGatherers` is reached.

## The gatherer (`ResourceGatherer`)

Template parameters (`public/simulation/components/ResourceGatherer.js:3-32`; civilian example `public/simulation/templates/template_unit_support_civilian.xml:53-73`):

- `MaxDistance` — gather range, 2.0 m for the civilian. Checked per tick via the obstruction manager (`ResourceGatherer.js:470-474`).
- `BaseSpeed` — global rate multiplier (1.0 for the civilian).
- `Rates` — per-subtype rate multipliers; a subtype (or generic type) not listed **cannot be gathered** (rate 0).
- `Capacities` — per-generic-type carrying capacity.

### Rate lookup: subtype first, then generic

`GetTargetGatherRate` (`ResourceGatherer.js:299-318`):

1. Returns 0 if the target has no `ResourceSupply` or its current amount is ≤ 0 (checked through the **miraged** interface, so fog-of-war targets answer from possibly stale data).
2. Look up the rate for `<generic>.<specific>`; if that is 0/absent, fall back to the `<generic>` rate.
3. Effective rate = `Rates[...] × BaseSpeed`, with technologies applied to both (`RecalculateGatherRates`, `ResourceGatherer.js:115-133`).
4. Multiply by the supply's diminishing-returns multiplier if any.

Civilian rates (all civs unless overridden): `food.fruit` 1, `food.grain` 0.5, `food.meat` 1, `wood.tree` 0.7, `wood.ruins` 5, `stone.rock` 0.35, `stone.ruins` 2, `metal.ore` 0.35, `metal.ruins` 2 — i.e. ruins are gathered much faster than living sources (`template_unit_support_civilian.xml:56-66`).

### Gather cycle and timers

- Each gather tick transfers exactly `GATHER_AMOUNT = 1` unit (`ResourceGatherer.js:38`, `277`). The rate therefore controls **how often** the unit gathers, not how much per tick: the timer interval is `1000 / rate` ms (`ResourceGatherer.js:204`, `210`). A civilian on a berry bush (rate 1) ticks every 1000 ms; on stone (rate 0.35) every ≈ 2857 ms.
- Per tick, the transfer is also clamped by remaining capacity and remaining supply (`ResourceGatherer.js:276-278`), so the last tick of a nearly-full carry or nearly-empty supply may take less than 1 unit.
- The cycle stops with reason `InventoryFilled` when the unit can no longer carry more of that type, `TargetInvalidated` when the supply is exhausted/gone, or `OutOfRange` (`ResourceGatherer.js:257-267`, `288-291`). UnitAI reacts to these (see below).

### Carrying capacity

- Capacities are per generic type and technology-modifiable (`RecalculateCapacities`, `ResourceGatherer.js:135-146`). The civilian carries 10 of each type (`template_unit_support_civilian.xml:67-72`).
- A unit only ever carries **one type at a time**: starting to gather a different generic type silently **drops** the currently carried resources — they vanish, they are not deposited on the ground (`ResourceGatherer.js:194-196`, `DropResources` at `ResourceGatherer.js:419-422`).

## Dropsites (`ResourceDropsite`)

- A dropsite template lists the generic types it accepts and a `Sharable` flag (`public/simulation/components/ResourceDropsite.js:3-13`).
- Dropping off credits the resources directly to the owning player's stockpile (`ReceiveResources` → `Player.AddResources`, `ResourceDropsite.js:45-58`); only accepted types are taken, anything else stays on the unit.
- Standard player dropsites:
  - Civil centre: `food wood stone metal`, sharable (`template_structure_civic_civil_centre.xml:119-122`).
  - Storehouse: `wood stone metal`, sharable (`template_structure_economic_storehouse.xml:58-61`).
  - Farmstead: `food`, sharable (`template_structure_economic_farmstead.xml:56-59`).
- A unit may use a dropsite if it owns it, or if the owner is a mutual ally, the dropsite `IsShared()`, and the unit's player has the `SharedDropsites` diplomacy option enabled (`ResourceGatherer.js:366-390`). Sharing defaults to the `Sharable` template value and can be toggled at runtime (`ResourceDropsite.js:15-19`, `70-76`).

### Nearest-dropsite selection (`UnitAI.FindNearestDropsite`)

`public/simulation/components/UnitAI.js:4495-4545`:

- Candidates: all entities with `ResourceDropsite` owned by the player (or mutual allies when shared dropsites are on), found via the range manager over the whole map.
- Filtered by: accepts the carried generic type, visible to the unit (`CheckTargetVisible` — dropsites hidden by fog of war are skipped), shared if foreign-owned, and — for ships — the `Naval` class (ships only use naval dropsites).
- Distance is measured from the unit to the dropsite's **obstruction edge** (`ObstructionManager.DistanceToPoint`), not its centre. Because the range manager pre-sorts by centre distance, the loop stops early once a candidate is more than 40 m (`maxDifference`, `UnitAI.js:4509`) farther than the best found — so "nearest" is nearest by obstruction distance within a 40 m correction window.
- Returns `undefined` when nothing qualifies; the gather order then just ends (`UnitAI.js:2671-2672`).

## The full UnitAI gather loop

1. On a gather order, if the unit is already full of that type it goes straight to `RETURNINGRESOURCE` (`UnitAI.js:548-553`).
2. While gathering, `InventoryFilled` (or a forced retarget) triggers a return: the nearest accepting dropsite is chosen and a `ReturnResource` order is inserted (`UnitAI.js:2600-2608`, `2676-2696`).
3. After dropping off (`DROPPINGRESOURCES` → `CommitResources`, `UnitAI.js:2703-2709`, `2858-2864`), the unit walks back to its supply and resumes.
4. When a supply is exhausted (`TargetInvalidated`), the unit searches for another nearby supply of the **same subtype** (and, for meat, the same template — it won't switch from sheep to a wolf), first around its current position, then around the original order position; failing that it drops off what it carries and idles at the dropsite (`UnitAI.js:2622-2672`).
5. Builders that finish a dropsite automatically start gathering a nearby resource of an accepted type; builders that finish a field start gathering it (`UnitAI.js:3194-3218`).

## Resource trickle (`ResourceTrickle`)

Passive income component (`public/simulation/components/ResourceTrickle.js`):

- Template: `Rates` (per generic type) and `Interval` in ms. Every interval, the rates are added directly to the owner's stockpile (`ResourceTrickle.js:48-56`). There is no cap, no supply, no gatherer.
- Both rates and interval are technology-modifiable (`ResourceTrickle.js:37`, `86`); a negative interval disables the trickle (`ResourceTrickle.js:87-93`), and entities with all-zero rates keep no timer (`ResourceTrickle.js:72-83`).
- The player entity itself has a `ResourceTrickle` with all rates 0.0 (`public/simulation/templates/template_player.xml:99-107`) — the hook exists for techs.
- Example: the Wonder trickles 1.0 of each resource every 2000 ms (`template_structure_wonder.xml:74-82`). The Persian ice house and Tachara variants also trickle (`public/simulation/templates/structures/pers/ice_house.xml`, `tachara*.xml`).

## Edge cases a bot must handle

- **Supplies vanish at 0** — re-check that a remembered supply entity still exists before tasking (`ResourceSupply.js:240-241`).
- **`MaxGatherers` counts approaching units**, so queuing more gatherers than the cap sends the extras into the find-another-supply fallback (`ResourceSupply.js:104-105`, `176-179`).
- **Switching resource types loses the load** — carried resources are dropped (destroyed) when starting to gather a different generic type (`ResourceGatherer.js:194-196`, `419-422`).
- **Fog of war:** gather-rate queries go through the mirage, whose supply amount can be stale and which reports no diminishing returns (`ResourceGatherer.js:301`, `ResourceSupply.js:490-492`).
- **Dropsite search respects visibility** — an enemy-territory dropsite you can't see is not used (`UnitAI.js:4525`).
- **Rate 0 means "cannot gather"** — a unit with no matching `Rates` entry will refuse the target outright (`StartGathering` returns false, `ResourceGatherer.js:183-185`).
- **Gather throughput is discrete**: each unit on a supply yields exactly its effective rate per second while in range and not full; travel time to the dropsite is the real efficiency loss, so dropsite distance matters more than small rate differences.
