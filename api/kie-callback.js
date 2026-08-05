// KIE дёргает этот адрес, когда задача завершилась. Всё, что нужно для доставки
// (чат, сообщение, тип результата), зашито в подписанной ссылке — базы не требуется.
import { Bot } from 'grammy';
import { parseCallbackMeta, deliver } from '../src/deliver.js';
import { query, body as readBody, json } from '../src/http.js';

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
let inited = false;

// taskId в колбэке лежит по-разному в зависимости от модели — забираем откуда получится.
function pickTaskId(b) {
  const cand = [b?.data?.taskId, b?.taskId, b?.data?.task_id, b?.task_id, b?.data?.id];
  return cand.find((v) => typeof v === 'string' && v);
}

export default async function handler(req, res) {
  try {
    const { d, s } = query(req);
    const meta = parseCallbackMeta(d, s); // невалидная подпись — сразу в catch

    const payload = await readBody(req);
    const taskId = pickTaskId(payload);
    if (!taskId) {
      console.error('[kie-callback] нет taskId в теле:', JSON.stringify(payload).slice(0, 500));
      json(res, 200, { ok: true, note: 'no taskId' });
      return;
    }

    if (!inited) {
      await bot.init();
      inited = true;
    }
    // Состояние берём из recordInfo, а не из тела колбэка: его формат не задокументирован.
    await deliver(bot.api, meta, taskId, undefined);
    json(res, 200, { ok: true });
  } catch (err) {
    console.error('[kie-callback]', err);
    json(res, 200, { ok: false, error: String(err?.message || err) });
  }
}
