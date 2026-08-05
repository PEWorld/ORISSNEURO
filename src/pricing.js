// Цены в кредитах, снятые с https://kie.ai/pricing (проверено 2026-08-05).
// KIE не отдаёт прайс по API, поэтому таблица локальная — если цифры разойдутся
// с реальным списанием, бот скажет об этом после генерации (там показывается факт).

export const PRICES = {
  // за картинку, одинаково для text-to-image и image-to-image
  'gpt-image-2-text-to-image': { unit: 'image', byResolution: { '1K': 6, '2K': 10, '4K': 16 } },
  'gpt-image-2-image-to-image': { unit: 'image', byResolution: { '1K': 6, '2K': 10, '4K': 16 } },

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
