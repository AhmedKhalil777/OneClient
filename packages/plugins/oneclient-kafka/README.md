# oneclient-kafka

Apache Kafka for oneClient, built on [kafkajs](https://kafka.js.org). Works with Apache Kafka, Redpanda, Confluent Cloud and Azure Event Hubs (Kafka endpoint).

## Connection

| Field | Notes |
|---|---|
| Bootstrap servers | `host:port`, comma-separated. `localhost` is rewritten to `127.0.0.1` (Docker port maps usually answer on IPv4 only). |
| SASL authentication | `none`, `plain`, `scram-sha-256`, `scram-sha-512`. User name and password (the password is stored encrypted). |
| Use TLS | Turn on for Confluent Cloud / Event Hubs. "Accept self-signed certificate" skips certificate verification. |

The broker must advertise an address the desktop can reach (`advertised.listeners`).

## Features

- **Explorer:** Brokers, Topics (internal `__*` topics hidden) and Consumer groups. Context menu: new topic, browse / produce, increase partitions, empty topic, delete topic, delete group, cluster overview.
- **Topic view** (`kafka.topic`):
  - *Messages:* read the newest N, from the beginning, from an offset or from a date/time, for one partition or all. Keys, headers and values are decoded (JSON pretty-printed, binary as base64). Browsing uses a throw-away consumer group that never commits and is deleted afterwards, stops at each partition's end as of the start of the read, and gives up after 15 s.
  - *Produce:* key, partition (or automatic), headers, value (Ctrl+S sends), N copies. "Produce again…" on a message copies it into the form.
  - *Partitions:* leader, replicas, ISR (under-replication highlighted), first / next offset and message counts.
  - *Configuration:* overrides (and optionally defaults); add, edit, or reset to the default.
- **Consumer group view** (`kafka.group`): state, members with their assigned partitions, committed offset / end offset / lag per partition, auto-refresh, reset offsets to earliest / latest / a date-time (only while the group has no members), delete.
- **Cluster dashboard** (`kafka.cluster`): brokers and controller, topic and partition counts, under-replicated partitions, all topics and groups.
- **Search:** topics and consumer groups appear in the top search (Ctrl+P).
- **Output:** topic changes, produced messages, offset resets and failures go to the *oneclient-kafka/Changes* channel.

## Development

```sh
pnpm --filter oneclient-kafka build
pnpm --filter oneclient-kafka test
```

A local single-node broker (KRaft) for manual testing:

```sh
docker run -d --name kafka -p 19092:19092 \
  -e KAFKA_NODE_ID=1 -e KAFKA_PROCESS_ROLES=broker,controller \
  -e KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093,EXTERNAL://:19092 \
  -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://localhost:9092,EXTERNAL://127.0.0.1:19092 \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:PLAINTEXT \
  -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 -e KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1 \
  -e KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1 apache/kafka:latest
```

Then connect to `127.0.0.1:19092`.
