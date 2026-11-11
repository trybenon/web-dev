/**
 * Воркер синхронизации: здесь живут WebSocket, часы и состояние комнаты.
 * В фоновой вкладке таймеры воркера не замедляются (decisions.md, 4.1),
 * поэтому пинги и отчёты о готовности идут вовремя.
 *
 * Вся логика — в SyncEngine; здесь только связь с сокетом и страницей.
 */
import { SyncEngine } from "./engine";
import type { FromWorker, ToWorker } from "./worker-protocol";

// в типах DOM у self нет postMessage воркера, поэтому описываем сами
const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  close(): void;
  navigator: { userAgent: string };
};

const engine = new SyncEngine({
  post: (message) => scope.postMessage(message),
  openSocket(url, events) {
    const socket = new WebSocket(url);
    socket.onopen = () => events.onOpen();
    socket.onmessage = (event) => events.onMessage(String(event.data));
    socket.onclose = (event) => events.onClose(event.code);
    return {
      send: (data) => socket.send(data),
      close: () => socket.close(),
    };
  },
  userAgent: scope.navigator.userAgent,
});

scope.onmessage = (event) => {
  engine.handle(event.data);
  if (event.data.type === "dispose") scope.close();
};
