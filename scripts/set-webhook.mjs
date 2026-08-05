// Привязывает бота к вебхуку Vercel: node scripts/set-webhook.mjs [https://your-app.vercel.app]
// Снять обратно (вернуться на локальный long polling): node scripts/set-webhook.mjs --drop
import { loadEnv } from '../src/env.js';
loadEnv();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN не задан');
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const args = process.argv.slice(2);

if (args.includes('--drop')) {
  console.log(await api('deleteWebhook', { drop_pending_updates: false }));
  process.exit(0);
}

const base = (args.find((a) => a.startsWith('http')) || process.env.PUBLIC_URL || '').replace(/\/$/, '');
if (!base) {
  console.error('Укажи адрес: node scripts/set-webhook.mjs https://your-app.vercel.app');
  process.exit(1);
}

const res = await api('setWebhook', {
  url: `${base}/api/telegram`,
  secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
  drop_pending_updates: true,
  allowed_updates: ['message', 'callback_query'],
});
console.log(res);
console.log(await api('getWebhookInfo'));
