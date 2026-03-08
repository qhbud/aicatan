/**
 * Generate and display a random Catan board.
 * Usage:  npx ts-node generate-map.ts [seed]
 */
import { generateBoard, Board } from './src/board';
import { Hex } from './src/types';

const PIPS: Record<number, number> = {
  2: 1, 3: 2, 4: 3, 5: 4, 6: 5,
  8: 5, 9: 4, 10: 3, 11: 2, 12: 1,
};

const RESOURCE_COLORS: Record<string, string> = {
  wood:   '\x1b[32m',   // green
  wheat:  '\x1b[33m',   // yellow
  sheep:  '\x1b[92m',   // bright green
  brick:  '\x1b[31m',   // red
  ore:    '\x1b[37m',   // grey/white
  desert: '\x1b[90m',   // dark grey
};
const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';

// ─── Display rows: which (q,r) hexes appear in each visual row (top → bottom) ─

const DISPLAY_ROWS: [number, number][][] = [
  [[0,-2], [1,-2], [2,-2]],
  [[-1,-1],[0,-1], [1,-1], [2,-1]],
  [[-2,0], [-1,0], [0,0],  [1,0],  [2,0]],
  [[-2,1], [-1,1], [0,1],  [1,1]],
  [[-2,2], [-1,2], [0,2]],
];

// ─── Hex box drawing ──────────────────────────────────────────────────────────

function hexLine1(hex: Hex): string {
  const col = RESOURCE_COLORS[hex.type] ?? '';
  const label = hex.type === 'desert' ? 'DESERT' : hex.type.toUpperCase().padEnd(6);
  return col + BOLD + label + RESET;
}

function hexLine2(hex: Hex): string {
  if (hex.type === 'desert') return DIM + ' robber ' + RESET;
  const pips = PIPS[hex.number ?? 0] ?? 0;
  const dots = '✦'.repeat(pips);
  const isRed = hex.number === 6 || hex.number === 8;
  const numCol = isRed ? '\x1b[31m' : '\x1b[36m';
  const numStr = `#${hex.number}`.padEnd(3);
  return numCol + BOLD + numStr + RESET + DIM + ` ${dots.padEnd(5)}` + RESET;
}

// ─── Board rendering ──────────────────────────────────────────────────────────

function renderBoard(board: Board): void {
  const maxWidth = 5; // hexes in widest row
  const hexW = 10;    // characters per hex cell

  console.log();

  for (let rowIdx = 0; rowIdx < DISPLAY_ROWS.length; rowIdx++) {
    const row = DISPLAY_ROWS[rowIdx];
    const indent = ' '.repeat(((maxWidth - row.length) * hexW) / 2);

    // Collect hex data for this row
    const hexes = row.map(([q, r]) => board.hexes.get(`${q},${r}`)!);

    // Top border
    console.log(indent + hexes.map(() => ' ╔════════╗ ').join(' '));
    // Line 1: resource
    console.log(indent + hexes.map(h => ` ║ ${hexLine1(h)} ║ `).join(' '));
    // Line 2: number + pips
    console.log(indent + hexes.map(h => ` ║ ${hexLine2(h)}  ║ `).join(' '));
    // Bottom border
    console.log(indent + hexes.map(() => ' ╚════════╝ ').join(' '));

    if (rowIdx < DISPLAY_ROWS.length - 1) console.log();
  }
}

// ─── Port summary ─────────────────────────────────────────────────────────────

function renderPorts(board: Board): void {
  const portVertices = [...board.vertices.values()].filter(v => v.port);

  // Group vertex pairs by port type
  const portGroups = new Map<string, string[]>();
  for (const v of portVertices) {
    const key = v.port!;
    if (!portGroups.has(key)) portGroups.set(key, []);
    portGroups.get(key)!.push(v.id);
  }

  console.log('\nPORTS:');
  for (const [type, vids] of portGroups) {
    const ratio = type === 'any' ? '3:1' : '2:1';
    const col = type === 'any' ? '\x1b[35m' : (RESOURCE_COLORS[type] ?? '');
    const label = type === 'any' ? '3:1 (any resource)' : `2:1 ${type.toUpperCase()}`;
    console.log(`  ${col}${BOLD}${ratio} ${label}${RESET}  — vertices: ${vids.length / 2 | 0} port location(s)`);
  }
}

// ─── Production stats ─────────────────────────────────────────────────────────

function renderStats(board: Board): void {
  const totals: Record<string, number> = { wood: 0, wheat: 0, sheep: 0, brick: 0, ore: 0 };

  for (const hex of board.hexes.values()) {
    if (hex.type === 'desert') continue;
    const pips = PIPS[hex.number ?? 0] ?? 0;
    totals[hex.type] = (totals[hex.type] ?? 0) + pips;
  }

  console.log('\nRESOURCE PRODUCTION (sum of pips across all tiles):');
  const maxPips = Math.max(...Object.values(totals));
  for (const [res, pips] of Object.entries(totals).sort(([,a],[,b]) => b - a)) {
    const col = RESOURCE_COLORS[res] ?? '';
    const bar = '█'.repeat(Math.round((pips / maxPips) * 20));
    const pad = ' '.repeat(6 - res.length);
    console.log(`  ${col}${BOLD}${res}${pad}${RESET}  ${bar.padEnd(20)} ${pips} pips`);
  }

  // Hex numbers frequency
  console.log('\nNUMBER DISTRIBUTION:');
  const numCounts: Record<number, number> = {};
  for (const hex of board.hexes.values()) {
    if (hex.number) numCounts[hex.number] = (numCounts[hex.number] ?? 0) + 1;
  }
  const nums = Object.entries(numCounts).sort(([a],[b]) => Number(a) - Number(b));
  for (const [num, count] of nums) {
    const pips = PIPS[Number(num)] ?? 0;
    const isRed = num === '6' || num === '8';
    const col = isRed ? '\x1b[31m' : '\x1b[36m';
    const dots = '✦'.repeat(pips);
    console.log(`  ${col}${BOLD}${String(num).padStart(2)}${RESET}  ${dots.padEnd(5)}  ×${count}`);
  }
}

// ─── High-value intersections ─────────────────────────────────────────────────

function renderTopIntersections(board: Board): void {
  const intersections = [...board.vertices.values()]
    .filter(v => v.hexIds.length >= 2)
    .map(v => {
      let pips = 0;
      const resources = new Set<string>();
      for (const hid of v.hexIds) {
        const h = board.hexes.get(hid)!;
        if (h.type !== 'desert') {
          pips += PIPS[h.number ?? 0] ?? 0;
          resources.add(h.type);
        }
      }
      return { id: v.id, pips, resources, port: v.port };
    })
    .sort((a, b) => b.pips - a.pips || b.resources.size - a.resources.size)
    .slice(0, 8);

  console.log('\nTOP SETTLEMENT SPOTS (by pip total):');
  for (const s of intersections) {
    const diversity = s.resources.size === 3 ? '★★★' : s.resources.size === 2 ? '★★ ' : '★  ';
    const resStr = [...s.resources].join('+');
    const portStr = s.port ? `  [${s.port.toUpperCase()}-PORT]` : '';
    const col = s.pips >= 13 ? '\x1b[92m' : s.pips >= 10 ? '\x1b[33m' : '\x1b[37m';
    console.log(`  ${col}${BOLD}${String(s.pips).padStart(2)} pips${RESET}  ${diversity}  ${resStr}${portStr}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const seed = process.argv[2] ? parseInt(process.argv[2]) : Math.floor(Math.random() * 0xFFFFFF);
const board = generateBoard(seed);

console.log(BOLD + '\n╔══════════════════════════════════════╗');
console.log('║      AI CATAN — RANDOM BOARD          ║');
console.log(`║      Seed: ${String(seed).padEnd(26)}║`);
console.log('╚══════════════════════════════════════╝' + RESET);

renderBoard(board);
renderPorts(board);
renderStats(board);
renderTopIntersections(board);

console.log(`\n${DIM}Run with this seed:  npx ts-node generate-map.ts ${seed}${RESET}`);
console.log(`${DIM}Use in game:         edit src/index.ts → seed: ${seed}${RESET}\n`);
