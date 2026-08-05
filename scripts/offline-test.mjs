// Гоняет реальные апдейты через бота с заглушкой вместо Telegram API.
// Ни одного сетевого запроса — ни в Telegram, ни в KIE (генерация не дёргается).
// Запуск: node scripts/offline-test.mjs
import { loadEnv } from '../src/env.js';
loadEnv();

process.env.ALLOWED_USER_IDS = '42';
delete process.env.PUBLIC_URL;

import { createBot } from '../src/bot.js';
import * as store from '../src/storage.js';

const USER = { id: 42, is_bot: false, first_name: 'Max' };
const CHAT = { id: 42, type: 'private' };

let bad = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ok ' : ' FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) bad++;
};

const bot = createBot('0:TEST');
bot.botInfo = {
  id: 0, is_bot: true, first_name: 'kie', username: 'kie_test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business_account: false, has_main_web_app: false,
};

let calls = [];
let msgId = 1000;
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload });
  if (method === 'sendMessage' || method === 'editMessageText') {
    return {
      ok: true,
      result: { message_id: method === 'sendMessage' ? ++msgId : payload.message_id,
        chat: CHAT, date: 0, text: payload.text },
    };
  }
  return { ok: true, result: true };
});

let updId = 1;
const text = (t) => ({
  update_id: updId++,
  message: { message_id: ++msgId, from: USER, chat: CHAT, date: 0, text: t,
    entities: t.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] : [] },
});
const tap = (data) => ({
  update_id: updId++,
  callback_query: { id: String(updId), from: USER, chat_instance: 'x', data,
    message: { message_id: msgId, chat: CHAT, date: 0, text: 'stub' } },
});

async function send(update) {
  calls = [];
  await bot.handleUpdate(update);
  return calls;
}

const lastText = (c) =>
  [...c].reverse().find((x) => x.method === 'sendMessage' || x.method === 'editMessageText')
    ?.payload.text ?? '';
const lastKb = (c) =>
  [...c].reverse().find((x) => x.payload?.reply_markup)?.payload.reply_markup?.inline_keyboard ?? [];
const buttons = (c) => lastKb(c).flat().map((b) => `${b.text}::${b.callback_data}`);

// сбрасываем состояние тестового юзера
await store.del('u:42');

console.log('\n— доступ —');
{
  const c = await send({ ...text('/help'), message: { ...text('/help').message, from: { ...USER, id: 999 } } });
  ok('чужой юзер отбивается', lastText(c).includes('Доступа нет'));
}

console.log('\n— справка и переключение моделей —');
ok('/help отвечает', lastText(await send(text('/help'))).includes('KIE AI'));
{
  const c = await send(text('/kling'));
  ok('/kling показывает свои параметры', lastText(c).includes('cfg_scale'));
  ok('в клавиатуре есть все три модели', buttons(c).filter((b) => b.includes('::m|')).length === 3);
  ok('активная модель помечена', buttons(c).some((b) => b.startsWith('● ') && b.includes('Kling')));
}

console.log('\n— /set —');
ok('чужой параметр отбивается', lastText(await send(text('/set resolution 4K'))).includes('нет параметра'));
ok('плохое значение отбивается', lastText(await send(text('/set duration 7'))).includes('допустимо'));
ok('валидное принимается', lastText(await send(text('/set duration 10'))).trim() === 'duration = 10');
ok('float с запятой', lastText(await send(text('/set cfg_scale 0,8'))).trim() === 'cfg_scale = 0.8');
{
  const c = await send(text('/settings'));
  ok('настройки сохранились', lastText(c).includes('<b>10</b>') && lastText(c).includes('<b>0.8</b>'));
}

console.log('\n— кнопки —');
{
  const mk = ['image', 'kling', 'seedance'];
  const ai = mk.indexOf('kling');
  let c = await send(tap(`p|${ai}|0`)); // duration → enum
  ok('enum открывает список значений', buttons(c).some((b) => b.includes(`::v|${ai}|0|`)));
  ok('есть кнопка назад', buttons(c).some((b) => b.includes(`::b|${ai}`)));

  c = await send(tap(`v|${ai}|0|0`)); // duration = "5"
  ok('выбор значения применяется', lastText(c).includes('duration') && lastText(c).includes('<b>5</b>'));

  c = await send(tap(`p|${ai}|2`)); // sound → bool, тумблер
  ok('bool переключается сразу', lastText(c).includes('sound'));
  const s1 = await (await import('../src/session.js')).load(42);
  ok('sound стал true', s1.params.kling.sound === true);

  c = await send(tap(`p|${ai}|4`)); // negative_prompt → ждём текст
  ok('строковый параметр просит ввод', lastText(c).includes('Пришли значение'));
  c = await send(text('размытие, артефакты'));
  ok('введённое значение записалось', lastText(c).includes('размытие, артефакты'));
  const s2 = await (await import('../src/session.js')).load(42);
  ok('negative_prompt в сессии', s2.params.kling.negative_prompt === 'размытие, артефакты');

  c = await send(text('/set negative_prompt -'));
  const s3 = await (await import('../src/session.js')).load(42);
  ok('"-" сбрасывает параметр', !('negative_prompt' in s3.params.kling));

  c = await send(tap('m|2'));
  ok('переключение модели кнопкой', lastText(c).includes('Seedance'));
  const s4 = await (await import('../src/session.js')).load(42);
  ok('active сменился', s4.active === 'seedance');
  ok('параметры Kling не потерялись', s4.params.kling.cfg_scale === 0.8);
}

console.log('\n— /reset и /files —');
{
  await send(tap('m|1'));
  const c = await send(text('/reset'));
  ok('/reset вернул дефолты', lastText(c).includes('<b>5</b>') && lastText(c).includes('<b>0.5</b>'));
  ok('/files пустой', lastText(await send(text('/files'))).includes('Файлов нет'));
  ok('/clear отвечает', lastText(await send(text('/clear'))).includes('убраны'));
}

console.log('\n— /model и /raw —');
{
  ok('/model ставит override', lastText(await send(text('/model my/custom-model'))).includes('my/custom-model'));
  ok('/model reset снимает', lastText(await send(text('/model reset'))).includes('автоматически'));
  ok('/raw без аргументов даёт подсказку', lastText(await send(text('/raw'))).includes('Формат'));
  ok('/raw ловит битый JSON', lastText(await send(text('/raw {нет}'))).includes('не разбирается'));
}

console.log('\n— пустой промпт —');
{
  await send(text('/image'));
  const c = await send(text('   '));
  ok('пробелы не запускают генерацию', !c.some((x) => x.method === 'sendPhoto'));
}

console.log('\n— полный цикл генерации (KIE замокан) —');
{
  // Подменяем сеть: настоящий KIE не дёргается, кредиты не тратятся.
  let kie = [];
  let mode = 'ok';
  const reply = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const b = opts?.body ? JSON.parse(opts.body) : null;
    kie.push({ u, b });
    if (u.includes('/jobs/createTask')) {
      if (mode === 'singular' && b.input.image_urls) {
        return reply({ code: 422, msg: 'input.image_url is required' });
      }
      if (mode === 'broken') return reply({ code: 402, msg: 'not enough credits' });
      return reply({ code: 200, msg: 'success', data: { taskId: 'task_test' } });
    }
    if (u.includes('/jobs/recordInfo')) {
      return reply({
        code: 200, msg: 'success',
        data: { taskId: 'task_test', state: 'success', costTime: 4200, creditsConsumed: 4,
          resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/out.png'] }) },
      });
    }
    throw new Error('неожиданный сетевой вызов: ' + u);
  };

  const settle = async (pred, ms = 3000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  // text-to-image
  await store.del('done:task_test');
  await send(text('/image'));
  kie = [];
  calls = [];
  await bot.handleUpdate(text('кот в скафандре'));
  const created = kie.find((x) => x.u.includes('createTask'));
  ok('createTask ушёл', !!created);
  ok('модель text-to-image', created?.b.model === 'gpt-image-2-text-to-image');
  ok('промпт долетел', created?.b.input.prompt === 'кот в скафандре');
  ok('callBackUrl не ставится локально', !('callBackUrl' in (created?.b ?? {})));
  ok('дождались доставки', await settle(() => calls.some((x) => x.method === 'sendPhoto')));
  const photo = calls.find((x) => x.method === 'sendPhoto');
  ok('картинка ушла ссылкой', photo?.payload.photo === 'https://cdn.example/out.png');
  ok('в подписи есть цена и время', /4 кред/.test(photo?.payload.caption ?? '') && /4с/.test(photo?.payload.caption ?? ''));

  // повторная доставка той же задачи не дублируется
  calls = [];
  const { deliver } = await import('../src/deliver.js');
  await deliver(bot.api, { c: 42, m: 1, k: 'photo', l: 'test' }, 'task_test');
  ok('повторная доставка гасится', !calls.some((x) => x.method === 'sendPhoto'));

  // kling image-to-video + фолбэк image_urls → image_url
  mode = 'singular';
  await store.del('done:task_test');
  const sess = await import('../src/session.js');
  await sess.update(42, (s) => {
    s.active = 'kling';
    s.attachments.kling = [{ kind: 'image', url: 'https://cdn.example/in.png', name: 'in.png' }];
    return s;
  });
  kie = [];
  calls = [];
  await bot.handleUpdate(text('камера облетает героя'));
  const tries = kie.filter((x) => x.u.includes('createTask'));
  ok('было две попытки createTask', tries.length === 2);
  ok('первая с image_urls', Array.isArray(tries[0]?.b.input.image_urls));
  ok('вторая с image_url', typeof tries[1]?.b.input.image_url === 'string' && !tries[1]?.b.input.image_urls);
  ok('видео доставлено', await settle(() => calls.some((x) => x.method === 'sendVideo')));

  // честная ошибка показывается пользователю
  mode = 'broken';
  await store.del('done:task_test');
  kie = [];
  calls = [];
  await bot.handleUpdate(text('ещё один дубль'));
  ok('ошибка KIE видна в чате', /not enough credits/.test(lastText(calls)));
  ok('нет молчаливого ретрая', kie.filter((x) => x.u.includes('createTask')).length === 1);
}

await store.del('u:42');
console.log(bad ? `\n${bad} проверок упало` : '\nвсё зелёное');
process.exit(bad ? 1 : 0);
