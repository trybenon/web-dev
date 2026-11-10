import { createReadStream, stat } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseByteRange } from "./range.js";

export function serveVideo(
  file: URL,
  request: IncomingMessage,
  response: ServerResponse,
) {
  stat(file, (error, information) => {
    if (error || !information.isFile()) {
      const notFound =
        !error || error.code === "ENOENT" || error.code === "ENOTDIR";

      response.writeHead(notFound ? 404 : 500);
      response.end(notFound ? "Not found" : "Internal server error");
      return;
    }

    const size = information.size;
    const rangeHeader = request.headers.range;

    const headers: Record<string, string | number> = {
      "Content-Type": "video/webm",
      "Accept-Ranges": "bytes",
    };

    let status = 200;
    let stream;

    if (rangeHeader !== undefined) {
      const range = parseByteRange(rangeHeader, size);

      if (range === null) {
        response.writeHead(416, {
          ...headers,
          "Content-Range": `bytes */${size}`,
        });
        response.end();
        return;
      }

      status = 206;
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
      headers["Content-Length"] = range.end - range.start + 1;

      stream = createReadStream(file, {
        start: range.start,
        end: range.end,
      });
    } else {
      headers["Content-Length"] = size;
      stream = createReadStream(file);
    }

    stream.once("error", () => {
      if (response.destroyed) {
        return;
      }

      if (response.headersSent) {
        response.destroy();
      } else {
        response.writeHead(500);
        response.end("Internal server error");
      }
    });

    response.once("close", () => {
      stream.destroy();
    });

    stream.once("open", () => {
      if (response.destroyed) {
        stream.destroy();
        return;
      }

      response.writeHead(status, headers);
      stream.pipe(response);
    });
  });
}
