export function allocateBudget(requests) {
  // array of { template, x, z, angle, builders }
  const construction_orders = [];
  // object: { key, kind, payload, cost, builders, detail }
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
