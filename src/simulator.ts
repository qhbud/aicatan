import * as fs from 'fs';
import * as path from 'path';
import {
  GameState, Player, PlayerAction, GameConfig, GameResult,
  ResourceCounts, ResourceType, BUILD_COSTS, RESOURCES,
  TurnLog, TurnEntry, TradeOffer, TradeResponse,
} from './types';
import { generateBoard } from './board';
import {
  createInitialState, logEvent, distributeResources, updateSpecialCards,
  checkWin, totalResources, deductCost, addResources, canAfford,
  currentSetupPlayer, grantSetupResources, getDiscardCount, calculateVP,
  bankTradeRatio,
} from './gameState';
import {
  validSetupSettlements, validSetupRoads, validBuildOnlyActions,
  validRobberPlacements, isValidSettlementSpot, isValidRoadSpot,
} from './rules';
import { AIAgent, createAgent } from './agents/agent';

// ─── Turn log helpers ─────────────────────────────────────────────────────────

function addEntry(
  turnLog: TurnLog,
  phase: TurnEntry['phase'],
  fromName: string,
  fromId: string | null,
  publicMessage: string,
  data?: Record<string, unknown>,
): void {
  turnLog.push({ phase, fromName, fromId, publicMessage, data });
}

function printEntry(entry: TurnEntry): void {
  const tag = entry.phase.toUpperCase().replace('_', '-');
  console.log(`  [${tag}] ${entry.fromName}: ${entry.publicMessage}`);
}

// ─── Dice ─────────────────────────────────────────────────────────────────────

function rollDice(): [number, number] {
  return [Math.ceil(Math.random() * 6), Math.ceil(Math.random() * 6)];
}

/** Returns true if rolling `total` would give at least one player a resource. */
function rollProducesResources(state: GameState, total: number): boolean {
  for (const hex of state.hexes.values()) {
    if (hex.number !== total || hex.hasRobber || hex.type === 'desert') continue;
    for (const v of state.vertices.values()) {
      if (v.building && v.hexIds.includes(hex.id)) return true;
    }
  }
  return false;
}

/** Roll until the result produces resources for at least one player (or 7 for robber). */
function rollDiceProductive(state: GameState): [number, number] {
  for (let attempt = 0; attempt < 20; attempt++) {
    const roll = rollDice();
    const total = roll[0] + roll[1];
    if (total === 7 || rollProducesResources(state, total)) return roll;
  }
  // Safety fallback: return whatever was last rolled (shouldn't happen in practice)
  return rollDice();
}

// ─── Resource formatting ──────────────────────────────────────────────────────

function fmtResources(r: Partial<ResourceCounts>): string {
  return RESOURCES.filter(res => (r[res] ?? 0) > 0)
    .map(res => `${r[res]} ${res}`)
    .join(', ') || 'nothing';
}

// ─── Player ordering ──────────────────────────────────────────────────────────

function getRespondOrder(state: GameState, activePlayerId: string): string[] {
  const idx = state.players.findIndex(p => p.id === activePlayerId);
  const order: string[] = [];
  for (let i = 1; i < state.players.length; i++) {
    order.push(state.players[(idx + i) % state.players.length].id);
  }
  return order;
}

// ─── Trade execution ──────────────────────────────────────────────────────────

function canExecutePlayerTrade(
  state: GameState,
  fromId: string,
  toId: string,
  give: Partial<ResourceCounts>,   // active player gives these
  want: Partial<ResourceCounts>,   // active player wants these
): boolean {
  const from = state.players.find(p => p.id === fromId)!;
  const to   = state.players.find(p => p.id === toId)!;

  for (const res of RESOURCES) {
    if (from.resources[res] < (give[res] ?? 0)) return false;
    if (to.resources[res]   < (want[res] ?? 0)) return false;
  }
  return true;
}

function executePlayerTrade(
  state: GameState,
  fromId: string,
  toId: string,
  give: Partial<ResourceCounts>,
  want: Partial<ResourceCounts>,
): void {
  const from = state.players.find(p => p.id === fromId)!;
  const to   = state.players.find(p => p.id === toId)!;

  for (const res of RESOURCES) {
    const g = give[res] ?? 0;
    const w = want[res] ?? 0;
    from.resources[res] -= g;
    to.resources[res]   += g;
    to.resources[res]   -= w;
    from.resources[res] += w;
  }
}

// ─── Apply a single build-phase action ───────────────────────────────────────

function applyBuildAction(state: GameState, playerId: string, action: PlayerAction): boolean {
  const player = state.players.find(p => p.id === playerId)!;

  switch (action.type) {
    case 'place_settlement': {
      if (!isValidSettlementSpot(state, action.vertexId, playerId, false)) return false;
      if (!canAfford(player.resources, BUILD_COSTS.settlement)) return false;
      state.vertices.get(action.vertexId)!.building = { type: 'settlement', playerId };
      player.settlementsLeft--;
      deductCost(player.resources, BUILD_COSTS.settlement);
      logEvent(state, playerId, 'build', `${player.name} builds settlement at ${action.vertexId}`);
      updateSpecialCards(state);
      return true;
    }
    case 'place_road': {
      const edge = state.edges.get(action.edgeId);
      if (!edge || edge.road !== null) return false;
      if (!isValidRoadSpot(state, action.edgeId, playerId)) return false;
      if (!canAfford(player.resources, BUILD_COSTS.road)) return false;
      edge.road = playerId;
      player.roadsLeft--;
      deductCost(player.resources, BUILD_COSTS.road);
      logEvent(state, playerId, 'build', `${player.name} builds road at ${action.edgeId}`);
      updateSpecialCards(state);
      return true;
    }
    case 'place_city': {
      const v = state.vertices.get(action.vertexId);
      if (!v || v.building?.playerId !== playerId || v.building?.type !== 'settlement') return false;
      if (!canAfford(player.resources, BUILD_COSTS.city)) return false;
      v.building.type = 'city';
      player.citiesLeft--;
      player.settlementsLeft++;
      deductCost(player.resources, BUILD_COSTS.city);
      logEvent(state, playerId, 'build', `${player.name} upgrades to city at ${action.vertexId}`);
      return true;
    }
    case 'buy_dev_card': {
      if (!canAfford(player.resources, BUILD_COSTS.dev_card) || state.devDeck.length === 0) return false;
      deductCost(player.resources, BUILD_COSTS.dev_card);
      const card = state.devDeck.shift()!;
      player.devCards.push(card);
      logEvent(state, playerId, 'build', `${player.name} buys a dev card`);
      return true;
    }
    case 'trade_bank': {
      const ratio = bankTradeRatio(state, playerId, action.give);
      if (player.resources[action.give] < ratio) return false;
      player.resources[action.give] -= ratio;
      player.resources[action.receive]++;
      logEvent(state, playerId, 'trade', `${player.name} bank-trades ${ratio}×${action.give} → 1×${action.receive}`);
      return true;
    }
    default:
      return false;
  }
}

// ─── Apply Knight card (announcement only — robber placed via runRobberNegotiation) ──────────────

function announceKnight(
  state: GameState,
  playerId: string,
  phase: 'pre_roll' | 'dev_card',
  turnLog: TurnLog,
): void {
  const player = state.players.find(p => p.id === playerId)!;
  const idx = player.devCards.indexOf('knight');
  if (idx === -1) return;

  player.devCards.splice(idx, 1);
  player.devCardPlayedThisTurn = true;
  player.knightsPlayed++;

  const msg = `plays KNIGHT — robber negotiation begins`;
  logEvent(state, playerId, 'dev_card', `${player.name} ${msg}`);
  const entry: TurnEntry = { phase, fromName: player.name, fromId: playerId, publicMessage: msg };
  turnLog.push(entry);
  printEntry(entry);

  updateSpecialCards(state);
}

// ─── Robber negotiation + placement ───────────────────────────────────────────

async function runRobberNegotiation(
  state: GameState,
  activePlayerId: string,
  agentMap: Map<string, AIAgent>,
  turnLog: TurnLog,
): Promise<void> {
  const activePlayer = state.players.find(p => p.id === activePlayerId)!;
  const activeAgent = agentMap.get(activePlayerId)!;

  // ── Threat phase ─────────────────────────────────────────────────────────────
  const threat = await activeAgent.proposeRobberThreat(state, turnLog);
  const threatEntry: TurnEntry = {
    phase: 'robber',
    fromName: activePlayer.name,
    fromId: activePlayerId,
    publicMessage: `[ROBBER THREAT] ${threat.publicMessage}`,
    reasoning: threat.reasoning,
    data: { isThreat: true, demands: threat.demands },
  };
  turnLog.push(threatEntry);
  printEntry(threatEntry);

  // Build demand map: targetId → give
  const demandMap = new Map<string, Partial<ResourceCounts>>();
  for (const d of (threat.demands ?? [])) demandMap.set(d.targetId, d.give);

  // ── Concession phase (skip if threat.skip) ────────────────────────────────
  const concessions: Array<{ playerId: string; name: string; give: Partial<ResourceCounts> }> = [];

  if (!threat.skip) {
    const respondOrder = getRespondOrder(state, activePlayerId);
    for (const responderId of respondOrder) {
      const responder = state.players.find(p => p.id === responderId)!;
      const agent = agentMap.get(responderId)!;
      const demand = demandMap.get(responderId);
      const result = await agent.respondToRobberThreat(state, turnLog, threat.publicMessage, demand);

      const concessionStr = result.concede && result.give
        ? ` offers: ${fmtResources(result.give)}`
        : ' offers nothing';
      const concessionEntry: TurnEntry = {
        phase: 'robber',
        fromName: responder.name,
        fromId: responderId,
        publicMessage: `[CONCESSION] ${result.concede ? 'CONCEDES' : 'DECLINES'}${concessionStr}: "${result.publicMessage}"`,
        reasoning: result.reasoning,
        data: { isConcessionResponse: true, concede: result.concede, give: result.give },
      };
      turnLog.push(concessionEntry);
      printEntry(concessionEntry);

      if (result.comment) {
        const commentEntry: TurnEntry = {
          phase: 'commentary',
          fromName: responder.name,
          fromId: responderId,
          publicMessage: result.comment,
        };
        turnLog.push(commentEntry);
        console.log(`  [COMMENTARY] ${responder.name}: ${result.comment}`);
      }

      if (result.concede && result.give && RESOURCES.some(r => (result.give![r] ?? 0) > 0)) {
        concessions.push({ playerId: responderId, name: responder.name, give: result.give });
      }
    }
  }

  // ── Placement phase ────────────────────────────────────────────────────────
  const robberResult = await activeAgent.decideRobber(state, turnLog);

  // Execute accepted concession first
  if (robberResult.acceptConcessionFrom) {
    const accepted = concessions.find(c => c.playerId === robberResult.acceptConcessionFrom);
    if (accepted) {
      const conceder = state.players.find(p => p.id === accepted.playerId)!;
      // Validate conceder has the resources
      const canPay = RESOURCES.every(r => (conceder.resources[r] ?? 0) >= (accepted.give[r] ?? 0));
      if (canPay) {
        RESOURCES.forEach(r => {
          conceder.resources[r] -= (accepted.give[r] ?? 0);
          activePlayer.resources[r] += (accepted.give[r] ?? 0);
        });
        const payMsg = `✓ CONCESSION: ${conceder.name} pays ${fmtResources(accepted.give)} to ${activePlayer.name}`;
        turnLog.push({ phase: 'robber', fromName: 'CONCESSION', fromId: null, publicMessage: payMsg });
        console.log(`  ${payMsg}`);
        logEvent(state, activePlayerId, 'concession', payMsg);
      } else {
        console.log(`  [ROBBER] ⚠ ${accepted.name} can't pay concession — not enough resources`);
      }
    }
  }

  // Place robber
  const targetHex = state.hexes.get(robberResult.hexId);
  if (targetHex && !targetHex.hasRobber) {
    for (const h of state.hexes.values()) h.hasRobber = false;
    targetHex.hasRobber = true;

    // Find all opponents with buildings adjacent to the chosen hex
    const eligibleVictimIds = new Set<string>();
    for (const v of state.vertices.values()) {
      if (v.hexIds.includes(targetHex.id) && v.building && v.building.playerId !== activePlayerId) {
        eligibleVictimIds.add(v.building.playerId);
      }
    }

    // Validate stealFrom — must be an eligible player with resources
    let stealVictimId = robberResult.stealFrom && eligibleVictimIds.has(robberResult.stealFrom)
      ? robberResult.stealFrom
      : null;

    // If AI didn't specify but there are eligible victims, auto-pick first one with resources
    if (!stealVictimId && eligibleVictimIds.size > 0) {
      for (const vid of eligibleVictimIds) {
        const p = state.players.find(pl => pl.id === vid)!;
        if (totalResources(p.resources) > 0) { stealVictimId = vid; break; }
      }
    }

    let stealMsg = '';
    if (stealVictimId) {
      const victim = state.players.find(p => p.id === stealVictimId)!;
      if (totalResources(victim.resources) > 0) {
        const available = RESOURCES.filter(r => victim.resources[r] > 0);
        if (available.length) {
          const res = available[Math.floor(Math.random() * available.length)];
          victim.resources[res]--;
          activePlayer.resources[res]++;
          stealMsg = `, steals 1 ${res} from ${victim.name}`;
          logEvent(state, activePlayerId, 'steal', `${activePlayer.name} steals 1 ${res} from ${victim.name}`);
        }
      }
    }

    const robberMsg = `moves robber to ${robberResult.hexId}${stealMsg}: "${robberResult.publicMessage}"`;
    const rEntry: TurnEntry = {
      phase: 'robber',
      fromName: activePlayer.name,
      fromId: activePlayerId,
      publicMessage: robberMsg,
      reasoning: robberResult.reasoning,
    };
    turnLog.push(rEntry);
    printEntry(rEntry);
    logEvent(state, activePlayerId, 'robber', `${activePlayer.name} ${robberMsg}`);
  } else {
    // Fallback: pick any non-robber hex
    const fallback = [...state.hexes.values()].find(h => !h.hasRobber);
    if (fallback) {
      for (const h of state.hexes.values()) h.hasRobber = false;
      fallback.hasRobber = true;
      const rEntry: TurnEntry = {
        phase: 'robber',
        fromName: activePlayer.name,
        fromId: activePlayerId,
        publicMessage: `moves robber to ${fallback.id} (auto)`,
      };
      turnLog.push(rEntry);
      printEntry(rEntry);
    }
  }
}

// ─── Trade negotiation ────────────────────────────────────────────────────────

let tradeCounter = 0;

async function runTradeNegotiation(
  state: GameState,
  activePlayerId: string,
  offerData: { give: Partial<ResourceCounts>; want: Partial<ResourceCounts>; publicMessage: string },
  agentMap: Map<string, AIAgent>,
  turnLog: TurnLog,
): Promise<void> {
  const activePlayer = state.players.find(p => p.id === activePlayerId)!;
  const offer: TradeOffer = {
    id: `t${++tradeCounter}`,
    offeredBy: activePlayerId,
    give: offerData.give,
    want: offerData.want,
    publicMessage: offerData.publicMessage,
  };

  // Log the offer
  const giveStr = fmtResources(offer.give);
  const wantStr = fmtResources(offer.want);
  const offerLine = `offers ${giveStr} → ${wantStr}: "${offer.publicMessage}"`;
  const offerEntry: TurnEntry = { phase: 'trade_offer', fromName: activePlayer.name, fromId: activePlayerId, publicMessage: offerLine, data: { offer } };
  turnLog.push(offerEntry);
  console.log(`\n  [TRADE-OFFER] ${activePlayer.name}: give ${giveStr} | want ${wantStr}`);
  console.log(`    "${offer.publicMessage}"`);

  // Sequential responses in turn order
  const respondOrder = getRespondOrder(state, activePlayerId);
  const responses: TradeResponse[] = [];

  for (const responderId of respondOrder) {
    const responder = state.players.find(p => p.id === responderId)!;
    const agent = agentMap.get(responderId)!;

    const result = await agent.respondToTrade(state, turnLog, offer, responses);

    const statusStr = result.accept ? 'ACCEPTS' : 'REJECTS';
    const counterStr = result.counter
      ? ` (counter: give ${fmtResources(result.counter.give)}, want ${fmtResources(result.counter.want)})`
      : '';
    const responseMsg = `${statusStr}${counterStr}: "${result.publicMessage}"`;

    const responseEntry: TurnEntry = {
      phase: 'trade_response',
      fromName: responder.name,
      fromId: responderId,
      publicMessage: responseMsg,
      reasoning: result.reasoning,
      data: { response: result, offerId: offer.id },
    };
    turnLog.push(responseEntry);
    printEntry(responseEntry);

    if (result.comment) {
      const commentEntry: TurnEntry = {
        phase: 'commentary',
        fromName: responder.name,
        fromId: responderId,
        publicMessage: result.comment,
      };
      turnLog.push(commentEntry);
      console.log(`  [COMMENTARY] ${responder.name}: ${result.comment}`);
    }

    responses.push({
      responderId,
      accept: result.accept,
      counter: result.counter,
      publicMessage: result.publicMessage,
    });
  }

  // Active player resolves
  const activeAgent = agentMap.get(activePlayerId)!;
  const acceptors = responses.filter(r => r.accept);
  const resolution = await activeAgent.resolveTradeOffer(state, turnLog, offer, responses);

  const resolveEntry: TurnEntry = {
    phase: 'trade_resolve',
    fromName: activePlayer.name,
    fromId: activePlayerId,
    publicMessage: resolution.publicMessage,
    reasoning: resolution.reasoning,
    data: { acceptFrom: resolution.acceptFrom, acceptCounter: resolution.acceptCounter },
  };
  turnLog.push(resolveEntry);
  console.log(`  [TRADE-RESOLVE] ${activePlayer.name}: ${resolution.publicMessage}`);

  // ── Renegotiation: active player raises their ask to all acceptors ─────────
  if (resolution.renegotiate && acceptors.length >= 2) {
    // Pre-validate: active player must be able to afford their side of the revised offer
    const reGiveCheck = resolution.renegotiate.give;
    if (!canAfford(activePlayer.resources, { wood:0, brick:0, wheat:0, sheep:0, ore:0, ...reGiveCheck })) {
      console.log(`  [TRADE] ⚠ Renegotiation cancelled — ${activePlayer.name} cannot afford to give ${fmtResources(reGiveCheck)}`);
      return;
    }

    const reOffer: TradeOffer = {
      id: `t${++tradeCounter}`,
      offeredBy: activePlayerId,
      give: resolution.renegotiate.give,
      want: resolution.renegotiate.want,
      publicMessage: resolution.renegotiate.publicMessage,
    };

    const reGiveStr = fmtResources(reOffer.give);
    const reWantStr = fmtResources(reOffer.want);
    console.log(`\n  [TRADE-RENEGOTIATE] ${activePlayer.name}: revised offer give ${reGiveStr} | want ${reWantStr}`);
    console.log(`    "${reOffer.publicMessage}"`);
    const reOfferEntry: TurnEntry = {
      phase: 'trade_offer',
      fromName: activePlayer.name,
      fromId: activePlayerId,
      publicMessage: `(REVISED) offers ${reGiveStr} → ${reWantStr}: "${reOffer.publicMessage}"`,
      data: { offer: reOffer },
    };
    turnLog.push(reOfferEntry);

    // Only prior acceptors respond to revised offer
    const reResponses: TradeResponse[] = [];
    for (const prior of acceptors) {
      const responderPlayer = state.players.find(p => p.id === prior.responderId)!;
      const responderAgent = agentMap.get(prior.responderId)!;
      const reResult = await responderAgent.respondToTrade(state, turnLog, reOffer, reResponses);

      const reStatusStr = reResult.accept ? 'ACCEPTS' : 'REJECTS';
      const reMsg = `${reStatusStr}: "${reResult.publicMessage}"`;
      const reEntry: TurnEntry = {
        phase: 'trade_response',
        fromName: responderPlayer.name,
        fromId: prior.responderId,
        publicMessage: reMsg,
        reasoning: reResult.reasoning,
        data: { response: reResult, offerId: reOffer.id },
      };
      turnLog.push(reEntry);
      printEntry(reEntry);
      reResponses.push({ responderId: prior.responderId, accept: reResult.accept, publicMessage: reResult.publicMessage });
    }

    // Auto-pick first acceptor of revised terms
    const reAcceptor = reResponses.find(r => r.accept);
    if (reAcceptor) {
      const responder = state.players.find(p => p.id === reAcceptor.responderId)!;
      if (canExecutePlayerTrade(state, activePlayerId, responder.id, reOffer.give, reOffer.want)) {
        executePlayerTrade(state, activePlayerId, responder.id, reOffer.give, reOffer.want);
        const tradeMsg = `✓ TRADE (revised): ${activePlayer.name} gives ${reGiveStr}, receives ${reWantStr} from ${responder.name}`;
        turnLog.push({ phase: 'trade_resolve', fromName: 'TRADE', fromId: null, publicMessage: tradeMsg });
        console.log(`  ${tradeMsg}`);
        logEvent(state, activePlayerId, 'player_trade', tradeMsg);
      } else {
        console.log(`  [TRADE] ⚠ Revised trade — resources insufficient — cancelled`);
      }
    } else {
      console.log(`  [TRADE] No one accepted revised terms — trade cancelled`);
    }
    return;
  }

  // ── Standard resolution ───────────────────────────────────────────────────
  if (!resolution.acceptFrom) return;

  const responder = state.players.find(
    p => p.id === resolution.acceptFrom || p.name === resolution.acceptFrom,
  );
  if (!responder) {
    console.log(`  [TRADE] ⚠ acceptFrom "${resolution.acceptFrom}" not found — trade cancelled`);
    return;
  }

  const response = responses.find(r => r.responderId === responder.id);
  if (!response) {
    console.log(`  [TRADE] ⚠ no response found from "${resolution.acceptFrom}" — trade cancelled`);
    return;
  }

  let finalGive: Partial<ResourceCounts>;
  let finalWant: Partial<ResourceCounts>;

  if (resolution.acceptCounter && response.counter) {
    finalGive = response.counter.want;
    finalWant = response.counter.give;
  } else if (response.accept) {
    finalGive = offer.give;
    finalWant = offer.want;
  } else {
    console.log(`  [TRADE] ⚠ ${responder.name} did not accept — trade cancelled`);
    return;
  }

  if (!canExecutePlayerTrade(state, activePlayerId, responder.id, finalGive, finalWant)) {
    console.log(`  [TRADE] ⚠ Resources insufficient — trade cancelled`);
    return;
  }

  executePlayerTrade(state, activePlayerId, responder.id, finalGive, finalWant);

  const tradeMsg = `✓ TRADE: ${activePlayer.name} gives ${fmtResources(finalGive)}, receives ${fmtResources(finalWant)} from ${responder.name}`;
  const tradeEntry: TurnEntry = { phase: 'trade_resolve', fromName: 'TRADE', fromId: null, publicMessage: tradeMsg };
  turnLog.push(tradeEntry);
  console.log(`  ${tradeMsg}`);
  logEvent(state, activePlayerId, 'player_trade', tradeMsg);
}

// ─── Road Building fallback ───────────────────────────────────────────────────

function pickBestRoadEdges(state: GameState, playerId: string, count: number, exclude: string[]): string[] {
  const PIPS: Record<number, number> = { 2:1, 3:2, 4:3, 5:4, 6:5, 8:5, 9:4, 10:3, 11:2, 12:1 };
  const candidates: { eid: string; score: number; opensSettlement: boolean }[] = [];
  for (const edge of state.edges.values()) {
    if (exclude.includes(edge.id)) continue;
    if (!isValidRoadSpot(state, edge.id, playerId)) continue;
    const forwardVid = edge.vertexIds.find(vid => {
      const v = state.vertices.get(vid);
      return !v?.building || v.building.playerId !== playerId;
    }) ?? edge.vertexIds[1];
    const fv = state.vertices.get(forwardVid);
    const opensSettlement = fv ? isValidSettlementSpot(state, forwardVid, playerId, false) : false;
    const score = (fv?.hexIds ?? []).reduce((sum, hid) => {
      const h = state.hexes.get(hid)!;
      return sum + (PIPS[h.number ?? 0] ?? 0);
    }, 0);
    candidates.push({ eid: edge.id, score, opensSettlement });
  }
  candidates.sort((a, b) => {
    if (a.opensSettlement !== b.opensSettlement) return a.opensSettlement ? -1 : 1;
    return b.score - a.score;
  });
  return candidates.slice(0, count).map(c => c.eid);
}

// ─── Apply post-roll dev card ─────────────────────────────────────────────────

function applyPostRollDevCard(
  state: GameState,
  playerId: string,
  result: import('./types').PostRollDevCardResult,
  knightUsedThisTurn: boolean,
  turnLog: TurnLog,
): boolean {
  const player = state.players.find(p => p.id === playerId)!;

  if (result.playDevCard && !player.devCardPlayedThisTurn) {
    const dc = result.playDevCard;
    const idx = player.devCards.indexOf(dc.type as import('./types').DevCardType);
    if (idx === -1) return false;

    player.devCards.splice(idx, 1);
    player.devCardPlayedThisTurn = true;

    let msg = '';
    if (dc.type === 'road_building') {
      msg = `plays Road Building`;
      const placed: string[] = [];
      const tryPlace = (eid: string | undefined): void => {
        if (player.roadsLeft <= 0 || !eid) return;
        if (isValidRoadSpot(state, eid, playerId)) {
          state.edges.get(eid)!.road = playerId;
          player.roadsLeft--;
          placed.push(eid);
        }
      };
      // Try AI-provided edges; fall back to auto-pick best road toward a settlement if invalid/missing
      if (dc.edgeId1 && isValidRoadSpot(state, dc.edgeId1, playerId)) {
        tryPlace(dc.edgeId1);
      } else {
        const [auto] = pickBestRoadEdges(state, playerId, 1, placed);
        tryPlace(auto);
      }
      if (dc.edgeId2 && isValidRoadSpot(state, dc.edgeId2, playerId)) {
        tryPlace(dc.edgeId2);
      } else {
        const [auto] = pickBestRoadEdges(state, playerId, 1, placed);
        tryPlace(auto);
      }
      if (placed.length > 0) msg += `, places roads at ${placed.join(' and ')}`;
      updateSpecialCards(state);
    } else if (dc.type === 'year_of_plenty') {
      player.resources[dc.resource1]++;
      player.resources[dc.resource2]++;
      msg = `plays Year of Plenty → gains ${dc.resource1} + ${dc.resource2}`;
    } else if (dc.type === 'monopoly') {
      let total = 0;
      for (const other of state.players) {
        if (other.id === playerId) continue;
        total += other.resources[dc.resource];
        other.resources[dc.resource] = 0;
      }
      player.resources[dc.resource] += total;
      msg = `plays Monopoly on ${dc.resource} → collects ${total} total`;
    }

    const entry: TurnEntry = { phase: 'dev_card', fromName: player.name, fromId: playerId, publicMessage: msg };
    turnLog.push(entry);
    printEntry(entry);
    logEvent(state, playerId, 'dev_card', `${player.name} ${msg}`);

    if (result.publicMessage) {
      const pmEntry: TurnEntry = { phase: 'dev_card', fromName: player.name, fromId: playerId, publicMessage: result.publicMessage };
      turnLog.push(pmEntry);
      printEntry(pmEntry);
    }
  }
  return false;
}

// ─── Setup turn ───────────────────────────────────────────────────────────────

async function runSetupTurn(
  state: GameState,
  agent: AIAgent,
  isSecondPlacement: boolean,
): Promise<void> {
  const player = currentSetupPlayer(state);
  const placement = isSecondPlacement ? 'SECOND' : 'FIRST';

  if (state.setupSubPhase === 'settlement') {
    const valid = validSetupSettlements(state, player.id);
    if (!valid.length) return;

    const context = `${player.name} places ${placement} settlement${isSecondPlacement ? ' (grants adjacent resources)' : ''}`;
    const result = await agent.decideSetup(state, valid, context);

    let placed = false;
    if (result.action?.type === 'place_settlement') {
      const vid = result.action.vertexId;
      if (isValidSettlementSpot(state, vid, player.id, true)) {
        state.vertices.get(vid)!.building = { type: 'settlement', playerId: player.id };
        player.settlementsLeft--;
        if (isSecondPlacement) grantSetupResources(state, player.id, vid);
        console.log(`  [SETUP] ${player.name} places settlement at ${vid}`);
        logEvent(state, player.id, 'setup', `${player.name} places settlement at ${vid}`);
        state.setupSubPhase = 'road';
        placed = true;
      }
    }
    if (!placed) {
      const fallback = (valid[0] as { vertexId: string }).vertexId;
      state.vertices.get(fallback)!.building = { type: 'settlement', playerId: player.id };
      player.settlementsLeft--;
      if (isSecondPlacement) grantSetupResources(state, player.id, fallback);
      console.log(`  [SETUP] ${player.name} (fallback) places settlement at ${fallback}`);
      logEvent(state, player.id, 'setup', `${player.name} (fallback) places settlement at ${fallback}`);
      state.setupSubPhase = 'road';
    }
  } else {
    // Find the vertex of the last placed settlement
    const lastVid = findLastSettlementVertex(state, player.id);
    if (!lastVid) return;

    const valid = validSetupRoads(state, player.id, lastVid);
    if (!valid.length) return;

    const context = `${player.name} places road adjacent to settlement at ${lastVid}`;
    const result = await agent.decideSetup(state, valid, context);

    let placed = false;
    if (result.action?.type === 'place_road') {
      const eid = result.action.edgeId;
      const edge = state.edges.get(eid);
      if (edge && edge.road === null) {
        edge.road = player.id;
        player.roadsLeft--;
        console.log(`  [SETUP] ${player.name} places road at ${eid}`);
        logEvent(state, player.id, 'setup', `${player.name} places road at ${eid}`);
        placed = true;
      }
    }
    if (!placed) {
      const fallback = (valid[0] as { edgeId: string }).edgeId;
      state.edges.get(fallback)!.road = player.id;
      player.roadsLeft--;
      console.log(`  [SETUP] ${player.name} (fallback) places road at ${fallback}`);
      logEvent(state, player.id, 'setup', `${player.name} (fallback) places road at ${fallback}`);
    }

    state.setupSubPhase = 'settlement';
    state.setupIndex++;
  }
}

function findLastSettlementVertex(state: GameState, playerId: string): string | null {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const ev = state.log[i];
    if (ev.playerId === playerId && ev.type === 'setup' && ev.message.includes('settlement at')) {
      const match = ev.message.match(/settlement at (.+)$/);
      if (match) return match[1];
    }
  }
  return null;
}

// ─── Main turn ────────────────────────────────────────────────────────────────

export async function runMainTurn(
  state: GameState,
  agentMap: Map<string, AIAgent>,
  sharedLog: TurnLog = [],
): Promise<void> {
  const player = state.players[state.currentPlayerIndex];
  const agent = agentMap.get(player.id)!;
  const turnLog: TurnLog = sharedLog;

  player.devCardPlayedThisTurn = false;
  let knightUsedThisTurn = false;
  let tradesRemaining = 3;

  const vp = calculateVP(state, player.id);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`TURN ${state.turn}: ${player.name} (${player.color}) — ${vp} VP`);
  console.log('─'.repeat(60));

  // ── PRE-ROLL PHASE ──────────────────────────────────────────────────────────
  console.log('\n  [PRE-ROLL PHASE]');

  let preRollLoopCount = 0;
  while (preRollLoopCount < 5) {   // safety cap
    preRollLoopCount++;
    const preRoll = await agent.decidePreRoll(state, turnLog, tradesRemaining);

    // Public statement (always emit an entry so reasoning is visible)
    {
      const entry: TurnEntry = {
        phase: 'pre_roll',
        fromName: player.name,
        fromId: player.id,
        publicMessage: preRoll.publicMessage ?? '',
        reasoning: preRoll.reasoning,
      };
      turnLog.push(entry);
      if (preRoll.publicMessage) printEntry(entry);
    }

    // Play Knight (announce + negotiate + place; executes BEFORE trade so threat is leverage)
    if (preRoll.playKnight && !knightUsedThisTurn && !player.devCardPlayedThisTurn) {
      const kidx = player.devCards.indexOf('knight');
      if (kidx !== -1) {
        announceKnight(state, player.id, 'pre_roll', turnLog);
        await runRobberNegotiation(state, player.id, agentMap, turnLog);
        knightUsedThisTurn = true;
      }
    }

    // Trade offer
    if (preRoll.tradeOffer && tradesRemaining > 0) {
      await runTradeNegotiation(state, player.id, preRoll.tradeOffer, agentMap, turnLog);
      tradesRemaining--;
    }

    if (preRoll.readyToRoll) break;
    if (!preRoll.tradeOffer && !preRoll.playKnight && !preRoll.publicMessage) break; // no action = roll
  }

  // ── ROLL ────────────────────────────────────────────────────────────────────
  const roll = rollDiceProductive(state);
  state.lastRoll = roll;
  const total = roll[0] + roll[1];
  const rollMsg = `rolls ${roll[0]}+${roll[1]}=${total}`;
  const rollEntry: TurnEntry = { phase: 'roll', fromName: player.name, fromId: player.id, publicMessage: rollMsg, data: { roll, total } };
  turnLog.push(rollEntry);
  console.log(`\n  [ROLL] ${player.name} ${rollMsg}`);
  logEvent(state, player.id, 'dice', `${player.name} ${rollMsg}`);

  // ── HANDLE 7 ────────────────────────────────────────────────────────────────
  if (total === 7) {
    // Discard phase — sequential in turn order starting from next player, then active last
    const discardOrder = [
      ...getRespondOrder(state, player.id),
      player.id,
    ];

    for (const pid of discardOrder) {
      const p = state.players.find(pl => pl.id === pid)!;
      const count = getDiscardCount(p);
      if (count === 0) continue;

      console.log(`  [DISCARD] ${p.name} must discard ${count} cards (has ${totalResources(p.resources)})`);
      const discardAgent = agentMap.get(pid)!;
      const discardResult = await discardAgent.decideDiscard(state, count);

      // Validate: correct count AND player actually has those resources
      const discardTotal = RESOURCES.reduce((s, r) => s + (discardResult.resources[r] ?? 0), 0);
      const hasResources = RESOURCES.every(r => (p.resources[r] ?? 0) >= (discardResult.resources[r] ?? 0));
      if (discardTotal === count && hasResources) {
        RESOURCES.forEach(r => { p.resources[r] -= (discardResult.resources[r] ?? 0); });
        const discardMsg = `discards ${fmtResources(discardResult.resources)}`;
        const dEntry: TurnEntry = { phase: 'discard', fromName: p.name, fromId: pid, publicMessage: discardMsg, reasoning: discardResult.reasoning };
        turnLog.push(dEntry);
        printEntry(dEntry);
        logEvent(state, pid, 'discard', `${p.name} ${discardMsg}`);
      } else {
        // Fallback: discard cheapest resources
        let rem = count;
        for (const r of RESOURCES) {
          if (rem === 0) break;
          const n = Math.min(p.resources[r], rem);
          p.resources[r] -= n;
          rem -= n;
        }
        const dEntry: TurnEntry = { phase: 'discard', fromName: p.name, fromId: pid, publicMessage: `discards ${count} resources (auto)` };
        turnLog.push(dEntry);
        printEntry(dEntry);
        logEvent(state, pid, 'discard', `${p.name} discards ${count} resources (auto-fallback)`);
      }
    }

    // Robber placement (only if Knight wasn't already used this turn)
    if (!knightUsedThisTurn) {
      console.log(`  [ROBBER] ${player.name} must move the robber`);
      await runRobberNegotiation(state, player.id, agentMap, turnLog);
    } else {
      const note: TurnEntry = { phase: 'system', fromName: 'System', fromId: null, publicMessage: `Robber already moved by Knight this turn` };
      turnLog.push(note);
      console.log(`  [SYSTEM] Robber already moved by Knight — skip robber placement`);
    }

  } else {
    // ── DISTRIBUTE RESOURCES ───────────────────────────────────────────────────
    const before: Record<string, ResourceCounts> = {};
    state.players.forEach(p => { before[p.id] = { ...p.resources }; });

    distributeResources(state, total);

    for (const p of state.players) {
      const gained: Partial<ResourceCounts> = {};
      RESOURCES.forEach(r => {
        const diff = p.resources[r] - before[p.id][r];
        if (diff > 0) gained[r] = diff;
      });
      if (Object.keys(gained).length > 0) {
        const resMsg = `receives ${fmtResources(gained)}`;
        const rEntry: TurnEntry = { phase: 'resources', fromName: p.name, fromId: p.id, publicMessage: resMsg };
        turnLog.push(rEntry);
        printEntry(rEntry);
      }
    }
  }

  // ── POST-ROLL DEV CARD ──────────────────────────────────────────────────────
  const playableDevCards = player.devCards.filter(c => {
    if (c === 'victory_point') return false;
    if (c === 'knight') return !knightUsedThisTurn;
    return true;
  });

  if (playableDevCards.length > 0 && !player.devCardPlayedThisTurn) {
    console.log(`\n  [DEV CARD PHASE]`);
    const devResult = await agent.decidePostRollDevCard(state, turnLog, knightUsedThisTurn);

    {
      // Always emit an entry so reasoning is visible
      const e: TurnEntry = {
        phase: 'dev_card',
        fromName: player.name,
        fromId: player.id,
        publicMessage: devResult.publicMessage ?? '',
        reasoning: devResult.reasoning,
      };
      turnLog.push(e);
      if (devResult.publicMessage) printEntry(e);
    }

    if (devResult.playKnight && !knightUsedThisTurn && !player.devCardPlayedThisTurn) {
      const kidx = player.devCards.indexOf('knight');
      if (kidx !== -1) {
        announceKnight(state, player.id, 'dev_card', turnLog);
        await runRobberNegotiation(state, player.id, agentMap, turnLog);
        knightUsedThisTurn = true;
      }
    } else if (devResult.playDevCard && !player.devCardPlayedThisTurn) {
      applyPostRollDevCard(state, player.id, devResult, knightUsedThisTurn, turnLog);
    }
  }

  // ── POST-ROLL TRADE PHASE ───────────────────────────────────────────────────
  if (tradesRemaining > 0) {
    console.log(`\n  [TRADE PHASE] (${tradesRemaining} offers remaining)`);

    for (let i = 0; i < tradesRemaining; i++) {
      const tradeResult = await agent.proposeNextTrade(state, turnLog, tradesRemaining - i);
      if (!tradeResult.offer) {
        console.log(`  [TRADE] ${player.name} passes on trading`);
        break;
      }
      await runTradeNegotiation(state, player.id, tradeResult.offer, agentMap, turnLog);
    }
  }

  // ── BUILD PHASE ─────────────────────────────────────────────────────────────
  console.log(`\n  [BUILD PHASE]`);
  const buildActions = validBuildOnlyActions(state, player.id);

  if (buildActions.length > 0) {
    const executeBuildResult = async (buildResult: import('./types').BuildResult, isRetry: boolean) => {
      if (buildResult.publicMessage && !isRetry) {
        const e: TurnEntry = { phase: 'build', fromName: player.name, fromId: player.id, publicMessage: buildResult.publicMessage };
        turnLog.push(e); printEntry(e);
      }

      const invalidActions: string[] = [];
      for (const action of buildResult.buildActions) {
        const isValid = buildActions.some(a => {
          if (a.type !== action.type) return false;
          if (a.type === 'place_settlement' || a.type === 'place_city') return (a as any).vertexId === (action as any).vertexId;
          if (a.type === 'place_road') return (a as any).edgeId === (action as any).edgeId;
          if (a.type === 'trade_bank') return (a as any).give === (action as any).give && (a as any).receive === (action as any).receive;
          return true;
        });
        if (!isValid) {
          const id = (action as any).edgeId ?? (action as any).vertexId ?? action.type;
          invalidActions.push(`${action.type}("${id}")`);
          console.log(`  [BUILD] ⚠ ${player.name} tried invalid action (${action.type}: ${id}) — skipped`);
          continue;
        }
        const success = applyBuildAction(state, player.id, action);
        if (success) {
          let desc = '';
          if (action.type === 'place_settlement') desc = `builds settlement at ${(action as any).vertexId}`;
          else if (action.type === 'place_road')   desc = `builds road at ${(action as any).edgeId}`;
          else if (action.type === 'place_city')   desc = `upgrades to city at ${(action as any).vertexId}`;
          else if (action.type === 'buy_dev_card') {
            desc = `buys a dev card`;
          }
          else if (action.type === 'trade_bank')   desc = `bank-trades ${(action as any).give} → ${(action as any).receive}`;
          if (desc) {
            const e: TurnEntry = { phase: 'build', fromName: player.name, fromId: player.id, publicMessage: desc };
            turnLog.push(e); printEntry(e);
          }
        } else {
          console.log(`  [BUILD] ⚠ ${player.name} build action failed (${action.type}) — resources or placement invalid`);
        }
      }
      return invalidActions;
    };

    let buildResult = await agent.decideBuild(state, turnLog, buildActions);
    {
      // Always emit an entry so reasoning is visible even with no publicMessage
      const e: TurnEntry = {
        phase: 'build',
        fromName: player.name,
        fromId: player.id,
        publicMessage: buildResult.publicMessage ?? '',
        reasoning: buildResult.reasoning,
      };
      turnLog.push(e);
      if (buildResult.publicMessage) printEntry(e);
    }
    const invalidActions = await executeBuildResult(buildResult, false);

    // Retry once if all actions were invalid
    if (invalidActions.length > 0 && buildResult.buildActions.length > 0 &&
        invalidActions.length === buildResult.buildActions.length) {
      const hint = `you returned ${invalidActions.join(', ')} — these IDs are not in the valid list`;
      console.log(`  [BUILD] Retrying build decision for ${player.name}...`);
      const retryResult = await agent.decideBuild(state, turnLog, buildActions, hint);
      await executeBuildResult(retryResult, true);
      if (retryResult.publicMessage) {
        const e: TurnEntry = { phase: 'build', fromName: player.name, fromId: player.id, publicMessage: `(retry) ${retryResult.publicMessage}` };
        turnLog.push(e); printEntry(e);
      }
    }
  } else {
    console.log(`  [BUILD] ${player.name} has nothing to build`);
  }

  logEvent(state, player.id, 'turn_end', `${player.name} ends turn — VP: ${calculateVP(state, player.id)}`);
}

// ─── Main simulation entry ────────────────────────────────────────────────────

export async function runGame(config: GameConfig): Promise<GameResult> {
  console.log('\n' + '═'.repeat(60));
  console.log('  AI CATAN SIMULATION');
  console.log('═'.repeat(60));
  console.log(`Players: ${config.players.map(p => `${p.name}(${p.model})`).join(', ')}`);

  const board = generateBoard(config.seed);
  const state = createInitialState(config.players, board, config.seed);
  const maxTurns = config.maxTurns ?? 200;
  const outputDir = config.outputDir ?? './outputs';

  const agentMap = new Map<string, AIAgent>();
  for (const pc of config.players) {
    agentMap.set(pc.id, createAgent(pc.id, pc.name, pc.model));
  }

  // ── SETUP PHASE ─────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('  SETUP PHASE');
  console.log('─'.repeat(60));

  while (state.phase === 'setup' && state.setupIndex < state.setupTurnOrder.length) {
    const setupPlayerId = state.setupTurnOrder[state.setupIndex];
    const agent = agentMap.get(setupPlayerId)!;
    const isSecond = state.setupIndex >= config.players.length;
    await runSetupTurn(state, agent, isSecond);

    if (state.setupIndex >= state.setupTurnOrder.length) {
      state.phase = 'main';
      state.turn = 1;
      break;
    }
  }

  console.log('\n  Setup complete.');
  for (const p of state.players) {
    console.log(`  ${p.name}: ${calculateVP(state, p.id)} VP, resources: ${RESOURCES.map(r => `${r}:${p.resources[r]}`).join(' ')}`);
  }

  // ── MAIN GAME ────────────────────────────────────────────────────────────────
  while (state.phase === 'main' && state.turn <= maxTurns) {
    await runMainTurn(state, agentMap);

    const winner = checkWin(state);
    if (winner) {
      state.winner = winner;
      state.phase = 'ended';
      const wp = state.players.find(p => p.id === winner)!;
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  ★ ${wp.name} WINS with ${calculateVP(state, winner)} VP! ★`);
      console.log('═'.repeat(60));
      logEvent(state, winner, 'win', `${wp.name} wins with ${calculateVP(state, winner)} VP!`);
      break;
    }

    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
    state.turn++;
  }

  if (!state.winner) {
    console.log(`\nGame ended: turn limit (${maxTurns}) reached`);
  }

  // ── SAVE OUTPUT ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(outputDir, `catan-${ts}.json`);
  const mdPath  = path.join(outputDir, `catan-${ts}.md`);

  const finalScores: Record<string, number> = {};
  for (const p of state.players) finalScores[p.id] = calculateVP(state, p.id);

  fs.writeFileSync(logPath, JSON.stringify({ config, finalScores, log: state.log }, null, 2));
  fs.writeFileSync(mdPath, buildReport(state, config, finalScores));

  console.log(`\nLog: ${logPath}`);
  console.log(`Report: ${mdPath}`);

  return { winner: state.winner, turns: state.turn, finalScores, logPath };
}

// ─── Markdown report ──────────────────────────────────────────────────────────

function buildReport(
  state: GameState,
  config: GameConfig,
  finalScores: Record<string, number>,
): string {
  const lines: string[] = [];
  lines.push('# AI Catan Simulation Report');
  lines.push(`**Date:** ${new Date().toLocaleString()}`);
  lines.push(`**Turns:** ${state.turn} | **Seed:** ${config.seed ?? 'random'}`);
  lines.push('');
  lines.push('## Players');
  for (const p of [...state.players].sort((a, b) => finalScores[b.id] - finalScores[a.id])) {
    const w = p.id === state.winner ? ' ★ WINNER' : '';
    lines.push(`- **${p.name}** (${p.color}) \`${p.model}\` — **${finalScores[p.id]} VP**${w}`);
  }
  lines.push('');
  lines.push('## Game Log (last 80 events)');
  for (const ev of state.log.slice(-80)) {
    const pname = ev.playerId ? state.players.find(p => p.id === ev.playerId)?.name ?? ev.playerId : 'System';
    lines.push(`- **T${ev.turn}** [${pname}] ${ev.message}`);
  }
  return lines.join('\n');
}
