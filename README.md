# kie-bot

Telegram-бот поверх KIE AI. Три модели, все параметры настраиваются как в API.

| Команда | Модель | Что умеет |
|---|---|---|
| `/image` | GPT Image 2 | text-to-image; приложи до 16 картинок → image-to-image |
| `/kling` | Kling 2.5 Turbo Pro | text-to-video; приложи 1 картинку → image-to-video |
| `/seedance` | Seedance 2.0 | референсы (до 9 картинок + 3 видео + 3 аудио) или first/last кадры |

Логика простая: выбрал модель → шлёшь текст, это промпт. Шлёшь файл — он цепляется на вход. Подпись к файлу тоже считается промптом.

## Параметры

`/settings` — кнопки со всеми полями активной модели. `/set ключ значение` — то же текстом. `/reset` — дефолты.

**GPT Image 2**: `aspect_ratio` (auto, 1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 2:1, 1:2, 3:1, 1:3, 21:9, 9:21), `resolution` (1K/2K/4K).

**Kling 2.5 Turbo Pro**: `duration` (5/10), `aspect_ratio` (16:9/9:16/1:1, только t2v), `sound`, `cfg_scale` (0–1), `negative_prompt` (до 500 символов).

**Seedance 2.0**: `mode` (`ref` — референсы / `frames` — первый+последний кадр; в API это взаимоисключающие режимы), `duration` (4–15), `resolution` (480p/720p/1080p/4k), `aspect_ratio` (1:1, 4:3, 3:4, 16:9, 9:16, 21:9, adaptive), `generate_audio`, `web_search`, `nsfw_checker`.

Если чего-то не хватает — есть голый API: `/model <id>` подменяет model id, `/raw {"input":{...}}` дольёт любой JSON поверх собранного ботом. `/status <taskId>`, `/credits`.

## Локальный запуск

```bash
npm install
cp .env.example .env   # вписать TELEGRAM_BOT_TOKEN, KIE_API_KEY, ALLOWED_USER_IDS
npm run dev
```

Long polling, настройки в `data/state.json`, результат ждётся опросом статуса.

> Если из России без VPN — `api.telegram.org` заблокирован, и локальный режим не стартует. Включи VPN, либо прокси (`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:ПОРТ npm run dev`), либо просто деплой на Vercel — там этой проблемы нет.

## Деплой на Vercel

Serverless не может ждать видео пять минут в одном запросе, поэтому схема такая: вебхук Telegram только создаёт задачу, а KIE потом сам стучится на `/api/kie-callback` — всё нужное для доставки зашито в подписанной ссылке.

1. `vercel` (или импорт репозитория в дашборде).
2. Переменные окружения проекта:
   - `TELEGRAM_BOT_TOKEN`, `KIE_API_KEY`, `ALLOWED_USER_IDS`
   - `TELEGRAM_WEBHOOK_SECRET`, `CALLBACK_SECRET` — любые случайные строки
   - `PUBLIC_URL` — только если домен свой. На обычном `*.vercel.app` адрес подхватывается сам из `VERCEL_PROJECT_PRODUCTION_URL`.
3. Открыть в браузере `https://<деплой>/api/setup?token=<TELEGRAM_WEBHOOK_SECRET>` — поставит вебхук и меню команд. Делается со стороны Vercel, так что VPN не нужен. Ответ покажет, какой адрес уйдёт в KIE и какое хранилище подключено.

Если результаты не приходят — первым делом Settings → Deployment Protection: включённая защита не даст KIE достучаться до `/api/kie-callback`.

### Хранилище

Без базы настройки живут только до холодного старта. Vercel → Storage → Upstash Redis (free) → подключить к проекту: переменные подхватятся сами (`UPSTASH_REDIS_REST_*` или `KV_REST_API_*`), ничего править не надо.

### Подстраховка

`/api/cron` добирает задачи, по которым колбэк не дошёл (нужно персистентное хранилище). На Hobby-плане Vercel крон запускается раз в сутки, так что смысл в нём появляется на Pro или с внешним планировщиком. Основной путь — колбэк.

## Проверка

```bash
node scripts/selftest.mjs
```

Собирает запросы под все модели, проверяет валидацию, подпись колбэков и связь с Telegram/KIE.
