# Analytics and telemetry tests  `stage-23.6.1`

This stage is the safety net for the system’s observability features: the parts that record what the app did, how long it took, and what happened when something went wrong. It is shared behind the scenes rather than part of startup or shutdown. These tests make sure analytics events, metrics, logs, and traces are produced correctly and sent to the right place.

The otel test crate ties the OpenTelemetry test suite together, while the harness sets up fake in-memory exporters so tests can inspect emitted data without needing real servers. The suite then checks specific behaviors: rejecting bad metric inputs, recording timings, sending data in the background, taking snapshots of current metrics, building runtime summaries, and adding manager-level tags and counters. Other tests verify routing rules between logs and trace events, plus full OTLP/HTTP export through a tiny local loopback server.

The analytics tests focus on higher-level event creation: choosing destinations, batching, filtering, serialization, deduplication, and turn-by-turn app behavior. App-server, core, and state tests then confirm that these signals appear correctly in real workflows, helper utilities, and stored logs.

## Files in this stage

### OTEL test scaffolding
These files define the OpenTelemetry integration test crate, organize its suite modules, and provide the shared in-memory harness used by the individual tests.

### `otel/tests/tests.rs`

`test` · `test crate setup and execution`

This file is the root of the `otel/tests` integration test crate. It begins with `#![allow(clippy::expect_used)]`, explicitly relaxing a lint that would otherwise complain about `expect` calls in test code; that signals the test suite prefers direct, fail-fast assertions over production-style error propagation. It then declares two modules: `harness` and `suite`. `harness` is the shared support layer for spinning up fixtures, test environments, or common assertions, while `suite` is the collection of scenario-focused test modules declared in `suite/mod.rs`. There is no runtime logic here beyond crate assembly, but this file is still important because integration tests in Rust are compiled as separate crates rooted at files like this one. The file therefore controls what helper code and test cases are visible to the test runner, and it establishes the boundary between reusable test infrastructure and the actual OpenTelemetry behavior checks.


### `otel/tests/suite/mod.rs`

`test` · `test discovery and compilation`

This file contains no executable logic; its entire job is to define the structure of the `otel` test suite by declaring eight sibling submodules: `manager_metrics`, `otel_export_routing_policy`, `otlp_http_loopback`, `runtime_summary`, `send`, `snapshot`, `timing`, and `validation`. In Rust test code, this kind of `mod.rs` acts as the compilation-time manifest for the suite: each listed module becomes part of the `suite` tree and can contribute tests, helpers, fixtures, or assertions. The design keeps scenario-specific test code split by concern rather than accumulating all OpenTelemetry coverage in one file. That matters for discoverability: readers can infer the suite covers metrics emitted by the manager, export routing behavior, OTLP HTTP loopback behavior, runtime summaries, send paths, snapshotting, timing-sensitive behavior, and validation rules. Because there are no items re-exported here, consumers access content through the module hierarchy itself, and the file's only state is the static module graph it establishes at compile time.


### `otel/tests/harness/mod.rs`

`test` · `test setup and metric assertion helpers`

This file is a test-only harness around the metrics subsystem. Its main helper, `build_metrics_with_defaults`, creates an `InMemoryMetricExporter`, builds a `MetricsConfig::in_memory` using fixed test environment/service metadata, applies any supplied default tags through repeated `with_tag` calls, and returns both the resulting `MetricsClient` and the exporter so tests can emit metrics and inspect what was exported.

The remaining helpers navigate OpenTelemetry SDK metric data structures. `latest_metrics` fetches the exporter’s finished metric batches, takes the last `ResourceMetrics` snapshot, and panics with clear messages if nothing has been exported yet. `find_metric` walks `scope_metrics()` and then `metrics()` to locate a metric by name across instrumentation scopes. `attributes_to_map` converts an iterator of `KeyValue` references into a `BTreeMap<String, String>` for deterministic assertions on tags/attributes. `histogram_data` is a specialized extractor for floating-point histogram metrics: it finds the named metric, asserts there is exactly one data point, and returns the bucket bounds, bucket counts, sum, and count as plain Rust values. It panics on unexpected aggregation or metric data types, which is appropriate for tests because those mismatches indicate the test setup or metric definition is wrong rather than a recoverable runtime condition.

#### Function details

##### `build_metrics_with_defaults`  (lines 12–27)

```
fn build_metrics_with_defaults(
    default_tags: &[(&str, &str)],
) -> Result<(MetricsClient, InMemoryMetricExporter)>
```

**Purpose**: Creates a metrics client backed by an in-memory exporter and preloads any requested default tags. It is the standard fixture constructor for metrics tests.

**Data flow**: Takes `default_tags: &[(&str, &str)]` → creates `InMemoryMetricExporter::default()` → builds `MetricsConfig::in_memory("test", "codex-cli", env!("CARGO_PKG_VERSION"), exporter.clone())` → folds over `default_tags`, applying each via `config.with_tag(*key, *value)?` → constructs `MetricsClient::new(config)?` → returns `Ok((metrics, exporter))`.

**Call relations**: Many metrics tests call this first to obtain a ready-to-use client and inspectable exporter. It delegates actual config and client validation to production code (`MetricsConfig` and `MetricsClient`).

*Call graph*: calls 2 internal fn (new, in_memory); called by 13 (manager_allows_disabling_metadata_tags, manager_attaches_metadata_tags_to_metrics, manager_attaches_optional_service_name_tag, manager_records_plugin_install_elicitation_sent_metric, manager_records_plugin_install_suggestion_metric, client_sends_enqueued_metric, send_builds_payload_with_tags_and_histograms, send_merges_default_tags_per_line, shutdown_flushes_in_memory_exporter, shutdown_without_metrics_exports_nothing (+3 more)); 2 external calls (default, env!).


##### `latest_metrics`  (lines 29–36)

```
fn latest_metrics(exporter: &InMemoryMetricExporter) -> ResourceMetrics
```

**Purpose**: Returns the most recently exported `ResourceMetrics` batch from the in-memory exporter. It gives tests a single snapshot to inspect after emitting metrics.

**Data flow**: Accepts `&InMemoryMetricExporter` → calls `get_finished_metrics()` and expects success → converts the finished batches into an iterator, takes `.last()`, and expects one batch to exist → returns that `ResourceMetrics`.

**Call relations**: Tests call this after recording metrics to inspect the latest export cycle. It is often paired with `find_metric`, `attributes_to_map`, or `histogram_data`.

*Call graph*: called by 12 (manager_allows_disabling_metadata_tags, manager_attaches_metadata_tags_to_metrics, manager_attaches_optional_service_name_tag, manager_records_plugin_install_elicitation_sent_metric, manager_records_plugin_install_suggestion_metric, client_sends_enqueued_metric, send_builds_payload_with_tags_and_histograms, send_merges_default_tags_per_line, shutdown_flushes_in_memory_exporter, record_duration_records_histogram (+2 more)); 1 external calls (get_finished_metrics).


##### `find_metric`  (lines 38–50)

```
fn find_metric(
    resource_metrics: &'a ResourceMetrics,
    name: &str,
) -> Option<&'a Metric>
```

**Purpose**: Searches a `ResourceMetrics` tree for a metric with a given name across all instrumentation scopes. It abstracts away the nested OpenTelemetry SDK structure.

**Data flow**: Takes `&ResourceMetrics` and `name: &str` → iterates through `resource_metrics.scope_metrics()` and then each scope’s `metrics()` → compares `metric.name()` to `name` → returns `Some(&Metric)` on the first match or `None` if absent.

**Call relations**: This helper is used directly by many tests and by `histogram_data`. It centralizes the traversal logic so tests do not repeat nested loops.

*Call graph*: called by 15 (histogram_data, manager_allows_disabling_metadata_tags, manager_attaches_metadata_tags_to_metrics, manager_attaches_optional_service_name_tag, manager_records_plugin_install_elicitation_sent_metric, manager_records_plugin_install_suggestion_metric, client_sends_enqueued_metric, send_builds_payload_with_tags_and_histograms, send_merges_default_tags_per_line, shutdown_flushes_in_memory_exporter (+5 more)); 1 external calls (scope_metrics).


##### `attributes_to_map`  (lines 52–58)

```
fn attributes_to_map(
    attributes: impl Iterator<Item = &'a KeyValue>,
) -> BTreeMap<String, String>
```

**Purpose**: Converts a metric attribute iterator into a deterministic `BTreeMap` for easy equality assertions. It normalizes OpenTelemetry `KeyValue` objects into owned strings.

**Data flow**: Accepts any iterator yielding `&KeyValue` → maps each item to `(kv.key.as_str().to_string(), kv.value.as_str().to_string())` → collects into `BTreeMap<String, String>` and returns it.

**Call relations**: Tests use this after locating a metric or data point to compare exported attributes against expected tag sets without depending on iteration order.

*Call graph*: called by 11 (manager_allows_disabling_metadata_tags, manager_attaches_metadata_tags_to_metrics, manager_attaches_optional_service_name_tag, manager_records_plugin_install_elicitation_sent_metric, manager_records_plugin_install_suggestion_metric, client_sends_enqueued_metric, send_builds_payload_with_tags_and_histograms, send_merges_default_tags_per_line, manager_snapshot_metrics_collects_without_shutdown, snapshot_collects_metrics_without_shutdown (+1 more)); 1 external calls (map).


##### `histogram_data`  (lines 60–79)

```
fn histogram_data(
    resource_metrics: &ResourceMetrics,
    name: &str,
) -> (Vec<f64>, Vec<u64>, f64, u64)
```

**Purpose**: Extracts the single data point from a named floating-point histogram metric and returns its bucket structure and totals in plain Rust collections. It is a convenience assertion helper for duration and histogram tests.

**Data flow**: Takes `&ResourceMetrics` and metric `name` → finds the metric with `find_metric(...).expect(...)` → matches `metric.data()` expecting `AggregatedMetrics::F64(MetricData::Histogram(histogram))` → collects histogram data points into a vector, asserts there is exactly one point, then collects that point’s bounds and bucket counts and reads its sum and count → returns `(Vec<f64>, Vec<u64>, f64, u64)`; panics on unexpected metric type or aggregation.

**Call relations**: Histogram-focused tests call this after `latest_metrics` to avoid manual pattern matching on SDK metric types. It depends on `find_metric` for lookup and intentionally panics when the exported metric shape is not the expected histogram form.

*Call graph*: calls 1 internal fn (find_metric); called by 4 (send_builds_payload_with_tags_and_histograms, record_duration_records_histogram, record_duration_seconds_uses_fractional_seconds_and_scaled_buckets, timer_result_records_success); 2 external calls (assert_eq!, panic!).


### Metrics client behavior
These tests walk through the metrics client and session telemetry APIs from validation and recording through sending, snapshots, summaries, and manager-specific counters.

### `otel/tests/suite/validation.rs`

`test` · `input validation and error-path verification`

This file is a focused negative-test suite for `MetricsClient` and `MetricsConfig`. The small helper `build_in_memory_client` constructs a valid in-memory metrics client used by the per-metric validation tests. The tests then deliberately supply malformed inputs and assert on the exact `MetricsError` variant and payload using `matches!` guards.

Two classes of validation are covered. Configuration-time validation is exercised by calling `MetricsConfig::in_memory(...).with_tag("bad key", "value")`, which must reject an invalid default tag key before a client is even built. Runtime recording validation is exercised through `metrics.counter(...)` and `metrics.histogram(...)`: invalid per-call tag keys and values must be rejected, invalid metric names such as `"bad name"` must produce `MetricsError::InvalidMetricName`, and negative increments on counters must produce `MetricsError::NegativeCounterIncrement` carrying both the metric name and the offending increment. Each runtime test shuts the client down afterward to keep the metrics pipeline lifecycle clean even though recording failed. These tests document that validation happens early and returns structured, inspectable errors rather than silently sanitizing bad input.

#### Function details

##### `build_in_memory_client`  (lines 7–11)

```
fn build_in_memory_client() -> Result<MetricsClient>
```

**Purpose**: Creates a valid in-memory `MetricsClient` fixture for validation tests. It centralizes the standard test configuration so each negative test can focus on one invalid input.

**Data flow**: It constructs an `InMemoryMetricExporter`, builds a `MetricsConfig::in_memory("test", "codex-cli", env!("CARGO_PKG_VERSION"), exporter)`, and passes that config to `MetricsClient::new`. It returns the resulting `Result<MetricsClient>`.

**Call relations**: This helper is called by the runtime validation tests for invalid tag keys/values, invalid metric names, and negative increments. It provides the baseline valid client those tests intentionally misuse.

*Call graph*: calls 2 internal fn (new, in_memory); called by 4 (counter_rejects_invalid_metric_name, counter_rejects_invalid_tag_key, counter_rejects_negative_increment, histogram_rejects_invalid_tag_value); 2 external calls (default, env!).


##### `invalid_tag_component_is_rejected`  (lines 15–30)

```
fn invalid_tag_component_is_rejected() -> Result<()>
```

**Purpose**: Verifies that invalid default tag components are rejected during metrics configuration building. It specifically checks the error payload for a bad tag key containing a space.

**Data flow**: It creates an in-memory metrics config with a fresh `InMemoryMetricExporter`, calls `.with_tag("bad key", "value")`, unwraps the resulting error, and asserts via `matches!` that the error is `MetricsError::InvalidTagComponent` with `label == "tag key"` and `value == "bad key"`.

**Call relations**: This is the configuration-time validation test in the file. Unlike the others, it does not build a `MetricsClient`; it stops at config construction.

*Call graph*: calls 1 internal fn (in_memory); 3 external calls (default, assert!, env!).


##### `counter_rejects_invalid_tag_key`  (lines 34–46)

```
fn counter_rejects_invalid_tag_key() -> Result<()>
```

**Purpose**: Checks that `MetricsClient::counter` validates per-call tag keys and rejects invalid ones. It confirms the returned error identifies the bad key as a tag-key problem.

**Data flow**: It obtains a valid in-memory client from `build_in_memory_client()`, calls `metrics.counter("codex.turns", 1, &[("bad key", "value")])`, unwraps the error, and asserts that it matches `MetricsError::InvalidTagComponent` with the expected label and value. It then shuts the client down.

**Call relations**: This test depends on `build_in_memory_client` for setup and exercises the counter recording path's input validation branch.

*Call graph*: calls 1 internal fn (build_in_memory_client); 1 external calls (assert!).


##### `histogram_rejects_invalid_tag_value`  (lines 50–66)

```
fn histogram_rejects_invalid_tag_value() -> Result<()>
```

**Purpose**: Verifies that histogram recording validates tag values and rejects invalid ones. It distinguishes bad values from bad keys in the returned error.

**Data flow**: It builds a valid in-memory client, calls `metrics.histogram("codex.request_latency", 3, &[("route", "bad value")])`, unwraps the error, and asserts that it is `MetricsError::InvalidTagComponent` with `label == "tag value"` and `value == "bad value"`. It then shuts the client down.

**Call relations**: This test uses the shared client fixture and targets the histogram recording path's tag-value validation logic.

*Call graph*: calls 1 internal fn (build_in_memory_client); 1 external calls (assert!).


##### `counter_rejects_invalid_metric_name`  (lines 70–79)

```
fn counter_rejects_invalid_metric_name() -> Result<()>
```

**Purpose**: Checks that metric names are validated before recording and that malformed names are rejected with `InvalidMetricName`. It documents the error variant used for naming violations.

**Data flow**: It creates a valid in-memory client, calls `metrics.counter("bad name", 1, &[])`, unwraps the error, and asserts that it matches `MetricsError::InvalidMetricName { name }` with `name == "bad name"`. It then shuts the client down.

**Call relations**: This test reuses `build_in_memory_client` and exercises the metric-name validation branch of the counter API.

*Call graph*: calls 1 internal fn (build_in_memory_client); 1 external calls (assert!).


##### `counter_rejects_negative_increment`  (lines 82–91)

```
fn counter_rejects_negative_increment() -> Result<()>
```

**Purpose**: Verifies that counters reject negative increments rather than accepting them or coercing them. It checks that the error reports both the metric name and the invalid increment.

**Data flow**: It builds a valid in-memory client, calls `metrics.counter("codex.turns", -1, &[])`, unwraps the error, and asserts that it matches `MetricsError::NegativeCounterIncrement { name, inc }` with the expected values. It then shuts the client down.

**Call relations**: This is the final runtime validation test and covers the numeric validation branch of the counter API using the shared client fixture.

*Call graph*: calls 1 internal fn (build_in_memory_client); 1 external calls (assert!).


### `otel/tests/suite/timing.rs`

`test` · `duration metric recording verification`

This file concentrates on timing metrics emitted as histograms. All tests use the shared in-memory metrics harness, record one or more durations, shut the client down, and inspect the exported histogram data through `histogram_data` plus direct metric lookup. The first test covers `record_duration`, asserting that a 15 ms duration becomes a histogram named `codex.request_latency` with unit `ms`, description `Duration in milliseconds.`, non-empty bucket bounds, sum `15.0`, and count `1`.

The second test exercises `record_duration_seconds_with_description`, recording three durations—200 ms, 1 s, and 4.9 s—and asserting the exact bucket boundaries used for second-based histograms. It also checks the bucket counts vector, total sum `6.1`, count `3`, unit `s`, and the custom description string. This documents the scaled bucket scheme rather than merely checking that some histogram exists.

The final test covers the timer API by creating a timer with `start_timer` and letting it drop immediately. After shutdown it verifies that one histogram sample was recorded with the expected unit/description and that the `route=chat` attribute was preserved. Together these tests define the contract for explicit and scoped timing instrumentation.

#### Function details

##### `record_duration_records_histogram`  (lines 11–34)

```
fn record_duration_records_histogram() -> Result<()>
```

**Purpose**: Verifies that recording a millisecond duration produces a histogram with the default millisecond unit and description. It checks both aggregate values and metric metadata.

**Data flow**: It builds an in-memory metrics client, records `codex.request_latency` with a 15 ms `Duration` and tag `route=chat`, then shuts down. It reads the latest exported metrics, decodes histogram bounds, bucket counts, sum, and count for that metric, and then looks up the metric directly to assert its unit is `ms` and its description is `Duration in milliseconds.`.

**Call relations**: This test is a direct consumer of the metrics timing API and uses the shared harness helpers to inspect the exported histogram after shutdown.

*Call graph*: calls 4 internal fn (build_metrics_with_defaults, find_metric, histogram_data, latest_metrics); 3 external calls (from_millis, assert!, assert_eq!).


##### `record_duration_seconds_uses_fractional_seconds_and_scaled_buckets`  (lines 37–78)

```
fn record_duration_seconds_uses_fractional_seconds_and_scaled_buckets() -> Result<()>
```

**Purpose**: Checks that second-based duration recording converts `Duration` values to fractional seconds and uses the expected bucket boundaries. It validates the exact histogram schema for second-unit timings.

**Data flow**: It creates an in-memory metrics client, records three durations under `codex.request_duration_seconds` using `record_duration_seconds_with_description`, then shuts down. It reads the exported histogram data, asserts the exact `bounds` vector, the exact `bucket_counts` vector, the floating-point sum near `6.1`, and total count `3`, then looks up the metric to verify unit `s` and the custom description string.

**Call relations**: This test extends the basic duration test by covering the alternate seconds-based API and its bucket scaling behavior.

*Call graph*: calls 4 internal fn (build_metrics_with_defaults, find_metric, histogram_data, latest_metrics); 4 external calls (from_millis, from_secs, assert!, assert_eq!).


##### `timer_result_records_success`  (lines 82–118)

```
fn timer_result_records_success() -> Result<()>
```

**Purpose**: Verifies that the scoped timer API records a histogram sample when the timer is created and then dropped. It also checks that timer-supplied attributes are attached to the resulting histogram point.

**Data flow**: It builds an in-memory metrics client, starts a timer for `codex.request_latency` with `route=chat`, asserts timer creation succeeded, and lets the timer go out of scope. After shutdown it reads the histogram data for the metric, asserts one sample was recorded, verifies unit `ms` and description `Duration in milliseconds.`, then extracts the histogram point attributes and checks that `route=chat` is present.

**Call relations**: This test covers the RAII-style timing path rather than explicit duration recording. It still relies on the shared harness helpers for post-shutdown histogram inspection.

*Call graph*: calls 5 internal fn (attributes_to_map, build_metrics_with_defaults, find_metric, histogram_data, latest_metrics); 2 external calls (assert!, assert_eq!).


### `otel/tests/suite/send.rs`

`test` · `metrics client send/flush verification`

This file focuses on `MetricsClient` behavior independent of `SessionTelemetry`. The tests use `build_metrics_with_defaults` to create an in-memory metrics pipeline with optional default tags, record counters, histograms, and gauges, shut the client down, and inspect the exported `ResourceMetrics`. Assertions descend into concrete OpenTelemetry metric representations: counters are expected as `AggregatedMetrics::U64(MetricData::Sum)`, gauges as `AggregatedMetrics::I64(MetricData::Gauge)`, and latency metrics as histograms decoded through the shared `histogram_data` helper.

A key concern here is tag precedence. The tests show that default tags are merged per metric line and that per-call tags override defaults with the same key (`env=dev` overriding `env=prod`, or `service=worker` overriding `service=codex-cli`). They also verify that descriptions supplied through `counter_with_description` and `gauge_with_description` survive export unchanged. The histogram assertions check both bucket accounting and attribute propagation. Separate tests cover the asynchronous/background send path by recording a metric and ensuring it appears after shutdown, flushing semantics for in-memory exporters, and the no-op case where shutting down without recording anything yields no exported metrics at all. Together these tests document the exact payload shape and lifecycle of metric emission.

#### Function details

##### `send_builds_payload_with_tags_and_histograms`  (lines 12–108)

```
fn send_builds_payload_with_tags_and_histograms() -> Result<()>
```

**Purpose**: Verifies that counters, histograms, and gauges are exported with the correct descriptions, values, and merged tags. It also checks that per-call tags override defaults where keys collide.

**Data flow**: It builds a metrics client with default tags `service=codex-cli` and `env=prod`, records a described counter with per-call tags `model=gpt-5.1` and `env=dev`, records a histogram for `codex.tool_latency`, records a described gauge for `codex.active`, and shuts the client down. It then reads the latest exported metrics, extracts and validates the counter description/value/attributes, decodes histogram bounds, bucket counts, sum, count, and attributes, and finally validates the gauge description, point value, and attributes.

**Call relations**: This top-level test drives several `MetricsClient` recording APIs in one flow and uses the shared harness helpers to inspect the exported metrics after shutdown.

*Call graph*: calls 5 internal fn (attributes_to_map, build_metrics_with_defaults, find_metric, histogram_data, latest_metrics); 4 external calls (from, assert!, assert_eq!, panic!).


##### `send_merges_default_tags_per_line`  (lines 112–179)

```
fn send_merges_default_tags_per_line() -> Result<()>
```

**Purpose**: Checks that default tags are merged independently for each metric and that per-metric overrides apply only to the metric being recorded. It demonstrates line-by-line tag precedence.

**Data flow**: It creates a metrics client with defaults `service=codex-cli`, `env=prod`, and `region=us`, records `codex.alpha` with overriding `env=dev` and `component=alpha`, records `codex.beta` with overriding `service=worker` and `component=beta`, then shuts down. It reads exported metrics, extracts the single counter point for each metric, converts attributes to maps, and compares them to the expected merged maps for alpha and beta separately.

**Call relations**: This test is invoked directly by the test runner and focuses specifically on tag-merging semantics. It reuses the harness metric lookup and attribute conversion helpers.

*Call graph*: calls 4 internal fn (attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics); 3 external calls (from, assert_eq!, panic!).


##### `client_sends_enqueued_metric`  (lines 183–207)

```
fn client_sends_enqueued_metric() -> Result<()>
```

**Purpose**: Verifies that a metric queued for background processing is actually exported once the client is shut down. It confirms the asynchronous send path is not dropping data.

**Data flow**: It builds an in-memory metrics client, records `codex.turns` with increment `1` and tag `model=gpt-5.1`, then shuts down the client. After reading the latest exported metrics, it finds the counter, collects its sum data points, asserts there is exactly one point with value `1`, converts attributes to a map, and checks that the `model` tag is present.

**Call relations**: This test isolates the enqueue-and-flush path rather than exercising multiple metric types. It depends on shutdown to force delivery before inspecting the exporter.

*Call graph*: calls 4 internal fn (attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics); 2 external calls (assert_eq!, panic!).


##### `shutdown_flushes_in_memory_exporter`  (lines 211–231)

```
fn shutdown_flushes_in_memory_exporter() -> Result<()>
```

**Purpose**: Ensures that calling `shutdown()` flushes pending metrics to the in-memory exporter even for a minimal single-counter case. It is a focused flush semantics test.

**Data flow**: It creates a metrics client, records `codex.turns` with no tags, calls `shutdown()`, then reads the latest exported metrics and extracts the counter's sum data points. The only assertion is that exactly one point was exported.

**Call relations**: This test is a narrower companion to `client_sends_enqueued_metric`, concentrating on shutdown flush behavior rather than tag contents.

*Call graph*: calls 3 internal fn (build_metrics_with_defaults, find_metric, latest_metrics); 2 external calls (assert_eq!, panic!).


##### `shutdown_without_metrics_exports_nothing`  (lines 235–243)

```
fn shutdown_without_metrics_exports_nothing() -> Result<()>
```

**Purpose**: Checks that shutting down an unused metrics client does not emit empty or spurious exports. It validates the no-data path.

**Data flow**: It builds an in-memory metrics client, immediately calls `shutdown()`, then reads `exporter.get_finished_metrics()` and asserts that the returned collection is empty.

**Call relations**: This is the simplest send-path test and covers the edge case where no metrics were recorded before shutdown.

*Call graph*: calls 1 internal fn (build_metrics_with_defaults); 1 external calls (assert!).


### `otel/tests/suite/snapshot.rs`

`test` · `on-demand metric snapshot verification`

This file verifies that metrics can be synchronously collected from the runtime reader before any periodic export or shutdown occurs. Both tests use `MetricsConfig::in_memory(...).with_tag("service", "codex-cli")?.with_runtime_reader()` so the metrics pipeline supports snapshot reads. The first test records a plain counter directly through `MetricsClient`, calls `snapshot()`, and inspects the returned metric set to ensure the counter exists with the expected merged attributes. It also checks that the underlying `InMemoryMetricExporter` has not received any finished exports yet, proving snapshot collection is separate from exporter flush.

The second test wraps the same metrics client in `SessionTelemetry` and records the same logical counter through the manager. Its expected attribute map is larger because manager metadata enrichment is active: `app.version`, `auth_mode`, `model`, `originator`, `service`, and `session_source` are merged with the per-call `tool` and `success` tags. Both tests decode the metric as a `U64` sum with exactly one data point and convert attributes into a `BTreeMap` for deterministic comparison. Together they document the distinction between snapshot reads and exporter-driven delivery, and they show how manager-level metadata affects snapshot contents just as it affects exported metrics.

#### Function details

##### `snapshot_collects_metrics_without_shutdown`  (lines 17–63)

```
fn snapshot_collects_metrics_without_shutdown() -> Result<()>
```

**Purpose**: Verifies that `MetricsClient::snapshot()` returns current metric data without requiring shutdown or periodic export. It also proves that taking a snapshot does not populate the finished-export buffer.

**Data flow**: It creates an `InMemoryMetricExporter`, builds a runtime-reader-enabled in-memory `MetricsConfig` with a default `service` tag, constructs a `MetricsClient`, records `codex.tool.call` with `tool=shell` and `success=true`, and calls `snapshot()`. It finds the counter in the returned snapshot, unwraps the single `U64` sum point, converts attributes to a map, and compares them to the expected merged tags. Finally it reads `exporter.get_finished_metrics()` and asserts that no periodic exports have occurred.

**Call relations**: This is the direct snapshot-path test for `MetricsClient`. It uses the shared `find_metric` and `attributes_to_map` helpers to inspect the snapshot payload.

*Call graph*: calls 4 internal fn (new, in_memory, attributes_to_map, find_metric); 6 external calls (from, default, assert!, assert_eq!, env!, panic!).


##### `manager_snapshot_metrics_collects_without_shutdown`  (lines 66–125)

```
fn manager_snapshot_metrics_collects_without_shutdown() -> Result<()>
```

**Purpose**: Checks that `SessionTelemetry::snapshot_metrics()` exposes current metric state without shutdown and includes manager metadata enrichment. It is the manager-level counterpart to the direct client snapshot test.

**Data flow**: It creates an in-memory runtime-reader-enabled metrics client with a default `service` tag, constructs a populated `SessionTelemetry` and attaches the metrics client, records `codex.tool.call` through `manager.counter(...)`, and calls `snapshot_metrics()`. It finds the counter in the returned snapshot, unwraps the single sum point, converts attributes to a map, and asserts equality with a map containing manager metadata (`app.version`, `auth_mode`, `model`, `originator`, `session_source`) plus the default and per-call tags.

**Call relations**: This test is invoked directly by the test runner and exercises the snapshot path through the `SessionTelemetry` wrapper rather than the raw metrics client.

*Call graph*: calls 6 internal fn (new, new, in_memory, attributes_to_map, find_metric, new); 5 external calls (from, default, assert_eq!, env!, panic!).


### `otel/tests/suite/runtime_summary.rs`

`test` · `runtime metrics aggregation verification`

This file contains a single integration-style test for the runtime metrics reader path. It creates an `InMemoryMetricExporter`, builds a `MetricsClient` from `MetricsConfig::in_memory(...).with_runtime_reader()`, and attaches that client to a `SessionTelemetry` populated with realistic session metadata. The test then explicitly resets runtime metrics and emits a representative mix of telemetry: a tool result with a 250 ms duration, an API request with a 300 ms duration, a websocket request with a 400 ms duration, one SSE event with a 120 ms duration, and two websocket events totaling 100 ms. One websocket event payload is a synthetic `responsesapi.websocket_timing` JSON message containing engine and overhead timing fields; the test expects those values to be parsed into dedicated summary fields.

It also records turn-level duration histograms for TTFT and TTFM. Finally, it calls `runtime_metrics_summary()` and compares the returned `RuntimeMetricsSummary` struct against a fully populated expected value. The assertions document the summary contract precisely: counts and cumulative durations are grouped into `RuntimeMetricTotals` for tool calls, API calls, streaming events, websocket calls, and websocket events, while protocol-specific timing metrics are surfaced as scalar millisecond fields. This test therefore validates both accumulation and extraction logic from heterogeneous telemetry sources.

#### Function details

##### `runtime_metrics_summary_collects_tool_api_and_streaming_metrics`  (lines 17–142)

```
fn runtime_metrics_summary_collects_tool_api_and_streaming_metrics() -> Result<()>
```

**Purpose**: Exercises the runtime metrics summary end to end by recording tool, API, SSE, websocket, and turn timing telemetry and then reading back the aggregated summary. It verifies both simple counters/durations and parsed websocket timing metrics.

**Data flow**: It creates an in-memory exporter and metrics client with a runtime reader, constructs `SessionTelemetry` with attached metrics, and calls `reset_runtime_metrics()`. It then emits a tool result, API request, websocket request, one SSE event result, two websocket event results (including one JSON timing payload), and two named duration metrics for TTFT and TTFM. Finally it calls `runtime_metrics_summary()`, unwraps the returned summary, and compares it to an expected `RuntimeMetricsSummary` containing exact counts, cumulative durations, and extracted timing fields such as `responses_api_overhead_ms` and `responses_api_engine_service_ttft_ms`.

**Call relations**: This is a direct test entrypoint for the runtime-summary feature. It drives multiple `SessionTelemetry` recording methods in sequence so the summary reader can aggregate across all supported runtime metric categories.

*Call graph*: calls 4 internal fn (new, new, in_memory, new); 6 external calls (from_millis, default, new, assert_eq!, env!, Text).


### `otel/tests/suite/manager_metrics.rs`

`test` · `metrics emission and shutdown verification`

This test file exercises `SessionTelemetry` as the higher-level wrapper around `MetricsClient`, focusing on the exact attribute sets attached to exported metrics. Each test builds an in-memory metrics pipeline with `build_metrics_with_defaults`, constructs a `SessionTelemetry` with concrete session metadata (`ThreadId`, model names, optional account/auth fields, originator, terminal kind, and `SessionSource::Cli`), records one metric, shuts the metrics pipeline down, and inspects the exported `AggregatedMetrics` payload. The assertions are intentionally concrete: they descend into `MetricData::Sum` for `U64` counters, require exactly one data point, and convert OpenTelemetry attributes into a `BTreeMap<String, String>` for stable comparison.

The file covers three important design choices. First, manager-level metadata tags such as `app.version`, `auth_mode`, `model`, `originator`, and `session_source` are automatically merged into metric attributes unless explicitly disabled. Second, a separately configured `service_name` tag is optional and only appears when set through `with_metrics_service_name`. Third, the plugin-install helper methods intentionally emit reduced attribute sets: the tests confirm that only the public, low-cardinality fields (`tool_type`, `response_action`, `completed`) survive, while more identifying inputs like plugin IDs or display names are not asserted as exported attributes. These tests therefore document both enrichment and redaction behavior.

#### Function details

##### `manager_attaches_metadata_tags_to_metrics`  (lines 19–75)

```
fn manager_attaches_metadata_tags_to_metrics() -> Result<()>
```

**Purpose**: Verifies that a `SessionTelemetry` configured with metrics enrichment adds session metadata tags to a normal counter metric. The test confirms that per-call tags are merged with manager metadata and default metrics tags.

**Data flow**: It creates an in-memory metrics/exporter pair with a default `service=codex-cli` tag, constructs `SessionTelemetry::new(...)` with model, account, auth mode, originator, terminal, and CLI session source, then attaches metrics via `with_metrics`. It records `codex.session_started` with increment `1` and a per-call `source=tui` tag, shuts metrics down, reads the latest exported resource metrics, extracts the single `U64` sum point, converts its attributes to a `BTreeMap`, and compares that map against the expected merged attributes.

**Call relations**: This is a top-level test entrypoint. It drives the normal manager metric path by invoking the constructor and metrics attachment path, then uses the shared harness helpers to locate and decode the exported metric after shutdown.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 4 external calls (from, assert_eq!, env!, panic!).


##### `manager_allows_disabling_metadata_tags`  (lines 79–121)

```
fn manager_allows_disabling_metadata_tags() -> Result<()>
```

**Purpose**: Checks that `SessionTelemetry` can emit metrics without automatically attaching session metadata. It proves that only explicitly supplied metric tags remain when metadata tagging is disabled.

**Data flow**: It builds an in-memory metrics client with no default tags, creates a populated `SessionTelemetry`, and attaches metrics through `with_metrics_without_metadata_tags`. After recording `codex.session_started` with `source=tui`, it shuts down the exporter, finds the emitted counter, unwraps the single `U64` sum point, converts attributes to a map, and asserts that the map contains only `source=tui`.

**Call relations**: This test follows the same export-inspection pattern as the previous one, but exercises the alternate attachment path that suppresses manager metadata. It relies on the harness helpers to inspect the resulting metric payload.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 3 external calls (from, assert_eq!, panic!).


##### `manager_attaches_optional_service_name_tag`  (lines 124–165)

```
fn manager_attaches_optional_service_name_tag() -> Result<()>
```

**Purpose**: Confirms that `SessionTelemetry` can inject an additional `service_name` metric attribute when configured explicitly. The test isolates this optional tag from the rest of the metadata behavior.

**Data flow**: It creates metrics/exporter state, builds a `SessionTelemetry` without account or auth metadata, sets an explicit service name through `with_metrics_service_name("my_app_server_client")`, then attaches metrics and records `codex.session_started`. After shutdown it extracts the single counter point's attributes and asserts that the `service_name` key exists with the configured value.

**Call relations**: This test is invoked directly by the test runner and exercises the builder-style configuration chain on `SessionTelemetry` before metric emission. It delegates metric lookup and attribute decoding to the shared harness utilities.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 2 external calls (assert_eq!, panic!).


##### `manager_records_plugin_install_suggestion_metric`  (lines 168–219)

```
fn manager_records_plugin_install_suggestion_metric() -> Result<()>
```

**Purpose**: Validates the specialized plugin-install suggestion metric emitted by `SessionTelemetry`. It checks that the exported counter uses the expected metric name constant and only the intended summary attributes.

**Data flow**: It builds in-memory metrics, creates a telemetry manager with metadata tagging disabled, and calls `record_plugin_install_suggestion` with tool type `connector`, an internal tool identifier, display name, response action `accept`, `user_confirmed=true`, and `completed=false`. After shutdown it finds the metric named by `PLUGIN_INSTALL_SUGGESTION_METRIC`, unwraps the single `U64` sum point, converts attributes to a map, and asserts equality with a map containing `completed=false`, `response_action=accept`, and `tool_type=connector`.

**Call relations**: This test covers one of the manager's domain-specific metric helpers rather than the generic `counter` API. It uses the same post-shutdown inspection flow as the other tests to verify the helper's attribute-shaping behavior.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 2 external calls (assert_eq!, panic!).


##### `manager_records_plugin_install_elicitation_sent_metric`  (lines 222–262)

```
fn manager_records_plugin_install_elicitation_sent_metric() -> Result<()>
```

**Purpose**: Checks the metric emitted when a plugin-install elicitation is sent. It ensures the helper records the expected metric name and a minimal attribute set.

**Data flow**: It creates in-memory metrics, constructs a telemetry manager with metadata tags disabled, and calls `record_plugin_install_elicitation_sent` with tool type `plugin`, a concrete plugin identifier, and display name `Slack`. After shutdown it locates the metric named by `PLUGIN_INSTALL_ELICITATION_SENT_METRIC`, extracts the single counter point, converts attributes to a map, and asserts that only `tool_type=plugin` is present.

**Call relations**: This is another direct test of a specialized `SessionTelemetry` helper. It follows the same harness-driven export decoding path to verify that the helper emits a low-cardinality metric payload.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 2 external calls (assert_eq!, panic!).


### Telemetry export and routing
These tests cover how telemetry is routed between logs and traces and how complete OTLP/HTTP exports are emitted over the wire.

### `otel/tests/suite/otel_export_routing_policy.rs`

`test` · `request/event telemetry routing verification`

This file builds end-to-end in-memory log and trace pipelines around `OtelProvider::log_export_filter` and `OtelProvider::trace_export_filter`, then emits `SessionTelemetry` events inside a root tracing span to inspect how fields are routed. The helper functions are central to the assertions: `log_attributes` converts an `SdkLogRecord`'s attributes into a stable `BTreeMap`, `span_event_attributes` does the same for trace events, `any_value_to_string` normalizes OpenTelemetry `AnyValue` variants into strings, and the two `find_*_by_*` helpers locate a specific log or span event by its `event.name` attribute.

The tests cover several event families. User prompts and tool results are intentionally split: logs retain sensitive payloads such as prompt text, tool arguments, output, and user email, while trace events keep only derived counts and lengths (`prompt_length`, `output_line_count`, etc.) and explicitly omit raw content. Auth recovery and API/websocket auth observability events are different: they are expected to appear in both logs and traces with concrete auth-related attributes like `auth.header_attached`, `auth.recovery_phase`, request IDs, Cloudflare ray IDs, and environment-derived auth metadata from `AuthEnvTelemetryMetadata`. Each test constructs a subscriber with both OTEL layers attached, forces flush on both providers, then inspects the exported records to prove the routing policy is deterministic and privacy-aware.

#### Function details

##### `log_attributes`  (lines 28–33)

```
fn log_attributes(record: &SdkLogRecord) -> BTreeMap<String, String>
```

**Purpose**: Converts an `SdkLogRecord`'s attribute iterator into a sorted string map suitable for assertions. It gives the tests a uniform representation regardless of the underlying OTEL value types.

**Data flow**: It reads `(key, value)` pairs from `record.attributes_iter()`, converts each key to `String`, converts each `AnyValue` through `any_value_to_string`, and collects the results into a `BTreeMap<String, String>`. It does not mutate external state.

**Call relations**: This helper is called by all log-routing tests after logs are exported. It sits between raw OTEL log records and the concrete equality assertions on individual attributes.

*Call graph*: called by 6 (otel_export_routing_policy_routes_api_request_auth_observability, otel_export_routing_policy_routes_auth_recovery_log_and_trace_events, otel_export_routing_policy_routes_tool_result_log_and_trace_events, otel_export_routing_policy_routes_user_prompt_log_and_trace_events, otel_export_routing_policy_routes_websocket_connect_auth_observability, otel_export_routing_policy_routes_websocket_request_transport_observability); 1 external calls (attributes_iter).


##### `span_event_attributes`  (lines 35–41)

```
fn span_event_attributes(event: &opentelemetry::trace::Event) -> BTreeMap<String, String>
```

**Purpose**: Builds a stable string map from a trace event's attribute list. The tests use it to inspect trace-safe event payloads without depending on OTEL's internal structures.

**Data flow**: It reads the `attributes` vector from an `opentelemetry::trace::Event`, converts each `KeyValue` key to `String`, converts each value with `to_string()`, and collects the pairs into a `BTreeMap<String, String>`. It returns the map without side effects.

**Call relations**: This helper is used by every trace-routing test after spans are flushed and exported. It provides the normalized view that the tests compare against expected trace attributes.

*Call graph*: called by 6 (otel_export_routing_policy_routes_api_request_auth_observability, otel_export_routing_policy_routes_auth_recovery_log_and_trace_events, otel_export_routing_policy_routes_tool_result_log_and_trace_events, otel_export_routing_policy_routes_user_prompt_log_and_trace_events, otel_export_routing_policy_routes_websocket_connect_auth_observability, otel_export_routing_policy_routes_websocket_request_transport_observability).


##### `any_value_to_string`  (lines 43–54)

```
fn any_value_to_string(value: &AnyValue) -> String
```

**Purpose**: Normalizes OpenTelemetry log `AnyValue` variants into strings for deterministic assertions. It handles primitive, byte, list, and map values explicitly.

**Data flow**: It pattern-matches on the input `&AnyValue`: integers, doubles, booleans, and strings are converted directly; bytes are decoded with `String::from_utf8_lossy`; list and map variants are formatted with debug output; all remaining variants fall back to debug formatting. It returns the resulting `String` and writes no state.

**Call relations**: This helper is used indirectly by all log assertions through `log_attributes`. It encapsulates the value-conversion policy so the tests can compare plain strings.

*Call graph*: 4 external calls (as_str, to_string, from_utf8_lossy, format!).


##### `find_log_by_event_name`  (lines 56–67)

```
fn find_log_by_event_name(
    logs: &'a [opentelemetry_sdk::logs::in_memory_exporter::LogDataWithResource],
    event_name: &str,
) -> &'a opentelemetry_sdk::logs::in_memory_exporter::LogDataWithReso
```

**Purpose**: Finds the exported log record whose `event.name` attribute matches a requested telemetry event. It fails the test immediately if no such log exists.

**Data flow**: It iterates over a slice of `LogDataWithResource`, converts each record's attributes with `log_attributes`, checks whether the `event.name` entry equals the requested `event_name`, and returns a reference to the first matching log. If none match, it panics with `expect`.

**Call relations**: Each log-routing test uses this helper after collecting emitted logs to isolate the specific event under inspection, such as `codex.user_prompt` or `codex.api_request`.

*Call graph*: called by 6 (otel_export_routing_policy_routes_api_request_auth_observability, otel_export_routing_policy_routes_auth_recovery_log_and_trace_events, otel_export_routing_policy_routes_tool_result_log_and_trace_events, otel_export_routing_policy_routes_user_prompt_log_and_trace_events, otel_export_routing_policy_routes_websocket_connect_auth_observability, otel_export_routing_policy_routes_websocket_request_transport_observability); 1 external calls (iter).


##### `find_span_event_by_name_attr`  (lines 69–81)

```
fn find_span_event_by_name_attr(
    events: &'a [opentelemetry::trace::Event],
    event_name: &str,
) -> &'a opentelemetry::trace::Event
```

**Purpose**: Locates a trace event by its `event.name` attribute within a finished span's event list. It gives the tests a direct handle on the event payload they want to inspect.

**Data flow**: It iterates over a slice of `opentelemetry::trace::Event`, converts each event's attributes with `span_event_attributes`, checks for a matching `event.name`, and returns a reference to the first match. If no event matches, it panics via `expect`.

**Call relations**: All trace-routing tests call this helper after retrieving finished spans. It narrows a span's event list down to the single telemetry event being asserted.

*Call graph*: called by 6 (otel_export_routing_policy_routes_api_request_auth_observability, otel_export_routing_policy_routes_auth_recovery_log_and_trace_events, otel_export_routing_policy_routes_tool_result_log_and_trace_events, otel_export_routing_policy_routes_user_prompt_log_and_trace_events, otel_export_routing_policy_routes_websocket_connect_auth_observability, otel_export_routing_policy_routes_websocket_request_transport_observability); 1 external calls (iter).


##### `auth_env_metadata`  (lines 83–92)

```
fn auth_env_metadata() -> AuthEnvTelemetryMetadata
```

**Purpose**: Constructs a fixed `AuthEnvTelemetryMetadata` fixture used by auth-observability tests. The values are chosen to make presence/absence assertions explicit.

**Data flow**: It returns a new `AuthEnvTelemetryMetadata` struct with hard-coded booleans and `Some("configured")` for the provider key name. It reads no external state and mutates nothing.

**Call relations**: The API-request and websocket auth tests call this helper when enriching `SessionTelemetry` with environment-derived auth metadata before emitting events.


##### `otel_export_routing_policy_routes_user_prompt_log_and_trace_events`  (lines 95–203)

```
fn otel_export_routing_policy_routes_user_prompt_log_and_trace_events()
```

**Purpose**: Verifies that user prompt telemetry is split correctly: raw prompt content and user email go only to logs, while traces receive only aggregate prompt statistics. It also checks that all exported logs are routed through the log-only target.

**Data flow**: The test creates in-memory log and span exporters, builds corresponding OTEL providers and tracing layers, and installs a subscriber with both layers filtered by `OtelProvider` routing predicates. Inside `with_default`, it rebuilds tracing interest, constructs `SessionTelemetry`, enters a root span, and emits `manager.user_prompt(...)` with one text input, one remote image, and one local image. After forcing flush, it reads exported logs and spans, asserts log targets, extracts the `codex.user_prompt` log and trace event, converts attributes with the helpers, and checks that logs contain `prompt` and `user.email` while traces contain only counts and lengths and omit sensitive fields.

**Call relations**: This is a top-level routing-policy test. It exercises the `SessionTelemetry::user_prompt` emission path under a subscriber configured with both OTEL sinks, then delegates record lookup and normalization to the local helper functions.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 11 external calls (default, default, builder, builder, assert!, assert_eq!, new, with_default, layer, filter_fn (+1 more)).


##### `otel_export_routing_policy_routes_tool_result_log_and_trace_events`  (lines 206–314)

```
fn otel_export_routing_policy_routes_tool_result_log_and_trace_events()
```

**Purpose**: Checks that tool-result telemetry keeps raw arguments, output, and MCP metadata in logs but emits only summarized lengths/counts in traces. It validates the privacy boundary for tool execution events.

**Data flow**: It sets up in-memory log and trace exporters and a dual-layer subscriber exactly as in the prompt test. Inside the subscriber context it creates `SessionTelemetry`, enters a root span, and emits `tool_result_with_tags` for a `shell` tool call with secret arguments, multiline output, and extra tags `mcp_server` and `mcp_server_origin`. After flushing, it inspects the `codex.tool_result` log and trace event: the log attribute map must include raw arguments/output and MCP tags, while the trace attribute map must include `arguments_length`, `output_length`, and `output_line_count` and must not include the raw or MCP fields.

**Call relations**: This test is another direct consumer of the shared setup and helper functions. It specifically drives the `SessionTelemetry::tool_result_with_tags` path to verify sink-specific field routing.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 11 external calls (default, default, builder, builder, assert!, assert_eq!, new, with_default, layer, filter_fn (+1 more)).


##### `otel_export_routing_policy_routes_auth_recovery_log_and_trace_events`  (lines 317–460)

```
fn otel_export_routing_policy_routes_auth_recovery_log_and_trace_events()
```

**Purpose**: Ensures auth-recovery telemetry is exported to both logs and traces with the same concrete auth fields. Unlike prompt/tool payloads, these observability fields are expected to be trace-safe.

**Data flow**: It builds in-memory log and trace pipelines, installs the filtered subscriber, creates `SessionTelemetry` with `TelemetryAuthMode::Chatgpt`, enters a root span, and emits `record_auth_recovery` with mode, step, outcome, request identifiers, error strings, and `state_changed=true`. After flushing, it finds the `codex.auth_recovery` log and trace event, converts both to maps, and asserts that both contain the same auth-related keys and values.

**Call relations**: This test uses the same subscriber wiring as the previous routing tests but exercises the auth-recovery event path. It demonstrates that not all events are split asymmetrically; some are duplicated across both sinks.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 10 external calls (default, default, builder, builder, assert_eq!, new, with_default, layer, filter_fn, registry).


##### `otel_export_routing_policy_routes_api_request_auth_observability`  (lines 463–644)

```
fn otel_export_routing_policy_routes_api_request_auth_observability()
```

**Purpose**: Verifies that API request telemetry carries auth-header, recovery, endpoint, error, and auth-environment metadata into both logs and traces. It also checks that conversation-start events inherit auth environment metadata.

**Data flow**: It creates in-memory exporters and a dual OTEL subscriber, then inside the subscriber context constructs `SessionTelemetry`, enriches it with `with_auth_env(auth_env_metadata())`, enters a root span, emits `conversation_starts(...)`, and then emits `record_api_request(...)` with a 401 status, auth-header details, retry/recovery flags, endpoint `/responses`, request IDs, and auth error fields. After flushing, it extracts the `codex.conversation_starts` and `codex.api_request` logs plus the corresponding trace events, converts attributes to maps, and asserts the presence of specific auth environment and request observability fields in both sinks.

**Call relations**: This test extends the routing-policy coverage from privacy splitting into auth observability propagation. It depends on `auth_env_metadata` for fixture data and on the helper lookup/conversion functions for assertions.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 10 external calls (default, default, builder, builder, assert_eq!, new, with_default, layer, filter_fn, registry).


##### `otel_export_routing_policy_routes_websocket_connect_auth_observability`  (lines 647–761)

```
fn otel_export_routing_policy_routes_websocket_connect_auth_observability()
```

**Purpose**: Checks that websocket connection telemetry exports auth and endpoint observability fields to logs and traces, including connection reuse and recovery-phase details. It confirms websocket connect events receive the same auth-environment enrichment as API requests.

**Data flow**: It sets up in-memory log and trace exporters and the filtered subscriber, creates `SessionTelemetry` enriched with `auth_env_metadata`, enters a root span, and emits `record_websocket_connect(...)` with latency, 401 status, auth-header details, retry/recovery metadata, endpoint `/responses`, `connection_reused=false`, request IDs, and auth error fields. After flushing, it finds the `codex.websocket_connect` log and trace event, converts attributes to maps, and asserts the expected log-side and trace-side auth fields.

**Call relations**: This test follows the same orchestration pattern as the API-request test but drives the websocket-connect event path. It uses the local helpers to isolate and inspect the exported event in each sink.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 10 external calls (default, default, builder, builder, assert_eq!, new, with_default, layer, filter_fn, registry).


##### `otel_export_routing_policy_routes_websocket_request_transport_observability`  (lines 764–851)

```
fn otel_export_routing_policy_routes_websocket_request_transport_observability()
```

**Purpose**: Verifies that websocket request transport telemetry exports connection reuse, error message, and auth-environment metadata to both logs and traces. It covers the lower-level request/stream path rather than initial connection setup.

**Data flow**: It constructs in-memory log and trace exporters, installs the filtered subscriber, creates `SessionTelemetry` with auth environment metadata, enters a root span, and emits `record_websocket_request(...)` with a 23 ms duration, error message `stream error`, and `connection_reused=true`. After flushing, it extracts the `codex.websocket_request` log and trace event, converts attributes to maps, and asserts the expected transport and auth-environment fields in each.

**Call relations**: This is the final routing-policy test in the file. It reuses the same subscriber/exporter setup and helper functions, but targets the websocket request event path to complete auth/transport observability coverage.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 10 external calls (default, default, builder, builder, assert_eq!, new, with_default, layer, filter_fn, registry).


### `otel/tests/suite/otlp_http_loopback.rs`

`test` · `exporter integration and transport verification`

This file is a full-stack transport test for the OTLP/HTTP exporters in `codex_otel`. Instead of mocking the exporter, it starts a real `TcpListener` on `127.0.0.1:0`, accepts connections in a background thread, parses incoming HTTP requests, and stores each request's path, content type, and body in a local `CapturedRequest` struct. `read_http_request` implements a minimal HTTP/1.1 parser with explicit timeouts, incremental reads, header/body size guards, UTF-8 validation for headers, lower-cased header names, and `Content-Length`-based body collection. `write_http_response` sends a minimal empty response so the exporter can complete normally.

The tests then configure either `MetricsClient` or `OtelProvider` with `OtelExporter::OtlpHttp` using JSON protocol and point the endpoint at the loopback server. Metrics tests verify `/v1/metrics` requests contain counter and gauge names plus tags. Log tests install the provider's logger layer and assert `/v1/logs` contains the emitted `event.name`. Trace tests install the tracing layer, emit spans and events, and assert `/v1/traces` contains span names, service metadata, configured span attributes, and trace events. The trace tests also cover W3C propagation helpers: they set a parent from `W3cTraceContext`, read back the current span context, and verify configured tracestate entries merge safely with incoming tracestate. A global `TRACE_CONTEXT_CONFIG_LOCK` serializes tests that mutate trace-context-related configuration so concurrent test execution cannot interfere.

#### Function details

##### `read_http_request`  (lines 33–134)

```
fn read_http_request(
    stream: &mut TcpStream,
) -> std::io::Result<(String, HashMap<String, String>, Vec<u8>)>
```

**Purpose**: Reads and parses a single HTTP request from a `TcpStream` for the loopback collector. It is intentionally minimal but robust enough to capture OTLP/HTTP exporter traffic in tests.

**Data flow**: It takes a mutable `TcpStream`, sets a 2-second read timeout, and repeatedly reads into a scratch buffer through a retrying closure that tolerates `WouldBlock` and `Interrupted` until a deadline. It accumulates bytes until `\r\n\r\n` marks the end of headers, rejects oversized headers, decodes headers as UTF-8, parses the request line to extract the path, lowercases and stores headers in a `HashMap<String, String>`, then if `content-length` is present continues reading until the full body is available, rejecting premature EOF or oversized bodies. It returns `(path, headers, body_bytes)`.

**Call relations**: This helper is called by each background loopback server thread whenever a connection is accepted. The export tests depend on it to turn raw exporter traffic into structured request captures for later assertions.

*Call graph*: 7 external calls (from_secs, new, now, set_read_timeout, new, new, from_utf8).


##### `write_http_response`  (lines 136–140)

```
fn write_http_response(stream: &mut TcpStream, status: &str) -> std::io::Result<()>
```

**Purpose**: Sends a minimal HTTP/1.1 response back to the exporter so the client side can complete its request successfully. The status line is parameterized to let tests simulate acceptance.

**Data flow**: It formats an HTTP response string with the provided status, zero content length, and `Connection: close`, writes the bytes to the mutable `TcpStream`, and flushes the stream. It returns any I/O error from `write_all` or `flush`.

**Call relations**: Each loopback server thread calls this immediately after attempting to parse a request. It complements `read_http_request` by completing the request-response exchange expected by the OTLP exporter.

*Call graph*: 3 external calls (flush, write_all, format!).


##### `otlp_http_exporter_sends_metrics_to_collector`  (lines 143–231)

```
fn otlp_http_exporter_sends_metrics_to_collector() -> Result<()>
```

**Purpose**: Verifies that the OTLP/HTTP metrics exporter sends JSON payloads to `/v1/metrics` and includes the recorded metric names and tags. It exercises both counter and gauge export through a real HTTP connection.

**Data flow**: The test binds a nonblocking loopback listener, spawns a server thread that accepts connections, parses requests with `read_http_request`, responds `202 Accepted`, and sends captured requests back over an `mpsc` channel. It constructs a `MetricsClient` using `MetricsConfig::otlp(...)` with an `OtlpHttp` exporter pointed at `http://{addr}/v1/metrics`, records a counter, histogram, and gauge, then shuts the client down. After joining the server and receiving captures, it finds the `/v1/metrics` request, checks that `content-type` starts with `application/json`, decodes the body lossily, and asserts that the body contains `codex.turns`, `codex.active`, and the `component=test` tag.

**Call relations**: This is a top-level integration test for the metrics export path. It drives the real exporter over TCP and relies on the local loopback server helpers to capture and inspect the outbound request.

*Call graph*: calls 2 internal fn (new, otlp); 8 external calls (from_secs, new, from_utf8_lossy, bind, assert!, env!, format!, spawn).


##### `otlp_http_exporter_sends_logs_to_collector`  (lines 234–323)

```
fn otlp_http_exporter_sends_logs_to_collector() -> std::result::Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Checks that OTEL log export over HTTP reaches `/v1/logs` with a JSON payload containing the emitted log event name. It validates the provider's logger layer and log exporter wiring.

**Data flow**: It starts the same style of loopback server and then builds an `OtelProvider` from `OtelSettings` with `exporter` set to an `OtlpHttp` endpoint at `/v1/logs`, while trace and metrics exporters are disabled. It obtains `logger_layer()`, installs it on a tracing subscriber, emits a `tracing::event!` targeted at `codex_otel.log_only` with `event.name = "codex.test.log_exported"`, and calls `otel.shutdown()`. After collecting captured requests, it finds the `/v1/logs` request, checks JSON content type, decodes the body, and asserts that the event name appears in the payload.

**Call relations**: This test exercises the provider-level log export path rather than the standalone metrics client. It depends on the loopback server helpers and on `OtelProvider::from` to build the logger layer under test.

*Call graph*: calls 1 internal fn (from); 12 external calls (new, from_secs, new, from, from_utf8_lossy, bind, assert!, env!, format!, spawn (+2 more)).


##### `otel_provider_rejects_header_unsafe_configured_tracestate`  (lines 326–352)

```
fn otel_provider_rejects_header_unsafe_configured_tracestate()
```

**Purpose**: Ensures provider construction fails when configured tracestate contains header-unsafe values. This protects OTLP/trace propagation from invalid newline-containing entries.

**Data flow**: It calls `OtelProvider::from(&OtelSettings { ... })` with a trace exporter configured for OTLP/HTTP and a `tracestate` map containing `"one\ntwo"` as a value. It captures the resulting error, asserts that provider creation failed, and checks that the error string mentions `configured tracestate value`.

**Call relations**: This is a direct configuration-validation test. Unlike the loopback export tests, it never starts a provider successfully or emits telemetry; it verifies rejection during provider construction.

*Call graph*: calls 1 internal fn (from); 6 external calls (from, new, new, from, assert!, env!).


##### `otlp_http_exporter_sends_traces_to_collector`  (lines 355–497)

```
fn otlp_http_exporter_sends_traces_to_collector() -> std::result::Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Verifies end-to-end OTLP/HTTP trace export, including span export, trace event export, configured span attributes, and tracestate merging with propagated parent context. It is the most complete trace loopback test in the file.

**Data flow**: The test first acquires `TRACE_CONTEXT_CONFIG_LOCK` to serialize trace-context-sensitive execution, then starts the loopback server. It builds an `OtelProvider` with `trace_exporter` pointing at `/v1/traces`, configured span attributes, and configured tracestate entries. After installing `tracing_layer()` on a subscriber, it creates a span with OTEL semantic fields, sets its parent from a `W3cTraceContext` containing both `traceparent` and incoming `tracestate`, enters the span, reads back `current_span_w3c_trace_context()`, emits a trace-safe event `codex.test.trace_event`, and logs an info message. After shutdown it asserts that the propagated tracestate string reflects merging of configured entries into the incoming vendor entry, then inspects the captured `/v1/traces` request body for the span name, service name, configured attribute, and trace event name.

**Call relations**: This test combines the loopback transport harness with the trace-context helper APIs from `codex_otel`. It validates both exporter transport and propagation behavior in one flow.

*Call graph*: calls 1 internal fn (from); 13 external calls (from, from_secs, new, from, from_utf8_lossy, bind, assert!, assert_eq!, env!, format! (+3 more)).


##### `otlp_http_exporter_sends_traces_to_collector_in_tokio_runtime`  (lines 500–600)

```
async fn otlp_http_exporter_sends_traces_to_collector_in_tokio_runtime() -> std::result::Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Checks that OTLP/HTTP trace export works correctly when the test itself runs inside a multi-threaded Tokio runtime. It guards against runtime-specific exporter issues.

**Data flow**: Under `#[tokio::test]`, it acquires the trace-context lock, starts the loopback server, constructs an `OtelProvider` with an OTLP/HTTP trace exporter to `/v1/traces`, installs the tracing layer on a subscriber, emits a span named `trace-loopback-tokio` and an info event inside that span, then shuts the provider down. After collecting captured requests, it verifies the `/v1/traces` request has JSON content type and that the body contains the span name and service name.

**Call relations**: This test mirrors the synchronous trace loopback test but specifically exercises the exporter under Tokio's multi-thread runtime. It uses the same local server capture pattern for assertions.

*Call graph*: calls 1 internal fn (from); 12 external calls (new, from_secs, new, from, from_utf8_lossy, bind, assert!, env!, format!, spawn (+2 more)).


##### `otlp_http_exporter_sends_traces_to_collector_in_current_thread_tokio_runtime`  (lines 603–722)

```
fn otlp_http_exporter_sends_traces_to_collector_in_current_thread_tokio_runtime() -> std::result::Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Verifies trace export also succeeds inside a manually created current-thread Tokio runtime running on a dedicated OS thread. It covers another runtime integration mode that can expose shutdown or scheduling bugs.

**Data flow**: It acquires the trace-context lock, starts the loopback server, then spawns a separate thread that builds a current-thread Tokio runtime and runs an async block. Inside that runtime it constructs an `OtelProvider` with an OTLP/HTTP trace exporter to `/v1/traces`, installs the tracing layer, emits a span named `trace-loopback-current-thread` with an info event, shuts the provider down, and sends the result back over an `mpsc` channel. The outer test waits for runtime completion, joins the runtime thread and server thread, then inspects the captured `/v1/traces` request for JSON content type, span name, and service name.

**Call relations**: This test is the runtime-variant companion to the previous trace tests. It adds an extra thread and result channel around the same provider/exporter flow to validate current-thread Tokio compatibility.

*Call graph*: 5 external calls (from_secs, from_utf8_lossy, bind, assert!, spawn).


### Analytics client and fixtures
These files build up analytics-focused fixtures and verify analytics client behavior from transport decisions to full reducer-driven event generation.

### `analytics/src/client_tests.rs`

`test` · `test execution`

This file is the focused unit-test companion to `analytics/src/client.rs`. Unlike the larger reducer-oriented test suite, these tests target the client façade and delivery helpers directly. The helper constructors build minimal `TrackEventRequest` values—one regular skill invocation event and one accepted-line-fingerprint event—plus representative client requests and responses for turn start/steer, thread lifecycle, and an ignored thread archive case.

A key theme is destination behavior. In debug builds, tests verify that `AnalyticsEventsDestination::from_base_url_and_capture_file` chooses `CaptureFile`, creates the file immediately, and on Unix applies mode `0o600`. Additional async tests send captured requests through `send_track_events_request`, then read the JSONL file back to confirm exact serialized payloads and that isolated batches become separate lines. Another test confirms that capture write failures still count as consumed delivery, matching the production design that capture mode disables network fallback.

The file also validates client-side filtering and batching. `client_with_receiver` constructs an `AnalyticsEventsClient` around a test channel so tests can inspect raw `AnalyticsFact`s emitted by `track_request` and `track_response`. Those tests prove only analytics-relevant request/response variants are enqueued. Finally, `track_event_request_batches_only_isolates_accepted_line_fingerprint_events` documents the batching rule that accepted-line fingerprint events must be sent in isolated requests while ordinary events can be grouped before and after them.

#### Function details

##### `sample_accepted_line_fingerprint_event`  (lines 50–68)

```
fn sample_accepted_line_fingerprint_event(thread_id: &str) -> TrackEventRequest
```

**Purpose**: Builds a minimal accepted-line-fingerprints analytics event fixture for batching and capture tests.

**Data flow**: Accepts `thread_id`, constructs a boxed `CodexAcceptedLineFingerprintsEventRequest` with fixed turn id, counts, and empty fingerprints, wraps it in `TrackEventRequest::AcceptedLineFingerprints`, and returns it.

**Call relations**: Used by batching tests to represent the event type that must be isolated into its own request.

*Call graph*: 3 external calls (new, new, AcceptedLineFingerprints).


##### `sample_regular_track_event`  (lines 70–86)

```
fn sample_regular_track_event(thread_id: &str) -> TrackEventRequest
```

**Purpose**: Builds a minimal non-isolated skill invocation analytics event fixture.

**Data flow**: Accepts `thread_id`, formats `skill-{thread_id}` as the skill id, fills `SkillInvocationEventParams` with fixed turn/model/invocation data, wraps it in `TrackEventRequest::SkillInvocation`, and returns it.

**Call relations**: Used by capture and batching tests as the ordinary event type that can share requests.

*Call graph*: called by 1 (capture_file_writes_exact_serialized_request); 2 external calls (SkillInvocation, format!).


##### `unique_capture_path`  (lines 89–98)

```
fn unique_capture_path(name: &str) -> PathBuf
```

**Purpose**: Generates a unique temporary JSONL path for capture-file tests.

**Data flow**: Accepts a name prefix, reads the current system time in nanoseconds since the Unix epoch, gets the process id, formats a filename `codex-analytics-{name}-{pid}-{nonce}.jsonl`, joins it under `std::env::temp_dir()`, and returns the `PathBuf`.

**Call relations**: Used by all capture-file tests to avoid collisions between runs.

*Call graph*: called by 4 (analytics_destination_uses_explicit_capture_file, capture_file_writes_exact_serialized_request, capture_file_writes_final_batches_as_separate_lines, capture_write_failure_still_consumes_delivery); 3 external calls (now, format!, temp_dir).


##### `client_with_receiver`  (lines 100–108)

```
fn client_with_receiver() -> (AnalyticsEventsClient, mpsc::Receiver<AnalyticsFact>)
```

**Purpose**: Constructs an enabled `AnalyticsEventsClient` backed by a test channel so tests can inspect enqueued `AnalyticsFact`s directly.

**Data flow**: Creates an `mpsc` channel, builds an `AnalyticsEventsQueue` with that sender and empty dedupe sets, wraps it in `AnalyticsEventsClient { queue: Some(queue) }`, and returns the client plus receiver.

**Call relations**: Shared by the request-filtering and response-filtering tests.

*Call graph*: called by 2 (track_request_only_enqueues_analytics_relevant_requests, track_response_only_enqueues_analytics_relevant_responses); 4 external calls (new, new, new, channel).


##### `analytics_destination_uses_explicit_capture_file`  (lines 112–140)

```
fn analytics_destination_uses_explicit_capture_file()
```

**Purpose**: Verifies that in debug builds an explicit capture-file path selects `CaptureFile`, creates the file, and applies secure Unix permissions.

**Data flow**: Generates a unique path, calls `AnalyticsEventsDestination::from_base_url_and_capture_file` with that path, asserts the returned enum variant, reads the file contents to confirm it exists and is empty, optionally checks Unix mode `0o600`, and removes the file.

**Call relations**: Tests the capture-file branch of destination selection and initialization.

*Call graph*: calls 2 internal fn (from_base_url_and_capture_file, unique_capture_path); 3 external calls (assert_eq!, metadata, remove_file).


##### `analytics_destination_uses_http_without_capture_file`  (lines 143–155)

```
fn analytics_destination_uses_http_without_capture_file()
```

**Purpose**: Verifies that without a capture file the destination is the expected HTTP endpoint URL.

**Data flow**: Calls `from_base_url_and_capture_file` with a backend-api base URL and `None`, then asserts the returned destination is `Http` with `/codex/analytics-events/events` appended.

**Call relations**: Tests the normal network-delivery branch of destination selection.

*Call graph*: calls 1 internal fn (from_base_url_and_capture_file); 1 external calls (assert_eq!).


##### `analytics_destination_ignores_capture_file_in_release`  (lines 159–171)

```
fn analytics_destination_ignores_capture_file_in_release()
```

**Purpose**: Verifies that non-debug builds ignore an explicit capture-file path and still choose HTTP delivery.

**Data flow**: Calls `from_base_url_and_capture_file` with a capture path in a release-only test configuration and asserts the result is the expected `Http` destination.

**Call relations**: Documents the compile-time behavior difference between debug and non-debug builds.

*Call graph*: calls 1 internal fn (from_base_url_and_capture_file); 2 external calls (assert_eq!, from).


##### `capture_file_writes_exact_serialized_request`  (lines 175–194)

```
async fn capture_file_writes_exact_serialized_request()
```

**Purpose**: Checks that sending one batch to a capture-file destination writes exactly one JSON line containing the serialized `TrackEventsRequest`.

**Data flow**: Creates a unique capture path and `CaptureFile` destination, builds one regular event and its expected JSON value, creates dummy auth, calls `send_track_events_request`, reads the file, parses the single line as JSON, and asserts it equals `{ "events": [expected_event] }`, then removes the file.

**Call relations**: Exercises the debug capture path inside `send_track_events_request`.

*Call graph*: calls 3 internal fn (sample_regular_track_event, unique_capture_path, create_dummy_chatgpt_auth_for_testing); 7 external calls (assert_eq!, read_to_string, remove_file, from_str, to_value, send_track_events_request, vec!).


##### `capture_file_writes_final_batches_as_separate_lines`  (lines 198–228)

```
async fn capture_file_writes_final_batches_as_separate_lines()
```

**Purpose**: Verifies that after batching, each final request batch written to a capture file occupies its own JSONL line.

**Data flow**: Creates a capture destination and dummy auth, builds a vector of regular and accepted-line events, iterates over `track_event_request_batches(events)` and sends each batch, then reads and parses all file lines and asserts there are three payloads in the expected order, finally removing the file.

**Call relations**: Tests the interaction between batching rules and capture-file delivery.

*Call graph*: calls 2 internal fn (unique_capture_path, create_dummy_chatgpt_auth_for_testing); 6 external calls (assert_eq!, read_to_string, remove_file, send_track_events_request, track_event_request_batches, vec!).


##### `capture_write_failure_still_consumes_delivery`  (lines 232–240)

```
fn capture_write_failure_still_consumes_delivery()
```

**Purpose**: Checks that capture mode reports delivery as handled even when appending to the capture file fails.

**Data flow**: Constructs a capture-file destination whose parent directory does not exist, builds a `TrackEventsRequest` with one regular event, calls `capture_track_events_request`, and asserts it returns `true`.

**Call relations**: Documents the production behavior that capture mode disables network fallback even on write failure.

*Call graph*: calls 1 internal fn (unique_capture_path); 2 external calls (assert!, vec!).


##### `sample_turn_start_request`  (lines 242–252)

```
fn sample_turn_start_request() -> ClientRequest
```

**Purpose**: Builds a minimal `ClientRequest::TurnStart` fixture for request-filtering tests.

**Data flow**: Constructs `RequestId::Integer(1)`, fills `TurnStartParams` with thread id `thread-1`, empty input, and default remaining fields, and returns the request.

**Call relations**: Used by the request-filtering test as one of the allowed request variants.

*Call graph*: called by 1 (track_request_only_enqueues_analytics_relevant_requests); 3 external calls (default, new, Integer).


##### `sample_turn_steer_request`  (lines 254–266)

```
fn sample_turn_steer_request() -> ClientRequest
```

**Purpose**: Builds a minimal `ClientRequest::TurnSteer` fixture for request-filtering tests.

**Data flow**: Constructs `RequestId::Integer(2)`, fills `TurnSteerParams` with fixed thread and expected turn ids and empty input, and returns the request.

**Call relations**: Used by the request-filtering test as the other allowed request variant.

*Call graph*: called by 1 (track_request_only_enqueues_analytics_relevant_requests); 2 external calls (new, Integer).


##### `sample_thread_archive_request`  (lines 268–275)

```
fn sample_thread_archive_request() -> ClientRequest
```

**Purpose**: Builds a `ClientRequest::ThreadArchive` fixture representing a request type that should be ignored by analytics tracking.

**Data flow**: Constructs `RequestId::Integer(3)`, fills `ThreadArchiveParams` with `thread-1`, and returns the request.

**Call relations**: Used by the request-filtering test as the ignored control case.

*Call graph*: called by 1 (track_request_only_enqueues_analytics_relevant_requests); 1 external calls (Integer).


##### `sample_thread`  (lines 277–300)

```
fn sample_thread(thread_id: &str) -> Thread
```

**Purpose**: Builds a minimal `Thread` fixture shared by thread-start, thread-resume, and thread-fork response builders.

**Data flow**: Accepts `thread_id`, fills a `Thread` with deterministic session id, preview, provider, timestamps, cwd, source, and empty turns, and returns it.

**Call relations**: Used by the three thread response helpers to avoid repeating the full thread literal.

*Call graph*: called by 3 (sample_thread_fork_response, sample_thread_resume_response, sample_thread_start_response); 3 external calls (new, test_path_buf, format!).


##### `sample_thread_start_response`  (lines 302–317)

```
fn sample_thread_start_response() -> ClientResponsePayload
```

**Purpose**: Builds a minimal `ClientResponsePayload::ThreadStart` fixture for response-filtering tests.

**Data flow**: Calls `sample_thread("thread-1")`, embeds it in `ThreadStartResponse` with fixed model/provider/policy fields, and returns the response enum.

**Call relations**: Used by the response-filtering test as one of the allowed response variants.

*Call graph*: calls 1 internal fn (sample_thread); called by 1 (track_response_only_enqueues_analytics_relevant_responses); 3 external calls (ThreadStart, new, test_path_buf).


##### `sample_thread_resume_response`  (lines 319–335)

```
fn sample_thread_resume_response() -> ClientResponsePayload
```

**Purpose**: Builds a minimal `ClientResponsePayload::ThreadResume` fixture for response-filtering tests.

**Data flow**: Calls `sample_thread("thread-2")`, embeds it in `ThreadResumeResponse` with fixed metadata, and returns the response enum.

**Call relations**: Used by the response-filtering test as another allowed response variant.

*Call graph*: calls 1 internal fn (sample_thread); called by 1 (track_response_only_enqueues_analytics_relevant_responses); 3 external calls (ThreadResume, new, test_path_buf).


##### `sample_thread_fork_response`  (lines 337–352)

```
fn sample_thread_fork_response() -> ClientResponsePayload
```

**Purpose**: Builds a minimal `ClientResponsePayload::ThreadFork` fixture for response-filtering tests.

**Data flow**: Calls `sample_thread("thread-3")`, embeds it in `ThreadForkResponse` with fixed metadata, and returns the response enum.

**Call relations**: Used by the response-filtering test to cover the thread-fork branch.

*Call graph*: calls 1 internal fn (sample_thread); called by 1 (track_response_only_enqueues_analytics_relevant_responses); 3 external calls (ThreadFork, new, test_path_buf).


##### `sample_turn_start_response`  (lines 354–367)

```
fn sample_turn_start_response() -> ClientResponsePayload
```

**Purpose**: Builds a minimal `ClientResponsePayload::TurnStart` fixture for response-filtering tests.

**Data flow**: Constructs a `Turn` with id `turn-1`, `InProgress` status, and empty items, wraps it in `TurnStartResponse`, and returns the response enum.

**Call relations**: Used by the response-filtering test as one of the allowed turn response variants.

*Call graph*: called by 1 (track_response_only_enqueues_analytics_relevant_responses); 2 external calls (TurnStart, new).


##### `sample_turn_steer_response`  (lines 369–373)

```
fn sample_turn_steer_response() -> ClientResponsePayload
```

**Purpose**: Builds a minimal `ClientResponsePayload::TurnSteer` fixture for response-filtering tests.

**Data flow**: Constructs `TurnSteerResponse { turn_id: "turn-2" }` and returns it inside `ClientResponsePayload::TurnSteer`.

**Call relations**: Used by the response-filtering test as the final allowed response variant.

*Call graph*: called by 1 (track_response_only_enqueues_analytics_relevant_responses); 1 external calls (TurnSteer).


##### `track_request_only_enqueues_analytics_relevant_requests`  (lines 376–397)

```
fn track_request_only_enqueues_analytics_relevant_requests()
```

**Purpose**: Verifies that `AnalyticsEventsClient::track_request` enqueues only turn-start and turn-steer requests and ignores unrelated request types.

**Data flow**: Builds a client and receiver with `client_with_receiver`, sends a turn-start and turn-steer request through `track_request` and asserts each yields `AnalyticsFact::ClientRequest` on the receiver, then sends a thread-archive request and asserts the receiver remains empty.

**Call relations**: Tests the request-type filtering logic in `AnalyticsEventsClient::track_request`.

*Call graph*: calls 4 internal fn (client_with_receiver, sample_thread_archive_request, sample_turn_start_request, sample_turn_steer_request); 2 external calls (Integer, assert!).


##### `track_response_only_enqueues_analytics_relevant_responses`  (lines 400–423)

```
fn track_response_only_enqueues_analytics_relevant_responses()
```

**Purpose**: Verifies that `AnalyticsEventsClient::track_response` enqueues only thread lifecycle and turn lifecycle responses and ignores unrelated responses.

**Data flow**: Builds a client and receiver, sends thread-start, thread-resume, thread-fork, turn-start, and turn-steer responses through `track_response` and asserts each yields `AnalyticsFact::ClientResponse`, then sends a thread-archive response and asserts the receiver remains empty.

**Call relations**: Tests the response-type filtering logic in `AnalyticsEventsClient::track_response`.

*Call graph*: calls 6 internal fn (client_with_receiver, sample_thread_fork_response, sample_thread_resume_response, sample_thread_start_response, sample_turn_start_response, sample_turn_steer_response); 3 external calls (ThreadArchive, Integer, assert!).


##### `track_event_request_batches_only_isolates_accepted_line_fingerprint_events`  (lines 426–443)

```
fn track_event_request_batches_only_isolates_accepted_line_fingerprint_events()
```

**Purpose**: Verifies that batching groups ordinary events together but isolates accepted-line-fingerprint events into one-event batches.

**Data flow**: Builds a mixed vector of regular and accepted-line events, passes it to `track_event_request_batches`, and asserts the number and sizes of returned batches plus that the isolated batches contain events whose `should_send_in_isolated_request()` is true.

**Call relations**: Tests the batching policy used by `send_track_events` before delivery.

*Call graph*: 4 external calls (assert!, assert_eq!, track_event_request_batches, vec!).


### `analytics/src/analytics_client_tests.rs`

`test` · `test execution`

This file is the main behavioral specification for the analytics subsystem. Most of it is test-only fixture construction around `AnalyticsReducer`, `TrackEventRequest`, and the app-server protocol types. The helper functions synthesize realistic `Thread`, `Turn`, `ClientRequest`, `ClientResponsePayload`, `ServerNotification`, approval requests/responses, plugin metadata, and custom analytics facts so tests can drive reducer state transitions without standing up a server.

A recurring pattern is staged ingestion: helpers like `ingest_initialize`, `ingest_turn_prerequisites`, `ingest_review_prerequisites`, `ingest_completed_command_execution_item`, `ingest_complete_child_turn`, and `ingest_rejected_turn_steer` feed ordered `AnalyticsFact` sequences into a reducer and collect emitted `TrackEventRequest`s. This lets tests focus on specific invariants: thread initialization should wait for client metadata, turn events require both initialization and resolved config, accepted-line events should emit once on completion from the latest diff, review events should denormalize onto tool items only within the same thread, and subagent threads should inherit parent connection metadata unless an explicit turn connection supersedes it.

The assertions are concrete JSON-shape checks, not just type checks. They verify exact field names, enum serialization, nullability, counts, timestamps, and nested metadata for app usage, plugins, hooks, compaction, guardian reviews, command execution, thread initialization, turn events, and turn-steer events. Several tests also lock down edge cases: ignored unrelated requests/responses, aborted approvals emitting once, reused item ids not crossing threads, accepted steer counts excluding rejected steers, and started-at remaining null when no start notification arrived.

Because the reducer itself lives elsewhere, this file’s value is in documenting expected control flow and state prerequisites through executable scenarios. The helper builders are intentionally repetitive and explicit so each test can assemble only the facts relevant to the behavior under scrutiny.

#### Function details

##### `sample_thread_with_metadata`  (lines 164–193)

```
fn sample_thread_with_metadata(
    thread_id: &str,
    ephemeral: bool,
    source: AppServerSessionSource,
    thread_source: Option<AppServerThreadSource>,
    parent_thread_id: Option<String>,
)
```

**Purpose**: Builds a representative `codex_app_server_protocol::Thread` fixture with configurable identity, source, and lineage fields for reducer tests.

**Data flow**: Takes `thread_id`, `ephemeral`, `source`, `thread_source`, and `parent_thread_id`; fills a `Thread` struct with deterministic session id, preview, provider, timestamps, cwd, version, and empty turns; returns the populated thread.

**Call relations**: Used by both thread-start and thread-resume response builders so tests can vary thread metadata without duplicating the full struct literal.

*Call graph*: called by 2 (sample_thread_resume_response_with_source, sample_thread_start_response); 3 external calls (new, test_path_buf, format!).


##### `sample_thread_start_response`  (lines 195–220)

```
fn sample_thread_start_response(
    thread_id: &str,
    ephemeral: bool,
    model: &str,
) -> ClientResponsePayload
```

**Purpose**: Wraps a sample thread in a `ClientResponsePayload::ThreadStart` fixture with standard model and policy metadata.

**Data flow**: Accepts `thread_id`, `ephemeral`, and `model`, calls `sample_thread_with_metadata` with `Exec`/`User` defaults and no parent, then embeds the thread plus cwd, approval, sandbox, and model fields into `ThreadStartResponse` inside `ClientResponsePayload`.

**Call relations**: Used widely by tests that need a thread lifecycle to begin from a start response. It is a common prerequisite in reducer setup helpers.

*Call graph*: calls 1 internal fn (sample_thread_with_metadata); called by 6 (guardian_review_event_ingests_custom_fact_with_optional_target_item, ingest_review_prerequisites, ingest_turn_prerequisites, initialize_caches_client_and_thread_lifecycle_publishes_once_initialized, item_review_summaries_do_not_cross_threads_with_reused_item_ids, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit); 3 external calls (ThreadStart, new, test_path_buf).


##### `sample_app_server_client_metadata`  (lines 222–230)

```
fn sample_app_server_client_metadata() -> CodexAppServerClientMetadata
```

**Purpose**: Returns a canonical `CodexAppServerClientMetadata` fixture used in serialization assertions.

**Data flow**: Constructs and returns a `CodexAppServerClientMetadata` with `DEFAULT_ORIGINATOR`, fixed client name/version, stdio transport, and `experimental_api_enabled: Some(true)`.

**Call relations**: Used by serialization-only tests that need stable expected nested client metadata in event payloads.

*Call graph*: called by 2 (compaction_event_serializes_expected_shape, turn_event_serializes_expected_shape).


##### `sample_runtime_metadata`  (lines 232–239)

```
fn sample_runtime_metadata() -> CodexRuntimeMetadata
```

**Purpose**: Returns a canonical `CodexRuntimeMetadata` fixture used across reducer and serialization tests.

**Data flow**: Constructs and returns a `CodexRuntimeMetadata` with fixed version, OS, OS version, and architecture strings.

**Call relations**: Shared by many tests and setup helpers whenever runtime metadata must be attached to initialize facts or expected event payloads.

*Call graph*: called by 7 (compaction_event_ingests_custom_fact, compaction_event_serializes_expected_shape, guardian_review_event_ingests_custom_fact_with_optional_target_item, ingest_initialize, ingest_rejected_turn_steer, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit, turn_event_serializes_expected_shape).


##### `sample_thread_resume_response`  (lines 241–254)

```
fn sample_thread_resume_response(
    thread_id: &str,
    ephemeral: bool,
    model: &str,
) -> ClientResponsePayload
```

**Purpose**: Builds a standard thread-resume response fixture using default session and thread-source values.

**Data flow**: Accepts `thread_id`, `ephemeral`, and `model`, forwards them to `sample_thread_resume_response_with_source` with `Exec`, `Some(User)`, and no parent, and returns the resulting `ClientResponsePayload`.

**Call relations**: Used by tests that need a resumed thread without customizing source or lineage. It is a convenience wrapper over the more configurable builder.

*Call graph*: calls 1 internal fn (sample_thread_resume_response_with_source); called by 2 (ingest_rejected_turn_steer, initialize_caches_client_and_thread_lifecycle_publishes_once_initialized).


##### `sample_thread_resume_response_with_source`  (lines 256–285)

```
fn sample_thread_resume_response_with_source(
    thread_id: &str,
    ephemeral: bool,
    model: &str,
    source: AppServerSessionSource,
    thread_source: Option<AppServerThreadSource>,
    paren
```

**Purpose**: Builds a `ClientResponsePayload::ThreadResume` fixture with caller-controlled session source, thread source, and parent lineage.

**Data flow**: Takes thread identity and metadata arguments, constructs the underlying thread via `sample_thread_with_metadata`, then embeds it into `ThreadResumeResponse` with standard model/provider/policy fields and returns it as `ClientResponsePayload`.

**Call relations**: Used directly by tests that need subagent or inherited-lineage scenarios, and indirectly by `sample_thread_resume_response`.

*Call graph*: calls 1 internal fn (sample_thread_with_metadata); called by 2 (compaction_event_ingests_custom_fact, sample_thread_resume_response); 3 external calls (ThreadResume, new, test_path_buf).


##### `sample_turn_start_request`  (lines 287–306)

```
fn sample_turn_start_request(thread_id: &str, request_id: i64) -> ClientRequest
```

**Purpose**: Creates a representative `ClientRequest::TurnStart` containing one text input and one image input.

**Data flow**: Accepts `thread_id` and integer `request_id`, constructs `RequestId::Integer`, fills `TurnStartParams` with the thread id, two `UserInput` entries, and defaulted remaining fields, and returns the request enum.

**Call relations**: Used by turn lifecycle setup helpers and tests that verify request tracking or pending-turn behavior.

*Call graph*: called by 3 (ingest_turn_prerequisites, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit, turn_start_error_response_discards_pending_start_request); 3 external calls (default, Integer, vec!).


##### `sample_turn_start_response`  (lines 308–321)

```
fn sample_turn_start_response(turn_id: &str) -> ClientResponsePayload
```

**Purpose**: Creates a `ClientResponsePayload::TurnStart` fixture for an in-progress turn with no items yet.

**Data flow**: Accepts `turn_id`, constructs a `Turn` with `InProgress` status and empty items, wraps it in `TurnStartResponse`, and returns `ClientResponsePayload::TurnStart`.

**Call relations**: Paired with `sample_turn_start_request` in setup helpers to establish reducer turn state.

*Call graph*: called by 4 (ingest_turn_prerequisites, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit, turn_start_error_response_discards_pending_start_request, unrelated_client_requests_are_ignored_by_reducer); 2 external calls (TurnStart, vec!).


##### `sample_turn_started_notification`  (lines 323–337)

```
fn sample_turn_started_notification(thread_id: &str, turn_id: &str) -> ServerNotification
```

**Purpose**: Builds a `ServerNotification::TurnStarted` fixture carrying a started timestamp for a turn.

**Data flow**: Takes `thread_id` and `turn_id`, constructs a `Turn` with `started_at: Some(455)` and `InProgress` status, wraps it in `TurnStartedNotification`, and returns the notification enum.

**Call relations**: Used when tests need the reducer to record explicit turn start timing before completion or item activity.

*Call graph*: called by 4 (ingest_completed_command_execution_item, ingest_turn_prerequisites, item_lifecycle_notifications_publish_command_execution_event, subagent_tool_items_inherit_parent_connection_metadata); 2 external calls (TurnStarted, vec!).


##### `sample_turn_token_usage_fact`  (lines 339–351)

```
fn sample_turn_token_usage_fact(thread_id: &str, turn_id: &str) -> TurnTokenUsageFact
```

**Purpose**: Creates a `TurnTokenUsageFact` fixture with fixed token counts for reducer tests.

**Data flow**: Accepts `thread_id` and `turn_id`, fills a `TokenUsage` struct with deterministic totals and wraps it in `TurnTokenUsageFact`.

**Call relations**: Injected by setup helpers and inheritance tests to verify token usage fields appear on emitted turn events.

*Call graph*: called by 2 (ingest_turn_prerequisites, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit).


##### `sample_turn_completed_notification`  (lines 353–376)

```
fn sample_turn_completed_notification(
    thread_id: &str,
    turn_id: &str,
    status: AppServerTurnStatus,
    codex_error_info: Option<codex_app_server_protocol::CodexErrorInfo>,
) -> ServerNoti
```

**Purpose**: Builds a `ServerNotification::TurnCompleted` fixture with configurable terminal status and optional codex error info.

**Data flow**: Takes `thread_id`, `turn_id`, terminal `AppServerTurnStatus`, and optional `CodexErrorInfo`; constructs a `Turn` with `completed_at: Some(456)`, `duration_ms: Some(1234)`, and optional wrapped `AppServerTurnError`; returns the notification enum.

**Call relations**: This is the standard terminal event used across many tests to trigger reducer emission of turn-level analytics.

*Call graph*: called by 12 (accepted_steers_increment_turn_steer_count, ingest_complete_child_turn, item_completed_without_turn_state_does_not_create_turn_state, reducer_emits_accepted_line_fingerprints_once_from_latest_turn_diff_on_completion, reducer_emits_large_accepted_line_aggregates_without_fingerprints, turn_completed_without_started_notification_emits_null_started_at, turn_does_not_emit_without_required_prerequisites, turn_event_counts_completed_tool_items, turn_lifecycle_emits_failed_turn_event, turn_lifecycle_emits_interrupted_turn_event_without_error (+2 more)); 2 external calls (TurnCompleted, vec!).


##### `sample_turn_resolved_config`  (lines 378–401)

```
fn sample_turn_resolved_config(thread_id: &str, turn_id: &str) -> TurnResolvedConfigFact
```

**Purpose**: Creates a `TurnResolvedConfigFact` fixture describing the resolved model, permissions, and session settings for a turn.

**Data flow**: Accepts `thread_id` and `turn_id`, fills a `TurnResolvedConfigFact` with fixed model/provider, read-only permission profile, cwd, approval policy, reviewer, collaboration mode, and image count, and returns it.

**Call relations**: Used by setup helpers and child-turn completion helpers because the reducer requires resolved config before it can emit a turn event.

*Call graph*: called by 3 (ingest_complete_child_turn, ingest_turn_prerequisites, turn_start_error_response_discards_pending_start_request); 2 external calls (read_only, from).


##### `sample_turn_profile`  (lines 403–413)

```
fn sample_turn_profile() -> TurnProfile
```

**Purpose**: Returns a deterministic `TurnProfile` fixture with timing and sampling counters.

**Data flow**: Constructs and returns a `TurnProfile` with fixed before/after sampling timings and request/retry counts.

**Call relations**: Injected into reducer state by setup helpers so emitted turn events can include profile metrics.

*Call graph*: called by 2 (ingest_complete_child_turn, ingest_turn_prerequisites).


##### `sample_turn_steer_request`  (lines 415–440)

```
fn sample_turn_steer_request(
    thread_id: &str,
    expected_turn_id: &str,
    request_id: i64,
) -> ClientRequest
```

**Purpose**: Creates a representative `ClientRequest::TurnSteer` with one text input and one local image input.

**Data flow**: Accepts `thread_id`, `expected_turn_id`, and integer `request_id`, constructs `TurnSteerParams` with those values plus two `UserInput` entries and empty optional metadata, and returns `ClientRequest::TurnSteer`.

**Call relations**: Used by accepted and rejected turn-steer tests and by the helper that simulates rejected steer flows.

*Call graph*: called by 3 (accepted_steers_increment_turn_steer_count, accepted_turn_steer_emits_expected_event, ingest_rejected_turn_steer); 2 external calls (Integer, vec!).


##### `sample_turn_steer_response`  (lines 442–446)

```
fn sample_turn_steer_response(turn_id: &str) -> ClientResponsePayload
```

**Purpose**: Builds a successful `ClientResponsePayload::TurnSteer` fixture naming the accepted turn id.

**Data flow**: Accepts `turn_id`, wraps it in `TurnSteerResponse`, and returns `ClientResponsePayload::TurnSteer`.

**Call relations**: Paired with `sample_turn_steer_request` in tests that verify accepted steer analytics.

*Call graph*: called by 2 (accepted_steers_increment_turn_steer_count, accepted_turn_steer_emits_expected_event); 1 external calls (TurnSteer).


##### `no_active_turn_steer_error`  (lines 448–454)

```
fn no_active_turn_steer_error() -> JSONRPCErrorError
```

**Purpose**: Creates a JSON-RPC error fixture representing a rejected steer because no active turn exists.

**Data flow**: Constructs and returns `JSONRPCErrorError` with code `-32600`, message `no active turn to steer`, and no extra data.

**Call relations**: Used by rejected-steer tests and by the pending-turn-start discard test to simulate a specific server-side rejection.

*Call graph*: called by 4 (accepted_steers_increment_turn_steer_count, rejected_turn_steer_uses_request_connection_metadata, turn_start_error_response_discards_pending_start_request, turn_steer_does_not_emit_without_pending_request).


##### `no_active_turn_steer_error_type`  (lines 456–458)

```
fn no_active_turn_steer_error_type() -> AnalyticsJsonRpcError
```

**Purpose**: Creates the analytics-classified error type corresponding to the no-active-turn steer rejection.

**Data flow**: Returns `AnalyticsJsonRpcError::TurnSteer(TurnSteerRequestError::NoActiveTurn)`.

**Call relations**: Passed alongside `no_active_turn_steer_error` so reducer tests can verify rejection-reason mapping.

*Call graph*: called by 3 (accepted_steers_increment_turn_steer_count, rejected_turn_steer_uses_request_connection_metadata, turn_steer_does_not_emit_without_pending_request); 1 external calls (TurnSteer).


##### `non_steerable_review_error`  (lines 460–475)

```
fn non_steerable_review_error() -> JSONRPCErrorError
```

**Purpose**: Creates a JSON-RPC error fixture indicating the active turn is a non-steerable review turn.

**Data flow**: Builds `JSONRPCErrorError` with code `-32600`, message `cannot steer a review turn`, and serialized `AppServerTurnError` data containing `CodexErrorInfo::ActiveTurnNotSteerable { turn_kind: Review }`.

**Call relations**: Used by the rejected-steer mapping test that verifies this server error becomes the `non_steerable_review` analytics reason.

*Call graph*: called by 1 (rejected_turn_steer_maps_active_turn_not_steerable_error_type); 1 external calls (to_value).


##### `non_steerable_review_error_type`  (lines 477–479)

```
fn non_steerable_review_error_type() -> AnalyticsJsonRpcError
```

**Purpose**: Creates the analytics-classified error type for a non-steerable review turn rejection.

**Data flow**: Returns `AnalyticsJsonRpcError::TurnSteer(TurnSteerRequestError::NonSteerableReview)`.

**Call relations**: Passed with `non_steerable_review_error` into the rejected-steer helper to drive the expected mapping.

*Call graph*: called by 1 (rejected_turn_steer_maps_active_turn_not_steerable_error_type); 1 external calls (TurnSteer).


##### `input_too_large_steer_error`  (lines 481–491)

```
fn input_too_large_steer_error() -> JSONRPCErrorError
```

**Purpose**: Creates a JSON-RPC error fixture for steer input rejected as too large.

**Data flow**: Constructs `JSONRPCErrorError` with code `-32602`, a maximum-length message, and JSON data containing `input_error_code`, `actual_chars`, and `max_chars`.

**Call relations**: Used by the rejected-steer mapping test for oversized input.

*Call graph*: called by 1 (rejected_turn_steer_maps_input_too_large_error_type); 1 external calls (json!).


##### `input_too_large_error_type`  (lines 493–495)

```
fn input_too_large_error_type() -> AnalyticsJsonRpcError
```

**Purpose**: Creates the analytics-classified error type for oversized input.

**Data flow**: Returns `AnalyticsJsonRpcError::Input(InputError::TooLarge)`.

**Call relations**: Supplied with `input_too_large_steer_error` so the reducer can emit the correct rejection reason.

*Call graph*: called by 1 (rejected_turn_steer_maps_input_too_large_error_type); 1 external calls (Input).


##### `ingest_rejected_turn_steer`  (lines 497–566)

```
async fn ingest_rejected_turn_steer(
    reducer: &mut AnalyticsReducer,
    out: &mut Vec<TrackEventRequest>,
    error: JSONRPCErrorError,
    error_type: Option<AnalyticsJsonRpcError>,
) -> serde_j
```

**Purpose**: Runs a full reducer scenario that establishes thread/turn context, submits a steer request, injects a rejection error, and returns the emitted turn-steer event as JSON.

**Data flow**: Mutably borrows a reducer and output vector, calls `ingest_turn_prerequisites`, ingests an additional initialize fact and thread resume response on another connection, clears prior events, ingests a steer request and matching `ErrorResponse`, asserts exactly one output event, serializes that event to `serde_json::Value`, and returns it.

**Call relations**: This helper is shared by the three rejected-turn-steer tests. It encapsulates the prerequisite reducer state needed for a rejection to emit analytics.

*Call graph*: calls 5 internal fn (ingest_turn_prerequisites, sample_runtime_metadata, sample_thread_resume_response, sample_turn_steer_request, ingest); called by 3 (rejected_turn_steer_maps_active_turn_not_steerable_error_type, rejected_turn_steer_maps_input_too_large_error_type, rejected_turn_steer_uses_request_connection_metadata); 4 external calls (new, Integer, assert_eq!, to_value).


##### `ingest_initialize`  (lines 568–588)

```
async fn ingest_initialize(reducer: &mut AnalyticsReducer, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Feeds a standard initialize fact into the reducer for connection 7.

**Data flow**: Constructs `AnalyticsFact::Initialize` with fixed client info, runtime metadata from `sample_runtime_metadata`, and stdio transport, ingests it into the reducer, and awaits completion.

**Call relations**: Used by broader setup helpers and tests that need initialized connection metadata before thread or turn events can be emitted.

*Call graph*: calls 2 internal fn (sample_runtime_metadata, ingest); called by 3 (ingest_turn_prerequisites, turn_start_error_response_discards_pending_start_request, unrelated_client_responses_are_ignored_by_reducer).


##### `ingest_turn_prerequisites`  (lines 590–680)

```
async fn ingest_turn_prerequisites(
    reducer: &mut AnalyticsReducer,
    out: &mut Vec<TrackEventRequest>,
    include_initialize: bool,
    include_resolved_config: bool,
    include_started: bool
```

**Purpose**: Builds up reducer state for a turn lifecycle test, optionally including initialize, resolved config, started notification, and token usage.

**Data flow**: Depending on boolean flags, it may call `ingest_initialize`, ingest a thread-start response and clear emitted events, then always ingests a turn-start request and response. It conditionally ingests resolved config, started notification, and token usage, and finally ingests a `TurnProfileFact`.

**Call relations**: This is the main shared setup routine for turn-related tests. Different tests toggle its flags to verify which prerequisites are required for later emissions.

*Call graph*: calls 9 internal fn (ingest_initialize, sample_thread_start_response, sample_turn_profile, sample_turn_resolved_config, sample_turn_start_request, sample_turn_start_response, sample_turn_started_notification, sample_turn_token_usage_fact, ingest); called by 11 (accepted_steers_increment_turn_steer_count, accepted_turn_steer_emits_expected_event, ingest_rejected_turn_steer, reducer_emits_accepted_line_fingerprints_once_from_latest_turn_diff_on_completion, reducer_emits_large_accepted_line_aggregates_without_fingerprints, turn_completed_without_started_notification_emits_null_started_at, turn_does_not_emit_without_required_prerequisites, turn_event_counts_completed_tool_items, turn_lifecycle_emits_failed_turn_event, turn_lifecycle_emits_interrupted_turn_event_without_error (+1 more)); 7 external calls (new, Custom, Notification, TurnProfile, TurnResolvedConfig, TurnTokenUsage, Integer).


##### `ingest_review_prerequisites`  (lines 682–702)

```
async fn ingest_review_prerequisites(
    reducer: &mut AnalyticsReducer,
    events: &mut Vec<TrackEventRequest>,
)
```

**Purpose**: Initializes reducer state for review-related tests by establishing client metadata and a started thread.

**Data flow**: Ingests `sample_initialize_fact(7)`, then a thread-start response for `thread-1`, and clears any emitted events so subsequent assertions focus only on review behavior.

**Call relations**: Shared by tests covering user approvals, guardian reviews, and tool-item review denormalization.

*Call graph*: calls 3 internal fn (sample_initialize_fact, sample_thread_start_response, ingest); called by 9 (aborted_server_request_publishes_aborted_user_review_event_once, command_execution_approval_response_publishes_user_review_event, effective_session_permissions_response_publishes_session_user_review_event, guardian_completed_notification_publishes_review_event_with_thread_metadata, item_lifecycle_notifications_publish_command_execution_event, item_review_summaries_do_not_cross_threads_with_reused_item_ids, permissions_reviews_emit_events_without_denormalizing_onto_tool_items, subagent_tool_items_inherit_parent_connection_metadata, terminal_reviews_denormalize_counts_onto_tool_item_events); 2 external calls (new, Integer).


##### `ingest_completed_command_execution_item`  (lines 704–754)

```
async fn ingest_completed_command_execution_item(
    reducer: &mut AnalyticsReducer,
    events: &mut Vec<TrackEventRequest>,
    thread_id: &str,
    item_id: &str,
)
```

**Purpose**: Simulates a command execution item lifecycle from turn start through item start and item completion.

**Data flow**: Ingests a turn-started notification for the given thread, then an `ItemStarted` notification with an in-progress command item, then an `ItemCompleted` notification with a completed command item carrying exit code and duration.

**Call relations**: Used by tests that need a finished command execution event, especially when verifying review counts denormalized onto tool-item analytics.

*Call graph*: calls 3 internal fn (sample_command_execution_item_with_id, sample_turn_started_notification, ingest); called by 3 (item_review_summaries_do_not_cross_threads_with_reused_item_ids, permissions_reviews_emit_events_without_denormalizing_onto_tool_items, terminal_reviews_denormalize_counts_onto_tool_item_events); 4 external calls (new, ItemCompleted, ItemStarted, Notification).


##### `sample_initialize_fact`  (lines 756–780)

```
fn sample_initialize_fact(connection_id: u64) -> AnalyticsFact
```

**Purpose**: Builds a reusable initialize fact fixture with websocket transport and explicit capabilities.

**Data flow**: Accepts `connection_id`, constructs `AnalyticsFact::Initialize` with fixed client info, capabilities, runtime metadata, and `DEFAULT_ORIGINATOR`, and returns it.

**Call relations**: Used by review setup and subagent inheritance tests when they need a concrete initialize fact value rather than immediately ingesting one.

*Call graph*: called by 2 (ingest_review_prerequisites, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit).


##### `ingest_complete_child_turn`  (lines 782–807)

```
async fn ingest_complete_child_turn(
    reducer: &mut AnalyticsReducer,
    events: &mut Vec<TrackEventRequest>,
    thread_id: &str,
    turn_id: &str,
)
```

**Purpose**: Completes a child/subagent turn by ingesting resolved config, profile, and terminal completion facts in sequence.

**Data flow**: For the given `thread_id` and `turn_id`, constructs three facts—resolved config, turn profile, and completed notification—and ingests them one after another into the reducer.

**Call relations**: Used by the subagent inheritance test to verify emitted turn events for child threads after lineage metadata has been established.

*Call graph*: calls 4 internal fn (sample_turn_completed_notification, sample_turn_profile, sample_turn_resolved_config, ingest); called by 1 (subagent_events_use_inherited_connection_unless_turn_connection_is_explicit); 5 external calls (new, Custom, Notification, TurnProfile, TurnResolvedConfig).


##### `sample_command_execution_item`  (lines 809–815)

```
fn sample_command_execution_item(
    status: CommandExecutionStatus,
    exit_code: Option<i32>,
    duration_ms: Option<i64>,
) -> ThreadItem
```

**Purpose**: Convenience wrapper that creates a command execution `ThreadItem` with the default item id `item-1`.

**Data flow**: Accepts status, exit code, and duration, forwards them to `sample_command_execution_item_with_id("item-1", ...)`, and returns the resulting `ThreadItem`.

**Call relations**: Used by several tests and by the action-mutating helper when the specific item id is not important.

*Call graph*: calls 1 internal fn (sample_command_execution_item_with_id); called by 4 (item_completed_without_turn_state_does_not_create_turn_state, item_lifecycle_notifications_publish_command_execution_event, sample_command_execution_item_with_actions, subagent_tool_items_inherit_parent_connection_metadata).


##### `sample_command_execution_item_with_id`  (lines 817–835)

```
fn sample_command_execution_item_with_id(
    id: &str,
    status: CommandExecutionStatus,
    exit_code: Option<i32>,
    duration_ms: Option<i64>,
) -> ThreadItem
```

**Purpose**: Builds a `ThreadItem::CommandExecution` fixture with caller-controlled item id and terminal fields.

**Data flow**: Accepts `id`, status, optional exit code, and optional duration, fills a `CommandExecution` thread item with fixed command, cwd, process id, source, and empty actions/output, and returns it.

**Call relations**: Used directly by item lifecycle helpers and indirectly by the default-id wrapper.

*Call graph*: called by 2 (ingest_completed_command_execution_item, sample_command_execution_item); 2 external calls (new, test_path_buf).


##### `sample_command_execution_item_with_actions`  (lines 837–853)

```
fn sample_command_execution_item_with_actions(
    status: CommandExecutionStatus,
    exit_code: Option<i32>,
    duration_ms: Option<i64>,
    command_actions: Vec<CommandAction>,
) -> ThreadItem
```

**Purpose**: Creates a command execution item and then replaces its `command_actions` vector with caller-supplied actions.

**Data flow**: Builds a base item via `sample_command_execution_item`, pattern-matches it as `ThreadItem::CommandExecution`, mutates the embedded `command_actions` field, and returns the modified item; panics if the variant is unexpectedly different.

**Call relations**: Used by the command execution event test that verifies action-category counts in emitted analytics.

*Call graph*: calls 1 internal fn (sample_command_execution_item); called by 1 (item_lifecycle_notifications_publish_command_execution_event); 1 external calls (unreachable!).


##### `sample_command_approval_request`  (lines 855–875)

```
fn sample_command_approval_request(request_id: i64, approval_id: Option<&str>) -> ServerRequest
```

**Purpose**: Builds a server approval request fixture for command execution reviews.

**Data flow**: Accepts integer `request_id` and optional `approval_id`, constructs `ServerRequest::CommandExecutionRequestApproval` with fixed thread/turn/item ids, timestamps, command text, and mostly empty optional fields, and returns it.

**Call relations**: Used by tests covering user review events, aborted requests, and review denormalization onto tool items.

*Call graph*: called by 4 (aborted_server_request_publishes_aborted_user_review_event_once, command_execution_approval_response_publishes_user_review_event, item_review_summaries_do_not_cross_threads_with_reused_item_ids, terminal_reviews_denormalize_counts_onto_tool_item_events); 1 external calls (Integer).


##### `sample_command_approval_response`  (lines 877–885)

```
fn sample_command_approval_response(
    request_id: i64,
    decision: CommandExecutionApprovalDecision,
) -> ServerResponse
```

**Purpose**: Builds a server approval response fixture carrying a chosen command approval decision.

**Data flow**: Accepts integer `request_id` and `CommandExecutionApprovalDecision`, wraps them in `ServerResponse::CommandExecutionRequestApproval`, and returns the response.

**Call relations**: Paired with `sample_command_approval_request` in tests that verify how reducer review state resolves.

*Call graph*: called by 4 (aborted_server_request_publishes_aborted_user_review_event_once, command_execution_approval_response_publishes_user_review_event, item_review_summaries_do_not_cross_threads_with_reused_item_ids, terminal_reviews_denormalize_counts_onto_tool_item_events); 1 external calls (Integer).


##### `sample_permissions_approval_request`  (lines 887–906)

```
fn sample_permissions_approval_request(request_id: i64) -> ServerRequest
```

**Purpose**: Builds a server approval request fixture for permissions reviews rather than command execution reviews.

**Data flow**: Accepts integer `request_id`, constructs `ServerRequest::PermissionsRequestApproval` with fixed thread/turn/item ids, cwd, reason, and a request profile enabling network access, and returns it.

**Call relations**: Used by tests that verify permissions reviews emit standalone review events and do not denormalize onto unrelated tool items.

*Call graph*: called by 2 (effective_session_permissions_response_publishes_session_user_review_event, permissions_reviews_emit_events_without_denormalizing_onto_tool_items); 2 external calls (Integer, test_path_buf).


##### `sample_effective_permissions_approval_response`  (lines 908–917)

```
fn sample_effective_permissions_approval_response(
    permissions: CoreRequestPermissionProfile,
    scope: CorePermissionGrantScope,
) -> CoreRequestPermissionsResponse
```

**Purpose**: Builds the effective permissions response fixture returned after a permissions approval decision is applied.

**Data flow**: Accepts a `CoreRequestPermissionProfile` and `CorePermissionGrantScope`, wraps them with `strict_auto_review: false` into `CoreRequestPermissionsResponse`, and returns it.

**Call relations**: Used by permissions review tests to distinguish denied turn-scoped responses from approved session-scoped responses.

*Call graph*: called by 2 (effective_session_permissions_response_publishes_session_user_review_event, permissions_reviews_emit_events_without_denormalizing_onto_tool_items).


##### `sample_guardian_review_completed`  (lines 919–946)

```
fn sample_guardian_review_completed(
    review_id: &str,
    target_item_id: Option<&str>,
    status: GuardianApprovalReviewStatus,
) -> ServerNotification
```

**Purpose**: Builds a guardian review completion notification fixture with optional target item id and configurable terminal status.

**Data flow**: Accepts `review_id`, optional `target_item_id`, and `GuardianApprovalReviewStatus`, constructs `ServerNotification::ItemGuardianApprovalReviewCompleted` with fixed thread/turn ids, timestamps, command action details, and a `GuardianApprovalReview` payload, and returns it.

**Call relations**: Used by the guardian review notification test to verify reducer emission of review analytics with inherited thread metadata.

*Call graph*: called by 1 (guardian_completed_notification_publishes_review_event_with_thread_metadata); 2 external calls (ItemGuardianApprovalReviewCompleted, test_path_buf).


##### `expected_absolute_path`  (lines 948–953)

```
fn expected_absolute_path(path: &PathBuf) -> String
```

**Purpose**: Computes the canonical absolute path string expected by skill-id normalization tests, falling back to the original path if canonicalization fails.

**Data flow**: Accepts a `PathBuf`, attempts `std::fs::canonicalize`, falls back to cloning the original path on error, converts the result to a lossy string, normalizes backslashes to forward slashes, and returns it.

**Call relations**: Used only by path-normalization tests to compare reducer helper output against a platform-stable absolute-path representation.

*Call graph*: called by 3 (normalize_path_for_skill_id_admin_scoped_uses_absolute_path, normalize_path_for_skill_id_repo_root_not_in_skill_path_uses_absolute_path, normalize_path_for_skill_id_user_scoped_uses_absolute_path); 1 external calls (canonicalize).


##### `normalize_path_for_skill_id_repo_scoped_uses_relative_path`  (lines 956–967)

```
fn normalize_path_for_skill_id_repo_scoped_uses_relative_path()
```

**Purpose**: Verifies that repo-scoped skill paths are normalized relative to the repository root.

**Data flow**: Constructs repo-root and skill-path fixtures, calls `normalize_path_for_skill_id` with a repo URL and root, and asserts the result is `.codex/skills/doc/SKILL.md`.

**Call relations**: This test documents the repo-scoped branch of the skill-id path normalization helper.

*Call graph*: calls 1 internal fn (normalize_path_for_skill_id); 2 external calls (from, assert_eq!).


##### `normalize_path_for_skill_id_user_scoped_uses_absolute_path`  (lines 970–981)

```
fn normalize_path_for_skill_id_user_scoped_uses_absolute_path()
```

**Purpose**: Verifies that user-scoped skill paths normalize to absolute paths when no repo context exists.

**Data flow**: Builds a user skill path, computes the expected absolute path with `expected_absolute_path`, calls `normalize_path_for_skill_id` with no repo URL/root, and asserts equality.

**Call relations**: Covers the non-repo branch of skill-id path normalization for user-installed skills.

*Call graph*: calls 2 internal fn (expected_absolute_path, normalize_path_for_skill_id); 2 external calls (from, assert_eq!).


##### `normalize_path_for_skill_id_admin_scoped_uses_absolute_path`  (lines 984–995)

```
fn normalize_path_for_skill_id_admin_scoped_uses_absolute_path()
```

**Purpose**: Verifies that admin-scoped skill paths also normalize to absolute paths without repo context.

**Data flow**: Builds an admin skill path under `/etc`, computes the expected absolute path, calls `normalize_path_for_skill_id` with no repo context, and asserts equality.

**Call relations**: Complements the user-scoped path test with another non-repo location.

*Call graph*: calls 2 internal fn (expected_absolute_path, normalize_path_for_skill_id); 2 external calls (from, assert_eq!).


##### `normalize_path_for_skill_id_repo_root_not_in_skill_path_uses_absolute_path`  (lines 998–1010)

```
fn normalize_path_for_skill_id_repo_root_not_in_skill_path_uses_absolute_path()
```

**Purpose**: Checks that repo-scoped normalization falls back to an absolute path when the skill path is not actually under the declared repo root.

**Data flow**: Constructs mismatched repo-root and skill-path values, computes the expected absolute path, calls `normalize_path_for_skill_id`, and asserts the fallback result.

**Call relations**: Documents an important edge case in skill-id normalization: repo context is only used when the path is truly nested under the repo root.

*Call graph*: calls 2 internal fn (expected_absolute_path, normalize_path_for_skill_id); 2 external calls (from, assert_eq!).


##### `app_mentioned_event_serializes_expected_shape`  (lines 1013–1048)

```
fn app_mentioned_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of an app-mentioned analytics event.

**Data flow**: Builds a `TrackEventsContext`, constructs `TrackEventRequest::AppMentioned` using `codex_app_metadata`, serializes it to JSON, and compares the full payload against an expected `json!` value.

**Call relations**: One of several serialization contract tests that lock down event field names and nesting.

*Call graph*: calls 1 internal fn (codex_app_metadata); 3 external calls (AppMentioned, assert_eq!, to_value).


##### `app_used_event_serializes_expected_shape`  (lines 1051–1086)

```
fn app_used_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of an app-used analytics event.

**Data flow**: Builds tracking context and `TrackEventRequest::AppUsed`, serializes it, and compares the result to the expected JSON object.

**Call relations**: Pairs with the app-mentioned serialization test to cover both app analytics event variants.

*Call graph*: calls 1 internal fn (codex_app_metadata); 3 external calls (AppUsed, assert_eq!, to_value).


##### `accepted_line_fingerprints_event_serializes_expected_shape`  (lines 1089–1128)

```
fn accepted_line_fingerprints_event_serializes_expected_shape()
```

**Purpose**: Verifies the serialized JSON structure of the accepted-line-fingerprints analytics event.

**Data flow**: Constructs a boxed `CodexAcceptedLineFingerprintsEventRequest` inside `TrackEventRequest::AcceptedLineFingerprints`, serializes it to JSON, and asserts the exact nested payload including empty `line_fingerprints`.

**Call relations**: Locks down the wire shape expected from the accepted-lines feature.

*Call graph*: 5 external calls (new, new, AcceptedLineFingerprints, assert_eq!, to_value).


##### `reducer_emits_large_accepted_line_aggregates_without_fingerprints`  (lines 1131–1199)

```
async fn reducer_emits_large_accepted_line_aggregates_without_fingerprints()
```

**Purpose**: Checks that a very large diff produces one accepted-line event with aggregate counts but no uploaded fingerprints, and remains under a size threshold.

**Data flow**: Initializes reducer turn state, constructs a diff with 20,000 added lines, ingests a `TurnDiffUpdated` notification and then a completion notification, filters emitted events for `AcceptedLineFingerprints`, and asserts counts, empty fingerprints, and serialized size under 2.1 MB.

**Call relations**: Exercises the reducer’s accepted-line aggregation path and the design choice from `accepted_lines.rs` to omit fingerprints from uploaded payloads.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 8 external calls (new, TurnDiffUpdated, new, Notification, default, assert!, assert_eq!, format!).


##### `reducer_emits_accepted_line_fingerprints_once_from_latest_turn_diff_on_completion`  (lines 1202–1266)

```
async fn reducer_emits_accepted_line_fingerprints_once_from_latest_turn_diff_on_completion()
```

**Purpose**: Verifies that only the latest diff snapshot for a turn is used when emitting the accepted-line event at completion time.

**Data flow**: Sets up turn prerequisites, ingests two successive `TurnDiffUpdated` notifications with different added lines, confirms no immediate events, then ingests turn completion and asserts exactly one accepted-line event reflecting only the latest diff.

**Call relations**: Documents reducer behavior around diff replacement rather than accumulation across multiple updates.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 8 external calls (new, TurnDiffUpdated, new, Notification, default, assert!, assert_eq!, format!).


##### `compaction_event_serializes_expected_shape`  (lines 1269–1347)

```
fn compaction_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of a compaction analytics event including nested client/runtime metadata and compaction fields.

**Data flow**: Constructs a `TrackEventRequest::Compaction` using `codex_compaction_event_params`, serializes it, and compares the full JSON payload to an expected object.

**Call relations**: Serialization contract test for compaction events.

*Call graph*: calls 3 internal fn (sample_app_server_client_metadata, sample_runtime_metadata, codex_compaction_event_params); 4 external calls (new, Compaction, assert_eq!, to_value).


##### `compaction_implementation_serializes_remote_v2`  (lines 1350–1355)

```
fn compaction_implementation_serializes_remote_v2()
```

**Purpose**: Verifies the enum serialization string for `CompactionImplementation::ResponsesCompactionV2`.

**Data flow**: Serializes the enum value to JSON and asserts the result is `"responses_compaction_v2"`.

**Call relations**: A narrow serialization test protecting one specific enum wire value.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `app_used_dedupe_is_keyed_by_turn_and_connector`  (lines 1358–1385)

```
fn app_used_dedupe_is_keyed_by_turn_and_connector()
```

**Purpose**: Checks that app-used deduplication in `AnalyticsEventsQueue` is scoped by `(turn_id, connector_id)`.

**Data flow**: Constructs a queue with empty dedupe sets, creates one app invocation and two tracking contexts for different turns, calls `should_enqueue_app_used` repeatedly, and asserts true/false/true across same-turn duplicate and different-turn reuse.

**Call relations**: Tests queue-level dedupe behavior rather than reducer logic.

*Call graph*: 5 external calls (new, new, new, assert_eq!, channel).


##### `thread_initialized_event_serializes_expected_shape`  (lines 1388–1451)

```
fn thread_initialized_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of a thread-initialized analytics event.

**Data flow**: Constructs `TrackEventRequest::ThreadInitialized` with explicit metadata, serializes it, and compares the result to an expected JSON object.

**Call relations**: Serialization contract test for thread lifecycle analytics.

*Call graph*: 4 external calls (ThreadInitialized, Feature, assert_eq!, to_value).


##### `command_execution_event_serializes_expected_shape`  (lines 1454–1550)

```
fn command_execution_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of a command execution analytics event including action counts and approval summary fields.

**Data flow**: Builds `TrackEventRequest::CommandExecution` with a populated `CodexCommandExecutionEventParams`, serializes it, and compares the payload to expected JSON.

**Call relations**: Serialization contract test for tool-item analytics.

*Call graph*: 3 external calls (CommandExecution, assert_eq!, to_value).


##### `review_event_serializes_expected_shape`  (lines 1553–1627)

```
fn review_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of a review analytics event, including subagent lineage metadata.

**Data flow**: Constructs `TrackEventRequest::ReviewEvent` with populated `CodexReviewEventParams`, serializes it, and compares the result to expected JSON.

**Call relations**: Serialization contract test for review events.

*Call graph*: 3 external calls (ReviewEvent, assert_eq!, to_value).


##### `initialize_caches_client_and_thread_lifecycle_publishes_once_initialized`  (lines 1629–1729)

```
async fn initialize_caches_client_and_thread_lifecycle_publishes_once_initialized()
```

**Purpose**: Verifies that thread lifecycle events are withheld until initialize metadata is available, then emitted with cached client/runtime fields.

**Data flow**: Ingests a thread-start response before initialize and asserts no events, ingests initialize and still expects none, then ingests a thread-resume response and asserts one thread-initialized event whose nested metadata matches the cached initialize fact.

**Call relations**: Documents reducer dependency on initialize facts for thread lifecycle emission.

*Call graph*: calls 2 internal fn (sample_thread_resume_response, sample_thread_start_response); 7 external calls (new, new, default, Integer, assert!, assert_eq!, to_value).


##### `unrelated_client_requests_are_ignored_by_reducer`  (lines 1732–1766)

```
async fn unrelated_client_requests_are_ignored_by_reducer()
```

**Purpose**: Checks that non-analytics-relevant client requests do not create pending reducer state.

**Data flow**: Ingests a `ThreadArchive` client request and then an unrelated turn-start response, and asserts no events were emitted.

**Call relations**: Covers reducer filtering of irrelevant request types.

*Call graph*: calls 1 internal fn (sample_turn_start_response); 5 external calls (new, new, default, Integer, assert!).


##### `unrelated_client_responses_are_ignored_by_reducer`  (lines 1769–1788)

```
async fn unrelated_client_responses_are_ignored_by_reducer()
```

**Purpose**: Checks that non-analytics-relevant client responses are ignored even after initialization.

**Data flow**: Initializes the reducer, ingests a `ThreadArchive` response, and asserts the output remains empty.

**Call relations**: Complements the unrelated-request test for the response side.

*Call graph*: calls 1 internal fn (ingest_initialize); 6 external calls (new, ThreadArchive, new, default, Integer, assert!).


##### `compaction_event_ingests_custom_fact`  (lines 1791–1919)

```
async fn compaction_event_ingests_custom_fact()
```

**Purpose**: Verifies that a custom compaction fact emits a compaction event enriched with cached thread/session/subagent metadata.

**Data flow**: Initializes reducer state, ingests a subagent thread-resume response with parent lineage, clears prior events, ingests a custom `Compaction` fact, serializes emitted events, and asserts one compaction event with expected session id, thread source, subagent source, parent thread id, and compaction fields.

**Call relations**: Exercises reducer enrichment of custom facts using previously cached thread metadata.

*Call graph*: calls 3 internal fn (sample_runtime_metadata, sample_thread_resume_response_with_source, from_string); 9 external calls (SubAgent, new, new, Custom, Compaction, default, Integer, assert_eq!, to_value).


##### `guardian_review_event_ingests_custom_fact_with_optional_target_item`  (lines 1922–2081)

```
async fn guardian_review_event_ingests_custom_fact_with_optional_target_item()
```

**Purpose**: Verifies that a custom guardian review fact emits the expected guardian review analytics event, including optional-null fields.

**Data flow**: Initializes reducer and thread state, clears prior events, ingests a custom `GuardianReview` fact with many optional fields unset, serializes emitted events, and asserts one `codex_guardian_review` payload with expected metadata and null handling.

**Call relations**: Documents reducer behavior for direct custom guardian review facts, distinct from notification-derived review events.

*Call graph*: calls 2 internal fn (sample_runtime_metadata, sample_thread_start_response); 9 external calls (new, new, Custom, GuardianReview, default, Integer, assert!, assert_eq!, to_value).


##### `item_lifecycle_notifications_publish_command_execution_event`  (lines 2084–2197)

```
async fn item_lifecycle_notifications_publish_command_execution_event()
```

**Purpose**: Checks that command execution analytics are emitted only when an item completes, not when it starts, and that action counts and timing are computed correctly.

**Data flow**: Sets up review prerequisites, ingests turn-started and item-started notifications and asserts no events, then ingests an item-completed notification with four command actions, serializes the emitted event, and asserts exact counts, timing, approval summary, and inherited metadata.

**Call relations**: Exercises reducer tool-item lifecycle handling and command-action categorization.

*Call graph*: calls 4 internal fn (ingest_review_prerequisites, sample_command_execution_item, sample_command_execution_item_with_actions, sample_turn_started_notification); 10 external calls (new, ItemCompleted, ItemStarted, new, Notification, default, assert!, assert_eq!, to_value, vec!).


##### `command_execution_approval_response_publishes_user_review_event`  (lines 2200–2253)

```
async fn command_execution_approval_response_publishes_user_review_event()
```

**Purpose**: Verifies that a completed command approval request/response pair emits a user review analytics event.

**Data flow**: Sets up review prerequisites, ingests a command approval server request and asserts no immediate event, then ingests the matching server response and asserts one review event with expected ids, subject kind, reviewer, status, and duration.

**Call relations**: Documents reducer review lifecycle for command approvals.

*Call graph*: calls 3 internal fn (ingest_review_prerequisites, sample_command_approval_request, sample_command_approval_response); 6 external calls (new, new, default, assert!, assert_eq!, to_value).


##### `permissions_reviews_emit_events_without_denormalizing_onto_tool_items`  (lines 2256–2304)

```
async fn permissions_reviews_emit_events_without_denormalizing_onto_tool_items()
```

**Purpose**: Checks that permissions approval events emit review analytics but do not increment review counts on later tool-item events with the same item id.

**Data flow**: Sets up review prerequisites, ingests a permissions approval request and effective denied response, asserts the emitted review event fields, clears events, then simulates a completed command execution item with item id `permissions-1` and asserts its review counters remain zero.

**Call relations**: Protects the reducer invariant that permissions reviews are not denormalized onto tool-item analytics.

*Call graph*: calls 4 internal fn (ingest_completed_command_execution_item, ingest_review_prerequisites, sample_effective_permissions_approval_response, sample_permissions_approval_request); 8 external calls (new, default, new, default, Integer, assert!, assert_eq!, to_value).


##### `effective_session_permissions_response_publishes_session_user_review_event`  (lines 2307–2349)

```
async fn effective_session_permissions_response_publishes_session_user_review_event()
```

**Purpose**: Verifies that an approved session-scoped permissions response emits a review event with `session_approval` resolution.

**Data flow**: Sets up review prerequisites, ingests a permissions approval request and an effective response granting session-scoped network access, serializes emitted events, and asserts the review status is approved with session resolution.

**Call relations**: Covers the approved/session branch of permissions review handling.

*Call graph*: calls 3 internal fn (ingest_review_prerequisites, sample_effective_permissions_approval_response, sample_permissions_approval_request); 6 external calls (new, new, default, Integer, assert_eq!, to_value).


##### `aborted_server_request_publishes_aborted_user_review_event_once`  (lines 2352–2398)

```
async fn aborted_server_request_publishes_aborted_user_review_event_once()
```

**Purpose**: Checks that aborting a pending approval request emits one aborted review event and that a later response for the same request id is ignored.

**Data flow**: Sets up review prerequisites, ingests a command approval request and then `ServerRequestAborted`, asserts one aborted review event, clears events, then ingests a late approval response and asserts no further events.

**Call relations**: Documents reducer cleanup of pending review state after abort.

*Call graph*: calls 3 internal fn (ingest_review_prerequisites, sample_command_approval_request, sample_command_approval_response); 7 external calls (new, new, default, Integer, assert!, assert_eq!, to_value).


##### `guardian_completed_notification_publishes_review_event_with_thread_metadata`  (lines 2401–2428)

```
async fn guardian_completed_notification_publishes_review_event_with_thread_metadata()
```

**Purpose**: Verifies that guardian review completion notifications emit review events enriched with cached thread metadata.

**Data flow**: Sets up review prerequisites, ingests a guardian review completed notification, serializes the first emitted event, and asserts review id, item id, thread source, reviewer, status, and timing fields.

**Call relations**: Covers the notification-driven guardian review path distinct from custom guardian review facts.

*Call graph*: calls 2 internal fn (ingest_review_prerequisites, sample_guardian_review_completed); 6 external calls (new, new, Notification, default, assert_eq!, to_value).


##### `terminal_reviews_denormalize_counts_onto_tool_item_events`  (lines 2431–2471)

```
async fn terminal_reviews_denormalize_counts_onto_tool_item_events()
```

**Purpose**: Checks that terminal user reviews are summarized onto later tool-item analytics for the same thread/item.

**Data flow**: Sets up review prerequisites, ingests a command approval request and an `AcceptForSession` response, clears events, simulates a completed command execution item, serializes the resulting tool-item event, and asserts review counts and final approval outcome reflect the prior review.

**Call relations**: Documents reducer denormalization of terminal review summaries onto tool-item events.

*Call graph*: calls 4 internal fn (ingest_completed_command_execution_item, ingest_review_prerequisites, sample_command_approval_request, sample_command_approval_response); 5 external calls (new, new, default, assert_eq!, to_value).


##### `item_review_summaries_do_not_cross_threads_with_reused_item_ids`  (lines 2474–2527)

```
async fn item_review_summaries_do_not_cross_threads_with_reused_item_ids()
```

**Purpose**: Ensures review summaries are keyed by thread as well as item id so reused item ids in another thread do not inherit prior review counts.

**Data flow**: Sets up review prerequisites, starts a second thread, ingests a command approval request/response in the first thread, clears events, simulates a completed command execution item with the same item id in the second thread, and asserts zero review counts and unknown approval outcome.

**Call relations**: Protects reducer state partitioning across threads.

*Call graph*: calls 5 internal fn (ingest_completed_command_execution_item, ingest_review_prerequisites, sample_command_approval_request, sample_command_approval_response, sample_thread_start_response); 6 external calls (new, new, default, Integer, assert_eq!, to_value).


##### `subagent_thread_started_review_serializes_expected_shape`  (lines 2530–2573)

```
fn subagent_thread_started_review_serializes_expected_shape()
```

**Purpose**: Asserts the JSON shape of a thread-initialized event produced for a review subagent thread.

**Data flow**: Builds `SubAgentThreadStartedInput` with `SubAgentSource::Review`, converts it with `subagent_thread_started_event_request`, wraps it in `TrackEventRequest::ThreadInitialized`, serializes it, and asserts expected fields.

**Call relations**: Serialization contract test for one subagent source variant.

*Call graph*: calls 1 internal fn (subagent_thread_started_event_request); 3 external calls (ThreadInitialized, assert_eq!, to_value).


##### `subagent_thread_started_thread_spawn_serializes_thread_lineage`  (lines 2576–2618)

```
fn subagent_thread_started_thread_spawn_serializes_thread_lineage()
```

**Purpose**: Asserts that thread-spawn subagent initialization events include parent and fork lineage fields.

**Data flow**: Creates concrete parent and forked-from thread ids, builds `SubAgentThreadStartedInput` with `SubAgentSource::ThreadSpawn`, serializes the resulting thread-initialized event, and asserts thread source, subagent source, parent thread id, forked-from id, and session id.

**Call relations**: Covers the lineage-rich subagent source variant.

*Call graph*: calls 2 internal fn (subagent_thread_started_event_request, from_string); 3 external calls (ThreadInitialized, assert_eq!, to_value).


##### `subagent_thread_started_memory_consolidation_serializes_expected_shape`  (lines 2621–2645)

```
fn subagent_thread_started_memory_consolidation_serializes_expected_shape()
```

**Purpose**: Asserts the serialized subagent source string for memory-consolidation subagent threads.

**Data flow**: Builds a `SubAgentThreadStartedInput` with `SubAgentSource::MemoryConsolidation`, serializes the resulting event, and asserts the `subagent_source` and null parent thread id.

**Call relations**: Serialization contract test for another subagent source variant.

*Call graph*: calls 1 internal fn (subagent_thread_started_event_request); 3 external calls (ThreadInitialized, assert_eq!, to_value).


##### `subagent_thread_started_other_serializes_expected_shape`  (lines 2648–2668)

```
fn subagent_thread_started_other_serializes_expected_shape()
```

**Purpose**: Asserts that `SubAgentSource::Other` serializes using its contained string value.

**Data flow**: Builds a `SubAgentThreadStartedInput` with `Other("guardian")`, serializes the resulting event, and asserts `subagent_source == "guardian"` and null parent thread id.

**Call relations**: Covers the open-ended subagent source variant.

*Call graph*: calls 1 internal fn (subagent_thread_started_event_request); 4 external calls (ThreadInitialized, assert_eq!, Other, to_value).


##### `subagent_thread_started_other_serializes_explicit_parent_thread_id`  (lines 2671–2697)

```
fn subagent_thread_started_other_serializes_explicit_parent_thread_id()
```

**Purpose**: Checks that `Other(...)` subagent events preserve an explicitly supplied parent thread id.

**Data flow**: Creates a concrete parent thread id, builds `SubAgentThreadStartedInput` with `Other("guardian")` and `parent_thread_id: Some(...)`, serializes the event, and asserts the parent thread id field.

**Call relations**: Extends the previous test to cover explicit lineage on `Other` sources.

*Call graph*: calls 2 internal fn (subagent_thread_started_event_request, from_string); 4 external calls (ThreadInitialized, assert_eq!, Other, to_value).


##### `subagent_thread_started_publishes_without_initialize`  (lines 2700–2734)

```
async fn subagent_thread_started_publishes_without_initialize()
```

**Purpose**: Verifies that custom subagent-thread-started facts can emit thread initialization analytics even without a prior initialize fact.

**Data flow**: Creates a default reducer, ingests `CustomAnalyticsFact::SubAgentThreadStarted`, serializes emitted events, and asserts one thread-initialized event with the supplied client metadata and subagent source.

**Call relations**: Documents a special reducer path where subagent-start events are self-contained and do not depend on connection initialization.

*Call graph*: 6 external calls (new, Custom, SubAgentThreadStarted, default, assert_eq!, to_value).


##### `subagent_events_use_inherited_connection_unless_turn_connection_is_explicit`  (lines 2737–2908)

```
async fn subagent_events_use_inherited_connection_unless_turn_connection_is_explicit()
```

**Purpose**: Checks that subagent threads inherit parent connection metadata for custom and turn events until an explicit turn connection is established, after which explicit connection metadata wins.

**Data flow**: Initializes a parent connection and thread, ingests a `SubAgentThreadStarted` fact for a child thread with parent lineage, emits and checks a compaction event using inherited metadata, completes a child turn and checks the emitted turn event still uses inherited metadata, then initializes a second connection and explicit turn-start request/response for the child thread, completes another child turn, and asserts the new turn event uses the explicit connection’s client metadata.

**Call relations**: This is a comprehensive inheritance test covering reducer metadata sourcing across parent-child thread relationships and later explicit overrides.

*Call graph*: calls 8 internal fn (ingest_complete_child_turn, sample_initialize_fact, sample_runtime_metadata, sample_thread_start_response, sample_turn_start_request, sample_turn_start_response, sample_turn_token_usage_fact, from_string); 11 external calls (new, new, Custom, Compaction, SubAgentThreadStarted, TurnTokenUsage, default, Integer, assert_eq!, panic! (+1 more)).


##### `subagent_tool_items_inherit_parent_connection_metadata`  (lines 2911–2992)

```
async fn subagent_tool_items_inherit_parent_connection_metadata()
```

**Purpose**: Verifies that tool-item analytics emitted from subagent threads inherit parent connection metadata and lineage fields.

**Data flow**: Sets up review prerequisites, ingests a `SubAgentThreadStarted` fact for a child thread, clears events, ingests turn-started, item-started, and item-completed notifications for the subagent thread, serializes emitted events, and asserts thread source, subagent source, parent thread id, and client name.

**Call relations**: Covers inheritance behavior for tool-item events specifically, not just turn or custom events.

*Call graph*: calls 3 internal fn (ingest_review_prerequisites, sample_command_execution_item, sample_turn_started_notification); 10 external calls (new, ItemCompleted, ItemStarted, new, Custom, Notification, SubAgentThreadStarted, default, assert_eq!, to_value).


##### `plugin_used_event_serializes_expected_shape`  (lines 2995–3027)

```
fn plugin_used_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of a plugin-used analytics event.

**Data flow**: Builds tracking context and sample plugin metadata, constructs `TrackEventRequest::PluginUsed` via `codex_plugin_used_metadata`, serializes it, and compares against expected JSON.

**Call relations**: Serialization contract test for plugin usage analytics.

*Call graph*: calls 2 internal fn (sample_plugin_metadata, codex_plugin_used_metadata); 3 external calls (PluginUsed, assert_eq!, to_value).


##### `plugin_management_event_serializes_expected_shape`  (lines 3030–3053)

```
fn plugin_management_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of a plugin management event such as plugin installation.

**Data flow**: Builds sample plugin metadata, constructs `TrackEventRequest::PluginInstalled` via `codex_plugin_metadata`, serializes it, and compares against expected JSON.

**Call relations**: Serialization contract test for plugin state-change analytics.

*Call graph*: calls 2 internal fn (sample_plugin_metadata, codex_plugin_metadata); 3 external calls (PluginInstalled, assert_eq!, to_value).


##### `plugin_management_event_can_use_remote_plugin_id_override`  (lines 3056–3072)

```
fn plugin_management_event_can_use_remote_plugin_id_override()
```

**Purpose**: Verifies that plugin analytics prefer `remote_plugin_id` over the local parsed plugin id when present.

**Data flow**: Mutates sample plugin metadata to set `remote_plugin_id`, constructs a plugin-installed event, serializes it, and asserts the payload’s `plugin_id` uses the override while name and marketplace remain unchanged.

**Call relations**: Documents an important identifier-selection rule in plugin metadata serialization.

*Call graph*: calls 2 internal fn (sample_plugin_metadata, codex_plugin_metadata); 3 external calls (PluginInstalled, assert_eq!, to_value).


##### `hook_run_event_serializes_expected_shape`  (lines 3075–3109)

```
fn hook_run_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of a hook-run analytics event.

**Data flow**: Builds tracking context and a `HookRunFact`, constructs `TrackEventRequest::HookRun` via `codex_hook_run_metadata`, serializes it, and compares against expected JSON.

**Call relations**: Serialization contract test for hook analytics.

*Call graph*: calls 1 internal fn (codex_hook_run_metadata); 3 external calls (HookRun, assert_eq!, to_value).


##### `hook_run_metadata_maps_sources_and_statuses`  (lines 3112–3164)

```
fn hook_run_metadata_maps_sources_and_statuses()
```

**Purpose**: Verifies mapping of multiple hook sources and statuses into their serialized analytics strings.

**Data flow**: Builds tracking context, serializes four `codex_hook_run_metadata` outputs for system/project/cloud-requirements/unknown sources and completed/blocked/failed statuses, and asserts the resulting JSON fields.

**Call relations**: Documents enum-to-string mapping behavior in hook metadata generation.

*Call graph*: calls 1 internal fn (codex_hook_run_metadata); 2 external calls (assert_eq!, to_value).


##### `hook_run_metadata_maps_stopped_status`  (lines 3167–3186)

```
fn hook_run_metadata_maps_stopped_status()
```

**Purpose**: Verifies that `HookRunStatus::Stopped` serializes as `stopped`.

**Data flow**: Builds tracking context, serializes one hook metadata value with stopped status, and asserts the `hook_source` and `status` fields.

**Call relations**: A narrow serialization test for one status variant.

*Call graph*: calls 1 internal fn (codex_hook_run_metadata); 2 external calls (assert_eq!, to_value).


##### `plugin_used_dedupe_is_keyed_by_turn_and_plugin`  (lines 3189–3212)

```
fn plugin_used_dedupe_is_keyed_by_turn_and_plugin()
```

**Purpose**: Checks that plugin-used deduplication is scoped by `(turn_id, plugin_id)`.

**Data flow**: Constructs a queue with empty dedupe sets, creates sample plugin metadata and two tracking contexts for different turns, calls `should_enqueue_plugin_used` repeatedly, and asserts true/false/true across duplicate and cross-turn cases.

**Call relations**: Queue-level dedupe test parallel to the app-used dedupe test.

*Call graph*: calls 1 internal fn (sample_plugin_metadata); 5 external calls (new, new, new, assert_eq!, channel).


##### `reducer_ingests_skill_invoked_fact`  (lines 3215–3266)

```
async fn reducer_ingests_skill_invoked_fact()
```

**Purpose**: Verifies that a custom skill-invoked fact emits the expected skill invocation analytics event with a computed local skill id.

**Data flow**: Builds tracking context and a user skill path, computes the expected skill id with `skill_id_for_local_skill`, ingests `CustomAnalyticsFact::SkillInvoked`, serializes emitted events, and asserts the full JSON payload.

**Call relations**: Exercises reducer handling of custom skill invocation facts.

*Call graph*: calls 1 internal fn (skill_id_for_local_skill); 8 external calls (from, new, Custom, SkillInvoked, default, assert_eq!, to_value, vec!).


##### `reducer_includes_plugin_id_for_plugin_skill_invocations`  (lines 3269–3301)

```
async fn reducer_includes_plugin_id_for_plugin_skill_invocations()
```

**Purpose**: Checks that plugin-backed skill invocations include the plugin id in emitted analytics.

**Data flow**: Builds tracking context and a plugin skill path, ingests a `SkillInvoked` custom fact with `plugin_id: Some(...)`, serializes emitted events, and asserts the payload contains that plugin id.

**Call relations**: Covers the plugin-associated branch of skill invocation analytics.

*Call graph*: 8 external calls (from, new, Custom, SkillInvoked, default, assert_eq!, to_value, vec!).


##### `reducer_ingests_hook_run_fact`  (lines 3304–3332)

```
async fn reducer_ingests_hook_run_fact()
```

**Purpose**: Verifies that a custom hook-run fact emits the expected hook analytics event.

**Data flow**: Builds a reducer and tracking context, ingests `CustomAnalyticsFact::HookRun`, serializes emitted events, and asserts one event with expected hook name, source, and status.

**Call relations**: Exercises reducer handling of custom hook facts.

*Call graph*: 6 external calls (new, Custom, HookRun, default, assert_eq!, to_value).


##### `reducer_ingests_app_and_plugin_facts`  (lines 3335–3385)

```
async fn reducer_ingests_app_and_plugin_facts()
```

**Purpose**: Verifies that custom app-mentioned, app-used, and plugin-used facts each emit their corresponding analytics events.

**Data flow**: Builds tracking context, ingests three custom facts in sequence, serializes emitted events, and asserts the array length and event types in order.

**Call relations**: Covers reducer handling of several simple custom fact variants.

*Call graph*: calls 1 internal fn (sample_plugin_metadata); 9 external calls (new, Custom, AppMentioned, AppUsed, PluginUsed, default, assert_eq!, to_value, vec!).


##### `reducer_ingests_plugin_state_changed_fact`  (lines 3388–3420)

```
async fn reducer_ingests_plugin_state_changed_fact()
```

**Purpose**: Verifies that a plugin state-change custom fact emits the correct plugin management event.

**Data flow**: Builds sample plugin metadata, ingests `CustomAnalyticsFact::PluginStateChanged` with `PluginState::Disabled`, serializes emitted events, and asserts the exact JSON payload.

**Call relations**: Exercises reducer mapping from plugin state changes to event types.

*Call graph*: calls 1 internal fn (sample_plugin_metadata); 6 external calls (new, Custom, PluginStateChanged, default, assert_eq!, to_value).


##### `turn_event_serializes_expected_shape`  (lines 3423–3558)

```
fn turn_event_serializes_expected_shape()
```

**Purpose**: Asserts the exact JSON shape of a fully populated turn analytics event.

**Data flow**: Constructs `TrackEventRequest::TurnEvent` with a detailed `CodexTurnEventParams`, serializes it, parses an expected JSON string into `serde_json::Value`, and asserts equality.

**Call relations**: Serialization contract test for the largest and most detailed analytics event type in the subsystem.

*Call graph*: calls 2 internal fn (sample_app_server_client_metadata, sample_runtime_metadata); 4 external calls (new, TurnEvent, assert_eq!, to_value).


##### `accepted_turn_steer_emits_expected_event`  (lines 3561–3628)

```
async fn accepted_turn_steer_emits_expected_event()
```

**Purpose**: Verifies that an accepted turn-steer request/response pair emits the expected turn-steer analytics event.

**Data flow**: Sets up turn prerequisites, ingests a steer request and matching steer response, asserts one output event, serializes it, and checks thread/session ids, expected and accepted turn ids, image count, result, timestamps, and nested metadata.

**Call relations**: Exercises reducer handling of successful steer requests.

*Call graph*: calls 3 internal fn (ingest_turn_prerequisites, sample_turn_steer_request, sample_turn_steer_response); 7 external calls (new, new, default, Integer, assert!, assert_eq!, to_value).


##### `rejected_turn_steer_uses_request_connection_metadata`  (lines 3631–3669)

```
async fn rejected_turn_steer_uses_request_connection_metadata()
```

**Purpose**: Verifies that rejected turn-steer events use the request connection’s cached metadata and map the no-active-turn error to the correct rejection reason.

**Data flow**: Calls `ingest_rejected_turn_steer` with the no-active-turn error and classified error type, then asserts the returned JSON payload fields including `result: rejected` and `rejection_reason: no_active_turn`.

**Call relations**: One of several tests built on the shared rejected-steer helper.

*Call graph*: calls 3 internal fn (ingest_rejected_turn_steer, no_active_turn_steer_error, no_active_turn_steer_error_type); 4 external calls (new, default, assert!, assert_eq!).


##### `rejected_turn_steer_maps_active_turn_not_steerable_error_type`  (lines 3672–3687)

```
async fn rejected_turn_steer_maps_active_turn_not_steerable_error_type()
```

**Purpose**: Checks that a non-steerable review rejection maps to the `non_steerable_review` analytics reason.

**Data flow**: Runs `ingest_rejected_turn_steer` with the review-specific error fixture and classified error type, then asserts the emitted payload’s `rejection_reason` field.

**Call relations**: Covers one specific rejection-reason mapping branch.

*Call graph*: calls 3 internal fn (ingest_rejected_turn_steer, non_steerable_review_error, non_steerable_review_error_type); 3 external calls (new, default, assert_eq!).


##### `rejected_turn_steer_maps_input_too_large_error_type`  (lines 3690–3705)

```
async fn rejected_turn_steer_maps_input_too_large_error_type()
```

**Purpose**: Checks that oversized input rejection maps to the `input_too_large` analytics reason.

**Data flow**: Runs `ingest_rejected_turn_steer` with the oversized-input error fixture and classified error type, then asserts the emitted payload’s `rejection_reason` field.

**Call relations**: Covers another rejection-reason mapping branch.

*Call graph*: calls 3 internal fn (ingest_rejected_turn_steer, input_too_large_error_type, input_too_large_steer_error); 3 external calls (new, default, assert_eq!).


##### `turn_steer_does_not_emit_without_pending_request`  (lines 3708–3725)

```
async fn turn_steer_does_not_emit_without_pending_request()
```

**Purpose**: Verifies that an error response alone does not emit a turn-steer event unless a matching pending steer request was previously recorded.

**Data flow**: Creates a default reducer, ingests an `ErrorResponse` for a steer request id without first ingesting the request, and asserts the output vector remains empty.

**Call relations**: Documents reducer dependence on pending request state for steer analytics.

*Call graph*: calls 2 internal fn (no_active_turn_steer_error, no_active_turn_steer_error_type); 4 external calls (new, default, Integer, assert!).


##### `turn_start_error_response_discards_pending_start_request`  (lines 3728–3790)

```
async fn turn_start_error_response_discards_pending_start_request()
```

**Purpose**: Checks that an error response for a turn-start request clears pending request state so a later synthetic response cannot resurrect it.

**Data flow**: Initializes reducer state, ingests a turn-start request, ingests an error response for that request id, then ingests a late turn-start response and later resolved-config/completion facts for the same turn id, asserting no events are emitted at any stage.

**Call relations**: Protects reducer cleanup semantics for failed turn-start requests.

*Call graph*: calls 6 internal fn (ingest_initialize, no_active_turn_steer_error, sample_turn_completed_notification, sample_turn_resolved_config, sample_turn_start_request, sample_turn_start_response); 8 external calls (new, new, Custom, Notification, TurnResolvedConfig, default, Integer, assert!).


##### `turn_lifecycle_emits_turn_event`  (lines 3793–3874)

```
async fn turn_lifecycle_emits_turn_event()
```

**Purpose**: Verifies the normal happy-path turn lifecycle emits one turn event with resolved config, token usage, tool counts, timing, and cached metadata.

**Data flow**: Sets up full turn prerequisites including initialize, resolved config, started notification, and token usage, ingests turn completion, asserts one output event, serializes it, and checks many nested fields and counters.

**Call relations**: This is the core reducer lifecycle test for completed turns.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 7 external calls (new, new, Notification, default, assert!, assert_eq!, to_value).


##### `turn_event_counts_completed_tool_items`  (lines 3877–4017)

```
async fn turn_event_counts_completed_tool_items()
```

**Purpose**: Checks that completed tool items of various kinds are counted into the correct per-turn aggregate counters and that MCP tool events preserve plugin id.

**Data flow**: Sets up turn prerequisites, ingests one MCP item-started notification, ingests a series of completed items across command execution, file change, MCP, dynamic tool, collab agent, subagent activity, web search, and image generation, verifies the emitted MCP tool call event, then completes the turn and asserts the turn event’s aggregate tool counters.

**Call relations**: Exercises reducer aggregation across multiple tool-item variants before turn completion.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 9 external calls (new, ItemCompleted, ItemStarted, new, Notification, default, assert_eq!, to_value, vec!).


##### `item_completed_without_turn_state_does_not_create_turn_state`  (lines 4020–4055)

```
async fn item_completed_without_turn_state_does_not_create_turn_state()
```

**Purpose**: Verifies that stray item-completed notifications do not create synthetic turn state that would later emit a turn event.

**Data flow**: Creates a default reducer, ingests an item-completed notification for an unknown turn, then ingests turn completion for that same turn, and asserts no events were emitted.

**Call relations**: Documents reducer refusal to infer turn lifecycle solely from item completion.

*Call graph*: calls 2 internal fn (sample_command_execution_item, sample_turn_completed_notification); 6 external calls (new, ItemCompleted, new, Notification, default, assert!).


##### `accepted_steers_increment_turn_steer_count`  (lines 4058–4160)

```
async fn accepted_steers_increment_turn_steer_count()
```

**Purpose**: Checks that only accepted steer requests increment the `steer_count` on the eventual turn event.

**Data flow**: Sets up turn prerequisites, ingests one accepted steer pair, one rejected steer pair, and another accepted steer pair, then completes the turn and asserts the emitted turn event has `steer_count == 2`.

**Call relations**: Connects steer-event handling with later turn-event aggregation.

*Call graph*: calls 6 internal fn (ingest_turn_prerequisites, no_active_turn_steer_error, no_active_turn_steer_error_type, sample_turn_completed_notification, sample_turn_steer_request, sample_turn_steer_response); 7 external calls (new, new, Notification, default, Integer, assert_eq!, to_value).


##### `turn_does_not_emit_without_required_prerequisites`  (lines 4163–4213)

```
async fn turn_does_not_emit_without_required_prerequisites()
```

**Purpose**: Verifies that turn completion alone is insufficient; the reducer requires both initialize metadata and resolved config before emitting a turn event.

**Data flow**: Runs two separate reducer scenarios: one missing initialize and one missing resolved config. In each case it ingests completion after partial prerequisites and asserts no events are emitted.

**Call relations**: Documents the reducer’s minimum prerequisite set for turn analytics.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 5 external calls (new, new, Notification, default, assert!).


##### `turn_lifecycle_emits_failed_turn_event`  (lines 4216–4265)

```
async fn turn_lifecycle_emits_failed_turn_event()
```

**Purpose**: Checks that failed turns emit turn events carrying both app-server turn error info and separately tracked codex error classification.

**Data flow**: Sets up turn prerequisites, ingests a custom `TurnCodexError` fact derived from a `CodexErr`, then ingests a failed turn completion notification with `BadRequest`, serializes the emitted event, and asserts failed status plus `turn_error`, `codex_error_kind`, and null HTTP status code.

**Call relations**: Exercises reducer merging of custom codex error facts with terminal turn status.

*Call graph*: calls 3 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification, from_codex_err); 9 external calls (new, new, Custom, Notification, TurnCodexError, default, assert_eq!, InvalidRequest, to_value).


##### `turn_lifecycle_emits_interrupted_turn_event_without_error`  (lines 4268–4298)

```
async fn turn_lifecycle_emits_interrupted_turn_event_without_error()
```

**Purpose**: Verifies that interrupted turns emit a turn event with interrupted status but no error classification.

**Data flow**: Sets up turn prerequisites, ingests an interrupted completion notification, serializes the emitted event, and asserts `status: interrupted` with null `turn_error` and `codex_error_kind`.

**Call relations**: Covers a non-success terminal status distinct from explicit failure.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 6 external calls (new, new, Notification, default, assert_eq!, to_value).


##### `turn_completed_without_started_notification_emits_null_started_at`  (lines 4301–4337)

```
async fn turn_completed_without_started_notification_emits_null_started_at()
```

**Purpose**: Checks that if no `TurnStarted` notification was seen, the emitted turn event leaves `started_at` null while still carrying completion timing and null token usage.

**Data flow**: Sets up turn prerequisites without the started notification or token usage, ingests completion, serializes the emitted event, and asserts `started_at == null`, `duration_ms == 1234`, and all token fields are null.

**Call relations**: Documents reducer behavior when only completion timing is available.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 6 external calls (new, new, Notification, default, assert_eq!, to_value).


##### `sample_plugin_metadata`  (lines 4339–4355)

```
fn sample_plugin_metadata() -> PluginTelemetryMetadata
```

**Purpose**: Builds a representative `PluginTelemetryMetadata` fixture with capability summary, MCP servers, and connector ids.

**Data flow**: Parses `sample@test` into a `PluginId`, constructs `PluginCapabilitySummary` with display name, skills flag, two MCP server names, and two connector ids, wraps it in `PluginTelemetryMetadata`, and returns it.

**Call relations**: Shared by plugin serialization, dedupe, and reducer-ingestion tests throughout the file.

*Call graph*: calls 1 internal fn (parse); called by 6 (plugin_management_event_can_use_remote_plugin_id_override, plugin_management_event_serializes_expected_shape, plugin_used_dedupe_is_keyed_by_turn_and_plugin, plugin_used_event_serializes_expected_shape, reducer_ingests_app_and_plugin_facts, reducer_ingests_plugin_state_changed_fact); 1 external calls (vec!).


### `app-server/tests/suite/v2/analytics.rs`

`test` · `cross-cutting telemetry assertions in integration tests`

This file is half test suite, half support module for other v2 tests. The two top-level tests build a `codex_core::config::Config` with `ConfigBuilder`, inject an OTLP/HTTP JSON metrics exporter, leave `analytics_enabled` unset, and then call `codex_core::otel_init::build_provider` with different `default_analytics_enabled` values. Rather than asserting provider existence directly, they inspect `provider.metrics()` because a provider may still exist for non-metrics telemetry. That distinction is an important design detail captured here.

The rest of the file helps other suites capture and inspect analytics traffic. `mount_analytics_capture` mounts a `POST /codex/analytics-events/events` endpoint on a `MockServer` and writes ChatGPT auth fixture data so analytics requests have account context. `wait_for_analytics_payload` and `wait_for_matching_analytics_event` poll `received_requests()` until a matching analytics POST arrives, repeatedly sleeping 25 ms between checks and parsing request bodies as JSON. Thin wrappers select by `event_type` or by goal-event fields. Finally, `thread_initialized_event` extracts the `codex_thread_initialized` event from a payload, and `assert_basic_thread_initialized_event` checks the common event fields such as thread/session ids, client identity, transport `stdio`, model, non-ephemeral status, source lineage fields, initialization mode, and presence of a numeric `created_at` timestamp.

#### Function details

##### `set_metrics_exporter`  (lines 24–31)

```
fn set_metrics_exporter(config: &mut codex_core::config::Config)
```

**Purpose**: Mutates a config to enable OTLP/HTTP JSON metrics export with a localhost endpoint. It gives analytics tests a concrete exporter configuration without relying on external environment.

**Data flow**: Takes a mutable `codex_core::config::Config` reference → assigns `config.otel.metrics_exporter = OtelExporterKind::OtlpHttp { endpoint: "http://localhost:4318", headers: HashMap::new(), protocol: OtelHttpProtocol::Json, tls: None }` → returns unit after mutating the config in place.

**Call relations**: Both default-analytics tests call it before invoking `build_provider`, so they differ only in the default-enable flag rather than exporter setup.

*Call graph*: called by 2 (app_server_default_analytics_disabled_without_flag, app_server_default_analytics_enabled_with_flag); 1 external calls (new).


##### `app_server_default_analytics_disabled_without_flag`  (lines 34–56)

```
async fn app_server_default_analytics_disabled_without_flag() -> Result<()>
```

**Purpose**: Verifies that when analytics are unset in config and the app-server default flag is false, metrics are not initialized.

**Data flow**: Builds a config rooted at a temp codex home, calls `set_metrics_exporter`, sets `config.analytics_enabled = None`, invokes `build_provider(..., default_analytics_enabled = false)`, computes `has_metrics` by checking `provider.as_ref().and_then(|otel| otel.metrics()).is_some()`, and asserts `has_metrics == false`.

**Call relations**: This direct test documents the default-off behavior for app-server analytics when config does not explicitly opt in.

*Call graph*: calls 2 internal fn (set_metrics_exporter, build_provider); 3 external calls (new, assert_eq!, default).


##### `app_server_default_analytics_enabled_with_flag`  (lines 59–80)

```
async fn app_server_default_analytics_enabled_with_flag() -> Result<()>
```

**Purpose**: Verifies that when analytics are unset in config but the app-server default flag is true, metrics are initialized.

**Data flow**: Builds a temp config, injects the metrics exporter, leaves `analytics_enabled = None`, calls `build_provider(..., default_analytics_enabled = true)`, derives `has_metrics` from `provider.metrics()`, and asserts `has_metrics == true`.

**Call relations**: This is the counterpart to the previous test and isolates the effect of the default-enable flag.

*Call graph*: calls 2 internal fn (set_metrics_exporter, build_provider); 3 external calls (new, assert_eq!, default).


##### `mount_analytics_capture`  (lines 82–99)

```
async fn mount_analytics_capture(server: &MockServer, codex_home: &Path) -> Result<()>
```

**Purpose**: Prepares a mock analytics ingestion endpoint and writes ChatGPT auth fixture data so tests can observe emitted analytics requests with authenticated context.

**Data flow**: Registers a `POST /codex/analytics-events/events` mock on the provided `MockServer` that returns HTTP 200, then writes ChatGPT auth under the given codex-home path with account/user ids set to `account-123`/`user-123` → returns `Result<()>`.

**Call relations**: Imported by many other v2 tests that need to capture analytics traffic before exercising thread or turn operations.

*Call graph*: calls 1 internal fn (new); called by 10 (thread_fork_tracks_thread_initialized_analytics, thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal, thread_resume_tracks_thread_initialized_analytics, thread_start_tracks_thread_initialized_analytics, turn_profile_tracks_blocking_tool_and_follow_up_sampling, turn_start_tracks_turn_event_analytics, turn_steer_rejects_context_only_input_without_merging_context, turn_steer_rejects_oversized_text_input, turn_steer_requires_active_turn, turn_steer_returns_active_turn_id); 5 external calls (given, new, write_chatgpt_auth, method, path).


##### `wait_for_analytics_payload`  (lines 101–121)

```
async fn wait_for_analytics_payload(
    server: &MockServer,
    read_timeout: Duration,
) -> Result<Value>
```

**Purpose**: Polls the mock server until any analytics POST body is observed, then parses and returns the full JSON payload.

**Data flow**: Given a `MockServer` and timeout duration, repeatedly calls `server.received_requests().await`, sleeps 25 ms when none are present or no matching analytics POST exists, and once a `POST /codex/analytics-events/events` request is found, clones its body and parses it with `serde_json::from_slice` into `Value` → returns the parsed payload or an invalid-payload error.

**Call relations**: Used by tests that want the entire analytics batch payload, especially those extracting `codex_thread_initialized` from the events array.

*Call graph*: called by 3 (thread_fork_tracks_thread_initialized_analytics, thread_resume_tracks_thread_initialized_analytics, thread_start_tracks_thread_initialized_analytics); 5 external calls (from_millis, received_requests, from_slice, sleep, timeout).


##### `wait_for_analytics_event`  (lines 123–132)

```
async fn wait_for_analytics_event(
    server: &MockServer,
    read_timeout: Duration,
    event_type: &str,
) -> Result<Value>
```

**Purpose**: Waits for a single analytics event with a specific `event_type` anywhere in captured analytics batches.

**Data flow**: Accepts a mock server, timeout, and `event_type` string → delegates to `wait_for_matching_analytics_event` with a predicate comparing `event["event_type"]` to the requested type → returns the matching event JSON value.

**Call relations**: Acts as a convenience wrapper for tests that care about one named event rather than the whole payload.

*Call graph*: calls 1 internal fn (wait_for_matching_analytics_event); called by 4 (turn_profile_tracks_blocking_tool_and_follow_up_sampling, turn_start_tracks_turn_event_analytics, turn_steer_requires_active_turn, turn_steer_returns_active_turn_id).


##### `wait_for_goal_event`  (lines 134–146)

```
async fn wait_for_goal_event(
    server: &MockServer,
    read_timeout: Duration,
    event_kind: &str,
    goal_status: &str,
) -> Result<Value>
```

**Purpose**: Waits for a `codex_goal_event` whose nested `event_kind` and `goal_status` fields match the requested values.

**Data flow**: Takes a mock server, timeout, `event_kind`, and `goal_status` → delegates to `wait_for_matching_analytics_event` with a predicate that checks `event_type == "codex_goal_event"` and the two nested `event_params` fields → returns the matching event JSON value.

**Call relations**: Used by goal-lifecycle tests elsewhere to avoid repeating nested JSON matching logic.

*Call graph*: calls 1 internal fn (wait_for_matching_analytics_event); called by 1 (thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal).


##### `wait_for_matching_analytics_event`  (lines 148–178)

```
async fn wait_for_matching_analytics_event(
    server: &MockServer,
    read_timeout: Duration,
    matches: impl Fn(&Value) -> bool,
) -> Result<Value>
```

**Purpose**: Scans captured analytics POST requests until it finds an event satisfying an arbitrary predicate. It is the core polling primitive behind the event-specific helpers.

**Data flow**: Given a mock server, timeout, and predicate `matches`, it repeatedly fetches `received_requests`, filters for `POST /codex/analytics-events/events`, parses each request body as JSON, extracts the `events` array if present, searches for the first event where `matches(event)` is true, and returns a clone of that event; otherwise it sleeps 25 ms and retries until timeout.

**Call relations**: Both `wait_for_analytics_event` and `wait_for_goal_event` delegate here, making it the generic event-selection engine for analytics assertions.

*Call graph*: called by 2 (wait_for_analytics_event, wait_for_goal_event); 5 external calls (from_millis, received_requests, from_slice, sleep, timeout).


##### `thread_initialized_event`  (lines 180–188)

```
fn thread_initialized_event(payload: &Value) -> Result<&Value>
```

**Purpose**: Extracts the `codex_thread_initialized` event from a parsed analytics payload. It fails with a descriptive error if the payload lacks an events array or the event is absent.

**Data flow**: Reads `payload["events"]` as an array, returning an error if missing, then searches for the first event whose `event_type` equals `codex_thread_initialized` → returns a borrowed reference to that event `Value`.

**Call relations**: Called by thread analytics tests after `wait_for_analytics_payload` returns a full batch.

*Call graph*: called by 3 (thread_fork_tracks_thread_initialized_analytics, thread_resume_tracks_thread_initialized_analytics, thread_start_tracks_thread_initialized_analytics).


##### `assert_basic_thread_initialized_event`  (lines 190–231)

```
fn assert_basic_thread_initialized_event(
    event: &Value,
    thread_id: &str,
    session_id: &str,
    expected_model: &str,
    initialization_mode: &str,
    expected_thread_source: &str,
)
```

**Purpose**: Asserts the common field set expected on a `codex_thread_initialized` analytics event. It checks identifiers, client metadata, transport, model, lineage defaults, initialization mode, and timestamp presence.

**Data flow**: Consumes an event JSON value plus expected `thread_id`, `session_id`, `expected_model`, `initialization_mode`, and `expected_thread_source` → performs a series of `assert_eq!` and `assert!` checks against nested `event_params` fields such as `app_server_client.product_client_id`, `rpc_transport`, `ephemeral`, `thread_source`, `subagent_source`, `parent_thread_id`, and `created_at` → returns unit.

**Call relations**: Used by multiple thread analytics tests to enforce a shared baseline before those tests assert scenario-specific fields.

*Call graph*: called by 3 (thread_fork_tracks_thread_initialized_analytics, thread_resume_tracks_thread_initialized_analytics, thread_start_tracks_thread_initialized_analytics); 2 external calls (assert!, assert_eq!).


### Application telemetry regressions
These tests exercise telemetry emitted by core application helpers, task metrics, request handling, and persisted log filtering.

### `core/src/tasks/mod_tests.rs`

`test` · `unit test execution`

This test module builds a minimal `SessionTelemetry` backed by `InMemoryMetricExporter` so metric helper behavior can be asserted without a live telemetry backend. `test_session_telemetry` constructs a `MetricsClient` using `MetricsConfig::in_memory(...).with_runtime_reader()` and then creates a `SessionTelemetry` with fixed thread/model/session metadata, finally stripping metadata tags via `with_metrics_without_metadata_tags` so assertions only need to consider the helper-specific attributes.

The remaining helpers inspect the exporter snapshot. `find_metric` walks `ResourceMetrics -> scope_metrics -> metrics` to locate a metric by name and panics if absent. `attributes_to_map` normalizes OpenTelemetry `KeyValue` iterators into a sorted `BTreeMap<String, String>` for deterministic comparison. `metric_point` asserts that the chosen metric is a `U64` sum with exactly one data point and returns that point's attributes and value.

Each test follows the same pattern: create telemetry, call one helper under test, snapshot metrics, extract the single point, and compare both the counter value and the exact attribute map. The cases cover both boolean branches for network proxy activity, both allowed/disallowed memory-read combinations with citation tagging, and manual versus automatic compaction tagging. These tests are intentionally narrow and concrete: they lock down the emitted tag keys and stringified boolean values used by dashboards and downstream metric consumers.

#### Function details

##### `test_session_telemetry`  (lines 21–41)

```
fn test_session_telemetry() -> SessionTelemetry
```

**Purpose**: Builds a `SessionTelemetry` instance wired to an in-memory metrics exporter for deterministic metric assertions.

**Data flow**: Creates an `InMemoryMetricExporter`, wraps it in a `MetricsClient` configured with `MetricsConfig::in_memory`, then constructs `SessionTelemetry::new(...)` with fixed thread/model/source metadata and returns the telemetry after calling `with_metrics_without_metadata_tags`. No external state is modified.

**Call relations**: Every metric test calls this first to obtain an isolated telemetry sink. It supplies the common fixture used before invoking the helper under test.

*Call graph*: calls 4 internal fn (new, new, in_memory, new); called by 6 (emit_compact_metric_records_auto_local, emit_compact_metric_records_manual_remote_v2, emit_turn_memory_metric_records_config_disabled_without_citations, emit_turn_memory_metric_records_read_allowed_with_citations, emit_turn_network_proxy_metric_records_active_turn, emit_turn_network_proxy_metric_records_inactive_turn); 2 external calls (default, env!).


##### `find_metric`  (lines 43–52)

```
fn find_metric(resource_metrics: &'a ResourceMetrics, name: &str) -> &'a Metric
```

**Purpose**: Searches a metrics snapshot for a metric with the requested name and returns it.

**Data flow**: Iterates through `resource_metrics.scope_metrics()` and each contained metric, comparing `metric.name()` to `name`. It returns a borrowed `&Metric` on the first match or panics if none is found.

**Call relations**: Only `metric_point` uses this helper as the first step in extracting a single asserted metric from the snapshot.

*Call graph*: called by 1 (metric_point); 2 external calls (scope_metrics, panic!).


##### `attributes_to_map`  (lines 54–60)

```
fn attributes_to_map(
    attributes: impl Iterator<Item = &'a KeyValue>,
) -> BTreeMap<String, String>
```

**Purpose**: Converts an iterator of OpenTelemetry attributes into a deterministic string map for equality assertions.

**Data flow**: Consumes an iterator of `&KeyValue`, maps each key/value to owned `String` pairs using `as_str()`, collects them into a `BTreeMap<String, String>`, and returns that map.

**Call relations**: `metric_point` calls this after locating the single data point so tests can compare attributes with `assert_eq!` independent of iteration order.

*Call graph*: called by 1 (metric_point); 1 external calls (map).


##### `metric_point`  (lines 62–76)

```
fn metric_point(resource_metrics: &ResourceMetrics, name: &str) -> (BTreeMap<String, String>, u64)
```

**Purpose**: Extracts the sole counter data point for a named metric and returns its attributes and numeric value.

**Data flow**: Reads a `ResourceMetrics` snapshot and metric name, finds the metric via `find_metric`, matches its aggregated data as `AggregatedMetrics::U64(MetricData::Sum(sum))`, collects the sum's data points, asserts there is exactly one point, converts that point's attributes with `attributes_to_map`, and returns `(BTreeMap<String, String>, u64)`. It panics on unexpected metric shape or type.

**Call relations**: All concrete tests call this after snapshotting metrics. It encapsulates the assumptions that these helpers emit exactly one `u64` counter point.

*Call graph*: calls 2 internal fn (attributes_to_map, find_metric); called by 6 (emit_compact_metric_records_auto_local, emit_compact_metric_records_manual_remote_v2, emit_turn_memory_metric_records_config_disabled_without_citations, emit_turn_memory_metric_records_read_allowed_with_citations, emit_turn_network_proxy_metric_records_active_turn, emit_turn_network_proxy_metric_records_inactive_turn); 2 external calls (assert_eq!, panic!).


##### `emit_turn_network_proxy_metric_records_active_turn`  (lines 79–101)

```
fn emit_turn_network_proxy_metric_records_active_turn()
```

**Purpose**: Verifies that the network-proxy metric helper emits a single counter increment tagged with `active=true` and the supplied temporary-memory tag.

**Data flow**: Creates test telemetry, calls `emit_turn_network_proxy_metric` with `network_proxy_active=true`, snapshots metrics, extracts the point for `TURN_NETWORK_PROXY_METRIC`, and asserts both value `1` and the exact two-attribute map.

**Call relations**: This is a direct unit test of the production helper's true branch.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_turn_network_proxy_metric).


##### `emit_turn_network_proxy_metric_records_inactive_turn`  (lines 104–126)

```
fn emit_turn_network_proxy_metric_records_inactive_turn()
```

**Purpose**: Verifies that the network-proxy metric helper emits `active=false` when the proxy is inactive.

**Data flow**: Creates test telemetry, calls `emit_turn_network_proxy_metric` with `false`, snapshots metrics, extracts `TURN_NETWORK_PROXY_METRIC`, and asserts value `1` plus the expected `active=false` and `tmp_mem_enabled=false` tags.

**Call relations**: This complements the active-case test by covering the helper's false branch.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_turn_network_proxy_metric).


##### `emit_turn_memory_metric_records_read_allowed_with_citations`  (lines 129–154)

```
fn emit_turn_memory_metric_records_read_allowed_with_citations()
```

**Purpose**: Checks that the memory metric helper marks all tags true when memory is enabled by feature and config and the turn cited memories.

**Data flow**: Creates test telemetry, calls `emit_turn_memory_metric(true, true, true)`, snapshots metrics, extracts `TURN_MEMORY_METRIC`, and asserts a single increment with `config_use_memories=true`, `feature_enabled=true`, `has_citations=true`, and `read_allowed=true`.

**Call relations**: This is the positive-path unit test for memory metric tagging.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_turn_memory_metric).


##### `emit_turn_memory_metric_records_config_disabled_without_citations`  (lines 157–182)

```
fn emit_turn_memory_metric_records_config_disabled_without_citations()
```

**Purpose**: Checks that the memory metric helper reports `read_allowed=false` when config disables memories, even if the feature flag is enabled.

**Data flow**: Creates test telemetry, calls `emit_turn_memory_metric(true, false, false)`, snapshots metrics, extracts `TURN_MEMORY_METRIC`, and asserts the expected false/true tag combination and counter value `1`.

**Call relations**: This covers the helper's derived `read_allowed` logic when feature and config flags differ.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_turn_memory_metric).


##### `emit_compact_metric_records_manual_remote_v2`  (lines 185–203)

```
fn emit_compact_metric_records_manual_remote_v2()
```

**Purpose**: Verifies that compaction metrics include the requested type and `manual=true` for manual runs.

**Data flow**: Creates test telemetry, calls `emit_compact_metric(&session_telemetry, "remote_v2", true)`, snapshots metrics, extracts `TASK_COMPACT_METRIC`, and asserts value `1` with `manual=true` and `type=remote_v2`.

**Call relations**: This is a direct unit test of compaction metric tagging for manual runs.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_compact_metric).


##### `emit_compact_metric_records_auto_local`  (lines 206–224)

```
fn emit_compact_metric_records_auto_local()
```

**Purpose**: Verifies that compaction metrics include `manual=false` for automatic local compaction.

**Data flow**: Creates test telemetry, calls `emit_compact_metric(&session_telemetry, "local", false)`, snapshots metrics, extracts `TASK_COMPACT_METRIC`, and asserts value `1` with `manual=false` and `type=local`.

**Call relations**: This complements the manual compaction test by covering the automatic branch.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_compact_metric).


### `core/src/util_tests.rs`

`test` · `test execution`

This test file builds a miniature tracing subscriber to capture feedback-tag events emitted by utility code in the parent module and related crates. The core test harness is `TagCollectorLayer`, a `tracing_subscriber::Layer` that listens only to events whose metadata target is `"feedback_tags"`; when such an event arrives it records all fields through `TagCollectorVisitor`, merges them into a shared `BTreeMap<String, String>`, and increments a shared event counter. The visitor implements `Visit` for booleans, strings, and generic debug values, so the tests observe the exact serialized field payloads that downstream telemetry would see, including quoted debug formatting for `Option`-like string fields.

The tests cover several subtle invariants in feedback-tag emission. They verify that `emit_feedback_request_tags_with_auth_env` includes both request-level auth fields and environment-derived auth telemetry, that auth-recovery emitters preserve 401-specific fields under dedicated `auth_401_*` keys, and that later emissions actively clear stale optional fields by writing empty-string values rather than leaving prior values in place. Another regression check ensures legacy emitters that do not carry auth-env data do not wipe previously emitted auth-env tags. The file also includes a compile-only macro smoke test for `feedback_tags!` and a small behavioral test for `normalize_thread_name`, asserting whitespace-only names are rejected while trimmed names are preserved.

#### Function details

##### `feedback_tags_macro_compiles`  (lines 19–24)

```
fn feedback_tags_macro_compiles()
```

**Purpose**: Provides a compile-time smoke test for the `feedback_tags!` macro using mixed field types, including a type that only implements `Debug`.

**Data flow**: Defines a local `OnlyDebug` struct, then invokes `feedback_tags!` with string, boolean, and debug-only values. It returns no value; success is purely that the macro expansion type-checks and compiles.

**Call relations**: This is a standalone unit test invoked by the test runner. It does not inspect runtime output; its role is to guard macro ergonomics and accepted argument forms.

*Call graph*: 1 external calls (feedback_tags!).


##### `TagCollectorVisitor::record_bool`  (lines 32–35)

```
fn record_bool(&mut self, field: &tracing::field::Field, value: bool)
```

**Purpose**: Captures a boolean tracing field into the collector map under the field's tracing name.

**Data flow**: Reads the incoming `Field` metadata and `bool` value, converts both to owned `String`s, and inserts them into `self.tags`. It mutates the visitor's internal `BTreeMap` and returns unit.

**Call relations**: It is called by tracing's event-recording machinery when `TagCollectorLayer::on_event` asks an event to record itself into the visitor. It exists so tests can inspect emitted boolean tags as strings.

*Call graph*: 1 external calls (name).


##### `TagCollectorVisitor::record_str`  (lines 37–40)

```
fn record_str(&mut self, field: &tracing::field::Field, value: &str)
```

**Purpose**: Captures a string tracing field into the collector map using the field name as the key.

**Data flow**: Takes a `Field` and `&str`, clones both into owned strings, and inserts them into `self.tags`. It updates visitor state in place and returns unit.

**Call relations**: Like the other `Visit` methods, this is driven indirectly by `event.record(&mut visitor)` inside `TagCollectorLayer::on_event`. It handles plain string-valued tracing fields.

*Call graph*: 1 external calls (name).


##### `TagCollectorVisitor::record_debug`  (lines 42–45)

```
fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug)
```

**Purpose**: Captures any tracing field recorded through `Debug` formatting, preserving the exact debug-rendered representation.

**Data flow**: Reads the field name and a `&dyn Debug`, formats the value with `{:?}`, and stores the resulting string in `self.tags`. This mutates the visitor map and returns unit.

**Call relations**: This path is important for optional and non-string fields emitted by feedback-tag helpers; `TagCollectorLayer::on_event` relies on it when tracing records values via debug formatting rather than typed string/bool methods.

*Call graph*: 2 external calls (name, format!).


##### `TagCollectorLayer::on_event`  (lines 58–66)

```
fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>)
```

**Purpose**: Intercepts tracing events for the `feedback_tags` target and accumulates their fields into shared test state.

**Data flow**: Receives a `tracing::Event` and subscriber context, checks `event.metadata().target()`, and returns early for non-feedback events. For matching events it creates a default `TagCollectorVisitor`, asks the event to record into it, extends the shared `tags` map with the collected fields, increments the shared `event_count`, and returns unit.

**Call relations**: This method is invoked by the tracing subscriber installed in each test via `registry().with(...).set_default()`. It is the bridge between production feedback-tag emitters and the assertions in the test cases.

*Call graph*: 3 external calls (default, metadata, record).


##### `emit_feedback_request_tags_records_sentry_feedback_fields`  (lines 70–170)

```
fn emit_feedback_request_tags_records_sentry_feedback_fields()
```

**Purpose**: Verifies that request-tag emission with explicit auth-environment telemetry produces the full expected set of tracing fields in a single feedback event.

**Data flow**: Builds shared `tags` and `event_count` state, installs `TagCollectorLayer` as the default subscriber, constructs an `AuthEnvTelemetry` and a populated `FeedbackRequestTags`, then calls `emit_feedback_request_tags_with_auth_env`. After emission it clones the collected tag map and asserts exact string values for endpoint, auth header, auth env, request ID, error, and follow-up fields, plus an event count of 1.

**Call relations**: The test runner invokes this directly. It drives the external emitter and depends on `TagCollectorLayer::on_event` plus the visitor methods to observe the emitted tracing payload.

*Call graph*: 6 external calls (new, new, new, assert_eq!, emit_feedback_request_tags_with_auth_env, registry).


##### `emit_feedback_auth_recovery_tags_preserves_401_specific_fields`  (lines 173–211)

```
fn emit_feedback_auth_recovery_tags_preserves_401_specific_fields()
```

**Purpose**: Checks that auth-recovery telemetry writes 401-specific request metadata into dedicated `auth_401_*` fields rather than dropping them.

**Data flow**: Creates the same tracing capture setup as other tests, invokes `emit_feedback_auth_recovery_tags` with recovery metadata and 401-related identifiers/errors, then reads the collected map and asserts the four `auth_401_*` keys contain the expected debug-formatted strings. It also asserts exactly one event was emitted.

**Call relations**: This standalone test is run by the test harness. It validates behavior of the auth-recovery emitter by observing the tracing event captured through the installed layer.

*Call graph*: 5 external calls (new, new, new, assert_eq!, registry).


##### `emit_feedback_auth_recovery_tags_clears_stale_401_fields`  (lines 214–258)

```
fn emit_feedback_auth_recovery_tags_clears_stale_401_fields()
```

**Purpose**: Ensures a later auth-recovery emission clears previously populated 401-specific fields when the new event omits them.

**Data flow**: Installs the collector subscriber, emits one recovery event with populated 401 fields, then emits a second event whose `auth_cf_ray`, `auth_error`, and `auth_error_code` are `None`. It clones the final merged tag map and asserts the latest request ID is present while the omitted fields were overwritten with empty-string values, and that two events were observed.

**Call relations**: The test runner invokes it directly. Its significance is cumulative: because `TagCollectorLayer` extends a persistent map across events, the assertions prove the emitter actively writes clearing values instead of relying on absence.

*Call graph*: 5 external calls (new, new, new, assert_eq!, registry).


##### `emit_feedback_request_tags_preserves_latest_auth_fields_after_unauthorized`  (lines 261–311)

```
fn emit_feedback_request_tags_preserves_latest_auth_fields_after_unauthorized()
```

**Purpose**: Confirms that request-tag emission after an unauthorized response retains the latest auth identifiers and error details in the normal auth fields.

**Data flow**: Sets up tracing capture, calls `emit_feedback_request_tags` with a `FeedbackRequestTags` containing retry/recovery and 401-related fields, then inspects the collected map. It asserts request ID, CF-Ray, auth error, auth error code, and follow-up success are present with the expected serialized values, and that only one event was emitted.

**Call relations**: This test is directly executed by the test harness. It covers the non-auth-env emitter path and checks that unauthorized-response metadata survives into the emitted feedback tags.

*Call graph*: 6 external calls (new, new, new, assert_eq!, emit_feedback_request_tags, registry).


##### `emit_feedback_request_tags_preserves_auth_env_fields_for_legacy_emitters`  (lines 314–425)

```
fn emit_feedback_request_tags_preserves_auth_env_fields_for_legacy_emitters()
```

**Purpose**: Verifies that a legacy request-tag emission without auth-env data clears ordinary auth fields but leaves previously emitted auth-env telemetry intact.

**Data flow**: Installs the collector, emits a first event through `emit_feedback_request_tags_with_auth_env` with full request and environment data, then emits a second event through `emit_feedback_request_tags` where all optional auth fields are `None`. It reads the merged tag map and asserts ordinary auth fields and follow-up fields became empty strings while all `auth_env_*` fields still retain their earlier values; it also checks that two events were captured.

**Call relations**: The test runner invokes this directly. It specifically exercises interaction between two different emitter APIs and relies on the collector's persistent map to detect unintended overwrites.

*Call graph*: 7 external calls (new, new, new, assert_eq!, emit_feedback_request_tags, emit_feedback_request_tags_with_auth_env, registry).


##### `normalize_thread_name_trims_and_rejects_empty`  (lines 428–434)

```
fn normalize_thread_name_trims_and_rejects_empty()
```

**Purpose**: Checks the normalization helper's whitespace handling for thread names.

**Data flow**: Calls `normalize_thread_name` with an all-whitespace string and with a padded non-empty string, then asserts the results are `None` and a trimmed `Some(String)` respectively. It has no side effects beyond assertions.

**Call relations**: This is an isolated unit test run by the test harness. It documents the helper's contract for empty-after-trim input.

*Call graph*: 1 external calls (assert_eq!).


### `core/tests/suite/otel.rs`

`test` · `cross-cutting observability during request processing, tool execution, and approvals`

This module is a dense observability test suite covering two layers: line-oriented tracing output captured by `tracing_test::traced_test`, and explicit span-field recording captured with a custom `tracing_subscriber` writing into a leaked `Mutex<Vec<u8>>`. Small helpers parse log lines (`extract_log_field`), assert that MCP-related fields are present but empty for non-MCP tools, synthesize shell-command function-call events, and generate platform-specific `touch` commands.

The SSE-focused tests mount mock streams containing assistant messages, malformed JSON, `response.failed`, `response.completed`, reasoning items, deltas, and function/custom-tool calls. They then submit simple `Op::UserInput` turns and assert that logs contain `codex.api_request`, `codex.conversation_starts`, `codex.sse_event`, token-usage fields, response-kind span names, and tool metadata such as `tool_name` and `from`. Tool-result tests verify the exact telemetry emitted for unsupported custom tools, unsupported function calls, and shell commands, including arguments, output text, success flags, and empty MCP fields. Approval-flow tests drive `ExecApprovalRequest` events and submit `Op::ExecApproval` decisions to confirm `codex.tool_decision` logs record `approved`, `approvedforsession`, or `denied` with the correct source (`config` or `user`). Finally, `sandbox_outcome_event_records_outcome` directly exercises `SessionTelemetry::sandbox_outcome`, asserting duration fields and outcome serialization.

#### Function details

##### `extract_log_field`  (lines 41–59)

```
fn extract_log_field(line: &str, key: &str) -> Option<String>
```

**Purpose**: Extracts a named field value from a tracing log line, supporting both quoted `key="value"` and bare `key=value` formats. It is careful not to confuse similarly prefixed keys when scanning whitespace-delimited tokens.

**Data flow**: Inputs are a log line and the target key. The function first searches for a quoted prefix and, if found, slices until the next quote; otherwise it scans whitespace-separated tokens, trims trailing commas, strips a bare `key=` prefix, and returns the matched value as `Some(String)` or `None` if absent.

**Call relations**: Only `assert_empty_mcp_tool_fields` calls this helper. The two unit tests at the top of the file indirectly validate its parsing behavior.

*Call graph*: called by 1 (assert_empty_mcp_tool_fields); 1 external calls (format!).


##### `assert_empty_mcp_tool_fields`  (lines 61–77)

```
fn assert_empty_mcp_tool_fields(line: &str) -> Result<(), String>
```

**Purpose**: Checks that a telemetry line contains `mcp_server` and `mcp_server_origin` fields and that both are empty strings. It is used to prove non-MCP tool telemetry still emits those keys in blank form.

**Data flow**: Input is a single log line. The function extracts `mcp_server` and `mcp_server_origin` via `extract_log_field`, returns descriptive `Err(String)` values if either field is missing or non-empty, and otherwise returns `Ok(())`.

**Call relations**: The custom-tool, function-call, and shell-command tool-result tests call this helper inside `logs_assert` closures after locating the relevant `codex.tool_result` line.

*Call graph*: calls 1 internal fn (extract_log_field); 1 external calls (format!).


##### `shell_command_call`  (lines 79–82)

```
fn shell_command_call(call_id: &str, command: &str) -> serde_json::Value
```

**Purpose**: Builds a synthetic Responses API function-call event for the `shell_command` tool. It keeps shell-command SSE fixtures concise in the tests below.

**Data flow**: Inputs are a call id and command string. The function wraps the command in a JSON arguments object, stringifies it, passes it to `ev_function_call(call_id, "shell_command", &args)`, and returns the resulting `serde_json::Value` event.

**Call relations**: Several shell-command telemetry and approval tests use this helper when mounting SSE streams so they do not have to handcraft the JSON each time.

*Call graph*: calls 1 internal fn (ev_function_call); 1 external calls (json!).


##### `touch_command`  (lines 84–90)

```
fn touch_command(path: &str) -> String
```

**Purpose**: Returns a platform-appropriate command string that creates a file, allowing approval tests to use a harmless shell command on both Windows and Unix-like systems. The command text itself is later embedded in shell-command tool calls.

**Data flow**: Input is the target path string. The function checks `cfg!(windows)` and returns either a PowerShell `New-Item` command or `/usr/bin/touch <path>`.

**Call relations**: All user-approval and sandbox-approval tests call this helper to generate the shell command used in the mocked tool call.

*Call graph*: called by 6 (handle_sandbox_error_user_approves_for_session_records_tool_decision, handle_sandbox_error_user_approves_retry_records_tool_decision, handle_sandbox_error_user_denies_records_tool_decision, handle_shell_command_user_approved_for_session_records_tool_decision, handle_shell_command_user_approved_records_tool_decision, handle_shell_command_user_denies_records_tool_decision); 2 external calls (cfg!, format!).


##### `extract_log_field_handles_empty_bare_values`  (lines 93–100)

```
fn extract_log_field_handles_empty_bare_values()
```

**Purpose**: Unit-tests that `extract_log_field` correctly returns empty strings for bare fields written as `key=` with no value. This guards a parsing edge case used by MCP-field assertions.

**Data flow**: It constructs a sample log line with empty `mcp_server` and `mcp_server_origin` values, calls `extract_log_field` twice, and asserts both results are `Some(String::new())`.

**Call relations**: This is a standalone synchronous test validating the helper’s parsing semantics.

*Call graph*: 1 external calls (assert_eq!).


##### `extract_log_field_does_not_confuse_similar_keys`  (lines 103–110)

```
fn extract_log_field_does_not_confuse_similar_keys()
```

**Purpose**: Unit-tests that searching for `mcp_server` does not accidentally match `mcp_server_origin`. It protects against prefix-collision bugs in log parsing.

**Data flow**: It builds a line containing only `mcp_server_origin=stdio`, calls `extract_log_field` for both keys, and asserts `mcp_server` is `None` while `mcp_server_origin` is `Some("stdio")`.

**Call relations**: This is the second direct helper test and complements the empty-value case.

*Call graph*: 1 external calls (assert_eq!).


##### `responses_api_emits_api_request_event`  (lines 114–152)

```
async fn responses_api_emits_api_request_event()
```

**Purpose**: Checks that a normal turn emits high-level telemetry events for the API request and conversation start. It validates the presence of `codex.api_request` and `codex.conversation_starts` log lines.

**Data flow**: The test mounts a minimal completed SSE stream, builds a default session, submits a text `Op::UserInput`, waits for `TurnComplete`, and then scans captured logs for the two expected event names.

**Call relations**: It is a top-level traced async test and serves as the broadest smoke test for request-start telemetry.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_emits_tracing_for_output_item`  (lines 156–193)

```
async fn process_sse_emits_tracing_for_output_item()
```

**Purpose**: Verifies that processing an assistant message SSE event emits a `codex.sse_event` log line tagged as `response.output_item.done`. This confirms output-item completion is traced.

**Data flow**: The test mounts an SSE stream containing `ev_assistant_message` and `ev_completed`, submits a simple user turn, waits for completion, and searches logs for a line containing both `codex.sse_event` and `event.kind=response.output_item.done`.

**Call relations**: It is one of several SSE-processing telemetry tests that differ only in the mounted event stream and expected log content.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_emits_failed_event_on_parse_error`  (lines 197–240)

```
async fn process_sse_emits_failed_event_on_parse_error()
```

**Purpose**: Ensures malformed SSE payloads produce a failed `codex.sse_event` log with the JSON parse error message. The test disables GhostCommit to keep the flow deterministic after the parse failure.

**Data flow**: It mounts a raw non-JSON SSE body, builds a session with `Feature::GhostCommit` disabled, submits a user turn, waits for `TurnComplete`, and asserts logs contain `codex.sse_event`, `error.message`, and the specific parser text `expected ident at line 1 column 2`.

**Call relations**: This test covers the malformed-input branch of SSE processing rather than a structured `response.failed` event.

*Call graph*: calls 3 internal fn (mount_sse_once, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_records_failed_event_when_stream_closes_without_completed`  (lines 244–287)

```
async fn process_sse_records_failed_event_when_stream_closes_without_completed()
```

**Purpose**: Checks that if the SSE stream ends after an assistant message but before `response.completed`, Codex records a failed SSE event noting the premature close. This guards incomplete-stream telemetry.

**Data flow**: The test mounts an SSE stream with only `ev_assistant_message`, disables GhostCommit, submits a user turn, waits for completion, and scans logs for `codex.sse_event` with `error.message` mentioning `stream closed before response.completed`.

**Call relations**: It is another negative SSE-path test, focused on transport termination rather than parse failure.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_failed_event_records_response_error_message`  (lines 291–355)

```
async fn process_sse_failed_event_records_response_error_message()
```

**Purpose**: Verifies that a structured `response.failed` event with an error object logs the embedded error message. The test then allows a follow-up local-shell completion so the turn can finish cleanly.

**Data flow**: It mounts one SSE stream containing a JSON `response.failed` with `{message: "boom", code: "bad"}`, then a second stream with an assistant message and completion. After submitting a user turn and waiting for `TurnComplete`, it asserts logs contain `codex.sse_event`, `event.kind=response.failed`, `error.message`, and `boom`.

**Call relations**: This test covers the structured failure branch where the response error object is well-formed and should be surfaced verbatim.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_failed_event_logs_parse_error`  (lines 359–417)

```
async fn process_sse_failed_event_logs_parse_error()
```

**Purpose**: Checks that even when a `response.failed` event has an invalid error payload shape, Codex still logs a `codex.sse_event` for `response.failed`. The emphasis is on not dropping telemetry when parsing the nested error object fails.

**Data flow**: The test mounts a malformed `response.failed` event whose `response.error` is a string, then a second completion stream, submits a user turn, waits for completion, and asserts logs contain `codex.sse_event` with `event.kind=response.failed`.

**Call relations**: It complements the previous test by covering malformed nested error content rather than a valid error object.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_failed_event_logs_missing_error`  (lines 421–469)

```
async fn process_sse_failed_event_logs_missing_error()
```

**Purpose**: Ensures a `response.failed` event lacking an `error` field still produces a `codex.sse_event` log tagged as `response.failed`. This guards another malformed-server edge case.

**Data flow**: It mounts an SSE stream containing `{"type":"response.failed","response":{}}`, disables GhostCommit, submits a user turn, waits for completion, and asserts the logs contain a `codex.sse_event` line with `event.kind=response.failed`.

**Call relations**: This is the missing-error variant of the malformed `response.failed` telemetry tests.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_failed_event_logs_response_completed_parse_error`  (lines 473–533)

```
async fn process_sse_failed_event_logs_response_completed_parse_error()
```

**Purpose**: Verifies that a malformed `response.completed` payload logs a parse error rather than silently succeeding. The expected log mentions failure to parse `ResponseCompleted`.

**Data flow**: The test mounts a malformed `response.completed` event with an empty `response` object, then a second completion stream, submits a user turn, waits for completion, and asserts logs contain `codex.sse_event`, `event.kind=response.completed`, `error.message`, and `failed to parse ResponseCompleted`.

**Call relations**: It is the `response.completed` analogue of the malformed `response.failed` tests.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_emits_completed_telemetry`  (lines 537–591)

```
async fn process_sse_emits_completed_telemetry()
```

**Purpose**: Checks that a well-formed `response.completed` event logs token-usage telemetry fields for input, output, cached, reasoning, and total/tool tokens. This validates extraction of usage counters from the SSE payload.

**Data flow**: The test mounts a `response.completed` SSE event whose `usage` object contains concrete token counts, submits a user turn, waits for completion, and scans logs for a `codex.sse_event` line containing `event.kind=response.completed` plus `input_token_count=3`, `output_token_count=5`, `cached_token_count=1`, `reasoning_token_count=2`, and `tool_token_count=9`.

**Call relations**: This is the positive counterpart to the malformed completion test and focuses on line-level telemetry rather than span fields.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `turn_and_completed_response_spans_record_token_usage`  (lines 594–683)

```
async fn turn_and_completed_response_spans_record_token_usage()
```

**Purpose**: Asserts that both the `handle_responses` completion span and the enclosing turn span record detailed token-usage fields and reasoning effort. It validates span enrichment, not just emitted event lines.

**Data flow**: The test installs a custom tracing subscriber writing into an in-memory buffer, mounts a `response.completed` SSE event with usage counts, builds a session configured with `ReasoningEffort::High` and GhostCommit disabled, submits a user turn, waits for completion, and converts the buffer to a string. It then asserts one log line for `handle_responses{... otel.name="completed" ...}` contains request reasoning effort and usage fields, and another `turn{otel.name="session_task.turn" ...}` line contains the corresponding turn-level token-usage fields including non-cached input tokens.

**Call relations**: This test is one of the span-field-focused cases that bypass `traced_test` and instead install a dedicated subscriber to inspect span close output.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 12 external calls (leak, new, default, new, new, from_utf8, new, assert!, wait_for_event, set_default (+2 more)).


##### `handle_responses_span_records_response_kind_and_tool_name`  (lines 686–760)

```
async fn handle_responses_span_records_response_kind_and_tool_name()
```

**Purpose**: Verifies that `handle_responses` spans record both the response kind and tool name when processing a function call, and still emit a separate completion span afterward. It checks metadata attached to spans rather than event logs.

**Data flow**: Using a custom subscriber buffer, the test mounts one SSE stream with `ev_function_call("function-call", "nonexistent", ...)` and completion, then a second stream with a final assistant message. After submitting a user turn and waiting for completion, it asserts the logs contain a `handle_responses{... otel.name="function_call" ... tool_name="nonexistent" ... from="output_item_done"}` line and another `handle_responses{... otel.name="completed"}` line.

**Call relations**: It complements the token-usage span test by focusing on response-kind/tool-name metadata for intermediate response items.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 12 external calls (leak, new, default, new, new, from_utf8, new, assert!, wait_for_event, set_default (+2 more)).


##### `record_responses_sets_span_fields_for_response_events`  (lines 763–871)

```
async fn record_responses_sets_span_fields_for_response_events()
```

**Purpose**: Checks a broad matrix of `handle_responses` span names and optional fields across created, rate-limit, function-call, assistant-message, reasoning, delta, and completed events. It is the most exhaustive span-field regression in the file.

**Data flow**: The test installs a custom subscriber, mounts a first `/responses` body containing `ev_response_created`, `response.output_item.added` for a function call, message-added, reasoning-added, text deltas, reasoning-summary and reasoning-content deltas, a function-call done event, an assistant message, a reasoning item, and completion; then mounts a second completion response. After submitting a user turn and waiting for completion, it scans the buffered logs for expected `handle_responses{...}` lines matching each `(otel.name, from, tool_name)` tuple while also requiring `codex.request.reasoning_effort=high`.

**Call relations**: This test drives the richest synthetic SSE stream in the file. It validates that the response-recording layer consistently annotates spans across many event kinds.

*Call graph*: calls 5 internal fn (mount_response_once, sse, sse_response, start_mock_server, test_codex); 13 external calls (leak, new, default, new, new, from_utf8, new, assert!, wait_for_event, format! (+3 more)).


##### `handle_response_item_records_tool_result_for_custom_tool_call`  (lines 875–950)

```
async fn handle_response_item_records_tool_result_for_custom_tool_call()
```

**Purpose**: Verifies telemetry for an unsupported custom tool call, including call id, tool name, raw arguments, synthesized failure output, `success=false`, and empty MCP fields. It proves unsupported custom tools still produce a structured `codex.tool_result` event.

**Data flow**: The test mounts a first SSE stream with `ev_custom_tool_call("custom-tool-call", "unsupported_tool", ...)` and completion, then a second stream with a final assistant message. After submitting a user turn and waiting for completion, it locates the `codex.tool_result` line for that call id and checks the expected substrings plus `assert_empty_mcp_tool_fields(line)`.

**Call relations**: This is one of three tool-result tests; it covers the custom-tool branch specifically.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `handle_response_item_records_tool_result_for_function_call`  (lines 954–1026)

```
async fn handle_response_item_records_tool_result_for_function_call()
```

**Purpose**: Checks telemetry for an unsupported ordinary function call. The expected output text is `unsupported call: <name>` and the event must include arguments, failure status, and blank MCP fields.

**Data flow**: The test mounts a function-call SSE stream followed by a completion stream, submits a user turn, waits for a `TokenCount` event, then finds the `codex.tool_result` line for `function-call`. It asserts presence of `tool_name=nonexistent`, the JSON arguments, `output=unsupported call: nonexistent`, `success=false`, and empty MCP fields.

**Call relations**: It parallels the custom-tool test but exercises the standard function-call path.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `handle_response_item_records_tool_result_for_shell_command_call`  (lines 1030–1104)

```
async fn handle_response_item_records_tool_result_for_shell_command_call()
```

**Purpose**: Verifies that shell-command execution emits a `codex.tool_result` event with the command arguments, some non-empty output field, `success=false`, and blank MCP fields. The test configures approvals so the shell command can run without prompting.

**Data flow**: The test mounts a shell-command function call and a follow-up assistant completion, builds a session with GhostCommit disabled and approval policy forced to `Never`, submits a user turn, waits for completion, and inspects the `codex.tool_result` line for `shell-call`. It checks `tool_name=shell_command`, the serialized command arguments, that an `output=` field exists and is non-empty, `success=false`, and empty MCP fields.

**Call relations**: This is the shell-command variant of the tool-result telemetry tests and uses `shell_command_call` to build the SSE fixture.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `tool_decision_assertion`  (lines 1106–1136)

```
fn tool_decision_assertion(
    call_id: &'a str,
    expected_decision: &'a str,
    expected_source: &'a str,
) -> impl Fn(&[&str]) -> Result<(), String> + 'a
```

**Purpose**: Builds a reusable log-assertion closure that checks a `codex.tool_decision` event for a specific call id, decision, and source. It normalizes comparisons by lowercasing the matched line.

**Data flow**: Inputs are the target call id, expected decision string, and expected source string. The function clones them into owned strings and returns a closure that scans a slice of log lines for `codex.tool_decision` with the call id, then verifies lowercase substrings for `tool_name=shell_command`, `decision=<expected>`, and `source=<expected>`.

**Call relations**: All shell-command approval-decision tests call this helper inside `logs_assert`, allowing each test to focus on driving the approval path rather than rewriting the same log parsing.

*Call graph*: called by 7 (handle_sandbox_error_user_approves_for_session_records_tool_decision, handle_sandbox_error_user_approves_retry_records_tool_decision, handle_sandbox_error_user_denies_records_tool_decision, handle_shell_command_autoapprove_from_config_records_tool_decision, handle_shell_command_user_approved_for_session_records_tool_decision, handle_shell_command_user_approved_records_tool_decision, handle_shell_command_user_denies_records_tool_decision).


##### `sandbox_outcome_assertion`  (lines 1138–1170)

```
fn sandbox_outcome_assertion(
    call_id: &'a str,
    expected_outcome: &'a str,
) -> impl Fn(&[&str]) -> Result<(), String> + 'a
```

**Purpose**: Builds a reusable log-assertion closure for `codex.sandbox_outcome` events, checking the outcome and both duration fields. It is tailored to the direct `SessionTelemetry::sandbox_outcome` test.

**Data flow**: Inputs are a call id and expected outcome string. The returned closure finds the matching `codex.sandbox_outcome` line, lowercases it, and verifies `tool_name=shell_command`, `outcome=<expected>`, `initial_duration_ms=12`, and `escalated_duration_ms=34`.

**Call relations**: Only `sandbox_outcome_event_records_outcome` uses this helper.

*Call graph*: called by 1 (sandbox_outcome_event_records_outcome).


##### `sandbox_outcome_event_records_outcome`  (lines 1174–1200)

```
fn sandbox_outcome_event_records_outcome()
```

**Purpose**: Directly exercises `SessionTelemetry::sandbox_outcome` and verifies the emitted log line records the expected outcome and durations. This bypasses the rest of Codex to test the telemetry helper in isolation.

**Data flow**: The test constructs a `SessionTelemetry` with a fresh `ThreadId`, model names, auth mode, app name, terminal kind, and `SessionSource::Cli`, then calls `telemetry.sandbox_outcome("shell_command", "sandbox-outcome-call", "escalated", 12ms, Some(34ms))`. It finally runs `logs_assert` with `sandbox_outcome_assertion(...)`.

**Call relations**: This is the only test in the file that does not build a `TestCodex` session. It validates the telemetry emitter directly.

*Call graph*: calls 3 internal fn (sandbox_outcome_assertion, new, new); 1 external calls (from_millis).


##### `handle_shell_command_autoapprove_from_config_records_tool_decision`  (lines 1204–1257)

```
async fn handle_shell_command_autoapprove_from_config_records_tool_decision()
```

**Purpose**: Checks that when configuration auto-approves shell commands, telemetry records a `codex.tool_decision` event with decision `approved` and source `config`. It covers the non-interactive approval path.

**Data flow**: The test mounts a shell-command call and completion, builds a session with approval policy `OnRequest` but permission profile `Disabled`, submits a user turn, waits for completion, and asserts logs satisfy `tool_decision_assertion("auto_config_call", "approved", "config")`.

**Call relations**: It is the config-driven approval counterpart to the user-driven approval tests below.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion); 3 external calls (default, wait_for_event, vec!).


##### `handle_shell_command_user_approved_records_tool_decision`  (lines 1261–1327)

```
async fn handle_shell_command_user_approved_records_tool_decision()
```

**Purpose**: Verifies that when the user explicitly approves a shell command, telemetry records decision `approved` with source `user`. It drives the interactive approval flow through `ExecApprovalRequest` and `Op::ExecApproval`.

**Data flow**: The test mounts a shell-command call using a platform-specific touch command, builds a session with `AskForApproval::UnlessTrusted`, submits a user turn, waits for `EventMsg::ExecApprovalRequest`, extracts the effective approval id, submits `Op::ExecApproval { decision: ReviewDecision::Approved }`, waits for `TokenCount`, and asserts the expected tool-decision log.

**Call relations**: This test is one of several nearly identical approval-flow tests that differ only in the submitted `ReviewDecision` and expected telemetry strings.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_shell_command_user_approved_for_session_records_tool_decision`  (lines 1331–1397)

```
async fn handle_shell_command_user_approved_for_session_records_tool_decision()
```

**Purpose**: Checks that approving a shell command for the session records decision `approvedforsession` with source `user`. It validates the persistent-approval variant of the interactive flow.

**Data flow**: The setup mirrors the previous test, but after receiving `ExecApprovalRequest` it submits `ReviewDecision::ApprovedForSession`. After waiting for `TokenCount`, it asserts the log matches `tool_decision_assertion("user_approved_session_call", "approvedforsession", "user")`.

**Call relations**: It shares the same control flow as the ordinary user-approval test but covers the session-scoped approval branch.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_sandbox_error_user_approves_retry_records_tool_decision`  (lines 1401–1467)

```
async fn handle_sandbox_error_user_approves_retry_records_tool_decision()
```

**Purpose**: Verifies telemetry when the user approves a retry after a sandbox-related approval request. The expected decision is still `approved` from source `user`.

**Data flow**: The test mounts a shell-command call and completion, builds a session requiring approval, submits a user turn, waits for `ExecApprovalRequest`, responds with `ReviewDecision::Approved`, waits for `TokenCount`, and asserts the corresponding tool-decision log for `sandbox_retry_call`.

**Call relations**: Although named for sandbox retry, its observable assertion is the same decision/source pair as ordinary user approval; the distinction is the scenario being exercised in the runtime.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_shell_command_user_denies_records_tool_decision`  (lines 1471–1537)

```
async fn handle_shell_command_user_denies_records_tool_decision()
```

**Purpose**: Checks that denying a shell command emits a `codex.tool_decision` event with decision `denied` and source `user`. This covers the negative branch of interactive approval.

**Data flow**: The test mounts a shell-command call and completion, builds a session with `UnlessTrusted`, submits a user turn, waits for `ExecApprovalRequest`, submits `ReviewDecision::Denied`, waits for `TokenCount`, and asserts the denial log via `tool_decision_assertion("user_denied_call", "denied", "user")`.

**Call relations**: It is the denial counterpart to the user-approval tests.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_sandbox_error_user_approves_for_session_records_tool_decision`  (lines 1541–1607)

```
async fn handle_sandbox_error_user_approves_for_session_records_tool_decision()
```

**Purpose**: Verifies that approving a sandbox-related shell command for the session records `approvedforsession` from source `user`. It covers the persistent-approval branch in the sandbox-error scenario.

**Data flow**: The test follows the same pattern as the other approval tests: mount shell-command SSE, build a session requiring approval, submit a turn, wait for `ExecApprovalRequest`, respond with `ReviewDecision::ApprovedForSession`, wait for `TokenCount`, and assert the expected tool-decision log for `sandbox_session_call`.

**Call relations**: This is the sandbox-scenario analogue of `handle_shell_command_user_approved_for_session_records_tool_decision`.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_sandbox_error_user_denies_records_tool_decision`  (lines 1611–1678)

```
async fn handle_sandbox_error_user_denies_records_tool_decision()
```

**Purpose**: Checks that denying a sandbox-related shell command emits decision `denied` from source `user`. It completes the matrix of sandbox approval outcomes.

**Data flow**: The test mounts the shell-command SSE sequence, builds a session with `UnlessTrusted`, submits a turn, waits for `ExecApprovalRequest`, submits `ReviewDecision::Denied`, waits for `TokenCount`, and asserts the denial log for `sandbox_deny_call`.

**Call relations**: This is the final approval-decision test and the sandbox-error counterpart to `handle_shell_command_user_denies_records_tool_decision`.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


### `state/src/log_db_filter_tests.rs`

`test` · `request handling`

This file is a focused async integration test around the state runtime’s log persistence layer. The test creates an isolated temporary Codex home directory using a UUID suffix, initializes a full `StateRuntime`, and starts the logging layer returned by `start(runtime.clone())`. It then installs that layer as the default tracing subscriber with a permissive `Targets` filter set to `TRACE`, ensuring any filtering observed comes from the sink implementation itself rather than subscriber-level suppression.

The test emits four events: `TRACE` and `DEBUG` for target `opentelemetry_sdk`, `INFO` for the same target, and `TRACE` for target `codex_state`. After forcing `layer.flush().await` and dropping the subscriber guard, it queries persisted logs through `runtime.query_logs(&crate::LogQuery::default())`. The assertion projects each row down to `(level, target, message)` and expects only two retained rows: the `INFO` OpenTelemetry event and the `TRACE` Codex event. That makes the intended invariant explicit: low-level OpenTelemetry SDK chatter is filtered out before storage, but normal application traces and higher-level SDK messages remain queryable. The test also performs best-effort cleanup of the temporary directory at the end.

#### Function details

##### `sqlite_sink_drops_low_level_opentelemetry_sdk_logs`  (lines 10–53)

```
async fn sqlite_sink_drops_low_level_opentelemetry_sdk_logs()
```

**Purpose**: Builds a temporary runtime and tracing subscriber, emits representative log events, flushes the sink, and asserts that only the allowed records were written to the log database. It specifically exercises the sink’s special-case filtering for `opentelemetry_sdk` targets.

**Data flow**: It derives a unique temporary `codex_home` path from `std::env::temp_dir()` plus a generated `Uuid`, passes that path and a provider string into `StateRuntime::init`, and feeds the resulting runtime into `start(...)` to obtain the log layer. With a default subscriber guard installed, it writes four tracing events, flushes the layer, queries all logs via `runtime.query_logs(&crate::LogQuery::default())`, maps each `LogRow` to `(level.as_str(), target.as_str(), message.as_deref())`, and compares the collected vector against the expected retained rows. Finally it removes the temporary directory with `tokio::fs::remove_dir_all` on a best-effort basis.

**Call relations**: This is a top-level Tokio test invoked by the test runner. Within the test flow it drives runtime initialization first, then constructs the logging layer, then emits events under a permissive subscriber filter so the sink’s own filtering logic is what determines persistence, and finally validates persisted output by querying the runtime after an explicit flush.

*Call graph*: calls 1 internal fn (init); 10 external calls (new, assert_eq!, format!, default, temp_dir, remove_dir_all, debug!, info!, trace!, registry).
