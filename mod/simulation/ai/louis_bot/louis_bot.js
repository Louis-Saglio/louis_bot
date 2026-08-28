import { BaseAI } from "simulation/ai/common-api/baseAI.js";
import { applyGatheringStrategy } from "simulation/ai/louis_bot/gathering_strategy.js";
import { applyDropoffsStrategy } from "simulation/ai/louis_bot/dropoffs_strategy.js";
import { applyPopulationStrategy } from "simulation/ai/louis_bot/population_strategy.js";
import { allocateBudget } from "simulation/ai/louis_bot/budget_allocation.js";
import { executeConstruction } from "simulation/ai/louis_bot/construction_execution.js";
import { executeTraining } from "simulation/ai/louis_bot/training_execution.js";

// number: the bot plays every that many turns
const PLAY_EVERY_N_TURN = 8;

export function LouisBot(settings) {
  BaseAI.call(this, settings);
}

LouisBot.prototype = Object.create(BaseAI.prototype);

LouisBot.prototype.CustomInit = function (gameState) {
  print(`[HARNESS] louis-bot: loaded for player ${this.player}\n`);
};

LouisBot.prototype.OnUpdate = function () {
  // GameState: this player's game state
  const game_state = this.gameState;
  if (game_state.playerData.state !== "active") return;

  if (this.turn % PLAY_EVERY_N_TURN !== 0) {
    this.turn++;
    return;
  }

  // number: this bot's turn counter
  const turn = this.turn;
  // object or undefined: state stashed by Deserialize
  const saved_state = this.saved_state;
  // object: { assignment_by_worker_id, owned_unit_ids_by_priority,
  //   carried_amount_by_worker_id, measured_rate_by_worker_id,
  //   last_delivery_time_by_worker_id }
  const gathering_state = this.gathering_state ?? saved_state?.gathering_state ?? {};
  // object: { builder_ids_by_foundation_id, pending_placements }
  const construction_state =
    this.construction_state ?? saved_state?.construction_state ?? {};
  // object: { attempted, rejected }
  const dropoff_state = this.dropoff_state ?? saved_state?.dropoff_state ?? {};

  // object: { state, requests }
  const dropoff_result = applyDropoffsStrategy(dropoff_state, game_state);

  // object: { requests }
  const population_result = applyPopulationStrategy(game_state);

  // array of spending request objects
  const requests = [
    ...dropoff_result.requests,
    ...population_result.requests,
  ];
  // object: { construction_orders, training_orders,
  //   owned_unit_ids_by_priority }; the compromiser approves spending and
  //   grants pool units to gathering
  const budget_result = allocateBudget(requests, game_state, gathering_state);

  // object: gathering state with the compromiser's unit grants applied
  const granted_gathering_state = {
    ...gathering_state,
    owned_unit_ids_by_priority: budget_result.owned_unit_ids_by_priority,
  };

  // object: { state, directives, requests }
  const gathering_result = applyGatheringStrategy(
    granted_gathering_state,
    game_state,
    turn,
  );

  // object: { state, directives }
  const construction_result = executeConstruction(
    construction_state,
    budget_result.construction_orders,
    game_state,
  );

  // object: { directives }
  const training_result = executeTraining(budget_result.training_orders);

  // array of directive objects
  const directives = [
    ...gathering_result.directives,
    ...construction_result.directives,
    ...training_result.directives,
  ];
  // object: one directive
  for (const directive of directives) {
    if (directive.kind === "gather") {
      // Entity or undefined
      const worker = game_state.getEntityById(directive.worker_id);
      // Entity or undefined
      const source = game_state.getEntityById(directive.source_id);
      if (worker && source) worker.gather(source);
    } else if (directive.kind === "stop") {
      // Entity or undefined
      const worker = game_state.getEntityById(directive.worker_id);
      if (worker) worker.stopMoving();
    } else if (directive.kind === "construct") {
      // Entity or undefined
      const poster = game_state.getEntityById(directive.builder_id);
      if (poster)
        poster.construct(
          directive.template,
          directive.x,
          directive.z,
          directive.angle,
        );
    } else if (directive.kind === "repair") {
      // Entity or undefined
      const builder = game_state.getEntityById(directive.builder_id);
      // Entity or undefined
      const foundation = game_state.getEntityById(directive.foundation_id);
      if (builder && foundation) builder.repair(foundation);
    } else if (directive.kind === "train") {
      // Entity or undefined
      const trainer = game_state.getEntityById(directive.trainer_id);
      if (trainer)
        trainer.train(
          game_state.getPlayerCiv(),
          directive.template,
          directive.count,
          null,
        );
    }
  }

  this.gathering_state = gathering_result.state;
  this.dropoff_state = dropoff_result.state;
  this.construction_state = construction_result.state;
  this.turn = turn + 1;
};

LouisBot.prototype.Serialize = function () {
  return {
    gathering_state: this.gathering_state,
    construction_state: this.construction_state,
    dropoff_state: this.dropoff_state,
  };
};

LouisBot.prototype.Deserialize = function (data, sharedScript) {
  this.saved_state = data || {};
  this.isDeserialized = true;
};
