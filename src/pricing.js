// Цены в кредитах, снятые с https://kie.ai/pricing (проверено 2026-08-05).
// KIE не отдаёт прайс по API, поэтому таблица локальная — если цифры разойдутся
// с реальным списанием, бот скажет об этом после генерации (там показывается факт).

export const PRICES = {
  'wan/3-0-video': { unit: 'second', wanRates: { '480P': 8, '720P': 16, '1080P': 32 } },
  // за картинку, одинаково для text-to-image и image-to-image
  'gpt-image-2-text-to-image': { unit: 'image', byResolution: { '1K': 6, '2K': 10, '4K': 16 } },
  'gpt-image-2-image-to-image': { unit: 'image', byResolution: { '1K': 6, '2K': 10, '4K': 16 } },

  // Nano Banana 2: 1K замерено живым запуском в CLI, 2K/4K — оценка.
  'nano-banana-2': { unit: 'image', byResolution: { '1K': 8, '2K': 12, '4K': 18 } },
  // Nano Banana Pro: оценка, после генерации бот покажет фактическое списание.
  'nano-banana-pro': { unit: 'image', byResolution: { '1K': 18, '2K': 18, '4K': 24 } },

  // Seedream 5.0 Pro: basic (1K) — 7.5, high (2K) — 14.5–15 по журналу задач CLI (KIE, 10.10.2026).
  'seedream/5-pro-text-to-image': { unit: 'image', byQuality: { basic: 7.5, high: 15 } },
  'seedream/5-pro-image-to-image': { unit: 'image', byQuality: { basic: 7.5, high: 15 } },

  // за ролик целиком
  'kling/v2-5-turbo-text-to-video-pro': { unit: 'video', byDuration: { 5: 42, 10: 84 } },
  'kling/v2-5-turbo-image-to-video-pro': { unit: 'video', byDuration: { 5: 42, 10: 84 } },

  // за секунду; с видео на входе ставка ниже, но считается (вход + выход)
  'bytedance/seedance-2': {
    unit: 'second',
    perSecond: {
      noVideo: { '480p': 19, '720p': 41, '1080p': 102, '4k': 208 },
      withVideo: { '480p': 11.5, '720p': 25, '1080p': 62, '4k': 128 },
    },
  },
};

/**
 * Прикидывает стоимость задачи.
 * @returns {{min:number, max:number, exact:boolean, note?:string}|null}
 *          null — модель не из нашей таблицы (например, задана через /model)
 */
export function estimate(model, input) {
  const p = PRICES[model];
  if (!p) return null;

  if (p.wanRates) {
    const rate = p.wanRates[input.resolution ?? '1080P'];
    const duration = Number(input.duration ?? 5);
    if (!rate || !Number.isInteger(duration) || (duration !== -1 && (duration < 2 || duration > 30))) return null;
    const hasVideo = !!input.reference_video_urls?.length;
    if (duration === -1) return { min: 2 * rate, max: 30 * rate, exact: false,
      note: `${rate} кред./с × (входное видео + автоматическая длительность результата); итог ≤30с, точная цена после генерации` };
    if (hasVideo) return { min: duration * rate, max: Math.min(30, duration + 15) * rate, exact: false,
      note: `${rate} кред./с × (входное видео + ${duration}с); длина входа уточняется KIE, суммарно ≤30с` };
    return { min: duration * rate, max: duration * rate, exact: true, note: `${rate} кред./с × ${duration}с` };
  }

  if (p.byResolution) {
    const res = input.resolution;
    if (res && p.byResolution[res] != null) {
      return { min: p.byResolution[res], max: p.byResolution[res], exact: true };
    }
    const vals = Object.values(p.byResolution);
    return {
      min: Math.min(...vals),
      max: Math.max(...vals),
      exact: false,
      note: 'resolution не задан — разрешение выберет модель',
    };
  }

  if (p.byQuality) {
    const q = input.quality ?? 'basic';
    const v = p.byQuality[q];
    if (v == null) return null;
    return q === 'basic'
      ? { min: v, max: v, exact: true }
      : { min: v, max: v, exact: false, note: 'high — по прошлым списаниям 14.5–15' };
  }

  if (p.byDuration) {
    const d = Number(input.duration ?? 5);
    const v = p.byDuration[d];
    if (v == null) return null;
    return { min: v, max: v, exact: true };
  }

  if (p.perSecond) {
    const res = input.resolution ?? '720p';
    const hasVideo = Array.isArray(input.reference_video_urls) && input.reference_video_urls.length > 0;
    const rate = p.perSecond[hasVideo ? 'withVideo' : 'noVideo'][res];
    if (rate == null) return null;
    const seconds = Number(input.duration ?? 5);
    const total = Math.round(rate * seconds * 100) / 100;
    if (hasVideo) {
      return {
        min: total,
        max: Infinity,
        exact: false,
        note: `${rate} кред./с × (длина входного видео + ${seconds}с) — вход тоже тарифицируется`,
      };
    }
    return { min: total, max: total, exact: true, note: `${rate} кред./с × ${seconds}с` };
  }

  return null;
}

export function formatEstimate(est) {
  if (!est) return 'неизвестно (модель не из прайс-листа)';
  const n = (v) => (Number.isInteger(v) ? String(v) : String(v));
  if (est.exact) return n(est.min);
  if (est.max === Infinity) return `от ${n(est.min)}`;
  return `${n(est.min)}–${n(est.max)}`;
}
