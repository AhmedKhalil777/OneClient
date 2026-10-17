import { describe, expect, it } from "vitest";
import { brokerList, describeKafkaError, makeKafka } from "../src/client.js";
import { decode } from "../src/messages.js";

describe("Kafka connection settings", () => {
  it("parses bootstrap servers and prefers IPv4 for localhost", () => {
    expect(brokerList({ brokers: "localhost:9092, kafka-2:9093\nkafka-3:9094" })).toEqual(["127.0.0.1:9092", "kafka-2:9093", "kafka-3:9094"]);
    expect(() => brokerList({ brokers: "" })).toThrow(/bootstrap server/);
    expect(() => brokerList({ brokers: "kafka" })).toThrow(/host:port/);
  });

  it("requires credentials for SASL", () => {
    expect(() => makeKafka({ brokers: "a:1", sasl: "scram-sha-256", username: "u" })).toThrow(/user name and password/);
    expect(() => makeKafka({ brokers: "a:1", sasl: "none" })).not.toThrow();
  });

  it("explains common errors, including aggregated ones", () => {
    expect(describeKafkaError({ message: "connect ECONNREFUSED 127.0.0.1:9092" })).toMatch(/refused/);
    expect(describeKafkaError({ message: "Topic creation errors", errors: [{ type: "INVALID_REPLICATION_FACTOR", message: "x" }] })).toMatch(/replication factor/);
    expect(describeKafkaError({ type: "SASL_AUTHENTICATION_FAILED", message: "bad" })).toMatch(/Authentication failed/);
  });
});

describe("message decoding", () => {
  it("recognises JSON, text, binary and tombstones", () => {
    expect(decode(Buffer.from('{"a":1}')).encoding).toBe("json");
    expect(decode(Buffer.from("[not json")).encoding).toBe("text");
    expect(decode(Buffer.from("hello"))).toEqual({ text: "hello", encoding: "text", size: 5 });
    const bin = decode(Buffer.from([0, 1, 2, 255]));
    expect(bin.encoding).toBe("base64");
    expect(Buffer.from(bin.text, "base64")).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(decode(null).encoding).toBe("null");
  });
});
