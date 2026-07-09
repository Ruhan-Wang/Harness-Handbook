# Analytics event modeling, reduction, and emitters  `stage-20.1`

This stage is shared behind-the-scenes support for understanding how Codex is used. It does not do the main user work itself. Instead, it watches important moments, turns them into safe structured records, combines related pieces, and sends them out without slowing the app.

The process starts with facts.rs, which defines “facts”: small records such as an error, a tool run, a setting, or a turn result. events.rs defines the final analytics “vocabulary,” meaning the event shapes that can be sent. lib.rs is the public doorway that other code imports, with a few shared helpers.

accepted_lines.rs measures accepted code changes as line counts, and hashes repository identity so raw remote URLs are not exposed. reducer.rs acts like an assembler: it remembers context across requests, responses, turns, tools, reviews, and threads, then reduces scattered facts into meaningful events. client.rs sends those events in the background. app-server/src/analytics_utils.rs wires the client to the server’s login and configuration. ext/goal/src/analytics.rs adapts goal activity into the same event system.

## Files in this stage

### Analytics domain model
These files define the analytics crate surface along with the internal facts and serialized event schemas that the rest of the subsystem builds on.

### `analytics/src/facts.rs`

`data_model` · `cross-cutting analytics event creation`

This file is like a set of standardized forms for the analytics pipeline. Instead of every part of the program inventing its own way to describe an event, this file defines shared shapes for important facts: how a turn was configured, how many tokens it used, whether it failed, what kind of error happened, whether a user steering request was accepted, which skill or plugin was used, and so on.

Most of the file is data definitions. A “fact” here means a compact record of something that happened. For example, a turn may produce a configuration fact, a token-usage fact, a timing profile fact, and possibly an error fact. These facts carry stable labels, such as `snake_case` names, so analytics output stays predictable even if the internal Rust type names change.

The file also includes a few small conversion helpers. These translate detailed internal errors into simpler analytics categories. That matters because analytics usually needs counts and trends, not full private error details. For example, many different error values are reduced to a `CodexErrKind`, with an optional HTTP status code kept when available.

Without this file, analytics events would be scattered, inconsistent, and harder to compare across clients, turns, and sessions.

#### Function details

##### `build_track_events_context`  (lines 46–56)

```
fn build_track_events_context(
    model_slug: String,
    thread_id: String,
    turn_id: String,
) -> TrackEventsContext
```

**Purpose**: Creates a small tracking bundle that identifies the model, thread, and turn connected to an analytics event. Other code uses this bundle so skill, app, hook, and plugin events can be tied back to the right conversation moment.

**Data flow**: It receives three strings: the model name, the thread ID, and the turn ID. It places those values unchanged into a new `TrackEventsContext` record. The result is returned to the caller; nothing else is changed.

**Call relations**: This is a convenience constructor for code that is about to record analytics. It does not call other project logic. Its output is later embedded in event inputs such as skill invocations, app mentions, hook runs, and plugin usage records.


##### `TurnCodexErrorFact::from_codex_err`  (lines 129–135)

```
fn from_codex_err(thread_id: String, turn_id: String, error: &CodexErr) -> Self
```

**Purpose**: Builds an analytics-friendly error fact for a failed turn. It keeps the thread and turn identifiers, then converts the detailed internal Codex error into the simpler error shape used for reporting.

**Data flow**: It takes a thread ID, a turn ID, and a reference to a `CodexErr`, which is the program’s internal error type. It copies the IDs into a new `TurnCodexErrorFact` and asks `TurnCodexError::from_codex_err` to simplify the error. The returned fact can then be sent through analytics.

**Call relations**: This is called when turn failure information is being recorded, including by `turn_lifecycle_emits_failed_turn_event` and `track_turn_codex_error`. It hands the actual error conversion to `TurnCodexError::from_codex_err`, keeping this function focused on wrapping the converted error with turn and thread context.

*Call graph*: calls 1 internal fn (from_codex_err); called by 2 (turn_lifecycle_emits_failed_turn_event, track_turn_codex_error).


##### `TurnCodexError::from_codex_err`  (lines 186–191)

```
fn from_codex_err(error: &CodexErr) -> Self
```

**Purpose**: Converts a detailed Codex error into the compact error information analytics needs: a broad error kind and, when relevant, an HTTP status code. This avoids sending overly detailed internal error data while still preserving useful troubleshooting signals.

**Data flow**: It receives a `CodexErr`. First it converts that error into a `CodexErrKind`, a simpler category such as timeout, quota exceeded, or invalid request. Then it reads any HTTP status code attached to the error. It returns a `TurnCodexError` containing those two pieces of information.

**Call relations**: This function is used by `TurnCodexErrorFact::from_codex_err` whenever a failed turn is turned into an analytics fact. It relies on the `CodexErrKind::from` conversion for the category and on the error’s `http_status_code_value` method for the optional status code.

*Call graph*: calls 1 internal fn (http_status_code_value); called by 1 (from_codex_err); 1 external calls (into).


##### `CodexErrKind::from`  (lines 195–238)

```
fn from(error: &CodexErr) -> Self
```

**Purpose**: Maps each detailed `CodexErr` variant to a stable analytics category. This gives dashboards and reports a consistent vocabulary for error types, even though the original error may carry extra details.

**Data flow**: It receives a reference to a `CodexErr`. It checks which kind of error it is and returns the matching `CodexErrKind`, ignoring extra fields like messages, paths, or nested error details. On Linux builds, it also includes Linux-specific sandbox error categories.

**Call relations**: This conversion is used when `TurnCodexError::from_codex_err` simplifies a turn error for analytics. It sits at the boundary between detailed runtime failure information and the cleaner labels that analytics consumers can group and count.


##### `TurnSteerRejectionReason::from`  (lines 309–314)

```
fn from(error: InputError) -> Self
```

**Purpose**: Converts a failed turn-steering request into the analytics reason that explains why it was rejected. A turn-steering request is an attempt to guide or modify an active turn while it is running.

**Data flow**: It receives a `TurnSteerRequestError`, such as there being no active turn or the expected turn not matching. It returns the corresponding `TurnSteerRejectionReason` with the same plain meaning. No outside state is read or changed.

**Call relations**: This conversion is used when code records a steering attempt that was rejected. It translates the request-layer error into the analytics-layer reason so the final `CodexTurnSteerEvent` can report both the rejection result and why it happened.


### `analytics/src/events.rs`

`data_model` · `cross-cutting analytics event creation`

This file is mostly a catalog of analytics messages. When Codex wants to report something that happened, such as a thread starting, a plugin being used, a command running, or a guardian review approving or denying an action, the data must be packaged in a predictable format. These structs and enums are that format. They are marked for serialization, meaning they can be converted into data such as JSON for an analytics service.

The file also includes a few translator functions. Internal code often records events in project-specific types, like hook names, plugin metadata, or compaction facts. The helpers here copy the useful fields, add common context such as thread ID, turn ID, product client ID, runtime operating system, and Codex version, and produce the final analytics event parameters.

A useful analogy is a set of pre-printed forms. Each kind of event has its own form with required boxes. Other parts of the system fill in the facts, and this file makes sure the boxes have the right names and values before the form is sent.

One important behavior is that accepted line fingerprint events are marked to be sent alone, not batched with other events. Guardian review tracking also records both wall-clock timestamps and elapsed time, so analytics can later answer how long reviews took and what result they reached.

#### Function details

##### `TrackEventRequest::should_send_in_isolated_request`  (lines 89–91)

```
fn should_send_in_isolated_request(&self) -> bool
```

**Purpose**: This function tells the sender whether a particular analytics event should be sent by itself instead of grouped with other events. Currently, accepted line fingerprint events get this special treatment.

**Data flow**: It receives one event request, checks which event variant it is, and returns true only when it is an accepted line fingerprints event. It does not change the event.

**Call relations**: When analytics code is preparing events to send, this method acts like a sorting rule. It uses Rust’s pattern matching to recognize the one event type that needs an isolated request.

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

**Purpose**: This creates a small tracking record at the moment a guardian review starts. The guardian review is the safety or approval check that decides whether an action can proceed.

**Data flow**: It takes identifiers for the thread, turn, review, optional target item, the source of the approval request, the action being reviewed, and the timeout. It stores those values and adds two start-time measurements: a Unix timestamp in milliseconds and an in-process timer for measuring elapsed time later.

**Call relations**: The guardian review runner calls this when a review begins. Later, the completed review uses this saved context to build a full analytics event with both the original review details and the final result.

*Call graph*: called by 1 (run_guardian_review); 2 external calls (now, now_unix_millis).


##### `GuardianReviewTrackContext::event_params`  (lines 331–380)

```
fn event_params(
        &self,
        result: GuardianReviewAnalyticsResult,
        completed_at_ms: u64,
    ) -> GuardianReviewEventParams
```

**Purpose**: This turns the saved guardian review context plus the final review result into the full set of analytics fields for a guardian review event.

**Data flow**: It reads the review IDs, action, request source, timeout, and start time stored in the context. It combines them with the result, such as decision, status, failure reason, risk level, model details, token usage, and first-token timing. It outputs a GuardianReviewEventParams value ready to be serialized and sent.

**Call relations**: After a guardian review finishes, the tracking layer calls this to create the event payload. It also measures elapsed time from the stored timer so the analytics event includes completion latency.

*Call graph*: called by 1 (track_guardian_review); 2 external calls (elapsed, clone).


##### `GuardianReviewAnalyticsResult::without_session`  (lines 408–431)

```
fn without_session() -> Self
```

**Purpose**: This creates a default guardian review result for cases where no guardian review session was successfully available. It represents a safe failure: deny the action and mark the review as failed closed.

**Data flow**: It takes no input. It returns a GuardianReviewAnalyticsResult filled with conservative defaults: denied decision, failed-closed status, one attempt, no model/session details, no token usage, and no timing details.

**Call relations**: Many guardian review paths use this as the baseline result, especially error, timeout, cancellation, or test scenarios. Other code can then overwrite specific fields if more information becomes available.

*Call graph*: called by 11 (guardian_review_metrics_record_counts_durations_and_token_usage, run_guardian_review, run_guardian_review_session_before_deadline, run_ephemeral_review, run_review, wait_for_guardian_review_cancel_drains_expected_turn_after_stale_terminal_event, wait_for_guardian_review_ignores_prior_turn_aborts, wait_for_guardian_review_ignores_prior_turn_completion, wait_for_guardian_review_ignores_prior_turn_errors, wait_for_guardian_review_preserves_structured_session_error (+1 more)).


##### `GuardianReviewAnalyticsResult::from_session`  (lines 433–449)

```
fn from_session(params: GuardianReviewSessionAnalyticsParams) -> Self
```

**Purpose**: This creates a guardian review analytics result when a real guardian session exists. It starts from the safe default result, then fills in the session-specific details.

**Data flow**: It receives session analytics details such as guardian thread ID, model, model provider, review model settings, and whether prior context existed. It returns a GuardianReviewAnalyticsResult that includes those details while keeping the default denied and failed-closed values until later code updates the actual outcome.

**Call relations**: The review-on-session path calls this after a guardian session is chosen or created. Internally it reuses GuardianReviewAnalyticsResult::without_session so all default fields stay consistent.

*Call graph*: called by 1 (run_review_on_session); 1 external calls (without_session).


##### `plugin_state_event_type`  (lines 963–970)

```
fn plugin_state_event_type(state: PluginState) -> &'static str
```

**Purpose**: This chooses the analytics event name for a plugin state change. For example, it maps an installed plugin to the string used for a plugin-installed event.

**Data flow**: It receives a PluginState value, checks whether the plugin was installed, uninstalled, enabled, or disabled, and returns the matching static event type string.

**Call relations**: When plugin state changes are ingested, that code calls this function to pick the correct event name before packaging the plugin metadata.

*Call graph*: called by 1 (ingest_plugin_state_changed).


##### `codex_app_metadata`  (lines 972–985)

```
fn codex_app_metadata(
    tracking: &TrackEventsContext,
    app: AppInvocation,
) -> CodexAppMetadata
```

**Purpose**: This builds the common analytics metadata for an app that was mentioned or used during a Codex turn.

**Data flow**: It receives the current tracking context and an app invocation record. It copies the connector ID, app name, invocation type, thread ID, turn ID, and model slug, and adds the product client ID from the login originator. It returns a CodexAppMetadata value.

**Call relations**: The app-used ingestion path and serialization tests call this to produce the event parameters for app mention and app use events.

*Call graph*: calls 1 internal fn (originator); called by 3 (app_mentioned_event_serializes_expected_shape, app_used_event_serializes_expected_shape, ingest_app_used).


##### `codex_plugin_metadata`  (lines 987–1013)

```
fn codex_plugin_metadata(plugin: PluginTelemetryMetadata) -> CodexPluginMetadata
```

**Purpose**: This builds the basic analytics metadata for a plugin, including its identity and the capabilities it exposes.

**Data flow**: It receives PluginTelemetryMetadata. It chooses a plugin ID, preferring a remote plugin ID when present and otherwise using the local plugin key. It copies the plugin name, marketplace name, skill availability, MCP server count, connector IDs, and product client ID into a CodexPluginMetadata result.

**Call relations**: Plugin install, uninstall, enable, disable, and plugin-used events rely on this helper so plugin identity is reported the same way everywhere. The plugin-used helper calls it as its first step.

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

**Purpose**: This converts an internal compaction fact into analytics event parameters. Compaction is the process of reducing or summarizing conversation context so the system can keep working within token limits.

**Data flow**: It receives a CodexCompactionEvent plus shared context such as session ID, app server client metadata, runtime metadata, thread source, subagent source, and parent thread ID. It copies trigger, reason, implementation, phase, strategy, status, error details, token counts, image counts, timestamps, and duration into a CodexCompactionEventParams result.

**Call relations**: The compaction ingestion path calls this when it needs to report a compaction event. Tests also use it to verify the serialized event shape.

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

**Purpose**: This converts an internal goal event into analytics event parameters. Goals describe tracked pieces of work for a thread, including progress and budget accounting.

**Data flow**: It receives a CodexGoalEvent plus session, client, runtime, and thread-lineage context. It copies the goal ID, event kind, goal status, token budget flag, and cumulative token or time accounting into a CodexGoalEventParams value.

**Call relations**: The goal ingestion path calls this before sending a goal analytics event. It provides the bridge between internal goal tracking and the analytics event schema.

*Call graph*: called by 1 (ingest_goal).


##### `codex_plugin_used_metadata`  (lines 1079–1094)

```
fn codex_plugin_used_metadata(
    tracking: &TrackEventsContext,
    plugin: PluginTelemetryMetadata,
) -> CodexPluginUsedMetadata
```

**Purpose**: This builds the analytics metadata for a plugin-use event, which needs both plugin identity and the thread or turn where it was used.

**Data flow**: It receives the current tracking context and plugin telemetry metadata. It extracts MCP server names if available, builds the embedded plugin metadata with codex_plugin_metadata, and adds thread ID, turn ID, and model slug from the tracking context. It returns CodexPluginUsedMetadata.

**Call relations**: The plugin-used ingestion path calls this when a plugin is used during a turn. It delegates the shared plugin identity work to codex_plugin_metadata so plugin-use events match plugin-management events.

*Call graph*: calls 1 internal fn (codex_plugin_metadata); called by 2 (plugin_used_event_serializes_expected_shape, ingest_plugin_used).


##### `codex_hook_run_metadata`  (lines 1096–1108)

```
fn codex_hook_run_metadata(
    tracking: &TrackEventsContext,
    hook: HookRunFact,
) -> CodexHookRunMetadata
```

**Purpose**: This builds analytics metadata for a hook run. A hook is a user, project, system, or plugin-provided action that runs at certain points, such as before tool use or after compaction.

**Data flow**: It receives the current tracking context and a hook run fact. It adds thread ID, turn ID, model slug, a readable hook event name, a readable hook source, and a normalized hook status. It returns CodexHookRunMetadata.

**Call relations**: The hook-run ingestion path calls this before sending hook analytics. It relies on three small mapper functions to translate hook event names, sources, and statuses into analytics-friendly values.

*Call graph*: calls 3 internal fn (analytics_hook_event_name, analytics_hook_source, analytics_hook_status); called by 4 (hook_run_event_serializes_expected_shape, hook_run_metadata_maps_sources_and_statuses, hook_run_metadata_maps_stopped_status, ingest_hook_run).


##### `analytics_hook_event_name`  (lines 1110–1123)

```
fn analytics_hook_event_name(event_name: HookEventName) -> &'static str
```

**Purpose**: This translates a hook event enum into the exact text label expected in analytics.

**Data flow**: It receives a HookEventName, checks which lifecycle point it represents, and returns a static string such as PreToolUse, PermissionRequest, or SessionStart.

**Call relations**: codex_hook_run_metadata calls this while building a hook run event. Keeping the mapping here prevents each caller from inventing its own spelling.

*Call graph*: called by 1 (codex_hook_run_metadata).


##### `analytics_hook_source`  (lines 1125–1139)

```
fn analytics_hook_source(source: HookSource) -> &'static str
```

**Purpose**: This translates where a hook came from into the string used in analytics. Sources include system, user, project, plugin, managed configuration, and unknown.

**Data flow**: It receives a HookSource enum value and returns the matching lowercase analytics string, such as user, project, session_flags, or cloud_managed_config.

**Call relations**: codex_hook_run_metadata calls this so hook-source reporting is consistent across all hook run events.

*Call graph*: called by 1 (codex_hook_run_metadata).


##### `current_runtime_metadata`  (lines 1141–1149)

```
fn current_runtime_metadata() -> CodexRuntimeMetadata
```

**Purpose**: This captures basic information about the Codex runtime environment for analytics events. It records what version of Codex is running and what operating system and CPU architecture it is running on.

**Data flow**: It reads the package version built into the program, the operating system and architecture constants from Rust, and the operating system version from the os_info library. It returns a CodexRuntimeMetadata struct.

**Call relations**: Thread initialization tracking and subagent thread-start event creation call this so those events include the environment where they happened.

*Call graph*: called by 2 (track_initialize, subagent_thread_started_event_request); 2 external calls (env!, get).


##### `subagent_thread_started_event_request`  (lines 1151–1178)

```
fn subagent_thread_started_event_request(
    input: SubAgentThreadStartedInput,
) -> ThreadInitializedEvent
```

**Purpose**: This creates a thread-initialized analytics event for a subagent thread. A subagent is a delegated worker thread created by Codex to help with a task.

**Data flow**: It receives a SubAgentThreadStartedInput containing IDs, client information, model, lineage, source, and creation time. It builds app server client metadata, adds current runtime metadata, marks the thread source as subagent, records the subagent source name, and returns a ThreadInitializedEvent with event type codex_thread_initialized.

**Call relations**: The subagent-thread-started ingestion path calls this when a new subagent thread begins. It calls current_runtime_metadata for environment details and subagent_source_name to turn the subagent source into a stable text value.

*Call graph*: calls 2 internal fn (current_runtime_metadata, subagent_source_name); called by 6 (subagent_thread_started_memory_consolidation_serializes_expected_shape, subagent_thread_started_other_serializes_expected_shape, subagent_thread_started_other_serializes_explicit_parent_thread_id, subagent_thread_started_review_serializes_expected_shape, subagent_thread_started_thread_spawn_serializes_thread_lineage, ingest_subagent_thread_started).


##### `subagent_source_name`  (lines 1180–1182)

```
fn subagent_source_name(subagent_source: &SubAgentSource) -> String
```

**Purpose**: This returns the name of the kind of subagent source, such as the category of reason the subagent was created.

**Data flow**: It receives a SubAgentSource reference, asks it for its kind, converts that kind to text, and returns the resulting String.

**Call relations**: subagent_thread_started_event_request uses this when creating subagent thread initialization analytics. Other thread metadata conversion code also calls it to keep the same naming.

*Call graph*: calls 1 internal fn (kind); called by 2 (subagent_thread_started_event_request, from_thread_metadata).


##### `analytics_hook_status`  (lines 1184–1190)

```
fn analytics_hook_status(status: HookRunStatus) -> HookRunStatus
```

**Purpose**: This normalizes hook run status before analytics reporting. It defensively converts an unexpected Running status into Failed.

**Data flow**: It receives a HookRunStatus. If the status is Running, it returns Failed; otherwise it returns the original status unchanged.

**Call relations**: codex_hook_run_metadata calls this while building hook run metadata. This protects analytics from receiving a still-running status in a place where completed hook results are expected.

*Call graph*: called by 1 (codex_hook_run_metadata).


### `analytics/src/lib.rs`

`other` · `cross-cutting`

This file is the crate root, which means it decides what the outside world can import from the analytics package. Most of its job is to gather useful pieces from smaller internal files, such as event definitions, facts, the analytics client, and accepted-line fingerprinting, and re-export them from one place. That keeps callers from needing to know the crate’s internal folder layout.

Think of it like a reception desk: the real work happens in different rooms, but callers can ask at one central desk instead of wandering the building. Without this file, other parts of the system would have to import analytics pieces from many separate modules, and public names would be harder to keep stable.

The file also defines a handful of small helper functions. Two return the current Unix time, which is the number of seconds or milliseconds since January 1, 1970, commonly used for timestamps. The others safely convert values into forms suitable for analytics data, such as turning an enum into its string form or converting signed and platform-sized numbers into unsigned 64-bit numbers. These helpers are deliberately forgiving: if time or numeric conversion fails, they use safe fallback behavior instead of crashing.

#### Function details

##### `now_unix_seconds`  (lines 61–66)

```
fn now_unix_seconds() -> u64
```

**Purpose**: Returns the current time as Unix seconds, meaning seconds since January 1, 1970. Analytics events can use this as a simple timestamp.

**Data flow**: It reads the system clock, compares it with the Unix starting point, and takes the number of whole seconds. If the clock comparison fails for some unusual reason, it falls back to zero seconds rather than stopping the program.

**Call relations**: When analytics code needs a timestamp in seconds, it can call this helper instead of repeating the clock logic. Inside, it relies on the standard system time function to get the current moment.

*Call graph*: 1 external calls (now).


##### `now_unix_millis`  (lines 68–76)

```
fn now_unix_millis() -> u64
```

**Purpose**: Returns the current time as Unix milliseconds, which is useful when analytics needs a more precise timestamp than whole seconds.

**Data flow**: It reads the system clock, measures how many milliseconds have passed since the Unix starting point, and converts that value into a 64-bit unsigned number. If the clock comparison fails, it uses zero; if the millisecond value is too large to fit, it uses the largest possible 64-bit unsigned number.

**Call relations**: Analytics code can call this when it needs millisecond precision. The function asks the standard clock for the current time and uses a standard numeric conversion so the result has the expected type.

*Call graph*: 2 external calls (now, try_from).


##### `serialize_enum_as_string`  (lines 78–82)

```
fn serialize_enum_as_string(value: &T) -> Option<String>
```

**Purpose**: Tries to turn a serializable value, usually an enum, into the string that would appear in JSON. This helps analytics store clean text labels rather than Rust-specific values.

**Data flow**: It takes a value that can be serialized, converts it into a JSON value, and then checks whether that JSON value is a string. If it is a string, it returns that text; if serialization fails or the JSON value is not a string, it returns nothing.

**Call relations**: Internal analytics code can use this helper when preparing event fields. It hands the actual conversion to the JSON serialization library, then keeps only the simple string result that analytics records expect.

*Call graph*: 1 external calls (to_value).


##### `usize_to_u64`  (lines 84–86)

```
fn usize_to_u64(value: usize) -> u64
```

**Purpose**: Safely converts a `usize` into a `u64`. A `usize` is a number sized for the current machine, while a `u64` is a fixed-size unsigned number often better for stored analytics data.

**Data flow**: It receives a machine-sized unsigned number and tries to convert it into a 64-bit unsigned number. If the value does not fit, it returns the largest possible 64-bit unsigned number instead of failing.

**Call relations**: Internal analytics code can use this when counts or sizes need to be written into analytics facts with a stable numeric type. It relies on the standard checked conversion function to avoid unsafe assumptions about number size.

*Call graph*: 1 external calls (try_from).


##### `option_i64_to_u64`  (lines 88–90)

```
fn option_i64_to_u64(value: Option<i64>) -> Option<u64>
```

**Purpose**: Converts an optional signed 64-bit number into an optional unsigned 64-bit number, but only when the value is present and non-negative. This is useful for analytics fields where negative numbers would not make sense.

**Data flow**: It receives either no value or a signed number. If there is no value, it returns no value. If there is a value, it tries to convert it to an unsigned number; negative or otherwise invalid values become no value.

**Call relations**: Internal analytics code can use this when cleaning up optional numeric inputs before recording them. Unlike the other conversion helper, it does not clamp invalid values; it drops them by returning nothing.


### Event reduction pipeline
These files implement the core transformation from raw observations and accepted-line parsing into finalized analytics event records.

### `analytics/src/accepted_lines.rs`

`domain_logic` · `turn completion / analytics reporting`

When a user accepts generated code, the system wants to know basic facts such as “how many lines were accepted?” and, internally, which added lines were meaningful enough to fingerprint. A fingerprint is a one-way hash: like a label made from the content, but not the content itself. This file reads a unified diff, which is the common text format Git uses to show added and removed lines, and counts accepted additions and deletions.

The main parser walks through the diff line by line. It notices file headers, remembers the current file path, enters each changed section, counts lines that start with plus signs as additions, and counts lines that start with minus signs as deletions. For added lines, it filters out very short or symbol-only lines before hashing the file path and normalized line text. This avoids treating things like a lone brace as meaningful code.

The file also builds the analytics event request sent later by the analytics pipeline. Importantly, although it still computes line fingerprints for tests and possible future use, the event payload deliberately sends an empty fingerprint list. That means the uploaded event contains counts and repository hash information, but not per-line hashes. Finally, it can inspect the current Git repository, find a remote URL, canonicalize it, and hash it so the raw repository address is not sent.

#### Function details

##### `accepted_line_fingerprints_from_unified_diff`  (lines 30–83)

```
fn accepted_line_fingerprints_from_unified_diff(
    unified_diff: &str,
) -> AcceptedLineFingerprintSummary
```

**Purpose**: Reads a Git-style unified diff and summarizes the accepted code change. It counts added and deleted lines, and creates hashes for meaningful added lines so they can be recognized without storing the raw text.

**Data flow**: It takes the diff as plain text. As it scans each line, it tracks the current file path, whether it is inside an actual changed section, and whether each line is an addition or deletion. Added lines are cleaned up and filtered; useful ones are turned into path and line hashes. It returns an AcceptedLineFingerprintSummary containing the total added lines, total deleted lines, and the collected fingerprints.

**Call relations**: This is the central parser in the file. It calls normalize_diff_path to clean file names, normalize_effective_line to decide whether an added line is worth fingerprinting, and fingerprint_hash to produce the privacy-preserving labels. It is used by accepted_line_event_input in the wider analytics flow and by the tests that check tricky diff cases.

*Call graph*: calls 3 internal fn (fingerprint_hash, normalize_diff_path, normalize_effective_line); called by 4 (parses_counts_and_effective_added_fingerprints, parses_hunk_lines_that_look_like_file_headers, skips_added_file_metadata_headers, accepted_line_event_input); 1 external calls (new).


##### `fingerprint_hash`  (lines 85–92)

```
fn fingerprint_hash(domain: &str, value: &str) -> String
```

**Purpose**: Creates a stable one-way hash for a value, such as a file path, line of code, or repository URL. The domain label keeps different kinds of data from accidentally sharing the same hash space.

**Data flow**: It receives a domain name and a value. It feeds a fixed version marker, the domain, and the value into SHA-1, a hashing algorithm that turns text into a fixed-looking string. It returns the hash as lowercase hexadecimal text.

**Call relations**: The diff parser uses this to hash paths and added lines. The repository hash function also uses the same idea for repository remotes. This helper is the privacy boundary: callers get a repeatable identifier without keeping the original text.

*Call graph*: called by 1 (accepted_line_fingerprints_from_unified_diff); 2 external calls (format!, new).


##### `accepted_line_fingerprint_event_requests`  (lines 94–129)

```
fn accepted_line_fingerprint_event_requests(
    input: AcceptedLineFingerprintEventInput,
) -> Vec<TrackEventRequest>
```

**Purpose**: Builds the analytics event object that reports accepted-line statistics. It packages counts, turn information, model information, timing, and repository hash into the format expected by the event tracking system.

**Data flow**: It takes an AcceptedLineFingerprintEventInput containing metadata and line-count results. It copies those fields into a CodexAcceptedLineFingerprintsEventRequest wrapped inside a TrackEventRequest. Although the input may contain line fingerprints, the output intentionally replaces them with an empty list before upload.

**Call relations**: maybe_emit_turn_event calls this when it is ready to send analytics for a completed turn. This function does not parse diffs itself; it receives already prepared data and turns it into the transport shape used by the analytics event pipeline.

*Call graph*: called by 1 (maybe_emit_turn_event); 1 external calls (vec!).


##### `accepted_line_repo_hash_for_cwd`  (lines 131–141)

```
async fn accepted_line_repo_hash_for_cwd(cwd: &Path) -> Option<String>
```

**Purpose**: Finds a repository remote for the current working directory and returns a hashed version of it. This lets analytics associate events with the same repository without sending the repository URL itself.

**Data flow**: It receives a filesystem path that is assumed to be inside a Git repository. It asks Git utilities for the repository’s remote URLs, prefers the remote named origin, otherwise uses the first available remote, canonicalizes the URL when possible, and hashes the result. It returns the hash, or nothing if no remote information is available.

**Call relations**: maybe_emit_turn_event calls this while preparing the accepted-line analytics event. It relies on external Git utility functions to read and normalize remotes, then uses this file’s hash helper to produce the final privacy-preserving repository identifier.

*Call graph*: called by 1 (maybe_emit_turn_event); 1 external calls (get_git_remote_urls_assume_git_repo).


##### `normalize_diff_path`  (lines 143–155)

```
fn normalize_diff_path(path: &str) -> Option<String>
```

**Purpose**: Turns a file path from a diff header into the real project path used for hashing. It also recognizes /dev/null, which Git uses to mean a file did not exist on one side of the change.

**Data flow**: It receives a path string from a diff line such as +++ b/src/lib.rs. It trims whitespace, returns nothing for /dev/null, and removes common Git prefixes like a/ or b/. It returns the cleaned path when there is one.

**Call relations**: accepted_line_fingerprints_from_unified_diff calls this before hashing added lines. This keeps path fingerprints stable, so the same file is not treated differently just because the diff used Git’s a/ and b/ prefixes.

*Call graph*: called by 1 (accepted_line_fingerprints_from_unified_diff).


##### `normalize_effective_line`  (lines 157–169)

```
fn normalize_effective_line(line: &str) -> Option<String>
```

**Purpose**: Decides whether an added line is meaningful enough to fingerprint and normalizes its spacing. This avoids recording fingerprints for tiny or non-informative lines such as a lone brace.

**Data flow**: It receives the text of an added line without the leading plus sign. It collapses all whitespace into single spaces, rejects lines that are three characters or shorter, and rejects lines with no letters, numbers, or underscores. It returns the cleaned line text only if it passes those checks.

**Call relations**: accepted_line_fingerprints_from_unified_diff calls this for every added line inside a diff hunk. Only lines accepted by this filter are handed to fingerprint_hash, so this function controls which additions become line fingerprints.

*Call graph*: called by 1 (accepted_line_fingerprints_from_unified_diff).


##### `tests::parses_counts_and_effective_added_fingerprints`  (lines 176–209)

```
fn parses_counts_and_effective_added_fingerprints()
```

**Purpose**: Checks the normal case: a diff with one deleted line and several added lines, where only meaningful added lines should be fingerprinted.

**Data flow**: It builds a sample diff string, sends it to accepted_line_fingerprints_from_unified_diff, and compares the returned summary with the expected counts and hashes. The expected result includes three added lines and one deleted line, but only two line fingerprints because a short brace-only line is ignored.

**Call relations**: This test protects the main parser’s intended behavior. It calls accepted_line_fingerprints_from_unified_diff and uses fingerprint_hash in the expected value so the test matches the same hashing scheme as production code.

*Call graph*: calls 1 internal fn (accepted_line_fingerprints_from_unified_diff); 1 external calls (assert_eq!).


##### `tests::skips_added_file_metadata_headers`  (lines 212–228)

```
fn skips_added_file_metadata_headers()
```

**Purpose**: Checks that the parser does not confuse diff metadata for real added code when a new file is created.

**Data flow**: It builds a diff for a newly added file, including the /dev/null marker and file header lines. It passes that diff to the parser and verifies that only the actual code line is counted as added, with no deleted lines and one fingerprint.

**Call relations**: This test exercises accepted_line_fingerprints_from_unified_diff on a common Git edge case. It confirms that normalize_diff_path and the parser’s hunk tracking work together so file headers are not counted as accepted code.

*Call graph*: calls 1 internal fn (accepted_line_fingerprints_from_unified_diff); 1 external calls (assert_eq!).


##### `tests::parses_hunk_lines_that_look_like_file_headers`  (lines 231–255)

```
fn parses_hunk_lines_that_look_like_file_headers()
```

**Purpose**: Checks a subtle case where real changed lines look like diff header lines. This matters because code or text can begin with --- or +++, and the parser must still count it correctly inside a changed section.

**Data flow**: It creates a diff where the actual removed line starts with --- and the actual added line starts with +++. It runs the parser and verifies one deletion, one addition, and a fingerprint for the added content after the leading diff plus sign is removed.

**Call relations**: This test calls accepted_line_fingerprints_from_unified_diff to make sure its hunk-state logic is correct. It guards against a bug where the parser might treat changed content as file metadata just because it resembles a diff header.

*Call graph*: calls 1 internal fn (accepted_line_fingerprints_from_unified_diff); 1 external calls (assert_eq!).


### `analytics/src/reducer.rs`

`domain_logic` · `cross-cutting during request handling and turn completion`

The analytics reducer is like a clerk who watches a busy service desk and writes clean summary cards after each task is done. Incoming facts often arrive in pieces: a turn starts in one message, gets configuration in another, uses tools in notifications, receives token counts later, and finally completes. This file stores those pieces in small in-memory maps until it has enough information to emit one analytics event.

It also enriches events with context. A thread event needs client and runtime details. A tool event needs its start and finish times, whether a review approved it, and what kind of tool it was. A review event needs to know what was reviewed and how the user or guardian system answered. If required context is missing, the reducer drops that analytics event and logs a warning rather than sending misleading data.

The file covers several families of analytics: thread initialization, turn completion, turn steering, tool calls, command execution, file changes, web search, image generation, reviews, skills, apps, hooks, plugins, goals, compaction, and accepted-line fingerprints from diffs. Without this file, analytics would lose the story of how a user session unfolded, making product metrics, debugging, safety auditing, and feature usage reporting much less reliable.

#### Function details

##### `AnalyticsDropSite::guardian`  (lines 168–176)

```
fn guardian(input: &'a GuardianReviewEventParams) -> Self
```

**Purpose**: Builds a small label describing where a guardian review analytics event came from. This label is used only for useful warning messages if required context is missing.

**Data flow**: It reads the guardian review's thread, turn, and review identifiers → packages them with the event name "guardian" → returns an AnalyticsDropSite value.

**Call relations**: When ingest_guardian_review is ready to emit a guardian event, it asks this helper for a drop-site label before checking thread context.

*Call graph*: called by 1 (ingest_guardian_review).


##### `AnalyticsDropSite::review`  (lines 178–186)

```
fn review(input: &'a PendingReviewState) -> Self
```

**Purpose**: Creates a warning label for a pending review event. It captures the thread, turn, review, and optional tool item being reviewed.

**Data flow**: It reads a PendingReviewState → copies references to its identifying fields → returns an AnalyticsDropSite marked as a "review" event.

**Call relations**: emit_review_event uses this before looking up connection and thread metadata, so any dropped review event can be explained clearly in logs.

*Call graph*: called by 1 (emit_review_event).


##### `AnalyticsDropSite::compaction`  (lines 188–196)

```
fn compaction(input: &'a CodexCompactionEvent) -> Self
```

**Purpose**: Creates a warning label for a compaction analytics event. Compaction means the conversation context was condensed to save space.

**Data flow**: It reads a compaction fact's thread and turn IDs → wraps them with the event name "compaction" → returns the label.

**Call relations**: ingest_compaction uses it while fetching the thread context needed to build the final compaction event.

*Call graph*: called by 1 (ingest_compaction).


##### `AnalyticsDropSite::goal`  (lines 198–206)

```
fn goal(input: &'a CodexGoalEvent) -> Self
```

**Purpose**: Creates a warning label for a goal analytics event. A goal event records work related to a user or agent goal.

**Data flow**: It reads the goal fact's thread ID and optional turn ID → packages them with the event name "goal" → returns the label.

**Call relations**: ingest_goal uses this label when it checks whether the thread has the connection and metadata needed for analytics.

*Call graph*: called by 1 (ingest_goal).


##### `AnalyticsDropSite::tool_item`  (lines 208–219)

```
fn tool_item(
        notification: &'a codex_app_server_protocol::ItemCompletedNotification,
        item_id: &'a str,
    ) -> Self
```

**Purpose**: Creates a warning label for an individual tool item event, such as a command, file change, or web search.

**Data flow**: It reads the item completion notification and the tool item ID → takes the thread and turn IDs from the notification → returns an AnalyticsDropSite for a "tool item".

**Call relations**: ingest_notification uses it after a tool completes and before building the detailed tool analytics event.

*Call graph*: called by 1 (ingest_notification).


##### `AnalyticsDropSite::turn_steer`  (lines 221–229)

```
fn turn_steer(thread_id: &'a str) -> Self
```

**Purpose**: Creates a warning label for a turn-steer event. Turn steering means sending extra input that changes or guides an existing turn.

**Data flow**: It receives a thread ID → records no turn, review, or item ID because the event may not have a final accepted turn → returns the label.

**Call relations**: emit_turn_steer_event uses it when checking whether thread metadata exists.

*Call graph*: called by 1 (emit_turn_steer_event).


##### `AnalyticsDropSite::turn`  (lines 231–239)

```
fn turn(thread_id: &'a str, turn_id: &'a str) -> Self
```

**Purpose**: Creates a warning label for a completed turn analytics event.

**Data flow**: It receives a thread ID and turn ID → stores them with the event name "turn" → returns the label.

**Call relations**: maybe_emit_turn_event uses it when deciding whether it has enough context to safely emit the turn event.

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

**Purpose**: Turns raw thread information into the smaller metadata bundle analytics needs. It also detects whether the thread was created by a sub-agent.

**Data flow**: It receives session and thread source details, parent thread information, and initialization mode → derives a human-readable sub-agent source when applicable → returns ThreadMetadataState.

**Call relations**: emit_thread_initialized calls this while creating the thread-initialized event and storing metadata for later turn, tool, and review events.

*Call graph*: calls 1 internal fn (subagent_source_name); called by 1 (emit_thread_initialized).


##### `TurnToolCounts::record`  (lines 370–393)

```
fn record(&mut self, item: &ThreadItem)
```

**Purpose**: Adds one completed tool-like thread item to the turn's counters. These counters later summarize how much tool work happened during the turn.

**Data flow**: It receives a ThreadItem → identifies whether it is a command, file change, MCP tool, dynamic tool, sub-agent tool, web search, or image generation → increments the matching count and the total count; non-tool items are ignored.

**Call relations**: ingest_notification updates the current turn with this whenever relevant item completion notifications arrive.


##### `AnalyticsReducer::ingest`  (lines 397–516)

```
async fn ingest(&mut self, input: AnalyticsFact, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: This is the main intake door for analytics facts. It routes each incoming fact to the specific reducer logic that knows how to store it or emit an event.

**Data flow**: It receives one AnalyticsFact and the output event list → matches the fact type → updates reducer state or appends TrackEventRequest values to the output list.

**Call relations**: Tests and the rest of the analytics pipeline call this as facts arrive; it delegates to specialized ingest_* methods for initialization, requests, responses, notifications, reviews, turns, plugins, skills, apps, and other custom facts.

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

**Purpose**: Stores information about a newly connected client. Later events need this client and runtime context to say where the activity came from.

**Data flow**: It receives a connection ID, initialize parameters, product client ID, runtime metadata, and transport type → builds ConnectionState → saves it by connection ID.

**Call relations**: AnalyticsReducer::ingest calls this for Initialize facts; many later event emitters look up the saved connection state.

*Call graph*: called by 1 (ingest).


##### `AnalyticsReducer::ingest_subagent_thread_started`  (lines 543–569)

```
fn ingest_subagent_thread_started(
        &mut self,
        input: SubAgentThreadStartedInput,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Records and emits analytics for a thread started by a sub-agent. A sub-agent is another agent working under a parent thread.

**Data flow**: It receives sub-agent thread input → copies parent connection if known, stores thread metadata, and appends a thread-initialized event to the output.

**Call relations**: AnalyticsReducer::ingest calls this for custom sub-agent facts; it uses the normal thread state map so later events for that child thread have context.

*Call graph*: calls 1 internal fn (subagent_thread_started_event_request); called by 1 (ingest); 1 external calls (ThreadInitialized).


##### `AnalyticsReducer::ingest_guardian_review`  (lines 571–592)

```
fn ingest_guardian_review(
        &mut self,
        input: GuardianReviewEventParams,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Emits an analytics event for a guardian review fact. The guardian is an automated approval or safety reviewer.

**Data flow**: It receives guardian review parameters → looks up connection and thread metadata → if found, wraps everything in a GuardianReview event and appends it to output.

**Call relations**: AnalyticsReducer::ingest calls this for custom guardian review facts; it uses AnalyticsDropSite::guardian and thread_context_or_warn to avoid sending incomplete events.

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

**Purpose**: Remembers client requests whose later responses are needed to complete analytics. This is mainly for turn starts and turn steering.

**Data flow**: It receives a connection ID, request ID, and client request → if the request starts or steers a turn, stores thread ID, expected turn ID, image count, and creation time as pending state.

**Call relations**: AnalyticsReducer::ingest calls this for client requests; ingest_response or ingest_error_response later removes the pending request and finishes the analytics story.

*Call graph*: calls 1 internal fn (num_input_images); called by 1 (ingest); 3 external calls (TurnStart, TurnSteer, now_unix_seconds).


##### `AnalyticsReducer::ingest_turn_resolved_config`  (lines 625–638)

```
async fn ingest_turn_resolved_config(
        &mut self,
        input: TurnResolvedConfigFact,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Stores the final configuration chosen for a turn, such as model and permissions. A turn event cannot be emitted until this is known.

**Data flow**: It receives a resolved-config fact → updates or creates the turn state with thread ID, input image count, and config → asks maybe_emit_turn_event whether the turn is now complete enough to send.

**Call relations**: AnalyticsReducer::ingest calls this for custom turn config facts; maybe_emit_turn_event coordinates it with profile and completion facts.

*Call graph*: calls 1 internal fn (maybe_emit_turn_event); called by 1 (ingest).


##### `AnalyticsReducer::ingest_turn_token_usage`  (lines 640–650)

```
async fn ingest_turn_token_usage(
        &mut self,
        input: TurnTokenUsageFact,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Stores token usage for a turn. Tokens are the chunks of text the model reads and writes.

**Data flow**: It receives token usage with thread and turn IDs → saves the usage in the turn state → asks maybe_emit_turn_event whether all required turn pieces have arrived.

**Call relations**: AnalyticsReducer::ingest calls this for token usage facts; the final turn event includes these counts if present.

*Call graph*: calls 1 internal fn (maybe_emit_turn_event); called by 1 (ingest).


##### `AnalyticsReducer::ingest_turn_profile`  (lines 652–661)

```
async fn ingest_turn_profile(
        &mut self,
        input: TurnProfileFact,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Stores timing profile information for a turn, such as sampling time and tool waiting time.

**Data flow**: It receives a turn profile fact → saves the profile under the turn ID → asks maybe_emit_turn_event whether the full turn event can now be emitted.

**Call relations**: AnalyticsReducer::ingest calls this for profile facts; maybe_emit_turn_event combines it with config, completion, and context.

*Call graph*: calls 1 internal fn (maybe_emit_turn_event); called by 1 (ingest).


##### `AnalyticsReducer::ingest_turn_codex_error`  (lines 663–672)

```
fn ingest_turn_codex_error(&mut self, input: TurnCodexErrorFact)
```

**Purpose**: Records a Codex-specific error associated with a turn. This lets the final turn event include richer error details.

**Data flow**: It receives turn ID, thread ID, and error → ensures a turn state exists → stores the thread ID if missing and saves the error.

**Call relations**: AnalyticsReducer::ingest calls this for custom turn error facts; codex_turn_event_params later reads the saved error when building the turn event.

*Call graph*: called by 1 (ingest).


##### `AnalyticsReducer::ingest_skill_invoked`  (lines 674–722)

```
async fn ingest_skill_invoked(
        &mut self,
        input: SkillInvokedInput,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Emits analytics for skill invocations. A skill is a reusable capability or script the system can call.

**Data flow**: It receives tracking data and a list of invocations → for each skill, finds repository information when possible, builds a stable skill ID, and appends a SkillInvocation event.

**Call relations**: AnalyticsReducer::ingest calls this for skill facts; it uses git helpers and skill_id_for_local_skill to identify local skills consistently.

*Call graph*: calls 2 internal fn (skill_id_for_local_skill, originator); called by 1 (ingest); 3 external calls (SkillInvocation, collect_git_info, get_git_repo_root).


##### `AnalyticsReducer::ingest_app_mentioned`  (lines 724–733)

```
fn ingest_app_mentioned(&mut self, input: AppMentionedInput, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits one analytics event for each app mentioned during a turn.

**Data flow**: It receives tracking data and mention records → converts each mention into app metadata → extends the output list with app-mentioned events.

**Call relations**: AnalyticsReducer::ingest calls this for app mention facts.

*Call graph*: called by 1 (ingest).


##### `AnalyticsReducer::ingest_app_used`  (lines 735–742)

```
fn ingest_app_used(&mut self, input: AppUsedInput, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits analytics when an app is actually used, not just mentioned.

**Data flow**: It receives tracking data and an app record → builds app metadata → appends a CodexAppUsed event.

**Call relations**: AnalyticsReducer::ingest calls this for app-used facts; it relies on codex_app_metadata to shape the event fields.

*Call graph*: calls 1 internal fn (codex_app_metadata); called by 1 (ingest); 1 external calls (AppUsed).


##### `AnalyticsReducer::ingest_hook_run`  (lines 744–750)

```
fn ingest_hook_run(&mut self, input: HookRunInput, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits analytics for a hook run. A hook is custom code that runs at a defined point in the workflow.

**Data flow**: It receives tracking data and hook details → converts them into hook metadata → appends a HookRun event.

**Call relations**: AnalyticsReducer::ingest calls this for hook facts.

*Call graph*: calls 1 internal fn (codex_hook_run_metadata); called by 1 (ingest); 1 external calls (HookRun).


##### `AnalyticsReducer::ingest_plugin_used`  (lines 752–758)

```
fn ingest_plugin_used(&mut self, input: PluginUsedInput, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits analytics when a plugin is used.

**Data flow**: It receives tracking data and plugin details → builds plugin-used metadata → appends a PluginUsed event.

**Call relations**: AnalyticsReducer::ingest calls this for plugin-used facts.

*Call graph*: calls 1 internal fn (codex_plugin_used_metadata); called by 1 (ingest); 1 external calls (PluginUsed).


##### `AnalyticsReducer::ingest_plugin_state_changed`  (lines 760–776)

```
fn ingest_plugin_state_changed(
        &mut self,
        input: PluginStateChangedInput,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Emits analytics when a plugin is installed, uninstalled, enabled, or disabled.

**Data flow**: It receives plugin information and the new state → chooses the correct event type and event wrapper → appends it to output.

**Call relations**: AnalyticsReducer::ingest calls this for plugin state facts; it uses helper functions from the events module to name and fill the event.

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

**Purpose**: Processes successful client responses and connects them back to earlier client requests. This is where new threads are announced and turn starts become known turn IDs.

**Data flow**: It receives a connection ID, client response, and output list → emits thread initialization events for thread responses, updates turn state for turn starts, or handles turn-steer responses.

**Call relations**: AnalyticsReducer::ingest calls this after converting a raw response; it calls emit_thread_initialized, ingest_turn_steer_response, and maybe_emit_turn_event as needed.

*Call graph*: calls 3 internal fn (emit_thread_initialized, ingest_turn_steer_response, maybe_emit_turn_event); called by 1 (ingest).


##### `AnalyticsReducer::ingest_server_request`  (lines 838–952)

```
fn ingest_server_request(&mut self, _connection_id: u64, request: ServerRequest)
```

**Purpose**: Stores pending approval requests sent from the server to the client. These become review analytics only after the user or client responds.

**Data flow**: It receives a server request → if it asks for command, file-change, or permission approval, derives what is being reviewed and why → stores PendingReviewState by request ID.

**Call relations**: AnalyticsReducer::ingest calls this for server requests; ingest_server_response, ingest_effective_permissions_approval_response, or ingest_server_request_aborted later complete the review.

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

**Purpose**: Completes user review analytics for normal server approval responses.

**Data flow**: It receives completion time and a server response → removes the matching pending review → converts the user's decision into analytics status and resolution → emits the review event.

**Call relations**: AnalyticsReducer::ingest calls this for server responses; it uses command_execution_review_result or file_change_review_result before calling emit_review_event.

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

**Purpose**: Completes analytics for a permissions approval response that comes from the core permission system.

**Data flow**: It receives completion time, request ID, and permission response → removes the pending review → maps the granted permissions to approved or denied → emits the review event.

**Call relations**: AnalyticsReducer::ingest calls this for effective permission responses; it delegates the final event creation to emit_review_event.

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

**Purpose**: Records that a pending user review ended without a normal decision.

**Data flow**: It receives completion time and request ID → removes the pending review if present → emits an aborted review event with no resolution.

**Call relations**: AnalyticsReducer::ingest calls this when the server says a request was aborted; emit_review_event builds the shared review payload.

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

**Purpose**: Handles error responses for client requests that were being tracked. This matters most for rejected turn-steer attempts.

**Data flow**: It receives connection ID, request ID, optional error type, and output list → removes the pending request → passes it to request-specific error handling.

**Call relations**: AnalyticsReducer::ingest calls this for JSON-RPC error responses; it forwards to ingest_request_error_response.

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

**Purpose**: Chooses how to treat a failed tracked request. Turn-start errors are ignored for analytics here, while turn-steer errors become rejection events.

**Data flow**: It receives the connection, pending request state, error type, and output list → matches the stored request kind → for turn steering, emits a rejected steer event.

**Call relations**: ingest_error_response calls this after finding the pending request; it delegates turn-steer failures to ingest_turn_steer_error_response.

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

**Purpose**: Turns a failed turn-steer request into a rejected turn-steer analytics event.

**Data flow**: It receives the connection, pending steer request, optional error type, and output list → converts the error into a rejection reason → emits the turn-steer event with no accepted turn ID.

**Call relations**: ingest_request_error_response calls this for turn-steer errors; it uses emit_turn_steer_event for the shared event shape.

*Call graph*: calls 2 internal fn (emit_turn_steer_event, rejection_reason_from_error_type); called by 1 (ingest_request_error_response).


##### `AnalyticsReducer::ingest_notification`  (lines 1089–1216)

```
async fn ingest_notification(
        &mut self,
        notification: ServerNotification,
        out: &mut Vec<TrackEventRequest>,
    )
```

**Purpose**: Processes server notifications, which are the stream of live updates during a turn. It records tool timings, tool counts, diffs, turn start and completion, and guardian review completions.

**Data flow**: It receives one notification → depending on its kind, stores start times, emits completed tool events, updates turn state, saves latest diffs, or triggers final turn emission.

**Call relations**: AnalyticsReducer::ingest calls this for notifications; it uses helpers such as tracked_tool_item_id, tool_item_event, ingest_guardian_review_completed, analytics_turn_status, and maybe_emit_turn_event.

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

**Purpose**: Stores thread metadata and emits the event that says a thread has been created, resumed, or forked.

**Data flow**: It receives connection ID, thread data, model, initialization mode, and output list → looks up connection context, derives thread metadata, stores it, and appends a ThreadInitialized event.

**Call relations**: ingest_response calls this for thread-start, resume, and fork responses; later turn and tool events depend on the stored thread metadata.

*Call graph*: calls 1 internal fn (from_thread_metadata); called by 1 (ingest_response); 2 external calls (ThreadInitialized, try_from).


##### `AnalyticsReducer::ingest_compaction`  (lines 1269–1289)

```
fn ingest_compaction(&mut self, input: CodexCompactionEvent, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits analytics when a conversation context is compacted.

**Data flow**: It receives a compaction fact → looks up connection and thread metadata → builds compaction event parameters and appends the event.

**Call relations**: AnalyticsReducer::ingest calls this for custom compaction facts; it uses AnalyticsDropSite::compaction and thread_context_or_warn.

*Call graph*: calls 3 internal fn (codex_compaction_event_params, compaction, thread_context_or_warn); called by 1 (ingest); 2 external calls (new, Compaction).


##### `AnalyticsReducer::ingest_goal`  (lines 1291–1309)

```
fn ingest_goal(&mut self, input: CodexGoalEvent, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Emits analytics for goal-related activity.

**Data flow**: It receives a goal fact → looks up thread and connection context → builds goal event parameters and appends the event.

**Call relations**: AnalyticsReducer::ingest calls this for custom goal facts; it follows the same context-checking pattern as compaction.

*Call graph*: calls 3 internal fn (codex_goal_event_params, goal, thread_context_or_warn); called by 1 (ingest); 2 external calls (new, Goal).


##### `AnalyticsReducer::ingest_guardian_review_completed`  (lines 1311–1351)

```
fn ingest_guardian_review_completed(
        &mut self,
        notification: codex_app_server_protocol::ItemGuardianApprovalReviewCompletedNotification,
        out: &mut Vec<TrackEventRequest>,
```

**Purpose**: Turns a completed guardian approval notification into a standard review event.

**Data flow**: It receives a guardian review completion notification → maps the guardian status, subject, trigger, and permission flags → creates PendingReviewState-like data → emits a review event marked as reviewed by Guardian.

**Call relations**: ingest_notification calls this for guardian review completion notifications; it then hands the normalized review to emit_review_event.

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

**Purpose**: Handles a successful turn-steer response and emits the accepted steer event.

**Data flow**: It receives connection ID, request ID, response, and output list → removes the pending steer request → increments the target turn's steer count if known → emits a successful turn-steer event.

**Call relations**: ingest_response calls this for TurnSteer responses; it shares emission logic with the error path through emit_turn_steer_event.

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

**Purpose**: Builds and appends the analytics event for accepted or rejected turn steering.

**Data flow**: It receives connection ID, pending steer data, optional accepted turn ID, result, rejection reason, and output list → looks up client and thread metadata → appends a TurnSteer event if context exists.

**Call relations**: ingest_turn_steer_response calls it for accepted steering, and ingest_turn_steer_error_response calls it for rejected steering.

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

**Purpose**: Builds and appends a review analytics event. It also records a short review summary for the related tool item, if there is one.

**Data flow**: It receives pending review details, reviewer, status, resolution, completion time, and output list → updates per-item review summary → looks up context → appends a ReviewEvent with timing and outcome fields.

**Call relations**: Review completion paths call this from server responses, permission responses, aborted requests, and guardian completions.

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

**Purpose**: Accumulates review facts that should later be attached to a tool item event.

**Data flow**: It receives an item key, reviewer, status, resolution, and pending review → increments total, guardian, or user review counts → stores final approval outcome and permission-request flags.

**Call relations**: emit_review_event calls this before emitting the review; ingest_notification later reads the summary when the tool item completes.

*Call graph*: calls 1 internal fn (final_approval_outcome); called by 1 (emit_review_event).


##### `AnalyticsReducer::maybe_emit_turn_event`  (lines 1486–1544)

```
async fn maybe_emit_turn_event(&mut self, turn_id: &str, out: &mut Vec<TrackEventRequest>)
```

**Purpose**: Checks whether a turn has all required pieces and, if so, emits the final turn analytics event. It is the gatekeeper that prevents partial turn events.

**Data flow**: It receives a turn ID and output list → verifies thread ID, image count, resolved config, profile, completion, connection, and metadata are present → appends the turn event, optionally appends accepted-line fingerprint events, and removes the completed turn state.

**Call relations**: Turn-related ingest methods call this whenever they add another piece of turn data, including config, profile, token usage, start response, and completion notification.

*Call graph*: calls 6 internal fn (accepted_line_fingerprint_event_requests, accepted_line_repo_hash_for_cwd, turn, accepted_line_event_input, codex_turn_event_params, warn_missing_analytics_context); called by 5 (ingest_notification, ingest_response, ingest_turn_profile, ingest_turn_resolved_config, ingest_turn_token_usage); 2 external calls (new, TurnEvent).


##### `AnalyticsReducer::thread_connection_or_warn`  (lines 1546–1566)

```
fn thread_connection_or_warn(
        &self,
        drop_site: AnalyticsDropSite<'_>,
    ) -> Option<&ConnectionState>
```

**Purpose**: Finds the connection metadata for a thread or logs why it cannot.

**Data flow**: It receives a drop-site label → looks up the thread, then its connection ID, then the connection state → returns the connection state or None after warning.

**Call relations**: thread_context_or_warn calls this as the first half of fetching full analytics context.

*Call graph*: calls 1 internal fn (warn_missing_analytics_context); called by 1 (thread_context_or_warn).


##### `AnalyticsReducer::thread_context_or_warn`  (lines 1568–1582)

```
fn thread_context_or_warn(
        &self,
        drop_site: AnalyticsDropSite<'_>,
    ) -> Option<(&ConnectionState, &ThreadMetadataState)>
```

**Purpose**: Finds both connection and thread metadata needed for most analytics events.

**Data flow**: It receives a drop-site label → gets connection state through thread_connection_or_warn → looks up thread metadata → returns both pieces or warns and returns None.

**Call relations**: Review, guardian, compaction, goal, and tool-item paths call this before emitting events that need full context.

*Call graph*: calls 2 internal fn (thread_connection_or_warn, warn_missing_analytics_context); called by 5 (emit_review_event, ingest_compaction, ingest_goal, ingest_guardian_review, ingest_notification).


##### `warn_missing_analytics_context`  (lines 1585–1606)

```
fn warn_missing_analytics_context(
    drop_site: &AnalyticsDropSite<'_>,
    missing: MissingAnalyticsContext,
)
```

**Purpose**: Writes a structured warning when an analytics event must be dropped because required context is missing.

**Data flow**: It receives a drop-site label and the kind of missing context → formats the missing context name and optional connection ID → sends a tracing warning.

**Call relations**: Context lookup and event emission helpers call this instead of silently losing analytics events.

*Call graph*: called by 4 (emit_turn_steer_event, maybe_emit_turn_event, thread_connection_or_warn, thread_context_or_warn); 1 external calls (warn!).


##### `tracked_tool_item_id`  (lines 1608–1629)

```
fn tracked_tool_item_id(item: &ThreadItem) -> Option<&str>
```

**Purpose**: Decides whether a thread item is a tool item that should get detailed analytics, and returns its item ID if so.

**Data flow**: It receives a ThreadItem → returns the ID for command, file change, MCP, dynamic, collaboration agent, web search, and image generation items → returns None for messages and other non-tool items.

**Call relations**: ingest_notification uses this for item-started and item-completed notifications.

*Call graph*: called by 1 (ingest_notification).


##### `item_review_summary_key`  (lines 1631–1642)

```
fn item_review_summary_key(pending_review: &PendingReviewState) -> Option<ToolItemKey>
```

**Purpose**: Builds the lookup key used to attach review summaries to later tool item events.

**Data flow**: It receives a pending review → if the review is tied to a command, file change, or MCP tool call, combines thread ID, turn ID, and item ID into a ToolItemKey → otherwise returns None.

**Call relations**: emit_review_event calls this before recording per-item review information.

*Call graph*: called by 1 (emit_review_event).


##### `tool_item_event`  (lines 1655–1970)

```
fn tool_item_event(input: ToolItemEventInput<'_>) -> Option<TrackEventRequest>
```

**Purpose**: Builds the correct analytics event for a completed tool item. Different tool kinds need different details, but they all share a common base.

**Data flow**: It receives tool item input with IDs, timings, context, and optional review summary → matches the item kind → computes outcome and counts → returns the matching TrackEventRequest, or None for untracked/in-progress items.

**Call relations**: ingest_notification calls this after a tracked tool completes; it delegates to many small helpers for names, outcomes, counts, and common base fields.

*Call graph*: calls 12 internal fn (collab_agent_tool_name, collab_tool_call_outcome, command_action_counts, command_execution_outcome, command_execution_tool_name, dynamic_tool_call_outcome, file_change_counts, image_generation_outcome, mcp_tool_call_outcome, patch_apply_outcome (+2 more)); called by 1 (ingest_notification); 9 external calls (CollabAgentToolCall, CommandExecution, DynamicToolCall, FileChange, ImageGeneration, McpToolCall, WebSearch, option_i64_to_u64, usize_to_u64).


##### `command_action_counts`  (lines 1987–2001)

```
fn command_action_counts(command_actions: &[CommandAction]) -> CommandActionCounts
```

**Purpose**: Counts what kinds of actions a command performed, such as reading files or searching.

**Data flow**: It receives a list of command actions → starts with the total length → increments read, list-files, search, or unknown counters → returns the counts.

**Call relations**: tool_item_event uses this when building command execution analytics.

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

**Purpose**: Creates the common fields shared by all tool item analytics events.

**Data flow**: It receives thread and turn IDs, item ID, tool name, outcome, timing, connection context, thread metadata, and review summary → combines them into CodexToolItemEventBase.

**Call relations**: tool_item_event calls this for every tracked tool kind so command, file, MCP, dynamic, agent, web, and image events have consistent fields.

*Call graph*: calls 1 internal fn (observed_duration_ms); called by 1 (tool_item_event).


##### `observed_duration_ms`  (lines 2052–2054)

```
fn observed_duration_ms(started_at_ms: u64, completed_at_ms: u64) -> Option<u64>
```

**Purpose**: Safely calculates elapsed time in milliseconds.

**Data flow**: It receives start and completion times → subtracts start from completion only if completion is not earlier → returns the duration or None.

**Call relations**: emit_review_event and tool_item_base use it to fill duration fields without underflowing if timestamps are unusual.

*Call graph*: called by 2 (emit_review_event, tool_item_base).


##### `user_review_id`  (lines 2056–2058)

```
fn user_review_id(request_id: &RequestId) -> String
```

**Purpose**: Creates a stable analytics review ID for a user approval request.

**Data flow**: It receives a request ID → prefixes it with "user:" → returns the resulting string.

**Call relations**: ingest_server_request uses this when storing pending user reviews.

*Call graph*: called by 1 (ingest_server_request); 1 external calls (format!).


##### `command_execution_review_result`  (lines 2060–2089)

```
fn command_execution_review_result(
    decision: CommandExecutionApprovalDecision,
) -> (ReviewStatus, ReviewResolution)
```

**Purpose**: Translates a command approval decision into analytics status and resolution.

**Data flow**: It receives the user's command decision → maps accept, session accept, policy amendments, decline, and cancel into ReviewStatus and ReviewResolution values.

**Call relations**: ingest_server_response uses this before emitting command review analytics.

*Call graph*: called by 1 (ingest_server_response).


##### `file_change_review_result`  (lines 2091–2102)

```
fn file_change_review_result(
    decision: FileChangeApprovalDecision,
) -> (ReviewStatus, ReviewResolution)
```

**Purpose**: Translates a file-change approval decision into analytics status and resolution.

**Data flow**: It receives the user's file-change decision → maps it to approved, denied, or aborted, with session approval when applicable → returns the pair.

**Call relations**: ingest_server_response uses this before emitting file-change review analytics.

*Call graph*: called by 1 (ingest_server_response).


##### `effective_permissions_review_result`  (lines 2104–2117)

```
fn effective_permissions_review_result(
    response: &CoreRequestPermissionsResponse,
) -> (ReviewStatus, ReviewResolution)
```

**Purpose**: Translates a permissions response into analytics status and resolution.

**Data flow**: It receives a permission response → treats an empty permission set as denied → otherwise marks it approved for the turn or session depending on the grant scope.

**Call relations**: ingest_effective_permissions_approval_response uses this before emitting a review event.

*Call graph*: called by 1 (ingest_effective_permissions_approval_response).


##### `guardian_review_result`  (lines 2119–2137)

```
fn guardian_review_result(
    status: GuardianApprovalReviewStatus,
) -> Option<(ReviewStatus, ReviewResolution)>
```

**Purpose**: Translates a guardian review status into analytics status and resolution, ignoring reviews still in progress.

**Data flow**: It receives a guardian status → returns None for in-progress → returns approved, denied, timed out, or aborted with no extra resolution for terminal statuses.

**Call relations**: ingest_guardian_review_completed uses this to decide whether a guardian completion should produce a review event.

*Call graph*: called by 1 (ingest_guardian_review_completed).


##### `guardian_review_subject_metadata`  (lines 2139–2188)

```
fn guardian_review_subject_metadata(
    action: &GuardianApprovalReviewAction,
) -> (ReviewSubjectKind, String, ReviewTrigger)
```

**Purpose**: Describes what a guardian reviewed and why the review was triggered.

**Data flow**: It receives a guardian review action → maps it to a subject kind, subject name, and trigger such as initial review, sandbox denial, network denial, or exec interception.

**Call relations**: ingest_guardian_review_completed calls this while converting guardian notifications into standard review events.

*Call graph*: called by 1 (ingest_guardian_review_completed).


##### `guardian_review_requested_additional_permissions`  (lines 2190–2202)

```
fn guardian_review_requested_additional_permissions(action: &GuardianApprovalReviewAction) -> bool
```

**Purpose**: Answers whether a guardian-reviewed action asked for extra permissions beyond the current sandbox.

**Data flow**: It receives a guardian action → checks action kind and permission request details → returns true for patch, network, or explicit permission expansion cases.

**Call relations**: ingest_guardian_review_completed uses this flag so review and tool analytics can show whether extra permissions were involved.

*Call graph*: calls 1 internal fn (guardian_review_request_permissions_network_enabled); called by 1 (ingest_guardian_review_completed).


##### `guardian_review_requested_network_access`  (lines 2204–2215)

```
fn guardian_review_requested_network_access(action: &GuardianApprovalReviewAction) -> bool
```

**Purpose**: Answers whether a guardian-reviewed action asked for network access.

**Data flow**: It receives a guardian action → checks network actions and permission profiles → returns true only when network access was requested.

**Call relations**: ingest_guardian_review_completed stores this on the pending review; record_item_review_summary may later attach it to a tool event.

*Call graph*: calls 1 internal fn (guardian_review_request_permissions_network_enabled); called by 1 (ingest_guardian_review_completed).


##### `guardian_review_request_permissions_network_enabled`  (lines 2217–2225)

```
fn guardian_review_request_permissions_network_enabled(
    permissions: &RequestPermissionProfile,
) -> bool
```

**Purpose**: Checks whether a permission profile explicitly enables network access.

**Data flow**: It receives a request permission profile → looks for the optional network section and its enabled flag → returns false if either is missing.

**Call relations**: The two guardian permission helpers use this to avoid duplicating the network-checking logic.

*Call graph*: called by 2 (guardian_review_requested_additional_permissions, guardian_review_requested_network_access).


##### `final_approval_outcome`  (lines 2227–2243)

```
fn final_approval_outcome(
    reviewer: Reviewer,
    status: ReviewStatus,
    resolution: ReviewResolution,
) -> FinalApprovalOutcome
```

**Purpose**: Condenses reviewer, status, and resolution into one final approval outcome label for a tool item.

**Data flow**: It receives who reviewed, whether they approved or denied, and any resolution → returns labels such as guardian approved, user denied, or user approved for session.

**Call relations**: record_item_review_summary calls this when updating the review summary attached to later tool analytics.

*Call graph*: called by 1 (record_item_review_summary).


##### `command_execution_tool_name`  (lines 2245–2252)

```
fn command_execution_tool_name(source: CommandExecutionSource) -> &'static str
```

**Purpose**: Normalizes different command execution sources into analytics tool names.

**Data flow**: It receives a command execution source → returns names such as "unified_exec", "user_shell", or "shell".

**Call relations**: tool_item_event uses this when building command execution events.

*Call graph*: called by 1 (tool_item_event).


##### `command_execution_outcome`  (lines 2254–2269)

```
fn command_execution_outcome(
    status: &CommandExecutionStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps command execution status into a final tool outcome. In-progress commands do not produce final tool analytics yet.

**Data flow**: It receives a command status → returns None for in progress → otherwise returns completed, failed, or rejected plus a failure reason when needed.

**Call relations**: tool_item_event uses this before emitting command execution analytics.

*Call graph*: called by 1 (tool_item_event).


##### `patch_apply_outcome`  (lines 2271–2286)

```
fn patch_apply_outcome(
    status: &PatchApplyStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps file patch status into a final tool outcome.

**Data flow**: It receives patch status → returns None for in progress → otherwise returns completed, failed, or rejected with the appropriate failure kind.

**Call relations**: tool_item_event uses this when building file change analytics.

*Call graph*: called by 1 (tool_item_event).


##### `mcp_tool_call_outcome`  (lines 2288–2299)

```
fn mcp_tool_call_outcome(
    status: &McpToolCallStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps MCP tool call status into a final tool outcome. MCP means Model Context Protocol, a way for the model to call external tools.

**Data flow**: It receives MCP tool status → returns None for in progress → otherwise returns completed or failed.

**Call relations**: tool_item_event uses this when building MCP tool call analytics.

*Call graph*: called by 1 (tool_item_event).


##### `dynamic_tool_call_outcome`  (lines 2301–2312)

```
fn dynamic_tool_call_outcome(
    status: &DynamicToolCallStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps dynamic tool call status into a final tool outcome.

**Data flow**: It receives dynamic tool status → returns None for in progress → otherwise returns completed or failed with a tool-error failure kind when failed.

**Call relations**: tool_item_event uses this when building dynamic tool call analytics.

*Call graph*: called by 1 (tool_item_event).


##### `collab_tool_call_outcome`  (lines 2314–2325)

```
fn collab_tool_call_outcome(
    status: &CollabAgentToolCallStatus,
) -> Option<(ToolItemTerminalStatus, Option<ToolItemFailureKind>)>
```

**Purpose**: Maps collaborative agent tool call status into a final tool outcome.

**Data flow**: It receives collaboration tool status → returns None for in progress → otherwise returns completed or failed.

**Call relations**: tool_item_event uses this when building collaborative agent tool call analytics.

*Call graph*: called by 1 (tool_item_event).


##### `image_generation_outcome`  (lines 2327–2335)

```
fn image_generation_outcome(status: &str) -> (ToolItemTerminalStatus, Option<ToolItemFailureKind>)
```

**Purpose**: Maps an image generation status string into a final analytics outcome.

**Data flow**: It receives the raw status text → treats "failed" and "error" as failed tool errors → treats other statuses as completed.

**Call relations**: tool_item_event uses this when building image generation analytics.

*Call graph*: called by 1 (tool_item_event).


##### `collab_agent_tool_name`  (lines 2337–2345)

```
fn collab_agent_tool_name(tool: &CollabAgentTool) -> &'static str
```

**Purpose**: Converts a collaborative agent tool enum into a stable analytics name.

**Data flow**: It receives a collaboration tool type → returns names such as "spawn_agent", "send_input", or "wait_agent".

**Call relations**: tool_item_event uses this when building collaborative agent tool call events.

*Call graph*: called by 1 (tool_item_event).


##### `file_change_counts`  (lines 2355–2366)

```
fn file_change_counts(changes: &[codex_app_server_protocol::FileUpdateChange]) -> FileChangeCounts
```

**Purpose**: Counts the kinds of file changes in a patch.

**Data flow**: It receives a list of file update changes → counts adds, deletes, updates, and moves → returns the counts.

**Call relations**: tool_item_event uses this to add file-change breakdowns to file change analytics.

*Call graph*: called by 1 (tool_item_event); 1 external calls (default).


##### `dynamic_content_counts`  (lines 2375–2389)

```
fn dynamic_content_counts(items: &[DynamicToolCallOutputContentItem]) -> DynamicContentCounts
```

**Purpose**: Counts text and image output items from a dynamic tool call.

**Data flow**: It receives output content items → counts total items, text items, and image items → returns the totals.

**Call relations**: tool_item_event uses this when dynamic tool output content is present.

*Call graph*: 2 external calls (len, usize_to_u64).


##### `web_search_action_kind`  (lines 2391–2398)

```
fn web_search_action_kind(action: &WebSearchAction) -> WebSearchActionKind
```

**Purpose**: Normalizes a web search action into a simple analytics category.

**Data flow**: It receives a web search action → returns Search, OpenPage, FindInPage, or Other.

**Call relations**: tool_item_event uses this when building web search analytics.


##### `web_search_query_count`  (lines 2400–2411)

```
fn web_search_query_count(query: &str, action: Option<&WebSearchAction>) -> Option<u64>
```

**Purpose**: Counts how many search queries are represented by a web search event when that count is meaningful.

**Data flow**: It receives the legacy query string and optional structured action → returns a count for search actions or non-empty legacy queries, and None for page-open or find-in-page actions.

**Call relations**: tool_item_event uses this to fill the query count in web search analytics.

*Call graph*: called by 1 (tool_item_event).


##### `accepted_line_event_input`  (lines 2413–2441)

```
fn accepted_line_event_input(
    turn_id: &str,
    turn_state: &TurnState,
) -> Option<(AcceptedLineFingerprintEventInput, PathBuf)>
```

**Purpose**: Prepares accepted-line fingerprint analytics from the latest turn diff. These fingerprints summarize code lines added or removed without sending the raw code.

**Data flow**: It receives a turn ID and turn state → parses the latest unified diff into line fingerprints → if there are accepted additions or deletions, returns event input plus the working directory for repo hashing.

**Call relations**: maybe_emit_turn_event calls this after emitting a turn event; if it returns data, repository hashing and accepted-line event requests are produced.

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

**Purpose**: Builds the full payload for a completed turn analytics event.

**Data flow**: It receives client metadata, runtime metadata, turn ID, completed turn state, and thread metadata → extracts model, permissions, timing, token, tool count, status, and error fields → returns CodexTurnEventParams.

**Call relations**: maybe_emit_turn_event calls this only after checking the turn state is fully populated.

*Call graph*: calls 4 internal fn (collaboration_mode_mode, personality_mode, reasoning_summary_mode, sandbox_policy_mode); called by 1 (maybe_emit_turn_event); 1 external calls (unreachable!).


##### `sandbox_policy_mode`  (lines 2572–2594)

```
fn sandbox_policy_mode(permission_profile: &PermissionProfile, cwd: &Path) -> &'static str
```

**Purpose**: Turns a detailed permission profile into a simple sandbox label for analytics.

**Data flow**: It receives a permission profile and current working directory → inspects file-system and network restrictions → returns labels such as "full_access", "external_sandbox", "read_only", or "workspace_write".

**Call relations**: codex_turn_event_params uses this to summarize sandbox behavior in the turn event.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, network_sandbox_policy); called by 1 (codex_turn_event_params).


##### `collaboration_mode_mode`  (lines 2596–2601)

```
fn collaboration_mode_mode(mode: ModeKind) -> &'static str
```

**Purpose**: Normalizes collaboration mode into a simple analytics string.

**Data flow**: It receives a mode → returns "plan" for plan mode and "default" for default, pair-programming, or execute modes.

**Call relations**: codex_turn_event_params uses this while building turn event fields.

*Call graph*: called by 1 (codex_turn_event_params).


##### `reasoning_summary_mode`  (lines 2603–2608)

```
fn reasoning_summary_mode(summary: Option<ReasoningSummary>) -> Option<String>
```

**Purpose**: Converts optional reasoning-summary settings into analytics text, omitting the explicit "none" case.

**Data flow**: It receives an optional ReasoningSummary → returns None for missing or None → otherwise returns the setting as a string.

**Call relations**: codex_turn_event_params uses this for the turn event's reasoning summary field.

*Call graph*: called by 1 (codex_turn_event_params).


##### `personality_mode`  (lines 2610–2615)

```
fn personality_mode(personality: Option<Personality>) -> Option<String>
```

**Purpose**: Converts optional personality settings into analytics text, omitting the explicit "none" case.

**Data flow**: It receives an optional Personality → returns None for missing or None → otherwise returns the personality as a string.

**Call relations**: codex_turn_event_params uses this for the turn event's personality field.

*Call graph*: called by 1 (codex_turn_event_params).


##### `analytics_turn_status`  (lines 2617–2624)

```
fn analytics_turn_status(status: codex_app_server_protocol::TurnStatus) -> Option<TurnStatus>
```

**Purpose**: Maps app-server turn status into analytics turn status, ignoring turns still in progress.

**Data flow**: It receives a protocol turn status → returns completed, failed, interrupted, or None for in-progress.

**Call relations**: ingest_notification uses this when a TurnCompleted notification arrives.

*Call graph*: called by 1 (ingest_notification).


##### `num_input_images`  (lines 2626–2631)

```
fn num_input_images(input: &[UserInput]) -> usize
```

**Purpose**: Counts how many image inputs the user sent with a request.

**Data flow**: It receives user input items → counts normal image and local image entries → returns the count.

**Call relations**: ingest_request uses this when remembering pending turn-start and turn-steer requests.

*Call graph*: called by 1 (ingest_request); 1 external calls (iter).


##### `rejection_reason_from_error_type`  (lines 2633–2640)

```
fn rejection_reason_from_error_type(
    error_type: Option<AnalyticsJsonRpcError>,
) -> Option<TurnSteerRejectionReason>
```

**Purpose**: Converts a tracked JSON-RPC error into a turn-steer rejection reason when possible. JSON-RPC is the request/response protocol used here.

**Data flow**: It receives an optional analytics error → if present and relevant, converts turn-steer or input errors into a TurnSteerRejectionReason → otherwise returns None.

**Call relations**: ingest_turn_steer_error_response uses this before emitting a rejected turn-steer event.

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

**Purpose**: Builds a stable, privacy-safer identifier for a local skill. It hashes the repository or personal prefix, path, and skill name.

**Data flow**: It receives optional repo URL, optional repo root, skill path, and skill name → normalizes the path → builds a raw ID string → SHA-1 hashes it and returns the hex digest.

**Call relations**: ingest_skill_invoked uses this for skill invocation analytics; tests also exercise it through the public helper behavior.

*Call graph*: calls 1 internal fn (normalize_path_for_skill_id); called by 2 (reducer_ingests_skill_invoked_fact, ingest_skill_invoked); 3 external calls (format!, update, new).


##### `normalize_path_for_skill_id`  (lines 2664–2682)

```
fn normalize_path_for_skill_id(
    repo_url: Option<&str>,
    repo_root: Option<&Path>,
    skill_path: &Path,
) -> String
```

**Purpose**: Normalizes a skill path before it is used in a skill ID. Repository skills use a path relative to the repo; personal or admin skills use an absolute path.

**Data flow**: It receives optional repo URL, optional repo root, and skill path → canonicalizes paths when possible → strips the repo root for repo-scoped skills → returns a slash-normalized string.

**Call relations**: skill_id_for_local_skill calls this, and path-normalization tests call it directly.

*Call graph*: called by 5 (normalize_path_for_skill_id_admin_scoped_uses_absolute_path, normalize_path_for_skill_id_repo_root_not_in_skill_path_uses_absolute_path, normalize_path_for_skill_id_repo_scoped_uses_relative_path, normalize_path_for_skill_id_user_scoped_uses_absolute_path, skill_id_for_local_skill); 1 external calls (canonicalize).


##### `tests::managed_full_disk_with_restricted_network_reports_external_sandbox`  (lines 2692–2703)

```
fn managed_full_disk_with_restricted_network_reports_external_sandbox()
```

**Purpose**: Checks that a managed sandbox with full disk access but restricted network is reported as an external sandbox.

**Data flow**: It builds a permission profile with unrestricted files and restricted network → calls sandbox_policy_mode → asserts the result is "external_sandbox".

**Call relations**: This test protects the analytics label used by codex_turn_event_params.

*Call graph*: calls 2 internal fn (from_runtime_permissions_with_enforcement, unrestricted); 1 external calls (assert_eq!).


##### `tests::guardian_review_result_maps_terminal_statuses`  (lines 2706–2712)

```
fn guardian_review_result_maps_terminal_statuses()
```

**Purpose**: Checks that guardian review statuses are mapped correctly for analytics.

**Data flow**: It calls guardian_review_result for in-progress and timed-out statuses → asserts in-progress produces no event result and timed-out maps to the timed-out review status.

**Call relations**: This test protects the mapping used by ingest_guardian_review_completed.

*Call graph*: 1 external calls (assert!).


### Client delivery layer
These files expose the runtime client that queues, reduces, deduplicates, and delivers analytics events for the application.

### `analytics/src/client.rs`

`io_transport` · `cross-cutting background event delivery`

This file solves a practical problem: many parts of the app want to report useful product and runtime events, but those reports should not slow down the user’s work. It provides an AnalyticsEventsClient with small methods like tracking a turn, a plugin change, a server request, or an error. Each method wraps the raw information into an AnalyticsFact, which is a structured note about something that happened.

When analytics is enabled, the client owns an AnalyticsEventsQueue. The queue is like a mailbox: callers drop facts into it, and a background task reads them later. That background task feeds facts into an AnalyticsReducer, which turns low-level facts into final TrackEventRequest records. Those records are then sent to the Codex backend over HTTP, but only if the user is authenticated with a backend that supports this kind of reporting.

The file also avoids duplicate “app used” and “plugin used” reports within the same turn by remembering recently emitted keys. If the queue fills up, events are dropped instead of blocking the app. In debug builds, developers can redirect analytics into a capture file instead of the network, which is useful for testing what would have been sent.

#### Function details

##### `AnalyticsEventsDestination::from_base_url`  (lines 75–78)

```
fn from_base_url(base_url: String) -> Self
```

**Purpose**: Builds the place analytics should be sent, starting from the backend base URL. In debug builds, it also checks whether an environment variable asks to capture events into a local file instead of sending them over the network.

**Data flow**: It takes a base URL as input. It reads the optional capture-file setting from the environment, then passes both pieces of information to the destination builder. The result is either an HTTP endpoint or, in debug builds, a file destination.

**Call relations**: AnalyticsEventsClient::new calls this during client setup. This function delegates the real choice to AnalyticsEventsDestination::from_base_url_and_capture_file after asking analytics_capture_file_from_env whether a debug capture file was requested.

*Call graph*: calls 1 internal fn (analytics_capture_file_from_env); called by 1 (new); 1 external calls (from_base_url_and_capture_file).


##### `AnalyticsEventsDestination::from_base_url_and_capture_file`  (lines 80–103)

```
fn from_base_url_and_capture_file(base_url: String, capture_file: Option<PathBuf>) -> Self
```

**Purpose**: Chooses between normal network delivery and debug-only file capture. This is the decision point that says where analytics payloads will actually go.

**Data flow**: It receives a backend base URL and an optional file path. In debug builds, if a path is present, it tries to prepare that capture file and returns a file destination. Otherwise, it trims the URL and appends the analytics endpoint path, returning an HTTP destination.

**Call relations**: The production setup path reaches this through AnalyticsEventsDestination::from_base_url. Tests call it directly to check both the HTTP and capture-file choices, including the release-build behavior that ignores capture files.

*Call graph*: calls 1 internal fn (initialize); called by 3 (analytics_destination_ignores_capture_file_in_release, analytics_destination_uses_explicit_capture_file, analytics_destination_uses_http_without_capture_file); 3 external calls (format!, error!, warn!).


##### `analytics_capture_file_from_env`  (lines 106–116)

```
fn analytics_capture_file_from_env() -> Option<PathBuf>
```

**Purpose**: Looks for the debug-only environment variable that tells the app to write analytics events to a file. This gives developers a safe way to inspect analytics without contacting the server.

**Data flow**: It reads one environment variable. If the variable exists and is not empty in a debug build, it converts the value into a file path. In non-debug builds, it always returns nothing.

**Call relations**: AnalyticsEventsDestination::from_base_url calls this before choosing a destination. Its output is handed to AnalyticsEventsDestination::from_base_url_and_capture_file.

*Call graph*: called by 1 (from_base_url); 1 external calls (var_os).


##### `AnalyticsEventsQueue::new`  (lines 119–134)

```
fn new(auth_manager: Arc<AuthManager>, destination: AnalyticsEventsDestination) -> Self
```

**Purpose**: Creates the background analytics pipeline. It gives callers a sender they can use immediately, while a spawned task receives facts, reduces them into events, and sends them out.

**Data flow**: It takes an authentication manager and a destination. It creates a bounded channel, starts a background task, and initializes two shared sets used for duplicate suppression. The returned queue can accept analytics facts without making callers wait for delivery.

**Call relations**: AnalyticsEventsClient::new calls this when analytics is enabled. Inside the spawned task, incoming facts are passed through AnalyticsReducer and then handed to send_track_events for authenticated delivery.

*Call graph*: calls 1 internal fn (send_track_events); 7 external calls (new, new, new, new, default, channel, spawn).


##### `AnalyticsEventsQueue::try_send`  (lines 136–141)

```
fn try_send(&self, input: AnalyticsFact)
```

**Purpose**: Attempts to put one analytics fact into the queue without waiting. If the queue is full, it drops the fact and logs a warning so analytics never blocks normal app work.

**Data flow**: It receives one AnalyticsFact. It tries to send it through the queue’s channel. On success, the background task will process it later; on failure, nothing is delivered and a warning is written.

**Call relations**: AnalyticsEventsClient::record_fact uses this as the final enqueue step for nearly all tracking methods. The receiving side was created by AnalyticsEventsQueue::new.

*Call graph*: 2 external calls (try_send, warn!).


##### `AnalyticsEventsQueue::should_enqueue_app_used`  (lines 143–159)

```
fn should_enqueue_app_used(
        &self,
        tracking: &TrackEventsContext,
        app: &AppInvocation,
    ) -> bool
```

**Purpose**: Decides whether an “app used” event is new enough to send. It prevents repeated reports for the same app connector within the same turn.

**Data flow**: It reads the current tracking context and app invocation. If the app has no connector id, it allows the event. Otherwise, it stores the pair of turn id and connector id in a shared set; the event is allowed only if that pair was not already present.

**Call relations**: AnalyticsEventsClient::track_app_used calls this before recording an app-used fact. It protects the downstream queue and analytics reducer from duplicate app usage reports.


##### `AnalyticsEventsQueue::should_enqueue_plugin_used`  (lines 161–174)

```
fn should_enqueue_plugin_used(
        &self,
        tracking: &TrackEventsContext,
        plugin: &PluginTelemetryMetadata,
    ) -> bool
```

**Purpose**: Decides whether a “plugin used” event should be sent for this turn. It keeps repeated plugin-use reports from being emitted over and over.

**Data flow**: It receives the tracking context and plugin metadata. It stores the pair of turn id and plugin id in a shared set, clearing the set if it has grown too large. It returns true only when this is the first time that pair has been seen recently.

**Call relations**: AnalyticsEventsClient::track_plugin_used calls this before recording a plugin-used fact. If it returns false, no fact is sent to the queue.


##### `AnalyticsEventsClient::new`  (lines 178–188)

```
fn new(
        auth_manager: Arc<AuthManager>,
        base_url: String,
        analytics_enabled: Option<bool>,
    ) -> Self
```

**Purpose**: Creates a normal analytics client for the app. It turns configuration choices into either an active background queue or a disabled client.

**Data flow**: It receives authentication, a backend URL, and an optional enabled flag. It builds the destination from the URL, and if analytics was not explicitly disabled, it creates an AnalyticsEventsQueue. The output is a client that other code can clone and use.

**Call relations**: Startup and session-building code call this when constructing application services. It calls AnalyticsEventsDestination::from_base_url and, when enabled, AnalyticsEventsQueue::new.

*Call graph*: calls 1 internal fn (from_base_url); called by 4 (analytics_events_client_from_config, emit_subagent_session_started_includes_fork_lineage_from_session_configuration, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx).


##### `AnalyticsEventsClient::disabled`  (lines 190–192)

```
fn disabled() -> Self
```

**Purpose**: Creates an analytics client that intentionally does nothing. This is useful in tests or modes where analytics should never be sent.

**Data flow**: It takes no input. It returns a client with no queue. Later tracking calls will quietly skip recording because there is nowhere to send facts.

**Call relations**: Many tests and helper flows call this when they need an AnalyticsEventsClient but do not want background analytics behavior.

*Call graph*: called by 33 (command_execution_started_helper_emits_once, complete_command_execution_item_emits_declined_once_for_pending_command, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, test_handle_token_count_event_emits_usage_and_rate_limits, test_handle_token_count_event_without_usage_info, test_handle_turn_complete_emits_completed_without_error, test_handle_turn_complete_emits_error_multiple_turns, test_handle_turn_complete_emits_failed_with_error, test_handle_turn_diff_emits_v2_notification (+15 more)).


##### `AnalyticsEventsClient::track_skill_invocations`  (lines 194–208)

```
fn track_skill_invocations(
        &self,
        tracking: TrackEventsContext,
        invocations: Vec<SkillInvocation>,
    )
```

**Purpose**: Records that one or more skills were invoked during a tracked context. It skips empty input because there is nothing meaningful to report.

**Data flow**: It receives tracking information and a list of skill invocations. If the list is non-empty, it packages them into a SkillInvoked analytics fact and sends that fact to record_fact.

**Call relations**: build_skill_injections calls this after deciding which skills are being used. It hands the finished fact to AnalyticsEventsClient::record_fact for queueing.

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

**Purpose**: Records that a client connection was initialized. This helps analytics understand what kind of client connected, how it connected, and what runtime environment it used.

**Data flow**: It receives a connection id, initialization parameters, a product client id, and the RPC transport type. It adds current runtime metadata, wraps everything in an Initialize fact, and passes it to record_fact.

**Call relations**: The initialize flow calls this when a new app-server connection starts. It calls current_runtime_metadata to enrich the event before queueing it.

*Call graph*: calls 2 internal fn (record_fact, current_runtime_metadata); called by 1 (initialize).


##### `AnalyticsEventsClient::track_subagent_thread_started`  (lines 226–230)

```
fn track_subagent_thread_started(&self, input: SubAgentThreadStartedInput)
```

**Purpose**: Records that a subagent thread has started. This gives analytics visibility into delegated or nested work sessions.

**Data flow**: It takes a SubAgentThreadStartedInput value. It wraps that input as a custom analytics fact and sends it to record_fact.

**Call relations**: emit_subagent_session_started calls this when the subagent session event is produced. The actual delivery is handled later by record_fact and the queue.

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

**Purpose**: Records the result of a Guardian review, including when it completed. Guardian review appears to be an approval or safety-review step, and this method captures its outcome for analytics.

**Data flow**: It receives review tracking context, the review result, and a completion timestamp in milliseconds. It asks the context to build event parameters, wraps them in a GuardianReview fact, and records it.

**Call relations**: No direct caller is shown in the graph, but when review code uses it, this method converts review-specific data into the common analytics fact stream through record_fact.

*Call graph*: calls 2 internal fn (record_fact, event_params); 3 external calls (new, Custom, GuardianReview).


##### `AnalyticsEventsClient::track_app_mentioned`  (lines 243–250)

```
fn track_app_mentioned(&self, tracking: TrackEventsContext, mentions: Vec<AppInvocation>)
```

**Purpose**: Records that one or more apps were mentioned. It skips empty mention lists so analytics does not receive meaningless events.

**Data flow**: It receives tracking context and app invocation records. If there are mentions, it wraps them into an AppMentionedInput and records a custom AppMentioned fact.

**Call relations**: No specific caller is shown in the graph, but this is the client API for app-mention reporting. It hands the final fact to record_fact.

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

**Purpose**: Records selected client requests that matter for turn analytics. It deliberately ignores most request types to avoid noisy or irrelevant reporting.

**Data flow**: It receives a connection id, request id, and a client request. If the request is a turn start or turn steer request, it clones the request, wraps it in a ClientRequest fact, and records it. Otherwise it returns without doing anything.

**Call relations**: track_initialized_request calls this while following client request traffic. The method filters the request before passing useful ones to record_fact.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (track_initialized_request); 3 external calls (new, clone, matches!).


##### `AnalyticsEventsClient::track_app_used`  (lines 271–281)

```
fn track_app_used(&self, tracking: TrackEventsContext, app: AppInvocation)
```

**Purpose**: Records that an app was actually used, while avoiding duplicate reports for the same app in the same turn. This keeps usage analytics cleaner.

**Data flow**: It receives tracking context and one app invocation. If analytics is disabled, it stops. If the queue says this app-use pair was already emitted, it stops. Otherwise it wraps the data in an AppUsed fact and records it.

**Call relations**: Callers use this when app usage is detected. It consults AnalyticsEventsQueue::should_enqueue_app_used before handing the fact to record_fact.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (Custom, AppUsed).


##### `AnalyticsEventsClient::track_hook_run`  (lines 283–287)

```
fn track_hook_run(&self, tracking: TrackEventsContext, hook: HookRunFact)
```

**Purpose**: Records that a hook ran. A hook is an extra bit of behavior triggered at a certain point in the app, and this captures its analytics details.

**Data flow**: It receives tracking context and a hook-run fact. It combines them into HookRunInput, wraps that as a custom analytics fact, and sends it to record_fact.

**Call relations**: No specific caller is shown in the graph, but hook-related code can use this method to enter the common analytics pipeline.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (Custom, HookRun).


##### `AnalyticsEventsClient::track_plugin_used`  (lines 289–299)

```
fn track_plugin_used(&self, tracking: TrackEventsContext, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records that a plugin was used, while suppressing repeated plugin-use events for the same turn. This prevents one active plugin from flooding analytics.

**Data flow**: It receives tracking context and plugin telemetry metadata. If there is no queue, it stops. If this plugin was already recorded for the turn, it stops. Otherwise it wraps the data in a PluginUsed fact and records it.

**Call relations**: Plugin usage reporting code calls this client API. It relies on AnalyticsEventsQueue::should_enqueue_plugin_used before sending the fact to record_fact.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (Custom, PluginUsed).


##### `AnalyticsEventsClient::track_compaction`  (lines 301–305)

```
fn track_compaction(&self, event: crate::facts::CodexCompactionEvent)
```

**Purpose**: Records a compaction event. Compaction usually means shrinking or summarizing stored conversation context, and this captures that activity for analytics.

**Data flow**: It receives a compaction event, boxes it to store it behind a pointer, wraps it as a custom Compaction fact, and records it.

**Call relations**: No specific caller is shown in the graph. When compaction code reports an event, this method forwards it into record_fact.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, Compaction).


##### `AnalyticsEventsClient::track_goal_event`  (lines 307–311)

```
fn track_goal_event(&self, event: CodexGoalEvent)
```

**Purpose**: Records progress or outcome information for a Codex goal. This lets higher-level goal tracking enter the analytics stream.

**Data flow**: It receives a CodexGoalEvent, wraps it in a custom Goal fact, and passes it to record_fact.

**Call relations**: The track function calls this when a goal event is ready. This method does only the conversion into the common analytics fact format.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (track); 3 external calls (new, Custom, Goal).


##### `AnalyticsEventsClient::track_turn_resolved_config`  (lines 313–317)

```
fn track_turn_resolved_config(&self, fact: TurnResolvedConfigFact)
```

**Purpose**: Records the resolved configuration for a turn. This helps analytics connect behavior with the actual settings that were used.

**Data flow**: It receives a TurnResolvedConfigFact, boxes it, wraps it in a custom TurnResolvedConfig fact, and records it.

**Call relations**: No direct caller is shown in the graph, but turn setup code can use this to report the final configuration through record_fact.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, TurnResolvedConfig).


##### `AnalyticsEventsClient::track_turn_token_usage`  (lines 319–323)

```
fn track_turn_token_usage(&self, fact: TurnTokenUsageFact)
```

**Purpose**: Records token usage for a turn. Tokens are chunks of text counted by language models, so this helps measure how much model input and output a turn consumed.

**Data flow**: It receives a TurnTokenUsageFact, boxes it, wraps it as a TurnTokenUsage analytics fact, and sends it to record_fact.

**Call relations**: No direct caller is shown in the graph, but token accounting code can call this to feed usage data into the analytics queue.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, TurnTokenUsage).


##### `AnalyticsEventsClient::track_turn_profile`  (lines 325–329)

```
fn track_turn_profile(&self, fact: TurnProfileFact)
```

**Purpose**: Records profiling information for a turn. Profiling information describes timing or performance characteristics, useful for understanding where time is spent.

**Data flow**: It receives a TurnProfileFact, boxes it, wraps it in a custom TurnProfile fact, and records it.

**Call relations**: No specific caller is shown in the graph. Performance-measurement code can use this method to send turn profile facts through record_fact.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, TurnProfile).


##### `AnalyticsEventsClient::track_turn_codex_error`  (lines 331–335)

```
fn track_turn_codex_error(&self, fact: TurnCodexErrorFact)
```

**Purpose**: Records a Codex error that happened during a turn. This gives analytics a structured way to count and understand turn failures.

**Data flow**: It receives a TurnCodexErrorFact, boxes it, wraps it in a custom TurnCodexError fact, and records it.

**Call relations**: No specific caller is shown in the graph. Error-reporting code can use this method to enter the common analytics path.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Custom, TurnCodexError).


##### `AnalyticsEventsClient::track_plugin_installed`  (lines 337–344)

```
fn track_plugin_installed(&self, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records that a plugin was installed. This tracks a plugin state change from the user or system perspective.

**Data flow**: It receives plugin telemetry metadata. It combines the metadata with the Installed state, wraps that as a PluginStateChanged fact, and records it.

**Call relations**: remote_plugin_install_response calls this after a plugin install response. The method turns that result into a state-change fact for record_fact.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (remote_plugin_install_response); 2 external calls (Custom, PluginStateChanged).


##### `AnalyticsEventsClient::track_plugin_uninstalled`  (lines 346–353)

```
fn track_plugin_uninstalled(&self, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records that a plugin was uninstalled. This keeps analytics aware of plugin lifecycle changes.

**Data flow**: It receives plugin telemetry metadata. It marks the plugin state as Uninstalled, wraps that in a PluginStateChanged fact, and records it.

**Call relations**: No specific caller is shown in the graph, but plugin removal code can call this when uninstalling is complete.

*Call graph*: calls 1 internal fn (record_fact); 2 external calls (Custom, PluginStateChanged).


##### `AnalyticsEventsClient::track_plugin_enabled`  (lines 355–362)

```
fn track_plugin_enabled(&self, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records that a plugin was enabled. This is different from installing: the plugin may already exist but has just been turned on.

**Data flow**: It receives plugin telemetry metadata. It pairs that metadata with the Enabled state, wraps it in a PluginStateChanged fact, and records it.

**Call relations**: emit_plugin_toggle_events calls this when a plugin toggle turns on. It then passes the fact through record_fact.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (emit_plugin_toggle_events); 2 external calls (Custom, PluginStateChanged).


##### `AnalyticsEventsClient::track_plugin_disabled`  (lines 364–371)

```
fn track_plugin_disabled(&self, plugin: PluginTelemetryMetadata)
```

**Purpose**: Records that a plugin was disabled. This reports that an installed plugin has been turned off.

**Data flow**: It receives plugin telemetry metadata. It pairs it with the Disabled state, wraps it in a PluginStateChanged fact, and records it.

**Call relations**: emit_plugin_toggle_events calls this when a plugin toggle turns off. The fact then enters the normal queue through record_fact.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (emit_plugin_toggle_events); 2 external calls (Custom, PluginStateChanged).


##### `AnalyticsEventsClient::record_fact`  (lines 373–377)

```
fn record_fact(&self, input: AnalyticsFact)
```

**Purpose**: Is the shared final step for putting an analytics fact into the queue. If analytics is disabled, it quietly does nothing.

**Data flow**: It receives one AnalyticsFact. If the client has an active queue, it asks the queue to try sending it. If there is no queue, the fact is discarded locally.

**Call relations**: Almost every tracking method in this file calls record_fact after building the right fact. It hands the fact to AnalyticsEventsQueue::try_send, which starts the background delivery path.

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

**Purpose**: Records selected client responses that are important for thread and turn analytics. It filters out less relevant response types.

**Data flow**: It receives a connection id, request id, and response payload. If the response is one of the tracked thread or turn response types, it boxes the payload, wraps it in a ClientResponse fact, and records it. Otherwise it does nothing.

**Call relations**: No specific caller is shown in the graph. Response-tracking code can call this as traffic passes through, and this method keeps only the analytics-relevant responses.

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

**Purpose**: Records an error response for a client request. It can include both the raw JSON-RPC error and a more analytics-friendly error category.

**Data flow**: It receives a connection id, request id, JSON-RPC error, and optional analytics error type. It wraps these values in an ErrorResponse fact and records it.

**Call relations**: A function also named track_error_response in another part of the system calls this when an error response is produced. This method forwards the structured error into record_fact.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (track_error_response).


##### `AnalyticsEventsClient::track_server_request`  (lines 417–422)

```
fn track_server_request(&self, connection_id: u64, request: ServerRequest)
```

**Purpose**: Records a request sent from the server side. This helps connect server-driven work with later responses, cancellations, or outcomes.

**Data flow**: It receives a connection id and server request. It boxes the request, wraps it in a ServerRequest fact, and records it.

**Call relations**: send_request_to_connections calls this when server requests are sent to clients. The method converts the request into an analytics fact.

*Call graph*: calls 1 internal fn (record_fact); called by 1 (send_request_to_connections); 1 external calls (new).


##### `AnalyticsEventsClient::track_server_response`  (lines 424–429)

```
fn track_server_response(&self, completed_at_ms: u64, response: ServerResponse)
```

**Purpose**: Records a server response along with when it completed. This provides timing and result visibility for server-side request handling.

**Data flow**: It receives a completion timestamp and a server response. It boxes the response, wraps it in a ServerResponse fact, and records it.

**Call relations**: notify_client_response calls this when a response is ready to notify the client. This method sends the response information into record_fact.

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

**Purpose**: Records the response to an effective-permissions approval request. In plain terms, it captures what happened when permission was requested and answered.

**Data flow**: It receives a completion timestamp, request id, and permissions response. It boxes the response, wraps everything in an EffectivePermissionsApprovalResponse fact, and records it.

**Call relations**: No specific caller is shown in the graph. Permission approval code can use this to report the final response through the analytics pipeline.

*Call graph*: calls 1 internal fn (record_fact); 1 external calls (new).


##### `AnalyticsEventsClient::track_server_request_aborted`  (lines 444–449)

```
fn track_server_request_aborted(&self, completed_at_ms: u64, request_id: RequestId)
```

**Purpose**: Records that a server request was aborted rather than completed normally. This helps distinguish cancellations from successful or failed responses.

**Data flow**: It receives a completion timestamp and request id. It wraps them in a ServerRequestAborted fact and records it.

**Call relations**: Cancellation and error paths call this, including cancel_all_requests, cancel_request, cancel_requests_for_thread, and notify_client_error. It provides the analytics record for those abort paths.

*Call graph*: calls 1 internal fn (record_fact); called by 4 (cancel_all_requests, cancel_request, cancel_requests_for_thread, notify_client_error).


##### `AnalyticsEventsClient::track_notification`  (lines 451–465)

```
fn track_notification(&self, notification: ServerNotification)
```

**Purpose**: Records selected server notifications related to turns, items, diffs, and Guardian review. It filters out notifications that are not useful for this analytics stream.

**Data flow**: It receives one server notification. If it matches one of the tracked notification types, it boxes it, wraps it in a Notification fact, and records it. Otherwise it returns without recording anything.

**Call relations**: No specific caller is shown in the graph. Notification-forwarding code can call this for every notification, and this method keeps only the important ones.

*Call graph*: calls 1 internal fn (record_fact); 3 external calls (new, Notification, matches!).


##### `send_track_events`  (lines 468–487)

```
async fn send_track_events(
    auth_manager: &AuthManager,
    destination: &AnalyticsEventsDestination,
    events: Vec<TrackEventRequest>,
)
```

**Purpose**: Sends already-reduced analytics events, but only when there is something to send and the current authentication allows backend delivery.

**Data flow**: It receives the authentication manager, destination, and a list of event requests. It stops on an empty list, missing authentication, or an auth type that does not use the Codex backend. Otherwise it splits events into batches and sends each batch.

**Call relations**: The background task created by AnalyticsEventsQueue::new calls this after AnalyticsReducer produces TrackEventRequest values. It uses track_event_request_batches and then hands each batch to send_track_events_request.

*Call graph*: calls 3 internal fn (send_track_events_request, track_event_request_batches, auth); called by 1 (new).


##### `track_event_request_batches`  (lines 489–510)

```
fn track_event_request_batches(events: Vec<TrackEventRequest>) -> Vec<Vec<TrackEventRequest>>
```

**Purpose**: Splits analytics events into request-sized groups. Some events require their own isolated request, and this function keeps that rule intact.

**Data flow**: It receives a list of TrackEventRequest values. It walks through them in order, collecting ordinary events together while placing isolated events into one-event batches. It returns a list of batches to send.

**Call relations**: send_track_events calls this just before network delivery. The resulting batches are sent one by one with send_track_events_request.

*Call graph*: called by 1 (send_track_events); 2 external calls (new, vec!).


##### `send_track_events_request`  (lines 512–553)

```
async fn send_track_events_request(
    auth: &CodexAuth,
    destination: &AnalyticsEventsDestination,
    events: Vec<TrackEventRequest>,
)
```

**Purpose**: Sends one batch of analytics events to its destination. For normal runs this means an authenticated HTTP POST; in debug capture mode it writes to a file instead.

**Data flow**: It receives authentication, a destination, and a non-empty batch of events. It wraps the batch in a TrackEventsRequest. In debug capture mode it may append the payload to a file and stop. Otherwise it builds an HTTP request with auth headers and JSON content, sends it with a timeout, and logs failures.

**Call relations**: send_track_events calls this for each batch. In debug builds it may call capture_track_events_request; otherwise it uses create_client and auth headers to reach the analytics HTTP endpoint.

*Call graph*: calls 2 internal fn (capture_track_events_request, create_client); called by 1 (send_track_events); 2 external calls (auth_provider_from_auth, warn!).


##### `capture_track_events_request`  (lines 556–571)

```
fn capture_track_events_request(
    destination: &AnalyticsEventsDestination,
    payload: &TrackEventsRequest,
) -> bool
```

**Purpose**: Writes an analytics payload to a debug capture file instead of sending it to the network. It returns whether capture mode was used.

**Data flow**: It receives a destination and payload. If the destination is not a capture file, it returns false. If it is a capture file, it tries to append the payload, logs any write error, and returns true.

**Call relations**: send_track_events_request calls this in debug builds before attempting HTTP delivery. A true result tells the caller that the payload was captured locally and network delivery should not happen.

*Call graph*: calls 1 internal fn (append_payload); called by 1 (send_track_events_request); 1 external calls (error!).


### `app-server/src/analytics_utils.rs`

`util` · `startup and test setup`

This file solves a simple setup problem: the app needs an analytics client, but creating one requires a few pieces that live elsewhere. It needs the login/authentication manager, the base ChatGPT server address, and a setting that says whether analytics are enabled.

The helper in this file acts like a prepared recipe. Other startup code hands it the shared authentication manager and the loaded configuration. It then creates an `AnalyticsEventsClient`, which is the object responsible for sending analytics events. Before passing along the base URL, it removes any trailing slash from the configured address. That small cleanup matters because URLs can otherwise end up with doubled slashes when paths are added later, like `https://example.com//event`.

The file does not decide what events to send, and it does not send anything itself. Its job is narrower: make sure the analytics client is built consistently from the same app settings every time. Without this helper, several parts of the app would need to know the exact construction details, which makes mistakes and drift more likely.

#### Function details

##### `analytics_events_client_from_config`  (lines 7–16)

```
fn analytics_events_client_from_config(
    auth_manager: Arc<AuthManager>,
    config: &Config,
) -> AnalyticsEventsClient
```

**Purpose**: Builds an analytics event client using the app’s authentication manager and configuration. It is used when the server or tests need a ready-to-use object for sending analytics events.

**Data flow**: It receives a shared `AuthManager`, which holds login/authentication state, and a `Config`, which contains settings such as the ChatGPT base URL and whether analytics are enabled. It trims any trailing slash from the base URL, combines that cleaned URL with the authentication manager and analytics-enabled flag, and returns a new `AnalyticsEventsClient`. It does not change the configuration or authentication manager.

**Call relations**: During server startup and test setup, callers such as `start_uninitialized`, `build_test_processor`, and `run_main_with_transport_options` call this helper when they need analytics wiring. This function then hands the prepared inputs to `AnalyticsEventsClient::new`, which creates the actual client used later to report analytics events.

*Call graph*: calls 1 internal fn (new); called by 3 (start_uninitialized, build_test_processor, run_main_with_transport_options).


### Goal event adapters
This file adds goal-specific helpers that translate goal lifecycle changes into analytics payloads through the shared client.

### `ext/goal/src/analytics.rs`

`domain_logic` · `cross-cutting during goal operations`

A “goal” here is a tracked objective attached to a thread, with information such as its status, budget, tokens used, and time used. This file exists so the rest of the goal system does not have to know the exact details of analytics events. Other parts of the code can simply say “this goal was created” or “this goal changed status,” and this wrapper builds the right event.

The central type is `GoalAnalytics`, which holds an `AnalyticsEventsClient`. Think of it like a mailing clerk: the goal system hands it a real-world happening, and it fills out the correct analytics form before sending it away.

Most public methods are named after the event they report: `created`, `usage_accounted`, `status_changed`, and `cleared`. They all funnel into the private `track` method. `track` copies the important fields from the goal, adds optional turn information when the event belongs to a specific turn, and includes usage totals only for usage-accounting events. One important detail is that `status_changed` only reports an event if there really was a previous status and it differs from the current one. That prevents noisy analytics records when nothing actually changed.

#### Function details

##### `GoalAnalytics::new`  (lines 16–18)

```
fn new(client: AnalyticsEventsClient) -> Self
```

**Purpose**: Creates a `GoalAnalytics` helper around an analytics client. Code uses this when it wants a simple goal-focused way to report analytics events.

**Data flow**: It receives an `AnalyticsEventsClient`, stores it inside a new `GoalAnalytics` value, and returns that value. Nothing is sent yet; this only prepares the reporting tool for later use.

**Call relations**: During setup, `new_with_host_capabilities` calls this to attach analytics reporting to the goal subsystem. After that, the returned helper is used by goal-handling code whenever goal events need to be recorded.

*Call graph*: called by 1 (new_with_host_capabilities).


##### `GoalAnalytics::created`  (lines 20–26)

```
fn created(
        &self,
        goal: &codex_state::ThreadGoal,
        attribution: GoalEventAttribution<'_>,
    )
```

**Purpose**: Reports that a goal has just been created. It lets the analytics system count new goals and connect them to the thread or turn that produced them.

**Data flow**: It receives the goal and attribution information saying whether the event belongs to a specific turn. It labels the event as `Created` and passes everything to `track`, which builds and sends the final analytics event.

**Call relations**: When `handle_create` finishes creating a goal, it calls this method. This method does not send the event directly; it hands the common work to `track` so all goal analytics events are shaped consistently.

*Call graph*: calls 1 internal fn (track); called by 1 (handle_create).


##### `GoalAnalytics::usage_accounted`  (lines 28–34)

```
fn usage_accounted(
        &self,
        goal: &codex_state::ThreadGoal,
        attribution: GoalEventAttribution<'_>,
    )
```

**Purpose**: Reports that the system has counted resource usage against a goal. This is how analytics learns the cumulative token and time cost associated with that goal.

**Data flow**: It receives the current goal and attribution information. It marks the event as `UsageAccounted` and passes it to `track`; because of that event kind, `track` includes the goal’s accumulated token count and elapsed time in seconds.

**Call relations**: When `account_active_goal_progress` updates progress and usage for the active goal, it calls this method. The method then delegates to `track`, which sends the completed analytics record through the analytics client.

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

**Purpose**: Reports a goal status change, but only when the status actually changed. This avoids creating misleading analytics events for updates that leave the status the same.

**Data flow**: It receives the goal’s current state, an optional previous status, and attribution information. If there is a previous status and it is different from the goal’s current status, it passes a `StatusChanged` event to `track`; otherwise, it does nothing.

**Call relations**: `account_active_goal_progress` and `handle_update` call this after goal state may have changed. This function acts as a guard before handing off to `track`, so the analytics client only sees real status transitions.

*Call graph*: calls 1 internal fn (track); called by 2 (account_active_goal_progress, handle_update).


##### `GoalAnalytics::cleared`  (lines 47–49)

```
fn cleared(&self, goal: &codex_state::ThreadGoal)
```

**Purpose**: Reports that a goal has been cleared. A cleared event is not tied to a particular turn, so it is sent without turn attribution.

**Data flow**: It receives the goal being cleared, sets the attribution to `NoTurn`, labels the event as `Cleared`, and passes those details to `track`. The result is an analytics event with no turn id attached.

**Call relations**: This is the goal-analytics entry point for clear operations. Like the other event-specific methods, it relies on `track` to build the standard event record and send it through the analytics client.

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

**Purpose**: Builds the actual analytics event from a goal and sends it. This is the shared path that keeps all goal analytics records consistent.

**Data flow**: It receives a goal, optional turn attribution, and the kind of event being reported. It copies out the thread id, goal id, current status, whether there is a token budget, and possibly the turn id. If the event is `UsageAccounted`, it also includes cumulative tokens and time; for other event kinds those usage fields are left empty. It then calls the analytics client to record the completed event.

**Call relations**: `created`, `usage_accounted`, `status_changed`, and `cleared` all call this after deciding what kind of goal event happened. `track` is the final local step before handing the event to `track_goal_event`, which belongs to the analytics client and performs the actual reporting.

*Call graph*: calls 1 internal fn (track_goal_event); called by 4 (cleared, created, status_changed, usage_accounted).
