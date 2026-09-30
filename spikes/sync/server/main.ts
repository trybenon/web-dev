/**
 * Сервер спайка: статика + WebSocket-релей комнат.
 *
 * Запуск без сборки: `node server/main.ts` (Node ≥ 22.18 снимает типы сам).
 * Браузеру .ts-файлы отдаются после удаления типов (module.stripTypeScriptTypes),
 * поэтому клиент тоже работает без сборщика. В проекте это место займёт Vite.
 *
 * Для испытаний можно задать искусственную задержку конкретному клиенту:
 *   ws://host/ws?lagUp=60&lagDown=60   — симметричные 120 мс RTT
 *   ws://host/ws?lagUp=100&lagDown=0   — асимметрия (известное ограничение NTP)
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, type Outbound } from '../core/room.ts';
import { LIMITS, parseClientMessage, type ServerMessage } from '../shared/protocol.ts';

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIRS = ['client', 'core', 'shared', 'background'];

/** Серверные часы: монотонные, от старта процесса. */
const now = (): number => performance.now();

// ─── HTTP: статика ──────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
};

const tsCache = new Map<string, { mtime: number; code: string }>();

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  let path = url.pathname === '/' ? '/client/index.html' : decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  // Проверяем путь ПОСЛЕ нормализации и с разделителем: иначе «..%2F» после
  // декодирования уводит в соседнюю папку с тем же началом имени.
  const rel = relative(ROOT, file);
  const top = rel.split(sep)[0];
  if (rel.startsWith('..') || isAbsolute(rel) || !PUBLIC_DIRS.includes(top)) {
    res.writeHead(404).end();
    return;
  }
  let info;
  try {
    info = await stat(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  if (info.isDirectory()) {
    // «/background» → «/background/». Без этой ветки чтение папки роняло сервер (EISDIR).
    res.writeHead(301, { location: url.pathname + '/' }).end();
    return;
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const headers = { 'content-type': type, 'cache-control': 'no-store' };

  if (extname(file) === '.ts') {
    const cached = tsCache.get(file);
    let code = cached && cached.mtime === info.mtimeMs ? cached.code : null;
    if (code === null) {
      code = stripTypeScriptTypes(await readFile(file, 'utf8'), { mode: 'strip' });
      tsCache.set(file, { mtime: info.mtimeMs, code });
    }
    res.writeHead(200, headers).end(code);
    return;
  }

  // Поддержка Range обязательна для медиа: без неё перемотка в Chrome
  // и воспроизведение в Safari работают плохо или не работают.
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range && info.size > 0) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${info.size}`,
      'content-length': end - start + 1,
    });
    pipeFile(createReadStream(file, { start, end }), res);
    return;
  }
  res.writeHead(200, { ...headers, 'accept-ranges': 'bytes', 'content-length': info.size });
  pipeFile(createReadStream(file), res);
}

/** Ошибка чтения файла не должна ронять процесс: у потока обязателен обработчик error. */
function pipeFile(stream: ReturnType<typeof createReadStream>, res: ServerResponse): void {
  stream.on('error', (err) => {
    console.error(err);
    res.destroy();
  });
  stream.pipe(res);
}

const http = createServer((req, res) => {
  serveStatic(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

// ─── WebSocket ──────────────────────────────────────────────────────

interface Conn {
  peerId: string;
  ws: WebSocket;
  room: Room | null;
  alive: boolean;
  lagUp: number;
  lagDown: number;
}

const rooms = new Map<string, Room>();
const conns = new Map<string, Conn>();

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: LIMITS.maxMessageBytes });

function send(conn: Conn, msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  const deliver = (): void => {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(data);
  };
  if (conn.lagDown > 0) setTimeout(deliver, conn.lagDown);
  else deliver();
}

function dispatch(room: Room, out: Outbound[]): void {
  for (const o of out) {
    if (o.to === 'all') {
      for (const c of conns.values()) if (c.room === room && c.peerId !== o.except) send(c, o.msg);
    } else {
      const c = conns.get(o.to);
      if (c) send(c, o.msg);
    }
  }
}

function handle(conn: Conn, raw: string): void {
  const msg = parseClientMessage(raw);
  if (!msg) {
    send(conn, { type: 'error', code: 'bad_request', message: 'Некорректное сообщение' });
    return;
  }
  if (msg.type === 'sync:ping') {
    // t1 и t2 снимаются как можно ближе к приёму и отправке.
    const t1 = now();
    send(conn, { type: 'sync:pong', id: msg.id, t0: msg.t0, t1, t2: now() });
    return;
  }
  if (msg.type === 'room:join') {
    if (conn.room) return;
    let room = rooms.get(msg.roomId);
    if (!room) {
      room = new Room(msg.roomId);
      rooms.set(msg.roomId, room);
    }
    const out = room.join(conn.peerId, msg.name);
    if (!out.some((o) => o.msg.type === 'error')) conn.room = room;
    dispatch(room, out);
    return;
  }
  const room = conn.room;
  if (!room) {
    send(conn, { type: 'error', code: 'not_joined', message: 'Сначала войдите в комнату' });
    return;
  }
  if (msg.type === 'playback:intent') dispatch(room, room.intent(conn.peerId, msg.action, msg.positionMs, now()));
  else if (msg.type === 'presence:update') dispatch(room, room.presence(conn.peerId, msg.presence, now()));
}

wss.on('connection', (ws, req) => {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  const conn: Conn = {
    peerId: randomUUID().slice(0, 8),
    ws,
    room: null,
    alive: true,
    lagUp: Math.max(0, Number(q.get('lagUp') ?? 0)),
    lagDown: Math.max(0, Number(q.get('lagDown') ?? 0)),
  };
  conns.set(conn.peerId, conn);

  ws.on('pong', () => {
    conn.alive = true;
  });
  ws.on('message', (data) => {
    const text = data.toString();
    if (conn.lagUp > 0) setTimeout(() => handle(conn, text), conn.lagUp);
    else handle(conn, text);
  });
  ws.on('close', () => {
    conns.delete(conn.peerId);
    const room = conn.room;
    if (!room) return;
    dispatch(room, room.leave(conn.peerId, now()));
    if (room.size === 0) rooms.delete(room.id);
  });
});

// Пульс: без него «полуоткрытые» соединения висят вечно и держат барьер.
setInterval(() => {
  for (const c of conns.values()) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 15_000).unref();

// Дедлайн барьера и рассылка присутствия.
let ticks = 0;
setInterval(() => {
  ticks += 1;
  for (const room of rooms.values()) {
    dispatch(room, room.tick(now()));
    if (ticks % 10 === 0) dispatch(room, [room.presenceSync()]);
  }
}, 100).unref();

http.listen(PORT, () => {
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`LISTENING ${port}`);
  console.log(`Откройте http://localhost:${port}/?room=demo в двух вкладках`);
});
