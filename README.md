# signalk-victoriametrics-history-provider

Experimental Signal K plugin under development. The [technical specification](SPEC.md)
describes the intended v1 design; it is not yet implemented in full.

Current increment supports only ingestion: one `preferred` subscription, conversion
to Prometheus Remote Write v1, a bounded batch queue, a `vmagent` binary installed
on the Signal K host, and remote destinations without authentication. It does not
yet provide the Signal K History API, managed containers, local VictoriaMetrics
binaries, authentication, or full vmagent health/queue diagnostics. Unsupported
configuration is rejected at startup.

Run unit tests with `npm install && npm test`. Runtime integration testing with
vmagent and a VictoriaMetrics destination remains to be done.
