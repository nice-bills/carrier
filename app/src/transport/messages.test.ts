import { describe, expect, it } from "vitest";
import { LIMITS, parseMessage } from "./messages";

const h = (c: string) => c.repeat(64);

describe("the hand message", () => {
  it("accepts a short list of note hashes, deduplicated", () => {
    expect(parseMessage({ kind: "hand", digests: [h("a"), h("a"), h("b")] })).toEqual({ kind: "hand", digests: [h("a"), h("b")] });
  });
  it("refuses empty, oversized or malformed lists", () => {
    expect(parseMessage({ kind: "hand", digests: [] })).toBeNull();
    expect(parseMessage({ kind: "hand", digests: Array.from({ length: LIMITS.maxHanded + 1 }, (_, i) => i.toString(16).padStart(64, "0")) })).toBeNull();
    expect(parseMessage({ kind: "hand", digests: ["not a hash"] })).toBeNull();
    expect(parseMessage({ kind: "hand" })).toBeNull();
  });
});
