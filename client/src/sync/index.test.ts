import { describe, expect, it } from "vitest";
import {
  createPlayerBridge,
  createStubPlayerBridge,
  createStubSyncClient,
  createSyncClient,
} from "./index";

describe("точка входа", () => {
  it("createSyncClient и createPlayerBridge — настоящие, заглушки отдельно", () => {
    expect(createSyncClient).not.toBe(createStubSyncClient);
    expect(createPlayerBridge).not.toBe(createStubPlayerBridge);
  });
});
