# Changelog

## 0.1.0

First experimental release.

- Ingest Signal K preferred-stream deltas through vmagent using Prometheus Remote Write v1.
- Manage VictoriaMetrics and vmagent containers, or use remote destinations and a host vmagent binary.
- Serve Signal K History from one VictoriaMetrics destination, including scalar, position, string and JSON values.
- Configure destinations, authentication, retention and optional administrator-only web interfaces from the Signal K panel.
- Warn about high-cardinality paths without dropping their samples; expose vmagent self-scrape metrics.

Known limitations: only the preferred subscription stream is stored; `sourcePolicy=all`,
managed VictoriaMetrics host binaries, bearer authentication and some History aggregates
are not supported. Existing Prometheus exporter history is not imported.
