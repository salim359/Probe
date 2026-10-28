import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactText, redactValue } from "../src/redact";

describe("redact", () => {
  it("redacts AWS access keys", () => {
    // Build at runtime so editors/scanners do not rewrite the sample.
    const accessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const text = `key=${accessKey} used here`;
    const out = redactText(text);
    assert.equal(out.includes(accessKey), false);
    assert.equal(out.includes("[REDACTED_AWS_ACCESS_KEY]"), true);
  });

  it("redacts bearer tokens and emails", () => {
    const out = redactText(
      "Authorization Bearer abcdefghijklmnop user@example.com",
    );
    assert.equal(out.includes("abcdefghijklmnop"), false);
    assert.equal(out.includes("user@example.com"), false);
  });

  it("redacts nested values", () => {
    const out = redactValue({
      msg: "api_key=sk-supersecretvalue123",
      n: 1,
    });
    assert.equal(out.msg.includes("sk-supersecretvalue123"), false);
    assert.equal(out.n, 1);
  });
});
