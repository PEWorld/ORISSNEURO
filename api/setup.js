// Одноразовая настройка после деплоя — открыть в браузере:
//   https://<деплой>/api/setup?token=<TELEGRAM_WEBHOOK_SECRET>
// Ставит вебхук Telegram и меню команд СО СТОРОНЫ Vercel, поэтому работает,
// даже если с твоей машины api.telegram.org недоступен.
import { query, json } from '../src/http.js';
import { publicBase } from '../src/deliver.js';
import { owners, creators, approvalChatId } from '../src/roles.js';

const COMMANDS = [
  { command: 'image', description: '🖼 GPT Image 2' },
  { command: 'nb2', description: '🍌 Nano Banana 2' },
  { command: 'nbpro', description: '🍌 Nano Banana Pro' },
  { command: 'seedream', description: '🌱 Seedream 5.0 Pro' },
  { command: 'kling', description: '🎬 Kling 2.5 Turbo Pro' },
  { command: 'seedance', description: '🌀 Seedance 2.0' },
  { command: 'wan', description: '🌊 WAN 3.0 — видео 2–30с' },
  { command: 'settings', description: 'Параметры активной модели' },
  { command: 'files', description: 'Приложенные файлы' },
  { command: 'clear', description: 'Убрать приложенные файлы' },
  { command: 'reset', description: 'Параметры по умолчанию' },
  { command: 'confirm', description: 'Окно подтверждения перед генерацией' },
  { command: 'credits', description: 'Остаток кредитов KIE' },
  { command: 'help', description: 'Справка' },
];

// У креатора своё короткое меню — владельческие команды ему только мешают.
const CREATOR_COMMANDS = [
  { command: 'clear', description: 'Убрать референсы' },
  { command: 'cancel', description: 'Отменить текущий шаг' },
  { command: 'help', description: 'Справка' },
];

export default async function handler(req, res) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || query(req).token !== secret) {
    json(res, 403, { error: 'нужен ?token=<TELEGRAM_WEBHOOK_SECRET>' });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const call = (method, body) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then((r) => r.json());

  const base = (publicBase() || `https://${req.headers.host}`).replace(/\/$/, '');

  const out = {
    base,
    callbackBase: publicBase() || '(не определился — задай PUBLIC_URL)',
    setWebhook: await call('setWebhook', {
      url: `${base}/api/telegram`,
      secret_token: secret,
      drop_pending_updates: false,
      allowed_updates: ['message', 'callback_query'],
    }),
    setMyCommands: await call('setMyCommands', { commands: COMMANDS }),
    creatorCommands: await Promise.all(
      creators().map(async (id) => ({
        id,
        res: await call('setMyCommands', {
          commands: CREATOR_COMMANDS,
          scope: { type: 'chat', chat_id: Number(id) },
        }),
      }))
    ),
    roles: { owners: owners(), creators: creators(), approvalsGoTo: approvalChatId() },
    me: await call('getMe'),
    webhookInfo: await call('getWebhookInfo'),
    storage: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
      ? 'upstash/kv — настройки переживают перезапуск'
      : 'memory — настройки живут только до следующего холодного старта, подключи Upstash',
    // Только имена переменных, без значений — чтобы понять, доехало ли хранилище.
    storageEnvSeen: Object.keys(process.env)
      .filter((k) => /UPSTASH|^KV_|REDIS/.test(k))
      .sort(),
  };

  if (!publicBase()) {
    out.warning =
      'Публичный адрес не определился, KIE некуда слать результат. ' +
      `Задай PUBLIC_URL=${base} в переменных проекта и передеплой.`;
  }

  json(res, 200, out);
}
