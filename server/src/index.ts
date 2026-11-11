import { RoomService } from "./room-service.js";
import { attachWebSocketGateway } from "./ws-gateway.js";
import { createAppServer } from "./app.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3000");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT должен быть целым числом от 1 до 65535");
}

const server = createAppServer();
const rooms = new RoomService();

attachWebSocketGateway(server, {
  onMessage: rooms.onMessage,
  onClose: rooms.onClose,
});

const roomTick = setInterval(() => {
  rooms.tick();
}, 100);

const presenceSync = setInterval(() => {
  rooms.syncPresence();
}, 1_000);

roomTick.unref();
presenceSync.unref();

server.once("close", () => {
  clearInterval(roomTick);
  clearInterval(presenceSync);
  rooms.dispose();
});

server.listen(port, host, () => {
  console.log(`Server: http://${host}:${port}`);
});
