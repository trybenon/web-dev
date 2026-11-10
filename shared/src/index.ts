export interface HealthResponse {
  status: "ok";
}

export * from "./monitoring.js";
export * from "./protocol/common.js";
export * from "./protocol/room.js";
export * from "./protocol/clock.js";
export * from "./protocol/playback.js";
export * from "./protocol/presence.js";
export * from "./protocol/source.js";
export * from "./protocol/error.js";
export * from "./protocol/messages.js";
export * from "./fixtures/messages.js";
