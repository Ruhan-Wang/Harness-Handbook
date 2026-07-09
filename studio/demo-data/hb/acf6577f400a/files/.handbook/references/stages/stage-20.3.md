# Session telemetry and feature-specific instrumentation  `stage-20.3`

This stage is behind-the-scenes instrumentation for a running session. It does not make the assistant smarter by itself. Instead, it acts like a dashboard and trip recorder, noting what happened, how long it took, and where problems appeared.

The central session telemetry file records session events, results, durations, and safe context. Turn timing adds finer stopwatch data for each assistant reply, such as time to first output and time spent waiting on tools. App-server tracing wraps incoming requests in trace spans, which are linked log sections that let one request be followed across the system. Tool dispatch tracing records tool calls without cluttering the tool runner itself.

Several files add safe labels and counters for specific features. Auth environment telemetry notes which login settings exist without recording secrets. Sandbox tags summarize permission mode. Guardian, cloud-config, goals, and memories files count feature activity and outcomes using stable metric names and labels. Memory usage code detects when commands read memory-related files. Finally, SQLite telemetry records database startup, fallback behavior, counts, and timings, including lightweight metrics for rollout and state startup.

## Files in this stage

### Session telemetry foundation
These files establish the shared session-scoped telemetry surface and the core timing and environment context that other instrumentation builds on.

### `login/src/auth_env_telemetry.rs`

`domain_logic` · `startup/auth setup and telemetry collection`

Authentication often depends on environment variables, which are named settings supplied outside the program, such as API keys. This file acts like a privacy-safe checklist. It asks, “Is an OpenAI API key set?”, “Is a Codex API key set?”, “Did this provider have its own configured key?”, and “Was a refresh-token URL override supplied?” It deliberately stores only yes/no answers, not the actual secrets.

The central type, AuthEnvTelemetry, is a small record of those answers. collect_auth_env_telemetry fills in that record by looking at the current process environment and at the selected model provider’s configuration. One important safety detail is that the provider’s environment key name is not copied into telemetry. If a provider key exists, the file records only the word “configured,” avoiding accidental leakage of a sensitive or user-specific string.

env_var_present is the small helper that decides whether an environment variable counts as present. Empty or whitespace-only values do not count. Values that exist but are not valid text still count as present, because the important telemetry question is whether something was supplied.

Finally, to_otel_metadata converts the local record into the format expected by the telemetry system, OpenTelemetry, which is a common way to collect diagnostic signals from software.

#### Function details

##### `AuthEnvTelemetry::to_otel_metadata`  (lines 19–28)

```
fn to_otel_metadata(&self) -> AuthEnvTelemetryMetadata
```

**Purpose**: This converts the file’s internal authentication-environment summary into the telemetry format used by the wider observability system. It is used when the program is ready to report these safe yes/no details outside this module.

**Data flow**: It starts with an AuthEnvTelemetry value containing booleans and optional provider-key information. It copies those fields into a new AuthEnvTelemetryMetadata value, cloning the optional provider key label so the original record is unchanged. The output is a telemetry-ready metadata object with the same safe summary information.

**Call relations**: After collect_auth_env_telemetry has built the local summary, this method is the bridge to the OpenTelemetry-facing type. It does not gather new data itself; it simply repackages what was already collected so another part of the system can attach it to telemetry.


##### `collect_auth_env_telemetry`  (lines 31–43)

```
fn collect_auth_env_telemetry(
    provider: &ModelProviderInfo,
    codex_api_key_env_enabled: bool,
) -> AuthEnvTelemetry
```

**Purpose**: This builds a privacy-safe snapshot of the authentication environment. It checks whether expected API-key and override environment variables are set, and it records whether provider-specific key configuration exists without revealing the actual key name or value.

**Data flow**: It receives a model provider description and a flag saying whether the Codex API key environment path is enabled. It reads several environment variables through env_var_present, looks at whether the provider has an env_key configured, replaces that provider key name with the safe label "configured," and returns an AuthEnvTelemetry record. It changes no environment variables; it only observes them.

**Call relations**: This is the main collection point for this file. It is called when authentication setup is being created, including flows represented by new and new_with_provider, and it is also called by the test in this file. During its work it delegates each environment-variable check to env_var_present so the meaning of “present” stays consistent.

*Call graph*: calls 1 internal fn (env_var_present); called by 3 (new, collect_auth_env_telemetry_buckets_provider_env_key_name, new_with_provider).


##### `env_var_present`  (lines 45–51)

```
fn env_var_present(name: &str) -> bool
```

**Purpose**: This answers the simple question: does this environment variable really have a usable value? It treats missing variables and blank text as absent, while treating non-text values as present because something was supplied.

**Data flow**: It receives the name of an environment variable. It asks the operating system for that variable’s value. If the value exists and is not just whitespace, it returns true; if it is missing, it returns false; if it exists but cannot be read as normal text, it still returns true.

**Call relations**: collect_auth_env_telemetry calls this helper for every environment setting it wants to summarize. The helper wraps the standard environment lookup in one consistent rule, so callers do not have to repeat the same edge-case decisions.

*Call graph*: called by 1 (collect_auth_env_telemetry); 1 external calls (var).


##### `tests::collect_auth_env_telemetry_buckets_provider_env_key_name`  (lines 60–88)

```
fn collect_auth_env_telemetry_buckets_provider_env_key_name()
```

**Purpose**: This test checks that provider-specific key information is not leaked into telemetry. It proves that when a provider has an env_key value, telemetry records only the safe label "configured" rather than the actual string.

**Data flow**: It creates a sample model provider whose env_key contains a secret-looking value. It passes that provider into collect_auth_env_telemetry with Codex API-key environment support disabled. It then compares the resulting provider_env_key_name field with the expected safe value, Some("configured").

**Call relations**: This test directly exercises collect_auth_env_telemetry. Its role is to guard the privacy behavior described above, so future changes do not accidentally start copying sensitive provider key text into telemetry.

*Call graph*: calls 1 internal fn (collect_auth_env_telemetry); 1 external calls (assert_eq!).


### `otel/src/events/session_telemetry.rs`

`domain_logic` · `cross-cutting`

A Codex session talks to APIs, streams server events, opens WebSockets, runs tools, asks for approvals, and processes user prompts. This file gives all of those moments a common way to be written down as logs, traces, and metrics. Logs are event records, traces are timeline breadcrumbs inside a larger operation, and metrics are numbers that can be graphed, such as counts and durations.

The central type is SessionTelemetry. It carries session metadata, such as conversation id, model, app version, authentication environment, and whether user prompts may be logged. Most public methods describe one real-world event: an API request completed, a WebSocket event arrived, a tool finished, a plugin suggestion was shown, or startup passed a phase. The methods usually do two things: update counters or timing measurements, then emit a structured event.

A useful analogy is a flight recorder. The application keeps flying normally, but this file writes down speed, route, warnings, and unusual events. If metrics are disabled or fail, the code warns instead of crashing the session. It also adds common session tags to metrics so production dashboards can group results by model, source, auth mode, and version.

#### Function details

##### `trace_field_value`  (lines 69–73)

```
fn trace_field_value(fields: &'a [(&str, &str)], key: &str) -> Option<&'a str>
```

**Purpose**: Looks up one named field inside a small list of trace fields. It is used when tool telemetry needs optional details such as which MCP server a tool came from.

**Data flow**: It receives a list of key-value text pairs and a key to search for. It scans the list and returns the matching value if it finds one; otherwise it returns nothing.

**Call relations**: When SessionTelemetry::tool_result_with_tags records a tool result, it calls this helper to pull out special trace fields before writing the log and trace event.

*Call graph*: called by 1 (tool_result_with_tags).


##### `SessionTelemetry::with_auth_env`  (lines 110–113)

```
fn with_auth_env(mut self, auth_env: AuthEnvTelemetryMetadata) -> Self
```

**Purpose**: Adds authentication environment details to an existing telemetry object. This lets later events say whether relevant API key environment variables were present.

**Data flow**: It receives a SessionTelemetry value and an AuthEnvTelemetryMetadata value. It replaces the stored auth environment metadata and returns the updated telemetry value.

**Call relations**: This is a setup-time builder method. Code that creates session telemetry can call it before events are recorded so later API and conversation events include auth environment context.


##### `SessionTelemetry::with_model`  (lines 115–119)

```
fn with_model(mut self, model: &str, slug: &str) -> Self
```

**Purpose**: Updates the model name and model slug attached to telemetry. This matters when configuration overrides the model after the telemetry object was first created.

**Data flow**: It receives model and slug strings. It copies them into the session metadata and returns the updated telemetry value.

**Call relations**: This is part of the setup path for tailoring session metadata before recording metrics and events. Later metric tags and logs read these stored model fields.


##### `SessionTelemetry::with_metrics_service_name`  (lines 121–124)

```
fn with_metrics_service_name(mut self, service_name: &str) -> Self
```

**Purpose**: Sets the service name used as a metric tag. The value is cleaned first so it is safe for metric systems that restrict tag characters.

**Data flow**: It receives a service name string, sanitizes it, stores it in metadata, and returns the updated telemetry value.

**Call relations**: This builder method uses sanitize_metric_tag_value before metadata is used by SessionTelemetry::metadata_tag_refs to attach standard tags to metrics.

*Call graph*: 1 external calls (sanitize_metric_tag_value).


##### `SessionTelemetry::with_metrics`  (lines 126–130)

```
fn with_metrics(mut self, metrics: MetricsClient) -> Self
```

**Purpose**: Attaches a metrics client to the telemetry object and enables normal session metadata tags. This turns metric recording on for this session.

**Data flow**: It receives a MetricsClient, stores it, sets the flag that says metadata tags should be included, and returns the updated telemetry value.

**Call relations**: SessionTelemetry::with_metrics_config and SessionTelemetry::with_provider_metrics both delegate here after obtaining a metrics client.

*Call graph*: called by 2 (with_metrics_config, with_provider_metrics).


##### `SessionTelemetry::with_metrics_without_metadata_tags`  (lines 132–136)

```
fn with_metrics_without_metadata_tags(mut self, metrics: MetricsClient) -> Self
```

**Purpose**: Attaches a metrics client but chooses not to add the usual session metadata tags. This is useful when callers want raw or test metrics without labels like model or auth mode.

**Data flow**: It receives a MetricsClient, stores it, turns off metadata tag merging, and returns the updated telemetry value.

**Call relations**: This is an alternate setup path to SessionTelemetry::with_metrics. Later metric methods still record values, but SessionTelemetry::metadata_tag_refs returns no common tags.


##### `SessionTelemetry::with_metrics_config`  (lines 138–141)

```
fn with_metrics_config(self, config: MetricsConfig) -> MetricsResult<Self>
```

**Purpose**: Builds a metrics client from configuration and attaches it to the session. It gives callers a one-step way to enable metrics from settings.

**Data flow**: It receives a MetricsConfig. It tries to create a MetricsClient; if that works, it returns the telemetry object with metrics attached, and if not, it returns the metrics error.

**Call relations**: After creating the client, it hands off to SessionTelemetry::with_metrics so the normal metrics setup path is reused.

*Call graph*: calls 2 internal fn (with_metrics, new).


##### `SessionTelemetry::with_provider_metrics`  (lines 143–148)

```
fn with_provider_metrics(self, provider: &OtelProvider) -> Self
```

**Purpose**: Copies a metrics client from an OpenTelemetry provider if that provider has one. This lets session telemetry share the provider's metric pipeline.

**Data flow**: It receives an OtelProvider. If the provider exposes a metrics client, it clones and attaches it; otherwise it leaves the telemetry object unchanged.

**Call relations**: It asks the provider for metrics and, when present, delegates to SessionTelemetry::with_metrics. This keeps provider-based setup consistent with direct setup.

*Call graph*: calls 2 internal fn (with_metrics, metrics).


##### `SessionTelemetry::counter`  (lines 150–163)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Adds to a named count metric, such as number of API calls or tool calls. It quietly skips work when metrics are disabled and warns if the metric system rejects the write.

**Data flow**: It receives a metric name, an increment amount, and tags. It merges in session metadata tags, sends the count to the metrics client, and produces no return value.

**Call relations**: Many higher-level event methods call this when something countable happens. Other parts of the project also call it directly for subsystem-specific metrics.

*Call graph*: called by 17 (force_http_fallback, emit_guardian_review_metrics, emit_compact_metric, emit_turn_memory_metric, emit_turn_network_proxy_metric, emit_unified_exec_tty_metric, emit_metrics, counter, counter, record_api_request (+7 more)); 1 external calls (warn!).


##### `SessionTelemetry::histogram`  (lines 165–178)

```
fn histogram(&self, name: &str, value: i64, tags: &[(&str, &str)])
```

**Purpose**: Records a numeric value in a histogram, which is a metric that shows distribution rather than just a total. This is useful for values like token counts.

**Data flow**: It receives a metric name, a number, and tags. If metrics are enabled, it adds metadata tags and sends the value to the metrics client; on failure it logs a warning.

**Call relations**: Subsystem metric emitters call this for value distributions. It follows the same safe pattern as SessionTelemetry::counter: telemetry failure should not break the app.

*Call graph*: called by 3 (emit_guardian_token_usage_histograms, histogram, histogram); 1 external calls (warn!).


##### `SessionTelemetry::record_duration`  (lines 180–193)

```
fn record_duration(&self, name: &str, duration: Duration, tags: &[(&str, &str)])
```

**Purpose**: Records how long something took. It is the common timing helper used for API calls, WebSocket events, startup phases, and response engine timings.

**Data flow**: It receives a metric name, a Duration, and tags. It adds session metadata tags, sends the timing measurement to the metrics client, and warns if recording fails.

**Call relations**: Higher-level methods such as SessionTelemetry::record_api_request, SessionTelemetry::record_websocket_event, and SessionTelemetry::record_startup_phase call this whenever they need a duration metric.

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

**Purpose**: Records the duration of one named startup phase. This helps production teams see which part of startup is slow or failing.

**Data flow**: It receives a phase name, elapsed time, and optional status. It records a duration metric tagged with that phase and status, then writes a structured log and trace event.

**Call relations**: Startup resolving code calls this as phases complete. Internally it uses SessionTelemetry::record_duration and the shared log-and-trace event macro.

*Call graph*: calls 1 internal fn (record_duration); called by 1 (resolve); 2 external calls (log_and_trace_event!, vec!).


##### `SessionTelemetry::record_turn_ttft`  (lines 221–232)

```
fn record_turn_ttft(&self, duration: Duration)
```

**Purpose**: Records time to first token for a model turn. Time to first token means how long the user waits before the first piece of output appears.

**Data flow**: It receives a duration. It records that duration as a metric and emits a telemetry event with the duration in milliseconds.

**Call relations**: This is called by turn-processing code when the first response token arrives. It reuses SessionTelemetry::record_duration and the standard log-and-trace path.

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

**Purpose**: Records that Codex asked the user about installing a plugin or connector. This helps measure how often install prompts are shown.

**Data flow**: It receives the tool type, id, and display name. It increments a metric tagged by tool type and logs/traces the prompt details.

**Call relations**: Plugin installation flows call this at the moment an install elicitation is dispatched. It uses SessionTelemetry::counter for the metric and then emits the event.

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

**Purpose**: Records what happened after a plugin or connector install suggestion was shown. It captures whether the user confirmed and whether the process completed.

**Data flow**: It receives tool identity, the response action, and two booleans for user confirmation and completion. It converts completion into a metric tag, increments the suggestion metric, and writes a structured event.

**Call relations**: Plugin suggestion flows call this after the user or system responds. It builds on SessionTelemetry::counter and the shared log-and-trace macro.

*Call graph*: calls 1 internal fn (counter); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::start_timer`  (lines 295–301)

```
fn start_timer(&self, name: &str, tags: &[(&str, &str)]) -> Result<Timer, MetricsError>
```

**Purpose**: Starts a metric timer that can later record elapsed time. This is useful when the caller wants a stopwatch-like object instead of manually measuring duration.

**Data flow**: It receives a metric name and tags. If metrics are enabled, it adds metadata tags and asks the metrics client to create a Timer; if metrics are disabled, it returns an error.

**Call relations**: Other timer wrappers call this when they need a session-aware timer. It relies on SessionTelemetry::tags_with_metadata before handing off to the metrics client.

*Call graph*: calls 1 internal fn (tags_with_metadata); called by 2 (start_timer, start_timer).


##### `SessionTelemetry::shutdown_metrics`  (lines 303–308)

```
fn shutdown_metrics(&self) -> MetricsResult<()>
```

**Purpose**: Flushes and shuts down the metrics client if one is attached. This helps make sure buffered metric data is sent before the process exits.

**Data flow**: It reads the optional metrics client. If no client exists it succeeds immediately; otherwise it calls the client's shutdown operation and returns that result.

**Call relations**: Teardown code can call this near the end of a run. It is intentionally harmless when metrics were never enabled.


##### `SessionTelemetry::snapshot_metrics`  (lines 310–315)

```
fn snapshot_metrics(&self) -> MetricsResult<ResourceMetrics>
```

**Purpose**: Collects the current metrics snapshot. A snapshot is a point-in-time copy of accumulated metric data.

**Data flow**: It checks whether a metrics client exists. If yes, it asks for a ResourceMetrics snapshot; if not, it returns an exporter-disabled error.

**Call relations**: SessionTelemetry::reset_runtime_metrics and SessionTelemetry::runtime_metrics_summary both call this to inspect or clear accumulated runtime metrics.

*Call graph*: called by 2 (reset_runtime_metrics, runtime_metrics_summary).


##### `SessionTelemetry::reset_runtime_metrics`  (lines 318–325)

```
fn reset_runtime_metrics(&self)
```

**Purpose**: Takes and discards a runtime metrics snapshot so delta-style counters reset. This is like emptying a measuring cup before the next measurement period.

**Data flow**: It first checks whether metrics exist. If they do, it calls SessionTelemetry::snapshot_metrics and ignores the data; if snapshotting fails, it writes a debug message.

**Call relations**: Debug or runtime-monitoring code can call this before measuring a new interval. It depends on SessionTelemetry::snapshot_metrics for the actual collection.

*Call graph*: calls 1 internal fn (snapshot_metrics); 1 external calls (debug!).


##### `SessionTelemetry::runtime_metrics_summary`  (lines 328–341)

```
fn runtime_metrics_summary(&self) -> Option<RuntimeMetricsSummary>
```

**Purpose**: Builds a small human-readable summary of runtime metrics when snapshots are available. It returns nothing if metrics are disabled or the snapshot has no useful data.

**Data flow**: It asks for a metrics snapshot. If successful, it converts the snapshot into RuntimeMetricsSummary and returns it only when the summary is not empty.

**Call relations**: Runtime diagnostics call this to show recent metric information. It uses SessionTelemetry::snapshot_metrics and RuntimeMetricsSummary::from_snapshot.

*Call graph*: calls 2 internal fn (snapshot_metrics, from_snapshot).


##### `SessionTelemetry::tags_with_metadata`  (lines 343–350)

```
fn tags_with_metadata(
        &'a self,
        tags: &'a [(&'a str, &'a str)],
    ) -> MetricsResult<Vec<(&'a str, &'a str)>>
```

**Purpose**: Combines caller-provided metric tags with the standard session tags. This keeps dashboards consistently labeled without every caller repeating the same metadata.

**Data flow**: It receives a slice of tags. It first gets metadata tags, appends the caller's tags, and returns the merged list.

**Call relations**: SessionTelemetry::start_timer uses this helper before creating timers. The counter, histogram, and duration methods follow the same merging pattern internally.

*Call graph*: calls 1 internal fn (metadata_tag_refs); called by 1 (start_timer).


##### `SessionTelemetry::metadata_tag_refs`  (lines 352–365)

```
fn metadata_tag_refs(&self) -> MetricsResult<Vec<(&str, &str)>>
```

**Purpose**: Builds the standard metric tags from session metadata, such as auth mode, source, originator, service name, model, and app version.

**Data flow**: It checks whether metadata tags are enabled. If not, it returns an empty list; otherwise it reads fields from metadata and converts them into metric tag pairs.

**Call relations**: SessionTelemetry::tags_with_metadata calls this whenever it needs the common session labels. The values are prepared using SessionMetricTagValues.

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

**Purpose**: Creates the base telemetry object for a session. It captures the identifying and configuration details that later events will reuse.

**Data flow**: It receives conversation id, model, account details, authentication mode, originator, prompt-logging preference, terminal type, and session source. It sanitizes metric-sensitive text, fills metadata, attaches any global metrics client, and returns SessionTelemetry.

**Call relations**: Session setup and tests call this as the starting point. Later builder methods can adjust auth environment, model, or metrics before the object is used across the run.

*Call graph*: calls 1 internal fn (global); called by 25 (test_session_telemetry, test_session_telemetry, new, session_telemetry, test_session_telemetry_without_metadata, test_session_telemetry, responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids (+15 more)); 4 external calls (to_string, sanitize_metric_tag_value, env!, default).


##### `SessionTelemetry::record_responses`  (lines 401–436)

```
fn record_responses(&self, handle_responses_span: &Span, event: &ResponseEvent)
```

**Purpose**: Adds details from a Responses API event to an existing trace span. A span is a timed trace section that can hold fields for later debugging.

**Data flow**: It receives a tracing Span and a ResponseEvent. It records the event type, tool names for function-call items, and token usage for completed responses when available.

**Call relations**: Response-processing code calls this while handling streamed response events. It uses SessionTelemetry::responses_type to turn the event into a readable category.

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

**Purpose**: Records the start of a conversation with key setup choices. This gives later investigations context about model provider, reasoning settings, sandbox policy, and auth environment.

**Data flow**: It receives provider and configuration details plus the MCP server names. It writes one structured event, logging server names while tracing only the count.

**Call relations**: Conversation startup code calls this once the session parameters are known. It uses the shared log-and-trace macro to send the same event to both observability channels.

*Call graph*: 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::log_request`  (lines 477–508)

```
async fn log_request(&self, attempt: u64, f: F) -> Result<Response, Error>
```

**Purpose**: Wraps an HTTP request so the request duration and outcome are recorded automatically. It is a convenience helper for simple request paths.

**Data flow**: It receives an attempt number and an async function that performs the request. It measures elapsed time, extracts status or error text, records the API request telemetry, and returns the original response result unchanged.

**Call relations**: Request code can call this around a reqwest request. It delegates the actual telemetry formatting to SessionTelemetry::record_api_request.

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

**Purpose**: Records the result of an HTTP API call. It captures success, status code, duration, retry/auth recovery details, endpoint, request identifiers, and auth errors.

**Data flow**: It receives request outcome details. It decides whether the call succeeded, increments the API call count, records the duration, and emits a structured event with both network and auth context.

**Call relations**: HTTP hooks and SessionTelemetry::log_request call this after requests finish. It uses SessionTelemetry::counter and SessionTelemetry::record_duration before emitting the log and trace event.

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

**Purpose**: Records an attempt to open a WebSocket connection. A WebSocket is a long-lived connection used to exchange messages with the server.

**Data flow**: It receives duration, optional status and error, auth/recovery details, endpoint, reuse flag, and request identifiers. It calculates success and writes one structured event.

**Call relations**: The WebSocket connection code calls this after connect attempts. Unlike per-message events, this method focuses on the connection handshake and authentication context.

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

**Purpose**: Records a request sent over an existing WebSocket connection. It measures whether the send/request step succeeded and how long it took.

**Data flow**: It receives duration, optional error text, and whether the connection was reused. It increments a request count, records request duration, and logs/traces the result with auth environment context.

**Call relations**: WebSocket request hooks call this after sending work over the socket. It uses SessionTelemetry::counter and SessionTelemetry::record_duration for metrics.

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

**Purpose**: Records a step in authentication recovery, such as retrying after an unauthorized response. This helps diagnose sign-in and token-refresh problems.

**Data flow**: It receives the recovery mode, step, outcome, optional request ids, server error details, reason, and whether auth state changed. It emits those fields as one structured event.

**Call relations**: Unauthorized-response handling calls this during recovery. It does not update counters; it focuses on making the recovery story visible in logs and traces.

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

**Purpose**: Records one event received from a WebSocket stream. It classifies the event, detects failures, and records timing metrics.

**Data flow**: It receives a nested result representing a possible WebSocket message or API error, plus duration. It parses text messages as JSON, extracts the event type, treats failures and unexpected messages as unsuccessful, records count and duration metrics, and logs/traces the outcome.

**Call relations**: WebSocket event hooks call this for each received event. If it sees a special response timing event, it calls SessionTelemetry::record_responses_websocket_timing_metrics before recording the general WebSocket event.

*Call graph*: calls 3 internal fn (counter, record_duration, record_responses_websocket_timing_metrics); called by 1 (on_ws_event); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::log_sse_event`  (lines 792–841)

```
fn log_sse_event(
        &self,
        response: &Result<Option<Result<StreamEvent, StreamError<E>>>, Elapsed>,
        duration: Duration,
    )
```

**Purpose**: Records one Server-Sent Events poll result. Server-Sent Events, or SSE, are a streaming HTTP format where the server sends named events over time.

**Data flow**: It receives a poll result and duration. It distinguishes successful events, response failures, parse errors, stream errors, end-of-stream, and idle timeout, then routes to the success or failure helper.

**Call relations**: SSE polling code calls this after each poll. It delegates successful events to SessionTelemetry::sse_event and failures to SessionTelemetry::sse_event_failed.

*Call graph*: calls 2 internal fn (sse_event, sse_event_failed); called by 1 (on_sse_poll).


##### `SessionTelemetry::sse_event`  (lines 843–860)

```
fn sse_event(&self, kind: &str, duration: Duration)
```

**Purpose**: Records a successful SSE event. It counts the event, records how long the poll took, and writes a log entry.

**Data flow**: It receives an event kind and duration. It records success-tagged count and duration metrics, then logs the event name, kind, and elapsed milliseconds.

**Call relations**: SessionTelemetry::log_sse_event calls this when a streamed SSE message parses successfully or marks normal completion.

*Call graph*: calls 2 internal fn (counter, record_duration); called by 1 (log_sse_event); 1 external calls (log_event!).


##### `SessionTelemetry::sse_event_failed`  (lines 862–899)

```
fn sse_event_failed(&self, kind: Option<&String>, duration: Duration, error: &T)
```

**Purpose**: Records a failed SSE event or failed SSE poll. It captures the kind when known and includes an error message.

**Data flow**: It receives an optional event kind, duration, and displayable error. It substitutes "unknown" when the kind is missing, records failure-tagged metrics, logs the error, and emits a trace event.

**Call relations**: SessionTelemetry::log_sse_event calls this for parse errors, stream errors, response.failed events, and idle timeouts.

*Call graph*: calls 2 internal fn (counter, record_duration); called by 1 (log_sse_event); 2 external calls (log_event!, trace_event!).


##### `SessionTelemetry::see_event_completed_failed`  (lines 901–915)

```
fn see_event_completed_failed(&self, error: &T)
```

**Purpose**: Records that processing a response.completed SSE event failed. The function name appears to contain "see" rather than "sse", but it logs the SSE completion failure.

**Data flow**: It receives an error value. It emits a structured log and trace event with kind response.completed and the error message.

**Call relations**: Response event mapping code calls this when it cannot process a completion event. It uses the shared log-and-trace macro.

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

**Purpose**: Records token counts from a completed SSE response. This gives observability into how many input, output, cached, reasoning, and tool tokens were involved.

**Data flow**: It receives several token counts, some optional. It emits them in a structured log and trace event for response.completed.

**Call relations**: Response event mapping code calls this after successfully extracting completion usage information from the stream.

*Call graph*: called by 1 (map_response_events); 1 external calls (log_and_trace_event!).


##### `SessionTelemetry::user_prompt`  (lines 941–982)

```
fn user_prompt(&self, items: &[UserInput])
```

**Purpose**: Records that the user submitted input, including prompt length and counts of text and image inputs. It only logs the actual prompt text if the session allows prompt logging.

**Data flow**: It receives a list of user input items. It combines text parts, counts text/image/local-image items, redacts the prompt if configured, then logs prompt length and traces input counts.

**Call relations**: User-input handling code calls this when a prompt enters the session. The split between log and trace keeps sensitive prompt text controlled while still preserving useful counts.

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

**Purpose**: Records the approval decision made for a tool call. This is useful when a tool needed review before running.

**Data flow**: It receives tool name, call id, decision, and decision source. It converts the decision to lowercase text and logs a structured tool decision event.

**Call relations**: Approval request code calls this after a review decision is made. It records the decision but does not update metrics.

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

**Purpose**: Records what happened when a tool ran under sandbox rules. A sandbox is a restricted environment that limits what a command can do.

**Data flow**: It receives tool identity, outcome, initial run duration, and optional escalated duration. It converts durations to milliseconds safely and writes both log and trace events.

**Call relations**: Tool execution code can call this after a sandboxed run completes. It makes both the first attempt and any escalated attempt visible.

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

**Purpose**: Wraps an async tool execution so the tool result is timed and recorded automatically. It returns the original tool result unchanged.

**Data flow**: It receives tool identity, arguments, extra metric tags, extra trace fields, and an async function to run. It measures duration, turns either the tool preview or error into output text, records the result, and returns the original result.

**Call relations**: Tool-running code can use this wrapper around actual tool work. It delegates recording to SessionTelemetry::tool_result_with_tags.

*Call graph*: calls 1 internal fn (tool_result_with_tags); 3 external calls (Borrowed, Owned, now).


##### `SessionTelemetry::log_tool_failed`  (lines 1070–1092)

```
fn log_tool_failed(&self, tool_name: &str, error: &str)
```

**Purpose**: Records a tool failure that happened before normal timing/result wrapping was possible. It logs zero duration and marks success as false.

**Data flow**: It receives a tool name and error text. It writes a log event with the error as output and a trace event with output length, line count, builtin origin, and error message.

**Call relations**: Early tool failure paths can call this when there is no full tool call context. It uses direct log and trace event macros rather than the metric helper.

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

**Purpose**: Records the final result of a tool call, including metrics and structured event fields. It supports extra tags and trace hints for special tool sources such as MCP servers.

**Data flow**: It receives tool name, call id, arguments, duration, success flag, output, extra metric tags, and extra trace fields. It records count and duration metrics, extracts MCP details from trace fields, logs full arguments/output, and traces safer summary fields such as lengths.

**Call relations**: SessionTelemetry::log_tool_result_with_tags calls this after a wrapped tool finishes. It uses trace_field_value to pick out MCP-related fields before emitting telemetry.

*Call graph*: calls 3 internal fn (counter, record_duration, trace_field_value); called by 1 (log_tool_result_with_tags); 3 external calls (with_capacity, log_event!, trace_event!).


##### `SessionTelemetry::record_responses_websocket_timing_metrics`  (lines 1143–1193)

```
fn record_responses_websocket_timing_metrics(&self, value: &serde_json::Value)
```

**Purpose**: Extracts detailed timing measurements from a special Responses API WebSocket event. These timings separate overhead, inference, and engine time-to-first-token or time-between-token costs.

**Data flow**: It receives a JSON value. It looks inside the timing_metrics object, reads known millisecond fields, converts valid values to Duration, and records each matching metric.

**Call relations**: SessionTelemetry::record_websocket_event calls this when a WebSocket message has the special timing event type. It relies on duration_from_ms_value to safely parse each timing value.

*Call graph*: calls 2 internal fn (record_duration, duration_from_ms_value); called by 1 (record_websocket_event); 1 external calls (get).


##### `SessionTelemetry::responses_type`  (lines 1195–1216)

```
fn responses_type(event: &ResponseEvent) -> String
```

**Purpose**: Turns a ResponseEvent into a short readable category name for tracing. This makes response traces easier to search and group.

**Data flow**: It receives a ResponseEvent. It matches the event variant and returns a string such as created, completed, text_delta, or a response item type.

**Call relations**: SessionTelemetry::record_responses calls this before recording the event type on a trace span. For item-based events, it delegates to SessionTelemetry::responses_item_type.

*Call graph*: calls 1 internal fn (responses_item_type); called by 1 (record_responses).


##### `SessionTelemetry::responses_item_type`  (lines 1218–1237)

```
fn responses_item_type(item: &ResponseItem) -> String
```

**Purpose**: Turns a response item into a short readable type name. It distinguishes messages, reasoning, tool calls, web search, image generation, compaction, and other item kinds.

**Data flow**: It receives a ResponseItem. It matches the item variant and returns a string label; for normal messages it includes the message role.

**Call relations**: SessionTelemetry::responses_type calls this when a Responses API event contains an added or completed output item.

*Call graph*: called by 1 (responses_type); 1 external calls (format!).


##### `duration_from_ms_value`  (lines 1240–1251)

```
fn duration_from_ms_value(value: Option<&serde_json::Value>) -> Option<Duration>
```

**Purpose**: Converts a JSON number measured in milliseconds into a Rust Duration. It rejects missing, negative, infinite, or non-number values.

**Data flow**: It receives an optional JSON value. It tries to read it as a floating-point, signed, or unsigned number, validates it, clamps it to the maximum Duration milliseconds, rounds it, and returns a Duration if valid.

**Call relations**: SessionTelemetry::record_responses_websocket_timing_metrics calls this for each timing field before recording detailed Responses API duration metrics.

*Call graph*: called by 1 (record_responses_websocket_timing_metrics); 1 external calls (from_millis).


### `core/src/turn_timing.rs`

`domain_logic` · `per-turn request handling and telemetry recording`

A “turn” is one round of interaction where the user asks something and the assistant works toward an answer. This file acts like a stopwatch set with several lap buttons. It records when the turn starts, when the first token or first full message appears, and how much time is spent in major phases such as sampling from the model or waiting on tools.

There are two layers of timing here. TurnTimingStateInner tracks simple milestones: start time, first token, and first message. TurnProfileState tracks a fuller profile of the turn: time before the first model request, time spent sampling, idle time between sampling requests, time blocked by tools, and time after the last sampling request. A mutex, which is a lock that stops two tasks from changing the same data at once, protects each shared state.

The file also decides which response events count as “first token” events. For example, actual assistant text or reasoning text counts, but metadata and rate-limit messages do not. Timing guards mark phases automatically: when a guard is created, a phase starts; when it is dropped, the phase ends. This makes phase timing harder to forget, much like a kitchen timer that stops when you take it off the counter.

#### Function details

##### `record_turn_ttft_metric`  (lines 18–27)

```
async fn record_turn_ttft_metric(turn_context: &TurnContext, event: &ResponseEvent)
```

**Purpose**: Records the turn’s “time to first token,” meaning how long it took before the user could see the first meaningful piece of assistant output. It only records the metric once, and only for events that actually represent visible output.

**Data flow**: It receives the current turn context and a response event. It asks the turn timing state whether this event should set the first-token time; if a duration comes back, it sends that duration to the session telemetry. If the event does not count, or the first token was already recorded, nothing is changed.

**Call relations**: During sampling, try_run_sampling_request calls this as response events arrive. This function delegates the decision to the turn timing state, then hands the final duration to telemetry so the rest of the system can report it.

*Call graph*: called by 1 (try_run_sampling_request).


##### `record_turn_ttfm_metric`  (lines 29–40)

```
async fn record_turn_ttfm_metric(turn_context: &TurnContext, item: &TurnItem)
```

**Purpose**: Records the turn’s “time to first message,” meaning how long it took before the first completed assistant message item was produced. This is separate from first token because a token can arrive before a full message is ready.

**Data flow**: It receives the current turn context and a completed turn item. It asks the timing state whether that item is the first agent message; if so, it gets back a duration and records it under the turn time-to-first-message metric. Otherwise it leaves telemetry unchanged.

**Call relations**: emit_turn_item_completed calls this when a turn item finishes. The function filters through TurnTimingState and then sends the resulting measurement to the session telemetry recorder.

*Call graph*: called by 1 (emit_turn_item_completed).


##### `TurnTimingState::mark_turn_started`  (lines 86–95)

```
async fn mark_turn_started(&self, started_at: Instant) -> i64
```

**Purpose**: Starts timing a new turn. It resets earlier first-token and first-message markers so measurements from a previous turn cannot leak into the new one.

**Data flow**: It receives an Instant, which is Rust’s steady clock value for measuring elapsed time. It also reads the current wall-clock Unix time in milliseconds, stores the start time and Unix seconds, clears old milestone times, starts the detailed profile, and returns the Unix millisecond timestamp.

**Call relations**: This is called near the beginning of a turn. It uses now_unix_timestamp_ms for a wall-clock timestamp and profile_state to reset the detailed phase profiler.

*Call graph*: calls 2 internal fn (profile_state, now_unix_timestamp_ms).


##### `TurnTimingState::started_at_unix_secs`  (lines 97–99)

```
async fn started_at_unix_secs(&self) -> Option<i64>
```

**Purpose**: Returns the turn start time as Unix seconds, if the turn has been started. This is useful when reports or protocol messages need a normal wall-clock timestamp.

**Data flow**: It reads the locked timing state and returns the stored Unix-second start time. If no turn start was recorded yet, it returns nothing.

**Call relations**: Other code can call this after mark_turn_started has stored the timestamp. It does not call into the profiling code; it only reads the simple milestone state.


##### `TurnTimingState::completed_at_and_duration_ms`  (lines 101–108)

```
async fn completed_at_and_duration_ms(&self) -> (Option<i64>, Option<i64>)
```

**Purpose**: Reports when the turn completed and how many milliseconds it lasted. It gives callers both a wall-clock completion time and an elapsed duration from the stored start time.

**Data flow**: It locks the timing state, gets the current Unix time in seconds, and compares the saved start Instant with the current time. It returns a pair: completion timestamp and duration in milliseconds, with no duration if the turn was never started.

**Call relations**: This is used when finishing or reporting a turn. It calls now_unix_timestamp_secs for the wall-clock completion time and reads the already stored start Instant for elapsed time.

*Call graph*: calls 1 internal fn (now_unix_timestamp_secs).


##### `TurnTimingState::time_to_first_token_ms`  (lines 110–115)

```
async fn time_to_first_token_ms(&self) -> Option<i64>
```

**Purpose**: Returns the already-recorded time to first token in milliseconds. It does not create the measurement; it only reads it.

**Data flow**: It locks the timing state and asks the inner state for the duration between turn start and first token. If both times exist, it converts that duration to milliseconds; otherwise it returns nothing.

**Call relations**: This is a read-only view over TurnTimingStateInner::time_to_first_token. It is useful after response events have already had a chance to record the first token.


##### `TurnTimingState::complete_profile`  (lines 117–119)

```
fn complete_profile(&self) -> TurnProfile
```

**Purpose**: Finishes the detailed turn profile and returns the final breakdown of where the turn’s time went. Calling it more than once returns the same completed profile rather than recalculating a different result.

**Data flow**: It gets the profile state, supplies the current Instant as the finish time, and receives a TurnProfile containing measured millisecond totals and sampling counts. The profile state is updated so the result is remembered.

**Call relations**: Turn-ending code calls this when it needs the final performance profile. It uses profile_state to reach the shared profiler, and TurnProfileState::complete does the detailed accounting.

*Call graph*: calls 1 internal fn (profile_state); 1 external calls (now).


##### `TurnTimingState::begin_sampling`  (lines 121–128)

```
fn begin_sampling(self: &Arc<Self>) -> TurnProfileTimingGuard
```

**Purpose**: Marks the start of a model sampling phase, where the system is asking the model to generate or reason. It returns a guard object that will automatically stop timing this phase when the guard is dropped.

**Data flow**: It reads the current time, asks the profile state to begin sampling, and builds a TurnProfileTimingGuard holding a shared reference back to this timing state. If the phase could not start, the guard is inactive and will do nothing when dropped.

**Call relations**: Sampling code calls this at the start of a model request. It uses profile_state to update the profile and returns a guard whose Drop behavior later calls back to end the phase.

*Call graph*: calls 1 internal fn (profile_state); 2 external calls (clone, now).


##### `TurnTimingState::record_sampling_retry`  (lines 130–132)

```
fn record_sampling_retry(&self)
```

**Purpose**: Counts an extra sampling attempt, such as when a model request must be retried. This helps performance reports distinguish one long request from repeated attempts.

**Data flow**: It locks the profile state and increments the retry count if the profile is active and not yet complete. If the turn was not started or is already complete, nothing changes.

**Call relations**: Sampling code can call this when retrying a model request. It passes the work directly to TurnProfileState::record_sampling_retry through profile_state.

*Call graph*: calls 1 internal fn (profile_state).


##### `TurnTimingState::begin_tool_blocking`  (lines 134–141)

```
fn begin_tool_blocking(self: &Arc<Self>) -> TurnProfileTimingGuard
```

**Purpose**: Marks the start of time spent blocked on a tool, such as waiting for a command or external operation before the assistant can continue. Like sampling, it returns a guard that ends the phase automatically.

**Data flow**: It gets the current time, asks the profile state to enter the tool-blocking phase, and returns a TurnProfileTimingGuard tied to that phase. If another phase is already active or the turn is not in a valid state, the guard is inactive.

**Call relations**: Tool-running code calls this when the assistant is waiting on tool work. The returned guard later uses Drop to tell the profile state that tool blocking ended.

*Call graph*: calls 1 internal fn (profile_state); 2 external calls (clone, now).


##### `TurnTimingState::record_ttft_for_response_event`  (lines 143–152)

```
async fn record_ttft_for_response_event(
        &self,
        event: &ResponseEvent,
    ) -> Option<Duration>
```

**Purpose**: Checks whether a response event should count as the first visible output and, if so, records the time to first token. It protects against recording this milestone more than once.

**Data flow**: It receives a response event. First it asks response_event_records_turn_ttft whether the event is meaningful output; if not, it returns nothing. If the event qualifies, it locks the timing state and tries to set the first-token timestamp, returning the elapsed duration if this was the first one.

**Call relations**: record_turn_ttft_metric calls this while processing model output. This function uses response_event_records_turn_ttft as the filter, then TurnTimingStateInner::record_turn_ttft to store the milestone.

*Call graph*: calls 1 internal fn (response_event_records_turn_ttft).


##### `TurnTimingState::record_ttfm_for_turn_item`  (lines 154–160)

```
async fn record_ttfm_for_turn_item(&self, item: &TurnItem) -> Option<Duration>
```

**Purpose**: Records the time to the first completed assistant message item. It ignores other turn items because they are not the first full agent message shown to the user.

**Data flow**: It receives a turn item and checks whether it is an AgentMessage. If not, it returns nothing. If it is, it locks the timing state and records the first-message time, returning the duration from turn start if this is the first message.

**Call relations**: record_turn_ttfm_metric calls this after turn items complete. It performs the item-type filter itself, then relies on TurnTimingStateInner::record_turn_ttfm for the one-time recording.

*Call graph*: 1 external calls (matches!).


##### `TurnTimingState::profile_state`  (lines 162–166)

```
fn profile_state(&self) -> std::sync::MutexGuard<'_, TurnProfileState>
```

**Purpose**: Gives safe access to the detailed profile state protected by a standard mutex, which is a lock for shared data. It also recovers the state if a previous holder panicked while holding the lock.

**Data flow**: It locks the profile mutex and returns the lock guard, which lets the caller read or change the profile. If the lock is poisoned by a panic, it still returns the contained state instead of failing.

**Call relations**: The public profile methods use this helper before starting, stopping, completing, or updating phase timing. It centralizes the locking behavior so those methods do not repeat it.

*Call graph*: called by 5 (begin_sampling, begin_tool_blocking, complete_profile, mark_turn_started, record_sampling_retry); 1 external calls (lock).


##### `TurnProfileTimingGuard::drop`  (lines 170–176)

```
fn drop(&mut self)
```

**Purpose**: Automatically ends a timed profile phase when the guard goes out of scope. This prevents callers from having to remember a separate “stop timing” call.

**Data flow**: When the guard is destroyed, it checks whether it was active. If so, it gets the current time and tells the profile state to end the phase it started.

**Call relations**: Guards are created by TurnTimingState::begin_sampling and TurnTimingState::begin_tool_blocking. Rust calls this drop method automatically, and it hands the end timestamp to TurnProfileState::end_phase.

*Call graph*: 1 external calls (now).


##### `now_unix_timestamp_secs`  (lines 179–181)

```
fn now_unix_timestamp_secs() -> i64
```

**Purpose**: Returns the current wall-clock time as Unix seconds, meaning seconds since January 1, 1970. This format is common in logs and telemetry.

**Data flow**: It calls now_unix_timestamp_ms to get milliseconds, divides by 1000, and returns seconds.

**Call relations**: TurnTimingState::completed_at_and_duration_ms uses this when it needs a human-comparable completion timestamp rather than just elapsed time.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (completed_at_and_duration_ms).


##### `now_unix_timestamp_ms`  (lines 183–188)

```
fn now_unix_timestamp_ms() -> i64
```

**Purpose**: Returns the current wall-clock time as Unix milliseconds. Many parts of the system use this when they need timestamps for events, requests, approvals, or telemetry.

**Data flow**: It reads the system clock, measures the duration since the Unix epoch, converts that duration to milliseconds, and fits it into an i64 number. If conversion would overflow, it returns the largest possible i64.

**Call relations**: This is a shared timestamp helper used in this file when a turn starts and by many other parts of the system that stamp events with the current time.

*Call graph*: called by 22 (stamp_ws_stream_request_start_ms, run_guardian_review, emit_turn_item_completed, emit_turn_item_started, request_command_approval, request_patch_approval, request_permissions_for_environment, execute_user_shell_command, emit_exec_command_begin, emit_exec_end (+12 more)); 2 external calls (now, try_from).


##### `duration_to_u64_ms`  (lines 190–192)

```
fn duration_to_u64_ms(duration: Duration) -> u64
```

**Purpose**: Converts a Duration into an unsigned millisecond count for telemetry profiles. It safely caps very large values instead of overflowing.

**Data flow**: It receives a Duration, reads its millisecond length, converts that value to u64, and returns u64::MAX if the value is too large to fit.

**Call relations**: TurnProfileState::complete uses this when turning internal Duration values into the numeric fields of a TurnProfile.

*Call graph*: called by 1 (complete); 2 external calls (as_millis, try_from).


##### `TurnProfileState::start`  (lines 195–201)

```
fn start(&mut self, started_at: Instant)
```

**Purpose**: Resets the detailed profile for a fresh turn and records the starting point. This clears any phase timings left from a previous turn.

**Data flow**: It receives the turn’s starting Instant. It replaces the whole profile state with a new default state that has started_at and last_transition_at set to that Instant.

**Call relations**: TurnTimingState::mark_turn_started calls this at the beginning of a turn. It prepares the profile so later calls to begin_sampling or begin_tool_blocking can classify elapsed time correctly.

*Call graph*: 1 external calls (default).


##### `TurnProfileState::begin_sampling`  (lines 203–218)

```
fn begin_sampling(&mut self, now: Instant) -> bool
```

**Purpose**: Starts measuring a sampling phase if the profile is in a valid state. It also counts this as one sampling request.

**Data flow**: It receives the current Instant. If the profile is already complete, not started, or already in another active phase, it returns false. Otherwise it first assigns elapsed idle time to the right bucket, marks sampling as active, increments the sampling request count, and returns true.

**Call relations**: TurnTimingState::begin_sampling calls this when model sampling begins. It uses advance to classify time since the previous transition before switching into the Sampling phase.

*Call graph*: calls 1 internal fn (advance); 1 external calls (take).


##### `TurnProfileState::record_sampling_retry`  (lines 220–224)

```
fn record_sampling_retry(&mut self)
```

**Purpose**: Adds one to the sampling retry count for an active, unfinished turn. This records that the system had to try sampling again.

**Data flow**: It checks whether the profile has started and is not completed. If so, it increments the retry count using saturating arithmetic, which means it stops at the maximum value instead of wrapping around.

**Call relations**: TurnTimingState::record_sampling_retry calls this when sampling code reports a retry. It only updates the counter; it does not change the current timing phase.


##### `TurnProfileState::begin_tool_blocking`  (lines 226–236)

```
fn begin_tool_blocking(&mut self, now: Instant) -> bool
```

**Purpose**: Starts measuring time spent blocked on a tool. It refuses to start if the profile is complete, not started, or already timing another phase.

**Data flow**: It receives the current Instant. If the state is invalid for starting a new phase, it returns false. Otherwise it classifies time since the last transition, sets the active phase to ToolBlocking, and returns true.

**Call relations**: TurnTimingState::begin_tool_blocking calls this when tool wait time begins. Like sampling, it uses advance first so the gap before the tool wait is not lost.

*Call graph*: calls 1 internal fn (advance).


##### `TurnProfileState::end_phase`  (lines 238–244)

```
fn end_phase(&mut self, now: Instant, phase: TurnProfilePhase)
```

**Purpose**: Stops the currently active profiling phase, but only if it matches the phase that the caller says is ending. This prevents one guard from accidentally ending a different phase.

**Data flow**: It receives the current Instant and the phase expected to end. If the profile is complete or the active phase is different, it does nothing. Otherwise it adds elapsed time to the active phase through advance and clears the active phase.

**Call relations**: TurnProfileTimingGuard::drop calls this automatically when a sampling or tool-blocking guard is destroyed. It is the closing half of begin_sampling and begin_tool_blocking.

*Call graph*: calls 1 internal fn (advance).


##### `TurnProfileState::advance`  (lines 246–257)

```
fn advance(&mut self, now: Instant)
```

**Purpose**: Classifies the time since the last profile transition into the right bucket. This is the core bookkeeping that turns a raw timeline into meaningful categories.

**Data flow**: It receives the current Instant and compares it with the previous transition time. Depending on the active phase, it adds the elapsed time to sampling or tool blocking; if no phase is active, it adds the time either before first sampling or to idle time after sampling.

**Call relations**: begin_sampling, begin_tool_blocking, end_phase, and complete all call this before changing or finalizing state. It is the shared “move the stopwatch forward” step.

*Call graph*: called by 4 (begin_sampling, begin_tool_blocking, complete, end_phase); 1 external calls (saturating_duration_since).


##### `TurnProfileState::complete`  (lines 259–302)

```
fn complete(&mut self, now: Instant) -> TurnProfile
```

**Purpose**: Finalizes the detailed turn profile and returns a stable summary of the turn’s timing. It preserves the first completed result so repeated calls do not change the numbers.

**Data flow**: It receives the finish Instant. If a profile was already completed, it returns that saved copy. Otherwise it advances timing to the finish point, moves any final idle time into “after last sampling,” converts durations to milliseconds, fills in request and retry counts, adjusts for tiny rounding differences, stores the completed profile, and returns it.

**Call relations**: TurnTimingState::complete_profile calls this when the turn is being reported. It uses advance for final classification and duration_to_u64_ms to build the TurnProfile fields.

*Call graph*: calls 2 internal fn (advance, duration_to_u64_ms); 1 external calls (take).


##### `TurnTimingStateInner::time_to_first_token`  (lines 306–308)

```
fn time_to_first_token(&self) -> Option<Duration>
```

**Purpose**: Calculates the elapsed time between turn start and first token, if both moments are known. It is a small read-only helper for the simple timing state.

**Data flow**: It reads started_at and first_token_at from the inner state. If either is missing, it returns nothing; otherwise it returns the duration from start to first token.

**Call relations**: TurnTimingStateInner::record_turn_ttft calls this right after setting the first-token timestamp, and TurnTimingState::time_to_first_token_ms uses the same idea when reporting milliseconds.

*Call graph*: called by 1 (record_turn_ttft).


##### `TurnTimingStateInner::record_turn_ttft`  (lines 310–317)

```
fn record_turn_ttft(&mut self) -> Option<Duration>
```

**Purpose**: Records the first-token timestamp exactly once and returns the resulting duration from turn start. It refuses to overwrite an earlier first-token measurement.

**Data flow**: It checks whether first_token_at is already set; if so, it returns nothing. It also requires a started_at value. If the turn has started and no first token was recorded, it stores the current Instant and returns the calculated time to first token.

**Call relations**: TurnTimingState::record_ttft_for_response_event calls this after confirming that a response event counts as visible output. It relies on time_to_first_token to calculate the final duration.

*Call graph*: calls 1 internal fn (time_to_first_token); 1 external calls (now).


##### `TurnTimingStateInner::record_turn_ttfm`  (lines 319–327)

```
fn record_turn_ttfm(&mut self) -> Option<Duration>
```

**Purpose**: Records the first-message timestamp exactly once and returns the duration from turn start. This tracks when the first complete agent message appears.

**Data flow**: It checks whether first_message_at is already set; if so, it returns nothing. It requires a saved start time, stores the current Instant as the first message time, and returns the elapsed duration.

**Call relations**: TurnTimingState::record_ttfm_for_turn_item calls this after confirming that the completed item is an agent message. The returned duration is later sent to telemetry by record_turn_ttfm_metric.

*Call graph*: 1 external calls (now).


##### `response_event_records_turn_ttft`  (lines 330–349)

```
fn response_event_records_turn_ttft(event: &ResponseEvent) -> bool
```

**Purpose**: Decides whether a response event should count as the first meaningful assistant output. This keeps metadata and bookkeeping events from falsely improving the first-token measurement.

**Data flow**: It receives a ResponseEvent. For item-added or item-done events, it delegates to response_item_records_turn_ttft. For text or reasoning deltas, it returns true. For creation notices, model metadata, moderation metadata, rate limits, completion notices, and similar non-output events, it returns false.

**Call relations**: TurnTimingState::record_ttft_for_response_event calls this before recording time to first token. It is the event-level filter, and response_item_records_turn_ttft is the item-level filter it uses when the event contains a response item.

*Call graph*: calls 1 internal fn (response_item_records_turn_ttft); called by 1 (record_ttft_for_response_event).


##### `response_item_records_turn_ttft`  (lines 351–387)

```
fn response_item_records_turn_ttft(item: &ResponseItem) -> bool
```

**Purpose**: Decides whether a response item contains meaningful output for the time-to-first-token metric. It treats actual assistant text, reasoning text, and tool-call starts as output, while ignoring final tool outputs and non-visible triggers.

**Data flow**: It receives a ResponseItem. For normal messages, it extracts raw assistant text and checks that it is not empty. For reasoning items, it looks for non-empty summary or content text. Some tool-call and compaction items count as output because they show the assistant doing work; agent messages, tool outputs, compaction triggers, and unknown items do not.

**Call relations**: response_event_records_turn_ttft calls this when a response event contains an item. It uses raw_assistant_output_text_from_item to inspect message text without duplicating the text-extraction rules.

*Call graph*: calls 1 internal fn (raw_assistant_output_text_from_item); called by 1 (response_event_records_turn_ttft).


### Request and tool tracing
These files attach telemetry to request handling and tool execution paths, including app-server spans, sandbox characterization, and rollout trace emission.

### `app-server/src/app_server_tracing.rs`

`util` · `request handling and cross-cutting telemetry`

This file is about observability: making the server’s work visible while it runs. A tracing span is like a labeled folder for one piece of work. Everything logged while the request is being processed can be attached to that folder, along with useful labels such as the RPC method, transport type, request id, connection id, client name, and client version.

The main job here is to build that folder in a consistent shape for two paths. `request_span` is used for normal JSON-RPC requests that come through transports such as stdio, Unix sockets, or websockets. `typed_request_span` is used when code calls the app server directly in-process, without a JSON envelope. Both paths create the same kind of span so monitoring tools can compare them fairly.

The file also tries to connect incoming work to a larger distributed trace. A distributed trace is a way to follow one user action across multiple services. If the request includes W3C trace context information, this file attaches it as the parent of the new span. If not, it may fall back to trace information from the process environment. Client identity is taken from an `initialize` request when present, or otherwise from the saved session state. Without this file, request logs would be harder to group, compare, and connect across transports and services.

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

**Purpose**: Creates the tracing span for a JSON-RPC app-server request. It labels the request with method, transport, request id, connection id, client information, and any incoming trace context so later logs and telemetry can be tied back to this request.

**Data flow**: It receives the parsed JSON-RPC request, the transport it arrived on, the connection id, and the current session state. It checks whether this is an `initialize` request with fresh client details, builds a standard span, records the best available client name and version, attaches parent trace information if present, and returns the completed span.

**Call relations**: When `process_request` starts handling a JSON-RPC request, it calls this function first to create the telemetry wrapper for that work. This function gathers details through helpers such as `initialize_client_info`, `transport_name`, `client_name`, and `client_version`, then uses `app_server_request_span_template`, `record_client_info`, and `attach_parent_context` to assemble the final span.

*Call graph*: calls 7 internal fn (app_server_request_span_template, attach_parent_context, client_name, client_version, initialize_client_info, record_client_info, transport_name); called by 1 (process_request).


##### `typed_request_span`  (lines 62–83)

```
fn typed_request_span(
    request: &ClientRequest,
    connection_id: ConnectionId,
    session: &ConnectionSessionState,
) -> Span
```

**Purpose**: Creates the same kind of tracing span for an in-process request, where the caller uses typed Rust request values instead of a JSON-RPC envelope. This keeps embedded calls visible in telemetry in the same way as socket-based calls.

**Data flow**: It receives a typed client request, a connection id, and session state. It reads the request method and id from the typed request, marks the transport as `in-process`, extracts client information if the request is an initialize request, falls back to session client information if needed, attaches any available parent context from the environment, and returns the span.

**Call relations**: When `process_client_request` handles an in-process request, it calls this function to create comparable request telemetry. The function reuses the shared span template and client-recording helpers, but gets method, id, and initialize details from the typed request instead of from a JSON-RPC object.

*Call graph*: calls 6 internal fn (app_server_request_span_template, attach_parent_context, initialize_client_info_from_typed_request, record_client_info, app_server_client_name, client_version); called by 1 (process_client_request); 2 external calls (id, method).


##### `transport_name`  (lines 85–92)

```
fn transport_name(transport: &AppServerTransport) -> &'static str
```

**Purpose**: Turns the server transport choice into a short stable text label for telemetry. This lets dashboards and logs say whether a request came from stdio, a Unix socket, websocket, or an off/disabled transport setting.

**Data flow**: It receives an `AppServerTransport` value. It matches the variant and returns a fixed string such as `stdio`, `unix_socket`, `websocket`, or `off`.

**Call relations**: `request_span` calls this while building telemetry for JSON-RPC requests. The returned label is passed into `app_server_request_span_template` so the span records the request’s transport in a consistent field.

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

**Purpose**: Builds the common tracing span shape used for all app-server requests. It is the shared template that keeps telemetry fields consistent across different ways of calling the server.

**Data flow**: It receives the RPC method, transport label, request id, and connection id. It creates a span named `app_server.request` with standard labels for OpenTelemetry, JSON-RPC details, app-server API version, and placeholders for client and turn information. It returns that span for callers to fill in further.

**Call relations**: Both `request_span` and `typed_request_span` call this before adding client details and parent trace context. It is the central place that defines what every app-server request span looks like.

*Call graph*: called by 2 (request_span, typed_request_span); 1 external calls (info_span!).


##### `record_client_info`  (lines 116–123)

```
fn record_client_info(span: &Span, client_name: Option<&str>, client_version: Option<&str>)
```

**Purpose**: Adds client name and client version labels to a span when those values are known. This helps operators answer questions like which editor, tool, or integration sent a request.

**Data flow**: It receives a span plus optional client name and version strings. For each value that exists, it records that value into the corresponding span field. It does not return a new value; it updates the span it was given.

**Call relations**: `request_span` and `typed_request_span` call this after they have chosen the best source of client information. It fills in fields that were left empty by `app_server_request_span_template`.

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

**Purpose**: Connects this request span to an existing distributed trace when possible. This lets one user action be followed across process or service boundaries instead of appearing as unrelated work.

**Data flow**: It receives the span, the request method, the request id, and optional W3C trace context from the request. If request trace data is present, it tries to set it as the span’s parent and warns if the trace data is invalid. If no request trace is present, it checks the process environment for trace context and uses that if found. It updates the span’s parent relationship and returns nothing.

**Call relations**: `request_span` calls this with trace data extracted from the JSON-RPC request. `typed_request_span` calls it without request-provided trace data, allowing the environment fallback. It delegates the actual trace attachment to OpenTelemetry helper functions.

*Call graph*: called by 2 (request_span, typed_request_span); 4 external calls (set_parent_from_context, set_parent_from_w3c_trace_context, traceparent_context_from_env, warn!).


##### `client_name`  (lines 144–152)

```
fn client_name(
    initialize_client_info: Option<&'a InitializeParams>,
    session: &'a ConnectionSessionState,
) -> Option<&'a str>
```

**Purpose**: Chooses the best available client name for a JSON-RPC request. A fresh name from an `initialize` request takes priority; otherwise it uses the name saved in the connection session.

**Data flow**: It receives optional initialize parameters and the session state. If initialize parameters are present, it returns the client name from them. If not, it asks the session for the previously stored app-server client name and returns that if available.

**Call relations**: `request_span` calls this after trying to parse initialize parameters from the request. Its answer is passed to `record_client_info` so the span can be labeled with the client name.

*Call graph*: calls 1 internal fn (app_server_client_name); called by 1 (request_span).


##### `client_version`  (lines 154–162)

```
fn client_version(
    initialize_client_info: Option<&'a InitializeParams>,
    session: &'a ConnectionSessionState,
) -> Option<&'a str>
```

**Purpose**: Chooses the best available client version for a JSON-RPC request. It prefers the version sent in the current `initialize` request and falls back to the version remembered in the session.

**Data flow**: It receives optional initialize parameters and the session state. If initialize parameters exist, it returns the version from those parameters. Otherwise it asks the session for the stored client version and returns that if available.

**Call relations**: `request_span` calls this alongside `client_name`. The selected version is then written into the span by `record_client_info`.

*Call graph*: calls 1 internal fn (client_version); called by 1 (request_span).


##### `initialize_client_info`  (lines 164–170)

```
fn initialize_client_info(request: &JSONRPCRequest) -> Option<InitializeParams>
```

**Purpose**: Extracts client information from a JSON-RPC `initialize` request, if the current request is one. This is important because initialize is where clients introduce themselves to the server.

**Data flow**: It receives a JSON-RPC request. If the method is not `initialize`, it returns nothing. If it is `initialize`, it clones the request parameters and tries to decode them into `InitializeParams`; on success it returns those parameters, and on missing or invalid parameters it returns nothing.

**Call relations**: `request_span` calls this before choosing client name and version. The parsed initialize data is then used by `client_name` and `client_version` to label the span with the newest client identity.

*Call graph*: called by 1 (request_span); 1 external calls (from_value).


##### `initialize_client_info_from_typed_request`  (lines 172–180)

```
fn initialize_client_info_from_typed_request(request: &ClientRequest) -> Option<(&str, &str)>
```

**Purpose**: Extracts client name and version from a typed in-process initialize request. It is the typed-request equivalent of reading initialize parameters from a JSON-RPC request.

**Data flow**: It receives a typed `ClientRequest`. If the request is an `Initialize` variant, it returns references to the client name and version inside its parameters. For any other request type, it returns nothing.

**Call relations**: `typed_request_span` calls this while building telemetry for in-process requests. If it returns client details, those details are recorded on the span; otherwise `typed_request_span` falls back to the session’s stored client information.

*Call graph*: called by 1 (typed_request_span).


### `core/src/sandbox_tags.rs`

`util` · `cross-cutting`

This file answers a simple but important question: “How locked down is this run?” The project has several ways to limit what a task can do, such as no sandbox, an external sandbox, a managed file and network policy, or a platform sandbox supplied by the operating system. Other parts of the system need compact labels for that state, especially for metadata and reporting. This file produces those labels in one consistent place.

Think of it like printing a badge for a visitor. The detailed permission rules may be complicated, but the badge needs to say something clear like “read-only,” “workspace-write,” or “windows_elevated.”

The first function decides the sandbox label. It checks whether sandboxing is disabled, delegated to something external, or managed by this program. For managed profiles, it asks whether the file and network rules are strict enough to require a real platform sandbox. If not, it reports no sandbox. On Windows, it has a special label for elevated Windows sandboxing. Otherwise, it asks the sandboxing layer which platform sandbox is available and converts that into a metric-friendly tag.

The second function decides the policy label. It looks at the effective file-system policy and classifies it as full access, read-only, or writable workspace access.

#### Function details

##### `permission_profile_sandbox_tag`  (lines 8–38)

```
fn permission_profile_sandbox_tag(
    profile: &PermissionProfile,
    windows_sandbox_level: WindowsSandboxLevel,
    enforce_managed_network: bool,
) -> &'static str
```

**Purpose**: This function chooses a short label describing what kind of sandbox is actually being used. It is useful when the system needs to record run metadata without carrying around the full permission configuration.

**Data flow**: It receives a permission profile, the chosen Windows sandbox level, and a flag saying whether managed network rules must be enforced. It first handles simple cases: disabled permissions become "none" and externally provided sandboxing becomes "external". For managed permissions, it converts the file-system rules into a sandbox policy and asks whether those rules require a platform sandbox at all. If they do, it checks for the special elevated Windows case, otherwise asks the sandboxing library what platform sandbox is available and turns that into a tag. The output is a fixed text label such as "none", "external", "windows_elevated", or a platform-specific sandbox tag.

**Call relations**: This function is called while dispatching work with a terminal outcome, while constructing new state, and by code that records whether turn metadata uses a platform sandbox tag. Inside, it relies on the sandboxing policy code to decide whether a platform sandbox is needed, and then on the platform sandbox lookup to name the sandbox that will be reported.

*Call graph*: calls 1 internal fn (should_require_platform_sandbox); called by 3 (dispatch_any_with_terminal_outcome, new, turn_metadata_state_uses_platform_sandbox_tag); 3 external calls (cfg!, get_platform_sandbox, matches!).


##### `permission_profile_policy_tag`  (lines 40–61)

```
fn permission_profile_policy_tag(
    profile: &PermissionProfile,
    cwd: &Path,
) -> &'static str
```

**Purpose**: This function chooses a short label for the file-access policy: full access, external sandboxing, read-only, or workspace-write. It helps callers describe the permission level in plain categories rather than detailed rule objects.

**Data flow**: It receives a permission profile and the current working directory. If permissions are disabled, it returns "danger-full-access". If an external sandbox is responsible, it returns "external-sandbox". For managed permissions, it reads the file-system sandbox policy from the profile, checks whether full disk writes are allowed, then checks whether there are any writable roots once the current directory is considered. The result is one fixed text label describing the effective file-writing power.

**Call relations**: This function is used when dispatching work with a terminal outcome, so the run can be tagged with the policy that was in force. It delegates the detailed interpretation of managed file rules to the profile’s file-system sandbox policy, then reduces that detail to a simple reporting label.

*Call graph*: calls 1 internal fn (file_system_sandbox_policy); called by 1 (dispatch_any_with_terminal_outcome).


### `core/src/tools/tool_dispatch_trace.rs`

`orchestration` · `tool dispatch`

When the system asks a tool to run, that work may succeed, fail, or return different shapes of output depending on who asked for it. This file is the small adapter that records that story for rollout tracing. A rollout trace is like a flight recorder: it captures important events so someone can inspect what happened later.

The main type, `ToolDispatchTrace`, wraps a trace context from the `codex-rollout-trace` crate. The trace crate owns the event format and the actual recording behavior. This file only translates core tool-dispatch objects into that trace format.

The flow is simple. When dispatch begins, `ToolDispatchTrace::start` builds a trace “invocation” from the current `ToolInvocation`: thread, turn, tool name, tool call id, requester, and payload. Later, if the tool finishes, `record_completed` converts the tool output into the correct trace result. A direct model tool call is recorded as a normal response item, while a code-mode tool call is recorded as a code-mode value. If the tool fails before completion, `record_failed` records the error.

An important detail is that tracing can be disabled. In that case, completion recording returns early and avoids building unnecessary trace data.

#### Function details

##### `ToolDispatchTrace::start`  (lines 25–32)

```
fn start(invocation: &ToolInvocation) -> Self
```

**Purpose**: Starts a trace record for one tool dispatch. Someone uses this at the beginning of a tool call so the later success or failure can be tied back to the same request.

**Data flow**: It receives a `ToolInvocation`, which contains the session, turn, tool name, caller, and input payload. It asks the session’s rollout trace service to start a tool-dispatch trace, giving it a recipe for building the trace invocation. It returns a `ToolDispatchTrace` object that holds the trace context for later updates.

**Call relations**: The tool-dispatch path calls this when it begins running a tool. The trace service then calls back into the local conversion helper, `tool_dispatch_invocation`, when it needs the event details.

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

**Purpose**: Records the end of a tool dispatch when the tool produced an output. It marks the trace as completed or failed based on whether the output counts as successful for logging.

**Data flow**: It takes the original invocation, the call id, the payload sent to the tool, and the tool’s output. First it checks whether tracing is enabled. If not, it does nothing. If tracing is enabled, it converts the output into the trace result shape, checks whether the output should be logged as success, and then records the completed trace event with the final status and result data.

**Call relations**: This is used after a dispatched tool returns. It relies on `tool_dispatch_result` to translate the output into the trace crate’s event format, asks the output whether it was successful for logging, and then hands the final event to the trace context’s `record_completed` method.

*Call graph*: calls 3 internal fn (tool_dispatch_result, is_enabled, record_completed); 1 external calls (success_for_logging).


##### `ToolDispatchTrace::record_failed`  (lines 57–59)

```
fn record_failed(&self, error: &FunctionCallError)
```

**Purpose**: Records that a tool dispatch failed with an error before a normal output was available. This keeps failed early-exit paths visible in the trace instead of silently disappearing.

**Data flow**: It receives a `FunctionCallError`, which describes what went wrong. It passes that error to the stored trace context, which records the failed trace event. It does not return a value or change the tool result itself.

**Call relations**: The tool-dispatch code can call this when dispatch fails. This method is a thin bridge to the rollout trace context’s own failure-recording behavior.

*Call graph*: calls 1 internal fn (record_failed).


##### `tool_dispatch_invocation`  (lines 62–85)

```
fn tool_dispatch_invocation(invocation: &ToolInvocation) -> Option<ToolDispatchInvocation>
```

**Purpose**: Builds the trace description of the tool request at the moment dispatch starts. It translates core project objects into the event shape expected by the rollout trace system.

**Data flow**: It reads the invocation’s source, session thread id, turn id, call id, tool name, namespace, and payload. If the source is a direct model request, it records the model-visible call id. If the source is code mode, it records the code cell id and runtime tool-call id. It also converts the payload into the trace payload format. The result is a `ToolDispatchInvocation` wrapped in `Some`.

**Call relations**: This helper is used by `ToolDispatchTrace::start` through the trace service’s start call. It delegates payload conversion to `tool_dispatch_payload` so the requester details and payload details stay cleanly separated.

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

**Purpose**: Converts a finished tool output into the form that should be written to the trace. The exact shape depends on whether the tool was called directly by the model or from code mode.

**Data flow**: It receives the original invocation, call id, original payload, and the tool output. For a direct call, it asks the output to become a normal response item. For a code-mode call, it asks the output for the value that code mode should see. It returns the matching trace result wrapped in `Some`.

**Call relations**: `ToolDispatchTrace::record_completed` calls this before recording a finished trace. This helper hands off to the tool output object for the final formatting, because each output type knows how to present itself as a model response or code-mode result.

*Call graph*: calls 1 internal fn (code_mode_result); called by 1 (record_completed); 1 external calls (to_response_item).


##### `tool_dispatch_payload`  (lines 103–115)

```
fn tool_dispatch_payload(payload: &ToolPayload) -> ToolDispatchPayload
```

**Purpose**: Copies a tool input payload into the rollout trace payload format. This lets the trace record show what kind of input the tool received without exposing core-only data structures.

**Data flow**: It receives a `ToolPayload`. If it is a function call, tool search, or custom input, it clones the corresponding arguments or input text into the matching `ToolDispatchPayload` variant. The output is a trace-friendly copy of the input payload.

**Call relations**: `tool_dispatch_invocation` calls this while building the start-of-dispatch trace event. It is the small translator responsible only for the payload part of that larger event.

*Call graph*: called by 1 (tool_dispatch_invocation).


### Feature metrics emitters
These files provide focused instrumentation for specific product areas such as guardian reviews, cloud-config activity, and goal lifecycle events.

### `core/src/guardian/metrics.rs`

`util` · `cross-cutting`

Guardian appears to be a safety review step: before some action is allowed, it can approve, deny, abort, or fail. This file is the bridge between that review result and the metrics system, which is the project’s way of collecting numbers for monitoring and analysis. Without it, operators could still run Guardian reviews, but they would lose the easy view of how often reviews happen, how many fail, what kinds of actions are reviewed, how slow they are, and how many model tokens they consume.

The main function, `emit_guardian_review_metrics`, receives a completed review result, the action that was reviewed, where the approval request came from, and the total completion time. It first builds a set of labels, called metric tags. A tag is like a label on a jar: it says “this count was for a denied network request” or “this duration came from a reused Guardian session.” It then records a review count, the total duration, optionally the time to first token, and optionally token usage.

Most of the rest of the file is careful translation. Internal enum values such as “High risk” or “Timed out” are converted into stable lowercase strings like `high` and `timed_out`. This matters because metric systems depend on consistent names. The test section builds an in-memory metrics collector and proves that a sample Guardian review produces the expected counts, durations, tags, and token breakdowns.

#### Function details

##### `emit_guardian_review_metrics`  (lines 21–52)

```
fn emit_guardian_review_metrics(
    session_telemetry: &SessionTelemetry,
    result: &GuardianReviewAnalyticsResult,
    approval_request_source: GuardianApprovalRequestSource,
    reviewed_action:
```

**Purpose**: Records all metrics for one finished Guardian review. Someone would use it after a review completes so dashboards and logs can show review volume, speed, result, and token cost.

**Data flow**: It takes a telemetry recorder, the review result, the source of the approval request, the reviewed action, and the total completion time in milliseconds. It turns the result and action into metric tags, increments the review counter, records the total duration, records time to first token if that value exists, and records token usage histograms if token usage exists. The output is not a returned value; the change is that metrics are written into the session telemetry system.

**Call relations**: In the normal flow, `track_guardian_review` calls this after a Guardian review has enough information to report. This function first asks `guardian_review_metric_tags` to prepare the shared labels, then uses the telemetry recorder’s `counter` and `record_duration` methods, and hands token details to `emit_guardian_token_usage_histograms` when token data is present. The test `guardian_review_metrics_record_counts_durations_and_token_usage` also calls it to verify the emitted metrics.

*Call graph*: calls 4 internal fn (emit_guardian_token_usage_histograms, guardian_review_metric_tags, counter, record_duration); called by 2 (guardian_review_metrics_record_counts_durations_and_token_usage, track_guardian_review); 1 external calls (from_millis).


##### `emit_guardian_token_usage_histograms`  (lines 54–78)

```
fn emit_guardian_token_usage_histograms(
    session_telemetry: &SessionTelemetry,
    token_usage: &TokenUsage,
    base_tags: Vec<(&'static str, String)>,
)
```

**Purpose**: Records the token counts for a Guardian review, split into useful categories such as input, cached input, output, and reasoning output. This helps people understand what parts of the review are costing model tokens.

**Data flow**: It receives the telemetry recorder, a `TokenUsage` summary, and the base metric tags already built for the review. For each token category, it adds one extra tag named `token_type` and records that category’s value in the token usage histogram. It does not return anything; it writes several metric samples.

**Call relations**: `emit_guardian_review_metrics` calls this only when the review result includes token usage. This helper relies on the token usage object for derived values like cached and non-cached input, then hands each number to the telemetry recorder’s `histogram` method.

*Call graph*: calls 3 internal fn (histogram, cached_input, non_cached_input); called by 1 (emit_guardian_review_metrics).


##### `guardian_review_metric_tags`  (lines 80–135)

```
fn guardian_review_metric_tags(
    result: &GuardianReviewAnalyticsResult,
    approval_request_source: GuardianApprovalRequestSource,
    reviewed_action: &GuardianReviewedAction,
) -> Vec<(&'static
```

**Purpose**: Builds the full set of labels attached to Guardian review metrics. These labels make raw numbers useful by showing what kind of review each number came from.

**Data flow**: It takes the review result, the approval request source, and the reviewed action. It converts each important field into a safe string tag: decision, terminal status, failure reason, source, action type, session kind, prior context, truncation, risk level, user authorization, outcome, model, and reasoning effort. It returns a vector of key-value tag pairs.

**Call relations**: `emit_guardian_review_metrics` calls this before recording any metrics, so all count, duration, and token metrics can share the same context. The small tag conversion helpers in this file provide the stable string values used here.

*Call graph*: called by 1 (emit_guardian_review_metrics); 1 external calls (vec!).


##### `decision_tag`  (lines 137–143)

```
fn decision_tag(decision: GuardianReviewDecision) -> &'static str
```

**Purpose**: Turns a Guardian review decision into a short metric-friendly word. This keeps metric labels stable instead of depending on internal enum formatting.

**Data flow**: It receives a decision value: approved, denied, or aborted. It matches that value and returns the corresponding lowercase string. Nothing else is changed.

**Call relations**: This is one of the small translators used by `guardian_review_metric_tags` when it builds the labels for metrics.


##### `terminal_status_tag`  (lines 145–153)

```
fn terminal_status_tag(status: GuardianReviewTerminalStatus) -> &'static str
```

**Purpose**: Turns the final status of a Guardian review into a stable tag string. This captures how the review ended, including outcomes like timeout or failed closed.

**Data flow**: It receives a terminal status value. It maps approved, denied, aborted, timed out, and failed closed to fixed lowercase strings. The returned string is used as a metric tag value.

**Call relations**: It feeds `guardian_review_metric_tags`, which uses the result to label every emitted Guardian review metric.


##### `failure_reason_tag`  (lines 155–164)

```
fn failure_reason_tag(reason: Option<GuardianReviewFailureReason>) -> &'static str
```

**Purpose**: Turns an optional Guardian failure reason into a metric tag. It also makes the absence of a failure explicit by returning `none`.

**Data flow**: It receives either a specific failure reason or no reason. Known reasons such as timeout, cancellation, prompt-building failure, session error, and parse error become fixed strings; no reason becomes `none`. It returns that string and changes no state.

**Call relations**: It is used by `guardian_review_metric_tags` so metrics can distinguish successful reviews from different kinds of failures.


##### `approval_request_source_tag`  (lines 166–171)

```
fn approval_request_source_tag(source: GuardianApprovalRequestSource) -> &'static str
```

**Purpose**: Names where the approval request came from in a form suitable for metrics. This helps separate reviews requested by the main turn from those requested by delegated subagents.

**Data flow**: It receives an approval request source value. It returns either `main_turn` or `delegated_subagent`. Nothing is written or mutated.

**Call relations**: `guardian_review_metric_tags` calls this while assembling the shared metric labels for a review.


##### `reviewed_action_tag`  (lines 173–183)

```
fn reviewed_action_tag(action: &GuardianReviewedAction) -> &'static str
```

**Purpose**: Converts the type of action being reviewed into a short tag. This lets metrics answer questions like whether reviews mostly involve shell commands, network access, or tool calls.

**Data flow**: It receives a reviewed action object. It looks only at which kind of action it is, not the detailed contents, and returns strings such as `shell`, `network_access`, or `mcp_tool_call`. It has no side effects.

**Call relations**: This helper supplies the `action` label used by `guardian_review_metric_tags`, which then passes it to all emitted Guardian review metrics.


##### `session_kind_tag`  (lines 185–192)

```
fn session_kind_tag(kind: Option<GuardianReviewSessionKind>) -> &'static str
```

**Purpose**: Turns the Guardian review session kind into a metric tag. It also records `none` when there was no session kind available.

**Data flow**: It receives an optional session kind. A new trunk session, reused trunk session, or forked temporary session becomes a fixed string; a missing value becomes `none`. The string is returned to the caller.

**Call relations**: `guardian_review_metric_tags` uses this to label whether the review used a new, reused, or temporary Guardian session.


##### `optional_bool_tag`  (lines 194–200)

```
fn optional_bool_tag(value: Option<bool>) -> &'static str
```

**Purpose**: Converts an optional true-or-false value into a metric tag string. It preserves the difference between false and unknown.

**Data flow**: It receives `Some(true)`, `Some(false)`, or no value. It returns `true`, `false`, or `unknown` respectively. There are no side effects.

**Call relations**: `guardian_review_metric_tags` uses this for fields where the system may not know the answer, such as whether there was prior review context.


##### `bool_tag`  (lines 202–204)

```
fn bool_tag(value: bool) -> &'static str
```

**Purpose**: Converts a plain true-or-false value into the strings `true` or `false` for metric labels.

**Data flow**: It receives a boolean value. If the value is true, it returns `true`; otherwise it returns `false`. It does not read or change anything else.

**Call relations**: `guardian_review_metric_tags` uses this for known boolean fields, such as whether the reviewed action text had to be truncated.


##### `risk_level_tag`  (lines 206–214)

```
fn risk_level_tag(risk_level: Option<GuardianRiskLevel>) -> &'static str
```

**Purpose**: Turns an optional Guardian risk level into a stable metric label. This lets metrics group reviews by low, medium, high, or critical risk.

**Data flow**: It receives a risk level or no value. Known levels become `low`, `medium`, `high`, or `critical`; no value becomes `none`. It returns that string.

**Call relations**: `guardian_review_metric_tags` calls this when preparing the risk-level label for each Guardian review metric.


##### `user_authorization_tag`  (lines 216–224)

```
fn user_authorization_tag(user_authorization: Option<GuardianUserAuthorization>) -> &'static str
```

**Purpose**: Turns the user authorization level into a metric label. This records how much permission the user had granted or whether it was unknown.

**Data flow**: It receives an optional user authorization value. It maps unknown, low, medium, and high authorization to fixed strings, and maps a missing value to `none`. It returns the chosen string.

**Call relations**: This is used inside `guardian_review_metric_tags` so emitted metrics can be filtered or grouped by the authorization level involved in the review.


##### `outcome_tag`  (lines 226–232)

```
fn outcome_tag(outcome: Option<GuardianAssessmentOutcome>) -> &'static str
```

**Purpose**: Converts the Guardian assessment outcome into a metric tag. It records whether the assessment said to allow or deny, or `none` if there was no assessment outcome.

**Data flow**: It receives an optional outcome. `Allow` becomes `allow`, `Deny` becomes `deny`, and no value becomes `none`. It returns the string without changing anything.

**Call relations**: `guardian_review_metric_tags` uses this helper when creating the shared labels for review metrics.


##### `tests::test_session_telemetry`  (lines 251–271)

```
fn test_session_telemetry() -> SessionTelemetry
```

**Purpose**: Creates a test-only telemetry setup that stores metrics in memory instead of sending them elsewhere. This gives the tests a safe place to record metrics and inspect them afterward.

**Data flow**: It starts with no inputs. It builds an in-memory metrics exporter and metrics client, creates a session telemetry object with test values, attaches the metrics client, and returns that ready-to-use telemetry object.

**Call relations**: The test `tests::guardian_review_metrics_record_counts_durations_and_token_usage` calls this first so it can run the real metric-emitting code and then examine the recorded results.

*Call graph*: calls 4 internal fn (new, new, in_memory, new); 2 external calls (default, env!).


##### `tests::find_metric`  (lines 273–282)

```
fn find_metric(resource_metrics: &'a ResourceMetrics, name: &str) -> &'a Metric
```

**Purpose**: Finds a metric with a given name inside an in-memory metrics snapshot. It is a test helper that keeps assertions focused on the metric being checked.

**Data flow**: It receives a metrics snapshot and a metric name. It searches through the snapshot’s metric groups until it finds a matching metric, then returns it. If the metric is missing, it stops the test with an error.

**Call relations**: Other test helpers, such as `tests::counter_point` and `tests::histogram_sums`, call this before reading a metric’s data.

*Call graph*: 2 external calls (scope_metrics, panic!).


##### `tests::attributes_to_map`  (lines 284–290)

```
fn attributes_to_map(
        attributes: impl Iterator<Item = &'a KeyValue>,
    ) -> BTreeMap<String, String>
```

**Purpose**: Turns metric attributes into a sorted map so tests can compare them easily. Attributes are the metric tags, such as `decision=approved`.

**Data flow**: It receives an iterator over metric key-value attributes. It converts each key and value to strings and collects them into a `BTreeMap`, which keeps entries ordered. It returns that map for assertions.

**Call relations**: `tests::counter_point` uses this to compare the counter’s tags with the expected set. `tests::histogram_sums` performs the same kind of conversion directly when reading histogram points.

*Call graph*: 1 external calls (map).


##### `tests::counter_point`  (lines 292–309)

```
fn counter_point(
        resource_metrics: &ResourceMetrics,
        name: &str,
    ) -> (BTreeMap<String, String>, u64)
```

**Purpose**: Reads one counter metric from a test snapshot and returns its tags and value. It assumes the counter should have exactly one recorded data point.

**Data flow**: It receives a metrics snapshot and a metric name. It finds the metric, checks that it is an unsigned integer sum counter, checks that there is exactly one point, converts that point’s attributes into a map, and returns the attributes together with the counter value. If the metric shape is not what the test expects, it fails the test.

**Call relations**: The main test calls this after emitting Guardian metrics to confirm the review count was incremented once and had exactly the expected labels. It depends on `tests::find_metric` to locate the metric and `tests::attributes_to_map` to prepare the labels.

*Call graph*: 4 external calls (assert_eq!, attributes_to_map, find_metric, panic!).


##### `tests::histogram_sums`  (lines 311–332)

```
fn histogram_sums(resource_metrics: &ResourceMetrics, name: &str) -> BTreeMap<String, u64>
```

**Purpose**: Reads a histogram metric from a test snapshot and returns the total recorded value for each token type or sample. A histogram is a metric form used for distributions, but this helper checks only the sums.

**Data flow**: It receives a metrics snapshot and a metric name. It finds the metric, checks that it is a floating-point histogram, walks over its data points, reads each point’s attributes, chooses the `token_type` tag when present or `sample` when absent, and returns a map from that label to the point’s summed value. If the metric is not shaped as expected, it fails the test.

**Call relations**: The main test uses this helper to verify token usage, total review duration, and time-to-first-token duration after `emit_guardian_review_metrics` has recorded them.

*Call graph*: 2 external calls (find_metric, panic!).


##### `tests::guardian_review_metrics_record_counts_durations_and_token_usage`  (lines 335–417)

```
fn guardian_review_metrics_record_counts_durations_and_token_usage()
```

**Purpose**: Checks that a representative Guardian review produces the expected metric count, tags, durations, and token usage. It protects the metrics contract from accidental changes.

**Data flow**: It creates test telemetry, builds a sample successful Guardian review result with risk, authorization, model, token usage, and timing data, then calls `emit_guardian_review_metrics`. After taking a metrics snapshot, it reads the counter and histograms and compares their values and tags with the expected results. The outcome is a passing test if the emitted metrics match, or a failed test if anything differs.

**Call relations**: This test drives the real production function `emit_guardian_review_metrics`. It uses `tests::test_session_telemetry` for setup, `tests::counter_point` to inspect the count metric, and `tests::histogram_sums` to inspect duration and token usage metrics.

*Call graph*: calls 2 internal fn (without_session, emit_guardian_review_metrics); 3 external calls (assert_eq!, counter_point, test_session_telemetry).


### `cloud-config/src/metrics.rs`

`io_transport` · `cross-cutting`

Cloud configuration is fetched and loaded in the background, and that can fail for many reasons: a bad network response, an authorization problem, an empty bundle, or no bundle at all. This file is the project’s small reporting desk for those events. Each public helper builds a metric, which is a counted event sent to the telemetry system, and attaches labels called tags. Tags are short pieces of context, such as the trigger that caused the fetch, the attempt number, the HTTP status code, or what kind of bundle was seen.

The file records three main moments. First, each fetch attempt can be counted. Second, the final result of a fetch can be counted once retries are over. Third, loading a bundle can be counted. To keep those reports consistent, helper functions turn optional data into stable words: no status code becomes "none", no bundle becomes "none", and a bundle with no relevant enterprise data becomes "empty". If the bundle contains enterprise-managed config or requirements, the metric records that shape.

At the bottom, `emit_metric` is the actual bridge to the telemetry library. If telemetry is available, it sends a counter increment. If not, it quietly does nothing. That means metrics never block or break the cloud-config path.

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

**Purpose**: Records one attempt to fetch the cloud configuration bundle. This helps answer questions like “how many retries are happening?” and “what status codes are we seeing during fetches?”

**Data flow**: It receives the reason the fetch was triggered, the attempt number, an outcome word, and an optional HTTP status code. It turns the attempt and status code into text tags, adds the trigger and outcome, and sends one counter event for a fetch attempt. It does not return data; its effect is the metric it tries to emit.

**Call relations**: The fetch and retry code calls this when a remote bundle request is tried or when authorization and validation paths need to record an attempt. It prepares the human-readable tags, asks `status_code_tag` to normalize the status code, and hands the finished metric to `emit_metric` for delivery.

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

**Purpose**: Records the final result of trying to fetch the cloud configuration bundle after the process has either succeeded or given up. It captures not just success or failure, but also why it ended that way and what kind of bundle was found, if any.

**Data flow**: It receives the trigger, outcome, reason, total attempt count, optional HTTP status code, and optional bundle. It converts the count and status code into tag text, summarizes the bundle’s contents, and emits one final fetch counter. It returns nothing; the output is the telemetry event.

**Call relations**: The higher-level fetch flow calls this when retries are finished, and some error paths call it when they end early. It uses `status_code_tag` for a consistent status-code label, uses the bundle-shape helper to summarize bundle contents, and then passes the complete metric to `emit_metric`.

*Call graph*: calls 2 internal fn (emit_metric, status_code_tag); called by 3 (fetch_remote_bundle_and_update_cache_with_retries, handle_unauthorized, validate_and_cache_remote_bundle); 1 external calls (vec!).


##### `emit_load_metric`  (lines 49–58)

```
fn emit_load_metric(trigger: &str, outcome: &str, bundle: Option<&CloudConfigBundle>)
```

**Purpose**: Records whether loading a cloud configuration bundle succeeded or failed. This is useful because fetching a bundle and successfully applying or loading it are related but separate events.

**Data flow**: It receives the trigger, an outcome word, and an optional bundle. It summarizes the bundle into a simple shape tag, combines that with the trigger and outcome, and emits one load counter. It returns nothing and only changes the outside world by attempting to send telemetry.

**Call relations**: Startup loading and background refresh code call this when they load or try to load cached or remote configuration. It builds the metric tags and hands them to `emit_metric`, so the rest of the system does not need to know the exact metric name or tag format.

*Call graph*: calls 1 internal fn (emit_metric); called by 3 (load_startup_bundle_with_timeout, refresh_cache_in_background, refresh_cache_once); 1 external calls (vec!).


##### `bundle_shape_tag`  (lines 60–79)

```
fn bundle_shape_tag(bundle: Option<&CloudConfigBundle>) -> String
```

**Purpose**: Turns a cloud configuration bundle into a short label describing what it contains. This keeps metrics useful without sending the full configuration contents.

**Data flow**: It receives either no bundle or a reference to a bundle. If there is no bundle, it returns "none". If there is a bundle but it has no enterprise-managed config or requirements, it returns "empty". If those sections are present, it returns a comma-separated label such as "enterprise_config" or "enterprise_config,enterprise_requirements".

**Call relations**: The metric-building functions use this when they need to describe a bundle in a safe, compact way. It acts like a shipping label: it says what category of package arrived without opening and printing everything inside.

*Call graph*: 1 external calls (new).


##### `status_code_tag`  (lines 81–85)

```
fn status_code_tag(status_code: Option<u16>) -> String
```

**Purpose**: Turns an optional HTTP status code into a stable text label for metrics. This avoids having some metrics omit the tag when there was no response code.

**Data flow**: It receives either a numeric status code or nothing. If a code is present, it converts it to text, such as "200" or "401". If no code is present, it returns "none".

**Call relations**: Fetch-attempt and final-fetch metric functions call this before sending telemetry. That keeps both metric types using the same wording for missing status codes.

*Call graph*: called by 2 (emit_fetch_attempt_metric, emit_fetch_final_metric).


##### `emit_metric`  (lines 87–95)

```
fn emit_metric(metric_name: &str, tags: Vec<(&str, String)>)
```

**Purpose**: Sends a counter metric to the project’s telemetry system, if that system is available. It is the one place in this file that talks directly to the metrics backend.

**Data flow**: It receives a metric name and a list of tag names and values. It asks the global telemetry system for a metrics reporter. If one exists, it converts the owned strings into borrowed text references and increments the named counter by one. If telemetry is not set up, it does nothing.

**Call relations**: All three public metric helpers call this after they have built their tags. It is the final handoff point: the rest of the file decides what should be reported, and this function performs the actual report without letting telemetry failures disturb the cloud-config workflow.

*Call graph*: called by 3 (emit_fetch_attempt_metric, emit_fetch_final_metric, emit_load_metric); 1 external calls (global).


### `ext/goal/src/metrics.rs`

`domain_logic` · `cross-cutting during goal creation and status updates`

This file is a small bridge between the goal feature and the project’s telemetry system. Telemetry means automatic measurements that help operators understand what the software is doing, like a dashboard in a car showing speed, fuel, and warning lights.

The central type, GoalMetrics, wraps an optional MetricsClient. If a metrics client is available, it sends counters and histograms. A counter is a number that goes up, such as “one more goal was created.” A histogram records measured values, such as how many tokens a goal used or how many seconds it ran. If no metrics client is configured, every method quietly does nothing. That makes metrics safe to use in places where telemetry may be disabled.

The file is careful not to double-count. For example, it only records a “resumed” event when a goal moves from paused, blocked, or usage-limited back to active. It only records terminal events when the goal’s status actually changed. Terminal here means an important stopping or limiting state, such as complete, blocked, budget-limited, or usage-limited.

Without this file, the system could still run goals, but operators would lose visibility into how often goals are created, where they stop, how long they take, and how many tokens they consume.

#### Function details

##### `GoalMetrics::new`  (lines 17–19)

```
fn new(metrics_client: Option<MetricsClient>) -> Self
```

**Purpose**: Creates a GoalMetrics helper around an optional metrics client. Code uses this so later goal operations can record measurements if telemetry is available, while still working normally if it is not.

**Data flow**: It receives either a MetricsClient or nothing. It stores that value inside a new GoalMetrics object. The result is a small reusable recorder that other goal code can keep and call later.

**Call relations**: new_with_host_capabilities calls this during setup, after deciding whether metrics support is available from the host. From that point on, the returned GoalMetrics object is passed into goal-related flows that may report events.

*Call graph*: called by 1 (new_with_host_capabilities).


##### `GoalMetrics::record_created`  (lines 21–26)

```
fn record_created(&self)
```

**Purpose**: Records that a new goal was created. This feeds a simple count of goal creation events into the metrics system.

**Data flow**: It looks inside the GoalMetrics object for a metrics client. If none is present, it stops without changing anything. If one is present, it asks the client to increase the goal-created counter by one, and ignores any reporting error so metrics cannot interrupt normal goal work.

**Call relations**: handle_create calls this when a goal is created. The function does not call other project logic; it simply sends the creation count to the metrics client if possible.

*Call graph*: called by 1 (handle_create).


##### `GoalMetrics::record_resumed`  (lines 28–33)

```
fn record_resumed(&self)
```

**Purpose**: Records that a goal resumed work. This is the low-level helper used when the code has already decided a resume event should be counted.

**Data flow**: It checks whether a metrics client is stored. With no client, it returns immediately. With a client, it increases the goal-resumed counter by one and discards any error from the metrics system.

**Call relations**: record_resumed_if_status_changed calls this after confirming that a status change really represents a resume. Keeping this as a separate helper means the actual counter-writing step is simple and reusable.

*Call graph*: called by 1 (record_resumed_if_status_changed).


##### `GoalMetrics::record_resumed_if_status_changed`  (lines 35–52)

```
fn record_resumed_if_status_changed(
        &self,
        previous_status: Option<codex_state::ThreadGoalStatus>,
        goal_status: codex_state::ThreadGoalStatus,
    )
```

**Purpose**: Decides whether a status change should count as a goal being resumed, and records it only in that case. It prevents false resume counts when the goal was already active or changed from some unrelated state.

**Data flow**: It receives the previous goal status, which may be missing, and the new goal status. It checks whether the new status is Active and the previous status was Paused, Blocked, or UsageLimited. If that pattern matches, it calls record_resumed; otherwise it does nothing.

**Call relations**: This function is used when code has both the old and new status and needs a safe way to count resumes. It hands off to record_resumed only after its status-change check says the event is meaningful.

*Call graph*: calls 1 internal fn (record_resumed); 1 external calls (matches!).


##### `GoalMetrics::record_terminal_if_status_changed`  (lines 54–83)

```
fn record_terminal_if_status_changed(
        &self,
        previous_status: Option<codex_state::ThreadGoalStatus>,
        goal: &codex_state::ThreadGoal,
    )
```

**Purpose**: Records important stopping or limiting outcomes for a goal, but only when the goal has newly entered that status. It also records how many tokens and seconds the goal used at that point.

**Data flow**: It receives the previous status and the current ThreadGoal. First it compares the previous status with the goal’s current status; if they are the same, it returns so the event is not counted twice. Then it chooses the right counter for Blocked, UsageLimited, BudgetLimited, or Complete. Active and Paused are not treated as terminal metrics here, so the function returns for those. If a metrics client exists, it increments the chosen counter and records token count and duration histograms tagged with the goal’s status.

**Call relations**: account_active_goal_progress and handle_update call this when goal progress or status changes are processed. The function turns those domain changes into telemetry, sending counters and measurements to the metrics client while leaving normal goal processing unaffected if metrics are unavailable.

*Call graph*: called by 2 (account_active_goal_progress, handle_update).


### Memories usage telemetry
These files define the metric vocabulary and classification logic for memory reads and tool-driven memory usage, then emit the resulting counters.

### `ext/memories/src/metrics.rs`

`io_transport` · `request handling`

The memory tools need a way to answer basic operational questions: Are people calling these tools? Which parts of the memory area are they touching? Are calls succeeding or failing? This file provides that reporting layer.

Its main job is to send a counter metric every time a memory tool is called. A counter is a number that only goes up, like a turnstile counting visitors. The metric is tagged with small pieces of context: the tool name, the operation name, the broad area of memory being used, the success or failure status, and whether a response was truncated, meaning shortened because it was too large.

The file also keeps those tags consistent. Instead of reporting every raw path, `scope_from_path` groups paths into friendly buckets such as `memory_md`, `skills`, or `rollout_summaries`. This matters because metrics systems work best with a small, predictable set of labels. If every unique file path became a label, dashboards could become noisy, expensive, or hard to search.

If no metrics client is available, recording quietly does nothing. That lets the memory tools run normally in environments where telemetry is disabled or not configured.

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

**Purpose**: Records that a memory tool operation was attempted. It captures enough context to later see which operation ran, what memory area it touched, whether it succeeded, and whether the result was shortened.

**Data flow**: It receives an optional metrics client, an operation name, a scope label, a success flag, and a truncation label. If there is no metrics client, it stops immediately and changes nothing. If metrics are available, it builds a full tool name using the memory tools namespace, converts the success flag into `succeeded` or `failed`, and sends a counter increment with all these labels attached.

**Call relations**: The memory tool call flow invokes this after handling different tool requests. Before sending the metric, it asks `status_tag` to turn the true-or-false success value into a readable label, then hands the finished metric to the metrics client.

*Call graph*: calls 1 internal fn (status_tag); called by 4 (handle_call, handle_call, handle_call, handle_call); 1 external calls (format!).


##### `scope_from_path`  (lines 32–53)

```
fn scope_from_path(path: &str) -> &'static str
```

**Purpose**: Turns a specific memory-related path into a broad category name for metrics. This keeps reporting useful without exposing or multiplying every individual path.

**Data flow**: It receives a path string, trims leading and trailing slashes, and ignores a leading `./` if present. It then compares the cleaned path with known memory locations and returns a fixed label such as `root`, `memory_md`, `skills`, `ad_hoc_notes`, or `other`.

**Call relations**: The memory tool call flow uses this when it has a concrete path and needs a stable scope label before recording metrics. Its output is typically passed onward to `record_tool_call` as the `scope` tag.

*Call graph*: called by 1 (handle_call).


##### `scope_from_optional_path`  (lines 55–57)

```
fn scope_from_optional_path(path: Option<&str>, default: &'static str) -> &'static str
```

**Purpose**: Chooses a scope label when a path may or may not be present. It gives callers a clean way to use a default label if there is no path to inspect.

**Data flow**: It receives an optional path and a default scope label. If the path exists, it sends that path through `scope_from_path` and returns the resulting category. If the path is missing, it returns the provided default unchanged.

**Call relations**: The memory tool call flow uses this for operations where a path is optional. It either delegates to `scope_from_path` for real path classification or supplies the caller’s default scope so metric recording can still proceed.

*Call graph*: called by 2 (handle_call, handle_call).


##### `truncated_tag`  (lines 59–65)

```
fn truncated_tag(truncated: Option<bool>) -> &'static str
```

**Purpose**: Turns an optional truncation value into a clear metric label. This lets dashboards distinguish between responses that were shortened, not shortened, or where that information was not known.

**Data flow**: It receives an optional true-or-false value. `Some(true)` becomes `true`, `Some(false)` becomes `false`, and a missing value becomes `unknown`. It returns one of those three fixed strings.

**Call relations**: The memory tool call flow uses this before recording metrics for calls where truncation may be relevant. The returned label is passed to `record_tool_call` as the `truncated` tag.

*Call graph*: called by 3 (handle_call, handle_call, handle_call).


##### `status_tag`  (lines 67–69)

```
fn status_tag(success: bool) -> &'static str
```

**Purpose**: Converts a success flag into the metric wording used for call outcomes. It keeps success and failure labels consistent everywhere this file records tool calls.

**Data flow**: It receives a boolean value. If the value is true, it returns `succeeded`; if false, it returns `failed`.

**Call relations**: `record_tool_call` uses this while building the metric tags. It is a small helper kept private to this file because only the metric-recording code needs it.

*Call graph*: called by 1 (record_tool_call).


### `memories/read/src/metrics.rs`

`config` · `cross-cutting telemetry`

This file is a tiny but useful naming anchor for telemetry. Telemetry means the measurements a system records so people can understand how it is behaving, such as how often a feature is used. Here, the feature is “memories,” and the metric name is stored in one public constant: `MEMORIES_USAGE_METRIC`.

Instead of writing the text `codex.memories.usage` directly in many places, other code can import this constant. That is like putting an address in a shared contacts list instead of typing it from memory every time. If the metric name ever needs to change, it can be changed here in one place, and the rest of the code can keep referring to the same constant.

Without this file, callers might duplicate the metric string by hand. That can lead to small spelling differences, which would split the recorded data across multiple metric names and make usage reports misleading.


### `memories/read/src/usage.rs`

`domain_logic` · `tool command analysis and metric reporting`

This file exists so the system can measure how different memory sources are being used without treating every file path as a separate thing. For example, reading `memories/MEMORY.md` and searching inside `memories/skills/` are different kinds of memory usage, and this code classifies them into a few clear buckets.

The main idea is cautious: it first parses the user’s shell command, then only continues if every parsed command is known to be safe. That matters because shell text can be complicated, and the system does not want to draw conclusions from commands it does not trust or understand. If parsing fails, or if any command is not on the safe list, it returns no usage categories.

Once the command is considered safe, the file parses it into higher-level actions such as “read this path” or “search this path.” It then checks the path text for known memory locations, such as `MEMORY.md`, `memory_summary.md`, raw memories, rollout summaries, or skills. Each match becomes a `MemoriesUsageKind` value. That value can later be turned into a short metric tag, like a label on a filing cabinet drawer.

#### Function details

##### `MemoriesUsageKind::as_tag`  (lines 18–26)

```
fn as_tag(self) -> &'static str
```

**Purpose**: This converts a memory usage category into the short text label used for metrics. It gives the rest of the system stable names like `memory_md` or `skills` instead of exposing Rust enum names directly.

**Data flow**: It starts with one `MemoriesUsageKind` value, such as `MemorySummary`. It matches that value to its fixed lowercase tag string. The output is a static text label, and nothing else is changed.

**Call relations**: After some other code has identified what kind of memory was used, this method provides the metric-friendly name for that category. It is the final labeling step before the category can be counted or reported.


##### `memories_usage_kinds_from_command`  (lines 29–48)

```
fn memories_usage_kinds_from_command(command: &str) -> Vec<MemoriesUsageKind>
```

**Purpose**: This looks at a shell command and returns the memory categories that command reads or searches. It is used when the system wants to emit a metric for tool-based memory access.

**Data flow**: It receives raw shell command text. First it tries to split that text into shell commands; if that fails, it returns an empty list. Next it checks that every command is known to be safe; if not, it again returns an empty list. Then it parses the command into actions like reading a file or searching a path, asks `get_memory_kind` whether each relevant path belongs to a known memory area, and returns the matching categories as a list.

**Call relations**: `emit_metric_for_tool_read` calls this function when it needs to know what kind of memory a tool command touched. This function relies on shell parsing helpers to understand the command safely, then hands each read or search path to `get_memory_kind` to classify it.

*Call graph*: calls 2 internal fn (parse_shell_script_into_commands, parse_shell_script); called by 1 (emit_metric_for_tool_read); 1 external calls (new).


##### `get_memory_kind`  (lines 50–64)

```
fn get_memory_kind(path: String) -> Option<MemoriesUsageKind>
```

**Purpose**: This checks one file path and decides whether it points to a known kind of memory content. It is the small lookup rulebook for mapping memory paths to memory usage categories.

**Data flow**: It takes a path as text. It checks whether that text contains one of the recognized memory path patterns, such as `memories/MEMORY.md` or `memories/skills/`. If a pattern matches, it returns the matching `MemoriesUsageKind`; if none match, it returns nothing.

**Call relations**: `memories_usage_kinds_from_command` uses this function after it has found a read or search path inside a safe command. This helper does the focused path-to-category decision, while the caller takes care of command parsing and collecting the results.


### `core/src/memory_usage.rs`

`domain_logic` · `tool completion / telemetry reporting`

This file answers a simple question: “Did a tool invocation read memory data, and should we count that?” In this project, tools can run commands such as shell commands or exec commands. Some of those commands may access memory-related files or features. Rather than guessing later, this file looks at the command text at the moment the tool finishes and emits a metric if the command matches known memory-use patterns.

The main flow is like a checkout scanner. First it tries to pull the actual command string out of the tool invocation. If the invocation is not a supported function-style command, or its arguments cannot be understood, it quietly stops. Then it asks a memory-usage helper to classify the command into one or more “kinds” of memory usage. For each kind, it increments a telemetry counter. The counter includes tags: the memory kind, the tool name in a flattened readable form, and whether the tool run succeeded.

An important detail is that this file is deliberately conservative. If it cannot confidently extract a shell script from the tool call, it records nothing. That avoids misleading metrics from unrelated or malformed tool calls.

#### Function details

##### `emit_metric_for_tool_read`  (lines 9–27)

```
fn emit_metric_for_tool_read(invocation: &ToolInvocation, success: bool)
```

**Purpose**: This function records a memory-usage metric for a completed tool invocation, but only when the tool contains a recognizable command. It is used so the system can later understand how often memory data is being read, by which tool, and whether those attempts succeeded.

**Data flow**: It receives a tool invocation and a success flag. It first asks for the command text hidden inside that invocation; if no supported command is found, it does nothing. If a command is found, it turns the success flag into a text tag, flattens the tool name into a metric-friendly label, asks which memory-usage kinds the command matches, and increments one telemetry counter for each matched kind.

**Call relations**: After a tool finishes, dispatch_any_with_terminal_outcome calls this function as part of reporting the final outcome. This function delegates command extraction to shell_script_for_invocation, uses flat_tool_name to make the tool name safe for telemetry tags, and relies on memories_usage_kinds_from_command to decide whether the command represents memory reading before it writes the metric.

*Call graph*: calls 3 internal fn (shell_script_for_invocation, flat_tool_name, memories_usage_kinds_from_command); called by 1 (dispatch_any_with_terminal_outcome).


##### `shell_script_for_invocation`  (lines 29–46)

```
fn shell_script_for_invocation(invocation: &ToolInvocation) -> Option<String>
```

**Purpose**: This helper tries to extract the actual command string from a tool invocation. It supports the project’s two plain command tools: shell_command and exec_command.

**Data flow**: It receives a tool invocation and looks at its payload. If the payload is not a function call with JSON arguments, it returns nothing. If the tool is shell_command, it parses the arguments as shell command parameters and returns the command field. If the tool is exec_command, it parses the arguments as exec command parameters and returns the cmd field. For namespaced tools, unknown tools, or invalid JSON, it returns nothing.

**Call relations**: emit_metric_for_tool_read calls this first because telemetry only makes sense when there is real command text to inspect. This helper does not emit metrics itself; it only hands back the command string, or declines by returning no value when the invocation is not one of the supported command shapes.

*Call graph*: called by 1 (emit_metric_for_tool_read).


### `memories/write/src/metrics.rs`

`config` · `cross-cutting`

This file is a small label sheet for observability. Observability means the information a running system emits so people can understand what it is doing, such as timings, counts, and token usage. Here, each constant is the official text name of a metric related to the memory-writing pipeline.

The metrics are grouped around startup and two phases of work. The startup metric marks memory system startup. Phase one metrics track how many phase-one jobs happen, how long the phase takes end to end, what it outputs, and how many model tokens it uses. Phase two has matching labels for its jobs, total time, input, and token use.

The important point is not that this file performs measurement itself. It does not start timers, count jobs, or send data anywhere. Instead, it provides the exact names that other code uses when reporting those measurements. Like printed labels on folders, these constants make sure all reports land under the same names. Without this file, metric names might be copied by hand in several places, making mistakes harder to find and dashboards or alerts less reliable.


### SQLite startup telemetry
These files adapt metrics sinks and classify database initialization outcomes so lightweight SQLite startup and fallback behavior is reported consistently.

### `rollout/src/sqlite_metrics.rs`

`io_transport` · `cross-cutting during database activity`

Database code often wants to say things like “one query ran” or “this operation took 12 milliseconds,” but it should not need to know the details of the metrics system. This file is the small adapter between those two worlds. It implements the database telemetry interface, `DbTelemetry`, using a `MetricsClient` from `codex_otel`, which is the project’s observability layer for recording measurements.

The key idea is that every metric is given an extra label called an originator tag. A tag is a small piece of text attached to a metric so people can later filter or group it, like putting a return address on a letter. Here, the originator says which part of the system produced the database metric. The `recorder` function builds a shared telemetry object, wrapping it in an `Arc` so multiple parts of the program can safely hold the same recorder. It also trims or normalizes the originator value through `bounded_originator_tag_value`, so the tag stays within expected limits.

When database code records a counter or duration, this adapter adds the originator tag, then forwards the metric to the real metrics client. It deliberately ignores errors from the metrics client, so a failure to report telemetry does not break normal database work.

#### Function details

##### `OtelDbTelemetry::counter`  (lines 15–18)

```
fn counter(&self, name: &str, inc: i64, tags: &[(&str, &str)])
```

**Purpose**: Records a count-based database metric, such as “this happened once” or “five rows were affected.” It also adds the originator label so the metric can be traced back to the part of the system that produced it.

**Data flow**: It receives a metric name, an amount to add, and any existing tags. It copies those tags, adds the originator tag, and sends the finished metric to the metrics client. Nothing is returned, and any reporting error is ignored so telemetry cannot interrupt database work.

**Call relations**: Database telemetry users call this through the `DbTelemetry` interface when they want to report a count. Before handing the metric to the underlying metrics client’s `counter` call, it asks `with_originator` to add the required originator tag.

*Call graph*: calls 2 internal fn (counter, with_originator).


##### `OtelDbTelemetry::record_duration`  (lines 20–23)

```
fn record_duration(&self, name: &str, duration: Duration, tags: &[(&str, &str)])
```

**Purpose**: Records how long a database-related action took. This is used for timing measurements, such as how long a query or transaction lasted.

**Data flow**: It receives a metric name, a time duration, and any existing tags. It adds the originator tag to those tags, then forwards the name, duration, and completed tag list to the metrics client. It returns nothing and does not let telemetry failures affect the caller.

**Call relations**: Database telemetry users call this through the `DbTelemetry` interface when they need to report timing information. It relies on `with_originator` to prepare the tags, then passes the measurement to the underlying metrics client’s `record_duration` call.

*Call graph*: calls 2 internal fn (record_duration, with_originator).


##### `recorder`  (lines 26–31)

```
fn recorder(metrics: codex_otel::MetricsClient, originator: &str) -> DbTelemetryHandle
```

**Purpose**: Creates the database telemetry recorder used by SQLite-related code. It packages a metrics client together with a safe originator label and returns it in a shared handle.

**Data flow**: It takes a metrics client and an originator string. It converts the originator into a bounded static tag value, builds an `OtelDbTelemetry` object with that value, wraps it in an `Arc` shared pointer, and returns it as a `DbTelemetryHandle`.

**Call relations**: The wider rollout setup calls this from `sqlite_telemetry_recorder` when it needs a telemetry object for SQLite. After this function builds the adapter, database code can use the returned handle without knowing anything about the OpenTelemetry metrics client underneath.

*Call graph*: called by 1 (sqlite_telemetry_recorder); 2 external calls (new, bounded_originator_tag_value).


##### `with_originator`  (lines 33–40)

```
fn with_originator(
    tags: &[(&'a str, &'a str)],
    originator: &'static str,
) -> Vec<(&'a str, &'a str)>
```

**Purpose**: Adds the standard originator tag to a metric’s existing tags. This keeps every database metric consistently labeled with its source.

**Data flow**: It receives a slice of existing tag pairs and the originator value. It copies the tags into a new list, appends the originator tag, and returns the new list. The original tag list is not changed.

**Call relations**: Both `OtelDbTelemetry::counter` and `OtelDbTelemetry::record_duration` call this just before sending data to the metrics client. It is the small shared helper that makes sure both count and timing metrics carry the same origin information.

*Call graph*: called by 2 (counter, record_duration).


### `state/src/telemetry.rs`

`util` · `database startup and fallback reporting`

This file is a small reporting layer for the project’s SQLite databases. Its job is to answer questions like: did the database start successfully, how long did it take, which database was it, and if it failed, what broad kind of error happened? Without this file, startup problems would be harder to understand from logs or metrics, and fallback paths could happen silently.

The main idea is deliberately simple. A `DbTelemetry` sink is something that can count events and record durations. Startup code can install one shared, process-wide sink after telemetry has been set up. Later database code can either use that shared sink or pass in a specific one. If no sink exists, the recording functions quietly do nothing. This is important: monitoring must never be the reason the database fails.

The file also keeps metric labels low-cardinality, meaning it uses a small fixed set of tag values instead of unbounded details like full error messages. This keeps monitoring systems healthy and searchable. For example, it turns database errors into broad labels such as `busy`, `locked`, `io`, `serde`, or `constraint`.

In short, this file acts like a dashboard clerk: it notes that something happened, puts it into a small set of useful categories, and moves on without interrupting the real work.

#### Function details

##### `install_process_db_telemetry`  (lines 29–36)

```
fn install_process_db_telemetry(telemetry: DbTelemetryHandle) -> bool
```

**Purpose**: Installs the shared telemetry sink that database code can use when it wants to report metrics. It only accepts the first sink installed, so later duplicate setup attempts do not replace the original.

**Data flow**: It receives a telemetry handle. If no process-wide database telemetry sink has been set yet, it stores this handle and returns `true`. If one is already present, it leaves the existing sink in place, writes a debug message, and returns `false`.

**Call relations**: Startup code is expected to call this after the broader telemetry system is ready. Later, `record_counter` and `record_duration` can find this installed sink through `resolve_telemetry` when callers do not provide their own sink.

*Call graph*: 1 external calls (debug!).


##### `DbKind::as_str`  (lines 47–54)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns an internal database kind into the short text label used in telemetry tags. This keeps metric output consistent, using names like `state`, `logs`, `goals`, and `memories`.

**Data flow**: It receives a `DbKind` value. It matches that value to a fixed string. The string is returned so it can be attached to a metric as the database name.

**Call relations**: It is used by `record_init_result` when building the tags for startup metrics. That lets callers pass a typed database choice while the telemetry system sends plain text labels.

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

**Purpose**: Records both the result and the duration of a database initialization step. It is used to show whether startup phases succeeded or failed, how long they took, and which database and phase were involved.

**Data flow**: It receives an optional telemetry sink, a database kind, a phase name, a duration, and the operation result. It turns the result into simple outcome tags, turns the database kind into a label, then records one counter metric and one duration metric. It returns nothing; its effect is sending telemetry if a sink is available.

**Call relations**: Database startup paths such as `init_inner` and `open_sqlite`, plus `record_backfill_gate`, call this after an initialization attempt. It relies on `DbOutcomeTags::from_result` to summarize success or failure, `DbKind::as_str` for the database label, and then hands the final metric data to `record_counter` and `record_duration`.

*Call graph*: calls 4 internal fn (as_str, from_result, record_counter, record_duration); called by 3 (init_inner, open_sqlite, record_backfill_gate).


##### `record_backfill_gate`  (lines 75–81)

```
fn record_backfill_gate(
    telemetry: Option<&dyn DbTelemetry>,
    duration: Duration,
    result: &anyhow::Result<()>,
)
```

**Purpose**: Records telemetry for the state database’s `backfill_gate` phase. A backfill is a process that fills in missing or older data, and this function reports whether that gate step worked and how long it took.

**Data flow**: It receives an optional telemetry sink, the time spent, and a success-or-failure result. It fills in the database kind as `State` and the phase name as `backfill_gate`, then passes everything to `record_init_result`. It returns nothing.

**Call relations**: This is a convenience wrapper around `record_init_result`. Callers use it when they specifically want to report the state database backfill gate without repeating the database and phase labels.

*Call graph*: calls 1 internal fn (record_init_result).


##### `record_fallback`  (lines 83–93)

```
fn record_fallback(
    caller: &'static str,
    reason: &'static str,
    telemetry_override: Option<&dyn DbTelemetry>,
)
```

**Purpose**: Records that the code used a fallback path, along with who triggered it and why. This helps operators notice when the system is surviving by using a backup behavior instead of the preferred one.

**Data flow**: It receives a caller label, a reason label, and an optional telemetry sink. It packages the caller and reason as tags, then records a fallback counter. It returns nothing; it only sends the metric if telemetry is available.

**Call relations**: Code that chooses a fallback path calls this at the moment the fallback is taken. It delegates the actual metric sending to `record_counter`, which chooses either the supplied telemetry sink or the process-wide one.

*Call graph*: calls 1 internal fn (record_counter).


##### `record_counter`  (lines 95–99)

```
fn record_counter(telemetry: Option<&dyn DbTelemetry>, name: &str, tags: &[(&str, &str)])
```

**Purpose**: Records a single count for a named metric. It is the shared helper for events where the important question is “how many times did this happen?”

**Data flow**: It receives an optional telemetry sink, a metric name, and tags. It asks `resolve_telemetry` for the sink to use. If one exists, it increments the named counter by 1 with those tags; if not, it does nothing.

**Call relations**: `record_init_result` uses this to count database initialization outcomes, and `record_fallback` uses it to count fallback events. It sits between higher-level reporting functions and the actual `DbTelemetry` implementation.

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

**Purpose**: Records how long a named operation took. It is the shared helper for timing metrics, such as database initialization duration.

**Data flow**: It receives an optional telemetry sink, a metric name, a duration, and tags. It asks `resolve_telemetry` for a usable sink. If one exists, it records the duration with the given name and tags; if not, it quietly skips recording.

**Call relations**: `record_init_result` calls this after building the tags for a database startup phase. Like `record_counter`, it hides the detail of whether telemetry came from an explicit override or the process-wide sink.

*Call graph*: calls 1 internal fn (resolve_telemetry); called by 1 (record_init_result).


##### `resolve_telemetry`  (lines 112–114)

```
fn resolve_telemetry(telemetry: Option<&dyn DbTelemetry>) -> Option<&dyn DbTelemetry>
```

**Purpose**: Chooses which telemetry sink should be used for a metric. It prefers the sink passed directly by the caller, and falls back to the process-wide sink if one was installed.

**Data flow**: It receives an optional telemetry reference. If that reference is present, it returns it. Otherwise, it looks for the globally installed database telemetry sink and returns that if available. If neither exists, it returns nothing.

**Call relations**: `record_counter` and `record_duration` both call this before sending metrics. This keeps the fallback rule in one place, so all database telemetry behaves the same way.

*Call graph*: called by 2 (record_counter, record_duration).


##### `DbOutcomeTags::from_result`  (lines 122–133)

```
fn from_result(result: &anyhow::Result<T>) -> Self
```

**Purpose**: Turns a success-or-failure result into simple telemetry labels. It marks successful operations as `success` with no error, and failed operations as `failed` with a broad error category.

**Data flow**: It receives a result from some database operation. If the result is successful, it creates tags saying status is `success` and error is `none`. If the result is an error, it calls `classify_error` to choose a short error label, then creates tags saying status is `failed`.

**Call relations**: `record_init_result` calls this while preparing initialization metrics. When there is a failure, this function hands the detailed error to `classify_error` so the metric gets a safe, limited category instead of a noisy full error message.

*Call graph*: calls 1 internal fn (classify_error); called by 1 (record_init_result).


##### `classify_error`  (lines 136–155)

```
fn classify_error(err: &anyhow::Error) -> &'static str
```

**Purpose**: Looks through an error and its causes, then chooses a broad category for telemetry. This makes failures easier to group without exposing or storing detailed error text in metrics.

**Data flow**: It receives an `anyhow::Error`, which can wrap several underlying causes. It walks through that chain of causes. If it finds a SQL database error, migration error, JSON parsing error, or input/output error, it returns the matching category. If nothing recognizable is found, it returns `unknown`.

**Call relations**: `DbOutcomeTags::from_result` calls this for failed results. If the error is from SQLx, the database library used here, it passes that error to `classify_sqlx_error` for more specific classification.

*Call graph*: calls 1 internal fn (classify_sqlx_error); called by 1 (from_result); 1 external calls (chain).


##### `classify_sqlx_error`  (lines 157–172)

```
fn classify_sqlx_error(err: &sqlx::Error) -> &'static str
```

**Purpose**: Classifies errors reported by SQLx, the library used to talk to SQL databases. It turns detailed SQLx error variants into stable labels such as `pool_timeout`, `io`, `serde`, or a SQLite-specific category.

**Data flow**: It receives a SQLx error. If the error came from the database itself, it reads the database error code and sends it to `classify_sqlite_code`. If it is a timeout, input/output error, or JSON decoding problem, it returns the matching label. Anything else becomes `unknown`.

**Call relations**: `classify_error` calls this when it finds a SQLx error in the error chain. For actual SQLite result codes, this function hands off to `classify_sqlite_code` so SQLite’s numeric codes are translated in one dedicated place.

*Call graph*: calls 1 internal fn (classify_sqlite_code); called by 1 (classify_error); 1 external calls (Borrowed).


##### `classify_sqlite_code`  (lines 174–190)

```
fn classify_sqlite_code(code: &str) -> &'static str
```

**Purpose**: Translates SQLite numeric result codes into short human-readable categories for telemetry. For example, it can turn SQLite’s `5` into `busy` and a constraint failure into `constraint`.

**Data flow**: It receives a SQLite result code as text. It tries to parse it as a number, extracts the primary SQLite code from the low byte, then matches that code to a fixed label such as `locked`, `readonly`, `corrupt`, or `cantopen`. If parsing fails or the code is not recognized, it returns `unknown`.

**Call relations**: `classify_sqlx_error` calls this when SQLx reports a database error with a SQLite code. The test in this file also calls it indirectly through assertions to confirm normal and extended SQLite codes are categorized correctly.

*Call graph*: called by 1 (classify_sqlx_error).


##### `tests::classifies_extended_sqlite_codes`  (lines 198–202)

```
fn classifies_extended_sqlite_codes()
```

**Purpose**: Checks that SQLite error code classification works for both ordinary codes and extended codes. Extended codes are larger numbers that still contain the main SQLite error type inside them.

**Data flow**: It supplies sample SQLite code strings to `classify_sqlite_code`. It compares the returned labels with the expected labels. If any label differs, the test fails.

**Call relations**: This test protects the behavior of `classify_sqlite_code`, especially the detail that extended SQLite codes should still map to their primary category. It runs only during the test lifecycle, not in normal application execution.

*Call graph*: 1 external calls (assert_eq!).
