// Хранилище состояния. Три бэкенда, выбирается сам по окружению:
//   Upstash Redis (REST)  — если заданы UPSTASH_REDIS_REST_URL/TOKEN (нужно на Vercel)
//   файл data/state.json  — локальный запуск
//   память                — фолбэк, переживает только один процесс
import fs from 'node:fs';
import path from 'node:path';

const UP_URL = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UP_TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const isServerless = () => !!process.env.VERCEL;

const mem = new Map();

async function upstash(cmd) {
  const res = await fetch(UP_URL(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UP_TOKEN()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`Upstash: ${json.error}`);
  return json.result;
}

const FILE = path.join(process.cwd(), 'data', 'state.json');
let fileCache = null;

function readFile() {
  if (fileCache) return fileCache;
  try {
    fileCache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    fileCache = {};
  }
  return fileCache;
}

function writeFile() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(fileCache, null, 2));
}

export const backend = () => (UP_TOKEN() ? 'upstash' : isServerless() ? 'memory' : 'file');

export async function get(key) {
  switch (backend()) {
    case 'upstash': {
      const raw = await upstash(['GET', key]);
      return raw ? JSON.parse(raw) : null;
    }
    case 'file':
      return readFile()[key] ?? null;
    default:
      return mem.get(key) ?? null;
  }
}

export async function set(key, value, ttlSeconds) {
  switch (backend()) {
    case 'upstash': {
      const cmd = ['SET', key, JSON.stringify(value)];
      if (ttlSeconds) cmd.push('EX', String(ttlSeconds));
      await upstash(cmd);
      return;
    }
    case 'file':
      readFile()[key] = value;
      writeFile();
      return;
    default:
      mem.set(key, value);
  }
}

export async function del(key) {
  switch (backend()) {
    case 'upstash':
      await upstash(['DEL', key]);
      return;
    case 'file':
      delete readFile()[key];
      writeFile();
      return;
    default:
      mem.delete(key);
  }
}

// Множество незавершённых задач — страховка на случай, если callback от KIE не дойдёт.
const PENDING = 'pending:tasks';

export async function addPending(taskId, meta) {
  if (backend() === 'memory') return;
  const all = (await get(PENDING)) || {};
  all[taskId] = { ...meta, at: Date.now() };
  await set(PENDING, all);
}

export async function removePending(taskId) {
  if (backend() === 'memory') return;
  const all = (await get(PENDING)) || {};
  if (!(taskId in all)) return false;
  delete all[taskId];
  await set(PENDING, all);
  return true;
}

export async function listPending() {
  if (backend() === 'memory') return {};
  return (await get(PENDING)) || {};
}
