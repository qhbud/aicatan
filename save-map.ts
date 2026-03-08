/**
 * Generate a Catan board and save it to maps/<seed>.html (self-contained)
 * Usage:  npx ts-node save-map.ts [seed]
 *         npx ts-node save-map.ts          (random seed)
 */
import { generateBoard } from './src/board';
import * as fs from 'fs';
import * as path from 'path';

// Port definitions — static (not affected by seed)
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

const seed = process.argv[2] ? parseInt(process.argv[2]) : Math.floor(Math.random() * 0xFFFFFF);
const board = generateBoard(seed);

const mapData = {
  seed,
  generatedAt: new Date().toISOString(),
  hexes: [...board.hexes.values()].map(h => ({
    id: h.id, q: h.q, r: h.r,
    type: h.type, number: h.number, hasRobber: h.hasRobber,
  })),
  ports: PORT_DEFS,
};

const html = buildHtml(mapData);

fs.mkdirSync('maps', { recursive: true });
const outPath = path.join('maps', `${seed}.html`);
fs.writeFileSync(outPath, html);

console.log(`\nSaved: ${outPath}`);
console.log(`Just open that file in any browser to view the map.\n`);

// ─── HTML template ────────────────────────────────────────────────────────────

function buildHtml(data: typeof mapData): string {
  const json = JSON.stringify(data);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AI Catan — Seed ${data.seed}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d2b4a;
      font-family: 'Georgia', serif;
      color: #f0e6d3;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    header { padding: 18px 0 4px; font-size: 1.4em; letter-spacing: 4px; color: #f5d78e; text-transform: uppercase; text-shadow: 0 2px 8px rgba(0,0,0,0.6); }
    #seed-label { font-size: 0.75em; color: #9ab8d8; letter-spacing: 2px; margin-bottom: 14px; }
    #board-svg { display: block; max-width: 100%; }
    #info-row { display: flex; gap: 24px; margin: 10px 0 28px; flex-wrap: wrap; justify-content: center; font-size: 0.82em; }
    .info-card { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px 18px; min-width: 155px; }
    .info-card h3 { font-size: 0.8em; letter-spacing: 2px; color: #9ab8d8; text-transform: uppercase; margin-bottom: 8px; }
    .legend-row { display: flex; align-items: center; gap: 8px; margin: 3px 0; }
    .legend-swatch { width: 13px; height: 13px; border-radius: 3px; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.2); }
    .pip-bar { display: inline-block; height: 6px; background: #f5d78e; border-radius: 3px; margin-left: 2px; vertical-align: middle; }
    .port-row { display: flex; align-items: center; gap: 7px; margin: 3px 0; }
    .port-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  </style>
</head>
<body>
  <header>AI CATAN</header>
  <div id="seed-label"></div>
  <svg id="board-svg"></svg>
  <div id="info-row"></div>
<script>
const MAP_DATA = ${json};

const COLORS = { wood:'#2e6b30', wheat:'#c8960e', sheep:'#72b85e', brick:'#aa3e22', ore:'#5a6070', desert:'#c4a96a', ocean:'#14467a' };
const BORDER  = { wood:'#1e4a20', wheat:'#8f6a08', sheep:'#4e8a3e', brick:'#7a2a14', ore:'#3a4050', desert:'#9a7e48' };
const PORT_COLORS = { any:'#9b59b6', wood:'#2e8b30', wheat:'#e0b020', sheep:'#5fba4a', brick:'#cc4428', ore:'#7888aa' };
const PORT_LABELS = { any:'3:1', wood:'2:1 Wood', wheat:'2:1 Wheat', sheep:'2:1 Sheep', brick:'2:1 Brick', ore:'2:1 Ore' };
const PIPS = {2:1,3:2,4:3,5:4,6:5,8:5,9:4,10:3,11:2,12:1};

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs={}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k,v] of Object.entries(attrs)) e.setAttribute(k,v);
  return e;
}

function hexCenter(q, r, size, ox, oy) {
  return { x: ox + size * Math.sqrt(3) * (q + r/2), y: oy + size * 1.5 * r };
}

function hexCorners(cx, cy, size) {
  return Array.from({length:6}, (_,i) => {
    const a = -Math.PI/6 - Math.PI/3*i;
    return [cx + size*Math.cos(a), cy + size*Math.sin(a)];
  });
}

function portFace(q, r, seaDir, size, ox, oy) {
  const {x:cx, y:cy} = hexCenter(q, r, size, ox, oy);
  const corners = hexCorners(cx, cy, size);
  const c1 = corners[(seaDir-1+6)%6], c2 = corners[seaDir];
  const mx = (c1[0]+c2[0])/2, my = (c1[1]+c2[1])/2;
  const dx = mx-cx, dy = my-cy, len = Math.sqrt(dx*dx+dy*dy);
  return {c1, c2, mx, my, nx:dx/len, ny:dy/len, cx, cy};
}

function render() {
  const data = MAP_DATA;
  const svg = document.getElementById('board-svg');
  const W=760, H=680, ox=W/2, oy=H/2-10, size=62;
  svg.setAttribute('viewBox', \`0 0 \${W} \${H}\`);
  svg.setAttribute('width', W); svg.setAttribute('height', H);

  svg.appendChild(el('rect', {x:0,y:0,width:W,height:H,fill:COLORS.ocean}));

  for (const hex of data.hexes) {
    const {x:cx, y:cy} = hexCenter(hex.q, hex.r, size, ox, oy);
    const corners = hexCorners(cx, cy, size);
    const pts = corners.map(([x,y]) => \`\${x.toFixed(1)},\${y.toFixed(1)}\`).join(' ');

    svg.appendChild(el('polygon', {points:pts, fill:COLORS[hex.type]??'#888', stroke:BORDER[hex.type]??'#444', 'stroke-width':'2'}));

    if (hex.type === 'desert') {
      const t = el('text', {x:cx, y:cy+6, 'text-anchor':'middle', 'font-size':'28', fill:'rgba(0,0,0,0.3)'});
      t.textContent = '♟'; svg.appendChild(t);
      const lb = el('text', {x:cx, y:cy+23, 'text-anchor':'middle', 'font-size':'8', fill:'rgba(0,0,0,0.35)', 'letter-spacing':'1'});
      lb.textContent = 'DESERT'; svg.appendChild(lb);
      continue;
    }

    const isRed = hex.number===6 || hex.number===8;
    svg.appendChild(el('circle', {cx, cy, r:18, fill:isRed?'#f5ede0':'#f5f0e8', stroke:isRed?'#c44':'#bbb', 'stroke-width':'1.5'}));

    const nt = el('text', {x:cx, y:cy+5, 'text-anchor':'middle', 'font-size':'16', 'font-weight':'bold', 'font-family':'Georgia,serif', fill:isRed?'#c00':'#222'});
    nt.textContent = hex.number??''; svg.appendChild(nt);

    const pips = PIPS[hex.number]??0, sp=5, tw=(pips-1)*sp;
    for (let p=0; p<pips; p++) {
      svg.appendChild(el('circle', {cx:cx-tw/2+p*sp, cy:cy+13, r:'1.8', fill:isRed?'#c00':'#444'}));
    }

    const rl = el('text', {x:cx, y:cy-24, 'text-anchor':'middle', 'font-size':'8', 'letter-spacing':'0.5', fill:'rgba(255,255,255,0.7)'});
    rl.textContent = hex.type.toUpperCase(); svg.appendChild(rl);
  }

  for (const port of data.ports) {
    const col = PORT_COLORS[port.type]??'#aaa';
    const f = portFace(port.q, port.r, port.seaDir, size, ox, oy);
    svg.appendChild(el('line', {x1:f.c1[0],y1:f.c1[1],x2:f.c2[0],y2:f.c2[1],stroke:col,'stroke-width':'5','stroke-linecap':'round'}));
    const lx = f.cx + f.nx*(size*0.87 + size*0.38), ly = f.cy + f.ny*(size*0.87 + size*0.38);
    const bgW = port.type==='any'?28:52;
    svg.appendChild(el('rect', {x:lx-bgW/2,y:ly-9,width:bgW,height:16,rx:4,fill:col,opacity:'0.92'}));
    const lt = el('text', {x:lx,y:ly+4,'text-anchor':'middle','font-size':'9','font-weight':'bold','font-family':'Georgia,serif',fill:'#fff'});
    lt.textContent = port.type==='any'?'3:1':\`2:1 \${port.type[0].toUpperCase()}\`; svg.appendChild(lt);
    svg.appendChild(el('line', {x1:(f.c1[0]+f.c2[0])/2,y1:(f.c1[1]+f.c2[1])/2,x2:lx,y2:ly,stroke:col,'stroke-width':'1.5','stroke-dasharray':'3,2',opacity:'0.6'}));
  }

  document.getElementById('seed-label').textContent = \`SEED: \${data.seed}\`;
  renderInfo(data);
}

function renderInfo(data) {
  const row = document.getElementById('info-row');
  const totals = {wood:0,wheat:0,sheep:0,brick:0,ore:0};
  for (const h of data.hexes) { if (h.type!=='desert') totals[h.type]=(totals[h.type]??0)+(PIPS[h.number]??0); }
  const maxP = Math.max(...Object.values(totals));

  const resCard = document.createElement('div'); resCard.className='info-card';
  resCard.innerHTML='<h3>Production</h3>';
  for (const [res,pips] of Object.entries(totals).sort(([,a],[,b])=>b-a)) {
    const bw = Math.round((pips/maxP)*60);
    const r = document.createElement('div'); r.className='legend-row';
    r.innerHTML = \`<div class="legend-swatch" style="background:\${COLORS[res]}"></div><span style="width:40px">\${res}</span><span class="pip-bar" style="width:\${bw}px"></span><span style="color:#9ab8d8;margin-left:3px">\${pips}</span>\`;
    resCard.appendChild(r);
  }
  row.appendChild(resCard);

  const numCounts={};
  for (const h of data.hexes) { if (h.number) numCounts[h.number]=(numCounts[h.number]??0)+1; }
  const numCard = document.createElement('div'); numCard.className='info-card';
  numCard.innerHTML='<h3>Numbers</h3>';
  for (const [num,count] of Object.entries(numCounts).sort(([a],[b])=>+a-+b)) {
    const isRed=num==='6'||num==='8', dots='✦'.repeat(PIPS[+num]??0);
    const r=document.createElement('div'); r.className='legend-row';
    r.innerHTML=\`<span style="width:22px;text-align:right;font-weight:bold;color:\${isRed?'#e05':'#7af'}">\${num}</span><span style="color:#f5d78e;width:40px;font-size:0.85em">\${dots}</span><span style="color:#9ab8d8">×\${count}</span>\`;
    numCard.appendChild(r);
  }
  row.appendChild(numCard);

  const portCard = document.createElement('div'); portCard.className='info-card';
  portCard.innerHTML='<h3>Ports</h3>';
  for (const port of data.ports) {
    const r=document.createElement('div'); r.className='port-row';
    r.innerHTML=\`<div class="port-dot" style="background:\${PORT_COLORS[port.type]}"></div><span>\${PORT_LABELS[port.type]??port.type}</span>\`;
    portCard.appendChild(r);
  }
  row.appendChild(portCard);
}

render();
</script>
</body>
</html>`;
}
