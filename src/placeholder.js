// Картинка-заглушка для сообщения «в процессе».
//
// Зачем: Telegram не умеет превращать текстовое сообщение в медиа, но умеет
// подменять медиа на медиа. Поэтому сообщение о ходе работы сразу отправляется
// картинкой — и потом обновляется на готовую, оставаясь на своём месте в чате.
//
// PNG собираем руками, чтобы не тащить зависимость: сплошная заливка сжимается
// в пару сотен байт.
import zlib from 'node:zlib';
import { InputFile } from 'grammy';
import * as store from './storage.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Однотонный PNG в оттенках серого. */
export function solidPng(width, height, gray = 0x1c) {
  const stride = width + 1; // байт фильтра на каждую строку
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    raw.fill(gray, y * stride + 1, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CACHE_KEY = (name) => `ph:${name}`;

/**
 * Отдаёт то, что можно передать в sendPhoto: сохранённый file_id, если заглушку
 * уже загружали, иначе свежий файл. Загружать её каждый раз незачем.
 *
 * Именно InputFile, а не голый Buffer: файлом grammy считает только его, буфер
 * молча уехал бы в JSON и Telegram отбил бы запрос.
 */
export async function placeholderMedia(name, make) {
  const cached = await store.get(CACHE_KEY(name));
  if (cached) return { media: cached, cached: true };
  return { media: new InputFile(make(), `${name}.png`), cached: false };
}

/** Запоминает file_id только что отправленной заглушки. */
export async function rememberPlaceholder(name, message) {
  const fileId = message?.photo?.at?.(-1)?.file_id;
  if (fileId) await store.set(CACHE_KEY(name), fileId);
}

// 21:9 — формат, в котором работает креатор.
export const wide = () => solidPng(1092, 468);
// 16:9 — под остальные модели.
export const standard = () => solidPng(1024, 576);
