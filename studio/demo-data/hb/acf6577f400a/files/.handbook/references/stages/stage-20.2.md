# OpenTelemetry runtime, provider, and metrics foundations  `stage-20.2`

This stage is shared behind-the-scenes support, used mostly during startup and then throughout the main work loop. It sets up observability: traces, metrics, and logs that help operators see what the program is doing. The core OpenTelemetry config cleans user settings, adds safe defaults, and rejects bad trace labels. The init code then turns those settings into a running setup. The otel crate config decides whether telemetry is enabled and where it goes, while its lib file exposes the pieces. The provider builds the real exporters, filters, global hooks, and shutdown path. The OTLP transport prepares HTTP or gRPC clients, certificates, headers, and timeouts. Targets decide which events may become logs or traces, and trace context carries a work ID across services. Metrics files define errors, names, config, safe tags, validation, the shared client, timers, one-time process-start reporting, and readable runtime summaries. Event helpers add consistent details like time, version, model, and session. Finally, Codex client and API telemetry hooks measure request attempts, retries, streaming, and WebSocket activity without mixing that reporting code into the networking logic.

## Files in this stage

### Runtime configuration bridge
These files sanitize user-facing OTEL settings and translate them into the concrete runtime provider configuration used during startup.

### `core/src/config/otel.rs`

`config` · `config load and startup`

OpenTelemetry is a standard way for software to report logs, traces, and metrics so operators can understand what the program is doing. This file sits between the raw configuration a user can edit and the stricter runtime setup code that installs OpenTelemetry for the whole process. That matters because a small typo in tracing metadata should not stop the program from starting.

The main flow starts with `resolve_config`. It reads optional settings from the TOML config, chooses safe defaults when settings are missing, and builds an `OtelConfig` value for the rest of the system. Some fields are simple switches, such as whether to log the user prompt. Others choose where logs, traces, or metrics should be exported.

The careful part is validation. User-provided span attributes and tracestate entries are checked before they reach OpenTelemetry initialization. A span attribute is extra label data attached to a trace span. A tracestate is standardized trace-routing metadata passed between services. Think of this file as a customs checkpoint: valid items pass through, invalid ones are left behind with a warning.

Instead of failing startup, invalid pieces are ignored. The warning is both written to the log and saved in the startup warnings list, so the user can be told what was wrong.

#### Function details

##### `resolve_config`  (lines 9–37)

```
fn resolve_config(
    config: OtelConfigToml,
    startup_warnings: &mut Vec<String>,
) -> OtelConfig
```

**Purpose**: Builds the final OpenTelemetry configuration from the user-editable TOML settings. It chooses defaults for missing values and makes sure user-provided trace metadata is safe before the global telemetry system is initialized.

**Data flow**: It receives an `OtelConfigToml` object and a mutable list of startup warnings. It reads each optional setting, substitutes defaults where needed, sends span attributes and tracestate data through validation helpers, and returns an `OtelConfig` containing only the settings the program should actually use. The warning list may gain messages about ignored invalid config.

**Call relations**: This is called during the broader configuration load by `load_config_with_layer_stack`. As part of building the final config, it asks `resolve_span_attributes` and `resolve_tracestate` to clean the user-supplied tracing metadata before handing the finished `OtelConfig` back to startup code.

*Call graph*: calls 2 internal fn (resolve_span_attributes, resolve_tracestate); called by 1 (load_config_with_layer_stack).


##### `resolve_span_attributes`  (lines 39–58)

```
fn resolve_span_attributes(
    span_attributes: Option<BTreeMap<String, String>>,
    startup_warnings: &mut Vec<String>,
) -> BTreeMap<String, String>
```

**Purpose**: Filters the user’s OpenTelemetry span attributes so only valid labels are kept. This prevents malformed labels from breaking telemetry initialization.

**Data flow**: It receives an optional map of span attribute names to values and the startup warning list. If no attributes were configured, it returns an empty map. If attributes exist, it checks each key-value pair with the OpenTelemetry validation code, keeps the valid pairs, and records a warning for each invalid one. The result is a cleaned map of attributes.

**Call relations**: It is called by `resolve_config` while building the final telemetry settings. When it finds bad input, it delegates warning creation to `push_invalid_config_warning`; otherwise, valid attributes flow back into the returned `OtelConfig`.

*Call graph*: calls 1 internal fn (push_invalid_config_warning); called by 1 (resolve_config); 3 external calls (from, new, validate_span_attributes).


##### `resolve_tracestate`  (lines 60–90)

```
fn resolve_tracestate(
    tracestate: Option<BTreeMap<String, BTreeMap<String, String>>>,
    startup_warnings: &mut Vec<String>,
) -> BTreeMap<String, BTreeMap<String, String>>
```

**Purpose**: Cleans and validates the configured tracestate, which is trace metadata shared across systems using the W3C tracing standard. It protects startup from bad tracestate settings by dropping invalid parts and warning the user.

**Data flow**: It receives an optional nested map: each tracestate member has a member key and a set of field key-value pairs. If none is configured, it returns an empty map. For each member, it first cleans that member’s fields, skips members left with no valid fields, validates each remaining member, then validates the combined tracestate as a whole. If the combined result is invalid, it warns and returns an empty map; otherwise it returns the cleaned tracestate.

**Call relations**: It is called by `resolve_config` as part of preparing final OpenTelemetry settings. It relies on `resolve_tracestate_member_fields` to clean each member’s inner fields, and uses `push_invalid_config_warning` whenever a member or the final combined tracestate cannot be accepted.

*Call graph*: calls 2 internal fn (push_invalid_config_warning, resolve_tracestate_member_fields); called by 1 (resolve_config); 3 external calls (new, validate_tracestate_entries, validate_tracestate_member).


##### `resolve_tracestate_member_fields`  (lines 92–107)

```
fn resolve_tracestate_member_fields(
    member_key: &str,
    fields: BTreeMap<String, String>,
    startup_warnings: &mut Vec<String>,
) -> BTreeMap<String, String>
```

**Purpose**: Checks the individual fields inside one tracestate member and keeps only the valid ones. This lets one bad field be ignored without automatically throwing away the whole member.

**Data flow**: It receives the tracestate member key, that member’s field map, and the startup warning list. It tests each field by temporarily validating it as part of that member. Valid fields are copied into a new map; invalid fields are skipped and produce warning messages. It returns the cleaned field map for that member.

**Call relations**: It is called by `resolve_tracestate` while walking through each configured tracestate member. When it detects an invalid field, it calls `push_invalid_config_warning`; the cleaned fields are then passed back so `resolve_tracestate` can decide whether the member and the whole tracestate are valid.

*Call graph*: calls 1 internal fn (push_invalid_config_warning); called by 1 (resolve_tracestate); 3 external calls (from, new, validate_tracestate_member).


##### `push_invalid_config_warning`  (lines 109–117)

```
fn push_invalid_config_warning(
    config_key: &str,
    err: impl Display,
    startup_warnings: &mut Vec<String>,
)
```

**Purpose**: Creates a clear warning message for invalid OpenTelemetry configuration and records it in two places. It logs the warning immediately and also stores it so startup reporting can show it later.

**Data flow**: It receives the config key that was invalid, the validation error, and the startup warning list. It formats those into a message like “Ignoring invalid `...` config: ...”, writes that message through the tracing log system, and appends the same text to the warning list. It does not return a value; its effect is the recorded warning.

**Call relations**: This helper is used by all validation paths in this file: span attributes, tracestate members, tracestate fields, and the final combined tracestate. It keeps warning behavior consistent, so each caller can focus on deciding what is invalid while this function handles how the user is told.

*Call graph*: called by 3 (resolve_span_attributes, resolve_tracestate, resolve_tracestate_member_fields); 2 external calls (format!, warn!).


### `core/src/otel_init.rs`

`orchestration` · `startup and telemetry setup`

This file is the bridge between Codex's own configuration format and the telemetry library that actually records and exports data. Without it, the app might still run, but it would not know where to send monitoring data, which signals to send, or whether telemetry should be disabled.

The main job is to read the user's config and build an OtelProvider, which is the object other parts of the app use to produce telemetry. It translates config choices like "send nothing," "send to Statsig," "send over OTLP HTTP," or "send over OTLP gRPC" into the matching telemetry exporter. OTLP means OpenTelemetry Protocol, a standard way to send telemetry data. For HTTP exporters, it also converts the selected body format, either JSON text or binary data.

The file also respects privacy and feature choices. Metrics are only enabled if analytics are allowed, and runtime metrics are only enabled when the matching feature flag is on. It sets a service name, version, environment, span attributes, and trace state so exported data can be identified later.

Finally, it contains small helper functions that record process-start metrics and connect SQLite database telemetry. These helpers quietly do nothing when telemetry metrics are unavailable, which keeps the rest of the app from needing repeated safety checks.

#### Function details

##### `build_provider`  (lines 16–95)

```
fn build_provider(
    config: &Config,
    service_version: &str,
    service_name_override: Option<&str>,
    default_analytics_enabled: bool,
) -> Result<Option<OtelProvider>, Box<dyn Error>>
```

**Purpose**: This function builds the app's OpenTelemetry provider from the main configuration. It decides whether telemetry is off, where telemetry should be sent, what service name to use, and whether metrics are allowed.

**Data flow**: It receives the app config, the service version, an optional replacement service name, and the default analytics setting. It reads the telemetry exporter settings, trace exporter settings, metric exporter settings, TLS certificate settings, feature flags, home directory, environment, span attributes, and trace state. It converts those config values into OtelSettings and asks the telemetry library to create an OtelProvider. The result is either a ready-to-use provider, no provider when exporting is disabled, or an error if setup fails.

**Call relations**: Startup paths such as initialize, run_main_with_transport_options, and run_main call this when the program is preparing telemetry. Tests also call it to check default analytics behavior and provider construction. Inside, it asks originator for the default service identity, then hands the completed settings to OtelProvider::from, which performs the actual provider creation.

*Call graph*: calls 2 internal fn (originator, from); called by 6 (initialize, run_main_with_transport_options, app_server_default_analytics_disabled_without_flag, app_server_default_analytics_enabled_with_flag, run_main, mcp_server_builds_otel_provider_with_logs_traces_and_metrics).


##### `codex_export_filter`  (lines 99–101)

```
fn codex_export_filter(meta: &tracing::Metadata<'_>) -> bool
```

**Purpose**: This function answers a simple question: should this tracing event be exported through Codex's OpenTelemetry path? It keeps only events whose source name starts with codex_otel, so unrelated internal events are not sent through this filter.

**Data flow**: It receives tracing metadata, which is descriptive information attached to a log or tracing event. It reads the event target, meaning the named source of the event, and checks whether that target begins with codex_otel. It returns true for matching events and false for everything else.

**Call relations**: This is meant to be used as a filter when telemetry exporting is installed. It calls the metadata target accessor to inspect the event source, then returns the yes-or-no decision to the tracing system.

*Call graph*: 1 external calls (target).


##### `record_process_start`  (lines 103–108)

```
fn record_process_start(otel: Option<&OtelProvider>, originator: &str)
```

**Purpose**: This function records a one-time metric saying that the process has started. It is safe to call even when telemetry is disabled, because it simply returns without doing anything if metrics are unavailable.

**Data flow**: It receives an optional telemetry provider and an originator string that identifies which Codex-originated program or mode is starting. It tries to get the metrics component from the provider. If metrics exist, it asks the telemetry library to record the process-start metric once. If there is no provider or no metrics support, nothing changes.

**Call relations**: Main startup flows such as run_main_with_transport_options and run_main call this after telemetry has been built. It hands the actual recording work to codex_otel::record_process_start_once so this file stays focused on wiring startup telemetry together.

*Call graph*: called by 3 (run_main_with_transport_options, run_main, run_main); 1 external calls (record_process_start_once).


##### `install_sqlite_telemetry`  (lines 110–116)

```
fn install_sqlite_telemetry(otel: Option<&OtelProvider>, originator: &str)
```

**Purpose**: This function connects SQLite database activity to the app's telemetry metrics. SQLite is the embedded database used by the app, and this hook lets database behavior be reported through the same monitoring pipeline.

**Data flow**: It receives an optional telemetry provider and an originator string. It looks for the provider's metrics component. If metrics are present, it creates a SQLite telemetry recorder tied to those metrics and the originator, then installs that recorder into the process database layer. If metrics are missing, it exits without changing anything.

**Call relations**: Startup flows such as run_main_with_transport_options and run_main call this when setting up process-wide telemetry. It asks codex_rollout to build the SQLite telemetry recorder, then passes that recorder to codex_state so the database layer can use it during later database operations.

*Call graph*: called by 3 (run_main_with_transport_options, run_main, run_main); 2 external calls (sqlite_telemetry_recorder, install_process_db_telemetry).


### Provider and crate surface
These files define the OTEL crate’s public integration boundary and construct the process-wide tracing, logging, and metrics providers from resolved settings.

### `otel/src/config.rs`

`config` · `config load and telemetry setup`

This file is the configuration vocabulary for the project's OpenTelemetry support. OpenTelemetry is a standard way to collect traces and metrics, which are records of what the program is doing and how it is performing. Without this file, the rest of the telemetry code would not have a shared, clear way to describe exporters, service names, runtime metric choices, extra span labels, or secure connection settings.

The main idea is simple: other parts of the system ask, “Given these telemetry settings, where should we send data?” The `OtelExporter` enum answers that with choices such as sending nothing, using a built-in Statsig metrics destination, sending over OTLP gRPC, or sending over OTLP HTTP. OTLP means “OpenTelemetry Protocol,” the standard wire format for telemetry data.

A special detail is the built-in Statsig exporter. In release builds it expands into a concrete HTTP exporter with a fixed endpoint, API key header, and JSON protocol. In debug builds, it becomes `None`, like unplugging the phone line during local work, so tests and everyday development do not quietly emit telemetry traffic.

The file also defines `OtelSettings`, the larger bundle of telemetry options, `OtelTlsConfig` for certificate-based secure connections, and a small validation step that rejects empty span attribute keys before they are attached to exported spans.

#### Function details

##### `resolve_exporter`  (lines 13–36)

```
fn resolve_exporter(exporter: &OtelExporter) -> OtelExporter
```

**Purpose**: This function turns a high-level exporter choice into the concrete exporter configuration the telemetry system should actually use. Its most important job is resolving the built-in Statsig option, while leaving other exporter choices unchanged.

**Data flow**: It receives an `OtelExporter` value. If that value is `Statsig`, it checks whether this is a debug build; in debug builds it returns `None`, and in non-debug builds it returns an OTLP HTTP exporter filled with the built-in Statsig endpoint, API key header, JSON protocol, and no custom TLS settings. For any other exporter, it returns a clone of the original choice.

**Call relations**: Telemetry setup code calls this when building metric exporters, loggers, and tracer providers, and also when converting broader configuration into OpenTelemetry settings. It acts as the translation point between a convenient named option, like `Statsig`, and the lower-level exporter details that the rest of the telemetry pipeline needs.

*Call graph*: called by 4 (build_otlp_metric_exporter, from, build_logger, build_tracer_provider); 3 external calls (from, cfg!, clone).


##### `validate_span_attributes`  (lines 39–48)

```
fn validate_span_attributes(attributes: &BTreeMap<String, String>) -> std::io::Result<()>
```

**Purpose**: This function checks user-configured span attributes before they are used. A span is one recorded unit of work in a trace, and attributes are key-value labels attached to it; this function makes sure none of the label names are empty.

**Data flow**: It receives a sorted map of attribute names to attribute values. It looks through the keys, and if any key is an empty string, it returns an input error explaining the problem. If every key has a name, it returns success and does not change the map.

**Call relations**: Configuration conversion code calls this before accepting span attributes into the telemetry settings. It is a small guardrail near the configuration boundary, so invalid labels are rejected early instead of reaching the exporter and causing confusing behavior later.

*Call graph*: called by 1 (from); 1 external calls (new).


##### `tests::statsig_default_metrics_exporter_is_disabled_in_debug_builds`  (lines 113–118)

```
fn statsig_default_metrics_exporter_is_disabled_in_debug_builds()
```

**Purpose**: This test confirms that the built-in Statsig exporter does not send telemetry during debug builds. It protects the local-development safety behavior from being accidentally changed.

**Data flow**: It creates the `Statsig` exporter choice, passes it through `resolve_exporter`, and checks that the result is `None`. The output is not a value used elsewhere; the test either passes or fails.

**Call relations**: The test exercises `resolve_exporter` directly. It documents and verifies the expectation that debug builds disable the built-in Statsig default, which matters because several telemetry builders rely on `resolve_exporter` when deciding what to activate.

*Call graph*: 1 external calls (assert!).


### `otel/src/lib.rs`

`other` · `cross-cutting`

Telemetry is the project’s way of recording what happened: timings, counters, trace IDs, session facts, and exporter settings. This file acts like a reception desk for that telemetry system. It declares the internal modules, then re-exports the useful public items so other crates can import them from one predictable place.

It also defines two small shared enums. `ToolDecisionSource` records where a tool-related decision came from, such as a user, configuration, or automated reviewer. `TelemetryAuthMode` is a simplified authentication label used by telemetry. It deliberately maps several detailed app authentication modes into just two telemetry categories, `ApiKey` and `Chatgpt`, so this crate does not need to depend on the deeper core authentication code. That avoids a circular dependency, where two parts of the program would need to build on each other at the same time.

Finally, this file provides convenience functions for global metrics. One starts a timer using the metrics client that has already been installed for the process. The other asks whether the current global metrics exporter is Statsig and, if so, returns its resolved settings. If telemetry is not enabled, timer creation returns an error instead of silently pretending to measure something.

#### Function details

##### `TelemetryAuthMode::from`  (lines 55–64)

```
fn from(mode: codex_app_server_protocol::AuthMode) -> Self
```

**Purpose**: This converts the app server’s detailed authentication modes into the simpler categories used in telemetry. It lets telemetry talk about login style without importing the full core authentication layer.

**Data flow**: It receives an `AuthMode` value from the app server protocol. It checks which kind it is, groups API-key-like modes as `ApiKey`, and groups ChatGPT, token, agent identity, and personal access token modes as `Chatgpt`. It returns the matching `TelemetryAuthMode` and does not change anything else.

**Call relations**: This is used whenever telemetry needs an authentication label based on the app server protocol’s auth mode. It stands between the detailed protocol type and the telemetry type, keeping the telemetry crate independent from heavier core code.


##### `start_global_timer`  (lines 68–73)

```
fn start_global_timer(name: &str, tags: &[(&str, &str)]) -> MetricsResult<Timer>
```

**Purpose**: This starts a named metrics timer using the process-wide metrics client. A caller uses it when they want to measure how long some work takes without manually passing a metrics client around.

**Data flow**: It receives a timer name and a list of tag key-value pairs, which are extra labels attached to the measurement. It asks the metrics module for the globally installed metrics client. If there is no global client, it returns an `ExporterDisabled` error; otherwise, it asks that client to start the timer and returns the resulting `Timer`.

**Call relations**: This function is a convenience wrapper around the metrics system’s `global` lookup. Callers come here when they want timing to be tied to the already configured global telemetry setup, and this function hands the actual timer creation to the global metrics client.

*Call graph*: calls 1 internal fn (global).


##### `global_statsig_metrics_settings`  (lines 77–79)

```
fn global_statsig_metrics_settings() -> Option<StatsigMetricsSettings>
```

**Purpose**: This reports the active Statsig metrics settings, but only when the global metrics exporter is actually Statsig. It gives callers a safe way to inspect the resolved Statsig configuration without assuming that Statsig is in use.

**Data flow**: It takes no input. It asks the metrics module for the global Statsig settings. If the current global metrics setup uses Statsig, it returns those settings; otherwise, it returns nothing.

**Call relations**: This function is a small public shortcut to `global_statsig_settings`. Callers use it after telemetry has been configured, and it delegates the real check to the metrics module that knows which exporter is active.

*Call graph*: calls 1 internal fn (global_statsig_settings).


### `otel/src/provider.rs`

`orchestration` · `startup, cross-cutting telemetry export, and teardown`

OpenTelemetry is a standard way for software to report what it is doing: logs for events, traces for request journeys, and metrics for counts and timings. This file acts like the control panel for that reporting. Given the user's telemetry settings, it decides which parts are enabled, validates sensitive trace-related metadata before changing any process-wide state, builds the right exporters, and installs global hooks so the rest of the program can record telemetry without knowing where it will be sent.

The main type, OtelProvider, holds the live logger provider, tracer provider, tracer, and metrics client. If nothing is enabled, it clears trace-state settings and returns no provider. If telemetry is enabled, it creates resources that label the service with its name, version, environment, and, for logs, the host name. It then builds log and trace exporters for OTLP, the OpenTelemetry wire protocol, over either gRPC or HTTP. Metrics are built through the project's MetricsClient.

The file also protects against accidental data leakage. Log export and trace export use separate filters, so only approved tracing targets go into traces. Finally, it flushes and shuts down telemetry clients both when asked explicitly and when the provider is dropped, so queued telemetry is not silently lost at exit.

#### Function details

##### `OtelProvider::shutdown`  (lines 64–75)

```
fn shutdown(&self)
```

**Purpose**: Flushes and closes any telemetry pieces owned by the provider. This is used when the program wants to end cleanly and give queued logs, traces, and metrics a chance to be sent.

**Data flow**: It reads the provider's optional tracer, metrics, and logger fields. For each one that exists, it asks it to flush or shut down, ignoring individual shutdown errors. Nothing is returned; the main change is that the telemetry backends are told to finish their work.

**Call relations**: This is the explicit cleanup path for the objects created by OtelProvider::from. It mirrors the automatic cleanup in OtelProvider::drop, so callers can choose to shut telemetry down at a known point instead of waiting for Rust to drop the provider.


##### `OtelProvider::from`  (lines 77–154)

```
fn from(settings: &OtelSettings) -> Result<Option<Self>, Box<dyn Error>>
```

**Purpose**: Creates an OtelProvider from the program's telemetry settings. It decides whether logs, traces, and metrics are enabled, builds the needed clients, and installs global OpenTelemetry state used by the rest of the process.

**Data flow**: It takes OtelSettings as input. It reads exporter choices, service identity, environment, span attributes, trace-state entries, and runtime metrics settings. If all telemetry is disabled, it clears configured trace-state entries and returns None. Otherwise it validates trace metadata, builds metrics if requested, creates log and trace resources, builds logger and tracer providers, installs global tracing and metrics hooks when present, and returns a populated OtelProvider.

**Call relations**: Higher-level setup code such as build_provider and test flows call this when they need telemetry. Inside, it hands off to make_resource for service labels, build_logger for log export, build_tracer_provider for trace export, MetricsClient::new for metrics, and trace-context helpers for global trace-state propagation.

*Call graph*: calls 9 internal fn (resolve_exporter, validate_span_attributes, new, otlp, install_global, install_global_statsig_settings, make_resource, set_tracestate_entries, validate_tracestate_entries); called by 6 (build_provider, otel_provider_rejects_header_unsafe_configured_tracestate, otlp_http_exporter_sends_logs_to_collector, otlp_http_exporter_sends_traces_to_collector, otlp_http_exporter_sends_traces_to_collector_in_tokio_runtime, build_wfp_metrics_provider); 6 external calls (new, new, debug!, set_text_map_propagator, set_tracer_provider, matches!).


##### `OtelProvider::logger_layer`  (lines 156–165)

```
fn logger_layer(&self) -> Option<impl Layer<S> + Send + Sync>
```

**Purpose**: Creates a tracing-subscriber layer that forwards approved Rust tracing events as OpenTelemetry logs. A layer is like an add-on plugged into the logging system.

**Data flow**: It reads the provider's logger field. If there is no logger, it returns None. If a logger exists, it wraps it in an OpenTelemetry bridge and attaches a filter so only log-safe targets are exported.

**Call relations**: This is used after OtelProvider::from has built a logger provider. It relies on OtelProvider::log_export_filter to decide which events should leave the process as logs.


##### `OtelProvider::tracing_layer`  (lines 167–178)

```
fn tracing_layer(&self) -> Option<impl Layer<S> + Send + Sync>
```

**Purpose**: Creates a tracing-subscriber layer that forwards approved spans and events as OpenTelemetry traces. A trace records how work moves through the program over time.

**Data flow**: It reads the provider's tracer field. If there is no tracer, it returns None. If a tracer exists, it builds a tracing-opentelemetry layer with that tracer and attaches a filter that allows spans and trace-safe targets.

**Call relations**: This is used by logging/tracing setup after OtelProvider::from has created a tracer. It depends on OtelProvider::trace_export_filter to keep trace export limited to safe data.


##### `OtelProvider::codex_export_filter`  (lines 180–182)

```
fn codex_export_filter(meta: &tracing::Metadata<'_>) -> bool
```

**Purpose**: Provides a compatibility filter for deciding whether a tracing event should be exported as a Codex/OpenTelemetry log. It simply follows the same rule as the normal log export filter.

**Data flow**: It receives tracing metadata, which includes details like the event's target. It passes that metadata to the log export filter and returns the resulting true-or-false decision.

**Call relations**: This is a small wrapper around OtelProvider::log_export_filter. It exists so other parts of the system can use a named Codex export filter while sharing the same underlying log decision.

*Call graph*: 1 external calls (log_export_filter).


##### `OtelProvider::log_export_filter`  (lines 184–186)

```
fn log_export_filter(meta: &tracing::Metadata<'_>) -> bool
```

**Purpose**: Decides whether a tracing event is allowed to be exported as a log. This helps avoid sending trace-only or sensitive targets through the log exporter.

**Data flow**: It receives tracing metadata, reads the target name from it, and asks is_log_export_target whether that target is log-safe. It returns true for export and false for exclusion.

**Call relations**: OtelProvider::logger_layer uses this as the gate in front of the OpenTelemetry log bridge. OtelProvider::codex_export_filter also delegates to it.

*Call graph*: calls 1 internal fn (is_log_export_target); 1 external calls (target).


##### `OtelProvider::trace_export_filter`  (lines 188–190)

```
fn trace_export_filter(meta: &tracing::Metadata<'_>) -> bool
```

**Purpose**: Decides whether tracing metadata is allowed into exported traces. It always allows spans themselves, and only allows events from targets marked as trace-safe.

**Data flow**: It receives tracing metadata. It checks whether the metadata represents a span; if so, it allows it. Otherwise it reads the target name and asks is_trace_safe_target whether that event is safe for trace export. It returns a true-or-false decision.

**Call relations**: OtelProvider::tracing_layer installs this filter on the trace export path. It uses the target rules from the targets module to reduce the chance that unsafe log events are attached to traces.

*Call graph*: calls 1 internal fn (is_trace_safe_target); 2 external calls (is_span, target).


##### `OtelProvider::metrics`  (lines 192–194)

```
fn metrics(&self) -> Option<&MetricsClient>
```

**Purpose**: Gives callers access to the metrics client if metrics were enabled. This lets other parts of the system record measurements without owning the provider internals.

**Data flow**: It reads the provider's optional metrics field and returns a borrowed reference when one exists. It does not create, change, or shut down anything.

**Call relations**: The with_provider_metrics flow calls this when it wants to use the provider's metrics client. The client itself is created earlier by OtelProvider::from.

*Call graph*: called by 1 (with_provider_metrics).


##### `OtelProvider::drop`  (lines 198–209)

```
fn drop(&mut self)
```

**Purpose**: Automatically flushes and shuts down telemetry when the OtelProvider is destroyed. This is a safety net so telemetry clients are not left running or holding unsent data.

**Data flow**: When Rust drops the provider, this method checks for a tracer provider, metrics client, and logger provider. For each present piece, it asks it to flush or shut down and ignores individual errors. It returns nothing because it is part of object cleanup.

**Call relations**: This cleanup path covers the same resources that OtelProvider::from created. It complements OtelProvider::shutdown, which lets callers perform the same kind of cleanup explicitly.


##### `make_resource`  (lines 212–221)

```
fn make_resource(settings: &OtelSettings, kind: ResourceKind) -> Resource
```

**Purpose**: Builds the OpenTelemetry resource that labels telemetry with service information. A resource is like the return address on every log or trace, saying which service produced it.

**Data flow**: It receives OtelSettings and whether the resource is for logs or traces. It detects the host name, asks resource_attributes to create the label list, combines those labels with the service name, and returns a Resource object.

**Call relations**: OtelProvider::from calls this once for logs and once for traces. It hands work to detected_host_name and resource_attributes so build_logger and build_tracer_provider can receive already-labeled resources.

*Call graph*: calls 2 internal fn (detected_host_name, resource_attributes); called by 1 (from); 1 external calls (builder).


##### `resource_attributes`  (lines 223–241)

```
fn resource_attributes(
    settings: &OtelSettings,
    host_name: Option<&str>,
    kind: ResourceKind,
) -> Vec<KeyValue>
```

**Purpose**: Creates the list of labels attached to a telemetry resource. These labels include the service version and environment, and for logs only, a valid host name when available.

**Data flow**: It receives settings, an optional host name, and whether the labels are for logs or traces. It always creates service version and environment labels. If the kind is logs and the host name is present and not blank, it adds a host.name label. It returns the completed list of key-value labels.

**Call relations**: make_resource calls this during provider setup. The tests call it directly to check that host names are included only in the intended cases.

*Call graph*: called by 3 (make_resource, resource_attributes_include_host_name_when_present, resource_attributes_omit_host_name_when_missing_or_empty); 2 external calls (new, vec!).


##### `detected_host_name`  (lines 243–246)

```
fn detected_host_name() -> Option<String>
```

**Purpose**: Reads the machine's host name and turns it into a clean optional string. This lets log telemetry say which computer produced it when that information is available.

**Data flow**: It asks the operating system for the host name, converts it into text, and passes the text to normalize_host_name. It returns Some(name) for a non-empty name or None if the result is blank.

**Call relations**: make_resource calls this before building resource attributes. It delegates the cleanup rule to normalize_host_name so blank names are handled consistently.

*Call graph*: calls 1 internal fn (normalize_host_name); called by 1 (make_resource); 1 external calls (gethostname).


##### `normalize_host_name`  (lines 248–251)

```
fn normalize_host_name(host_name: &str) -> Option<String>
```

**Purpose**: Cleans up a host name and rejects empty values. This prevents telemetry from carrying meaningless host.name labels like spaces.

**Data flow**: It receives a host name string, trims whitespace from both ends, and checks whether anything remains. It returns the cleaned name when non-empty, or None when the input is empty after trimming.

**Call relations**: detected_host_name uses this after reading the operating system host name, and resource_attributes uses the same logic for host names passed in tests or by callers.

*Call graph*: called by 1 (detected_host_name).


##### `tracer_provider_builder`  (lines 253–265)

```
fn tracer_provider_builder(
    resource: &Resource,
    span_attributes: BTreeMap<String, String>,
) -> TracerProviderBuilder
```

**Purpose**: Starts building a trace provider and optionally adds a processor that stamps configured attributes onto every span. A span is one timed unit of work inside a trace.

**Data flow**: It receives a resource and a map of span attributes. It creates a tracer provider builder with the resource. If the attribute map is empty, it returns the plain builder. If attributes exist, it adds a SpanAttributesProcessor so future spans receive those labels.

**Call relations**: build_tracer_provider uses this after choosing the trace exporter and batch processor. It connects global service labels from the resource with per-span labels configured by the user.

*Call graph*: called by 1 (build_tracer_provider); 2 external calls (builder, clone).


##### `SpanAttributesProcessor::on_start`  (lines 277–281)

```
fn on_start(&self, span: &mut Span, _cx: &Context)
```

**Purpose**: Adds configured labels to each span when the span begins. This makes sure every exported span carries the user-requested extra metadata.

**Data flow**: It receives a mutable span and reads the processor's stored attribute map. For each key and value, it creates an OpenTelemetry key-value pair and sets it on the span. It does not return a value; it changes the span before export.

**Call relations**: This method is called by the OpenTelemetry tracing SDK because tracer_provider_builder registers SpanAttributesProcessor as a span processor. It runs at span start, before the span later reaches the exporter built by build_tracer_provider.

*Call graph*: 2 external calls (new, set_attribute).


##### `SpanAttributesProcessor::on_end`  (lines 283–283)

```
fn on_end(&self, _span: SpanData)
```

**Purpose**: Does nothing when a span ends. The processor only needs to add attributes at span start, so no end-of-span work is required.

**Data flow**: It receives completed span data and ignores it. No data is changed and nothing is returned.

**Call relations**: The OpenTelemetry SDK calls this as part of the SpanProcessor interface. It is intentionally empty because SpanAttributesProcessor's useful work happens in SpanAttributesProcessor::on_start.


##### `SpanAttributesProcessor::force_flush`  (lines 285–287)

```
fn force_flush(&self) -> OTelSdkResult
```

**Purpose**: Reports that this processor has nothing buffered to flush. It exists because every span processor must provide a flush method.

**Data flow**: It receives no extra input beyond the processor itself. Since the processor stores only static attributes and no queued spans, it immediately returns success.

**Call relations**: The OpenTelemetry SDK may call this when the tracer provider is flushed, such as during OtelProvider::shutdown or OtelProvider::drop. It does not hand off work because there is no internal queue.


##### `SpanAttributesProcessor::shutdown_with_timeout`  (lines 289–291)

```
fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult
```

**Purpose**: Reports that this processor shuts down immediately. It has no background worker or network connection of its own.

**Data flow**: It receives a timeout value but does not need it. It returns success without changing data, because there is nothing to close.

**Call relations**: The OpenTelemetry SDK may call this during tracer shutdown. Real exporting work is handled by the batch processors created in build_tracer_provider, not by this attribute-stamping processor.


##### `build_logger`  (lines 294–361)

```
fn build_logger(
    resource: &Resource,
    exporter: &OtelExporter,
) -> Result<SdkLoggerProvider, Box<dyn Error>>
```

**Purpose**: Builds the OpenTelemetry logger provider for the configured log exporter. It translates the project's exporter settings into an SDK logger that can send logs over OTLP gRPC or OTLP HTTP.

**Data flow**: It receives a resource and an exporter setting. It starts a logger provider builder with the resource labels. If exporting is disabled, it returns a provider without an exporter. For gRPC, it builds headers, TLS settings, and a gRPC log exporter. For HTTP, it chooses binary or JSON protocol, applies headers, optionally builds a TLS-aware HTTP client, and creates an HTTP log exporter. It returns the finished logger provider or an error.

**Call relations**: OtelProvider::from calls this when log export is enabled. It relies on configuration helpers to resolve exporter choices and on otlp helpers to build headers, TLS settings, and HTTP clients.

*Call graph*: calls 4 internal fn (resolve_exporter, build_grpc_tls_config, build_header_map, build_http_client); 7 external calls (new, builder, from_headers, builder, debug!, clone, unreachable!).


##### `build_tracer_provider`  (lines 363–457)

```
fn build_tracer_provider(
    resource: &Resource,
    exporter: &OtelExporter,
    span_attributes: BTreeMap<String, String>,
) -> Result<SdkTracerProvider, Box<dyn Error>>
```

**Purpose**: Builds the OpenTelemetry tracer provider for the configured trace exporter. It chooses the right trace exporter and batch processor, then combines them with resource labels and optional per-span attributes.

**Data flow**: It receives a resource, exporter setting, and span attributes. If trace exporting is disabled, it returns a provider with no exporter but still applies the resource and span-attribute processor. For gRPC, it builds headers, TLS settings, and a gRPC span exporter. For HTTP, it chooses binary or JSON protocol, applies headers, builds an HTTP client when needed, and creates a span exporter. On a multi-threaded Tokio runtime, it uses an async batch processor; otherwise it uses the standard batch processor. It returns the finished tracer provider or an error.

**Call relations**: OtelProvider::from calls this when traces are enabled. It delegates provider construction to tracer_provider_builder, uses otlp helpers for connection details, and installs a batch processor so spans are sent in groups instead of one network call at a time.

*Call graph*: calls 7 internal fn (resolve_exporter, build_async_http_client, build_grpc_tls_config, build_header_map, build_http_client, current_tokio_runtime_is_multi_thread, tracer_provider_builder); 7 external calls (builder, new, from_headers, builder, builder, debug!, unreachable!).


##### `tests::resource_attributes_include_host_name_when_present`  (lines 466–479)

```
fn resource_attributes_include_host_name_when_present()
```

**Purpose**: Checks that log resource attributes include host.name when a valid host name is provided. This protects the expected log-labeling behavior.

**Data flow**: It creates test settings, calls resource_attributes with a sample host name and log kind, searches the returned labels for host.name, and asserts that the value matches the sample name.

**Call relations**: This test calls resource_attributes directly instead of going through make_resource, so it can focus on the host-name rule. It uses tests::test_otel_settings to provide a simple settings object.

*Call graph*: calls 1 internal fn (resource_attributes); 2 external calls (assert_eq!, test_otel_settings).


##### `tests::resource_attributes_omit_host_name_when_missing_or_empty`  (lines 482–510)

```
fn resource_attributes_omit_host_name_when_missing_or_empty()
```

**Purpose**: Checks that host.name is not added when the host name is missing, blank, or when attributes are for traces. This confirms that host labeling is limited to meaningful log resources.

**Data flow**: It creates test settings and calls resource_attributes three times: with no host name, with a whitespace-only host name, and with a trace resource. It then asserts that none of the returned label lists contain host.name.

**Call relations**: This test exercises the same resource_attributes helper used by make_resource during provider setup. It guards both the blank-host cleanup rule and the logs-only host-name rule.

*Call graph*: calls 1 internal fn (resource_attributes); 2 external calls (assert!, test_otel_settings).


##### `tests::log_export_target_excludes_trace_safe_events`  (lines 513–518)

```
fn log_export_target_excludes_trace_safe_events()
```

**Purpose**: Checks the log export target rules used by this provider. It confirms that log-only and network-proxy targets are allowed as logs, while trace-safe targets are not treated as log export targets.

**Data flow**: It passes several target strings into the target-filtering functions and asserts the expected true-or-false results. No program state is changed.

**Call relations**: This test protects the behavior depended on by OtelProvider::log_export_filter and OtelProvider::logger_layer. The actual target decision comes from the targets module.

*Call graph*: 1 external calls (assert!).


##### `tests::trace_export_target_only_includes_trace_safe_prefix`  (lines 521–526)

```
fn trace_export_target_only_includes_trace_safe_prefix()
```

**Purpose**: Checks that only trace-safe target names are accepted for trace events. This helps prevent ordinary log-only targets from being attached to exported traces.

**Data flow**: It passes trace-safe and non-trace-safe target strings into the target-filtering functions and asserts the expected results. It returns nothing and changes no state.

**Call relations**: This test protects the behavior used by OtelProvider::trace_export_filter and OtelProvider::tracing_layer. The target-matching logic itself lives in the targets module.

*Call graph*: 1 external calls (assert!).


##### `tests::test_otel_settings`  (lines 528–541)

```
fn test_otel_settings() -> OtelSettings
```

**Purpose**: Builds a small, reusable OtelSettings value for tests in this file. It keeps the tests focused on resource and filter behavior rather than setup details.

**Data flow**: It creates an OtelSettings object with test service identity, local codex home, all exporters disabled, runtime metrics off, and empty span and trace-state maps. It returns that settings object to the test that asked for it.

**Call relations**: The resource attribute tests call this helper before calling resource_attributes. It is test-only support code and is not part of runtime telemetry setup.

*Call graph*: 2 external calls (new, from).


### Metrics foundations
These files establish the metrics subsystem’s shared types, validation rules, naming conventions, global coordination, and tag/config models.

### `otel/src/metrics/error.rs`

`data_model` · `cross-cutting`

This file is the shared vocabulary for things that can go wrong in the metrics system. Metrics are measurements such as counters, timings, or runtime statistics. Without a central error type, each part of the metrics code would have to invent its own failure messages, making problems harder to report and harder to fix.

The main piece is `MetricsError`, an enum, which means a value that can be one of several named cases. Each case describes a specific kind of failure: an empty metric name, invalid characters in a metric or tag, a disabled exporter, a negative counter increase, a bad OpenTelemetry Protocol configuration, or a failure while flushing collected data. OpenTelemetry is the observability toolkit used here to send metrics to external monitoring systems.

The file also defines `Result<T>` as shorthand for “either a successful value of type `T`, or a `MetricsError`.” This keeps function signatures in the metrics code shorter and more consistent.

Some error cases wrap lower-level errors from OpenTelemetry libraries. That preserves the original cause while still presenting the project’s own clearer error category. In everyday terms, this file is like a checklist of possible warning lights on a dashboard: each light has a precise meaning, and some also keep the mechanic’s detailed diagnostic code underneath.


### `otel/src/metrics/validation.rs`

`domain_logic` · `metric creation and tag building`

Metrics are measurements the program reports, such as counts, timings, or gauges. Tags are extra labels attached to those measurements, like a route name or status code. This file is the gatekeeper for those names and labels.

The rules are deliberately simple. A metric name must not be empty, and it may contain only letters, numbers, dots, underscores, and hyphens. A tag key or tag value must also not be empty, and it allows the same characters plus forward slashes. If something breaks these rules, the file returns a clear MetricsError instead of letting the invalid data travel farther through the system.

An everyday analogy is labeling boxes in a warehouse. If labels can contain anything, scanners and lookup systems may fail. This file makes sure every label follows the agreed format before the box enters the warehouse.

The public-to-this-crate functions validate whole tag maps, single metric names, and individual tag keys or values. The small helper functions at the bottom define what characters are allowed. This keeps the rest of the metrics code focused on recording measurements, while this file provides one shared place for the naming rules.

#### Function details

##### `validate_tags`  (lines 5–11)

```
fn validate_tags(tags: &BTreeMap<String, String>) -> Result<()>
```

**Purpose**: Checks a whole set of metric tags at once. Someone uses this when they already have a map of tag names to tag values and need to make sure every pair is acceptable before creating or recording a metric.

**Data flow**: It receives a sorted map of tag keys and tag values. For each pair, it checks the key first and then the value. If all pairs pass, it returns success; if any key or value is empty or contains a forbidden character, it stops and returns the matching metrics error.

**Call relations**: This is called by new when a metrics object or tag collection is being created. It delegates the actual checks to validate_tag_key and validate_tag_value so the same rules are used whether tags arrive as a batch or one at a time.

*Call graph*: calls 2 internal fn (validate_tag_key, validate_tag_value); called by 1 (new).


##### `validate_metric_name`  (lines 13–23)

```
fn validate_metric_name(name: &str) -> Result<()>
```

**Purpose**: Checks whether a metric name is allowed. It prevents empty names and names with characters that the metrics system does not accept.

**Data flow**: It receives a name as text. It first rejects an empty string, then looks at every character and asks whether each one is an allowed metric-name character. It returns success when the name is valid, or a MetricsError that includes the bad name when it is not.

**Call relations**: This is called when code creates different kinds of metrics: counter, gauge, histogram, and duration_histogram. It acts as the common checkpoint before those metric builders continue.

*Call graph*: called by 4 (counter, duration_histogram, gauge, histogram).


##### `validate_tag_key`  (lines 25–28)

```
fn validate_tag_key(key: &str) -> Result<()>
```

**Purpose**: Checks whether a tag key, meaning the label name, is valid. For example, it would validate the key part of a tag like service.name=checkout.

**Data flow**: It receives the tag key text and passes it to the shared tag component checker with the label "tag key". The result is either success or a clear error saying the tag key was empty or invalid.

**Call relations**: This is used anywhere tag keys are accepted: attributes, with_tag, push_optional_tag, and validate_tags. It hands the real checking to validate_tag_component so tag keys and tag values follow the same basic rules while still producing errors with the right wording.

*Call graph*: calls 1 internal fn (validate_tag_component); called by 4 (attributes, with_tag, push_optional_tag, validate_tags).


##### `validate_tag_value`  (lines 30–32)

```
fn validate_tag_value(value: &str) -> Result<()>
```

**Purpose**: Checks whether a tag value, meaning the label's content, is valid. It makes sure tag values are not blank and contain only allowed characters.

**Data flow**: It receives the tag value text and sends it to the shared tag component checker with the label "tag value". It returns success if the value is usable, or a MetricsError that explains what is wrong.

**Call relations**: This is called by attributes, with_tag, push_optional_tag, and validate_tags whenever tag values are supplied. Like validate_tag_key, it relies on validate_tag_component so the tag rules stay consistent in one place.

*Call graph*: calls 1 internal fn (validate_tag_component); called by 4 (attributes, with_tag, push_optional_tag, validate_tags).


##### `validate_tag_component`  (lines 34–47)

```
fn validate_tag_component(value: &str, label: &str) -> Result<()>
```

**Purpose**: Applies the shared validation rules for one tag piece, whether that piece is a key or a value. The label argument lets it produce an error message that says which kind of tag part failed.

**Data flow**: It receives the text to check and a human-readable label such as "tag key" or "tag value". It rejects empty text, then checks every character against the allowed tag-character rule. It returns success if the text passes, or a MetricsError that includes the label and, when useful, the invalid value.

**Call relations**: This is the common worker called by validate_tag_key and validate_tag_value. By putting the shared checks here, the file avoids having two slightly different versions of the same tag rule.

*Call graph*: called by 2 (validate_tag_key, validate_tag_value).


##### `is_metric_char`  (lines 49–51)

```
fn is_metric_char(c: char) -> bool
```

**Purpose**: Answers one small question: is this character allowed inside a metric name? It is the character-level rule used by metric name validation.

**Data flow**: It receives one character. It returns true if the character is an ASCII letter, ASCII number, dot, underscore, or hyphen; otherwise it returns false. It does not change anything else.

**Call relations**: validate_metric_name uses this while scanning a metric name character by character. The matches! macro is used internally as a compact way to compare the character against the allowed punctuation marks.

*Call graph*: 1 external calls (matches!).


##### `is_tag_char`  (lines 53–55)

```
fn is_tag_char(c: char) -> bool
```

**Purpose**: Answers whether one character is allowed inside a tag key or tag value. It is similar to the metric-name rule, but also permits forward slashes.

**Data flow**: It receives one character. It returns true for ASCII letters, ASCII numbers, dots, underscores, hyphens, and forward slashes; otherwise it returns false. It has no side effects.

**Call relations**: validate_tag_component uses this while checking each character of a tag key or value. The matches! macro is used internally to test the small set of allowed punctuation characters.

*Call graph*: 1 external calls (matches!).


### `otel/src/metrics/names.rs`

`config` · `cross-cutting`

This file solves a simple but important coordination problem: many parts of the system want to record measurements, such as tool calls, API requests, startup timing, token use, plugin activity, hooks, and thread skill counts. If each part typed metric names by hand, small spelling differences would split the data into separate buckets and make dashboards or alerts unreliable. This file avoids that by defining one shared constant for each metric name.

A metric is a named measurement sent to an observability system, which is software used to understand how a program behaves while it runs. Think of these constants like labels on jars in a pantry: everyone uses the same label, so sugar does not accidentally get stored under three different names.

The constants cover counts, durations, token usage, startup prewarming, goal lifecycle events, guardian reviews, WebSocket and server-sent event activity, and plugin or hook events. Some names include units such as `duration_ms` or `duration_s`, which makes it clear whether a value is measured in milliseconds or seconds.

There are no functions here. The value of the file is consistency. Other code imports these names when it records telemetry, and external monitoring tools can rely on the names staying predictable.


### `otel/src/metrics/config.rs`

`config` · `startup / test setup / metrics configuration`

Metrics are small measurements, such as counts, timings, or gauges, that help people see how a running service is behaving. This file is the setup form for that metrics pipeline. Without it, the rest of the metrics code would not know the service name, environment, version, exporter destination, or shared tags to attach to every measurement.

The main type is `MetricsConfig`, which is like a shipping label plus delivery instructions for metrics. It records basic identity information, such as the environment and service version. It also chooses a metrics exporter, meaning the place where metrics go. There are two choices: `Otlp`, which sends metrics through OpenTelemetry Protocol, a standard telemetry format, and `InMemory`, which keeps metrics inside the process for tests.

The file also provides small builder-style methods. A caller starts with either an OTLP config or an in-memory config, then optionally adds an export interval, enables a runtime reader for on-demand snapshots, or adds default tags. Tags are key-value labels, such as `region=us-east`, that make metrics easier to filter later. Before a tag is accepted, its key and value are checked by validation helpers so bad labels do not enter the metrics system.

#### Function details

##### `MetricsConfig::otlp`  (lines 27–42)

```
fn otlp(
        environment: impl Into<String>,
        service_name: impl Into<String>,
        service_version: impl Into<String>,
        exporter: OtelExporter,
    ) -> Self
```

**Purpose**: Creates a metrics configuration that sends measurements to an OpenTelemetry exporter. Use this when the service should report metrics to an external collector or observability system.

**Data flow**: The caller provides the environment, service name, service version, and an OTLP exporter. The text-like inputs are converted into owned strings, the exporter is wrapped as the OTLP choice, and a new config comes out with no custom export interval, no runtime reader, and no default tags yet.

**Call relations**: This is the normal starting point for production-style metrics setup. It is called by higher-level configuration conversion code and by an integration test that checks metrics can be sent to a collector; after this function creates the base config, callers can further customize it with methods such as adding tags or changing the export interval.

*Call graph*: called by 2 (from, otlp_http_exporter_sends_metrics_to_collector); 3 external calls (new, into, Otlp).


##### `MetricsConfig::in_memory`  (lines 45–60)

```
fn in_memory(
        environment: impl Into<String>,
        service_name: impl Into<String>,
        service_version: impl Into<String>,
        exporter: InMemoryMetricExporter,
    ) -> Self
```

**Purpose**: Creates a metrics configuration that stores exported metrics in memory instead of sending them over the network. This is mainly useful for tests, where code needs to inspect what would have been reported.

**Data flow**: The caller provides the environment, service name, service version, and an in-memory exporter. The identity fields are converted into strings, the exporter is wrapped as the in-memory choice, and the returned config starts with default timing behavior, no runtime reader, and an empty set of default tags.

**Call relations**: Test helpers and telemetry tests call this when they need a safe, local metrics setup. It lets those tests run the same metrics-producing code as the real system, but collect the results inside the test process instead of relying on an external metrics collector.

*Call graph*: called by 10 (test_session_telemetry, test_session_telemetry_without_metadata, test_session_telemetry, websocket_harness_with_provider_options, build_metrics_with_defaults, runtime_metrics_summary_collects_tool_api_and_streaming_metrics, manager_snapshot_metrics_collects_without_shutdown, snapshot_collects_metrics_without_shutdown, build_in_memory_client, invalid_tag_component_is_rejected); 3 external calls (new, into, InMemory).


##### `MetricsConfig::with_export_interval`  (lines 63–66)

```
fn with_export_interval(mut self, interval: Duration) -> Self
```

**Purpose**: Sets how often metrics should be exported periodically. This lets callers shorten the interval for fast tests or adjust reporting frequency for a particular runtime setup.

**Data flow**: The function receives an existing config and a time duration. It stores that duration as the chosen export interval and returns the updated config, leaving the other settings unchanged.

**Call relations**: This is a builder step used after a base config has been created. It does not start exporting by itself; it simply records the timing choice so the later metrics setup code can use it when building the actual exporter pipeline.


##### `MetricsConfig::with_runtime_reader`  (lines 69–72)

```
fn with_runtime_reader(mut self) -> Self
```

**Purpose**: Turns on a manual reader that can take on-demand snapshots of runtime metrics. This is useful when code needs to collect current metrics immediately instead of waiting for the periodic exporter.

**Data flow**: The function receives an existing config, flips the runtime-reader flag to true, and returns the updated config. No other settings are changed.

**Call relations**: This is another builder step used during metrics setup. Later code that builds the metrics provider can see this flag and install the extra reader needed for snapshot-style collection.


##### `MetricsConfig::with_tag`  (lines 75–82)

```
fn with_tag(mut self, key: impl Into<String>, value: impl Into<String>) -> Result<Self>
```

**Purpose**: Adds a default tag that will be attached to every metric created under this configuration. Tags help people group and filter metrics later, for example by deployment, region, or feature.

**Data flow**: The caller provides a tag key and value. The function turns both into strings, checks the key and value with validation helpers, and, if both are acceptable, stores them in the config's default tag map. It returns the updated config on success, or an error if the tag is invalid.

**Call relations**: This builder step protects the rest of the metrics system from bad labels. It calls the tag validation functions before changing the config, so later exporter setup and metric creation can assume the default tags have already passed the project’s rules.

*Call graph*: calls 2 internal fn (validate_tag_key, validate_tag_value); 1 external calls (into).


### `otel/src/metrics/tags.rs`

`domain_logic` · `cross-cutting during metrics recording`

Metrics are much more useful when they carry a few labels, such as which model was used, where the session came from, or what app version was running. But labels can also cause problems if they contain unsafe text or too many unique values. A metrics system can become slow or expensive if every run creates a new label value. This file acts like a small checklist for session metric labels.

It names the allowed tag keys, such as `model`, `app.version`, and `originator`. It also keeps a short list of known originator values. If an originator is not on that list, it is grouped under `other`, which keeps the metric data easy to aggregate.

The main type, `SessionMetricTagValues`, is a small bundle of possible session tag values. Some values are required, such as the model and app version. Others are optional, such as authentication mode or service name. Its `into_tags` method turns that bundle into an ordered list of key-value pairs. Before adding each tag, it checks that the key and value are valid. In everyday terms, this file is the label maker for session metrics: it prints only approved labels, skips blanks, and keeps unusual sources from flooding the reporting system.

#### Function details

##### `bounded_originator_tag_value`  (lines 29–36)

```
fn bounded_originator_tag_value(originator: &str) -> &'static str
```

**Purpose**: This function turns a raw originator name into a safe, known metric value. If the originator is not one of the approved names, it returns `other` so metrics stay grouped and readable instead of being split across endless unique labels.

**Data flow**: It receives an originator string from elsewhere in the program. It first sanitizes that text into a form suitable for metric tags, then compares it with the built-in list of known originators. The result is either the matching known originator value or the fallback value `other`.

**Call relations**: When process-start metrics are recorded, `record_process_start_once` calls this function to prepare the originator tag. This function delegates the cleanup step to `sanitize_metric_tag_value`, then hands back a bounded value that the caller can safely attach to telemetry.

*Call graph*: called by 1 (record_process_start_once); 1 external calls (sanitize_metric_tag_value).


##### `SessionMetricTagValues::into_tags`  (lines 48–57)

```
fn into_tags(self) -> Result<Vec<(&'static str, &'a str)>>
```

**Purpose**: This method converts a `SessionMetricTagValues` bundle into the actual ordered list of metric tags. Someone would use it right before recording a session metric, so the metric receives the expected labels in a consistent order.

**Data flow**: It takes ownership of the session tag bundle. It starts with an empty list sized for up to six tags, then tries to add authentication mode, session source, originator, service name, model, and app version. Optional missing values are skipped. If every included tag passes validation, it returns the completed list; if any key or value is invalid, it returns an error instead.

**Call relations**: This is the public conversion step for the `SessionMetricTagValues` struct. For each possible tag, it calls `SessionMetricTagValues::push_optional_tag`, which performs the skip-if-missing and validation work before adding the tag to the list.

*Call graph*: 2 external calls (push_optional_tag, with_capacity).


##### `SessionMetricTagValues::push_optional_tag`  (lines 59–71)

```
fn push_optional_tag(
        tags: &mut Vec<(&'static str, &'a str)>,
        key: &'static str,
        value: Option<&'a str>,
    ) -> Result<()>
```

**Purpose**: This helper adds one tag to the growing tag list, but only if a value is present and valid. It keeps the repeated safety checks in one place so every session metric tag follows the same rules.

**Data flow**: It receives the tag list being built, a fixed tag key, and an optional value. If the value is missing, it leaves the list unchanged and succeeds. If the value is present, it validates the key and the value, then appends the key-value pair to the list. If validation fails, it returns an error and does not add the bad tag.

**Call relations**: `SessionMetricTagValues::into_tags` calls this helper once for each possible session tag. This helper passes the actual checking work to `validate_tag_key` and `validate_tag_value`, then gives the updated list back to the conversion flow.

*Call graph*: calls 2 internal fn (validate_tag_key, validate_tag_value).


##### `tests::session_metric_tags_include_expected_tags_in_order`  (lines 86–109)

```
fn session_metric_tags_include_expected_tags_in_order()
```

**Purpose**: This test confirms that a complete set of session tag values becomes the exact tag list expected by the metrics code. It also checks that the order is stable, which can matter for predictable output and easy comparison.

**Data flow**: It creates a `SessionMetricTagValues` value where all optional and required fields are present. It converts that bundle into tags, then compares the result with the exact expected list of key-value pairs. The test passes only if all tags are included in the intended order.

**Call relations**: This test exercises `SessionMetricTagValues::into_tags` as a caller would use it. It uses `assert_eq!` to compare the produced tags with the expected result, guarding against accidental changes to tag names, inclusion rules, or ordering.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_metric_tags_skip_missing_optional_tags`  (lines 112–133)

```
fn session_metric_tags_skip_missing_optional_tags()
```

**Purpose**: This test confirms that missing optional tags are simply left out rather than producing empty or invalid metric labels. That keeps metrics clean when information such as authentication mode or service name is unavailable.

**Data flow**: It creates a `SessionMetricTagValues` value with `auth_mode` and `service_name` set to missing. It converts the bundle into tags, then checks that the result contains only the required tags and the optional tags that had values. The output is compared with the expected shorter list.

**Call relations**: This test calls `SessionMetricTagValues::into_tags` to verify the optional-tag path. It relies on `assert_eq!` to make sure `SessionMetricTagValues::push_optional_tag` correctly skips missing values while still adding the rest.

*Call graph*: 1 external calls (assert_eq!).


### `otel/src/metrics/mod.rs`

`orchestration` · `startup and cross-cutting metrics use`

Metrics are the numbers the system records so operators can understand what is happening, such as timings, counts, and process information. This file does not do the measuring itself. Instead, it gathers the metrics pieces into one module and provides a safe shared place to store the project-wide metrics client.

The important idea here is “set once, read many times.” The file uses `OnceLock`, which is a one-time storage cell: after a value is put in, later code can read it, but it cannot be replaced. That is useful for global metrics because many parts of the program need to record measurements, but the actual metrics setup should happen only once during initialization. It is like putting the official thermometer in a shared hallway: everyone can look at it, but nobody swaps it out midway through the day.

This file also re-exports names from its child modules, such as `MetricsClient`, configuration types, error types, metric names, and tag helpers. That means other code can import them from the metrics module without needing to know which smaller file they live in. Without this file, the rest of the system would have no simple, consistent way to find the metrics client or the common metrics definitions.

#### Function details

##### `install_global`  (lines 27–29)

```
fn install_global(metrics: MetricsClient)
```

**Purpose**: Stores the main metrics client in a shared global slot so other parts of the program can record metrics later. It is meant to be called during setup, before normal metric recording begins.

**Data flow**: A `MetricsClient` goes in. The function tries to place it into the one-time global storage cell. Nothing is returned; after this succeeds, later callers can ask for the global metrics client. If something was already installed, the new value is ignored.

**Call relations**: This is called from setup-style conversion code named `from`, where configuration is being turned into usable runtime pieces. After that setup step, functions such as `global` can hand copies of the installed client to code that needs to record measurements.

*Call graph*: called by 1 (from).


##### `global`  (lines 31–33)

```
fn global() -> Option<MetricsClient>
```

**Purpose**: Returns the shared metrics client if one has been installed. Code uses this when it wants to record a metric without carrying a metrics client through every function call.

**Data flow**: It reads the one-time global metrics storage. If a client is present, it returns a cloned copy wrapped in `Some`; if setup has not installed one yet, it returns `None`. It does not change the stored client.

**Call relations**: This is used when new metrics-related objects are created and when a global timer is started. In those moments, the calling code asks this function whether metrics are available, then either records through the returned client or continues without one.

*Call graph*: called by 2 (new, start_global_timer).


##### `install_global_statsig_settings`  (lines 35–37)

```
fn install_global_statsig_settings(settings: StatsigMetricsSettings)
```

**Purpose**: Stores Statsig-specific metrics settings in a shared global slot. These settings describe how Statsig metrics should be shaped or labeled elsewhere in the system.

**Data flow**: A `StatsigMetricsSettings` value goes in. The function tries to put it into one-time global storage. It returns nothing; after installation, other code can read a cloned copy of those settings. If settings were already installed, this call leaves the original value in place.

**Call relations**: This is called from setup-style conversion code named `from`, alongside other initialization work. Once installed, the settings become available through `global_statsig_settings`, which is used by the code that needs Statsig metrics configuration.

*Call graph*: called by 1 (from).


##### `global_statsig_settings`  (lines 39–41)

```
fn global_statsig_settings() -> Option<StatsigMetricsSettings>
```

**Purpose**: Returns the shared Statsig metrics settings if they were installed during startup. This lets metrics code find those settings without each caller passing them around manually.

**Data flow**: It reads the one-time global settings storage. If settings exist, it returns a cloned copy wrapped in `Some`; if not, it returns `None`. It only reads; it does not modify the stored settings.

**Call relations**: This is called by `global_statsig_metrics_settings`, which acts as the higher-level access point for Statsig metrics configuration. In that flow, this function supplies the raw shared settings value when it is available.

*Call graph*: called by 1 (global_statsig_metrics_settings).


### Metrics transport and recording
These files implement OTLP transport setup and the concrete metrics client features used to emit counters, timers, startup signals, and runtime summaries.

### `otel/src/otlp.rs`

`io_transport` · `telemetry exporter setup`

OpenTelemetry is the system used to report what the program is doing, for example timing information, logs, and metrics. OTLP is the protocol used to send that information to a collector service. This file is the adapter that makes those outgoing connections safe and configurable.

Its job is much like packing a delivery truck before sending reports away: it adds the right address, security documents, custom labels, and deadline. It builds HTTP header maps from plain key-value settings. It builds TLS configuration for gRPC, where TLS is the encrypted connection layer used by HTTPS-like systems. It also builds blocking and asynchronous HTTP clients for exporters that send telemetry over HTTP.

A major part of the file is certificate handling. It can load a custom certificate authority, which tells the client which server certificates to trust. It can also load a client certificate and private key for mutual TLS, often called mTLS, where both sides prove their identity. The file deliberately rejects half-configured mTLS: a certificate without its matching private key, or the reverse, is treated as a configuration error.

It also reads timeout values from environment variables, falling back to OpenTelemetry defaults when nothing valid is set. One subtle piece is the blocking HTTP client builder: because blocking work can interfere with Tokio, the asynchronous runtime used by Rust programs, it chooses a safe way to build the client depending on what kind of runtime is currently active.

#### Function details

##### `build_header_map`  (lines 22–32)

```
fn build_header_map(headers: &std::collections::HashMap<String, String>) -> HeaderMap
```

**Purpose**: This function turns ordinary string headers from configuration into the typed header format expected by the HTTP client. It quietly skips any header name or value that is not valid HTTP.

**Data flow**: It receives a map of text keys and text values. For each pair, it tries to convert the key into an HTTP header name and the value into an HTTP header value. Valid pairs are inserted into a new header map, and the finished map is returned.

**Call relations**: Telemetry builders for metrics, logs, and traces call this when they need to attach custom HTTP headers to OTLP export requests. It does not send anything itself; it prepares the labels that later network clients will use.

*Call graph*: called by 3 (build_otlp_metric_exporter, build_logger, build_tracer_provider); 3 external calls (new, from_bytes, from_str).


##### `build_grpc_tls_config`  (lines 34–68)

```
fn build_grpc_tls_config(
    endpoint: &str,
    tls_config: ClientTlsConfig,
    tls: &OtelTlsConfig,
) -> Result<ClientTlsConfig, Box<dyn Error>>
```

**Purpose**: This function prepares TLS security settings for OTLP over gRPC. gRPC is a network protocol often used for service-to-service calls, and TLS is the encryption and identity-checking layer.

**Data flow**: It receives an endpoint address, an existing gRPC TLS configuration, and the project's TLS settings. It extracts the host name from the endpoint, sets that as the expected server name, optionally reads a custom certificate authority file, and optionally reads a client certificate plus private key for mTLS. It returns an updated TLS configuration or a clear configuration error.

**Call relations**: The metric, log, and trace exporter builders call this when they are configured to send OTLP data over gRPC. It relies on read_bytes to load certificate files and config_error to report invalid settings in a consistent way.

*Call graph*: calls 2 internal fn (config_error, read_bytes); called by 3 (build_otlp_metric_exporter, build_logger, build_tracer_provider); 3 external calls (domain_name, from_pem, from_pem).


##### `build_http_client`  (lines 74–92)

```
fn build_http_client(
    tls: &OtelTlsConfig,
    timeout_var: &str,
) -> Result<reqwest::blocking::Client, Box<dyn Error>>
```

**Purpose**: This function builds a blocking HTTP client for OTLP exporters. It is careful about where that blocking work happens so it does not accidentally stall an async runtime.

**Data flow**: It receives TLS settings and the name of the timeout environment variable to honor. It checks whether the code is currently inside a Tokio runtime, and if so what kind. In a multi-thread runtime it uses Tokio's safe blocking escape hatch; in a single-thread runtime it moves the work to a separate operating-system thread; outside Tokio it builds directly. The result is a ready blocking HTTP client or an error.

**Call relations**: Metric, log, and trace exporter setup call this when they need an HTTP client that works in blocking OpenTelemetry exporter threads. It delegates the actual certificate and timeout setup to build_http_client_inner, and uses current_tokio_runtime_is_multi_thread to choose the safe execution path.

*Call graph*: calls 2 internal fn (build_http_client_inner, current_tokio_runtime_is_multi_thread); called by 4 (build_otlp_metric_exporter, build_http_client_works_in_current_thread_runtime, build_logger, build_tracer_provider); 4 external calls (clone, spawn, try_current, block_in_place).


##### `current_tokio_runtime_is_multi_thread`  (lines 94–99)

```
fn current_tokio_runtime_is_multi_thread() -> bool
```

**Purpose**: This function answers one narrow question: is the current code running inside a multi-threaded Tokio runtime? Tokio is the async task runner used by many Rust programs.

**Data flow**: It tries to get the current Tokio runtime handle. If there is no runtime, it returns false. If there is one, it checks whether its flavor is multi-threaded and returns true or false.

**Call relations**: build_http_client uses this to decide whether blocking work can be wrapped with Tokio's block-in-place support. The trace provider setup also uses it when deciding how to build telemetry plumbing safely.

*Call graph*: called by 2 (build_http_client, build_tracer_provider); 1 external calls (try_current).


##### `build_http_client_inner`  (lines 101–146)

```
fn build_http_client_inner(
    tls: &OtelTlsConfig,
    timeout_var: &str,
) -> Result<reqwest::blocking::Client, Box<dyn Error>>
```

**Purpose**: This function does the actual work of creating a blocking HTTP client with timeout and TLS settings. It is separated from build_http_client so the outer function can choose a safe place to run it.

**Data flow**: It receives TLS settings and a timeout environment variable name. It starts a blocking reqwest HTTP client builder with the resolved timeout. If a custom certificate authority is configured, it reads and installs it as the trusted root. If client certificate and private key are both configured, it reads them, combines them into a client identity, and forces HTTPS-only use. If only one half of the client identity is present, it returns a configuration error. Finally it builds and returns the client.

**Call relations**: Only build_http_client calls this. It uses resolve_otlp_timeout to decide the request deadline, read_bytes to load certificate material, and config_error to turn bad TLS setup into readable errors.

*Call graph*: calls 3 internal fn (config_error, read_bytes, resolve_otlp_timeout); called by 1 (build_http_client); 3 external calls (from_pem, from_pem, builder).


##### `build_async_http_client`  (lines 148–194)

```
fn build_async_http_client(
    tls: Option<&OtelTlsConfig>,
    timeout_var: &str,
) -> Result<reqwest::Client, Box<dyn Error>>
```

**Purpose**: This function builds the non-blocking HTTP client used when telemetry sending can happen asynchronously. It applies the same timeout and TLS rules as the blocking client path.

**Data flow**: It receives optional TLS settings and a timeout environment variable name. It creates an async reqwest client builder with the resolved timeout. If TLS settings are present, it may load a custom certificate authority and may load a client certificate plus private key for mTLS. It rejects incomplete mTLS settings. It returns the finished async HTTP client or an error.

**Call relations**: The trace provider setup calls this when it needs an async HTTP client for OTLP export. It shares the helper functions used by the blocking client path: resolve_otlp_timeout for deadlines, read_bytes for files, and config_error for clear setup failures.

*Call graph*: calls 3 internal fn (config_error, read_bytes, resolve_otlp_timeout); called by 1 (build_tracer_provider); 3 external calls (from_pem, from_pem, builder).


##### `resolve_otlp_timeout`  (lines 196–204)

```
fn resolve_otlp_timeout(signal_var: &str) -> Duration
```

**Purpose**: This function decides how long OTLP export requests are allowed to take before timing out. It follows OpenTelemetry's priority order: a signal-specific timeout first, then the general OTLP timeout, then the default.

**Data flow**: It receives the name of a signal-specific environment variable, such as one for traces or metrics. It first asks read_timeout_env for that variable. If it is missing or invalid, it tries the general OTLP timeout variable. If that is also missing or invalid, it returns the OpenTelemetry default timeout duration.

**Call relations**: Both the blocking and async HTTP client builders call this before creating their clients. It delegates individual environment-variable parsing to read_timeout_env.

*Call graph*: calls 1 internal fn (read_timeout_env); called by 2 (build_async_http_client, build_http_client_inner).


##### `read_timeout_env`  (lines 206–213)

```
fn read_timeout_env(var: &str) -> Option<Duration>
```

**Purpose**: This function reads one timeout environment variable and turns it into a duration. It treats missing, non-number, or negative values as unusable.

**Data flow**: It receives an environment variable name. It reads the variable from the process environment, parses the value as a number of milliseconds, rejects negative values, and returns a duration when everything is valid. Otherwise it returns nothing.

**Call relations**: resolve_otlp_timeout calls this while checking timeout settings in priority order. This helper keeps the parsing rules in one small place.

*Call graph*: called by 1 (resolve_otlp_timeout); 2 external calls (from_millis, var).


##### `read_bytes`  (lines 215–223)

```
fn read_bytes(path: &AbsolutePathBuf) -> Result<(Vec<u8>, PathBuf), Box<dyn Error>>
```

**Purpose**: This function reads a configured certificate or key file from disk and adds helpful context if the read fails.

**Data flow**: It receives an absolute path. It tries to read all bytes from that file. On success it returns both the file contents and the path as a normal path buffer. On failure it returns an error message that includes the file path, so the user can tell which configured file caused the problem.

**Call relations**: The gRPC TLS builder and both HTTP client builders call this whenever they need certificate or private-key bytes. It does no parsing itself; it simply supplies the raw file contents to the certificate-parsing code.

*Call graph*: calls 1 internal fn (to_path_buf); called by 3 (build_async_http_client, build_grpc_tls_config, build_http_client_inner); 4 external calls (new, new, format!, read).


##### `config_error`  (lines 225–227)

```
fn config_error(message: impl Into<String>) -> Box<dyn Error>
```

**Purpose**: This function creates a standard configuration error from a plain message. It is used when the user's OTLP settings are inconsistent or invalid.

**Data flow**: It receives a message, turns it into a string, wraps it in an input-data error, and returns it as a general error value that callers can pass upward.

**Call relations**: The TLS and HTTP client builders call this for problems like missing endpoint hosts, incomplete mTLS pairs, or certificate parsing failures. It keeps those errors consistent across the file.

*Call graph*: called by 3 (build_async_http_client, build_grpc_tls_config, build_http_client_inner); 3 external calls (new, into, new).


##### `tests::current_tokio_runtime_is_multi_thread_detects_runtime_flavor`  (lines 236–257)

```
fn current_tokio_runtime_is_multi_thread_detects_runtime_flavor()
```

**Purpose**: This test checks that current_tokio_runtime_is_multi_thread correctly recognizes whether it is outside Tokio, inside a single-thread Tokio runtime, or inside a multi-thread Tokio runtime.

**Data flow**: It first calls the function with no Tokio runtime and expects false. Then it creates a current-thread runtime and expects false inside it. Finally it creates a multi-thread runtime and expects true inside it.

**Call relations**: This test directly protects the runtime-detection helper that build_http_client relies on. If this behavior changed, the blocking HTTP client might be built in an unsafe or inefficient place.

*Call graph*: 4 external calls (new_current_thread, new_multi_thread, assert!, assert_eq!).


##### `tests::build_http_client_works_in_current_thread_runtime`  (lines 260–271)

```
fn build_http_client_works_in_current_thread_runtime()
```

**Purpose**: This test confirms that the blocking HTTP client can still be built while running inside a single-thread Tokio runtime. That is the tricky case where blocking work must be moved away from the runtime thread.

**Data flow**: It creates a current-thread Tokio runtime, then calls build_http_client with default TLS settings inside that runtime. It checks that the result is successful.

**Call relations**: This test exercises the special path in build_http_client that spawns a separate thread when a single-thread Tokio runtime is active. It helps prevent regressions that would break telemetry setup in async contexts.

*Call graph*: calls 1 internal fn (build_http_client); 3 external calls (new_current_thread, assert!, default).


### `otel/src/metrics/client.rs`

`domain_logic` · `startup, cross-cutting runtime metrics recording, snapshot collection, teardown`

This file is the main doorway into Codex metrics. Metrics are small measurements, such as “this event happened 3 times” or “this operation took 42 milliseconds.” The file turns a user-facing configuration into an OpenTelemetry meter provider, which is the library component that stores and exports those measurements.

At startup, `MetricsClient::new` validates default tags, describes the running service with resource information like service name, version, environment, and operating system, then chooses where metrics should go. They can go to an in-memory exporter, useful for tests and local inspection, or to an OTLP exporter, which is OpenTelemetry’s common network format for sending telemetry to collectors.

During runtime, callers use simple methods such as `counter`, `gauge`, `histogram`, and `record_duration`. The inner client validates names and tags, merges caller tags with default tags, creates OpenTelemetry instruments only once, then reuses them. The instrument caches are protected by mutexes, which are locks that stop two tasks from changing the same cache at the same time.

The file also supports snapshots through a manual reader, like asking the metrics system for a photo of its current state without shutting it down. Finally, `shutdown` flushes pending measurements and stops the provider cleanly so data is not lost.

#### Function details

##### `SharedManualReader::new`  (lines 70–72)

```
fn new(inner: Arc<ManualReader>) -> Self
```

**Purpose**: Wraps a manual OpenTelemetry metrics reader so it can be shared safely with the metrics provider. This is used when Codex wants to collect a metrics snapshot on demand.

**Data flow**: It receives a shared pointer to a `ManualReader` → stores that pointer inside a small wrapper object → returns the wrapper so the provider can own a reader-like object while other code can still keep access to the same reader.

**Call relations**: When `build_provider` is setting up the meter provider and runtime snapshots are enabled, it calls this constructor to attach the manual reader. After that, OpenTelemetry treats the wrapper as a normal metric reader.

*Call graph*: called by 1 (build_provider).


##### `SharedManualReader::register_pipeline`  (lines 76–78)

```
fn register_pipeline(&self, pipeline: Weak<Pipeline>)
```

**Purpose**: Passes OpenTelemetry pipeline registration through to the real manual reader. A pipeline is the internal route that connects instruments to collection and export.

**Data flow**: It receives a weak reference to the OpenTelemetry pipeline → forwards that reference to the wrapped manual reader → changes the wrapped reader’s internal connection to the pipeline.

**Call relations**: OpenTelemetry calls this as part of provider setup. The wrapper does not make decisions itself; it simply hands the registration to the shared manual reader that `build_provider` attached.


##### `SharedManualReader::collect`  (lines 80–82)

```
fn collect(&self, rm: &mut ResourceMetrics) -> opentelemetry_sdk::error::OTelSdkResult
```

**Purpose**: Collects the current metrics into a provided snapshot container by delegating to the real manual reader.

**Data flow**: It receives an empty or reusable `ResourceMetrics` container → asks the wrapped manual reader to fill it with current measurements → returns success or an OpenTelemetry error.

**Call relations**: This is called by OpenTelemetry’s reader flow. It supports the same underlying manual reader that `MetricsClient::snapshot` uses, so runtime code can ask for a snapshot without stopping the provider.


##### `SharedManualReader::force_flush`  (lines 84–86)

```
fn force_flush(&self) -> opentelemetry_sdk::error::OTelSdkResult
```

**Purpose**: Forces the wrapped manual reader to flush any pending metrics work. Flushing means pushing out buffered data instead of waiting.

**Data flow**: It receives no extra data → calls `force_flush` on the wrapped reader → returns whatever success or error the reader reports.

**Call relations**: OpenTelemetry may call this during provider flushing. The wrapper exists only to forward the request to the shared manual reader.


##### `SharedManualReader::shutdown_with_timeout`  (lines 88–90)

```
fn shutdown_with_timeout(&self, timeout: Duration) -> opentelemetry_sdk::error::OTelSdkResult
```

**Purpose**: Shuts down the wrapped manual reader, respecting a maximum amount of time to wait.

**Data flow**: It receives a timeout duration → passes that timeout to the wrapped reader’s shutdown method → returns success or an OpenTelemetry shutdown error.

**Call relations**: OpenTelemetry uses this during shutdown. It lets the provider clean up the manual snapshot reader that was attached by `build_provider`.


##### `SharedManualReader::temporality`  (lines 92–94)

```
fn temporality(&self, kind: InstrumentKind) -> Temporality
```

**Purpose**: Reports how the wrapped reader wants metrics values to be expressed. Temporality means whether exported values are totals since the beginning or changes since the last collection.

**Data flow**: It receives the kind of metric instrument being queried → asks the wrapped manual reader for its temporality choice → returns that choice unchanged.

**Call relations**: OpenTelemetry calls this when deciding how to collect different instrument kinds. The wrapper keeps the behavior of the underlying manual reader intact.


##### `MetricsClientInner::counter`  (lines 110–144)

```
fn counter(
        &self,
        name: &str,
        description: Option<&str>,
        inc: i64,
        tags: &[(&str, &str)],
    ) -> Result<()>
```

**Purpose**: Records that something happened a certain number of times. It rejects negative increments because counters are meant to only go up.

**Data flow**: It receives a metric name, optional description, increment amount, and tags → validates the name and checks the increment is not negative → merges tags with defaults → finds or creates a cached OpenTelemetry counter → adds the increment with the merged attributes → returns success or a metrics error.

**Call relations**: Public methods such as `MetricsClient::counter` and `MetricsClient::counter_with_description` delegate here. Before recording, it uses `MetricsClientInner::attributes` to turn tags into OpenTelemetry attributes.

*Call graph*: calls 2 internal fn (attributes, validate_metric_name).


##### `MetricsClientInner::histogram`  (lines 146–159)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Records one numeric sample in a histogram. A histogram groups many samples into ranges, which is useful for understanding distributions such as sizes or counts.

**Data flow**: It receives a metric name, integer value, and tags → validates the name → builds merged attributes → finds or creates a cached floating-point histogram for that name → records the value as a sample → returns success or an error.

**Call relations**: `MetricsClient::histogram` is the public wrapper that calls this. It relies on `MetricsClientInner::attributes` to check and combine tags before the sample is recorded.

*Call graph*: calls 2 internal fn (attributes, validate_metric_name).


##### `MetricsClientInner::gauge`  (lines 161–189)

```
fn gauge(
        &self,
        name: &str,
        description: Option<&str>,
        value: i64,
        tags: &[(&str, &str)],
    ) -> Result<()>
```

**Purpose**: Records a current value, such as memory in use or the number of active items. Unlike a counter, a gauge can go up or down.

**Data flow**: It receives a name, optional description, value, and tags → validates the name → merges and validates tags → finds or creates a cached OpenTelemetry gauge → records the current value with those attributes → returns success or a metrics error.

**Call relations**: The public `MetricsClient::gauge` and `MetricsClient::gauge_with_description` methods call this. It uses `MetricsClientInner::attributes` before recording so every gauge measurement carries consistent labels.

*Call graph*: calls 2 internal fn (attributes, validate_metric_name).


##### `MetricsClientInner::duration_histogram`  (lines 191–222)

```
fn duration_histogram(
        &self,
        name: &str,
        value: f64,
        unit: &'static str,
        description: &str,
        boundaries: &'static [f64],
        tags: &[(&str, &str)],
```

**Purpose**: Records an elapsed time into a histogram with a clear unit and preset bucket boundaries. This lets dashboards show how fast or slow operations usually are.

**Data flow**: It receives a metric name, duration value, unit, description, bucket boundaries, and tags → validates the name → merges tags into attributes → finds or creates a cached histogram keyed by name, unit, and description → records the duration value → returns success or an error.

**Call relations**: `MetricsClient::record_duration` and `MetricsClient::record_duration_seconds_with_description` call this after converting a `Duration` into milliseconds or seconds. It uses `MetricsClientInner::attributes` to prepare the labels attached to the timing sample.

*Call graph*: calls 2 internal fn (attributes, validate_metric_name).


##### `MetricsClientInner::attributes`  (lines 224–244)

```
fn attributes(&self, tags: &[(&str, &str)]) -> Result<Vec<KeyValue>>
```

**Purpose**: Combines default tags with per-measurement tags and turns them into OpenTelemetry attributes. Tags are labels like environment, feature name, or status that make metrics searchable and filterable.

**Data flow**: It receives a slice of tag key/value pairs → if no tags are provided, it converts only the default tags → otherwise it copies the defaults, validates each supplied key and value, lets supplied tags override matching defaults, and converts the result into OpenTelemetry `KeyValue` attributes → returns the attribute list or a validation error.

**Call relations**: All inner recording methods call this before sending data to OpenTelemetry. It centralizes tag validation so counters, gauges, histograms, and duration histograms all follow the same labeling rules.

*Call graph*: calls 2 internal fn (validate_tag_key, validate_tag_value); called by 4 (counter, duration_histogram, gauge, histogram).


##### `MetricsClientInner::shutdown`  (lines 246–255)

```
fn shutdown(&self) -> Result<()>
```

**Purpose**: Flushes queued metrics and then shuts down the OpenTelemetry meter provider. This is important because telemetry exporters may buffer data before sending it.

**Data flow**: It receives no input beyond the existing client state → logs that metrics are being flushed → asks the provider to flush pending measurements → asks the provider to shut down → returns success or wraps provider errors as metrics errors.

**Call relations**: `MetricsClient::shutdown` calls this public-facing cleanup path. It hands off to OpenTelemetry’s `force_flush` and `shutdown` operations so the backend has the best chance to receive final metrics.

*Call graph*: 3 external calls (force_flush, shutdown, debug!).


##### `MetricsClient::new`  (lines 264–318)

```
fn new(config: MetricsConfig) -> Result<Self>
```

**Purpose**: Creates a ready-to-use metrics client from configuration. It validates labels, describes the service, chooses an exporter, and builds the OpenTelemetry provider and meter.

**Data flow**: It receives a `MetricsConfig` → checks default tags → builds resource attributes such as service version, environment, and operating system → optionally creates a manual reader for snapshots → chooses either an in-memory exporter or an OTLP network exporter → builds the provider and meter → stores instrument caches, runtime reader, and default tags in a shared inner client → returns the client or a configuration/exporter error.

**Call relations**: This is the setup point used by tests and higher-level application builders. It calls `os_resource_attributes` for host details, `build_otlp_metric_exporter` when network export is configured, and `build_provider` to assemble the OpenTelemetry provider.

*Call graph*: calls 4 internal fn (build_otlp_metric_exporter, build_provider, os_resource_attributes, validate_tags); called by 12 (test_session_telemetry, test_session_telemetry_without_metadata, test_session_telemetry, websocket_harness_with_provider_options, with_metrics_config, from, build_metrics_with_defaults, otlp_http_exporter_sends_metrics_to_collector, runtime_metrics_summary_collects_tool_api_and_streaming_metrics, manager_snapshot_metrics_collects_without_shutdown (+2 more)); 6 external calls (new, new, new, with_capacity, builder, new).


##### `MetricsClient::counter`  (lines 321–323)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Public helper for recording a counter increment without an instrument description. Use it when code wants to say “this event happened N more times.”

**Data flow**: It receives a metric name, increment amount, and tags → passes them to the inner counter recorder with no description → returns the same success or error result.

**Call relations**: Runtime telemetry helpers call this for event counts such as process start tracking. It is a thin public wrapper over `MetricsClientInner::counter`.

*Call graph*: called by 2 (record_process_start_once, counter).


##### `MetricsClient::counter_with_description`  (lines 326–334)

```
fn counter_with_description(
        &self,
        name: &str,
        description: &str,
        inc: i64,
        tags: &[(&str, &str)],
    ) -> Result<()>
```

**Purpose**: Public helper for recording a counter increment while also giving the metric a human-readable description. The description helps people understand the metric in dashboards and collectors.

**Data flow**: It receives a metric name, description, increment amount, and tags → forwards them to the inner counter recorder → returns success or the validation/export error from the inner layer.

**Call relations**: This is used when callers want richer metric metadata. It follows the same path as `MetricsClient::counter`, but includes the description when the OpenTelemetry counter is first created.


##### `MetricsClient::histogram`  (lines 337–339)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Public helper for recording one sample in a histogram. Use it for values where the spread matters, not just the latest value.

**Data flow**: It receives a metric name, integer sample value, and tags → forwards them to the inner histogram recorder → returns success or a metrics error.

**Call relations**: This is the simple public entry point for histogram samples. It delegates to `MetricsClientInner::histogram`, which validates the name, prepares attributes, and records the sample.


##### `MetricsClient::gauge`  (lines 342–344)

```
fn gauge(&self, name: &str, value: i64, tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Public helper for recording a current numeric value without a description. Use it for measurements that can rise and fall.

**Data flow**: It receives a metric name, current value, and tags → passes them to the inner gauge recorder with no description → returns success or an error.

**Call relations**: Application code calls this when it has a point-in-time value to report. The actual OpenTelemetry work happens in `MetricsClientInner::gauge`.


##### `MetricsClient::gauge_with_description`  (lines 347–355)

```
fn gauge_with_description(
        &self,
        name: &str,
        description: &str,
        value: i64,
        tags: &[(&str, &str)],
    ) -> Result<()>
```

**Purpose**: Public helper for recording a current numeric value with a human-readable description. This improves clarity for anyone inspecting the metric later.

**Data flow**: It receives a metric name, description, value, and tags → forwards them to the inner gauge recorder → returns the inner result.

**Call relations**: This mirrors `MetricsClient::gauge` but includes metadata when the gauge instrument is created. It delegates to `MetricsClientInner::gauge`.


##### `MetricsClient::record_duration`  (lines 358–372)

```
fn record_duration(
        &self,
        name: &str,
        duration: Duration,
        tags: &[(&str, &str)],
    ) -> Result<()>
```

**Purpose**: Records how long something took, measured in milliseconds. It uses a histogram so many timings can be summarized into fast, typical, and slow ranges.

**Data flow**: It receives a metric name, a `Duration`, and tags → converts the duration to milliseconds, capping it so it fits safely into the expected numeric range → sends it to the inner duration histogram with millisecond units, a standard description, and millisecond bucket boundaries → returns success or an error.

**Call relations**: Timer-related code and duration helpers call this after an operation finishes. It hands the converted value to `MetricsClientInner::duration_histogram` for validation, tagging, caching, and recording.

*Call graph*: called by 2 (record, record_duration); 1 external calls (as_millis).


##### `MetricsClient::record_duration_seconds_with_description`  (lines 375–390)

```
fn record_duration_seconds_with_description(
        &self,
        name: &str,
        description: &str,
        duration: Duration,
        tags: &[(&str, &str)],
    ) -> Result<()>
```

**Purpose**: Records how long something took, measured in seconds, with a custom description. This is useful when a metric should use seconds as its unit in telemetry systems.

**Data flow**: It receives a metric name, description, `Duration`, and tags → converts the duration to a floating-point number of seconds → sends it to the inner duration histogram with second units and second-based bucket boundaries → returns success or an error.

**Call relations**: Callers use this when they need descriptive, seconds-based timing metrics. It delegates the actual recording to `MetricsClientInner::duration_histogram`.

*Call graph*: 1 external calls (as_secs_f64).


##### `MetricsClient::start_timer`  (lines 392–398)

```
fn start_timer(
        &self,
        name: &str,
        tags: &[(&str, &str)],
    ) -> std::result::Result<Timer, MetricsError>
```

**Purpose**: Starts a timer object that can later record elapsed time for a named metric. This is a convenience for measuring a block of work without manually calculating the duration.

**Data flow**: It receives a metric name and tags → creates a `Timer` tied to this metrics client → returns the timer or a metrics error.

**Call relations**: Code that wants scoped timing calls this before doing work. It hands control to `Timer::new`, and the timer later uses this client to record the measured duration.

*Call graph*: calls 1 internal fn (new).


##### `MetricsClient::snapshot`  (lines 401–410)

```
fn snapshot(&self) -> Result<ResourceMetrics>
```

**Purpose**: Collects a current snapshot of runtime metrics without shutting down the metrics provider. This is useful for tests, diagnostics, or live inspection.

**Data flow**: It checks whether a runtime manual reader was configured → if not, returns a “snapshot unavailable” error → otherwise creates an empty `ResourceMetrics` snapshot → asks the manual reader to collect into it → returns the filled snapshot or a collection error.

**Call relations**: This depends on the manual reader created in `MetricsClient::new` and attached in `build_provider`. It does not export or shut down metrics; it only asks the existing reader for the current state.

*Call graph*: 1 external calls (default).


##### `MetricsClient::shutdown`  (lines 413–415)

```
fn shutdown(&self) -> Result<()>
```

**Purpose**: Public cleanup method for flushing and stopping the metrics system. Call it when the application is ending or the client is no longer needed.

**Data flow**: It receives no extra input → delegates to the inner shutdown method → returns success or the shutdown error from the provider.

**Call relations**: This is the public face of `MetricsClientInner::shutdown`. It lets higher-level code perform a clean teardown without knowing OpenTelemetry details.


##### `os_resource_attributes`  (lines 418–432)

```
fn os_resource_attributes() -> Vec<KeyValue>
```

**Purpose**: Builds metric resource attributes that describe the operating system. These labels help operators group or filter metrics by platform.

**Data flow**: It reads the current operating system type and version → sanitizes both values so they are safe as metric tag values → skips values reported as `unspecified` → returns a list of OpenTelemetry key/value attributes such as `os` and `os_version`.

**Call relations**: `MetricsClient::new` calls this while building the service resource. The returned attributes are attached to all metrics from this client as background context.

*Call graph*: called by 1 (new); 4 external calls (new, new, sanitize_metric_tag_value, get).


##### `build_provider`  (lines 434–455)

```
fn build_provider(
    resource: Resource,
    exporter: E,
    interval: Option<Duration>,
    runtime_reader: Option<Arc<ManualReader>>,
) -> (SdkMeterProvider, Meter)
```

**Purpose**: Assembles the OpenTelemetry meter provider and meter around a chosen metrics exporter. Think of it as wiring the measuring tools to the delivery pipe.

**Data flow**: It receives resource information, an exporter, an optional export interval, and an optional manual snapshot reader → builds a periodic reader that exports metrics on a schedule → optionally attaches the shared manual reader for snapshots → builds the SDK meter provider → asks the provider for Codex’s meter → returns both provider and meter.

**Call relations**: `MetricsClient::new` calls this after deciding which exporter to use. If snapshots are enabled, it calls `SharedManualReader::new` so the provider and client can share access to the same manual reader.

*Call graph*: calls 1 internal fn (new); called by 1 (new); 2 external calls (builder, builder).


##### `build_otlp_metric_exporter`  (lines 457–531)

```
fn build_otlp_metric_exporter(
    exporter: OtelExporter,
    temporality: Temporality,
) -> Result<opentelemetry_otlp::MetricExporter>
```

**Purpose**: Creates a network exporter that sends metrics using OTLP, the OpenTelemetry protocol for telemetry data. It supports both gRPC and HTTP transport, with headers and optional TLS security settings.

**Data flow**: It receives an exporter configuration and a temporality setting → rejects disabled export → resolves special exporter aliases when needed → for gRPC, builds headers and TLS configuration, then creates a tonic-based exporter → for HTTP, chooses binary or JSON protocol, adds headers and optional TLS HTTP client, then creates an HTTP exporter → returns the exporter or a clear metrics configuration/build error.

**Call relations**: `MetricsClient::new` calls this when metrics are configured to leave the process through OTLP. It uses shared OTLP helper functions for headers, TLS, and HTTP clients, then hands the finished exporter back to `build_provider`.

*Call graph*: calls 4 internal fn (resolve_exporter, build_grpc_tls_config, build_header_map, build_http_client); called by 1 (new); 4 external calls (new, from_headers, debug!, builder).


### `otel/src/metrics/timer.rs`

`domain_logic` · `cross-cutting`

This file provides `Timer`, a helper for measuring elapsed time and sending that measurement to the metrics system. Think of it like starting a kitchen timer when you begin a task, then writing down the result when the task is done.

A `Timer` stores four things: the metric name, a set of labels called tags, a metrics client that knows how to report the measurement, and the moment the timer started. Tags are extra pieces of context, such as which operation or route was being measured, so later dashboards can group and filter the numbers.

The important behavior is that the timer records itself automatically when it is dropped. In Rust, `drop` runs when a value goes out of scope, similar to cleaning up when leaving a room. That means code can start a timer and then mostly forget about it; when the timer’s lifetime ends, it sends the elapsed duration. If sending the metric fails during this automatic cleanup, the file logs an error instead of crashing the program.

Callers can also record explicitly with extra tags. Those extra tags are combined with the timer’s original tags, and the metrics client receives the elapsed time since creation.

#### Function details

##### `Timer::drop`  (lines 14–18)

```
fn drop(&mut self)
```

**Purpose**: Automatically records the timer when the `Timer` value is being cleaned up. This makes timing easy and safer, because callers do not have to remember to manually submit the measurement in every path.

**Data flow**: When the timer is about to disappear, it calls `record` with no extra tags. If recording succeeds, nothing else happens. If recording fails, the error is written to the application logs so the failure is visible without interrupting cleanup.

**Call relations**: This is called by Rust automatically when a `Timer` goes out of scope. It hands off the real work to `Timer::record`, and only adds the fallback behavior of logging an error if the metrics client could not accept the duration.

*Call graph*: calls 1 internal fn (record); 1 external calls (error!).


##### `Timer::new`  (lines 22–32)

```
fn new(name: &str, tags: &[(&str, &str)], client: &MetricsClient) -> Self
```

**Purpose**: Creates a new timer and starts measuring immediately. It is used when some other part of the metrics system wants to begin timing an operation.

**Data flow**: It receives a metric name, a list of tags, and a metrics client. It copies the name and tags into owned strings, clones the client so the timer can keep using it, records the current instant as the start time, and returns the ready-to-use `Timer`.

**Call relations**: This function is called by `start_timer`, which is the higher-level entry point for beginning a timed measurement. `Timer::new` prepares the timer’s stored data and uses the system clock’s current instant as the starting line.

*Call graph*: called by 1 (start_timer); 2 external calls (now, clone).


##### `Timer::record`  (lines 34–40)

```
fn record(&self, additional_tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Sends the elapsed time for this timer to the metrics client. Callers use it when they want to record the duration now, optionally adding more context tags for this specific recording.

**Data flow**: It receives extra tags from the caller and reads the timer’s stored tags, name, client, and start time. It builds one combined tag list, measures how much time has passed since the timer started, and asks the metrics client to record that duration. The result is either success or an error from the metrics client.

**Call relations**: This is the central recording step used by `Timer::drop` during automatic cleanup. After combining tags and calculating elapsed time, it hands the final metric name, duration, and tags to the metrics client’s `record_duration` function.

*Call graph*: calls 1 internal fn (record_duration); called by 1 (drop); 2 external calls (elapsed, with_capacity).


### `otel/src/metrics/process.rs`

`domain_logic` · `startup`

This file solves a small but important counting problem. A service may have many setup steps, background tasks, or libraries that all know the process has started. If each one reported a startup metric, the monitoring system would think many processes started when only one did. This file acts like a turnstile that lets the first report through and politely blocks the rest.

It keeps a single shared flag, `PROCESS_START_RECORDED`, using an atomic boolean. “Atomic” means it can be safely checked and changed even if multiple threads try at the same time. The public function, `record_process_start_once`, checks that flag. If nobody has recorded the process start yet, it flips the flag and sends one counter increment through the metrics client. If the flag was already set, it returns `false` and sends nothing.

The metric also includes an `originator` tag, which says which part of the system is claiming the start event. Before sending, the originator value is bounded, meaning it is made safe or limited so metrics do not explode with too many unique label values. Without this file, dashboards and alerts based on process starts could be inflated or misleading.

#### Function details

##### `record_process_start_once`  (lines 13–27)

```
fn record_process_start_once(metrics: &MetricsClient, originator: &str) -> Result<bool>
```

**Purpose**: Records the process-start counter one time for the current running process. It returns whether this call was the one that actually sent the metric, so callers can tell the difference between a real first record and a skipped duplicate.

**Data flow**: It receives a metrics client, which is the object used to send metrics, and an originator string, which names where the report came from. It first checks and updates the shared `PROCESS_START_RECORDED` flag in one safe step. If another caller already recorded the start, it returns `Ok(false)` and changes nothing else. If this is the first caller, it cleans up or limits the originator tag value, sends a counter increment of 1 for the process-start metric, and returns `Ok(true)` if sending succeeds. If sending the metric fails, that error is returned.

**Call relations**: When some startup code wants to announce that the process has begun, it calls this function instead of sending the metric directly. The function calls `bounded_originator_tag_value` to make the originator tag safe for metrics, then calls the metrics client's `counter` method to send the actual count. The atomic flag sits in front of those calls so only the first attempt reaches the metrics system.

*Call graph*: calls 2 internal fn (counter, bounded_originator_tag_value).


### `otel/src/metrics/runtime_metrics.rs`

`domain_logic` · `cross-cutting metric collection and logging`

OpenTelemetry is a common toolkit for collecting measurements from running software. Its raw metric snapshots are detailed and nested, a bit like a warehouse full of labeled boxes. This file acts like a clerk who walks through those boxes, finds the labels this project cares about, adds the numbers, and writes a short receipt.

The main receipt is `RuntimeMetricsSummary`. It groups related measurements: tool calls, API calls, server-sent streaming events, websocket requests and events, and several response-timing fields such as overhead time, inference time, and “time to first token” style timings. For groups that have both a count and a duration, it uses `RuntimeMetricTotals`.

The file also knows how to merge summaries. Counts and durations are added safely, while one-off timing fields are replaced only when the newer value is non-zero. That means a later real measurement can fill in a blank, but an empty value does not erase useful data.

At the bottom are small helper functions that search a `ResourceMetrics` snapshot for a metric name, then sum either counter values or histogram duration totals. Histogram sums arrive as floating-point numbers, so the file carefully converts them into whole milliseconds, treating invalid, negative, or infinite values as zero.

#### Function details

##### `RuntimeMetricTotals::is_empty`  (lines 31–33)

```
fn is_empty(self) -> bool
```

**Purpose**: Checks whether a count-and-duration pair contains no useful information. This is used to tell whether a category such as API calls or tool calls has recorded anything at all.

**Data flow**: It receives one `RuntimeMetricTotals` value. It looks at the `count` and `duration_ms` fields. It returns `true` only when both are zero; otherwise it returns `false`.

**Call relations**: When `RuntimeMetricsSummary::is_empty` checks the whole summary, it asks each `RuntimeMetricTotals` section to answer this smaller question for itself.

*Call graph*: called by 1 (is_empty).


##### `RuntimeMetricTotals::merge`  (lines 35–38)

```
fn merge(&mut self, other: Self)
```

**Purpose**: Adds another count-and-duration pair into the current one. It is used when measurements from more than one snapshot need to be combined.

**Data flow**: It receives a mutable current total and another total. It adds the other count to the current count, and the other duration to the current duration. The current object is changed in place. The additions are saturating, meaning they stop at the largest possible number instead of overflowing into a wrong value.

**Call relations**: When `RuntimeMetricsSummary::merge` combines two full summaries, it delegates each count-and-duration category to this function so the small total knows how to add itself correctly.

*Call graph*: called by 1 (merge).


##### `RuntimeMetricsSummary::is_empty`  (lines 59–73)

```
fn is_empty(self) -> bool
```

**Purpose**: Checks whether the entire runtime summary has no recorded measurements. This is useful before logging or reporting, so the system can avoid printing an empty metrics report.

**Data flow**: It receives a `RuntimeMetricsSummary`. It asks each grouped total whether it is empty, then checks every standalone timing field for zero. It returns `true` only if every part of the summary is blank.

**Call relations**: This is the top-level emptiness check. It relies on `RuntimeMetricTotals::is_empty` for the grouped categories, then directly checks the single timing fields itself.

*Call graph*: calls 1 internal fn (is_empty).


##### `RuntimeMetricsSummary::merge`  (lines 75–105)

```
fn merge(&mut self, other: Self)
```

**Purpose**: Combines another runtime summary into the current one. This lets the system build one useful summary out of multiple metric snapshots or partial summaries.

**Data flow**: It receives a mutable current summary and another summary. For categories with counts and durations, it adds the numbers. For single timing fields, it copies the incoming value only if that value is greater than zero. The current summary is updated in place.

**Call relations**: This function is the summary-level combiner. It calls `RuntimeMetricTotals::merge` for grouped totals, while it handles the standalone response and turn timing fields directly.

*Call graph*: calls 1 internal fn (merge).


##### `RuntimeMetricsSummary::responses_api_summary`  (lines 107–117)

```
fn responses_api_summary(&self) -> RuntimeMetricsSummary
```

**Purpose**: Builds a smaller summary containing only the Responses API timing fields. This is useful when a caller wants to log or display just that subset instead of the full runtime picture.

**Data flow**: It reads the current summary. It copies only the Responses API timing values into a new `RuntimeMetricsSummary`, and fills every unrelated field with its default empty value. It returns that new trimmed-down summary.

**Call relations**: This helper is used when websocket timing totals are logged. In that flow, the logger asks for the Responses API slice of the larger summary so it can focus on those specific timing measurements.

*Call graph*: called by 1 (log_websocket_timing_totals); 1 external calls (default).


##### `RuntimeMetricsSummary::from_snapshot`  (lines 119–169)

```
fn from_snapshot(snapshot: &ResourceMetrics) -> Self
```

**Purpose**: Creates a friendly runtime summary from a raw OpenTelemetry metric snapshot. This is the main translation step from detailed telemetry data into the compact shape used by the rest of the project.

**Data flow**: It receives a `ResourceMetrics` snapshot, which contains many named metric streams. For each metric name this project cares about, it asks helper functions to total either counter values or histogram duration sums. It then puts those totals into a new `RuntimeMetricsSummary` and returns it.

**Call relations**: This function is called by `runtime_metrics_summary`, which wants a clean summary from the current telemetry snapshot. During that conversion, it repeatedly calls `sum_counter` for count metrics and `sum_histogram_ms` for duration metrics.

*Call graph*: calls 2 internal fn (sum_counter, sum_histogram_ms); called by 1 (runtime_metrics_summary).


##### `sum_counter`  (lines 172–179)

```
fn sum_counter(snapshot: &ResourceMetrics, name: &str) -> u64
```

**Purpose**: Finds all counter metrics with a given name in a snapshot and adds their values. A counter is a measurement that only goes up, such as “number of API calls.”

**Data flow**: It receives a metrics snapshot and the name of the counter to look for. It walks through all metric groups in the snapshot, keeps only metrics with the matching name, totals their counter data, and returns one combined whole number.

**Call relations**: `RuntimeMetricsSummary::from_snapshot` uses this whenever it needs a count, such as tool call count or websocket request count. This helper does the searching so the summary-building code can stay easy to read.

*Call graph*: called by 1 (from_snapshot); 1 external calls (scope_metrics).


##### `sum_counter_metric`  (lines 181–189)

```
fn sum_counter_metric(metric: &Metric) -> u64
```

**Purpose**: Extracts the total value from one counter metric. It protects callers from accidentally treating a non-counter metric as a counter.

**Data flow**: It receives one OpenTelemetry `Metric`. It checks whether the metric data is an unsigned integer sum, which is the expected counter form. If it is, it adds all of that metric’s data-point values and returns the total. If it is not the right kind of metric, it returns zero.

**Call relations**: This is the per-metric worker used by the counter-summing path. `sum_counter` finds the matching named metrics, and this function knows how to read each matching counter safely.

*Call graph*: 1 external calls (data).


##### `sum_histogram_ms`  (lines 191–198)

```
fn sum_histogram_ms(snapshot: &ResourceMetrics, name: &str) -> u64
```

**Purpose**: Finds all duration histogram metrics with a given name in a snapshot and adds their total time. A histogram records many observed timings, and this function cares about the sum of those timings.

**Data flow**: It receives a metrics snapshot and the duration metric name to look for. It walks through the metric groups, keeps only metrics with the matching name, extracts each histogram’s summed duration, and returns the combined result as whole milliseconds.

**Call relations**: `RuntimeMetricsSummary::from_snapshot` uses this for every duration field, such as API call duration, streaming event duration, and response timing values. This helper hides the nested OpenTelemetry structure from the summary-building code.

*Call graph*: called by 1 (from_snapshot); 1 external calls (scope_metrics).


##### `sum_histogram_metric_ms`  (lines 200–208)

```
fn sum_histogram_metric_ms(metric: &Metric) -> u64
```

**Purpose**: Extracts the summed duration from one histogram metric and expresses it as whole milliseconds. It ignores metrics that are not floating-point histograms.

**Data flow**: It receives one OpenTelemetry `Metric`. It checks whether the metric contains floating-point histogram data. If so, it reads the sum from each histogram data point, converts each sum to a safe whole number with `f64_to_u64`, adds them, and returns the total. If the metric is the wrong shape, it returns zero.

**Call relations**: This is the per-metric worker used by `sum_histogram_ms`. The outer function finds matching duration metrics by name, and this function reads each one safely.

*Call graph*: 1 external calls (data).


##### `f64_to_u64`  (lines 210–216)

```
fn f64_to_u64(value: f64) -> u64
```

**Purpose**: Converts a floating-point measurement into a safe whole-number millisecond value. It prevents bad telemetry values from turning into misleading huge or invalid numbers.

**Data flow**: It receives a floating-point number. If the number is not finite, is zero, or is negative, it returns zero. Otherwise it caps the value at the largest possible `u64`, rounds it to the nearest whole number, and returns that integer.

**Call relations**: `sum_histogram_metric_ms` uses this when turning histogram duration sums into whole milliseconds. It is the safety gate between raw floating-point telemetry and the integer totals stored in `RuntimeMetricsSummary`.


### Trace and event plumbing
These files provide trace-context propagation plus the shared event-target and event-emission helpers used by session telemetry.

### `otel/src/targets.rs`

`domain_logic` · `cross-cutting`

This file helps keep different kinds of observability data separate. OpenTelemetry is a common system for collecting logs, traces, and metrics from a running program. A trace follows work as it moves through the system, while a log is more like a written note about something that happened.

The code uses target names as labels. Any target beginning with `codex_otel` belongs to this telemetry area. A more specific prefix, `codex_otel.trace_safe`, marks events that are safe to send to trace export. Everything under the general telemetry prefix, except those trace-safe events, is treated as log-only export data.

This distinction matters because trace data may travel through different tools or be shown in different places than logs. Some telemetry may be useful for logs but not appropriate, useful, or safe inside traces. The file is therefore a small gatekeeper: it looks at a target string and answers, “Is this for log export?” or “Is this safe for trace export?” Without this central rule, different parts of the telemetry pipeline might disagree about where the same event belongs.

#### Function details

##### `is_log_export_target`  (lines 5–7)

```
fn is_log_export_target(target: &str) -> bool
```

**Purpose**: This function decides whether a telemetry target should be exported as a log. It returns true for targets that start with the general OpenTelemetry prefix, unless they are specifically marked as trace-safe.

**Data flow**: It receives a target name as text. It checks whether the text begins with the telemetry prefix, then asks `is_trace_safe_target` whether the same target belongs to the trace-safe group. The result is a yes-or-no answer: true means this target should go through log export, false means it should not.

**Call relations**: The log export filtering code calls this function when deciding whether to keep or reject a telemetry event for log output. Inside that decision, this function relies on `is_trace_safe_target` so that trace-safe events are not accidentally treated as log-only events.

*Call graph*: calls 1 internal fn (is_trace_safe_target); called by 1 (log_export_filter).


##### `is_trace_safe_target`  (lines 9–11)

```
fn is_trace_safe_target(target: &str) -> bool
```

**Purpose**: This function decides whether a telemetry target is explicitly marked as safe for trace export. It does this by checking for the `codex_otel.trace_safe` prefix.

**Data flow**: It receives a target name as text. It compares the beginning of that text with the trace-safe prefix. It returns true if the target starts with that prefix, and false otherwise; it does not change anything else.

**Call relations**: The trace export filter calls this function when deciding what can be included in traces. `is_log_export_target` also calls it as a safeguard, so anything marked trace-safe is excluded from the log-export-only group.

*Call graph*: called by 2 (trace_export_filter, is_log_export_target).


### `otel/src/trace_context.rs`

`io_transport` · `cross-cutting`

Modern tracing gives each request or task an ID, like a parcel tracking number. When work moves from one process to another, that ID must travel with it. This file translates between the program’s internal tracing spans and the standard W3C headers called traceparent and tracestate. The traceparent value carries the main trace and span IDs. The tracestate value carries extra vendor-specific details.

The file can read trace context from the current tracing span, turn it into a W3cTraceContext object for sending elsewhere, and read a W3cTraceContext back into an OpenTelemetry context so a new span can continue the same trace. It can also read TRACEPARENT and TRACESTATE from environment variables, which lets a child process continue a parent process’s trace.

A second job in this file is safely adding configured tracestate entries. Because these values end up in headers that other tools must parse, the code validates keys and values before installing them. It also merges configured fields into existing tracestate instead of blindly replacing everything. Without this file, traces would often stop at process boundaries, and bad tracestate configuration could produce telemetry headers that downstream systems reject.

#### Function details

##### `current_span_w3c_trace_context`  (lines 29–31)

```
fn current_span_w3c_trace_context() -> Option<W3cTraceContext>
```

**Purpose**: This gets the W3C trace context for whatever tracing span is currently active. It is useful when the program is about to send work somewhere else and needs to pass along the current trace ID.

**Data flow**: It reads the current tracing span from the tracing system, then passes that span to span_w3c_trace_context. If the current span has a valid trace, the result is a W3cTraceContext containing traceparent and possibly tracestate; otherwise the result is nothing.

**Call relations**: This is the simple public doorway for callers that do not already have a span object. It asks the tracing library for the current span, then delegates the real extraction work to span_w3c_trace_context.

*Call graph*: calls 1 internal fn (span_w3c_trace_context); 1 external calls (current).


##### `span_w3c_trace_context`  (lines 33–50)

```
fn span_w3c_trace_context(span: &Span) -> Option<W3cTraceContext>
```

**Purpose**: This converts a specific tracing span into the standard W3C trace context values that can be sent to another process or service. It also folds in any configured tracestate additions.

**Data flow**: It receives a span, reads its OpenTelemetry context, and first checks whether the span context is valid. If it is valid, it asks OpenTelemetry’s trace context propagator to write trace headers into a temporary map, reads the process-wide configured tracestate entries, merges them with any existing tracestate, and returns a W3cTraceContext. If the span has no valid trace, it returns nothing.

**Call relations**: current_span_w3c_trace_context calls this after finding the active span. During its work, it uses tracestate_entries to read configured additions and merge_tracestate_entries to combine those additions with the span’s existing propagated tracestate.

*Call graph*: calls 2 internal fn (merge_tracestate_entries, tracestate_entries); called by 1 (current_span_w3c_trace_context); 3 external calls (new, context, new).


##### `set_tracestate_entries`  (lines 52–61)

```
fn set_tracestate_entries(
    entries: BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: This installs the process-wide tracestate entries that should be added to outgoing trace context. It validates them first so the program does not start sending malformed tracing headers.

**Data flow**: It receives a nested map: each top-level key is a tracestate member, and each inner map holds field names and values. It validates the whole structure, then takes a write lock and replaces the stored global tracestate configuration. On success it returns Ok; on invalid input it returns an error.

**Call relations**: Configuration-loading code reaches this through a from path. It relies on validate_tracestate_entries before writing to the shared storage returned by tracestate_entries, so later calls to span_w3c_trace_context only see safe values.

*Call graph*: calls 2 internal fn (tracestate_entries, validate_tracestate_entries); called by 1 (from).


##### `current_span_trace_id`  (lines 63–72)

```
fn current_span_trace_id() -> Option<String>
```

**Purpose**: This returns just the trace ID for the currently active span. It is a compact way to attach the current trace identifier to logs, diagnostics, or other output.

**Data flow**: It reads the current span from the tracing system, gets its span context, and checks that the context is valid. If valid, it converts the trace ID to a string and returns it; if not, it returns nothing.

**Call relations**: The test current_span_trace_id_returns_hex_trace_id calls this to prove it returns a real 32-character hexadecimal trace ID when OpenTelemetry tracing is active.

*Call graph*: called by 1 (current_span_trace_id_returns_hex_trace_id); 1 external calls (current).


##### `context_from_w3c_trace_context`  (lines 74–76)

```
fn context_from_w3c_trace_context(trace: &W3cTraceContext) -> Option<Context>
```

**Purpose**: This turns a W3cTraceContext object into an OpenTelemetry Context that the tracing system can use. It is the receiving-side counterpart to exporting trace context.

**Data flow**: It receives a W3cTraceContext with optional traceparent and tracestate strings. It passes those optional strings to context_from_trace_headers, which parses them and either returns a valid OpenTelemetry context or nothing.

**Call relations**: set_parent_from_w3c_trace_context uses this when attaching an incoming parent trace to a span. The parses_valid_w3c_trace_context test also calls it to check that valid W3C data becomes the expected trace and span IDs.

*Call graph*: calls 1 internal fn (context_from_trace_headers); called by 2 (set_parent_from_w3c_trace_context, parses_valid_w3c_trace_context).


##### `set_parent_from_w3c_trace_context`  (lines 78–85)

```
fn set_parent_from_w3c_trace_context(span: &Span, trace: &W3cTraceContext) -> bool
```

**Purpose**: This makes a span continue an incoming trace described by a W3cTraceContext. It answers whether the incoming trace data was usable.

**Data flow**: It receives a span and a W3cTraceContext. It tries to parse the trace context into an OpenTelemetry Context; if that works, it sets that context as the span’s parent and returns true. If parsing fails, it leaves the span unchanged and returns false.

**Call relations**: This function connects two smaller steps: context_from_w3c_trace_context parses the incoming trace, then set_parent_from_context attaches it to the span. It is meant for code that receives trace context from outside and wants the next span to join that trace.

*Call graph*: calls 2 internal fn (context_from_w3c_trace_context, set_parent_from_context).


##### `set_parent_from_context`  (lines 87–89)

```
fn set_parent_from_context(span: &Span, context: Context)
```

**Purpose**: This attaches an already-parsed OpenTelemetry Context as the parent of a tracing span. That makes the span part of an existing trace tree.

**Data flow**: It receives a span and a context. It asks the tracing/OpenTelemetry integration to set the context as the span’s parent. It does not return useful data; the change is on the span relationship.

**Call relations**: set_parent_from_w3c_trace_context calls this after it has successfully parsed W3C trace context. This function is the final handoff from parsed trace data to the live tracing span.

*Call graph*: called by 1 (set_parent_from_w3c_trace_context); 1 external calls (set_parent).


##### `traceparent_context_from_env`  (lines 91–95)

```
fn traceparent_context_from_env() -> Option<Context>
```

**Purpose**: This reads trace context from environment variables once and returns it as an OpenTelemetry Context. It lets a process continue a trace that was passed in by its parent process.

**Data flow**: It checks a process-wide cache. On the first call, the cache is filled by loading and parsing TRACEPARENT and optional TRACESTATE from the environment; later calls reuse the stored result. It returns a cloned context if the environment had valid trace data, or nothing otherwise.

**Call relations**: This function is a standalone entry point for environment-based propagation. It hides the one-time loading behavior so callers can ask for the parent context without repeatedly reading environment variables.


##### `context_from_trace_headers`  (lines 97–113)

```
fn context_from_trace_headers(
    traceparent: Option<&str>,
    tracestate: Option<&str>,
) -> Option<Context>
```

**Purpose**: This parses raw W3C trace header strings into an OpenTelemetry Context. It is the low-level parser shared by object-based and environment-based trace loading.

**Data flow**: It receives optional traceparent and tracestate strings. If traceparent is missing, it returns nothing. Otherwise it puts the provided values into a temporary header map, asks the OpenTelemetry trace context propagator to extract a context, checks that the extracted span context is valid, and returns the context only if it is valid.

**Call relations**: context_from_w3c_trace_context calls this for W3cTraceContext objects, and load_traceparent_context calls it for environment variables. It is the common gate that rejects malformed or incomplete incoming trace headers.

*Call graph*: called by 2 (context_from_w3c_trace_context, load_traceparent_context); 2 external calls (new, new).


##### `load_traceparent_context`  (lines 115–129)

```
fn load_traceparent_context() -> Option<Context>
```

**Purpose**: This loads TRACEPARENT and TRACESTATE from the process environment and tries to turn them into a tracing context. It logs whether the environment trace data was accepted or ignored.

**Data flow**: It reads TRACEPARENT from the environment and stops if it is absent. It also reads optional TRACESTATE. Then it calls context_from_trace_headers; if parsing succeeds, it returns the context and writes a debug message. If parsing fails, it writes a warning and returns nothing.

**Call relations**: traceparent_context_from_env uses this as the one-time loader behind its cache. This keeps environment parsing centralized and ensures invalid inherited trace data is ignored safely.

*Call graph*: calls 1 internal fn (context_from_trace_headers); 3 external calls (debug!, var, warn!).


##### `tracestate_entries`  (lines 131–133)

```
fn tracestate_entries() -> &'static RwLock<BTreeMap<String, BTreeMap<String, String>>>
```

**Purpose**: This gives access to the shared store of configured tracestate entries. The store is protected by a read-write lock, which is a lock that allows many readers or one writer at a time.

**Data flow**: It checks whether the global store has already been created. If not, it creates an empty map inside a read-write lock. It returns a reference to that shared locked map.

**Call relations**: set_tracestate_entries calls this to replace the configured entries, while span_w3c_trace_context calls it to read those entries when building outgoing trace context.

*Call graph*: called by 2 (set_tracestate_entries, span_w3c_trace_context).


##### `merge_tracestate_entries`  (lines 135–164)

```
fn merge_tracestate_entries(
    tracestate: Option<&str>,
    configured_entries: &BTreeMap<String, BTreeMap<String, String>>,
) -> Option<String>
```

**Purpose**: This combines an existing tracestate header with the configured tracestate entries for this process. It preserves usable incoming data while adding or updating configured fields.

**Data flow**: It receives an optional existing tracestate string and the configured entry map. It first parses the existing string, ignoring it with a warning if it is invalid. Then it walks through the configured entries in a deterministic order, merges each member’s fields, and inserts the result into the OpenTelemetry TraceState. It returns a finished tracestate header string, or nothing if the final header is empty.

**Call relations**: span_w3c_trace_context calls this while preparing outgoing W3C context. For each configured member, this function delegates field-level merging to merge_tracestate_member_fields and warns if OpenTelemetry rejects the resulting tracestate.

*Call graph*: calls 1 internal fn (merge_tracestate_member_fields); called by 1 (span_w3c_trace_context); 1 external calls (warn!).


##### `validate_tracestate_entries`  (lines 167–190)

```
fn validate_tracestate_entries(
    entries: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: This checks a full configured tracestate map before it is installed. The goal is to catch bad configuration early, before the program sends trace headers that other systems cannot read.

**Data flow**: It receives all configured tracestate members and their fields. It encodes each member’s fields into the single string format used inside a tracestate header, then asks OpenTelemetry to validate the resulting key-value pairs. It returns Ok if everything is acceptable, or an InvalidInput-style error if not.

**Call relations**: set_tracestate_entries calls this before writing the configuration into the global store. A configuration conversion path also calls it, so invalid tracestate can be rejected while configuration is being built.

*Call graph*: called by 2 (from, set_tracestate_entries); 1 external calls (from_key_value).


##### `validate_tracestate_member`  (lines 193–205)

```
fn validate_tracestate_member(
    member_key: &str,
    fields: &BTreeMap<String, String>,
) -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: This checks one configured tracestate member and its fields. It is useful when validating a single member separately from the whole configuration.

**Data flow**: It receives a member key and its field map. It encodes the fields into the member’s header value, then asks OpenTelemetry to validate that one key-value pair. It returns Ok for a valid member or an InvalidInput-style error for a bad one.

**Call relations**: This function uses encode_tracestate_member_fields to apply this file’s stricter field rules before handing the result to OpenTelemetry’s TraceState validation.

*Call graph*: calls 1 internal fn (encode_tracestate_member_fields); 1 external calls (from_key_value).


##### `encode_tracestate_member_fields`  (lines 207–236)

```
fn encode_tracestate_member_fields(
    member_key: &str,
    fields: &BTreeMap<String, String>,
) -> Result<(String, String), Box<dyn std::error::Error>>
```

**Purpose**: This turns the project’s structured tracestate fields into the single string value required by the W3C tracestate header. It also rejects characters that would make the header unsafe or ambiguous.

**Data flow**: It receives a member key and an ordered map of field keys to values. For each field, it checks that the field key and value use allowed characters, then formats the pair as key:value. It joins all field pairs with semicolons, checks that the final member value is safe for a header, and returns the member key plus encoded value. If anything is invalid, it returns an error built by invalid_tracestate_config.

**Call relations**: validate_tracestate_member calls this before OpenTelemetry validation. Inside, it relies on is_configured_tracestate_field_key, is_configured_tracestate_field_value, and is_header_safe_tracestate_member_value to make the character rules clear and reusable.

*Call graph*: calls 4 internal fn (invalid_tracestate_config, is_configured_tracestate_field_key, is_configured_tracestate_field_value, is_header_safe_tracestate_member_value); called by 1 (validate_tracestate_member); 2 external calls (with_capacity, format!).


##### `is_configured_tracestate_field_key`  (lines 238–243)

```
fn is_configured_tracestate_field_key(field_key: &str) -> bool
```

**Purpose**: This checks whether one configured tracestate field name is allowed. Field names must be non-empty and must avoid separator characters that would confuse later parsing.

**Data flow**: It receives a field key string. It returns true only if every byte is a visible ASCII character and none of the bytes are colon, semicolon, comma, or equals sign. Otherwise it returns false.

**Call relations**: encode_tracestate_member_fields calls this for every configured field key. A false result causes encoding to stop with a configuration error.

*Call graph*: called by 1 (encode_tracestate_member_fields).


##### `is_configured_tracestate_field_value`  (lines 245–249)

```
fn is_configured_tracestate_field_value(value: &str) -> bool
```

**Purpose**: This checks whether one configured tracestate field value can safely appear inside the project’s semicolon-separated field format.

**Data flow**: It receives a value string. It returns true only if every byte is allowed in a tracestate member value and no byte is a semicolon, because semicolon is used here to separate fields.

**Call relations**: encode_tracestate_member_fields calls this for every configured field value. It helps prevent one value from accidentally breaking the structure of the encoded member.

*Call graph*: called by 1 (encode_tracestate_member_fields).


##### `is_header_safe_tracestate_member_value`  (lines 251–255)

```
fn is_header_safe_tracestate_member_value(value: &str) -> bool
```

**Purpose**: This checks the final encoded tracestate member value before it is sent as part of a header. It makes sure the value obeys the broader W3C header safety rules.

**Data flow**: It receives the complete encoded member value. It accepts an empty value, or a value whose bytes are all valid tracestate member value bytes and whose final byte is not a space. It returns true or false.

**Call relations**: encode_tracestate_member_fields calls this after joining all fields. This final check catches problems that might not be visible when looking at individual fields alone.

*Call graph*: called by 1 (encode_tracestate_member_fields).


##### `is_tracestate_member_value_byte`  (lines 257–259)

```
fn is_tracestate_member_value_byte(byte: u8) -> bool
```

**Purpose**: This is the basic byte-level rule for characters allowed in a tracestate member value. It keeps commas and equals signs out because those characters have special meaning in the tracestate header format.

**Data flow**: It receives one byte. It returns true if the byte is in the printable ASCII range from space through tilde and is not comma or equals sign; otherwise it returns false.

**Call relations**: The value-checking helpers use this rule to decide whether configured tracestate values are safe for headers. It is the small shared test underneath those higher-level checks.

*Call graph*: 1 external calls (matches!).


##### `invalid_tracestate_config`  (lines 261–266)

```
fn invalid_tracestate_config(message: String) -> Box<dyn std::error::Error>
```

**Purpose**: This builds a standard error for bad tracestate configuration. It gives callers a consistent InvalidInput error when validation fails.

**Data flow**: It receives an error message string. It wraps that message in an input-validation I/O error and boxes it as a general error object. The returned error can travel through functions that use a broad error type.

**Call relations**: encode_tracestate_member_fields calls this whenever it finds an invalid field key, field value, or final encoded value.

*Call graph*: called by 1 (encode_tracestate_member_fields); 2 external calls (new, new).


##### `merge_tracestate_member_fields`  (lines 268–300)

```
fn merge_tracestate_member_fields(
    existing: Option<&str>,
    configured_fields: &BTreeMap<String, String>,
) -> String
```

**Purpose**: This merges configured fields into one tracestate member value without throwing away unrelated existing fields. It is like updating selected entries in a note while leaving the rest of the note intact.

**Data flow**: It receives an optional existing member value and a map of configured fields. It splits the existing value on semicolons, replaces any matching key:value fields with configured values, remembers which field keys were already seen, keeps unrelated fields as they were, then appends configured fields that were missing. It returns the merged member value as a semicolon-separated string.

**Call relations**: merge_tracestate_entries calls this for each configured tracestate member. This function performs the fine-grained field update that lets the outer merge preserve existing tracestate data.

*Call graph*: called by 1 (merge_tracestate_entries); 3 external calls (new, new, format!).


##### `tests::parses_valid_w3c_trace_context`  (lines 319–336)

```
fn parses_valid_w3c_trace_context()
```

**Purpose**: This test proves that a valid W3C traceparent string is parsed into the expected OpenTelemetry trace ID and span ID. It also checks that the parsed context is marked as remote, meaning it came from outside this process.

**Data flow**: It builds a W3cTraceContext with known trace and span IDs, calls context_from_w3c_trace_context, and inspects the resulting span context. The expected output is a context whose trace ID and span ID match the input strings.

**Call relations**: This test exercises context_from_w3c_trace_context as the public object-based parsing path. It confirms that valid incoming trace data survives the conversion accurately.

*Call graph*: calls 1 internal fn (context_from_w3c_trace_context); 3 external calls (assert!, assert_eq!, format!).


##### `tests::invalid_traceparent_returns_none`  (lines 339–343)

```
fn invalid_traceparent_returns_none()
```

**Purpose**: This test proves that malformed traceparent text is rejected. That matters because accepting bad trace IDs could corrupt trace relationships.

**Data flow**: It passes the string not-a-traceparent as the traceparent input and no tracestate. The expected result is None, meaning no context is produced.

**Call relations**: The test checks the same low-level parsing behavior used by context_from_trace_headers. It protects the rule that invalid incoming headers must not become parent trace contexts.

*Call graph*: 1 external calls (assert!).


##### `tests::missing_traceparent_returns_none`  (lines 346–354)

```
fn missing_traceparent_returns_none()
```

**Purpose**: This test proves that tracestate alone is not enough to create a trace context. The traceparent value is required because it carries the main trace identity.

**Data flow**: It builds a W3cTraceContext with no traceparent and a sample tracestate value, then asks for a context. The expected result is None.

**Call relations**: This test exercises context_from_w3c_trace_context and, through it, the lower-level header parsing rule that traceparent must be present.

*Call graph*: 1 external calls (assert!).


##### `tests::current_span_trace_id_returns_hex_trace_id`  (lines 357–371)

```
fn current_span_trace_id_returns_hex_trace_id()
```

**Purpose**: This test proves that current_span_trace_id returns a real trace ID when tracing is properly set up. It checks both the shape and non-zero content of the ID.

**Data flow**: It creates an OpenTelemetry tracer provider, connects it to the tracing subscriber, enters a test span, and calls current_span_trace_id. The expected output is a 32-character hexadecimal string that is not all zeroes.

**Call relations**: This test calls current_span_trace_id in a live tracing setup. It confirms that the helper works with the tracing/OpenTelemetry integration rather than only with hand-built data.

*Call graph*: calls 1 internal fn (current_span_trace_id); 7 external calls (builder, assert!, assert_eq!, assert_ne!, trace_span!, layer, registry).


### `otel/src/events/mod.rs`

`orchestration` · `compile-time module wiring`

This is a small module index file. In Rust, a `mod.rs` file often works like a table of contents for a folder: it does not contain the event logic itself, but it names the files that make up this part of the system. Here, it includes two internal modules: `session_telemetry`, which likely contains event code tied to recording or reporting session activity, and `shared`, which likely holds common event pieces used by more than one event module. The `pub(crate)` wording means these modules are visible inside this crate, but not exposed as part of the public API to outside users. Without this file, Rust would not know to compile and connect these event modules under `otel::events`, so other internal code would not be able to refer to them through that path. Its job is simple but important: it keeps the event subsystem organized and gives the rest of the crate a stable place to find event-related building blocks.


### `otel/src/events/shared.rs`

`util` · `cross-cutting telemetry emission`

This file is like a standard form used whenever the system writes an event for observability. Observability means recording what the program is doing so people can debug problems, audit behavior, or understand usage later.

The main pieces are three macros: `log_event!`, `trace_event!`, and `log_and_trace_event!`. A macro is code that writes other code at compile time, which lets the project avoid repeating the same long list of event fields everywhere. `log_event!` sends an event to a log-only target and includes user account and email fields. `trace_event!` sends a similar event to a trace-safe target, but leaves out the more sensitive user identity fields. `log_and_trace_event!` writes both versions at once: shared fields go to both, while log-only and trace-only fields can be kept separate.

Each event gets a timestamp from this file’s `timestamp` function. It also pulls common metadata from `$self.metadata`, such as the conversation, app version, authentication mode, originator, terminal type, model, and slug. Without this file, every event writer would have to remember to attach these fields by hand, which would make telemetry inconsistent and easier to get wrong.

#### Function details

##### `timestamp`  (lines 58–60)

```
fn timestamp() -> String
```

**Purpose**: Creates the current time as a text string in a standard internet-friendly format. Event-writing code uses it so every telemetry record can say exactly when it happened.

**Data flow**: It takes no input from the caller. It reads the current UTC time from the system clock, formats it as an RFC 3339 timestamp with millisecond precision, and returns that formatted string.

**Call relations**: When the event macros in this file build a log or trace record, they ask `timestamp` for the event time. `timestamp` delegates the actual clock reading to Chrono’s `Utc::now`, then hands the formatted time back so it can be attached to the event.

*Call graph*: 1 external calls (now).


### Transport telemetry callbacks
These files define the callback traits and wrappers that let client and API transport layers report request-attempt telemetry to observers.

### `codex-client/src/telemetry.rs`

`data_model` · `cross-cutting request reporting`

This file is a contract, not a full working component by itself. It defines `RequestTelemetry`, a trait, which is Rust’s way of saying “anything that follows this shape can be used here.” The rest of the client can call this trait after an API request attempt and pass along what happened: which attempt number it was, whether an HTTP status code came back, whether there was a transport error, and how long the attempt took.

In plain terms, this is like a delivery driver filling out a short trip note after each delivery try: “first attempt, got a 500 response, no network error, took two seconds.” Different parts of the system can then decide what to do with that note. One implementation might log it to a file. Another might send it to a metrics system. Another might ignore it.

The important design choice is separation. The network code does not need to know where telemetry goes or how it is stored. It only needs to call `on_request` with the facts. The trait is marked `Send + Sync`, meaning implementations must be safe to share across threads or tasks, which matters because API clients often make requests from asynchronous or concurrent code.


### `codex-api/src/telemetry.rs`

`io_transport` · `request handling and cross-cutting telemetry`

This file is about observability: helping the rest of the system know what happened during API communication, how long it took, and whether it failed. Without it, requests could still be sent, but the program would lose useful timing and error information, especially when a request is retried.

It defines small telemetry interfaces for two streaming styles. Server-sent events, or SSE, are a way for a server to keep sending events over one HTTP connection. WebSockets are a two-way live connection, more like a phone call than a mailed letter. The traits in this file let another part of the program plug in code that records when those streams are polled, when WebSocket requests finish, and when WebSocket messages arrive.

For normal HTTP responses, the file introduces a tiny shared idea: anything that has an HTTP status code can expose it through `WithStatus`. Both regular responses and streaming responses use this. That lets the main wrapper, `run_with_request_telemetry`, treat them the same way.

The main flow is: make a request, send it through the existing retry helper, measure each attempt with a clock, then report the attempt number, status code if there is one, error if any, and elapsed time. It is like putting a stopwatch and note card beside every delivery attempt.

#### Function details

##### `http_status`  (lines 49–54)

```
fn http_status(err: &TransportError) -> Option<StatusCode>
```

**Purpose**: This helper tries to pull an HTTP status code out of a transport error. It is used when a request failed but the server still gave a meaningful HTTP response code, such as 429 or 500.

**Data flow**: It receives a `TransportError`, which represents something that went wrong while communicating with the API. If the error is specifically an HTTP error, it takes out the status code and returns it. For non-HTTP failures, such as connection-level problems, it returns nothing.

**Call relations**: During `run_with_request_telemetry`, a failed request attempt is inspected before telemetry is reported. This helper supplies the status code when one exists, so the telemetry record can say not just that the attempt failed, but also what the server answered with.


##### `Response::status`  (lines 57–59)

```
fn status(&self) -> StatusCode
```

**Purpose**: This gives a regular API response a common way to reveal its HTTP status code. It lets generic telemetry code read the status without needing to know the exact response type.

**Data flow**: It reads the `status` field already stored inside the `Response` and returns that HTTP status code unchanged. It does not modify the response.

**Call relations**: When `run_with_request_telemetry` receives a successful regular response, it calls this shared `status` behavior through the `WithStatus` trait. That lets the telemetry wrapper report the status code for successful attempts.


##### `StreamResponse::status`  (lines 63–65)

```
fn status(&self) -> StatusCode
```

**Purpose**: This gives a streaming API response the same status-code access as a regular response. It allows the telemetry wrapper to treat streaming and non-streaming HTTP calls uniformly.

**Data flow**: It reads the `status` field from the `StreamResponse` and returns it as the HTTP status code. The streaming response itself is not changed.

**Call relations**: When `run_with_request_telemetry` is used for a streaming call, a successful `StreamResponse` can still be measured and reported just like a regular response. This is important because `run_with_request_telemetry` is called by both ordinary execution code and streaming JSON code.


##### `run_with_request_telemetry`  (lines 68–98)

```
async fn run_with_request_telemetry(
    policy: RetryPolicy,
    telemetry: Option<Arc<dyn RequestTelemetry>>,
    make_request: impl FnMut() -> Request,
    send: F,
) -> Result<T, TransportError>
```

**Purpose**: This function sends an API request with retry support while recording timing and result details for every attempt. It is the bridge between the retry system and the telemetry system.

**Data flow**: It receives a retry policy, optional telemetry recorder, a way to build a fresh request, and a function that actually sends the request. For each attempt, it starts a timer, sends the request, checks whether the result was a successful response or an error, extracts the HTTP status when possible, reports the attempt to telemetry if telemetry is enabled, and finally returns the same success or failure result produced by the retry process.

**Call relations**: Higher-level request paths such as `execute_with` and `stream_encoded_json_with` call this when they need to perform an API call. Inside, it hands the retry work to `run_with_retry`, but wraps each send attempt with measurement and reporting. It uses `Response::status` or `StreamResponse::status` for successful calls, and `http_status` for failed HTTP calls, so the telemetry recorder gets a clear account of each attempt.

*Call graph*: called by 2 (execute_with, stream_encoded_json_with); 1 external calls (run_with_retry).
