import {
  GameState, Player, PlayerAction, ResourceType, BUILD_COSTS, RESOURCES,
} from './types';
import {
  canAfford, bankTradeRatio, totalResources,
} from './gameState';
import { adjacentVertices, edgesAtVertex } from './board';

// ─── Setup phase ──────────────────────────────────────────────────────────────

export function validSetupSettlements(state: GameState, playerId: string): PlayerAction[] {
  const actions: PlayerAction[] = [];
  for (const vertex of state.vertices.values()) {
    if (isValidSettlementSpot(state, vertex.id, playerId, true)) {
      actions.push({ type: 'place_settlement', vertexId: vertex.id });
    }
  }
  return actions;
}

export function validSetupRoads(state: GameState, playerId: string, lastSettlement: string): PlayerAction[] {
  const edges = edgesAtVertex(lastSettlement, state.edges);
  return edges.map(e => ({ type: 'place_road' as const, edgeId: e.id }));
}

// ─── Placement validation ─────────────────────────────────────────────────────

export function isValidSettlementSpot(
  state: GameState,
  vertexId: string,
  playerId: string,
  setupPhase: boolean,
): boolean {
  const vertex = state.vertices.get(vertexId);
  if (!vertex) return false;
  if (vertex.building !== null) return false;

  // Distance rule: no adjacent vertex can have a building
  for (const adjId of adjacentVertices(vertexId, state.edges)) {
    if (state.vertices.get(adjId)?.building !== null) return false;
  }

  // Outside setup: must connect via player's road
  if (!setupPhase) {
    const connected = edgesAtVertex(vertexId, state.edges).some(e => e.road === playerId);
    if (!connected) return false;
  }

  return true;
}

export function isValidRoadSpot(state: GameState, edgeId: string, playerId: string): boolean {
  const edge = state.edges.get(edgeId);
  if (!edge || edge.road !== null) return false;

  for (const vertId of edge.vertexIds) {
    const vertex = state.vertices.get(vertId)!;
    if (vertex.building?.playerId === playerId) return true;
    if (vertex.building && vertex.building.playerId !== playerId) continue;
    if (edgesAtVertex(vertId, state.edges).some(e => e.id !== edgeId && e.road === playerId)) return true;
  }
  return false;
}

// ─── Build-only valid actions (no dev card use) ───────────────────────────────
// Used in the build phase — dev cards are handled in their own phase.

export function validBuildOnlyActions(state: GameState, playerId: string): PlayerAction[] {
  const player = state.players.find(p => p.id === playerId)!;
  const actions: PlayerAction[] = [];

  // Road
  if (canAfford(player.resources, BUILD_COSTS.road) && player.roadsLeft > 0) {
    for (const edge of state.edges.values()) {
      if (edge.road === null && isValidRoadSpot(state, edge.id, playerId)) {
        actions.push({ type: 'place_road', edgeId: edge.id });
      }
    }
  }

  // Settlement
  if (canAfford(player.resources, BUILD_COSTS.settlement) && player.settlementsLeft > 0) {
    for (const vertex of state.vertices.values()) {
      if (isValidSettlementSpot(state, vertex.id, playerId, false)) {
        actions.push({ type: 'place_settlement', vertexId: vertex.id });
      }
    }
  }

  // City
  if (canAfford(player.resources, BUILD_COSTS.city) && player.citiesLeft > 0) {
    for (const vertex of state.vertices.values()) {
      if (vertex.building?.playerId === playerId && vertex.building.type === 'settlement') {
        actions.push({ type: 'place_city', vertexId: vertex.id });
      }
    }
  }

  // Buy dev card
  if (canAfford(player.resources, BUILD_COSTS.dev_card) && state.devDeck.length > 0) {
    actions.push({ type: 'buy_dev_card' });
  }

  // Bank / port trades
  for (const give of RESOURCES) {
    const ratio = bankTradeRatio(state, playerId, give);
    if (player.resources[give] >= ratio) {
      for (const receive of RESOURCES) {
        if (receive !== give) {
          actions.push({ type: 'trade_bank', give, receive });
        }
      }
    }
  }

  return actions;
}

// ─── Robber placement ─────────────────────────────────────────────────────────

export function validRobberPlacements(state: GameState, playerId: string): string[] {
  return [...state.hexes.values()]
    .filter(h => !h.hasRobber)
    .map(h => h.id);
}

// ─── Discard options ──────────────────────────────────────────────────────────

export function validDiscardCombinations(
  state: GameState,
  playerId: string,
  count: number,
): Array<Partial<import('./types').ResourceCounts>> {
  const player = state.players.find(p => p.id === playerId)!;
  const results: Array<Partial<import('./types').ResourceCounts>> = [];

  function gen(remaining: number, resIdx: number, current: Partial<import('./types').ResourceCounts>): void {
    if (remaining === 0) { results.push({ ...current }); return; }
    if (resIdx >= RESOURCES.length) return;
    const res = RESOURCES[resIdx];
    const max = Math.min(remaining, player.resources[res]);
    for (let i = 0; i <= max; i++) {
      const next = { ...current };
      if (i > 0) next[res] = i;
      gen(remaining - i, resIdx + 1, next);
    }
  }

  gen(count, 0, {});
  return results.slice(0, 50);
}
