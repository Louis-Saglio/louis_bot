// dict: resource name -> weight (number)
const GATHER_WEIGHTS = { food: 0.5, wood: 0.5, metal: 0, stone: 0 };
// number: meters added to every enemy threat radius, covering the gatherer
// standing beside its source and enemy movement between bot turns
const DANGER_MARGIN = 10;

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

function buildTerritoryGrid(game_state) {
  // object: { data, width, height, cellSize }: territory owner per tile,
  // owner id in the low 5 bits
  const territory = game_state.sharedScript.territoryMap;
  // Int32Array: distance in tiles from each tile to the nearest
  // own-territory tile, 0 on own territory, -1 while unreached
  const distance = new Int32Array(territory.data.length);
  // array of tile indices: breadth-first frontier, seeded with own territory
  const frontier = [];
  // number: tile index
  for (let cell = 0; cell < territory.data.length; cell++) {
    if ((territory.data[cell] & 0x1f) === game_state.player) frontier.push(cell);
    else distance[cell] = -1;
  }
  // number: read cursor into the frontier, which grows during the walk
  for (let head = 0; head < frontier.length; head++) {
    // number: tile index being expanded
    const cell = frontier[head];
    // number: tile coordinates of the expanded cell
    const x = cell % territory.width;
    const z = Math.floor(cell / territory.width);
    // [number, number]: one 4-neighborhood offset
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      // number: neighbor tile coordinates
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nx >= territory.width || nz < 0 || nz >= territory.height)
        continue;
      // number: neighbor tile index
      const next = nx + nz * territory.width;
      if (distance[next] !== -1) continue;
      distance[next] = distance[cell] + 1;
      frontier.push(next);
    }
  }
  return { territory: territory, distance: distance };
}

function sampleTerritory(grid, x, z) {
  // number: tile coordinates of the world position, clamped to the grid
  const tile_x = Math.min(
    Math.max(Math.floor(x / grid.territory.cellSize), 0),
    grid.territory.width - 1,
  );
  const tile_z = Math.min(
    Math.max(Math.floor(z / grid.territory.cellSize), 0),
    grid.territory.height - 1,
  );
  // number: tile index
  const cell = tile_x + tile_z * grid.territory.width;
  return {
    // number: player id owning this tile, 0 when unowned
    owner: grid.territory.data[cell] & 0x1f,
    // number: tiles from this tile to the nearest own-territory tile
    distance: grid.distance[cell],
  };
}

function buildThreatList(game_state) {
  // array of { x, z, radius }: enemy positions with the radius within which
  // they would attack a gatherer
  const threats = [];
  // Entity: one enemy entity
  for (const enemy of game_state.getEnemyEntities().toEntityArray()) {
    // gaia is a diplomatic enemy but out of scope as a threat
    if (enemy.owner() === 0) continue;
    // [number, number] or undefined: enemy position
    const pos = enemy.position();
    if (!pos || enemy.foundationProgress() !== undefined) continue;
    // number: meters within which this enemy attacks a gatherer
    let radius = 0;
    if (enemy.hasDefensiveFire()) {
      // static defenses shoot at anything within arrow range
      // string: one attack type
      for (const type of enemy.attackTypes() || [])
        radius = Math.max(radius, enemy.attackRange(type) || 0);
    } else if ((enemy.attackTypes() || []).length > 0) {
      // mobile units chase anything they see
      radius = enemy.visionRange() || 0;
    }
    if (radius <= 0) continue;
    threats.push({ x: pos[0], z: pos[1], radius: radius + DANGER_MARGIN });
  }
  return threats;
}

function isDangerous(threats, x, z) {
  // object: { x, z, radius }
  for (const threat of threats) {
    // number: axis offsets between the threat and the position
    const dx = threat.x - x;
    const dz = threat.z - z;
    if (dx * dx + dz * dz <= threat.radius * threat.radius) return true;
  }
  return false;
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
  fallback_by_resource,
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
      if (fallback_by_resource[resource]) {
        // fallback: nearest-to-territory wins; the rate only proves the
        // worker can gather the source and feeds the cross-resource score
        // object: one source record of this resource
        for (const candidate of remaining_slots_by_resource[resource]) {
          // number: plain template rate of this worker on that source
          const rate = templateRate(
            worker.template_rates,
            candidate.specific,
            candidate.generic,
          );
          if (rate <= 0) continue;
          if (
            !source ||
            candidate.distance < source.distance ||
            (candidate.distance === source.distance && candidate.id < source.id)
          ) {
            source = candidate;
            best_rate = rate;
          }
        }
      } else {
        // object: one source record of this resource
        for (const candidate of remaining_slots_by_resource[resource]) {
          // number: estimated rate of this worker on that source
          const rate = estimateSourceRate(worker.template_rates, candidate);
          if (rate > best_rate) {
            best_rate = rate;
            source = candidate;
          }
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

  // array of number: unit ids this strategy owns; the compromiser writes
  // this bucket between turns, gathering never scans the engine for units
  const owned_unit_ids = Object.values(
    gathering_state.owned_unit_ids_by_priority || {},
  ).flat();
  // array of number: owned unit ids still alive
  const live_owned_ids = [];
  // array of string: owned unit ids whose entity is gone
  const dead_worker_ids = [];
  // number: one owned unit id
  for (const unit_id of owned_unit_ids) {
    if (game_state.getEntityById(unit_id)) live_owned_ids.push(unit_id);
    else dead_worker_ids.push(String(unit_id));
  }

  // number: current simulation time in milliseconds
  const time_ms = game_state.getTimeElapsed();

  // object: { territory, distance }: owner grid plus per-tile distance in
  // tiles to the nearest own-territory tile
  const territory_grid = buildTerritoryGrid(game_state);
  // array of { x, z, radius }: enemy positions with the radius within which
  // they would attack a gatherer
  const threats = buildThreatList(game_state);

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
      // object: { owner, distance }: territory info of the supply's tile
      const tile = sampleTerritory(territory_grid, pos[0], pos[1]);
      slots.push({
        id: supply.id(),
        generic: supply_type.generic,
        specific: supply_type.generic + "." + supply_type.specific,
        gatherer_count: gatherer_count,
        max_gatherers: max_gatherers,
        diminishing_return: supply.getDiminishingReturns(),
        measured_rate: 0,
        measured_template_rate: 0,
        // number: player id owning the supply's tile, 0 when unowned
        owner: tile.owner,
        // number: tiles from the supply to the nearest own-territory tile
        distance: tile.distance,
        // boolean: whether an enemy would attack a gatherer there
        dangerous: isDangerous(threats, pos[0], pos[1]),
      });
    }
    free_slots_by_resource[resource] = slots;
  }

  // dict: resource name -> bool; true when no safe in-territory supply has a
  // free slot, in which case assignment falls back to safe neutral supplies
  // nearest the territory and ignores gather-rate optimization
  const fallback_by_resource = {};
  // string: resource name
  for (const resource of Object.keys(free_slots_by_resource)) {
    // array of source records: safe supplies inside own territory
    const local = free_slots_by_resource[resource].filter(
      (source) => source.owner === game_state.player && !source.dangerous,
    );
    if (local.length > 0) {
      free_slots_by_resource[resource] = local;
      fallback_by_resource[resource] = false;
    } else {
      free_slots_by_resource[resource] = free_slots_by_resource[resource].filter(
        (source) => source.owner === 0 && !source.dangerous,
      );
      fallback_by_resource[resource] = true;
    }
  }

  // array of worker ids (string): assignments to drop
  const dropped_ids = [];
  // array of worker ids (string): alive, non-idle workers pulled off a
  // source that turned dangerous or left the eligible set
  const recalled_ids = [];
  // string: worker id, dict key
  for (const worker_id of Object.keys(assignment_by_worker_id)) {
    // Entity or undefined
    const worker = game_state.getEntityById(+worker_id);
    if (!worker || worker.isIdle()) {
      dropped_ids.push(worker_id);
      continue;
    }
    // object: { resource, source_id, subtype }
    const assignment = assignment_by_worker_id[worker_id];
    // Entity or undefined
    const source = game_state.getEntityById(assignment.source_id);
    // [number, number] or undefined: source position
    const pos = source ? source.position() : undefined;
    if (!pos || source.resourceSupplyAmount() <= 0) {
      // dead or depleted source: the engine idles the worker by itself
      dropped_ids.push(worker_id);
      continue;
    }
    // object: { owner, distance }: territory info of the source's tile
    const tile = sampleTerritory(territory_grid, pos[0], pos[1]);
    // boolean: whether the source still qualifies under the current rules
    const eligible =
      !isDangerous(threats, pos[0], pos[1]) &&
      (tile.owner === game_state.player ||
        (fallback_by_resource[assignment.resource] && tile.owner === 0));
    if (!eligible) {
      dropped_ids.push(worker_id);
      recalled_ids.push(worker_id);
    }
  }

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
    dropped_ids.concat(dead_worker_ids),
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

  // array of { id: number, template_rates: object }: owned workers needing a
  // source, idle ones plus those recalled from ineligible sources; borrowed
  // builders are not idle, so they keep building undisturbed
  const idle_gatherers = [];
  // number: one owned unit id, alive by construction of live_owned_ids
  for (const unit_id of live_owned_ids) {
    // Entity: the owned unit
    const ent = game_state.getEntityById(unit_id);
    if (
      !ent.isGatherer() ||
      !ent.isIdle() ||
      !ent.position() ||
      assignment_by_worker_id[unit_id] !== undefined
    )
      continue;
    idle_gatherers.push({
      id: unit_id,
      template_rates: ent.resourceGatherRates(),
    });
  }
  // string: recalled worker id
  for (const worker_id of recalled_ids) {
    // Entity or undefined: alive by construction of recalled_ids
    const worker = game_state.getEntityById(+worker_id);
    if (!worker || !worker.position()) continue;
    idle_gatherers.push({
      id: worker.id(),
      template_rates: worker.resourceGatherRates(),
    });
  }
  idle_gatherers.sort((a, b) => a.id - b.id);

  // array of { worker_id, source_id }
  const new_assignments = assignIdleWorkers(
    idle_gatherers,
    committed_rate_by_resource,
    free_slots_by_resource,
    GATHER_WEIGHTS,
    fallback_by_resource,
  );
  // array of { kind, worker_id, source_id }
  const directives = [];
  // set of worker ids (number) that received a source this pass
  const reassigned_ids = new Set();
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
      reassigned_ids.add(pair.worker_id);
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
  // string: recalled worker id; a recalled worker that got no new source
  // must not keep walking to its old one
  for (const worker_id of recalled_ids)
    if (!reassigned_ids.has(+worker_id))
      directives.push({ kind: "stop", worker_id: +worker_id });

  return {
    state: {
      assignment_by_worker_id,
      // dict: priority -> ids of the units this strategy owns at that
      // priority; the bucket carries through borrowed builders and freshly
      // granted units, it is not derived from the assignment detail above
      owned_unit_ids_by_priority: {
        1: live_owned_ids.sort((a, b) => a - b),
      },
      carried_amount_by_worker_id,
      measured_rate_by_worker_id,
      last_delivery_time_by_worker_id,
    },
    directives: directives,
    requests: [],
  };
}
