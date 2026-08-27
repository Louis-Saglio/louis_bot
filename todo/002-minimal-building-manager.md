# Minimal building manager

- **ID:** 002
- **Created:** 2026-08-27
- **Depends on:** 001

## Context

Construction requests approved by the spending manager (ticket 001) need
someone to do the plumbing: post the `construct` command, then send
builders to raise the foundation. That logistics lives in a dedicated
building manager, so spending decisions and construction mechanics stay
separate concerns.

Deliberately minimal v1, per the design discussion:

- It builds only with the builder candidates listed in the construction
  order. No fallback builder selection, no replacing dead builders. If the
  list is empty or all candidates are dead, the foundation never gets
  built. Accepted for now. A better building manager comes later.
- Known limitation, to document in code: an unfinished foundation counts as
  coverage for the emitting pass. A foundation whose builders died sits
  unfinished forever, and its resource cost is sunk. Re-emission does not
  save it because the pass stops emitting once the foundation exists.
- It receives construction orders `{ template, x, z, angle, builders }`,
  not spending requests. It knows nothing about costs, keys, or reasons.

## Description

Add a `manageConstruction` executor, same pure/impure style as
`manageWorkers`. It consumes the construction orders produced by the
spending manager and returns `{ state, directives }`. `OnUpdate` resolves
the entity ids and posts the directives. `manageConstruction` itself calls
no entity command methods.

1. For each new construction order, emit a directive
   `{ kind: "construct", template, x, z, angle, builder_id }` naming one of
   the listed builders as the poster. The command creates the foundation
   instantly at processing time with `autorepair: false`, so no builder is
   sent automatically.
2. Keep one small piece of state: `builder_ids_by_foundation_id`. Match
   each freshly created foundation to its order, by template and position
   or by scanning `getOwnStructures()` for new foundations, so builders
   survive past the one-turn order.
3. Each turn, for every unfinished own foundation with recorded builders,
   emit a `{ kind: "repair", builder_id, foundation_id }` directive for
   every still-alive builder.
4. Drop the foundation's entry once `foundationProgress()` reports
   completion. Do not replace dead builders. If none remain, leave the
   foundation untouched.
5. Persist the state through `Serialize`/`Deserialize` like `worker_state`.

## Acceptance criteria

- [ ] Feeding a construction order with live builder ids makes a foundation
      appear at the requested spot, and builders walk to build it.
      Observable in a headless game.
- [ ] Foundations reach completion with no order surviving past its turn.
      State comes only from `builder_ids_by_foundation_id` and game state.
- [ ] A construction order with `builders: []` or only dead ids fails
      quietly. No crash, no fallback builder recruited.
- [ ] `manageConstruction` returns directives as data and calls no entity
      command methods. `OnUpdate` posts them.
- [ ] Completed foundations leave the manager's state.
- [ ] The state survives a save/load cycle (`Serialize`/`Deserialize`).

## Out of scope

- Fallback builder selection when the order lists none. Future building
  manager redesign.
- Replacing dead builders, resuming abandoned foundations.
- Placement validity search. The caller provides x/z. Silent rejection on
  invalid spots is accepted, and the emitter retries next turn.
- Emitting construction orders from a real pass. Ticket 003.

## Notes

- The construct directive maps to `entity.construct(...)`, which posts
  `autorepair: false`. The repair directive must come on a later cycle
  (`docs/ai_engine_api.md:826-828`).
- `getOwnStructures()` includes foundations. Distinguish them with
  `foundationProgress() === undefined` for finished buildings. Beware: a
  fresh foundation reports `0`, which is falsy
  (`docs/ai_engine_api.md:804-808`).
- Builders ordered to `repair` are not idle, so `pruneWorkers` keeps their
  worker assignments. Gatherers building their own dropsite stay counted
  as gatherers and resume on their own: they go idle on completion and the
  worker pass reassigns them.
