import { createAppServer } from "./app.js";

const server = createAppServer();

server.listen(3000, "127.0.0.1", () => {
  console.log("Server: http://127.0.0.1:3000");
});
