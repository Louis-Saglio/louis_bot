# Unit allocation through the compromiser

- **ID:** 005
- **Created:** 2026-08-28
- **Depends on:** none

## Context

The ownership design in `docs/on_update_design.md` ("agreed, not yet built")
defines a unit pool (`getOwnUnits()` minus every strategy's
`owned_unit_ids_by_priority` buckets) that the compromiser hands out. Today
nothing implements it: the gathering strategy scans `getOwnUnits()` for idle
gatherers itself, and the `owned_unit_ids_by_priority` dict it publishes is
write-only. This ticket builds the first vertical slice of unit allocation.

Decisions taken during the discussion:

- **Builders are borrowed, not transferred.** Construct requests carry builder
  candidates (the dropoffs strategy already emits its choppers). Builders stay
  in the gathering bucket while they build; when the foundation finishes the
  engine idles them and gathering's idle-assignment pass puts them back to
  work. No return bookkeeping. Rejected alternative: transferring builders out
  of the bucket for the duration of construction (the doc's "task" lifetime
  taken literally), which needs an owner to hold them and a return path.
- **Grants are usable in the same turn.** The doc's one-turn lag between grant
  and use is dropped: the compromiser grants pool units to gathering and
  gathering assigns them to sources in the same `OnUpdate`. The lag exists to
  keep grant decisions consistent across competing strategies; gathering is
  the only unit consumer, so same-turn use is safe and simpler.

Out of scope deliberately: readiness requests, owning requests,
priority-based stealing, and the population strategy's demand table. Gathering
is the only strategy holding units.

## Description

Reorder `OnUpdate` (`mod/simulation/ai/louis_bot/louis_bot.js`): strategies
emit requests first (dropoffs, population), then the compromiser runs, then
gathering, then the executors. Directives are still posted only by `OnUpdate`,
gathering's included.

Extend `allocateBudget` (`mod/simulation/ai/louis_bot/budget_allocation.js`)
to take the game state and the gathering state in addition to requests:

- Approve construct requests that carry a non-empty builder candidate list,
  as today. Reject construct requests with an empty list, with a log line.
  Training requests keep the current approve-all behavior.
- Compute the pool: ids of `getOwnUnits()` not present in any strategy bucket
  (only gathering has one).
- Grant the whole pool to gathering at priority 1 and return the updated
  `owned_unit_ids_by_priority`.

Rework `applyGatheringStrategy`
(`mod/simulation/ai/louis_bot/gathering_strategy.js`) to be bucket-driven:

- The bucket in its input state is authoritative. Stop scanning
  `getOwnUnits()` for idle units entirely.
- Reconcile: prune dead units from the bucket and from every private dict.
- Keep the existing assignment lifecycle (drop on idle, drop on dead or
  depleted source, recall on dangerous or ineligible source) but operate on
  bucket units only. Dropping an assignment does not remove the worker from
  the bucket; borrowed builders keep no assignment and stay untouched because
  they are not idle.
- Assign idle bucket units (plus recalled workers) to sources exactly as the
  current `assignIdleWorkers` does, including units granted this same turn.
- Return the bucket carried through (pruned, plus the compromiser's grants)
  instead of re-deriving it from the private assignments.

## Acceptance criteria

- [ ] A headless game (see `docs/pyrogenesis_cli.md`) runs without errors and
  the log shows workers assigned to food and wood sources from turn one.
- [ ] The log shows a storehouse construction order approved with builder
  candidates, and the foundation rises and completes; its builders return to
  gathering afterwards (they appear in later assignment log lines).
- [ ] Newly trained civilians are granted to gathering and assigned to a
  source without any code path reading idle units from `getOwnUnits()`
  (grep shows no `getOwnUnits` call left in `gathering_strategy.js`).
- [ ] A construct request with an empty builder list is rejected and logged.

## Out of scope

- Readiness requests, owning requests, priority-based stealing.
- Population strategy consuming a demand table.
- Military units: every pool unit goes to gathering regardless of class.
- Updating `docs/on_update_design.md` (editing `docs/` is forbidden; note the
  two accepted deviations in the implementation summary instead).

## Notes

- `docs/on_update_design.md` sections "Ownership and readiness" and "The
  compromiser's turn" describe the target; this ticket implements steps 2 and
  6 of the compromiser's turn in their minimal form.
- Every variable declaration needs a type comment (project rule in
  `AGENTS.md`).
