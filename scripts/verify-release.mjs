import { verifyArtifacts } from "./release-artifacts.mjs";

await verifyArtifacts(process.argv[2] ?? ".release", process.env.APP_RELEASE);
console.log("Release files and source maps match the prepared build");
