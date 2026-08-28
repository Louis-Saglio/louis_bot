export function allocateBudget(requests, game_state, gathering_state) {
  // array of { template, x, z, angle, builders }
  const construction_orders = [];
  // array of { template, count, trainer_id }
  const training_orders = [];
  // object: { key, kind, priority, payload, cost, builders, detail }
  for (const request of requests) {
    if (request.kind === "construct") {
      if (!request.builders || request.builders.length === 0) {
        print(
          `[HARNESS] louis-bot: rejected ${request.key}, no builder candidates\n`,
        );
        continue;
      }
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
    } else if (request.kind === "train") {
      training_orders.push({
        template: request.payload.template,
        count: request.payload.count,
        trainer_id: request.payload.trainer_id,
      });
      print(
        `[HARNESS] louis-bot: approved ${request.key}, training order for ${request.payload.count} ${request.payload.template}\n`,
      );
    }
  }

  // set of unit ids (number) already owned by a strategy; builders stay in
  // their owner's bucket while they build, so nothing is removed here
  const owned_ids = new Set();
  // array of number: unit ids held at one priority level
  for (const ids of Object.values(
    gathering_state.owned_unit_ids_by_priority || {},
  ))
    // number: one owned unit id
    for (const id of ids) owned_ids.add(id);

  // array of number: ids of units belonging to nobody, granted to gathering
  const pool_ids = [];
  // Entity: one own unit
  for (const unit of game_state.getOwnUnits().toEntityArray())
    if (!owned_ids.has(unit.id())) pool_ids.push(unit.id());

  // dict: priority -> sorted unit ids; the pool joins gathering at priority 1
  const owned_unit_ids_by_priority = {
    1: [
      ...((gathering_state.owned_unit_ids_by_priority || {})[1] || []),
      ...pool_ids,
    ].sort((a, b) => a - b),
  };
  if (pool_ids.length > 0)
    print(
      `[HARNESS] louis-bot: granted ${pool_ids.length} pool units to gathering\n`,
    );

  return {
    construction_orders: construction_orders,
    training_orders: training_orders,
    owned_unit_ids_by_priority: owned_unit_ids_by_priority,
  };
}
