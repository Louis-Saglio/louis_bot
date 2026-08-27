# Spending requests and passthrough spending manager

- **ID:** 001
- **Created:** 2026-08-27
- **Depends on:** none

## Context

The bot is about to gain its first resource-spending feature (dropoff
buildings, ticket 003). Research, unit training, tribute, and barter will
follow. If each `manage*` pass spends resources on its own, balancing
spending across concerns gets messy fast. So all spending goes through one
place: passes emit spending requests, a spending manager approves them and
dispatches them to the right executor.

Decisions from the design discussion:

- The spending manager is stateless. Each turn it evaluates the requests
  emitted that turn against current stock. Unfulfilled requests are dropped
  at end of turn. Passes re-emit every turn as long as the need persists.
  No pending queue, no cancel protocol, no expiry.
- This puts one contract on every emitting pass: count "already paid for"
  as "need satisfied". Count foundations as coverage, check training
  queues. Otherwise the bot pays twice.
- v1 policy: approve everything. The engine validates `construct` at
  command processing time against real stock and rejects silently without
  charging, so an unaffordable approval costs nothing and the pass
  re-emits the request next turn. Virtual-stock reservation was considered
  and dropped as premature.
- The manager does not hand raw spending requests to executors. It converts
  each approved request into a tailored order in the executor's own
  vocabulary. A construct request becomes a construction order. The
  spending manager is the only component that knows both languages.
- Prioritization by key prefix was designed but deferred. With a single
  spender there is nothing to balance yet.

## Description

Add to `mod/simulation/ai/louis_bot/louis_bot.js`, or a sibling module
imported from it, matching how the file grows:

1. The spending request shape. Plain structured-cloneable data, since it
   may end up in serialized bot state:

   ```js
   {
     key: "dropsite:wood:cluster-7",  // unique handle: emitting concern + object
     kind: "construct",               // dispatch tag
     payload: { template, x, z, angle },  // kind-specific command data
     cost: { food: 0, wood: 100, stone: 0, metal: 0 },
     builders: [/* entity ids */],    // always a list, [] when no candidates;
                                      // only meaningful for kind "construct"
     detail: "woodline dropsite for cluster 7"  // human-readable, logs only
   }
   ```

2. A pure function `manageSpending(requests, game_state)` that:
   - approves every request (v1 policy);
   - dispatches on `kind`. Only `"construct"` is wired. It converts the
     request into a construction order `{ template, x, z, angle, builders }`.
     Cost, key and detail are spending-layer vocabulary and do not leak
     into the order;
   - returns `{ construction_orders }`. Extend with other order types when
     new kinds are wired;
   - logs one line per request received and per order emitted.

3. Wire it into `OnUpdate` and fix the command vocabulary in the existing
   code. Three words, three layers:
   - A directive is an engine command described as plain data, e.g.
     `{ kind: "gather", worker_id, source_id }`. Decision-making passes and
     executors emit directives. Rename the worker pass's current `orders`
     field to `directives`.
   - A request is a spending decision a pass wants made. Passes emit
     requests; the spending manager approves them.
   - An order is an approved request rephrased in an executor's vocabulary.
     The spending manager emits orders; executors (ticket 002) consume them
     and emit directives.
   `OnUpdate` collects directives and requests from every pass, runs
   `manageSpending`, hands orders to executors, and posts every directive
   as an engine command. It is the only function that calls entity command
   methods. Until ticket 003 exists, nothing emits requests. That is fine.

## Acceptance criteria

- [ ] The spending request shape exists with `builders` as a non-nullable
      list, empty by default.
- [ ] `manageSpending` is a pure function. Same input gives same output,
      and it posts no engine commands.
- [ ] Approved construct requests come out as construction orders shaped
      `{ template, x, z, angle, builders }`, with no `key`, `cost`, or
      `detail`.
- [ ] A synthetic construct request fed through `OnUpdate` produces a
      construction order and the two log lines (request received, order
      emitted).
- [ ] The worker pass's `orders` field is renamed to `directives`, with no
      behavior change: `OnUpdate` posts them as before.
- [ ] The bot still runs a headless game without errors when no pass emits
      requests.

## Out of scope

- Approval policy beyond approve-all: priority, budgeting, stock
  reservation. Deferred until a second spender exists.
- A labor allocation compromiser for units. Worker assignment stays a
  direct directive from the worker pass until a second claimant for units
  exists (the army manager). Unit allocation differs from resource
  spending: it is continuous rather than point-in-time, units are not
  fungible, and reallocating costs walking time, so it needs stickiness
  that stock spending does not. `assignIdleWorkers` is the seed of that
  future compromiser: it already scores worker-to-source pairs, and the
  general version scores worker-to-claim pairs across concerns.
  Allocations end when a unit goes idle, which is how builders return to
  gathering with no bookkeeping.
- Executing construction orders. Ticket 002.
- Any pass actually emitting requests. Ticket 003.
- Other kinds: `train`, `research`, `barter`, `tribute`.

## Notes

- API reference: `docs/ai_engine_api.md`. The engine validates construct
  commands at processing time and rejects them silently (`:829-834`). The
  bot only ever sees its own logs, hence the logging requirement.
- Keep the style of `louis_bot.js`: pure decision functions, impure layer
  at the edges, every engine command posted from `OnUpdate`.
