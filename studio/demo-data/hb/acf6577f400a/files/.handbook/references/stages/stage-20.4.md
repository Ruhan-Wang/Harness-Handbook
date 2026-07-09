# Rollout trace recording, schema, and replay reducers  `stage-20.4`

This stage is the project’s flight recorder. During the main run, it can write down what Codex does, then later turn that raw diary into a clean story that can be replayed or inspected. The bundle and raw event files define the trace package: a table of contents plus an ordered event log. The model files define the replay-friendly shapes for conversations, tool calls, threads, terminal work, code cells, compaction checkpoints, model requests, and stored payloads. The crate front door exports these pieces, while rollout configuration supplies the few settings tracing needs.

The writer, thread, code cell, compaction, inference, tool dispatch, MCP, and protocol event files are the recording adapters. They sit beside normal work, assign trace IDs, save large payloads, and keep running even if tracing is off or a write fails.

The reducer files are the replay workshop. They read the raw bundle in order and build one compact RolloutTrace. Separate reducers clean up conversations, normalize JSON messages, track model calls, compaction, threads, code cells, tools, agent handoffs, and terminal sessions, linking scattered events into one understandable run history.

## Files in this stage

### crate surface and schemas
These files define the public crate surface plus the raw, bundle, and reduced data schemas that both recording and replay rely on.

### `rollout-trace/src/bundle.rs`

`data_model` · `trace bundle creation and loading`

A trace bundle is a saved package of rollout history: the raw event log, any extra payload files, and a manifest file that explains what is inside. This file defines the standard names for those pieces, such as `manifest.json`, `trace.jsonl`, and the `payloads` folder. It also defines `TraceBundleManifest`, the manifest saved at the root of the bundle.

The manifest is like the label on a box in storage. It says which trace and rollout the box belongs to, when recording started, where to find the raw event log, and which root thread the rollout began from. That root thread matters because the reduced trace data is organized under that thread tree. If it is missing or wrong, replay should not guess a replacement, because that could attach events to the wrong logical conversation or task.

The file also records schema version numbers. A schema is the expected shape of saved data. Versioning lets future code know whether it understands the saved bundle format. The manifest can be serialized and deserialized, meaning it can be turned into JSON and read back into Rust data.

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

**Purpose**: Creates a new manifest using the project’s standard local bundle layout. Callers provide the unique trace details, and this function fills in the fixed file and folder names used inside the bundle.

**Data flow**: It takes a trace ID, rollout ID, root thread ID, and start time. It combines those with the current manifest schema version and the conventional locations for the raw event log and payload directory. The result is a complete `TraceBundleManifest` ready to be written into `manifest.json`.

**Call relations**: The bundle creation flow calls this when it is building a new trace bundle. After this function produces the manifest, the creator can save it alongside the raw trace log and payload directory so later readers know how to open the bundle.

*Call graph*: called by 1 (create).


### `rollout-trace/src/lib.rs`

`orchestration` · `cross-cutting`

This crate records and replays “rollout traces,” which are bundles of evidence about what happened during a Codex run: threads starting, model inference attempts, tool calls, compaction events, payload files, and the reduced summary produced from those raw events. This file does not implement that behavior directly. Instead, it declares the internal building blocks and carefully re-exports the pieces other code is meant to use.

Think of it like the reception desk for a larger office. The actual work happens in separate rooms such as `writer`, `reducer`, `thread`, `inference`, and `tool_dispatch`, but outsiders come through this one desk to get the official forms and services. That matters because hot-path Codex code can depend on a small, stable tracing API without knowing how the trace bundle is laid out internally.

The comments also explain the project boundary: this crate owns the trace schema and writer API, while heavier semantic replay and viewer-style projections stay outside core Codex runtime code. The exported names include no-op-capable trace contexts, which means callers can use the same objects whether tracing is enabled or disabled. Without this file, users of the crate would need to know and import many private module paths directly, making the tracing system harder to understand and easier to break.


### `rollout-trace/src/model/conversation.rs`

`data_model` · `cross-cutting: used whenever conversation traces are built, saved, loaded, or displayed`

This file is a set of data definitions for the conversation part of a rollout trace. A rollout trace is a record of what happened during an agent run. Without these shared types, different parts of the system could disagree about what counts as a message, a tool call, a reasoning item, or an inference request.

The central type is `ConversationItem`. Think of it like one entry in a chat transcript, but richer than a normal chat bubble. It records who the item belongs to, when it was first seen, what role it had, what channel it used, what kind of item it was, what visible content it contained, and what runtime event caused it to exist. Structural events, such as a compaction marker where old history was summarized or replaced, live in the same ordered list so a viewer can show the conversation as it changed over time.

`ConversationBody` and `ConversationPart` describe the actual content inside an item. Content can be plain text, a summary, encoded unreadable data, code, small JSON-like data, or a reference to a larger raw payload stored elsewhere. This keeps normal views readable while still preserving exact evidence for debugging.

`InferenceCall` records one request sent to a model provider and the response metadata. It links the full raw request and response payloads to the reduced list of conversation item IDs that the model saw or produced. `TokenUsage` stores the token counts for cost and performance analysis.


### `rollout-trace/src/model/mod.rs`

`data_model` · `trace construction and replay data loading`

A Codex rollout can create a lot of noisy runtime data: chat messages, model calls, tool calls, terminal sessions, debug details, and raw JSON payloads. This file defines the cleaned-up model used after that activity has been reduced into something deterministic and replayable. In plain terms, it is the filing cabinet for one captured run.

The file first gives clear names to many kinds of IDs. For example, an AgentThreadId names a conversation thread, a ToolCallId names a tool-call object owned by the reducer, and a TerminalId names a terminal runtime session. These are all strings underneath, but the aliases make the meaning of each string clear.

The main type is RolloutTrace. It stores the trace identity, rollout identity, start and end times, current status, the root conversation thread, and many ordered maps of related records. A BTreeMap is a map that keeps keys in a stable sorted order, which helps make saved traces predictable and easier to compare.

This file also re-exports the more detailed model pieces from the conversation, runtime, and session submodules. Those files define the contents; this file defines the whole container that holds them together.

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

**Purpose**: Creates a fresh, empty RolloutTrace for a reducer to fill in as it reads events from a rollout. It sets the basic identity and start time, marks the trace as still running, and prepares empty collections for every kind of record that may be added later.

**Data flow**: It receives the schema version, trace ID, rollout ID, root thread ID, and start timestamp. It copies those into a new RolloutTrace, sets the end time to absent because the run is not finished yet, sets the status to Running, and creates empty sorted maps for threads, turns, messages, model calls, tool calls, terminal records, compactions, interaction edges, and raw payload references. The result is a complete but empty trace object ready to be populated.

**Call relations**: The replay_bundle flow calls this when it needs a blank trace to begin rebuilding or reducing a rollout. Inside this constructor, the empty maps are created with standard map constructors so later reducer steps can insert each discovered conversation item, runtime action, or payload reference into the right place.

*Call graph*: called by 1 (replay_bundle); 1 external calls (new).


### `rollout-trace/src/raw_event.rs`

`data_model` · `cross-cutting trace recording and replay`

This file gives the project a common language for recording trace events. A rollout can include model calls, tool calls, code execution, thread starts and stops, compaction, child-agent results, and lower-level protocol events. Without one shared event shape, the trace log would be harder to check, replay, or reduce into a cleaner graph later.

The central type is RawTraceEvent. Think of it like an envelope around a letter. The envelope always has the same basic facts: schema version, sequence number, timestamp, rollout id, optional thread id, optional turn id, and then the actual event payload. Because every envelope looks the same, the system can read events in order and do basic safety checks before it even understands the specific event inside.

RawTraceEventPayload is the list of possible “letters” inside that envelope. Each variant describes one kind of thing that may happen, such as an inference starting, a tool finishing, a code cell returning, or an unknown future event stored as Other. Some events point to separate raw payloads, using RawPayloadRef, instead of storing large request or response data directly.

The helper method raw_payload_refs gathers those referenced payloads so the writer can make sure the referenced data exists before the event is appended.

#### Function details

##### `RawTraceEventPayload::raw_payload_refs`  (lines 236–311)

```
fn raw_payload_refs(&self) -> Vec<&RawPayloadRef>
```

**Purpose**: This method finds every separate raw payload that a trace event depends on. It is useful before writing an event, because the trace log should not point to request, response, or metadata blobs that have not been stored yet.

**Data flow**: It starts with one RawTraceEventPayload value, such as an inference request, a tool result, or a protocol event. It checks which kind of event it is, then collects the RawPayloadRef values inside it, if any. It returns a list of borrowed payload references; events with no external payloads return an empty list, events with one payload return a one-item list, and the generic Other event returns all payloads it carries.

**Call relations**: This function sits beside the raw event definitions as a consistency helper. When code is preparing to append a raw event, it can call this method to ask, “Which payload blobs must already exist for this event to be valid?” Internally it only builds and returns small lists, using standard vector creation, and it does not write files or change the event.

*Call graph*: 2 external calls (new, vec!).


### `rollout/src/config.rs`

`config` · `config load and startup, then read throughout runtime`

This file is the rollout system’s configuration shape. Think of it like a labeled folder that carries the few addresses and switches the rest of the program needs: the Codex home directory, the SQLite data directory, the current working directory, the model provider name, and a yes-or-no memory-generation flag.

The central idea is the `RolloutConfigView` trait. A trait is a shared promise: anything that implements it can answer the same questions about configuration. That lets setup code, tests, or shared references all provide configuration in the same way.

`RolloutConfig` is the concrete version. It owns its data, using `PathBuf` for stored filesystem paths and `String` for the provider id. The `from_view` function copies values out of any read-only configuration view and turns them into an owned `RolloutConfig`. This matters because startup code can accept flexible inputs, then freeze them into one stable configuration object for later use.

The file also makes references and `Arc` values work as configuration views. `Arc` means “atomic reference-counted pointer,” a safe way for multiple parts of a program to share the same value. These forwarding implementations mean callers do not need to unwrap or clone configuration just to read it.

#### Function details

##### `RolloutConfig::from_view`  (lines 25–33)

```
fn from_view(view: &impl RolloutConfigView) -> Self
```

**Purpose**: Builds a full owned `RolloutConfig` from any read-only configuration view. This is useful when initialization code wants to accept flexible configuration sources but store one stable copy for the rollout system.

**Data flow**: It receives something that can answer configuration questions. It reads each needed value from that view, copies path values into owned path buffers, copies the model provider id into an owned string, and copies the memory-generation flag. The result is a new `RolloutConfig` that no longer depends on the original view.

**Call relations**: This is called during initialization by `init` and `try_init`. In that startup flow, they hand it a configuration-like object, and it asks that object for `codex_home`, `sqlite_home`, `cwd`, `model_provider_id`, and `generate_memories` so the rest of rollout can use a concrete config.

*Call graph*: called by 2 (init, try_init); 5 external calls (codex_home, cwd, generate_memories, model_provider_id, sqlite_home).


##### `RolloutConfig::codex_home`  (lines 37–39)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Returns the configured Codex home directory as a borrowed path. Other code uses this when it needs to find files under the main Codex home area without taking ownership of the stored path.

**Data flow**: It reads the `codex_home` path stored inside the `RolloutConfig` and turns it into a borrowed `Path` view. Nothing is changed; the caller simply gets a read-only look at the path.

**Call relations**: This is one of the methods that makes `RolloutConfig` satisfy `RolloutConfigView`. When code treats a `RolloutConfig` as a configuration view, this method supplies the Codex home path and uses the standard path conversion helper underneath.

*Call graph*: 1 external calls (as_path).


##### `RolloutConfig::sqlite_home`  (lines 41–43)

```
fn sqlite_home(&self) -> &Path
```

**Purpose**: Returns the configured SQLite storage directory as a borrowed path. Code that opens or locates the local database uses this to know where that database-related data should live.

**Data flow**: It reads the stored `sqlite_home` path buffer and returns a read-only path slice of it. The original configuration remains unchanged.

**Call relations**: This supports the `RolloutConfigView` interface for `RolloutConfig`. When initialization or runtime code asks a concrete config for its SQLite location, this method provides it through the normal borrowed-path form.

*Call graph*: 1 external calls (as_path).


##### `RolloutConfig::cwd`  (lines 45–47)

```
fn cwd(&self) -> &Path
```

**Purpose**: Returns the configured current working directory as a borrowed path. This gives the rollout code a stable idea of what directory work should be considered relative to.

**Data flow**: It reads the `cwd` field stored in the config and exposes it as a borrowed `Path`. It does not modify the path or the config.

**Call relations**: This is part of the read-only configuration view implemented by `RolloutConfig`. Any caller using the config through `RolloutConfigView` can ask for the working directory and receive it here.

*Call graph*: 1 external calls (as_path).


##### `RolloutConfig::model_provider_id`  (lines 49–51)

```
fn model_provider_id(&self) -> &str
```

**Purpose**: Returns the configured model provider identifier, such as the name or key for the provider the system should use. This lets the rest of the rollout code choose the right model backend.

**Data flow**: It reads the stored `model_provider_id` string and returns it as a borrowed string slice. No copy is made and the configuration is not changed.

**Call relations**: This method is part of the `RolloutConfigView` implementation for the concrete config. When setup code copies a config through `from_view`, or when other code reads the provider setting, this is the concrete source of that value.


##### `RolloutConfig::generate_memories`  (lines 53–55)

```
fn generate_memories(&self) -> bool
```

**Purpose**: Returns whether memory generation is enabled. This acts like a feature switch that other code can check before doing memory-related work.

**Data flow**: It reads the stored boolean flag and returns that true-or-false value. There are no side effects.

**Call relations**: This completes the concrete config’s implementation of `RolloutConfigView`. Code that needs to decide whether to generate memories can ask through the shared view interface and receive this stored flag.


##### `T::codex_home`  (lines 59–61)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Lets a borrowed configuration object behave just like the configuration object itself when asking for the Codex home directory. This removes friction for callers that only have a reference.

**Data flow**: It receives a reference to something that already knows how to provide configuration. It forwards the Codex home request to the underlying object and returns that same borrowed path.

**Call relations**: This is part of the blanket implementation for `&T`, meaning references automatically support `RolloutConfigView` when the thing they point to does. It hands the request straight through to the underlying `codex_home` method.


##### `T::sqlite_home`  (lines 63–65)

```
fn sqlite_home(&self) -> &Path
```

**Purpose**: Lets a borrowed configuration object provide the SQLite home directory without extra wrapping or copying. Callers can pass references wherever a configuration view is expected.

**Data flow**: It takes a reference to a configuration-capable object, asks the underlying object for its SQLite home path, and returns that borrowed path to the caller.

**Call relations**: This belongs to the reference-forwarding implementation of `RolloutConfigView`. When code has `&config` rather than `config`, this method forwards the SQLite location request to the real config object.


##### `T::cwd`  (lines 67–69)

```
fn cwd(&self) -> &Path
```

**Purpose**: Lets a borrowed configuration object provide the current working directory. This keeps configuration access consistent whether code owns the config or only borrows it.

**Data flow**: It receives a reference, calls the underlying object’s `cwd` method, and returns the borrowed working-directory path it gets back. It changes nothing.

**Call relations**: This is used implicitly when a reference is treated as a `RolloutConfigView`. It simply passes the request down to the object being referenced.


##### `T::model_provider_id`  (lines 71–73)

```
fn model_provider_id(&self) -> &str
```

**Purpose**: Lets a borrowed configuration object provide the model provider id. This avoids unnecessary string copying just because code is working through a reference.

**Data flow**: It takes a reference to a configuration view, asks the underlying value for its provider id, and returns the borrowed string slice. The original value stays untouched.

**Call relations**: As part of the `&T` forwarding implementation, this method makes references fit smoothly into the same configuration-reading flow used by owned configs.


##### `T::generate_memories`  (lines 75–77)

```
fn generate_memories(&self) -> bool
```

**Purpose**: Lets a borrowed configuration object report whether memory generation is enabled. This allows feature checks to work the same way through references.

**Data flow**: It receives a reference, asks the underlying config-like value for the memory-generation flag, and returns that true-or-false answer.

**Call relations**: This forwards the call for any referenced type that already implements `RolloutConfigView`. It keeps callers from needing special cases for borrowed configuration.


##### `Arc::codex_home`  (lines 81–83)

```
fn codex_home(&self) -> &Path
```

**Purpose**: Lets a shared `Arc` configuration object provide the Codex home directory. `Arc` is used when multiple parts of the program need safe shared access to the same config.

**Data flow**: It receives an `Arc` pointing to a configuration-capable object, looks through the shared pointer to the underlying value, asks for the Codex home path, and returns the borrowed result.

**Call relations**: This is part of the `Arc<T>` implementation of `RolloutConfigView`. When shared configuration is passed around, this method forwards the Codex home request to the actual config inside the `Arc`.


##### `Arc::sqlite_home`  (lines 85–87)

```
fn sqlite_home(&self) -> &Path
```

**Purpose**: Lets shared `Arc` configuration provide the SQLite home directory. This means database-related code can read the setting even when config is shared across parts of the program.

**Data flow**: It looks through the `Arc` to the underlying configuration value, asks that value for its SQLite home path, and returns the borrowed path. The shared pointer and config are not changed.

**Call relations**: This forwarding method makes `Arc<T>` usable wherever a `RolloutConfigView` is expected. It passes the SQLite location request on to the config stored inside the shared pointer.


##### `Arc::cwd`  (lines 89–91)

```
fn cwd(&self) -> &Path
```

**Purpose**: Lets shared `Arc` configuration provide the current working directory. This keeps shared configuration just as easy to read as an ordinary config value.

**Data flow**: It receives an `Arc`, gets a reference to the underlying configuration object, asks for the working directory, and returns the borrowed path.

**Call relations**: This fits into the shared-configuration path. When code holds config in an `Arc` and asks for `cwd`, this method forwards that request to the inner object.


##### `Arc::model_provider_id`  (lines 93–95)

```
fn model_provider_id(&self) -> &str
```

**Purpose**: Lets shared `Arc` configuration provide the model provider id. This allows many parts of the program to read which provider to use without copying or unwrapping the config.

**Data flow**: It looks inside the `Arc`, calls the underlying object’s provider-id method, and returns the borrowed string slice. No data is copied or modified.

**Call relations**: This is one of the forwarding methods that makes `Arc<T>` implement `RolloutConfigView`. In shared runtime flows, it passes provider-id reads through to the inner configuration.


##### `Arc::generate_memories`  (lines 97–99)

```
fn generate_memories(&self) -> bool
```

**Purpose**: Lets shared `Arc` configuration report whether memory generation is enabled. This supports simple feature-flag checks even when configuration is shared.

**Data flow**: It receives the shared pointer, reads through it to the underlying config-like object, asks for the memory-generation flag, and returns that boolean value.

**Call relations**: This completes the `Arc<T>` forwarding implementation. When shared configuration is used through the common view interface, this method passes the memory flag request to the real config value.


### trace writing backbone
These files provide the low-level event translation and persistence machinery used by higher-level tracing contexts to serialize payloads and append raw events.

### `rollout-trace/src/protocol_event.rs`

`domain_logic` · `request handling / event recording`

Think of this file as a customs desk between two countries. On one side are many detailed Codex protocol events: turns starting and ending, shell commands, patch attempts, MCP tool calls, collaboration actions, warnings, and more. On the other side is the rollout trace format, which only wants certain events that mark important runtime boundaries.

The file decides which protocol events matter for tracing, converts them into trace-friendly shapes, and ignores the rest. Turn events become trace records saying a Codex turn started or ended, with a completed, failed, or cancelled status. Tool-like actions, such as running a command, applying a patch, calling an MCP tool, or interacting with a collaborator agent, become “started” or “ended” runtime events tied to a tool call id.

An important detail is that the file keeps the original protocol payload available by reference. That means the recorder can save the exact event data for debugging without copying it or reshaping it first. The long match statements are deliberate: when a new protocol event is added elsewhere, the compiler forces this file to make an explicit choice about whether that event should appear in rollout traces.

#### Function details

##### `codex_turn_trace_event`  (lines 38–79)

```
fn codex_turn_trace_event(
    thread_id: AgentThreadId,
    default_turn_id: &str,
    event: &EventMsg,
) -> Option<CodexTurnTraceEvent>
```

**Purpose**: This function looks at a Codex protocol event and decides whether it marks the start or end of a Codex turn. If it does, it creates the matching raw trace event; if not, it returns nothing.

**Data flow**: It receives the agent thread id, a fallback turn id, and one protocol event. For a turn start, it copies the event’s turn id and creates a “turn started” trace payload. For a normal turn completion, it creates a “turn ended” payload with a completed status. For an aborted turn, it uses the event’s turn id if present, otherwise the fallback id, then converts the abort reason into a cancelled-style execution status. For every other protocol event, nothing comes out.

**Call relations**: The trace recording flow calls this from record_codex_turn_event when it is considering whether a protocol event should become a turn-level trace record. When the turn was aborted, this function hands the abort reason to execution_status_for_abort_reason so the trace uses the project’s standard execution status wording.

*Call graph*: calls 1 internal fn (execution_status_for_abort_reason); called by 1 (record_codex_turn_event).


##### `ToolRuntimePayload::serialize`  (lines 118–139)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: This function tells Serde, Rust’s serialization library, how to write out a tool runtime payload. It preserves the exact original protocol event shape instead of converting everything into a generic blob first.

**Data flow**: It receives a ToolRuntimePayload value, which is a wrapper around a borrowed protocol event. It checks which kind of event is inside, then asks that original event to serialize itself. The output is serialized data in the same structure as the underlying protocol event, with no extra copy or manual rebuilding.

**Call relations**: This is used whenever a tool runtime payload is saved or sent through code that relies on Serde serialization. It supports the events produced by tool_runtime_trace_event by making their borrowed payloads writable in the trace.


##### `tool_runtime_trace_event`  (lines 142–290)

```
fn tool_runtime_trace_event(event: &EventMsg) -> Option<ToolRuntimeTraceEvent<'_>>
```

**Purpose**: This function decides whether a protocol event represents the beginning or end of a tool-like action that should appear in the rollout trace. It covers command execution, patch application, MCP tool calls, collaboration actions, and sub-agent activity.

**Data flow**: It receives one protocol event. If the event starts a traced tool action, it returns a “started” trace event containing the tool call id and the original payload. If the event ends a traced action, it returns an “ended” trace event with the tool call id, a completed, failed, or cancelled status, and the original payload. User shell command events are deliberately skipped, and many protocol events that are not runtime boundaries return nothing.

**Call relations**: The trace recorder calls this from record_tool_call_event when protocol events pass through the system. For command and patch endings, it uses the status conversion helpers on ExecCommandStatus and PatchApplyStatus. For collaboration events, it wraps the corresponding begin or end payload so the recorder can keep the original protocol details.

*Call graph*: called by 1 (record_tool_call_event); 15 external calls (CollabAgentInteractionBegin, CollabAgentInteractionEnd, CollabAgentSpawnBegin, CollabAgentSpawnEnd, CollabCloseBegin, CollabCloseEnd, CollabWaitingBegin, CollabWaitingEnd, ExecCommandBegin, ExecCommandEnd (+5 more)).


##### `wrapped_protocol_event_type`  (lines 292–371)

```
fn wrapped_protocol_event_type(event: &EventMsg) -> Option<&'static str>
```

**Purpose**: This function picks out a small set of protocol events that should be recorded as wrapped protocol events and gives each one a stable text name. It is used for general trace visibility around important session-level events.

**Data flow**: It receives one protocol event. For selected events such as session configuration, turn start, turn complete, turn abort, thread rollback, error, warning, and shutdown complete, it returns a short snake_case event type string. For all other protocol events, it returns nothing.

**Call relations**: record_protocol_event calls this when deciding whether to save a protocol event in wrapped form. This function does not build the whole trace record itself; it only answers the question, “Is this event one of the protocol events we wrap, and what should we call it?”

*Call graph*: called by 1 (record_protocol_event).


##### `ExecCommandStatus::trace_execution_status`  (lines 378–384)

```
fn trace_execution_status(&self) -> ExecutionStatus
```

**Purpose**: This function converts a command execution status from the Codex protocol into the rollout trace’s shared execution status language. It keeps command outcomes consistent with other traced actions.

**Data flow**: It receives a command status: completed, failed, or declined. It maps completed to completed, failed to failed, and declined to cancelled. The result is an ExecutionStatus value used by trace events.

**Call relations**: tool_runtime_trace_event uses this when it sees the end of a traced command execution. That lets command-end trace events report their outcome in the same terms as patch, turn, and collaboration events.


##### `PatchApplyStatus::trace_execution_status`  (lines 388–394)

```
fn trace_execution_status(&self) -> ExecutionStatus
```

**Purpose**: This function converts a patch application status from the Codex protocol into the rollout trace’s shared execution status language. It makes patch results comparable to other runtime results in the trace.

**Data flow**: It receives a patch status: completed, failed, or declined. It maps completed to completed, failed to failed, and declined to cancelled. The result is an ExecutionStatus value for the trace.

**Call relations**: tool_runtime_trace_event uses this when it sees the end of a patch application. The converted status is then attached to the tool runtime trace event.


##### `execution_status_for_abort_reason`  (lines 397–404)

```
fn execution_status_for_abort_reason(reason: &TurnAbortReason) -> ExecutionStatus
```

**Purpose**: This function turns a Codex turn abort reason into the rollout trace’s execution status. In the current protocol, every listed abort reason means the turn did not finish normally, so the trace marks it as cancelled.

**Data flow**: It receives a turn abort reason, such as interrupted, replaced, review ended, or budget limited. It maps that reason to ExecutionStatus::Cancelled. The output is the status used in a turn-ended trace event.

**Call relations**: codex_turn_trace_event calls this when it receives a TurnAborted protocol event. This keeps the turn tracing path focused on building the trace event while this helper owns the small rule for interpreting abort reasons.

*Call graph*: called by 1 (codex_turn_trace_event).


### `rollout-trace/src/writer.rs`

`io_transport` · `active throughout tracing during rollout execution`

A rollout trace is like a black-box flight recorder for an agent run. This file is the part that records the black-box data while the run is still active. It does not try to build the final, cleaned-up view of the rollout in memory. Instead, it writes simple raw facts to disk: a manifest that describes the trace, a line-by-line event log, and separate payload files for larger JSON objects such as inference requests and responses.

The main type is `TraceWriter`. It owns a mutex, which is a lock that stops two tasks from writing to the same files and counters at the same time. That matters because tracing can happen from different parts of the system, and the event sequence numbers and payload file names must stay consistent.

The writer first creates the bundle directory and manifest. Later, callers can save a JSON payload file and get back a small reference to it. Events can then include that reference instead of embedding the whole payload. This is like putting a large document in a filing cabinet and writing its cabinet location in the logbook.

One important safety detail is that payload files are written before events that point to them. If the process stops after an event is logged, replay should not find an event that refers to a missing payload file. Each event is flushed to disk immediately, favoring reliable diagnostics over maximum write speed.

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

**Purpose**: Creates a new trace bundle on disk and returns a writer ready to record events. It sets up the payload folder, writes the manifest, opens the raw event log, and initializes the counters used for event order and payload file names.

**Data flow**: It receives a bundle directory, trace ID, rollout ID, and root thread ID. It turns the directory into concrete paths, creates the payload directory, records the current time in milliseconds, builds a manifest, writes that manifest as JSON, and opens the event log file for appending. The result is a `TraceWriter` whose internal state is protected by a lock and starts with sequence number 1 and payload ordinal 1.

**Call relations**: This is the starting point for trace recording. It is called by test setup, thread-writer helpers, and inference-tracing paths when a trace needs to begin. Inside, it relies on `unix_time_ms` to timestamp the bundle and `write_json_file` to persist the manifest before handing back a writer that later calls append and payload-writing methods.

*Call graph*: calls 3 internal fn (new, unix_time_ms, write_json_file); called by 8 (started_inference_attempt, responses_websocket_request_prewarm_traces_logical_request, enabled_attempt_adds_inference_request_header, enabled_context_records_replayable_inference_attempt, create_started_writer_for_thread, child_thread_metadata_creates_spawn_origin_without_delivery_edge, start_root_in_root, writer_records_payload_refs_and_replays_rollout_status); 6 external calls (as_ref, join, new, new, new, create_dir_all).


##### `TraceWriter::write_json_payload`  (lines 86–106)

```
fn write_json_payload(
        &self,
        kind: RawPayloadKind,
        value: &impl Serialize,
    ) -> Result<RawPayloadRef>
```

**Purpose**: Writes a larger JSON payload into the bundle and returns a compact reference that later events can store. This keeps the event log small while still preserving the full request, response, or metadata content.

**Data flow**: It receives a payload kind and any serializable value. It locks the writer state, takes the next payload number, builds a stable payload ID and file path, writes the value to `payloads/<number>.json`, then returns a `RawPayloadRef` containing the ID, kind, and relative path. It also advances the next payload number inside the writer.

**Call relations**: Higher-level tracing code calls this before logging events that need to point at detailed data, such as inference requests, inference responses, tool lifecycle payloads, or follow-up tool output. It uses `lock_inner` so numbering stays safe and `write_json_file` so the payload is actually on disk before any event can refer to it.

*Call graph*: calls 2 internal fn (lock_inner, write_json_file); called by 9 (write_json_payload_best_effort, write_json_payload_best_effort, write_json_payload_best_effort, append_completed_inference, append_inference_request, append_spawn_agent_tool_lifecycle, append_followup_with_tool_output, append_inference_with_tool_call, write_json_payload_best_effort); 1 external calls (format!).


##### `TraceWriter::append`  (lines 109–111)

```
fn append(&self, payload: RawTraceEventPayload) -> Result<RawTraceEvent>
```

**Purpose**: Adds one raw trace event when no extra thread or turn context needs to be supplied separately. It is the convenient default path for simple event logging.

**Data flow**: It receives an event payload. It creates an empty default context and passes both the context and payload to `append_with_context`. The returned value is the complete raw event that was written to disk.

**Call relations**: Tracing helpers for starting threads, starting turns, inference starts, inference completions, and tool-output follow-ups call this when the payload already carries enough information or no envelope context is needed. It delegates all real writing work to `append_with_context`.

*Call graph*: calls 1 internal fn (append_with_context); called by 6 (append_inference_completion, append_inference_start_for_thread, start_thread, start_turn_for_thread, append_followup_with_tool_output, append_inference_with_tool_call); 1 external calls (default).


##### `TraceWriter::append_with_context`  (lines 114–134)

```
fn append_with_context(
        &self,
        context: RawTraceEventContext,
        payload: RawTraceEventPayload,
    ) -> Result<RawTraceEvent>
```

**Purpose**: Writes one complete raw event to the event log, including its sequence number, timestamp, rollout ID, optional thread or turn context, and payload. This is the main event-recording function.

**Data flow**: It receives explicit context and an event payload. It locks the writer, creates a `RawTraceEvent` with the current schema version, next sequence number, current wall-clock time, rollout ID from the manifest, context fields, and payload. It increments the sequence counter, writes the event as one JSON line, writes a newline, flushes the log to disk, and returns the event it wrote.

**Call relations**: This is called directly by tracing paths that have extra context, such as completed inference or spawned-agent tool lifecycle events, and indirectly by `append`. It uses `lock_inner` to keep event order consistent and `unix_time_ms` to timestamp the event before serializing it to the log.

*Call graph*: calls 2 internal fn (lock_inner, unix_time_ms); called by 3 (append_completed_inference, append_spawn_agent_tool_lifecycle, append); 1 external calls (to_writer).


##### `TraceWriter::lock_inner`  (lines 136–141)

```
fn lock_inner(&self) -> MutexGuard<'_, TraceWriterInner>
```

**Purpose**: Safely opens access to the writer’s shared internal state. It also deliberately keeps working even if an earlier panic happened while the lock was held, so later diagnostic events are not lost.

**Data flow**: It reads the mutex inside `TraceWriter` and returns a guard that lets the caller access the manifest, payload directory, event log, and counters. If the mutex was marked poisoned after a panic, it recovers the inner state instead of stopping the trace writer.

**Call relations**: `write_json_payload` calls this before assigning payload numbers, and `append_with_context` calls it before assigning event sequence numbers and writing the event log. It is the small gatekeeper that keeps concurrent trace writes from stepping on each other.

*Call graph*: called by 2 (append_with_context, write_json_payload).


##### `write_json_file`  (lines 144–148)

```
fn write_json_file(path: &Path, value: &impl Serialize) -> Result<()>
```

**Purpose**: Writes a value as nicely formatted JSON to a specific file path. It is a shared helper for manifest files and payload files.

**Data flow**: It receives a file path and a serializable value. It creates or replaces the file at that path, then writes the value as pretty-printed JSON. On failure, it returns an error with path-specific context so the caller can tell which file could not be created or written.

**Call relations**: `TraceWriter::create` uses this to write the bundle manifest, and `TraceWriter::write_json_payload` uses it to write individual payload files. This helper centralizes the disk-writing step so both call sites get the same JSON formatting and error messages.

*Call graph*: called by 2 (create, write_json_payload); 2 external calls (create, to_writer_pretty).


##### `unix_time_ms`  (lines 150–155)

```
fn unix_time_ms() -> i64
```

**Purpose**: Returns the current time as milliseconds since the Unix epoch, which is the common timestamp baseline starting at January 1, 1970 UTC. The trace uses this for bundle start time and event times.

**Data flow**: It asks the system clock for the current time, measures how long it has been since the Unix epoch, converts that duration to milliseconds, and returns it as a signed integer. If the clock is earlier than the epoch, it falls back to zero duration; if the millisecond value is too large, it returns the largest possible integer instead.

**Call relations**: `TraceWriter::create` calls this when stamping the manifest with the trace start time. `TraceWriter::append_with_context` calls it for each event so replay and debugging tools can see when events happened in real-world time.

*Call graph*: called by 2 (append_with_context, create); 2 external calls (now, try_from).


##### `tests::writer_records_payload_refs_and_replays_rollout_status`  (lines 171–264)

```
fn writer_records_payload_refs_and_replays_rollout_status() -> anyhow::Result<()>
```

**Purpose**: Checks that the writer creates a replayable trace bundle with payload references and final rollout status intact. It proves that events and payload files written by this file can be read back into the reduced rollout view.

**Data flow**: It creates a temporary directory, creates a `TraceWriter`, writes a realistic sequence of rollout, thread, turn, inference, and completion events, and writes JSON payloads for metadata and inference data. It then replays the bundle from disk and compares the replayed rollout fields against the expected status, thread, turn, inference payload IDs, and payload path.

**Call relations**: This test exercises the public flow beginning with `TraceWriter::create`, followed by `write_json_payload` and `append`, then hands the finished bundle to `replay_bundle`. Its role is to catch breaks in the contract between the writer and the replay code: if the writer logs events or payload references incorrectly, the replayed rollout will not match the assertions.

*Call graph*: calls 1 internal fn (create); 4 external calls (new, assert_eq!, replay_bundle, json!).


### recording contexts
These files expose the runtime-facing tracing APIs for threads and their specialized child activities such as inference, compaction, code cells, MCP calls, and tool dispatch.

### `rollout-trace/src/thread.rs`

`domain_logic` · `cross-cutting during session and tool execution`

A rollout can involve one main agent thread and several child agent threads. To understand what happened later, the system can write a trace bundle: a folder of events and payload files that describes the rollout like a flight recorder. This file is the thread-level control panel for that recorder.

The important idea is that tracing is optional and best-effort. If the environment variable CODEX_ROLLOUT_TRACE_ROOT is not set, or if creating the trace files fails, the code returns a disabled context. A disabled context accepts the same method calls but writes nothing. That means debugging traces can be turned on without making normal Codex sessions fragile.

When tracing is enabled, ThreadTraceContext stores a shared TraceWriter, the root thread ID, and the current thread ID. It can record the start and end of a thread, selected protocol events, Codex turn events, tool runtime events, child-agent result messages, code-cell execution, model inference attempts, compaction checkpoints, and MCP tool-call correlations. Think of it as a notebook assigned to one worker in a larger team: each worker writes their own actions, but the root notebook also marks when the whole job starts and ends.

The private EnabledThreadTraceContext helpers centralize the repetitive work: write larger JSON payloads to side files, append small event records, attach thread and turn context, and log warnings instead of failing the session.

#### Function details

##### `ThreadTraceContext::disabled`  (lines 95–99)

```
fn disabled() -> Self
```

**Purpose**: Creates a trace context that records nothing. Code uses this when tracing is not requested, or when a child/session should not write into an existing trace bundle.

**Data flow**: Nothing goes in. It builds a ThreadTraceContext whose internal state is Disabled. The result can be passed around safely; later trace calls will simply return without writing files.

**Call relations**: This is the safe fallback used by session setup, tests, and child-thread setup paths. Other methods in this file also return disabled contexts when tracing is unavailable, so callers can keep one simple code path whether tracing is on or off.

*Call graph*: called by 9 (run_codex_thread_interactive, guardian_subagent_does_not_inherit_parent_exec_policy_rules, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_with_config_and_rx, make_session_with_history_source_and_agent_control_and_rx, session_new_fails_when_zsh_fork_enabled_without_packaged_zsh, parent_rollout_thread_trace_for_source, disabled_thread_context_accepts_trace_calls_without_writing).


##### `ThreadTraceContext::start_root_or_disabled`  (lines 106–118)

```
fn start_root_or_disabled(metadata: ThreadStartedTraceMetadata) -> Self
```

**Purpose**: Starts tracing for a root rollout thread if the CODEX_ROLLOUT_TRACE_ROOT environment variable points to a trace directory. If tracing cannot start, it logs a warning and returns a disabled context instead of stopping the session.

**Data flow**: It receives startup metadata about the thread and session. It reads the environment variable, turns it into a path, and asks start_root_in_root to create the bundle. The output is either an enabled root trace context or a disabled one.

**Call relations**: Session creation calls this when a new root thread begins. It hands the real setup work to start_root_in_root, while using ThreadTraceContext::disabled as the fallback whenever the environment is absent or setup fails.

*Call graph*: calls 1 internal fn (start_root_in_root); called by 1 (new); 4 external calls (from, disabled, var_os, warn!).


##### `ThreadTraceContext::start_root_in_root_for_test`  (lines 124–129)

```
fn start_root_in_root_for_test(
        root: &Path,
        metadata: ThreadStartedTraceMetadata,
    ) -> anyhow::Result<Self>
```

**Purpose**: Starts a root trace in a specific directory supplied by a test. This avoids changing process-wide environment variables during tests.

**Data flow**: It receives a root directory and thread-start metadata. It forwards both to start_root_in_root. The result is either an enabled ThreadTraceContext or an error describing why the trace bundle could not be created.

**Call relations**: Trace-related tests call this to build repeatable trace bundles. It exists as a test-friendly doorway into the same root setup path used by normal startup.

*Call graph*: calls 1 internal fn (start_root_in_root); called by 5 (attach_trace_bundle, attach_test_trace, create_in_root_writes_replayable_lifecycle_events, protocol_wrapper_records_selected_events_as_raw_payloads, spawned_thread_start_appends_to_root_bundle).


##### `ThreadTraceContext::start`  (lines 132–146)

```
fn start(
        writer: Arc<TraceWriter>,
        root_thread_id: AgentThreadId,
        metadata: ThreadStartedTraceMetadata,
    ) -> Self
```

**Purpose**: Creates an enabled trace context for one thread inside an existing rollout bundle. It also records that the thread has started.

**Data flow**: It receives a shared TraceWriter, the root thread ID, and metadata for the new thread. It stores the writer and IDs in an EnabledThreadTraceContext, writes a ThreadStarted event through record_thread_started, and returns an enabled ThreadTraceContext.

**Call relations**: start_root_in_root uses this after it creates the trace bundle, and child-thread setup uses it when adding another thread to the same bundle. It is the common point where a live writer becomes a usable thread trace handle.

*Call graph*: calls 1 internal fn (record_thread_started); called by 1 (start_root_in_root); 1 external calls (Enabled).


##### `ThreadTraceContext::is_enabled`  (lines 153–155)

```
fn is_enabled(&self) -> bool
```

**Purpose**: Tells callers whether this context will actually write trace events. This lets callers avoid preparing expensive trace-only data when tracing is off.

**Data flow**: It reads the context’s internal state. It returns true for an Enabled state and false for Disabled. It does not write anything or change the context.

**Call relations**: This is a small guard for outside code. Most methods already check for Disabled internally, but callers can use this before cloning or building large payloads just for tracing.

*Call graph*: 1 external calls (matches!).


##### `ThreadTraceContext::start_child_thread_trace_or_disabled`  (lines 162–174)

```
fn start_child_thread_trace_or_disabled(
        &self,
        metadata: ThreadStartedTraceMetadata,
    ) -> Self
```

**Purpose**: Creates a trace context for a newly spawned child thread that belongs to the same rollout bundle. If the parent is not tracing, the child also gets a disabled context.

**Data flow**: It receives metadata for the child thread. If the current context is Disabled, it returns a disabled child context. If enabled, it reuses the same shared writer and root thread ID, records the child thread start, and returns an enabled child context.

**Call relations**: Session creation for spawned agents calls this when a child thread begins. It routes enabled children through ThreadTraceContext::start, while preserving the no-op behavior when the parent has no trace bundle.

*Call graph*: called by 1 (new); 3 external calls (clone, disabled, start).


##### `ThreadTraceContext::record_ended`  (lines 181–192)

```
fn record_ended(&self, status: RolloutStatus)
```

**Purpose**: Records that this thread has finished, including its final rollout status. If the thread is the root thread, it also records that the whole rollout has ended.

**Data flow**: It receives a RolloutStatus. If tracing is disabled, nothing happens. If enabled, it appends a ThreadEnded event for the current thread; when the current thread is also the root, it appends a RolloutEnded event too.

**Call relations**: This is used near graceful shutdown. It relies on the enabled context’s append helper so write failures become warnings, not session failures.

*Call graph*: 1 external calls (clone).


##### `ThreadTraceContext::record_protocol_event`  (lines 198–214)

```
fn record_protocol_event(&self, event: &EventMsg)
```

**Purpose**: Records selected protocol messages as raw trace breadcrumbs. It deliberately skips noisy event types so the trace stays useful rather than flooded.

**Data flow**: It receives a protocol EventMsg. If tracing is off, or if wrapped_protocol_event_type says this event should not be wrapped, it returns. Otherwise it writes the full event as a JSON payload file and appends a ProtocolEventObserved event pointing to that payload.

**Call relations**: Runtime protocol handling can call this as messages pass through. It asks protocol_event::wrapped_protocol_event_type whether the event matters for raw tracing, then uses the enabled context to store the payload and append the event.

*Call graph*: calls 1 internal fn (wrapped_protocol_event_type).


##### `ThreadTraceContext::record_codex_turn_event`  (lines 217–230)

```
fn record_codex_turn_event(&self, default_turn_id: &str, event: &EventMsg)
```

**Purpose**: Turns certain protocol lifecycle messages into typed Codex turn trace events. A Codex turn is one unit of agent work, such as responding to a user prompt.

**Data flow**: It receives a default turn ID and a protocol EventMsg. If enabled, it asks codex_turn_trace_event to translate the protocol message. If translation succeeds, it appends the resulting trace payload with the proper turn context.

**Call relations**: Protocol event processing can call this alongside raw event recording. The translation logic lives in protocol_event, while this method supplies the current thread identity and writes the result.

*Call graph*: calls 1 internal fn (codex_turn_trace_event).


##### `ThreadTraceContext::record_tool_call_event`  (lines 237–248)

```
fn record_tool_call_event(&self, codex_turn_id: impl Into<CodexTurnId>, event: &EventMsg)
```

**Purpose**: Records runtime observations about a tool call, such as when the tool begins or ends. These are separate from the original tool dispatch, because they describe what happened while Codex executed it.

**Data flow**: It receives a Codex turn ID and a protocol EventMsg. If enabled, it converts the protocol event with tool_runtime_trace_event, turns that into a raw trace payload through raw_tool_runtime_payload, and appends it with the given turn ID.

**Call relations**: Tool execution paths can call this when protocol lifecycle events arrive. The protocol_event module recognizes the tool runtime event; this file adds the thread and turn context and writes it.

*Call graph*: calls 1 internal fn (tool_runtime_trace_event); 1 external calls (into).


##### `ThreadTraceContext::record_agent_result_interaction`  (lines 256–283)

```
fn record_agent_result_interaction(
        &self,
        child_codex_turn_id: impl Into<CodexTurnId>,
        parent_thread_id: impl Into<AgentThreadId>,
        payload: &AgentResultTracePayload<'_
```

**Purpose**: Records the moment a completed child agent sends its result message back to a parent thread. This makes the parent-child handoff explicit in the trace instead of forcing later tools to guess it from prompts.

**Data flow**: It receives the child turn ID, the parent thread ID, and a payload containing the child path, message, and status. If enabled, it stores the full payload as JSON when possible, builds a stable edge ID linking child and parent, and appends an AgentResultObserved event.

**Call relations**: Child-agent completion delivery can call this when notifying the parent. It uses the current thread as the child thread, then writes an edge that later trace reducers can use to rebuild the rollout graph.

*Call graph*: 3 external calls (clone, into, format!).


##### `ThreadTraceContext::record_codex_turn_started`  (lines 290–302)

```
fn record_codex_turn_started(&self, codex_turn_id: impl Into<CodexTurnId>)
```

**Purpose**: Records an explicit Codex turn start event. This is especially useful in trace-focused tests that need valid reducer input without running the whole session loop.

**Data flow**: It receives a Codex turn ID. If tracing is enabled, it appends a CodexTurnStarted event containing that turn ID and the current thread ID. If tracing is disabled, it does nothing.

**Call relations**: Integration tests and any code that needs a direct turn-start hook can call this. It writes through the same context-aware append helper used by other turn-scoped events.

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

**Purpose**: Starts tracing for a first-class code-mode cell and returns a handle for later cell events. A code cell is a runtime unit of code execution visible to the model or user interface.

**Data flow**: It receives the Codex turn ID, runtime cell ID, model-visible call ID, and source JavaScript. It first builds a CodeCellTraceContext with code_cell_trace_context, then records the cell start on that context, and returns the context.

**Call relations**: Code-mode execution calls this when a new cell begins. It delegates context construction to code_cell_trace_context, then immediately records the first lifecycle event.

*Call graph*: calls 1 internal fn (code_cell_trace_context).


##### `ThreadTraceContext::code_cell_trace_context`  (lines 318–332)

```
fn code_cell_trace_context(
        &self,
        codex_turn_id: impl Into<CodexTurnId>,
        runtime_cell_id: impl Into<String>,
    ) -> CodeCellTraceContext
```

**Purpose**: Builds a trace handle for a code-mode cell that may already have started. This lets later code record more events for the same cell without re-emitting a start event.

**Data flow**: It receives a Codex turn ID and runtime cell ID. If tracing is disabled, it returns a disabled CodeCellTraceContext. If enabled, it passes the shared writer, current thread ID, turn ID, and cell ID into CodeCellTraceContext::enabled.

**Call relations**: start_code_cell_trace calls this before recording a start event. Other code can use it when it only needs a handle for an existing cell.

*Call graph*: calls 2 internal fn (disabled, enabled); called by 1 (start_code_cell_trace); 1 external calls (clone).


##### `ThreadTraceContext::start_tool_dispatch_trace`  (lines 339–350)

```
fn start_tool_dispatch_trace(
        &self,
        invocation: impl FnOnce() -> Option<ToolDispatchInvocation>,
    ) -> ToolDispatchTraceContext
```

**Purpose**: Starts tracing for one tool dispatch: the boundary where Codex asks a tool to do something. The tool invocation is built lazily so disabled tracing does not pay the cost of cloning large tool arguments.

**Data flow**: It receives a closure that can create a ToolDispatchInvocation. If tracing is disabled, the closure is never called and a disabled tool trace context is returned. If enabled, it calls the closure; when an invocation exists, it starts and returns a ToolDispatchTraceContext.

**Call relations**: Tool-dispatch code calls this at the start of a tool request. It hands off to ToolDispatchTraceContext::start for the detailed tool lifecycle, while keeping the disabled path cheap.

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

**Purpose**: Creates a reusable trace context for model inference during one Codex turn. It does not start a specific network attempt yet, because retry and fallback logic decides when each concrete request begins.

**Data flow**: It receives a turn ID, model name, and provider name. If disabled, it returns a disabled InferenceTraceContext. If enabled, it packages the shared writer, current thread ID, turn ID, model, and provider into an enabled inference context.

**Call relations**: Model transport code can call this before making requests. The returned context is then used by lower-level inference code when actual attempts, retries, or fallbacks happen.

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

**Purpose**: Creates a trace context for remote compaction, where older conversation history is summarized or replaced by a checkpoint. This needs special tracing because the model request and the later history replacement are both important.

**Data flow**: It receives a turn ID, compaction ID, model name, and provider name. If tracing is off, it returns a disabled CompactionTraceContext. If enabled, it builds an enabled compaction context with the shared writer and current thread ID.

**Call relations**: Remote-compaction code calls this when preparing a checkpoint operation. The returned context records request/response attempts and later checkpoint installation events.

*Call graph*: calls 2 internal fn (disabled, enabled); 2 external calls (clone, into).


##### `ThreadTraceContext::start_mcp_call_trace`  (lines 406–417)

```
fn start_mcp_call_trace(&self, tool_call_id: impl Into<ToolCallId>) -> McpCallTraceContext
```

**Purpose**: Creates a correlation ID for one MCP backend tool request. MCP means Model Context Protocol, a way to connect tools or services to the agent; the extra ID helps match rollout traces with logs from another process.

**Data flow**: It receives the rollout-local tool call ID. If tracing is disabled, it returns a disabled McpCallTraceContext. If enabled, it creates a fresh UUID, returns a trace context containing that UUID, and appends an event linking the tool call ID to the MCP call ID.

**Call relations**: MCP bridge code calls this before sending a concrete backend request. This file records the cross-process link, and McpCallTraceContext carries the generated ID onward.

*Call graph*: calls 2 internal fn (disabled, enabled); 2 external calls (into, new_v4).


##### `start_root_in_root`  (lines 420–444)

```
fn start_root_in_root(
    root: &Path,
    metadata: ThreadStartedTraceMetadata,
) -> anyhow::Result<ThreadTraceContext>
```

**Purpose**: Creates a new trace bundle directory for a root rollout and returns the enabled root thread context. This is the core setup path behind both normal environment-based tracing and test tracing.

**Data flow**: It receives a root directory and thread metadata. It generates a trace ID, builds a bundle path, creates a TraceWriter, writes a RolloutStarted event, logs where the trace is being recorded, and starts the root thread context. On setup failure, it returns an error.

**Call relations**: ThreadTraceContext::start_root_or_disabled calls this during normal startup, and ThreadTraceContext::start_root_in_root_for_test calls it in tests. After creating the writer, it hands control to ThreadTraceContext::start to record the thread start.

*Call graph*: calls 2 internal fn (start, create); called by 2 (start_root_in_root_for_test, start_root_or_disabled); 6 external calls (new, join, new_v4, debug!, format!, warn!).


##### `record_thread_started`  (lines 446–457)

```
fn record_thread_started(
    context: &EnabledThreadTraceContext,
    metadata: ThreadStartedTraceMetadata,
)
```

**Purpose**: Writes the first event for a thread: that the thread started, where it sits in the agent path, and optional startup metadata. This gives later trace readers a stable entry point for that thread.

**Data flow**: It receives an enabled context and thread-start metadata. It tries to store the full metadata as a JSON payload file, then appends a ThreadStarted event containing the thread ID, agent path, and optional reference to that payload.

**Call relations**: ThreadTraceContext::start calls this whenever an enabled root or child thread trace is created. It uses the enabled context’s helper methods so payload and event write failures become warnings.

*Call graph*: calls 2 internal fn (append_best_effort, write_json_payload_best_effort); called by 1 (start).


##### `EnabledThreadTraceContext::write_json_payload_best_effort`  (lines 460–472)

```
fn write_json_payload_best_effort(
        &self,
        kind: RawPayloadKind,
        payload: &impl Serialize,
    ) -> Option<RawPayloadRef>
```

**Purpose**: Writes a larger trace payload as a JSON side file, without letting write failures break the running session. It returns a small reference that later events can point to.

**Data flow**: It receives a payload kind and any serializable payload. It asks TraceWriter to write the JSON. On success it returns a RawPayloadRef; on failure it logs a warning and returns None.

**Call relations**: record_thread_started and raw_tool_runtime_payload use this when an event needs to carry more detail than should be embedded directly. Other enabled trace methods use the same pattern for raw payload capture.

*Call graph*: called by 2 (raw_tool_runtime_payload, record_thread_started); 1 external calls (warn!).


##### `EnabledThreadTraceContext::raw_tool_runtime_payload`  (lines 474–504)

```
fn raw_tool_runtime_payload(
        &self,
        trace_event: crate::protocol_event::ToolRuntimeTraceEvent<'_>,
    ) -> Option<RawTraceEventPayload>
```

**Purpose**: Converts a recognized tool runtime event into the raw trace event format used by the writer. It also stores the detailed tool runtime data as a JSON payload file.

**Data flow**: It receives a ToolRuntimeTraceEvent, either Started or Ended. It writes the event’s detailed payload as a ToolRuntimeEvent JSON file. If that succeeds, it returns a ToolCallRuntimeStarted or ToolCallRuntimeEnded payload containing the tool call ID, status when present, and payload reference.

**Call relations**: ThreadTraceContext::record_tool_call_event uses this after protocol_event has identified a tool runtime lifecycle message. This helper bridges the typed protocol event into the raw event stream.

*Call graph*: calls 1 internal fn (write_json_payload_best_effort).


##### `EnabledThreadTraceContext::append_best_effort`  (lines 506–510)

```
fn append_best_effort(&self, payload: RawTraceEventPayload)
```

**Purpose**: Appends a trace event without extra turn context, while treating failures as warnings. It is used for events that belong to the rollout or thread as a whole.

**Data flow**: It receives a RawTraceEventPayload. It asks TraceWriter to append it to the trace. If writing fails, it logs a warning and returns nothing.

**Call relations**: record_thread_started uses this to write the ThreadStarted event, and the enabled trace flow uses the same idea for rollout-level or thread-level events. It is the simple final write step for events that do not need a Codex turn ID.

*Call graph*: called by 1 (record_thread_started); 1 external calls (warn!).


##### `EnabledThreadTraceContext::append_with_context_best_effort`  (lines 512–524)

```
fn append_with_context_best_effort(
        &self,
        codex_turn_id: CodexTurnId,
        payload: RawTraceEventPayload,
    )
```

**Purpose**: Appends a trace event with thread and Codex turn context attached. This makes later analysis able to place the event inside the right thread and turn.

**Data flow**: It receives a Codex turn ID and a raw event payload. It builds a RawTraceEventContext containing the current thread ID and that turn ID, then asks TraceWriter to append the payload with that context. If writing fails, it logs a warning.

**Call relations**: Turn-scoped recording methods use this after they translate or build their payloads. It is the shared final step for Codex turn events, tool runtime events, agent-result edges, and similar events that need precise placement.

*Call graph*: 2 external calls (clone, warn!).


### `rollout-trace/src/code_cell.rs`

`io_transport` · `during code-mode execution`

A code-mode runtime cell is a piece of JavaScript execution that the assistant starts through the public `exec` tool. This file is the tracing layer for that cell. Its job is to leave a clear breadcrumb trail without forcing the main execution code to know the details of trace files, payload storage, or event shapes.

The central type is `CodeCellTraceContext`. Think of it like a receipt book attached to one running code cell. If tracing is disabled, the receipt book is blank and every recording call returns immediately. If tracing is enabled, it holds a `TraceWriter`, the agent thread ID, the Codex turn ID, and the runtime cell ID. Those IDs make each event easy to connect back to the right conversation and turn.

The file records three important moments: the cell started, the first runtime response arrived, and the cell ended. Runtime responses are also serialized into a raw payload, so the trace keeps evidence of what happened at the runtime boundary. The file is careful not to crash or interrupt execution if tracing fails. Failed writes only produce a warning. That matters because tracing is useful for debugging and replay, but it should not break the user-facing run.

#### Function details

##### `CodeCellTraceContext::disabled`  (lines 57–61)

```
fn disabled() -> Self
```

**Purpose**: Creates a tracing context that accepts recording calls but writes nothing. This is useful when tracing is turned off, because callers can still use the same API without checking a flag each time.

**Data flow**: No outside data goes in. The function builds a `CodeCellTraceContext` whose internal state is `Disabled`. What comes out is a harmless no-op handle: later calls like `record_started` will simply return without changing anything.

**Call relations**: The broader code asks for this when building a code cell trace context and tracing is not available or not wanted. It lets later execution code call the normal recording methods without needing separate disabled-path logic.

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

**Purpose**: Creates a tracing context that knows where to write trace events and which conversation turn and runtime cell those events belong to. Use this when a code cell is known and tracing should be active.

**Data flow**: It receives a shared `TraceWriter`, a thread ID, a Codex turn ID, and a runtime cell ID. It converts the IDs into their stored forms and places them into an enabled context. The result is a `CodeCellTraceContext` that future recording calls can use to write properly labeled events.

**Call relations**: The broader code calls this while constructing the trace context for a real code-mode cell. The returned handle is then carried through cell execution so start, response, and end events can all be tied to the same writer and IDs.

*Call graph*: called by 1 (code_cell_trace_context); 2 external calls (into, Enabled).


##### `CodeCellTraceContext::record_started`  (lines 81–97)

```
fn record_started(
        &self,
        model_visible_call_id: impl Into<ModelVisibleCallId>,
        source_js: impl Into<String>,
    )
```

**Purpose**: Records that a code-mode runtime cell has started. It captures the model-visible call ID and the JavaScript source before that JavaScript has a chance to trigger nested tool calls.

**Data flow**: It reads the context’s current state. If tracing is disabled, nothing happens. If tracing is enabled, it takes the model-visible call ID and source JavaScript, combines them with the runtime cell ID, and sends a `CodeCellStarted` event to the trace writer through `append_with_context_best_effort`.

**Call relations**: Execution code calls this at the beginning of a runtime cell. This function does not write directly; it hands the finished event to `append_with_context_best_effort`, which adds the thread and turn context and tries to append it safely.

*Call graph*: calls 1 internal fn (append_with_context_best_effort); 1 external calls (into).


##### `CodeCellTraceContext::record_initial_response`  (lines 105–117)

```
fn record_initial_response(&self, response: &RuntimeResponse)
```

**Purpose**: Records the first response returned by the public code-mode `exec` tool. This matters because a cell may yield control back to the model while still continuing to run.

**Data flow**: It receives a `RuntimeResponse`. If tracing is disabled, it stops. If tracing is enabled, it translates the response into a simple lifecycle status, stores the full raw response as a JSON payload when possible, and appends a `CodeCellInitialResponse` event with the runtime cell ID, status, and optional payload reference.

**Call relations**: Execution code calls this when the first runtime response is available. It relies on `code_cell_status_for_runtime_response` to summarize the response and `code_cell_response_payload` to store the detailed response, then passes the event to `append_with_context_best_effort`.

*Call graph*: calls 3 internal fn (append_with_context_best_effort, code_cell_response_payload, code_cell_status_for_runtime_response).


##### `CodeCellTraceContext::record_ended`  (lines 120–132)

```
fn record_ended(&self, response: &RuntimeResponse)
```

**Purpose**: Records the final lifecycle point for a code-mode runtime cell. It tells the trace whether the cell completed, failed, yielded, or terminated at the end.

**Data flow**: It receives the final `RuntimeResponse`. With tracing disabled, it does nothing. With tracing enabled, it converts the response into a status, writes the raw response into payload storage when possible, and appends a `CodeCellEnded` event that points back to the same runtime cell.

**Call relations**: Execution code calls this once the runtime cell reaches its terminal point. Like the initial-response path, it uses `code_cell_status_for_runtime_response` and `code_cell_response_payload`, then hands the event to `append_with_context_best_effort` for safe writing.

*Call graph*: calls 3 internal fn (append_with_context_best_effort, code_cell_response_payload, code_cell_status_for_runtime_response).


##### `code_cell_status_for_runtime_response`  (lines 135–147)

```
fn code_cell_status_for_runtime_response(response: &RuntimeResponse) -> CodeCellRuntimeStatus
```

**Purpose**: Turns a detailed runtime response into a simpler status used by trace events. This gives later trace readers an easy way to tell whether the cell yielded, terminated, completed successfully, or failed.

**Data flow**: It receives a `RuntimeResponse`. If the response says the cell yielded, it returns `Yielded`; if it says the cell terminated, it returns `Terminated`; if it is a result, it checks whether there is error text and returns `Failed` or `Completed`. It does not change any outside state.

**Call relations**: `record_initial_response` and `record_ended` call this before writing their events. It supplies the compact status field that sits beside the fuller raw response payload.

*Call graph*: called by 2 (record_ended, record_initial_response).


##### `code_cell_response_payload`  (lines 149–158)

```
fn code_cell_response_payload(
    context: &EnabledCodeCellTraceContext,
    response: &RuntimeResponse,
) -> Option<RawPayloadRef>
```

**Purpose**: Stores the full runtime response as a trace payload and returns a reference to it if that storage succeeds. This keeps detailed evidence available without stuffing the whole response directly into every event.

**Data flow**: It receives the enabled trace context and a `RuntimeResponse`. It wraps the response in a serializable payload shape, asks `write_json_payload_best_effort` to write it as a tool-result payload, and returns either a payload reference or `None` if writing failed.

**Call relations**: `record_initial_response` and `record_ended` call this when they need to attach the raw runtime response to an event. It delegates the actual JSON writing and error handling to `write_json_payload_best_effort`.

*Call graph*: calls 1 internal fn (write_json_payload_best_effort); called by 2 (record_ended, record_initial_response).


##### `write_json_payload_best_effort`  (lines 160–172)

```
fn write_json_payload_best_effort(
    writer: &TraceWriter,
    kind: RawPayloadKind,
    payload: &impl Serialize,
) -> Option<RawPayloadRef>
```

**Purpose**: Tries to write a JSON trace payload without letting failures interrupt the main program. If the write fails, it logs a warning and returns no payload reference.

**Data flow**: It receives a `TraceWriter`, a payload kind, and data that can be serialized to JSON. It asks the writer to store that JSON. On success, it returns the new payload reference. On failure, it emits a warning and returns `None`.

**Call relations**: `code_cell_response_payload` calls this when saving a runtime response. This helper is the safety wrapper around payload writing, so tracing problems stay visible in logs but do not break code execution.

*Call graph*: calls 1 internal fn (write_json_payload); called by 1 (code_cell_response_payload); 1 external calls (warn!).


##### `append_with_context_best_effort`  (lines 174–185)

```
fn append_with_context_best_effort(
    context: &EnabledCodeCellTraceContext,
    payload: RawTraceEventPayload,
)
```

**Purpose**: Appends a trace event with the correct thread and turn information, while treating write failures as warnings instead of fatal errors. It is the common final step for recording code-cell lifecycle events.

**Data flow**: It receives an enabled context and a prepared raw trace event. It builds an event context containing the thread ID and Codex turn ID, then asks the writer to append the event. If appending fails, it logs a warning and otherwise leaves the program alone.

**Call relations**: `record_started`, `record_initial_response`, and `record_ended` all call this after building their specific events. It centralizes the shared context stamping and safe append behavior for every code-cell trace event in this file.

*Call graph*: called by 3 (record_ended, record_initial_response, record_started); 1 external calls (warn!).


### `rollout-trace/src/compaction.rs`

`io_transport` · `during remote compaction attempts and checkpoint installation`

Compaction is like taking a long notebook and rewriting it into a shorter set of notes so future work can continue without carrying every old page. This file creates a small tracing layer around that process. It keeps one stable compaction ID for the overall checkpoint, and gives each upstream request attempt its own request ID, because compaction may retry before it finally succeeds.

The main type, CompactionTraceContext, is the long-lived context for one compaction lifecycle. It can be enabled, with a TraceWriter and identifying details such as thread, turn, model, and provider, or disabled, in which case every tracing call quietly does nothing. That no-op behavior matters because callers can record trace events unconditionally without checking whether tracing is turned on.

When a compaction request starts, the context creates a CompactionTraceAttempt. The attempt records the exact request payload, then later records either the response items or the error. If compaction succeeds and the compacted history becomes the live history, record_installed writes a checkpoint payload showing the old selected history and the replacement history.

Most writes here are “best effort”: if trace writing fails, the main compaction work should not fail just because logging failed. Some failures are ignored, and one checkpoint write path emits a warning.

#### Function details

##### `CompactionTraceContext::disabled`  (lines 91–95)

```
fn disabled() -> Self
```

**Purpose**: Creates a compaction trace context that accepts tracing calls but records nothing. This is useful when tracing is turned off, because the caller can still use the same code path without special checks.

**Data flow**: Nothing comes in. The function builds a CompactionTraceContext marked as disabled. The result is a context object whose later methods will immediately return without writing trace data.

**Call relations**: The broader compaction setup calls this through compaction_trace_context when tracing should be inactive. Later, code may still call start_attempt or record_installed on it, but those calls become harmless no-ops.

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

**Purpose**: Creates a live tracing context for one compaction checkpoint. It stores the trace writer and the identifying information needed to connect later events to the right agent thread, turn, model, provider, and compaction ID.

**Data flow**: It receives a shared TraceWriter, IDs for the thread, turn, and compaction, plus model and provider names. It packages those values into an enabled internal state. The returned context can create traced request attempts and record checkpoint installation.

**Call relations**: The compaction trace setup path calls this through compaction_trace_context when tracing is available. The context it returns is later used by compaction code, especially compact_conversation_history, to start attempts and record final installation.

*Call graph*: called by 1 (compaction_trace_context); 1 external calls (Enabled).


##### `CompactionTraceContext::start_attempt`  (lines 119–132)

```
fn start_attempt(&self, request: &impl Serialize) -> CompactionTraceAttempt
```

**Purpose**: Starts tracing one upstream compaction request attempt and immediately records the request payload. This separates a single retryable request from the larger compaction checkpoint it belongs to.

**Data flow**: It receives a serializable request object. If the context is disabled, it returns a disabled attempt. If enabled, it creates a new request ID, copies the shared compaction context into a new CompactionTraceAttempt, records the request as a trace payload, and returns the attempt for later completion or failure logging.

**Call relations**: compact_conversation_history calls this when it is about to send a compaction request. Internally it uses next_compaction_request_id to label the attempt, falls back to CompactionTraceAttempt::disabled when tracing is off, and then hands the request payload to record_started.

*Call graph*: calls 2 internal fn (disabled, next_compaction_request_id); called by 1 (compact_conversation_history); 1 external calls (Enabled).


##### `CompactionTraceContext::record_installed`  (lines 138–166)

```
fn record_installed(&self, checkpoint: &CompactionCheckpointTracePayload<'_>)
```

**Purpose**: Records the moment when a compacted replacement history becomes the live conversation history. This is the checkpoint event that says, in effect, “from now on, use this shorter history instead of that selected old history.”

**Data flow**: It receives a CompactionCheckpointTracePayload containing the input history chosen for compaction and the replacement history that will be used going forward. If tracing is disabled, nothing happens. If enabled, it writes that checkpoint as a JSON payload, then appends a CompactionInstalled event tied to the thread and turn. If writing fails, it logs a warning and stops or warns again for append failure.

**Call relations**: This function is used after compaction succeeds and the system installs the new history. Unlike the small best-effort helpers used by request attempts, this path explicitly warns if the trace payload or event could not be written, because the checkpoint is an important record of the history change.

*Call graph*: 1 external calls (warn!).


##### `CompactionTraceAttempt::disabled`  (lines 171–175)

```
fn disabled() -> Self
```

**Purpose**: Creates a request-attempt object that records nothing. It is the attempt-level version of a disabled trace context.

**Data flow**: Nothing comes in. The function returns a CompactionTraceAttempt marked as disabled. Later calls such as record_completed or record_failed will see that state and do nothing.

**Call relations**: CompactionTraceContext::start_attempt calls this when someone starts an attempt from a disabled context. This keeps the caller’s code simple: it can still receive an attempt object and report the result without checking whether tracing exists.

*Call graph*: called by 1 (start_attempt).


##### `CompactionTraceAttempt::record_started`  (lines 177–201)

```
fn record_started(&self, request: &impl Serialize)
```

**Purpose**: Records that a compaction request attempt has begun, including the exact request sent to the compact endpoint. This gives later debugging a copy of the input that produced a response or failure.

**Data flow**: It receives a serializable request. If the attempt is disabled, it returns immediately. If enabled, it tries to write the request as a JSON trace payload. If that succeeds, it appends a CompactionRequestStarted event containing the compaction ID, request ID, thread and turn IDs, model, provider, and the saved request payload reference.

**Call relations**: CompactionTraceContext::start_attempt calls this right after creating an enabled attempt. The function relies on write_json_payload_best_effort to save the request body and append_with_context_best_effort to add the event to the trace without disrupting the main compaction flow if tracing fails.

*Call graph*: calls 2 internal fn (append_with_context_best_effort, write_json_payload_best_effort).


##### `CompactionTraceAttempt::record_completed`  (lines 208–231)

```
fn record_completed(&self, output_items: &[ResponseItem])
```

**Purpose**: Records a successful compaction response. It saves the response items in a trace-friendly form so the trace preserves what the compact endpoint returned.

**Data flow**: It receives a slice of ResponseItem values from the compact endpoint. If tracing is disabled, it does nothing. If enabled, it converts each response item with trace_response_item_json, wraps them in a response payload, writes that payload as JSON, and appends a CompactionRequestCompleted event pointing to the saved response.

**Call relations**: CompactionTraceAttempt::record_result calls this when the compact endpoint returned success. It uses the same best-effort trace-writing helpers as record_started, so a trace write problem does not turn a successful compaction into an application failure.

*Call graph*: calls 2 internal fn (append_with_context_best_effort, write_json_payload_best_effort); called by 1 (record_result); 1 external calls (iter).


##### `CompactionTraceAttempt::record_result`  (lines 234–239)

```
fn record_result(&self, result: Result<&[ResponseItem], E>)
```

**Purpose**: Records the outcome of a compaction request without making the caller write separate success and failure branches. It is a small convenience wrapper around the success and error recording paths.

**Data flow**: It receives a Result: either response items on success or an error on failure. For success, it passes the response items to record_completed. For failure, it passes the error to record_failed. It returns no value; its effect is only trace recording.

**Call relations**: Callers can use this after the compact endpoint finishes. Internally it chooses between record_completed and record_failed, so the rest of the tracing behavior stays centralized in those two functions.

*Call graph*: calls 2 internal fn (record_completed, record_failed).


##### `CompactionTraceAttempt::record_failed`  (lines 242–254)

```
fn record_failed(&self, error: impl Display)
```

**Purpose**: Records that a compaction request attempt failed before producing a usable response. It stores the error text alongside the compaction and request IDs so the failed attempt can be understood later.

**Data flow**: It receives an error-like value that can be displayed as text. If tracing is disabled, it returns. If enabled, it converts the error to a string and appends a CompactionRequestFailed event tied to the current compaction and request attempt.

**Call relations**: CompactionTraceAttempt::record_result calls this when the result is an error. It hands the event to append_with_context_best_effort, keeping failure tracing separate from the main application error handling.

*Call graph*: calls 1 internal fn (append_with_context_best_effort); called by 1 (record_result); 1 external calls (to_string).


##### `next_compaction_request_id`  (lines 257–260)

```
fn next_compaction_request_id() -> CompactionRequestId
```

**Purpose**: Creates a unique ID for each upstream compaction request attempt. This matters because one compaction checkpoint can involve several retries, and the trace needs to tell those attempts apart.

**Data flow**: It reads and increments a shared atomic counter, which is a number that can be safely updated from multiple threads. It formats the number into a string like a compaction request ID and returns it.

**Call relations**: CompactionTraceContext::start_attempt calls this whenever it creates an enabled attempt. The returned ID is then used by started, completed, and failed events so all events for the same request attempt line up.

*Call graph*: called by 1 (start_attempt); 1 external calls (format!).


##### `write_json_payload_best_effort`  (lines 262–268)

```
fn write_json_payload_best_effort(
    writer: &TraceWriter,
    kind: RawPayloadKind,
    payload: &impl Serialize,
) -> Option<crate::RawPayloadRef>
```

**Purpose**: Tries to save a trace payload as JSON, but treats failure as non-fatal. It is used when tracing should never break the real compaction work.

**Data flow**: It receives a TraceWriter, a payload kind describing what is being saved, and a serializable payload. It asks the writer to store the JSON. If that succeeds, it returns a reference to the saved payload; if it fails, it returns nothing.

**Call relations**: record_started and record_completed call this before appending events that point to request or response payloads. If it returns nothing, those functions stop recording that event rather than interrupting the compaction request.

*Call graph*: calls 1 internal fn (write_json_payload); called by 2 (record_completed, record_started).


##### `append_with_context_best_effort`  (lines 270–279)

```
fn append_with_context_best_effort(
    context: &EnabledCompactionTraceContext,
    payload: RawTraceEventPayload,
)
```

**Purpose**: Appends a trace event with the thread and turn context attached, while ignoring append failures. It is the common helper for attempt-level trace events.

**Data flow**: It receives the enabled compaction context and an event payload. It builds a RawTraceEventContext containing the thread ID and Codex turn ID, then asks the TraceWriter to append the event. It does not return anything and discards any write error.

**Call relations**: record_started, record_completed, and record_failed call this after they have built their event payloads. It is the final step that places those attempt events into the trace stream.

*Call graph*: called by 3 (record_completed, record_failed, record_started).


### `rollout-trace/src/inference.rs`

`domain_logic` · `request handling`

This file is the tracing layer for model inference calls. An inference call is a request to a model provider, such as asking a hosted model to produce the next response. During one Codex turn, there may be more than one attempt: for example, a retry after an authentication problem, or a fallback from WebSocket to HTTP. This file gives each attempt its own ID, records the request payload, and then records how the attempt ended: completed, failed, or cancelled.

The main idea is a no-op handle. If tracing is disabled, callers still receive an InferenceTraceContext and InferenceTraceAttempt, but their methods quietly do nothing. This keeps the hot request path simple: transport code does not need to keep asking, “is tracing enabled?” It can just say, “record that this started” or “record that this failed.”

When tracing is enabled, the context carries shared facts for the turn, such as the thread ID, turn ID, model, provider name, and trace writer. Each attempt gets a fresh UUID-like inference call ID, which can also be placed into request headers so downstream systems can connect provider-side logs to Codex traces. Terminal events are protected by an atomic flag, which is a small lock-free safety check that prevents the same attempt from being marked both failed and cancelled, for example. The file also saves response summaries, including special care to preserve reasoning content that normal request serialization may omit.

#### Function details

##### `InferenceTraceContext::disabled`  (lines 96–100)

```
fn disabled() -> Self
```

**Purpose**: Creates a tracing context that accepts all the usual tracing calls but records nothing. This is useful when tracing is off, because callers can keep one simple code path instead of checking for tracing everywhere.

**Data flow**: No outside data goes in. The function returns an InferenceTraceContext whose internal state is Disabled. Later calls made through this context become harmless no-ops.

**Call relations**: Many request and test paths create this disabled context when tracing is unavailable or not relevant. When start_attempt is called on it, the flow continues with a disabled InferenceTraceAttempt instead of writing trace data.

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

**Purpose**: Creates a tracing context for one Codex turn. It stores the writer and identifying details needed to attach future inference attempts to the right thread, turn, model, and provider.

**Data flow**: It receives a shared TraceWriter, thread ID, turn ID, model name, and provider name. It wraps those values into an enabled context and returns an InferenceTraceContext ready to start traced attempts.

**Call relations**: Setup code and tests call this when rollout tracing is active. Later, stream_responses_api or stream_responses_websocket use the returned context to start concrete inference attempts.

*Call graph*: called by 5 (started_inference_attempt, responses_websocket_request_prewarm_traces_logical_request, enabled_attempt_adds_inference_request_header, enabled_context_records_replayable_inference_attempt, inference_trace_context); 1 external calls (Enabled).


##### `InferenceTraceContext::start_attempt`  (lines 122–134)

```
fn start_attempt(&self) -> InferenceTraceAttempt
```

**Purpose**: Starts tracking one concrete request attempt to the model provider. A single turn can have several attempts because of retries or fallback paths.

**Data flow**: It reads whether the context is enabled. If disabled, it returns a disabled attempt. If enabled, it clones the turn-level context, generates a new inference call ID, creates an atomic terminal-event guard set to false, and returns an enabled attempt.

**Call relations**: The HTTP and WebSocket streaming paths call this after building a provider request. It hands back an InferenceTraceAttempt that those paths can use to add headers and record started, completed, failed, or cancelled events.

*Call graph*: calls 2 internal fn (disabled, next_inference_call_id); called by 2 (stream_responses_api, stream_responses_websocket); 2 external calls (new, Enabled).


##### `InferenceTraceAttempt::disabled`  (lines 139–143)

```
fn disabled() -> Self
```

**Purpose**: Creates a single inference attempt that records nothing. This lets callers use the same attempt methods even when tracing is off.

**Data flow**: No input is needed. The function returns an InferenceTraceAttempt with Disabled state, so later calls like add_request_headers or record_completed simply return without changing anything.

**Call relations**: This is used directly by tests and WebSocket paths, and indirectly by InferenceTraceContext::start_attempt when the parent context is disabled.

*Call graph*: called by 4 (stream_responses_websocket, response_stream_records_last_model_feedback_ids, start_attempt, disabled_attempt_adds_no_request_headers).


##### `InferenceTraceAttempt::inference_call_id`  (lines 145–152)

```
fn inference_call_id(&self) -> Option<&str>
```

**Purpose**: Returns the attempt’s unique tracing ID if this attempt is being traced. Disabled attempts have no ID.

**Data flow**: It reads the attempt state. For a disabled attempt it returns None. For an enabled attempt it returns the stored inference call ID as text.

**Call relations**: InferenceTraceAttempt::add_request_headers calls this before adding the trace ID to outgoing HTTP headers. It keeps the header code from needing to know the internal enabled-or-disabled layout.

*Call graph*: called by 1 (add_request_headers).


##### `InferenceTraceAttempt::add_request_headers`  (lines 155–167)

```
fn add_request_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds a trace ID header to an outgoing provider request when tracing is enabled. This helps connect Codex’s trace record with logs or handling on the provider side.

**Data flow**: It receives a mutable HTTP header map. It asks the attempt for its inference call ID; if there is none, it changes nothing. If there is an ID and it can be safely represented as a header value, it inserts it under the x-codex-inference-call-id header name.

**Call relations**: Transport code calls this while preparing a provider request. It relies on inference_call_id, and it is intentionally best-effort: if something unexpected prevents making the header, the provider request is still allowed to continue.

*Call graph*: calls 1 internal fn (inference_call_id); 2 external calls (insert, from_str).


##### `InferenceTraceAttempt::record_started`  (lines 174–197)

```
fn record_started(&self, request: &impl Serialize)
```

**Purpose**: Records that an inference attempt has begun and saves the request payload that should be replayed or inspected later. This gives the trace a clear “what was sent to the model” starting point.

**Data flow**: It receives any serializable request object. If the attempt is disabled, nothing happens. If enabled, it writes the request as a raw inference-request payload; if that succeeds, it appends an InferenceStarted event containing the attempt ID, thread ID, turn ID, model, provider, and payload reference.

**Call relations**: Request-sending code calls this once the model-visible request is known. It uses write_json_payload_best_effort to save the request body and append_with_context_best_effort to add the event to the trace.

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

**Purpose**: Records that a provider attempt finished successfully. It saves a compact response summary, including response IDs, optional token usage, and completed output items.

**Data flow**: It receives the response ID, optional upstream request ID, optional token usage, and output items. It first claims the terminal slot so only one final event can be recorded. Then it writes a response payload summary. If that succeeds, it appends an InferenceCompleted event with the response details and payload reference.

**Call relations**: map_response_events calls this when the response stream reaches a successful end. It depends on take_terminal_attempt to prevent duplicate endings, write_response_payload_best_effort to save the response summary, and append_with_context_best_effort to write the trace event.

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

**Purpose**: Records that an inference attempt failed before completion. If some complete output items were already seen, it also saves them as partial evidence.

**Data flow**: It receives an error, an optional upstream request ID, and any completed output items observed before failure. It claims the terminal slot; if another final event was already recorded, it stops. If there are output items, it writes a partial response payload. Then it appends an InferenceFailed event with the attempt ID, request ID, error text, and optional partial payload reference.

**Call relations**: map_response_events calls this when the provider request or stream ends in an error. It shares the same terminal guard and response-payload helper as completed and cancelled recording.

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

**Purpose**: Records that Codex intentionally stopped consuming a provider stream. This can happen when the turn is interrupted or another message takes priority.

**Data flow**: It receives a cancellation reason, an optional upstream request ID, and any output items already completed. It claims the terminal slot. If there are partial output items, it writes them as a response payload. Then it appends an InferenceCancelled event with the reason and any partial evidence.

**Call relations**: map_response_events calls this when the stream is stopped on purpose rather than succeeding or failing. Like record_failed and record_completed, it uses take_terminal_attempt so an attempt has only one final lifecycle event.

*Call graph*: calls 3 internal fn (take_terminal_attempt, append_with_context_best_effort, write_response_payload_best_effort); called by 1 (map_response_events); 2 external calls (to_string, is_empty).


##### `InferenceTraceAttempt::take_terminal_attempt`  (lines 304–313)

```
fn take_terminal_attempt(&self) -> Option<&EnabledInferenceTraceAttempt>
```

**Purpose**: Allows exactly one final event to be recorded for an enabled attempt. This prevents confusing traces where the same attempt appears to both fail and complete, for example.

**Data flow**: It reads the attempt state. Disabled attempts return None. Enabled attempts use an atomic boolean, which is a thread-safe true-or-false flag, to switch terminal_recorded from false to true. If it was already true, it returns None; otherwise it returns the enabled attempt data.

**Call relations**: record_completed, record_failed, and record_cancelled all call this before writing their final event. It is the shared gatekeeper for the attempt’s ending.

*Call graph*: called by 3 (record_cancelled, record_completed, record_failed).


##### `trace_response_item_json`  (lines 321–345)

```
fn trace_response_item_json(item: &ResponseItem) -> JsonValue
```

**Purpose**: Converts a model response item into JSON for trace evidence, while preserving reasoning content that normal serialization may leave out. This helps the trace reflect what Codex actually received, not only what would be sent back to a model later.

**Data flow**: It receives one ResponseItem. It first serializes the item to JSON. If serialization fails, it creates a JSON object describing the serialization error. For reasoning items with readable content, it inserts that content into the JSON object. It returns the final JSON value.

**Call relations**: write_response_payload_best_effort uses this for every output item in a response summary. A test calls it directly to prove that reasoning content omitted by the normal serializer is restored for traces.

*Call graph*: called by 1 (traced_response_item_preserves_reasoning_content_omitted_by_normal_serializer); 1 external calls (to_value).


##### `next_inference_call_id`  (lines 347–349)

```
fn next_inference_call_id() -> InferenceCallId
```

**Purpose**: Creates a fresh unique ID for one inference attempt. This ID ties together trace events and can be propagated in request headers.

**Data flow**: No input is needed. It generates a new version-4 UUID, which is a random unique identifier, converts it to text, and returns it as an InferenceCallId.

**Call relations**: InferenceTraceContext::start_attempt calls this whenever an enabled context begins a new provider request attempt.

*Call graph*: called by 1 (start_attempt); 1 external calls (new_v4).


##### `write_json_payload_best_effort`  (lines 351–357)

```
fn write_json_payload_best_effort(
    writer: &TraceWriter,
    kind: RawPayloadKind,
    payload: &impl Serialize,
) -> Option<crate::RawPayloadRef>
```

**Purpose**: Writes a JSON payload to the trace store, but treats failure as non-fatal. Tracing should never be the reason a model request fails.

**Data flow**: It receives a TraceWriter, a payload kind, and a serializable payload. It asks the writer to store the payload as JSON. If writing succeeds, it returns a payload reference; if writing fails, it returns None.

**Call relations**: record_started uses this to save request payloads. write_response_payload_best_effort also uses it after building a response summary.

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

**Purpose**: Builds and writes the trace’s summary of an inference response. It records stable response identity, provider request identity, token usage when known, and completed output items.

**Data flow**: It receives an enabled attempt, optional response ID, optional upstream request ID, optional token usage, and response items. It converts each response item into trace-friendly JSON, wraps everything in a TracedResponseStreamOutput object, and writes that object as an inference-response payload. It returns a payload reference if writing succeeds, or None if it does not.

**Call relations**: record_completed calls this for full successful responses. record_failed and record_cancelled call it only when there are partial output items worth saving.

*Call graph*: calls 1 internal fn (write_json_payload_best_effort); called by 3 (record_cancelled, record_completed, record_failed); 1 external calls (iter).


##### `append_with_context_best_effort`  (lines 379–388)

```
fn append_with_context_best_effort(
    context: &EnabledInferenceTraceContext,
    payload: RawTraceEventPayload,
)
```

**Purpose**: Appends a trace event with the thread and turn already filled in, while ignoring write failures. It keeps trace-writing errors from disrupting model traffic.

**Data flow**: It receives the enabled tracing context and an event payload. It builds a RawTraceEventContext containing the thread ID and Codex turn ID, then asks the writer to append the event. The append result is discarded, so no error is returned.

**Call relations**: record_started, record_completed, record_failed, and record_cancelled all use this as their final step after preparing the event they want to add to the trace.

*Call graph*: called by 4 (record_cancelled, record_completed, record_failed, record_started).


##### `tests::disabled_attempt_adds_no_request_headers`  (lines 405–411)

```
fn disabled_attempt_adds_no_request_headers()
```

**Purpose**: Checks that a disabled attempt does not modify outgoing request headers. This confirms that the no-op tracing path is safe and quiet.

**Data flow**: It creates an empty header map and a disabled attempt. It asks the attempt to add request headers, then verifies the header map is still empty.

**Call relations**: This test exercises InferenceTraceAttempt::disabled and InferenceTraceAttempt::add_request_headers from the disabled path.

*Call graph*: calls 1 internal fn (disabled); 2 external calls (new, assert!).


##### `tests::enabled_attempt_adds_inference_request_header`  (lines 414–440)

```
fn enabled_attempt_adds_inference_request_header() -> anyhow::Result<()>
```

**Purpose**: Checks that an enabled attempt adds a valid inference call ID header. This proves trace IDs can travel with provider requests.

**Data flow**: It creates a temporary trace writer, builds an enabled context, starts an attempt, and passes an empty header map to add_request_headers. It then checks that the expected header exists, matches the attempt’s own ID, and parses as a UUID.

**Call relations**: This test covers the enabled context setup, attempt creation, and header propagation flow through InferenceTraceContext::enabled, InferenceTraceContext::start_attempt, and InferenceTraceAttempt::add_request_headers.

*Call graph*: calls 2 internal fn (enabled, create); 5 external calls (new, new, new, assert!, assert_eq!).


##### `tests::enabled_context_records_replayable_inference_attempt`  (lines 443–494)

```
fn enabled_context_records_replayable_inference_attempt() -> anyhow::Result<()>
```

**Purpose**: Checks that an enabled tracing context records a complete inference attempt that can later be read back for replay or inspection.

**Data flow**: It creates a temporary trace, writes prerequisite thread and turn events, creates an enabled inference context, starts an attempt, records a request, and records a successful completion. Then it loads the replay bundle and verifies that one inference call exists with the expected thread, turn, completed status, upstream request ID, and raw payload count.

**Call relations**: This test follows the main happy path through InferenceTraceContext::enabled, record_started, record_completed, TraceWriter storage, and replay_bundle reading.

*Call graph*: calls 2 internal fn (enabled, create); 5 external calls (new, new, assert_eq!, replay_bundle, json!).


##### `tests::traced_response_item_preserves_reasoning_content_omitted_by_normal_serializer`  (lines 497–523)

```
fn traced_response_item_preserves_reasoning_content_omitted_by_normal_serializer()
```

**Purpose**: Checks that trace serialization keeps readable reasoning content that the normal protocol serializer omits. This protects important evidence in rollout traces.

**Data flow**: It builds a reasoning response item containing a summary, raw reasoning content, and encrypted content. It serializes the item normally and also through trace_response_item_json. It verifies the normal JSON lacks the content field while the traced JSON includes it.

**Call relations**: This test directly guards the special behavior in trace_response_item_json, which is later used when response payloads are written for completed, failed, or cancelled attempts.

*Call graph*: calls 1 internal fn (trace_response_item_json); 3 external calls (assert_eq!, to_value, vec!).


### `rollout-trace/src/tool_dispatch.rs`

`io_transport` · `tool dispatch tracing during request handling`

When Codex decides to use a tool, that moment is an important boundary. This file turns that boundary into trace events: one event when the tool call starts, and one when it finishes or fails. Think of it like a shipping label and delivery receipt for each tool call. The label says what was sent, where it came from, and what kind of package it is; the receipt says whether it arrived and what came back.

The main handle is ToolDispatchTraceContext. It can be enabled, meaning it has a TraceWriter and enough IDs to attach events to the right thread and turn, or disabled, meaning all later trace calls quietly do nothing. This lets the rest of the system call tracing code without constantly checking whether tracing is active.

The file also defines the small data shapes used at this boundary: ToolDispatchInvocation for the incoming tool request, ToolDispatchPayload for the different kinds of tool input, and ToolDispatchResult for the result returned to the caller. It converts these into raw trace payloads, writes larger JSON payloads separately, and appends compact trace events that point to them.

A key behavior is “best effort” writing. If trace payload writing or event appending fails, the code logs a warning but does not break the actual tool call. It also suppresses one known non-canonical code-mode boundary to avoid double-counting the same tool work.

#### Function details

##### `ToolDispatchTraceContext::disabled`  (lines 131–135)

```
fn disabled() -> Self
```

**Purpose**: Creates a trace context that accepts trace calls but records nothing. This is used when tracing is turned off or when this particular tool boundary should not be recorded.

**Data flow**: No input is needed. It builds a ToolDispatchTraceContext whose internal state is Disabled. The result is a harmless handle that later completion or failure calls can use without causing any trace output.

**Call relations**: The wider trace setup calls this through start_tool_dispatch_trace when it needs a no-op trace handle. ToolDispatchTraceContext::start also returns this kind of handle when suppresses_tool_dispatch_trace says this dispatch should be skipped.

*Call graph*: called by 1 (start_tool_dispatch_trace).


##### `ToolDispatchTraceContext::is_enabled`  (lines 141–143)

```
fn is_enabled(&self) -> bool
```

**Purpose**: Tells callers whether this context will actually record a result. Callers can use this to avoid doing extra work, such as formatting or cloning large tool outputs, when no trace will be written.

**Data flow**: It reads the context’s internal state. If the state is Enabled, it returns true; otherwise it returns false. It does not change anything.

**Call relations**: The higher-level record_completed flow checks this before preparing caller-side result data. Internally it simply tests the context state.

*Call graph*: called by 1 (record_completed); 1 external calls (matches!).


##### `ToolDispatchTraceContext::start`  (lines 146–161)

```
fn start(writer: Arc<TraceWriter>, invocation: ToolDispatchInvocation) -> Self
```

**Purpose**: Starts tracing for one resolved tool call. It records the “tool call started” event and returns a context that can later record the matching completion or failure.

**Data flow**: It receives a shared TraceWriter and a ToolDispatchInvocation containing the tool IDs, name, requester, and input. First it checks whether this dispatch should be suppressed. If so, it returns a disabled context. Otherwise it stores the writer and IDs in an enabled context, writes the start event, and returns that enabled context.

**Call relations**: The broader start_tool_dispatch_trace entry point calls this when tool routing has decided what will run. This function asks suppresses_tool_dispatch_trace whether to skip the trace, calls record_started to write the opening event, and then hands the returned context back to the caller for later completion.

*Call graph*: calls 2 internal fn (record_started, suppresses_tool_dispatch_trace); called by 1 (start_tool_dispatch_trace); 2 external calls (disabled, Enabled).


##### `ToolDispatchTraceContext::record_completed`  (lines 164–177)

```
fn record_completed(&self, status: ExecutionStatus, result: ToolDispatchResult)
```

**Purpose**: Records that a traced tool call finished with a normal result, whether successful or failed according to the supplied status. It captures the result in the trace format expected by the rest of the tracing system.

**Data flow**: It reads the context state, the execution status, and the tool result. If the context is disabled, it returns immediately. If enabled, it converts the public result shape into the raw response shape and passes it along to be written as the end event.

**Call relations**: The higher-level record_completed flow calls this after a tool has produced a caller-facing result. This function delegates the actual payload writing and event append to append_tool_call_ended.

*Call graph*: calls 1 internal fn (append_tool_call_ended); called by 1 (record_completed).


##### `ToolDispatchTraceContext::record_failed`  (lines 180–191)

```
fn record_failed(&self, error: impl Display)
```

**Purpose**: Records that a tool dispatch failed before it could produce a normal result payload. This keeps failures visible in traces even when there is no ordinary tool response to store.

**Data flow**: It receives an error value that can be displayed as text. If tracing is disabled, it does nothing. If enabled, it turns the error into a string, marks the status as Failed, wraps the error in a trace response, and records the end event.

**Call relations**: The higher-level record_failed flow calls this when dispatch itself breaks. Like record_completed, it hands the final writing work to append_tool_call_ended.

*Call graph*: calls 1 internal fn (append_tool_call_ended); called by 1 (record_failed); 1 external calls (to_string).


##### `suppresses_tool_dispatch_trace`  (lines 194–198)

```
fn suppresses_tool_dispatch_trace(invocation: &ToolDispatchInvocation) -> bool
```

**Purpose**: Decides whether a specific tool dispatch should be left out of this trace layer. It prevents recording a known non-canonical code-mode boundary so the trace does not show duplicate or misleading tool calls.

**Data flow**: It examines the invocation’s payload type, namespace, and tool name. It returns true only for a custom payload with no namespace whose tool name matches the public code-mode tool name. All other invocations return false.

**Call relations**: ToolDispatchTraceContext::start calls this before writing anything. If it returns true, start returns a disabled context instead of calling record_started.

*Call graph*: called by 1 (start); 1 external calls (matches!).


##### `record_started`  (lines 200–233)

```
fn record_started(context: &EnabledToolDispatchTraceContext, invocation: ToolDispatchInvocation)
```

**Purpose**: Writes the trace event that marks the beginning of a tool call. It prepares a readable summary, stores the full input payload, and attaches requester and identity information.

**Data flow**: It receives an enabled context and the invocation. It takes the tool name, namespace, requester, and payload from the invocation; classifies the tool kind; builds a label and short input preview; converts the full input into JSON; writes that JSON as a separate payload; converts requester details into trace fields; then appends a ToolCallStarted event. The trace writer is changed by adding the payload and event when those writes succeed.

**Call relations**: ToolDispatchTraceContext::start calls this after it has built an enabled context. This function coordinates several helpers: dispatched_tool_kind, dispatched_tool_label, requester_fields, write_json_payload_best_effort, and append_with_context_best_effort.

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

**Purpose**: Turns the high-level description of who requested the tool into the exact fields stored in a raw trace event. It separates model-requested calls from code-cell-requested calls.

**Data flow**: It receives a ToolDispatchRequester. For a model request, it outputs the model-visible call ID, no runtime tool ID, and a raw requester value saying Model. For a code-cell request, it outputs no model-visible call ID, the runtime tool call ID, and a raw requester value containing the runtime cell ID.

**Call relations**: record_started calls this while building the ToolCallStarted event. The returned fields are placed directly into that event so later trace readers can tell who caused the tool dispatch.

*Call graph*: called by 1 (record_started).


##### `dispatched_tool_kind`  (lines 261–277)

```
fn dispatched_tool_kind(tool_name: &str, _payload: &ToolDispatchPayload) -> ToolCallKind
```

**Purpose**: Classifies a tool name into a standard trace category, such as shell command, web search, image generation, or agent control. This makes traces easier to group and read than using raw tool names alone.

**Data flow**: It receives the tool name and the payload. It matches known names to standard ToolCallKind values. If the name is not recognized, it returns an Other category that still preserves the original name.

**Call relations**: record_started calls this before writing the start event. The kind it returns becomes part of the tool call summary in the trace.

*Call graph*: called by 1 (record_started).


##### `dispatched_tool_label`  (lines 279–288)

```
fn dispatched_tool_label(
    tool_name: &str,
    tool_namespace: Option<&str>,
    _payload: &ToolDispatchPayload,
) -> String
```

**Purpose**: Builds the human-readable label shown for a dispatched tool. If the tool belongs to a namespace, the label includes both namespace and tool name.

**Data flow**: It receives the tool name, an optional namespace, and the payload. If a namespace is present, it returns a string like namespace.tool_name. If not, it returns just the tool name.

**Call relations**: record_started calls this when preparing the ToolCallStarted summary. The label is stored in the trace so readers can quickly recognize what ran.

*Call graph*: called by 1 (record_started); 1 external calls (format!).


##### `ToolDispatchPayload::log_payload_preview`  (lines 291–298)

```
fn log_payload_preview(&self) -> String
```

**Purpose**: Creates a short, safe preview of the tool input for the trace summary. This gives readers a quick glance at what was requested without putting the full payload into the event summary.

**Data flow**: It reads the payload variant. For function calls it previews the argument string; for search it previews the query; for custom input it previews the input text; for local shell it joins the command words into one command line. It passes that text to truncate_preview and returns the shortened string.

**Call relations**: record_started uses this while building the input_preview for the ToolCallStarted summary. It relies on truncate_preview to enforce the length limit.

*Call graph*: calls 1 internal fn (truncate_preview).


##### `ToolDispatchPayload::into_json_payload`  (lines 300–333)

```
fn into_json_payload(self) -> JsonValue
```

**Purpose**: Converts the tool input into a structured JSON value that can be stored as the full invocation payload. This preserves the details needed for later debugging or replay-style inspection.

**Data flow**: It consumes the ToolDispatchPayload. Depending on the variant, it builds a JSON object with a type field and the relevant input fields, such as function arguments, search parameters, custom input, or local shell command settings. The output is a serde_json value ready to be written by the trace writer.

**Call relations**: record_started calls this before writing the invocation payload. The resulting JSON is then passed to write_json_payload_best_effort.

*Call graph*: 1 external calls (json!).


##### `truncate_preview`  (lines 336–344)

```
fn truncate_preview(value: &str) -> String
```

**Purpose**: Shortens long text to a fixed preview length. This keeps trace summaries readable while still showing the beginning of the input.

**Data flow**: It receives a string slice. It takes at most 160 characters, preserving character boundaries, and adds “...” if there was more text after that. It returns the preview string.

**Call relations**: ToolDispatchPayload::log_payload_preview calls this for every kind of previewable input. It is a small helper used before the start event summary is written.

*Call graph*: called by 1 (log_payload_preview).


##### `append_tool_call_ended`  (lines 346–361)

```
fn append_tool_call_ended(
    context: &EnabledToolDispatchTraceContext,
    status: ExecutionStatus,
    response: &DispatchedToolTraceResponse<'_>,
)
```

**Purpose**: Writes the trace event that marks the end of a tool call. It stores the result payload and appends a ToolCallEnded event with the final status.

**Data flow**: It receives the enabled context, an execution status, and a response shape. It writes the response as a JSON payload, getting back an optional reference to that payload. Then it appends a ToolCallEnded event containing the tool call ID, status, and payload reference. The trace writer gains the result payload and event if writing succeeds.

**Call relations**: ToolDispatchTraceContext::record_completed and ToolDispatchTraceContext::record_failed both call this. It uses write_json_payload_best_effort for the result body and append_with_context_best_effort for the final event.

*Call graph*: calls 2 internal fn (append_with_context_best_effort, write_json_payload_best_effort); called by 2 (record_completed, record_failed).


##### `write_json_payload_best_effort`  (lines 363–375)

```
fn write_json_payload_best_effort(
    writer: &TraceWriter,
    kind: RawPayloadKind,
    payload: &impl Serialize,
) -> Option<RawPayloadRef>
```

**Purpose**: Tries to write a JSON payload to the trace store without risking the main program flow. If writing fails, it logs a warning and lets execution continue.

**Data flow**: It receives a TraceWriter, a payload kind, and something serializable as JSON. It asks the writer to store the payload. On success, it returns a reference to the stored payload. On failure, it logs the error and returns None.

**Call relations**: record_started calls this for invocation inputs, and append_tool_call_ended calls it for results. It is the file’s safety wrapper around TraceWriter::write_json_payload.

*Call graph*: calls 1 internal fn (write_json_payload); called by 2 (append_tool_call_ended, record_started); 1 external calls (warn!).


##### `append_with_context_best_effort`  (lines 377–388)

```
fn append_with_context_best_effort(
    context: &EnabledToolDispatchTraceContext,
    payload: RawTraceEventPayload,
)
```

**Purpose**: Appends a raw trace event with the thread and turn context attached, while treating trace failures as non-fatal. This keeps tracing useful but never lets it break tool execution.

**Data flow**: It receives an enabled context and a raw trace event payload. It builds an event context from the stored thread ID and Codex turn ID, then asks the writer to append the event. If appending fails, it logs a warning and returns without raising the error.

**Call relations**: record_started uses this for ToolCallStarted events, and append_tool_call_ended uses it for ToolCallEnded events. It is the shared final step for adding events to the trace.

*Call graph*: called by 2 (append_tool_call_ended, record_started); 1 external calls (warn!).


##### `tests::suppresses_only_noncanonical_dispatch_boundaries`  (lines 395–426)

```
fn suppresses_only_noncanonical_dispatch_boundaries()
```

**Purpose**: Checks that trace suppression is narrow and only skips the intended non-canonical code-mode boundary. This protects against accidentally hiding ordinary custom tools or namespaced tools from traces.

**Data flow**: It builds three sample invocations: the special code-mode custom call, a different custom tool, and a namespaced version of the code-mode tool. It asserts that only the first one is suppressed and the other two are still traceable.

**Call relations**: The test calls the local tests::invocation helper to build inputs, then calls suppresses_tool_dispatch_trace through assertions. It documents the intended behavior used by ToolDispatchTraceContext::start.

*Call graph*: 1 external calls (assert!).


##### `tests::classifies_interrupt_agent_as_close_agent`  (lines 429–439)

```
fn classifies_interrupt_agent_as_close_agent()
```

**Purpose**: Checks that the interrupt_agent tool is grouped under the CloseAgent trace category. This keeps agent interruption events classified with other agent-closing actions.

**Data flow**: It passes the tool name interrupt_agent and a sample function payload into dispatched_tool_kind. It asserts that the returned kind is ToolCallKind::CloseAgent.

**Call relations**: This test exercises dispatched_tool_kind directly. That same classifier is used by record_started when writing real ToolCallStarted events.

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

**Purpose**: Builds a small ToolDispatchInvocation for tests. It removes repeated setup code so the tests can focus on the behavior they are checking.

**Data flow**: It receives a tool name, optional namespace, requester, and payload. It fills in fixed test IDs for thread, turn, and tool call, converts the tool name to a string, and returns a complete ToolDispatchInvocation.

**Call relations**: tests::suppresses_only_noncanonical_dispatch_boundaries calls this to create sample invocations. It is test-only support code and is not part of the runtime tracing flow.


### `rollout-trace/src/mcp.rs`

`domain_logic` · `request handling`

When the system decides to actually run an MCP request, tracing needs a reliable way to say, “this specific backend call belongs to this specific trace event.” This file provides that small bridge. Think of it like putting a discreet luggage tag on a request before it leaves, so later tooling can match the returned suitcase to the right trip.

The main type is McpCallTraceContext. It can be disabled, meaning it carries no ID and changes nothing, or enabled, meaning it holds one MCP call ID created by the trace system. The important public action is add_request_meta. It takes the request’s existing metadata, if any, and adds a private key named codex_bridge_mcp_call_id when tracing is enabled.

The code is deliberately cautious. If metadata is already a JSON object, it adds the ID while preserving the existing fields. If there is no metadata, it creates a new object containing only the ID. If the metadata is some unexpected JSON shape, like a string or list, it leaves it alone rather than risking a broken MCP request. Tracing is treated as best-effort: useful when possible, but never allowed to interfere with the real backend call.

#### Function details

##### `McpCallTraceContext::disabled`  (lines 20–22)

```
fn disabled() -> Self
```

**Purpose**: Creates a trace context that does nothing. This is used when rollout tracing is not active, so MCP requests can continue normally without extra metadata.

**Data flow**: Nothing goes in. The function creates a McpCallTraceContext with no stored MCP call ID. The result is a context whose later add_request_meta call will return request metadata unchanged.

**Call relations**: start_mcp_call_trace calls this when it decides there should be no trace information for an MCP call. From that point on, callers can still use the same context-shaped object, but it behaves like a no-op placeholder.

*Call graph*: called by 1 (start_mcp_call_trace).


##### `McpCallTraceContext::enabled`  (lines 25–29)

```
fn enabled(mcp_call_id: McpCallId) -> Self
```

**Purpose**: Creates a trace context for one real MCP backend execution. It stores the unique MCP call ID that will later be attached to the outgoing request.

**Data flow**: An MCP call ID goes in. The function wraps that ID inside a McpCallTraceContext. The result is a context that can expose the ID internally and add it to request metadata.

**Call relations**: start_mcp_call_trace calls this when tracing is active and a concrete MCP call needs to be linked to a rollout trace. The test tests::enabled_mcp_trace_adds_bridge_correlation_meta also calls it to prove that an enabled context adds the expected correlation field.

*Call graph*: called by 2 (enabled_mcp_trace_adds_bridge_correlation_meta, start_mcp_call_trace).


##### `McpCallTraceContext::mcp_call_id`  (lines 32–34)

```
fn mcp_call_id(&self) -> Option<&str>
```

**Purpose**: Returns the stored MCP call ID, if tracing is enabled. It gives the rest of this file a simple way to ask whether this context is active.

**Data flow**: The function reads the McpCallTraceContext. If it contains an ID, it returns that ID as text; if it contains no ID, it returns nothing. It does not change the context.

**Call relations**: McpCallTraceContext::add_request_meta calls this before touching metadata. That check decides whether the function should add a trace tag or leave the request exactly as it was.

*Call graph*: called by 1 (add_request_meta).


##### `McpCallTraceContext::add_request_meta`  (lines 37–63)

```
fn add_request_meta(&self, meta: Option<JsonValue>) -> Option<JsonValue>
```

**Purpose**: Adds the private trace correlation ID to one outgoing MCP request’s metadata when tracing is enabled. It is careful not to disturb existing metadata or break requests if the metadata is in an unexpected form.

**Data flow**: The current optional JSON metadata goes in, along with the trace context’s stored ID if there is one. If there is no ID, the same metadata comes back unchanged. If there is an ID and the metadata is a JSON object, the function inserts codex_bridge_mcp_call_id into that object. If there is no metadata, it creates a new JSON object with that field. If the metadata is not an object, it returns it unchanged.

**Call relations**: This is the main helper other MCP request-building code would use before sending a backend call. It first calls McpCallTraceContext::mcp_call_id to decide whether tracing is active, then uses JSON object and string construction helpers to place the ID into the request metadata when safe.

*Call graph*: calls 1 internal fn (mcp_call_id); 3 external calls (Object, String, new).


##### `tests::disabled_mcp_trace_leaves_request_meta_unchanged`  (lines 74–81)

```
fn disabled_mcp_trace_leaves_request_meta_unchanged()
```

**Purpose**: Checks that a disabled trace context is truly harmless. If tracing is off, existing request metadata should not be edited.

**Data flow**: The test starts with sample JSON metadata containing a source field. It passes that metadata through a disabled McpCallTraceContext. The expected result is exactly the same metadata that went in.

**Call relations**: This test exercises the no-op path of McpCallTraceContext::add_request_meta through McpCallTraceContext::disabled. It guards the promise that tracing can be turned off without changing MCP requests.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::enabled_mcp_trace_adds_bridge_correlation_meta`  (lines 84–98)

```
fn enabled_mcp_trace_adds_bridge_correlation_meta()
```

**Purpose**: Checks that an enabled trace context adds the private MCP call ID while preserving existing metadata. This proves the correlation tag is added without erasing other request information.

**Data flow**: The test creates an enabled context with the ID mcp-call-id and sample metadata containing a source field. It runs add_request_meta, reads the resulting JSON object, and verifies that the original source field remains and the private correlation key contains the trace ID.

**Call relations**: This test calls McpCallTraceContext::enabled to build an active trace context, then verifies the behavior expected from McpCallTraceContext::add_request_meta. It documents the normal tracing path: keep existing metadata, add the bridge-private ID, and make the request traceable.

*Call graph*: calls 1 internal fn (enabled); 2 external calls (assert_eq!, json!).


### reducer entry and conversation reconstruction
These files establish deterministic replay and rebuild the model-visible conversation transcript from normalized payload content and inference or compaction history.

### `rollout-trace/src/reducer/conversation.rs`

`domain_logic` · `trace reduction, when model-facing payloads are processed`

A trace contains many snapshots of what was sent to or received from the model. Those snapshots can repeat old messages, omit earlier history, or replace history after compaction. This file is the part of the reducer that turns those messy snapshots into stable conversation items with stable IDs.

The main idea is reconciliation: compare the current model-facing payload with what the reducer already knows. If an item is the same as an earlier one, reuse its ID. If it is new, create a new conversation item. This is like keeping a shared photo album from repeated exports: when an export includes photos you already have, you do not add duplicates; when it includes a new photo, you add it once.

Requests are treated as the model-visible input. Responses are immediately appended because they are new output from the model. Incremental requests that only send a delta are expanded by looking up the previous response they refer to. Compaction checkpoints are special: they record both the old input history, a marker showing where history was compressed, and the replacement history that future requests should use as the new baseline.

The file also has careful matching rules for reasoning items. Some reasoning payloads may appear once with readable text and later only as encrypted content. The reducer treats the encrypted part as the stable identity and merges readable evidence when it can.

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

**Purpose**: Turns a model request payload into the list of conversation item IDs that were visible to the model. It preserves existing IDs for repeated history and creates new IDs for newly introduced input.

**Data flow**: It receives the time, model call ID, thread and turn IDs, and a reference to the raw request payload. It reads the JSON payload, extracts the input array, normalizes the raw model items into the reducer’s common shape, then reconciles those items against the current thread snapshot. If the request points to a previous response, it rebuilds the omitted prefix from that earlier request and response before adding the new items. It returns the full list of request item IDs and updates the thread’s conversation list and latest snapshot.

**Call relations**: This is called when the reducer sees an inference request. It hands the normalized input to TraceReducer::reconcile_conversation_items, then records the resulting IDs through TraceReducer::append_thread_conversation_items. It relies on normalize_model_items to turn provider-shaped JSON into the project’s common conversation shape.

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

**Purpose**: Turns a model response payload into conversation items produced by that model call. It also records token usage on the matching inference call when the payload contains it.

**Data flow**: It receives the time, inference call ID, and raw response payload reference. It reads the JSON, extracts output_items, looks up which thread and turn the inference call belongs to, normalizes the output, and appends it after the current thread snapshot. It returns the IDs of the response items and updates the conversation snapshot and inference usage information.

**Call relations**: This runs after a model response is observed. It calls TraceReducer::reconcile_conversation_items in append-only mode because model output should be added after the known prefix, then uses TraceReducer::append_thread_conversation_items to make those items part of the thread transcript.

*Call graph*: calls 3 internal fn (append_thread_conversation_items, reconcile_conversation_items, normalize_model_items); 3 external calls (Ok, bail!, vec!).


##### `TraceReducer::reconcile_conversation_items`  (lines 193–277)

```
fn reconcile_conversation_items(
        &mut self,
        items: Vec<NormalizedConversationItem>,
        context: ReconcileItems<'_>,
    ) -> Result<Vec<String>>
```

**Purpose**: Matches a list of normalized model-visible items against the current known conversation, reusing old IDs where safe and creating new items where needed. This is the central duplicate-avoidance and identity-preserving routine for live conversation snapshots.

**Data flow**: It receives normalized items plus context such as thread, turn, time, producer information, starting position, and reconciliation mode. For each item, it checks whether the expected existing item still matches; if not, a full snapshot may search elsewhere in the snapshot for matching content, while append-only mode treats mismatches as an error. It updates sightings, links model-visible tool and code-cell items, resolves pending agent edges, flushes pending code-cell starts, and returns the ordered item IDs.

**Call relations**: TraceReducer::reduce_inference_request and TraceReducer::reduce_inference_response both delegate to this function. It uses TraceReducer::ensure_call_id_consistency and TraceReducer::item_matches before deciding whether to reuse an ID, calls TraceReducer::find_matching_snapshot_item when position alone is not enough, creates new items with TraceReducer::create_conversation_item, and refreshes existing items through TraceReducer::update_conversation_item_from_sighting.

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

**Purpose**: Processes a compaction checkpoint, where old conversation history is compressed and replaced by a shorter installed history. It records both the boundary and the replacement so later requests reconcile against the right baseline.

**Data flow**: It receives time, thread and turn IDs, a compaction ID, and the raw checkpoint payload. It reads input_history and replacement_history arrays, normalizes both, reconciles the input history against existing candidates, creates a special compaction marker item, then creates or reconciles the replacement items as fresh post-compaction history. It appends the input items, marker, and replacement items to the thread and returns all three groups of IDs.

**Call relations**: This is called by the compaction-reduction path when a checkpoint payload is installed. It uses required_array to validate the expected JSON fields, normalize_model_items for the model-shaped arrays, TraceReducer::reconcile_detached_conversation_items for histories that are not simply the current live snapshot, TraceReducer::create_conversation_item for the marker, and TraceReducer::append_thread_conversation_items to record the transcript effects.

*Call graph*: calls 5 internal fn (append_thread_conversation_items, create_conversation_item, reconcile_detached_conversation_items, normalize_model_items, required_array); 4 external calls (new, Ok, from_ref, vec!).


##### `TraceReducer::reconcile_detached_conversation_items`  (lines 360–402)

```
fn reconcile_detached_conversation_items(
        &mut self,
        items: Vec<NormalizedConversationItem>,
        context: DetachedReconcileItems<'_>,
    ) -> Result<Vec<String>>
```

**Purpose**: Reconciles conversation items that come from a detached history, such as compaction input or replacement history, rather than the normal live request snapshot. It can reuse matching candidate items but does not depend on current position in the live thread snapshot.

**Data flow**: It receives normalized items and a detached context containing candidate IDs, thread and turn IDs, time, and producer information. For each item, it verifies call ID consistency, looks for an unused matching candidate, creates a new item if none matches, updates producer and reasoning information, attaches tool or code-cell links, resolves pending edges, and returns the resulting IDs.

**Call relations**: TraceReducer::reduce_compaction_checkpoint calls this for both the pre-compaction input history and the replacement history. It shares much of the same inner work as TraceReducer::reconcile_conversation_items, especially consistency checks, item updates, and link attachment.

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

**Purpose**: Creates a brand-new conversation item record and stores it in the rollout. It is used whenever reconciliation decides that no existing item safely represents the current model-visible content.

**Data flow**: It receives the thread, optional turn ID, first-seen time, normalized item content, and producer references. It asks for the next unique conversation item ID, builds a ConversationItem with the normalized role, channel, kind, body, call ID, and producer data, inserts it into the rollout map, and returns the new ID.

**Call relations**: This is called from TraceReducer::reconcile_conversation_items, TraceReducer::reconcile_detached_conversation_items, and TraceReducer::reduce_compaction_checkpoint when they need a fresh item. It gets unique names from TraceReducer::next_conversation_item_id.

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

**Purpose**: Updates an already-known conversation item when the same item is seen again. This mainly enriches reasoning items and adds any newly discovered producer links without duplicating them.

**Data flow**: It receives an item ID, the newly normalized sighting of that item, and producer references. It looks up the stored item, merges reasoning body details when appropriate, appends any producer references not already present, and returns success or an error if the item ID does not exist or reasoning content conflicts.

**Call relations**: Both reconciliation functions call this after deciding which ID represents an item. It delegates the delicate reasoning merge to merge_reasoning_body.

*Call graph*: calls 1 internal fn (merge_reasoning_body); called by 2 (reconcile_conversation_items, reconcile_detached_conversation_items); 2 external calls (Ok, bail!).


##### `TraceReducer::append_thread_conversation_items`  (lines 453–465)

```
fn append_thread_conversation_items(
        &mut self,
        thread_id: &str,
        item_ids: &[String],
    ) -> Result<()>
```

**Purpose**: Adds conversation item IDs to a thread’s transcript without adding duplicates. This makes newly reduced items visible in the thread-level conversation order.

**Data flow**: It receives a thread ID and a slice of item IDs. It finds the thread, checks each ID, and appends only those not already present. It changes the thread’s conversation_item_ids list and returns success or an error from thread lookup.

**Call relations**: The request, response, and compaction reducers call this after they have reduced payloads into item IDs. It is the final step that connects individual conversation item records to the thread transcript.

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

**Purpose**: Searches a previous snapshot for an unused item whose content matches the current normalized item. It helps preserve IDs even when a full request snapshot has reordered repeated history.

**Data flow**: It receives a list of previous item IDs, the IDs already reused in the current pass, and the normalized item to match. It scans for the first previous ID that has not already been used and whose stored item matches the normalized content. It returns that ID if found, otherwise nothing.

**Call relations**: TraceReducer::reconcile_conversation_items uses this in full-snapshot mode when position-based matching fails or when the current item extends beyond the old snapshot. TraceReducer::reconcile_detached_conversation_items uses it to reuse candidate items during compaction-related reconciliation.

*Call graph*: called by 2 (reconcile_conversation_items, reconcile_detached_conversation_items).


##### `TraceReducer::ensure_call_id_consistency`  (lines 481–499)

```
fn ensure_call_id_consistency(
        &self,
        thread_id: &str,
        normalized: &NormalizedConversationItem,
    ) -> Result<()>
```

**Purpose**: Protects against one model-visible call ID being reused for different content in the same thread. This matters because call IDs are used to connect tool or code execution records to conversation items.

**Data flow**: It receives a thread ID and a normalized item. If the item has no call ID, it returns success. If it has a call ID, it scans existing conversation items in that thread with the same call ID and kind; if any such item has different content, it returns an error. Otherwise it succeeds.

**Call relations**: Both reconciliation functions call this before reusing or creating an item. It relies on conversation_item_matches to decide whether existing content is truly the same.

*Call graph*: calls 1 internal fn (conversation_item_matches); called by 2 (reconcile_conversation_items, reconcile_detached_conversation_items); 2 external calls (Ok, bail!).


##### `TraceReducer::item_matches`  (lines 501–506)

```
fn item_matches(&self, item_id: &str, normalized: &NormalizedConversationItem) -> bool
```

**Purpose**: Checks whether a stored conversation item ID represents the same content as a normalized item. It is a small helper that hides the lookup and comparison details.

**Data flow**: It receives an item ID and normalized item. It looks up the stored conversation item; if it is missing, the answer is false. If found, it compares the stored item to the normalized one and returns true or false.

**Call relations**: TraceReducer::reconcile_conversation_items uses this while deciding whether an item at a particular snapshot position can be reused. The actual comparison rules live in conversation_item_matches.

*Call graph*: calls 1 internal fn (conversation_item_matches); called by 1 (reconcile_conversation_items).


##### `TraceReducer::next_conversation_item_id`  (lines 508–512)

```
fn next_conversation_item_id(&mut self) -> String
```

**Purpose**: Generates the next unique conversation item ID. This gives every newly created conversation item a stable name inside the reduced rollout.

**Data flow**: It reads the reducer’s next conversation item number, increments that number for the future, formats the old number as a string like conversation_item:123, and returns it.

**Call relations**: TraceReducer::create_conversation_item calls this whenever it needs to insert a new item into the rollout.

*Call graph*: called by 1 (create_conversation_item); 1 external calls (format!).


##### `required_array`  (lines 556–567)

```
fn required_array(
    payload: &'a Value,
    key: &str,
    raw_payload: &RawPayloadRef,
) -> Result<&'a Vec<Value>>
```

**Purpose**: Reads a named JSON field and confirms it is an array. It gives compaction checkpoint parsing a clear error when an expected history field is missing or has the wrong shape.

**Data flow**: It receives a JSON payload, the field name to read, and the raw payload reference for error reporting. It looks up the field and checks that it is an array. It returns a reference to that array or an error message naming the payload and missing field.

**Call relations**: TraceReducer::reduce_compaction_checkpoint calls this for input_history and replacement_history before normalizing those arrays.

*Call graph*: called by 1 (reduce_compaction_checkpoint); 1 external calls (get).


##### `conversation_item_matches`  (lines 569–587)

```
fn conversation_item_matches(
    item: &ConversationItem,
    normalized: &NormalizedConversationItem,
) -> bool
```

**Purpose**: Compares a stored conversation item with a normalized item to decide whether they are the same logical transcript entry. It checks all identity-defining fields while using special rules for reasoning content.

**Data flow**: It receives a stored ConversationItem and a normalized item. It compares role, channel, kind, agent message, call ID, and body. For ordinary items it compares body parts directly, while reasoning items may match by encrypted identity even if readable text differs. It returns true if the items represent the same content.

**Call relations**: TraceReducer::ensure_call_id_consistency and TraceReducer::item_matches both use this as their core comparison. It delegates body comparison to conversation_body_matches or reasoning_body_matches depending on the item kind.

*Call graph*: calls 2 internal fn (conversation_body_matches, reasoning_body_matches); called by 2 (ensure_call_id_consistency, item_matches).


##### `conversation_body_matches`  (lines 589–608)

```
fn conversation_body_matches(left: &ConversationBody, right: &ConversationBody) -> bool
```

**Purpose**: Checks whether two conversation bodies have the same visible parts. It treats JSON parts specially by comparing their summary text rather than raw payload IDs, because two equivalent JSON parts can come from different raw payload records.

**Data flow**: It receives two ConversationBody values. It first checks that they have the same number of parts, then compares each pair in order. JSON parts match when their summaries match; other parts must be exactly equal. It returns true or false.

**Call relations**: conversation_item_matches uses this for normal body comparison. reasoning_body_matches and merge_reasoning_body also use it as the first, simplest check before applying reasoning-specific rules.

*Call graph*: called by 3 (conversation_item_matches, merge_reasoning_body, reasoning_body_matches).


##### `reasoning_body_matches`  (lines 610–628)

```
fn reasoning_body_matches(left: &ConversationBody, right: &ConversationBody) -> bool
```

**Purpose**: Compares reasoning bodies in a way that tolerates different readable forms of the same encrypted reasoning item. This prevents the reducer from creating duplicates when the response includes readable reasoning but a later request only includes the encrypted blob.

**Data flow**: It receives two conversation bodies. It first tries the normal body comparison. If that fails, it looks for an encoded reasoning part in each body and compares the encoded label and value. It returns true when either the full body matches or the encoded identity matches.

**Call relations**: conversation_item_matches uses this for reasoning items, and merge_reasoning_body uses it before combining evidence from two sightings. It gets the encoded identity through reasoning_encoded_part.

*Call graph*: calls 2 internal fn (conversation_body_matches, reasoning_encoded_part); called by 2 (conversation_item_matches, merge_reasoning_body).


##### `merge_reasoning_body`  (lines 630–673)

```
fn merge_reasoning_body(
    existing: &mut ConversationBody,
    incoming: &ConversationBody,
) -> Result<()>
```

**Purpose**: Combines two sightings of the same reasoning item so the stored item keeps the best available readable text, summaries, and encrypted identity. It refuses to merge if the encrypted identity shows they are actually different reasoning items.

**Data flow**: It receives the stored body as mutable data and an incoming body. If the bodies already match, it does nothing. If they do not represent the same encoded reasoning item, it returns an error. Otherwise it keeps existing text or summary parts when present, fills missing ones from the incoming body, preserves the encoded parts, rewrites the stored body in that order, and returns success.

**Call relations**: TraceReducer::update_conversation_item_from_sighting calls this whenever a reasoning item is seen again. It uses conversation_body_matches and reasoning_body_matches for safety, then uses reasoning_text_parts, reasoning_summary_parts, and reasoning_encoded_parts to assemble the enriched body.

*Call graph*: calls 5 internal fn (conversation_body_matches, reasoning_body_matches, reasoning_encoded_parts, reasoning_summary_parts, reasoning_text_parts); called by 1 (update_conversation_item_from_sighting); 2 external calls (Ok, bail!).


##### `reasoning_text_parts`  (lines 675–680)

```
fn reasoning_text_parts(body: &ConversationBody) -> Vec<&ConversationPart>
```

**Purpose**: Collects the readable text parts from a reasoning body. These are the human-readable explanation fragments, when the provider includes them.

**Data flow**: It receives a ConversationBody, scans its parts, keeps only Text parts, and returns references to those parts. It does not change the body.

**Call relations**: merge_reasoning_body calls this on both the existing and incoming bodies to decide which readable text to preserve.

*Call graph*: called by 1 (merge_reasoning_body).


##### `reasoning_summary_parts`  (lines 682–687)

```
fn reasoning_summary_parts(body: &ConversationBody) -> Vec<&ConversationPart>
```

**Purpose**: Collects summary parts from a reasoning body. Summaries are shorter readable descriptions that may appear alongside or instead of full reasoning text.

**Data flow**: It receives a ConversationBody, scans its parts, keeps only Summary parts, and returns references to them. It does not change the body.

**Call relations**: merge_reasoning_body calls this while rebuilding the best combined reasoning body from existing and incoming sightings.

*Call graph*: called by 1 (merge_reasoning_body).


##### `reasoning_encoded_parts`  (lines 689–694)

```
fn reasoning_encoded_parts(body: &ConversationBody) -> Vec<&ConversationPart>
```

**Purpose**: Collects encrypted or encoded reasoning parts from a body. These parts act as the stable identity for reasoning items across different payload snapshots.

**Data flow**: It receives a ConversationBody, scans its parts, keeps only Encoded parts, and returns references to them. It does not change the body.

**Call relations**: merge_reasoning_body calls this after confirming the reasoning item identity, so the rebuilt stored body keeps the encoded content.

*Call graph*: called by 1 (merge_reasoning_body).


##### `reasoning_encoded_part`  (lines 696–704)

```
fn reasoning_encoded_part(body: &ConversationBody) -> Option<(&str, &str)>
```

**Purpose**: Finds the first encoded reasoning part and returns its label and value. This gives reasoning comparison a compact identity to compare.

**Data flow**: It receives a ConversationBody, scans parts until it finds an Encoded part, and returns the encoded label and value as borrowed strings. If there is no encoded part, it returns nothing.

**Call relations**: reasoning_body_matches calls this for both bodies when normal body comparison fails. Matching encoded parts allow two differently serialized reasoning bodies to be treated as the same item.

*Call graph*: called by 1 (reasoning_body_matches).


### `rollout-trace/src/reducer/mod.rs`

`orchestration` · `trace replay / bundle reduction`

A trace bundle stores what happened as a line-by-line log of raw events, plus separate payload files for larger JSON bodies. This file is the reducer’s front door. Its job is like turning a box of timestamped receipts into a readable trip diary: it keeps the original evidence, but also builds a structured account of threads, turns, model calls, tool calls, code cells, compactions, and agent-to-agent messages.

The main function, `replay_bundle`, opens the bundle manifest, creates an empty `RolloutTrace`, then reads the raw event log one JSON line at a time. Each event is sent to `TraceReducer::apply_event`, which records any raw payload references first, then looks at the event kind and routes it to the right reducer logic. Most detailed work lives in neighboring modules such as `inference`, `tool`, `thread`, `conversation`, `code_cell`, and `compaction`.

The `TraceReducer` also keeps temporary lookup tables for things that arrive out of order. For example, a runtime code-cell event may arrive before the model response item that proves where it came from, so the reducer queues it until ownership can be checked. At the end, pending spawn edges are resolved, because only then does the reducer know whether a child thread produced the preferred target item or needs a fallback.

#### Function details

##### `replay_bundle`  (lines 44–86)

```
fn replay_bundle(bundle_dir: impl AsRef<Path>) -> Result<RolloutTrace>
```

**Purpose**: Reads one local trace bundle from disk and rebuilds it into a `RolloutTrace`. This is the high-level replay entry for callers who want the reduced trace rather than the raw event log.

**Data flow**: It receives a bundle directory path. It reads the manifest file to get basic rollout identity and start information, creates a fresh reducer with empty tracking tables, then opens the raw event log. For each non-empty line, it parses a raw event from JSON and applies it to the reducer. After all lines are replayed, it resolves any edges that needed whole-bundle knowledge, then returns the completed `RolloutTrace` or an error with context if reading or parsing failed.

**Call relations**: This is the outside caller’s way into the reducer. It sets up the `TraceReducer`, feeds events to `TraceReducer::apply_event` in file order, and finally returns the reducer’s accumulated rollout. It also creates the initial `RolloutTrace` using the bundle manifest, so later event handling has a graph to fill in.

*Call graph*: calls 1 internal fn (new); 9 external calls (as_ref, join, to_path_buf, new, new, open, new, from_reader, from_str).


##### `TraceReducer::read_payload_json`  (lines 139–147)

```
fn read_payload_json(&self, payload: &RawPayloadRef) -> Result<Value>
```

**Purpose**: Loads the JSON body for a raw payload reference stored in the bundle. Reducer steps use this when an event points to a separate payload file and they need to inspect a small part of that JSON to build the reduced trace.

**Data flow**: It receives a `RawPayloadRef`, which contains the payload’s path and identifier. It joins that path with the bundle directory, opens the file, parses it as JSON, and returns the parsed `serde_json::Value`. If the file cannot be opened or parsed, it returns an error that names the payload being read.

**Call relations**: This helper is available to the reducer logic when typed replay needs details from an external payload file. It depends on the reducer’s stored bundle directory, which was set up by `replay_bundle` before any events were applied.

*Call graph*: 3 external calls (open, join, from_reader).


##### `TraceReducer::apply_event`  (lines 149–480)

```
fn apply_event(&mut self, event: RawTraceEvent) -> Result<()>
```

**Purpose**: Applies one raw trace event to the in-progress reduced rollout. It is the central dispatcher that decides what each event means and sends it to the appropriate reducer path.

**Data flow**: It receives a parsed `RawTraceEvent`. Before interpreting the event, it records every raw payload reference into the rollout so the reduced trace can still point back to original evidence. Then it matches on the event’s payload kind. Start events create or update objects, end events mark objects finished with status and time, inference and tool events are routed to their specialized reducers, code-cell events may be recorded immediately or queued, and malformed or unsupported cases return an error. The output is either a successful update to the reducer’s internal `RolloutTrace` and pending tables, or an explanatory failure.

**Call relations**: During replay, `replay_bundle` calls this once for each non-empty event-log line. Inside, it first calls `TraceReducer::insert_raw_payload` for evidence bookkeeping, then routes the event to the right part of the reducer. Some branches reject impossible data with an error, such as a compaction-installed event missing the thread or turn it belongs to.

*Call graph*: calls 1 internal fn (insert_raw_payload); 1 external calls (bail!).


##### `TraceReducer::insert_raw_payload`  (lines 482–486)

```
fn insert_raw_payload(&mut self, payload: &RawPayloadRef)
```

**Purpose**: Records that a raw payload file exists and belongs to this trace. This keeps the reduced rollout linked to the original data without copying the full raw body into the graph.

**Data flow**: It receives a reference to a raw payload record. It clones that small reference and inserts it into the rollout’s `raw_payloads` map, keyed by the payload’s raw payload id. Afterward, the rollout can point back to that payload whenever someone needs the original evidence.

**Call relations**: This is called by `TraceReducer::apply_event` before the event is interpreted. That means every event’s payload references are preserved consistently, even when the event’s semantic reduction is handled elsewhere or, for debug-only protocol wrapper events, does not create a reduced object.

*Call graph*: called by 1 (apply_event); 1 external calls (clone).


### `rollout-trace/src/reducer/conversation/normalize.rs`

`domain_logic` · `request and response reduction`

The trace reducer receives conversation data in a “Responses-shaped” JSON format, where different item types use different fields and rules. This file normalizes those varied shapes into `NormalizedConversationItem`, a simpler in-between record that says: who spoke, which channel it belongs to, what kind of item it is, what its body contains, and whether it is tied to a tool call. Think of it like sorting a mixed bag of receipts, notes, and tickets into labeled folders before filing them permanently.

The main flow starts with a list of JSON items. Each item must declare its `type`. Based on that type, the file routes it to the right parser: normal messages, agent messages, reasoning blocks, function calls, tool outputs, custom tool calls, search calls, and compaction summaries. If required fields are missing or have the wrong shape, it returns a clear error that includes the raw payload id, so the bad source can be found.

The file also protects the trace from losing information. When content is too structured, unknown, image-based, or otherwise not easy to show as plain text, it stores either a short JSON summary or a reference back to the raw payload. That way the user interface can display something useful without pretending it fully understood every field.

#### Function details

##### `normalize_model_items`  (lines 34–43)

```
fn normalize_model_items(
    items: &[Value],
    raw_payload: &RawPayloadRef,
) -> Result<Vec<NormalizedConversationItem>>
```

**Purpose**: Converts a whole list of raw JSON model items into normalized conversation items. This is used when reducers need a clean, consistent conversation view from incoming request, response, or checkpoint data.

**Data flow**: It receives a slice of JSON values and a reference to the raw payload they came from. It walks through the items one by one, asks `normalize_model_item` to translate each item, and collects the results. If any item cannot be understood, the error stops the whole conversion; otherwise it returns the full normalized list.

**Call relations**: Higher-level reducers call this when they see model conversation data in compaction checkpoints, inference requests, or inference responses. It is the batch wrapper around `normalize_model_item`, which does the item-by-item decision making.

*Call graph*: calls 1 internal fn (normalize_model_item); called by 3 (reduce_compaction_checkpoint, reduce_inference_request, reduce_inference_response); 1 external calls (new).


##### `token_usage_from_value`  (lines 45–52)

```
fn token_usage_from_value(value: &Value) -> Option<TokenUsage>
```

**Purpose**: Extracts token usage numbers from a JSON value, if all expected fields are present. Token usage is the accounting data that says roughly how much model input and output was consumed.

**Data flow**: It receives one JSON value and reads four numeric fields from it. Each field is pulled through `u64_field`, which turns missing or non-numeric fields into failure and clamps negative numbers to zero. If all four fields are available, it returns a `TokenUsage`; if any are missing, it returns nothing.

**Call relations**: This helper is separate from conversation item normalization because token accounting is related metadata, not a conversation message. It relies on `u64_field` for the repeated field-reading rule.

*Call graph*: calls 1 internal fn (u64_field).


##### `normalize_model_item`  (lines 54–151)

```
fn normalize_model_item(
    item: &Value,
    raw_payload: &RawPayloadRef,
) -> Result<NormalizedConversationItem>
```

**Purpose**: Translates one raw JSON item into one normalized conversation item by looking at its declared type. This is the central dispatcher for all supported model item shapes.

**Data flow**: It receives a JSON item and the raw payload reference. First it reads the item’s `type`; if there is no string type, it returns an error. Then it chooses the right normalization path: messages go to message parsers, reasoning goes to reasoning parsing, tool calls and outputs become commentary items, compaction items become summary-channel items, and unsupported types produce an error. The output is one `NormalizedConversationItem` with role, channel, kind, body, metadata, and optional call id filled in.

**Call relations**: `normalize_model_items` calls this for every item in a payload. This function then hands off to specialized helpers such as `normalize_message_item`, `normalize_agent_message_item`, `normalize_reasoning_item`, `raw_text_or_json_body`, `tool_output_body`, `custom_tool_call_body`, `compaction_body`, and `json_body` depending on what kind of item it sees.

*Call graph*: calls 8 internal fn (compaction_body, custom_tool_call_body, json_body, normalize_agent_message_item, normalize_message_item, normalize_reasoning_item, raw_text_or_json_body, tool_output_body); called by 1 (normalize_model_items); 2 external calls (get, bail!).


##### `normalize_message_item`  (lines 153–182)

```
fn normalize_message_item(
    item: &Value,
    raw_payload: &RawPayloadRef,
) -> Result<NormalizedConversationItem>
```

**Purpose**: Normalizes a standard conversation message, such as a system, user, assistant, developer, or tool message. It makes sure the sender role is known before the item enters the trace.

**Data flow**: It receives a JSON message item and the raw payload reference. It reads the `role` field, converts that string into an internal role with `role_from_str`, optionally converts the `phase` field into a conversation channel, and turns the `content` array into conversation body parts with `content_parts`. It returns a normalized item of kind `Message`, or an error if the role is missing or unsupported.

**Call relations**: `normalize_model_item` calls this when it sees an item whose type is `message`. This function delegates role translation to `role_from_str` and body extraction to `content_parts`, so the main dispatcher does not need to know message-specific details.

*Call graph*: calls 2 internal fn (content_parts, role_from_str); called by 1 (normalize_model_item); 2 external calls (get, bail!).


##### `normalize_agent_message_item`  (lines 184–226)

```
fn normalize_agent_message_item(
    item: &Value,
    raw_payload: &RawPayloadRef,
) -> Result<NormalizedConversationItem>
```

**Purpose**: Normalizes an `agent_message`, which carries assistant analysis content along with author and recipient metadata. It preserves encrypted content as encoded data rather than trying to read it.

**Data flow**: It receives a raw JSON item and payload reference. It first parses the JSON into the protocol’s typed `ResponseItem` form, then confirms that the parsed item is actually an agent message. It converts text content into text parts and encrypted content into encoded parts, checks that there is at least one part, and returns an assistant analysis-channel message with `AgentMessageMetadata` attached.

**Call relations**: `normalize_model_item` calls this for items whose type is `agent_message`. It depends on the protocol model type `ResponseItem` to interpret this richer shape safely, then returns the same normalized conversation shape used by the rest of the reducer.

*Call graph*: called by 1 (normalize_model_item); 2 external calls (clone, bail!).


##### `normalize_reasoning_item`  (lines 228–282)

```
fn normalize_reasoning_item(
    item: &Value,
    raw_payload: &RawPayloadRef,
) -> Result<NormalizedConversationItem>
```

**Purpose**: Normalizes a reasoning item, which represents the assistant’s internal reasoning content, summaries, or encrypted reasoning data. It keeps reasoning separate from ordinary messages by marking it as kind `Reasoning` on the analysis channel.

**Data flow**: It receives a JSON reasoning item and the raw payload reference. It gathers text reasoning from `content`, summary text from `summary`, and optional string `encrypted_content`. Text becomes normal text parts, summaries become summary parts, and encrypted data becomes an encoded part. If none of those sources provide content, it returns an error; otherwise it returns a normalized assistant reasoning item.

**Call relations**: `normalize_model_item` calls this when it sees a `reasoning` item. It uses `append_reasoning_parts` twice, once for main reasoning content and once for summaries, then adds encrypted content itself.

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

**Purpose**: Adds either reasoning text parts or reasoning summary parts from one array inside a reasoning JSON item. It enforces the expected shape so malformed reasoning data is caught early.

**Data flow**: It receives the full reasoning item, the key to read, whether that key should contain content or summaries, the raw payload reference, and a mutable list of parts to add to. If the key is absent, it does nothing. If the key is present, it must be an array with entries of the expected type and string `text` fields. Valid entries are appended to the parts list as either text or summary parts.

**Call relations**: `normalize_reasoning_item` calls this for the `content` and `summary` sections of a reasoning item. This helper owns the detailed validation rules, letting the caller focus on assembling the final normalized item.

*Call graph*: called by 1 (normalize_reasoning_item); 3 external calls (get, bail!, matches!).


##### `role_from_str`  (lines 357–366)

```
fn role_from_str(role: &str) -> Option<ConversationRole>
```

**Purpose**: Converts a role name from JSON into the internal conversation role value. It keeps the accepted role vocabulary in one small place.

**Data flow**: It receives a role string such as `user` or `assistant`. If the string is one of the supported roles, it returns the matching internal role. If the string is unknown, it returns nothing so the caller can report an unsupported role error.

**Call relations**: `normalize_message_item` calls this while validating normal message items. It acts as the gatekeeper that prevents unknown role labels from silently entering the normalized conversation.

*Call graph*: called by 1 (normalize_message_item).


##### `channel_from_phase`  (lines 368–375)

```
fn channel_from_phase(phase: &str) -> Option<ConversationChannel>
```

**Purpose**: Converts a message `phase` string into an internal conversation channel. A channel is a broad lane for the message, such as commentary, final answer, or summary.

**Data flow**: It receives a phase string from the raw JSON. Known phases become internal channel values; unknown phases return nothing, which means the normalized item simply has no channel from that phase.

**Call relations**: This helper is used when a normal message includes a `phase` field. It keeps phase-to-channel translation separate from the rest of message normalization.


##### `content_parts`  (lines 377–402)

```
fn content_parts(content: Option<&Value>, raw_payload: &RawPayloadRef) -> Vec<ConversationPart>
```

**Purpose**: Turns a message-style `content` array into displayable conversation parts. It extracts plain text when it can and falls back to raw-payload references when the content is not directly representable.

**Data flow**: It receives optional JSON content and the raw payload reference. If the content is not an array, it returns a payload reference part pointing back to the original content. For each array entry, text-like types become text parts, images and unknown types become payload references, and entries without a type also become payload references. If the array produces no parts, it adds an `empty_content` reference so the item is still visible in the trace.

**Call relations**: `normalize_message_item` uses this for normal message bodies, and `tool_output_body` uses it when a tool output is already shaped like a content array. It relies on `payload_ref_part` whenever it cannot safely turn a content entry into plain text.

*Call graph*: calls 1 internal fn (payload_ref_part); called by 2 (normalize_message_item, tool_output_body); 2 external calls (new, vec!).


##### `custom_tool_call_body`  (lines 404–422)

```
fn custom_tool_call_body(item: &Value, raw_payload: &RawPayloadRef) -> ConversationBody
```

**Purpose**: Builds the body for a custom tool call. It gives special treatment to executable calls so code can be shown as code instead of as ordinary text.

**Data flow**: It receives the full custom tool call item and the raw payload reference. If the item has no string `input`, it falls back to a JSON body for the whole item. If the tool name is `exec`, it returns the input as a JavaScript code part. Otherwise it returns the input as a text part.

**Call relations**: `normalize_model_item` calls this for `custom_tool_call` items. If the custom tool call is not in the expected simple shape, this helper hands off to `json_body` so the trace still keeps a summarized version of the original data.

*Call graph*: calls 1 internal fn (json_body); called by 1 (normalize_model_item); 2 external calls (get, vec!).


##### `raw_text_or_json_body`  (lines 424–440)

```
fn raw_text_or_json_body(value: Option<&Value>, raw_payload: &RawPayloadRef) -> ConversationBody
```

**Purpose**: Builds a conversation body from a value that might be raw text, JSON stored as a string, a real JSON object, or missing. This is useful for function-call arguments, which may arrive in different forms.

**Data flow**: It receives an optional JSON value and the raw payload reference. If the value is a string, it tries to parse that string as JSON; parseable JSON becomes a JSON body, and ordinary text stays as a text part. If the value is already non-string JSON, it becomes a JSON body. If the value is missing, it returns a payload reference part so the trace still points back to the source payload.

**Call relations**: `normalize_model_item` calls this for standard function-call arguments. It delegates structured values to `json_body` and uses a payload reference when there is no argument value to show.

*Call graph*: calls 1 internal fn (json_body); called by 1 (normalize_model_item); 1 external calls (vec!).


##### `tool_output_body`  (lines 442–455)

```
fn tool_output_body(output: Option<&Value>, raw_payload: &RawPayloadRef) -> ConversationBody
```

**Purpose**: Builds the body for a tool output item. It chooses the most readable representation based on whether the output is text, a content array, other JSON, or missing.

**Data flow**: It receives optional output JSON and the raw payload reference. A string output becomes a text part. An array output is interpreted through `content_parts`. Any other JSON value becomes a summarized JSON part. If the output is missing, it returns a payload reference labeled as tool output.

**Call relations**: `normalize_model_item` calls this for function-call and custom-tool-call output items. It reuses `content_parts` for message-like arrays and `json_body` for structured output that should be preserved but not expanded in full.

*Call graph*: calls 2 internal fn (content_parts, json_body); called by 1 (normalize_model_item); 1 external calls (vec!).


##### `compaction_body`  (lines 457–473)

```
fn compaction_body(item: &Value, raw_payload: &RawPayloadRef) -> Result<ConversationBody>
```

**Purpose**: Builds the body for a compaction summary item. Compaction means earlier conversation history was condensed, and this function preserves the encrypted summary that represents that condensed history.

**Data flow**: It receives the compaction item and raw payload reference. It requires a string `encrypted_content` field; if that field is missing or not a string, it returns an error. When present, it wraps the encrypted value in an encoded conversation part labeled `encrypted_content`.

**Call relations**: `normalize_model_item` calls this for compaction-related item types. The structural marker that history was cut is created elsewhere; this function only normalizes the encoded summary carried in the payload.

*Call graph*: called by 1 (normalize_model_item); 3 external calls (get, bail!, vec!).


##### `json_body`  (lines 475–482)

```
fn json_body(value: &Value, raw_payload: &RawPayloadRef) -> ConversationBody
```

**Purpose**: Wraps a JSON value as a conversation body while keeping a short readable summary and a link back to the raw payload. This is the safe fallback for structured data that should not be flattened into text.

**Data flow**: It receives a JSON value and the raw payload reference. It creates one JSON conversation part containing a shortened summary from `summarize_json` and the raw payload id. The result is a `ConversationBody` with that single JSON part.

**Call relations**: Several normalizers call this when they need to preserve structured information: `normalize_model_item`, `custom_tool_call_body`, `raw_text_or_json_body`, and `tool_output_body`. It keeps large or complex JSON readable without discarding the original source link.

*Call graph*: called by 4 (custom_tool_call_body, normalize_model_item, raw_text_or_json_body, tool_output_body); 1 external calls (vec!).


##### `payload_ref_part`  (lines 484–489)

```
fn payload_ref_part(label: &str, raw_payload: &RawPayloadRef) -> ConversationPart
```

**Purpose**: Creates a small placeholder part that points back to the raw payload. This is used when the normalizer cannot or should not copy the actual content into the conversation body.

**Data flow**: It receives a label explaining what kind of content is being referenced and the raw payload reference. It returns a `PayloadRef` part containing that label and the raw payload id. Nothing is parsed or changed.

**Call relations**: `content_parts` calls this for images, unknown content types, missing content, and empty content. It helps the trace stay honest: instead of inventing text, it says where the original data can be found.

*Call graph*: called by 1 (content_parts).


##### `summarize_json`  (lines 491–500)

```
fn summarize_json(value: &Value) -> String
```

**Purpose**: Creates a short string preview of a JSON value. This makes structured data easier to display in the trace without flooding the view with a huge blob.

**Data flow**: It receives any JSON value. It serializes the value to a string, or uses a placeholder if serialization somehow fails. If the string is longer than the maximum summary length, it cuts it down and adds an ellipsis. The result is a compact summary string.

**Call relations**: `json_body` uses this when building JSON conversation parts. It provides the readable preview while `json_body` keeps the raw payload id for full provenance.

*Call graph*: 1 external calls (to_string).


##### `u64_field`  (lines 502–507)

```
fn u64_field(value: &Value, field: &str) -> Option<u64>
```

**Purpose**: Reads one numeric token-usage field from JSON as a non-negative unsigned number. It provides a shared rule for token counters.

**Data flow**: It receives a JSON value and a field name. It looks up that field, accepts it only if it is an integer, clamps negative values up to zero, and returns it as an unsigned number. If the field is missing or not an integer, it returns nothing.

**Call relations**: `token_usage_from_value` calls this for each token counter it needs. This keeps all token fields using the same conversion behavior.

*Call graph*: called by 1 (token_usage_from_value); 1 external calls (get).


### `rollout-trace/src/reducer/inference.rs`

`domain_logic` · `trace reduction during inference start, inference finish, and turn-end cleanup`

An inference call is one trip from Codex to a model provider, like sending a question to an AI service and waiting for the answer. This file makes those trips understandable in the reduced trace. Without it, the trace could show conversation content but not reliably connect that content to the model call that produced it, when it ran, or whether it completed successfully.

The main flow starts when a raw “inference started” event arrives. The reducer first checks that this call is not already known, then checks that it belongs to a real Codex turn and the correct thread. That matters because a trace is like a family tree: if a model call is attached to the wrong parent turn, later analysis becomes misleading. It then reduces the request payload into conversation items before inserting the inference call record, so the stored call already points to the exact request evidence.

When a model call ends, the reducer accepts completion, failure, or cancellation events. If there is a response or partial response, it reduces that into response items and stores useful IDs from the provider. There is also a cleanup path for turn endings: if a turn ends while a model stream still looks live, this file closes that inference call so the final trace does not pretend it is still running.

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

**Purpose**: This function begins tracking a model call when the trace says an inference request has started. It verifies that the call belongs to a known turn and thread, turns the outgoing request into conversation evidence, and then stores a new running inference record.

**Data flow**: It receives the raw event sequence number, the wall-clock time, and a StartedInferenceCall bundle containing IDs, model/provider names, and the raw request payload. It checks for duplicate inference IDs, looks up the referenced Codex turn, confirms the thread matches, and reduces the request payload into item IDs. After that, it inserts a new InferenceCall into the rollout with a running execution window, request links, model/provider details, and empty response fields. If the IDs are inconsistent or duplicated, it stops with an error instead of recording a misleading call.

**Call relations**: This is used when the reducer is processing an inference-start event. It relies on the wider TraceReducer state to find the owning turn, reduce the request into normalized conversation items, and confirm the thread exists. If something is wrong, it uses the shared error path to reject the event; otherwise it leaves behind a running inference call that later completion or cleanup logic can update.

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

**Purpose**: This function closes any model calls that are still marked as running when their owning Codex turn ends. It prevents the reduced trace from showing an inference stream as still alive after the turn that owned it has already finished.

**Data flow**: It receives the event sequence number, the end time, the Codex turn ID, and the final status of that turn. If the turn is still running, it does nothing. Otherwise, it chooses an inference status that matches the turn ending: completed or cancelled turns cause leftover running inferences to become cancelled, while failed or aborted turns pass through those statuses. It then scans stored inference calls, finds running ones attached to that turn, and fills in their end time, end sequence, and final status.

**Call relations**: This runs as part of turn-end cleanup rather than normal model completion. In the usual path, complete_inference_call closes the inference first. This function is the safety net for cases where Codex stopped observing the provider stream before a terminal inference event arrived, so later readers see a closed timeline instead of a dangling one.


##### `TraceReducer::complete_inference_call`  (lines 138–226)

```
fn complete_inference_call(
        &mut self,
        seq: RawEventSeq,
        wall_time_unix_ms: i64,
        payload: RawTraceEventPayload,
    ) -> Result<()>
```

**Purpose**: This function finishes a tracked model call when the trace reports that it completed, failed, or was cancelled. It records the final status, stores provider IDs, and turns any full or partial response payload into normalized response items.

**Data flow**: It receives the event sequence number, the wall-clock time, and a raw terminal inference event. It first recognizes which kind of terminal event it is: completed, failed, or cancelled. From that it extracts the inference call ID, status, optional response ID, optional upstream request ID, and any response or partial-response payload. It checks that the inference call already exists. If a payload is present, it reduces that payload into response item IDs. Then it updates the stored inference call with response IDs, raw payload IDs, response item IDs, and, if the call is still running, its end time, end sequence, and final status. If the event is not a terminal inference event or refers to an unknown call, it returns an error.

**Call relations**: This is called when the reducer reaches the end event for an inference call. It follows the record created by TraceReducer::start_inference_call and fills in the response side of the story. It also cooperates with TraceReducer::close_running_inference_calls_for_turn_end: if cleanup already marked the call as terminal, this function keeps that earlier status but still preserves late-arriving partial response evidence and provider request IDs.

*Call graph*: 1 external calls (bail!).


### `rollout-trace/src/reducer/compaction.rs`

`domain_logic` · `event reduction during trace processing`

A compaction is a way of replacing a stretch of conversation history with a shorter checkpoint, like summarizing old pages in a notebook so the notebook stays usable. This file is responsible for tracking that process inside `TraceReducer`, which turns raw events into a cleaner model of what happened.

It separates two ideas that might look similar but are not the same. First, the system may send one or more remote compaction requests. Those requests have start times, end times, statuses, models, providers, and raw request or response payloads kept as evidence. Second, a compaction may later be installed, meaning the checkpoint becomes the live replacement history for the thread. A completed request alone does not rewrite the conversation.

The code also protects the trace from impossible or inconsistent data. It rejects duplicate starts or installs, unknown turns, unknown requests, and mismatches where an event says it belongs to one thread or compaction but the earlier record says something else. If those checks were missing, the reduced trace could quietly connect the wrong request to the wrong conversation, which would make later analysis misleading.

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

**Purpose**: Records that one attempt to ask an upstream service for a compaction has begun. It creates a running request record, but it does not change the conversation history.

**Data flow**: It receives the raw event sequence number, the wall-clock start time, and the unpacked start-event fields such as compaction ID, request ID, thread ID, turn ID, model, provider, and request payload. It first checks that this request ID has not already been seen, that the thread exists, that the referenced Codex turn exists, and that the turn belongs to the same thread. If everything lines up, it adds a new `CompactionRequest` to the rollout with a running execution window and a pointer to the raw request payload. The output is success, or an error if the event would make the trace inconsistent.

**Call relations**: This is used when the reducer sees the start of a compaction request. It records the request as evidence of an upstream call. If the event is a duplicate or points at the wrong thread or turn, it stops the reduction with an error through `bail!` rather than letting bad links enter the model.

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

**Purpose**: Marks a previously started compaction request as finished. It stores the finish time, final status, and optional response payload, while still leaving the conversation itself unchanged.

**Data flow**: It receives the event sequence number, finish time, compaction ID, request ID, final execution status, and maybe a raw response payload. It looks up the existing request by ID, confirms that the completion belongs to the same compaction that was recorded at start time, then fills in the request's end time, end sequence, status, and response payload ID. It returns success after updating that request, or an error if the completion refers to an unknown request or the wrong compaction.

**Call relations**: This follows `TraceReducer::start_compaction_request` in the normal lifecycle of an upstream compaction attempt. It completes the request record but deliberately does not install any checkpoint. If the completion cannot be matched to a valid start, it uses `bail!` so the reduced trace does not invent a request history.

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

**Purpose**: Records the moment when a compaction checkpoint actually becomes part of the reduced conversation. This is the point where replacement history is treated as live thread history.

**Data flow**: It receives the install time, thread ID, Codex turn ID, compaction ID, and checkpoint payload. It checks that this compaction has not already been installed, that the thread and turn exist, and that the turn belongs to the given thread. It then reduces the checkpoint payload into concrete conversation item IDs, gathers all request IDs that belong to this compaction, remembers the replacement item IDs as pending replacement history for the thread, and inserts a new `Compaction` record into the rollout. The result is a recorded installed compaction, or an error if the install event does not match the existing trace.

**Call relations**: This is the semantic finish line of the compaction flow. Earlier request start and completion records show that remote work was attempted; this function is called when an install event says the checkpoint should take effect. It relies on checkpoint reduction to interpret the payload, and it uses `bail!` to reject duplicate installs or references to the wrong thread or turn.

*Call graph*: 1 external calls (bail!).


### `rollout-trace/src/reducer/thread.rs`

`domain_logic` · `trace reduction as raw events are processed`

A trace is a stream of low-level events. This file acts like the logbook clerk for the parts of that stream that say, “a thread began,” “a thread ended,” “a Codex turn began,” or “a Codex turn ended.” Without it, the rest of the system would not have reliable containers to attach conversations, tool calls, code cells, and model calls to.

The main owner is TraceReducer, which builds a structured rollout from raw events. When a thread starts, the reducer checks that the thread id has not already been used, reads optional metadata, and decides whether the thread is a root agent or a spawned child agent. For spawned agents, it derives a parent link, a task name, and an agent role so the final trace can show the agent tree clearly.

A “Codex turn” is a single work interval inside a thread. This file records when each turn starts and ends, and it checks that a turn is attached to the thread it claims to belong to. When a turn ends, it also closes related work that should not keep running past the turn, such as code cells and inference calls.

The important idea is that threads are the shelves, turns are folders on those shelves, and later reducer modules put their own documents into the right folder.

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

**Purpose**: Creates a new agent thread in the rollout when a raw event says a thread has started. It also works out whether this is the main/root agent or a child agent spawned by another thread.

**Data flow**: It receives the event sequence number, time, thread id, event-provided agent path, and optional metadata payload. It first rejects duplicate thread ids. If metadata exists, it reads it and prefers the richer spawn metadata over the simpler event field. It then builds an AgentThread with start time, running status, model and nickname if present, and either a root origin or a spawned-child origin. The rollout’s thread map gains one new thread record.

**Call relations**: This is called by the reducer when it sees a thread-start event. It uses spawn_edge_id to create the stable link name between a parent thread and a child thread. If the event would create an impossible state, such as starting the same thread twice, it stops reduction with an error.

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

**Purpose**: Marks an existing agent thread as finished, failed, aborted, or still running based on the status carried by the trace event. It deliberately only ends that one thread, rather than treating a child thread ending as the whole rollout ending.

**Data flow**: It receives the event sequence number, time, thread id, and rollout-style status. It looks up the thread, writes the end time and ending sequence number, and converts the rollout status into the thread’s execution status. The thread record changes from open-ended running work to a terminal or updated execution state.

**Call relations**: When a thread-end event arrives, this function asks TraceReducer::thread_mut for the matching thread record. That helper provides the guardrail: if the event names a thread the reducer has never seen, the end operation fails instead of silently inventing data.

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

**Purpose**: Creates a new Codex turn inside an existing thread. A turn is a bounded stretch of work, so this records the starting point that later events can attach to.

**Data flow**: It receives the event sequence number, time, Codex turn id, and thread id. It rejects duplicate turn ids, checks that the referenced thread already exists, and then inserts a new CodexTurn with running status and an empty list of input items. The rollout gains a new turn connected to its parent thread.

**Call relations**: This is used when the reducer sees a turn-start event. It calls TraceReducer::thread_mut not because it needs to edit the thread, but to prove the thread exists before creating a turn under it. If the turn id is already in use, it reports an error rather than mixing two turns together.

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

**Purpose**: Closes a Codex turn and records how it finished. It also checks that any thread id included in the raw event agrees with the thread that originally owned the turn.

**Data flow**: It receives the event sequence number, time, an optional thread id from the event, the Codex turn id, and the final execution status. If the event supplies a thread id, it compares that id with the stored owner of the turn and rejects a mismatch. It then finds the turn, writes its end time, ending sequence, and final status. After that, related running work for the turn is closed so the trace does not show activity continuing after the turn ended.

**Call relations**: This function is reached when a turn-end event is reduced. It stands at a boundary point: once it closes the turn, it also prompts the reducer’s other cleanup paths to stop still-running code cells and inference calls tied to that turn. If the turn was never started, or if the event points to the wrong thread, it raises an error.

*Call graph*: 2 external calls (bail!, clone).


##### `TraceReducer::thread_mut`  (lines 200–205)

```
fn thread_mut(&mut self, thread_id: &str) -> Result<&mut AgentThread>
```

**Purpose**: Finds an existing thread and gives the caller permission to change it. It provides a clear error message when a trace event mentions a thread id that is not known.

**Data flow**: It receives a thread id and looks in the rollout’s thread map. If the id exists, it returns a mutable reference to that AgentThread so the caller can edit it. If the id is missing, it returns an error explaining that the trace referenced an unknown thread.

**Call relations**: TraceReducer::end_thread uses this helper before writing a thread’s end information. TraceReducer::start_codex_turn uses it as a validation step before creating a turn under a thread. This keeps the same “unknown thread” rule in one place.

*Call graph*: called by 2 (end_thread, start_codex_turn).


##### `TraceReducer::thread_started_metadata`  (lines 207–214)

```
fn thread_started_metadata(
        &self,
        metadata_payload: &RawPayloadRef,
    ) -> Result<ThreadStartedMetadata>
```

**Purpose**: Reads and parses the optional metadata attached to a thread-start event. That metadata can contain useful human and hierarchy information, such as nickname, model, task name, and spawn details.

**Data flow**: It receives a reference to a raw payload. It asks the reducer to read that payload as JSON, then converts the JSON value into a ThreadStartedMetadata structure. The result is either parsed metadata ready for start_thread to use, or an error that includes which raw payload failed to parse.

**Call relations**: TraceReducer::start_thread calls this when a thread-start event includes metadata. This keeps metadata parsing out of the central event flow, so the rest of the reducer can work with a clearer, typed shape instead of loose JSON.

*Call graph*: 1 external calls (from_value).


##### `ThreadStartedMetadata::thread_spawn`  (lines 228–254)

```
fn thread_spawn(&self) -> Option<ThreadSpawnMetadata>
```

**Purpose**: Looks inside thread-start metadata to see whether the thread was spawned as a child agent. If so, it extracts the parent thread id and child identity details needed to draw the parent-child relationship.

**Data flow**: It reads the metadata’s session_source JSON and searches for the nested subagent.thread_spawn section. If that section is missing or lacks a parent thread id, it returns nothing. If it is present, it builds ThreadSpawnMetadata using the nested agent path, task name, and agent role when available, falling back to top-level metadata where appropriate. It may also derive a task name from the agent path.

**Call relations**: TraceReducer::start_thread uses this right after parsing thread metadata. The result decides whether the new thread is stored as AgentOrigin::Root or as AgentOrigin::Spawned with a parent link and task label.


##### `task_name_from_agent_path`  (lines 264–270)

```
fn task_name_from_agent_path(agent_path: &str) -> String
```

**Purpose**: Creates a readable task name from an agent path by taking the last non-empty path segment. This gives spawned agents a sensible name even when the metadata does not provide one directly.

**Data flow**: It receives a path-like string such as a slash-separated agent path. It scans from the end, skips empty pieces, and chooses the last meaningful segment. It returns that segment as a new string, or the whole input if no better segment is found.

**Call relations**: TraceReducer::start_thread uses this as a fallback when spawned-thread metadata does not include a task name. ThreadStartedMetadata::thread_spawn also uses it while building spawn metadata, so task naming stays consistent wherever the spawn information is interpreted.


### runtime and tool replay
These files reduce runtime execution and tool activity into replayable code-cell, tool-call, terminal, and multi-agent interaction models linked back to the transcript.

### `rollout-trace/src/reducer/code_cell.rs`

`domain_logic` · `trace reduction`

A code cell is the trace’s way of showing JavaScript that the model asked to run with an exec-style tool call. The tricky part is that two timelines are involved. The model-visible conversation item may only appear when an inference response is reduced, but the runtime may start executing the JavaScript earlier. Without this file, traces could show code running with no clear parent message, lose early failures, or leave code cells looking unfinished.

The reducer acts like a careful clerk matching receipts to packages. If a runtime start arrives before the matching conversation item exists, it stores the start in a pending list. When later conversation reduction creates the model-visible item, the reducer creates the CodeCell, links it to its source item, and replays any early lifecycle events that were waiting.

The file also records when a code cell first responds, yields, ends, or is force-closed because its owning turn failed or was cancelled. It connects nested tool calls back to the code cell that requested them, and it links wait calls by reading the runtime cell id from the wait tool’s arguments. Finally, it maintains a bridge from short-lived runtime cell ids to stable reduced code-cell ids, scoped by thread so identical runtime ids in different threads do not collide.

#### Function details

##### `TraceReducer::start_or_queue_code_cell`  (lines 88–104)

```
fn start_or_queue_code_cell(&mut self, pending: PendingCodeCellStart) -> Result<()>
```

**Purpose**: This starts a code cell if the conversation item that requested it is already known. If that source item has not appeared yet, it safely queues the start so the final trace will still point to the right model-visible request.

**Data flow**: It receives a pending code-cell start, including timing, thread, turn, runtime id, model-visible call id, and JavaScript source. It checks whether the matching conversation item exists. If not, it stores the start by code-cell id; if yes, it passes the start on to be fully inserted. It errors if the same cell is started twice.

**Call relations**: This is the first stop for runtime start events. It asks `TraceReducer::source_item_id_for_pending_code_cell` whether the parent conversation item exists, and either waits or hands the work to `TraceReducer::start_code_cell`.

*Call graph*: calls 2 internal fn (source_item_id_for_pending_code_cell, start_code_cell); 1 external calls (bail!).


##### `TraceReducer::flush_pending_code_cell_starts`  (lines 110–128)

```
fn flush_pending_code_cell_starts(&mut self) -> Result<()>
```

**Purpose**: This revisits code-cell starts that were waiting for their model-visible source item. It lets delayed conversation data unlock runtime cells that had already begun executing.

**Data flow**: It scans the queued starts and checks each one against the current conversation items. Starts whose source item now exists are removed from the pending map and converted into real CodeCell records. Starts that are still missing their source stay queued.

**Call relations**: This is called after parts of the reducer create new conversation items. It uses `TraceReducer::source_item_id_for_pending_code_cell` to find newly ready starts, then calls `TraceReducer::start_code_cell` to materialize them.

*Call graph*: calls 2 internal fn (source_item_id_for_pending_code_cell, start_code_cell); 1 external calls (new).


##### `TraceReducer::start_code_cell`  (lines 131–211)

```
fn start_code_cell(&mut self, pending: PendingCodeCellStart) -> Result<()>
```

**Purpose**: This creates the actual CodeCell record once the reducer can prove which conversation item authored the JavaScript. It also links any already-known outputs and nested tool calls.

**Data flow**: It takes a pending start, validates that it belongs to an existing thread and Codex turn, finds the source conversation item, gathers output items, and builds a CodeCell with running execution status. It stores the CodeCell in the rollout, links output conversation items back to it, and replays any queued lifecycle events such as early responses or endings.

**Call relations**: Only `TraceReducer::start_or_queue_code_cell` and `TraceReducer::flush_pending_code_cell_starts` call this after source ownership is known. It relies on helper methods to validate the turn, find source and output items, add output links, and replay waiting lifecycle events.

*Call graph*: calls 5 internal fn (add_code_cell_output_item, flush_pending_code_cell_lifecycle_events, model_visible_code_cell_item_ids, source_item_id_for_code_cell_start, validate_code_cell_turn); called by 2 (flush_pending_code_cell_starts, start_or_queue_code_cell); 2 external calls (new, bail!).


##### `TraceReducer::source_item_id_for_pending_code_cell`  (lines 214–226)

```
fn source_item_id_for_pending_code_cell(
        &self,
        pending: &PendingCodeCellStart,
    ) -> Result<Option<String>>
```

**Purpose**: This checks whether a pending code-cell start already has a matching model-visible custom tool call item. It answers the question, “Can this queued runtime start be safely attached now?”

**Data flow**: It reads the pending start’s thread id and model-visible call id, searches conversation items for a matching custom tool call, and returns the first matching item id if one exists. It does not change the rollout.

**Call relations**: Both `TraceReducer::start_or_queue_code_cell` and `TraceReducer::flush_pending_code_cell_starts` use this before allowing a CodeCell to be created. It delegates the actual search to `TraceReducer::model_visible_code_cell_item_ids`.

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

**Purpose**: This records the runtime’s first response for a code cell, such as moving from starting to running or yielded. If the cell itself is still waiting to be created, it queues the response instead of losing it.

**Data flow**: It receives event timing, a code-cell id, runtime cell id, and runtime status. If the CodeCell exists, it updates the cell immediately. If the start is pending, it stores this lifecycle event beside that start. If neither exists, it reports an unknown-cell error.

**Call relations**: Runtime initial-response events enter through this method. It either calls `TraceReducer::record_code_cell_initial_response` now or stores the event with `TraceReducer::queue_code_cell_lifecycle_event` so `TraceReducer::flush_pending_code_cell_lifecycle_events` can replay it later.

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

**Purpose**: This updates an existing CodeCell when its runtime first answers. It captures the first response time and the latest runtime status.

**Data flow**: It looks up the CodeCell by id, stores the runtime cell id, records the first response timestamp and sequence if they were not already set, and updates the runtime status. If the response says the cell yielded, it also records when that yield happened.

**Call relations**: This is the direct updater used by `TraceReducer::record_or_queue_code_cell_initial_response` for already-created cells. It is also used by `TraceReducer::flush_pending_code_cell_lifecycle_events` when replaying responses that arrived before the cell could be created.

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

**Purpose**: This ends a code cell when the runtime reports completion, failure, or termination. If the cell start is still pending, it saves the end event so very fast cells are not lost.

**Data flow**: It receives event timing, a code-cell id, and final runtime status. If the CodeCell exists, it closes it immediately. If the start is pending, it queues an end lifecycle event. If no known or pending cell matches, it returns an error.

**Call relations**: Runtime end events pass through this method. It mirrors the initial-response path by either calling `TraceReducer::end_code_cell` immediately or using `TraceReducer::queue_code_cell_lifecycle_event` for later replay.

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

**Purpose**: This marks an existing CodeCell as no longer running. It records when it ended and converts the code-cell runtime status into the broader execution status used by the trace.

**Data flow**: It looks up the CodeCell, fills in a first-response time if one was never recorded, writes the end time and sequence, converts the runtime status into completed, failed, cancelled, or still running, and stores the final runtime status.

**Call relations**: This is the central closer for code cells. It is called directly by `TraceReducer::end_or_queue_code_cell`, during queued lifecycle replay by `TraceReducer::flush_pending_code_cell_lifecycle_events`, and by `TraceReducer::terminate_running_code_cells_for_turn_end` when a turn is interrupted.

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

**Purpose**: This closes code cells that are still running when their owning turn fails, is cancelled, or is aborted. It prevents a finished trace from falsely looking like code is still live.

**Data flow**: It receives a turn id, event timing, and the turn’s final execution status. For normal running or completed turns, it does nothing. For failed or interrupted turns, it finds running code cells in that turn and ends each one with a matching failed or terminated runtime status.

**Call relations**: This is used when reducing turn-end events. It calls `TraceReducer::end_code_cell` for each affected cell, but intentionally does not close yielded cells just because a turn completed normally.

*Call graph*: calls 1 internal fn (end_code_cell).


##### `TraceReducer::queue_code_cell_lifecycle_event`  (lines 384–395)

```
fn queue_code_cell_lifecycle_event(
        &mut self,
        code_cell_id: CodeCellId,
        event: PendingCodeCellLifecycleEvent,
    )
```

**Purpose**: This stores a lifecycle event for a code cell whose start has been seen but cannot be materialized yet. It keeps early responses and endings in the right order.

**Data flow**: It receives a code-cell id and a pending lifecycle event. It appends the event to that cell’s waiting list and sorts the list by raw event sequence so replay follows trace order.

**Call relations**: This is called by `TraceReducer::record_or_queue_code_cell_initial_response` and `TraceReducer::end_or_queue_code_cell` when the CodeCell is not created yet but its start is pending. The stored events are later consumed by `TraceReducer::flush_pending_code_cell_lifecycle_events`.

*Call graph*: called by 2 (end_or_queue_code_cell, record_or_queue_code_cell_initial_response).


##### `TraceReducer::flush_pending_code_cell_lifecycle_events`  (lines 397–422)

```
fn flush_pending_code_cell_lifecycle_events(&mut self, code_cell_id: &str) -> Result<()>
```

**Purpose**: This replays response and end events that arrived before a queued code cell could be created. It makes the final CodeCell reflect what really happened at runtime.

**Data flow**: It receives a code-cell id, removes any queued lifecycle events for that cell, and applies them in stored order. Initial-response events update the first response and status; end events close the execution window.

**Call relations**: This is called at the end of `TraceReducer::start_code_cell`, right after the CodeCell is inserted. It hands each queued event to either `TraceReducer::record_code_cell_initial_response` or `TraceReducer::end_code_cell`.

*Call graph*: calls 2 internal fn (end_code_cell, record_code_cell_initial_response); called by 1 (start_code_cell).


##### `TraceReducer::link_tool_call_to_code_cell`  (lines 428–445)

```
fn link_tool_call_to_code_cell(
        &mut self,
        tool_call_id: &ToolCallId,
        requester: &ToolCallRequester,
    ) -> Result<()>
```

**Purpose**: This records that a nested tool call was requested by JavaScript running inside a code cell. It gives viewers a parent-child path from the code cell to the tool work it triggered.

**Data flow**: It receives a tool-call id and a requester description. If the requester is not a code cell, it changes nothing. If the requester names an existing code cell, it adds the tool-call id to that cell’s nested-tool list without duplicating it. If the cell is still pending, it leaves the link to be recovered later.

**Call relations**: Tool-call reduction uses this after deciding who requested the tool. It uses `push_unique` for safe list insertion, and `TraceReducer::start_code_cell` can backfill links for calls that were reduced before the cell became real.

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

**Purpose**: This connects a model-visible wait tool call to the runtime code cell it is waiting on. Wait calls are special because the relationship is hidden inside the tool’s JSON arguments rather than expressed as a normal nested tool requester.

**Data flow**: It receives the thread id, tool-call id, and an optional raw request payload reference. It reads the payload, ignores it unless the tool name is `wait`, parses the JSON arguments, extracts the runtime `cell_id`, translates that runtime id to a reduced code-cell id if known, and adds the wait call to that cell’s wait list.

**Call relations**: This is used while reducing tool request payloads. It looks up runtime-to-code-cell mappings through `TraceReducer::code_cell_id_for_runtime_cell_id_if_known` and adds the link with `push_unique`; malformed wait payloads produce errors instead of silent bad links.

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

**Purpose**: This attaches a later-seen custom tool output conversation item to the CodeCell that produced it. It covers the case where runtime execution was already known before the model-visible output item appeared.

**Data flow**: It receives a conversation item id, optional call id, and item kind. It ignores items without a call id or items that are not custom tool call outputs. For matching outputs, it derives the CodeCell id from the call id, checks that the CodeCell exists, and links the output item to it.

**Call relations**: Conversation-item reduction calls this when new items are observed. It uses `TraceReducer::reduced_code_cell_id_for_model_visible_call` to find the expected CodeCell id and `TraceReducer::add_code_cell_output_item` to add the two-way link.

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

**Purpose**: This finds the thread that owns a code-cell runtime event. It prefers the thread id carried by the event, but can fall back to the event’s Codex turn id for older or less complete traces.

**Data flow**: It receives an optional thread id, an optional turn id, the runtime cell id, and the event name for error messages. If a thread id is present, it returns it. Otherwise it looks up the turn and returns that turn’s thread id, or errors if neither path works.

**Call relations**: Code-cell event reduction uses this helper before resolving runtime cell ids or storing events. It avoids repeating the same fallback logic in every event-specific branch.

*Call graph*: 1 external calls (bail!).


##### `TraceReducer::reduced_code_cell_id_for_model_visible_call`  (lines 558–566)

```
fn reduced_code_cell_id_for_model_visible_call(
        &self,
        model_visible_call_id: &str,
    ) -> CodeCellId
```

**Purpose**: This creates the stable CodeCell id from the model-visible exec call id. It treats the conversation call id as the durable identity, rather than relying on the runtime’s temporary cell handle.

**Data flow**: It receives a model-visible call id string and returns a new id by prefixing it as a code-cell id. It reads no reducer state and changes nothing.

**Call relations**: This helper is used by `TraceReducer::attach_model_visible_code_cell_item` when connecting later output items to the CodeCell that should own them.

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

**Purpose**: This records the bridge from a runtime cell id to the stable reduced CodeCell id. The bridge is scoped by thread because runtime ids can repeat in different threads.

**Data flow**: It receives a thread id, runtime cell id, and CodeCell id. It builds a thread-and-runtime lookup key, checks whether a mapping already exists, accepts an identical repeat, rejects conflicting mappings, and otherwise stores the new mapping.

**Call relations**: Runtime start handling uses this kind of mapping so later events, waits, and nested tools can find the correct CodeCell. It builds keys with `runtime_code_cell_key` and reports conflicts rather than overwriting them.

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

**Purpose**: This resolves a runtime cell id into the stable CodeCell id for a specific thread. It is the strict version: unknown runtime cells become clear errors.

**Data flow**: It receives a thread id, runtime cell id, and event name. It asks the optional lookup helper for the CodeCell id. If found, it returns the id; if not, it returns an error that names the event and missing runtime cell.

**Call relations**: This is called by `TraceReducer::reduce_tool_call_requester` when a raw nested-tool requester names a runtime code cell. It wraps `TraceReducer::code_cell_id_for_runtime_cell_id_if_known` with better error reporting.

*Call graph*: calls 1 internal fn (code_cell_id_for_runtime_cell_id_if_known); called by 1 (reduce_tool_call_requester).


##### `TraceReducer::code_cell_id_for_runtime_cell_id_if_known`  (lines 609–617)

```
fn code_cell_id_for_runtime_cell_id_if_known(
        &self,
        thread_id: &str,
        runtime_cell_id: &str,
    ) -> Option<CodeCellId>
```

**Purpose**: This does a quiet lookup from thread-local runtime cell id to stable CodeCell id. It is useful when an unknown mapping is allowed and should simply mean “not linked yet.”

**Data flow**: It receives a thread id and runtime cell id, builds the combined lookup key, and returns the stored CodeCell id if present. It does not change state and returns nothing if the mapping is unknown.

**Call relations**: The strict resolver `TraceReducer::code_cell_id_for_runtime_cell_id` uses this and turns a miss into an error. `TraceReducer::link_wait_tool_call_from_request_payload` uses it directly because a wait link can be skipped when the cell is not known yet.

*Call graph*: calls 1 internal fn (runtime_code_cell_key); called by 2 (code_cell_id_for_runtime_cell_id, link_wait_tool_call_from_request_payload).


##### `TraceReducer::reduce_tool_call_requester`  (lines 623–638)

```
fn reduce_tool_call_requester(
        &self,
        thread_id: &str,
        requester: RawToolCallRequester,
    ) -> Result<ToolCallRequester>
```

**Purpose**: This converts a raw requester description into the stable requester form used in the reduced trace. In particular, it turns runtime code-cell handles into stable CodeCell ids.

**Data flow**: It receives a thread id and a raw requester. Model requesters pass through as model requesters. Code-cell requesters carry a runtime cell id, which it resolves to a stable CodeCell id and returns as a code-cell requester.

**Call relations**: Tool-call reduction uses this at the boundary between raw events and the reduced graph. It calls `TraceReducer::code_cell_id_for_runtime_cell_id` so nested JavaScript tool calls are anchored to the correct CodeCell.

*Call graph*: calls 1 internal fn (code_cell_id_for_runtime_cell_id).


##### `TraceReducer::validate_code_cell_turn`  (lines 640–655)

```
fn validate_code_cell_turn(&self, thread_id: &str, codex_turn_id: &str) -> Result<()>
```

**Purpose**: This checks that a code-cell start refers to a real thread and a real Codex turn, and that they belong together. It protects the trace from attaching runtime work to the wrong turn.

**Data flow**: It receives a thread id and turn id. It verifies the thread exists, verifies the turn exists, and confirms the turn’s stored thread id matches the supplied thread id. It returns success or a specific error.

**Call relations**: `TraceReducer::start_code_cell` calls this before inserting a CodeCell. That means bad ownership is caught before any partial CodeCell is written into the rollout.

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

**Purpose**: This finds conversation items in a thread that match a model-visible code-cell call id and a requested item kind. It is the shared search tool for source and output items.

**Data flow**: It reads all reduced conversation items and filters them by thread id, call id, and kind. It returns the matching item ids as strings and does not mutate anything.

**Call relations**: `TraceReducer::source_item_id_for_pending_code_cell`, `TraceReducer::source_item_id_for_code_cell_start`, and `TraceReducer::start_code_cell` use this to locate the model-visible pieces that should be connected to a CodeCell.

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

**Purpose**: This finds the exact conversation item that authored a code-cell start. Unlike the pending check, this requires the item to exist and errors if it does not.

**Data flow**: It receives the thread id, CodeCell id, and model-visible call id. It searches for a matching custom tool call item and returns the first item id. If none is found, it returns an explanatory error.

**Call relations**: `TraceReducer::start_code_cell` calls this immediately before creating the CodeCell. It uses `TraceReducer::model_visible_code_cell_item_ids` for the search and enforces the rule that every CodeCell must have a source item.

*Call graph*: calls 1 internal fn (model_visible_code_cell_item_ids); called by 1 (start_code_cell).


##### `TraceReducer::add_code_cell_output_item`  (lines 696–712)

```
fn add_code_cell_output_item(&mut self, code_cell_id: &str, item_id: &str) -> Result<()>
```

**Purpose**: This links a CodeCell to a conversation item that represents its custom tool output. It records the relationship in both directions so viewers can navigate either way.

**Data flow**: It receives a CodeCell id and conversation item id. It adds the item id to the CodeCell’s output list without duplicates, then adds a producer reference to the conversation item showing it was produced by that CodeCell. It errors if either record has disappeared.

**Call relations**: `TraceReducer::start_code_cell` uses this for outputs already visible at creation time, and `TraceReducer::attach_model_visible_code_cell_item` uses it for outputs discovered later. It relies on `push_unique` for duplicate-safe insertion.

*Call graph*: calls 1 internal fn (push_unique); called by 2 (attach_model_visible_code_cell_item, start_code_cell); 1 external calls (bail!).


##### `execution_status_for_code_cell`  (lines 715–724)

```
fn execution_status_for_code_cell(status: &CodeCellRuntimeStatus) -> ExecutionStatus
```

**Purpose**: This translates a code-cell-specific runtime status into the general execution status used across the trace. It makes CodeCell endings comparable with other execution windows.

**Data flow**: It receives a CodeCellRuntimeStatus. Starting, running, and yielded become running; completed becomes completed; failed becomes failed; terminated becomes cancelled.

**Call relations**: `TraceReducer::end_code_cell` calls this when closing a CodeCell so the cell’s execution window uses the common trace status language.

*Call graph*: called by 1 (end_code_cell).


##### `push_unique`  (lines 726–730)

```
fn push_unique(items: &mut Vec<String>, item_id: &str)
```

**Purpose**: This appends a string to a list only if it is not already there. It prevents duplicate links in lists such as outputs, nested tools, and wait calls.

**Data flow**: It receives a mutable list of strings and a string to add. It checks whether the value is already present. If not, it copies the value into the list; otherwise it leaves the list unchanged.

**Call relations**: `TraceReducer::add_code_cell_output_item`, `TraceReducer::link_tool_call_to_code_cell`, and `TraceReducer::link_wait_tool_call_from_request_payload` use this whenever they add relationship ids that may be observed more than once.

*Call graph*: called by 3 (add_code_cell_output_item, link_tool_call_to_code_cell, link_wait_tool_call_from_request_payload).


##### `runtime_code_cell_key`  (lines 732–734)

```
fn runtime_code_cell_key(thread_id: &str, runtime_cell_id: &str) -> (String, String)
```

**Purpose**: This builds the lookup key used to map a runtime cell id to a stable CodeCell id. It includes the thread id so identical runtime ids in different threads stay separate.

**Data flow**: It receives a thread id and runtime cell id, copies both strings, and returns them as a pair. It has no side effects.

**Call relations**: `TraceReducer::record_runtime_code_cell_id` uses this when storing mappings, and `TraceReducer::code_cell_id_for_runtime_cell_id_if_known` uses it when looking mappings up.

*Call graph*: called by 2 (code_cell_id_for_runtime_cell_id_if_known, record_runtime_code_cell_id).


### `rollout-trace/src/reducer/tool.rs`

`domain_logic` · `event reduction during trace building`

A “tool call” is when the system asks some outside capability to do work, such as running a command, writing to a terminal, or calling an MCP tool. The raw event stream can describe that work in pieces: a dispatch start, a runtime start, output seen in the conversation, a runtime end, and a final result. This file is the part of the reducer that stitches those pieces into one understandable object.

Think of it like assembling a package’s tracking history from scans at different warehouses. Each scan has only part of the story, so this code checks the package ID, finds the right route, and links every scan to the same delivery.

The main work happens when a tool starts or ends. On start, the reducer checks that the tool is not duplicated, finds its thread, connects it to any model-visible call items already seen, and creates a `ToolCall` record. If the tool is terminal-backed, it also starts or links a richer terminal operation. On end, it records finish time, status, result payload, and closes related terminal or agent activity when appropriate.

The file also handles ordering surprises. Conversation items may appear before or after the tool object. Runtime observations may add extra facts later. Helper functions keep links unique and stop contradictory data, such as two tools claiming the same model-visible call.

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

**Purpose**: Creates the main record for a tool call when a raw “tool started” event arrives. It also links that tool to the right thread, Codex turn, model-visible conversation items, terminal operation, and inference response so later readers can see why the tool ran and what it belonged to.

**Data flow**: It receives the event sequence number, wall-clock time, optional thread and turn identifiers, and a grouped set of tool-start fields. It checks that the tool call ID is new, checks that any model-visible call ID is not already claimed by another tool, works out the thread, validates the turn, finds any already-seen call or output conversation items, possibly starts a terminal operation from the invocation payload, stores the new `ToolCall`, and then adds reverse links from output items and inference responses. The result is either an updated rollout trace with a new connected tool call, or an error if the event contradicts existing trace data.

**Call relations**: This is the main entry point in this file for tool-start events. It relies on `TraceReducer::tool_thread_id`, `TraceReducer::validate_tool_turn`, and `TraceReducer::ensure_unique_model_visible_tool_call` for safety checks, then uses `TraceReducer::add_tool_output_item` and `TraceReducer::link_tool_to_inference_response` to connect the new tool to conversation and inference records. If a required condition fails, it stops with an error through `bail!`.

*Call graph*: calls 5 internal fn (add_tool_output_item, ensure_unique_model_visible_tool_call, link_tool_to_inference_response, tool_thread_id, validate_tool_turn); 2 external calls (new, bail!).


##### `TraceReducer::assign_mcp_tool_call_correlation`  (lines 172–184)

```
fn assign_mcp_tool_call_correlation(
        &mut self,
        tool_call_id: ToolCallId,
        mcp_call_id: McpCallId,
    ) -> Result<()>
```

**Purpose**: Adds the MCP call ID to a tool call after the generic tool record already exists. MCP means “Model Context Protocol,” a bridge protocol used to call external tools; this ID connects the local tool call to the protocol-level call.

**Data flow**: It receives a tool call ID and an MCP call ID. It looks up the existing tool call, stores the MCP ID if none was set before, and returns success. If the tool call does not exist or already has an MCP ID, it returns an error instead of silently overwriting the data.

**Call relations**: This function is used after a tool has already been started by `TraceReducer::start_tool_call`. It does not create a tool call itself; it only enriches one with the bridge-visible MCP identifier. If the event points at a missing or already-correlated tool, it reports that through `bail!`.

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

**Purpose**: Marks a tool call as finished from the canonical dispatch result. It records when the tool ended, whether it succeeded or failed, and the raw result payload, and it may also close related terminal or agent activity.

**Data flow**: It receives the end event’s sequence number and time, the tool call ID, the final execution status, and an optional result payload. It updates the stored `ToolCall` with end time, end sequence, status, and result payload ID. If this tool has a terminal operation that was not already driven by runtime payloads, it ends that terminal operation too. It also gives the result payload to the agent-interaction linking logic. It returns success after updating the trace, or an error if the tool call ID is unknown.

**Call relations**: This is the matching close-out path for a tool created by `TraceReducer::start_tool_call`. It clones stored identifiers so it can safely update related terminal and agent records after releasing the mutable borrow of the tool call. If the tool is unknown, it reports the broken event stream through `bail!`.

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

**Purpose**: Records a lower-level runtime “begin” observation for a tool that has already started. These runtime events can add facts that the dispatch event did not know, such as terminal details or agent interaction information.

**Data flow**: It receives the event sequence, time, tool call ID, and a raw runtime payload. It finds the tool, adds the payload ID to the tool’s list of runtime payloads without duplicating it, checks that terminal-like tools do not accidentally create a second terminal operation, and then lets terminal and agent-specific logic read the runtime payload. If a terminal operation is created, the tool’s summary is updated to point at that richer terminal record. The result is an enriched tool call and possibly new linked domain records.

**Call relations**: This function runs after `TraceReducer::start_tool_call` when runtime-level details arrive. It uses `push_unique` to remember the payload once and uses `matches!` to guard special terminal-backed kinds. If the observation would create inconsistent state, such as a second terminal operation for the same command, it stops with `bail!`.

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

**Purpose**: Records a lower-level runtime “end” observation for an already-started tool. This is important for tools whose real output and finish status come from runtime events rather than only from the dispatch result.

**Data flow**: It receives the event sequence, time, tool call ID, final status, and raw runtime payload. It finds the tool, remembers the runtime payload ID once, retrieves the linked terminal operation if there is one, and ends that terminal operation using the runtime payload as its evidence. It also gives the runtime payload to agent-interaction ending logic. It returns success after updating linked records, or an error if the tool call is missing.

**Call relations**: This is the runtime-level partner to `TraceReducer::start_tool_runtime_observation`. It uses `push_unique` to avoid duplicate payload references, then hands off to terminal and agent-specific ending logic when the tool has those richer records. If the raw event references a tool that was never started, it reports that through `bail!`.

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

**Purpose**: Links a conversation item to an existing tool call when that conversation item is observed after the tool call was already reduced. This keeps the trace correct even when events arrive in an inconvenient order.

**Data flow**: It receives a conversation item ID, an optional model-visible call ID, and the item kind. If there is no call ID, it does nothing. For call items, it finds the single matching tool, adds the item to the tool’s call-item list, links the tool to any inference response that produced that item, and refreshes terminal observation links. For output items, it adds the item to the tool’s output list and marks the item as produced by the tool. Message, reasoning, and compaction marker items are ignored because they are not tool call/output records.

**Call relations**: Transcript reduction calls this when it later discovers conversation items that belong to a tool. The function uses `TraceReducer::single_tool_for_model_visible_call` to find the right tool, then delegates the actual linking to `TraceReducer::add_tool_call_item`, `TraceReducer::add_tool_output_item`, and `TraceReducer::link_tool_to_inference_response` as needed.

*Call graph*: calls 4 internal fn (add_tool_call_item, add_tool_output_item, link_tool_to_inference_response, single_tool_for_model_visible_call).


##### `TraceReducer::tool_thread_id`  (lines 372–390)

```
fn tool_thread_id(
        &self,
        thread_id: Option<String>,
        codex_turn_id: Option<&str>,
    ) -> Result<String>
```

**Purpose**: Determines which conversation thread a tool call belongs to. A thread may be stated directly, or it may be inferred from the Codex turn that started the tool.

**Data flow**: It receives an optional thread ID and an optional Codex turn ID. If the thread ID is present, it returns it immediately. If not, it requires a Codex turn ID, looks up that turn in the rollout, and returns the turn’s thread ID. If neither path works, it returns an error explaining what context is missing or unknown.

**Call relations**: `TraceReducer::start_tool_call` calls this early because every stored tool call must belong to a thread. It uses `bail!` when the raw start event does not provide enough information to place the tool in the trace.

*Call graph*: called by 1 (start_tool_call); 1 external calls (bail!).


##### `TraceReducer::validate_tool_turn`  (lines 392–409)

```
fn validate_tool_turn(&self, thread_id: &str, codex_turn_id: Option<&str>) -> Result<()>
```

**Purpose**: Checks that a tool call’s thread and Codex turn agree with each other. This prevents a tool from being recorded under one thread while claiming to come from a turn in another thread.

**Data flow**: It receives a thread ID and an optional Codex turn ID. It first confirms that the thread exists. If a turn ID is provided, it confirms that the turn exists and that the turn’s stored thread matches the supplied thread. It returns success when the context is consistent, or an error when the raw event points at missing or conflicting data.

**Call relations**: `TraceReducer::start_tool_call` uses this after choosing the thread with `TraceReducer::tool_thread_id`. It acts like a gatekeeper before the tool call is inserted into the rollout, using `bail!` to stop bad links from being saved.

*Call graph*: called by 1 (start_tool_call); 1 external calls (bail!).


##### `TraceReducer::ensure_unique_model_visible_tool_call`  (lines 411–425)

```
fn ensure_unique_model_visible_tool_call(
        &self,
        model_visible_call_id: Option<&str>,
        tool_call_id: &str,
    ) -> Result<()>
```

**Purpose**: Makes sure a model-visible call ID is not claimed by two different tool calls. This matters because the conversation transcript should point to one concrete tool execution, not several competing ones.

**Data flow**: It receives an optional model-visible call ID and the tool call ID that is about to be inserted. If there is no model-visible ID, it succeeds immediately. Otherwise, it asks whether a tool with that visible call ID already exists. If an existing tool is found and it is not the same tool call ID, the function returns an error; otherwise it allows the start to continue.

**Call relations**: `TraceReducer::start_tool_call` calls this before inserting a new tool. Internally it uses `TraceReducer::single_tool_for_model_visible_call` to search existing tools and `bail!` to reject duplicate ownership.

*Call graph*: calls 1 internal fn (single_tool_for_model_visible_call); called by 1 (start_tool_call); 1 external calls (bail!).


##### `TraceReducer::single_tool_for_model_visible_call`  (lines 427–442)

```
fn single_tool_for_model_visible_call(
        &self,
        model_visible_call_id: &str,
    ) -> Result<Option<ToolCallId>>
```

**Purpose**: Finds the one tool call that matches a model-visible call ID, if such a tool exists. It also detects the bad case where more than one tool matches the same visible ID.

**Data flow**: It receives a model-visible call ID. It scans the stored tool calls for tools whose model-visible call ID equals that value. If it finds none, it returns `None`; if it finds exactly one, it returns that tool call ID; if it finds more than one, it returns an error because the trace has become ambiguous.

**Call relations**: `TraceReducer::ensure_unique_model_visible_tool_call` uses this to prevent duplicates before a tool is inserted. `TraceReducer::attach_model_visible_tool_item` uses it later to decide which tool should receive a newly observed conversation item.

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

**Purpose**: Finds conversation items that already belong to a model-visible tool call. It is used when a tool starts after some related transcript items have already been seen.

**Data flow**: It receives a thread ID, a model-visible call ID, and a list of allowed conversation item kinds. It scans all conversation items and keeps only those in the same thread, with the same call ID, and with one of the requested kinds. It returns their item IDs as a list.

**Call relations**: `TraceReducer::start_tool_call` uses this during insertion to pick up pre-existing call items and output items. This lets the reducer cope with event streams where the transcript and tool lifecycle events are not perfectly ordered.


##### `TraceReducer::add_tool_call_item`  (lines 462–468)

```
fn add_tool_call_item(&mut self, tool_call_id: &str, item_id: &str) -> Result<()>
```

**Purpose**: Adds a model-visible call conversation item to a tool call’s list. This records that the transcript item is the user- or model-facing representation of that tool request.

**Data flow**: It receives a tool call ID and a conversation item ID. It looks up the tool call, appends the item ID only if it is not already present, and returns success. If the tool call cannot be found, it returns an error because the link would have nowhere to attach.

**Call relations**: `TraceReducer::attach_model_visible_tool_item` calls this when transcript reduction discovers a function-call or custom-tool-call item for an existing tool. It relies on `push_unique` so repeated observations do not create duplicate links.

*Call graph*: calls 1 internal fn (push_unique); called by 1 (attach_model_visible_tool_item); 1 external calls (bail!).


##### `TraceReducer::add_tool_output_item`  (lines 470–486)

```
fn add_tool_output_item(&mut self, tool_call_id: &str, item_id: &str) -> Result<()>
```

**Purpose**: Adds a model-visible output conversation item to a tool call and marks that item as produced by the tool. This creates a two-way connection: the tool knows its output item, and the item knows which tool produced it.

**Data flow**: It receives a tool call ID and a conversation item ID. It finds the tool call, adds the item ID to the tool’s output list without duplication, then finds the conversation item and adds a `ProducerRef::Tool` entry if it is not already there. It returns success after both sides are linked, or an error if either record has disappeared.

**Call relations**: `TraceReducer::start_tool_call` uses this to attach output items that were already observed before the tool start was reduced. `TraceReducer::attach_model_visible_tool_item` uses it for output items discovered later. It calls `push_unique` for the tool-side list and uses `bail!` when the link cannot be made safely.

*Call graph*: calls 1 internal fn (push_unique); called by 2 (attach_model_visible_tool_item, start_tool_call); 1 external calls (bail!).


##### `TraceReducer::link_tool_to_inference_response`  (lines 488–510)

```
fn link_tool_to_inference_response(&mut self, tool_call_id: &str)
```

**Purpose**: Connects a tool call back to the inference response that started it. An inference response is the model’s produced answer; if that answer included a tool-call item, this function records that the response launched the tool.

**Data flow**: It receives a tool call ID. It looks up the tool, copies its model-visible call item IDs, and scans inference calls for responses that include any of those items. For each matching inference call, it adds the tool call ID to the inference’s list of tools started by that response, avoiding duplicates. If the tool is missing or has no call items yet, it quietly does nothing.

**Call relations**: `TraceReducer::start_tool_call` calls this after creating a tool, and `TraceReducer::attach_model_visible_tool_item` calls it when a call item is attached later. It is the bridge from transcript-level model output to the concrete tool execution record.

*Call graph*: called by 2 (attach_model_visible_tool_item, start_tool_call).


##### `push_unique`  (lines 513–517)

```
fn push_unique(items: &mut Vec<String>, item_id: &str)
```

**Purpose**: Adds a string to a list only if the list does not already contain it. It is a small safety helper that keeps repeated events from creating duplicate IDs.

**Data flow**: It receives a mutable list of strings and an item ID. It checks whether the ID is already present. If not, it copies the ID into the list; if it is already there, the list is left unchanged. It does not return a value.

**Call relations**: `TraceReducer::add_tool_call_item`, `TraceReducer::add_tool_output_item`, `TraceReducer::start_tool_runtime_observation`, and `TraceReducer::end_tool_runtime_observation` use this whenever they record links or payload IDs that may be seen more than once.

*Call graph*: called by 4 (add_tool_call_item, add_tool_output_item, end_tool_runtime_observation, start_tool_runtime_observation).


### `rollout-trace/src/reducer/tool/agents.rs`

`domain_logic` · `trace reduction`

This file is part of the trace reducer, which converts raw recorded events into a cleaner story of what happened. Its job is to build “interaction edges”: links that say, for example, “this tool call in the parent thread created this message in the child thread” or “this child agent result was delivered back to the parent.” Think of it like drawing arrows on a whiteboard after reading a chat log, so a newcomer can follow how agents talked to each other.

A tricky part is timing. The sender-side tool event can appear before the recipient-side conversation message has been reduced. So this file often creates a pending edge, waits for the matching message to appear, and then attaches the edge to the exact message. If the exact message never appears, spawn edges can fall back to the child thread itself, so the trace still preserves the fact that a child agent was created.

The file also keeps raw payload IDs with each edge. These are the original pieces of evidence behind the reduced link. It carefully merges duplicate observations, rejects conflicting ones, and avoids linking the same delivered message twice.

#### Function details

##### `spawn_edge_id`  (lines 66–68)

```
fn spawn_edge_id(parent_thread_id: &str, child_thread_id: &str) -> String
```

**Purpose**: Builds the stable ID used for the link between a parent thread and a spawned child thread. A stable ID matters because the same spawn relationship may be seen more than once and must merge into one edge, not create duplicates.

**Data flow**: It receives a parent thread ID and a child thread ID. It combines them into a single string that names the spawn edge. The output is that edge ID.

**Call relations**: Spawn-related reducer code uses this when it sees either a spawn completion or a sub-agent start notification, so both observations point at the same relationship.

*Call graph*: called by 2 (end_spawn_agent_interaction, end_sub_agent_activity); 1 external calls (format!).


##### `TraceReducer::start_agent_interaction_from_runtime`  (lines 72–126)

```
fn start_agent_interaction_from_runtime(
        &mut self,
        tool_call_id: &str,
        runtime_payload: &RawPayloadRef,
    ) -> Result<()>
```

**Purpose**: Starts building an agent-to-agent link from a runtime “begin” event. It records that an assignment, message, or close request has begun, even if the final recipient-side evidence is not visible yet.

**Data flow**: It receives a tool call ID and a raw runtime payload. It looks up what kind of tool call this is, reads the payload into the matching event shape, and either queues a message-style edge, creates or updates a close edge, or ignores tool kinds that are not agent deliveries. The result is an updated reducer state or an error if required data is missing or malformed.

**Call relations**: This is one of the entry points from tool runtime event reduction into the agent-linking logic. It hands message deliveries to TraceReducer::queue_message_agent_interaction and close requests to TraceReducer::upsert_close_agent_interaction.

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

**Purpose**: Finishes or enriches an agent interaction when a runtime “end” event arrives. It adds completion time and, for spawn events, learns which child thread was created.

**Data flow**: It receives the event time, the tool call ID, and the raw runtime payload. It reads the payload, detects whether it is a sub-agent activity notification or a normal tool end payload, and then routes it to the matching helper. The reducer state gains an updated pending or materialized edge.

**Call relations**: This is the counterpart to TraceReducer::start_agent_interaction_from_runtime. It delegates to TraceReducer::end_sub_agent_activity, TraceReducer::end_spawn_agent_interaction, TraceReducer::end_message_agent_interaction, or TraceReducer::upsert_close_agent_interaction depending on what kind of end event was observed.

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

**Purpose**: Interprets a sub-agent activity event and makes sure it matches the tool call that produced it. This protects the trace from recording impossible links, such as treating a close notification as a normal message.

**Data flow**: It receives the event time, tool call ID, tool kind, and activity payload. It compares the tool kind with the activity kind, then either queues a spawn/message edge, updates a close edge, or returns an error for a mismatch. The output is an updated reducer state or a clear failure.

**Call relations**: TraceReducer::end_agent_interaction_from_runtime calls this when the runtime end payload names an agent thread directly. This function then hands valid message-like activity to TraceReducer::queue_sub_agent_activity_message_edge or valid close activity to TraceReducer::upsert_close_agent_interaction.

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

**Purpose**: Creates the pending link for a sub-agent activity message, using details from the original tool call. This is used when the runtime reports that the target agent actually received or started work.

**Data flow**: It receives timing, tool, edge, target-thread, and optional fallback information. It looks up the tool call, finds the sender agent path, extracts the message text from the tool invocation, gathers raw payload IDs, and builds a pending edge. That pending edge is then either resolved to an existing conversation item or saved for later.

**Call relations**: TraceReducer::end_sub_agent_activity calls this after deciding that the activity is a valid spawn, assignment, or send-message event. It relies on helpers for message text, agent identity, payload evidence, and final queue-or-resolve behavior.

*Call graph*: calls 4 internal fn (agent_message_content_from_invocation, agent_path_for_thread, agent_tool_payload_ids, queue_or_resolve_agent_interaction_edge); called by 1 (end_sub_agent_activity).


##### `TraceReducer::agent_message_content_from_invocation`  (lines 277–307)

```
fn agent_message_content_from_invocation(&self, tool_call_id: &str) -> Result<String>
```

**Purpose**: Extracts the actual message text that was passed to an agent tool. This lets the reducer match the sender-side tool call with the recipient-side conversation message.

**Data flow**: It receives a tool call ID. It finds the tool call’s raw invocation payload, reads the JSON inside it, pulls out the serialized function arguments, parses those arguments, and returns the message field. If any piece is missing or badly formatted, it returns an error.

**Call relations**: TraceReducer::queue_sub_agent_activity_message_edge uses this when an activity event does not directly carry the message text but the original tool invocation does.

*Call graph*: called by 1 (queue_sub_agent_activity_message_edge); 1 external calls (from_str).


##### `TraceReducer::attach_agent_interaction_tool_result`  (lines 310–346)

```
fn attach_agent_interaction_tool_result(
        &mut self,
        tool_call_id: &str,
        result_payload: Option<&RawPayloadRef>,
    ) -> Result<()>
```

**Purpose**: Adds the tool result payload to the agent interaction edge that came from the same tool call. This keeps the final tool response attached to the reduced link as supporting evidence.

**Data flow**: It receives a tool call ID and an optional result payload. If there is no payload, nothing changes. If a matching edge already exists, the payload ID is added there; if the edge is still pending, the payload ID is added to the pending record instead. Duplicate payload IDs are avoided.

**Call relations**: This function is used after tool result reduction may have produced a result payload. It connects that result evidence to either the already-materialized interaction edge or the waiting pending edge.

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

**Purpose**: Records the relationship created when one agent spawns another agent thread. It captures the child thread, the prompt used to start it, and the raw payload evidence.

**Data flow**: It receives the end time, tool call ID, and spawn-end payload. If the payload does not name a new child thread, it does nothing. Otherwise it builds a spawn edge from the tool call to the child’s first visible task message, with a fallback to the child thread if that message never appears.

**Call relations**: TraceReducer::end_agent_interaction_from_runtime calls this for completed spawn-agent tool calls. It uses spawn_edge_id for the stable relationship name and passes the resulting pending edge to TraceReducer::queue_or_resolve_agent_interaction_edge.

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

**Purpose**: Completes an assignment or send-message interaction by adding the end time from the runtime event. It is a small adapter around the shared message-queueing logic.

**Data flow**: It receives the event time, tool call ID, edge kind, and end payload. It pulls the receiver thread and prompt from the payload and forwards them with the completion time. The reducer state is updated through the shared message interaction path.

**Call relations**: TraceReducer::end_agent_interaction_from_runtime calls this for assignment and send-message tool completions. It hands the work to TraceReducer::queue_message_agent_interaction so begin and end events use the same matching logic.

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

**Purpose**: Builds the pending link for a direct agent message, such as assigning a task or sending a message. It prepares the information needed to match the sender tool call to the recipient conversation item.

**Data flow**: It receives the tool call ID, edge kind, target thread, message text, and optional end time. It looks up the tool call, finds the sender agent path, gathers raw payload IDs, and creates a pending edge. The edge is either resolved immediately to an existing message or stored until the message appears.

**Call relations**: Both TraceReducer::start_agent_interaction_from_runtime and TraceReducer::end_message_agent_interaction call this, so begin and end observations can merge into the same edge.

*Call graph*: calls 4 internal fn (agent_path_for_thread, agent_tool_payload_ids, queue_or_resolve_agent_interaction_edge, tool_edge_id); called by 2 (end_message_agent_interaction, start_agent_interaction_from_runtime).


##### `TraceReducer::agent_tool_payload_ids`  (lines 420–436)

```
fn agent_tool_payload_ids(&self, tool_call_id: &str) -> Result<Vec<String>>
```

**Purpose**: Collects all raw payload IDs that belong to an agent-related tool call. These IDs are the original evidence behind the cleaned-up interaction edge.

**Data flow**: It receives a tool call ID. It looks up the tool call and collects its invocation payload, runtime payloads, and result payload if present, while avoiding duplicates. It returns the list of payload IDs.

**Call relations**: Several edge-building paths call this before creating or updating an interaction edge, so assignments, messages, spawns, and close events all carry their source evidence.

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

**Purpose**: Creates or updates the link that says one tool call closed or interrupted an agent thread. It avoids creating links to threads that do not exist in the reduced trace.

**Data flow**: It receives a tool call ID, target thread ID, and optional end time. If the target thread is unknown, it leaves the evidence only on the tool call and creates no edge. Otherwise it gathers timing and raw payload IDs, then inserts or merges a close-agent edge pointing at the target thread.

**Call relations**: Start, end, and sub-agent activity paths call this when they see close-agent information. It delegates the actual insert-or-merge behavior to TraceReducer::upsert_interaction_edge.

*Call graph*: calls 3 internal fn (agent_tool_payload_ids, upsert_interaction_edge, tool_edge_id); called by 3 (end_agent_interaction_from_runtime, end_sub_agent_activity, start_agent_interaction_from_runtime); 1 external calls (new).


##### `TraceReducer::queue_agent_result_interaction_edge`  (lines 475–513)

```
fn queue_agent_result_interaction_edge(
        &mut self,
        observed: ObservedAgentResultEdge,
    ) -> Result<()>
```

**Purpose**: Records the delivery of a child agent’s result back to its parent thread. It preserves this relationship even when the child did not produce a final assistant message.

**Data flow**: It receives an ObservedAgentResultEdge containing timing, child and parent thread IDs, the child turn ID, message text, and optional raw payload. It tries to anchor the source to the child’s latest assistant message for that turn; if none exists, it anchors to the child thread. It then creates a pending result edge aimed at the parent thread.

**Call relations**: This is used when child completion notifications are observed outside the normal tool lifecycle. It uses TraceReducer::latest_assistant_message_item_for_turn to find the best source anchor and TraceReducer::queue_or_resolve_agent_interaction_edge to match the parent-side delivered message.

*Call graph*: calls 3 internal fn (agent_path_for_thread, latest_assistant_message_item_for_turn, queue_or_resolve_agent_interaction_edge).


##### `TraceReducer::resolve_pending_agent_edges_for_item`  (lines 516–541)

```
fn resolve_pending_agent_edges_for_item(
        &mut self,
        item_id: &str,
    ) -> Result<()>
```

**Purpose**: Checks whether a newly reduced conversation item is the missing target for a pending agent edge. This is how delayed recipient-side messages get connected to the sender-side tool call.

**Data flow**: It receives a conversation item ID. If the item is already the target of an edge, it stops. Otherwise it extracts inter-agent message details from the item, searches pending edges for the same target thread, author, and content, removes the matching pending edge, and materializes it as a real edge to this item.

**Call relations**: This function runs when conversation items become available during reduction. It works with TraceReducer::inter_agent_message_item, TraceReducer::is_interaction_edge_target_item, and TraceReducer::upsert_agent_interaction_edge_for_item.

*Call graph*: calls 3 internal fn (inter_agent_message_item, is_interaction_edge_target_item, upsert_agent_interaction_edge_for_item).


##### `TraceReducer::queue_or_resolve_agent_interaction_edge`  (lines 543–590)

```
fn queue_or_resolve_agent_interaction_edge(
        &mut self,
        pending: PendingAgentInteractionEdge,
    ) -> Result<()>
```

**Purpose**: Either immediately connects a pending agent edge to its matching conversation item or stores it until that item appears. It also merges repeated observations of the same edge safely.

**Data flow**: It receives a PendingAgentInteractionEdge. First it searches for an already-existing matching recipient message. If found, it creates the real edge. If not, it looks for an existing pending edge with the same ID; matching data is merged, conflicting data causes an error, and entirely new data is stored for later.

**Call relations**: All message-like agent edge builders funnel through this function. It is the central waiting-room logic that keeps early sender events from being lost before recipient messages are reduced.

*Call graph*: calls 3 internal fn (find_unlinked_inter_agent_message_item, upsert_agent_interaction_edge_for_item, extend_unique); called by 4 (end_spawn_agent_interaction, queue_agent_result_interaction_edge, queue_message_agent_interaction, queue_sub_agent_activity_message_edge); 1 external calls (bail!).


##### `TraceReducer::resolve_pending_spawn_edge_fallbacks`  (lines 593–628)

```
fn resolve_pending_spawn_edge_fallbacks(&mut self) -> Result<()>
```

**Purpose**: Finalizes spawn edges that never found the child’s first visible task message but do have a real child thread. This prevents failed early child agents from disappearing from the trace.

**Data flow**: It takes all pending agent edges out of the reducer. For each edge with a spawn fallback thread, it checks that the edge really is a spawn edge and that the child thread exists. Valid unresolved spawns are inserted as edges to the child thread; non-spawn fallback data causes an error; other pending edges are left unmaterialized by this pass.

**Call relations**: This is used after normal item matching has had its chance. It hands valid fallback edges to TraceReducer::upsert_interaction_edge so the final reduced trace still shows the parent-child relationship.

*Call graph*: calls 1 internal fn (upsert_interaction_edge); 3 external calls (new, bail!, take).


##### `TraceReducer::upsert_agent_interaction_edge_for_item`  (lines 630–647)

```
fn upsert_agent_interaction_edge_for_item(
        &mut self,
        pending: PendingAgentInteractionEdge,
        target_item_id: String,
    ) -> Result<()>
```

**Purpose**: Turns a pending agent interaction into a real edge whose target is a specific conversation item. The target item is also recorded as content carried by the edge.

**Data flow**: It receives a pending edge and the target item ID. It builds an InteractionEdge pointing at that conversation item, includes the item ID in the carried item list, preserves timing and raw payload evidence, and inserts or merges it into the rollout.

**Call relations**: TraceReducer::queue_or_resolve_agent_interaction_edge uses this when a matching message is already present, and TraceReducer::resolve_pending_agent_edges_for_item uses it when a newly reduced item completes a pending edge.

*Call graph*: calls 1 internal fn (upsert_interaction_edge); called by 2 (queue_or_resolve_agent_interaction_edge, resolve_pending_agent_edges_for_item); 1 external calls (vec!).


##### `TraceReducer::upsert_interaction_edge`  (lines 649–677)

```
fn upsert_interaction_edge(&mut self, edge: InteractionEdge) -> Result<()>
```

**Purpose**: Inserts a new interaction edge or merges new evidence into an existing edge with the same ID. It is the safety gate that prevents one edge ID from pointing at two different relationships.

**Data flow**: It receives a complete InteractionEdge. If no edge with that ID exists, it inserts it. If one exists with the same kind, source, and target, it widens the time range and adds any new carried item or payload IDs. If the existing edge points somewhere else, it returns an error.

**Call relations**: Close edges, resolved message edges, and spawn fallback edges all use this shared insert-or-merge path so conflict checks and evidence merging behave consistently.

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

**Purpose**: Searches a thread for a delivered inter-agent message that has not already been used as the target of an edge. This helps match early sender-side events to recipient-side transcript items.

**Data flow**: It receives a thread ID, expected author, and expected message content. It walks that thread’s conversation items, skips items already linked by an interaction edge, and returns the first item whose inter-agent message fields match. If none match, it returns nothing.

**Call relations**: TraceReducer::queue_or_resolve_agent_interaction_edge calls this before deciding whether to materialize an edge immediately or keep it pending.

*Call graph*: called by 1 (queue_or_resolve_agent_interaction_edge).


##### `TraceReducer::inter_agent_message_item`  (lines 701–710)

```
fn inter_agent_message_item(&self, item_id: &str) -> Option<(String, String, String)>
```

**Purpose**: Extracts the thread, author, and content from a conversation item if that item is truly an inter-agent delivery for its own thread. This filters out ordinary assistant messages.

**Data flow**: It receives an item ID. It looks up the conversation item, extracts possible inter-agent message fields, checks that the message recipient matches the thread’s agent path, and returns the thread ID, author, and content if valid. Otherwise it returns nothing.

**Call relations**: TraceReducer::resolve_pending_agent_edges_for_item uses this to understand newly reduced items. It relies on inter_agent_message_fields for the item-level parsing.

*Call graph*: calls 1 internal fn (inter_agent_message_fields); called by 1 (resolve_pending_agent_edges_for_item).


##### `TraceReducer::agent_path_for_thread`  (lines 712–718)

```
fn agent_path_for_thread(&self, thread_id: &str) -> Result<String>
```

**Purpose**: Finds the agent identity path for a thread. The agent path is the name-like address used to match who sent or received an inter-agent message.

**Data flow**: It receives a thread ID. It looks up the thread in the reduced rollout and returns its agent path. If the thread is unknown, it returns an error explaining which thread was missing.

**Call relations**: Edge-building functions use this whenever they need the sender’s identity, including spawn, message, sub-agent activity, and agent-result edges.

*Call graph*: called by 4 (end_spawn_agent_interaction, queue_agent_result_interaction_edge, queue_message_agent_interaction, queue_sub_agent_activity_message_edge).


##### `TraceReducer::is_interaction_edge_target_item`  (lines 720–725)

```
fn is_interaction_edge_target_item(&self, item_id: &str) -> bool
```

**Purpose**: Checks whether a conversation item is already the target of an interaction edge. This prevents the same delivered message from being claimed twice.

**Data flow**: It receives an item ID. It scans existing interaction edges and returns true if any edge targets that exact conversation item, otherwise false.

**Call relations**: TraceReducer::resolve_pending_agent_edges_for_item calls this before trying to attach a newly reduced item to a pending edge.

*Call graph*: called by 1 (resolve_pending_agent_edges_for_item).


##### `TraceReducer::latest_assistant_message_item_for_turn`  (lines 727–744)

```
fn latest_assistant_message_item_for_turn(
        &self,
        thread_id: &str,
        codex_turn_id: &str,
    ) -> Option<String>
```

**Purpose**: Finds the latest normal assistant message in a child agent turn. This gives an agent-result edge the most precise source when the child actually produced a final answer.

**Data flow**: It receives a thread ID and a turn ID. It filters conversation items to normal assistant message items in that thread and turn, ignores inter-agent delivery messages, chooses the one seen latest, and returns its item ID if found.

**Call relations**: TraceReducer::queue_agent_result_interaction_edge uses this before falling back to anchoring a result delivery on the whole child thread.

*Call graph*: called by 1 (queue_agent_result_interaction_edge).


##### `extend_unique`  (lines 747–753)

```
fn extend_unique(items: &mut Vec<String>, new_items: Vec<String>)
```

**Purpose**: Adds several string IDs to a list while avoiding duplicates. It is used for evidence lists where repeating the same ID would add noise but no meaning.

**Data flow**: It receives a mutable list and a second list of new strings. For each new string, it checks whether the first list already contains it; if not, it appends it. It changes the first list and returns no separate value.

**Call relations**: Pending-edge merging and final edge merging use this helper so carried item IDs and raw payload IDs stay complete without repeated entries.

*Call graph*: called by 2 (queue_or_resolve_agent_interaction_edge, upsert_interaction_edge).


##### `tool_edge_id`  (lines 755–757)

```
fn tool_edge_id(tool_call_id: &str) -> String
```

**Purpose**: Builds the stable ID used for an interaction edge that comes directly from a tool call. Stable IDs let separate begin, end, and payload observations merge into one edge.

**Data flow**: It receives a tool call ID and formats it into an edge ID string. The output is that string.

**Call relations**: Message, close, and some sub-agent activity paths use this when the tool call itself is the source of the relationship.

*Call graph*: called by 3 (end_sub_agent_activity, queue_message_agent_interaction, upsert_close_agent_interaction); 1 external calls (format!).


##### `tool_call_source_matches`  (lines 759–761)

```
fn tool_call_source_matches(anchor: &TraceAnchor, tool_call_id: &str) -> bool
```

**Purpose**: Checks whether a trace anchor points to a specific tool call. A trace anchor is a pointer to something in the reduced trace, such as a tool call, thread, or message item.

**Data flow**: It receives an anchor and a tool call ID. It returns true only when the anchor is a tool-call anchor with the same ID. It does not change any state.

**Call relations**: This helper supports code that needs to find the edge or pending edge produced by a particular tool call, especially when attaching later tool-result evidence.

*Call graph*: 1 external calls (matches!).


##### `push_unique`  (lines 763–767)

```
fn push_unique(items: &mut Vec<String>, item: &str)
```

**Purpose**: Adds one string ID to a list only if it is not already present. This keeps evidence lists tidy and prevents duplicate raw payload IDs.

**Data flow**: It receives a mutable list and one string. If the string is absent, it appends a copy; if it is already present, the list stays the same. It returns no separate value.

**Call relations**: TraceReducer::agent_tool_payload_ids uses this while collecting payload IDs, and TraceReducer::attach_agent_interaction_tool_result uses it when adding a result payload.

*Call graph*: called by 2 (agent_tool_payload_ids, attach_agent_interaction_tool_result).


##### `inter_agent_message_fields`  (lines 769–805)

```
fn inter_agent_message_fields(item: &ConversationItem) -> Option<(String, String, String)>
```

**Purpose**: Recognizes a conversation item as an inter-agent message and extracts sender, recipient, and content. It supports both the newer explicit agent-message shape and an older JSON-in-text format.

**Data flow**: It receives a conversation item. It first rejects anything that is not an assistant message. For newer items, it reads the embedded agent-message metadata and the text or encrypted content body. For older traces, it parses the message text as an InterAgentCommunication JSON object. It returns author, recipient, and content when the shape is valid, otherwise nothing.

**Call relations**: TraceReducer::inter_agent_message_item calls this as the low-level parser before checking whether the recipient matches the thread that contains the item.

*Call graph*: called by 1 (inter_agent_message_item).


### `rollout-trace/src/reducer/tool/terminal.rs`

`domain_logic` · `trace reduction`

Raw traces record terminal work as scattered tool lifecycle events and JSON payloads. This file is the translator that turns those pieces into a cleaner story: a terminal operation starts, may belong to a terminal session, ends with a result, and can be linked back to what the model saw. Without it, terminal timelines would be hard to reconstruct, especially for actions like sending stdin to an existing process.

There are two ways a terminal operation can start. Rich protocol events describe exec-style runtime activity directly. Some direct tool calls, such as write_stdin, do not always have that rich runtime start event, so this file can also build a terminal row from the normal dispatch invocation payload. In both cases it parses the JSON, creates a TerminalOperation, assigns it a fresh id, and joins it to a TerminalSession when a process or session id is known.

When the tool ends, the file records the finish time, status, and output. It accepts more than one response shape because different recording paths store terminal results differently. It also checks that a terminal id does not mysteriously change between start and end. Finally, it mirrors model-visible call and output item ids onto the terminal operation, so a UI can connect the transcript view and the terminal timeline.

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

**Purpose**: Starts a terminal operation from a normal tool dispatch invocation, but only for write_stdin. This fills a gap for direct stdin-writing tools that may not produce a richer runtime-start event.

**Data flow**: It receives the event sequence, time, thread id, tool call id, tool kind, and optional invocation payload. If the tool is not write_stdin, it does nothing and returns no operation id. If a payload exists, it reads the JSON, parses the write_stdin request and session id, then creates a terminal operation and returns its new id.

**Call relations**: This is used when the reducer sees the invocation side of a direct write_stdin tool call. It relies on parse_dispatch_terminal_request to understand the dispatch JSON, then hands the parsed request to insert_terminal_operation so the shared operation-creation path is used.

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

**Purpose**: Starts a terminal operation from a protocol runtime-begin payload. This is the main path for richer exec-style terminal events that already describe the command or stdin interaction.

**Data flow**: It receives event timing, thread and tool ids, the tool kind, and a runtime payload reference. It first decides whether this tool kind is terminal-related. If so, it reads the payload JSON, decodes it as an exec-command begin payload, converts it into a terminal request, and creates a new terminal operation.

**Call relations**: This function is called when the reducer sees a runtime-begin event. It asks terminal_operation_kind whether the tool belongs in the terminal view, uses parse_protocol_terminal_request to convert the protocol payload, and then passes the result to insert_terminal_operation.

*Call graph*: calls 3 internal fn (insert_terminal_operation, parse_protocol_terminal_request, terminal_operation_kind); 1 external calls (from_value).


##### `TraceReducer::insert_terminal_operation`  (lines 108–150)

```
fn insert_terminal_operation(
        &mut self,
        start: TerminalOperationStart<'_>,
    ) -> Result<Option<TerminalOperationId>>
```

**Purpose**: Creates and stores a new TerminalOperation in the rollout being built. It is the common insertion point for terminal operations regardless of whether they came from dispatch payloads or runtime payloads.

**Data flow**: It receives a prepared start record containing timing, ids, operation kind, raw payload id, and parsed request details. It generates a new operation id, stores a running operation with its request and source payload, and, if a terminal id is known, makes sure there is a matching terminal session. It returns the new operation id.

**Call relations**: Both start_terminal_operation_from_invocation and start_terminal_operation_from_runtime call this after parsing their input. It uses next_terminal_operation_id for a stable id and ensure_terminal_session when the operation can be tied to a terminal session.

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

**Purpose**: Marks a terminal operation as finished and attaches its output, if an output payload is available. It also keeps the terminal session link up to date once the terminal id is known.

**Data flow**: It receives the finish sequence, finish time, thread id, operation id, final status, and optional response payload. It finds the existing operation, parses the response if present, records the end time and status, adds the response payload id, checks or fills in the terminal id, and stores the terminal result. If a terminal id is available, it ensures the session contains this operation.

**Call relations**: Callers can use this at the end of any tool lifecycle; non-terminal tools simply should not have a terminal operation id. It calls ensure_terminal_session after updating the operation, and uses push_unique so payload ids and session operation ids are not duplicated. It stops with an error if the operation is unknown or if the terminal id changes unexpectedly.

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

**Purpose**: Makes sure a TerminalSession exists for a given terminal id and that a given operation is listed in it. A session is the long-lived terminal process or channel that several operations can belong to.

**Data flow**: It receives a thread id, terminal id, operation id, and the operation's start time and sequence. If the session does not exist, it creates one using this operation as the creator. Then it checks that the same terminal id is not being reused by another thread and adds the operation id to the session if it is not already there.

**Call relations**: insert_terminal_operation calls this when a terminal id is known at start time. end_terminal_operation calls it when the id is learned or confirmed at finish time. It is the guardrail that keeps terminal operations grouped into the right session.

*Call graph*: called by 2 (end_terminal_operation, insert_terminal_operation); 3 external calls (new, bail!, push_unique).


##### `TraceReducer::sync_terminal_model_observation`  (lines 280–317)

```
fn sync_terminal_model_observation(
        &mut self,
        tool_call_id: &str,
    ) -> Result<()>
```

**Purpose**: Links a terminal operation to the tool call and tool output items that were visible to the model. This lets a viewer jump between the model transcript and the terminal timeline.

**Data flow**: It receives a tool call id and looks up that tool call in the reduced rollout. If the tool call has a terminal operation and has model-visible call or output item ids, it copies those ids into a terminal model observation on the operation. It updates an existing direct-tool-call observation when one is already present, or creates one otherwise.

**Call relations**: This runs after model-visible tool item ids have been learned for a tool call. It does not parse terminal output itself; instead, it connects already-reduced tool call data to the terminal operation created by the start and end paths.

*Call graph*: 1 external calls (bail!).


##### `TraceReducer::next_terminal_operation_id`  (lines 319–323)

```
fn next_terminal_operation_id(&mut self) -> TerminalOperationId
```

**Purpose**: Produces the next unique id for a terminal operation. The id is simple and stable within the reduced rollout, like numbering tickets in order.

**Data flow**: It reads the reducer's current terminal operation counter, formats it into a string such as terminal_operation:0, then increments the counter for next time. The output is the new operation id.

**Call relations**: insert_terminal_operation calls this whenever a new terminal operation is stored. It is kept private so ids are assigned from one central place.

*Call graph*: called by 1 (insert_terminal_operation); 1 external calls (format!).


##### `terminal_operation_kind`  (lines 326–341)

```
fn terminal_operation_kind(kind: &ToolCallKind) -> Option<TerminalOperationKind>
```

**Purpose**: Decides whether a tool kind belongs in the terminal view and, if so, which terminal operation kind it maps to. This prevents unrelated tools, such as web or image tools, from becoming terminal rows.

**Data flow**: It receives a ToolCallKind. For ExecCommand and WriteStdin it returns the matching TerminalOperationKind. For all other tool kinds it returns nothing.

**Call relations**: start_terminal_operation_from_runtime calls this before parsing a runtime payload. If it returns nothing, the runtime event is ignored for terminal reduction.

*Call graph*: called by 1 (start_terminal_operation_from_runtime).


##### `parse_protocol_terminal_request`  (lines 363–388)

```
fn parse_protocol_terminal_request(
    payload: ExecCommandBeginPayload,
    operation_kind: &TerminalOperationKind,
) -> ParsedTerminalRequest
```

**Purpose**: Converts a rich protocol begin payload into the common TerminalRequest shape used by the reduced model. It normalizes exec commands and stdin writes into the same terminal-operation language.

**Data flow**: It receives an ExecCommandBeginPayload and the terminal operation kind. It copies the optional process id as the terminal id, then builds either an ExecCommand request with command and working directory or a WriteStdin request with the interaction input. The output is a parsed request plus the optional terminal id.

**Call relations**: start_terminal_operation_from_runtime calls this after decoding runtime JSON. Its output is passed to insert_terminal_operation, which stores the operation and possibly creates the session.

*Call graph*: called by 1 (start_terminal_operation_from_runtime).


##### `parse_dispatch_terminal_request`  (lines 390–421)

```
fn parse_dispatch_terminal_request(value: JsonValue) -> Result<ParsedTerminalRequest>
```

**Purpose**: Parses the normal dispatch invocation payload for a direct write_stdin call. This is needed when the dispatch payload is the only place that carries the session id needed to join the terminal session.

**Data flow**: It receives raw JSON from a dispatch invocation. It checks that the tool name is write_stdin and that the payload is a function-style payload, then parses the function arguments string. It extracts the session id, stdin characters, and optional output-limiting settings, and returns a terminal request tied to that session.

**Call relations**: start_terminal_operation_from_invocation calls this for direct write_stdin starts. It uses terminal_id_from_json to accept session ids that arrive as either strings or numbers, and reports clear errors when the dispatch payload is not the expected shape.

*Call graph*: calls 1 internal fn (terminal_id_from_json); called by 1 (start_terminal_operation_from_invocation); 3 external calls (bail!, from_str, from_value).


##### `parse_terminal_response_payload`  (lines 423–446)

```
fn parse_terminal_response_payload(
    value: JsonValue,
    operation_kind: &TerminalOperationKind,
    raw_payload_id: &str,
) -> Result<ParsedTerminalResponse>
```

**Purpose**: Chooses the right parser for a terminal operation's response payload. Different recording paths can store terminal endings in protocol form or dispatch form, and this function hides that difference.

**Data flow**: It receives response JSON, the operation kind, and the raw payload id for error messages. For exec commands it parses the protocol end payload. For write_stdin it first tries the protocol shape, and if that fails it tries the dispatch response shape. The output is a parsed terminal response containing an optional terminal id and a TerminalResult.

**Call relations**: The terminal-ending flow uses this before storing the final result on an operation. It delegates to parse_protocol_terminal_response for protocol results and parse_dispatch_terminal_response for dispatch-style write_stdin results.

*Call graph*: calls 2 internal fn (parse_dispatch_terminal_response, parse_protocol_terminal_response); 1 external calls (clone).


##### `parse_protocol_terminal_response`  (lines 448–460)

```
fn parse_protocol_terminal_response(payload: ExecCommandEndPayload) -> ParsedTerminalResponse
```

**Purpose**: Turns a protocol exec-command end payload into a TerminalResult. This captures the usual terminal output fields: exit code, stdout, stderr, and formatted output.

**Data flow**: It receives an ExecCommandEndPayload. It copies the optional process id as the terminal id and packages stdout, stderr, exit code, and formatted output into the common result structure. Fields that the protocol payload does not provide, such as token count and chunk id, are left empty.

**Call relations**: parse_terminal_response_payload calls this after successfully decoding a protocol response. Its result is then stored on the terminal operation by the ending flow.

*Call graph*: called by 1 (parse_terminal_response_payload).


##### `parse_dispatch_terminal_response`  (lines 462–499)

```
fn parse_dispatch_terminal_response(value: JsonValue) -> Result<ParsedTerminalResponse>
```

**Purpose**: Parses terminal output from dispatch-style tool responses. This covers direct responses, code-mode responses, and error responses that do not use the protocol end payload shape.

**Data flow**: It receives response JSON and decodes it as a tagged dispatch response. A direct response becomes text output from the response item. A code-mode response is further interpreted as an exec result when possible. An error response becomes stderr and formatted output. It returns a terminal response without a terminal id, because this response shape does not provide one.

**Call relations**: parse_terminal_response_payload uses this as the fallback path for write_stdin responses that are not protocol-shaped. For code-mode values it hands off to parse_code_mode_exec_result so structured exec-like data is preserved.

*Call graph*: calls 1 internal fn (parse_code_mode_exec_result); called by 1 (parse_terminal_response_payload); 2 external calls (new, from_value).


##### `parse_code_mode_exec_result`  (lines 501–523)

```
fn parse_code_mode_exec_result(value: JsonValue) -> TerminalResult
```

**Purpose**: Extracts terminal-like output from a code-mode tool value. Code-mode may return a structured exec result, but this function also has a safe fallback for less structured JSON.

**Data flow**: It receives a JSON value. If the value matches the expected code-mode exec result shape, it copies exit code, output, token count, and chunk id into a TerminalResult. If not, it turns the JSON into readable text using json_text_content or a JSON string representation. The output is always a TerminalResult.

**Call relations**: parse_dispatch_terminal_response calls this for code-mode dispatch responses. It uses json_text_content only on the fallback path, when the response is not the structured exec result it hoped for.

*Call graph*: calls 1 internal fn (json_text_content); called by 1 (parse_dispatch_terminal_response); 2 external calls (clone, new).


##### `json_text_content`  (lines 525–539)

```
fn json_text_content(value: &JsonValue) -> Option<String>
```

**Purpose**: Pulls human-readable text out of a JSON value. It is a small helper for cases where a response might be a plain string, a list of text parts, null, or another JSON object.

**Data flow**: It receives a JSON value. A string is returned as-is. An array is searched for items with a text field and those texts are joined with new lines. Null returns nothing. Other JSON values are converted to their JSON text form. The output is optional text.

**Call relations**: parse_code_mode_exec_result uses this when it cannot decode a structured code-mode exec result. It helps preserve something readable instead of dropping unusual response shapes.

*Call graph*: called by 1 (parse_code_mode_exec_result).


##### `terminal_id_from_json`  (lines 541–547)

```
fn terminal_id_from_json(value: &JsonValue) -> Option<String>
```

**Purpose**: Converts a JSON session id into the string form used as a terminal id. It accepts the practical forms seen in traces while rejecting empty or unsupported values.

**Data flow**: It receives a JSON value. A non-empty string is returned unchanged, and a number is converted to text. Other values, including empty strings, return nothing.

**Call relations**: parse_dispatch_terminal_request calls this when reading the write_stdin session_id argument. If it cannot produce an id, the request parser reports that the dispatch payload omitted a usable session id.

*Call graph*: called by 1 (parse_dispatch_terminal_request); 3 external calls (clone, is_empty, to_string).
