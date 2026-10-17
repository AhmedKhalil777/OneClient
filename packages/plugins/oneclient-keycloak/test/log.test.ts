import { describe, expect, it } from "vitest";
import { redact } from "../src/log.js";

describe("log redaction", () => {
  it("masks secrets in JSON bodies, at any depth", () => {
    const out = redact(JSON.stringify({ username: "a", credentials: [{ type: "password", value: "hunter2" }], clientSecret: "s" }));
    expect(out).not.toContain("hunter2");
    expect(out).toContain("username");
    expect(out).not.toMatch(/"clientSecret": "s"/);
  });
  it("masks secrets in form bodies", () => {
    const out = redact("grant_type=password&username=a&password=hunter2&client_secret=xyz")!;
    expect(out).toContain("username=a");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("xyz");
  });
});
