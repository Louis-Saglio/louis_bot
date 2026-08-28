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

Currently built: `gathering_strategy.js` (bucket-driven: works the units the
compromiser grants, measures rates), `dropoffs_strategy.js`
(requests a storehouse near any chopped tree with no dropsite within 40 m),
`population_strategy.js` (requests one civilian when the civil center's
queue is empty), `budget_allocation.js` (compromiser: approves spending,
grants pool units to gathering),
`construction_execution.js` (foundations and builders),
`training_execution.js` (unit training).

## The allocation design

This section records the target design for resource and unit allocation.
Built so far: the pool (`getOwnUnits()` minus every strategy's buckets) and
the grant of pool units to gathering. Not yet built: owning requests,
readiness requests, priority-based stealing.

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
  Represented as a standard `owned_unit_ids_by_priority` dict in each
  strategy's state: priority level -> sorted list of entity ids. A strategy
  may hold different units at different priorities. The compromiser mutates
  these dicts between turns.
- **Un-owned**, meaning in the pool. The pool has no representation: it is
  `getOwnUnits()` minus the union of all buckets of all strategies. Freshly
  trained units land in the pool.

Gathering is an owner like any other strategy: it holds its assigned
workers at priority 1, because it uses them continuously and pays a real
cost (walking time, lost rate history) when one is pulled away. It is the
largest holder, not a special case.

Ownership is soft. The compromiser prefers pool units, but when a request
cannot be served from the pool it takes owned units from the lowest-priority
buckets across all strategies. A unit's holding priority is a fact stored
in its owner's bucket, not inferred from re-emitted requests.

Owned units leave their bucket in exactly three ways: the strategy stops
re-emitting the owning request (the claim lapses, units return to the pool;
a crashed strategy cannot squat on units forever), the compromiser steals
them, or they die.

Grants are usable in the same turn: the compromiser adds pool units to
gathering's bucket and gathering assigns them to sources in the same
`OnUpdate`. The one-turn lag between grant and use from the original design
was dropped while gathering is the only unit consumer.

**Readiness** is a standing demand, not a hold: "keep 10 archers in
existence." A readiness request carries an **escalation priority**, the
priority the strategy would claim at if it actually needed the units. A
unit counts toward a readiness request when it is un-owned (priority 0) or
held strictly below the escalation priority: readiness means "this unit
would be mine if I escalated right now." Gathering's priority-1 workers
therefore count as ready for almost everyone. Several strategies may be
satisfied by the same group; when one of them escalates and owns the group
away, the others' readiness fails next turn and they re-emit.

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
  unit_candidates: [/* entity ids */],  // array: the emitter's own units to
                                        // use; an empty list rejects the
                                        // request
  lifetime: "task",                // string: "purchase" (stock leaves once,
                                   // units stay), "task" (units are borrowed,
                                   // never leave their bucket, and are freed
                                   // by idleness when done), "standing"
                                   // (held while re-emitted)
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
  count: 10,                    // number: units that should be available
  escalation_priority: 4,       // number: 1-5; a unit counts when un-owned
                                // or held strictly below this priority
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
2. Compute the pool from game state and the union of every strategy's
   `owned_unit_ids_by_priority` buckets.
3. Check readiness: per request, count matching units that are un-owned or
   held strictly below the request's escalation priority. Aggregate into
   the demand table (per capability: available count, watcher keys, missing
   count), which is part of the compromiser's turn output.
4. Fill owning requests by descending priority, from the pool first. When
   the pool is short, steal owned units from the lowest-priority buckets,
   strictly below the request's priority. Prefer incumbents: a re-emitted
   request keeps its units.
5. Approve spending requests by descending priority against remaining stock,
   population headroom, and unit requirements, lending pool units into
   `unit_candidates` when the emitter's own units fall short.
6. Mutate every strategy's `owned_unit_ids_by_priority` to reflect grants,
   lapses, and thefts.
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

