// Локальный запуск: long polling, состояние в data/state.json, результат ждём опросом.
import { loadEnv } from './src/env.js';
loadEnv();

import { createBot } from './src/bot.js';
import { backend } from './src/storage.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN не задан. Скопируй .env.example в .env и вставь токен от @BotFather.');
  process.exit(1);
}
if (!process.env.KIE_API_KEY) {
  console.error('KIE_API_KEY не задан (см. .env).');
  process.exit(1);
}

const bot = createBot(token);

try {
  await bot.api.getMe();
} catch (err) {
  console.error(`Не достучался до api.telegram.org: ${err.message}`);
  console.error(
    'Обычно это блокировка провайдера. Варианты:\n' +
      '  1) включить VPN и запустить снова;\n' +
      '  2) прокси: NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:PORT npm run dev\n' +
      '  3) задеплоить на Vercel — там Telegram доступен, машина в цепочке не нужна.'
  );
  process.exit(1);
}

await bot.api.setMyCommands([
  { command: 'image', description: '🖼 GPT Image 2' },
  { command: 'kling', description: '🎬 Kling 2.5 Turbo Pro' },
  { command: 'seedance', description: '🌀 Seedance 2.0' },
  { command: 'settings', description: 'Параметры активной модели' },
  { command: 'files', description: 'Приложенные файлы' },
  { command: 'clear', description: 'Убрать приложенные файлы' },
  { command: 'reset', description: 'Параметры по умолчанию' },
  { command: 'credits', description: 'Остаток кредитов KIE' },
  { command: 'help', description: 'Справка' },
]);

// На всякий случай снимаем вебхук — иначе long polling не запустится.
await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

const me = await bot.api.getMe();
console.log(`Бот @${me.username} запущен (long polling). Хранилище: ${backend()}.`);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

await bot.start({ drop_pending_updates: true });
