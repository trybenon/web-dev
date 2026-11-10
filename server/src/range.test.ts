import { describe, expect, it } from "vitest";
import { parseByteRange } from "./range.js";

describe("parseByteRange", () => {
  it.each([
    { header: "bytes=0-3", expected: { start: 0, end: 3 } },
    { header: "bytes=4-", expected: { start: 4, end: 9 } },
    { header: "bytes=-3", expected: { start: 7, end: 9 } },
    { header: "bytes=8-99", expected: { start: 8, end: 9 } },
    { header: "bytes=-99", expected: { start: 0, end: 9 } },
    { header: "bytes=0-0", expected: { start: 0, end: 0 } },
  ])("parses $header for a 10-byte file", ({ header, expected }) => {
    expect(parseByteRange(header, 10)).toEqual(expected);
  });

  it.each([
    "bytes=-",
    "bytes=8-3",
    "bytes=10-",
    "bytes=-0",
    "bytes=abc-def",
    "bytes=9007199254740992-",
  ])("rejects an invalid or unsatisfiable range: %s", (header) => {
    expect(parseByteRange(header, 10)).toBeNull();
  });

  it("cannot select bytes from an empty file", () => {
    expect(parseByteRange("bytes=0-", 0)).toBeNull();
  });
});
