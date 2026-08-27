import { BaseAI } from "simulation/ai/common-api/baseAI.js";
import { applyWorkersStrategy } from "simulation/ai/louis_bot/workers_strategy.js";
import { applyDropoffsStrategy } from "simulation/ai/louis_bot/dropoffs_strategy.js";
import { allocateBudget } from "simulation/ai/louis_bot/budget_allocation.js";
import { executeConstruction } from "simulation/ai/louis_bot/construction_execution.js";

// number: the bot plays every that many turns
const PLAY_EVERY_N_TURN = 8;

/**
 * @param {object} settings — engine-provided player settings: { player,
 *   difficulty, behavior } (see the AI engine API docs).
 */
export function LouisBot(settings) {
  BaseAI.call(this, settings);
}

LouisBot.prototype = Object.create(BaseAI.prototype);

/**
 * @param {GameState} gameState — this player's game state.
 */
LouisBot.prototype.CustomInit = function (gameState) {
  print(`[HARNESS] louis-bot: loaded for player ${this.player}\n`);
};

/**
 * The top of the call stack: reads and writes the bot state, each concern
 * lives in its own pass below, and every engine command is posted here.
 * No parameters.
 */
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
  // object: { assignment_by_worker_id, carried_amount_by_worker_id,
  //   measured_rate_by_worker_id, last_delivery_time_by_worker_id }
  const worker_state = this.worker_state ?? saved_state?.worker_state ?? {};
  // object: { builder_ids_by_foundation_id, pending_placements }
  const construction_state =
    this.construction_state ?? saved_state?.construction_state ?? {};
  // object: { attempted, rejected }
  const dropoff_state = this.dropoff_state ?? saved_state?.dropoff_state ?? {};

  // object: { state, directives, requests }: the worker pass result
  const worker_result = applyWorkersStrategy(worker_state, game_state, turn);

  // object: { state, requests }: the dropoff pass result
  const dropoff_result = applyDropoffsStrategy(
    dropoff_state,
    worker_result.state.assignment_by_worker_id,
    game_state,
  );

  // array of spending request objects: from every pass
  const requests = [...worker_result.requests, ...dropoff_result.requests];
  // object { construction_orders: array }: the budget allocation result
  const budget_result = allocateBudget(requests);

  // object: { state, directives }: the construction execution result
  const construction_result = executeConstruction(
    construction_state,
    budget_result.construction_orders,
    game_state,
  );

  // array of directive objects: from every pass and executor
  const directives = [
    ...worker_result.directives,
    ...construction_result.directives,
  ];
  // object: one directive
  for (const directive of directives) {
    if (directive.kind === "gather") {
      // Entity or undefined: worker to order
      const worker = game_state.getEntityById(directive.worker_id);
      // Entity or undefined: source it should gather
      const source = game_state.getEntityById(directive.source_id);
      if (worker && source) worker.gather(source);
    } else if (directive.kind === "construct") {
      // Entity or undefined: the builder posting the placement
      const poster = game_state.getEntityById(directive.builder_id);
      if (poster)
        poster.construct(
          directive.template,
          directive.x,
          directive.z,
          directive.angle,
        );
    } else if (directive.kind === "repair") {
      // Entity or undefined: the builder
      const builder = game_state.getEntityById(directive.builder_id);
      // Entity or undefined: the foundation to raise
      const foundation = game_state.getEntityById(directive.foundation_id);
      if (builder && foundation) builder.repair(foundation);
    }
  }

  this.worker_state = worker_result.state;
  this.dropoff_state = dropoff_result.state;
  this.construction_state = construction_result.state;
  this.turn = turn + 1;
};

/**
 * Plain structured-cloneable data only, no live Entity references.
 * @returns {object} the bot state to persist in saved games.
 */
LouisBot.prototype.Serialize = function () {
  return {
    worker_state: this.worker_state,
    construction_state: this.construction_state,
    dropoff_state: this.dropoff_state,
  };
};

/**
 * The state is only stashed here; OnUpdate restores it on the first update
 * after load.
 * @param {object} data — plain object returned by Serialize.
 * @param {SharedScript} sharedScript — the shared script instance.
 */
LouisBot.prototype.Deserialize = function (data, sharedScript) {
  this.saved_state = data || {};
  this.isDeserialized = true;
};
