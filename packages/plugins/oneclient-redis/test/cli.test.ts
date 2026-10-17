import { describe, expect, it } from "vitest";
import { formatReply, isWriteCommand, tokenize } from "../src/cli.js";
import { escapeGlob } from "../src/keys.js";
import { parseInfo } from "../src/server.js";

describe("CLI", () => {
  it("tokenizes like redis-cli", () => {
    expect(tokenize(`SET "my key" 'it is' plain`)).toEqual(["SET", "my key", "it is", "plain"]);
    expect(tokenize(`SET k "line\\nbreak \\"q\\""`)).toEqual(["SET", "k", 'line\nbreak "q"']);
    expect(tokenize("  GET   k  ")).toEqual(["GET", "k"]);
    expect(() => tokenize('GET "open')).toThrow(/Unbalanced/);
  });

  it("formats replies like redis-cli", () => {
    expect(formatReply("OK")).toBe('"OK"');
    expect(formatReply(3)).toBe("(integer) 3");
    expect(formatReply(null)).toBe("(nil)");
    expect(formatReply([])).toBe("(empty array)");
    expect(formatReply(["a", ["b", 2]])).toBe('1) "a"\n2) 1) "b"\n   2) (integer) 2');
  });

  it("knows which commands write", () => {
    expect(isWriteCommand("set a 1")).toBe(true);
    expect(isWriteCommand("  HSET h f v")).toBe(true);
    expect(isWriteCommand("GET a")).toBe(false);
  });
});

describe("helpers", () => {
  it("parses INFO", () => {
    const info = parseInfo("# Server\r\nredis_version:7.4.1\r\nos:Linux\r\n\r\n# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=0\r\n");
    expect(info.server?.redis_version).toBe("7.4.1");
    expect(info.keyspace?.db0).toBe("keys=3,expires=1,avg_ttl=0");
  });

  it("escapes glob characters for literal prefixes", () => {
    expect(escapeGlob("a*b?[c]\\")).toBe("a\\*b\\?\\[c\\]\\\\");
  });
});
