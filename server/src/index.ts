import { createAppServer } from "./app.js";
import * as Sentry from "@sentry/node";
import { sanitizeErrorEvent } from "@watch-together/shared";

const dsn = process.env.BUGSINK_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.APP_RELEASE,
    sendDefaultPii: false,
    beforeSend: sanitizeErrorEvent,
  });
}

const server = createAppServer();

server.listen(3000, "127.0.0.1", () => {
  console.log("Server: http://127.0.0.1:3000");
});
