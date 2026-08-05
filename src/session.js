// Состояние пользователя: активная модель, её параметры, приложенные файлы.
import * as store from './storage.js';
import { MODELS, defaultParams } from './models.js';

const KEY = (userId) => `u:${userId}`;

export function emptySession() {
  const params = {};
  const attachments = {};
  for (const k of Object.keys(MODELS)) {
    params[k] = defaultParams(k);
    attachments[k] = [];
  }
  return {
    active: 'image',
    params,
    attachments,
    awaiting: null,
    modelOverride: null,
    confirm: true,
    // Окон подтверждения может быть открыто несколько сразу — держим их все,
    // иначе кнопка на любом, кроме последнего, переставала бы работать.
    pendingJobs: {},
    pendingFrames: {},
  };
}

export async function load(userId) {
  const raw = await store.get(KEY(userId));
  const base = emptySession();
  if (!raw) return base;
  // Мягкое слияние: новые параметры схемы подхватываются у старых сессий.
  return {
    ...base,
    ...raw,
    params: Object.fromEntries(
      Object.keys(MODELS).map((k) => [k, { ...base.params[k], ...(raw.params?.[k] || {}) }])
    ),
    attachments: Object.fromEntries(
      Object.keys(MODELS).map((k) => [k, raw.attachments?.[k] || []])
    ),
    pendingJobs: raw.pendingJobs || {},
    pendingFrames: raw.pendingFrames || {},
  };
}

export async function save(userId, session) {
  await store.set(KEY(userId), session);
}

const PENDING_LIMIT = 20;

/** Добавляет запись, не давая словарю расти бесконечно. */
export function remember(map, id, value) {
  const next = { ...(map || {}), [id]: value };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - PENDING_LIMIT))) delete next[k];
  return next;
}

export async function update(userId, fn) {
  const s = await load(userId);
  const next = (await fn(s)) || s;
  await save(userId, next);
  return next;
}
