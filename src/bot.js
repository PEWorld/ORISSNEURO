import { Bot, InlineKeyboard } from 'grammy';
import { MODELS, defaultParams, findParam, coerce, formatValue } from './models.js';
import * as session from './session.js';
import * as store from './storage.js';
import { createTask, getCredits, getTask, waitForTask, uploadBuffer } from './kie.js';
import { callbackUrl, deliver, escapeHtml } from './deliver.js';

const MK = Object.keys(MODELS); // ['image','kling','seedance'] — индексы в callback_data

export function createBot(token) {
  const bot = new Bot(token);

  // ── доступ ──────────────────────────────────────────────────────────────────
  const allowed = (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (allowed.length && (!id || !allowed.includes(String(id)))) {
      if (ctx.chat) await ctx.reply(`Доступа нет. Твой id: ${id}`);
      return;
    }
    await next();
  });

  bot.catch((err) => console.error('[bot]', err?.error ?? err));

  // ── команды ─────────────────────────────────────────────────────────────────
  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  for (const mk of MK) {
    bot.command(mk, async (ctx) => {
      const s = await session.update(ctx.from.id, (s) => {
        s.active = mk;
        s.awaiting = null;
        return s;
      });
      const rest = ctx.match?.trim();
      if (rest) return runGeneration(ctx, rest);
      await ctx.reply(await settingsText(s), {
        parse_mode: 'HTML',
        reply_markup: settingsKeyboard(s),
      });
    });
  }

  bot.command('settings', async (ctx) => {
    const s = await session.load(ctx.from.id);
    await ctx.reply(await settingsText(s), {
      parse_mode: 'HTML',
      reply_markup: settingsKeyboard(s),
    });
  });

  bot.command('set', async (ctx) => {
    const s = await session.load(ctx.from.id);
    const m = (ctx.match || '').trim().match(/^(\S+)\s*([\s\S]*)$/);
    if (!m) {
      return ctx.reply('Формат: <code>/set ключ значение</code>. Например <code>/set resolution 4K</code>', {
        parse_mode: 'HTML',
      });
    }
    const [, key, rawValue] = m;
    const param = findParam(s.active, key);
    if (!param) {
      return ctx.reply(
        `У ${MODELS[s.active].label} нет параметра <code>${escapeHtml(key)}</code>.\nЕсть: ${MODELS[
          s.active
        ].params.map((p) => p.key).join(', ')}`,
        { parse_mode: 'HTML' }
      );
    }
    try {
      const value = coerce(param, rawValue);
      const next = await session.update(ctx.from.id, (s) => {
        if (value === undefined) delete s.params[s.active][key];
        else s.params[s.active][key] = value;
        return s;
      });
      await ctx.reply(`${key} = ${formatValue(param, next.params[next.active])}`);
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });

  bot.command('reset', async (ctx) => {
    const s = await session.update(ctx.from.id, (s) => {
      s.params[s.active] = defaultParams(s.active);
      s.modelOverride = null;
      return s;
    });
    await ctx.reply(await settingsText(s), { parse_mode: 'HTML', reply_markup: settingsKeyboard(s) });
  });

  bot.command('clear', async (ctx) => {
    const s = await session.update(ctx.from.id, (s) => {
      s.attachments[s.active] = [];
      return s;
    });
    await ctx.reply(`🧹 Файлы для ${MODELS[s.active].label} убраны.`);
  });

  bot.command('files', async (ctx) => {
    const s = await session.load(ctx.from.id);
    const list = s.attachments[s.active];
    if (!list.length) return ctx.reply(`Файлов нет. ${MODELS[s.active].attachHint}`);
    await ctx.reply(
      list.map((a, i) => `${i + 1}. [${a.kind}] ${a.url}`).join('\n'),
      { disable_web_page_preview: true }
    );
  });

  bot.command('credits', async (ctx) => {
    try {
      await ctx.reply(`💳 Кредитов на KIE: ${await getCredits()}`);
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });

  bot.command('status', async (ctx) => {
    const taskId = (ctx.match || '').trim();
    if (!taskId) return ctx.reply('Формат: <code>/status &lt;taskId&gt;</code>', { parse_mode: 'HTML' });
    try {
      const data = await getTask(taskId);
      await ctx.reply(
        `<code>${escapeHtml(JSON.stringify(data, null, 2)).slice(0, 3500)}</code>`,
        { parse_mode: 'HTML' }
      );
      if (data.state === 'success') {
        await deliver(ctx.api, { c: ctx.chat.id, k: guessKind(data.model), l: data.model }, taskId, data);
      }
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });

  // Полный обход схемы: свой model id и свой input — как в голом API.
  bot.command('model', async (ctx) => {
    const v = (ctx.match || '').trim();
    const s = await session.update(ctx.from.id, (s) => {
      s.modelOverride = v && v !== 'reset' ? v : null;
      return s;
    });
    await ctx.reply(
      s.modelOverride
        ? `model id принудительно: <code>${escapeHtml(s.modelOverride)}</code>`
        : 'model id снова выбирается автоматически.',
      { parse_mode: 'HTML' }
    );
  });

  bot.command('raw', async (ctx) => {
    const body = (ctx.match || '').trim();
    if (!body) {
      return ctx.reply(
        'Формат: <code>/raw {"model":"...","input":{...}}</code>\n' +
          'Если <code>model</code> не указать — возьмётся активная модель, а <code>input</code> ' +
          'дольётся поверх собранного ботом.',
        { parse_mode: 'HTML' }
      );
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      return ctx.reply(`⚠️ JSON не разбирается: ${err.message}`);
    }
    await runGeneration(ctx, null, payload);
  });

  // ── файлы ───────────────────────────────────────────────────────────────────
  bot.on(['message:photo', 'message:document', 'message:video', 'message:audio', 'message:voice'],
    async (ctx) => {
      try {
        const att = await ingestFile(ctx);
        const s = await session.update(ctx.from.id, (s) => {
          const def = MODELS[s.active];
          const limit = def.accepts[att.kind] ?? 0;
          if (!limit) throw new Error(`${def.label} не принимает ${att.kind}`);
          const same = s.attachments[s.active].filter((a) => a.kind === att.kind);
          if (same.length >= limit) {
            throw new Error(`${def.label}: больше ${limit} ${att.kind} нельзя. /clear чтобы сбросить`);
          }
          s.attachments[s.active].push(att);
          return s;
        });
        const list = s.attachments[s.active];
        const caption = ctx.message.caption?.trim();
        await ctx.reply(
          `📎 Принял (${att.kind}). Всего файлов: ${list.length}.\n` +
            (caption ? 'Генерирую по подписи…' : 'Теперь пришли промпт текстом.')
        );
        if (caption) await runGeneration(ctx, caption);
      } catch (err) {
        await ctx.reply(`⚠️ ${err.message}`);
      }
    }
  );

  // ── текст ───────────────────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) return;
    const s = await session.load(ctx.from.id);

    // ждём значение параметра, введённое вручную
    if (s.awaiting) {
      const { mk, key } = s.awaiting;
      const param = findParam(mk, key);
      try {
        const value = coerce(param, text);
        const next = await session.update(ctx.from.id, (s) => {
          if (value === undefined) delete s.params[mk][key];
          else s.params[mk][key] = value;
          s.awaiting = null;
          return s;
        });
        await ctx.reply(`${key} = ${formatValue(param, next.params[mk])}`);
        await ctx.reply(await settingsText(next), {
          parse_mode: 'HTML',
          reply_markup: settingsKeyboard(next),
        });
      } catch (err) {
        await ctx.reply(`⚠️ ${err.message}\nПришли значение ещё раз или /settings чтобы выйти.`);
      }
      return;
    }

    await runGeneration(ctx, text);
  });

  // ── инлайн-кнопки ───────────────────────────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    const [action, a, b, c] = ctx.callbackQuery.data.split('|');
    const userId = ctx.from.id;

    if (action === 'm') {
      const s = await session.update(userId, (s) => {
        s.active = MK[+a];
        s.awaiting = null;
        return s;
      });
      await ctx.answerCallbackQuery(MODELS[s.active].label);
      return refresh(ctx, s);
    }

    if (action === 'b') {
      const s = await session.update(userId, (s) => ((s.awaiting = null), s));
      await ctx.answerCallbackQuery();
      return refresh(ctx, s);
    }

    if (action === 'p') {
      const mk = MK[+a];
      const param = MODELS[mk].params[+b];
      if (param.type === 'bool') {
        const s = await session.update(userId, (s) => {
          const cur = s.params[mk][param.key] ?? param.def ?? false;
          s.params[mk][param.key] = !cur;
          return s;
        });
        await ctx.answerCallbackQuery(`${param.key}: ${formatValue(param, s.params[mk])}`);
        return refresh(ctx, s);
      }
      if (param.type === 'enum') {
        const s = await session.load(userId);
        await ctx.answerCallbackQuery();
        return safeEdit(ctx, paramText(mk, param, s), valuesKeyboard(a, b, param));
      }
      // string / int / float — просим текстом
      const s = await session.update(userId, (s) => ((s.awaiting = { mk, key: param.key }), s));
      await ctx.answerCallbackQuery();
      return safeEdit(
        ctx,
        `${paramText(mk, param, s)}\n\nПришли значение сообщением. <code>-</code> — сбросить.`,
        new InlineKeyboard().text('← назад', `b|${a}`)
      );
    }

    if (action === 'v') {
      const mk = MK[+a];
      const param = MODELS[mk].params[+b];
      const value = c === '_' ? undefined : param.values[+c];
      const s = await session.update(userId, (s) => {
        if (value === undefined) delete s.params[mk][param.key];
        else s.params[mk][param.key] = value;
        s.awaiting = null;
        return s;
      });
      await ctx.answerCallbackQuery(`${param.key}: ${formatValue(param, s.params[mk])}`);
      return refresh(ctx, s);
    }

    await ctx.answerCallbackQuery();
  });

  return bot;
}

// ── генерация ─────────────────────────────────────────────────────────────────
async function runGeneration(ctx, prompt, rawPayload) {
  const s = await session.load(ctx.from.id);
  const mk = s.active;
  const def = MODELS[mk];

  let model;
  let input;
  try {
    if (prompt !== null && prompt !== undefined) {
      ({ model, input } = def.build({
        prompt,
        params: s.params[mk],
        attachments: s.attachments[mk],
      }));
    } else {
      ({ model, input } = def.build({
        prompt: rawPayload?.input?.prompt ?? '',
        params: s.params[mk],
        attachments: s.attachments[mk],
      }));
    }
    if (rawPayload) {
      if (rawPayload.model) model = rawPayload.model;
      if (rawPayload.input) input = { ...input, ...rawPayload.input };
    }
    if (s.modelOverride) model = s.modelOverride;
    if (!input.prompt || String(input.prompt).trim().length < 1) {
      return ctx.reply('Нужен промпт.');
    }
  } catch (err) {
    return ctx.reply(`⚠️ ${err.message}`);
  }

  const label = `${def.emoji} ${def.label}`;
  const status = await ctx.reply(`⏳ <b>${label}</b>\n<code>${escapeHtml(model)}</code>\nсоздаю задачу…`, {
    parse_mode: 'HTML',
  });
  const meta = { c: ctx.chat.id, m: status.message_id, k: def.resultKind, l: label };

  let taskId;
  try {
    taskId = await createTask(model, input, callbackUrl(meta));
  } catch (err) {
    // Разные версии схемы Kling ждут то image_urls, то image_url — пробуем второй вариант.
    if (/image_url/i.test(err.message) && Array.isArray(input.image_urls)) {
      const retry = { ...input, image_url: input.image_urls[0] };
      delete retry.image_urls;
      try {
        taskId = await createTask(model, retry, callbackUrl(meta));
      } catch (err2) {
        return reportFail(ctx, status.message_id, label, err2.message);
      }
    } else {
      return reportFail(ctx, status.message_id, label, err.message);
    }
  }
  await ctx.api
    .editMessageText(
      ctx.chat.id,
      status.message_id,
      `⏳ <b>${label}</b> в работе\n<code>${escapeHtml(model)}</code>\n<code>${taskId}</code>`,
      { parse_mode: 'HTML' }
    )
    .catch(() => {});

  if (callbackUrl(meta)) {
    // Vercel: результат придёт вебхуком от KIE, крон подстрахует.
    await store.addPending(taskId, meta);
  } else {
    // Локально: ждём в фоне этого же процесса.
    waitForTask(taskId)
      .then((data) => deliver(ctx.api, meta, taskId, data))
      .catch((err) =>
        ctx.api
          .sendMessage(ctx.chat.id, `❌ ${label}: ${err.message}\n${taskId}`)
          .catch(() => {})
      );
  }
}

function reportFail(ctx, messageId, label, message) {
  return ctx.api
    .editMessageText(
      ctx.chat.id,
      messageId,
      `❌ <b>${label}</b>\n<code>${escapeHtml(message)}</code>`,
      { parse_mode: 'HTML' }
    )
    .catch(() => ctx.reply(`❌ ${label}: ${message}`));
}

// ── файлы из Telegram → хранилище KIE ─────────────────────────────────────────
async function ingestFile(ctx) {
  const msg = ctx.message;
  let fileId;
  let kind;
  let name;
  let mime;

  if (msg.photo) {
    fileId = msg.photo.at(-1).file_id;
    kind = 'image';
    name = 'photo.jpg';
    mime = 'image/jpeg';
  } else if (msg.video) {
    fileId = msg.video.file_id;
    kind = 'video';
    name = msg.video.file_name || 'video.mp4';
    mime = msg.video.mime_type || 'video/mp4';
  } else if (msg.audio || msg.voice) {
    const f = msg.audio || msg.voice;
    fileId = f.file_id;
    kind = 'audio';
    name = f.file_name || (msg.voice ? 'voice.ogg' : 'audio.mp3');
    mime = f.mime_type || 'audio/mpeg';
  } else if (msg.document) {
    fileId = msg.document.file_id;
    mime = msg.document.mime_type || 'application/octet-stream';
    name = msg.document.file_name || 'file';
    kind = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';
  } else {
    throw new Error('Не понял, что это за файл');
  }

  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не смог скачать файл из Telegram (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const uploaded = await uploadBuffer(buf, name, mime);
  return { kind, url: uploaded, name };
}

// ── интерфейс настроек ────────────────────────────────────────────────────────
async function settingsText(s) {
  const mk = s.active;
  const def = MODELS[mk];
  const lines = [`${def.emoji} <b>${def.label}</b>`, ''];
  for (const p of def.params) {
    lines.push(`<code>${p.key}</code> = <b>${escapeHtml(formatValue(p, s.params[mk]))}</b>`);
  }
  const files = s.attachments[mk];
  lines.push('', `📎 Файлов: ${files.length}${files.length ? ` (${countKinds(files)})` : ''}`);
  if (!files.length) lines.push(`<i>${escapeHtml(def.attachHint)}</i>`);
  if (s.modelOverride) lines.push('', `model id: <code>${escapeHtml(s.modelOverride)}</code>`);
  lines.push('', '<i>Пришли текст — он станет промптом.</i>');
  return lines.join('\n');
}

function countKinds(files) {
  const c = {};
  for (const f of files) c[f.kind] = (c[f.kind] || 0) + 1;
  return Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(', ');
}

function settingsKeyboard(s) {
  const kb = new InlineKeyboard();
  for (const mk of MK) {
    kb.text(`${mk === s.active ? '● ' : ''}${MODELS[mk].emoji} ${MODELS[mk].label}`, `m|${MK.indexOf(mk)}`);
    kb.row();
  }
  const ai = MK.indexOf(s.active);
  MODELS[s.active].params.forEach((p, i) => {
    kb.text(`${p.key}: ${formatValue(p, s.params[s.active])}`, `p|${ai}|${i}`).row();
  });
  return kb;
}

function paramText(mk, param, s) {
  const lines = [
    `<b>${param.key}</b>`,
    `сейчас: <b>${escapeHtml(formatValue(param, s.params[mk]))}</b>`,
  ];
  if (param.note) lines.push('', `<i>${escapeHtml(param.note)}</i>`);
  return lines.join('\n');
}

function valuesKeyboard(a, b, param) {
  const kb = new InlineKeyboard();
  param.values.forEach((v, i) => {
    kb.text(v, `v|${a}|${b}|${i}`);
    if ((i + 1) % 4 === 0) kb.row();
  });
  kb.row();
  if (param.def === undefined) kb.text('сбросить', `v|${a}|${b}|_`);
  kb.text('← назад', `b|${a}`);
  return kb;
}

async function refresh(ctx, s) {
  return safeEdit(ctx, await settingsText(s), settingsKeyboard(s));
}

async function safeEdit(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

function guessKind(model = '') {
  return /image/i.test(model) && !/video/i.test(model) ? 'photo' : 'video';
}

const HELP = `<b>KIE AI прямо в телеге</b>

<b>Модели</b>
/image — 🖼 GPT Image 2
/kling — 🎬 Kling 2.5 Turbo Pro
/seedance — 🌀 Seedance 2.0

Выбрал модель → шлёшь текст, это промпт. Шлёшь картинку/видео/аудио — они цепляются как вход (image-to-image, image-to-video, референсы Seedance). Подпись к файлу тоже работает как промпт.

<b>Параметры</b>
/settings — все параметры активной модели кнопками
/set ключ значение — то же текстом, напр. <code>/set resolution 4K</code>
/reset — параметры по умолчанию
/files — что сейчас приложено
/clear — убрать приложенные файлы

<b>Сырой API</b>
/model &lt;id&gt; — свой model id (/model reset — обратно)
/raw {"input":{...}} — свой JSON поверх собранного
/status &lt;taskId&gt; — статус задачи
/credits — остаток кредитов`;
