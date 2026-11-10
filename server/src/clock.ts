import { performance } from "node:perf_hooks";

export const serverNow = (): number => performance.now();
