// Мелочи для serverless-ручек. Не полагаемся на хелперы Vercel (req.query /
// res.status / res.json) — они могут быть отключены, а руками это три строки.

export function query(req) {
  if (req.query) return req.query;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return Object.fromEntries(url.searchParams);
}

export async function body(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body);
      } catch {
        return {};
      }
    }
    if (Buffer.isBuffer(req.body)) {
      try {
        return JSON.parse(req.body.toString('utf8'));
      } catch {
        return {};
      }
    }
    return req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
