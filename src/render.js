// Оформление сообщений и надёжная отправка медиа.
import { InputFile } from 'grammy';
import { escapeHtml } from './html.js';

const CAPTION_LIMIT = 1024;
const TEXT_LIMIT = 4096;

// Моноширинный блок — у него в Telegram есть кнопка «копировать».
export function pre(text) {
  return `<pre>${escapeHtml(text)}</pre>`;
}

export function clip(text, limit) {
  const s = String(text);
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
}

/**
 * Промпт должен быть под картинками и копироваться целиком. В подпись он влезает
 * не всегда (1024 символа), поэтому длинный уезжает отдельным сообщением.
 * @returns {{caption:string, overflow:string|null}}
 */
export function captionPlan(prompt, header = '') {
  const body = pre(prompt);
  const full = header ? `${header}\n${body}` : body;
  if (full.length <= CAPTION_LIMIT) return { caption: full, overflow: null };
  return {
    caption: header || undefined,
    overflow: clip(body, TEXT_LIMIT),
  };
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
