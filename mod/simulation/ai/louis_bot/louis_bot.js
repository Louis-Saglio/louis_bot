import { BaseAI } from "simulation/ai/common-api/baseAI.js";

// dict: resource name -> weight (number); sums to 1, constant for now.
// A zero weight means no worker is ever sent to that resource.
const GATHER_WEIGHTS = { food: 0.5, wood: 0.5, metal: 0, stone: 0 };

// number: the bot plays every that many turns
const PLAY_EVERY_N_TURN = 8;

// number: meters; two wood supplies closer than this belong to one cluster
const CLUSTER_RADIUS = 30;
// number: meters; a cluster is covered when a wood dropsite, built or
// foundation, sits this close to the cluster centroid
const DROPOFF_COVERAGE_RADIUS = 40;
// number: remaining wood below which a cluster never justifies a storehouse
const MIN_CLUSTER_SUPPLY = 1500;
// number: meters; how far from the centroid the placement search may wander
const DROPOFF_SEARCH_RADIUS = 40;
// number: meters; step between candidate spots in the placement search
const DROPOFF_SEARCH_STEP = 2;

/**
 * @param {object} settings — engine-provided player settings: { player,
 *   difficulty, behavior } (see the AI engine API docs).
 */
export function LouisBot(settings) {
  BaseAI.call(this, settings);
}

LouisBot.prototype = Object.create(BaseAI.prototype);

/**
 * Falls back to the generic type, like the engine's own lookup.
 * @param {object|undefined} rates — worker's resourceGatherRates() output,
 *   subtype name -> rate.
 * @param {string} subtype — full subtype, e.g. "food.fruit".
 * @param {string} generic_type — generic type, e.g. "food".
 * @returns {number}
 */
function templateRate(rates, subtype, generic_type) {
  if (!rates) return 0;
  return +rates[subtype] || +rates[generic_type] || 0;
}

/**
 * @param {object} template_rates — worker's resourceGatherRates() output.
 * @param {{id: number, generic: string, specific: string,
 *   gatherer_count: number, max_gatherers: number,
 *   diminishing_return: number, measured_rate: number,
 *   measured_template_rate: number}} source — one free gatherer slot.
 * @returns {number}
 */
function estimateSourceRate(template_rates, source) {
  // number: the worker's template rate on this subtype, 0 if it cannot gather it
  const template_rate = templateRate(
    template_rates,
    source.specific,
    source.generic,
  );
  if (template_rate <= 0) return 0;
  if (source.measured_rate > 0)
    return (
      source.measured_rate * (template_rate / source.measured_template_rate)
    );
  return (
    template_rate * Math.pow(source.diminishing_return, source.gatherer_count)
  );
}

/**
 * @param {object} assignment_by_worker_id — worker id -> { resource,
 *   source_id, subtype }.
 * @param {object} carried_amount_by_worker_id — worker id -> last seen
 *   carried amount.
 * @param {object} measured_rate_by_worker_id — worker id -> { rate, turn }.
 * @param {object} last_delivery_time_by_worker_id — worker id -> delivery
 *   time in milliseconds.
 * @param {Array<string>} dead_worker_ids — worker ids whose entity is gone.
 * @returns {{assignment_by_worker_id: object,
 *   carried_amount_by_worker_id: object, measured_rate_by_worker_id: object,
 *   last_delivery_time_by_worker_id: object}}
 */
function pruneWorkers(
  assignment_by_worker_id,
  carried_amount_by_worker_id,
  measured_rate_by_worker_id,
  last_delivery_time_by_worker_id,
  dead_worker_ids,
) {
  // dict: worker id -> { resource, source_id, subtype }, pruned copy
  const new_assignment_by_worker_id = { ...assignment_by_worker_id };
  // dict: worker id -> last seen carried amount, pruned copy
  const new_carried_amount_by_worker_id = {
    ...carried_amount_by_worker_id,
  };
  // dict: worker id -> { rate, turn }, pruned copy
  const new_measured_rate_by_worker_id = { ...measured_rate_by_worker_id };
  // dict: worker id -> last delivery time in milliseconds, pruned copy
  const new_last_delivery_time_by_worker_id = {
    ...last_delivery_time_by_worker_id,
  };

  // string: id of a worker that died
  for (const worker_id of dead_worker_ids) {
    delete new_assignment_by_worker_id[worker_id];
    delete new_carried_amount_by_worker_id[worker_id];
    delete new_measured_rate_by_worker_id[worker_id];
    delete new_last_delivery_time_by_worker_id[worker_id];
  }

  return {
    assignment_by_worker_id: new_assignment_by_worker_id,
    carried_amount_by_worker_id: new_carried_amount_by_worker_id,
    measured_rate_by_worker_id: new_measured_rate_by_worker_id,
    last_delivery_time_by_worker_id: new_last_delivery_time_by_worker_id,
  };
}

/**
 * @param {object} carried_amount_by_worker_id — worker id -> last seen
 *   carried amount.
 * @param {object} measured_rate_by_worker_id — worker id -> { rate, turn }.
 * @param {object} last_delivery_time_by_worker_id — worker id -> delivery
 *   time in milliseconds.
 * @param {Array<{worker_id: string, carried_now: number}>} live_workers —
 *   assigned workers that still exist, with their current carried amount.
 * @param {number} time_ms — current simulation time in milliseconds.
 * @param {number} turn — current bot turn, stamped into new rate records.
 * @returns {{carried_amount_by_worker_id: object,
 *   measured_rate_by_worker_id: object,
 *   last_delivery_time_by_worker_id: object}}
 */
function measureGatheringRates(
  carried_amount_by_worker_id,
  measured_rate_by_worker_id,
  last_delivery_time_by_worker_id,
  live_workers,
  time_ms,
  turn,
) {
  // dict: worker id -> last seen carried amount, refreshed copy
  const new_carried_amount_by_worker_id = { ...carried_amount_by_worker_id };
  // dict: worker id -> { rate, turn }, updated copy
  const new_measured_rate_by_worker_id = { ...measured_rate_by_worker_id };
  // dict: worker id -> last delivery time in milliseconds, stamped copy
  const new_last_delivery_time_by_worker_id = {
    ...last_delivery_time_by_worker_id,
  };

  // object { worker_id, carried_now }: one live worker
  for (const worker of live_workers) {
    // string: worker id, dict key
    const worker_id = worker.worker_id;
    // number: current carried amount
    const carried_now = worker.carried_now;
    if (new_carried_amount_by_worker_id[worker_id] > 0 && carried_now === 0) {
      // number: milliseconds since the previous delivery
      const elapsed_ms =
        time_ms - (new_last_delivery_time_by_worker_id[worker_id] ?? time_ms);
      if (elapsed_ms > 0)
        // object: { rate: number, turn: number }
        new_measured_rate_by_worker_id[worker_id] = {
          rate:
            (new_carried_amount_by_worker_id[worker_id] * 1000) / elapsed_ms,
          turn: turn,
        };
      new_last_delivery_time_by_worker_id[worker_id] = time_ms;
    }
    new_carried_amount_by_worker_id[worker_id] = carried_now;
  }

  return {
    carried_amount_by_worker_id: new_carried_amount_by_worker_id,
    measured_rate_by_worker_id: new_measured_rate_by_worker_id,
    last_delivery_time_by_worker_id: new_last_delivery_time_by_worker_id,
  };
}

/**
 * @param {Array<{id: number, template_rates: object}>} workers — idle
 *   gatherers with their template rates.
 * @param {object} committed_rate_by_resource — resource -> sum of rates
 *   already committed.
 * @param {object} free_slots_by_resource — resource -> array of source
 *   records, as in estimateSourceRate.
 * @param {object} weights — resource -> weight.
 * @returns {Array<{worker_id: number, source_id: number}>}
 */
function assignIdleWorkers(
  workers,
  committed_rate_by_resource,
  free_slots_by_resource,
  weights,
) {
  // dict: resource name -> remaining source records (local copies)
  const remaining_slots_by_resource = {};
  // string: resource name
  for (const resource of Object.keys(free_slots_by_resource))
    remaining_slots_by_resource[resource] = free_slots_by_resource[
      resource
    ].map((source) => ({ ...source }));
  // dict: resource name -> running committed rate, including this pass's choices
  const running_rate_by_resource = { ...committed_rate_by_resource };
  // array of { worker_id, source_id }: the assignment decisions
  const assignment_pairs = [];
  // object { id, template_rates }: one idle worker
  for (const worker of workers) {
    // string or undefined: resource picked for this worker
    let best_resource;
    // object or undefined: source record picked for this worker
    let best_source;
    // number: score of the best choice so far
    let best_score = Infinity;
    // string: resource name
    for (const resource of Object.keys(remaining_slots_by_resource)) {
      if (
        !(weights[resource] > 0) ||
        remaining_slots_by_resource[resource].length === 0
      )
        continue;
      // object or undefined: best source of this resource for this worker
      let source;
      // number: its estimated rate
      let best_rate = 0;
      // object: one source record of this resource
      for (const candidate of remaining_slots_by_resource[resource]) {
        // number: estimated rate of this worker on that source
        const rate = estimateSourceRate(worker.template_rates, candidate);
        if (rate > best_rate) {
          best_rate = rate;
          source = candidate;
        }
      }
      if (!source) continue;
      // number: scaled share of this resource after adding the slot
      const score =
        (running_rate_by_resource[resource] + best_rate) / weights[resource];
      if (score < best_score) {
        best_score = score;
        best_resource = resource;
        best_source = source;
      }
    }
    if (!best_source) continue;
    assignment_pairs.push({ worker_id: worker.id, source_id: best_source.id });
    running_rate_by_resource[best_resource] += estimateSourceRate(
      worker.template_rates,
      best_source,
    );
    best_source.gatherer_count += 1;
    if (best_source.gatherer_count >= best_source.max_gatherers)
      remaining_slots_by_resource[best_resource] = remaining_slots_by_resource[
        best_resource
      ].filter((source) => source !== best_source);
  }
  return assignment_pairs;
}

/**
 * The worker pass: the impure layer around the pure functions, reads the
 * simulation (read-only) and emits gather directives; OnUpdate posts them.
 * @param {object} worker_state — { assignment_by_worker_id,
 *   carried_amount_by_worker_id, measured_rate_by_worker_id,
 *   last_delivery_time_by_worker_id }.
 * @param {GameState} game_state — this player's game state, read-only.
 * @param {number} turn — current bot turn, stamped into new rate records.
 * @returns {{state: object, directives: Array<{kind: string,
 *   worker_id: number, source_id: number}>, requests: Array<object>}} the
 *   updated worker_state, the gather directives, and this pass's spending
 *   requests (none for now).
 */
function manageWorkers(worker_state, game_state, turn) {
  // dict: worker id -> { resource, source_id, subtype }
  let assignment_by_worker_id = worker_state.assignment_by_worker_id || {};
  // dict: worker id -> last seen carried amount (number)
  let carried_amount_by_worker_id =
    worker_state.carried_amount_by_worker_id || {};
  // dict: worker id -> { rate: number, turn: number }
  let measured_rate_by_worker_id =
    worker_state.measured_rate_by_worker_id || {};
  // dict: worker id -> last delivery time in milliseconds (number)
  let last_delivery_time_by_worker_id =
    worker_state.last_delivery_time_by_worker_id || {};

  // number: current simulation time in milliseconds
  const time_ms = game_state.getTimeElapsed();

  // A table entry only holds while the worker is alive and busy: an idle
  // worker's gather order has ended, its entry is stale.
  ({
    assignment_by_worker_id,
    carried_amount_by_worker_id,
    measured_rate_by_worker_id,
    last_delivery_time_by_worker_id,
  } = pruneWorkers(
    assignment_by_worker_id,
    carried_amount_by_worker_id,
    measured_rate_by_worker_id,
    last_delivery_time_by_worker_id,
    Object.keys(assignment_by_worker_id).filter((worker_id) => {
      // Entity or undefined: the worker, undefined if it died
      const worker = game_state.getEntityById(+worker_id);
      return !worker || worker.isIdle();
    }),
  ));

  ({
    carried_amount_by_worker_id,
    measured_rate_by_worker_id,
    last_delivery_time_by_worker_id,
  } = measureGatheringRates(
    carried_amount_by_worker_id,
    measured_rate_by_worker_id,
    last_delivery_time_by_worker_id,
    Object.keys(assignment_by_worker_id).map((worker_id) => ({
      worker_id: worker_id,
      carried_now: +(
        (game_state.getEntityById(+worker_id).resourceCarrying() || [])[0]
          ?.amount ?? 0
      ),
    })),
    time_ms,
    turn,
  ));

  // dict: resource name -> committed gather rate (number)
  const committed_rate_by_resource = { food: 0, wood: 0, metal: 0, stone: 0 };
  // [string, object]: worker id and its assignment record
  for (const [worker_id, assignment] of Object.entries(
    assignment_by_worker_id,
  )) {
    // number: measured rate, 0 before the first delivery
    let rate = measured_rate_by_worker_id[worker_id]?.rate;
    if (!rate) {
      // Entity or undefined: the assigned worker
      const worker = game_state.getEntityById(+worker_id);
      if (worker)
        rate = templateRate(
          worker.resourceGatherRates(),
          assignment.subtype,
          assignment.resource,
        );
    }
    committed_rate_by_resource[assignment.resource] += rate || 0;
  }

  // The resource collections are maintained globally by the shared
  // script, no full map scan here.
  // dict: resource name -> array of source records (see estimateSourceRate)
  const free_slots_by_resource = {};
  // string: resource name
  for (const resource of Object.keys(GATHER_WEIGHTS)) {
    // array of source records: free slots of this resource
    const slots = [];
    // Entity: one resource supply
    for (const supply of game_state.getResourceSupplies(resource).values()) {
      // [number, number] or undefined: supply position
      const pos = supply.position();
      // object { generic, specific } or undefined: supply type
      const supply_type = supply.resourceSupplyType();
      if (!pos || !supply_type || supply.resourceSupplyAmount() <= 0) continue;
      // number: gatherer cap of the supply
      const max_gatherers = supply.maxGatherers();
      // number: gatherers currently on it, including en route
      const gatherer_count = supply.resourceSupplyNumGatherers();
      if (max_gatherers <= 0 || gatherer_count >= max_gatherers) continue;
      slots.push({
        id: supply.id(),
        generic: supply_type.generic,
        specific: supply_type.generic + "." + supply_type.specific,
        gatherer_count: gatherer_count,
        max_gatherers: max_gatherers,
        diminishing_return: supply.getDiminishingReturns(),
        measured_rate: 0,
        measured_template_rate: 0,
      });
    }
    free_slots_by_resource[resource] = slots;
  }

  // array of source records: the free slots of one resource
  for (const slots of Object.values(free_slots_by_resource))
    // object: one source record
    for (const source of slots) {
      // number: summed measured rates of workers on this source
      let measured_sum = 0;
      // number: summed template rates of those workers
      let template_sum = 0;
      // number: how many workers had a measurement
      let measured_count = 0;
      // [string, object]: worker id and its assignment record
      for (const [worker_id, assignment] of Object.entries(
        assignment_by_worker_id,
      ))
        if (assignment.source_id === source.id) {
          // Entity or undefined: the worker on this source
          const worker = game_state.getEntityById(+worker_id);
          if (!worker) continue;
          // number: template rate of the worker on this source's subtype
          const template_rate = templateRate(
            worker.resourceGatherRates(),
            source.specific,
            source.generic,
          );
          if (
            template_rate > 0 &&
            measured_rate_by_worker_id[worker_id]?.rate
          ) {
            measured_sum += measured_rate_by_worker_id[worker_id].rate;
            template_sum += template_rate;
            measured_count++;
          }
        }
      if (measured_count > 0) {
        source.measured_rate = measured_sum / measured_count;
        source.measured_template_rate = template_sum / measured_count;
      }
    }

  // Sorted by id so the greedy below is deterministic.
  // array of { id: number, template_rates: object }: idle gatherers
  const idle_gatherers = game_state
    .getOwnUnits()
    .toEntityArray()
    .filter(
      (ent) =>
        ent.isGatherer() &&
        ent.isIdle() &&
        ent.position() &&
        assignment_by_worker_id[ent.id()] === undefined,
    )
    .map((ent) => ({
      id: ent.id(),
      template_rates: ent.resourceGatherRates(),
    }))
    .sort((a, b) => a.id - b.id);

  // array of { worker_id, source_id }: pairs to order
  const new_assignments = assignIdleWorkers(
    idle_gatherers,
    committed_rate_by_resource,
    free_slots_by_resource,
    GATHER_WEIGHTS,
  );
  // array of { kind, worker_id, source_id }: gather directives
  const directives = [];
  if (new_assignments.length > 0) {
    // dict: resource name -> how many workers were assigned there this pass
    const assigned_count_by_resource = {};
    // object { worker_id, source_id }: one pair
    for (const pair of new_assignments) {
      // Entity or undefined: worker to order
      const worker = game_state.getEntityById(pair.worker_id);
      // Entity or undefined: source it should gather
      const source = game_state.getEntityById(pair.source_id);
      if (!worker || !source) continue;
      directives.push({
        kind: "gather",
        worker_id: pair.worker_id,
        source_id: pair.source_id,
      });
      // object { generic, specific }: type of the chosen source
      const supply_type = source.resourceSupplyType();
      assignment_by_worker_id[pair.worker_id] = {
        resource: supply_type.generic,
        source_id: pair.source_id,
        subtype: supply_type.generic + "." + supply_type.specific,
      };
      assigned_count_by_resource[supply_type.generic] =
        (assigned_count_by_resource[supply_type.generic] || 0) + 1;
    }
    print(
      `[HARNESS] louis-bot: t=${(time_ms / 60000).toFixed(1)}m assigned ${new_assignments.length} idle ${JSON.stringify(assigned_count_by_resource)}\n`,
    );
  }

  return {
    state: {
      assignment_by_worker_id,
      carried_amount_by_worker_id,
      measured_rate_by_worker_id,
      last_delivery_time_by_worker_id,
    },
    directives: directives,
    requests: [],
  };
}

/**
 * The spending manager, pure. v1 approves every request and dispatches on
 * kind; only "construct" is wired, converted into a construction order in
 * the building layer's vocabulary (no key, cost, or detail). Unfulfilled
 * requests are dropped at end of turn: passes re-emit while the need
 * persists, and must count "already paid for" as "need satisfied".
 * @param {Array<{key: string, kind: string, payload: object,
 *   cost: object, builders: Array<number>, detail: string}>} requests —
 *   the spending requests emitted by every pass this turn.
 * @returns {{construction_orders: Array<{template: string, x: number,
 *   z: number, angle: number, builders: Array<number>}>}}
 */
function manageSpending(requests) {
  // array of { template, x, z, angle, builders }
  const construction_orders = [];
  // object { key, kind, payload, cost, builders, detail }: one request
  for (const request of requests) {
    print(
      `[HARNESS] louis-bot: spending request ${request.key} (${request.kind}): ${request.detail}\n`,
    );
    if (request.kind !== "construct") continue;
    construction_orders.push({
      template: request.payload.template,
      x: request.payload.x,
      z: request.payload.z,
      angle: request.payload.angle,
      builders: request.builders,
    });
    print(
      `[HARNESS] louis-bot: approved ${request.key}, construction order for ${request.payload.template}\n`,
    );
  }
  return { construction_orders };
}

/**
 * Union-find over supplies: two supplies closer than CLUSTER_RADIUS belong
 * to the same cluster, so cluster boundaries follow tree spacing instead of
 * a fixed area. The centroid is weighted by remaining supply so exhausted
 * trees stop pulling the site.
 * @param {Array<{id: number, x: number, z: number, amount: number}>} supplies
 * @returns {Array<{supply_ids: Array<number>, supply_sum: number,
 *   x: number, z: number}>} clusters with supply-weighted centroids.
 */
function clusterSupplies(supplies) {
  // array of { id, x, z, amount }: sorted so the result is deterministic
  const sorted = [...supplies].sort((a, b) => a.id - b.id);
  // array of number: union-find parent per supply index
  const parent = sorted.map((unused, i) => i);

  /**
   * Finds the root of a supply index, compressing the path.
   * @param {number} i — supply index.
   * @returns {number}
   */
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }

  // number: outer supply index
  for (let i = 0; i < sorted.length; i++) {
    // number: inner supply index
    for (let j = i + 1; j < sorted.length; j++) {
      // number: squared distance between the two supplies
      const dist2 =
        (sorted[i].x - sorted[j].x) * (sorted[i].x - sorted[j].x) +
        (sorted[i].z - sorted[j].z) * (sorted[i].z - sorted[j].z);
      if (dist2 > CLUSTER_RADIUS * CLUSTER_RADIUS) continue;
      // number: roots of both supplies
      const root_i = find(i);
      const root_j = find(j);
      if (root_i !== root_j) parent[root_i] = root_j;
    }
  }

  // dict: root index -> { supply_ids, supply_sum, weight_x, weight_z }
  const accumulator_by_root = {};
  // number: supply index
  for (let i = 0; i < sorted.length; i++) {
    // number: root of this supply
    const root = find(i);
    if (!accumulator_by_root[root])
      accumulator_by_root[root] = {
        supply_ids: [],
        supply_sum: 0,
        weight_x: 0,
        weight_z: 0,
      };
    // object: the cluster accumulator
    const accumulator = accumulator_by_root[root];
    accumulator.supply_ids.push(sorted[i].id);
    accumulator.supply_sum += sorted[i].amount;
    accumulator.weight_x += sorted[i].x * sorted[i].amount;
    accumulator.weight_z += sorted[i].z * sorted[i].amount;
  }

  // array of cluster records: the result
  const clusters = [];
  // object: one cluster accumulator
  for (const accumulator of Object.values(accumulator_by_root))
    clusters.push({
      supply_ids: accumulator.supply_ids,
      supply_sum: accumulator.supply_sum,
      x: accumulator.weight_x / accumulator.supply_sum,
      z: accumulator.weight_z / accumulator.supply_sum,
    });
  return clusters;
}

/**
 * Approximates the engine's placement check with the AI-visible grids:
 * every passability cell under the footprint must be free for the
 * building-land class (no obstruction, no water, flat enough) and the
 * center cell must be own territory. The AI grids can lag the engine's by
 * a few turns, so a spot passing here can still be rejected silently;
 * manageDropoffs then retries with the next-best spot.
 * @param {GameState} game_state — this player's game state, read-only.
 * @param {number} x — candidate center.
 * @param {number} z — candidate center.
 * @param {number} half_size — half the footprint side plus margin, meters.
 * @returns {boolean}
 */
function isBuildableSpot(game_state, x, z, half_size) {
  // object: { data, width, height, cellSize }: the pathfinder grid
  const passability = game_state.getPassabilityMap();
  // number: mask of the passability class used for land buildings
  const blocked_mask = game_state.getPassabilityClassMask("building-land");
  // number: longitudinal offset from the candidate center
  for (let dx = -half_size; dx <= half_size; dx += passability.cellSize) {
    // number: latitudinal offset from the candidate center
    for (let dz = -half_size; dz <= half_size; dz += passability.cellSize) {
      // number: cell coordinates in the passability grid
      const cell_x = Math.floor((x + dx) / passability.cellSize);
      const cell_z = Math.floor((z + dz) / passability.cellSize);
      if (
        cell_x < 0 ||
        cell_x >= passability.width ||
        cell_z < 0 ||
        cell_z >= passability.height
      )
        return false;
      // number: cell index
      const cell = cell_x + cell_z * passability.width;
      if (passability.data[cell] & blocked_mask) return false;
    }
  }
  // object: { data, width, height, cellSize }: the territory grid
  const territory = game_state.sharedScript.territoryMap;
  // number: territory cell index of the candidate center
  const territory_cell =
    Math.floor(x / territory.cellSize) +
    Math.floor(z / territory.cellSize) * territory.width;
  if (
    x < 0 ||
    z < 0 ||
    territory_cell < 0 ||
    territory_cell >= territory.data.length
  )
    return false;
  // The low 5 bits hold the owning player id, 0 means unowned.
  return (territory.data[territory_cell] & 0x1f) === game_state.player;
}

/**
 * Ring search around the centroid, nearest valid spot first, so the
 * storehouse lands as close to the trees as placement rules allow.
 * @param {GameState} game_state — this player's game state, read-only.
 * @param {number} cx — cluster centroid.
 * @param {number} cz — cluster centroid.
 * @param {number} half_size — half the footprint side plus margin, meters.
 * @param {Array<{x: number, z: number}>} rejected_positions — spots that
 *   already failed silently; skipped so each retry tries the next-best one.
 * @returns {{x: number, z: number}|undefined}
 */
function findDropoffSpot(game_state, cx, cz, half_size, rejected_positions) {
  // number: distance of the current candidate ring from the centroid
  for (
    let radius = 0;
    radius <= DROPOFF_SEARCH_RADIUS;
    radius += DROPOFF_SEARCH_STEP
  ) {
    // number: how many candidates sit on this ring; 1 for the center
    const steps = radius === 0 ? 1 : 16;
    // number: candidate index on this ring
    for (let step = 0; step < steps; step++) {
      // number: candidate coordinates
      const x = cx + radius * Math.cos((step * 2 * Math.PI) / steps);
      const z = cz + radius * Math.sin((step * 2 * Math.PI) / steps);
      // boolean: whether this spot already failed
      const is_rejected = rejected_positions.some(
        (rejected) =>
          (rejected.x - x) * (rejected.x - x) +
            (rejected.z - z) * (rejected.z - z) <
          1,
      );
      if (is_rejected) continue;
      if (isBuildableSpot(game_state, x, z, half_size))
        return { x: x, z: z };
    }
  }
  return undefined;
}

/**
 * The dropoff pass. Keeps track of attempted spots because construct
 * rejection is silent: a spot that produced no foundation by the next turn
 * is skipped from then on.
 * @param {object} dropoff_state — { attempted, rejected }.
 * @param {object} assignment_by_worker_id — worker id -> { resource,
 *   source_id, subtype }, from the worker pass state.
 * @param {GameState} game_state — this player's game state, read-only.
 * @returns {{state: object, requests: Array<object>}} the updated
 *   dropoff_state and the construct spending requests.
 */
function manageDropoffs(dropoff_state, assignment_by_worker_id, game_state) {
  // array of { id, x, z, amount }: wood supplies worth clustering
  const supplies = [];
  // Entity: one wood supply
  for (const supply of game_state.getResourceSupplies("wood").values()) {
    // [number, number] or undefined: supply position, [x, z]
    const pos = supply.position();
    if (!pos) continue;
    // number: remaining wood on this supply
    const amount = supply.resourceSupplyAmount();
    if (amount <= 0) continue;
    supplies.push({ id: supply.id(), x: pos[0], z: pos[1], amount: amount });
  }
  // array of cluster records
  const clusters = clusterSupplies(supplies);

  // array of { x, z }: own wood dropsites
  const dropsites = [];
  // array of { x, z }: own foundations of any kind
  const foundations = [];
  // Entity: one own structure
  for (const structure of game_state.getOwnStructures().values()) {
    // [number, number] or undefined: structure position, [x, z]
    const pos = structure.position();
    if (!pos) continue;
    // Foundations carry the built template's classes, so storehouse
    // foundations count as coverage too.
    if (structure.hasClass("Storehouse") || structure.hasClass("CivCentre"))
      dropsites.push({ x: pos[0], z: pos[1] });
    if (structure.foundationProgress() !== undefined)
      foundations.push({ x: pos[0], z: pos[1] });
  }

  // array of { x, z }: spots ordered on the previous play turn
  const previously_attempted = dropoff_state.attempted || [];
  // array of { x, z }: spots that never produced a foundation
  const rejected = [...(dropoff_state.rejected || [])];
  // object { x, z }: one previously attempted spot
  for (const attempted_spot of previously_attempted) {
    // boolean: whether a foundation now stands on this spot
    const placed = foundations.some(
      (foundation) =>
        (foundation.x - attempted_spot.x) * (foundation.x - attempted_spot.x) +
          (foundation.z - attempted_spot.z) * (foundation.z - attempted_spot.z) <
        1,
    );
    if (!placed) rejected.push(attempted_spot);
  }

  // dict: source id -> array of worker ids assigned to it
  const worker_ids_by_source_id = {};
  // [string, object]: worker id and its assignment record
  for (const [worker_id, assignment] of Object.entries(
    assignment_by_worker_id,
  )) {
    if (!worker_ids_by_source_id[assignment.source_id])
      worker_ids_by_source_id[assignment.source_id] = [];
    worker_ids_by_source_id[assignment.source_id].push(+worker_id);
  }

  // string: this civ's storehouse template name
  const template_name = "structures/" + game_state.getPlayerCiv() + "/storehouse";
  // Template or null: the storehouse template
  const storehouse_template = game_state.getTemplate(template_name);
  if (!storehouse_template) return { state: dropoff_state, requests: [] };
  // object: resource name -> amount, only non-zero costs
  const storehouse_cost = storehouse_template.cost();
  // number: half the footprint side plus a margin, meters
  const half_size =
    Math.max(
      +storehouse_template.get("Obstruction/Static/@width"),
      +storehouse_template.get("Obstruction/Static/@depth"),
    ) /
      2 +
    1;
  // number: wood in stock
  const wood_stock = game_state.playerData.resourceCounts.wood;

  // array of spending request objects
  const requests = [];
  // array of { x, z }: spots ordered this turn
  const attempted = [];
  // object: one cluster record
  for (const cluster of clusters) {
    if (cluster.supply_sum < MIN_CLUSTER_SUPPLY) continue;
    // array of number: ids of workers gathering in this cluster
    const builders = [];
    // number: one supply id of the cluster
    for (const supply_id of cluster.supply_ids)
      // number: one worker id assigned to this supply
      for (const worker_id of worker_ids_by_source_id[supply_id] || [])
        builders.push(worker_id);
    if (builders.length === 0) continue;
    // boolean: whether a dropsite already serves this cluster
    const covered = dropsites.some(
      (dropsite) =>
        (dropsite.x - cluster.x) * (dropsite.x - cluster.x) +
          (dropsite.z - cluster.z) * (dropsite.z - cluster.z) <
        DROPOFF_COVERAGE_RADIUS * DROPOFF_COVERAGE_RADIUS,
    );
    if (covered) continue;
    // The engine charges the real stock at command processing and rejects
    // silently when it is short, so do not emit what cannot be afforded.
    if (wood_stock < storehouse_cost.wood) continue;
    // object { x, z } or undefined: the nearest buildable spot
    const spot = findDropoffSpot(
      game_state,
      cluster.x,
      cluster.z,
      half_size,
      rejected,
    );
    if (!spot) continue;
    requests.push({
      key: "dropsite:wood:cluster-" + cluster.supply_ids[0],
      kind: "construct",
      payload: {
        template: template_name,
        x: spot.x,
        z: spot.z,
        angle: 0,
      },
      cost: storehouse_cost,
      builders: builders,
      detail:
        "woodline dropsite for a cluster of " +
        cluster.supply_ids.length +
        " supplies at (" +
        cluster.x.toFixed(0) +
        ", " +
        cluster.z.toFixed(0) +
        ")",
    });
    attempted.push({ x: spot.x, z: spot.z });
  }
  return {
    state: { attempted: attempted, rejected: rejected },
    requests: requests,
  };
}

/**
 * Deliberately minimal: no builder fallback and no replacement of dead
 * builders, because a proper building manager will be designed later.
 * Consequence to know when reading the logs: a foundation whose builders
 * all die stays unfinished forever, since the emitting pass counts the
 * foundation as coverage and stops re-emitting.
 * @param {object} construction_state — { builder_ids_by_foundation_id,
 *   pending_placements }.
 * @param {Array<{template: string, x: number, z: number, angle: number,
 *   builders: Array<number>}>} construction_orders — orders approved by the
 *   spending manager this turn.
 * @param {GameState} game_state — this player's game state, read-only.
 * @returns {{state: object, directives: Array<object>}}
 */
function manageConstruction(
  construction_state,
  construction_orders,
  game_state,
) {
  // dict: foundation id -> array of builder ids
  const builder_ids_by_foundation_id = {
    ...(construction_state.builder_ids_by_foundation_id || {}),
  };
  // array of { template, x, z, angle, builders }: placements ordered on the
  // previous play turn, awaiting their foundation; the construct command
  // takes effect one turn later, so matching happens on this turn at the
  // earliest
  const unmatched_placements = [
    ...(construction_state.pending_placements || []),
  ];
  // array of directive objects
  const directives = [];

  // Entity: one own structure
  for (const structure of game_state.getOwnStructures().values()) {
    if (structure.foundationProgress() === undefined) continue;
    // number: foundation entity id
    const foundation_id = structure.id();
    if (builder_ids_by_foundation_id[foundation_id] !== undefined) continue;
    // [number, number] or undefined: foundation position, [x, z]
    const pos = structure.position();
    if (!pos) continue;
    // number: index into unmatched_placements of the order that spawned
    // this foundation, -1 if none
    let match_index = -1;
    // number: loop index into unmatched_placements
    for (let i = 0; i < unmatched_placements.length; i++) {
      // object { template, x, z, angle, builders }: one pending placement
      const pending = unmatched_placements[i];
      if (structure.templateName() !== "foundation|" + pending.template)
        continue;
      // number: squared horizontal distance to the ordered position
      const dist2 =
        (pos[0] - pending.x) * (pos[0] - pending.x) +
        (pos[1] - pending.z) * (pos[1] - pending.z);
      if (dist2 > 1) continue;
      match_index = i;
      break;
    }
    if (match_index === -1) continue;
    builder_ids_by_foundation_id[foundation_id] =
      unmatched_placements[match_index].builders;
    unmatched_placements.splice(match_index, 1);
    print(
      `[HARNESS] louis-bot: foundation ${foundation_id} matched, ${builder_ids_by_foundation_id[foundation_id].length} builders assigned\n`,
    );
  }

  // [string, Array<number>]: foundation id and its builder ids
  for (const [foundation_id, builder_ids] of Object.entries(
    builder_ids_by_foundation_id,
  )) {
    // Entity or undefined: the foundation
    const foundation = game_state.getEntityById(+foundation_id);
    // A missing entity means destroyed, undefined progress means completed.
    if (!foundation || foundation.foundationProgress() === undefined) {
      delete builder_ids_by_foundation_id[foundation_id];
      continue;
    }
    // number: one builder id
    for (const builder_id of builder_ids) {
      if (!game_state.getEntityById(builder_id)) continue;
      directives.push({
        kind: "repair",
        builder_id: builder_id,
        foundation_id: +foundation_id,
      });
    }
  }

  // array of { template, x, z, angle, builders }: this turn's placements,
  // matched against foundations on a later turn
  const new_pending_placements = [];
  // object { template, x, z, angle, builders }: one approved order
  for (const order of construction_orders) {
    // The construct command is posted from an entity, so an order without
    // builders cannot even place its foundation.
    if (order.builders.length === 0) {
      print(
        `[HARNESS] louis-bot: construction order for ${order.template} has no builders, skipped\n`,
      );
      continue;
    }
    directives.push({
      kind: "construct",
      template: order.template,
      x: order.x,
      z: order.z,
      angle: order.angle,
      builder_id: order.builders[0],
    });
    new_pending_placements.push(order);
    print(
      `[HARNESS] louis-bot: placing ${order.template} at (${order.x.toFixed(1)}, ${order.z.toFixed(1)}) with ${order.builders.length} builders\n`,
    );
  }

  return {
    state: {
      builder_ids_by_foundation_id: builder_ids_by_foundation_id,
      pending_placements: new_pending_placements,
    },
    directives: directives,
  };
}

/**
 * @param {GameState} gameState — this player's game state.
 */
LouisBot.prototype.CustomInit = function (gameState) {
  print(`[HARNESS] louis-bot: loaded for player ${this.player}\n`);
};

/**
 * The top of the call stack: reads and writes the bot state, each concern
 * lives in its own pass below, and every engine command is posted here.
 * No parameters.
 */
LouisBot.prototype.OnUpdate = function () {
  // GameState: this player's game state
  const game_state = this.gameState;
  if (game_state.playerData.state !== "active") return;

  if (this.turn % PLAY_EVERY_N_TURN !== 0) {
    this.turn++;
    return;
  }

  // number: this bot's turn counter
  const turn = this.turn;
  // object or undefined: state stashed by Deserialize
  const saved_state = this.saved_state;
  // object: { assignment_by_worker_id, carried_amount_by_worker_id,
  //   measured_rate_by_worker_id, last_delivery_time_by_worker_id }
  const worker_state = this.worker_state ?? saved_state?.worker_state ?? {};
  // object: { builder_ids_by_foundation_id, pending_placements }
  const construction_state =
    this.construction_state ?? saved_state?.construction_state ?? {};
  // object: { attempted, rejected }
  const dropoff_state = this.dropoff_state ?? saved_state?.dropoff_state ?? {};

  // object: { state, directives, requests }: the worker pass result
  const worker_result = manageWorkers(worker_state, game_state, turn);
  this.worker_state = worker_result.state;

  // object: { state, requests }: the dropoff pass result
  const dropoff_result = manageDropoffs(
    dropoff_state,
    worker_result.state.assignment_by_worker_id,
    game_state,
  );
  this.dropoff_state = dropoff_result.state;

  // array of spending request objects: from every pass
  const requests = [...worker_result.requests, ...dropoff_result.requests];
  // object { construction_orders: array }: the spending manager result
  const spending_result = manageSpending(requests);

  // object: { state, directives }: the building manager result
  const construction_result = manageConstruction(
    construction_state,
    spending_result.construction_orders,
    game_state,
  );
  this.construction_state = construction_result.state;

  // array of directive objects: from every pass and executor
  const directives = [
    ...worker_result.directives,
    ...construction_result.directives,
  ];
  // object: one directive
  for (const directive of directives) {
    if (directive.kind === "gather") {
      // Entity or undefined: worker to order
      const worker = game_state.getEntityById(directive.worker_id);
      // Entity or undefined: source it should gather
      const source = game_state.getEntityById(directive.source_id);
      if (worker && source) worker.gather(source);
    } else if (directive.kind === "construct") {
      // Entity or undefined: the builder posting the placement
      const poster = game_state.getEntityById(directive.builder_id);
      if (poster)
        poster.construct(
          directive.template,
          directive.x,
          directive.z,
          directive.angle,
        );
    } else if (directive.kind === "repair") {
      // Entity or undefined: the builder
      const builder = game_state.getEntityById(directive.builder_id);
      // Entity or undefined: the foundation to raise
      const foundation = game_state.getEntityById(directive.foundation_id);
      if (builder && foundation) builder.repair(foundation);
    }
  }

  this.turn = turn + 1;
};

/**
 * Plain structured-cloneable data only, no live Entity references.
 * @returns {object} the bot state to persist in saved games.
 */
LouisBot.prototype.Serialize = function () {
  return {
    worker_state: this.worker_state,
    construction_state: this.construction_state,
    dropoff_state: this.dropoff_state,
  };
};

/**
 * The state is only stashed here; OnUpdate restores it on the first update
 * after load.
 * @param {object} data — plain object returned by Serialize.
 * @param {SharedScript} sharedScript — the shared script instance.
 */
LouisBot.prototype.Deserialize = function (data, sharedScript) {
  this.saved_state = data || {};
  this.isDeserialized = true;
};
