// Мини-загрузчик .env, чтобы не тащить зависимость. На Vercel переменные уже в окружении.
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv() {
  for (const name of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v !== '') process.env[m[1]] ||= v;
    }
  }
}
