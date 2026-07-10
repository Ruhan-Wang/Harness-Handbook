# Session telemetry and feature-specific instrumentation  `stage-20.3`

This stage is the system’s shared “black box recorder” for a single session. It does not do the product’s main work by itself. Instead, it adds careful measurement around that work so developers can see what happened, how long it took, and which path was used, without exposing secrets.

At the center is the session telemetry layer, which gives the rest of the code one consistent way to emit logs, traces, and metrics, all stamped with the same session details. Turn timing adds a stopwatch for each user turn, breaking the response into milestones such as first output and tool wait time. App-server tracing marks incoming requests so activity can be followed across request boundaries.

Several files add tags and counters for specific features. Auth environment telemetry records only safe yes/no style signals about configuration. Sandbox tags summarize what safety sandbox was effectively active. Tool dispatch tracing records tool calls in a trace-friendly form. Guardian, cloud-config, goals, and memories each define their own stable metric names and tags. Finally, SQLite startup telemetry reports how database initialization and fallback behaved, so startup problems can be spotted early.

## Files in this stage

### Session telemetry foundation
These files establish the shared session-scoped telemetry surface and the core timing and environment context that other instrumentation builds on.

### `login/src/auth_env_telemetry.rs`

`config` · `startup`

This file defines `AuthEnvTelemetry`, a compact struct of booleans and optional metadata describing whether key auth-related environment variables are present. The fields cover OpenAI API key presence, Codex API key presence, whether Codex API key env support is enabled by configuration, whether the selected model provider has an env-key configured, whether that provider env var is present, and whether a refresh-token URL override env var is set.

The key privacy design choice is in `collect_auth_env_telemetry`: when a `ModelProviderInfo` contains `env_key`, the code does not copy the actual environment variable name into telemetry. Instead it buckets that fact as `Some("configured")`, while separately checking presence by dereferencing the real env var name only locally. This avoids leaking provider-specific secret names into telemetry payloads. `env_var_present` also treats non-Unicode environment values as present, since the signal of interest is existence/non-emptiness rather than readability.

`AuthEnvTelemetry::to_otel_metadata` converts the local struct into `codex_otel::AuthEnvTelemetryMetadata` for emission. The included test specifically locks down the bucketing behavior so a configured provider env key never appears verbatim in telemetry.

#### Function details

##### `AuthEnvTelemetry::to_otel_metadata`  (lines 19–28)

```
fn to_otel_metadata(&self) -> AuthEnvTelemetryMetadata
```

**Purpose**: Converts the local telemetry snapshot into the OpenTelemetry metadata type used by the broader telemetry pipeline.

**Data flow**: Reads all fields from `self`, clones `provider_env_key_name`, copies the booleans and optional presence flag into a new `AuthEnvTelemetryMetadata`, and returns it.

**Call relations**: This is the final adaptation step after collection, allowing callers that gather auth-env telemetry to pass it into the telemetry subsystem without exposing the internal struct.


##### `collect_auth_env_telemetry`  (lines 31–43)

```
fn collect_auth_env_telemetry(
    provider: &ModelProviderInfo,
    codex_api_key_env_enabled: bool,
) -> AuthEnvTelemetry
```

**Purpose**: Builds an `AuthEnvTelemetry` snapshot from the current process environment and the selected model provider configuration.

**Data flow**: Accepts a `&ModelProviderInfo` and a `codex_api_key_env_enabled` flag. It checks `OPENAI_API_KEY_ENV_VAR`, `CODEX_API_KEY_ENV_VAR`, and `REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR` with `env_var_present`; sets `provider_env_key_name` to `Some("configured")` when `provider.env_key` exists; and sets `provider_env_key_present` by checking the actual provider env var name when configured.

**Call relations**: Called during higher-level initialization paths that assemble telemetry context. It delegates raw environment probing to `env_var_present` and intentionally buckets provider key naming for privacy.

*Call graph*: calls 1 internal fn (env_var_present); called by 3 (new, collect_auth_env_telemetry_buckets_provider_env_key_name, new_with_provider).


##### `env_var_present`  (lines 45–51)

```
fn env_var_present(name: &str) -> bool
```

**Purpose**: Determines whether an environment variable should count as present for telemetry purposes.

**Data flow**: Reads `std::env::var(name)`. It returns `true` for non-empty Unicode values, `true` for `NotUnicode`, and `false` only for `NotPresent` or empty/whitespace-only Unicode values.

**Call relations**: Used exclusively by `collect_auth_env_telemetry` so all auth-env presence checks share the same semantics, especially around blank values and non-Unicode entries.

*Call graph*: called by 1 (collect_auth_env_telemetry); 1 external calls (var).


##### `tests::collect_auth_env_telemetry_buckets_provider_env_key_name`  (lines 60–88)

```
fn collect_auth_env_telemetry_buckets_provider_env_key_name()
```

**Purpose**: Verifies that telemetry records only the bucketed marker `configured` rather than the provider’s actual env var name.

**Data flow**: Constructs a `ModelProviderInfo` with `env_key: Some("sk-should-not-leak")`, calls `collect_auth_env_telemetry`, and asserts `provider_env_key_name == Some("configured".to_string())`.

**Call relations**: This test locks down the privacy-sensitive behavior in `collect_auth_env_telemetry` for provider env-key reporting.

*Call graph*: calls 1 internal fn (collect_auth_env_telemetry); 1 external calls (assert_eq!).


### `otel/src/events/session_telemetry.rs`

`domain_logic` · `startup, request handling, streaming, tool execution, and cross-cutting telemetry throughout a session`

This file is the core telemetry surface for a single Codex session. It defines two metadata structs—`AuthEnvTelemetryMetadata` for environment/auth discovery flags and `SessionTelemetryMetadata` for conversation ID, account identity, originator, model/slug, terminal type, and prompt-redaction policy—plus the `SessionTelemetry` wrapper that optionally owns a `MetricsClient`. Construction starts with `SessionTelemetry::new`, which sanitizes the originator, captures the crate version, and attaches the globally installed metrics client if one exists. Builder-style methods then override auth environment details, model/slug, service name, or metrics behavior, including a mode that suppresses automatic metadata tags.

The implementation splits into three concerns. First, generic metric helpers (`counter`, `histogram`, `record_duration`, `start_timer`) merge caller tags with session-derived tags via `metadata_tag_refs`, validate through the metrics layer, and downgrade failures to warnings. Second, domain-specific recorders emit concrete telemetry for startup phases, turn TTFT, plugin install prompts, API requests, websocket connect/request/event lifecycles, auth recovery, SSE polling, user prompts, tool approvals, sandbox outcomes, and tool execution results. These methods consistently derive success/failure tags, serialize durations in milliseconds, and include auth-env booleans and request identifiers where relevant. Third, response-stream helpers inspect `ResponseEvent`, `ResponseItem`, SSE payloads, and websocket JSON messages to classify event kinds, extract token usage, and parse special `responsesapi.websocket_timing` payloads into dedicated duration metrics.

Notable design choices: ping/pong websocket frames are ignored entirely; malformed websocket/SSE payloads are counted as failed events rather than panicking; user prompt text is logged only when `log_user_prompts` is enabled, while traces always omit raw prompt text; runtime metric snapshots are optional and used both for summaries and for resetting delta accumulators by collecting-and-discarding a snapshot.

#### Function details

##### `trace_field_value`  (lines 69–73)

```
fn trace_field_value(fields: &'a [(&str, &str)], key: &str) -> Option<&'a str>
```

**Purpose**: Looks up a named field inside a slice of `(key, value)` trace-field pairs and returns the matching string value if present. It is a tiny extractor used to pull specific optional annotations back out of caller-supplied metadata.

**Data flow**: Reads the borrowed `fields` slice and the target `key`, scans linearly with `iter().find_map`, compares each tuple's key to `key`, and returns `Option<&str>` pointing into the original slice without allocating.

**Call relations**: It is used during tool result emission when `SessionTelemetry::tool_result_with_tags` needs to recover `mcp_server` and `mcp_server_origin` from the extra trace fields supplied by its caller.

*Call graph*: called by 1 (tool_result_with_tags).


##### `SessionTelemetry::with_auth_env`  (lines 110–113)

```
fn with_auth_env(mut self, auth_env: AuthEnvTelemetryMetadata) -> Self
```

**Purpose**: Overrides the auth-environment metadata attached to the session telemetry object. This lets callers enrich an already-created session with discovered environment-key presence and related auth flags.

**Data flow**: Consumes `self` mutably plus an `AuthEnvTelemetryMetadata`, writes that value into `self.metadata.auth_env`, and returns the updated `SessionTelemetry` by value.

**Call relations**: This is a builder-style customization step applied after construction and before telemetry emission so later event methods include the updated auth environment fields.


##### `SessionTelemetry::with_model`  (lines 115–119)

```
fn with_model(mut self, model: &str, slug: &str) -> Self
```

**Purpose**: Replaces the session's model and slug metadata. It is used when the effective model identity becomes known or needs to be overridden after initial construction.

**Data flow**: Consumes `self`, clones the provided `model` and `slug` strings into owned `String`s, stores them in `self.metadata`, and returns the modified session telemetry.

**Call relations**: As a builder method, it prepares metadata consumed later by all log/trace macros and by metric-tag generation.


##### `SessionTelemetry::with_metrics_service_name`  (lines 121–124)

```
fn with_metrics_service_name(mut self, service_name: &str) -> Self
```

**Purpose**: Sets the service-name metric tag attached to this session, sanitizing it for metric-tag safety. This affects only metric tagging, not the general event payload fields.

**Data flow**: Consumes `self`, reads the input `service_name`, passes it through `sanitize_metric_tag_value`, stores the sanitized string in `self.metadata.service_name`, and returns the updated object.

**Call relations**: It is part of session setup; later `metadata_tag_refs` includes this field when automatic metadata tags are enabled.

*Call graph*: 1 external calls (sanitize_metric_tag_value).


##### `SessionTelemetry::with_metrics`  (lines 126–130)

```
fn with_metrics(mut self, metrics: MetricsClient) -> Self
```

**Purpose**: Attaches a concrete metrics client and enables automatic session metadata tags on all metric emissions. It is the normal path for turning on metrics for a session.

**Data flow**: Consumes `self`, stores `Some(metrics)` into `self.metrics`, sets `metrics_use_metadata_tags` to `true`, and returns the updated telemetry object.

**Call relations**: It is the common sink used by configuration-based and provider-based setup paths so subsequent metric helpers can emit through the attached client.

*Call graph*: called by 2 (with_metrics_config, with_provider_metrics).


##### `SessionTelemetry::with_metrics_without_metadata_tags`  (lines 132–136)

```
fn with_metrics_without_metadata_tags(mut self, metrics: MetricsClient) -> Self
```

**Purpose**: Attaches a metrics client but disables automatic session metadata tags. This supports callers that want explicit tags only, without originator/model/auth/session-source enrichment.

**Data flow**: Consumes `self`, stores `Some(metrics)`, sets `metrics_use_metadata_tags` to `false`, and returns the modified telemetry object.

**Call relations**: This is an alternate setup path chosen when the caller wants metrics enabled but does not want `metadata_tag_refs` merged into every metric.


##### `SessionTelemetry::with_metrics_config`  (lines 138–141)

```
fn with_metrics_config(self, config: MetricsConfig) -> MetricsResult<Self>
```

**Purpose**: Builds a `MetricsClient` from a `MetricsConfig` and attaches it to the session. It combines metrics-client construction with the standard metadata-tag-enabled attachment behavior.

**Data flow**: Consumes `self` and a `MetricsConfig`, invokes `MetricsClient::new(config)` which may fail, then on success feeds the client into `with_metrics` and returns `MetricsResult<Self>`.

**Call relations**: This is used during setup when the caller has raw metrics configuration rather than an already-instantiated provider or client.

*Call graph*: calls 2 internal fn (with_metrics, new).


##### `SessionTelemetry::with_provider_metrics`  (lines 143–148)

```
fn with_provider_metrics(self, provider: &OtelProvider) -> Self
```

**Purpose**: Copies the metrics client out of an `OtelProvider` if one is installed and attaches it to the session. If the provider has no metrics client, it leaves the session unchanged.

**Data flow**: Consumes `self` and reads `provider.metrics()`. On `Some`, it clones the provider's `MetricsClient` and passes it to `with_metrics`; on `None`, it returns the original `self`.

**Call relations**: This is the provider-wiring path during initialization, bridging provider-level OTEL setup into session-scoped telemetry.

*Call graph*: calls 2 internal fn (with_metrics, metrics).


##### `SessionTelemetry::counter`  (lines 150–163)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Emits a single counter increment through the attached metrics client, automatically merging session metadata tags when configured. It intentionally swallows exporter/validation failures after logging a warning.

**Data flow**: Reads `self.metrics`; if absent, returns early with success semantics. Otherwise it calls `tags_with_metadata(tags)`, then `metrics.counter(name, inc, &tags)`. Any `MetricsError` is caught and logged with `tracing::warn!`; no value is returned.

**Call relations**: This is the shared primitive behind many higher-level telemetry methods such as API, websocket, SSE, plugin, and tool metrics, and is also used elsewhere in the crate for ad hoc counters.

*Call graph*: called by 17 (force_http_fallback, emit_guardian_review_metrics, emit_compact_metric, emit_turn_memory_metric, emit_turn_network_proxy_metric, emit_unified_exec_tty_metric, emit_metrics, counter, counter, record_api_request (+7 more)); 1 external calls (warn!).


##### `SessionTelemetry::histogram`  (lines 165–178)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)])
```

**Purpose**: Records an integer histogram sample through the attached metrics client with optional session metadata tags. Like `counter`, it treats metrics failures as non-fatal.

**Data flow**: Reads the optional metrics client, merges metadata tags via `tags_with_metadata`, calls `metrics.histogram(name, value, &tags)`, and logs a warning if validation or export fails.

**Call relations**: It serves as the generic histogram helper for callers that need raw integer samples rather than duration-specific recording.

*Call graph*: called by 3 (emit_guardian_token_usage_histograms, histogram, histogram); 1 external calls (warn!).


##### `SessionTelemetry::record_duration`  (lines 180–193)

```
fn record_duration(&self, name: &str, duration: Duration, tags: &[(&str, &str)])
```

**Purpose**: Records a `Duration` sample into a duration histogram metric, enriching tags with session metadata when enabled. It is the standard duration-recording primitive used throughout the file.

**Data flow**: Reads `self.metrics`; if present, merges tags with `tags_with_metadata`, forwards to `metrics.record_duration(name, duration, &tags)`, and warns on any `MetricsError`. It returns nothing.

**Call relations**: Most timing-oriented methods delegate here, including startup phases, API requests, websocket requests/events, turn TTFT, tool durations, and parsed responses timing metrics.

*Call graph*: called by 11 (emit_guardian_review_metrics, resolve, record_api_request, record_responses_websocket_timing_metrics, record_startup_phase, record_turn_ttft, record_websocket_event, record_websocket_request, sse_event, sse_event_failed (+1 more)); 1 external calls (warn!).


##### `SessionTelemetry::record_startup_phase`  (lines 196–218)

```
fn record_startup_phase(
        &self,
        phase: &'static str,
        duration: Duration,
        status: Option<&'static str>,
    )
```

**Purpose**: Records a coarse startup phase duration both as a metric and as a structured production telemetry event. It optionally tags the phase with a status string such as success/failure.

**Data flow**: Builds a small `Vec` of tags containing `phase` and optional `status`, sends the duration to `STARTUP_PHASE_DURATION_METRIC` via `record_duration`, then emits a combined log/trace event with `event.name`, phase, status, and `duration_ms`.

**Call relations**: It is invoked during startup-resolution flows to produce latency breakdown telemetry while reusing the generic duration recorder.

*Call graph*: calls 1 internal fn (record_duration); called by 1 (resolve); 2 external calls (log_and_trace_event!, vec!).


##### `SessionTelemetry::record_turn_ttft`  (lines 221–232)

```
fn record_turn_ttft(&self, duration: Duration)
```

**Purpose**: Captures time-to-first-token for a turn as both a metric and a structured event. This gives both aggregate latency histograms and per-turn observability.

**Data flow**: Writes the duration to `TURN_TTFT_DURATION_METRIC` with no extra tags, then emits a log-and-trace event named `codex.turn_ttft` containing `duration_ms`.

**Call relations**: It is called when the system determines the first-token latency for a turn and delegates metric storage to `record_duration`.

*Call graph*: calls 1 internal fn (record_duration); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::record_plugin_install_elicitation_sent`  (lines 235–257)

```
fn record_plugin_install_elicitation_sent(
        &self,
        tool_type: &str,
        tool_id: &str,
        tool_name: &str,
    )
```

**Purpose**: Records that the UI or agent surfaced an install elicitation for a plugin or connector. It captures the tool type in metrics and the concrete tool identity in event telemetry.

**Data flow**: Increments `PLUGIN_INSTALL_ELICITATION_SENT_METRIC` with a `tool_type` tag, then emits a log/trace event containing `tool_type`, `tool_id`, and `tool_name` under `plugin_install.*` fields.

**Call relations**: This is a specialized domain event emitted at the moment an install prompt is dispatched.

*Call graph*: calls 1 internal fn (counter); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::record_plugin_install_suggestion`  (lines 260–293)

```
fn record_plugin_install_suggestion(
        &self,
        tool_type: &str,
        tool_id: &str,
        tool_name: &str,
        response_action: &str,
        user_confirmed: bool,
        comple
```

**Purpose**: Records the outcome of a plugin or connector install suggestion, including the surfaced action, whether the user confirmed it, and whether the flow completed. Metrics aggregate by tool type, action, and completion state.

**Data flow**: Converts `completed` to a string tag, increments `PLUGIN_INSTALL_SUGGESTION_METRIC` with `tool_type`, `response_action`, and `completed`, then emits a structured event with tool identity plus boolean `user_confirmed` and `completed` fields.

**Call relations**: It is used after a suggestion interaction resolves, complementing the earlier elicitation event.

*Call graph*: calls 1 internal fn (counter); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::start_timer`  (lines 295–301)

```
fn start_timer(&self, name: &str, tags: &[(&str, &str)]) -> Result<Timer, MetricsError>
```

**Purpose**: Starts a metrics timer for a named metric using the session's metrics client and merged metadata tags. Unlike the fire-and-forget helpers, it returns an error if metrics are unavailable or tags are invalid.

**Data flow**: Reads `self.metrics`; if absent, returns `MetricsError::ExporterDisabled`. Otherwise it computes merged tags with `tags_with_metadata` and calls `metrics.start_timer(name, &tags)`, returning the resulting `Timer`.

**Call relations**: This is used by callers that want scoped timing with explicit error handling rather than silent warning-based recording.

*Call graph*: calls 1 internal fn (tags_with_metadata); called by 2 (start_timer, start_timer).


##### `SessionTelemetry::shutdown_metrics`  (lines 303–308)

```
fn shutdown_metrics(&self) -> MetricsResult<()>
```

**Purpose**: Flushes and shuts down the attached metrics provider if one exists. If metrics are disabled, it succeeds without doing anything.

**Data flow**: Reads `self.metrics`; on `Some`, forwards to `metrics.shutdown()`, otherwise returns `Ok(())`.

**Call relations**: This is a teardown helper used when the session or process is ending and metrics should be flushed.


##### `SessionTelemetry::snapshot_metrics`  (lines 310–315)

```
fn snapshot_metrics(&self) -> MetricsResult<ResourceMetrics>
```

**Purpose**: Collects a runtime metrics snapshot from the attached metrics client. It requires a runtime reader to have been configured and returns an explicit error otherwise.

**Data flow**: Reads `self.metrics`; if absent, returns `MetricsError::ExporterDisabled`. Otherwise it calls `metrics.snapshot()` and returns the resulting `ResourceMetrics`.

**Call relations**: It underpins both runtime-summary generation and the reset-by-snapshot behavior.

*Call graph*: called by 2 (reset_runtime_metrics, runtime_metrics_summary).


##### `SessionTelemetry::reset_runtime_metrics`  (lines 318–325)

```
fn reset_runtime_metrics(&self)
```

**Purpose**: Collects and discards a runtime metrics snapshot solely to reset delta accumulators in the manual reader. It is a best-effort maintenance operation.

**Data flow**: Checks whether `self.metrics` is present; if not, returns immediately. Otherwise it calls `snapshot_metrics()`, ignores the snapshot, and logs a debug message if collection fails.

**Call relations**: This is used when the caller wants future runtime summaries to start from a fresh delta baseline.

*Call graph*: calls 1 internal fn (snapshot_metrics); 1 external calls (debug!).


##### `SessionTelemetry::runtime_metrics_summary`  (lines 328–341)

```
fn runtime_metrics_summary(&self) -> Option<RuntimeMetricsSummary>
```

**Purpose**: Builds a compact `RuntimeMetricsSummary` from the current runtime snapshot, returning `None` when snapshots are unavailable or contain no nonzero data. It converts raw OTEL metric data into session-level totals.

**Data flow**: Calls `snapshot_metrics()`, returning `None` on error. On success it passes the `ResourceMetrics` to `RuntimeMetricsSummary::from_snapshot`, then returns `Some(summary)` unless `summary.is_empty()` is true.

**Call relations**: This is the high-level read path for runtime metrics introspection and depends on the runtime-metrics summarizer in `metrics/runtime_metrics.rs`.

*Call graph*: calls 2 internal fn (snapshot_metrics, from_snapshot).


##### `SessionTelemetry::tags_with_metadata`  (lines 343–350)

```
fn tags_with_metadata(
        &'a self,
        tags: &'a [(&'a str, &'a str)],
    ) -> MetricsResult<Vec<(&'a str, &'a str)>>
```

**Purpose**: Merges caller-supplied metric tags with the session's standard metadata tags. It is the central place where per-session metric enrichment happens.

**Data flow**: Calls `metadata_tag_refs()` to obtain a `Vec` of borrowed metadata tags, extends that vector with the provided `tags` slice, and returns the merged vector or a validation error from metadata-tag generation.

**Call relations**: It is used by all metric-emitting helpers and by `start_timer` so they all share identical metadata-tag behavior.

*Call graph*: calls 1 internal fn (metadata_tag_refs); called by 1 (start_timer).


##### `SessionTelemetry::metadata_tag_refs`  (lines 352–365)

```
fn metadata_tag_refs(&self) -> MetricsResult<Vec<(&str, &str)>>
```

**Purpose**: Builds the standard metric-tag set derived from session metadata, or returns an empty set when metadata tagging is disabled. The tags include auth mode, session source, originator, service name, model, and app version.

**Data flow**: Reads `metrics_use_metadata_tags`; if false, returns an empty `Vec`. Otherwise it constructs `SessionMetricTagValues` from fields in `self.metadata` and calls `into_tags()` to validate and materialize the borrowed tag vector.

**Call relations**: This is an internal helper called only by `tags_with_metadata`, isolating the policy for which metadata becomes metric tags.

*Call graph*: called by 1 (tags_with_metadata); 1 external calls (new).


##### `SessionTelemetry::new`  (lines 368–399)

```
fn new(
        conversation_id: ThreadId,
        model: &str,
        slug: &str,
        account_id: Option<String>,
        account_email: Option<String>,
        auth_mode: Option<TelemetryAuthMo
```

**Purpose**: Constructs a new session telemetry object with core conversation metadata and any globally installed metrics client. It is the canonical entry point for creating session-scoped telemetry.

**Data flow**: Consumes conversation identifiers and session settings, converts optional `TelemetryAuthMode` and `SessionSource` to strings, sanitizes `originator`, initializes `auth_env` with `Default`, captures `env!("CARGO_PKG_VERSION")`, stores model/slug and prompt logging policy, reads `crate::metrics::global()` into `metrics`, enables metadata tags, and returns the assembled `SessionTelemetry`.

**Call relations**: This is called broadly by session setup and tests; later builder methods may refine the metadata or metrics attachment before event methods are used.

*Call graph*: calls 1 internal fn (global); called by 25 (test_session_telemetry, test_session_telemetry, new, session_telemetry, test_session_telemetry_without_metadata, test_session_telemetry, responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids (+15 more)); 4 external calls (to_string, sanitize_metric_tag_value, env!, default).


##### `SessionTelemetry::record_responses`  (lines 401–436)

```
fn record_responses(&self, handle_responses_span: &Span, event: &ResponseEvent)
```

**Purpose**: Annotates an existing tracing span with fields derived from a `ResponseEvent`, including event type, tool name for function-call items, and token usage on completion. It does not emit a new event; it enriches the current span.

**Data flow**: Reads the `ResponseEvent`, computes a string kind via `responses_type`, writes it into `handle_responses_span` under `otel.name`, then pattern-matches the event to optionally record `from`, `tool_name`, and several token-usage counters on the span.

**Call relations**: It is used while handling streamed Responses API events so the active tracing span reflects the specific event subtype and any available usage data.

*Call graph*: calls 1 internal fn (responses_type); 1 external calls (record).


##### `SessionTelemetry::conversation_starts`  (lines 439–475)

```
fn conversation_starts(
        &self,
        provider_name: &str,
        reasoning_effort: Option<ReasoningEffort>,
        reasoning_summary: ReasoningSummary,
        context_window: Option<i64>,
```

**Purpose**: Emits the session-start event describing provider choice, reasoning settings, context-window limits, approval/sandbox policy, and MCP server presence. It captures both auth-environment discovery and startup configuration in one structured record.

**Data flow**: Reads many fields from `self.metadata.auth_env` plus the function arguments, logs MCP server names only to the log target as a comma-joined string, records only the MCP server count to the trace target, and emits a combined `codex.conversation_starts` event.

**Call relations**: This is called near the beginning of a conversation after configuration has been resolved and before substantive request handling begins.

*Call graph*: 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::log_request`  (lines 477–508)

```
async fn log_request(&self, attempt: u64, f: F) -> Result<Response, Error>
```

**Purpose**: Wraps an async HTTP request future, measures its elapsed time, derives status/error information from the result, records API-request telemetry, and returns the original result unchanged. It is a convenience wrapper for instrumenting outbound requests.

**Data flow**: Captures `Instant::now()`, awaits the closure `f`, computes elapsed `Duration`, extracts `status` and optional error string from `Result<Response, reqwest::Error>`, calls `record_api_request` with default auth/recovery placeholders and endpoint `"unknown"`, then returns the original response result.

**Call relations**: It is used when callers want automatic timing and telemetry around a single request attempt without manually assembling all API-request fields.

*Call graph*: calls 1 internal fn (record_api_request); 1 external calls (now).


##### `SessionTelemetry::record_api_request`  (lines 511–571)

```
fn record_api_request(
        &self,
        attempt: u64,
        status: Option<u16>,
        error: Option<&str>,
        duration: Duration,
        auth_header_attached: bool,
        auth_heade
```

**Purpose**: Records a fully described API request attempt as both count/duration metrics and a structured event. It captures HTTP status, retry/auth-recovery context, endpoint identity, and auth-environment diagnostics.

**Data flow**: Computes `success` from 2xx status plus absence of an error string, converts status to a string tag or `"none"`, increments `API_CALL_COUNT_METRIC`, records `API_CALL_DURATION_METRIC`, and emits `codex.api_request` with duration, status, error, attempt number, auth-header/recovery fields, endpoint, auth-env booleans, request IDs, and auth error details.

**Call relations**: It is the detailed API telemetry sink used directly by request middleware and indirectly by `log_request`.

*Call graph*: calls 2 internal fn (counter, record_duration); called by 2 (on_request, log_request); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::record_websocket_connect`  (lines 574–625)

```
fn record_websocket_connect(
        &self,
        duration: Duration,
        status: Option<u16>,
        error: Option<&str>,
        auth_header_attached: bool,
        auth_header_name: Option<&
```

**Purpose**: Emits a structured event describing websocket connection establishment, including latency, HTTP status if available, auth/recovery context, and whether an existing connection was reused. Unlike request/event methods, it does not emit metrics here.

**Data flow**: Derives a success string from `error` and optional `status`, then emits `codex.websocket_connect` with duration, status, success, error, auth-header/recovery fields, endpoint, auth-env metadata, connection reuse, request IDs, and auth error details.

**Call relations**: It is called by websocket connection setup code after a connect attempt completes.

*Call graph*: called by 1 (connect_websocket); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::record_websocket_request`  (lines 627–662)

```
fn record_websocket_request(
        &self,
        duration: Duration,
        error: Option<&str>,
        connection_reused: bool,
    )
```

**Purpose**: Records a websocket request/roundtrip as both metrics and a structured event. It aggregates success/failure counts and durations separately from lower-level websocket event telemetry.

**Data flow**: Converts presence of `error` into a `success` tag, increments `WEBSOCKET_REQUEST_COUNT_METRIC`, records `WEBSOCKET_REQUEST_DURATION_METRIC`, and emits `codex.websocket_request` with duration, success, error, auth-env flags, and `connection_reused`.

**Call relations**: It is invoked by websocket request handling code after a request over an established websocket completes.

*Call graph*: calls 2 internal fn (counter, record_duration); called by 1 (on_ws_request); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::record_auth_recovery`  (lines 665–694)

```
fn record_auth_recovery(
        &self,
        mode: &str,
        step: &str,
        outcome: &str,
        request_id: Option<&str>,
        cf_ray: Option<&str>,
        auth_error: Option<&str>,
```

**Purpose**: Emits a structured event for auth-recovery workflows such as retries, token refreshes, or fallback steps. It captures the recovery mode, step, outcome, and any server-provided auth diagnostics.

**Data flow**: Reads the supplied mode/step/outcome and optional request IDs, Cloudflare ray, auth error/code, recovery reason, and state-change flag, then emits a combined `codex.auth_recovery` log/trace event.

**Call relations**: It is called from unauthorized-handling logic to make auth remediation visible in telemetry.

*Call graph*: called by 1 (handle_unauthorized); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::record_websocket_event`  (lines 696–790)

```
fn record_websocket_event(
        &self,
        result: &Result<
            Option<
                Result<
                    tokio_tungstenite::tungstenite::Message,
                    tokio_tu
```

**Purpose**: Classifies a single websocket receive result, records success/failure metrics and duration, and emits a structured event. It also parses special timing payloads from Responses API websocket messages into dedicated latency metrics.

**Data flow**: Pattern-matches the nested `Result<Option<Result<Message, tungstenite::Error>>, ApiError>`. For text messages it attempts JSON parsing, extracts the `type` field as `kind`, records timing metrics when the kind is `responsesapi.websocket_timing`, and treats `response.failed` as unsuccessful with an extracted error payload. Binary, close, frame, parse errors, stream closure, tungstenite errors, and API errors all become failed events with synthesized error messages; ping/pong return early without metrics. It then emits `WEBSOCKET_EVENT_COUNT_METRIC`, `WEBSOCKET_EVENT_DURATION_METRIC`, and a `codex.websocket_event` log/trace event.

**Call relations**: This is the per-message telemetry sink used by websocket event loops; it delegates timing-payload extraction to `record_responses_websocket_timing_metrics`.

*Call graph*: calls 3 internal fn (counter, record_duration, record_responses_websocket_timing_metrics); called by 1 (on_ws_event); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::log_sse_event`  (lines 792–841)

```
fn log_sse_event(
        &self,
        response: &Result<Option<Result<StreamEvent, StreamError<E>>>, Elapsed>,
        duration: Duration,
    )
```

**Purpose**: Interprets the result of polling an SSE stream and routes it to success or failure telemetry paths. It validates certain event payloads more deeply than others, especially `response.failed` and `response.output_item.done`.

**Data flow**: Reads `Result<Option<Result<StreamEvent, StreamError<E>>>, Elapsed>`. For successful SSE events, `[DONE]` is treated as a normal event; otherwise it parses `sse.data` as JSON. `response.failed` payloads are sent to `sse_event_failed`; `response.output_item.done` is additionally deserialized into `ResponseItem` and treated as failed if that parse fails; other valid JSON events go to `sse_event`. Stream errors and idle timeouts go to `sse_event_failed`; `Ok(None)` produces no telemetry.

**Call relations**: It is called by SSE polling code and delegates the actual metric/event emission to `sse_event` and `sse_event_failed`.

*Call graph*: calls 2 internal fn (sse_event, sse_event_failed); called by 1 (on_sse_poll).


##### `SessionTelemetry::sse_event`  (lines 843–860)

```
fn sse_event(&self, kind: &str, duration: Duration)
```

**Purpose**: Records a successful SSE event kind as both metrics and a log event. It is the happy-path sink for parsed SSE messages.

**Data flow**: Increments `SSE_EVENT_COUNT_METRIC` with `kind` and `success=true`, records `SSE_EVENT_DURATION_METRIC` with the same tags, and emits a log-only `codex.sse_event` containing the kind and duration in milliseconds.

**Call relations**: It is called only from `log_sse_event` after the SSE payload has been accepted as valid.

*Call graph*: calls 2 internal fn (counter, record_duration); called by 1 (log_sse_event); 1 external calls (log_event!).


##### `SessionTelemetry::sse_event_failed`  (lines 862–899)

```
fn sse_event_failed(&self, kind: Option<&String>, duration: Duration, error: &T)
```

**Purpose**: Records a failed SSE event or polling failure as metrics plus both log and trace events. It preserves the event kind when known and falls back to `unknown` otherwise.

**Data flow**: Maps `Option<&String>` to a `kind_str`, increments `SSE_EVENT_COUNT_METRIC` and records `SSE_EVENT_DURATION_METRIC` with `success=false`, emits a log event that conditionally includes `event.kind`, and always emits a trace event with kind, duration, and formatted error message.

**Call relations**: It is the failure sink used by `log_sse_event` for malformed payloads, stream errors, and idle timeouts.

*Call graph*: calls 2 internal fn (counter, record_duration); called by 1 (log_sse_event); 2 external calls (log_event!, trace_event!).


##### `SessionTelemetry::see_event_completed_failed`  (lines 901–915)

```
fn see_event_completed_failed(&self, error: &T)
```

**Purpose**: Emits a telemetry event indicating that processing of the terminal `response.completed` SSE event failed. Despite the method name typo, it specifically reports completion-event failure.

**Data flow**: Formats the supplied displayable `error` into a combined log/trace event named `codex.sse_event` with `event.kind = "response.completed"` and `error.message`.

**Call relations**: It is called from response-event mapping logic when completion parsing or handling fails after the stream reaches the completed event.

*Call graph*: called by 1 (map_response_events); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::sse_event_completed`  (lines 917–939)

```
fn sse_event_completed(
        &self,
        input_token_count: i64,
        output_token_count: i64,
        cached_token_count: Option<i64>,
        reasoning_token_count: Option<i64>,
        too
```

**Purpose**: Emits the parsed token-usage details from a successful `response.completed` SSE event. It records counts for input, output, cached, reasoning, and tool tokens.

**Data flow**: Takes concrete token counts and optional cached/reasoning counts and emits a combined `codex.sse_event` log/trace event with `event.kind = "response.completed"` and the token fields.

**Call relations**: It is called by response-event mapping code after a completion event has been successfully parsed.

*Call graph*: called by 1 (map_response_events); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::user_prompt`  (lines 941–982)

```
fn user_prompt(&self, items: &[UserInput])
```

**Purpose**: Logs user input telemetry for a turn, including prompt length and modality counts, while optionally redacting the actual prompt text. It separates privacy-sensitive logging from trace-safe aggregate counts.

**Data flow**: Iterates over `items: &[UserInput]`, concatenates all `UserInput::Text` contents into one `String`, counts text/image/local-image items, chooses either the real prompt or `"[REDACTED]"` based on `self.metadata.log_user_prompts`, logs `codex.user_prompt` with prompt length and chosen prompt text, and traces the same event with prompt length plus modality counts but no raw prompt.

**Call relations**: It is emitted when a user turn is submitted so downstream observability can correlate prompt size and modality mix without always exposing content.

*Call graph*: 3 external calls (iter, log_event!, trace_event!).


##### `SessionTelemetry::tool_decision`  (lines 984–999)

```
fn tool_decision(
        &self,
        tool_name: &str,
        call_id: &str,
        decision: &ReviewDecision,
        source: ToolDecisionSource,
    )
```

**Purpose**: Logs the approval or review decision made for a tool call, including whether it came from the user, config, or automated reviewer. It records the decision as a lowercased string.

**Data flow**: Reads `tool_name`, `call_id`, `ReviewDecision`, and `ToolDecisionSource`, converts the decision to lowercase text and the source to string, and emits a log-only `codex.tool_decision` event.

**Call relations**: It is called from approval-request flows when a tool invocation is accepted, rejected, or otherwise decided.

*Call graph*: called by 1 (request_approval); 1 external calls (log_event!).


##### `SessionTelemetry::sandbox_outcome`  (lines 1001–1030)

```
fn sandbox_outcome(
        &self,
        tool_name: &str,
        call_id: &str,
        outcome: &str,
        initial_duration: Duration,
        escalated_duration: Option<Duration>,
    )
```

**Purpose**: Logs the outcome of sandboxed tool execution, including initial and optional escalated durations. It clamps duration conversions to `i64` milliseconds for trace/log field compatibility.

**Data flow**: Converts `initial_duration` and optional `escalated_duration` to bounded `i64` millisecond values, then emits both log and trace `codex.sandbox_outcome` events with tool name, call ID, outcome, and the duration fields.

**Call relations**: It is used after sandbox execution completes, especially when an escalation path may have added a second timing component.

*Call graph*: 3 external calls (as_millis, log_event!, trace_event!).


##### `SessionTelemetry::log_tool_result_with_tags`  (lines 1033–1068)

```
async fn log_tool_result_with_tags(
        &self,
        tool_name: &str,
        call_id: &str,
        arguments: &str,
        extra_tags: &[(&str, &str)],
        extra_trace_fields: &[(&str, &s
```

**Purpose**: Wraps an async tool execution, measures elapsed time, derives a preview/error string and success flag, emits tool-result telemetry with caller-supplied tags and trace fields, and returns the original result. It is the async convenience wrapper around `tool_result_with_tags`.

**Data flow**: Captures `Instant::now()`, awaits the closure `f`, computes elapsed duration, maps `Ok((preview, success))` to a borrowed output string and `Err(error)` to an owned error string with `success=false`, calls `tool_result_with_tags(...)`, and finally returns the original `Result<(String, bool), E>` unchanged.

**Call relations**: Callers use this when they want timing and telemetry around a tool invocation without manually measuring duration or formatting failure output.

*Call graph*: calls 1 internal fn (tool_result_with_tags); 3 external calls (Borrowed, Owned, now).


##### `SessionTelemetry::log_tool_failed`  (lines 1070–1092)

```
fn log_tool_failed(&self, tool_name: &str, error: &str)
```

**Purpose**: Emits an immediate failed tool-result event without timing or call ID context, intended for failures that occur before normal tool execution telemetry can be produced. It marks the tool as builtin and records output/error length in the trace.

**Data flow**: Uses `Duration::ZERO` as the duration, logs `codex.tool_result` with `success=false`, the error string as `output`, and empty MCP fields, then traces the same event with output length, line count, builtin origin, and `error.message`.

**Call relations**: This is a fallback path for early tool failures when the richer `tool_result_with_tags` flow is not available.

*Call graph*: 2 external calls (log_event!, trace_event!).


##### `SessionTelemetry::tool_result_with_tags`  (lines 1095–1141)

```
fn tool_result_with_tags(
        &self,
        tool_name: &str,
        call_id: &str,
        arguments: &str,
        duration: Duration,
        success: bool,
        output: &str,
        extra
```

**Purpose**: Records the result of a tool call as metrics plus structured log/trace events, incorporating extra metric tags and extra trace fields. It distinguishes builtin tools from MCP-backed tools by inspecting supplied trace fields.

**Data flow**: Builds a tag vector containing `tool`, `success`, and any `extra_tags`, increments `TOOL_CALL_COUNT_METRIC`, records `TOOL_CALL_DURATION_METRIC`, extracts `mcp_server` and `mcp_server_origin` from `extra_trace_fields` via `trace_field_value`, logs `codex.tool_result` with arguments and output text, and traces aggregate-safe fields such as argument/output lengths, line count, tool origin, and whether it is an MCP tool.

**Call relations**: It is the concrete sink used by `log_tool_result_with_tags` after async execution completes.

*Call graph*: calls 3 internal fn (counter, record_duration, trace_field_value); called by 1 (log_tool_result_with_tags); 3 external calls (with_capacity, log_event!, trace_event!).


##### `SessionTelemetry::record_responses_websocket_timing_metrics`  (lines 1143–1193)

```
fn record_responses_websocket_timing_metrics(&self, value: &serde_json::Value)
```

**Purpose**: Extracts Responses API timing breakdown fields from a websocket JSON payload and records each present duration into its dedicated metric. It ignores missing, malformed, negative, or non-finite values.

**Data flow**: Reads `value["timing_metrics"]`, then individually looks up overhead, inference, engine IAPI TTFT, engine service TTFT, engine IAPI TBT, and engine service TBT fields. Each field is converted with `duration_from_ms_value`; successful conversions are forwarded to `record_duration` with the corresponding metric name and no extra tags.

**Call relations**: It is called only from `record_websocket_event` when a websocket message's `type` is `responsesapi.websocket_timing`.

*Call graph*: calls 2 internal fn (record_duration, duration_from_ms_value); called by 1 (record_websocket_event); 1 external calls (get).


##### `SessionTelemetry::responses_type`  (lines 1195–1216)

```
fn responses_type(event: &ResponseEvent) -> String
```

**Purpose**: Maps a `ResponseEvent` enum variant to a stable string label suitable for tracing span annotation. For item-carrying variants it delegates to item-type classification.

**Data flow**: Pattern-matches the `ResponseEvent` and returns an owned `String` such as `created`, `completed`, `text_delta`, or an item-derived label from `responses_item_type`.

**Call relations**: It is used by `record_responses` to populate the span's `otel.name` field.

*Call graph*: calls 1 internal fn (responses_item_type); called by 1 (record_responses).


##### `SessionTelemetry::responses_item_type`  (lines 1218–1237)

```
fn responses_item_type(item: &ResponseItem) -> String
```

**Purpose**: Maps a `ResponseItem` variant to a stable string label, including role-specific labels for message items. This normalizes heterogeneous response items into telemetry-friendly names.

**Data flow**: Pattern-matches the `ResponseItem` and returns an owned `String`; `Message { role, .. }` becomes `message_from_<role>`, while all other variants map to fixed strings like `function_call`, `tool_search_output`, or `other`.

**Call relations**: It is called by `responses_type` whenever a response event wraps a `ResponseItem`.

*Call graph*: called by 1 (responses_type); 1 external calls (format!).


##### `duration_from_ms_value`  (lines 1240–1251)

```
fn duration_from_ms_value(value: Option<&serde_json::Value>) -> Option<Duration>
```

**Purpose**: Converts a JSON numeric value interpreted as milliseconds into a `Duration`, rejecting invalid numbers. It accepts floating-point, signed integer, and unsigned integer JSON representations.

**Data flow**: Reads an optional `serde_json::Value`, extracts it as `f64` via `as_f64`/`as_i64`/`as_u64`, returns `None` for missing, non-finite, or negative values, clamps large values to `u64::MAX`, rounds to the nearest millisecond, and returns `Some(Duration::from_millis(...))`.

**Call relations**: It is the numeric parsing helper used by `record_responses_websocket_timing_metrics` for each timing field.

*Call graph*: called by 1 (record_responses_websocket_timing_metrics); 1 external calls (from_millis).


### `core/src/turn_timing.rs`

`domain_logic` · `throughout a turn; updated at turn start, during streaming, around sampling/tool execution, and at completion`

This module maintains two related timing models for a turn. `TurnTimingStateInner`, protected by an async `tokio::sync::Mutex`, records coarse milestones: when the turn started, the Unix start timestamp, when the first token arrived, and when the first assistant message item arrived. `TurnProfileState`, protected by a standard mutex, accumulates a richer phase profile for analytics: time before first sampling, active sampling time, overhead between sampling requests, tool-blocking time, idle time after the last sampling phase, counts of sampling requests and retries, and an optional cached completed `TurnProfile`.

The public helpers `record_turn_ttft_metric` and `record_turn_ttfm_metric` are adapters from streaming events into telemetry. They ask the turn's timing state to record TTFT or TTFM only once, then emit the resulting duration through session telemetry. Event classification is explicit: text deltas, reasoning deltas, non-empty assistant messages, reasoning items with non-empty text, and tool-call items count toward TTFT; agent messages and output items like function-call outputs do not.

Phase profiling uses RAII guards. `begin_sampling` and `begin_tool_blocking` attempt to enter a phase and return `TurnProfileTimingGuard`; on drop, an active guard ends its phase automatically. `TurnProfileState::advance` attributes elapsed time since the last transition to the currently active phase or to pre/post-sampling idle buckets. `complete` finalizes the profile once, computes total elapsed time from `started_at`, and assigns any rounding remainder back into the final active or idle bucket so the classified durations sum to the total. The design prevents overlapping phases, ignores retries after completion, and tolerates clock anomalies via saturating duration arithmetic.

#### Function details

##### `record_turn_ttft_metric`  (lines 18–27)

```
async fn record_turn_ttft_metric(turn_context: &TurnContext, event: &ResponseEvent)
```

**Purpose**: Records and emits the turn's time-to-first-token metric when a response event qualifies as the first token-bearing output.

**Data flow**: Reads `turn_context.turn_timing_state`, awaits `record_ttft_for_response_event(event)`, and if it returns `Some(duration)` forwards that duration to `turn_context.session_telemetry.record_turn_ttft(duration)`. Otherwise it returns without emitting anything.

**Call relations**: Called by `try_run_sampling_request` as streaming response events arrive.

*Call graph*: called by 1 (try_run_sampling_request).


##### `record_turn_ttfm_metric`  (lines 29–40)

```
async fn record_turn_ttfm_metric(turn_context: &TurnContext, item: &TurnItem)
```

**Purpose**: Records and emits the turn's time-to-first-message metric when the first `TurnItem::AgentMessage` is completed.

**Data flow**: Awaits `turn_context.turn_timing_state.record_ttfm_for_turn_item(item)`, and if a duration is returned, emits it through `session_telemetry.record_duration(TURN_TTFM_DURATION_METRIC, duration, &[])`.

**Call relations**: Called by `emit_turn_item_completed` when turn items are finalized.

*Call graph*: called by 1 (emit_turn_item_completed).


##### `TurnTimingState::mark_turn_started`  (lines 86–95)

```
async fn mark_turn_started(&self, started_at: Instant) -> i64
```

**Purpose**: Initializes timing state for a new turn, resetting first-token/message markers and starting a fresh profile timeline.

**Data flow**: Computes `started_at_unix_ms` via `now_unix_timestamp_ms()`, locks the async state, stores `started_at`, stores Unix seconds as `started_at_unix_ms / 1000`, clears `first_token_at` and `first_message_at`, then resets the profile state with `start(started_at)`. It returns the Unix-millisecond timestamp.

**Call relations**: Called when a turn begins so later TTFT/TTFM and profile measurements have a baseline.

*Call graph*: calls 2 internal fn (profile_state, now_unix_timestamp_ms).


##### `TurnTimingState::started_at_unix_secs`  (lines 97–99)

```
async fn started_at_unix_secs(&self) -> Option<i64>
```

**Purpose**: Returns the stored Unix-seconds start timestamp for the current turn, if one has been recorded.

**Data flow**: Locks the async state and returns `started_at_unix_secs`.

**Call relations**: Used by callers that need the coarse wall-clock start time.


##### `TurnTimingState::completed_at_and_duration_ms`  (lines 101–108)

```
async fn completed_at_and_duration_ms(&self) -> (Option<i64>, Option<i64>)
```

**Purpose**: Returns the current completion wall-clock time and elapsed duration since turn start in milliseconds.

**Data flow**: Locks the async state, computes `completed_at` from `now_unix_timestamp_secs()`, derives `duration_ms` from `started_at.elapsed().as_millis()` if a start exists, saturating to `i64::MAX` on conversion overflow, and returns the pair `(Some(completed_at), Option<duration_ms>)`.

**Call relations**: Used when finalizing turn analytics or metadata at completion.

*Call graph*: calls 1 internal fn (now_unix_timestamp_secs).


##### `TurnTimingState::time_to_first_token_ms`  (lines 110–115)

```
async fn time_to_first_token_ms(&self) -> Option<i64>
```

**Purpose**: Returns the already-recorded time to first token in milliseconds, if TTFT has been observed.

**Data flow**: Locks the async state, calls `state.time_to_first_token()`, converts the resulting `Duration` to `i64` milliseconds with saturation, and returns it as `Option<i64>`.

**Call relations**: Provides a read-only accessor after TTFT has been recorded.


##### `TurnTimingState::complete_profile`  (lines 117–119)

```
fn complete_profile(&self) -> TurnProfile
```

**Purpose**: Finalizes and returns the turn's classified `TurnProfile`, caching the result so repeated calls are stable.

**Data flow**: Locks the profile mutex via `profile_state()`, calls `complete(Instant::now())`, and returns the resulting `TurnProfile`.

**Call relations**: Used at turn completion to emit or persist the phase breakdown.

*Call graph*: calls 1 internal fn (profile_state); 1 external calls (now).


##### `TurnTimingState::begin_sampling`  (lines 121–128)

```
fn begin_sampling(self: &Arc<Self>) -> TurnProfileTimingGuard
```

**Purpose**: Attempts to enter the sampling phase and returns an RAII guard that will end the phase on drop if activation succeeded.

**Data flow**: Locks the profile state, calls `begin_sampling(Instant::now())` to determine whether the phase can start, then returns `TurnProfileTimingGuard { timing: Arc::clone(self), phase: Sampling, active }`.

**Call relations**: Used around model sampling requests so elapsed time is attributed to sampling until the guard is dropped.

*Call graph*: calls 1 internal fn (profile_state); 2 external calls (clone, now).


##### `TurnTimingState::record_sampling_retry`  (lines 130–132)

```
fn record_sampling_retry(&self)
```

**Purpose**: Increments the sampling-retry counter for the current profile when retries occur before completion.

**Data flow**: Locks the profile state and calls `record_sampling_retry()`.

**Call relations**: Used by retry logic to annotate the eventual `TurnProfile`.

*Call graph*: calls 1 internal fn (profile_state).


##### `TurnTimingState::begin_tool_blocking`  (lines 134–141)

```
fn begin_tool_blocking(self: &Arc<Self>) -> TurnProfileTimingGuard
```

**Purpose**: Attempts to enter the tool-blocking phase and returns an RAII guard that ends the phase on drop if activation succeeded.

**Data flow**: Locks the profile state, calls `begin_tool_blocking(Instant::now())`, and returns `TurnProfileTimingGuard { timing: Arc::clone(self), phase: ToolBlocking, active }`.

**Call relations**: Used around synchronous tool waits so that blocked time is separated from sampling and idle overhead.

*Call graph*: calls 1 internal fn (profile_state); 2 external calls (clone, now).


##### `TurnTimingState::record_ttft_for_response_event`  (lines 143–152)

```
async fn record_ttft_for_response_event(
        &self,
        event: &ResponseEvent,
    ) -> Option<Duration>
```

**Purpose**: Records TTFT exactly once when a response event is classified as token-bearing.

**Data flow**: Checks `response_event_records_turn_ttft(event)`; if false returns `None`. Otherwise it locks the async state and calls `state.record_turn_ttft()`, returning the resulting `Option<Duration>`.

**Call relations**: Called by `record_turn_ttft_metric`; event classification is delegated to `response_event_records_turn_ttft`.

*Call graph*: calls 1 internal fn (response_event_records_turn_ttft).


##### `TurnTimingState::record_ttfm_for_turn_item`  (lines 154–160)

```
async fn record_ttfm_for_turn_item(&self, item: &TurnItem) -> Option<Duration>
```

**Purpose**: Records TTFM exactly once when the first completed turn item is an `AgentMessage`.

**Data flow**: Returns `None` unless `item` matches `TurnItem::AgentMessage(_)`. For agent messages it locks the async state and calls `state.record_turn_ttfm()`, returning the resulting duration if this is the first message.

**Call relations**: Called by `record_turn_ttfm_metric` during turn-item completion.

*Call graph*: 1 external calls (matches!).


##### `TurnTimingState::profile_state`  (lines 162–166)

```
fn profile_state(&self) -> std::sync::MutexGuard<'_, TurnProfileState>
```

**Purpose**: Obtains the synchronous mutex guard for the profile state, recovering from poisoning by taking the inner value.

**Data flow**: Locks `self.profile` and on poison uses `PoisonError::into_inner` to return the guard anyway.

**Call relations**: Internal helper used by profile-related methods such as start, begin/end phase, retry recording, and completion.

*Call graph*: called by 5 (begin_sampling, begin_tool_blocking, complete_profile, mark_turn_started, record_sampling_retry); 1 external calls (lock).


##### `TurnProfileTimingGuard::drop`  (lines 170–176)

```
fn drop(&mut self)
```

**Purpose**: Automatically ends the associated profile phase when the guard goes out of scope, but only if phase entry actually succeeded.

**Data flow**: Checks `self.active`; if true, locks the timing state's profile and calls `end_phase(Instant::now(), self.phase)`. It returns no value.

**Call relations**: Completes the RAII pattern started by `begin_sampling` and `begin_tool_blocking`.

*Call graph*: 1 external calls (now).


##### `now_unix_timestamp_secs`  (lines 179–181)

```
fn now_unix_timestamp_secs() -> i64
```

**Purpose**: Returns the current Unix timestamp in whole seconds.

**Data flow**: Calls `now_unix_timestamp_ms()` and divides the result by 1000.

**Call relations**: Used by `completed_at_and_duration_ms` for completion wall-clock time.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (completed_at_and_duration_ms).


##### `now_unix_timestamp_ms`  (lines 183–188)

```
fn now_unix_timestamp_ms() -> i64
```

**Purpose**: Returns the current Unix timestamp in milliseconds, saturating to zero/default on clock errors and `i64::MAX` on conversion overflow.

**Data flow**: Reads `SystemTime::now()`, computes duration since `UNIX_EPOCH` with `unwrap_or_default()`, converts `as_millis()` to `i64` with `try_from`, and returns the result or `i64::MAX` on overflow.

**Call relations**: Used widely across the system for timestamping; within this file it initializes turn start time and supports completion timestamps.

*Call graph*: called by 22 (stamp_ws_stream_request_start_ms, run_guardian_review, emit_turn_item_completed, emit_turn_item_started, request_command_approval, request_patch_approval, request_permissions_for_environment, execute_user_shell_command, emit_exec_command_begin, emit_exec_end (+12 more)); 2 external calls (now, try_from).


##### `duration_to_u64_ms`  (lines 190–192)

```
fn duration_to_u64_ms(duration: Duration) -> u64
```

**Purpose**: Converts a `Duration` to milliseconds as `u64`, saturating on overflow.

**Data flow**: Reads `duration.as_millis()`, converts it with `u64::try_from`, and returns the result or `u64::MAX`.

**Call relations**: Used when finalizing `TurnProfile` fields in `TurnProfileState::complete`.

*Call graph*: called by 1 (complete); 2 external calls (as_millis, try_from).


##### `TurnProfileState::start`  (lines 195–201)

```
fn start(&mut self, started_at: Instant)
```

**Purpose**: Resets the profile state for a new turn starting at the given instant.

**Data flow**: Replaces `self` with a new `TurnProfileState` whose `started_at` and `last_transition_at` are `Some(started_at)` and whose remaining fields come from `Default::default()`.

**Call relations**: Called by `TurnTimingState::mark_turn_started`.

*Call graph*: 1 external calls (default).


##### `TurnProfileState::begin_sampling`  (lines 203–218)

```
fn begin_sampling(&mut self, now: Instant) -> bool
```

**Purpose**: Starts a sampling phase if profiling is active, not completed, and no other phase is currently active.

**Data flow**: Returns `false` if a completed profile exists, no start time exists, or another phase is active. Otherwise it calls `advance(now)`, moves any pending idle-after-sampling time into `between_sampling_overhead` if sampling has been seen before, marks `seen_sampling = true`, sets `active_phase = Some(Sampling)`, increments `sampling_request_count` with saturation, and returns `true`.

**Call relations**: Called by `TurnTimingState::begin_sampling` before constructing the guard.

*Call graph*: calls 1 internal fn (advance); 1 external calls (take).


##### `TurnProfileState::record_sampling_retry`  (lines 220–224)

```
fn record_sampling_retry(&mut self)
```

**Purpose**: Increments the retry counter for sampling attempts as long as profiling has started and not yet completed.

**Data flow**: Checks that `completed_profile` is `None` and `started_at` is `Some`, then increments `sampling_retry_count` with saturation.

**Call relations**: Called by `TurnTimingState::record_sampling_retry`.


##### `TurnProfileState::begin_tool_blocking`  (lines 226–236)

```
fn begin_tool_blocking(&mut self, now: Instant) -> bool
```

**Purpose**: Starts a tool-blocking phase if profiling is active, not completed, and no other phase is currently active.

**Data flow**: Returns `false` if completed, not started, or already in another phase. Otherwise it calls `advance(now)`, sets `active_phase = Some(ToolBlocking)`, and returns `true`.

**Call relations**: Called by `TurnTimingState::begin_tool_blocking`.

*Call graph*: calls 1 internal fn (advance).


##### `TurnProfileState::end_phase`  (lines 238–244)

```
fn end_phase(&mut self, now: Instant, phase: TurnProfilePhase)
```

**Purpose**: Ends the currently active phase if it matches the expected phase and profiling has not already completed.

**Data flow**: Checks that `completed_profile` is `None` and `active_phase == Some(phase)`; if so it calls `advance(now)` and then clears `active_phase`.

**Call relations**: Invoked from `TurnProfileTimingGuard::drop` to close sampling or tool-blocking intervals.

*Call graph*: calls 1 internal fn (advance).


##### `TurnProfileState::advance`  (lines 246–257)

```
fn advance(&mut self, now: Instant)
```

**Purpose**: Attributes elapsed time since the last transition to the appropriate bucket based on the current active phase and whether sampling has begun before.

**Data flow**: Replaces `last_transition_at` with `now`; if there was no previous timestamp it returns. Otherwise it computes `elapsed = now.saturating_duration_since(previous)` and adds it to `sampling`, `tool_blocking`, `pending_idle_after_sampling`, or `before_first_sampling` depending on `active_phase` and `seen_sampling`.

**Call relations**: Internal accounting primitive used by phase transitions and completion.

*Call graph*: called by 4 (begin_sampling, begin_tool_blocking, complete, end_phase); 1 external calls (saturating_duration_since).


##### `TurnProfileState::complete`  (lines 259–302)

```
fn complete(&mut self, now: Instant) -> TurnProfile
```

**Purpose**: Finalizes the classified turn profile once, ensuring all elapsed time is accounted for and caching the result for future calls.

**Data flow**: If `completed_profile` already exists, it clones and returns it. Otherwise it remembers `final_phase`, calls `advance(now)`, drains `pending_idle_after_sampling` into `after_last_sampling` if sampling occurred, constructs a `TurnProfile` from all duration buckets and counters using `duration_to_u64_ms`, computes total elapsed time from `started_at`, calculates any rounding remainder between total and classified milliseconds, adds that remainder back into the bucket corresponding to `final_phase` or idle state, clears `active_phase`, stores a clone in `completed_profile`, and returns it.

**Call relations**: Called by `TurnTimingState::complete_profile`; it is the terminal aggregation step for phase analytics.

*Call graph*: calls 2 internal fn (advance, duration_to_u64_ms); 1 external calls (take).


##### `TurnTimingStateInner::time_to_first_token`  (lines 306–308)

```
fn time_to_first_token(&self) -> Option<Duration>
```

**Purpose**: Computes the elapsed duration from turn start to the recorded first-token instant, if both timestamps exist.

**Data flow**: Uses `self.first_token_at?` and `self.started_at?` to compute `first_token_at.duration_since(started_at)` and returns it as `Option<Duration>`.

**Call relations**: Used by `record_turn_ttft` and indirectly by the public TTFT accessor.

*Call graph*: called by 1 (record_turn_ttft).


##### `TurnTimingStateInner::record_turn_ttft`  (lines 310–317)

```
fn record_turn_ttft(&mut self) -> Option<Duration>
```

**Purpose**: Records the first-token timestamp exactly once and returns the resulting TTFT duration.

**Data flow**: Returns `None` if `first_token_at` is already set or `started_at` is absent. Otherwise it stores `Instant::now()` into `first_token_at` and returns `self.time_to_first_token()`.

**Call relations**: Called by `TurnTimingState::record_ttft_for_response_event` after event classification passes.

*Call graph*: calls 1 internal fn (time_to_first_token); 1 external calls (now).


##### `TurnTimingStateInner::record_turn_ttfm`  (lines 319–327)

```
fn record_turn_ttfm(&mut self) -> Option<Duration>
```

**Purpose**: Records the first-message timestamp exactly once and returns the elapsed duration since turn start.

**Data flow**: Returns `None` if `first_message_at` is already set or `started_at` is absent. Otherwise it captures `Instant::now()`, stores it in `first_message_at`, computes `duration_since(started_at)`, and returns that duration.

**Call relations**: Called by `TurnTimingState::record_ttfm_for_turn_item` for the first agent message.

*Call graph*: 1 external calls (now).


##### `response_event_records_turn_ttft`  (lines 330–349)

```
fn response_event_records_turn_ttft(event: &ResponseEvent) -> bool
```

**Purpose**: Classifies whether a streaming `ResponseEvent` should count as the first token-bearing output for TTFT purposes.

**Data flow**: Pattern-matches the event: output-item events delegate to `response_item_records_turn_ttft`, text and reasoning deltas return `true`, and lifecycle/control events such as `Created`, `Completed`, moderation metadata, tool-call input deltas, rate limits, and model metadata return `false`.

**Call relations**: Used by `TurnTimingState::record_ttft_for_response_event` to gate TTFT recording.

*Call graph*: calls 1 internal fn (response_item_records_turn_ttft); called by 1 (record_ttft_for_response_event).


##### `response_item_records_turn_ttft`  (lines 351–387)

```
fn response_item_records_turn_ttft(item: &ResponseItem) -> bool
```

**Purpose**: Classifies whether a `ResponseItem` contains user-visible output that should count as TTFT.

**Data flow**: For `Message`, it extracts raw assistant text with `raw_assistant_output_text_from_item` and requires non-empty text. For `Reasoning`, it checks summary/content entries for non-empty text. `AgentMessage` returns false. Tool-call and shell-call items return true because they are visible output. Output items like `FunctionCallOutput`, `ToolSearchOutput`, and `Other` return false.

**Call relations**: Called by `response_event_records_turn_ttft` when TTFT classification depends on a completed or added response item.

*Call graph*: calls 1 internal fn (raw_assistant_output_text_from_item); called by 1 (response_event_records_turn_ttft).


### Request and tool tracing
These files attach telemetry to request handling and tool execution paths, including app-server spans, sandbox characterization, and rollout trace emission.

### `app-server/src/app_server_tracing.rs`

`util` · `per-request tracing during request processing`

This file centralizes how request spans are created so telemetry is consistent across stdio, websocket, Unix-socket, and in-process callers. `request_span` handles parsed `JSONRPCRequest` values from transport-based JSON-RPC, while `typed_request_span` mirrors the same shape for typed `ClientRequest` values used by the in-process path. Both functions create spans through `app_server_request_span_template`, which stamps stable OpenTelemetry and RPC fields such as `otel.kind=server`, `rpc.system=jsonrpc`, `rpc.method`, `rpc.transport`, `rpc.request_id`, `app_server.connection_id`, and placeholders for client name/version and turn ID.

Client identity is derived carefully. For initialize requests, `initialize_client_info` or `initialize_client_info_from_typed_request` extracts `InitializeParams.client_info`; otherwise the code falls back to `ConnectionSessionState` via `client_name` and `client_version`. `record_client_info` writes only present values into the span. Parent tracing context is attached by `attach_parent_context`: if the inbound JSON-RPC request carries a W3C trace carrier, it attempts to set that as the parent and warns if invalid; otherwise it falls back to any ambient `traceparent` context from the environment. This preserves distributed tracing continuity for both external and embedded callers while keeping span field names identical across transports.

#### Function details

##### `request_span`  (lines 24–55)

```
fn request_span(
    request: &JSONRPCRequest,
    transport: &AppServerTransport,
    connection_id: ConnectionId,
    session: &ConnectionSessionState,
) -> Span
```

**Purpose**: Builds the tracing span for a transport-delivered JSON-RPC request, including transport name, request ID, client identity, and optional inbound trace context.

**Data flow**: Takes a `JSONRPCRequest`, `AppServerTransport`, `ConnectionId`, and `ConnectionSessionState`; extracts optional initialize params with `initialize_client_info`, derives the method string, creates a span via `app_server_request_span_template`, records client name/version using initialize params or session fallbacks, constructs an optional `W3cTraceContext` from `request.trace`, attaches parent context with `attach_parent_context`, and returns the configured `Span`.

**Call relations**: Called by request-processing code for JSON-RPC transports. It delegates transport labeling, client-info extraction, and parent-context handling to helpers in this file.

*Call graph*: calls 7 internal fn (app_server_request_span_template, attach_parent_context, client_name, client_version, initialize_client_info, record_client_info, transport_name); called by 1 (process_request).


##### `typed_request_span`  (lines 62–83)

```
fn typed_request_span(
    request: &ClientRequest,
    connection_id: ConnectionId,
    session: &ConnectionSessionState,
) -> Span
```

**Purpose**: Builds the tracing span for an in-process typed `ClientRequest`, mirroring the JSON-RPC span shape while stamping transport as `in-process`.

**Data flow**: Takes a typed request, connection ID, and session state; reads `request.method()` and `request.id()`, creates a span with `app_server_request_span_template(..., "in-process", ...)`, extracts optional initialize client info from the typed request, records client name/version using that info or session fallbacks, attaches parent context using only ambient environment trace context, and returns the span.

**Call relations**: Called by in-process request handling so embedded callers produce spans comparable to transport-based requests.

*Call graph*: calls 6 internal fn (app_server_request_span_template, attach_parent_context, initialize_client_info_from_typed_request, record_client_info, app_server_client_name, client_version); called by 1 (process_client_request); 2 external calls (id, method).


##### `transport_name`  (lines 85–92)

```
fn transport_name(transport: &AppServerTransport) -> &'static str
```

**Purpose**: Maps `AppServerTransport` variants to the stable string values recorded in tracing spans.

**Data flow**: Matches on `AppServerTransport` and returns one of the static strings `"stdio"`, `"unix_socket"`, `"websocket"`, or `"off"`.

**Call relations**: Used only by `request_span` when filling the `rpc.transport` field.

*Call graph*: called by 1 (request_span).


##### `app_server_request_span_template`  (lines 94–114)

```
fn app_server_request_span_template(
    method: &str,
    transport: &'static str,
    request_id: &impl std::fmt::Display,
    connection_id: ConnectionId,
) -> Span
```

**Purpose**: Creates the base tracing span with the standard app-server/OpenTelemetry field set and empty placeholders for client metadata.

**Data flow**: Takes method, transport string, request ID display value, and connection ID, and returns an `info_span!` named `app_server.request` populated with fixed fields plus empty `app_server.client_name`, `app_server.client_version`, and `turn.id` fields.

**Call relations**: Shared by both `request_span` and `typed_request_span` so all request spans have the same shape.

*Call graph*: called by 2 (request_span, typed_request_span); 1 external calls (info_span!).


##### `record_client_info`  (lines 116–123)

```
fn record_client_info(span: &Span, client_name: Option<&str>, client_version: Option<&str>)
```

**Purpose**: Writes optional client name and version values into an existing span only when present.

**Data flow**: Takes a `Span` plus `Option<&str>` for client name and version; if each option is `Some`, it records the corresponding field on the span.

**Call relations**: Used by both span-construction entrypoints after they derive client identity from initialize params or session state.

*Call graph*: called by 2 (request_span, typed_request_span); 1 external calls (record).


##### `attach_parent_context`  (lines 125–142)

```
fn attach_parent_context(
    span: &Span,
    method: &str,
    request_id: &impl std::fmt::Display,
    parent_trace: Option<&W3cTraceContext>,
)
```

**Purpose**: Attaches distributed tracing parent context to a span from either an inbound W3C trace carrier or ambient environment context.

**Data flow**: Takes a span, method, request ID, and optional `W3cTraceContext`. If a parent trace is provided it calls `set_parent_from_w3c_trace_context`; invalid carriers trigger a warning with method and request ID. If no explicit parent trace exists, it checks `traceparent_context_from_env()` and, when present, applies it with `set_parent_from_context`.

**Call relations**: Called by both `request_span` and `typed_request_span` so parent-trace behavior is consistent across transport and in-process requests.

*Call graph*: called by 2 (request_span, typed_request_span); 4 external calls (set_parent_from_context, set_parent_from_w3c_trace_context, traceparent_context_from_env, warn!).


##### `client_name`  (lines 144–152)

```
fn client_name(
    initialize_client_info: Option<&'a InitializeParams>,
    session: &'a ConnectionSessionState,
) -> Option<&'a str>
```

**Purpose**: Chooses the client name for a transport request, preferring initialize params over previously stored session state.

**Data flow**: Takes optional `InitializeParams` and a `ConnectionSessionState`; returns `Some(params.client_info.name.as_str())` when initialize params are present, otherwise returns `session.app_server_client_name()`.

**Call relations**: Used by `request_span` during client-info recording.

*Call graph*: calls 1 internal fn (app_server_client_name); called by 1 (request_span).


##### `client_version`  (lines 154–162)

```
fn client_version(
    initialize_client_info: Option<&'a InitializeParams>,
    session: &'a ConnectionSessionState,
) -> Option<&'a str>
```

**Purpose**: Chooses the client version for a transport request, preferring initialize params over previously stored session state.

**Data flow**: Takes optional `InitializeParams` and a `ConnectionSessionState`; returns `Some(params.client_info.version.as_str())` when initialize params are present, otherwise returns `session.client_version()`.

**Call relations**: Used by `request_span` during client-info recording.

*Call graph*: calls 1 internal fn (client_version); called by 1 (request_span).


##### `initialize_client_info`  (lines 164–170)

```
fn initialize_client_info(request: &JSONRPCRequest) -> Option<InitializeParams>
```

**Purpose**: Extracts `InitializeParams` from a parsed JSON-RPC request only when the method is `initialize`.

**Data flow**: Checks `request.method`; if it is not `"initialize"` returns `None`. Otherwise clones `request.params`, deserializes them with `serde_json::from_value`, and returns `Option<InitializeParams>`.

**Call relations**: Used by `request_span` to derive client name/version from the initialize request itself.

*Call graph*: called by 1 (request_span); 1 external calls (from_value).


##### `initialize_client_info_from_typed_request`  (lines 172–180)

```
fn initialize_client_info_from_typed_request(request: &ClientRequest) -> Option<(&str, &str)>
```

**Purpose**: Extracts client name and version from a typed `ClientRequest::Initialize` variant.

**Data flow**: Matches on `ClientRequest`; for `Initialize { params, .. }` it returns `Some((&params.client_info.name, &params.client_info.version))`, otherwise `None`.

**Call relations**: Used by `typed_request_span` as the typed-request analogue of `initialize_client_info`.

*Call graph*: called by 1 (typed_request_span).


### `core/src/sandbox_tags.rs`

`util` · `cross-cutting telemetry/tag generation during request dispatch and turn metadata assembly`

This file reduces rich permission and sandbox configuration into short static strings suitable for analytics, telemetry, or event tagging. `permission_profile_sandbox_tag` answers the question "what sandbox implementation is effectively in play?" It immediately classifies `PermissionProfile::Disabled` as `"none"` and `External` as `"external"`. For managed profiles, it first converts the file-system config into a sandbox policy and asks `should_require_platform_sandbox` whether a platform sandbox is actually needed given the filesystem policy, network mode, and `enforce_managed_network` flag. If not, the tag is also `"none"`. Otherwise, Windows gets a special `"windows_elevated"` tag when the target OS is Windows and the configured level is `Elevated`; all other cases query `get_platform_sandbox`, convert the resulting `SandboxType` to its metric tag, and fall back to `"none"` if no platform sandbox is available.

`permission_profile_policy_tag` answers a different question: "what high-level access policy does this profile represent from the caller's perspective?" Disabled maps to `"danger-full-access"`, external to `"external-sandbox"`, and managed profiles are classified by inspecting the derived filesystem sandbox policy. Full-disk write access becomes `"danger-full-access"`; zero writable roots relative to `cwd` becomes `"read-only"`; otherwise the tag is `"workspace-write"`. Together these functions provide stable, low-cardinality summaries of both enforcement mechanism and effective write scope.

#### Function details

##### `permission_profile_sandbox_tag`  (lines 8–38)

```
fn permission_profile_sandbox_tag(
    profile: &PermissionProfile,
    windows_sandbox_level: WindowsSandboxLevel,
    enforce_managed_network: bool,
) -> &'static str
```

**Purpose**: Returns a static tag describing the effective sandbox implementation for a permission profile, taking platform requirements and Windows sandbox level into account.

**Data flow**: It takes a `PermissionProfile`, `WindowsSandboxLevel`, and `enforce_managed_network` flag. It pattern-matches the profile: `Disabled` returns `"none"`, `External` returns `"external"`, and `Managed` derives a filesystem sandbox policy and calls `should_require_platform_sandbox`; if that returns false it returns `"none"`. Otherwise, on Windows with `Elevated` level it returns `"windows_elevated"`; in all remaining cases it calls `get_platform_sandbox(windows_sandbox_level != WindowsSandboxLevel::Disabled)`, maps the resulting `SandboxType` through `SandboxType::as_metric_tag`, and falls back to `"none"` if no sandbox is available.

**Call relations**: This helper is called by telemetry-producing flows such as `dispatch_any_with_terminal_outcome`, metadata construction in `new`, and tests validating platform sandbox tagging. It delegates the managed-profile requirement decision to `should_require_platform_sandbox` and platform detection to `get_platform_sandbox`.

*Call graph*: calls 1 internal fn (should_require_platform_sandbox); called by 3 (dispatch_any_with_terminal_outcome, new, turn_metadata_state_uses_platform_sandbox_tag); 3 external calls (cfg!, get_platform_sandbox, matches!).


##### `permission_profile_policy_tag`  (lines 40–61)

```
fn permission_profile_policy_tag(
    profile: &PermissionProfile,
    cwd: &Path,
) -> &'static str
```

**Purpose**: Returns a static tag describing the effective high-level access policy implied by a permission profile and current working directory.

**Data flow**: It takes a `PermissionProfile` and `cwd: &Path`. `Disabled` maps directly to `"danger-full-access"`, `External` to `"external-sandbox"`, and `Managed` derives `profile.file_system_sandbox_policy()`, then checks `has_full_disk_write_access()` and `get_writable_roots_with_cwd(cwd)` to classify the profile as `"danger-full-access"`, `"read-only"`, or `"workspace-write"`. It returns a `&'static str` and mutates nothing.

**Call relations**: This function is used by `dispatch_any_with_terminal_outcome` when emitting policy-oriented telemetry. It complements `permission_profile_sandbox_tag` by summarizing access scope rather than sandbox mechanism.

*Call graph*: calls 1 internal fn (file_system_sandbox_policy); called by 1 (dispatch_any_with_terminal_outcome).


### `core/src/tools/tool_dispatch_trace.rs`

`orchestration` · `tool dispatch; wraps each registry invocation/result with rollout tracing`

This module is a thin adapter around `codex_rollout_trace`. `ToolDispatchTrace` owns a `ToolDispatchTraceContext` started from the session's `rollout_thread_trace`, and its methods ensure dispatch success and failure paths emit matching trace end events. The adapter is intentionally separate from registry control flow so the registry can stay focused on dispatch semantics while this file handles schema translation.

`start` snapshots a `ToolInvocation` into a `ToolDispatchInvocation`, including thread and turn identifiers, tool name and namespace, requester identity, and a normalized payload. Requester mapping is source-sensitive: direct model calls become `ToolDispatchRequester::Model` with the model-visible call id, while code-mode calls become `ToolDispatchRequester::CodeCell` with runtime cell and tool-call ids.

On completion, `record_completed` first checks whether tracing is enabled, then converts the invocation/result pair into a `ToolDispatchResult`. Direct calls serialize the model-facing response item via `to_response_item`; code-mode calls serialize the JavaScript-facing value via `code_mode_result`. The method derives `ExecutionStatus::Completed` versus `Failed` from `result.success_for_logging()`, so tool-level failures still produce a completed trace record with failed status rather than disappearing. `record_failed` delegates fatal or early-return errors directly to the trace context. Payload conversion is centralized in `tool_dispatch_payload`, which preserves the original argument or custom-input string for function, tool-search, and custom payload variants.

#### Function details

##### `ToolDispatchTrace::start`  (lines 25–32)

```
fn start(invocation: &ToolInvocation) -> Self
```

**Purpose**: Begins a rollout-trace span for a tool dispatch using the current invocation as the source of trace metadata.

**Data flow**: Reads the invocation's session services, calls `start_tool_dispatch_trace` with a closure that builds a `ToolDispatchInvocation`, and stores the returned `ToolDispatchTraceContext` inside a new `ToolDispatchTrace`.

**Call relations**: Called by `dispatch_any_with_terminal_outcome` at the start of registry dispatch so later success or failure paths can close the trace consistently.

*Call graph*: called by 1 (dispatch_any_with_terminal_outcome).


##### `ToolDispatchTrace::record_completed`  (lines 34–55)

```
fn record_completed(
        &self,
        invocation: &ToolInvocation,
        call_id: &str,
        payload: &ToolPayload,
        result: &dyn ToolOutput,
    )
```

**Purpose**: Finishes a dispatch trace for a completed tool call, recording either completed or failed execution status based on the tool output's logging success flag.

**Data flow**: Takes the original `ToolInvocation`, the response `call_id`, the `ToolPayload`, and a `dyn ToolOutput`. It first checks `self.context.is_enabled()`, then builds a `ToolDispatchResult` via `tool_dispatch_result`; if conversion succeeds, it computes `ExecutionStatus` from `result.success_for_logging()` and writes the completion event through `self.context.record_completed`.

**Call relations**: Used on successful dispatch return paths. It delegates payload/result-shape conversion to `tool_dispatch_result` so the registry does not need to know trace schema details.

*Call graph*: calls 3 internal fn (tool_dispatch_result, is_enabled, record_completed); 1 external calls (success_for_logging).


##### `ToolDispatchTrace::record_failed`  (lines 57–59)

```
fn record_failed(&self, error: &FunctionCallError)
```

**Purpose**: Finishes a dispatch trace with a failure event derived from a `FunctionCallError`.

**Data flow**: Consumes a shared reference to self and a `FunctionCallError`, then forwards that error to `self.context.record_failed`. It does not transform the error locally.

**Call relations**: Used by dispatch failure paths to ensure unsupported tools, incompatible payloads, and other early errors still produce terminal trace records.

*Call graph*: calls 1 internal fn (record_failed).


##### `tool_dispatch_invocation`  (lines 62–85)

```
fn tool_dispatch_invocation(invocation: &ToolInvocation) -> Option<ToolDispatchInvocation>
```

**Purpose**: Converts a core `ToolInvocation` into the rollout-trace invocation schema, including requester identity and normalized payload.

**Data flow**: Reads `invocation.source` to choose either `ToolDispatchRequester::Model` or `ToolDispatchRequester::CodeCell`, copies thread id, turn id, call id, tool name, and namespace from the invocation, converts `invocation.payload` with `tool_dispatch_payload`, and returns `Some(ToolDispatchInvocation)`.

**Call relations**: Used only by `ToolDispatchTrace::start` as the lazy builder passed into the rollout-trace context.

*Call graph*: calls 1 internal fn (tool_dispatch_payload).


##### `tool_dispatch_result`  (lines 87–101)

```
fn tool_dispatch_result(
    invocation: &ToolInvocation,
    call_id: &str,
    payload: &ToolPayload,
    result: &dyn ToolOutput,
) -> Option<ToolDispatchResult>
```

**Purpose**: Converts a completed tool output into the rollout-trace result schema appropriate for the invocation source.

**Data flow**: Reads `invocation.source`; for `Direct` it calls `result.to_response_item(call_id, payload)` and wraps it in `ToolDispatchResult::DirectResponse`, while for `CodeMode` it calls `result.code_mode_result(payload)` and wraps it in `ToolDispatchResult::CodeModeResponse`. It returns the constructed result as `Some(...)`.

**Call relations**: Called by `ToolDispatchTrace::record_completed` to keep source-specific result serialization out of the tracing wrapper's control flow.

*Call graph*: calls 1 internal fn (code_mode_result); called by 1 (record_completed); 1 external calls (to_response_item).


##### `tool_dispatch_payload`  (lines 103–115)

```
fn tool_dispatch_payload(payload: &ToolPayload) -> ToolDispatchPayload
```

**Purpose**: Normalizes core tool payload variants into the rollout-trace payload enum while preserving the raw input strings.

**Data flow**: Pattern-matches `ToolPayload`: function arguments become `ToolDispatchPayload::Function`, tool-search arguments become `ToolDispatchPayload::ToolSearch`, and custom input becomes `ToolDispatchPayload::Custom`, each cloning the underlying string.

**Call relations**: Used by `tool_dispatch_invocation` so trace records retain the original invocation payload regardless of tool type.

*Call graph*: called by 1 (tool_dispatch_invocation).


### Feature metrics emitters
These files provide focused instrumentation for specific product areas such as guardian reviews, cloud-config activity, and goal lifecycle events.

### `core/src/guardian/metrics.rs`

`util` · `cross-cutting; whenever a guardian review finishes`

This file is the guardian review telemetry adapter between `GuardianReviewAnalyticsResult` and the concrete metric instruments exposed by `SessionTelemetry`. The main entrypoint builds a shared tag set from review outcome data, increments the guardian review counter, records total review latency, optionally records time-to-first-token, and, when token accounting is present, emits one histogram sample per token category. The tag set is intentionally normalized into low-cardinality strings: enums such as `GuardianReviewDecision`, `GuardianReviewTerminalStatus`, `GuardianRiskLevel`, and `GuardianUserAuthorization` are mapped to fixed literals, optional booleans become `true`/`false`/`unknown`, and free-form model / reasoning-effort strings are sanitized before use as metric tags. Missing optional fields are consistently represented as `none` rather than omitted, which keeps metric dimensions stable.

Token usage emission is split out so each histogram point reuses the same base tags plus a `token_type` dimension for `total`, `input`, `cached_input`, `non_cached_input`, `output`, and `reasoning_output`. Negative token counts are clamped to zero before recording, matching the defensive handling in `TokenUsage`. The tests construct an in-memory metrics client, emit a representative approved network-access review, then inspect exported metric points to verify exact attributes and histogram sums, including sanitization of `guardian_model` into `gpt-5.4_guardian`.

#### Function details

##### `emit_guardian_review_metrics`  (lines 21–52)

```
fn emit_guardian_review_metrics(
    session_telemetry: &SessionTelemetry,
    result: &GuardianReviewAnalyticsResult,
    approval_request_source: GuardianApprovalRequestSource,
    reviewed_action:
```

**Purpose**: Builds the full guardian review tag set and records the core review metrics for one completed review. It always emits count and total duration, and conditionally emits TTFT and token-usage histograms when those fields are present in the analytics result.

**Data flow**: Reads `session_telemetry`, the completed `GuardianReviewAnalyticsResult`, the approval source, reviewed action, and wall-clock completion latency in milliseconds. It transforms the analytics result into `Vec<(&'static str, String)>` tags via `guardian_review_metric_tags`, converts them into borrowed `(&str, &str)` pairs, increments `GUARDIAN_REVIEW_COUNT_METRIC`, records `GUARDIAN_REVIEW_DURATION_METRIC` from `completion_latency_ms`, optionally records `GUARDIAN_REVIEW_TTFT_DURATION_METRIC` from `result.time_to_first_token_ms`, and, if `result.token_usage` exists, delegates token histogram emission. It returns no value and writes only telemetry side effects.

**Call relations**: This is the file’s public metric entrypoint. It is invoked by guardian review orchestration after a review completes, and by the unit test that validates emitted metrics. After assembling tags, it delegates token-specific work to `emit_guardian_token_usage_histograms` so the main review path stays focused on the common metrics.

*Call graph*: calls 4 internal fn (emit_guardian_token_usage_histograms, guardian_review_metric_tags, counter, record_duration); called by 2 (guardian_review_metrics_record_counts_durations_and_token_usage, track_guardian_review); 1 external calls (from_millis).


##### `emit_guardian_token_usage_histograms`  (lines 54–78)

```
fn emit_guardian_token_usage_histograms(
    session_telemetry: &SessionTelemetry,
    token_usage: &TokenUsage,
    base_tags: Vec<(&'static str, String)>,
)
```

**Purpose**: Records guardian token usage as multiple histogram samples, one per token category. It expands a single `TokenUsage` struct into six tagged measurements.

**Data flow**: Consumes `session_telemetry`, a `TokenUsage` reference, and an owned base tag vector. For each derived token type/value pair, it clones the base tags, appends `("token_type", ...)`, converts tags to borrowed references, and records a histogram sample to `GUARDIAN_REVIEW_TOKEN_USAGE_METRIC`. It reads `cached_input()` and `non_cached_input()` from `TokenUsage`, clamps signed token counters with `.max(0)`, and returns nothing.

**Call relations**: Only `emit_guardian_review_metrics` calls this helper, and only when the analytics result includes token usage. Its role is to fan out one logical token-usage payload into the metric backend’s preferred per-sample representation.

*Call graph*: calls 3 internal fn (histogram, cached_input, non_cached_input); called by 1 (emit_guardian_review_metrics).


##### `guardian_review_metric_tags`  (lines 80–135)

```
fn guardian_review_metric_tags(
    result: &GuardianReviewAnalyticsResult,
    approval_request_source: GuardianApprovalRequestSource,
    reviewed_action: &GuardianReviewedAction,
) -> Vec<(&'static
```

**Purpose**: Constructs the canonical guardian review metric dimensions from analytics fields and request metadata. It centralizes all tag naming and defaulting rules in one place.

**Data flow**: Reads the review `result`, `approval_request_source`, and `reviewed_action`. It maps each field through the local tag helpers, sanitizes optional `guardian_model` and `guardian_reasoning_effort` strings, substitutes `none` for absent optional values, and returns a `Vec<(&'static str, String)>` containing tags such as `decision`, `terminal_status`, `failure_reason`, `action`, `session_kind`, `risk_level`, and `outcome`.

**Call relations**: This helper is called by `emit_guardian_review_metrics` before any metric emission. It depends on the small enum-to-string helpers below to keep the tag vocabulary stable and low-cardinality.

*Call graph*: called by 1 (emit_guardian_review_metrics); 1 external calls (vec!).


##### `decision_tag`  (lines 137–143)

```
fn decision_tag(decision: GuardianReviewDecision) -> &'static str
```

**Purpose**: Maps a `GuardianReviewDecision` enum to its metric string literal.

**Data flow**: Takes a `GuardianReviewDecision`, matches its variant, and returns one of `approved`, `denied`, or `aborted`. It has no side effects.

**Call relations**: Used indirectly through `guardian_review_metric_tags` to normalize decision values before metric emission.


##### `terminal_status_tag`  (lines 145–153)

```
fn terminal_status_tag(status: GuardianReviewTerminalStatus) -> &'static str
```

**Purpose**: Maps the terminal review status enum to the metric tag vocabulary, including timeout and fail-closed cases.

**Data flow**: Consumes a `GuardianReviewTerminalStatus` and returns a static string such as `approved`, `denied`, `aborted`, `timed_out`, or `failed_closed`.

**Call relations**: Called from `guardian_review_metric_tags` so terminal-state analytics become stable metric dimensions.


##### `failure_reason_tag`  (lines 155–164)

```
fn failure_reason_tag(reason: Option<GuardianReviewFailureReason>) -> &'static str
```

**Purpose**: Converts an optional guardian failure reason into a metric-safe string, with `none` for successful reviews.

**Data flow**: Reads `Option<GuardianReviewFailureReason>`, pattern-matches each known failure variant, and returns `timeout`, `cancelled`, `prompt_build_error`, `session_error`, `parse_error`, or `none`.

**Call relations**: Used by `guardian_review_metric_tags` to preserve failure classification even when the terminal status is broader.


##### `approval_request_source_tag`  (lines 166–171)

```
fn approval_request_source_tag(source: GuardianApprovalRequestSource) -> &'static str
```

**Purpose**: Normalizes the source of the approval request into a fixed metric tag.

**Data flow**: Takes `GuardianApprovalRequestSource` and returns `main_turn` or `delegated_subagent`.

**Call relations**: Called during tag construction so metrics distinguish reviews initiated by the main turn from delegated subagents.


##### `reviewed_action_tag`  (lines 173–183)

```
fn reviewed_action_tag(action: &GuardianReviewedAction) -> &'static str
```

**Purpose**: Classifies the reviewed action variant into a compact action tag.

**Data flow**: Matches a borrowed `GuardianReviewedAction` and returns a static label such as `shell`, `unified_exec`, `execve`, `apply_patch`, `network_access`, `mcp_tool_call`, or `request_permissions`.

**Call relations**: Used by `guardian_review_metric_tags` to expose what kind of action guardian reviewed without embedding action payload details.


##### `session_kind_tag`  (lines 185–192)

```
fn session_kind_tag(kind: Option<GuardianReviewSessionKind>) -> &'static str
```

**Purpose**: Maps optional guardian session reuse metadata into a metric tag.

**Data flow**: Consumes `Option<GuardianReviewSessionKind>` and returns `trunk_new`, `trunk_reused`, `ephemeral_forked`, or `none`.

**Call relations**: Called from `guardian_review_metric_tags` so metrics can distinguish fresh, reused, and forked guardian sessions.


##### `optional_bool_tag`  (lines 194–200)

```
fn optional_bool_tag(value: Option<bool>) -> &'static str
```

**Purpose**: Encodes tri-state optional booleans for metrics.

**Data flow**: Reads `Option<bool>` and returns `true`, `false`, or `unknown`.

**Call relations**: Used for tags like `had_prior_review_context`, where absence is semantically different from false.


##### `bool_tag`  (lines 202–204)

```
fn bool_tag(value: bool) -> &'static str
```

**Purpose**: Encodes a plain boolean as a metric tag string.

**Data flow**: Takes `bool` and returns `true` or `false`.

**Call relations**: Used by `guardian_review_metric_tags` for non-optional flags such as `reviewed_action_truncated`.


##### `risk_level_tag`  (lines 206–214)

```
fn risk_level_tag(risk_level: Option<GuardianRiskLevel>) -> &'static str
```

**Purpose**: Maps optional guardian risk levels into metric strings.

**Data flow**: Consumes `Option<GuardianRiskLevel>` and returns `low`, `medium`, `high`, `critical`, or `none`.

**Call relations**: Part of the tag-construction pipeline for completed reviews.


##### `user_authorization_tag`  (lines 216–224)

```
fn user_authorization_tag(user_authorization: Option<GuardianUserAuthorization>) -> &'static str
```

**Purpose**: Maps optional user-authorization assessments into metric strings.

**Data flow**: Consumes `Option<GuardianUserAuthorization>` and returns `unknown`, `low`, `medium`, `high`, or `none`.

**Call relations**: Used by `guardian_review_metric_tags` to expose guardian’s authorization judgment in telemetry.


##### `outcome_tag`  (lines 226–232)

```
fn outcome_tag(outcome: Option<GuardianAssessmentOutcome>) -> &'static str
```

**Purpose**: Maps optional guardian allow/deny outcomes into metric strings.

**Data flow**: Consumes `Option<GuardianAssessmentOutcome>` and returns `allow`, `deny`, or `none`.

**Call relations**: Called during metric tag assembly so the final assessment outcome is available as a dimension.


##### `tests::test_session_telemetry`  (lines 251–271)

```
fn test_session_telemetry() -> SessionTelemetry
```

**Purpose**: Builds a `SessionTelemetry` instance backed by an in-memory OpenTelemetry exporter for metric assertions. It strips metadata tags so tests can compare only guardian-specific attributes.

**Data flow**: Creates an `InMemoryMetricExporter`, wraps it in `MetricsClient::new(MetricsConfig::in_memory(...).with_runtime_reader())`, constructs a `SessionTelemetry` with synthetic thread/model/session metadata, and returns the telemetry object configured with metrics but without metadata tags.

**Call relations**: Used by the metrics test as the fixture that captures emitted guardian metrics without requiring external telemetry infrastructure.

*Call graph*: calls 4 internal fn (new, new, in_memory, new); 2 external calls (default, env!).


##### `tests::find_metric`  (lines 273–282)

```
fn find_metric(resource_metrics: &'a ResourceMetrics, name: &str) -> &'a Metric
```

**Purpose**: Searches a `ResourceMetrics` snapshot for a metric by name and panics if it is absent.

**Data flow**: Iterates through scope metrics and their contained metrics, compares each metric name to the requested `name`, and returns a borrowed `Metric` reference on match. If no metric matches, it panics with a descriptive message.

**Call relations**: Shared by the test helpers that decode counters and histograms from the in-memory exporter snapshot.

*Call graph*: 2 external calls (scope_metrics, panic!).


##### `tests::attributes_to_map`  (lines 284–290)

```
fn attributes_to_map(
        attributes: impl Iterator<Item = &'a KeyValue>,
    ) -> BTreeMap<String, String>
```

**Purpose**: Converts OpenTelemetry attribute iterators into a deterministic `BTreeMap` for assertions.

**Data flow**: Consumes an iterator of `&KeyValue`, maps each key/value to owned `String`s, and collects them into a sorted `BTreeMap<String, String>`.

**Call relations**: Used by `counter_point` and `histogram_sums` so tests can compare metric attributes independent of iteration order.

*Call graph*: 1 external calls (map).


##### `tests::counter_point`  (lines 292–309)

```
fn counter_point(
        resource_metrics: &ResourceMetrics,
        name: &str,
    ) -> (BTreeMap<String, String>, u64)
```

**Purpose**: Extracts the single data point from a u64 sum metric and returns its attributes and value. It asserts the expected aggregation shape used by the guardian counter metric.

**Data flow**: Looks up the metric by name with `find_metric`, matches the metric data as `AggregatedMetrics::U64(MetricData::Sum)`, asserts there is exactly one point, converts that point’s attributes with `attributes_to_map`, and returns `(BTreeMap<String, String>, u64)`. Unexpected aggregation types cause a panic.

**Call relations**: Called by the main metrics test to inspect `GUARDIAN_REVIEW_COUNT_METRIC` after emitting one review.

*Call graph*: 4 external calls (assert_eq!, attributes_to_map, find_metric, panic!).


##### `tests::histogram_sums`  (lines 311–332)

```
fn histogram_sums(resource_metrics: &ResourceMetrics, name: &str) -> BTreeMap<String, u64>
```

**Purpose**: Reads histogram points from a metric snapshot and indexes them by `token_type` or a fallback sample label. This lets tests compare guardian duration and token-usage histograms by summed value.

**Data flow**: Finds the metric, matches it as `AggregatedMetrics::F64(MetricData::Histogram)`, iterates data points, converts attributes to a map, extracts `token_type` when present or uses `sample`, and collects a `BTreeMap<String, u64>` from label to `point.sum() as u64`.

**Call relations**: Used by the main test to validate token usage, total duration, and TTFT histograms emitted by `emit_guardian_review_metrics`.

*Call graph*: 2 external calls (find_metric, panic!).


##### `tests::guardian_review_metrics_record_counts_durations_and_token_usage`  (lines 335–417)

```
fn guardian_review_metrics_record_counts_durations_and_token_usage()
```

**Purpose**: End-to-end test that verifies guardian review metrics include the expected tags, durations, and token-usage breakdown. It exercises approved network-access review telemetry with populated optional fields.

**Data flow**: Creates test telemetry, builds a `GuardianReviewAnalyticsResult` with decision, terminal status, risk, authorization, outcome, session kind, model metadata, prior-context flag, truncation flag, token usage, and TTFT, then calls `emit_guardian_review_metrics`. It snapshots metrics and asserts the counter value and exact attribute map, plus histogram sums for token categories and durations.

**Call relations**: This test is the direct caller of `emit_guardian_review_metrics` in the file and validates the full tag vocabulary and optional metric branches.

*Call graph*: calls 2 internal fn (without_session, emit_guardian_review_metrics); 3 external calls (assert_eq!, counter_point, test_session_telemetry).


### `cloud-config/src/metrics.rs`

`util` · `cross-cutting during fetch retries, final outcomes, and load completion`

This file is a small telemetry helper layer around `codex_otel::global()`. It defines three metric names: per-attempt fetches, final fetch outcomes, and overall load outcomes. The public helpers build consistent tag sets so the service code does not duplicate string formatting or omit dimensions.

`emit_fetch_attempt_metric` records each backend attempt with `trigger` (for example startup or refresh), numeric `attempt`, textual `outcome`, and a normalized `status_code` tag. `emit_fetch_final_metric` records the terminal result of a fetch sequence, adding `reason`, total `attempt_count`, and `bundle_shape`. `emit_load_metric` records the higher-level startup/refresh load outcome and also includes `bundle_shape`.

`bundle_shape_tag` is the only domain-aware helper here. It maps `None` to `"none"`, an empty bundle to `"empty"`, and otherwise inspects whether `config_toml.enterprise_managed` and/or `requirements_toml.enterprise_managed` are non-empty. It emits stable comma-separated labels sorted lexicographically, so the combined case is always `enterprise_config,enterprise_requirements` regardless of insertion order. `status_code_tag` similarly normalizes absent codes to `"none"`.

The private `emit_metric` function is intentionally best-effort: if no global metrics backend is installed, it silently does nothing; otherwise it converts owned tag strings into borrowed `(&str, &str)` pairs and increments the named counter by 1.

#### Function details

##### `emit_fetch_attempt_metric`  (lines 7–24)

```
fn emit_fetch_attempt_metric(
    trigger: &str,
    attempt: usize,
    outcome: &str,
    status_code: Option<u16>,
)
```

**Purpose**: Emits a counter event for one individual backend fetch attempt.

**Data flow**: Takes `trigger`, numeric `attempt`, textual `outcome`, and optional `status_code`. It converts `attempt` to a string, normalizes the status code via `status_code_tag`, assembles four tags, and passes them to `emit_metric` under `codex.cloud_config_bundle.fetch_attempt`.

**Call relations**: Called by the service on successful fetch validation, retryable request failures, and unauthorized responses so each attempt is observable regardless of final outcome.

*Call graph*: calls 2 internal fn (emit_metric, status_code_tag); called by 3 (handle_unauthorized, retry_after_request_failure, validate_and_cache_remote_bundle); 1 external calls (vec!).


##### `emit_fetch_final_metric`  (lines 26–47)

```
fn emit_fetch_final_metric(
    trigger: &str,
    outcome: &str,
    reason: &str,
    attempt_count: usize,
    status_code: Option<u16>,
    bundle: Option<&CloudConfigBundle>,
)
```

**Purpose**: Emits the terminal metric for a fetch sequence after success or permanent failure.

**Data flow**: Takes `trigger`, `outcome`, `reason`, `attempt_count`, optional `status_code`, and optional bundle reference. It stringifies `attempt_count`, normalizes the status code, derives `bundle_shape` from the bundle, builds the tag vector, and sends it to `emit_metric` under `codex.cloud_config_bundle.fetch_final`.

**Call relations**: Used by the service when a remote bundle is accepted, when validation fails, when auth recovery fails or is unavailable, and when retries are exhausted.

*Call graph*: calls 2 internal fn (emit_metric, status_code_tag); called by 3 (fetch_remote_bundle_and_update_cache_with_retries, handle_unauthorized, validate_and_cache_remote_bundle); 1 external calls (vec!).


##### `emit_load_metric`  (lines 49–58)

```
fn emit_load_metric(trigger: &str, outcome: &str, bundle: Option<&CloudConfigBundle>)
```

**Purpose**: Emits the higher-level load metric for startup or refresh operations.

**Data flow**: Takes `trigger`, `outcome`, and optional bundle reference. It derives `bundle_shape`, builds three tags, and forwards them to `emit_metric` under `codex.cloud_config_bundle.load`.

**Call relations**: Called by startup timeout handling and by refresh paths to record whether the overall load cycle succeeded or failed, independent of lower-level retry details.

*Call graph*: calls 1 internal fn (emit_metric); called by 3 (load_startup_bundle_with_timeout, refresh_cache_in_background, refresh_cache_once); 1 external calls (vec!).


##### `bundle_shape_tag`  (lines 60–79)

```
fn bundle_shape_tag(bundle: Option<&CloudConfigBundle>) -> String
```

**Purpose**: Summarizes the structural contents of a bundle into a stable tag string for metrics.

**Data flow**: Accepts `Option<&CloudConfigBundle>`. `None` returns `"none"`. For `Some(bundle)`, it creates a mutable `Vec<&str>`, pushes `enterprise_config` if `config_toml.enterprise_managed` is non-empty and `enterprise_requirements` if `requirements_toml.enterprise_managed` is non-empty, then returns `"empty"` if no sources were present or a sorted comma-joined string otherwise.

**Call relations**: Used by final fetch and load metric helpers so telemetry can distinguish empty bundles from bundles containing config fragments, requirements fragments, or both.

*Call graph*: 1 external calls (new).


##### `status_code_tag`  (lines 81–85)

```
fn status_code_tag(status_code: Option<u16>) -> String
```

**Purpose**: Normalizes an optional HTTP status code into a metric tag value.

**Data flow**: Takes `Option<u16>`, converts `Some(code)` to `code.to_string()`, and maps `None` to the literal string `"none"`.

**Call relations**: Shared by both fetch metric helpers to keep status-code tagging consistent across attempt-level and final metrics.

*Call graph*: called by 2 (emit_fetch_attempt_metric, emit_fetch_final_metric).


##### `emit_metric`  (lines 87–95)

```
fn emit_metric(metric_name: &str, tags: Vec<(&str, String)>)
```

**Purpose**: Performs the actual best-effort counter emission through the global OpenTelemetry facade.

**Data flow**: Consumes a metric name and owned tag vector `Vec<(&str, String)>`. It queries `codex_otel::global()`, and if metrics are available, converts each tag value to `&str`, collects borrowed tag refs, and calls `metrics.counter(metric_name, 1, &tag_refs)`. If no global metrics backend exists, it returns without output.

**Call relations**: This private sink is used by all public metric helpers so service code only needs to supply semantic fields, not telemetry plumbing.

*Call graph*: called by 3 (emit_fetch_attempt_metric, emit_fetch_final_metric, emit_load_metric); 1 external calls (global).


### `ext/goal/src/metrics.rs`

`orchestration` · `whenever goal lifecycle transitions are persisted`

This file is the metrics adapter for the goal subsystem. `GoalMetrics` simply wraps `Option<MetricsClient>`, making all metric emission no-ops when metrics are unavailable. The public methods correspond to semantic lifecycle moments rather than raw metric names: `record_created`, `record_resumed`, `record_resumed_if_status_changed`, and `record_terminal_if_status_changed`.

The conditional methods encode the subsystem’s metric policy. A goal is considered resumed only when its new status is `Active` and the previous status was one of `Paused`, `Blocked`, or `UsageLimited`; transitions from `BudgetLimited` are intentionally excluded. Terminal metrics are emitted only when status actually changes and the new status is one of `Blocked`, `UsageLimited`, `BudgetLimited`, or `Complete`. In that case the code increments the corresponding terminal counter and also records `goal.tokens_used` and `goal.time_used_seconds` into histograms tagged with the final status string. Active and paused states are explicitly ignored for terminal metrics. This keeps metric cardinality and semantics stable while letting runtime and tool code report status transitions through a small, focused API.

#### Function details

##### `GoalMetrics::new`  (lines 17–19)

```
fn new(metrics_client: Option<MetricsClient>) -> Self
```

**Purpose**: Constructs the metrics wrapper around an optional metrics client. It allows the rest of the subsystem to emit metrics without repeatedly checking for client presence.

**Data flow**: Takes `Option<MetricsClient>`, stores it in `GoalMetrics { metrics_client }`, and returns the wrapper. No metrics are emitted here.

**Call relations**: Called during extension construction so runtime and tool code can share one metrics adapter.

*Call graph*: called by 1 (new_with_host_capabilities).


##### `GoalMetrics::record_created`  (lines 21–26)

```
fn record_created(&self)
```

**Purpose**: Increments the goal-created counter if metrics are enabled. It is the direct metric for new goal creation.

**Data flow**: Checks `self.metrics_client.as_ref()`, returns early if `None`, otherwise calls `metrics_client.counter(GOAL_CREATED_METRIC, 1, &[])` and ignores the result.

**Call relations**: Used by goal creation flows after a new goal is established. It is a leaf emission helper with no additional policy.

*Call graph*: called by 1 (handle_create).


##### `GoalMetrics::record_resumed`  (lines 28–33)

```
fn record_resumed(&self)
```

**Purpose**: Increments the goal-resumed counter if metrics are enabled. It records explicit resumption events.

**Data flow**: Returns early when no metrics client exists; otherwise calls `metrics_client.counter(GOAL_RESUMED_METRIC, 1, &[])` and discards the result.

**Call relations**: Called directly by resume restoration and indirectly by `record_resumed_if_status_changed` when a qualifying status transition occurs.

*Call graph*: called by 1 (record_resumed_if_status_changed).


##### `GoalMetrics::record_resumed_if_status_changed`  (lines 35–52)

```
fn record_resumed_if_status_changed(
        &self,
        previous_status: Option<codex_state::ThreadGoalStatus>,
        goal_status: codex_state::ThreadGoalStatus,
    )
```

**Purpose**: Conditionally records a resumed metric when a goal transitions into `Active` from a resumable non-active state. It prevents counting unchanged or non-resume transitions.

**Data flow**: Accepts `previous_status` and `goal_status`, checks whether `goal_status == Active` and `previous_status` matches `Paused | Blocked | UsageLimited`, and if so calls `self.record_resumed()`. Otherwise it returns without side effects.

**Call relations**: Used after external goal sets or updates where both old and new statuses are known. It delegates actual metric emission to `record_resumed`.

*Call graph*: calls 1 internal fn (record_resumed); 1 external calls (matches!).


##### `GoalMetrics::record_terminal_if_status_changed`  (lines 54–83)

```
fn record_terminal_if_status_changed(
        &self,
        previous_status: Option<codex_state::ThreadGoalStatus>,
        goal: &codex_state::ThreadGoal,
    )
```

**Purpose**: Records terminal-status metrics when a goal’s status changes into a terminal or limited state. It emits both a counter for the status and histograms for cumulative tokens and duration.

**Data flow**: Takes `previous_status` and a goal reference, returns immediately if the status is unchanged, matches `goal.status` to choose one of `GOAL_BLOCKED_METRIC`, `GOAL_USAGE_LIMITED_METRIC`, `GOAL_BUDGET_LIMITED_METRIC`, or `GOAL_COMPLETED_METRIC`, and returns early for `Active` or `Paused`. If a metrics client exists, it builds `status_tag = [("status", goal.status.as_str())]`, increments the chosen counter, and records `goal.tokens_used` and `goal.time_used_seconds` into the corresponding histograms with that tag.

**Call relations**: Called by runtime accounting and update flows after persistence. It centralizes the policy for which statuses count as terminal/limited and what aggregate values to record alongside them.

*Call graph*: called by 2 (account_active_goal_progress, handle_update).


### Memories usage telemetry
These files define the metric vocabulary and classification logic for memory reads and tool-driven memory usage, then emit the resulting counters.

### `ext/memories/src/metrics.rs`

`util` · `cross-cutting during tool request handling`

This file is the metrics adapter for the memories extension. Its central constant, `MEMORIES_TOOL_CALL_METRIC`, names the counter emitted whenever a memory tool runs. `record_tool_call` is intentionally defensive: it exits immediately when no `MetricsClient` was wired in, so callers can unconditionally invoke it without branching. When metrics are enabled, it constructs a fully namespaced `tool` tag from `MEMORY_TOOLS_NAMESPACE` and the operation name, then increments the counter with a fixed tag set: tool, operation, scope, status, and truncated. The rest of the file exists to keep those tags low-cardinality and stable.

`scope_from_path` canonicalizes user/backend paths into a small set of semantic buckets rather than emitting raw paths. It trims leading/trailing slashes, strips a leading `./`, then recognizes specific top-level files and directories such as `MEMORY.md`, `memory_summary.md`, `rollout_summaries`, `skills`, and `extensions/ad_hoc/notes`; everything else collapses to `other`. `scope_from_optional_path` preserves that mapping while supplying a caller-chosen default when no path was provided. `truncated_tag` similarly converts `Option<bool>` into the string tags `true`, `false`, or `unknown`, and the private `status_tag` maps success booleans to `succeeded`/`failed`. The design keeps metric dimensions bounded and comparable across list/read/search/add-note operations.

#### Function details

##### `record_tool_call`  (lines 7–30)

```
fn record_tool_call(
    metrics_client: Option<&MetricsClient>,
    operation: &str,
    scope: &str,
    success: bool,
    truncated: &str,
)
```

**Purpose**: Emits one counter increment for a memory-tool invocation, annotated with normalized tags describing which operation ran and whether it succeeded or returned truncated output.

**Data flow**: It takes an optional `&MetricsClient`, the operation name, a precomputed scope tag, a success flag, and a truncated tag string. If the client is `None`, it returns immediately without side effects; otherwise it formats a namespaced tool identifier, derives the status tag via `status_tag`, and calls the client's `counter` method with increment `1` and the assembled tag slice.

**Call relations**: Each tool-specific `handle_call` path invokes this after awaiting its backend operation so telemetry reflects the actual outcome. It delegates only the status-string conversion to `status_tag`; callers are responsible for computing scope and truncation tags before entering.

*Call graph*: calls 1 internal fn (status_tag); called by 4 (handle_call, handle_call, handle_call, handle_call); 1 external calls (format!).


##### `scope_from_path`  (lines 32–53)

```
fn scope_from_path(path: &str) -> &'static str
```

**Purpose**: Maps a concrete memory-store path string into a fixed telemetry scope category.

**Data flow**: It reads a raw path string, strips surrounding `/` characters and an optional leading `./`, then compares the normalized path against known files and directory prefixes. It returns one of several static strings such as `root`, `memory_md`, `memory_summary`, `rollout_summaries`, `skills`, `ad_hoc_notes`, or `other`.

**Call relations**: The read-tool handling flow uses this when it has an explicit path and wants a stable metric tag instead of the literal user-supplied path. It performs no I/O and delegates to no other local helper.

*Call graph*: called by 1 (handle_call).


##### `scope_from_optional_path`  (lines 55–57)

```
fn scope_from_optional_path(path: Option<&str>, default: &'static str) -> &'static str
```

**Purpose**: Provides the same scope categorization as `scope_from_path`, but for optional path arguments.

**Data flow**: It accepts `Option<&str>` plus a static default scope. If a path is present it forwards to `scope_from_path`; if absent it returns the supplied default unchanged.

**Call relations**: List/search handlers call this when path filtering is optional and they need a deterministic scope tag even for root-wide operations. It is a thin wrapper around `scope_from_path` to keep call sites concise.

*Call graph*: called by 2 (handle_call, handle_call).


##### `truncated_tag`  (lines 59–65)

```
fn truncated_tag(truncated: Option<bool>) -> &'static str
```

**Purpose**: Converts an optional truncation flag into the exact string tag expected by metrics.

**Data flow**: It matches on `Option<bool>` and returns `true` for `Some(true)`, `false` for `Some(false)`, and `unknown` for `None`.

**Call relations**: Tool handlers use this after backend completion when truncation may or may not be known from the response shape. It feeds directly into `record_tool_call` as the `truncated` tag value.

*Call graph*: called by 3 (handle_call, handle_call, handle_call).


##### `status_tag`  (lines 67–69)

```
fn status_tag(success: bool) -> &'static str
```

**Purpose**: Turns a success boolean into the low-cardinality status label used on tool-call metrics.

**Data flow**: It reads a `bool` and returns `succeeded` when true, otherwise `failed`.

**Call relations**: Only `record_tool_call` invokes it while assembling metric tags, keeping status-string policy private to this file.

*Call graph*: called by 1 (record_tool_call).


### `memories/read/src/metrics.rs`

`config` · `cross-cutting`

This file contains one public constant, `MEMORIES_USAGE_METRIC`, with the value `"codex.memories.usage"`. Its purpose is to give the memories read path a stable metric key that can be imported wherever telemetry is emitted, avoiding duplicated string literals and accidental naming drift.

Because the constant is `pub`, other modules or crates can depend on the exact metric identifier when recording, aggregating, or testing telemetry. The naming suggests this metric captures usage-level information for memory reads rather than phase timing or token accounting. Keeping the identifier in its own file makes the telemetry contract explicit and easy to audit.

There is no logic here, but the design matters operationally: metric names are effectively part of an observability API. Changing this constant would alter dashboards, alerts, and downstream aggregation behavior, so centralization reduces that risk and makes such changes deliberate.


### `memories/read/src/usage.rs`

`domain_logic` · `tool-read telemetry classification`

This module turns a shell command string into zero or more `MemoriesUsageKind` values that can be emitted as metrics tags. The enum captures the specific memory surfaces the system cares about: `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, rollout summaries, and skills. `MemoriesUsageKind::as_tag` maps each variant to the stable lowercase metric tag string used externally.

The main classifier, `memories_usage_kinds_from_command`, is deliberately conservative. It first asks `parse_shell_script_into_commands` to split the shell script into command units; if parsing fails, it returns an empty vector immediately. It then requires every parsed command to satisfy `is_known_safe_command`; any unsafe or unknown command causes the entire classification to return empty, preventing telemetry from being inferred from arbitrary shell text. Only then does it parse the script into higher-level `ParsedCommand` values and inspect each one. `Read` commands classify directly from their path, `Search` commands classify only when they include a path, and `ListFiles`/`Unknown` commands are ignored. `get_memory_kind` performs simple substring checks against canonical memory path fragments and returns the matching enum variant. The output preserves one classification per matching parsed command and does not deduplicate repeated kinds.

#### Function details

##### `MemoriesUsageKind::as_tag`  (lines 18–26)

```
fn as_tag(self) -> &'static str
```

**Purpose**: Maps a `MemoriesUsageKind` enum variant to the stable metric tag string used in telemetry. The mapping is a fixed one-to-one conversion.

**Data flow**: Consumes `self` by value, matches on the enum variant, and returns the corresponding `&'static str` such as `"memory_md"` or `"rollout_summaries"`.

**Call relations**: This method is used after classification when metrics code needs a string tag. It is pure and does not depend on any parser state.


##### `memories_usage_kinds_from_command`  (lines 29–48)

```
fn memories_usage_kinds_from_command(command: &str) -> Vec<MemoriesUsageKind>
```

**Purpose**: Parses a shell command string and extracts memory-usage categories for safe read/search operations targeting known memory paths. It refuses to classify commands that cannot be parsed safely.

**Data flow**: Accepts `command: &str`, attempts to split it with `parse_shell_script_into_commands`, returns an empty `Vec` if that fails, checks that every parsed command passes `is_known_safe_command` and returns empty if any do not, reparses the script into `ParsedCommand` values with `parse_shell_script`, maps `Read` and `Search` paths through `get_memory_kind`, drops `ListFiles` and `Unknown`, collects the surviving `MemoriesUsageKind` values into a vector, and returns it.

**Call relations**: This function is called by `emit_metric_for_tool_read` to derive telemetry labels from shell activity. Internally it delegates path classification to `get_memory_kind` and relies on shell-command parsing utilities to gate classification on safe, understood commands.

*Call graph*: calls 2 internal fn (parse_shell_script_into_commands, parse_shell_script); called by 1 (emit_metric_for_tool_read); 1 external calls (new).


##### `get_memory_kind`  (lines 50–64)

```
fn get_memory_kind(path: String) -> Option<MemoriesUsageKind>
```

**Purpose**: Classifies a single path string into one of the known memory usage categories based on substring matching. It recognizes specific files and directory prefixes under `memories/`.

**Data flow**: Takes ownership of `path: String`, checks it in priority order for `memories/MEMORY.md`, `memories/memory_summary.md`, `memories/raw_memories.md`, `memories/rollout_summaries/`, and `memories/skills/`, returning the corresponding `Some(MemoriesUsageKind)` or `None` if no known memory path fragment is present.

**Call relations**: This is an internal helper used by `memories_usage_kinds_from_command` after shell parsing has identified a read/search path. It encapsulates the concrete path-to-category mapping.


### `core/src/memory_usage.rs`

`util` · `post-tool execution telemetry emission`

This file is a small telemetry adapter between generic tool invocation records and the `codex_memories_read` usage classifier. The public function `emit_metric_for_tool_read` is called after tool execution completes. It first tries to recover the shell command string from the invocation using `shell_script_for_invocation`; only two unnamespaced function tools are recognized: `shell_command`, whose JSON arguments deserialize as `ShellCommandToolCallParams`, and `exec_command`, whose arguments deserialize as `ExecCommandArgs`. Any other tool namespace/name combination or non-function payload is ignored.

When a command string is available, the function computes a string success tag (`"true"` or `"false"`), flattens the tool name with `flat_tool_name`, and asks `memories_usage_kinds_from_command` to classify the command into one or more memory-usage kinds. For each returned kind it increments the session telemetry counter named `MEMORIES_USAGE_METRIC` by 1, tagging the metric with the usage kind, flattened tool name, and success flag. The implementation is intentionally conservative: malformed JSON arguments, unsupported tools, and non-function payloads simply produce no metric rather than failing the caller.

#### Function details

##### `emit_metric_for_tool_read`  (lines 9–27)

```
fn emit_metric_for_tool_read(invocation: &ToolInvocation, success: bool)
```

**Purpose**: Detects memory-read usage in supported shell-like tool invocations and emits one telemetry counter increment per detected usage kind.

**Data flow**: Reads a `ToolInvocation` and a `success` boolean. It calls `shell_script_for_invocation`; if that returns `None`, it exits early. Otherwise it converts success to `"true"`/`"false"`, flattens `invocation.tool_name`, classifies the command with `memories_usage_kinds_from_command`, and for each kind writes to `invocation.turn.session_telemetry.counter` using `MEMORIES_USAGE_METRIC` and tags `kind`, `tool`, and `success`.

**Call relations**: Invoked by `dispatch_any_with_terminal_outcome` after tool completion. It delegates command extraction to `shell_script_for_invocation` and classification to the memories usage library.

*Call graph*: calls 3 internal fn (shell_script_for_invocation, flat_tool_name, memories_usage_kinds_from_command); called by 1 (dispatch_any_with_terminal_outcome).


##### `shell_script_for_invocation`  (lines 29–46)

```
fn shell_script_for_invocation(invocation: &ToolInvocation) -> Option<String>
```

**Purpose**: Extracts the shell command string from supported tool invocation payloads.

**Data flow**: Reads `invocation.payload`; if it is not `ToolPayload::Function { arguments }`, returns `None`. For unnamespaced tool name `shell_command`, it deserializes `arguments` as `ShellCommandToolCallParams` and returns `params.command` on success. For unnamespaced `exec_command`, it deserializes as `ExecCommandArgs` and returns `params.cmd`. Any namespaced tool, other tool name, or deserialization failure yields `None`.

**Call relations**: Used only by `emit_metric_for_tool_read` as the gate that determines whether telemetry should be emitted at all.

*Call graph*: called by 1 (emit_metric_for_tool_read).


### `memories/write/src/metrics.rs`

`config` · `cross-cutting`

This file is a constants module for observability in the memories write subsystem. It declares a set of `pub(crate)` string constants covering startup and two processing phases. `MEMORY_STARTUP` identifies startup telemetry. Phase one has separate metric names for job count, end-to-end latency in milliseconds, output volume, and token usage. Phase two similarly defines names for job count, end-to-end latency, input volume, and token usage.

The constants are crate-visible rather than fully public, which indicates these identifiers are intended for internal coordination within the memories write crate, not as an external API for other crates. The naming scheme is systematic: all metrics share the `codex.memory` prefix, then a phase-specific suffix such as `phase1.e2e_ms` or `phase2.token_usage`. That consistency is important for dashboards and aggregation queries.

There is no executable behavior, but this file encodes the telemetry vocabulary of the write pipeline. It implicitly documents the pipeline structure as a startup stage followed by at least two measurable phases, each tracking throughput-like counts and resource-consumption metrics. Centralizing these names prevents subtle mismatches between emitters and consumers of telemetry.


### SQLite startup telemetry
These files adapt metrics sinks and classify database initialization outcomes so lightweight SQLite startup and fallback behavior is reported consistently.

### `rollout/src/sqlite_metrics.rs`

`util` · `cross-cutting`

This file is a thin telemetry bridge between `codex_state` and `codex_otel`. Its central type, `OtelDbTelemetry`, stores a `codex_otel::MetricsClient` plus a `'static` originator string that has already been normalized through `bounded_originator_tag_value`. By implementing `codex_state::DbTelemetry`, it lets the SQLite runtime emit counters and duration measurements without depending directly on OTEL-specific APIs.

The implementation is intentionally minimal: both trait methods first call the local `with_originator` helper, which clones the incoming slice of `(&str, &str)` tags into a `Vec` and appends `(ORIGINATOR_TAG, originator)`. They then forward the metric to the underlying client and explicitly ignore the result with `let _ = ...`, making telemetry best-effort rather than able to fail database operations.

The exported constructor, `recorder`, wraps the adapter in an `Arc` and returns the `DbTelemetryHandle` alias expected by `codex_state`. A subtle design choice is that the stored originator is `'static`; the constructor achieves this by passing the caller-provided `&str` through `bounded_originator_tag_value`, so later metric emission does not borrow from transient caller state. The file contains no mutable shared state beyond the owned metrics client and performs no batching or caching.

#### Function details

##### `OtelDbTelemetry::counter`  (lines 15–18)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Emits a database counter metric through the wrapped OTEL client after adding the standard originator tag.

**Data flow**: Reads `self.metrics` and `self.originator`, plus the caller-provided metric `name`, increment `inc`, and tag slice. It builds a new `Vec<(&str, &str)>` via `with_originator`, then forwards that enriched tag set to `MetricsClient::counter`. It returns `()` and does not mutate persistent state; any metrics-client error is discarded.

**Call relations**: This method is invoked by code using the `DbTelemetry` trait on the returned recorder handle. In that path it delegates first to `with_originator` so all DB counters are attributed, then to the OTEL client's counter emission API.

*Call graph*: calls 2 internal fn (counter, with_originator).


##### `OtelDbTelemetry::record_duration`  (lines 20–23)

```
fn record_duration(&self, name: &str, duration: Duration, tags: &[(&str, &str)])
```

**Purpose**: Records a duration-valued database metric through OTEL with the originator tag appended.

**Data flow**: Consumes `name`, a `Duration`, and a borrowed tag slice while reading `self.originator` and `self.metrics`. It clones and extends the tags with `with_originator`, then passes the duration and tags to `MetricsClient::record_duration`. It returns `()` and suppresses any downstream telemetry failure.

**Call relations**: This is the duration-reporting half of the `DbTelemetry` implementation used by the SQLite runtime. It follows the same flow as `counter`: enrich tags locally, then delegate to the OTEL client for actual export.

*Call graph*: calls 2 internal fn (record_duration, with_originator).


##### `recorder`  (lines 26–31)

```
fn recorder(metrics: codex_otel::MetricsClient, originator: &str) -> DbTelemetryHandle
```

**Purpose**: Constructs the shared `DbTelemetryHandle` that exposes OTEL-backed telemetry to the state runtime.

**Data flow**: Takes ownership of a `codex_otel::MetricsClient` and borrows an `originator` string from the caller. It converts the originator into a bounded `'static` value with `bounded_originator_tag_value`, stores both fields in `OtelDbTelemetry`, wraps that struct in `Arc`, and returns it as `DbTelemetryHandle`.

**Call relations**: This helper is called by `sqlite_telemetry_recorder` in `state_db.rs` when higher-level startup code wants to attach telemetry to SQLite operations. It does not emit metrics itself; it prepares the adapter object that later trait calls use.

*Call graph*: called by 1 (sqlite_telemetry_recorder); 2 external calls (new, bounded_originator_tag_value).


##### `with_originator`  (lines 33–40)

```
fn with_originator(
    tags: &[(&'a str, &'a str)],
    originator: &'static str,
) -> Vec<(&'a str, &'a str)>
```

**Purpose**: Creates a new tag vector from an existing slice and appends the standard OTEL originator tag pair.

**Data flow**: Accepts a borrowed slice of tag tuples and a `'static` originator string. It clones the slice into a mutable `Vec`, pushes `(ORIGINATOR_TAG, originator)`, and returns the resulting vector. It does not read or write any external state.

**Call relations**: This helper sits directly underneath both `OtelDbTelemetry::counter` and `OtelDbTelemetry::record_duration`. Its sole role in the call flow is to centralize tag augmentation so both metric paths behave identically.

*Call graph*: called by 2 (counter, record_duration).


### `state/src/telemetry.rs`

`util` · `startup and fallback instrumentation across database initialization paths`

This module defines a small abstraction, `DbTelemetry`, for emitting counters and duration metrics about SQLite startup and fallback paths without coupling database behavior to any particular telemetry backend. A process-global sink can be installed once through `install_process_db_telemetry`, stored in a `OnceLock<Arc<dyn DbTelemetry>>`; low-level database code may also pass an explicit sink override. The exported helpers `record_init_result`, `record_backfill_gate`, and `record_fallback` build low-cardinality tag sets around metric names such as `DB_INIT_METRIC`, `DB_INIT_DURATION_METRIC`, and `DB_FALLBACK_METRIC`.

The module’s main logic is error classification. `DbKind` maps the database being initialized (`State`, `Logs`, `Goals`, `Memories`) to a stable tag string. `DbOutcomeTags::from_result` turns an `anyhow::Result` into `status=success|failed` plus an `error` tag. `classify_error` walks the full `anyhow` cause chain and recognizes `sqlx::Error`, migration errors, serde failures, and I/O failures. SQLx database errors are further reduced by `classify_sqlx_error`, which extracts SQLite result codes and passes them to `classify_sqlite_code`; extended SQLite codes are masked down to their primary low byte so tags like `busy`, `locked`, `corrupt`, `cantopen`, and `constraint` remain stable. If no sink is available, metric emission is silently skipped by design.

#### Function details

##### `install_process_db_telemetry`  (lines 29–36)

```
fn install_process_db_telemetry(telemetry: DbTelemetryHandle) -> bool
```

**Purpose**: Installs the process-wide default telemetry sink used by low-level database code when no explicit sink is supplied. Only the first installation wins.

**Data flow**: It takes an `Arc<dyn DbTelemetry>`, attempts to store it in `PROCESS_DB_TELEMETRY`, and returns `true` on first install or `false` if a sink was already present. On duplicate installation it emits a debug log and leaves the original sink unchanged.

**Call relations**: Startup code calls this once after telemetry initialization. Later metric helpers rely on `resolve_telemetry` to read the installed sink when callers do not pass an override.

*Call graph*: 1 external calls (debug!).


##### `DbKind::as_str`  (lines 47–54)

```
fn as_str(self) -> &'static str
```

**Purpose**: Maps the internal database kind enum to the stable string tag used in metrics. This keeps metric cardinality fixed and explicit.

**Data flow**: It takes `self` by value and returns one of the static strings `state`, `logs`, `goals`, or `memories`. No external state is read or written.

**Call relations**: Only `record_init_result` calls this helper when assembling the `db` metric tag.

*Call graph*: called by 1 (record_init_result).


##### `record_init_result`  (lines 57–73)

```
fn record_init_result(
    telemetry: Option<&dyn DbTelemetry>,
    db: DbKind,
    phase: &'static str,
    duration: Duration,
    result: &anyhow::Result<T>,
)
```

**Purpose**: Emits both a counter and a duration metric for a database initialization phase, tagged with database kind and classified outcome. It is the main telemetry entrypoint for startup/open paths.

**Data flow**: Inputs are an optional telemetry sink, `DbKind`, phase string, elapsed `Duration`, and a borrowed `anyhow::Result<T>`. The function derives `DbOutcomeTags` from the result, builds a four-tag array (`status`, `phase`, `db`, `error`), then calls `record_counter` and `record_duration` with the configured metric names.

**Call relations**: Initialization code such as `init_inner` and `open_sqlite` calls this after each startup phase, and `record_backfill_gate` delegates to it for the state DB backfill gate phase.

*Call graph*: calls 4 internal fn (as_str, from_result, record_counter, record_duration); called by 3 (init_inner, open_sqlite, record_backfill_gate).


##### `record_backfill_gate`  (lines 75–81)

```
fn record_backfill_gate(
    telemetry: Option<&dyn DbTelemetry>,
    duration: Duration,
    result: &anyhow::Result<()>,
)
```

**Purpose**: Specialized wrapper that records telemetry for the state database backfill gate phase. It standardizes the phase and database tags for that event.

**Data flow**: It takes an optional telemetry sink, a duration, and a `Result<()>`, then forwards them to `record_init_result` with `DbKind::State` and phase `backfill_gate`.

**Call relations**: Callers use this instead of constructing the tags manually for backfill gating. It is a thin convenience layer over `record_init_result`.

*Call graph*: calls 1 internal fn (record_init_result).


##### `record_fallback`  (lines 83–93)

```
fn record_fallback(
    caller: &'static str,
    reason: &'static str,
    telemetry_override: Option<&dyn DbTelemetry>,
)
```

**Purpose**: Emits a fallback counter tagged by caller and reason. It is used when code abandons a preferred database path and switches to a fallback behavior.

**Data flow**: Inputs are static `caller` and `reason` strings plus an optional telemetry override. The function builds a two-tag slice and passes it to `record_counter` with `DB_FALLBACK_METRIC`.

**Call relations**: Fallback-capable code paths call this helper directly. It shares the same sink-resolution behavior as initialization metrics through `record_counter`.

*Call graph*: calls 1 internal fn (record_counter).


##### `record_counter`  (lines 95–99)

```
fn record_counter(telemetry: Option<&dyn DbTelemetry>, name: &str, tags: &[(&str, &str)])
```

**Purpose**: Internal helper that emits a single incrementing counter if a telemetry sink is available. Missing telemetry is treated as a no-op.

**Data flow**: It takes an optional sink, metric name, and tag slice, resolves the effective sink with `resolve_telemetry`, and if present calls `telemetry.counter(name, 1, tags)`. It returns no value and writes only to the telemetry sink.

**Call relations**: Both `record_init_result` and `record_fallback` delegate counter emission here so sink resolution and no-op behavior are centralized.

*Call graph*: calls 1 internal fn (resolve_telemetry); called by 2 (record_fallback, record_init_result).


##### `record_duration`  (lines 101–110)

```
fn record_duration(
    telemetry: Option<&dyn DbTelemetry>,
    name: &str,
    duration: Duration,
    tags: &[(&str, &str)],
)
```

**Purpose**: Internal helper that records a duration metric if a telemetry sink is available. Like counters, missing telemetry is silently ignored.

**Data flow**: It accepts an optional sink, metric name, `Duration`, and tags, resolves the sink via `resolve_telemetry`, and if present calls `telemetry.record_duration(name, duration, tags)`.

**Call relations**: Only `record_init_result` uses this helper, pairing it with `record_counter` for each initialization outcome.

*Call graph*: calls 1 internal fn (resolve_telemetry); called by 1 (record_init_result).


##### `resolve_telemetry`  (lines 112–114)

```
fn resolve_telemetry(telemetry: Option<&dyn DbTelemetry>) -> Option<&dyn DbTelemetry>
```

**Purpose**: Chooses the telemetry sink to use for an emission attempt. An explicit override wins; otherwise the process-wide installed sink is used if present.

**Data flow**: It takes `Option<&dyn DbTelemetry>` and returns either that same reference or, if absent, a borrowed reference to the sink stored in `PROCESS_DB_TELEMETRY`. If neither exists it returns `None`.

**Call relations**: Both `record_counter` and `record_duration` call this helper before attempting emission, making it the single sink-selection point in the module.

*Call graph*: called by 2 (record_counter, record_duration).


##### `DbOutcomeTags::from_result`  (lines 122–133)

```
fn from_result(result: &anyhow::Result<T>) -> Self
```

**Purpose**: Converts a generic `anyhow::Result` into the low-cardinality `status` and `error` tags used by initialization metrics. Successful results always map to `success/none`.

**Data flow**: It borrows a `Result<T>`, pattern matches on `Ok` versus `Err`, and returns a `DbOutcomeTags` struct. On errors it calls `classify_error` to derive the stable `error` tag.

**Call relations**: `record_init_result` uses this helper before assembling metric tags, so all initialization telemetry shares the same success/failure classification rules.

*Call graph*: calls 1 internal fn (classify_error); called by 1 (record_init_result).


##### `classify_error`  (lines 136–155)

```
fn classify_error(err: &anyhow::Error) -> &'static str
```

**Purpose**: Walks an `anyhow::Error` chain and reduces it to a stable telemetry category such as `migration`, `serde`, `io`, or a SQLite-derived class. It prefers more specific inner causes when present.

**Data flow**: It iterates `err.chain()`, checking each cause for `sqlx::Error`, `sqlx::migrate::MigrateError`, `serde_json::Error`, or `std::io::Error`. On the first recognized cause it returns the corresponding static tag, delegating SQLx errors to `classify_sqlx_error`; if nothing matches it returns `unknown`.

**Call relations**: Only `DbOutcomeTags::from_result` calls this helper. It is the top-level classifier that bridges rich error chains into low-cardinality telemetry tags.

*Call graph*: calls 1 internal fn (classify_sqlx_error); called by 1 (from_result); 1 external calls (chain).


##### `classify_sqlx_error`  (lines 157–172)

```
fn classify_sqlx_error(err: &sqlx::Error) -> &'static str
```

**Purpose**: Classifies a `sqlx::Error` into a stable telemetry tag, with special handling for SQLite database result codes and serde decode failures. It distinguishes pool timeout and I/O from generic unknown SQLx failures.

**Data flow**: It pattern matches on the `sqlx::Error` variant. For `Database`, it extracts the optional database code, defaults to borrowed `"none"`, converts it to a string, and passes it to `classify_sqlite_code`; for `PoolTimedOut`, `Io`, and serde-backed decode variants it returns fixed tags; otherwise it returns `unknown`.

**Call relations**: `classify_error` delegates SQLx-specific classification here. This helper is where SQLite result-code interpretation is separated from broader SQLx transport and decoding failures.

*Call graph*: calls 1 internal fn (classify_sqlite_code); called by 1 (classify_error); 1 external calls (Borrowed).


##### `classify_sqlite_code`  (lines 174–190)

```
fn classify_sqlite_code(code: &str) -> &'static str
```

**Purpose**: Maps a SQLite result code string to a stable primary-category telemetry tag. Extended result codes are reduced to their primary low-byte code before classification.

**Data flow**: It parses the input string as `i32`, masks the parsed value with `0xff` to obtain the primary SQLite code, and matches that code to tags like `busy`, `locked`, `readonly`, `io`, `corrupt`, `full`, `cantopen`, `schema`, and `constraint`. Unparseable or unmapped codes return `unknown`.

**Call relations**: This is the final step in SQLx database-error classification, called only by `classify_sqlx_error`. The included test locks in the extended-code masking behavior.

*Call graph*: called by 1 (classify_sqlx_error).


##### `tests::classifies_extended_sqlite_codes`  (lines 198–202)

```
fn classifies_extended_sqlite_codes()
```

**Purpose**: Regression test for SQLite code classification, especially the handling of extended result codes. It ensures the low-byte masking logic maps extended codes to their primary category.

**Data flow**: The test passes fixed code strings into `classify_sqlite_code` and asserts the returned tags for `5`, `6`, and extended code `2067`. No external state is involved.

**Call relations**: This synchronous unit test is run by the test harness and directly validates the helper used by SQLx error telemetry classification.

*Call graph*: 1 external calls (assert_eq!).
