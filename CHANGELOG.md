# Changelog

## 0.1.3

- Put path filtering in an advanced section with a no-filter option that retains saved paths.
- Return source-specific History columns with `sourcePolicy=all` for the preferred-stream samples already stored.
- Allow collecting all sources with one fixed-period Signal K subscription; keep preferred collection as the default.
- Sample the last update per context, source and path every five seconds by default in both collection modes.

## 0.1.2

- Ignore identical History samples repeated for the same series and timestamp.
- Report conflicting values for one series and timestamp explicitly, while preserving errors for genuinely mixed scalar and object data.

## 0.1.1

- Configure a remote VictoriaMetrics with one base URL; derive its History and Remote Write endpoints automatically.
- Existing remote VictoriaMetrics destinations must be reconfigured with the new base URL field after upgrading. The previous read/write URL fields are no longer accepted.

## 0.1.0

First experimental release.

- Ingest Signal K preferred-stream deltas through vmagent using Prometheus Remote Write v1.
- Manage VictoriaMetrics and vmagent containers, or use remote destinations and a host vmagent binary.
- Serve Signal K History from one VictoriaMetrics destination, including scalar, position, string and JSON values.
- Configure destinations, authentication, retention and optional administrator-only web interfaces from the Signal K panel.
- Warn about high-cardinality paths without dropping their samples; expose vmagent self-scrape metrics.

Known limitations at release: only the preferred subscription stream is stored;
`sourcePolicy=all`, managed VictoriaMetrics host binaries, bearer authentication
and some History aggregates are not supported. Existing Prometheus exporter
history is not imported.
