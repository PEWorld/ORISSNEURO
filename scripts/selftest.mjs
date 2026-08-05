// Проверка сборки запросов и связи: node scripts/selftest.mjs
import { loadEnv } from '../src/env.js';
loadEnv();

import { MODELS, coerce, findParam } from '../src/models.js';
import { createBot } from '../src/bot.js';
import { callbackUrl, parseCallbackMeta } from '../src/deliver.js';
import { getCredits } from '../src/kie.js';
import { emptySession } from '../src/session.js';

let bad = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok ' : ' FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) bad++;
};

console.log('\n— сборка запросов —');
const s = emptySession();

for (const [mk, def] of Object.entries(MODELS)) {
  const state = { prompt: 'тест', params: s.params[mk], attachments: [] };
  const t2 = def.build(state);
  console.log(`\n${mk} (без файлов): ${t2.model}\n  ${JSON.stringify(t2.input)}`);
  ok(`${mk}: есть prompt`, !!t2.input.prompt);

  const withImg = def.build({
    ...state,
    attachments: [
      { kind: 'image', url: 'https://x/1.png' },
      { kind: 'image', url: 'https://x/2.png' },
    ],
  });
  console.log(`${mk} (2 картинки): ${withImg.model}\n  ${JSON.stringify(withImg.input)}`);
}

const seed = MODELS.seedance.build({
  prompt: 'тест',
  params: { ...s.params.seedance, mode: 'frames' },
  attachments: [
    { kind: 'image', url: 'https://x/a.png' },
    { kind: 'image', url: 'https://x/b.png' },
  ],
});
console.log(`\nseedance (frames):\n  ${JSON.stringify(seed.input)}`);
ok('seedance frames: first/last заданы', !!seed.input.first_frame_url && !!seed.input.last_frame_url);
ok('seedance frames: нет reference_image_urls', !seed.input.reference_image_urls);
ok('seedance: mode не улетает в API', !('mode' in seed.input));

const klingI2V = MODELS.kling.build({
  prompt: 'тест',
  params: s.params.kling,
  attachments: [{ kind: 'image', url: 'https://x/a.png' }],
});
ok('kling i2v: модель image-to-video', klingI2V.model === 'kling/v2-5-turbo-image-to-video-pro');
ok('kling i2v: aspect_ratio убран', !('aspect_ratio' in klingI2V.input));
ok('kling: duration строкой', typeof klingI2V.input.duration === 'string');

console.log('\n— валидация значений —');
ok('enum отвергает мусор', (() => {
  try { coerce(findParam('image', 'aspect_ratio'), '99:1'); return false; } catch { return true; }
})());
ok('int держит границы', (() => {
  try { coerce(findParam('seedance', 'duration'), '99'); return false; } catch { return true; }
})());
ok('float парсит запятую', coerce(findParam('kling', 'cfg_scale'), '0,7') === 0.7);
ok('"-" сбрасывает', coerce(findParam('kling', 'negative_prompt'), '-') === undefined);

console.log('\n— подпись колбэка —');
process.env.PUBLIC_URL = 'https://example.vercel.app';
const meta = { c: 123, m: 456, k: 'video', l: 'Kling' };
const url = new URL(callbackUrl(meta));
const back = parseCallbackMeta(url.searchParams.get('d'), url.searchParams.get('s'));
ok('meta переживает round-trip', JSON.stringify(back) === JSON.stringify(meta));
ok('подделанная подпись отбивается', (() => {
  try { parseCallbackMeta(url.searchParams.get('d'), 'deadbeef'); return false; } catch { return true; }
})());
delete process.env.PUBLIC_URL;
ok('без PUBLIC_URL колбэк не строится', callbackUrl(meta) === null);

console.log('\n— живые проверки —');
try {
  const bot = createBot(process.env.TELEGRAM_BOT_TOKEN);
  const me = await bot.api.getMe();
  ok('Telegram getMe', true, `@${me.username}`);
} catch (err) {
  ok('Telegram getMe', false, err.message);
}
try {
  ok('KIE кредиты', true, String(await getCredits()));
} catch (err) {
  ok('KIE кредиты', false, err.message);
}

console.log(bad ? `\n${bad} проверок упало` : '\nвсё зелёное');
process.exit(bad ? 1 : 0);
