/**
 * The budget allocation, pure. v1 approves every request and dispatches on
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
export function allocateBudget(requests) {
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
