import { writeFile } from "node:fs/promises";
import { validateDsn } from "./release-artifacts.mjs";

const dsn = validateDsn(process.env.BUGSINK_DSN);
// Single quotes keep Compose from interpolating a dollar sign in a DSN.
await writeFile(process.argv[2], `BUGSINK_DSN='${dsn}'\n`, { mode: 0o600 });
