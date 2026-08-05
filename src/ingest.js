// Файл из Telegram → файловое хранилище KIE, откуда его заберут модели.
import { uploadBuffer } from './kie.js';

export async function ingestFile(ctx) {
  const msg = ctx.message;
  let fileId;
  let kind;
  let name;
  let mime;

  if (msg.photo) {
    fileId = msg.photo.at(-1).file_id;
    kind = 'image';
    name = 'photo.jpg';
    mime = 'image/jpeg';
  } else if (msg.video) {
    fileId = msg.video.file_id;
    kind = 'video';
    name = msg.video.file_name || 'video.mp4';
    mime = msg.video.mime_type || 'video/mp4';
  } else if (msg.audio || msg.voice) {
    const f = msg.audio || msg.voice;
    fileId = f.file_id;
    kind = 'audio';
    name = f.file_name || (msg.voice ? 'voice.ogg' : 'audio.mp3');
    mime = f.mime_type || 'audio/mpeg';
  } else if (msg.document) {
    fileId = msg.document.file_id;
    mime = msg.document.mime_type || 'application/octet-stream';
    name = msg.document.file_name || 'file';
    kind = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';
  } else {
    throw new Error('Не понял, что это за файл');
  }

  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не смог скачать файл из Telegram (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const uploaded = await uploadBuffer(buf, name, mime);
  return { kind, url: uploaded, name };
}
