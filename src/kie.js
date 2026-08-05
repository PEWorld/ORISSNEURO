// Клиент KIE AI API. Ровно те же эндпоинты, что у kie-tools/kie.mjs.
const API_BASE = 'https://api.kie.ai';
const UPLOAD_BASE = 'https://kieai.redpandaai.co';

function key() {
  const k = process.env.KIE_API_KEY;
  if (!k) throw new Error('KIE_API_KEY не задан');
  return k;
}

async function apiFetch(url, options = {}) {
  const isForm = options.body instanceof FormData;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(options.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`KIE вернул не JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || (json.code && json.code !== 200)) {
    throw new Error(`KIE ${json.code ?? res.status}: ${json.msg ?? json.message ?? res.statusText}`);
  }
  return json;
}

export async function createTask(model, input, callBackUrl) {
  const body = { model, input };
  if (callBackUrl) body.callBackUrl = callBackUrl;
  const json = await apiFetch(`${API_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return json.data.taskId;
}

export async function getTask(taskId) {
  const json = await apiFetch(
    `${API_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`
  );
  return json.data;
}

export async function getCredits() {
  const json = await apiFetch(`${API_BASE}/api/v1/chat/credit`);
  return json.data;
}

// Заливает буфер в файловое хранилище KIE и отдаёт публичный URL.
export async function uploadBuffer(buf, fileName, mime) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime || 'application/octet-stream' }), fileName);
  form.append('uploadPath', 'kie-bot');
  const res = await fetch(`${UPLOAD_BASE}/api/file-stream-upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Загрузка файла не удалась: ${json.msg ?? res.status}`);
  return json.data.downloadUrl;
}

// Достаёт ссылки на результат из resultJson независимо от формы ответа модели.
export function resultUrls(data) {
  if (!data?.resultJson) return [];
  let parsed;
  try {
    parsed = typeof data.resultJson === 'string' ? JSON.parse(data.resultJson) : data.resultJson;
  } catch {
    return [];
  }
  const urls = parsed.resultUrls ?? parsed.result_urls ?? [];
  return Array.isArray(urls) ? urls.filter(Boolean) : [];
}

export const TERMINAL = new Set(['success', 'fail']);

// Локальный режим: ждём завершения опросом. На Vercel вместо этого работает callBackUrl.
export async function waitForTask(taskId, { intervalMs = 5000, timeoutMs = 20 * 60 * 1000 } = {}) {
  const start = Date.now();
  let errors = 0;
  for (;;) {
    let data;
    try {
      data = await getTask(taskId);
      errors = 0;
    } catch (err) {
      if (++errors > 10) throw new Error(`Опрос статуса падает подряд: ${err.message}`);
      data = null;
    }
    if (data && TERMINAL.has(data.state)) return data;
    if (Date.now() - start > timeoutMs) throw new Error('Таймаут ожидания результата (20 мин)');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
