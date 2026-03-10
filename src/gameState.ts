import {
  GameState, Player, PlayerConfig, ResourceCounts, ResourceType,
  DevCardType, GameEvent, RESOURCES, BUILD_COSTS, VICTORY_POINTS_TO_WIN,
} from './types';
import { Board, verticesOfHex, adjacentVertices, edgesAtVertex } from './board';

// ─── Dev card deck ────────────────────────────────────────────────────────────

function buildDevDeck(): DevCardType[] {
  return [
    ...Array(14).fill('knight'),
    ...Array(5).fill('victory_point'),
    ...Array(2).fill('road_building'),
    ...Array(2).fill('year_of_plenty'),
    ...Array(2).fill('monopoly'),
  ] as DevCardType[];
}

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffleArr<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Create initial state ─────────────────────────────────────────────────────

export function createInitialState(
  playerConfigs: PlayerConfig[],
  board: Board,
  seed?: number,
): GameState {
  const rng = mulberry32((seed ?? 12345) + 1);

  const players: Player[] = playerConfigs.map(cfg => ({
    id: cfg.id,
    name: cfg.name,
    model: cfg.model,
    color: cfg.color,
    resources: { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 },
    settlementsLeft: 5,
    citiesLeft: 4,
    roadsLeft: 15,
    devCards: [],
    devCardPlayedThisTurn: false,
    knightsPlayed: 0,
    hasLongestRoad: false,
    hasLargestArmy: false,
  }));

  const playerIds = players.map(p => p.id);
  // Setup order: forward then reversed (snake draft)
  const setupTurnOrder = [...playerIds, ...[...playerIds].reverse()];

  return {
    phase: 'setup',
    setupTurnOrder,
    setupIndex: 0,
    setupSubPhase: 'settlement',
    turn: 0,
    currentPlayerIndex: 0,
    players,
    hexes: board.hexes,
    vertices: board.vertices,
    edges: board.edges,
    devDeck: shuffleArr(buildDevDeck(), rng),
    lastRoll: null,

    longestRoadPlayer: null,
    longestRoadLength: 4,  // threshold to claim it
    largestArmyPlayer: null,
    largestArmySize: 2,    // threshold to claim it
    winner: null,
    log: [],
    turnSummaries: [],
  };
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export function logEvent(
  state: GameState,
  playerId: string | null,
  type: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  state.log.push({ turn: state.turn, playerId, type, message, data });
}

// ─── Resource helpers ─────────────────────────────────────────────────────────

export function totalResources(r: ResourceCounts): number {
  return r.wood + r.brick + r.wheat + r.sheep + r.ore;
}

export function canAfford(resources: ResourceCounts, cost: ResourceCounts): boolean {
  return RESOURCES.every(res => resources[res] >= cost[res]);
}

export function deductCost(resources: ResourceCounts, cost: ResourceCounts): void {
  RESOURCES.forEach(res => { resources[res] -= cost[res]; });
}

export function addResources(resources: ResourceCounts, adds: Partial<ResourceCounts>): void {
  RESOURCES.forEach(res => { resources[res] += (adds[res] ?? 0); });
}

// ─── Resource distribution on dice roll ───────────────────────────────────────

export function distributeResources(state: GameState, roll: number): void {
  for (const hex of state.hexes.values()) {
    if (hex.number !== roll || hex.hasRobber) continue;
    const resource = hex.type as ResourceType;
    if (hex.type === 'desert') continue;

    for (const vertex of verticesOfHex(hex.id, state.vertices)) {
      if (!vertex.building) continue;
      const player = state.players.find(p => p.id === vertex.building!.playerId);
      if (!player) continue;
      const amount = vertex.building.type === 'city' ? 2 : 1;
      player.resources[resource] += amount;
      logEvent(state, player.id, 'resource', `${player.name} receives ${amount} ${resource} from hex ${hex.id}`);
    }
  }
}

// ─── VP calculation ───────────────────────────────────────────────────────────

/** VP visible to all players — excludes hidden victory_point dev cards */
export function calculateVisibleVP(state: GameState, playerId: string): number {
  const player = state.players.find(p => p.id === playerId)!;
  let vp = 0;
  vp += [...state.vertices.values()].filter(v => v.building?.playerId === playerId).reduce((s, v) => s + (v.building!.type === 'city' ? 2 : 1), 0);
  if (player.hasLongestRoad) vp += 2;
  if (player.hasLargestArmy) vp += 2;
  return vp;
}

export function calculateVP(state: GameState, playerId: string): number {
  const player = state.players.find(p => p.id === playerId)!;
  let vp = 0;

  // Settlements and cities on the board
  for (const vertex of state.vertices.values()) {
    if (vertex.building?.playerId === playerId) {
      vp += vertex.building.type === 'city' ? 2 : 1;
    }
  }

  // Longest road / largest army bonus
  if (player.hasLongestRoad) vp += 2;
  if (player.hasLargestArmy) vp += 2;

  // Victory point dev cards
  vp += player.devCards.filter(c => c === 'victory_point').length;

  return vp;
}

// ─── Longest road calculation ─────────────────────────────────────────────────

export function calculateLongestRoad(state: GameState, playerId: string): number {
  // Find all edges owned by this player
  const playerEdges = [...state.edges.values()].filter(e => e.road === playerId);
  if (playerEdges.length === 0) return 0;

  // Build adjacency map: vertex -> connected vertices via player roads
  const adj = new Map<string, Set<string>>();
  for (const edge of playerEdges) {
    const [v1, v2] = edge.vertexIds;
    if (!adj.has(v1)) adj.set(v1, new Set());
    if (!adj.has(v2)) adj.set(v2, new Set());
    adj.get(v1)!.add(v2);
    adj.get(v2)!.add(v1);
  }

  // DFS from each vertex to find longest path
  let maxLen = 0;

  function dfs(current: string, prev: string | null, visitedEdges: Set<string>, length: number): void {
    if (length > maxLen) maxLen = length;
    const neighbors = adj.get(current) ?? new Set();
    for (const next of neighbors) {
      const eid = [current, next].sort().join('||');
      if (visitedEdges.has(eid)) continue;
      // Road can pass through an opponent's settlement only if you own a piece there
      // (simplified: allow travel through any vertex that isn't blocked)
      const vertex = state.vertices.get(next);
      if (vertex?.building && vertex.building.playerId !== playerId && prev !== null) {
        // Opponent building blocks road continuity
        continue;
      }
      visitedEdges.add(eid);
      dfs(next, current, visitedEdges, length + 1);
      visitedEdges.delete(eid);
    }
  }

  for (const startVertex of adj.keys()) {
    dfs(startVertex, null, new Set(), 0);
  }

  return maxLen;
}

// ─── Update longest road / largest army awards ────────────────────────────────

export function updateSpecialCards(state: GameState): void {
  // Largest army
  for (const player of state.players) {
    if (player.knightsPlayed > state.largestArmySize) {
      if (state.largestArmyPlayer && state.largestArmyPlayer !== player.id) {
        const prev = state.players.find(p => p.id === state.largestArmyPlayer)!;
        prev.hasLargestArmy = false;
      }
      state.largestArmyPlayer = player.id;
      state.largestArmySize = player.knightsPlayed;
      player.hasLargestArmy = true;
      logEvent(state, player.id, 'largest_army', `${player.name} claims Largest Army (${player.knightsPlayed} knights)`);
    }
  }

  // Longest road
  for (const player of state.players) {
    const len = calculateLongestRoad(state, player.id);
    if (len > state.longestRoadLength) {
      if (state.longestRoadPlayer && state.longestRoadPlayer !== player.id) {
        const prev = state.players.find(p => p.id === state.longestRoadPlayer)!;
        prev.hasLongestRoad = false;
      }
      state.longestRoadPlayer = player.id;
      state.longestRoadLength = len;
      player.hasLongestRoad = true;
      logEvent(state, player.id, 'longest_road', `${player.name} claims Longest Road (${len} segments)`);
    }
  }
}

// ─── Win condition ────────────────────────────────────────────────────────────

export function checkWin(state: GameState): string | null {
  for (const player of state.players) {
    if (calculateVP(state, player.id) >= VICTORY_POINTS_TO_WIN) {
      return player.id;
    }
  }
  return null;
}

// ─── Bank trade ratio ─────────────────────────────────────────────────────────

export function bankTradeRatio(state: GameState, playerId: string, resource: ResourceType): number {
  // Check if player has a 2:1 port for this specific resource
  for (const vertex of state.vertices.values()) {
    if (vertex.building?.playerId === playerId && vertex.port === resource) return 2;
  }
  // Check if player has a 3:1 any port
  for (const vertex of state.vertices.values()) {
    if (vertex.building?.playerId === playerId && vertex.port === 'any') return 3;
  }
  return 4; // default bank rate
}

// ─── Setup phase helpers ──────────────────────────────────────────────────────

export function currentSetupPlayer(state: GameState): Player {
  return state.players.find(p => p.id === state.setupTurnOrder[state.setupIndex])!;
}

/** After placing second settlement in reverse order, give adjacent resources */
export function grantSetupResources(state: GameState, playerId: string, vertexId: string): void {
  const vertex = state.vertices.get(vertexId)!;
  const player = state.players.find(p => p.id === playerId)!;
  for (const hexId of vertex.hexIds) {
    const hex = state.hexes.get(hexId)!;
    if (hex.type !== 'desert') {
      player.resources[hex.type as ResourceType]++;
      logEvent(state, playerId, 'setup_resource', `${player.name} receives 1 ${hex.type} from setup`);
    }
  }
}

// ─── Discard on 7 ────────────────────────────────────────────────────────────

export function getDiscardCount(player: Player): number {
  const total = totalResources(player.resources);
  return total > 7 ? Math.floor(total / 2) : 0;
}
