/**
 * Ping all configured AI APIs and report which have working credits.
 * Run with: npx ts-node test-apis.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const PING_PROMPT = 'You are playing Catan. You have wood:2 brick:1 wheat:0 sheep:2 ore:1. Should you build a road or save for a settlement? Answer in one sentence.';

interface ApiResult {
  provider: string;
  model: string;
  status: 'ok' | 'no_key' | 'error';
  response?: string;
  error?: string;
  ms?: number;
}

async function pingAnthropic(): Promise<ApiResult[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [{ provider: 'Anthropic', model: 'claude-sonnet-4-6', status: 'no_key' }];

  const client = new Anthropic({ apiKey: key });
  const models = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
  const results: ApiResult[] = [];

  for (const model of models) {
    const t = Date.now();
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 100,
        messages: [{ role: 'user', content: PING_PROMPT }],
      });
      const text = res.content[0].type === 'text' ? res.content[0].text : '?';
      results.push({ provider: 'Anthropic', model, status: 'ok', response: text.trim(), ms: Date.now() - t });
    } catch (err: unknown) {
      results.push({ provider: 'Anthropic', model, status: 'error', error: (err as Error).message, ms: Date.now() - t });
    }
  }
  return results;
}

async function pingOpenAI(): Promise<ApiResult[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return [{ provider: 'OpenAI', model: 'gpt-4o', status: 'no_key' }];

  const client = new OpenAI({ apiKey: key });
  const models = ['gpt-4o-mini', 'gpt-4o', 'o4-mini'];
  const results: ApiResult[] = [];

  for (const model of models) {
    const t = Date.now();
    try {
      const isO = model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4');
      const res = await client.chat.completions.create({
        model,
        ...(isO ? { max_completion_tokens: 100 } : { max_tokens: 100 }),
        messages: [{ role: 'user', content: PING_PROMPT }],
      });
      const text = res.choices[0]?.message?.content ?? '?';
      results.push({ provider: 'OpenAI', model, status: 'ok', response: text.trim(), ms: Date.now() - t });
    } catch (err: unknown) {
      results.push({ provider: 'OpenAI', model, status: 'error', error: (err as Error).message, ms: Date.now() - t });
    }
  }
  return results;
}

async function pingGemini(): Promise<ApiResult[]> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return [{ provider: 'Google', model: 'gemini-1.5-pro', status: 'no_key' }];

  const client = new GoogleGenerativeAI(key);
  const models = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash', 'gemini-2.5-flash-preview-04-17'];
  const results: ApiResult[] = [];

  for (const model of models) {
    const t = Date.now();
    try {
      const genModel = client.getGenerativeModel({ model });
      const res = await genModel.generateContent(PING_PROMPT);
      const text = res.response.text();
      results.push({ provider: 'Google', model, status: 'ok', response: text.trim(), ms: Date.now() - t });
    } catch (err: unknown) {
      results.push({ provider: 'Google', model, status: 'error', error: (err as Error).message, ms: Date.now() - t });
    }
  }
  return results;
}

async function pingXAI(): Promise<ApiResult[]> {
  const key = process.env.XAI_API_KEY;
  if (!key) return [{ provider: 'xAI', model: 'grok-3', status: 'no_key' }];

  const client = new OpenAI({ apiKey: key, baseURL: 'https://api.x.ai/v1' });
  const models = ['grok-3-mini', 'grok-3'];
  const results: ApiResult[] = [];

  for (const model of models) {
    const t = Date.now();
    try {
      const res = await client.chat.completions.create({
        model,
        max_tokens: 100,
        messages: [{ role: 'user', content: PING_PROMPT }],
      });
      const text = res.choices[0]?.message?.content ?? '?';
      results.push({ provider: 'xAI', model, status: 'ok', response: text.trim(), ms: Date.now() - t });
    } catch (err: unknown) {
      results.push({ provider: 'xAI', model, status: 'error', error: (err as Error).message, ms: Date.now() - t });
    }
  }
  return results;
}

async function pingDeepSeek(): Promise<ApiResult[]> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return [{ provider: 'DeepSeek', model: 'deepseek-chat', status: 'no_key' }];

  const client = new OpenAI({ apiKey: key, baseURL: 'https://api.deepseek.com/v1' });
  const models = ['deepseek-chat', 'deepseek-reasoner'];
  const results: ApiResult[] = [];

  for (const model of models) {
    const t = Date.now();
    try {
      const res = await client.chat.completions.create({
        model,
        max_tokens: 100,
        messages: [{ role: 'user', content: PING_PROMPT }],
      });
      const msg = res.choices[0]?.message as unknown as Record<string, unknown>;
      const text = String(msg?.content ?? msg?.reasoning_content ?? '?');
      results.push({ provider: 'DeepSeek', model, status: 'ok', response: text.trim(), ms: Date.now() - t });
    } catch (err: unknown) {
      results.push({ provider: 'DeepSeek', model, status: 'error', error: (err as Error).message, ms: Date.now() - t });
    }
  }
  return results;
}

async function pingFireworks(): Promise<ApiResult[]> {
  const key = process.env.FIREWORKS_API_KEY;
  if (!key) return [{ provider: 'Fireworks', model: 'deepseek-v3', status: 'no_key' }];

  const client = new OpenAI({ apiKey: key, baseURL: 'https://api.fireworks.ai/inference/v1' });
  const models = [
    'accounts/fireworks/models/llama-v3p3-70b-instruct',
    'accounts/fireworks/models/deepseek-v3',
  ];
  const results: ApiResult[] = [];

  for (const model of models) {
    const t = Date.now();
    try {
      const res = await client.chat.completions.create({
        model,
        max_tokens: 100,
        messages: [{ role: 'user', content: PING_PROMPT }],
      });
      const text = res.choices[0]?.message?.content ?? '?';
      results.push({ provider: 'Fireworks', model: model.split('/').pop()!, status: 'ok', response: text.trim(), ms: Date.now() - t });
    } catch (err: unknown) {
      results.push({ provider: 'Fireworks', model: model.split('/').pop()!, status: 'error', error: (err as Error).message, ms: Date.now() - t });
    }
  }
  return results;
}

function printResult(r: ApiResult): void {
  const icon = r.status === 'ok' ? '✅' : r.status === 'no_key' ? '🔑' : '❌';
  const detail = r.status === 'ok'
    ? `"${r.response}"  (${r.ms}ms)`
    : r.status === 'no_key'
    ? 'no API key in .env'
    : `${r.error?.slice(0, 100)}  (${r.ms}ms)`;
  console.log(`  ${icon} ${r.provider.padEnd(10)} ${r.model.padEnd(40)} ${detail}`);
}

async function main(): Promise<void> {
  console.log('\n=== API PING TEST ===');
  console.log('Pinging all providers in parallel...\n');

  const [anthropic, openai, gemini, xai, fireworks, deepseek] = await Promise.all([
    pingAnthropic(),
    pingOpenAI(),
    pingGemini(),
    pingXAI(),
    pingFireworks(),
    pingDeepSeek(),
  ]);

  const all = [...anthropic, ...openai, ...gemini, ...xai, ...fireworks, ...deepseek];

  const working   = all.filter(r => r.status === 'ok');
  const noKey     = all.filter(r => r.status === 'no_key');
  const errored   = all.filter(r => r.status === 'error');

  if (working.length) {
    console.log('WORKING:');
    working.forEach(printResult);
  }
  if (errored.length) {
    console.log('\nERRORS:');
    errored.forEach(printResult);
  }
  if (noKey.length) {
    console.log('\nMISSING KEYS (add to .env):');
    noKey.forEach(printResult);
  }

  console.log(`\nSummary: ${working.length} working, ${errored.length} errored, ${noKey.length} missing keys`);
  console.log('\nAdd keys to .env — see .env.example for format.\n');
}

main().catch(console.error);
