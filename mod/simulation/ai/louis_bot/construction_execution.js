export function executeConstruction(
  construction_state,
  construction_orders,
  game_state,
) {
  // dict: foundation id -> array of builder ids
  const builder_ids_by_foundation_id = {
    ...(construction_state.builder_ids_by_foundation_id || {}),
  };
  // array of { template, x, z, angle, builders }
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
    // number: index into unmatched_placements of the matching order, -1 if none
    let match_index = -1;
    // number: loop index into unmatched_placements
    for (let i = 0; i < unmatched_placements.length; i++) {
      // object: { template, x, z, angle, builders }
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
    // Entity or undefined
    const foundation = game_state.getEntityById(+foundation_id);
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

  // array of { template, x, z, angle, builders }
  const new_pending_placements = [];
  // object: { template, x, z, angle, builders }
  for (const order of construction_orders) {
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
