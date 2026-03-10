import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const SEED = process.argv[2] ?? '15286652';
const stateFiles = fs.readdirSync(`games/${SEED}`)
  .filter(f => f.match(/^state-after-turn-\d+\.json$/))
  .sort((a, b) => {
    const na = parseInt(a.match(/(\d+)/)![1]);
    const nb = parseInt(b.match(/(\d+)/)![1]);
    return nb - na;
  });

if (stateFiles.length === 0) { console.error('No state files found'); process.exit(1); }

const latestFile = stateFiles[0];
const turnNum = parseInt(latestFile.match(/(\d+)/)![1]);
console.log(`Reflecting on game ${SEED} after turn ${turnNum}...`);

const raw = JSON.parse(fs.readFileSync(`games/${SEED}/${latestFile}`, 'utf-8'));

// Deserialize maps from JSON arrays
const vertices = new Map(raw.vertices as [string, any][]);
const edges = new Map(raw.edges as [string, any][]);
const hexes = new Map(raw.hexes as [string, any][]);
const players: any[] = raw.players;

function calculateVP(playerId: string): number {
  let vp = 0;
  for (const v of vertices.values() as any) {
    if (v.building?.playerId === playerId) vp += v.building.type === 'city' ? 2 : 1;
  }
  const p = players.find(p => p.id === playerId)!;
  if (p.hasLongestRoad) vp += 2;
  if (p.hasLargestArmy) vp += 2;
  vp += p.devCards.filter((c: string) => c === 'victory_point').length;
  return vp;
}

function buildingsOnBoard(playerId: string) {
  let settlements = 0, cities = 0, roads = 0;
  for (const v of vertices.values() as any) {
    if (v.building?.playerId === playerId) {
      if (v.building.type === 'city') cities++; else settlements++;
    }
  }
  for (const e of edges.values() as any) {
    if (e.road === playerId) roads++;
  }
  return { settlements, cities, roads };
}

function fmtResources(r: Record<string, number>): string {
  return Object.entries(r).filter(([,v]) => v > 0).map(([k,v]) => `${v} ${k}`).join(', ') || 'none';
}

function buildContext(playerId: string): string {
  const me = players.find(p => p.id === playerId)!;
  const myVP = calculateVP(playerId);
  const { settlements, cities, roads } = buildingsOnBoard(playerId);
  const others = players.filter(p => p.id !== playerId);

  const standingsTable = [...players]
    .map(p => {
      const vp = calculateVP(p.id);
      const b = buildingsOnBoard(p.id);
      const specials = [
        p.hasLongestRoad ? 'Longest Road (+2 VP)' : '',
        p.hasLargestArmy ? `Largest Army x${p.knightsPlayed} (+2 VP)` : '',
      ].filter(Boolean).join(', ');
      return `  ${p.name} (${p.model}): ${vp} VP — ${b.settlements} settlements, ${b.cities} cities, ${b.roads} roads${specials ? ' | '+specials : ''}`;
    })
    .sort((a, b) => {
      const va = parseInt(a.match(/(\d+) VP/)![1]);
      const vb = parseInt(b.match(/(\d+) VP/)![1]);
      return vb - va;
    })
    .join('\n');

  const myNotes = [
    `You are ${me.name} (${me.model}).`,
    `Current VP: ${myVP}/10 (need ${10 - myVP} more to win).`,
    `On the board: ${settlements} settlements, ${cities} cities, ${roads} roads.`,
    `Pieces remaining: ${me.settlementsLeft} settlements, ${me.citiesLeft} cities, ${me.roadsLeft} roads.`,
    `Resources in hand: ${fmtResources(me.resources)}.`,
    `Dev cards: ${me.devCards.join(', ') || 'none'}.`,
    `Knights played: ${me.knightsPlayed}${me.hasLargestArmy ? ' (YOU HOLD LARGEST ARMY +2 VP)' : ''}.`,
    me.hasLongestRoad ? 'YOU HOLD LONGEST ROAD (+2 VP).' : '',
  ].filter(Boolean).join('\n');

  return `=== POST-GAME REFLECTION | After Turn ${turnNum} ===

CURRENT STANDINGS:
${standingsTable}

YOUR SITUATION:
${myNotes}

GAME CONTEXT:
- 10 VP wins. Game is in progress — nobody has won yet.
- Longest Road (currently ${raw.longestRoadLength} roads) held by: ${players.find(p => p.hasLongestRoad)?.name ?? 'nobody'}.
- Largest Army (${raw.largestArmySize} knights) held by: ${players.find(p => p.hasLargestArmy)?.name ?? 'nobody'}.
- Dev deck has ${raw.devDeck.length} cards remaining.

Write a short strategic reflection (2–4 sentences) as ${me.name}. Explain:
1. Your realistic path to 10 VP — what specific builds, cards, or bonuses you're targeting.
2. Your biggest obstacles and which opponents you need to watch most closely.
3. One concrete action you will prioritize on your very next turn.

Be direct and tactical. No fluff. Write in first person as ${me.name}.`;
}

async function callClaude(prompt: string, model: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return (resp.content[0] as any).text.trim();
}

async function callOpenAI(prompt: string, model: string, baseURL?: string, apiKey?: string): Promise<string> {
  const client = new OpenAI({ apiKey: apiKey ?? process.env.OPENAI_API_KEY, baseURL });
  const resp = await client.chat.completions.create({
    model,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.choices[0].message.content?.trim() ?? '';
}

async function callGemini(prompt: string, model: string): Promise<string> {
  const client = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
  const gm = client.getGenerativeModel({ model });
  const resp = await gm.generateContent(prompt);
  return resp.response.text().trim();
}

async function getReflection(player: any): Promise<string> {
  const prompt = buildContext(player.id);
  const model: string = player.model;
  try {
    if (model.startsWith('claude-')) return await callClaude(prompt, model);
    if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return await callOpenAI(prompt, model);
    if (model.startsWith('gemini-')) return await callGemini(prompt, model);
    if (model.startsWith('grok-')) return await callOpenAI(prompt, model, 'https://api.x.ai/v1', process.env.XAI_API_KEY);
    if (model.startsWith('deepseek-')) return await callOpenAI(prompt, model, 'https://api.deepseek.com', process.env.DEEPSEEK_API_KEY);
    return `[unknown model: ${model}]`;
  } catch (err: any) {
    return `[error: ${err.message}]`;
  }
}

async function main() {
  const outDir = `games/${SEED}/reflections`;
  fs.mkdirSync(outDir, { recursive: true });

  const lines: string[] = [`# AI Reflections — Game ${SEED}, After Turn ${turnNum}`, ''];

  for (const player of players) {
    const vp = calculateVP(player.id);
    console.log(`  Asking ${player.name} (${player.model}) — ${vp} VP...`);
    const reflection = await getReflection(player);
    lines.push(`## ${player.name} — ${vp} VP (${player.model})`);
    lines.push('');
    lines.push(reflection);
    lines.push('');
    console.log(`  ✓ ${player.name} done`);
  }

  const outPath = path.join(outDir, `after-turn-${turnNum}.md`);
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`\nSaved to ${outPath}`);
}

main();
