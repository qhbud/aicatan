import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  GameState, Player, PlayerAction, TurnLog, TurnEntry, TradeOffer, TradeResponse,
  ResourceCounts, ResourceType, RESOURCES, BUILD_COSTS,
  PreRollResult, TradeResponseResult, TradeResolutionResult,
  PostRollDevCardResult, PostRollTradeResult, BuildResult,
  SetupResult, RobberResult, RobberThreatResult, RobberConcessionResult, DiscardResult,
} from '../types';
import { calculateVP, calculateVisibleVP, bankTradeRatio, totalResources, calculateLongestRoad } from '../gameState';
import { adjacentVertices } from '../board';
import { isValidRoadSpot, isValidSettlementSpot } from '../rules';

// ─── Agent interface ──────────────────────────────────────────────────────────

export interface AIAgent {
  playerId: string;
  playerName: string;
  model: string;

  /** Setup phase — choose settlement or road placement */
  decideSetup(state: GameState, validActions: PlayerAction[], context: string): Promise<SetupResult>;

  /** Pre-roll: play Knight? propose trade? ready to roll? */
  decidePreRoll(state: GameState, turnLog: TurnLog, tradesLeft: number): Promise<PreRollResult>;

  /** Respond to another player's trade offer */
  respondToTrade(
    state: GameState,
    turnLog: TurnLog,
    offer: TradeOffer,
    priorResponses: TradeResponse[],
  ): Promise<TradeResponseResult>;

  /** Resolve your own trade offer after all responses are in */
  resolveTradeOffer(
    state: GameState,
    turnLog: TurnLog,
    offer: TradeOffer,
    responses: TradeResponse[],
  ): Promise<TradeResolutionResult>;

  /** Post-roll: play dev card? (Knight allowed if not used pre-roll) */
  decidePostRollDevCard(
    state: GameState,
    turnLog: TurnLog,
    knightUsedThisTurn: boolean,
  ): Promise<PostRollDevCardResult>;

  /** Post-roll trade: propose offer or return null to stop trading */
  proposeNextTrade(
    state: GameState,
    turnLog: TurnLog,
    tradesLeft: number,
  ): Promise<PostRollTradeResult>;

  /** Build phase: place settlements/cities/roads, buy dev card, bank trade */
  decideBuild(
    state: GameState,
    turnLog: TurnLog,
    validBuildActions: PlayerAction[],
    retryHint?: string,
  ): Promise<BuildResult>;

  /** Announce robber threat / demands before placement (or skip directly to placement) */
  proposeRobberThreat(state: GameState, turnLog: TurnLog): Promise<RobberThreatResult>;

  /** Respond to active player's robber threat — offer concession or decline */
  respondToRobberThreat(
    state: GameState,
    turnLog: TurnLog,
    threatMsg: string,
    demandedGive: Partial<ResourceCounts> | undefined,
  ): Promise<RobberConcessionResult>;

  /** Move robber after rolling 7 or playing Knight (after negotiation) */
  decideRobber(state: GameState, turnLog: TurnLog): Promise<RobberResult>;

  /** Discard half resources when 7 is rolled and player has >7 */
  decideDiscard(state: GameState, discardCount: number): Promise<DiscardResult>;
}

// ─── Pip probability table ────────────────────────────────────────────────────
// Reflects how many ways each number can be rolled on 2d6

const PIPS: Record<number, number> = {
  2: 1, 3: 2, 4: 3, 5: 4, 6: 5,
  8: 5, 9: 4, 10: 3, 11: 2, 12: 1,
};

// ─── Shared formatting helpers ────────────────────────────────────────────────

function fmt(r: Partial<ResourceCounts>): string {
  return RESOURCES.filter(res => (r[res] ?? 0) > 0)
    .map(res => `${r[res]} ${res}`)
    .join(', ') || 'nothing';
}

function fmtFull(r: ResourceCounts): string {
  return RESOURCES.map(res => `${res}:${r[res]}`).join(' ');
}

function formatTurnLog(turnLog: TurnLog): string {
  if (turnLog.length === 0) return '  (no events yet this turn)';
  return turnLog.map(e => {
    const tag = e.phase.toUpperCase().replace('_', '-');
    return `  [${tag}] ${e.fromName}: ${e.publicMessage}`;
  }).join('\n');
}

function formatStateHeader(state: GameState, playerId: string): string {
  const player = state.players.find(p => p.id === playerId)!;
  const vp = calculateVP(state, playerId);
  const lines: string[] = [];

  // Board
  lines.push('BOARD:');
  for (const hex of state.hexes.values()) {
    const robber = hex.hasRobber ? ' [ROBBER]' : '';
    const num = hex.number ? `#${hex.number}` : 'desert';
    lines.push(`  ${hex.id}: ${hex.type.toUpperCase()} ${num}${robber}`);
  }

  // Buildings on board
  const buildings = [...state.vertices.values()].filter(v => v.building);
  if (buildings.length) {
    lines.push('BUILDINGS ON BOARD:');
    for (const v of buildings) {
      const owner = state.players.find(p => p.id === v.building!.playerId)!;
      const port = v.port ? ` [${v.port}-port]` : '';
      lines.push(`  ${v.id}: ${owner.name}(${owner.color}) ${v.building!.type}${port}`);
    }
  }

  // Roads on board
  const roads = [...state.edges.values()].filter(e => e.road);
  if (roads.length) {
    lines.push('ROADS ON BOARD:');
    for (const e of roads) {
      const owner = state.players.find(p => p.id === e.road)!;
      lines.push(`  ${e.id}: ${owner.name}(${owner.color})`);
    }
  }

  // Your status
  lines.push('YOUR STATUS:');
  lines.push(`  Name: ${player.name} | Color: ${player.color} | VP: ${vp}/10`);
  lines.push(`  Resources: ${fmtFull(player.resources)}`);
  lines.push(`  Dev cards in hand: ${player.devCards.join(', ') || 'none'}`);
  lines.push(`  Pieces left: ${player.settlementsLeft} settlements, ${player.citiesLeft} cities, ${player.roadsLeft} roads`);
  lines.push(`  Trade rates: ${RESOURCES.map(r => `${r}=${bankTradeRatio(state, playerId, r)}:1`).join(', ')}`);
  if (player.hasLongestRoad) lines.push('  ** Longest Road (+2 VP) **');
  if (player.hasLargestArmy) lines.push('  ** Largest Army (+2 VP) **');

  // Special cards — Longest Road & Largest Army
  lines.push('SPECIAL CARDS (each worth +2 VP):');
  {
    const lrHolder = state.longestRoadPlayer ? state.players.find(p => p.id === state.longestRoadPlayer)?.name : null;
    const lrThreshold = state.longestRoadLength; // need strictly more than this to steal/claim
    lines.push(`  LONGEST ROAD (need >${lrThreshold} roads to claim/steal): ${lrHolder ? `${lrHolder} holds it (${lrThreshold} roads)` : `unclaimed (need >4 to claim)`}`);
    lines.push(`    ⚠ RULE: To STEAL Longest Road you must have MORE roads than the current holder — a TIE is NOT enough. The holder keeps the card on a tie.`);
    for (const p of state.players) {
      const len = calculateLongestRoad(state, p.id);
      const needed = lrThreshold + 1 - len;
      const mark = p.id === playerId ? ' ← YOU' : '';
      const status = p.hasLongestRoad ? ` [HOLDS IT — ${len} roads]` : needed <= 0 ? ' [can claim now — build 1 road!]' : needed === 1 ? ` [${len} roads — tied with holder! Need 1 MORE road to steal it]` : ` [${len} roads — need ${needed} more to steal]`;
      lines.push(`    ${p.name}:${status}${mark}`);
    }
    const laHolder = state.largestArmyPlayer ? state.players.find(p => p.id === state.largestArmyPlayer)?.name : null;
    const laThreshold = state.largestArmySize;
    lines.push(`  LARGEST ARMY (need >${laThreshold} knights): ${laHolder ? `${laHolder} holds it (${laThreshold} knights)` : `unclaimed (need >2 to claim)`}`);
    for (const p of state.players) {
      const needed = laThreshold + 1 - p.knightsPlayed;
      const mark = p.id === playerId ? ' ← YOU' : '';
      const status = p.hasLargestArmy ? ' [HOLDS IT]' : needed <= 0 ? ' [can claim now!]' : ` (need ${needed} more knight${needed > 1 ? 's' : ''})`;
      lines.push(`    ${p.name}: ${p.knightsPlayed} knights played${status}${mark}`);
    }
  }

  // VP Standings & leader alert
  // Use visible VP for opponents (hides their secret victory_point dev cards)
  const allVPs = state.players.map(p => ({
    p,
    vp: p.id === playerId ? calculateVP(state, p.id) : calculateVisibleVP(state, p.id),
  })).sort((a, b) => b.vp - a.vp);
  const maxVP = allVPs[0].vp;
  const avgVP = allVPs.reduce((s, x) => s + x.vp, 0) / allVPs.length;
  const myVP = calculateVP(state, playerId);
  const vpToWin = 10 - myVP;
  lines.push('STANDINGS (10 VP to win):');
  for (const { p: sp, vp: svp } of allVPs) {
    const mark = sp.id === playerId ? ' ← YOU' : '';
    const toWin = 10 - svp;
    const note = sp.id !== playerId ? ' (visible only — they may have hidden VP cards)' : '';
    lines.push(`  ${sp.name}: ${svp} VP (needs ${toWin} more)${note}${mark}`);
  }
  if (maxVP - avgVP >= 2) {
    const leader = allVPs[0].p;
    const leaderToWin = 10 - maxVP;
    if (leader.id !== playerId) {
      lines.push(`⚠ LEADER ALERT: ${leader.name} needs only ${leaderToWin} more VP to win (has ${maxVP}, avg ${avgVP.toFixed(1)}).`);
      lines.push(`  → DO NOT TRADE with ${leader.name} — every resource you give them accelerates their win.`);
      lines.push(`  → ROBBER must go on ${leader.name}'s highest-pip hex every time you get it.`);
      lines.push(`  → CALL FOR COALITION: tell other players to also stop trading with ${leader.name}.`);
      lines.push(`  → If you've previously stated you won't trade with ${leader.name}, HONOR that commitment.`);
      lines.push(`  → This is your highest priority. Losing 1 resource to slow them is worth it.`);
    } else {
      lines.push(`⚠ YOU ARE THE LEADER: You need ${vpToWin} more VP. Others will try to block you.`);
      lines.push(`  → Build as fast as possible — you need ${vpToWin} more VP before they organize.`);
      lines.push(`  → Offer trades that benefit multiple players so they have reason to keep trading with you.`);
    }
  }

  // Passive player alert
  if (state.turnSummaries.length >= 3) {
    const recentBuilt = state.turnSummaries.slice(-3).some(ts =>
      ts.events.some(e => e.includes(player.name) && e.includes('built:'))
    );
    if (!recentBuilt && myVP < maxVP) {
      lines.push(`⚠ STAGNATION ALERT: You have not built anything in the last ${Math.min(3, state.turnSummaries.length)} turns.`);
      lines.push(`  → You are falling behind. Prioritize building this turn above all else.`);
      lines.push(`  → Trade aggressively to get what you need. Do not end this turn without building.`);
    }
  }

  // Opponents — full resource breakdown visible to all
  lines.push('OPPONENTS (exact resources visible — dev cards hidden):');
  for (const other of state.players) {
    if (other.id === playerId) continue;
    const otherVP = calculateVisibleVP(state, other.id);
    const bonuses: string[] = [];
    if (other.hasLongestRoad) bonuses.push('LR+2VP');
    if (other.hasLargestArmy) bonuses.push('LA+2VP');
    const bonusStr = bonuses.length ? ` [${bonuses.join(',')}]` : '';
    const resStr = fmtFull(other.resources);
    const devCardCount = other.devCards.length;
    const devStr = devCardCount > 0 ? ` | ${devCardCount} hidden dev card${devCardCount > 1 ? 's' : ''}` : '';
    // What are they missing for common builds?
    const needs: string[] = [];
    const missingSettlement = RESOURCES.filter(r => (other.resources[r] ?? 0) < (BUILD_COSTS.settlement[r] ?? 0)).map(r => `${BUILD_COSTS.settlement[r] - other.resources[r]} ${r}`);
    const missingCity = RESOURCES.filter(r => (other.resources[r] ?? 0) < (BUILD_COSTS.city[r] ?? 0)).map(r => `${BUILD_COSTS.city[r] - other.resources[r]} ${r}`);
    const missingRoad = RESOURCES.filter(r => (other.resources[r] ?? 0) < (BUILD_COSTS.road[r] ?? 0)).map(r => `${BUILD_COSTS.road[r] - other.resources[r]} ${r}`);
    if (missingSettlement.length === 0) needs.push('can build SETTLEMENT');
    else if (missingSettlement.length <= 2) needs.push(`needs ${missingSettlement.join('+')} for settlement`);
    if (missingCity.length === 0) needs.push('can build CITY');
    else if (missingCity.length <= 2) needs.push(`needs ${missingCity.join('+')} for city`);
    if (missingRoad.length === 0) needs.push('can build road');
    const needStr = needs.length ? ` | ${needs.join('; ')}` : '';
    lines.push(`  ${other.name}: ${otherVP} VP${bonusStr} | ${resStr}${devStr}${needStr}`);
  }

  // Turn history (last 5 turns)
  if (state.turnSummaries.length > 0) {
    const recent = state.turnSummaries.slice(-5);
    lines.push('RECENT TURN HISTORY (last ' + recent.length + ' turns):');
    for (const ts of recent) {
      lines.push(`  Turn ${ts.turn}:`);
      for (const ev of ts.events) lines.push('  ' + ev);
    }
  }

  return lines.join('\n');
}

function describeVertexForPlacement(state: GameState, vertexId: string): string {
  const v = state.vertices.get(vertexId);
  if (!v) return vertexId;
  let totalPips = 0;
  const hexParts = v.hexIds.map(hid => {
    const h = state.hexes.get(hid)!;
    if (h.type === 'desert') return 'desert';
    const pips = PIPS[h.number ?? 0] ?? 0;
    totalPips += pips;
    return `${h.number}-${h.type}`;
  }).join(', ');
  const port = v.port ? ` [${v.port.toUpperCase()}-PORT]` : '';
  const occupied = v.building ? ` [TAKEN by ${state.players.find(p => p.id === v.building!.playerId)?.name}]` : '';
  return `  "${hexParts}"  ★${totalPips} pips${port}${occupied}  (id: ${vertexId})`;
}

/** Describes a setup road edge in terms of where it leads away from the settlement */
function describeEdgeForSetup(state: GameState, edgeId: string, settlementVertexId: string): string {
  const edge = state.edges.get(edgeId);
  if (!edge) return `  edge ${edgeId}`;
  const leadVid = edge.vertexIds.find(v => v !== settlementVertexId) ?? edge.vertexIds[0];
  const lead = state.vertices.get(leadVid);
  if (!lead) return `  edge ${edgeId}`;

  let totalPips = 0;
  const hexParts = lead.hexIds.map(hid => {
    const h = state.hexes.get(hid)!;
    if (h.type === 'desert') return 'DESERT';
    const pips = PIPS[h.number ?? 0] ?? 0;
    totalPips += pips;
    return `${h.type.toUpperCase()}#${h.number}(${pips}✦)`;
  }).join(' + ');
  const port = lead.port ? ` [${lead.port.toUpperCase()}-PORT]` : '';
  const occupied = lead.building ? ` [BLOCKED by ${state.players.find(p => p.id === lead.building!.playerId)?.name}]` : '';
  const hexLabel = lead.hexIds.map(hid => {
    const h = state.hexes.get(hid)!;
    return h.type === 'desert' ? 'desert' : `${h.number}-${h.type}`;
  }).join(', ');
  return `  → "${hexLabel}"  ★${totalPips} pips${port}${occupied}  (id: ${edgeId})`;
}

function describeHexesForRobber(state: GameState, myPlayerId: string): string {
  const lines: string[] = [];
  for (const hex of state.hexes.values()) {
    const current = hex.hasRobber ? ' ← CURRENT ROBBER (cannot place here)' : '';
    // Collect unique players with buildings adjacent to this hex (excluding self)
    const adjMap = new Map<string, { name: string; hasRes: boolean }>();
    for (const v of state.vertices.values()) {
      if (v.hexIds.includes(hex.id) && v.building && v.building.playerId !== myPlayerId) {
        const pid = v.building.playerId;
        if (!adjMap.has(pid)) {
          const p = state.players.find(pl => pl.id === pid)!;
          adjMap.set(pid, { name: p.name, hasRes: totalResources(p.resources) > 0 });
        }
      }
    }
    const stealOptions = adjMap.size
      ? ' | STEAL FROM: ' + [...adjMap.entries()].map(([id, info]) =>
          `${info.name}(id:${id})${info.hasRes ? '' : '[no resources]'}`
        ).join(' or ')
      : ' | no stealable opponents';
    const num = hex.number ? `#${hex.number}` : 'DESERT';
    lines.push(`  ${hex.id}: ${hex.type.toUpperCase()} ${num}${stealOptions}${current}`);
  }
  return lines.join('\n');
}

function describeBuildActions(state: GameState, actions: PlayerAction[], playerId: string): string {
  const byType = new Map<string, PlayerAction[]>();
  for (const a of actions) {
    if (!byType.has(a.type)) byType.set(a.type, []);
    byType.get(a.type)!.push(a);
  }
  const lines: string[] = [];
  for (const [type, list] of byType) {
    if (type === 'place_settlement' || type === 'place_city') {
      const described = list.slice(0, 8).map(a => {
        const vid = (a as { vertexId: string }).vertexId;
        return describeVertexForPlacement(state, vid);
      }).join('\n    ');
      const more = list.length > 8 ? `\n    ...${list.length - 8} more` : '';
      lines.push(`  ${type}:\n    ${described}${more}`);
    } else if (type === 'place_road') {
      const eids = list.slice(0, 8).map(a => (a as { edgeId: string }).edgeId).join(', ');
      const more = list.length > 8 ? ` ...+${list.length - 8}` : '';
      lines.push(`  place_road: ${eids}${more}`);
    } else if (type === 'trade_bank') {
      const trades = list.slice(0, 6).map(a => {
        const t = a as { give: ResourceType; receive: ResourceType };
        const ratio = bankTradeRatio(state, playerId, t.give);
        return `${ratio}×${t.give}→1×${t.receive}`;
      }).join(', ');
      lines.push(`  trade_bank: ${trades}`);
    } else {
      lines.push(`  ${type}: available`);
    }
  }
  return lines.join('\n');
}

// ─── JSON extraction / fallback parsers ──────────────────────────────────────

function extractJSON(raw: string): unknown {
  const block = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const str = block ? block[1] : raw;
  const match = str.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found');
  return JSON.parse(match[0]);
}

function safeExtract(raw: string): Record<string, unknown> {
  try { return extractJSON(raw) as Record<string, unknown>; }
  catch { return {}; }
}

function parsePartialResources(obj: unknown): Partial<ResourceCounts> {
  if (!obj || typeof obj !== 'object') return {};
  const result: Partial<ResourceCounts> = {};
  for (const res of RESOURCES) {
    const val = (obj as Record<string, unknown>)[res];
    if (typeof val === 'number' && val > 0) result[res] = val;
  }
  return result;
}

// ─── Robber impact helper ─────────────────────────────────────────────────────

function describeRobberImpact(state: GameState, playerId: string): string | null {
  const robberHex = [...state.hexes.values()].find(h => h.hasRobber);
  if (!robberHex || robberHex.type === 'desert') return null;

  // Check if any of MY buildings are adjacent to the robber hex
  const myBlockedBuildings: string[] = [];
  for (const v of state.vertices.values()) {
    if (v.building?.playerId === playerId && v.hexIds.includes(robberHex.id)) {
      const pips = PIPS[robberHex.number ?? 0] ?? 0;
      const type = v.building.type === 'city' ? 'CITY' : 'settlement';
      myBlockedBuildings.push(`${type} on ${robberHex.number}-${robberHex.type} (${pips} pips — ${pips > 3 ? 'HIGH' : 'medium'} frequency)`);
    }
  }
  if (myBlockedBuildings.length === 0) return null;

  const pips = PIPS[robberHex.number ?? 0] ?? 0;
  return `🚨 ROBBER ALERT — The robber is on YOUR ${robberHex.type.toUpperCase()} hex (${robberHex.id}, #${robberHex.number}, ${pips} pips)!\n` +
    `  Blocked: ${myBlockedBuildings.join('; ')}\n` +
    `  You are losing ${robberHex.type} income every time ${robberHex.number} is rolled. MOVE IT.`;
}

function describeKnightHolders(state: GameState, playerId: string): string | null {
  // Only reveal who has dev cards (count), not what type — card contents are private
  const others = state.players.filter(p => p.id !== playerId && p.devCards.length > 0);
  if (others.length === 0) return null;
  return `  Players with dev cards (may include Knights): ${others.map(p => `${p.name} (${p.devCards.length})`).join(', ')} — consider offering them a trade to incentivize playing a Knight on their turn.`;
}

// ─── Monopoly strategy hint ───────────────────────────────────────────────────

/**
 * If the player holds a Monopoly card, analyse the "dirty monopoly" strategy:
 * trade away your own copies of a resource first (getting value back), THEN play
 * Monopoly to reclaim them + whatever opponents hold.
 *
 * Returns a hint block to inject into prompts, or null if no Monopoly card.
 */
function buildMonopolyHint(state: GameState, playerId: string, phase: 'pre_roll' | 'post_roll'): string | null {
  const player = state.players.find(p => p.id === playerId)!;
  if (!player.devCards.includes('monopoly')) return null;

  const opponents = state.players.filter(p => p.id !== playerId);

  // For each resource compute clean vs dirty yield
  const analysis = (RESOURCES as ResourceType[]).map(res => {
    const opponentTotal = opponents.reduce((s, p) => s + p.resources[res], 0);
    const ownHoldings = player.resources[res];
    const cleanYield = opponentTotal;         // just play now
    const dirtyYield = opponentTotal + ownHoldings; // trade away yours first, reclaim all
    return { res, opponentTotal, ownHoldings, cleanYield, dirtyYield };
  });

  // Best target by dirty yield
  const best = [...analysis].sort((a, b) => b.dirtyYield - a.dirtyYield)[0];
  if (best.dirtyYield === 0) return null; // nothing to gain

  const lines: string[] = [];
  lines.push('★ MONOPOLY STRATEGY ALERT:');

  if (phase === 'pre_roll') {
    lines.push('  You hold a MONOPOLY dev card. Consider the "dirty monopoly" strategy:');
    lines.push('  1. BEFORE rolling, trade away your own copies of the target resource (get something valuable in return).');
    lines.push('  2. After rolling, play Monopoly on that resource — you steal back what you traded PLUS everything opponents hold.');
    lines.push('');
    lines.push('  Current opponent holdings per resource:');
    for (const { res, opponentTotal, ownHoldings, cleanYield, dirtyYield } of analysis) {
      if (cleanYield === 0 && ownHoldings === 0) continue;
      const dirtyNote = ownHoldings > 0
        ? ` | trade away your ${ownHoldings} first → dirty yield: ${dirtyYield}`
        : '';
      lines.push(`    ${res}: opponents hold ${opponentTotal} (clean yield: ${cleanYield})${dirtyNote}`);
    }
    if (best.ownHoldings > 0) {
      lines.push(`  → Best dirty target: ${best.res} — trade your ${best.ownHoldings} away for good value, then mono for ${best.dirtyYield} total.`);
    } else if (best.cleanYield > 0) {
      lines.push(`  → Best clean target: ${best.res} — opponents hold ${best.cleanYield}. Play Monopoly post-roll.`);
    }
  } else {
    // post_roll — remind them of the opportunity
    lines.push('  You hold a MONOPOLY card. Best target based on current opponent holdings:');
    for (const { res, opponentTotal, ownHoldings, dirtyYield } of analysis.filter(a => a.opponentTotal > 0 || a.ownHoldings > 0)) {
      const note = ownHoldings > 0
        ? ` (you have ${ownHoldings} — if you traded them away pre-roll you would have gotten ${dirtyYield} total)`
        : '';
      lines.push(`    ${res}: steal ${opponentTotal} from opponents${note}`);
    }
    if (best.ownHoldings > 0) {
      lines.push(`  ⚠ You still hold ${best.ownHoldings} ${best.res} — if you DIDN'T trade them away pre-roll, you missed extra value.`);
      lines.push(`    Playing Monopoly on ${best.res} now still nets ${best.cleanYield} from opponents.`);
    }
  }

  return lines.join('\n');
}

// ─── Phase prompt builders ────────────────────────────────────────────────────

function buildPreRollPrompt(
  state: GameState, playerId: string, turnLog: TurnLog, tradesLeft: number,
): string {
  const player = state.players.find(p => p.id === playerId)!;
  const hasKnight = player.devCards.includes('knight');

  const robberAlert = describeRobberImpact(state, playerId);
  const knightHolders = robberAlert ? describeKnightHolders(state, playerId) : null;

  let robberBlock = '';
  if (robberAlert) {
    robberBlock = `\n${robberAlert}`;
    if (hasKnight) {
      robberBlock += `\n  ★ YOU HAVE A KNIGHT — play it NOW to move the robber off your tile before rolling!`;
    } else if (knightHolders) {
      robberBlock += `\n${knightHolders}`;
    } else {
      robberBlock += `\n  You have no Knight. Consider trading aggressively to acquire one, or wait for a 7.`;
    }
    robberBlock += '\n';
  }

  const monoHint = buildMonopolyHint(state, playerId, 'pre_roll');

  return `=== PRE-ROLL PHASE | Turn ${state.turn} | ${player.name}'s Turn ===${robberBlock}

${formatStateHeader(state, playerId)}

TURN LOG SO FAR:
${formatTurnLog(turnLog)}

${buildMarketIntel(state, playerId)}
${monoHint ? '\n' + monoHint + '\n' : ''}
PRE-ROLL OPTIONS:
You act BEFORE rolling the dice. Trade offers and Knight use happen NOW and are visible to all.
Trade offers remaining this turn: ${tradesLeft}
${hasKnight ? '★ You have a KNIGHT card — playing it BEFORE a trade offer lets you move the robber as leverage.' : ''}
⚠ DEV CARD REMINDER: You may only play ONE dev card per turn (not counting VP cards, which are automatic). Do NOT sit on action cards (Knight, Monopoly, Road Building, Year of Plenty) — play them when the moment is right. Hoarding them turns them to waste.

Choose any combination:
• publicMessage: say something at the table (bluff, threaten, negotiate — everyone hears this)
• playKnight: announce you're playing a Knight (robber placement + theft happen in a SEPARATE step after negotiation)
• tradeOffer: propose a player-to-player exchange (other players respond sequentially)
• readyToRoll: true when you're done with pre-roll actions

Respond with JSON ONLY:
{
  "reasoning": "your private strategic thinking (other players never see this)",
  "publicMessage": "optional statement at the table",
  "playKnight": null,
  "tradeOffer": null,
  "readyToRoll": true
}

tradeOffer format: { "give": { "wood": 2 }, "want": { "ore": 1 }, "publicMessage": "..." }
playKnight: set to true to play the Knight card. Where you move the robber is decided AFTER a negotiation round where others may pay concessions to spare themselves.
Set readyToRoll: false if you want to act again this pre-roll phase after responses come back.`;
}

/** Returns a block reminding the player of prior public commitments to not trade with someone */
function buildCommitmentReminder(state: GameState, playerId: string, offeringPlayerId: string): string {
  const offeringPlayer = state.players.find(p => p.id === offeringPlayerId)!;
  // Scan recent turn summaries for this player's commentary mentioning the offerer
  const commitmentKeywords = ["won't trade", "will not trade", "stop trading", "not trading", "refuse to trade", "boycott"];
  const mentions: string[] = [];
  for (const ts of state.turnSummaries.slice(-5)) {
    for (const ev of ts.events) {
      if (!ev.includes(offeringPlayer.name)) continue;
      const me = state.players.find(p => p.id === playerId)!;
      if (!ev.includes(me.name)) continue;
      if (commitmentKeywords.some(kw => ev.toLowerCase().includes(kw))) {
        mentions.push(`Turn ${ts.turn}: ${ev.trim()}`);
      }
    }
  }
  if (mentions.length === 0) return '';
  return `⚠ COMMITMENT REMINDER: You previously stated you would not trade with ${offeringPlayer.name}:
${mentions.map(m => `  "${m}"`).join('\n')}
Honor your stated position — breaking commitments damages your credibility with all players.

`;
}

/** Returns true if this vertex is a valid settlement spot — no building here or on adjacent vertices */
function isOpenSettlementSpot(vertexId: string, state: GameState): boolean {
  const v = state.vertices.get(vertexId);
  if (!v || v.building) return false;
  for (const adjId of adjacentVertices(vertexId, state.edges)) {
    if (state.vertices.get(adjId)?.building) return false;
  }
  return true;
}

/** Summarise a vertex as "11-wood, 6-wheat, 9-ore ★14 pips [PORT]" */
function describeVertexBrief(state: GameState, vertexId: string): string {
  const v = state.vertices.get(vertexId);
  if (!v) return vertexId;
  let pips = 0;
  const hexes = v.hexIds.map(hid => {
    const h = state.hexes.get(hid)!;
    if (h.type === 'desert') return 'desert';
    const p = PIPS[h.number ?? 0] ?? 0;
    pips += p;
    return `${h.number}-${h.type}`;
  }).join(', ');
  const port = v.port ? ` [${v.port.toUpperCase()}-PORT]` : '';
  return `"${hexes}" ★${pips} pips${port}`;
}

/**
 * Classifies a road's purpose: does it lead toward an open settlement spot?
 * Also returns a description of the target spot for context.
 */
function roadSettlementPurpose(edgeId: string, state: GameState, playerId: string): {
  tag: string; open: boolean;
} {
  const edge = state.edges.get(edgeId);
  if (!edge) return { tag: '[no path data]', open: false };

  // Identify the "forward" vertex — the one we're building toward
  const forwardVid = edge.vertexIds.find(vid => {
    const v = state.vertices.get(vid);
    return !v?.building || v.building.playerId !== playerId;
  }) ?? edge.vertexIds[1];

  // Check if it's immediately a valid settlement spot
  if (isOpenSettlementSpot(forwardVid, state)) {
    return { tag: `✅ OPENS SETTLEMENT NOW — settle at ${describeVertexBrief(state, forwardVid)} after building this road`, open: true };
  }

  // Check 1 more road away
  const oneAway: string[] = [];
  for (const adjId of adjacentVertices(forwardVid, state.edges)) {
    if (isOpenSettlementSpot(adjId, state)) oneAway.push(describeVertexBrief(state, adjId));
  }
  if (oneAway.length > 0) {
    return { tag: `📍 1 more road → settlement at ${oneAway[0]}`, open: true };
  }

  // Check 2 more roads away
  for (const adjId of adjacentVertices(forwardVid, state.edges)) {
    for (const adj2Id of adjacentVertices(adjId, state.edges)) {
      if (isOpenSettlementSpot(adj2Id, state)) {
        return { tag: `🔜 2 more roads → settlement at ${describeVertexBrief(state, adj2Id)}`, open: true };
      }
    }
  }

  return { tag: '❌ NO settlement access — dead end', open: false };
}

function buildTradeResponsePrompt(
  state: GameState,
  playerId: string,
  turnLog: TurnLog,
  offer: TradeOffer,
  priorResponses: TradeResponse[],
): string {
  const player = state.players.find(p => p.id === playerId)!;
  const offeringPlayer = state.players.find(p => p.id === offer.offeredBy)!;

  const priorStr = priorResponses.length
    ? priorResponses.map(r => {
        const rp = state.players.find(p => p.id === r.responderId)!;
        const status = r.accept ? 'ACCEPTS' : 'REJECTS';
        const counter = r.counter ? ` | counter: give ${fmt(r.counter.give)}, want ${fmt(r.counter.want)}` : '';
        return `  ${rp.name}: ${status}${counter} — "${r.publicMessage}"`;
      }).join('\n')
    : '  (you are first to respond)';

  const pipMap = boardResourcePips(state);
  const wantedRes = Object.keys(offer.want ?? {}).filter(r => (offer.want[r as keyof typeof offer.want] ?? 0) > 0);
  const leverageLines = wantedRes.map(r => {
    const pips = pipMap[r] ?? 0;
    const scarce = pips <= 10 ? ' — SCARCE on this board, you can demand more' : '';
    return `  You hold ${r} (${pips} board pips${scarce})`;
  });
  const leverageStr = leverageLines.length ? `\nYOUR LEVERAGE:\n${leverageLines.join('\n')}` : '';

  const canPay = RESOURCES.every(r => (player.resources[r] ?? 0) >= (offer.want[r as ResourceType] ?? 0));
  const resourceCheck = `⚠ RESOURCE CHECK — this trade requires you to GIVE: ${fmt(offer.want)}
Your hand: ${fmtFull(player.resources)}
${canPay
  ? `✓ You CAN fulfill this trade.`
  : `✗ YOU CANNOT FULFILL THIS TRADE — you are missing resources. You MUST set "accept": false.`}`;

  // Build what-can-I-build analysis
  const handAfterTrade = { ...player.resources } as ResourceCounts;
  for (const r of RESOURCES) {
    handAfterTrade[r] = (handAfterTrade[r] ?? 0) - (offer.want[r] ?? 0) + (offer.give[r] ?? 0);
  }
  const canBuildNow = (cost: Partial<ResourceCounts>) =>
    RESOURCES.every(r => (player.resources[r] ?? 0) >= (cost[r as ResourceType] ?? 0));
  const canBuildAfter = (cost: Partial<ResourceCounts>) =>
    RESOURCES.every(r => (handAfterTrade[r] ?? 0) >= (cost[r as ResourceType] ?? 0));

  const buildAnalysis: string[] = [];
  for (const [item, cost] of Object.entries(BUILD_COSTS)) {
    const before = canBuildNow(cost);
    const after = canBuildAfter(cost);
    if (!before && after) buildAnalysis.push(`  ✅ UNLOCKS ${item} — you COULD NOT build this before, but CAN after the trade`);
    else if (before && !after) buildAnalysis.push(`  ❌ LOSES ${item} — you CAN build this now, but CANNOT after giving resources away`);
  }
  // Check if the received resource gets us closer to something
  const receivedRes = RESOURCES.filter(r => (offer.give[r] ?? 0) > 0);
  const givenRes = RESOURCES.filter(r => (offer.want[r] ?? 0) > 0);
  const valueLines: string[] = [];
  for (const r of receivedRes) {
    const pips = pipMap[r] ?? 0;
    const scarce = pips <= 10 ? 'SCARCE (hard to get from dice)' : pips <= 14 ? 'moderate production' : 'abundant';
    valueLines.push(`  You RECEIVE ${offer.give[r]} ${r} — board production: ${pips} pips (${scarce})`);
  }
  for (const r of givenRes) {
    const pips = pipMap[r] ?? 0;
    const scarce = pips <= 10 ? 'SCARCE (hard to replace)' : pips <= 14 ? 'moderate production' : 'abundant';
    valueLines.push(`  You GIVE ${offer.want[r]} ${r} — board production: ${pips} pips (${scarce})`);
    const bankRate = bankTradeRatio(state, playerId, r);
    if (bankRate <= 2) valueLines.push(`    ⚠ You have a ${bankRate}:1 port for ${r} — you can convert this cheaply at the bank instead`);
  }

  const tradeValueSection = `
TRADE VALUE ANALYSIS — think selfishly, not charitably:
${valueLines.join('\n')}
${buildAnalysis.length ? buildAnalysis.join('\n') : '  (no change in what you can immediately build)'}

YOUR HAND after this trade would be: ${fmtFull(handAfterTrade)}

SELF-INTEREST RULE: Only accept if this trade advances YOUR path to 10 VP.
Ask yourself: Does receiving ${fmt(offer.give)} actually help me build something, develop faster, or reach a goal?
Is giving away ${fmt(offer.want)} something I can afford to lose right now?
If you are being asked to give a resource you genuinely need, or are receiving something useless to you, REJECT or COUNTER.
Accepting trades out of politeness or to avoid conflict is poor strategy — every resource matters.`;

  return `=== TRADE OFFER | Turn ${state.turn} ===

${offeringPlayer.name}(${offeringPlayer.color}) offers:
  GIVE you: ${fmt(offer.give)}
  WANT from you: ${fmt(offer.want)}
  "${offer.publicMessage}"

${resourceCheck}
${tradeValueSection}

TURN LOG:
${formatTurnLog(turnLog)}

PRIOR RESPONSES (in order):
${priorStr}

You are: ${player.name}(${player.color}) | ${calculateVP(state, playerId)} VP
${leverageStr}

${buildCommitmentReminder(state, playerId, offer.offeredBy)}If other players already accepted, the offerer may renegotiate to better terms — factor this into your decision.
Counter-offer if the deal undervalues your resources or if you want more in exchange.

OPTIONAL COMMENT:
You may include a brief "comment" — a public remark visible to all players (separate from your trade response).
Use it to: call out a dominant player everyone should stop trading with, warn others about a lopsided deal,
or react to something noteworthy. Only include it if genuinely worth saying — leave null otherwise.
Do NOT repeat warnings already made in the turn log above — check what's already been said and say something new or stay silent.

Respond with JSON ONLY:
{
  "reasoning": "private thinking — evaluate whether this trade helps YOUR path to 10 VP",
  "accept": true,
  "counter": null,
  "publicMessage": "required — what you say at the table",
  "comment": null
}

counter format: { "give": { "wood": 1 }, "want": { "ore": 1 } }
A counter is shown to everyone. The active player decides whether to accept it.
comment: optional string shown to all (e.g. "Everyone stop trading with DeepSeek, they're running away with it!") or null.`;
}

function buildTradeResolutionPrompt(
  state: GameState,
  playerId: string,
  turnLog: TurnLog,
  offer: TradeOffer,
  responses: TradeResponse[],
): string {
  const player = state.players.find(p => p.id === playerId)!;

  const responseSummary = responses.map(r => {
    const rp = state.players.find(p => p.id === r.responderId)!;
    const hasRes = (obj: Partial<ResourceCounts>) =>
      RESOURCES.every(res => (rp.resources[res] ?? 0) >= (obj[res] ?? 0));

    if (r.accept) {
      const canDo = hasRes(offer.want);
      return `  ${rp.name}: ACCEPTS${canDo ? '' : ' ⚠ (may lack resources)'} — "${r.publicMessage}"`;
    } else {
      let counterStr = '';
      if (r.counter) {
        const canDoCounter = hasRes(r.counter.give);
        counterStr = `\n    counter offer: they give ${fmt(r.counter.give)}, you give ${fmt(r.counter.want)}${canDoCounter ? '' : ' ⚠ (may lack resources)'}`;
      }
      return `  ${rp.name}: REJECTS${counterStr} — "${r.publicMessage}"`;
    }
  }).join('\n');

  const acceptors = responses.filter(r => r.accept);
  const multipleAccept = acceptors.length >= 2;
  const renegotiateBlock = multipleAccept
    ? `\n★ MULTIPLE PLAYERS ACCEPTED (${acceptors.map(r => state.players.find(p => p.id === r.responderId)!.name).join(', ')})
  You can RENEGOTIATE — propose revised (better) terms to all acceptors instead of settling.
  They will each re-respond to your new offer. Use this to maximize your gain.
  Set "renegotiate" in your response with new give/want that favors you more.`
    : '';

  return `=== TRADE RESOLUTION | Turn ${state.turn} ===

Your original offer: give ${fmt(offer.give)}, want ${fmt(offer.want)}
Your resources: ${fmtFull(player.resources)}
${buildMarketIntel(state, player.id)}

RESPONSES:
${responseSummary}
${renegotiateBlock}

TURN LOG:
${formatTurnLog(turnLog)}

${multipleAccept
  ? 'RECOMMENDED: Renegotiate for better terms since multiple players accepted. Only pick acceptFrom if you are satisfied with the original offer.'
  : 'Choose who to trade with (if anyone). Pick the most favorable response.'}
Your resources must cover the "give" side.

Respond with JSON ONLY:
{
  "reasoning": "private thinking",
  "acceptFrom": null,
  "acceptCounter": false,
  "renegotiate": null,
  "publicMessage": "required — what you announce"
}

acceptFrom: null = decline all | "p2" or "PlayerName" = accept from that player at original terms
acceptCounter: true = accept their counter-offer instead of original terms (only if picking one player)
renegotiate: null = don't renegotiate | { "give": {...}, "want": {...}, "publicMessage": "..." } = propose new terms to all acceptors (only valid when 2+ accepted)`;
}

function buildRoadBuildingEdgeHint(state: GameState, playerId: string): string {
  const candidates: { eid: string; hexDesc: string; pips: number; purpose: { tag: string; open: boolean } }[] = [];
  for (const edge of state.edges.values()) {
    if (!isValidRoadSpot(state, edge.id, playerId)) continue;
    const forwardVid = edge.vertexIds.find(vid => {
      const v = state.vertices.get(vid);
      return !v?.building || v.building.playerId !== playerId;
    }) ?? edge.vertexIds[1];
    const fv = forwardVid ? state.vertices.get(forwardVid) : null;
    let pips = 0;
    const hexDesc = (fv?.hexIds ?? []).map(hid => {
      const h = state.hexes.get(hid)!;
      if (h.type === 'desert') return 'desert';
      const p = PIPS[h.number ?? 0] ?? 0;
      pips += p;
      return `${h.number}-${h.type}`;
    }).join(', ');
    const purpose = roadSettlementPurpose(edge.id, state, playerId);
    const port = fv?.port ? ` [${fv.port.toUpperCase()}-PORT]` : '';
    candidates.push({ eid: edge.id, hexDesc: hexDesc + port, pips, purpose });
  }
  candidates.sort((a, b) => {
    if (a.purpose.open !== b.purpose.open) return a.purpose.open ? -1 : 1;
    return b.pips - a.pips;
  });
  if (candidates.length === 0) return '';
  const listed = candidates.slice(0, 10).map(r =>
    `  ${r.purpose.tag}  "${r.hexDesc}" ★${r.pips}  id: "${r.eid}"`
  ).join('\n');
  return `\nROAD BUILDING — valid edge IDs (copy EXACTLY — do NOT invent IDs):\n${listed}\n`;
}

function buildPostRollDevCardPrompt(
  state: GameState,
  playerId: string,
  turnLog: TurnLog,
  knightUsedThisTurn: boolean,
): string {
  const player = state.players.find(p => p.id === playerId)!;
  const roll = state.lastRoll;
  const rollStr = roll ? `${roll[0]}+${roll[1]}=${roll[0] + roll[1]}` : '?';

  const playableCards = player.devCards.filter(c => {
    if (c === 'knight') return !knightUsedThisTurn;
    if (c === 'victory_point') return false;
    return true;
  });

  const robberAlert = describeRobberImpact(state, playerId);
  const robberBlock = (robberAlert && !knightUsedThisTurn && player.devCards.includes('knight'))
    ? `\n${robberAlert}\n  ★ YOU HAVE A KNIGHT — play it NOW to remove the robber from your tile!\n`
    : robberAlert ? `\n${robberAlert}\n` : '';

  const monoHint = buildMonopolyHint(state, playerId, 'post_roll');
  const roadHint = playableCards.includes('road_building') ? buildRoadBuildingEdgeHint(state, playerId) : '';

  return `=== POST-ROLL DEV CARD PHASE | Turn ${state.turn} ===${robberBlock}

You rolled: ${rollStr}
Your resources: ${fmtFull(player.resources)}
${formatStateHeader(state, playerId)}

TURN LOG:
${formatTurnLog(turnLog)}

Playable dev cards: ${playableCards.join(', ') || 'none'}
${knightUsedThisTurn ? '(Knight already used this turn)' : ''}
${monoHint ? '\n' + monoHint + '\n' : ''}${roadHint}
Play at most ONE dev card now. Skip with both fields null.

DEV CARD RULES:
• You may play at most 1 dev card per turn (Knight OR one action card — never both).
• Victory point cards are AUTOMATIC — they score at the end of the game without being played.
• DO NOT hoard dev cards. Action cards (Knight, Road Building, Year of Plenty, Monopoly) lose value the longer you wait — play them as soon as the timing is good.
• If you have an action card and a relevant situation (robber on you → play Knight; need resources → Year of Plenty/Monopoly; want to expand roads → Road Building), PLAY IT NOW.

Respond with JSON ONLY:
{
  "reasoning": "private thinking",
  "publicMessage": null,
  "playKnight": null,
  "playDevCard": null
}

playKnight: true  (robber placement happens separately after a negotiation round)
playDevCard examples:
  { "type": "road_building", "edgeId1": "...", "edgeId2": "..." }
  { "type": "year_of_plenty", "resource1": "ore", "resource2": "wheat" }
  { "type": "monopoly", "resource": "ore" }`;
}

// ─── Market intelligence ──────────────────────────────────────────────────────

function boardResourcePips(state: GameState): Record<string, number> {
  const pips: Record<string, number> = { wood: 0, brick: 0, wheat: 0, sheep: 0, ore: 0 };
  for (const hex of state.hexes.values()) {
    if (hex.type !== 'desert' && hex.number && PIPS[hex.number]) {
      pips[hex.type] = (pips[hex.type] ?? 0) + PIPS[hex.number];
    }
  }
  return pips;
}

function buildMarketIntel(state: GameState, playerId: string): string {
  const lines: string[] = ['MARKET INTELLIGENCE:'];
  const opponents = state.players.filter(p => p.id !== playerId);

  // Resource scarcity
  const pipMap = boardResourcePips(state);
  const sorted = (RESOURCES as string[]).slice().sort((a, b) => (pipMap[a] ?? 0) - (pipMap[b] ?? 0));
  lines.push('  Board scarcity (fewer pips = rarer = higher trade value):');
  for (const r of sorted) {
    const p = pipMap[r] ?? 0;
    const tag = p <= 10 ? ' ★ SCARCE — demand a premium' : p >= 20 ? ' (abundant)' : '';
    lines.push(`    ${r}: ${p} pips${tag}`);
  }

  // Opponent port leverage
  lines.push('  Opponent bank rates (reveals port access — lower = they can undercut you):');
  for (const opp of opponents) {
    const rates = RESOURCES.map(r => {
      const ratio = bankTradeRatio(state, opp.id, r);
      return ratio < 4 ? `${ratio}:1 ${r}` : null;
    }).filter(Boolean);
    const portStr = rates.length ? rates.join(', ') : 'no ports (4:1 all)';
    const devCount = opp.devCards.length;
    const devNote = devCount > 0 ? ` | ${devCount} dev card${devCount > 1 ? 's' : ''} (unknown)` : '';
    lines.push(`    ${opp.name}: ${portStr} | ${totalResources(opp.resources)} resource cards${devNote} | ${calculateVisibleVP(state, opp.id)} visible VP`);
  }

  // Exact opponent resources + what they need (use this to target trade offers)
  lines.push('  OPPONENT RESOURCES & NEEDS (exact — use to decide who to trade with and what to ask for):');
  for (const opp of opponents) {
    const resStr = fmtFull(opp.resources);
    const total = totalResources(opp.resources);
    if (total === 0) { lines.push(`    ${opp.name}: EMPTY HAND — cannot trade anything`); continue; }
    // What they have that you might want
    const theyHave = RESOURCES.filter(r => opp.resources[r] > 0).map(r => `${opp.resources[r]} ${r}`);
    // What they're missing for builds (= what they'd pay for)
    const wantForSettlement = RESOURCES.filter(r => (opp.resources[r] ?? 0) < BUILD_COSTS.settlement[r]).map(r => `${r}`);
    const wantForCity = RESOURCES.filter(r => (opp.resources[r] ?? 0) < BUILD_COSTS.city[r]).map(r => `${r}`);
    const wantForRoad = RESOURCES.filter(r => (opp.resources[r] ?? 0) < BUILD_COSTS.road[r]).map(r => `${r}`);
    const urgentNeeds: string[] = [];
    if (wantForSettlement.length <= 2 && wantForSettlement.length > 0) urgentNeeds.push(`wants ${wantForSettlement.join('+')} (1-2 away from settlement)`);
    if (wantForCity.length <= 2 && wantForCity.length > 0) urgentNeeds.push(`wants ${wantForCity.join('+')} (1-2 away from city)`);
    if (wantForRoad.length === 1) urgentNeeds.push(`wants ${wantForRoad[0]} (1 away from road)`);
    lines.push(`    ${opp.name}: has [${theyHave.join(', ')}]${urgentNeeds.length ? ' — ' + urgentNeeds.join('; ') : ''}`);
  }

  lines.push('  STRATEGY REMINDERS:');
  lines.push('  • You hold a scarce resource → start high, others will still accept.');
  lines.push('  • Multiple players accept → RENEGOTIATE for better terms, or pick the best counter-offer.');
  lines.push('  • Players near a build goal are willing to overpay — exploit urgency.');
  lines.push('  • Never give a resource away cheap if your bank rate for it is already 2:1 or 3:1.');

  return lines.join('\n');
}

function buildPostRollTradePrompt(
  state: GameState,
  playerId: string,
  turnLog: TurnLog,
  tradesLeft: number,
): string {
  const player = state.players.find(p => p.id === playerId)!;

  return `=== TRADE PHASE | Turn ${state.turn} ===

Trade offers remaining this turn: ${tradesLeft}
Your resources: ${fmtFull(player.resources)}
Your bank rates: ${RESOURCES.map(r => `${r}=${bankTradeRatio(state, playerId, r)}:1`).join(', ')}

${buildMarketIntel(state, playerId)}

TURN LOG:
${formatTurnLog(turnLog)}

Propose a trade offer, or set offer to null to move on to building.
If multiple players accept, you will get a chance to renegotiate for better terms.
Be aggressive — start offers in your favor and adjust only if needed.

IMPORTANT: Resources you receive from a trade ARE immediately available to spend in the BUILD PHASE this turn.
If you are 1 resource short of a settlement or city, USE THIS TRADE PHASE to get it — then build immediately after.
Do not skip trading if a trade would let you build a settlement or city this turn.

Respond with JSON ONLY:
{
  "reasoning": "private thinking",
  "offer": null
}

offer format: { "give": { "wood": 1 }, "want": { "ore": 2 }, "publicMessage": "..." }
You must have the resources you offer to give.`;
}

function missingResources(have: ResourceCounts, cost: ResourceCounts): string {
  const missing = RESOURCES.filter(r => (have[r] ?? 0) < (cost[r] ?? 0))
    .map(r => `${cost[r] - (have[r] ?? 0)} ${r}`);
  return missing.join(', ');
}

function describeBuildStatus(state: GameState, player: Player, validActions: PlayerAction[]): string {
  const res = player.resources;
  const lines: string[] = [];
  const validTypes = new Set(validActions.map(a => a.type));

  // Settlement
  const canSettlement = validTypes.has('place_settlement');
  if (canSettlement) {
    const settlementActions = validActions.filter(a => a.type === 'place_settlement');
    // Sort best-first by pip total (same as setup)
    const withPips = settlementActions.map(a => {
      const vid = (a as any).vertexId as string;
      const v = state.vertices.get(vid);
      const pips = (v?.hexIds ?? []).reduce((sum, hid) => {
        const h = state.hexes.get(hid)!;
        return sum + (PIPS[h.number ?? 0] ?? 0);
      }, 0);
      return { vid, pips };
    }).sort((a, b) => b.pips - a.pips);
    const spots = withPips.slice(0, 8).map(({ vid }) => describeVertexForPlacement(state, vid)).join('\n    ');
    const more = withPips.length > 8 ? `\n    ...+${withPips.length - 8} more` : '';
    lines.push(`✓ CAN BUILD settlement [+1 VP + new resource income every roll] (1 wood + 1 brick + 1 wheat + 1 sheep):\n    ${spots}${more}`);
  } else {
    const missing = missingResources(res, BUILD_COSTS.settlement);
    const reason = missing ? `missing: ${missing}` : 'no valid spot or pieces remaining';
    lines.push(`✗ CANNOT build settlement [+1 VP + income] — ${reason}`);
  }

  // Road
  const canRoad = validTypes.has('place_road');
  if (canRoad) {
    const roadActions = validActions.filter(a => a.type === 'place_road');

    // Classify each road by settlement purpose, sort useful ones first
    const classified = roadActions.map(a => {
      const eid = (a as any).edgeId as string;
      const edge = state.edges.get(eid);
      const purpose = roadSettlementPurpose(eid, state, player.id);
      const farVid = edge?.vertexIds.find(vid => {
        const v = state.vertices.get(vid);
        return !v?.building || v.building.playerId !== player.id;
      }) ?? edge?.vertexIds[1];
      const far = farVid ? state.vertices.get(farVid) : null;
      let totalPips = 0;
      const hexDesc = (far?.hexIds ?? []).map(hid => {
        const h = state.hexes.get(hid)!;
        if (h.type === 'desert') return 'desert';
        const pips = PIPS[h.number ?? 0] ?? 0;
        totalPips += pips;
        return `${h.number}-${h.type}`;
      }).join(', ');
      const port = far?.port ? ` [${far.port.toUpperCase()}-PORT]` : '';
      return { eid, hexDesc, totalPips, port, purpose, open: purpose.open };
    }).sort((a, b) => {
      // Sort: open paths first (by pip value), then dead ends
      if (a.open !== b.open) return a.open ? -1 : 1;
      return b.totalPips - a.totalPips;
    });

    // Longest Road context
    const myRoadLen = calculateLongestRoad(state, player.id);
    const lrThreshold = state.longestRoadLength;
    const lrHolder = state.longestRoadPlayer;
    const roadsToLR = lrThreshold + 1 - myRoadLen;
    const lrContext = lrHolder === player.id
      ? `  You HOLD Longest Road (${myRoadLen} roads). Defend it — anyone matching your count does NOT steal it; they must EXCEED it.`
      : myRoadLen === lrThreshold
      ? `  ★ You are TIED with the holder at ${myRoadLen} roads — but a TIE does NOT steal the card! You need EXACTLY 1 more road to exceed the holder and take Longest Road (+2 VP).`
      : roadsToLR <= 2
      ? `  ★ You need only ${roadsToLR} more road(s) to EXCEED the holder (${lrThreshold}) and claim Longest Road (+2 VP)!`
      : `  Longest Road needs >${lrThreshold} roads; you have ${myRoadLen} (${roadsToLR} away — not close enough to chase).`;

    const hasUsefulRoad = classified.some(r => r.open);
    const purposeWarning = !hasUsefulRoad && roadsToLR > 2
      ? `\n  ⚠ WARNING: No road leads toward a settlement spot AND you are not close to Longest Road.\n  Building a road right now wastes 1 wood + 1 brick with no strategic return. SKIP roads this turn.`
      : '';

    const described = classified.slice(0, 12).map(r =>
      `  → "${r.hexDesc}" ★${r.totalPips} pips${r.port}  ${r.purpose.tag}  (id: ${r.eid})`
    ).join('\n');
    const more = classified.length > 12 ? `\n  ...+${classified.length - 12} more` : '';

    lines.push(`✓ CAN BUILD road (1 wood + 1 brick):\n${lrContext}${purposeWarning}\n  ⚠ Only build a road if it has ✅, 📍, or 🔜 purpose (i.e. within 2 roads of a settlement spot), OR if you are ≤2 roads from Longest Road.\n${described}${more}`);
  } else {
    const missing = missingResources(res, BUILD_COSTS.road);
    const reason = missing ? `missing: ${missing}` : 'no valid spot or pieces remaining';
    lines.push(`✗ CANNOT build road — ${reason}`);
  }

  // City
  const canCity = validTypes.has('place_city');
  if (canCity) {
    const spots = validActions.filter(a => a.type === 'place_city')
      .map(a => describeVertexForPlacement(state, (a as any).vertexId)).join('\n    ');
    lines.push(`✓ CAN BUILD city [+1 VP + doubles resource income on that hex] (2 wheat + 3 ore):\n    ${spots}`);
  } else {
    const mySettlements = [...state.vertices.values()]
      .filter(v => v.building?.playerId === player.id && v.building.type === 'settlement');
    const missing = missingResources(res, BUILD_COSTS.city);
    const reason = missing ? `missing: ${missing}` : mySettlements.length === 0 ? 'no settlements to upgrade' : 'no pieces remaining';
    lines.push(`✗ CANNOT build city [+1 VP + doubles income] — ${reason}`);
  }

  // Dev card
  const canDev = validTypes.has('buy_dev_card');
  if (canDev) {
    lines.push(`✓ CAN BUY dev card (1 wheat + 1 sheep + 1 ore)`);
  } else {
    const missing = missingResources(res, BUILD_COSTS.dev_card);
    const reason = missing ? `missing: ${missing}` : 'dev deck is empty';
    lines.push(`✗ CANNOT buy dev card — ${reason}`);
  }

  // Bank trades
  const bankTrades = validActions.filter(a => a.type === 'trade_bank');
  if (bankTrades.length > 0) {
    const tradeStrs = bankTrades.slice(0, 6).map(a => {
      const t = a as { give: ResourceType; receive: ResourceType };
      const ratio = bankTradeRatio(state, player.id, t.give);
      return `${ratio}×${t.give}→1×${t.receive}`;
    }).join(', ');
    lines.push(`✓ CAN TRADE with bank: ${tradeStrs}`);
  } else {
    lines.push(`✗ CANNOT bank trade — not enough of any single resource`);
  }

  return lines.join('\n');
}

function buildBuildPrompt(
  state: GameState,
  playerId: string,
  turnLog: TurnLog,
  validActions: PlayerAction[],
  retryHint?: string,
): string {
  const player = state.players.find(p => p.id === playerId)!;
  const vp = calculateVP(state, playerId);

  const buildSummary = describeBuildStatus(state, player, validActions);
  const retryBlock = retryHint
    ? `\n⚠ RETRY — your previous response was rejected: ${retryHint}\nYou MUST pick from the valid list below. Do NOT invent IDs.\n`
    : '';

  return `=== BUILD PHASE | Turn ${state.turn} ===${retryBlock}

Your resources: ${fmtFull(player.resources)}
⚠ These are your ACTUAL current resources — they already include everything you gained from trades and dice rolls this turn. You can spend them right now.
VP: ${vp}/10
Dev cards: ${player.devCards.join(', ') || 'none'}

TURN LOG:
${formatTurnLog(turnLog)}

${buildSummary}

HOW SETTLEMENTS WORK (read carefully):
  • You can ONLY place a settlement at one of the spots listed under "✓ CAN BUILD settlement" above.
  • Those spots are the ONLY legal locations — they are connected to your existing road network AND have no adjacent buildings within 1 vertex (the distance rule).
  • You CANNOT place a settlement on any other vertex, even if it looks empty on the board.
  • If "✓ CAN BUILD settlement" is shown, you have both the resources AND a legal spot. DO IT — this is your highest priority.
  • If you want to settle a spot not in the list, you must BUILD A ROAD there first (over one or more turns), then the spot unlocks in a future turn.

BUILDING PRIORITY (highest to lowest VP/turn impact):
  1. CITY — doubles income on existing hex AND gives +1 VP. Best single investment.
  2. SETTLEMENT — new income stream on new hexes AND +1 VP. Second best.
  3. ROAD — ONLY build if it serves a clear purpose (see list above marked ✅, 📍, or 🔜), OR if you are ≤2 roads from claiming Longest Road (+2 VP).
     ✅ = immediately opens a settlement. 📍 = 1 more road needed. 🔜 = 2 more roads needed — still worth building to extend your network toward a future settlement.
     Roads marked ❌ lead nowhere useful — building them wastes 1 wood + 1 brick with zero return.
     A road that doesn't unlock a settlement spot and doesn't approach Longest Road is ALWAYS the wrong move.
  4. DEV CARD — Knights build toward Largest Army (+2 VP for >2 knights); may also draw VP card. NOTE: you can only play 1 dev card per turn (VP cards are automatic and don't count). Don't hoard action cards — use them!
  5. BANK TRADE — only to convert excess into what you need for a build this turn.
Do NOT pass on building if you can afford a settlement or city.
Do NOT build a road just to "do something" — save wood and brick for when you have a real destination.

IMPORTANT: You may ONLY choose actions marked ✓ CAN BUILD. Do NOT invent vertex/edge IDs. Copy them EXACTLY from the list.
buildActions can be empty [] if nothing is worth building right now.
List all actions you want to take in order (resources deducted after each).

Respond with JSON ONLY:
{
  "reasoning": "private thinking",
  "publicMessage": null,
  "buildActions": []
}

Action formats (replace the id: field with the actual ID string copied from the list above — never use placeholder text):
  { "type": "place_settlement", "vertexId": "0,0|0,1|1,0" }
  { "type": "place_road", "edgeId": "0,0|0,1|1,0||0,1|1,0|1,1" }
  { "type": "place_city", "vertexId": "0,0|0,1|1,0" }
  { "type": "buy_dev_card" }
  { "type": "trade_bank", "give": "wood", "receive": "ore" }`;
}

function buildRobberThreatPrompt(state: GameState, playerId: string, turnLog: TurnLog): string {
  const player = state.players.find(p => p.id === playerId)!;
  const opponents = state.players.filter(p => p.id !== playerId);

  const opponentLines = opponents.map(p => {
    const total = RESOURCES.reduce((s, r) => s + p.resources[r], 0);
    return `  ${p.name} (${p.id}): ${fmtFull(p.resources)} [${total} total]`;
  }).join('\n');

  return `=== ROBBER NEGOTIATION — THREAT PHASE | Turn ${state.turn} ===

You are about to move the robber. Before placing it, you may threaten other players to extract concessions.
They will see your message and decide whether to pay you to spare them.
After their responses, you will decide where to place the robber and whether to accept a concession.

TURN LOG:
${formatTurnLog(turnLog)}

OPPONENTS (resources visible):
${opponentLines}

HEXES available for robber:
${describeHexesForRobber(state, playerId)}

Your resources: ${fmtFull(player.resources)}

Respond with JSON ONLY:
{
  "reasoning": "private strategic thinking",
  "publicMessage": "what you say at the table (threat, demand, or bluff)",
  "demands": [{ "targetId": "p2", "give": { "ore": 1 } }],
  "skip": false
}

demands: array of players you're threatening and what you want from each (can threaten multiple).
skip: set true to skip negotiation and place the robber immediately (no concession round).
publicMessage is required even if skip=true.`;
}

function buildRobberConcessionPrompt(
  state: GameState,
  playerId: string,
  turnLog: TurnLog,
  threatMsg: string,
  demandedGive: Partial<ResourceCounts> | undefined,
): string {
  const player = state.players.find(p => p.id === playerId)!;
  const activePlayer = state.players.find(p => p.id !== playerId && state.currentPlayerIndex === state.players.indexOf(p))
    ?? state.players[state.currentPlayerIndex];

  const demandStr = demandedGive && Object.keys(demandedGive).some(k => (demandedGive[k as ResourceType] ?? 0) > 0)
    ? `They specifically demand you give: ${fmt(demandedGive)}`
    : 'They have not specified a specific demand for you — you may voluntarily offer resources.';

  const canAffordDemand = demandedGive
    ? RESOURCES.every(r => (player.resources[r] ?? 0) >= (demandedGive[r as ResourceType] ?? 0))
    : true;

  return `=== ROBBER NEGOTIATION — CONCESSION PHASE | Turn ${state.turn} ===

${activePlayer.name} is about to move the robber and said:
"${threatMsg}"

${demandStr}
${demandedGive && !canAffordDemand ? `⚠ You cannot fulfill their exact demand (insufficient resources). You may offer less or nothing.` : ''}

TURN LOG:
${formatTurnLog(turnLog)}

Your resources: ${fmtFull(player.resources)}

Decide: pay a concession to avoid the robber, or call their bluff and offer nothing.
If you concede, the active player may still place the robber on you — it's not guaranteed to spare you, but it gives them incentive.

OPTIONAL COMMENT:
You may include a "comment" — a brief public aside visible to all (e.g. calling out the threat as extortion,
warning others about this player's dominance, or rallying allies). Leave null if nothing worth saying.
Do NOT repeat points already made in the turn log — check what's been said and add something new or stay silent.

Respond with JSON ONLY:
{
  "reasoning": "private thinking — is the threat credible? can I afford it? is it worth it?",
  "concede": true,
  "give": { "ore": 1 },
  "publicMessage": "required — what you say at the table",
  "comment": null
}

concede: false = refuse to pay anything (give should be null or omitted).
give: what you're offering to the active player (must be resources you actually have).
comment: optional public remark (string) or null.`;
}

function buildRobberPrompt(state: GameState, playerId: string, turnLog: TurnLog): string {
  const player = state.players.find(p => p.id === playerId)!;

  // Extract concessions from turnLog
  const concessionEntries = turnLog.filter(e => e.phase === 'robber' && e.data?.isConcessionResponse);
  const concessionStr = concessionEntries.length > 0
    ? `\nCONCESSION RESPONSES (from your threat):\n${concessionEntries.map(e => `  ${e.fromName}: ${e.publicMessage}`).join('\n')}\n\nYou may accept at most ONE concession (set acceptConcessionFrom to their playerId). The resources transfer before you place the robber.`
    : '\n(No concession negotiation occurred — place robber directly.)';

  return `=== ROBBER PLACEMENT | Turn ${state.turn} ===

Move the robber to any hex (not its current location, marked "CURRENT ROBBER").
${concessionStr}

TURN LOG:
${formatTurnLog(turnLog)}

HEXES WITH STEAL OPTIONS:
${describeHexesForRobber(state, playerId)}

Your resources: ${fmtFull(player.resources)}

STEALING RULES:
- stealFrom must be the playerId of a player with a building ON THE HEX YOU CHOSE (see "STEAL FROM:" above)
- If the hex has stealable opponents, you SHOULD set stealFrom — you get a random one of their resources
- If multiple opponents are on the hex, pick the one you want to steal from
- stealFrom is null only if the hex has no opponents or they all have zero resources

Respond with JSON ONLY:
{
  "reasoning": "private thinking",
  "hexId": "q,r",
  "stealFrom": "p2",
  "acceptConcessionFrom": null,
  "publicMessage": "required — what you say"
}

acceptConcessionFrom: playerId of the player whose concession you accept, or null to accept none.`;
}

function buildDiscardPrompt(state: GameState, playerId: string, discardCount: number): string {
  const player = state.players.find(p => p.id === playerId)!;
  const total = totalResources(player.resources);

  // Show per-resource counts explicitly
  const handLines = RESOURCES.filter(r => player.resources[r] > 0)
    .map(r => `  ${r}: ${player.resources[r]}`)
    .join('\n');

  return `=== DISCARD | Turn ${state.turn} ===

A 7 was rolled. You have ${total} cards (more than 7) and MUST discard exactly ${discardCount} cards.

YOUR HAND:
${handLines}

⚠ RULES:
- You must discard exactly ${discardCount} cards total
- You can only discard resources you actually have (cannot discard more of a type than you hold)
- Discard your least valuable resources — keep what you need for your next build
- Prioritize keeping: resources needed for settlements, cities, or roads you plan to build soon

Respond with JSON ONLY:
{
  "reasoning": "which resources are least useful to keep and why",
  "resources": { "wood": 1, "sheep": 1 }
}

resources: exactly what you are discarding — must sum to ${discardCount} and not exceed what you have.`;
}

function buildSetupPrompt(
  state: GameState, playerId: string, validActions: PlayerAction[], context: string,
): string {
  const player = state.players.find(p => p.id === playerId)!;
  const n = state.players.length;
  const isRound2 = state.setupIndex >= n;
  const overallPick = state.setupIndex + 1;  // 1-indexed, settlement pick number

  const settlements = validActions.filter(a => a.type === 'place_settlement');
  const roads       = validActions.filter(a => a.type === 'place_road');

  // ── Snake draft context ────────────────────────────────────────────────────
  const draftLines: string[] = [];
  draftLines.push(`You are pick #${overallPick} of ${n * 2} total placements (snake draft).`);
  if (!isRound2) {
    const picksBeforeYou    = state.setupIndex;
    const picksAfterInRound = (n - 1) - state.setupIndex;
    draftLines.push(`Round 1: ${picksBeforeYou} player(s) have already picked. ${picksAfterInRound} player(s) pick after you before the snake reverses.`);
    if (state.setupIndex === 0)
      draftLines.push('You pick FIRST — choose a strong all-round intersection. You pick LAST in round 2, so plan for flexibility.');
    else if (state.setupIndex === n - 1)
      draftLines.push('You pick LAST in round 1 and FIRST in round 2 — you get a double pick. Claim two dominant spots.');
    else
      draftLines.push(`Pick to complement future round-2 placement: aim for resources you cannot easily get in round 2.`);
  } else {
    // Describe the player's actual first settlement so the AI has accurate context
    const mySettlement = [...state.vertices.values()].find(v => v.building?.playerId === playerId);
    if (mySettlement) {
      const firstDesc = mySettlement.hexIds.map(hid => {
        const h = state.hexes.get(hid)!;
        return h.type === 'desert' ? 'desert' : `${h.number}-${h.type}`;
      }).join(', ');
      const firstPips = mySettlement.hexIds.reduce((sum, hid) => {
        const h = state.hexes.get(hid)!;
        return sum + (PIPS[h.number ?? 0] ?? 0);
      }, 0);
      const firstPort = mySettlement.port ? ` [${mySettlement.port.toUpperCase()}-PORT]` : '';
      draftLines.push(`Round 2 (REVERSE order). Your FIRST settlement is on: "${firstDesc}"  ★${firstPips} pips${firstPort}`);
      // Resources in hand now = what the second settlement just granted (filled after placement)
      const inHand = fmtFull(player.resources);
      draftLines.push(`Resources in hand from setup: ${inHand}`);
    }
    draftLines.push('Choose your SECOND settlement to complement your first — prioritize resources you are missing.');
    if (state.setupIndex === n)
      draftLines.push('You pick FIRST in round 2 — many spots are still open.');
    else if (state.setupIndex === n * 2 - 1)
      draftLines.push('You pick LAST in round 2 — popular intersections may already be taken. Find the best remaining spot.');
  }

  // ── Board summary ──────────────────────────────────────────────────────────
  const boardLines: string[] = ['BOARD HEXES:'];
  for (const hex of state.hexes.values()) {
    if (hex.type === 'desert') {
      boardLines.push(`  ${hex.id}: DESERT (no production)`);
    } else {
      const pips = PIPS[hex.number ?? 0] ?? 0;
      const robber = hex.hasRobber ? ' [ROBBER]' : '';
      boardLines.push(`  ${hex.id}: ${hex.type.toUpperCase()} #${hex.number} (${pips}✦)${robber}`);
    }
  }

  // ── Settlement placement ───────────────────────────────────────────────────
  let actionDesc = '';
  if (settlements.length) {
    // Sort by pip total descending so best spots appear first
    const withPips = settlements.map(a => {
      const vid = (a as { vertexId: string }).vertexId;
      const v = state.vertices.get(vid);
      const pips = (v?.hexIds ?? []).reduce((sum, hid) => {
        const h = state.hexes.get(hid)!;
        return sum + (PIPS[h.number ?? 0] ?? 0);
      }, 0);
      return { a, vid, pips };
    }).sort((x, y) => y.pips - x.pips);

    const described = withPips.slice(0, 12).map(({ vid }) => describeVertexForPlacement(state, vid)).join('\n');
    const more = withPips.length > 12 ? `\n  ...${withPips.length - 12} more spots omitted` : '';
    actionDesc = `VALID SETTLEMENT SPOTS (sorted best first by pip total):\n${described}${more}

Pip key: 6 and 8 = 5✦ (rolled most often) | 5 and 9 = 4✦ | 4 and 10 = 3✦ | 3 and 11 = 2✦ | 2 and 12 = 1✦
Aim for ★10–13 pip total with 3 different resources. Ports are strong for a matching resource strategy.
${isRound2 ? '\nYour second settlement grants 1 of each adjacent resource immediately — factor this into your choice.' : ''}`;

  // ── Road placement ─────────────────────────────────────────────────────────
  } else if (roads.length) {
    // Find the settlement vertex (shared by all valid road edges)
    const settlementVid = (() => {
      const firstEdge = state.edges.get((roads[0] as { edgeId: string }).edgeId);
      if (!firstEdge) return null;
      return firstEdge.vertexIds.find(vid => state.vertices.get(vid)?.building?.playerId === playerId) ?? null;
    })();

    const described = roads.map(a => {
      const eid = (a as { edgeId: string }).edgeId;
      return settlementVid
        ? describeEdgeForSetup(state, eid, settlementVid)
        : `  edge ${eid}`;
    }).join('\n');

    // In round 2, also show the other settlement so the AI knows its full position
    const otherSettlements = [...state.vertices.values()].filter(
      v => v.building?.playerId === playerId && v.id !== settlementVid,
    );
    const otherSettlementDesc = otherSettlements.length
      ? `\nYour OTHER settlement: ${otherSettlements.map(v => describeVertexForPlacement(state, v.id)).join(', ')}`
      : '';

    actionDesc = `YOUR SETTLEMENT (place road here): ${settlementVid ? describeVertexForPlacement(state, settlementVid) : 'unknown'}${otherSettlementDesc}

VALID ROAD DIRECTIONS (each shows what vertex the road leads toward):
${described}

Place your road toward the highest-pip future settlement spot that is not blocked.
A good road opens access to a third intersection with diverse, high-probability resources.`;
  }

  const actionExample = roads.length
    ? `{ "type": "place_road", "edgeId": "0,0|0,1|1,0||0,1|1,0|1,1" }`
    : `{ "type": "place_settlement", "vertexId": "0,0|0,1|1,0" }`;

  return `=== SETUP PHASE | ${context} ===

SNAKE DRAFT POSITION:
${draftLines.join('\n')}

${boardLines.join('\n')}

${actionDesc}

Respond with JSON ONLY. In your reasoning, refer to spots by their resources and numbers (e.g. "the 6-sheep, 4-brick, 11-wood intersection") — never use raw IDs in the reasoning text. Copy the exact id string into the action field.
{
  "reasoning": "strategic thinking using resource+number names (e.g. 'I want the 6-ore, 5-wheat, 9-sheep spot because...')",
  "action": ${actionExample}
}`;
}

// ─── Phase response parsers ───────────────────────────────────────────────────

function parsePreRollResult(raw: string): PreRollResult {
  const d = safeExtract(raw);
  return {
    reasoning: String(d.reasoning ?? ''),
    publicMessage: d.publicMessage ? String(d.publicMessage) : undefined,
    playKnight: d.playKnight === true || d.playKnight === 'true' ? true : undefined,
    tradeOffer: d.tradeOffer && typeof d.tradeOffer === 'object'
      ? { give: parsePartialResources((d.tradeOffer as Record<string,unknown>).give),
          want: parsePartialResources((d.tradeOffer as Record<string,unknown>).want),
          publicMessage: String((d.tradeOffer as Record<string,unknown>).publicMessage ?? '') }
      : undefined,
    readyToRoll: d.readyToRoll !== false,
  };
}

function parseTradeResponseResult(raw: string): TradeResponseResult {
  const d = safeExtract(raw);
  return {
    reasoning: String(d.reasoning ?? ''),
    accept: d.accept === true,
    counter: d.counter && typeof d.counter === 'object' && !Array.isArray(d.counter)
      ? { give: parsePartialResources((d.counter as Record<string,unknown>).give),
          want: parsePartialResources((d.counter as Record<string,unknown>).want) }
      : undefined,
    publicMessage: String(d.publicMessage ?? '...'),
    comment: d.comment && typeof d.comment === 'string' && d.comment.trim() ? d.comment.trim() : undefined,
  };
}

function parseTradeResolutionResult(raw: string): TradeResolutionResult {
  const d = safeExtract(raw);
  let renegotiate: TradeResolutionResult['renegotiate'];
  if (d.renegotiate && typeof d.renegotiate === 'object' && !Array.isArray(d.renegotiate)) {
    const r = d.renegotiate as Record<string, unknown>;
    renegotiate = {
      give: parsePartialResources(r.give),
      want: parsePartialResources(r.want),
      publicMessage: String(r.publicMessage ?? '...'),
    };
  }
  return {
    reasoning: String(d.reasoning ?? ''),
    acceptFrom: d.acceptFrom ? String(d.acceptFrom) : undefined,
    acceptCounter: d.acceptCounter === true,
    renegotiate,
    publicMessage: String(d.publicMessage ?? '...'),
  };
}

function parsePostRollDevCardResult(raw: string): PostRollDevCardResult {
  const d = safeExtract(raw);
  let playDevCard: PostRollDevCardResult['playDevCard'] = undefined;

  if (d.playDevCard && typeof d.playDevCard === 'object') {
    const dc = d.playDevCard as Record<string, unknown>;
    const t = String(dc.type ?? '');
    if (t === 'road_building') {
      playDevCard = { type: 'road_building', edgeId1: String(dc.edgeId1 ?? ''), edgeId2: dc.edgeId2 ? String(dc.edgeId2) : undefined };
    } else if (t === 'year_of_plenty') {
      playDevCard = { type: 'year_of_plenty', resource1: String(dc.resource1 ?? 'wood') as ResourceType, resource2: String(dc.resource2 ?? 'wheat') as ResourceType };
    } else if (t === 'monopoly') {
      playDevCard = { type: 'monopoly', resource: String(dc.resource ?? 'ore') as ResourceType };
    }
  }

  return {
    reasoning: String(d.reasoning ?? ''),
    publicMessage: d.publicMessage ? String(d.publicMessage) : undefined,
    playKnight: d.playKnight === true || d.playKnight === 'true' ? true : undefined,
    playDevCard,
  };
}

function parsePostRollTradeResult(raw: string): PostRollTradeResult {
  const d = safeExtract(raw);
  if (!d.offer) return { reasoning: String(d.reasoning ?? ''), offer: null };
  const o = d.offer as Record<string, unknown>;
  return {
    reasoning: String(d.reasoning ?? ''),
    offer: {
      give: parsePartialResources(o.give),
      want: parsePartialResources(o.want),
      publicMessage: String(o.publicMessage ?? ''),
    },
  };
}

const PLACEHOLDER_PATTERN = /EXACT_ID|FROM_LIST|PLACEHOLDER|YOUR_ID|<.*>/i;

function parseBuildResult(raw: string): BuildResult {
  const d = safeExtract(raw);
  const rawActions = Array.isArray(d.buildActions) ? d.buildActions as PlayerAction[] : [];
  // Strip out any actions that contain placeholder text instead of real IDs
  const actions = rawActions.filter(a => {
    const vid = (a as any).vertexId;
    const eid = (a as any).edgeId;
    if (vid && PLACEHOLDER_PATTERN.test(String(vid))) return false;
    if (eid && PLACEHOLDER_PATTERN.test(String(eid))) return false;
    return true;
  });
  return {
    reasoning: String(d.reasoning ?? ''),
    publicMessage: d.publicMessage ? String(d.publicMessage) : undefined,
    buildActions: actions,
  };
}

function parseSetupResult(raw: string): SetupResult {
  const d = safeExtract(raw);
  const action = d.action as PlayerAction;
  return { reasoning: String(d.reasoning ?? ''), action: action as (import('../types').PlaceSettlementAction | import('../types').PlaceRoadAction) };
}

function parseRobberThreatResult(raw: string): RobberThreatResult {
  const d = safeExtract(raw);
  const demands: RobberThreatResult['demands'] = [];
  if (Array.isArray(d.demands)) {
    for (const item of d.demands) {
      if (item && typeof item === 'object') {
        const targetId = String((item as Record<string,unknown>).targetId ?? '');
        const give = parsePartialResources((item as Record<string,unknown>).give);
        if (targetId) demands.push({ targetId, give });
      }
    }
  }
  return {
    reasoning: String(d.reasoning ?? ''),
    publicMessage: String(d.publicMessage ?? '...'),
    demands: demands.length > 0 ? demands : undefined,
    skip: d.skip === true,
  };
}

function parseRobberConcessionResult(raw: string): RobberConcessionResult {
  const d = safeExtract(raw);
  return {
    reasoning: String(d.reasoning ?? ''),
    concede: d.concede === true,
    give: d.give && typeof d.give === 'object' ? parsePartialResources(d.give) : undefined,
    publicMessage: String(d.publicMessage ?? '...'),
    comment: d.comment && typeof d.comment === 'string' && d.comment.trim() ? d.comment.trim() : undefined,
  };
}

function parseRobberResult(raw: string): RobberResult {
  const d = safeExtract(raw);
  return {
    reasoning: String(d.reasoning ?? ''),
    hexId: String(d.hexId ?? '0,0'),
    stealFrom: d.stealFrom ? String(d.stealFrom) : undefined,
    acceptConcessionFrom: d.acceptConcessionFrom ? String(d.acceptConcessionFrom) : undefined,
    publicMessage: String(d.publicMessage ?? '...'),
  };
}

function parseDiscardResult(raw: string): DiscardResult {
  const d = safeExtract(raw);
  return {
    reasoning: String(d.reasoning ?? ''),
    resources: parsePartialResources(d.resources),
  };
}

// ─── Base agent (shared logic, subclasses override callModel) ─────────────────

abstract class BaseAgent implements AIAgent {
  constructor(
    public playerId: string,
    public playerName: string,
    public model: string,
    public reflection?: string,
  ) {}

  protected systemPrompt(): string {
    const base = `You are ${this.playerName}, an expert Catan player. Your goal is to reach 10 victory points first.\nBe strategic: threaten, negotiate, bluff, and build wisely.\nAlways respond with valid JSON only — no markdown, no extra text.`;
    if (this.reflection) {
      return base + `\n\nYOUR STRATEGIC MEMO (written by you after last turn — use it to guide your decisions):\n${this.reflection}`;
    }
    return base;
  }

  abstract callModel(system: string, user: string): Promise<string>;

  async decideSetup(state: GameState, validActions: PlayerAction[], context: string): Promise<SetupResult> {
    const prompt = buildSetupPrompt(state, this.playerId, validActions, context);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parseSetupResult(raw);
  }

  async decidePreRoll(state: GameState, turnLog: TurnLog, tradesLeft: number): Promise<PreRollResult> {
    const prompt = buildPreRollPrompt(state, this.playerId, turnLog, tradesLeft);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parsePreRollResult(raw);
  }

  async respondToTrade(state: GameState, turnLog: TurnLog, offer: TradeOffer, priorResponses: TradeResponse[]): Promise<TradeResponseResult> {
    const prompt = buildTradeResponsePrompt(state, this.playerId, turnLog, offer, priorResponses);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parseTradeResponseResult(raw);
  }

  async resolveTradeOffer(state: GameState, turnLog: TurnLog, offer: TradeOffer, responses: TradeResponse[]): Promise<TradeResolutionResult> {
    const prompt = buildTradeResolutionPrompt(state, this.playerId, turnLog, offer, responses);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parseTradeResolutionResult(raw);
  }

  async decidePostRollDevCard(state: GameState, turnLog: TurnLog, knightUsedThisTurn: boolean): Promise<PostRollDevCardResult> {
    const prompt = buildPostRollDevCardPrompt(state, this.playerId, turnLog, knightUsedThisTurn);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parsePostRollDevCardResult(raw);
  }

  async proposeNextTrade(state: GameState, turnLog: TurnLog, tradesLeft: number): Promise<PostRollTradeResult> {
    const prompt = buildPostRollTradePrompt(state, this.playerId, turnLog, tradesLeft);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parsePostRollTradeResult(raw);
  }

  async decideBuild(state: GameState, turnLog: TurnLog, validBuildActions: PlayerAction[], retryHint?: string): Promise<BuildResult> {
    const prompt = buildBuildPrompt(state, this.playerId, turnLog, validBuildActions, retryHint);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parseBuildResult(raw);
  }

  async proposeRobberThreat(state: GameState, turnLog: TurnLog): Promise<RobberThreatResult> {
    const prompt = buildRobberThreatPrompt(state, this.playerId, turnLog);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parseRobberThreatResult(raw);
  }

  async respondToRobberThreat(
    state: GameState,
    turnLog: TurnLog,
    threatMsg: string,
    demandedGive: Partial<ResourceCounts> | undefined,
  ): Promise<RobberConcessionResult> {
    const prompt = buildRobberConcessionPrompt(state, this.playerId, turnLog, threatMsg, demandedGive);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parseRobberConcessionResult(raw);
  }

  async decideRobber(state: GameState, turnLog: TurnLog): Promise<RobberResult> {
    const prompt = buildRobberPrompt(state, this.playerId, turnLog);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parseRobberResult(raw);
  }

  async decideDiscard(state: GameState, discardCount: number): Promise<DiscardResult> {
    const prompt = buildDiscardPrompt(state, this.playerId, discardCount);
    const raw = await this.callModel(this.systemPrompt(), prompt);
    return parseDiscardResult(raw);
  }
}

// ─── Model implementations ────────────────────────────────────────────────────

// ─── Rate-limit retry helper ──────────────────────────────────────────────────

function isRateLimitError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? 0;
  return status === 429 || msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('resource exhausted') || msg.toLowerCase().includes('too many requests');
}

async function withRetry<T>(
  name: string,
  fn: () => Promise<T>,
  maxAttempts = 8,
): Promise<T> {
  let delay = 15000; // start at 15s
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isRateLimitError(err) && attempt < maxAttempts) {
        console.warn(`  [${name}] Rate limited — waiting ${delay / 1000}s before retry (attempt ${attempt}/${maxAttempts})...`);
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 120000); // exponential backoff, cap at 2 min
      } else {
        throw err;
      }
    }
  }
  throw new Error(`${name}: max retry attempts reached`);
}

// ─── Agent implementations ────────────────────────────────────────────────────

class ClaudeAgent extends BaseAgent {
  private client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  async callModel(system: string, user: string): Promise<string> {
    try {
      return await withRetry(this.playerName, async () => {
        const res = await this.client.messages.create({
          model: this.model,
          max_tokens: 1200,
          system,
          messages: [{ role: 'user', content: user }],
        });
        return res.content[0].type === 'text' ? res.content[0].text : '{}';
      });
    } catch (err) {
      console.error(`[${this.playerName}] Anthropic error:`, (err as Error).message);
      return '{}';
    }
  }
}

class OpenAIAgent extends BaseAgent {
  private client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  async callModel(system: string, user: string): Promise<string> {
    try {
      return await withRetry(this.playerName, async () => {
        const res = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: 1200,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          response_format: { type: 'json_object' },
        });
        return res.choices[0]?.message?.content ?? '{}';
      });
    } catch (err) {
      console.error(`[${this.playerName}] OpenAI error:`, (err as Error).message);
      return '{}';
    }
  }
}

class GeminiAgent extends BaseAgent {
  private client = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY ?? '');

  async callModel(system: string, user: string): Promise<string> {
    try {
      return await withRetry(this.playerName, async () => {
        const genModel = this.client.getGenerativeModel({
          model: this.model,
          systemInstruction: system,
        });
        const res = await genModel.generateContent(user);
        return res.response.text();
      });
    } catch (err) {
      console.error(`[${this.playerName}] Gemini error:`, (err as Error).message);
      return '{}';
    }
  }
}

class XAIAgent extends BaseAgent {
  private client = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' });

  async callModel(system: string, user: string): Promise<string> {
    try {
      return await withRetry(this.playerName, async () => {
        const res = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: 1200,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        });
        return res.choices[0]?.message?.content ?? '{}';
      });
    } catch (err) {
      console.error(`[${this.playerName}] xAI error:`, (err as Error).message);
      return '{}';
    }
  }
}

class DeepSeekAgent extends BaseAgent {
  private client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' });

  async callModel(system: string, user: string): Promise<string> {
    try {
      return await withRetry(this.playerName, async () => {
        const res = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: 1200,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        });
        return res.choices[0]?.message?.content ?? '{}';
      });
    } catch (err) {
      console.error(`[${this.playerName}] DeepSeek error:`, (err as Error).message);
      return '{}';
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAgent(playerId: string, playerName: string, model: string, reflection?: string): AIAgent {
  if (model.startsWith('claude'))                                        return new ClaudeAgent(playerId, playerName, model, reflection);
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return new OpenAIAgent(playerId, playerName, model, reflection);
  if (model.startsWith('gemini'))                                        return new GeminiAgent(playerId, playerName, model, reflection);
  if (model.startsWith('grok'))                                          return new XAIAgent(playerId, playerName, model, reflection);
  if (model.startsWith('deepseek'))                                      return new DeepSeekAgent(playerId, playerName, model, reflection);
  return new ClaudeAgent(playerId, playerName, model, reflection);
}
