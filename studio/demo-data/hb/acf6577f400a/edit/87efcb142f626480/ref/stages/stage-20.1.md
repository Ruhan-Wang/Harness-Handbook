# Analytics event modeling, reduction, and emitters  `stage-20.1`

This stage is the analytics engine room: shared support that watches what the app is doing, turns those observations into clean event records, and ships them out. It sits behind the main work of the system rather than being startup or shutdown code.

The flow starts with facts.rs, which defines the internal “facts” the system notices in memory, like a turn starting, a plugin being used, or an error happening. accepted_lines.rs adds one special input: it reads code diffs, summarizes which added lines were accepted, and creates privacy-safer fingerprints and repository hashes instead of sending raw file paths or remote URLs.

reducer.rs is the heart of the stage. It acts like a sorter on a conveyor belt, combining scattered facts from requests and notifications into complete analytics events. events.rs defines what those finished, sendable event payloads look like and converts facts into that wire-ready form, including extra timing and session details for guardian review tracking.

client.rs is the front door other code uses. It queues facts in the background, deduplicates repeated events, batches special cases, and sends results over HTTP or to a debug file. lib.rs ties these pieces together, while analytics_utils.rs and ext/goal/src/analytics.rs are small adapters that plug analytics into the app server and goal features.

## Files in this stage

### Analytics domain model
These files define the analytics crate surface along with the internal facts and serialized event schemas that the rest of the subsystem builds on.

### `analytics/src/facts.rs`

`data_model` · `cross-cutting; facts are created throughout request handling and consumed during analytics reduction`

This file collects the raw and semi-normalized inputs consumed by the analytics reducer. `AnalyticsFact` is the top-level envelope spanning protocol-surface observations (`Initialize`, client/server requests and responses, notifications) and `CustomAnalyticsFact` values for analytics-only signals such as compaction, guardian review, turn config resolution, token usage, skill invocation, and plugin state changes. Supporting structs like `TrackEventsContext`, `TurnResolvedConfigFact`, `TurnTokenUsageFact`, `TurnProfileFact`, `CodexCompactionEvent`, and `CodexGoalEvent` preserve the exact identifiers and counters later needed to build final event payloads.

The file also defines several enums that intentionally narrow broader protocol/core concepts into analytics-safe categories. `CodexErrKind` collapses the large `CodexErr` space into a serializable taxonomy while preserving optional HTTP status separately in `TurnCodexError`. `TurnSteerRejectionReason` similarly unifies request-level and input-level steer failures through `From` conversions from `TurnSteerRequestError` and `InputError`.

Most behavior here is conversion-oriented. `build_track_events_context` packages model/thread/turn IDs for repeated use by app/plugin/hook event helpers. `TurnCodexErrorFact::from_codex_err` and `TurnCodexError::from_codex_err` snapshot a `CodexErr` into analytics-friendly fields at the time of failure, avoiding later dependence on richer error internals. The rest of the file is intentionally data-heavy and behavior-light so the reducer can accumulate facts without needing protocol-specific logic scattered across the codebase.

#### Function details

##### `build_track_events_context`  (lines 46–56)

```
fn build_track_events_context(
    model_slug: String,
    thread_id: String,
    turn_id: String,
) -> TrackEventsContext
```

**Purpose**: Packages the current model, thread, and turn identifiers into the reusable context object used by several analytics helpers.

**Data flow**: Consumes three `String` arguments (`model_slug`, `thread_id`, `turn_id`) and returns a `TrackEventsContext` containing those values unchanged.

**Call relations**: Called by upstream analytics producers before emitting app, hook, plugin, or skill facts. It is a simple constructor with no downstream delegation.


##### `TurnCodexErrorFact::from_codex_err`  (lines 129–135)

```
fn from_codex_err(thread_id: String, turn_id: String, error: &CodexErr) -> Self
```

**Purpose**: Builds a turn-scoped analytics error fact from a richer `CodexErr` value.

**Data flow**: Consumes `thread_id`, `turn_id`, and a borrowed `CodexErr`. It delegates error normalization to `TurnCodexError::from_codex_err`, stores the resulting simplified error alongside the identifiers, and returns a `TurnCodexErrorFact`.

**Call relations**: Used when turn failures are recorded for analytics, including explicit turn error tracking and failure-event tests. It is the public constructor that bridges core errors into reducer-consumable facts.

*Call graph*: calls 1 internal fn (from_codex_err); called by 2 (turn_lifecycle_emits_failed_turn_event, track_turn_codex_error).


##### `TurnCodexError::from_codex_err`  (lines 186–191)

```
fn from_codex_err(error: &CodexErr) -> Self
```

**Purpose**: Extracts the analytics-relevant pieces of a `CodexErr`: its normalized kind and optional HTTP status code.

**Data flow**: Reads a borrowed `CodexErr`, converts it into `CodexErrKind` via `Into`, reads `http_status_code_value()`, and returns a `TurnCodexError` containing those two fields.

**Call relations**: Called only by `TurnCodexErrorFact::from_codex_err` so callers do not need to know the normalization details.

*Call graph*: calls 1 internal fn (http_status_code_value); called by 1 (from_codex_err); 1 external calls (into).


##### `CodexErrKind::from`  (lines 195–238)

```
fn from(error: &CodexErr) -> Self
```

**Purpose**: Maps each supported `CodexErr` variant into the analytics error taxonomy.

**Data flow**: Consumes a borrowed `CodexErr`, pattern-matches every variant, and returns the corresponding `CodexErrKind`. Linux-only Landlock variants are conditionally compiled to preserve platform-specific fidelity.

**Call relations**: Used indirectly through `TurnCodexError::from_codex_err` whenever a turn error is captured for analytics.


##### `TurnSteerRejectionReason::from`  (lines 309–314)

```
fn from(error: InputError) -> Self
```

**Purpose**: Converts a `TurnSteerRequestError` into the serialized analytics rejection reason for turn-steer failures.

**Data flow**: Consumes a `TurnSteerRequestError`, matches its variant, and returns the corresponding `TurnSteerRejectionReason`.

**Call relations**: Used by reducer error handling through `rejection_reason_from_error_type` when a turn-steer request fails before acceptance.


### `analytics/src/events.rs`

`data_model` · `cross-cutting; whenever analytics events are constructed for emission`

This file is the schema layer for analytics emission. Nearly every analytics event shape is represented as a `#[derive(Serialize)]` struct or enum, including thread initialization, turn lifecycle, compaction, goals, hook runs, app/plugin usage, tool-item events, guardian reviews, and accepted-line fingerprints. `TrackEventRequest` is the central untagged enum that wraps all outbound event variants; its `should_send_in_isolated_request` special-cases accepted-line fingerprint uploads so they can be sent separately from normal batches.

A notable cluster of types models guardian review telemetry in detail: `GuardianReviewedAction` captures the reviewed operation shape, `GuardianReviewTrackContext` stores immutable identifiers plus a wall-clock start timestamp and `Instant`, and `GuardianReviewAnalyticsResult` carries the eventual decision/session outcome. `GuardianReviewTrackContext::event_params` merges those two sources, converts millisecond timestamps to seconds for `started_at`/`completed_at`, computes `completion_latency_ms` from elapsed monotonic time, and extracts token counts from optional `TokenUsage`.

The helper functions are concrete mappers from internal facts to event payloads. They preserve thread/turn/model context from `TrackEventsContext`, normalize hook names/sources/statuses into analytics-friendly strings, derive plugin metadata including remote-plugin overrides and connector IDs, and build compaction/goal payloads by copying all fact fields plus session/runtime/client metadata. `current_runtime_metadata` snapshots package version and OS details, while `subagent_thread_started_event_request` synthesizes a full `codex_thread_initialized` event for in-process subagent threads with `rpc_transport` fixed to `InProcess` and `thread_source` fixed to `Subagent`.

#### Function details

##### `TrackEventRequest::should_send_in_isolated_request`  (lines 89–91)

```
fn should_send_in_isolated_request(&self) -> bool
```

**Purpose**: Identifies event variants that must be transmitted outside the normal batch flow. At present only `AcceptedLineFingerprints` is treated this way.

**Data flow**: Reads `self` by reference, pattern-matches its enum variant, and returns a `bool` indicating whether the event should be isolated. It does not mutate any state.

**Call relations**: Used by the analytics sending path after reducer/event construction to decide batching behavior; it is a leaf classification helper and delegates only to the pattern match.

*Call graph*: 1 external calls (matches!).


##### `GuardianReviewTrackContext::new`  (lines 309–329)

```
fn new(
        thread_id: String,
        turn_id: String,
        review_id: String,
        target_item_id: Option<String>,
        approval_request_source: GuardianApprovalRequestSource,
        r
```

**Purpose**: Creates the immutable tracking context for a single guardian review attempt, capturing identifiers, reviewed action metadata, timeout, and both wall-clock and monotonic start times.

**Data flow**: Consumes thread/turn/review identifiers, optional target item ID, approval source, reviewed action, and timeout. It reads the current time via `now_unix_millis()` and `Instant::now()`, stores those values into a new `GuardianReviewTrackContext`, and returns it.

**Call relations**: Called when guardian review execution begins so later analytics can compute latency and reuse the same identifiers. It does not call into analytics emission directly; later code passes the resulting context to `GuardianReviewTrackContext::event_params`.

*Call graph*: called by 1 (run_guardian_review); 2 external calls (now, now_unix_millis).


##### `GuardianReviewTrackContext::event_params`  (lines 331–380)

```
fn event_params(
        &self,
        result: GuardianReviewAnalyticsResult,
        completed_at_ms: u64,
    ) -> GuardianReviewEventParams
```

**Purpose**: Builds the final `GuardianReviewEventParams` payload by combining the stored review context with the eventual analytics result and completion timestamp.

**Data flow**: Reads `self` fields, clones owned identifiers/action data, consumes a `GuardianReviewAnalyticsResult`, and takes `completed_at_ms`. It computes `completion_latency_ms` from `started_instant.elapsed()`, converts stored and completed millisecond timestamps to seconds for `started_at` and `completed_at`, maps optional `TokenUsage` into individual token counters, and returns a fully populated `GuardianReviewEventParams`.

**Call relations**: Invoked by guardian-review tracking code once a review finishes. It is the bridge between runtime review execution and the reducer’s later `CustomAnalyticsFact::GuardianReview` ingestion.

*Call graph*: called by 1 (track_guardian_review); 2 external calls (elapsed, clone).


##### `GuardianReviewAnalyticsResult::without_session`  (lines 408–431)

```
fn without_session() -> Self
```

**Purpose**: Constructs the default fail-closed guardian review analytics result for cases where no guardian session metadata exists.

**Data flow**: Takes no inputs and returns a `GuardianReviewAnalyticsResult` with `decision` set to `Denied`, `terminal_status` to `FailedClosed`, `attempt_count` to 1, and all session/model/token-related fields set to `None` or false-like defaults.

**Call relations**: Used by multiple guardian-review execution paths and tests as the baseline result before session-specific fields are known. `GuardianReviewAnalyticsResult::from_session` builds on top of this default.

*Call graph*: called by 11 (guardian_review_metrics_record_counts_durations_and_token_usage, run_guardian_review, run_guardian_review_session_before_deadline, run_ephemeral_review, run_review, wait_for_guardian_review_cancel_drains_expected_turn_after_stale_terminal_event, wait_for_guardian_review_ignores_prior_turn_aborts, wait_for_guardian_review_ignores_prior_turn_completion, wait_for_guardian_review_ignores_prior_turn_errors, wait_for_guardian_review_preserves_structured_session_error (+1 more)).


##### `GuardianReviewAnalyticsResult::from_session`  (lines 433–449)

```
fn from_session(params: GuardianReviewSessionAnalyticsParams) -> Self
```

**Purpose**: Creates a guardian review analytics result pre-populated with session/model metadata while inheriting the default fail-closed outcome fields.

**Data flow**: Consumes `GuardianReviewSessionAnalyticsParams`, copies its guardian-thread/session/model/catalog fields into a new `GuardianReviewAnalyticsResult`, fills `had_prior_review_context`, and uses `without_session()` for the remaining default decision/status/token fields.

**Call relations**: Called when a guardian review runs on an actual guardian session. It delegates to `without_session` so callers can later overwrite decision/outcome fields without re-specifying session metadata.

*Call graph*: called by 1 (run_review_on_session); 1 external calls (without_session).


##### `plugin_state_event_type`  (lines 963–970)

```
fn plugin_state_event_type(state: PluginState) -> &'static str
```

**Purpose**: Maps a `PluginState` enum to the exact analytics event type string used for plugin lifecycle events.

**Data flow**: Consumes a `PluginState` value and returns a static string such as `codex_plugin_installed` or `codex_plugin_disabled`.

**Call relations**: Used by reducer plugin-state ingestion when wrapping plugin metadata into the correct `TrackEventRequest` variant and event type.

*Call graph*: called by 1 (ingest_plugin_state_changed).


##### `codex_app_metadata`  (lines 972–985)

```
fn codex_app_metadata(
    tracking: &TrackEventsContext,
    app: AppInvocation,
) -> CodexAppMetadata
```

**Purpose**: Builds the shared app invocation metadata payload for app-mentioned and app-used analytics events.

**Data flow**: Reads `TrackEventsContext` for `thread_id`, `turn_id`, and `model_slug`, consumes an `AppInvocation` for connector/app/invocation fields, reads the current product client ID from `originator()`, and returns a `CodexAppMetadata` struct.

**Call relations**: Called by reducer paths for app mention/use events and by serialization tests. It is a pure mapper with no side effects beyond reading the originator identity.

*Call graph*: calls 1 internal fn (originator); called by 3 (app_mentioned_event_serializes_expected_shape, app_used_event_serializes_expected_shape, ingest_app_used).


##### `codex_plugin_metadata`  (lines 987–1013)

```
fn codex_plugin_metadata(plugin: PluginTelemetryMetadata) -> CodexPluginMetadata
```

**Purpose**: Converts `PluginTelemetryMetadata` into the normalized plugin analytics payload, including capability-derived counts and connector IDs.

**Data flow**: Consumes `PluginTelemetryMetadata`, destructures `plugin_id`, optional `remote_plugin_id`, and optional `capability_summary`, chooses the remote ID override when present, reads `originator().value` for `product_client_id`, maps capability summary into `has_skills`, `mcp_server_count`, and a vector of connector ID strings, and returns `CodexPluginMetadata`.

**Call relations**: Used for plugin management events directly and as a sub-step of `codex_plugin_used_metadata`. Reducer plugin-state ingestion relies on it before selecting installed/uninstalled/enabled/disabled variants.

*Call graph*: calls 1 internal fn (originator); called by 4 (plugin_management_event_can_use_remote_plugin_id_override, plugin_management_event_serializes_expected_shape, codex_plugin_used_metadata, ingest_plugin_state_changed).


##### `codex_compaction_event_params`  (lines 1015–1050)

```
fn codex_compaction_event_params(
    input: CodexCompactionEvent,
    session_id: String,
    app_server_client: CodexAppServerClientMetadata,
    runtime: CodexRuntimeMetadata,
    thread_source: Op
```

**Purpose**: Copies a `CodexCompactionEvent` fact plus thread/session/client/runtime context into the serialized compaction event payload.

**Data flow**: Consumes the compaction fact and contextual arguments (`session_id`, `CodexAppServerClientMetadata`, `CodexRuntimeMetadata`, optional thread/subagent/parent metadata). It transfers all compaction fields unchanged into `CodexCompactionEventParams` and returns that struct.

**Call relations**: Called by reducer compaction ingestion after thread context lookup succeeds. It is a pure assembly step before wrapping the payload in `TrackEventRequest::Compaction`.

*Call graph*: called by 2 (compaction_event_serializes_expected_shape, ingest_compaction).


##### `codex_goal_event_params`  (lines 1052–1077)

```
fn codex_goal_event_params(
    input: CodexGoalEvent,
    session_id: String,
    app_server_client: CodexAppServerClientMetadata,
    runtime: CodexRuntimeMetadata,
    thread_source: Option<ThreadS
```

**Purpose**: Copies a `CodexGoalEvent` fact plus session/client/runtime/thread context into the serialized goal event payload.

**Data flow**: Consumes the goal fact and contextual metadata, moves all goal identifiers/status/accounting fields into `CodexGoalEventParams`, and returns the assembled struct.

**Call relations**: Used by reducer goal ingestion once thread context is available. It parallels `codex_compaction_event_params` for goal analytics.

*Call graph*: called by 1 (ingest_goal).


##### `codex_plugin_used_metadata`  (lines 1079–1094)

```
fn codex_plugin_used_metadata(
    tracking: &TrackEventsContext,
    plugin: PluginTelemetryMetadata,
) -> CodexPluginUsedMetadata
```

**Purpose**: Builds the richer plugin-used payload that combines generic plugin metadata with MCP server names and current tracking context.

**Data flow**: Reads `TrackEventsContext` for thread/turn/model, consumes `PluginTelemetryMetadata`, extracts `mcp_server_names` from its capability summary if present, delegates to `codex_plugin_metadata` for the flattened plugin block, and returns `CodexPluginUsedMetadata`.

**Call relations**: Called by reducer plugin-used ingestion and tests. It layers usage context on top of the generic plugin metadata helper.

*Call graph*: calls 1 internal fn (codex_plugin_metadata); called by 2 (plugin_used_event_serializes_expected_shape, ingest_plugin_used).


##### `codex_hook_run_metadata`  (lines 1096–1108)

```
fn codex_hook_run_metadata(
    tracking: &TrackEventsContext,
    hook: HookRunFact,
) -> CodexHookRunMetadata
```

**Purpose**: Transforms a `HookRunFact` and current tracking context into the serialized hook-run analytics payload.

**Data flow**: Reads `TrackEventsContext` for thread/turn/model, consumes `HookRunFact`, converts hook event name, source, and status through analytics-specific normalization helpers, and returns `CodexHookRunMetadata` with all fields wrapped in `Some(...)`.

**Call relations**: Used by reducer hook-run ingestion. It delegates to `analytics_hook_event_name`, `analytics_hook_source`, and `analytics_hook_status` to keep normalization rules centralized.

*Call graph*: calls 3 internal fn (analytics_hook_event_name, analytics_hook_source, analytics_hook_status); called by 4 (hook_run_event_serializes_expected_shape, hook_run_metadata_maps_sources_and_statuses, hook_run_metadata_maps_stopped_status, ingest_hook_run).


##### `analytics_hook_event_name`  (lines 1110–1123)

```
fn analytics_hook_event_name(event_name: HookEventName) -> &'static str
```

**Purpose**: Maps protocol-level `HookEventName` variants to the exact analytics string names expected downstream.

**Data flow**: Consumes a `HookEventName` and returns a static string such as `PreToolUse`, `SessionStart`, or `SubagentStop`.

**Call relations**: Only called from `codex_hook_run_metadata` as part of hook event serialization.

*Call graph*: called by 1 (codex_hook_run_metadata).


##### `analytics_hook_source`  (lines 1125–1139)

```
fn analytics_hook_source(source: HookSource) -> &'static str
```

**Purpose**: Maps protocol-level `HookSource` variants to analytics source strings.

**Data flow**: Consumes a `HookSource` and returns a static lowercase identifier like `system`, `plugin`, `cloud_managed_config`, or `unknown`.

**Call relations**: Only called from `codex_hook_run_metadata` to normalize hook provenance.

*Call graph*: called by 1 (codex_hook_run_metadata).


##### `current_runtime_metadata`  (lines 1141–1149)

```
fn current_runtime_metadata() -> CodexRuntimeMetadata
```

**Purpose**: Captures runtime environment details for inclusion in analytics events.

**Data flow**: Reads compile-time package version via `env!("CARGO_PKG_VERSION")`, runtime OS and architecture from `std::env::consts`, and OS version from `os_info::get()`. It returns a populated `CodexRuntimeMetadata`.

**Call relations**: Used when thread initialization events are emitted, including both normal initialization and synthetic subagent-thread initialization.

*Call graph*: called by 2 (track_initialize, subagent_thread_started_event_request); 2 external calls (env!, get).


##### `subagent_thread_started_event_request`  (lines 1151–1178)

```
fn subagent_thread_started_event_request(
    input: SubAgentThreadStartedInput,
) -> ThreadInitializedEvent
```

**Purpose**: Synthesizes a full `codex_thread_initialized` analytics event for a subagent thread started internally rather than through the external app-server protocol.

**Data flow**: Consumes `SubAgentThreadStartedInput`, builds `ThreadInitializedEventParams` with `rpc_transport` fixed to `InProcess`, `thread_source` fixed to `Some(ThreadSource::Subagent)`, `initialization_mode` fixed to `New`, runtime metadata from `current_runtime_metadata()`, and subagent source text from `subagent_source_name()`. It returns a `ThreadInitializedEvent` wrapper with event type `codex_thread_initialized`.

**Call relations**: Called by reducer subagent-thread ingestion and serialization tests. It packages internal subagent lifecycle facts into the same event shape used for externally initialized threads.

*Call graph*: calls 2 internal fn (current_runtime_metadata, subagent_source_name); called by 6 (subagent_thread_started_memory_consolidation_serializes_expected_shape, subagent_thread_started_other_serializes_expected_shape, subagent_thread_started_other_serializes_explicit_parent_thread_id, subagent_thread_started_review_serializes_expected_shape, subagent_thread_started_thread_spawn_serializes_thread_lineage, ingest_subagent_thread_started).


##### `subagent_source_name`  (lines 1180–1182)

```
fn subagent_source_name(subagent_source: &SubAgentSource) -> String
```

**Purpose**: Converts a `SubAgentSource` into the string stored in analytics metadata.

**Data flow**: Reads the source kind via `subagent_source.kind()`, converts it to string, and returns that `String`.

**Call relations**: Used both here and in reducer thread metadata construction so subagent source naming stays consistent across thread initialization and later turn/tool events.

*Call graph*: calls 1 internal fn (kind); called by 2 (subagent_thread_started_event_request, from_thread_metadata).


##### `analytics_hook_status`  (lines 1184–1190)

```
fn analytics_hook_status(status: HookRunStatus) -> HookRunStatus
```

**Purpose**: Normalizes hook run status for analytics, defensively collapsing unexpected `Running` into `Failed`.

**Data flow**: Consumes a `HookRunStatus`; if it is `Running`, returns `HookRunStatus::Failed`, otherwise returns the original status unchanged.

**Call relations**: Only called from `codex_hook_run_metadata` to ensure emitted hook analytics never report an in-progress terminal state.

*Call graph*: called by 1 (codex_hook_run_metadata).


### `analytics/src/lib.rs`

`util` · `cross-cutting; imported wherever analytics helpers or types are needed`

This crate root is mostly composition and utility. It declares the analytics submodules (`accepted_lines`, `client`, `events`, `facts`, `reducer`), re-exports the types that other crates use to produce analytics facts or consume analytics helpers, and defines a handful of generic conversion/time helpers shared across the reducer and event-building code.

`now_unix_seconds` and `now_unix_millis` snapshot wall-clock time relative to `UNIX_EPOCH`, defaulting to zero duration if the system clock is earlier than the epoch. The millisecond variant additionally performs a checked conversion from `u128` to `u64`, saturating to `u64::MAX` on overflow. `serialize_enum_as_string` is a small serde-based helper used when analytics wants the textual representation of an enum rather than its structured JSON form; it serializes to a `serde_json::Value` and extracts a string only if the serialized value is actually a JSON string. `usize_to_u64` and `option_i64_to_u64` centralize checked integer widening used throughout reducer code when converting counts and protocol timestamps into analytics payload fields.

Because this file re-exports nearly all externally relevant analytics types, it is the stable import point for callers while the implementation details remain split across the submodules.

#### Function details

##### `now_unix_seconds`  (lines 61–66)

```
fn now_unix_seconds() -> u64
```

**Purpose**: Returns the current Unix timestamp in whole seconds.

**Data flow**: Reads `SystemTime::now()`, computes duration since `UNIX_EPOCH`, substitutes a default zero duration on error, extracts seconds, and returns a `u64`.

**Call relations**: Used by analytics code that needs coarse wall-clock timestamps, such as accepted-line fingerprint events and turn-steer request capture.

*Call graph*: 1 external calls (now).


##### `now_unix_millis`  (lines 68–76)

```
fn now_unix_millis() -> u64
```

**Purpose**: Returns the current Unix timestamp in milliseconds with checked narrowing to `u64`.

**Data flow**: Reads `SystemTime::now()`, computes duration since `UNIX_EPOCH`, substitutes zero duration on error, extracts milliseconds as `u128`, attempts `u64::try_from`, and returns either the converted value or `u64::MAX` on overflow.

**Call relations**: Used where analytics payloads need millisecond precision, notably guardian review tracking context creation.

*Call graph*: 2 external calls (now, try_from).


##### `serialize_enum_as_string`  (lines 78–82)

```
fn serialize_enum_as_string(value: &T) -> Option<String>
```

**Purpose**: Attempts to serialize a value and recover it as a plain string if its serde representation is a JSON string.

**Data flow**: Takes a borrowed serializable value, runs `serde_json::to_value`, ignores serialization errors, checks whether the resulting JSON value is a string, and returns `Option<String>`.

**Call relations**: Used by reducer code for fields like reasoning effort where analytics wants the enum’s serialized string form rather than nested JSON.

*Call graph*: 1 external calls (to_value).


##### `usize_to_u64`  (lines 84–86)

```
fn usize_to_u64(value: usize) -> u64
```

**Purpose**: Performs a checked conversion from `usize` to `u64` with saturation on overflow.

**Data flow**: Consumes a `usize`, attempts `u64::try_from`, and returns the converted value or `u64::MAX` if conversion fails.

**Call relations**: Widely used by reducer counting helpers when populating analytics payload counters.

*Call graph*: 1 external calls (try_from).


##### `option_i64_to_u64`  (lines 88–90)

```
fn option_i64_to_u64(value: Option<i64>) -> Option<u64>
```

**Purpose**: Converts an optional signed integer into an optional nonnegative `u64`, dropping negative or overflowing values.

**Data flow**: Consumes `Option<i64>`, and for `Some(value)` attempts `u64::try_from(value)`. It returns `Some(u64)` only for successful nonnegative conversions; otherwise `None`.

**Call relations**: Used throughout reducer ingestion to sanitize protocol timestamps and durations before analytics emission.


### Event reduction pipeline
These files implement the core transformation from raw observations and accepted-line parsing into finalized analytics event records.

### `analytics/src/accepted_lines.rs`

`domain_logic` · `turn completion / analytics aggregation`

This file implements the accepted-line analytics feature at the diff-parsing layer. The main output type, `AcceptedLineFingerprintSummary`, records total added and deleted line counts plus a vector of `AcceptedLineFingerprint` values. Parsing is done by `accepted_line_fingerprints_from_unified_diff`, which walks the diff line-by-line while tracking two pieces of state: the current file path from `+++` headers and whether the parser is inside a hunk after seeing `@@`.

The parser deliberately ignores file metadata outside hunks except for `+++` path headers, resets state on each `diff --git`, and treats hunk lines beginning with `+` or `-` as actual additions/deletions even if their contents resemble file headers. Added lines increment `accepted_added_lines`; deleted lines increment `accepted_deleted_lines`. Fingerprints are only emitted for added lines when a normalized path exists and `normalize_effective_line` decides the content is meaningful. That normalization collapses whitespace, rejects very short strings (length ≤ 3), and rejects lines with no alphanumeric or underscore characters, which filters out braces-only and punctuation-only additions.

`fingerprint_hash` namespaces hashes with a fixed `file-line-v1\0` prefix plus a domain (`path`, `line`, or `repo`) before SHA-1 hex encoding, preventing collisions across semantic categories. Event construction intentionally strips fingerprints from uploaded payloads: `accepted_line_fingerprint_event_requests` preserves aggregate counts but sends `line_fingerprints: Vec::new()`, leaving local fingerprint computation available for tests and future attribution. `accepted_line_repo_hash_for_cwd` asynchronously reads Git remotes, prefers `origin`, canonicalizes the chosen URL when possible, and hashes it instead of exposing the raw remote.

#### Function details

##### `accepted_line_fingerprints_from_unified_diff`  (lines 30–83)

```
fn accepted_line_fingerprints_from_unified_diff(
    unified_diff: &str,
) -> AcceptedLineFingerprintSummary
```

**Purpose**: Parses a unified diff into aggregate added/deleted counts and fingerprints for meaningful added lines tied to normalized file paths.

**Data flow**: Consumes a diff string, iterates over `lines()`, maintains `current_path: Option<String>` and `in_hunk: bool`, updates those on `diff --git`, `@@`, `+++`, and `---` markers, increments counters for `+` and `-` lines, normalizes added-line content with `normalize_effective_line`, hashes path and line content with `fingerprint_hash`, and returns `AcceptedLineFingerprintSummary`.

**Call relations**: Called by analytics code when a turn diff must be summarized and by the file’s tests. It delegates path normalization, line normalization, and hashing to helpers while owning the diff-state machine.

*Call graph*: calls 3 internal fn (fingerprint_hash, normalize_diff_path, normalize_effective_line); called by 4 (parses_counts_and_effective_added_fingerprints, parses_hunk_lines_that_look_like_file_headers, skips_added_file_metadata_headers, accepted_line_event_input); 1 external calls (new).


##### `fingerprint_hash`  (lines 85–92)

```
fn fingerprint_hash(domain: &str, value: &str) -> String
```

**Purpose**: Computes a namespaced SHA-1 hex digest for a path, line, or repo value used in accepted-line analytics.

**Data flow**: Takes a `domain` string and `value` string, feeds `file-line-v1\0`, the domain, a separator null byte, and the value bytes into a `sha1::Sha1` hasher, finalizes it, and formats the digest as lowercase hexadecimal.

**Call relations**: Used by diff parsing for path and line fingerprints and by repo hashing for canonical remote URLs. The domain parameter is what keeps hashes for different semantic categories distinct.

*Call graph*: called by 1 (accepted_line_fingerprints_from_unified_diff); 2 external calls (format!, new).


##### `accepted_line_fingerprint_event_requests`  (lines 94–129)

```
fn accepted_line_fingerprint_event_requests(
    input: AcceptedLineFingerprintEventInput,
) -> Vec<TrackEventRequest>
```

**Purpose**: Builds the analytics event request for accepted-line summaries while intentionally omitting raw path/line fingerprints from the uploaded payload.

**Data flow**: Consumes `AcceptedLineFingerprintEventInput`, destructures all fields, ignores the incoming `line_fingerprints` binding, constructs one `TrackEventRequest::AcceptedLineFingerprints` containing `CodexAcceptedLineFingerprintsEventRequest` and `CodexAcceptedLineFingerprintsEventParams`, and sets `line_fingerprints` in the payload to an empty vector.

**Call relations**: Called by higher-level analytics emission code when a turn completes. Its key design choice is to preserve aggregate counts but suppress fingerprint upload despite local computation.

*Call graph*: called by 1 (maybe_emit_turn_event); 1 external calls (vec!).


##### `accepted_line_repo_hash_for_cwd`  (lines 131–141)

```
async fn accepted_line_repo_hash_for_cwd(cwd: &Path) -> Option<String>
```

**Purpose**: Derives a privacy-preserving repository identifier for the current working directory from Git remotes.

**Data flow**: Accepts a `&Path`, asynchronously fetches remote URLs with `get_git_remote_urls_assume_git_repo`, selects `origin` if present or otherwise the first remote, canonicalizes the chosen URL with `canonicalize_git_remote_url` when possible, hashes the canonical or original URL with `fingerprint_hash("repo", ...)`, and returns `Option<String>`.

**Call relations**: Invoked by analytics orchestration before emitting accepted-line events. It depends on Git utility functions for remote discovery and normalization, then reuses the same hashing scheme as line/path fingerprints.

*Call graph*: called by 1 (maybe_emit_turn_event); 1 external calls (get_git_remote_urls_assume_git_repo).


##### `normalize_diff_path`  (lines 143–155)

```
fn normalize_diff_path(path: &str) -> Option<String>
```

**Purpose**: Converts a diff header path into the logical repository-relative path used for fingerprinting, or drops deleted-file null paths.

**Data flow**: Trims the input path string, returns `None` for `/dev/null`, otherwise strips a leading `b/` or `a/` prefix if present and returns the remaining path as `Some(String)`.

**Call relations**: Used only by `accepted_line_fingerprints_from_unified_diff` when processing `+++` file headers outside hunks.

*Call graph*: called by 1 (accepted_line_fingerprints_from_unified_diff).


##### `normalize_effective_line`  (lines 157–169)

```
fn normalize_effective_line(line: &str) -> Option<String>
```

**Purpose**: Filters and normalizes added-line content so only meaningful code/text lines are fingerprinted.

**Data flow**: Splits the input line on whitespace, rejoins tokens with single spaces, rejects the result if its length is 3 or less or if it contains no alphanumeric character and no underscore, and otherwise returns `Some(normalized)`.

**Call relations**: Called by `accepted_line_fingerprints_from_unified_diff` before hashing added lines. It is the main heuristic that excludes trivial additions like braces or punctuation-only lines.

*Call graph*: called by 1 (accepted_line_fingerprints_from_unified_diff).


##### `tests::parses_counts_and_effective_added_fingerprints`  (lines 176–209)

```
fn parses_counts_and_effective_added_fingerprints()
```

**Purpose**: Verifies that diff parsing counts additions/deletions correctly and fingerprints only meaningful added lines after normalization.

**Data flow**: Builds a small diff containing one deletion and three additions, calls `accepted_line_fingerprints_from_unified_diff`, and asserts the returned summary contains the expected counts and exactly two fingerprints for `fn useful() {` and `return user.id;`.

**Call relations**: This test exercises the main parser path, including path extraction, line normalization, and fingerprint generation.

*Call graph*: calls 1 internal fn (accepted_line_fingerprints_from_unified_diff); 1 external calls (assert_eq!).


##### `tests::skips_added_file_metadata_headers`  (lines 212–228)

```
fn skips_added_file_metadata_headers()
```

**Purpose**: Checks that file metadata headers for newly added files are not mistaken for added content lines outside hunks.

**Data flow**: Constructs a diff for a new file with `--- /dev/null`, `+++ b/new.py`, and one hunk addition, parses it, and asserts one added line, zero deleted lines, and one fingerprint.

**Call relations**: This test covers the parser’s outside-hunk header handling and the `/dev/null` path normalization case.

*Call graph*: calls 1 internal fn (accepted_line_fingerprints_from_unified_diff); 1 external calls (assert_eq!).


##### `tests::parses_hunk_lines_that_look_like_file_headers`  (lines 231–255)

```
fn parses_hunk_lines_that_look_like_file_headers()
```

**Purpose**: Ensures that lines inside hunks beginning with `---` or `+++` are treated as actual diff content, not metadata headers.

**Data flow**: Creates a diff whose hunk contains `--- old value` and `+++ new value`, parses it, and asserts one deletion plus one fingerprinted addition whose normalized content is `++ new value`.

**Call relations**: This test validates the `in_hunk` state guard in the parser, proving that header-like text inside hunks is still counted as content.

*Call graph*: calls 1 internal fn (accepted_line_fingerprints_from_unified_diff); 1 external calls (assert_eq!).


### `analytics/src/reducer.rs`

`orchestration` · `request handling and event stream reduction throughout a session`

This file is the heart of analytics assembly. `AnalyticsReducer` maintains multiple correlated state maps: pending client requests keyed by `(connection_id, RequestId)`, per-turn accumulation in `turns`, connection metadata in `connections`, per-thread metadata in `threads`, started timestamps for tool items, pending approval reviews, and per-item review summaries. The reducer ingests both protocol-surface facts and custom analytics facts, updating these maps until enough information exists to emit a concrete analytics event.

The main control flow starts in `AnalyticsReducer::ingest`, which dispatches each `AnalyticsFact` to specialized handlers. Request/response handlers track turn starts and turn-steer attempts; notification handlers observe item starts/completions, guardian review completions, turn lifecycle notifications, and diffs; custom handlers inject resolved config, token usage, profiles, compaction, goals, plugin/app/hook usage, and guardian review payloads. Emission is intentionally delayed for turn events until `thread_id`, input-image count, resolved config, profile, and completion state are all present. At that point `maybe_emit_turn_event` builds a `codex_turn_event`, optionally derives accepted-line fingerprints from the latest unified diff, and then removes the turn state.

Tool-item analytics are similarly synthesized only on `ItemCompleted`, using `tool_item_event` to inspect the concrete `ThreadItem` variant and derive counts, terminal status, failure kind, execution duration, and review summary fields. Review flows are tracked separately: server approval requests create `PendingReviewState`, later responses/aborts resolve them into `codex_review_event` records and update `item_review_summaries` so the eventual tool-item event can report review counts and final approval outcome. Missing thread/connection metadata never panics; instead helper methods log a structured warning via `AnalyticsDropSite` and drop the event. The file also contains many small normalization helpers for statuses, policy modes, path hashing inputs, and protocol-to-analytics enum mappings.

#### Function details

##### `AnalyticsDropSite::guardian`  (lines 168–176)

```
fn guardian(input: &'a GuardianReviewEventParams) -> Self
```

**Purpose**: Builds a structured drop-site descriptor for guardian review events so missing-context warnings include the relevant thread, turn, and review identifiers.

**Data flow**: Reads a borrowed `GuardianReviewEventParams` and returns an `AnalyticsDropSite` with `event_name` set to `guardian`, `thread_id` and `turn_id` borrowed from the payload, `review_id` set, and `item_id` left `None`.

**Call relations**: Called immediately before thread-context lookup in guardian review ingestion so any dropped event can be logged with precise identifiers.

*Call graph*: called by 1 (ingest_guardian_review).


##### `AnalyticsDropSite::review`  (lines 178–186)

```
fn review(input: &'a PendingReviewState) -> Self
```

**Purpose**: Builds the warning context descriptor for user or guardian review events derived from pending review state.

**Data flow**: Reads a borrowed `PendingReviewState` and returns an `AnalyticsDropSite` containing the review’s thread, turn, review ID, and optional item ID.

**Call relations**: Used by `emit_review_event` before context lookup and warning emission.

*Call graph*: called by 1 (emit_review_event).


##### `AnalyticsDropSite::compaction`  (lines 188–196)

```
fn compaction(input: &'a CodexCompactionEvent) -> Self
```

**Purpose**: Builds the warning context descriptor for compaction analytics events.

**Data flow**: Reads a borrowed `CodexCompactionEvent` and returns an `AnalyticsDropSite` with event name `compaction`, thread ID, and turn ID populated.

**Call relations**: Used by compaction ingestion when thread/session metadata may be missing.

*Call graph*: called by 1 (ingest_compaction).


##### `AnalyticsDropSite::goal`  (lines 198–206)

```
fn goal(input: &'a CodexGoalEvent) -> Self
```

**Purpose**: Builds the warning context descriptor for goal analytics events.

**Data flow**: Reads a borrowed `CodexGoalEvent` and returns an `AnalyticsDropSite` with event name `goal`, thread ID, and optional turn ID.

**Call relations**: Used by goal ingestion before thread-context lookup.

*Call graph*: called by 1 (ingest_goal).


##### `AnalyticsDropSite::tool_item`  (lines 208–219)

```
fn tool_item(
        notification: &'a codex_app_server_protocol::ItemCompletedNotification,
        item_id: &'a str,
    ) -> Self
```

**Purpose**: Builds the warning context descriptor for tool-item completion analytics.

**Data flow**: Reads an `ItemCompletedNotification` and the resolved tracked `item_id`, then returns an `AnalyticsDropSite` containing thread, turn, and item identifiers with event name `tool item`.

**Call relations**: Used in notification handling before attempting to emit a tool-item event.

*Call graph*: called by 1 (ingest_notification).


##### `AnalyticsDropSite::turn_steer`  (lines 221–229)

```
fn turn_steer(thread_id: &'a str) -> Self
```

**Purpose**: Builds the warning context descriptor for turn-steer analytics events.

**Data flow**: Takes a thread ID string slice and returns an `AnalyticsDropSite` with event name `turn steer` and only the thread ID populated.

**Call relations**: Used by `emit_turn_steer_event` when thread metadata may be absent.

*Call graph*: called by 1 (emit_turn_steer_event).


##### `AnalyticsDropSite::turn`  (lines 231–239)

```
fn turn(thread_id: &'a str, turn_id: &'a str) -> Self
```

**Purpose**: Builds the warning context descriptor for turn lifecycle analytics events.

**Data flow**: Takes thread and turn ID string slices and returns an `AnalyticsDropSite` with event name `turn` and those identifiers populated.

**Call relations**: Used by `maybe_emit_turn_event` when connection or thread metadata lookup fails.

*Call graph*: called by 1 (maybe_emit_turn_event).


##### `ThreadMetadataState::from_thread_metadata`  (lines 282–306)

```
fn from_thread_metadata(
        session_id: String,
        session_source: &SessionSource,
        thread_source: Option<ThreadSource>,
        parent_thread_id: Option<String>,
        initializati
```

**Purpose**: Normalizes thread/session metadata from app-server thread information into the reducer’s compact per-thread state.

**Data flow**: Consumes `session_id`, a borrowed `SessionSource`, optional `ThreadSource`, optional parent thread ID, and initialization mode. It derives `subagent_source` only when the session source is `SessionSource::SubAgent`, using `subagent_source_name`, and returns a `ThreadMetadataState`.

**Call relations**: Called when a thread is initialized through normal app-server responses. Later turn, tool, compaction, and review events read this stored metadata.

*Call graph*: calls 1 internal fn (subagent_source_name); called by 1 (emit_thread_initialized).


##### `TurnToolCounts::record`  (lines 370–393)

```
fn record(&mut self, item: &ThreadItem)
```

**Purpose**: Updates per-turn tool counters based on a completed `ThreadItem` variant.

**Data flow**: Mutably reads `self` and inspects a borrowed `ThreadItem`. For tracked tool variants it increments the corresponding category counter and `total`; for non-tool transcript/reasoning/compaction items it returns without changing counts.

**Call relations**: Called from notification handling on item completion, including a special path for `SubAgentActivity` where only counts are updated and no tool-item event is emitted.


##### `AnalyticsReducer::ingest`  (lines 397–516)

```
async fn ingest(&mut self, input: AnalyticsFact, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Top-level dispatcher that accepts any analytics fact, updates reducer state, and appends zero or more finished analytics events to the output buffer.

**Data flow**: Consumes an `AnalyticsFact`, mutably updates the reducer’s maps, and mutably appends `TrackEventRequest` values into `out`. Depending on the fact variant it delegates to specialized ingestion methods, some async, and may emit events immediately or defer until more state arrives.

**Call relations**: This is the reducer entrypoint used by higher-level analytics collection code. It fans out to all other ingestion methods based on fact type.

*Call graph*: calls 23 internal fn (ingest_app_mentioned, ingest_app_used, ingest_compaction, ingest_effective_permissions_approval_response, ingest_error_response, ingest_goal, ingest_guardian_review, ingest_hook_run, ingest_initialize, ingest_notification (+13 more)); called by 6 (ingest_complete_child_turn, ingest_completed_command_execution_item, ingest_initialize, ingest_rejected_turn_steer, ingest_review_prerequisites, ingest_turn_prerequisites).


##### `AnalyticsReducer::ingest_initialize`  (lines 518–541)

```
fn ingest_initialize(
        &mut self,
        connection_id: u64,
        params: InitializeParams,
        product_client_id: String,
        runtime: CodexRuntimeMetadata,
        rpc_transport:
```

**Purpose**: Stores connection-scoped client/runtime metadata from the initialize handshake.

**Data flow**: Consumes connection ID, initialize params, product client ID, runtime metadata, and RPC transport. It inserts a `ConnectionState` into `self.connections`, building `CodexAppServerClientMetadata` from client info and optional experimental API capability.

**Call relations**: Called from `ingest` on `AnalyticsFact::Initialize`; later thread, turn, review, and tool-item events depend on this stored connection metadata.

*Call graph*: called by 1 (ingest).


##### `AnalyticsReducer::ingest_subagent_thread_started`  (lines 543–569)

```
fn ingest_subagent_thread_started(
        &mut self,
        input: SubAgentThreadStartedInput,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Registers metadata for an internally started subagent thread and emits its synthetic thread-initialized analytics event.

**Data flow**: Consumes `SubAgentThreadStartedInput`, looks up the parent thread’s connection ID if available, inserts or fills `ThreadAnalyticsState` for the new thread with subagent metadata, inherits the parent connection when missing, and pushes a `TrackEventRequest::ThreadInitialized` built by `subagent_thread_started_event_request`.

**Call relations**: Triggered by custom subagent-start facts. It both seeds future context lookups for the subagent thread and emits the immediate initialization event.

*Call graph*: calls 1 internal fn (subagent_thread_started_event_request); called by 1 (ingest); 1 external calls (ThreadInitialized).


##### `AnalyticsReducer::ingest_guardian_review`  (lines 571–592)

```
fn ingest_guardian_review(
        &mut self,
        input: GuardianReviewEventParams,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Wraps a completed guardian review payload with session/client/runtime metadata and emits the final guardian review analytics event.

**Data flow**: Consumes `GuardianReviewEventParams`, looks up connection and thread metadata via `thread_context_or_warn`, and if found pushes `TrackEventRequest::GuardianReview` containing `GuardianReviewEventPayload` with session ID, app-server client metadata, runtime metadata, and the supplied review payload.

**Call relations**: Called from `ingest` for custom guardian review facts. If thread context is missing, it drops the event after logging via the `AnalyticsDropSite::guardian` path.

*Call graph*: calls 2 internal fn (guardian, thread_context_or_warn); called by 1 (ingest); 2 external calls (new, GuardianReview).


##### `AnalyticsReducer::ingest_request`  (lines 594–623)

```
fn ingest_request(
        &mut self,
        connection_id: u64,
        request_id: RequestId,
        request: ClientRequest,
    )
```

**Purpose**: Captures client request state needed to correlate later responses, specifically turn starts and turn-steer attempts.

**Data flow**: Consumes connection ID, request ID, and `ClientRequest`. For `TurnStart`, it stores `PendingTurnStartState` with thread ID and image count. For `TurnSteer`, it stores `PendingTurnSteerState` with thread ID, expected turn ID, image count, and current Unix-seconds creation time. Other requests are ignored.

**Call relations**: Called from `ingest` on client requests. Later `ingest_response` or `ingest_error_response` removes these pending entries to emit turn or turn-steer analytics.

*Call graph*: calls 1 internal fn (num_input_images); called by 1 (ingest); 3 external calls (TurnStart, TurnSteer, now_unix_seconds).


##### `AnalyticsReducer::ingest_turn_resolved_config`  (lines 625–638)

```
async fn ingest_turn_resolved_config(
        &mut self,
        input: TurnResolvedConfigFact,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Adds resolved configuration data to a turn’s accumulated state and attempts turn-event emission if all prerequisites are now present.

**Data flow**: Consumes `TurnResolvedConfigFact`, ensures a `TurnState` exists for its turn ID, stores thread ID, input-image count, and the full resolved config, then calls `maybe_emit_turn_event`.

**Call relations**: Triggered by custom turn-config facts. It is one of several partial-state updates that converge in `maybe_emit_turn_event`.

*Call graph*: calls 1 internal fn (maybe_emit_turn_event); called by 1 (ingest).


##### `AnalyticsReducer::ingest_turn_token_usage`  (lines 640–650)

```
async fn ingest_turn_token_usage(
        &mut self,
        input: TurnTokenUsageFact,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Adds token usage data to a turn’s accumulated state and re-checks whether the turn event can now be emitted.

**Data flow**: Consumes `TurnTokenUsageFact`, ensures a `TurnState`, stores thread ID and token usage, then calls `maybe_emit_turn_event`.

**Call relations**: Called from `ingest` for token-usage facts; complements resolved config, profile, and completion notifications.

*Call graph*: calls 1 internal fn (maybe_emit_turn_event); called by 1 (ingest).


##### `AnalyticsReducer::ingest_turn_profile`  (lines 652–661)

```
async fn ingest_turn_profile(
        &mut self,
        input: TurnProfileFact,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Adds timing/profile metrics to a turn’s accumulated state and re-checks turn-event readiness.

**Data flow**: Consumes `TurnProfileFact`, ensures a `TurnState`, stores the profile, and calls `maybe_emit_turn_event`.

**Call relations**: Another partial-state contributor to eventual turn-event emission.

*Call graph*: calls 1 internal fn (maybe_emit_turn_event); called by 1 (ingest).


##### `AnalyticsReducer::ingest_turn_codex_error`  (lines 663–672)

```
fn ingest_turn_codex_error(&mut self, input: TurnCodexErrorFact)
```

**Purpose**: Stores normalized Codex error information for a turn so it can be included in the eventual turn event.

**Data flow**: Consumes `TurnCodexErrorFact`, ensures a `TurnState`, fills in thread ID if absent, and stores the simplified `TurnCodexError`.

**Call relations**: Called from `ingest` for custom turn-error facts. Unlike config/profile/token updates, it does not itself trigger emission because turn completion prerequisites may still be missing.

*Call graph*: called by 1 (ingest).


##### `AnalyticsReducer::ingest_skill_invoked`  (lines 674–722)

```
async fn ingest_skill_invoked(
        &mut self,
        input: SkillInvokedInput,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Emits one skill-invocation analytics event per invoked skill, enriching each with repo URL and a stable hashed skill ID.

**Data flow**: Consumes `SkillInvokedInput`, iterates its `invocations`, maps `SkillScope` to a string, discovers repo root with `get_git_repo_root`, optionally fetches git metadata via `collect_git_info`, computes a stable skill ID with `skill_id_for_local_skill`, reads `originator().value`, and pushes a `TrackEventRequest::SkillInvocation` for each invocation.

**Call relations**: Called from `ingest` for custom skill-invoked facts. It is an immediate-emission path rather than a state accumulator.

*Call graph*: calls 2 internal fn (skill_id_for_local_skill, originator); called by 1 (ingest); 3 external calls (SkillInvocation, collect_git_info, get_git_repo_root).


##### `AnalyticsReducer::ingest_app_mentioned`  (lines 724–733)

```
fn ingest_app_mentioned(&mut self, input: AppMentionedInput, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits analytics events for each app mention observed in a turn.

**Data flow**: Consumes `AppMentionedInput`, iterates the `mentions` vector, converts each `AppInvocation` with `codex_app_metadata`, wraps it in `CodexAppMentionedEventRequest`, and extends the output vector.

**Call relations**: Called from `ingest` for custom app-mentioned facts. It is a straightforward mapping path.

*Call graph*: called by 1 (ingest).


##### `AnalyticsReducer::ingest_app_used`  (lines 735–742)

```
fn ingest_app_used(&mut self, input: AppUsedInput, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits the analytics event for a concrete app use within the current tracking context.

**Data flow**: Consumes `AppUsedInput`, converts its `AppInvocation` with `codex_app_metadata`, wraps it in `CodexAppUsedEventRequest`, and pushes `TrackEventRequest::AppUsed`.

**Call relations**: Called from `ingest` for custom app-used facts.

*Call graph*: calls 1 internal fn (codex_app_metadata); called by 1 (ingest); 1 external calls (AppUsed).


##### `AnalyticsReducer::ingest_hook_run`  (lines 744–750)

```
fn ingest_hook_run(&mut self, input: HookRunInput, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits a hook-run analytics event from a hook fact and current tracking context.

**Data flow**: Consumes `HookRunInput`, converts the hook fact with `codex_hook_run_metadata`, wraps it in `CodexHookRunEventRequest`, and pushes `TrackEventRequest::HookRun`.

**Call relations**: Called from `ingest` for custom hook-run facts.

*Call graph*: calls 1 internal fn (codex_hook_run_metadata); called by 1 (ingest); 1 external calls (HookRun).


##### `AnalyticsReducer::ingest_plugin_used`  (lines 752–758)

```
fn ingest_plugin_used(&mut self, input: PluginUsedInput, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits a plugin-used analytics event enriched with plugin metadata and current thread/turn/model context.

**Data flow**: Consumes `PluginUsedInput`, converts it with `codex_plugin_used_metadata`, wraps it in `CodexPluginUsedEventRequest`, and pushes `TrackEventRequest::PluginUsed`.

**Call relations**: Called from `ingest` for custom plugin-used facts.

*Call graph*: calls 1 internal fn (codex_plugin_used_metadata); called by 1 (ingest); 1 external calls (PluginUsed).


##### `AnalyticsReducer::ingest_plugin_state_changed`  (lines 760–776)

```
fn ingest_plugin_state_changed(
        &mut self,
        input: PluginStateChangedInput,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Emits the appropriate plugin lifecycle analytics event for install/uninstall/enable/disable transitions.

**Data flow**: Consumes `PluginStateChangedInput`, builds a `CodexPluginEventRequest` using `plugin_state_event_type` and `codex_plugin_metadata`, then matches the state to push the corresponding `TrackEventRequest` variant.

**Call relations**: Called from `ingest` for custom plugin-state facts. It centralizes the mapping from plugin state to both event type string and wrapper variant.

*Call graph*: calls 2 internal fn (codex_plugin_metadata, plugin_state_event_type); called by 1 (ingest); 4 external calls (PluginDisabled, PluginEnabled, PluginInstalled, PluginUninstalled).


##### `AnalyticsReducer::ingest_response`  (lines 778–836)

```
async fn ingest_response(
        &mut self,
        connection_id: u64,
        response: ClientResponse,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Processes client responses, correlating them with pending requests to emit thread initialization, turn-start, or turn-steer analytics.

**Data flow**: Consumes connection ID and `ClientResponse`. Thread start/resume/fork responses call `emit_thread_initialized`. Turn-start responses remove the matching pending request, populate turn state with connection/thread/image data, and call `maybe_emit_turn_event`. Turn-steer responses delegate to `ingest_turn_steer_response`.

**Call relations**: Called from `ingest` on client responses after protocol decoding. It is the response-side counterpart to `ingest_request`.

*Call graph*: calls 3 internal fn (emit_thread_initialized, ingest_turn_steer_response, maybe_emit_turn_event); called by 1 (ingest).


##### `AnalyticsReducer::ingest_server_request`  (lines 838–952)

```
fn ingest_server_request(&mut self, _connection_id: u64, request: ServerRequest)
```

**Purpose**: Tracks pending approval/review requests initiated by the server so later responses can emit review analytics and annotate tool-item summaries.

**Data flow**: Consumes a `ServerRequest`, and for command execution, file change, or permissions approval requests computes trigger type, requested-permission flags, converts `started_at_ms` with `option_i64_to_u64`, synthesizes a user review ID via `user_review_id`, and inserts a `PendingReviewState` keyed by request ID. Unsupported server requests are ignored.

**Call relations**: Called from `ingest` on server requests. Later server responses, effective-permissions responses, or aborts remove these pending entries and call `emit_review_event`.

*Call graph*: calls 1 internal fn (user_review_id); called by 1 (ingest); 1 external calls (option_i64_to_u64).


##### `AnalyticsReducer::ingest_server_response`  (lines 954–997)

```
fn ingest_server_response(
        &mut self,
        completed_at_ms: u64,
        response: ServerResponse,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Resolves pending user approval reviews from server responses and emits the corresponding review analytics events.

**Data flow**: Consumes completion time and `ServerResponse`. For command execution and file change approval responses it removes the matching `PendingReviewState`, maps the decision to `(ReviewStatus, ReviewResolution)` via helper functions, and calls `emit_review_event`.

**Call relations**: Called from `ingest` on server responses. It completes the review lifecycle started by `ingest_server_request`.

*Call graph*: calls 3 internal fn (emit_review_event, command_execution_review_result, file_change_review_result); called by 1 (ingest).


##### `AnalyticsReducer::ingest_effective_permissions_approval_response`  (lines 999–1018)

```
fn ingest_effective_permissions_approval_response(
        &mut self,
        completed_at_ms: u64,
        request_id: RequestId,
        response: CoreRequestPermissionsResponse,
        out: &mut V
```

**Purpose**: Resolves pending permissions reviews using the effective granted permissions response and emits the resulting review event.

**Data flow**: Consumes completion time, request ID, and `CoreRequestPermissionsResponse`, removes the matching pending review, derives status/resolution with `effective_permissions_review_result`, and calls `emit_review_event`.

**Call relations**: Called from `ingest` for the special effective-permissions response fact path.

*Call graph*: calls 2 internal fn (emit_review_event, effective_permissions_review_result); called by 1 (ingest).


##### `AnalyticsReducer::ingest_server_request_aborted`  (lines 1020–1037)

```
fn ingest_server_request_aborted(
        &mut self,
        completed_at_ms: u64,
        request_id: RequestId,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Marks a pending user review as aborted when the server request is cancelled before a normal response arrives.

**Data flow**: Consumes completion time and request ID, removes the matching `PendingReviewState`, and emits a review event with `ReviewStatus::Aborted` and `ReviewResolution::None`.

**Call relations**: Called from `ingest` on server-request-aborted facts.

*Call graph*: calls 1 internal fn (emit_review_event); called by 1 (ingest).


##### `AnalyticsReducer::ingest_error_response`  (lines 1039–1050)

```
fn ingest_error_response(
        &mut self,
        connection_id: u64,
        request_id: RequestId,
        error_type: Option<AnalyticsJsonRpcError>,
        out: &mut Vec<TrackEventRequest>,
```

**Purpose**: Handles JSON-RPC error responses by removing the pending request and routing it to request-specific error handling.

**Data flow**: Consumes connection ID, request ID, optional `AnalyticsJsonRpcError`, removes the matching `RequestState` from `self.requests`, and delegates to `ingest_request_error_response` if one existed.

**Call relations**: Called from `ingest` on error responses. It is the generic error-side counterpart to `ingest_response`.

*Call graph*: calls 1 internal fn (ingest_request_error_response); called by 1 (ingest).


##### `AnalyticsReducer::ingest_request_error_response`  (lines 1052–1070)

```
fn ingest_request_error_response(
        &mut self,
        connection_id: u64,
        request: RequestState,
        error_type: Option<AnalyticsJsonRpcError>,
        out: &mut Vec<TrackEventReque
```

**Purpose**: Dispatches a failed pending request to the appropriate request-type-specific error handler.

**Data flow**: Consumes connection ID, a `RequestState`, optional analytics error type, and output buffer. It ignores failed `TurnStart` requests and routes failed `TurnSteer` requests to `ingest_turn_steer_error_response`.

**Call relations**: Only called from `ingest_error_response` after the pending request has been removed.

*Call graph*: calls 1 internal fn (ingest_turn_steer_error_response); called by 1 (ingest_error_response).


##### `AnalyticsReducer::ingest_turn_steer_error_response`  (lines 1072–1087)

```
fn ingest_turn_steer_error_response(
        &mut self,
        connection_id: u64,
        pending_request: PendingTurnSteerState,
        error_type: Option<AnalyticsJsonRpcError>,
        out: &mut
```

**Purpose**: Emits a rejected turn-steer analytics event from a failed pending turn-steer request.

**Data flow**: Consumes connection ID, `PendingTurnSteerState`, optional analytics error type, derives an optional rejection reason with `rejection_reason_from_error_type`, and calls `emit_turn_steer_event` with `accepted_turn_id` set to `None` and result `Rejected`.

**Call relations**: Reached only for failed turn-steer requests via `ingest_request_error_response`.

*Call graph*: calls 2 internal fn (emit_turn_steer_event, rejection_reason_from_error_type); called by 1 (ingest_request_error_response).


##### `AnalyticsReducer::ingest_notification`  (lines 1089–1216)

```
async fn ingest_notification(
        &mut self,
        notification: ServerNotification,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Processes server notifications that contribute to analytics state or directly trigger event emission, including item lifecycle, guardian review completion, turn lifecycle, and diff updates.

**Data flow**: Consumes a `ServerNotification` and mutates reducer state. `ItemStarted` records start timestamps for tracked tool items. `ItemCompleted` updates turn tool counts, looks up start/completion times and thread context, builds a tool-item event via `tool_item_event`, and clears any stored review summary. Guardian review completion delegates to `ingest_guardian_review_completed`. `TurnStarted`, `TurnDiffUpdated`, and `TurnCompleted` update turn state and may trigger `maybe_emit_turn_event`.

**Call relations**: Called from `ingest` on notifications. It is the main bridge from streaming server notifications into accumulated analytics state.

*Call graph*: calls 7 internal fn (tool_item, ingest_guardian_review_completed, maybe_emit_turn_event, thread_context_or_warn, analytics_turn_status, tool_item_event, tracked_tool_item_id); called by 1 (ingest); 3 external calls (option_i64_to_u64, matches!, warn!).


##### `AnalyticsReducer::emit_thread_initialized`  (lines 1218–1267)

```
fn emit_thread_initialized(
        &mut self,
        connection_id: u64,
        thread: codex_app_server_protocol::Thread,
        model: String,
        initialization_mode: ThreadInitializationMo
```

**Purpose**: Registers thread metadata from a successful thread start/resume/fork response and emits the corresponding thread-initialized analytics event.

**Data flow**: Consumes connection ID, protocol `Thread`, model string, initialization mode, and output buffer. It converts protocol session source into `SessionSource`, derives `ThreadMetadataState` with `from_thread_metadata`, stores it in `self.threads`, and pushes a `ThreadInitializedEvent` populated from connection metadata and thread fields.

**Call relations**: Called from `ingest_response` for thread lifecycle responses. It seeds thread context required by many later analytics events.

*Call graph*: calls 1 internal fn (from_thread_metadata); called by 1 (ingest_response); 2 external calls (ThreadInitialized, try_from).


##### `AnalyticsReducer::ingest_compaction`  (lines 1269–1289)

```
fn ingest_compaction(&mut self, input: CodexCompactionEvent, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits a compaction analytics event once thread/session/client/runtime context is available.

**Data flow**: Consumes `CodexCompactionEvent`, looks up connection and thread metadata with `thread_context_or_warn`, builds event params via `codex_compaction_event_params`, wraps them in `CodexCompactionEventRequest`, and pushes `TrackEventRequest::Compaction`.

**Call relations**: Called from `ingest` for custom compaction facts. Missing context causes a warning and drop.

*Call graph*: calls 3 internal fn (codex_compaction_event_params, compaction, thread_context_or_warn); called by 1 (ingest); 2 external calls (new, Compaction).


##### `AnalyticsReducer::ingest_goal`  (lines 1291–1309)

```
fn ingest_goal(&mut self, input: CodexGoalEvent, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits a goal analytics event once thread/session/client/runtime context is available.

**Data flow**: Consumes `CodexGoalEvent`, looks up connection and thread metadata, builds params with `codex_goal_event_params`, wraps them in `CodexGoalEventRequest`, and pushes `TrackEventRequest::Goal`.

**Call relations**: Called from `ingest` for custom goal facts.

*Call graph*: calls 3 internal fn (codex_goal_event_params, goal, thread_context_or_warn); called by 1 (ingest); 2 external calls (new, Goal).


##### `AnalyticsReducer::ingest_guardian_review_completed`  (lines 1311–1351)

```
fn ingest_guardian_review_completed(
        &mut self,
        notification: codex_app_server_protocol::ItemGuardianApprovalReviewCompletedNotification,
        out: &mut Vec<TrackEventRequest>,
```

**Purpose**: Converts a guardian approval review completion notification into a generic review analytics event and updates per-item review summary state.

**Data flow**: Consumes `ItemGuardianApprovalReviewCompletedNotification`, maps guardian status with `guardian_review_result`, derives subject metadata with `guardian_review_subject_metadata`, converts start/completion timestamps with `option_i64_to_u64`, computes requested-permission flags from the action, constructs a `PendingReviewState`, and passes it to `emit_review_event` with reviewer `Guardian`.

**Call relations**: Called from notification handling when guardian review completion notifications arrive. It reuses the same review-event emission path as user approvals.

*Call graph*: calls 5 internal fn (emit_review_event, guardian_review_requested_additional_permissions, guardian_review_requested_network_access, guardian_review_result, guardian_review_subject_metadata); called by 1 (ingest_notification); 1 external calls (option_i64_to_u64).


##### `AnalyticsReducer::ingest_turn_steer_response`  (lines 1353–1376)

```
fn ingest_turn_steer_response(
        &mut self,
        connection_id: u64,
        request_id: RequestId,
        response: TurnSteerResponse,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Completes a successful turn-steer request by incrementing the accepted turn’s steer count and emitting an accepted turn-steer analytics event.

**Data flow**: Consumes connection ID, request ID, `TurnSteerResponse`, and output buffer. It removes the matching pending turn-steer request, increments `steer_count` on the accepted turn if that turn state exists, and calls `emit_turn_steer_event` with the accepted turn ID and result `Accepted`.

**Call relations**: Called from `ingest_response` for successful turn-steer responses.

*Call graph*: calls 1 internal fn (emit_turn_steer_event); called by 1 (ingest_response).


##### `AnalyticsReducer::emit_turn_steer_event`  (lines 1378–1417)

```
fn emit_turn_steer_event(
        &mut self,
        connection_id: u64,
        pending_request: PendingTurnSteerState,
        accepted_turn_id: Option<String>,
        result: TurnSteerResult,
```

**Purpose**: Builds and emits the serialized turn-steer analytics event using connection and thread metadata.

**Data flow**: Consumes connection ID, pending turn-steer state, optional accepted turn ID, result, optional rejection reason, and output buffer. It looks up connection metadata and thread metadata, warns and returns if missing, then pushes `TrackEventRequest::TurnSteer` with a populated `CodexTurnSteerEventRequest`.

**Call relations**: Shared by both successful and failed turn-steer paths. It depends on prior thread initialization having populated `self.threads`.

*Call graph*: calls 2 internal fn (turn_steer, warn_missing_analytics_context); called by 2 (ingest_turn_steer_error_response, ingest_turn_steer_response); 1 external calls (TurnSteer).


##### `AnalyticsReducer::emit_review_event`  (lines 1419–1465)

```
fn emit_review_event(
        &mut self,
        pending_review: PendingReviewState,
        reviewer: Reviewer,
        status: ReviewStatus,
        resolution: ReviewResolution,
        completed_a
```

**Purpose**: Emits a generic review analytics event and, when applicable, updates the per-tool-item review summary used by later tool-item analytics.

**Data flow**: Consumes `PendingReviewState`, reviewer, status, resolution, completion time, and output buffer. It derives an optional `ToolItemKey` with `item_review_summary_key`, updates summary state via `record_item_review_summary`, looks up connection/thread metadata, computes observed duration with `observed_duration_ms`, and pushes `TrackEventRequest::ReviewEvent`.

**Call relations**: Called by user approval responses, guardian review completion, and aborted review paths. It is the central review-event emission routine.

*Call graph*: calls 5 internal fn (review, record_item_review_summary, thread_context_or_warn, item_review_summary_key, observed_duration_ms); called by 4 (ingest_effective_permissions_approval_response, ingest_guardian_review_completed, ingest_server_request_aborted, ingest_server_response); 1 external calls (ReviewEvent).


##### `AnalyticsReducer::record_item_review_summary`  (lines 1467–1484)

```
fn record_item_review_summary(
        &mut self,
        item_key: ToolItemKey,
        reviewer: Reviewer,
        status: ReviewStatus,
        resolution: ReviewResolution,
        pending_review:
```

**Purpose**: Accumulates review counts and final approval outcome for a tool item so the eventual tool-item event can report aggregate review information.

**Data flow**: Consumes a `ToolItemKey`, reviewer, status, resolution, and borrowed `PendingReviewState`. It mutably updates or creates `ItemReviewSummary`, increments total and reviewer-specific counts, overwrites `final_approval_outcome` using `final_approval_outcome`, and ORs in requested-permission flags.

**Call relations**: Called only from `emit_review_event` when the review subject corresponds to a concrete tool item.

*Call graph*: calls 1 internal fn (final_approval_outcome); called by 1 (emit_review_event).


##### `AnalyticsReducer::maybe_emit_turn_event`  (lines 1486–1544)

```
async fn maybe_emit_turn_event(&mut self, turn_id: &str, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Checks whether a turn has accumulated all required state and, if so, emits the turn analytics event plus any accepted-line fingerprint events.

**Data flow**: Reads the `TurnState` for `turn_id`; if thread ID, image count, resolved config, profile, or completion are missing, it returns early. Otherwise it resolves connection and thread metadata, builds `CodexTurnEventParams` with `codex_turn_event_params`, pushes `TrackEventRequest::TurnEvent`, optionally derives accepted-line input with `accepted_line_event_input`, asynchronously fills `repo_hash` via `accepted_line_repo_hash_for_cwd`, extends output with `accepted_line_fingerprint_event_requests`, and finally removes the turn state from `self.turns`.

**Call relations**: Called after each partial turn-state update and on turn completion. It is the convergence point for turn analytics emission.

*Call graph*: calls 6 internal fn (accepted_line_fingerprint_event_requests, accepted_line_repo_hash_for_cwd, turn, accepted_line_event_input, codex_turn_event_params, warn_missing_analytics_context); called by 5 (ingest_notification, ingest_response, ingest_turn_profile, ingest_turn_resolved_config, ingest_turn_token_usage); 2 external calls (new, TurnEvent).


##### `AnalyticsReducer::thread_connection_or_warn`  (lines 1546–1566)

```
fn thread_connection_or_warn(
        &self,
        drop_site: AnalyticsDropSite<'_>,
    ) -> Option<&ConnectionState>
```

**Purpose**: Looks up the connection metadata associated with a thread, logging a structured warning if the thread or connection mapping is missing.

**Data flow**: Reads `self.threads` and `self.connections` using the thread ID from `AnalyticsDropSite`. It returns `Some(&ConnectionState)` on success or logs via `warn_missing_analytics_context` and returns `None` on failure.

**Call relations**: Used by `thread_context_or_warn` as the first half of full thread-context resolution.

*Call graph*: calls 1 internal fn (warn_missing_analytics_context); called by 1 (thread_context_or_warn).


##### `AnalyticsReducer::thread_context_or_warn`  (lines 1568–1582)

```
fn thread_context_or_warn(
        &self,
        drop_site: AnalyticsDropSite<'_>,
    ) -> Option<(&ConnectionState, &ThreadMetadataState)>
```

**Purpose**: Looks up both connection metadata and thread metadata for a given drop site, warning and returning `None` if either is absent.

**Data flow**: Consumes an `AnalyticsDropSite`, delegates to `thread_connection_or_warn`, then reads `self.threads` for metadata. It returns a tuple of borrowed `ConnectionState` and `ThreadMetadataState` or logs and returns `None`.

**Call relations**: Used by compaction, goal, guardian review, review-event, and tool-item emission paths to guard against incomplete reducer context.

*Call graph*: calls 2 internal fn (thread_connection_or_warn, warn_missing_analytics_context); called by 5 (emit_review_event, ingest_compaction, ingest_goal, ingest_guardian_review, ingest_notification).


##### `warn_missing_analytics_context`  (lines 1585–1606)

```
fn warn_missing_analytics_context(
    drop_site: &AnalyticsDropSite<'_>,
    missing: MissingAnalyticsContext,
)
```

**Purpose**: Emits a structured warning describing which analytics event was dropped and which piece of context was missing.

**Data flow**: Reads an `AnalyticsDropSite` and `MissingAnalyticsContext`, derives a string label and optional connection ID, and logs a `tracing::warn!` with thread/turn/review/item identifiers.

**Call relations**: Called by context lookup helpers and turn-steer/turn emission paths whenever analytics cannot be emitted safely.

*Call graph*: called by 4 (emit_turn_steer_event, maybe_emit_turn_event, thread_connection_or_warn, thread_context_or_warn); 1 external calls (warn!).


##### `tracked_tool_item_id`  (lines 1608–1629)

```
fn tracked_tool_item_id(item: &ThreadItem) -> Option<&str>
```

**Purpose**: Extracts the stable item ID for tool-item variants that should participate in tool analytics tracking.

**Data flow**: Reads a borrowed `ThreadItem`, returns `Some(&str)` for command execution, file change, MCP, dynamic tool, collab agent, web search, and image generation items, and `None` for transcript/reasoning/non-tool variants.

**Call relations**: Used by notification handling to decide whether an item should have start/completion timestamps tracked and whether a tool-item analytics event can be emitted.

*Call graph*: called by 1 (ingest_notification).


##### `item_review_summary_key`  (lines 1631–1642)

```
fn item_review_summary_key(pending_review: &PendingReviewState) -> Option<ToolItemKey>
```

**Purpose**: Determines whether a pending review should contribute to a concrete tool item’s review summary and, if so, constructs the key.

**Data flow**: Reads a borrowed `PendingReviewState`. For command execution, file change, and MCP tool call subjects it clones thread ID, turn ID, and item ID into a `ToolItemKey`; for permissions and network-access reviews it returns `None`.

**Call relations**: Called by `emit_review_event` before updating `item_review_summaries`.

*Call graph*: called by 1 (emit_review_event).


##### `tool_item_event`  (lines 1655–1970)

```
fn tool_item_event(input: ToolItemEventInput<'_>) -> Option<TrackEventRequest>
```

**Purpose**: Builds the concrete analytics event for a completed tool item by inspecting the `ThreadItem` variant and deriving variant-specific counters and outcome fields.

**Data flow**: Consumes `ToolItemEventInput`, pattern-matches the borrowed `ThreadItem`, derives terminal status/failure kind via helper functions, computes counts such as command actions, file changes, dynamic content, receiver threads, or web-search query counts, builds a shared `CodexToolItemEventBase` with `tool_item_base`, and returns the appropriate `TrackEventRequest` variant or `None` for unsupported/in-progress items.

**Call relations**: Called from notification handling on `ItemCompleted` after timestamps and thread context are available. It delegates heavily to outcome/count/name helpers to keep per-variant logic localized.

*Call graph*: calls 12 internal fn (collab_agent_tool_name, collab_tool_call_outcome, command_action_counts, command_execution_outcome, command_execution_tool_name, dynamic_tool_call_outcome, file_change_counts, image_generation_outcome, mcp_tool_call_outcome, patch_apply_outcome (+2 more)); called by 1 (ingest_notification); 9 external calls (CollabAgentToolCall, CommandExecution, DynamicToolCall, FileChange, ImageGeneration, McpToolCall, WebSearch, option_i64_to_u64, usize_to_u64).


##### `command_action_counts`  (lines 1987–2001)

```
fn command_action_counts(command_actions: &[CommandAction]) -> CommandActionCounts
```

**Purpose**: Counts command action categories within a command execution item.

**Data flow**: Reads a slice of `CommandAction`, initializes totals from length, iterates actions, increments `read`, `list_files`, `search`, or `unknown`, and returns `CommandActionCounts`.

**Call relations**: Used only by `tool_item_event` when building command execution analytics.

*Call graph*: called by 1 (tool_item_event); 3 external calls (default, len, usize_to_u64).


##### `tool_item_base`  (lines 2012–2050)

```
fn tool_item_base(
    thread_id: &str,
    turn_id: &str,
    item_id: String,
    tool_name: String,
    outcome: ToolItemOutcome,
    context: ToolItemContext<'_>,
) -> CodexToolItemEventBase
```

**Purpose**: Constructs the shared base payload embedded in all tool-item analytics events.

**Data flow**: Consumes thread/turn/item identifiers, tool name, `ToolItemOutcome`, and `ToolItemContext`. It clones connection and thread metadata, computes observed duration with `observed_duration_ms`, folds in optional review summary data or defaults, and returns `CodexToolItemEventBase`.

**Call relations**: Called by each tool-item branch inside `tool_item_event` to avoid duplicating common payload assembly.

*Call graph*: calls 1 internal fn (observed_duration_ms); called by 1 (tool_item_event).


##### `observed_duration_ms`  (lines 2052–2054)

```
fn observed_duration_ms(started_at_ms: u64, completed_at_ms: u64) -> Option<u64>
```

**Purpose**: Computes a nonnegative observed duration from start and completion timestamps.

**Data flow**: Consumes `started_at_ms` and `completed_at_ms`, performs `checked_sub`, and returns `Some(duration)` or `None` if completion precedes start.

**Call relations**: Used by both review-event and tool-item base construction.

*Call graph*: called by 2 (emit_review_event, tool_item_base).


##### `user_review_id`  (lines 2056–2058)

```
fn user_review_id(request_id: &RequestId) -> String
```

**Purpose**: Synthesizes a stable analytics review ID for user approval requests from the underlying JSON-RPC request ID.

**Data flow**: Reads a borrowed `RequestId`, formats it as `user:{request_id}`, and returns the resulting `String`.

**Call relations**: Used when pending user reviews are first recorded in `ingest_server_request`.

*Call graph*: called by 1 (ingest_server_request); 1 external calls (format!).


##### `command_execution_review_result`  (lines 2060–2089)

```
fn command_execution_review_result(
    decision: CommandExecutionApprovalDecision,
) -> (ReviewStatus, ReviewResolution)
```

**Purpose**: Maps a command execution approval decision into analytics review status and resolution.

**Data flow**: Consumes `CommandExecutionApprovalDecision`, pattern-matches all variants, and returns a `(ReviewStatus, ReviewResolution)` pair that distinguishes plain approval, session approval, exec-policy amendment, network-policy amendment, denial, and cancellation.

**Call relations**: Used by `ingest_server_response` for command execution approval responses.

*Call graph*: called by 1 (ingest_server_response).


##### `file_change_review_result`  (lines 2091–2102)

```
fn file_change_review_result(
    decision: FileChangeApprovalDecision,
) -> (ReviewStatus, ReviewResolution)
```

**Purpose**: Maps a file-change approval decision into analytics review status and resolution.

**Data flow**: Consumes `FileChangeApprovalDecision` and returns the corresponding `(ReviewStatus, ReviewResolution)` pair.

**Call relations**: Used by `ingest_server_response` for file-change approval responses.

*Call graph*: called by 1 (ingest_server_response).


##### `effective_permissions_review_result`  (lines 2104–2117)

```
fn effective_permissions_review_result(
    response: &CoreRequestPermissionsResponse,
) -> (ReviewStatus, ReviewResolution)
```

**Purpose**: Interprets the effective granted permissions response as an approval or denial plus scope resolution.

**Data flow**: Reads a borrowed `CoreRequestPermissionsResponse`. If no permissions were granted it returns denied/none; otherwise it maps grant scope `Turn` to approved/none and `Session` to approved/session approval.

**Call relations**: Used by `ingest_effective_permissions_approval_response`.

*Call graph*: called by 1 (ingest_effective_permissions_approval_response).


##### `guardian_review_result`  (lines 2119–2137)

```
fn guardian_review_result(
    status: GuardianApprovalReviewStatus,
) -> Option<(ReviewStatus, ReviewResolution)>
```

**Purpose**: Maps guardian approval review status into analytics review status, omitting in-progress notifications.

**Data flow**: Consumes `GuardianApprovalReviewStatus` and returns `None` for `InProgress` or `Some((ReviewStatus, ReviewResolution::None))` for terminal statuses approved, denied, timed out, or aborted.

**Call relations**: Used by `ingest_guardian_review_completed` to ignore nonterminal notifications and normalize terminal ones.

*Call graph*: called by 1 (ingest_guardian_review_completed).


##### `guardian_review_subject_metadata`  (lines 2139–2188)

```
fn guardian_review_subject_metadata(
    action: &GuardianApprovalReviewAction,
) -> (ReviewSubjectKind, String, ReviewTrigger)
```

**Purpose**: Derives analytics subject kind, subject name, and trigger from the reviewed guardian action.

**Data flow**: Reads a borrowed `GuardianApprovalReviewAction`, pattern-matches its variant, and returns a tuple describing the review subject and trigger. `RequestPermissions` inspects nested network/file-system permissions to distinguish initial, sandbox-denial, and network-policy-denial triggers.

**Call relations**: Used by `ingest_guardian_review_completed` when converting guardian review notifications into generic review events.

*Call graph*: called by 1 (ingest_guardian_review_completed).


##### `guardian_review_requested_additional_permissions`  (lines 2190–2202)

```
fn guardian_review_requested_additional_permissions(action: &GuardianApprovalReviewAction) -> bool
```

**Purpose**: Determines whether a guardian-reviewed action requested any additional permissions for analytics summary purposes.

**Data flow**: Reads a borrowed `GuardianApprovalReviewAction`. It returns true for apply-patch and network-access actions, inspects `RequestPermissions` via `guardian_review_request_permissions_network_enabled` and file-system presence, and returns false for command/execve/MCP actions.

**Call relations**: Used by `ingest_guardian_review_completed` to populate pending review summary flags.

*Call graph*: calls 1 internal fn (guardian_review_request_permissions_network_enabled); called by 1 (ingest_guardian_review_completed).


##### `guardian_review_requested_network_access`  (lines 2204–2215)

```
fn guardian_review_requested_network_access(action: &GuardianApprovalReviewAction) -> bool
```

**Purpose**: Determines whether a guardian-reviewed action requested network access.

**Data flow**: Reads a borrowed `GuardianApprovalReviewAction`, returns true for explicit network-access actions, inspects `RequestPermissions` network settings via `guardian_review_request_permissions_network_enabled`, and returns false otherwise.

**Call relations**: Used by `ingest_guardian_review_completed` alongside the additional-permissions helper.

*Call graph*: calls 1 internal fn (guardian_review_request_permissions_network_enabled); called by 1 (ingest_guardian_review_completed).


##### `guardian_review_request_permissions_network_enabled`  (lines 2217–2225)

```
fn guardian_review_request_permissions_network_enabled(
    permissions: &RequestPermissionProfile,
) -> bool
```

**Purpose**: Extracts the boolean network-enabled flag from a request-permissions profile.

**Data flow**: Reads a borrowed `RequestPermissionProfile`, traverses optional `network.enabled`, defaults missing values to false, and returns the resulting `bool`.

**Call relations**: Shared helper for the two guardian review permission-flag functions.

*Call graph*: called by 2 (guardian_review_requested_additional_permissions, guardian_review_requested_network_access).


##### `final_approval_outcome`  (lines 2227–2243)

```
fn final_approval_outcome(
    reviewer: Reviewer,
    status: ReviewStatus,
    resolution: ReviewResolution,
) -> FinalApprovalOutcome
```

**Purpose**: Collapses reviewer, review status, and resolution into the single final approval outcome enum stored on tool-item analytics.

**Data flow**: Consumes `Reviewer`, `ReviewStatus`, and `ReviewResolution`, pattern-matches the tuple, and returns a `FinalApprovalOutcome` such as `GuardianApproved`, `UserApprovedForSession`, or `UserAborted`.

**Call relations**: Used by `record_item_review_summary` whenever a review affecting a tool item completes.

*Call graph*: called by 1 (record_item_review_summary).


##### `command_execution_tool_name`  (lines 2245–2252)

```
fn command_execution_tool_name(source: CommandExecutionSource) -> &'static str
```

**Purpose**: Maps command execution source to the analytics tool name string.

**Data flow**: Consumes `CommandExecutionSource` and returns `unified_exec`, `user_shell`, or `shell`.

**Call relations**: Used by `tool_item_event` when building command execution analytics.

*Call graph*: called by 1 (tool_item_event).


##### `command_execution_outcome`  (lines 2254–2269)

```
fn command_execution_outcome(
    status: &CommandExecutionStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps command execution status into tool terminal status and failure kind, skipping in-progress items.

**Data flow**: Reads a borrowed `CommandExecutionStatus` and returns `None` for `InProgress` or `Some((ToolItemTerminalStatus, Option<ToolItemFailureKind>))` for completed, failed, or declined outcomes.

**Call relations**: Used by `tool_item_event` to decide whether a command execution item is ready for analytics emission.

*Call graph*: called by 1 (tool_item_event).


##### `patch_apply_outcome`  (lines 2271–2286)

```
fn patch_apply_outcome(
    status: &PatchApplyStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps patch/file-change status into tool terminal status and failure kind, skipping in-progress items.

**Data flow**: Reads a borrowed `PatchApplyStatus` and returns `None` for `InProgress` or the corresponding completed/failed/rejected tuple.

**Call relations**: Used by `tool_item_event` for file-change analytics.

*Call graph*: called by 1 (tool_item_event).


##### `mcp_tool_call_outcome`  (lines 2288–2299)

```
fn mcp_tool_call_outcome(
    status: &McpToolCallStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps MCP tool call status into tool terminal status and failure kind, skipping in-progress items.

**Data flow**: Reads a borrowed `McpToolCallStatus` and returns `None` for `InProgress` or the corresponding completed/failed tuple.

**Call relations**: Used by `tool_item_event` for MCP tool call analytics.

*Call graph*: called by 1 (tool_item_event).


##### `dynamic_tool_call_outcome`  (lines 2301–2312)

```
fn dynamic_tool_call_outcome(
    status: &DynamicToolCallStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps dynamic tool call status into tool terminal status and failure kind, skipping in-progress items.

**Data flow**: Reads a borrowed `DynamicToolCallStatus` and returns `None` for `InProgress` or the corresponding completed/failed tuple.

**Call relations**: Used by `tool_item_event` for dynamic tool call analytics.

*Call graph*: called by 1 (tool_item_event).


##### `collab_tool_call_outcome`  (lines 2314–2325)

```
fn collab_tool_call_outcome(
    status: &CollabAgentToolCallStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps collaborative agent tool call status into tool terminal status and failure kind, skipping in-progress items.

**Data flow**: Reads a borrowed `CollabAgentToolCallStatus` and returns `None` for `InProgress` or the corresponding completed/failed tuple.

**Call relations**: Used by `tool_item_event` for collab-agent tool analytics.

*Call graph*: called by 1 (tool_item_event).


##### `image_generation_outcome`  (lines 2327–2335)

```
fn image_generation_outcome(status: &str) -> (ToolItemTerminalStatus, Option<ToolItemFailureKind>)
```

**Purpose**: Normalizes image generation status strings into analytics terminal status and failure kind.

**Data flow**: Reads a status string slice; `failed` and `error` map to failed/tool-error, while all other strings map to completed/no failure.

**Call relations**: Used by `tool_item_event` for image generation analytics because that protocol surface exposes a string status rather than a typed enum.

*Call graph*: called by 1 (tool_item_event).


##### `collab_agent_tool_name`  (lines 2337–2345)

```
fn collab_agent_tool_name(tool: &CollabAgentTool) -> &'static str
```

**Purpose**: Maps collaborative agent tool enum variants to analytics tool name strings.

**Data flow**: Consumes a borrowed `CollabAgentTool` and returns one of `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, or `close_agent`.

**Call relations**: Used by `tool_item_event` when building collab-agent tool call analytics.

*Call graph*: called by 1 (tool_item_event).


##### `file_change_counts`  (lines 2355–2366)

```
fn file_change_counts(changes: &[codex_app_server_protocol::FileUpdateChange]) -> FileChangeCounts
```

**Purpose**: Counts add/update/delete/move operations within a file-change item.

**Data flow**: Reads a slice of `FileUpdateChange`, initializes `FileChangeCounts::default()`, iterates changes, increments counters based on `PatchChangeKind`, and returns the counts.

**Call relations**: Used by `tool_item_event` for file-change analytics.

*Call graph*: called by 1 (tool_item_event); 1 external calls (default).


##### `dynamic_content_counts`  (lines 2375–2389)

```
fn dynamic_content_counts(items: &[DynamicToolCallOutputContentItem]) -> DynamicContentCounts
```

**Purpose**: Counts total, text, and image output content items from a dynamic tool call.

**Data flow**: Reads a slice of `DynamicToolCallOutputContentItem`, iterates items to count text vs image variants, computes total from length, and returns `DynamicContentCounts`.

**Call relations**: Used by `tool_item_event` when a dynamic tool call reports output content items.

*Call graph*: 2 external calls (len, usize_to_u64).


##### `web_search_action_kind`  (lines 2391–2398)

```
fn web_search_action_kind(action: &WebSearchAction) -> WebSearchActionKind
```

**Purpose**: Maps protocol web-search action variants into the analytics `WebSearchActionKind` enum.

**Data flow**: Consumes a borrowed `WebSearchAction` and returns `Search`, `OpenPage`, `FindInPage`, or `Other`.

**Call relations**: Used by `tool_item_event` for web-search analytics.


##### `web_search_query_count`  (lines 2400–2411)

```
fn web_search_query_count(query: &str, action: Option<&WebSearchAction>) -> Option<u64>
```

**Purpose**: Derives how many search queries were represented by a web-search item, when that concept applies.

**Data flow**: Reads the raw query string and optional `WebSearchAction`. For `Search`, it prefers the explicit `queries` list length, otherwise counts a single nonempty query. For open-page/find-in-page/other actions it returns `None`. With no action, it returns `Some(1)` only if the raw query is nonblank.

**Call relations**: Used by `tool_item_event` to populate `query_count` on web-search analytics.

*Call graph*: called by 1 (tool_item_event).


##### `accepted_line_event_input`  (lines 2413–2441)

```
fn accepted_line_event_input(
    turn_id: &str,
    turn_state: &TurnState,
) -> Option<(AcceptedLineFingerprintEventInput, PathBuf)>
```

**Purpose**: Builds the intermediate input for accepted-line fingerprint analytics from a completed turn’s latest diff and resolved config.

**Data flow**: Reads `turn_id` and borrowed `TurnState`, extracts `latest_diff`, computes accepted-line summary via `accepted_line_fingerprints_from_unified_diff`, returns `None` if both added and deleted accepted counts are zero, otherwise clones thread ID and resolved config, stamps `completed_at` with `now_unix_seconds()`, and returns `(AcceptedLineFingerprintEventInput, permission_profile_cwd)`.

**Call relations**: Called by `maybe_emit_turn_event` after the main turn event is emitted so accepted-line analytics can be generated opportunistically.

*Call graph*: calls 1 internal fn (accepted_line_fingerprints_from_unified_diff); called by 1 (maybe_emit_turn_event); 1 external calls (now_unix_seconds).


##### `codex_turn_event_params`  (lines 2443–2570)

```
fn codex_turn_event_params(
    app_server_client: CodexAppServerClientMetadata,
    runtime: CodexRuntimeMetadata,
    turn_id: String,
    turn_state: &TurnState,
    thread_metadata: &ThreadMetadat
```

**Purpose**: Assembles the full turn analytics payload from accumulated turn state plus connection and thread metadata.

**Data flow**: Consumes app-server client metadata, runtime metadata, turn ID, borrowed `TurnState`, and borrowed `ThreadMetadataState`. It requires populated thread ID, image count, resolved config, profile, and completion state, destructures those values, derives sandbox policy, collaboration mode, reasoning summary, and personality strings via helper functions, copies token usage and tool counts, and returns `CodexTurnEventParams`.

**Call relations**: Called only by `maybe_emit_turn_event` once all prerequisites are satisfied. It is the final turn-payload assembler.

*Call graph*: calls 4 internal fn (collaboration_mode_mode, personality_mode, reasoning_summary_mode, sandbox_policy_mode); called by 1 (maybe_emit_turn_event); 1 external calls (unreachable!).


##### `sandbox_policy_mode`  (lines 2572–2594)

```
fn sandbox_policy_mode(permission_profile: &PermissionProfile, cwd: &Path) -> &'static str
```

**Purpose**: Classifies a permission profile and cwd into the analytics sandbox policy mode string.

**Data flow**: Reads a borrowed `PermissionProfile` and cwd path. Disabled profiles map to `full_access`, external profiles to `external_sandbox`, and managed profiles inspect file-system and network sandbox policies to distinguish `full_access`, `external_sandbox`, `read_only`, and `workspace_write`.

**Call relations**: Used by `codex_turn_event_params` to populate the turn’s `sandbox_policy` field.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, network_sandbox_policy); called by 1 (codex_turn_event_params).


##### `collaboration_mode_mode`  (lines 2596–2601)

```
fn collaboration_mode_mode(mode: ModeKind) -> &'static str
```

**Purpose**: Normalizes collaboration mode into the analytics string vocabulary.

**Data flow**: Consumes `ModeKind` and returns `plan` for `Plan`, otherwise `default` for `Default`, `PairProgramming`, and `Execute`.

**Call relations**: Used by `codex_turn_event_params`.

*Call graph*: called by 1 (codex_turn_event_params).


##### `reasoning_summary_mode`  (lines 2603–2608)

```
fn reasoning_summary_mode(summary: Option<ReasoningSummary>) -> Option<String>
```

**Purpose**: Converts optional reasoning summary configuration into the analytics string field, suppressing explicit `None`.

**Data flow**: Consumes `Option<ReasoningSummary>` and returns `None` for absent or `ReasoningSummary::None`, otherwise `Some(summary.to_string())`.

**Call relations**: Used by `codex_turn_event_params`.

*Call graph*: called by 1 (codex_turn_event_params).


##### `personality_mode`  (lines 2610–2615)

```
fn personality_mode(personality: Option<Personality>) -> Option<String>
```

**Purpose**: Converts optional personality configuration into the analytics string field, suppressing explicit `None`.

**Data flow**: Consumes `Option<Personality>` and returns `None` for absent or `Personality::None`, otherwise `Some(personality.to_string())`.

**Call relations**: Used by `codex_turn_event_params`.

*Call graph*: called by 1 (codex_turn_event_params).


##### `analytics_turn_status`  (lines 2617–2624)

```
fn analytics_turn_status(status: codex_app_server_protocol::TurnStatus) -> Option<TurnStatus>
```

**Purpose**: Maps protocol turn status into analytics turn status, omitting in-progress turns.

**Data flow**: Consumes protocol `TurnStatus` and returns `Some(Completed|Failed|Interrupted)` or `None` for `InProgress`.

**Call relations**: Used by notification handling when storing completed turn state.

*Call graph*: called by 1 (ingest_notification).


##### `num_input_images`  (lines 2626–2631)

```
fn num_input_images(input: &[UserInput]) -> usize
```

**Purpose**: Counts image inputs in a turn-start or turn-steer request payload.

**Data flow**: Reads a slice of `UserInput`, filters for `Image` and `LocalImage` variants, counts them, and returns the `usize` total.

**Call relations**: Used by `ingest_request` when recording pending turn-start and turn-steer requests.

*Call graph*: called by 1 (ingest_request); 1 external calls (iter).


##### `rejection_reason_from_error_type`  (lines 2633–2640)

```
fn rejection_reason_from_error_type(
    error_type: Option<AnalyticsJsonRpcError>,
) -> Option<TurnSteerRejectionReason>
```

**Purpose**: Converts an optional analytics JSON-RPC error classification into an optional turn-steer rejection reason.

**Data flow**: Consumes `Option<AnalyticsJsonRpcError>`, returns `None` if absent, otherwise maps `TurnSteer` and `Input` variants through their respective `Into<TurnSteerRejectionReason>` conversions.

**Call relations**: Used by `ingest_turn_steer_error_response`.

*Call graph*: called by 1 (ingest_turn_steer_error_response).


##### `skill_id_for_local_skill`  (lines 2642–2658)

```
fn skill_id_for_local_skill(
    repo_url: Option<&str>,
    repo_root: Option<&Path>,
    skill_path: &Path,
    skill_name: &str,
) -> String
```

**Purpose**: Computes a stable SHA-1 skill identifier from repo context, normalized path, and skill name.

**Data flow**: Consumes optional repo URL, optional repo root, skill path, and skill name. It normalizes the path with `normalize_path_for_skill_id`, prefixes with `repo_{url}` or `personal`, concatenates prefix/path/name into a raw ID string, hashes it with `sha1`, and returns the lowercase hex digest.

**Call relations**: Used by skill invocation ingestion and tests to ensure local skills have stable anonymized IDs.

*Call graph*: calls 1 internal fn (normalize_path_for_skill_id); called by 2 (reducer_ingests_skill_invoked_fact, ingest_skill_invoked); 3 external calls (format!, update, new).


##### `normalize_path_for_skill_id`  (lines 2664–2682)

```
fn normalize_path_for_skill_id(
    repo_url: Option<&str>,
    repo_root: Option<&Path>,
    skill_path: &Path,
) -> String
```

**Purpose**: Normalizes a skill path for skill-ID construction, using repo-relative paths when possible and absolute canonical paths otherwise.

**Data flow**: Consumes optional repo URL, optional repo root, and skill path. It canonicalizes the skill path, and if both repo URL and repo root are present it canonicalizes the root and strips it as a prefix when possible; otherwise it uses the absolute path. In all cases it converts separators to `/` and returns a `String`.

**Call relations**: Called by `skill_id_for_local_skill` and exercised directly by tests covering repo-scoped and user/admin-scoped skills.

*Call graph*: called by 5 (normalize_path_for_skill_id_admin_scoped_uses_absolute_path, normalize_path_for_skill_id_repo_root_not_in_skill_path_uses_absolute_path, normalize_path_for_skill_id_repo_scoped_uses_relative_path, normalize_path_for_skill_id_user_scoped_uses_absolute_path, skill_id_for_local_skill); 1 external calls (canonicalize).


##### `tests::managed_full_disk_with_restricted_network_reports_external_sandbox`  (lines 2692–2703)

```
fn managed_full_disk_with_restricted_network_reports_external_sandbox()
```

**Purpose**: Verifies that managed full-disk access combined with restricted network is classified as `external_sandbox` rather than `full_access`.

**Data flow**: Builds a managed `PermissionProfile` from runtime permissions and asserts the result of `sandbox_policy_mode`.

**Call relations**: Unit test for the sandbox policy classification helper.

*Call graph*: calls 2 internal fn (from_runtime_permissions_with_enforcement, unrestricted); 1 external calls (assert_eq!).


##### `tests::guardian_review_result_maps_terminal_statuses`  (lines 2706–2712)

```
fn guardian_review_result_maps_terminal_statuses()
```

**Purpose**: Checks that guardian review status normalization drops in-progress states and preserves timed-out terminal states.

**Data flow**: Calls `guardian_review_result` with representative statuses and asserts on the returned `Option`/tuple values.

**Call relations**: Unit test for guardian review status mapping.

*Call graph*: 1 external calls (assert!).


### Client delivery layer
These files expose the runtime client that queues, reduces, deduplicates, and delivers analytics events for the application.

### `analytics/src/client.rs`

`orchestration` · `cross-cutting analytics collection and delivery`

This file is the orchestration layer between raw runtime facts and outbound analytics delivery. `AnalyticsEventsClient` is the public-facing handle; internally it optionally owns an `AnalyticsEventsQueue`, allowing analytics to be globally disabled by setting `queue: None`. The queue contains a Tokio `mpsc::Sender<AnalyticsFact>` plus two mutex-protected `HashSet`s used to deduplicate app-used and plugin-used events by `(turn_id, connector_id)` and `(turn_id, plugin_id)` respectively. To bound memory, each dedupe set is cleared once it reaches `ANALYTICS_EVENT_DEDUPE_MAX_KEYS`.

`AnalyticsEventsQueue::new` spawns a background task that receives `AnalyticsFact`s, feeds them into `AnalyticsReducer`, collects any emitted `TrackEventRequest`s, and passes them to `send_track_events`. The client’s many `track_*` methods are mostly typed adapters that filter irrelevant protocol traffic, wrap inputs into the appropriate `AnalyticsFact` or `CustomAnalyticsFact`, and enqueue them via `record_fact`. Notably, `track_request`, `track_response`, and `track_notification` only forward a curated subset of protocol messages relevant to analytics state transitions.

Delivery is controlled by `AnalyticsEventsDestination`. In normal mode it trims the configured base URL and appends `/codex/analytics-events/events`. In debug builds, an environment variable can switch delivery to a capture file; initialization failures are logged, and capture mode disables network delivery. `send_track_events` first drops empty batches, then requires an authenticated `CodexAuth` that uses the Codex backend. `track_event_request_batches` isolates any event whose `should_send_in_isolated_request()` returns true—currently important for accepted-line fingerprint events—so those events are sent in their own requests. `send_track_events_request` serializes `TrackEventsRequest`, optionally captures it to disk in debug mode, otherwise posts JSON with auth headers and a 10-second timeout, logging non-success statuses or transport failures without retrying.

#### Function details

##### `AnalyticsEventsDestination::from_base_url`  (lines 75–78)

```
fn from_base_url(base_url: String) -> Self
```

**Purpose**: Constructs the analytics destination from a base URL, consulting the debug capture-file environment variable first.

**Data flow**: Accepts a base URL string, reads an optional capture path via `analytics_capture_file_from_env`, forwards both values to `from_base_url_and_capture_file`, and returns the resulting `AnalyticsEventsDestination`.

**Call relations**: Called by `AnalyticsEventsClient::new` during client construction. It centralizes the environment-sensitive destination selection.

*Call graph*: calls 1 internal fn (analytics_capture_file_from_env); called by 1 (new); 1 external calls (from_base_url_and_capture_file).


##### `AnalyticsEventsDestination::from_base_url_and_capture_file`  (lines 80–103)

```
fn from_base_url_and_capture_file(base_url: String, capture_file: Option<PathBuf>) -> Self
```

**Purpose**: Chooses between HTTP delivery and debug capture-file delivery, initializing the capture file when requested.

**Data flow**: Takes a base URL and optional `PathBuf`. In debug builds, if a capture path is present it tries `crate::analytics_capture::initialize(&path)`, logs initialization errors, logs that capture mode disables network delivery, and returns `CaptureFile { path }`. Otherwise it trims trailing slashes from the base URL and returns `Http { url: format!("{base_url}/codex/analytics-events/events") }`.

**Call relations**: Used by `from_base_url` and directly by tests. It is the only place where capture mode can override network delivery.

*Call graph*: calls 1 internal fn (initialize); called by 3 (analytics_destination_ignores_capture_file_in_release, analytics_destination_uses_explicit_capture_file, analytics_destination_uses_http_without_capture_file); 3 external calls (format!, error!, warn!).


##### `analytics_capture_file_from_env`  (lines 106–116)

```
fn analytics_capture_file_from_env() -> Option<PathBuf>
```

**Purpose**: Reads the debug-only analytics capture file path from the configured environment variable.

**Data flow**: In debug builds, reads `ANALYTICS_EVENTS_CAPTURE_FILE_ENV_VAR` with `std::env::var_os`, filters out empty values, converts the result into `PathBuf`, and returns `Option<PathBuf>`. In non-debug builds it always returns `None`.

**Call relations**: Called only by `AnalyticsEventsDestination::from_base_url` to decide whether capture mode should be enabled.

*Call graph*: called by 1 (from_base_url); 1 external calls (var_os).


##### `AnalyticsEventsQueue::new`  (lines 119–134)

```
fn new(auth_manager: Arc<AuthManager>, destination: AnalyticsEventsDestination) -> Self
```

**Purpose**: Creates the bounded analytics fact queue, initializes dedupe state, and spawns the background reducer-and-delivery task.

**Data flow**: Accepts shared `AuthManager` and an `AnalyticsEventsDestination`, creates an `mpsc` channel of size 256, spawns an async task that owns a default `AnalyticsReducer` and loops over received `AnalyticsFact`s, reducing each into a temporary `Vec<TrackEventRequest>` and passing that vector to `send_track_events`, then returns `AnalyticsEventsQueue` with the sender and empty dedupe `HashSet`s wrapped in `Arc<Mutex<_>>`.

**Call relations**: Constructed by `AnalyticsEventsClient::new` when analytics are enabled. It is the core runtime driver that connects fact ingestion to event delivery.

*Call graph*: calls 1 internal fn (send_track_events); 7 external calls (new, new, new, new, default, channel, spawn).


##### `AnalyticsEventsQueue::try_send`  (lines 136–141)

```
fn try_send(&self, input: AnalyticsFact)
```

**Purpose**: Attempts to enqueue one analytics fact without blocking and drops it with a warning if the queue is full.

**Data flow**: Takes an `AnalyticsFact`, calls `self.sender.try_send(input)`, and if that returns an error logs a warning that analytics events are being dropped.

**Call relations**: Used exclusively by `AnalyticsEventsClient::record_fact`. It is the queue backpressure boundary for the whole analytics subsystem.

*Call graph*: 2 external calls (try_send, warn!).


##### `AnalyticsEventsQueue::should_enqueue_app_used`  (lines 143–159)

```
fn should_enqueue_app_used(
        &self,
        tracking: &TrackEventsContext,
        app: &AppInvocation,
    ) -> bool
```

**Purpose**: Implements per-turn deduplication for app-used analytics keyed by connector id.

**Data flow**: Accepts tracking context and `AppInvocation`. If `app.connector_id` is `None`, returns `true` immediately. Otherwise it locks `app_used_emitted_keys`, clears the set if it has reached 4096 entries, inserts `(tracking.turn_id.clone(), connector_id.clone())`, and returns whether the insert was new.

**Call relations**: Called by `AnalyticsEventsClient::track_app_used` before enqueuing a custom app-used fact. It prevents duplicate app-used events within the same turn for the same connector.


##### `AnalyticsEventsQueue::should_enqueue_plugin_used`  (lines 161–174)

```
fn should_enqueue_plugin_used(
        &self,
        tracking: &TrackEventsContext,
        plugin: &PluginTelemetryMetadata,
    ) -> bool
```

**Purpose**: Implements per-turn deduplication for plugin-used analytics keyed by plugin id.

**Data flow**: Locks `plugin_used_emitted_keys`, clears it if it has reached 4096 entries, inserts `(tracking.turn_id.clone(), plugin.plugin_id.as_key())`, and returns whether the insert was new.

**Call relations**: Called by `AnalyticsEventsClient::track_plugin_used` before enqueuing a plugin-used fact.


##### `AnalyticsEventsClient::new`  (lines 178–188)

```
fn new(
        auth_manager: Arc<AuthManager>,
        base_url: String,
        analytics_enabled: Option<bool>,
    ) -> Self
```

**Purpose**: Constructs an analytics client that is either enabled with a background queue or disabled based on configuration.

**Data flow**: Accepts shared `AuthManager`, base URL, and optional `analytics_enabled` flag; builds a destination with `AnalyticsEventsDestination::from_base_url`; if `analytics_enabled != Some(false)` creates an `AnalyticsEventsQueue` with the auth manager and destination; stores the resulting `Option<AnalyticsEventsQueue>` in `AnalyticsEventsClient`.

**Call relations**: This is the main constructor used by application code. It wires together destination selection and queue startup.

*Call graph*: calls 1 internal fn (from_base_url); called by 4 (analytics_events_client_from_config, emit_subagent_session_started_includes_fork_lineage_from_session_configuration, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx).


##### `AnalyticsEventsClient::disabled`  (lines 190–192)

```
fn disabled() -> Self
```

**Purpose**: Constructs a client that silently drops all analytics by having no queue.

**Data flow**: Returns `AnalyticsEventsClient { queue: None }`.

**Call relations**: Used by many tests and by callers that want a no-op analytics client.

*Call graph*: called by 33 (command_execution_started_helper_emits_once, complete_command_execution_item_emits_declined_once_for_pending_command, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, test_handle_token_count_event_emits_usage_and_rate_limits, test_handle_token_count_event_without_usage_info, test_handle_turn_complete_emits_completed_without_error, test_handle_turn_complete_emits_error_multiple_turns, test_handle_turn_complete_emits_failed_with_error, test_handle_turn_diff_emits_v2_notification (+15 more)).


##### `AnalyticsEventsClient::track_skill_invocations`  (lines 194–208)

```
fn track_skill_invocations(
        &self,
        tracking: TrackEventsContext,
        invocations: Vec<SkillInvocation>,
    )
```

**Purpose**: Records a batch of skill invocation facts if the batch is non-empty.

**Data flow**: Accepts `TrackEventsContext` and `Vec<SkillInvocation>`, returns early if the vector is empty, otherwise wraps them in `CustomAnalyticsFact::SkillInvoked(SkillInvokedInput { ... })` inside `AnalyticsFact::Custom` and passes that fact to `record_fact`.

**Call relations**: Called by higher-level skill injection/build logic. It is a thin adapter from typed inputs to reducer facts.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (build_skill_injections); 2 external calls (Custom, SkillInvoked).


##### `AnalyticsEventsClient::track_initialize`  (lines 210–224)

```
fn track_initialize(
        &self,
        connection_id: u64,
        params: InitializeParams,
        product_client_id: String,
        rpc_transport: AppServerRpcTransport,
    )
```

**Purpose**: Records an initialize fact for a client connection, attaching current runtime metadata at the moment of tracking.

**Data flow**: Accepts connection id, `InitializeParams`, product client id, and RPC transport; calls `current_runtime_metadata()`; wraps everything in `AnalyticsFact::Initialize`; enqueues it via `record_fact`.

**Call relations**: Called when a client connection initializes. It seeds reducer state used later to enrich thread, turn, and review events.

*Call graph*: calls 2 internal fn (record_fact, current_runtime_metadata); called by 1 (initialize).


##### `AnalyticsEventsClient::track_subagent_thread_started`  (lines 226–230)

```
fn track_subagent_thread_started(&self, input: SubAgentThreadStartedInput)
```

**Purpose**: Records a custom fact announcing that a subagent thread has started.

**Data flow**: Accepts `SubAgentThreadStartedInput`, wraps it in `CustomAnalyticsFact::SubAgentThreadStarted`, and forwards it to `record_fact`.

**Call relations**: Called by subagent session-start logic so the reducer can emit thread initialization analytics even without a normal initialize/request/response sequence.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (emit_subagent_session_started); 2 external calls (Custom, SubAgentThreadStarted).


##### `AnalyticsEventsClient::track_guardian_review`  (lines 232–241)

```
fn track_guardian_review(
        &self,
        tracking: &GuardianReviewTrackContext,
        result: GuardianReviewAnalyticsResult,
        completed_at_ms: u64,
    )
```

**Purpose**: Records a guardian review analytics fact derived from a tracking context and review result.

**Data flow**: Accepts `GuardianReviewTrackContext`, `GuardianReviewAnalyticsResult`, and completion timestamp, computes event params by calling `tracking.event_params(result, completed_at_ms)`, boxes them inside `CustomAnalyticsFact::GuardianReview`, and enqueues the fact.

**Call relations**: Used by guardian review code paths to emit custom review analytics without going through app-server notifications.

*Call graph*: calls 2 internal fn (record_fact, event_params); 3 external calls (new, Custom, GuardianReview).


##### `AnalyticsEventsClient::track_app_mentioned`  (lines 243–250)

```
fn track_app_mentioned(&self, tracking: TrackEventsContext, mentions: Vec<AppInvocation>)
```

**Purpose**: Records app-mentioned analytics only when there is at least one mention.

**Data flow**: Accepts tracking context and `Vec<AppInvocation>`, returns early if the vector is empty, otherwise wraps it in `CustomAnalyticsFact::AppMentioned(AppMentionedInput { ... })` and enqueues it.

**Call relations**: Called by code that detects app mentions in a turn.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (Custom, AppMentioned).


##### `AnalyticsEventsClient::track_request`  (lines 252–269)

```
fn track_request(
        &self,
        connection_id: u64,
        request_id: RequestId,
        request: &ClientRequest,
    )
```

**Purpose**: Filters client requests down to analytics-relevant request types and records only turn-start and turn-steer requests.

**Data flow**: Accepts connection id, request id, and borrowed `ClientRequest`; if the request is not `TurnStart` or `TurnSteer`, returns immediately. Otherwise clones the request, boxes it inside `AnalyticsFact::ClientRequest`, and enqueues it.

**Call relations**: Called by request-tracking code. Its filtering ensures the reducer only sees request types that affect analytics state.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (track_initialized_request); 3 external calls (new, clone, matches!).


##### `AnalyticsEventsClient::track_app_used`  (lines 271–281)

```
fn track_app_used(&self, tracking: TrackEventsContext, app: AppInvocation)
```

**Purpose**: Records an app-used fact if analytics are enabled and the `(turn, connector)` pair has not already been emitted.

**Data flow**: Accepts tracking context and `AppInvocation`, returns early if `queue` is `None`, then calls `queue.should_enqueue_app_used(&tracking, &app)` and returns if that is false. On success it wraps the inputs in `CustomAnalyticsFact::AppUsed(AppUsedInput { ... })` and enqueues the fact.

**Call relations**: Called by app-usage tracking code. It combines enablement checking, dedupe, and fact creation.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (Custom, AppUsed).


##### `AnalyticsEventsClient::track_hook_run`  (lines 283–287)

```
fn track_hook_run(&self, tracking: TrackEventsContext, hook: HookRunFact)
```

**Purpose**: Records a hook-run custom analytics fact.

**Data flow**: Accepts tracking context and `HookRunFact`, wraps them in `HookRunInput` inside `CustomAnalyticsFact::HookRun`, and enqueues the fact.

**Call relations**: Used by hook execution code paths.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (Custom, HookRun).


##### `AnalyticsEventsClient::track_plugin_used`  (lines 289–299)

```
fn track_plugin_used(&self, tracking: TrackEventsContext, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records a plugin-used fact if analytics are enabled and the `(turn, plugin)` pair has not already been emitted.

**Data flow**: Accepts tracking context and `PluginTelemetryMetadata`, returns early if disabled, checks `queue.should_enqueue_plugin_used`, and if true wraps the inputs in `CustomAnalyticsFact::PluginUsed` and enqueues the fact.

**Call relations**: Parallel to `track_app_used`, but keyed by plugin id.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (Custom, PluginUsed).


##### `AnalyticsEventsClient::track_compaction`  (lines 301–305)

```
fn track_compaction(&self, event: crate::facts::CodexCompactionEvent)
```

**Purpose**: Records a custom compaction analytics fact.

**Data flow**: Accepts a `CodexCompactionEvent`, boxes it inside `CustomAnalyticsFact::Compaction`, and enqueues it.

**Call relations**: Called by compaction logic when a compaction attempt completes or fails.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, Compaction).


##### `AnalyticsEventsClient::track_goal_event`  (lines 307–311)

```
fn track_goal_event(&self, event: CodexGoalEvent)
```

**Purpose**: Records a custom goal analytics fact.

**Data flow**: Accepts `CodexGoalEvent`, boxes it inside `CustomAnalyticsFact::Goal`, and enqueues it.

**Call relations**: Called by higher-level goal tracking code.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (track); 3 external calls (new, Custom, Goal).


##### `AnalyticsEventsClient::track_turn_resolved_config`  (lines 313–317)

```
fn track_turn_resolved_config(&self, fact: TurnResolvedConfigFact)
```

**Purpose**: Records the resolved configuration fact for a turn.

**Data flow**: Accepts `TurnResolvedConfigFact`, boxes it inside `CustomAnalyticsFact::TurnResolvedConfig`, and enqueues it.

**Call relations**: Called when turn configuration becomes known so the reducer can later emit a complete turn event.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, TurnResolvedConfig).


##### `AnalyticsEventsClient::track_turn_token_usage`  (lines 319–323)

```
fn track_turn_token_usage(&self, fact: TurnTokenUsageFact)
```

**Purpose**: Records token usage for a turn.

**Data flow**: Accepts `TurnTokenUsageFact`, boxes it inside `CustomAnalyticsFact::TurnTokenUsage`, and enqueues it.

**Call relations**: Used by token accounting code to enrich later turn events.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, TurnTokenUsage).


##### `AnalyticsEventsClient::track_turn_profile`  (lines 325–329)

```
fn track_turn_profile(&self, fact: TurnProfileFact)
```

**Purpose**: Records timing/profile metrics for a turn.

**Data flow**: Accepts `TurnProfileFact`, boxes it inside `CustomAnalyticsFact::TurnProfile`, and enqueues it.

**Call relations**: Used by profiling code to enrich later turn events.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, TurnProfile).


##### `AnalyticsEventsClient::track_turn_codex_error`  (lines 331–335)

```
fn track_turn_codex_error(&self, fact: TurnCodexErrorFact)
```

**Purpose**: Records a classified Codex error fact for a turn.

**Data flow**: Accepts `TurnCodexErrorFact`, boxes it inside `CustomAnalyticsFact::TurnCodexError`, and enqueues it.

**Call relations**: Used when a turn encounters a Codex-layer error that should be reflected in analytics.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, TurnCodexError).


##### `AnalyticsEventsClient::track_plugin_installed`  (lines 337–344)

```
fn track_plugin_installed(&self, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records a plugin state-change fact marking a plugin as installed.

**Data flow**: Accepts `PluginTelemetryMetadata`, wraps it with `PluginState::Installed` inside `PluginStateChangedInput`, then inside `CustomAnalyticsFact::PluginStateChanged`, and enqueues it.

**Call relations**: Called by plugin installation flows.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (remote_plugin_install_response); 2 external calls (Custom, PluginStateChanged).


##### `AnalyticsEventsClient::track_plugin_uninstalled`  (lines 346–353)

```
fn track_plugin_uninstalled(&self, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records a plugin state-change fact marking a plugin as uninstalled.

**Data flow**: Accepts plugin metadata, wraps it with `PluginState::Uninstalled`, and enqueues the resulting custom fact.

**Call relations**: Used by plugin removal flows.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (Custom, PluginStateChanged).


##### `AnalyticsEventsClient::track_plugin_enabled`  (lines 355–362)

```
fn track_plugin_enabled(&self, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records a plugin state-change fact marking a plugin as enabled.

**Data flow**: Accepts plugin metadata, wraps it with `PluginState::Enabled`, and enqueues the resulting custom fact.

**Call relations**: Called by plugin toggle logic when enabling a plugin.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (emit_plugin_toggle_events); 2 external calls (Custom, PluginStateChanged).


##### `AnalyticsEventsClient::track_plugin_disabled`  (lines 364–371)

```
fn track_plugin_disabled(&self, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records a plugin state-change fact marking a plugin as disabled.

**Data flow**: Accepts plugin metadata, wraps it with `PluginState::Disabled`, and enqueues the resulting custom fact.

**Call relations**: Called by plugin toggle logic when disabling a plugin.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (emit_plugin_toggle_events); 2 external calls (Custom, PluginStateChanged).


##### `AnalyticsEventsClient::record_fact`  (lines 373–377)

```
fn record_fact(&self, input: AnalyticsFact)
```

**Purpose**: Internal helper that enqueues an analytics fact only when the client is enabled.

**Data flow**: Accepts an `AnalyticsFact`, checks whether `self.queue` is `Some`, and if so forwards the fact to `queue.try_send(input)`; otherwise it does nothing.

**Call relations**: This is the common sink used by nearly every `track_*` method in the client.

*Call graph*: called by 26 (track_app_mentioned, track_app_used, track_compaction, track_effective_permissions_approval_response, track_error_response, track_goal_event, track_guardian_review, track_hook_run, track_initialize, track_notification (+15 more)).


##### `AnalyticsEventsClient::track_response`  (lines 379–400)

```
fn track_response(
        &self,
        connection_id: u64,
        request_id: RequestId,
        response: ClientResponsePayload,
    )
```

**Purpose**: Filters client responses down to analytics-relevant response types and records only thread lifecycle and turn lifecycle responses.

**Data flow**: Accepts connection id, request id, and owned `ClientResponsePayload`; returns early unless the response is `ThreadStart`, `ThreadResume`, `ThreadFork`, `TurnStart`, or `TurnSteer`. For allowed variants it boxes the response inside `AnalyticsFact::ClientResponse` and enqueues it.

**Call relations**: Called by response-tracking code. Its filtering mirrors the reducer’s interest in only a subset of protocol responses.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (new, matches!).


##### `AnalyticsEventsClient::track_error_response`  (lines 402–415)

```
fn track_error_response(
        &self,
        connection_id: u64,
        request_id: RequestId,
        error: JSONRPCErrorError,
        error_type: Option<AnalyticsJsonRpcError>,
    )
```

**Purpose**: Records an error response fact for a client request, including optional analytics-specific error classification.

**Data flow**: Accepts connection id, request id, `JSONRPCErrorError`, and optional `AnalyticsJsonRpcError`, wraps them in `AnalyticsFact::ErrorResponse`, and enqueues the fact.

**Call relations**: Used when client requests fail, especially for turn-steer rejection analytics and pending-request cleanup.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (track_error_response).


##### `AnalyticsEventsClient::track_server_request`  (lines 417–422)

```
fn track_server_request(&self, connection_id: u64, request: ServerRequest)
```

**Purpose**: Records a server request fact for reducer processing.

**Data flow**: Accepts connection id and owned `ServerRequest`, boxes the request inside `AnalyticsFact::ServerRequest`, and enqueues it.

**Call relations**: Used by server-request plumbing so the reducer can track approval requests and similar server-initiated interactions.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (send_request_to_connections); 1 external calls (new).


##### `AnalyticsEventsClient::track_server_response`  (lines 424–429)

```
fn track_server_response(&self, completed_at_ms: u64, response: ServerResponse)
```

**Purpose**: Records a server response fact with its completion timestamp.

**Data flow**: Accepts `completed_at_ms` and owned `ServerResponse`, boxes the response inside `AnalyticsFact::ServerResponse`, and enqueues it.

**Call relations**: Used to complete pending server-request analytics such as user approvals.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (notify_client_response); 1 external calls (new).


##### `AnalyticsEventsClient::track_effective_permissions_approval_response`  (lines 431–442)

```
fn track_effective_permissions_approval_response(
        &self,
        completed_at_ms: u64,
        request_id: RequestId,
        response: RequestPermissionsResponse,
    )
```

**Purpose**: Records the effective permissions response that results from a permissions approval flow.

**Data flow**: Accepts completion timestamp, request id, and `RequestPermissionsResponse`, boxes the response inside `AnalyticsFact::EffectivePermissionsApprovalResponse`, and enqueues it.

**Call relations**: Used by permissions approval handling so the reducer can emit the correct review event.

*Call graph*: calls 1 internal fn (record_fact); 1 external calls (new).


##### `AnalyticsEventsClient::track_server_request_aborted`  (lines 444–449)

```
fn track_server_request_aborted(&self, completed_at_ms: u64, request_id: RequestId)
```

**Purpose**: Records that a pending server request was aborted at a given time.

**Data flow**: Accepts completion timestamp and request id, wraps them in `AnalyticsFact::ServerRequestAborted`, and enqueues the fact.

**Call relations**: Used by request-cancellation paths so the reducer can emit aborted review analytics and clear pending state.

*Call graph*: calls 1 internal fn (record_fact); called by 4 (cancel_all_requests, cancel_request, cancel_requests_for_thread, notify_client_error).


##### `AnalyticsEventsClient::track_notification`  (lines 451–465)

```
fn track_notification(&self, notification: ServerNotification)
```

**Purpose**: Filters server notifications down to analytics-relevant lifecycle notifications and records only those.

**Data flow**: Accepts owned `ServerNotification`, returns early unless it is one of `TurnStarted`, `TurnCompleted`, `TurnDiffUpdated`, `ItemStarted`, `ItemCompleted`, `ItemGuardianApprovalReviewStarted`, or `ItemGuardianApprovalReviewCompleted`. Allowed notifications are boxed inside `AnalyticsFact::Notification` and enqueued.

**Call relations**: Called by notification plumbing. It is the notification-side counterpart to `track_request` and `track_response` filtering.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Notification, matches!).


##### `send_track_events`  (lines 468–487)

```
async fn send_track_events(
    auth_manager: &AuthManager,
    destination: &AnalyticsEventsDestination,
    events: Vec<TrackEventRequest>,
)
```

**Purpose**: Performs the top-level delivery workflow for a reducer-emitted batch of analytics events, including auth gating and isolated-request batching.

**Data flow**: Accepts `&AuthManager`, destination, and `Vec<TrackEventRequest>`. Returns immediately if the vector is empty. Otherwise awaits `auth_manager.auth()`, returns if no auth or if the auth does not use the Codex backend, splits events with `track_event_request_batches`, and awaits `send_track_events_request` for each batch.

**Call relations**: Called by the background task spawned in `AnalyticsEventsQueue::new` after each fact is reduced. It is the main bridge from reducer output to actual delivery.

*Call graph*: calls 3 internal fn (send_track_events_request, track_event_request_batches, auth); called by 1 (new).


##### `track_event_request_batches`  (lines 489–510)

```
fn track_event_request_batches(events: Vec<TrackEventRequest>) -> Vec<Vec<TrackEventRequest>>
```

**Purpose**: Splits a sequence of analytics events into request batches, isolating events that must be sent alone.

**Data flow**: Consumes a vector of `TrackEventRequest`, iterates in order, accumulates non-isolated events into `current_batch`, flushes that batch before any event whose `should_send_in_isolated_request()` is true, emits isolated events as one-element batches, and returns `Vec<Vec<TrackEventRequest>>`.

**Call relations**: Used only by `send_track_events`. It preserves event order while enforcing per-event isolation rules.

*Call graph*: called by 1 (send_track_events); 2 external calls (new, vec!).


##### `send_track_events_request`  (lines 512–553)

```
async fn send_track_events_request(
    auth: &CodexAuth,
    destination: &AnalyticsEventsDestination,
    events: Vec<TrackEventRequest>,
)
```

**Purpose**: Sends one analytics request batch either to the debug capture file or over HTTP with auth headers.

**Data flow**: Accepts `&CodexAuth`, destination, and a vector of events; returns early if empty; wraps events in `TrackEventsRequest`; in debug builds, returns immediately if `capture_track_events_request(destination, &payload)` handled it. Otherwise matches the destination to obtain the HTTP URL, builds a client with `create_client()`, POSTs JSON with a 10-second timeout, auth headers from `auth_provider_from_auth(auth)`, and `Content-Type: application/json`, awaits the response, and logs warnings for non-success statuses or transport errors.

**Call relations**: Called by `send_track_events` for each batch. It is the final delivery step and the only function that performs network I/O.

*Call graph*: calls 2 internal fn (capture_track_events_request, create_client); called by 1 (send_track_events); 2 external calls (auth_provider_from_auth, warn!).


##### `capture_track_events_request`  (lines 556–571)

```
fn capture_track_events_request(
    destination: &AnalyticsEventsDestination,
    payload: &TrackEventsRequest,
) -> bool
```

**Purpose**: Implements debug-only capture-file delivery by appending the serialized analytics request and suppressing network sending.

**Data flow**: Accepts destination and payload, pattern-matches for `AnalyticsEventsDestination::CaptureFile { path }`, returns `false` for non-capture destinations, otherwise calls `crate::analytics_capture::append_payload(path, payload)`, logs any append error, and returns `true` regardless so network delivery remains disabled.

**Call relations**: Called only from `send_track_events_request` in debug builds. It is the switch that diverts delivery away from HTTP when capture mode is active.

*Call graph*: calls 1 internal fn (append_payload); called by 1 (send_track_events_request); 1 external calls (error!).


### `app-server/src/analytics_utils.rs`

`util` · `startup and test setup when analytics client is created`

This file contains a single helper, `analytics_events_client_from_config`, used by app-server startup paths and tests to build `AnalyticsEventsClient` consistently. The function extracts the ChatGPT base URL from `Config`, trims any trailing slash so downstream URL composition is stable, and passes through the `analytics_enabled` feature flag unchanged. It also forwards the shared `Arc<AuthManager>` so analytics requests can authenticate using the same login state as the rest of the server.

Although small, the helper captures an important normalization detail: `chatgpt_base_url.trim_end_matches('/')` prevents accidental double slashes when the analytics client appends its own paths. By keeping this logic in one place, startup code does not need to remember which config fields analytics depends on or how to normalize them.

#### Function details

##### `analytics_events_client_from_config`  (lines 7–16)

```
fn analytics_events_client_from_config(
    auth_manager: Arc<AuthManager>,
    config: &Config,
) -> AnalyticsEventsClient
```

**Purpose**: Constructs an `AnalyticsEventsClient` from shared auth state and app configuration, normalizing the base URL first.

**Data flow**: Takes `Arc<AuthManager>` and `&Config`, trims trailing `/` characters from `config.chatgpt_base_url`, converts the result to `String`, reads `config.analytics_enabled`, and passes all three values into `AnalyticsEventsClient::new`, returning the client.

**Call relations**: Called by multiple startup and test-construction paths so analytics initialization uses the same auth manager and normalized base URL everywhere.

*Call graph*: calls 1 internal fn (new); called by 3 (start_uninitialized, build_test_processor, run_main_with_transport_options).


### Goal event adapters
This file adds goal-specific helpers that translate goal lifecycle changes into analytics payloads through the shared client.

### `ext/goal/src/analytics.rs`

`orchestration` · `whenever goal lifecycle events are emitted`

This file is a thin analytics adapter around `AnalyticsEventsClient`. `GoalAnalytics` stores the client and exposes semantic methods corresponding to lifecycle moments in the goal subsystem: `created`, `usage_accounted`, `status_changed`, and `cleared`. The small `GoalEventAttribution` enum captures whether an event should be attributed to a specific turn ID or to no turn at all, which lets runtime code distinguish active-turn accounting from idle or external mutations.

The real shaping logic lives in the private `track` method. It decides whether cumulative usage fields should be included based on `GoalEventKind`: only `UsageAccounted` events carry `goal.tokens_used` and `goal.time_used_seconds`; creation, status-change, and clear events intentionally omit those totals. It then constructs a `CodexGoalEvent` by copying the thread ID, optional turn ID, goal ID, current status, and whether a token budget exists. This keeps analytics payload construction consistent across all call sites and avoids duplicating event-kind-specific field rules in runtime or tool code.

#### Function details

##### `GoalAnalytics::new`  (lines 16–18)

```
fn new(client: AnalyticsEventsClient) -> Self
```

**Purpose**: Constructs the analytics wrapper around an `AnalyticsEventsClient`. It is the dependency-injection point for goal analytics.

**Data flow**: Takes an `AnalyticsEventsClient`, stores it in `GoalAnalytics { client }`, and returns the wrapper. No external side effects occur.

**Call relations**: Called during extension construction so runtime and tool code can emit goal analytics through a focused interface instead of using the raw client directly.

*Call graph*: called by 1 (new_with_host_capabilities).


##### `GoalAnalytics::created`  (lines 20–26)

```
fn created(
        &self,
        goal: &codex_state::ThreadGoal,
        attribution: GoalEventAttribution<'_>,
    )
```

**Purpose**: Emits a goal-created analytics event for a specific goal and attribution context. It is the semantic entry point for creation tracking.

**Data flow**: Accepts a `codex_state::ThreadGoal` reference and `GoalEventAttribution`, then forwards them unchanged to `track` with `GoalEventKind::Created`. It returns nothing and writes only through the analytics client.

**Call relations**: Invoked by goal creation flows such as tool-driven creation handlers. It delegates payload assembly and client emission to `track`.

*Call graph*: calls 1 internal fn (track); called by 1 (handle_create).


##### `GoalAnalytics::usage_accounted`  (lines 28–34)

```
fn usage_accounted(
        &self,
        goal: &codex_state::ThreadGoal,
        attribution: GoalEventAttribution<'_>,
    )
```

**Purpose**: Emits an analytics event after goal usage has been persisted. This variant includes cumulative token and time totals.

**Data flow**: Takes a goal reference and attribution, then calls `track` with `GoalEventKind::UsageAccounted`. The downstream payload includes `goal.tokens_used` and `goal.time_used_seconds`.

**Call relations**: Called from runtime accounting after successful active-turn or idle usage updates. It relies on `track` to encode the event-kind-specific cumulative fields.

*Call graph*: calls 1 internal fn (track); called by 1 (account_active_goal_progress).


##### `GoalAnalytics::status_changed`  (lines 36–45)

```
fn status_changed(
        &self,
        goal: &codex_state::ThreadGoal,
        previous_status: Option<codex_state::ThreadGoalStatus>,
        attribution: GoalEventAttribution<'_>,
    )
```

**Purpose**: Conditionally emits a status-change analytics event only when the previous status exists and differs from the goal’s current status. It suppresses no-op updates.

**Data flow**: Receives a goal reference, an `Option<ThreadGoalStatus>` previous status, and attribution. It checks `previous_status.is_some_and(|status| status != goal.status)` and only then calls `track` with `GoalEventKind::StatusChanged`.

**Call relations**: Used by runtime accounting and update flows after reading prior state. The guard prevents duplicate analytics when a write leaves status unchanged.

*Call graph*: calls 1 internal fn (track); called by 2 (account_active_goal_progress, handle_update).


##### `GoalAnalytics::cleared`  (lines 47–49)

```
fn cleared(&self, goal: &codex_state::ThreadGoal)
```

**Purpose**: Emits a goal-cleared analytics event without turn attribution. Clearing is always treated as a non-turn-specific event.

**Data flow**: Takes a goal reference and calls `track` with `GoalEventAttribution::NoTurn` and `GoalEventKind::Cleared`. It returns nothing.

**Call relations**: Called when an external clear succeeds. It delegates all payload construction to `track`.

*Call graph*: calls 1 internal fn (track).


##### `GoalAnalytics::track`  (lines 51–76)

```
fn track(
        &self,
        goal: &codex_state::ThreadGoal,
        attribution: GoalEventAttribution<'_>,
        event_kind: GoalEventKind,
    )
```

**Purpose**: Builds and submits the concrete `CodexGoalEvent` payload for a goal analytics event. It centralizes event-kind-specific field population and turn attribution formatting.

**Data flow**: Accepts a goal reference, attribution enum, and `GoalEventKind`. It derives `(cumulative_tokens_accounted, cumulative_time_accounted_seconds)` as `Some(...)` only for `UsageAccounted`, converts thread and optional turn IDs to owned strings, clones `goal.goal_id`, copies status and budget-presence flags, constructs `CodexGoalEvent`, and sends it via `self.client.track_goal_event(...)`.

**Call relations**: This private helper is the sink for all public analytics methods. Those methods choose the semantic event kind; `track` performs the final translation into the analytics transport payload.

*Call graph*: calls 1 internal fn (track_goal_event); called by 4 (cleared, created, status_changed, usage_accounted).
