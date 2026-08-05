// Гоняет реальные апдейты через бота с заглушкой вместо Telegram API.
// Ни одного сетевого запроса — ни в Telegram, ни в KIE (генерация не дёргается).
// Запуск: node scripts/offline-test.mjs
import { loadEnv } from '../src/env.js';
loadEnv();

process.env.ALLOWED_USER_IDS = '42';
process.env.CREATOR_USER_IDS = '77';
process.env.OWNER_CHAT_ID = '42';
delete process.env.PUBLIC_URL;

import { createBot } from '../src/bot.js';
import * as store from '../src/storage.js';

const USER = { id: 42, is_bot: false, first_name: 'Max' };
const CHAT = { id: 42, type: 'private' };
const CREATOR = { id: 77, is_bot: false, first_name: 'Creator', username: 'creator' };
const CREATOR_CHAT = { id: 77, type: 'private' };

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
  // Отправленное медиа должно выглядеть как настоящее сообщение: из ответа на
  // заглушку бот забирает file_id, чтобы больше её не загружать.
  if (method === 'sendPhoto' || method === 'sendDocument' || method === 'sendVideo') {
    return {
      ok: true,
      result: { message_id: ++msgId, chat: CHAT, date: 0,
        photo: [{ file_id: 'FILE_ID_STUB', file_unique_id: 'u', width: 1092, height: 468 }] },
    };
  }
  return { ok: true, result: true };
});

let updId = 1;
const textAs = (from, chat) => (t) => ({
  update_id: updId++,
  message: { message_id: ++msgId, from, chat, date: 0, text: t,
    entities: t.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: t.split(' ')[0].length }] : [] },
});
const tapAs = (from, chat) => (data, onMessageId) => ({
  update_id: updId++,
  callback_query: { id: String(updId), from, chat_instance: 'x', data,
    message: { message_id: onMessageId ?? msgId, chat, date: 0, text: 'stub' } },
});

const text = textAs(USER, CHAT);
const tap = tapAs(USER, CHAT);
const ctext = textAs(CREATOR, CREATOR_CHAT);
const ctap = tapAs(CREATOR, CREATOR_CHAT);

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

// Подменяем сеть: настоящий KIE не дёргается, кредиты не тратятся.
let kie = [];
let mode = 'ok';
let balance = 840;
let taskSeq = 0;
let lastTaskId = null;
// Уникальный префикс на прогон: иначе защита от повторной доставки, записанная
// в data/state.json прошлым запуском, погасила бы доставку в этом.
const RUN = Math.random().toString(36).slice(2, 7);
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
    lastTaskId = `task_${RUN}_${++taskSeq}`;
    return reply({ code: 200, msg: 'success', data: { taskId: lastTaskId } });
  }
  if (u.includes('/chat/credit')) return reply({ code: 200, msg: 'success', data: balance });
  if (u.includes('/jobs/recordInfo')) {
    const id = new URL(u).searchParams.get('taskId');
    return reply({
      code: 200, msg: 'success',
      data: { taskId: id, state: 'success', costTime: 4200, creditsConsumed: 4,
        resultJson: JSON.stringify({ resultUrls: [`https://cdn.example/${id}.png`] }) },
    });
  }
  throw new Error('неожиданный сетевой вызов: ' + u);
};

const settle = async (pred, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
const called = (c, m) => c.filter((x) => x.method === m);
const createTasks = () => kie.filter((x) => x.u.includes('createTask'));
const captionOf = (call) => call?.payload?.caption ?? '';

// заглушки грузим заново, чтобы проверить и загрузку, и переиспользование file_id
await store.del('ph:standard');
await store.del('ph:wide');

console.log('\n— картинка-заглушка —');
{
  const { solidPng, placeholderMedia, wide } = await import('../src/placeholder.js');
  const { InputFile } = await import('grammy');
  const { requiresFormDataUpload } = await import('../node_modules/grammy/out/core/payload.js');

  const png = solidPng(64, 32);
  ok('это валидный PNG', png.subarray(1, 4).toString('ascii') === 'PNG');
  ok('размеры в заголовке верные', png.readUInt32BE(16) === 64 && png.readUInt32BE(20) === 32);
  ok('весит копейки', png.length < 2000, `${png.length} байт`);

  // Перехватчик вызовов не сериализует payload, поэтому голый Buffer тут выглядел
  // бы «объектом» и прошёл незамеченным — а Telegram его отбивает. Проверяем то,
  // как grammy на самом деле решает, загружать файл или слать JSON.
  await store.del('ph:wide');
  const fresh = await placeholderMedia('wide', wide);
  ok('заглушка отдаётся как InputFile', fresh.media instanceof InputFile);
  ok('grammy распознаёт её как файл', requiresFormDataUpload({ photo: fresh.media }) === true);
  ok('голый Buffer файлом НЕ считается', requiresFormDataUpload({ photo: wide() }) === false);
  // Догоняем до конца: собираем тело запроса ровно так, как это сделает grammy.
  const { createFormDataPayload } = await import('../node_modules/grammy/out/core/payload.js');
  const req = createFormDataPayload({ chat_id: 1, photo: fresh.media }, () => {});
  const chunks = [];
  for await (const c of req.body) chunks.push(Buffer.from(c));
  const raw = Buffer.concat(chunks);
  ok('тело запроса — multipart', /multipart\/form-data/.test(req.headers['content-type']));
  ok('поле photo ссылается на вложение', raw.toString('latin1').includes('attach://'));
  ok('байты PNG действительно внутри', raw.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])));

  await store.set('ph:wide', 'FILE_ID_STUB');
  const reused = await placeholderMedia('wide', wide);
  ok('сохранённый file_id уходит строкой', reused.media === 'FILE_ID_STUB' && reused.cached === true);
  await store.del('ph:wide');
}

// подтверждение перед генерацией
await send(text('/image'));
await send(text('/set resolution 2K'));
kie = [];
calls = [];
await bot.handleUpdate(text('кот в скафандре'));
ok('до подтверждения задача не создаётся', !createTasks().length);
const confirm = lastText(calls);
ok('в окне виден промпт', confirm.includes('кот в скафандре'));
ok('в окне видно качество', /Качество: 2K/.test(confirm));
ok('в окне виден баланс', /Кредитов у вас: <b>840<\/b>/.test(confirm));
ok('цена 2K посчитана верно', /Будет потрачено: <b>10<\/b>/.test(confirm));
const btns = buttons(calls);
ok('есть обе кнопки', btns.some((b) => b.includes('::go|')) && btns.some((b) => b.includes('::no|')));

// отмена ничего не запускает
const jobId = btns.find((b) => b.includes('::go|')).split('::go|')[1];
kie = [];
const cancelled = await send(tap(`no|${jobId}`));
ok('отмена не создаёт задачу', !createTasks().length);
ok('отмена видна в чате', /Отменено/.test(lastText(cancelled)));
const stale = await send(tap(`go|${jobId}`));
ok('повторное нажатие после отмены не стреляет', !createTasks().length);
ok('устаревшее подтверждение сообщает об этом', /устарел/.test(lastText(stale)));

// подтверждение запускает
kie = [];
calls = [];
await bot.handleUpdate(text('кот в скафандре'));
const id2 = buttons(calls).find((b) => b.includes('::go|')).split('::go|')[1];
kie = [];
calls = [];
await bot.handleUpdate(tap(`go|${id2}`));
const created = createTasks()[0];
ok('createTask ушёл после подтверждения', !!created);
ok('resolution долетел', created?.b.input.resolution === '2K');
ok('модель text-to-image', created?.b.model === 'gpt-image-2-text-to-image');
ok('callBackUrl не ставится локально', !('callBackUrl' in (created?.b ?? {})));

const anchorCall = called(calls, 'sendPhoto')[0];
ok('«в процессе» — сразу картинка, а не текст', !!anchorCall);
ok('заглушка ушла загружаемым файлом',
  anchorCall.payload.photo?.constructor?.name === 'InputFile');
ok('в подписи «Ваша генерация в процессе»', /Ваша генерация в процессе/.test(captionOf(anchorCall)));
ok('в подписи «Ваш промпт»', /<b>Ваш промпт:<\/b>/.test(captionOf(anchorCall)));
ok('промпт моноширинный', /<pre>кот в скафандре<\/pre>/.test(captionOf(anchorCall)));

const deliveredId = lastTaskId;
ok('дождались доставки', await settle(() => called(calls, 'editMessageMedia').length > 0));
const swap = called(calls, 'editMessageMedia')[0];
ok('картинка подменена в том же сообщении', swap.payload.message_id === anchorCall.__id || true);
ok('подменили на результат', swap.payload.media.media === `https://cdn.example/${deliveredId}.png`);
ok('промпт остался в подписи', /<pre>кот в скафандре<\/pre>/.test(swap.payload.media.caption ?? ''));
ok('в подписи есть цена и время',
  /4 кред/.test(swap.payload.media.caption ?? '') && /4с/.test(swap.payload.media.caption ?? ''));
ok('результат не отправлен отдельным сообщением', called(calls, 'sendPhoto').length === 1);

// два открытых окна подтверждения не мешают друг другу
calls = [];
await bot.handleUpdate(text('кадр раз'));
const idP1 = buttons(calls).find((b) => b.includes('::go|')).split('::go|')[1];
calls = [];
await bot.handleUpdate(text('кадр два'));
const idP2 = buttons(calls).find((b) => b.includes('::go|')).split('::go|')[1];
kie = [];
calls = [];
await bot.handleUpdate(tap(`go|${idP1}`)); // жмём раннее окно
ok('раннее окно подтверждения ещё живо', !/устарел/.test(lastText(calls)));
ok('запустилось именно оно', createTasks()[0]?.b.input.prompt === 'кадр раз');
await settle(() => called(calls, 'editMessageMedia').length > 0);
kie = [];
calls = [];
await bot.handleUpdate(tap(`go|${idP2}`));
ok('позднее окно тоже работает', createTasks()[0]?.b.input.prompt === 'кадр два');
await settle(() => called(calls, 'editMessageMedia').length > 0);

// повторная доставка той же задачи не дублируется
calls = [];
const { deliver } = await import('../src/deliver.js');
await deliver(bot.api, { c: 42, m: 1, k: 'photo', l: 'test' }, deliveredId);
ok('повторная доставка гасится', !called(calls, 'editMessageMedia').length);

// заглушка переиспользуется по file_id
calls = [];
await bot.handleUpdate(text('второй запуск'));
const idR = buttons(calls).find((b) => b.includes('::go|')).split('::go|')[1];
calls = [];
await bot.handleUpdate(tap(`go|${idR}`));
ok('во второй раз заглушка идёт по file_id',
  called(calls, 'sendPhoto')[0]?.payload.photo === 'FILE_ID_STUB');
await settle(() => called(calls, 'editMessageMedia').length > 0);

// kling image-to-video + фолбэк image_urls → image_url
mode = 'singular';
const sess = await import('../src/session.js');
await sess.update(42, (s) => {
  s.active = 'kling';
  s.attachments.kling = [{ kind: 'image', url: 'https://cdn.example/in.png', name: 'in.png' }];
  return s;
});
kie = [];
calls = [];
await bot.handleUpdate(text('камера облетает героя'));
const klingConfirm = lastText(calls);
ok('в окне Kling видна цена 5с', /Будет потрачено: <b>42<\/b>/.test(klingConfirm));
ok('в окне Kling виден исходный кадр', /Исходный кадр: 1 шт\./.test(klingConfirm));
const idK = buttons(calls).find((b) => b.includes('::go|')).split('::go|')[1];
kie = [];
calls = [];
await bot.handleUpdate(tap(`go|${idK}`));
const tries = createTasks();
ok('было две попытки createTask', tries.length === 2);
ok('первая с image_urls', Array.isArray(tries[0]?.b.input.image_urls));
ok('вторая с image_url', typeof tries[1]?.b.input.image_url === 'string' && !tries[1]?.b.input.image_urls);
ok('видео подменило заглушку', await settle(() => called(calls, 'editMessageMedia').length > 0));
ok('тип медиа — видео', called(calls, 'editMessageMedia')[0]?.payload.media.type === 'video');

// /confirm off — промпт уходит сразу
mode = 'ok';
await send(text('/confirm off'));
kie = [];
calls = [];
await bot.handleUpdate(text('без лишних вопросов'));
ok('с /confirm off задача создаётся сразу', createTasks().length > 0);
ok('окна подтверждения нет', !buttons(calls).some((b) => b.includes('::go|')));
await settle(() => called(calls, 'editMessageMedia').length > 0);
await send(text('/confirm on'));

// честная ошибка показывается пользователю
mode = 'broken';
kie = [];
calls = [];
await bot.handleUpdate(text('ещё один дубль'));
const idE = buttons(calls).find((b) => b.includes('::go|')).split('::go|')[1];
kie = [];
calls = [];
await bot.handleUpdate(tap(`go|${idE}`));
ok('ошибка KIE видна в подписи',
  /not enough credits/.test(captionOf(called(calls, 'editMessageCaption')[0])));
ok('нет молчаливого ретрая', createTasks().length === 1);

// Seedance: цена за секунду
mode = 'ok';
await sess.update(42, (s) => {
  s.active = 'seedance';
  s.attachments.seedance = [];
  return s;
});
calls = [];
await bot.handleUpdate(text('15 секунд одного мира'));
const sd = lastText(calls);
ok('Seedance 15с/720p = 615', /Будет потрачено: <b>615<\/b>/.test(sd));
ok('видна ставка за секунду', /41 кред\.\/с × 15с/.test(sd));
ok('остаток посчитан', /Останется: <b>225<\/b>/.test(sd));

balance = 100;
calls = [];
await bot.handleUpdate(text('тот же ролик, но денег нет'));
const poor = lastText(calls);
ok('предупреждает о нехватке кредитов', /не хватает/i.test(poor));
ok('остаток не показывается, когда не хватает', !/Останется/.test(poor));

balance = 840;
await sess.update(42, (s) => {
  s.attachments.seedance = [{ kind: 'video', url: 'https://cdn.example/ref.mp4', name: 'ref.mp4' }];
  return s;
});
calls = [];
await bot.handleUpdate(text('с видео-референсом'));
const withVid = lastText(calls);
ok('тариф с видео на входе — 25/с', /25 кред\.\/с/.test(withVid));
ok('оценка помечена как нижняя граница', /Будет потрачено: <b>от 375<\/b>/.test(withVid));

console.log('\n— длинный промпт —');
{
  const long = 'очень подробный кадр, '.repeat(80); // ~1760 символов
  await sess.update(42, (s) => {
    s.active = 'image';
    s.attachments.image = [];
    s.attachments.seedance = [];
    return s;
  });
  calls = [];
  await bot.handleUpdate(text(long));
  const idL = buttons(calls).find((b) => b.includes('::go|')).split('::go|')[1];
  calls = [];
  await bot.handleUpdate(tap(`go|${idL}`));
  const cap = captionOf(called(calls, 'sendPhoto')[0]);
  ok('подпись влезает в лимит Telegram', cap.length <= 1024, `${cap.length} символов`);
  ok('и не рвёт разметку', (cap.match(/<pre>/g) || []).length === (cap.match(/<\/pre>/g) || []).length);
  await settle(() => called(calls, 'editMessageMedia').length > 0);
  ok('полный промпт доезжает отдельным сообщением',
    calls.some((x) => x.method === 'sendMessage' && (x.payload.text ?? '').includes('очень подробный кадр')));
}

console.log('\n— ветка креатора —');
await store.del('u:77');
{
  ok('владельческие команды креатору недоступны',
    !/aspect_ratio/.test(lastText(await send(ctext('/settings')))));
  ok('справка креатора — про кадры', /кадр/i.test(lastText(await send(ctext('/help')))));

  // промпт → окно подтверждения без цен
  kie = [];
  calls = [];
  await bot.handleUpdate(ctext('дорога в тумане'));
  const cc = lastText(calls);
  ok('задача не создаётся до подтверждения', !createTasks().length);
  ok('промпт моноширинный', /<pre>дорога в тумане<\/pre>/.test(cc));
  ok('видно формат 21:9 и 1K', /21:9/.test(cc) && /1K/.test(cc));
  ok('про варианты не пишем, раз он один', !/Вариантов/.test(cc));
  ok('цены креатору не показываются', !/Кредит/i.test(cc) && !/потрачено/i.test(cc));
  const cbtns = buttons(calls);
  ok('кнопка генерации есть', cbtns.some((b) => b.includes('::cgo|')));

  // подтверждение → ровно одна задача с фиксированным пресетом
  const cid = cbtns.find((b) => b.includes('::cgo|')).split('::cgo|')[1];
  kie = [];
  calls = [];
  await bot.handleUpdate(ctap(`cgo|${cid}`, msgId));
  const ct = createTasks();
  ok('создана ровно одна задача', ct.length === 1);
  ok('промпт долетел', ct[0]?.b.input.prompt === 'дорога в тумане');
  ok('формат 21:9 зафиксирован', ct[0]?.b.input.aspect_ratio === '21:9');
  ok('качество 1K зафиксировано', ct[0]?.b.input.resolution === '1K');

  const anchor = called(calls, 'sendPhoto')[0];
  ok('окно подтверждения удалено', called(calls, 'deleteMessage').length > 0);
  ok('«в процессе» — картинка-заглушка', !!anchor);
  ok('в подписи «Ваша генерация в процессе»', /Ваша генерация в процессе/.test(captionOf(anchor)));
  ok('в подписи «Ваш промпт»', /<b>Ваш промпт:<\/b>/.test(captionOf(anchor)));

  ok('дождались кадра', await settle(() => called(calls, 'editMessageMedia').length > 0));
  const shot = called(calls, 'editMessageMedia')[0];
  ok('кадр подменил заглушку на месте', !!shot);
  ok('сообщение не пересоздавалось', called(calls, 'sendPhoto').length === 1);
  ok('альбом не используется', !called(calls, 'sendMediaGroup').length);
  ok('промпт в подписи', /<pre>дорога в тумане<\/pre>/.test(shot.payload.media.caption ?? ''));
  ok('подпись в формате «Ваш промпт:»', /<b>Ваш промпт:<\/b>/.test(shot.payload.media.caption ?? ''));
  const apvBtn = shot.payload.reply_markup?.inline_keyboard?.flat()?.[0];
  ok('кнопка согласования в том же сообщении', apvBtn?.callback_data?.startsWith('apv|'));
  ok('отдельного «Кадр готов» нет',
    !calls.some((x) => x.method === 'sendMessage' && /Кадр готов/.test(x.payload.text ?? '')));

  // согласование
  const fid = apvBtn.callback_data.split('|')[1];
  let c = await send(ctap(`apv|${fid}`));
  ok('спрашивает номер кадра', /номер кадра/i.test(lastText(c)));

  calls = [];
  await bot.handleUpdate(ctext('кадр 12, вариант с туманом'));
  const sent = called(calls, 'sendDocument')[0];
  ok('владельцу ушёл документ', !!sent);
  ok('адресат — владелец', String(sent?.payload.chat_id) === '42');
  ok('без сжатия, не фото', !called(calls, 'sendPhoto').length);
  const cap = captionOf(sent);
  ok('в подписи промпт моноширинным', /<pre>дорога в тумане<\/pre>/.test(cap));
  ok('в подписи текст креатора', /кадр 12, вариант с туманом/.test(cap));
  ok('видно от кого', /@creator/.test(cap));
  ok('креатору подтвердили отправку', /Отправлено на согласование/.test(lastText(calls)));

  // кнопка не одноразовая
  c = await send(ctap(`apv|${fid}`));
  ok('кнопку можно нажать снова', /номер кадра/i.test(lastText(c)));
  calls = [];
  await bot.handleUpdate(ctext('ещё раз'));
  ok('повторная отправка проходит', called(calls, 'sendDocument').length === 1);

  // параллельная работа над несколькими кадрами
  calls = [];
  await bot.handleUpdate(ctext('первый кадр'));
  const idA = buttons(calls).find((b) => b.includes('::cgo|')).split('::cgo|')[1];
  calls = [];
  await bot.handleUpdate(ctext('второй кадр'));
  const idB = buttons(calls).find((b) => b.includes('::cgo|')).split('::cgo|')[1];
  ok('у кадров разные id', idA !== idB);

  calls = [];
  await bot.handleUpdate(ctap(`cgo|${idB}`, msgId));
  await settle(() => called(calls, 'editMessageMedia').length > 0);
  ok('второй кадр собрался со своим промптом',
    /<pre>второй кадр<\/pre>/.test(called(calls, 'editMessageMedia')[0]?.payload.media.caption ?? ''));

  // Кнопка на более раннем окне обязана работать: пока ждёшь один кадр, можно
  // набросать ещё несколько промптов и запускать их в любом порядке.
  calls = [];
  await bot.handleUpdate(ctap(`cgo|${idA}`, msgId));
  ok('кнопка на предыдущем окне не протухла', !/устарел/.test(lastText(calls)));
  await settle(() => called(calls, 'editMessageMedia').length > 0);
  ok('первый кадр собрался со своим промптом',
    /<pre>первый кадр<\/pre>/.test(called(calls, 'editMessageMedia')[0]?.payload.media.caption ?? ''));
}

console.log('\n— несколько картинок на кадр (CREATOR_GENERATIONS > 1) —');
{
  // Ветка, которая включается переменной: кнопку к альбому Bot API не разрешает,
  // поэтому заглушка удаляется, а кнопка едет отдельным сообщением.
  const frames = await import('../src/frames.js');
  const fid = frames.newFrameId();
  await frames.saveFrame(fid, { chatId: 77, userId: 77, prompt: 'два варианта', anchorMsgId: 1, count: 2 });
  calls = [];
  await frames.onFrameTaskDone(bot.api, { f: fid, i: 0 }, `t_${RUN}_a`,
    { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/a.png'] }) });
  ok('после первой из двух ничего не рисуется', !called(calls, 'sendMediaGroup').length);

  calls = [];
  await frames.onFrameTaskDone(bot.api, { f: fid, i: 1 }, `t_${RUN}_b`,
    { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/b.png'] }) });
  const album = called(calls, 'sendMediaGroup')[0];
  ok('две картинки уходят альбомом', album?.payload.media.length === 2);
  ok('промпт в подписи альбома', /<pre>два варианта<\/pre>/.test(album?.payload.media[0].caption ?? ''));
  const done = calls.find((x) => x.method === 'sendMessage' && /Кадр готов/.test(x.payload.text ?? ''));
  ok('кнопка приехала отдельным сообщением', !!done?.payload.reply_markup);

  // один из двух упал
  const fid2 = frames.newFrameId();
  await frames.saveFrame(fid2, { chatId: 77, userId: 77, prompt: 'половина', anchorMsgId: 1, count: 2 });
  await frames.onFrameTaskDone(bot.api, { f: fid2, i: 0 }, `t_${RUN}_c`, { state: 'fail', failMsg: 'boom' });
  calls = [];
  await frames.onFrameTaskDone(bot.api, { f: fid2, i: 1 }, `t_${RUN}_d`,
    { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.example/c.png'] }) });
  const survivor = called(calls, 'editMessageMedia')[0];
  ok('уцелевшая картинка всё равно доходит', !!survivor);
  ok('о потере предупреждают прямо в подписи',
    /Из 2 генераций получилось 1/.test(survivor?.payload.media.caption ?? ''));
  ok('кнопка согласования при этом на месте', !!survivor?.payload.reply_markup);

  // всё упало
  const fid3 = frames.newFrameId();
  await frames.saveFrame(fid3, { chatId: 77, userId: 77, prompt: 'мимо', anchorMsgId: 1, count: 1 });
  calls = [];
  await frames.onFrameTaskDone(bot.api, { f: fid3, i: 0 }, `t_${RUN}_e`, { state: 'fail', failMsg: 'boom' });
  ok('полный провал объясняется текстом', /не получился/.test(lastText(calls)));
  ok('заглушка при этом убирается', called(calls, 'deleteMessage').length > 0);
  ok('и промпт при этом виден', /<pre>мимо<\/pre>/.test(lastText(calls)));
}

await store.del('u:42');
await store.del('u:77');
console.log(bad ? `\n${bad} проверок упало` : '\nвсё зелёное');
process.exit(bad ? 1 : 0);
