# Developer guide

## Architecture

The bot is a set of pure decision passes wired together in `OnUpdate`
(`mod/simulation/ai/louis_bot/louis_bot.js`). Three layers, three words:

- A **request** is something a strategy wants: resources, units, or unit
  readiness. Strategies emit requests; they never post engine commands.
- The **compromiser** approves requests against reality and converts each
  approved one into an **order** in an executor's vocabulary. It is the only
  component that sees every strategy's demands.
- An **executor** carries orders out and emits **directives**: plain-data
  engine commands. `OnUpdate` is the only function that posts them to the
  engine.

Passes return their next state as plain structured-cloneable data; `OnUpdate`
stores it and `Serialize`/`Deserialize` persists it.

Currently built: `gathering_strategy.js` (assigns idle gatherers, measures
rates), `dropoffs_strategy.js` (requests storehouses for uncovered wood
clusters), `budget_allocation.js` (approve-all compromiser),
`construction_execution.js` (foundations and builders).

## The allocation design (agreed, not yet built)

This section records the target design for resource and unit allocation.

### Principles

- **One compromiser for stock and units.** Approving an action means
  approving everything it needs: resources, units, production building,
  population headroom. Approving a foundation without builders sinks the
  cost into a foundation nobody raises. The merged compromiser judges each
  request as a whole or rejects it.
- **Requests are granular.** One request per indivisible spend: one
  building, one trained unit, one tech. Never bundle ("4 storehouses, 400
  wood"), because a bundled request is rejected all together when stock
  covers only part. Granular requests let the compromiser approve the
  affordable prefix, so strategies may request without bounds and never
  underspend out of caution.
- **Requests re-emit every turn or die.** Unfulfilled requests are dropped
  at end of turn. A strategy that still cares re-emits next turn.
- **Count already-paid-for as satisfied.** Foundations count as coverage,
  training queues count as trained. Otherwise the bot pays twice.
- **Reconcile before deciding.** Units owned last turn may have died or
  been taken by the compromiser. Every strategy diffs its state against
  reality each turn before emitting anything.

### Ownership and readiness

A unit is in exactly one of two places:

- **Owned** by one strategy, because that strategy is using it right now.
  Represented as a standard `owned_unit_ids` list of entity ids in each
  strategy's state. The compromiser mutates these lists between turns.
- **Un-owned**, meaning in the pool. The pool has no representation: it is
  `getOwnUnits()` minus the union of all `owned_unit_ids`. Pool units gather
  by default (gathering is the residual claimant, not a requester), and any
  of them can be taken at any time.

Ownership is soft. The compromiser prefers pool units, but when a request
cannot be served from the pool it may take owned units from a lower-priority
use. The owner's re-emitted owning request states what the units are doing
and at what priority; the new request outranks it or goes unsatisfied.

There is a one-turn lag between grant and use: the compromiser adds units to
a strategy's list at end of turn T, the strategy sees them and can emit
directives for them at turn T+1. Requests acquire, directives use, never in
the same turn.

**Readiness** is a standing demand, not a hold: "keep 10 archers in
existence." Ready units stay in the pool and gather. Several strategies may
be satisfied by the same group; when one of them owns the group away, the
others' readiness fails next turn and they re-emit.

### Request shapes

All requests are plain structured-cloneable data with a `key` (stable id,
emitter + object) and a `detail` (human-readable, logs only).

Spending / action request (construct, train, research, barter, tribute):

```js
{
  key: "dropsite:wood:cluster-7",  // string: stable id
  kind: "construct",               // string: dispatch tag
  priority: 3,                     // number: 1-5, honest scale
  payload: { template, x, z, angle },  // object: kind-specific command data
  cost: { food: 0, wood: 100, stone: 0, metal: 0 },  // object: stock cost
  population_cost: 0,              // number: headroom consumed under the cap
  units_min: 2,                    // number: below this the action is useless
  units_ideal: 4,                  // number: beyond this no added value
  unit_candidates: [/* entity ids */],  // array: defaults to the emitter's
                                        // own units; empty means the
                                        // compromiser must supply them
  lifetime: "task",                // string: "purchase" (stock leaves once,
                                   // units stay), "task" (units return when
                                   // done), "standing" (held while re-emitted)
  detail: "woodline dropsite for cluster 7"  // string: logs only
}
```

Owning request (acquire units for active use):

```js
{
  key: "defense:home-vs-ram",   // string: stable id
  priority: 5,                  // number: 1-5
  capability: "melee_infantry", // string: matched against template classes
  units_min: 3,                 // number
  units_ideal: 5,               // number
  location: { x, z },           // object: where the units are needed
  detail: "ram attacking north tower"  // string: logs only
}
```

Readiness request (keep units in existence, hold nothing):

```js
{
  key: "defense:home-archers",  // string: stable id
  capability: "archer",         // string: matched against template classes
  count: 10,                    // number: units that should exist un-owned
  detail: "anti-ram reserve"    // string: logs only
}
```

### Priorities

An integer 1 to 5, on a scale shared by all strategies, with a written
meaning per level so a 4 from defense equals a 4 from economy. Strategies
set priorities from their own context (defense knows threat severity) and
must be honest: inflation makes the scale useless, and benchmarking is the
enforcement. Priority 0 means the request is useless; do not emit it.

### The compromiser's turn

1. Read every strategy's result: directives, spending requests, owning
   requests, readiness requests.
2. Compute the pool from all `owned_unit_ids` lists and game state.
3. Check readiness: per capability, count pool units, list watcher keys,
   compute the missing count. The demand table (pool count, watchers,
   missing) is part of the compromiser's turn output.
4. Fill owning requests by descending priority, from the pool first. When
   the pool is short, steal owned units from lower-priority uses. Prefer
   incumbents: a re-emitted request keeps its units.
5. Approve spending requests by descending priority against remaining stock,
   population headroom, and unit requirements, lending pool units into
   `unit_candidates` when the emitter's own units fall short.
6. Mutate every strategy's `owned_unit_ids` to reflect grants and thefts.
7. Convert approved spending requests into orders for the executors.

### The population strategy

The only strategy allowed to emit train requests, because it is the only one
that sees the whole population. Its inputs are the demand table, the current
population composition, and the pop cap. It is proactive, not reactive:
training takes tens of seconds, so a population strategy that only answers
unfulfilled readiness delivers the army after the tower has fallen. It keeps
a standing policy (military-to-worker ratio, common unit types) and treats
the demand table as a correction signal. Many watchers on the same small
group means train ahead: one raid can unready several strategies at once.

