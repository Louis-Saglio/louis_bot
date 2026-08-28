# Territory- and danger-aware gathering

- **ID:** 004
- **Created:** 2026-08-28
- **Depends on:** none

## Context

The bot eventually sends its gatherers into the enemy base. Observed cause:
workers walking to a chicken next to the enemy CC and dying there.

Root cause in `gathering_strategy.js`: the candidate pool is
`game_state.getResourceSupplies(resource)`, every supply of that type on the
whole map, and `assignIdleWorkers` scores sources purely on gather rate and
cross-resource weights. Distance, territory and enemy presence never enter
the decision. Early game the best-rate sources happen to be local; once
nearby supplies deplete or saturate, the best-scoring free sources are far
away, eventually inside the enemy base. Workers that die en route are pruned
and reassigned to another distant source, so the flow never stops.

Agreed rule, from the discussion:

- Gather only inside own territory, with the existing rate optimization.
- If a resource has no in-territory supply left, fall back to supplies in
  neutral territory ordered by distance to the own-territory edge, ignoring
  rate optimization.
- In both tiers, exclude supplies an enemy would attack a gatherer at. The
  enemy's attack trigger is what defines the threat radius: mobile units
  chase anything they see, so their radius is `visionRange()`; static
  defenses only shoot within arrow range, so theirs is max `attackRange`.

Alternatives considered and rejected:

- Blanket ban on enemy-territory supplies as the fallback filter. Rejected:
  the real problem is lethality, not borders, and a territory ban would not
  protect against raiders standing inside own territory.
- "Distance to nearest own structure" as the fallback metric. Rejected: less
  faithful than distance to the territory edge near territory protrusions,
  and the distance transform is cheap on this grid size.
- Danger filter only in the fallback. Rejected: an enemy army camping a
  source inside own territory is the same suicide as the chicken. One
  uniform rule instead of per-tier special cases.

## Description

Rework source eligibility in `applyGatheringStrategy`
(`mod/simulation/ai/louis_bot/gathering_strategy.js`):

1. **Inputs.** `louis_bot.js` passes `territoryMap` and the per-player enemy
   data (`sharedAI.playersData.isEnemy`, or equivalent) into
   `applyGatheringStrategy`. `territoryMap` is `{ width, height, cellSize,
   data: Uint8Array }`, owner per tile, index `x + y * width`
   (`docs/ai_engine_api.md:626`). The grid can lag the engine a few turns
   (`docs/ai_engine_api.md:835`); acceptable here.
2. **Distance transform.** Once per turn, compute a distance-to-own-territory
   grid from `territoryMap` (multi-source BFS over own-territory tiles, or an
   equivalent two-pass approximation). Each supply samples one cell to get
   its distance to the territory edge.
3. **Threat list.** Once per turn, collect enemy entities that can hurt a
   gatherer:
   - mobile units with at least one attack type: radius = `visionRange()`;
   - structures with `hasDefensiveFire()`: radius = max `attackRange(type)`
     over their attack types.
   A supply is dangerous if any threat entity is within
   `radius + DANGER_MARGIN` of the supply position. `DANGER_MARGIN` (~10 m)
   is a named constant at the top of the file, to be calibrated later.
4. **Eligibility, per resource.** Tier 1 candidates: supplies in own
   territory, not dangerous. If a resource has no tier 1 candidate, fallback
   for that resource only: supplies in neutral territory, not dangerous.
   Keep the existing filters (position known, `resourceSupplyAmount() > 0`,
   `maxGatherers`, `resourceSupplyNumGatherers()`).
5. **Assignment.** Tier 1 keeps the current rate-based scoring untouched.
   In the fallback, sources are ordered by distance-to-territory (nearest
   first); measured rates, template rates and diminishing returns are
   ignored for source choice. The cross-resource weight balancing
   (`GATHER_WEIGHTS`) still decides how workers split between resources, so
   a fallback resource competes with tier 1 resources as today.
6. **Recheck existing assignments.** Each turn, before assigning idle
   workers, drop any assignment whose source is now ineligible: dangerous,
   depleted, or out of own territory while tier 1 candidates exist for that
   resource. Dropped workers become idle and are reassigned by the same
   rules. This also recalls workers when a mobile threat walks up to their
   source.
7. **Nothing eligible.** Workers stay idle. No assignment, no directive.

## Acceptance criteria

- [ ] In a headless game with an enemy on the map, the bot never issues a
      gather order to a supply inside enemy territory while any eligible
      in-territory or neutral fallback supply exists.
- [ ] In a headless game, once all in-territory food is depleted, gatherers
      walk to the neutral food source nearest the territory edge, not to the
      source with the best rate.
- [ ] A supply within `visionRange() + DANGER_MARGIN` of an enemy soldier,
      or within arrow range + margin of an enemy CC or tower, receives no
      gather order, in either tier.
- [ ] When an enemy unit moves within threat radius of a source with
      assigned gatherers, their assignments are dropped on a following turn
      and they are reassigned elsewhere (or stay idle if nothing is
      eligible).
- [ ] Existing behavior is otherwise unchanged: rate measurement,
      diminishing returns and `GATHER_WEIGHTS` balancing still apply to
      in-territory assignment.
- [ ] Deterministic: same seed gives same assignments.
- [ ] Headless smoke game runs to completion without errors in the bot log.

## Out of scope

- Gaia predators (wolves, lions) as threats.
- Ceasefire handling (enemies do not attack during ceasefire).
- Any military or fleeing response to nearby enemies; workers recalled from
  a dangerous source simply get reassigned or go idle.
- Calibrating `DANGER_MARGIN` against benchmarks.
- Making the dropoffs pass (ticket 003) prefer sites that extend territory
  toward fallback resources.

## Notes

- `getResourceSupplies(resource)` excludes huntable animals and sea
  creatures (`docs/ai_engine_api.md:800`); the chicken in the observed bug
  is a domestic animal supply, which is included.
- AI players see through fog of war (`docs/ai_engine_api.md:138`), so the
  threat list covers all enemy entities, not just scouted ones.
- Relevant accessors: `visionRange()` and `hasDefensiveFire()`
  (`docs/ai_engine_api.md:461-464`), `attackTypes()` / `attackRange(type)`
  (`docs/ai_engine_api.md:443`), `playersData.isEnemy`
  (`docs/ai_engine_api.md:226-227`).
- Threat entities move; the eligibility recheck in step 6 is what makes the
  snapshot-based threat list sufficient. Do not try to predict movement.
- The bot's `OnUpdate` runs every turn; if the distance transform or threat
  scan shows up in profiles, self-throttle like Petra (one turn in eight,
  `docs/ai_engine_api.md:135-137`) rather than complicating the logic.
