export function allocateBudget(requests) {
  // array of { template, x, z, angle, builders }
  const construction_orders = [];
  // array of { template, count, trainer_id }
  const training_orders = [];
  // object: { key, kind, priority, payload, cost, detail }
  for (const request of requests) {
    print(
      `[HARNESS] louis-bot: spending request ${request.key} (${request.kind}): ${request.detail}\n`,
    );
    if (request.kind === "construct") {
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
  return {
    construction_orders: construction_orders,
    training_orders: training_orders,
  };
}
