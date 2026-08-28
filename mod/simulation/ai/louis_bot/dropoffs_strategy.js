// number: meters; a chopped tree is covered when a wood dropsite, built or
// foundation, sits this close to it, and the placement search wanders this
// far from the tree
const DROPOFF_RADIUS = 40;
// number: meters; step between candidate rings in the placement search
const DROPOFF_SEARCH_STEP = 2;
// number: candidate spots per search ring
const DROPOFF_SEARCH_STEPS_PER_RING = 16;

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
      // number: cell index in the passability grid
      const cell = cell_x + cell_z * passability.width;
      if (passability.data[cell] & blocked_mask) return false;
    }
  }
  // object: { data, width, cellSize }
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

function findDropoffSpot(game_state, tree, half_size, rejected) {
  // number: distance of the current candidate ring from the tree
  for (let radius = 0; radius <= DROPOFF_RADIUS; radius += DROPOFF_SEARCH_STEP) {
    // number: how many candidates sit on this ring; 1 for the center
    const steps = radius === 0 ? 1 : DROPOFF_SEARCH_STEPS_PER_RING;
    // number: candidate index on this ring
    for (let step = 0; step < steps; step++) {
      // number: candidate coordinates
      const x = tree.x + radius * Math.cos((step * 2 * Math.PI) / steps);
      const z = tree.z + radius * Math.sin((step * 2 * Math.PI) / steps);
      // boolean: whether this spot already failed
      const is_rejected = rejected.some(
        (rejected_spot) =>
          (rejected_spot.x - x) * (rejected_spot.x - x) +
            (rejected_spot.z - z) * (rejected_spot.z - z) <
          1,
      );
      if (is_rejected) continue;
      if (isBuildableSpot(game_state, x, z, half_size)) return { x: x, z: z };
    }
  }
  return undefined;
}

export function applyDropoffsStrategy(dropoff_state, game_state) {
  // dict: wood supply id -> { id, x, z }, for order target lookup
  const supply_by_id = {};
  // Entity: one wood supply
  for (const supply of game_state.getResourceSupplies("wood").values()) {
    // [number, number] or undefined: supply position, [x, z]
    const pos = supply.position();
    if (!pos || supply.resourceSupplyAmount() <= 0) continue;
    // object: { id, x, z }
    const record = { id: supply.id(), x: pos[0], z: pos[1] };
    supply_by_id[record.id] = record;
  }

  // array of { supply, choppers }: wood supplies being chopped, in
  // deterministic order, one entry per tree however many choppers it has
  const chopped = [];
  // Entity: one own unit
  for (const unit of game_state.getOwnUnits().toEntityArray()) {
    // array of order data objects: the unit's order queue
    const orders = unit.unitAIOrderData();
    if (!orders || orders.length === 0) continue;
    // number or undefined: entity id the current order targets
    const target_id = orders[0].target;
    // object or undefined: the wood supply under this order, if any
    const supply = supply_by_id[target_id];
    if (supply === undefined) continue;
    // object or undefined: this tree's entry in the chopped list
    let entry;
    // object: one chopped-tree entry
    for (const candidate of chopped)
      if (candidate.supply.id === supply.id) entry = candidate;
    if (entry === undefined) {
      entry = { supply: supply, choppers: [] };
      chopped.push(entry);
    }
    entry.choppers.push(unit.id());
  }
  chopped.sort((a, b) => a.supply.id - b.supply.id);

  // array of { x, z }: wood dropsites, built or foundation
  const dropsites = [];
  // array of { x, z }: foundations of any kind, for attempt matching
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

  // array of { x, z }
  const previously_attempted = dropoff_state.attempted || [];
  // array of { x, z }: blacklisted spots, kept only while still unbuildable
  // so territory growth or cleared obstructions give them another chance
  const rejected = (dropoff_state.rejected || []).filter(
    (spot) => !isBuildableSpot(game_state, spot.x, spot.z, half_size),
  );
  // object: { x, z }
  for (const attempted_spot of previously_attempted) {
    // boolean: whether a foundation now stands on this spot
    const placed = foundations.some(
      (foundation) =>
        (foundation.x - attempted_spot.x) * (foundation.x - attempted_spot.x) +
          (foundation.z - attempted_spot.z) * (foundation.z - attempted_spot.z) <
        1,
    );
    // A missing foundation on a buildable spot means placement was not the
    // problem (stock shortage, silent engine rejection), so only unbuildable
    // spots are blacklisted
    if (
      !placed &&
      !isBuildableSpot(
        game_state,
        attempted_spot.x,
        attempted_spot.z,
        half_size,
      )
    )
      rejected.push(attempted_spot);
  }

  // array of spending request objects; at most one per turn
  const requests = [];
  // array of { x, z }
  const attempted = [];
  // object: one chopped-tree entry; stop after the first emitted request
  for (const entry of chopped) {
    // boolean: whether a dropsite already serves this tree
    const covered = dropsites.some(
      (dropsite) =>
        (dropsite.x - entry.supply.x) * (dropsite.x - entry.supply.x) +
          (dropsite.z - entry.supply.z) * (dropsite.z - entry.supply.z) <
        DROPOFF_RADIUS * DROPOFF_RADIUS,
    );
    if (covered) continue;
    // object: { x, z } or undefined
    const spot = findDropoffSpot(
      game_state,
      entry.supply,
      half_size,
      rejected,
    );
    if (!spot) continue;
    requests.push({
      key: "dropsite:wood:tree-" + entry.supply.id,
      kind: "construct",
      priority: 3,
      payload: {
        template: template_name,
        x: spot.x,
        z: spot.z,
        angle: 0,
      },
      cost: storehouse_cost,
      builders: entry.choppers,
      detail:
        "woodline dropsite for " +
        entry.choppers.length +
        " choppers on tree " +
        entry.supply.id,
    });
    attempted.push({ x: spot.x, z: spot.z });
    break;
  }
  return {
    state: { attempted: attempted, rejected: rejected },
    requests: requests,
  };
}
