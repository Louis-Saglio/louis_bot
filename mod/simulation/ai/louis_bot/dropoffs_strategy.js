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

function clusterSupplies(supplies) {
  // array of { id, x, z, amount }
  const sorted = [...supplies].sort((a, b) => a.id - b.id);
  // array of number: union-find parent per supply index
  const parent = sorted.map((unused, i) => i);

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

  // array of cluster records
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

function isBuildableSpot(game_state, x, z, half_size) {
  // object: { data, width, height, cellSize }
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
  // object: { data, width, height, cellSize }
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
  return (territory.data[territory_cell] & 0x1f) === game_state.player;
}

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

export function applyDropoffsStrategy(
  dropoff_state,
  assignment_by_worker_id,
  game_state,
) {
  // array of { id, x, z, amount }
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

  // array of { x, z }
  const dropsites = [];
  // array of { x, z }
  const foundations = [];
  // Entity: one own structure
  for (const structure of game_state.getOwnStructures().values()) {
    // [number, number] or undefined: structure position, [x, z]
    const pos = structure.position();
    if (!pos) continue;
    if (structure.hasClass("Storehouse") || structure.hasClass("CivCentre"))
      dropsites.push({ x: pos[0], z: pos[1] });
    if (structure.foundationProgress() !== undefined)
      foundations.push({ x: pos[0], z: pos[1] });
  }

  // array of { x, z }
  const previously_attempted = dropoff_state.attempted || [];
  // array of { x, z }
  const rejected = [...(dropoff_state.rejected || [])];
  // object: { x, z }
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

  // dict: source id -> array of worker ids
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
  // Template or null
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
  // array of { x, z }
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
    if (wood_stock < storehouse_cost.wood) continue;
    // object: { x, z } or undefined
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
