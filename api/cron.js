// Страховка: добирает задачи, по которым колбэк от KIE не дошёл.
// Работает только с персистентным хранилищем (Upstash / Vercel KV).
import { Bot } from 'grammy';
import { getTask, TERMINAL } from '../src/kie.js';
import { deliver } from '../src/deliver.js';
import * as store from '../src/storage.js';
import { json } from '../src/http.js';

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
let inited = false;

const MAX_AGE_MS = 30 * 60 * 1000;

export default async function handler(req, res) {
  try {
    const pending = await store.listPending();
    const ids = Object.keys(pending);
    if (!ids.length) {
      json(res, 200, { checked: 0, backend: store.backend() });
      return;
    }
    if (!inited) {
      await bot.init();
      inited = true;
    }

    let delivered = 0;
    for (const taskId of ids) {
      const meta = pending[taskId];
      try {
        const data = await getTask(taskId);
        if (TERMINAL.has(data.state)) {
          await deliver(bot.api, meta, taskId, data);
          delivered++;
        } else if (Date.now() - (meta.at ?? 0) > MAX_AGE_MS) {
          await store.removePending(taskId);
        }
      } catch (err) {
        console.error('[cron]', taskId, err.message);
        if (Date.now() - (meta.at ?? 0) > MAX_AGE_MS) await store.removePending(taskId);
      }
    }
    json(res, 200, { checked: ids.length, delivered });
  } catch (err) {
    console.error('[cron]', err);
    json(res, 200, { ok: false, error: String(err?.message || err) });
  }
}
