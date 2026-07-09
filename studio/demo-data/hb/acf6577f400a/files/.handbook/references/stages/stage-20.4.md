# Rollout trace recording, schema, and replay reducers  `stage-20.4`

This stage is cross-cutting execution infrastructure: it sits alongside the main rollout flow to record what happened, persist it as a trace bundle, and later replay that bundle into structured models for debugging, analysis, and UI reconstruction. `lib.rs` exposes that surface, while `bundle.rs`, `raw_event.rs`, and `writer.rs` define the bundle manifest, append-only event format, payload ordering rules, and filesystem writer that make traces durable and deterministic. `protocol_event.rs` narrows broader protocol traffic into the trace vocabulary, and `rollout/src/config.rs` provides the stable config view used by rollout code that enables or shapes tracing.

On the recording side, `thread.rs`, `inference.rs`, `compaction.rs`, `code_cell.rs`, `tool_dispatch.rs`, and `mcp.rs` provide scoped tracing contexts for sessions, threads, model calls, compaction attempts, code execution, tool dispatch, and MCP backend calls, including correlation IDs and no-op behavior when tracing is disabled. On replay, `model/mod.rs` and `model/conversation.rs` define the reduced in-memory schema, and `reducer/mod.rs` drives deterministic reconstruction. Specialized reducers rebuild conversation snapshots, inference lifecycles, compaction checkpoints, thread/turn structure, code cells, generic tool calls, multi-agent interactions, and terminal sessions into one coherent rollout trace graph.

## Files in this stage

### crate surface and schemas
These files define the public crate surface plus the raw, bundle, and reduced data schemas that both recording and replay rely on.

### `rollout-trace/src/bundle.rs`

`data_model` · `trace bundle creation and replay metadata handling`

This file is a compact data-model module for the rollout-trace bundle format. At the top it declares the canonical names used inside a bundle directory: `manifest.json` for the manifest itself, `trace.jsonl` for the raw event log, `payloads` for detached payload storage, and `state.json` for a reducer-written `RolloutTrace` cache. It also fixes separate schema-version constants for the manifest and reduced trace, both currently `1`, making version checks explicit rather than implicit in filenames.

The central type is `TraceBundleManifest`, a `Serialize`/`Deserialize` struct carrying the metadata needed to interpret a bundle root: `schema_version`, `trace_id`, `rollout_id`, `root_thread_id`, `started_at_unix_ms`, `raw_event_log`, and `payloads_dir`. The comment on `root_thread_id` captures an important invariant: replay must fail if the root thread is missing rather than inventing a placeholder, because reduced objects are scoped to that thread tree.

Its only behavior is the constructor `new`, which intentionally hardcodes the standard local layout by filling `schema_version` from `TRACE_MANIFEST_SCHEMA_VERSION` and setting `raw_event_log` and `payloads_dir` to the conventional constants. That keeps bundle writers consistent and avoids scattering literal filenames across the codebase.

#### Function details

##### `TraceBundleManifest::new`  (lines 33–48)

```
fn new(
        trace_id: String,
        rollout_id: String,
        root_thread_id: AgentThreadId,
        started_at_unix_ms: i64,
    ) -> Self
```

**Purpose**: Constructs a manifest for a newly created trace bundle using the standard local directory layout and current manifest schema version.

**Data flow**: It takes `trace_id: String`, `rollout_id: String`, `root_thread_id: AgentThreadId`, and `started_at_unix_ms: i64`, then returns `TraceBundleManifest` with `schema_version` set to `TRACE_MANIFEST_SCHEMA_VERSION`, the provided identifiers and timestamp copied through, `raw_event_log` set to `RAW_EVENT_LOG_FILE_NAME.to_string()`, and `payloads_dir` set to `PAYLOADS_DIR_NAME.to_string()`.

**Call relations**: Bundle-creation code calls this when materializing a new trace bundle manifest. The constructor encapsulates the file-layout convention so callers do not need to know the manifest's internal filename fields.

*Call graph*: called by 1 (create).


### `rollout-trace/src/lib.rs`

`orchestration` · `cross-cutting`

This crate root assembles the rollout-trace subsystem into a stable import surface. Internally, the crate is split into modules for bundle layout, code-cell tracing, compaction tracing, inference tracing, MCP correlation, reduced-model definitions, raw payload references, protocol and raw event schemas, replay/reduction, thread tracing, tool-dispatch tracing, and the append-only writer. This file keeps those implementation details private and re-exports the concrete types that other crates need.

The exported API is intentionally layered. Writer-facing code gets no-op-capable context handles such as `ThreadTraceContext`, `InferenceTraceContext`, `InferenceTraceAttempt`, `CodeCellTraceContext`, `CompactionTraceContext`, `CompactionTraceAttempt`, `McpCallTraceContext`, and `ToolDispatchTraceContext`, plus the `TraceWriter` itself. Replay and viewer code gets the reduced model via `model::*`, raw event and payload identifiers like `RawEventSeq`, `RawTraceEvent`, `RawTraceEventPayload`, `RawPayloadId`, `RawPayloadKind`, and `RawPayloadRef`, and the reducer entrypoint `replay_bundle`. Bundle-level conventions are surfaced through `REDUCED_STATE_FILE_NAME` and the environment variable constant `CODEX_ROLLOUT_TRACE_ROOT_ENV`.

The comments make an important design boundary explicit: this crate owns the trace schema, while semantic replay and projections remain outside hot-path Codex code. That keeps instrumentation dependencies small while preserving a single canonical trace format.


### `rollout-trace/src/model/conversation.rs`

`data_model` · `trace replay and viewer projection`

This file contains the transcript-centric portion of the reduced trace schema. Its central type, `ConversationItem`, represents one logical transcript row or structural boundary within a thread. Each item carries stable identity (`ConversationItemId`), owning thread, optional originating `CodexTurnId`, first-seen timestamp, normalized role and optional channel, item kind, optional `AgentMessageMetadata`, a structured `ConversationBody`, optional model-visible `call_id`, and a plural `produced_by` list of `ProducerRef` values. That last field is a key design choice: runtime causes are recorded as provenance only and are not allowed to rewrite the model-visible body.

The schema distinguishes roles (`System`, `Developer`, `User`, `Assistant`, `Tool`), channels (`Analysis`, `Commentary`, `Final`, `Summary`), and normalized item kinds such as message, reasoning, function/custom tool call and output, plus `CompactionMarker` for history replacement boundaries. `ConversationBody` is an ordered list of `ConversationPart` variants, covering plain text, summaries, opaque encoded blobs, JSON summarized by a `RawPayloadId`, code blocks, and lazy-loaded payload references. This lets replay preserve exact model-visible structure while avoiding inlining large payloads.

The file also defines `InferenceCall`, which links a single upstream model request/response pair to the reduced transcript. It stores execution timing, model/provider metadata, optional response and upstream request IDs, ordered request and response item IDs, tool calls started by the response, optional `TokenUsage`, and raw payload IDs for the full request and response bodies. Together these types form the semantic conversation graph that viewers and replay tools consume.


### `rollout-trace/src/model/mod.rs`

`data_model` · `replay/reduction and serialized artifact representation`

This module is primarily schema definition. It introduces the string-based identifier aliases used throughout the reduced trace graph, including `AgentThreadId`, `CodexTurnId`, `InferenceCallId`, `McpCallId`, `CodeCellId`, `CompactionId`, and several reducer-owned edge and operation ids. It then re-exports the concrete model types from the `conversation`, `runtime`, and `session` submodules so consumers can import the whole reduced schema from one place.

The central type is `RolloutTrace`, a `Serialize`/`Deserialize` struct representing one replayable rollout artifact. Its fields separate product/session identity (`trace_id`, `rollout_id`, `root_thread_id`) from lifecycle timing (`started_at_unix_ms`, optional `ended_at_unix_ms`, `status`) and from the reduced graph itself. The graph is stored in `BTreeMap`s keyed by stable ids for threads, turns, conversation items, inference calls, code cells, tool calls, terminal sessions and operations, compactions and compaction requests, interaction edges, and raw payload references. Using `BTreeMap` gives deterministic ordering in serialized output and replay.

`RolloutTrace::new` is the only behavior here: it constructs an empty trace in `Running` state with all maps initialized and `ended_at_unix_ms` unset. The reducer then incrementally fills these collections as it processes raw events.

#### Function details

##### `RolloutTrace::new`  (lines 94–122)

```
fn new(
        schema_version: u32,
        trace_id: String,
        rollout_id: String,
        root_thread_id: AgentThreadId,
        started_at_unix_ms: i64,
    ) -> Self
```

**Purpose**: Constructs an empty reduced trace object ready for the reducer to populate. It establishes the initial rollout identity and marks the rollout as still running.

**Data flow**: Consumes `schema_version`, `trace_id`, `rollout_id`, `root_thread_id`, and `started_at_unix_ms`; stores them directly, sets `ended_at_unix_ms` to `None`, sets `status` to `RolloutStatus::Running`, and initializes every graph collection field as an empty `BTreeMap`. Returns the fully initialized `RolloutTrace`.

**Call relations**: It is called by `replay_bundle` at the start of reduction, providing the empty accumulator into which replayed threads, turns, calls, payloads, and edges are inserted.

*Call graph*: called by 1 (replay_bundle); 1 external calls (new).


### `rollout-trace/src/raw_event.rs`

`data_model` · `cross-cutting raw trace writing and validation`

This module is the low-level schema for raw rollout traces. `RawTraceEvent` is the common envelope written to the append-only log: it carries a schema version, monotonic sequence number, wall-clock timestamp, rollout id, optional thread and turn context, and a typed `RawTraceEventPayload`. `RawTraceEventContext` is the smaller writer-supplied subset used when appending events. The file also defines `RawToolCallRequester`, which distinguishes model-originated tool calls from those issued by a runtime code cell using runtime-local identifiers.

The large `RawTraceEventPayload` enum enumerates every raw event shape currently emitted by the tracing system: rollout/thread/turn lifecycle, inference start/completion/failure/cancellation, tool-call lifecycle and MCP correlation, code-cell lifecycle, compaction attempts and installation, agent-result delivery, wrapped protocol events, and a generic `Other` escape hatch. Many variants carry `RawPayloadRef` fields pointing to separately stored JSON payloads rather than embedding large data inline.

`raw_payload_refs` is the key behavioral helper. It pattern-matches every payload variant and returns the exact set of referenced `RawPayloadRef`s that must already exist before the event is appended. Variants with no payloads return an empty vector; optional payload fields are converted with `.iter().collect()` so absent payloads naturally disappear; multi-payload variants like `Other` return all refs. This function encodes an important invariant for trace integrity: event records may refer only to payloads that have already been persisted.

#### Function details

##### `RawTraceEventPayload::raw_payload_refs`  (lines 236–311)

```
fn raw_payload_refs(&self) -> Vec<&RawPayloadRef>
```

**Purpose**: Returns the list of raw payload references that a given raw event payload depends on. It is used to enforce that referenced payload blobs exist before the event itself is appended or replayed.

**Data flow**: Matches on `self` across all `RawTraceEventPayload` variants. Variants with no payload-bearing fields return `Vec::new()`. Variants with one required payload return `vec![payload_ref]`. Variants with optional payloads use `.iter().collect()` so `None` yields an empty vector and `Some(ref)` yields a one-element vector. `Other` returns `payloads.iter().collect()`. The function reads only the enum fields and returns a new `Vec<&RawPayloadRef>`.

**Call relations**: This helper is part of the raw-event schema itself and is consumed by writer or replay logic that needs to validate payload/event ordering and completeness.

*Call graph*: 2 external calls (new, vec!).


### `rollout/src/config.rs`

`config` · `config access and config snapshotting during rollout subsystem initialization`

This file is intentionally minimal and type-focused. The `RolloutConfigView` trait exposes five getters required by the rollout subsystem: `codex_home`, `sqlite_home`, `cwd`, `model_provider_id`, and `generate_memories`. The concrete `RolloutConfig` struct stores those values as owned `PathBuf`s, a `String`, and a `bool`, and derives `Clone`, `Debug`, `PartialEq`, and `Eq`. `pub type Config = RolloutConfig` provides a compatibility alias.

`RolloutConfig::from_view` is the only constructor-like behavior: it snapshots any `RolloutConfigView` into an owned `RolloutConfig` by cloning paths and strings and copying the boolean. The rest of the file is trait plumbing. `RolloutConfig` implements `RolloutConfigView` directly by returning borrowed views into its fields. Blanket implementations for `&T` and `Arc<T>` forward each getter to the underlying `T: RolloutConfigView + ?Sized`, allowing callers to pass borrowed or shared config objects without additional adapters.

The main design choice is that this file avoids embedding any loading or validation logic. It exists purely to define the configuration contract and make ownership flexible at API boundaries.

#### Function details

##### `RolloutConfig::from_view`  (lines 25–33)

```
fn from_view(view: &impl RolloutConfigView) -> Self
```

**Purpose**: Builds an owned `RolloutConfig` by copying values out of any `RolloutConfigView`. It is the snapshotting adapter from abstract config providers to the concrete config struct.

**Data flow**: Accepts `&impl RolloutConfigView`, reads `codex_home`, `sqlite_home`, and `cwd` and clones them into `PathBuf`s, clones `model_provider_id` into a `String`, copies `generate_memories`, and returns the assembled `RolloutConfig`.

**Call relations**: Called during rollout initialization paths that want to decouple long-lived rollout state from the lifetime or ownership model of the original config source.

*Call graph*: called by 2 (init, try_init); 5 external calls (codex_home, cwd, generate_memories, model_provider_id, sqlite_home).


##### `RolloutConfig::codex_home`  (lines 37–39)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Returns the configured Codex home directory as a `&Path`. It exposes the owned `PathBuf` through the trait interface.

**Data flow**: Borrows `self` and returns `self.codex_home.as_path()`.

**Call relations**: Used wherever rollout code needs the root home directory from a concrete `RolloutConfig`.

*Call graph*: 1 external calls (as_path).


##### `RolloutConfig::sqlite_home`  (lines 41–43)

```
fn sqlite_home(&self) -> &Path
```

**Purpose**: Returns the configured SQLite home directory as a `&Path`. It is the concrete getter for the trait.

**Data flow**: Borrows `self` and returns `self.sqlite_home.as_path()`.

**Call relations**: Used by rollout code that needs database-related filesystem roots from a concrete config.

*Call graph*: 1 external calls (as_path).


##### `RolloutConfig::cwd`  (lines 45–47)

```
fn cwd(&self) -> &Path
```

**Purpose**: Returns the configured working directory as a `&Path`. It exposes the rollout session's cwd through the trait.

**Data flow**: Borrows `self` and returns `self.cwd.as_path()`.

**Call relations**: Used by rollout code that needs the session cwd from a concrete `RolloutConfig`.

*Call graph*: 1 external calls (as_path).


##### `RolloutConfig::model_provider_id`  (lines 49–51)

```
fn model_provider_id(&self) -> &str
```

**Purpose**: Returns the configured default model provider identifier as `&str`. It is the concrete string getter for the trait.

**Data flow**: Borrows `self` and returns `self.model_provider_id.as_str()`.

**Call relations**: Used by rollout code that needs the default provider name from a concrete config.


##### `RolloutConfig::generate_memories`  (lines 53–55)

```
fn generate_memories(&self) -> bool
```

**Purpose**: Returns whether rollout processing should generate memories. It is the concrete boolean getter for the trait.

**Data flow**: Borrows `self` and returns `self.generate_memories`.

**Call relations**: Used by rollout logic that conditionally enables memory generation based on config.


##### `T::codex_home`  (lines 59–61)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Forwards `RolloutConfigView::codex_home` through a shared reference to another config view. It lets `&T` satisfy the trait without manual dereferencing by callers.

**Data flow**: Borrows `&&T`, dereferences to `*self`, calls `codex_home()` on the underlying `T`, and returns the resulting `&Path`.

**Call relations**: Part of the blanket `impl RolloutConfigView for &T`; used implicitly whenever APIs receive borrowed config views.


##### `T::sqlite_home`  (lines 63–65)

```
fn sqlite_home(&self) -> &Path
```

**Purpose**: Forwards `sqlite_home` through a shared reference wrapper. It preserves the same trait interface for `&T`.

**Data flow**: Borrows `&&T`, dereferences, calls `sqlite_home()` on the underlying config view, and returns `&Path`.

**Call relations**: Used implicitly via the blanket reference implementation of `RolloutConfigView`.


##### `T::cwd`  (lines 67–69)

```
fn cwd(&self) -> &Path
```

**Purpose**: Forwards `cwd` through a shared reference wrapper. This avoids requiring owned config values at call sites.

**Data flow**: Borrows `&&T`, dereferences, calls `cwd()` on the underlying config view, and returns `&Path`.

**Call relations**: Used implicitly when rollout APIs are passed `&T` where `T: RolloutConfigView`.


##### `T::model_provider_id`  (lines 71–73)

```
fn model_provider_id(&self) -> &str
```

**Purpose**: Forwards `model_provider_id` through a shared reference wrapper. It preserves trait usability for borrowed config objects.

**Data flow**: Borrows `&&T`, dereferences, calls `model_provider_id()` on the underlying config view, and returns `&str`.

**Call relations**: Part of the blanket reference implementation used implicitly by config-consuming APIs.


##### `T::generate_memories`  (lines 75–77)

```
fn generate_memories(&self) -> bool
```

**Purpose**: Forwards `generate_memories` through a shared reference wrapper. It keeps the boolean getter available on `&T`.

**Data flow**: Borrows `&&T`, dereferences, calls `generate_memories()` on the underlying config view, and returns `bool`.

**Call relations**: Used implicitly via the blanket `RolloutConfigView for &T` implementation.


##### `Arc::codex_home`  (lines 81–83)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Forwards `codex_home` through an `Arc<T>` wrapper. This allows shared config objects to satisfy `RolloutConfigView` directly.

**Data flow**: Borrows `&Arc<T>`, calls `self.as_ref().codex_home()`, and returns `&Path` from the underlying config view.

**Call relations**: Used implicitly when rollout APIs receive `Arc<T>` config objects.


##### `Arc::sqlite_home`  (lines 85–87)

```
fn sqlite_home(&self) -> &Path
```

**Purpose**: Forwards `sqlite_home` through an `Arc<T>` wrapper. It preserves the trait interface for shared ownership.

**Data flow**: Borrows `&Arc<T>`, calls `self.as_ref().sqlite_home()`, and returns `&Path`.

**Call relations**: Part of the blanket `RolloutConfigView for Arc<T>` implementation.


##### `Arc::cwd`  (lines 89–91)

```
fn cwd(&self) -> &Path
```

**Purpose**: Forwards `cwd` through an `Arc<T>` wrapper. This avoids forcing callers to unwrap shared config state.

**Data flow**: Borrows `&Arc<T>`, calls `self.as_ref().cwd()`, and returns `&Path`.

**Call relations**: Used implicitly by config-consuming rollout code when config is shared via `Arc`.


##### `Arc::model_provider_id`  (lines 93–95)

```
fn model_provider_id(&self) -> &str
```

**Purpose**: Forwards `model_provider_id` through an `Arc<T>` wrapper. It keeps the string getter available on shared config values.

**Data flow**: Borrows `&Arc<T>`, calls `self.as_ref().model_provider_id()`, and returns `&str`.

**Call relations**: Part of the blanket `Arc<T>` trait implementation used implicitly at API boundaries.


##### `Arc::generate_memories`  (lines 97–99)

```
fn generate_memories(&self) -> bool
```

**Purpose**: Forwards `generate_memories` through an `Arc<T>` wrapper. It preserves the boolean getter for shared config ownership.

**Data flow**: Borrows `&Arc<T>`, calls `self.as_ref().generate_memories()`, and returns `bool`.

**Call relations**: Used implicitly whenever rollout code reads config through an `Arc<dyn RolloutConfigView>` or similar shared wrapper.


### trace writing backbone
These files provide the low-level event translation and persistence machinery used by higher-level tracing contexts to serialize payloads and append raw events.

### `rollout-trace/src/protocol_event.rs`

`domain_logic` · `protocol event ingestion during session/turn/tool tracing`

This module is the bridge between the broad Codex protocol surface and the narrower rollout trace schema. `codex_turn_trace_event` recognizes only turn lifecycle messages: `TurnStarted` becomes `RawTraceEventPayload::CodexTurnStarted`, `TurnComplete` becomes `CodexTurnEnded` with `ExecutionStatus::Completed`, and `TurnAborted` becomes `CodexTurnEnded` with status derived from `execution_status_for_abort_reason`. For aborted turns without an explicit turn id, it falls back to the caller-supplied `default_turn_id`.

Tool-runtime mapping is more extensive. `ToolRuntimeTraceEvent` distinguishes `Started` and `Ended` observations, each carrying a borrowed `tool_call_id` and a `ToolRuntimePayload<'a>`. That payload enum wraps the original protocol event structs by reference and implements `Serialize` by delegating directly to the wrapped event, preserving exact protocol JSON without cloning into an intermediate `Value`. `tool_runtime_trace_event` explicitly matches many `EventMsg` variants, converting only runtime-boundary events such as exec commands, patch apply, MCP tool calls, collaboration lifecycle events, and `SubAgentActivity`. Notably, `ExecCommandBegin/End` events from `ExecCommandSource::UserShell` are excluded, and several end statuses are inferred from protocol-specific fields like `result.is_ok()` or `new_thread_id.is_some()`.

`wrapped_protocol_event_type` separately classifies a small set of generic protocol events that should be wrapped as opaque observed events rather than mapped into dedicated runtime boundaries. Two trait impls map `ExecCommandStatus` and `PatchApplyStatus` into reduced `ExecutionStatus`, and `execution_status_for_abort_reason` collapses all current abort reasons into `Cancelled`.

#### Function details

##### `codex_turn_trace_event`  (lines 38–79)

```
fn codex_turn_trace_event(
    thread_id: AgentThreadId,
    default_turn_id: &str,
    event: &EventMsg,
) -> Option<CodexTurnTraceEvent>
```

**Purpose**: Maps turn lifecycle protocol events into raw trace turn events with the correct context turn id. It handles started, completed, and aborted turns while ignoring all other protocol messages.

**Data flow**: Accepts the enclosing `thread_id`, a `default_turn_id`, and an `&EventMsg`. For `TurnStarted`, it clones `event.turn_id` into both `context_turn_id` and `RawTraceEventPayload::CodexTurnStarted`. For `TurnComplete`, it emits `CodexTurnEnded` with `ExecutionStatus::Completed`. For `TurnAborted`, it uses `event.turn_id` if present or `default_turn_id.to_string()` otherwise, computes status via `execution_status_for_abort_reason`, and emits `CodexTurnEnded`. All other variants return `None`.

**Call relations**: It is called by `record_codex_turn_event` when protocol events arrive. It delegates abort-status mapping to `execution_status_for_abort_reason`.

*Call graph*: calls 1 internal fn (execution_status_for_abort_reason); called by 1 (record_codex_turn_event).


##### `ToolRuntimePayload::serialize`  (lines 118–139)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes a borrowed wrapped protocol event using that event type's own `Serialize` implementation. This preserves the exact protocol payload shape in trace payloads without cloning or converting through `serde_json::Value` first.

**Data flow**: Matches on `self` across all `ToolRuntimePayload` variants and forwards `serializer` to the wrapped event's `serialize` method. It returns the serializer result and does not mutate state.

**Call relations**: This implementation is used whenever a `ToolRuntimePayload` is written into a raw payload by higher-level tracing code, making the wrapper enum transparent at serialization time.


##### `tool_runtime_trace_event`  (lines 142–290)

```
fn tool_runtime_trace_event(event: &EventMsg) -> Option<ToolRuntimeTraceEvent<'_>>
```

**Purpose**: Recognizes protocol events that correspond to concrete tool runtime boundaries and converts them into `Started` or `Ended` trace observations. It also computes reduced execution status for terminal events based on protocol-specific semantics.

**Data flow**: Accepts `&EventMsg` and pattern-matches exhaustively. It returns `Some(ToolRuntimeTraceEvent::Started { ... })` for begin events such as non-`UserShell` exec commands, patch apply begin, MCP begin, and collaboration begin variants. It returns `Some(...Ended { status, payload })` for matching end events, deriving `status` via `trace_execution_status()`, `result.is_ok()`, `new_thread_id.is_some()`, or fixed `ExecutionStatus::Completed` depending on the variant. All explicitly listed non-runtime or unsupported variants return `None`.

**Call relations**: It is called by `record_tool_call_event` to decide whether an incoming protocol event should produce a tool runtime trace event. It relies on the `TraceExecutionStatus` trait impls for exec and patch statuses.

*Call graph*: called by 1 (record_tool_call_event); 15 external calls (CollabAgentInteractionBegin, CollabAgentInteractionEnd, CollabAgentSpawnBegin, CollabAgentSpawnEnd, CollabCloseBegin, CollabCloseEnd, CollabWaitingBegin, CollabWaitingEnd, ExecCommandBegin, ExecCommandEnd (+5 more)).


##### `wrapped_protocol_event_type`  (lines 292–371)

```
fn wrapped_protocol_event_type(event: &EventMsg) -> Option<&'static str>
```

**Purpose**: Classifies a small subset of protocol events by stable string type names for generic wrapping into trace events. It intentionally returns `None` for most protocol variants that either have dedicated trace mappings or are not traced.

**Data flow**: Matches on `&EventMsg` and returns `Some(&'static str)` for `SessionConfigured`, `TurnStarted`, `TurnComplete`, `TurnAborted`, `ThreadRolledBack`, `Error`, `Warning`, and `ShutdownComplete`. Every other listed variant returns `None`.

**Call relations**: It is used by `record_protocol_event` when deciding whether to wrap an observed protocol event into `RawTraceEventPayload::ProtocolEventObserved` rather than mapping it through a dedicated trace-specific path.

*Call graph*: called by 1 (record_protocol_event).


##### `ExecCommandStatus::trace_execution_status`  (lines 378–384)

```
fn trace_execution_status(&self) -> ExecutionStatus
```

**Purpose**: Converts protocol exec-command terminal status into the reduced trace execution status enum. It preserves the distinction between completion, failure, and user decline.

**Data flow**: Matches `self`: `Completed` maps to `ExecutionStatus::Completed`, `Failed` to `ExecutionStatus::Failed`, and `Declined` to `ExecutionStatus::Cancelled`. Returns the mapped status.

**Call relations**: This trait method is used by `tool_runtime_trace_event` when translating `ExecCommandEnd` events into terminal tool-runtime trace events.


##### `PatchApplyStatus::trace_execution_status`  (lines 388–394)

```
fn trace_execution_status(&self) -> ExecutionStatus
```

**Purpose**: Converts protocol patch-apply terminal status into the reduced trace execution status enum. It treats declined patch application as cancellation rather than failure.

**Data flow**: Matches `self`: `Completed` becomes `ExecutionStatus::Completed`, `Failed` becomes `ExecutionStatus::Failed`, and `Declined` becomes `ExecutionStatus::Cancelled`. Returns the mapped value.

**Call relations**: This trait method is used by `tool_runtime_trace_event` when translating `PatchApplyEnd` events.


##### `execution_status_for_abort_reason`  (lines 397–404)

```
fn execution_status_for_abort_reason(reason: &TurnAbortReason) -> ExecutionStatus
```

**Purpose**: Maps turn abort reasons into the reduced execution status used by `CodexTurnEnded`. All currently supported abort reasons collapse to cancellation.

**Data flow**: Matches `&TurnAbortReason`; `Interrupted`, `Replaced`, `ReviewEnded`, and `BudgetLimited` all return `ExecutionStatus::Cancelled`.

**Call relations**: It is called only by `codex_turn_trace_event` when converting `TurnAborted` protocol events into raw trace turn-end events.

*Call graph*: called by 1 (codex_turn_trace_event).


### `rollout-trace/src/writer.rs`

`io_transport` · `whenever trace bundles are created or raw events/payloads are written to disk`

The central type here is `TraceWriter`, which wraps a `Mutex<TraceWriterInner>`. The inner state holds the immutable `TraceBundleManifest`, the payloads directory path, a buffered append-only event log file, and monotonically increasing counters for event sequence numbers and payload ordinals. `create` initializes a bundle directory, creates the `payloads/` subdirectory, writes the manifest JSON, opens `trace.jsonl` in append mode, and seeds counters at 1.

Two write paths are exposed. `write_json_payload` allocates the next payload ordinal, writes a pretty-printed JSON file under `payloads/{ordinal}.json`, and returns a `RawPayloadRef` containing a stable `raw_payload:{ordinal}` id, payload kind, and relative path. `append_with_context` allocates the next event sequence number, stamps the event with schema version, current wall-clock milliseconds, rollout id from the manifest, optional thread/turn context, and the supplied payload, then writes one JSON line and flushes immediately. `append` is just the context-free convenience wrapper.

The writer deliberately tolerates poisoned mutexes by recovering the inner state with `PoisonError::into_inner`; the comment explains that losing later diagnostic events after a panic would be worse than continuing. Another important invariant is payload-before-event ordering: payload files are written before the event that references them, so interrupted replays never see dangling payload references.

#### Function details

##### `TraceWriter::create`  (lines 51–83)

```
fn create(
        bundle_dir: impl AsRef<Path>,
        trace_id: String,
        rollout_id: String,
        root_thread_id: AgentThreadId,
    ) -> Result<Self>
```

**Purpose**: Creates a new trace bundle on disk, writes its manifest, opens the raw event log, and initializes sequence counters. It is the one-time setup entrypoint for bundle writing.

**Data flow**: Accepts a bundle directory path, `trace_id`, `rollout_id`, and `root_thread_id`. It creates `payloads/`, computes `started_at_unix_ms` via `unix_time_ms`, builds `TraceBundleManifest::new(...)`, writes it with `write_json_file`, opens `trace.jsonl` in create+append mode, and returns `TraceWriter { inner: Mutex::new(TraceWriterInner { manifest, payloads_dir, event_log: BufWriter::new(file), next_seq: 1, next_payload_ordinal: 1 }) }`.

**Call relations**: Called by root trace startup and various tests/helpers that need a started writer. It delegates timestamp generation to `unix_time_ms` and JSON file emission to `write_json_file`.

*Call graph*: calls 3 internal fn (new, unix_time_ms, write_json_file); called by 8 (started_inference_attempt, responses_websocket_request_prewarm_traces_logical_request, enabled_attempt_adds_inference_request_header, enabled_context_records_replayable_inference_attempt, create_started_writer_for_thread, child_thread_metadata_creates_spawn_origin_without_delivery_edge, start_root_in_root, writer_records_payload_refs_and_replays_rollout_status); 6 external calls (as_ref, join, new, new, new, create_dir_all).


##### `TraceWriter::write_json_payload`  (lines 86–106)

```
fn write_json_payload(
        &self,
        kind: RawPayloadKind,
        value: &impl Serialize,
    ) -> Result<RawPayloadRef>
```

**Purpose**: Writes one payload body into the bundle's payload directory and returns the reference object used by raw events. It guarantees the payload file exists before any event points at it.

**Data flow**: Accepts a `RawPayloadKind` and serializable value. It locks the inner state, reads and increments `next_payload_ordinal`, derives `raw_payload_id`, relative path `payloads/{ordinal}.json`, and absolute path under `payloads_dir`, writes the JSON file with `write_json_file`, and returns `RawPayloadRef { raw_payload_id, kind, path: relative_path }`.

**Call relations**: Used by higher-level best-effort helpers across thread, inference, compaction, and tool-dispatch tracing. It depends on `lock_inner` for synchronized ordinal allocation and `write_json_file` for actual serialization.

*Call graph*: calls 2 internal fn (lock_inner, write_json_file); called by 9 (write_json_payload_best_effort, write_json_payload_best_effort, write_json_payload_best_effort, append_completed_inference, append_inference_request, append_spawn_agent_tool_lifecycle, append_followup_with_tool_output, append_inference_with_tool_call, write_json_payload_best_effort); 1 external calls (format!).


##### `TraceWriter::append`  (lines 109–111)

```
fn append(&self, payload: RawTraceEventPayload) -> Result<RawTraceEvent>
```

**Purpose**: Appends a raw event without explicit thread/turn context. It is a convenience wrapper for context-free events like rollout start/end.

**Data flow**: Accepts a `RawTraceEventPayload`, constructs `RawTraceEventContext::default()`, and forwards both to `append_with_context`. It returns the resulting `RawTraceEvent` or any I/O/serialization error.

**Call relations**: Called by higher-level tracing code for events that do not need contextual envelope fields. It delegates all real work to `append_with_context`.

*Call graph*: calls 1 internal fn (append_with_context); called by 6 (append_inference_completion, append_inference_start_for_thread, start_thread, start_turn_for_thread, append_followup_with_tool_output, append_inference_with_tool_call); 1 external calls (default).


##### `TraceWriter::append_with_context`  (lines 114–134)

```
fn append_with_context(
        &self,
        context: RawTraceEventContext,
        payload: RawTraceEventPayload,
    ) -> Result<RawTraceEvent>
```

**Purpose**: Appends one fully formed raw trace event line with optional thread and turn context. It assigns sequence number, timestamp, and rollout id at write time.

**Data flow**: Accepts `RawTraceEventContext` and `RawTraceEventPayload`. It locks the inner state, builds `RawTraceEvent { schema_version, seq: inner.next_seq, wall_time_unix_ms: unix_time_ms(), rollout_id: inner.manifest.rollout_id.clone(), thread_id: context.thread_id, codex_turn_id: context.codex_turn_id, payload }`, increments `next_seq`, writes the event as JSON to `event_log`, appends a newline, flushes, and returns the event.

**Call relations**: Used directly by contextual trace helpers and indirectly by `append`. It relies on `lock_inner` for serialized sequence assignment and `unix_time_ms` for wall-clock stamping.

*Call graph*: calls 2 internal fn (lock_inner, unix_time_ms); called by 3 (append_completed_inference, append_spawn_agent_tool_lifecycle, append); 1 external calls (to_writer).


##### `TraceWriter::lock_inner`  (lines 136–141)

```
fn lock_inner(&self) -> MutexGuard<'_, TraceWriterInner>
```

**Purpose**: Obtains mutable access to the writer's inner state while recovering from mutex poisoning. This preserves trace logging after panics in tracing code.

**Data flow**: Locks `self.inner` and returns `MutexGuard<'_, TraceWriterInner>`. If the mutex is poisoned, it calls `PoisonError::into_inner` to recover the guard instead of panicking.

**Call relations**: Used internally by both payload and event append paths. It is the synchronization point that protects sequence counters and buffered file handles.

*Call graph*: called by 2 (append_with_context, write_json_payload).


##### `write_json_file`  (lines 144–148)

```
fn write_json_file(path: &Path, value: &impl Serialize) -> Result<()>
```

**Purpose**: Serializes a value as pretty-printed JSON into a newly created file. It is the shared helper for manifest and payload file creation.

**Data flow**: Accepts a target `&Path` and serializable value, creates the file with `File::create`, writes JSON via `serde_json::to_writer_pretty`, and wraps filesystem/serialization failures with path-specific context.

**Call relations**: Called by `TraceWriter::create` for the manifest and by `TraceWriter::write_json_payload` for payload bodies.

*Call graph*: called by 2 (create, write_json_payload); 2 external calls (create, to_writer_pretty).


##### `unix_time_ms`  (lines 150–155)

```
fn unix_time_ms() -> i64
```

**Purpose**: Returns the current wall-clock time in Unix milliseconds, saturating safely on clock anomalies or integer overflow. It standardizes timestamps used in manifests and raw events.

**Data flow**: Reads `SystemTime::now()`, computes duration since `UNIX_EPOCH` with `unwrap_or_default()` on backward-clock errors, converts `as_millis()` to `i64` with `try_from`, and returns `i64::MAX` on overflow.

**Call relations**: Used by both bundle creation and event append paths so all on-disk timestamps share the same conversion behavior.

*Call graph*: called by 2 (append_with_context, create); 2 external calls (now, try_from).


##### `tests::writer_records_payload_refs_and_replays_rollout_status`  (lines 171–264)

```
fn writer_records_payload_refs_and_replays_rollout_status() -> anyhow::Result<()>
```

**Purpose**: Validates that the writer produces a replayable bundle with correct payload references, rollout status, thread/turn state, and payload-path bookkeeping. It is an end-to-end test of manifest, payload, and event writing.

**Data flow**: Creates a temp bundle with `TraceWriter::create`, appends rollout/thread/turn/inference lifecycle events, writes protocol and inference payload files, replays the bundle with `replay_bundle`, and asserts reduced rollout status, root thread id, turn execution status, inference payload ids, and payload path `payloads/1.json`.

**Call relations**: This test drives the public writer API directly, proving that payload refs and event ordering are sufficient for the reducer to reconstruct rollout state.

*Call graph*: calls 1 internal fn (create); 4 external calls (new, assert_eq!, replay_bundle, json!).


### recording contexts
These files expose the runtime-facing tracing APIs for threads and their specialized child activities such as inference, compaction, code cells, MCP calls, and tool dispatch.

### `rollout-trace/src/thread.rs`

`domain_logic` · `session startup, per-thread execution, and thread/turn/tool runtime event recording`

This file defines the no-op-capable `ThreadTraceContext`, which wraps either a disabled state or an `EnabledThreadTraceContext` containing an `Arc<TraceWriter>`, the rollout's `root_thread_id`, and the current `thread_id`. It also defines the serialized startup payload `ThreadStartedTraceMetadata` and the child-result payload `AgentResultTracePayload`. Root tracing is enabled only when `CODEX_ROLLOUT_TRACE_ROOT` is present; startup is explicitly best-effort, with failures downgraded to warnings and a disabled context so diagnostics never break production sessions.

The main control flow is: create a root bundle directory and `TraceWriter`, append `RolloutStarted`, then append `ThreadStarted` with an optional raw metadata payload file. From there, the context can emit thread end events, wrap selected protocol events as raw breadcrumbs, derive typed Codex-turn and tool-runtime events from protocol messages, and create specialized sub-contexts for code cells, tool dispatch, inference, compaction, and MCP correlation. Every write path has a disabled fast path and an enabled best-effort path that logs warnings instead of propagating errors.

A notable invariant is that child threads share the root bundle writer but must get their own `ThreadStarted` event exactly once; resumed children should therefore use `disabled()` rather than inheriting the parent trace. Another subtlety is that only the root thread emits `RolloutEnded`; child `record_ended` calls update thread execution state without closing the whole rollout.

#### Function details

##### `ThreadTraceContext::disabled`  (lines 95–99)

```
fn disabled() -> Self
```

**Purpose**: Constructs a trace handle in the `Disabled` state. All later trace calls become cheap no-ops through this handle.

**Data flow**: Takes no arguments and creates `ThreadTraceContext { state: ThreadTraceContextState::Disabled }`. It reads no external state, writes nothing, and returns the inert context.

**Call relations**: Used by production and test setup paths whenever tracing is unavailable, intentionally suppressed, or should not be inherited. Callers then invoke normal trace methods without branching because those methods all early-return on the disabled state.

*Call graph*: called by 9 (run_codex_thread_interactive, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, parent_rollout_thread_trace_for_source, disabled_thread_context_accepts_trace_calls_without_writing).


##### `ThreadTraceContext::start_root_or_disabled`  (lines 106–118)

```
fn start_root_or_disabled(metadata: ThreadStartedTraceMetadata) -> Self
```

**Purpose**: Attempts to start a root rollout trace bundle from the `CODEX_ROLLOUT_TRACE_ROOT` environment variable, falling back to a disabled context on absence or initialization failure. This keeps trace startup optional and non-fatal.

**Data flow**: Consumes `ThreadStartedTraceMetadata`, reads the process environment via `std::env::var_os`, converts the configured root into a `PathBuf`, and invokes `start_root_in_root`. On success it returns the enabled root context; on missing env var or any error it logs a warning and returns `ThreadTraceContext::disabled()`.

**Call relations**: Invoked by higher-level session construction when a new root session starts. It delegates bundle creation and initial event emission to `start_root_in_root`, and only handles the policy decision of enable-vs-disable.

*Call graph*: calls 1 internal fn (start_root_in_root); called by 1 (new); 4 external calls (from, disabled, var_os, warn!).


##### `ThreadTraceContext::start_root_in_root_for_test`  (lines 124–129)

```
fn start_root_in_root_for_test(
        root: &Path,
        metadata: ThreadStartedTraceMetadata,
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts a root trace bundle in an explicit directory without consulting environment variables. It exists so tests can create deterministic bundles without mutating process-global env state.

**Data flow**: Accepts a root `&Path` and startup metadata, forwards both to `start_root_in_root`, and returns that `anyhow::Result<ThreadTraceContext>` unchanged.

**Call relations**: Used only by tests and test helpers that need replayable bundles. It is a thin wrapper around the real root-start logic.

*Call graph*: calls 1 internal fn (start_root_in_root); called by 5 (attach_trace_bundle, attach_test_trace, create_in_root_writes_replayable_lifecycle_events, protocol_wrapper_records_selected_events_as_raw_payloads, spawned_thread_start_appends_to_root_bundle).


##### `ThreadTraceContext::start`  (lines 132–146)

```
fn start(
        writer: Arc<TraceWriter>,
        root_thread_id: AgentThreadId,
        metadata: ThreadStartedTraceMetadata,
    ) -> Self
```

**Purpose**: Creates an enabled thread context inside an existing rollout bundle and immediately records the thread-start lifecycle event. It is the common constructor for both root and child thread traces once a writer already exists.

**Data flow**: Takes an `Arc<TraceWriter>`, the rollout's `root_thread_id`, and startup metadata. It builds `EnabledThreadTraceContext` using the metadata's `thread_id`, calls `record_thread_started` to emit the startup event and metadata payload, then returns `ThreadTraceContext::Enabled(context)`.

**Call relations**: Called by `start_root_in_root` for the root thread and by `start_child_thread_trace_or_disabled` for spawned children. It delegates the actual startup event serialization to `record_thread_started`.

*Call graph*: calls 1 internal fn (record_thread_started); called by 1 (start_root_in_root); 1 external calls (Enabled).


##### `ThreadTraceContext::is_enabled`  (lines 153–155)

```
fn is_enabled(&self) -> bool
```

**Purpose**: Reports whether this handle will actually write trace data. It lets callers avoid expensive payload preparation when tracing is off.

**Data flow**: Reads `self.state` and returns `true` only when it matches `ThreadTraceContextState::Enabled(_)`. It does not mutate state or perform I/O.

**Call relations**: This is a leaf predicate used by callers that want to branch before constructing trace-owned data. Most trace methods do not require it because they already contain their own disabled fast path.

*Call graph*: 1 external calls (matches!).


##### `ThreadTraceContext::start_child_thread_trace_or_disabled`  (lines 162–174)

```
fn start_child_thread_trace_or_disabled(
        &self,
        metadata: ThreadStartedTraceMetadata,
    ) -> Self
```

**Purpose**: Starts tracing for a newly spawned child thread within the same rollout bundle, or returns a disabled child context if the parent is disabled. It preserves the root bundle while assigning the child its own thread identity.

**Data flow**: Consumes child `ThreadStartedTraceMetadata`. If `self` is disabled, it returns `ThreadTraceContext::disabled()`. If enabled, it clones the parent's `Arc<TraceWriter>`, reuses the parent's `root_thread_id`, and calls `ThreadTraceContext::start` with the child metadata.

**Call relations**: Called when a session spawns a fresh child thread. It bridges parent and child tracing by sharing the writer but ensuring the child gets its own startup event and thread id.

*Call graph*: called by 1 (new); 3 external calls (clone, disabled, start).


##### `ThreadTraceContext::record_ended`  (lines 181–192)

```
fn record_ended(&self, status: RolloutStatus)
```

**Purpose**: Emits terminal lifecycle events for a thread and, if that thread is the root, for the entire rollout. This distinguishes child completion from rollout completion.

**Data flow**: Takes a `RolloutStatus`. In the enabled state it appends `RawTraceEventPayload::ThreadEnded { thread_id, status: status.clone() }`. If `thread_id == root_thread_id`, it also appends `RawTraceEventPayload::RolloutEnded { status }`. Disabled contexts do nothing.

**Call relations**: Called during graceful shutdown paths. It writes directly through the enabled context's append helper and conditionally emits the rollout-level terminal event only for the root thread.

*Call graph*: 1 external calls (clone).


##### `ThreadTraceContext::record_protocol_event`  (lines 198–214)

```
fn record_protocol_event(&self, event: &EventMsg)
```

**Purpose**: Wraps selected protocol events as raw trace breadcrumbs so reducers and debugging tools can inspect important protocol-level observations. High-volume deltas are intentionally excluded.

**Data flow**: Accepts `&EventMsg`, checks enabled state, derives an event type string with `wrapped_protocol_event_type`, serializes the full event into a payload file of kind `RawPayloadKind::ProtocolEvent`, and appends `RawTraceEventPayload::ProtocolEventObserved { event_type, event_payload }`. If the event type is not one of the wrapped kinds or payload writing fails, it returns early.

**Call relations**: Used when protocol traffic should be mirrored into rollout traces. It depends on `wrapped_protocol_event_type` to decide eligibility and on the enabled context helpers for payload persistence and event append.

*Call graph*: calls 1 internal fn (wrapped_protocol_event_type).


##### `ThreadTraceContext::record_codex_turn_event`  (lines 217–230)

```
fn record_codex_turn_event(&self, default_turn_id: &str, event: &EventMsg)
```

**Purpose**: Converts protocol lifecycle events into typed Codex-turn trace events and records them with explicit thread/turn context. This gives reducers canonical turn lifecycle records instead of forcing them to infer everything from raw protocol messages.

**Data flow**: Takes a fallback turn id `&str` and `&EventMsg`. In the enabled state it calls `codex_turn_trace_event(thread_id.clone(), default_turn_id, event)`. If conversion succeeds, it appends the returned payload using `append_with_context_best_effort`, keyed by `trace_event.context_turn_id`.

**Call relations**: Called from protocol lifecycle wiring when a protocol event may correspond to turn start/end semantics. It delegates event interpretation to `codex_turn_trace_event` and only performs contextual append.

*Call graph*: calls 1 internal fn (codex_turn_trace_event).


##### `ThreadTraceContext::record_tool_call_event`  (lines 237–248)

```
fn record_tool_call_event(&self, codex_turn_id: impl Into<CodexTurnId>, event: &EventMsg)
```

**Purpose**: Converts protocol lifecycle events into typed runtime tool events for an already-dispatched tool call. These events describe execution inside the dispatch boundary rather than the caller-facing dispatch itself.

**Data flow**: Accepts a `codex_turn_id` convertible into `CodexTurnId` and `&EventMsg`. If enabled, it derives a `ToolRuntimeTraceEvent` via `tool_runtime_trace_event`, converts that into a `RawTraceEventPayload` with `raw_tool_runtime_payload`, and appends it with thread/turn context. Any failed conversion causes an early return.

**Call relations**: Used when protocol events reflect runtime progress of a tool call. It sits between protocol parsing and raw event append, delegating interpretation to `tool_runtime_trace_event` and payload shaping to `EnabledThreadTraceContext::raw_tool_runtime_payload`.

*Call graph*: calls 1 internal fn (tool_runtime_trace_event); 1 external calls (into).


##### `ThreadTraceContext::record_agent_result_interaction`  (lines 256–283)

```
fn record_agent_result_interaction(
        &self,
        child_codex_turn_id: impl Into<CodexTurnId>,
        parent_thread_id: impl Into<AgentThreadId>,
        payload: &AgentResultTracePayload<'_
```

**Purpose**: Records a child-to-parent completion notification as an explicit graph edge in the trace. This preserves the runtime delivery event without pretending it was a tool call.

**Data flow**: Takes a child turn id, a parent thread id, and an `AgentResultTracePayload`. In the enabled state it converts ids into owned `CodexTurnId`/`AgentThreadId`, optionally writes the payload JSON as `RawPayloadKind::AgentResult`, constructs a stable `edge_id` string incorporating child thread, child turn, and parent thread, and appends `RawTraceEventPayload::AgentResultObserved` with message text and optional carried payload reference.

**Call relations**: Called when a completed child sends its result back to the parent mailbox. It writes a trace-only edge event so reducers do not need to infer this relationship from later prompt snapshots.

*Call graph*: 3 external calls (clone, into, format!).


##### `ThreadTraceContext::record_codex_turn_started`  (lines 290–302)

```
fn record_codex_turn_started(&self, codex_turn_id: impl Into<CodexTurnId>)
```

**Purpose**: Emits an explicit turn-start event for tests and lightweight integrations that need valid reducer input without running the full production session loop. It is a direct hook for creating a turn lifecycle boundary.

**Data flow**: Accepts a turn id convertible into `CodexTurnId`. In the enabled state it appends `RawTraceEventPayload::CodexTurnStarted { codex_turn_id, thread_id }` with matching thread/turn context. Disabled contexts return immediately.

**Call relations**: Used primarily by trace-focused tests or simplified integrations. It bypasses protocol-derived turn detection and writes the canonical start event directly.

*Call graph*: 2 external calls (clone, into).


##### `ThreadTraceContext::start_code_cell_trace`  (lines 305–315)

```
fn start_code_cell_trace(
        &self,
        codex_turn_id: impl Into<CodexTurnId>,
        runtime_cell_id: impl Into<String>,
        model_visible_call_id: impl Into<String>,
        source_js:
```

**Purpose**: Starts a first-class code-mode cell lifecycle and returns the corresponding `CodeCellTraceContext`. It combines context construction with the initial started event.

**Data flow**: Takes a turn id, runtime cell id, model-visible call id, and source JavaScript. It first builds a context via `code_cell_trace_context`, then calls `record_started(model_visible_call_id, source_js)` on that returned context, and finally returns it.

**Call relations**: Called when code mode begins executing a runtime cell. It layers a convenience start step on top of `code_cell_trace_context` so callers do not need two separate operations.

*Call graph*: calls 1 internal fn (code_cell_trace_context).


##### `ThreadTraceContext::code_cell_trace_context`  (lines 318–332)

```
fn code_cell_trace_context(
        &self,
        codex_turn_id: impl Into<CodexTurnId>,
        runtime_cell_id: impl Into<String>,
    ) -> CodeCellTraceContext
```

**Purpose**: Builds a reusable trace handle for a code-mode runtime cell that may already have been started elsewhere. It encapsulates the current thread id and shared writer.

**Data flow**: Accepts a turn id and runtime cell id. If disabled, it returns `CodeCellTraceContext::disabled()`. If enabled, it clones the writer and calls `CodeCellTraceContext::enabled(writer, thread_id.clone(), codex_turn_id, runtime_cell_id)`.

**Call relations**: Used directly when callers need a handle for an existing cell, and indirectly by `start_code_cell_trace` before it records the start event.

*Call graph*: calls 2 internal fn (disabled, enabled); called by 1 (start_code_cell_trace); 1 external calls (clone).


##### `ThreadTraceContext::start_tool_dispatch_trace`  (lines 339–350)

```
fn start_tool_dispatch_trace(
        &self,
        invocation: impl FnOnce() -> Option<ToolDispatchInvocation>,
    ) -> ToolDispatchTraceContext
```

**Purpose**: Starts tracing for one dispatch-level tool lifecycle while avoiding expensive invocation construction when tracing is disabled. The invocation closure is intentionally lazy for hot-path efficiency.

**Data flow**: Accepts a `FnOnce() -> Option<ToolDispatchInvocation>`. If disabled, it returns `ToolDispatchTraceContext::disabled()` without invoking the closure. If enabled, it executes the closure; `None` also yields a disabled dispatch context, while `Some(invocation)` is passed to `ToolDispatchTraceContext::start` with a cloned writer.

**Call relations**: Called on the tool dispatch hot path. It gates whether the caller must adapt core tool objects into trace-owned payloads, and delegates actual lifecycle recording to `ToolDispatchTraceContext::start`.

*Call graph*: calls 2 internal fn (disabled, start); 1 external calls (clone).


##### `ThreadTraceContext::inference_trace_context`  (lines 357–373)

```
fn inference_trace_context(
        &self,
        codex_turn_id: impl Into<CodexTurnId>,
        model: impl Into<String>,
        provider_name: impl Into<String>,
    ) -> InferenceTraceContext
```

**Purpose**: Builds an `InferenceTraceContext` for a specific Codex turn, model, and provider without yet representing a concrete attempt. Transport code can then start one or more attempts under that logical inference context.

**Data flow**: Takes a turn id, model string, and provider name. Disabled state returns `InferenceTraceContext::disabled()`. Enabled state clones the writer and calls `InferenceTraceContext::enabled(writer, thread_id.clone(), codex_turn_id.into(), model.into(), provider_name.into())`.

**Call relations**: Used by inference transport code before request retries or fallbacks are known. It prepares shared context, leaving attempt-level events to downstream inference tracing APIs.

*Call graph*: calls 2 internal fn (disabled, enabled); 2 external calls (clone, into).


##### `ThreadTraceContext::compaction_trace_context`  (lines 381–399)

```
fn compaction_trace_context(
        &self,
        codex_turn_id: impl Into<CodexTurnId>,
        compaction_id: impl Into<CompactionId>,
        model: impl Into<String>,
        provider_name: impl
```

**Purpose**: Builds a `CompactionTraceContext` for one remote compaction checkpoint flow. It captures the thread, turn, compaction id, model, and provider needed for request/response attempts and later checkpoint installation.

**Data flow**: Accepts a turn id, compaction id, model, and provider. Disabled state returns `CompactionTraceContext::disabled()`. Enabled state clones the writer and calls `CompactionTraceContext::enabled(writer, thread_id.clone(), codex_turn_id.into(), compaction_id.into(), model.into(), provider_name.into())`.

**Call relations**: Called when remote compaction is about to be used for a checkpoint. It parallels `inference_trace_context` but for compaction-specific lifecycle recording.

*Call graph*: calls 2 internal fn (disabled, enabled); 2 external calls (clone, into).


##### `ThreadTraceContext::start_mcp_call_trace`  (lines 406–417)

```
fn start_mcp_call_trace(&self, tool_call_id: impl Into<ToolCallId>) -> McpCallTraceContext
```

**Purpose**: Assigns a globally unique MCP correlation id to a concrete backend request and returns an `McpCallTraceContext` carrying that id. This separates rollout-local tool ids from cross-process correlation ids.

**Data flow**: Accepts a tool call id convertible into `ToolCallId`. If disabled, it returns `McpCallTraceContext::disabled()`. If enabled, it generates a UUID string, creates `McpCallTraceContext::enabled(mcp_call_id.clone())`, appends `RawTraceEventPayload::McpToolCallCorrelationAssigned { tool_call_id, mcp_call_id }`, and returns the trace handle.

**Call relations**: Used when bridging a dispatch-level tool call to an MCP backend request. It emits the correlation assignment event immediately and hands the generated id to downstream MCP logging/tracing code.

*Call graph*: calls 2 internal fn (disabled, enabled); 2 external calls (into, new_v4).


##### `start_root_in_root`  (lines 420–444)

```
fn start_root_in_root(
    root: &Path,
    metadata: ThreadStartedTraceMetadata,
) -> anyhow::Result<ThreadTraceContext>
```

**Purpose**: Creates a new rollout trace bundle directory, initializes its writer and manifest, emits the rollout-start event, and returns the root thread context. It is the concrete root-start implementation shared by production and tests.

**Data flow**: Consumes a root directory path and startup metadata. It generates a UUID `trace_id`, derives `bundle_dir` as `trace-{trace_id}-{thread_id}`, creates a `TraceWriter` with trace/rollout/root ids all tied to the root thread, appends `RawTraceEventPayload::RolloutStarted`, logs the bundle path at debug level, and returns `ThreadTraceContext::start(writer, thread_id, metadata)`. Errors from writer creation propagate; append failures only warn.

**Call relations**: Called by both `ThreadTraceContext::start_root_or_disabled` and `ThreadTraceContext::start_root_in_root_for_test`. It performs the one-time bundle setup before handing off to `ThreadTraceContext::start` for thread-level startup.

*Call graph*: calls 2 internal fn (start, create); called by 2 (start_root_in_root_for_test, start_root_or_disabled); 6 external calls (new, join, new_v4, debug!, format!, warn!).


##### `record_thread_started`  (lines 446–457)

```
fn record_thread_started(
    context: &EnabledThreadTraceContext,
    metadata: ThreadStartedTraceMetadata,
)
```

**Purpose**: Serializes startup metadata and appends the canonical `ThreadStarted` raw event for a thread. It captures both the visible agent path and an optional payload file containing richer operational metadata.

**Data flow**: Takes an enabled context and owned `ThreadStartedTraceMetadata`. It writes the metadata JSON as `RawPayloadKind::SessionMetadata`, receiving an optional `RawPayloadRef`, then appends `RawTraceEventPayload::ThreadStarted { thread_id, agent_path, metadata_payload }`. Ownership of `metadata.thread_id` and `metadata.agent_path` is moved into the event.

**Call relations**: Called only from `ThreadTraceContext::start` as part of thread initialization. It relies on the enabled context's best-effort payload and append helpers.

*Call graph*: calls 2 internal fn (append_best_effort, write_json_payload_best_effort); called by 1 (start).


##### `EnabledThreadTraceContext::write_json_payload_best_effort`  (lines 460–472)

```
fn write_json_payload_best_effort(
        &self,
        kind: RawPayloadKind,
        payload: &impl Serialize,
    ) -> Option<RawPayloadRef>
```

**Purpose**: Writes a JSON payload file through the shared `TraceWriter` and converts any failure into a warning plus `None`. It is the common payload persistence helper for thread-scoped tracing.

**Data flow**: Accepts a `RawPayloadKind` and a serializable payload reference. It calls `self.writer.write_json_payload(kind, payload)`, returning `Some(RawPayloadRef)` on success or logging a warning and returning `None` on error.

**Call relations**: Used by startup metadata recording and tool-runtime payload conversion, and indirectly by several public trace methods that need optional payload references without failing the main execution path.

*Call graph*: called by 2 (raw_tool_runtime_payload, record_thread_started); 1 external calls (warn!).


##### `EnabledThreadTraceContext::raw_tool_runtime_payload`  (lines 474–504)

```
fn raw_tool_runtime_payload(
        &self,
        trace_event: crate::protocol_event::ToolRuntimeTraceEvent<'_>,
    ) -> Option<RawTraceEventPayload>
```

**Purpose**: Converts a parsed `ToolRuntimeTraceEvent` into the corresponding raw trace payload variant, including persistence of the runtime payload body. It normalizes started and ended runtime observations into the crate's raw event schema.

**Data flow**: Consumes a `crate::protocol_event::ToolRuntimeTraceEvent<'_>`. For `Started`, it writes the embedded payload as `RawPayloadKind::ToolRuntimeEvent` and returns `RawTraceEventPayload::ToolCallRuntimeStarted { tool_call_id, runtime_payload }`. For `Ended`, it writes the payload similarly and returns `RawTraceEventPayload::ToolCallRuntimeEnded { tool_call_id, status, runtime_payload }`. Any payload-write failure yields `None`.

**Call relations**: Called by `ThreadTraceContext::record_tool_call_event` after protocol-to-runtime interpretation has already happened. It isolates the schema mapping and payload-file creation.

*Call graph*: calls 1 internal fn (write_json_payload_best_effort).


##### `EnabledThreadTraceContext::append_best_effort`  (lines 506–510)

```
fn append_best_effort(&self, payload: RawTraceEventPayload)
```

**Purpose**: Appends a raw trace event without extra context and suppresses append failures to warnings. It is the simplest event-write helper for thread-scoped tracing.

**Data flow**: Accepts a `RawTraceEventPayload`, calls `self.writer.append(payload)`, and ignores the returned event object. On error it logs a warning; otherwise it writes to the bundle's `trace.jsonl`.

**Call relations**: Used by startup, shutdown, rollout-start/end, and MCP-correlation paths that do not need explicit turn context attached.

*Call graph*: called by 1 (record_thread_started); 1 external calls (warn!).


##### `EnabledThreadTraceContext::append_with_context_best_effort`  (lines 512–524)

```
fn append_with_context_best_effort(
        &self,
        codex_turn_id: CodexTurnId,
        payload: RawTraceEventPayload,
    )
```

**Purpose**: Appends a raw trace event with explicit thread and Codex-turn context, suppressing failures to warnings. It is the contextual counterpart to `append_best_effort`.

**Data flow**: Takes a `CodexTurnId` and `RawTraceEventPayload`, constructs `RawTraceEventContext { thread_id: Some(self.thread_id.clone()), codex_turn_id: Some(codex_turn_id) }`, and calls `self.writer.append_with_context(event_context, payload)`. Errors are logged and otherwise ignored.

**Call relations**: Used by turn, tool-runtime, agent-result, and explicit turn-start recording paths whenever reducers need the event tied to both a thread and a turn.

*Call graph*: 2 external calls (clone, warn!).


### `rollout-trace/src/code_cell.rs`

`domain_logic` · `runtime cell execution and completion`

This module centers on `CodeCellTraceContext`, a small cloneable wrapper whose internal state is either `Disabled` or `Enabled(EnabledCodeCellTraceContext)`. The enabled state captures the shared `Arc<TraceWriter>` plus the enclosing `AgentThreadId`, `CodexTurnId`, and the runtime-local `runtime_cell_id` that identifies the JavaScript cell inside code mode. Public methods all follow the same hot-path pattern: early-return if tracing is disabled, otherwise build a concrete `RawTraceEventPayload` and append it best-effort.

`record_started` emits `CodeCellStarted` before nested tool calls can occur, preserving the model-visible call id and parsed JavaScript source. `record_initial_response` and `record_ended` both derive a `CodeCellRuntimeStatus` from `codex_code_mode::RuntimeResponse`, serialize the raw runtime response into a `ToolResult` payload, and attach that payload reference to `CodeCellInitialResponse` or `CodeCellEnded`. The response payload is intentionally the runtime-boundary object, not the later model-visible custom-tool output.

Two helper functions encapsulate failure policy: `write_json_payload_best_effort` logs a warning and returns `None` if payload persistence fails, while `append_with_context_best_effort` constructs `RawTraceEventContext` from the stored thread/turn ids and warns on append failure. The design invariant is that tracing must never affect execution: all serialization and append errors degrade to missing trace evidence rather than propagated failures.

#### Function details

##### `CodeCellTraceContext::disabled`  (lines 57–61)

```
fn disabled() -> Self
```

**Purpose**: Constructs a trace context whose methods are safe no-ops. It is the disabled branch used when rollout tracing is unavailable or intentionally off.

**Data flow**: Takes no arguments and creates `CodeCellTraceContext { state: CodeCellTraceContextState::Disabled }`. It returns that value and writes no external state.

**Call relations**: It is selected by the higher-level `code_cell_trace_context` factory when tracing should not record code-cell events, allowing downstream execution code to call tracing methods unconditionally.

*Call graph*: called by 1 (code_cell_trace_context).


##### `CodeCellTraceContext::enabled`  (lines 64–78)

```
fn enabled(
        writer: Arc<TraceWriter>,
        thread_id: impl Into<AgentThreadId>,
        codex_turn_id: impl Into<CodexTurnId>,
        runtime_cell_id: impl Into<String>,
    ) -> Self
```

**Purpose**: Constructs an active trace context for a specific already-known runtime cell. It captures the writer and stable identifiers needed to stamp every later event with thread, turn, and runtime-cell identity.

**Data flow**: Consumes an `Arc<TraceWriter>` plus values convertible into `AgentThreadId`, `CodexTurnId`, and `String` for `runtime_cell_id`; converts them with `into()` and stores them in `EnabledCodeCellTraceContext`. Returns a `CodeCellTraceContext` in the `Enabled` state.

**Call relations**: It is chosen by `code_cell_trace_context` when rollout tracing is enabled and the runtime cell id is known, setting up the state later read by `record_started`, `record_initial_response`, and `record_ended`.

*Call graph*: called by 1 (code_cell_trace_context); 2 external calls (into, Enabled).


##### `CodeCellTraceContext::record_started`  (lines 81–97)

```
fn record_started(
        &self,
        model_visible_call_id: impl Into<ModelVisibleCallId>,
        source_js: impl Into<String>,
    )
```

**Purpose**: Emits the raw event that declares a code cell has started executing, including the model-visible `exec` call id and the parsed JavaScript source. This establishes the parent runtime object before nested tool activity can be traced.

**Data flow**: Reads `self.state`; if disabled, returns immediately. Otherwise converts `model_visible_call_id` and `source_js`, clones `runtime_cell_id` from the enabled context, builds `RawTraceEventPayload::CodeCellStarted`, and passes it to `append_with_context_best_effort`, which writes the event through the stored `TraceWriter`.

**Call relations**: It is invoked by runtime code at cell start. Its only delegation is to `append_with_context_best_effort`, which centralizes event-context construction and best-effort append behavior.

*Call graph*: calls 1 internal fn (append_with_context_best_effort); 1 external calls (into).


##### `CodeCellTraceContext::record_initial_response`  (lines 105–117)

```
fn record_initial_response(&self, response: &RuntimeResponse)
```

**Purpose**: Records the first runtime response returned by the public code-mode `exec` tool, distinguishing yielded cells from terminal initial responses. It preserves both a normalized status and the raw runtime response payload.

**Data flow**: Accepts `&RuntimeResponse`, checks whether tracing is enabled, then computes `status` via `code_cell_status_for_runtime_response` and `response_payload` via `code_cell_response_payload`. It clones `runtime_cell_id`, builds `RawTraceEventPayload::CodeCellInitialResponse`, and appends it with context.

**Call relations**: It is called when the runtime produces the first response for a cell. It delegates status classification to `code_cell_status_for_runtime_response`, payload serialization to `code_cell_response_payload`, and final event emission to `append_with_context_best_effort`.

*Call graph*: calls 3 internal fn (append_with_context_best_effort, code_cell_response_payload, code_cell_status_for_runtime_response).


##### `CodeCellTraceContext::record_ended`  (lines 120–132)

```
fn record_ended(&self, response: &RuntimeResponse)
```

**Purpose**: Emits the terminal lifecycle event for a code-mode runtime cell. It marks final runtime status and optionally links the serialized terminal response payload.

**Data flow**: Takes `&RuntimeResponse`, returns early if disabled, otherwise derives `CodeCellRuntimeStatus`, serializes the response into an optional `RawPayloadRef`, clones `runtime_cell_id`, constructs `RawTraceEventPayload::CodeCellEnded`, and appends it through the writer with thread/turn context.

**Call relations**: It is called by the runtime owner when the cell has definitively ended. Like `record_initial_response`, it relies on the shared helpers for status mapping, payload writing, and best-effort append.

*Call graph*: calls 3 internal fn (append_with_context_best_effort, code_cell_response_payload, code_cell_status_for_runtime_response).


##### `code_cell_status_for_runtime_response`  (lines 135–147)

```
fn code_cell_status_for_runtime_response(response: &RuntimeResponse) -> CodeCellRuntimeStatus
```

**Purpose**: Maps a `RuntimeResponse` into the reduced trace enum `CodeCellRuntimeStatus`. It distinguishes yielded, terminated, successful result, and failed result states using the presence of `error_text`.

**Data flow**: Reads the `RuntimeResponse` variant: `Yielded` becomes `Yielded`, `Terminated` becomes `Terminated`, and `Result` becomes `Failed` if `error_text.is_some()` else `Completed`. Returns the derived status without side effects.

**Call relations**: It is used by both `record_initial_response` and `record_ended` so those event constructors share one consistent status policy.

*Call graph*: called by 2 (record_ended, record_initial_response).


##### `code_cell_response_payload`  (lines 149–158)

```
fn code_cell_response_payload(
    context: &EnabledCodeCellTraceContext,
    response: &RuntimeResponse,
) -> Option<RawPayloadRef>
```

**Purpose**: Serializes a runtime response into a raw trace payload reference suitable for code-cell lifecycle events. It wraps the borrowed response in a trace-specific payload struct so the raw runtime object is preserved.

**Data flow**: Reads the enabled context's `writer`, constructs `CodeCellResponseTracePayload { response }`, and passes it with `RawPayloadKind::ToolResult` to `write_json_payload_best_effort`. Returns `Some(RawPayloadRef)` on success or `None` if serialization/storage fails.

**Call relations**: It is called by `record_initial_response` and `record_ended` to keep response-payload creation identical across initial and terminal events.

*Call graph*: calls 1 internal fn (write_json_payload_best_effort); called by 2 (record_ended, record_initial_response).


##### `write_json_payload_best_effort`  (lines 160–172)

```
fn write_json_payload_best_effort(
    writer: &TraceWriter,
    kind: RawPayloadKind,
    payload: &impl Serialize,
) -> Option<RawPayloadRef>
```

**Purpose**: Attempts to persist a JSON payload to the trace store without letting failures affect the caller's main control flow. It converts writer errors into warnings and an absent payload reference.

**Data flow**: Accepts a `TraceWriter`, `RawPayloadKind`, and serializable payload; calls `writer.write_json_payload(kind, payload)`. On success it wraps the returned payload ref in `Some`; on error it logs `warn!` and returns `None`.

**Call relations**: It is only reached through `code_cell_response_payload`, isolating the best-effort serialization policy for code-cell response evidence.

*Call graph*: calls 1 internal fn (write_json_payload); called by 1 (code_cell_response_payload); 1 external calls (warn!).


##### `append_with_context_best_effort`  (lines 174–185)

```
fn append_with_context_best_effort(
    context: &EnabledCodeCellTraceContext,
    payload: RawTraceEventPayload,
)
```

**Purpose**: Appends a raw trace event using the thread and turn ids stored in an enabled code-cell context. It ensures every emitted event carries the same envelope context and suppresses append failures to warnings.

**Data flow**: Builds `RawTraceEventContext { thread_id: Some(...), codex_turn_id: Some(...) }` from the enabled context, then calls `context.writer.append_with_context(event_context, payload)`. It returns unit and only writes to the trace log; on error it emits `warn!`.

**Call relations**: This helper is the final sink for `record_started`, `record_initial_response`, and `record_ended`, so all code-cell lifecycle events share identical envelope construction and failure handling.

*Call graph*: called by 3 (record_ended, record_initial_response, record_started); 1 external calls (warn!).


### `rollout-trace/src/compaction.rs`

`domain_logic` · `history compaction request/retry and checkpoint installation`

This file defines two layered no-op-capable handles: `CompactionTraceContext` for the overall semantic compaction operation within a turn, and `CompactionTraceAttempt` for one concrete upstream compact-endpoint request. The enabled context stores an `Arc<TraceWriter>`, `AgentThreadId`, `CodexTurnId`, stable `CompactionId`, and provider metadata (`model`, `provider_name`). Each attempt clones that context and adds a unique `CompactionRequestId` generated from the global `NEXT_COMPACTION_REQUEST` atomic counter.

`start_attempt` is the main entry point: if tracing is disabled it returns a disabled attempt; otherwise it allocates a request id, constructs an enabled attempt, immediately records `CompactionRequestStarted`, and returns the attempt for later terminal recording. `record_completed` serializes the compact endpoint's `ResponseItem` list using `trace_response_item_json` from the inference module so trace evidence preserves response-item details that normal request serialization may omit. `record_result` lets callers pass a `Result` directly and dispatches to `record_completed` or `record_failed` without branching.

At the context level, `record_installed` persists a `CompactionCheckpointTracePayload` containing both `input_history` and `replacement_history`, then emits `CompactionInstalled` tied to the stable `compaction_id`. Unlike the code-cell module, helper functions here are intentionally quieter: payload writes use `.ok()` and event appends ignore errors except in `record_installed`, where failures are explicitly warned because checkpoint installation is the semantic culmination of compaction.

#### Function details

##### `CompactionTraceContext::disabled`  (lines 91–95)

```
fn disabled() -> Self
```

**Purpose**: Constructs a compaction trace context that accepts calls but records nothing. It gives compaction code a uniform API regardless of whether rollout tracing is enabled.

**Data flow**: Takes no inputs and returns `CompactionTraceContext { state: CompactionTraceContextState::Disabled }`. It does not touch external state.

**Call relations**: It is returned by the higher-level `compaction_trace_context` setup path when tracing is unavailable, and later causes `start_attempt` and `record_installed` to short-circuit.

*Call graph*: called by 1 (compaction_trace_context).


##### `CompactionTraceContext::enabled`  (lines 98–116)

```
fn enabled(
        writer: Arc<TraceWriter>,
        thread_id: AgentThreadId,
        codex_turn_id: CodexTurnId,
        compaction_id: CompactionId,
        model: String,
        provider_name: S
```

**Purpose**: Builds an active context for all upstream attempts that contribute to one compaction checkpoint. It captures the stable compaction identity and provider metadata reused across retries.

**Data flow**: Consumes a `TraceWriter` handle, thread and turn ids, a `CompactionId`, and provider strings; stores them in `EnabledCompactionTraceContext` inside the `Enabled` enum variant. Returns the resulting `CompactionTraceContext`.

**Call relations**: It is selected by `compaction_trace_context` when tracing is active, and its stored fields are later cloned into each `CompactionTraceAttempt` created by `start_attempt`.

*Call graph*: called by 1 (compaction_trace_context); 1 external calls (Enabled).


##### `CompactionTraceContext::start_attempt`  (lines 119–132)

```
fn start_attempt(&self, request: &impl Serialize) -> CompactionTraceAttempt
```

**Purpose**: Creates one traced upstream compaction request attempt and immediately records its request payload. This is the retry boundary: each call gets a fresh request id while sharing the same stable compaction id.

**Data flow**: Reads `self.state`; if disabled, returns `CompactionTraceAttempt::disabled()`. Otherwise clones the enabled context, generates a new `CompactionRequestId` via `next_compaction_request_id`, constructs an enabled `CompactionTraceAttempt`, calls `attempt.record_started(request)` to persist the request payload and start event, then returns the attempt.

**Call relations**: It is invoked by `compact_conversation_history` when issuing a compact endpoint request. It delegates request-id generation to `next_compaction_request_id` and startup event emission to `CompactionTraceAttempt::record_started`.

*Call graph*: calls 2 internal fn (disabled, next_compaction_request_id); called by 1 (compact_conversation_history); 1 external calls (Enabled).


##### `CompactionTraceContext::record_installed`  (lines 138–166)

```
fn record_installed(&self, checkpoint: &CompactionCheckpointTracePayload<'_>)
```

**Purpose**: Records the moment compacted replacement history becomes the live thread history. It ties the installed checkpoint back to the same semantic `compaction_id` used by all request attempts.

**Data flow**: Accepts a borrowed `CompactionCheckpointTracePayload`; if disabled, returns. Otherwise it writes the checkpoint as `RawPayloadKind::CompactionCheckpoint` through `context.writer.write_json_payload`, warning and returning on error. On success it builds `RawTraceEventContext` from the stored thread/turn ids and appends `RawTraceEventPayload::CompactionInstalled { compaction_id, checkpoint_payload }`, warning if append fails.

**Call relations**: This is called after a successful compaction result has been accepted and installed into live history. It does not use the generic helper functions because it needs explicit warning behavior for both payload-write and append failures.

*Call graph*: 1 external calls (warn!).


##### `CompactionTraceAttempt::disabled`  (lines 171–175)

```
fn disabled() -> Self
```

**Purpose**: Constructs a no-op attempt object for callers that still want to invoke terminal recording methods uniformly. It mirrors the disabled-context pattern at the per-request level.

**Data flow**: Creates and returns `CompactionTraceAttempt { state: CompactionTraceAttemptState::Disabled }` with no side effects.

**Call relations**: It is produced by `CompactionTraceContext::start_attempt` when the parent context is disabled, ensuring later `record_result`, `record_completed`, or `record_failed` calls safely do nothing.

*Call graph*: called by 1 (start_attempt).


##### `CompactionTraceAttempt::record_started`  (lines 177–201)

```
fn record_started(&self, request: &impl Serialize)
```

**Purpose**: Persists the exact compact endpoint request payload and emits the corresponding start event for one upstream attempt. It captures both stable compaction identity and per-attempt request identity.

**Data flow**: Reads `self.state`; if disabled, returns. Otherwise writes the serializable request as `RawPayloadKind::CompactionRequest` using `write_json_payload_best_effort`; if that returns `None`, it stops. With a payload ref, it builds `RawTraceEventPayload::CompactionRequestStarted` containing `compaction_id`, `compaction_request_id`, thread/turn ids, model, provider name, and `request_payload`, then appends it via `append_with_context_best_effort`.

**Call relations**: It is called internally by `CompactionTraceContext::start_attempt` immediately after constructing an enabled attempt, so every returned enabled attempt has already emitted its start event.

*Call graph*: calls 2 internal fn (append_with_context_best_effort, write_json_payload_best_effort).


##### `CompactionTraceAttempt::record_completed`  (lines 208–231)

```
fn record_completed(&self, output_items: &[ResponseItem])
```

**Purpose**: Records a successful non-streaming compact endpoint response and preserves the returned response items in trace-specific JSON form. It emits the terminal completed event for that request attempt.

**Data flow**: If disabled, returns. Otherwise it maps each `ResponseItem` in `output_items` through `trace_response_item_json`, collects them into `TracedCompactionCompleted { output_items }`, writes that as `RawPayloadKind::CompactionResponse`, and if successful appends `RawTraceEventPayload::CompactionRequestCompleted { compaction_id, compaction_request_id, response_payload }`.

**Call relations**: It is reached from `record_result` on `Ok(...)`. It delegates response-item serialization to the inference module helper and uses the local best-effort helpers for payload persistence and event append.

*Call graph*: calls 2 internal fn (append_with_context_best_effort, write_json_payload_best_effort); called by 1 (record_result); 1 external calls (iter).


##### `CompactionTraceAttempt::record_result`  (lines 234–239)

```
fn record_result(&self, result: Result<&[ResponseItem], E>)
```

**Purpose**: Provides a single terminal-recording entry point for callers that already have a `Result` from the compact endpoint. It converts success into a completed event and failure into a failed event.

**Data flow**: Consumes `Result<&[ResponseItem], E>` where `E: Display`; matches on the result and forwards the slice to `record_completed` or the error to `record_failed`. Returns unit and writes whatever those delegated methods write.

**Call relations**: It is the convenience wrapper used by callers that do not want to branch on trace behavior themselves. Its control flow is a simple dispatch to the two terminal methods.

*Call graph*: calls 2 internal fn (record_completed, record_failed).


##### `CompactionTraceAttempt::record_failed`  (lines 242–254)

```
fn record_failed(&self, error: impl Display)
```

**Purpose**: Emits a failed terminal event for a compaction request attempt when the compact endpoint errors before producing a usable response. It stores only the textual error, not a response payload.

**Data flow**: Checks whether the attempt is enabled; if so, converts the `Display` error to `String`, builds `RawTraceEventPayload::CompactionRequestFailed { compaction_id, compaction_request_id, error }`, and appends it with the parent context's thread/turn envelope.

**Call relations**: It is called by `record_result` on `Err(...)`. Unlike `record_completed`, it does not serialize any payload and goes straight to `append_with_context_best_effort`.

*Call graph*: calls 1 internal fn (append_with_context_best_effort); called by 1 (record_result); 1 external calls (to_string).


##### `next_compaction_request_id`  (lines 257–260)

```
fn next_compaction_request_id() -> CompactionRequestId
```

**Purpose**: Generates a unique local request id for each upstream compaction attempt. The ids are monotonic within the process and formatted with a trace-specific prefix.

**Data flow**: Reads and increments the static `NEXT_COMPACTION_REQUEST` atomic using `fetch_add(1, Ordering::Relaxed)`, formats the resulting ordinal as `compaction_request:{ordinal}`, and returns that `CompactionRequestId` string.

**Call relations**: It is called only by `CompactionTraceContext::start_attempt` to assign a fresh request id to each retry or new compact endpoint call.

*Call graph*: called by 1 (start_attempt); 1 external calls (format!).


##### `write_json_payload_best_effort`  (lines 262–268)

```
fn write_json_payload_best_effort(
    writer: &TraceWriter,
    kind: RawPayloadKind,
    payload: &impl Serialize,
) -> Option<crate::RawPayloadRef>
```

**Purpose**: Attempts to write a JSON payload to the trace store and silently drops failures. It is the lightweight helper used for request and response payloads on compaction attempts.

**Data flow**: Calls `writer.write_json_payload(kind, payload).ok()` and returns `Some(RawPayloadRef)` on success or `None` on error. It performs no logging.

**Call relations**: It is used by `CompactionTraceAttempt::record_started` and `CompactionTraceAttempt::record_completed` so those hot-path methods can skip event emission when payload persistence fails.

*Call graph*: calls 1 internal fn (write_json_payload); called by 2 (record_completed, record_started).


##### `append_with_context_best_effort`  (lines 270–279)

```
fn append_with_context_best_effort(
    context: &EnabledCompactionTraceContext,
    payload: RawTraceEventPayload,
)
```

**Purpose**: Appends a compaction-related raw event with the thread and turn ids from the enabled context. It intentionally ignores append errors.

**Data flow**: Builds `RawTraceEventContext` from `context.thread_id` and `context.codex_turn_id`, then calls `context.writer.append_with_context(event_context, payload)` and discards the result. Returns unit.

**Call relations**: It is the final append sink for `record_started`, `record_completed`, and `record_failed`, giving all per-attempt events the same envelope context and silent best-effort behavior.

*Call graph*: called by 3 (record_completed, record_failed, record_started).


### `rollout-trace/src/inference.rs`

`domain_logic` · `upstream inference request setup, streaming, and terminalization`

This module defines the main tracing machinery for model inference. `InferenceTraceContext` is a turn-local handle storing `Arc<TraceWriter>`, `AgentThreadId`, `CodexTurnId`, `model`, and `provider_name` when enabled, or a disabled sentinel otherwise. `start_attempt` creates an `InferenceTraceAttempt` for one concrete upstream request, assigning a UUID-based `InferenceCallId` and an `AtomicBool terminal_recorded` guard so only one terminal event can ever be emitted even if multiple code paths race to finish the stream.

The attempt object supports three phases. First, `add_request_headers` injects `x-codex-inference-call-id` into an `http::HeaderMap` when enabled, but silently skips impossible header-conversion failures to preserve best-effort semantics. Second, `record_started` writes the logical or physical request payload as `InferenceRequest` and emits `InferenceStarted` with thread, turn, model, and provider metadata. Third, one of `record_completed`, `record_failed`, or `record_cancelled` consumes the terminal guard via `take_terminal_attempt`; duplicate terminal calls become no-ops.

Response payloads are summarized as `TracedResponseStreamOutput`, which stores optional `response_id`, optional provider `upstream_request_id`, optional `TokenUsage`, and fully serialized `ResponseItem`s. The helper `trace_response_item_json` is a key design choice: it starts from normal `serde_json::to_value(item)` but explicitly reinserts reasoning `content` that the protocol serializer omits for future-request shaping, preserving raw evidence for replay and debugging. The included tests verify disabled behavior, header propagation, replayable event recording, and reasoning-content preservation.

#### Function details

##### `InferenceTraceContext::disabled`  (lines 96–100)

```
fn disabled() -> Self
```

**Purpose**: Constructs a turn-local inference trace context that records nothing. It allows transport code to keep tracing calls in place without branching on an `Option`.

**Data flow**: Takes no arguments and returns `InferenceTraceContext { state: InferenceTraceContextState::Disabled }`. It does not mutate any shared state.

**Call relations**: It is used broadly by startup paths, tests, and transport code when tracing is absent, and causes `start_attempt` to return a disabled attempt whose methods all no-op.

*Call graph*: called by 18 (prewarm_websocket, drain_to_completed, run_remote_compaction_request_v2, responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids, send_provider_auth_request, responses_websocket_emits_rate_limit_events, responses_websocket_emits_reasoning_included_event (+8 more)).


##### `InferenceTraceContext::enabled`  (lines 103–119)

```
fn enabled(
        writer: Arc<TraceWriter>,
        thread_id: AgentThreadId,
        codex_turn_id: CodexTurnId,
        model: String,
        provider_name: String,
    ) -> Self
```

**Purpose**: Builds an active inference tracing context for one Codex turn. It captures the writer, thread/turn identity, and provider metadata reused by every attempt in that turn.

**Data flow**: Consumes an `Arc<TraceWriter>`, `AgentThreadId`, `CodexTurnId`, `model`, and `provider_name`, stores them in `EnabledInferenceTraceContext`, and returns an enabled `InferenceTraceContext`.

**Call relations**: It is created by inference-trace setup code and tests before request streaming begins, and its stored fields are cloned into each attempt created by `start_attempt`.

*Call graph*: called by 5 (started_inference_attempt, responses_websocket_request_prewarm_traces_logical_request, enabled_attempt_adds_inference_request_header, enabled_context_records_replayable_inference_attempt, inference_trace_context); 1 external calls (Enabled).


##### `InferenceTraceContext::start_attempt`  (lines 122–134)

```
fn start_attempt(&self) -> InferenceTraceAttempt
```

**Purpose**: Creates a new traced upstream request attempt with a fresh inference call id and a terminal-event guard. This is the unit used for retries, auth recovery, or protocol fallback.

**Data flow**: Reads `self.state`; if disabled, returns `InferenceTraceAttempt::disabled()`. Otherwise clones the enabled context, generates a UUID string via `next_inference_call_id`, initializes `terminal_recorded` to `false`, wraps everything in `EnabledInferenceTraceAttempt`, and returns the enabled attempt.

**Call relations**: It is invoked by both `stream_responses_api` and `stream_responses_websocket` after a concrete provider request has been built, so each transport attempt gets its own trace identity.

*Call graph*: calls 2 internal fn (disabled, next_inference_call_id); called by 2 (stream_responses_api, stream_responses_websocket); 2 external calls (new, Enabled).


##### `InferenceTraceAttempt::disabled`  (lines 139–143)

```
fn disabled() -> Self
```

**Purpose**: Constructs a no-op attempt object for code paths that still want to call header injection and lifecycle recording uniformly. It mirrors the disabled context at per-request granularity.

**Data flow**: Returns `InferenceTraceAttempt { state: InferenceTraceAttemptState::Disabled }` with no side effects.

**Call relations**: It is returned by `InferenceTraceContext::start_attempt` when tracing is disabled and is also used directly in tests and some fallback paths.

*Call graph*: called by 4 (stream_responses_websocket, response_stream_records_last_model_feedback_ids, start_attempt, disabled_attempt_adds_no_request_headers).


##### `InferenceTraceAttempt::inference_call_id`  (lines 145–152)

```
fn inference_call_id(&self) -> Option<&str>
```

**Purpose**: Exposes the generated inference call id as an optional string slice. It hides the disabled/enabled state split from callers that only need the id if present.

**Data flow**: Matches on `self.state`; returns `None` for `Disabled` and `Some(&str)` borrowed from `attempt.inference_call_id` for `Enabled`. It does not mutate state.

**Call relations**: It is used only by `add_request_headers` to decide whether a propagation header should be inserted.

*Call graph*: called by 1 (add_request_headers).


##### `InferenceTraceAttempt::add_request_headers`  (lines 155–167)

```
fn add_request_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds the rollout-trace correlation header to an outgoing provider request when tracing is enabled. It never lets tracing break request construction.

**Data flow**: Takes a mutable `HeaderMap`, obtains the optional id via `inference_call_id`, converts it to `HeaderValue` with `HeaderValue::from_str`, and if successful inserts it under `INFERENCE_CALL_ID_HEADER`. If tracing is disabled or conversion fails, it returns without modifying headers.

**Call relations**: It is called by transport code before sending the provider request. Its only dependency is `inference_call_id`, which abstracts away disabled attempts.

*Call graph*: calls 1 internal fn (inference_call_id); 2 external calls (insert, from_str).


##### `InferenceTraceAttempt::record_started`  (lines 174–197)

```
fn record_started(&self, request: &impl Serialize)
```

**Purpose**: Persists the request payload that replay should treat as the model-visible inference input and emits the corresponding start event. It captures the exact request or a caller-supplied logical equivalent.

**Data flow**: If the attempt is disabled, returns. Otherwise writes the serializable request as `RawPayloadKind::InferenceRequest` using `write_json_payload_best_effort`; if that fails, it stops. With a payload ref, it appends `RawTraceEventPayload::InferenceStarted` containing the attempt's `inference_call_id`, thread/turn ids, model, provider name, and `request_payload`.

**Call relations**: It is called by transport code after request construction. It delegates payload persistence to `write_json_payload_best_effort` and final append to `append_with_context_best_effort`.

*Call graph*: calls 2 internal fn (append_with_context_best_effort, write_json_payload_best_effort).


##### `InferenceTraceAttempt::record_completed`  (lines 205–234)

```
fn record_completed(
        &self,
        response_id: &str,
        upstream_request_id: Option<&str>,
        token_usage: &Option<TokenUsage>,
        output_items: &[ResponseItem],
    )
```

**Purpose**: Records successful provider completion for an inference stream and stores a summarized response payload containing ids, token usage, and completed output items. It is terminal and idempotent via the atomic guard.

**Data flow**: Accepts `response_id`, optional `upstream_request_id`, optional `TokenUsage`, and a slice of `ResponseItem`. It first calls `take_terminal_attempt`; if another terminal event already won, it returns. Otherwise it serializes the response via `write_response_payload_best_effort`, and if successful appends `RawTraceEventPayload::InferenceCompleted` with the call id, copied `response_id`, mapped `upstream_request_id`, and `response_payload`.

**Call relations**: It is called by `map_response_events` when the provider stream reaches a successful terminal response. It relies on `take_terminal_attempt` to prevent duplicates and on `write_response_payload_best_effort` to encode the response summary.

*Call graph*: calls 3 internal fn (take_terminal_attempt, append_with_context_best_effort, write_response_payload_best_effort); called by 1 (map_response_events).


##### `InferenceTraceAttempt::record_failed`  (lines 237–266)

```
fn record_failed(
        &self,
        error: impl Display,
        upstream_request_id: Option<&str>,
        output_items: &[ResponseItem],
    )
```

**Purpose**: Records a failed inference attempt, including any complete output items observed before the failure. It covers both pre-response failures and mid-stream failures.

**Data flow**: Takes a displayable error, optional `upstream_request_id`, and observed `output_items`. It acquires terminal ownership via `take_terminal_attempt`; if none, returns. If `output_items` is non-empty, it serializes them as a partial response payload with no `response_id` or token usage; otherwise `partial_response_payload` is `None`. It then appends `RawTraceEventPayload::InferenceFailed` with the call id, optional upstream request id, `error.to_string()`, and the optional partial payload.

**Call relations**: It is invoked by `map_response_events` on provider failure paths. It shares the same terminal guard and response-payload helper as the completion and cancellation paths.

*Call graph*: calls 3 internal fn (take_terminal_attempt, append_with_context_best_effort, write_response_payload_best_effort); called by 1 (map_response_events); 2 external calls (to_string, is_empty).


##### `InferenceTraceAttempt::record_cancelled`  (lines 273–302)

```
fn record_cancelled(
        &self,
        reason: impl Display,
        upstream_request_id: Option<&str>,
        output_items: &[ResponseItem],
    )
```

**Purpose**: Records that Codex intentionally stopped consuming a provider stream, such as interruption or mailbox preemption, while preserving any complete output items already seen. It is distinct from provider failure.

**Data flow**: Accepts a displayable cancellation reason, optional `upstream_request_id`, and observed `output_items`. After `take_terminal_attempt`, it conditionally serializes non-empty output items into a partial response payload and appends `RawTraceEventPayload::InferenceCancelled` with the call id, optional upstream request id, `reason.to_string()`, and the optional partial payload.

**Call relations**: It is called by `map_response_events` when the client intentionally abandons a stream. Like the other terminal methods, it depends on `take_terminal_attempt` to ensure only one terminal event is emitted.

*Call graph*: calls 3 internal fn (take_terminal_attempt, append_with_context_best_effort, write_response_payload_best_effort); called by 1 (map_response_events); 2 external calls (to_string, is_empty).


##### `InferenceTraceAttempt::take_terminal_attempt`  (lines 304–313)

```
fn take_terminal_attempt(&self) -> Option<&EnabledInferenceTraceAttempt>
```

**Purpose**: Implements the single-terminal-event invariant for an inference attempt. It atomically marks the attempt as terminal the first time it is called and rejects all later terminal recordings.

**Data flow**: Matches on `self.state`; disabled returns `None`. For enabled attempts it calls `attempt.terminal_recorded.swap(true, Ordering::AcqRel)`: if the previous value was already `true`, it returns `None`; otherwise it returns `Some(&EnabledInferenceTraceAttempt)`.

**Call relations**: It is the gatekeeper used by `record_completed`, `record_failed`, and `record_cancelled`, preventing duplicate terminal events from retries in stream-mapping logic.

*Call graph*: called by 3 (record_cancelled, record_completed, record_failed).


##### `trace_response_item_json`  (lines 321–345)

```
fn trace_response_item_json(item: &ResponseItem) -> JsonValue
```

**Purpose**: Serializes a `ResponseItem` for trace evidence rather than future request construction, restoring reasoning content omitted by the normal protocol serializer. This preserves what Codex actually received from the provider.

**Data flow**: Starts with `serde_json::to_value(item)`, falling back to a JSON object containing `serialization_error` if serialization fails. If the item is `ResponseItem::Reasoning { content: Some(content), .. }` and the serialized value is an object, it inserts a `content` field serialized from the original reasoning content, again falling back to a `serialization_error` object on failure. Returns the resulting `JsonValue`.

**Call relations**: It is used by compaction and inference response-payload builders, and is directly exercised by the reasoning-content preservation test.

*Call graph*: called by 1 (traced_response_item_preserves_reasoning_content_omitted_by_normal_serializer); 1 external calls (to_value).


##### `next_inference_call_id`  (lines 347–349)

```
fn next_inference_call_id() -> InferenceCallId
```

**Purpose**: Generates a fresh inference call id for one upstream request attempt. The id is a UUID string suitable for propagation in request headers and trace events.

**Data flow**: Calls `Uuid::new_v4().to_string()` and returns the resulting `InferenceCallId`. It has no other side effects.

**Call relations**: It is called only by `InferenceTraceContext::start_attempt` when constructing an enabled attempt.

*Call graph*: called by 1 (start_attempt); 1 external calls (new_v4).


##### `write_json_payload_best_effort`  (lines 351–357)

```
fn write_json_payload_best_effort(
    writer: &TraceWriter,
    kind: RawPayloadKind,
    payload: &impl Serialize,
) -> Option<crate::RawPayloadRef>
```

**Purpose**: Writes a serializable payload to the trace store and silently drops errors. It is the common helper for request and response payload persistence in inference tracing.

**Data flow**: Calls `writer.write_json_payload(kind, payload).ok()` and returns an optional payload reference. It performs no logging or mutation beyond the writer call.

**Call relations**: It is used directly by `record_started` and indirectly by all terminal methods through `write_response_payload_best_effort`.

*Call graph*: calls 1 internal fn (write_json_payload); called by 2 (record_started, write_response_payload_best_effort).


##### `write_response_payload_best_effort`  (lines 359–377)

```
fn write_response_payload_best_effort(
    attempt: &EnabledInferenceTraceAttempt,
    response_id: Option<&str>,
    upstream_request_id: Option<&str>,
    token_usage: Option<&TokenUsage>,
    outpu
```

**Purpose**: Builds and persists the summarized response payload used by completed, failed, and cancelled inference terminal events. It centralizes the trace-specific response serialization rules.

**Data flow**: Accepts the enabled attempt plus optional `response_id`, optional `upstream_request_id`, optional `TokenUsage`, and `output_items`. It maps each `ResponseItem` through `trace_response_item_json`, collects them into `TracedResponseStreamOutput`, and writes that struct as `RawPayloadKind::InferenceResponse` via `write_json_payload_best_effort`. Returns an optional payload ref.

**Call relations**: It is called by `record_completed`, `record_failed`, and `record_cancelled` so all terminal inference events share one response-summary format.

*Call graph*: calls 1 internal fn (write_json_payload_best_effort); called by 3 (record_cancelled, record_completed, record_failed); 1 external calls (iter).


##### `append_with_context_best_effort`  (lines 379–388)

```
fn append_with_context_best_effort(
    context: &EnabledInferenceTraceContext,
    payload: RawTraceEventPayload,
)
```

**Purpose**: Appends an inference-related raw event with the thread and turn ids from the enabled context. It intentionally ignores append errors to keep tracing non-intrusive.

**Data flow**: Constructs `RawTraceEventContext` from `context.thread_id` and `context.codex_turn_id`, then calls `context.writer.append_with_context(event_context, payload)` and discards the result. Returns unit.

**Call relations**: It is the final append sink for `record_started`, `record_completed`, `record_failed`, and `record_cancelled`.

*Call graph*: called by 4 (record_cancelled, record_completed, record_failed, record_started).


##### `tests::disabled_attempt_adds_no_request_headers`  (lines 405–411)

```
fn disabled_attempt_adds_no_request_headers()
```

**Purpose**: Verifies that a disabled inference attempt leaves an outgoing header map untouched. This protects the no-op contract for disabled tracing.

**Data flow**: Creates an empty `HeaderMap`, calls `InferenceTraceAttempt::disabled().add_request_headers(&mut headers)`, and asserts the map remains empty.

**Call relations**: This test exercises the disabled branch of `add_request_headers` and indirectly the disabled attempt constructor.

*Call graph*: calls 1 internal fn (disabled); 2 external calls (new, assert!).


##### `tests::enabled_attempt_adds_inference_request_header`  (lines 414–440)

```
fn enabled_attempt_adds_inference_request_header() -> anyhow::Result<()>
```

**Purpose**: Checks that an enabled attempt injects the `x-codex-inference-call-id` header and that the value matches the attempt's generated UUID. It validates both propagation and id format.

**Data flow**: Creates a temporary trace writer and enabled context, starts an attempt, mutates a fresh `HeaderMap` via `add_request_headers`, then reads the inserted header, compares it to `attempt.inference_call_id()`, and parses it as a UUID.

**Call relations**: This test covers the normal enabled path from `InferenceTraceContext::enabled` through `start_attempt` into `add_request_headers`.

*Call graph*: calls 2 internal fn (enabled, create); 5 external calls (new, new, new, assert!, assert_eq!).


##### `tests::enabled_context_records_replayable_inference_attempt`  (lines 443–494)

```
fn enabled_context_records_replayable_inference_attempt() -> anyhow::Result<()>
```

**Purpose**: Ensures an enabled context writes enough raw events and payloads for replay to reconstruct a completed inference call. It validates end-to-end integration with the reducer-facing replay bundle.

**Data flow**: Creates a temporary trace writer, appends prerequisite `ThreadStarted` and `CodexTurnStarted` events, builds an enabled context, starts an attempt, records a JSON request and a completed response, then loads the trace with `replay_bundle` and asserts the reconstructed inference call's ids, status, upstream request id, and payload counts.

**Call relations**: This test exercises the main happy path across `enabled`, `start_attempt`, `record_started`, and `record_completed`, then verifies the downstream replay consumer sees the expected reduced state.

*Call graph*: calls 2 internal fn (enabled, create); 5 external calls (new, new, assert_eq!, replay_bundle, json!).


##### `tests::traced_response_item_preserves_reasoning_content_omitted_by_normal_serializer`  (lines 497–523)

```
fn traced_response_item_preserves_reasoning_content_omitted_by_normal_serializer()
```

**Purpose**: Confirms that trace serialization restores reasoning `content` omitted by the standard `ResponseItem` serializer. It protects the module's key evidence-preservation behavior.

**Data flow**: Builds a `ResponseItem::Reasoning` with summary, content, and encrypted content; serializes it normally and via `trace_response_item_json`; then asserts the normal JSON lacks `content` while the traced JSON includes it with the expected shape.

**Call relations**: This test directly targets `trace_response_item_json`, documenting why the helper exists and what extra data it preserves.

*Call graph*: calls 1 internal fn (trace_response_item_json); 3 external calls (assert_eq!, to_value, vec!).


### `rollout-trace/src/tool_dispatch.rs`

`domain_logic` · `tool dispatch and tool result conversion on the request handling hot path`

This file centers on `ToolDispatchTraceContext`, which is either disabled or enabled with an `Arc<TraceWriter>`, `thread_id`, `codex_turn_id`, and `tool_call_id`. Core code passes a `ToolDispatchInvocation` describing the resolved tool call: tool name and optional namespace, requester (`Model` with `model_visible_call_id` or `CodeCell` with runtime ids), and one of several payload variants (`Function`, `ToolSearch`, `Custom`, `LocalShell`). The trace layer then converts that invocation into a canonical `ToolCallStarted` event plus a later `ToolCallEnded` event.

A key design choice is suppression of noncanonical boundaries: a `Custom` payload for the public code-mode tool with no namespace is intentionally not traced at this layer, because more specific code-mode tracing already represents that work. For traced calls, `record_started` computes a `ToolCallKind`, a human-readable label, and a truncated input preview, writes a JSON payload file for the full invocation, derives requester fields, and appends a contextual raw event. Completion paths serialize either a direct `ResponseInputItem`, a code-mode JSON value, or an error string into a result payload file and append `ToolCallEnded` with an `ExecutionStatus`.

All writes are best-effort: payload or append failures only emit warnings. The helper methods keep hot-path overhead low by avoiding unnecessary formatting and by truncating previews to 160 characters.

#### Function details

##### `ToolDispatchTraceContext::disabled`  (lines 131–135)

```
fn disabled() -> Self
```

**Purpose**: Constructs a disabled dispatch trace handle that accepts lifecycle calls but records nothing. It is the inert fallback for disabled tracing or suppressed dispatch boundaries.

**Data flow**: Takes no arguments and returns `ToolDispatchTraceContext { state: ToolDispatchTraceContextState::Disabled }`. It performs no I/O and mutates no shared state.

**Call relations**: Returned by `ThreadTraceContext::start_tool_dispatch_trace` when thread tracing is disabled or the invocation closure yields `None`, and by `ToolDispatchTraceContext::start` when suppression rules exclude the boundary.

*Call graph*: called by 1 (start_tool_dispatch_trace).


##### `ToolDispatchTraceContext::is_enabled`  (lines 141–143)

```
fn is_enabled(&self) -> bool
```

**Purpose**: Reports whether this dispatch context will record result conversion work. Callers use it to avoid formatting or cloning outputs unnecessarily.

**Data flow**: Reads `self.state` and returns `true` only for `Enabled(_)`. It has no side effects.

**Call relations**: Queried by higher-level tool result code before constructing expensive trace result payloads; the method itself does not delegate further.

*Call graph*: called by 1 (record_completed); 1 external calls (matches!).


##### `ToolDispatchTraceContext::start`  (lines 146–161)

```
fn start(writer: Arc<TraceWriter>, invocation: ToolDispatchInvocation) -> Self
```

**Purpose**: Starts one dispatch-level tool lifecycle, applying suppression rules before recording the canonical start event. It returns the handle that later records completion or failure.

**Data flow**: Accepts an `Arc<TraceWriter>` and owned `ToolDispatchInvocation`. It first checks `suppresses_tool_dispatch_trace(&invocation)`; if true, it returns `disabled()`. Otherwise it builds `EnabledToolDispatchTraceContext` from the invocation's thread, turn, and tool-call ids, calls `record_started(&context, invocation)`, and returns `ToolDispatchTraceContext::Enabled(context)`.

**Call relations**: Called from `ThreadTraceContext::start_tool_dispatch_trace` after lazy invocation construction. It delegates suppression policy to `suppresses_tool_dispatch_trace` and event emission to `record_started`.

*Call graph*: calls 2 internal fn (record_started, suppresses_tool_dispatch_trace); called by 1 (start_tool_dispatch_trace); 2 external calls (disabled, Enabled).


##### `ToolDispatchTraceContext::record_completed`  (lines 164–177)

```
fn record_completed(&self, status: ExecutionStatus, result: ToolDispatchResult)
```

**Purpose**: Records a successful or otherwise normal dispatch result, including the caller-facing result payload. It supports both direct protocol responses and code-mode JSON responses.

**Data flow**: Takes an `ExecutionStatus` and owned `ToolDispatchResult`. If enabled, it matches the result into a borrowed `DispatchedToolTraceResponse` variant and passes that plus the status to `append_tool_call_ended`. Disabled contexts return immediately.

**Call relations**: Invoked after a traced tool dispatch finishes and the caller-facing result has been converted. It delegates payload-file creation and event append to `append_tool_call_ended`.

*Call graph*: calls 1 internal fn (append_tool_call_ended); called by 1 (record_completed).


##### `ToolDispatchTraceContext::record_failed`  (lines 180–191)

```
fn record_failed(&self, error: impl Display)
```

**Purpose**: Records a dispatch failure that did not produce a normal result payload. It wraps the error text into the trace response schema and marks the execution as failed.

**Data flow**: Accepts any `Display` error. If enabled, it converts the error to `String`, constructs `DispatchedToolTraceResponse::Error { error }`, and calls `append_tool_call_ended` with `ExecutionStatus::Failed`. Disabled contexts do nothing.

**Call relations**: Used on error paths before a normal tool result exists. It shares the same terminal append helper as `record_completed`.

*Call graph*: calls 1 internal fn (append_tool_call_ended); called by 1 (record_failed); 1 external calls (to_string).


##### `suppresses_tool_dispatch_trace`  (lines 194–198)

```
fn suppresses_tool_dispatch_trace(invocation: &ToolDispatchInvocation) -> bool
```

**Purpose**: Implements the policy for skipping noncanonical dispatch traces that would duplicate more specific code-mode tracing. The current rule suppresses the public code-mode tool when invoked as an unnamespaced custom payload.

**Data flow**: Reads a borrowed `ToolDispatchInvocation` and returns `true` only when `payload` matches `ToolDispatchPayload::Custom { .. }`, `tool_namespace` is `None`, and `tool_name` equals `codex_code_mode::PUBLIC_TOOL_NAME`.

**Call relations**: Called only by `ToolDispatchTraceContext::start` before any event is emitted. It acts as the gatekeeper for whether a dispatch lifecycle should exist at all.

*Call graph*: called by 1 (start); 1 external calls (matches!).


##### `record_started`  (lines 200–233)

```
fn record_started(context: &EnabledToolDispatchTraceContext, invocation: ToolDispatchInvocation)
```

**Purpose**: Builds and appends the canonical `ToolCallStarted` raw event for a dispatch-level tool invocation. It computes classification, summary text, requester metadata, and an optional invocation payload file.

**Data flow**: Consumes an enabled context and owned `ToolDispatchInvocation`. It extracts `tool_name` and `tool_namespace`, computes `kind` via `dispatched_tool_kind`, `label` via `dispatched_tool_label`, and `input_preview` via `invocation.payload.log_payload_preview()`. It converts the payload into JSON with `into_json_payload`, wraps it in `DispatchedToolTraceRequest`, writes that as `RawPayloadKind::ToolInvocation`, derives requester fields with `requester_fields`, and appends `RawTraceEventPayload::ToolCallStarted` with summary and optional payload reference.

**Call relations**: Called only from `ToolDispatchTraceContext::start`. It orchestrates the helper functions that classify the tool, normalize requester metadata, and persist the invocation body.

*Call graph*: calls 5 internal fn (append_with_context_best_effort, dispatched_tool_kind, dispatched_tool_label, requester_fields, write_json_payload_best_effort); called by 1 (start).


##### `requester_fields`  (lines 235–259)

```
fn requester_fields(
    requester: ToolDispatchRequester,
) -> (
    Option<ModelVisibleCallId>,
    Option<CodeModeRuntimeToolId>,
    RawToolCallRequester,
)
```

**Purpose**: Normalizes the requester enum into the three fields expected by the raw event schema: optional model-visible call id, optional code-mode runtime tool id, and a `RawToolCallRequester` discriminator. It bridges core-facing requester data to trace-facing schema fields.

**Data flow**: Consumes a `ToolDispatchRequester`. For `Model`, it returns `(Some(model_visible_call_id), None, RawToolCallRequester::Model)`. For `CodeCell`, it returns `(None, Some(runtime_tool_call_id), RawToolCallRequester::CodeCell { runtime_cell_id })`.

**Call relations**: Used by `record_started` while constructing `ToolCallStarted`. It isolates the schema mapping so the start-recording logic stays linear.

*Call graph*: called by 1 (record_started).


##### `dispatched_tool_kind`  (lines 261–277)

```
fn dispatched_tool_kind(tool_name: &str, _payload: &ToolDispatchPayload) -> ToolCallKind
```

**Purpose**: Maps a tool name to the normalized `ToolCallKind` used in trace summaries and reducers. It groups multiple synonymous tool names into shared semantic categories.

**Data flow**: Reads `tool_name` and ignores the payload parameter. It matches known names like `exec_command`, `write_stdin`, `apply_patch`, `web_search`, `spawn_agent`, `interrupt_agent`, etc., returning the corresponding `ToolCallKind`; unknown names become `ToolCallKind::Other { name: other.to_string() }`.

**Call relations**: Called by `record_started` to classify the dispatch. The mapping is intentionally centralized here so tests can validate category behavior such as `interrupt_agent` mapping to `CloseAgent`.

*Call graph*: called by 1 (record_started).


##### `dispatched_tool_label`  (lines 279–288)

```
fn dispatched_tool_label(
    tool_name: &str,
    tool_namespace: Option<&str>,
    _payload: &ToolDispatchPayload,
) -> String
```

**Purpose**: Builds the human-readable label shown in generic tool summaries. Namespaced tools are rendered as `namespace.tool_name`; otherwise the bare tool name is used.

**Data flow**: Reads `tool_name` and optional `tool_namespace`. It returns `format!("{namespace}.{tool_name}")` when a namespace exists, else `tool_name.to_string()`.

**Call relations**: Used by `record_started` when constructing `ToolCallSummary::Generic`. It complements `dispatched_tool_kind` by producing display text rather than semantic classification.

*Call graph*: called by 1 (record_started); 1 external calls (format!).


##### `ToolDispatchPayload::log_payload_preview`  (lines 291–298)

```
fn log_payload_preview(&self) -> String
```

**Purpose**: Extracts a concise preview string from a tool invocation payload for inclusion in the start-event summary. It chooses the most user-meaningful text field for each payload variant.

**Data flow**: Borrows `self` and matches variants: `Function.arguments`, `ToolSearch.arguments.query`, `Custom.input`, or joined `LocalShell.command`. It passes the selected string to `truncate_preview` and returns the truncated preview.

**Call relations**: Called by `record_started` before the full payload is serialized. It provides lightweight summary text while the full invocation body goes into a payload file.

*Call graph*: calls 1 internal fn (truncate_preview).


##### `ToolDispatchPayload::into_json_payload`  (lines 300–333)

```
fn into_json_payload(self) -> JsonValue
```

**Purpose**: Converts an owned dispatch payload into the JSON shape persisted in the raw payload file. Each variant is tagged with a `type` field and includes its variant-specific fields.

**Data flow**: Consumes `self` and returns a `serde_json::Value`. `Function` becomes `{type:"function", arguments}`, `ToolSearch` becomes `{type:"tool_search", arguments}`, `Custom` becomes `{type:"custom", input}`, and `LocalShell` becomes a JSON object containing command, workdir, timeout, sandbox permissions, prefix rule, additional permissions, and justification.

**Call relations**: Used by `record_started` to build the `DispatchedToolTraceRequest` written as `RawPayloadKind::ToolInvocation`.

*Call graph*: 1 external calls (json!).


##### `truncate_preview`  (lines 336–344)

```
fn truncate_preview(value: &str) -> String
```

**Purpose**: Limits preview strings to 160 Unicode scalar values and appends `...` when truncation occurs. This keeps summary fields bounded without corrupting UTF-8.

**Data flow**: Accepts `&str`, iterates over `.chars()`, collects up to `MAX_PREVIEW_CHARS` into a `String`, checks whether more characters remain, and conditionally appends `...`. It returns the resulting preview string.

**Call relations**: Called only by `ToolDispatchPayload::log_payload_preview` as the shared truncation primitive for all payload variants.

*Call graph*: called by 1 (log_payload_preview).


##### `append_tool_call_ended`  (lines 346–361)

```
fn append_tool_call_ended(
    context: &EnabledToolDispatchTraceContext,
    status: ExecutionStatus,
    response: &DispatchedToolTraceResponse<'_>,
)
```

**Purpose**: Writes the result payload file for a completed or failed dispatch and appends the canonical `ToolCallEnded` raw event. It is the shared terminal-event helper for both success and failure paths.

**Data flow**: Takes an enabled context, an `ExecutionStatus`, and a borrowed `DispatchedToolTraceResponse`. It writes the response JSON as `RawPayloadKind::ToolResult`, obtaining an optional `RawPayloadRef`, then appends `RawTraceEventPayload::ToolCallEnded { tool_call_id, status, result_payload }` with thread/turn context.

**Call relations**: Called by both `ToolDispatchTraceContext::record_completed` and `ToolDispatchTraceContext::record_failed`. It delegates payload persistence and contextual append to the file-local best-effort helpers.

*Call graph*: calls 2 internal fn (append_with_context_best_effort, write_json_payload_best_effort); called by 2 (record_completed, record_failed).


##### `write_json_payload_best_effort`  (lines 363–375)

```
fn write_json_payload_best_effort(
    writer: &TraceWriter,
    kind: RawPayloadKind,
    payload: &impl Serialize,
) -> Option<RawPayloadRef>
```

**Purpose**: Persists a JSON payload through `TraceWriter` and converts write failures into warnings plus `None`. It is the file-local payload helper for dispatch tracing.

**Data flow**: Accepts a `&TraceWriter`, `RawPayloadKind`, and serializable payload reference. It calls `writer.write_json_payload(kind, payload)` and returns `Some(RawPayloadRef)` on success or logs a warning and returns `None` on error.

**Call relations**: Used by both `record_started` and `append_tool_call_ended` so dispatch tracing can remain best-effort and non-fatal.

*Call graph*: calls 1 internal fn (write_json_payload); called by 2 (append_tool_call_ended, record_started); 1 external calls (warn!).


##### `append_with_context_best_effort`  (lines 377–388)

```
fn append_with_context_best_effort(
    context: &EnabledToolDispatchTraceContext,
    payload: RawTraceEventPayload,
)
```

**Purpose**: Appends a raw event with the dispatch context's thread and turn ids, suppressing append failures to warnings. It is the common event-write helper for dispatch start and end events.

**Data flow**: Takes an enabled dispatch context and a `RawTraceEventPayload`, constructs `RawTraceEventContext { thread_id: Some(context.thread_id.clone()), codex_turn_id: Some(context.codex_turn_id.clone()) }`, and calls `context.writer.append_with_context(...)`. Errors are logged and otherwise ignored.

**Call relations**: Called by `record_started` and `append_tool_call_ended` to ensure both lifecycle edges are contextualized consistently.

*Call graph*: called by 2 (append_tool_call_ended, record_started); 1 external calls (warn!).


##### `tests::suppresses_only_noncanonical_dispatch_boundaries`  (lines 395–426)

```
fn suppresses_only_noncanonical_dispatch_boundaries()
```

**Purpose**: Verifies the suppression rule only excludes the specific noncanonical public code-mode custom dispatch and not other custom or namespaced calls. It protects against overbroad suppression.

**Data flow**: Builds several `ToolDispatchInvocation` values with the local `invocation` helper and asserts `suppresses_tool_dispatch_trace` is true only for the unnamespaced public code-mode custom case.

**Call relations**: This unit test targets `suppresses_tool_dispatch_trace` directly, documenting the intended boundary between canonical and suppressed dispatch traces.

*Call graph*: 1 external calls (assert!).


##### `tests::classifies_interrupt_agent_as_close_agent`  (lines 429–439)

```
fn classifies_interrupt_agent_as_close_agent()
```

**Purpose**: Checks that the tool-name classifier maps `interrupt_agent` into `ToolCallKind::CloseAgent`. This preserves semantic grouping for related agent-closing operations.

**Data flow**: Calls `dispatched_tool_kind` with tool name `interrupt_agent` and a sample function payload, then asserts the returned enum equals `ToolCallKind::CloseAgent`.

**Call relations**: This unit test exercises the name-to-kind mapping in `dispatched_tool_kind`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::invocation`  (lines 441–456)

```
fn invocation(
        tool_name: &str,
        tool_namespace: Option<String>,
        requester: ToolDispatchRequester,
        payload: ToolDispatchPayload,
    ) -> ToolDispatchInvocation
```

**Purpose**: Constructs a minimal `ToolDispatchInvocation` fixture for the local tests. It fills in stable thread, turn, and tool-call ids while allowing the test to vary tool name, namespace, requester, and payload.

**Data flow**: Accepts tool name, optional namespace, requester, and payload; returns a `ToolDispatchInvocation` with fixed `thread_id`, `codex_turn_id`, and `tool_call_id` strings plus the provided fields.

**Call relations**: Used by the file's tests to reduce duplication when probing suppression and classification behavior.


### `rollout-trace/src/mcp.rs`

`util` · `outgoing MCP request construction`

This module is intentionally minimal. `McpCallTraceContext` stores a single `Option<McpCallId>`; `None` means tracing is disabled and `Some(id)` means one concrete MCP backend execution has been assigned a trace-owned correlation id. The constant `MCP_CALL_ID_META_KEY` defines the private metadata field name inserted into MCP requests: `codex_bridge_mcp_call_id`.

The main behavior is `add_request_meta`. It first checks `mcp_call_id()`: if tracing is disabled, it returns the original `Option<JsonValue>` unchanged. If enabled, it tries to preserve existing metadata while adding the correlation field. When metadata is already a JSON object, it mutates that object in place by inserting the trace id string. When metadata is absent, it creates a fresh `serde_json::Map` containing only the correlation field. If metadata exists but is not an object, the function deliberately falls back to a no-op rather than coercing or rejecting it; tracing is best-effort and must not break MCP requests.

The tests cover both invariants: disabled tracing leaves metadata untouched, and enabled tracing preserves existing object fields while adding the bridge correlation key whose value matches the stored MCP call id.

#### Function details

##### `McpCallTraceContext::disabled`  (lines 20–22)

```
fn disabled() -> Self
```

**Purpose**: Constructs an MCP trace context that carries no correlation id and leaves request metadata unchanged. It is the no-op branch for callers that still want a uniform API.

**Data flow**: Returns `McpCallTraceContext { mcp_call_id: None }` with no side effects.

**Call relations**: It is chosen by `start_mcp_call_trace` when rollout tracing is not assigning an MCP call id, and causes `add_request_meta` to return its input unchanged.

*Call graph*: called by 1 (start_mcp_call_trace).


##### `McpCallTraceContext::enabled`  (lines 25–29)

```
fn enabled(mcp_call_id: McpCallId) -> Self
```

**Purpose**: Constructs an MCP trace context for one concrete backend call with a trace-owned correlation id. That id can later be embedded into request metadata.

**Data flow**: Consumes an `McpCallId`, wraps it in `Some`, and returns `McpCallTraceContext { mcp_call_id: Some(mcp_call_id) }`.

**Call relations**: It is used by `start_mcp_call_trace` and by the enabled-path test to create a context whose metadata injection behavior can be exercised.

*Call graph*: called by 2 (enabled_mcp_trace_adds_bridge_correlation_meta, start_mcp_call_trace).


##### `McpCallTraceContext::mcp_call_id`  (lines 32–34)

```
fn mcp_call_id(&self) -> Option<&str>
```

**Purpose**: Returns the stored MCP call id as an optional borrowed string slice. It hides the internal `Option<String>` representation from callers.

**Data flow**: Reads `self.mcp_call_id` and returns `self.mcp_call_id.as_deref()`, yielding `None` when disabled or `Some(&str)` when enabled.

**Call relations**: It is used by `add_request_meta` to decide whether metadata should be modified at all.

*Call graph*: called by 1 (add_request_meta).


##### `McpCallTraceContext::add_request_meta`  (lines 37–63)

```
fn add_request_meta(&self, meta: Option<JsonValue>) -> Option<JsonValue>
```

**Purpose**: Adds the bridge-private MCP correlation field to outgoing request metadata when tracing is enabled, while preserving existing object metadata. It never forces metadata into a different shape if the input is malformed.

**Data flow**: Accepts `Option<JsonValue>`. If `mcp_call_id()` returns `None`, it returns the original `meta`. If enabled and `meta` is `Some(JsonValue::Object(mut map))`, it inserts `MCP_CALL_ID_META_KEY -> JsonValue::String(mcp_call_id.to_string())` and returns the updated object. If `meta` is `None`, it creates a new `serde_json::Map`, inserts the same key/value, and returns `Some(JsonValue::Object(map))`. For any other JSON type, it returns the original `meta` unchanged.

**Call relations**: It is called during MCP request construction after a trace context has been created. Its only internal dependency is `mcp_call_id`, which abstracts the enabled/disabled split.

*Call graph*: calls 1 internal fn (mcp_call_id); 3 external calls (Object, String, new).


##### `tests::disabled_mcp_trace_leaves_request_meta_unchanged`  (lines 74–81)

```
fn disabled_mcp_trace_leaves_request_meta_unchanged()
```

**Purpose**: Verifies that disabled MCP tracing does not alter request metadata. This protects the no-op guarantee for callers.

**Data flow**: Builds a sample JSON object in `meta`, calls `McpCallTraceContext::disabled().add_request_meta(meta.clone())`, and asserts the returned value equals the original.

**Call relations**: This test exercises the disabled branch of `add_request_meta` through the public constructor.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::enabled_mcp_trace_adds_bridge_correlation_meta`  (lines 84–98)

```
fn enabled_mcp_trace_adds_bridge_correlation_meta()
```

**Purpose**: Checks that enabled MCP tracing inserts the private correlation field while preserving existing metadata fields. It also verifies the inserted value matches the context's stored id.

**Data flow**: Creates an enabled trace context with a fixed id, passes object metadata through `add_request_meta`, unwraps the resulting object, and asserts both the original `source` field and the inserted `MCP_CALL_ID_META_KEY` field have the expected values.

**Call relations**: This test covers the normal enabled-object path from `enabled` through `add_request_meta` and confirms `mcp_call_id` consistency.

*Call graph*: calls 1 internal fn (enabled); 2 external calls (assert_eq!, json!).


### reducer entry and conversation reconstruction
These files establish deterministic replay and rebuild the model-visible conversation transcript from normalized payload content and inference or compaction history.

### `rollout-trace/src/reducer/conversation.rs`

`domain_logic` · `inference request/response reduction and compaction checkpoint reduction`

This module is the core of model-visible conversation reduction. It parses normalized items from request/response/checkpoint payloads, reconciles them against prior thread snapshots, and updates `rollout.conversation_items`, per-thread `conversation_item_ids`, and inference/compaction references. The key distinction is between full snapshots and append-only deltas. Full inference requests are authoritative snapshots of live context, so `reconcile_conversation_items` can reuse matching prior items by position or by content elsewhere in the previous snapshot, but only once per snapshot. Incremental requests with `previous_response_id` and response outputs are append-only: they reconstruct the omitted prefix from the prior inference call and then require exact positional consistency.

The reducer also enforces call-id invariants: within a thread, the same model-visible `call_id` and `ConversationItemKind` cannot be reused with different content. Each sighting updates producer refs and, for reasoning items, may merge complementary readable text/summary with the same encrypted identity. Detached reconciliation is used for compaction checkpoints, where input history may reuse existing items but replacement history intentionally starts fresh ids because compaction is a rewrite boundary. After each reconciliation pass, the module triggers tool/code-cell attachment hooks and flushes pending code-cell starts, making conversation reduction the unlock point for runtime entities that were waiting on model-visible source items.

#### Function details

##### `TraceReducer::reduce_inference_request`  (lines 34–129)

```
fn reduce_inference_request(
        &mut self,
        wall_time_unix_ms: i64,
        inference_call_id: &InferenceCallId,
        thread_id: &str,
        codex_turn_id: &str,
        request_paylo
```

**Purpose**: Reduces an inference request payload into the thread's model-visible input item ids, handling both full snapshots and incremental requests that reference a previous response. It also applies post-compaction snapshot overrides for the first full request after compaction installation.

**Data flow**: Reads the request payload JSON, requires `input` to be an array, normalizes it with `normalize::normalize_model_items`, and inspects `previous_response_id`. For incremental requests, it finds the prior inference call in the same thread by matching `response_id`, reconstructs the omitted prefix from that call's request and response item ids, reconciles only the delta in append-only mode, and concatenates the ids. For full requests, it reconciles the whole normalized list in full-snapshot mode, optionally using `pending_compaction_replacement_item_ids[thread_id]` as the baseline snapshot. It appends the resulting ids to the thread, updates `thread_conversation_snapshots`, clears pending compaction replacement state when consumed, and returns the request item ids.

**Call relations**: This is called from `TraceReducer::start_inference_call` before the `InferenceCall` is inserted. It delegates item identity decisions to `reconcile_conversation_items` and thread-list mutation to `append_thread_conversation_items`.

*Call graph*: calls 3 internal fn (append_thread_conversation_items, reconcile_conversation_items, normalize_model_items); 3 external calls (new, Ok, bail!).


##### `TraceReducer::reduce_inference_response`  (lines 132–191)

```
fn reduce_inference_response(
        &mut self,
        wall_time_unix_ms: i64,
        inference_call_id: &InferenceCallId,
        response_payload: &RawPayloadRef,
    ) -> Result<Vec<String>>
```

**Purpose**: Reduces an inference response payload into conversation items produced by that inference call and appends them to the thread snapshot immediately. It also captures token usage when present.

**Data flow**: Reads the response payload JSON, requires `output_items` as an array, looks up the owning inference call to obtain `thread_id` and `codex_turn_id`, normalizes the output items, computes the append position from the current thread snapshot length, and reconciles the items in append-only mode with `ProducerRef::Inference { inference_call_id }`. It appends the resulting ids to the thread and snapshot, then parses `token_usage` via `normalize::token_usage_from_value` and stores it on the mutable `InferenceCall` if both usage and the inference record exist.

**Call relations**: This is called from `TraceReducer::complete_inference_call` whenever a terminal inference event carries a full or partial response payload. It relies on `reconcile_conversation_items` for item creation/reuse and on `append_thread_conversation_items` for thread ordering.

*Call graph*: calls 3 internal fn (append_thread_conversation_items, reconcile_conversation_items, normalize_model_items); 3 external calls (Ok, bail!, vec!).


##### `TraceReducer::reconcile_conversation_items`  (lines 193–277)

```
fn reconcile_conversation_items(
        &mut self,
        items: Vec<NormalizedConversationItem>,
        context: ReconcileItems<'_>,
    ) -> Result<Vec<String>>
```

**Purpose**: Performs the main snapshot reconciliation algorithm for normalized conversation items, deciding whether each item reuses an existing id or becomes a new `ConversationItem`. It also attaches tool/code-cell edges and resolves pending agent edges as each item is sighted.

**Data flow**: Consumes a vector of `NormalizedConversationItem` plus a `ReconcileItems` context containing thread/turn ids, timestamp, producer refs, start index, mode, and optional snapshot override. It derives the previous snapshot, iterates normalized items with offsets, checks call-id consistency, and for each item either reuses the item at the same index if `item_matches`, searches the previous snapshot for another unused matching item in full-snapshot mode, creates a new item with `create_conversation_item`, or errors on append-only mismatches. After choosing an id it updates the item from the new sighting, attaches model-visible tool and code-cell links, resolves pending agent edges, pushes the id into the result vector, and finally calls `flush_pending_code_cell_starts` before returning all ids.

**Call relations**: This is the central reconciliation engine used by both `reduce_inference_request` and `reduce_inference_response`. It delegates creation, matching, consistency checks, and sighting updates to specialized helpers.

*Call graph*: calls 5 internal fn (create_conversation_item, ensure_call_id_consistency, find_matching_snapshot_item, item_matches, update_conversation_item_from_sighting); called by 2 (reduce_inference_request, reduce_inference_response); 4 external calls (with_capacity, Ok, bail!, matches!).


##### `TraceReducer::reduce_compaction_checkpoint`  (lines 283–358)

```
fn reduce_compaction_checkpoint(
        &mut self,
        wall_time_unix_ms: i64,
        thread_id: &str,
        codex_turn_id: &str,
        compaction_id: &CompactionId,
        checkpoint_paylo
```

**Purpose**: Reduces a compaction checkpoint payload into conversation items representing the old input history, a structural compaction marker, and the installed replacement history. It returns all three pieces so the compaction reducer can record the installed boundary.

**Data flow**: Reads checkpoint JSON, extracts `input_history` and `replacement_history` arrays with `required_array`, normalizes both arrays, and reconciles input history against the current thread snapshot using `reconcile_detached_conversation_items`. It then creates a fresh `CompactionMarker` item with empty body and `ProducerRef::Compaction`, reconciles replacement history with no reuse candidates so all replacement items get fresh ids, appends input ids, marker id, and replacement ids to the thread conversation list, and returns a `ReducedCompactionCheckpoint` containing those ids.

**Call relations**: This is called only by `TraceReducer::reduce_compaction_installed_event`. It uses detached reconciliation because checkpoint histories are not reduced as ordinary inference snapshots.

*Call graph*: calls 5 internal fn (append_thread_conversation_items, create_conversation_item, reconcile_detached_conversation_items, normalize_model_items, required_array); 4 external calls (new, Ok, from_ref, vec!).


##### `TraceReducer::reconcile_detached_conversation_items`  (lines 360–402)

```
fn reconcile_detached_conversation_items(
        &mut self,
        items: Vec<NormalizedConversationItem>,
        context: DetachedReconcileItems<'_>,
    ) -> Result<Vec<String>>
```

**Purpose**: Reconciles normalized items against an explicit candidate set rather than the live thread snapshot. It is used for compaction checkpoint histories that need reuse semantics different from ordinary request/response reduction.

**Data flow**: Consumes normalized items and a `DetachedReconcileItems` context with thread/turn ids, timestamp, producer refs, and candidate item ids. For each item it checks call-id consistency, tries to find an unused matching candidate with `find_matching_snapshot_item`, otherwise creates a new item, updates the item from the new sighting, attaches model-visible tool/code-cell links, resolves pending agent edges, collects the chosen ids, and flushes pending code-cell starts before returning the ids.

**Call relations**: This helper is used by `reduce_compaction_checkpoint` for both input-history reuse and replacement-history fresh insertion.

*Call graph*: calls 3 internal fn (ensure_call_id_consistency, find_matching_snapshot_item, update_conversation_item_from_sighting); called by 1 (reduce_compaction_checkpoint); 2 external calls (with_capacity, Ok).


##### `TraceReducer::create_conversation_item`  (lines 404–430)

```
fn create_conversation_item(
        &mut self,
        thread_id: &str,
        codex_turn_id: Option<String>,
        first_seen_at_unix_ms: i64,
        item: NormalizedConversationItem,
        pr
```

**Purpose**: Allocates a new conversation item id and inserts a fully populated `ConversationItem` into the rollout. It is the only constructor for new transcript nodes in this module.

**Data flow**: Takes thread id, optional turn id, first-seen timestamp, a `NormalizedConversationItem`, and producer refs. It obtains a fresh id from `next_conversation_item_id`, then inserts a `ConversationItem` into `self.rollout.conversation_items` with copied role/channel/kind/agent metadata/body/call id and returns the new id.

**Call relations**: This is called from both reconciliation engines and from `reduce_compaction_checkpoint` when inserting the explicit compaction marker.

*Call graph*: calls 1 internal fn (next_conversation_item_id); called by 2 (reconcile_conversation_items, reduce_compaction_checkpoint).


##### `TraceReducer::update_conversation_item_from_sighting`  (lines 432–451)

```
fn update_conversation_item_from_sighting(
        &mut self,
        item_id: &str,
        normalized: &NormalizedConversationItem,
        produced_by: &[ProducerRef],
    ) -> Result<()>
```

**Purpose**: Merges additional evidence from a new sighting into an existing conversation item. For ordinary items it only adds missing producer refs; for reasoning items it may merge complementary readable body parts.

**Data flow**: Looks up `self.rollout.conversation_items[item_id]` mutably, and if the item kind is `Reasoning` calls `merge_reasoning_body` on the existing and incoming bodies. It then iterates `produced_by` and appends any producer refs not already present. It errors if the item id does not exist.

**Call relations**: This is called after reconciliation chooses an item id, from both `reconcile_conversation_items` and `reconcile_detached_conversation_items`.

*Call graph*: calls 1 internal fn (merge_reasoning_body); called by 2 (reconcile_conversation_items, reconcile_detached_conversation_items); 2 external calls (Ok, bail!).


##### `TraceReducer::append_thread_conversation_items`  (lines 453–465)

```
fn append_thread_conversation_items(
        &mut self,
        thread_id: &str,
        item_ids: &[String],
    ) -> Result<()>
```

**Purpose**: Adds conversation item ids to a thread's ordered transcript list without duplicating ids already present. It preserves thread-level conversation order independently of snapshot reconciliation.

**Data flow**: Mutably fetches the thread via `thread_mut`, iterates the provided `item_ids`, and pushes each id into `thread.conversation_item_ids` only if it is not already contained. It returns `()`.

**Call relations**: This helper is used after request, response, and compaction checkpoint reduction to expose reduced items in the thread's visible conversation sequence.

*Call graph*: called by 3 (reduce_compaction_checkpoint, reduce_inference_request, reduce_inference_response); 1 external calls (Ok).


##### `TraceReducer::find_matching_snapshot_item`  (lines 467–479)

```
fn find_matching_snapshot_item(
        &self,
        previous_snapshot: &[String],
        used_item_ids: &[String],
        normalized: &NormalizedConversationItem,
    ) -> Option<String>
```

**Purpose**: Searches a prior snapshot or candidate list for the first unused item whose stored content matches a normalized item. It supports content-based reuse during full-snapshot and detached reconciliation.

**Data flow**: Reads `previous_snapshot`, `used_item_ids`, and a normalized item, scans snapshot ids in order, skips ids already used in the current reconciliation pass, tests each remaining id with `self.item_matches`, and returns the first matching id cloned as `Option<String>`.

**Call relations**: This helper is called by both reconciliation engines when positional reuse is unavailable or inappropriate and content-based reuse is allowed.

*Call graph*: called by 2 (reconcile_conversation_items, reconcile_detached_conversation_items).


##### `TraceReducer::ensure_call_id_consistency`  (lines 481–499)

```
fn ensure_call_id_consistency(
        &self,
        thread_id: &str,
        normalized: &NormalizedConversationItem,
    ) -> Result<()>
```

**Purpose**: Enforces that a model-visible `call_id` is not reused within a thread for the same item kind but different content. This prevents ambiguous linkage between transcript items and reduced tool/code-cell nodes.

**Data flow**: If the normalized item has no `call_id`, it returns immediately. Otherwise it scans all existing `self.rollout.conversation_items`, and for any item in the same thread with the same `call_id` and `kind`, it compares content using `conversation_item_matches`; if any differ, it errors. It does not mutate state.

**Call relations**: This validation runs before item-id selection in both reconciliation engines so inconsistent call-id reuse fails replay early.

*Call graph*: calls 1 internal fn (conversation_item_matches); called by 2 (reconcile_conversation_items, reconcile_detached_conversation_items); 2 external calls (Ok, bail!).


##### `TraceReducer::item_matches`  (lines 501–506)

```
fn item_matches(&self, item_id: &str, normalized: &NormalizedConversationItem) -> bool
```

**Purpose**: Checks whether an existing conversation item id refers to content equivalent to a normalized item. It is a thin lookup wrapper around `conversation_item_matches`.

**Data flow**: Looks up `item_id` in `self.rollout.conversation_items`; if absent it returns `false`, otherwise it compares the stored item to the normalized item with `conversation_item_matches`. It is read-only.

**Call relations**: This helper is used by `reconcile_conversation_items` for positional reuse checks and by `find_matching_snapshot_item` indirectly.

*Call graph*: calls 1 internal fn (conversation_item_matches); called by 1 (reconcile_conversation_items).


##### `TraceReducer::next_conversation_item_id`  (lines 508–512)

```
fn next_conversation_item_id(&mut self) -> String
```

**Purpose**: Generates the next synthetic conversation item id in monotonically increasing ordinal order. It centralizes id allocation for transcript nodes.

**Data flow**: Reads `self.next_conversation_item_ordinal`, increments it, and returns `format!("conversation_item:{ordinal}")`. It mutates only the ordinal counter.

**Call relations**: This is called exclusively by `create_conversation_item` whenever reconciliation needs a fresh transcript node.

*Call graph*: called by 1 (create_conversation_item); 1 external calls (format!).


##### `required_array`  (lines 556–567)

```
fn required_array(
    payload: &'a Value,
    key: &str,
    raw_payload: &RawPayloadRef,
) -> Result<&'a Vec<Value>>
```

**Purpose**: Extracts a named array field from a checkpoint payload with a contextual error message that includes the raw payload id. It is a small validation helper for compaction checkpoint parsing.

**Data flow**: Reads a JSON `payload`, field `key`, and `RawPayloadRef`, attempts `payload.get(key).and_then(Value::as_array)`, and returns the borrowed array or an error mentioning `raw_payload.raw_payload_id` and the missing/non-array key.

**Call relations**: This helper is used by `reduce_compaction_checkpoint` to validate `input_history` and `replacement_history`.

*Call graph*: called by 1 (reduce_compaction_checkpoint); 1 external calls (get).


##### `conversation_item_matches`  (lines 569–587)

```
fn conversation_item_matches(
    item: &ConversationItem,
    normalized: &NormalizedConversationItem,
) -> bool
```

**Purpose**: Defines semantic equality between a stored `ConversationItem` and a normalized item. It treats reasoning items specially so encrypted identity can match even when readable text differs across sightings.

**Data flow**: Compares role, channel, kind, agent-message metadata, and call id directly. For the body it uses `reasoning_body_matches` when both sides are `Reasoning`, otherwise `conversation_body_matches`. It returns a boolean and does not mutate state.

**Call relations**: This comparison function underpins call-id consistency checks and item reuse decisions throughout conversation reconciliation.

*Call graph*: calls 2 internal fn (conversation_body_matches, reasoning_body_matches); called by 2 (ensure_call_id_consistency, item_matches).


##### `conversation_body_matches`  (lines 589–608)

```
fn conversation_body_matches(left: &ConversationBody, right: &ConversationBody) -> bool
```

**Purpose**: Compares two `ConversationBody` values part-by-part, ignoring payload-local raw ids inside JSON parts and comparing only their summaries. This makes JSON-backed items reusable across different payload observations.

**Data flow**: Checks equal part counts, zips corresponding parts, and compares each pair; `ConversationPart::Json` compares only `summary`, while all other variants use direct equality. It returns a boolean.

**Call relations**: This is the default body comparator used by `conversation_item_matches`, and it is also consulted by reasoning-specific matching and merging.

*Call graph*: called by 3 (conversation_item_matches, merge_reasoning_body, reasoning_body_matches).


##### `reasoning_body_matches`  (lines 610–628)

```
fn reasoning_body_matches(left: &ConversationBody, right: &ConversationBody) -> bool
```

**Purpose**: Determines whether two reasoning bodies represent the same logical reasoning item, allowing encrypted-content identity to override differences in readable text or summary. This accommodates request/response asymmetry in reasoning serialization.

**Data flow**: First checks `conversation_body_matches`; if that fails, it extracts the first encoded part from each body with `reasoning_encoded_part` and returns true only when both encoded `(label, value)` pairs exist and are equal. It is pure.

**Call relations**: This function is used by `conversation_item_matches` for reasoning items and by `merge_reasoning_body` to decide whether two sightings can be safely merged.

*Call graph*: calls 2 internal fn (conversation_body_matches, reasoning_encoded_part); called by 2 (conversation_item_matches, merge_reasoning_body).


##### `merge_reasoning_body`  (lines 630–673)

```
fn merge_reasoning_body(
    existing: &mut ConversationBody,
    incoming: &ConversationBody,
) -> Result<()>
```

**Purpose**: Merges complementary readable evidence from two sightings of the same encrypted reasoning item without overwriting already-recorded readable content. It preserves the first readable text/summary unless one category is missing.

**Data flow**: If the bodies already match under `conversation_body_matches`, it returns unchanged. Otherwise it requires `reasoning_body_matches` to succeed, extracts existing text and summary parts plus incoming text and summary parts, keeps existing text/summary when present and fills missing categories from the incoming body, reuses encoded parts from the existing body, and rewrites `existing.parts` as text parts + summary parts + encoded parts. It errors if encrypted identities differ.

**Call relations**: This merge logic is invoked only by `update_conversation_item_from_sighting` for `ConversationItemKind::Reasoning` items.

*Call graph*: calls 5 internal fn (conversation_body_matches, reasoning_body_matches, reasoning_encoded_parts, reasoning_summary_parts, reasoning_text_parts); called by 1 (update_conversation_item_from_sighting); 2 external calls (Ok, bail!).


##### `reasoning_text_parts`  (lines 675–680)

```
fn reasoning_text_parts(body: &ConversationBody) -> Vec<&ConversationPart>
```

**Purpose**: Returns all text parts from a reasoning body. It is a selector used during reasoning-body merging.

**Data flow**: Iterates `body.parts`, filters for `ConversationPart::Text`, and collects borrowed references into a vector. It is read-only.

**Call relations**: This helper is used by `merge_reasoning_body` when deciding whether existing or incoming readable text should be retained.

*Call graph*: called by 1 (merge_reasoning_body).


##### `reasoning_summary_parts`  (lines 682–687)

```
fn reasoning_summary_parts(body: &ConversationBody) -> Vec<&ConversationPart>
```

**Purpose**: Returns all summary parts from a reasoning body. It supports selective merging of readable reasoning summaries.

**Data flow**: Iterates `body.parts`, filters for `ConversationPart::Summary`, and collects borrowed references into a vector. It is read-only.

**Call relations**: This helper is used by `merge_reasoning_body` alongside text-part extraction.

*Call graph*: called by 1 (merge_reasoning_body).


##### `reasoning_encoded_parts`  (lines 689–694)

```
fn reasoning_encoded_parts(body: &ConversationBody) -> Vec<&ConversationPart>
```

**Purpose**: Returns all encoded parts from a reasoning body. The merge logic preserves these as the stable identity-bearing portion of the item.

**Data flow**: Iterates `body.parts`, filters for `ConversationPart::Encoded`, and collects borrowed references into a vector. It is read-only.

**Call relations**: This helper is used by `merge_reasoning_body` when reconstructing the merged body.

*Call graph*: called by 1 (merge_reasoning_body).


##### `reasoning_encoded_part`  (lines 696–704)

```
fn reasoning_encoded_part(body: &ConversationBody) -> Option<(&str, &str)>
```

**Purpose**: Extracts the first encoded reasoning part as a `(label, value)` pair for identity comparison. It is the minimal representation needed to compare encrypted reasoning blobs.

**Data flow**: Scans `body.parts` and returns the first `ConversationPart::Encoded { label, value }` as borrowed string slices, or `None` if no encoded part exists. It is pure.

**Call relations**: This helper is used by `reasoning_body_matches` to compare encrypted identities across sightings.

*Call graph*: called by 1 (reasoning_body_matches).


### `rollout-trace/src/reducer/mod.rs`

`orchestration` · `trace replay`

This module is the reducer entry surface for the crate: `replay_bundle` opens the bundle manifest and newline-delimited raw event log, constructs a `TraceReducer`, replays events in file order, then performs one final reconciliation pass for deferred spawn-edge targets before returning the finished `RolloutTrace`. The reducer state is intentionally richer than the final graph. Besides the in-progress `rollout`, it tracks conversation snapshot history per thread for transcript deduplication, pending compaction replacement item ids, a bridge from runtime-local code cell ids to reduced code-cell ids, queued code-cell starts and lifecycle events that arrive before their model-visible source item exists, and pending multi-agent interaction edges whose exact recipient transcript item has not yet been reduced.

`apply_event` is the central dispatcher. Before interpreting semantics, it extracts every `RawPayloadRef` from the event and inserts it into `rollout.raw_payloads`, preserving raw evidence independently of whether the reducer creates a typed object for that event. It then matches every `RawTraceEventPayload` variant and forwards to the appropriate reducer method in thread, inference, tool, code-cell, compaction, or conversation logic. Several branches enforce invariants eagerly with reducer errors: missing thread/turn context on compaction install, unsupported `Other` events, and code-cell lifecycle events that cannot be mapped back to a thread/runtime cell. A notable design choice is deferred resolution: some edges and code-cell events are queued rather than guessed, so replay stays strict about model-visible ownership and exact graph anchors.

#### Function details

##### `replay_bundle`  (lines 44–86)

```
fn replay_bundle(bundle_dir: impl AsRef<Path>) -> Result<RolloutTrace>
```

**Purpose**: Replays an on-disk trace bundle directory into a fully reduced `RolloutTrace`. It initializes reducer bookkeeping from the manifest, streams the raw event log line by line, and performs a final pass to resolve deferred spawn-edge fallbacks.

**Data flow**: Takes a bundle directory path-like input, reads `MANIFEST_FILE_NAME` into `TraceBundleManifest`, and uses its ids/timestamps to construct `RolloutTrace::new` plus all reducer-side maps, counters, and queues. It then opens `RAW_EVENT_LOG_FILE_NAME`, skips blank lines, parses each non-empty line as `RawTraceEvent`, feeds each event into reducer state mutation, runs pending spawn fallback resolution after the loop, and returns the completed `RolloutTrace`.

**Call relations**: This is the public entry used by tests and callers that want reduction from a local bundle. It drives the entire replay sequence by repeatedly invoking `TraceReducer::apply_event`; after all events are seen, it invokes the deferred spawn-edge resolution step because only then is it known whether a child-thread delivery item ever appeared.

*Call graph*: calls 1 internal fn (new); 9 external calls (as_ref, join, to_path_buf, new, new, open, new, from_reader, from_str).


##### `TraceReducer::read_payload_json`  (lines 139–147)

```
fn read_payload_json(&self, payload: &RawPayloadRef) -> Result<Value>
```

**Purpose**: Loads and parses a referenced raw payload file as JSON for reducer logic that needs typed fields from payload bodies. It keeps payload access centralized so subreducers can work from `RawPayloadRef` ids and paths.

**Data flow**: Takes `&self` and a `&RawPayloadRef`, joins the reducer's `bundle_dir` with `payload.path`, opens that file, parses it with `serde_json::from_reader`, and returns a `serde_json::Value`. It does not mutate reducer state; it only adds contextual error messages naming the raw payload id.

**Call relations**: This helper is called from specialized reducers when an event's semantic reduction depends on payload contents rather than just payload identity. It is delegated to by thread metadata parsing, terminal parsing, and agent-interaction parsing so those modules do not duplicate file-opening logic.

*Call graph*: 3 external calls (open, join, from_reader).


##### `TraceReducer::apply_event`  (lines 149–480)

```
fn apply_event(&mut self, event: RawTraceEvent) -> Result<()>
```

**Purpose**: Dispatches one `RawTraceEvent` into the correct typed reduction path and updates the in-progress rollout graph plus reducer-side pending state. It is the single place where raw event variants are interpreted.

**Data flow**: Consumes a `RawTraceEvent`, first iterates over `event.payload.raw_payload_refs()` and inserts each referenced payload into `rollout.raw_payloads`. It then matches on `event.payload`, updating top-level rollout fields directly for rollout start/end, or delegating to thread, turn, inference, tool, code-cell, compaction, and agent-edge reducers with event sequence numbers, timestamps, ids, statuses, and payload refs. It returns `Ok(())` on successful mutation or an error when invariants are violated, such as unsupported `Other` events or missing required thread/turn context.

**Call relations**: This function is invoked repeatedly by `replay_bundle` for every parsed log line. It delegates outward to nearly all reducer subsystems depending on the payload variant, and it calls `TraceReducer::insert_raw_payload` up front so semantic branches can assume raw payload evidence has already been recorded.

*Call graph*: calls 1 internal fn (insert_raw_payload); 1 external calls (bail!).


##### `TraceReducer::insert_raw_payload`  (lines 482–486)

```
fn insert_raw_payload(&mut self, payload: &RawPayloadRef)
```

**Purpose**: Copies a raw payload reference into the reduced trace's `raw_payloads` index. This preserves payload evidence independently of whether any typed reducer branch consumes the payload body.

**Data flow**: Takes `&mut self` and `&RawPayloadRef`, clones the payload ref, and inserts it into `self.rollout.raw_payloads` keyed by `raw_payload_id`. It returns no value and only mutates the raw-payload map.

**Call relations**: It is called only from `TraceReducer::apply_event` before payload-specific dispatch. That placement ensures every payload referenced by an event is retained once, even for event kinds like protocol breadcrumbs that do not create reduced semantic objects.

*Call graph*: called by 1 (apply_event); 1 external calls (clone).


### `rollout-trace/src/reducer/conversation/normalize.rs`

`domain_logic` · `payload parsing during conversation reduction`

This module converts raw JSON payload fragments into `NormalizedConversationItem` values containing role, channel, kind, optional agent-routing metadata, body parts, and optional model-visible `call_id`. The reducer later decides whether those normalized items reuse existing `ConversationItem` ids or become new ones. The parser covers ordinary messages, agent messages, reasoning items, function/custom-tool calls and outputs, several JSON-backed tool-call variants, and compaction summary items. Unsupported item types fail replay explicitly rather than being ignored.

Normalization is intentionally lossy in a few places to stabilize identity across payload observations. JSON-heavy items become `ConversationPart::Json` with a truncated summary plus `raw_payload_id`; equality later compares only the summary. Message content arrays are converted into text parts when possible and otherwise into `PayloadRef` placeholders so non-text content is still represented without embedding large blobs. `custom_tool_call` with `name == "exec"` becomes a `ConversationPart::Code` in JavaScript, while other custom tools become plain text input. Reasoning items collect readable content, summary text, and optional `encrypted_content`, and token usage extraction clamps negative integers to zero by using `max(0) as u64`. Agent messages are parsed through `codex_protocol::models::ResponseItem`, preserving `author` and `recipient` in `AgentMessageMetadata` and mapping encrypted content into `ConversationPart::Encoded`.

#### Function details

##### `normalize_model_items`  (lines 34–43)

```
fn normalize_model_items(
    items: &[Value],
    raw_payload: &RawPayloadRef,
) -> Result<Vec<NormalizedConversationItem>>
```

**Purpose**: Normalizes an array of raw JSON model items into `NormalizedConversationItem` values. It is the batch entry point used by request, response, and compaction checkpoint reduction.

**Data flow**: Takes a slice of `serde_json::Value` items and a `RawPayloadRef`, iterates the slice, calls `normalize_model_item` for each element, pushes each result into a vector, and returns the completed vector. It has no side effects beyond allocation.

**Call relations**: This function is called by `reduce_inference_request`, `reduce_inference_response`, and `reduce_compaction_checkpoint` before any reconciliation logic runs.

*Call graph*: calls 1 internal fn (normalize_model_item); called by 3 (reduce_compaction_checkpoint, reduce_inference_request, reduce_inference_response); 1 external calls (new).


##### `token_usage_from_value`  (lines 45–52)

```
fn token_usage_from_value(value: &Value) -> Option<TokenUsage>
```

**Purpose**: Extracts token-usage counters from a JSON object into the reducer's `TokenUsage` struct. Missing or non-integer fields cause the whole extraction to return `None`.

**Data flow**: Reads `input_tokens`, `cached_input_tokens`, `output_tokens`, and `reasoning_output_tokens` using `u64_field`; if all are present it returns `Some(TokenUsage { ... })`, otherwise `None`. It is pure.

**Call relations**: This helper is used by `TraceReducer::reduce_inference_response` when storing usage on an `InferenceCall`.

*Call graph*: calls 1 internal fn (u64_field).


##### `normalize_model_item`  (lines 54–151)

```
fn normalize_model_item(
    item: &Value,
    raw_payload: &RawPayloadRef,
) -> Result<NormalizedConversationItem>
```

**Purpose**: Dispatches normalization based on the raw item's `type` field and constructs the corresponding normalized conversation representation. It is the central parser for Responses-shaped items.

**Data flow**: Reads `item["type"]` as a string and matches it. Depending on the type it delegates to `normalize_message_item`, `normalize_agent_message_item`, `normalize_reasoning_item`, or directly constructs `NormalizedConversationItem` values using helpers like `raw_text_or_json_body`, `tool_output_body`, `custom_tool_call_body`, `json_body`, and `compaction_body`. It fills role/channel/kind/call_id according to the item type and errors on missing type or unsupported types.

**Call relations**: This function is called by `normalize_model_items` for each raw item and fans out to the specialized parsers and body builders.

*Call graph*: calls 8 internal fn (compaction_body, custom_tool_call_body, json_body, normalize_agent_message_item, normalize_message_item, normalize_reasoning_item, raw_text_or_json_body, tool_output_body); called by 1 (normalize_model_items); 2 external calls (get, bail!).


##### `normalize_message_item`  (lines 153–182)

```
fn normalize_message_item(
    item: &Value,
    raw_payload: &RawPayloadRef,
) -> Result<NormalizedConversationItem>
```

**Purpose**: Parses a standard `message` item into a normalized conversation message with role, optional channel from `phase`, and body parts from `content`. It validates that the role string is supported.

**Data flow**: Reads `role` from the JSON item, maps it through `role_from_str`, optionally maps `phase` through `channel_from_phase`, converts `content` into `ConversationPart`s with `content_parts`, and returns a `NormalizedConversationItem` with kind `Message` and no `call_id`. It errors on missing or unsupported roles.

**Call relations**: This specialized parser is selected by `normalize_model_item` for `type: "message"`.

*Call graph*: calls 2 internal fn (content_parts, role_from_str); called by 1 (normalize_model_item); 2 external calls (get, bail!).


##### `normalize_agent_message_item`  (lines 184–226)

```
fn normalize_agent_message_item(
    item: &Value,
    raw_payload: &RawPayloadRef,
) -> Result<NormalizedConversationItem>
```

**Purpose**: Parses an `agent_message` item using the protocol model so routing metadata and content variants are interpreted consistently with the wire schema. It preserves author/recipient and converts content into text or encoded parts.

**Data flow**: Clones the raw JSON item and deserializes it into `codex_protocol::models::ResponseItem`, requires the `AgentMessage` variant, maps each `AgentMessageInputContent` entry into either `ConversationPart::Text` or `ConversationPart::Encoded`, errors if the content list is empty, and returns a `NormalizedConversationItem` with role `Assistant`, channel `Analysis`, kind `Message`, and `agent_message: Some(AgentMessageMetadata { author, recipient })`.

**Call relations**: This parser is chosen by `normalize_model_item` for `type: "agent_message"`.

*Call graph*: called by 1 (normalize_model_item); 2 external calls (clone, bail!).


##### `normalize_reasoning_item`  (lines 228–282)

```
fn normalize_reasoning_item(
    item: &Value,
    raw_payload: &RawPayloadRef,
) -> Result<NormalizedConversationItem>
```

**Purpose**: Parses a `reasoning` item into a normalized reasoning body containing readable content parts, summary parts, and optional encrypted identity. It rejects reasoning items that contain none of those forms.

**Data flow**: Starts with an empty `parts` vector, appends content parts from `content` and summary parts from `summary` via `append_reasoning_parts`, then inspects `encrypted_content`: `null` is ignored, a string becomes `ConversationPart::Encoded`, and any other type errors. If no parts were collected it errors; otherwise it returns a `NormalizedConversationItem` with role `Assistant`, channel `Analysis`, kind `Reasoning`, and no `call_id`.

**Call relations**: This parser is selected by `normalize_model_item` for `type: "reasoning"`.

*Call graph*: calls 1 internal fn (append_reasoning_parts); called by 1 (normalize_model_item); 3 external calls (get, new, bail!).


##### `append_reasoning_parts`  (lines 290–355)

```
fn append_reasoning_parts(
    item: &Value,
    key: &str,
    kind: ReasoningPartKind,
    raw_payload: &RawPayloadRef,
    parts: &mut Vec<ConversationPart>,
) -> Result<()>
```

**Purpose**: Validates and appends either readable reasoning content parts or summary parts from a reasoning item field. It enforces the allowed per-entry `type` values for each field.

**Data flow**: Reads `item[key]`; if absent it returns, and if `kind` is `Content` with `Value::Null` it also returns. Otherwise it requires an array, iterates entries, validates each entry's `type` (`reasoning_text`/`text` for content, `summary_text` for summary), extracts `text` as a string, and pushes either `ConversationPart::Text` or `ConversationPart::Summary` into the mutable `parts` vector. It errors on malformed entries.

**Call relations**: This helper is called twice by `normalize_reasoning_item`, once for `content` and once for `summary`.

*Call graph*: called by 1 (normalize_reasoning_item); 3 external calls (get, bail!, matches!).


##### `role_from_str`  (lines 357–366)

```
fn role_from_str(role: &str) -> Option<ConversationRole>
```

**Purpose**: Maps raw message role strings into `ConversationRole` enum values. Unknown roles are rejected by returning `None`.

**Data flow**: Matches the input string against `system`, `developer`, `user`, `assistant`, and `tool`, returning the corresponding enum or `None`. It is pure.

**Call relations**: This helper is used by `normalize_message_item` to validate and convert the `role` field.

*Call graph*: called by 1 (normalize_message_item).


##### `channel_from_phase`  (lines 368–375)

```
fn channel_from_phase(phase: &str) -> Option<ConversationChannel>
```

**Purpose**: Maps a message `phase` string into an optional `ConversationChannel`. Unrecognized phases are ignored rather than treated as errors.

**Data flow**: Matches `commentary`, `final_answer`, and `summary` to their enum variants and returns `None` for anything else. It is pure.

**Call relations**: This helper is used by `normalize_message_item` when populating the optional channel.


##### `content_parts`  (lines 377–402)

```
fn content_parts(content: Option<&Value>, raw_payload: &RawPayloadRef) -> Vec<ConversationPart>
```

**Purpose**: Converts a message or tool-output `content` array into `ConversationPart`s, preserving text directly and representing unsupported or non-text content as payload references. It guarantees at least one part.

**Data flow**: If `content` is missing or not an array, it returns a single `PayloadRef` labeled `content`. Otherwise it iterates each part: text-like types (`input_text`, `output_text`, `text`) become `ConversationPart::Text` when they contain string `text`; `input_image` becomes a payload ref labeled `input_image`; other known/unknown types become payload refs labeled by their type; missing `type` becomes a generic `content` payload ref. If no parts were produced, it inserts an `empty_content` payload ref.

**Call relations**: This helper is used by `normalize_message_item` and by `tool_output_body` when tool output is an array of content parts.

*Call graph*: calls 1 internal fn (payload_ref_part); called by 2 (normalize_message_item, tool_output_body); 2 external calls (new, vec!).


##### `custom_tool_call_body`  (lines 404–422)

```
fn custom_tool_call_body(item: &Value, raw_payload: &RawPayloadRef) -> ConversationBody
```

**Purpose**: Builds the body for a `custom_tool_call`, treating `exec` specially as JavaScript source code and other custom tools as plain text input. If the expected string input is absent, it falls back to a JSON summary of the whole item.

**Data flow**: Reads `item["input"]` as a string; if absent it returns `json_body(item, raw_payload)`. If present and `item["name"] == "exec"`, it returns a `ConversationBody` containing one `ConversationPart::Code { language: "javascript", source }`; otherwise it returns one `ConversationPart::Text { text: input }`.

**Call relations**: This helper is used by `normalize_model_item` for `type: "custom_tool_call"`.

*Call graph*: calls 1 internal fn (json_body); called by 1 (normalize_model_item); 2 external calls (get, vec!).


##### `raw_text_or_json_body`  (lines 424–440)

```
fn raw_text_or_json_body(value: Option<&Value>, raw_payload: &RawPayloadRef) -> ConversationBody
```

**Purpose**: Interprets a function-call arguments field as either raw text or embedded JSON. This lets stringified JSON arguments normalize to structured JSON summaries while preserving non-JSON strings as text.

**Data flow**: Matches on the optional `Value`: a `String` is parsed with `serde_json::from_str::<Value>` and becomes `json_body` on success or a single `Text` part on parse failure; any non-string value becomes `json_body`; `None` becomes a single payload-ref part labeled `payload`.

**Call relations**: This helper is used by `normalize_model_item` for `type: "function_call"`.

*Call graph*: calls 1 internal fn (json_body); called by 1 (normalize_model_item); 1 external calls (vec!).


##### `tool_output_body`  (lines 442–455)

```
fn tool_output_body(output: Option<&Value>, raw_payload: &RawPayloadRef) -> ConversationBody
```

**Purpose**: Normalizes tool output into text, content parts, or JSON summary depending on the raw output shape. Missing output is represented by a payload reference.

**Data flow**: If `output` is a string it returns a single `Text` part; if it is an array it delegates to `content_parts`; if it is any other JSON value it delegates to `json_body`; if absent it returns a single payload-ref part labeled `tool_output`.

**Call relations**: This helper is used by `normalize_model_item` for both function-call and custom-tool output item types.

*Call graph*: calls 2 internal fn (content_parts, json_body); called by 1 (normalize_model_item); 1 external calls (vec!).


##### `compaction_body`  (lines 457–473)

```
fn compaction_body(item: &Value, raw_payload: &RawPayloadRef) -> Result<ConversationBody>
```

**Purpose**: Parses a compaction summary item into an encoded conversation body keyed by `encrypted_content`. It treats the encrypted summary itself as the identity-bearing content.

**Data flow**: Reads `item["encrypted_content"]` as a string and returns a `ConversationBody` containing one `ConversationPart::Encoded { label: "encrypted_content", value }`. It errors if the field is missing or not a string.

**Call relations**: This helper is used by `normalize_model_item` for `compaction`, `compaction_summary`, and `context_compaction` item types.

*Call graph*: called by 1 (normalize_model_item); 3 external calls (get, bail!, vec!).


##### `json_body`  (lines 475–482)

```
fn json_body(value: &Value, raw_payload: &RawPayloadRef) -> ConversationBody
```

**Purpose**: Wraps an arbitrary JSON value in a `ConversationPart::Json` using a summarized string plus the raw payload id. This preserves evidence of structured content without embedding the full value into equality semantics.

**Data flow**: Builds a `ConversationBody` with one `ConversationPart::Json { summary: summarize_json(value), raw_payload_id: raw_payload.raw_payload_id.clone() }` and returns it. It is pure aside from allocation.

**Call relations**: This helper is used by several normalization paths as the fallback representation for structured or unsupported content.

*Call graph*: called by 4 (custom_tool_call_body, normalize_model_item, raw_text_or_json_body, tool_output_body); 1 external calls (vec!).


##### `payload_ref_part`  (lines 484–489)

```
fn payload_ref_part(label: &str, raw_payload: &RawPayloadRef) -> ConversationPart
```

**Purpose**: Creates a `ConversationPart::PayloadRef` pointing back to the raw payload when content cannot or should not be inlined. It is a compact placeholder representation.

**Data flow**: Takes a label and `RawPayloadRef`, clones the payload id, and returns `ConversationPart::PayloadRef { label, raw_payload_id }`. It is pure.

**Call relations**: This helper is used by `content_parts` to represent missing, unsupported, or non-text content.

*Call graph*: called by 1 (content_parts).


##### `summarize_json`  (lines 491–500)

```
fn summarize_json(value: &Value) -> String
```

**Purpose**: Serializes a JSON value into a bounded-length summary string for `ConversationPart::Json`. It truncates long JSON to keep stored summaries compact.

**Data flow**: Serializes the value with `serde_json::to_string`, falling back to `"<unserializable json>"` on failure, truncates the resulting string to 240 characters if necessary, appends `...` after truncation, and returns the summary.

**Call relations**: This helper is used only by `json_body` when constructing JSON-backed conversation parts.

*Call graph*: 1 external calls (to_string).


##### `u64_field`  (lines 502–507)

```
fn u64_field(value: &Value, field: &str) -> Option<u64>
```

**Purpose**: Extracts a non-negative integer field from JSON as `u64`, clamping negative values to zero. It is a tolerant numeric helper for token usage parsing.

**Data flow**: Reads `value[field]` as `i64`, applies `max(0) as u64`, and returns `Option<u64>`. Missing or non-integer fields yield `None`.

**Call relations**: This helper is used by `token_usage_from_value` for each token counter field.

*Call graph*: called by 1 (token_usage_from_value); 1 external calls (get).


### `rollout-trace/src/reducer/inference.rs`

`domain_logic` · `inference start/completion and turn-end cleanup`

This module adds inference-call lifecycle methods to `TraceReducer`. `StartedInferenceCall` packages the raw start-event fields into one struct so callers cannot accidentally swap adjacent string arguments. `start_inference_call` validates uniqueness and turn ownership before reducing the request payload into model-visible conversation items. Only after request reduction succeeds does it insert an `InferenceCall` with a running `ExecutionWindow`, model/provider metadata, request item ids, and raw request payload id.

`close_running_inference_calls_for_turn_end` is a cleanup path used when a turn ends before an inference stream has emitted its own terminal event. It scans all inference calls for the given turn and closes only those still marked `Running`, mapping turn completion/cancellation to `ExecutionStatus::Cancelled`, preserving `Failed`, and propagating `Aborted`.

`complete_inference_call` handles all terminal inference event variants by pattern-matching `RawTraceEventPayload` into a normalized tuple of call id, terminal status, optional response id, optional upstream request id, and optional response payload. If a response payload exists—even for failed or cancelled calls—it reduces response items and stores them. When updating the `InferenceCall`, it preserves any terminal status already set by turn-end cleanup, while still recording late `upstream_request_id`, raw response payload id, and partial response item ids. This makes replay robust to asynchronous mapper events that arrive after the owning turn has already been closed.

#### Function details

##### `TraceReducer::start_inference_call`  (lines 36–106)

```
fn start_inference_call(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        started: StartedInferenceCall,
    ) -> Result<()>
```

**Purpose**: Starts an inference call, validates its thread/turn association, reduces its request payload into conversation items, and inserts the resulting `InferenceCall` record. Request reduction happens before insertion so the inference object always points at valid request item ids.

**Data flow**: Consumes event sequence/time and a `StartedInferenceCall` containing inference id, thread id, turn id, model, provider, and request payload ref. It checks for duplicate inference ids, validates that `self.rollout.codex_turns[codex_turn_id]` exists and belongs to the supplied thread, calls `reduce_inference_request` to obtain `request_item_ids`, ensures the thread exists via `thread_mut`, and inserts an `InferenceCall` into `self.rollout.inference_calls` with a running `ExecutionWindow`, copied metadata, empty response/tool-call lists, `usage: None`, and raw payload ids.

**Call relations**: This is called from outer event dispatch on inference-start events. It delegates transcript parsing to `reduce_inference_request` and establishes the inference record later updated by `complete_inference_call`.

*Call graph*: 2 external calls (new, bail!).


##### `TraceReducer::close_running_inference_calls_for_turn_end`  (lines 113–135)

```
fn close_running_inference_calls_for_turn_end(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        codex_turn_id: &str,
        turn_status: &ExecutionStatus,
    )
```

**Purpose**: Closes any inference calls that are still marked running when their owning turn ends. This prevents abandoned provider streams from appearing live in the reduced rollout.

**Data flow**: Takes turn-end sequence/time, `codex_turn_id`, and turn `ExecutionStatus`, maps the turn status to an inference terminal status (`Cancelled` for completed/cancelled turns, `Failed` for failed turns, `Aborted` for aborted turns, and no-op for running), then iterates `self.rollout.inference_calls.values_mut()` and updates `ended_at_unix_ms`, `ended_seq`, and `execution.status` for matching calls whose current status is still `Running`.

**Call relations**: This cleanup helper is invoked by turn-end orchestration before or independently of later inference terminal events. `complete_inference_call` is written to preserve the status set here if a late terminal event arrives afterward.


##### `TraceReducer::complete_inference_call`  (lines 138–226)

```
fn complete_inference_call(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        payload: RawTraceEventPayload,
    ) -> Result<()>
```

**Purpose**: Handles terminal inference events for completed, failed, or cancelled calls, optionally reducing any full or partial response payload into conversation items. It also records response ids, upstream request ids, and raw response payload ids while respecting earlier turn-end closure.

**Data flow**: Consumes event sequence/time and a `RawTraceEventPayload`, pattern-matching it into `(inference_call_id, status, response_id, upstream_request_id, response_payload)` for `InferenceCompleted`, `InferenceFailed`, or `InferenceCancelled`; any other payload errors. It verifies the inference exists, optionally reduces `response_payload` through `reduce_inference_response`, then mutably updates the `InferenceCall`: sets `response_id`, closes the execution window only if it is still `Running`, stores `upstream_request_id` when present, stores `raw_response_payload_id` when a payload exists, and replaces `response_item_ids` when response items were reduced.

**Call relations**: This is called from outer event dispatch for terminal inference events. It delegates response transcript reduction to `reduce_inference_response` and is designed to coexist with prior turn-end cleanup from `close_running_inference_calls_for_turn_end`.

*Call graph*: 1 external calls (bail!).


### `rollout-trace/src/reducer/compaction.rs`

`domain_logic` · `compaction request handling and checkpoint install`

This module adds compaction-specific lifecycle methods to `TraceReducer`. `StartedCompactionRequest` packages the raw start-event fields so callers do not pass a long sequence of adjacent strings. `start_compaction_request` validates uniqueness, confirms the referenced thread exists, checks that the referenced Codex turn exists and belongs to that thread, and then inserts a `CompactionRequest` with an `ExecutionWindow` in `Running` state plus raw request payload id, model, and provider metadata.

`complete_compaction_request` closes one request attempt by validating that the request exists and that the completion's `compaction_id` matches the one recorded at start. It updates end timestamps, terminal `ExecutionStatus`, and optional raw response payload id, but deliberately does not touch conversation history. That semantic boundary is handled by `reduce_compaction_installed_event`, which validates uniqueness and thread/turn ownership, delegates checkpoint parsing and conversation-item creation to `reduce_compaction_checkpoint`, gathers all request ids associated with the installed `compaction_id`, stores the replacement item ids in `pending_compaction_replacement_item_ids` for the next full request reconciliation, and inserts a `Compaction` record containing the marker item, input history ids, and replacement history ids. The design makes request attempts evidence of remote calls, while installation is the only event that rewrites live transcript state.

#### Function details

##### `TraceReducer::start_compaction_request`  (lines 21–76)

```
fn start_compaction_request(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        started: StartedCompactionRequest,
    ) -> Result<()>
```

**Purpose**: Begins tracking one upstream compaction request attempt and records its request payload metadata. It validates that the request id is unique and that the referenced turn belongs to the supplied thread.

**Data flow**: Consumes event sequence/time and a `StartedCompactionRequest` containing compaction id, request id, thread id, turn id, model, provider, and request payload ref. It checks `self.rollout.compaction_requests` for duplicates, ensures the thread exists via `thread_mut`, validates `self.rollout.codex_turns[codex_turn_id]` and its thread ownership, then inserts a `CompactionRequest` with a running `ExecutionWindow`, copied metadata, and `raw_request_payload_id` set from the payload ref.

**Call relations**: This is called from outer event dispatch when a compaction request starts. It does not reduce checkpoint content; it only establishes the request-attempt record later closed by `complete_compaction_request`.

*Call graph*: 1 external calls (bail!).


##### `TraceReducer::complete_compaction_request`  (lines 82–111)

```
fn complete_compaction_request(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        compaction_id: String,
        compaction_request_id: CompactionRequestId,
```

**Purpose**: Closes a previously started compaction request attempt and stores its terminal status and optional response payload id. It intentionally leaves conversation history unchanged.

**Data flow**: Takes event sequence/time, `compaction_id`, `compaction_request_id`, terminal `ExecutionStatus`, and optional `RawPayloadRef`. It mutably looks up the request in `self.rollout.compaction_requests`, verifies the completion's `compaction_id` matches the request's recorded one, then sets `execution.ended_at_unix_ms`, `execution.ended_seq`, `execution.status`, and `raw_response_payload_id` from the optional payload.

**Call relations**: This is invoked by terminal compaction-request events after `start_compaction_request` has inserted the request. It records remote-call evidence only; installation of replacement history happens separately in `reduce_compaction_installed_event`.

*Call graph*: 1 external calls (bail!).


##### `TraceReducer::reduce_compaction_installed_event`  (lines 117–171)

```
fn reduce_compaction_installed_event(
        &mut self,
        wall_time_unix_ms: i64,
        thread_id: String,
        codex_turn_id: String,
        compaction_id: String,
        checkpoint_pay
```

**Purpose**: Processes the event that makes a compaction checkpoint live in the reduced conversation graph. It creates the installed `Compaction` record and primes future request reconciliation to compare against replacement history.

**Data flow**: Consumes install time, `thread_id`, `codex_turn_id`, `compaction_id`, and checkpoint payload ref. It rejects duplicate installs, validates thread existence and turn ownership, calls `reduce_compaction_checkpoint` to obtain `input_item_ids`, `marker_item_id`, and `replacement_item_ids`, collects all matching request ids from `self.rollout.compaction_requests`, stores the replacement ids in `self.pending_compaction_replacement_item_ids[thread_id]`, and inserts a `Compaction` into `self.rollout.compactions` with install metadata and checkpoint-derived item ids.

**Call relations**: This is called when a compaction install event arrives, after any request attempts may already have been tracked. It delegates transcript-item creation to the conversation reducer and then records the installed compaction boundary for later full-request reconciliation.

*Call graph*: 1 external calls (bail!).


### `rollout-trace/src/reducer/thread.rs`

`domain_logic` · `trace replay when thread and turn lifecycle events arrive`

This module owns the reduced graph nodes that everything else hangs off of: threads and turns. `start_thread` inserts a new `AgentThread` with an `ExecutionWindow` beginning at the raw event's sequence and wall time, and it optionally parses a metadata payload into `ThreadStartedMetadata`. That metadata is authoritative for multi-agent v2 identity: if a nested `session_source.subagent.thread_spawn` object exists, the reducer derives `AgentOrigin::Spawned`, computes a stable spawn edge id, prefers metadata-provided `agent_path`, and derives a task name either from metadata or from the last non-empty path segment. Otherwise the thread is marked `AgentOrigin::Root`.

`end_thread` only marks the thread terminal; it intentionally does not imply rollout completion, which matters for child-agent shutdown. `start_codex_turn` validates that the owning thread already exists and inserts a running `CodexTurn`. `end_codex_turn` validates any thread id carried by the raw event against the turn's actual owner, marks the turn terminal, then triggers cleanup of still-running code cells and inference calls associated with that turn. The helper `thread_mut` centralizes unknown-thread errors with contextual messages, while `thread_started_metadata` reads and deserializes the metadata payload through the shared payload loader. The metadata structs are private implementation details used only to interpret optional session-source fields.

#### Function details

##### `TraceReducer::start_thread`  (lines 30–104)

```
fn start_thread(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        thread_id: String,
        agent_path: String,
        metadata_payload: Option<RawPayloadRef>,
```

**Purpose**: Creates a reduced `AgentThread` from a raw thread-start event, optionally enriching it with parsed metadata and multi-agent spawn identity. It rejects duplicate thread ids.

**Data flow**: Takes reducer state plus raw sequence/time, `thread_id`, denormalized `agent_path`, and optional `metadata_payload`. It checks for an existing thread id, optionally parses metadata via `thread_started_metadata`, derives authoritative agent path, nickname, default model, and either `AgentOrigin::Spawned` or `AgentOrigin::Root`, then inserts an `AgentThread` with a running `ExecutionWindow` and empty `conversation_item_ids` into `rollout.threads`.

**Call relations**: This method is invoked from the central `apply_event` dispatcher on `RawTraceEventPayload::ThreadStarted`. It delegates spawn-edge id construction to `spawn_edge_id` and task-name fallback derivation to `task_name_from_agent_path` so thread insertion stays focused on assembling the final `AgentThread`.

*Call graph*: 3 external calls (new, bail!, spawn_edge_id).


##### `TraceReducer::end_thread`  (lines 107–124)

```
fn end_thread(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        thread_id: String,
        status: RolloutStatus,
    ) -> Result<()>
```

**Purpose**: Marks an existing thread's execution window as ended and maps rollout-level terminal status into thread-level `ExecutionStatus`. It does not alter overall rollout status.

**Data flow**: Takes reducer state, raw sequence/time, a `thread_id`, and `RolloutStatus`. It fetches the mutable thread via `thread_mut`, writes `ended_at_unix_ms`, `ended_seq`, and a mapped `ExecutionStatus` onto the thread's `execution`, and returns `Ok(())`.

**Call relations**: Called by `apply_event` for `ThreadEnded` events. It relies on `thread_mut` for existence validation and contextual unknown-thread errors.

*Call graph*: calls 1 internal fn (thread_mut).


##### `TraceReducer::start_codex_turn`  (lines 127–156)

```
fn start_codex_turn(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        codex_turn_id: CodexTurnId,
        thread_id: String,
    ) -> Result<()>
```

**Purpose**: Creates a running `CodexTurn` inside an already-known thread. It rejects duplicate turn ids and unknown owning threads.

**Data flow**: Takes reducer state, raw sequence/time, `codex_turn_id`, and `thread_id`. It checks `rollout.codex_turns` for duplicates, validates the thread exists by calling `thread_mut`, then inserts a `CodexTurn` with the provided ids, a running `ExecutionWindow`, and empty `input_item_ids` into `rollout.codex_turns`.

**Call relations**: Invoked from `apply_event` on `CodexTurnStarted`. It uses `thread_mut` only for validation; all actual turn creation happens locally.

*Call graph*: calls 1 internal fn (thread_mut); 3 external calls (clone, new, bail!).


##### `TraceReducer::end_codex_turn`  (lines 159–197)

```
fn end_codex_turn(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        thread_id: Option<String>,
        codex_turn_id: CodexTurnId,
        status: ExecutionStatus,
```

**Purpose**: Marks a Codex turn terminal, validates any thread id carried by the raw event, and closes subordinate running work tied to that turn. It is the turn-level shutdown path.

**Data flow**: Takes reducer state, raw sequence/time, optional event thread id, `codex_turn_id`, and terminal `ExecutionStatus`. It first checks that any supplied thread id matches the stored turn owner, then mutates the turn's execution end fields and status. After updating the turn, it triggers termination of running code cells and closure of running inference calls associated with that turn.

**Call relations**: Called by `apply_event` for `CodexTurnEnded`. Beyond updating the turn itself, it delegates to turn-end cleanup helpers so unfinished code cells and inference calls do not remain running after the turn has ended.

*Call graph*: 2 external calls (bail!, clone).


##### `TraceReducer::thread_mut`  (lines 200–205)

```
fn thread_mut(&mut self, thread_id: &str) -> Result<&mut AgentThread>
```

**Purpose**: Fetches a mutable reduced thread by id with a reducer-specific unknown-thread error. It centralizes thread existence validation.

**Data flow**: Takes `&mut self` and a thread id string slice, looks up `rollout.threads.get_mut(thread_id)`, and returns `Result<&mut AgentThread>`. It does not transform the thread beyond returning the mutable reference.

**Call relations**: Used by `end_thread` and `start_codex_turn`, and likely by other reducer modules through the impl block. Its role in call flow is to provide a single contextual failure mode for unknown thread references.

*Call graph*: called by 2 (end_thread, start_codex_turn).


##### `TraceReducer::thread_started_metadata`  (lines 207–214)

```
fn thread_started_metadata(
        &self,
        metadata_payload: &RawPayloadRef,
    ) -> Result<ThreadStartedMetadata>
```

**Purpose**: Reads and deserializes a thread-start metadata payload into the private `ThreadStartedMetadata` shape. It isolates payload parsing from thread insertion logic.

**Data flow**: Takes `&self` and a `&RawPayloadRef`, loads the payload JSON via `read_payload_json`, deserializes it with `serde_json::from_value`, and returns `ThreadStartedMetadata`. It does not mutate reducer state.

**Call relations**: Called only from `start_thread` when a `metadata_payload` is present. It delegates payload file access to the shared reducer helper and keeps metadata parsing errors tied to the raw payload id.

*Call graph*: 1 external calls (from_value).


##### `ThreadStartedMetadata::thread_spawn`  (lines 228–254)

```
fn thread_spawn(&self) -> Option<ThreadSpawnMetadata>
```

**Purpose**: Extracts nested subagent spawn metadata from `session_source` and normalizes fallback fields from the outer metadata object. It returns only the subset needed to derive `AgentOrigin::Spawned`.

**Data flow**: Reads `self.session_source`, navigates to `subagent.thread_spawn`, extracts `parent_thread_id`, optional `agent_path`, optional `task_name`, and optional `agent_role`, applying fallbacks from top-level metadata fields and `task_name_from_agent_path` when needed. It returns `Option<ThreadSpawnMetadata>` and does not mutate state.

**Call relations**: Used by `start_thread` after metadata deserialization to decide whether the thread is a spawned child and to gather the authoritative child identity fields.


##### `task_name_from_agent_path`  (lines 264–270)

```
fn task_name_from_agent_path(agent_path: &str) -> String
```

**Purpose**: Derives a human-readable task name from the last non-empty segment of an agent path. It is the fallback naming rule when metadata does not provide an explicit task name.

**Data flow**: Takes an `agent_path` string slice, splits from the right on `/`, selects the first non-empty segment if any, falls back to the whole path otherwise, converts the chosen segment to `String`, and returns it. It is pure.

**Call relations**: Called from `start_thread` and `ThreadStartedMetadata::thread_spawn` when task-name metadata is absent. It provides consistent fallback naming across both metadata parsing and final origin construction.


### runtime and tool replay
These files reduce runtime execution and tool activity into replayable code-cell, tool-call, terminal, and multi-agent interaction models linked back to the transcript.

### `rollout-trace/src/reducer/code_cell.rs`

`domain_logic` · `request/response reduction and runtime event handling`

This module extends `TraceReducer` with the full lifecycle for reduced `CodeCell` objects. Its core design is that the durable identity is `code_cell:{model_visible_call_id}`, while the runtime `cell_id` is only a thread-local handle used to resolve later waits and nested tool calls. To preserve the invariant that every reduced `CodeCell` points at the exact `ConversationItem` that authored the JavaScript, `CodeCellStarted` events are queued in `pending_code_cell_starts` until the matching `CustomToolCall` item appears in reduced conversation history. While a start is queued, early lifecycle events are stored in `pending_code_cell_lifecycle_events`, sorted by `RawEventSeq`, then replayed once the cell materializes.

When a cell starts, the reducer validates thread/turn ownership, finds the source item and any already-visible output items, backfills nested tool-call links by scanning existing `rollout.tool_calls`, and inserts a `CodeCell` with `ExecutionWindow` set to running and `runtime_status` set to `Starting`. Later helpers record initial response timestamps, yielded timestamps, terminal status, and reverse producer links from conversation output items. The file also maintains the `(thread_id, runtime_cell_id) -> code_cell_id` bridge so runtime-scoped identifiers can be resolved safely even when the same runtime cell id repeats across threads. Special handling for turn termination closes still-running cells on failed/cancelled/aborted turns, but deliberately leaves yielded cells alone on normal completion because they may resume via a later `wait`.

#### Function details

##### `TraceReducer::start_or_queue_code_cell`  (lines 88–104)

```
fn start_or_queue_code_cell(&mut self, pending: PendingCodeCellStart) -> Result<()>
```

**Purpose**: Accepts a parsed code-cell start event and either materializes the `CodeCell` immediately or stores it until the model-visible source `custom_tool_call` item exists. It also rejects duplicate starts against both live and pending state.

**Data flow**: Consumes a `PendingCodeCellStart` containing event timing, thread/turn context, reduced `code_cell_id`, runtime cell id, model-visible call id, and source JS. It checks reducer state via `source_item_id_for_pending_code_cell`; if no source item is yet reduced, it inserts the payload into `self.pending_code_cell_starts`. Otherwise it forwards the same payload into `start_code_cell` and returns that result.

**Call relations**: This is the entry path for code-cell start events after outer event dispatch has parsed them. It first probes conversation-derived availability through `source_item_id_for_pending_code_cell`; only when ownership can be proven does it delegate to `TraceReducer::start_code_cell`, otherwise it preserves the event for later replay.

*Call graph*: calls 2 internal fn (source_item_id_for_pending_code_cell, start_code_cell); 1 external calls (bail!).


##### `TraceReducer::flush_pending_code_cell_starts`  (lines 110–128)

```
fn flush_pending_code_cell_starts(&mut self) -> Result<()>
```

**Purpose**: Scans queued code-cell starts and materializes any whose source conversation item has become available after inference or compaction reduction. It is the bridge that turns previously blocked runtime starts into real `CodeCell` nodes.

**Data flow**: Reads `self.pending_code_cell_starts`, tests each pending entry with `source_item_id_for_pending_code_cell`, collects ready ids into a temporary vector, removes each ready entry from the pending map, and passes it to `start_code_cell`. It mutates reducer state by shrinking the pending queue and inserting live code cells.

**Call relations**: This is invoked from conversation reconciliation paths after new model-visible items are created. It does not create cells itself; instead it identifies newly unblocked starts and hands each one to `TraceReducer::start_code_cell`.

*Call graph*: calls 2 internal fn (source_item_id_for_pending_code_cell, start_code_cell); 1 external calls (new).


##### `TraceReducer::start_code_cell`  (lines 131–211)

```
fn start_code_cell(&mut self, pending: PendingCodeCellStart) -> Result<()>
```

**Purpose**: Creates the final reduced `CodeCell` record once the source conversation item is known and validated. It seeds execution timing, source/output links, runtime metadata, and any nested tool-call edges already observed while the start was pending.

**Data flow**: Consumes a `PendingCodeCellStart`, destructures event metadata, validates uniqueness, requires a `codex_turn_id`, and checks thread/turn consistency with `validate_code_cell_turn`. It resolves the source item via `source_item_id_for_code_cell_start`, gathers output item ids with `model_visible_code_cell_item_ids`, scans `self.rollout.tool_calls` for calls whose requester is `ToolCallRequester::CodeCell { code_cell_id }`, and inserts a `CodeCell` into `self.rollout.code_cells` with an `ExecutionWindow` started at the event timestamp/seq. It then ensures the thread exists, links any already-known output items through `add_code_cell_output_item`, and replays queued lifecycle events via `flush_pending_code_cell_lifecycle_events`.

**Call relations**: This is called only after `start_or_queue_code_cell` or `flush_pending_code_cell_starts` determines the source item exists. It is the central constructor for reduced code-cell state and immediately delegates follow-up linking to output-item and lifecycle replay helpers so out-of-order traces become order-insensitive.

*Call graph*: calls 5 internal fn (add_code_cell_output_item, flush_pending_code_cell_lifecycle_events, model_visible_code_cell_item_ids, source_item_id_for_code_cell_start, validate_code_cell_turn); called by 2 (flush_pending_code_cell_starts, start_or_queue_code_cell); 2 external calls (new, bail!).


##### `TraceReducer::source_item_id_for_pending_code_cell`  (lines 214–226)

```
fn source_item_id_for_pending_code_cell(
        &self,
        pending: &PendingCodeCellStart,
    ) -> Result<Option<String>>
```

**Purpose**: Checks whether the model-visible `CustomToolCall` item for a pending code-cell start has already been reduced. It returns only the first matching item id because a start needs proof of ownership, not the full set.

**Data flow**: Reads a `PendingCodeCellStart`'s `thread_id` and `model_visible_call_id`, queries `model_visible_code_cell_item_ids` for `ConversationItemKind::CustomToolCall`, and returns the first id as `Option<String>`. It does not mutate reducer state.

**Call relations**: This helper is used by both `start_or_queue_code_cell` and `flush_pending_code_cell_starts` to decide whether a queued start can be materialized yet.

*Call graph*: calls 1 internal fn (model_visible_code_cell_item_ids); called by 2 (flush_pending_code_cell_starts, start_or_queue_code_cell).


##### `TraceReducer::record_or_queue_code_cell_initial_response`  (lines 235–267)

```
fn record_or_queue_code_cell_initial_response(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        code_cell_id: CodeCellId,
        runtime_cell_id: String,
        s
```

**Purpose**: Processes the first runtime response/status observed for a code cell, but queues it if the cell start is still pending behind conversation reduction. This preserves strict unknown-cell validation without losing fast-failure or early-yield events.

**Data flow**: Takes event sequence/time, reduced `code_cell_id`, runtime cell id, and `CodeCellRuntimeStatus`. It checks `self.rollout.code_cells`; if the cell is absent but `self.pending_code_cell_starts` contains the id, it appends a `PendingCodeCellLifecycleEventKind::InitialResponse` into the pending lifecycle map. If the cell already exists, it forwards all fields to `record_code_cell_initial_response`; otherwise it errors.

**Call relations**: This is called from runtime event dispatch for initial-response events. Depending on whether the start has already materialized, it either stores an ordered pending lifecycle event via `queue_code_cell_lifecycle_event` or delegates immediately to `TraceReducer::record_code_cell_initial_response`.

*Call graph*: calls 2 internal fn (queue_code_cell_lifecycle_event, record_code_cell_initial_response); 1 external calls (bail!).


##### `TraceReducer::record_code_cell_initial_response`  (lines 269–292)

```
fn record_code_cell_initial_response(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        code_cell_id: CodeCellId,
        runtime_cell_id: String,
        status: Co
```

**Purpose**: Updates an existing `CodeCell` with the runtime's first response metadata and current runtime status. It also records the first yielded timestamp when the status is `Yielded`.

**Data flow**: Looks up `self.rollout.code_cells[code_cell_id]` mutably, sets `runtime_cell_id`, initializes `initial_response_at_unix_ms` and `initial_response_seq` only if they were previously unset, conditionally sets `yielded_at_unix_ms` and `yielded_seq` when status is `Yielded`, and finally overwrites `runtime_status`. It returns `()` or errors if the cell is missing.

**Call relations**: This is the concrete updater used both for immediate initial-response handling and for replay from `flush_pending_code_cell_lifecycle_events` after a queued start becomes real.

*Call graph*: called by 2 (flush_pending_code_cell_lifecycle_events, record_or_queue_code_cell_initial_response); 1 external calls (bail!).


##### `TraceReducer::end_or_queue_code_cell`  (lines 300–322)

```
fn end_or_queue_code_cell(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        code_cell_id: CodeCellId,
        status: CodeCellRuntimeStatus,
    ) -> Result<()>
```

**Purpose**: Processes a terminal runtime event for a code cell, or queues that terminal status until the pending start can be materialized. It mirrors the initial-response path for end events.

**Data flow**: Consumes event sequence/time, reduced `code_cell_id`, and terminal `CodeCellRuntimeStatus`. If the cell is already present in `self.rollout.code_cells`, it calls `end_code_cell`. If the cell is absent but its start is pending, it stores a `PendingCodeCellLifecycleEventKind::Ended` in `self.pending_code_cell_lifecycle_events`; otherwise it errors.

**Call relations**: This is invoked by runtime event dispatch for code-cell end events. It either records the terminal state immediately through `TraceReducer::end_code_cell` or preserves it beside a queued start using `queue_code_cell_lifecycle_event`.

*Call graph*: calls 2 internal fn (end_code_cell, queue_code_cell_lifecycle_event); 1 external calls (bail!).


##### `TraceReducer::end_code_cell`  (lines 324–344)

```
fn end_code_cell(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        code_cell_id: CodeCellId,
        status: CodeCellRuntimeStatus,
    ) -> Result<()>
```

**Purpose**: Marks an existing `CodeCell` as ended and translates runtime status into the broader `ExecutionStatus` used by the rollout graph. It also backfills initial-response timing if the cell ended before any explicit initial-response event was recorded.

**Data flow**: Mutably reads `self.rollout.code_cells[code_cell_id]`, initializes `initial_response_at_unix_ms`/`initial_response_seq` if absent, sets `execution.ended_at_unix_ms`, `execution.ended_seq`, and `execution.status` using `execution_status_for_code_cell(status)`, then stores the terminal `runtime_status`. It returns `()` or errors if the cell is unknown.

**Call relations**: This is the terminal-state primitive used by direct end handling, queued lifecycle replay, and turn-end cleanup in `terminate_running_code_cells_for_turn_end`.

*Call graph*: calls 1 internal fn (execution_status_for_code_cell); called by 3 (end_or_queue_code_cell, flush_pending_code_cell_lifecycle_events, terminate_running_code_cells_for_turn_end); 1 external calls (bail!).


##### `TraceReducer::terminate_running_code_cells_for_turn_end`  (lines 353–382)

```
fn terminate_running_code_cells_for_turn_end(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        codex_turn_id: &str,
        turn_status: &ExecutionStatus,
    ) ->
```

**Purpose**: Closes still-running code cells when their owning turn ends abnormally, preventing completed traces from showing abandoned JS frames as live. It intentionally ignores normal completion because yielded cells may continue across turns via `wait`.

**Data flow**: Reads the turn's `ExecutionStatus`, maps `Failed` to `CodeCellRuntimeStatus::Failed` and `Cancelled`/`Aborted` to `Terminated`, then scans `self.rollout.code_cells` for cells with matching `codex_turn_id` and `execution.status == Running`. For each matching id it calls `end_code_cell` with the turn-end sequence/time and derived runtime status.

**Call relations**: This is called from turn-end orchestration, after the turn status is known. It delegates actual mutation to `end_code_cell` for each affected cell.

*Call graph*: calls 1 internal fn (end_code_cell).


##### `TraceReducer::queue_code_cell_lifecycle_event`  (lines 384–395)

```
fn queue_code_cell_lifecycle_event(
        &mut self,
        code_cell_id: CodeCellId,
        event: PendingCodeCellLifecycleEvent,
    )
```

**Purpose**: Stores an early lifecycle event for a code cell whose start is still pending and keeps the queue ordered by raw event sequence. This preserves original event ordering across delayed materialization.

**Data flow**: Takes a reduced `code_cell_id` and a `PendingCodeCellLifecycleEvent`, pushes the event into `self.pending_code_cell_lifecycle_events[code_cell_id]`, then sorts that vector by `event.seq`. It mutates only the pending lifecycle-event map.

**Call relations**: This helper is used by both `record_or_queue_code_cell_initial_response` and `end_or_queue_code_cell` when runtime lifecycle events arrive before the source conversation item exists.

*Call graph*: called by 2 (end_or_queue_code_cell, record_or_queue_code_cell_initial_response).


##### `TraceReducer::flush_pending_code_cell_lifecycle_events`  (lines 397–422)

```
fn flush_pending_code_cell_lifecycle_events(&mut self, code_cell_id: &str) -> Result<()>
```

**Purpose**: Replays any queued initial-response and end events after a code cell has been created. It ensures fast or failed cells retain their runtime history even when all lifecycle events arrived before conversation reduction caught up.

**Data flow**: Removes the vector of pending events for the given `code_cell_id` from `self.pending_code_cell_lifecycle_events`. It iterates in stored order and dispatches each event by matching its enum variant: `InitialResponse` calls `record_code_cell_initial_response`, and `Ended` calls `end_code_cell` with the saved sequence/time/status.

**Call relations**: This is called at the end of `start_code_cell` so a newly inserted `CodeCell` immediately absorbs any lifecycle events that were queued while its start was blocked.

*Call graph*: calls 2 internal fn (end_code_cell, record_code_cell_initial_response); called by 1 (start_code_cell).


##### `TraceReducer::link_tool_call_to_code_cell`  (lines 428–445)

```
fn link_tool_call_to_code_cell(
        &mut self,
        tool_call_id: &ToolCallId,
        requester: &ToolCallRequester,
    ) -> Result<()>
```

**Purpose**: Adds a nested tool call id to its parent code cell when the tool requester is `ToolCallRequester::CodeCell`. It silently skips unresolved parents because queued starts are backfilled later.

**Data flow**: Reads the `requester`; if it is not `ToolCallRequester::CodeCell`, it returns immediately. Otherwise it looks up the parent cell in `self.rollout.code_cells` and, if present, appends `tool_call_id` to `cell.nested_tool_call_ids` using `push_unique` to avoid duplicates.

**Call relations**: This is called from tool-call reduction after a tool call has been reduced. If the parent code cell already exists it links immediately; if not, `start_code_cell` later reconstructs the relationship by scanning existing tool calls.

*Call graph*: calls 1 internal fn (push_unique).


##### `TraceReducer::link_wait_tool_call_from_request_payload`  (lines 451–499)

```
fn link_wait_tool_call_from_request_payload(
        &mut self,
        thread_id: &str,
        tool_call_id: &ToolCallId,
        request_payload: Option<&RawPayloadRef>,
    ) -> Result<()>
```

**Purpose**: Infers a `wait` tool call's relationship to a code cell by parsing the runtime `cell_id` embedded in the tool invocation arguments. This covers waits, which are model-visible tool calls rather than nested JS tool requests.

**Data flow**: Accepts `thread_id`, `tool_call_id`, and an optional `RawPayloadRef`. If no payload exists, or the payload JSON's `tool_name` is not `wait`, it returns. Otherwise it reads the payload JSON, extracts `payload.arguments` as a string, parses that string into JSON, extracts `cell_id`, resolves it to a reduced code-cell id with `code_cell_id_for_runtime_cell_id_if_known`, and if the cell exists appends `tool_call_id` to `cell.wait_tool_call_ids` via `push_unique`. It errors on malformed wait payloads missing arguments or `cell_id`.

**Call relations**: This runs during tool-call reduction for invocation payloads. It depends on the runtime-id bridge maintained elsewhere and only links when the referenced runtime cell is already known in the same thread.

*Call graph*: calls 2 internal fn (code_cell_id_for_runtime_cell_id_if_known, push_unique); 2 external calls (bail!, from_str).


##### `TraceReducer::attach_model_visible_code_cell_item`  (lines 505–526)

```
fn attach_model_visible_code_cell_item(
        &mut self,
        item_id: &str,
        call_id: Option<&str>,
        kind: &ConversationItemKind,
    ) -> Result<()>
```

**Purpose**: Links a later-observed model-visible `custom_tool_call_output` conversation item back to its existing code cell. This lets conversation history reference code-cell output without copying runtime bytes into the runtime node itself.

**Data flow**: Takes a conversation `item_id`, optional `call_id`, and item `kind`. It returns early unless `call_id` is present and `kind` is `ConversationItemKind::CustomToolCallOutput`. It derives the reduced code-cell id with `reduced_code_cell_id_for_model_visible_call`, checks whether that cell exists in `self.rollout.code_cells`, and if so delegates to `add_code_cell_output_item` to update both the cell and the conversation item producer list.

**Call relations**: This is invoked from conversation reconciliation whenever a model-visible item is reduced. It only acts for custom-tool output items and relies on `add_code_cell_output_item` for the actual reverse-link mutation.

*Call graph*: calls 2 internal fn (add_code_cell_output_item, reduced_code_cell_id_for_model_visible_call).


##### `TraceReducer::code_cell_event_thread_id`  (lines 533–555)

```
fn code_cell_event_thread_id(
        &self,
        thread_id: Option<String>,
        codex_turn_id: Option<&str>,
        runtime_cell_id: &str,
        event_name: &str,
    ) -> Result<String>
```

**Purpose**: Resolves the owning thread id for a code-cell runtime event, preferring the explicit thread id but falling back to the event's Codex turn id. This centralizes compatibility logic for older/raw event paths.

**Data flow**: Consumes optional `thread_id`, optional `codex_turn_id`, `runtime_cell_id`, and `event_name`. If `thread_id` is present it returns it unchanged. Otherwise it requires `codex_turn_id`, looks up `self.rollout.codex_turns[codex_turn_id]`, and returns that turn's `thread_id`; missing data produces contextual errors mentioning the event and runtime cell.

**Call relations**: This helper is used by outer code-cell event dispatch before runtime ids are resolved. It avoids duplicating thread-resolution logic in each event arm.

*Call graph*: 1 external calls (bail!).


##### `TraceReducer::reduced_code_cell_id_for_model_visible_call`  (lines 558–566)

```
fn reduced_code_cell_id_for_model_visible_call(
        &self,
        model_visible_call_id: &str,
    ) -> CodeCellId
```

**Purpose**: Builds the stable reduced code-cell id from the model-visible `exec` call id. This encodes the design choice that model-visible call identity, not runtime cell id, is the durable graph anchor.

**Data flow**: Takes `model_visible_call_id: &str` and returns `format!("code_cell:{model_visible_call_id}")`. It does not read or mutate reducer state.

**Call relations**: This helper is used when conversation reduction needs to attach model-visible output items back to an existing code cell.

*Call graph*: called by 1 (attach_model_visible_code_cell_item); 1 external calls (format!).


##### `TraceReducer::record_runtime_code_cell_id`  (lines 572–591)

```
fn record_runtime_code_cell_id(
        &mut self,
        thread_id: &str,
        runtime_cell_id: &str,
        code_cell_id: &str,
    ) -> Result<()>
```

**Purpose**: Registers the mapping from a thread-local runtime `cell_id` to the stable reduced code-cell id. It enforces that the same `(thread, runtime_cell_id)` pair cannot point at two different reduced cells.

**Data flow**: Builds a composite key with `runtime_code_cell_key(thread_id, runtime_cell_id)`, checks `self.code_cell_ids_by_runtime` for an existing mapping, returns success if it already matches, errors if it conflicts, and otherwise inserts `code_cell_id.to_string()` into the map.

**Call relations**: This is called by outer event reduction when a runtime cell id first becomes associated with a reduced code cell. Later resolution helpers and wait/nested-tool linking depend on this bridge.

*Call graph*: calls 1 internal fn (runtime_code_cell_key); 1 external calls (bail!).


##### `TraceReducer::code_cell_id_for_runtime_cell_id`  (lines 594–607)

```
fn code_cell_id_for_runtime_cell_id(
        &self,
        thread_id: &str,
        runtime_cell_id: &str,
        event_name: &str,
    ) -> Result<CodeCellId>
```

**Purpose**: Resolves a runtime `cell_id` within a thread to the reduced `CodeCellId`, failing with a contextual error if the mapping is unknown. It is the strict lookup variant used when the caller requires the edge to exist.

**Data flow**: Reads `thread_id`, `runtime_cell_id`, and `event_name`, delegates to `code_cell_id_for_runtime_cell_id_if_known`, and wraps a missing result with an error mentioning the event and thread. It does not mutate state.

**Call relations**: This is used by `reduce_tool_call_requester` when converting runtime-scoped nested-tool requesters into stable reduced graph requesters.

*Call graph*: calls 1 internal fn (code_cell_id_for_runtime_cell_id_if_known); called by 1 (reduce_tool_call_requester).


##### `TraceReducer::code_cell_id_for_runtime_cell_id_if_known`  (lines 609–617)

```
fn code_cell_id_for_runtime_cell_id_if_known(
        &self,
        thread_id: &str,
        runtime_cell_id: &str,
    ) -> Option<CodeCellId>
```

**Purpose**: Performs the optional lookup from `(thread_id, runtime_cell_id)` to reduced `CodeCellId`. It is the lenient variant used when missing mappings should simply defer linking.

**Data flow**: Constructs the composite key with `runtime_code_cell_key`, reads `self.code_cell_ids_by_runtime`, and returns a cloned `Option<CodeCellId>`. It does not mutate reducer state.

**Call relations**: This helper underpins both the strict resolver `code_cell_id_for_runtime_cell_id` and the best-effort wait-linking path in `link_wait_tool_call_from_request_payload`.

*Call graph*: calls 1 internal fn (runtime_code_cell_key); called by 2 (code_cell_id_for_runtime_cell_id, link_wait_tool_call_from_request_payload).


##### `TraceReducer::reduce_tool_call_requester`  (lines 623–638)

```
fn reduce_tool_call_requester(
        &self,
        thread_id: &str,
        requester: RawToolCallRequester,
    ) -> Result<ToolCallRequester>
```

**Purpose**: Converts a raw tool-call requester from event payloads into the reduced `ToolCallRequester` enum used in the rollout graph. For code-mode requesters it replaces the runtime cell handle with the stable reduced code-cell id.

**Data flow**: Consumes `thread_id` and a `RawToolCallRequester`. It maps `RawToolCallRequester::Model` directly to `ToolCallRequester::Model`; for `RawToolCallRequester::CodeCell { runtime_cell_id }` it resolves the runtime id through `code_cell_id_for_runtime_cell_id` and returns `ToolCallRequester::CodeCell { code_cell_id }`.

**Call relations**: This is called during tool-call reduction at the boundary between raw event payloads and reduced graph state. It delegates runtime-id resolution to the strict lookup helper so nested tool calls cannot attach to unknown cells.

*Call graph*: calls 1 internal fn (code_cell_id_for_runtime_cell_id).


##### `TraceReducer::validate_code_cell_turn`  (lines 640–655)

```
fn validate_code_cell_turn(&self, thread_id: &str, codex_turn_id: &str) -> Result<()>
```

**Purpose**: Checks that a code-cell start references an existing thread and an existing Codex turn that belongs to that thread. It prevents cross-thread or dangling turn associations from entering reduced state.

**Data flow**: Reads `thread_id` and `codex_turn_id`, verifies `self.rollout.threads` contains the thread, fetches `self.rollout.codex_turns[codex_turn_id]`, and compares `turn.thread_id` to the supplied thread. It returns `()` on success or errors on any mismatch.

**Call relations**: This validation is performed inside `start_code_cell` before the reducer inserts the `CodeCell`.

*Call graph*: called by 1 (start_code_cell); 1 external calls (bail!).


##### `TraceReducer::model_visible_code_cell_item_ids`  (lines 657–673)

```
fn model_visible_code_cell_item_ids(
        &self,
        thread_id: &str,
        call_id: &str,
        kind: ConversationItemKind,
    ) -> Vec<String>
```

**Purpose**: Finds conversation items in a thread that share a given model-visible call id and item kind. It is the common query used to locate both the source `custom_tool_call` item and any `custom_tool_call_output` items.

**Data flow**: Scans `self.rollout.conversation_items.values()`, filters by `item.thread_id == thread_id`, `item.call_id == Some(call_id)`, and `item.kind == kind`, then collects matching `item_id` strings into a vector. It is read-only.

**Call relations**: This helper supports source-item discovery for pending and starting code cells and output-item collection during `start_code_cell`.

*Call graph*: called by 3 (source_item_id_for_code_cell_start, source_item_id_for_pending_code_cell, start_code_cell).


##### `TraceReducer::source_item_id_for_code_cell_start`  (lines 675–694)

```
fn source_item_id_for_code_cell_start(
        &self,
        thread_id: &str,
        code_cell_id: &str,
        model_visible_call_id: &str,
    ) -> Result<String>
```

**Purpose**: Resolves the required source `CustomToolCall` conversation item for a code-cell start and errors if none was observed. It is the strict version used once the reducer has decided the start should materialize now.

**Data flow**: Queries `model_visible_code_cell_item_ids` for `ConversationItemKind::CustomToolCall`, takes the first result, and returns it as `String`. If no item exists, it produces an error naming both the reduced code-cell id and the model-visible call id.

**Call relations**: This is called from `start_code_cell` after turn validation, when the reducer is ready to construct the final `CodeCell` and needs a guaranteed source item id.

*Call graph*: calls 1 internal fn (model_visible_code_cell_item_ids); called by 1 (start_code_cell).


##### `TraceReducer::add_code_cell_output_item`  (lines 696–712)

```
fn add_code_cell_output_item(&mut self, code_cell_id: &str, item_id: &str) -> Result<()>
```

**Purpose**: Adds a conversation output item id to a code cell and adds the reciprocal `ProducerRef::CodeCell` to the conversation item. It keeps both sides of the relationship synchronized and deduplicated.

**Data flow**: Looks up the target `CodeCell` mutably, appends `item_id` to `cell.output_item_ids` via `push_unique`, then looks up the `ConversationItem` mutably and pushes `ProducerRef::CodeCell { code_cell_id }` into `item.produced_by` if absent. It errors if either side is missing.

**Call relations**: This helper is used both when a code cell starts and already has visible output items, and later when conversation reduction observes a new `custom_tool_call_output` item for an existing cell.

*Call graph*: calls 1 internal fn (push_unique); called by 2 (attach_model_visible_code_cell_item, start_code_cell); 1 external calls (bail!).


##### `execution_status_for_code_cell`  (lines 715–724)

```
fn execution_status_for_code_cell(status: &CodeCellRuntimeStatus) -> ExecutionStatus
```

**Purpose**: Maps fine-grained `CodeCellRuntimeStatus` values into the coarser `ExecutionStatus` stored in `ExecutionWindow`. It preserves running semantics for `Starting`, `Running`, and `Yielded` while translating terminal runtime states to completed/failed/cancelled.

**Data flow**: Takes a borrowed `CodeCellRuntimeStatus` and returns the corresponding `ExecutionStatus` by pattern match. It is pure and stateless.

**Call relations**: This function is used only by `TraceReducer::end_code_cell` when finalizing a code cell's execution window.

*Call graph*: called by 1 (end_code_cell).


##### `push_unique`  (lines 726–730)

```
fn push_unique(items: &mut Vec<String>, item_id: &str)
```

**Purpose**: Appends a string id to a vector only if that exact id is not already present. It is a small deduplication helper for relationship lists.

**Data flow**: Mutably reads a `Vec<String>` and an `item_id`, scans for equality, and pushes `item_id.to_string()` only when absent. It mutates the vector in place and returns nothing.

**Call relations**: This helper is reused by code-cell output linking, nested tool-call linking, and wait-tool linking to keep edge lists free of duplicates.

*Call graph*: called by 3 (add_code_cell_output_item, link_tool_call_to_code_cell, link_wait_tool_call_from_request_payload).


##### `runtime_code_cell_key`  (lines 732–734)

```
fn runtime_code_cell_key(thread_id: &str, runtime_cell_id: &str) -> (String, String)
```

**Purpose**: Builds the composite map key used to scope runtime cell ids by thread. This prevents collisions when the same runtime `cell_id` appears in different threads.

**Data flow**: Takes `thread_id` and `runtime_cell_id` and returns a `(String, String)` tuple containing owned copies of both. It is pure and stateless.

**Call relations**: This helper is used by both runtime-id recording and lookup so they share the same thread-scoped key format.

*Call graph*: called by 2 (code_cell_id_for_runtime_cell_id_if_known, record_runtime_code_cell_id).


### `rollout-trace/src/reducer/tool.rs`

`domain_logic` · `trace replay during tool lifecycle events and transcript back-linking`

This module turns raw tool lifecycle events into reduced `ToolCall` objects while coordinating several adjacent domains. `ToolCallStarted` is a typed wrapper for the raw start-event fields so the dispatcher can pass one structured argument instead of a long positional list. `start_tool_call` validates uniqueness of both `tool_call_id` and optional `model_visible_call_id`, resolves the owning thread either directly or through the referenced Codex turn, validates thread/turn consistency, reduces the requester, and discovers any already-reduced model-visible call/output conversation items for the same call id. It may also create a terminal operation immediately from the canonical invocation payload for direct tools like `write_stdin`, replacing the generic summary with `ToolCallSummary::Terminal` when appropriate.

After insertion, the module performs several reverse-link repairs that matter because replay order is not guaranteed to be transcript-first: it links the tool to a code cell if the requester came from one, associates the tool with any inference response that emitted its call item, attaches already-known output items as `ProducerRef::Tool`, and synchronizes terminal model observations. Runtime begin/end events append unique raw runtime payload ids and may create or complete terminal operations or multi-agent interaction edges. `end_tool_call` records terminal status and result payload ids, optionally ends a terminal operation from the canonical result when no runtime payloads exist, and attaches result payload evidence to any agent interaction edge. The remaining helpers enforce invariants and maintain one-to-one mappings between model-visible call ids and reduced tool calls.

#### Function details

##### `TraceReducer::start_tool_call`  (lines 48–169)

```
fn start_tool_call(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        thread_id: Option<String>,
        codex_turn_id: Option<String>,
        started: ToolCallStar
```

**Purpose**: Creates a reduced `ToolCall` from a raw tool-start event, validates identity invariants, and establishes all immediately knowable links to transcript, terminal, code-cell, and inference structures. It is the main entry for tool reduction.

**Data flow**: Takes reducer state, raw sequence/time, optional thread id, optional turn id, and a `ToolCallStarted` bundle. It rejects duplicate tool ids, ensures the optional model-visible call id is not already claimed by another tool, resolves and validates the owning thread/turn, reduces requester information, gathers existing model-visible call/output item ids, optionally starts a terminal operation from the invocation payload, stores raw invocation payload id, inserts a running `ToolCall` into `rollout.tool_calls`, then post-processes links to code cells, inference responses, output items, and terminal observations.

**Call relations**: Called by `apply_event` on `ToolCallStarted`. It delegates thread resolution to `tool_thread_id`, consistency checks to `validate_tool_turn`, uniqueness checks to `ensure_unique_model_visible_tool_call`, terminal creation to terminal subreducers, and reverse-link maintenance to `add_tool_output_item` and `link_tool_to_inference_response`.

*Call graph*: calls 5 internal fn (add_tool_output_item, ensure_unique_model_visible_tool_call, link_tool_to_inference_response, tool_thread_id, validate_tool_turn); 2 external calls (new, bail!).


##### `TraceReducer::assign_mcp_tool_call_correlation`  (lines 172–184)

```
fn assign_mcp_tool_call_correlation(
        &mut self,
        tool_call_id: ToolCallId,
        mcp_call_id: McpCallId,
    ) -> Result<()>
```

**Purpose**: Stores the bridge-visible MCP call id on an already-created tool call. It enforces that correlation is assigned exactly once.

**Data flow**: Takes mutable reducer state, a `tool_call_id`, and an `McpCallId`. It looks up the tool call in `rollout.tool_calls`, replaces `mcp_call_id` if currently `None`, errors if the tool is unknown or already had a correlation, and returns `Ok(())`.

**Call relations**: Invoked from `apply_event` when an `McpToolCallCorrelationAssigned` event arrives after the generic tool call exists. It does not delegate further because the operation is a simple in-place enrichment.

*Call graph*: 1 external calls (bail!).


##### `TraceReducer::end_tool_call`  (lines 190–230)

```
fn end_tool_call(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        tool_call_id: ToolCallId,
        status: ExecutionStatus,
        result_payload: Option<RawPayl
```

**Purpose**: Marks a tool call terminal, records its canonical result payload, optionally completes a terminal operation from that result, and attaches result evidence to any agent interaction edge. It is the generic tool-end reducer.

**Data flow**: Takes reducer state, raw sequence/time, `tool_call_id`, terminal `ExecutionStatus`, and optional result payload ref. It mutates the matching `ToolCall` execution end fields and `raw_result_payload_id`, captures whether terminal completion should come from the result payload, optionally calls `end_terminal_operation`, then forwards the result payload ref to agent-edge attachment logic. It returns `Ok(())` or errors on unknown tool ids.

**Call relations**: Called by `apply_event` for `ToolCallEnded`. It delegates terminal completion only when the tool has a terminal operation and no runtime payloads were recorded, and it delegates payload propagation to `attach_agent_interaction_tool_result` so pending or resolved agent edges retain the canonical result evidence.

*Call graph*: 2 external calls (bail!, clone).


##### `TraceReducer::start_tool_runtime_observation`  (lines 236–293)

```
fn start_tool_runtime_observation(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        tool_call_id: ToolCallId,
        runtime_payload: RawPayloadRef,
    ) -> Resul
```

**Purpose**: Processes a runtime-begin payload for an existing tool call, recording raw runtime evidence and creating richer runtime-derived children such as terminal operations or agent edges. It is the runtime-start enrichment path.

**Data flow**: Takes reducer state, raw sequence/time, `tool_call_id`, and runtime payload ref. It looks up the tool call, appends the runtime payload id uniquely to `raw_runtime_payload_ids`, checks whether creating another terminal operation would be invalid, optionally starts a terminal operation from the runtime payload, updates the tool summary and `terminal_operation_id` if one was newly created, synchronizes terminal model observations when relevant, and starts any supported agent interaction from the runtime payload.

**Call relations**: Invoked from `apply_event` on `ToolCallRuntimeStarted`. It delegates terminal parsing/creation to terminal subreducers and multi-agent edge creation to `start_agent_interaction_from_runtime`, while using `push_unique` locally to preserve runtime payload ids without duplication.

*Call graph*: calls 1 internal fn (push_unique); 2 external calls (bail!, matches!).


##### `TraceReducer::end_tool_runtime_observation`  (lines 296–334)

```
fn end_tool_runtime_observation(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        tool_call_id: ToolCallId,
        status: ExecutionStatus,
        runtime_payload
```

**Purpose**: Processes a runtime-end payload for an existing tool call, recording raw runtime evidence and completing any runtime-backed terminal or agent interaction state. It is the runtime-end counterpart to runtime-start reduction.

**Data flow**: Takes reducer state, raw sequence/time, `tool_call_id`, terminal status, and runtime payload ref. It appends the runtime payload id uniquely to the tool call, captures the owning thread and optional terminal operation id, optionally ends the terminal operation with the runtime payload as response evidence, then ends or enriches any agent interaction derived from that runtime payload.

**Call relations**: Called by `apply_event` for `ToolCallRuntimeEnded`. It delegates terminal completion to `end_terminal_operation` and multi-agent completion to `end_agent_interaction_from_runtime`.

*Call graph*: calls 1 internal fn (push_unique); 1 external calls (bail!).


##### `TraceReducer::attach_model_visible_tool_item`  (lines 341–370)

```
fn attach_model_visible_tool_item(
        &mut self,
        item_id: &str,
        call_id: Option<&str>,
        kind: &ConversationItemKind,
    ) -> Result<()>
```

**Purpose**: Back-links a newly reduced conversation item to its corresponding tool call when transcript reduction observes the item after the tool object already exists. It keeps tool/transcript relationships correct despite replay ordering.

**Data flow**: Takes mutable reducer state, a conversation `item_id`, optional model-visible `call_id`, and the item's `ConversationItemKind`. If no call id is present it returns immediately. Otherwise it resolves the unique tool for that call id and, depending on whether the item is a call item or output item, appends the item id to the appropriate tool field, updates inference-response linkage, and re-syncs terminal model observations.

**Call relations**: This is called from transcript/conversation reduction when model-visible tool items are materialized. It delegates tool lookup to `single_tool_for_model_visible_call`, then uses `add_tool_call_item`, `add_tool_output_item`, and `link_tool_to_inference_response` to update the already-inserted tool.

*Call graph*: calls 4 internal fn (add_tool_call_item, add_tool_output_item, link_tool_to_inference_response, single_tool_for_model_visible_call).


##### `TraceReducer::tool_thread_id`  (lines 372–390)

```
fn tool_thread_id(
        &self,
        thread_id: Option<String>,
        codex_turn_id: Option<&str>,
    ) -> Result<String>
```

**Purpose**: Resolves the owning thread id for a tool-start event from either explicit thread context or the referenced Codex turn. It enforces that at least one source of ownership is present.

**Data flow**: Takes `&self`, an optional owned thread id, and an optional turn id string slice. It returns the explicit thread id if present; otherwise it looks up the turn in `rollout.codex_turns` and returns that turn's thread id clone; if neither is available or the turn is unknown, it returns an error.

**Call relations**: Used only by `start_tool_call` before tool insertion. It isolates the event-context resolution logic so the main start path can work with a concrete thread id.

*Call graph*: called by 1 (start_tool_call); 1 external calls (bail!).


##### `TraceReducer::validate_tool_turn`  (lines 392–409)

```
fn validate_tool_turn(&self, thread_id: &str, codex_turn_id: Option<&str>) -> Result<()>
```

**Purpose**: Checks that a tool-start event references an existing thread and, when a Codex turn is supplied, that the turn exists and belongs to that same thread. It prevents cross-thread tool attribution.

**Data flow**: Takes `&self`, a resolved thread id, and an optional turn id. It verifies `rollout.threads` contains the thread, optionally verifies `rollout.codex_turns` contains the turn, and compares `turn.thread_id` against the supplied thread id. It returns `Ok(())` or a reducer error.

**Call relations**: Called by `start_tool_call` immediately after `tool_thread_id`. It performs validation only and delegates nothing further.

*Call graph*: called by 1 (start_tool_call); 1 external calls (bail!).


##### `TraceReducer::ensure_unique_model_visible_tool_call`  (lines 411–425)

```
fn ensure_unique_model_visible_tool_call(
        &self,
        model_visible_call_id: Option<&str>,
        tool_call_id: &str,
    ) -> Result<()>
```

**Purpose**: Enforces that a model-visible call id maps to at most one reduced tool call. It guards against duplicate tool starts for the same transcript call item.

**Data flow**: Takes `&self`, an optional model-visible call id, and the current tool call id. If no call id is present it returns success. Otherwise it looks up any existing tool via `single_tool_for_model_visible_call` and errors if a different tool already claims that call id.

**Call relations**: Called by `start_tool_call` before insertion. It delegates the actual lookup to `single_tool_for_model_visible_call` and exists to keep the start path's invariant checks explicit.

*Call graph*: calls 1 internal fn (single_tool_for_model_visible_call); called by 1 (start_tool_call); 1 external calls (bail!).


##### `TraceReducer::single_tool_for_model_visible_call`  (lines 427–442)

```
fn single_tool_for_model_visible_call(
        &self,
        model_visible_call_id: &str,
    ) -> Result<Option<ToolCallId>>
```

**Purpose**: Finds the unique reduced tool call associated with a given model-visible call id, if any. It also detects and rejects impossible many-to-one mappings already present in reducer state.

**Data flow**: Takes `&self` and a model-visible call id, scans `rollout.tool_calls` for matching `model_visible_call_id`, returns `Ok(None)` if none match, `Ok(Some(tool_call_id))` if exactly one matches, or an error if multiple matches are found.

**Call relations**: Used by `ensure_unique_model_visible_tool_call` during tool insertion and by `attach_model_visible_tool_item` during transcript back-linking. It is the canonical lookup for model-visible call ownership.

*Call graph*: called by 2 (attach_model_visible_tool_item, ensure_unique_model_visible_tool_call); 1 external calls (bail!).


##### `TraceReducer::model_visible_tool_item_ids`  (lines 444–460)

```
fn model_visible_tool_item_ids(
        &self,
        thread_id: &str,
        call_id: &str,
        kinds: &[ConversationItemKind],
    ) -> Vec<String>
```

**Purpose**: Collects already-reduced conversation item ids in a thread that match a given model-visible call id and any of a supplied set of item kinds. It is used to seed tool/transcript links when the transcript was reduced first.

**Data flow**: Takes `&self`, a thread id, a call id, and a slice of `ConversationItemKind`. It filters `rollout.conversation_items` by matching thread, `call_id`, and kind membership, clones the matching `item_id`s into a `Vec<String>`, and returns that vector.

**Call relations**: Called by `start_tool_call` to pre-populate `model_visible_call_item_ids` and discover output items that may already exist before the tool object is inserted.


##### `TraceReducer::add_tool_call_item`  (lines 462–468)

```
fn add_tool_call_item(&mut self, tool_call_id: &str, item_id: &str) -> Result<()>
```

**Purpose**: Adds a conversation call-item id to a tool call's `model_visible_call_item_ids` without duplication. It is the low-level mutator for call-item back-links.

**Data flow**: Takes mutable reducer state, a tool call id, and an item id. It fetches the mutable `ToolCall`, appends the item id via `push_unique`, and returns `Ok(())` or an error if the tool disappeared.

**Call relations**: Called by `attach_model_visible_tool_item` when a function/custom tool call item is observed after tool insertion. It delegates duplicate suppression to `push_unique`.

*Call graph*: calls 1 internal fn (push_unique); called by 1 (attach_model_visible_tool_item); 1 external calls (bail!).


##### `TraceReducer::add_tool_output_item`  (lines 470–486)

```
fn add_tool_output_item(&mut self, tool_call_id: &str, item_id: &str) -> Result<()>
```

**Purpose**: Adds a conversation output-item id to a tool call and also records the reverse `ProducerRef::Tool` on the conversation item. It maintains both directions of the tool-output relationship.

**Data flow**: Takes mutable reducer state, a tool call id, and an item id. It fetches the mutable `ToolCall`, appends the item id uniquely to `model_visible_output_item_ids`, then fetches the mutable conversation item and pushes `ProducerRef::Tool { tool_call_id }` into `produced_by` if not already present. It errors if either object is missing.

**Call relations**: Called by `start_tool_call` for output items already known at insertion time and by `attach_model_visible_tool_item` for output items observed later. It uses `push_unique` for the tool-side list and performs the conversation-item reverse link locally.

*Call graph*: calls 1 internal fn (push_unique); called by 2 (attach_model_visible_tool_item, start_tool_call); 1 external calls (bail!).


##### `TraceReducer::link_tool_to_inference_response`  (lines 488–510)

```
fn link_tool_to_inference_response(&mut self, tool_call_id: &str)
```

**Purpose**: Associates a tool call with any inference response whose response items include the tool's model-visible call item. This lets the reduced inference record know which tools were started by its output.

**Data flow**: Takes mutable reducer state and a tool call id. It reads the tool's `model_visible_call_item_ids`; if none exist it returns early. Otherwise it scans all `rollout.inference_calls`, and for each inference whose `response_item_ids` contain any of those call items, it appends the tool call id to `tool_call_ids_started_by_response` if not already present.

**Call relations**: Called after tool insertion and after later transcript back-linking in `attach_model_visible_tool_item`. It does not delegate further; it is the bridge from transcript-linked tool items back to inference-call provenance.

*Call graph*: called by 2 (attach_model_visible_tool_item, start_tool_call).


##### `push_unique`  (lines 513–517)

```
fn push_unique(items: &mut Vec<String>, item_id: &str)
```

**Purpose**: Appends a string id to a vector only if it is not already present. It is the local duplicate-suppression helper for tool-side id lists.

**Data flow**: Takes a mutable `Vec<String>` and an item id string slice, scans for an equal existing entry, and pushes `item_id.to_string()` only when absent. It returns no value and mutates the vector in place.

**Call relations**: Used by tool-call item linking and runtime payload tracking helpers in this file. It is a small internal utility that keeps repeated observations from duplicating ids.

*Call graph*: called by 4 (add_tool_call_item, add_tool_output_item, end_tool_runtime_observation, start_tool_runtime_observation).


### `rollout-trace/src/reducer/tool/agents.rs`

`domain_logic` · `trace replay during multi-agent tool runtime, transcript reduction, and replay finalization`

This module is the reducer's multi-agent edge engine. It defines two reducer-only structs: `PendingAgentInteractionEdge`, which stores a not-yet-materialized delivery edge keyed by exact author/content/target-thread matching, and `ObservedAgentResultEdge`, which wraps child-result notifications observed outside normal tool lifecycle events. The core design is deferred resolution: sender-side runtime events often arrive before the recipient thread's mailbox message becomes a reduced `ConversationItem`, so the reducer queues a pending edge rather than anchoring it imprecisely. When the matching transcript item later appears, the edge is materialized to that exact item; for spawn edges only, a final replay-end fallback can target the child thread if no delivery item ever appears.

Runtime begin/end handlers inspect the owning tool kind and deserialize protocol payloads into the appropriate codex-protocol event types. Message-like tools (`AssignAgentTask`, `SendMessage`) queue delivery edges keyed by sender agent path and message content; `CloseAgent` creates a direct thread-targeted edge; `SpawnAgent` can resolve either from explicit spawn-end payloads or from newer sub-agent activity events. Child-result notifications are special: the source anchor is the latest assistant message in the child turn when one exists, otherwise the child thread itself, because failed/cancelled children may notify the parent without producing a final assistant transcript item. Edge upsert logic merges repeated observations by widening time bounds and extending carried item/raw-payload ids while rejecting conflicting endpoints.

#### Function details

##### `spawn_edge_id`  (lines 66–68)

```
fn spawn_edge_id(parent_thread_id: &str, child_thread_id: &str) -> String
```

**Purpose**: Builds the stable interaction-edge id for a parent-to-child spawn relationship. The id format is deterministic and reused across metadata-derived and runtime-derived spawn handling.

**Data flow**: Takes parent and child thread id string slices, formats `edge:spawn:{parent_thread_id}:{child_thread_id}`, and returns the resulting `String`. It is pure.

**Call relations**: Called when deriving spawn origins and when reducing spawn runtime/activity events. It provides the shared identifier that lets separate observations merge onto one edge.

*Call graph*: called by 2 (end_spawn_agent_interaction, end_sub_agent_activity); 1 external calls (format!).


##### `TraceReducer::start_agent_interaction_from_runtime`  (lines 72–126)

```
fn start_agent_interaction_from_runtime(
        &mut self,
        tool_call_id: &str,
        runtime_payload: &RawPayloadRef,
    ) -> Result<()>
```

**Purpose**: Interprets a tool runtime-begin payload as the start of a multi-agent interaction when the tool kind supports one. It creates or updates pending delivery/close edges from begin-time protocol facts.

**Data flow**: Takes mutable reducer state, a tool call id, and runtime payload ref. It reads the tool kind from `rollout.tool_calls`, parses the payload JSON into the corresponding protocol type for supported kinds, and either queues a message interaction edge, upserts a close-agent edge, or returns `Ok(())` for unsupported tool kinds.

**Call relations**: Called by `start_tool_runtime_observation` after generic runtime payload bookkeeping. It delegates message-edge creation to `queue_message_agent_interaction` and close-edge creation to `upsert_close_agent_interaction`.

*Call graph*: calls 2 internal fn (queue_message_agent_interaction, upsert_close_agent_interaction); 1 external calls (from_value).


##### `TraceReducer::end_agent_interaction_from_runtime`  (lines 129–184)

```
fn end_agent_interaction_from_runtime(
        &mut self,
        wall_time_unix_ms: i64,
        tool_call_id: &str,
        runtime_payload: &RawPayloadRef,
    ) -> Result<()>
```

**Purpose**: Interprets a tool runtime-end payload as the completion or enrichment of a multi-agent interaction. It handles both classic protocol end payloads and newer sub-agent activity payloads.

**Data flow**: Takes mutable reducer state, wall-clock end time, tool call id, and runtime payload ref. It reads the tool kind, loads payload JSON, branches first on whether the payload contains `agent_thread_id` to detect `SubAgentActivityEvent`, otherwise deserializes the payload according to tool kind and forwards to spawn/message/close-specific end handlers. It returns `Ok(())` or a reducer error on mismatched activity/tool combinations.

**Call relations**: Called by `end_tool_runtime_observation` after generic runtime bookkeeping. It delegates to `end_sub_agent_activity`, `end_spawn_agent_interaction`, `end_message_agent_interaction`, or `upsert_close_agent_interaction` depending on payload shape and tool kind.

*Call graph*: calls 4 internal fn (end_message_agent_interaction, end_spawn_agent_interaction, end_sub_agent_activity, upsert_close_agent_interaction); 1 external calls (from_value).


##### `TraceReducer::end_sub_agent_activity`  (lines 186–243)

```
fn end_sub_agent_activity(
        &mut self,
        wall_time_unix_ms: i64,
        tool_call_id: &str,
        tool_kind: &ToolCallKind,
        payload: &SubAgentActivityEvent,
    ) -> Result<()>
```

**Purpose**: Maps a `SubAgentActivityEvent` emitted on runtime end into the appropriate interaction-edge update for spawn, follow-up task, send-message, or close-agent tools. It validates that the activity kind matches the tool kind.

**Data flow**: Takes mutable reducer state, wall-clock time, tool call id, tool kind, and parsed activity payload. It extracts the target child thread id and matches `(tool_kind, payload.kind)`, then either computes a spawn edge id and queues a spawn delivery edge, queues a message/follow-up edge keyed by the tool edge id, upserts a close-agent edge, or errors on incompatible combinations.

**Call relations**: Reached only from `end_agent_interaction_from_runtime` when the runtime payload has `agent_thread_id`. It delegates edge construction to `queue_sub_agent_activity_message_edge`, `upsert_close_agent_interaction`, `spawn_edge_id`, and `tool_edge_id`.

*Call graph*: calls 4 internal fn (queue_sub_agent_activity_message_edge, upsert_close_agent_interaction, spawn_edge_id, tool_edge_id); called by 1 (end_agent_interaction_from_runtime); 1 external calls (bail!).


##### `TraceReducer::queue_sub_agent_activity_message_edge`  (lines 245–275)

```
fn queue_sub_agent_activity_message_edge(
        &mut self,
        wall_time_unix_ms: i64,
        tool_call_id: &str,
        edge_id: String,
        edge_kind: InteractionEdgeKind,
        target
```

**Purpose**: Builds a pending interaction edge from a sub-agent activity event using the tool's invocation payload to recover the delivered message content. It packages all edge metadata before queueing or immediate resolution.

**Data flow**: Takes mutable reducer state, wall-clock time, tool call id, edge id, edge kind, target thread id, and optional unresolved spawn fallback thread id. It reads the tool call, derives start time, sender agent path, message content from invocation arguments, and carried raw payload ids, then constructs `PendingAgentInteractionEdge` and passes it to `queue_or_resolve_agent_interaction_edge`.

**Call relations**: Called by `end_sub_agent_activity` for spawn and interacted activity kinds. It delegates sender lookup to `agent_path_for_thread`, message extraction to `agent_message_content_from_invocation`, payload collection to `agent_tool_payload_ids`, and final queue/resolve behavior to `queue_or_resolve_agent_interaction_edge`.

*Call graph*: calls 4 internal fn (agent_message_content_from_invocation, agent_path_for_thread, agent_tool_payload_ids, queue_or_resolve_agent_interaction_edge); called by 1 (end_sub_agent_activity).


##### `TraceReducer::agent_message_content_from_invocation`  (lines 277–307)

```
fn agent_message_content_from_invocation(&self, tool_call_id: &str) -> Result<String>
```

**Purpose**: Extracts the `message` field from a tool invocation payload's serialized function arguments. It is used when runtime activity events identify the recipient thread but do not repeat the message body.

**Data flow**: Takes `&self` and a tool call id, looks up the tool call and its `raw_invocation_payload_id`, resolves that id through `rollout.raw_payloads`, reads the payload JSON, navigates to `payload.arguments`, parses the JSON string into `AgentMessageInvocationArgs`, and returns the `message` string. It errors if any expected field or payload is missing.

**Call relations**: Called by `queue_sub_agent_activity_message_edge`. It depends on earlier raw-payload insertion by the top-level reducer and on the tool call already having recorded its invocation payload id.

*Call graph*: called by 1 (queue_sub_agent_activity_message_edge); 1 external calls (from_str).


##### `TraceReducer::attach_agent_interaction_tool_result`  (lines 310–346)

```
fn attach_agent_interaction_tool_result(
        &mut self,
        tool_call_id: &str,
        result_payload: Option<&RawPayloadRef>,
    ) -> Result<()>
```

**Purpose**: Adds a canonical tool result payload id to an already resolved or still-pending multi-agent interaction edge sourced from that tool call. It preserves result evidence even when the recipient transcript item has not appeared yet.

**Data flow**: Takes mutable reducer state, a tool call id, and an optional result payload ref. If no payload is provided it returns immediately. Otherwise it searches first for an existing `interaction_edges` entry whose source anchor is that tool call and appends the payload id uniquely to `carried_raw_payload_ids`; if none exists, it searches pending edges and appends there instead.

**Call relations**: Called by `end_tool_call` after generic tool completion. It uses `tool_call_source_matches` conceptually to find the relevant edge and `push_unique` to avoid duplicate payload ids.

*Call graph*: calls 1 internal fn (push_unique).


##### `TraceReducer::end_spawn_agent_interaction`  (lines 348–376)

```
fn end_spawn_agent_interaction(
        &mut self,
        wall_time_unix_ms: i64,
        tool_call_id: &str,
        payload: &CollabAgentSpawnEndEvent,
    ) -> Result<()>
```

**Purpose**: Builds a pending spawn interaction edge from a classic spawn runtime-end payload. It records the child thread as a possible fallback target if no child-side delivery item is ever reduced.

**Data flow**: Takes mutable reducer state, wall-clock time, tool call id, and parsed `CollabAgentSpawnEndEvent`. If `new_thread_id` is absent it returns success without creating an edge. Otherwise it derives the child thread id, computes the stable spawn edge id, looks up the sender agent path and carried payload ids, constructs a `PendingAgentInteractionEdge` with `unresolved_spawn_thread_id: Some(child_thread_id)`, and queues or resolves it.

**Call relations**: Called by `end_agent_interaction_from_runtime` for `ToolCallKind::SpawnAgent` classic end payloads. It delegates sender lookup to `agent_path_for_thread`, payload collection to `agent_tool_payload_ids`, id construction to `spawn_edge_id`, and final handling to `queue_or_resolve_agent_interaction_edge`.

*Call graph*: calls 4 internal fn (agent_path_for_thread, agent_tool_payload_ids, queue_or_resolve_agent_interaction_edge, spawn_edge_id); called by 1 (end_agent_interaction_from_runtime).


##### `TraceReducer::end_message_agent_interaction`  (lines 378–392)

```
fn end_message_agent_interaction(
        &mut self,
        wall_time_unix_ms: i64,
        tool_call_id: &str,
        edge_kind: InteractionEdgeKind,
        payload: &CollabAgentInteractionEndEven
```

**Purpose**: Converts a classic message-interaction runtime-end payload into the common message-edge queueing path. It exists to adapt the end payload type to the shared helper signature.

**Data flow**: Takes mutable reducer state, wall-clock time, tool call id, edge kind, and parsed `CollabAgentInteractionEndEvent`, then forwards receiver thread id, prompt text, and end time to `queue_message_agent_interaction`. It returns that helper's result.

**Call relations**: Called by `end_agent_interaction_from_runtime` for `AssignAgentTask` and `SendMessage` classic end payloads. It is a thin adapter over `queue_message_agent_interaction`.

*Call graph*: calls 1 internal fn (queue_message_agent_interaction); called by 1 (end_agent_interaction_from_runtime).


##### `TraceReducer::queue_message_agent_interaction`  (lines 394–418)

```
fn queue_message_agent_interaction(
        &mut self,
        tool_call_id: &str,
        kind: InteractionEdgeKind,
        target_thread_id: String,
        message_content: String,
        ended_a
```

**Purpose**: Constructs a pending message-delivery edge for assign-task or send-message tools using sender thread identity and carried payload ids from the tool call. It is the common path for begin/end payloads that already include the message content.

**Data flow**: Takes mutable reducer state, tool call id, interaction kind, target thread id, message content, and optional end time. It reads the tool call for start time and sender thread, derives sender agent path and carried raw payload ids, constructs a `PendingAgentInteractionEdge` keyed by `tool_edge_id(tool_call_id)`, and passes it to `queue_or_resolve_agent_interaction_edge`.

**Call relations**: Called from both `start_agent_interaction_from_runtime` and `end_message_agent_interaction`. It delegates sender lookup to `agent_path_for_thread`, payload collection to `agent_tool_payload_ids`, edge-id construction to `tool_edge_id`, and queue/resolve behavior to `queue_or_resolve_agent_interaction_edge`.

*Call graph*: calls 4 internal fn (agent_path_for_thread, agent_tool_payload_ids, queue_or_resolve_agent_interaction_edge, tool_edge_id); called by 2 (end_message_agent_interaction, start_agent_interaction_from_runtime).


##### `TraceReducer::agent_tool_payload_ids`  (lines 420–436)

```
fn agent_tool_payload_ids(&self, tool_call_id: &str) -> Result<Vec<String>>
```

**Purpose**: Collects all raw payload ids currently associated with a tool call's invocation, runtime observations, and result. It provides the evidence list carried on interaction edges.

**Data flow**: Takes `&self` and a tool call id, looks up the tool call, initializes an empty vector, appends `raw_invocation_payload_id`, each `raw_runtime_payload_id`, and `raw_result_payload_id` uniquely when present, and returns the resulting `Vec<String>`.

**Call relations**: Used by message, spawn, close, and sub-agent activity edge builders so every interaction edge carries the raw payload evidence that produced it. It delegates duplicate suppression to the local `push_unique` helper.

*Call graph*: calls 1 internal fn (push_unique); called by 4 (end_spawn_agent_interaction, queue_message_agent_interaction, queue_sub_agent_activity_message_edge, upsert_close_agent_interaction); 1 external calls (new).


##### `TraceReducer::upsert_close_agent_interaction`  (lines 438–472)

```
fn upsert_close_agent_interaction(
        &mut self,
        tool_call_id: &str,
        target_thread_id: String,
        ended_at_unix_ms: Option<i64>,
    ) -> Result<()>
```

**Purpose**: Creates or updates a close-agent interaction edge that targets a thread directly rather than a delivered conversation item. It intentionally drops edges to unknown target threads.

**Data flow**: Takes mutable reducer state, tool call id, target thread id, and optional end time. If the target thread is not present in `rollout.threads`, it returns success without creating an edge. Otherwise it reads the tool start time, gathers carried raw payload ids, constructs an `InteractionEdge` with `TraceAnchor::ToolCall` source and `TraceAnchor::Thread` target, and upserts it into `rollout.interaction_edges`.

**Call relations**: Called from runtime begin/end handling and sub-agent activity handling for `CloseAgent`. It delegates payload collection to `agent_tool_payload_ids`, edge-id construction to `tool_edge_id`, and merge/insert behavior to `upsert_interaction_edge`.

*Call graph*: calls 3 internal fn (agent_tool_payload_ids, upsert_interaction_edge, tool_edge_id); called by 3 (end_agent_interaction_from_runtime, end_sub_agent_activity, start_agent_interaction_from_runtime); 1 external calls (new).


##### `TraceReducer::queue_agent_result_interaction_edge`  (lines 475–513)

```
fn queue_agent_result_interaction_edge(
        &mut self,
        observed: ObservedAgentResultEdge,
    ) -> Result<()>
```

**Purpose**: Queues or resolves the edge from a child agent's completion result to the parent-side notification message. It chooses the most precise available source anchor from the child side.

**Data flow**: Takes mutable reducer state and an `ObservedAgentResultEdge`. It derives `message_author` from the child thread's agent path, chooses the source anchor as the latest assistant message item in the child turn if one exists or else the child thread, constructs a `PendingAgentInteractionEdge` of kind `AgentResult` targeting the parent thread with the observed message and optional carried payload id, and passes it to `queue_or_resolve_agent_interaction_edge`.

**Call relations**: Called by the top-level dispatcher when an `AgentResultObserved` raw event arrives. It delegates sender lookup to `agent_path_for_thread`, source-item discovery to `latest_assistant_message_item_for_turn`, and final queue/resolve behavior to `queue_or_resolve_agent_interaction_edge`.

*Call graph*: calls 3 internal fn (agent_path_for_thread, latest_assistant_message_item_for_turn, queue_or_resolve_agent_interaction_edge).


##### `TraceReducer::resolve_pending_agent_edges_for_item`  (lines 516–541)

```
fn resolve_pending_agent_edges_for_item(
        &mut self,
        item_id: &str,
    ) -> Result<()>
```

**Purpose**: Attempts to resolve any pending interaction edge whose intended target is a newly reduced conversation item. It is the transcript-side hook that turns queued deliveries into concrete graph edges.

**Data flow**: Takes mutable reducer state and a conversation `item_id`. It first ignores items already targeted by an interaction edge, then extracts `(thread_id, author, content)` via `inter_agent_message_item`; if that succeeds, it searches `pending_agent_interaction_edges` for a matching pending edge, removes it, and materializes it to the item via `upsert_agent_interaction_edge_for_item`.

**Call relations**: Called from conversation reduction when a new item is inserted. It depends on `inter_agent_message_item` to recognize only true inter-agent mailbox messages and on `is_interaction_edge_target_item` to avoid double-targeting the same item.

*Call graph*: calls 3 internal fn (inter_agent_message_item, is_interaction_edge_target_item, upsert_agent_interaction_edge_for_item).


##### `TraceReducer::queue_or_resolve_agent_interaction_edge`  (lines 543–590)

```
fn queue_or_resolve_agent_interaction_edge(
        &mut self,
        pending: PendingAgentInteractionEdge,
    ) -> Result<()>
```

**Purpose**: Either resolves a pending interaction edge immediately to an already-known recipient message item or stores/merges it in the pending queue for later transcript resolution. It is the central deferred-resolution mechanism for agent edges.

**Data flow**: Takes mutable reducer state and a `PendingAgentInteractionEdge`. It first searches for an unlinked matching recipient message item via `find_unlinked_inter_agent_message_item`; if found, it materializes the edge immediately. Otherwise it looks for an existing pending edge with the same `edge_id`; if found, it verifies all endpoint-identifying fields match, merges time bounds and carried raw payload ids, and returns. If no existing pending edge matches, it pushes the new pending edge onto `pending_agent_interaction_edges`.

**Call relations**: Called by all sender-side edge builders and by agent-result handling. It delegates immediate materialization to `upsert_agent_interaction_edge_for_item`, recipient lookup to `find_unlinked_inter_agent_message_item`, and payload-list merging to `extend_unique`.

*Call graph*: calls 3 internal fn (find_unlinked_inter_agent_message_item, upsert_agent_interaction_edge_for_item, extend_unique); called by 4 (end_spawn_agent_interaction, queue_agent_result_interaction_edge, queue_message_agent_interaction, queue_sub_agent_activity_message_edge); 1 external calls (bail!).


##### `TraceReducer::resolve_pending_spawn_edge_fallbacks`  (lines 593–628)

```
fn resolve_pending_spawn_edge_fallbacks(&mut self) -> Result<()>
```

**Purpose**: At replay end, materializes any still-pending spawn edges to their child thread when no child-side delivery item was ever reduced. It is the final reconciliation pass for spawn-only fallback semantics.

**Data flow**: Takes mutable reducer state, drains `pending_agent_interaction_edges` with `std::mem::take`, iterates the drained edges, and for each edge with `unresolved_spawn_thread_id` set verifies it is a `SpawnAgent` edge and that the child thread exists. It then inserts or merges an `InteractionEdge` targeting `TraceAnchor::Thread` with no carried item ids but preserved carried raw payload ids.

**Call relations**: Called once by `replay_bundle` after all raw events have been processed. It delegates final insertion/merge behavior to `upsert_interaction_edge` and intentionally ignores non-spawn pending edges because only spawn has a valid thread-level fallback.

*Call graph*: calls 1 internal fn (upsert_interaction_edge); 3 external calls (new, bail!, take).


##### `TraceReducer::upsert_agent_interaction_edge_for_item`  (lines 630–647)

```
fn upsert_agent_interaction_edge_for_item(
        &mut self,
        pending: PendingAgentInteractionEdge,
        target_item_id: String,
    ) -> Result<()>
```

**Purpose**: Materializes a pending interaction edge to a concrete recipient conversation item and records that item as carried by the edge. It is the common item-targeted edge constructor.

**Data flow**: Takes mutable reducer state, a `PendingAgentInteractionEdge`, and a target item id string. It constructs an `InteractionEdge` with the pending edge's id, kind, source, timestamps, and raw payload ids, sets `target` to `TraceAnchor::ConversationItem { item_id }`, sets `carried_item_ids` to a one-element vector containing that item id, and upserts it.

**Call relations**: Called by `queue_or_resolve_agent_interaction_edge` for immediate resolution and by `resolve_pending_agent_edges_for_item` when transcript reduction later reveals the target item. It delegates merge/insert behavior to `upsert_interaction_edge`.

*Call graph*: calls 1 internal fn (upsert_interaction_edge); called by 2 (queue_or_resolve_agent_interaction_edge, resolve_pending_agent_edges_for_item); 1 external calls (vec!).


##### `TraceReducer::upsert_interaction_edge`  (lines 649–677)

```
fn upsert_interaction_edge(&mut self, edge: InteractionEdge) -> Result<()>
```

**Purpose**: Inserts a new `InteractionEdge` or merges a repeated observation of the same edge id when endpoints match. It is the canonical storage layer for reduced interaction edges.

**Data flow**: Takes mutable reducer state and an `InteractionEdge`. If an edge with the same id already exists, it verifies `kind`, `source`, and `target` are identical, then widens `started_at_unix_ms`/`ended_at_unix_ms` and extends `carried_item_ids` and `carried_raw_payload_ids` uniquely. If no edge exists, it inserts the new edge into `rollout.interaction_edges`.

**Call relations**: Used by close-edge creation, item-targeted materialization, and replay-end spawn fallback resolution. It delegates list merging to `extend_unique` and serves as the final sink for all interaction-edge reduction paths.

*Call graph*: calls 1 internal fn (extend_unique); called by 3 (resolve_pending_spawn_edge_fallbacks, upsert_agent_interaction_edge_for_item, upsert_close_agent_interaction); 1 external calls (bail!).


##### `TraceReducer::find_unlinked_inter_agent_message_item`  (lines 679–699)

```
fn find_unlinked_inter_agent_message_item(
        &self,
        thread_id: &str,
        message_author: &str,
        message_content: &str,
    ) -> Option<String>
```

**Purpose**: Searches a thread's conversation timeline for the first mailbox message item matching a given author and content that is not already targeted by another interaction edge. It supports immediate edge resolution when the recipient item already exists.

**Data flow**: Takes `&self`, a target thread id, message author, and message content. It looks up the thread, iterates its `conversation_item_ids` in order, filters out items already used as interaction-edge targets, checks each remaining item with `inter_agent_message_item`, and returns the first matching item id clone or `None`.

**Call relations**: Called only by `queue_or_resolve_agent_interaction_edge`. It relies on `is_interaction_edge_target_item` and `inter_agent_message_item` to ensure only unused, semantically valid mailbox items are considered.

*Call graph*: called by 1 (queue_or_resolve_agent_interaction_edge).


##### `TraceReducer::inter_agent_message_item`  (lines 701–710)

```
fn inter_agent_message_item(&self, item_id: &str) -> Option<(String, String, String)>
```

**Purpose**: Recognizes whether a reduced conversation item represents an inter-agent mailbox delivery and, if so, extracts its thread id, author agent path, and message content. It supports both newer structured agent-message items and older serialized transport JSON.

**Data flow**: Takes `&self` and an item id, looks up the conversation item, extracts `(author_agent_path, recipient_agent_path, message_content)` via `inter_agent_message_fields`, looks up the owning thread, verifies the recipient agent path matches the thread's `agent_path`, and returns `Some((thread_id, author, content))` or `None`.

**Call relations**: Used by `resolve_pending_agent_edges_for_item` and indirectly by recipient-item search. It delegates the actual body parsing to `inter_agent_message_fields`.

*Call graph*: calls 1 internal fn (inter_agent_message_fields); called by 1 (resolve_pending_agent_edges_for_item).


##### `TraceReducer::agent_path_for_thread`  (lines 712–718)

```
fn agent_path_for_thread(&self, thread_id: &str) -> Result<String>
```

**Purpose**: Returns the reduced agent path for a thread id with a contextual unknown-thread error. It is the common sender/recipient identity lookup for agent-edge reduction.

**Data flow**: Takes `&self` and a thread id, looks up `rollout.threads`, clones the thread's `agent_path`, and returns it as `Result<String>`. It does not mutate state.

**Call relations**: Called by spawn, message, close, and agent-result edge builders whenever they need the sender agent identity. It is a small lookup helper with reducer-specific error context.

*Call graph*: called by 4 (end_spawn_agent_interaction, queue_agent_result_interaction_edge, queue_message_agent_interaction, queue_sub_agent_activity_message_edge).


##### `TraceReducer::is_interaction_edge_target_item`  (lines 720–725)

```
fn is_interaction_edge_target_item(&self, item_id: &str) -> bool
```

**Purpose**: Checks whether a conversation item is already the target of any reduced interaction edge. It prevents multiple edges from claiming the same mailbox item as their target.

**Data flow**: Takes `&self` and an item id, scans `rollout.interaction_edges.values()` for any edge whose `target` is `TraceAnchor::ConversationItem` with that id, and returns a boolean. It is pure.

**Call relations**: Used by `resolve_pending_agent_edges_for_item` and `find_unlinked_inter_agent_message_item` to avoid double-targeting recipient items.

*Call graph*: called by 1 (resolve_pending_agent_edges_for_item).


##### `TraceReducer::latest_assistant_message_item_for_turn`  (lines 727–744)

```
fn latest_assistant_message_item_for_turn(
        &self,
        thread_id: &str,
        codex_turn_id: &str,
    ) -> Option<String>
```

**Purpose**: Finds the latest ordinary assistant message item in a specific thread and Codex turn, excluding agent-message mailbox items. It is used as the preferred source anchor for child-result edges.

**Data flow**: Takes `&self`, a thread id, and a turn id, filters `rollout.conversation_items` by matching thread, matching `codex_turn_id`, `ConversationRole::Assistant`, `ConversationItemKind::Message`, and `agent_message.is_none()`, selects the item with the maximum `first_seen_at_unix_ms`, and returns its id clone if any.

**Call relations**: Called by `queue_agent_result_interaction_edge` to anchor child results to the child's actual final assistant output when available, falling back to the thread otherwise.

*Call graph*: called by 1 (queue_agent_result_interaction_edge).


##### `extend_unique`  (lines 747–753)

```
fn extend_unique(items: &mut Vec<String>, new_items: Vec<String>)
```

**Purpose**: Appends multiple string ids into a vector while preserving uniqueness. It is the batch merge helper for carried item and payload id lists.

**Data flow**: Takes a mutable `Vec<String>` and a `Vec<String>` of new items, iterates the new items, and pushes each only if not already present. It mutates the destination vector in place.

**Call relations**: Used by pending-edge merging and final interaction-edge upsert logic. It is the multi-item counterpart to `push_unique`.

*Call graph*: called by 2 (queue_or_resolve_agent_interaction_edge, upsert_interaction_edge).


##### `tool_edge_id`  (lines 755–757)

```
fn tool_edge_id(tool_call_id: &str) -> String
```

**Purpose**: Builds the stable interaction-edge id for tool-scoped agent interactions such as send-message, assign-task, and close-agent. The id is derived solely from the tool call id.

**Data flow**: Takes a tool call id string slice, formats `edge:tool:{tool_call_id}`, and returns the resulting `String`. It is pure.

**Call relations**: Called by message, close, and sub-agent activity reducers whenever the interaction edge should be keyed directly to the tool call rather than a parent/child thread pair.

*Call graph*: called by 3 (end_sub_agent_activity, queue_message_agent_interaction, upsert_close_agent_interaction); 1 external calls (format!).


##### `tool_call_source_matches`  (lines 759–761)

```
fn tool_call_source_matches(anchor: &TraceAnchor, tool_call_id: &str) -> bool
```

**Purpose**: Checks whether a `TraceAnchor` is a `ToolCall` anchor for a specific tool call id. It is a small predicate used when attaching result payloads to edges.

**Data flow**: Takes a `&TraceAnchor` and a tool call id string slice, pattern-matches the anchor, and returns `true` only when it is `TraceAnchor::ToolCall { tool_call_id: source }` with the same id. It is pure.

**Call relations**: Used internally by `attach_agent_interaction_tool_result` to find resolved or pending edges sourced from a given tool call.

*Call graph*: 1 external calls (matches!).


##### `push_unique`  (lines 763–767)

```
fn push_unique(items: &mut Vec<String>, item: &str)
```

**Purpose**: Appends a single string to a vector only if it is not already present. It is the local duplicate-suppression helper for carried raw payload ids.

**Data flow**: Takes a mutable `Vec<String>` and an item string slice, scans for an equal existing entry, and pushes `item.to_string()` only when absent. It mutates the vector in place.

**Call relations**: Used by `agent_tool_payload_ids` and `attach_agent_interaction_tool_result` to keep payload evidence lists deduplicated.

*Call graph*: called by 2 (agent_tool_payload_ids, attach_agent_interaction_tool_result).


##### `inter_agent_message_fields`  (lines 769–805)

```
fn inter_agent_message_fields(item: &ConversationItem) -> Option<(String, String, String)>
```

**Purpose**: Extracts `(author, recipient, content)` from a conversation item if and only if the item encodes an inter-agent delivery message. It supports both structured `agent_message` items and older serialized `InterAgentCommunication` text bodies.

**Data flow**: Takes a `&ConversationItem`, first requires assistant-role message kind. If `item.agent_message` is present, it inspects `item.body.parts` and accepts either plain text or `encrypted_content` forms, returning the author, recipient, and chosen content. Otherwise it requires a single text part, attempts to parse it as `InterAgentCommunication`, and returns author, recipient, and encrypted-or-plain content on success; otherwise returns `None`.

**Call relations**: Called by `inter_agent_message_item` as the low-level parser for mailbox-message semantics. It is intentionally strict so ordinary assistant JSON text is not misclassified as an inter-agent delivery.

*Call graph*: called by 1 (inter_agent_message_item).


### `rollout-trace/src/reducer/tool/terminal.rs`

`domain_logic` · `trace replay during tool runtime/start/end and transcript back-linking`

This module is the terminal-specific branch of tool reduction. It supports two sources of terminal semantics. For protocol-backed tools such as `ExecCommand`, runtime begin/end payloads carry the richest process details and are parsed into `ExecCommandBeginPayload` and `ExecCommandEndPayload`. For direct tools like `WriteStdin`, the reducer can synthesize a terminal operation from the canonical dispatch invocation/result payloads when runtime begin data is absent, using the dispatch payload's `session_id` as the terminal/session join key. `start_terminal_operation_from_invocation` and `start_terminal_operation_from_runtime` both normalize into `TerminalOperationStart`, which `insert_terminal_operation` turns into a new `TerminalOperation` with a generated `terminal_operation:{n}` id and, when a terminal id is known, an associated `TerminalSession`.

`end_terminal_operation` updates execution end fields, parses an optional response payload into a `TerminalResult`, appends the raw payload id, and enforces that begin/end process ids cannot disagree. If the begin payload lacked a process id but the end payload has one, the end event retroactively completes the operation's terminal id and session linkage. `ensure_terminal_session` guarantees all operations sharing a terminal id belong to the same thread and appends operation ids uniquely. `sync_terminal_model_observation` projects model-visible tool call/output item ids from the owning `ToolCall` into a `TerminalModelObservation` with source `DirectToolCall`, intentionally keeping runtime result data separate from what later transcript items prove was shown to the model. The parsing helpers are strict about supported payload shapes and include fallback logic for code-mode write-stdin results.

#### Function details

##### `TraceReducer::start_terminal_operation_from_invocation`  (lines 36–72)

```
fn start_terminal_operation_from_invocation(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        thread_id: &str,
        tool_call_id: &str,
        kind: &ToolCallKi
```

**Purpose**: Creates a terminal operation from a canonical dispatch invocation payload when the tool kind is `WriteStdin`. It is the fallback path for direct tools that do not emit a richer runtime-begin event.

**Data flow**: Takes mutable reducer state, raw sequence/time, thread id, tool call id, tool kind, and optional invocation payload ref. If the kind is not `WriteStdin` it returns `Ok(None)`. If the invocation payload is missing it also returns `Ok(None)`. Otherwise it reads the payload JSON, parses it with `parse_dispatch_terminal_request`, wraps the parsed request in `TerminalOperationStart`, and delegates insertion to `insert_terminal_operation`, returning the new operation id if created.

**Call relations**: Called by `start_tool_call` before the generic `ToolCall` is inserted. It delegates payload parsing to `parse_dispatch_terminal_request` and actual operation/session creation to `insert_terminal_operation`.

*Call graph*: calls 2 internal fn (insert_terminal_operation, parse_dispatch_terminal_request); 1 external calls (matches!).


##### `TraceReducer::start_terminal_operation_from_runtime`  (lines 75–106)

```
fn start_terminal_operation_from_runtime(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        thread_id: &str,
        tool_call_id: &str,
        kind: &ToolCallKind,
```

**Purpose**: Creates a terminal operation from a protocol runtime-begin payload for terminal-capable tool kinds. It is the primary path for exec-like runtime observations.

**Data flow**: Takes mutable reducer state, raw sequence/time, thread id, tool call id, tool kind, and runtime payload ref. It maps the tool kind to an optional `TerminalOperationKind` via `terminal_operation_kind`; if none, returns `Ok(None)`. Otherwise it reads and deserializes the runtime payload into `ExecCommandBeginPayload`, converts that to a normalized request with `parse_protocol_terminal_request`, and inserts the operation via `insert_terminal_operation`.

**Call relations**: Called by `start_tool_runtime_observation` after generic runtime bookkeeping. It delegates kind filtering to `terminal_operation_kind`, request normalization to `parse_protocol_terminal_request`, and storage/session creation to `insert_terminal_operation`.

*Call graph*: calls 3 internal fn (insert_terminal_operation, parse_protocol_terminal_request, terminal_operation_kind); 1 external calls (from_value).


##### `TraceReducer::insert_terminal_operation`  (lines 108–150)

```
fn insert_terminal_operation(
        &mut self,
        start: TerminalOperationStart<'_>,
    ) -> Result<Option<TerminalOperationId>>
```

**Purpose**: Allocates a new terminal operation id, inserts the `TerminalOperation`, and ensures a matching `TerminalSession` exists when a terminal id is known. It is the common sink for both invocation-derived and runtime-derived starts.

**Data flow**: Takes mutable reducer state and a `TerminalOperationStart` bundle. It generates the next operation id with `next_terminal_operation_id`, destructures the parsed request into optional `terminal_id` and `TerminalRequest`, inserts a running `TerminalOperation` with initial raw payload id into `rollout.terminal_operations`, optionally calls `ensure_terminal_session` when `terminal_id` is present, and returns `Ok(Some(operation_id))`.

**Call relations**: Called by both terminal-start entry points. It delegates session creation/validation to `ensure_terminal_session` and id generation to `next_terminal_operation_id`.

*Call graph*: calls 2 internal fn (ensure_terminal_session, next_terminal_operation_id); called by 2 (start_terminal_operation_from_invocation, start_terminal_operation_from_runtime); 2 external calls (new, vec!).


##### `TraceReducer::end_terminal_operation`  (lines 156–231)

```
fn end_terminal_operation(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        thread_id: &str,
        operation_id: &str,
        status: ExecutionStatus,
        re
```

**Purpose**: Marks a terminal operation terminal and optionally parses and attaches a terminal result from a response payload. It also reconciles terminal/session identity when the process id is learned only at end time.

**Data flow**: Takes mutable reducer state, raw sequence/time, thread id, operation id, terminal status, and optional response payload ref. It looks up the operation kind, optionally reads and parses the response payload into `(raw_payload_id, ParsedTerminalResponse)`, mutates the operation's execution end fields and result, appends the raw payload id uniquely, validates or fills in `terminal_id` based on the response, captures the final terminal id and original start metadata, and if a terminal id is known ensures the corresponding session exists and includes this operation.

**Call relations**: Called from generic tool reduction on tool end or runtime end depending on whether the terminal tool is protocol-backed. It delegates response parsing to `parse_terminal_response_payload` and session maintenance to `ensure_terminal_session`.

*Call graph*: calls 1 internal fn (ensure_terminal_session); 2 external calls (bail!, push_unique).


##### `TraceReducer::ensure_terminal_session`  (lines 233–274)

```
fn ensure_terminal_session(
        &mut self,
        thread_id: &str,
        terminal_id: &str,
        operation_id: &str,
        started_at_unix_ms: i64,
        started_seq: RawEventSeq,
    )
```

**Purpose**: Creates a `TerminalSession` on first sight of a terminal id and appends an operation id to that session, enforcing that all operations for a terminal belong to the same thread. It is the session join-key manager.

**Data flow**: Takes mutable reducer state, thread id, terminal id, operation id, and the operation's start time/seq. If `rollout.terminal_sessions` lacks the terminal id, it inserts a new running `TerminalSession` with `created_by_operation_id` set to the current operation. It then fetches the session mutably, verifies `session.thread_id == thread_id`, appends the operation id uniquely to `operation_ids`, and returns `Ok(())`.

**Call relations**: Called by both `insert_terminal_operation` and `end_terminal_operation`. It uses `push_unique` from the parent tool module to avoid duplicate operation ids when an operation is linked to the session at both start and end.

*Call graph*: called by 2 (end_terminal_operation, insert_terminal_operation); 3 external calls (new, bail!, push_unique).


##### `TraceReducer::sync_terminal_model_observation`  (lines 280–317)

```
fn sync_terminal_model_observation(
        &mut self,
        tool_call_id: &str,
    ) -> Result<()>
```

**Purpose**: Copies model-visible tool call/output item ids from a `ToolCall` onto its associated terminal operation as a `TerminalModelObservation`. It keeps terminal rows connected to transcript evidence.

**Data flow**: Takes mutable reducer state and a tool call id. It looks up the tool call, returns early if it has no `terminal_operation_id` or no call/output item ids, then fetches the terminal operation and either updates an existing `TerminalModelObservation` with source `DirectToolCall` or pushes a new one containing cloned call/output item id vectors.

**Call relations**: Called after tool insertion, after transcript back-linking, and after runtime-created terminal operations are attached. It depends on generic tool reduction to have already populated the tool's model-visible item lists.

*Call graph*: 1 external calls (bail!).


##### `TraceReducer::next_terminal_operation_id`  (lines 319–323)

```
fn next_terminal_operation_id(&mut self) -> TerminalOperationId
```

**Purpose**: Generates the next stable reduced terminal operation id using the reducer's ordinal counter. It ensures deterministic ids across replay.

**Data flow**: Takes mutable reducer state, reads `next_terminal_operation_ordinal`, increments it, formats `terminal_operation:{ordinal}`, and returns the resulting `String`. It mutates only the counter.

**Call relations**: Called only by `insert_terminal_operation` when a new terminal operation is created.

*Call graph*: called by 1 (insert_terminal_operation); 1 external calls (format!).


##### `terminal_operation_kind`  (lines 326–341)

```
fn terminal_operation_kind(kind: &ToolCallKind) -> Option<TerminalOperationKind>
```

**Purpose**: Maps a `ToolCallKind` to the corresponding `TerminalOperationKind` when the tool represents terminal activity. Non-terminal tool kinds map to `None`.

**Data flow**: Takes a `&ToolCallKind`, matches it, returns `Some(TerminalOperationKind::ExecCommand)` for `ExecCommand`, `Some(TerminalOperationKind::WriteStdin)` for `WriteStdin`, and `None` for all other kinds. It is pure.

**Call relations**: Used by `start_terminal_operation_from_runtime` to decide whether a runtime payload should be interpreted as terminal activity at all.

*Call graph*: called by 1 (start_terminal_operation_from_runtime).


##### `parse_protocol_terminal_request`  (lines 363–388)

```
fn parse_protocol_terminal_request(
    payload: ExecCommandBeginPayload,
    operation_kind: &TerminalOperationKind,
) -> ParsedTerminalRequest
```

**Purpose**: Normalizes a protocol runtime-begin payload into the reducer's `ParsedTerminalRequest` shape. It extracts both the optional terminal id and the operation-specific request fields.

**Data flow**: Takes an `ExecCommandBeginPayload` and a `&TerminalOperationKind`. It clones `process_id` into `terminal_id`, then builds either `TerminalRequest::ExecCommand` from `command` and `cwd` or `TerminalRequest::WriteStdin` from `interaction_input.unwrap_or_default()`, with yield/max-output fields left `None`. It returns `ParsedTerminalRequest`.

**Call relations**: Called by `start_terminal_operation_from_runtime` after payload deserialization. It is a pure normalization helper.

*Call graph*: called by 1 (start_terminal_operation_from_runtime).


##### `parse_dispatch_terminal_request`  (lines 390–421)

```
fn parse_dispatch_terminal_request(value: JsonValue) -> Result<ParsedTerminalRequest>
```

**Purpose**: Parses a dispatch-style tool invocation payload into a `WriteStdin` terminal request. It is intentionally strict about tool name, payload type, and presence of `session_id`.

**Data flow**: Takes a `serde_json::Value`, deserializes it into `DispatchedToolTraceRequestPayload`, verifies `tool_name == "write_stdin"` and `payload.kind == "function"`, extracts the serialized `arguments` string, parses it into `DispatchedWriteStdinArgs`, converts `session_id` to a terminal id with `terminal_id_from_json`, and returns `ParsedTerminalRequest` containing `TerminalRequest::WriteStdin { stdin, yield_time_ms, max_output_tokens }`.

**Call relations**: Called by `start_terminal_operation_from_invocation` when a direct write-stdin tool start needs terminal semantics from the canonical invocation payload.

*Call graph*: calls 1 internal fn (terminal_id_from_json); called by 1 (start_terminal_operation_from_invocation); 3 external calls (bail!, from_str, from_value).


##### `parse_terminal_response_payload`  (lines 423–446)

```
fn parse_terminal_response_payload(
    value: JsonValue,
    operation_kind: &TerminalOperationKind,
    raw_payload_id: &str,
) -> Result<ParsedTerminalResponse>
```

**Purpose**: Parses a terminal response payload into a normalized `ParsedTerminalResponse`, choosing protocol or dispatch parsing based on operation kind and payload shape. It provides the tolerant write-stdin fallback logic.

**Data flow**: Takes a JSON value, a `&TerminalOperationKind`, and the raw payload id for error context. For `ExecCommand`, it deserializes directly to `ExecCommandEndPayload` and normalizes with `parse_protocol_terminal_response`. For `WriteStdin`, it first tries the same protocol parse; if that fails, it falls back to `parse_dispatch_terminal_response` with contextual error text mentioning both parse attempts. It returns `ParsedTerminalResponse`.

**Call relations**: Called by `end_terminal_operation` when a response payload is present. It delegates to `parse_protocol_terminal_response` and `parse_dispatch_terminal_response` depending on kind and parse success.

*Call graph*: calls 2 internal fn (parse_dispatch_terminal_response, parse_protocol_terminal_response); 1 external calls (clone).


##### `parse_protocol_terminal_response`  (lines 448–460)

```
fn parse_protocol_terminal_response(payload: ExecCommandEndPayload) -> ParsedTerminalResponse
```

**Purpose**: Converts a protocol runtime-end payload into the reducer's normalized terminal response shape. It preserves process id and standard stdout/stderr/exit-code fields.

**Data flow**: Takes an `ExecCommandEndPayload`, copies `process_id` into `terminal_id`, builds `TerminalResult { exit_code: Some(...), stdout, stderr, formatted_output: Some(...), original_token_count: None, chunk_id: None }`, and returns `ParsedTerminalResponse`.

**Call relations**: Used by `parse_terminal_response_payload` for protocol-backed exec responses and for write-stdin responses that happen to use the protocol shape.

*Call graph*: called by 1 (parse_terminal_response_payload).


##### `parse_dispatch_terminal_response`  (lines 462–499)

```
fn parse_dispatch_terminal_response(value: JsonValue) -> Result<ParsedTerminalResponse>
```

**Purpose**: Parses a dispatch-style tool result payload into a terminal response, supporting direct-response, code-mode-response, and error variants. It projects terminal-specific fields from higher-level tool result shapes.

**Data flow**: Takes a JSON value, deserializes it into `DispatchedToolTraceResponsePayload`, then matches the enum: `DirectResponse` extracts textual output from `response_item.output` via `json_text_content` or falls back to `to_string`; `CodeModeResponse` delegates to `parse_code_mode_exec_result`; `Error` maps the error string into stderr/formatted output. It returns `ParsedTerminalResponse` with `terminal_id: None`.

**Call relations**: Called by `parse_terminal_response_payload` as the fallback for `WriteStdin` when protocol parsing fails. It delegates code-mode projection to `parse_code_mode_exec_result`.

*Call graph*: calls 1 internal fn (parse_code_mode_exec_result); called by 1 (parse_terminal_response_payload); 2 external calls (new, from_value).


##### `parse_code_mode_exec_result`  (lines 501–523)

```
fn parse_code_mode_exec_result(value: JsonValue) -> TerminalResult
```

**Purpose**: Projects a code-mode exec result object into a `TerminalResult`, preserving structured fields when present and falling back to textual extraction otherwise. It handles JavaScript-facing write-stdin results.

**Data flow**: Takes a JSON value, first attempts to deserialize it into `CodeModeExecResult`; on success it returns `TerminalResult` with `exit_code`, `output` as stdout/formatted output, and optional `original_token_count` and `chunk_id`. On deserialization failure it extracts text with `json_text_content` or falls back to `value.to_string()`, returning a less-structured `TerminalResult` with no exit code or token metadata.

**Call relations**: Called only by `parse_dispatch_terminal_response` for `CodeModeResponse` payloads. It encapsulates the structured-versus-fallback projection logic.

*Call graph*: calls 1 internal fn (json_text_content); called by 1 (parse_dispatch_terminal_response); 2 external calls (clone, new).


##### `json_text_content`  (lines 525–539)

```
fn json_text_content(value: &JsonValue) -> Option<String>
```

**Purpose**: Extracts a human-readable text representation from a JSON value used in dispatch response payloads. It supports plain strings, arrays of `{text}` objects, null, and generic fallback serialization.

**Data flow**: Takes a `&JsonValue`, returns `Some(cloned_string)` for `String`, joins all `text` fields with newlines for `Array`, returns `None` for `Null`, and returns `Some(other.to_string())` for any other JSON type. It is pure.

**Call relations**: Used by `parse_dispatch_terminal_response` and `parse_code_mode_exec_result` when projecting textual terminal output from loosely structured JSON.

*Call graph*: called by 1 (parse_code_mode_exec_result).


##### `terminal_id_from_json`  (lines 541–547)

```
fn terminal_id_from_json(value: &JsonValue) -> Option<String>
```

**Purpose**: Converts a JSON `session_id` value into a terminal/session id string when the value is a non-empty string or a number. It rejects unsupported or empty forms.

**Data flow**: Takes a `&JsonValue`, returns `Some(cloned_string)` for non-empty strings, `Some(number.to_string())` for numbers, and `None` otherwise. It is pure.

**Call relations**: Called by `parse_dispatch_terminal_request` to recover the terminal/session join key from write-stdin dispatch arguments.

*Call graph*: called by 1 (parse_dispatch_terminal_request); 3 external calls (clone, is_empty, to_string).
