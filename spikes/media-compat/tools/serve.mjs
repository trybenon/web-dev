// Статический сервер прототипа: public/ и samples/ на http://localhost:8790.
// localhost — «безопасный контекст», поэтому OPFS и WebCodecs работают без HTTPS.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 8790);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const top = path.startsWith('/samples/') ? 'samples' : 'public';
  const file = normalize(join(ROOT, top, path.replace(/^\/samples\//, '/')));
  const rel = relative(join(ROOT, top), file);
  if (rel.startsWith('..') || rel.split(sep)[0] === '..') return void res.writeHead(404).end();
  let info;
  try {
    info = await stat(file);
  } catch {
    return void res.writeHead(404).end();
  }
  if (!info.isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': info.size, 'cache-control': 'no-store' });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
});
server.listen(PORT, () => {
  const port = server.address().port;
  console.log(`LISTENING ${port}`);
  console.log(`Прототип:        http://localhost:${port}/`);
  console.log(`Таблица кодеков: http://localhost:${port}/check.html`);
});
