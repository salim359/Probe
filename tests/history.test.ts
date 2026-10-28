import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expiresAtEpoch, makeTurnSk } from "../src/history";

describe("history helpers", () => {
  it("builds sortable TURN sort keys", () => {
    const at = new Date("2026-10-28T12:00:00.000Z");
    const sk = makeTurnSk(at);
    assert.match(sk, /^TURN#2026-10-28T12:00:00\.000Z#[0-9a-f-]{36}$/i);
  });

  it("sets TTL ~90 days ahead", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const ttl = expiresAtEpoch(at);
    const expected = Math.floor(at.getTime() / 1000) + 90 * 24 * 60 * 60;
    assert.equal(ttl, expected);
  });
});
