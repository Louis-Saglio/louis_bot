# Loot and treasures — 0 A.D. 0.28.0

All data was extracted from the game files, not from memory: `/home/ubuntu/0ad-reference/` (0 A.D. 0.28.0, the version the harness runs). Paths below are relative to that root. Grounded in `public/simulation/components/Loot.js`, `Looter.js`, `Treasure.js`, `TreasureCollector.js`, `ResourceSupply.js`, `Health.js`, `public/simulation/helpers/Attack.js`, `public/simulation/helpers/Setup.js`, and the gaia treasure/ruins templates under `public/simulation/templates/gaia/`.

## Loot on templates

Any entity can carry a `Loot` component listing resources credited when it is killed (`public/simulation/components/Loot.js:3-9`):

```xml
<Loot>
  <xp>100</xp>
  <food>5</food>
</Loot>
```

- Five keys: `food`, `wood`, `stone`, `metal`, `xp`. Missing keys default to 0 (`Loot.js:15`, `Loot.js:22`).
- Values are template integers; tech/aura modifications (`ApplyValueModificationsToEntity` on `Loot/<type>`) are applied and the result is floored (`Loot.js:13-24`).
- Examples: `template_unit_infantry.xml:43-49` — xp 100, food 5; `template_unit_cavalry.xml:38-44` — xp 130, food 10, wood 5; `template_structure_civic_house.xml:34-36` — wood 15; `template_structure_civic_civil_centre.xml:82-86` — wood 60, stone 60, metal 50.
- Entities without a `Loot` component give nothing.

## Who gets the loot (Looter rules)

Loot is transferred in `Looter.prototype.Collect` (`public/simulation/components/Looter.js:11-44`), which is called from exactly one place: `Health.prototype.KilledBy`, i.e. when the victim's health reaches 0 (`public/simulation/components/Health.js:210-233`, call at `Health.js:230-232`).

Exact rules:

- **Only killing pays.** The looter is the entity that dealt the killing blow (`attacker` passed to `KilledBy`). The attacker must have a `Looter` component; all units and all structures have one (`public/simulation/templates/template_unit.xml:44`, `public/simulation/templates/template_structure.xml:58`), so towers and fortresses loot their arrow kills too.
- **The resources go to the killer's owner player** via `QueryOwnerInterface(this.entity).AddResources(...)` (`Looter.js:36-38`). There is no splitting: whoever lands the killing blow takes everything.
- **Amount per resource type:** `ApplyValueModificationsToEntity("Looter/Resource/"+type, victimLoot[type], killerEntity) + carried[type]` (`Looter.js:27-33`). The victim's template loot is modified by techs/auras **on the killer** (key `Looter/Resource/<type>`), not on the victim. Known modifiers: the briton civ bonus adds +1 to every resource per kill (`public/simulation/data/technologies/civbonuses/brit_woad_warriors.json:10-13`); several hero auras multiply or add loot for nearby units (e.g. kush hero Nastasen ×1.5, iber hero Viriato ×2 — `public/simulation/data/auras/units/heroes/kush_hero_nastasen_1.json:12-15`, `iber_hero_viriato_2.json:6-9`).
- **Carried resources are looted too.** If the victim is a worker or trader, everything it carries is added on top of the template loot: gatherers' carried load plus the trader's goods (`Looter.js:17-24`, helper `calculateCarriedResources` in `public/globalscripts/Templates.js:612-623`; trader goods from `public/simulation/components/Trader.js:236-239`). Killing a loaded gatherer or trader refunds its cargo to the killer.
- **Capturing gives no loot.** Capture changes ownership without reducing health to 0, so `KilledBy`/`Looter.Collect` never runs; only destroying a building pays its `Loot`.
- **XP is not collected by `Looter`.** The `xp` loot is granted progressively with damage: each `TakeDamage` call returns `xp = victimLootXp × damageDealt / victimMaxHP` (`Health.js:195-197`), and the attack helper feeds it to the attacker's `Promotion` component (`public/simulation/helpers/Attack.js:342-344`). So every attacker that damaged the victim earns a proportional share of the XP loot, and the full `xp` amount is paid out exactly when the victim goes from full HP to dead — regardless of who strikes last. Status-effect damage grants no XP (`helpers/Attack.js:338-340`).

### Loot scaling by rank

Verified: the auto-researched rank techs multiply all five loot values by 1.2 per rank, applied to the **victim** (the modification key is `Loot/<type>` on the victim's entity):

- `public/simulation/data/technologies/unit_advanced.json:15-19` — `Loot/food|wood|stone|metal|xp ×1.2`, affects "Advanced Unit" and "Elite Unit".
- `public/simulation/data/technologies/unit_elite.json:15-19` — same ×1.2, affects "Elite Unit".

So an Advanced unit yields ×1.2 loot, an Elite unit ×1.44, of its template loot — including the XP it grants when damaged.

## Treasures

Treasures are neutral gaia entities with a `Treasure` component (`public/simulation/components/Treasure.js`). Base template `public/simulation/templates/template_gaia_treasure.xml` sets `<CollectTime>1000</CollectTime>` (1 s); the ~28 concrete templates in `public/simulation/templates/gaia/treasure/` only add resources. Examples: `food_crate.xml` 200 food, `wood.xml` 300 wood, `stone.xml` 300 stone, `metal.xml` 300 metal, `shipwreck.xml` 500 wood.

**Collection mechanics** (`public/simulation/components/TreasureCollector.js`):

- Any entity with a `TreasureCollector` component can collect — in practice all units (present on `template_unit.xml:102-104`, including ships, siege, dogs; `<MaxDistance>2</MaxDistance>` m).
- The unit must stand within `MaxDistance` of the treasure; the check uses the obstruction manager at start and again on completion (`TreasureCollector.js:106-124`).
- Collection is a single one-shot timer of `CollectTime` ms (`TreasureCollector.js:56-60`). There are no rate modifiers ("ToDo: Implement rate modifiers", `TreasureCollector.js:56`), so every treasure takes exactly 1 s for every unit.
- On completion the reward goes to the **collector's owner** (`Treasure.js:57-86`): resources are added, the `OnTreasureCollected` trigger event fires, and the treasure entity is **destroyed**. First collector wins; a treasure is taken atomically, there is no sharing.
- The reward is computed once when the treasure gets an owner (`Treasure.js:98-102`) via `ApplyValueModificationsToEntity("Treasure/Resources/<type>", ...)` (`Treasure.js:24-35`); techs could in principle modify it, none shipped do for standard treasures.
- UnitAI has explicit `CollectTreasure` / `CollectTreasureNearPosition` orders (`public/simulation/components/UnitAI.js:5756-5774`). When a treasure order's target is invalidated, the unit auto-searches for another available, visible treasure within 64 m (`UnitAI.js:2953-2955`, `UnitAI.js:4577-4593`).

**`DisableTreasures` game setting:** a boolean match setting, default false (`public/gamesettings/attributes/DisableTreasures.js:1-12`). When enabled, at match setup every entity with the `Treasure` interface is destroyed (`public/simulation/helpers/Setup.js:25-27`). The harness runs with treasures disabled, so in our experiments no treasures exist; on random maps that place them they would otherwise appear as defined by the map script (GUI label: "As defined by the map", `public/gui/common/gamedescription.js:389-394`).

## Ruins (gatherable "loot")

Ruins are separate from loot: they are gaia resource supplies gathered like trees or mines, not killed. Base template `public/simulation/templates/template_gaia_ruins.xml`:

- `ResourceSupply`: `KillBeforeGather false`, `Max 500`, `Type stone.ruins`, `MaxGatherers 1` (`template_gaia_ruins.xml:19-25`). Individual ruins override `Max` (e.g. `gaia/ruins/stone_column_roman.xml` — 400). Metal statues under `gaia/ruins/metal_statue_*.xml` use metal instead.
- **Only one gatherer per ruin at a time** (`MaxGatherers 1`, `ResourceSupply.js:176-179`).
- Ruins use dedicated gather-rate subtypes, much faster than rock/ore: infantry and citizen women gather `wood.ruins` 5, `stone.ruins` 2, `metal.ruins` 2 per second, vs 0.5–0.75 for natural sources (`public/simulation/templates/template_unit_infantry.xml:73-77`, `template_unit_support_civilian.xml:61-65`). Effective rate = template rate × `ResourceGatherer/BaseSpeed` modifiers; the subtype rate is looked up first, then the generic type (`ResourceSupply.js`-based lookup in `public/simulation/components/ResourceGatherer.js:299-318`).
- A ruin is destroyed when its supply reaches 0 (`ResourceSupply.js:239-241`).

Contrast with hunt: herd/hunt fauna have `KillBeforeGather true` (they must be killed first, then gathered as corpses — `template_unit_fauna_hunt.xml:7`); ruins are gathered directly.

## Edge cases a bot should know

- **Kill-stealing matters for resources but not XP.** Resource loot goes entirely to the owner of the entity landing the killing blow; XP is distributed proportionally to damage dealt.
- **Gaia/self-inflicted kills:** if the killer has no owner (`INVALID_PLAYER`) or no `Looter` component, no resources are paid.
- **Killing your own or allied units pays loot** the same way — nothing in `Looter.Collect` or `KilledBy` checks diplomatic stance (only the attacker's ownership is re-read at kill time, `Health.js:212-218`).
- **Traders:** a trader carries `goods` worth the trade gain for its current route leg; killing it hands that amount to the killer (`Looter.js:18-24`, `Trader.js:236-239`).
- **Treasure races:** the timer can be interrupted by moving out of range or the target being taken (`TreasureCollector.js:97-114`); the reward check happens only at timer expiry, so two units collecting the same treasure both spend the 1 s and only one is rewarded.
- **Loot values in the GUI state** (`GuiInterface.js:580` area) are per-entity template values already modified by techs — use them rather than recomputing.
