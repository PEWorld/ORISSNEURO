// Оформление сообщений и надёжная отправка медиа.
import { InputFile } from 'grammy';
import { escapeHtml } from './html.js';

const CAPTION_LIMIT = 1024;
const TEXT_LIMIT = 4096;

// Единый вид подписи под результатом: заголовок, «Ваш промпт:», сам промпт.
export const PROMPT_LABEL = '<b>Ваш промпт:</b>';
export const WAITING_HEADER = `⏳ <b>Ваша генерация в процессе</b>\n\n${PROMPT_LABEL}`;

// Моноширинный блок — у него в Telegram есть кнопка «копировать».
export function pre(text) {
  return `<pre>${escapeHtml(text)}</pre>`;
}

export function clip(text, limit) {
  const s = String(text);
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}

/**
 * Промпт должен быть под картинкой и копироваться целиком. В подпись он влезает
 * не всегда (1024 символа), поэтому длинный ужимается в подписи, а целиком
 * уезжает отдельным сообщением.
 * @returns {{caption:string, overflow:string|null}}
 */
export function captionPlan(prompt, header = '') {
  const build = (p) => (header ? `${header}\n` : '') + pre(p);
  const full = build(prompt);
  if (full.length <= CAPTION_LIMIT) return { caption: full, overflow: null };

  // Экранирование меняет длину непредсказуемо (& → &amp;), поэтому подбираем.
  let len = prompt.length;
  let caption = full;
  while (len > 40 && caption.length > CAPTION_LIMIT) {
    len = Math.floor(len * 0.8);
    caption = build(clip(prompt, len));
  }
  return { caption, overflow: clip(pre(prompt), TEXT_LIMIT) };
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`не скачалось: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function nameFor(url, fallback) {
  try {
    const base = new URL(url).pathname.split('/').pop();
    return base && /\.[a-z0-9]{2,4}$/i.test(base) ? base : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Отправляет набор файлов одним сообщением, если он один, и альбомом, если их
 * несколько. Разница принципиальная: к одиночному медиа Telegram разрешает и
 * подпись, и инлайн-кнопки, а к альбому — только подпись.
 * @param items [{ url, type: 'photo'|'document', caption? }]
 * @param extra доп. поля (например reply_markup) — доедут только при одном файле
 */
export async function sendMediaSetSmart(api, chatId, items, extra = {}) {
  if (items.length === 1) {
    const it = items[0];
    return sendMediaSmart(api, chatId, it.type, it.url, {
      ...(it.caption ? { caption: it.caption, parse_mode: 'HTML' } : {}),
      ...extra,
    });
  }
  return sendAlbumSmart(api, chatId, items);
}

/**
 * Отправляет альбом. Сначала пробует отдать Telegram ссылки — так быстрее и не
 * тратит трафик. Если Telegram не смог их забрать (размер, таймаут, CDN),
 * качаем сами и грузим файлами.
 * @param items [{ url, type: 'photo'|'document', caption?, parse_mode? }]
 */
export async function sendAlbumSmart(api, chatId, items, extra = {}) {
  const byUrl = items.map((it) => ({
    type: it.type,
    media: it.url,
    ...(it.caption ? { caption: it.caption, parse_mode: 'HTML' } : {}),
  }));
  try {
    return await api.sendMediaGroup(chatId, byUrl, extra);
  } catch (err) {
    const buffers = await Promise.all(items.map((it) => download(it.url)));
    const byFile = items.map((it, i) => ({
      type: it.type,
      media: new InputFile(
        buffers[i],
        nameFor(it.url, it.type === 'document' ? `frame-${i + 1}.png` : `photo-${i + 1}.png`)
      ),
      ...(it.caption ? { caption: it.caption, parse_mode: 'HTML' } : {}),
    }));
    return api.sendMediaGroup(chatId, byFile, extra);
  }
}

/**
 * Отправляет сообщение о ходе работы картинкой-заглушкой, чтобы результат потом
 * встал на её место. Если отправить картинку не вышло — не молчим, а откатываемся
 * на обычный текст: доставка тогда просто придёт отдельным сообщением.
 * @returns {{messageId:number, isMedia:boolean}}
 */
export async function sendWaiting(ctx, caption, { media, cached }, remember) {
  try {
    const msg = await ctx.replyWithPhoto(media, { caption, parse_mode: 'HTML' });
    if (!cached) await remember(msg).catch(() => {});
    return { messageId: msg.message_id, isMedia: true };
  } catch (err) {
    console.error('[render] заглушка не отправилась:', err?.description ?? err?.message ?? err);
    const msg = await ctx.reply(caption, { parse_mode: 'HTML' });
    return { messageId: msg.message_id, isMedia: false };
  }
}

/**
 * Подменяет медиа прямо в существующем сообщении — так результат остаётся на
 * месте «в процессе», а не уезжает вниз чата. Работает только если сообщение
 * уже было медиа: текст в картинку Telegram превратить не даст.
 */
export async function editMediaSmart(api, chatId, messageId, kind, url, opts = {}) {
  const { caption, reply_markup } = opts;
  const base = { type: kind, ...(caption ? { caption, parse_mode: 'HTML' } : {}) };
  const extra = reply_markup ? { reply_markup } : {};
  try {
    return await api.editMessageMedia(chatId, messageId, { ...base, media: url }, extra);
  } catch {
    const buf = await download(url);
    const file = new InputFile(buf, nameFor(url, kind === 'video' ? 'out.mp4' : 'out.png'));
    return api.editMessageMedia(chatId, messageId, { ...base, media: file }, extra);
  }
}

// То же самое для одиночного медиа.
export async function sendMediaSmart(api, chatId, kind, url, options = {}) {
  const method = kind === 'video' ? 'sendVideo' : kind === 'document' ? 'sendDocument' : 'sendPhoto';
  try {
    return await api[method](chatId, url, options);
  } catch {
    const buf = await download(url);
    const file = new InputFile(buf, nameFor(url, kind === 'video' ? 'out.mp4' : 'out.png'));
    return api[method](chatId, file, options);
  }
}
