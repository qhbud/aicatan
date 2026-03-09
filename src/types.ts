// ─── Resources & Tiles ────────────────────────────────────────────────────────

export type ResourceType = 'wood' | 'brick' | 'wheat' | 'sheep' | 'ore';
export type TileType = ResourceType | 'desert';
export type PortType = ResourceType | 'any'; // resource = 2:1, any = 3:1
export type BuildingType = 'settlement' | 'city';
export type DevCardType = 'knight' | 'victory_point' | 'road_building' | 'year_of_plenty' | 'monopoly';
export type GamePhase = 'setup' | 'main' | 'ended';

export interface ResourceCounts {
  wood: number;
  brick: number;
  wheat: number;
  sheep: number;
  ore: number;
}

// ─── Board Structures ─────────────────────────────────────────────────────────

export interface Hex {
  id: string;       // "${q},${r}"
  q: number;
  r: number;
  type: TileType;
  number: number | null;
  hasRobber: boolean;
}

export interface Vertex {
  id: string;
  hexIds: string[];
  building: { type: BuildingType; playerId: string } | null;
  port: PortType | null;
}

export interface Edge {
  id: string;
  vertexIds: [string, string];
  road: string | null;  // playerId
}

// ─── Player ───────────────────────────────────────────────────────────────────

export interface Player {
  id: string;
  name: string;
  model: string;
  color: string;
  resources: ResourceCounts;
  settlementsLeft: number;
  citiesLeft: number;
  roadsLeft: number;
  devCards: DevCardType[];
  devCardPlayedThisTurn: boolean;
  knightsPlayed: number;
  hasLongestRoad: boolean;
  hasLargestArmy: boolean;
}

// ─── Game State ───────────────────────────────────────────────────────────────

export interface TurnSummary {
  turn: number;
  events: string[];   // human-readable lines: builds, trades, robber, commentary
}

export interface GameState {
  phase: GamePhase;
  setupTurnOrder: string[];
  setupIndex: number;
  setupSubPhase: 'settlement' | 'road';
  turn: number;
  currentPlayerIndex: number;
  players: Player[];
  hexes: Map<string, Hex>;
  vertices: Map<string, Vertex>;
  edges: Map<string, Edge>;
  devDeck: DevCardType[];
  lastRoll: [number, number] | null;
  longestRoadPlayer: string | null;
  longestRoadLength: number;
  largestArmyPlayer: string | null;
  largestArmySize: number;
  winner: string | null;
  log: GameEvent[];
  turnSummaries: TurnSummary[];  // rolling history of completed turns
}

export interface GameEvent {
  turn: number;
  playerId: string | null;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

// ─── Turn Log (visible to all players each turn) ──────────────────────────────

export interface TurnEntry {
  phase: 'pre_roll' | 'trade_offer' | 'trade_response' | 'trade_resolve'
       | 'roll' | 'discard' | 'robber' | 'resources' | 'dev_card' | 'build' | 'system'
       | 'commentary';
  fromName: string;
  fromId: string | null;
  publicMessage: string;
  reasoning?: string;   // private — shown italicized in dialogue, never read by other agents
  data?: Record<string, unknown>;
}

export type TurnLog = TurnEntry[];

// ─── Trade Structures ─────────────────────────────────────────────────────────

export interface TradeOffer {
  id: string;
  offeredBy: string;   // playerId
  give: Partial<ResourceCounts>;
  want: Partial<ResourceCounts>;
  publicMessage: string;
}

export interface TradeResponse {
  responderId: string;
  accept: boolean;
  counter?: { give: Partial<ResourceCounts>; want: Partial<ResourceCounts> };
  publicMessage: string;
}

// ─── Phase Result Types (returned by agent methods) ───────────────────────────

export interface PreRollResult {
  reasoning: string;          // private — logged to file, never shown to other agents
  publicMessage?: string;     // spoken at the table, goes into TurnLog
  playKnight?: boolean;       // true = play Knight; robber placement decided separately via decideRobber
  tradeOffer?: {
    give: Partial<ResourceCounts>;
    want: Partial<ResourceCounts>;
    publicMessage: string;
  };
  readyToRoll: boolean;
}

export interface TradeResponseResult {
  reasoning: string;
  accept: boolean;
  counter?: { give: Partial<ResourceCounts>; want: Partial<ResourceCounts> };
  publicMessage: string;      // required
  comment?: string;           // optional public remark shown in dialogue (call out unfair deals, warn about leader, etc.)
}

export interface TradeResolutionResult {
  reasoning: string;
  acceptFrom?: string;        // playerId, or omit to decline all
  acceptCounter: boolean;     // true = accept their counter terms instead of original offer
  renegotiate?: {             // propose new (better) terms to all acceptors instead of picking one
    give: Partial<ResourceCounts>;
    want: Partial<ResourceCounts>;
    publicMessage: string;
  };
  publicMessage: string;      // required
}

export interface PostRollDevCardResult {
  reasoning: string;
  publicMessage?: string;
  playKnight?: boolean;       // true = play Knight; robber placement decided separately via decideRobber
  playDevCard?: (
    | { type: 'road_building'; edgeId1: string; edgeId2?: string }
    | { type: 'year_of_plenty'; resource1: ResourceType; resource2: ResourceType }
    | { type: 'monopoly'; resource: ResourceType }
  );
}

export interface PostRollTradeResult {
  reasoning: string;
  offer?: {
    give: Partial<ResourceCounts>;
    want: Partial<ResourceCounts>;
    publicMessage: string;
  } | null;  // null = done trading
}

export interface BuildResult {
  reasoning: string;
  publicMessage?: string;
  buildActions: PlayerAction[];   // place_settlement | place_road | place_city | buy_dev_card | trade_bank
}

export interface SetupResult {
  reasoning: string;
  action: PlaceSettlementAction | PlaceRoadAction;
}

export interface RobberThreatResult {
  reasoning: string;
  publicMessage: string;      // announced to table — threat, demands, or "I'm moving the robber"
  demands?: Array<{
    targetId: string;         // playerId being threatened
    give: Partial<ResourceCounts>;  // what you demand from them to spare them
  }>;
  skip: boolean;              // true = skip negotiation, place robber immediately
}

export interface RobberConcessionResult {
  reasoning: string;
  concede: boolean;           // true = offering something to avoid the robber
  give?: Partial<ResourceCounts>;  // what they're willing to give the active player
  publicMessage: string;
  comment?: string;           // optional public aside — warn others, call out the threat, etc.
}

export interface RobberResult {
  reasoning: string;
  hexId: string;
  stealFrom?: string;
  publicMessage: string;
  acceptConcessionFrom?: string;  // playerId whose concession to accept (executes before placement)
}

export interface DiscardResult {
  reasoning: string;
  resources: Partial<ResourceCounts>;
}

// ─── Player Actions (internal game engine) ────────────────────────────────────

export interface PlaceSettlementAction { type: 'place_settlement'; vertexId: string }
export interface PlaceRoadAction       { type: 'place_road';       edgeId: string   }
export interface PlaceCityAction       { type: 'place_city';       vertexId: string }
export interface BuyDevCardAction      { type: 'buy_dev_card'                       }
export interface UseKnightAction       { type: 'use_knight';       hexId: string; stealFrom?: string }
export interface UseRoadBuildingAction { type: 'use_road_building'; edgeId1: string; edgeId2?: string }
export interface UseYearOfPlentyAction { type: 'use_year_of_plenty'; resource1: ResourceType; resource2: ResourceType }
export interface UseMonopolyAction     { type: 'use_monopoly';     resource: ResourceType }
export interface TradeBankAction       { type: 'trade_bank';       give: ResourceType; receive: ResourceType }
export interface DiscardAction         { type: 'discard';          resources: Partial<ResourceCounts> }
export interface MoveRobberAction      { type: 'move_robber';      hexId: string; stealFrom?: string }
export interface EndTurnAction         { type: 'end_turn' }

export type PlayerAction =
  | PlaceSettlementAction | PlaceRoadAction | PlaceCityAction
  | BuyDevCardAction | UseKnightAction | UseRoadBuildingAction
  | UseYearOfPlentyAction | UseMonopolyAction | TradeBankAction
  | DiscardAction | MoveRobberAction | EndTurnAction;

// ─── Game Config ──────────────────────────────────────────────────────────────

export interface PlayerConfig {
  id: string;
  name: string;
  model: string;
  color: string;
}

export interface GameConfig {
  players: PlayerConfig[];
  seed?: number;
  maxTurns?: number;
  outputDir?: string;
  verboseLog?: boolean;
}

export interface GameResult {
  winner: string | null;
  turns: number;
  finalScores: Record<string, number>;
  logPath: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const BUILD_COSTS: Record<string, ResourceCounts> = {
  road:       { wood: 1, brick: 1, wheat: 0, sheep: 0, ore: 0 },
  settlement: { wood: 1, brick: 1, wheat: 1, sheep: 1, ore: 0 },
  city:       { wood: 0, brick: 0, wheat: 2, sheep: 0, ore: 3 },
  dev_card:   { wood: 0, brick: 0, wheat: 1, sheep: 1, ore: 1 },
};

export const RESOURCES: ResourceType[] = ['wood', 'brick', 'wheat', 'sheep', 'ore'];
export const VICTORY_POINTS_TO_WIN = 10;
