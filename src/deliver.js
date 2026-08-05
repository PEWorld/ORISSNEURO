// Отправка результата задачи в чат + подпись/проверка callback-ссылок для KIE.
import crypto from 'node:crypto';
import { getTask, resultUrls } from './kie.js';
import * as store from './storage.js';

function secret() {
  return process.env.CALLBACK_SECRET || process.env.TELEGRAM_BOT_TOKEN || 'dev-secret';
}

const b64u = {
  enc: (s) => Buffer.from(s, 'utf8').toString('base64url'),
  dec: (s) => Buffer.from(s, 'base64url').toString('utf8'),
};

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

// Публичный адрес, на который KIE постучится с результатом. На Vercel домен
// подставляется сам, поэтому PUBLIC_URL нужен только если домен свой.
export function publicBase() {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const dep = process.env.VERCEL_URL;
  return (
    process.env.PUBLIC_URL || (prod && `https://${prod}`) || (dep && `https://${dep}`) || null
  );
}

// Все данные для доставки едут внутри самой ссылки — серверлесу не нужна БД для задач.
export function callbackUrl(meta) {
  const base = publicBase();
  if (!base) return null;
  const d = b64u.enc(JSON.stringify(meta));
  return `${base.replace(/\/$/, '')}/api/kie-callback?d=${d}&s=${sign(d)}`;
}

export function parseCallbackMeta(d, s) {
  if (!d || !s) throw new Error('нет подписи');
  const expected = sign(d);
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('подпись не сходится');
  return JSON.parse(b64u.dec(d));
}

function human(data) {
  const parts = [];
  if (data?.costTime) parts.push(`${Math.round(data.costTime / 1000)}с`);
  if (data?.creditsConsumed != null) parts.push(`${data.creditsConsumed} кред.`);
  return parts.join(' · ');
}

// Не даём одной задаче отправиться дважды (callback + подстраховка кроном).
async function claim(taskId) {
  const k = `done:${taskId}`;
  if (await store.get(k)) return false;
  await store.set(k, 1, 60 * 60 * 24);
  return true;
}

/**
 * Отправляет результат завершённой задачи в чат.
 * @param api      grammy bot.api
 * @param meta     { c: chatId, m: messageId|null, k: 'photo'|'video', l: label }
 * @param taskId
 * @param data     уже полученный recordInfo, иначе будет запрошен
 */
export async function deliver(api, meta, taskId, data) {
  if (!(await claim(taskId))) return;
  const info = data ?? (await getTask(taskId));
  const chatId = meta.c;
  const label = meta.l || 'Задача';

  const editOrSend = async (text) => {
    if (meta.m) {
      try {
        await api.editMessageText(chatId, meta.m, text, { parse_mode: 'HTML' });
        return;
      } catch { /* сообщение могло уехать — просто отправим новое */ }
    }
    await api.sendMessage(chatId, text, { parse_mode: 'HTML' });
  };

  if (info.state === 'fail') {
    await editOrSend(
      `❌ <b>${label}</b> — не получилось\n<code>${escapeHtml(
        `${info.failCode || ''} ${info.failMsg || 'без подробностей'}`.trim()
      )}</code>\n\n<code>${taskId}</code>`
    );
    await store.removePending(taskId);
    return;
  }

  const urls = resultUrls(info);
  if (!urls.length) {
    await editOrSend(`⚠️ <b>${label}</b> — задача успешна, но KIE не вернул файлов.\n<code>${taskId}</code>`);
    await store.removePending(taskId);
    return;
  }

  const stats = human(info);
  const caption = `${label}${stats ? ` · ${stats}` : ''}`;

  for (const [i, url] of urls.entries()) {
    const cap = urls.length > 1 ? `${caption} (${i + 1}/${urls.length})` : caption;
    try {
      if (meta.k === 'video') {
        await api.sendVideo(chatId, url, { caption: cap, supports_streaming: true });
      } else {
        await api.sendPhoto(chatId, url, { caption: cap });
      }
    } catch {
      // Телеграм не смог забрать файл по ссылке (слишком большой / долгий) — отдаём ссылкой.
      try {
        await api.sendDocument(chatId, url, { caption: cap });
      } catch {
        await api.sendMessage(chatId, `${cap}\n${url}`, { disable_web_page_preview: false });
      }
    }
  }

  await editOrSend(`✅ <b>${label}</b> готово${stats ? ` · ${stats}` : ''}`);
  await store.removePending(taskId);
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
