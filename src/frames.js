// Кадр креатора: один промпт → две параллельные генерации → один готовый блок
// с кнопкой «Отправить на согласование».
//
// Кадров может быть сколько угодно одновременно, поэтому состояние лежит по
// ключам, а не в сессии, и последнюю добежавшую генерацию определяет атомарный
// счётчик — иначе два колбэка, пришедшие одновременно, отрисовали бы кадр дважды.
import { InlineKeyboard } from 'grammy';
import * as store from './storage.js';
import { resultUrls } from './kie.js';
import { pre, captionPlan, clip, sendMediaSetSmart } from './render.js';
import { escapeHtml } from './html.js';
import { approvalChatId } from './roles.js';

const TTL = 60 * 60 * 24 * 7; // кнопка должна работать и через несколько дней

const kFrame = (fid) => `frame:${fid}`;
const kCount = (fid) => `fcnt:${fid}`;
const kRes = (fid, i) => `fres:${fid}:${i}`;

export function newFrameId() {
  return Math.random().toString(36).slice(2, 10);
}

export async function saveFrame(fid, data) {
  await store.set(kFrame(fid), data, TTL);
}

export async function loadFrame(fid) {
  return store.get(kFrame(fid));
}

/**
 * Вызывается на каждую завершённую генерацию кадра.
 * Отрисовывает кадр только тогда, когда добежали все.
 */
export async function onFrameTaskDone(api, meta, taskId, info) {
  const { f: fid, i: index } = meta;
  const urls = info.state === 'success' ? resultUrls(info) : [];
  await store.set(kRes(fid, index), urls[0] || '', TTL);

  const frame = await loadFrame(fid);
  if (!frame) return; // кадр протух или уже разобран

  const done = await store.incr(kCount(fid), TTL);
  if (done < frame.count) return;

  await renderFrame(api, fid);
}

async function collectUrls(fid, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push((await store.get(kRes(fid, i))) || '');
  return out;
}

async function renderFrame(api, fid) {
  const frame = await loadFrame(fid);
  if (!frame || frame.rendered) return;

  const urls = (await collectUrls(fid, frame.count)).filter(Boolean);
  const failed = frame.count - urls.length;

  // Сообщение «в процессе» больше не нужно — результат приходит цельным блоком.
  await api.deleteMessage(frame.chatId, frame.anchorMsgId).catch(() => {});

  if (!urls.length) {
    await api.sendMessage(
      frame.chatId,
      `❌ Кадр не получился, обе генерации упали.\n\n${pre(frame.prompt)}`,
      { parse_mode: 'HTML' }
    );
    await store.del(kFrame(fid));
    return;
  }

  const note = failed ? `⚠️ Из ${frame.count} генераций получилось ${urls.length}.` : '';
  const { caption, overflow } = captionPlan(frame.prompt, note);
  const keyboard = new InlineKeyboard().text('📤 Отправить на согласование', `apv|${fid}`);

  // Одна картинка укладывается в одно сообщение вместе с промптом и кнопкой.
  // Двум и больше Telegram кнопку прицепить не даст — тогда она едет отдельно.
  await sendMediaSetSmart(
    api,
    frame.chatId,
    urls.map((url, i) => ({ type: 'photo', url, ...(i === 0 && caption ? { caption } : {}) })),
    urls.length === 1 ? { reply_markup: keyboard } : {}
  );
  if (overflow) {
    await api.sendMessage(frame.chatId, overflow, { parse_mode: 'HTML' });
  }
  if (urls.length > 1) {
    await api.sendMessage(frame.chatId, '✅ Кадр готов', { reply_markup: keyboard });
  }

  await saveFrame(fid, { ...frame, rendered: true, urls });
}

/** Отправляет кадр владельцу файлами без сжатия. */
export async function sendForApproval(api, fid, note, from) {
  const frame = await loadFrame(fid);
  if (!frame) throw new Error('Этот кадр уже не найти — сгенерируй заново.');
  const urls = frame.urls?.length ? frame.urls : (await collectUrls(fid, frame.count)).filter(Boolean);
  if (!urls.length) throw new Error('У этого кадра нет картинок.');

  const chatId = approvalChatId();
  if (!chatId) throw new Error('Не задан адресат согласования (OWNER_CHAT_ID).');

  const who = from.username ? `@${from.username}` : from.first_name || String(from.id);
  const header =
    `📤 <b>Кадр на согласование</b>\n` +
    `От: ${escapeHtml(who)}\n` +
    `Подпись: ${escapeHtml(clip(note, 300))}`;

  const { caption, overflow } = captionPlan(frame.prompt, header);

  // Документами — чтобы Telegram не пережал картинки.
  await sendMediaSetSmart(
    api,
    chatId,
    urls.map((url, i) => ({ type: 'document', url, ...(i === 0 && caption ? { caption } : {}) }))
  );
  if (overflow) await api.sendMessage(chatId, overflow, { parse_mode: 'HTML' });

  return urls.length;
}
