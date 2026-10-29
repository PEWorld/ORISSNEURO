// KIE contract and prices verified 2026-10-29:
// https://docs.kie.ai/market/wan/3-0-video
// https://kie.ai/wan3.0-video
export const wan = {
  label: 'WAN 3.0', emoji: '🌊', resultKind: 'video',
  accepts: { image: 10, video: 5, audio: 5, file: 1 },
  attachHint: 'ref: до 10 картинок, 5 видео и 5 аудио (видео/аудио суммарно до 15с каждый тип). frames: 1–2 картинки — первый/последний кадр. Можно приложить документ или задать ссылку на страницу.',
  priceHint: '480P: 8 кред./с ($0.04); 720P: 16 ($0.08); 1080P: 32 ($0.16). Цена = (входное видео + результат) × ставка. duration=-1: итоговая длина и цена определяются моделью.',
  params: [
    { key: 'mode', type: 'enum', values: ['ref', 'frames'], def: 'ref', local: true, note: 'ref — референсы Image1/Video1/Audio1. frames — первый и последний кадр; несовместим с референсами.' },
    { key: 'resolution', type: 'enum', values: ['480P', '720P', '1080P'], def: '480P', note: '8 / 16 / 32 кредита в секунду. Дефолт бота 480P, API — 1080P.' },
    { key: 'aspect_ratio', type: 'enum', values: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'], def: 'adaptive' },
    { key: 'duration', type: 'int', min: -1, max: 30, def: 5, validate: n => n === -1 || n >= 2, note: '2–30с или -1 (автоматически). Входное видео + результат ≤30с.' },
    { key: 'audio', type: 'bool', def: true, note: 'Звуковая дорожка результата.' },
    { key: 'seed', type: 'int', min: 0, max: 2147483647, def: undefined, note: 'Не задан — случайный seed.' },
    { key: 'nsfw_checker', type: 'bool', def: false },
    { key: 'reference_link_urls', type: 'string', local: true, def: undefined, note: 'Один публичный URL страницы без авторизации. Несовместим с документом и frames.' },
    { key: 'reference_file_urls', type: 'string', local: true, def: undefined, note: 'Один публичный URL документа или приложи файл в чат. DOC(X), XLS(X), PPT(X), PDF, TXT, KEY, PAGES, NUMBERS, MD; ≤100MB и ≤50 страниц. Несовместим со ссылкой и frames.' },
  ],
  build(state) {
    const input = { prompt: state.prompt };
    for (const p of this.params) {
      if (p.local) continue;
      const v = state.params[p.key] ?? p.def;
      if (v !== undefined) input[p.key] = v;
    }
    const of = kind => state.attachments.filter(a => a.kind === kind);
    for (const [kind, limit] of Object.entries(this.accepts)) {
      if (of(kind).length > limit) throw new Error(`WAN: максимум ${limit} ${kind}`);
      for (const att of of(kind)) {
        const maxMB = { image: 20, video: 100, audio: 15, file: 100 }[kind];
        if (att.size > maxMB * 1024 * 1024) throw new Error(`WAN ${kind}: максимум ${maxMB}MB.`);
        const formats = { image: /\.(jpe?g|png|bmp|webp)$/i, video: /\.(mp4|mov)$/i, audio: /\.(mp3|wav)$/i, file: /\.(docx?|xlsx?|pptx?|pdf|txt|key|pages|numbers|md)$/i };
        if (att.name && !formats[kind].test(att.name)) throw new Error(`WAN: неподдерживаемый формат ${att.name}. Аудио — MP3/WAV, видео — MP4/MOV. Голосовое OGG сначала преобразуй в MP3/WAV.`);
      }
    }
    const imgs = of('image').map(a => a.url);
    const files = of('file').map(a => a.url);
    if (state.params.mode === 'frames') {
      if (!imgs.length || imgs.length > 2 || of('video').length || of('audio').length || files.length || state.params.reference_file_urls || state.params.reference_link_urls) {
        throw new Error('WAN frames: нужны только 1–2 картинки. Убери остальные вложения и ссылки (/clear).');
      }
      input.first_frame_url = imgs[0];
      if (imgs[1]) input.last_frame_url = imgs[1];
    } else {
      for (const kind of ['image', 'video', 'audio']) {
        const urls = of(kind).map(a => a.url);
        if (urls.length) input[`reference_${kind}_urls`] = urls;
      }
      for (const key of ['reference_file_urls', 'reference_link_urls']) {
        const value = state.params[key];
        if (value) {
          let url;
          try { url = new URL(value); } catch { throw new Error(`${key}: нужен один публичный HTTP(S) URL`); }
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(`${key}: нужен публичный HTTP(S) URL`);
          input[key] = [value];
        }
      }
      if (files.length) {
        if (input.reference_file_urls) throw new Error('WAN: выбери один документ — вложение или URL.');
        input.reference_file_urls = files;
      }
      if (input.reference_file_urls && input.reference_link_urls) throw new Error('WAN: документ и ссылка на страницу несовместимы.');
    }
    validateWan(input);
    for (const kind of ['video', 'audio']) {
      const refs = of(kind);
      const known = refs.filter(a => Number.isFinite(a.duration));
      const seconds = known.reduce((n, a) => n + a.duration, 0);
      if (known.some(a => a.duration < 1 || a.duration > 15) || seconds > 15) throw new Error(`WAN: ${kind} — каждый клип 1–15с, суммарно ≤15с.`);
      if (kind === 'video' && input.duration !== -1 && seconds + input.duration > 30) throw new Error('WAN: входное видео + результат должны быть ≤30с.');
    }
    return { model: 'wan/3-0-video', input };
  },
};

export function validateWan(input) {
  if (String(input.prompt ?? '').length > 20000) throw new Error('WAN: промпт максимум 20000 символов.');
  if (!Number.isInteger(input.duration) || (input.duration !== -1 && (input.duration < 2 || input.duration > 30))) throw new Error('WAN duration: 2–30 или -1.');
  if (!wan.params[1].values.includes(input.resolution)) throw new Error('WAN resolution: 480P, 720P или 1080P.');
  if (!wan.params[2].values.includes(input.aspect_ratio)) throw new Error('WAN: недопустимое соотношение сторон.');
  if (typeof input.audio !== 'boolean' || (input.nsfw_checker != null && typeof input.nsfw_checker !== 'boolean')) throw new Error('WAN: audio/nsfw_checker — true или false.');
  if (input.seed != null && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 2147483647)) throw new Error('WAN seed: целое 0–2147483647.');
  const refs = ['image', 'video', 'audio', 'file', 'link'].map(k => `reference_${k}_urls`);
  for (const [i, key] of refs.entries()) {
    if (input[key] != null && (!Array.isArray(input[key]) || input[key].length > [10, 5, 5, 1, 1][i])) throw new Error(`WAN: неверное число ${key}.`);
  }
  if ((input.first_frame_url || input.last_frame_url) && refs.some(k => input[k]?.length)) throw new Error('WAN: frames и reference_* несовместимы.');
  if (input.last_frame_url && !input.first_frame_url) throw new Error('WAN: последний кадр требует первый.');
  if (input.reference_file_urls?.length && input.reference_link_urls?.length) throw new Error('WAN: документ и ссылка несовместимы.');
}
