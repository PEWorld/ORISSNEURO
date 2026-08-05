// Вебхук Telegram (Vercel). Отвечает быстро: создаёт задачу в KIE и выходит,
// результат прилетит отдельным запросом на /api/kie-callback.
import { webhookCallback } from 'grammy';
import { createBot } from '../src/bot.js';
import { body as readBody } from '../src/http.js';

const bot = createBot(process.env.TELEGRAM_BOT_TOKEN);

// Свой адаптер вместо встроенного 'https': Vercel уже вычитал тело запроса,
// и штатный адаптер, который слушает поток, просто повис бы до таймаута.
const vercelAdapter = (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  return {
    update: readBody(req),
    header: Array.isArray(secret) ? secret[0] : secret,
    end: () => res.end(),
    respond: (json) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(json);
    },
    unauthorized: () => {
      res.writeHead(401);
      res.end('secret token is wrong');
    },
  };
};

const handle = webhookCallback(bot, vercelAdapter, {
  secretToken: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
  timeoutMilliseconds: 55_000,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('kie-bot жив');
    return;
  }
  try {
    await handle(req, res);
  } catch (err) {
    console.error('[webhook]', err);
    // Не отдаём ошибку Telegram — иначе он будет ретраить один и тот же апдейт.
    if (!res.headersSent) res.writeHead(200).end();
  }
}
