# AI Catan

A TypeScript engine that plays a full game of **Settlers of Catan** with five different large language models as the players. Each model receives the board state in natural language, reasons about its position, negotiates and trades, and returns its moves. The system runs the setup phase, executes turns round by round, renders the board and the agents' dialogue to HTML, and exports turn-by-turn state that can be animated in Blender.

The default roster:

| Player   | Model               |
| -------- | ------------------- |
| GPT      | `gpt-4o`            |
| Gemini   | `gemini-2.0-flash`  |
| Grok     | `grok-3`            |
| DeepSeek | `deepseek-chat`     |
| Claude   | `claude-sonnet-4-6` |

## How it works

1. **Board generation** (`src/board.ts`, `generate-map.ts`, `save-map.ts`) builds a randomized hex board from a seed, including ports and number tokens, and renders it to a self-contained HTML viewer.
2. **Game state** (`src/gameState.ts`, `src/types.ts`, `src/state-serializer.ts`) tracks resources, buildings, roads, the robber, and the dev-card deck, and serializes the state into a prompt-friendly description.
3. **Rules** (`src/rules.ts`) enforce legal placements, builds, and trades.
4. **Agents** (`src/agents/agent.ts`) wrap each provider's API behind one interface so any model can take a turn from the same serialized prompt.
5. **Simulator** (`src/simulator.ts`) drives the dice, the robber, and resource distribution.
6. **Reflection** (`reflect.ts`) replays a finished game and asks the models to analyze what happened.

Each run is stored under `games/<seed>/`, with per-turn `dialogue.html` and `map.html` files and `state-after-turn-NN.json` snapshots.

## Setup

```bash
npm install
cp .env.example .env   # then fill in your API keys
```

`.env` keys (see `.env.example`):

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=AI...
XAI_API_KEY=xai-...
```

Confirm your keys and credits work before running a game:

```bash
npx ts-node test-apis.ts
```

## Running a game

```bash
# 1. Run the setup phase (settlement + road placement). Omit the seed for a random board.
npx ts-node run-setup.ts [seed]

# 2. Run one full round (every player takes a turn). Repeat to advance the game.
npx ts-node run-turn.ts <seed>

# 3. After the game, generate a reflection/analysis pass.
npx ts-node reflect.ts <seed>
```

Board-only utilities:

```bash
npx ts-node generate-map.ts [seed]   # print a board to the console
npx ts-node save-map.ts [seed]       # save a board to maps/<seed>.html
```

## Blender animation

`blender_anim.py` and `ballanim.py` are run from inside Blender's Text Editor (Alt+R). They read the exported per-turn state and animate each model's resource counts, including audio-driven bobbing for a narrated video.

## Project layout

```
src/                 board, rules, game state, agents, simulator
run-setup.ts         setup phase runner
run-turn.ts          per-round turn runner
reflect.ts           post-game analysis
test-apis.ts         API connectivity / credit check
generate-map.ts      print a board
save-map.ts          export a board to HTML
games/<seed>/        recorded games (state snapshots + HTML)
maps/                exported board viewers
blender_anim.py      Blender turn-by-turn animation
ballanim.py          Blender audio-amplitude animation
comparison.md        analysis of model play across games
resource-log.md      per-turn resource log
```

## License

MIT — see [LICENSE](LICENSE).
