# signalk-victoriametrics-history-provider

Experimental first release for Signal K. The [technical specification](SPEC.md)
describes the longer-term design; this README describes what version 0.1.0
actually supports.

## Installation

Requires Node.js 22 or newer. Install
`signalk-victoriametrics-history-provider` from Signal K's Apps & Plugins page,
then enable it and open its configuration panel. The panel requires Signal K
2.27.0 or newer; the first release has been exercised on Signal K 2.28.0.

For a local setup, install and enable `signalk-container` first, then add a
**VictoriaMetrics** destination in **Managed container** mode and select
**Write and History**. Save the configuration and restart the plugin when
prompted. This starts one managed VictoriaMetrics and one vmagent; their data
and vmagent's disk queue persist in the Signal K data directory.

For an existing VictoriaMetrics, choose **Remote**, enter its full Remote Write
endpoint (for example, `http://host:8428/api/v1/write`) and its History base URL
(for example, `http://host:8428`). A Prometheus-compatible destination is
write-only and must accept Prometheus Remote Write. Multiple write destinations
are supported, but only one VictoriaMetrics destination can serve History.
The plugin does not import data written by the old Prometheus exporter.

Current increment supports one `preferred` subscription, conversion to
Prometheus Remote Write v1, a bounded batch queue, and a Signal K History API
provider reading raw VictoriaMetrics samples. VictoriaMetrics and vmagent can
be run as managed containers through `signalk-container-helper`; vmagent can
also use an installed host binary. Remote destinations support no authentication
or one Basic Auth credential pair shared by Remote Write and History reads.
Managed host-binary VictoriaMetrics, bearer authentication, rich vmagent queue
diagnostics, and some History aggregates are not yet implemented.
Unsupported configuration is rejected at startup.

Managed-container mode requires the `signalk-container` plugin and its
Docker/Podman runtime. Read-only access to a remote VictoriaMetrics does not
require it. Host-binary vmagent also works without it when all destinations
are remote.

History returns stored strings and JSON values, including objects assembled
from previously written leaf series. Signal K defaults to `average`; for a
non-numeric path the provider instead uses the last value in each interval and
reports `method: last` in the response. `:first`, `:last` and `:middle_index`
remain available explicitly; numeric-only paths still use numeric `average`.
Boolean and date values written before type labels were added remain numeric
in existing history.

History values use raw `/api/v1/export` samples. Context and path discovery
uses VictoriaMetrics label-value queries, so discovery no longer downloads all
samples. VictoriaMetrics rounds the discovery time range to UTC days: a path
listed for a short interval may have samples elsewhere on the same day but
none in the exact interval. String values and changing JSON leaves become
labels/new series; exclude high-cardinality paths in ingestion settings when
storage growth matters.

History limits apply per requested path, not to the sum of all paths shown by
a client. The defaults are 500 raw series, 200,000 raw samples, 32 MiB of
VictoriaMetrics export data, 15 seconds, and a maximum range of 30 days.
The 30-day range is an independent ceiling: a frequently updated path can
reach the sample limit sooner. Shorten the requested interval or increase the
appropriate limit in the destination's advanced History settings. Limit errors
name the path, the exceeded limit and the observed count in the HTTP response.

The plugin warns when a Signal K path produces 100 distinct metric series in
one UTC day. This is an alert only: every sample continues through ingestion.
In **Advanced cardinality alert**, the threshold can be adjusted from 2 to
250, and paths can be exempted from the alert without excluding their data.
The monitor tracks at most 500 paths and reports when that bound is reached.
Its counters reset on restart and at midnight UTC; the warning is not an
authoritative count of historical series already stored in a destination.
For a VictoriaMetrics destination, its cardinality explorer provides a
database-side view of the most expensive `signalk_path` values.

Run unit tests with `npm install && npm test` on Node 22 or newer.

The Signal K configuration page includes a custom panel with conditional
fields for ingestion, vmagent and destinations. It requires a Signal K Admin
UI with plugin configuration panels (2.27.0 or newer). Build the panel with
`npm run build`; `npm pack` builds it automatically and includes the generated
`public/` assets. Ingestion and vmagent start automatically when any destination
is write-enabled. Managed container image versions are pinned by the plugin;
they cannot be overridden in configuration. The server-side configuration
validator remains authoritative.

`job` and `instance` are required metric labels. On first start, missing values
are generated and saved in the plugin configuration: `job` defaults to
`signalk-victoriametrics` and `instance` to
`signalk-victoriametrics-<random-hex>`. Existing values are preserved, and both
can be edited in the configuration panel. Changing either label starts new
time series and the default History reader will no longer select older series
with the previous identity.

Whenever ingestion starts vmagent, it scrapes its own `/metrics` endpoint every
15 seconds and sends those operational metrics to every write-enabled
destination. The series use `job="signalk-vmagent"`, the vessel context, and an
`instance` label from the saved plugin configuration.
Read-only mode does not start vmagent and therefore has no self-scrape.

For an external destination, select **Basic Auth** under its URLs and enter
the username and password. Remote Write uses private credential files read by
vmagent; History requests send an HTTP Basic Authorization header. The password
is also stored in the Signal K plugin configuration, so access to that
configuration must be restricted to administrators.
On Windows, Unix file modes do not protect these files; restrict the Signal K
data directory with Windows ACLs before configuring Basic Auth.

For a managed VictoriaMetrics destination, an empty retention field requests
no planned expiry. VictoriaMetrics has no truly unlimited retention, so the
plugin sends `100y`; an absent field defaults to `30d`.

The sandbox integration has been exercised with managed VictoriaMetrics and
vmagent containers. Signal K currently strips hyphens from source refs in the
HTTP `paths=path|sourceRef` parser; direct History provider calls do not have
that limitation. The plugin does not alter the server parser.

## Managed Web Interfaces

The Signal K Webapps list includes a VictoriaMetrics interface page. It has one
tab for each exposed service and no tabs by default. Enable **Expose vmagent
web interface** in the vmagent settings and/or **Expose this VictoriaMetrics
web interface** on individual managed destinations. Remote destinations are
never proxied. The page entry remains visible while no interfaces are selected,
but no administration endpoint is proxied.

The interfaces are served through Signal K's administrator-protected plugin
routes. No additional host port is opened. Enabling exposure changes the
managed service's HTTP path prefix, so the plugin updates its internal History,
Remote Write, health, and self-scrape URLs at the same time. Access to these
interfaces grants the same administrative capabilities as direct access to the
corresponding VictoriaMetrics or vmagent endpoint; use Signal K administrator
accounts only.
