/**
 * Game logic tests — run with:
 *   npx ts-node --test test/game.test.ts
 *   or: node --require ts-node/register --test test/game.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateBoard } from '../src/board';
import { createInitialState, canAfford, deductCost, addResources, calculateVP, bankTradeRatio } from '../src/gameState';
import { isValidSettlementSpot, isValidRoadSpot, validBuildOnlyActions } from '../src/rules';
import { GameState, BUILD_COSTS, RESOURCES } from '../src/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(): GameState {
  const board = generateBoard(42);
  return createInitialState(
    [
      { id: 'p1', name: 'Alice', model: 'test', color: 'red' },
      { id: 'p2', name: 'Bob',   model: 'test', color: 'blue' },
    ],
    board,
    42,
  );
}

/** Give a player resources directly. */
function giveResources(state: GameState, playerId: string, res: Partial<typeof BUILD_COSTS.settlement>): void {
  const p = state.players.find(p => p.id === playerId)!;
  for (const r of RESOURCES) p.resources[r] += (res[r] ?? 0);
}

/** Place a settlement at the first valid setup vertex for a player. Returns vertexId. */
function placeSettlement(state: GameState, playerId: string, vertexId?: string): string {
  const vid = vertexId ?? [...state.vertices.values()].find(v =>
    isValidSettlementSpot(state, v.id, playerId, true),
  )!.id;
  state.vertices.get(vid)!.building = { type: 'settlement', playerId };
  const p = state.players.find(p => p.id === playerId)!;
  p.settlementsLeft--;
  return vid;
}

/** Place a road on the first edge adjacent to a vertex for a player. Returns edgeId. */
function placeRoad(state: GameState, playerId: string, vertexId: string): string {
  // find any edge touching this vertex
  const edge = [...state.edges.values()].find(e =>
    e.vertexIds.includes(vertexId) && e.road === null,
  )!;
  edge.road = playerId;
  const p = state.players.find(p => p.id === playerId)!;
  p.roadsLeft--;
  return edge.id;
}

// ─── Settlement placement ─────────────────────────────────────────────────────

describe('Settlement placement — distance rule', () => {
  test('cannot place adjacent to an existing settlement', () => {
    const state = makeState();
    const vid1 = placeSettlement(state, 'p1');
    // All adjacent vertices should now be invalid for anyone
    const adjEdges = [...state.edges.values()].filter(e => e.vertexIds.includes(vid1));
    const adjVertexIds = new Set(adjEdges.flatMap(e => e.vertexIds).filter(v => v !== vid1));

    for (const adjVid of adjVertexIds) {
      assert.equal(
        isValidSettlementSpot(state, adjVid, 'p1', true),
        false,
        `${adjVid} adjacent to ${vid1} should be blocked`,
      );
      assert.equal(
        isValidSettlementSpot(state, adjVid, 'p2', true),
        false,
        `${adjVid} adjacent to ${vid1} should block p2 too`,
      );
    }
  });

  test('can place non-adjacent to existing settlement', () => {
    const state = makeState();
    placeSettlement(state, 'p1');
    // At least one valid spot should still exist for p2 (large board)
    const validForP2 = [...state.vertices.values()].filter(v =>
      isValidSettlementSpot(state, v.id, 'p2', true),
    );
    assert.ok(validForP2.length > 0, 'p2 should have valid spots remaining');
  });

  test('cannot place on occupied vertex', () => {
    const state = makeState();
    const vid = placeSettlement(state, 'p1');
    assert.equal(isValidSettlementSpot(state, vid, 'p2', true), false);
    assert.equal(isValidSettlementSpot(state, vid, 'p1', true), false);
  });
});

describe('Settlement placement — road connection (non-setup)', () => {
  test('cannot place without own adjacent road', () => {
    const state = makeState();
    // Find any unoccupied vertex — without a road it should be invalid
    const vid = [...state.vertices.values()].find(v =>
      isValidSettlementSpot(state, v.id, 'p1', true),
    )!.id;
    assert.equal(
      isValidSettlementSpot(state, vid, 'p1', false),
      false,
      'no road → cannot place in non-setup',
    );
  });

  test('can place at end of two-road chain (non-adjacent to first settlement)', () => {
    const state = makeState();
    const s1 = placeSettlement(state, 'p1');
    // Build road 1: s1 → mid
    const road1Id = placeRoad(state, 'p1', s1);
    const road1 = state.edges.get(road1Id)!;
    const midVid = road1.vertexIds.find(v => v !== s1)!;
    // Build road 2: mid → far  (far is now 2 edges from s1, not adjacent)
    const road2 = [...state.edges.values()].find(e =>
      e.vertexIds.includes(midVid) && e.id !== road1Id && e.road === null,
    );
    if (!road2) return; // skip if no second edge exists (edge of board)
    road2.road = 'p1';
    const farVid = road2.vertexIds.find(v => v !== midVid)!;
    // farVid is 2 hops from s1 — distance rule satisfied, own road connected
    assert.equal(
      isValidSettlementSpot(state, farVid, 'p1', false),
      true,
      'end of two-road chain should be a valid placement spot',
    );
  });

  test('enemy road does not count as connection', () => {
    const state = makeState();
    const s1 = placeSettlement(state, 'p2');
    const roadEdgeId = placeRoad(state, 'p2', s1);
    const roadEdge = state.edges.get(roadEdgeId)!;
    const farVid = roadEdge.vertexIds.find(v => v !== s1)!;
    assert.equal(
      isValidSettlementSpot(state, farVid, 'p1', false),
      false,
      "p2's road should not enable p1 to place",
    );
  });

  test('cannot place where p1 road is blocked by p2 settlement', () => {
    const state = makeState();
    // p1 builds settlement + road
    const s1 = placeSettlement(state, 'p1');
    const roadEdgeId = placeRoad(state, 'p1', s1);
    const roadEdge = state.edges.get(roadEdgeId)!;
    const farVid = roadEdge.vertexIds.find(v => v !== s1)!;
    // p2 blocks that vertex
    state.vertices.get(farVid)!.building = { type: 'settlement', playerId: 'p2' };
    // p1 tries to place at the end of their own road — now occupied
    assert.equal(
      isValidSettlementSpot(state, farVid, 'p1', false),
      false,
      'occupied vertex should block placement even with adjacent road',
    );
  });
});

// ─── Road placement ────────────────────────────────────────────────────────────

describe('Road placement', () => {
  test('can build road adjacent to own settlement', () => {
    const state = makeState();
    const s1 = placeSettlement(state, 'p1');
    const adjEdge = [...state.edges.values()].find(e =>
      e.vertexIds.includes(s1) && e.road === null,
    )!;
    assert.equal(isValidRoadSpot(state, adjEdge.id, 'p1'), true);
  });

  test('cannot build road adjacent only to enemy settlement', () => {
    const state = makeState();
    const s2 = placeSettlement(state, 'p2');
    // Find an edge touching p2's settlement with no other p1 infrastructure
    const adjEdge = [...state.edges.values()].find(e =>
      e.vertexIds.includes(s2) && e.road === null,
    )!;
    assert.equal(isValidRoadSpot(state, adjEdge.id, 'p1'), false);
  });

  test('cannot build road on occupied edge', () => {
    const state = makeState();
    const s1 = placeSettlement(state, 'p1');
    const adjEdge = [...state.edges.values()].find(e =>
      e.vertexIds.includes(s1) && e.road === null,
    )!;
    adjEdge.road = 'p1'; // already built
    assert.equal(isValidRoadSpot(state, adjEdge.id, 'p1'), false);
    assert.equal(isValidRoadSpot(state, adjEdge.id, 'p2'), false);
  });

  test('can extend road along chain', () => {
    const state = makeState();
    const s1 = placeSettlement(state, 'p1');
    const road1Id = placeRoad(state, 'p1', s1);
    const road1 = state.edges.get(road1Id)!;
    const midVid = road1.vertexIds.find(v => v !== s1)!;
    // From midVid, find another open edge
    const nextEdge = [...state.edges.values()].find(e =>
      e.vertexIds.includes(midVid) && e.id !== road1Id && e.road === null,
    );
    if (nextEdge) {
      assert.equal(isValidRoadSpot(state, nextEdge.id, 'p1'), true);
    }
  });
});

// ─── Building costs & resource deduction ──────────────────────────────────────

describe('Build costs', () => {
  test('canAfford returns false when short on resources', () => {
    assert.equal(canAfford({ wood: 0, brick: 1, wheat: 1, sheep: 1, ore: 0 }, BUILD_COSTS.settlement), false);
  });

  test('canAfford returns true when exactly meeting cost', () => {
    assert.equal(canAfford({ wood: 1, brick: 1, wheat: 1, sheep: 1, ore: 0 }, BUILD_COSTS.settlement), true);
  });

  test('deductCost removes correct amounts', () => {
    const res = { wood: 3, brick: 2, wheat: 2, sheep: 1, ore: 0 };
    deductCost(res, BUILD_COSTS.road); // costs 1 wood + 1 brick
    assert.equal(res.wood, 2);
    assert.equal(res.brick, 1);
  });

  test('addResources adds correctly', () => {
    const res = { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 };
    addResources(res, { wood: 2, ore: 3 });
    assert.equal(res.wood, 2);
    assert.equal(res.ore, 3);
    assert.equal(res.wheat, 0);
  });
});

// ─── validBuildOnlyActions ────────────────────────────────────────────────────

describe('validBuildOnlyActions', () => {
  test('returns no actions with no resources', () => {
    const state = makeState();
    placeSettlement(state, 'p1');
    const actions = validBuildOnlyActions(state, 'p1');
    assert.equal(actions.length, 0, 'no actions without resources');
  });

  test('includes road when player has wood+brick and has settlement', () => {
    const state = makeState();
    placeSettlement(state, 'p1');
    giveResources(state, 'p1', { wood: 1, brick: 1 });
    const actions = validBuildOnlyActions(state, 'p1');
    assert.ok(actions.some(a => a.type === 'place_road'), 'should include road action');
  });

  test('includes settlement when player can afford and has two-road chain to open spot', () => {
    const state = makeState();
    const s1 = placeSettlement(state, 'p1');
    // Two roads to reach a non-adjacent vertex
    const road1Id = placeRoad(state, 'p1', s1);
    const road1 = state.edges.get(road1Id)!;
    const midVid = road1.vertexIds.find(v => v !== s1)!;
    const road2 = [...state.edges.values()].find(e =>
      e.vertexIds.includes(midVid) && e.id !== road1Id && e.road === null,
    );
    if (!road2) return; // edge of board — skip
    road2.road = 'p1';
    giveResources(state, 'p1', { wood: 1, brick: 1, wheat: 1, sheep: 1 });
    const actions = validBuildOnlyActions(state, 'p1');
    assert.ok(actions.some(a => a.type === 'place_settlement'), 'should include settlement after two-road chain');
  });

  test('does NOT include settlement without road connection (non-setup)', () => {
    const state = makeState();
    placeSettlement(state, 'p1');
    // Has resources but no road → no reachable open spot
    giveResources(state, 'p1', { wood: 1, brick: 1, wheat: 1, sheep: 1 });
    const actions = validBuildOnlyActions(state, 'p1');
    // Settlement options require connected road; first settlement has no road
    assert.equal(
      actions.some(a => a.type === 'place_settlement'),
      false,
      'cannot build settlement without road connection',
    );
  });

  test('includes city when player has settlement and ore+wheat', () => {
    const state = makeState();
    const s1 = placeSettlement(state, 'p1');
    giveResources(state, 'p1', { wheat: 2, ore: 3 });
    const actions = validBuildOnlyActions(state, 'p1');
    assert.ok(actions.some(a => a.type === 'place_city'), 'should include city upgrade');
    const cityAction = actions.find(a => a.type === 'place_city') as any;
    assert.equal(cityAction.vertexId, s1, 'city should target own settlement');
  });

  test('does NOT include city for enemy settlement', () => {
    const state = makeState();
    placeSettlement(state, 'p2'); // p2 settles somewhere
    giveResources(state, 'p1', { wheat: 2, ore: 3 });
    const actions = validBuildOnlyActions(state, 'p1');
    assert.equal(actions.some(a => a.type === 'place_city'), false, 'cannot upgrade enemy settlement');
  });

  test('includes dev card when player can afford', () => {
    const state = makeState();
    giveResources(state, 'p1', { wheat: 1, sheep: 1, ore: 1 });
    const actions = validBuildOnlyActions(state, 'p1');
    assert.ok(actions.some(a => a.type === 'buy_dev_card'));
  });

  test('does NOT include dev card when deck is empty', () => {
    const state = makeState();
    state.devDeck = [];
    giveResources(state, 'p1', { wheat: 1, sheep: 1, ore: 1 });
    const actions = validBuildOnlyActions(state, 'p1');
    assert.equal(actions.some(a => a.type === 'buy_dev_card'), false);
  });

  test('includes bank trade at 4:1 when player has 4 of a resource', () => {
    const state = makeState();
    giveResources(state, 'p1', { wood: 4 });
    const actions = validBuildOnlyActions(state, 'p1');
    const woodTrades = actions.filter(a => a.type === 'trade_bank' && (a as any).give === 'wood');
    assert.equal(woodTrades.length, 4, 'should be able to trade wood for 4 other resources');
  });

  test('does NOT include bank trade with only 3 of a resource (no port)', () => {
    const state = makeState();
    giveResources(state, 'p1', { wood: 3 });
    const actions = validBuildOnlyActions(state, 'p1');
    assert.equal(actions.some(a => a.type === 'trade_bank' && (a as any).give === 'wood'), false);
  });
});

// ─── VP calculation ───────────────────────────────────────────────────────────

describe('VP calculation', () => {
  test('1 settlement = 1 VP', () => {
    const state = makeState();
    placeSettlement(state, 'p1');
    assert.equal(calculateVP(state, 'p1'), 1);
  });

  test('city = 2 VP (upgraded from settlement)', () => {
    const state = makeState();
    const vid = placeSettlement(state, 'p1');
    state.vertices.get(vid)!.building!.type = 'city';
    assert.equal(calculateVP(state, 'p1'), 2);
  });

  test('2 settlements = 2 VP', () => {
    const state = makeState();
    placeSettlement(state, 'p1');
    // find a non-adjacent spot for second settlement
    const second = [...state.vertices.values()].find(v =>
      isValidSettlementSpot(state, v.id, 'p1', true),
    )!;
    placeSettlement(state, 'p1', second.id);
    assert.equal(calculateVP(state, 'p1'), 2);
  });

  test('victory_point dev card adds 1 VP', () => {
    const state = makeState();
    placeSettlement(state, 'p1');
    state.players.find(p => p.id === 'p1')!.devCards.push('victory_point');
    assert.equal(calculateVP(state, 'p1'), 2);
  });

  test('largest army adds 2 VP', () => {
    const state = makeState();
    placeSettlement(state, 'p1');
    state.players.find(p => p.id === 'p1')!.hasLargestArmy = true;
    assert.equal(calculateVP(state, 'p1'), 3);
  });

  test('longest road adds 2 VP', () => {
    const state = makeState();
    placeSettlement(state, 'p1');
    state.players.find(p => p.id === 'p1')!.hasLongestRoad = true;
    assert.equal(calculateVP(state, 'p1'), 3);
  });
});

// ─── Bank trade ratio ─────────────────────────────────────────────────────────

describe('bankTradeRatio', () => {
  test('default is 4:1 without any port', () => {
    const state = makeState();
    assert.equal(bankTradeRatio(state, 'p1', 'wood'), 4);
  });

  test('generic port (any) gives 3:1 for all resources', () => {
    const state = makeState();
    // Give p1 a settlement on a 'any' port vertex
    const portVertex = [...state.vertices.values()].find(v => v.port === 'any');
    if (portVertex) {
      portVertex.building = { type: 'settlement', playerId: 'p1' };
      for (const r of RESOURCES) {
        assert.equal(bankTradeRatio(state, 'p1', r), 3, `any port should give 3:1 for ${r}`);
      }
    }
  });

  test('specific resource port gives 2:1 for that resource', () => {
    const state = makeState();
    const portVertex = [...state.vertices.values()].find(v =>
      v.port && v.port !== 'any',
    );
    if (portVertex) {
      portVertex.building = { type: 'settlement', playerId: 'p1' };
      const portRes = portVertex.port as import('../src/types').ResourceType;
      assert.equal(bankTradeRatio(state, 'p1', portRes), 2);
      // Other resources still at 4
      const otherRes = RESOURCES.find(r => r !== portVertex.port);
      if (otherRes) assert.equal(bankTradeRatio(state, 'p1', otherRes), 4);
    }
  });
});
