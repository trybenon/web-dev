import { readFile } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function serveStaticFile(
  pathname: string,
  directory: URL,
  response: ServerResponse,
) {
  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  if (decodedPath.includes("\0")) {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  if (decodedPath.split("/").includes("..")) {
    response.writeHead(403, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Forbidden");
    return;
  }
  const rootPath = fileURLToPath(directory);
  const filePath = resolve(rootPath, `.${decodedPath}`);
  const relativePath = relative(rootPath, filePath);

  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    isAbsolute(relativePath)
  ) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  readFile(filePath, (error, content) => {
    if (error) {
      const notFound =
        error.code === "ENOENT" ||
        error.code === "ENOTDIR" ||
        error.code === "EISDIR";

      response.writeHead(notFound ? 404 : 500);
      response.end(notFound ? "Not found" : "Internal server error");
      return;
    }

    const contentType =
      contentTypes[extname(filePath).toLowerCase()] ??
      "application/octet-stream";

    response.writeHead(200, {
      "Content-Type": contentType,
    });
    response.end(content);
  });
}
