import { extname } from "node:path";
import { serveVideo } from "./video.js";
import { serveStaticFile } from "./static.js";
import { readFile } from "node:fs";
import { createServer } from "node:http";
import type { HealthResponse } from "@watch-together/shared";

const defaultIndexFile = new URL(
  "../../client/dist/index.html",
  import.meta.url,
);

export function createAppServer(indexFile: URL = defaultIndexFile) {
  return createServer((request, response) => {
    const pathname = (request.url ?? "/").split("?")[0];
    const reservedPath = ["/api", "/assets", "/media"].some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );

    const wantsHtml = request.headers.accept?.includes("text/html") ?? false;

    const useHtmlFallback =
      wantsHtml && !reservedPath && extname(pathname) === "";
    if (request.method === "GET" && pathname === "/api/health") {
      const body: HealthResponse = { status: "ok" };

      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(body));
      return;
    }

    if (request.method === "GET" && (pathname === "/" || useHtmlFallback)) {
      readFile(indexFile, (error, content) => {
        if (error) {
          const status = error.code === "ENOENT" ? 404 : 500;

          response.writeHead(status, {
            "Content-Type": "text/plain; charset=utf-8",
          });
          response.end(
            status === 404 ? "Client build not found" : "Internal server error",
          );
          return;
        }

        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(content);
      });
      return;
    }
    if (
      request.method === "GET" &&
      (pathname.startsWith("/assets/") ||
        pathname === "/favicon.svg" ||
        pathname === "/icons.svg")
    ) {
      serveStaticFile(pathname, new URL("./", indexFile), response);
      return;
    }
    if (request.method === "GET" && pathname === "/media/demo.webm") {
      const videoFile = new URL("./media/demo.webm", indexFile);

      serveVideo(videoFile, request, response);
      return;
    }
    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Not found");
  });
}
