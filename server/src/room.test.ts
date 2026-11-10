import { describe, expect, it } from "vitest";
import { Room } from "./room.js";

describe("Room: начальное состояние", () => {
  it("новая комната на паузе в начале, якорь - момент создания", () => {
    const room = new Room("r", 1_000);
    expect(room.playback).toEqual({
      rev: 0,
      status: 'paused',
      positionMS: 0,
      anchorServerTime: 1_000,
      rate: 1,
      setBy: null,
    });
  });
  it("playback отдает копию, снаружи состояние не поменять", () => {
    const room = new Room("r", 0);
    room.playback.positionMs = 99;
    expect(room.playback.positionMs).toBe(0);
  });
  it("на паузе позиция стоит", () => {
    expect(new Room("r", 0).positionAt(60_000)).toBe(0);
  });
});