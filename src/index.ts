import * as dotenv from 'dotenv';
import { GameConfig } from './types';
import { runGame } from './simulator';

dotenv.config();

// ─── Default game configuration ───────────────────────────────────────────────
// Edit this to swap in different models, add/remove players, change seed, etc.

const config: GameConfig = {
  players: [
    {
      id: 'p1',
      name: 'GPT-4o',
      model: 'gpt-4o',
      color: 'red',
    },
    {
      id: 'p2',
      name: 'Gemini',
      model: 'gemini-2.0-flash',
      color: 'blue',
    },
    {
      id: 'p3',
      name: 'Grok',
      model: 'grok-3',
      color: 'green',
    },
    {
      id: 'p4',
      name: 'DeepSeek',
      model: 'deepseek-chat',
      color: 'orange',
    },
  ],
  seed: 2270014,    // set to undefined for random board each game
  maxTurns: 200,    // safety limit
  outputDir: './outputs',
  verboseLog: true,
};

// Allow overriding player count via CLI: `npm run dev -- 2` for a 2-player game
const args = process.argv.slice(2);
if (args[0]) {
  const n = parseInt(args[0]);
  if (!isNaN(n) && n >= 2 && n <= 4) {
    config.players = config.players.slice(0, n);
    console.log(`Running with ${n} players`);
  }
}

runGame(config)
  .then(result => {
    console.log('\n=== FINAL RESULTS ===');
    console.log('Winner:', result.winner ?? 'None (turn limit)');
    console.log('Total turns:', result.turns);
    console.log('Final scores:', result.finalScores);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
