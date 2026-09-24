// Отправка результата задачи в чат + подпись/проверка callback-ссылок для KIE.
import crypto from 'node:crypto';
import { getTask, resultUrls } from './kie.js';
import * as store from './storage.js';
import { escapeHtml } from './html.js';
import { captionPlan, sendMediaSmart, editMediaSmart, PROMPT_LABEL } from './render.js';
import { onFrameTaskDone } from './frames.js';

export { escapeHtml };

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

// Всё нужное для доставки едет внутри самой ссылки — серверлесу не нужна БД для задач.
// Промпт туда не кладём: он бывает на тысячи символов, для него отдельная запись.
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

// Промпт нужен при доставке, чтобы подписать им результат. Живёт сутки.
const kJob = (taskId) => `job:${taskId}`;

export async function rememberJob(taskId, data) {
  await store.set(kJob(taskId), data, 60 * 60 * 24);
}

export async function recallJob(taskId) {
  return store.get(kJob(taskId));
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
 * @param api   grammy bot.api
 * @param meta  { c: chatId, m: messageId|null, k: 'photo'|'document'|'video', l: label, f?: frameId, i?: index }
 */
export async function deliver(api, meta, taskId, data) {
  if (!(await claim(taskId))) return;
  const info = data ?? (await getTask(taskId));

  // Кадр креатора собирается отдельно: результат показывается, только когда
  // добежали обе генерации.
  if (meta.f) {
    await store.removePending(taskId);
    return onFrameTaskDone(api, meta, taskId, info);
  }

  const chatId = meta.c;
  const label = meta.l || 'Задача';
  const job = await recallJob(taskId);
  const prompt = job?.prompt;

  // Сообщение о ходе работы — картинка-заглушка, поэтому правим подпись.
  const editOrSend = async (text) => {
    if (meta.m) {
      try {
        await api.editMessageCaption(chatId, meta.m, { caption: text, parse_mode: 'HTML' });
        return;
      } catch { /* сообщение могло уехать или быть текстом — отправим новое */ }
      await api.deleteMessage(chatId, meta.m).catch(() => {});
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

  // Результат подписан своим промптом — так при нескольких параллельных
  // генерациях видно, что к чему относится.
  const stats = human(info);
  const header = `${label}${stats ? ` · ${stats}` : ''}`;
  const { caption, overflow } = prompt
    ? captionPlan(prompt, `${header}\n\n${PROMPT_LABEL}`)
    : { caption: header, overflow: null };

  // Один файл подменяем прямо в сообщении о ходе работы — оно остаётся на месте.
  if (urls.length === 1 && meta.m) {
    try {
      await editMediaSmart(api, chatId, meta.m, meta.k, urls[0], { caption });
      if (overflow) await api.sendMessage(chatId, overflow, { parse_mode: 'HTML' }).catch(() => {});
      await store.removePending(taskId);
      return;
    } catch {
      // Не вышло подменить — отправим обычным сообщением ниже.
    }
  }

  if (meta.m) await api.deleteMessage(chatId, meta.m).catch(() => {});

  for (const [i, url] of urls.entries()) {
    const cap = i === 0 ? caption : undefined;
    try {
      await sendMediaSmart(api, chatId, meta.k, url, {
        ...(cap ? { caption: cap, parse_mode: 'HTML' } : {}),
        ...(meta.k === 'video' ? { supports_streaming: true } : {}),
      });
    } catch {
      await api.sendMessage(chatId, `${header}\n${url}`).catch(() => {});
    }
  }
  if (overflow) await api.sendMessage(chatId, overflow, { parse_mode: 'HTML' }).catch(() => {});

  await store.removePending(taskId);
}
