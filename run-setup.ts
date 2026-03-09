/**
 * Run the AI Catan setup phase and save results to setup/
 * Usage:  npx ts-node run-setup.ts [seed]
 *         npx ts-node run-setup.ts          (random seed)
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { generateBoard } from './src/board';
import { createInitialState, currentSetupPlayer, grantSetupResources, logEvent } from './src/gameState';
import { validSetupSettlements, validSetupRoads, isValidSettlementSpot } from './src/rules';
import { createAgent } from './src/agents/agent';
import { serializeState } from './src/state-serializer';

// ─── Config ───────────────────────────────────────────────────────────────────

const PLAYERS = [
  { id: 'p1', name: 'GPT-4o',   model: 'gpt-4o',                color: 'chatgpt'  },
  { id: 'p2', name: 'Gemini',   model: 'gemini-2.0-flash',      color: 'gemini'   },
  { id: 'p3', name: 'Grok',     model: 'grok-3',                color: 'grok'     },
  { id: 'p4', name: 'DeepSeek', model: 'deepseek-chat',         color: 'deepseek' },
  { id: 'p5', name: 'Claude',   model: 'claude-sonnet-4-6',     color: 'claude'   },
];

const PORT_DEFS = [
  { q: -1, r: -1, seaDir: 3, type: 'sheep' },
  { q:  0, r: -2, seaDir: 2, type: 'any'   },
  { q:  1, r: -2, seaDir: 1, type: 'ore'   },
  { q:  2, r: -2, seaDir: 0, type: 'any'   },
  { q:  2, r:  0, seaDir: 1, type: 'wheat' },
  { q:  1, r:  1, seaDir: 5, type: 'any'   },
  { q:  0, r:  2, seaDir: 4, type: 'brick' },
  { q: -2, r:  2, seaDir: 4, type: 'any'   },
  { q: -2, r:  0, seaDir: 3, type: 'wood'  },
];

const CSS_COLORS: Record<string, string> = {
  chatgpt:  '#A73E3A',
  gemini:   '#2863B8',
  grok:     '#2C2C2E',
  deepseek: '#3EABAB',
  claude:   '#409128',
  kimi:     '#9F43A8',
  lama:     '#989131',
};

/** Derive brand hex from model name, falling back to stored color key, then grey. */
function modelToHex(model: string): string {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return CSS_COLORS.chatgpt;
  if (model.startsWith('gemini'))    return CSS_COLORS.gemini;
  if (model.startsWith('grok'))      return CSS_COLORS.grok;
  if (model.startsWith('deepseek'))  return CSS_COLORS.deepseek;
  if (model.startsWith('claude'))    return CSS_COLORS.claude;
  if (model.startsWith('kimi'))      return CSS_COLORS.kimi;
  if (model.startsWith('llama') || model.startsWith('lama')) return CSS_COLORS.lama;
  return '#888888';
}

function playerHex(model: string, colorKey: string): string {
  return CSS_COLORS[colorKey] ?? modelToHex(model);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SetupEntry {
  round: 1 | 2;
  playerName: string;
  playerId: string;
  playerColor: string;
  action: 'settlement' | 'road';
  reasoning: string;
  chosenId: string;
  fallback: boolean;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const seed = process.argv[2] ? parseInt(process.argv[2]) : Math.floor(Math.random() * 0xFFFFFF);
  console.log(`\nSeed: ${seed}`);
  console.log('Running AI setup phase...\n');

  const board = generateBoard(seed);
  const state = createInitialState(PLAYERS, board, seed);
  const agentMap = new Map(PLAYERS.map(p => [p.id, createAgent(p.id, p.name, p.model)]));
  const setupLog: SetupEntry[] = [];
  const n = PLAYERS.length;

  // ── Setup loop ──────────────────────────────────────────────────────────────
  while (state.phase === 'setup' && state.setupIndex < state.setupTurnOrder.length) {
    const player = currentSetupPlayer(state);
    const agent  = agentMap.get(player.id) as any;
    const isSecond = state.setupIndex >= n;
    const round: 1 | 2 = isSecond ? 2 : 1;

    if (state.setupSubPhase === 'settlement') {
      const valid = validSetupSettlements(state, player.id);
      const ctx   = `${player.name} places ${isSecond ? 'SECOND' : 'FIRST'} settlement${isSecond ? ' (grants adjacent resources)' : ''}`;
      console.log(`[Round ${round}] ${player.name} — settlement`);

      const result = await agent.decideSetup(state, valid, ctx);

      let vid = '';
      let fallback = false;
      if (result.action?.type === 'place_settlement') {
        const proposed = result.action.vertexId as string;
        if (isValidSettlementSpot(state, proposed, player.id, true)) vid = proposed;
      }
      if (!vid) { vid = (valid[0] as any).vertexId; fallback = true; }

      state.vertices.get(vid)!.building = { type: 'settlement', playerId: player.id };
      player.settlementsLeft--;
      if (isSecond) grantSetupResources(state, player.id, vid);
      logEvent(state, player.id, 'setup', `${player.name} places settlement at ${vid}${fallback ? ' (fallback)' : ''}`);
      console.log(`  → ${vid}${fallback ? ' (fallback)' : ''}`);

      setupLog.push({ round, playerName: player.name, playerId: player.id, playerColor: playerHex(player.model, player.color), action: 'settlement', reasoning: result.reasoning ?? '', chosenId: vid, fallback });
      state.setupSubPhase = 'road';

    } else {
      // Find the vertex of this player's most recent settlement
      let lastVid = '';
      for (let i = state.log.length - 1; i >= 0; i--) {
        const ev = state.log[i];
        if (ev.playerId === player.id && ev.type === 'setup' && ev.message.includes('settlement at')) {
          const m = ev.message.match(/settlement at (\S+)/);
          if (m) { lastVid = m[1]; break; }
        }
      }

      const valid = validSetupRoads(state, player.id, lastVid);
      const ctx   = `${player.name} places road adjacent to settlement at ${lastVid}`;
      console.log(`[Round ${round}] ${player.name} — road`);

      const result = await agent.decideSetup(state, valid, ctx);

      let eid = '';
      let fallback = false;
      if (result.action?.type === 'place_road') {
        const proposed = result.action.edgeId as string;
        const edge = state.edges.get(proposed);
        if (edge && edge.road === null) eid = proposed;
      }
      if (!eid) { eid = (valid[0] as any).edgeId; fallback = true; }

      state.edges.get(eid)!.road = player.id;
      player.roadsLeft--;
      logEvent(state, player.id, 'setup', `${player.name} places road at ${eid}${fallback ? ' (fallback)' : ''}`);
      console.log(`  → ${eid}${fallback ? ' (fallback)' : ''}`);

      setupLog.push({ round, playerName: player.name, playerId: player.id, playerColor: playerHex(player.model, player.color), action: 'road', reasoning: result.reasoning ?? '', chosenId: eid, fallback });
      state.setupSubPhase = 'settlement';
      state.setupIndex++;
    }

    if (state.setupIndex >= state.setupTurnOrder.length) {
      state.phase = 'main';
      state.turn = 1;
      break;
    }
  }

  console.log('\nSetup complete. Starting resources:');
  for (const p of state.players) {
    const r = p.resources;
    console.log(`  ${p.name}: wood:${r.wood} brick:${r.brick} wheat:${r.wheat} sheep:${r.sheep} ore:${r.ore}`);
  }

  // ── Collect final board state ─────────────────────────────────────────────
  const hexes = [...board.hexes.values()].map(h => ({
    id: h.id, q: h.q, r: h.r, type: h.type, number: h.number, hasRobber: h.hasRobber,
  }));
  const settlements = [...state.vertices.values()].filter(v => v.building).map(v => {
    const p = PLAYERS.find(pl => pl.id === v.building!.playerId)!;
    return { vertexId: v.id, playerId: p.id, playerName: p.name, playerColor: playerHex(p.model, p.color) };
  });
  const roads = [...state.edges.values()].filter(e => e.road).map(e => {
    const p = PLAYERS.find(pl => pl.id === e.road)!;
    return { edgeId: e.id, playerId: p.id, playerName: p.name, playerColor: playerHex(p.model, p.color) };
  });

  // ── Save files ────────────────────────────────────────────────────────────
  const gameDir   = path.join('games', String(seed));
  const setupDir  = path.join(gameDir, 'setup');
  fs.mkdirSync(setupDir, { recursive: true });

  const playersWithHex = PLAYERS.map(p => ({ ...p, colorHex: playerHex(p.model, p.color) }));
  const mapData = { seed, hexes, ports: PORT_DEFS, settlements, roads, players: playersWithHex };
  fs.writeFileSync(path.join(gameDir,  'map.html'),           buildMapHtml({ ...mapData, settlements: [], roads: [] }));
  fs.writeFileSync(path.join(setupDir, 'setup-map.html'),     buildMapHtml(mapData));
  fs.writeFileSync(path.join(setupDir, 'dialogue.html'),      buildDialogueHtml(seed, setupLog));
  fs.writeFileSync(path.join(gameDir,  'state.json'),         JSON.stringify(serializeState(state), null, 2));

  console.log(`\nSaved to games/${seed}/`);
  console.log(`  map.html           (blank board)`);
  console.log(`  state.json         (game state for turn runner)`);
  console.log(`  setup/setup-map.html`);
  console.log(`  setup/dialogue.html\n`);
}

main().catch(e => { console.error(e); process.exit(1); });

// ─── Shared SVG JS (embedded in both HTML files) ──────────────────────────────

const SHARED_SVG_JS = `
const COLORS={wood:'#2e6b30',wheat:'#c8960e',sheep:'#72b85e',brick:'#aa3e22',ore:'#5a6070',desert:'#c4a96a',ocean:'#14467a'};
const BORDER={wood:'#1e4a20',wheat:'#8f6a08',sheep:'#4e8a3e',brick:'#7a2a14',ore:'#3a4050',desert:'#9a7e48'};
const PORT_COLORS={any:'#9b59b6',wood:'#2e8b30',wheat:'#e0b020',sheep:'#5fba4a',brick:'#cc4428',ore:'#7888aa'};
const PIPS={2:1,3:2,4:3,5:4,6:5,8:5,9:4,10:3,11:2,12:1};
const SVG_NS='http://www.w3.org/2000/svg';
function el(t,a={}){const e=document.createElementNS(SVG_NS,t);for(const[k,v]of Object.entries(a))e.setAttribute(k,v);return e;}
function hexCenter(q,r,sz,ox,oy){return{x:ox+sz*Math.sqrt(3)*(q+r/2),y:oy+sz*1.5*r};}
function hexCorners(cx,cy,sz){return Array.from({length:6},(_,i)=>{const a=-Math.PI/6-Math.PI/3*i;return[cx+sz*Math.cos(a),cy+sz*Math.sin(a)];});}
function portFace(q,r,sd,sz,ox,oy){const{x:cx,y:cy}=hexCenter(q,r,sz,ox,oy);const c=hexCorners(cx,cy,sz);const c1=c[(sd-1+6)%6],c2=c[sd];const mx=(c1[0]+c2[0])/2,my=(c1[1]+c2[1])/2;const dx=mx-cx,dy=my-cy,len=Math.sqrt(dx*dx+dy*dy);return{c1,c2,mx,my,nx:dx/len,ny:dy/len,cx,cy};}
function vertexPos(vid,sz,ox,oy){const ids=vid.split('|').map(h=>h.replace(/^~/,''));let sx=0,sy=0;for(const hid of ids){const[q,r]=hid.split(',').map(Number);const c=hexCenter(q,r,sz,ox,oy);sx+=c.x;sy+=c.y;}return{x:sx/ids.length,y:sy/ids.length};}
function edgePts(eid,sz,ox,oy){const[v1,v2]=eid.split('||');return{p1:vertexPos(v1,sz,ox,oy),p2:vertexPos(v2,sz,ox,oy)};}
function drawBoard(svg,D,W,H,sz){
  const ox=W/2,oy=H/2-10;
  svg.setAttribute('viewBox',\`0 0 \${W} \${H}\`);svg.setAttribute('width',W);svg.setAttribute('height',H);
  svg.appendChild(el('rect',{x:0,y:0,width:W,height:H,fill:COLORS.ocean}));
  for(const hex of D.hexes){
    const{x:cx,y:cy}=hexCenter(hex.q,hex.r,sz,ox,oy);
    const corners=hexCorners(cx,cy,sz);
    const pts=corners.map(([x,y])=>\`\${x.toFixed(1)},\${y.toFixed(1)}\`).join(' ');
    svg.appendChild(el('polygon',{points:pts,fill:COLORS[hex.type]??'#888',stroke:BORDER[hex.type]??'#444','stroke-width':'2'}));
    if(hex.type==='desert'){
      const t=el('text',{x:cx,y:cy+6,'text-anchor':'middle','font-size':'26',fill:'rgba(0,0,0,0.28)'});t.textContent='♟';svg.appendChild(t);
      const lb=el('text',{x:cx,y:cy+22,'text-anchor':'middle','font-size':'8',fill:'rgba(0,0,0,0.3)','letter-spacing':'1'});lb.textContent='DESERT';svg.appendChild(lb);
      continue;
    }
    const isRed=hex.number===6||hex.number===8;
    svg.appendChild(el('circle',{cx,cy,r:18,fill:isRed?'#f5ede0':'#f5f0e8',stroke:isRed?'#c44':'#bbb','stroke-width':'1.5'}));
    const nt=el('text',{x:cx,y:cy+5,'text-anchor':'middle','font-size':'16','font-weight':'bold','font-family':'Georgia,serif',fill:isRed?'#c00':'#222'});nt.textContent=hex.number??'';svg.appendChild(nt);
    const pips=PIPS[hex.number]??0,sp=5,tw=(pips-1)*sp;
    for(let p=0;p<pips;p++)svg.appendChild(el('circle',{cx:cx-tw/2+p*sp,cy:cy+13,r:'1.8',fill:isRed?'#c00':'#444'}));
    const rl=el('text',{x:cx,y:cy-24,'text-anchor':'middle','font-size':'8','letter-spacing':'0.5',fill:'rgba(255,255,255,0.65)'});rl.textContent=hex.type.toUpperCase();svg.appendChild(rl);
  }
  for(const port of D.ports){
    const col=PORT_COLORS[port.type]??'#aaa';
    const f=portFace(port.q,port.r,port.seaDir,sz,ox,oy);
    svg.appendChild(el('line',{x1:f.c1[0],y1:f.c1[1],x2:f.c2[0],y2:f.c2[1],stroke:col,'stroke-width':'5','stroke-linecap':'round'}));
    const lx=f.cx+f.nx*(sz*0.87+sz*0.38),ly=f.cy+f.ny*(sz*0.87+sz*0.38);
    const bgW=port.type==='any'?28:52;
    svg.appendChild(el('rect',{x:lx-bgW/2,y:ly-9,width:bgW,height:16,rx:4,fill:col,opacity:'0.92'}));
    const lt=el('text',{x:lx,y:ly+4,'text-anchor':'middle','font-size':'9','font-weight':'bold','font-family':'Georgia,serif',fill:'#fff'});lt.textContent=port.type==='any'?'3:1':\`2:1 \${port.type[0].toUpperCase()}\`;svg.appendChild(lt);
    svg.appendChild(el('line',{x1:(f.c1[0]+f.c2[0])/2,y1:(f.c1[1]+f.c2[1])/2,x2:lx,y2:ly,stroke:col,'stroke-width':'1.5','stroke-dasharray':'3,2',opacity:'0.6'}));
  }
  // Roads (draw under settlements)
  for(const road of D.roads){
    const col=road.playerColor;
    const{p1,p2}=edgePts(road.edgeId,sz,ox,oy);
    svg.appendChild(el('line',{x1:p1.x,y1:p1.y,x2:p2.x,y2:p2.y,stroke:'rgba(0,0,0,0.35)','stroke-width':'8','stroke-linecap':'round'}));
    svg.appendChild(el('line',{x1:p1.x,y1:p1.y,x2:p2.x,y2:p2.y,stroke:col,'stroke-width':'5','stroke-linecap':'round'}));
  }
  // Settlements
  for(const s of D.settlements){
    const{x,y}=vertexPos(s.vertexId,sz,ox,oy);
    const col=s.playerColor;
    svg.appendChild(el('circle',{cx:x,cy:y,r:10,fill:'rgba(0,0,0,0.35)','stroke-width':'0'}));
    svg.appendChild(el('circle',{cx:x,cy:y,r:9,fill:col,stroke:'#fff','stroke-width':'2'}));
  }
}`;

// ─── Map HTML ─────────────────────────────────────────────────────────────────

function buildMapHtml(data: {
  seed: number; hexes: any[]; ports: any[];
  settlements: any[]; roads: any[]; players: any[];
}): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>AI Catan — Setup Map (Seed ${data.seed})</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d2b4a;font-family:'Georgia',serif;color:#f0e6d3;display:flex;flex-direction:column;align-items:center;min-height:100vh}
header{padding:18px 0 4px;font-size:1.4em;letter-spacing:4px;color:#f5d78e;text-transform:uppercase}
#sub{font-size:0.75em;color:#9ab8d8;letter-spacing:2px;margin-bottom:10px}
#board-svg{display:block;max-width:100%}
#legend{display:flex;gap:14px;margin:10px 0 24px;flex-wrap:wrap;justify-content:center}
.pc{background:rgba(255,255,255,0.06);border:2px solid;border-radius:8px;padding:7px 14px;display:flex;align-items:center;gap:9px;font-size:0.87em}
.pd{width:13px;height:13px;border-radius:50%}</style></head>
<body><header>AI CATAN</header>
<div id="sub">SETUP COMPLETE — SEED: ${data.seed}</div>
<svg id="board-svg"></svg>
<div id="legend"></div>
<script>
const D=${JSON.stringify(data)};
${SHARED_SVG_JS}
const svg=document.getElementById('board-svg');
drawBoard(svg,D,760,680,62);
const leg=document.getElementById('legend');
for(const p of D.players){
  const col=p.colorHex??'#fff';
  const c=document.createElement('div');c.className='pc';c.style.borderColor=col;
  c.innerHTML=\`<div class="pd" style="background:\${col}"></div><b>\${p.name}</b><span style="color:#9ab8d8;font-size:0.85em">\${p.model}</span>\`;
  leg.appendChild(c);
}
</script></body></html>`;
}

// ─── Dialogue HTML ────────────────────────────────────────────────────────────

function buildDialogueHtml(seed: number, log: SetupEntry[]): string {
  const entryHtml = log.map((e, i) => {
    const col = e.playerColor;
    const badge = e.action === 'settlement'
      ? `<span style="background:#4a5568;color:#e2e8f0;padding:2px 8px;border-radius:4px;font-size:0.75em;letter-spacing:1px">SETTLEMENT</span>`
      : `<span style="background:#2d3748;color:#90cdf4;padding:2px 8px;border-radius:4px;font-size:0.75em;letter-spacing:1px">ROAD</span>`;
    const fallbackBadge = e.fallback
      ? `<span style="color:#f6ad55;font-size:0.75em;margin-left:6px">⚠ fallback</span>` : '';
    const reasoningHtml = e.reasoning
      ? `<div style="margin-top:10px;color:#e2e8f0;line-height:1.6;font-size:0.9em;white-space:pre-wrap">${escapeHtml(e.reasoning)}</div>` : '';

    // Section divider before round 2 first entry
    const divider = (i > 0 && e.round === 2 && log[i - 1].round === 1)
      ? `<div style="text-align:center;color:#4a7aab;letter-spacing:3px;font-size:0.8em;margin:28px 0 16px;border-top:1px solid #1e3a5c;padding-top:16px">ROUND 2 — REVERSE ORDER</div>` : '';
    const firstDivider = i === 0
      ? `<div style="text-align:center;color:#4a7aab;letter-spacing:3px;font-size:0.8em;margin-bottom:16px">ROUND 1 — FORWARD ORDER</div>` : '';

    return `${firstDivider}${divider}
<div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-left:4px solid ${col};border-radius:8px;padding:14px 18px;margin-bottom:10px">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <div style="width:11px;height:11px;border-radius:50%;background:${col};flex-shrink:0"></div>
    <span style="color:${col};font-weight:bold;font-size:0.95em">${escapeHtml(e.playerName)}</span>
    ${badge}${fallbackBadge}
  </div>
  ${reasoningHtml}
  <div style="margin-top:8px;font-size:0.75em;color:#4a7aab;font-family:monospace;word-break:break-all">→ ${escapeHtml(e.chosenId)}</div>
</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>AI Catan — Setup Dialogue (Seed ${seed})</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d2b4a;font-family:'Georgia',serif;color:#f0e6d3;display:flex;flex-direction:column;align-items:center;min-height:100vh}
header{padding:18px 0 4px;font-size:1.4em;letter-spacing:4px;color:#f5d78e;text-transform:uppercase}
#sub{font-size:0.75em;color:#9ab8d8;letter-spacing:2px;margin-bottom:20px}
#log{width:100%;max-width:720px;padding:0 20px 40px}</style></head>
<body><header>AI CATAN</header>
<div id="sub">SETUP DIALOGUE — SEED: ${seed}</div>
<div id="log">${entryHtml}</div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
