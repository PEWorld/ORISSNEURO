import { Bot, InlineKeyboard } from 'grammy';
import { MODELS, defaultParams, findParam, coerce, formatValue } from './models.js';
import { validateWan } from './wan.js';
import * as session from './session.js';
import * as store from './storage.js';
import { createTask, getCredits, getTask, waitForTask } from './kie.js';
import { callbackUrl, deliver, rememberJob, escapeHtml } from './deliver.js';
import { estimate, formatEstimate } from './pricing.js';
import { roleOf } from './roles.js';
import { creatorComposer } from './creator.js';
import { ingestFile } from './ingest.js';
import { captionPlan, sendWaiting, PROMPT_LABEL } from './render.js';
import { placeholderMedia, rememberPlaceholder, standard } from './placeholder.js';

const MK = Object.keys(MODELS); // ['image','kling','seedance','nb2','nbpro','seedream'] — индексы в callback_data

export function createBot(token) {
  const bot = new Bot(token);

  // ── доступ и роли ───────────────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    ctx.role = id ? roleOf(id) : null;
    if (!ctx.role) {
      if (ctx.chat) await ctx.reply(`Доступа нет. Твой id: ${id}`);
      return;
    }
    await next();
  });

  bot.catch((err) => console.error('[bot]', err?.error ?? err));

  // Креатор живёт в своей ветке и до владельческих обработчиков не доходит.
  bot.filter((ctx) => ctx.role === 'creator', creatorComposer());
  const owner = bot.filter((ctx) => ctx.role === 'owner');

  // ── команды ─────────────────────────────────────────────────────────────────
  owner.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  for (const mk of MK) {
    owner.command(mk, async (ctx) => {
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

  owner.command('settings', async (ctx) => {
    const s = await session.load(ctx.from.id);
    await ctx.reply(await settingsText(s), {
      parse_mode: 'HTML',
      reply_markup: settingsKeyboard(s),
    });
  });

  owner.command('set', async (ctx) => {
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

  owner.command('reset', async (ctx) => {
    const s = await session.update(ctx.from.id, (s) => {
      s.params[s.active] = defaultParams(s.active);
      s.modelOverride = null;
      return s;
    });
    await ctx.reply(await settingsText(s), { parse_mode: 'HTML', reply_markup: settingsKeyboard(s) });
  });

  owner.command('confirm', async (ctx) => {
    const arg = (ctx.match || '').trim().toLowerCase();
    const s = await session.update(ctx.from.id, (s) => {
      s.confirm = arg === 'on' ? true : arg === 'off' ? false : s.confirm === false;
      return s;
    });
    await ctx.reply(
      s.confirm
        ? 'Окно подтверждения включено — перед каждой генерацией покажу параметры и цену.'
        : 'Окно подтверждения выключено — промпт уходит в работу сразу. Вернуть: /confirm on'
    );
  });

  owner.command('clear', async (ctx) => {
    const s = await session.update(ctx.from.id, (s) => {
      s.attachments[s.active] = [];
      return s;
    });
    await ctx.reply(`🧹 Файлы для ${MODELS[s.active].label} убраны.`);
  });

  owner.command('files', async (ctx) => {
    const s = await session.load(ctx.from.id);
    const list = s.attachments[s.active];
    if (!list.length) return ctx.reply(`Файлов нет. ${MODELS[s.active].attachHint}`);
    await ctx.reply(
      list.map((a, i) => `${i + 1}. [${a.kind}] ${a.url}`).join('\n'),
      { disable_web_page_preview: true }
    );
  });

  owner.command('credits', async (ctx) => {
    try {
      await ctx.reply(`💳 Кредитов на KIE: ${await getCredits()}`);
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });

  owner.command('status', async (ctx) => {
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
  owner.command('model', async (ctx) => {
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

  owner.command('raw', async (ctx) => {
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
  owner.on(['message:photo', 'message:document', 'message:video', 'message:audio', 'message:voice'],
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
  owner.on('message:text', async (ctx) => {
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
  owner.on('callback_query:data', async (ctx) => {
    const [action, a, b, c] = ctx.callbackQuery.data.split('|');
    const userId = ctx.from.id;

    if (action === 'go' || action === 'no') {
      const s = await session.load(userId);
      const job = s.pendingJobs?.[a];
      if (!job) {
        await ctx.answerCallbackQuery('Это подтверждение уже неактуально');
        return safeEdit(ctx, '⌛️ Запрос устарел — пришли промпт заново.', undefined);
      }
      await session.update(userId, (s) => {
        delete s.pendingJobs[a];
        return s;
      });
      if (action === 'no') {
        await ctx.answerCallbackQuery('Отменено');
        return safeEdit(ctx, `✖️ Отменено — <b>${job.label}</b>`, undefined);
      }
      await ctx.answerCallbackQuery('Погнали');
      return execute(ctx, job, ctx.callbackQuery.message?.message_id);
    }

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
    if (model === 'wan/3-0-video') validateWan(input);
    if (!input.prompt || String(input.prompt).trim().length < 1) {
      return ctx.reply('Нужен промпт.');
    }
  } catch (err) {
    return ctx.reply(`⚠️ ${err.message}`);
  }

  const job = { model, input, kind: def.resultKind, label: `${def.emoji} ${def.label}` };

  if (s.confirm === false) return execute(ctx, job);

  // Показываем, что именно уйдёт в KIE и во сколько это обойдётся.
  const id = Math.random().toString(36).slice(2, 8);
  await session.update(ctx.from.id, (s) => {
    s.pendingJobs = session.remember(s.pendingJobs, id, { id, ...job });
    return s;
  });
  await ctx.reply(await confirmText(job), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('✅ Генерить', `go|${id}`)
      .text('✖️ Отмена', `no|${id}`),
  });
}

// Собственно запуск задачи. statusId — сообщение, которое надо превратить в статус
// (при подтверждении это само окно подтверждения, чтобы не плодить сообщения).
async function execute(ctx, job, statusId) {
  const { model, input, label } = job;

  // Сообщение о ходе работы сразу отправляем картинкой-заглушкой: текст Telegram
  // потом в медиа не превратит, а медиа на медиа подменить даст — так результат
  // окажется на месте ожидания, а не улетит вниз чата. Промпт держим тут же:
  // пока ждёшь несколько генераций сразу, только по нему и видно, какая из них какая.
  const header =
    `⏳ <b>Ваша генерация в процессе</b>\n${label} · <code>${escapeHtml(model)}</code>\n\n` +
    PROMPT_LABEL;
  const { caption } = captionPlan(String(input.prompt), header);

  if (statusId) await ctx.api.deleteMessage(ctx.chat.id, statusId).catch(() => {});
  const { messageId: statusMessageId } = await sendWaiting(
    ctx,
    caption,
    await placeholderMedia('standard', standard),
    (msg) => rememberPlaceholder('standard', msg)
  );
  const meta = { c: ctx.chat.id, m: statusMessageId, k: job.kind, l: label };

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
        return reportFail(ctx, statusMessageId, label, err2.message);
      }
    } else {
      return reportFail(ctx, statusMessageId, label, err.message);
    }
  }
  await rememberJob(taskId, { prompt: String(input.prompt) });

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

// Человеческие имена для полей, которые уходят в API.
const FIELD_LABELS = {
  resolution: 'Качество',
  aspect_ratio: 'Соотношение',
  duration: 'Длительность',
  cfg_scale: 'Следование промпту',
  negative_prompt: 'Негатив',
  sound: 'Звук',
  generate_audio: 'Звук',
  audio: 'Звук',
  seed: 'Seed',
  web_search: 'Поиск в вебе',
  nsfw_checker: 'NSFW-фильтр',
};

const COUNT_LABELS = {
  input_urls: 'Референсы',
  image_urls: 'Исходный кадр',
  reference_image_urls: 'Референсы',
  reference_video_urls: 'Видео-референсы',
  reference_audio_urls: 'Аудио-референсы',
  reference_file_urls: 'Документ',
  reference_link_urls: 'Страница',
};

async function confirmText({ model, input, label }) {
  const lines = [`<b>${label}</b>`, `<code>${escapeHtml(model)}</code>`, ''];

  const promptText = String(input.prompt);
  lines.push(
    `<b>Промпт:</b> ${escapeHtml(
      promptText.length > 300 ? promptText.slice(0, 300) + '…' : promptText
    )}`,
    ''
  );

  for (const [key, value] of Object.entries(input)) {
    if (key === 'prompt') continue;
    if (Array.isArray(value)) {
      lines.push(`${COUNT_LABELS[key] ?? key}: ${value.length} шт.`);
    } else if (key === 'first_frame_url') {
      lines.push('Первый кадр: задан');
    } else if (key === 'last_frame_url') {
      lines.push('Последний кадр: задан');
    } else if (typeof value === 'boolean') {
      lines.push(`${FIELD_LABELS[key] ?? key}: ${value ? 'вкл' : 'выкл'}`);
    } else {
      const suffix = key === 'duration' ? ' с' : '';
      lines.push(`${FIELD_LABELS[key] ?? key}: ${key === 'duration' && value === -1 ? 'автоматически' : escapeHtml(String(value)) + suffix}`);
    }
  }

  const est = estimate(model, input);
  let balance = null;
  try {
    balance = await getCredits();
  } catch { /* баланс не критичен — покажем без него */ }

  lines.push('');
  if (balance != null) lines.push(`Кредитов у вас: <b>${balance}</b>`);
  lines.push(`Будет потрачено: <b>${formatEstimate(est)}</b>`);
  if (est?.note) lines.push(`<i>${escapeHtml(est.note)}</i>`);

  if (balance != null && est) {
    if (est.min > balance) {
      lines.push('', '⚠️ <b>Кредитов не хватает</b> — KIE, скорее всего, откажет.');
    } else if (est.max !== Infinity) {
      lines.push(`Останется: <b>${Math.round((balance - est.max) * 100) / 100}</b>`);
    }
  }

  lines.push('', 'Всё верно?');
  return lines.join('\n');
}

// Сообщение о ходе работы — картинка, поэтому правим подпись, а не текст.
function reportFail(ctx, messageId, label, message) {
  const text = `❌ <b>${label}</b>\n<code>${escapeHtml(message)}</code>`;
  return ctx.api
    .editMessageCaption(ctx.chat.id, messageId, { caption: text, parse_mode: 'HTML' })
    .catch(() =>
      ctx.api
        .deleteMessage(ctx.chat.id, messageId)
        .catch(() => {})
        .then(() => ctx.reply(text, { parse_mode: 'HTML' }))
    );
}

// ── интерфейс настроек ────────────────────────────────────────────────────────
async function settingsText(s) {
  const mk = s.active;
  const def = MODELS[mk];
  const lines = [`${def.emoji} <b>${def.label}</b>`, ''];
  if (def.priceHint) lines.push(escapeHtml(def.priceHint), '');
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
  return /image|banana/i.test(model) && !/video/i.test(model) ? 'document' : 'video';
}

const HELP = `<b>KIE AI прямо в телеге</b>

<b>Модели</b>
/image — 🖼 GPT Image 2
/nb2 — 🍌 Nano Banana 2
/nbpro — 🍌 Nano Banana Pro
/seedream — 🌱 Seedream 5.0 Pro
/kling — 🎬 Kling 2.5 Turbo Pro
/seedance — 🌀 Seedance 2.0
/wan — 🌊 WAN 3.0 (2–30с, референсы, кадры, документы, ссылки)

Выбрал модель → шлёшь текст, это промпт. Шлёшь картинку/видео/аудио — они цепляются как вход (image-to-image, image-to-video, референсы Seedance). Подпись к файлу тоже работает как промпт.

<b>Параметры</b>
/settings — все параметры активной модели кнопками
/set ключ значение — то же текстом, напр. <code>/set resolution 4K</code>
/reset — параметры по умолчанию
/files — что сейчас приложено
/clear — убрать приложенные файлы

<b>Перед запуском</b>
Показываю окно с параметрами и ценой — генерация стартует только после «Генерить». /confirm off отключает окно, /confirm on возвращает.

<b>Сырой API</b>
/model &lt;id&gt; — свой model id (/model reset — обратно)
/raw {"input":{...}} — свой JSON поверх собранного
/status &lt;taskId&gt; — статус задачи
/credits — остаток кредитов`;
