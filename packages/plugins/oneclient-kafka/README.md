# oneclient-kafka (Phase 5)

Reference plugin, not implemented yet. Topics/consumer groups use the same
Tier 1 explorer pattern as `oneclient-postgres`; the message browser is a
**Tier 2** custom view (`contributes.views[].tier === 2`) to prove the
sandboxed-view-host path end-to-end. Native dependency note: a Kafka client
typically means either `kafkajs` (pure JS, no native deps, slightly fewer
protocol features) or `node-rdkafka` (wraps librdkafka, needs prebuilt
native bindings per OS/arch/Node ABI). Default to `kafkajs` for Phase 4 to
avoid native-module packaging/signing pain across win32/macOS/linux; revisit
`node-rdkafka` only if a required feature forces it.
