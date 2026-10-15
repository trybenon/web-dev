import { createServer } from "node:http";
import type { HealthResponse } from "@watch-together/shared";

export function createAppServer() {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/health") {
      const body: HealthResponse = { status: "ok" };

      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
      return;
    }

    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Not found");
  });
}
