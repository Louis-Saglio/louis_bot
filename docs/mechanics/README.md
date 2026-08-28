# Game mechanics of 0 A.D. 0.28.0

One file per **game mechanic**, written for an agent implementing a bot. These
files explain *how the simulation works*: formulas, timings, edge cases, and
what a bot can observe or must do.

**Everything here was verified against the pinned game copy at
`/home/ubuntu/0ad-reference/` (0.28.0)** — the simulation components
(`public/simulation/components/*.js`), helpers (`public/simulation/helpers/*.js`),
data (`public/simulation/data/**`), templates (`public/simulation/templates/**`)
and engine source (`source/source/simulation2/**`). Nothing was written from
memory; every claim carries an inline `path:line` citation. If a statement looks
wrong, trust the source, not the doc — and fix the doc.

## Index

### Economy
- [resources_and_gathering](resources_and_gathering.md) — resource types/subtypes, gather rates and cycles, carrying capacity, dropsites, supply exhaustion, trickle.
- [animals_and_hunting](animals_and_hunting.md) — fauna categories and stances, the flee order and flee speeds, meat supplies, the corpse entity.
- [construction](construction.md) — foundations, the construct→repair two-step, multi-builder formula, repair, placement rules.
- [training_and_production](training_and_production.md) — production queues, batch training, refunds, rally points, auto-queue.
- [population_and_entity_limits](population_and_entity_limits.md) — population costs/bonuses, world pop cap, entity limits (heroes, siege).
- [trade_and_barter](trade_and_barter.md) — barter prices, trade routes and the distance-based gain formula, international trade.
- [loot_and_treasures](loot_and_treasures.md) — kill/destroy loot, XP loot, treasures, ruins.

### Combat
- [combat_and_damage](combat_and_damage.md) — attack/damage types, the exact armor formula, class bonuses, projectiles, building fire.
- [capture](capture.md) — capture points, capture strength, ownership flips, capture vs destroy.
- [promotion_and_experience](promotion_and_experience.md) — XP gain rule, ranks, what promotion changes.
- [garrisoning](garrisoning.md) — garrison vs turrets, healing inside, arrows from garrisoned units, walls/gates.
- [healing_and_repair](healing_and_repair.md) — healers, regeneration sources, repairing siege and buildings.

### World and information
- [territory](territory.md) — influence/weights, connected territory, territory decay, build restrictions.
- [vision_and_fog_of_war](vision_and_fog_of_war.md) — LOS grid, fog/explored states, mirages, shared vision (and what the AI actually sees).

### Progression and game flow
- [technologies_and_modifiers](technologies_and_modifiers.md) — tech JSON, requirements, the modification pipeline, pairs, phases.
- [auras](auras.md) — aura schema, targeting, stacking rules.
- [victory_defeat_and_diplomacy](victory_defeat_and_diplomacy.md) — victory conditions (incl. the harness's `conquest_civic_centers`), defeat, diplomacy, ceasefire.
- [orders_and_simulation_time](orders_and_simulation_time.md) — the 200 ms turn model, when commands take effect, UnitAI order queues, stances, timers, game speed.
