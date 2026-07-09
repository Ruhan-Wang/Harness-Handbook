# OpenTelemetry runtime, provider, and metrics foundations  `stage-20.2`

This stage is the shared observability toolbox for the whole system. It mostly sits behind the scenes during startup and then stays available while the app runs. Its job is to turn user telemetry settings into working tracing, logging, and metrics: tracing follows a request’s path, logging records notable events, and metrics count and time things.

It starts with configuration. core/src/config/otel.rs cleans up user TOML settings and turns bad tracing metadata into warnings instead of blocking startup. core/src/otel_init.rs and otel/src/provider.rs then assemble the real OpenTelemetry provider, choose exporters, install global handlers, add standard resource information, and shut things down cleanly later. otel/src/otlp.rs builds the network pieces used to send telemetry out.

The metrics files provide a small measurement system: config, names, tags, validation, errors, the main client, timers, one-time process-start reporting, and runtime snapshot summaries. Together they make sure metric names and labels are safe and consistent before recording anything.

trace_context.rs carries tracing IDs across process boundaries so related work can be linked. events/shared.rs standardizes session event emission. targets.rs decides what becomes a log versus a trace. The telemetry trait files in codex-client and codex-api let transport code report request-attempt details to outside observers.

## Files in this stage

### Runtime configuration bridge
These files sanitize user-facing OTEL settings and translate them into the concrete runtime provider configuration used during startup.

### `core/src/config/otel.rs`

`config` · `startup/config load`

This module is a small config-normalization layer for OTEL settings. Its top-level `resolve_config` function converts `OtelConfigToml` into the runtime `OtelConfig`, filling defaults for `log_user_prompt`, `environment`, exporter kinds, and metrics exporter, while treating trace metadata specially because OTEL provider initialization installs process-global state.

The key design choice is that invalid span attributes or tracestate entries do not abort startup. `resolve_span_attributes` iterates each configured key/value pair, validates each singleton attribute map with `codex_otel::validate_span_attributes`, and drops only the invalid entries while recording a warning. `resolve_tracestate_member_fields` performs similar per-field filtering for each tracestate member, and `resolve_tracestate` then validates both each member and the final combined tracestate map. If the combined tracestate is invalid even after per-entry filtering, the entire tracestate is discarded and replaced with an empty map.

Warnings are centralized through `push_invalid_config_warning`, which logs via `tracing::warn!` and appends a human-readable message to the mutable `startup_warnings` vector supplied by the caller. This makes OTEL config resilient: malformed metadata is surfaced to the user but cannot poison global telemetry initialization.

#### Function details

##### `resolve_config`  (lines 9–37)

```
fn resolve_config(
    config: OtelConfigToml,
    startup_warnings: &mut Vec<String>,
) -> OtelConfig
```

**Purpose**: Builds the runtime OTEL config from TOML, applying defaults and sanitizing user-provided trace metadata.

**Data flow**: It reads fields from `OtelConfigToml`, defaulting `log_user_prompt`, `environment`, `exporter`, `trace_exporter`, and `metrics_exporter`, then calls `resolve_span_attributes` and `resolve_tracestate` with the mutable warning vector. It returns a populated `OtelConfig`.

**Call relations**: The main config loader calls this near the end of `Config::load_config_with_layer_stack` so telemetry config is ready for provider initialization.

*Call graph*: calls 2 internal fn (resolve_span_attributes, resolve_tracestate); called by 1 (load_config_with_layer_stack).


##### `resolve_span_attributes`  (lines 39–58)

```
fn resolve_span_attributes(
    span_attributes: Option<BTreeMap<String, String>>,
    startup_warnings: &mut Vec<String>,
) -> BTreeMap<String, String>
```

**Purpose**: Filters configured OTEL span attributes down to only those that pass validation.

**Data flow**: It takes an optional `BTreeMap<String, String>` and mutable warnings. `None` returns an empty map. Otherwise it validates each single-entry attribute map with `codex_otel::validate_span_attributes`; valid entries are inserted into a new map, invalid ones trigger `push_invalid_config_warning` and are skipped.

**Call relations**: This helper is called only by `resolve_config`.

*Call graph*: calls 1 internal fn (push_invalid_config_warning); called by 1 (resolve_config); 3 external calls (from, new, validate_span_attributes).


##### `resolve_tracestate`  (lines 60–90)

```
fn resolve_tracestate(
    tracestate: Option<BTreeMap<String, BTreeMap<String, String>>>,
    startup_warnings: &mut Vec<String>,
) -> BTreeMap<String, BTreeMap<String, String>>
```

**Purpose**: Filters and validates the configured OTEL tracestate structure at both member and whole-header levels.

**Data flow**: It takes an optional nested `BTreeMap` and mutable warnings. `None` returns an empty map. Otherwise it iterates each member, filters its fields through `resolve_tracestate_member_fields`, skips empty members, validates each remaining member with `validate_tracestate_member`, inserts valid members into a new map, then validates the combined map with `validate_tracestate_entries`. If the combined validation fails, it warns and returns an empty map.

**Call relations**: This helper is called only by `resolve_config` and encapsulates the stricter multi-stage tracestate validation logic.

*Call graph*: calls 2 internal fn (push_invalid_config_warning, resolve_tracestate_member_fields); called by 1 (resolve_config); 3 external calls (new, validate_tracestate_entries, validate_tracestate_member).


##### `resolve_tracestate_member_fields`  (lines 92–107)

```
fn resolve_tracestate_member_fields(
    member_key: &str,
    fields: BTreeMap<String, String>,
    startup_warnings: &mut Vec<String>,
) -> BTreeMap<String, String>
```

**Purpose**: Filters a single tracestate member’s fields down to those that are individually valid for that member key.

**Data flow**: It iterates the provided field map, validates each singleton field map with `validate_tracestate_member(member_key, &field)`, inserts valid fields into a new map, and warns-and-skips invalid ones.

**Call relations**: It is used by `resolve_tracestate` before whole-member and whole-tracestate validation.

*Call graph*: calls 1 internal fn (push_invalid_config_warning); called by 1 (resolve_tracestate); 3 external calls (from, new, validate_tracestate_member).


##### `push_invalid_config_warning`  (lines 109–117)

```
fn push_invalid_config_warning(
    config_key: &str,
    err: impl Display,
    startup_warnings: &mut Vec<String>,
)
```

**Purpose**: Records a standardized warning message for invalid OTEL config and emits it to tracing logs.

**Data flow**: It formats `Ignoring invalid `{config_key}` config: {err}`, logs that message with `tracing::warn!`, and pushes the same string into the mutable `startup_warnings` vector.

**Call relations**: All OTEL validation helpers delegate warning emission here so startup diagnostics are consistent.

*Call graph*: called by 3 (resolve_span_attributes, resolve_tracestate, resolve_tracestate_member_fields); 2 external calls (format!, warn!).


### `core/src/otel_init.rs`

`orchestration` · `startup`

This file converts `crate::config::Config` into a `codex_otel::OtelSettings` value and asks `OtelProvider::from` to construct the actual telemetry provider. The main work is in `build_provider`, which translates `codex_config::types::OtelExporterKind` variants into `codex_otel::OtelExporter` variants, including protocol conversion from `OtelHttpProtocol` config enums and cloning endpoint/header/TLS certificate material into the OTEL runtime types. It computes three exporters separately: a general exporter, a trace exporter, and a metrics exporter; metrics are forcibly disabled by returning `OtelExporter::None` when `analytics_enabled` resolves false, even if a metrics exporter is configured. The function also derives the service name from either an explicit override or the login-originator identity, and enables runtime metrics only when the `Feature::RuntimeMetrics` feature flag is on.

The remaining helpers are intentionally defensive: both `record_process_start` and `install_sqlite_telemetry` first extract the metrics handle from an optional provider and become no-ops when metrics are unavailable. `codex_export_filter` is a narrow tracing predicate that only allows events whose target begins with `codex_otel`, preventing unrelated tracing events from being exported through this path.

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

**Purpose**: Constructs an `Option<OtelProvider>` from application config, translating exporter, protocol, TLS, feature-flag, and service identity settings into `codex_otel::OtelSettings`. It also enforces the product rule that metrics export is disabled when analytics are off.

**Data flow**: Inputs are `&Config`, `service_version`, optional `service_name_override`, and a `default_analytics_enabled` fallback. It reads `config.otel.*`, `config.analytics_enabled`, `config.features`, and `config.codex_home`; maps config exporter enums into `OtelExporter` values by cloning endpoints, headers, and TLS certificate paths/bytes; derives the service name from the override or `originator().value`; then packages everything into `OtelSettings` and passes that to `OtelProvider::from`. It returns either `Ok(Some(provider))`, `Ok(None)` if OTEL is disabled by the provider constructor, or an error boxed as `Box<dyn Error>`.

**Call relations**: This is invoked during application/server initialization paths and OTEL-focused tests. Those callers use it before the main runtime begins so later startup code can record process metrics and install DB telemetry. Internally it delegates only to the login-originator helper for default naming and to `OtelProvider::from` for the actual provider creation.

*Call graph*: calls 2 internal fn (originator, from); called by 6 (initialize, run_main_with_transport_options, app_server_default_analytics_disabled_without_flag, app_server_default_analytics_enabled_with_flag, run_main, mcp_server_builds_otel_provider_with_logs_traces_and_metrics).


##### `codex_export_filter`  (lines 99–101)

```
fn codex_export_filter(meta: &tracing::Metadata<'_>) -> bool
```

**Purpose**: Implements a tracing metadata predicate that keeps only Codex-owned OTEL events. It is a simple target-prefix filter rather than a broader severity or module tree policy.

**Data flow**: It takes `&tracing::Metadata<'_>`, reads `meta.target()`, checks whether the target string starts with `"codex_otel"`, and returns that boolean. It does not mutate any state or emit side effects.

**Call relations**: This function is used wherever a tracing subscriber or exporter needs a filter callback for OTEL-bound events. It does not delegate beyond reading the metadata target.

*Call graph*: 1 external calls (target).


##### `record_process_start`  (lines 103–108)

```
fn record_process_start(otel: Option<&OtelProvider>, originator: &str)
```

**Purpose**: Records a one-time process-start metric when a metrics-capable OTEL provider is available. It intentionally exits silently when telemetry is absent or metrics export is disabled.

**Data flow**: Inputs are `Option<&OtelProvider>` and an `originator` string. It reads the provider's metrics handle via `OtelProvider::metrics`; if absent it returns immediately, otherwise it passes the metrics handle and originator to `codex_otel::record_process_start_once` and ignores that call's result.

**Call relations**: Startup entrypoints call this after OTEL initialization so process lifecycle metrics are emitted early. Its only downstream work is the external one-shot recorder, which encapsulates deduplication and metric emission.

*Call graph*: called by 3 (run_main_with_transport_options, run_main, run_main); 1 external calls (record_process_start_once).


##### `install_sqlite_telemetry`  (lines 110–116)

```
fn install_sqlite_telemetry(otel: Option<&OtelProvider>, originator: &str)
```

**Purpose**: Installs a SQLite/process DB telemetry recorder backed by the OTEL metrics pipeline. Like the process-start helper, it is a no-op when metrics are unavailable.

**Data flow**: It accepts `Option<&OtelProvider>` and an `originator` string, extracts the metrics handle if present, clones that handle into `codex_rollout::sqlite_telemetry_recorder`, then passes the resulting recorder into `codex_state::install_process_db_telemetry`. It returns `()` and discards installation errors.

**Call relations**: Main startup flows call this after provider creation so later SQLite/state DB activity can emit metrics. It delegates first to rollout code to build the recorder object and then to state-layer installation code to register it process-wide.

*Call graph*: called by 3 (run_main_with_transport_options, run_main, run_main); 2 external calls (sqlite_telemetry_recorder, install_process_db_telemetry).


### Provider and crate surface
These files define the OTEL crate’s public integration boundary and construct the process-wide tracing, logging, and metrics providers from resolved settings.

### `otel/src/config.rs`

`config` · `configuration resolution and validation`

This configuration module holds both constants and data structures for OTEL setup. At the top are the built-in Statsig OTLP HTTP endpoint and API-key header/value constants. `resolve_exporter` is the main policy function: when given `OtelExporter::Statsig`, it expands that symbolic choice into a concrete `OtelExporter::OtlpHttp` using the built-in endpoint, a one-entry `HashMap` containing the Statsig API key header, JSON protocol, and no TLS configuration. However, in debug builds it intentionally resolves `Statsig` to `OtelExporter::None` so local development and tests do not emit best-effort telemetry unless explicitly configured. Any other exporter variant is cloned through unchanged.

`validate_span_attributes` performs the only explicit validation in this file, rejecting any configured span-attribute map whose keys contain the empty string with `io::ErrorKind::InvalidInput`. The rest of the file is mostly data model: `OtelSettings` aggregates resolved runtime settings such as environment, service identity, exporter choices, runtime metrics flag, span attributes, and tracestate; `StatsigMetricsSettings` is a serializable subset intended for recreating built-in metrics exporter configuration in another process; `OtelHttpProtocol` distinguishes binary protobuf vs JSON OTLP/HTTP; `OtelTlsConfig` carries optional certificate/key paths; and `OtelExporter` enumerates `None`, symbolic `Statsig`, and concrete OTLP gRPC/HTTP exporters. The test asserts the debug-build suppression policy for `Statsig`.

#### Function details

##### `resolve_exporter`  (lines 13–36)

```
fn resolve_exporter(exporter: &OtelExporter) -> OtelExporter
```

**Purpose**: Resolves symbolic exporter choices into concrete exporter settings, with special handling for the built-in Statsig metrics exporter. In debug builds it disables that default entirely.

**Data flow**: Takes `exporter: &OtelExporter` and pattern-matches it. For `OtelExporter::Statsig`, it checks `cfg!(debug_assertions)`; if true it returns `OtelExporter::None`, otherwise it constructs and returns `OtelExporter::OtlpHttp { endpoint: STATSIG_OTLP_HTTP_ENDPOINT.to_string(), headers: HashMap::from([(STATSIG_API_KEY_HEADER.to_string(), STATSIG_API_KEY.to_string())]), protocol: OtelHttpProtocol::Json, tls: None }`. For all other variants it returns `exporter.clone()`.

**Call relations**: This resolver is called by exporter-building code such as `build_otlp_metric_exporter`, `build_logger`, `build_tracer_provider`, and configuration conversion logic. It centralizes the only place where the symbolic `Statsig` variant becomes concrete transport settings.

*Call graph*: called by 4 (build_otlp_metric_exporter, from, build_logger, build_tracer_provider); 3 external calls (from, cfg!, clone).


##### `validate_span_attributes`  (lines 39–48)

```
fn validate_span_attributes(attributes: &BTreeMap<String, String>) -> std::io::Result<()>
```

**Purpose**: Checks that configured span-attribute keys are non-empty before those attributes are attached to exported spans. It enforces a minimal but important input invariant.

**Data flow**: Consumes `attributes: &BTreeMap<String, String>`, scans `attributes.keys()` for any empty string via `String::is_empty`, and if found returns `Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "configured span attribute key must not be empty"))`; otherwise it returns `Ok(())`.

**Call relations**: It is called during configuration construction (`from`) before OTEL settings are accepted. The function is intentionally narrow and leaves all other semantic validation to higher layers or downstream exporters.

*Call graph*: called by 1 (from); 1 external calls (new).


##### `tests::statsig_default_metrics_exporter_is_disabled_in_debug_builds`  (lines 113–118)

```
fn statsig_default_metrics_exporter_is_disabled_in_debug_builds()
```

**Purpose**: Asserts the debug-build policy that the symbolic Statsig exporter resolves to `None` instead of a live OTLP endpoint. This prevents accidental telemetry emission during local development.

**Data flow**: Calls `resolve_exporter(&OtelExporter::Statsig)` and asserts the returned variant matches `OtelExporter::None`.

**Call relations**: This test directly targets the special-case branch in `resolve_exporter` and documents the intended debug-only behavior.

*Call graph*: 1 external calls (assert!).


### `otel/src/lib.rs`

`orchestration` · `startup and cross-cutting import surface used throughout the process`

This crate root wires together the telemetry package's modules and exposes the stable API consumed by the rest of the application. Most of the file is re-exports: exporter/config types, `SessionTelemetry` and its metadata structs, runtime metrics summaries, timers, the metrics API, the `OtelProvider`, trace-context helpers, and the shared `sanitize_metric_tag_value` utility. It also defines two small enums used across telemetry boundaries. `ToolDecisionSource` is a serializable/displayable source label for tool approval decisions. `TelemetryAuthMode` is a reduced auth-mode enum intentionally decoupled from `codex-core`; its `From<codex_app_server_protocol::AuthMode>` implementation collapses several upstream auth variants into either `ApiKey` or `Chatgpt` to avoid a circular dependency while preserving telemetry semantics.

The two free functions are convenience accessors over global metrics state. `start_global_timer` starts a `Timer` using the globally installed metrics client and returns `ExporterDisabled` if no global client exists. `global_statsig_metrics_settings` exposes the resolved Statsig metrics settings only when the active global exporter is Statsig. Overall, this file is mostly API shaping and dependency-boundary management rather than feature logic.

#### Function details

##### `TelemetryAuthMode::from`  (lines 55–64)

```
fn from(mode: codex_app_server_protocol::AuthMode) -> Self
```

**Purpose**: Converts the broader app-server auth-mode enum into the telemetry crate's reduced two-variant representation. It groups multiple upstream modes into the telemetry categories `ApiKey` and `Chatgpt`.

**Data flow**: Consumes a `codex_app_server_protocol::AuthMode`, pattern-matches it, maps `ApiKey` and `BedrockApiKey` to `TelemetryAuthMode::ApiKey`, maps `Chatgpt`, `ChatgptAuthTokens`, `AgentIdentity`, and `PersonalAccessToken` to `TelemetryAuthMode::Chatgpt`, and returns the chosen enum variant.

**Call relations**: This adapter is used when constructing session telemetry so auth mode can be recorded without importing the upstream protocol type everywhere.


##### `start_global_timer`  (lines 68–73)

```
fn start_global_timer(name: &str, tags: &[(&str, &str)]) -> MetricsResult<Timer>
```

**Purpose**: Starts a metrics timer using the globally installed metrics client. It provides a crate-level shortcut for code that does not already hold a `SessionTelemetry` or `MetricsClient`.

**Data flow**: Reads `crate::metrics::global()`. If no global client is installed, returns `Err(MetricsError::ExporterDisabled)`; otherwise forwards `name` and `tags` to `metrics.start_timer` and returns the resulting `Timer`.

**Call relations**: It is a convenience wrapper over the global metrics singleton, used by callers that want scoped timing without threading a metrics client through their APIs.

*Call graph*: calls 1 internal fn (global).


##### `global_statsig_metrics_settings`  (lines 77–79)

```
fn global_statsig_metrics_settings() -> Option<StatsigMetricsSettings>
```

**Purpose**: Returns the globally installed Statsig metrics settings when the active metrics exporter is Statsig. It exposes resolved exporter-specific configuration to external callers.

**Data flow**: Calls `crate::metrics::global_statsig_settings()` and returns its `Option<StatsigMetricsSettings>` unchanged.

**Call relations**: This is the public accessor layered over the internal global settings store in `metrics/mod.rs`.

*Call graph*: calls 1 internal fn (global_statsig_settings).


### `otel/src/provider.rs`

`orchestration` · `startup, global telemetry installation, and teardown`

This file is the top-level OTEL orchestration layer. `OtelProvider` bundles optional logger, tracer provider, tracer, and metrics client handles so the rest of the application can install subscriber layers and later flush/shutdown exporters. The central `OtelProvider::from` method interprets `OtelSettings`, resolves exporter aliases, validates trace-related configuration before mutating any process-global state, and short-circuits to `Ok(None)` when logs, traces, and metrics are all disabled. When enabled, it builds metrics via `MetricsConfig::otlp`, optionally enabling runtime metrics, creates separate `Resource` values for logs and traces, constructs the logger and tracer provider, derives a named tracer, installs configured tracestate globally, and registers global tracer/propagator and metrics handles.

Resource construction is intentionally split: `make_resource` always includes service name, service version, and environment, but `resource_attributes` only adds `host.name` for log resources and only when a trimmed hostname is non-empty. Trace providers can also attach configured span attributes through `SpanAttributesProcessor`, which injects each configured key/value pair in `on_start` and otherwise acts as a no-op processor.

Exporter setup is protocol-aware. `build_logger` and `build_tracer_provider` branch across `None`, OTLP gRPC, and OTLP HTTP, wiring headers, TLS, protocol selection, and either blocking or async HTTP clients. Trace HTTP export has an extra runtime-sensitive path: on a multi-thread Tokio runtime it uses `build_async_http_client` and `TokioBatchSpanProcessor`; otherwise it falls back to blocking HTTP plus the standard batch processor. Both explicit `shutdown` and `Drop` flush and shut down tracer, metrics, and logger in that order, making cleanup best-effort and idempotent from the caller’s perspective.

#### Function details

##### `OtelProvider::shutdown`  (lines 64–75)

```
fn shutdown(&self)
```

**Purpose**: Flushes and shuts down any active tracer provider, metrics client, and logger provider owned by the `OtelProvider`. It ignores individual shutdown errors so teardown remains best-effort.

**Data flow**: Reads `self.tracer_provider`, `self.metrics`, and `self.logger` → if present, calls tracer `force_flush()` then `shutdown()`, metrics `shutdown()`, and logger `shutdown()` → discards all returned errors and returns `()`.

**Call relations**: Callers use this for explicit teardown before process exit. Its logic mirrors the `Drop` implementation so cleanup happens whether shutdown is invoked manually or implicitly.


##### `OtelProvider::from`  (lines 77–154)

```
fn from(settings: &OtelSettings) -> Result<Option<Self>, Box<dyn Error>>
```

**Purpose**: Builds an `OtelProvider` from configuration, including metrics, log exporter, trace exporter, global propagator state, and optional Statsig metrics settings. It is the main entry point for enabling telemetry in the process.

**Data flow**: Consumes `&OtelSettings` → computes whether logs, traces, and metrics are enabled by resolving exporter settings → if all disabled, clears global tracestate entries and returns `Ok(None)` → otherwise validates configured span attributes when traces are enabled and validates tracestate entries unconditionally → optionally builds a `MetricsClient` from `MetricsConfig::otlp`, adding a runtime reader when requested → builds log and trace `Resource`s via `make_resource` → conditionally builds logger and tracer provider, derives a tracer from the provider, installs tracestate entries globally, installs the global tracer provider and `TraceContextPropagator` when tracing is enabled, installs global metrics and optional Statsig settings when metrics are enabled → returns `Ok(Some(OtelProvider { ... }))` or the first setup error.

**Call relations**: Higher-level provider/bootstrap code and integration tests call this to initialize telemetry. It delegates concrete resource creation to `make_resource`, exporter construction to `build_logger` and `build_tracer_provider`, metrics creation to `MetricsClient::new`, and global state updates to the metrics and trace-context modules.

*Call graph*: calls 9 internal fn (resolve_exporter, validate_span_attributes, new, otlp, install_global, install_global_statsig_settings, make_resource, set_tracestate_entries, validate_tracestate_entries); called by 6 (build_provider, otel_provider_rejects_header_unsafe_configured_tracestate, otlp_http_exporter_sends_logs_to_collector, otlp_http_exporter_sends_traces_to_collector, otlp_http_exporter_sends_traces_to_collector_in_tokio_runtime, build_wfp_metrics_provider); 6 external calls (new, new, debug!, set_text_map_propagator, set_tracer_provider, matches!).


##### `OtelProvider::logger_layer`  (lines 156–165)

```
fn logger_layer(&self) -> Option<impl Layer<S> + Send + Sync>
```

**Purpose**: Builds a tracing-subscriber layer that forwards tracing events into the OTEL logger provider. The layer is only returned when logging is enabled.

**Data flow**: Reads `self.logger` → if present, wraps it in `OpenTelemetryTracingBridge::new(logger)` and applies a filter function using `OtelProvider::log_export_filter` → returns `Some(layer)`; otherwise returns `None`.

**Call relations**: Subscriber setup code calls this after `OtelProvider::from` to attach OTEL log export to the tracing registry. It depends on `log_export_filter` to exclude targets that should not be exported as logs.


##### `OtelProvider::tracing_layer`  (lines 167–178)

```
fn tracing_layer(&self) -> Option<impl Layer<S> + Send + Sync>
```

**Purpose**: Builds a tracing-subscriber layer that exports tracing spans through the configured OTEL tracer. The layer is only returned when tracing is enabled.

**Data flow**: Reads `self.tracer` → if present, creates `tracing_opentelemetry::layer()`, clones the tracer into it, and applies a filter function using `OtelProvider::trace_export_filter` → returns `Some(layer)`; otherwise `None`.

**Call relations**: Subscriber setup code uses this alongside `logger_layer` to export spans. It relies on `trace_export_filter` so only spans and explicitly trace-safe event targets are sent to tracing exporters.


##### `OtelProvider::codex_export_filter`  (lines 180–182)

```
fn codex_export_filter(meta: &tracing::Metadata<'_>) -> bool
```

**Purpose**: Provides a compatibility alias for the log export filter. It currently forwards directly to `log_export_filter`.

**Data flow**: Accepts tracing metadata → passes it unchanged to `Self::log_export_filter` → returns that boolean result.

**Call relations**: This function exists as a thin wrapper for callers that refer to a codex-specific export filter name. It delegates all actual filtering logic to `log_export_filter`.

*Call graph*: 1 external calls (log_export_filter).


##### `OtelProvider::log_export_filter`  (lines 184–186)

```
fn log_export_filter(meta: &tracing::Metadata<'_>) -> bool
```

**Purpose**: Determines whether a tracing event target should be exported as a log. It accepts only OTEL-prefixed targets that are not marked trace-safe.

**Data flow**: Reads `meta.target()` from tracing metadata → passes the target string to `is_log_export_target` → returns the resulting boolean.

**Call relations**: Used by `logger_layer` and indirectly by `codex_export_filter`. It delegates target-prefix policy to `targets.rs` so filtering rules stay centralized.

*Call graph*: calls 1 internal fn (is_log_export_target); 1 external calls (target).


##### `OtelProvider::trace_export_filter`  (lines 188–190)

```
fn trace_export_filter(meta: &tracing::Metadata<'_>) -> bool
```

**Purpose**: Determines whether tracing metadata should be exported through the trace pipeline. All spans are allowed, and non-span events are allowed only for trace-safe targets.

**Data flow**: Reads `meta.is_span()` and `meta.target()` → returns `true` if the metadata describes a span or if `is_trace_safe_target(meta.target())` is true; otherwise returns `false`.

**Call relations**: This filter is attached by `tracing_layer`. It combines tracing’s intrinsic span classification with the target-prefix policy from `targets.rs`.

*Call graph*: calls 1 internal fn (is_trace_safe_target); 2 external calls (is_span, target).


##### `OtelProvider::metrics`  (lines 192–194)

```
fn metrics(&self) -> Option<&MetricsClient>
```

**Purpose**: Exposes the optional metrics client owned by the provider. It lets callers access metrics only when metrics export was configured.

**Data flow**: Reads `self.metrics` and returns `self.metrics.as_ref()`, yielding `Option<&MetricsClient>`.

**Call relations**: Higher-level code that wants to emit metrics through the provider calls this accessor. It is a simple read-only view over state initialized by `OtelProvider::from`.

*Call graph*: called by 1 (with_provider_metrics).


##### `OtelProvider::drop`  (lines 198–209)

```
fn drop(&mut self)
```

**Purpose**: Performs best-effort flush and shutdown of telemetry components when the provider is dropped. It mirrors explicit shutdown so resources are cleaned up even without a manual call.

**Data flow**: On drop, reads the optional tracer provider, metrics client, and logger provider → calls tracer `force_flush()` and `shutdown()`, metrics `shutdown()`, and logger `shutdown()` if present → ignores all errors.

**Call relations**: Rust invokes this automatically when an `OtelProvider` goes out of scope. It duplicates `shutdown` rather than delegating, ensuring cleanup still occurs during implicit destruction.


##### `make_resource`  (lines 212–221)

```
fn make_resource(settings: &OtelSettings, kind: ResourceKind) -> Resource
```

**Purpose**: Builds an OpenTelemetry `Resource` for either logs or traces from shared settings plus optional detected host metadata. It centralizes the common resource-builder sequence.

**Data flow**: Takes `&OtelSettings` and `ResourceKind` → starts `Resource::builder()`, sets the service name from settings, computes attributes by calling `resource_attributes(settings, detected_host_name().as_deref(), kind)`, and builds the final `Resource`.

**Call relations**: Called by `OtelProvider::from` to create separate resources for logs and traces. It delegates hostname lookup to `detected_host_name` and attribute selection to `resource_attributes`.

*Call graph*: calls 2 internal fn (detected_host_name, resource_attributes); called by 1 (from); 1 external calls (builder).


##### `resource_attributes`  (lines 223–241)

```
fn resource_attributes(
    settings: &OtelSettings,
    host_name: Option<&str>,
    kind: ResourceKind,
) -> Vec<KeyValue>
```

**Purpose**: Computes the `KeyValue` list attached to a resource, always including service version and environment and conditionally including host name for logs. It encodes the policy difference between log and trace resources.

**Data flow**: Accepts settings, optional host name, and `ResourceKind` → initializes a vector with `service.version` and `env` attributes → if `kind == Logs` and `host_name.and_then(normalize_host_name)` yields a non-empty normalized name, pushes `host.name` → returns the vector.

**Call relations**: Used by `make_resource` and directly by tests. It delegates host-name cleanup to `normalize_host_name` and otherwise performs straightforward attribute assembly.

*Call graph*: called by 3 (make_resource, resource_attributes_include_host_name_when_present, resource_attributes_omit_host_name_when_missing_or_empty); 2 external calls (new, vec!).


##### `detected_host_name`  (lines 243–246)

```
fn detected_host_name() -> Option<String>
```

**Purpose**: Reads the machine hostname and normalizes it into an optional non-empty string. It hides the platform-specific hostname retrieval behind a simple `Option<String>` API.

**Data flow**: Calls `gethostname()` → converts the OS string lossily to `&str` → passes it to `normalize_host_name` → returns `Some(String)` for a non-empty trimmed hostname or `None` otherwise.

**Call relations**: This helper is only used by `make_resource` when constructing resource attributes. It delegates the trimming/emptiness rule to `normalize_host_name`.

*Call graph*: calls 1 internal fn (normalize_host_name); called by 1 (make_resource); 1 external calls (gethostname).


##### `normalize_host_name`  (lines 248–251)

```
fn normalize_host_name(host_name: &str) -> Option<String>
```

**Purpose**: Trims a hostname string and rejects empty results. It prevents blank or whitespace-only host names from being exported.

**Data flow**: Takes `host_name: &str` → trims whitespace → returns `Some(trimmed.to_owned())` if non-empty, else `None`.

**Call relations**: Called by both `detected_host_name` and `resource_attributes` so explicit and detected host names follow the same normalization rule.

*Call graph*: called by 1 (detected_host_name).


##### `tracer_provider_builder`  (lines 253–265)

```
fn tracer_provider_builder(
    resource: &Resource,
    span_attributes: BTreeMap<String, String>,
) -> TracerProviderBuilder
```

**Purpose**: Creates a base `SdkTracerProvider` builder with the given resource and optionally installs a span processor that injects configured span attributes. It keeps span-attribute wiring separate from exporter wiring.

**Data flow**: Accepts `&Resource` and a `BTreeMap<String, String>` of span attributes → starts `SdkTracerProvider::builder().with_resource(resource.clone())` → if the map is empty, returns the builder unchanged; otherwise adds a `SpanAttributesProcessor { attributes: span_attributes }` via `with_span_processor` and returns the augmented builder.

**Call relations**: This helper is called by `build_tracer_provider` in both the no-exporter and exporter-enabled paths. It encapsulates the decision of whether configured span attributes require an extra processor.

*Call graph*: called by 1 (build_tracer_provider); 2 external calls (builder, clone).


##### `SpanAttributesProcessor::on_start`  (lines 277–281)

```
fn on_start(&self, span: &mut Span, _cx: &Context)
```

**Purpose**: Injects configured key/value attributes into every span as soon as it starts. This turns static configuration into per-span metadata rather than resource metadata.

**Data flow**: Reads `self.attributes` and receives a mutable `Span` plus context → iterates over each `(key, value)` pair, cloning both strings into `KeyValue::new(key.clone(), value.clone())`, and calls `span.set_attribute(...)` for each → returns `()`.

**Call relations**: OpenTelemetry invokes this callback for each span when `SpanAttributesProcessor` has been installed by `tracer_provider_builder`. It is the only non-no-op method in that processor.

*Call graph*: 2 external calls (new, set_attribute).


##### `SpanAttributesProcessor::on_end`  (lines 283–283)

```
fn on_end(&self, _span: SpanData)
```

**Purpose**: Implements the required span-processor callback for span completion but intentionally performs no work. Configured attributes are only applied at span start.

**Data flow**: Receives completed `SpanData` and ignores it, returning `()`.

**Call relations**: This method is called by the OpenTelemetry SDK as part of the `SpanProcessor` trait, but this processor has no end-of-span behavior.


##### `SpanAttributesProcessor::force_flush`  (lines 285–287)

```
fn force_flush(&self) -> OTelSdkResult
```

**Purpose**: Reports that there is nothing buffered to flush for this processor. It satisfies the `SpanProcessor` trait with a no-op success result.

**Data flow**: Takes no meaningful input and returns `Ok(())` as `OTelSdkResult`.

**Call relations**: The SDK may call this during provider flush/shutdown. Because the processor only mutates spans in memory at start time, it has no exporter state to flush.


##### `SpanAttributesProcessor::shutdown_with_timeout`  (lines 289–291)

```
fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult
```

**Purpose**: Reports successful shutdown for the attribute-injection processor without doing any work. The processor owns no background tasks or buffers.

**Data flow**: Accepts a timeout `Duration`, ignores it, and returns `Ok(())` as `OTelSdkResult`.

**Call relations**: The SDK invokes this during tracer-provider shutdown when the processor is installed. It is intentionally a no-op because all useful work happened in `on_start`.


##### `build_logger`  (lines 294–361)

```
fn build_logger(
    resource: &Resource,
    exporter: &OtelExporter,
) -> Result<SdkLoggerProvider, Box<dyn Error>>
```

**Purpose**: Constructs an `SdkLoggerProvider` configured for the selected exporter protocol and TLS settings. It supports no-op, OTLP gRPC, and OTLP HTTP logging backends.

**Data flow**: Takes a `Resource` and exporter config → starts `SdkLoggerProvider::builder().with_resource(resource.clone())` → resolves exporter aliases → for `None`, returns the built provider immediately; for OTLP gRPC, logs the endpoint, builds a header map, creates a base tonic TLS config, optionally augments it with `build_grpc_tls_config`, builds a `LogExporter` with tonic endpoint/metadata/TLS, and attaches it as a batch exporter; for OTLP HTTP, logs the endpoint, maps `OtelHttpProtocol` to OTLP `Protocol`, builds an HTTP exporter with endpoint/protocol/headers, optionally injects a blocking HTTP client from `build_http_client`, then attaches the built exporter → finally builds and returns the logger provider.

**Call relations**: Called from `OtelProvider::from` when log export is enabled. It delegates transport-specific pieces to `crate::otlp` helpers and keeps only the exporter-selection and provider-wiring logic locally.

*Call graph*: calls 4 internal fn (resolve_exporter, build_grpc_tls_config, build_header_map, build_http_client); 7 external calls (new, builder, from_headers, builder, debug!, clone, unreachable!).


##### `build_tracer_provider`  (lines 363–457)

```
fn build_tracer_provider(
    resource: &Resource,
    exporter: &OtelExporter,
    span_attributes: BTreeMap<String, String>,
) -> Result<SdkTracerProvider, Box<dyn Error>>
```

**Purpose**: Constructs an `SdkTracerProvider` for the selected trace exporter, including runtime-sensitive HTTP exporter handling and optional configured span attributes. It supports no-op, OTLP gRPC, and OTLP HTTP tracing backends.

**Data flow**: Accepts a `Resource`, exporter config, and span-attribute map → resolves exporter aliases → for `None`, returns `tracer_provider_builder(resource, span_attributes).build()`; for OTLP gRPC, logs the endpoint, builds headers and tonic TLS config, and builds a `SpanExporter` with tonic transport; for OTLP HTTP, logs the endpoint and branches again: if `current_tokio_runtime_is_multi_thread()` is true, maps protocol, builds an HTTP exporter builder, injects an async client from `build_async_http_client`, wraps the exporter in `TokioBatchSpanProcessor`, and returns a tracer provider built from `tracer_provider_builder(...).with_span_processor(processor)` immediately; otherwise maps protocol, builds an HTTP exporter builder, optionally injects a blocking client from `build_http_client`, and builds the exporter → for non-early-return paths, wraps the exporter in a standard `BatchSpanProcessor`, adds it to `tracer_provider_builder`, and builds the provider.

**Call relations**: This function is called by `OtelProvider::from` when tracing is enabled. It delegates resource-plus-span-attribute setup to `tracer_provider_builder` and transport/client details to the OTLP helper module, while owning the key control-flow decision between async Tokio batch processing and the standard blocking exporter path.

*Call graph*: calls 7 internal fn (resolve_exporter, build_async_http_client, build_grpc_tls_config, build_header_map, build_http_client, current_tokio_runtime_is_multi_thread, tracer_provider_builder); 7 external calls (builder, new, from_headers, builder, builder, debug!, unreachable!).


##### `tests::resource_attributes_include_host_name_when_present`  (lines 466–479)

```
fn resource_attributes_include_host_name_when_present()
```

**Purpose**: Verifies that log resources include a `host.name` attribute when a non-empty hostname is supplied. It protects the conditional host-name export behavior.

**Data flow**: Builds test settings, calls `resource_attributes(..., Some("opentelemetry-test"), ResourceKind::Logs)`, searches the returned attributes for `HOST_NAME_ATTRIBUTE`, converts the found value to `String`, and asserts it equals `Some("opentelemetry-test".to_string())`.

**Call relations**: This test directly exercises `resource_attributes` with the positive host-name case. It complements the omission test for missing/empty host names and trace resources.

*Call graph*: calls 1 internal fn (resource_attributes); 2 external calls (assert_eq!, test_otel_settings).


##### `tests::resource_attributes_omit_host_name_when_missing_or_empty`  (lines 482–510)

```
fn resource_attributes_omit_host_name_when_missing_or_empty()
```

**Purpose**: Verifies that `host.name` is omitted when no hostname is available, when the hostname is whitespace-only, and for trace resources even when a hostname exists. It locks down the resource-kind-specific policy.

**Data flow**: Calls `resource_attributes` three times: with `None` hostname for logs, with whitespace hostname for logs, and with a real hostname for traces → checks each returned attribute list with `.any(...)` and asserts that none contain `HOST_NAME_ATTRIBUTE`.

**Call relations**: This test covers the negative branches in `resource_attributes`, including the `normalize_host_name` rejection path and the `ResourceKind::Traces` exclusion rule.

*Call graph*: calls 1 internal fn (resource_attributes); 2 external calls (assert!, test_otel_settings).


##### `tests::log_export_target_excludes_trace_safe_events`  (lines 513–518)

```
fn log_export_target_excludes_trace_safe_events()
```

**Purpose**: Verifies the target-prefix policy for log export: log-only and general OTEL targets are included, but trace-safe targets are excluded from log export. It protects the separation between log and trace pipelines.

**Data flow**: Calls `is_log_export_target` with several target strings and asserts the expected true/false outcomes.

**Call relations**: This test validates the filtering behavior consumed by `OtelProvider::log_export_filter` and therefore by `logger_layer`.

*Call graph*: 1 external calls (assert!).


##### `tests::trace_export_target_only_includes_trace_safe_prefix`  (lines 521–526)

```
fn trace_export_target_only_includes_trace_safe_prefix()
```

**Purpose**: Verifies that only the trace-safe target prefix is accepted for non-span trace export. It ensures unrelated OTEL targets do not leak into trace exporters.

**Data flow**: Calls `is_trace_safe_target` with trace-safe and non-trace-safe target strings and asserts the expected results.

**Call relations**: This test validates the target policy used by `OtelProvider::trace_export_filter` for non-span events.

*Call graph*: 1 external calls (assert!).


##### `tests::test_otel_settings`  (lines 528–541)

```
fn test_otel_settings() -> OtelSettings
```

**Purpose**: Creates a minimal `OtelSettings` fixture used by provider tests. It disables all exporters and initializes empty span/tracestate maps.

**Data flow**: Constructs and returns an `OtelSettings` value with fixed strings for environment/service metadata, `PathBuf::from(".")` for `codex_home`, all exporters set to `OtelExporter::None`, `runtime_metrics` false, and empty `BTreeMap`s for span attributes and tracestate.

**Call relations**: This helper is called by the resource-attribute tests to avoid repeating boilerplate configuration setup.

*Call graph*: 2 external calls (new, from).


### Metrics foundations
These files establish the metrics subsystem’s shared types, validation rules, naming conventions, global coordination, and tag/config models.

### `otel/src/metrics/error.rs`

`data_model` · `cross-cutting`

This file establishes a crate-local `Result<T>` alias bound to `MetricsError` and defines the `MetricsError` enum with `thiserror::Error` for human-readable formatting and source chaining. The variants are grouped around the metrics pipeline’s failure modes. Several variants enforce input validation before metrics are emitted: empty or invalid metric names, empty tag components, invalid tag component values, and negative counter increments. Others represent runtime configuration and exporter lifecycle problems: `ExporterDisabled` signals metrics are intentionally off, `InvalidConfig` captures semantic configuration errors, and `ExporterBuild` wraps `opentelemetry_otlp::ExporterBuildError` when OTLP exporter construction fails. Shutdown and runtime-inspection paths are also modeled explicitly: `ProviderShutdown` wraps `opentelemetry_sdk::error::OTelSdkError`, `RuntimeSnapshotUnavailable` indicates the snapshot reader was never enabled, and `RuntimeSnapshotCollect` wraps collection failures from the SDK. The design is intentionally specific rather than using generic strings, which lets callers distinguish user/input mistakes from infrastructure failures and decide whether to retry, disable metrics, or surface configuration guidance. Because the enum derives `Debug` and `Error`, it integrates cleanly with Rust error propagation while preserving underlying source errors where available.


### `otel/src/metrics/validation.rs`

`util` · `metric and tag construction time`

This file is the validation core for metric identifiers before they are accepted into counters, gauges, histograms, or tag collections. It distinguishes metric names from tag components because the allowed character sets differ slightly: metric names may contain ASCII alphanumerics plus `.`, `_`, and `-`, while tag keys and values additionally allow `/`. Empty strings are rejected for both categories.

`validate_tags` walks a `BTreeMap<String, String>` and validates every key/value pair, propagating the first failure. `validate_metric_name` performs two explicit checks in order: empty names produce `MetricsError::EmptyMetricName`, and names containing any disallowed character produce `MetricsError::InvalidMetricName { name }`. Tag validation is split into `validate_tag_key` and `validate_tag_value`, but both delegate to the shared `validate_tag_component`, which emits either `MetricsError::EmptyTagComponent { label }` or `MetricsError::InvalidTagComponent { label, value }`. The `label` argument preserves whether the failure came from a key or a value, which improves diagnostics.

The low-level predicates `is_metric_char` and `is_tag_char` encode the exact grammar and are used through `.chars().all(...)`, so validation is Unicode-aware at the `char` level but intentionally restricted to ASCII-compatible characters. This module is reused by tag builders and metric constructors to keep all acceptance rules consistent.

#### Function details

##### `validate_tags`  (lines 5–11)

```
fn validate_tags(tags: &BTreeMap<String, String>) -> Result<()>
```

**Purpose**: Validates every key and value in a tag map before the map is accepted into metrics configuration or emission. It stops at the first invalid entry.

**Data flow**: Takes `&BTreeMap<String, String>` → iterates over each `(key, value)` pair → runs `validate_tag_key(key)` and `validate_tag_value(value)` for each → returns `Ok(())` if all pass or propagates the first `MetricsError`.

**Call relations**: This function is used during metrics configuration creation when a whole default-tag map must be checked at once. It delegates per-component syntax rules to `validate_tag_key` and `validate_tag_value`.

*Call graph*: calls 2 internal fn (validate_tag_key, validate_tag_value); called by 1 (new).


##### `validate_metric_name`  (lines 13–23)

```
fn validate_metric_name(name: &str) -> Result<()>
```

**Purpose**: Checks that a metric name is non-empty and contains only the allowed metric-name characters. It produces metric-specific error variants so callers can distinguish naming failures from tag failures.

**Data flow**: Accepts `name: &str` → returns `Err(MetricsError::EmptyMetricName)` if empty → otherwise scans `name.chars()` with `is_metric_char` → returns `Err(MetricsError::InvalidMetricName { name: name.to_string() })` on any invalid character, else `Ok(())`.

**Call relations**: Metric constructors such as counters, gauges, histograms, and duration histograms call this before registering instruments. It is a leaf validator and does not delegate beyond the character predicate.

*Call graph*: called by 4 (counter, duration_histogram, gauge, histogram).


##### `validate_tag_key`  (lines 25–28)

```
fn validate_tag_key(key: &str) -> Result<()>
```

**Purpose**: Validates one tag key using the shared tag-component grammar while labeling failures specifically as key errors. It exists mainly to preserve clearer error messages.

**Data flow**: Takes `key: &str` → calls `validate_tag_component(key, "tag key")` → converts its success into `Ok(())` and propagates any `MetricsError` unchanged.

**Call relations**: This helper is called from attribute builders, tag-adding APIs, session tag assembly, and whole-map validation. It delegates all actual checks to `validate_tag_component` so key and value validation stay structurally identical.

*Call graph*: calls 1 internal fn (validate_tag_component); called by 4 (attributes, with_tag, push_optional_tag, validate_tags).


##### `validate_tag_value`  (lines 30–32)

```
fn validate_tag_value(value: &str) -> Result<()>
```

**Purpose**: Validates one tag value using the shared tag-component grammar while labeling failures specifically as value errors.

**Data flow**: Takes `value: &str` → calls `validate_tag_component(value, "tag value")` → returns its `Result<()>` directly.

**Call relations**: This helper is used anywhere a tag value enters the metrics system, including attribute builders, tag APIs, session tag assembly, and map validation. Like `validate_tag_key`, it is a thin wrapper over `validate_tag_component`.

*Call graph*: calls 1 internal fn (validate_tag_component); called by 4 (attributes, with_tag, push_optional_tag, validate_tags).


##### `validate_tag_component`  (lines 34–47)

```
fn validate_tag_component(value: &str, label: &str) -> Result<()>
```

**Purpose**: Implements the common validation logic for both tag keys and tag values. It rejects empty strings and any character outside the tag grammar.

**Data flow**: Receives `value: &str` and a descriptive `label: &str` → if `value` is empty, returns `MetricsError::EmptyTagComponent { label: label.to_string() }` → otherwise checks `value.chars().all(is_tag_char)` and returns `MetricsError::InvalidTagComponent { label: label.to_string(), value: value.to_string() }` on failure → otherwise returns `Ok(())`.

**Call relations**: This is the shared implementation behind `validate_tag_key` and `validate_tag_value`. It is not called directly by higher-level code; wrappers provide the correct label for diagnostics.

*Call graph*: called by 2 (validate_tag_key, validate_tag_value).


##### `is_metric_char`  (lines 49–51)

```
fn is_metric_char(c: char) -> bool
```

**Purpose**: Defines the exact per-character allowlist for metric names. It is the low-level predicate used by `validate_metric_name`.

**Data flow**: Accepts a single `char` → returns `true` for ASCII alphanumerics or `.`, `_`, `-`; otherwise `false`.

**Call relations**: This predicate is only used inside `validate_metric_name` to keep the grammar definition isolated and easy to audit.

*Call graph*: 1 external calls (matches!).


##### `is_tag_char`  (lines 53–55)

```
fn is_tag_char(c: char) -> bool
```

**Purpose**: Defines the exact per-character allowlist for tag keys and values. It extends the metric-name grammar by permitting `/`.

**Data flow**: Accepts a single `char` → returns `true` for ASCII alphanumerics or `.`, `_`, `-`, `/`; otherwise `false`.

**Call relations**: This predicate is only used by `validate_tag_component`, which in turn powers both key and value validation.

*Call graph*: 1 external calls (matches!).


### `otel/src/metrics/names.rs`

`data_model` · `cross-cutting`

This file is the authoritative registry of metric-name strings for the OpenTelemetry metrics layer. Each `pub const` binds a semantic event or measurement to a stable dotted identifier such as `codex.tool.call`, `codex.api_request.duration_ms`, or `codex.goal.completed`. The constants span multiple domains: tool execution, API and SSE/WebSocket traffic, Responses API timing breakdowns, turn-level latency and resource usage, guardian review activity, goal lifecycle and token accounting, plugin installation/startup sync, hook execution, startup phase and prewarm timing, and thread/skills instrumentation. Several names encode units directly in the suffix (`duration_ms`, `duration_s`), which is an important convention for dashboards and downstream aggregation. The inline comments on startup metrics document intended tagging semantics and interpretation, clarifying that some metrics represent coarse phase durations while others measure prewarm lifetime or age at first turn. Centralizing names here prevents drift between emitters, tests, and dashboards, and it reduces the risk of accidental cardinality or naming inconsistencies caused by ad hoc string literals. This file contains no behavior, but it is foundational for telemetry stability because metric identity is effectively part of the system’s observability contract.


### `otel/src/metrics/config.rs`

`config` · `metrics configuration assembly before metrics client initialization`

This file is the metrics configuration model. `MetricsExporter` abstracts over two concrete export paths: `Otlp(OtelExporter)` for real exporters and `InMemory(InMemoryMetricExporter)` for tests. `MetricsConfig` then packages the environment name, service name, service version, exporter, optional periodic export interval, a `runtime_reader` flag, and a `BTreeMap` of default tags that should be attached to every metric.

The implementation is intentionally lightweight and builder-oriented. `MetricsConfig::otlp` and `MetricsConfig::in_memory` are convenience constructors that populate the common identity fields, wrap the chosen exporter variant, and initialize `export_interval` to `None`, `runtime_reader` to `false`, and `default_tags` to an empty map. `with_export_interval` and `with_runtime_reader` toggle optional behavior by mutating and returning `self`. `with_tag` is the only method with validation logic: it converts the key and value into owned strings, validates them with the shared metric-tag validators, inserts them into the `default_tags` map, and returns the updated config or a validation error.

Because `default_tags` is a `BTreeMap`, insertion order is normalized and duplicate keys are overwritten by the latest call. The file itself does not build exporters or providers; it only shapes the data consumed later by `MetricsClient::new`.

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

**Purpose**: Constructs a metrics configuration targeting an OTLP exporter. It fills in the required identity fields and leaves optional behaviors disabled by default.

**Data flow**: Consumes `environment`, `service_name`, `service_version`, and an `OtelExporter`, converts the first three with `Into<String>`, wraps the exporter in `MetricsExporter::Otlp`, initializes `export_interval` to `None`, `runtime_reader` to `false`, `default_tags` to an empty `BTreeMap`, and returns the new `MetricsConfig`.

**Call relations**: It is used by setup code and tests as the standard starting point for real exporter configurations before optional builder methods are applied.

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

**Purpose**: Constructs a metrics configuration backed by an in-memory exporter, primarily for tests and local inspection. It mirrors the OTLP constructor but swaps in the in-memory exporter variant.

**Data flow**: Consumes `environment`, `service_name`, `service_version`, and an `InMemoryMetricExporter`, converts the identity fields into owned strings, wraps the exporter in `MetricsExporter::InMemory`, initializes optional fields to defaults, and returns the config.

**Call relations**: It is the common constructor used by tests and harnesses that need metrics collection without external transport.

*Call graph*: called by 10 (test_session_telemetry, test_session_telemetry_without_metadata, test_session_telemetry, websocket_harness_with_provider_options, build_metrics_with_defaults, runtime_metrics_summary_collects_tool_api_and_streaming_metrics, manager_snapshot_metrics_collects_without_shutdown, snapshot_collects_metrics_without_shutdown, build_in_memory_client, invalid_tag_component_is_rejected); 3 external calls (new, into, InMemory).


##### `MetricsConfig::with_export_interval`  (lines 63–66)

```
fn with_export_interval(mut self, interval: Duration) -> Self
```

**Purpose**: Overrides the periodic export interval for the metrics provider. It is a simple builder mutator.

**Data flow**: Consumes `self`, stores `Some(interval)` into `self.export_interval`, and returns the updated config.

**Call relations**: Callers apply this after constructing a base config when they need non-default export cadence.


##### `MetricsConfig::with_runtime_reader`  (lines 69–72)

```
fn with_runtime_reader(mut self) -> Self
```

**Purpose**: Enables the optional manual runtime reader used for on-demand snapshots. This is required for runtime summaries and reset-by-snapshot behavior.

**Data flow**: Consumes `self`, sets `self.runtime_reader = true`, and returns the updated config.

**Call relations**: It is applied during configuration assembly before `MetricsClient::new` so the client installs a `ManualReader`.


##### `MetricsConfig::with_tag`  (lines 75–82)

```
fn with_tag(mut self, key: impl Into<String>, value: impl Into<String>) -> Result<Self>
```

**Purpose**: Adds a validated default tag that will be attached to every metric emitted by the resulting client. It rejects invalid tag keys or values before mutating the config.

**Data flow**: Consumes `self`, converts `key` and `value` into owned `String`s, validates them with `validate_tag_key` and `validate_tag_value`, inserts them into `self.default_tags`, and returns `Result<Self>`.

**Call relations**: This is used during config assembly to establish global/default metric dimensions before the client is built.

*Call graph*: calls 2 internal fn (validate_tag_key, validate_tag_value); 1 external calls (into).


### `otel/src/metrics/tags.rs`

`domain_logic` · `metric emission setup for session/process events`

This file is the small normalization and validation layer for metric tags attached to session/process metrics. It declares the exported tag-key constants (`app.version`, `auth_mode`, `model`, `originator`, `service_name`, `session_source`) so callers use one spelling everywhere. The `bounded_originator_tag_value` helper specifically protects cardinality for the `originator` tag: it sanitizes the raw input with `sanitize_metric_tag_value`, compares the sanitized string against a fixed list of known originators, and collapses everything else to the literal `other`.

The main data structure is `SessionMetricTagValues<'a>`, a borrowed bundle of six session metadata fields, two of which are optional (`auth_mode`, `service_name`). Its `into_tags` method builds a `Vec<(&'static str, &'a str)>` in a deliberate, stable order matching the field list. Each candidate tag is routed through `push_optional_tag`, which skips absent optionals, validates the key via `validate_tag_key`, validates the value via `validate_tag_value`, and only then appends the pair. That means invalid tag syntax aborts the whole conversion before partially malformed output escapes. The tests lock down both the exact ordering and the omission behavior for missing optional tags, which matters because downstream metrics code may preserve tag order when exporting or asserting on payloads.

#### Function details

##### `bounded_originator_tag_value`  (lines 29–36)

```
fn bounded_originator_tag_value(originator: &str) -> &'static str
```

**Purpose**: Maps an arbitrary originator string onto a low-cardinality exported value. It preserves only known sanitized originator identifiers and returns the fallback `other` for everything else.

**Data flow**: Takes `originator: &str` → sanitizes it with `sanitize_metric_tag_value` → scans the static `KNOWN_ORIGINATOR_TAG_VALUES` slice for an exact match against the sanitized text → returns the matched `&'static str` from the allowlist or `OTHER_ORIGINATOR_TAG_VALUE`.

**Call relations**: This helper is used when process-start metrics are recorded and the caller needs a bounded `originator` tag. It delegates sanitization first so matching is done against the same normalized form metrics exporters expect, then performs the allowlist collapse locally.

*Call graph*: called by 1 (record_process_start_once); 1 external calls (sanitize_metric_tag_value).


##### `SessionMetricTagValues::into_tags`  (lines 48–57)

```
fn into_tags(self) -> Result<Vec<(&'static str, &'a str)>>
```

**Purpose**: Converts a `SessionMetricTagValues` bundle into the concrete tag list sent with metrics. It preserves a fixed tag order and omits only the optional fields that are `None`.

**Data flow**: Consumes `self` containing borrowed session fields → allocates a vector with capacity 6 → invokes `Self::push_optional_tag` for each tag key/value pair in the order auth mode, session source, originator, service name, model, app version → returns `Ok(Vec<(&'static str, &'a str)>)` or the first validation error.

**Call relations**: This is the public assembly point for callers that have collected session metadata and need validated tags. Its only internal delegation is to `push_optional_tag`, which centralizes skip-and-validate behavior so every field follows the same rules.

*Call graph*: 2 external calls (push_optional_tag, with_capacity).


##### `SessionMetricTagValues::push_optional_tag`  (lines 59–71)

```
fn push_optional_tag(
        tags: &mut Vec<(&'static str, &'a str)>,
        key: &'static str,
        value: Option<&'a str>,
    ) -> Result<()>
```

**Purpose**: Adds one tag pair to the output vector if a value is present and syntactically valid. It is the shared validation gate used by `into_tags` for both required and optional fields.

**Data flow**: Receives a mutable tag vector, a static key, and `Option<&str>` value → returns early with `Ok(())` when the value is `None` → validates the key and value strings → pushes `(key, value)` into the vector → returns success or propagates a validation error.

**Call relations**: This function is called repeatedly by `SessionMetricTagValues::into_tags` as it walks the session fields. It delegates actual syntax checks to `validate_tag_key` and `validate_tag_value` so tag construction stays aligned with the rest of the metrics subsystem.

*Call graph*: calls 2 internal fn (validate_tag_key, validate_tag_value).


##### `tests::session_metric_tags_include_expected_tags_in_order`  (lines 86–109)

```
fn session_metric_tags_include_expected_tags_in_order()
```

**Purpose**: Verifies that a fully populated `SessionMetricTagValues` instance produces all six tags in the exact expected order. The test guards against accidental reordering or omission of required fields.

**Data flow**: Builds a `SessionMetricTagValues` with all fields present → calls `into_tags()` and unwraps the result → compares the returned vector against a literal ordered `vec![(key, value), ...]` using `assert_eq!`.

**Call relations**: This test exercises the normal path through `into_tags`, indirectly covering repeated calls to `push_optional_tag`. It exists to pin down the externally visible tag sequence expected by downstream metrics assertions.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_metric_tags_skip_missing_optional_tags`  (lines 112–133)

```
fn session_metric_tags_skip_missing_optional_tags()
```

**Purpose**: Verifies that absent optional fields are omitted rather than emitted as empty tags or placeholders. It specifically checks the reduced output shape when `auth_mode` and `service_name` are missing.

**Data flow**: Builds a `SessionMetricTagValues` with `auth_mode: None` and `service_name: None` → calls `into_tags()` → asserts that the resulting vector contains only session source, originator, model, and app version in order.

**Call relations**: This test covers the `None` early-return branch inside `push_optional_tag` as reached from `into_tags`. It complements the full-population test by locking down omission semantics for optional metadata.

*Call graph*: 1 external calls (assert_eq!).


### `otel/src/metrics/mod.rs`

`orchestration` · `startup installation of globals and cross-cutting access during runtime`

This module file primarily organizes and re-exports the metrics subsystem. It declares the internal submodules (`client`, `config`, `error`, `names`, `process`, `runtime_metrics`, `tags`, `timer`, `validation`) and then re-exports the main public pieces: `MetricsClient`, `MetricsConfig`, `MetricsExporter`, `MetricsError`, the crate-local `Result` alias, process-start recording, all metric-name constants, the originator tag constant, `SessionMetricTagValues`, and the bounded-originator helper.

Its only real state is two `OnceLock` singletons: `GLOBAL_METRICS` for the process-wide `MetricsClient` and `GLOBAL_STATSIG_METRICS_SETTINGS` for resolved Statsig exporter settings. The four functions are thin wrappers around those locks. Installation functions attempt a one-time set and intentionally ignore subsequent attempts by discarding the `set` result. Accessor functions clone the stored values out so callers receive owned copies rather than references tied to the singleton.

This design makes global metrics optional and immutable after first installation, which simplifies use from session telemetry and crate-level helpers. The file itself contains no metric-recording logic; it is the registry and export hub for the rest of the metrics subsystem.

#### Function details

##### `install_global`  (lines 27–29)

```
fn install_global(metrics: MetricsClient)
```

**Purpose**: Installs the process-wide global metrics client the first time it is called. Later calls are ignored because the underlying `OnceLock` can only be set once.

**Data flow**: Consumes a `MetricsClient`, calls `GLOBAL_METRICS.set(metrics)`, discards the `Result`, and returns `()`. If the singleton was already initialized, the passed client is simply dropped.

**Call relations**: It is called during provider/setup initialization so later code can retrieve the global client via `global()`.

*Call graph*: called by 1 (from).


##### `global`  (lines 31–33)

```
fn global() -> Option<MetricsClient>
```

**Purpose**: Returns a clone of the globally installed metrics client, if one has been installed. It is the main read accessor for process-wide metrics state.

**Data flow**: Reads `GLOBAL_METRICS.get()`, clones the stored `MetricsClient` when present, and returns `Option<MetricsClient>`.

**Call relations**: It is used by session telemetry construction and by the crate-level `start_global_timer` helper.

*Call graph*: called by 2 (new, start_global_timer).


##### `install_global_statsig_settings`  (lines 35–37)

```
fn install_global_statsig_settings(settings: StatsigMetricsSettings)
```

**Purpose**: Stores the resolved Statsig metrics settings in a process-wide singleton. Like the global metrics client, it only takes effect on the first call.

**Data flow**: Consumes `StatsigMetricsSettings`, calls `GLOBAL_STATSIG_METRICS_SETTINGS.set(settings)`, ignores the result, and returns `()`. Repeated installation attempts are dropped.

**Call relations**: It is invoked during provider/setup initialization when Statsig-backed metrics are configured.

*Call graph*: called by 1 (from).


##### `global_statsig_settings`  (lines 39–41)

```
fn global_statsig_settings() -> Option<StatsigMetricsSettings>
```

**Purpose**: Returns a clone of the globally stored Statsig metrics settings, if any. It is the internal accessor behind the crate's public Statsig-settings helper.

**Data flow**: Reads `GLOBAL_STATSIG_METRICS_SETTINGS.get()`, clones the stored settings when present, and returns `Option<StatsigMetricsSettings>`.

**Call relations**: It is called by `otel::global_statsig_metrics_settings` to expose the singleton to external callers.

*Call graph*: called by 1 (global_statsig_metrics_settings).


### Metrics transport and recording
These files implement OTLP transport setup and the concrete metrics client features used to emit counters, timers, startup signals, and runtime summaries.

### `otel/src/otlp.rs`

`io_transport` · `provider/exporter initialization`

This file is the transport-plumbing layer for OTLP exporters. It converts user configuration into concrete `reqwest` and tonic transport objects while normalizing errors into boxed `io::Error`s with actionable messages. `build_header_map` filters a plain `HashMap<String, String>` into an HTTP `HeaderMap`, silently dropping invalid header names or values instead of failing exporter setup.

TLS setup is split by protocol stack. `build_grpc_tls_config` parses the endpoint as an `http::Uri`, extracts the host for SNI/domain validation, optionally loads a CA PEM into `TonicCertificate`, and optionally loads a client cert/key pair into `TonicIdentity`; supplying only one half of the mTLS pair is rejected. `build_http_client_inner` and `build_async_http_client` perform the analogous work for blocking and async `reqwest` clients, including disabling built-in roots when a custom CA is provided and concatenating cert+key PEM bytes before creating a `ReqwestIdentity`.

`build_http_client` is the notable control-flow wrapper: on a multi-thread Tokio runtime it uses `block_in_place`, on a current-thread runtime it spawns a dedicated OS thread to avoid blocking the runtime, and outside Tokio it calls the inner builder directly. Timeout selection is centralized in `resolve_otlp_timeout`, which prefers a signal-specific env var, then the generic OTLP timeout, then the OpenTelemetry default. `read_bytes` preserves the original path in success and wraps read failures with the path in the error text. Tests specifically verify runtime-flavor detection and that blocking client construction works inside a current-thread runtime.

#### Function details

##### `build_header_map`  (lines 22–32)

```
fn build_header_map(headers: &std::collections::HashMap<String, String>) -> HeaderMap
```

**Purpose**: Converts configured string headers into a `reqwest::header::HeaderMap` suitable for OTLP exporters. Invalid header names or values are ignored rather than aborting setup.

**Data flow**: Takes `&HashMap<String, String>` → creates an empty `HeaderMap` → iterates each `(key, value)` and attempts `HeaderName::from_bytes(key.as_bytes())` plus `HeaderValue::from_str(value)` → inserts only pairs where both conversions succeed → returns the populated `HeaderMap`.

**Call relations**: Exporter builders for metrics, logs, and traces call this before constructing OTLP clients. It is a leaf conversion helper and does not propagate parse failures upward, intentionally making header handling permissive.

*Call graph*: called by 3 (build_otlp_metric_exporter, build_logger, build_tracer_provider); 3 external calls (new, from_bytes, from_str).


##### `build_grpc_tls_config`  (lines 34–68)

```
fn build_grpc_tls_config(
    endpoint: &str,
    tls_config: ClientTlsConfig,
    tls: &OtelTlsConfig,
) -> Result<ClientTlsConfig, Box<dyn Error>>
```

**Purpose**: Builds a tonic `ClientTlsConfig` for OTLP gRPC exporters, including endpoint-derived domain name, optional custom CA, and optional client identity for mTLS.

**Data flow**: Accepts `endpoint: &str`, a base `ClientTlsConfig`, and `&OtelTlsConfig` → parses the endpoint into `Uri`, extracts the host or returns a configuration error if absent, sets that host as the TLS domain name, optionally reads CA PEM bytes and installs a `TonicCertificate`, then matches on `(client_certificate, client_private_key)` to either load both PEM files into a `TonicIdentity`, reject partial mTLS configuration, or leave identity unset → returns the finalized `ClientTlsConfig`.

**Call relations**: This helper is invoked by OTLP metric, log, and trace gRPC exporter setup paths whenever TLS settings are present. It delegates file I/O to `read_bytes` and error shaping to `config_error` so the exporter builders stay focused on protocol selection.

*Call graph*: calls 2 internal fn (config_error, read_bytes); called by 3 (build_otlp_metric_exporter, build_logger, build_tracer_provider); 3 external calls (domain_name, from_pem, from_pem).


##### `build_http_client`  (lines 74–92)

```
fn build_http_client(
    tls: &OtelTlsConfig,
    timeout_var: &str,
) -> Result<reqwest::blocking::Client, Box<dyn Error>>
```

**Purpose**: Constructs a blocking `reqwest` client for OTLP HTTP exporters while avoiding illegal blocking behavior inside Tokio runtimes. It chooses a runtime-aware execution strategy before delegating to the actual builder.

**Data flow**: Takes `&OtelTlsConfig` and a timeout env-var name → checks `current_tokio_runtime_is_multi_thread()`; if true, runs `build_http_client_inner` inside `tokio::task::block_in_place`; else if any Tokio runtime exists, clones inputs, spawns a dedicated thread, joins it, and maps thread/join/string errors into boxed config errors; otherwise calls `build_http_client_inner` directly → returns `reqwest::blocking::Client` or boxed error.

**Call relations**: HTTP exporter setup for metrics, logs, and traces calls this when a blocking client is needed. It delegates actual client assembly to `build_http_client_inner`; its main role is selecting the safe execution path based on runtime context.

*Call graph*: calls 2 internal fn (build_http_client_inner, current_tokio_runtime_is_multi_thread); called by 4 (build_otlp_metric_exporter, build_http_client_works_in_current_thread_runtime, build_logger, build_tracer_provider); 4 external calls (clone, spawn, try_current, block_in_place).


##### `current_tokio_runtime_is_multi_thread`  (lines 94–99)

```
fn current_tokio_runtime_is_multi_thread() -> bool
```

**Purpose**: Detects whether the current execution context is inside a Tokio multi-thread runtime. This is used to decide whether `block_in_place` is legal.

**Data flow**: Calls `tokio::runtime::Handle::try_current()` → if a handle exists, compares `runtime_flavor()` to `RuntimeFlavor::MultiThread`; if no runtime exists, returns `false`.

**Call relations**: This predicate is consulted by `build_http_client` and trace-provider setup to choose between blocking and async exporter/client strategies. Tests exercise it under no runtime, current-thread runtime, and multi-thread runtime conditions.

*Call graph*: called by 2 (build_http_client, build_tracer_provider); 1 external calls (try_current).


##### `build_http_client_inner`  (lines 101–146)

```
fn build_http_client_inner(
    tls: &OtelTlsConfig,
    timeout_var: &str,
) -> Result<reqwest::blocking::Client, Box<dyn Error>>
```

**Purpose**: Performs the actual blocking `reqwest` client construction for OTLP HTTP exporters, including timeout and TLS/mTLS configuration. It assumes the caller has already chosen a safe context for blocking work.

**Data flow**: Accepts `&OtelTlsConfig` and timeout env-var name → starts a `reqwest::blocking::Client::builder()` with timeout from `resolve_otlp_timeout` → if a CA path exists, reads PEM bytes, parses a `ReqwestCertificate`, disables built-in roots, and adds the custom root → matches on client cert/key paths to either read both files, concatenate PEM bytes, parse a `ReqwestIdentity`, and enforce `https_only(true)`; reject partial mTLS config; or do nothing → builds and returns the client, boxing any reqwest build error.

**Call relations**: Only `build_http_client` calls this function. It delegates timeout lookup to `resolve_otlp_timeout`, file loading to `read_bytes`, and human-readable configuration failures to `config_error`.

*Call graph*: calls 3 internal fn (config_error, read_bytes, resolve_otlp_timeout); called by 1 (build_http_client); 3 external calls (from_pem, from_pem, builder).


##### `build_async_http_client`  (lines 148–194)

```
fn build_async_http_client(
    tls: Option<&OtelTlsConfig>,
    timeout_var: &str,
) -> Result<reqwest::Client, Box<dyn Error>>
```

**Purpose**: Builds an async `reqwest::Client` for OTLP HTTP exporters, mirroring the blocking builder’s timeout and TLS behavior. It supports optional TLS configuration because some callers may not need custom certificates.

**Data flow**: Takes `Option<&OtelTlsConfig>` and timeout env-var name → creates a `reqwest::Client::builder()` with timeout from `resolve_otlp_timeout` → if TLS config is present, optionally loads and installs a custom CA, optionally loads and concatenates client cert/key PEM into a `ReqwestIdentity` with `https_only(true)`, or rejects partial mTLS configuration → builds and returns the async client.

**Call relations**: The trace-provider setup uses this path when running under a multi-thread Tokio runtime so trace exporting can stay async. It shares the same helper dependencies as the blocking builder: `resolve_otlp_timeout`, `read_bytes`, and `config_error`.

*Call graph*: calls 3 internal fn (config_error, read_bytes, resolve_otlp_timeout); called by 1 (build_tracer_provider); 3 external calls (from_pem, from_pem, builder).


##### `resolve_otlp_timeout`  (lines 196–204)

```
fn resolve_otlp_timeout(signal_var: &str) -> Duration
```

**Purpose**: Resolves the effective OTLP timeout from environment variables with signal-specific precedence. It falls back to the OpenTelemetry crate default when no valid override is present.

**Data flow**: Accepts `signal_var: &str` → tries `read_timeout_env(signal_var)` first → if absent/invalid, tries `read_timeout_env(OTEL_EXPORTER_OTLP_TIMEOUT)` → if still absent, returns `OTEL_EXPORTER_OTLP_TIMEOUT_DEFAULT`.

**Call relations**: Both HTTP client builders call this so logs, traces, and other OTLP signals honor the same timeout precedence rules. It delegates parsing and validation of individual env vars to `read_timeout_env`.

*Call graph*: calls 1 internal fn (read_timeout_env); called by 2 (build_async_http_client, build_http_client_inner).


##### `read_timeout_env`  (lines 206–213)

```
fn read_timeout_env(var: &str) -> Option<Duration>
```

**Purpose**: Parses one timeout environment variable as a non-negative millisecond duration. Invalid, missing, or negative values are treated as unset.

**Data flow**: Takes `var: &str` → reads `env::var(var)` and returns `None` if missing → parses the string as `i64`, returning `None` on parse failure → rejects negative values with `None` → converts non-negative milliseconds to `Duration::from_millis(parsed as u64)` and returns `Some(duration)`.

**Call relations**: This is a private helper used only by `resolve_otlp_timeout` to keep env parsing logic isolated from precedence logic.

*Call graph*: called by 1 (resolve_otlp_timeout); 2 external calls (from_millis, var).


##### `read_bytes`  (lines 215–223)

```
fn read_bytes(path: &AbsolutePathBuf) -> Result<(Vec<u8>, PathBuf), Box<dyn Error>>
```

**Purpose**: Reads a configured certificate/key file and preserves the resolved path alongside the bytes for later error reporting. It wraps filesystem errors with path-aware messages.

**Data flow**: Accepts `&AbsolutePathBuf` → calls `fs::read(path)` → on success returns `(Vec<u8>, path.to_path_buf())` → on failure constructs a new boxed `io::Error` with the original error kind and a message including `path.display()`.

**Call relations**: TLS builders for both gRPC and HTTP call this whenever they need CA, client certificate, or private key contents. It centralizes path-rich I/O errors so higher-level builders can focus on PEM parsing and protocol configuration.

*Call graph*: calls 1 internal fn (to_path_buf); called by 3 (build_async_http_client, build_grpc_tls_config, build_http_client_inner); 4 external calls (new, new, format!, read).


##### `config_error`  (lines 225–227)

```
fn config_error(message: impl Into<String>) -> Box<dyn Error>
```

**Purpose**: Creates a boxed invalid-data `io::Error` from a configuration message. It standardizes the error type returned by this module’s validation branches.

**Data flow**: Takes any `message` convertible into `String` → converts it, wraps it in `io::Error::new(ErrorKind::InvalidData, ...)`, boxes the error, and returns `Box<dyn Error>`.

**Call relations**: This helper is used by the TLS and HTTP client builders whenever they need to reject malformed endpoint/TLS configuration or remap parsing failures into clearer configuration errors.

*Call graph*: called by 3 (build_async_http_client, build_grpc_tls_config, build_http_client_inner); 3 external calls (new, into, new).


##### `tests::current_tokio_runtime_is_multi_thread_detects_runtime_flavor`  (lines 236–257)

```
fn current_tokio_runtime_is_multi_thread_detects_runtime_flavor()
```

**Purpose**: Verifies that runtime-flavor detection distinguishes no runtime, current-thread runtime, and multi-thread runtime correctly. It protects the branching logic used by blocking HTTP client construction.

**Data flow**: Calls `current_tokio_runtime_is_multi_thread()` outside any runtime and asserts false → builds a current-thread runtime and asserts the function returns false inside it → builds a multi-thread runtime and asserts the function returns true inside it.

**Call relations**: This test directly exercises `current_tokio_runtime_is_multi_thread`, which is later consumed by `build_http_client` and trace exporter setup. It exists to prevent regressions in runtime-sensitive branching.

*Call graph*: 4 external calls (new_current_thread, new_multi_thread, assert!, assert_eq!).


##### `tests::build_http_client_works_in_current_thread_runtime`  (lines 260–271)

```
fn build_http_client_works_in_current_thread_runtime()
```

**Purpose**: Verifies that `build_http_client` succeeds even when called from a Tokio current-thread runtime. This covers the dedicated-thread fallback path that avoids blocking the runtime.

**Data flow**: Builds a current-thread Tokio runtime → runs `build_http_client(&OtelTlsConfig::default(), OTEL_EXPORTER_OTLP_TIMEOUT)` inside it → asserts that the returned `Result` is `Ok`.

**Call relations**: This test targets the non-multi-thread branch of `build_http_client`, ensuring the wrapper’s thread-spawn strategy correctly delegates to `build_http_client_inner` without runtime panics.

*Call graph*: calls 1 internal fn (build_http_client); 3 external calls (new_current_thread, assert!, default).


### `otel/src/metrics/client.rs`

`io_transport` · `metrics initialization, metric emission during runtime, runtime snapshot collection, and shutdown`

This file contains the full metrics implementation. At the bottom is `MetricsClient`, a cheap cloneable wrapper around `Arc<MetricsClientInner>`. The inner struct owns the `SdkMeterProvider`, a `Meter`, mutex-protected caches for counters, gauges, generic histograms, and duration histograms, an optional `ManualReader` for runtime snapshots, and a `BTreeMap` of default tags. Instrument caches are keyed by `InstrumentKey`, which includes metric name plus optional unit and description so repeated recordings reuse the same OTEL instrument instead of rebuilding it.

`MetricsClientInner` provides the actual recording methods. Each validates metric names, merges default tags with per-call tags via `attributes`, validates tag keys/values, lazily creates the appropriate OTEL instrument under a mutex, and records the sample. Counters reject negative increments explicitly. Duration recording uses dedicated histogram builders with fixed units, descriptions, and bucket boundaries for milliseconds or seconds.

`MetricsClient::new` translates `MetricsConfig` into an OTEL `Resource`, adding service version, environment, and sanitized OS attributes. It optionally creates a delta-temporality `ManualReader` for runtime snapshots, then builds either an in-memory or OTLP exporter pipeline. `build_provider` wires a periodic reader plus the optional shared manual reader into an `SdkMeterProvider`. `build_otlp_metric_exporter` handles exporter selection, Statsig indirection, gRPC vs HTTP protocol setup, headers, and TLS customization. Shutdown flushes then stops the provider; snapshot collection reads from the manual reader without shutting anything down.

#### Function details

##### `SharedManualReader::new`  (lines 70–72)

```
fn new(inner: Arc<ManualReader>) -> Self
```

**Purpose**: Wraps an `Arc<ManualReader>` in a small adapter type that itself implements `MetricReader`. This allows the same manual reader to be installed into the provider while still being retained for direct snapshot collection.

**Data flow**: Consumes an `Arc<ManualReader>`, stores it in `SharedManualReader { inner }`, and returns the wrapper.

**Call relations**: It is used by `build_provider` when runtime snapshots are enabled so the provider can own a reader implementation while `MetricsClientInner` keeps the original `Arc`.

*Call graph*: called by 1 (build_provider).


##### `SharedManualReader::register_pipeline`  (lines 76–78)

```
fn register_pipeline(&self, pipeline: Weak<Pipeline>)
```

**Purpose**: Forwards pipeline registration to the wrapped manual reader. It exists solely to satisfy the `MetricReader` trait.

**Data flow**: Reads the `Weak<Pipeline>` argument and passes it unchanged to `self.inner.register_pipeline(pipeline)`.

**Call relations**: This method is called by the OTEL SDK after the reader is attached to a provider.


##### `SharedManualReader::collect`  (lines 80–82)

```
fn collect(&self, rm: &mut ResourceMetrics) -> opentelemetry_sdk::error::OTelSdkResult
```

**Purpose**: Delegates metric collection into a `ResourceMetrics` buffer to the wrapped manual reader. It preserves the manual reader's collection behavior exactly.

**Data flow**: Takes a mutable `ResourceMetrics` reference, forwards it to `self.inner.collect(rm)`, and returns the OTEL SDK result.

**Call relations**: The OTEL SDK invokes this through the `MetricReader` trait, and `MetricsClient::snapshot` ultimately relies on the same underlying reader.


##### `SharedManualReader::force_flush`  (lines 84–86)

```
fn force_flush(&self) -> opentelemetry_sdk::error::OTelSdkResult
```

**Purpose**: Forwards force-flush requests to the wrapped manual reader. This is trait plumbing rather than custom logic.

**Data flow**: Calls `self.inner.force_flush()` and returns its result.

**Call relations**: It participates in provider lifecycle operations when the SDK flushes readers.


##### `SharedManualReader::shutdown_with_timeout`  (lines 88–90)

```
fn shutdown_with_timeout(&self, timeout: Duration) -> opentelemetry_sdk::error::OTelSdkResult
```

**Purpose**: Forwards timed shutdown requests to the wrapped manual reader. It ensures the wrapper behaves identically to the underlying reader during teardown.

**Data flow**: Receives a `Duration` timeout, passes it to `self.inner.shutdown_with_timeout(timeout)`, and returns the OTEL SDK result.

**Call relations**: This is used by the OTEL SDK when the provider is shutting down.


##### `SharedManualReader::temporality`  (lines 92–94)

```
fn temporality(&self, kind: InstrumentKind) -> Temporality
```

**Purpose**: Returns the aggregation temporality chosen by the wrapped manual reader for a given instrument kind. It preserves the manual reader's delta configuration.

**Data flow**: Reads the `InstrumentKind`, forwards it to `self.inner.temporality(kind)`, and returns the resulting `Temporality`.

**Call relations**: The OTEL SDK queries this through the `MetricReader` trait while configuring pipelines.


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

**Purpose**: Validates and records a counter increment, lazily creating and caching the OTEL counter instrument keyed by name and optional description. It rejects negative increments before touching OTEL state.

**Data flow**: Reads `name`, optional `description`, `inc`, and `tags`; validates the metric name; returns `NegativeCounterIncrement` if `inc < 0`; builds OTEL attributes via `attributes(tags)`; locks the `counters` map; constructs an `InstrumentKey`; inserts or reuses a `Counter<u64>` built from `self.meter`; adds `inc as u64` with the attributes; returns `Result<()>`.

**Call relations**: This is the internal implementation behind the public `MetricsClient::counter` and `counter_with_description` methods.

*Call graph*: calls 2 internal fn (attributes, validate_metric_name).


##### `MetricsClientInner::histogram`  (lines 146–159)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Validates and records an integer histogram sample, lazily creating a generic `f64` histogram instrument per metric name. It is used for non-duration histogram metrics.

**Data flow**: Validates `name`, converts tags to OTEL attributes with `attributes`, locks the `histograms` cache, inserts or reuses `self.meter.f64_histogram(name).build()`, records `value as f64`, and returns `Result<()>`.

**Call relations**: It backs the public `MetricsClient::histogram` method.

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

**Purpose**: Validates and records a gauge measurement, caching the OTEL gauge instrument by name and optional description. It supports both described and undescribed gauges.

**Data flow**: Validates the metric name, computes attributes, locks the `gauges` map, builds an `InstrumentKey`, inserts or reuses an `i64` gauge from `self.meter`, records the provided `value`, and returns `Result<()>`.

**Call relations**: It is the shared implementation behind `MetricsClient::gauge` and `gauge_with_description`.

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

**Purpose**: Records a duration-like floating-point sample into a histogram instrument configured with an explicit unit, description, and bucket boundaries. It caches instruments by name, unit, and description so millisecond and second histograms remain distinct.

**Data flow**: Validates `name`, computes attributes, locks `duration_histograms`, constructs an `InstrumentKey` containing `name`, `unit`, and `description`, inserts or reuses a histogram builder configured with `with_unit`, `with_description`, and `with_boundaries`, records `value`, and returns `Result<()>`.

**Call relations**: This is the internal primitive used by the public duration-recording methods.

*Call graph*: calls 2 internal fn (attributes, validate_metric_name).


##### `MetricsClientInner::attributes`  (lines 224–244)

```
fn attributes(&self, tags: &[(&str, &str)]) -> Result<Vec<KeyValue>>
```

**Purpose**: Builds the final OTEL attribute list by merging default tags with per-call tags and validating all caller-supplied keys and values. It ensures every metric emission uses a consistent attribute-construction path.

**Data flow**: If `tags` is empty, clones `default_tags` directly into `Vec<KeyValue>`. Otherwise it clones `default_tags` into a mutable `BTreeMap`, validates each incoming key and value, inserts them so per-call tags override defaults on duplicate keys, then converts the merged map into `Vec<KeyValue>`.

**Call relations**: All recording methods call this before touching OTEL instruments, so tag validation and default-tag merging happen uniformly.

*Call graph*: calls 2 internal fn (validate_tag_key, validate_tag_value); called by 4 (counter, duration_histogram, gauge, histogram).


##### `MetricsClientInner::shutdown`  (lines 246–255)

```
fn shutdown(&self) -> Result<()>
```

**Purpose**: Flushes pending metrics and shuts down the underlying OTEL meter provider. It wraps OTEL SDK errors in crate-specific `MetricsError` values.

**Data flow**: Logs a debug message, calls `self.meter_provider.force_flush()`, maps any failure to `MetricsError::ProviderShutdown`, then calls `self.meter_provider.shutdown()` with the same error mapping, and returns `Ok(())` on success.

**Call relations**: This is the implementation behind the public `MetricsClient::shutdown` method and is used during teardown.

*Call graph*: 3 external calls (force_flush, shutdown, debug!).


##### `MetricsClient::new`  (lines 264–318)

```
fn new(config: MetricsConfig) -> Result<Self>
```

**Purpose**: Constructs a fully configured metrics client from `MetricsConfig`, including resource attributes, exporter selection, provider creation, instrument caches, and optional runtime snapshot support. It is the main initialization entry point for metrics.

**Data flow**: Destructures `MetricsConfig`, validates `default_tags`, builds resource attributes for service version, environment, and sanitized OS info from `os_resource_attributes`, creates an OTEL `Resource`, optionally creates a delta `ManualReader` when `runtime_reader` is true, chooses between in-memory and OTLP exporters, builds the provider and meter via `build_provider`, initializes empty mutex-protected caches and stores the optional runtime reader and default tags inside `MetricsClientInner`, then returns `MetricsClient(Arc::new(...))`.

**Call relations**: It is called by session telemetry setup, provider setup, and tests; internally it delegates exporter-specific work to `build_otlp_metric_exporter` and provider wiring to `build_provider`.

*Call graph*: calls 4 internal fn (build_otlp_metric_exporter, build_provider, os_resource_attributes, validate_tags); called by 12 (test_session_telemetry, test_session_telemetry_without_metadata, test_session_telemetry, websocket_harness_with_provider_options, with_metrics_config, from, build_metrics_with_defaults, otlp_http_exporter_sends_metrics_to_collector, runtime_metrics_summary_collects_tool_api_and_streaming_metrics, manager_snapshot_metrics_collects_without_shutdown (+2 more)); 6 external calls (new, new, new, with_capacity, builder, new).


##### `MetricsClient::counter`  (lines 321–323)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Public convenience method for recording a counter increment without an instrument description. It simply forwards to the inner implementation.

**Data flow**: Reads `name`, `inc`, and `tags`, calls `self.0.counter(name, None, inc, tags)`, and returns the resulting `Result<()>`.

**Call relations**: This is the standard counter API used by session telemetry and process-start recording.

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

**Purpose**: Public counter API that also sets an OTEL instrument description on first use. It is useful for metrics that need richer schema metadata.

**Data flow**: Forwards `name`, `description`, `inc`, and `tags` to `self.0.counter(name, Some(description), inc, tags)` and returns the result.

**Call relations**: It is an alternate public entry point over the same inner counter logic.


##### `MetricsClient::histogram`  (lines 337–339)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Public API for recording a generic integer histogram sample. It delegates all validation and instrument caching to the inner client.

**Data flow**: Passes `name`, `value`, and `tags` to `self.0.histogram` and returns the resulting `Result<()>`.

**Call relations**: This is used when callers need histogram aggregation but not the duration-specific helpers.


##### `MetricsClient::gauge`  (lines 342–344)

```
fn gauge(&self, name: &str, value: i64, tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Public API for recording a gauge measurement without an instrument description. It is the simple gauge entry point.

**Data flow**: Forwards `name`, `value`, and `tags` to `self.0.gauge(name, None, value, tags)` and returns the result.

**Call relations**: It is the standard gauge wrapper over the inner implementation.


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

**Purpose**: Public gauge API that associates a description with the instrument. It allows richer metric metadata while reusing the same recording path.

**Data flow**: Calls `self.0.gauge(name, Some(description), value, tags)` and returns the resulting `Result<()>`.

**Call relations**: This is the described variant of the public gauge API.


##### `MetricsClient::record_duration`  (lines 358–372)

```
fn record_duration(
        &self,
        name: &str,
        duration: Duration,
        tags: &[(&str, &str)],
    ) -> Result<()>
```

**Purpose**: Records a duration in milliseconds using a histogram configured with millisecond units and predefined bucket boundaries. It is the primary duration metric API used by session telemetry.

**Data flow**: Converts the input `Duration` to milliseconds, clamps it to `i64::MAX` before casting to `f64`, and forwards the sample plus fixed unit/description/boundaries to `self.0.duration_histogram`.

**Call relations**: This is called by higher-level telemetry code whenever a latency should be aggregated in milliseconds.

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

**Purpose**: Records a duration in seconds using a histogram with caller-provided description text and second-based bucket boundaries. It supports metrics whose natural unit is seconds rather than milliseconds.

**Data flow**: Converts the input `Duration` to `as_secs_f64()`, then forwards the sample, `"s"` unit, caller description, and fixed second boundaries to `self.0.duration_histogram`.

**Call relations**: It is the alternate duration API for second-scale metrics with explicit descriptions.

*Call graph*: 1 external calls (as_secs_f64).


##### `MetricsClient::start_timer`  (lines 392–398)

```
fn start_timer(
        &self,
        name: &str,
        tags: &[(&str, &str)],
    ) -> std::result::Result<Timer, MetricsError>
```

**Purpose**: Creates a `Timer` object bound to this metrics client, metric name, and tag set. The timer can later record elapsed duration automatically.

**Data flow**: Constructs `Timer::new(name, tags, self)` and wraps it in `Ok(...)`, returning `std::result::Result<Timer, MetricsError>`.

**Call relations**: This is used by session telemetry and other callers that prefer scoped timing over manually measuring durations.

*Call graph*: calls 1 internal fn (new).


##### `MetricsClient::snapshot`  (lines 401–410)

```
fn snapshot(&self) -> Result<ResourceMetrics>
```

**Purpose**: Collects a runtime metrics snapshot from the optional manual reader without shutting down the provider. It is intended for debug/runtime summaries and delta resets.

**Data flow**: Reads `self.0.runtime_reader`; if absent, returns `MetricsError::RuntimeSnapshotUnavailable`. Otherwise it creates `ResourceMetrics::default()`, calls `reader.collect(&mut snapshot)`, maps collection failures to `MetricsError::RuntimeSnapshotCollect`, and returns the populated snapshot.

**Call relations**: This powers session-level runtime summaries and reset behavior when runtime-reader support was enabled at client construction.

*Call graph*: 1 external calls (default).


##### `MetricsClient::shutdown`  (lines 413–415)

```
fn shutdown(&self) -> Result<()>
```

**Purpose**: Public shutdown API that flushes and stops the underlying OTEL provider. It delegates directly to the inner shutdown logic.

**Data flow**: Calls `self.0.shutdown()` and returns its `Result<()>`.

**Call relations**: This is used during process or provider teardown.


##### `os_resource_attributes`  (lines 418–432)

```
fn os_resource_attributes() -> Vec<KeyValue>
```

**Purpose**: Builds sanitized OS-related resource attributes for the OTEL resource. It omits attributes whose sanitized value becomes `"unspecified"`.

**Data flow**: Calls `os_info::get()`, converts OS type and version to strings, sanitizes both with `sanitize_metric_tag_value`, conditionally pushes `KeyValue::new("os", ...)` and `KeyValue::new("os_version", ...)` into a vector when they are not `"unspecified"`, and returns the vector.

**Call relations**: It is called during `MetricsClient::new` so every metrics provider resource carries normalized OS metadata.

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

**Purpose**: Constructs the OTEL meter provider and meter from a resource, push exporter, optional export interval, and optional runtime manual reader. It wires together the periodic export pipeline and the optional snapshot pipeline.

**Data flow**: Builds a `PeriodicReader` from the exporter, optionally applies `with_interval`, creates an `SdkMeterProvider::builder()` with the resource, optionally adds a `SharedManualReader` wrapping the provided `ManualReader`, adds the periodic reader, builds the provider, obtains `provider.meter(METER_NAME)`, and returns `(SdkMeterProvider, Meter)`.

**Call relations**: It is called by `MetricsClient::new` after exporter selection to produce the concrete provider used for all metric recording.

*Call graph*: calls 1 internal fn (new); called by 1 (new); 2 external calls (builder, builder).


##### `build_otlp_metric_exporter`  (lines 457–531)

```
fn build_otlp_metric_exporter(
    exporter: OtelExporter,
    temporality: Temporality,
) -> Result<opentelemetry_otlp::MetricExporter>
```

**Purpose**: Builds an OTLP metric exporter from the crate's exporter configuration, handling disabled exporters, Statsig indirection, gRPC vs HTTP transport, headers, protocol selection, and TLS customization. It translates configuration errors into `MetricsError` values.

**Data flow**: Pattern-matches `OtelExporter`. `None` returns `ExporterDisabled`. `Statsig` resolves to a concrete exporter via `crate::config::resolve_exporter` and recurses. `OtlpGrpc` logs the endpoint, builds a header map, creates a base `ClientTlsConfig`, optionally customizes it with `crate::otlp::build_grpc_tls_config`, then builds a tonic-based exporter with endpoint, temporality, metadata, and TLS. `OtlpHttp` logs the endpoint, maps `OtelHttpProtocol` to OTLP `Protocol`, builds an HTTP exporter with endpoint, temporality, protocol, and headers, optionally injects a custom HTTP client from `crate::otlp::build_http_client`, then builds the exporter. Build failures are mapped to `MetricsError::ExporterBuild`; TLS/config failures become `InvalidConfig`.

**Call relations**: It is called only by `MetricsClient::new` when the selected exporter is OTLP-based.

*Call graph*: calls 4 internal fn (resolve_exporter, build_grpc_tls_config, build_header_map, build_http_client); called by 1 (new); 4 external calls (new, from_headers, debug!, builder).


### `otel/src/metrics/timer.rs`

`domain_logic` · `around timed operations and scope exit`

This file provides the `Timer` type used by the metrics subsystem to capture durations without requiring callers to manually compute elapsed time. A timer stores four pieces of state: the metric name as an owned `String`, a cloned owned copy of the base tags as `Vec<(String, String)>`, a cloned `MetricsClient`, and the `Instant` captured at creation. Owning the name and tags lets the timer outlive the borrowed inputs passed to `new`, and cloning the client makes the timer self-contained.

The design is intentionally RAII-based. `Timer::new` snapshots `Instant::now()` and copies the provided tags into owned strings. `Timer::record` computes elapsed time from `start_time`, prepends any `additional_tags` supplied at call time, then appends the timer’s stored base tags and forwards the duration to `MetricsClient::record_duration`. The ordering means ad hoc tags appear before the timer’s default tags in the exported slice. The `Drop` implementation calls `record(&[])` automatically, ensuring a duration is emitted even if the caller forgets to record manually. Errors during drop cannot be returned, so they are logged with `tracing::error!` instead of panicking. That makes timer cleanup best-effort and non-fatal during unwinding or scope exit.

#### Function details

##### `Timer::drop`  (lines 14–18)

```
fn drop(&mut self)
```

**Purpose**: Automatically records the timer’s duration when the timer leaves scope. It converts any recording failure into an error log instead of surfacing it to the caller.

**Data flow**: Reads the timer’s stored name, tags, client, and start time through `self.record(&[])` → if recording returns `Err`, formats and emits a tracing error message → returns no value and does not mutate externally visible state beyond the metric/log side effects.

**Call relations**: This is invoked implicitly by Rust’s drop semantics whenever a `Timer` is destroyed. It delegates to `Timer::record` with no extra tags so the normal recording path is reused, and only adds logging for the error-only drop context.

*Call graph*: calls 1 internal fn (record); 1 external calls (error!).


##### `Timer::new`  (lines 22–32)

```
fn new(name: &str, tags: &[(&str, &str)], client: &MetricsClient) -> Self
```

**Purpose**: Constructs a self-contained timer from a metric name, borrowed tag slice, and metrics client. It snapshots the start instant immediately so later recordings measure elapsed time from creation.

**Data flow**: Takes `name: &str`, `tags: &[(&str, &str)]`, and `client: &MetricsClient` → clones the metric name into a `String`, maps each borrowed tag pair into owned `(String, String)` entries, clones the client handle, captures `Instant::now()`, and returns a populated `Timer`.

**Call relations**: This constructor is called by the higher-level `start_timer` API in the metrics client layer. It performs all ownership conversion up front so later `record` and `drop` calls can run without borrowing the original inputs.

*Call graph*: called by 1 (start_timer); 2 external calls (now, clone).


##### `Timer::record`  (lines 34–40)

```
fn record(&self, additional_tags: &[(&str, &str)]) -> Result<()>
```

**Purpose**: Records the elapsed duration since timer creation, optionally augmenting the metric with extra tags supplied at record time. It is the shared implementation used by both explicit recording and drop-based recording.

**Data flow**: Accepts `additional_tags: &[(&str, &str)]` and reads `self.tags`, `self.name`, `self.client`, and `self.start_time` → allocates a combined tag vector sized for both tag sets, extends it first with `additional_tags` and then with borrowed views of the stored owned tags, computes `self.start_time.elapsed()`, and passes name, duration, and tags to `MetricsClient::record_duration` → returns that `Result<()>`.

**Call relations**: This method is called directly by `Timer::drop` and may also be used by callers that want to record before scope exit. It delegates the actual metric emission to `MetricsClient::record_duration`, keeping this type focused on elapsed-time calculation and tag assembly.

*Call graph*: calls 1 internal fn (record_duration); called by 1 (drop); 2 external calls (elapsed, with_capacity).


### `otel/src/metrics/process.rs`

`domain_logic` · `startup / first metrics initialization in a process`

This file contains a single helper for emitting the `PROCESS_START_METRIC` at most once. The module-level `PROCESS_START_RECORDED: AtomicBool` starts as `false` and acts as a lock-free guard across the entire process. `record_process_start_once` uses `compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)` to claim the right to emit the metric; if another caller has already done so, the function returns `Ok(false)` without touching the metrics client.

On the first successful call, it records a counter increment of 1 using the provided `MetricsClient`. The metric includes a single originator tag built from `ORIGINATOR_TAG` and `bounded_originator_tag_value(originator)`, ensuring the originator dimension is normalized and bounded before being sent. The function then returns `Ok(true)` to indicate that this invocation actually emitted the metric.

The design is intentionally minimal: there is no reset path, and relaxed atomics are sufficient because the only invariant is one-time emission, not synchronization of additional state. Any metrics-layer failure is propagated to the caller rather than swallowed.

#### Function details

##### `record_process_start_once`  (lines 13–27)

```
fn record_process_start_once(metrics: &MetricsClient, originator: &str) -> Result<bool>
```

**Purpose**: Records the process-start counter exactly once for the lifetime of the process and reports whether this call performed the emission. It prevents duplicate startup counts across repeated initialization paths.

**Data flow**: Reads and updates the static `PROCESS_START_RECORDED` atomic with `compare_exchange`; if the exchange fails, returns `Ok(false)`. On success, computes a bounded originator tag with `bounded_originator_tag_value(originator)`, calls `metrics.counter(PROCESS_START_METRIC, 1, &[(ORIGINATOR_TAG, ...)])`, propagates any metrics error, and returns `Ok(true)`.

**Call relations**: It is called by startup/setup code after a metrics client exists, using the metrics client's standard counter API for the actual emission.

*Call graph*: calls 2 internal fn (counter, bounded_originator_tag_value).


### `otel/src/metrics/runtime_metrics.rs`

`domain_logic` · `runtime snapshot inspection and post-hoc telemetry summarization`

This file is the read-side summarizer for runtime metrics snapshots. `RuntimeMetricTotals` is a tiny pair of `count` and `duration_ms` with helpers for emptiness checks and saturating merges. `RuntimeMetricsSummary` then groups those totals into higher-level categories—tool calls, API calls, SSE streaming events, websocket requests, websocket events—and also stores standalone duration totals for Responses API overhead/inference/engine timing plus turn TTFT and TTFM.

The summary logic is intentionally asymmetric. `is_empty` requires every grouped total and standalone duration to be zero. `merge` saturating-adds the grouped totals but treats the standalone timing fields as last-nonzero wins: if the incoming summary has a positive value, it replaces the current one. `responses_api_summary` returns a copy containing only the Responses API timing fields and zero/default values elsewhere.

`from_snapshot` is the main extractor. It reads a `ResourceMetrics` snapshot and computes each field by summing either counters or histogram sums for specific metric-name constants. The helper functions traverse all scope metrics in the snapshot, filter by metric name, and then inspect the aggregated metric data. Counter extraction only accepts `AggregatedMetrics::U64(MetricData::Sum(_))`; histogram extraction only accepts `AggregatedMetrics::F64(MetricData::Histogram(_))`. Histogram sums are converted to `u64` with `f64_to_u64`, which rejects non-finite and non-positive values and clamps huge values before rounding.

#### Function details

##### `RuntimeMetricTotals::is_empty`  (lines 31–33)

```
fn is_empty(self) -> bool
```

**Purpose**: Checks whether both the count and duration components are zero. It is the basic emptiness predicate for grouped runtime totals.

**Data flow**: Reads `self.count` and `self.duration_ms`, compares both to zero, and returns a `bool`.

**Call relations**: It is used by `RuntimeMetricsSummary::is_empty` to determine whether grouped categories contain any data.

*Call graph*: called by 1 (is_empty).


##### `RuntimeMetricTotals::merge`  (lines 35–38)

```
fn merge(&mut self, other: Self)
```

**Purpose**: Adds another totals struct into this one using saturating arithmetic. It prevents overflow while combining counts and durations from multiple summaries.

**Data flow**: Reads `other.count` and `other.duration_ms`, updates `self.count` and `self.duration_ms` with `saturating_add`, and returns `()`.

**Call relations**: It is called by `RuntimeMetricsSummary::merge` for each grouped category.

*Call graph*: called by 1 (merge).


##### `RuntimeMetricsSummary::is_empty`  (lines 59–73)

```
fn is_empty(self) -> bool
```

**Purpose**: Checks whether the entire summary contains no recorded activity or timing data. Every grouped total must be empty and every standalone timing field must be zero.

**Data flow**: Calls `is_empty()` on `tool_calls`, `api_calls`, `streaming_events`, `websocket_calls`, and `websocket_events`, directly compares each standalone timing field to zero, and returns the combined boolean result.

**Call relations**: It is used by session telemetry to suppress returning an all-zero runtime summary.

*Call graph*: calls 1 internal fn (is_empty).


##### `RuntimeMetricsSummary::merge`  (lines 75–105)

```
fn merge(&mut self, other: Self)
```

**Purpose**: Combines another summary into this one, summing grouped totals and replacing standalone timing fields when the incoming value is positive. This supports incremental aggregation while preserving the latest nonzero timing breakdowns.

**Data flow**: Calls `merge` on each `RuntimeMetricTotals` field, then for each standalone timing field checks `if other.<field> > 0` and overwrites `self.<field>` when true. It mutates `self` in place and returns `()`.

**Call relations**: It is used when multiple runtime summaries need to be folded together, with grouped activity accumulated and timing breakdowns treated as overwrite-on-presence.

*Call graph*: calls 1 internal fn (merge).


##### `RuntimeMetricsSummary::responses_api_summary`  (lines 107–117)

```
fn responses_api_summary(&self) -> RuntimeMetricsSummary
```

**Purpose**: Returns a summary containing only the Responses API timing breakdown fields, with all other categories reset to defaults. It is a projection helper for callers interested only in websocket timing metrics.

**Data flow**: Constructs a new `RuntimeMetricsSummary` copying the six Responses API timing fields from `self` and filling the remaining fields from `RuntimeMetricsSummary::default()`.

**Call relations**: It is used by higher-level logging/reporting code that wants just the Responses API timing subset.

*Call graph*: called by 1 (log_websocket_timing_totals); 1 external calls (default).


##### `RuntimeMetricsSummary::from_snapshot`  (lines 119–169)

```
fn from_snapshot(snapshot: &ResourceMetrics) -> Self
```

**Purpose**: Builds a runtime summary by extracting named counters and histogram sums from an OTEL `ResourceMetrics` snapshot. It is the main translation from raw OTEL data to compact application-level totals.

**Data flow**: For each grouped category, calls `sum_counter` on the corresponding count metric and `sum_histogram_ms` on the corresponding duration metric to build `RuntimeMetricTotals`. For standalone timing fields, calls `sum_histogram_ms` on each dedicated metric constant. It then returns a populated `RuntimeMetricsSummary`.

**Call relations**: It is called by `SessionTelemetry::runtime_metrics_summary` after a snapshot has been collected.

*Call graph*: calls 2 internal fn (sum_counter, sum_histogram_ms); called by 1 (runtime_metrics_summary).


##### `sum_counter`  (lines 172–179)

```
fn sum_counter(snapshot: &ResourceMetrics, name: &str) -> u64
```

**Purpose**: Sums all matching counter metrics with a given name across every scope in a snapshot. It abstracts the traversal over OTEL scope metrics.

**Data flow**: Iterates `snapshot.scope_metrics()`, flattens each scope's metrics, filters metrics whose `name()` equals the requested `name`, maps each through `sum_counter_metric`, sums the resulting `u64` values, and returns the total.

**Call relations**: It is used by `RuntimeMetricsSummary::from_snapshot` for all count-based fields.

*Call graph*: called by 1 (from_snapshot); 1 external calls (scope_metrics).


##### `sum_counter_metric`  (lines 181–189)

```
fn sum_counter_metric(metric: &Metric) -> u64
```

**Purpose**: Extracts the total value from a single OTEL counter metric when it has the expected aggregated shape. Unexpected metric data types contribute zero.

**Data flow**: Matches `metric.data()`. If it is `AggregatedMetrics::U64(MetricData::Sum(sum))`, it iterates the sum's data points, reads each point's `value`, sums them, and returns the total; otherwise it returns `0`.

**Call relations**: It is the per-metric helper used by `sum_counter`.

*Call graph*: 1 external calls (data).


##### `sum_histogram_ms`  (lines 191–198)

```
fn sum_histogram_ms(snapshot: &ResourceMetrics, name: &str) -> u64
```

**Purpose**: Sums the histogram `sum()` values for all matching histogram metrics with a given name across every scope in a snapshot. It is used for duration totals expressed in milliseconds.

**Data flow**: Iterates `snapshot.scope_metrics()`, flattens metrics, filters by metric name, maps each metric through `sum_histogram_metric_ms`, sums the resulting `u64` values, and returns the total.

**Call relations**: It is used by `RuntimeMetricsSummary::from_snapshot` for all duration-based fields.

*Call graph*: called by 1 (from_snapshot); 1 external calls (scope_metrics).


##### `sum_histogram_metric_ms`  (lines 200–208)

```
fn sum_histogram_metric_ms(metric: &Metric) -> u64
```

**Purpose**: Extracts the summed histogram total from a single OTEL histogram metric when it has the expected floating-point histogram shape. Non-histogram or differently typed metrics contribute zero.

**Data flow**: Matches `metric.data()`. If it is `AggregatedMetrics::F64(MetricData::Histogram(histogram))`, it iterates the histogram's data points, converts each point's `sum()` with `f64_to_u64`, sums the converted values, and returns the total; otherwise it returns `0`.

**Call relations**: It is the per-metric helper used by `sum_histogram_ms`.

*Call graph*: 1 external calls (data).


##### `f64_to_u64`  (lines 210–216)

```
fn f64_to_u64(value: f64) -> u64
```

**Purpose**: Safely converts a floating-point aggregate value into a nonnegative `u64` by rejecting invalid values and clamping large ones. It is used when reading histogram sums from OTEL snapshots.

**Data flow**: Reads `value: f64`, returns `0` if it is non-finite or `<= 0.0`, otherwise clamps it to `u64::MAX as f64`, rounds it, casts to `u64`, and returns the result.

**Call relations**: It is called by `sum_histogram_metric_ms` to normalize histogram sums before accumulation.


### Trace and event plumbing
These files provide trace-context propagation plus the shared event-target and event-emission helpers used by session telemetry.

### `otel/src/targets.rs`

`util` · `cross-cutting during tracing/log filtering`

This file contains the string constants and predicates that partition tracing targets into log-exportable and trace-safe categories. The constants establish a naming convention rooted at `codex_otel`, with `codex_otel.log_only` representing log-only traffic and `codex_otel.trace_safe` representing targets safe to emit through trace exporters.

The logic is intentionally minimal but important because provider filters depend on it. `is_trace_safe_target` is a pure prefix check against `OTEL_TRACE_SAFE_TARGET`, so any nested target such as `codex_otel.trace_safe.summary` is considered trace-safe. `is_log_export_target` first requires the broader `OTEL_TARGET_PREFIX`, then explicitly excludes anything classified as trace-safe. That means trace-safe targets are not duplicated into the log pipeline, while other `codex_otel.*` targets remain eligible for log export. By keeping these checks in one file, the provider’s log and trace filters can share the same target taxonomy without duplicating string rules.

#### Function details

##### `is_log_export_target`  (lines 5–7)

```
fn is_log_export_target(target: &str) -> bool
```

**Purpose**: Determines whether a tracing target should be exported as a log target. It accepts OTEL-prefixed targets except those reserved as trace-safe.

**Data flow**: Takes `target: &str` → checks `target.starts_with(OTEL_TARGET_PREFIX)` and `!is_trace_safe_target(target)` → returns the combined boolean.

**Call relations**: This predicate is called by `OtelProvider::log_export_filter`. It delegates the exclusion rule to `is_trace_safe_target` so the trace-safe prefix definition stays single-sourced.

*Call graph*: calls 1 internal fn (is_trace_safe_target); called by 1 (log_export_filter).


##### `is_trace_safe_target`  (lines 9–11)

```
fn is_trace_safe_target(target: &str) -> bool
```

**Purpose**: Determines whether a tracing target belongs to the trace-safe namespace. It is a simple prefix classifier.

**Data flow**: Takes `target: &str` → returns `target.starts_with(OTEL_TRACE_SAFE_TARGET)`.

**Call relations**: This predicate is used directly by `OtelProvider::trace_export_filter` and indirectly by `is_log_export_target` to keep trace-safe events out of the log pipeline.

*Call graph*: called by 2 (trace_export_filter, is_log_export_target).


### `otel/src/trace_context.rs`

`domain_logic` · `request/span propagation and provider configuration`

This file is the trace-context utility layer that sits beside the global tracer provider. It can read the current tracing span and emit a `W3cTraceContext`, parse incoming `traceparent`/`tracestate` headers into an OpenTelemetry `Context`, set a span’s parent from that context, and lazily bootstrap a parent context from `TRACEPARENT`/`TRACESTATE` environment variables. `TRACEPARENT_CONTEXT` caches the env-derived context in a `OnceLock<Option<Context>>`, while configured tracestate entries live in a process-global `OnceLock<RwLock<BTreeMap<String, BTreeMap<String, String>>>>` so they can be updated when provider settings change.

The most nuanced logic is tracestate handling. `span_w3c_trace_context` injects the current span context into a temporary header map using `TraceContextPropagator`, then merges any propagated tracestate with configured entries from the global map. `merge_tracestate_entries` parses existing tracestate if possible, warns and ignores invalid incoming values, then upserts configured members in reverse map order because `TraceState::insert` prepends members. Within each member, `merge_tracestate_member_fields` treats the opaque member value as semicolon-separated `key:value` fields so configured fields can replace matching existing fields without discarding unrelated ones.

Validation is strict before installation: `validate_tracestate_entries` and `validate_tracestate_member` encode configured field maps into member values, verify field-key and field-value grammar, ensure the final member value is header-safe, and finally ask `TraceState::from_key_value` to validate the resulting W3C structure. Invalid configuration becomes `InvalidInput` I/O errors with explicit messages. Tests cover valid parsing, invalid/missing traceparent rejection, and extraction of the current span’s hex trace ID.

#### Function details

##### `current_span_w3c_trace_context`  (lines 29–31)

```
fn current_span_w3c_trace_context() -> Option<W3cTraceContext>
```

**Purpose**: Extracts W3C trace context from the currently active tracing span. It is the convenience entry point for callers that do not already hold a `Span` handle.

**Data flow**: Calls `Span::current()` to obtain the active span → passes that span reference to `span_w3c_trace_context` → returns `Option<W3cTraceContext>`.

**Call relations**: This is a thin wrapper over `span_w3c_trace_context`, used when callers want the current span’s outbound trace headers without manually fetching the span first.

*Call graph*: calls 1 internal fn (span_w3c_trace_context); 1 external calls (current).


##### `span_w3c_trace_context`  (lines 33–50)

```
fn span_w3c_trace_context(span: &Span) -> Option<W3cTraceContext>
```

**Purpose**: Builds a `W3cTraceContext` from a specific tracing span, including merged configured tracestate entries. It returns `None` when the span has no valid OpenTelemetry span context.

**Data flow**: Accepts `&Span` → gets the OpenTelemetry `Context` via `span.context()` → checks `context.span().span_context().is_valid()` and returns `None` if invalid → injects the context into a temporary `HashMap` using `TraceContextPropagator`, removes any `tracestate`, reads the configured tracestate map from the global `RwLock`, merges propagated and configured tracestate via `merge_tracestate_entries`, and returns `Some(W3cTraceContext { traceparent, tracestate })`.

**Call relations**: Called by `current_span_w3c_trace_context`. It depends on `tracestate_entries` for global configured state and `merge_tracestate_entries` for the nontrivial tracestate upsert behavior.

*Call graph*: calls 2 internal fn (merge_tracestate_entries, tracestate_entries); called by 1 (current_span_w3c_trace_context); 3 external calls (new, context, new).


##### `set_tracestate_entries`  (lines 52–61)

```
fn set_tracestate_entries(
    entries: BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Installs the process-global configured tracestate entries after validating them. It replaces the entire stored map atomically under a write lock.

**Data flow**: Takes a `BTreeMap<String, BTreeMap<String, String>>` → validates it with `validate_tracestate_entries` → acquires a write lock from `tracestate_entries()`, recovering from poisoning if necessary → overwrites the stored map with the new entries → returns `Ok(())` or the validation error.

**Call relations**: Provider initialization calls this after configuration has been accepted, and also uses it to clear tracestate when telemetry is disabled. It delegates syntax checking to `validate_tracestate_entries` before mutating global state.

*Call graph*: calls 2 internal fn (tracestate_entries, validate_tracestate_entries); called by 1 (from).


##### `current_span_trace_id`  (lines 63–72)

```
fn current_span_trace_id() -> Option<String>
```

**Purpose**: Returns the current tracing span’s trace ID as a lowercase hex string when a valid span context exists. It is a lightweight helper for diagnostics and correlation.

**Data flow**: Gets `Span::current().context()`, then the current span and span context → if the span context is invalid, returns `None`; otherwise converts `trace_id()` to string and returns `Some(String)`.

**Call relations**: Tests call this inside an instrumented span to verify trace IDs are exposed correctly. It is independent of the richer W3C header-building path.

*Call graph*: called by 1 (current_span_trace_id_returns_hex_trace_id); 1 external calls (current).


##### `context_from_w3c_trace_context`  (lines 74–76)

```
fn context_from_w3c_trace_context(trace: &W3cTraceContext) -> Option<Context>
```

**Purpose**: Parses the project’s `W3cTraceContext` struct into an OpenTelemetry `Context`. It is the inverse of the outbound header-building helpers.

**Data flow**: Accepts `&W3cTraceContext` → passes `trace.traceparent.as_deref()` and `trace.tracestate.as_deref()` to `context_from_trace_headers` → returns the resulting `Option<Context>`.

**Call relations**: This helper is used by `set_parent_from_w3c_trace_context` and by tests that validate parsing behavior. It delegates all actual extraction logic to `context_from_trace_headers`.

*Call graph*: calls 1 internal fn (context_from_trace_headers); called by 2 (set_parent_from_w3c_trace_context, parses_valid_w3c_trace_context).


##### `set_parent_from_w3c_trace_context`  (lines 78–85)

```
fn set_parent_from_w3c_trace_context(span: &Span, trace: &W3cTraceContext) -> bool
```

**Purpose**: Attempts to parse a W3C trace context and set it as the parent of a tracing span. It reports success as a boolean instead of surfacing parsing details.

**Data flow**: Takes `&Span` and `&W3cTraceContext` → calls `context_from_w3c_trace_context(trace)` → if parsing succeeds, passes the resulting `Context` to `set_parent_from_context(span, context)` and returns `true`; otherwise returns `false`.

**Call relations**: Callers use this when they receive inbound trace headers and want to continue the trace on a span. It composes parsing and parent-setting by delegating to `context_from_w3c_trace_context` and `set_parent_from_context`.

*Call graph*: calls 2 internal fn (context_from_w3c_trace_context, set_parent_from_context).


##### `set_parent_from_context`  (lines 87–89)

```
fn set_parent_from_context(span: &Span, context: Context)
```

**Purpose**: Sets an OpenTelemetry parent context on a tracing span. It intentionally ignores the return value from the underlying tracing extension method.

**Data flow**: Accepts `&Span` and `Context` → calls `span.set_parent(context)` and discards the result → returns `()`.

**Call relations**: This is the low-level parent-assignment helper used by `set_parent_from_w3c_trace_context` once parsing has succeeded.

*Call graph*: called by 1 (set_parent_from_w3c_trace_context); 1 external calls (set_parent).


##### `traceparent_context_from_env`  (lines 91–95)

```
fn traceparent_context_from_env() -> Option<Context>
```

**Purpose**: Lazily loads and caches a parent trace context from `TRACEPARENT` and optional `TRACESTATE` environment variables. Subsequent calls reuse the cached `Option<Context>`.

**Data flow**: Accesses the `TRACEPARENT_CONTEXT` `OnceLock` → initializes it with `load_traceparent_context` on first use → clones and returns the cached `Option<Context>`.

**Call relations**: This function is the public entry point for env-based trace continuation. It delegates one-time parsing and logging behavior to `load_traceparent_context`.


##### `context_from_trace_headers`  (lines 97–113)

```
fn context_from_trace_headers(
    traceparent: Option<&str>,
    tracestate: Option<&str>,
) -> Option<Context>
```

**Purpose**: Extracts an OpenTelemetry `Context` from raw `traceparent` and optional `tracestate` header values. It rejects missing or invalid `traceparent` values.

**Data flow**: Accepts `traceparent: Option<&str>` and `tracestate: Option<&str>` → returns `None` immediately if `traceparent` is absent → builds a temporary `HashMap` containing `traceparent` and optional `tracestate` strings → uses `TraceContextPropagator::new().extract(&headers)` to build a `Context` → returns `None` if the extracted span context is invalid, else `Some(context)`.

**Call relations**: This parser underpins both `context_from_w3c_trace_context` and `load_traceparent_context`. It is the central inbound extraction path for W3C trace headers.

*Call graph*: called by 2 (context_from_w3c_trace_context, load_traceparent_context); 2 external calls (new, new).


##### `load_traceparent_context`  (lines 115–129)

```
fn load_traceparent_context() -> Option<Context>
```

**Purpose**: Reads trace context from environment variables once and logs whether continuation succeeded or failed. It is the initializer used by the cached env-context accessor.

**Data flow**: Reads `TRACEPARENT` from the environment, returning `None` if absent; reads optional `TRACESTATE`; calls `context_from_trace_headers(Some(&traceparent), tracestate.as_deref())` → on success logs a debug message and returns `Some(context)`; on failure logs a warning and returns `None`.

**Call relations**: This function is only invoked through `traceparent_context_from_env`’s `OnceLock` initialization. It delegates parsing to `context_from_trace_headers` and adds the one-time logging side effects.

*Call graph*: calls 1 internal fn (context_from_trace_headers); 3 external calls (debug!, var, warn!).


##### `tracestate_entries`  (lines 131–133)

```
fn tracestate_entries() -> &'static RwLock<BTreeMap<String, BTreeMap<String, String>>>
```

**Purpose**: Returns the process-global lock protecting configured tracestate entries, initializing it on first use. It hides the `OnceLock<RwLock<...>>` plumbing behind a simple accessor.

**Data flow**: Accesses `TRACESTATE_ENTRIES` and, if uninitialized, installs `RwLock::new(BTreeMap::new())` → returns a shared reference to the `RwLock`.

**Call relations**: Both `set_tracestate_entries` and `span_w3c_trace_context` call this to mutate or read the configured tracestate map.

*Call graph*: called by 2 (set_tracestate_entries, span_w3c_trace_context).


##### `merge_tracestate_entries`  (lines 135–164)

```
fn merge_tracestate_entries(
    tracestate: Option<&str>,
    configured_entries: &BTreeMap<String, BTreeMap<String, String>>,
) -> Option<String>
```

**Purpose**: Merges propagated tracestate with configured tracestate members and returns the resulting header string. It preserves existing members where possible while upserting configured fields.

**Data flow**: Accepts optional incoming `tracestate` string and a configured member map → attempts to parse the incoming string with `TraceState::from_str`, warning and falling back to empty state on parse failure → iterates configured members in reverse key order, computes each merged member value with `merge_tracestate_member_fields(trace_state.get(key), fields)`, and inserts it into the `TraceState`; if insertion fails, warns and stops applying further configured members → serializes the final state with `.header()` and returns `Some(header)` unless the header is empty, in which case `None`.

**Call relations**: This function is called by `span_w3c_trace_context` when exporting the current span’s W3C context. It delegates per-member field merging to `merge_tracestate_member_fields` and owns the warning-and-continue behavior for malformed incoming or configured state.

*Call graph*: calls 1 internal fn (merge_tracestate_member_fields); called by 1 (span_w3c_trace_context); 1 external calls (warn!).


##### `validate_tracestate_entries`  (lines 167–190)

```
fn validate_tracestate_entries(
    entries: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Validates the full configured tracestate map before it is installed globally or used for propagation. It checks both the custom field grammar and the final W3C `TraceState` structure.

**Data flow**: Takes `&BTreeMap<String, BTreeMap<String, String>>` → maps each member through `encode_tracestate_member_fields`, collecting encoded `(key, value)` pairs or returning the first error → passes the encoded pairs to `TraceState::from_key_value(...)` to validate W3C member keys and list structure → on SDK validation failure, wraps the message in an `InvalidInput` `io::Error`; otherwise returns `Ok(())`.

**Call relations**: Provider setup and `set_tracestate_entries` call this before mutating global tracestate configuration. It delegates member encoding and field-level checks to `encode_tracestate_member_fields`.

*Call graph*: called by 2 (from, set_tracestate_entries); 1 external calls (from_key_value).


##### `validate_tracestate_member`  (lines 193–205)

```
fn validate_tracestate_member(
    member_key: &str,
    fields: &BTreeMap<String, String>,
) -> Result<(), Box<dyn std::error::Error>>
```

**Purpose**: Validates one configured tracestate member and its field map in isolation. It is useful for per-member config checks or diagnostics.

**Data flow**: Accepts `member_key: &str` and `&BTreeMap<String, String>` → encodes them with `encode_tracestate_member_fields` → validates the resulting single `(key, value)` pair with `TraceState::from_key_value([(key.as_str(), value.as_str())])` → returns `Ok(())` or an `InvalidInput` boxed error.

**Call relations**: This function is a narrower sibling of `validate_tracestate_entries`. It reuses the same encoding logic and final W3C validation path but for a single member.

*Call graph*: calls 1 internal fn (encode_tracestate_member_fields); 1 external calls (from_key_value).


##### `encode_tracestate_member_fields`  (lines 207–236)

```
fn encode_tracestate_member_fields(
    member_key: &str,
    fields: &BTreeMap<String, String>,
) -> Result<(String, String), Box<dyn std::error::Error>>
```

**Purpose**: Encodes a configured tracestate member’s field map into the opaque semicolon-separated member value used in the outgoing header. It enforces the project’s stricter field grammar before W3C validation.

**Data flow**: Takes `member_key: &str` and `&BTreeMap<String, String>` → allocates a vector sized to the number of fields → for each `(field_key, value)`, checks `is_configured_tracestate_field_key(field_key)` and `is_configured_tracestate_field_value(value)`, returning `invalid_tracestate_config(...)` on failure; otherwise pushes `format!("{field_key}:{value}")` → joins encoded fields with `;` into one member value → checks `is_header_safe_tracestate_member_value(&value)` and errors if unsafe → returns `(member_key.to_string(), value)`.

**Call relations**: This helper is called by `validate_tracestate_member` and indirectly by full-map validation. It delegates the low-level grammar checks to the `is_*` predicates and error construction to `invalid_tracestate_config`.

*Call graph*: calls 4 internal fn (invalid_tracestate_config, is_configured_tracestate_field_key, is_configured_tracestate_field_value, is_header_safe_tracestate_member_value); called by 1 (validate_tracestate_member); 2 external calls (with_capacity, format!).


##### `is_configured_tracestate_field_key`  (lines 238–243)

```
fn is_configured_tracestate_field_key(field_key: &str) -> bool
```

**Purpose**: Checks whether a configured tracestate field key uses only printable non-reserved bytes and is non-empty. It excludes separators that would break the custom `key:value;...` encoding.

**Data flow**: Accepts `field_key: &str` → returns `true` only if it is non-empty and every byte is in `!` through `~` excluding `:`, `;`, `,`, and `=`.

**Call relations**: Used exclusively by `encode_tracestate_member_fields` during validation of configured tracestate fields.

*Call graph*: called by 1 (encode_tracestate_member_fields).


##### `is_configured_tracestate_field_value`  (lines 245–249)

```
fn is_configured_tracestate_field_value(value: &str) -> bool
```

**Purpose**: Checks whether a configured tracestate field value is compatible with the custom semicolon-separated member encoding. It allows normal tracestate member bytes except semicolons.

**Data flow**: Accepts `value: &str` → returns `true` only if every byte satisfies `is_tracestate_member_value_byte(byte)` and is not `b';'`.

**Call relations**: Used only by `encode_tracestate_member_fields` to validate configured field values before joining them into one member string.

*Call graph*: called by 1 (encode_tracestate_member_fields).


##### `is_header_safe_tracestate_member_value`  (lines 251–255)

```
fn is_header_safe_tracestate_member_value(value: &str) -> bool
```

**Purpose**: Checks whether a fully encoded tracestate member value is safe to place in the outgoing header. It allows empty values and otherwise enforces valid bytes with no trailing space.

**Data flow**: Accepts `value: &str` → returns `true` if the string is empty, or if all bytes satisfy `is_tracestate_member_value_byte` and the last byte is not a space; otherwise returns `false`.

**Call relations**: This predicate is used by `encode_tracestate_member_fields` after field encoding to validate the final opaque member value as a whole.

*Call graph*: called by 1 (encode_tracestate_member_fields).


##### `is_tracestate_member_value_byte`  (lines 257–259)

```
fn is_tracestate_member_value_byte(byte: u8) -> bool
```

**Purpose**: Defines the allowed byte range for tracestate member values. It excludes commas and equals signs from otherwise printable ASCII.

**Data flow**: Accepts `byte: u8` → returns `true` when the byte is in `b' '..=b'~'` and not `b','` or `b'='`; otherwise `false`.

**Call relations**: This low-level predicate is used by both `is_configured_tracestate_field_value` and `is_header_safe_tracestate_member_value`.

*Call graph*: 1 external calls (matches!).


##### `invalid_tracestate_config`  (lines 261–266)

```
fn invalid_tracestate_config(message: String) -> Box<dyn std::error::Error>
```

**Purpose**: Constructs a boxed `InvalidInput` I/O error for malformed configured tracestate. It standardizes the error type returned by validation helpers.

**Data flow**: Takes a `String` message → wraps it in `std::io::Error::new(std::io::ErrorKind::InvalidInput, message)` → boxes and returns it as `Box<dyn Error>`.

**Call relations**: This helper is used by `encode_tracestate_member_fields` whenever a field key, field value, or final encoded member value violates the custom configuration grammar.

*Call graph*: called by 1 (encode_tracestate_member_fields); 2 external calls (new, new).


##### `merge_tracestate_member_fields`  (lines 268–300)

```
fn merge_tracestate_member_fields(
    existing: Option<&str>,
    configured_fields: &BTreeMap<String, String>,
) -> String
```

**Purpose**: Merges configured `key:value` fields into one existing tracestate member value without discarding unrelated existing fields. It preserves existing field order where possible and appends new configured fields at the end.

**Data flow**: Accepts `existing: Option<&str>` and configured field map → initializes an output `Vec<String>` and `BTreeSet` of seen field keys → if an existing member value is present, splits it on `;`, skips empty segments, and for each segment either replaces it with a configured `field_key:value` when the segment contains a known `field_key` and that key has not yet been seen, or preserves the original segment; tracks seen keys as it goes → extends the output with any configured fields whose keys were not seen in the existing value → joins the segments with `;` and returns the merged string.

**Call relations**: This helper is called by `merge_tracestate_entries` for each configured member. It implements the project-specific field-level upsert semantics inside otherwise opaque W3C tracestate member values.

*Call graph*: called by 1 (merge_tracestate_entries); 3 external calls (new, new, format!).


##### `tests::parses_valid_w3c_trace_context`  (lines 319–336)

```
fn parses_valid_w3c_trace_context()
```

**Purpose**: Verifies that a valid `traceparent` string is parsed into a remote OpenTelemetry span context with the expected trace and span IDs. It confirms the inbound extraction path preserves exact identifiers.

**Data flow**: Builds a `W3cTraceContext` with formatted `traceparent` and no `tracestate` → calls `context_from_w3c_trace_context` and unwraps the result → extracts the span context and asserts the parsed trace ID and span ID equal the expected hex values and that the context is marked remote.

**Call relations**: This test directly exercises `context_from_w3c_trace_context`, which delegates to `context_from_trace_headers`. It validates the successful parse branch.

*Call graph*: calls 1 internal fn (context_from_w3c_trace_context); 3 external calls (assert!, assert_eq!, format!).


##### `tests::invalid_traceparent_returns_none`  (lines 339–343)

```
fn invalid_traceparent_returns_none()
```

**Purpose**: Verifies that malformed `traceparent` input is rejected. It ensures invalid inbound headers do not produce a usable parent context.

**Data flow**: Calls `context_from_trace_headers(Some("not-a-traceparent"), None)` and asserts that the result is `None`.

**Call relations**: This test targets the invalid extraction branch inside `context_from_trace_headers`.

*Call graph*: 1 external calls (assert!).


##### `tests::missing_traceparent_returns_none`  (lines 346–354)

```
fn missing_traceparent_returns_none()
```

**Purpose**: Verifies that `tracestate` alone is insufficient to create a parent context. A missing `traceparent` must always yield `None`.

**Data flow**: Builds a `W3cTraceContext` with `traceparent: None` and a sample `tracestate` → calls `context_from_w3c_trace_context` → asserts the result is `None`.

**Call relations**: This test covers the early-return branch in `context_from_trace_headers` as reached through `context_from_w3c_trace_context`.

*Call graph*: 1 external calls (assert!).


##### `tests::current_span_trace_id_returns_hex_trace_id`  (lines 357–371)

```
fn current_span_trace_id_returns_hex_trace_id()
```

**Purpose**: Verifies that `current_span_trace_id` returns a nonzero 32-character hexadecimal trace ID when called inside an instrumented span. It confirms integration with tracing-opentelemetry span context propagation.

**Data flow**: Builds an `SdkTracerProvider` and tracer, installs a tracing subscriber with an OpenTelemetry layer, creates and enters a `trace_span!`, calls `current_span_trace_id()`, unwraps the result, and asserts length 32, all characters hex digits, and value not equal to all zeros.

**Call relations**: This test exercises `current_span_trace_id` in a realistic tracing setup where a current span has a valid OpenTelemetry context.

*Call graph*: calls 1 internal fn (current_span_trace_id); 7 external calls (builder, assert!, assert_eq!, assert_ne!, trace_span!, layer, registry).


### `otel/src/events/mod.rs`

`orchestration` · `cross-cutting`

This file is the root of the `otel::events` module tree. It declares two crate-visible submodules, `session_telemetry` and `shared`, without reexporting them publicly. That visibility choice indicates event emission is intended to be orchestrated internally by the telemetry crate rather than consumed directly as a broad public API. The split also reveals the internal organization: `session_telemetry` likely contains event definitions or emitters tied to session lifecycle and user interactions, while `shared` holds common event-building utilities, schemas, or helper logic reused across event producers. Although there is no executable code here, this module boundary matters because it determines how event code is compiled, namespaced, and accessed by sibling modules. In practice, this file is active whenever telemetry event functionality is referenced elsewhere in the crate, serving as the structural entry point that binds specialized event logic into the larger OpenTelemetry subsystem.


### `otel/src/events/shared.rs`

`util` · `cross-cutting whenever any telemetry event is emitted`

This file is the common formatting layer for telemetry events. Its three macros—`log_event!`, `trace_event!`, and `log_and_trace_event!`—wrap `tracing::event!` and append a consistent envelope of metadata derived from a `SessionTelemetry`-like `self` value. Both log and trace variants add `event.timestamp`, `conversation.id`, `app.version`, `auth_mode`, `originator`, `terminal.type`, `model`, and `slug`; the log-only variant additionally includes potentially more sensitive account fields (`user.account_id`, `user.email`) and targets `OTEL_LOG_ONLY_TARGET`, while the trace-safe variant targets `OTEL_TRACE_SAFE_TARGET` and omits those user identifiers. `log_and_trace_event!` simply expands to both macros with a shared `common` field block plus separate `log` and `trace` additions.

The only function, `timestamp`, generates the RFC 3339 UTC timestamp string used by the macros. The design keeps timestamp formatting and metadata injection centralized, which prevents drift across dozens of event call sites and enforces the distinction between log-only and trace-safe payloads. Because the macros read fields directly from `$self.metadata`, callers must provide a telemetry object with the expected metadata layout.

#### Function details

##### `timestamp`  (lines 58–60)

```
fn timestamp() -> String
```

**Purpose**: Returns the current UTC time formatted as an RFC 3339 string with millisecond precision and a `Z` suffix. This is the canonical event timestamp used by the telemetry macros.

**Data flow**: Calls `Utc::now()`, formats the result with `to_rfc3339_opts(SecondsFormat::Millis, true)`, and returns the resulting `String`.

**Call relations**: It is invoked implicitly by every expansion of `log_event!` and `trace_event!`, so all emitted telemetry events share the same timestamp format.

*Call graph*: 1 external calls (now).


### Transport telemetry callbacks
These files define the callback traits and wrappers that let client and API transport layers report request-attempt telemetry to observers.

### `codex-client/src/telemetry.rs`

`util` · `request handling`

This file defines a single trait, `RequestTelemetry`, which is the extension point for instrumentation around outbound HTTP requests. The trait is constrained by `Send + Sync`, signaling that implementations may be shared across threads and invoked from concurrent request paths. Its sole method, `on_request`, receives the attempt number, an optional `StatusCode`, an optional borrowed `TransportError`, and the elapsed `Duration`. That signature captures both successful and failed attempts in one callback: a caller can report a completed HTTP exchange with a status, a transport-level failure with an error, or combinations that reflect partial outcomes. By taking `&self` and borrowing the error, the interface avoids transferring ownership or forcing allocation in the hot path. This file intentionally contains no concrete telemetry backend; instead it defines the contract that retry loops and transport implementations use when emitting metrics, logs, or traces. The result is a low-level observability seam that keeps instrumentation policy outside the core request execution logic.


### `codex-api/src/telemetry.rs`

`util` · `cross-cutting request execution and streaming instrumentation`

This file is about instrumentation rather than request semantics. It declares two public traits: `SseTelemetry`, which receives the result and elapsed duration of each SSE poll, and `WebsocketTelemetry`, which records both request-level connection attempts and per-event WebSocket reads. The trait signatures expose the raw result types, including nested transport and timeout errors, so telemetry implementations can distinguish clean EOF, parser failures, network failures, and idle timeouts.

To support generic request telemetry across both unary and streaming HTTP calls, the file introduces a small internal trait `WithStatus` implemented for `codex_client::Response` and `codex_client::StreamResponse`. That lets `run_with_request_telemetry` treat both response types uniformly when extracting an HTTP status code.

`http_status` is a focused helper that pulls a `StatusCode` out of `TransportError::Http` and returns `None` for build/network/other transport failures. `run_with_request_telemetry` then wraps `codex_client::run_with_retry`: for each retry attempt it clones the optional `RequestTelemetry` sink and the send closure, records `Instant::now()`, awaits the actual send, derives `(status, err)` from the result, and invokes `t.on_request(attempt, status, err, elapsed)` if telemetry is configured. The wrapper returns the original transport result unchanged, so it adds observability without altering retry behavior or error semantics.

#### Function details

##### `http_status`  (lines 49–54)

```
fn http_status(err: &TransportError) -> Option<StatusCode>
```

**Purpose**: Extracts an HTTP status code from a transport error when the failure came from an HTTP response. Non-HTTP transport failures intentionally produce no status.

**Data flow**: Pattern-matches the borrowed `TransportError`; for `TransportError::Http { status, .. }` it returns `Some(*status)`, otherwise `None`.

**Call relations**: This helper is used inside `run_with_request_telemetry` so telemetry callbacks can still receive a status code on HTTP error responses.


##### `Response::status`  (lines 57–59)

```
fn status(&self) -> StatusCode
```

**Purpose**: Implements the internal `WithStatus` trait for unary HTTP responses by returning the response's stored status code. It provides a uniform interface for telemetry code.

**Data flow**: Reads `self.status` from `codex_client::Response` and returns it by value.

**Call relations**: This trait method allows `run_with_request_telemetry` to work generically over unary responses.


##### `StreamResponse::status`  (lines 63–65)

```
fn status(&self) -> StatusCode
```

**Purpose**: Implements the internal `WithStatus` trait for streaming HTTP responses by returning the stream response's status code. This keeps streaming and unary telemetry paths aligned.

**Data flow**: Reads `self.status` from `codex_client::StreamResponse` and returns it by value.

**Call relations**: This trait method is what lets `run_with_request_telemetry` instrument streaming request attempts as well as unary ones.


##### `run_with_request_telemetry`  (lines 68–98)

```
async fn run_with_request_telemetry(
    policy: RetryPolicy,
    telemetry: Option<Arc<dyn RequestTelemetry>>,
    make_request: impl FnMut() -> Request,
    send: F,
) -> Result<T, TransportError>
```

**Purpose**: Wraps `codex_client::run_with_retry` so each request attempt reports timing, status, and transport error information to an optional telemetry sink. It preserves the original retry policy and send behavior while adding observability.

**Data flow**: Consumes a `RetryPolicy`, optional `Arc<dyn RequestTelemetry>`, a `make_request` closure, and a clonable async `send` function. It passes them into `run_with_retry`, but replaces the send callback with an async closure that records `Instant::now()`, awaits `send(req)`, derives `(status, err)` from either the successful response's `WithStatus::status()` or `http_status(err)`, calls `t.on_request(attempt, status, err, elapsed)` when telemetry exists, and returns the original `Result<T, TransportError>`. The outer function awaits `run_with_retry` and returns its final result unchanged.

**Call relations**: Higher-level execution paths such as `execute_with` and `stream_encoded_json_with` call this wrapper instead of invoking `run_with_retry` directly, so all retry attempts are instrumented consistently.

*Call graph*: called by 2 (execute_with, stream_encoded_json_with); 1 external calls (run_with_retry).
