import { Hex, Vertex, Edge, TileType, PortType, ResourceType } from './types';

// ─── Axial coordinate helpers ─────────────────────────────────────────────────

// Six directions: E, NE, NW, W, SW, SE
const DIRECTIONS: [number, number][] = [
  [1, 0],   // 0: E
  [1, -1],  // 1: NE
  [0, -1],  // 2: NW
  [-1, 0],  // 3: W
  [-1, 1],  // 4: SW
  [0, 1],   // 5: SE
];

function hexId(q: number, r: number): string {
  return `${q},${r}`;
}

function neighborId(q: number, r: number, dir: number): string {
  return hexId(q + DIRECTIONS[dir][0], r + DIRECTIONS[dir][1]);
}

// A vertex is identified by the sorted IDs of up to 3 hexes that meet at it
// Off-board hexes get a "~" prefix so they still produce unique IDs
function makeVertexId(ids: string[]): string {
  return [...ids].sort().join('|');
}

// Corner i of hex (q,r) is the junction of H, H+dir[i], H+dir[(i+1)%6]
function cornerKey(q: number, r: number, cornerIndex: number, boardSet: Set<string>): string {
  const tag = (id: string) => boardSet.has(id) ? id : `~${id}`;
  const h = hexId(q, r);
  const n1 = neighborId(q, r, cornerIndex);
  const n2 = neighborId(q, r, (cornerIndex + 1) % 6);
  return makeVertexId([tag(h), tag(n1), tag(n2)]);
}

// Edge between corner i and corner (i+1)%6 of hex (q,r)
function edgeKey(vKey1: string, vKey2: string): string {
  return [vKey1, vKey2].sort().join('||');
}

// ─── Standard board hex positions (axial, max(|q|,|r|,|q+r|) ≤ 2) ───────────

const HEX_POSITIONS: [number, number][] = [
  [-2, 0], [-2, 1], [-2, 2],
  [-1, -1], [-1, 0], [-1, 1], [-1, 2],
  [0, -2], [0, -1], [0, 0], [0, 1], [0, 2],
  [1, -2], [1, -1], [1, 0], [1, 1],
  [2, -2], [2, -1], [2, 0],
];

// ─── Tile and number distribution ────────────────────────────────────────────

const TILE_TYPES: TileType[] = [
  'wood', 'wood', 'wood', 'wood',
  'wheat', 'wheat', 'wheat', 'wheat',
  'sheep', 'sheep', 'sheep', 'sheep',
  'ore', 'ore', 'ore',
  'brick', 'brick', 'brick',
  'desert',
];

// Numbers placed using the standard Catan spiral (A-R, skipping desert)
// 2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12
const NUMBER_TOKENS = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];

// Standard Catan spiral order (index into HEX_POSITIONS) for number placement
// Starts top-left, goes clockwise around rings then inward
const SPIRAL_ORDER = [0, 3, 7, 12, 16, 13, 17, 18, 15, 11, 6, 2, 1, 4, 8, 14, 10, 5, 9];

// ─── Port definitions (hex_q, hex_r, sea_direction, port_type) ───────────────
// Edge on coastal face = edge between corner (dir-1+6)%6 and corner dir of the hex

interface PortDef {
  q: number;
  r: number;
  seaDir: number;
  type: PortType;
}

const PORT_DEFINITIONS: PortDef[] = [
  { q: -1, r: -1, seaDir: 3, type: 'sheep' },  // W face of top-left border hex
  { q:  0, r: -2, seaDir: 2, type: 'any'   },  // NW face top hex
  { q:  1, r: -2, seaDir: 1, type: 'ore'   },  // NE face top-right hex
  { q:  2, r: -2, seaDir: 0, type: 'any'   },  // E face right-top corner
  { q:  2, r:  0, seaDir: 1, type: 'wheat' },  // NE face right-bottom hex
  { q:  1, r:  1, seaDir: 5, type: 'any'   },  // SE face lower-right hex
  { q:  0, r:  2, seaDir: 4, type: 'brick' },  // SW face bottom hex
  { q: -2, r:  2, seaDir: 4, type: 'any'   },  // SW face bottom-left hex
  { q: -2, r:  0, seaDir: 3, type: 'wood'  },  // W face left hex
];

// ─── Seeded random shuffle ────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Board generation ─────────────────────────────────────────────────────────

export interface Board {
  hexes: Map<string, Hex>;
  vertices: Map<string, Vertex>;
  edges: Map<string, Edge>;
}

export function generateBoard(seed?: number): Board {
  const rng = mulberry32(seed ?? Math.floor(Math.random() * 0xFFFFFF));

  const boardSet = new Set(HEX_POSITIONS.map(([q, r]) => hexId(q, r)));

  // 1. Assign tile types (shuffled)
  const shuffledTiles = shuffle(TILE_TYPES, rng);

  // 2. Assign number tokens in spiral order, skipping desert
  const hexes = new Map<string, Hex>();
  let tokenIdx = 0;
  const spiralHexIds = SPIRAL_ORDER.map(i => hexId(HEX_POSITIONS[i][0], HEX_POSITIONS[i][1]));

  HEX_POSITIONS.forEach(([q, r], i) => {
    const id = hexId(q, r);
    const type = shuffledTiles[i];
    hexes.set(id, { id, q, r, type, number: null, hasRobber: false });
  });

  // Place number tokens following spiral order, skip desert hex
  for (const hid of spiralHexIds) {
    const hex = hexes.get(hid)!;
    if (hex.type !== 'desert' && tokenIdx < NUMBER_TOKENS.length) {
      hex.number = NUMBER_TOKENS[tokenIdx++];
    }
  }

  // Place robber on desert
  for (const hex of hexes.values()) {
    if (hex.type === 'desert') {
      hex.hasRobber = true;
      break;
    }
  }

  // 3. Build vertex and edge maps from hex corners
  const vertices = new Map<string, Vertex>();
  const edges = new Map<string, Edge>();

  for (const [q, r] of HEX_POSITIONS) {
    const corners: string[] = [];
    for (let i = 0; i < 6; i++) {
      const vid = cornerKey(q, r, i, boardSet);
      corners.push(vid);
      if (!vertices.has(vid)) {
        // Collect which board hexes touch this vertex
        const hids: string[] = [];
        const h = hexId(q, r);
        const n1 = neighborId(q, r, i);
        const n2 = neighborId(q, r, (i + 1) % 6);
        if (boardSet.has(h)) hids.push(h);
        if (boardSet.has(n1)) hids.push(n1);
        if (boardSet.has(n2)) hids.push(n2);
        vertices.set(vid, { id: vid, hexIds: hids, building: null, port: null });
      }
    }

    // Create edges between consecutive corners
    for (let i = 0; i < 6; i++) {
      const eid = edgeKey(corners[i], corners[(i + 1) % 6]);
      if (!edges.has(eid)) {
        const [v1, v2] = [corners[i], corners[(i + 1) % 6]].sort() as [string, string];
        edges.set(eid, { id: eid, vertexIds: [v1, v2], road: null });
      }
    }
  }

  // 4. Assign ports to coastal vertices
  for (const pd of PORT_DEFINITIONS) {
    const { q, r, seaDir, type } = pd;
    const hid = hexId(q, r);
    if (!boardSet.has(hid)) continue;

    // The two vertices on the sea-facing edge:
    // corner (seaDir-1+6)%6 and corner seaDir
    const vA = cornerKey(q, r, (seaDir - 1 + 6) % 6, boardSet);
    const vB = cornerKey(q, r, seaDir, boardSet);

    const vertA = vertices.get(vA);
    const vertB = vertices.get(vB);
    if (vertA) vertA.port = type;
    if (vertB) vertB.port = type;
  }

  return { hexes, vertices, edges };
}

// ─── Board query helpers ──────────────────────────────────────────────────────

/** Vertices adjacent to a given vertex (connected by an edge) */
export function adjacentVertices(vertexId: string, edges: Map<string, Edge>): string[] {
  const result: string[] = [];
  for (const edge of edges.values()) {
    if (edge.vertexIds[0] === vertexId) result.push(edge.vertexIds[1]);
    else if (edge.vertexIds[1] === vertexId) result.push(edge.vertexIds[0]);
  }
  return result;
}

/** All edges touching a vertex */
export function edgesAtVertex(vertexId: string, edges: Map<string, Edge>): Edge[] {
  return [...edges.values()].filter(e => e.vertexIds.includes(vertexId));
}

/** Vertices adjacent to a hex */
export function verticesOfHex(hexId: string, vertices: Map<string, Vertex>): Vertex[] {
  return [...vertices.values()].filter(v => v.hexIds.includes(hexId));
}

/** Human-readable board summary for AI prompts */
export function describeBoardHexes(hexes: Map<string, Hex>): string {
  const lines: string[] = [];
  for (const hex of hexes.values()) {
    const robber = hex.hasRobber ? ' [ROBBER]' : '';
    const num = hex.number ? `#${hex.number}` : 'desert';
    lines.push(`  ${hex.id}: ${hex.type.toUpperCase()} ${num}${robber}`);
  }
  return lines.join('\n');
}

/** Get the resource a hex produces */
export function hexResource(hex: Hex): ResourceType | null {
  if (hex.type === 'desert') return null;
  return hex.type as ResourceType;
}
