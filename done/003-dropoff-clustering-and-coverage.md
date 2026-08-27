# Dropoff clustering and coverage

- **ID:** 003
- **Created:** 2026-08-27
- **Depends on:** 001, 002

## Context

Walking time dominates gather rates once a resource line sits far from a
dropsite. The bot's measured rates already show it. The bot should build
storehouses near remote woodlines so gatherers stop trekking back to the
civil center.

Original proposal: when a gatherer is assigned a tree with no storehouse
within 20 m, build one at the spot that minimizes average walking distance
to trees within 20 m. The discussion changed this a lot:

- State-driven, not event-driven. Triggering on assignment events fires in
  bursts and couples building to the pure assignment function. Instead a
  dedicated dropoff pass reads the world each turn and emits a spending
  request (ticket 001) per uncovered cluster.
- Payoff test. Building unconditionally spams storehouses. A storehouse
  21 m away is nearly as good as 19 m, and a three-tree cluster never pays
  back the build. Build only for clusters with enough remaining supply and
  at least one committed gatherer.
- Good-enough placement. Supply-weighted centroid, with remaining supply as
  weight so nearly-exhausted trees stop pulling the site, snapped to a
  buildable spot. The exact geometric median and grid search were rejected
  as premature.
- Wood only for now. Storehouses take wood, metal and stone. Food needs
  farmsteads. The rule is written per generic resource type but only wood
  is wired in this ticket.
- Spending goes through the manager. The pass emits construct spending
  requests with `builders` set to the cluster's workers. They are nearby
  and keep their worker assignment while building. The pass never posts
  commands itself. Foundations, built or not, count as coverage. Since
  unfulfilled requests are dropped each turn, the foundation appearing next
  turn is what stops re-emission.
- Approved requests are executed by the building manager (ticket 002),
  including the known v1 limitation that a foundation whose builders die
  never finishes.

## Description

Add a `manageDropoffs` pass, in the codebase's pure/impure style:

1. Cluster wood supplies with union-find. Two supplies share a cluster if
   within ~30 m of each other. Keep it deterministic: sort by entity id.
   Per cluster compute the remaining supply sum, the supply-weighted
   centroid, and the workers assigned to it (from `worker_state`
   assignments by `source_id`).
2. Coverage. A cluster is covered if any own storehouse, built or
   foundation, is within D ≈ 40 m of the centroid. The civil center also
   accepts wood, so count it as a dropsite too.
3. Payoff test. Emit a request only if the cluster is uncovered, has
   remaining supply ≥ S_min ≈ 1500, and has at least one assigned
   gatherer.
4. Placement. The nearest position to the centroid where the storehouse
   template actually fits. The centroid often lands on trees. Validate
   before emitting, since construct rejection is silent.
5. Emit one spending request per qualifying cluster: `kind: "construct"`,
   payload = the player's civ storehouse template plus the snapped
   position, `cost` from the template, `builders` = the cluster's assigned
   worker ids, `key` = `dropsite:wood:<stable cluster id>`, `detail` = a
   human-readable reason.
6. The constants (~30 m cluster radius, D ≈ 40 m, S_min ≈ 1500) live as
   named constants at the top of the file, to be calibrated by benchmarking
   later.

## Acceptance criteria

- [ ] In a headless game, once the bot gathers wood on a cluster farther
      than D from any dropsite with ≥ S_min remaining, exactly one
      storehouse request is emitted per turn for that cluster, with the
      cluster's gatherers as `builders`.
- [ ] A storehouse appears near the woodline and the cluster's workers
      build it. Afterwards workers deliver there, visible as shorter walks
      in measured rates or delivery timing.
- [ ] No request is emitted for clusters near the CC, for tiny clusters, or
      once a foundation exists. No double-build across turns.
- [ ] Deterministic: same seed gives same clusters and same placement.
- [ ] The worker pass is untouched. Assignments and rate measurements
      behave as before. Building workers keep their assignment, then get
      reassigned normally on completion.

## Out of scope

- Food (farmsteads), metal, stone. The pass is shaped per generic resource
  type so these fall out later, but only wood is wired.
- Placement optimization beyond centroid plus nearest-buildable snap.
- Calibrating D, S_min and the cluster radius against benchmark win rates.
- Payback math from measured gather rates replacing the static thresholds.
- Building-manager improvements: fallback builders, abandoned foundations.

## Notes

- The shared script maintains the resource supply collections
  (`game_state.getResourceSupplies(resource)`). No full map scan needed.
  The worker pass already uses them.
- Storehouses require own territory in 0.28 (`Territory: own`, inherited
  from `template_structure.xml`). A woodline centroid far from the CC may
  sit outside it, so the placement snap must search until it finds a spot
  that is both unobstructed and in own territory.
- Validate placement against the live state. The AI territory grid can lag
  a few turns (`docs/ai_engine_api.md:835-836`).
- The storehouse template name depends on the civ. Look it up from the
  player's civ: `structures/{civ}/storehouse`.
