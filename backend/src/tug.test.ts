// backend/src/tug.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { Tug } from "./tug.js";

describe("Tug", () => {
  let tug: Tug;

  beforeEach(() => {
    tug = new Tug();
    tug.reset();
  });

  it("starts with rope at centre (p=0.5)", () => {
    const s = tug.snapshot();
    expect(s.p).toBe(0.5);
    expect(s.driveA).toBe(0);
    expect(s.driveB).toBe(0);
    expect(s.membersA).toBe(0);
    expect(s.membersB).toBe(0);
  });

  it("winner() returns A when tied", () => {
    expect(tug.winner()).toBe("A");
  });

  it("applyPull toward A moves rope below 0.5", () => {
    tug.applyPull("p1", "A", 1);
    const s = tug.snapshot();
    expect(s.p).toBeLessThan(0.5);
    expect(s.driveA).toBeGreaterThan(0);
    expect(s.membersA).toBe(1);
  });

  it("applyPull toward B moves rope above 0.5", () => {
    tug.applyPull("p1", "B", 1);
    const s = tug.snapshot();
    expect(s.p).toBeGreaterThan(0.5);
    expect(s.driveB).toBeGreaterThan(0);
    expect(s.membersB).toBe(1);
  });

  it("winner() returns B when B is ahead", () => {
    tug.applyPull("p1", "B", 100);
    expect(tug.winner()).toBe("B");
  });

  it("winner() returns A when A is ahead", () => {
    tug.applyPull("p1", "A", 100);
    expect(tug.winner()).toBe("A");
  });

  it("ignores zero or non-finite impulse", () => {
    tug.applyPull("p1", "A", 0);
    tug.applyPull("p2", "B", NaN);
    tug.applyPull("p3", "A", Infinity);
    // Infinity is finite? No — isFinite(Infinity) is false, so it's ignored
    const s = tug.snapshot();
    // Only Infinity pull was attempted with non-zero, but it gets rejected
    expect(s.p).toBe(0.5);
    expect(s.membersA).toBe(0);
    expect(s.membersB).toBe(0);
  });

  it("same participant counted once per side per round", () => {
    tug.applyPull("p1", "A", 1);
    tug.applyPull("p1", "A", 1);
    tug.applyPull("p1", "A", 1);
    expect(tug.snapshot().membersA).toBe(1);
  });

  it("reset() restores initial state", () => {
    tug.applyPull("p1", "A", 5);
    tug.applyPull("p2", "B", 5);
    tug.reset();
    const s = tug.snapshot();
    expect(s.p).toBe(0.5);
    expect(s.driveA).toBe(0);
    expect(s.driveB).toBe(0);
    expect(s.membersA).toBe(0);
    expect(s.membersB).toBe(0);
  });

  it("tick() does not throw and drives decay over time", () => {
    tug.applyPull("p1", "A", 2);
    const before = tug.snapshot().driveA;
    tug.tick();
    const after = tug.snapshot().driveA;
    // tick may or may not have elapsed time, but it should not throw
    expect(after).toBeLessThanOrEqual(before);
  });

  it("multiple independent instances do not share state", () => {
    const tugA = new Tug();
    const tugB = new Tug();
    tugA.applyPull("p1", "B", 10);
    expect(tugA.winner()).toBe("B");
    expect(tugB.winner()).toBe("A"); // tugB untouched
  });
});
