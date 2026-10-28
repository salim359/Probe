import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractFunctionName, extractRegion } from "../src/orchestrator";

describe("orchestrator parse helpers", () => {
  it("extracts function name", () => {
    assert.equal(
      extractFunctionName(
        "Investigate Lambda lambdaLogs-dev-dev-submitContact",
      ),
      "lambdaLogs-dev-dev-submitContact",
    );
  });

  it("extracts region", () => {
    assert.equal(extractRegion("check errors in us-east-1 please"), "us-east-1");
  });
});
