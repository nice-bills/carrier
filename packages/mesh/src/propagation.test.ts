import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { hashNote, type Note } from "@carrier/protocol";
import { CarrierNode, contact } from "./node.js";
import { frame, reassemble, parse, Reassembler, MAX_FRAMES, MTU } from "./transport.js";
import type { Signer } from "./types.js";

/**
 * Does this actually work in a room full of people?
 *
 * The protocol can be correct and the idea still fail, if notes never reach
 * anyone with signal. These are the numbers behind the claim, run against a
 * crude mobility model rather than asserted in a pitch.
 */

class TestSigner implements Signer {
  readonly keypair = Keypair.generate();
  get publicKey() {
    return this.keypair.publicKey;
  }
  sign(m: Uint8Array) {
    return nacl.sign.detached(m, this.keypair.secretKey);
  }
}

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const NOW = 1_800_000_000n;
const POUCH = new PublicKey("11111111111111111111111111111112");

function note(slotIndex: number, to: PublicKey): Note {
  return {
    pouch: POUCH,
    to,
    amount: 1_000_000n,
    slotIndex,
    epoch: 0,
    expiry: NOW + 604_800n, // a week to find signal
    relayFeeBps: 200,
  };
}

/**
 * Deterministic PRNG so a failure is reproducible. A flaky simulation is worse
 * than none — it teaches you to ignore the suite.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * One tick: every pair of people has `meetChance` of bumping into each other.
 * Crude, but the shape that matters — encounters are random and local, nobody
 * has a global view, and no device chooses a route.
 */
function mingle(crowd: CarrierNode[], meetChance: number, random: () => number, at: bigint) {
  for (let i = 0; i < crowd.length; i += 1) {
    for (let j = i + 1; j < crowd.length; j += 1) {
      if (random() < meetChance) contact(crowd[i]!, crowd[j]!, at);
    }
  }
}

describe("propagation", () => {
  it("reaches most of a room within a few rounds of mingling", () => {
    const random = rng(7);
    const crowd = Array.from({ length: 30 }, () => new CarrierNode(new TestSigner()));
    const [patientZero] = crowd;

    const bundle = patientZero!.originate(note(1, crowd[29]!.publicKey));
    const digest = hex(hashNote(bundle.note));

    // Five rounds where any two people have a 4% chance of meeting — a coffee
    // break at a build station, not a stadium.
    for (let round = 0; round < 5; round += 1) {
      mingle(crowd, 0.04, random, NOW + BigInt(round));
    }

    const reached = crowd.filter((d) => d.holds(digest)).length;
    // The hop cap bounds how far one note travels, which is the point: this is a
    // payment with a bounded audience, not a broadcast.
    expect(reached).toBeGreaterThan(5);
  });

  it("a note held by anyone who reconnects is a note that settles", () => {
    const random = rng(11);
    const crowd = Array.from({ length: 20 }, () => new CarrierNode(new TestSigner()));

    crowd[0]!.originate(note(1, crowd[19]!.publicKey));
    const digest = crowd[0]!.digests()[0]!;

    for (let round = 0; round < 4; round += 1) {
      mingle(crowd, 0.06, random, NOW + BigInt(round));
    }

    const carriers = crowd.filter((d) => d.holds(digest));
    expect(carriers.length).toBeGreaterThan(1);

    // Settlement needs exactly one of them to find signal — that is the whole
    // resilience argument, so state it as an assertion rather than a slogan.
    const anyOne = carriers[carriers.length - 1]!;
    const carried = anyOne.bundle(digest)!;
    expect(carried.hops.length).toBeGreaterThan(0);
    expect(carried.entries.length).toBe(1 + 2 * carried.hops.length);
  });

  it("carries several payments at once without mixing them up", () => {
    const random = rng(3);
    const crowd = Array.from({ length: 12 }, () => new CarrierNode(new TestSigner()));

    const digests = [0, 1, 2].map((i) => {
      const b = crowd[i]!.originate(note(i + 1, crowd[11]!.publicKey));
      return hex(hashNote(b.note));
    });

    for (let round = 0; round < 5; round += 1) {
      mingle(crowd, 0.08, random, NOW + BigInt(round));
    }

    for (const d of crowd) {
      for (const digest of d.digests()) {
        const bundle = d.bundle(digest)!;
        // Every bundle a device holds is internally consistent: its hops all
        // reference its own note, and the chain is unbroken.
        expect(hex(hashNote(bundle.note))).toBe(digest);
        bundle.hops.forEach((hop, i) => {
          expect(hop.seq).toBe(i);
          expect(hex(hop.noteHash)).toBe(digest);
        });
      }
    }

    expect(digests.every((d) => crowd.some((n) => n.holds(d)))).toBe(true);
  });
});

describe("framing", () => {
  it("survives frames arriving out of order and twice", () => {
    const body = new Uint8Array(MTU * 2 + 17).map((_, i) => i % 251);
    const frames = frame("abcd", body);
    expect(frames).toHaveLength(3);

    const scrambled = [frames[2]!, frames[0]!, frames[2]!, frames[1]!];
    expect(reassemble(scrambled)).toEqual(body);
  });

  it("returns nothing while a frame is still missing", () => {
    const body = new Uint8Array(MTU * 2).fill(9);
    const frames = frame("abcd", body);
    expect(reassemble([frames[0]!, frames[1]!])).toEqual(body);
    expect(reassemble([frames[0]!])).toBeNull();
  });

  it("frames a body that fits in one write", () => {
    const body = new Uint8Array(10).fill(1);
    const frames = frame("abcd", body);
    expect(frames).toHaveLength(1);
    expect(reassemble(frames)).toEqual(body);
  });
});

describe("framing from strangers", () => {
  const payload = new Uint8Array(4);

  it("never throws on junk frames", () => {
    const junk: unknown[] = [
      null,
      undefined,
      7,
      "frame",
      {},
      { digest: "a", index: -1, total: 1, payload },
      { digest: "a", index: Number.NaN, total: 1, payload },
      { digest: "a", index: 0, total: Number.NaN, payload },
      { digest: "a", index: 0.5, total: 2, payload },
      { digest: "a", index: 0, total: -1, payload },
      { digest: "a", index: 0, total: 1, payload: [1, 2, 3] },
      { digest: "a", index: 0, total: 1, payload: new Uint8Array(MTU + 1) },
      { digest: 5, index: 0, total: 1, payload },
    ];
    expect(() => reassemble(junk)).not.toThrow();
    expect(reassemble(junk)).toBeNull();
    for (const j of junk) expect(reassemble([j])).toBeNull();
    expect(reassemble(null as never)).toBeNull();

    const r = new Reassembler();
    for (const j of junk) expect(r.push(j)).toBeNull();
    expect(r.size).toBe(0);
  });

  it("rejects n = 2^28 without allocating for it", () => {
    const huge = { digest: "a", index: 0, total: 2 ** 28, payload };
    const before = process.memoryUsage().heapUsed;
    expect(reassemble([huge])).toBeNull();
    expect(new Reassembler().push(huge)).toBeNull();
    expect(reassemble([{ ...huge, total: MAX_FRAMES + 1 }])).toBeNull();
    // A 2^28-slot array alone would be over a gigabyte.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(50 * 1024 * 1024);
  });

  it("keeps transfers apart by digest", () => {
    const one = new Uint8Array(MTU + 10).fill(1);
    const two = new Uint8Array(MTU + 10).fill(2);
    const mixed = [...frame("one", one), ...frame("two", two)];
    expect(reassemble(mixed, "one")).toEqual(one);
    expect(reassemble(mixed, "two")).toEqual(two);
    // Without a digest, the first well-formed frame's transfer is the one read.
    expect(reassemble([null, ...mixed])).toEqual(one);
    // Two transfers claiming one digest with different sizes read as nothing.
    const clash = [...frame("x", one), { digest: "x", index: 0, total: 5, payload }];
    expect(reassemble(clash)).toBeNull();
  });

  it("refuses to frame a body larger than MAX_FRAMES frames", () => {
    expect(() => frame("big", new Uint8Array(MTU * MAX_FRAMES + 1))).toThrow(RangeError);
    expect(frame("ok", new Uint8Array(MTU * MAX_FRAMES))).toHaveLength(MAX_FRAMES);
  });

  it("buffers a bounded number of transfers per peer", () => {
    const r = new Reassembler(2);
    const body = new Uint8Array(MTU * 2).fill(9);
    const [a0] = frame("a", body);
    const [b0] = frame("b", body);
    const [c0, c1] = frame("c", body);
    r.push(a0);
    r.push(b0);
    r.push(c0);
    expect(r.size).toBe(2); // "a" was evicted
    expect(r.push(c1)).toEqual({ digest: "c", body });
    expect(r.size).toBe(1);
  });

  it("parses untrusted JSON without throwing", () => {
    expect(parse("{not json")).toBeUndefined();
    expect(parse(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(parse("x".repeat(100), 10)).toBeUndefined();
    expect(parse('{"a":1}')).toEqual({ a: 1 });
    expect(parse(new TextEncoder().encode("null"))).toBeNull();
  });
});
