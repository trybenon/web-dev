import { createAppServer } from "./app.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3000");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT должен быть целым числом от 1 до 65535");
}

const server = createAppServer();

server.listen(port, host, () => {
  console.log(`Server: http://${host}:${port}`);
});
