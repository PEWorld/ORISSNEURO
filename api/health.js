import { MODELS } from '../src/models.js';
import { json } from '../src/http.js';

export default function handler(_req, res) {
  json(res, 200, { ok: true, revision: process.env.VERCEL_GIT_COMMIT_SHA || null, models: Object.keys(MODELS) });
}
