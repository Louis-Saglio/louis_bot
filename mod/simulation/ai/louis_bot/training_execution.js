export function executeTraining(training_orders) {
  // array of directive objects
  const directives = [];
  // object: { template, count, trainer_id }
  for (const order of training_orders) {
    directives.push({
      kind: "train",
      trainer_id: order.trainer_id,
      template: order.template,
      count: order.count,
    });
    print(
      `[HARNESS] louis-bot: training directive for ${order.count} ${order.template} at trainer ${order.trainer_id}\n`,
    );
  }
  return { directives: directives };
}
