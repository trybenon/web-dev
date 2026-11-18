import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const dsn = process.env.BUGSINK_DSN;
assert(dsn && !/[\s'\\]/u.test(dsn), "Set a valid Bugsink DSN");
const parsed = new URL(dsn);
assert(
  ["https:", "http:"].includes(parsed.protocol) &&
    parsed.username &&
    parsed.pathname !== "/",
  "Invalid Bugsink DSN",
);
// Single quotes keep Compose from interpolating a dollar sign in a DSN.
await writeFile(process.argv[2], `BUGSINK_DSN='${dsn}'\n`, { mode: 0o600 });
