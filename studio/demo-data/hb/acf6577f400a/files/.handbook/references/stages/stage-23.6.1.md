# Analytics and telemetry tests  `stage-23.6.1`

This stage is a behind-the-scenes safety check for observability: the code that records what the system is doing. “Telemetry” means measurements, logs, and traces that help developers understand sessions without inspecting them by hand. The OpenTelemetry test entry files, tests.rs and suite/mod.rs, assemble the test suite, while harness/mod.rs provides an in-memory fake metrics collector. The validation, timing, send, snapshot, runtime_summary, manager_metrics, export-routing, and HTTP loopback tests check that metrics reject bad input, record durations, flush correctly, can be read immediately, summarize runtime activity, carry the right labels, route sensitive details safely, and can be exported to a local fake collector. The analytics client tests check that app-server activity becomes the right analytics events, with batching and privacy limits. The app-server analytics tests decide when analytics should run and provide HTTP capture helpers. Core task and utility tests verify telemetry tags for proxy use, memory, compaction, feedback, authentication failures, and thread names. The main core OpenTelemetry test checks session logs and traces. The state log filter test keeps noisy low-level SDK messages out of the user-facing log database.

## Files in this stage

### OTEL test scaffolding
These files define the OpenTelemetry integration test crate, organize its suite modules, and provide the shared in-memory harness used by the individual tests.

### `otel/tests/tests.rs`

`test` · `test discovery and test compilation`

This file is like the front door for a group of tests. It does not contain test cases itself. Instead, it connects two nearby modules: `harness`, which likely provides shared test setup and helper tools, and `suite`, which likely contains the actual test scenarios.

The first line relaxes one lint rule from Clippy, Rust’s extra code checker. Normally, Clippy may warn when tests use `expect`, a helper that stops the test with a clear message if something goes wrong. In test code, that is often acceptable because a failed setup should usually fail loudly and explain why. This file allows that style for this test target.

Without this file, Rust would not know to compile and run the `harness` and `suite` modules as part of this integration test. In everyday terms, it is the table of contents for this test package: short, but necessary for the rest of the tests to be found.


### `otel/tests/suite/mod.rs`

`test` · `test discovery and compilation`

This file does not contain test logic itself. Instead, it names the separate test files that make up the OpenTelemetry test suite, such as tests for metric management, export routing, loopback HTTP behavior, runtime summaries, sending data, snapshots, timing, and validation. In Rust, a `mod` line is like putting a chapter into a book: it makes another source file part of the current module tree. Without this file, those test modules would not be connected here, so the test runner might not discover or compile them as part of this suite. Its main job is organization. It keeps the suite split into focused files while still presenting them as one coherent group of tests.


### `otel/tests/harness/mod.rs`

`test` · `test execution`

This file exists so metrics tests can be clear and repeatable. In normal use, metrics may be sent to an outside telemetry system. In tests, that would be slow, flaky, and hard to inspect. Instead, this harness builds a MetricsClient connected to an in-memory exporter, which is like a notebook that records every metric the code tried to send.

The helpers cover the common steps most tests need. First, build_metrics_with_defaults creates a test metrics setup and optionally adds default tags, which are labels attached to every metric, such as service names or metadata. After the code under test records metrics, latest_metrics pulls out the most recent batch from the in-memory exporter. find_metric searches that batch by metric name. attributes_to_map turns OpenTelemetry key-value labels into a simple sorted map, making assertions easier to read. histogram_data extracts bucket boundaries, bucket counts, sum, and total count from a histogram metric, while deliberately failing fast if the metric is missing or is not shaped like the test expects.

Together these helpers keep individual tests focused on the behavior they care about, rather than on the plumbing needed to read OpenTelemetry data structures.

#### Function details

##### `build_metrics_with_defaults`  (lines 12–27)

```
fn build_metrics_with_defaults(
    default_tags: &[(&str, &str)],
) -> Result<(MetricsClient, InMemoryMetricExporter)>
```

**Purpose**: Creates a ready-to-use metrics client for tests, connected to an in-memory exporter instead of a real telemetry backend. Tests use it when they need to record metrics and then inspect exactly what was produced.

**Data flow**: It receives a list of default tag key-value pairs. It creates an in-memory exporter, builds a test MetricsConfig using the package version and fixed test service details, adds each default tag to that config, then constructs a MetricsClient. It returns both the client, which records metrics, and the exporter, which stores the recorded output for later inspection.

**Call relations**: Many metrics tests start here before exercising the code they want to check. This helper relies on the metrics configuration builder and MetricsClient constructor, then hands the client to the test and the exporter to later helpers such as latest_metrics.

*Call graph*: calls 2 internal fn (new, in_memory); called by 13 (manager_allows_disabling_metadata_tags, manager_attaches_metadata_tags_to_metrics, manager_attaches_optional_service_name_tag, manager_records_plugin_install_elicitation_sent_metric, manager_records_plugin_install_suggestion_metric, client_sends_enqueued_metric, send_builds_payload_with_tags_and_histograms, send_merges_default_tags_per_line, shutdown_flushes_in_memory_exporter, shutdown_without_metrics_exports_nothing (+3 more)); 2 external calls (default, env!).


##### `latest_metrics`  (lines 29–36)

```
fn latest_metrics(exporter: &InMemoryMetricExporter) -> ResourceMetrics
```

**Purpose**: Gets the newest exported metrics batch from the in-memory exporter. Tests use it after recording metrics so they can inspect the final captured data.

**Data flow**: It receives an in-memory exporter. It asks the exporter for all finished metric batches, takes the last one, and returns it as ResourceMetrics. If no finished metrics are available, it stops the test with a clear failure message.

**Call relations**: After tests create a metrics client with build_metrics_with_defaults and record one or more metrics, they call this helper to retrieve the captured batch. The returned ResourceMetrics is then commonly passed to find_metric or histogram_data for detailed checks.

*Call graph*: called by 12 (manager_allows_disabling_metadata_tags, manager_attaches_metadata_tags_to_metrics, manager_attaches_optional_service_name_tag, manager_records_plugin_install_elicitation_sent_metric, manager_records_plugin_install_suggestion_metric, client_sends_enqueued_metric, send_builds_payload_with_tags_and_histograms, send_merges_default_tags_per_line, shutdown_flushes_in_memory_exporter, record_duration_records_histogram (+2 more)); 1 external calls (get_finished_metrics).


##### `find_metric`  (lines 38–50)

```
fn find_metric(
    resource_metrics: &'a ResourceMetrics,
    name: &str,
) -> Option<&'a Metric>
```

**Purpose**: Looks through a captured metrics batch and finds the metric with a given name. This saves tests from repeating the nested OpenTelemetry search code.

**Data flow**: It receives a ResourceMetrics object and a metric name. It walks through the grouped metric data, checks each metric's name, and returns the matching metric if one is found. If there is no match, it returns nothing.

**Call relations**: Tests call this directly when they want to assert that a named metric exists and inspect it themselves. histogram_data also uses it first, because extracting histogram values only makes sense after locating the named metric.

*Call graph*: called by 15 (histogram_data, manager_allows_disabling_metadata_tags, manager_attaches_metadata_tags_to_metrics, manager_attaches_optional_service_name_tag, manager_records_plugin_install_elicitation_sent_metric, manager_records_plugin_install_suggestion_metric, client_sends_enqueued_metric, send_builds_payload_with_tags_and_histograms, send_merges_default_tags_per_line, shutdown_flushes_in_memory_exporter (+5 more)); 1 external calls (scope_metrics).


##### `attributes_to_map`  (lines 52–58)

```
fn attributes_to_map(
    attributes: impl Iterator<Item = &'a KeyValue>,
) -> BTreeMap<String, String>
```

**Purpose**: Turns metric attributes, which are OpenTelemetry key-value labels, into an ordinary sorted map of strings. This makes test assertions simpler and more readable.

**Data flow**: It receives an iterator over KeyValue attributes. For each attribute, it converts the key and value into owned strings, then collects them into a BTreeMap, which keeps keys in a stable sorted order. It returns that map without changing the original metric data.

**Call relations**: After a test finds a metric or data point, it uses this helper to compare the metric's labels against expected tags. It is often used alongside latest_metrics and find_metric in tests that verify metadata or default tags.

*Call graph*: called by 11 (manager_allows_disabling_metadata_tags, manager_attaches_metadata_tags_to_metrics, manager_attaches_optional_service_name_tag, manager_records_plugin_install_elicitation_sent_metric, manager_records_plugin_install_suggestion_metric, client_sends_enqueued_metric, send_builds_payload_with_tags_and_histograms, send_merges_default_tags_per_line, manager_snapshot_metrics_collects_without_shutdown, snapshot_collects_metrics_without_shutdown (+1 more)); 1 external calls (map).


##### `histogram_data`  (lines 60–79)

```
fn histogram_data(
    resource_metrics: &ResourceMetrics,
    name: &str,
) -> (Vec<f64>, Vec<u64>, f64, u64)
```

**Purpose**: Extracts the important values from a named histogram metric so tests can check duration or bucket-based measurements. A histogram is a metric that groups observed numbers into ranges, like sorting temperatures into low, medium, and high buckets.

**Data flow**: It receives a captured ResourceMetrics object and a metric name. It finds the metric, verifies that it is a floating-point histogram with exactly one data point, then collects the bucket boundaries, bucket counts, total sum, and total count. It returns those four pieces as simple values; if the metric is missing or has an unexpected shape, it fails the test immediately.

**Call relations**: Tests that check timing and duration metrics call this after retrieving exported metrics with latest_metrics. Internally it delegates the name lookup to find_metric, then performs the stricter histogram-specific checks before handing simple data back to the test.

*Call graph*: calls 1 internal fn (find_metric); called by 4 (send_builds_payload_with_tags_and_histograms, record_duration_records_histogram, record_duration_seconds_uses_fractional_seconds_and_scaled_buckets, timer_result_records_success); 2 external calls (assert_eq!, panic!).


### Metrics client behavior
These tests walk through the metrics client and session telemetry APIs from validation and recording through sending, snapshots, summaries, and manager-specific counters.

### `otel/tests/suite/validation.rs`

`test` · `test run`

This is a safety-check test file for the OpenTelemetry metrics layer. Metrics are small measurements the program records, such as counts or timing values. Tags are extra labels attached to those measurements, like adding a sticky note that says which route or feature produced the number. If metric names or tags are malformed, the monitoring data can become confusing, rejected by outside tools, or inconsistent across the system.

The file builds a lightweight metrics client that writes to an in-memory exporter instead of a real monitoring backend. That makes the tests fast and self-contained: they can ask, “Would this input be accepted?” without sending anything over the network.

Each test deliberately gives the metrics API one bad piece of input. It then checks that the returned error is the specific expected error, not just any failure. This matters because callers can rely on precise error kinds to understand what went wrong. The tests cover invalid global config tags, invalid per-metric tag keys, invalid per-metric tag values, invalid metric names, and negative counter increments. In short, this file acts like a guardrail inspection: it proves the metrics client rejects bad labels and impossible counts before they enter the telemetry pipeline.

#### Function details

##### `build_in_memory_client`  (lines 7–11)

```
fn build_in_memory_client() -> Result<MetricsClient>
```

**Purpose**: Creates a metrics client for tests that records data in memory rather than sending it to an external service. This lets validation tests exercise the real metrics API without depending on a live monitoring system.

**Data flow**: It starts with no inputs. It creates a default in-memory metric exporter, builds a metrics configuration for a test service using the package version, and passes that configuration into the metrics client constructor. The result is either a ready-to-use MetricsClient or an error if the client cannot be created.

**Call relations**: The validation tests call this helper when they need a working metrics client before trying one bad metric operation. It relies on the metrics configuration builder and client constructor, so the tests use the same setup path as normal code, just with an in-memory destination.

*Call graph*: calls 2 internal fn (new, in_memory); called by 4 (counter_rejects_invalid_metric_name, counter_rejects_invalid_tag_key, counter_rejects_negative_increment, histogram_rejects_invalid_tag_value); 2 external calls (default, env!).


##### `invalid_tag_component_is_rejected`  (lines 15–30)

```
fn invalid_tag_component_is_rejected() -> Result<()>
```

**Purpose**: Checks that a bad tag key is rejected while building the metrics configuration. This protects the system from starting with globally attached labels that outside telemetry tools may not accept.

**Data flow**: It builds an in-memory metrics configuration and then tries to add the tag key "bad key" with value "value". Because the key contains a space, the call is expected to fail. The test unwraps the error and verifies that it is specifically an InvalidTagComponent error for a tag key with the bad value preserved.

**Call relations**: This test exercises configuration-time validation directly, without using the shared client helper. It calls the in-memory configuration builder and then checks the resulting error with an assertion, proving bad global tags are stopped before a MetricsClient is even created.

*Call graph*: calls 1 internal fn (in_memory); 3 external calls (default, assert!, env!).


##### `counter_rejects_invalid_tag_key`  (lines 34–46)

```
fn counter_rejects_invalid_tag_key() -> Result<()>
```

**Purpose**: Checks that a counter metric refuses a tag whose key is malformed. A counter is a number that only goes up, such as a request count or turn count.

**Data flow**: It first obtains a test MetricsClient from build_in_memory_client. Then it tries to record the counter "codex.turns" with an increment of 1 and a tag key of "bad key". The metric call returns an error instead of recording the value, and the test verifies that the error says the tag key is invalid. Finally, it shuts down the test client cleanly.

**Call relations**: This test depends on build_in_memory_client for a real client configured with an in-memory exporter. After setup, it exercises the counter path and uses an assertion to confirm that per-metric tag validation catches the bad key at record time.

*Call graph*: calls 1 internal fn (build_in_memory_client); 1 external calls (assert!).


##### `histogram_rejects_invalid_tag_value`  (lines 50–66)

```
fn histogram_rejects_invalid_tag_value() -> Result<()>
```

**Purpose**: Checks that a histogram metric refuses a malformed tag value. A histogram records measured values, such as request latency, so they can later be summarized into ranges or percentiles.

**Data flow**: It creates a test MetricsClient, then tries to record the histogram "codex.request_latency" with value 3 and a tag pair where the value is "bad value". Because the tag value contains invalid text, the call returns an InvalidTagComponent error. The test confirms the error names the tag value and includes the rejected value, then shuts down the client.

**Call relations**: This test uses build_in_memory_client for setup, just like the counter validation tests. It then follows the histogram recording path and checks that validation happens before the bad measurement can enter the metrics pipeline.

*Call graph*: calls 1 internal fn (build_in_memory_client); 1 external calls (assert!).


##### `counter_rejects_invalid_metric_name`  (lines 70–79)

```
fn counter_rejects_invalid_metric_name() -> Result<()>
```

**Purpose**: Checks that a counter cannot be recorded with an invalid metric name. This keeps metric names predictable and compatible with the telemetry system.

**Data flow**: It creates a test MetricsClient and then tries to record a counter named "bad name" with an increment of 1 and no tags. The space in the name makes it invalid, so the call returns an InvalidMetricName error. The test verifies the rejected name is reported correctly and then shuts down the client.

**Call relations**: This test gets its client from build_in_memory_client, then focuses on the metric-name validation inside the counter recording path. Its assertion proves that bad names are rejected separately from tag or counter-value problems.

*Call graph*: calls 1 internal fn (build_in_memory_client); 1 external calls (assert!).


##### `counter_rejects_negative_increment`  (lines 82–91)

```
fn counter_rejects_negative_increment() -> Result<()>
```

**Purpose**: Checks that a counter refuses a negative increment. Since counters represent values that only increase, allowing a negative change would make the metric misleading.

**Data flow**: It creates a test MetricsClient and tries to record the counter "codex.turns" with an increment of -1. The counter call returns a NegativeCounterIncrement error rather than recording the value. The test confirms both the metric name and the bad increment are included in the error, then shuts down the client.

**Call relations**: This test uses build_in_memory_client for the common metrics setup, then exercises the counter-specific rule that increments must not be negative. The assertion ties the failure to the expected counter validation behavior.

*Call graph*: calls 1 internal fn (build_in_memory_client); 1 external calls (assert!).


### `otel/tests/suite/timing.rs`

`test` · `test run`

This is a test file for the project’s OpenTelemetry metrics support. OpenTelemetry is a standard way for software to report what it is doing, such as how long requests take. Here, the focus is timing: when the code records a duration, does that duration show up in the exported metrics in the shape other tools expect?

The tests build a metrics system using a test exporter, record one or more durations, then shut the metrics system down so any buffered data is flushed. After that, they inspect the latest exported metrics. A histogram is like sorting measured times into labeled buckets: for example, “under 0.5 seconds” or “under 1 second.” These tests verify that the histogram has bucket boundaries, the right number of recorded events, the expected total sum, and the correct metric metadata.

The file also checks two different time units. One path records milliseconds and expects the unit to be `ms`; another records seconds, including fractional seconds, and expects second-based bucket boundaries. The last test checks the timer object style, where starting a timer and then letting it go out of scope records one measurement automatically, like starting a stopwatch and logging the time when you put it down.

#### Function details

##### `record_duration_records_histogram`  (lines 11–34)

```
fn record_duration_records_histogram() -> Result<()>
```

**Purpose**: This test proves that recording a duration in milliseconds creates a histogram metric. It also checks that the metric uses milliseconds as its unit and has the standard duration description.

**Data flow**: The test starts with a fresh test metrics system and exporter. It records a 15 millisecond duration for the metric named `codex.request_latency`, with a `route=chat` label. After shutdown flushes the data, it reads the exported metrics, extracts the histogram, and checks that exactly one timing was counted, that the total is 15.0, and that the metric metadata says the unit is `ms` with the expected description.

**Call relations**: The Rust test runner calls this function as an individual test. Inside, it relies on `build_metrics_with_defaults` to create the test setup, `latest_metrics` to read what was exported, `histogram_data` to pull out the histogram details, and `find_metric` to inspect the metric’s unit and description.

*Call graph*: calls 4 internal fn (build_metrics_with_defaults, find_metric, histogram_data, latest_metrics); 3 external calls (from_millis, assert!, assert_eq!).


##### `record_duration_seconds_uses_fractional_seconds_and_scaled_buckets`  (lines 37–78)

```
fn record_duration_seconds_uses_fractional_seconds_and_scaled_buckets() -> Result<()>
```

**Purpose**: This test proves that durations can be recorded in seconds, including fractional seconds, and that the histogram buckets are scaled for seconds rather than milliseconds. It protects against accidentally reporting second-based timings with the wrong unit or bucket layout.

**Data flow**: The test creates a fresh metrics system and exporter, then records three durations: 0.2 seconds, 1 second, and 4.9 seconds. Each value is recorded under `codex.request_duration_seconds` with a method label and a custom description. After shutdown, the test reads the exported histogram and checks the exact second-based bucket boundaries, the bucket counts for the three measurements, the total sum of about 6.1 seconds, the count of 3, and the metric unit and description.

**Call relations**: The Rust test runner calls this function during the test suite. The function uses `build_metrics_with_defaults` for setup, `latest_metrics` to retrieve exported results, `histogram_data` to inspect bucket boundaries and counts, and `find_metric` to confirm the metric’s public metadata.

*Call graph*: calls 4 internal fn (build_metrics_with_defaults, find_metric, histogram_data, latest_metrics); 4 external calls (from_millis, from_secs, assert!, assert_eq!).


##### `timer_result_records_success`  (lines 82–118)

```
fn timer_result_records_success() -> Result<()>
```

**Purpose**: This test checks the stopwatch-style timing API. It verifies that starting a timer succeeds and that dropping the timer records one histogram measurement with the original labels attached.

**Data flow**: The test creates a fresh metrics system and exporter, then starts a timer for `codex.request_latency` with the label `route=chat`. The timer is kept only inside a small block; when the block ends, the timer is dropped, which records the elapsed time. After shutdown, the test reads the exported histogram, checks that one measurement was recorded, confirms the unit and description, then converts the metric attributes into a simple map and checks that the `route` label is still `chat`.

**Call relations**: The Rust test runner calls this function as part of the timing test suite. It uses `build_metrics_with_defaults` to prepare an isolated metrics environment, `latest_metrics` and `histogram_data` to verify the recorded timing, `find_metric` to locate the exported metric, and `attributes_to_map` to make the metric labels easy to compare.

*Call graph*: calls 5 internal fn (attributes_to_map, build_metrics_with_defaults, find_metric, histogram_data, latest_metrics); 2 external calls (assert!, assert_eq!).


### `otel/tests/suite/send.rs`

`test` · `test run`

This is a test file for the telemetry system, which is the part of the project that records measurements such as counters, histograms, and gauges. In plain terms, it checks that when Codex says “record one turn,” “record this tool latency,” or “record how many operations are active,” those measurements end up in the exported metrics data with the right names, values, descriptions, and labels.

The tests use an in-memory exporter, which is like a fake mailbox for metrics: instead of sending data over the network, the system drops the finished metrics into a place the test can inspect. Each test builds a metrics client, records one or more measurements, calls shutdown to force delivery, then reads back the exported metrics.

A major focus is tags, also called attributes: small key-value labels such as service=codex-cli or env=prod. The file checks that default tags are added to every metric, that per-call tags can add more detail, and that a per-call tag can override a default tag when both use the same key. It also verifies that shutdown is safe both when there are queued metrics waiting to be sent and when no metrics were recorded at all.

#### Function details

##### `send_builds_payload_with_tags_and_histograms`  (lines 12–108)

```
fn send_builds_payload_with_tags_and_histograms() -> Result<()>
```

**Purpose**: This test checks the full shape of a metrics export when several metric types are recorded. It confirms that counters, histograms, and gauges keep their values, descriptions, and tags, including default tags and per-metric overrides.

**Data flow**: The test starts by creating a metrics client with default tags for service and environment. It records a counter, a histogram, and a gauge, then shuts the client down so queued data is exported. It reads the exported metrics back from the in-memory exporter and compares what came out against the expected names, values, descriptions, bucket counts, sums, and attributes.

**Call relations**: This test drives the normal send path from the outside. It relies on the harness to build the metrics client, collect the latest exported data, find named metrics, convert attributes into an easy-to-compare map, and extract histogram details. It is run by the test framework to prove that the public recording methods produce the correct OpenTelemetry output.

*Call graph*: calls 5 internal fn (attributes_to_map, build_metrics_with_defaults, find_metric, histogram_data, latest_metrics); 4 external calls (from, assert!, assert_eq!, panic!).


##### `send_merges_default_tags_per_line`  (lines 112–179)

```
fn send_merges_default_tags_per_line() -> Result<()>
```

**Purpose**: This test checks the rule for combining default tags with tags supplied for one specific metric. It makes sure default tags are reused on every metric, but a metric-specific tag wins when it uses the same key.

**Data flow**: The test creates a metrics client with default service, environment, and region tags. It records two counters: one overrides the environment, and the other overrides the service. After shutdown, it reads each exported counter and checks that the final attributes are the expected merged set for that individual metric.

**Call relations**: This test focuses on tag-merging behavior in the send flow. It uses the shared harness to create the test metrics setup and inspect the exported results, then uses assertions to lock in the intended precedence rule so later changes do not accidentally change how labels are attached.

*Call graph*: calls 4 internal fn (attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics); 3 external calls (from, assert_eq!, panic!).


##### `client_sends_enqueued_metric`  (lines 183–207)

```
fn client_sends_enqueued_metric() -> Result<()>
```

**Purpose**: This test verifies that a metric recorded by the client is not left sitting in an internal queue. It proves that the background sending work delivers the metric by the time shutdown completes.

**Data flow**: The test creates a metrics client with no default tags, records one counter with a model tag, and calls shutdown. It then reads the exporter output, finds the counter, checks that exactly one point was exported, and confirms that the value and model tag survived the trip.

**Call relations**: This test exercises the queued send path as a user would experience it: record first, flush on shutdown, inspect later. The harness supplies the in-memory exporter and lookup helpers, while the assertions confirm that the background worker did its job.

*Call graph*: calls 4 internal fn (attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics); 2 external calls (assert_eq!, panic!).


##### `shutdown_flushes_in_memory_exporter`  (lines 211–231)

```
fn shutdown_flushes_in_memory_exporter() -> Result<()>
```

**Purpose**: This test makes sure shutdown forces recorded metrics out to the exporter. Without this behavior, a program could exit after recording metrics but lose them before they are delivered.

**Data flow**: The test creates a metrics client, records one counter, and immediately shuts the client down. It then asks the in-memory exporter for the latest metrics, finds the counter, and checks that one data point was exported.

**Call relations**: This test is centered on the shutdown part of the metrics lifecycle. It uses the harness to build and inspect the exporter, and it confirms that shutdown is not just cleanup but also a final flush step.

*Call graph*: calls 3 internal fn (build_metrics_with_defaults, find_metric, latest_metrics); 2 external calls (assert_eq!, panic!).


##### `shutdown_without_metrics_exports_nothing`  (lines 235–243)

```
fn shutdown_without_metrics_exports_nothing() -> Result<()>
```

**Purpose**: This test checks the quiet path where the metrics client is shut down without any measurements being recorded. It ensures the system does not create empty or misleading metric exports.

**Data flow**: The test creates a metrics client with an in-memory exporter and records nothing. After shutdown, it asks the exporter for finished metrics and expects the list to be empty.

**Call relations**: This test covers an edge case in the same shutdown flow used by the other tests. Instead of looking up a metric, it checks the exporter directly to confirm that doing nothing produces no exported data.

*Call graph*: calls 1 internal fn (build_metrics_with_defaults); 1 external calls (assert!).


### `otel/tests/suite/snapshot.rs`

`test` · `test run`

Telemetry is the system’s way of recording facts such as “a shell tool was called successfully.” In normal use, these measurements may be exported later by a background process. These tests make sure there is also a reliable “show me what has been recorded right now” path.

The file builds an in-memory metrics exporter, which is like a notebook kept inside the test instead of sending data over the network. It then records a counter named `codex.tool.call` with labels such as the tool name and whether it succeeded. A snapshot is taken immediately, and the test looks inside that snapshot to confirm the counter exists and has exactly the expected labels.

The first test checks this behavior directly through `MetricsClient`. It also confirms that taking a snapshot does not count as a finished periodic export. That distinction matters: snapshots should be a read-only peek, not a signal that the exporter lifecycle has ended.

The second test checks the same idea through `SessionTelemetry`, which adds session-wide labels such as model name, app version, authentication mode, originator, and session source. This protects the higher-level telemetry path from silently dropping important context.

#### Function details

##### `snapshot_collects_metrics_without_shutdown`  (lines 17–63)

```
fn snapshot_collects_metrics_without_shutdown() -> Result<()>
```

**Purpose**: This test proves that a `MetricsClient` can record a counter and immediately return it in a snapshot. It also verifies that asking for a snapshot does not trigger the normal “finished metrics” export path.

**Data flow**: The test starts with an empty in-memory exporter and builds a metrics configuration with a fixed service tag. It records one `codex.tool.call` counter with `tool=shell` and `success=true`, then asks the metrics client for a snapshot. The snapshot is searched for that metric, its labels are converted into a simple map, and the result is compared with the expected labels. Finally, the exporter is checked to make sure no completed background export has appeared.

**Call relations**: This test uses the metrics setup path by creating a configuration and a `MetricsClient`, then uses helper functions to find the metric and turn its attributes into an easy-to-compare map. It exercises the snapshot path directly, without going through session-level telemetry.

*Call graph*: calls 4 internal fn (new, in_memory, attributes_to_map, find_metric); 6 external calls (from, default, assert!, assert_eq!, env!, panic!).


##### `manager_snapshot_metrics_collects_without_shutdown`  (lines 66–125)

```
fn manager_snapshot_metrics_collects_without_shutdown() -> Result<()>
```

**Purpose**: This test proves that the higher-level `SessionTelemetry` object can also return a current metrics snapshot. It checks that session context is attached to the metric along with the metric’s own labels.

**Data flow**: The test creates an in-memory metrics client, then wraps it in a `SessionTelemetry` object with details such as thread ID, model, account ID, authentication mode, originator, terminal type, and CLI session source. It records one `codex.tool.call` counter through the session manager. When it asks for a metrics snapshot, it finds the counter and compares its labels against the expected combined set: session labels plus `tool=shell` and `success=true`.

**Call relations**: This test sits one layer above the direct metrics-client test. It calls into `SessionTelemetry`, which adds standard session information before handing measurements to the underlying metrics client, and then it uses the same snapshot inspection helpers to confirm the final recorded metric is correct.

*Call graph*: calls 6 internal fn (new, new, in_memory, attributes_to_map, find_metric, new); 5 external calls (from, default, assert_eq!, env!, panic!).


### `otel/tests/suite/runtime_summary.rs`

`test` · `test run`

This test acts like a small rehearsal of a Codex session. Instead of sending real telemetry to an outside service, it uses an in-memory metrics exporter, which is like a notebook kept inside the test so the recorded numbers can be inspected immediately. The test creates a telemetry session, clears any previous runtime metric totals, then records several kinds of activity: one tool result, one normal API request, one WebSocket request, one server-sent event, two WebSocket events, and two turn timing measurements. It also feeds in a special WebSocket timing message that contains detailed timing numbers from the responses API. After all of that, it asks the session for a `RuntimeMetricsSummary`, which is the compact “receipt” of what happened during the run. The expected summary is written out by hand, including each count and total duration. The final assertion compares the real summary to that expected receipt. This matters because runtime metrics are used to explain where time went during a session. If this test failed, Codex might report misleading totals, miss important streaming or WebSocket timings, or fail to include response API timing details.

#### Function details

##### `runtime_metrics_summary_collects_tool_api_and_streaming_metrics`  (lines 17–142)

```
fn runtime_metrics_summary_collects_tool_api_and_streaming_metrics() -> Result<()>
```

**Purpose**: This test verifies that a telemetry session can collect many different runtime measurements and combine them into one accurate summary. It is used to catch mistakes where a metric is not counted, counted twice, or given the wrong duration.

**Data flow**: The test starts with a fresh in-memory metrics exporter and builds a metrics client and telemetry session around it. It then records sample events with known durations and known timing values. After recording, it asks for the runtime summary and compares that result with a hand-written expected summary. Nothing is sent over the network; the important output is whether the assertion passes or fails.

**Call relations**: During the test, this function calls constructors such as `new` and `in_memory` to set up a fake telemetry environment, then uses the session's recording methods to simulate real session activity. At the end, it uses `assert_eq!` to make the runtime summary prove that the earlier records were gathered and totaled correctly.

*Call graph*: calls 4 internal fn (new, new, in_memory, new); 6 external calls (from_millis, default, new, assert_eq!, env!, Text).


### `otel/tests/suite/manager_metrics.rs`

`test` · `test run`

This is a test file for the telemetry layer, which is the part of the system that reports measurements such as “a session started” or “a plugin install was suggested.” Metrics are only useful if their labels are correct. Labels, also called attributes or tags, are small pieces of context like the model name, app version, authentication mode, or tool type. They are like sticky notes on a measurement that explain what the number means.

Each test builds a temporary in-memory metrics setup, creates a `SessionTelemetry` object, records one metric, shuts metrics down so pending data is flushed, then reads back what was exported. The test then checks the metric’s attributes exactly.

The file covers two broad behaviors. First, it checks general session metric tagging: metadata should be added by default, can be turned off, and can include an optional service name. Second, it checks special plugin-install metrics. Those tests make sure only safe, intended labels are included, such as `tool_type`, `response_action`, and `completed`, while more detailed plugin names are not attached as metric labels here.

Without these tests, telemetry changes could accidentally remove important context, add unwanted identifying detail, or break dashboards that depend on stable metric labels.

#### Function details

##### `manager_attaches_metadata_tags_to_metrics`  (lines 19–75)

```
fn manager_attaches_metadata_tags_to_metrics() -> Result<()>
```

**Purpose**: This test proves that ordinary metrics recorded through `SessionTelemetry` automatically receive session metadata tags. It checks that a session-start counter includes context such as app version, model, originator, authentication mode, session source, and the metric’s own `source` tag.

**Data flow**: The test starts with a temporary metrics exporter and a telemetry manager configured with a model, account, authentication mode, originator, terminal type, and CLI session source. It records one counter named `codex.session_started`, flushes the metrics, then reads the exported data back. The output is expected to be one metric point whose attributes match the full expected map of metadata plus the explicit `source=tui` tag.

**Call relations**: During the test, the test harness builds the metrics setup, then `SessionTelemetry::new` creates the telemetry object used by the test. After the counter is recorded and metrics are shut down, helper functions fetch the latest exported metrics, find the named metric, and convert its attributes into a simple map so the assertion can compare expected and actual tags.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 4 external calls (from, assert_eq!, env!, panic!).


##### `manager_allows_disabling_metadata_tags`  (lines 79–121)

```
fn manager_allows_disabling_metadata_tags() -> Result<()>
```

**Purpose**: This test proves that callers can record metrics without the automatic session metadata tags. That matters when a metric should carry only the attributes explicitly supplied by the code that records it.

**Data flow**: The test creates a temporary metrics exporter and a telemetry manager, but attaches metrics using the option that disables metadata tags. It records a `codex.session_started` counter with only `source=tui`, flushes the metrics, then reads back the exported point. The expected result is a single attribute map containing only `source=tui` and none of the usual session metadata.

**Call relations**: The test relies on the shared harness to create and inspect metrics. It exercises the `with_metrics_without_metadata_tags` path on `SessionTelemetry`, then uses the same read-back helpers as the metadata test to confirm that the manager did not add extra labels before export.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 3 external calls (from, assert_eq!, panic!).


##### `manager_attaches_optional_service_name_tag`  (lines 124–165)

```
fn manager_attaches_optional_service_name_tag() -> Result<()>
```

**Purpose**: This test checks that a caller can add a custom service name tag to metrics. This is useful when the same telemetry code may run inside different applications or clients and the exported metrics need to say which one produced them.

**Data flow**: The test builds temporary metrics, creates a telemetry manager without account or authentication details, sets a service name of `my_app_server_client`, and records a session-start counter. After flushing and reading the metric back, it converts the point’s attributes into a map and checks that the `service_name` attribute is present with the configured value.

**Call relations**: This test follows the same setup-record-flush-read pattern as the other manager metric tests. It specifically exercises the configuration step that adds a service name before metrics are attached, then uses the harness helpers to locate the exported counter and inspect its tags.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 2 external calls (assert_eq!, panic!).


##### `manager_records_plugin_install_suggestion_metric`  (lines 168–219)

```
fn manager_records_plugin_install_suggestion_metric() -> Result<()>
```

**Purpose**: This test verifies the metric emitted when the system suggests installing a plugin or connector. It makes sure the exported labels describe the safe, dashboard-relevant facts: tool type, user response action, and whether installation completed.

**Data flow**: The test creates a telemetry manager with metadata tags disabled, then records a plugin-install suggestion for a connector named Google Calendar with an `accept` response, user confirmation set to true, and completion set to false. After metrics are flushed, it finds the plugin-install suggestion metric and reads its attributes. The expected output is one metric point labeled with `tool_type=connector`, `response_action=accept`, and `completed=false`.

**Call relations**: The test calls the specialized `record_plugin_install_suggestion` method on `SessionTelemetry` instead of the generic counter method. The harness then retrieves the exported metric by the shared metric-name constant and turns its attributes into a map so the test can confirm that the specialized recorder chose the right labels.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 2 external calls (assert_eq!, panic!).


##### `manager_records_plugin_install_elicitation_sent_metric`  (lines 222–262)

```
fn manager_records_plugin_install_elicitation_sent_metric() -> Result<()>
```

**Purpose**: This test verifies the metric emitted when the system sends an installation prompt, or elicitation, for a plugin. It checks that the metric records the broad tool type without attaching the specific plugin identifier or display name as labels.

**Data flow**: The test creates temporary metrics and a telemetry manager with automatic metadata tags disabled. It records that an installation elicitation was sent for a Slack plugin, flushes the exporter, and reads back the named metric. The expected result is one metric point with only `tool_type=plugin` in its attributes.

**Call relations**: This test exercises the specialized `record_plugin_install_elicitation_sent` method. After that method records the metric, the shared test helpers collect the latest exported metrics, find the expected metric by its constant name, and expose the attributes for the final equality check.

*Call graph*: calls 6 internal fn (new, attributes_to_map, build_metrics_with_defaults, find_metric, latest_metrics, new); 2 external calls (assert_eq!, panic!).


### Telemetry export and routing
These tests cover how telemetry is routed between logs and traces and how complete OTLP/HTTP exports are emitted over the wire.

### `otel/tests/suite/otel_export_routing_policy.rs`

`test` · `test run`

OpenTelemetry is a standard way for software to report what it is doing through logs and traces. A log is like a detailed receipt; a trace is more like a map of what happened during a request. This test file checks that Codex splits information correctly between those two places.

Each test builds an in-memory telemetry setup, so nothing is sent over the network. It creates a fake log exporter and a fake trace exporter, runs a small piece of SessionTelemetry behavior, flushes the captured data, and then inspects what was recorded.

The main idea is privacy-aware routing. For example, when a user prompt is recorded, the log may contain the actual prompt and user email because it is sent through the log-only path. The trace event should contain useful counts and lengths, such as prompt length or image count, but not the prompt text or user identity. The same pattern is checked for tool results, authentication recovery, API requests, and WebSocket activity.

Small helper functions turn telemetry attributes into easy-to-compare maps and find the event being tested. Without these tests, a future code change could silently put secrets into traces or remove important authentication debugging fields from telemetry.

#### Function details

##### `log_attributes`  (lines 28–33)

```
fn log_attributes(record: &SdkLogRecord) -> BTreeMap<String, String>
```

**Purpose**: This helper turns the attributes on a captured log record into a simple name-to-text map. The tests use it so they can ask plain questions like “does this log contain the prompt?” without dealing with OpenTelemetry’s internal value types.

**Data flow**: It receives one SDK log record. It reads each attribute from the record, converts the attribute value into a string using any_value_to_string, and returns a sorted map from attribute name to text value. It does not change the log record.

**Call relations**: The test functions call this after telemetry has been flushed into the in-memory log exporter. It supports find_log_by_event_name indirectly and is also used directly by the tests to check the exact fields on each chosen log event.

*Call graph*: called by 6 (otel_export_routing_policy_routes_api_request_auth_observability, otel_export_routing_policy_routes_auth_recovery_log_and_trace_events, otel_export_routing_policy_routes_tool_result_log_and_trace_events, otel_export_routing_policy_routes_user_prompt_log_and_trace_events, otel_export_routing_policy_routes_websocket_connect_auth_observability, otel_export_routing_policy_routes_websocket_request_transport_observability); 1 external calls (attributes_iter).


##### `span_event_attributes`  (lines 35–41)

```
fn span_event_attributes(event: &opentelemetry::trace::Event) -> BTreeMap<String, String>
```

**Purpose**: This helper turns the attributes on a trace event into a simple name-to-text map. It lets the tests compare trace data without needing to know the OpenTelemetry attribute structures.

**Data flow**: It receives one trace event. It walks through that event’s attributes, converts each value to text with the value’s normal string form, and returns a sorted map from attribute name to text value. It leaves the event unchanged.

**Call relations**: The test functions call this after looking inside the finished span captured by the in-memory span exporter. find_span_event_by_name_attr also uses the same idea to locate a trace event by its event.name attribute.

*Call graph*: called by 6 (otel_export_routing_policy_routes_api_request_auth_observability, otel_export_routing_policy_routes_auth_recovery_log_and_trace_events, otel_export_routing_policy_routes_tool_result_log_and_trace_events, otel_export_routing_policy_routes_user_prompt_log_and_trace_events, otel_export_routing_policy_routes_websocket_connect_auth_observability, otel_export_routing_policy_routes_websocket_request_transport_observability).


##### `any_value_to_string`  (lines 43–54)

```
fn any_value_to_string(value: &AnyValue) -> String
```

**Purpose**: This helper converts OpenTelemetry log values into ordinary strings so tests can compare them easily. OpenTelemetry log attributes can be integers, booleans, text, bytes, lists, maps, and other forms, so this function gives the tests one common format.

**Data flow**: It receives one OpenTelemetry AnyValue. It checks what kind of value it is, converts common types directly into readable text, decodes bytes as UTF-8 when possible, and falls back to debug-style text for complex or unknown values. The result is a string.

**Call relations**: log_attributes uses this for every log attribute it reads. The test functions do not usually call it directly, but their log assertions depend on it to make OpenTelemetry values comparable with expected strings.

*Call graph*: 4 external calls (as_str, to_string, from_utf8_lossy, format!).


##### `find_log_by_event_name`  (lines 56–67)

```
fn find_log_by_event_name(
    logs: &'a [opentelemetry_sdk::logs::in_memory_exporter::LogDataWithResource],
    event_name: &str,
) -> &'a opentelemetry_sdk::logs::in_memory_exporter::LogDataWithReso
```

**Purpose**: This helper finds the captured log event with a specific event.name attribute. It keeps each test focused on the event it cares about instead of manually searching through all logs.

**Data flow**: It receives a list of captured log records and the event name to search for. It checks each log’s attributes, looking for event.name equal to the requested name. It returns the matching log data, or fails the test if no such log exists.

**Call relations**: Every test uses this after flushing the in-memory log exporter. It relies on log_attributes to read log attributes in a simple form, then hands the matching log back to the test for detailed assertions.

*Call graph*: called by 6 (otel_export_routing_policy_routes_api_request_auth_observability, otel_export_routing_policy_routes_auth_recovery_log_and_trace_events, otel_export_routing_policy_routes_tool_result_log_and_trace_events, otel_export_routing_policy_routes_user_prompt_log_and_trace_events, otel_export_routing_policy_routes_websocket_connect_auth_observability, otel_export_routing_policy_routes_websocket_request_transport_observability); 1 external calls (iter).


##### `find_span_event_by_name_attr`  (lines 69–81)

```
fn find_span_event_by_name_attr(
    events: &'a [opentelemetry::trace::Event],
    event_name: &str,
) -> &'a opentelemetry::trace::Event
```

**Purpose**: This helper finds a trace event with a specific event.name attribute inside a finished span. It is the trace-side companion to find_log_by_event_name.

**Data flow**: It receives a list of trace events and the event name to search for. It converts each event’s attributes into a map, checks event.name, and returns the first matching event. If none is found, the test fails with a clear message.

**Call relations**: Every test uses this after flushing the in-memory span exporter and reading the events from the finished span. It relies on span_event_attributes to inspect each event, then gives the matching event back for detailed checks.

*Call graph*: called by 6 (otel_export_routing_policy_routes_api_request_auth_observability, otel_export_routing_policy_routes_auth_recovery_log_and_trace_events, otel_export_routing_policy_routes_tool_result_log_and_trace_events, otel_export_routing_policy_routes_user_prompt_log_and_trace_events, otel_export_routing_policy_routes_websocket_connect_auth_observability, otel_export_routing_policy_routes_websocket_request_transport_observability); 1 external calls (iter).


##### `auth_env_metadata`  (lines 83–92)

```
fn auth_env_metadata() -> AuthEnvTelemetryMetadata
```

**Purpose**: This helper creates a fixed set of fake authentication-environment facts for tests. It represents things like whether API key environment variables are present and whether a refresh-token URL override was configured.

**Data flow**: It takes no input. It builds and returns an AuthEnvTelemetryMetadata value with known true, false, and named settings. Nothing outside the returned value is changed.

**Call relations**: The API-request and WebSocket tests attach this metadata to SessionTelemetry before recording events. That lets those tests verify that authentication environment details appear in both logs and traces where expected.


##### `otel_export_routing_policy_routes_user_prompt_log_and_trace_events`  (lines 95–203)

```
fn otel_export_routing_policy_routes_user_prompt_log_and_trace_events()
```

**Purpose**: This test checks how user prompts are split between logs and traces. It verifies that the full prompt and user email are kept in log-only telemetry, while the trace receives only safer summary facts such as length and input counts.

**Data flow**: The test creates in-memory log and trace exporters, wires them into a tracing subscriber with Codex’s log and trace filters, then records a prompt containing text, a remote image, and a local image. After flushing, it reads the captured logs and spans. It expects the log to contain the prompt text and user email, and expects the trace event to contain counts and length but not the prompt, email, or account id.

**Call relations**: This is one of the main privacy-routing checks. It calls the helper functions to find the codex.user_prompt log and trace event and to turn their attributes into maps. It exercises SessionTelemetry.user_prompt through the same OpenTelemetry routing filters used by the production telemetry provider.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 11 external calls (default, default, builder, builder, assert!, assert_eq!, new, with_default, layer, filter_fn (+1 more)).


##### `otel_export_routing_policy_routes_tool_result_log_and_trace_events`  (lines 206–314)

```
fn otel_export_routing_policy_routes_tool_result_log_and_trace_events()
```

**Purpose**: This test checks how tool-call results are split between logs and traces. It makes sure sensitive tool arguments and output go to logs, while traces only receive safer measurements such as argument length, output length, and line count.

**Data flow**: The test sets up in-memory OpenTelemetry exporters and a subscriber, creates a telemetry session, and records a successful shell tool result with secret arguments, secret output, and MCP tags. After flushing, it inspects the log and trace data. The log must include the full arguments, output, and MCP tag values; the trace must include only summary lengths and line count, not the raw arguments, output, or MCP tags.

**Call relations**: This test follows the same pattern as the user-prompt test but focuses on SessionTelemetry.tool_result_with_tags. It uses find_log_by_event_name, find_span_event_by_name_attr, log_attributes, and span_event_attributes to compare the two telemetry sinks.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 11 external calls (default, default, builder, builder, assert!, assert_eq!, new, with_default, layer, filter_fn (+1 more)).


##### `otel_export_routing_policy_routes_auth_recovery_log_and_trace_events`  (lines 317–460)

```
fn otel_export_routing_policy_routes_auth_recovery_log_and_trace_events()
```

**Purpose**: This test checks that authentication recovery events are recorded consistently in both logs and traces. Unlike prompts or tool output, these fields are operational debugging details, so the test expects the same recovery facts in both places.

**Data flow**: The test builds fake log and trace exporters, creates a telemetry session using ChatGPT-style authentication, and records an authentication recovery event with request id, Cloudflare ray id, error name, error code, and state-change status. After flushing, it finds the auth recovery log and trace event. It checks that both contain the expected mode, step, outcome, request identifiers, error details, and state-changed flag.

**Call relations**: This test exercises SessionTelemetry.record_auth_recovery. It uses the shared helper functions to locate and inspect the codex.auth_recovery event in both telemetry outputs, confirming that routing does not strip important authentication troubleshooting fields.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 10 external calls (default, default, builder, builder, assert_eq!, new, with_default, layer, filter_fn, registry).


##### `otel_export_routing_policy_routes_api_request_auth_observability`  (lines 463–644)

```
fn otel_export_routing_policy_routes_api_request_auth_observability()
```

**Purpose**: This test checks that API request telemetry includes the authentication details needed to debug unauthorized requests. It also checks that environment-derived authentication metadata is attached to conversation and request events.

**Data flow**: The test creates in-memory exporters, creates a telemetry session with fixed authentication environment metadata, starts a conversation, and records an API request that returned a 401 unauthorized response. It then reads logs and traces. It verifies that conversation telemetry contains environment facts, and that API request telemetry includes header attachment, header name, retry behavior, recovery mode and phase, endpoint, error details, and selected environment facts.

**Call relations**: This test exercises SessionTelemetry.conversation_starts and SessionTelemetry.record_api_request together because request telemetry can include session-level authentication environment context. It uses auth_env_metadata to supply known values and the shared finder and attribute helpers to inspect codex.conversation_starts and codex.api_request events.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 10 external calls (default, default, builder, builder, assert_eq!, new, with_default, layer, filter_fn, registry).


##### `otel_export_routing_policy_routes_websocket_connect_auth_observability`  (lines 647–761)

```
fn otel_export_routing_policy_routes_websocket_connect_auth_observability()
```

**Purpose**: This test checks that WebSocket connection telemetry includes useful authentication and connection details. A WebSocket is a long-lived network connection, so connection failures need enough information to explain whether authentication headers, retries, or environment settings were involved.

**Data flow**: The test sets up in-memory telemetry, creates a session with fixed authentication environment metadata, and records a WebSocket connect attempt that failed with a 401 response. It flushes and inspects the captured data. The log must include fields such as auth header presence, header name, endpoint, connection reuse status, error, and provider key name; the trace must include recovery phase and refresh-token override status.

**Call relations**: This test exercises SessionTelemetry.record_websocket_connect. It uses auth_env_metadata for predictable environment fields and the shared log and span helpers to verify that codex.websocket_connect is exported with the expected authentication observability data.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 10 external calls (default, default, builder, builder, assert_eq!, new, with_default, layer, filter_fn, registry).


##### `otel_export_routing_policy_routes_websocket_request_transport_observability`  (lines 764–851)

```
fn otel_export_routing_policy_routes_websocket_request_transport_observability()
```

**Purpose**: This test checks telemetry for a WebSocket request after a connection exists. It verifies that transport-level facts, such as whether the connection was reused and what error occurred, are visible in telemetry.

**Data flow**: The test creates in-memory log and trace exporters, builds a telemetry session with fixed authentication environment metadata, and records a WebSocket request that ended with a stream error on a reused connection. After flushing, it finds the WebSocket request log and trace event. It checks that both include connection reuse information, that the log includes the error message, and that environment authentication facts are present where expected.

**Call relations**: This test exercises SessionTelemetry.record_websocket_request. Like the other routing tests, it runs through Codex’s log and trace export filters and uses the shared helper functions to locate and inspect the codex.websocket_request telemetry in both outputs.

*Call graph*: calls 4 internal fn (find_log_by_event_name, find_span_event_by_name_attr, log_attributes, span_event_attributes); 10 external calls (default, default, builder, builder, assert_eq!, new, with_default, layer, filter_fn, registry).


### `otel/tests/suite/otlp_http_loopback.rs`

`test` · `test run`

OpenTelemetry is a standard way for programs to report what they are doing: metrics, logs, and traces. Metrics are numbers like counters and gauges. Logs are event messages. Traces describe a path of work through the system. This file makes sure Codex’s OpenTelemetry HTTP exporter really sends those items in the expected JSON form.

The tests start a local TCP listener on the machine, like setting up a temporary mailbox. Codex is configured to export telemetry to that local address. A background thread accepts incoming HTTP requests, reads the path, headers, and body, replies with a simple success response, and stores what it saw. The test then creates telemetry data, shuts the exporter down so buffered data is flushed, and checks the captured request.

The file also checks trace-context behavior. Trace context is the small piece of information that lets separate parts of a system agree they are working on the same request. One test verifies that unsafe configured trace-state values, such as values containing newlines, are rejected because they would be unsafe inside HTTP headers. Other tests make sure trace export still works inside different Tokio runtimes, which are Rust async task runners.

#### Function details

##### `read_http_request`  (lines 33–134)

```
fn read_http_request(
    stream: &mut TcpStream,
) -> std::io::Result<(String, HashMap<String, String>, Vec<u8>)>
```

**Purpose**: Reads one raw HTTP request from a TCP connection and turns it into useful pieces: the requested path, the headers, and the body bytes. The tests use it so their fake collector can inspect what the exporter sent.

**Data flow**: It receives an open TCP stream. It waits up to a short deadline for data, reads until the HTTP headers are complete, parses the request line to find the path, stores headers in a lowercase lookup map, then reads the body according to the Content-Length header. It returns the path, headers, and body, or an input/output error if the request is missing, malformed, too large, or too slow.

**Call relations**: The loopback server threads inside the exporter tests call this whenever Codex connects to the fake collector. After this function has captured the request details, the server sends a response and later hands the captured data back to the test for assertions.

*Call graph*: 7 external calls (from_secs, new, now, set_read_timeout, new, new, from_utf8).


##### `write_http_response`  (lines 136–140)

```
fn write_http_response(stream: &mut TcpStream, status: &str) -> std::io::Result<()>
```

**Purpose**: Writes a minimal HTTP response back to the exporter. This lets the fake collector tell Codex, “I received your telemetry,” without running a real OpenTelemetry collector.

**Data flow**: It receives an open TCP stream and a status string such as “202 Accepted”. It builds a tiny HTTP response with no body, writes it to the stream, and flushes the stream so the client sees it promptly. It returns success or an input/output error.

**Call relations**: The server threads call this after trying to read each incoming request. It completes the pretend collector exchange so the exporter can finish cleanly instead of waiting for a server reply.

*Call graph*: 3 external calls (flush, write_all, format!).


##### `otlp_http_exporter_sends_metrics_to_collector`  (lines 143–231)

```
fn otlp_http_exporter_sends_metrics_to_collector() -> Result<()>
```

**Purpose**: Checks that the metrics exporter sends metric data to an HTTP OpenTelemetry endpoint. It proves that counters, gauges, labels, and JSON content type all appear in the outgoing request.

**Data flow**: The test starts a local listener, creates a metrics client pointed at that listener, records a counter and a gauge, then shuts the client down to force sending. It receives the captured HTTP requests from the server thread and checks that the request went to `/v1/metrics`, used JSON, and contained the expected metric names and label values.

**Call relations**: This is a top-level test. It relies on `read_http_request` and `write_http_response` through its background fake collector, and it exercises the real `MetricsClient` and OTLP HTTP exporter path.

*Call graph*: calls 2 internal fn (new, otlp); 8 external calls (from_secs, new, from_utf8_lossy, bind, assert!, env!, format!, spawn).


##### `otlp_http_exporter_sends_logs_to_collector`  (lines 234–323)

```
fn otlp_http_exporter_sends_logs_to_collector() -> std::result::Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Checks that log events created through Rust’s tracing system are exported over HTTP as OpenTelemetry log data. This catches problems where logs might be recorded locally but never leave the process.

**Data flow**: The test starts a local listener, configures an OpenTelemetry provider with only log export enabled, attaches its logger layer to a tracing subscriber, and emits one named log event. After shutdown, it inspects the captured request and confirms that `/v1/logs`, a JSON content type, and the expected event name are present.

**Call relations**: This top-level test uses the same fake collector pattern as the metrics test. The tracing subscriber sends the event into the provider, the provider sends it to the loopback server, and the captured request is checked afterward.

*Call graph*: calls 1 internal fn (from); 12 external calls (new, from_secs, new, from, from_utf8_lossy, bind, assert!, env!, format!, spawn (+2 more)).


##### `otel_provider_rejects_header_unsafe_configured_tracestate`  (lines 326–352)

```
fn otel_provider_rejects_header_unsafe_configured_tracestate()
```

**Purpose**: Checks that the OpenTelemetry provider refuses trace-state configuration that would be unsafe in an HTTP header. This protects telemetry propagation from malformed or potentially dangerous header values.

**Data flow**: The test builds provider settings with a configured tracestate value containing a newline. It asks the provider to build itself and expects that to fail. It then checks that the error message points to the unsafe configured tracestate value.

**Call relations**: This test does not use the loopback server because it is testing configuration validation before any network export happens. It directly exercises provider creation and confirms bad trace-context settings are rejected early.

*Call graph*: calls 1 internal fn (from); 6 external calls (from, new, new, from, assert!, env!).


##### `otlp_http_exporter_sends_traces_to_collector`  (lines 355–497)

```
fn otlp_http_exporter_sends_traces_to_collector() -> std::result::Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Checks that spans and trace events are exported over HTTP, and that configured trace-state values are merged safely into propagated trace context. A span is a named stretch of work inside a trace.

**Data flow**: The test locks shared trace-context configuration so similar tests do not interfere with each other, starts a fake collector, and configures trace export to `/v1/traces`. It creates a span, sets its parent from incoming W3C trace context, enters the span, reads back the current propagated context, emits trace events, and shuts down the provider. It then checks both the propagated tracestate string and the captured JSON body for the span name, service name, configured attribute, and event name.

**Call relations**: This is the main end-to-end trace test. It uses the helper HTTP reader and writer through the server thread, calls into Codex’s trace-context helper functions to set and read W3C context, and verifies that the exporter sends the resulting trace to the fake collector.

*Call graph*: calls 1 internal fn (from); 13 external calls (from, from_secs, new, from, from_utf8_lossy, bind, assert!, assert_eq!, env!, format! (+3 more)).


##### `otlp_http_exporter_sends_traces_to_collector_in_tokio_runtime`  (lines 500–600)

```
async fn otlp_http_exporter_sends_traces_to_collector_in_tokio_runtime() -> std::result::Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Checks that trace export works while running inside a multi-threaded Tokio runtime. Tokio is Rust’s common async task runner, so this guards against exporter behavior that only works in plain synchronous tests.

**Data flow**: The async test starts a fake HTTP collector, builds an OpenTelemetry provider with trace export enabled, installs the tracing layer, creates and enters a span, emits a trace message, then shuts the provider down. It reads the captured request and confirms that `/v1/traces`, JSON content, the span name, and the service name were sent.

**Call relations**: This top-level Tokio test follows the same loopback pattern as the synchronous trace test, but runs under a multi-thread async runtime. It demonstrates that the exporter can operate correctly when an async runtime is already active.

*Call graph*: calls 1 internal fn (from); 12 external calls (new, from_secs, new, from, from_utf8_lossy, bind, assert!, env!, format!, spawn (+2 more)).


##### `otlp_http_exporter_sends_traces_to_collector_in_current_thread_tokio_runtime`  (lines 603–722)

```
fn otlp_http_exporter_sends_traces_to_collector_in_current_thread_tokio_runtime() -> std::result::Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Checks that trace export also works inside a single-threaded Tokio runtime. This is important because single-thread runtimes have different blocking and scheduling constraints than multi-thread ones.

**Data flow**: The test starts a fake collector, then starts a separate thread containing a current-thread Tokio runtime. Inside that runtime it creates the OpenTelemetry provider, records a span and trace message, shuts the provider down, and sends the result back through a channel. The outer test waits for completion, collects the HTTP request, and checks that it contains the expected trace endpoint, JSON content type, span name, and service name.

**Call relations**: This top-level test combines the loopback collector with an explicitly built current-thread Tokio runtime. The extra runtime thread and result channel let the test prove the exporter finishes cleanly even in that stricter async environment.

*Call graph*: 5 external calls (from_secs, from_utf8_lossy, bind, assert!, spawn).


### Analytics client and fixtures
These files build up analytics-focused fixtures and verify analytics client behavior from transport decisions to full reducer-driven event generation.

### `analytics/src/client_tests.rs`

`test` · `test run`

This is a test file for the analytics system. The analytics client watches some client requests and server responses, turns the important ones into internal analytics facts, and later sends event payloads either to an HTTP endpoint or, in debug builds, to a local capture file. These tests act like a checklist for that behavior.

The file first defines small sample events, requests, responses, and threads. These are like stage props: realistic enough to exercise the analytics code, but simple and predictable. The tests then check three main areas.

First, they verify destination selection. In debug builds, a caller can ask analytics to write JSON lines to a capture file, which is useful for local inspection. In normal release builds, that capture-file option is ignored and analytics goes to the HTTP endpoint instead.

Second, they verify capture-file writing. A sent event should appear as exactly the serialized JSON request expected, one payload per line. Even if writing fails, the delivery is treated as consumed so the queue does not get stuck retrying a bad local debug path.

Third, they verify filtering and batching. Only analytics-relevant app-server requests and responses are enqueued. Archive messages are ignored. Accepted-line-fingerprint events are split into their own one-event requests, while ordinary events can stay grouped together.

#### Function details

##### `sample_accepted_line_fingerprint_event`  (lines 50–68)

```
fn sample_accepted_line_fingerprint_event(thread_id: &str) -> TrackEventRequest
```

**Purpose**: Builds a sample analytics event for accepted line fingerprints, meaning information about code lines the user accepted. Tests use it to check special batching rules for this event type.

**Data flow**: It takes a thread ID as input, copies it into a fixed test event, fills in predictable fields such as turn ID, model name, and line counts, and returns a `TrackEventRequest` containing that event. It does not change any outside state.

**Call relations**: This helper creates the special event that `track_event_request_batches_only_isolates_accepted_line_fingerprint_events` uses to prove these events are separated from ordinary analytics events. It also supplies one of the event types used by the capture-file batch test.

*Call graph*: 3 external calls (new, new, AcceptedLineFingerprints).


##### `sample_regular_track_event`  (lines 70–86)

```
fn sample_regular_track_event(thread_id: &str) -> TrackEventRequest
```

**Purpose**: Builds a normal sample analytics event for a skill invocation, meaning a user or system action that invoked a named skill. Tests use it as the ordinary event type to compare against the special accepted-line-fingerprint event.

**Data flow**: It takes a thread ID, uses it in the event’s thread field and in a generated skill ID, fills in fixed test values for the rest, and returns a `TrackEventRequest`. No files, queues, or shared state are touched.

**Call relations**: The capture-file tests call this helper when they need a predictable event payload. It is also paired with accepted-line-fingerprint events in batching tests so the code can prove which events stay grouped and which are isolated.

*Call graph*: called by 1 (capture_file_writes_exact_serialized_request); 2 external calls (SkillInvocation, format!).


##### `unique_capture_path`  (lines 89–98)

```
fn unique_capture_path(name: &str) -> PathBuf
```

**Purpose**: Creates a unique temporary file path for debug analytics capture tests. This avoids tests stepping on each other’s files when they run close together or in parallel.

**Data flow**: It takes a short name, reads the current time and the current process ID, combines them with the system temporary directory, and returns a path ending in `.jsonl`. It only creates a path string; the file is created later by the analytics destination code.

**Call relations**: Destination and capture-file tests call this before asking analytics to write locally. It gives each test its own scratch location, which is then passed into destination creation or direct capture-file sending.

*Call graph*: called by 4 (analytics_destination_uses_explicit_capture_file, capture_file_writes_exact_serialized_request, capture_file_writes_final_batches_as_separate_lines, capture_write_failure_still_consumes_delivery); 3 external calls (now, format!, temp_dir).


##### `client_with_receiver`  (lines 100–108)

```
fn client_with_receiver() -> (AnalyticsEventsClient, mpsc::Receiver<AnalyticsFact>)
```

**Purpose**: Creates a test analytics client together with the receiving end of its internal queue. This lets tests see exactly what the client tried to enqueue.

**Data flow**: It creates a small message channel, wraps the sending side in an `AnalyticsEventsQueue`, initializes the duplicate-prevention sets, and returns the client plus the receiver. The caller can then trigger tracking and inspect what arrives on the receiver.

**Call relations**: The request-filtering and response-filtering tests use this setup. They call tracking methods on the returned client, then read from the receiver to confirm whether an `AnalyticsFact` was or was not queued.

*Call graph*: called by 2 (track_request_only_enqueues_analytics_relevant_requests, track_response_only_enqueues_analytics_relevant_responses); 4 external calls (new, new, new, channel).


##### `analytics_destination_uses_explicit_capture_file`  (lines 112–140)

```
fn analytics_destination_uses_explicit_capture_file()
```

**Purpose**: Checks that, in debug builds, an explicit capture file path makes analytics write to that file instead of sending over the network. It also checks that the file is created empty and privately readable/writable on Unix systems.

**Data flow**: It creates a unique path, asks the destination builder to use that capture file, and compares the result with the expected capture-file destination. It then reads the file to confirm it starts empty, checks file permissions on Unix, and deletes the file afterward.

**Call relations**: This test directly exercises `AnalyticsEventsDestination::from_base_url_and_capture_file`. It relies on `unique_capture_path` for a safe scratch file and validates the debug-only local capture path used by later capture-writing tests.

*Call graph*: calls 2 internal fn (from_base_url_and_capture_file, unique_capture_path); 3 external calls (assert_eq!, metadata, remove_file).


##### `analytics_destination_uses_http_without_capture_file`  (lines 143–155)

```
fn analytics_destination_uses_http_without_capture_file()
```

**Purpose**: Checks the normal destination choice when no capture file is requested. Analytics should send to the backend HTTP endpoint built from the base URL.

**Data flow**: It passes a backend base URL and no capture file into the destination builder, then compares the returned destination with the exact expected HTTP URL. It does not touch the filesystem.

**Call relations**: This test covers the everyday path of `AnalyticsEventsDestination::from_base_url_and_capture_file`: no local debug capture, so the destination becomes the analytics-events HTTP endpoint.

*Call graph*: calls 1 internal fn (from_base_url_and_capture_file); 1 external calls (assert_eq!).


##### `analytics_destination_ignores_capture_file_in_release`  (lines 159–171)

```
fn analytics_destination_ignores_capture_file_in_release()
```

**Purpose**: Checks that release builds do not honor the debug capture-file option. This helps prevent production builds from silently writing analytics data to an arbitrary local file.

**Data flow**: It passes both a backend base URL and a capture-file path, then expects the destination to still be the HTTP endpoint. The capture path is only a test value and should not be used.

**Call relations**: This release-only test exercises the same destination builder as the debug destination tests, but proves the build configuration changes the behavior: capture files are for debug builds only.

*Call graph*: calls 1 internal fn (from_base_url_and_capture_file); 2 external calls (assert_eq!, from).


##### `capture_file_writes_exact_serialized_request`  (lines 175–194)

```
async fn capture_file_writes_exact_serialized_request()
```

**Purpose**: Checks that sending one analytics event to a capture file writes exactly the JSON payload expected. This guards against accidental changes in the capture-file format.

**Data flow**: It creates a temporary capture path, builds one regular sample event, serializes that event to the expected JSON value, and sends it through the analytics sending function with dummy authentication. It then reads the file, parses the single line as JSON, compares it with `{ "events": [...] }`, and removes the file.

**Call relations**: This test calls `sample_regular_track_event` and `unique_capture_path`, then hands the event to `send_track_events_request`. Instead of checking the network, it checks the capture-file destination, which is the debug path used for inspecting outgoing analytics.

*Call graph*: calls 3 internal fn (sample_regular_track_event, unique_capture_path, create_dummy_chatgpt_auth_for_testing); 7 external calls (assert_eq!, read_to_string, remove_file, from_str, to_value, send_track_events_request, vec!).


##### `capture_file_writes_final_batches_as_separate_lines`  (lines 198–228)

```
async fn capture_file_writes_final_batches_as_separate_lines()
```

**Purpose**: Checks that each final analytics batch is written as its own line in the capture file. This matters because JSON-lines files store one complete JSON object per line, making captured requests easy to read and replay.

**Data flow**: It creates a capture file, builds three events, splits them into request batches, and sends each batch to the capture destination. It reads all file lines back, parses each line as JSON, and confirms there are three separate payloads in the expected order.

**Call relations**: This test connects batching and sending: `track_event_request_batches` decides how events are split, and `send_track_events_request` writes each split batch. The test confirms the two pieces produce separate captured requests rather than one merged blob.

*Call graph*: calls 2 internal fn (unique_capture_path, create_dummy_chatgpt_auth_for_testing); 6 external calls (assert_eq!, read_to_string, remove_file, send_track_events_request, track_event_request_batches, vec!).


##### `capture_write_failure_still_consumes_delivery`  (lines 232–240)

```
fn capture_write_failure_still_consumes_delivery()
```

**Purpose**: Checks that a failed debug capture-file write is still treated as a completed delivery. This prevents a bad local capture path from clogging the analytics queue forever during tests or debug runs.

**Data flow**: It creates a path under a missing parent directory, builds a payload with one regular event, and asks the capture writer to write it. The expected result is success from the caller’s point of view, even though the file cannot actually be written.

**Call relations**: This test calls the debug capture-writing function directly. It proves that local capture failures are deliberately swallowed so the higher-level delivery loop can keep moving.

*Call graph*: calls 1 internal fn (unique_capture_path); 2 external calls (assert!, vec!).


##### `sample_turn_start_request`  (lines 242–252)

```
fn sample_turn_start_request() -> ClientRequest
```

**Purpose**: Builds a sample client request that starts a turn, meaning the user begins a new interaction in an existing thread. The request-filtering test uses it as an analytics-relevant request.

**Data flow**: It creates a `ClientRequest::TurnStart` with a fixed request ID, thread ID, empty input, and default values for less important fields. The result is a ready-made request object for tests.

**Call relations**: The request-filtering test passes this request into `client.track_request` and expects an analytics fact to be queued. It represents one of the request types the analytics client should notice.

*Call graph*: called by 1 (track_request_only_enqueues_analytics_relevant_requests); 3 external calls (default, new, Integer).


##### `sample_turn_steer_request`  (lines 254–266)

```
fn sample_turn_steer_request() -> ClientRequest
```

**Purpose**: Builds a sample client request that steers an existing turn, meaning it adds guidance or input while a turn is expected to continue. The request-filtering test uses it as another request that should be recorded.

**Data flow**: It creates a `ClientRequest::TurnSteer` with fixed thread and turn IDs, empty input, and no extra metadata. It returns that request object without changing anything else.

**Call relations**: The request-filtering test sends this through `client.track_request` after the turn-start request. Both are expected to become queued analytics facts.

*Call graph*: called by 1 (track_request_only_enqueues_analytics_relevant_requests); 2 external calls (new, Integer).


##### `sample_thread_archive_request`  (lines 268–275)

```
fn sample_thread_archive_request() -> ClientRequest
```

**Purpose**: Builds a sample request to archive a thread. Tests use it as an example of a client request that should not be recorded for analytics.

**Data flow**: It creates a `ClientRequest::ThreadArchive` with a fixed request ID and thread ID, then returns it. There are no side effects.

**Call relations**: The request-filtering test passes this request into `client.track_request` after the relevant request types. The receiver should stay empty, proving archive requests are intentionally ignored.

*Call graph*: called by 1 (track_request_only_enqueues_analytics_relevant_requests); 1 external calls (Integer).


##### `sample_thread`  (lines 277–300)

```
fn sample_thread(thread_id: &str) -> Thread
```

**Purpose**: Builds a realistic but fixed thread object for response tests. It avoids repeating the same large thread setup in each sample response helper.

**Data flow**: It takes a thread ID, uses it to fill the thread ID and session ID, supplies fixed metadata such as status, source, working directory, version, and timestamps, and returns a `Thread`. It does not access external services.

**Call relations**: The thread-start, thread-resume, and thread-fork response helpers call this to embed a thread in their response payloads. Those response payloads are then used to test which server responses analytics records.

*Call graph*: called by 3 (sample_thread_fork_response, sample_thread_resume_response, sample_thread_start_response); 3 external calls (new, test_path_buf, format!).


##### `sample_thread_start_response`  (lines 302–317)

```
fn sample_thread_start_response() -> ClientResponsePayload
```

**Purpose**: Builds a sample server response for starting a thread. The response-filtering test uses it as one of the response types that should produce analytics.

**Data flow**: It creates a sample thread, adds model, provider, working directory, approval, sandbox, and related fixed settings, wraps everything in a `ThreadStart` response payload, and returns it.

**Call relations**: The response-filtering test sends this payload to `client.track_response` and expects a queued `AnalyticsFact::ClientResponse`. It proves thread-start responses are analytics-relevant.

*Call graph*: calls 1 internal fn (sample_thread); called by 1 (track_response_only_enqueues_analytics_relevant_responses); 3 external calls (ThreadStart, new, test_path_buf).


##### `sample_thread_resume_response`  (lines 319–335)

```
fn sample_thread_resume_response() -> ClientResponsePayload
```

**Purpose**: Builds a sample server response for resuming an existing thread. Tests use it to confirm resuming a thread is considered analytics-relevant.

**Data flow**: It creates a sample thread with a different ID, fills in fixed model and runtime settings, leaves the initial turns page absent, wraps the data in a `ThreadResume` response payload, and returns it.

**Call relations**: The response-filtering test passes this payload to `client.track_response`. The expected queued fact shows that resume responses are included in analytics tracking.

*Call graph*: calls 1 internal fn (sample_thread); called by 1 (track_response_only_enqueues_analytics_relevant_responses); 3 external calls (ThreadResume, new, test_path_buf).


##### `sample_thread_fork_response`  (lines 337–352)

```
fn sample_thread_fork_response() -> ClientResponsePayload
```

**Purpose**: Builds a sample server response for forking a thread, meaning creating a new thread from an existing conversation path. Tests use it as another response that should be recorded.

**Data flow**: It creates a sample thread, supplies fixed model and runtime settings, wraps it in a `ThreadFork` response payload, and returns it.

**Call relations**: The response-filtering test sends this payload through `client.track_response` and expects it to be enqueued. Together with start and resume responses, it covers the main thread-creation style responses.

*Call graph*: calls 1 internal fn (sample_thread); called by 1 (track_response_only_enqueues_analytics_relevant_responses); 3 external calls (ThreadFork, new, test_path_buf).


##### `sample_turn_start_response`  (lines 354–367)

```
fn sample_turn_start_response() -> ClientResponsePayload
```

**Purpose**: Builds a sample server response for starting a turn. Tests use it to confirm turn-level server responses are also analytics-relevant.

**Data flow**: It creates a `Turn` with a fixed ID, empty items, full item view, and an in-progress status, then wraps it in a `TurnStart` response payload. It returns that payload.

**Call relations**: The response-filtering test passes this response to `client.track_response`. A queued analytics fact confirms that the analytics client records turn-start responses.

*Call graph*: called by 1 (track_response_only_enqueues_analytics_relevant_responses); 2 external calls (TurnStart, new).


##### `sample_turn_steer_response`  (lines 369–373)

```
fn sample_turn_steer_response() -> ClientResponsePayload
```

**Purpose**: Builds a sample server response for steering a turn. Tests use it as the response counterpart to a turn-steer request.

**Data flow**: It creates a `TurnSteer` response payload containing a fixed new turn ID and returns it. It does not read or write anything outside the function.

**Call relations**: The response-filtering test sends this payload into `client.track_response` and expects analytics output. This proves turn-steer responses are included in the tracked response set.

*Call graph*: called by 1 (track_response_only_enqueues_analytics_relevant_responses); 1 external calls (TurnSteer).


##### `track_request_only_enqueues_analytics_relevant_requests`  (lines 376–397)

```
fn track_request_only_enqueues_analytics_relevant_requests()
```

**Purpose**: Checks that the analytics client queues facts only for client requests that matter to analytics. It should record turn start and turn steer requests, but ignore thread archive requests.

**Data flow**: It creates a test client and receiver, sends sample turn-start and turn-steer requests through `track_request`, and confirms each produces a queued `ClientRequest` analytics fact. It then sends an archive request and confirms the queue remains empty.

**Call relations**: This test uses `client_with_receiver` as its observation point and the three sample request helpers as inputs. It exercises the client’s request-filtering logic directly.

*Call graph*: calls 4 internal fn (client_with_receiver, sample_thread_archive_request, sample_turn_start_request, sample_turn_steer_request); 2 external calls (Integer, assert!).


##### `track_response_only_enqueues_analytics_relevant_responses`  (lines 400–423)

```
fn track_response_only_enqueues_analytics_relevant_responses()
```

**Purpose**: Checks that the analytics client queues facts only for server responses that matter to analytics. It records thread and turn lifecycle responses, but ignores thread archive responses.

**Data flow**: It creates a test client and receiver, feeds in sample thread-start, thread-resume, thread-fork, turn-start, and turn-steer responses, and confirms each queues a `ClientResponse` analytics fact. It then feeds in a thread-archive response and confirms nothing new is queued.

**Call relations**: This test uses the response helper functions to cover each important response kind. By reading from the receiver after each call to `track_response`, it verifies the response-filtering rules.

*Call graph*: calls 6 internal fn (client_with_receiver, sample_thread_fork_response, sample_thread_resume_response, sample_thread_start_response, sample_turn_start_response, sample_turn_steer_response); 3 external calls (ThreadArchive, Integer, assert!).


##### `track_event_request_batches_only_isolates_accepted_line_fingerprint_events`  (lines 426–443)

```
fn track_event_request_batches_only_isolates_accepted_line_fingerprint_events()
```

**Purpose**: Checks the batching rule for analytics events: accepted-line-fingerprint events must travel alone, while ordinary events can be grouped together. This helps keep special event payloads separated from regular analytics traffic.

**Data flow**: It builds a list containing two ordinary events, two accepted-line-fingerprint events, and two more ordinary events. It passes the list to the batch splitter, then checks that the output is four batches: ordinary pair, special single, special single, ordinary pair.

**Call relations**: This test calls `track_event_request_batches`, using the sample event helpers to create the input mix. It confirms the batching function respects each event’s `should_send_in_isolated_request` rule.

*Call graph*: 4 external calls (assert!, assert_eq!, track_event_request_batches, vec!).


### `analytics/src/analytics_client_tests.rs`

`test` · `test`

The analytics reducer listens to many small facts: a client connects, a thread starts, a turn begins, a tool runs, a review finishes, a plugin is used, or an error happens. This test file feeds the reducer carefully chosen examples of those facts and then checks the outgoing analytics events. In everyday terms, it is like a receipt checker: after a complicated shopping trip, it confirms every item was recorded once, in the right category, with the right totals.

The first part of the file builds reusable sample data: fake threads, turns, approval requests, tool items, errors, plugin metadata, and runtime metadata. These helpers keep the tests readable and make each scenario realistic.

The tests then cover the main analytics promises. They verify JSON shapes for events, so dashboards and downstream systems do not break. They check reducer behavior across lifecycles: thread initialization, turn completion, steering requests, tool-item completion, reviews, subagents, compaction, hooks, apps, plugins, and skills. They also test edge cases, such as ignoring unrelated requests, not emitting incomplete turn events, preventing duplicate app/plugin usage events, keeping review counts scoped to the correct thread, and dropping huge line fingerprints while still reporting aggregate accepted-line counts.

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

**Purpose**: Builds a realistic fake thread with common metadata such as IDs, session ID, source, working directory, and parent thread information. Tests use it when they need a thread object without repeating all fields.

**Data flow**: It receives a thread ID, whether the thread is temporary, where the session came from, optional thread source, and optional parent ID. It fills in standard sample values around those inputs and returns a complete Thread value.

**Call relations**: This is the base helper for thread-start and thread-resume samples. Those helpers call it so tests can focus on the behavior being checked instead of thread construction details.

*Call graph*: called by 2 (sample_thread_resume_response_with_source, sample_thread_start_response); 3 external calls (new, test_path_buf, format!).


##### `sample_thread_start_response`  (lines 195–220)

```
fn sample_thread_start_response(
    thread_id: &str,
    ephemeral: bool,
    model: &str,
) -> ClientResponsePayload
```

**Purpose**: Creates a fake successful response for starting a new thread. Tests use it to make the reducer believe the app server has opened a thread.

**Data flow**: It takes a thread ID, temporary-thread flag, and model name. It builds a thread with sample metadata, wraps it in a thread-start response, and returns it as a client response payload.

**Call relations**: Many reducer tests call this after an initialize fact. It hands the reducer the thread metadata needed before later turn, review, compaction, or subagent assertions can make sense.

*Call graph*: calls 1 internal fn (sample_thread_with_metadata); called by 6 (guardian_review_event_ingests_custom_fact_with_optional_target_item, ingest_review_prerequisites, ingest_turn_prerequisites, initialize_caches_client_and_thread_lifecycle_publishes_once_initialized, item_review_summaries_do_not_cross_threads_with_reused_item_ids, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit); 3 external calls (ThreadStart, new, test_path_buf).


##### `sample_app_server_client_metadata`  (lines 222–230)

```
fn sample_app_server_client_metadata() -> CodexAppServerClientMetadata
```

**Purpose**: Returns a standard sample description of the client that is talking to the app server. Tests use it when checking serialized analytics events.

**Data flow**: It reads no input. It returns fixed metadata such as product client ID, client name, client version, transport, and experimental API flag.

**Call relations**: Serialization tests for compaction and turn events call this so their expected JSON includes consistent client information.

*Call graph*: called by 2 (compaction_event_serializes_expected_shape, turn_event_serializes_expected_shape).


##### `sample_runtime_metadata`  (lines 232–239)

```
fn sample_runtime_metadata() -> CodexRuntimeMetadata
```

**Purpose**: Returns a standard sample description of the runtime environment. This lets tests check that analytics events include operating system and Codex version details.

**Data flow**: It takes no input. It produces fixed runtime values such as Codex version, OS, OS version, and CPU architecture.

**Call relations**: Initialization helpers and event-shape tests call it whenever reducer output needs runtime metadata.

*Call graph*: called by 7 (compaction_event_ingests_custom_fact, compaction_event_serializes_expected_shape, guardian_review_event_ingests_custom_fact_with_optional_target_item, ingest_initialize, ingest_rejected_turn_steer, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit, turn_event_serializes_expected_shape).


##### `sample_thread_resume_response`  (lines 241–254)

```
fn sample_thread_resume_response(
    thread_id: &str,
    ephemeral: bool,
    model: &str,
) -> ClientResponsePayload
```

**Purpose**: Creates a simple fake response for resuming an existing thread. Tests use it when they do not need special source or parent-thread details.

**Data flow**: It receives a thread ID, temporary-thread flag, and model name. It passes those plus default source information into the more detailed resume helper and returns the resulting client response payload.

**Call relations**: This is a convenience wrapper used by initialization and rejected-steering tests. It delegates the actual construction to sample_thread_resume_response_with_source.

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

**Purpose**: Creates a fake thread-resume response with explicit session source, thread source, and parent thread information. Tests use it for subagent and lineage scenarios.

**Data flow**: It takes thread identity, temporary flag, model, source details, and optional parent ID. It builds a full ThreadResume payload containing both standard defaults and those specific lineage fields.

**Call relations**: The simple resume helper calls this with defaults. Subagent and compaction tests call it directly when they need the reducer to remember where a resumed thread came from.

*Call graph*: calls 1 internal fn (sample_thread_with_metadata); called by 2 (compaction_event_ingests_custom_fact, sample_thread_resume_response); 3 external calls (ThreadResume, new, test_path_buf).


##### `sample_turn_start_request`  (lines 287–306)

```
fn sample_turn_start_request(thread_id: &str, request_id: i64) -> ClientRequest
```

**Purpose**: Builds a fake client request to start a turn. The request includes both text and an image so tests can verify input-image counting.

**Data flow**: It receives a thread ID and request ID. It creates a TurnStart request for that thread with sample user inputs and returns it as a ClientRequest.

**Call relations**: Turn lifecycle helpers and error-handling tests feed this request into the reducer before sending a matching response or error.

*Call graph*: called by 3 (ingest_turn_prerequisites, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit, turn_start_error_response_discards_pending_start_request); 3 external calls (default, Integer, vec!).


##### `sample_turn_start_response`  (lines 308–321)

```
fn sample_turn_start_response(turn_id: &str) -> ClientResponsePayload
```

**Purpose**: Builds a fake successful response for starting a turn. Tests use it to connect a client request to a concrete turn ID.

**Data flow**: It receives a turn ID. It creates an in-progress Turn object with that ID and returns it in a TurnStart response payload.

**Call relations**: Turn setup helpers and unrelated-request tests use it to verify that the reducer only creates turn state when the response matches a relevant pending request.

*Call graph*: called by 4 (ingest_turn_prerequisites, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit, turn_start_error_response_discards_pending_start_request, unrelated_client_requests_are_ignored_by_reducer); 2 external calls (TurnStart, vec!).


##### `sample_turn_started_notification`  (lines 323–337)

```
fn sample_turn_started_notification(thread_id: &str, turn_id: &str) -> ServerNotification
```

**Purpose**: Creates a fake server notification saying a turn has started. Tests use it to give the reducer a start timestamp.

**Data flow**: It receives a thread ID and turn ID. It returns a notification containing an in-progress turn with a fixed started-at timestamp.

**Call relations**: Turn and tool-item tests send this before completion so emitted analytics can include start time and duration-related context.

*Call graph*: called by 4 (ingest_completed_command_execution_item, ingest_turn_prerequisites, item_lifecycle_notifications_publish_command_execution_event, subagent_tool_items_inherit_parent_connection_metadata); 2 external calls (TurnStarted, vec!).


##### `sample_turn_token_usage_fact`  (lines 339–351)

```
fn sample_turn_token_usage_fact(thread_id: &str, turn_id: &str) -> TurnTokenUsageFact
```

**Purpose**: Creates sample token usage for a turn. Tokens are the chunks of text the model reads or writes, and analytics uses them for cost and performance reporting.

**Data flow**: It receives thread and turn IDs. It returns a custom fact with fixed input, cached input, output, reasoning, and total token counts.

**Call relations**: Turn prerequisite setup and subagent tests feed this into the reducer so final turn events can include usage numbers.

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

**Purpose**: Builds a fake server notification saying a turn has finished. Tests use it to trigger final turn analytics.

**Data flow**: It receives a thread ID, turn ID, final status, and optional error details. It returns a TurnCompleted notification with fixed completion time and duration, and includes an error object when requested.

**Call relations**: Many lifecycle tests use this as the final step. Once it is ingested, the reducer may emit turn events, accepted-line summaries, or nothing if prerequisites are missing.

*Call graph*: called by 12 (accepted_steers_increment_turn_steer_count, ingest_complete_child_turn, item_completed_without_turn_state_does_not_create_turn_state, reducer_emits_accepted_line_fingerprints_once_from_latest_turn_diff_on_completion, reducer_emits_large_accepted_line_aggregates_without_fingerprints, turn_completed_without_started_notification_emits_null_started_at, turn_does_not_emit_without_required_prerequisites, turn_event_counts_completed_tool_items, turn_lifecycle_emits_failed_turn_event, turn_lifecycle_emits_interrupted_turn_event_without_error (+2 more)); 2 external calls (TurnCompleted, vec!).


##### `sample_turn_resolved_config`  (lines 378–401)

```
fn sample_turn_resolved_config(thread_id: &str, turn_id: &str) -> TurnResolvedConfigFact
```

**Purpose**: Creates sample resolved configuration for a turn, such as model, permissions, sandbox, approval policy, and collaboration mode. This is required for full turn analytics.

**Data flow**: It receives thread and turn IDs. It returns a TurnResolvedConfigFact filled with realistic defaults and those IDs.

**Call relations**: Turn setup helpers and error-discard tests send this custom fact before completion so the reducer has the configuration fields needed for a turn event.

*Call graph*: called by 3 (ingest_complete_child_turn, ingest_turn_prerequisites, turn_start_error_response_discards_pending_start_request); 2 external calls (read_only, from).


##### `sample_turn_profile`  (lines 403–413)

```
fn sample_turn_profile() -> TurnProfile
```

**Purpose**: Creates sample timing breakdowns for a turn. These timings show where time was spent, such as model sampling or tool blocking.

**Data flow**: It takes no input. It returns fixed timing values and request/retry counts.

**Call relations**: Turn setup helpers and child-turn helpers attach this profile to the reducer before completion, allowing emitted turn events to include performance fields.

*Call graph*: called by 2 (ingest_complete_child_turn, ingest_turn_prerequisites).


##### `sample_turn_steer_request`  (lines 415–440)

```
fn sample_turn_steer_request(
    thread_id: &str,
    expected_turn_id: &str,
    request_id: i64,
) -> ClientRequest
```

**Purpose**: Builds a fake request to steer an already-running turn, meaning the user adds more input while a turn is active. It includes text and a local image.

**Data flow**: It receives a thread ID, expected active turn ID, and request ID. It returns a TurnSteer client request with sample inputs.

**Call relations**: Steering tests feed this into the reducer before either an accepted response or a rejection error, so the reducer can produce a steer analytics event.

*Call graph*: called by 3 (accepted_steers_increment_turn_steer_count, accepted_turn_steer_emits_expected_event, ingest_rejected_turn_steer); 2 external calls (Integer, vec!).


##### `sample_turn_steer_response`  (lines 442–446)

```
fn sample_turn_steer_response(turn_id: &str) -> ClientResponsePayload
```

**Purpose**: Builds a fake successful response to a turn-steering request. It tells the reducer which turn accepted the added input.

**Data flow**: It receives the accepted turn ID and wraps it in a TurnSteer response payload.

**Call relations**: Accepted-steering tests pair this with sample_turn_steer_request to check that accepted events are emitted and steer counts increase.

*Call graph*: called by 2 (accepted_steers_increment_turn_steer_count, accepted_turn_steer_emits_expected_event); 1 external calls (TurnSteer).


##### `no_active_turn_steer_error`  (lines 448–454)

```
fn no_active_turn_steer_error() -> JSONRPCErrorError
```

**Purpose**: Creates a sample JSON-RPC error for trying to steer when no turn is active. JSON-RPC is the request-response message format used here.

**Data flow**: It takes no input and returns an error with a fixed code and message.

**Call relations**: Rejected-steering and pending-request cleanup tests use it to verify that the reducer records or ignores the error in the right circumstances.

*Call graph*: called by 4 (accepted_steers_increment_turn_steer_count, rejected_turn_steer_uses_request_connection_metadata, turn_start_error_response_discards_pending_start_request, turn_steer_does_not_emit_without_pending_request).


##### `no_active_turn_steer_error_type`  (lines 456–458)

```
fn no_active_turn_steer_error_type() -> AnalyticsJsonRpcError
```

**Purpose**: Returns the analytics-friendly category for the no-active-turn steering error. This category is what appears in tracking output.

**Data flow**: It takes no input and returns an AnalyticsJsonRpcError value representing a TurnSteer NoActiveTurn failure.

**Call relations**: Steering tests pass it alongside the raw error so the reducer can map the rejection reason to no_active_turn.

*Call graph*: called by 3 (accepted_steers_increment_turn_steer_count, rejected_turn_steer_uses_request_connection_metadata, turn_steer_does_not_emit_without_pending_request); 1 external calls (TurnSteer).


##### `non_steerable_review_error`  (lines 460–475)

```
fn non_steerable_review_error() -> JSONRPCErrorError
```

**Purpose**: Creates a sample error for trying to steer a review turn, which is not allowed. It includes structured error data, not just text.

**Data flow**: It takes no input. It serializes a turn error explaining that the active turn is a review and returns it as JSON-RPC error data.

**Call relations**: The non-steerable rejection test uses this raw error together with its analytics error type to check the final rejection reason.

*Call graph*: called by 1 (rejected_turn_steer_maps_active_turn_not_steerable_error_type); 1 external calls (to_value).


##### `non_steerable_review_error_type`  (lines 477–479)

```
fn non_steerable_review_error_type() -> AnalyticsJsonRpcError
```

**Purpose**: Returns the analytics-friendly category for the non-steerable review-turn error.

**Data flow**: It takes no input and returns an AnalyticsJsonRpcError value for TurnSteer NonSteerableReview.

**Call relations**: The matching rejected-steering test passes it to the shared ingest helper so the reducer emits non_steerable_review.

*Call graph*: called by 1 (rejected_turn_steer_maps_active_turn_not_steerable_error_type); 1 external calls (TurnSteer).


##### `input_too_large_steer_error`  (lines 481–491)

```
fn input_too_large_steer_error() -> JSONRPCErrorError
```

**Purpose**: Creates a sample error for a steering request whose input is too large. This checks that input validation failures become clear analytics reasons.

**Data flow**: It takes no input. It returns a JSON-RPC error containing an input_too_large code and size details.

**Call relations**: The input-too-large steering test uses this with input_too_large_error_type to verify the reducer's rejection mapping.

*Call graph*: called by 1 (rejected_turn_steer_maps_input_too_large_error_type); 1 external calls (json!).


##### `input_too_large_error_type`  (lines 493–495)

```
fn input_too_large_error_type() -> AnalyticsJsonRpcError
```

**Purpose**: Returns the analytics-friendly category for an input-too-large error.

**Data flow**: It takes no input and returns an AnalyticsJsonRpcError value for Input TooLarge.

**Call relations**: The rejected-steering test passes it to the shared helper so the emitted event has rejection_reason input_too_large.

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

**Purpose**: Sets up a realistic reducer state, sends a turn-steering request, then sends a rejection error. It returns the emitted analytics event as JSON for easy assertions.

**Data flow**: It receives a reducer, output event list, raw error, and optional categorized error. It ingests setup facts, a request from one connection, an error response, checks that exactly one event appeared, and returns that event serialized as JSON.

**Call relations**: Several rejected-steering tests call this shared flow. Internally it uses turn setup, initialize metadata, resume metadata, and sample steering requests to exercise the same path as real app-server traffic.

*Call graph*: calls 5 internal fn (ingest_turn_prerequisites, sample_runtime_metadata, sample_thread_resume_response, sample_turn_steer_request, ingest); called by 3 (rejected_turn_steer_maps_active_turn_not_steerable_error_type, rejected_turn_steer_maps_input_too_large_error_type, rejected_turn_steer_uses_request_connection_metadata); 4 external calls (new, Integer, assert_eq!, to_value).


##### `ingest_initialize`  (lines 568–588)

```
async fn ingest_initialize(reducer: &mut AnalyticsReducer, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Sends a standard initialize fact into the reducer. Initialization tells analytics which client and runtime are connected.

**Data flow**: It receives a reducer and output list. It builds a fixed Initialize fact and ingests it, possibly updating reducer state but not normally producing an event.

**Call relations**: Turn setup and unrelated-response tests call this before later facts, because many analytics events need client and runtime metadata.

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

**Purpose**: Performs the common setup needed before testing turn completion. It can include initialization, resolved configuration, start notification, token usage, and profile timing.

**Data flow**: It receives a reducer, output list, and four booleans controlling which setup facts to send. It ingests the chosen facts and leaves the reducer ready for turn-completion tests.

**Call relations**: Most turn lifecycle, steering, and accepted-line tests call this helper. It hides repetitive setup while letting each test choose which prerequisites are present or missing.

*Call graph*: calls 9 internal fn (ingest_initialize, sample_thread_start_response, sample_turn_profile, sample_turn_resolved_config, sample_turn_start_request, sample_turn_start_response, sample_turn_started_notification, sample_turn_token_usage_fact, ingest); called by 11 (accepted_steers_increment_turn_steer_count, accepted_turn_steer_emits_expected_event, ingest_rejected_turn_steer, reducer_emits_accepted_line_fingerprints_once_from_latest_turn_diff_on_completion, reducer_emits_large_accepted_line_aggregates_without_fingerprints, turn_completed_without_started_notification_emits_null_started_at, turn_does_not_emit_without_required_prerequisites, turn_event_counts_completed_tool_items, turn_lifecycle_emits_failed_turn_event, turn_lifecycle_emits_interrupted_turn_event_without_error (+1 more)); 7 external calls (new, Custom, Notification, TurnProfile, TurnResolvedConfig, TurnTokenUsage, Integer).


##### `ingest_review_prerequisites`  (lines 682–702)

```
async fn ingest_review_prerequisites(
    reducer: &mut AnalyticsReducer,
    events: &mut Vec<TrackEventRequest>,
)
```

**Purpose**: Sets up the reducer for tests about reviews and tool items. It initializes the client and starts a thread, then clears emitted setup events.

**Data flow**: It receives a reducer and event list. It ingests a standard initialize fact and a thread-start response, then empties the event list so later assertions only see the event under test.

**Call relations**: Review, approval, guardian, and tool-item tests call this before sending approval requests or item notifications.

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

**Purpose**: Sends a full command-tool lifecycle into the reducer: turn started, command item started, command item completed. Tests use it to trigger command execution analytics.

**Data flow**: It receives a reducer, event list, thread ID, and item ID. It ingests notifications for a command item moving from in-progress to completed and leaves any emitted events in the list.

**Call relations**: Review-summary tests call this after creating review state, so they can check whether review counts are attached to the final tool-item event.

*Call graph*: calls 3 internal fn (sample_command_execution_item_with_id, sample_turn_started_notification, ingest); called by 3 (item_review_summaries_do_not_cross_threads_with_reused_item_ids, permissions_reviews_emit_events_without_denormalizing_onto_tool_items, terminal_reviews_denormalize_counts_onto_tool_item_events); 4 external calls (new, ItemCompleted, ItemStarted, Notification).


##### `sample_initialize_fact`  (lines 756–780)

```
fn sample_initialize_fact(connection_id: u64) -> AnalyticsFact
```

**Purpose**: Builds a reusable initialize fact with fixed client, capability, runtime, and transport metadata.

**Data flow**: It receives a connection ID. It returns an AnalyticsFact::Initialize tied to that connection.

**Call relations**: Review setup and subagent inheritance tests use it to seed the reducer with known connection metadata.

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

**Purpose**: Completes a child or subagent turn with the minimum facts needed for a turn event. It is useful when testing inherited metadata.

**Data flow**: It receives a reducer, event list, thread ID, and turn ID. It ingests resolved config, profile timing, and a completed-turn notification.

**Call relations**: The subagent metadata test calls this after creating a subagent thread to check whether turn events inherit or override connection data correctly.

*Call graph*: calls 4 internal fn (sample_turn_completed_notification, sample_turn_profile, sample_turn_resolved_config, ingest); called by 1 (subagent_events_use_inherited_connection_unless_turn_connection_is_explicit); 5 external calls (new, Custom, Notification, TurnProfile, TurnResolvedConfig).


##### `sample_command_execution_item`  (lines 809–815)

```
fn sample_command_execution_item(
    status: CommandExecutionStatus,
    exit_code: Option<i32>,
    duration_ms: Option<i64>,
) -> ThreadItem
```

**Purpose**: Creates a standard fake shell command item. Tests use it when they do not need a custom item ID.

**Data flow**: It receives command status, optional exit code, and optional duration. It delegates to the ID-specific helper using item-1 and returns a ThreadItem.

**Call relations**: Tool-item tests and action-count tests call this helper, while sample_command_execution_item_with_actions builds on it for command-action scenarios.

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

**Purpose**: Creates a fake shell command item with a caller-chosen ID. This allows tests to check thread and item scoping.

**Data flow**: It receives an item ID, status, optional exit code, and optional duration. It returns a CommandExecution thread item with sample command text, working directory, process ID, and source.

**Call relations**: The completed-command lifecycle helper uses it to produce matching started and completed items, and the simpler command helper delegates to it.

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

**Purpose**: Creates a fake command item and attaches a chosen list of command actions, such as read, list files, search, or unknown. Tests use it to verify action counting.

**Data flow**: It receives status, exit code, duration, and action list. It first builds a normal command item, replaces its command_actions field, and returns the modified item.

**Call relations**: The command execution lifecycle test uses it at item completion so analytics can count action categories in the emitted event.

*Call graph*: calls 1 internal fn (sample_command_execution_item); called by 1 (item_lifecycle_notifications_publish_command_execution_event); 1 external calls (unreachable!).


##### `sample_command_approval_request`  (lines 855–875)

```
fn sample_command_approval_request(request_id: i64, approval_id: Option<&str>) -> ServerRequest
```

**Purpose**: Creates a fake server request asking the user to approve a command execution. This models the app asking permission before running a shell command.

**Data flow**: It receives a request ID and optional approval ID. It returns a ServerRequest tied to thread-1, turn-1, and item-1 with sample command information.

**Call relations**: User-review and aborted-request tests ingest this before a response or abort, so the reducer can remember an approval review is pending.

*Call graph*: called by 4 (aborted_server_request_publishes_aborted_user_review_event_once, command_execution_approval_response_publishes_user_review_event, item_review_summaries_do_not_cross_threads_with_reused_item_ids, terminal_reviews_denormalize_counts_onto_tool_item_events); 1 external calls (Integer).


##### `sample_command_approval_response`  (lines 877–885)

```
fn sample_command_approval_response(
    request_id: i64,
    decision: CommandExecutionApprovalDecision,
) -> ServerResponse
```

**Purpose**: Creates a fake user response to a command approval request. Tests use it to finish a pending review.

**Data flow**: It receives a request ID and decision. It returns a ServerResponse carrying that decision.

**Call relations**: Approval-response tests pair it with sample_command_approval_request to check that user review events and final approval summaries are produced.

*Call graph*: called by 4 (aborted_server_request_publishes_aborted_user_review_event_once, command_execution_approval_response_publishes_user_review_event, item_review_summaries_do_not_cross_threads_with_reused_item_ids, terminal_reviews_denormalize_counts_onto_tool_item_events); 1 external calls (Integer).


##### `sample_permissions_approval_request`  (lines 887–906)

```
fn sample_permissions_approval_request(request_id: i64) -> ServerRequest
```

**Purpose**: Creates a fake server request asking for broader permissions, such as network access. This tests permission-review analytics separate from command reviews.

**Data flow**: It receives a request ID. It returns a PermissionsRequestApproval server request with sample thread, turn, item, reason, working directory, and requested network permission.

**Call relations**: Permission review tests ingest this before an effective permissions response to verify approved, denied, and session-scoped outcomes.

*Call graph*: called by 2 (effective_session_permissions_response_publishes_session_user_review_event, permissions_reviews_emit_events_without_denormalizing_onto_tool_items); 2 external calls (Integer, test_path_buf).


##### `sample_effective_permissions_approval_response`  (lines 908–917)

```
fn sample_effective_permissions_approval_response(
    permissions: CoreRequestPermissionProfile,
    scope: CorePermissionGrantScope,
) -> CoreRequestPermissionsResponse
```

**Purpose**: Builds the core response that says what permissions were actually granted and for what scope. Scope means whether permission applies just to this turn or the whole session.

**Data flow**: It receives a permission profile and grant scope. It returns a CoreRequestPermissionsResponse using those values with strict auto-review disabled.

**Call relations**: Permission tests use it after a permissions approval request so the reducer can turn the decision into a review event.

*Call graph*: called by 2 (effective_session_permissions_response_publishes_session_user_review_event, permissions_reviews_emit_events_without_denormalizing_onto_tool_items).


##### `sample_guardian_review_completed`  (lines 919–946)

```
fn sample_guardian_review_completed(
    review_id: &str,
    target_item_id: Option<&str>,
    status: GuardianApprovalReviewStatus,
) -> ServerNotification
```

**Purpose**: Creates a fake notification that the guardian reviewer finished reviewing an action. The guardian is an automated reviewer for risky actions.

**Data flow**: It receives a review ID, optional target item ID, and guardian status. It returns a notification with sample command action details, start and completion times, and review result.

**Call relations**: The guardian-completed test ingests this after review prerequisites to check that guardian review events include thread metadata and timing.

*Call graph*: called by 1 (guardian_completed_notification_publishes_review_event_with_thread_metadata); 2 external calls (ItemGuardianApprovalReviewCompleted, test_path_buf).


##### `expected_absolute_path`  (lines 948–953)

```
fn expected_absolute_path(path: &PathBuf) -> String
```

**Purpose**: Computes the expected normalized absolute path string for path-related tests. It makes assertions work even if the test path can or cannot be canonicalized by the operating system.

**Data flow**: It receives a path. It tries to canonicalize it, falls back to the original path if that fails, converts it to text, and normalizes backslashes to forward slashes.

**Call relations**: Skill path normalization tests call this when the expected answer should be an absolute path rather than a repository-relative path.

*Call graph*: called by 3 (normalize_path_for_skill_id_admin_scoped_uses_absolute_path, normalize_path_for_skill_id_repo_root_not_in_skill_path_uses_absolute_path, normalize_path_for_skill_id_user_scoped_uses_absolute_path); 1 external calls (canonicalize).


##### `normalize_path_for_skill_id_repo_scoped_uses_relative_path`  (lines 956–967)

```
fn normalize_path_for_skill_id_repo_scoped_uses_relative_path()
```

**Purpose**: Checks that a skill inside a repository is identified by its path relative to that repository. This keeps repo-scoped skill IDs stable across machines.

**Data flow**: It builds a repo root and skill path under that root, calls the normalization function, and asserts the result is the relative .codex path.

**Call relations**: This is a direct test of normalize_path_for_skill_id. It verifies the repository case used later by skill ID generation.

*Call graph*: calls 1 internal fn (normalize_path_for_skill_id); 2 external calls (from, assert_eq!).


##### `normalize_path_for_skill_id_user_scoped_uses_absolute_path`  (lines 970–981)

```
fn normalize_path_for_skill_id_user_scoped_uses_absolute_path()
```

**Purpose**: Checks that a user-scoped skill uses an absolute path when there is no repository context. This avoids pretending a personal skill belongs to a repo.

**Data flow**: It builds a user skill path, calls the normalization function without repo information, computes the expected absolute path, and compares them.

**Call relations**: It uses expected_absolute_path as the expected-value helper and exercises normalize_path_for_skill_id directly.

*Call graph*: calls 2 internal fn (expected_absolute_path, normalize_path_for_skill_id); 2 external calls (from, assert_eq!).


##### `normalize_path_for_skill_id_admin_scoped_uses_absolute_path`  (lines 984–995)

```
fn normalize_path_for_skill_id_admin_scoped_uses_absolute_path()
```

**Purpose**: Checks that an admin or system skill uses an absolute path. This gives system-wide skills a distinct and stable identity.

**Data flow**: It builds an /etc skill path, normalizes it without repo information, and compares the result to the expected absolute path.

**Call relations**: Like the user-scoped test, it combines expected_absolute_path with normalize_path_for_skill_id.

*Call graph*: calls 2 internal fn (expected_absolute_path, normalize_path_for_skill_id); 2 external calls (from, assert_eq!).


##### `normalize_path_for_skill_id_repo_root_not_in_skill_path_uses_absolute_path`  (lines 998–1010)

```
fn normalize_path_for_skill_id_repo_root_not_in_skill_path_uses_absolute_path()
```

**Purpose**: Checks the fallback behavior when repo information exists but the skill path is not actually inside that repo. In that case, relative path would be misleading.

**Data flow**: It builds a repo root and a skill path elsewhere, calls normalization, and asserts the result is the absolute path.

**Call relations**: This protects normalize_path_for_skill_id from producing incorrect repo-relative IDs for unrelated paths.

*Call graph*: calls 2 internal fn (expected_absolute_path, normalize_path_for_skill_id); 2 external calls (from, assert_eq!).


##### `app_mentioned_event_serializes_expected_shape`  (lines 1013–1048)

```
fn app_mentioned_event_serializes_expected_shape()
```

**Purpose**: Checks the exact JSON for an app-mentioned analytics event. App-mentioned means Codex referenced or invoked an app connector.

**Data flow**: It builds tracking context and an app invocation, creates the event, serializes it to JSON, and compares it to the expected object.

**Call relations**: This test exercises codex_app_metadata through the AppMentioned event wrapper and protects downstream consumers from schema changes.

*Call graph*: calls 1 internal fn (codex_app_metadata); 3 external calls (AppMentioned, assert_eq!, to_value).


##### `app_used_event_serializes_expected_shape`  (lines 1051–1086)

```
fn app_used_event_serializes_expected_shape()
```

**Purpose**: Checks the exact JSON for an app-used analytics event. This confirms connector, app name, invocation type, and tracking fields are placed correctly.

**Data flow**: It builds tracking context and a sample app invocation, wraps it as AppUsed, serializes it, and compares against expected JSON.

**Call relations**: It uses codex_app_metadata in the app-used path, complementing the app-mentioned serialization test.

*Call graph*: calls 1 internal fn (codex_app_metadata); 3 external calls (AppUsed, assert_eq!, to_value).


##### `accepted_line_fingerprints_event_serializes_expected_shape`  (lines 1089–1128)

```
fn accepted_line_fingerprints_event_serializes_expected_shape()
```

**Purpose**: Checks the JSON shape for accepted-line fingerprint analytics. These events summarize code lines accepted from a model-generated diff.

**Data flow**: It builds an event with thread, turn, model, repo hash, accepted line counts, and an empty fingerprint list. It serializes the event and compares it to expected JSON.

**Call relations**: This schema test supports reducer tests that later emit accepted-line events from turn diffs.

*Call graph*: 5 external calls (new, new, AcceptedLineFingerprints, assert_eq!, to_value).


##### `reducer_emits_large_accepted_line_aggregates_without_fingerprints`  (lines 1131–1199)

```
async fn reducer_emits_large_accepted_line_aggregates_without_fingerprints()
```

**Purpose**: Verifies that very large diffs still report accepted line counts but omit detailed fingerprints. This prevents analytics payloads from becoming too large.

**Data flow**: It sets up a full turn, feeds a huge diff with 20,000 added lines, completes the turn, then checks one accepted-line event with counts and no fingerprints.

**Call relations**: It uses turn prerequisites and a completed-turn notification to exercise the reducer’s accepted-line emission path at completion time.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 8 external calls (new, TurnDiffUpdated, new, Notification, default, assert!, assert_eq!, format!).


##### `reducer_emits_accepted_line_fingerprints_once_from_latest_turn_diff_on_completion`  (lines 1202–1266)

```
async fn reducer_emits_accepted_line_fingerprints_once_from_latest_turn_diff_on_completion()
```

**Purpose**: Checks that the reducer uses the latest diff and emits accepted-line analytics only once when the turn completes.

**Data flow**: It sends two diff updates for the same turn, then completes the turn. It verifies that one event is emitted and its aggregate count reflects the latest diff.

**Call relations**: This test depends on the normal turn setup helper and confirms that diff updates are stored until completion rather than emitted immediately.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 8 external calls (new, TurnDiffUpdated, new, Notification, default, assert!, assert_eq!, format!).


##### `compaction_event_serializes_expected_shape`  (lines 1269–1347)

```
fn compaction_event_serializes_expected_shape()
```

**Purpose**: Checks the exact JSON for a compaction event. Compaction means shrinking conversation context so a long session can continue within model limits.

**Data flow**: It builds a compaction event with client, runtime, thread, token, timing, and status data, serializes it, and compares it with expected JSON.

**Call relations**: It exercises codex_compaction_event_params using sample client and runtime metadata, separate from reducer ingestion tests.

*Call graph*: calls 3 internal fn (sample_app_server_client_metadata, sample_runtime_metadata, codex_compaction_event_params); 4 external calls (new, Compaction, assert_eq!, to_value).


##### `compaction_implementation_serializes_remote_v2`  (lines 1350–1355)

```
fn compaction_implementation_serializes_remote_v2()
```

**Purpose**: Checks the string used for the ResponsesCompactionV2 compaction implementation. This protects the public analytics value.

**Data flow**: It serializes the enum value and asserts the JSON string is responses_compaction_v2.

**Call relations**: This focused serialization test supports compaction event schema stability.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `app_used_dedupe_is_keyed_by_turn_and_connector`  (lines 1358–1385)

```
fn app_used_dedupe_is_keyed_by_turn_and_connector()
```

**Purpose**: Checks that app-used events are only queued once per turn and connector. This prevents duplicate analytics when the same app is detected repeatedly.

**Data flow**: It builds an analytics queue with empty dedupe sets, one app, and two turn contexts. It checks that the first use in a turn is allowed, the repeat is blocked, and the same app in another turn is allowed.

**Call relations**: This directly tests AnalyticsEventsQueue’s app-used deduplication behavior without involving the reducer.

*Call graph*: 5 external calls (new, new, new, assert_eq!, channel).


##### `thread_initialized_event_serializes_expected_shape`  (lines 1388–1451)

```
fn thread_initialized_event_serializes_expected_shape()
```

**Purpose**: Checks the JSON shape for a thread-initialized event. This event records that a conversation thread exists and captures its startup context.

**Data flow**: It builds a ThreadInitialized event with client, runtime, model, source, mode, and timestamps, serializes it, and compares it to expected JSON.

**Call relations**: This schema test supports reducer tests that emit thread initialization from thread-start or resume responses.

*Call graph*: 4 external calls (ThreadInitialized, Feature, assert_eq!, to_value).


##### `command_execution_event_serializes_expected_shape`  (lines 1454–1550)

```
fn command_execution_event_serializes_expected_shape()
```

**Purpose**: Checks the JSON shape for a command execution analytics event. This event describes a completed shell command tool item.

**Data flow**: It builds a command event with base tool fields, review counts, approval outcome, status, source, exit code, and command action counts. It serializes and compares the result.

**Call relations**: This verifies the event type independently from reducer tests that create command execution events from item notifications.

*Call graph*: 3 external calls (CommandExecution, assert_eq!, to_value).


##### `review_event_serializes_expected_shape`  (lines 1553–1627)

```
fn review_event_serializes_expected_shape()
```

**Purpose**: Checks the JSON shape for a review event, including reviewer, subject, trigger, result, timing, and subagent lineage.

**Data flow**: It constructs a CodexReviewEventRequest, serializes it, and asserts every expected field and string value appears correctly.

**Call relations**: This schema test supports later reducer tests for user reviews, guardian reviews, and permissions reviews.

*Call graph*: 3 external calls (ReviewEvent, assert_eq!, to_value).


##### `initialize_caches_client_and_thread_lifecycle_publishes_once_initialized`  (lines 1629–1729)

```
async fn initialize_caches_client_and_thread_lifecycle_publishes_once_initialized()
```

**Purpose**: Verifies that the reducer waits for client initialization before publishing thread lifecycle analytics. Without that wait, events would miss client and runtime metadata.

**Data flow**: It first sends a thread response before initialization and expects no event. Then it initializes the connection, resumes another thread, and checks that exactly one initialized-thread event includes cached client and runtime fields.

**Call relations**: This test uses sample thread start and resume responses to exercise reducer state: initialization is cached, and later thread lifecycle events can use it.

*Call graph*: calls 2 internal fn (sample_thread_resume_response, sample_thread_start_response); 7 external calls (new, new, default, Integer, assert!, assert_eq!, to_value).


##### `unrelated_client_requests_are_ignored_by_reducer`  (lines 1732–1766)

```
async fn unrelated_client_requests_are_ignored_by_reducer()
```

**Purpose**: Checks that requests unrelated to turn starts do not create pending turn state. This prevents accidental analytics from mismatched responses.

**Data flow**: It sends a thread-archive request, then a turn-start-looking response with the same request ID, and confirms no events are emitted.

**Call relations**: The test pairs an unrelated request with sample_turn_start_response to make sure the reducer does not match responses too broadly.

*Call graph*: calls 1 internal fn (sample_turn_start_response); 5 external calls (new, new, default, Integer, assert!).


##### `unrelated_client_responses_are_ignored_by_reducer`  (lines 1769–1788)

```
async fn unrelated_client_responses_are_ignored_by_reducer()
```

**Purpose**: Checks that unrelated client responses do not emit analytics by themselves. The reducer should only react to response types it understands for analytics.

**Data flow**: It initializes the reducer, sends a thread-archive response, and asserts the output list remains empty.

**Call relations**: It uses ingest_initialize for realistic client metadata, then verifies the reducer ignores the archive response.

*Call graph*: calls 1 internal fn (ingest_initialize); 6 external calls (new, ThreadArchive, new, default, Integer, assert!).


##### `compaction_event_ingests_custom_fact`  (lines 1791–1919)

```
async fn compaction_event_ingests_custom_fact()
```

**Purpose**: Checks that a custom compaction fact becomes a compaction analytics event with thread, client, runtime, and subagent lineage attached.

**Data flow**: It initializes a connection, resumes a subagent thread, clears setup events, ingests a compaction fact, then asserts the emitted JSON fields.

**Call relations**: This test combines resume-with-source setup and a CustomAnalyticsFact::Compaction to exercise the reducer’s custom compaction path.

*Call graph*: calls 3 internal fn (sample_runtime_metadata, sample_thread_resume_response_with_source, from_string); 9 external calls (SubAgent, new, new, Custom, Compaction, default, Integer, assert_eq!, to_value).


##### `guardian_review_event_ingests_custom_fact_with_optional_target_item`  (lines 1922–2081)

```
async fn guardian_review_event_ingests_custom_fact_with_optional_target_item()
```

**Purpose**: Checks that a custom guardian review fact emits a guardian-review analytics event, even when there is no target item ID.

**Data flow**: It initializes, starts a thread, clears setup events, sends a GuardianReview custom fact, and checks session, client, runtime, reviewed action, status, timeout, and optional fields.

**Call relations**: This test uses sample runtime and thread-start response setup, then exercises the reducer’s custom guardian-review path.

*Call graph*: calls 2 internal fn (sample_runtime_metadata, sample_thread_start_response); 9 external calls (new, new, Custom, GuardianReview, default, Integer, assert!, assert_eq!, to_value).


##### `item_lifecycle_notifications_publish_command_execution_event`  (lines 2084–2197)

```
async fn item_lifecycle_notifications_publish_command_execution_event()
```

**Purpose**: Verifies that a command execution event is emitted when a command item completes, not when it starts. It also checks action counts and timing.

**Data flow**: It sets up review prerequisites, sends a turn-started notification, sends item-started, verifies no event yet, sends item-completed with command actions, and checks the emitted event.

**Call relations**: This test uses command item helpers and turn-start notification to exercise the reducer’s tool-item lifecycle tracking.

*Call graph*: calls 4 internal fn (ingest_review_prerequisites, sample_command_execution_item, sample_command_execution_item_with_actions, sample_turn_started_notification); 10 external calls (new, ItemCompleted, ItemStarted, new, Notification, default, assert!, assert_eq!, to_value, vec!).


##### `command_execution_approval_response_publishes_user_review_event`  (lines 2200–2253)

```
async fn command_execution_approval_response_publishes_user_review_event()
```

**Purpose**: Checks that a user’s command approval response becomes a review event. This records human approval decisions in analytics.

**Data flow**: It sets up a thread, sends a command approval request, confirms no immediate event, sends an accept response, and verifies the emitted review fields.

**Call relations**: It pairs sample_command_approval_request with sample_command_approval_response to test the reducer’s pending-review matching.

*Call graph*: calls 3 internal fn (ingest_review_prerequisites, sample_command_approval_request, sample_command_approval_response); 6 external calls (new, new, default, assert!, assert_eq!, to_value).


##### `permissions_reviews_emit_events_without_denormalizing_onto_tool_items`  (lines 2256–2304)

```
async fn permissions_reviews_emit_events_without_denormalizing_onto_tool_items()
```

**Purpose**: Checks that permission reviews emit review events but do not get counted on unrelated tool-item summaries. Denormalizing means copying review counts onto tool events.

**Data flow**: It sends a permissions request and denied effective response, verifies a permissions review event, then completes a command item with the same item ID and checks review counts remain zero.

**Call relations**: This test combines permission review helpers with the completed-command helper to protect separation between permission reviews and command tool-item reviews.

*Call graph*: calls 4 internal fn (ingest_completed_command_execution_item, ingest_review_prerequisites, sample_effective_permissions_approval_response, sample_permissions_approval_request); 8 external calls (new, default, new, default, Integer, assert!, assert_eq!, to_value).


##### `effective_session_permissions_response_publishes_session_user_review_event`  (lines 2307–2349)

```
async fn effective_session_permissions_response_publishes_session_user_review_event()
```

**Purpose**: Checks that granting permissions for the whole session produces an approved review event with session approval resolution.

**Data flow**: It sets up a thread, sends a permissions request, sends an effective response granting network permission for the session, and checks the emitted review status and resolution.

**Call relations**: It uses the permissions request and effective permissions response helpers to exercise the reducer’s permission decision mapping.

*Call graph*: calls 3 internal fn (ingest_review_prerequisites, sample_effective_permissions_approval_response, sample_permissions_approval_request); 6 external calls (new, new, default, Integer, assert_eq!, to_value).


##### `aborted_server_request_publishes_aborted_user_review_event_once`  (lines 2352–2398)

```
async fn aborted_server_request_publishes_aborted_user_review_event_once()
```

**Purpose**: Verifies that an aborted approval request produces exactly one aborted review event and cannot later be completed again.

**Data flow**: It creates a pending command approval, sends an abort, checks the aborted review event, clears events, then sends a late accept response and expects no new event.

**Call relations**: This test uses command approval helpers to ensure the reducer removes pending review state after abort.

*Call graph*: calls 3 internal fn (ingest_review_prerequisites, sample_command_approval_request, sample_command_approval_response); 7 external calls (new, new, default, Integer, assert!, assert_eq!, to_value).


##### `guardian_completed_notification_publishes_review_event_with_thread_metadata`  (lines 2401–2428)

```
async fn guardian_completed_notification_publishes_review_event_with_thread_metadata()
```

**Purpose**: Checks that a guardian review completion notification emits a review event with the thread’s cached metadata.

**Data flow**: It sets up a thread, ingests a sample guardian completion notification, serializes the first event, and checks review ID, item ID, subject, reviewer, status, and timing.

**Call relations**: It uses ingest_review_prerequisites and sample_guardian_review_completed to exercise notification-driven guardian review analytics.

*Call graph*: calls 2 internal fn (ingest_review_prerequisites, sample_guardian_review_completed); 6 external calls (new, new, Notification, default, assert_eq!, to_value).


##### `terminal_reviews_denormalize_counts_onto_tool_item_events`  (lines 2431–2471)

```
async fn terminal_reviews_denormalize_counts_onto_tool_item_events()
```

**Purpose**: Checks that completed terminal reviews are summarized on the related tool-item event. This lets command events include review counts and final approval outcome.

**Data flow**: It creates and completes a user approval review, clears review events, completes the matching command item, and checks review counts and final approval outcome on the command event.

**Call relations**: It combines approval request/response helpers with the completed-command helper to verify review summaries are attached at item completion.

*Call graph*: calls 4 internal fn (ingest_completed_command_execution_item, ingest_review_prerequisites, sample_command_approval_request, sample_command_approval_response); 5 external calls (new, new, default, assert_eq!, to_value).


##### `item_review_summaries_do_not_cross_threads_with_reused_item_ids`  (lines 2474–2527)

```
async fn item_review_summaries_do_not_cross_threads_with_reused_item_ids()
```

**Purpose**: Checks that review summaries are scoped by thread as well as item ID. Reusing item IDs in different threads must not mix analytics.

**Data flow**: It creates two threads, records a review for item-1 in thread-1, then completes item-1 in thread-2 and checks review counts are zero.

**Call relations**: This test uses thread-start, approval, and completed-command helpers to prove reducer matching includes thread identity.

*Call graph*: calls 5 internal fn (ingest_completed_command_execution_item, ingest_review_prerequisites, sample_command_approval_request, sample_command_approval_response, sample_thread_start_response); 6 external calls (new, new, default, Integer, assert_eq!, to_value).


##### `subagent_thread_started_review_serializes_expected_shape`  (lines 2530–2573)

```
fn subagent_thread_started_review_serializes_expected_shape()
```

**Purpose**: Checks serialization for a subagent thread started for review work. A subagent is a child agent thread created for a specific task.

**Data flow**: It builds a SubAgentThreadStartedInput with Review source, wraps it as a thread-initialized event, serializes it, and checks client, source, created time, and lineage fields.

**Call relations**: This directly exercises subagent_thread_started_event_request for the review subagent case.

*Call graph*: calls 1 internal fn (subagent_thread_started_event_request); 3 external calls (ThreadInitialized, assert_eq!, to_value).


##### `subagent_thread_started_thread_spawn_serializes_thread_lineage`  (lines 2576–2618)

```
fn subagent_thread_started_thread_spawn_serializes_thread_lineage()
```

**Purpose**: Checks that a thread-spawn subagent event includes parent and forked-from thread IDs. This preserves conversation lineage.

**Data flow**: It creates valid parent and fork IDs, builds a subagent-start input with ThreadSpawn source, serializes the event, and asserts lineage fields.

**Call relations**: This tests subagent_thread_started_event_request for the thread-spawn source variant.

*Call graph*: calls 2 internal fn (subagent_thread_started_event_request, from_string); 3 external calls (ThreadInitialized, assert_eq!, to_value).


##### `subagent_thread_started_memory_consolidation_serializes_expected_shape`  (lines 2621–2645)

```
fn subagent_thread_started_memory_consolidation_serializes_expected_shape()
```

**Purpose**: Checks serialization for a subagent started for memory consolidation. Memory consolidation is background summarizing or cleanup of stored context.

**Data flow**: It builds a memory-consolidation subagent input, serializes the thread-initialized event, and verifies the subagent source and missing parent field.

**Call relations**: It exercises subagent_thread_started_event_request for the MemoryConsolidation source.

*Call graph*: calls 1 internal fn (subagent_thread_started_event_request); 3 external calls (ThreadInitialized, assert_eq!, to_value).


##### `subagent_thread_started_other_serializes_expected_shape`  (lines 2648–2668)

```
fn subagent_thread_started_other_serializes_expected_shape()
```

**Purpose**: Checks that a custom subagent source string is serialized correctly. This covers future or less common subagent kinds.

**Data flow**: It builds a subagent input with Other("guardian"), serializes it, and checks the source string and null parent.

**Call relations**: It exercises subagent_thread_started_event_request for the Other source variant.

*Call graph*: calls 1 internal fn (subagent_thread_started_event_request); 4 external calls (ThreadInitialized, assert_eq!, Other, to_value).


##### `subagent_thread_started_other_serializes_explicit_parent_thread_id`  (lines 2671–2697)

```
fn subagent_thread_started_other_serializes_explicit_parent_thread_id()
```

**Purpose**: Checks that a custom subagent source can still include an explicit parent thread ID. This keeps lineage available even for non-standard subagents.

**Data flow**: It builds a valid parent thread ID, creates an Other("guardian") subagent input with that parent, serializes it, and checks both fields.

**Call relations**: It complements the previous Other-source test by covering explicit parent lineage.

*Call graph*: calls 2 internal fn (subagent_thread_started_event_request, from_string); 4 external calls (ThreadInitialized, assert_eq!, Other, to_value).


##### `subagent_thread_started_publishes_without_initialize`  (lines 2700–2734)

```
async fn subagent_thread_started_publishes_without_initialize()
```

**Purpose**: Verifies that a custom subagent-thread-start fact can emit a thread-initialized event even without a prior initialize fact. Subagents may be created internally, not through a normal client connection.

**Data flow**: It ingests a SubAgentThreadStarted custom fact into a fresh reducer and checks one emitted thread-initialized event with client and subagent fields.

**Call relations**: This exercises the reducer’s custom subagent thread path, independent of normal connection initialization.

*Call graph*: 6 external calls (new, Custom, SubAgentThreadStarted, default, assert_eq!, to_value).


##### `subagent_events_use_inherited_connection_unless_turn_connection_is_explicit`  (lines 2737–2908)

```
async fn subagent_events_use_inherited_connection_unless_turn_connection_is_explicit()
```

**Purpose**: Checks how subagent events choose client metadata. They should inherit from the parent thread unless a later turn explicitly uses another connection.

**Data flow**: It initializes a parent connection, starts a parent thread, starts a subagent thread, checks a compaction and completed turn inherit parent metadata, then starts a turn through another connection and checks that explicit metadata wins.

**Call relations**: This large integration-style test uses many helpers to exercise reducer metadata inheritance across subagent thread, compaction, turn completion, token usage, and explicit turn start paths.

*Call graph*: calls 8 internal fn (ingest_complete_child_turn, sample_initialize_fact, sample_runtime_metadata, sample_thread_start_response, sample_turn_start_request, sample_turn_start_response, sample_turn_token_usage_fact, from_string); 11 external calls (new, new, Custom, Compaction, SubAgentThreadStarted, TurnTokenUsage, default, Integer, assert_eq!, panic! (+1 more)).


##### `subagent_tool_items_inherit_parent_connection_metadata`  (lines 2911–2992)

```
async fn subagent_tool_items_inherit_parent_connection_metadata()
```

**Purpose**: Checks that tool-item events inside a subagent thread inherit parent client metadata and include subagent lineage.

**Data flow**: It sets up a parent thread, starts a subagent thread, sends turn and command item notifications for the subagent, then checks the command event’s source, parent ID, and client name.

**Call relations**: It combines review prerequisites, a SubAgentThreadStarted fact, turn-start notification, and command item helpers to test tool-item metadata inheritance.

*Call graph*: calls 3 internal fn (ingest_review_prerequisites, sample_command_execution_item, sample_turn_started_notification); 10 external calls (new, ItemCompleted, ItemStarted, new, Custom, Notification, SubAgentThreadStarted, default, assert_eq!, to_value).


##### `plugin_used_event_serializes_expected_shape`  (lines 2995–3027)

```
fn plugin_used_event_serializes_expected_shape()
```

**Purpose**: Checks the JSON shape for a plugin-used event. Plugins can add skills, MCP servers, and app connectors, and analytics records which plugin was used during a turn.

**Data flow**: It builds tracking context and sample plugin metadata, creates a PluginUsed event, serializes it, and compares all expected plugin and turn fields.

**Call relations**: It exercises codex_plugin_used_metadata with sample_plugin_metadata.

*Call graph*: calls 2 internal fn (sample_plugin_metadata, codex_plugin_used_metadata); 3 external calls (PluginUsed, assert_eq!, to_value).


##### `plugin_management_event_serializes_expected_shape`  (lines 3030–3053)

```
fn plugin_management_event_serializes_expected_shape()
```

**Purpose**: Checks the JSON shape for a plugin management event, such as plugin installed. This records plugin metadata outside a specific turn.

**Data flow**: It builds a PluginInstalled event from sample plugin metadata, serializes it, and compares plugin ID, name, marketplace, skill flag, server count, connector IDs, and product client ID.

**Call relations**: It exercises codex_plugin_metadata for the normal local plugin ID path.

*Call graph*: calls 2 internal fn (sample_plugin_metadata, codex_plugin_metadata); 3 external calls (PluginInstalled, assert_eq!, to_value).


##### `plugin_management_event_can_use_remote_plugin_id_override`  (lines 3056–3072)

```
fn plugin_management_event_can_use_remote_plugin_id_override()
```

**Purpose**: Checks that plugin analytics can use a remote plugin ID when one is provided. This lets server-side plugin identity override the local config ID.

**Data flow**: It builds sample plugin metadata, sets a remote_plugin_id, serializes a plugin-installed event, and verifies the overridden ID while other metadata remains unchanged.

**Call relations**: It reuses sample_plugin_metadata and codex_plugin_metadata to test the override branch.

*Call graph*: calls 2 internal fn (sample_plugin_metadata, codex_plugin_metadata); 3 external calls (PluginInstalled, assert_eq!, to_value).


##### `hook_run_event_serializes_expected_shape`  (lines 3075–3109)

```
fn hook_run_event_serializes_expected_shape()
```

**Purpose**: Checks the JSON for a hook-run event. A hook is user, project, system, or cloud-provided code that runs at certain Codex lifecycle points.

**Data flow**: It builds tracking context and a completed pre-tool-use hook fact, creates the event, serializes it, and compares expected fields.

**Call relations**: It exercises codex_hook_run_metadata through the HookRun event wrapper.

*Call graph*: calls 1 internal fn (codex_hook_run_metadata); 3 external calls (HookRun, assert_eq!, to_value).


##### `hook_run_metadata_maps_sources_and_statuses`  (lines 3112–3164)

```
fn hook_run_metadata_maps_sources_and_statuses()
```

**Purpose**: Checks that hook source and status enum values become the expected analytics strings. This protects dashboards from inconsistent labels.

**Data flow**: It serializes hook metadata for system, project, cloud requirements, and unknown sources with different statuses, then compares the source and status strings.

**Call relations**: This directly tests codex_hook_run_metadata mapping behavior across several source/status combinations.

*Call graph*: calls 1 internal fn (codex_hook_run_metadata); 2 external calls (assert_eq!, to_value).


##### `hook_run_metadata_maps_stopped_status`  (lines 3167–3186)

```
fn hook_run_metadata_maps_stopped_status()
```

**Purpose**: Checks that a stopped hook run serializes with status stopped. This covers a terminal state separate from completed, blocked, or failed.

**Data flow**: It builds tracking context and a stopped user hook fact, serializes hook metadata, and checks source and status strings.

**Call relations**: It is a focused companion to the broader hook source/status mapping test.

*Call graph*: calls 1 internal fn (codex_hook_run_metadata); 2 external calls (assert_eq!, to_value).


##### `plugin_used_dedupe_is_keyed_by_turn_and_plugin`  (lines 3189–3212)

```
fn plugin_used_dedupe_is_keyed_by_turn_and_plugin()
```

**Purpose**: Checks that plugin-used events are only queued once per turn and plugin. This avoids duplicate tracking when the same plugin contributes multiple times in one turn.

**Data flow**: It builds an analytics queue with empty dedupe sets, sample plugin metadata, and two turn contexts. It verifies first use is allowed, repeated use in the same turn is blocked, and use in a different turn is allowed.

**Call relations**: This directly tests AnalyticsEventsQueue’s plugin-used deduplication behavior.

*Call graph*: calls 1 internal fn (sample_plugin_metadata); 5 external calls (new, new, new, assert_eq!, channel).


##### `reducer_ingests_skill_invoked_fact`  (lines 3215–3266)

```
async fn reducer_ingests_skill_invoked_fact()
```

**Purpose**: Checks that a custom skill-invoked fact becomes a skill invocation analytics event with a stable skill ID.

**Data flow**: It builds tracking context, a user skill path, computes the expected local skill ID, ingests a SkillInvoked fact, and compares the emitted JSON.

**Call relations**: It exercises both skill_id_for_local_skill and the reducer’s custom SkillInvoked handling.

*Call graph*: calls 1 internal fn (skill_id_for_local_skill); 8 external calls (from, new, Custom, SkillInvoked, default, assert_eq!, to_value, vec!).


##### `reducer_includes_plugin_id_for_plugin_skill_invocations`  (lines 3269–3301)

```
async fn reducer_includes_plugin_id_for_plugin_skill_invocations()
```

**Purpose**: Checks that skill invocations coming from plugins include the plugin ID. This links skill usage back to the plugin that provided it.

**Data flow**: It builds a plugin skill invocation with plugin_id, ingests it, serializes output, and asserts the plugin_id appears in event_params.

**Call relations**: This is a narrower companion to reducer_ingests_skill_invoked_fact, focused on plugin-provided skills.

*Call graph*: 8 external calls (from, new, Custom, SkillInvoked, default, assert_eq!, to_value, vec!).


##### `reducer_ingests_hook_run_fact`  (lines 3304–3332)

```
async fn reducer_ingests_hook_run_fact()
```

**Purpose**: Checks that a custom hook-run fact becomes a hook-run analytics event.

**Data flow**: It ingests a HookRun custom fact with tracking context, hook name, source, and failed status, then asserts one emitted event with matching fields.

**Call relations**: It exercises the reducer path that turns CustomAnalyticsFact::HookRun into a TrackEventRequest::HookRun.

*Call graph*: 6 external calls (new, Custom, HookRun, default, assert_eq!, to_value).


##### `reducer_ingests_app_and_plugin_facts`  (lines 3335–3385)

```
async fn reducer_ingests_app_and_plugin_facts()
```

**Purpose**: Checks that custom app-mentioned, app-used, and plugin-used facts each produce the right analytics event type.

**Data flow**: It builds shared tracking context, ingests three custom facts in sequence, serializes outputs, and checks that three expected event types appear in order.

**Call relations**: This test covers the reducer’s simple pass-through conversions for app and plugin usage facts using sample plugin metadata.

*Call graph*: calls 1 internal fn (sample_plugin_metadata); 9 external calls (new, Custom, AppMentioned, AppUsed, PluginUsed, default, assert_eq!, to_value, vec!).


##### `reducer_ingests_plugin_state_changed_fact`  (lines 3388–3420)

```
async fn reducer_ingests_plugin_state_changed_fact()
```

**Purpose**: Checks that a plugin state change, such as disabled, produces the corresponding plugin management event.

**Data flow**: It ingests a PluginStateChanged custom fact with sample plugin metadata and Disabled state, then compares the emitted JSON to the expected codex_plugin_disabled event.

**Call relations**: It exercises the reducer path for plugin state changes and relies on sample_plugin_metadata for consistent plugin details.

*Call graph*: calls 1 internal fn (sample_plugin_metadata); 6 external calls (new, Custom, PluginStateChanged, default, assert_eq!, to_value).


##### `turn_event_serializes_expected_shape`  (lines 3423–3558)

```
fn turn_event_serializes_expected_shape()
```

**Purpose**: Checks the full JSON shape for a turn event. Turn events are the main record of one model interaction, including configuration, status, timing, tool counts, and token usage.

**Data flow**: It builds a CodexTurnEventRequest with many fields populated, serializes it, parses expected JSON, and asserts exact equality.

**Call relations**: This schema test supports reducer lifecycle tests that later emit turn events from many smaller facts.

*Call graph*: calls 2 internal fn (sample_app_server_client_metadata, sample_runtime_metadata); 4 external calls (new, TurnEvent, assert_eq!, to_value).


##### `accepted_turn_steer_emits_expected_event`  (lines 3561–3628)

```
async fn accepted_turn_steer_emits_expected_event()
```

**Purpose**: Checks that an accepted turn-steering request emits a turn-steer analytics event with request metadata and accepted turn ID.

**Data flow**: It sets up a turn, sends a steering request and successful response, then asserts one event with thread, session, input-image count, result, timestamps, client, runtime, and lineage fields.

**Call relations**: It uses ingest_turn_prerequisites plus steering request/response helpers to exercise the accepted-steering reducer path.

*Call graph*: calls 3 internal fn (ingest_turn_prerequisites, sample_turn_steer_request, sample_turn_steer_response); 7 external calls (new, new, default, Integer, assert!, assert_eq!, to_value).


##### `rejected_turn_steer_uses_request_connection_metadata`  (lines 3631–3669)

```
async fn rejected_turn_steer_uses_request_connection_metadata()
```

**Purpose**: Checks that a rejected steering event uses metadata from the request connection. This matters when multiple clients or connections are active.

**Data flow**: It calls the shared rejected-steering helper with a no-active-turn error, then checks rejected status, reason, thread fields, client metadata, runtime, and timestamp.

**Call relations**: It relies on ingest_rejected_turn_steer to build the multi-connection setup and focuses on the resulting event fields.

*Call graph*: calls 3 internal fn (ingest_rejected_turn_steer, no_active_turn_steer_error, no_active_turn_steer_error_type); 4 external calls (new, default, assert!, assert_eq!).


##### `rejected_turn_steer_maps_active_turn_not_steerable_error_type`  (lines 3672–3687)

```
async fn rejected_turn_steer_maps_active_turn_not_steerable_error_type()
```

**Purpose**: Checks that a non-steerable review-turn error becomes the rejection reason non_steerable_review.

**Data flow**: It runs the shared rejected-steering flow with the non-steerable raw error and categorized error, then asserts the rejection_reason field.

**Call relations**: It uses non_steerable_review_error and non_steerable_review_error_type to exercise one branch of rejection mapping.

*Call graph*: calls 3 internal fn (ingest_rejected_turn_steer, non_steerable_review_error, non_steerable_review_error_type); 3 external calls (new, default, assert_eq!).


##### `rejected_turn_steer_maps_input_too_large_error_type`  (lines 3690–3705)

```
async fn rejected_turn_steer_maps_input_too_large_error_type()
```

**Purpose**: Checks that an input-too-large steering error becomes the rejection reason input_too_large.

**Data flow**: It runs the shared rejected-steering flow with the input-too-large raw error and categorized error, then asserts the rejection_reason field.

**Call relations**: It uses input_too_large_steer_error and input_too_large_error_type to exercise the input validation branch of rejection mapping.

*Call graph*: calls 3 internal fn (ingest_rejected_turn_steer, input_too_large_error_type, input_too_large_steer_error); 3 external calls (new, default, assert_eq!).


##### `turn_steer_does_not_emit_without_pending_request`  (lines 3708–3725)

```
async fn turn_steer_does_not_emit_without_pending_request()
```

**Purpose**: Checks that a steering error response alone does not emit an event. The reducer must first have seen the matching request.

**Data flow**: It sends an ErrorResponse for a request ID into a fresh reducer and asserts no events are produced.

**Call relations**: This protects the reducer’s pending-request matching logic for turn-steer analytics.

*Call graph*: calls 2 internal fn (no_active_turn_steer_error, no_active_turn_steer_error_type); 4 external calls (new, default, Integer, assert!).


##### `turn_start_error_response_discards_pending_start_request`  (lines 3728–3790)

```
async fn turn_start_error_response_discards_pending_start_request()
```

**Purpose**: Checks that a failed turn-start request is removed from pending state. A later synthetic response must not resurrect it.

**Data flow**: It initializes, sends a turn-start request, sends an error, then sends a late turn-start response and later completion facts. It asserts no events are emitted.

**Call relations**: This uses turn-start, error, resolved-config, and completion helpers to verify failed starts cannot create later turn analytics.

*Call graph*: calls 6 internal fn (ingest_initialize, no_active_turn_steer_error, sample_turn_completed_notification, sample_turn_resolved_config, sample_turn_start_request, sample_turn_start_response); 8 external calls (new, new, Custom, Notification, TurnResolvedConfig, default, Integer, assert!).


##### `turn_lifecycle_emits_turn_event`  (lines 3793–3874)

```
async fn turn_lifecycle_emits_turn_event()
```

**Purpose**: Checks the normal successful turn lifecycle. When all required facts arrive, the reducer should emit one complete turn event.

**Data flow**: It sets up initialization, turn start, resolved config, started notification, token usage, and profile. Then it sends completion and checks the emitted event’s metadata, counts, timing, status, and token fields.

**Call relations**: This is the main happy-path reducer test for turn analytics, built on ingest_turn_prerequisites and sample_turn_completed_notification.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 7 external calls (new, new, Notification, default, assert!, assert_eq!, to_value).


##### `turn_event_counts_completed_tool_items`  (lines 3877–4017)

```
async fn turn_event_counts_completed_tool_items()
```

**Purpose**: Checks that a final turn event counts completed tool items by type, including shell commands, file changes, MCP tools, dynamic tools, subagent tools, web search, and image generation.

**Data flow**: It sets up a turn, sends one started MCP item and several completed tool items, confirms MCP event plugin metadata, completes the turn, and checks the final counts.

**Call relations**: It exercises the reducer’s item-completion accounting and final turn-summary emission.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 9 external calls (new, ItemCompleted, ItemStarted, new, Notification, default, assert_eq!, to_value, vec!).


##### `item_completed_without_turn_state_does_not_create_turn_state`  (lines 4020–4055)

```
async fn item_completed_without_turn_state_does_not_create_turn_state()
```

**Purpose**: Checks that an item completion by itself does not create turn state. This prevents stray notifications from causing bogus turn events.

**Data flow**: It ingests a completed command item in a fresh reducer, then a turn-completed notification for the same turn, and asserts no events are emitted.

**Call relations**: It uses command item and turn completion helpers to prove the reducer requires a real turn setup before summarizing.

*Call graph*: calls 2 internal fn (sample_command_execution_item, sample_turn_completed_notification); 6 external calls (new, ItemCompleted, new, Notification, default, assert!).


##### `accepted_steers_increment_turn_steer_count`  (lines 4058–4160)

```
async fn accepted_steers_increment_turn_steer_count()
```

**Purpose**: Checks that accepted steering requests increase the final turn’s steer count, while rejected ones do not.

**Data flow**: It sets up a turn, sends one accepted steer, one rejected steer, another accepted steer, then completes the turn and asserts the turn event has steer_count 2.

**Call relations**: It combines steering helpers, no-active-turn error helpers, and final turn completion to verify reducer counting.

*Call graph*: calls 6 internal fn (ingest_turn_prerequisites, no_active_turn_steer_error, no_active_turn_steer_error_type, sample_turn_completed_notification, sample_turn_steer_request, sample_turn_steer_response); 7 external calls (new, new, Notification, default, Integer, assert_eq!, to_value).


##### `turn_does_not_emit_without_required_prerequisites`  (lines 4163–4213)

```
async fn turn_does_not_emit_without_required_prerequisites()
```

**Purpose**: Checks that turn completion does not emit analytics when essential setup is missing. This avoids incomplete or misleading events.

**Data flow**: It runs two scenarios: one without initialization and one without resolved config. In both, it completes the turn and asserts no output.

**Call relations**: It uses ingest_turn_prerequisites with different flags to test the reducer’s required-field gates.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 5 external calls (new, new, Notification, default, assert!).


##### `turn_lifecycle_emits_failed_turn_event`  (lines 4216–4265)

```
async fn turn_lifecycle_emits_failed_turn_event()
```

**Purpose**: Checks that a failed turn emits a turn event with both app-server error information and Codex error classification.

**Data flow**: It sets up a turn, ingests a custom Codex error fact, completes the turn with failed status and bad-request info, then checks status, turn_error, and codex_error_kind fields.

**Call relations**: It combines normal turn prerequisites, TurnCodexError custom fact, and failed completion to test error enrichment.

*Call graph*: calls 3 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification, from_codex_err); 9 external calls (new, new, Custom, Notification, TurnCodexError, default, assert_eq!, InvalidRequest, to_value).


##### `turn_lifecycle_emits_interrupted_turn_event_without_error`  (lines 4268–4298)

```
async fn turn_lifecycle_emits_interrupted_turn_event_without_error()
```

**Purpose**: Checks that an interrupted turn emits an interrupted status without inventing an error. Interruption is not always a failure.

**Data flow**: It sets up a turn, completes it with Interrupted status and no error info, then asserts status is interrupted and error fields are null.

**Call relations**: This is a focused variant of the turn lifecycle tests using the normal setup helper and completion notification.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 6 external calls (new, new, Notification, default, assert_eq!, to_value).


##### `turn_completed_without_started_notification_emits_null_started_at`  (lines 4301–4337)

```
async fn turn_completed_without_started_notification_emits_null_started_at()
```

**Purpose**: Checks that a completed turn can still emit when the started notification was missing, but started_at and token fields remain null if not provided.

**Data flow**: It sets up initialization and resolved config without start notification or token usage, completes the turn, and checks null started_at and token fields while preserving duration.

**Call relations**: This tests the reducer’s graceful handling of partial-but-sufficient turn lifecycle data.

*Call graph*: calls 2 internal fn (ingest_turn_prerequisites, sample_turn_completed_notification); 6 external calls (new, new, Notification, default, assert_eq!, to_value).


##### `sample_plugin_metadata`  (lines 4339–4355)

```
fn sample_plugin_metadata() -> PluginTelemetryMetadata
```

**Purpose**: Builds reusable fake plugin metadata with a plugin ID, display name, skill support, MCP server names, and app connector IDs.

**Data flow**: It takes no input. It parses a sample plugin ID and returns PluginTelemetryMetadata with a populated capability summary.

**Call relations**: Plugin serialization, deduplication, reducer ingestion, and plugin state tests call this to share one consistent plugin fixture.

*Call graph*: calls 1 internal fn (parse); called by 6 (plugin_management_event_can_use_remote_plugin_id_override, plugin_management_event_serializes_expected_shape, plugin_used_dedupe_is_keyed_by_turn_and_plugin, plugin_used_event_serializes_expected_shape, reducer_ingests_app_and_plugin_facts, reducer_ingests_plugin_state_changed_fact); 1 external calls (vec!).


### `app-server/tests/suite/v2/analytics.rs`

`test` · `test execution`

This file is part test, part test toolbox. Analytics are the small event reports the app-server sends so the project can understand things like thread starts, turns, and goals. In normal life these reports would go to a real service. In tests, this file sets up a fake web server and teaches the tests how to wait for, read, and check those reports safely.

The first two tests verify an important default: if the user has not explicitly set analytics on or off, the app-server may choose its own default. One test says “when the default is off, metrics must stay off.” The other says “when the default is on, metrics must be enabled.” This protects privacy and product behavior from changing by accident.

The helper functions then act like a mailroom for analytics tests. They mount a fake HTTP endpoint, write a fake ChatGPT login file so the app has account information, wait until a matching analytics request arrives, parse its JSON body, and pull out specific events. Other test files use these helpers to assert that starting, resuming, forking, steering, and completing goals all produce the expected analytics records. Without this file, those tests would either need to duplicate a lot of setup code or would be much less precise about what analytics were actually emitted.

#### Function details

##### `set_metrics_exporter`  (lines 24–31)

```
fn set_metrics_exporter(config: &mut codex_core::config::Config)
```

**Purpose**: This helper edits a test configuration so metrics are sent through the OpenTelemetry HTTP exporter. OpenTelemetry is a common format for sending monitoring data, and here it is aimed at a local test endpoint rather than a real analytics service.

**Data flow**: It takes a mutable config object as input. It replaces the config's metrics exporter setting with an HTTP JSON exporter pointed at localhost, with no extra headers or TLS settings. It does not return a value; the config is changed in place.

**Call relations**: The two analytics-default tests call this before building a telemetry provider. It gives those tests a realistic metrics destination so they can check whether the provider actually enables metrics under different default settings.

*Call graph*: called by 2 (app_server_default_analytics_disabled_without_flag, app_server_default_analytics_enabled_with_flag); 1 external calls (new).


##### `app_server_default_analytics_disabled_without_flag`  (lines 34–56)

```
async fn app_server_default_analytics_disabled_without_flag() -> Result<()>
```

**Purpose**: This test proves that app-server metrics stay disabled when the config does not explicitly mention analytics and the app-server default says analytics should be off. It protects the system from accidentally collecting metrics by default.

**Data flow**: It creates a temporary Codex home folder, builds a fresh config, sets a metrics exporter, and then leaves the analytics setting unset. It asks the telemetry setup code to build a provider with the default-analytics flag set to false. It then checks the provider and expects that no metrics component exists.

**Call relations**: This test uses set_metrics_exporter to prepare the config, then hands the config to codex_core::otel_init::build_provider. The final assertion is the safety check: even though an exporter was configured, metrics must not appear because the default flag was false.

*Call graph*: calls 2 internal fn (set_metrics_exporter, build_provider); 3 external calls (new, assert_eq!, default).


##### `app_server_default_analytics_enabled_with_flag`  (lines 59–80)

```
async fn app_server_default_analytics_enabled_with_flag() -> Result<()>
```

**Purpose**: This test proves the opposite default case: when analytics are not explicitly configured and the app-server default says analytics should be on, metrics are enabled. It ensures the app-server can opt into analytics by default when intended.

**Data flow**: It creates a temporary Codex home folder, builds a fresh config, points metrics at an HTTP exporter, and leaves analytics unset. It builds a telemetry provider with the default-analytics flag set to true. It then checks that the provider includes a metrics component.

**Call relations**: Like the disabled-default test, it relies on set_metrics_exporter and then calls the shared telemetry builder. The assertion confirms that the default flag is respected by the telemetry setup path.

*Call graph*: calls 2 internal fn (set_metrics_exporter, build_provider); 3 external calls (new, assert_eq!, default).


##### `mount_analytics_capture`  (lines 82–99)

```
async fn mount_analytics_capture(server: &MockServer, codex_home: &Path) -> Result<()>
```

**Purpose**: This helper prepares a fake analytics receiver for tests. It also writes fake ChatGPT authentication data so analytics events can include the account and user information they normally depend on.

**Data flow**: It receives a mock HTTP server and a Codex home path. It mounts a rule on the mock server that accepts POST requests to the analytics-events endpoint and replies with HTTP 200, meaning “accepted.” Then it writes a test auth file containing a token, account id, and user ids. It returns success or an error if setup fails.

**Call relations**: Many app-server analytics tests call this before performing actions that should emit analytics, such as starting, resuming, or forking threads and tracking goal lifecycle events. It sets the stage so later helpers can read the HTTP requests that the app-server sends.

*Call graph*: calls 1 internal fn (new); called by 10 (thread_fork_tracks_thread_initialized_analytics, thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal, thread_resume_tracks_thread_initialized_analytics, thread_start_tracks_thread_initialized_analytics, turn_profile_tracks_blocking_tool_and_follow_up_sampling, turn_start_tracks_turn_event_analytics, turn_steer_rejects_context_only_input_without_merging_context, turn_steer_rejects_oversized_text_input, turn_steer_requires_active_turn, turn_steer_returns_active_turn_id); 5 external calls (given, new, write_chatgpt_auth, method, path).


##### `wait_for_analytics_payload`  (lines 101–121)

```
async fn wait_for_analytics_payload(
    server: &MockServer,
    read_timeout: Duration,
) -> Result<Value>
```

**Purpose**: This helper waits until the fake analytics server receives any analytics payload, then returns that payload as parsed JSON. It is useful when a test wants to inspect the whole batch of analytics events.

**Data flow**: It takes the mock server and a maximum wait time. It repeatedly asks the server for received requests, looking for a POST to the analytics endpoint. If no matching request has arrived yet, it sleeps briefly and tries again until the timeout expires. When it finds a request, it parses the body from raw bytes into JSON and returns it.

**Call relations**: Thread start, resume, and fork analytics tests call this after triggering app-server behavior. They then pass the returned payload to helpers such as thread_initialized_event to find and check the expected event.

*Call graph*: called by 3 (thread_fork_tracks_thread_initialized_analytics, thread_resume_tracks_thread_initialized_analytics, thread_start_tracks_thread_initialized_analytics); 5 external calls (from_millis, received_requests, from_slice, sleep, timeout).


##### `wait_for_analytics_event`  (lines 123–132)

```
async fn wait_for_analytics_event(
    server: &MockServer,
    read_timeout: Duration,
    event_type: &str,
) -> Result<Value>
```

**Purpose**: This helper waits for a single analytics event with a given event type. It saves tests from manually scanning every analytics payload.

**Data flow**: It receives the mock server, a timeout, and the event type string to look for. It builds a small matching rule that checks each event's event_type field, then delegates the actual polling and JSON parsing to wait_for_matching_analytics_event. It returns the first matching event as JSON.

**Call relations**: Tests for turn events, active-turn behavior, and profiling call this after the app-server should have emitted a specific event. This function is the simple front door for event-type based checks, while wait_for_matching_analytics_event does the lower-level searching.

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

**Purpose**: This helper waits for a specific goal analytics event, including both the kind of goal event and its status. It is tailored for tests that check the lifecycle of goals.

**Data flow**: It receives the mock server, a timeout, an expected event kind, and an expected goal status. It creates a matching rule that requires the event type to be codex_goal_event and also checks event_params.event_kind and event_params.goal_status. It returns the first JSON event that satisfies all three checks.

**Call relations**: The goal lifecycle test calls this when it expects goal-related analytics to arrive. It delegates the repeated polling and parsing work to wait_for_matching_analytics_event, adding only the goal-specific matching rule.

*Call graph*: calls 1 internal fn (wait_for_matching_analytics_event); called by 1 (thread_goal_lifecycle_emits_analytics_and_clear_deletes_goal).


##### `wait_for_matching_analytics_event`  (lines 148–178)

```
async fn wait_for_matching_analytics_event(
    server: &MockServer,
    read_timeout: Duration,
    matches: impl Fn(&Value) -> bool,
) -> Result<Value>
```

**Purpose**: This is the general search helper for analytics events. It waits for analytics HTTP requests, opens their JSON bodies, and returns the first event accepted by a caller-provided matching rule.

**Data flow**: It receives a mock server, a timeout, and a matching function. Inside the timeout, it repeatedly reads the server's received requests. For each POST to the analytics endpoint, it parses the request body as JSON, looks for an events array, and tests each event with the matching function. If one matches, it returns that event; otherwise it sleeps briefly and keeps waiting.

**Call relations**: wait_for_analytics_event and wait_for_goal_event both call this instead of duplicating the polling loop. It is the shared engine behind “wait until the analytics event I care about appears” in the test suite.

*Call graph*: called by 2 (wait_for_analytics_event, wait_for_goal_event); 5 external calls (from_millis, received_requests, from_slice, sleep, timeout).


##### `thread_initialized_event`  (lines 180–188)

```
fn thread_initialized_event(payload: &Value) -> Result<&Value>
```

**Purpose**: This helper pulls the thread-initialized analytics event out of a full analytics payload. Tests use it when they expect a thread start, resume, or fork to report that a thread was initialized.

**Data flow**: It receives a JSON payload. It first looks for an events array and returns an error if that array is missing. It then scans the events for one whose event_type is codex_thread_initialized. If found, it returns a reference to that event; if not, it returns an error explaining that the expected event was absent.

**Call relations**: Thread start, resume, and fork tests call this after wait_for_analytics_payload has returned a full analytics request body. It narrows the payload down to the one event that assert_basic_thread_initialized_event can then inspect in detail.

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

**Purpose**: This helper checks the common required fields of a thread-initialized analytics event. It keeps several tests consistent about what a valid thread initialization report must contain.

**Data flow**: It receives the event JSON and the expected thread id, session id, model, initialization mode, and thread source. It compares those expected values against fields inside event_params, also checking fixed values such as the default client name, stdio transport, non-ephemeral status, null parent and subagent fields, and the presence of a numeric created_at timestamp. It returns nothing; a mismatch fails the test.

**Call relations**: Thread start, resume, and fork analytics tests call this after extracting the thread-initialized event. It is the final checklist that proves the event contains the right identity, client, model, source, and timing information.

*Call graph*: called by 3 (thread_fork_tracks_thread_initialized_analytics, thread_resume_tracks_thread_initialized_analytics, thread_start_tracks_thread_initialized_analytics); 2 external calls (assert!, assert_eq!).


### Application telemetry regressions
These tests exercise telemetry emitted by core application helpers, task metrics, request handling, and persisted log filtering.

### `core/src/tasks/mod_tests.rs`

`test` · `test run`

This is a test file for a small but important kind of bookkeeping: telemetry metrics. A metric is a counted measurement, like “this happened once,” often with labels that explain the situation. Here, the code checks that when the task system reports certain events, the recorded metric has both the right value and the right descriptive tags.

The tests use an in-memory metrics exporter, which is like a clipboard instead of a real reporting service. The code under test writes metrics to it, and the tests read the clipboard back to make sure the entry is correct. This avoids sending anything over the network while still testing the real metric-writing path.

There are helper functions that build a fake session with metrics enabled, find a named metric in the captured snapshot, turn its labels into an easy-to-compare map, and extract the single counter value the test expects. Then the individual tests cover three metric families: whether a network proxy was active during a turn, whether memory reading was enabled and actually allowed, and whether a task compaction was manual or automatic and what type it was.

Without these tests, a later code change could still compile but record the wrong label names, wrong true/false values, or wrong metric counter, making dashboards and product analysis unreliable.

#### Function details

##### `test_session_telemetry`  (lines 21–41)

```
fn test_session_telemetry() -> SessionTelemetry
```

**Purpose**: Creates a fake session telemetry object that records metrics in memory for tests. Test cases use it so they can inspect what metrics were emitted without contacting a real telemetry service.

**Data flow**: It starts with a fresh in-memory metric exporter, builds a metrics client configured for testing, creates a new session identity and session metadata, then attaches the metrics client to that session. The result is a SessionTelemetry value ready to receive metric events during a test.

**Call relations**: Each metric test calls this first to get a clean, isolated telemetry session. It calls the telemetry and metrics constructors needed to build that session, and the returned object is later passed into the metric-emitting functions being tested.

*Call graph*: calls 4 internal fn (new, new, in_memory, new); called by 6 (emit_compact_metric_records_auto_local, emit_compact_metric_records_manual_remote_v2, emit_turn_memory_metric_records_config_disabled_without_citations, emit_turn_memory_metric_records_read_allowed_with_citations, emit_turn_network_proxy_metric_records_active_turn, emit_turn_network_proxy_metric_records_inactive_turn); 2 external calls (default, env!).


##### `find_metric`  (lines 43–52)

```
fn find_metric(resource_metrics: &'a ResourceMetrics, name: &str) -> &'a Metric
```

**Purpose**: Looks through a captured metrics snapshot and returns the metric with a requested name. It gives the tests a simple way to locate the exact measurement they care about.

**Data flow**: It receives a ResourceMetrics snapshot and a metric name. It searches through the snapshot’s groups of metrics until it finds one with that name, then returns it. If no matching metric exists, it stops the test with a clear failure message.

**Call relations**: This helper is used by metric_point. The individual tests do not search the snapshot themselves; they ask metric_point for the metric value and labels, and metric_point relies on this function to find the named metric first.

*Call graph*: called by 1 (metric_point); 2 external calls (scope_metrics, panic!).


##### `attributes_to_map`  (lines 54–60)

```
fn attributes_to_map(
    attributes: impl Iterator<Item = &'a KeyValue>,
) -> BTreeMap<String, String>
```

**Purpose**: Converts metric labels into a sorted map of strings so tests can compare them easily. This makes the assertions clear and stable, regardless of the original label order.

**Data flow**: It receives an iterator over metric key-value labels. For each label, it turns the key and value into plain strings and collects them into a BTreeMap, which keeps keys in sorted order. The output is a map from label name to label value.

**Call relations**: metric_point calls this after it has found the single metric data point. The returned map is handed back to the test, which compares it with the expected labels.

*Call graph*: called by 1 (metric_point); 1 external calls (map).


##### `metric_point`  (lines 62–76)

```
fn metric_point(resource_metrics: &ResourceMetrics, name: &str) -> (BTreeMap<String, String>, u64)
```

**Purpose**: Extracts the labels and count from a named counter metric in a captured snapshot. It also checks that the metric has exactly the simple shape these tests expect: one unsigned integer counter with one data point.

**Data flow**: It receives a metrics snapshot and a metric name. It finds the metric, checks that it is an unsigned integer counter sum, checks that there is exactly one recorded point, converts that point’s labels into a map, and returns the label map plus the counter value. If the metric has an unexpected form, it fails the test.

**Call relations**: All six test cases call this after emitting a metric and taking a snapshot. It ties together find_metric and attributes_to_map so each test can focus on checking the expected value and labels.

*Call graph*: calls 2 internal fn (attributes_to_map, find_metric); called by 6 (emit_compact_metric_records_auto_local, emit_compact_metric_records_manual_remote_v2, emit_turn_memory_metric_records_config_disabled_without_citations, emit_turn_memory_metric_records_read_allowed_with_citations, emit_turn_network_proxy_metric_records_active_turn, emit_turn_network_proxy_metric_records_inactive_turn); 2 external calls (assert_eq!, panic!).


##### `emit_turn_network_proxy_metric_records_active_turn`  (lines 79–101)

```
fn emit_turn_network_proxy_metric_records_active_turn()
```

**Purpose**: Tests that a turn with the network proxy active records the network proxy metric correctly. It verifies both the count and the labels that describe the active state and temporary memory setting.

**Data flow**: It creates a test telemetry session, emits the network proxy metric with active set to true and a temporary-memory label set to true, then snapshots the recorded metrics. It extracts the relevant metric and checks that its value is 1 and its labels say active=true and tmp_mem_enabled=true.

**Call relations**: This test uses test_session_telemetry to set up a clean metrics recorder, calls emit_turn_network_proxy_metric from the task code under test, then uses metric_point to read back what was recorded.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_turn_network_proxy_metric).


##### `emit_turn_network_proxy_metric_records_inactive_turn`  (lines 104–126)

```
fn emit_turn_network_proxy_metric_records_inactive_turn()
```

**Purpose**: Tests that a turn with the network proxy inactive records the network proxy metric correctly. It makes sure the false case is reported explicitly, not lost or mislabeled.

**Data flow**: It creates a test telemetry session, emits the network proxy metric with active set to false and a temporary-memory label set to false, then snapshots the metrics. It confirms that the metric count is 1 and that the labels contain active=false and tmp_mem_enabled=false.

**Call relations**: Like the active-turn test, it sets up telemetry with test_session_telemetry, exercises emit_turn_network_proxy_metric, and reads the result through metric_point. Together, the two tests cover both true and false network proxy states.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_turn_network_proxy_metric).


##### `emit_turn_memory_metric_records_read_allowed_with_citations`  (lines 129–154)

```
fn emit_turn_memory_metric_records_read_allowed_with_citations()
```

**Purpose**: Tests the memory metric when memory reading is fully allowed and citations are present. This checks the happy path where the feature is enabled, configuration permits it, and the output includes memory citations.

**Data flow**: It creates a test telemetry session, emits the memory metric with feature enabled, config enabled, and citations present, then snapshots the metrics. It verifies that the counter is 1 and that the labels report feature_enabled=true, config_use_memories=true, has_citations=true, and read_allowed=true.

**Call relations**: The test prepares telemetry with test_session_telemetry, calls emit_turn_memory_metric from the task code, and uses metric_point to inspect the recorded TURN_MEMORY_METRIC. It confirms that the metric code derives read_allowed correctly when both enabling inputs are true.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_turn_memory_metric).


##### `emit_turn_memory_metric_records_config_disabled_without_citations`  (lines 157–182)

```
fn emit_turn_memory_metric_records_config_disabled_without_citations()
```

**Purpose**: Tests the memory metric when the feature exists but the user or configuration has disabled memory use. It checks that the metric records memory reading as not allowed and notes that no citations were present.

**Data flow**: It creates a test telemetry session, emits the memory metric with feature enabled, config disabled, and citations absent, then snapshots the metrics. It checks that the counter is 1 and that the labels report feature_enabled=true, config_use_memories=false, has_citations=false, and read_allowed=false.

**Call relations**: This test follows the same setup-emit-read pattern as the other metric tests. It calls emit_turn_memory_metric and then metric_point, covering the important case where one setting blocks memory reads even though the feature itself is available.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_turn_memory_metric).


##### `emit_compact_metric_records_manual_remote_v2`  (lines 185–203)

```
fn emit_compact_metric_records_manual_remote_v2()
```

**Purpose**: Tests that a manual remote_v2 compaction event is counted with the right labels. Compaction here means shrinking or summarizing task context, and the metric needs to say what kind happened and whether a person triggered it.

**Data flow**: It creates a test telemetry session, emits the compact metric with type remote_v2 and manual set to true, then snapshots the metrics. It confirms that the counter value is 1 and that the labels are type=remote_v2 and manual=true.

**Call relations**: The test gets its telemetry object from test_session_telemetry, calls emit_compact_metric from the task module, and uses metric_point to read back TASK_COMPACT_METRIC. It covers the manual remote compaction path.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_compact_metric).


##### `emit_compact_metric_records_auto_local`  (lines 206–224)

```
fn emit_compact_metric_records_auto_local()
```

**Purpose**: Tests that an automatic local compaction event is counted with the right labels. This protects the distinction between automatic background compaction and manual compaction requested by a user or caller.

**Data flow**: It creates a test telemetry session, emits the compact metric with type local and manual set to false, then snapshots the metrics. It verifies that the counter value is 1 and that the labels are type=local and manual=false.

**Call relations**: This test mirrors the manual remote compaction test but uses the automatic local case. It relies on test_session_telemetry for setup, emit_compact_metric for the behavior under test, and metric_point for reading the recorded metric.

*Call graph*: calls 2 internal fn (metric_point, test_session_telemetry); 2 external calls (assert_eq!, emit_compact_metric).


### `core/src/util_tests.rs`

`test` · `test run`

This is a test file. Its main job is to prove that the project’s feedback-tag reporting works the way monitoring tools expect. Feedback tags are small pieces of context, such as which API endpoint was used or whether an authorization header was attached. They are sent through Rust’s tracing system, which is a structured logging and telemetry pipeline.

To inspect those tracing events, the file builds a tiny test-only collector. `TagCollectorLayer` listens for events whose target is `feedback_tags`, and `TagCollectorVisitor` pulls each field out of the event into a map of names to string values. Think of it like putting a temporary basket under a mail slot so the tests can inspect exactly which letters were delivered.

The tests then emit feedback tags in several situations: normal request reporting, authentication recovery after a 401 unauthorized response, clearing old error fields, preserving the latest failure details, and supporting older emitters that do not send every field. The file also checks that blank optional fields are deliberately written as empty strings, rather than leaving stale values behind. Finally, it verifies that thread names are trimmed and empty names are rejected.

#### Function details

##### `feedback_tags_macro_compiles`  (lines 19–24)

```
fn feedback_tags_macro_compiles()
```

**Purpose**: This test checks that the `feedback_tags!` macro can accept different kinds of values, including strings, booleans, and values that only support debug printing. Its purpose is to catch compile-time breakage in the macro interface.

**Data flow**: The test defines a small local type that can be debug-printed, then passes several fields into the macro. Nothing is returned; the important result is that the code compiles successfully.

**Call relations**: The Rust test runner calls this test. Inside it, the test invokes the `feedback_tags!` macro directly to make sure callers elsewhere in the project can keep using that macro shape.

*Call graph*: 1 external calls (feedback_tags!).


##### `TagCollectorVisitor::record_bool`  (lines 32–35)

```
fn record_bool(&mut self, field: &tracing::field::Field, value: bool)
```

**Purpose**: This method records a boolean field from a tracing event into the test collector. It lets tests later ask, for example, whether a tag like `auth_header_attached` was emitted as `true` or `false`.

**Data flow**: It receives a field name and a boolean value from the tracing system. It turns the field name and value into strings, then stores them in the visitor’s tag map.

**Call relations**: This method is called by the tracing event recording process when `TagCollectorLayer::on_event` asks an event to write its fields into a `TagCollectorVisitor`. It contributes one captured field to the map that the test later checks.

*Call graph*: 1 external calls (name).


##### `TagCollectorVisitor::record_str`  (lines 37–40)

```
fn record_str(&mut self, field: &tracing::field::Field, value: &str)
```

**Purpose**: This method records a string field from a tracing event into the test collector. It is used for tags such as endpoint names, request IDs, and error codes.

**Data flow**: It receives a field name and a string value. It copies both into the visitor’s tag map so the test can compare the recorded value with the expected value.

**Call relations**: The tracing event recording process calls this when an emitted feedback tag is a string. It is part of the path from an emitted telemetry event to the assertions in the tests.

*Call graph*: 1 external calls (name).


##### `TagCollectorVisitor::record_debug`  (lines 42–45)

```
fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug)
```

**Purpose**: This method records fields that are supplied in debug-print form rather than as plain strings or booleans. Debug printing is Rust’s standard way to turn many values into a readable representation for developers.

**Data flow**: It receives a field name and a value that can be debug-printed. It formats that value into a string and stores it under the field name in the visitor’s tag map.

**Call relations**: The tracing system calls this during event recording when a field is not handled by the more specific boolean or string methods. The tests rely on this because many optional values are emitted in a quoted debug-style form.

*Call graph*: 2 external calls (name, format!).


##### `TagCollectorLayer::on_event`  (lines 58–66)

```
fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>)
```

**Purpose**: This method is the test collector’s event hook. It watches tracing events and captures only the ones meant for feedback tags.

**Data flow**: It receives a tracing event. If the event is not targeted at `feedback_tags`, it ignores it. If it is, it creates a visitor, asks the event to write its fields into that visitor, merges the collected tags into shared test storage, and increments a shared event counter.

**Call relations**: The tracing subscriber calls this method whenever an event is emitted while the test collector is installed. The feedback-tag emission functions trigger those events, and the individual tests inspect the stored tags and event count afterward.

*Call graph*: 3 external calls (default, metadata, record).


##### `emit_feedback_request_tags_records_sentry_feedback_fields`  (lines 70–170)

```
fn emit_feedback_request_tags_records_sentry_feedback_fields()
```

**Purpose**: This test verifies that a full feedback request event includes the expected request, authentication, and environment fields. It protects the data that monitoring tools such as Sentry need for debugging failures.

**Data flow**: The test creates shared storage for captured tags, installs the test tracing collector, builds an authentication-environment snapshot, and emits feedback request tags with that snapshot. It then reads the captured map and checks that each important field has the expected string value, and that exactly one feedback event was recorded.

**Call relations**: The test runner calls this test. The test sets up `TagCollectorLayer`, calls `emit_feedback_request_tags_with_auth_env`, and then relies on `TagCollectorLayer::on_event` and `TagCollectorVisitor` to capture what was emitted.

*Call graph*: 6 external calls (new, new, new, assert_eq!, emit_feedback_request_tags_with_auth_env, registry).


##### `emit_feedback_auth_recovery_tags_preserves_401_specific_fields`  (lines 173–211)

```
fn emit_feedback_auth_recovery_tags_preserves_401_specific_fields()
```

**Purpose**: This test checks that authentication recovery reporting keeps the details from a 401 unauthorized response. A 401 response means the server rejected the credentials, so preserving its request ID, Cloudflare ray ID, and error code is important for diagnosis.

**Data flow**: The test installs the tag collector, emits authentication recovery tags with specific 401-related values, then reads the captured tag map. It confirms that the 401 request ID, ray ID, error message, and error code were recorded, and that one event was emitted.

**Call relations**: The test runner calls this test. The authentication recovery emitter produces the event, and the custom tracing layer captures it so the assertions can verify the fields.

*Call graph*: 5 external calls (new, new, new, assert_eq!, registry).


##### `emit_feedback_auth_recovery_tags_clears_stale_401_fields`  (lines 214–258)

```
fn emit_feedback_auth_recovery_tags_clears_stale_401_fields()
```

**Purpose**: This test makes sure old 401 error details do not accidentally remain visible after a later recovery update omits them. Without this, monitoring could show yesterday’s error as if it belonged to the current request.

**Data flow**: The test first emits recovery tags with full 401 details, then emits a second recovery event where several optional 401 fields are missing. It reads the final captured tag values and checks that missing fields became empty strings, while the newer request ID replaced the older one. It also checks that two events were captured.

**Call relations**: The test runner calls this test. Two calls to the authentication recovery emitter create two tracing events, and `TagCollectorLayer::on_event` merges the latest fields into the shared map for inspection.

*Call graph*: 5 external calls (new, new, new, assert_eq!, registry).


##### `emit_feedback_request_tags_preserves_latest_auth_fields_after_unauthorized`  (lines 261–311)

```
fn emit_feedback_request_tags_preserves_latest_auth_fields_after_unauthorized()
```

**Purpose**: This test verifies that after an unauthorized response, the ordinary request-tag emitter still reports the most recent authentication failure details. That helps developers see the failed request and the follow-up recovery result together.

**Data flow**: The test installs the collector and emits feedback request tags describing a retry after unauthorized access, including request IDs, error details, and a failed follow-up status. It then reads the captured tags and confirms those latest authentication fields were recorded, with one event counted.

**Call relations**: The test runner calls this test. It calls `emit_feedback_request_tags`, which emits a tracing event that the collector layer receives and stores for the assertions.

*Call graph*: 6 external calls (new, new, new, assert_eq!, emit_feedback_request_tags, registry).


##### `emit_feedback_request_tags_preserves_auth_env_fields_for_legacy_emitters`  (lines 314–425)

```
fn emit_feedback_request_tags_preserves_auth_env_fields_for_legacy_emitters()
```

**Purpose**: This test checks compatibility between newer feedback emitters that include authentication-environment details and older emitters that do not. It ensures older calls clear per-request fields without wiping out environment fields that should remain known.

**Data flow**: The test first emits a rich feedback event with authentication-environment information. It then emits a second, simpler event with many optional request fields missing. After both events, it checks that missing request fields were replaced by empty strings, while environment fields such as API-key presence remained available. It also checks that two events were captured.

**Call relations**: The test runner calls this test. It uses both `emit_feedback_request_tags_with_auth_env` and `emit_feedback_request_tags`, while the tracing collector captures their combined effect so the test can verify backward-compatible behavior.

*Call graph*: 7 external calls (new, new, new, assert_eq!, emit_feedback_request_tags, emit_feedback_request_tags_with_auth_env, registry).


##### `normalize_thread_name_trims_and_rejects_empty`  (lines 428–434)

```
fn normalize_thread_name_trims_and_rejects_empty()
```

**Purpose**: This test verifies that thread names are cleaned up before use. Names made only of spaces are rejected, while names with extra spaces around them are trimmed.

**Data flow**: The test passes a whitespace-only string and expects no usable name back. It then passes a name with leading and trailing spaces and expects the cleaned name `my thread` as the result.

**Call relations**: The test runner calls this test. It directly exercises `normalize_thread_name`, which is imported from the surrounding utility module, and checks the returned values with assertions.

*Call graph*: 1 external calls (assert_eq!).


### `core/tests/suite/otel.rs`

`test` · `test run`

Telemetry is the system’s flight recorder. When Codex talks to the model, receives streamed events, runs tools, or asks the user for approval, operators need clear records of what happened. This test file builds small fake conversations against a mock server and then inspects the tracing output to make sure those records are present and correctly labeled. The tests cover both normal paths, like a completed model response with token usage, and failure paths, like malformed server-sent events. A server-sent event stream, or SSE, is a way for a server to send a sequence of updates over one HTTP response. The file also checks tool-related telemetry: unsupported function calls, shell command calls, sandbox retries, and whether a command was approved by configuration or by the user. Several helper functions create fake shell calls, create platform-specific commands, and search log lines for named fields. Without these tests, telemetry could silently lose important details such as token counts, error messages, approval source, or tool output, making real problems much harder to diagnose.

#### Function details

##### `extract_log_field`  (lines 41–59)

```
fn extract_log_field(line: &str, key: &str) -> Option<String>
```

**Purpose**: Pulls one named value out of a single formatted log line. It understands both quoted fields, such as key="value", and plain fields, such as key=value.

**Data flow**: It receives a log line and a field name. It first looks for a quoted value, then scans space-separated tokens for an unquoted value. It returns the value as text when found, or nothing when the field is absent.

**Call relations**: This is a small helper used by assert_empty_mcp_tool_fields when tests need to check specific telemetry fields instead of doing broad text matching.

*Call graph*: called by 1 (assert_empty_mcp_tool_fields); 1 external calls (format!).


##### `assert_empty_mcp_tool_fields`  (lines 61–77)

```
fn assert_empty_mcp_tool_fields(line: &str) -> Result<(), String>
```

**Purpose**: Checks that MCP-related tool fields are present in a log line but empty. MCP means Model Context Protocol, a way tools can be provided by external servers; these tests expect no external MCP server for local tool calls.

**Data flow**: It receives one log line. It extracts mcp_server and mcp_server_origin, verifies both exist, and verifies both values are empty. It returns success or a clear error message explaining what was wrong.

**Call relations**: Tool-result tests call this helper after finding a codex.tool_result log line, so they can confirm local tools are not accidentally reported as MCP tools.

*Call graph*: calls 1 internal fn (extract_log_field); 1 external calls (format!).


##### `shell_command_call`  (lines 79–82)

```
fn shell_command_call(call_id: &str, command: &str) -> serde_json::Value
```

**Purpose**: Builds a fake model function-call event that asks Codex to run a shell command. Tests use it to simulate the model requesting command execution.

**Data flow**: It receives a call id and command text. It wraps the command in JSON arguments and passes that to the shared response-event builder. The result is a JSON event shaped like a shell_command function call.

**Call relations**: Many shell-command telemetry tests use this helper while mounting fake SSE responses on the mock server.

*Call graph*: calls 1 internal fn (ev_function_call); 1 external calls (json!).


##### `touch_command`  (lines 84–90)

```
fn touch_command(path: &str) -> String
```

**Purpose**: Creates a small command that makes a file, using the right syntax for the current operating system. This lets approval tests request a realistic command without hard-coding Unix-only syntax.

**Data flow**: It receives a file path. On Windows it returns a PowerShell New-Item command; on other systems it returns a /usr/bin/touch command. It does not run the command itself.

**Call relations**: User-approval and sandbox-retry tests call this when they need a shell command that will trigger approval handling.

*Call graph*: called by 6 (handle_sandbox_error_user_approves_for_session_records_tool_decision, handle_sandbox_error_user_approves_retry_records_tool_decision, handle_sandbox_error_user_denies_records_tool_decision, handle_shell_command_user_approved_for_session_records_tool_decision, handle_shell_command_user_approved_records_tool_decision, handle_shell_command_user_denies_records_tool_decision); 2 external calls (cfg!, format!).


##### `extract_log_field_handles_empty_bare_values`  (lines 93–100)

```
fn extract_log_field_handles_empty_bare_values()
```

**Purpose**: Verifies that extract_log_field can read empty unquoted values. This matters because telemetry sometimes records a field as present but blank.

**Data flow**: It creates a sample log line with mcp_server= and mcp_server_origin=. It asks extract_log_field for each field and asserts that the returned value is an empty string.

**Call relations**: The Rust test runner calls this directly. It protects the helper that later tool-result tests rely on.

*Call graph*: 1 external calls (assert_eq!).


##### `extract_log_field_does_not_confuse_similar_keys`  (lines 103–110)

```
fn extract_log_field_does_not_confuse_similar_keys()
```

**Purpose**: Verifies that extract_log_field does not mistake one field name for another longer field name. For example, mcp_server should not match mcp_server_origin.

**Data flow**: It creates a sample log line containing only mcp_server_origin. It confirms that looking up mcp_server returns nothing, while looking up mcp_server_origin returns the expected value.

**Call relations**: The Rust test runner calls this directly. It prevents false positives in later checks of telemetry field names.

*Call graph*: 1 external calls (assert_eq!).


##### `responses_api_emits_api_request_event`  (lines 114–152)

```
async fn responses_api_emits_api_request_event()
```

**Purpose**: Checks that sending user input to the Responses API creates telemetry for the API request and for the start of a conversation.

**Data flow**: It starts a mock server, prepares a completed fake stream, builds a test Codex instance, and submits the text "hello". After the turn finishes, it scans captured logs for codex.api_request and codex.conversation_starts.

**Call relations**: The test runner calls this asynchronous test. It uses the mock server and test Codex builder to drive the normal request path, then inspects tracing output.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_emits_tracing_for_output_item`  (lines 156–193)

```
async fn process_sse_emits_tracing_for_output_item()
```

**Purpose**: Checks that a completed assistant output item from the SSE stream is logged as a response output event.

**Data flow**: It mounts a fake stream containing an assistant message and a completion event, submits user input, waits for the turn to complete, and searches logs for a codex.sse_event with response.output_item.done.

**Call relations**: The test runner calls this. It exercises the stream-processing path and confirms that individual response items are visible in telemetry.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_emits_failed_event_on_parse_error`  (lines 197–240)

```
async fn process_sse_emits_failed_event_on_parse_error()
```

**Purpose**: Checks that malformed streamed data is recorded as a telemetry error instead of disappearing silently.

**Data flow**: It serves an invalid SSE payload, submits user input, waits for Codex to finish handling the turn, and looks for a codex.sse_event log containing the JSON parse error message.

**Call relations**: The test runner calls this. It drives the SSE parser through a bad-input path and confirms the error is handed to tracing.

*Call graph*: calls 3 internal fn (mount_sse_once, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_records_failed_event_when_stream_closes_without_completed`  (lines 244–287)

```
async fn process_sse_records_failed_event_when_stream_closes_without_completed()
```

**Purpose**: Checks that Codex logs a failure when a stream ends before the required response.completed event arrives.

**Data flow**: It serves a stream with an assistant message but no completed marker. After a user turn, it searches logs for a codex.sse_event whose error says the stream closed too early.

**Call relations**: The test runner calls this. It verifies the stream-processing code records an incomplete response as a failure.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_failed_event_records_response_error_message`  (lines 291–355)

```
async fn process_sse_failed_event_records_response_error_message()
```

**Purpose**: Checks that an explicit response.failed event from the server includes the server’s error message in telemetry.

**Data flow**: It serves a failed response whose error message is "boom", then serves a follow-up successful response so the overall turn can finish. It waits for completion and confirms the failure log contains response.failed and the message.

**Call relations**: The test runner calls this. It exercises the failure-event branch of SSE handling and then lets Codex continue through the normal follow-up flow.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_failed_event_logs_parse_error`  (lines 359–417)

```
async fn process_sse_failed_event_logs_parse_error()
```

**Purpose**: Checks that Codex still logs a response.failed event even when the error payload has an unexpected shape.

**Data flow**: It sends a response.failed event where the error field is a plain string instead of an object, then sends a normal follow-up stream. After the turn finishes, it verifies that response.failed appeared in telemetry.

**Call relations**: The test runner calls this. It covers a defensive path where telemetry should survive malformed error details.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_failed_event_logs_missing_error`  (lines 421–469)

```
async fn process_sse_failed_event_logs_missing_error()
```

**Purpose**: Checks that a response.failed event with no error object is still visible in logs.

**Data flow**: It serves a failed response with an empty response body, submits user input, waits for completion, and confirms a codex.sse_event for response.failed was written.

**Call relations**: The test runner calls this. It ensures missing optional error details do not prevent the event itself from being recorded.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_failed_event_logs_response_completed_parse_error`  (lines 473–533)

```
async fn process_sse_failed_event_logs_response_completed_parse_error()
```

**Purpose**: Checks that a malformed response.completed event records a parse error in telemetry.

**Data flow**: It sends a response.completed event without the expected completed-response fields, then provides a successful follow-up stream. After the turn finishes, it searches logs for response.completed plus a parse-error message.

**Call relations**: The test runner calls this. It validates telemetry for a bad completion payload in the stream-processing code.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `process_sse_emits_completed_telemetry`  (lines 537–591)

```
async fn process_sse_emits_completed_telemetry()
```

**Purpose**: Checks that a completed response logs token usage. Token counts matter for cost, performance, and debugging model behavior.

**Data flow**: It serves a completed response with input, cached input, output, reasoning, and total token counts. After a user turn, it checks that those numbers appear on the codex.sse_event log.

**Call relations**: The test runner calls this. It exercises the completed-response path and verifies that usage data is copied into telemetry fields.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `turn_and_completed_response_spans_record_token_usage`  (lines 594–683)

```
async fn turn_and_completed_response_spans_record_token_usage()
```

**Purpose**: Checks that token usage is attached not only to event logs but also to tracing spans. A span is a timed section of work, like a labeled stopwatch around a request or turn.

**Data flow**: It installs a tracing subscriber that writes into an in-memory buffer, serves a completed response with usage numbers, runs a Codex turn with high reasoning effort, then reads the buffer and asserts that both the response span and turn span contain the expected token fields.

**Call relations**: The test runner calls this. It sets up its own tracing capture instead of relying on the default traced test helper so it can inspect full span-close output.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 12 external calls (leak, new, default, new, new, from_utf8, new, assert!, wait_for_event, set_default (+2 more)).


##### `handle_responses_span_records_response_kind_and_tool_name`  (lines 686–760)

```
async fn handle_responses_span_records_response_kind_and_tool_name()
```

**Purpose**: Checks that response-handling spans say what kind of response item was processed and, for tool calls, which tool name was involved.

**Data flow**: It captures tracing output, serves a fake unsupported function call followed by completion, then serves a follow-up assistant message. After the turn, it looks for span lines showing a function_call with tool_name="nonexistent" and a completed response span.

**Call relations**: The test runner calls this. It exercises the response handler’s metadata recording for function-call items and completion items.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 12 external calls (leak, new, default, new, new, from_utf8, new, assert!, wait_for_event, set_default (+2 more)).


##### `record_responses_sets_span_fields_for_response_events`  (lines 763–871)

```
async fn record_responses_sets_span_fields_for_response_events()
```

**Purpose**: Checks that many different streamed response event types set the expected span fields. This makes the tracing timeline readable when debugging detailed model streams.

**Data flow**: It captures tracing output, builds one SSE stream containing created, added item, message, reasoning, text delta, function call, and completed events, then runs a user turn. It loops over expected span names and checks that each appears with the right source and tool metadata when applicable.

**Call relations**: The test runner calls this. It uses mounted HTTP responses rather than the simpler SSE helper so it can test a richer sequence of streamed events.

*Call graph*: calls 5 internal fn (mount_response_once, sse, sse_response, start_mock_server, test_codex); 13 external calls (leak, new, default, new, new, from_utf8, new, assert!, wait_for_event, format! (+3 more)).


##### `handle_response_item_records_tool_result_for_custom_tool_call`  (lines 875–950)

```
async fn handle_response_item_records_tool_result_for_custom_tool_call()
```

**Purpose**: Checks that an unsupported custom tool call is reported as a failed tool result with useful details.

**Data flow**: It serves a custom tool call named unsupported_tool, then a follow-up assistant response. After the turn completes, it finds the codex.tool_result line and checks call id, tool name, arguments, failure output, success=false, and empty MCP fields.

**Call relations**: The test runner calls this. It uses assert_empty_mcp_tool_fields to verify that local unsupported custom tools are not labeled as MCP tools.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `handle_response_item_records_tool_result_for_function_call`  (lines 954–1026)

```
async fn handle_response_item_records_tool_result_for_function_call()
```

**Purpose**: Checks that an unsupported normal function call is reported as a failed tool result.

**Data flow**: It serves a function call named nonexistent, then a follow-up assistant response. Once Codex reaches token-count reporting, it checks the tool-result log for the call id, tool name, arguments, failure text, success=false, and empty MCP fields.

**Call relations**: The test runner calls this. It follows the function-call handling path and then reuses assert_empty_mcp_tool_fields for the MCP-related checks.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `handle_response_item_records_tool_result_for_shell_command_call`  (lines 1030–1104)

```
async fn handle_response_item_records_tool_result_for_shell_command_call()
```

**Purpose**: Checks that a shell command tool call produces a tool-result telemetry event, even when the command result is not successful.

**Data flow**: It serves a shell_command call for "echo shell", configures approval so no user prompt is needed, and serves a follow-up assistant response. After the turn, it checks the tool-result log for the tool name, command arguments, non-empty output, success=false, and empty MCP fields.

**Call relations**: The test runner calls this. It uses shell_command_call to create the fake model request and assert_empty_mcp_tool_fields to confirm local-tool labeling.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (default, wait_for_event, vec!).


##### `tool_decision_assertion`  (lines 1106–1136)

```
fn tool_decision_assertion(
    call_id: &'a str,
    expected_decision: &'a str,
    expected_source: &'a str,
) -> impl Fn(&[&str]) -> Result<(), String> + 'a
```

**Purpose**: Builds a reusable log-checking function for shell command approval decisions. The generated checker looks for one call id, one expected decision, and one expected decision source.

**Data flow**: It receives the expected call id, decision, and source, stores them in owned strings, and returns a closure. When that closure later receives log lines, it finds the matching codex.tool_decision event and checks the tool name, decision, and source.

**Call relations**: Shell approval tests call this helper when passing a log assertion. It keeps all tool-decision log checks consistent across config approval, user approval, session approval, and denial cases.

*Call graph*: called by 7 (handle_sandbox_error_user_approves_for_session_records_tool_decision, handle_sandbox_error_user_approves_retry_records_tool_decision, handle_sandbox_error_user_denies_records_tool_decision, handle_shell_command_autoapprove_from_config_records_tool_decision, handle_shell_command_user_approved_for_session_records_tool_decision, handle_shell_command_user_approved_records_tool_decision, handle_shell_command_user_denies_records_tool_decision).


##### `sandbox_outcome_assertion`  (lines 1138–1170)

```
fn sandbox_outcome_assertion(
    call_id: &'a str,
    expected_outcome: &'a str,
) -> impl Fn(&[&str]) -> Result<(), String> + 'a
```

**Purpose**: Builds a reusable log-checking function for sandbox outcome telemetry. A sandbox is a restricted environment used to run commands more safely.

**Data flow**: It receives a call id and expected outcome, stores them, and returns a closure. When given log lines, the closure finds the matching codex.sandbox_outcome event and checks the tool name, outcome, and recorded durations.

**Call relations**: sandbox_outcome_event_records_outcome calls this helper to verify the telemetry emitted directly by SessionTelemetry.

*Call graph*: called by 1 (sandbox_outcome_event_records_outcome).


##### `sandbox_outcome_event_records_outcome`  (lines 1174–1200)

```
fn sandbox_outcome_event_records_outcome()
```

**Purpose**: Checks that SessionTelemetry writes a sandbox outcome event with the expected outcome and timing fields.

**Data flow**: It creates a SessionTelemetry object for a fake session, records a sandbox outcome for a shell command with initial and escalated durations, and then checks the captured logs using sandbox_outcome_assertion.

**Call relations**: The test runner calls this. Unlike the longer Codex turn tests, it calls the telemetry object directly to focus only on sandbox outcome logging.

*Call graph*: calls 3 internal fn (sandbox_outcome_assertion, new, new); 1 external calls (from_millis).


##### `handle_shell_command_autoapprove_from_config_records_tool_decision`  (lines 1204–1257)

```
async fn handle_shell_command_autoapprove_from_config_records_tool_decision()
```

**Purpose**: Checks that when configuration automatically allows a shell command, telemetry records the decision as approved by config.

**Data flow**: It serves a shell command call, configures permissions so the command can be approved without asking the user, runs a user turn, waits for completion, and checks for a codex.tool_decision event with decision approved and source config.

**Call relations**: The test runner calls this. It uses shell_command_call to create the request and tool_decision_assertion to inspect the resulting log.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion); 3 external calls (default, wait_for_event, vec!).


##### `handle_shell_command_user_approved_records_tool_decision`  (lines 1261–1327)

```
async fn handle_shell_command_user_approved_records_tool_decision()
```

**Purpose**: Checks that when the user approves a shell command once, telemetry records an approved decision from the user.

**Data flow**: It creates a platform-specific file-touch command, serves it as a shell call, submits user input, waits for an execution approval request, sends back an Approved decision, and then checks logs for the approved user decision.

**Call relations**: The test runner calls this. It uses touch_command to build the command and tool_decision_assertion to verify the approval record.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_shell_command_user_approved_for_session_records_tool_decision`  (lines 1331–1397)

```
async fn handle_shell_command_user_approved_for_session_records_tool_decision()
```

**Purpose**: Checks that when the user approves a shell command for the whole session, telemetry records that stronger approval choice.

**Data flow**: It serves a shell command call, waits for Codex to ask for approval, submits an ApprovedForSession decision, waits for progress, and checks that the tool-decision log says approvedforsession from user.

**Call relations**: The test runner calls this. It follows the same approval-request path as the one-time approval test, but with a session-wide decision.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_sandbox_error_user_approves_retry_records_tool_decision`  (lines 1401–1467)

```
async fn handle_sandbox_error_user_approves_retry_records_tool_decision()
```

**Purpose**: Checks that when a command needs a retry after sandbox trouble and the user approves, telemetry records that approval.

**Data flow**: It serves a shell command call that triggers the approval flow, submits user input, waits for the approval request, sends an Approved decision, then checks the tool-decision log for approved from user.

**Call relations**: The test runner calls this. It uses the same helper pattern as other approval tests so sandbox-retry approvals are logged consistently.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_shell_command_user_denies_records_tool_decision`  (lines 1471–1537)

```
async fn handle_shell_command_user_denies_records_tool_decision()
```

**Purpose**: Checks that when the user denies a shell command, telemetry records a denied decision from the user.

**Data flow**: It serves a shell command call, waits for Codex to ask for approval, sends a Denied decision, waits for progress, and checks that the tool-decision log says denied from user.

**Call relations**: The test runner calls this. It covers the negative branch of the user approval flow and uses tool_decision_assertion for the final log check.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_sandbox_error_user_approves_for_session_records_tool_decision`  (lines 1541–1607)

```
async fn handle_sandbox_error_user_approves_for_session_records_tool_decision()
```

**Purpose**: Checks that session-wide approval during a sandbox-related retry path is logged as approved for session by the user.

**Data flow**: It creates a platform-appropriate touch command, serves it as a shell call, waits for an approval request, submits ApprovedForSession, then checks logs for the matching decision and source.

**Call relations**: The test runner calls this. It combines the sandbox retry scenario with the session-wide user approval decision.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


##### `handle_sandbox_error_user_denies_records_tool_decision`  (lines 1611–1678)

```
async fn handle_sandbox_error_user_denies_records_tool_decision()
```

**Purpose**: Checks that denial during a sandbox-related command flow is logged as a user denial.

**Data flow**: It serves a shell command call, waits for the execution approval request, sends Denied, waits for progress, and checks logs for a codex.tool_decision event showing denied from user.

**Call relations**: The test runner calls this. It completes the matrix of sandbox-related approval outcomes by covering the denial case.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, tool_decision_assertion, touch_command); 4 external calls (default, wait_for_event, panic!, vec!).


### `state/src/log_db_filter_tests.rs`

`test` · `test run`

This test checks an important cleanup rule for the project’s saved logs. The system records tracing logs into a SQLite database, but one outside library, OpenTelemetry SDK, can produce very detailed low-level messages. Those messages are useful when debugging the library itself, but they would clutter the application’s own log history if saved at every level.

The test creates a temporary state directory, starts a real StateRuntime, attaches the database logging layer, and then emits four log messages. Two are low-level messages from the OpenTelemetry SDK and should be dropped. One is a higher-level OpenTelemetry message and should stay. One is a low-level message from this project’s own state code and should also stay.

After forcing the logging layer to flush, the test reads the saved logs back from the runtime and compares them with the exact expected result. This is like checking a mailroom rule: junk mail from one sender at certain priority levels is thrown away, but important mail from that sender and all project mail still reaches the inbox. Finally, it removes the temporary directory so the test does not leave files behind.

#### Function details

##### `sqlite_sink_drops_low_level_opentelemetry_sdk_logs`  (lines 10–53)

```
async fn sqlite_sink_drops_low_level_opentelemetry_sdk_logs()
```

**Purpose**: This asynchronous test proves that the SQLite log sink filters out OpenTelemetry SDK trace and debug logs, while keeping OpenTelemetry info logs and this project’s own trace logs. Someone would use this test to make sure the saved log history stays useful instead of being flooded by noisy library internals.

**Data flow**: It starts with a fresh temporary folder and a test provider name, then builds a StateRuntime that writes state and logs there. It installs the logging layer, emits several log events with different sources and levels, flushes pending log writes, and queries the stored log rows. The output is not returned to a caller; instead, the test passes only if the database contains exactly the two expected retained log entries, and then it deletes the temporary folder.

**Call relations**: The Tokio test runner calls this function as part of the test suite. Inside the test, it relies on runtime initialization to create the state database, uses the log layer startup path to connect tracing events to SQLite storage, then calls the runtime’s log query path to verify what was actually saved. The final assertion ties the whole flow together by confirming that the filtering rule worked end to end.

*Call graph*: calls 1 internal fn (init); 10 external calls (new, assert_eq!, format!, default, temp_dir, remove_dir_all, debug!, info!, trace!, registry).
