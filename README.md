# signalk-victoriametrics-history-provider

Experimental Signal K plugin under development. The [technical specification](SPEC.md)
describes the intended v1 design; it is not yet implemented in full.

Current increment supports one `preferred` subscription, conversion to
Prometheus Remote Write v1, a bounded batch queue, and a Signal K History API
provider reading raw VictoriaMetrics samples. VictoriaMetrics and vmagent can
be run as managed containers through `signalk-container-helper`; vmagent can
also use an installed host binary. Remote destinations without authentication
are supported. Managed host-binary VictoriaMetrics, authentication, rich
vmagent queue diagnostics, and some History data types are not yet implemented.
Unsupported configuration is rejected at startup.

Run unit tests with `npm install && npm test` on Node 22 or newer.

The sandbox integration has been exercised with managed VictoriaMetrics and
vmagent containers. Signal K currently strips hyphens from source refs in the
HTTP `paths=path|sourceRef` parser; direct History provider calls do not have
that limitation. The plugin does not alter the server parser.
