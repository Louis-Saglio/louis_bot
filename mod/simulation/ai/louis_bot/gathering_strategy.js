// dict: resource name -> weight (number)
const GATHER_WEIGHTS = { food: 0.5, wood: 0.5, metal: 0, stone: 0 };

function templateRate(rates, subtype, generic_type) {
  if (!rates) return 0;
  return +rates[subtype] || +rates[generic_type] || 0;
}

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

function pruneWorkers(
  assignment_by_worker_id,
  carried_amount_by_worker_id,
  measured_rate_by_worker_id,
  last_delivery_time_by_worker_id,
  dead_worker_ids,
) {
  // dict: worker id -> { resource, source_id, subtype }
  const new_assignment_by_worker_id = { ...assignment_by_worker_id };
  // dict: worker id -> last seen carried amount (number)
  const new_carried_amount_by_worker_id = {
    ...carried_amount_by_worker_id,
  };
  // dict: worker id -> { rate, turn }
  const new_measured_rate_by_worker_id = { ...measured_rate_by_worker_id };
  // dict: worker id -> last delivery time in milliseconds (number)
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

function measureGatheringRates(
  carried_amount_by_worker_id,
  measured_rate_by_worker_id,
  last_delivery_time_by_worker_id,
  live_workers,
  time_ms,
  turn,
) {
  // dict: worker id -> last seen carried amount (number)
  const new_carried_amount_by_worker_id = { ...carried_amount_by_worker_id };
  // dict: worker id -> { rate, turn }
  const new_measured_rate_by_worker_id = { ...measured_rate_by_worker_id };
  // dict: worker id -> last delivery time in milliseconds (number)
  const new_last_delivery_time_by_worker_id = {
    ...last_delivery_time_by_worker_id,
  };

  // object: { worker_id, carried_now }
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

function assignIdleWorkers(
  workers,
  committed_rate_by_resource,
  free_slots_by_resource,
  weights,
) {
  // dict: resource name -> remaining source records
  const remaining_slots_by_resource = {};
  // string: resource name
  for (const resource of Object.keys(free_slots_by_resource))
    remaining_slots_by_resource[resource] = free_slots_by_resource[
      resource
    ].map((source) => ({ ...source }));
  // dict: resource name -> running committed rate (number)
  const running_rate_by_resource = { ...committed_rate_by_resource };
  // array of { worker_id, source_id }
  const assignment_pairs = [];
  // object: { id, template_rates }
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

export function applyGatheringStrategy(gathering_state, game_state, turn) {
  // dict: worker id -> { resource, source_id, subtype }
  let assignment_by_worker_id = gathering_state.assignment_by_worker_id || {};
  // dict: worker id -> last seen carried amount (number)
  let carried_amount_by_worker_id =
    gathering_state.carried_amount_by_worker_id || {};
  // dict: worker id -> { rate: number, turn: number }
  let measured_rate_by_worker_id =
    gathering_state.measured_rate_by_worker_id || {};
  // dict: worker id -> last delivery time in milliseconds (number)
  let last_delivery_time_by_worker_id =
    gathering_state.last_delivery_time_by_worker_id || {};

  // number: current simulation time in milliseconds
  const time_ms = game_state.getTimeElapsed();

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
      // Entity or undefined
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
      // Entity or undefined
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

  // dict: resource name -> array of source records
  const free_slots_by_resource = {};
  // string: resource name
  for (const resource of Object.keys(GATHER_WEIGHTS)) {
    // array of source records
    const slots = [];
    // Entity: one resource supply
    for (const supply of game_state.getResourceSupplies(resource).values()) {
      // [number, number] or undefined: supply position
      const pos = supply.position();
      // object: { generic, specific } or undefined
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

  // array of source records
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
          // Entity or undefined
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

  // array of { id: number, template_rates: object }
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

  // array of { worker_id, source_id }
  const new_assignments = assignIdleWorkers(
    idle_gatherers,
    committed_rate_by_resource,
    free_slots_by_resource,
    GATHER_WEIGHTS,
  );
  // array of { kind, worker_id, source_id }
  const directives = [];
  if (new_assignments.length > 0) {
    // dict: resource name -> how many workers were assigned there this pass (number)
    const assigned_count_by_resource = {};
    // object: { worker_id, source_id }
    for (const pair of new_assignments) {
      // Entity or undefined
      const worker = game_state.getEntityById(pair.worker_id);
      // Entity or undefined
      const source = game_state.getEntityById(pair.source_id);
      if (!worker || !source) continue;
      directives.push({
        kind: "gather",
        worker_id: pair.worker_id,
        source_id: pair.source_id,
      });
      // object: { generic, specific }
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
