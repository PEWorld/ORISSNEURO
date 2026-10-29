// Схемы моделей KIE AI: полный набор параметров каждой нейронки — ровно как в API.
// Каждый параметр описывается так, чтобы бот мог сам построить под него клавиатуру
// и провалидировать введённое значение.
//
// type: 'enum' | 'bool' | 'int' | 'float' | 'string'
// def === undefined  → поле не отправляется в API (используется дефолт модели)

import { wan } from './wan.js';

const AR_GPT = [
  'auto', '1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5',
  '16:9', '9:16', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21',
];

export const MODELS = {
  image: {
    label: 'GPT Image 2',
    emoji: '🖼',
    // Картинки отдаём файлом (документом), чтобы Telegram их не пережимал.
    resultKind: 'document',
    // Максимум вложений и что именно принимаем
    accepts: { image: 16, video: 0, audio: 0 },
    attachHint: 'Пришли до 16 картинок — включится image-to-image (input_urls).',
    params: [
      {
        key: 'aspect_ratio', type: 'enum', values: AR_GPT, def: 'auto',
        note: '1:1 нельзя апскейлить до 4K; у 5:4, 4:5, 3:1, 1:3, 9:21 нет 2K/4K.',
      },
      {
        key: 'resolution', type: 'enum', values: ['1K', '2K', '4K'], def: undefined,
        note: 'Не задано — решает модель.',
      },
    ],
    build(state) {
      const urls = state.attachments.filter((a) => a.kind === 'image').map((a) => a.url);
      const model = urls.length ? 'gpt-image-2-image-to-image' : 'gpt-image-2-text-to-image';
      const input = { prompt: state.prompt };
      if (urls.length) input.input_urls = urls.slice(0, 16);
      applyParams(this.params, state.params, input);
      return { model, input };
    },
  },

  kling: {
    label: 'Kling 2.5 Turbo Pro',
    emoji: '🎬',
    resultKind: 'video',
    accepts: { image: 1, video: 0, audio: 0 },
    attachHint: 'Пришли 1 картинку — переключится на image-to-video.',
    params: [
      { key: 'duration', type: 'enum', values: ['5', '10'], def: '5', note: 'Секунды.' },
      {
        key: 'aspect_ratio', type: 'enum', values: ['16:9', '9:16', '1:1'], def: '16:9',
        note: 'Только для text-to-video. При картинке на входе игнорируется.',
      },
      { key: 'sound', type: 'bool', def: false, note: 'Генерация звука.' },
      {
        key: 'cfg_scale', type: 'float', min: 0, max: 1, def: 0.5,
        note: 'Насколько жёстко держаться промпта. 0–1, шаг 0.1.',
      },
      {
        key: 'negative_prompt', type: 'string', maxLength: 500, def: undefined,
        note: 'Чего в кадре быть не должно.',
      },
    ],
    build(state) {
      const img = state.attachments.find((a) => a.kind === 'image');
      const model = img
        ? 'kling/v2-5-turbo-image-to-video-pro'
        : 'kling/v2-5-turbo-text-to-video-pro';
      const input = { prompt: state.prompt };
      if (img) input.image_urls = [img.url];
      applyParams(this.params, state.params, input);
      // aspect_ratio у image-to-video задаёт исходник, поле не нужно
      if (img) delete input.aspect_ratio;
      if (input.duration != null) input.duration = String(input.duration);
      return { model, input };
    },
  },

  seedance: {
    label: 'Seedance 2.0',
    emoji: '🌀',
    resultKind: 'video',
    accepts: { image: 9, video: 3, audio: 3 },
    attachHint:
      'Режим ref: до 9 картинок + до 3 видео + до 3 аудио как референсы.\n' +
      'Режим frames: 1-я картинка — первый кадр, 2-я — последний.',
    params: [
      {
        key: 'mode', type: 'enum', values: ['ref', 'frames'], def: 'ref', local: true,
        note: 'ref → reference_image/video/audio_urls. frames → first_frame_url + last_frame_url. ' +
          'В API это взаимоисключающие режимы.',
      },
      { key: 'duration', type: 'int', min: 4, max: 15, def: 15, note: 'Секунды, 4–15.' },
      { key: 'resolution', type: 'enum', values: ['480p', '720p', '1080p', '4k'], def: '720p' },
      {
        key: 'aspect_ratio', type: 'enum',
        values: ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9', 'adaptive'], def: '16:9',
      },
      { key: 'generate_audio', type: 'bool', def: false, note: 'В API дефолт true, тут выключено.' },
      { key: 'web_search', type: 'bool', def: undefined, note: 'Даёт модели искать референсы в вебе.' },
      { key: 'nsfw_checker', type: 'bool', def: false },
    ],
    build(state) {
      const input = { prompt: state.prompt };
      const imgs = state.attachments.filter((a) => a.kind === 'image').map((a) => a.url);
      const vids = state.attachments.filter((a) => a.kind === 'video').map((a) => a.url);
      const auds = state.attachments.filter((a) => a.kind === 'audio').map((a) => a.url);
      const mode = state.params.mode ?? 'ref';

      if (mode === 'frames') {
        if (imgs[0]) input.first_frame_url = imgs[0];
        if (imgs[1]) input.last_frame_url = imgs[1];
      } else {
        if (imgs.length) input.reference_image_urls = imgs.slice(0, 9);
        if (vids.length) input.reference_video_urls = vids.slice(0, 3);
        if (auds.length) input.reference_audio_urls = auds.slice(0, 3);
      }
      applyParams(this.params, state.params, input);
      return { model: 'bytedance/seedance-2', input };
    },
  },

  // Новые модели — только в конец: индекс модели зашит в callback_data кнопок.
  nb2: nanoBanana({ model: 'nano-banana-2', label: 'Nano Banana 2', emoji: '🍌', maxRefs: 14 }),
  nbpro: nanoBanana({ model: 'nano-banana-pro', label: 'Nano Banana Pro', emoji: '🍌', maxRefs: 8 }),

  // Seedream 5.0 Pro: t2i и i2i — разные model id, режим выбирается по наличию картинок.
  // Схема — docs.kie.ai/market/seedream/5-pro-*. nsfw_checker по умолчанию выключен.
  seedream: {
    label: 'Seedream 5.0 Pro',
    emoji: '🌱',
    resultKind: 'document',
    accepts: { image: 10, video: 0, audio: 0 },
    attachHint: 'Пришли до 10 картинок — включится image-to-image (image_urls).',
    params: [
      {
        key: 'aspect_ratio', type: 'enum',
        values: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9'], def: '3:4',
        note: 'В API обязательный, дефолт модели — 1:1.',
      },
      { key: 'quality', type: 'enum', values: ['basic', 'high'], def: 'basic', note: 'basic — 1K, high — 2K.' },
      { key: 'output_format', type: 'enum', values: ['png', 'jpeg'], def: 'png' },
      {
        key: 'nsfw_checker', type: 'bool', def: false,
        note: 'Фильтр KIE. Выключен — результат приходит без дополнительной фильтрации.',
      },
    ],
    build(state) {
      const urls = state.attachments.filter((a) => a.kind === 'image').map((a) => a.url);
      const model = urls.length ? 'seedream/5-pro-image-to-image' : 'seedream/5-pro-text-to-image';
      const input = { prompt: state.prompt };
      if (urls.length) input.image_urls = urls.slice(0, 10);
      applyParams(this.params, state.params, input);
      return { model, input };
    },
  },
  wan,
};

// Обе Nano Banana принимают одну и ту же схему; t2i и i2i — один model id,
// режим включается самим полем image_input.
function nanoBanana({ model, label, emoji, maxRefs }) {
  return {
    label,
    emoji,
    resultKind: 'document',
    accepts: { image: maxRefs, video: 0, audio: 0 },
    attachHint: `Пришли до ${maxRefs} картинок — они уйдут референсами (image_input).`,
    params: [
      {
        key: 'aspect_ratio', type: 'enum',
        values: ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
        def: 'auto',
      },
      { key: 'resolution', type: 'enum', values: ['1K', '2K', '4K'], def: '1K' },
      { key: 'output_format', type: 'enum', values: ['png', 'jpg'], def: 'png' },
    ],
    build(state) {
      const urls = state.attachments.filter((a) => a.kind === 'image').map((a) => a.url);
      const input = { prompt: state.prompt };
      if (urls.length) input.image_input = urls.slice(0, maxRefs);
      applyParams(this.params, state.params, input);
      return { model, input };
    },
  };
}

// Кладём в input всё, что реально задано (или имеет дефолт), кроме local-полей бота.
function applyParams(schema, values, input) {
  for (const p of schema) {
    if (p.local) continue;
    const v = values[p.key] !== undefined ? values[p.key] : p.def;
    if (v === undefined || v === null || v === '') continue;
    input[p.key] = v;
  }
}

export function defaultParams(modelKey) {
  const out = {};
  for (const p of MODELS[modelKey].params) {
    if (p.def !== undefined) out[p.key] = p.def;
  }
  return out;
}

export function findParam(modelKey, key) {
  return MODELS[modelKey].params.find((p) => p.key === key);
}

// Разбор значения из текста с валидацией по схеме. Бросает Error с понятным текстом.
export function coerce(param, raw) {
  const s = String(raw).trim();
  if (s === '-' || s.toLowerCase() === 'none' || s === '') return undefined; // сброс к дефолту модели
  switch (param.type) {
    case 'enum':
      if (!param.values.includes(s)) {
        throw new Error(`${param.key}: допустимо только ${param.values.join(', ')}`);
      }
      return s;
    case 'bool': {
      if (/^(1|true|on|да|yes|y)$/i.test(s)) return true;
      if (/^(0|false|off|нет|no|n)$/i.test(s)) return false;
      throw new Error(`${param.key}: нужно true или false`);
    }
    case 'int': {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new Error(`${param.key}: нужно целое число`);
      if (param.min != null && n < param.min) throw new Error(`${param.key}: минимум ${param.min}`);
      if (param.max != null && n > param.max) throw new Error(`${param.key}: максимум ${param.max}`);
      if (param.validate && !param.validate(n)) throw new Error(`${param.key}: ${param.note}`);
      return n;
    }
    case 'float': {
      const n = Number.parseFloat(s.replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error(`${param.key}: нужно число`);
      if (param.min != null && n < param.min) throw new Error(`${param.key}: минимум ${param.min}`);
      if (param.max != null && n > param.max) throw new Error(`${param.key}: максимум ${param.max}`);
      return n;
    }
    default: {
      if (param.maxLength && s.length > param.maxLength) {
        throw new Error(`${param.key}: максимум ${param.maxLength} символов`);
      }
      return s;
    }
  }
}

export function formatValue(param, values) {
  const v = values[param.key];
  if (v === undefined || v === null || v === '') {
    return param.def === undefined ? '—' : String(param.def);
  }
  if (typeof v === 'boolean') return v ? 'вкл' : 'выкл';
  return String(v);
}
