export function applyPopulationStrategy(game_state) {
  // array of spending request objects
  const empty_result = { requests: [] };
  // Entity or undefined: the own civil center, finished buildings only
  let civ_center;
  // Entity: one own structure
  for (const structure of game_state.getOwnStructures().values()) {
    if (!structure.hasClass("CivCentre")) continue;
    if (structure.foundationProgress() !== undefined) continue;
    civ_center = structure;
    break;
  }
  if (!civ_center) return empty_result;

  // array of { id, template, count, progress, ... } or undefined: queued
  // training items; a busy queue counts as need satisfied
  const queue = civ_center.trainingQueue();
  if (queue && queue.length > 0) return empty_result;

  // string: this civ's civilian template name
  const template_name =
    "units/" + game_state.getPlayerCiv() + "/support_civilian";
  // Template or null
  const template = game_state.getTemplate(template_name);
  if (!template) return empty_result;

  return {
    requests: [
      {
        key: "population:civilian",
        kind: "train",
        priority: 3,
        payload: {
          template: template_name,
          count: 1,
          trainer_id: civ_center.id(),
        },
        // object: resource name -> amount, only non-zero costs
        cost: template.cost(),
        detail: "one civilian from the civil center",
      },
    ],
  };
}
