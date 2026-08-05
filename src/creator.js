// Ветка креатора: только GPT Image 2, жёстко 21:9 / 1K, две генерации на промпт.
// Никаких настроек, моделей и цен — интерфейс сведён к «промпт → кадр → согласование».
import { Composer, InlineKeyboard } from 'grammy';
import * as session from './session.js';
import * as store from './storage.js';
import { createTask, waitForTask } from './kie.js';
import { callbackUrl, deliver, rememberJob, escapeHtml } from './deliver.js';
import { pre, captionPlan, PROMPT_LABEL, WAITING_HEADER } from './render.js';
import { placeholderMedia, rememberPlaceholder, wide } from './placeholder.js';
import { ingestFile } from './ingest.js';
import { newFrameId, saveFrame, sendForApproval } from './frames.js';

// Сколько картинок на один промпт. Одна укладывается в одно сообщение вместе
// с кнопкой; при двух и больше кнопка поедет отдельным сообщением.
const GENERATIONS = Math.max(1, Number(process.env.CREATOR_GENERATIONS) || 1);
const ASPECT = '21:9';
const RESOLUTION = '1K';
const MAX_REFS = 16;

const HELP = `<b>Генерация кадров</b>

Пришли промпт текстом — сделаю кадр в формате ${ASPECT}, ${RESOLUTION}${
  GENERATIONS > 1 ? ` (${GENERATIONS} варианта)` : ''
}.

Можно приложить картинки-референсы (до ${MAX_REFS}) — тогда кадр строится по ним. /clear убирает их.

У готового кадра есть кнопка «Отправить на согласование». Нажать можно сразу или потом — кнопка не пропадает. Бот спросит номер кадра, туда можно писать что угодно.

Пока ждёшь один кадр, спокойно запускай следующие — они не мешают друг другу.`;

export function creatorComposer() {
  const c = new Composer();

  c.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  c.command('clear', async (ctx) => {
    await session.update(ctx.from.id, (s) => ((s.attachments.image = []), s));
    await ctx.reply('🧹 Референсы убраны.');
  });

  c.command('cancel', async (ctx) => {
    await session.update(ctx.from.id, (s) => ((s.awaiting = null), (s.pendingFrame = null), s));
    await ctx.reply('Ок, отменил.');
  });

  c.on(['message:photo', 'message:document'], async (ctx) => {
    try {
      const att = await ingestFile(ctx);
      if (att.kind !== 'image') throw new Error('Принимаю только картинки.');
      const s = await session.update(ctx.from.id, (s) => {
        if (s.attachments.image.length >= MAX_REFS) {
          throw new Error(`Больше ${MAX_REFS} референсов нельзя. /clear чтобы сбросить.`);
        }
        s.attachments.image.push(att);
        return s;
      });
      const caption = ctx.message.caption?.trim();
      await ctx.reply(`📎 Референс принят. Всего: ${s.attachments.image.length}.`);
      if (caption) await proposeFrame(ctx, caption);
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });

  c.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) return;
    const s = await session.load(ctx.from.id);

    // Ждём подпись к кадру, который отправляют на согласование.
    if (s.awaiting?.kind === 'approval') {
      const fid = s.awaiting.fid;
      await session.update(ctx.from.id, (s) => ((s.awaiting = null), s));
      try {
        const n = await sendForApproval(ctx.api, fid, text, ctx.from);
        await ctx.reply(`✅ Отправлено на согласование (${n} шт.).`);
      } catch (err) {
        await ctx.reply(`⚠️ ${err.message}`);
      }
      return;
    }

    await proposeFrame(ctx, text);
  });

  c.on('callback_query:data', async (ctx) => {
    const [action, arg] = ctx.callbackQuery.data.split('|');

    if (action === 'apv') {
      await session.update(ctx.from.id, (s) => ((s.awaiting = { kind: 'approval', fid: arg }), s));
      await ctx.answerCallbackQuery();
      await ctx.reply('Введите номер кадра:');
      return;
    }

    if (action === 'cgo' || action === 'cno') {
      const s = await session.load(ctx.from.id);
      const pending = s.pendingFrame;
      if (!pending || pending.id !== arg) {
        await ctx.answerCallbackQuery('Этот запрос уже неактуален');
        return editSafe(ctx, '⌛️ Запрос устарел — пришли промпт заново.');
      }
      await session.update(ctx.from.id, (s) => ((s.pendingFrame = null), s));
      if (action === 'cno') {
        await ctx.answerCallbackQuery('Отменено');
        return editSafe(ctx, '✖️ Отменено.');
      }
      await ctx.answerCallbackQuery('Погнали');
      return startFrame(ctx, pending);
    }

    await ctx.answerCallbackQuery();
  });

  return c;
}

async function proposeFrame(ctx, prompt) {
  const s = await session.load(ctx.from.id);
  const refs = s.attachments.image.map((a) => a.url);
  const id = Math.random().toString(36).slice(2, 8);
  await session.update(ctx.from.id, (s) => ((s.pendingFrame = { id, prompt, refs }), s));

  const lines = [
    '<b>Промпт:</b>',
    pre(prompt),
    `Формат: <b>${ASPECT}</b> · Качество: <b>${RESOLUTION}</b>` +
      (GENERATIONS > 1 ? ` · Вариантов: <b>${GENERATIONS}</b>` : ''),
  ];
  if (refs.length) lines.push(`Референсы: <b>${refs.length} шт.</b>`);
  lines.push('', 'Генерируем?');

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('✅ Генерить', `cgo|${id}`)
      .text('✖️ Отмена', `cno|${id}`),
  });
}

async function startFrame(ctx, pending) {
  const { prompt, refs } = pending;
  const fid = newFrameId();

  // Якорь сразу отправляем картинкой-заглушкой: текстовое сообщение Telegram
  // потом в картинку не превратит, а медиа на медиа подменить даст — так
  // результат окажется здесь же, а не улетит вниз чата.
  await ctx.api.deleteMessage(ctx.chat.id, ctx.callbackQuery.message.message_id).catch(() => {});
  const { caption } = captionPlan(prompt, WAITING_HEADER);
  const { media, cached } = await placeholderMedia('wide', wide);
  const anchor = await ctx.replyWithPhoto(media, { caption, parse_mode: 'HTML' });
  const anchorId = anchor.message_id;
  if (!cached) await rememberPlaceholder('wide', anchor);

  await saveFrame(fid, {
    chatId: ctx.chat.id,
    userId: ctx.from.id,
    prompt,
    anchorMsgId: anchorId,
    count: GENERATIONS,
  });

  const model = refs.length ? 'gpt-image-2-image-to-image' : 'gpt-image-2-text-to-image';
  const input = { prompt, aspect_ratio: ASPECT, resolution: RESOLUTION };
  if (refs.length) input.input_urls = refs;

  const started = [];
  for (let i = 0; i < GENERATIONS; i++) {
    const meta = { c: ctx.chat.id, m: anchorId, k: 'photo', l: 'Кадр', f: fid, i };
    try {
      const taskId = await createTask(model, input, callbackUrl(meta));
      await rememberJob(taskId, { prompt });
      started.push({ taskId, meta });
    } catch (err) {
      // Одна из двух не стартовала — считаем её сразу проваленной, иначе кадр
      // никогда не соберётся и зависнет в «в процессе».
      await store.set(`fres:${fid}:${i}`, '', 60 * 60 * 24 * 7);
      await store.incr(`fcnt:${fid}`, 60 * 60 * 24 * 7);
      console.error('[creator] createTask упал:', err.message);
    }
  }

  if (!started.length) {
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        anchorId,
        `❌ Не удалось запустить генерацию.\n\n${pre(prompt)}`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
    return;
  }

  for (const { taskId, meta } of started) {
    if (callbackUrl(meta)) {
      await store.addPending(taskId, meta);
    } else {
      waitForTask(taskId)
        .then((data) => deliver(ctx.api, meta, taskId, data))
        .catch((err) => {
          console.error('[creator] задача упала:', err.message);
          return deliver(ctx.api, meta, taskId, { state: 'fail', failMsg: err.message });
        });
    }
  }
}

async function editSafe(ctx, text) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML' });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML' });
  }
}

export { escapeHtml };
