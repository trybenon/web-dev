import { describe, expect, it } from "vitest";
import {
  createPlayerBridge,
  createStubPlayerBridge,
  createStubSyncClient,
  createSyncClient,
} from "./index";

describe("точка входа", () => {
  it("пока воркера нет, createSyncClient — это заглушка", () => {
    expect(createSyncClient).toBe(createStubSyncClient);
    expect(createPlayerBridge).toBe(createStubPlayerBridge);
  });
});
