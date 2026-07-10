# Core shared protocol and domain types  `stage-18.1`

This stage is the system’s shared vocabulary. It sits behind the scenes and gives the rest of the codebase a common set of names, shapes, and rules for data. Think of it like agreed forms and labels used by many departments, so everyone means the same thing when they talk about a session, a thread, a tool, a plugin, a permission, or an error.

The main protocol crate does most of this work. It defines core IDs like SessionId and ThreadId, trusted path and tool-name values, the big session and event message formats, user input, turn items, approvals, account and auth details, model and config settings, dynamic tool descriptions, memory citations, network-policy reports, shell output decoding, and the central error and sandbox-permission rules. Its crate root gathers these pieces into one import point.

Around that are other shared contract crates. Plugin files define plugin IDs and manifests. Tools files describe tool metadata and discoverable tools. Config, state, thread-store, cloud-tasks, skills, exec-policy, network-proxy, TUI, and core files each contribute small but important shared types. Together, they let startup, runtime, storage, and UI all exchange data safely and consistently.

## Files in this stage

### Protocol crate foundation
These files establish the protocol crate’s shared identifiers, low-level value types, and crate-wide module surface before higher-level schemas build on them.

### `protocol/src/thread_id.rs`

`data_model` · `cross-cutting`

This file is the thread-scoped counterpart to `session_id.rs`. `ThreadId` wraps a `uuid::Uuid` in a dedicated newtype so APIs can distinguish thread identity from other UUID-bearing identifiers at compile time. New IDs are generated with `Uuid::now_v7()`, giving sortable UUIDv7 values. Parsing is centralized in `from_string`, and both borrowed and owned string conversions delegate to that parser.

The type implements `Display`, `Serialize`, and `Deserialize` so it always appears as a plain UUID string in protocol payloads. The serde implementation is explicit rather than derived, which keeps the wire shape stable and ensures invalid UUID strings are rejected with a serde error. `JsonSchema` similarly advertises the type as a string schema, and the `TS` annotation fixes the generated TypeScript type to `string`.

Unlike `SessionId`, this file does not define cross-type conversions except to `String`; those live in the session-ID module. The single test checks the core invariant that `ThreadId::default()` generates a real UUID rather than the nil UUID. Because thread IDs appear throughout the protocol—in events, rollout metadata, collaboration payloads, and session configuration—this small file is active across nearly every subsystem.

#### Function details

##### `ThreadId::new`  (lines 18–22)

```
fn new() -> Self
```

**Purpose**: Generates a fresh thread identifier using a UUIDv7 value.

**Data flow**: Calls `Uuid::now_v7()` → stores it in `ThreadId { uuid }` → returns the new ID.

**Call relations**: Used widely across tests and runtime code whenever a new thread identity is needed. It is also the basis for `Default`.

*Call graph*: called by 465 (collab_resume_begin_maps_to_item_started_resume_agent, collab_resume_end_maps_to_item_completed_resume_agent, ignores_user_message_item_lifecycle_events, preserves_user_message_client_id_from_legacy_event, rebuilds_sleep_item_from_persisted_completion, command_execution_started_helper_emits_once, complete_command_execution_item_emits_declined_once_for_pending_command, guardian_assessment_aborted_emits_completed_review_payload, guardian_assessment_completed_emits_review_payload, guardian_assessment_started_uses_event_turn_id_fallback (+15 more)); 1 external calls (now_v7).


##### `ThreadId::from_string`  (lines 24–28)

```
fn from_string(s: &str) -> Result<Self, uuid::Error>
```

**Purpose**: Parses a textual UUID into a `ThreadId`.

**Data flow**: Takes `&str` → calls `Uuid::parse_str(s)?` → wraps the parsed UUID in `ThreadId` and returns `Result<Self, uuid::Error>`.

**Call relations**: Used by explicit parsing call sites and by the `TryFrom<&str>`/`TryFrom<String>` implementations.

*Call graph*: called by 318 (thread_id, compaction_event_ingests_custom_fact, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit, subagent_thread_started_other_serializes_explicit_parent_thread_id, subagent_thread_started_thread_spawn_serializes_thread_lineage, conversation_id_serializes_as_plain_string, serialize_get_conversation_summary, serialize_server_request, rollback_response_rebuilds_pathless_thread_from_stored_history, source_kind_matches_distinguishes_subagent_variants (+15 more)); 1 external calls (parse_str).


##### `ThreadId::try_from`  (lines 42–44)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: Parses an owned `String` into a `ThreadId` by delegating to `from_string`.

**Data flow**: Consumes `String` → borrows it as `&str` → calls `Self::from_string(...)` → returns the parse result.

**Call relations**: Provides ergonomic conversion from owned strings in adapters and tests.

*Call graph*: called by 10 (reconstructs_collab_spawn_end_item_with_model_metadata, reconstructs_interrupted_send_input_as_completed_collab_call, test_model_client_session, fixed_thread_id, try_from, try_from, get_phase2_input_selection, stage1_output_from_row_if_thread_enabled, generic_url_target, suggestion_target); 1 external calls (from_string).


##### `String::from`  (lines 48–50)

```
fn from(value: ThreadId) -> Self
```

**Purpose**: Converts a `ThreadId` into its canonical UUID string form.

**Data flow**: Consumes `ThreadId` → calls `to_string()` via `Display` → returns the resulting `String`.

**Call relations**: Complements the parsing conversions so thread IDs round-trip through stringly typed interfaces.

*Call graph*: 1 external calls (to_string).


##### `ThreadId::default`  (lines 54–56)

```
fn default() -> Self
```

**Purpose**: Provides a default thread ID by generating a fresh one.

**Data flow**: Calls `Self::new()` → returns the new `ThreadId`.

**Call relations**: Used by generic defaulting and tests that need placeholder thread IDs.

*Call graph*: called by 59 (app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears, record_initial_history_reconstructs_typed_inter_agent_message, record_initial_history_resumed_aborted_turn_without_id_clears_active_turn_for_compaction_accounting, record_initial_history_resumed_bare_turn_context_does_not_hydrate_previous_turn_settings, record_initial_history_resumed_bare_turn_context_does_not_seed_reference_context_item, record_initial_history_resumed_does_not_seed_reference_context_item_after_compaction, record_initial_history_resumed_hydrates_previous_turn_settings_from_lifecycle_turn_with_missing_turn_context_id, record_initial_history_resumed_replaced_incomplete_compacted_turn_clears_reference_context_item, record_initial_history_resumed_rollback_drops_incomplete_user_turn_compaction_metadata, record_initial_history_resumed_rollback_skips_only_user_turns (+15 more)); 1 external calls (new).


##### `ThreadId::fmt`  (lines 60–62)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats the thread ID as its UUID string.

**Data flow**: Delegates formatting to the inner `Uuid` via `Display::fmt(&self.uuid, f)`.

**Call relations**: Backs `to_string()`, string conversions, and serde serialization.

*Call graph*: 1 external calls (fmt).


##### `ThreadId::serialize`  (lines 66–71)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes the thread ID as a JSON string.

**Data flow**: Passes the inner UUID to `serializer.collect_str(&self.uuid)` → returns the serializer result.

**Call relations**: Invoked automatically by serde whenever `ThreadId` appears in protocol payloads.

*Call graph*: 1 external calls (collect_str).


##### `ThreadId::deserialize`  (lines 75–82)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes a thread ID from a JSON string containing a UUID.

**Data flow**: Deserializes a `String`, parses it with `Uuid::parse_str`, maps parse failures into serde errors, wraps the UUID in `ThreadId`, and returns it.

**Call relations**: Invoked automatically by serde when reading protocol payloads containing thread IDs.

*Call graph*: 2 external calls (deserialize, parse_str).


##### `ThreadId::schema_name`  (lines 86–88)

```
fn schema_name() -> String
```

**Purpose**: Provides the schema type name used by `schemars` for this newtype.

**Data flow**: Returns the owned string `"ThreadId"`.

**Call relations**: Used during JSON Schema generation.


##### `ThreadId::json_schema`  (lines 90–92)

```
fn json_schema(generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Advertises `ThreadId` as having the same JSON Schema shape as a plain string.

**Data flow**: Delegates to `<String>::json_schema(generator)` and returns that schema.

**Call relations**: Used by schema generation so clients see thread IDs as strings.

*Call graph*: 1 external calls (json_schema).


##### `tests::test_thread_id_default_is_not_zeroes`  (lines 99–102)

```
fn test_thread_id_default_is_not_zeroes()
```

**Purpose**: Verifies that `ThreadId::default()` generates a non-nil UUID.

**Data flow**: Creates `ThreadId::default()` and asserts its inner UUID is not `Uuid::nil()`.

**Call relations**: Tests the default/new ID generation invariant.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_ne!).


### `protocol/src/session_id.rs`

`data_model` · `cross-cutting`

This file wraps a `uuid::Uuid` in a dedicated `SessionId` newtype so session identifiers are type-safe in Rust while still serializing as ordinary strings in JSON and TypeScript. New IDs are generated with `Uuid::now_v7()`, so they are time-ordered UUIDv7 values rather than random UUIDv4 values. Parsing is centralized in `from_string`, and both `TryFrom<&str>` and `TryFrom<String>` delegate to it.

The type is intentionally interoperable with `ThreadId`: there are direct `From<ThreadId> for SessionId` and `From<SessionId> for ThreadId` conversions that simply reuse the same underlying UUID. That reflects a protocol design where session and thread IDs can share the same wire value in some contexts while still being distinct Rust types.

Serialization and deserialization are custom but simple: serde always emits a string and parses from a string, rejecting invalid UUID text. `JsonSchema` also advertises the type as a string schema, and `TS` generation is pinned to `string`. The tests focus on two invariants: default-generated IDs are not the nil UUID, and conversion to/from `ThreadId` preserves the exact UUID.

#### Function details

##### `SessionId::new`  (lines 20–24)

```
fn new() -> Self
```

**Purpose**: Generates a fresh session identifier using a UUIDv7 timestamp-ordered UUID.

**Data flow**: Calls `Uuid::now_v7()` → stores the result in `SessionId { uuid }` → returns the new ID.

**Call relations**: Used by session-creation and test setup paths whenever a new session identity is needed. It is also the basis for `Default`.

*Call graph*: called by 5 (websocket_harness_with_provider_options, config_summary_entries_include_runtime_workspace_roots, test_send_event_as_notification, test_send_event_as_notification_with_meta, test_send_event_as_notification_with_meta_and_thread_id); 1 external calls (now_v7).


##### `SessionId::from_string`  (lines 26–30)

```
fn from_string(s: &str) -> Result<Self, uuid::Error>
```

**Purpose**: Parses a textual UUID into a `SessionId`.

**Data flow**: Takes `&str` → calls `Uuid::parse_str(s)?` → wraps the parsed UUID in `SessionId` and returns `Result<Self, uuid::Error>`.

**Call relations**: Used by explicit parsing call sites and by the `TryFrom<&str>`/`TryFrom<String>` implementations.

*Call graph*: called by 2 (session_configured_from_thread_response, serialize_event); 1 external calls (parse_str).


##### `SessionId::try_from`  (lines 44–46)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: Parses an owned `String` into a `SessionId` by delegating to `from_string`.

**Data flow**: Consumes `String` → borrows it as `&str` → calls `Self::from_string(...)` → returns the parse result.

**Call relations**: Provides ergonomic conversion from owned strings in adapters and tests.

*Call graph*: 1 external calls (from_string).


##### `String::from`  (lines 50–52)

```
fn from(value: SessionId) -> Self
```

**Purpose**: Converts a `SessionId` into its canonical UUID string form.

**Data flow**: Consumes `SessionId` → calls `to_string()` via `Display` → returns the resulting `String`.

**Call relations**: Complements the parsing conversions so session IDs round-trip through stringly typed interfaces.

*Call graph*: 1 external calls (to_string).


##### `SessionId::from`  (lines 56–58)

```
fn from(value: ThreadId) -> Self
```

**Purpose**: Converts a `ThreadId` into a `SessionId` by reusing the same underlying UUID.

**Data flow**: Consumes `ThreadId` → copies `value.uuid` into `SessionId { uuid }` → returns it.

**Call relations**: Used where thread and session identity are intentionally aligned but the Rust type must change.

*Call graph*: called by 8 (new, emit_subagent_session_started_includes_fork_lineage_from_session_configuration, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, resumed_subagent_session_keeps_inherited_session_id, session_configured_produces_thread_started_event, stream_stage_one_prompt, converts_to_and_from_thread_id).


##### `ThreadId::from`  (lines 62–64)

```
fn from(value: SessionId) -> Self
```

**Purpose**: Converts a `SessionId` into a `ThreadId` by reusing the same underlying UUID.

**Data flow**: Consumes `SessionId` → copies `value.uuid` into `ThreadId { uuid }` → returns it.

**Call relations**: Complements `From<ThreadId> for SessionId` for bidirectional conversion.


##### `SessionId::default`  (lines 68–70)

```
fn default() -> Self
```

**Purpose**: Provides a default session ID by generating a fresh one.

**Data flow**: Calls `Self::new()` → returns the new `SessionId`.

**Call relations**: Used by generic defaulting and tested to ensure it does not produce the nil UUID.

*Call graph*: called by 1 (test_session_id_default_is_not_zeroes); 1 external calls (new).


##### `SessionId::fmt`  (lines 74–76)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats the session ID as its UUID string.

**Data flow**: Delegates formatting to the inner `Uuid` via `Display::fmt(&self.uuid, f)`.

**Call relations**: Backs `to_string()`, string conversions, and serde serialization.

*Call graph*: 1 external calls (fmt).


##### `SessionId::serialize`  (lines 80–85)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes the session ID as a JSON string.

**Data flow**: Passes the inner UUID to `serializer.collect_str(&self.uuid)` → returns the serializer result.

**Call relations**: Invoked automatically by serde whenever `SessionId` appears in protocol payloads.

*Call graph*: 1 external calls (collect_str).


##### `SessionId::deserialize`  (lines 89–96)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes a session ID from a JSON string containing a UUID.

**Data flow**: Deserializes a `String`, parses it with `Uuid::parse_str`, maps parse failures into serde errors, wraps the UUID in `SessionId`, and returns it.

**Call relations**: Invoked automatically by serde when reading protocol payloads containing session IDs.

*Call graph*: 2 external calls (deserialize, parse_str).


##### `SessionId::schema_name`  (lines 100–102)

```
fn schema_name() -> String
```

**Purpose**: Provides the schema type name used by `schemars` for this newtype.

**Data flow**: Returns the owned string `"SessionId"`.

**Call relations**: Used during JSON Schema generation.


##### `SessionId::json_schema`  (lines 104–106)

```
fn json_schema(generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Advertises `SessionId` as having the same JSON Schema shape as a plain string.

**Data flow**: Delegates to `<String>::json_schema(generator)` and returns that schema.

**Call relations**: Used by schema generation so clients see session IDs as strings.

*Call graph*: 1 external calls (json_schema).


##### `tests::test_session_id_default_is_not_zeroes`  (lines 114–117)

```
fn test_session_id_default_is_not_zeroes()
```

**Purpose**: Verifies that `SessionId::default()` generates a non-nil UUID.

**Data flow**: Creates `SessionId::default()` and asserts its inner UUID is not `Uuid::nil()`.

**Call relations**: Tests the default/new ID generation invariant.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_ne!).


##### `tests::converts_to_and_from_thread_id`  (lines 120–125)

```
fn converts_to_and_from_thread_id()
```

**Purpose**: Verifies that converting between `ThreadId` and `SessionId` preserves the exact identifier value.

**Data flow**: Creates a new `ThreadId`, converts it to `SessionId`, converts back to `ThreadId`, and asserts equality with the original.

**Call relations**: Tests the bidirectional conversion bridge between the two ID types.

*Call graph*: calls 2 internal fn (from, new); 1 external calls (assert_eq!).


### `protocol/src/agent_path.rs`

`data_model` · `cross-cutting`

This file wraps a `String` in the `AgentPath` newtype and enforces a narrow path grammar at construction time. Valid absolute paths must either be exactly `/morpheus` or begin with `/root`; non-root segments must be lowercase ASCII identifiers containing only letters, digits, or underscores. Reserved names are rejected: `root` cannot appear as a child segment, and `.` / `..` are forbidden everywhere. Trailing slashes are also invalid.

The type exposes canonical constructors for the two special roots, string accessors, and convenience operations for deriving descendants. `join` appends a single validated child name to an existing absolute path. `resolve` accepts either an absolute reference, the literal root path, or a validated slash-separated relative reference and returns a new absolute `AgentPath`; it explicitly rejects empty references and path traversal-like inputs. The `name` method returns the last segment, but normalizes `/root` to `root` rather than an empty string.

Several trait impls make the type ergonomic at API boundaries: `TryFrom<String>`, `TryFrom<&str>`, `FromStr`, `From<AgentPath> for String`, `AsRef<str>`, `Deref<Target = str>`, and `Display`. Serde and schema annotations serialize it as a plain string while still routing deserialization through validation. The tests focus on the special roots, child joining, mixed absolute/relative resolution, and representative validation failures.

#### Function details

##### `AgentPath::root`  (lines 22–24)

```
fn root() -> Self
```

**Purpose**: Constructs the canonical root agent path `/root` without parsing input.

**Data flow**: It reads the `ROOT` constant, allocates a `String` copy, wraps it in `AgentPath`, and returns the new value. It does not inspect external state or perform validation because the constant is already trusted.

**Call relations**: This is the standard constructor used throughout agent-management flows whenever code needs the hierarchy root as a starting point, including listing, subtree traversal, completion routing, and message queue setup.

*Call graph*: called by 38 (list_agents, encrypted_inter_agent_communication_clears_existing_last_task_message, ensure_v2_agent_loaded_reloads_registered_unloaded_agent, list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants, multi_agent_v2_completion_ignores_dead_direct_parent, multi_agent_v2_completion_queues_message_for_direct_parent, resume_agent_from_rollout_does_not_reopen_v2_descendants, send_inter_agent_communication_without_turn_queues_message_without_triggering_turn, spawn_agent_can_fork_parent_thread_history_with_sanitized_items, spawn_agent_fork_last_n_turns_keeps_only_recent_turns (+15 more)).


##### `AgentPath::morpheus`  (lines 26–28)

```
fn morpheus() -> Self
```

**Purpose**: Constructs the special absolute path `/morpheus`.

**Data flow**: It clones the `MORPHEUS` constant into a `String`, wraps it in `AgentPath`, and returns it. No validation is needed because the constant is predefined.

**Call relations**: It is mainly a convenience constructor for code and tests that need the reserved Morpheus path; in the provided graph it is exercised directly by the unit test for expected naming behavior.

*Call graph*: called by 1 (morpheus_has_expected_name).


##### `AgentPath::from_string`  (lines 30–33)

```
fn from_string(path: String) -> Result<Self, String>
```

**Purpose**: Validates an owned string as an absolute agent path and converts it into an `AgentPath`.

**Data flow**: It takes an input `String`, passes `&str` view to `validate_absolute_path`, and on success returns `Ok(AgentPath(path))`; on failure it propagates the validation error string unchanged. No mutation occurs beyond consuming the input string into the wrapper.

**Call relations**: This is the central checked constructor behind parsing and conversion paths. Higher-level code reaches it directly when restoring or filtering stored paths, and indirectly through `TryFrom` and `FromStr` implementations.

*Call graph*: calls 1 internal fn (validate_absolute_path); called by 2 (resume_thread_subagent_restores_stored_nickname_and_role, multi_agent_v2_list_agents_filters_by_relative_path_prefix).


##### `AgentPath::as_str`  (lines 35–37)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the underlying path as a borrowed string slice.

**Data flow**: It reads the inner `String` field and returns `&str` pointing into it. It performs no transformation or allocation.

**Call relations**: This is the primitive accessor used by formatting, deref/as-ref adapters, root checks, name extraction, and external code that needs the raw path text for IDs or bookkeeping.

*Call graph*: called by 8 (agent_id_for_path, release_reserved_agent_path, forward_child_completion_to_parent, as_ref, deref, fmt, is_root, name).


##### `AgentPath::is_root`  (lines 39–41)

```
fn is_root(&self) -> bool
```

**Purpose**: Checks whether this path is exactly the canonical `/root` path.

**Data flow**: It reads the current path via `as_str`, compares it to the `ROOT` constant, and returns a boolean. No state is changed.

**Call relations**: It is used internally by `name` to special-case the root segment and by prefix-matching logic elsewhere that needs to distinguish the hierarchy root from ordinary descendants.

*Call graph*: calls 1 internal fn (as_str); called by 2 (agent_matches_prefix, name).


##### `AgentPath::name`  (lines 43–52)

```
fn name(&self) -> &str
```

**Purpose**: Extracts the final path segment, with `/root` normalized to `root`.

**Data flow**: It first checks `is_root`; if true it returns the `ROOT_SEGMENT` constant. Otherwise it reads the path string, splits from the right on `'/'`, takes the first non-empty trailing segment, and falls back to `ROOT_SEGMENT` if splitting somehow yields nothing.

**Call relations**: This is a pure accessor used where UI or logic needs the local agent name rather than the full absolute path. Its root special-case avoids exposing an empty segment for `/root`.

*Call graph*: calls 2 internal fn (as_str, is_root).


##### `AgentPath::join`  (lines 54–57)

```
fn join(&self, agent_name: &str) -> Result<Self, String>
```

**Purpose**: Builds a child agent path by appending one validated agent name to the current absolute path.

**Data flow**: It takes `&self` and `agent_name`, validates the child name with `validate_agent_name`, formats `"{self}/{agent_name}"` using `Display` on `self`, then re-validates the resulting absolute path through `from_string`. It returns either the new `AgentPath` or the first validation error encountered.

**Call relations**: This is the safe path-construction helper for creating descendants under an existing agent. It delegates segment validation first to produce precise child-name errors, then relies on full-path validation for the final invariant.

*Call graph*: calls 1 internal fn (validate_agent_name); 2 external calls (from_string, format!).


##### `AgentPath::resolve`  (lines 59–72)

```
fn resolve(&self, reference: &str) -> Result<Self, String>
```

**Purpose**: Resolves a user-supplied path reference against the current path, supporting absolute references, the literal root path, and validated relative references.

**Data flow**: It takes `&self` and a `reference` string. Empty input returns an error immediately. The exact string `/root` returns `AgentPath::root()`. References beginning with `/` are parsed as absolute via `TryFrom<&str>`. Otherwise it validates the slash-separated relative reference with `validate_relative_reference`, concatenates `"{self}/{reference}"`, and constructs a validated absolute `AgentPath` with `from_string`.

**Call relations**: This is the higher-level path resolver used when callers may provide either absolute or relative agent references. It delegates to the absolute and relative validators to reject traversal-like or malformed inputs before producing a canonical absolute path.

*Call graph*: calls 1 internal fn (validate_relative_reference); 4 external calls (from_string, root, try_from, format!).


##### `AgentPath::try_from`  (lines 86–88)

```
fn try_from(value: &str) -> Result<Self, Self::Error>
```

**Purpose**: Implements checked conversion from an owned string into `AgentPath`.

**Data flow**: It consumes a `String`, forwards it to `from_string`, and returns the same `Result<Self, String>`. No additional logic is added.

**Call relations**: This conversion is the main parsing entrypoint used across the codebase when raw path strings arrive from storage, protocol payloads, or tests. It exists to integrate `AgentPath` with standard conversion APIs while preserving validation.

*Call graph*: called by 29 (interrupted_subagent_activity_removes_missing_thread_watch, encrypted_inter_agent_communication_clears_existing_last_task_message, ensure_v2_agent_loaded_reloads_registered_unloaded_agent, send_inter_agent_communication_without_turn_queues_message_without_triggering_turn, spawn_agent_can_fork_parent_thread_history_with_sanitized_items, spawn_agent_fork_last_n_turns_keeps_only_recent_turns, agent_path, input_queue_drains_mailbox_in_delivery_order, input_queue_notifies_mailbox_subscribers, input_queue_tracks_pending_trigger_turn_mail (+15 more)); 1 external calls (from_string).


##### `String::from`  (lines 92–94)

```
fn from(value: AgentPath) -> Self
```

**Purpose**: Converts an `AgentPath` back into its owned underlying string.

**Data flow**: It consumes the `AgentPath` value and returns its inner `String` field by move, with no copying or validation.

**Call relations**: This supports serialization-style or API-boundary code that needs to take ownership of the raw path text after working with the validated wrapper.


##### `AgentPath::from_str`  (lines 100–102)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Implements `FromStr` parsing for `AgentPath` from a borrowed string slice.

**Data flow**: It accepts `&str`, forwards to `TryFrom<&str>`, and returns the resulting `Result<AgentPath, String>`. The borrowed input is copied into an owned string by the downstream conversion path.

**Call relations**: This enables idiomatic string parsing APIs and serde-like consumers that rely on `FromStr`; it is a thin adapter over the same validation logic used elsewhere.

*Call graph*: 1 external calls (try_from).


##### `AgentPath::as_ref`  (lines 106–108)

```
fn as_ref(&self) -> &str
```

**Purpose**: Exposes `AgentPath` as `&str` for generic APIs expecting `AsRef<str>`.

**Data flow**: It reads the inner string through `as_str` and returns the borrowed slice. No allocation or mutation occurs.

**Call relations**: This trait adapter lets `AgentPath` participate in generic string-taking code without explicit conversion, and internally just reuses the canonical accessor.

*Call graph*: calls 1 internal fn (as_str).


##### `AgentPath::deref`  (lines 114–116)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Allows `AgentPath` to be dereferenced as `str`.

**Data flow**: It returns the same borrowed `&str` as `as_str`, exposing the inner path text through `Deref<Target = str>`.

**Call relations**: This is an ergonomic adapter so callers can use string methods on `AgentPath` references directly; it delegates to the same underlying accessor used by other trait impls.

*Call graph*: calls 1 internal fn (as_str).


##### `AgentPath::fmt`  (lines 120–122)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats an `AgentPath` as its raw path string.

**Data flow**: It reads the path via `as_str` and writes it into the provided formatter with `write_str`, returning the formatter result.

**Call relations**: This powers user-facing formatting and also supports internal `format!` calls such as path concatenation in `join` and `resolve`.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `validate_agent_name`  (lines 125–147)

```
fn validate_agent_name(agent_name: &str) -> Result<(), String>
```

**Purpose**: Checks that a single path segment is a legal agent name under the path grammar.

**Data flow**: It inspects the input `&str` and returns `Err(String)` for empty names, the reserved `root` segment, the reserved `.` and `..` names, any embedded slash, or any character outside lowercase ASCII letters, digits, and underscore. Otherwise it returns `Ok(())`.

**Call relations**: This is the shared low-level validator used by `join`, absolute-path validation, and relative-reference validation so all segment checks stay consistent.

*Call graph*: called by 3 (join, validate_absolute_path, validate_relative_reference); 1 external calls (format!).


##### `validate_absolute_path`  (lines 149–171)

```
fn validate_absolute_path(path: &str) -> Result<(), String>
```

**Purpose**: Validates the full syntax of an absolute agent path string.

**Data flow**: It accepts `&str`. The exact `/morpheus` path is accepted immediately. Otherwise it requires a leading slash, splits off the first segment, requires that segment to be `root`, rejects empty paths and trailing slashes, then validates each remaining segment with `validate_agent_name`. It returns `Ok(())` on success or a descriptive error string on the first failure.

**Call relations**: This is the core invariant checker behind all `AgentPath` construction from raw strings. `from_string` delegates to it so every parsed absolute path obeys the same root and segment rules.

*Call graph*: calls 1 internal fn (validate_agent_name); called by 1 (from_string).


##### `validate_relative_reference`  (lines 173–181)

```
fn validate_relative_reference(reference: &str) -> Result<(), String>
```

**Purpose**: Validates a slash-separated relative path reference before it is resolved against an existing absolute path.

**Data flow**: It takes `&str`, rejects references ending with `/`, splits on `'/'`, and validates each segment with `validate_agent_name`. It returns `Ok(())` if every segment is legal.

**Call relations**: This is used only by `resolve` for non-absolute references, ensuring relative inputs cannot smuggle reserved names or malformed segments into the resulting absolute path.

*Call graph*: calls 1 internal fn (validate_agent_name); called by 1 (resolve).


##### `tests::root_has_expected_name`  (lines 189–194)

```
fn root_has_expected_name()
```

**Purpose**: Verifies that the root constructor yields `/root`, reports the name `root`, and is recognized as root.

**Data flow**: It constructs `AgentPath::root()`, reads its string and derived name, checks `is_root()`, and asserts the expected values.

**Call relations**: This test exercises the root-specific branches in `root`, `as_str`, `name`, and `is_root`.

*Call graph*: calls 1 internal fn (root); 2 external calls (assert!, assert_eq!).


##### `tests::morpheus_has_expected_name`  (lines 197–202)

```
fn morpheus_has_expected_name()
```

**Purpose**: Verifies that the Morpheus constructor yields `/morpheus`, reports the final segment `morpheus`, and is not treated as root.

**Data flow**: It constructs `AgentPath::morpheus()`, reads its string and name, checks `is_root()`, and asserts the expected values.

**Call relations**: This test covers the special non-root absolute path accepted by validation and confirms `name` falls back to last-segment extraction for it.

*Call graph*: calls 1 internal fn (morpheus); 2 external calls (assert!, assert_eq!).


##### `tests::join_builds_child_paths`  (lines 205–210)

```
fn join_builds_child_paths()
```

**Purpose**: Checks that joining a valid child name under root produces the expected descendant path.

**Data flow**: It creates the root path, calls `join("researcher")`, unwraps the result, then asserts both the full path string and the derived child name.

**Call relations**: This test exercises the happy path through `join`, including child-name validation and final absolute-path reconstruction.

*Call graph*: calls 1 internal fn (root); 1 external calls (assert_eq!).


##### `tests::resolve_supports_relative_and_absolute_references`  (lines 213–223)

```
fn resolve_supports_relative_and_absolute_references()
```

**Purpose**: Confirms that `resolve` accepts both relative child references and absolute replacement paths.

**Data flow**: It parses a current path from `"/root/researcher"`, resolves `"worker"` and `"/root/other"`, parses the expected absolute results, and compares them for equality.

**Call relations**: This test covers the two main non-error branches in `resolve`: relative concatenation and absolute passthrough parsing.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (assert_eq!).


##### `tests::invalid_names_and_paths_are_rejected`  (lines 226–239)

```
fn invalid_names_and_paths_are_rejected()
```

**Purpose**: Checks representative validation failures for bad child names, invalid absolute roots, and forbidden relative traversal syntax.

**Data flow**: It calls `join` with an uppercase name, parses an absolute path not rooted at `/root`, and resolves a relative reference containing `..`; each result is compared against the exact expected error string.

**Call relations**: This test locks down the user-visible validation messages emitted by `validate_agent_name`, `validate_absolute_path`, and `resolve`'s relative-reference path.

*Call graph*: 1 external calls (assert_eq!).


### `protocol/src/tool_name.rs`

`data_model` · `cross-cutting`

This file packages tool identifiers into a structured type instead of passing raw strings everywhere. `ToolName` stores the local `name` plus an optional `namespace`, which is important for MCP and other namespaced tool ecosystems where the model may refer to tools with a prefix. The constructors make the intended shape explicit: `new` accepts an optional namespace, `plain` creates an unnamespaced tool, and `namespaced` requires both parts.

The `Display` implementation concatenates namespace and name directly when a namespace exists, and otherwise prints just the name. That means the namespace string is expected to already contain any separator convention the caller wants preserved. Ordering is also customized: namespaced tools compare as `(namespace, Some(name))`, while plain tools compare as `(name, None)`. This gives a deterministic sort order that groups namespaced tools by namespace while still allowing plain tools to participate in the same ordering relation.

The `From<String>` and `From<&str>` impls intentionally treat bare strings as plain tool names, not as pre-parsed namespaced identifiers. This keeps parsing policy out of the type and leaves namespace splitting to higher-level code that knows the relevant naming conventions.

#### Function details

##### `ToolName::new`  (lines 15–20)

```
fn new(namespace: Option<String>, name: impl Into<String>) -> Self
```

**Purpose**: Constructs a `ToolName` from an optional namespace and a name value convertible into `String`.

**Data flow**: Takes `namespace: Option<String>` and `name: impl Into<String>` → converts `name` into an owned string → stores both fields in `ToolName` → returns it.

**Call relations**: Used by callers that already have an optional namespace and want to preserve that split explicitly.

*Call graph*: called by 2 (from_parts, build_tool_call); 1 external calls (into).


##### `ToolName::plain`  (lines 22–27)

```
fn plain(name: impl Into<String>) -> Self
```

**Purpose**: Constructs an unnamespaced tool name.

**Data flow**: Takes `name: impl Into<String>` → converts it into an owned string → returns `ToolName { name, namespace: None }`.

**Call relations**: Used widely for built-in or otherwise unqualified tool names, and by the `From<String>`/`From<&str>` conversions.

*Call graph*: called by 73 (augment_tool_definition_appends_typed_declaration, augment_tool_definition_includes_property_descriptions_as_comments, code_mode_only_description_includes_nested_tools, blocking_tool, danger_full_access_tool_attempts_do_not_enforce_managed_network, guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip, rejects_escalated_permissions_when_policy_not_on_request (+15 more)); 1 external calls (into).


##### `ToolName::namespaced`  (lines 29–34)

```
fn namespaced(namespace: impl Into<String>, name: impl Into<String>) -> Self
```

**Purpose**: Constructs a namespaced tool name from separate namespace and local-name values.

**Data flow**: Takes `namespace: impl Into<String>` and `name: impl Into<String>` → converts both into owned strings → returns `ToolName { name, namespace: Some(namespace) }`.

**Call relations**: Used by code that canonicalizes MCP or other prefixed tool identifiers into structured form.

*Call graph*: called by 32 (code_mode_only_description_groups_namespace_instructions_once, code_mode_only_description_omits_empty_namespace_sections, code_mode_only_description_renders_shared_mcp_types_once, canonical_tool_name, tool_name, image_generation_publication_is_finalized_by_core, mcp_post_tool_use_payload_uses_prefixed_tool_name_args_and_result, mcp_updated_input_rewrites_builtin_like_tool_names_as_mcp, tool_name, tool_name (+15 more)); 1 external calls (into).


##### `ToolName::fmt`  (lines 38–43)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a tool name for display by concatenating namespace and local name when a namespace exists, or printing only the local name otherwise.

**Data flow**: Reads `self.namespace` and `self.name` → if namespace is `Some`, writes `"{namespace}{name}"`; otherwise writes `name` alone.

**Call relations**: Used by `to_string()` and any display/logging surface that needs a single textual tool identifier.

*Call graph*: 2 external calls (write_str, write!).


##### `ToolName::cmp`  (lines 47–57)

```
fn cmp(&self, other: &Self) -> Ordering
```

**Purpose**: Defines total ordering for tool names, grouping namespaced tools by namespace and then name while treating plain tools as `(name, None)` tuples.

**Data flow**: Reads `self` and `other` → converts each into a comparison tuple of either `(namespace.as_str(), Some(name.as_str()))` or `(name.as_str(), None)` → compares the tuples and returns the resulting `Ordering`.

**Call relations**: Used by `PartialOrd::partial_cmp` and any sorted collections relying on `Ord`.

*Call graph*: called by 1 (partial_cmp).


##### `ToolName::partial_cmp`  (lines 61–63)

```
fn partial_cmp(&self, other: &Self) -> Option<Ordering>
```

**Purpose**: Implements partial ordering by delegating to the total `Ord` implementation.

**Data flow**: Takes `&self` and `&other` → calls `self.cmp(other)` → wraps the result in `Some(...)`.

**Call relations**: Provides the standard `PartialOrd` companion to `Ord`.

*Call graph*: calls 1 internal fn (cmp).


##### `ToolName::from`  (lines 73–75)

```
fn from(name: &str) -> Self
```

**Purpose**: Converts a bare owned string into an unnamespaced `ToolName`.

**Data flow**: Consumes `String` → calls `ToolName::plain(name)` → returns the resulting `ToolName`.

**Call relations**: Used by generic conversions where a raw string should be interpreted as a plain tool name.

*Call graph*: 1 external calls (plain).


### `protocol/src/exec_output.rs`

`util` · `request handling`

This file defines two lightweight output containers and the decoding pipeline used to turn raw process bytes into displayable text. `StreamOutput<T>` stores a payload plus an optional `truncated_after_lines` marker; the `String` specialization has a simple constructor, while the `Vec<u8>` specialization can decode itself into `StreamOutput<String>`. `ExecToolCallOutput` aggregates exit code, decoded stdout/stderr, aggregated output, duration, and timeout status, with a `Default` implementation that produces an all-empty successful result.

The decoding logic is intentionally more sophisticated than `String::from_utf8_lossy`. `bytes_to_string_smart` first returns early for empty input, then accepts valid UTF-8 unchanged. For invalid UTF-8, it asks `detect_encoding` to guess an encoding using `chardetng`, then decodes with `encoding_rs`. If the chosen decoder reports errors, `decode_bytes` falls back to lossy UTF-8 so callers always receive a string.

A notable design choice is the IBM866-versus-Windows-1252 heuristic. Some Windows shell snippets containing only “smart punctuation” bytes in the 0x80–0x9F range plus ASCII words are misidentified as IBM866, which turns punctuation into Cyrillic garbage. `detect_encoding` corrects that specific case by switching to `WINDOWS_1252` only when `looks_like_windows_1252_punctuation` confirms that all extended bytes are from a small allowlist of punctuation values and the text also contains ASCII letters. This narrow heuristic avoids corrupting legitimate CP866 Cyrillic output while fixing a common VS Code shell-output failure mode.

#### Function details

##### `StreamOutput::new`  (lines 22–27)

```
fn new(text: String) -> Self
```

**Purpose**: Constructs a text stream output with no truncation marker.

**Data flow**: It takes an owned `String`, stores it in `StreamOutput { text, truncated_after_lines: None }`, and returns the new value.

**Call relations**: This is the standard constructor used throughout command-execution and test code when building decoded stdout, stderr, or aggregated output values.

*Call graph*: called by 15 (make_exec_output, includes_timed_out_message, execute_user_shell_command, run, map_exec_result, emit_exec_end_for_unified_exec, emit_failed_exec_end_for_unified_exec, check_for_sandbox_denial_with_text, formats_basic_record, uses_aggregated_output_over_streams (+5 more)).


##### `StreamOutput::from_utf8_lossy`  (lines 31–36)

```
fn from_utf8_lossy(&self) -> StreamOutput<String>
```

**Purpose**: Converts a byte-oriented stream output into a string-oriented one using the smart decoding pipeline.

**Data flow**: It reads `self.text` as `&[u8]`, passes it to `bytes_to_string_smart`, copies over `self.truncated_after_lines`, and returns a new `StreamOutput<String>`.

**Call relations**: Byte-collecting process-output code uses this to transform captured raw bytes into decoded text while preserving truncation metadata.

*Call graph*: calls 1 internal fn (bytes_to_string_smart).


##### `ExecToolCallOutput::default`  (lines 50–59)

```
fn default() -> Self
```

**Purpose**: Constructs an empty successful execution result with zero duration and no timeout.

**Data flow**: It returns `ExecToolCallOutput` with `exit_code: 0`, empty `stdout`, `stderr`, and `aggregated_output` created via `StreamOutput::new(String::new())`, `duration: Duration::ZERO`, and `timed_out: false`.

**Call relations**: This default is used where callers need a placeholder or baseline execution result before filling in actual process output.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `bytes_to_string_smart`  (lines 63–74)

```
fn bytes_to_string_smart(bytes: &[u8]) -> String
```

**Purpose**: Decodes arbitrary bytes into a string using UTF-8 fast paths and best-effort encoding detection for invalid UTF-8.

**Data flow**: It takes `&[u8]`. Empty input returns `String::new()`. Valid UTF-8 is returned as an owned copy. Otherwise it calls `detect_encoding(bytes)` to choose an encoding and then `decode_bytes(bytes, encoding)` to produce the final string.

**Call relations**: Process-output collection code and `StreamOutput<Vec<u8>>::from_utf8_lossy` call this as the central decoding entrypoint.

*Call graph*: calls 2 internal fn (decode_bytes, detect_encoding); called by 3 (spawn_process_output, collect_spawn_process_output, from_utf8_lossy); 2 external calls (new, from_utf8).


##### `detect_encoding`  (lines 97–116)

```
fn detect_encoding(bytes: &[u8]) -> &'static Encoding
```

**Purpose**: Guesses the most likely text encoding for a byte slice and applies a targeted Windows-1252 correction for a known IBM866 misdetection case.

**Data flow**: It creates an `EncodingDetector`, feeds the bytes, and obtains a guessed `Encoding`. If the guess is `IBM866` and `looks_like_windows_1252_punctuation(bytes)` returns true, it returns `WINDOWS_1252`; otherwise it returns the guessed encoding unchanged.

**Call relations**: This helper is only used by `bytes_to_string_smart` and encapsulates the encoding-detection policy, including the special punctuation heuristic.

*Call graph*: calls 1 internal fn (looks_like_windows_1252_punctuation); called by 1 (bytes_to_string_smart); 1 external calls (new).


##### `decode_bytes`  (lines 118–126)

```
fn decode_bytes(bytes: &[u8], encoding: &'static Encoding) -> String
```

**Purpose**: Decodes bytes with a chosen encoding and falls back to lossy UTF-8 if the decoder reports errors.

**Data flow**: It takes `&[u8]` and an `Encoding`, calls `encoding.decode(bytes)`, and if `had_errors` is true returns `String::from_utf8_lossy(bytes).into_owned()`. Otherwise it returns the decoder's owned string.

**Call relations**: This is the final decoding step after `detect_encoding` has selected an encoding.

*Call graph*: called by 1 (bytes_to_string_smart); 2 external calls (decode, from_utf8_lossy).


##### `looks_like_windows_1252_punctuation`  (lines 141–161)

```
fn looks_like_windows_1252_punctuation(bytes: &[u8]) -> bool
```

**Purpose**: Detects the narrow byte-pattern that should be interpreted as Windows-1252 smart punctuation rather than IBM866 Cyrillic.

**Data flow**: It scans the byte slice, immediately returning `false` if any byte is `>= 0xA0`. For bytes in `0x80..=0x9F`, it requires each to satisfy `is_windows_1252_punct`; otherwise it returns `false`. It also tracks whether at least one such punctuation byte and at least one ASCII alphabetic byte were seen, returning `true` only if both conditions hold.

**Call relations**: This predicate is consulted only by `detect_encoding` to decide whether to override an IBM866 guess with Windows-1252.

*Call graph*: calls 1 internal fn (is_windows_1252_punct); called by 1 (detect_encoding).


##### `is_windows_1252_punct`  (lines 163–165)

```
fn is_windows_1252_punct(byte: u8) -> bool
```

**Purpose**: Checks whether a byte is one of the allowlisted Windows-1252 smart-punctuation values involved in the IBM866 collision.

**Data flow**: It tests membership of the input byte in the `WINDOWS_1252_PUNCT_BYTES` constant array and returns the boolean result.

**Call relations**: This is the low-level helper used by `looks_like_windows_1252_punctuation` to keep the punctuation allowlist centralized.

*Call graph*: called by 1 (looks_like_windows_1252_punctuation).


### `protocol/src/lib.rs`

`orchestration` · `cross-cutting`

This file is the top-level module map for the `protocol` crate. Its main job is structural: it declares all protocol-related submodules, including account/auth data, approvals, capabilities, configuration types, dynamic tool definitions, execution output, MCP-facing protocol types, permissions, shell environment data, and user-input/request schemas. A few low-level modules (`agent_path`, `session_id`, `thread_id`, `tool_name`) remain private internally and are selectively re-exported as `AgentPath`, `SessionId`, `ThreadId`, and `ToolName`, which makes those types part of the crate’s public API without exposing their internal module layout.

Because there are no functions or runtime logic here, the important design choice is API curation: this file defines what consumers see as the canonical protocol namespace. Public modules such as `mcp_approval_meta`, `memory_citation`, `parse_command`, `plan_tool`, and `request_user_input` become stable leaf namespaces, while the explicit `pub use` lines elevate a handful of identifier wrappers to crate-root symbols for ergonomic imports. In practice, this file is active whenever another crate compiles against or imports protocol definitions; it is the index that ties together serialization schemas, shared enums/structs, and protocol constants used across the system.


### Core protocol schemas
These files define the main reusable protocol data models for configuration, permissions, content, tools, commands, and account-facing payloads that feed into the top-level session protocol.

### `protocol/src/permissions.rs`

`domain_logic` · `sandbox policy derivation and runtime permission checks`

This file contains the substantive sandbox-permission logic for the protocol layer. It defines `NetworkSandboxPolicy`, `FileSystemAccessMode`, `FileSystemSpecialPath`, `FileSystemPath`, `FileSystemSandboxEntry`, `FileSystemSandboxKind`, and `FileSystemSandboxPolicy`, then builds a large amount of behavior around them. The policy model supports exact paths, symbolic special paths like `Root`, `ProjectRoots`, `Tmpdir`, and `SlashTmp`, plus deny-only glob patterns. Access resolution is specificity-based: resolved entries are compared by path depth and then by access precedence, where `Deny > Write > Read`. Restricted policies can also protect workspace metadata (`.git`, `.agents`, `.codex`) even under writable roots, unless an explicit write entry targets the protected metadata path itself.

A major theme is compatibility. The file can project legacy `SandboxPolicy` values into richer filesystem/network policies, preserve deny-read entries across legacy rebuilds, and attempt to bridge modern policies back into legacy form when representable. It also computes semantic signatures so callers can detect when direct runtime enforcement is required because legacy sandbox runtimes cannot faithfully express the richer policy. `ReadDenyMatcher` is the runtime helper for deny-read checks: it snapshots exact denied roots as both lexical and canonical path candidates, compiles deny globs with fail-closed or error-return behavior, and answers subtree/glob denial queries robustly across symlinks. Numerous helpers normalize paths, expand symbolic workspace-root entries, preserve symlink-visible carveouts, and derive writable roots with read-only subpaths for downstream sandbox backends.

#### Function details

##### `is_protected_metadata_name`  (lines 35–39)

```
fn is_protected_metadata_name(name: &OsStr) -> bool
```

**Purpose**: Returns whether a path basename is one of the protected workspace metadata names: `.git`, `.agents`, or `.codex`. This is the broad metadata-name predicate.

**Data flow**: Borrows an `&OsStr`, iterates `PROTECTED_METADATA_PATH_NAMES`, compares each to the input, and returns `true` on the first match. It mutates nothing.

**Call relations**: Used by callers that need to recognize protected metadata names generically. It is the simplest metadata helper in the file.


##### `is_protected_metadata_directory_name`  (lines 41–44)

```
fn is_protected_metadata_directory_name(name: &OsStr) -> bool
```

**Purpose**: Returns whether a basename is one of the protected metadata directories that are always directories in Codex semantics: `.agents` or `.codex`. `.git` is excluded because it may be a file pointer.

**Data flow**: Borrows an `&OsStr`, compares it to `.agents` and `.codex`, and returns the resulting `bool`. It has no side effects.

**Call relations**: Used by code that specifically cares about protected metadata directories rather than all protected metadata names.

*Call graph*: 1 external calls (new).


##### `forbidden_agent_metadata_write`  (lines 48–77)

```
fn forbidden_agent_metadata_write(
    path: &Path,
    cwd: &Path,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
) -> Option<&'static str>
```

**Purpose**: Determines whether an attempted agent write should be blocked because it targets protected metadata under a writable root without an explicit metadata write grant. It returns the offending metadata name when blocked.

**Data flow**: Accepts a target `path`, `cwd`, and `&FileSystemSandboxPolicy`. It returns `None` immediately unless the policy is restricted. It resolves the candidate path against `cwd`, finds whether the target lies under a writable root’s protected metadata child via `metadata_child_of_writable_root`, checks for an explicit write entry with `has_explicit_write_entry_for_metadata_path`, and if none exists asks `can_write_path_with_cwd`; when that write check fails it returns `Some(metadata_name)`, otherwise `None`.

**Call relations**: Used before execution to reject writes into protected metadata paths. It delegates path resolution and metadata-root detection to lower-level helpers and relies on the policy’s own write-check logic for the final decision.

*Call graph*: calls 4 internal fn (can_write_path_with_cwd, has_explicit_write_entry_for_metadata_path, metadata_child_of_writable_root, resolve_candidate_path); 1 external calls (matches!).


##### `NetworkSandboxPolicy::is_enabled`  (lines 91–93)

```
fn is_enabled(self) -> bool
```

**Purpose**: Returns whether network access is enabled under the policy. Only `Enabled` yields true.

**Data flow**: Consumes `self`, matches it against `NetworkSandboxPolicy::Enabled`, and returns a `bool`. It mutates nothing.

**Call relations**: Used throughout sandbox setup and legacy bridging whenever code needs a simple yes/no network-access answer.

*Call graph*: called by 10 (spawn_debug_sandbox_child, should_install_network_seccomp, bwrap_network_mode, network_access_from_policy, from, to_legacy_sandbox_policy, compatibility_workspace_write_policy, should_require_platform_sandbox, dynamic_network_policy_for_network, should_apply_network_block); 1 external calls (matches!).


##### `FileSystemAccessMode::can_read`  (lines 127–129)

```
fn can_read(self) -> bool
```

**Purpose**: Returns whether an access mode permits reads. Both `Read` and `Write` allow reads; `Deny` does not.

**Data flow**: Consumes `self`, checks that it is not `Deny`, and returns the resulting `bool`. It has no side effects.

**Call relations**: Used by access-comparison and policy-evaluation code whenever read capability matters independently of write capability.

*Call graph*: called by 1 (access_covers); 1 external calls (matches!).


##### `FileSystemAccessMode::can_write`  (lines 131–133)

```
fn can_write(self) -> bool
```

**Purpose**: Returns whether an access mode permits writes. Only `Write` yields true.

**Data flow**: Consumes `self`, matches it against `FileSystemAccessMode::Write`, and returns a `bool`. It mutates nothing.

**Call relations**: Used by policy narrowing, writable-root derivation, and access checks throughout the file.

*Call graph*: called by 1 (access_covers); 1 external calls (matches!).


##### `FileSystemSpecialPath::project_roots`  (lines 167–169)

```
fn project_roots(subpath: Option<PathBuf>) -> Self
```

**Purpose**: Constructs the symbolic special-path token representing workspace/project roots, optionally with a subpath under each root. This is the canonical constructor for that special path.

**Data flow**: Accepts `Option<PathBuf>` and returns `FileSystemSpecialPath::ProjectRoots { subpath }`. It has no side effects.

**Call relations**: Used by workspace-write policy construction and by helpers that append default protected subpaths under project roots.


##### `FileSystemSpecialPath::unknown`  (lines 171–176)

```
fn unknown(path: impl Into<String>, subpath: Option<PathBuf>) -> Self
```

**Purpose**: Constructs a forward-compatible unknown special-path token, preserving its raw path string and optional subpath. Older runtimes can carry these values without understanding them.

**Data flow**: Accepts `path: impl Into<String>` and `Option<PathBuf>`, converts the path into `String`, and returns `FileSystemSpecialPath::Unknown { path, subpath }`.

**Call relations**: Used when deserializing or constructing future special-path tokens that should degrade gracefully rather than failing.

*Call graph*: 1 external calls (into).


##### `FileSystemSandboxEntry::from`  (lines 186–191)

```
fn from(value: FileSystemSandboxEntry<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts a filesystem sandbox entry from absolute-path form to URI form. It preserves access mode and converts the nested path representation.

**Data flow**: Consumes `FileSystemSandboxEntry<AbsolutePathBuf>`, converts `path` with `.into()`, preserves `access`, and returns `FileSystemSandboxEntry<PathUri>`.

**Call relations**: Used when protocol payloads need URI-safe path encoding rather than runtime absolute paths.


##### `FileSystemSandboxEntry::try_from`  (lines 197–202)

```
fn try_from(value: FileSystemSandboxEntry<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts a filesystem sandbox entry from URI form back to absolute-path form, failing if the path URI cannot be resolved. It preserves access mode.

**Data flow**: Consumes `FileSystemSandboxEntry<PathUri>`, converts `path` with `try_into()?`, preserves `access`, and returns `io::Result<FileSystemSandboxEntry<AbsolutePathBuf>>`.

**Call relations**: Used when deserialized protocol entries must become runtime filesystem entries.


##### `ReadDenyMatcher::new`  (lines 257–266)

```
fn new(file_system_sandbox_policy: &FileSystemSandboxPolicy, cwd: &Path) -> Option<Self>
```

**Purpose**: Builds a runtime deny-read matcher from a filesystem policy using fail-closed handling for malformed glob patterns. If the policy has no deny-read restrictions, it returns `None`.

**Data flow**: Borrows a `FileSystemSandboxPolicy` and `cwd`, calls `Self::build(..., InvalidDenyReadGlobBehavior::FailClosed)`, unwraps the impossible error case with `unreachable!`, and returns `Option<ReadDenyMatcher>`.

**Call relations**: Used by direct read-deny checks that must never silently broaden access because of malformed patterns. It is the convenience constructor over `build`.

*Call graph*: called by 1 (is_read_denied); 2 external calls (build, unreachable!).


##### `ReadDenyMatcher::try_new`  (lines 273–282)

```
fn try_new(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
    ) -> Result<Option<Self>, String>
```

**Purpose**: Builds a deny-read matcher but returns an explicit error for malformed glob patterns instead of failing closed. This is intended for host-side expansion work that should reject bad policy input.

**Data flow**: Borrows a `FileSystemSandboxPolicy` and `cwd`, forwards them to `Self::build(..., InvalidDenyReadGlobBehavior::ReturnError)`, and returns `Result<Option<ReadDenyMatcher>, String>`.

**Call relations**: Used by callers that need to surface invalid deny-glob configuration rather than silently treating it as deny-all.

*Call graph*: called by 1 (resolve_windows_deny_read_paths); 1 external calls (build).


##### `ReadDenyMatcher::build`  (lines 284–321)

```
fn build(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
        invalid_glob_behavior: InvalidDenyReadGlobBehavior,
    ) -> Result<Option<Self>, String>
```

**Purpose**: Constructs the internal deny-read matcher state from exact denied roots and deny-read glob patterns. It snapshots exact roots as lexical/canonical candidate sets and compiles glob matchers according to the requested invalid-pattern behavior.

**Data flow**: Borrows a policy and `cwd`, plus an `InvalidDenyReadGlobBehavior`. If the policy has no denied-read restrictions it returns `Ok(None)`. Otherwise it gathers denied roots via `get_unreadable_roots_with_cwd(cwd)`, maps each through `normalized_and_canonical_candidates`, gathers deny globs via `get_unreadable_globs_with_cwd(cwd)`, compiles each with `build_glob_matcher`, either marks `invalid_pattern = true` or returns `Err(...)` on malformed patterns depending on the behavior, and finally returns `Ok(Some(ReadDenyMatcher { denied_candidates, deny_read_matchers, invalid_pattern }))`.

**Call relations**: Called by both public constructors. It is the core builder that translates policy semantics into efficient runtime matcher state.

*Call graph*: calls 4 internal fn (get_unreadable_globs_with_cwd, get_unreadable_roots_with_cwd, has_denied_read_restrictions, build_glob_matcher); 2 external calls (new, format!).


##### `ReadDenyMatcher::is_read_denied`  (lines 324–350)

```
fn is_read_denied(&self, path: &Path) -> bool
```

**Purpose**: Checks whether a path is denied for reading by the matcher’s policy snapshot. It fails closed when the matcher was built with malformed deny patterns under fail-closed mode.

**Data flow**: Borrows `self` and a `&Path`. If `invalid_pattern` is true, it returns `true`. Otherwise it computes lexical/canonical candidates for the input path with `normalized_and_canonical_candidates`, checks whether any candidate equals or is nested under any denied exact-root candidate, and if not checks whether any compiled glob matcher matches any candidate. It returns the resulting `bool`.

**Call relations**: Used by direct tool-read checks and glob-expansion code after a matcher has been built. It depends on the candidate-normalization helper to catch symlink aliases.

*Call graph*: calls 1 internal fn (normalized_and_canonical_candidates); called by 1 (collect_existing_glob_matches).


##### `FileSystemPath::from`  (lines 377–385)

```
fn from(value: FileSystemPath<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts a filesystem path representation from absolute-path form to URI form. Exact paths become `PathUri`; glob and special-path variants are preserved unchanged.

**Data flow**: Consumes `FileSystemPath<AbsolutePathBuf>`, matches on the variant, converts `Path { path }` with `PathUri::from_abs_path(&path)`, and returns the corresponding `FileSystemPath<PathUri>`.

**Call relations**: Used by entry and permission-profile conversions when protocol payloads need URI-safe path encoding.

*Call graph*: calls 1 internal fn (from_abs_path).


##### `FileSystemPath::try_from`  (lines 391–399)

```
fn try_from(value: FileSystemPath<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts a filesystem path representation from URI form back to absolute-path form, failing if an exact path URI cannot be resolved. Glob and special-path variants pass through unchanged.

**Data flow**: Consumes `FileSystemPath<PathUri>`, matches on the variant, converts `Path { path }` with `path.to_abs_path()?`, and returns `io::Result<FileSystemPath<AbsolutePathBuf>>`.

**Call relations**: Used when deserialized protocol path values must become runtime filesystem paths.


##### `project_roots_glob_pattern`  (lines 404–406)

```
fn project_roots_glob_pattern(subpath: &Path) -> String
```

**Purpose**: Encodes a workspace-root-relative glob pattern using the reserved `codex-project-roots://` prefix. This lets symbolic project-root globs survive serialization before concrete roots are known.

**Data flow**: Borrows a `&Path`, formats `PROJECT_ROOTS_GLOB_PATTERN_PREFIX` plus `subpath.display()`, and returns the resulting `String`.

**Call relations**: Used by callers that need to create symbolic deny-glob entries scoped to project roots. Later helpers parse and materialize this prefix.

*Call graph*: called by 1 (compile_scoped_filesystem_pattern); 1 external calls (format!).


##### `read_only_file_system_entries`  (lines 408–415)

```
fn read_only_file_system_entries() -> Vec<FileSystemSandboxEntry>
```

**Purpose**: Returns the canonical entry list for a read-only filesystem policy: a single special-path root entry with `Read` access.

**Data flow**: Takes no inputs and returns `vec![FileSystemSandboxEntry { path: FileSystemPath::Special { value: Root }, access: Read }]`.

**Call relations**: Used by `FileSystemSandboxPolicy::read_only` and nowhere else. It isolates the canonical read-only entry list.

*Call graph*: called by 1 (read_only); 1 external calls (vec!).


##### `FileSystemSandboxPolicy::default`  (lines 418–420)

```
fn default() -> Self
```

**Purpose**: Provides the default filesystem sandbox policy, which is read-only. This is the safest baseline filesystem policy.

**Data flow**: Takes no inputs and returns `Self::read_only()`. It has no side effects.

**Call relations**: Used widely as the default filesystem policy in tests and runtime setup. It delegates to the explicit read-only constructor.

*Call graph*: called by 8 (file_system_sandbox_context_uses_active_attempt, default_exec_approval_requirement_keeps_prompt_when_granular_allows_sandbox_approval, default_exec_approval_requirement_rejects_sandbox_prompt_when_granular_disables_it, extension_tool_receives_turn_environment_sandbox, view_image_tool_applies_local_sandbox_read_denies, default_policy_with_unreadable_glob, default_policy_with_unreadable_glob, unreadable_glob_policy_includes_canonicalized_static_prefix); 1 external calls (read_only).


##### `FileSystemSandboxPolicy::read_only`  (lines 424–426)

```
fn read_only() -> Self
```

**Purpose**: Constructs the canonical restricted read-only filesystem policy. It grants read access to the filesystem root and nothing more.

**Data flow**: Calls `read_only_file_system_entries()` and wraps the result with `Self::restricted(entries)`, returning the new policy.

**Call relations**: Used by defaults and by legacy-policy projection for read-only sandboxing.

*Call graph*: calls 1 internal fn (read_only_file_system_entries); called by 2 (extensible_builtin_parent_profile, read_only); 1 external calls (restricted).


##### `FileSystemSandboxPolicy::unrestricted`  (lines 428–434)

```
fn unrestricted() -> Self
```

**Purpose**: Constructs an unrestricted filesystem policy with no explicit entries. This represents full filesystem access under managed semantics.

**Data flow**: Returns `FileSystemSandboxPolicy { kind: Unrestricted, glob_scan_max_depth: None, entries: Vec::new() }`. It mutates nothing.

**Call relations**: Used by runtime permission projection and tests whenever full filesystem access is needed.

*Call graph*: called by 15 (managed_full_disk_with_restricted_network_reports_external_sandbox, windows_restricted_token_rejects_network_only_restrictions, exec_server_params_use_path_uri_and_env_policy_overlay_contract, full_disk_write_full_network_returns_unwrapped_command, full_disk_write_proxy_only_keeps_full_filesystem_but_unshares_network, managed_proxy_preflight_argv_is_wrapped_for_full_access_policy, to_sandbox_policy, file_system_sandbox_policy, disabled_permission_profile_ignores_runtime_network_policy, permission_profile_from_runtime_permissions_preserves_unrestricted_managed_network (+5 more)); 1 external calls (new).


##### `FileSystemSandboxPolicy::external_sandbox`  (lines 436–442)

```
fn external_sandbox() -> Self
```

**Purpose**: Constructs a filesystem policy indicating that filesystem isolation is enforced externally. It carries no explicit entries because Codex is not constructing the sandbox itself.

**Data flow**: Returns `FileSystemSandboxPolicy { kind: ExternalSandbox, glob_scan_max_depth: None, entries: Vec::new() }`.

**Call relations**: Used when projecting external sandbox ownership into the filesystem-policy model.

*Call graph*: called by 4 (external_sandbox_auto_approves_in_on_request, file_system_sandbox_policy, permission_profile_from_runtime_permissions_preserves_external_sandbox, from); 1 external calls (new).


##### `FileSystemSandboxPolicy::restricted`  (lines 444–450)

```
fn restricted(entries: Vec<FileSystemSandboxEntry>) -> Self
```

**Purpose**: Constructs a restricted filesystem policy from an explicit entry list. It leaves `glob_scan_max_depth` unset by default.

**Data flow**: Consumes `Vec<FileSystemSandboxEntry>`, wraps it in `FileSystemSandboxPolicy { kind: Restricted, glob_scan_max_depth: None, entries }`, and returns the policy.

**Call relations**: This is the main constructor used throughout the file and tests for explicit restricted policies.

*Call graph*: called by 138 (requested_permissions_trust_project_uses_permission_profile_intent, permission_profile_override_keeps_memories_root_out_of_legacy_projection, permission_profile_override_preserves_split_write_roots, compile_permission_profile, workspace_write_permission_profile_with_private_denials, managed_cwd_write_profile_has_filesystem_restrictions, managed_full_disk_write_profile_has_no_filesystem_restrictions, managed_unresolvable_write_profile_has_filesystem_restrictions, writable_windows_policy_without_sandbox_backend_still_requires_approval, windows_elevated_allows_split_restricted_read_policies (+15 more)).


##### `FileSystemSandboxPolicy::has_root_access`  (lines 452–461)

```
fn has_root_access(&self, predicate: impl Fn(FileSystemAccessMode) -> bool) -> bool
```

**Purpose**: Checks whether a restricted policy contains a root special-path entry satisfying a supplied access predicate. It is the shared helper behind full-disk read/write detection.

**Data flow**: Borrows `self` and a predicate `Fn(FileSystemAccessMode) -> bool`, returns `false` unless `kind` is `Restricted`, then scans `self.entries` for `FileSystemPath::Special { value: Root }` entries whose `access` satisfies the predicate.

**Call relations**: Used by `has_full_disk_read_access` and `has_full_disk_write_access` to detect broad root grants.

*Call graph*: called by 2 (has_full_disk_read_access, has_full_disk_write_access); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::has_denied_read_restrictions`  (lines 463–469)

```
fn has_denied_read_restrictions(&self) -> bool
```

**Purpose**: Returns whether a restricted policy contains any explicit `Deny` entries. This is the coarse indicator that read access is narrowed beyond simple allow roots.

**Data flow**: Borrows `self`, checks that `kind` is `Restricted`, scans `self.entries` for any entry with `access == Deny`, and returns the resulting `bool`.

**Call relations**: Used by deny-read matcher construction, full-disk read detection, and unsandboxed-execution checks.

*Call graph*: called by 3 (unsandboxed_execution_allowed, has_full_disk_read_access, build); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::from_legacy_sandbox_policy_preserving_deny_entries`  (lines 471–493)

```
fn from_legacy_sandbox_policy_preserving_deny_entries(
        sandbox_policy: &SandboxPolicy,
        cwd: &Path,
        existing: &Self,
    ) -> Self
```

**Purpose**: Rebuilds a filesystem policy from a legacy `SandboxPolicy` while preserving explicit deny-read entries and glob depth from an existing richer policy. This prevents deny rules from being lost when callers update only the legacy-compatible allow side.

**Data flow**: Borrows a legacy `SandboxPolicy`, `cwd`, and existing `FileSystemSandboxPolicy`. It rebuilds a fresh policy with `from_legacy_sandbox_policy_for_cwd`, returns it unchanged if the rebuilt kind is not restricted, otherwise copies `glob_scan_max_depth` from `existing` and appends any deny entries from `existing.entries` that are not already present.

**Call relations**: Used when applying legacy sandbox updates onto an existing richer policy. It is the compatibility-preserving bridge for deny-read rules.

*Call graph*: called by 2 (apply, legacy_bridge_preserves_explicit_deny_entries); 2 external calls (from_legacy_sandbox_policy_for_cwd, matches!).


##### `FileSystemSandboxPolicy::preserve_deny_read_restrictions_from`  (lines 497–528)

```
fn preserve_deny_read_restrictions_from(&mut self, existing: &Self)
```

**Purpose**: Mutates a policy to preserve explicit deny-read restrictions from an existing policy, even when the new allow-side policy would otherwise become unrestricted. This keeps deny rules enforceable across policy replacement.

**Data flow**: Mutably borrows `self` and borrows `existing`. If `existing` has any deny entries and `self.kind` is `Unrestricted`, it replaces `self` with a restricted root-write policy. If `self` is not restricted after that, it returns. Otherwise it copies `glob_scan_max_depth` from `existing` when missing and appends any deny entries from `existing` not already present.

**Call relations**: Used by callers that replace allow-side policy state but must retain deny-read restrictions. It is the in-place counterpart to `from_legacy_sandbox_policy_preserving_deny_entries`.

*Call graph*: 3 external calls (restricted, matches!, vec!).


##### `FileSystemSandboxPolicy::has_write_narrowing_entries`  (lines 537–556)

```
fn has_write_narrowing_entries(&self) -> bool
```

**Purpose**: Returns whether a restricted policy contains any effective non-write entries that narrow a broader root-write grant. Shadowed entries with an equally specific write override do not count.

**Data flow**: Borrows `self`, returns `false` unless `kind` is `Restricted`, then scans entries. Write entries are ignored. Path entries count unless `has_same_target_write_override(entry)` is true; glob patterns always count; special paths count depending on variant, with `Root` counting only for `Deny`, `Minimal` and `Unknown` ignored, and other special paths counting unless shadowed by a same-target write override.

**Call relations**: Used by `has_full_disk_write_access` to distinguish truly unrestricted write access from root-write policies with carveouts.

*Call graph*: called by 1 (has_full_disk_write_access); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::has_same_target_write_override`  (lines 560–566)

```
fn has_same_target_write_override(&self, entry: &FileSystemSandboxEntry) -> bool
```

**Purpose**: Checks whether a higher-precedence write entry targets the same exact location as another entry, making that other entry ineffective as a narrowing carveout. This is a same-specificity shadowing test, not a subtree test.

**Data flow**: Borrows `self` and an entry, scans `self.entries` for any candidate whose access can write, whose access precedence is greater than the target entry’s access, and whose path shares the same target according to `file_system_paths_share_target`. It returns a `bool`.

**Call relations**: Used only by `has_write_narrowing_entries` to avoid treating shadowed read entries as effective write restrictions.


##### `FileSystemSandboxPolicy::workspace_write`  (lines 570–627)

```
fn workspace_write(
        writable_roots: &[AbsolutePathBuf],
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> Self
```

**Purpose**: Constructs the canonical restricted filesystem policy corresponding to legacy workspace-write semantics. It grants root read, project-root write, optional tmpdir writes, explicit extra writable roots, and default read-only carveouts for protected metadata.

**Data flow**: Accepts extra writable roots and two booleans controlling tmpdir grants. It starts with root-read and project-roots-write entries, conditionally adds `SlashTmp` and `Tmpdir` write entries, appends exact write entries for each extra writable root, then adds default read-only project-root subpath entries for `.git`, `.agents`, and `.codex`, plus default read-only exact-path carveouts for protected metadata under each extra writable root. It returns `FileSystemSandboxPolicy::restricted(entries)`.

**Call relations**: Used by legacy-policy projection, permission-profile presets, and tests. It is the main constructor for workspace-write filesystem semantics.

*Call graph*: calls 4 internal fn (restricted, append_default_read_only_path_if_no_explicit_rule, append_default_read_only_project_root_subpath_if_no_explicit_rule, default_read_only_subpaths_for_writable_root); called by 8 (extensible_builtin_parent_profile, test_writable_roots_constraint, write_permissions_for_paths_keep_dirs_outside_workspace_root, write_permissions_for_paths_skip_dirs_already_writable_under_workspace_root, ignores_missing_writable_roots, mounts_dev_before_writable_dev_binds, workspace_write_with, from); 3 external calls (project_roots, iter, vec!).


##### `FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd`  (lines 636–663)

```
fn from_legacy_sandbox_policy_for_cwd(sandbox_policy: &SandboxPolicy, cwd: &Path) -> Self
```

**Purpose**: Projects a legacy `SandboxPolicy` into an equivalent filesystem policy while resolving cwd-sensitive workspace-write defaults for a specific working directory. It also adds protected metadata carveouts under the cwd root and explicit writable roots.

**Data flow**: Borrows a legacy `SandboxPolicy` and `cwd`, starts from `Self::from(sandbox_policy)`, and if the legacy policy is `WorkspaceWrite` it resolves `cwd` to an `AbsolutePathBuf`, appends default read-only protected subpaths for the cwd root with `protect_missing_dot_codex = true`, and appends default read-only protected subpaths for each explicit writable root with `protect_missing_dot_codex = false`. It returns the resulting policy.

**Call relations**: Used when legacy workspace-write semantics must be interpreted relative to a concrete cwd. It extends the simpler `From<&SandboxPolicy>` projection with cwd-specific metadata protection.

*Call graph*: calls 3 internal fn (append_default_read_only_path_if_no_explicit_rule, default_read_only_subpaths_for_writable_root, from_absolute_path); called by 19 (exec_one_off_command_inner, can_set_legacy_sandbox_policy, set_legacy_sandbox_policy, file_system_policy_with_unreadable_glob, session_configuration_apply_permission_profile_preserves_existing_deny_read_entries, session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update, non_legacy_file_system_sandbox_policy, build_agent_spawn_config_uses_turn_context_values, spawn_agent_reapplies_runtime_sandbox_after_role_config, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command (+9 more)); 1 external calls (from).


##### `FileSystemSandboxPolicy::has_full_disk_read_access`  (lines 666–674)

```
fn has_full_disk_read_access(&self) -> bool
```

**Purpose**: Returns whether filesystem reads are effectively unrestricted. Restricted policies need a root-readable entry and no deny-read restrictions to qualify.

**Data flow**: Borrows `self`, returns `true` immediately for `Unrestricted` and `ExternalSandbox`, and for `Restricted` returns `self.has_root_access(FileSystemAccessMode::can_read) && !self.has_denied_read_restrictions()`.

**Call relations**: Used by readable-root derivation, platform-default inclusion, semantic signatures, and runtime sandbox setup.

*Call graph*: calls 2 internal fn (has_denied_read_restrictions, has_root_access); called by 7 (add_helper_runtime_permissions, create_filesystem_args, get_readable_roots_with_cwd, include_platform_defaults, semantic_signature, with_additional_readable_roots, has_full_disk_read_access).


##### `FileSystemSandboxPolicy::has_full_disk_write_access`  (lines 677–685)

```
fn has_full_disk_write_access(&self) -> bool
```

**Purpose**: Returns whether filesystem writes are effectively unrestricted. Restricted policies need a root-write grant and no effective narrowing entries.

**Data flow**: Borrows `self`, returns `true` for `Unrestricted` and `ExternalSandbox`, and for `Restricted` returns `self.has_root_access(FileSystemAccessMode::can_write) && !self.has_write_narrowing_entries()`.

**Call relations**: Used by writable-root derivation, legacy bridging, metadata-write checks, and semantic signatures.

*Call graph*: calls 2 internal fn (has_root_access, has_write_narrowing_entries); called by 10 (patch_rejection_reason, create_bwrap_command_args, create_filesystem_args, sandbox_prompt_from_policy, can_write_path_with_cwd, get_writable_roots_with_cwd, semantic_signature, to_legacy_sandbox_policy, ensure_linux_bubblewrap_is_supported, should_require_platform_sandbox).


##### `FileSystemSandboxPolicy::include_platform_defaults`  (lines 688–699)

```
fn include_platform_defaults(&self) -> bool
```

**Purpose**: Returns whether platform-default readable roots should be included for this policy. This happens only for restricted policies that do not already have full-disk read access and that include a readable `Minimal` special-path entry.

**Data flow**: Borrows `self`, checks `!self.has_full_disk_read_access()`, `kind == Restricted`, and scans entries for `FileSystemPath::Special { value: Minimal }` with readable access. It returns the resulting `bool`.

**Call relations**: Used by downstream sandbox argument generation and semantic signatures to decide whether platform-default readable roots are part of the effective policy.

*Call graph*: calls 1 internal fn (has_full_disk_read_access); called by 3 (create_filesystem_args, semantic_signature, include_platform_defaults); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::resolve_access_with_cwd`  (lines 701–719)

```
fn resolve_access_with_cwd(&self, path: &Path, cwd: &Path) -> FileSystemAccessMode
```

**Purpose**: Computes the effective access mode for a path under the policy, resolving symbolic entries against a given cwd and applying specificity/precedence rules. Unrestricted and external policies always resolve to `Write`.

**Data flow**: Borrows `self`, `path`, and `cwd`. For unrestricted/external kinds it returns `Write`. For restricted policies it resolves the candidate path against `cwd` with `resolve_candidate_path`, returns `Deny` if resolution fails, gathers resolved entries with `resolved_entries_with_cwd(cwd)`, filters entries whose resolved path is a prefix of the target path, selects the maximum by `resolved_entry_precedence`, and returns that entry’s access or `Deny` if none match.

**Call relations**: Used by `can_read_path_with_cwd`, `can_write_path_with_cwd`, and other access-sensitive helpers. It is the core path-access resolution algorithm.

*Call graph*: calls 2 internal fn (resolved_entries_with_cwd, resolve_candidate_path); called by 3 (can_read_path_with_cwd, can_write_path_with_cwd, granted_file_system_entry_within_request).


##### `FileSystemSandboxPolicy::can_read_path_with_cwd`  (lines 721–723)

```
fn can_read_path_with_cwd(&self, path: &Path, cwd: &Path) -> bool
```

**Purpose**: Returns whether a path is readable under the policy after cwd resolution. It is a convenience wrapper over `resolve_access_with_cwd`.

**Data flow**: Borrows `self`, `path`, and `cwd`, calls `resolve_access_with_cwd(path, cwd)`, then calls `.can_read()` on the resulting access mode and returns the `bool`.

**Call relations**: Used by readable-root derivation and additional-readable-root insertion logic.

*Call graph*: calls 1 internal fn (resolve_access_with_cwd); called by 3 (windows_policy_has_root_read_access, add_helper_runtime_permissions, with_additional_readable_roots).


##### `FileSystemSandboxPolicy::can_write_path_with_cwd`  (lines 725–733)

```
fn can_write_path_with_cwd(&self, path: &Path, cwd: &Path) -> bool
```

**Purpose**: Returns whether a path is writable under the policy after cwd resolution and protected-metadata checks. Even when access resolution yields `Write`, metadata protection can still deny the write.

**Data flow**: Borrows `self`, `path`, and `cwd`. If `resolve_access_with_cwd(...).can_write()` is false, it returns false. If `has_full_disk_write_access()` is true, it returns true. Otherwise it returns `!self.is_metadata_write_denied(path, cwd)`.

**Call relations**: Used by writable-root derivation, metadata-write rejection, and compatibility checks. It layers metadata protection on top of raw access resolution.

*Call graph*: calls 3 internal fn (has_full_disk_write_access, is_metadata_write_denied, resolve_access_with_cwd); called by 4 (with_additional_writable_roots, forbidden_agent_metadata_write, compatibility_workspace_write_policy, protected_metadata_names_for_writable_root).


##### `FileSystemSandboxPolicy::is_metadata_write_denied`  (lines 735–755)

```
fn is_metadata_write_denied(&self, path: &Path, cwd: &Path) -> bool
```

**Purpose**: Checks whether a write should be denied specifically because it targets protected metadata under a writable root without an explicit metadata write grant. This is the internal metadata-protection predicate used by `can_write_path_with_cwd`.

**Data flow**: Borrows `self`, `path`, and `cwd`. It returns false unless the policy is restricted. It resolves the target path against `cwd`, returning true on resolution failure. It then finds the protected metadata child under a writable root with `metadata_child_of_writable_root`; if none exists it returns false. Otherwise it returns the negation of `has_explicit_write_entry_for_metadata_path(self, &protected_metadata_path, target, cwd)`.

**Call relations**: Called only by `can_write_path_with_cwd`. It encapsulates the protected-metadata carveout logic.

*Call graph*: calls 3 internal fn (has_explicit_write_entry_for_metadata_path, metadata_child_of_writable_root, resolve_candidate_path); called by 1 (can_write_path_with_cwd); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::materialize_project_roots_with_cwd`  (lines 762–787)

```
fn materialize_project_roots_with_cwd(mut self, cwd: &Path) -> Self
```

**Purpose**: Replaces symbolic `ProjectRoots` entries and project-root-prefixed glob patterns with concrete cwd-relative paths. This is used when a durable policy must stop rebinding to future cwd changes.

**Data flow**: Consumes `self` mutably and borrows `cwd`. It resolves `cwd` to `Option<AbsolutePathBuf>`, then iterates `self.entries`: `ProjectRoots` special paths are replaced with exact `Path` entries via `resolve_file_system_path`, project-root-prefixed glob patterns are rewritten with `resolve_project_roots_glob_pattern`, and other entries are left unchanged. It returns the mutated policy.

**Call relations**: Used when symbolic workspace-root authority must be concretized against the current cwd. It delegates path and glob resolution to lower-level helpers.

*Call graph*: calls 4 internal fn (parse_project_roots_glob_pattern, resolve_file_system_path, resolve_project_roots_glob_pattern, from_absolute_path); 1 external calls (as_ref).


##### `FileSystemSandboxPolicy::materialize_project_roots_with_workspace_roots`  (lines 791–845)

```
fn materialize_project_roots_with_workspace_roots(
        mut self,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Expands symbolic project-root entries into concrete entries for each provided workspace root. Both exact special paths and project-root-prefixed glob patterns are duplicated across all roots.

**Data flow**: Consumes `self` mutably and borrows a slice of workspace roots. It builds a new `entries` vector, replacing each `ProjectRoots` special path with one exact `Path` entry per workspace root (optionally joined with the subpath), replacing each project-root-prefixed glob with one concrete glob per workspace root, and copying all other entries unchanged. It stores the new vector back into `self.entries` and returns `self`.

**Call relations**: Used when a policy must be expanded across multiple workspace roots rather than a single cwd. It is the multi-root counterpart to `materialize_project_roots_with_cwd`.

*Call graph*: calls 1 internal fn (parse_project_roots_glob_pattern); 2 external calls (with_capacity, iter).


##### `FileSystemSandboxPolicy::with_materialized_project_roots_for_workspace_roots`  (lines 849–862)

```
fn with_materialized_project_roots_for_workspace_roots(
        mut self,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Preserves symbolic project-root entries while also appending their concrete expansions for the provided workspace roots. This gives callers both the symbolic and materialized forms in one policy.

**Data flow**: Consumes `self` mutably and borrows workspace roots. It clones `self`, materializes the clone with `materialize_project_roots_with_workspace_roots`, then appends any resulting entries not already present in `self.entries`. It returns the augmented policy.

**Call relations**: Used when callers want concrete workspace-root entries available without losing the original symbolic entries.


##### `FileSystemSandboxPolicy::with_additional_readable_roots`  (lines 864–885)

```
fn with_additional_readable_roots(
        mut self,
        cwd: &Path,
        additional_readable_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Adds exact readable roots to a policy only when they are not already effectively readable. Full-disk-read policies are returned unchanged.

**Data flow**: Consumes `self` mutably, borrows `cwd` and a slice of additional readable roots. If `has_full_disk_read_access()` is true it returns immediately. Otherwise it checks each root with `can_read_path_with_cwd`; unreadable roots are appended as exact `Path` entries with `Read` access. It returns the updated policy.

**Call relations**: Used by callers that need to widen read access incrementally without duplicating already-effective grants.

*Call graph*: calls 2 internal fn (can_read_path_with_cwd, has_full_disk_read_access).


##### `FileSystemSandboxPolicy::with_additional_writable_roots`  (lines 887–904)

```
fn with_additional_writable_roots(
        mut self,
        cwd: &Path,
        additional_writable_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Adds exact writable roots to a policy only when they are not already effectively writable. Unlike the legacy workspace-write helper, it does not add metadata carveouts for the new roots.

**Data flow**: Consumes `self` mutably, borrows `cwd` and a slice of additional writable roots, checks each root with `can_write_path_with_cwd`, and appends exact `Path` entries with `Write` access for roots that are not already writable. It returns the updated policy.

**Call relations**: Used by callers that need to widen write access incrementally under the modern split-policy semantics.

*Call graph*: calls 1 internal fn (can_write_path_with_cwd).


##### `FileSystemSandboxPolicy::with_additional_legacy_workspace_writable_roots`  (lines 912–942)

```
fn with_additional_legacy_workspace_writable_roots(
        mut self,
        additional_writable_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Adds writable roots using legacy workspace-write semantics, including exact root entries even when already writable via symbolic project roots and default protected-metadata carveouts for each new root. This mirrors old `WorkspaceWrite` behavior more closely than `with_additional_writable_roots`.

**Data flow**: Consumes `self` mutably and borrows additional writable roots. It returns unchanged unless `kind` is `Restricted`. For each root it appends an exact `Path` write entry if no identical write entry already exists, then appends default read-only protected subpaths for that root via `default_read_only_subpaths_for_writable_root` and `append_default_read_only_path_if_no_explicit_rule`. It returns the updated policy.

**Call relations**: Used when callers need to preserve legacy writable-root semantics rather than the leaner modern widening behavior.

*Call graph*: calls 2 internal fn (append_default_read_only_path_if_no_explicit_rule, default_read_only_subpaths_for_writable_root); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::needs_direct_runtime_enforcement`  (lines 944–964)

```
fn needs_direct_runtime_enforcement(
        &self,
        network_policy: NetworkSandboxPolicy,
        cwd: &Path,
    ) -> bool
```

**Purpose**: Returns whether the policy cannot be faithfully enforced by bridging through legacy `SandboxPolicy` alone and therefore requires direct runtime enforcement of `FileSystemSandboxPolicy`. This catches semantic mismatches such as nested carveouts or metadata protections the legacy runtime cannot express.

**Data flow**: Borrows `self`, a `NetworkSandboxPolicy`, and `cwd`. It returns false unless `kind` is `Restricted`. It attempts `to_legacy_sandbox_policy(network_policy, cwd)` and returns true on error. It then checks `protected_metadata_names_need_direct_runtime_enforcement(self, &legacy_policy, cwd)` and returns true if needed. Finally it compares `self.semantic_signature(cwd)` to `legacy_runtime_file_system_policy_for_cwd(&legacy_policy, cwd).semantic_signature(cwd)` and returns whether they differ.

**Call relations**: Used by runtime-selection code to decide whether legacy sandbox backends are sufficient. It depends on both legacy bridging and semantic-signature comparison.

*Call graph*: calls 4 internal fn (semantic_signature, to_legacy_sandbox_policy, legacy_runtime_file_system_policy_for_cwd, protected_metadata_names_need_direct_runtime_enforcement); called by 1 (ensure_legacy_landlock_mode_supports_policy); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::is_semantically_equivalent_to`  (lines 968–970)

```
fn is_semantically_equivalent_to(&self, other: &Self, cwd: &Path) -> bool
```

**Purpose**: Checks whether two filesystem policies resolve to the same effective semantics for a given cwd, ignoring incidental entry ordering. This is stronger than structural equality and weaker than full runtime equivalence across all cwd values.

**Data flow**: Borrows `self`, `other`, and `cwd`, computes `self.semantic_signature(cwd)` and `other.semantic_signature(cwd)`, compares them for equality, and returns the `bool`.

**Call relations**: Used by tests and compatibility logic to compare policies by meaning rather than raw entry order.

*Call graph*: calls 1 internal fn (semantic_signature); 1 external calls (semantic_signature).


##### `FileSystemSandboxPolicy::get_readable_roots_with_cwd`  (lines 973–987)

```
fn get_readable_roots_with_cwd(&self, cwd: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the explicit readable roots implied by the policy for a given cwd. Full-disk-read policies return an empty vector because no explicit roots are needed.

**Data flow**: Borrows `self` and `cwd`. If `has_full_disk_read_access()` is true it returns `Vec::new()`. Otherwise it resolves entries with `resolved_entries_with_cwd(cwd)`, keeps entries whose access can read and whose resolved path still passes `can_read_path_with_cwd`, collects their paths, deduplicates them with `dedup_absolute_paths(..., true)`, and returns the result.

**Call relations**: Used by sandbox backend argument generation and semantic signatures. It derives the explicit readable-root set from the richer policy.

*Call graph*: calls 3 internal fn (has_full_disk_read_access, resolved_entries_with_cwd, dedup_absolute_paths); called by 3 (create_filesystem_args, semantic_signature, readable_roots_for_cwd); 1 external calls (new).


##### `FileSystemSandboxPolicy::get_writable_roots_with_cwd`  (lines 991–1103)

```
fn get_writable_roots_with_cwd(&self, cwd: &Path) -> Vec<WritableRoot>
```

**Purpose**: Returns the writable roots implied by the policy for a given cwd, each paired with protected metadata names and read-only carveout subpaths. This is the main projection consumed by downstream sandbox backends.

**Data flow**: Borrows `self` and `cwd`. If `has_full_disk_write_access()` is true it returns `Vec::new()`. Otherwise it resolves entries, collects effectively writable resolved paths, deduplicates them by effective path, and for each deduped root computes raw writable aliases, protected metadata names via `protected_metadata_names_for_writable_root`, default protected subpaths, and additional explicit non-write carveouts under that root while preserving symlink-visible paths where needed. It returns a vector of `WritableRoot { root, protected_metadata_names, read_only_subpaths }`.

**Call relations**: Used by sandbox backend generation, semantic signatures, and direct-enforcement checks. It is one of the most important policy-projection methods in the file.

*Call graph*: calls 3 internal fn (has_full_disk_write_access, resolved_entries_with_cwd, dedup_absolute_paths); called by 6 (patch_rejection_reason, create_filesystem_args, sandbox_prompt_from_policy, semantic_signature, protected_metadata_names_need_direct_runtime_enforcement, compatibility_workspace_write_policy); 1 external calls (new).


##### `FileSystemSandboxPolicy::get_unreadable_roots_with_cwd`  (lines 1106–1128)

```
fn get_unreadable_roots_with_cwd(&self, cwd: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Returns the explicit unreadable exact-path roots implied by deny entries for a given cwd. It omits the filesystem root itself because downstream deny masks on `/` would erase narrower readable carveouts.

**Data flow**: Borrows `self` and `cwd`. It returns `Vec::new()` unless `kind` is `Restricted`. It resolves the cwd root, resolves entries with `resolved_entries_with_cwd(cwd)`, keeps deny entries whose resolved path is not readable under the policy and is not the filesystem root, collects their paths, deduplicates them with effective-path normalization, and returns the result.

**Call relations**: Used by deny-read matcher construction, sandbox backend generation, and semantic signatures.

*Call graph*: calls 3 internal fn (resolved_entries_with_cwd, dedup_absolute_paths, from_absolute_path); called by 5 (create_filesystem_args, denied_reads_text, semantic_signature, build, resolve_windows_deny_read_paths); 2 external calls (new, matches!).


##### `FileSystemSandboxPolicy::get_unreadable_globs_with_cwd`  (lines 1131–1151)

```
fn get_unreadable_globs_with_cwd(&self, cwd: &Path) -> Vec<String>
```

**Purpose**: Returns the deny-read glob patterns implied by the policy for a given cwd, resolving project-root-relative patterns against the cwd. The returned list is sorted and deduplicated.

**Data flow**: Borrows `self` and `cwd`. It returns `Vec::new()` unless `kind` is `Restricted`. It scans deny entries for `FileSystemPath::GlobPattern`, resolves each pattern against `cwd` with `AbsolutePathBuf::resolve_path_against_base`, converts to owned strings, sorts the vector, deduplicates it, and returns it.

**Call relations**: Used by deny-read matcher construction, sandbox backend generation, and semantic signatures.

*Call graph*: called by 7 (create_bwrap_command_args, create_filesystem_args, denied_reads_text, semantic_signature, build, build_seatbelt_unreadable_glob_policy, resolve_windows_deny_read_paths); 2 external calls (new, matches!).


##### `FileSystemSandboxPolicy::to_legacy_sandbox_policy`  (lines 1153–1266)

```
fn to_legacy_sandbox_policy(
        &self,
        network_policy: NetworkSandboxPolicy,
        cwd: &Path,
    ) -> io::Result<SandboxPolicy>
```

**Purpose**: Attempts to bridge the richer filesystem policy plus network policy back into the older `SandboxPolicy` representation. Some split-write configurations cannot be represented and return an error.

**Data flow**: Borrows `self`, a `NetworkSandboxPolicy`, and `cwd`. External sandbox maps to `SandboxPolicy::ExternalSandbox`; unrestricted maps to `DangerFullAccess` when network is enabled or restricted external sandbox otherwise. Restricted policies inspect entries to determine whether workspace-root write, tmpdir write, slash-tmp write, or unbridgeable root write is requested, and whether full-disk write access is effectively present. They then return `DangerFullAccess`, `WorkspaceWrite`, `ReadOnly`, or an `io::Error` when writes outside the workspace root cannot be represented by legacy policy.

**Call relations**: Used by direct-enforcement checks and compatibility layers that still need legacy sandbox-policy output. It is the main bridge from rich filesystem semantics back to the older runtime contract.

*Call graph*: calls 5 internal fn (has_full_disk_write_access, is_enabled, dedup_absolute_paths, resolve_file_system_special_path, from_absolute_path); called by 1 (needs_direct_runtime_enforcement); 2 external calls (new, new).


##### `FileSystemSandboxPolicy::resolved_entries_with_cwd`  (lines 1268–1281)

```
fn resolved_entries_with_cwd(&self, cwd: &Path) -> Vec<ResolvedFileSystemEntry>
```

**Purpose**: Resolves all entries in the policy that can be concretized against a given cwd into exact absolute paths paired with access modes. Entries that cannot resolve, such as some special paths, are omitted.

**Data flow**: Borrows `self` and `cwd`, resolves `cwd` to `Option<AbsolutePathBuf>`, iterates `self.entries`, resolves each entry path with `resolve_entry_path(&entry.path, cwd_absolute.as_ref())`, and collects successful resolutions into `Vec<ResolvedFileSystemEntry { path, access }>`.

**Call relations**: Used by access resolution, readable/writable/unreadable root derivation, and metadata-write helpers. It is the common path-resolution primitive for policy evaluation.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 6 (get_readable_roots_with_cwd, get_unreadable_roots_with_cwd, get_writable_roots_with_cwd, resolve_access_with_cwd, has_explicit_write_entry_for_metadata_path, metadata_child_of_writable_root).


##### `FileSystemSandboxPolicy::semantic_signature`  (lines 1283–1293)

```
fn semantic_signature(&self, cwd: &Path) -> FileSystemSemanticSignature
```

**Purpose**: Computes a normalized semantic summary of the policy for a given cwd, including full-disk flags, platform-default inclusion, readable roots, writable roots, unreadable roots, and unreadable globs. This supports semantic comparison independent of entry ordering.

**Data flow**: Borrows `self` and `cwd`, computes `has_full_disk_read_access`, `has_full_disk_write_access`, `include_platform_defaults`, sorted readable roots, sorted writable roots, sorted unreadable roots, and unreadable globs, packages them into `FileSystemSemanticSignature`, and returns it.

**Call relations**: Used by `is_semantically_equivalent_to` and `needs_direct_runtime_enforcement`. It is the canonical normalized view of policy semantics.

*Call graph*: calls 9 internal fn (get_readable_roots_with_cwd, get_unreadable_globs_with_cwd, get_unreadable_roots_with_cwd, get_writable_roots_with_cwd, has_full_disk_read_access, has_full_disk_write_access, include_platform_defaults, sorted_absolute_paths, sorted_writable_roots); called by 2 (is_semantically_equivalent_to, needs_direct_runtime_enforcement).


##### `NetworkSandboxPolicy::from`  (lines 1297–1303)

```
fn from(value: &SandboxPolicy) -> Self
```

**Purpose**: Projects a legacy `SandboxPolicy` into the simpler network sandbox policy. Full network access becomes `Enabled`; otherwise network is `Restricted`.

**Data flow**: Borrows a `SandboxPolicy`, calls `value.has_full_network_access()`, and returns `NetworkSandboxPolicy::Enabled` or `Restricted` accordingly.

**Call relations**: Used by permission-profile projection and legacy sandbox bridging whenever network policy must be separated from filesystem policy.

*Call graph*: called by 14 (exec_one_off_command_inner, can_set_legacy_sandbox_policy, set_legacy_sandbox_policy, apply, session_configuration_apply_preserves_profile_file_system_policy_on_cwd_only_update, session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update, build_agent_spawn_config_uses_turn_context_values, spawn_agent_reapplies_runtime_sandbox_after_role_config, from_legacy_sandbox_policy, from_legacy_sandbox_policy (+4 more)); 1 external calls (has_full_network_access).


##### `FileSystemSandboxPolicy::from`  (lines 1307–1330)

```
fn from(value: &SandboxPolicy) -> Self
```

**Purpose**: Projects a legacy `SandboxPolicy` into the richer filesystem sandbox policy. Read-only, workspace-write, unrestricted, and external sandbox variants each map to their corresponding filesystem semantics.

**Data flow**: Borrows a `SandboxPolicy`, matches on its variant, and returns `unrestricted()`, `external_sandbox()`, a restricted root-read policy, or `workspace_write(...)` with the legacy writable roots and tmpdir flags.

**Call relations**: Used by permission-profile projection and by cwd-aware legacy-policy expansion. It is the basic legacy-to-filesystem-policy bridge.

*Call graph*: calls 4 internal fn (external_sandbox, restricted, unrestricted, workspace_write); called by 2 (from_legacy_sandbox_policy, legacy_runtime_file_system_policy_for_cwd); 1 external calls (vec!).


##### `resolve_file_system_path`  (lines 1333–1342)

```
fn resolve_file_system_path(
    path: &FileSystemPath,
    cwd: Option<&AbsolutePathBuf>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves a `FileSystemPath` into an exact absolute path when possible. Exact paths clone directly, glob patterns cannot resolve, and special paths delegate to special-path resolution.

**Data flow**: Borrows a `FileSystemPath` and optional cwd, matches on the variant, clones exact paths, returns `None` for glob patterns, and delegates special paths to `resolve_file_system_special_path`.

**Call relations**: Used by project-root materialization and entry-path resolution. It is the generic path-resolution helper for non-root special cases.

*Call graph*: calls 1 internal fn (resolve_file_system_special_path); called by 2 (materialize_project_roots_with_cwd, resolve_entry_path); 1 external calls (clone).


##### `resolve_entry_path`  (lines 1344–1354)

```
fn resolve_entry_path(
    path: &FileSystemPath,
    cwd: Option<&AbsolutePathBuf>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves a policy entry path into an exact absolute path, treating the `Root` special path specially by mapping it to the filesystem root of the provided cwd. Other paths delegate to `resolve_file_system_path`.

**Data flow**: Borrows a `FileSystemPath` and optional cwd. If the path is `Special { value: Root }`, it maps the cwd to `absolute_root_path_for_cwd`; otherwise it delegates to `resolve_file_system_path`. It returns `Option<AbsolutePathBuf>`.

**Call relations**: Used by `resolved_entries_with_cwd` so root entries become concrete absolute paths for access resolution.

*Call graph*: calls 1 internal fn (resolve_file_system_path).


##### `parse_project_roots_glob_pattern`  (lines 1356–1360)

```
fn parse_project_roots_glob_pattern(pattern: &str) -> Option<&Path>
```

**Purpose**: Parses a symbolic project-roots glob pattern and returns the relative subpath portion when the reserved prefix is present. Non-prefixed patterns return `None`.

**Data flow**: Borrows `pattern: &str`, strips `PROJECT_ROOTS_GLOB_PATTERN_PREFIX`, maps the remainder to `Path::new`, and returns `Option<&Path>`.

**Call relations**: Used by project-root materialization helpers to detect symbolic workspace-root glob patterns.

*Call graph*: called by 2 (materialize_project_roots_with_cwd, materialize_project_roots_with_workspace_roots).


##### `resolve_project_roots_glob_pattern`  (lines 1362–1366)

```
fn resolve_project_roots_glob_pattern(subpath: &Path, root: &AbsolutePathBuf) -> String
```

**Purpose**: Resolves a project-root-relative glob subpath against a concrete workspace root and returns the resulting absolute glob string.

**Data flow**: Borrows a relative `subpath` and `root`, resolves the subpath against `root` with `AbsolutePathBuf::resolve_path_against_base`, converts the result to a lossy string, and returns it.

**Call relations**: Used by both cwd-based and multi-root project-root glob materialization.

*Call graph*: calls 2 internal fn (as_path, resolve_path_against_base); called by 1 (materialize_project_roots_with_cwd).


##### `resolve_candidate_path`  (lines 1368–1374)

```
fn resolve_candidate_path(path: &Path, cwd: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves an arbitrary candidate path against a cwd, preserving absolute paths and joining relative paths to the cwd. It returns `None` if the cwd cannot be converted to an absolute path.

**Data flow**: Borrows `path` and `cwd`. If `path.is_absolute()` it attempts `AbsolutePathBuf::from_absolute_path(path)`. Otherwise it resolves `cwd` to `AbsolutePathBuf` and joins the relative path onto it. It returns `Option<AbsolutePathBuf>`.

**Call relations**: Used by access checks and metadata-write helpers whenever a user-supplied or relative path must be normalized before policy evaluation.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 3 (is_metadata_write_denied, resolve_access_with_cwd, forbidden_agent_metadata_write); 1 external calls (is_absolute).


##### `file_system_paths_share_target`  (lines 1382–1400)

```
fn file_system_paths_share_target(left: &FileSystemPath, right: &FileSystemPath) -> bool
```

**Purpose**: Checks whether two config-level filesystem paths refer to the same exact target before any prefix matching. This is used only for same-specificity shadowing and duplicate-rule detection.

**Data flow**: Borrows two `FileSystemPath` values, matches on their variant combinations, compares exact paths directly, compares special paths with `special_paths_share_target`, compares special-vs-exact paths with `special_path_matches_absolute_path`, compares glob patterns by string equality, and returns false for glob-vs-non-glob combinations.

**Call relations**: Used by write-narrowing analysis and by default read-only carveout insertion to avoid duplicate or shadowed entries.

*Call graph*: calls 2 internal fn (special_path_matches_absolute_path, special_paths_share_target).


##### `special_paths_share_target`  (lines 1404–1426)

```
fn special_paths_share_target(left: &FileSystemSpecialPath, right: &FileSystemSpecialPath) -> bool
```

**Purpose**: Checks whether two special-path tokens resolve to the same concrete target without needing a cwd. Only cwd-independent special paths can match here.

**Data flow**: Borrows two `FileSystemSpecialPath` values, matches on variant pairs, and returns true for identical cwd-independent variants (`Root`, `Minimal`, `Tmpdir`, `SlashTmp`), equal `ProjectRoots` subpaths, or equal `Unknown` path/subpath pairs; otherwise false.

**Call relations**: Used by `file_system_paths_share_target` when comparing two special-path entries.

*Call graph*: called by 1 (file_system_paths_share_target).


##### `special_path_matches_absolute_path`  (lines 1433–1442)

```
fn special_path_matches_absolute_path(
    value: &FileSystemSpecialPath,
    path: &AbsolutePathBuf,
) -> bool
```

**Purpose**: Checks whether a cwd-independent special path names the same location as an exact absolute path. Only stable special paths like filesystem root and `/tmp` are folded this way.

**Data flow**: Borrows a `FileSystemSpecialPath` and `AbsolutePathBuf`, matches on the special path, and returns true when `Root` matches a path with no parent or `SlashTmp` matches `/tmp`; all other special paths return false.

**Call relations**: Used by `file_system_paths_share_target` for special-vs-exact path comparisons.

*Call graph*: calls 1 internal fn (as_path); called by 1 (file_system_paths_share_target); 1 external calls (new).


##### `resolved_entry_precedence`  (lines 1446–1449)

```
fn resolved_entry_precedence(entry: &ResolvedFileSystemEntry) -> (usize, FileSystemAccessMode)
```

**Purpose**: Computes the precedence key for a resolved entry: path specificity first, then access-mode precedence. More specific paths win; ties are broken by `Deny > Write > Read`.

**Data flow**: Borrows a `ResolvedFileSystemEntry`, counts path components to get specificity, pairs that with `entry.access`, and returns `(usize, FileSystemAccessMode)`.

**Call relations**: Used by `resolve_access_with_cwd` when selecting the winning entry among all prefixes of a target path.


##### `absolute_root_path_for_cwd`  (lines 1451–1459)

```
fn absolute_root_path_for_cwd(cwd: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Returns the filesystem root corresponding to a given absolute cwd. This is used to concretize the symbolic `Root` special path.

**Data flow**: Borrows an `AbsolutePathBuf`, finds the last ancestor of `cwd.as_path()`, converts it back into `AbsolutePathBuf`, and panics if the root is somehow not absolute.

**Call relations**: Used by `resolve_entry_path` and by unreadable-root derivation when the filesystem root needs special handling.

*Call graph*: calls 2 internal fn (as_path, from_absolute_path).


##### `normalized_and_canonical_candidates`  (lines 1461–1480)

```
fn normalized_and_canonical_candidates(path: &Path) -> Vec<PathBuf>
```

**Purpose**: Builds the set of path spellings used for deny-read matching: the lexical absolute form when possible plus the canonical target when it exists. This lets deny checks catch both symlink aliases and future-created paths.

**Data flow**: Borrows a `&Path`, initializes an empty candidate vector, pushes the normalized absolute path if conversion succeeds or the raw path otherwise, then attempts `path.canonicalize()` and pushes the canonical absolute path if available, using `push_unique` to avoid duplicates. It returns `Vec<PathBuf>`.

**Call relations**: Used by `ReadDenyMatcher::build` for denied roots and by `ReadDenyMatcher::is_read_denied` for candidate paths. It is central to symlink-aware deny matching.

*Call graph*: calls 2 internal fn (push_unique, from_absolute_path); called by 1 (is_read_denied); 3 external calls (canonicalize, to_path_buf, new).


##### `push_unique`  (lines 1482–1486)

```
fn push_unique(candidates: &mut Vec<PathBuf>, candidate: PathBuf)
```

**Purpose**: Appends a path candidate to a vector only if it is not already present. This preserves insertion order while avoiding duplicates.

**Data flow**: Mutably borrows a `Vec<PathBuf>` and consumes a `PathBuf`, scans the vector for equality, and pushes the candidate only when absent.

**Call relations**: Used only by `normalized_and_canonical_candidates` to maintain a deduplicated candidate list.

*Call graph*: called by 1 (normalized_and_canonical_candidates).


##### `build_glob_matcher`  (lines 1488–1497)

```
fn build_glob_matcher(pattern: &str) -> Result<GlobMatcher, String>
```

**Purpose**: Compiles a deny-read glob pattern into a `GlobMatcher` using config-compatible parsing rules. It keeps `*` and `?` within a single path component and treats unclosed `[` as a literal.

**Data flow**: Borrows `pattern: &str`, constructs a `GlobBuilder`, sets `literal_separator(true)` and `allow_unclosed_class(true)`, builds the glob, compiles it to a matcher, and returns `Result<GlobMatcher, String>` with any build error converted to text.

**Call relations**: Used by `ReadDenyMatcher::build` when compiling deny-read glob patterns from policy entries.

*Call graph*: called by 1 (build); 1 external calls (new).


##### `resolve_file_system_special_path`  (lines 1499–1535)

```
fn resolve_file_system_special_path(
    value: &FileSystemSpecialPath,
    cwd: Option<&AbsolutePathBuf>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves a special-path token into an exact absolute path when possible. Some special paths, such as `Root`, `Minimal`, and `Unknown`, intentionally do not resolve here.

**Data flow**: Borrows a `FileSystemSpecialPath` and optional cwd. `ProjectRoots` resolves to the cwd or a subpath under it; `Tmpdir` resolves from the `TMPDIR` environment variable when non-empty and absolute; `SlashTmp` resolves to `/tmp` only if that directory exists; `Root`, `Minimal`, and `Unknown` return `None`. It returns `Option<AbsolutePathBuf>`.

**Call relations**: Used by generic path resolution and legacy bridging whenever special-path tokens need concrete absolute paths.

*Call graph*: calls 2 internal fn (from_absolute_path, resolve_path_against_base); called by 2 (to_legacy_sandbox_policy, resolve_file_system_path); 2 external calls (from, var_os).


##### `dedup_absolute_paths`  (lines 1537–1554)

```
fn dedup_absolute_paths(
    paths: Vec<AbsolutePathBuf>,
    normalize_effective_paths: bool,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Deduplicates a list of absolute paths, optionally normalizing each path to its effective canonical form before comparison. This prevents duplicate roots caused by symlink aliases or repeated entries.

**Data flow**: Consumes `Vec<AbsolutePathBuf>` and a `normalize_effective_paths` flag, iterates through the paths, optionally rewrites each with `normalize_effective_absolute_path`, tracks seen `PathBuf`s in a `HashSet`, and returns the deduplicated vector in first-seen order.

**Call relations**: Used by readable/writable/unreadable root derivation, legacy bridging, and protected-subpath computation.

*Call graph*: calls 1 internal fn (normalize_effective_absolute_path); called by 5 (get_readable_roots_with_cwd, get_unreadable_roots_with_cwd, get_writable_roots_with_cwd, to_legacy_sandbox_policy, default_read_only_subpaths_for_writable_root); 2 external calls (new, with_capacity).


##### `sorted_absolute_paths`  (lines 1556–1559)

```
fn sorted_absolute_paths(mut paths: Vec<AbsolutePathBuf>) -> Vec<AbsolutePathBuf>
```

**Purpose**: Sorts absolute paths lexicographically by their underlying `Path`. This is used when building stable semantic signatures.

**Data flow**: Consumes `Vec<AbsolutePathBuf>`, sorts it in place by `as_path().cmp(...)`, and returns the sorted vector.

**Call relations**: Used by `semantic_signature` and `sorted_writable_roots` to normalize ordering.

*Call graph*: called by 2 (semantic_signature, sorted_writable_roots).


##### `sorted_writable_roots`  (lines 1561–1570)

```
fn sorted_writable_roots(mut roots: Vec<WritableRoot>) -> Vec<WritableRoot>
```

**Purpose**: Sorts writable roots and normalizes the ordering of each root’s read-only subpaths and protected metadata names. This produces a stable representation for semantic comparison.

**Data flow**: Consumes `Vec<WritableRoot>`, for each root sorts `read_only_subpaths` with `sorted_absolute_paths`, sorts and deduplicates `protected_metadata_names`, then sorts the roots by `root.as_path()`. It returns the normalized vector.

**Call relations**: Used only by `semantic_signature` to make writable-root comparison order-insensitive.

*Call graph*: calls 1 internal fn (sorted_absolute_paths); called by 1 (semantic_signature); 1 external calls (take).


##### `normalize_effective_absolute_path`  (lines 1572–1591)

```
fn normalize_effective_absolute_path(path: AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Normalizes an absolute path to its effective canonical form while preserving unresolved suffixes under the first existing ancestor. This helps deduplicate symlink aliases without requiring the full path to exist.

**Data flow**: Consumes an `AbsolutePathBuf`, iterates its ancestors from leaf to root, skips missing ancestors, canonicalizes the first existing ancestor with `canonicalize_preserving_symlinks`, rejoins the original suffix under that normalized ancestor, and returns the resulting absolute path if successful; otherwise it returns the original path unchanged.

**Call relations**: Used by `dedup_absolute_paths` when effective-path normalization is requested.

*Call graph*: calls 2 internal fn (from_absolute_path, to_path_buf); called by 1 (dedup_absolute_paths); 2 external calls (canonicalize_preserving_symlinks, symlink_metadata).


##### `default_read_only_subpaths_for_writable_root`  (lines 1593–1630)

```
fn default_read_only_subpaths_for_writable_root(
    writable_root: &AbsolutePathBuf,
    protect_missing_dot_codex: bool,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Computes the default protected metadata subpaths that should remain read-only under a writable root. It handles `.git` directories and gitdir pointer files, existing `.agents`, and `.codex`, optionally protecting a missing top-level `.codex` for the workspace root.

**Data flow**: Borrows a writable root and `protect_missing_dot_codex`. It inspects `<root>/.git`, adding the gitdir target when `.git` is a pointer file and exists, and always adding `.git` itself when it is a file or directory. It adds `<root>/.agents` when that directory exists. It adds `<root>/.codex` when `protect_missing_dot_codex` is true or the directory exists. Finally it deduplicates the collected paths without effective-path normalization and returns them.

**Call relations**: Used by workspace-write policy construction, legacy-policy expansion, writable-root derivation, and legacy workspace-root widening.

*Call graph*: calls 4 internal fn (dedup_absolute_paths, is_git_pointer_file, resolve_gitdir_from_file, join); called by 5 (from_legacy_sandbox_policy_for_cwd, with_additional_legacy_workspace_writable_roots, workspace_write, legacy_runtime_file_system_policy_for_cwd, legacy_workspace_write_projection_accepts_relative_cwd); 1 external calls (new).


##### `legacy_runtime_file_system_policy_for_cwd`  (lines 1639–1711)

```
fn legacy_runtime_file_system_policy_for_cwd(
    sandbox_policy: &SandboxPolicy,
    cwd: &Path,
) -> FileSystemSandboxPolicy
```

**Purpose**: Reconstructs the concrete filesystem policy that legacy sandbox runtimes actually enforce for a given cwd. Unlike the richer profile projection, it intentionally omits symbolic project-root metadata carveouts that legacy runtimes cannot represent.

**Data flow**: Borrows a legacy `SandboxPolicy` and `cwd`. Non-`WorkspaceWrite` policies delegate to `FileSystemSandboxPolicy::from`. For `WorkspaceWrite`, it builds entries for root-read, project-roots-write, optional `SlashTmp` and `Tmpdir` writes, and exact writable roots, then appends default read-only protected subpaths for the cwd root and each explicit writable root. It returns `FileSystemSandboxPolicy::restricted(entries)`.

**Call relations**: Used by `needs_direct_runtime_enforcement` and tests to compare rich policy semantics against what legacy runtimes can actually enforce.

*Call graph*: calls 5 internal fn (from, restricted, append_default_read_only_path_if_no_explicit_rule, default_read_only_subpaths_for_writable_root, from_absolute_path); called by 4 (needs_direct_runtime_enforcement, legacy_projection_runtime_enforcement_ignores_entry_order, missing_symbolic_metadata_carveouts_need_direct_runtime_enforcement, split_only_nested_carveouts_need_direct_runtime_enforcement); 1 external calls (vec!).


##### `append_default_read_only_project_root_subpath_if_no_explicit_rule`  (lines 1713–1723)

```
fn append_default_read_only_project_root_subpath_if_no_explicit_rule(
    entries: &mut Vec<FileSystemSandboxEntry>,
    subpath: impl Into<PathBuf>,
)
```

**Purpose**: Adds a default read-only `ProjectRoots` subpath entry only when no explicit rule already targets the same location. This avoids duplicating or overriding user-specified rules.

**Data flow**: Mutably borrows an entry vector and consumes a subpath, wraps the subpath as `FileSystemPath::Special { value: ProjectRoots { subpath: Some(...) } }`, and delegates insertion to `append_default_read_only_entry_if_no_explicit_rule`.

**Call relations**: Used by `workspace_write` when adding default symbolic protected metadata carveouts under project roots.

*Call graph*: calls 1 internal fn (append_default_read_only_entry_if_no_explicit_rule); called by 1 (workspace_write); 2 external calls (into, project_roots).


##### `append_default_read_only_path_if_no_explicit_rule`  (lines 1725–1730)

```
fn append_default_read_only_path_if_no_explicit_rule(
    entries: &mut Vec<FileSystemSandboxEntry>,
    path: AbsolutePathBuf,
)
```

**Purpose**: Adds a default read-only exact-path entry only when no explicit rule already targets the same location. This preserves user overrides for protected metadata paths.

**Data flow**: Mutably borrows an entry vector and consumes an `AbsolutePathBuf`, wraps it as `FileSystemPath::Path { path }`, and delegates insertion to `append_default_read_only_entry_if_no_explicit_rule`.

**Call relations**: Used by workspace-write construction, legacy-policy expansion, and legacy writable-root widening when adding protected metadata carveouts.

*Call graph*: calls 1 internal fn (append_default_read_only_entry_if_no_explicit_rule); called by 4 (from_legacy_sandbox_policy_for_cwd, with_additional_legacy_workspace_writable_roots, workspace_write, legacy_runtime_file_system_policy_for_cwd).


##### `append_default_read_only_entry_if_no_explicit_rule`  (lines 1732–1747)

```
fn append_default_read_only_entry_if_no_explicit_rule(
    entries: &mut Vec<FileSystemSandboxEntry>,
    path: FileSystemPath,
)
```

**Purpose**: Adds a read-only entry only when no existing entry already targets the same exact location. This is the shared duplicate-avoidance helper for default carveout insertion.

**Data flow**: Mutably borrows an entry vector and consumes a `FileSystemPath`. It scans existing entries with `file_system_paths_share_target`; if any match, it returns without change. Otherwise it pushes `FileSystemSandboxEntry { path, access: Read }`.

**Call relations**: Called by both exact-path and project-root-subpath default insertion helpers.

*Call graph*: called by 2 (append_default_read_only_path_if_no_explicit_rule, append_default_read_only_project_root_subpath_if_no_explicit_rule).


##### `has_explicit_resolved_path_entry`  (lines 1749–1754)

```
fn has_explicit_resolved_path_entry(
    entries: &[ResolvedFileSystemEntry],
    path: &AbsolutePathBuf,
) -> bool
```

**Purpose**: Checks whether a resolved-entry list already contains an exact path entry for a given absolute path. This is used to avoid adding redundant default carveouts.

**Data flow**: Borrows a slice of `ResolvedFileSystemEntry` and an `AbsolutePathBuf`, scans for any entry whose `path` equals the target, and returns the resulting `bool`.

**Call relations**: Used by writable-root derivation when filtering default protected subpaths that are already explicitly represented.

*Call graph*: 1 external calls (iter).


##### `metadata_path_name`  (lines 1756–1761)

```
fn metadata_path_name(name: &OsStr) -> Option<&'static str>
```

**Purpose**: Returns the protected metadata name string when an `OsStr` matches one of the protected metadata basenames. It is the option-returning counterpart to `is_protected_metadata_name`.

**Data flow**: Borrows an `&OsStr`, scans `PROTECTED_METADATA_PATH_NAMES`, and returns `Some(&'static str)` for the matching name or `None` otherwise.

**Call relations**: Used by metadata-root detection to recover the canonical metadata name string for reporting and path construction.


##### `metadata_child_of_writable_root`  (lines 1763–1779)

```
fn metadata_child_of_writable_root(
    policy: &FileSystemSandboxPolicy,
    target: &Path,
    cwd: &Path,
) -> Option<(AbsolutePathBuf, &'static str)>
```

**Purpose**: Determines whether a target path lies under a writable root’s protected metadata child and, if so, returns that protected metadata path plus its name. This is the core helper for metadata-write protection.

**Data flow**: Borrows a policy, target path, and cwd. It resolves writable entries with `resolved_entries_with_cwd(cwd)`, filters for writable entries, strips each writable root prefix from the target, inspects the first remaining path component, maps it through `metadata_path_name`, and returns the first matching `(entry.path.join(metadata_name), metadata_name)` pair.

**Call relations**: Used by `is_metadata_write_denied` and `forbidden_agent_metadata_write` to detect writes into protected metadata under writable roots.

*Call graph*: calls 1 internal fn (resolved_entries_with_cwd); called by 2 (is_metadata_write_denied, forbidden_agent_metadata_write).


##### `protected_metadata_names_for_writable_root`  (lines 1781–1804)

```
fn protected_metadata_names_for_writable_root(
    policy: &FileSystemSandboxPolicy,
    root: &AbsolutePathBuf,
    raw_writable_roots: &[&AbsolutePathBuf],
    cwd: &Path,
) -> Vec<String>
```

**Purpose**: Computes which protected metadata names should be considered protected for a given writable root, taking into account raw writable-root aliases and explicit metadata write grants. A metadata name is protected only if all candidate metadata paths under that root remain non-writable.

**Data flow**: Borrows a policy, normalized writable root, raw writable-root aliases, and cwd. For each protected metadata name it builds candidate metadata paths under the normalized root and each raw alias, checks whether all of them fail `policy.can_write_path_with_cwd(...)`, and if so pushes the metadata name string into the result vector. It returns the collected names.

**Call relations**: Used by `get_writable_roots_with_cwd` when constructing `WritableRoot` values for downstream sandbox backends.

*Call graph*: 3 external calls (new, iter, vec!).


##### `protected_metadata_names_need_direct_runtime_enforcement`  (lines 1806–1834)

```
fn protected_metadata_names_need_direct_runtime_enforcement(
    policy: &FileSystemSandboxPolicy,
    legacy_policy: &SandboxPolicy,
    cwd: &Path,
) -> bool
```

**Purpose**: Checks whether the richer policy’s protected metadata-name semantics cannot be represented by the bridged legacy writable-root projection. This is one of the reasons direct runtime enforcement may be required.

**Data flow**: Borrows a rich policy, bridged legacy `SandboxPolicy`, and cwd. It gets writable roots from both policies, then for each rich writable root either returns true if no matching legacy root exists while protected metadata names are present, or checks whether each protected metadata name corresponds to a read-only subpath in the legacy root. It returns true on the first mismatch.

**Call relations**: Used by `needs_direct_runtime_enforcement` as a specialized semantic mismatch check focused on metadata protection.

*Call graph*: calls 1 internal fn (get_writable_roots_with_cwd); called by 1 (needs_direct_runtime_enforcement); 1 external calls (get_writable_roots_with_cwd).


##### `has_explicit_write_entry_for_metadata_path`  (lines 1836–1850)

```
fn has_explicit_write_entry_for_metadata_path(
    policy: &FileSystemSandboxPolicy,
    protected_metadata_path: &AbsolutePathBuf,
    target: &Path,
    cwd: &Path,
) -> bool
```

**Purpose**: Checks whether the policy contains an explicit write entry that targets a protected metadata path or one of its descendants. This is how callers distinguish intentional metadata writes from default-protected ones.

**Data flow**: Borrows a policy, protected metadata path, target path, and cwd. It resolves entries with `resolved_entries_with_cwd(cwd)` and returns true if any writable entry both prefixes the target path and itself lies under the protected metadata path.

**Call relations**: Used by `is_metadata_write_denied` and `forbidden_agent_metadata_write` to exempt explicitly granted metadata writes from default protection.

*Call graph*: calls 1 internal fn (resolved_entries_with_cwd); called by 2 (is_metadata_write_denied, forbidden_agent_metadata_write).


##### `is_git_pointer_file`  (lines 1852–1855)

```
fn is_git_pointer_file(path: &AbsolutePathBuf) -> bool
```

**Purpose**: Returns whether a `.git` path is a gitdir pointer file rather than a directory. This matters because the actual git metadata may live elsewhere and should also be protected.

**Data flow**: Borrows an `AbsolutePathBuf`, checks that it is a file and that its basename is `.git`, and returns the resulting `bool`.

**Call relations**: Used by `default_read_only_subpaths_for_writable_root` before attempting to resolve a gitdir pointer.

*Call graph*: calls 1 internal fn (as_path); called by 1 (default_read_only_subpaths_for_writable_root); 1 external calls (new).


##### `resolve_gitdir_from_file`  (lines 1857–1914)

```
fn resolve_gitdir_from_file(dot_git: &AbsolutePathBuf) -> Option<AbsolutePathBuf>
```

**Purpose**: Parses a `.git` pointer file of the form `gitdir: <path>` and resolves the referenced gitdir path relative to the file’s parent directory. It logs errors and returns `None` on malformed content or missing targets.

**Data flow**: Borrows a `.git` file path, reads it to string, trims whitespace, splits once on `:`, validates that the prefix is `gitdir`, trims the target path, resolves it against the `.git` file’s parent with `AbsolutePathBuf::resolve_path_against_base`, checks that the resolved path exists, and returns `Some(gitdir_path)` or `None` while logging detailed errors with `tracing::error!` on failure.

**Call relations**: Used by `default_read_only_subpaths_for_writable_root` so git worktrees and submodules protect the real gitdir target in addition to the `.git` pointer file.

*Call graph*: calls 2 internal fn (as_path, resolve_path_against_base); called by 1 (default_read_only_subpaths_for_writable_root); 2 external calls (error!, read_to_string).


##### `tests::symlink_dir`  (lines 1929–1931)

```
fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()>
```

**Purpose**: Creates a directory symlink on Unix for use in symlink-sensitive permission tests. It is a tiny fixture helper.

**Data flow**: Borrows `original` and `link` paths and calls `std::os::unix::fs::symlink(original, link)`, returning the resulting `io::Result<()>`.

**Call relations**: Used by multiple Unix-only tests that verify symlink-preserving writable-root and deny-read behavior.

*Call graph*: 1 external calls (symlink).


##### `tests::unknown_special_paths_are_ignored_by_legacy_bridge`  (lines 1934–1965)

```
fn unknown_special_paths_are_ignored_by_legacy_bridge() -> std::io::Result<()>
```

**Purpose**: Verifies that unknown special-path tokens do not break legacy bridging and are simply ignored when converting to `SandboxPolicy`. This preserves forward compatibility.

**Data flow**: Builds a restricted policy containing root-read and an unknown special-path write entry, converts it with `to_legacy_sandbox_policy`, and asserts the result is legacy read-only with restricted network.

**Call relations**: Run by the test harness as a compatibility test for unknown special paths.

*Call graph*: calls 1 internal fn (restricted); 3 external calls (new, assert_eq!, vec!).


##### `tests::writable_roots_proactively_protect_missing_dot_codex`  (lines 1969–1992)

```
fn writable_roots_proactively_protect_missing_dot_codex()
```

**Purpose**: Checks that a writable project-root policy proactively includes `.codex` as a protected read-only subpath even when the directory does not yet exist. This ensures first-time creation still goes through approval flow.

**Data flow**: Creates a temp cwd, builds a restricted policy with `ProjectRoots` write access, calls `get_writable_roots_with_cwd`, and asserts the single writable root equals the canonical cwd and contains `<cwd>/.codex` in `read_only_subpaths`.

**Call relations**: Executed by the test harness as a regression test for proactive `.codex` protection.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::legacy_workspace_write_projection_preserves_symbolic_project_root`  (lines 1995–2038)

```
fn legacy_workspace_write_projection_preserves_symbolic_project_root()
```

**Purpose**: Verifies that projecting a legacy workspace-write policy into `FileSystemSandboxPolicy` preserves symbolic `ProjectRoots` entries and symbolic protected metadata carveouts rather than immediately materializing them.

**Data flow**: Builds a legacy `SandboxPolicy::WorkspaceWrite` with no extra writable roots and both tmpdir exclusions enabled, converts it with `FileSystemSandboxPolicy::from`, and asserts exact equality with the expected restricted policy containing root-read, project-roots-write, and symbolic read-only `.git`, `.agents`, and `.codex` project-root subpaths.

**Call relations**: Run by the test harness as a projection test for the basic legacy-to-filesystem-policy bridge.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::legacy_current_working_directory_special_path_deserializes_as_project_roots`  (lines 2041–2059)

```
fn legacy_current_working_directory_special_path_deserializes_as_project_roots() -> serde_json::Result<()>
```

**Purpose**: Checks that the legacy special-path token `current_working_directory` deserializes as `ProjectRoots` and reserializes using the modern `project_roots` spelling. This preserves backward compatibility while normalizing output.

**Data flow**: Deserializes JSON `{ "kind": "current_working_directory" }` into `FileSystemSpecialPath`, asserts equality with `project_roots(None)`, serializes it back to JSON, and asserts the output uses `{ "kind": "project_roots" }`.

**Call relations**: Executed by the test harness as a serde compatibility test for special-path aliases.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::writable_roots_skip_default_dot_codex_when_explicit_user_rule_exists`  (lines 2063–2109)

```
fn writable_roots_skip_default_dot_codex_when_explicit_user_rule_exists()
```

**Purpose**: Verifies that an explicit user write rule for `.codex` suppresses the default protected `.codex` carveout and metadata-name protection. Explicit metadata grants should win over defaults.

**Data flow**: Creates a temp cwd, builds a restricted policy with project-root write plus an explicit exact-path write entry for `<cwd>/.codex`, calls `get_writable_roots_with_cwd`, finds the workspace root, and asserts `.codex` is absent from both `protected_metadata_names` and `read_only_subpaths`; it also asserts `can_write_path_with_cwd(<cwd>/.codex/config.toml)` is true.

**Call relations**: Run by the test harness as a regression test for explicit metadata-write overrides.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 3 external calls (new, assert!, vec!).


##### `tests::filesystem_policy_blocks_protected_metadata_path_writes_by_default`  (lines 2112–2141)

```
fn filesystem_policy_blocks_protected_metadata_path_writes_by_default()
```

**Purpose**: Checks that a broad writable-root policy still blocks writes into `.git`, `.agents`, and `.codex` by default and reports those names as protected metadata. This is the core metadata-protection behavior.

**Data flow**: Creates a temp cwd, builds a restricted policy with one exact-path write entry for the cwd root, asserts `can_write_path_with_cwd` is false for paths under `.git`, `.agents`, and `.codex`, then calls `get_writable_roots_with_cwd` and asserts the single writable root lists all three protected metadata names and rejects those paths via `WritableRoot::is_path_writable`.

**Call relations**: Executed by the test harness as the main default metadata-protection test.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::legacy_workspace_write_projection_accepts_relative_cwd`  (lines 2144–2218)

```
fn legacy_workspace_write_projection_accepts_relative_cwd()
```

**Purpose**: Verifies that cwd-relative paths are accepted when expanding a legacy workspace-write policy and that protected metadata under the resolved cwd remains blocked. This covers relative-cwd compatibility.

**Data flow**: Uses a relative cwd path, computes the expected absolute root from `current_dir()`, converts a legacy workspace-write policy with `from_legacy_sandbox_policy_for_cwd`, builds the expected entry list including symbolic and exact protected metadata carveouts, asserts equality, and then checks `forbidden_agent_metadata_write` and `can_write_path_with_cwd` for `.git`, `.codex`, and `.agents` descendants.

**Call relations**: Run by the test harness as a cwd-resolution and metadata-protection regression test.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_for_cwd, default_read_only_subpaths_for_writable_root, from_absolute_path); 5 external calls (new, assert!, assert_eq!, current_dir, vec!).


##### `tests::effective_runtime_roots_preserve_symlinked_paths`  (lines 2222–2269)

```
fn effective_runtime_roots_preserve_symlinked_paths()
```

**Purpose**: Checks that writable-root and unreadable-root projections preserve symlink-visible paths rather than collapsing everything to canonical targets. Downstream sandboxes need the user-visible symlink paths to mask the correct inodes.

**Data flow**: Creates a real directory, a symlinked root, a denied child, and a `.codex` directory under the real root; builds a restricted policy with write access to the symlinked root and deny access to the symlinked child; asserts `get_unreadable_roots_with_cwd` returns the symlinked denied path and `get_writable_roots_with_cwd` returns the symlinked root with both the symlinked denied child and symlinked `.codex` in `read_only_subpaths`.

**Call relations**: Executed by the test harness as a symlink-preservation test for effective runtime roots.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::project_roots_special_path_preserves_symlinked_root`  (lines 2273–2340)

```
fn project_roots_special_path_preserves_symlinked_root()
```

**Purpose**: Verifies that symbolic `ProjectRoots` write access resolves to the symlinked cwd path, not just its canonical target, and that explicit deny carveouts and protected metadata remain symlink-visible.

**Data flow**: Creates a real root, symlinked cwd, denied child, `.agents`, and `.codex`; builds a restricted policy with `Minimal` read, `ProjectRoots` write, and an exact deny entry for the symlinked denied child; asserts readable roots, unreadable roots, and writable-root carveouts all use the symlinked paths.

**Call relations**: Run by the test harness as the symbolic-project-root counterpart to the previous symlink-preservation test.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::writable_roots_preserve_symlinked_protected_subpaths`  (lines 2344–2380)

```
fn writable_roots_preserve_symlinked_protected_subpaths()
```

**Purpose**: Checks that protected metadata carveouts under a writable root preserve the literal symlink path itself rather than only the canonical target. This matters when `.codex` is a symlink.

**Data flow**: Creates a root, a decoy directory, and a `.codex` symlink pointing to the decoy; builds a restricted policy granting write access to the root; calls `get_writable_roots_with_cwd`; and asserts the sole read-only subpath is the symlink-visible `.codex` path, not the canonical decoy path.

**Call relations**: Executed by the test harness as a focused symlink-preservation test for protected metadata carveouts.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::writable_roots_preserve_explicit_symlinked_carveouts_under_symlinked_roots`  (lines 2384–2426)

```
fn writable_roots_preserve_explicit_symlinked_carveouts_under_symlinked_roots()
```

**Purpose**: Verifies that explicit deny carveouts under a symlinked writable root preserve the literal in-root symlink path rather than canonicalizing to the target. This lets downstream sandboxes mask the symlink inode itself.

**Data flow**: Creates a real root, symlinked root, decoy directory, and a symlinked private path under the real root; builds a restricted policy with write access to the symlinked root and deny access to the symlinked private path; calls `get_writable_roots_with_cwd`; and asserts the read-only subpaths contain the symlink-visible private path but not the canonical decoy path.

**Call relations**: Run by the test harness as a symlink-carveout preservation test.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::writable_roots_preserve_explicit_symlinked_carveouts_that_escape_root`  (lines 2430–2473)

```
fn writable_roots_preserve_explicit_symlinked_carveouts_that_escape_root()
```

**Purpose**: Checks that explicit deny carveouts under a symlinked writable root still preserve the literal in-root symlink path even when the symlink target escapes outside the root. The visible path must remain maskable.

**Data flow**: Creates a real root, symlinked root, an outside directory, and a symlinked private path under the real root pointing outside; builds a restricted policy with write access to the symlinked root and deny access to the symlinked private path; calls `get_writable_roots_with_cwd`; and asserts the read-only subpaths contain the symlink-visible path but not the canonical outside target.

**Call relations**: Executed by the test harness as another symlink-carveout preservation regression test.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::writable_roots_preserve_explicit_symlinked_carveouts_that_alias_root`  (lines 2477–2507)

```
fn writable_roots_preserve_explicit_symlinked_carveouts_that_alias_root()
```

**Purpose**: Verifies that explicit deny carveouts that symlink back to the writable root itself are still preserved as literal in-root paths. This avoids losing the alias path in downstream masking.

**Data flow**: Creates a root and an `alias-root` symlink pointing back to the root, builds a restricted policy with write access to the root and deny access to the alias path, calls `get_writable_roots_with_cwd`, and asserts the writable root is the canonical root while the read-only subpath is the alias path under that root.

**Call relations**: Run by the test harness as the alias-root variant of symlink-carveout preservation.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (new, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::tmpdir_special_path_preserves_symlinked_tmpdir`  (lines 2511–2581)

```
fn tmpdir_special_path_preserves_symlinked_tmpdir()
```

**Purpose**: Checks that the `Tmpdir` special path preserves a symlinked `TMPDIR` path in writable-root and unreadable-root projections. This ensures downstream sandboxes see the user-visible tmpdir path.

**Data flow**: On Unix, reruns itself in a subprocess with a test env var to isolate `TMPDIR`, creates a real tmpdir, symlinked tmpdir, denied child, and `.codex`, sets `TMPDIR` to the symlinked path, builds a restricted policy with `Tmpdir` write and an exact deny entry for the symlinked denied child, and asserts unreadable roots and writable-root carveouts use the symlinked tmpdir paths.

**Call relations**: Executed by the test harness as the tmpdir-specific symlink-preservation test.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 10 external calls (new, assert!, assert_eq!, new, create_dir_all, symlink_dir, current_exe, set_var, var_os, vec!).


##### `tests::resolve_access_with_cwd_uses_most_specific_entry`  (lines 2584–2631)

```
fn resolve_access_with_cwd_uses_most_specific_entry()
```

**Purpose**: Verifies the core access-resolution rule that the most specific matching entry wins, with deeper paths overriding broader ones. This covers write, read, deny, and re-widened write cases.

**Data flow**: Creates a temp cwd and exact paths for `docs`, `docs/private`, and `docs/private/public`; builds a restricted policy with project-root write, `docs` read, `docs/private` deny, and `docs/private/public` write; then asserts `resolve_access_with_cwd` returns `Write` for the cwd root, `Read` for `docs`, `Deny` for `docs/private`, and `Write` for `docs/private/public`.

**Call relations**: Run by the test harness as the main semantic test for access precedence.

*Call graph*: calls 2 internal fn (restricted, resolve_path_against_base); 3 external calls (new, assert_eq!, vec!).


##### `tests::split_only_nested_carveouts_need_direct_runtime_enforcement`  (lines 2634–2663)

```
fn split_only_nested_carveouts_need_direct_runtime_enforcement()
```

**Purpose**: Checks that policies with nested carveouts under a writable project root require direct runtime enforcement because legacy workspace-write projection cannot express them faithfully. It also confirms metadata-name protections independently require direct enforcement.

**Data flow**: Creates a temp cwd and a `docs` path, builds a restricted policy with project-root write plus an exact `docs` read carveout, asserts `needs_direct_runtime_enforcement(...)` is true, then builds the legacy runtime projection for a default workspace-write policy and asserts that it too still requires direct enforcement because metadata-name protections remain outside the legacy contract.

**Call relations**: Executed by the test harness as a direct-enforcement classification test.

*Call graph*: calls 3 internal fn (restricted, legacy_runtime_file_system_policy_for_cwd, resolve_path_against_base); 4 external calls (new, new_workspace_write_policy, assert!, vec!).


##### `tests::legacy_projection_runtime_enforcement_ignores_entry_order`  (lines 2666–2690)

```
fn legacy_projection_runtime_enforcement_ignores_entry_order()
```

**Purpose**: Verifies that semantic equivalence and direct-enforcement classification are insensitive to entry ordering. Reversing the entry list should not change meaning.

**Data flow**: Builds the legacy runtime filesystem policy for a workspace-write sandbox, clones and reverses its entries, wraps the reversed list in a restricted policy, and asserts `is_semantically_equivalent_to` is true and `needs_direct_runtime_enforcement` returns the same value for both policies.

**Call relations**: Run by the test harness as an order-insensitivity regression test.

*Call graph*: calls 2 internal fn (restricted, legacy_runtime_file_system_policy_for_cwd); 4 external calls (new, new, assert!, assert_eq!).


##### `tests::missing_symbolic_metadata_carveouts_need_direct_runtime_enforcement`  (lines 2693–2717)

```
fn missing_symbolic_metadata_carveouts_need_direct_runtime_enforcement()
```

**Purpose**: Checks that both the richer profile projection and the legacy runtime projection still require direct runtime enforcement because symbolic metadata protections for missing paths cannot be represented by legacy writable-root semantics alone.

**Data flow**: Builds a legacy workspace-write policy, projects it with `from_legacy_sandbox_policy_for_cwd` and `legacy_runtime_file_system_policy_for_cwd`, and asserts `needs_direct_runtime_enforcement(...)` is true for both.

**Call relations**: Executed by the test harness as a regression test for metadata-name direct-enforcement requirements.

*Call graph*: calls 2 internal fn (from_legacy_sandbox_policy_for_cwd, legacy_runtime_file_system_policy_for_cwd); 3 external calls (new, new, assert!).


##### `tests::root_write_with_read_only_child_is_not_full_disk_write`  (lines 2720–2749)

```
fn root_write_with_read_only_child_is_not_full_disk_write()
```

**Purpose**: Verifies that a root-write policy with a narrower read-only child is not considered full-disk write access and cannot be bridged to legacy sandbox policy. The child carveout meaningfully narrows writes.

**Data flow**: Creates a temp cwd and a `docs` path, builds a restricted policy with root-write and exact `docs` read, asserts `has_full_disk_write_access()` is false, asserts `resolve_access_with_cwd(docs)` is `Read`, asserts `needs_direct_runtime_enforcement(...)` is true, and asserts `to_legacy_sandbox_policy(...)` returns an error.

**Call relations**: Run by the test harness as a key regression test for write-narrowing semantics.

*Call graph*: calls 2 internal fn (restricted, resolve_path_against_base); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::root_deny_does_not_materialize_as_unreadable_root`  (lines 2752–2783)

```
fn root_deny_does_not_materialize_as_unreadable_root()
```

**Purpose**: Checks that a root-level deny entry does not appear as an unreadable root in projections, because doing so would erase narrower readable carveouts when downstream sandboxes apply deny masks. Narrower readable paths must survive.

**Data flow**: Creates a temp cwd and a `docs` path, builds a restricted policy with root-deny and exact `docs` read, asserts `resolve_access_with_cwd(docs)` is `Read`, asserts `get_readable_roots_with_cwd` returns the canonical `docs` path, and asserts `get_unreadable_roots_with_cwd` is empty.

**Call relations**: Executed by the test harness as a regression test for unreadable-root projection semantics.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_path_against_base); 5 external calls (new, assert!, assert_eq!, canonicalize_preserving_symlinks, vec!).


##### `tests::duplicate_root_deny_prevents_full_disk_write_access`  (lines 2786–2811)

```
fn duplicate_root_deny_prevents_full_disk_write_access()
```

**Purpose**: Verifies that adding a root-level deny alongside a root-level write prevents the policy from counting as full-disk write access. The deny entry wins at equal specificity because of access precedence.

**Data flow**: Creates a temp cwd and resolves the filesystem root, builds a restricted policy with root-write and root-deny entries, asserts `has_full_disk_write_access()` is false, and asserts `resolve_access_with_cwd(root)` returns `Deny`.

**Call relations**: Run by the test harness as a precedence test for duplicate root entries.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::same_specificity_write_override_keeps_full_disk_write_access`  (lines 2814–2839)

```
fn same_specificity_write_override_keeps_full_disk_write_access()
```

**Purpose**: Checks that an exact-path write entry shadowing an exact-path read entry at the same target prevents that read entry from narrowing full-disk write access. Shadowed carveouts should not affect semantics.

**Data flow**: Creates a temp cwd and a `docs` path, builds a restricted policy with root-write, exact `docs` read, and exact `docs` write, asserts `has_full_disk_write_access()` is true, and asserts `resolve_access_with_cwd(docs)` returns `Write`.

**Call relations**: Executed by the test harness as a regression test for same-target write overrides.

*Call graph*: calls 2 internal fn (restricted, resolve_path_against_base); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::with_additional_readable_roots_skips_existing_effective_access`  (lines 2842–2857)

```
fn with_additional_readable_roots_skips_existing_effective_access()
```

**Purpose**: Verifies that adding an already-readable root does not change the policy. Effective access, not just structural presence, controls whether a new entry is needed.

**Data flow**: Creates a temp cwd and exact cwd root, builds a restricted policy with `ProjectRoots` read access, calls `with_additional_readable_roots(cwd, &[cwd_root])`, and asserts the result equals the original policy.

**Call relations**: Run by the test harness as a widening-noop test for additional readable roots.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert_eq!, from_ref, vec!).


##### `tests::with_additional_writable_roots_skips_existing_effective_access`  (lines 2860–2875)

```
fn with_additional_writable_roots_skips_existing_effective_access()
```

**Purpose**: Checks that adding an already-writable root does not change the policy. This mirrors the readable-root widening behavior for writes.

**Data flow**: Creates a temp cwd and exact cwd root, builds a restricted policy with `ProjectRoots` write access, calls `with_additional_writable_roots(cwd, &[cwd_root])`, and asserts the result equals the original policy.

**Call relations**: Executed by the test harness as a widening-noop test for additional writable roots.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert_eq!, from_ref, vec!).


##### `tests::with_additional_writable_roots_adds_new_root`  (lines 2878–2907)

```
fn with_additional_writable_roots_adds_new_root()
```

**Purpose**: Verifies that `with_additional_writable_roots` appends a new exact-path write entry when the root is not already writable. This is the positive-path widening case.

**Data flow**: Creates a temp workspace cwd and an extra absolute root, builds a restricted policy with `ProjectRoots` write access, calls `with_additional_writable_roots(&cwd, &[extra])`, and asserts the result equals the expected restricted policy containing both the symbolic project-root write and the exact extra-root write entry.

**Call relations**: Run by the test harness as the positive-path test for writable-root widening.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert_eq!, from_ref, vec!).


##### `tests::materialize_project_roots_with_workspace_roots_expands_exact_and_glob_entries`  (lines 2910–2991)

```
fn materialize_project_roots_with_workspace_roots_expands_exact_and_glob_entries()
```

**Purpose**: Checks that materializing project roots across multiple workspace roots expands both exact symbolic entries and project-root-prefixed glob entries. Each workspace root should receive its own concrete entries.

**Data flow**: Creates two absolute workspace roots, builds a restricted policy with symbolic project-root write, symbolic `.git` read, and a project-root-prefixed deny glob, calls `materialize_project_roots_with_workspace_roots(&[first, second])`, and asserts exact equality with the expected expanded restricted policy containing concrete path and glob entries for both roots.

**Call relations**: Executed by the test harness as the main multi-root materialization test.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 3 external calls (new, assert_eq!, vec!).


##### `tests::materialize_project_roots_with_cwd_expands_symbolic_glob_entries`  (lines 2994–3016)

```
fn materialize_project_roots_with_cwd_expands_symbolic_glob_entries()
```

**Purpose**: Verifies that cwd-based materialization rewrites project-root-prefixed glob entries into concrete absolute glob strings under the cwd.

**Data flow**: Creates a temp cwd, builds a restricted policy with one project-root-prefixed deny glob, calls `materialize_project_roots_with_cwd(cwd)`, and asserts exact equality with the expected restricted policy containing the resolved absolute glob pattern.

**Call relations**: Run by the test harness as the cwd-based glob-materialization test.

*Call graph*: calls 1 internal fn (restricted); 3 external calls (new, assert_eq!, vec!).


##### `tests::with_additional_legacy_workspace_writable_roots_protects_metadata`  (lines 3019–3057)

```
fn with_additional_legacy_workspace_writable_roots_protects_metadata()
```

**Purpose**: Checks that legacy-style writable-root widening adds both the exact write entry and default protected metadata carveouts for the new root. This distinguishes it from the leaner modern widening helper.

**Data flow**: Creates a temp extra root with a `.git` directory, builds a restricted policy with `ProjectRoots` write access, calls `with_additional_legacy_workspace_writable_roots(&[extra])`, and asserts exact equality with the expected restricted policy containing the symbolic project-root write, exact extra-root write, and exact extra-root `.git` read carveout.

**Call relations**: Executed by the test harness as the positive-path test for legacy writable-root widening.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (new, assert_eq!, create_dir_all, from_ref, vec!).


##### `tests::file_system_access_mode_orders_by_conflict_precedence`  (lines 3060–3063)

```
fn file_system_access_mode_orders_by_conflict_precedence()
```

**Purpose**: Verifies the intended ordering of `FileSystemAccessMode`: `Write > Read` and `Deny > Write`. This ordering is relied on by access-resolution tie-breaking.

**Data flow**: Asserts the enum ordering comparisons directly using `assert!`.

**Call relations**: Run by the test harness as a compact regression test for access-mode precedence.

*Call graph*: 1 external calls (assert!).


##### `tests::legacy_bridge_preserves_explicit_deny_entries`  (lines 3066–3091)

```
fn legacy_bridge_preserves_explicit_deny_entries()
```

**Purpose**: Checks that rebuilding a filesystem policy from a legacy sandbox policy while preserving deny entries actually retains the explicit deny path. This protects deny-read rules across compatibility updates.

**Data flow**: Builds an existing restricted policy containing one exact deny entry, rebuilds from a legacy workspace-write policy with `from_legacy_sandbox_policy_preserving_deny_entries`, and asserts the rebuilt policy still contains the deny entry.

**Call relations**: Executed by the test harness as a regression test for deny-entry preservation during legacy bridging.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_preserving_deny_entries, restricted, try_from); 4 external calls (new, new_workspace_write_policy, assert!, vec!).


##### `tests::preserving_deny_entries_keeps_unrestricted_policy_enforceable`  (lines 3094–3113)

```
fn preserving_deny_entries_keeps_unrestricted_policy_enforceable()
```

**Purpose**: Verifies that preserving deny-read restrictions onto an unrestricted replacement policy converts it into a restricted root-write policy plus the deny entry, keeping the deny enforceable. Unrestricted plus deny would otherwise be contradictory.

**Data flow**: Builds an existing restricted policy containing one unreadable glob and `glob_scan_max_depth = Some(2)`, starts from `FileSystemSandboxPolicy::unrestricted()`, calls `preserve_deny_read_restrictions_from(&existing)`, builds the expected restricted root-write-plus-deny policy, and asserts equality.

**Call relations**: Run by the test harness as the in-place counterpart to the previous deny-preservation test.

*Call graph*: calls 2 internal fn (restricted, unrestricted); 3 external calls (assert_eq!, unreadable_glob_entry, vec!).


##### `tests::deny_policy`  (lines 3115–3122)

```
fn deny_policy(path: &Path) -> FileSystemSandboxPolicy
```

**Purpose**: Creates a simple restricted policy containing one exact deny entry for use in deny-read matcher tests. It is a local fixture helper.

**Data flow**: Borrows a `&Path`, converts it to `AbsolutePathBuf`, wraps it in `FileSystemPath::Path`, pairs it with `FileSystemAccessMode::Deny`, and returns `FileSystemSandboxPolicy::restricted(vec![...])`.

**Call relations**: Used by several deny-read tests as a concise fixture constructor.

*Call graph*: calls 1 internal fn (restricted); 1 external calls (vec!).


##### `tests::unreadable_glob_entry`  (lines 3124–3129)

```
fn unreadable_glob_entry(pattern: String) -> FileSystemSandboxEntry
```

**Purpose**: Creates a single deny-read glob entry for use in tests. It is a tiny fixture helper.

**Data flow**: Consumes a glob pattern `String`, wraps it as `FileSystemPath::GlobPattern { pattern }` with `access: Deny`, and returns the `FileSystemSandboxEntry`.

**Call relations**: Used by tests that build policies containing deny-read glob entries.


##### `tests::default_policy_with_unreadable_glob`  (lines 3131–3135)

```
fn default_policy_with_unreadable_glob(pattern: String) -> FileSystemSandboxPolicy
```

**Purpose**: Builds the default read-only policy and appends one deny-read glob entry. This is a convenience fixture for glob-matching tests.

**Data flow**: Consumes a glob pattern `String`, starts from `FileSystemSandboxPolicy::default()`, pushes `unreadable_glob_entry(pattern)` into `policy.entries`, and returns the policy.

**Call relations**: Used by multiple deny-read glob tests as a concise fixture constructor.

*Call graph*: calls 1 internal fn (default); 1 external calls (unreadable_glob_entry).


##### `tests::is_read_denied`  (lines 3137–3144)

```
fn is_read_denied(
        path: &Path,
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
    ) -> bool
```

**Purpose**: Convenience helper that builds a `ReadDenyMatcher` from a policy and asks whether a path is denied. It hides the optional matcher construction from individual tests.

**Data flow**: Borrows a path, policy, and cwd, calls `ReadDenyMatcher::new(file_system_sandbox_policy, cwd)`, and if a matcher exists calls `matcher.is_read_denied(path)`, otherwise returns false via `Option::is_some_and`.

**Call relations**: Used by all deny-read matcher tests in this module.

*Call graph*: calls 1 internal fn (new).


##### `tests::exact_path_and_descendants_are_denied`  (lines 3147–3162)

```
fn exact_path_and_descendants_are_denied()
```

**Purpose**: Verifies that an exact deny path blocks both the path itself and descendants, but not unrelated siblings. This is the basic subtree-deny behavior.

**Data flow**: Creates a temp directory with a denied subdirectory and nested file, builds a deny policy for the denied directory, and asserts `is_read_denied` is true for the directory and nested file but false for an unrelated file.

**Call relations**: Run by the test harness as the simplest deny-read matcher test.

*Call graph*: 5 external calls (new, assert!, deny_policy, create_dir_all, write).


##### `tests::canonical_target_matches_denied_symlink_alias`  (lines 3166–3179)

```
fn canonical_target_matches_denied_symlink_alias()
```

**Purpose**: Checks that deny-read matching catches symlink aliases by comparing canonical targets as well as lexical paths. A deny on the real path should also block reads through a symlink alias.

**Data flow**: Creates a real directory, a symlink alias to it, and a file under the real directory, builds a deny policy for the real directory, and asserts `is_read_denied` is true for the file accessed through the alias path.

**Call relations**: Executed by the test harness as a symlink-aware deny-read regression test.

*Call graph*: 6 external calls (new, assert!, deny_policy, symlink_dir, create_dir_all, write).


##### `tests::literal_patterns_and_globs_are_denied`  (lines 3182–3197)

```
fn literal_patterns_and_globs_are_denied()
```

**Purpose**: Verifies that a policy can combine exact deny roots and deny globs, and that both forms are enforced. This covers mixed exact/glob deny behavior.

**Data flow**: Creates a temp literal directory and another text file, builds a deny policy for the literal directory, appends a deny glob matching `**/*.txt` under the temp root, and asserts `is_read_denied` is true for both the literal directory and the text file.

**Call relations**: Run by the test harness as a mixed exact-and-glob deny test.

*Call graph*: 7 external calls (new, assert!, format!, deny_policy, unreadable_glob_entry, create_dir_all, write).


##### `tests::glob_patterns_deny_matching_paths`  (lines 3200–3212)

```
fn glob_patterns_deny_matching_paths()
```

**Purpose**: Checks that deny-read glob patterns match intended paths. This is the basic positive-path test for glob matching.

**Data flow**: Creates a temp file `private/secret1.txt`, builds a default policy with a deny glob matching `private/secret?.txt`, and asserts `is_read_denied` is true for the file.

**Call relations**: Executed by the test harness as a simple glob-matching regression test.

*Call graph*: 6 external calls (new, assert!, format!, default_policy_with_unreadable_glob, create_dir_all, write).


##### `tests::glob_patterns_do_not_cross_path_separators`  (lines 3215–3236)

```
fn glob_patterns_do_not_cross_path_separators()
```

**Purpose**: Verifies that `*` and `?` in deny globs do not cross path separators because the matcher uses `literal_separator(true)`. This keeps glob semantics aligned with config parsing expectations.

**Data flow**: Creates several files under a temp root, builds a deny glob of the form `*/file[0-9]?.txt`, and asserts it matches only the one-level-deep numeric filename while rejecting nested, too-short, and non-numeric variants.

**Call relations**: Run by the test harness as a regression test for path-separator-sensitive glob semantics.

*Call graph*: 6 external calls (new, assert!, format!, default_policy_with_unreadable_glob, create_dir_all, write).


##### `tests::globstar_patterns_deny_root_and_nested_matches`  (lines 3239–3255)

```
fn globstar_patterns_deny_root_and_nested_matches()
```

**Purpose**: Checks that `**` deny globs match both root-level and nested paths. This validates recursive glob behavior for deny-read patterns.

**Data flow**: Creates `.env` files at the temp root and in a nested directory plus an unrelated text file, builds a deny glob `**/*.env`, and asserts `is_read_denied` is true for both `.env` files and false for the unrelated file.

**Call relations**: Executed by the test harness as the recursive-glob deny test.

*Call graph*: 6 external calls (new, assert!, format!, default_policy_with_unreadable_glob, create_dir_all, write).


##### `tests::unclosed_character_classes_match_literal_brackets`  (lines 3258–3268)

```
fn unclosed_character_classes_match_literal_brackets()
```

**Purpose**: Verifies that unclosed `[` in deny globs is treated literally rather than as a parse error or wildcard class. This matches the configured glob-builder behavior.

**Data flow**: Creates a file literally named `[` and another unrelated file, builds a deny glob ending in `/[`, and asserts `is_read_denied` is true for the bracket-named file and false for the unrelated file.

**Call relations**: Run by the test harness as a regression test for permissive glob parsing of unclosed character classes.

*Call graph*: 5 external calls (new, assert!, format!, default_policy_with_unreadable_glob, write).


### `protocol/src/models.rs`

`data_model` · `cross-cutting protocol serialization, request/response shaping, and permission projection`

This file is the protocol backbone for conversation payloads and permission metadata. On the permissions side, it defines `SandboxPermissions`, `FileSystemPermissions`, `NetworkPermissions`, `AdditionalPermissionProfile`, `SandboxEnforcement`, `ManagedFileSystemPermissions`, `PermissionProfile`, and `ActivePermissionProfile`, including conversions between legacy `SandboxPolicy`, runtime sandbox policies, and newer split filesystem/network representations. A key design choice is backward-compatible serde: `FileSystemPermissions` serializes to legacy `{read, write}` when possible, but falls back to canonical `{entries, glob_scan_max_depth}` when deny rules or glob depth make the old shape insufficient; `PermissionProfile` similarly accepts both tagged modern and legacy rollout shapes.

On the messaging side, `ResponseInputItem`, `ResponseItem`, `ContentItem`, `AgentMessageInputContent`, `MessagePhase`, and related enums model provider-facing request/response items. `ResponseItem` carries optional metadata with helper methods to read, stamp, and clear `turn_id` safely without disturbing unknown variants. The file also contains image-tag helpers and local-image conversion logic: local files are read, optionally resized/encoded for prompts, wrapped with `<image>` marker text when labeled, and degraded into explanatory `InputText` placeholders on read, decode, or unsupported-format failures. Tool-call outputs are represented by `FunctionCallOutputPayload`, which serializes as either a plain string or an array of structured content items; MCP `CallToolResult` values can be converted into that payload, preserving image outputs as `InputImage` items when possible and falling back to JSON text otherwise. Numerous tests lock down edge cases such as metadata round-tripping, image detail preservation, compaction aliases, and multimodal output serialization.

#### Function details

##### `SandboxPermissions::requires_escalated_permissions`  (lines 49–51)

```
fn requires_escalated_permissions(self) -> bool
```

**Purpose**: Returns whether the per-command sandbox override requests fully unsandboxed execution. Only `RequireEscalated` counts as escalated.

**Data flow**: Consumes `self`, pattern-matches it against `SandboxPermissions::RequireEscalated`, and returns a `bool`. It reads no external state and mutates nothing.

**Call relations**: Called by execution-policy code when deciding whether a command must bypass the sandbox entirely. It is one of three small semantic predicates over the enum.

*Call graph*: called by 4 (exec_env_for_sandbox_permissions, managed_network_for_sandbox_permissions, sandbox_override_for_first_attempt, sandbox_permissions_preserving_denied_reads); 1 external calls (matches!).


##### `SandboxPermissions::requests_sandbox_override`  (lines 55–57)

```
fn requests_sandbox_override(self) -> bool
```

**Purpose**: Reports whether the command requested any explicit sandbox override at all. Both escalation and additional-permissions flows count; `UseDefault` does not.

**Data flow**: Consumes `self`, checks that it is not `UseDefault`, and returns a `bool`. No state is read or written.

**Call relations**: Used by event-building and shell-request code to decide whether to surface override metadata. It complements the more specific escalation and additional-permissions predicates.

*Call graph*: called by 3 (exec_command_event, shell_event_with_prefix_rule, exec_command_event); 1 external calls (matches!).


##### `SandboxPermissions::uses_additional_permissions`  (lines 61–63)

```
fn uses_additional_permissions(self) -> bool
```

**Purpose**: Returns whether the command uses the sandboxed widening flow rather than full escalation. Only `WithAdditionalPermissions` satisfies this predicate.

**Data flow**: Consumes `self`, matches it against `SandboxPermissions::WithAdditionalPermissions`, and returns a `bool`. It has no side effects.

**Call relations**: Called by permission-grant logic that distinguishes additive sandbox overlays from unsandboxed execution. It is the narrowest of the three `SandboxPermissions` helpers.

*Call graph*: called by 2 (apply_granted_turn_permissions, implicit_granted_permissions); 1 external calls (matches!).


##### `FileSystemPermissions::try_from`  (lines 88–97)

```
fn try_from(value: FileSystemPermissions<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts `FileSystemPermissions<PathUri>` into `FileSystemPermissions<AbsolutePathBuf>`, failing if any path URI cannot be resolved to an absolute path. It preserves entries and glob depth.

**Data flow**: Consumes a `FileSystemPermissions<PathUri>`, maps each `FileSystemSandboxEntry<PathUri>` through `try_from`, collects into `io::Result<Vec<_>>`, and returns `Ok(FileSystemPermissions { entries, glob_scan_max_depth })` or the first `io::Error`. It mutates no external state.

**Call relations**: Used when protocol payloads carrying URI-based paths must be materialized into runtime absolute paths. It mirrors the opposite `From` conversion defined earlier in the file.


##### `FileSystemPermissions::default`  (lines 101–106)

```
fn default() -> Self
```

**Purpose**: Provides an empty filesystem-permissions value with no entries and no glob depth. This represents the absence of explicit filesystem grants.

**Data flow**: Takes no inputs and returns `FileSystemPermissions { entries: Vec::new(), glob_scan_max_depth: None }`. No external state is touched.

**Call relations**: Used by generic defaulting and tests that normalize empty nested permission profiles. It is the baseline shape for optional filesystem overlays.

*Call graph*: called by 1 (normalize_additional_permissions_drops_empty_nested_profiles); 1 external calls (new).


##### `FileSystemPermissions::is_empty`  (lines 112–114)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether there are any filesystem permission entries at all. It ignores `glob_scan_max_depth` and looks only at the entry list.

**Data flow**: Reads `self.entries.is_empty()` and returns the resulting `bool`. It does not mutate state.

**Call relations**: Used by callers that need to know whether a filesystem overlay contributes any explicit path rules. It is a simple structural emptiness check.


##### `FileSystemPermissions::from_read_write_roots`  (lines 116–137)

```
fn from_read_write_roots(
        read: Option<Vec<PathType>>,
        write: Option<Vec<PathType>>,
    ) -> Self
```

**Purpose**: Builds canonical filesystem permissions from legacy read-root and write-root lists. Each read root becomes a `Read` path entry and each write root becomes a `Write` path entry.

**Data flow**: Accepts `Option<Vec<PathType>>` for `read` and `write`, creates a new `entries` vector, extends it with `FileSystemSandboxEntry { path: FileSystemPath::Path { path }, access: Read/Write }` for each supplied root, sets `glob_scan_max_depth` to `None`, and returns the new `FileSystemPermissions`.

**Call relations**: Called during deserialization of legacy permission shapes and by higher-level permission-building code. It is the bridge from old `{read, write}` semantics into the canonical entry-based representation.

*Call graph*: called by 39 (request_permissions_response_materializes_session_cwd_grants_before_recording, write_permissions_for_paths, file_system_permissions, file_system_sandbox_context_uses_active_attempt, preapproved_additional_permissions_escalate_intercepted_exec, shell_request_escalation_execution_is_explicit, extension_tool_uses_granted_turn_permissions, remote_request_permissions_grant_unblocks_later_remote_exec, normalized_directory_write_permissions, partial_request_permissions_grants_do_not_preapprove_new_permissions (+15 more)); 1 external calls (new).


##### `FileSystemPermissions::explicit_path_entries`  (lines 139–144)

```
fn explicit_path_entries(&self) -> impl Iterator<Item = (&PathType, FileSystemAccessMode)>
```

**Purpose**: Iterates only the concrete path entries in a filesystem-permissions set, skipping glob and special-path entries. This exposes the subset that maps directly to explicit filesystem roots.

**Data flow**: Borrows `self`, filters `self.entries` for `FileSystemPath::Path { path }`, and yields an iterator of `(&PathType, FileSystemAccessMode)`. It performs no mutation.

**Call relations**: Used by callers that need only literal path grants rather than symbolic or glob-based rules. It is a read-only view over the canonical entry list.


##### `FileSystemPermissions::legacy_read_write_roots`  (lines 146–152)

```
fn legacy_read_write_roots(&self) -> Option<LegacyReadWriteRoots<PathType>>
```

**Purpose**: Attempts to project canonical filesystem permissions back into the legacy `(read, write)` root tuple. It succeeds only when the canonical form is representable without deny rules, special paths, or glob depth.

**Data flow**: Borrows `self`, calls `as_legacy_permissions()`, and maps the resulting struct to `(legacy.read, legacy.write)`. It returns `Option<(Option<Vec<PathType>>, Option<Vec<PathType>>)>` and does not mutate state.

**Call relations**: Used by compatibility code that still needs the old read/write-root projection. It delegates all representability checks to `as_legacy_permissions`.

*Call graph*: calls 1 internal fn (as_legacy_permissions).


##### `FileSystemPermissions::as_legacy_permissions`  (lines 154–180)

```
fn as_legacy_permissions(&self) -> Option<LegacyFileSystemPermissions<PathType>>
```

**Purpose**: Converts canonical filesystem permissions into the private legacy serde shape when possible. It rejects any configuration that cannot be faithfully represented by separate read and write root lists.

**Data flow**: Borrows `self`; if `glob_scan_max_depth` is set, returns `None`. Otherwise it iterates entries, requiring every path to be `FileSystemPath::Path` and every access to be `Read` or `Write`; `Deny`, globs, and special paths all cause `None`. It accumulates cloned read and write roots and returns `Some(LegacyFileSystemPermissions { read: nonempty-or-None, write: nonempty-or-None })`.

**Call relations**: Called by `legacy_read_write_roots` and by the custom `Serialize` impl. It is the gatekeeper that decides whether the compact legacy wire shape is safe to emit.

*Call graph*: called by 2 (legacy_read_write_roots, serialize); 1 external calls (new).


##### `FileSystemPermissions::serialize`  (lines 214–227)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes filesystem permissions using the legacy `{read, write}` shape when possible, otherwise the canonical `{entries, glob_scan_max_depth}` shape. This preserves backward compatibility without losing expressive power.

**Data flow**: Borrows `self`; if `as_legacy_permissions()` returns `Some`, it serializes that legacy struct. Otherwise it clones `entries` and `glob_scan_max_depth` into `CanonicalFileSystemPermissions` and serializes that. It writes to the provided serde serializer.

**Call relations**: Invoked automatically by serde when filesystem permissions are serialized. It depends on `as_legacy_permissions` to choose the most compatible wire representation.

*Call graph*: calls 1 internal fn (as_legacy_permissions).


##### `FileSystemPermissions::deserialize`  (lines 234–250)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes filesystem permissions from either the canonical entry-based shape or the older read/write-root shape. This lets rollout files and APIs evolve without breaking older payloads.

**Data flow**: Consumes a serde deserializer, parses `FileSystemPermissionsDe<PathType>`, then either returns the canonical entries/depth directly or converts legacy `read`/`write` roots via `Self::from_read_write_roots`. It returns `Result<Self, D::Error>`.

**Call relations**: Used automatically by serde for all `FileSystemPermissions` payloads. It is the inverse of the custom serializer and central to backward-compatible config loading.

*Call graph*: 2 external calls (from_read_write_roots, deserialize).


##### `NetworkPermissions::is_empty`  (lines 259–261)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether the optional network-permissions overlay carries any explicit setting. A `None` `enabled` field means the overlay is empty.

**Data flow**: Reads `self.enabled.is_none()` and returns the resulting `bool`. It mutates nothing.

**Call relations**: Used by callers that normalize or inspect partial permission overlays. It is the network analogue of `FileSystemPermissions::is_empty`.


##### `AdditionalPermissionProfile::is_empty`  (lines 273–275)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether an additional-permissions overlay contains neither network nor filesystem sections. Presence of an empty nested section still counts as non-empty because the option itself is set.

**Data flow**: Reads `self.network.is_none()` and `self.file_system.is_none()`, combines them with `&&`, and returns the `bool`. No state is changed.

**Call relations**: Used by permission-normalization code and tests to distinguish absent overlays from explicitly present-but-empty nested structures.


##### `SandboxEnforcement::from_legacy_sandbox_policy`  (lines 293–299)

```
fn from_legacy_sandbox_policy(sandbox_policy: &SandboxPolicy) -> Self
```

**Purpose**: Maps a legacy `SandboxPolicy` into the newer enforcement classification: managed, disabled, or external. This separates who owns sandbox construction from the detailed filesystem/network rules.

**Data flow**: Borrows a `SandboxPolicy`, matches its variant, and returns `SandboxEnforcement::Disabled` for `DangerFullAccess`, `External` for `ExternalSandbox`, and `Managed` for `ReadOnly` or `WorkspaceWrite`. It has no side effects.

**Call relations**: Called when projecting legacy sandbox settings into modern permission profiles. It feeds `PermissionProfile::from_legacy_sandbox_policy` and related configuration paths.

*Call graph*: called by 12 (exec_one_off_command_inner, can_set_legacy_sandbox_policy, set_legacy_sandbox_policy, apply, session_configuration_apply_permission_profile_preserves_existing_deny_read_entries, session_configuration_apply_preserves_profile_file_system_policy_on_cwd_only_update, session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update, build_agent_spawn_config_uses_turn_context_values, spawn_agent_reapplies_runtime_sandbox_after_role_config, from_legacy_sandbox_policy (+2 more)).


##### `ManagedFileSystemPermissions::from`  (lines 321–337)

```
fn from(value: ManagedFileSystemPermissions<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts managed filesystem permissions from absolute-path form to URI form. It preserves unrestricted vs restricted mode and maps each entry path type accordingly.

**Data flow**: Consumes `ManagedFileSystemPermissions<AbsolutePathBuf>`, matches on the enum, converts restricted entries with `FileSystemSandboxEntry::<PathUri>::from`, preserves `glob_scan_max_depth`, and returns `ManagedFileSystemPermissions<PathUri>`. No external state is touched.

**Call relations**: Used when protocol payloads need URI-safe path encoding. It mirrors the opposite `TryFrom` conversion for runtime materialization.


##### `ManagedFileSystemPermissions::try_from`  (lines 345–361)

```
fn try_from(value: ManagedFileSystemPermissions<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts managed filesystem permissions from URI form back to absolute-path form, failing if any path URI cannot be resolved. It preserves unrestricted mode and glob depth.

**Data flow**: Consumes `ManagedFileSystemPermissions<PathUri>`, matches on the enum, converts restricted entries with `FileSystemSandboxEntry::<AbsolutePathBuf>::try_from`, collects errors as `io::Result`, and returns the converted enum.

**Call relations**: Used when deserialized protocol data must become runtime filesystem policy. It is the inverse of the URI conversion above.


##### `ManagedFileSystemPermissions::from_sandbox_policy`  (lines 365–378)

```
fn from_sandbox_policy(file_system_sandbox_policy: &FileSystemSandboxPolicy) -> Self
```

**Purpose**: Builds managed filesystem permissions from a runtime `FileSystemSandboxPolicy`. Restricted and unrestricted policies map directly; external sandbox policies are considered unreachable here because they belong to a different `PermissionProfile` variant.

**Data flow**: Borrows a `FileSystemSandboxPolicy`, matches on `kind`, clones entries and converts `glob_scan_max_depth: Option<usize>` into `Option<NonZeroUsize>` for restricted policies, returns `Unrestricted` for unrestricted policies, and panics via `unreachable!` for external sandbox policies.

**Call relations**: Called by `PermissionProfile` constructors and materialization helpers whenever a runtime filesystem policy must be embedded inside a managed permission profile.

*Call graph*: called by 4 (from_runtime_permissions_with_enforcement, materialize_project_roots_with_workspace_roots, read_only, workspace_write_with); 1 external calls (unreachable!).


##### `ManagedFileSystemPermissions::to_sandbox_policy`  (lines 380–392)

```
fn to_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Converts managed filesystem permissions back into a runtime `FileSystemSandboxPolicy`. It is the inverse of `from_sandbox_policy` for managed cases.

**Data flow**: Borrows `self`, matches on the enum, and returns either `FileSystemSandboxPolicy { kind: Restricted, glob_scan_max_depth: ..., entries: clone }` or `FileSystemSandboxPolicy::unrestricted()`. It does not mutate state.

**Call relations**: Used by `PermissionProfile` accessors and legacy-bridge methods whenever the runtime sandbox layer needs a concrete filesystem policy.

*Call graph*: calls 1 internal fn (unrestricted).


##### `PermissionProfile::try_from`  (lines 443–455)

```
fn try_from(value: PermissionProfile<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts a URI-based `PermissionProfile<PathUri>` into an absolute-path `PermissionProfile<AbsolutePathBuf>`. It preserves the profile variant and converts managed filesystem permissions when present.

**Data flow**: Consumes `PermissionProfile<PathUri>`, matches on the enum, converts managed `file_system` with `try_into()`, preserves `network`, and returns `io::Result<PermissionProfile<AbsolutePathBuf>>`.

**Call relations**: Used when protocol payloads carrying path URIs are materialized into runtime permission profiles. It mirrors the opposite `From` conversion defined earlier.


##### `ActivePermissionProfile::new`  (lines 479–484)

```
fn new(id: impl Into<String>) -> Self
```

**Purpose**: Constructs an active-permission-profile marker with a chosen profile ID and no parent `extends` value. It is a lightweight identity wrapper for UI and bookkeeping.

**Data flow**: Accepts `id: impl Into<String>`, converts it, sets `extends` to `None`, and returns `ActivePermissionProfile { id, extends: None }`. No external state is modified.

**Call relations**: Used by callers that need to stamp or display the selected permission profile. `read_only()` delegates to this constructor with the built-in read-only ID.

*Call graph*: 1 external calls (into).


##### `ActivePermissionProfile::read_only`  (lines 486–488)

```
fn read_only() -> Self
```

**Purpose**: Returns the built-in active-profile marker for the reserved read-only profile ID. It avoids repeating the constant at call sites.

**Data flow**: Takes no inputs and returns `Self::new(BUILT_IN_PERMISSION_PROFILE_READ_ONLY)`. It has no side effects.

**Call relations**: Used where code needs a stable marker for the built-in read-only profile. It is a convenience wrapper over `ActivePermissionProfile::new`.

*Call graph*: 1 external calls (new).


##### `PermissionProfile::default`  (lines 492–500)

```
fn default() -> Self
```

**Purpose**: Provides the default runtime permission profile: managed sandboxing with no filesystem entries and restricted network access. This is the safest baseline profile.

**Data flow**: Returns `PermissionProfile::Managed { file_system: ManagedFileSystemPermissions::Restricted { entries: Vec::new(), glob_scan_max_depth: None }, network: NetworkSandboxPolicy::Restricted }`. It reads no external state.

**Call relations**: Used widely as the fallback permission profile when no explicit configuration is supplied. It establishes the default security posture for many subsystems.

*Call graph*: called by 14 (list_all_tools_accepts_canonical_namespaced_tool_names, list_all_tools_adds_server_metadata_to_cached_tools, list_all_tools_applies_legacy_mcp_prefix_by_default, list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot, list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty, list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails, list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending, list_available_server_infos_uses_cache_while_client_is_pending, no_local_runtime_fails_local_stdio_but_keeps_local_http_server, shutdown_cancels_pending_tool_listing (+4 more)); 1 external calls (new).


##### `PermissionProfile::read_only`  (lines 505–511)

```
fn read_only() -> Self
```

**Purpose**: Constructs the canonical managed read-only permission profile with restricted network access. It mirrors the legacy read-only sandbox preset.

**Data flow**: Builds a runtime `FileSystemSandboxPolicy::read_only()`, converts it with `ManagedFileSystemPermissions::from_sandbox_policy`, pairs it with `NetworkSandboxPolicy::Restricted`, and returns `PermissionProfile::Managed { ... }`.

**Call relations**: Used by defaults, tests, and compatibility code that need the built-in read-only profile. It is one of the main preset constructors on `PermissionProfile`.

*Call graph*: calls 2 internal fn (from_sandbox_policy, read_only); called by 153 (rollback_response_rebuilds_pathless_thread_from_stored_history, cancellation_expiration_keeps_process_alive_until_terminated, timeout_or_cancellation_reports_cancellation_without_timeout_exit_code, windows_sandbox_exec_request, requested_permissions_trust_project_uses_permission_profile_intent, summary_from_stored_thread_preserves_millisecond_precision, default, try_from, derive_permission_profile, load_config_with_layer_stack (+15 more)).


##### `PermissionProfile::workspace_write`  (lines 518–525)

```
fn workspace_write() -> Self
```

**Purpose**: Constructs the canonical managed workspace-write profile with restricted network access and default legacy workspace-write knobs. The resulting filesystem permissions still contain symbolic workspace-root entries.

**Data flow**: Calls `Self::workspace_write_with(&[], NetworkSandboxPolicy::Restricted, false, false)` and returns its result. It has no side effects of its own.

**Call relations**: Used as the built-in workspace-write preset. It delegates all detailed construction to `workspace_write_with`.

*Call graph*: called by 77 (requested_permissions_trust_project_uses_permission_profile_intent, debug_sandbox_honors_explicit_builtin_permission_profile, derive_permission_profile, derive_sandbox_policy_preserves_windows_downgrade_for_unsupported_fallback, permission_snapshot_setter_preserves_permission_constraints, managed_allowed_domains_only_disables_default_mode_allowlist_expansion, managed_allowed_domains_only_ignores_user_allowlist_and_hard_denies_misses, managed_allowed_domains_only_without_managed_allowlist_blocks_all_user_domains, requirements_allowed_domains_do_not_override_user_denies_for_same_pattern, requirements_allowlist_expansion_keeps_user_entries_mutable (+15 more)); 1 external calls (workspace_write_with).


##### `PermissionProfile::workspace_write_with`  (lines 532–547)

```
fn workspace_write_with(
        writable_roots: &[AbsolutePathBuf],
        network: NetworkSandboxPolicy,
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> Self
```

**Purpose**: Constructs a managed workspace-write profile with explicit writable roots, network policy, and legacy tmpdir exclusion flags. It preserves symbolic `:workspace_roots` semantics until later materialization.

**Data flow**: Accepts writable roots, network policy, and two booleans; builds a runtime `FileSystemSandboxPolicy::workspace_write(...)`, converts it with `ManagedFileSystemPermissions::from_sandbox_policy`, and returns `PermissionProfile::Managed { file_system, network }`.

**Call relations**: Called by the simpler `workspace_write()` preset and by configuration code that needs custom writable roots or network settings. It is the main constructor for managed workspace-write profiles.

*Call graph*: calls 2 internal fn (from_sandbox_policy, workspace_write); called by 33 (deserialize_allowed_sandbox_modes, remote_sandbox_config_first_match_overrides_top_level, derive_permission_profile, builtin_permission_profile, windows_restricted_token_allows_workspace_write_profiles, granular_sandbox_approval_false_rejects_out_of_root_patch, granular_with_all_flags_true_matches_on_request_for_out_of_root_patch, missing_project_dot_codex_config_requires_approval, restrictive_workspace_write_profile, restrictive_workspace_write_profile (+15 more)).


##### `PermissionProfile::materialize_project_roots_with_workspace_roots`  (lines 549–569)

```
fn materialize_project_roots_with_workspace_roots(
        self,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Replaces symbolic workspace-root references inside a permission profile with concrete entries for the provided workspace roots. Disabled and external profiles pass through unchanged.

**Data flow**: Consumes `self` and a slice of `AbsolutePathBuf`. For `Managed`, it converts the embedded managed filesystem permissions to a runtime policy, calls `materialize_project_roots_with_workspace_roots`, converts back with `from_sandbox_policy`, and returns a new managed profile with the same network policy. Other variants are returned unchanged.

**Call relations**: Used when a durable permission profile must be rebound to a concrete set of workspace roots before enforcement or persistence. It delegates the actual path expansion to the filesystem-policy layer.

*Call graph*: calls 1 internal fn (from_sandbox_policy).


##### `PermissionProfile::from_runtime_permissions`  (lines 571–586)

```
fn from_runtime_permissions(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        network_sandbox_policy: NetworkSandboxPolicy,
    ) -> Self
```

**Purpose**: Builds a permission profile from runtime filesystem and network sandbox policies, inferring enforcement mode from the filesystem policy kind. It is the main projection from runtime sandbox state into protocol form.

**Data flow**: Borrows a `FileSystemSandboxPolicy` and takes a `NetworkSandboxPolicy`, derives `SandboxEnforcement::Managed` for restricted/unrestricted filesystem kinds and `External` for external sandbox, then forwards all inputs to `from_runtime_permissions_with_enforcement`.

**Call relations**: Called by config loading, tests, and runtime snapshotting code. It is the convenience entrypoint when enforcement mode should be inferred rather than supplied explicitly.

*Call graph*: called by 65 (requested_permissions_trust_project_uses_permission_profile_intent, load_config_with_layer_stack, permission_profile_override_keeps_memories_root_out_of_legacy_projection, workspace_write_permission_profile_with_private_denials, managed_cwd_write_profile_has_filesystem_restrictions, managed_full_disk_write_profile_has_no_filesystem_restrictions, managed_unresolvable_write_profile_has_filesystem_restrictions, writable_windows_policy_without_sandbox_backend_still_requires_approval, windows_elevated_allows_split_restricted_read_policies, windows_elevated_rejects_reopened_writable_descendants (+15 more)); 1 external calls (from_runtime_permissions_with_enforcement).


##### `PermissionProfile::from_runtime_permissions_with_enforcement`  (lines 588–609)

```
fn from_runtime_permissions_with_enforcement(
        enforcement: SandboxEnforcement,
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        network_sandbox_policy: NetworkSandboxPolic
```

**Purpose**: Builds a permission profile from runtime sandbox policies plus an explicit enforcement mode. It decides whether unrestricted filesystem access should become `Disabled` or remain managed unrestricted.

**Data flow**: Accepts `SandboxEnforcement`, a borrowed `FileSystemSandboxPolicy`, and a `NetworkSandboxPolicy`. It returns `External` for external filesystem policies, `Disabled` when the filesystem is unrestricted and enforcement is `Disabled`, and otherwise `Managed` with filesystem converted via `ManagedFileSystemPermissions::from_sandbox_policy` and the supplied network policy.

**Call relations**: Used by `from_runtime_permissions`, legacy-policy projection, and configuration application code. It centralizes the subtle distinction between disabled sandboxing and managed unrestricted filesystem access.

*Call graph*: calls 1 internal fn (from_sandbox_policy); called by 23 (managed_full_disk_with_restricted_network_reports_external_sandbox, exec_one_off_command_inner, load_config_with_layer_stack, can_set_legacy_sandbox_policy, set_legacy_sandbox_policy, permission_profile_override_preserves_split_write_roots, apply, set_permission_profile_projection, record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout, session_configuration_apply_permission_profile_preserves_existing_deny_read_entries (+13 more)).


##### `PermissionProfile::from_legacy_sandbox_policy`  (lines 611–617)

```
fn from_legacy_sandbox_policy(sandbox_policy: &SandboxPolicy) -> Self
```

**Purpose**: Projects a legacy `SandboxPolicy` into the modern `PermissionProfile` representation. It derives enforcement, filesystem policy, and network policy from the legacy value.

**Data flow**: Borrows a `SandboxPolicy`, computes enforcement with `SandboxEnforcement::from_legacy_sandbox_policy`, converts filesystem with `FileSystemSandboxPolicy::from`, converts network with `NetworkSandboxPolicy::from`, and forwards all three to `from_runtime_permissions_with_enforcement`.

**Call relations**: Used when older config or persisted thread state still stores legacy sandbox policies. It is the main compatibility bridge into the newer permission-profile model.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy, from, from); called by 2 (permission_profile_round_trip_preserves_disabled_sandbox, permission_profile_round_trip_preserves_external_sandbox); 1 external calls (from_runtime_permissions_with_enforcement).


##### `PermissionProfile::from_legacy_sandbox_policy_for_cwd`  (lines 619–625)

```
fn from_legacy_sandbox_policy_for_cwd(sandbox_policy: &SandboxPolicy, cwd: &Path) -> Self
```

**Purpose**: Projects a legacy `SandboxPolicy` into a modern permission profile while resolving cwd-sensitive workspace-write defaults against a specific working directory. This preserves legacy semantics for symbolic workspace roots.

**Data flow**: Borrows a `SandboxPolicy` and `cwd: &Path`, derives enforcement from the legacy policy, converts filesystem with `FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd`, converts network with `NetworkSandboxPolicy::from`, and forwards to `from_runtime_permissions_with_enforcement`.

**Call relations**: Used when thread/session state needs a permission profile that reflects the current working directory. It is the cwd-aware counterpart to `from_legacy_sandbox_policy`.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); called by 6 (submit_turn_with_policies, deserialize, apply_thread_settings_to_session, display_permission_profile_from_thread_response, thread_session_state_from_thread_resume_response, apply_thread_settings); 1 external calls (from_runtime_permissions_with_enforcement).


##### `PermissionProfile::enforcement`  (lines 627–633)

```
fn enforcement(&self) -> SandboxEnforcement
```

**Purpose**: Returns the enforcement classification of a permission profile. This exposes whether sandbox construction is managed by Codex, disabled, or external.

**Data flow**: Borrows `self`, matches on the enum variant, and returns the corresponding `SandboxEnforcement`. It does not mutate state.

**Call relations**: Used by projection and sandbox-context code that needs to reason about enforcement ownership separately from detailed permissions.

*Call graph*: called by 4 (set_permission_profile_projection, file_system_sandbox_context, with_managed_mitm_ca_readable_root, effective_permission_profile).


##### `PermissionProfile::file_system_sandbox_policy`  (lines 635–641)

```
fn file_system_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Extracts the runtime filesystem sandbox policy implied by a permission profile. Disabled profiles become unrestricted; external profiles become external sandbox.

**Data flow**: Borrows `self`, matches on the enum, and returns either `file_system.to_sandbox_policy()`, `FileSystemSandboxPolicy::unrestricted()`, or `FileSystemSandboxPolicy::external_sandbox()`. No state is changed.

**Call relations**: Called by runtime sandbox setup and compatibility code whenever a concrete filesystem policy is needed from the higher-level profile.

*Call graph*: calls 2 internal fn (external_sandbox, unrestricted); called by 13 (sandbox_policy_mode, permission_profile_trusts_project, sandbox_mode_requirement_for_permission_profile, profile_has_managed_filesystem_restrictions, permission_profile_policy_tag, file_system_sandbox_policy, sandbox_mode_from_permission_profile, from_permission_profile, to_runtime_permissions, add_dir_warning_message (+3 more)).


##### `PermissionProfile::network_sandbox_policy`  (lines 643–648)

```
fn network_sandbox_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Extracts the runtime network sandbox policy implied by a permission profile. Disabled profiles always imply enabled network access.

**Data flow**: Borrows `self`, returns the stored `network` for managed/external profiles, or `NetworkSandboxPolicy::Enabled` for disabled profiles. It has no side effects.

**Call relations**: Used alongside `file_system_sandbox_policy` when reconstructing runtime sandbox settings from a profile.

*Call graph*: called by 11 (sandbox_policy_mode, network_proxy_spec_for_active_permission_profile, spawn_command_under_linux_sandbox, network_sandbox_policy, sandbox_mode_from_permission_profile, from_permission_profile, to_runtime_permissions, sandbox_mode_from_permission_profile, preset_matches_current, legacy_compatible_permission_profile (+1 more)).


##### `PermissionProfile::to_legacy_sandbox_policy`  (lines 650–667)

```
fn to_legacy_sandbox_policy(&self, cwd: &Path) -> io::Result<SandboxPolicy>
```

**Purpose**: Attempts to convert a modern permission profile back into the older `SandboxPolicy` representation. Some managed filesystem configurations cannot be bridged and may return an `io::Error`.

**Data flow**: Borrows `self` and `cwd: &Path`. Managed profiles delegate to `file_system.to_sandbox_policy().to_legacy_sandbox_policy(*network, cwd)`, disabled profiles return `SandboxPolicy::DangerFullAccess`, and external profiles return `SandboxPolicy::ExternalSandbox` with network access mapped to the legacy enum. It returns `io::Result<SandboxPolicy>`.

**Call relations**: Used by compatibility layers and summaries that still need legacy sandbox-policy output. It depends on the filesystem-policy bridge to determine whether the conversion is representable.

*Call graph*: called by 4 (turn_permission_fields, compatibility_sandbox_policy_for_permission_profile, legacy_compatible_permission_profile, summarize_permission_profile).


##### `PermissionProfile::to_runtime_permissions`  (lines 669–674)

```
fn to_runtime_permissions(&self) -> (FileSystemSandboxPolicy, NetworkSandboxPolicy)
```

**Purpose**: Returns the pair of runtime filesystem and network sandbox policies represented by the profile. It is a convenience accessor for enforcement code.

**Data flow**: Borrows `self`, calls `self.file_system_sandbox_policy()` and `self.network_sandbox_policy()`, and returns the tuple. It does not mutate state.

**Call relations**: Used by command execution and sandbox setup code that needs both runtime policies together. It is a thin wrapper over the two individual accessors.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, network_sandbox_policy); called by 12 (build_exec_request, resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides, new, set_permission_profile_projection, file_system_sandbox_context, sandbox_exec_request, apply_permission_profile_to_current_thread, should_warn_about_system_bwrap, with_managed_mitm_ca_readable_root (+2 more)).


##### `PermissionProfile::from`  (lines 718–743)

```
fn from(value: LegacyPermissionProfile<PathType>) -> Self
```

**Purpose**: Converts the private tagged-deserialization enum into the public `PermissionProfile`. It is a direct variant-preserving mapping.

**Data flow**: Consumes `TaggedPermissionProfile<PathType>`, matches on its variant, and returns the corresponding `PermissionProfile<PathType>` with moved fields. No external state is touched.

**Call relations**: Used by the custom `Deserialize` impl after serde has parsed the tagged modern wire shape. It isolates the public enum from the serde-only helper type.


##### `PermissionProfile::deserialize`  (lines 757–765)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes a permission profile from either the modern tagged shape or the older legacy rollout shape. This preserves backward compatibility for persisted thread data and configs.

**Data flow**: Consumes a serde deserializer, parses `PermissionProfileDe<PathType>`, converts `Tagged` via `.into()` and `Legacy` via `.into()`, and returns the resulting `PermissionProfile`. It writes only to the deserialization output.

**Call relations**: Invoked automatically by serde for `PermissionProfile`. It is the counterpart to the file’s compatibility-focused permission-profile conversion logic.

*Call graph*: 1 external calls (deserialize).


##### `NetworkPermissions::from`  (lines 769–773)

```
fn from(value: NetworkSandboxPolicy) -> Self
```

**Purpose**: Converts a runtime `NetworkSandboxPolicy` into the protocol `NetworkPermissions` overlay shape. The result always sets `enabled` explicitly.

**Data flow**: Consumes a `NetworkSandboxPolicy`, calls `value.is_enabled()`, wraps that in `Some(...)`, and returns `NetworkPermissions { enabled }`. It has no side effects.

**Call relations**: Used when projecting runtime sandbox state into protocol-visible permission overlays. It is the network-side bridge from runtime policy to protocol model.

*Call graph*: calls 1 internal fn (is_enabled).


##### `FileSystemPermissions::from`  (lines 777–793)

```
fn from(value: &FileSystemSandboxPolicy) -> Self
```

**Purpose**: Converts a runtime `FileSystemSandboxPolicy` into protocol `FileSystemPermissions`. Restricted policies preserve their entries; unrestricted and external policies are represented as a synthetic root-write entry.

**Data flow**: Borrows a `FileSystemSandboxPolicy`, clones restricted entries directly, or constructs a single `FileSystemSandboxEntry` targeting `FileSystemSpecialPath::Root` with `Write` access for unrestricted/external kinds. It converts `glob_scan_max_depth` to `Option<NonZeroUsize>` and returns `FileSystemPermissions { entries, glob_scan_max_depth }`.

**Call relations**: Used when exposing runtime filesystem policy through protocol types. It intentionally collapses unrestricted and external filesystem access into a broad root-write representation.

*Call graph*: 1 external calls (vec!).


##### `FileSystemSandboxPolicy::from`  (lines 797–801)

```
fn from(value: &FileSystemPermissions) -> Self
```

**Purpose**: Converts protocol `FileSystemPermissions` back into a runtime restricted filesystem sandbox policy. It preserves entries and glob depth directly.

**Data flow**: Borrows `FileSystemPermissions`, constructs `FileSystemSandboxPolicy::restricted(value.entries.clone())`, then copies `glob_scan_max_depth` back to `Option<usize>` via `usize::from`. It returns the runtime policy.

**Call relations**: Used when protocol-visible filesystem permissions need to become runtime enforcement policy. It is the inverse of the projection above for restricted cases.

*Call graph*: calls 1 internal fn (restricted).


##### `plaintext_agent_message_content`  (lines 867–878)

```
fn plaintext_agent_message_content(content: &[AgentMessageInputContent]) -> Option<String>
```

**Purpose**: Extracts a readable plaintext string from agent-message input content only when every part is plaintext. Any encrypted segment causes the whole conversion to fail.

**Data flow**: Accepts a slice of `AgentMessageInputContent`, preallocates a vector of text parts, iterates through the slice, pushes `text.as_str()` for `InputText`, returns `None` immediately for `EncryptedContent`, joins collected parts with `\n`, trims to reject all-whitespace output, and returns `Some(text)` or `None`.

**Call relations**: Used by transcript-building and visible-message rendering code that wants a local plaintext preview only when the entire message is readable. It intentionally fails closed on mixed encrypted/plaintext content.

*Call graph*: called by 3 (collect_guardian_transcript_entries, build_current_thread_section, push_visible_message); 2 external calls (with_capacity, len).


##### `ResponseItem::is_user_message`  (lines 1122–1124)

```
fn is_user_message(&self) -> bool
```

**Purpose**: Checks whether a response item is a standard `Message` whose role is exactly `"user"`. It excludes all other item variants and non-user roles.

**Data flow**: Borrows `self`, pattern-matches `ResponseItem::Message { role, .. } if role == "user"`, and returns a `bool`. It mutates nothing.

**Call relations**: Used by higher-level response processing that needs to identify ordinary user messages among many response-item variants.

*Call graph*: 1 external calls (matches!).


##### `ResponseItem::turn_id`  (lines 1127–1131)

```
fn turn_id(&self) -> Option<&str>
```

**Purpose**: Returns the non-empty turn ID stored in item metadata, if present. Empty strings are treated as absent.

**Data flow**: Borrows `self`, calls `self.metadata()`, drills into `metadata.turn_id.as_deref()`, filters out empty strings, and returns `Option<&str>`. It does not mutate state.

**Call relations**: Used by `stamp_turn_id_if_missing` and other callers that need to inspect stamped turn metadata without exposing the full metadata struct.

*Call graph*: calls 1 internal fn (metadata); called by 1 (stamp_turn_id_if_missing).


##### `ResponseItem::stamp_turn_id_if_missing`  (lines 1134–1144)

```
fn stamp_turn_id_if_missing(&mut self, turn_id: &str)
```

**Purpose**: Adds a turn ID to item metadata only when the provided ID is non-empty and the item does not already carry a non-empty turn ID. It preserves existing metadata and ignores unsupported variants.

**Data flow**: Mutably borrows `self` and takes `turn_id: &str`. If the input is empty or `self.turn_id()` already returns `Some`, it returns early. Otherwise it calls `metadata_mut()`, inserts default `ResponseItemMetadata` if needed, and sets `turn_id` to `Some(turn_id.to_string())`.

**Call relations**: Used by response-processing code that stamps provider items with conversation turn identity. It depends on `turn_id()` and `metadata_mut()` to avoid overwriting existing metadata or touching `ResponseItem::Other`.

*Call graph*: calls 2 internal fn (metadata_mut, turn_id).


##### `ResponseItem::clear_metadata`  (lines 1147–1151)

```
fn clear_metadata(&mut self)
```

**Purpose**: Removes provider-facing metadata from a response item before sending it to systems that do not accept metadata fields. Unsupported variants are left untouched.

**Data flow**: Mutably borrows `self`, calls `metadata_mut()`, and if present replaces the inner `Option<ResponseItemMetadata>` with `None`. It mutates only the item itself.

**Call relations**: Used before forwarding response items to providers that reject metadata. It relies on `metadata_mut()` to abstract over the many variants that carry optional metadata.

*Call graph*: calls 1 internal fn (metadata_mut).


##### `ResponseItem::metadata`  (lines 1153–1172)

```
fn metadata(&self) -> Option<&ResponseItemMetadata>
```

**Purpose**: Returns a shared reference to the metadata field for any response-item variant that carries one. `ResponseItem::Other` has no metadata.

**Data flow**: Borrows `self`, matches across all metadata-bearing variants, and returns `metadata.as_ref()`; for `Other` it returns `None`. It does not mutate state.

**Call relations**: Used internally by `turn_id()` and any future read-only metadata accessors. It centralizes the variant matching needed to reach metadata.

*Call graph*: called by 1 (turn_id).


##### `ResponseItem::metadata_mut`  (lines 1174–1193)

```
fn metadata_mut(&mut self) -> Option<&mut Option<ResponseItemMetadata>>
```

**Purpose**: Returns a mutable reference to the optional metadata slot for any metadata-bearing response-item variant. This enables in-place stamping or clearing.

**Data flow**: Mutably borrows `self`, matches across all variants that contain `metadata`, and returns `Some(&mut Option<ResponseItemMetadata>)`; for `Other` it returns `None`. It does not itself modify the metadata.

**Call relations**: Used by `stamp_turn_id_if_missing` and `clear_metadata`. It is the mutable counterpart to `metadata()`.

*Call graph*: called by 2 (clear_metadata, stamp_turn_id_if_missing).


##### `BaseInstructions::default`  (lines 1206–1210)

```
fn default() -> Self
```

**Purpose**: Provides the default base instructions text by embedding the bundled markdown prompt file. This gives new threads a stable built-in instruction set.

**Data flow**: Returns `BaseInstructions { text: BASE_INSTRUCTIONS_DEFAULT.to_string() }`, where the constant is populated by `include_str!`. It reads the compile-time embedded string and mutates nothing.

**Call relations**: Used wherever default model/thread instructions are needed and no explicit instructions were configured.

*Call graph*: called by 12 (get_conversation_summary_by_thread_id_reads_pathless_store_thread, thread_delete_with_non_local_thread_store_does_not_create_local_persistence, seed_pathless_store_thread, thread_unarchive_preserves_pathless_store_metadata, default, attach_thread_persistence, shutdown_complete_does_not_append_to_thread_store_after_shutdown, find_locates_rollout_file_written_by_recorder, persist_reports_filesystem_error_and_retries_buffered_items, recorder_materializes_on_flush_with_pending_items (+2 more)).


##### `format_allow_prefixes`  (lines 1217–1254)

```
fn format_allow_prefixes(prefixes: Vec<Vec<String>>) -> Option<String>
```

**Purpose**: Formats a list of allowed command prefixes into a human-readable bullet list, sorted deterministically and truncated by both count and byte budget. It appends a marker when truncation occurs.

**Data flow**: Consumes `Vec<Vec<String>>`, marks truncation if the count exceeds `MAX_RENDERED_PREFIXES`, sorts prefixes by token count, then combined token length, then lexical order, renders up to the maximum count with `render_command_prefix`, joins them with newlines, truncates at the last valid UTF-8 boundary before `MAX_ALLOW_PREFIX_TEXT_BYTES`, and returns `Some(output)` with `TRUNCATED_MARKER` appended if truncation happened.

**Call relations**: Used by approval and exec-policy messaging code to present allowed command prefixes to users. It delegates token rendering to `render_command_prefix` and length comparison to `prefix_combined_str_len`.

*Call graph*: called by 5 (record_execpolicy_amendment_message, approved_command_prefixes_text, format_allow_prefixes_limits_output, render_command_prefix_list_limits_output_to_max_prefixes, render_command_prefix_list_sorts_by_len_then_total_len_then_alphabetical); 1 external calls (format!).


##### `prefix_combined_str_len`  (lines 1256–1258)

```
fn prefix_combined_str_len(prefix: &[String]) -> usize
```

**Purpose**: Computes the total character length of all tokens in a command prefix. It is used only as a secondary sort key for deterministic prefix rendering.

**Data flow**: Borrows a slice of `String`, sums `String::len` across all elements, and returns the `usize` total. It has no side effects.

**Call relations**: Called by `format_allow_prefixes` during sorting. It helps shorter textual prefixes sort ahead of longer ones when token counts match.


##### `render_command_prefix`  (lines 1260–1267)

```
fn render_command_prefix(prefix: &[String]) -> String
```

**Purpose**: Renders one command prefix as a JSON-like bracketed token list. Each token is individually JSON-escaped for readability and correctness.

**Data flow**: Borrows a slice of `String`, serializes each token with `serde_json::to_string` falling back to debug formatting on error, joins them with `, `, wraps the result in `[...]`, and returns the final `String`.

**Call relations**: Used by `format_allow_prefixes` to produce each bullet-list line. It isolates token escaping and formatting from the truncation/sorting logic.

*Call graph*: 1 external calls (format!).


##### `should_serialize_reasoning_content`  (lines 1269–1276)

```
fn should_serialize_reasoning_content(content: &Option<Vec<ReasoningItemContent>>) -> bool
```

**Purpose**: Controls whether the optional `content` field of `ResponseItem::Reasoning` should be serialized. It suppresses serialization when the content contains any `ReasoningText` entries or when the field is absent.

**Data flow**: Borrows `&Option<Vec<ReasoningItemContent>>`, returns `false` for `None`, and for `Some(content)` returns `true` only if no element matches `ReasoningItemContent::ReasoningText { .. }`. It mutates nothing.

**Call relations**: Used as a serde `skip_serializing_if` predicate on the reasoning item’s `content` field. It encodes a subtle wire-compatibility rule about which reasoning content forms should be emitted.


##### `local_image_error_placeholder`  (lines 1278–1289)

```
fn local_image_error_placeholder(
    path: &std::path::Path,
    error: impl std::fmt::Display,
) -> ContentItem
```

**Purpose**: Builds a text fallback content item explaining that a local image could not be read or processed. This keeps the user-visible prompt informative when attachment preparation fails.

**Data flow**: Accepts a filesystem `path` and any displayable `error`, formats a sentence mentioning both, wraps it as `ContentItem::InputText { text }`, and returns it. No external state is changed.

**Call relations**: Used by local-image preparation code when file reads, encoding, or generic processing fail. It is one of several placeholder constructors for degraded image handling.

*Call graph*: 1 external calls (format!).


##### `image_open_tag_text`  (lines 1299–1301)

```
fn image_open_tag_text() -> String
```

**Purpose**: Returns the literal `<image>` marker text used in prompt content. This is the unlabeled open tag for image placeholders.

**Data flow**: Takes no inputs and returns `IMAGE_OPEN_TAG.to_string()`. It has no side effects.

**Call relations**: Used by code that needs the canonical open-tag text for image markers. It pairs with `image_close_tag_text`.

*Call graph*: called by 1 (skips_unnamed_image_label_text).


##### `image_close_tag_text`  (lines 1303–1305)

```
fn image_close_tag_text() -> String
```

**Purpose**: Returns the literal `</image>` marker text used to close image placeholders in prompt content.

**Data flow**: Takes no inputs and returns `IMAGE_CLOSE_TAG.to_string()`. It mutates nothing.

**Call relations**: Used by tests and prompt-building code that need the canonical close-tag text.


##### `local_image_label_text`  (lines 1307–1309)

```
fn local_image_label_text(label_number: usize) -> String
```

**Purpose**: Formats the human-readable label for a numbered local image placeholder, such as `[Image #2]`. This label is embedded into local-image open tags.

**Data flow**: Accepts `label_number: usize`, formats it into `[Image #<n>]`, and returns the resulting `String`. No state is changed.

**Call relations**: Used by `local_image_open_tag_text_with_path` and by attachment-editing code that renumbers image placeholders.

*Call graph*: called by 12 (local_image_open_tag_text_with_path, attach_image, relabel_local_images, apply_external_edit_drops_missing_attachments, apply_external_edit_limits_duplicates_to_occurrences, apply_external_edit_rebuilds_text_and_attachments, apply_external_edit_renumbers_image_placeholders, clear_for_ctrl_c_preserves_image_draft_state, deleting_reordered_image_one_renumbers_text_in_place, set_text_content_reattaches_images_without_placeholder_metadata (+2 more)); 1 external calls (format!).


##### `local_image_open_tag_text_with_path`  (lines 1311–1315)

```
fn local_image_open_tag_text_with_path(label_number: usize, path: &std::path::Path) -> String
```

**Purpose**: Builds the labeled local-image open tag that includes both the image label and the original filesystem path. This gives downstream consumers a textual anchor around the embedded image payload.

**Data flow**: Accepts a label number and `&Path`, computes the label with `local_image_label_text`, formats `<image name=[Image #n] path="...">`, and returns the string. It reads the path only for display formatting.

**Call relations**: Used by `local_image_content_items` when wrapping local images with textual markers. It is the canonical formatter for labeled local-image open tags.

*Call graph*: calls 1 internal fn (local_image_label_text); called by 1 (local_image_content_items); 2 external calls (display, format!).


##### `is_local_image_open_tag_text`  (lines 1317–1320)

```
fn is_local_image_open_tag_text(text: &str) -> bool
```

**Purpose**: Checks whether a string looks like a labeled local-image open tag. It uses a simple prefix/suffix test rather than full parsing.

**Data flow**: Borrows `text: &str`, strips the `LOCAL_IMAGE_OPEN_TAG_PREFIX`, then checks whether the remainder ends with `LOCAL_IMAGE_OPEN_TAG_SUFFIX`, returning a `bool`. It mutates nothing.

**Call relations**: Used by user-message parsing code to recognize local-image markers in text streams.

*Call graph*: called by 1 (parse_user_message).


##### `is_local_image_close_tag_text`  (lines 1322–1324)

```
fn is_local_image_close_tag_text(text: &str) -> bool
```

**Purpose**: Checks whether a string is the local-image close tag. Local-image close tags are currently identical to generic image close tags.

**Data flow**: Borrows `text: &str`, delegates to `is_image_close_tag_text(text)`, and returns the resulting `bool`. It has no side effects.

**Call relations**: Used by user-message parsing code and intentionally shares logic with generic image close-tag detection.

*Call graph*: calls 1 internal fn (is_image_close_tag_text); called by 1 (parse_user_message).


##### `is_image_open_tag_text`  (lines 1326–1328)

```
fn is_image_open_tag_text(text: &str) -> bool
```

**Purpose**: Checks whether a string is exactly the generic `<image>` open tag.

**Data flow**: Compares `text` to the `IMAGE_OPEN_TAG` constant and returns a `bool`. It mutates nothing.

**Call relations**: Used by user-message parsing code to detect generic image markers.

*Call graph*: called by 1 (parse_user_message).


##### `is_image_close_tag_text`  (lines 1330–1332)

```
fn is_image_close_tag_text(text: &str) -> bool
```

**Purpose**: Checks whether a string is exactly the generic `</image>` close tag.

**Data flow**: Compares `text` to the `IMAGE_CLOSE_TAG` constant and returns a `bool`. It has no side effects.

**Call relations**: Used directly by user-message parsing and indirectly by `is_local_image_close_tag_text`.

*Call graph*: called by 2 (parse_user_message, is_local_image_close_tag_text).


##### `invalid_image_error_placeholder`  (lines 1334–1345)

```
fn invalid_image_error_placeholder(
    path: &std::path::Path,
    error: impl std::fmt::Display,
) -> ContentItem
```

**Purpose**: Builds a text fallback content item explaining that a local file exists but is not a valid image. This distinguishes invalid image data from generic read failures.

**Data flow**: Accepts a `path` and displayable `error`, formats `Image located at ... is invalid: ...`, wraps it as `ContentItem::InputText`, and returns it. No external state is modified.

**Call relations**: Used by local-image preparation when image decoding fails in a way classified as invalid image data.

*Call graph*: 1 external calls (format!).


##### `unsupported_image_error_placeholder`  (lines 1347–1355)

```
fn unsupported_image_error_placeholder(path: &std::path::Path, mime: &str) -> ContentItem
```

**Purpose**: Builds a text fallback content item explaining that a local file has an unsupported image MIME type. This gives a clearer message than a generic processing failure.

**Data flow**: Accepts a `path` and MIME string, formats `Codex cannot attach image at ...: unsupported image ...`, wraps it as `ContentItem::InputText`, and returns it.

**Call relations**: Used by local-image preparation when `load_for_prompt_bytes` reports `UnsupportedImageFormat`.

*Call graph*: 1 external calls (format!).


##### `local_image_content_items_with_label_number`  (lines 1357–1388)

```
fn local_image_content_items_with_label_number(
    path: &std::path::Path,
    file_bytes: Vec<u8>,
    label_number: Option<usize>,
    detail: ImageDetail,
) -> Vec<ContentItem>
```

**Purpose**: Processes raw local image bytes into prompt content items, optionally labeling the image and preserving requested detail level. On failure it returns a single explanatory text placeholder instead of image content.

**Data flow**: Accepts a path, raw `file_bytes`, optional label number, and `ImageDetail`. It maps detail to `PromptImageMode` (`Original` stays original; others resize to fit), calls `load_for_prompt_bytes`, and on success delegates to `local_image_content_items(path, image.into_data_url(), label_number, detail)`. On error it pattern-matches `ImageProcessingError` and returns a one-element vector containing either `local_image_error_placeholder`, `invalid_image_error_placeholder`, or `unsupported_image_error_placeholder`.

**Call relations**: Called by `ResponseInputItem::from_user_input` when local images are processed eagerly. It is the main image-preparation path and delegates final wrapping to `local_image_content_items`.

*Call graph*: calls 1 internal fn (local_image_content_items); 2 external calls (load_for_prompt_bytes, vec!).


##### `local_image_content_items`  (lines 1396–1418)

```
fn local_image_content_items(
    path: &std::path::Path,
    image_url: String,
    label_number: Option<usize>,
    detail: ImageDetail,
) -> Vec<ContentItem>
```

**Purpose**: Builds the final prompt content sequence for a local image: optional labeled open tag, the `InputImage` item, and optional close tag. It assumes the image URL is already prepared.

**Data flow**: Accepts a path, prepared `image_url`, optional label number, and `ImageDetail`. It allocates a vector with capacity 3, pushes `InputText` open tag if labeled, always pushes `ContentItem::InputImage { image_url, detail: Some(detail) }`, and pushes `InputText` close tag if labeled. It returns the vector.

**Call relations**: Used by `local_image_content_items_with_label_number` and by deferred local-image handling in `ResponseInputItem::from_user_input`. It isolates the marker-wrapping logic from image processing.

*Call graph*: calls 1 internal fn (local_image_open_tag_text_with_path); called by 1 (local_image_content_items_with_label_number); 1 external calls (with_capacity).


##### `ResponseItem::from`  (lines 1421–1470)

```
fn from(item: ResponseInputItem) -> Self
```

**Purpose**: Converts a `ResponseInputItem` into the corresponding `ResponseItem`, filling in omitted fields such as `id` and `metadata` with `None`. MCP tool-call outputs are normalized into ordinary function-call outputs.

**Data flow**: Consumes a `ResponseInputItem`, matches on its variant, and returns the corresponding `ResponseItem`. `Message` preserves role/content/phase and sets `id`/`metadata` to `None`; `FunctionCallOutput` and `CustomToolCallOutput` preserve payloads and set metadata to `None`; `McpToolCallOutput` converts its `CallToolResult` with `into_function_call_output_payload`; `ToolSearchOutput` wraps `call_id` in `Some`.

**Call relations**: Used when request-side items need to be promoted into the richer response-item enum. It centralizes the normalization between the two closely related protocol types.

*Call graph*: called by 2 (response_item_from_user_input, response_input_message_conversion_preserves_phase).


##### `ResponseInputItem::from`  (lines 1540–1542)

```
fn from(items: Vec<UserInput>) -> Self
```

**Purpose**: Converts a vector of `UserInput` into a user-role `ResponseInputItem::Message` using the default local-image processing mode. It is the ergonomic entrypoint for prompt construction from user input.

**Data flow**: Consumes `Vec<UserInput>`, forwards it to `Self::from_user_input(items, LocalImagePreparation::Process)`, and returns the resulting `ResponseInputItem`. It has no side effects of its own.

**Call relations**: Used by many callers and tests that want the standard user-input conversion behavior. It delegates all real work to `from_user_input`.

*Call graph*: called by 8 (run_compact_task_inner_impl, image_user_input_preserves_requested_detail, local_image_non_image_adds_placeholder, local_image_read_error_adds_placeholder, local_image_unsupported_image_format_adds_placeholder, local_image_user_input_preserves_requested_detail, mixed_remote_and_local_images_share_label_sequence, serializes_image_user_input_without_tags); 1 external calls (from_user_input).


##### `ResponseInputItem::from_user_input`  (lines 1546–1595)

```
fn from_user_input(
        items: Vec<UserInput>,
        local_image_preparation: LocalImagePreparation,
    ) -> Self
```

**Purpose**: Converts structured `UserInput` values into a provider-facing user message with multimodal `ContentItem`s. It handles remote images, local images, image labeling, detail defaults, deferred local-image encoding, and placeholder text on failures.

**Data flow**: Consumes `Vec<UserInput>` and a `LocalImagePreparation` mode. It builds `ResponseInputItem::Message { role: "user", content, phase: None }`, where `content` is produced by flattening each input: text becomes `InputText`; remote images increment a shared image counter and become `InputImage` with defaulted detail; local images increment the same counter, read the file from disk, then either process bytes through `local_image_content_items_with_label_number` or wrap raw bytes as an octet-stream data URL via `local_image_content_items` when preparation is deferred; read failures become `local_image_error_placeholder`; `Skill` and `Mention` inputs are dropped entirely.

**Call relations**: This is the main user-input-to-provider-message conversion path. `ResponseInputItem::from` delegates here, and many tests exercise it to verify image sequencing, detail preservation, and placeholder behavior.

*Call graph*: called by 1 (response_item_from_user_input).


##### `function_call_output_content_items_to_text`  (lines 1663–1683)

```
fn function_call_output_content_items_to_text(
    content_items: &[FunctionCallOutputContentItem],
) -> Option<String>
```

**Purpose**: Lossily converts structured function-call output content into plain text for human-readable surfaces. Only non-blank `InputText` items are kept; images and encrypted content are ignored.

**Data flow**: Borrows a slice of `FunctionCallOutputContentItem`, filters for `InputText { text }` where `text.trim()` is non-empty, collects borrowed text segments, returns `None` if none remain, otherwise joins them with `\n` and returns `Some(String)`.

**Call relations**: Used by logging, previews, and `FunctionCallOutputBody::to_text` when callers still need a string representation of multimodal tool output.

*Call graph*: called by 9 (into_text, log_preview, handle_call, handle_call, handle_call, expect_text_output, to_text, function_call_output_content_items_to_text_ignores_blank_text_and_images, function_call_output_content_items_to_text_joins_text_segments); 1 external calls (iter).


##### `FunctionCallOutputContentItem::from`  (lines 1688–1700)

```
fn from(item: crate::dynamic_tools::DynamicToolCallOutputContentItem) -> Self
```

**Purpose**: Converts a dynamic-tool output content item into the protocol’s function-call output content item. Image outputs are assigned the default image detail.

**Data flow**: Consumes `crate::dynamic_tools::DynamicToolCallOutputContentItem`, matches on the variant, and returns either `InputText { text }` or `InputImage { image_url, detail: Some(DEFAULT_IMAGE_DETAIL) }`. It has no side effects.

**Call relations**: Used when dynamic tool outputs are adapted into the protocol’s standardized function-call output payload format.


##### `FunctionCallOutputBody::to_text`  (lines 1727–1732)

```
fn to_text(&self) -> Option<String>
```

**Purpose**: Returns a best-effort plain-text representation of a function-call output body. Plain string bodies are returned directly; structured content bodies are reduced via the lossy text extractor.

**Data flow**: Borrows `self`, clones and returns the inner string for `Text`, or delegates `ContentItems(items)` to `function_call_output_content_items_to_text(items)`. It does not mutate state.

**Call relations**: Used by callers that need a readable string regardless of whether the authoritative payload is plain text or structured multimodal content.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text).


##### `FunctionCallOutputBody::default`  (lines 1736–1738)

```
fn default() -> Self
```

**Purpose**: Provides an empty text body as the default function-call output body. This keeps default payloads string-shaped rather than array-shaped.

**Data flow**: Returns `FunctionCallOutputBody::Text(String::new())`. It reads no external state.

**Call relations**: Used by default construction of `FunctionCallOutputPayload` and any generic code relying on `Default`.

*Call graph*: 2 external calls (Text, new).


##### `FunctionCallOutputPayload::from_text`  (lines 1742–1747)

```
fn from_text(content: String) -> Self
```

**Purpose**: Constructs a function-call output payload from plain text with no explicit success metadata. It is the simplest payload constructor.

**Data flow**: Consumes a `String`, wraps it as `FunctionCallOutputBody::Text(content)`, sets `success` to `None`, and returns `FunctionCallOutputPayload { body, success }`.

**Call relations**: Used widely when tool outputs are naturally string-only. It is the text counterpart to `from_content_items`.

*Call graph*: called by 9 (dynamic_tool_call_round_trip_sends_text_content_items_to_model, custom_tool_call_output, record_items_truncates_custom_tool_call_output_content, ensure_call_outputs_present, seed_guardian_parent_history, external_context_pollution_items_exclude_local_tool_calls, to_response_item, azure_responses_request_includes_store_and_reasoning_ids, serializes_success_as_plain_string); 1 external calls (Text).


##### `FunctionCallOutputPayload::from_content_items`  (lines 1749–1754)

```
fn from_content_items(content_items: Vec<FunctionCallOutputContentItem>) -> Self
```

**Purpose**: Constructs a function-call output payload from structured content items with no explicit success metadata. This is used for multimodal or encrypted tool outputs.

**Data flow**: Consumes `Vec<FunctionCallOutputContentItem>`, wraps it as `FunctionCallOutputBody::ContentItems(content_items)`, sets `success` to `None`, and returns the payload.

**Call relations**: Used when tool outputs need to preserve images or encrypted content rather than collapsing to a string.

*Call graph*: called by 12 (encrypted_function_output_uses_plaintext_byte_estimate, image_data_url_payload_does_not_dominate_custom_tool_call_output_estimate, image_data_url_payload_does_not_dominate_function_call_output_estimate, non_base64_image_urls_are_unchanged, non_image_base64_data_url_is_unchanged, original_detail_images_are_capped_at_max_patch_count, original_detail_images_scale_with_dimensions, original_detail_webp_images_scale_with_dimensions, image_output, to_response_item (+2 more)); 1 external calls (ContentItems).


##### `FunctionCallOutputPayload::text_content`  (lines 1756–1761)

```
fn text_content(&self) -> Option<&str>
```

**Purpose**: Returns a shared reference to the inner text only when the payload body is plain text. Structured content bodies return `None`.

**Data flow**: Borrows `self`, matches on `self.body`, and returns `Some(&str)` for `Text` or `None` for `ContentItems`. It mutates nothing.

**Call relations**: Used by callers that specifically want direct access to string bodies without lossy conversion.


##### `FunctionCallOutputPayload::text_content_mut`  (lines 1763–1768)

```
fn text_content_mut(&mut self) -> Option<&mut String>
```

**Purpose**: Returns a mutable reference to the inner text only when the payload body is plain text. Structured content bodies cannot be edited through this accessor.

**Data flow**: Mutably borrows `self`, matches on `self.body`, and returns `Some(&mut String)` for `Text` or `None` for `ContentItems`. It does not itself modify the string.

**Call relations**: Used by callers that need to edit plain-text tool output in place while leaving structured payloads untouched.


##### `FunctionCallOutputPayload::content_items`  (lines 1770–1775)

```
fn content_items(&self) -> Option<&[FunctionCallOutputContentItem]>
```

**Purpose**: Returns a shared slice of structured content items only when the payload body is array-shaped. Plain text bodies return `None`.

**Data flow**: Borrows `self`, matches on `self.body`, and returns `Some(&[FunctionCallOutputContentItem])` for `ContentItems` or `None` for `Text`. It mutates nothing.

**Call relations**: Used by code that extracts image URLs or otherwise inspects structured tool output.

*Call graph*: called by 1 (output_image_urls).


##### `FunctionCallOutputPayload::content_items_mut`  (lines 1777–1782)

```
fn content_items_mut(&mut self) -> Option<&mut Vec<FunctionCallOutputContentItem>>
```

**Purpose**: Returns a mutable reference to the structured content vector only when the payload body is array-shaped. Plain text bodies return `None`.

**Data flow**: Mutably borrows `self`, matches on `self.body`, and returns `Some(&mut Vec<FunctionCallOutputContentItem>)` for `ContentItems` or `None` for `Text`. It does not itself mutate the vector.

**Call relations**: Used by callers that need to edit structured tool output in place.


##### `FunctionCallOutputPayload::serialize`  (lines 1789–1797)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes the payload body directly as the wire value for `function_call_output.output`: either a plain string or an array of content items. The internal `success` field is intentionally omitted from the wire format.

**Data flow**: Borrows `self`, matches on `self.body`, and either calls `serializer.serialize_str(content)` for `Text` or serializes the `items` vector directly for `ContentItems`. It writes to the serde serializer.

**Call relations**: Invoked automatically by serde when function-call output payloads are serialized. It enforces the special wire encoding documented in the file comments.

*Call graph*: 1 external calls (serialize_str).


##### `FunctionCallOutputPayload::deserialize`  (lines 1801–1810)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes a function-call output payload from either a plain string or an array of structured content items. The internal `success` field is always reset to `None` on input.

**Data flow**: Consumes a serde deserializer, deserializes `FunctionCallOutputBody`, wraps it in `FunctionCallOutputPayload { body, success: None }`, and returns the result.

**Call relations**: Used automatically by serde for incoming function-call output payloads. It is the inverse of the custom serializer’s body-only wire format.

*Call graph*: 1 external calls (deserialize).


##### `CallToolResult::from_result`  (lines 1814–1819)

```
fn from_result(result: Result<Self, String>) -> Self
```

**Purpose**: Normalizes a `Result<CallToolResult, String>` into a `CallToolResult`, converting error strings into structured error payloads. This gives callers a single return type regardless of success or failure.

**Data flow**: Consumes `Result<Self, String>`, returns the inner `CallToolResult` on `Ok`, or delegates `Err(error)` to `Self::from_error_text(error)`. It mutates no external state.

**Call relations**: Used by tool-call handling code that naturally produces `Result` values but needs protocol `CallToolResult` output.

*Call graph*: 1 external calls (from_error_text).


##### `CallToolResult::from_error_text`  (lines 1821–1831)

```
fn from_error_text(text: String) -> Self
```

**Purpose**: Builds a structured MCP tool-call result representing an error message. The error is encoded as a single text content item with `is_error: Some(true)`.

**Data flow**: Consumes an error `String`, constructs `content` as a one-element JSON array item `{ "type": "text", "text": text }`, sets `structured_content` to `None`, `is_error` to `Some(true)`, `meta` to `None`, and returns the new `CallToolResult`.

**Call relations**: Called by `from_result` and any code that needs to synthesize an MCP-style error result from plain text.

*Call graph*: 1 external calls (vec!).


##### `CallToolResult::success`  (lines 1833–1835)

```
fn success(&self) -> bool
```

**Purpose**: Returns whether the tool-call result should be treated as successful. Only `is_error == Some(true)` counts as failure.

**Data flow**: Borrows `self`, compares `self.is_error` to `Some(true)`, negates that comparison, and returns the `bool`. It mutates nothing.

**Call relations**: Used by `as_function_call_output_payload` to populate the payload’s internal `success` metadata.

*Call graph*: called by 1 (as_function_call_output_payload).


##### `CallToolResult::as_function_call_output_payload`  (lines 1837–1878)

```
fn as_function_call_output_payload(&self) -> FunctionCallOutputPayload
```

**Purpose**: Converts an MCP `CallToolResult` into the protocol’s function-call output payload, preserving structured content when possible. Structured JSON content takes precedence; otherwise image-bearing MCP content becomes multimodal content items, and everything else falls back to serialized JSON text.

**Data flow**: Borrows `self`. If `structured_content` exists and is non-null, it serializes that JSON to a text body, or returns the serialization error text with `success: Some(false)` on failure. Otherwise it serializes `self.content` to JSON text, attempts `convert_mcp_content_to_items(&self.content)`, chooses `ContentItems` when that returns `Some` or `Text(serialized_content)` when it returns `None`, and returns `FunctionCallOutputPayload { body, success: Some(self.success()) }`.

**Call relations**: Called by `into_function_call_output_payload` and indirectly by `ResponseItem::from` for MCP tool-call outputs. It delegates MCP content interpretation to `convert_mcp_content_to_items`.

*Call graph*: calls 2 internal fn (success, convert_mcp_content_to_items); called by 1 (into_function_call_output_payload); 3 external calls (ContentItems, Text, to_string).


##### `CallToolResult::into_function_call_output_payload`  (lines 1880–1882)

```
fn into_function_call_output_payload(self) -> FunctionCallOutputPayload
```

**Purpose**: Consumes a `CallToolResult` and returns its function-call output payload representation. It is an ownership-taking convenience wrapper over the borrowing conversion method.

**Data flow**: Consumes `self`, calls `self.as_function_call_output_payload()`, and returns the resulting `FunctionCallOutputPayload`. No external state is modified.

**Call relations**: Used when callers already own the `CallToolResult` and want to move directly into the payload form without keeping the original value.

*Call graph*: calls 1 internal fn (as_function_call_output_payload).


##### `convert_mcp_content_to_items`  (lines 1885–1950)

```
fn convert_mcp_content_to_items(
    contents: &[serde_json::Value],
) -> Option<Vec<FunctionCallOutputContentItem>>
```

**Purpose**: Attempts to reinterpret MCP content JSON as structured function-call output content items, but only returns `Some` when at least one image is present. Text-only content intentionally falls back to plain serialized JSON elsewhere.

**Data flow**: Borrows a slice of `serde_json::Value`, defines a local `McpContent` enum for deserialization, iterates through each content value, and converts it into `FunctionCallOutputContentItem`: MCP text becomes `InputText`; MCP image becomes `InputImage` with a preserved or synthesized data URL and detail inferred from `_meta["codex/imageDetail"]` or defaulted; unknown or unparsable content becomes `InputText` containing serialized JSON. It tracks whether any image was seen and returns `Some(items)` only if `saw_image` is true, otherwise `None`.

**Call relations**: Called by `CallToolResult::as_function_call_output_payload` and exercised directly by tests. It is the key bridge that preserves multimodal MCP outputs instead of collapsing them to opaque JSON strings.

*Call graph*: called by 3 (as_function_call_output_payload, convert_mcp_content_to_items_builds_data_urls_when_missing_prefix, convert_mcp_content_to_items_preserves_data_urls); 4 external calls (len, with_capacity, format!, to_string).


##### `FunctionCallOutputPayload::fmt`  (lines 1957–1965)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a function-call output payload as text for logging and simple test assertions. Plain text bodies print directly; structured content bodies print as JSON.

**Data flow**: Borrows `self`, writes the inner string directly for `Text`, or serializes `ContentItems` to JSON with `serde_json::to_string(items).unwrap_or_default()` and writes that string to the formatter. It returns `fmt::Result`.

**Call relations**: Invoked implicitly by Rust formatting when payloads are displayed. It gives callers a string-like view even for structured content.

*Call graph*: 2 external calls (write_str, to_string).


##### `tests::plaintext_agent_message_content_rejects_mixed_encrypted_content`  (lines 1988–1999)

```
fn plaintext_agent_message_content_rejects_mixed_encrypted_content()
```

**Purpose**: Verifies that plaintext extraction fails when any encrypted content is mixed into an agent message. This enforces the fail-closed behavior of `plaintext_agent_message_content`.

**Data flow**: Builds a two-element content vector containing one plaintext part and one encrypted part, calls `plaintext_agent_message_content(&content)`, and asserts the result is `None`.

**Call relations**: Run by the test harness as a focused regression test for mixed plaintext/encrypted agent messages.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::response_input_message_conversion_preserves_phase`  (lines 2002–2023)

```
fn response_input_message_conversion_preserves_phase()
```

**Purpose**: Checks that converting `ResponseInputItem::Message` into `ResponseItem` preserves the optional `MessagePhase`. This guards against losing commentary/final-answer distinctions during conversion.

**Data flow**: Constructs a `ResponseInputItem::Message` with `phase: Some(Commentary)`, converts it with `ResponseItem::from`, and asserts equality with the expected `ResponseItem::Message` carrying the same phase and `metadata: None`.

**Call relations**: Executed by the test harness to validate the `From<ResponseInputItem> for ResponseItem` implementation.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert_eq!, vec!).


##### `tests::response_item_metadata_round_trips_and_stamps_turn_ids`  (lines 2026–2058)

```
fn response_item_metadata_round_trips_and_stamps_turn_ids() -> Result<()>
```

**Purpose**: Exercises metadata serialization, unknown-field tolerance, and turn-ID stamping semantics on `ResponseItem`. It verifies that existing non-empty IDs are preserved, empty IDs can be replaced, and unsupported variants ignore stamping.

**Data flow**: Builds response items with and without metadata using local helpers, round-trips one through `serde_json::to_value`/`from_value`, deserializes another from JSON containing an extra unknown metadata field, calls `stamp_turn_id_if_missing` under several conditions, and asserts the resulting `turn_id()` values and item equality.

**Call relations**: Run by the test harness as the main regression suite for `ResponseItem` metadata helpers and serde behavior.

*Call graph*: 6 external calls (assert_eq!, response_item_metadata, response_item_with_metadata, from_value, json!, to_value).


##### `tests::response_item_with_metadata`  (lines 2060–2070)

```
fn response_item_with_metadata(metadata: Option<ResponseItemMetadata>) -> ResponseItem
```

**Purpose**: Creates a simple `ResponseItem::Message` carrying optional metadata for use in metadata-related tests. It avoids repeating the same fixture construction.

**Data flow**: Accepts `Option<ResponseItemMetadata>`, constructs a user-role message with one `InputText` content item and the supplied metadata, and returns it.

**Call relations**: Used only by `tests::response_item_metadata_round_trips_and_stamps_turn_ids` as a local fixture helper.

*Call graph*: 1 external calls (vec!).


##### `tests::response_item_metadata`  (lines 2072–2076)

```
fn response_item_metadata(turn_id: &str) -> ResponseItemMetadata
```

**Purpose**: Constructs a `ResponseItemMetadata` fixture with a chosen turn ID string. It is a tiny helper for metadata tests.

**Data flow**: Accepts `turn_id: &str`, clones it into `Some(String)`, wraps it in `ResponseItemMetadata`, and returns the struct.

**Call relations**: Used by the metadata round-trip/stamping test to build expected metadata values succinctly.


##### `tests::image_detail_roundtrips_all_wire_values`  (lines 2079–2106)

```
fn image_detail_roundtrips_all_wire_values() -> Result<()>
```

**Purpose**: Verifies serde round-tripping for `ImageDetail` enum values and for `ContentItem::InputImage` carrying a detail field. This locks down the wire strings such as `"auto"` and `"low"`.

**Data flow**: Deserializes and serializes `ImageDetail` values with serde JSON, deserializes an `input_image` content item from JSON, and asserts the resulting enum and content-item values match expectations.

**Call relations**: Run by the test harness to protect the image-detail wire contract.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `tests::sandbox_permissions_helpers_match_documented_semantics`  (lines 2109–2141)

```
fn sandbox_permissions_helpers_match_documented_semantics()
```

**Purpose**: Checks that the three `SandboxPermissions` predicate helpers return the documented booleans for each enum variant. This prevents semantic drift in command-override handling.

**Data flow**: Iterates over a table of expected booleans for each `SandboxPermissions` variant and asserts the outputs of `requires_escalated_permissions`, `requests_sandbox_override`, and `uses_additional_permissions` match.

**Call relations**: Executed by the test harness as a compact semantic test for the enum helper methods.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::convert_mcp_content_to_items_preserves_data_urls`  (lines 2144–2159)

```
fn convert_mcp_content_to_items_preserves_data_urls()
```

**Purpose**: Verifies that MCP image content already expressed as a data URL is preserved unchanged when converted to structured output items. The converter must not prepend a second `data:` prefix.

**Data flow**: Builds a one-element MCP content JSON array containing an image with `data: "data:image/png;base64,Zm9v"`, calls `convert_mcp_content_to_items`, unwraps the result, and asserts it equals a single `InputImage` item with the same URL and default detail.

**Call relations**: Run by the test harness as a regression test for MCP image conversion.

*Call graph*: calls 1 internal fn (convert_mcp_content_to_items); 2 external calls (assert_eq!, vec!).


##### `tests::response_item_parses_image_generation_call`  (lines 2162–2182)

```
fn response_item_parses_image_generation_call()
```

**Purpose**: Checks that a complete `image_generation_call` JSON object deserializes into the expected `ResponseItem::ImageGenerationCall`. This protects the provider wire contract for image generation.

**Data flow**: Deserializes a JSON value containing `id`, `status`, `revised_prompt`, and `result` into `ResponseItem` and asserts equality with the expected enum variant carrying `metadata: None`.

**Call relations**: Executed by the test harness as one of the image-generation response-item serde tests.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::response_item_parses_image_generation_call_without_revised_prompt`  (lines 2185–2204)

```
fn response_item_parses_image_generation_call_without_revised_prompt()
```

**Purpose**: Verifies that `image_generation_call` deserialization works when `revised_prompt` is omitted. The field should become `None` rather than causing failure.

**Data flow**: Deserializes a JSON value lacking `revised_prompt` into `ResponseItem` and asserts equality with `ResponseItem::ImageGenerationCall { revised_prompt: None, ... }`.

**Call relations**: Complements the previous image-generation serde test by covering the optional-field case.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::additional_permission_profile_is_empty_when_all_fields_are_none`  (lines 2207–2209)

```
fn additional_permission_profile_is_empty_when_all_fields_are_none()
```

**Purpose**: Confirms that the default additional-permission profile is considered empty when both optional sections are absent.

**Data flow**: Constructs `AdditionalPermissionProfile::default()`, calls `.is_empty()`, and asserts the result is `true`.

**Call relations**: Run by the test harness as a basic semantic check for overlay emptiness.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::additional_permission_profile_is_not_empty_when_field_is_present_but_nested_empty`  (lines 2212–2218)

```
fn additional_permission_profile_is_not_empty_when_field_is_present_but_nested_empty()
```

**Purpose**: Verifies that an additional-permission profile counts as non-empty when a nested section is present, even if that nested section itself carries no explicit setting. This distinguishes explicit presence from total absence.

**Data flow**: Constructs `AdditionalPermissionProfile { network: Some(NetworkPermissions { enabled: None }), file_system: None }`, calls `.is_empty()`, and asserts the result is `false`.

**Call relations**: Executed by the test harness to lock down the subtle semantics of overlay emptiness.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::permission_profile_round_trip_preserves_glob_scan_max_depth`  (lines 2221–2240)

```
fn permission_profile_round_trip_preserves_glob_scan_max_depth()
```

**Purpose**: Checks that converting runtime permissions into a `PermissionProfile` and back preserves `glob_scan_max_depth`. This guards against losing deny-glob scanning limits in profile projection.

**Data flow**: Builds a restricted `FileSystemSandboxPolicy` with one deny glob and `glob_scan_max_depth = Some(2)`, converts it with `PermissionProfile::from_runtime_permissions`, then asserts that `permission_profile.file_system_sandbox_policy()` equals the original policy.

**Call relations**: Run by the test harness as a regression test for permission-profile fidelity.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert_eq!, vec!).


##### `tests::permission_profile_deserializes_legacy_rollout_shape`  (lines 2243–2280)

```
fn permission_profile_deserializes_legacy_rollout_shape() -> Result<()>
```

**Purpose**: Verifies that the legacy untagged rollout JSON shape still deserializes into the modern managed `PermissionProfile`. This preserves backward compatibility for stored thread data.

**Data flow**: Builds legacy JSON with `network.enabled` and canonical `file_system.entries`, deserializes it into `PermissionProfile`, and asserts equality with the expected managed profile containing a restricted filesystem and enabled network.

**Call relations**: Executed by the test harness to validate the custom `Deserialize` impl for `PermissionProfile`.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `tests::permission_profile_presets_match_legacy_defaults`  (lines 2283–2294)

```
fn permission_profile_presets_match_legacy_defaults()
```

**Purpose**: Checks that the built-in `read_only` and `workspace_write` permission-profile presets match the projection of the corresponding legacy sandbox-policy defaults. This keeps old and new preset constructors aligned.

**Data flow**: Constructs modern presets with `PermissionProfile::read_only()` and `PermissionProfile::workspace_write()`, constructs legacy equivalents via `PermissionProfile::from_legacy_sandbox_policy(...)`, and asserts equality for both pairs.

**Call relations**: Run by the test harness as a compatibility test between modern presets and legacy sandbox defaults.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::permission_profile_round_trip_preserves_disabled_sandbox`  (lines 2297–2315)

```
fn permission_profile_round_trip_preserves_disabled_sandbox() -> Result<()>
```

**Purpose**: Verifies that legacy full-access sandboxing projects to `PermissionProfile::Disabled` and round-trips back to the same legacy policy and runtime permissions. This distinguishes disabled sandboxing from managed unrestricted access.

**Data flow**: Creates a temp directory for cwd, converts `SandboxPolicy::DangerFullAccess` with `PermissionProfile::from_legacy_sandbox_policy`, asserts the profile is `Disabled`, asserts `to_legacy_sandbox_policy(cwd)` returns `DangerFullAccess`, and asserts `to_runtime_permissions()` returns unrestricted filesystem plus enabled network.

**Call relations**: Executed by the test harness as a key regression test for disabled-sandbox semantics.

*Call graph*: calls 1 internal fn (from_legacy_sandbox_policy); 2 external calls (assert_eq!, tempdir).


##### `tests::disabled_permission_profile_ignores_runtime_network_policy`  (lines 2318–2326)

```
fn disabled_permission_profile_ignores_runtime_network_policy()
```

**Purpose**: Checks that explicit disabled enforcement wins over a restricted runtime network policy when constructing a permission profile. The result should still be `PermissionProfile::Disabled`.

**Data flow**: Calls `PermissionProfile::from_runtime_permissions_with_enforcement(SandboxEnforcement::Disabled, &FileSystemSandboxPolicy::unrestricted(), NetworkSandboxPolicy::Restricted)` and asserts the result is `PermissionProfile::Disabled`.

**Call relations**: Run by the test harness to lock down the precedence of enforcement mode over runtime network policy.

*Call graph*: calls 2 internal fn (from_runtime_permissions_with_enforcement, unrestricted); 1 external calls (assert_eq!).


##### `tests::permission_profile_from_runtime_permissions_preserves_external_sandbox`  (lines 2329–2349)

```
fn permission_profile_from_runtime_permissions_preserves_external_sandbox()
```

**Purpose**: Verifies that an external filesystem sandbox projects to `PermissionProfile::External` and remains external even if explicit enforcement is set to managed. Filesystem kind takes precedence.

**Data flow**: Builds `FileSystemSandboxPolicy::external_sandbox()`, converts it with both `from_runtime_permissions` and `from_runtime_permissions_with_enforcement(SandboxEnforcement::Managed, ...)`, and asserts both results equal `PermissionProfile::External { network: Restricted }`.

**Call relations**: Executed by the test harness as a regression test for external-sandbox projection.

*Call graph*: calls 2 internal fn (from_runtime_permissions, external_sandbox); 1 external calls (assert_eq!).


##### `tests::permission_profile_from_runtime_permissions_preserves_unrestricted_managed_network`  (lines 2352–2374)

```
fn permission_profile_from_runtime_permissions_preserves_unrestricted_managed_network()
```

**Purpose**: Checks that unrestricted filesystem plus non-disabled enforcement remains a managed unrestricted profile rather than collapsing to `Disabled`. This preserves split-policy semantics where filesystem and network differ.

**Data flow**: Calls `PermissionProfile::from_runtime_permissions_with_enforcement(SandboxEnforcement::External, &FileSystemSandboxPolicy::unrestricted(), NetworkSandboxPolicy::Restricted)`, asserts the result is managed unrestricted with restricted network, and asserts `to_runtime_permissions()` reproduces unrestricted filesystem plus restricted network.

**Call relations**: Run by the test harness to protect the distinction between disabled sandboxing and managed unrestricted filesystem access.

*Call graph*: calls 2 internal fn (from_runtime_permissions_with_enforcement, unrestricted); 1 external calls (assert_eq!).


##### `tests::permission_profile_round_trip_preserves_external_sandbox`  (lines 2377–2402)

```
fn permission_profile_round_trip_preserves_external_sandbox() -> Result<()>
```

**Purpose**: Verifies that a legacy external sandbox policy projects to `PermissionProfile::External` and round-trips back to the same legacy policy and runtime permissions.

**Data flow**: Creates a temp cwd, builds `SandboxPolicy::ExternalSandbox { network_access: Restricted }`, converts it with `PermissionProfile::from_legacy_sandbox_policy`, asserts the profile is external with restricted network, asserts `to_legacy_sandbox_policy(cwd)` returns the original legacy policy, and asserts `to_runtime_permissions()` returns external filesystem plus restricted network.

**Call relations**: Executed by the test harness as the external-sandbox counterpart to the disabled-sandbox round-trip test.

*Call graph*: calls 1 internal fn (from_legacy_sandbox_policy); 2 external calls (assert_eq!, tempdir).


##### `tests::file_system_permissions_with_glob_scan_depth_uses_canonical_json`  (lines 2405–2434)

```
fn file_system_permissions_with_glob_scan_depth_uses_canonical_json() -> Result<()>
```

**Purpose**: Checks that filesystem permissions serialize to the canonical entry-based JSON shape when `glob_scan_max_depth` is present, rather than the legacy read/write-root shape. It also verifies round-trip fidelity.

**Data flow**: Builds a `FileSystemPermissions` with one explicit path entry and `glob_scan_max_depth = Some(2)`, serializes it to JSON, asserts `read` and `write` keys are absent while `entries` and `glob_scan_max_depth` are present, then deserializes back and asserts equality.

**Call relations**: Run by the test harness to validate the custom serializer/deserializer behavior for filesystem permissions.

*Call graph*: calls 1 internal fn (try_from); 7 external calls (new, from, assert!, assert_eq!, cfg!, to_value, vec!).


##### `tests::file_system_permissions_rejects_zero_glob_scan_depth`  (lines 2437–2443)

```
fn file_system_permissions_rejects_zero_glob_scan_depth()
```

**Purpose**: Verifies that `glob_scan_max_depth: 0` fails deserialization because the field is modeled as `Option<NonZeroUsize>`. This prevents invalid zero-depth values from entering the protocol model.

**Data flow**: Attempts to deserialize JSON with `entries: []` and `glob_scan_max_depth: 0` into `FileSystemPermissions` and expects an error.

**Call relations**: Executed by the test harness as a validation test for the filesystem-permissions schema.

*Call graph*: 1 external calls (json!).


##### `tests::convert_mcp_content_to_items_builds_data_urls_when_missing_prefix`  (lines 2446–2461)

```
fn convert_mcp_content_to_items_builds_data_urls_when_missing_prefix()
```

**Purpose**: Checks that MCP image content lacking a `data:` prefix is converted into a proper base64 data URL using the supplied MIME type. This preserves image usability in multimodal outputs.

**Data flow**: Builds MCP image JSON with `data: "Zm9v"` and `mimeType: "image/png"`, calls `convert_mcp_content_to_items`, unwraps the result, and asserts it equals one `InputImage` with URL `data:image/png;base64,Zm9v` and default detail.

**Call relations**: Run by the test harness as the complement to the data-URL preservation test.

*Call graph*: calls 1 internal fn (convert_mcp_content_to_items); 2 external calls (assert_eq!, vec!).


##### `tests::convert_mcp_content_to_items_returns_none_without_images`  (lines 2464–2471)

```
fn convert_mcp_content_to_items_returns_none_without_images()
```

**Purpose**: Verifies that text-only MCP content does not produce structured content items and instead should fall back to plain serialized JSON elsewhere. This is an intentional design choice of the converter.

**Data flow**: Builds a one-element MCP text JSON array, calls `convert_mcp_content_to_items`, and asserts the result is `None`.

**Call relations**: Executed by the test harness to document the converter’s image-gated behavior.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::function_call_output_content_items_to_text_joins_text_segments`  (lines 2474–2490)

```
fn function_call_output_content_items_to_text_joins_text_segments()
```

**Purpose**: Checks that the lossy text extractor joins multiple non-blank text segments with newlines while ignoring image items. This defines the human-readable fallback for multimodal outputs.

**Data flow**: Builds a vector containing text, image, and text content items, calls `function_call_output_content_items_to_text`, and asserts the result is `Some("line 1\nline 2")`.

**Call relations**: Run by the test harness as a direct test of the text-extraction helper.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text); 2 external calls (assert_eq!, vec!).


##### `tests::function_call_output_content_items_to_text_ignores_blank_text_and_images`  (lines 2493–2509)

```
fn function_call_output_content_items_to_text_ignores_blank_text_and_images()
```

**Purpose**: Verifies that blank text, images, and encrypted content do not contribute to the lossy text fallback. If nothing readable remains, the helper should return `None`.

**Data flow**: Builds content items containing blank text, an image, and encrypted content, calls `function_call_output_content_items_to_text`, and asserts the result is `None`.

**Call relations**: Complements the previous text-extraction test by covering the all-non-readable case.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text); 2 external calls (assert_eq!, vec!).


##### `tests::function_call_output_body_to_text_returns_plain_text_content`  (lines 2512–2516)

```
fn function_call_output_body_to_text_returns_plain_text_content()
```

**Purpose**: Checks that `FunctionCallOutputBody::to_text` returns the inner string unchanged for plain text bodies.

**Data flow**: Constructs `FunctionCallOutputBody::Text("ok")`, calls `.to_text()`, and asserts the result is `Some("ok")`.

**Call relations**: Run by the test harness as the simplest `to_text` case.

*Call graph*: 2 external calls (assert_eq!, Text).


##### `tests::function_call_output_body_to_text_uses_content_item_fallback`  (lines 2519–2532)

```
fn function_call_output_body_to_text_uses_content_item_fallback()
```

**Purpose**: Verifies that `FunctionCallOutputBody::to_text` delegates structured content bodies to the lossy text extractor. Images should be ignored while text survives.

**Data flow**: Constructs `FunctionCallOutputBody::ContentItems` containing one text item and one image item, calls `.to_text()`, and asserts the result is `Some("line 1")`.

**Call relations**: Executed by the test harness to validate the structured-body branch of `to_text`.

*Call graph*: 3 external calls (assert_eq!, ContentItems, vec!).


##### `tests::function_call_deserializes_optional_namespace`  (lines 2535–2556)

```
fn function_call_deserializes_optional_namespace()
```

**Purpose**: Checks that `ResponseItem::FunctionCall` accepts an optional `namespace` field during deserialization. This preserves compatibility with namespaced tool-call payloads.

**Data flow**: Deserializes JSON for a `function_call` item containing `namespace`, then asserts equality with the expected `ResponseItem::FunctionCall` carrying `namespace: Some(...)` and `metadata: None`.

**Call relations**: Run by the test harness as a serde regression test for function-call items.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `tests::render_command_prefix_list_sorts_by_len_then_total_len_then_alphabetical`  (lines 2559–2580)

```
fn render_command_prefix_list_sorts_by_len_then_total_len_then_alphabetical()
```

**Purpose**: Verifies the deterministic sorting order used by `format_allow_prefixes`: first token count, then combined token length, then lexical order. This keeps approval messages stable and predictable.

**Data flow**: Builds an unsorted vector of command prefixes, formats it with `format_allow_prefixes`, and asserts the resulting bullet list matches the expected sorted order.

**Call relations**: Executed by the test harness as a direct test of prefix sorting behavior.

*Call graph*: calls 1 internal fn (format_allow_prefixes); 2 external calls (assert_eq!, vec!).


##### `tests::render_command_prefix_list_limits_output_to_max_prefixes`  (lines 2583–2592)

```
fn render_command_prefix_list_limits_output_to_max_prefixes()
```

**Purpose**: Checks that `format_allow_prefixes` truncates by maximum prefix count and appends the truncation marker. This prevents excessively long approval messages.

**Data flow**: Builds more than `MAX_RENDERED_PREFIXES` one-token prefixes, formats them, asserts the output ends with `TRUNCATED_MARKER`, prints it for debugging, and asserts the line count equals `MAX_RENDERED_PREFIXES + 1`.

**Call relations**: Run by the test harness as the count-based truncation test for prefix formatting.

*Call graph*: calls 1 internal fn (format_allow_prefixes); 2 external calls (assert_eq!, eprintln!).


##### `tests::format_allow_prefixes_limits_output`  (lines 2595–2612)

```
fn format_allow_prefixes_limits_output()
```

**Purpose**: Verifies that `format_allow_prefixes` also enforces the byte-length limit, not just the prefix-count limit. This protects UI surfaces from oversized rendered text.

**Data flow**: Builds an exec policy with many long allowed prefixes, formats the resulting prefix list, and asserts the output length does not exceed `MAX_ALLOW_PREFIX_TEXT_BYTES + TRUNCATED_MARKER.len()`.

**Call relations**: Executed by the test harness as the byte-budget truncation test for prefix formatting.

*Call graph*: calls 1 internal fn (format_allow_prefixes); 3 external calls (assert!, empty, format!).


##### `tests::serializes_success_as_plain_string`  (lines 2615–2627)

```
fn serializes_success_as_plain_string() -> Result<()>
```

**Purpose**: Checks that a plain-text successful function-call output serializes with `output` as a JSON string rather than an object wrapper. This locks down the special wire encoding of `FunctionCallOutputPayload`.

**Data flow**: Builds `ResponseInputItem::FunctionCallOutput` with `FunctionCallOutputPayload::from_text("ok")`, serializes it to JSON, parses the JSON back into `serde_json::Value`, and asserts `output` is the string `"ok"`.

**Call relations**: Run by the test harness as a serialization test for plain-text function-call outputs.

*Call graph*: calls 1 internal fn (from_text); 3 external calls (assert_eq!, from_str, to_string).


##### `tests::serializes_failure_as_string`  (lines 2630–2644)

```
fn serializes_failure_as_string() -> Result<()>
```

**Purpose**: Verifies that even when internal `success` metadata is `Some(false)`, a plain-text function-call output still serializes as a bare JSON string. The success flag is intentionally not part of the wire format.

**Data flow**: Builds a `FunctionCallOutputPayload` with `body: Text("bad")` and `success: Some(false)`, wraps it in `ResponseInputItem::FunctionCallOutput`, serializes to JSON, parses back to `Value`, and asserts `output` is the string `"bad"`.

**Call relations**: Complements the previous serialization test by covering the failure-metadata case.

*Call graph*: 4 external calls (assert_eq!, Text, from_str, to_string).


##### `tests::serializes_image_outputs_as_array`  (lines 2647–2689)

```
fn serializes_image_outputs_as_array() -> Result<()>
```

**Purpose**: Checks that MCP tool results containing images convert into structured content items and serialize as an array-valued `output`. This preserves multimodal outputs on the wire.

**Data flow**: Builds a `CallToolResult` with text and image MCP content, converts it with `into_function_call_output_payload`, asserts `success == Some(true)` and that `content_items()` returns the expected text-plus-image items, wraps the payload in `ResponseInputItem::FunctionCallOutput`, serializes to JSON, and asserts `output` is an array.

**Call relations**: Run by the test harness as the main multimodal serialization test for function-call outputs.

*Call graph*: 6 external calls (assert!, assert_eq!, panic!, from_str, to_string, vec!).


##### `tests::serializes_custom_tool_image_outputs_as_array`  (lines 2692–2711)

```
fn serializes_custom_tool_image_outputs_as_array() -> Result<()>
```

**Purpose**: Verifies that custom-tool outputs carrying image content items also serialize `output` as an array. This ensures custom tools share the same multimodal wire behavior as function-call outputs.

**Data flow**: Builds `ResponseInputItem::CustomToolCallOutput` with `FunctionCallOutputPayload::from_content_items` containing one image item, serializes to JSON, parses back to `Value`, and asserts `output` is an array.

**Call relations**: Executed by the test harness as the custom-tool counterpart to the previous image-output serialization test.

*Call graph*: calls 1 internal fn (from_content_items); 4 external calls (assert!, from_str, to_string, vec!).


##### `tests::serializes_encrypted_function_output_content_as_array`  (lines 2714–2740)

```
fn serializes_encrypted_function_output_content_as_array() -> Result<()>
```

**Purpose**: Checks that encrypted structured function-call output serializes as an array of content items rather than collapsing to text. This preserves opaque encrypted payloads faithfully.

**Data flow**: Builds `ResponseInputItem::FunctionCallOutput` with `FunctionCallOutputPayload::from_content_items` containing one `EncryptedContent` item, serializes to JSON value, and asserts exact equality with the expected array-shaped JSON.

**Call relations**: Run by the test harness to validate encrypted structured-output serialization.

*Call graph*: calls 1 internal fn (from_content_items); 3 external calls (assert_eq!, to_value, vec!).


##### `tests::preserves_existing_image_data_urls`  (lines 2743–2769)

```
fn preserves_existing_image_data_urls() -> Result<()>
```

**Purpose**: Verifies that MCP image content already using a data URL remains unchanged after conversion into function-call output payload content items.

**Data flow**: Builds a `CallToolResult` with one MCP image whose `data` field is already a data URL, converts it into a payload, extracts `content_items()`, and asserts the resulting `InputImage` item preserves the original URL and default detail.

**Call relations**: Executed by the test harness as another regression test for MCP image conversion fidelity.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


##### `tests::preserves_original_detail_metadata_on_mcp_images`  (lines 2772–2801)

```
fn preserves_original_detail_metadata_on_mcp_images() -> Result<()>
```

**Purpose**: Checks that MCP image `_meta` carrying `codex/imageDetail: original` is preserved as `ImageDetail::Original` in converted content items.

**Data flow**: Builds a `CallToolResult` with one MCP image and `_meta` detail `original`, converts it into a payload, extracts `content_items()`, and asserts the resulting `InputImage` has `detail: Some(ImageDetail::Original)`.

**Call relations**: Run by the test harness to validate detail-metadata preservation for MCP images.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


##### `tests::preserves_standard_detail_metadata_on_mcp_images`  (lines 2804–2833)

```
fn preserves_standard_detail_metadata_on_mcp_images() -> Result<()>
```

**Purpose**: Verifies that standard MCP image detail metadata such as `high` is preserved during conversion to structured content items.

**Data flow**: Builds a `CallToolResult` with one MCP image and `_meta` detail `high`, converts it into a payload, extracts `content_items()`, and asserts the resulting `InputImage` has `detail: Some(ImageDetail::High)`.

**Call relations**: Complements the previous test by covering a non-`original` detail value.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


##### `tests::deserializes_array_payload_into_items`  (lines 2836–2864)

```
fn deserializes_array_payload_into_items() -> Result<()>
```

**Purpose**: Checks that an array-valued function-call output payload deserializes into `FunctionCallOutputBody::ContentItems` and reserializes back to the same array. This validates the custom payload serde logic.

**Data flow**: Parses a JSON array containing `input_text` and `input_image` items into `FunctionCallOutputPayload`, asserts `success` is `None`, asserts the body equals the expected `ContentItems` vector, and asserts serializing the payload yields the same JSON as serializing the expected items directly.

**Call relations**: Run by the test harness as a direct serde round-trip test for array-shaped payloads.

*Call graph*: 3 external calls (assert_eq!, from_str, vec!).


##### `tests::deserializes_encrypted_array_payload_into_items`  (lines 2867–2888)

```
fn deserializes_encrypted_array_payload_into_items() -> Result<()>
```

**Purpose**: Verifies that array-valued payloads containing `encrypted_content` deserialize correctly into structured content items and round-trip through serialization.

**Data flow**: Parses a JSON array with one `encrypted_content` item into `FunctionCallOutputPayload`, asserts `success` is `None`, asserts the body equals the expected `ContentItems` vector, and asserts serialization matches the expected array JSON.

**Call relations**: Executed by the test harness as the encrypted-content counterpart to the previous array-payload test.

*Call graph*: 3 external calls (assert_eq!, from_str, vec!).


##### `tests::deserializes_compaction_alias`  (lines 2891–2904)

```
fn deserializes_compaction_alias() -> Result<()>
```

**Purpose**: Checks that the legacy `compaction_summary` type alias still deserializes into `ResponseItem::Compaction`. This preserves compatibility with older payloads.

**Data flow**: Parses a JSON string with `type: "compaction_summary"` and `encrypted_content`, deserializes it into `ResponseItem`, and asserts equality with `ResponseItem::Compaction { ... }`.

**Call relations**: Run by the test harness as a serde compatibility test for compaction aliases.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::deserializes_context_compaction`  (lines 2907–2920)

```
fn deserializes_context_compaction() -> Result<()>
```

**Purpose**: Verifies that `context_compaction` response items deserialize into the dedicated `ResponseItem::ContextCompaction` variant with optional encrypted content.

**Data flow**: Parses JSON with `type: "context_compaction"` and `encrypted_content`, deserializes into `ResponseItem`, and asserts equality with the expected variant.

**Call relations**: Executed by the test harness as a serde test for the newer context-compaction item type.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::serializes_compaction_trigger_without_payload`  (lines 2923–2933)

```
fn serializes_compaction_trigger_without_payload() -> Result<()>
```

**Purpose**: Checks that `ResponseItem::CompactionTrigger` serializes to a minimal object containing only its `type` when metadata is absent.

**Data flow**: Constructs `ResponseItem::CompactionTrigger { metadata: None }`, serializes it to JSON value, and asserts exact equality with `{ "type": "compaction_trigger" }`.

**Call relations**: Run by the test harness as a serialization test for payload-less compaction triggers.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::serializes_stamped_compaction_trigger_metadata`  (lines 2936–2950)

```
fn serializes_stamped_compaction_trigger_metadata() -> Result<()>
```

**Purpose**: Verifies that stamping a turn ID onto a compaction trigger causes metadata to serialize correctly. This exercises both metadata stamping and serde output.

**Data flow**: Constructs `ResponseItem::CompactionTrigger { metadata: None }`, calls `stamp_turn_id_if_missing("turn-1")`, serializes to JSON value, and asserts the result includes `metadata.turn_id`.

**Call relations**: Executed by the test harness as a combined test of metadata helpers and compaction-trigger serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::deserializes_compaction_trigger_without_payload`  (lines 2953–2960)

```
fn deserializes_compaction_trigger_without_payload() -> Result<()>
```

**Purpose**: Checks that a minimal `compaction_trigger` JSON object deserializes successfully into `ResponseItem::CompactionTrigger { metadata: None }`.

**Data flow**: Parses the JSON string `{ "type":"compaction_trigger" }` into `ResponseItem` and asserts equality with the expected variant.

**Call relations**: Run by the test harness as the deserialization counterpart to the compaction-trigger serialization test.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::deserializes_legacy_ghost_snapshot_as_other`  (lines 2963–2978)

```
fn deserializes_legacy_ghost_snapshot_as_other() -> Result<()>
```

**Purpose**: Verifies that unknown legacy response-item types such as `ghost_snapshot` deserialize into `ResponseItem::Other` rather than failing. This preserves forward and backward compatibility.

**Data flow**: Parses a JSON object with `type: "ghost_snapshot"` and nested payload into `ResponseItem` and asserts the result is `ResponseItem::Other`.

**Call relations**: Executed by the test harness to validate the catch-all `#[serde(other)]` behavior.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::roundtrips_web_search_call_actions`  (lines 2981–3068)

```
fn roundtrips_web_search_call_actions() -> Result<()>
```

**Purpose**: Exercises deserialization and serialization of `web_search_call` items across several action variants and a partial item lacking action details. It verifies both parsed enum values and round-trip JSON behavior.

**Data flow**: Iterates over a table of JSON literals and expected parsed values, deserializes each into `ResponseItem`, asserts equality with the expected `WebSearchCall` variant, serializes back to JSON value, optionally removes `id` from the expected JSON for partial cases, and asserts equality.

**Call relations**: Run by the test harness as the main serde regression suite for web-search call actions.

*Call graph*: 4 external calls (assert_eq!, from_str, to_value, vec!).


##### `tests::serializes_image_user_input_without_tags`  (lines 3071–3091)

```
fn serializes_image_user_input_without_tags() -> Result<()>
```

**Purpose**: Checks that remote image user input becomes a single `InputImage` content item without surrounding textual image tags. Only local images receive label tags.

**Data flow**: Builds `Vec<UserInput>` containing one remote image with `detail: None`, converts it with `ResponseInputItem::from`, pattern-matches the resulting message, and asserts the content is exactly one `InputImage` with default detail.

**Call relations**: Executed by the test harness as a user-input conversion test for remote images.

*Call graph*: calls 1 internal fn (from); 3 external calls (assert_eq!, panic!, vec!).


##### `tests::image_user_input_preserves_requested_detail`  (lines 3094–3116)

```
fn image_user_input_preserves_requested_detail() -> Result<()>
```

**Purpose**: Verifies that remote image user input preserves an explicitly requested `ImageDetail` rather than replacing it with the default.

**Data flow**: Builds one `UserInput::Image` with `detail: Some(ImageDetail::Original)`, converts it with `ResponseInputItem::from`, pattern-matches the message content, and asserts the first item is an `InputImage` carrying `Original` detail.

**Call relations**: Run by the test harness as a detail-preservation test for remote image inputs.

*Call graph*: calls 1 internal fn (from); 3 external calls (assert_eq!, panic!, vec!).


##### `tests::tool_search_call_roundtrips`  (lines 3119–3161)

```
fn tool_search_call_roundtrips() -> Result<()>
```

**Purpose**: Checks serde round-tripping for `ResponseItem::ToolSearchCall`, including optional `call_id` and arbitrary JSON `arguments`. This protects the wire contract for tool-search requests.

**Data flow**: Deserializes a JSON `tool_search_call` object into `ResponseItem`, asserts equality with the expected enum variant, then serializes the parsed item back to JSON value and asserts exact equality with the original shape.

**Call relations**: Executed by the test harness as a serde regression test for tool-search call items.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::tool_search_output_roundtrips`  (lines 3164–3233)

```
fn tool_search_output_roundtrips() -> Result<()>
```

**Purpose**: Verifies both conversion from `ResponseInputItem::ToolSearchOutput` to `ResponseItem` and direct serialization of the input item. This ensures tool-search outputs preserve call ID, execution mode, status, and tool metadata.

**Data flow**: Builds a `ResponseInputItem::ToolSearchOutput` with one tool JSON object, asserts `ResponseItem::from(input.clone())` equals the expected `ResponseItem::ToolSearchOutput`, then serializes the input item to JSON value and asserts exact equality with the expected wire shape.

**Call relations**: Run by the test harness as the main conversion/serialization test for tool-search outputs.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::tool_search_server_items_allow_null_call_id`  (lines 3236–3283)

```
fn tool_search_server_items_allow_null_call_id() -> Result<()>
```

**Purpose**: Checks that server-side tool-search call and output items accept `null` `call_id` values during deserialization. This preserves compatibility with server-originated search flows.

**Data flow**: Deserializes one `tool_search_call` JSON object and one `tool_search_output` JSON object, both with `call_id: null`, into `ResponseItem` values and asserts equality with the expected variants carrying `call_id: None`.

**Call relations**: Executed by the test harness as a serde compatibility test for nullable tool-search IDs.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::mixed_remote_and_local_images_share_label_sequence`  (lines 3286–3336)

```
fn mixed_remote_and_local_images_share_label_sequence() -> Result<()>
```

**Purpose**: Verifies that remote and local images share a single monotonically increasing image label sequence when converted from user input. Local image tags should reflect the combined ordering, not just local-image count.

**Data flow**: Creates a temp local PNG file, builds user input containing one remote image followed by one local image, converts it with `ResponseInputItem::from`, pattern-matches the message content, and asserts the remote image is first while the local image open tag uses label number 2 and is followed by an image item and close tag.

**Call relations**: Run by the test harness as a sequencing test for mixed multimodal user input.

*Call graph*: calls 1 internal fn (from); 6 external calls (assert!, assert_eq!, panic!, write, tempdir, vec!).


##### `tests::local_image_open_tag_preserves_path`  (lines 3339–3347)

```
fn local_image_open_tag_preserves_path()
```

**Purpose**: Checks that `local_image_open_tag_text_with_path` embeds the path text verbatim, including special characters. This documents the exact textual marker format.

**Data flow**: Calls `local_image_open_tag_text_with_path(1, Path::new(r#"/tmp/a&"<b>.png"#))` and asserts the returned string matches the expected literal tag.

**Call relations**: Executed by the test harness as a direct formatting test for local-image open tags.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::local_image_user_input_preserves_requested_detail`  (lines 3350–3374)

```
fn local_image_user_input_preserves_requested_detail() -> Result<()>
```

**Purpose**: Verifies that local image user input preserves an explicitly requested image detail through file reading and prompt-content construction.

**Data flow**: Creates a temp PNG file, builds one `UserInput::LocalImage` with `detail: Some(ImageDetail::Original)`, converts it with `ResponseInputItem::from`, pattern-matches the message content, and asserts the embedded `InputImage` item carries `Original` detail.

**Call relations**: Run by the test harness as the local-image counterpart to the remote-image detail-preservation test.

*Call graph*: calls 1 internal fn (from); 5 external calls (assert!, panic!, write, tempdir, vec!).


##### `tests::local_image_read_error_adds_placeholder`  (lines 3377–3408)

```
fn local_image_read_error_adds_placeholder() -> Result<()>
```

**Purpose**: Checks that missing local image files produce a single explanatory text placeholder instead of failing conversion. The placeholder should mention both the path and the read problem.

**Data flow**: Builds one `UserInput::LocalImage` pointing at a nonexistent file, converts it with `ResponseInputItem::from`, pattern-matches the resulting message content, and asserts there is exactly one `InputText` item whose text mentions the missing path and the phrase `could not read`.

**Call relations**: Executed by the test harness as a degraded-path test for local-image conversion.

*Call graph*: calls 1 internal fn (from); 5 external calls (assert!, assert_eq!, panic!, tempdir, vec!).


##### `tests::local_image_non_image_adds_placeholder`  (lines 3411–3442)

```
fn local_image_non_image_adds_placeholder() -> Result<()>
```

**Purpose**: Verifies that a local file with a non-image MIME type produces an unsupported-image placeholder rather than an image attachment. This keeps prompts informative when users attach the wrong file type.

**Data flow**: Creates a temp JSON file, builds one `UserInput::LocalImage` pointing at it, converts it with `ResponseInputItem::from`, pattern-matches the message content, and asserts there is one `InputText` placeholder mentioning the unsupported MIME type and the file path.

**Call relations**: Run by the test harness as an unsupported-format test for local-image conversion.

*Call graph*: calls 1 internal fn (from); 6 external calls (assert!, assert_eq!, panic!, write, tempdir, vec!).


##### `tests::local_image_unsupported_image_format_adds_placeholder`  (lines 3445–3475)

```
fn local_image_unsupported_image_format_adds_placeholder() -> Result<()>
```

**Purpose**: Checks that unsupported-but-image-like formats such as SVG produce the exact unsupported-image placeholder text. This distinguishes unsupported formats from generic read or decode failures.

**Data flow**: Creates a temp SVG file, builds one `UserInput::LocalImage` pointing at it, converts it with `ResponseInputItem::from`, pattern-matches the message content, and asserts the sole `InputText` item equals the expected formatted placeholder string.

**Call relations**: Executed by the test harness as a precise regression test for unsupported image-format messaging.

*Call graph*: calls 1 internal fn (from); 6 external calls (assert_eq!, format!, panic!, write, tempdir, vec!).


### `protocol/src/account.rs`

`data_model` · `cross-cutting`

This file is primarily a data-model definition for account state. `PlanType` is a serde/JSON-schema/TypeScript-exported enum whose wire names are mostly lowercase, with explicit overrides for usage-based variants such as `self_serve_business_usage_based` and `enterprise_cbp_usage_based`; unknown serialized values deserialize to `Unknown` via `#[serde(other)]`. `ProviderAccount` captures provider-specific account identity before adaptation to a final wire type, distinguishing API-key usage, ChatGPT accounts with `email` and `plan_type`, and Amazon Bedrock accounts with an `AmazonBedrockCredentialSource` of either `CodexManaged` or `AwsManaged`. The behavioral logic is intentionally small and classification-oriented: `PlanType::is_team_like` groups `Team` with `SelfServeBusinessUsageBased`, `is_business_like` groups `Business` with `EnterpriseCbpUsageBased`, and `is_workspace_account` recognizes all workspace-oriented plans including team, business, enterprise, and education tiers while excluding personal plans like `Pro`. Two conversion impls bridge from auth-layer types: `From<AuthPlanType>` maps known plans through `KnownPlan` conversion and collapses unknown auth strings to `PlanType::Unknown`, while `From<KnownPlan>` performs the explicit variant-by-variant mapping. The inline tests lock down serialization names, helper classifications, workspace-account membership, and auth-to-account conversion behavior.

#### Function details

##### `PlanType::is_team_like`  (lines 55–57)

```
fn is_team_like(self) -> bool
```

**Purpose**: Classifies whether a plan belongs to the team-like family used by downstream account logic.

**Data flow**: Consumes `self` by value and returns `true` only for `PlanType::Team` and `PlanType::SelfServeBusinessUsageBased`; all other variants return `false`.

**Call relations**: This helper is called by code that needs coarse plan-family grouping rather than exact variant matching. It does not delegate further.

*Call graph*: 1 external calls (matches!).


##### `PlanType::is_business_like`  (lines 59–61)

```
fn is_business_like(self) -> bool
```

**Purpose**: Classifies whether a plan belongs to the business-like family.

**Data flow**: Consumes `self` and returns `true` for `PlanType::Business` and `PlanType::EnterpriseCbpUsageBased`, otherwise `false`.

**Call relations**: Used wherever business-tier behavior should apply to both classic and usage-based business plans.

*Call graph*: 1 external calls (matches!).


##### `PlanType::is_workspace_account`  (lines 63–73)

```
fn is_workspace_account(self) -> bool
```

**Purpose**: Determines whether a plan represents a workspace-oriented account rather than an individual plan.

**Data flow**: Consumes `self` and returns `true` for `Team`, `SelfServeBusinessUsageBased`, `Business`, `EnterpriseCbpUsageBased`, `Enterprise`, and `Edu`; returns `false` for other variants such as `Free`, `Go`, `Plus`, `Pro`, `ProLite`, and `Unknown`.

**Call relations**: This helper supports downstream logic that needs to distinguish workspace accounts from personal subscriptions.

*Call graph*: 1 external calls (matches!).


##### `PlanType::from`  (lines 86–100)

```
fn from(plan: KnownPlan) -> Self
```

**Purpose**: Converts auth-layer plan representations into protocol-layer `PlanType` values, preserving known variants and collapsing unknown ones.

**Data flow**: Accepts either `AuthPlanType::Known(plan)` or `AuthPlanType::Unknown(_)`; known plans are converted through the `From<KnownPlan> for PlanType` mapping, while unknown auth strings become `PlanType::Unknown`.

**Call relations**: This conversion bridges the authentication subsystem and the protocol/account model. It is used whenever auth-derived plan information is exposed through this module’s types.


##### `tests::usage_based_plan_types_use_expected_wire_names`  (lines 111–140)

```
fn usage_based_plan_types_use_expected_wire_names()
```

**Purpose**: Verifies serde serialization and deserialization names for usage-based plan variants and `ProLite`.

**Data flow**: Serializes selected `PlanType` variants to JSON strings and deserializes the corresponding wire names back into `PlanType`, asserting exact expected values in both directions.

**Call relations**: Run by the test harness to lock down the public wire-format contract of `PlanType`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::plan_family_helpers_group_usage_based_variants_with_existing_plans`  (lines 143–151)

```
fn plan_family_helpers_group_usage_based_variants_with_existing_plans()
```

**Purpose**: Checks that the team-like and business-like helper methods include the intended usage-based variants.

**Data flow**: Calls `is_team_like` and `is_business_like` on representative plan variants and asserts the expected boolean results.

**Call relations**: This test documents the grouping semantics encoded in the helper methods.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::workspace_account_helper_includes_usage_based_workspace_plans`  (lines 154–168)

```
fn workspace_account_helper_includes_usage_based_workspace_plans()
```

**Purpose**: Ensures the workspace-account helper returns true for all workspace-oriented plans, including usage-based variants, and false for personal plans.

**Data flow**: Invokes `is_workspace_account` on several plan variants and compares each result to the expected boolean with `assert_eq!`.

**Call relations**: Executed by the test harness to pin the membership of the workspace-account classification.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::auth_plan_type_converts_to_account_plan_type`  (lines 171–184)

```
fn auth_plan_type_converts_to_account_plan_type()
```

**Purpose**: Verifies conversion from auth-layer plan enums into protocol-layer `PlanType`, including unknown-plan fallback.

**Data flow**: Constructs `AuthPlanType::Known` and `AuthPlanType::Unknown` values, converts them with `PlanType::from`, and asserts the resulting `PlanType` variants.

**Call relations**: This test covers the auth-to-account adaptation path implemented by the conversion trait.

*Call graph*: 1 external calls (assert_eq!).


### `protocol/src/approvals.rs`

`data_model` · `request handling`

This file is primarily a schema module for approval-related events. It declares enums and structs for execution approvals, patch approvals, network approval context, guardian review metadata, and elicitation requests. Most types derive `Serialize`, `Deserialize`, `JsonSchema`, and `TS`, so the same Rust definitions drive wire format, JSON schema generation, and TypeScript bindings.

The most behavior-rich type is `ExecApprovalRequestEvent`. Besides carrying command tokens, working directory, optional reason, optional network context, proposed policy amendments, additional permissions, and parsed command structure, it computes two compatibility values. `effective_approval_id` chooses `approval_id` when present and otherwise falls back to `call_id`, preserving legacy semantics for prompts tied directly to the command item. `effective_available_decisions` returns the explicit `available_decisions` list when supplied, but otherwise reconstructs the legacy default set using `default_available_decisions`.

That defaulting logic is intentionally branchy: network approvals allow session approval and may surface a single allow-type network policy amendment; requests for additional filesystem permissions only allow approve or abort; ordinary exec approvals always allow approve, optionally include an execpolicy prefix amendment, and always include abort. `ElicitationRequest::message` abstracts over the `Form` and `Url` variants so callers can read the prompt text without matching on the mode. The tests focus on guardian action serialization shapes for backward-compatible protocol decoding.

#### Function details

##### `ExecPolicyAmendment::new`  (lines 45–47)

```
fn new(command: Vec<String>) -> Self
```

**Purpose**: Constructs an exec-policy amendment wrapper from a command-token prefix.

**Data flow**: It takes ownership of `Vec<String>` command tokens and returns `ExecPolicyAmendment { command }` unchanged.

**Call relations**: This is a convenience constructor for code that wants an explicit method rather than using the struct literal or `From<Vec<String>>` conversion.


##### `ExecPolicyAmendment::command`  (lines 49–51)

```
fn command(&self) -> &[String]
```

**Purpose**: Returns the amendment's command prefix as a borrowed slice.

**Data flow**: It reads the internal `Vec<String>` and returns `&[String]` without cloning or modifying it.

**Call relations**: This accessor supports callers that need to inspect the proposed prefix rule without taking ownership of the amendment.


##### `ExecPolicyAmendment::from`  (lines 55–57)

```
fn from(command: Vec<String>) -> Self
```

**Purpose**: Implements conversion from a vector of command tokens into an `ExecPolicyAmendment`.

**Data flow**: It consumes the input `Vec<String>` and wraps it directly in the struct.

**Call relations**: This trait impl provides ergonomic construction at call sites that already produce a token vector.


##### `ExecApprovalRequestEvent::effective_approval_id`  (lines 268–272)

```
fn effective_approval_id(&self) -> String
```

**Purpose**: Computes the stable approval identifier clients should use for this approval prompt.

**Data flow**: It reads `self.approval_id`; if present it clones and returns that string, otherwise it clones and returns `self.call_id`. No state is mutated.

**Call relations**: Approval handlers call this when processing callbacks so they can treat legacy command-level approvals and newer subcommand approvals uniformly.

*Call graph*: called by 2 (handle_exec_approval, handle_exec_approval_now).


##### `ExecApprovalRequestEvent::effective_available_decisions`  (lines 274–286)

```
fn effective_available_decisions(&self) -> Vec<ReviewDecision>
```

**Purpose**: Returns the review decisions to present, honoring explicit protocol data when available and reconstructing legacy defaults otherwise.

**Data flow**: It reads `self.available_decisions`. If `Some`, it clones and returns that vector. If `None`, it passes references to `network_approval_context`, `proposed_execpolicy_amendment`, `proposed_network_policy_amendments`, and `additional_permissions` into `default_available_decisions` and returns the computed vector.

**Call relations**: This is used by the immediate approval-handling path when rendering or validating user choices. It delegates to the static defaulting helper only for older senders that omitted the field.

*Call graph*: called by 1 (handle_exec_approval_now); 1 external calls (default_available_decisions).


##### `ExecApprovalRequestEvent::default_available_decisions`  (lines 288–321)

```
fn default_available_decisions(
        network_approval_context: Option<&NetworkApprovalContext>,
        proposed_execpolicy_amendment: Option<&ExecPolicyAmendment>,
        proposed_network_policy_
```

**Purpose**: Implements the legacy rules for which approval decisions are valid for a given approval context.

**Data flow**: It takes four optional inputs describing network context, execpolicy amendment, network policy amendments, and additional permissions. For network approvals, it starts with `Approved` and `ApprovedForSession`, optionally appends a `NetworkPolicyAmendment` decision for the first allow amendment found, then appends `Abort`. For additional-permission requests, it returns only `Approved` and `Abort`. Otherwise it returns `Approved`, optionally an `ApprovedExecpolicyAmendment` carrying a cloned prefix amendment, and `Abort`.

**Call relations**: This helper is only reached through `effective_available_decisions` when explicit decisions are absent, preserving backward compatibility with older protocol producers.

*Call graph*: 1 external calls (vec!).


##### `ElicitationRequest::message`  (lines 346–350)

```
fn message(&self) -> &str
```

**Purpose**: Extracts the human-readable prompt message from either elicitation variant.

**Data flow**: It pattern-matches on `self`; for both `Form` and `Url` variants it returns a borrowed `&str` pointing to the `message` field.

**Call relations**: This is a small convenience method for UI or orchestration code that needs the prompt text without caring whether the elicitation is schema-based or URL-based.


##### `tests::guardian_assessment_action_deserializes_command_shape`  (lines 400–417)

```
fn guardian_assessment_action_deserializes_command_shape()
```

**Purpose**: Verifies that the tagged JSON shape for a guardian `command` action deserializes into the expected enum variant.

**Data flow**: It builds a JSON object with `type: "command"`, deserializes it into `GuardianAssessmentAction`, and compares the result to the expected `Command` variant containing a normalized absolute cwd.

**Call relations**: This test protects the wire-format contract for guardian command assessments, especially the tagged enum shape and path deserialization.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `tests::guardian_assessment_action_round_trips_execve_shape`  (lines 421–450)

```
fn guardian_assessment_action_round_trips_execve_shape()
```

**Purpose**: Verifies that the `execve` guardian action shape both deserializes correctly and serializes back to the same JSON.

**Data flow**: It constructs a JSON value for an `execve` action, deserializes it into `GuardianAssessmentAction`, serializes the enum back to JSON, and asserts both round-trip equality and equality with the expected `Execve` variant.

**Call relations**: This test covers the more structured guardian action variant and ensures the serde representation remains stable in both directions.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


### `protocol/src/auth.rs`

`data_model` · `auth`

This file contains two small but important domains: account plan classification and refresh-token failure reporting. `PlanType` is an untagged enum that preserves unknown raw strings while still recognizing a curated set of known plans through `KnownPlan`. The `from_raw_value` helper lowercases incoming text and maps multiple aliases onto the same canonical plan, such as `enterprise` and `hc`, or `education` and `edu`. Unknown values are intentionally retained rather than rejected so the client can survive server-side plan additions.

`KnownPlan` provides lightweight behavior for presentation and policy decisions. `display_name` returns title-cased labels suitable for UI copy, `raw_value` returns the canonical lowercase identifier used in serialized or API-facing contexts, and `is_workspace_account` groups the plans that represent workspace-managed accounts rather than individual subscriptions.

The second half of the file defines `RefreshTokenFailedError`, a structured error carrying both a machine-readable `RefreshTokenFailedReason` and a human-readable message. The constructor accepts any `Into<String>` message source and stores both fields directly. The error derives `thiserror::Error` with the message as its display text, allowing higher-level error enums to wrap it cleanly. The lone test verifies serde alias handling for plan strings that should deserialize into canonical known plans.

#### Function details

##### `PlanType::from_raw_value`  (lines 13–30)

```
fn from_raw_value(raw: &str) -> Self
```

**Purpose**: Normalizes a raw plan string into either a canonical known plan or an unknown passthrough value.

**Data flow**: It takes `&str`, lowercases it with `to_ascii_lowercase`, matches the normalized text against known identifiers and aliases, and returns either `PlanType::Known(...)` with the corresponding `KnownPlan` or `PlanType::Unknown(raw.to_string())` preserving the original spelling.

**Call relations**: This is the explicit normalization path for code that receives raw plan identifiers outside serde deserialization and needs stable downstream plan handling.

*Call graph*: 2 external calls (Known, Unknown).


##### `KnownPlan::display_name`  (lines 54–68)

```
fn display_name(self) -> &'static str
```

**Purpose**: Returns the human-readable display label for a known plan.

**Data flow**: It matches on `self` and returns a static string such as `"Plus"`, `"Pro Lite"`, or `"Enterprise CBP Usage Based"`.

**Call relations**: This is a pure presentation helper for UI or messaging code that needs a friendly plan name rather than the serialized identifier.


##### `KnownPlan::raw_value`  (lines 70–84)

```
fn raw_value(self) -> &'static str
```

**Purpose**: Returns the canonical lowercase identifier for a known plan.

**Data flow**: It matches on `self` and returns a static string like `"free"`, `"enterprise"`, or `"self_serve_business_usage_based"`.

**Call relations**: This is the inverse-style helper to `display_name`, used when code needs the stable wire/API value for a known plan.


##### `KnownPlan::is_workspace_account`  (lines 86–96)

```
fn is_workspace_account(self) -> bool
```

**Purpose**: Classifies whether a known plan represents a workspace-managed account tier.

**Data flow**: It pattern-matches `self` against the workspace-oriented variants and returns `true` for those plans, `false` otherwise.

**Call relations**: This helper supports policy or messaging branches that differ between individual subscriptions and workspace-owned accounts.

*Call graph*: 1 external calls (matches!).


##### `RefreshTokenFailedError::new`  (lines 107–112)

```
fn new(reason: RefreshTokenFailedReason, message: impl Into<String>) -> Self
```

**Purpose**: Constructs a refresh-token failure error from a reason code and message.

**Data flow**: It takes a `RefreshTokenFailedReason` and any `message` implementing `Into<String>`, converts the message into an owned string, stores both fields in `RefreshTokenFailedError`, and returns it.

**Call relations**: Authentication and token-refresh flows call this when classifying refresh failures so they can propagate both structured reason and user-facing explanation through higher-level error handling.

*Call graph*: called by 4 (refresh_failure_is_scoped_to_the_matching_auth_snapshot, refresh_token, next, classify_refresh_token_failure); 1 external calls (into).


##### `tests::plan_type_deserializes_raw_aliases`  (lines 130–140)

```
fn plan_type_deserializes_raw_aliases()
```

**Purpose**: Verifies that serde deserialization accepts legacy or alternate raw plan strings and maps them to the expected known plans.

**Data flow**: It deserializes JSON strings `"hc"` and `"education"` into `PlanType` and asserts they become `Known(Enterprise)` and `Known(Edu)` respectively.

**Call relations**: This test protects the alias behavior encoded in the serde attributes on `KnownPlan` and the untagged `PlanType` representation.

*Call graph*: 1 external calls (assert_eq!).


### `protocol/src/capabilities.rs`

`data_model` · `cross-cutting protocol serialization/deserialization`

This file is a pure protocol model module centered on two public types. `SelectedCapabilityRoot` is a struct with an `id: String` and a `location: CapabilityRootLocation`; its documentation frames it as a stable identifier chosen by an external capability-selection platform plus the information needed to resolve that selection at runtime. `CapabilityRootLocation` is currently an enum with a single tagged variant, `Environment`, carrying `environment_id: String` and `path: String`. The serde attributes make the wire format explicit: field names use camelCase, the enum is externally represented with a discriminator field named `type`, and `environment_id` is serialized as `environmentId`. The same naming is mirrored for TypeScript generation via `ts_rs`. Both types derive `Debug`, `Clone`, `PartialEq`, `Eq`, `Serialize`, `Deserialize`, `JsonSchema`, and `TS`, signaling they are intended to move across process or language boundaries and to participate in schema/documentation tooling. An important design choice is extensibility: even though only `Environment` exists today, using an enum with a tagged representation leaves room for future location kinds without changing the top-level `SelectedCapabilityRoot` shape.


### `protocol/src/config_types.rs`

`config` · `config load`

This file is a broad configuration model module. Most items are enums or structs with serde/schema/TypeScript derives, but several include nontrivial validation or merge behavior. `ProfileV2Name` is a validated wrapper for profile filenames: it accepts only non-empty ASCII alphanumeric, underscore, and hyphen names, explicitly preventing path-like values from escaping `$CODEX_HOME/<name>.config.toml`. `ApprovalsReviewer` customizes its JSON schema so both `auto_review` and the legacy `guardian_subagent` value are documented as accepted strings.

`ShellEnvironmentPolicy` captures how command environments are built: inheritance mode, default-secret filtering toggle, explicit exclude/include wildcard patterns, injected variables, and whether to use the shell profile. Its `Default` implementation intentionally starts from full inheritance, ignores default excludes, and leaves all pattern lists empty.

The web-search types support layered configuration. `WebSearchLocation::merge` overlays non-`None` fields from another location, while `WebSearchToolConfig::merge` overlays scalar options and recursively merges nested locations. Conversion impls then translate tool-oriented config into the user-facing `WebSearchConfig` shape.

`ServiceTier` maps between internal enum variants and request strings, including compatibility with both `fast` and `priority`. `ModelProviderAuthInfo` turns millisecond fields into `Duration`s and supplies robust defaults, including a nonzero timeout and a cwd resolved from `.` or current directory. Finally, collaboration-mode types model the active mode plus model settings; `with_updates` and `apply_mask` produce new immutable values by selectively overriding model, reasoning effort, developer instructions, and optionally the mode itself. Tests cover aliasing, validation, visibility invariants, and merge semantics.

#### Function details

##### `ProfileV2Name::as_str`  (lines 103–105)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the validated profile name as a borrowed string slice.

**Data flow**: It reads the inner `String` and returns `&str` without allocation.

**Call relations**: This is the primitive accessor used by the `Deref` impl and any code that needs the validated profile name text.

*Call graph*: called by 1 (deref).


##### `ProfileV2NameParseError::fmt`  (lines 114–120)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a user-facing error explaining that the supplied profile value is invalid and should be a plain name.

**Data flow**: It reads the stored invalid `value` and writes a fixed explanatory message containing that value into the formatter.

**Call relations**: This display implementation is used whenever profile-name parsing fails and the error is surfaced to users or logs.

*Call graph*: 1 external calls (write!).


##### `ProfileV2Name::from_str`  (lines 128–140)

```
fn from_str(value: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses and validates a profile-v2 name from a string.

**Data flow**: It takes `&str`, rejects empty input and any byte that is not ASCII alphanumeric, underscore, or hyphen, and on failure returns `ProfileV2NameParseError { value: value.to_string() }`. On success it clones the string into `ProfileV2Name`.

**Call relations**: This is the sole validation gate for profile names, preventing path traversal or arbitrary file selection when profile names are turned into config filenames.


##### `ProfileV2Name::deref`  (lines 146–148)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Allows a `ProfileV2Name` to be used as `str`.

**Data flow**: It delegates to `as_str` and returns the borrowed slice.

**Call relations**: This ergonomic adapter lets callers pass profile names into generic string APIs without explicit conversion.

*Call graph*: calls 1 internal fn (as_str).


##### `ProfileV2Name::fmt`  (lines 152–154)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the profile name as its raw validated string.

**Data flow**: It delegates formatting to the inner `String` field and returns the formatter result.

**Call relations**: This supports display in CLI messages and diagnostics involving selected profile names.


##### `ApprovalsReviewer::schema_name`  (lines 175–177)

```
fn schema_name() -> String
```

**Purpose**: Provides a stable schema name for the custom JSON schema implementation.

**Data flow**: It returns the fixed string `"ApprovalsReviewer"`.

**Call relations**: Schema generation calls this alongside `json_schema` so the custom schema appears under a predictable type name.


##### `ApprovalsReviewer::json_schema`  (lines 179–184)

```
fn json_schema(_generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Builds a custom string-enum schema documenting both current and legacy accepted reviewer values.

**Data flow**: It ignores the generator, passes the accepted string values and a long description into `string_enum_schema_with_description`, and returns the resulting `Schema`.

**Call relations**: This overrides derive-generated schema output so external consumers see compatibility values like `guardian_subagent` even though serialization normalizes to `auto_review`.

*Call graph*: calls 1 internal fn (string_enum_schema_with_description).


##### `ShellEnvironmentPolicy::default`  (lines 234–243)

```
fn default() -> Self
```

**Purpose**: Constructs the baseline shell environment policy used when no explicit policy is configured.

**Data flow**: It returns a `ShellEnvironmentPolicy` with `inherit: All`, `ignore_default_excludes: true`, empty `exclude`, empty `set`, empty `include_only`, and `use_profile: false`.

**Call relations**: Environment-building and spawn-configuration code uses this default as the starting policy when approvals or profiles do not override environment behavior.

*Call graph*: called by 7 (from_approval_and_profile, populate_env_inserts_thread_id, populate_env_omits_thread_id_when_missing, test_core_inherit_defaults_keep_sensitive_vars, build_agent_spawn_config_uses_turn_context_values, create_env_from_core_vars, create_env_from_core_vars); 2 external calls (new, new).


##### `string_enum_schema_with_description`  (lines 246–262)

```
fn string_enum_schema_with_description(values: &[&str], description: &str) -> Schema
```

**Purpose**: Creates a JSON schema object for a string enum with an attached description.

**Data flow**: It takes a slice of allowed string values and a description, constructs a `SchemaObject` with string instance type and metadata description, fills `enum_values` with `serde_json::Value::String` entries for each allowed value, and returns `Schema::Object(schema)`.

**Call relations**: This helper exists to support the custom `ApprovalsReviewer` schema implementation and keep the schema-building logic localized.

*Call graph*: called by 1 (json_schema); 3 external calls (new, default, Object).


##### `WebSearchLocation::merge`  (lines 330–337)

```
fn merge(&self, other: &Self) -> Self
```

**Purpose**: Overlays one optional location onto another, preferring non-`None` fields from the overlay.

**Data flow**: It reads `self` and `other`, and for each field (`country`, `region`, `city`, `timezone`) returns `other.field.clone().or_else(|| self.field.clone())` in a new `WebSearchLocation`.

**Call relations**: This is the field-level merge primitive used when combining layered web-search configuration sources.


##### `WebSearchToolConfig::merge`  (lines 349–363)

```
fn merge(&self, other: &Self) -> Self
```

**Purpose**: Combines two tool-level web-search configs, preferring overlay values while preserving unspecified base values.

**Data flow**: It reads both configs and returns a new one where `context_size` prefers `other`, `allowed_domains` prefers `other` when present otherwise clones `self`, and `location` is merged recursively when both sides exist or cloned from whichever side is present.

**Call relations**: This is the higher-level merge operation for layered tool config and delegates nested location merging to `WebSearchLocation::merge`.


##### `WebSearchUserLocation::from`  (lines 402–410)

```
fn from(location: WebSearchLocation) -> Self
```

**Purpose**: Converts a generic web-search location into the user-location shape expected by another config surface.

**Data flow**: It consumes a `WebSearchLocation`, copies its optional geographic fields into `WebSearchUserLocation`, and sets `type` to `Approximate`.

**Call relations**: This conversion is used when translating tool config into the broader `WebSearchConfig` representation.


##### `WebSearchConfig::from`  (lines 414–424)

```
fn from(config: WebSearchToolConfig) -> Self
```

**Purpose**: Converts tool-oriented web-search configuration into the normalized `WebSearchConfig` structure.

**Data flow**: It consumes `WebSearchToolConfig`, maps `allowed_domains` into `Some(WebSearchFilters { allowed_domains: Some(...) })` when present, converts `location` via `Into<WebSearchUserLocation>`, copies `context_size` into `search_context_size`, and returns the assembled config.

**Call relations**: This conversion bridges two related config shapes so downstream code can consume a single normalized web-search configuration model.


##### `ServiceTier::request_value`  (lines 442–447)

```
fn request_value(self) -> &'static str
```

**Purpose**: Returns the request/API string corresponding to a service tier.

**Data flow**: It matches on `self` and returns `"priority"` for `Fast` and `"flex"` for `Flex`.

**Call relations**: This is used when serializing an explicit service-tier choice into outbound request parameters.


##### `ServiceTier::from_request_value`  (lines 449–455)

```
fn from_request_value(value: &str) -> Option<Self>
```

**Purpose**: Parses a request/API string into a known service tier.

**Data flow**: It matches the input `&str`, returning `Some(Fast)` for `"fast"` or `"priority"`, `Some(Flex)` for `"flex"`, and `None` for anything else.

**Call relations**: Configuration application code calls this when interpreting request values or persisted strings back into the enum.

*Call graph*: called by 1 (apply).


##### `ModelProviderAuthInfo::timeout`  (lines 496–498)

```
fn timeout(&self) -> Duration
```

**Purpose**: Converts the configured nonzero timeout in milliseconds into a `Duration`.

**Data flow**: It reads `self.timeout_ms`, extracts the inner `u64` with `get()`, wraps it with `Duration::from_millis`, and returns the duration.

**Call relations**: Provider-auth execution code uses this helper instead of reading raw milliseconds directly.

*Call graph*: 2 external calls (from_millis, get).


##### `ModelProviderAuthInfo::refresh_interval`  (lines 500–502)

```
fn refresh_interval(&self) -> Option<Duration>
```

**Purpose**: Converts the configured refresh interval into an optional `Duration`, treating zero as disabled.

**Data flow**: It reads `self.refresh_interval_ms`, attempts `NonZeroU64::new(...)`, and maps a present value to `Duration::from_millis(value.get())`; zero yields `None`.

**Call relations**: Token-cache refresh logic uses this helper to distinguish proactive refresh disabled (`None`) from a concrete refresh cadence.

*Call graph*: 1 external calls (new).


##### `default_provider_auth_timeout_ms`  (lines 505–510)

```
fn default_provider_auth_timeout_ms() -> NonZeroU64
```

**Purpose**: Supplies the default nonzero timeout value for provider-auth commands.

**Data flow**: It passes the constant `DEFAULT_PROVIDER_AUTH_TIMEOUT_MS` and the config field name string into `non_zero_u64` and returns the resulting `NonZeroU64`.

**Call relations**: Serde defaulting for `ModelProviderAuthInfo.timeout_ms` uses this helper so the invariant that timeout is nonzero is enforced centrally.

*Call graph*: calls 1 internal fn (non_zero_u64).


##### `default_provider_auth_refresh_interval_ms`  (lines 512–514)

```
fn default_provider_auth_refresh_interval_ms() -> u64
```

**Purpose**: Supplies the default refresh interval in milliseconds for provider-auth commands.

**Data flow**: It returns the constant `DEFAULT_PROVIDER_AUTH_REFRESH_INTERVAL_MS` unchanged.

**Call relations**: Serde defaulting for `ModelProviderAuthInfo.refresh_interval_ms` uses this helper.


##### `non_zero_u64`  (lines 516–521)

```
fn non_zero_u64(value: u64, field_name: &str) -> NonZeroU64
```

**Purpose**: Converts a `u64` into `NonZeroU64`, panicking with a field-specific message if the value is zero.

**Data flow**: It takes a numeric value and field name, calls `NonZeroU64::new`, returns the wrapped value on success, and panics with `"{field_name} must be non-zero"` if the input is zero.

**Call relations**: This helper backs default construction for provider-auth timeout values and centralizes the invariant-checking panic message.

*Call graph*: called by 1 (default_provider_auth_timeout_ms); 2 external calls (new, panic!).


##### `default_provider_auth_cwd`  (lines 523–533)

```
fn default_provider_auth_cwd() -> AbsolutePathBuf
```

**Purpose**: Computes the default working directory for provider-auth commands.

**Data flow**: It first tries to deserialize `"."` into an `AbsolutePathBuf` using a string deserializer; if that succeeds it returns the resolved path. If not, it falls back to `AbsolutePathBuf::current_dir()`. If both mechanisms fail, it panics with an explanatory message.

**Call relations**: Serde defaulting and default-value comparison for `ModelProviderAuthInfo.cwd` rely on this helper to produce a stable absolute cwd.

*Call graph*: calls 2 internal fn (current_dir, deserialize); called by 1 (is_default_provider_auth_cwd); 2 external calls (panic!, new).


##### `is_default_provider_auth_cwd`  (lines 535–537)

```
fn is_default_provider_auth_cwd(path: &AbsolutePathBuf) -> bool
```

**Purpose**: Checks whether a provider-auth cwd equals the computed default cwd.

**Data flow**: It takes a borrowed `AbsolutePathBuf`, recomputes the default via `default_provider_auth_cwd`, compares for equality, and returns the boolean result.

**Call relations**: Schema/serde annotations use this predicate to skip serializing `cwd` when it matches the default.

*Call graph*: calls 1 internal fn (default_provider_auth_cwd).


##### `ModeKind::display_name`  (lines 601–608)

```
fn display_name(self) -> &'static str
```

**Purpose**: Returns the human-readable label for a collaboration mode kind.

**Data flow**: It matches on `self` and returns a static string such as `"Plan"`, `"Default"`, `"Pair Programming"`, or `"Execute"`.

**Call relations**: UI messaging code uses this when it needs to mention a mode by name, including request-user-input availability messages.

*Call graph*: called by 1 (request_user_input_unavailable_message).


##### `ModeKind::is_tui_visible`  (lines 610–612)

```
fn is_tui_visible(self) -> bool
```

**Purpose**: Reports whether a mode should be shown in the TUI's visible mode list.

**Data flow**: It pattern-matches `self` and returns `true` only for `Plan` and `Default`.

**Call relations**: Mode-selection code uses this to filter hidden compatibility/internal modes from the visible TUI mode set.

*Call graph*: called by 1 (mask_for_kind); 1 external calls (matches!).


##### `ModeKind::allows_request_user_input`  (lines 614–616)

```
fn allows_request_user_input(self) -> bool
```

**Purpose**: Reports whether the mode permits explicit request-user-input behavior.

**Data flow**: It returns `true` only when `self` is `Plan`, otherwise `false`.

**Call relations**: This supports runtime gating of user-input request features based on the active collaboration mode.

*Call graph*: 1 external calls (matches!).


##### `CollaborationMode::settings_ref`  (lines 629–631)

```
fn settings_ref(&self) -> &Settings
```

**Purpose**: Returns a shared reference to the embedded settings struct.

**Data flow**: It borrows `self.settings` and returns `&Settings`.

**Call relations**: This private helper avoids repeating field access in `model`, `reasoning_effort`, `with_updates`, and `apply_mask`.

*Call graph*: called by 4 (apply_mask, model, reasoning_effort, with_updates).


##### `CollaborationMode::model`  (lines 633–635)

```
fn model(&self) -> &str
```

**Purpose**: Returns the configured model name for the collaboration mode.

**Data flow**: It borrows the settings via `settings_ref`, reads `settings.model`, and returns it as `&str`.

**Call relations**: Snapshot-building code calls this when extracting the active model from the current collaboration mode.

*Call graph*: calls 1 internal fn (settings_ref); called by 1 (thread_config_snapshot).


##### `CollaborationMode::reasoning_effort`  (lines 637–639)

```
fn reasoning_effort(&self) -> Option<ReasoningEffort>
```

**Purpose**: Returns the configured reasoning-effort setting for the collaboration mode.

**Data flow**: It borrows the settings via `settings_ref`, clones the optional `ReasoningEffort`, and returns it.

**Call relations**: Snapshot-building code uses this to capture the active reasoning-effort setting alongside the model.

*Call graph*: calls 1 internal fn (settings_ref); called by 1 (thread_config_snapshot).


##### `CollaborationMode::with_updates`  (lines 648–666)

```
fn with_updates(
        &self,
        model: Option<String>,
        effort: Option<Option<ReasoningEffort>>,
        developer_instructions: Option<Option<String>>,
    ) -> Self
```

**Purpose**: Creates a new collaboration mode with selectively updated model, reasoning effort, and developer instructions while preserving the current mode kind.

**Data flow**: It takes optional overrides for `model`, `effort`, and `developer_instructions`, reads the current settings via `settings_ref`, substitutes provided values while cloning existing ones for omitted fields, constructs a new `Settings`, and returns a new `CollaborationMode` with the original `mode` and updated settings.

**Call relations**: Higher-level mode-update helpers call this when changing model-related settings without changing the collaboration mode kind itself.

*Call graph*: calls 1 internal fn (settings_ref); called by 1 (with_model).


##### `CollaborationMode::apply_mask`  (lines 673–689)

```
fn apply_mask(&self, mask: &CollaborationModeMask) -> Self
```

**Purpose**: Applies a partial mask to a collaboration mode, overriding only the fields present in the mask.

**Data flow**: It takes `&self` and a `CollaborationModeMask`, reads current settings via `settings_ref`, chooses `mask.mode.unwrap_or(self.mode)` for the mode, and for each settings field uses the mask's `Option` value when present or clones the existing value otherwise. It returns a new `CollaborationMode` and ignores `mask.name` entirely.

**Call relations**: This is the general-purpose overlay operation for named mode masks and is exercised directly by tests that verify optional fields can be cleared.

*Call graph*: calls 1 internal fn (settings_ref).


##### `tests::apply_mask_can_clear_optional_fields`  (lines 717–743)

```
fn apply_mask_can_clear_optional_fields()
```

**Purpose**: Verifies that applying a mask with `Some(None)` clears optional settings rather than preserving them.

**Data flow**: It constructs a base `CollaborationMode` with populated optional fields, constructs a mask that leaves mode/model unchanged but sets `reasoning_effort` and `developer_instructions` to `Some(None)`, applies the mask, and asserts the resulting mode matches the expected cleared settings.

**Call relations**: This test targets the subtle nested-`Option` semantics in `CollaborationMode::apply_mask`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::mode_kind_deserializes_alias_values_to_default`  (lines 746–752)

```
fn mode_kind_deserializes_alias_values_to_default()
```

**Purpose**: Checks that legacy or alias serialized mode names all deserialize to `ModeKind::Default`.

**Data flow**: It iterates over alias strings, formats each as JSON, deserializes into `ModeKind`, and asserts the result is `Default`.

**Call relations**: This test protects the serde alias compatibility encoded on the `ModeKind::Default` variant.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `tests::approvals_reviewer_serializes_auto_review_and_accepts_legacy_guardian_subagent`  (lines 755–777)

```
fn approvals_reviewer_serializes_auto_review_and_accepts_legacy_guardian_subagent()
```

**Purpose**: Verifies both serialization and deserialization compatibility for approval reviewer values.

**Data flow**: It checks `to_string()` and JSON serialization for `User` and `AutoReview`, then iterates over accepted input strings (`user`, `auto_review`, `guardian_subagent`), deserializes each into `ApprovalsReviewer`, and asserts the expected normalized variant.

**Call relations**: This test covers the compatibility contract that the schema and serde attributes are designed to preserve.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `tests::profile_v2_name_rejects_paths_and_empty_names`  (lines 780–795)

```
fn profile_v2_name_rejects_paths_and_empty_names()
```

**Purpose**: Ensures profile-name parsing rejects path-like values and empty strings.

**Data flow**: It calls `ProfileV2Name::from_str` with `"../foo"` and `""`, compares each result to the expected `ProfileV2NameParseError`, and includes assertion messages explaining the security and usability rationale.

**Call relations**: This test locks down the validation boundary that prevents arbitrary file access through profile selection.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::tui_visible_collaboration_modes_match_mode_kind_visibility`  (lines 798–808)

```
fn tui_visible_collaboration_modes_match_mode_kind_visibility()
```

**Purpose**: Checks that the exported visible-mode constant matches the per-mode visibility predicate.

**Data flow**: It compares `TUI_VISIBLE_COLLABORATION_MODES` to the expected array, asserts every listed mode returns `true` from `is_tui_visible`, and asserts hidden compatibility modes return `false`.

**Call relations**: This test keeps the constant list and the `ModeKind::is_tui_visible` logic in sync.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::web_search_location_merge_prefers_overlay_values`  (lines 811–833)

```
fn web_search_location_merge_prefers_overlay_values()
```

**Purpose**: Verifies that location merging keeps base values where the overlay is `None` and replaces them where the overlay is populated.

**Data flow**: It constructs base and overlay `WebSearchLocation` values, calls `merge`, and asserts the merged result contains the expected field-by-field combination.

**Call relations**: This test exercises the overlay semantics implemented by `WebSearchLocation::merge`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::web_search_tool_config_merge_prefers_overlay_values`  (lines 836–870)

```
fn web_search_tool_config_merge_prefers_overlay_values()
```

**Purpose**: Verifies that tool-config merging prefers overlay scalar values, preserves absent overlay lists, and recursively merges nested locations.

**Data flow**: It constructs base and overlay `WebSearchToolConfig` values, calls `merge`, and asserts the resulting config matches the expected combination of overridden and preserved fields.

**Call relations**: This test covers the full merge behavior of `WebSearchToolConfig::merge`, including delegation to nested location merging.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `protocol/src/dynamic_tools.rs`

`io_transport` · `config load`

This file models dynamic tool declarations, tool-call requests, and tool responses. The canonical schema distinguishes top-level `DynamicToolSpec::Function` entries from `DynamicToolSpec::Namespace` entries containing nested tools. Function specs carry a name, description, JSON input schema, and a `defer_loading` flag; namespace specs group functions under a namespace name.

The behavioral core is the legacy-normalization path. Older persisted metadata used a flatter shape with optional `namespace`, optional `exposeToContext`, and sometimes no explicit `type` tag. `normalize_dynamic_tool_specs` first scans the raw JSON array to detect whether any value or nested tool looks legacy and whether any value already uses canonical tagged format. Mixed legacy and canonical input is rejected outright with a custom serde error so callers cannot accidentally combine incompatible representations in one payload.

If the input is already canonical, the function simply deserializes each JSON value into `DynamicToolSpec`. For legacy input, it deserializes each item into `LegacyDynamicToolSpec`, converts it into a `DynamicToolFunctionSpec`, and derives `defer_loading` from the explicit field when present or from the inverse of `expose_to_context` for backward compatibility. The resulting `(namespace, function)` pairs are then grouped by namespace: unnamespaced functions stay top-level, while namespaced functions are accumulated into `DynamicToolSpec::Namespace` entries with empty descriptions. `deserialize_dynamic_tool_specs` plugs this normalization into serde field deserialization for optional arrays.

#### Function details

##### `normalize_dynamic_tool_specs`  (lines 88–131)

```
fn normalize_dynamic_tool_specs(
    values: Vec<JsonValue>,
) -> Result<Vec<DynamicToolSpec>, serde_json::Error>
```

**Purpose**: Normalizes a raw JSON array of dynamic tool specs into canonical `DynamicToolSpec` values, supporting either all-legacy or all-canonical input.

**Data flow**: It takes `Vec<JsonValue>`, defines a predicate that detects legacy markers (`namespace`, `exposeToContext`, or missing `type`), scans the array and any nested `tools` arrays to determine whether legacy and/or canonical formats are present, and returns a custom serde error if both appear together. If no legacy markers are found, it deserializes each value directly into `DynamicToolSpec`. Otherwise it deserializes each value into `LegacyDynamicToolSpec`, converts each to a `DynamicToolFunctionSpec` while deriving `defer_loading`, collects `(Option<String>, DynamicToolFunctionSpec)` pairs, and passes them to `group_dynamic_tools_by_namespace`.

**Call relations**: CLI parsing and serde field deserialization both call this as the single compatibility gateway for dynamic tool specs. It delegates namespace aggregation to `group_dynamic_tools_by_namespace` after legacy conversion.

*Call graph*: calls 1 internal fn (group_dynamic_tools_by_namespace); called by 2 (parse_dynamic_tools_arg, deserialize_dynamic_tool_specs); 1 external calls (custom).


##### `group_dynamic_tools_by_namespace`  (lines 133–159)

```
fn group_dynamic_tools_by_namespace(
    tools: Vec<(Option<String>, DynamicToolFunctionSpec)>,
) -> Vec<DynamicToolSpec>
```

**Purpose**: Aggregates legacy-style function specs into canonical top-level functions and namespace groups.

**Data flow**: It takes a vector of `(Option<String>, DynamicToolFunctionSpec)` pairs, initializes an output vector and a `HashMap<String, usize>` tracking namespace positions, then iterates through the pairs. Entries with `None` namespace become `DynamicToolSpec::Function`. Entries with a namespace are wrapped as `DynamicToolNamespaceTool::Function` and either appended to an existing namespace group's `tools` vector or used to create a new `DynamicToolSpec::Namespace` with an empty description. It returns the assembled `Vec<DynamicToolSpec>`.

**Call relations**: This function is only reached from `normalize_dynamic_tool_specs` after legacy items have been converted into function specs. The `unreachable!` branch documents the invariant that stored namespace indices must always point at namespace entries.

*Call graph*: called by 1 (normalize_dynamic_tool_specs); 8 external calls (new, new, with_capacity, Function, Function, Namespace, unreachable!, vec!).


##### `deserialize_dynamic_tool_specs`  (lines 161–173)

```
fn deserialize_dynamic_tool_specs(
    deserializer: D,
) -> Result<Option<Vec<DynamicToolSpec>>, D::Error>
```

**Purpose**: Serde helper that deserializes an optional raw JSON array of dynamic tool specs and normalizes it into canonical form.

**Data flow**: It takes a serde `Deserializer`, deserializes `Option<Vec<JsonValue>>`, returns `Ok(None)` if the field is absent/null, otherwise passes the raw values to `normalize_dynamic_tool_specs`, wraps the successful result in `Some`, and converts normalization failures into the deserializer's error type with `D::Error::custom`.

**Call relations**: This function is intended for use in serde attributes on containing structs so dynamic tool specs are normalized automatically during deserialization.

*Call graph*: calls 1 internal fn (normalize_dynamic_tool_specs); 1 external calls (deserialize).


### `protocol/src/error.rs`

`domain_logic` · `cross-cutting`

This file is the core error-model layer for the protocol crate. `CodexErr` is the umbrella enum used across the system, wrapping domain-specific failures such as stream disconnects, sandbox denials, HTTP status errors, usage limits, refresh-token failures, and common external error types. `SandboxErr` captures execution-specific failures, including denied commands with captured `ExecToolCallOutput` and optional network-policy context.

Several methods encode policy rather than mere formatting. `is_retryable` classifies each error variant into retryable and non-retryable buckets, which higher-level orchestration uses to decide whether to rerun a turn. `to_codex_protocol_error` maps internal failures into coarse protocol categories like `UsageLimitExceeded`, `Unauthorized`, `SandboxError`, or `Other`, and `to_error_event` packages that category with a formatted message for client consumption. `http_status_code_value` extracts an HTTP status code from the subset of errors that carry one.

The file also defines display wrappers for connection and stream failures, plus `UnexpectedResponseError`, whose formatting is intentionally nuanced: it prefers a nested JSON `error.message` when present, truncates long bodies safely on UTF-8 boundaries, and emits a friendlier Cloudflare-blocked message for a specific 403 HTML pattern while preserving URL, cf-ray, request ID, and identity-auth metadata.

`UsageLimitReachedError` generates plan-aware copy, including workspace-credit and spend-cap cases, promo-message overrides, and retry timestamps formatted in local time with ordinal day suffixes. `get_error_message_ui` further condenses errors for UI display, especially sandbox denials where it prefers aggregated output, then stderr/stdout, then a synthetic exit-code message, and truncates the final text to a fixed byte budget.

#### Function details

##### `CodexErr::from`  (lines 167–169)

```
fn from(_: CancelErr) -> Self
```

**Purpose**: Converts a cancellation error into the canonical aborted-turn error.

**Data flow**: It ignores the incoming `CancelErr` value and returns `CodexErr::TurnAborted`.

**Call relations**: This conversion lets async cancellation paths integrate with the main error type without preserving cancellation internals.


##### `CodexErr::is_retryable`  (lines 173–210)

```
fn is_retryable(&self) -> bool
```

**Purpose**: Classifies whether a given `CodexErr` should be treated as transient and eligible for retry.

**Data flow**: It pattern-matches on `self` and returns `false` for user/action/configuration/policy failures and other terminal conditions, while returning `true` for transient transport, timeout, internal-agent, IO, JSON, and join failures. Linux-specific landlock variants are explicitly non-retryable.

**Call relations**: Higher-level orchestration consults this method when deciding whether to automatically retry a failed turn or surface the error immediately.


##### `CodexErr::downcast_ref`  (lines 215–217)

```
fn downcast_ref(&self) -> Option<&T>
```

**Purpose**: Provides an `anyhow`-style downcast shim on the concrete error enum.

**Data flow**: It casts `self` to `&dyn Any`, attempts `downcast_ref::<T>()`, and returns `Option<&T>`.

**Call relations**: This exists for compatibility with older call sites that previously worked with `anyhow::Error` and still perform downcast checks.


##### `CodexErr::to_codex_protocol_error`  (lines 220–247)

```
fn to_codex_protocol_error(&self) -> CodexErrorInfo
```

**Purpose**: Maps an internal error variant to the coarse protocol error category sent to clients.

**Data flow**: It matches on `self` and returns a `CodexErrorInfo` variant. For retry-limit, connection-failed, and response-stream-failed cases it also calls `http_status_code_value()` to include an optional HTTP status code payload.

**Call relations**: Client-facing error-event generation calls this to translate detailed internal failures into stable protocol categories.

*Call graph*: calls 1 internal fn (http_status_code_value); called by 1 (to_error_event).


##### `CodexErr::to_error_event`  (lines 249–259)

```
fn to_error_event(&self, message_prefix: Option<String>) -> ErrorEvent
```

**Purpose**: Builds an `ErrorEvent` containing a formatted message and protocol error classification.

**Data flow**: It formats `self` to a string, optionally prefixes it with `"{prefix}: ..."` when `message_prefix` is provided, calls `to_codex_protocol_error()` for the structured category, and returns `ErrorEvent { message, codex_error_info: Some(...) }`.

**Call relations**: This is the main bridge from internal errors to protocol events emitted toward clients or UI layers.

*Call graph*: calls 1 internal fn (to_codex_protocol_error); 1 external calls (format!).


##### `CodexErr::http_status_code_value`  (lines 261–270)

```
fn http_status_code_value(&self) -> Option<u16>
```

**Purpose**: Extracts an HTTP status code from error variants that wrap HTTP-layer failures.

**Data flow**: It matches on `self`, pulling a `StatusCode` from retry-limit, unexpected-status, connection-failed, or response-stream-failed variants, then maps it to `u16` with `StatusCode::as_u16`. Other variants return `None`.

**Call relations**: This helper is used when constructing protocol error payloads and by other reporting paths that want to surface the underlying HTTP status.

*Call graph*: called by 3 (from_codex_err, notify_stream_error, to_codex_protocol_error).


##### `ConnectionFailedError::fmt`  (lines 279–281)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a connection failure with the wrapped reqwest error text.

**Data flow**: It reads `self.source` and writes `"Connection failed: {source}"` into the formatter.

**Call relations**: This display implementation feeds into `CodexErr::ConnectionFailed` formatting and any logs or UI messages that render the wrapped error.

*Call graph*: 1 external calls (write!).


##### `ResponseStreamFailed::fmt`  (lines 291–301)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a response-stream read failure, optionally including the request ID.

**Data flow**: It reads `self.source` and `self.request_id`, builds the suffix `", request id: ..."` only when an ID is present, and writes the full message into the formatter.

**Call relations**: This display text is surfaced directly in error events for stream-read failures.

*Call graph*: 1 external calls (write!).


##### `UnexpectedResponseError::display_body`  (lines 320–331)

```
fn display_body(&self) -> String
```

**Purpose**: Chooses the most useful body text to show for an unexpected HTTP response.

**Data flow**: It first calls `extract_error_message`; if that returns `Some`, it uses that message. Otherwise it trims `self.body`, returns `"Unknown error"` if empty, or truncates the trimmed body with `truncate_with_ellipsis` to the configured byte limit.

**Call relations**: The `Display` implementation calls this for the generic unexpected-status path after ruling out the special Cloudflare-friendly message.

*Call graph*: calls 2 internal fn (extract_error_message, truncate_with_ellipsis); called by 1 (fmt).


##### `UnexpectedResponseError::extract_error_message`  (lines 333–345)

```
fn extract_error_message(&self) -> Option<String>
```

**Purpose**: Attempts to pull a nested `error.message` string out of a JSON response body.

**Data flow**: It parses `self.body` as `serde_json::Value`, navigates through `error.message`, requires the value to be a string, trims it, and returns `Some(message.to_string())` if non-empty; any parse or shape mismatch yields `None`.

**Call relations**: This helper is used by `display_body` so JSON API errors can surface a concise semantic message instead of raw body text.

*Call graph*: called by 1 (display_body).


##### `UnexpectedResponseError::friendly_message`  (lines 347–375)

```
fn friendly_message(&self) -> Option<String>
```

**Purpose**: Detects a specific Cloudflare-blocked 403 pattern and formats a simplified explanatory message with metadata.

**Data flow**: It checks that `status` is `FORBIDDEN` and that `body` contains both `Cloudflare` and `blocked`; otherwise it returns `None`. On a match it builds a message starting from `CLOUDFLARE_BLOCKED_MESSAGE`, appending status and any present URL, cf-ray, request ID, identity authorization error, and identity error code.

**Call relations**: The `Display` implementation consults this first so a common HTML block page is rendered as a clearer region/access explanation.

*Call graph*: called by 1 (fmt); 1 external calls (format!).


##### `UnexpectedResponseError::fmt`  (lines 379–403)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats an unexpected HTTP response, using either the Cloudflare-specific friendly message or a generic status/body summary with metadata.

**Data flow**: It calls `friendly_message`; if that returns `Some`, it writes it directly. Otherwise it reads `status`, obtains a body summary from `display_body`, builds `"unexpected status {status}: {body}"`, appends optional URL, cf-ray, request ID, identity authorization error, and identity error code, and writes the final string.

**Call relations**: This display implementation is the user-visible representation for `CodexErr::UnexpectedStatus` and underpins logs, UI messages, and protocol events.

*Call graph*: calls 2 internal fn (display_body, friendly_message); 2 external calls (format!, write!).


##### `truncate_with_ellipsis`  (lines 408–420)

```
fn truncate_with_ellipsis(text: &str, max_bytes: usize) -> String
```

**Purpose**: Truncates a string to a byte budget without splitting a UTF-8 codepoint, then appends `...`.

**Data flow**: It takes `text` and `max_bytes`. If the text already fits, it clones and returns it. Otherwise it walks backward from `max_bytes` until it reaches a UTF-8 character boundary, copies the prefix into a new `String`, appends `...`, and returns it.

**Call relations**: This helper is used by `UnexpectedResponseError::display_body` to keep long response bodies readable and valid UTF-8.

*Call graph*: called by 1 (display_body).


##### `truncate_text`  (lines 422–427)

```
fn truncate_text(content: &str, policy: TruncationPolicy) -> String
```

**Purpose**: Applies either byte-based or token-budget-based middle truncation according to a `TruncationPolicy`.

**Data flow**: It takes content and a policy, matches on the policy, and delegates to `truncate_middle_chars` for byte limits or `truncate_middle_with_token_budget(...).0` for token limits, returning the truncated string.

**Call relations**: UI error-message generation uses this helper to enforce a fixed display budget independent of the original error source.

*Call graph*: called by 1 (get_error_message_ui); 2 external calls (truncate_middle_chars, truncate_middle_with_token_budget).


##### `RetryLimitReachedError::fmt`  (lines 436–446)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a retry-limit exhaustion error, optionally including the request ID from the last failed attempt.

**Data flow**: It reads `status` and `request_id`, conditionally builds the request-ID suffix, and writes `"exceeded retry limit, last status: ..."` into the formatter.

**Call relations**: This display text is surfaced through `CodexErr::RetryLimit` when repeated retries have failed.

*Call graph*: 1 external calls (write!).


##### `UsageLimitReachedError::fmt`  (lines 459–553)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a usage-limit error into plan-aware, workspace-aware, and reset-aware user-facing copy.

**Data flow**: It first checks `rate_limits.limit_name`; if a non-empty non-`codex` name is present, it emits a model-switching message with `retry_suffix_after_or`. Otherwise it checks `rate_limit_reached_type` for workspace credit/spend-cap cases and returns specialized messages for those. Next it prefers `promo_message` when present. If none of those apply, it matches on `plan_type` to choose upsell/admin/default wording and appends either `retry_suffix_after_or` or `retry_suffix` depending on the sentence structure. It writes the final message to the formatter.

**Call relations**: This display implementation is the main source of user-visible quota and rate-limit messaging and is heavily exercised by the dedicated test file.

*Call graph*: 2 external calls (format!, write!).


##### `retry_suffix`  (lines 556–563)

```
fn retry_suffix(resets_at: Option<&DateTime<Utc>>) -> String
```

**Purpose**: Builds a sentence-ending retry hint beginning with `Try again ...`.

**Data flow**: It takes an optional reset timestamp. If present it formats the timestamp with `format_retry_timestamp` and returns `" Try again at ... ."`; otherwise it returns `" Try again later."`.

**Call relations**: Usage-limit formatting uses this variant when the preceding sentence already ends naturally and should continue with a direct retry instruction.

*Call graph*: calls 1 internal fn (format_retry_timestamp); 1 external calls (format!).


##### `retry_suffix_after_or`  (lines 565–572)

```
fn retry_suffix_after_or(resets_at: Option<&DateTime<Utc>>) -> String
```

**Purpose**: Builds a retry hint beginning with `or try again ...` for messages that already offer another immediate action.

**Data flow**: It takes an optional reset timestamp. If present it formats the timestamp with `format_retry_timestamp` and returns `" or try again at ... ."`; otherwise it returns `" or try again later."`.

**Call relations**: Usage-limit formatting uses this variant for upsell/admin messages that first suggest another action and then offer waiting as an alternative.

*Call graph*: calls 1 internal fn (format_retry_timestamp); 1 external calls (format!).


##### `format_retry_timestamp`  (lines 574–585)

```
fn format_retry_timestamp(resets_at: &DateTime<Utc>) -> String
```

**Purpose**: Formats a UTC reset timestamp into a local-time string, using a shorter same-day format and a dated format for later days.

**Data flow**: It converts `resets_at` and the current time from `now_for_retry()` into local time. If both fall on the same local date, it returns a time-only string like `"1:05 PM"`. Otherwise it computes the ordinal suffix with `day_suffix`, formats a string like `"Jan 3rd, 2024 1:05 PM"`, and returns it.

**Call relations**: Both retry-suffix helpers delegate to this function so all reset-time messaging uses the same local formatting rules.

*Call graph*: calls 2 internal fn (day_suffix, now_for_retry); called by 2 (retry_suffix, retry_suffix_after_or); 2 external calls (with_timezone, format!).


##### `day_suffix`  (lines 587–597)

```
fn day_suffix(day: u32) -> &'static str
```

**Purpose**: Returns the English ordinal suffix for a day number.

**Data flow**: It takes a `u32` day, special-cases 11 through 13 as `"th"`, otherwise uses the last digit to return `"st"`, `"nd"`, `"rd"`, or `"th"`.

**Call relations**: This helper is only used by `format_retry_timestamp` when constructing date strings for non-same-day resets.

*Call graph*: called by 1 (format_retry_timestamp).


##### `now_for_retry`  (lines 605–613)

```
fn now_for_retry() -> DateTime<Utc>
```

**Purpose**: Returns the current UTC time, with a test-only override hook.

**Data flow**: In tests, it first checks the thread-local `NOW_OVERRIDE` and returns that value when set. Otherwise it returns `Utc::now()`.

**Call relations**: Timestamp formatting uses this indirection so tests can deterministically verify retry-message wording across same-day and future-day cases.

*Call graph*: called by 1 (format_retry_timestamp); 1 external calls (now).


##### `EnvVarError::fmt`  (lines 625–631)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a missing-environment-variable error and optionally appends setup instructions.

**Data flow**: It writes `"Missing environment variable: `<var>`."` and, if `instructions` is `Some`, appends a space plus the instruction text before returning `Ok(())`.

**Call relations**: This display implementation feeds into `CodexErr::EnvVar` and any user-facing diagnostics about missing configuration in the environment.

*Call graph*: 1 external calls (write!).


##### `get_error_message_ui`  (lines 634–668)

```
fn get_error_message_ui(e: &CodexErr) -> String
```

**Purpose**: Produces a concise UI-oriented error message, with special handling for sandbox execution output.

**Data flow**: It matches on `&CodexErr`. For `Sandbox(Denied)`, it prefers non-empty `aggregated_output.text`; otherwise it inspects trimmed stderr and stdout and returns stderr+stdout, stderr only, stdout only, or a synthetic exit-code message. For `Sandbox(Timeout)`, it formats a plain timeout message using `output.duration.as_millis()`. All other errors use `e.to_string()`. The chosen message is then truncated with `truncate_text(..., TruncationPolicy::Bytes(ERROR_MESSAGE_UI_MAX_BYTES))` and returned.

**Call relations**: UI and presentation layers call this instead of raw `Display` when they need a bounded, execution-focused message suitable for direct display to users.

*Call graph*: calls 1 internal fn (truncate_text); 3 external calls (format!, to_string, Bytes).


### `protocol/src/mcp.rs`

`data_model` · `protocol serialization and MCP adapter conversion`

This module is mostly schema definitions, but it also contains the compatibility glue that makes MCP payloads safe to deserialize from heterogeneous JSON. `RequestId` is an untagged enum that accepts either string or integer IDs and implements `Display` by forwarding to the underlying value. The public structs `McpServerInfo`, `Tool`, `Resource`, `ResourceContent`, `ResourceTemplate`, and `CallToolResult` are all serde/TS/schema-friendly mirrors of MCP concepts. The adapter section introduces private serde-only structs (`ToolSerde`, `ResourceSerde`, `ResourceTemplateSerde`) that accept both camelCase and snake_case field spellings where needed. `deserialize_lossy_opt_i64` is the key robustness helper: it deserializes an optional JSON number into `Option<i64>`, preserving signed values, converting unsigned values only when they fit in `i64`, and returning `None` for oversized or non-integral numbers instead of failing. The `from_mcp_value` constructors on `Tool`, `Resource`, and `ResourceTemplate` deserialize arbitrary `serde_json::Value` through those private adapter structs and then convert into the public protocol types. The included test focuses on `Resource.size`, proving that large-but-valid `u64` values survive, negative values survive, and values too large for `i64` degrade to `None` rather than causing a hard error.

#### Function details

##### `RequestId::fmt`  (lines 21–26)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a request ID as text regardless of whether it is stored as a string or integer. This lets request IDs participate naturally in logs and user-facing messages.

**Data flow**: Reads `self`; for `RequestId::String(s)` it writes `s` directly to the formatter, and for `RequestId::Integer(i)` it delegates to the integer’s formatting implementation. It returns the standard `fmt::Result` and mutates only the formatter output stream.

**Call relations**: Invoked implicitly by Rust formatting machinery whenever a `RequestId` is displayed. It depends on the enum shape defined in this file and does not call other local helpers.

*Call graph*: 1 external calls (write_str).


##### `deserialize_lossy_opt_i64`  (lines 171–187)

```
fn deserialize_lossy_opt_i64(deserializer: D) -> Result<Option<i64>, D::Error>
```

**Purpose**: Deserializes an optional JSON number into `Option<i64>` without failing on oversized unsigned values. It is intentionally lossy so protocol parsing remains tolerant of MCP servers that emit large numeric sizes.

**Data flow**: Accepts a serde deserializer, deserializes `Option<serde_json::Number>`, then branches: signed numbers become `Some(i64)`, unsigned numbers are converted with `i64::try_from` and become `Some` only if they fit, floating/non-integral or too-large values become `None`, and absent values stay `None`. It returns `Result<Option<i64>, D::Error>`.

**Call relations**: Used as a custom field deserializer on `ResourceSerde.size`. It sits in the adapter path between raw JSON and the public `Resource` type so callers of `Resource::from_mcp_value` get tolerant parsing automatically.

*Call graph*: 2 external calls (deserialize, try_from).


##### `Tool::from`  (lines 210–231)

```
fn from(value: ToolSerde) -> Self
```

**Purpose**: Converts the private serde adapter `ToolSerde` into the public `Tool` protocol struct. It is a field-for-field move into the schema-friendly type.

**Data flow**: Consumes a `ToolSerde`, destructures all fields, and returns `Tool { name, title, description, input_schema, output_schema, annotations, icons, meta }`. No external state is read or written.

**Call relations**: Called by `Tool::from_mcp_value` after serde has accepted alternate field spellings and defaults. It isolates the public type from the more permissive deserialization shape.


##### `Resource::from`  (lines 256–279)

```
fn from(value: ResourceSerde) -> Self
```

**Purpose**: Converts the private serde adapter `ResourceSerde` into the public `Resource` struct. This keeps tolerant deserialization concerns separate from the exported protocol type.

**Data flow**: Consumes `ResourceSerde`, moves all fields into a new `Resource`, and returns it. The `size` field has already been normalized by `deserialize_lossy_opt_i64` before this conversion runs.

**Call relations**: Used by `Resource::from_mcp_value` after raw JSON has been parsed through the adapter struct. It is the final step in the resource adapter pipeline.


##### `ResourceTemplate::from`  (lines 299–316)

```
fn from(value: ResourceTemplateSerde) -> Self
```

**Purpose**: Converts the private `ResourceTemplateSerde` adapter into the public `ResourceTemplate` type. It preserves the normalized field names and optional metadata.

**Data flow**: Consumes a `ResourceTemplateSerde`, destructures its fields, and returns `ResourceTemplate { annotations, uri_template, name, title, description, mime_type }`. It has no side effects.

**Call relations**: Called by `ResourceTemplate::from_mcp_value` after serde has accepted both `uriTemplate` and `uri_template` spellings. It mirrors the adapter pattern used for tools and resources.


##### `Tool::from_mcp_value`  (lines 320–322)

```
fn from_mcp_value(value: serde_json::Value) -> Result<Self, serde_json::Error>
```

**Purpose**: Builds a public `Tool` from arbitrary MCP-shaped JSON. It accepts wire JSON, deserializes through the permissive adapter, and returns a typed protocol value or serde error.

**Data flow**: Accepts `serde_json::Value`, deserializes it into `ToolSerde` with `serde_json::from_value`, converts that adapter into `Tool` via `.into()`, and returns `Result<Tool, serde_json::Error>`. It does not mutate external state.

**Call relations**: Called by higher-level MCP integration code when converting tool metadata from upstream MCP libraries or raw JSON. It delegates field normalization to serde and structural conversion to `Tool::from`.

*Call graph*: called by 1 (protocol_tool_from_rmcp_tool).


##### `Resource::from_mcp_value`  (lines 326–328)

```
fn from_mcp_value(value: serde_json::Value) -> Result<Self, serde_json::Error>
```

**Purpose**: Builds a public `Resource` from arbitrary MCP-shaped JSON while tolerating mixed field naming and oversized numeric sizes. It is the main entrypoint for resource adaptation.

**Data flow**: Accepts `serde_json::Value`, deserializes it into `ResourceSerde`, converts that into `Resource`, and returns the result or a serde error. The `size` field may emerge as `None` if the source number cannot fit in `i64`.

**Call relations**: Used by production resource-conversion code and by the file’s regression test. It delegates tolerant numeric parsing to `deserialize_lossy_opt_i64` through the adapter struct.

*Call graph*: called by 2 (resource_from_rmcp, resource_size_deserializes_without_narrowing).


##### `ResourceTemplate::from_mcp_value`  (lines 332–334)

```
fn from_mcp_value(value: serde_json::Value) -> Result<Self, serde_json::Error>
```

**Purpose**: Builds a public `ResourceTemplate` from MCP-shaped JSON. It accepts alternate field spellings and returns a typed protocol value.

**Data flow**: Consumes a `serde_json::Value`, deserializes it into `ResourceTemplateSerde`, converts that into `ResourceTemplate`, and returns `Result<ResourceTemplate, serde_json::Error>`. No external state is touched.

**Call relations**: Called by code that imports MCP resource-template metadata. It follows the same adapter pattern as `Tool::from_mcp_value` and `Resource::from_mcp_value`.


##### `tests::resource_size_deserializes_without_narrowing`  (lines 344–371)

```
fn resource_size_deserializes_without_narrowing()
```

**Purpose**: Verifies the tolerant numeric behavior for `Resource.size`: large fitting `u64` values and negative values are preserved, while values too large for `i64` become `None`. This documents the intended lossy-deserialization contract.

**Data flow**: Constructs three JSON resource objects with different `size` values, parses each with `Resource::from_mcp_value`, and asserts the resulting `size` field is `Some(5_000_000_000)`, `Some(-1)`, and `None` respectively. It reads no shared state and writes none.

**Call relations**: Run by the test harness as the regression test for `deserialize_lossy_opt_i64` behavior. It exercises the full public adapter path rather than the helper directly.

*Call graph*: calls 1 internal fn (from_mcp_value); 2 external calls (assert_eq!, json!).


### `protocol/src/memory_citation.rs`

`data_model` · `cross-cutting`

This file introduces two protocol structs used to describe memory-backed citations. `MemoryCitation` is the top-level container, with an `entries: Vec<MemoryCitationEntry>` holding one or more cited spans and a `rollout_ids: Vec<String>` recording rollout identifiers associated with the memory source. `MemoryCitationEntry` captures a single citation target with a `path`, inclusive `line_start` and `line_end` bounds as `u32`, and a free-form `note` explaining the relevance of that span.

Both types derive `Serialize`, `Deserialize`, `JsonSchema`, and `TS`, so they are intended to cross process and language boundaries unchanged. The `camelCase` serde rename policy ensures Rust field names map to wire names expected by external consumers. `MemoryCitation` additionally derives `Default`, making an empty citation set and empty rollout list the natural zero value; that is useful when citations are optional but callers want a concrete object rather than `Option`. The design is intentionally simple and immutable-by-convention: there are no helper methods, validation hooks, or normalization logic here, so invariants such as `line_start <= line_end` or path interpretation must be enforced by producers. This file’s role is to freeze the shape of citation payloads, not to compute them.


### `protocol/src/network_policy.rs`

`data_model` · `network approval payload handling`

This file contains a single serde-deserializable struct, `NetworkPolicyDecisionPayload`, which mirrors the information returned by network policy evaluation: the `NetworkPolicyDecision` itself, the `NetworkDecisionSource` that produced it, an optional `NetworkApprovalProtocol`, and optional host, reason, and port fields. The struct uses camelCase serde naming so it can be populated directly from wire payloads. Its only behavior is `is_ask_from_decider`, a narrowly targeted predicate that checks for the specific combination of `decision == Ask` and `source == Decider`. That combination matters because not every `Ask` decision necessarily originates from the same approval path, and downstream code wants a concise way to detect the interactive approval case without repeating enum comparisons. The file is intentionally minimal and purely protocol-facing: it does not perform I/O, persistence, or policy evaluation itself, only deserialization and one semantic classification helper.

#### Function details

##### `NetworkPolicyDecisionPayload::is_ask_from_decider`  (lines 19–21)

```
fn is_ask_from_decider(&self) -> bool
```

**Purpose**: Returns true only when the payload represents an `Ask` decision emitted by the `Decider` source. This identifies the interactive approval path in one check.

**Data flow**: Borrows `self`, compares `self.decision` to `NetworkPolicyDecision::Ask` and `self.source` to `NetworkDecisionSource::Decider`, combines the comparisons with `&&`, and returns the resulting `bool`. It mutates nothing.

**Call relations**: Called by higher-level network-approval context construction to decide whether a payload should be treated as a decider-originated approval request.

*Call graph*: called by 1 (network_approval_context_from_payload).


### `protocol/src/openai_models.rs`

`data_model` · `model catalog load and model-selection UI logic`

This module is the schema layer for model metadata returned by the backend and consumed by clients. `ReasoningEffort` is a string-backed enum with known values (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) plus `Custom(String)` for forward compatibility; it implements `Display`, custom serde, and an open-string JSON schema that rejects only the empty string. `ModelInfo` is the main backend-facing record, carrying model slug, display metadata, reasoning options, shell/tool capabilities, truncation policy, context-window limits, service tiers, multimodal support, and optional `ModelMessages` for personality-aware instruction templating. `deserialize_optional_model_selector` is a compatibility helper that treats unknown string values for fields like `tool_mode` and `multi_agent_version` as omitted rather than failing deserialization.

Instruction assembly is a notable behavior cluster. `ModelMessages` can declare an `instructions_template` containing the `{{ personality }}` placeholder plus `ModelInstructionsVariables` for default, friendly, and pragmatic variants. `ModelInfo::get_model_instructions` prefers the template whenever present, replacing the placeholder with the selected personality message or an empty string; if a personality is requested but no template exists, it logs a warning and falls back to `base_instructions`. The file also defines `ModelPreset`, a client-facing projection of `ModelInfo`, plus helpers to detect fast-mode support, filter visible models by auth mode, and mark exactly one default preset based on picker visibility. Tests focus on forward-compatible deserialization, instruction templating semantics, service-tier filtering, and reasoning-effort wire behavior.

#### Function details

##### `ReasoningEffort::as_str`  (lines 54–64)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the exact wire string for a reasoning-effort value, including custom values. This is the canonical string representation used by display and serialization.

**Data flow**: Borrows `self`, matches on the enum variant, and returns a `&str` pointing to a static literal for known variants or to the inner `String` for `Custom`. It mutates nothing.

**Call relations**: Used by both `Display` and `Serialize` implementations so all outward string representations stay consistent.

*Call graph*: called by 2 (fmt, serialize).


##### `ReasoningEffort::fmt`  (lines 68–70)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a reasoning-effort value as its wire string. This lets the enum participate naturally in logs and UI text.

**Data flow**: Borrows `self`, calls `self.as_str()`, writes that string to the formatter, and returns `fmt::Result`. It mutates only the formatter output.

**Call relations**: Invoked implicitly by Rust formatting and by tests calling `.to_string()`. It delegates the actual string choice to `as_str()`.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `ReasoningEffort::schema_name`  (lines 74–76)

```
fn schema_name() -> String
```

**Purpose**: Provides the JSON schema type name for `ReasoningEffort`. This keeps generated schemas stable and readable.

**Data flow**: Takes no inputs and returns the string `"ReasoningEffort"`. It has no side effects.

**Call relations**: Used by the `JsonSchema` implementation when schema generators need a named schema for this type.


##### `ReasoningEffort::json_schema`  (lines 78–93)

```
fn json_schema(_generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Defines `ReasoningEffort` as an open non-empty string in generated JSON schema rather than a closed enum. This preserves forward compatibility for newly introduced effort values.

**Data flow**: Ignores the schema generator input, constructs a `Schema::Object` with `instance_type = String`, a description metadata block, and `StringValidation { min_length: Some(1) }`, and returns it.

**Call relations**: Used by schema generation for shared protocol types. It intentionally diverges from a fixed enum schema so unknown future effort strings remain valid.

*Call graph*: 3 external calls (new, default, Object).


##### `ReasoningEffort::serialize`  (lines 97–102)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes a reasoning-effort value as its wire string. Custom values are emitted unchanged.

**Data flow**: Borrows `self`, calls `self.as_str()`, and passes the result to `serializer.serialize_str(...)`. It writes only to the serde serializer.

**Call relations**: Invoked automatically by serde. It shares the same string mapping as `Display` via `as_str()`.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (serialize_str).


##### `ReasoningEffort::deserialize`  (lines 106–112)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Deserializes a reasoning-effort string into the enum, accepting both known values and arbitrary non-empty custom strings. Empty strings are rejected.

**Data flow**: Consumes a serde deserializer, deserializes a `String`, parses it with `FromStr`, and maps parse errors into serde errors with `D::Error::custom`.

**Call relations**: Used automatically by serde for model metadata. It delegates all semantic validation to `FromStr`.

*Call graph*: 1 external calls (deserialize).


##### `ReasoningEffort::from_str`  (lines 118–129)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a reasoning-effort string into a known enum variant or a forward-compatible `Custom` value. The empty string is the only invalid input.

**Data flow**: Accepts `&str`, matches known literals to fixed variants, returns `Err("reasoning_effort must not be empty")` for `""`, and otherwise returns `Ok(ReasoningEffort::Custom(s.to_string()))`.

**Call relations**: Used by deserialization and by callers parsing user or config strings directly. It is the semantic source of truth for accepted effort values.

*Call graph*: 1 external calls (Custom).


##### `default_input_modalities`  (lines 160–162)

```
fn default_input_modalities() -> Vec<InputModality>
```

**Purpose**: Returns the backward-compatible default input modalities for models that omit modality metadata. The default assumes both text and image input are accepted.

**Data flow**: Takes no inputs and returns `vec![InputModality::Text, InputModality::Image]`. It has no side effects.

**Call relations**: Used as a serde default for both `ModelPreset` and `ModelInfo`, and by tests constructing model fixtures.

*Call graph*: called by 43 (preset_to_info, drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles, drop_last_n_user_turns_ignores_session_prefix_user_messages, drop_last_n_user_turns_preserves_prefix, drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn, for_prompt_strips_images_when_model_does_not_support_images, normalization_retains_local_shell_outputs, normalize_adds_missing_output_for_custom_tool_call, normalize_adds_missing_output_for_custom_tool_call_panics_in_debug, normalize_adds_missing_output_for_function_call (+15 more)); 1 external calls (vec!).


##### `deserialize_optional_model_selector`  (lines 305–314)

```
fn deserialize_optional_model_selector(deserializer: D) -> Result<Option<T>, D::Error>
```

**Purpose**: Deserializes an optional string-backed selector enum while treating unknown strings as `None` instead of failing. This preserves compatibility when newer servers send selector values older clients do not recognize.

**Data flow**: Consumes a serde deserializer, deserializes `Option<String>`, returns `Ok(None)` if absent, otherwise wraps the string in `serde_json::Value::String` and attempts `serde_json::from_value::<T>`. Successful parses become `Some(T)`; parse failures are swallowed as `None`.

**Call relations**: Used as a custom deserializer for `ModelInfo.tool_mode` and `ModelInfo.multi_agent_version`. It is a targeted forward-compatibility shim.

*Call graph*: 3 external calls (deserialize, String, from_value).


##### `TruncationPolicyConfig::bytes`  (lines 323–328)

```
fn bytes(limit: i64) -> Self
```

**Purpose**: Constructs a truncation policy measured in bytes. It is a small const constructor used in model fixtures and defaults.

**Data flow**: Accepts `limit: i64` and returns `TruncationPolicyConfig { mode: TruncationMode::Bytes, limit }`. It has no side effects.

**Call relations**: Used by tests and model-building code whenever byte-based truncation policy metadata is needed.

*Call graph*: called by 19 (preset_to_info, remote_model_with_auto_review_override, model_switch_to_smaller_model_updates_token_context_window, test_model_info, test_remote_model, remote_model_friendly_personality_instructions_with_feature, user_turn_personality_remote_model_template_includes_update_message, remote_models_apply_remote_base_instructions, remote_models_get_model_info_uses_longest_matching_prefix, remote_models_long_model_slug_is_sent_with_custom_reasoning (+9 more)).


##### `TruncationPolicyConfig::tokens`  (lines 330–335)

```
fn tokens(limit: i64) -> Self
```

**Purpose**: Constructs a truncation policy measured in tokens. It is the token-based counterpart to `bytes()`.

**Data flow**: Accepts `limit: i64` and returns `TruncationPolicyConfig { mode: TruncationMode::Tokens, limit }`. It mutates nothing.

**Call relations**: Used by callers that need token-based truncation metadata rather than byte-based limits.

*Call graph*: called by 2 (with_config_overrides, model_with_shell_type).


##### `default_effective_context_window_percent`  (lines 342–344)

```
fn default_effective_context_window_percent() -> i64
```

**Purpose**: Provides the default percentage of a model’s context window considered usable for inputs. This leaves headroom for prompts, tools, and output.

**Data flow**: Takes no inputs and returns the constant `95`. It has no side effects.

**Call relations**: Used as the serde default for `ModelInfo.effective_context_window_percent`.


##### `ModelInfo::resolved_context_window`  (lines 429–431)

```
fn resolved_context_window(&self) -> Option<i64>
```

**Purpose**: Returns the effective context-window limit for a model, preferring `context_window` over `max_context_window`. This gives callers one place to ask for the active limit.

**Data flow**: Borrows `self`, returns `self.context_window.or(self.max_context_window)`, and mutates nothing.

**Call relations**: Used by token-budgeting code and by `auto_compact_token_limit()` to derive compaction thresholds.

*Call graph*: called by 3 (model_context_window, build_stage_one_input_message, auto_compact_token_limit).


##### `ModelInfo::auto_compact_token_limit`  (lines 433–444)

```
fn auto_compact_token_limit(&self) -> Option<i64>
```

**Purpose**: Computes the automatic compaction threshold for a model, clamping any configured limit to 90% of the resolved context window when a context limit is known. If no context limit exists, the configured limit is used as-is.

**Data flow**: Borrows `self`, computes `context_limit` as 90% of `resolved_context_window()` when present, reads `self.auto_compact_token_limit` as `config_limit`, and returns `Some(min(config_limit, context_limit))`, `Some(context_limit)`, or `config_limit` depending on which values exist.

**Call relations**: Used by context-budgeting code that decides when to trigger compaction. It depends on `resolved_context_window()` for the preferred context limit.

*Call graph*: calls 1 internal fn (resolved_context_window).


##### `ModelInfo::supports_personality`  (lines 446–450)

```
fn supports_personality(&self) -> bool
```

**Purpose**: Returns whether the model advertises complete personality-aware instruction support through `model_messages`. This requires both a placeholder-bearing template and complete personality variables.

**Data flow**: Borrows `self`, checks `self.model_messages.as_ref().is_some_and(ModelMessages::supports_personality)`, and returns the resulting `bool`. It mutates nothing.

**Call relations**: Used when projecting `ModelInfo` into `ModelPreset` so clients know whether personality controls should be shown.

*Call graph*: called by 1 (from).


##### `ModelInfo::get_model_instructions`  (lines 452–471)

```
fn get_model_instructions(&self, personality: Option<Personality>) -> String
```

**Purpose**: Builds the final instruction text for a model, preferring a template-based personality substitution when available and otherwise falling back to `base_instructions`. If a personality is requested but no template exists, it logs a warning.

**Data flow**: Borrows `self` and accepts `Option<Personality>`. If `self.model_messages` exists and has `instructions_template`, it obtains a personality message from `model_messages.get_personality_message(personality).unwrap_or_default()` and replaces `{{ personality }}` in the template. Otherwise, if `personality` is `Some`, it emits a `warn!` log and returns `self.base_instructions.clone()`. If no personality is requested, it simply clones and returns `base_instructions`.

**Call relations**: Used by model-selection and request-building code when assembling provider instructions. It delegates personality-message lookup to `ModelMessages` and is the main consumer of the templating metadata.

*Call graph*: 1 external calls (warn!).


##### `ModelMessages::has_personality_placeholder`  (lines 483–488)

```
fn has_personality_placeholder(&self) -> bool
```

**Purpose**: Checks whether the instruction template contains the `{{ personality }}` placeholder token. This is the first prerequisite for personality support.

**Data flow**: Borrows `self`, inspects `self.instructions_template.as_ref()`, checks `contains(PERSONALITY_PLACEHOLDER)`, defaults to `false` when no template exists, and returns the `bool`.

**Call relations**: Used internally by `ModelMessages::supports_personality` to determine whether the template can actually vary by personality.

*Call graph*: called by 1 (supports_personality).


##### `ModelMessages::supports_personality`  (lines 490–496)

```
fn supports_personality(&self) -> bool
```

**Purpose**: Returns whether the model-messages block fully supports personality substitution. It requires both a placeholder-bearing template and complete personality variables.

**Data flow**: Borrows `self`, calls `has_personality_placeholder()`, checks `instructions_variables.as_ref().is_some_and(ModelInstructionsVariables::is_complete)`, combines them with `&&`, and returns the result.

**Call relations**: Used by `ModelInfo::supports_personality`. It centralizes the completeness check for personality-aware instruction templating.

*Call graph*: calls 1 internal fn (has_personality_placeholder).


##### `ModelMessages::get_personality_message`  (lines 498–502)

```
fn get_personality_message(&self, personality: Option<Personality>) -> Option<String>
```

**Purpose**: Returns the personality-specific instruction fragment from the nested variables block, if available. It simply forwards the request to `ModelInstructionsVariables`.

**Data flow**: Borrows `self`, accesses `self.instructions_variables.as_ref()`, and if present delegates to `variables.get_personality_message(personality)`. It returns `Option<String>` and mutates nothing.

**Call relations**: Used by `ModelInfo::get_model_instructions` when filling the template placeholder.


##### `ModelInstructionsVariables::is_complete`  (lines 513–517)

```
fn is_complete(&self) -> bool
```

**Purpose**: Checks whether all three personality message slots—default, friendly, and pragmatic—are populated. This is the completeness criterion for full personality support.

**Data flow**: Borrows `self`, checks that `personality_default`, `personality_friendly`, and `personality_pragmatic` are all `Some`, and returns the resulting `bool`.

**Call relations**: Used by `ModelMessages::supports_personality` to decide whether the variables block is sufficient for personality-aware UI and templating.


##### `ModelInstructionsVariables::get_personality_message`  (lines 519–529)

```
fn get_personality_message(&self, personality: Option<Personality>) -> Option<String>
```

**Purpose**: Returns the appropriate personality message string for a requested personality, or the default message when no personality is specified. `Personality::None` intentionally maps to an empty string.

**Data flow**: Borrows `self` and accepts `Option<Personality>`. If a personality is provided, it matches: `None` personality variant returns `Some(String::new())`, `Friendly` clones `personality_friendly`, and `Pragmatic` clones `personality_pragmatic`. If no personality is provided, it clones `personality_default`. It returns `Option<String>`.

**Call relations**: Used by `ModelMessages::get_personality_message` and indirectly by `ModelInfo::get_model_instructions`. It is the semantic source of personality-message selection.

*Call graph*: 1 external calls (new).


##### `ModelInfoUpgrade::from`  (lines 539–544)

```
fn from(upgrade: &ModelUpgrade) -> Self
```

**Purpose**: Converts a client-facing `ModelUpgrade` into the backend-facing `ModelInfoUpgrade` shape. It keeps only the target model ID and migration markdown.

**Data flow**: Borrows a `ModelUpgrade`, clones `upgrade.id` into `model`, clones `upgrade.migration_markdown.unwrap_or_default()` into `migration_markdown`, and returns `ModelInfoUpgrade { ... }`.

**Call relations**: Used when projecting upgrade metadata between the two related model metadata types.


##### `ModelPreset::from`  (lines 555–584)

```
fn from(info: ModelInfo) -> Self
```

**Purpose**: Projects backend `ModelInfo` metadata into the client-facing `ModelPreset` shape used by pickers and local model lists. It derives personality support and picker visibility and rewrites upgrade metadata into the preset form.

**Data flow**: Consumes `ModelInfo`, computes `supports_personality = info.supports_personality()`, clones or moves fields into `ModelPreset`, defaults `default_reasoning_effort` to `ReasoningEffort::None` when absent, sets `is_default` to `false`, maps `upgrade` into a `ModelUpgrade` using the source slug as `migration_config_key`, sets `show_in_picker` based on `visibility == ModelVisibility::List`, and preserves `input_modalities`.

**Call relations**: Used by model-list building code and tests. It is the main projection from backend catalog metadata into the UI-facing preset model.

*Call graph*: calls 1 internal fn (supports_personality); called by 3 (build_available_models_picks_default_after_hiding_hidden_models, model_preset_preserves_availability_nux, model_preset_supports_fast_mode_from_service_tiers).


##### `ModelPreset::supports_fast_mode`  (lines 588–596)

```
fn supports_fast_mode(&self) -> bool
```

**Purpose**: Returns whether a model preset supports the fast service tier, either through structured `service_tiers` metadata or the deprecated `additional_speed_tiers` list. This keeps old and new catalog fields interoperable.

**Data flow**: Borrows `self`, checks whether any `service_tiers` entry has `id == ServiceTier::Fast.request_value()` or any `additional_speed_tiers` entry equals the literal `"fast"`, and returns the resulting `bool`.

**Call relations**: Used by UI and selection logic that wants to expose or badge fast-mode support on presets.


##### `ModelInfo::supports_service_tier`  (lines 600–604)

```
fn supports_service_tier(&self, service_tier: &str) -> bool
```

**Purpose**: Checks whether a backend model advertises support for a given service-tier ID. It is a simple membership test over `service_tiers`.

**Data flow**: Borrows `self` and `service_tier: &str`, iterates `self.service_tiers`, compares each `tier.id` to the requested string, and returns `true` if any match.

**Call relations**: Used by `service_tier_for_request` to validate requested service tiers before including them in outbound requests.


##### `ModelInfo::service_tier_for_request`  (lines 606–611)

```
fn service_tier_for_request(&self, service_tier: Option<String>) -> Option<String>
```

**Purpose**: Normalizes an optional requested service tier for outbound requests, dropping the explicit default sentinel and any unsupported tier IDs. Only supported non-default tiers are returned.

**Data flow**: Borrows `self` and consumes `Option<String>`. It filters the option so the string must differ from `SERVICE_TIER_DEFAULT_REQUEST_VALUE` and satisfy `self.supports_service_tier(service_tier)`, then returns the filtered `Option<String>`.

**Call relations**: Called by request-building code before sending model service-tier selections to the backend. It delegates support checking to `supports_service_tier`.

*Call graph*: called by 1 (build_responses_request).


##### `ModelPreset::filter_by_auth`  (lines 618–623)

```
fn filter_by_auth(models: Vec<ModelPreset>, chatgpt_mode: bool) -> Vec<ModelPreset>
```

**Purpose**: Filters model presets according to authentication mode. In ChatGPT mode all models remain visible; otherwise only API-supported models are kept.

**Data flow**: Consumes `Vec<ModelPreset>` and `chatgpt_mode: bool`, filters the vector so each model passes if `chatgpt_mode || model.supported_in_api`, collects the survivors, and returns the new vector.

**Call relations**: Used by model-list construction code to derive the visible preset set for the current auth mode.

*Call graph*: called by 2 (expected_visible_models, build_available_models).


##### `ModelPreset::mark_default_by_picker_visibility`  (lines 628–637)

```
fn mark_default_by_picker_visibility(models: &mut [ModelPreset])
```

**Purpose**: Marks exactly one preset as default based on picker visibility. It clears all existing defaults, then chooses the first picker-visible model or falls back to the first model overall.

**Data flow**: Mutably borrows a slice of `ModelPreset`, iterates through all presets setting `is_default = false`, then searches for the first `show_in_picker` preset and sets its `is_default = true`; if none are picker-visible, it sets `is_default = true` on `models.first_mut()` when present.

**Call relations**: Called by model-list assembly code after filtering and ordering. It centralizes the rule that only one preset should be marked default.

*Call graph*: called by 3 (expected_visible_models, list_models_uses_chatgpt_remote_catalog_as_source_of_truth, build_available_models); 2 external calls (first_mut, iter_mut).


##### `tests::test_model`  (lines 647–688)

```
fn test_model(spec: Option<ModelMessages>) -> ModelInfo
```

**Purpose**: Builds a minimal `ModelInfo` fixture with configurable `model_messages` for use across tests. It fills all required fields with stable defaults.

**Data flow**: Accepts `spec: Option<ModelMessages>`, constructs a `ModelInfo` with fixed slug/display name, empty vectors, default truncation policy via `TruncationPolicyConfig::bytes(10_000)`, default input modalities via `default_input_modalities()`, and the supplied `model_messages`, then returns it.

**Call relations**: Used by many tests in this module as the common model fixture constructor.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); 2 external calls (new, vec!).


##### `tests::personality_variables`  (lines 690–696)

```
fn personality_variables() -> ModelInstructionsVariables
```

**Purpose**: Creates a complete `ModelInstructionsVariables` fixture with default, friendly, and pragmatic messages. It avoids repetition in personality-related tests.

**Data flow**: Constructs and returns `ModelInstructionsVariables { personality_default: Some("default"), personality_friendly: Some("friendly"), personality_pragmatic: Some("pragmatic") }`.

**Call relations**: Used by multiple instruction-templating tests as a reusable fixture.


##### `tests::reasoning_effort_accepts_known_and_custom_values`  (lines 699–721)

```
fn reasoning_effort_accepts_known_and_custom_values()
```

**Purpose**: Verifies that known reasoning-effort strings parse to fixed variants while unknown non-empty strings round-trip through `Custom`. It also checks serialization and display output.

**Data flow**: Constructs a `Custom("max")` value, deserializes `"max"` from JSON, serializes the custom value back to JSON, calls `.to_string()`, and asserts the tuple of parse/serialize/display results matches expectations for both known and custom values.

**Call relations**: Run by the test harness as the main semantic test for `ReasoningEffort` parsing and serialization.

*Call graph*: 3 external calls (assert_eq!, Custom, to_string).


##### `tests::reasoning_effort_rejects_empty_values`  (lines 724–729)

```
fn reasoning_effort_rejects_empty_values()
```

**Purpose**: Checks that parsing an empty reasoning-effort string fails with the documented error message. This is the only invalid string case.

**Data flow**: Calls `"".parse::<ReasoningEffort>()` and asserts the result is `Err("reasoning_effort must not be empty")`.

**Call relations**: Executed by the test harness as the negative-path counterpart to the previous reasoning-effort test.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::reasoning_effort_json_schema_is_an_open_string`  (lines 732–752)

```
fn reasoning_effort_json_schema_is_an_open_string()
```

**Purpose**: Verifies that the generated JSON schema for `ReasoningEffort` is an open non-empty string schema rather than a closed enum. This protects forward compatibility.

**Data flow**: Creates a default `SchemaGenerator`, calls `ReasoningEffort::json_schema(&mut effort_generator)`, and asserts exact equality with the expected `Schema::Object` containing string type, description, and `min_length: 1`.

**Call relations**: Run by the test harness as a schema regression test for reasoning-effort metadata.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::get_model_instructions_uses_template_when_placeholder_present`  (lines 755–764)

```
fn get_model_instructions_uses_template_when_placeholder_present()
```

**Purpose**: Checks that `ModelInfo::get_model_instructions` uses the instruction template and substitutes the selected personality message when the placeholder is present.

**Data flow**: Builds a test model with `instructions_template: "Hello {{ personality }}"` and complete personality variables, calls `get_model_instructions(Some(Personality::Friendly))`, and asserts the result is `"Hello friendly"`.

**Call relations**: Executed by the test harness as the basic positive-path test for personality templating.

*Call graph*: 3 external calls (assert_eq!, personality_variables, test_model).


##### `tests::get_model_instructions_always_strips_placeholder`  (lines 767–817)

```
fn get_model_instructions_always_strips_placeholder()
```

**Purpose**: Verifies that the personality placeholder is always removed from the final instructions, even when the selected personality message is missing or empty. This prevents raw template tokens from leaking into prompts.

**Data flow**: Builds two test models with `instructions_template: "Hello\n{{ personality }}"`, one with only a friendly message and one with no personality messages, calls `get_model_instructions` with several personality selections and `None`, and asserts each result is either `"Hello\nfriendly"` or `"Hello\n"` with the placeholder stripped.

**Call relations**: Run by the test harness as a detailed regression test for placeholder substitution semantics.

*Call graph*: 2 external calls (assert_eq!, test_model).


##### `tests::get_model_instructions_falls_back_when_template_is_missing`  (lines 820–833)

```
fn get_model_instructions_falls_back_when_template_is_missing()
```

**Purpose**: Checks that `get_model_instructions` falls back to `base_instructions` when no template is present, even if personality variables exist. Template presence is required for substitution.

**Data flow**: Builds a test model with `instructions_template: None`, calls `get_model_instructions(Some(Personality::Friendly))`, and asserts the result is `"base"`.

**Call relations**: Executed by the test harness as the fallback-path test for instruction assembly.

*Call graph*: 2 external calls (assert_eq!, test_model).


##### `tests::get_personality_message_returns_default_when_personality_is_none`  (lines 836–842)

```
fn get_personality_message_returns_default_when_personality_is_none()
```

**Purpose**: Verifies that omitting the personality selection returns the default personality message from `ModelInstructionsVariables`.

**Data flow**: Builds complete personality variables with the helper, calls `get_personality_message(None)`, and asserts the result is `Some("default")`.

**Call relations**: Run by the test harness as a focused test for the no-personality branch of message selection.

*Call graph*: 2 external calls (assert_eq!, personality_variables).


##### `tests::get_personality_message`  (lines 845–907)

```
fn get_personality_message()
```

**Purpose**: Exercises all branches of `ModelInstructionsVariables::get_personality_message`, including complete variables, partially missing variables, and missing default values. It documents how `Personality::None` maps to an empty string and how absent variants yield `None`.

**Data flow**: Builds several `ModelInstructionsVariables` fixtures, calls `get_personality_message` with `Friendly`, `Pragmatic`, `Personality::None`, and `None`, and asserts the returned `Option<String>` values match expectations in each case.

**Call relations**: Executed by the test harness as the comprehensive semantic test for personality-message selection.

*Call graph*: 2 external calls (assert_eq!, personality_variables).


##### `tests::model_info_defaults_availability_nux_to_none_when_omitted`  (lines 910–950)

```
fn model_info_defaults_availability_nux_to_none_when_omitted()
```

**Purpose**: Checks that omitted optional `ModelInfo` fields deserialize to their intended defaults, including `availability_nux: None`, default web-search tool type, and absent optional selectors. This protects backward-compatible model metadata loading.

**Data flow**: Deserializes a JSON `ModelInfo` object that omits several optional fields, then asserts `availability_nux` is `None`, `supports_image_detail_original` is false, `web_search_tool_type` is `Text`, `supports_search_tool` and `use_responses_lite` are false, and optional fields like `comp_hash`, `auto_review_model_override`, and `tool_mode` are `None`.

**Call relations**: Run by the test harness as a broad defaulting test for `ModelInfo` deserialization.

*Call graph*: 4 external calls (assert!, assert_eq!, from_value, json!).


##### `tests::model_info_deserializes_known_tool_mode`  (lines 953–966)

```
fn model_info_deserializes_known_tool_mode()
```

**Purpose**: Verifies that a known `tool_mode` string deserializes into the corresponding enum variant. This confirms the custom selector deserializer still accepts recognized values.

**Data flow**: Serializes a test model to JSON value, inserts `tool_mode: "code_mode_only"` into the object, deserializes back into `ModelInfo`, and asserts `model.tool_mode == Some(ToolMode::CodeModeOnly)`.

**Call relations**: Executed by the test harness as the positive-path test for `deserialize_optional_model_selector` on `tool_mode`.

*Call graph*: 4 external calls (assert_eq!, test_model, String, to_value).


##### `tests::model_info_treats_unknown_tool_mode_as_omitted`  (lines 969–987)

```
fn model_info_treats_unknown_tool_mode_as_omitted()
```

**Purpose**: Checks that an unknown `tool_mode` string is treated as absent rather than causing deserialization failure or being preserved. This is the intended forward-compatibility behavior.

**Data flow**: Serializes a test model to JSON value, inserts `tool_mode: "future_tool_mode"`, deserializes into `ModelInfo`, asserts `tool_mode == None`, reserializes the model, and asserts the serialized object no longer contains a `tool_mode` key.

**Call relations**: Run by the test harness as the negative-path selector-compatibility test for `tool_mode`.

*Call graph*: 5 external calls (assert!, assert_eq!, test_model, String, to_value).


##### `tests::model_info_treats_unknown_multi_agent_version_as_omitted`  (lines 990–1003)

```
fn model_info_treats_unknown_multi_agent_version_as_omitted()
```

**Purpose**: Verifies that an unknown `multi_agent_version` string is also treated as omitted. This extends the same forward-compatibility rule to another selector field.

**Data flow**: Serializes a test model to JSON value, inserts `multi_agent_version: "future_multi_agent_version"`, deserializes into `ModelInfo`, and asserts `multi_agent_version == None`.

**Call relations**: Executed by the test harness as the selector-compatibility test for `multi_agent_version`.

*Call graph*: 4 external calls (assert_eq!, test_model, String, to_value).


##### `tests::resolved_context_window_prefers_context_window`  (lines 1006–1014)

```
fn resolved_context_window_prefers_context_window()
```

**Purpose**: Checks that `resolved_context_window()` prefers `context_window` over `max_context_window` when both are present.

**Data flow**: Builds a `ModelInfo` fixture with both fields set, calls `resolved_context_window()`, and asserts the result is the `context_window` value.

**Call relations**: Run by the test harness as a direct test of context-window precedence.

*Call graph*: 2 external calls (assert_eq!, test_model).


##### `tests::resolved_context_window_falls_back_to_max_context_window`  (lines 1017–1026)

```
fn resolved_context_window_falls_back_to_max_context_window()
```

**Purpose**: Verifies that `resolved_context_window()` falls back to `max_context_window` when `context_window` is absent, and that `auto_compact_token_limit()` derives 90% of that value by default.

**Data flow**: Builds a `ModelInfo` fixture with only `max_context_window`, calls `resolved_context_window()` and `auto_compact_token_limit()`, and asserts the results are `Some(400_000)` and `Some(360_000)` respectively.

**Call relations**: Executed by the test harness as the fallback-path test for context-window and compaction-limit derivation.

*Call graph*: 2 external calls (assert_eq!, test_model).


##### `tests::model_preset_preserves_availability_nux`  (lines 1029–1051)

```
fn model_preset_preserves_availability_nux()
```

**Purpose**: Checks that projecting `ModelInfo` into `ModelPreset` preserves availability NUX metadata and recognizes fast-mode support from deprecated speed-tier metadata. It also preserves the default service tier.

**Data flow**: Builds a `ModelInfo` fixture with `availability_nux`, `additional_speed_tiers = ["fast"]`, and `default_service_tier = Some(Fast)`, converts it with `ModelPreset::from`, and asserts the resulting preset preserves the NUX, reports `supports_fast_mode() == true`, and keeps the default service tier.

**Call relations**: Run by the test harness as a projection test for `ModelPreset::from` and `supports_fast_mode`.

*Call graph*: calls 1 internal fn (from); 5 external calls (new, assert!, assert_eq!, test_model, vec!).


##### `tests::model_preset_supports_fast_mode_from_service_tiers`  (lines 1054–1065)

```
fn model_preset_supports_fast_mode_from_service_tiers()
```

**Purpose**: Verifies that `ModelPreset::supports_fast_mode` also recognizes fast support from structured `service_tiers`, not just deprecated speed-tier strings.

**Data flow**: Builds a `ModelInfo` fixture with one `ModelServiceTier` whose ID is the fast tier, converts it to `ModelPreset`, and asserts `supports_fast_mode()` is true.

**Call relations**: Complements the previous fast-mode test by covering the structured service-tier path.

*Call graph*: calls 1 internal fn (from); 3 external calls (assert!, test_model, vec!).


##### `tests::service_tier_for_request_omits_explicit_default_tier`  (lines 1068–1083)

```
fn service_tier_for_request_omits_explicit_default_tier()
```

**Purpose**: Checks that requesting the explicit default-tier sentinel does not produce a service-tier override in outbound requests. The sentinel means “use catalog default,” not “send this tier ID.”

**Data flow**: Builds a `ModelInfo` fixture whose supported/default tier is fast, calls `service_tier_for_request(Some(SERVICE_TIER_DEFAULT_REQUEST_VALUE.to_string()))`, and asserts the result is `None`.

**Call relations**: Run by the test harness as a normalization test for outbound service-tier selection.

*Call graph*: 3 external calls (assert_eq!, test_model, vec!).


##### `tests::service_tier_for_request_filters_unsupported_tiers`  (lines 1086–1106)

```
fn service_tier_for_request_filters_unsupported_tiers()
```

**Purpose**: Verifies that `service_tier_for_request` returns supported non-default tiers unchanged, rejects unsupported tiers, and leaves `None` unchanged.

**Data flow**: Builds a `ModelInfo` fixture supporting only the fast tier, calls `service_tier_for_request` with the fast tier, an unsupported string, and `None`, and asserts the results are `Some(fast)`, `None`, and `None` respectively.

**Call relations**: Executed by the test harness as the main semantic test for service-tier request filtering.

*Call graph*: 3 external calls (assert_eq!, test_model, vec!).


##### `tests::service_tier_for_request_does_not_apply_catalog_default`  (lines 1109–1121)

```
fn service_tier_for_request_does_not_apply_catalog_default()
```

**Purpose**: Checks that `service_tier_for_request(None)` does not automatically substitute the model’s catalog default tier. Absence means no explicit request override.

**Data flow**: Builds a `ModelInfo` fixture with a default fast tier, calls `service_tier_for_request(None)`, and asserts the result is `None`.

**Call relations**: Run by the test harness as the final service-tier normalization test.

*Call graph*: 3 external calls (assert_eq!, test_model, vec!).


### `protocol/src/parse_command.rs`

`data_model` · `request handling`

This file contains the `ParsedCommand` enum, a serde-tagged sum type used to represent the outcome of parsing a textual command. The enum is serialized with a `type` discriminator in `snake_case`, making variants explicit on the wire. `Read` carries the original command string, a `name` for the read operation, and a `PathBuf` pointing to the file being read; the inline documentation notes that this path is best-effort and may be relative, in which case it must be resolved against the command’s execution `cwd`. `ListFiles` stores the original command plus an optional path scope, `Search` stores the original command plus optional query and path filters, and `Unknown` preserves only the raw command text when parsing cannot classify it.

The key design choice is preserving the original `cmd` in every variant. That lets later stages retain auditability and display fidelity even after extracting structured fields. Using `Option<String>` for `path` and `query` acknowledges that parsers may only partially recover intent from free-form shell commands. There is no parsing logic in this file; instead, it defines the stable interchange format that parser code elsewhere emits and that UI, policy, or execution layers consume.


### `protocol/src/user_input.rs`

`data_model` · `request handling`

This file models the leaf-level content that can appear in a user submission. `UserInput` is a tagged enum covering plain text, pre-encoded image URLs, local image paths that will later be converted to data URLs, selected skills, and structured mentions. The text variant carries `text_elements`, which are UI-defined spans into the UTF-8 byte buffer used to preserve rich placeholders or markers without mutating the literal text.

`TextElement` is the key helper type for those spans. It stores a `ByteRange` plus an optional placeholder string. The placeholder can be explicitly stored or, if absent, derived lazily from the referenced substring of the source text. That fallback behavior is encapsulated in `placeholder(text)`, while `_placeholder_for_conversion_only` exposes the raw stored placeholder for protocol-to-protocol conversions where the original text buffer is unavailable. `map_range` supports remapping spans after text transformations while preserving the placeholder, and `set_placeholder` mutates the stored placeholder in place.

`ByteRange` itself is a simple inclusive/exclusive byte-offset pair with a conversion from `Range<usize>`. The file also defines `MAX_USER_INPUT_TEXT_CHARS`, a conservative cap intended to prevent a single user message from consuming too much of the model context window.

#### Function details

##### `TextElement::new`  (lines 63–68)

```
fn new(byte_range: ByteRange, placeholder: Option<String>) -> Self
```

**Purpose**: Constructs a `TextElement` from a byte range and optional placeholder text.

**Data flow**: Takes `byte_range: ByteRange` and `placeholder: Option<String>` → stores them directly in a new `TextElement` → returns it.

**Call relations**: Used by callers building rich text-element metadata for user input. It is a simple constructor with no further delegation.


##### `TextElement::map_range`  (lines 75–83)

```
fn map_range(&self, map: F) -> Self
```

**Purpose**: Returns a copy of the text element with its byte range transformed by a caller-provided mapping function, while preserving the placeholder unchanged.

**Data flow**: Takes `&self` and `map: FnOnce(ByteRange) -> ByteRange` → applies `map` to `self.byte_range` → clones `self.placeholder` → returns a new `TextElement` with the remapped range and same placeholder.

**Call relations**: Used when text is rewritten and element spans must be adjusted without losing placeholder metadata.


##### `TextElement::set_placeholder`  (lines 85–87)

```
fn set_placeholder(&mut self, placeholder: Option<String>)
```

**Purpose**: Mutates the stored placeholder for an existing text element.

**Data flow**: Takes `&mut self` and `placeholder: Option<String>` → assigns the new value into `self.placeholder` → returns unit.

**Call relations**: Used by code that enriches or normalizes text-element metadata after construction.


##### `TextElement::_placeholder_for_conversion_only`  (lines 95–97)

```
fn _placeholder_for_conversion_only(&self) -> Option<&str>
```

**Purpose**: Returns the stored placeholder string, if any, without attempting to derive a fallback from source text. It exists specifically for conversion code that lacks access to the original text buffer.

**Data flow**: Reads `self.placeholder` → returns `Option<&str>` via `as_deref()`.

**Call relations**: Intended only for `From<TextElement>`-style conversions between equivalent protocol types; normal callers should prefer `placeholder(text)`.


##### `TextElement::placeholder`  (lines 99–103)

```
fn placeholder(&'a self, text: &'a str) -> Option<&'a str>
```

**Purpose**: Returns the effective placeholder for a text element, preferring the stored placeholder and otherwise falling back to the referenced substring of the provided text buffer.

**Data flow**: Takes `&self` and `text: &str` → returns `self.placeholder.as_deref()` if present; otherwise calls `text.get(self.byte_range.start..self.byte_range.end)` and returns that substring if the byte range is valid.

**Call relations**: Used by UI/rendering or persistence code that needs a human-readable representation of the element.


##### `ByteRange::from`  (lines 115–120)

```
fn from(range: std::ops::Range<usize>) -> Self
```

**Purpose**: Converts a standard Rust `Range<usize>` into the protocol `ByteRange` struct.

**Data flow**: Consumes `std::ops::Range<usize>` → copies `range.start` and `range.end` into `ByteRange { start, end }` → returns it.

**Call relations**: Provides ergonomic construction of protocol byte ranges from ordinary Rust slicing ranges.


### `protocol/src/items.rs`

`data_model` · `turn assembly and event translation`

This file is the core data-model layer for streamed conversation items. The top-level `TurnItem` enum wraps concrete structs such as `UserMessageItem`, `AgentMessageItem`, `ReasoningItem`, `WebSearchItem`, `ImageGenerationItem`, `FileChangeItem`, `McpToolCallItem`, and `ContextCompactionItem`. Most structs are plain serializable records, but the impl blocks encode important compatibility behavior. `UserMessageItem::as_legacy_event` flattens only text inputs into a single `message` string, rebases `TextElement` byte ranges across concatenated text chunks, and separately extracts remote image URLs, local image paths, and trimmed image-detail vectors. `trim_trailing_default_image_details` is a subtle wire-compatibility helper: trailing `None` detail entries are removed so legacy payloads do not carry meaningless defaults. Hook prompts are represented as fragments tagged with `hook_run_id`; they serialize to and parse from `<hook_prompt ...>...</hook_prompt>` XML snippets embedded as `ContentItem::InputText`, with empty IDs rejected on both encode and decode. Assistant and reasoning items can emit legacy event streams, including optional raw reasoning content. File-change and MCP tool-call items each split into begin/end legacy events, with end events omitted unless enough completion data exists. `TurnItem::as_legacy_events` is intentionally lossy for some variants: hook prompts, plans, and sleeps produce no legacy events, while file changes and MCP calls only emit completion-side events in this generic projection.

#### Function details

##### `ContextCompactionItem::new`  (lines 229–233)

```
fn new() -> Self
```

**Purpose**: Constructs a new context-compaction item with a freshly generated UUID string. It gives compaction events a stable item identity in turn streams.

**Data flow**: Takes no arguments, generates a UUID via `uuid::Uuid::new_v4()`, converts it to `String`, and returns a `ContextCompactionItem { id }`. It writes no external state.

**Call relations**: Called when compaction tasks need to emit a new turn item. It is also the implementation behind the type’s `Default` impl, so callers can obtain the same initialized shape through either path.

*Call graph*: called by 3 (run_compact_task_inner_impl, run_remote_compact_task_inner_impl, run_remote_compact_task_inner_impl); 1 external calls (new_v4).


##### `ContextCompactionItem::as_legacy_event`  (lines 235–237)

```
fn as_legacy_event(&self) -> EventMsg
```

**Purpose**: Projects a context-compaction item into the older event protocol as `EventMsg::ContextCompacted`. The legacy event carries no payload beyond the variant itself.

**Data flow**: Reads `self` only to satisfy the method receiver; it ignores the item ID and returns `EventMsg::ContextCompacted(ContextCompactedEvent {})`. No state is mutated.

**Call relations**: Used when newer turn items must be exposed to legacy consumers. `TurnItem::as_legacy_events` delegates to this method for the `ContextCompaction` variant.

*Call graph*: 1 external calls (ContextCompacted).


##### `ContextCompactionItem::default`  (lines 241–243)

```
fn default() -> Self
```

**Purpose**: Provides the default constructor for `ContextCompactionItem` by forwarding to `new()`. It ensures default values are still unique rather than zeroed or empty.

**Data flow**: Accepts no inputs and returns the result of `Self::new()`. It has no side effects beyond UUID generation inside `new`.

**Call relations**: Invoked implicitly by generic code using `Default`. It exists solely to route default construction through the same UUID-producing path as explicit creation.

*Call graph*: 1 external calls (new).


##### `UserMessageItem::new`  (lines 247–253)

```
fn new(content: &[UserInput]) -> Self
```

**Purpose**: Creates a user-message item from a slice of `UserInput`, assigning a new UUID and leaving `client_id` unset. It is the canonical constructor for user turn items.

**Data flow**: Accepts `&[UserInput]`, clones the slice into a `Vec<UserInput>`, generates a UUID string for `id`, sets `client_id` to `None`, and returns the populated `UserMessageItem`. No external state is modified.

**Call relations**: Called by parsing and turn-recording code when user input is first materialized into protocol items. Downstream legacy conversion methods assume this constructor’s shape: stable `id`, optional `client_id`, and preserved input ordering.

*Call graph*: called by 7 (parse_user_message, inspect_pending_input, record_user_prompt_and_emit_turn_item, item_completed_event_defaults_missing_completed_at_ms, item_started_event_from_non_web_search_emits_no_legacy_events, item_started_event_requires_started_at_ms, user_message_item_legacy_event_preserves_image_details); 2 external calls (to_vec, new_v4).


##### `UserMessageItem::as_legacy_event`  (lines 255–267)

```
fn as_legacy_event(&self) -> EventMsg
```

**Purpose**: Converts a structured user message into the older flattened `UserMessageEvent` shape. It preserves text, image references, image detail metadata, local image paths, and rebased text-element ranges.

**Data flow**: Reads `self.client_id` and derives `message()`, `image_urls()`, `image_details()`, `local_image_paths()`, `local_image_details()`, and `text_elements()`. It packages those into `EventMsg::UserMessage(UserMessageEvent { ... })` and returns the event without mutating `self`.

**Call relations**: Used by `TurnItem::as_legacy_events` for `TurnItem::UserMessage`. It orchestrates several helper methods because the legacy event format splits one structured `content` vector into multiple parallel fields.

*Call graph*: calls 6 internal fn (image_details, image_urls, local_image_details, local_image_paths, message, text_elements); 1 external calls (UserMessage).


##### `UserMessageItem::message`  (lines 269–278)

```
fn message(&self) -> String
```

**Purpose**: Flattens only text chunks from `self.content` into one concatenated string. Non-text inputs contribute empty strings and therefore disappear from the legacy message body.

**Data flow**: Iterates over `self.content`, clones `text` from each `UserInput::Text`, substitutes `String::new()` for all other variants, joins the collected strings, and returns the result. It does not mutate state.

**Call relations**: Called by `UserMessageItem::as_legacy_event` to populate the legacy `message` field. Its concatenation order is also the basis for the byte-offset rebasing performed by `text_elements()`.

*Call graph*: called by 1 (as_legacy_event).


##### `UserMessageItem::text_elements`  (lines 280–306)

```
fn text_elements(&self) -> Vec<TextElement>
```

**Purpose**: Rebases per-chunk `TextElement` byte ranges so they align with the concatenated string returned by `message()`. This preserves placeholder annotations after flattening multiple text inputs into one legacy message.

**Data flow**: Walks `self.content` in order, tracking a running byte `offset`. For each `UserInput::Text`, it clones each embedded element into a new `TextElement` whose `ByteRange` start/end are shifted by `offset`, and whose placeholder text is recomputed against the original chunk text. It returns the accumulated `Vec<TextElement>`.

**Call relations**: Used only by `UserMessageItem::as_legacy_event`. Its logic depends on the same text concatenation order as `message()`, so the two methods together preserve positional metadata for legacy consumers.

*Call graph*: calls 1 internal fn (new); called by 1 (as_legacy_event); 1 external calls (new).


##### `UserMessageItem::image_urls`  (lines 308–316)

```
fn image_urls(&self) -> Vec<String>
```

**Purpose**: Extracts remote image URLs from `UserInput::Image` entries in order. It ignores text and local-image inputs.

**Data flow**: Iterates over `self.content`, clones each `image_url` from `UserInput::Image`, collects them into a `Vec<String>`, and returns it. No state is changed.

**Call relations**: Called by `UserMessageItem::as_legacy_event` to populate the legacy `images` field. It is paired with `image_details()` so remote image metadata stays positionally aligned.

*Call graph*: called by 1 (as_legacy_event).


##### `UserMessageItem::image_details`  (lines 318–328)

```
fn image_details(&self) -> Vec<Option<ImageDetail>>
```

**Purpose**: Collects optional `ImageDetail` values for remote images and trims meaningless trailing `None` entries. This keeps the serialized legacy detail vector compact and backward-compatible.

**Data flow**: Filters `self.content` for `UserInput::Image`, copies each `detail: Option<ImageDetail>` into a vector, passes that vector through `trim_trailing_default_image_details`, and returns the trimmed result. It does not mutate `self`.

**Call relations**: Used by `UserMessageItem::as_legacy_event` alongside `image_urls()`. The trimming helper is important because legacy consumers interpret omitted trailing defaults differently from explicit `null`s.

*Call graph*: calls 1 internal fn (trim_trailing_default_image_details); called by 1 (as_legacy_event).


##### `UserMessageItem::local_image_paths`  (lines 330–338)

```
fn local_image_paths(&self) -> Vec<std::path::PathBuf>
```

**Purpose**: Extracts filesystem paths from `UserInput::LocalImage` entries. It preserves ordering so the paths line up with local-image detail metadata.

**Data flow**: Iterates over `self.content`, clones each `path` from `UserInput::LocalImage`, collects them into a `Vec<PathBuf>`, and returns it. No external state is touched.

**Call relations**: Called by `UserMessageItem::as_legacy_event` to populate the legacy `local_images` field. It is the local-file counterpart to `image_urls()`.

*Call graph*: called by 1 (as_legacy_event).


##### `UserMessageItem::local_image_details`  (lines 340–350)

```
fn local_image_details(&self) -> Vec<Option<ImageDetail>>
```

**Purpose**: Collects optional `ImageDetail` values for local images and removes trailing default `None` entries. This mirrors the remote-image detail behavior for local attachments.

**Data flow**: Filters `self.content` for `UserInput::LocalImage`, copies each optional `detail`, trims trailing `None` values via `trim_trailing_default_image_details`, and returns the resulting vector. It does not mutate `self`.

**Call relations**: Used by `UserMessageItem::as_legacy_event` together with `local_image_paths()`. It shares the same trimming invariant as `image_details()`.

*Call graph*: calls 1 internal fn (trim_trailing_default_image_details); called by 1 (as_legacy_event).


##### `trim_trailing_default_image_details`  (lines 353–360)

```
fn trim_trailing_default_image_details(
    mut details: Vec<Option<ImageDetail>>,
) -> Vec<Option<ImageDetail>>
```

**Purpose**: Removes trailing `None` entries from an image-detail vector. This treats absent trailing defaults as semantically equivalent to explicit nulls while producing a smaller, more compatible payload.

**Data flow**: Takes ownership of `Vec<Option<ImageDetail>>`, repeatedly checks `details.last()` and pops while the last element is `Some(None)`, then returns the shortened vector. It mutates only the local vector argument.

**Call relations**: Called by both `UserMessageItem::image_details` and `UserMessageItem::local_image_details`. It centralizes the wire-shape normalization used for legacy image metadata fields.

*Call graph*: called by 2 (image_details, local_image_details); 1 external calls (matches!).


##### `HookPromptItem::from_fragments`  (lines 363–370)

```
fn from_fragments(id: Option<&String>, fragments: Vec<HookPromptFragment>) -> Self
```

**Purpose**: Builds a hook-prompt item from already parsed fragments, reusing a provided ID when available or generating a new UUID otherwise. It is the canonical constructor after parsing or reconstruction.

**Data flow**: Accepts `Option<&String>` and `Vec<HookPromptFragment>`, clones the provided ID if present or generates a UUID string if absent, and returns `HookPromptItem { id, fragments }`. No external state is modified.

**Call relations**: Used by hook-prompt parsing code after XML fragments have been decoded. It lets callers preserve upstream IDs when reconstructing items from response content.

*Call graph*: called by 2 (parse_visible_hook_prompt_message, parse_hook_prompt_message).


##### `HookPromptFragment::from_single_hook`  (lines 374–379)

```
fn from_single_hook(text: impl Into<String>, hook_run_id: impl Into<String>) -> Self
```

**Purpose**: Convenience constructor for a single hook-prompt fragment from arbitrary string-like inputs. It normalizes both fields into owned `String`s.

**Data flow**: Accepts `text` and `hook_run_id` as `impl Into<String>`, converts both, and returns `HookPromptFragment { text, hook_run_id }`. It has no side effects.

**Call relations**: Used mainly in tests and fragment assembly code to create fragments succinctly. It feeds into `build_hook_prompt_message` when constructing outbound hook-prompt messages.

*Call graph*: 1 external calls (into).


##### `build_hook_prompt_message`  (lines 382–403)

```
fn build_hook_prompt_message(fragments: &[HookPromptFragment]) -> Option<ResponseItem>
```

**Purpose**: Encodes hook-prompt fragments into a `ResponseItem::Message` whose content is a sequence of XML-wrapped `ContentItem::InputText` entries. Empty or invalid fragments are filtered out, and no message is produced if nothing valid remains.

**Data flow**: Accepts a slice of `HookPromptFragment`, filters out fragments whose `hook_run_id` is blank after trimming, serializes each remaining fragment with `serialize_hook_prompt_fragment`, wraps successful XML strings as `ContentItem::InputText`, and collects them. If the resulting content vector is empty it returns `None`; otherwise it returns `Some(ResponseItem::Message { id: Some(uuid), role: "user", content, phase: None, metadata: None })`.

**Call relations**: Called when hook prompts need to be embedded into response-item streams or rebuilt from rollout data. It delegates XML formatting to `serialize_hook_prompt_fragment` and is the inverse of `parse_hook_prompt_message`.

*Call graph*: called by 6 (rebuilds_hook_prompt_items_from_rollout_response_items, test_hook_prompt_raw_response_emits_item_completed, detects_hook_prompt_fragment_and_roundtrips_escaping, parses_hook_prompt_message_as_distinct_turn_item, run_turn, hook_prompt_roundtrips_multiple_fragments); 2 external calls (iter, new_v4).


##### `parse_hook_prompt_message`  (lines 405–424)

```
fn parse_hook_prompt_message(
    id: Option<&String>,
    content: &[ContentItem],
) -> Option<HookPromptItem>
```

**Purpose**: Attempts to decode an entire `ResponseItem` message content array into a `HookPromptItem`. Parsing succeeds only if every content item is `InputText` and every text payload parses as a valid hook-prompt fragment.

**Data flow**: Accepts an optional ID reference and a slice of `ContentItem`. It maps each item: non-`InputText` items immediately yield `None`, while text items are passed to `parse_hook_prompt_fragment`. The collected `Option<Vec<_>>` short-circuits on any failure; empty fragment lists also return `None`. On success it returns `Some(HookPromptItem::from_fragments(id, fragments))`.

**Call relations**: Used by response-item handling code to detect hook prompts encoded inside ordinary message content. It is the structural inverse of `build_hook_prompt_message` and delegates per-fragment XML parsing to `parse_hook_prompt_fragment`.

*Call graph*: calls 1 internal fn (from_fragments); called by 3 (handle_response_item, maybe_emit_hook_prompt_item_completed, hook_prompt_roundtrips_multiple_fragments); 1 external calls (iter).


##### `parse_hook_prompt_fragment`  (lines 426–434)

```
fn parse_hook_prompt_fragment(text: &str) -> Option<HookPromptFragment>
```

**Purpose**: Parses a single XML hook-prompt fragment string into `HookPromptFragment`. It rejects malformed XML and fragments whose `hook_run_id` is blank after trimming.

**Data flow**: Accepts `&str`, trims surrounding whitespace, deserializes it with `quick_xml::de::from_str::<HookPromptXml>`, extracts `text` and `hook_run_id`, rejects empty IDs, and returns `Some(HookPromptFragment { text, hook_run_id })` or `None` on failure. It does not mutate external state.

**Call relations**: Called by `parse_hook_prompt_message` and other hook-prompt detection paths. It is the inverse of `serialize_hook_prompt_fragment`, with the additional invariant that blank IDs are invalid.

*Call graph*: called by 4 (is_contextual_user_fragment, parse_visible_hook_prompt_message, rollout_hook_prompt_texts, hook_prompt_parses_legacy_single_hook_run_id).


##### `serialize_hook_prompt_fragment`  (lines 436–445)

```
fn serialize_hook_prompt_fragment(text: &str, hook_run_id: &str) -> Option<String>
```

**Purpose**: Serializes one hook-prompt fragment into the XML text form embedded in response content. It refuses to serialize fragments with blank hook-run IDs.

**Data flow**: Accepts `text` and `hook_run_id` as `&str`, returns `None` if the ID is blank after trimming, otherwise builds a `HookPromptXml` struct, serializes it with `quick_xml::se::to_string`, and returns the XML string on success. No external state is changed.

**Call relations**: Used by `build_hook_prompt_message` to encode fragments for transport. It pairs with `parse_hook_prompt_fragment` to provide round-trippable XML representation.

*Call graph*: 1 external calls (to_string).


##### `AgentMessageItem::new`  (lines 448–455)

```
fn new(content: &[AgentMessageContent]) -> Self
```

**Purpose**: Constructs an assistant-authored message item from a slice of `AgentMessageContent`, assigning a UUID and leaving optional metadata unset. It is the basic constructor for assistant turn items.

**Data flow**: Accepts `&[AgentMessageContent]`, clones the slice into a vector, generates a UUID string for `id`, sets `phase` and `memory_citation` to `None`, and returns the new `AgentMessageItem`. It writes no external state.

**Call relations**: Used wherever assistant output is first materialized into turn items. Its output is later consumed by `as_legacy_events` when older event streams are needed.

*Call graph*: 2 external calls (to_vec, new_v4).


##### `AgentMessageItem::as_legacy_events`  (lines 457–468)

```
fn as_legacy_events(&self) -> Vec<EventMsg>
```

**Purpose**: Converts each assistant content chunk into a separate legacy `AgentMessage` event while preserving optional phase and memory-citation metadata. The current content model only supports text chunks.

**Data flow**: Iterates over `self.content`; for each `AgentMessageContent::Text { text }`, clones the text plus `self.phase` and `self.memory_citation` into `EventMsg::AgentMessage(AgentMessageEvent { ... })`. It returns the collected `Vec<EventMsg>` without mutating `self`.

**Call relations**: Called by `TurnItem::as_legacy_events` for `TurnItem::AgentMessage`. It is intentionally one-to-many because a single item may contain multiple content segments.


##### `ReasoningItem::as_legacy_events`  (lines 472–491)

```
fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>
```

**Purpose**: Projects reasoning summaries, and optionally raw reasoning content, into the older event stream. Summary text always emits `AgentReasoning` events; raw content emits only when explicitly enabled.

**Data flow**: Reads `self.summary_text` and pushes one `EventMsg::AgentReasoning` per entry. If `show_raw_agent_reasoning` is true, it also reads `self.raw_content` and pushes one `EventMsg::AgentReasoningRawContent` per entry. It returns the accumulated vector and does not mutate state.

**Call relations**: Used by `TurnItem::as_legacy_events` for reasoning items. The boolean flag lets callers decide whether sensitive or verbose raw reasoning should be surfaced to legacy consumers.

*Call graph*: 3 external calls (new, AgentReasoning, AgentReasoningRawContent).


##### `WebSearchItem::as_legacy_event`  (lines 495–501)

```
fn as_legacy_event(&self) -> EventMsg
```

**Purpose**: Converts a completed web-search item into the legacy `WebSearchEnd` event. It preserves the call ID, query string, and structured action.

**Data flow**: Clones `self.id`, `self.query`, and `self.action` into `EventMsg::WebSearchEnd(WebSearchEndEvent { ... })` and returns it. No state is mutated.

**Call relations**: Called by `TurnItem::as_legacy_events` for `TurnItem::WebSearch`. It provides a one-to-one compatibility mapping for completed search activity.

*Call graph*: 2 external calls (clone, WebSearchEnd).


##### `ImageGenerationItem::as_legacy_event`  (lines 505–513)

```
fn as_legacy_event(&self) -> EventMsg
```

**Purpose**: Projects an image-generation item into the legacy completion event format. It carries status, revised prompt, result payload, and optional saved path.

**Data flow**: Reads and clones `self.id`, `status`, `revised_prompt`, `result`, and `saved_path` into `EventMsg::ImageGenerationEnd(ImageGenerationEndEvent { ... })`. It returns the event without mutating `self`.

**Call relations**: Used by `TurnItem::as_legacy_events` for `TurnItem::ImageGeneration`. It is a straightforward compatibility adapter for image-generation completion.

*Call graph*: 1 external calls (ImageGenerationEnd).


##### `FileChangeItem::as_legacy_begin_event`  (lines 517–524)

```
fn as_legacy_begin_event(&self, turn_id: String) -> EventMsg
```

**Purpose**: Builds the legacy patch-apply begin event from a file-change item. It marks whether the patch was auto-approved and includes the full change map.

**Data flow**: Accepts a `turn_id: String`, clones `self.id` and `self.changes`, reads `self.auto_approved.unwrap_or(false)`, and returns `EventMsg::PatchApplyBegin(PatchApplyBeginEvent { call_id, turn_id, auto_approved, changes })`. It does not mutate `self`.

**Call relations**: Used by code paths that need explicit begin/end patch lifecycle events. Unlike `TurnItem::as_legacy_events`, this method emits the start-side event directly and requires the caller to supply the turn ID.

*Call graph*: 1 external calls (PatchApplyBegin).


##### `FileChangeItem::as_legacy_end_event`  (lines 526–537)

```
fn as_legacy_end_event(&self, turn_id: String) -> Option<EventMsg>
```

**Purpose**: Builds the legacy patch-apply completion event when the file-change item has a final `status`. If status is absent, no end event is emitted.

**Data flow**: Accepts `turn_id: String`, clones `self.status` and returns `None` immediately if it is absent. Otherwise it clones `id` and `changes`, fills missing `stdout`/`stderr` with empty strings, computes `success` as `status == PatchApplyStatus::Completed`, and returns `Some(EventMsg::PatchApplyEnd(...))`.

**Call relations**: Called directly by callers that need patch completion events and by `TurnItem::as_legacy_events`, which passes an empty turn ID in its generic projection. The optional return reflects that an in-progress file-change item has no completion event yet.

*Call graph*: 1 external calls (PatchApplyEnd).


##### `McpToolCallItem::as_legacy_begin_event`  (lines 541–552)

```
fn as_legacy_begin_event(&self) -> EventMsg
```

**Purpose**: Converts an MCP tool-call item into the legacy begin event, including invocation metadata and optional app/plugin identifiers. Null JSON arguments are omitted from the invocation payload.

**Data flow**: Reads `self.id`, `server`, `tool`, `arguments`, `mcp_app_resource_uri`, and `plugin_id`. It constructs `McpInvocation` with `arguments: (!self.arguments.is_null()).then(|| self.arguments.clone())`, wraps it in `EventMsg::McpToolCallBegin(McpToolCallBeginEvent { ... })`, and returns the event.

**Call relations**: Used by code that emits explicit MCP begin events. It is the start-side counterpart to `as_legacy_end_event` and preserves the same invocation shape.

*Call graph*: 2 external calls (is_null, McpToolCallBegin).


##### `McpToolCallItem::as_legacy_end_event`  (lines 554–573)

```
fn as_legacy_end_event(&self) -> Option<EventMsg>
```

**Purpose**: Builds the legacy MCP tool-call completion event when both a terminal result state and a duration are available. It encodes either a successful `CallToolResult` or an error string.

**Data flow**: Reads `self.result` and `self.error` to derive a `Result<CallToolResult, String>`: success if `result` exists, failure if only `error` exists, and `None` if neither exists. It then requires `self.duration?`; if duration is absent it returns `None`. Otherwise it clones invocation metadata and returns `Some(EventMsg::McpToolCallEnd(...))`.

**Call relations**: Called by `TurnItem::as_legacy_events` for `TurnItem::McpToolCall`, and by callers that need explicit completion events. The optional return encodes two completion prerequisites: terminal outcome data and measured duration.

*Call graph*: 2 external calls (is_null, McpToolCallEnd).


##### `TurnItem::id`  (lines 577–592)

```
fn id(&self) -> String
```

**Purpose**: Returns the item ID regardless of which `TurnItem` variant is stored. It provides a uniform accessor over the heterogeneous enum.

**Data flow**: Matches on `self`, clones the `id` field from the contained item struct, and returns it as `String`. It reads only the enum payload and mutates nothing.

**Call relations**: Used by higher-level orchestration code that needs stable item identifiers without variant-specific branching. It is a pure accessor over the enum.


##### `TurnItem::as_legacy_events`  (lines 594–617)

```
fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>
```

**Purpose**: Projects any turn item into zero or more legacy `EventMsg` values. Some variants map directly, some expand into multiple events, and some intentionally disappear because the legacy protocol has no equivalent.

**Data flow**: Matches on `self`: user messages become a one-element vector from `as_legacy_event`; hook prompts, plans, and sleeps return empty vectors; agent messages and reasoning delegate to their own multi-event converters; web search, image generation, image view, and context compaction each produce one event; file changes and MCP tool calls call their optional end-event methods and collect the `Option` into a vector. It returns the resulting `Vec<EventMsg>`.

**Call relations**: This is the central compatibility adapter for the file. Callers use it when streaming modern turn items to legacy event consumers, and it delegates to the variant-specific conversion methods where richer logic is needed.

*Call graph*: 3 external calls (new, new, vec!).


##### `tests::hook_prompt_roundtrips_multiple_fragments`  (lines 626–639)

```
fn hook_prompt_roundtrips_multiple_fragments()
```

**Purpose**: Verifies that multiple hook-prompt fragments survive a full encode/decode round trip through `ResponseItem::Message` content. It also checks XML escaping behavior indirectly by using punctuation and ampersands in the fragment text.

**Data flow**: Builds two `HookPromptFragment`s, passes them to `build_hook_prompt_message`, pattern-matches the resulting `ResponseItem::Message` to extract `content`, parses that content with `parse_hook_prompt_message`, and asserts that the parsed fragments equal the originals. On unexpected message shape it panics.

**Call relations**: Run by the test harness as the main round-trip test for hook-prompt serialization. It exercises both `build_hook_prompt_message` and `parse_hook_prompt_message` together.

*Call graph*: calls 2 internal fn (build_hook_prompt_message, parse_hook_prompt_message); 3 external calls (assert_eq!, panic!, vec!).


##### `tests::hook_prompt_parses_legacy_single_hook_run_id`  (lines 642–655)

```
fn hook_prompt_parses_legacy_single_hook_run_id()
```

**Purpose**: Checks that a single legacy XML hook-prompt fragment parses into the expected structured fragment. This preserves compatibility with older serialized forms.

**Data flow**: Passes a literal `<hook_prompt hook_run_id="..."></hook_prompt>` string to `parse_hook_prompt_fragment`, unwraps the result, and asserts equality with a manually constructed `HookPromptFragment`. It reads no shared state and writes none.

**Call relations**: Executed by the test harness as a focused parser compatibility test. It isolates `parse_hook_prompt_fragment` without involving message-level wrapping.

*Call graph*: calls 1 internal fn (parse_hook_prompt_fragment); 1 external calls (assert_eq!).


### `protocol/src/protocol.rs`

`data_model` · `cross-cutting`

This file is the protocol backbone for the system. It declares the request side (`Submission`, `Op`, thread-setting overrides, realtime conversation inputs), the response side (`Event`, the large `EventMsg` tagged enum, and dozens of concrete event payload structs), and the durable history format (`RolloutItem`, `SessionMeta`, `TurnContextItem`, `InitialHistory`). The design is intentionally schema-heavy: most types derive `Serialize`, `Deserialize`, `JsonSchema`, and `TS`, so the same Rust definitions drive persistence, API payloads, and generated frontend typings.

A major theme is backward compatibility. Several payloads accept legacy aliases (`task_started`/`turn_started`, `environmentId`/`environment_id`), default missing fields for old rollout files (`completed_at_ms`, `summary_index`, `content_index`), and provide bridges from older sandbox representations to newer permission profiles. `HasLegacyEvent` converts newer item lifecycle events back into older begin/end events for consumers that still expect them.

The file also embeds policy logic rather than only raw data. `SandboxPolicy` computes writable roots from cwd, `/tmp`, and `TMPDIR`, while protecting sensitive subpaths; `WritableRoot` rejects writes outside the root, inside read-only carveouts, or under protected metadata names. Token accounting helpers aggregate usage and estimate remaining context-window headroom. Session/thread source enums normalize startup strings and preserve lineage for subagents and internal sessions. Review, MCP, dynamic tool, collaboration, and realtime conversation payloads all live here so a single protocol layer can describe the full lifecycle of a turn from startup through tool execution, approvals, compaction, rollback, and shutdown.

#### Function details

##### `TurnEnvironmentSelections::new`  (lines 126–134)

```
fn new(
        legacy_fallback_cwd: AbsolutePathBuf,
        environments: Vec<TurnEnvironmentSelection>,
    ) -> Self
```

**Purpose**: Constructs a `TurnEnvironmentSelections` value from an explicit fallback cwd and a full list of environment-specific cwd selections. It is a thin constructor used where callers need to package both pieces together as one atomic override.

**Data flow**: Takes an `AbsolutePathBuf` for `legacy_fallback_cwd` and a `Vec<TurnEnvironmentSelection>` for `environments` → stores them unchanged into a new `TurnEnvironmentSelections` struct → returns that struct without side effects.

**Call relations**: Called by session/thread setup and resume paths when environment overrides are assembled or validated. It does not delegate further; its role is to make callers pass the fallback cwd and environment list together so downstream code can treat them as a coherent snapshot.

*Call graph*: called by 30 (collect_resume_override_mismatches_includes_service_tier, build_environment_override, run_review_on_session, spawn_internal, absolute_cwd_update_with_turn_environment_is_allowed, empty_turn_environments_clear_primary_environment, environment_settings_preserve_explicit_primary_cwd, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_configuration_for_tests (+15 more)).


##### `GitSha::new`  (lines 143–145)

```
fn new(sha: &str) -> Self
```

**Purpose**: Wraps a raw SHA string in the `GitSha` newtype used by session metadata and git info payloads. It gives call sites a typed protocol value instead of passing plain strings.

**Data flow**: Takes `&str` input → clones it into an owned `String` → returns `GitSha(String)`.

**Call relations**: Used by git metadata collection and tests that verify serialization and backfill behavior. It delegates to standard string allocation only and performs no validation itself.

*Call graph*: called by 8 (thread_list_includes_git_info, thread_metadata_update_can_clear_stored_git_fields, test_git_info_serialization, stored_thread, branch_remote_and_distance, collect_git_info, get_head_commit_hash, backfill_sessions_preserves_existing_git_branch_and_fills_missing_git_fields).


##### `RealtimeVoice::wire_name`  (lines 244–266)

```
fn wire_name(self) -> &'static str
```

**Purpose**: Maps each `RealtimeVoice` enum variant to the exact lowercase identifier expected on the wire. This avoids relying on enum formatting when talking to realtime backends.

**Data flow**: Reads `self` → matches every voice variant explicitly → returns a `&'static str` such as `"alloy"`, `"cove"`, or `"marin"`.

**Call relations**: Used wherever a protocol enum must be converted into backend-facing text. It is a leaf mapping function with no further delegation.


##### `RealtimeVoicesList::builtin`  (lines 280–308)

```
fn builtin() -> Self
```

**Purpose**: Returns the built-in catalog of supported realtime voices, split by protocol version and annotated with defaults. The ordering is stable and intentionally encoded in code.

**Data flow**: Creates two concrete `Vec<RealtimeVoice>` lists for `v1` and `v2`, plus `default_v1` and `default_v2` values → returns a populated `RealtimeVoicesList`.

**Call relations**: Invoked by voice-listing and validation flows that need the canonical supported set. It does not inspect runtime state; it serves as the authoritative static source for voice availability.

*Call graph*: called by 4 (thread_realtime_list_voices, default_realtime_voice, validate_realtime_voice, realtime_conversation_list_voices); 1 external calls (vec!).


##### `Op::from`  (lines 666–674)

```
fn from(value: Vec<UserInput>) -> Self
```

**Purpose**: Converts a plain vector of `UserInput` items into the full `Op::UserInput` submission variant with all optional turn-scoped fields initialized to defaults. This is a convenience bridge for callers that only have message content.

**Data flow**: Takes `Vec<UserInput>` → wraps it in `Op::UserInput { items, final_output_json_schema: None, responsesapi_client_metadata: None, additional_context: Default::default(), thread_settings: ThreadSettingsOverrides::default() }` → returns the enum value.

**Call relations**: Used by code paths that want to enqueue a user turn without manually filling every optional field. It delegates only to default constructors for the map and thread settings.

*Call graph*: 2 external calls (default, default).


##### `InterAgentCommunication::new`  (lines 694–710)

```
fn new(
        author: AgentPath,
        recipient: AgentPath,
        other_recipients: Vec<AgentPath>,
        content: String,
        trigger_turn: bool,
    ) -> Self
```

**Purpose**: Builds a plaintext inter-agent message record with sender, primary recipient, optional additional recipients, content, and whether it should trigger a turn. It leaves encryption and metadata unset.

**Data flow**: Consumes `author`, `recipient`, `other_recipients`, `content`, and `trigger_turn` → stores them in a new `InterAgentCommunication` with `encrypted_content: None` and `metadata: None` → returns the struct.

**Call relations**: Called by multi-agent orchestration when forwarding child completions, spawning agents, or queueing direct parent messages. It is the standard constructor for durable, model-visible agent-to-agent messages.

*Call graph*: called by 27 (maybe_start_completion_watcher, ensure_v2_agent_loaded_reloads_registered_unloaded_agent, multi_agent_v2_completion_queues_message_for_direct_parent, send_inter_agent_communication_without_turn_queues_message_without_triggering_turn, spawn_agent_can_fork_parent_thread_history_with_sanitized_items, spawn_agent_fork_last_n_turns_keeps_only_recent_turns, inter_agent_assistant_msg, forward_child_completion_to_parent, make_mail, inter_agent_assistant_message (+15 more)).


##### `InterAgentCommunication::new_encrypted`  (lines 712–728)

```
fn new_encrypted(
        author: AgentPath,
        recipient: AgentPath,
        other_recipients: Vec<AgentPath>,
        encrypted_content: String,
        trigger_turn: bool,
    ) -> Self
```

**Purpose**: Builds an inter-agent message whose payload is carried in `encrypted_content` instead of plaintext `content`. It preserves the same routing and trigger semantics as the plaintext constructor.

**Data flow**: Consumes `author`, `recipient`, `other_recipients`, `encrypted_content`, and `trigger_turn` → creates a struct with empty plaintext `content`, `encrypted_content: Some(...)`, and `metadata: None` → returns it.

**Call relations**: Used when agent communication must be serialized as an encrypted envelope, including tests around memory serialization and queued encrypted messages. It does not perform encryption itself; it only packages already-encrypted text.

*Call graph*: called by 4 (encrypted_inter_agent_communication_clears_existing_last_task_message, communication_from_tool_message, serializes_inter_agent_communications_for_memory, queued_encrypted_inter_agent_communication_renders_message_envelope); 1 external calls (new).


##### `InterAgentCommunication::to_response_input_item`  (lines 730–738)

```
fn to_response_input_item(&self) -> ResponseInputItem
```

**Purpose**: Converts an inter-agent communication record into a `ResponseInputItem::Message` suitable for feeding back through the Responses API input channel. The message is encoded as JSON text and marked as commentary.

**Data flow**: Reads `self` → serializes the whole struct with `serde_json::to_string(self).unwrap_or_default()` → wraps that JSON string in `ContentItem::OutputText` inside `ResponseInputItem::Message { role: "assistant", phase: Some(MessagePhase::Commentary) }` → returns the input item.

**Call relations**: Used when inter-agent traffic must be represented as a model input item rather than a durable rollout record. It delegates to serde JSON serialization and hardcodes the assistant/commentary framing so downstream consumers can distinguish it from normal user content.

*Call graph*: 1 external calls (vec!).


##### `InterAgentCommunication::to_model_input_item`  (lines 740–770)

```
fn to_model_input_item(&self) -> ResponseItem
```

**Purpose**: Projects an inter-agent message into the model-facing `ResponseItem` form. Plaintext messages become a single text content item; encrypted messages become a two-part envelope with a descriptive header and an encrypted payload item.

**Data flow**: Reads all fields on `self` → if `encrypted_content` is present, computes a `message_type` string based on `trigger_turn`, formats a header containing recipient and sender, and builds `Vec<AgentMessageInputContent>` with `InputText` plus `EncryptedContent`; otherwise builds a one-element text vector from `content` → returns `ResponseItem::AgentMessage { author, recipient, content, metadata }` using stringified paths and cloned metadata.

**Call relations**: Called when recording inter-agent communication into model-visible history. It encapsulates the protocol choice that encrypted messages are not flattened into plaintext but preserved as a structured envelope.

*Call graph*: called by 1 (record_inter_agent_communication); 2 external calls (to_string, vec!).


##### `InterAgentCommunication::is_message_content`  (lines 772–774)

```
fn is_message_content(content: &[ContentItem]) -> bool
```

**Purpose**: Checks whether a slice of generic `ContentItem` values encodes a serialized `InterAgentCommunication`. It is a predicate wrapper around the parser.

**Data flow**: Takes `&[ContentItem]` → calls `Self::from_message_content(content)` → returns `true` if parsing succeeded and `false` otherwise.

**Call relations**: Used by higher-level content classification logic to recognize inter-agent instruction payloads. It delegates all actual decoding to `from_message_content`.

*Call graph*: called by 1 (is_inter_agent_instruction_content); 1 external calls (from_message_content).


##### `InterAgentCommunication::from_message_content`  (lines 776–783)

```
fn from_message_content(content: &[ContentItem]) -> Option<Self>
```

**Purpose**: Attempts to decode an `InterAgentCommunication` from a single text content item. Only one-element slices containing either `InputText` or `OutputText` are accepted.

**Data flow**: Takes `&[ContentItem]` → pattern matches on exactly one `InputText { text }` or `OutputText { text }` element → runs `serde_json::from_str(text).ok()` → returns `Some(InterAgentCommunication)` on successful JSON decode, otherwise `None`.

**Call relations**: Used by message-boundary and content-recognition logic that needs to recover structured inter-agent messages from generic content arrays. It intentionally rejects multi-item content to avoid ambiguous decoding.

*Call graph*: called by 1 (is_trigger_turn_boundary); 1 external calls (from_str).


##### `Op::kind`  (lines 787–816)

```
fn kind(&self) -> &'static str
```

**Purpose**: Returns a stable snake_case string label for each submission operation variant. These labels are suitable for logging, metrics, or generic dispatch metadata.

**Data flow**: Reads `self` → matches every `Op` variant explicitly → returns a `&'static str` such as `"user_input"`, `"refresh_mcp_servers"`, or `"run_user_shell_command"`.

**Call relations**: Used by callers that need a lightweight operation identifier without serializing the full enum. It is a pure mapping function.


##### `GranularApprovalConfig::allows_sandbox_approval`  (lines 888–890)

```
fn allows_sandbox_approval(self) -> bool
```

**Purpose**: Reports whether sandbox approval prompts are enabled in a granular approval policy. It exposes the raw `sandbox_approval` flag through a named method.

**Data flow**: Reads `self.sandbox_approval` from a copied config → returns that boolean unchanged.

**Call relations**: Called when rendering or interpreting granular approval instructions. It does not transform state beyond naming the intent of the field.

*Call graph*: called by 1 (granular_instructions).


##### `GranularApprovalConfig::allows_rules_approval`  (lines 892–894)

```
fn allows_rules_approval(self) -> bool
```

**Purpose**: Reports whether approval prompts triggered by execpolicy `prompt` rules are allowed. It is the accessor for the `rules` flag.

**Data flow**: Reads `self.rules` → returns the boolean.

**Call relations**: Used by granular approval instruction generation to decide whether rule-based prompts should be surfaced or auto-rejected.

*Call graph*: called by 1 (granular_instructions).


##### `GranularApprovalConfig::allows_skill_approval`  (lines 896–898)

```
fn allows_skill_approval(self) -> bool
```

**Purpose**: Reports whether prompts caused by skill script execution are allowed under the current granular approval policy.

**Data flow**: Reads `self.skill_approval` → returns the boolean.

**Call relations**: Consumed by granular approval logic that needs to distinguish skill-triggered approvals from other approval categories.

*Call graph*: called by 1 (granular_instructions).


##### `GranularApprovalConfig::allows_request_permissions`  (lines 900–902)

```
fn allows_request_permissions(self) -> bool
```

**Purpose**: Reports whether `request_permissions` tool prompts are allowed under the granular approval policy.

**Data flow**: Reads `self.request_permissions` → returns the boolean.

**Call relations**: Used by approval-policy rendering and enforcement code to decide whether permission-escalation prompts may be shown.

*Call graph*: called by 1 (granular_instructions).


##### `GranularApprovalConfig::allows_mcp_elicitations`  (lines 904–906)

```
fn allows_mcp_elicitations(self) -> bool
```

**Purpose**: Reports whether MCP elicitation prompts are allowed under the granular approval policy.

**Data flow**: Reads `self.mcp_elicitations` → returns the boolean.

**Call relations**: Called by granular approval instruction generation so MCP elicitation behavior can be described or enforced separately from other prompt types.

*Call graph*: called by 1 (granular_instructions).


##### `NetworkAccess::is_enabled`  (lines 922–924)

```
fn is_enabled(self) -> bool
```

**Purpose**: Normalizes the `NetworkAccess` enum into a simple boolean indicating whether outbound network access is available.

**Data flow**: Reads `self` → returns `true` only for `NetworkAccess::Enabled`, `false` for `Restricted`.

**Call relations**: Used by sandbox policy helpers when translating `ExternalSandbox` network settings into full-access booleans.

*Call graph*: 1 external calls (matches!).


##### `WritableRoot::is_path_writable`  (lines 1000–1018)

```
fn is_path_writable(&self, path: &Path) -> bool
```

**Purpose**: Determines whether a concrete filesystem path is writable under a writable-root rule with read-only carveouts and protected metadata names. It enforces three checks in order: containment under the root, exclusion from read-only subpaths, and exclusion from protected top-level metadata names.

**Data flow**: Takes `&Path` → returns `false` immediately if the path is not under `self.root`; iterates `read_only_subpaths` and returns `false` if any prefix matches; calls `path_contains_protected_metadata_name` and returns `false` if that check succeeds; otherwise returns `true`.

**Call relations**: Used by sandbox evaluation and tests that probe effective write permissions. It delegates the metadata-name check to the helper method so top-level protected names are handled consistently.

*Call graph*: calls 1 internal fn (path_contains_protected_metadata_name); 1 external calls (starts_with).


##### `WritableRoot::path_contains_protected_metadata_name`  (lines 1020–1032)

```
fn path_contains_protected_metadata_name(&self, path: &Path) -> bool
```

**Purpose**: Checks whether a path under the writable root begins with one of the configured protected metadata directory names. This prevents creating or replacing sensitive top-level metadata paths even when the root itself is writable.

**Data flow**: Takes `&Path` → attempts `strip_prefix(&self.root)`; if that fails or the relative path has no first component, returns `false`; otherwise compares the first component against each string in `protected_metadata_names` using `OsStr` equality → returns whether any name matches.

**Call relations**: Called only from `WritableRoot::is_path_writable` as the final veto after root and read-only-subpath checks.

*Call graph*: called by 1 (is_path_writable); 1 external calls (strip_prefix).


##### `SandboxPolicy::from_str`  (lines 1038–1040)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a JSON string into a `SandboxPolicy`. The string is expected to be the serde representation of the tagged enum.

**Data flow**: Takes `&str` → passes it to `serde_json::from_str` → returns `Result<SandboxPolicy, serde_json::Error>`.

**Call relations**: Provides `FromStr` support so config and CLI layers can parse sandbox policies from textual JSON. It delegates entirely to serde.

*Call graph*: 1 external calls (from_str).


##### `FileSystemSandboxPolicy::from_str`  (lines 1046–1048)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a JSON string into a `FileSystemSandboxPolicy` using serde.

**Data flow**: Takes `&str` → calls `serde_json::from_str` → returns `Result<FileSystemSandboxPolicy, serde_json::Error>`.

**Call relations**: Acts as the textual parsing hook for the newer filesystem-specific sandbox policy type.

*Call graph*: 1 external calls (from_str).


##### `NetworkSandboxPolicy::from_str`  (lines 1054–1056)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a JSON string into a `NetworkSandboxPolicy` using serde.

**Data flow**: Takes `&str` → calls `serde_json::from_str` → returns `Result<NetworkSandboxPolicy, serde_json::Error>`.

**Call relations**: Completes the trio of `FromStr` implementations for split runtime permission policies.

*Call graph*: 1 external calls (from_str).


##### `SandboxPolicy::new_read_only_policy`  (lines 1061–1065)

```
fn new_read_only_policy() -> Self
```

**Purpose**: Constructs the canonical read-only legacy sandbox policy with network disabled.

**Data flow**: Creates and returns `SandboxPolicy::ReadOnly { network_access: false }`.

**Call relations**: Used by tests and callers that need the standard restrictive baseline without spelling out the enum payload.


##### `SandboxPolicy::new_workspace_write_policy`  (lines 1070–1077)

```
fn new_workspace_write_policy() -> Self
```

**Purpose**: Constructs the canonical workspace-write legacy sandbox policy with no extra writable roots, network disabled, and both temporary-directory exclusions turned off.

**Data flow**: Creates and returns `SandboxPolicy::WorkspaceWrite { writable_roots: vec![], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false }`.

**Call relations**: Used by callers and tests that want the default workspace-write behavior before any cwd-specific expansion.

*Call graph*: 1 external calls (vec!).


##### `SandboxPolicy::has_full_disk_read_access`  (lines 1079–1081)

```
fn has_full_disk_read_access(&self) -> bool
```

**Purpose**: Reports whether the legacy sandbox policy grants unrestricted disk read access. In this protocol version it always returns `true` for every variant.

**Data flow**: Ignores `self` and returns `true`.

**Call relations**: Used by permission-summary and compatibility code. The unconditional result reflects the legacy policy model, where read restrictions are not represented.


##### `SandboxPolicy::has_full_disk_write_access`  (lines 1083–1090)

```
fn has_full_disk_write_access(&self) -> bool
```

**Purpose**: Reports whether the legacy sandbox policy grants unrestricted disk write access.

**Data flow**: Matches `self` → returns `true` for `DangerFullAccess` and `ExternalSandbox`, `false` for `ReadOnly` and `WorkspaceWrite`.

**Call relations**: Used by sandbox probing and compatibility tests to compare legacy and split-policy semantics.


##### `SandboxPolicy::has_full_network_access`  (lines 1092–1099)

```
fn has_full_network_access(&self) -> bool
```

**Purpose**: Reports whether the legacy sandbox policy permits unrestricted outbound network access.

**Data flow**: Matches `self` → returns `true` for `DangerFullAccess`; for `ExternalSandbox` delegates to `network_access.is_enabled()`; for `ReadOnly` and `WorkspaceWrite` returns the embedded boolean flag.

**Call relations**: Used by permission summaries and semantic-equivalence tests. It centralizes the variant-specific interpretation of network settings.


##### `SandboxPolicy::get_writable_roots_with_cwd`  (lines 1104–1192)

```
fn get_writable_roots_with_cwd(&self, cwd: &Path) -> Vec<WritableRoot>
```

**Purpose**: Expands a legacy sandbox policy into concrete writable roots for a specific cwd, including default writable locations and read-only carveouts. For workspace-write policies it merges configured roots with cwd, optional `/tmp`, and optional `TMPDIR`, canonicalizes absolute paths where possible, and computes protected subpaths for each root.

**Data flow**: Takes `&self` and `cwd: &Path` → returns empty vectors for `DangerFullAccess`, `ExternalSandbox`, and `ReadOnly`; for `WorkspaceWrite`, clones configured `writable_roots`, tries to convert `cwd` into `AbsolutePathBuf` and appends it, conditionally appends `/tmp` on Unix and `TMPDIR` from the environment unless excluded, logging invalid paths with `tracing::error!`; then maps each root into `WritableRoot { root, read_only_subpaths: default_read_only_subpaths_for_writable_root(...), protected_metadata_names: Vec::new() }` and returns the collected vector.

**Call relations**: Used by sandbox enforcement, compatibility bridges, and tests that compare effective write semantics. It is the main place where abstract legacy policy becomes concrete filesystem state tied to the current process environment.

*Call graph*: calls 1 internal fn (from_absolute_path); 5 external calls (from, new, cfg!, error!, var_os).


##### `EventMsg::from`  (lines 1636–1638)

```
fn from(event: SubAgentActivityEvent) -> Self
```

**Purpose**: Wraps collaboration and sub-agent activity payload structs into their corresponding `EventMsg` enum variants via `From` conversions. This lets callers emit those events without naming the enum variant explicitly.

**Data flow**: Takes a concrete event payload such as `CollabAgentSpawnBeginEvent` or `SubAgentActivityEvent` → returns the matching `EventMsg::...` variant containing that payload.

**Call relations**: Used by event-emission code that constructs collaboration events incrementally. These conversions are leaf wrappers and do not alter payload contents.

*Call graph*: 11 external calls (CollabAgentInteractionBegin, CollabAgentInteractionEnd, CollabAgentSpawnBegin, CollabAgentSpawnEnd, CollabCloseBegin, CollabCloseEnd, CollabResumeBegin, CollabResumeEnd, CollabWaitingBegin, CollabWaitingEnd (+1 more)).


##### `CodexErrorInfo::affects_turn_status`  (lines 1711–1728)

```
fn affects_turn_status(&self) -> bool
```

**Purpose**: Classifies protocol-level error kinds by whether they should mark a turn as failed during history replay. Some errors are informational or administrative and should not poison turn status.

**Data flow**: Reads `self` → returns `false` for `ThreadRollbackFailed` and `ActiveTurnNotSteerable`; returns `true` for all other enumerated error kinds including context, usage, HTTP, sandbox, stream, auth, and generic failures.

**Call relations**: Used indirectly through `ErrorEvent::affects_turn_status` when reconstructing turn state from persisted events.


##### `ItemStartedEvent::as_legacy_events`  (lines 1745–1760)

```
fn as_legacy_events(&self, _: bool) -> Vec<EventMsg>
```

**Purpose**: Projects a typed item lifecycle start event into older begin-style `EventMsg` values for legacy consumers. Only certain `TurnItem` variants have legacy equivalents.

**Data flow**: Reads `self.item` and `self.turn_id` → for `TurnItem::WebSearch` returns a one-element vector with `EventMsg::WebSearchBegin`; for `ImageGeneration` returns `ImageGenerationBegin`; for `FileChange` delegates to the item’s `as_legacy_begin_event`; for `McpToolCall` delegates to its legacy begin conversion; for `ImageView` and all other variants returns an empty vector.

**Call relations**: Called through the `HasLegacyEvent` trait when replaying or exporting events to older clients. It bridges the newer itemized lifecycle model back to the older event taxonomy.

*Call graph*: 2 external calls (new, vec!).


##### `default_item_completed_at_ms`  (lines 1775–1777)

```
fn default_item_completed_at_ms() -> i64
```

**Purpose**: Supplies the backward-compatible default timestamp for old `ItemCompletedEvent` rollout records that omitted `completed_at_ms`.

**Data flow**: Returns the constant `0`.

**Call relations**: Referenced by serde as the default provider during deserialization of `ItemCompletedEvent`.


##### `ItemCompletedEvent::as_legacy_events`  (lines 1784–1792)

```
fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>
```

**Purpose**: Projects a typed item lifecycle completion event into older end-style `EventMsg` values. File changes use a dedicated end-event conversion; other items delegate to their own legacy-event expansion.

**Data flow**: Reads `self.item` and `self.turn_id` → if the item is `TurnItem::FileChange`, calls `item.as_legacy_end_event(self.turn_id.clone())` and collects the optional result into a vector; otherwise calls `self.item.as_legacy_events(show_raw_agent_reasoning)` and returns that vector.

**Call relations**: Used by the `HasLegacyEvent` compatibility layer during replay/export. It complements `ItemStartedEvent::as_legacy_events` for completion-side translations.

*Call graph*: 1 external calls (as_legacy_events).


##### `AgentMessageContentDeltaEvent::as_legacy_events`  (lines 1804–1806)

```
fn as_legacy_events(&self, _: bool) -> Vec<EventMsg>
```

**Purpose**: Declares that incremental agent-message content deltas have no legacy event equivalent.

**Data flow**: Ignores inputs and returns an empty `Vec<EventMsg>`.

**Call relations**: Called through `HasLegacyEvent` when generic event replay asks for legacy projections.

*Call graph*: 1 external calls (new).


##### `ReasoningContentDeltaEvent::as_legacy_events`  (lines 1829–1831)

```
fn as_legacy_events(&self, _: bool) -> Vec<EventMsg>
```

**Purpose**: Declares that incremental reasoning-summary deltas have no legacy event equivalent.

**Data flow**: Ignores inputs and returns an empty `Vec<EventMsg>`.

**Call relations**: Used by the compatibility layer to suppress unsupported delta events for legacy consumers.

*Call graph*: 1 external calls (new).


##### `ReasoningRawContentDeltaEvent::as_legacy_events`  (lines 1846–1848)

```
fn as_legacy_events(&self, _: bool) -> Vec<EventMsg>
```

**Purpose**: Declares that incremental raw reasoning-content deltas have no legacy event equivalent.

**Data flow**: Ignores inputs and returns an empty `Vec<EventMsg>`.

**Call relations**: Used by the compatibility layer alongside the other delta-event no-op conversions.

*Call graph*: 1 external calls (new).


##### `EventMsg::as_legacy_events`  (lines 1852–1867)

```
fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>
```

**Purpose**: Dispatches legacy-event projection based on the concrete `EventMsg` variant. Only item lifecycle and delta variants participate; all other events produce no legacy expansion.

**Data flow**: Reads `self` → for `ItemStarted`, `ItemCompleted`, `AgentMessageContentDelta`, `ReasoningContentDelta`, and `ReasoningRawContentDelta`, delegates to the payload’s `as_legacy_events(show_raw_agent_reasoning)`; for every other variant returns an empty vector.

**Call relations**: This is the top-level compatibility hook used when replaying modern events into older UI/event models.

*Call graph*: 1 external calls (new).


##### `ErrorEvent::affects_turn_status`  (lines 1886–1890)

```
fn affects_turn_status(&self) -> bool
```

**Purpose**: Determines whether a concrete error event should mark the current turn as failed. If the event carries structured `CodexErrorInfo`, that classification is used; otherwise the error is treated as turn-affecting.

**Data flow**: Reads `self.codex_error_info` → if `None`, returns `true`; if `Some(info)`, calls `CodexErrorInfo::affects_turn_status` and returns that result.

**Call relations**: Called by error-handling and history-replay logic to decide whether an emitted error changes turn outcome.

*Call graph*: called by 1 (handle_error).


##### `TokenUsageInfo::new_or_append`  (lines 2018–2042)

```
fn new_or_append(
        info: &Option<TokenUsageInfo>,
        last: &Option<TokenUsage>,
        model_context_window: Option<i64>,
    ) -> Option<Self>
```

**Purpose**: Builds or updates aggregate token-usage state from an optional existing snapshot, an optional last-turn usage record, and an optional context-window size. It gracefully returns `None` when there is no prior info and no new usage.

**Data flow**: Takes `info: &Option<TokenUsageInfo>`, `last: &Option<TokenUsage>`, and `model_context_window: Option<i64>` → returns `None` if both options are absent; otherwise clones existing info or creates a zeroed snapshot, appends `last` via `append_last_usage` when present, overwrites `model_context_window` when a new value is supplied, and returns `Some(updated_info)`.

**Call relations**: Used by token accounting paths that incrementally update session totals after each turn or event. It centralizes the merge semantics for optional usage and optional context-window metadata.

*Call graph*: called by 4 (new, update_token_info, token_usage_info_new_or_append_preserves_context_window_when_not_provided, token_usage_info_new_or_append_updates_context_window_when_provided); 1 external calls (default).


##### `TokenUsageInfo::append_last_usage`  (lines 2044–2047)

```
fn append_last_usage(&mut self, last: &TokenUsage)
```

**Purpose**: Adds one `TokenUsage` sample into the running total and records it as the most recent usage snapshot.

**Data flow**: Takes `&mut self` and `last: &TokenUsage` → mutates `self.total_token_usage` in place via `add_assign(last)` → clones `last` into `self.last_token_usage` → returns unit.

**Call relations**: Called by `TokenUsageInfo::new_or_append` and any code that already has a mutable aggregate snapshot.

*Call graph*: calls 1 internal fn (add_assign); 1 external calls (clone).


##### `TokenUsageInfo::fill_to_context_window`  (lines 2049–2062)

```
fn fill_to_context_window(&mut self, context_window: i64)
```

**Purpose**: Rewrites token usage to represent a fully consumed context window, preserving only the delta from the previous total as the synthetic `last_token_usage`. This is used when the system knows the window is saturated rather than incrementally measured.

**Data flow**: Takes `&mut self` and `context_window: i64` → computes `previous_total`, `delta = max(context_window - previous_total, 0)` → sets `model_context_window = Some(context_window)` → replaces `total_token_usage` with a zeroed struct whose `total_tokens` equals `context_window` → replaces `last_token_usage` with a zeroed struct whose `total_tokens` equals `delta`.

**Call relations**: Used by code that marks token usage as fully occupying the model context window, rather than appending a measured sample.

*Call graph*: 1 external calls (default).


##### `TokenUsageInfo::full_context_window`  (lines 2064–2072)

```
fn full_context_window(context_window: i64) -> Self
```

**Purpose**: Creates a fresh `TokenUsageInfo` snapshot representing a completely full context window.

**Data flow**: Takes `context_window: i64` → creates a zeroed `TokenUsageInfo` with `model_context_window: Some(context_window)` → calls `fill_to_context_window(context_window)` on it → returns the populated snapshot.

**Call relations**: Called by code paths that need a one-shot saturated usage snapshot, such as explicit full-window accounting.

*Call graph*: called by 1 (set_token_usage_full); 1 external calls (default).


##### `RateLimitReachedType::from_str`  (lines 2107–2116)

```
fn from_str(value: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses the backend’s snake_case rate-limit reason string into the typed `RateLimitReachedType` enum.

**Data flow**: Takes `&str` → matches known literals like `"rate_limit_reached"` and workspace credit/usage depletion variants → returns the corresponding enum on success or an `Err(String)` describing the unknown value.

**Call relations**: Used when decoding textual rate-limit classifications from external sources into typed protocol state.

*Call graph*: 1 external calls (format!).


##### `TokenUsage::is_zero`  (lines 2150–2152)

```
fn is_zero(&self) -> bool
```

**Purpose**: Checks whether the aggregate token count is zero.

**Data flow**: Reads `self.total_tokens` → returns `true` if it equals `0`, else `false`.

**Call relations**: Used by summary/reporting code that wants to suppress empty usage displays.

*Call graph*: called by 1 (session_summary).


##### `TokenUsage::cached_input`  (lines 2154–2156)

```
fn cached_input(&self) -> i64
```

**Purpose**: Returns the cached-input token count, clamped at zero to avoid negative values leaking into displays or metrics.

**Data flow**: Reads `self.cached_input_tokens` → returns `max(value, 0)`.

**Call relations**: Used by metrics and by `non_cached_input` to compute the uncached portion safely.

*Call graph*: called by 3 (emit_guardian_token_usage_histograms, emit_token_usage_metrics, non_cached_input).


##### `TokenUsage::non_cached_input`  (lines 2158–2160)

```
fn non_cached_input(&self) -> i64
```

**Purpose**: Computes the uncached input-token count by subtracting cached input from total input and clamping at zero.

**Data flow**: Reads `self.input_tokens` and calls `self.cached_input()` → computes `(input_tokens - cached_input).max(0)` → returns that value.

**Call relations**: Used by metrics and display helpers, including `blended_total` and `FinalOutput` formatting.

*Call graph*: calls 1 internal fn (cached_input); called by 3 (emit_guardian_token_usage_histograms, blended_total, new).


##### `TokenUsage::blended_total`  (lines 2163–2165)

```
fn blended_total(&self) -> i64
```

**Purpose**: Computes the primary display total used in summaries: uncached input plus output tokens, excluding cached input and clamping negatives away.

**Data flow**: Calls `self.non_cached_input()` and reads `self.output_tokens` → computes `(non_cached_input + output_tokens.max(0)).max(0)` → returns the result.

**Call relations**: Used by `FinalOutput::fmt` and other display-oriented reporting paths.

*Call graph*: calls 1 internal fn (non_cached_input); called by 1 (new).


##### `TokenUsage::tokens_in_context_window`  (lines 2167–2169)

```
fn tokens_in_context_window(&self) -> i64
```

**Purpose**: Returns the token count that should be interpreted as occupying the model context window.

**Data flow**: Reads and returns `self.total_tokens` unchanged.

**Call relations**: Used by context-window percentage calculations.

*Call graph*: called by 1 (percent_of_context_window_remaining).


##### `TokenUsage::percent_of_context_window_remaining`  (lines 2181–2192)

```
fn percent_of_context_window_remaining(&self, context_window: i64) -> i64
```

**Purpose**: Estimates the remaining user-controllable percentage of the model context window after subtracting a fixed baseline reserved for prompts/tools/system context. This keeps the UI from showing immediate depletion due to fixed overhead.

**Data flow**: Takes `context_window: i64` and reads `self.total_tokens` via `tokens_in_context_window()` → if `context_window <= BASELINE_TOKENS`, returns `0`; otherwise computes `effective_window = context_window - BASELINE_TOKENS`, `used = max(total_tokens - BASELINE_TOKENS, 0)`, `remaining = max(effective_window - used, 0)`, converts to a percentage, clamps to `[0,100]`, rounds, and returns it as `i64`.

**Call relations**: Used by UI/reporting code that needs a normalized remaining-context indicator rather than raw token counts.

*Call graph*: calls 1 internal fn (tokens_in_context_window).


##### `TokenUsage::add_assign`  (lines 2195–2201)

```
fn add_assign(&mut self, other: &TokenUsage)
```

**Purpose**: Performs an in-place element-wise sum of two `TokenUsage` structs.

**Data flow**: Takes `&mut self` and `other: &TokenUsage` → adds each numeric field from `other` into the corresponding field on `self` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`) → returns unit.

**Call relations**: Used by `TokenUsageInfo::append_last_usage` to maintain running totals.

*Call graph*: called by 1 (append_last_usage).


##### `FinalOutput::from`  (lines 2210–2212)

```
fn from(token_usage: TokenUsage) -> Self
```

**Purpose**: Wraps a `TokenUsage` value in the `FinalOutput` struct used for final turn summaries.

**Data flow**: Consumes `TokenUsage` → returns `FinalOutput { token_usage }`.

**Call relations**: Provides a simple conversion for code that already has token usage and needs the final-output wrapper.


##### `FinalOutput::fmt`  (lines 2216–2242)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats token usage into a concise human-readable summary string, including uncached input, optional cached-input annotation, output, and optional reasoning-output annotation.

**Data flow**: Reads `self.token_usage`, computes display numbers using `blended_total()`, `non_cached_input()`, `cached_input()`, and `output_tokens`, formats each with `format_with_separators`, conditionally appends `(+ N cached)` and `(reasoning N)` fragments, and writes the final sentence into the formatter.

**Call relations**: Used when `FinalOutput` is rendered for logs, CLI output, or summaries. It delegates numeric formatting to `format_with_separators` and relies on the token helper methods for semantics.

*Call graph*: 1 external calls (write!).


##### `McpToolCallEndEvent::is_success`  (lines 2369–2374)

```
fn is_success(&self) -> bool
```

**Purpose**: Determines whether an MCP tool call completed successfully according to the protocol result payload. A transport-level `Err` is always failure; an `Ok` result is only success when `is_error` is not explicitly true.

**Data flow**: Reads `self.result` → if `Ok(result)`, returns `!result.is_error.unwrap_or(false)`; if `Err(_)`, returns `false`.

**Call relations**: Called by MCP event handling to classify completed tool calls for UI or state updates.

*Call graph*: called by 1 (handle_mcp_tool_call_end).


##### `InitialHistory::scan_rollout_items`  (lines 2432–2438)

```
fn scan_rollout_items(&self, mut predicate: impl FnMut(&RolloutItem) -> bool) -> bool
```

**Purpose**: Runs a predicate over the rollout items contained in resumed or forked history and reports whether any item matches. New or cleared histories are treated as empty.

**Data flow**: Takes `&self` and a mutable predicate `FnMut(&RolloutItem) -> bool` → returns `false` for `New` and `Cleared`; for `Resumed` runs `.any(&mut predicate)` over `history`; for `Forked` runs `.any(predicate)` over the item vector.

**Call relations**: Used by resume/fork logic that needs to inspect prior history without exposing the enum shape at each call site.

*Call graph*: called by 1 (initial_history_has_prior_user_turns).


##### `InitialHistory::forked_from_id`  (lines 2440–2454)

```
fn forked_from_id(&self) -> Option<ThreadId>
```

**Purpose**: Extracts the originating thread ID for forked history. Resumed histories look for `forked_from_id` in session metadata; directly forked histories use the source session’s own `id`.

**Data flow**: Reads `self` → returns `None` for `New`/`Cleared`; for `Resumed`, scans history for the first `RolloutItem::SessionMeta` carrying `meta.forked_from_id`; for `Forked`, scans for the first `SessionMeta` and returns `meta.id`.

**Call relations**: Called when creating a new forked thread so lineage can be preserved in session configuration.

*Call graph*: called by 1 (fork_thread_with_initial_history).


##### `InitialHistory::session_cwd`  (lines 2456–2462)

```
fn session_cwd(&self) -> Option<PathBuf>
```

**Purpose**: Returns the session cwd recorded in resumed or forked rollout items, if present.

**Data flow**: Reads `self` → returns `None` for `New`/`Cleared`; for `Resumed` and `Forked`, delegates to `session_cwd_from_items` on the contained rollout slice.

**Call relations**: Used by resume/fork reconstruction when cwd must be recovered from persisted history.

*Call graph*: calls 1 internal fn (session_cwd_from_items).


##### `InitialHistory::get_rollout_items`  (lines 2464–2470)

```
fn get_rollout_items(&self) -> Vec<RolloutItem>
```

**Purpose**: Returns the underlying rollout items as an owned vector, normalizing empty history variants to an empty list.

**Data flow**: Reads `self` → returns `Vec::new()` for `New`/`Cleared`; clones and returns `resumed.history` for `Resumed`; clones and returns the item vector for `Forked`.

**Call relations**: Used by thread loading, snapshotting, and truncation code that needs a concrete item list regardless of initial-history variant.

*Call graph*: called by 3 (load_thread_from_resume_source_or_send_internal, snapshot_turn_state, truncate_before_nth_user_message); 1 external calls (new).


##### `InitialHistory::get_event_msgs`  (lines 2472–2495)

```
fn get_event_msgs(&self) -> Option<Vec<EventMsg>>
```

**Purpose**: Extracts only the persisted `EventMsg` rollout items from resumed or forked history. Empty-history variants return `None` rather than an empty vector.

**Data flow**: Reads `self` → returns `None` for `New`/`Cleared`; for `Resumed` and `Forked`, iterates contained rollout items, filters `RolloutItem::EventMsg(ev)`, clones each event, collects them into a vector, and wraps it in `Some(...)`.

**Call relations**: Used when seeding client-visible initial messages from persisted history during session configuration.

*Call graph*: called by 1 (new).


##### `InitialHistory::get_base_instructions`  (lines 2497–2512)

```
fn get_base_instructions(&self) -> Option<BaseInstructions>
```

**Purpose**: Finds the session’s persisted `BaseInstructions` in rollout history, if any.

**Data flow**: Reads `self` → returns `None` for `New`/`Cleared`; for `Resumed` and `Forked`, scans rollout items for the first `RolloutItem::SessionMeta` and returns `meta.base_instructions.clone()`.

**Call relations**: Used by resume/fork reconstruction to recover session-level instructions when available.


##### `InitialHistory::get_dynamic_tools`  (lines 2514–2528)

```
fn get_dynamic_tools(&self) -> Option<Vec<DynamicToolSpec>>
```

**Purpose**: Finds the session’s persisted dynamic tool definitions in rollout history, if any.

**Data flow**: Reads `self` → returns `None` for `New`/`Cleared`; for `Resumed` and `Forked`, scans for the first `RolloutItem::SessionMeta` and returns `meta.dynamic_tools.clone()`.

**Call relations**: Used when reconstructing dynamic tool availability from resumed history.


##### `InitialHistory::get_multi_agent_version`  (lines 2530–2540)

```
fn get_multi_agent_version(&self) -> Option<MultiAgentVersion>
```

**Purpose**: Determines the effective persisted multi-agent protocol version from initial history, consulting session metadata first and falling back to turn-context items.

**Data flow**: Reads `self` → returns `None` for `New`/`Cleared`; for `Resumed`, calls `multi_agent_version_from_items(&history, Some(conversation_id))`; for `Forked`, calls `multi_agent_version_from_items(items, None)`.

**Call relations**: Called by version-resolution logic during thread resume/fork so multi-agent behavior matches persisted history.

*Call graph*: calls 1 internal fn (multi_agent_version_from_items); called by 1 (resolve_multi_agent_version).


##### `InitialHistory::get_resumed_session_sources`  (lines 2542–2545)

```
fn get_resumed_session_sources(&self) -> Option<(SessionSource, Option<ThreadSource>)>
```

**Purpose**: Returns the persisted session source and optional thread source for resumed histories.

**Data flow**: Calls `self.get_resumed_session_meta()?` → clones `meta.source` and `meta.thread_source` → returns them as `Some((SessionSource, Option<ThreadSource>))` or `None` if no resumed session metadata exists.

**Call relations**: Used by resume logic to preserve source classification across restarts.

*Call graph*: calls 1 internal fn (get_resumed_session_meta); called by 1 (resume_thread_with_history).


##### `InitialHistory::get_resumed_thread_source`  (lines 2547–2550)

```
fn get_resumed_thread_source(&self) -> Option<ThreadSource>
```

**Purpose**: Returns only the optional persisted thread source from resumed history.

**Data flow**: Calls `self.get_resumed_session_meta()` → maps the result to `meta.thread_source.clone()` → returns `Option<ThreadSource>`.

**Call relations**: A narrower accessor used when only thread-source analytics metadata is needed.

*Call graph*: calls 1 internal fn (get_resumed_session_meta).


##### `InitialHistory::get_resumed_parent_thread_id`  (lines 2552–2555)

```
fn get_resumed_parent_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the persisted parent thread ID from resumed history, if the resumed session metadata recorded one.

**Data flow**: Calls `self.get_resumed_session_meta()` → maps the result to `meta.parent_thread_id` → returns `Option<ThreadId>`.

**Call relations**: Used by resume logic to preserve subagent lineage.

*Call graph*: calls 1 internal fn (get_resumed_session_meta).


##### `InitialHistory::get_resumed_session_meta`  (lines 2557–2567)

```
fn get_resumed_session_meta(&self) -> Option<&SessionMeta>
```

**Purpose**: Internal helper that locates the `SessionMeta` record inside resumed history. Forked and empty histories intentionally do not expose a resumed session meta through this path.

**Data flow**: Reads `self` → returns `None` for `New`, `Cleared`, and `Forked`; for `Resumed`, scans `resumed.history` for the first `RolloutItem::SessionMeta` and returns a shared reference to its `meta` field.

**Call relations**: Used by the resumed-source, resumed-thread-source, and resumed-parent-thread-id accessors to avoid duplicating the scan logic.

*Call graph*: called by 3 (get_resumed_parent_thread_id, get_resumed_session_sources, get_resumed_thread_source).


##### `session_cwd_from_items`  (lines 2570–2575)

```
fn session_cwd_from_items(items: &[RolloutItem]) -> Option<PathBuf>
```

**Purpose**: Scans rollout items for the first session metadata record and returns its cwd.

**Data flow**: Takes `&[RolloutItem]` → iterates until it finds `RolloutItem::SessionMeta(meta_line)` → clones and returns `meta_line.meta.cwd` as `Some(PathBuf)`; returns `None` if no session metadata exists.

**Call relations**: Used by `InitialHistory::session_cwd` for both resumed and forked histories.

*Call graph*: called by 1 (session_cwd); 1 external calls (iter).


##### `ThreadSource::as_str`  (lines 2605–2612)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the canonical string form of a `ThreadSource`, preserving custom feature labels verbatim.

**Data flow**: Reads `self` → returns fixed literals for `User`, `Subagent`, and `MemoryConsolidation`; for `Feature(feature)` returns `feature` by reference.

**Call relations**: Used by the `Display` implementation and any code that needs the normalized textual label.

*Call graph*: called by 1 (fmt).


##### `ThreadSource::fmt`  (lines 2616–2618)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a `ThreadSource` as its canonical string label.

**Data flow**: Calls `self.as_str()` → writes that string into the formatter.

**Call relations**: Backs `to_string()` and conversions to plain strings.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `ThreadSource::try_from`  (lines 2624–2626)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: Parses an owned `String` into a `ThreadSource` by delegating to the string parser.

**Data flow**: Takes `String` → calls `value.parse()` / `from_str` → returns `Result<ThreadSource, String>`.

**Call relations**: Provides ergonomic conversion from owned strings in serde or API-adapter code.


##### `String::from`  (lines 2630–2632)

```
fn from(value: ThreadSource) -> Self
```

**Purpose**: Converts a `ThreadSource` into its string representation.

**Data flow**: Consumes `ThreadSource` → calls `to_string()` → returns the resulting `String`.

**Call relations**: Complements `TryFrom<String>` and `FromStr` so thread-source values round-trip cleanly through stringly typed interfaces.

*Call graph*: 1 external calls (to_string).


##### `ThreadSource::from_str`  (lines 2638–2645)

```
fn from_str(value: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a textual thread-source label into the typed enum. Known labels map to dedicated variants; any other nonempty label becomes `Feature(String)`.

**Data flow**: Takes `&str` → matches `"user"`, `"subagent"`, and `"memory_consolidation"`; otherwise allocates `ThreadSource::Feature(other.to_string())` → returns `Ok(...)` in all cases.

**Call relations**: Used by `TryFrom<String>` and deserialization paths that treat thread source as an application-owned string namespace.

*Call graph*: 1 external calls (Feature).


##### `SessionSource::fmt`  (lines 2676–2687)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a `SessionSource` into the persisted/display string used across analytics and rollout metadata. Internal and subagent sources are prefixed to preserve category information.

**Data flow**: Reads `self` → writes fixed strings for `Cli`, `VSCode`, `Exec`, `Mcp`, and `Unknown`; writes the contained string for `Custom`; formats `internal_{source}` for `Internal`; formats `subagent_{sub_source}` for `SubAgent`.

**Call relations**: Used by string conversions and any code that needs a stable textual session-source label.

*Call graph*: 2 external calls (write_str, write!).


##### `SessionSource::from_startup_arg`  (lines 2691–2706)

```
fn from_startup_arg(value: &str) -> Result<Self, &'static str>
```

**Purpose**: Normalizes a startup argument into a `SessionSource`, accepting several aliases and lowercasing custom values. Empty or whitespace-only input is rejected.

**Data flow**: Takes `&str` → trims whitespace; if empty, returns `Err("session source must not be empty")`; lowercases the trimmed value; maps known names (`cli`, `vscode`, `exec`, `mcp`, `appserver`, `app-server`, `app_server`, `unknown`) to dedicated variants; otherwise returns `SessionSource::Custom(normalized)`.

**Call relations**: Used during startup/session creation to turn CLI or config strings into typed source metadata.

*Call graph*: 1 external calls (Custom).


##### `SessionSource::is_internal`  (lines 2708–2710)

```
fn is_internal(&self) -> bool
```

**Purpose**: Reports whether the session source is one of the internal system-generated variants.

**Data flow**: Reads `self` → returns `true` only for `SessionSource::Internal(_)`.

**Call relations**: Used by callers that need to distinguish user-facing sessions from internal maintenance sessions.

*Call graph*: 1 external calls (matches!).


##### `SessionSource::is_non_root_agent`  (lines 2712–2717)

```
fn is_non_root_agent(&self) -> bool
```

**Purpose**: Reports whether the session belongs to a non-root agent context, either internal or subagent.

**Data flow**: Reads `self` → returns `true` for `Internal(_)` and `SubAgent(_)`, `false` otherwise.

**Call relations**: Used by agent/session logic that treats root-user sessions differently from spawned/internal agents.

*Call graph*: 1 external calls (matches!).


##### `SessionSource::get_nickname`  (lines 2719–2726)

```
fn get_nickname(&self) -> Option<String>
```

**Purpose**: Extracts the optional agent nickname from a thread-spawn subagent source.

**Data flow**: Reads `self` → if it is `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { agent_nickname, .. })`, clones and returns `agent_nickname`; otherwise returns `None`.

**Call relations**: Used by UI or lineage code that wants human-friendly subagent labels.


##### `SessionSource::get_agent_role`  (lines 2728–2735)

```
fn get_agent_role(&self) -> Option<String>
```

**Purpose**: Extracts the optional agent role from a thread-spawn subagent source.

**Data flow**: Reads `self` → if it is `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { agent_role, .. })`, clones and returns `agent_role`; otherwise returns `None`.

**Call relations**: Used where subagent role metadata should be surfaced or persisted.


##### `SessionSource::get_agent_path`  (lines 2737–2744)

```
fn get_agent_path(&self) -> Option<AgentPath>
```

**Purpose**: Extracts the optional canonical `AgentPath` from a thread-spawn subagent source.

**Data flow**: Reads `self` → if it is `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { agent_path, .. })`, clones and returns `agent_path`; otherwise returns `None`.

**Call relations**: Used by multi-agent v2 code that tracks canonical path-based agent identity.


##### `SessionSource::restriction_product`  (lines 2746–2756)

```
fn restriction_product(&self) -> Option<Product>
```

**Purpose**: Maps a session source to the `Product` used for product-restriction checks. Standard top-level sources default to `Codex`; custom sources are interpreted by name; internal and subagent sources intentionally produce no product.

**Data flow**: Reads `self` → for `Custom(source)` calls `Product::from_session_source_name(source)`; for `Cli`, `VSCode`, `Exec`, `Mcp`, and `Unknown` returns `Some(Product::Codex)`; for `Internal(_)` and `SubAgent(_)` returns `None`.

**Call relations**: Used by `matches_product_restriction` to evaluate product-scoped restrictions without guessing for internal/subagent sessions.

*Call graph*: calls 1 internal fn (from_session_source_name); called by 1 (matches_product_restriction).


##### `SessionSource::matches_product_restriction`  (lines 2758–2763)

```
fn matches_product_restriction(&self, products: &[Product]) -> bool
```

**Purpose**: Checks whether this session source satisfies a list of allowed products. An empty restriction list always matches.

**Data flow**: Takes `products: &[Product]` → returns `true` if the slice is empty; otherwise computes `self.restriction_product()` and, if present, asks that product whether it matches the restriction list; returns `false` when no product can be derived.

**Call relations**: Used by policy/filtering code that gates behavior by product family.

*Call graph*: calls 1 internal fn (restriction_product); 1 external calls (is_empty).


##### `SessionSource::parent_thread_id`  (lines 2765–2776)

```
fn parent_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the parent thread ID encoded in a subagent session source, if any.

**Data flow**: Reads `self` → for `SessionSource::SubAgent(subagent_source)` delegates to `subagent_source.parent_thread_id()`; for all other variants returns `None`.

**Call relations**: Used by lineage reconstruction and subagent session setup.


##### `SubAgentSource::fmt`  (lines 2780–2794)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a subagent source into a stable string label. Thread-spawn sources include the parent thread ID and depth in the formatted value.

**Data flow**: Reads `self` → writes fixed strings for `Review`, `Compact`, and `MemoryConsolidation`; for `ThreadSpawn { parent_thread_id, depth, .. }` writes `thread_spawn_{parent_thread_id}_d{depth}`; for `Other(other)` writes the contained string.

**Call relations**: Used by `SessionSource::fmt` and any code that needs a textual subagent-source identifier.

*Call graph*: 2 external calls (write_str, write!).


##### `SubAgentSource::kind`  (lines 2798–2806)

```
fn kind(&self) -> &str
```

**Purpose**: Returns the coarse-grained kind label for a subagent source, without embedding parent IDs or depth.

**Data flow**: Reads `self` → returns `"review"`, `"compact"`, `"thread_spawn"`, `"memory_consolidation"`, or the contained custom string.

**Call relations**: Used by code that wants to bucket subagent sources by type rather than full formatted identity.

*Call graph*: called by 1 (subagent_source_name).


##### `SubAgentSource::parent_thread_id`  (lines 2808–2818)

```
fn parent_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Extracts the parent thread ID from a thread-spawn subagent source.

**Data flow**: Reads `self` → returns `Some(*parent_thread_id)` for `ThreadSpawn`; returns `None` for `Review`, `Compact`, `MemoryConsolidation`, and `Other`.

**Call relations**: Used by `SessionSource::parent_thread_id` and lineage-aware session logic.


##### `InternalSessionSource::fmt`  (lines 2822–2826)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats an internal session source as its stable string label.

**Data flow**: Reads `self` → currently writes `"memory_consolidation"` for the sole variant.

**Call relations**: Used by `SessionSource::fmt` when rendering internal session sources.

*Call graph*: 1 external calls (write_str).


##### `multi_agent_version_from_items`  (lines 2829–2852)

```
fn multi_agent_version_from_items(
    items: &[RolloutItem],
    thread_id: Option<ThreadId>,
) -> Option<MultiAgentVersion>
```

**Purpose**: Finds the effective `MultiAgentVersion` in rollout items, preferring the newest matching `SessionMeta` entry and falling back to the newest `TurnContext` entry. When a thread ID is supplied, only session metadata for that thread is considered.

**Data flow**: Takes `items: &[RolloutItem]` and `thread_id: Option<ThreadId>` → scans items in reverse for `RolloutItem::SessionMeta` whose `meta.id` matches the optional thread filter and returns `meta.multi_agent_version` if present; if none found, scans in reverse for `RolloutItem::TurnContext(turn_context)` and returns `turn_context.multi_agent_version`; otherwise returns `None`.

**Call relations**: Used by `InitialHistory::get_multi_agent_version` to reconstruct persisted multi-agent behavior from rollout history.

*Call graph*: called by 1 (get_multi_agent_version); 1 external calls (iter).


##### `SessionMeta::default`  (lines 2911–2931)

```
fn default() -> Self
```

**Purpose**: Creates an empty/default session metadata record with fresh default IDs and all optional metadata cleared. This supports tests and code paths that progressively fill fields.

**Data flow**: Constructs `SessionMeta` with `ThreadId::default()`, empty strings and paths, `SessionSource::default()`, and `None` for all optional fields including lineage, model provider, instructions, dynamic tools, memory mode, and multi-agent version → returns it.

**Call relations**: Used by tests and thread/session creation helpers as a baseline metadata object before real values are assigned.

*Call graph*: calls 1 internal fn (default); called by 6 (read_summary_from_rollout_preserves_agent_nickname, read_summary_from_rollout_preserves_forked_from_id, read_summary_from_rollout_returns_empty_preview_when_no_user_message, session_meta_item, session_meta_normalizes_legacy_dynamic_tools, create_thread); 3 external calls (new, new, default).


##### `ResponseItem::from`  (lines 2964–2974)

```
fn from(value: CompactedItem) -> Self
```

**Purpose**: Converts a `CompactedItem` into a plain assistant `ResponseItem::Message` so compacted summaries can be treated like normal assistant output in model history.

**Data flow**: Consumes `CompactedItem` → builds `ResponseItem::Message { id: None, role: "assistant", content: vec![ContentItem::OutputText { text: value.message }], phase: None, metadata: None }` → returns it.

**Call relations**: Used when replacement history or compacted summaries must be reinserted into response-item streams.

*Call graph*: 1 external calls (vec!).


##### `TurnContextItem::permission_profile`  (lines 3029–3044)

```
fn permission_profile(&self) -> PermissionProfile
```

**Purpose**: Returns the effective `PermissionProfile` for a persisted turn context. If a canonical profile was stored, it is reused; otherwise the method reconstructs one from legacy sandbox fields.

**Data flow**: Reads `self.permission_profile` → if `Some`, clones and returns it; otherwise obtains a `FileSystemSandboxPolicy` from `self.file_system_sandbox_policy` or derives one from `self.sandbox_policy` and `self.cwd`, computes `SandboxEnforcement::from_legacy_sandbox_policy(&self.sandbox_policy)` and `NetworkSandboxPolicy::from(&self.sandbox_policy)`, then calls `PermissionProfile::from_runtime_permissions_with_enforcement(...)` and returns the result.

**Call relations**: Called when applying persisted turn context back into runtime state or reconstructing filesystem permissions from rollout history.

*Call graph*: called by 2 (filesystem_from_turn_context_item, apply_turn_context).


##### `TruncationPolicy::from`  (lines 3055–3060)

```
fn from(config: crate::openai_models::TruncationPolicyConfig) -> Self
```

**Purpose**: Converts an OpenAI-model truncation config into the protocol’s simpler `TruncationPolicy` enum.

**Data flow**: Consumes `crate::openai_models::TruncationPolicyConfig` → matches `config.mode` and returns `TruncationPolicy::Bytes(config.limit as usize)` or `TruncationPolicy::Tokens(config.limit as usize)`.

**Call relations**: Used where model-layer truncation settings are projected into protocol-visible policy values.

*Call graph*: 2 external calls (Bytes, Tokens).


##### `TruncationPolicy::token_budget`  (lines 3064–3072)

```
fn token_budget(&self) -> usize
```

**Purpose**: Returns an approximate token budget for the truncation policy, converting byte limits into estimated tokens when necessary.

**Data flow**: Reads `self` → for `Bytes(bytes)`, calls `codex_utils_string::approx_tokens_from_byte_count(*bytes)`, attempts `usize::try_from`, and falls back to `usize::MAX` on overflow; for `Tokens(tokens)`, returns the stored token count.

**Call relations**: Used by output-truncation logic that needs a token-oriented budget regardless of how the policy was specified.

*Call graph*: called by 2 (model_output_max_tokens, truncate_function_output_items_with_policy); 2 external calls (approx_tokens_from_byte_count, try_from).


##### `TruncationPolicy::byte_budget`  (lines 3074–3081)

```
fn byte_budget(&self) -> usize
```

**Purpose**: Returns an approximate byte budget for the truncation policy, converting token limits into estimated bytes when necessary.

**Data flow**: Reads `self` → for `Bytes(bytes)` returns the stored byte count; for `Tokens(tokens)` calls `codex_utils_string::approx_bytes_for_tokens(*tokens)` and returns that estimate.

**Call relations**: Used by text-formatting and truncation code that operates on byte lengths.

*Call graph*: called by 3 (formatted_truncate_text, formatted_truncate_text_content_items_with_policy, truncate_function_output_items_with_policy); 1 external calls (approx_bytes_for_tokens).


##### `TruncationPolicy::mul`  (lines 3087–3096)

```
fn mul(self, multiplier: f64) -> Self::Output
```

**Purpose**: Scales a truncation policy by a floating-point multiplier, rounding up so the scaled budget is never smaller than the mathematical product.

**Data flow**: Consumes `self` and `multiplier: f64` → for `Bytes(bytes)` computes `(bytes as f64 * multiplier).ceil() as usize` and returns `Bytes(...)`; for `Tokens(tokens)` computes the analogous scaled token count and returns `Tokens(...)`.

**Call relations**: Used by callers that reserve fractions of a truncation budget for subcomponents while preserving the original unit.

*Call graph*: 2 external calls (Bytes, Tokens).


##### `ReviewOutputEvent::default`  (lines 3172–3179)

```
fn default() -> Self
```

**Purpose**: Creates an empty structured review result with no findings, empty overall text fields, and zero confidence.

**Data flow**: Constructs `ReviewOutputEvent { findings: Vec::new(), overall_correctness: String::default(), overall_explanation: String::default(), overall_confidence_score: 0.0 }` → returns it.

**Call relations**: Used as a baseline when review mode exits without a populated result or when tests need an empty review payload.

*Call graph*: 2 external calls (default, new).


##### `McpAuthStatus::fmt`  (lines 3465–3473)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats MCP authentication status into user-facing text labels.

**Data flow**: Reads `self` → maps variants to `"Unsupported"`, `"Not logged in"`, `"Bearer token"`, or `"OAuth"` → writes the chosen string into the formatter.

**Call relations**: Used anywhere MCP auth status is displayed or stringified.

*Call graph*: 1 external calls (write_str).


##### `Product::to_app_platform`  (lines 3493–3499)

```
fn to_app_platform(self) -> &'static str
```

**Purpose**: Maps a `Product` enum to the short platform identifier used by app-facing integrations.

**Data flow**: Reads `self` → returns `"chat"` for `Chatgpt`, `"codex"` for `Codex`, and `"atlas"` for `Atlas`.

**Call relations**: Used when product restrictions or source classifications must be translated into app-platform labels.


##### `Product::from_session_source_name`  (lines 3501–3509)

```
fn from_session_source_name(value: &str) -> Option<Self>
```

**Purpose**: Interprets a session-source string as a known product name, case-insensitively and after trimming whitespace.

**Data flow**: Takes `&str` → trims and lowercases it → returns `Some(Product::Chatgpt)`, `Some(Product::Codex)`, or `Some(Product::Atlas)` for exact matches, otherwise `None`.

**Call relations**: Called by `SessionSource::restriction_product` to derive product restrictions from custom session-source names.

*Call graph*: called by 1 (restriction_product).


##### `Product::matches_product_restriction`  (lines 3511–3513)

```
fn matches_product_restriction(&self, products: &[Product]) -> bool
```

**Purpose**: Checks whether this product is allowed by a restriction list, with empty lists treated as unrestricted.

**Data flow**: Takes `products: &[Product]` → returns `true` if the slice is empty or if it contains `self`; otherwise returns `false`.

**Call relations**: Used by `SessionSource::matches_product_restriction` after a source has been mapped to a product.

*Call graph*: 2 external calls (contains, is_empty).


##### `SessionConfiguredEvent::deserialize`  (lines 3658–3725)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Custom-deserializes `SessionConfiguredEvent` while preserving backward compatibility with older rollout records that stored `sandbox_policy` instead of `permission_profile`, and that sometimes omitted `thread_id`. It immediately normalizes legacy fields into the canonical modern representation.

**Data flow**: Deserializes an internal `Wire` struct containing both modern and legacy fields → computes `permission_profile` by preferring `wire.permission_profile`, otherwise deriving it from `wire.sandbox_policy` and `wire.cwd`, otherwise raising a missing-field error → sets `thread_id` to the provided value or derives it from `session_id` → copies the remaining fields into a `SessionConfiguredEvent` and returns it.

**Call relations**: Invoked automatically by serde when reading persisted or incoming session-configured payloads. It is the key compatibility bridge that lets old rollout files deserialize into the new protocol shape.

*Call graph*: calls 1 internal fn (from_legacy_sandbox_policy_for_cwd); 2 external calls (deserialize, missing_field).


##### `validate_thread_goal_objective`  (lines 3742–3752)

```
fn validate_thread_goal_objective(value: &str) -> Result<(), String>
```

**Purpose**: Validates a thread-goal objective string against protocol constraints: it must be nonempty and no longer than `MAX_THREAD_GOAL_OBJECTIVE_CHARS` Unicode scalar values.

**Data flow**: Takes `&str` → if empty, returns `Err("goal objective must not be empty")`; if `value.chars().count()` exceeds 4000, returns a formatted length error; otherwise returns `Ok(())`.

**Call relations**: Called by thread-goal creation/update flows before persisting or accepting a goal objective.

*Call graph*: called by 2 (set_thread_goal, handle_create); 1 external calls (format!).


##### `ReviewDecision::to_opaque_string`  (lines 3821–3836)

```
fn to_opaque_string(&self) -> &'static str
```

**Purpose**: Converts a review/approval decision into a privacy-safe categorical label that omits embedded amendment details or other potentially sensitive payload data.

**Data flow**: Reads `self` → matches each variant and returns a fixed `&'static str`, with `NetworkPolicyAmendment` further branching on allow vs deny action.

**Call relations**: Used by telemetry or logging surfaces that need decision categories without serializing full decision contents.


##### `tests::feature_thread_source_serializes_as_its_app_owned_label`  (lines 4142–4151)

```
fn feature_thread_source_serializes_as_its_app_owned_label() -> Result<()>
```

**Purpose**: Verifies that `ThreadSource::Feature` serializes and deserializes as the raw feature label string rather than a tagged object.

**Data flow**: Creates `ThreadSource::Feature("automation")` → serializes to JSON and compares with `"automation"` → deserializes the same JSON back and asserts equality.

**Call relations**: Exercises the custom string-based serde behavior for feature thread sources.

*Call graph*: 2 external calls (Feature, assert_eq!).


##### `tests::session_meta_normalizes_legacy_dynamic_tools`  (lines 4154–4204)

```
fn session_meta_normalizes_legacy_dynamic_tools() -> Result<()>
```

**Purpose**: Checks that legacy flat dynamic-tool entries deserialize into the newer namespace-grouped `DynamicToolSpec` structure inside `SessionMeta`.

**Data flow**: Starts from `SessionMeta::default()` serialized to JSON, injects a legacy `dynamic_tools` array, deserializes back into `SessionMeta`, and asserts that the resulting `dynamic_tools` field contains one namespace spec with two function specs and the expected `defer_loading` defaults.

**Call relations**: Validates backward-compatible deserialization behavior for persisted session metadata.

*Call graph*: calls 1 internal fn (default); 4 external calls (assert_eq!, json!, from_value, to_value).


##### `tests::sorted_writable_roots`  (lines 4206–4221)

```
fn sorted_writable_roots(roots: Vec<WritableRoot>) -> Vec<(PathBuf, Vec<PathBuf>)>
```

**Purpose**: Normalizes a vector of `WritableRoot` values into a sorted, comparable representation for assertions.

**Data flow**: Consumes `Vec<WritableRoot>` → converts each root into `(PathBuf, Vec<PathBuf>)`, sorts each root’s `read_only_subpaths`, then sorts the outer vector by root path → returns the normalized vector.

**Call relations**: Used by filesystem-policy tests to compare writable-root sets deterministically.


##### `tests::sandbox_policy_allows_read`  (lines 4223–4225)

```
fn sandbox_policy_allows_read(policy: &SandboxPolicy, _path: &Path, _cwd: &Path) -> bool
```

**Purpose**: Test helper that models read permission under the legacy sandbox policy abstraction.

**Data flow**: Takes a `SandboxPolicy` and ignores the path arguments → returns `policy.has_full_disk_read_access()`.

**Call relations**: Used by semantic-equivalence tests comparing legacy and split sandbox policies.

*Call graph*: 1 external calls (has_full_disk_read_access).


##### `tests::sandbox_policy_allows_write`  (lines 4227–4236)

```
fn sandbox_policy_allows_write(policy: &SandboxPolicy, path: &Path, cwd: &Path) -> bool
```

**Purpose**: Test helper that models write permission under the legacy sandbox policy abstraction for a specific path and cwd.

**Data flow**: Takes `policy`, `path`, and `cwd` → returns `true` immediately if `policy.has_full_disk_write_access()`; otherwise computes writable roots with `get_writable_roots_with_cwd(cwd)` and returns whether any root reports the path writable.

**Call relations**: Used by semantic-equivalence tests to compare effective write behavior across policy representations.

*Call graph*: 2 external calls (get_writable_roots_with_cwd, has_full_disk_write_access).


##### `tests::session_source_from_startup_arg_maps_known_values`  (lines 4239–4248)

```
fn session_source_from_startup_arg_maps_known_values()
```

**Purpose**: Verifies that known startup-source strings map to the expected dedicated `SessionSource` variants.

**Data flow**: Parses `"vscode"` and `"app-server"` with `SessionSource::from_startup_arg` and asserts the results are `VSCode` and `Mcp`.

**Call relations**: Covers alias handling in startup-source normalization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::inter_agent_communication_response_input_item_preserves_commentary_phase`  (lines 4251–4272)

```
fn inter_agent_communication_response_input_item_preserves_commentary_phase()
```

**Purpose**: Checks that converting inter-agent communication to a response input item preserves assistant role, JSON payload, and commentary phase.

**Data flow**: Builds an `InterAgentCommunication` with root/child agent paths → calls `to_response_input_item()` → asserts exact equality with the expected `ResponseInputItem::Message` containing serialized JSON and `MessagePhase::Commentary`.

**Call relations**: Validates the model-input projection used for inter-agent history.

*Call graph*: calls 1 internal fn (root); 2 external calls (assert_eq!, vec!).


##### `tests::queued_encrypted_inter_agent_communication_renders_message_envelope`  (lines 4275–4301)

```
fn queued_encrypted_inter_agent_communication_renders_message_envelope()
```

**Purpose**: Verifies that encrypted inter-agent communication is converted into the expected two-part model envelope with a descriptive header and encrypted payload item.

**Data flow**: Constructs an encrypted communication via `new_encrypted` → calls `to_model_input_item()` → asserts equality with the expected `ResponseItem::AgentMessage` content vector.

**Call relations**: Covers the encrypted branch of `InterAgentCommunication::to_model_input_item`.

*Call graph*: calls 2 internal fn (root, new_encrypted); 2 external calls (new, assert_eq!).


##### `tests::session_source_from_startup_arg_normalizes_custom_values`  (lines 4304–4313)

```
fn session_source_from_startup_arg_normalizes_custom_values()
```

**Purpose**: Verifies that unknown startup-source strings are trimmed, lowercased, and stored as `SessionSource::Custom`.

**Data flow**: Parses `"atlas"` and `" Atlas "` → asserts both become `SessionSource::Custom("atlas")`.

**Call relations**: Tests normalization behavior for custom session sources.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_source_restriction_product_defaults_non_subagent_sources_to_codex`  (lines 4316–4337)

```
fn session_source_restriction_product_defaults_non_subagent_sources_to_codex()
```

**Purpose**: Checks that standard top-level session sources all map to `Product::Codex` for restriction purposes.

**Data flow**: Calls `restriction_product()` on `Cli`, `VSCode`, `Exec`, `Mcp`, and `Unknown` → asserts each returns `Some(Product::Codex)`.

**Call relations**: Validates the default product mapping used by restriction checks.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_source_restriction_product_does_not_guess_subagent_products`  (lines 4340–4350)

```
fn session_source_restriction_product_does_not_guess_subagent_products()
```

**Purpose**: Ensures internal and subagent session sources do not infer a product restriction category.

**Data flow**: Calls `restriction_product()` on a review subagent source and an internal memory-consolidation source → asserts both return `None`.

**Call relations**: Protects against over-broad product inference for non-root sessions.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_source_restriction_product_maps_custom_sources_to_products`  (lines 4353–4370)

```
fn session_source_restriction_product_maps_custom_sources_to_products()
```

**Purpose**: Verifies that recognized custom source names map to products and unrecognized names do not.

**Data flow**: Constructs several `SessionSource::Custom` values (`chatgpt`, `ATLAS`, `codex`, `atlas-dev`) → calls `restriction_product()` and asserts the expected `Some(...)` or `None` results.

**Call relations**: Tests `Product::from_session_source_name` as used through `SessionSource`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_source_matches_product_restriction`  (lines 4373–4388)

```
fn session_source_matches_product_restriction()
```

**Purpose**: Checks end-to-end product restriction matching for custom and built-in session sources.

**Data flow**: Calls `matches_product_restriction()` with various product slices on custom chatgpt, VSCode, and unknown custom atlas-dev sources → asserts expected true/false outcomes, including the unrestricted empty-slice case.

**Call relations**: Exercises the combined `restriction_product` and `Product::matches_product_restriction` logic.

*Call graph*: 1 external calls (assert!).


##### `tests::sandbox_policy_probe_paths`  (lines 4390–4403)

```
fn sandbox_policy_probe_paths(policy: &SandboxPolicy, cwd: &Path) -> Vec<PathBuf>
```

**Purpose**: Builds a deduplicated set of representative paths to probe when comparing sandbox semantics.

**Data flow**: Starts with `cwd`, then for each writable root from `policy.get_writable_roots_with_cwd(cwd)` adds the root path and all read-only subpaths, sorts and deduplicates the list, and returns it.

**Call relations**: Used by semantic-equivalence tests to choose paths for read/write comparisons.

*Call graph*: 2 external calls (get_writable_roots_with_cwd, vec!).


##### `tests::assert_same_sandbox_policy_semantics`  (lines 4405–4441)

```
fn assert_same_sandbox_policy_semantics(
        expected: &SandboxPolicy,
        actual: &SandboxPolicy,
        cwd: &Path,
    )
```

**Purpose**: Asserts that two sandbox policies expose the same effective read/write/network semantics for a set of probe paths under a given cwd.

**Data flow**: Compares full-access booleans directly, unions probe paths from both policies, then for each path compares helper-derived read and write permissions with assertion messages that include the path.

**Call relations**: Central helper for tests that round-trip between legacy and split sandbox policy representations.

*Call graph*: 2 external calls (assert_eq!, sandbox_policy_probe_paths).


##### `tests::external_sandbox_reports_full_access_flags`  (lines 4444–4456)

```
fn external_sandbox_reports_full_access_flags()
```

**Purpose**: Verifies that `ExternalSandbox` always reports full disk write access and reflects its embedded network setting accurately.

**Data flow**: Constructs restricted and enabled `ExternalSandbox` policies → asserts write access is always true and network access matches the enum value.

**Call relations**: Tests `has_full_disk_write_access` and `has_full_network_access` for the external-sandbox variant.

*Call graph*: 1 external calls (assert!).


##### `tests::read_only_reports_network_access_flags`  (lines 4459–4467)

```
fn read_only_reports_network_access_flags()
```

**Purpose**: Verifies that read-only policies report network access according to their boolean flag.

**Data flow**: Creates the default read-only policy and a read-only policy with `network_access: true` → asserts the first reports false and the second true.

**Call relations**: Tests the read-only branch of `has_full_network_access`.

*Call graph*: 2 external calls (new_read_only_policy, assert!).


##### `tests::granular_approval_config_mcp_elicitation_flag_is_field_driven`  (lines 4470–4491)

```
fn granular_approval_config_mcp_elicitation_flag_is_field_driven()
```

**Purpose**: Checks that `allows_mcp_elicitations()` simply reflects the `mcp_elicitations` field.

**Data flow**: Constructs two `GranularApprovalConfig` values differing only in `mcp_elicitations` → asserts the accessor returns true and false respectively.

**Call relations**: Covers one granular approval accessor.

*Call graph*: 1 external calls (assert!).


##### `tests::granular_approval_config_skill_approval_flag_is_field_driven`  (lines 4494–4515)

```
fn granular_approval_config_skill_approval_flag_is_field_driven()
```

**Purpose**: Checks that `allows_skill_approval()` reflects the `skill_approval` field.

**Data flow**: Constructs configs with `skill_approval` true and false → asserts the accessor matches.

**Call relations**: Covers another granular approval accessor.

*Call graph*: 1 external calls (assert!).


##### `tests::granular_approval_config_request_permissions_flag_is_field_driven`  (lines 4518–4539)

```
fn granular_approval_config_request_permissions_flag_is_field_driven()
```

**Purpose**: Checks that `allows_request_permissions()` reflects the `request_permissions` field.

**Data flow**: Constructs configs with `request_permissions` true and false → asserts the accessor matches.

**Call relations**: Covers another granular approval accessor.

*Call graph*: 1 external calls (assert!).


##### `tests::granular_approval_config_defaults_missing_optional_flags_to_false`  (lines 4542–4560)

```
fn granular_approval_config_defaults_missing_optional_flags_to_false()
```

**Purpose**: Verifies serde defaults for optional granular approval flags omitted from JSON.

**Data flow**: Deserializes a JSON object missing `skill_approval` and `request_permissions` → asserts the resulting struct has those fields set to `false`.

**Call relations**: Protects backward-compatible decoding of older config payloads.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::restricted_file_system_policy_reports_full_access_from_root_entries`  (lines 4563–4582)

```
fn restricted_file_system_policy_reports_full_access_from_root_entries()
```

**Purpose**: Checks that split filesystem sandbox policies with a root entry correctly report full read or full write access depending on the access mode.

**Data flow**: Builds restricted policies containing a single `Root` entry with `Read` or `Write` access → asserts `has_full_disk_read_access`, `has_full_disk_write_access`, and `include_platform_defaults` behave as expected.

**Call relations**: Tests semantics of the newer `FileSystemSandboxPolicy` type imported into this module.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert!, vec!).


##### `tests::restricted_file_system_policy_treats_root_with_carveouts_as_scoped_access`  (lines 4585–4636)

```
fn restricted_file_system_policy_treats_root_with_carveouts_as_scoped_access()
```

**Purpose**: Verifies that a root write grant plus a deny carveout is treated as scoped access rather than full access, and that the denied path appears as a read-only subpath.

**Data flow**: Creates a temp cwd, derives canonical root and blocked paths, builds a restricted policy with root write plus blocked deny, then asserts full-access flags are false, readable/unreadable roots are correct, and the writable root contains the blocked path in `read_only_subpaths`.

**Call relations**: Exercises carveout semantics for split filesystem policies.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_path_against_base); 5 external calls (new, assert!, assert_eq!, canonicalize_preserving_symlinks, vec!).


##### `tests::restricted_file_system_policy_derives_effective_paths`  (lines 4639–4706)

```
fn restricted_file_system_policy_derives_effective_paths()
```

**Purpose**: Checks that a restricted filesystem policy using symbolic project-root and minimal entries expands to the expected readable roots, unreadable roots, and protected metadata carveouts.

**Data flow**: Creates a temp cwd with `.agents` and `.codex`, builds a policy with `Minimal` read, project-root write, and a denied `secret` path, then asserts effective readable/unreadable roots and that writable roots include read-only subpaths for `secret`, `.agents`, and `.codex`.

**Call relations**: Tests path materialization and metadata protection in split filesystem policies.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_path_against_base); 6 external calls (new, assert!, assert_eq!, canonicalize_preserving_symlinks, create_dir_all, vec!).


##### `tests::restricted_file_system_policy_treats_read_entries_as_read_only_subpaths`  (lines 4709–4753)

```
fn restricted_file_system_policy_treats_read_entries_as_read_only_subpaths()
```

**Purpose**: Verifies that a nested read-only entry inside a writable project root becomes a read-only carveout, while a deeper nested write entry reopens that subpath as its own writable root.

**Data flow**: Creates canonical docs/docs-public paths under a temp cwd, builds a policy with project-root write, docs read, and docs/public write, then compares normalized writable roots against the expected root-plus-carveout and nested writable-root structure.

**Call relations**: Tests precedence and decomposition of overlapping filesystem permission entries.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_path_against_base); 5 external calls (new, assert!, assert_eq!, canonicalize_preserving_symlinks, vec!).


##### `tests::file_system_policy_rejects_legacy_bridge_for_non_workspace_writes`  (lines 4756–4783)

```
fn file_system_policy_rejects_legacy_bridge_for_non_workspace_writes()
```

**Purpose**: Ensures that converting a split filesystem policy with writes outside the workspace root back into a legacy sandbox policy fails rather than silently widening permissions.

**Data flow**: Builds a restricted policy granting write access to an external path (`/tmp` or `C:\temp`) and calls `to_legacy_sandbox_policy(...)` → asserts the returned error message mentions writes outside the workspace root.

**Call relations**: Protects the lossy compatibility bridge from misrepresenting broader filesystem permissions.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert!, cfg!, vec!).


##### `tests::legacy_sandbox_policy_semantics_survive_split_bridge`  (lines 4786–4822)

```
fn legacy_sandbox_policy_semantics_survive_split_bridge()
```

**Purpose**: Checks that converting legacy sandbox policies to split filesystem/network policies and back preserves effective semantics.

**Data flow**: Builds an array of representative legacy policies, converts each through `FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd(...).to_legacy_sandbox_policy(...)`, and uses `assert_same_sandbox_policy_semantics` to compare original and reconstructed policies.

**Call relations**: Validates the round-trip compatibility bridge between old and new permission models.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_for_cwd, from, resolve_path_against_base); 3 external calls (new, assert_same_sandbox_policy_semantics, vec!).


##### `tests::item_started_event_from_web_search_emits_begin_event`  (lines 4825–4846)

```
fn item_started_event_from_web_search_emits_begin_event()
```

**Purpose**: Verifies that a `TurnItem::WebSearch` start event produces the expected legacy `WebSearchBegin` event.

**Data flow**: Constructs an `ItemStartedEvent` containing a `WebSearchItem`, calls `as_legacy_events(false)`, asserts one event is returned, and pattern-matches it to confirm the `call_id`.

**Call relations**: Tests one branch of `ItemStartedEvent::as_legacy_events`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, WebSearch, panic!).


##### `tests::item_started_event_from_non_web_search_emits_no_legacy_events`  (lines 4849–4862)

```
fn item_started_event_from_non_web_search_emits_no_legacy_events()
```

**Purpose**: Verifies that item types without legacy equivalents produce no legacy events on start.

**Data flow**: Constructs an `ItemStartedEvent` containing a `UserMessage` item, calls `as_legacy_events(false)`, and asserts the result is empty.

**Call relations**: Tests the default/empty branch of start-event legacy projection.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert!, UserMessage).


##### `tests::item_started_event_from_image_generation_emits_begin_event`  (lines 4865–4885)

```
fn item_started_event_from_image_generation_emits_begin_event()
```

**Purpose**: Verifies that an image-generation item start maps to `ImageGenerationBegin`.

**Data flow**: Constructs an `ItemStartedEvent` with `TurnItem::ImageGeneration`, calls `as_legacy_events(false)`, and asserts the single returned event is `ImageGenerationBegin` with the expected `call_id`.

**Call relations**: Tests another branch of `ItemStartedEvent::as_legacy_events`.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, ImageGeneration, panic!).


##### `tests::item_started_event_from_file_change_emits_patch_begin_event`  (lines 4888–4921)

```
fn item_started_event_from_file_change_emits_patch_begin_event()
```

**Purpose**: Verifies that a file-change item start maps to `PatchApplyBegin` with turn ID, auto-approval flag, and changes preserved.

**Data flow**: Constructs an `ItemStartedEvent` containing a `FileChangeItem`, calls `as_legacy_events(false)`, and asserts the returned `PatchApplyBegin` event contains the expected fields.

**Call relations**: Tests the file-change branch of start-event legacy projection.

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert!, assert_eq!, FileChange, panic!).


##### `tests::item_started_event_from_mcp_tool_call_emits_begin_event`  (lines 4924–4958)

```
fn item_started_event_from_mcp_tool_call_emits_begin_event()
```

**Purpose**: Verifies that an MCP tool-call item start maps to `McpToolCallBegin` with invocation metadata preserved.

**Data flow**: Constructs an `ItemStartedEvent` containing an `McpToolCallItem`, calls `as_legacy_events(false)`, and asserts the returned begin event contains server, tool, app resource URI, and plugin ID.

**Call relations**: Tests the MCP branch of start-event legacy projection.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, McpToolCall, json!, panic!).


##### `tests::item_completed_event_from_image_generation_emits_end_event`  (lines 4961–4990)

```
fn item_completed_event_from_image_generation_emits_end_event()
```

**Purpose**: Verifies that an image-generation item completion maps to `ImageGenerationEnd` with status, revised prompt, result, and saved path preserved.

**Data flow**: Constructs an `ItemCompletedEvent` containing a completed `ImageGenerationItem`, calls `as_legacy_events(false)`, and asserts the returned end event fields.

**Call relations**: Tests one branch of `ItemCompletedEvent::as_legacy_events`.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, ImageGeneration, test_path_buf, panic!).


##### `tests::item_completed_event_from_file_change_emits_patch_end_event`  (lines 4993–5028)

```
fn item_completed_event_from_file_change_emits_patch_end_event()
```

**Purpose**: Verifies that a file-change item completion maps to `PatchApplyEnd` with stdout, success, status, and changes preserved.

**Data flow**: Constructs an `ItemCompletedEvent` containing a completed `FileChangeItem`, calls `as_legacy_events(false)`, and asserts the returned patch-end event fields.

**Call relations**: Tests the file-change completion branch of legacy projection.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, new, assert!, assert_eq!, FileChange, panic!).


##### `tests::item_completed_event_from_mcp_tool_call_emits_end_event`  (lines 5031–5072)

```
fn item_completed_event_from_mcp_tool_call_emits_end_event()
```

**Purpose**: Verifies that an MCP tool-call item completion maps to `McpToolCallEnd` and that success classification works for a non-error result.

**Data flow**: Constructs an `ItemCompletedEvent` containing a completed `McpToolCallItem` with a `CallToolResult`, calls `as_legacy_events(false)`, and asserts the returned end event fields and `is_success()` result.

**Call relations**: Tests the MCP completion branch and `McpToolCallEndEvent::is_success`.

*Call graph*: calls 1 internal fn (new); 7 external calls (from_millis, assert!, assert_eq!, McpToolCall, json!, panic!, vec!).


##### `tests::item_started_event_requires_started_at_ms`  (lines 5075–5086)

```
fn item_started_event_requires_started_at_ms()
```

**Purpose**: Verifies that `ItemStartedEvent` deserialization fails if the required `started_at_ms` field is missing.

**Data flow**: Serializes an `ItemStartedEvent` to JSON, removes `started_at_ms`, attempts deserialization, and asserts it errors.

**Call relations**: Protects the stricter event contract for item-start timestamps.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, UserMessage, to_value).


##### `tests::item_completed_event_defaults_missing_completed_at_ms`  (lines 5089–5101)

```
fn item_completed_event_defaults_missing_completed_at_ms()
```

**Purpose**: Verifies that `ItemCompletedEvent` deserialization defaults missing `completed_at_ms` to zero for backward compatibility.

**Data flow**: Serializes an `ItemCompletedEvent`, removes `completed_at_ms`, deserializes it back, and asserts the field equals `0`.

**Call relations**: Tests the serde default hook `default_item_completed_at_ms`.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, UserMessage, to_value).


##### `tests::rollback_failed_error_does_not_affect_turn_status`  (lines 5103–5109)

```
fn rollback_failed_error_does_not_affect_turn_status()
```

**Purpose**: Checks that `ThreadRollbackFailed` errors are classified as non-failing for turn status.

**Data flow**: Constructs an `ErrorEvent` with `codex_error_info: Some(ThreadRollbackFailed)` and asserts `affects_turn_status()` is false.

**Call relations**: Tests one non-failing branch of error classification.

*Call graph*: 1 external calls (assert!).


##### `tests::active_turn_not_steerable_error_does_not_affect_turn_status`  (lines 5112–5120)

```
fn active_turn_not_steerable_error_does_not_affect_turn_status()
```

**Purpose**: Checks that `ActiveTurnNotSteerable` errors are classified as non-failing for turn status.

**Data flow**: Constructs an `ErrorEvent` with `ActiveTurnNotSteerable { turn_kind: Review }` and asserts `affects_turn_status()` is false.

**Call relations**: Tests the other non-failing branch of error classification.

*Call graph*: 1 external calls (assert!).


##### `tests::generic_error_affects_turn_status`  (lines 5123–5129)

```
fn generic_error_affects_turn_status()
```

**Purpose**: Checks that generic structured errors still mark a turn as failed.

**Data flow**: Constructs an `ErrorEvent` with `codex_error_info: Some(Other)` and asserts `affects_turn_status()` is true.

**Call relations**: Tests the default failing branch of error classification.

*Call graph*: 1 external calls (assert!).


##### `tests::realtime_conversation_started_event_uses_realtime_session_id`  (lines 5132–5145)

```
fn realtime_conversation_started_event_uses_realtime_session_id()
```

**Purpose**: Verifies the serialized field names for `RealtimeConversationStartedEvent`, especially `realtime_session_id` and version formatting.

**Data flow**: Constructs a started event with `realtime_session_id: Some("conv_1")` and `version: V2`, serializes to JSON, and asserts exact equality with the expected object.

**Call relations**: Protects the wire format for realtime conversation startup.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::realtime_voice_list_is_stable`  (lines 5148–5179)

```
fn realtime_voice_list_is_stable()
```

**Purpose**: Verifies that `RealtimeVoicesList::builtin()` returns the exact expected voice ordering and defaults.

**Data flow**: Calls `RealtimeVoicesList::builtin()` and compares the result against a literal `RealtimeVoicesList` value.

**Call relations**: Guards the canonical built-in voice catalog against accidental reordering or drift.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::user_input_text_serializes_empty_text_elements`  (lines 5182–5199)

```
fn user_input_text_serializes_empty_text_elements() -> Result<()>
```

**Purpose**: Verifies that `UserInput::Text` serializes an empty `text_elements` vector explicitly.

**Data flow**: Constructs `UserInput::Text { text: "hello", text_elements: Vec::new() }`, serializes to JSON, and asserts the output includes `"text_elements": []`.

**Call relations**: Protects the wire shape for rich-text user input even when no elements are present.

*Call graph*: 3 external calls (new, assert_eq!, to_value).


##### `tests::user_message_event_serializes_empty_metadata_vectors`  (lines 5202–5223)

```
fn user_message_event_serializes_empty_metadata_vectors() -> Result<()>
```

**Purpose**: Verifies that `UserMessageEvent` serializes empty `local_images` and `text_elements` vectors explicitly while omitting absent optional fields.

**Data flow**: Constructs a mostly-default `UserMessageEvent`, serializes it, and asserts the JSON contains `message`, `local_images: []`, and `text_elements: []`.

**Call relations**: Tests serialization defaults for legacy user-message events.

*Call graph*: 4 external calls (default, new, assert_eq!, to_value).


##### `tests::user_message_event_deserializes_without_image_detail_fields`  (lines 5226–5245)

```
fn user_message_event_deserializes_without_image_detail_fields() -> Result<()>
```

**Purpose**: Verifies backward-compatible deserialization of `UserMessageEvent` when image-detail arrays are absent.

**Data flow**: Deserializes a JSON object containing `message`, `images`, `local_images`, and `text_elements` but no detail arrays → asserts the detail vectors default to empty and other fields deserialize correctly.

**Call relations**: Protects compatibility with older persisted user-message events.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::user_message_item_legacy_event_preserves_image_details`  (lines 5248–5281)

```
fn user_message_item_legacy_event_preserves_image_details()
```

**Purpose**: Checks that converting a `UserMessageItem` to its legacy event preserves remote/local image lists, detail hints, and client ID.

**Data flow**: Builds a `UserMessageItem` from mixed `UserInput::Image` and `UserInput::LocalImage` values, sets `client_id`, converts via `as_legacy_event()`, pattern-matches `EventMsg::UserMessage`, and asserts all image/detail fields.

**Call relations**: Tests legacy projection for user-message items.

*Call graph*: calls 1 internal fn (new); 3 external calls (from, assert_eq!, panic!).


##### `tests::turn_aborted_event_deserializes_without_turn_id`  (lines 5284–5301)

```
fn turn_aborted_event_deserializes_without_turn_id() -> Result<()>
```

**Purpose**: Verifies that `TurnAbortedEvent` can deserialize old payloads that omit `turn_id`.

**Data flow**: Deserializes an `EventMsg` JSON object of type `turn_aborted` containing only `reason`, pattern-matches the result, and asserts `turn_id` is `None` and the reason is preserved.

**Call relations**: Protects backward compatibility for abort events.

*Call graph*: 4 external calls (assert_eq!, json!, panic!, from_value).


##### `tests::turn_context_item_deserializes_without_network`  (lines 5304–5317)

```
fn turn_context_item_deserializes_without_network() -> Result<()>
```

**Purpose**: Verifies that `TurnContextItem` deserializes correctly when newer optional fields like `network`, `file_system_sandbox_policy`, and `comp_hash` are absent.

**Data flow**: Deserializes a minimal JSON turn-context object and asserts those optional fields are `None`.

**Call relations**: Tests backward-compatible decoding of persisted turn context.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::multi_agent_version_uses_newest_present_session_meta_value`  (lines 5320–5350)

```
fn multi_agent_version_uses_newest_present_session_meta_value() -> Result<()>
```

**Purpose**: Checks that multi-agent version lookup prefers the newest session metadata entry that actually contains a version, even if a later metadata entry omits it.

**Data flow**: Builds two `SessionMetaLine` rollout items for the same thread, one older with `V2` and one newer with `None`, calls `multi_agent_version_from_items(...)`, and asserts the result is `Some(V2)`.

**Call relations**: Tests the reverse-scan fallback semantics in multi-agent version reconstruction.

*Call graph*: calls 1 internal fn (from_string); 2 external calls (default, assert_eq!).


##### `tests::turn_context_item_serializes_network_when_present`  (lines 5353–5408)

```
fn turn_context_item_serializes_network_when_present() -> Result<()>
```

**Purpose**: Verifies that `TurnContextItem` serializes optional `network`, `file_system_sandbox_policy`, and compatibility `summary` fields in the expected JSON shape.

**Data flow**: Constructs a `TurnContextItem` with populated network and filesystem policy fields, serializes it, and asserts the corresponding JSON subobjects and `summary` value.

**Call relations**: Protects the persisted/wire format for enriched turn-context records.

*Call graph*: calls 1 internal fn (restricted); 4 external calls (assert_eq!, test_path_buf, to_value, vec!).


##### `tests::serialize_event`  (lines 5413–5460)

```
fn serialize_event() -> Result<()>
```

**Purpose**: Verifies the JSON nesting and field layout of a top-level `Event` containing `EventMsg::SessionConfigured`.

**Data flow**: Constructs session and thread IDs, a temp rollout path, a `SessionConfiguredEvent`, wraps it in `Event`, serializes to JSON, and compares against an expected literal object.

**Call relations**: Tests the outer event envelope and tagged-enum serialization.

*Call graph*: calls 3 internal fn (read_only, from_string, from_string); 6 external calls (new, default, assert_eq!, test_path_buf, json!, SessionConfigured).


##### `tests::deserialize_legacy_session_configured_event_uses_sandbox_policy`  (lines 5463–5480)

```
fn deserialize_legacy_session_configured_event_uses_sandbox_policy() -> Result<()>
```

**Purpose**: Verifies that legacy `SessionConfiguredEvent` payloads containing only `sandbox_policy` deserialize successfully and are normalized into the correct `permission_profile`.

**Data flow**: Builds a JSON object with `sandbox_policy` but no `permission_profile`, deserializes it into `SessionConfiguredEvent`, and asserts the resulting profile is `PermissionProfile::read_only()`.

**Call relations**: Directly tests the custom deserializer’s backward-compatibility bridge.

*Call graph*: 4 external calls (assert_eq!, test_path_buf, json!, from_value).


##### `tests::vec_u8_as_base64_serialization_and_deserialization`  (lines 5483–5498)

```
fn vec_u8_as_base64_serialization_and_deserialization() -> Result<()>
```

**Purpose**: Verifies that `ExecCommandOutputDeltaEvent.chunk` is serialized as base64 text and round-trips correctly.

**Data flow**: Constructs an event with raw bytes `[1,2,3,4,5]`, serializes to a JSON string and asserts the base64 payload `AQIDBAU=`, then deserializes and asserts equality with the original event.

**Call relations**: Tests the `serde_with::base64` annotation on command-output deltas.

*Call graph*: 4 external calls (assert_eq!, from_str, to_string, vec!).


##### `tests::serialize_mcp_startup_update_event`  (lines 5501–5518)

```
fn serialize_mcp_startup_update_event() -> Result<()>
```

**Purpose**: Verifies the tagged JSON shape of `McpStartupUpdateEvent`, especially the nested `status.state` representation.

**Data flow**: Constructs an `Event` containing `EventMsg::McpStartupUpdate` with a failed status, serializes to JSON, and asserts the `type`, `server`, `status.state`, and `status.error` fields.

**Call relations**: Protects the wire format for MCP startup progress events.

*Call graph*: 3 external calls (assert_eq!, McpStartupUpdate, to_value).


##### `tests::serialize_mcp_startup_complete_event`  (lines 5521–5541)

```
fn serialize_mcp_startup_complete_event() -> Result<()>
```

**Purpose**: Verifies the JSON shape of `McpStartupCompleteEvent` with ready, failed, and cancelled server lists.

**Data flow**: Constructs an `Event` containing `EventMsg::McpStartupComplete`, serializes it, and asserts the expected array contents in the JSON output.

**Call relations**: Protects the aggregate MCP startup completion payload format.

*Call graph*: 4 external calls (assert_eq!, McpStartupComplete, to_value, vec!).


##### `tests::token_usage_info_new_or_append_updates_context_window_when_provided`  (lines 5544–5562)

```
fn token_usage_info_new_or_append_updates_context_window_when_provided()
```

**Purpose**: Checks that `TokenUsageInfo::new_or_append` overwrites the stored context-window size when a new one is supplied.

**Data flow**: Creates an initial `TokenUsageInfo` with one context window and a `last` usage sample, calls `new_or_append(..., Some(128_000))`, and asserts the returned `model_context_window` is updated.

**Call relations**: Tests one branch of token-usage merge semantics.

*Call graph*: calls 1 internal fn (new_or_append); 2 external calls (assert_eq!, default).


##### `tests::token_usage_info_new_or_append_preserves_context_window_when_not_provided`  (lines 5565–5584)

```
fn token_usage_info_new_or_append_preserves_context_window_when_not_provided()
```

**Purpose**: Checks that `TokenUsageInfo::new_or_append` preserves the existing context-window size when no replacement value is supplied.

**Data flow**: Creates an initial `TokenUsageInfo` and a `last` usage sample, calls `new_or_append(..., None)`, and asserts the original `model_context_window` remains unchanged.

**Call relations**: Tests the other branch of token-usage merge semantics.

*Call graph*: calls 1 internal fn (new_or_append); 2 external calls (assert_eq!, default).


### Plugin and tool contracts
These files define shared plugin identifiers, manifests, discovery metadata, and normalized tool definitions used across loading, marketplace, and client-facing tool exposure.

### `plugin/src/plugin_id.rs`

`domain_logic` · `config parsing, plugin selection, cache/telemetry identity handling`

This file encapsulates the rules for plugin identity. `PluginId` stores two validated segments: `plugin_name` and `marketplace_name`. The validation policy is intentionally narrow and filesystem-safe: each segment must be non-empty and contain only ASCII alphanumerics, `_`, or `-`. Those rules are enforced centrally by `validate_plugin_segment`, which returns a plain `String` error message so callers can wrap or contextualize it.

`PluginId::new` validates both segments independently and returns a typed `PluginIdError::Invalid` on failure. `PluginId::parse` handles the serialized key form used throughout the system. It splits on the last `@` with `rsplit_once`, rejects missing separators and empty sides with a specific `<plugin>@<marketplace>` expectation message, then delegates to `new`. If segment validation fails, it rewrites the message to include the original full key, which is useful when malformed IDs come from config, cache entries, or external APIs. `as_key` performs the inverse serialization by joining the two validated segments with `@`.

The design keeps parsing and validation deterministic and side-effect free, making this module safe to use in low-level paths such as cache naming, telemetry metadata derivation, plugin selection parsing, and uninstall/install workflows.

#### Function details

##### `PluginId::new`  (lines 16–24)

```
fn new(plugin_name: String, marketplace_name: String) -> Result<Self, PluginIdError>
```

**Purpose**: Constructs a `PluginId` from already-separated plugin and marketplace names after validating both segments. It is the structured entry point used when callers already know the two components.

**Data flow**: It takes owned `String` values for `plugin_name` and `marketplace_name`, validates each with `validate_plugin_segment`, maps any validation failure into `PluginIdError::Invalid`, and on success returns `Ok(PluginId { plugin_name, marketplace_name })`.

**Call relations**: Many cache, marketplace, and selection paths call this when they derive the two segments independently. `PluginId::parse` also delegates here so all segment validation logic stays centralized.

*Call graph*: calls 1 internal fn (validate_plugin_segment); called by 36 (parse_plugin_selection, refresh_curated_plugin_cache, refresh_non_curated_plugin_cache_with_mode, read_plugin_detail_for_marketplace_plugin, refresh_curated_plugin_cache_leaves_api_curated_plugin_when_api_manifest_missing, refresh_curated_plugin_cache_migrates_full_sha_cache_version_to_short_version, refresh_curated_plugin_cache_reinstalls_missing_api_curated_plugin, refresh_curated_plugin_cache_reinstalls_missing_configured_plugin_with_current_short_version, refresh_curated_plugin_cache_removes_cache_for_plugin_removed_from_marketplace, refresh_curated_plugin_cache_replaces_existing_local_version_with_short_sha_version (+15 more)).


##### `PluginId::parse`  (lines 26–43)

```
fn parse(plugin_key: &str) -> Result<Self, PluginIdError>
```

**Purpose**: Parses a serialized plugin key of the form `<plugin>@<marketplace>` into a validated `PluginId`. It also enriches validation errors with the original key text for easier diagnostics.

**Data flow**: It accepts `&str plugin_key`, splits it with `rsplit_once('@')`, rejects missing separators or empty halves with a formatted `PluginIdError::Invalid`, then allocates owned strings for both halves and calls `Self::new`. If `new` returns an invalid-segment error, it rewrites that message to append `in `<plugin_key>`` before returning it.

**Call relations**: This is the main parsing path used across plugin loading, telemetry, uninstall flows, and marketplace-related code whenever a plugin key arrives as text. It delegates structural validation to `new` after handling the serialized format.

*Call graph*: called by 19 (sample_plugin_metadata, extract_plugin_migration_details, emit_plugin_toggle_events, plugin_uninstall_response, parse_plugin_selection, is_tool_suggest_fallback_plugin, installed_plugin_name_for_marketplace, load_plugin, merge_configured_plugins_with_remote_installed, plugin_id (+9 more)); 3 external calls (new, format!, Invalid).


##### `PluginId::as_key`  (lines 45–47)

```
fn as_key(&self) -> String
```

**Purpose**: Serializes a validated `PluginId` back into the canonical `<plugin>@<marketplace>` string form. It is the inverse of `parse` for already-validated IDs.

**Data flow**: It reads `self.plugin_name` and `self.marketplace_name`, formats them with `@` between them, and returns the resulting `String`.

**Call relations**: Telemetry and uninstall-related code call this when they need the stable textual key for reporting, lookup, or path derivation.

*Call graph*: called by 3 (from_plugin_id, plugin_telemetry_metadata_from_root, uninstall_plugin_id); 1 external calls (format!).


##### `validate_plugin_segment`  (lines 51–64)

```
fn validate_plugin_segment(segment: &str, kind: &str) -> Result<(), String>
```

**Purpose**: Checks one plugin-ID segment against the crate’s allowed character set and non-empty requirement. It is the low-level validator shared by all plugin-ID construction paths.

**Data flow**: It takes a borrowed `segment` and a descriptive `kind` label, returns an error string if the segment is empty or if any character is not ASCII alphanumeric, `-`, or `_`, and otherwise returns `Ok(())`.

**Call relations**: Only `PluginId::new` calls this directly, making `new` the single structured constructor while this helper encapsulates the exact validation rule and error wording.

*Call graph*: called by 1 (new); 1 external calls (format!).


### `plugin/src/manifest.rs`

`data_model` · `manifest parsing and plugin resolution`

This file is almost entirely data model, but it contains one important transformation routine. `PluginManifest<Resource>` is generic over how referenced resources are represented, allowing the same manifest shape to be used first with absolute filesystem paths and later with authority-bound locators. Its fields cover package metadata (`name`, `version`, `description`, `keywords`), component paths (`skills`, `mcp_servers`, `apps`, `hooks`), and optional UI/model-facing interface metadata. `PluginManifestHooks<Resource>` distinguishes hook declarations that are path-based from hooks embedded inline as parsed `HooksFile` values.

`PluginManifestInterface<Resource>` holds optional presentation metadata such as display names, descriptions, developer/category labels, capability strings, URLs, prompt defaults, branding assets, and screenshots. Its `Default` implementation intentionally initializes every optional field to `None` and every collection to empty, making partial construction ergonomic in tests and callers.

`PluginManifest::display_name` trims and validates the interface display name before using it, falling back to the manifest `name` if the interface field is absent or blank. `try_map_resources` is the key behavioral method: it consumes the manifest, applies a caller-supplied fallible mapping function to every resource-bearing field across paths, hook path lists, and interface assets, preserves inline hooks unchanged, and short-circuits on the first mapping error. This is how provider code converts plain absolute paths into environment-scoped resource locators while preserving all non-resource metadata verbatim.

#### Function details

##### `PluginManifestInterface::default`  (lines 53–70)

```
fn default() -> Self
```

**Purpose**: Creates an empty interface metadata block with no optional values and no listed capabilities or screenshots. It is the baseline initializer for callers that only want to set a few interface fields.

**Data flow**: It constructs and returns `PluginManifestInterface<Resource>` with every `Option` field set to `None`, `capabilities` as an empty `Vec`, and `screenshots` as an empty `Vec`. No inputs or external state are involved.

**Call relations**: Tests use this default when constructing manifests that only populate selected asset fields. It keeps fixture setup concise while preserving the full interface shape.

*Call graph*: called by 1 (environment_descriptor_binds_every_manifest_resource); 1 external calls (new).


##### `PluginManifest::display_name`  (lines 75–82)

```
fn display_name(&self) -> &str
```

**Purpose**: Returns the preferred human-facing package name from the manifest. It uses the interface display name only when that field exists and is non-empty after trimming.

**Data flow**: It reads `self.interface`, then `interface.display_name`, converts to `&str`, trims whitespace, filters out empty strings, and returns the surviving display name or falls back to `&self.name`. It returns a borrowed string slice without allocating.

**Call relations**: Consumers call this when they need a stable display label independent of whether branding metadata was supplied. The trimming/filtering avoids exposing whitespace-only interface names.


##### `PluginManifest::try_map_resources`  (lines 84–166)

```
fn try_map_resources(
        self,
        mut map: impl FnMut(Resource) -> Result<Mapped, Error>,
    ) -> Result<PluginManifest<Mapped>, Error>
```

**Purpose**: Transforms every resource reference inside a manifest from one representation to another using a fallible mapping closure. It preserves all non-resource metadata and inline hook bodies unchanged.

**Data flow**: It consumes `self` and a mutable mapper `FnMut(Resource) -> Result<Mapped, Error>`. The method destructures the manifest, separately rewrites `paths.skills`, `paths.mcp_servers`, `paths.apps`, hook path vectors inside `PluginManifestHooks::Paths`, and interface asset fields (`composer_icon`, `logo`, `screenshots`) by applying `map`; `PluginManifestHooks::Inline` is passed through untouched. Any mapping failure returns `Err(Error)` immediately; otherwise it reconstructs and returns a `PluginManifest<Mapped>` with all transformed resource fields.

**Call relations**: Provider code invokes this during resolved-plugin construction to bind manifest resources to an authority-aware locator type. It delegates the actual conversion policy to the supplied closure so the manifest layer stays generic and reusable.

*Call graph*: called by 1 (from_environment); 2 external calls (Inline, Paths).


### `plugin/src/lib.rs`

`data_model` · `cross-cutting`

This crate root is the aggregation point for plugin-related data structures that are reused across loading, capability reporting, and telemetry. It publicly exposes helper APIs from internal modules (`load_outcome`, `manifest`, `plugin_id`, `provider`) and from `codex_utils_plugins`, while locally defining a few small but important records. `AppConnectorId` wraps a `String` to distinguish connector identifiers from arbitrary text, and `AppDeclaration` captures an app’s declared name, connector, and optional category. The helper `app_connector_ids_from_declarations` preserves first-seen order while deduplicating connector IDs with a `HashSet`, so downstream capability summaries and effective app lists remain stable and do not repeat connectors when multiple app declarations point at the same backend.

`PluginCapabilitySummary` is the compact, model-facing summary of what an active plugin contributes: config/display names, a prompt-safe description, whether it exposes skills, MCP server names, and app connector IDs. `PluginHookSource` records the provenance of hook definitions, including plugin identity, plugin roots, the source file path and relative path, and parsed `HookEventsToml`. `PluginTelemetryMetadata` packages a `PluginId`, optional remote-plugin identifier, and optional capability summary for analytics. Its constructors intentionally default optional telemetry fields to `None`; richer metadata is only attached when a valid plugin ID can be derived from a capability summary’s `config_name`.

#### Function details

##### `app_connector_ids_from_declarations`  (lines 38–49)

```
fn app_connector_ids_from_declarations(
    app_declarations: impl IntoIterator<Item = &'a AppDeclaration>,
) -> Vec<AppConnectorId>
```

**Purpose**: Collects unique `AppConnectorId` values from a sequence of `AppDeclaration` references while preserving the order of first appearance. It is the crate-level normalization step used anywhere plugin app declarations need to become a deduplicated connector list.

**Data flow**: It accepts any iterator of `&AppDeclaration`. For each declaration, it reads `app.connector_id`, checks membership in a local `HashSet<&AppConnectorId>`, and when first seen clones that connector ID into an output `Vec<AppConnectorId>`. It returns the ordered deduplicated vector and does not mutate external state.

**Call relations**: This helper is used by plugin loading code when building capability summaries and effective app lists. Those callers rely on it specifically to collapse duplicate app declarations across one plugin or many plugins without losing the precedence implied by iteration order.

*Call graph*: 2 external calls (new, new).


##### `PluginTelemetryMetadata::from_plugin_id`  (lines 81–87)

```
fn from_plugin_id(plugin_id: &PluginId) -> Self
```

**Purpose**: Builds the minimal telemetry record for a known plugin identifier. It is the fallback constructor used when the system knows the plugin ID but has no capability summary or remote ID to attach.

**Data flow**: It takes `&PluginId`, clones it into the returned `PluginTelemetryMetadata`, and sets `remote_plugin_id` and `capability_summary` to `None`. No global state is read or written.

**Call relations**: Telemetry-producing code calls this when it has already resolved a `PluginId` from installation state or a plugin root and wants a baseline metadata object. It does not delegate further beyond cloning the identifier, making it the simplest path in telemetry assembly.

*Call graph*: called by 2 (installed_plugin_telemetry_metadata, plugin_telemetry_metadata_from_root); 1 external calls (clone).


##### `PluginCapabilitySummary::telemetry_metadata`  (lines 91–99)

```
fn telemetry_metadata(&self) -> Option<PluginTelemetryMetadata>
```

**Purpose**: Attempts to convert a capability summary back into telemetry metadata by parsing the summary’s `config_name` as a stable `PluginId`. It only succeeds for summaries whose config name follows the `<plugin>@<marketplace>` format.

**Data flow**: It reads `self.config_name`, passes it to `PluginId::parse`, and on success constructs a `PluginTelemetryMetadata` containing the parsed ID, `remote_plugin_id: None`, and a cloned copy of the summary in `capability_summary`. If parsing fails, it returns `None`.

**Call relations**: This method is the richer telemetry path for code that starts from capability summaries rather than installation metadata. Its only delegated work is plugin-ID parsing; the optional return value communicates whether the summary can be tied to a valid stable plugin identifier.

*Call graph*: calls 1 internal fn (parse).


### `tools/src/tool_definition.rs`

`data_model` · `tool parsing and adaptation`

This file introduces `ToolDefinition`, the internal representation that downstream code converts into API-specific tool specs. The struct carries a tool’s `name`, human-readable `description`, input `JsonSchema`, optional output `serde_json::Value` schema, and a boolean `defer_loading` marker. The design is intentionally minimal: parsing code elsewhere produces `ToolDefinition`, and adapter layers such as the Responses API conversion consume it. The two methods support the most common transformations needed during that adaptation. `renamed` is a builder-style mutator that replaces the tool name and returns the updated struct by value, which is useful when an MCP tool must be exposed under a namespaced or externally selected name without rebuilding the rest of the definition. `into_deferred` converts a fully described tool into a deferred-loading variant by clearing `output_schema` and setting `defer_loading` to `true`; this encodes the invariant that deferred tools should not advertise an output schema up front. Because both methods take ownership of `self` and return `Self`, they compose naturally in fluent conversion pipelines.

#### Function details

##### `ToolDefinition::renamed`  (lines 16–19)

```
fn renamed(mut self, name: String) -> Self
```

**Purpose**: Returns a copy of the tool definition with only its `name` field replaced. It is a builder-style convenience for adapting parsed tools to externally chosen names.

**Data flow**: Consumes `self` mutably and a new `name: String`, assigns the new string into `self.name`, and returns the modified `ToolDefinition`. All other fields are preserved unchanged.

**Call relations**: This method is used in conversion pipelines such as the MCP-to-Responses-API adapters, where a parsed tool definition must be exposed under `ToolName.name`. It performs a narrow transformation before later serialization-oriented mapping.


##### `ToolDefinition::into_deferred`  (lines 21–25)

```
fn into_deferred(mut self) -> Self
```

**Purpose**: Transforms a tool definition into its deferred-loading form by removing output schema information and marking the definition as deferred. This encodes the contract expected by downstream deferred tool specs.

**Data flow**: Consumes `self` mutably, sets `self.output_schema = None`, sets `self.defer_loading = true`, and returns the updated `ToolDefinition`. Input schema, name, and description remain unchanged.

**Call relations**: This method is used by deferred conversion paths such as `mcp_tool_to_deferred_responses_api_tool`. It is typically chained after parsing and optional renaming, before the final API-specific struct is built.


### `tools/src/tool_discovery.rs`

`data_model` · `request handling`

This file exists so the rest of the system can talk about two different kinds of installable things — app connectors and plugins — in one consistent way. Without it, each caller would need separate logic for each kind, and the install UI and related tools would be harder to build and easier to get wrong.

At the center is `DiscoverableTool`, an enum (a value that can be one of several named variants) that wraps either an `AppInfo` connector or a `DiscoverablePluginInfo` plugin. The helper methods on it answer basic questions like "what kind is this?", "what is its id?", and "does it have an install URL?". That lets higher-level code treat both kinds like items on the same shelf.

The file also defines a few small data types used when presenting install choices. `RequestPluginInstallEntry` is a flattened, client-friendly version of a tool: just the fields a UI or API response needs. `ListAvailablePluginsToInstallResult` wraps a whole list of those entries.

One important rule lives here: if the requesting client is the text-based TUI client, plugin entries are filtered out for the request-plugin-install flow, leaving only connectors. In other words, this file is both the shared vocabulary and the policy checkpoint for tool discovery data before it is shown to users.

#### Function details

##### `DiscoverableTool::tool_type`  (lines 38–43)

```
fn tool_type(&self) -> DiscoverableToolType
```

**Purpose**: Returns whether a discoverable item is a connector or a plugin. This gives calling code a simple label it can use when building messages, UI rows, or install metadata.

**Data flow**: It takes one `DiscoverableTool` value as input. It looks at which variant is inside — connector or plugin — and turns that into the matching `DiscoverableToolType` enum value. It returns that type label without changing the original tool.

**Call relations**: This is a small helper used wherever code needs to treat mixed tool lists consistently. It sits close to the data model so higher-level flows do not need to repeat "if connector do this, if plugin do that" just to learn the category.


##### `DiscoverableTool::id`  (lines 45–50)

```
fn id(&self) -> &str
```

**Purpose**: Returns the stable identifier for a discoverable tool, regardless of whether it is a connector or a plugin. Callers use this when they need a machine-readable key rather than a display name.

**Data flow**: It receives a `DiscoverableTool`, reads the wrapped connector or plugin record, and pulls out its `id` field. It returns that id as text and does not modify anything.

**Call relations**: The call graph shows `build_request_plugin_install_meta` asking this method for the tool's id while preparing install-related metadata. This method gives that builder one common doorway for both connectors and plugins.

*Call graph*: called by 1 (build_request_plugin_install_meta).


##### `DiscoverableTool::name`  (lines 52–57)

```
fn name(&self) -> &str
```

**Purpose**: Returns the human-facing name of a discoverable tool. This is what other parts of the system use when they need a friendly label to show users.

**Data flow**: It takes a `DiscoverableTool`, checks which variant it contains, reads that item's `name` field, and returns it as text. Nothing is changed; it is a read-only lookup.

**Call relations**: The graph shows `build_request_plugin_install_meta` calling this when assembling metadata for an install request. In that larger flow, this method supplies the display name alongside the id and other properties.

*Call graph*: called by 1 (build_request_plugin_install_meta).


##### `DiscoverableTool::install_url`  (lines 59–64)

```
fn install_url(&self) -> Option<&str>
```

**Purpose**: Returns a web link for installing a connector when one exists. For plugins, it deliberately returns nothing because plugin install information is represented differently in this model.

**Data flow**: It receives a `DiscoverableTool`. If the tool is a connector, it reads the connector's optional `install_url` and passes that through; if the tool is a plugin, it returns `None`, meaning "no URL available". The tool itself is not changed.

**Call relations**: According to the call graph, `build_request_plugin_install_meta` uses this when preparing install metadata. This method acts like a safe adapter: callers can ask every tool for an install URL and get either a real link or a clear "not applicable" answer.

*Call graph*: called by 1 (build_request_plugin_install_meta).


##### `DiscoverableTool::from`  (lines 74–76)

```
fn from(value: DiscoverablePluginInfo) -> Self
```

**Purpose**: Creates a `DiscoverableTool` from a more specific source type so callers can easily place connectors or plugins into one mixed collection. It is mainly there to make surrounding code cleaner and more uniform.

**Data flow**: It takes either an `AppInfo` or a `DiscoverablePluginInfo` value as input, wraps it in the matching `DiscoverableTool` variant, and boxes it (stores it indirectly on the heap) for the enum. The result is one unified `DiscoverableTool` value.

**Call relations**: This conversion is used before later steps such as filtering or list-building can treat different tool kinds together. It is an early normalization step: first make everything a `DiscoverableTool`, then the rest of the flow can use the shared helper methods.

*Call graph*: 3 external calls (new, Connector, Plugin).


##### `filter_request_plugin_install_discoverable_tools_for_client`  (lines 79–91)

```
fn filter_request_plugin_install_discoverable_tools_for_client(
    discoverable_tools: Vec<DiscoverableTool>,
    app_server_client_name: Option<&str>,
) -> Vec<DiscoverableTool>
```

**Purpose**: Applies a client-specific rule to the installable tool list. In plain terms: if the caller is the text UI client, remove plugin entries from this particular flow; otherwise, leave the list unchanged.

**Data flow**: It takes a whole list of discoverable tools plus the optional name of the requesting client. If that client name is not `codex-tui`, it returns the original list untouched. If it is `codex-tui`, it walks through the list, keeps only non-plugin items, and returns the reduced list.

**Call relations**: This function fits between raw discovery and the response sent to a specific client. It is a policy gate: upstream code gathers possible tools, this function tailors them to the client, and later code can safely build install choices from that filtered set.


##### `collect_request_plugin_install_entries`  (lines 120–146)

```
fn collect_request_plugin_install_entries(
    discoverable_tools: &[DiscoverableTool],
) -> Vec<RequestPluginInstallEntry>
```

**Purpose**: Turns the richer internal tool records into a simple, serializable list of entries ready to send to a client. It is used when the system needs a clean install menu rather than the full internal objects.

**Data flow**: It takes a slice of `DiscoverableTool` items as input. For each one, it reads the fields that matter for install presentation — id, name, description, type, and plugin-specific capabilities like skills or server names — and builds a `RequestPluginInstallEntry`. It returns a new vector containing one flattened entry per input tool.

**Call relations**: This is the downstream step after discovery and any client-based filtering. Once another part of the system has decided which tools are eligible, this function repackages them into the simpler shape that API results such as the available-plugins-to-install response can use.

*Call graph*: 1 external calls (iter).


### `core/src/mention_syntax.rs`

`config` · `request handling`

This file exposes two constants from `codex_utils_plugins::mention_syntax`: `PLUGIN_TEXT_MENTION_SIGIL` and `TOOL_MENTION_SIGIL`. These values define the literal marker characters or strings that the rest of the system uses when parsing or generating explicit mentions of plugins and tools inside user/model text. By re-exporting them from codex-core, the crate ensures that mention parsing, prompt generation, and any UI or orchestration code can share one canonical syntax source without importing the lower-level utility crate directly. The module contains no parsing logic itself; its value is in preventing syntax drift and making the mention vocabulary part of the core crate's visible interface.


### Configuration and policy types
These files capture broadly reused configuration, execution-policy, network-proxy, and cloud-task contract types shared across subsystems.

### `cloud-tasks-client/src/api.rs`

`data_model` · `cross-cutting`

This file is the contract layer for the cloud tasks subsystem. It introduces the canonical domain types exchanged between callers and backend implementations: `TaskId`, `TaskStatus`, `TaskSummary`, `TaskListPage`, `DiffSummary`, `TaskText`, `TurnAttempt`, `ApplyOutcome`, `ApplyStatus`, and `CreatedTask`. Serialization is only attached where values cross HTTP or JSON boundaries; notably `TaskId` is transparent, `TaskStatus` uses kebab-case, and `ApplyStatus` uses lowercase. Error reporting is normalized through `CloudTaskError`, which distinguishes unimplemented operations, HTTP failures, local I/O failures, and generic messages.

The central abstraction is `CloudBackend`, a `Send + Sync` trait whose methods all return boxed, pinned futures via `CloudBackendFuture`. That keeps consumers object-safe while still allowing async implementations. The trait covers task listing, summary/detail retrieval, assistant text retrieval, sibling-attempt enumeration, dry-run and real patch application, and task creation with best-of-N support.

A subtle but important modeling choice is that `TaskText` and `TurnAttempt` carry attempt metadata (`turn_id`, sibling IDs, placement, status) alongside human-readable text and optional diffs. That lets higher layers build attempt-switching UIs without reinterpreting raw backend payloads. `AttemptStatus` defaults to `Unknown`, but concrete clients may map missing backend values differently.

#### Function details

##### `TaskText::default`  (lines 124–133)

```
fn default() -> Self
```

**Purpose**: Constructs an empty `TaskText` placeholder with no prompt, no messages, no turn identifiers, and an `AttemptStatus::Unknown` marker.

**Data flow**: It reads no external state and creates a fresh `TaskText` value with `prompt: None`, empty `messages` and `sibling_turn_ids`, `turn_id: None`, `attempt_placement: None`, and `attempt_status` set to `Unknown`. It returns that struct without side effects.

**Call relations**: This is the default constructor used wherever callers need a safe zero-value `TaskText`, especially before real backend detail data has been loaded. It does not delegate to backend logic; it only initializes the struct fields consistently.

*Call graph*: 1 external calls (new).


### `config/src/types.rs`

`data_model` · `cross-cutting`

This file is the main configuration type catalog. It re-exports many protocol and keymap types, then defines numerous serde/schemars-backed enums and structs for auth storage, Windows sandboxing, URI-based file openers, analytics, tool suggestion, memories, apps/connectors, OTEL exporters, notifications, TUI settings, notices, plugin MCP policy, marketplace metadata, sandbox write settings, and shell environment policy. Most items are intentionally passive data models with `Serialize`, `Deserialize`, `Default`, and `JsonSchema` derives.

The nontrivial behavior is concentrated in a few conversion/default implementations. `SessionPickerViewMode` and notification enums implement `Display` using stable lowercase/kebab-case strings. `AuthKeyringBackendKind::default` is platform-sensitive, preferring `Secrets` on Windows and `Direct` elsewhere. `UriBasedFileOpener::get_scheme` maps enum variants to URI schemes or `None` when disabled. `ToolSuggestDisabledTool` provides constructors for plugin/connector entries and a `normalized` method that trims ids and drops empty ones.

`MemoriesConfig::from(MemoriesToml)` is the largest adapter: it starts from `MemoriesConfig::default`, fills missing values from defaults, and clamps numeric settings into safe ranges such as 1..=4096 raw memories and 0..=100 remaining rate-limit percent. `OtelConfig::default` establishes exporter defaults (`metrics_exporter` defaults to `Statsig`). `PluginMcpServerConfig::default` enables plugin MCP servers with empty tool overrides. `From<SandboxWorkspaceWrite>` and `From<ShellEnvironmentPolicyToml>` convert persistence shapes into protocol/runtime types, notably compiling environment include/exclude regex patterns case-insensitively and defaulting shell env inheritance to `All`.

#### Function details

##### `default_enabled`  (lines 58–60)

```
fn default_enabled() -> bool
```

**Purpose**: Provides a serde-friendly default of `true` for config fields that are enabled unless explicitly disabled.

**Data flow**: Takes no input and returns the boolean literal `true`.

**Call relations**: Referenced by serde `default = "default_enabled"` attributes across multiple config structs; it is a tiny shared default helper.


##### `SessionPickerViewMode::as_str`  (lines 72–77)

```
fn as_str(self) -> &'static str
```

**Purpose**: Returns the stable config/display string for the session picker layout mode.

**Data flow**: Matches `self` on `Comfortable` or `Dense` → returns the corresponding static string literal.

**Call relations**: Used by the `fmt::Display` implementation to avoid duplicating the string mapping.

*Call graph*: called by 1 (fmt).


##### `SessionPickerViewMode::fmt`  (lines 81–83)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the session picker mode as its canonical lowercase string for user-facing output.

**Data flow**: Reads `self`, calls `self.as_str()`, and writes that string into the provided formatter with `write_str`.

**Call relations**: Invoked by standard formatting macros whenever this enum is displayed.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `AuthKeyringBackendKind::default`  (lines 127–133)

```
fn default() -> Self
```

**Purpose**: Chooses the default keyring storage strategy based on the target platform. Windows defaults to encrypted local secrets-file mode; other platforms default to direct OS keyring storage.

**Data flow**: Evaluates `cfg!(windows)` at compile time → returns `AuthKeyringBackendKind::Secrets` when true, otherwise `AuthKeyringBackendKind::Direct`.

**Call relations**: Used implicitly wherever `Default::default()` is derived or called for auth keyring backend settings throughout auth and remote-control flows.

*Call graph*: called by 92 (list_remote_control_clients_recovers_auth_after_unauthorized, list_remote_control_clients_retries_unauthorized_only_once, remote_control_handle_discards_pairing_response_after_auth_change, remote_control_handle_recovers_auth_before_refreshing_pairing, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_start_allows_missing_auth_when_enabled, remote_control_waits_for_account_id_before_enrolling, connect_remote_control_websocket_recovers_after_unauthorized_enrollment, connect_remote_control_websocket_recovers_after_unauthorized_refresh, connect_remote_control_websocket_requires_chatgpt_auth (+15 more)); 1 external calls (cfg!).


##### `UriBasedFileOpener::get_scheme`  (lines 172–180)

```
fn get_scheme(&self) -> Option<&str>
```

**Purpose**: Maps a configured URI-based editor opener to the URI scheme string used to launch files, or disables URI launching entirely.

**Data flow**: Matches `self` across `VsCode`, `VsCodeInsiders`, `Windsurf`, `Cursor`, and `None` → returns `Some(&str)` for the editor-specific scheme or `None` for disabled mode.

**Call relations**: Called by code that constructs editor-launch URIs from config-selected opener variants.


##### `ToolSuggestDisabledTool::plugin`  (lines 247–252)

```
fn plugin(id: impl Into<String>) -> Self
```

**Purpose**: Convenience constructor for a disabled-tool entry targeting a plugin discoverable.

**Data flow**: Accepts `id: impl Into<String>` → converts it into `String` → returns `ToolSuggestDisabledTool { kind: Plugin, id }`.

**Call relations**: Used by callers building disabled-tool lists programmatically, such as install-request filtering.

*Call graph*: called by 1 (disabled_install_request); 1 external calls (into).


##### `ToolSuggestDisabledTool::connector`  (lines 254–259)

```
fn connector(id: impl Into<String>) -> Self
```

**Purpose**: Convenience constructor for a disabled-tool entry targeting a connector discoverable.

**Data flow**: Accepts `id: impl Into<String>` → converts it into `String` → returns `ToolSuggestDisabledTool { kind: Connector, id }`.

**Call relations**: Sibling to `plugin`, used when the disabled item refers to a connector rather than a plugin.

*Call graph*: called by 1 (disabled_install_request); 1 external calls (into).


##### `ToolSuggestDisabledTool::normalized`  (lines 261–267)

```
fn normalized(&self) -> Option<Self>
```

**Purpose**: Trims whitespace from a disabled-tool id and drops entries whose ids become empty. This prevents meaningless blank identifiers from propagating.

**Data flow**: Reads `self.id`, trims it to `id` → if non-empty, returns `Some(Self { kind: self.kind, id: id.to_string() })`; otherwise returns `None`.

**Call relations**: Called by higher-level config sanitation code when normalizing user-provided disabled-tool lists.


##### `MemoriesConfig::default`  (lines 331–346)

```
fn default() -> Self
```

**Purpose**: Defines the effective default memories behavior and numeric thresholds used when the user omits the `[memories]` section or individual fields.

**Data flow**: Constructs and returns a `MemoriesConfig` with hard-coded booleans and constants such as `generate_memories: true`, `max_raw_memories_for_consolidation: 256`, `max_rollouts_per_startup: 2`, and `min_rate_limit_remaining_percent: 25`.

**Call relations**: Used directly by config assembly and by `From<MemoriesToml>` as the baseline for filling missing values.

*Call graph*: called by 2 (startup_test_memories_config, new_config).


##### `MemoriesConfig::from`  (lines 350–392)

```
fn from(toml: MemoriesToml) -> Self
```

**Purpose**: Converts raw optional TOML memories settings into a fully populated effective config, applying defaults and clamping out-of-range numeric values into safe bounds.

**Data flow**: Consumes `toml: MemoriesToml` → creates `defaults = Self::default()` → for each field, uses the TOML value when present or the default otherwise; clamps `max_raw_memories_for_consolidation` to 1..=4096, `max_unused_days` to 0..=365, `max_rollout_age_days` to 0..=90, `max_rollouts_per_startup` to 1..=128, `min_rollout_idle_hours` to 1..=48, and `min_rate_limit_remaining_percent` to 0..=100 → returns the resulting `MemoriesConfig`.

**Call relations**: Invoked during config materialization from persisted TOML and exercised by tests that verify clamping behavior.

*Call graph*: called by 2 (memories_config_clamps_count_limits_to_nonzero_values, memories_config_clamps_rate_limit_remaining_threshold); 1 external calls (default).


##### `OtelConfig::default`  (lines 573–583)

```
fn default() -> Self
```

**Purpose**: Defines the runtime default OTEL exporter configuration when no explicit telemetry settings are provided.

**Data flow**: Constructs and returns `OtelConfig` with `log_user_prompt: false`, `environment: "dev"`, `exporter` and `trace_exporter` set to `None`, `metrics_exporter` set to `Statsig`, and empty `BTreeMap`s for span attributes and tracestate.

**Call relations**: Used by config assembly code as the baseline effective telemetry configuration.

*Call graph*: called by 1 (new_config); 1 external calls (new).


##### `Notifications::default`  (lines 594–596)

```
fn default() -> Self
```

**Purpose**: Makes TUI notifications enabled by default when the user does not specify a notifications setting.

**Data flow**: Returns `Notifications::Enabled(true)`.

**Call relations**: Used implicitly by serde/default derivation for `TuiNotificationSettings`.

*Call graph*: 1 external calls (Enabled).


##### `NotificationMethod::fmt`  (lines 609–615)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the notification delivery method as its lowercase config/display string.

**Data flow**: Matches `self` on `Auto`, `Osc9`, or `Bel` → writes `"auto"`, `"osc9"`, or `"bel"` into the formatter.

**Call relations**: Called by formatting code when notification method values are rendered for logs, UI, or diagnostics.

*Call graph*: 1 external calls (write!).


##### `NotificationCondition::fmt`  (lines 629–634)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the notification condition enum as its lowercase string form.

**Data flow**: Matches `self` on `Unfocused` or `Always` → writes the corresponding string into the formatter.

**Call relations**: Used by standard formatting paths for notification settings.

*Call graph*: 1 external calls (write!).


##### `default_true`  (lines 775–777)

```
fn default_true() -> bool
```

**Purpose**: Provides a serde-friendly default of `true` for TUI booleans that should be on unless explicitly disabled.

**Data flow**: Takes no input and returns `true`.

**Call relations**: Referenced by serde defaults on `Tui` fields such as animations, tooltips, and status-line colors.


##### `PluginMcpServerConfig::default`  (lines 865–873)

```
fn default() -> Self
```

**Purpose**: Defines the default policy overlay for a plugin-provided MCP server: enabled, with no explicit approval mode or tool allow/deny lists.

**Data flow**: Constructs and returns `PluginMcpServerConfig { enabled: true, default_tools_approval_mode: None, enabled_tools: None, disabled_tools: None, tools: HashMap::new() }`.

**Call relations**: Used whenever plugin MCP server policy is omitted and by serde/default derivation for nested plugin config.

*Call graph*: 1 external calls (new).


##### `SandboxSettings::from`  (lines 920–927)

```
fn from(sandbox_workspace_write: SandboxWorkspaceWrite) -> Self
```

**Purpose**: Converts local writable-workspace sandbox config into the app-server protocol’s sandbox settings shape, wrapping booleans in `Option` as expected by the protocol.

**Data flow**: Consumes `SandboxWorkspaceWrite` → moves `writable_roots` directly and wraps `network_access`, `exclude_tmpdir_env_var`, and `exclude_slash_tmp` in `Some(...)` → returns `codex_app_server_protocol::SandboxSettings`.

**Call relations**: Used when config-derived sandbox settings are sent across the app-server protocol boundary.


##### `ShellEnvironmentPolicy::from`  (lines 950–977)

```
fn from(toml: ShellEnvironmentPolicyToml) -> Self
```

**Purpose**: Builds the effective shell environment policy from its TOML persistence form, applying defaults and compiling include/exclude patterns into runtime matchers.

**Data flow**: Consumes `ShellEnvironmentPolicyToml` → defaults `inherit` to `ShellEnvironmentPolicyInherit::All`, `ignore_default_excludes` to `true`, and `experimental_use_profile` to `false` → turns optional `exclude` and `include_only` string vectors into collections of `EnvironmentVariablePattern::new_case_insensitive(&s)` → defaults `r#set` to an empty `HashMap` → returns `ShellEnvironmentPolicy { inherit, ignore_default_excludes, exclude, r#set, include_only, use_profile }`.

**Call relations**: Invoked when raw config is converted into the protocol/runtime shell policy consumed by process-spawning tools.


### `execpolicy-legacy/src/exec_call.rs`

`data_model` · `cross-cutting`

This file contains the small `ExecCall` struct, which stores a command `program` and its positional `args` as owned `String`s. The constructor `ExecCall::new` is intentionally ergonomic for tests and call sites that already have string literals: it accepts `&str` for the program and a slice of `&str` for arguments, then clones them into owned strings. That keeps callers concise while ensuring the resulting value is self-contained and serializable.

The `Display` implementation renders the invocation in shell-like form by writing the program first and then each argument prefixed with a space. There is no quoting or escaping logic here, so the formatted string is meant for diagnostics and human-readable error messages rather than for safe shell re-execution. The file has no validation or policy logic of its own; it is a compact data carrier used by higher-level matching and testing code.

#### Function details

##### `ExecCall::new`  (lines 12–17)

```
fn new(program: &str, args: &[&str]) -> Self
```

**Purpose**: Constructs an owned `ExecCall` from borrowed program and argument strings. It is a convenience constructor heavily used in tests.

**Data flow**: Takes `program: &str` and `args: &[&str]`, clones the program with `to_string`, maps each argument reference into an owned `String`, collects them into a `Vec<String>`, and returns the populated `ExecCall`.

**Call relations**: Many tests and policy checks call this to build command invocations succinctly. It performs no validation and simply prepares the data structure consumed elsewhere.

*Call graph*: called by 28 (test_cp_multiple_files, test_cp_no_args, test_cp_one_arg, test_cp_one_file, test_head_invalid_n_as_0, test_head_invalid_n_as_float, test_head_invalid_n_as_negative_int, test_head_invalid_n_as_nonint_float, test_head_no_args, test_head_one_file_no_flags (+15 more)).


##### `ExecCall::fmt`  (lines 21–27)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats an `ExecCall` as a space-separated command line for display. It is intended for logs and error messages.

**Data flow**: Reads `self` and a mutable formatter, writes the program, then iterates `self.args` and writes each argument preceded by a space. It returns `std::fmt::Result` from the underlying writes.

**Call relations**: This method is invoked implicitly whenever an `ExecCall` is formatted with `{}`. Higher-level code relies on it for readable diagnostics rather than for machine parsing.

*Call graph*: 1 external calls (write!).


### `execpolicy-legacy/src/valid_exec.rs`

`data_model` · `request handling`

This file is the core result model for a successful policy check. `ValidExec` represents a command line that the policy engine has already accepted, split into `program`, `flags`, `opts`, and positional `args`, plus a `system_path` fallback list of safer absolute binaries such as `/bin/ls` ahead of a bare `ls`. The type derives `Default`, `Eq`, `PartialEq`, and `Serialize`, which makes it easy to compare in tests and emit as structured output.

The companion structs capture the matched pieces with validation baked in. `MatchedArg` stores the original positional index, an `ArgType`, and the string value; `MatchedOpt` stores an option name, its supplied value, and the validated `ArgType`; `MatchedFlag` stores only the flag name because flags are presence-only. Both `MatchedArg::new` and `MatchedOpt::new` call `ArgType::validate` before constructing the value, so these structs maintain the invariant that their `value` field already conforms to the declared type. `ValidExec::new` is intentionally minimal: it initializes a command with positional args and system paths while leaving flags and opts empty, which matches the common test and parser path for simple commands. `ValidExec::might_write_files` inspects both typed options and typed positional arguments, relying on `ArgType::might_write_file()` to conservatively classify commands whose accepted invocation could modify the filesystem.

#### Function details

##### `ValidExec::new`  (lines 21–29)

```
fn new(program: &str, args: Vec<MatchedArg>, system_path: &[&str]) -> Self
```

**Purpose**: Builds a `ValidExec` for a program with already-matched positional arguments and an optional prioritized list of absolute executable paths. It is the convenience constructor used when a command has no matched flags or options to populate.

**Data flow**: Takes `program: &str`, `args: Vec<MatchedArg>`, and `system_path: &[&str]`. It copies `program` into an owned `String`, preserves the provided `args`, initializes `flags` and `opts` as empty vectors, converts each borrowed system path entry into an owned `String`, and returns the assembled `ValidExec`.

**Call relations**: This constructor is used by callers that already resolved and validated positional arguments elsewhere and just need the canonical accepted-exec container. It does not delegate to any policy logic itself; beyond vector construction and string conversion, it only prepares the result object consumed by higher-level check paths and tests.

*Call graph*: 1 external calls (vec!).


##### `ValidExec::might_write_files`  (lines 33–36)

```
fn might_write_files(&self) -> bool
```

**Purpose**: Computes whether any accepted option or positional argument type implies possible file writes. It provides a conservative side-effect signal for downstream consumers deciding how risky an allowed command may be.

**Data flow**: Reads `self.opts` and `self.args`, examines each element's `r#type`, and calls `might_write_file()` on those `ArgType` values. It returns `true` if any option type or argument type reports write capability; otherwise it returns `false` without mutating state.

**Call relations**: This is a pure query on an already-built `ValidExec`. It sits downstream of policy matching: once a command has been accepted and materialized, callers can use this helper to classify it without re-parsing or re-validating any arguments.


##### `MatchedArg::new`  (lines 47–54)

```
fn new(index: usize, r#type: ArgType, value: &str) -> Result<Self>
```

**Purpose**: Constructs a validated positional-argument record, preserving both its original argv index and its semantic `ArgType`. It rejects invalid values before they can enter a `ValidExec`.

**Data flow**: Accepts `index: usize`, `r#type: ArgType`, and `value: &str`. It first invokes `r#type.validate(value)?`; on success it returns `Ok(MatchedArg { index, r#type, value: value.to_string() })`, and on failure it propagates the validation error through the crate `Result` type.

**Call relations**: According to the call graph, this is invoked by `resolve_observed_args_with_patterns` when positional arguments have been matched against policy patterns. It delegates the actual semantic check to `ArgType::validate`, then packages the validated result for inclusion in the accepted execution structure.

*Call graph*: calls 1 internal fn (validate); called by 1 (resolve_observed_args_with_patterns).


##### `MatchedOpt::new`  (lines 69–76)

```
fn new(name: &str, value: &str, r#type: ArgType) -> Result<Self>
```

**Purpose**: Constructs a validated option-with-value record for an option declared in policy. It ensures the supplied option argument conforms to the expected `ArgType` before storing it.

**Data flow**: Takes `name: &str`, `value: &str`, and `r#type: ArgType`. It validates `value` against `r#type`, then returns `Ok(MatchedOpt { name: name.to_string(), value: value.to_string(), r#type })`; if validation fails, it returns the propagated error instead of constructing the struct.

**Call relations**: The call graph shows this is used by `check` during policy evaluation when an option token and its following value have been recognized. It delegates type enforcement to `ArgType::validate` and feeds the resulting typed option into the broader command-match result.

*Call graph*: calls 1 internal fn (validate); called by 1 (check).


##### `MatchedOpt::name`  (lines 78–80)

```
fn name(&self) -> &str
```

**Purpose**: Returns the stored option name as a borrowed string slice. It is a tiny accessor that avoids cloning the owned `String`.

**Data flow**: Reads `self.name` and returns `&str` referencing the internal string. It performs no transformation and does not modify any state.

**Call relations**: This helper is used wherever callers need to inspect or compare an option's canonical name after matching. It is purely local behavior on the data model and does not invoke any other logic.


##### `MatchedFlag::new`  (lines 90–94)

```
fn new(name: &str) -> Self
```

**Purpose**: Constructs a matched flag record from a flag token such as `-a` or `-l`. Because flags carry no separate value, the constructor only stores the name.

**Data flow**: Accepts `name: &str`, converts it to an owned `String`, and returns `MatchedFlag { name }`. There is no validation step and no side effect.

**Call relations**: This constructor is used after higher-level parsing has already decided that a token is an allowed flag. It serves as the final packaging step before the flag is inserted into a `ValidExec`.


### `execpolicy/src/decision.rs`

`data_model` · `policy parse and match aggregation`

This file is a compact data-and-logic definition for policy outcomes. `Decision` is a serializable/deserializable enum with three ordered variants: `Allow`, `Prompt`, and `Forbidden`. The derives (`Clone`, `Copy`, `Eq`, `Ord`, `Serialize`, `Deserialize`) make it usable both in policy parsing and in later aggregation logic such as selecting the maximum decision across matched rules. The serde `rename_all = "camelCase"` attribute controls JSON representation of the enum itself, while the parser below handles the policy language's lowercase string forms.

The only behavior here is `Decision::parse`, which accepts the textual decision values used in rule definitions and returns the corresponding enum variant. It recognizes exactly `allow`, `prompt`, and `forbidden`; any other string becomes `Error::InvalidDecision` carrying the original input. That strictness matters because other parts of the system rely on `Decision` being normalized before evaluation or serialization. The file therefore acts as the single source of truth for valid decision names and keeps invalid values from leaking deeper into policy construction.

#### Function details

##### `Decision::parse`  (lines 19–26)

```
fn parse(raw: &str) -> Result<Self>
```

**Purpose**: Parses a raw decision string from policy text into a `Decision` enum variant. It accepts only the three supported policy values and rejects everything else with a typed parse error.

**Data flow**: It takes `raw: &str`, matches it against the literals `allow`, `prompt`, and `forbidden`, and returns `Ok(Self::Allow)`, `Ok(Self::Prompt)`, or `Ok(Self::Forbidden)` respectively. For any other input it constructs `Error::InvalidDecision(other.to_string())` and returns that in the crate `Result` type.

**Call relations**: This parser is called from network-rule parsing logic when textual rule fields need to become internal decisions. It does not delegate further beyond constructing the error variant for invalid input.

*Call graph*: called by 1 (parse_network_rule_decision); 1 external calls (InvalidDecision).


### `network-proxy/src/reasons.rs`

`data_model` · `request handling`

This file centralizes a set of `pub(crate)` string constants that encode machine-readable reason identifiers for proxy decisions and error responses. The constants cover broad denial (`REASON_DENIED`, `REASON_NOT_ALLOWED`, `REASON_POLICY_DENIED`), more specific transport or policy cases (`REASON_METHOD_NOT_ALLOWED`, `REASON_NOT_ALLOWED_LOCAL`, `REASON_UNIX_SOCKET_UNSUPPORTED`), proxy-state conditions (`REASON_PROXY_DISABLED`), and MITM-specific outcomes (`REASON_MITM_REQUIRED`, `REASON_MITM_HOOK_DENIED`). Keeping these values in one module avoids duplicated literals across policy evaluation, response generation, audit logging, and blocked-request observation paths. The `pub(crate)` visibility is a deliberate design choice: the strings are shared throughout the crate as stable internal vocabulary, but they are not part of the external crate API, which leaves room to change or remap them later without breaking downstream consumers. The main invariant is consistency—every component that emits a reason code should use these exact constants so logs, metrics, and client-visible error payloads can be correlated reliably.


### Skills and extension models
These files define the shared in-memory and extension-facing schemas for skills catalogs, loaded skills, and related selection metadata.

### `core-skills/src/model.rs`

`data_model` · `skill load, filtering, and per-turn skill access`

This file contains the primary skill metadata schema and the aggregate result of a skill-loading pass. `SkillMetadata` stores the user-visible fields (`name`, `description`, optional `short_description`), optional UI/interface metadata, optional tool dependencies, optional policy, the declaring `path_to_skills_md`, the `SkillScope`, and an optional `plugin_id`. Supporting structs (`SkillPolicy`, `SkillInterface`, `SkillDependencies`, `SkillToolDependency`, `SkillError`) are mostly plain data carriers.

`SkillLoadOutcome` is the important aggregate: it holds loaded `skills`, parse/load `errors`, `disabled_paths`, the discovered `skill_roots`, a path-to-root map, a path-to-filesystem map, and two maps for implicit skills keyed by scripts directory and doc path. Its methods derive operational views from that state: whether a skill is enabled, whether it may be implicitly invoked, an owned list of allowed implicit skills, an iterator pairing each skill with its enabled flag, and the executor filesystem associated with a skill path.

`HostLoadedSkills` wraps an `Arc<SkillLoadOutcome>` for per-turn use and reads skill text through the same `ExecutorFileSystem` that originally exposed the skill, falling back to `LOCAL_FS` when no custom mapping exists. `SkillFileSystemsByPath` encapsulates the shared filesystem map behind an `Arc<HashMap<...>>` and supports pruning to retained paths. Finally, `filter_skill_load_outcome_for_product` destructively filters a whole outcome by `Product`, keeping all internal maps and root lists consistent with the surviving skills and implicit-skill entries. The key invariant is that after filtering, filesystem and root metadata only reference retained skill paths.

#### Function details

##### `SkillMetadata::allows_implicit_invocation`  (lines 29–34)

```
fn allows_implicit_invocation(&self) -> bool
```

**Purpose**: Determines whether a skill may be selected implicitly from its policy. Missing policy or missing `allow_implicit_invocation` defaults to `true`.

**Data flow**: It reads `self.policy`, then reads `policy.allow_implicit_invocation` if present. It unwraps nested `Option`s and returns a `bool`, defaulting to `true` when no explicit prohibition exists. It writes no state.

**Call relations**: This method is used by higher-level enablement checks when deciding whether a loaded skill can participate in implicit invocation.


##### `SkillMetadata::matches_product_restriction_for_product`  (lines 36–49)

```
fn matches_product_restriction_for_product(
        &self,
        restriction_product: Option<Product>,
    ) -> bool
```

**Purpose**: Checks whether this skill is allowed under an optional product restriction. A skill with no policy always matches; a skill with a policy matches when its `products` list is empty or the requested product satisfies that restriction list.

**Data flow**: It reads `self.policy` and, when present, inspects `policy.products`. If the list is empty it returns `true`; otherwise it reads the `restriction_product` argument and asks that `Product` whether it matches the policy's restrictions. The result is a boolean with no side effects.

**Call relations**: This predicate is the core filter used when pruning a `SkillLoadOutcome` for a specific product, and it is also applied to implicit-skill maps during that pruning.


##### `SkillLoadOutcome::is_skill_enabled`  (lines 104–106)

```
fn is_skill_enabled(&self, skill: &SkillMetadata) -> bool
```

**Purpose**: Answers whether a loaded skill is currently enabled by checking whether its declaring path is absent from `disabled_paths`.

**Data flow**: It takes `&self` and `&SkillMetadata`, reads `skill.path_to_skills_md`, and tests membership in `self.disabled_paths`. It returns `true` when the path is not disabled and does not mutate state.

**Call relations**: This is the first gate in implicit-invocation eligibility and is called by `SkillLoadOutcome::is_skill_allowed_for_implicit_invocation`.

*Call graph*: called by 1 (is_skill_allowed_for_implicit_invocation).


##### `SkillLoadOutcome::is_skill_allowed_for_implicit_invocation`  (lines 108–110)

```
fn is_skill_allowed_for_implicit_invocation(&self, skill: &SkillMetadata) -> bool
```

**Purpose**: Combines enablement and policy into a single implicit-invocation decision for one skill.

**Data flow**: It reads the supplied `SkillMetadata` and `self.disabled_paths`, first invoking `is_skill_enabled`, then reading the skill's policy through `allows_implicit_invocation`. It returns `true` only if both checks pass and writes no state.

**Call relations**: This method is the per-skill predicate used when building the list of implicitly invocable skills.

*Call graph*: calls 1 internal fn (is_skill_enabled); 1 external calls (allows_implicit_invocation).


##### `SkillLoadOutcome::allowed_skills_for_implicit_invocation`  (lines 112–118)

```
fn allowed_skills_for_implicit_invocation(&self) -> Vec<SkillMetadata>
```

**Purpose**: Produces an owned `Vec<SkillMetadata>` containing only enabled skills whose policy permits implicit invocation.

**Data flow**: It iterates over `self.skills`, applies `is_skill_allowed_for_implicit_invocation` to each borrowed item, clones the passing `SkillMetadata` values, and collects them into a vector. It returns that vector without mutating the outcome.

**Call relations**: Callers use this as the filtered skill set for later rendering and finalization steps, rather than reimplementing enablement and policy checks themselves.

*Call graph*: called by 2 (finalize_skill_outcome, build_available_skills).


##### `SkillLoadOutcome::skills_with_enabled`  (lines 120–124)

```
fn skills_with_enabled(&self) -> impl Iterator<Item = (&SkillMetadata, bool)>
```

**Purpose**: Exposes an iterator over all loaded skills paired with a computed enabled flag.

**Data flow**: It borrows `self.skills`, maps each `&SkillMetadata` to `(&SkillMetadata, bool)` by calling `is_skill_enabled`, and returns the lazy iterator. No allocation beyond iterator state occurs here and no state is changed.

**Call relations**: This supports catalog-building code that needs to preserve all loaded skills while also surfacing whether each one is disabled.

*Call graph*: called by 1 (catalog_from_outcome).


##### `SkillLoadOutcome::file_system_for_skill`  (lines 126–132)

```
fn file_system_for_skill(
        &self,
        skill: &SkillMetadata,
    ) -> Option<Arc<dyn ExecutorFileSystem>>
```

**Purpose**: Looks up the executor filesystem associated with a skill's `SKILLS.md` path.

**Data flow**: It reads `skill.path_to_skills_md` and queries `self.file_systems_by_skill_path`. It returns `Option<Arc<dyn ExecutorFileSystem>>`, cloning the stored `Arc` when present, and does not mutate state.

**Call relations**: This is the bridge from metadata to I/O context and is used by `HostLoadedSkills::read_skill_text` before falling back to `LOCAL_FS`.

*Call graph*: calls 1 internal fn (get).


##### `HostLoadedSkills::new`  (lines 143–145)

```
fn new(outcome: Arc<SkillLoadOutcome>) -> Self
```

**Purpose**: Wraps a shared `Arc<SkillLoadOutcome>` into the per-turn `HostLoadedSkills` helper.

**Data flow**: It takes ownership of an `Arc<SkillLoadOutcome>` argument and stores it in the `outcome` field of a new `HostLoadedSkills`. It returns the wrapper and performs no other work.

**Call relations**: Construction happens when turn or review contexts need a stable handle for reading skill bodies through the same environment that loaded them.

*Call graph*: called by 4 (spawn_review_thread, make_turn_context, skill_loading_and_reads_use_the_supplied_executor_file_system, installed_extension_uses_host_loaded_skills).


##### `HostLoadedSkills::outcome`  (lines 147–149)

```
fn outcome(&self) -> &SkillLoadOutcome
```

**Purpose**: Returns a shared reference to the underlying `SkillLoadOutcome`.

**Data flow**: It reads the internal `Arc<SkillLoadOutcome>` and returns `&SkillLoadOutcome` via `as_ref()`. No cloning or mutation occurs.

**Call relations**: This is a simple accessor for callers that need the loaded-skill metadata alongside the read helper.


##### `HostLoadedSkills::read_skill_text`  (lines 151–158)

```
async fn read_skill_text(&self, skill: &SkillMetadata) -> io::Result<String>
```

**Purpose**: Reads the full text of a skill's declaring `SKILLS.md` through the executor filesystem that owns that skill, or the local filesystem if no custom mapping exists.

**Data flow**: It takes `&self` and `&SkillMetadata`, reads the filesystem mapping from the wrapped outcome, falls back to `LOCAL_FS` when absent, converts `skill.path_to_skills_md` into a `PathUri`, and asynchronously calls `read_file_text`. It returns `io::Result<String>` and performs external file I/O through the selected filesystem.

**Call relations**: This is the runtime read path for host-loaded skills: callers construct `HostLoadedSkills`, then use this method to fetch instruction text while preserving environment-specific access semantics.

*Call graph*: calls 1 internal fn (from_abs_path).


##### `SkillFileSystemsByPath::new`  (lines 167–171)

```
fn new(values: HashMap<AbsolutePathBuf, Arc<dyn ExecutorFileSystem>>) -> Self
```

**Purpose**: Creates the shared path-to-filesystem wrapper from a plain `HashMap`.

**Data flow**: It takes ownership of a `HashMap<AbsolutePathBuf, Arc<dyn ExecutorFileSystem>>`, wraps it in an `Arc`, stores it in `values`, and returns the new `SkillFileSystemsByPath`.

**Call relations**: Skill-loading code uses this constructor when assembling a `SkillLoadOutcome` from discovered roots and filesystem contexts.

*Call graph*: called by 1 (load_skills_from_roots); 1 external calls (new).


##### `SkillFileSystemsByPath::get`  (lines 173–175)

```
fn get(&self, path: &AbsolutePathBuf) -> Option<Arc<dyn ExecutorFileSystem>>
```

**Purpose**: Fetches the filesystem associated with one absolute skill path.

**Data flow**: It reads the internal `values` map with the provided `&AbsolutePathBuf` key and clones the stored `Arc<dyn ExecutorFileSystem>` if found. It returns `Option<Arc<dyn ExecutorFileSystem>>` and does not mutate state.

**Call relations**: This is an internal helper used by `SkillLoadOutcome::file_system_for_skill` to keep map access encapsulated.

*Call graph*: called by 1 (file_system_for_skill).


##### `SkillFileSystemsByPath::retain_paths`  (lines 177–185)

```
fn retain_paths(&mut self, paths: &HashSet<AbsolutePathBuf>)
```

**Purpose**: Prunes the filesystem map so it contains only entries whose paths are in a retained-path set.

**Data flow**: It takes `&mut self` and a `HashSet<AbsolutePathBuf>` of allowed paths, iterates the current map, filters out non-retained keys, clones surviving keys and filesystem `Arc`s into a new `HashMap`, then replaces `self.values` with a new `Arc` around that filtered map.

**Call relations**: This method is part of outcome consistency maintenance and is invoked during product filtering so stale filesystem mappings do not survive after skills are removed.

*Call graph*: 1 external calls (new).


##### `SkillFileSystemsByPath::fmt`  (lines 189–193)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides a compact debug representation that reports only the number of stored filesystem mappings.

**Data flow**: It reads `self.values.len()` and writes a `DebugStruct` named `SkillFileSystemsByPath` into the provided formatter. It returns `fmt::Result` and does not expose the underlying trait objects.

**Call relations**: This custom formatter supports debugging of `SkillLoadOutcome` without trying to print non-debuggable or noisy filesystem internals.

*Call graph*: 1 external calls (debug_struct).


##### `filter_skill_load_outcome_for_product`  (lines 196–241)

```
fn filter_skill_load_outcome_for_product(
    mut outcome: SkillLoadOutcome,
    restriction_product: Option<Product>,
) -> SkillLoadOutcome
```

**Purpose**: Filters a complete `SkillLoadOutcome` down to the skills and auxiliary maps that match an optional product restriction.

**Data flow**: It takes ownership of a mutable `SkillLoadOutcome` plus `Option<Product>`. It retains only matching entries in `outcome.skills`, derives the surviving skill paths into a `HashSet`, prunes `file_systems_by_skill_path`, rebuilds `skill_root_by_path` to only retained paths, recomputes the set of retained roots and trims `skill_roots`, then rebuilds both implicit-skill maps to keep only matching skills. It returns the updated `SkillLoadOutcome` by value.

**Call relations**: This function is the top-level product-gating pass applied after loading. Rather than only filtering the visible skill list, it also rewrites every dependent map so later reads, aliasing, and implicit-skill lookups remain aligned with the filtered catalog.

*Call graph*: 1 external calls (new).


### `ext/skills/src/catalog.rs`

`data_model` · `cross-cutting`

This file is the canonical type layer for skills. `SkillSourceKind` identifies where a skill comes from (`Host`, `Executor`, `Orchestrator`, or arbitrary `Custom(String)`), with string rendering centralized in `as_str`/`Display`. `SkillAuthority` pairs a source kind with an opaque source-specific `id`; callers are expected to route list/read operations by this authority rather than infer transport details.

Two opaque identifiers separate package identity from resource identity. `SkillPackageId(pub String)` names a package, while `SkillResourceId` stores a resource `id` plus an optional hidden `EnvironmentSkillResource` binding containing an `environment_id` and `AbsolutePathBuf`. That extra binding is what lets executor-owned resources be read through the correct environment filesystem without exposing raw paths as public API.

`SkillCatalogEntry` is the visible metadata record for one skill: package id, authority, display name, long and short descriptions, main prompt resource, optional display path, optional `SkillDependencies`, and booleans controlling whether the skill is enabled and whether it should appear in prompt-visible listings. Its builder-style methods mutate those optional fields fluently, and `rendered_path` prefers `display_path` over the raw resource id.

`SkillCatalog` is a per-turn merged catalog with accumulated warnings. Its `extend` method merges another catalog entry-by-entry through `push_entry`, and `push_entry` enforces a deduplication invariant: entries are unique by `(authority, id)` pair. The file also defines simple result wrappers (`SkillReadResult`, `SkillSearchResult`, `SkillSearchMatch`) and `SkillProviderError`, a lightweight message-only error type implementing `Display` and `Error` for provider APIs.

#### Function details

##### `SkillSourceKind::custom`  (lines 20–22)

```
fn custom(kind: impl Into<String>) -> Self
```

**Purpose**: Constructs a custom source kind from any string-like input. It is the convenience constructor for extension-private or future provider categories that do not fit the built-in variants.

**Data flow**: Accepts `kind: impl Into<String>`, converts it into an owned `String`, wraps it in `SkillSourceKind::Custom`, and returns the enum value; no external state is touched.

**Call relations**: Used by callers that need a nonstandard authority kind. It is a leaf constructor and does not participate in broader control flow beyond supplying a `SkillSourceKind` value.

*Call graph*: 2 external calls (into, Custom).


##### `SkillSourceKind::as_str`  (lines 24–31)

```
fn as_str(&self) -> &str
```

**Purpose**: Maps each source-kind variant to its stable string representation. For `Custom`, it exposes the stored custom string directly.

**Data flow**: Reads `self`, matches on the enum variant, and returns a borrowed `&str` pointing either to a static literal or the inner custom string; no allocation or mutation occurs.

**Call relations**: Primarily used by the `Display` implementation to render authorities and error messages consistently.

*Call graph*: called by 1 (fmt).


##### `SkillSourceKind::fmt`  (lines 35–37)

```
fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Implements `Display` for `SkillSourceKind` by writing the canonical string form into the formatter. This gives source kinds readable output in logs and user-facing errors.

**Data flow**: Reads `self`, obtains its string form via `as_str`, and forwards formatting to the formatter; returns `std::fmt::Result` and writes only to the formatter output stream.

**Call relations**: Called implicitly whenever a `SkillSourceKind` is formatted, including provider error construction paths that mention unsupported authorities.

*Call graph*: calls 1 internal fn (as_str).


##### `SkillAuthority::new`  (lines 48–53)

```
fn new(kind: SkillSourceKind, id: impl Into<String>) -> Self
```

**Purpose**: Builds an opaque authority identifier from a source kind and source-specific id. It standardizes authority construction across providers and adapters.

**Data flow**: Takes a `SkillSourceKind` and `id: impl Into<String>`, converts the id into an owned `String`, and returns a `SkillAuthority { kind, id }`; no external state is modified.

**Call relations**: Used broadly by provider list/read code and tests whenever a catalog entry or request needs to identify the owning source.

*Call graph*: called by 7 (list, catalog_entry_from_skill, read, catalog_entry_from_resource, from_authority, into_authority, test_entry); 1 external calls (into).


##### `SkillResourceId::new`  (lines 69–74)

```
fn new(id: impl Into<String>) -> Self
```

**Purpose**: Creates a plain resource identifier with no environment binding. This is the normal constructor for host and orchestrator resources whose transport does not require executor filesystem routing.

**Data flow**: Accepts `id: impl Into<String>`, converts it into an owned string, stores it with `environment_path: None`, and returns the new `SkillResourceId`.

**Call relations**: Called when catalog entries or requests refer to resources that can be resolved directly from their string id.

*Call graph*: called by 4 (catalog_entry_from_skill, catalog_entry_from_resource, handle, test_entry); 1 external calls (into).


##### `SkillResourceId::environment`  (lines 76–88)

```
fn environment(
        id: impl Into<String>,
        environment_id: impl Into<String>,
        path: AbsolutePathBuf,
    ) -> Self
```

**Purpose**: Creates a resource identifier that is additionally bound to an owning environment id and absolute path. This preserves enough hidden routing information for executor-backed reads.

**Data flow**: Consumes an `id`, `environment_id`, and `AbsolutePathBuf`, converts the string-like inputs into owned strings, wraps the environment metadata in `EnvironmentSkillResource`, stores it in `environment_path: Some(...)`, and returns the `SkillResourceId`.

**Call relations**: Used by executor-provider catalog construction so later read requests can recover the exact environment and path to access.

*Call graph*: called by 1 (catalog_entry_from_skill); 1 external calls (into).


##### `SkillResourceId::as_str`  (lines 90–92)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the public string identifier for the resource. This is the stable external-facing id used in prompts, package/resource comparisons, and provider requests.

**Data flow**: Borrows `self.id` and returns it as `&str`; no allocation or mutation occurs.

**Call relations**: Consumed throughout the skills subsystem wherever a resource id string is needed, including rendering and provider validation.


##### `SkillResourceId::environment_path`  (lines 94–98)

```
fn environment_path(&self) -> Option<(&str, &AbsolutePathBuf)>
```

**Purpose**: Exposes the hidden environment binding, if present, as borrowed components. It is intentionally crate-private so only internal provider code can use the embedded filesystem routing data.

**Data flow**: Reads `self.environment_path`; if present, maps it to `(&str, &AbsolutePathBuf)` borrowing the stored environment id and path; otherwise returns `None`.

**Call relations**: Used by executor read logic to recover the environment and absolute path associated with an executor-owned resource.


##### `SkillCatalogEntry::new`  (lines 123–142)

```
fn new(
        id: SkillPackageId,
        authority: SkillAuthority,
        name: impl Into<String>,
        description: impl Into<String>,
        main_prompt: SkillResourceId,
    ) -> Self
```

**Purpose**: Constructs a catalog entry with required metadata and sensible defaults for optional fields and visibility flags. It is the base constructor all providers build on.

**Data flow**: Accepts required `id`, `authority`, `name`, `description`, and `main_prompt`, converts the string-like fields into owned `String`s, and returns a `SkillCatalogEntry` with `short_description`, `display_path`, and `dependencies` unset, `enabled` true, and `prompt_visible` true.

**Call relations**: Called by provider-specific catalog-entry builders and tests, after which fluent modifiers may adjust descriptions, display path, dependencies, or visibility.

*Call graph*: called by 4 (catalog_entry_from_skill, catalog_entry_from_skill, catalog_entry_from_resource, test_entry); 1 external calls (into).


##### `SkillCatalogEntry::with_short_description`  (lines 144–147)

```
fn with_short_description(mut self, short_description: Option<String>) -> Self
```

**Purpose**: Sets the optional short description on a catalog entry in builder style. It allows providers to preserve concise metadata when available.

**Data flow**: Takes ownership of `self` and an `Option<String>`, assigns it to `self.short_description`, and returns the modified entry.

**Call relations**: Typically chained immediately after `SkillCatalogEntry::new` during provider catalog construction.


##### `SkillCatalogEntry::with_display_path`  (lines 149–152)

```
fn with_display_path(mut self, display_path: impl Into<String>) -> Self
```

**Purpose**: Overrides the path shown to users for this skill. This lets providers present normalized or synthetic paths instead of raw resource ids.

**Data flow**: Consumes `self` and `display_path: impl Into<String>`, converts the path into an owned string, stores it in `self.display_path = Some(...)`, and returns the updated entry.

**Call relations**: Used by providers that want rendered output to show a normalized filesystem path or synthetic URI rather than the underlying resource identifier.

*Call graph*: 1 external calls (into).


##### `SkillCatalogEntry::with_dependencies`  (lines 154–157)

```
fn with_dependencies(mut self, dependencies: Option<SkillDependencies>) -> Self
```

**Purpose**: Attaches optional dependency metadata to a catalog entry. This preserves package dependency information for downstream rendering or selection logic.

**Data flow**: Consumes `self` and an `Option<SkillDependencies>`, assigns it to `self.dependencies`, and returns the modified entry.

**Call relations**: Chained by providers after base entry construction when skill metadata includes dependency declarations.


##### `SkillCatalogEntry::disabled`  (lines 159–162)

```
fn disabled(mut self) -> Self
```

**Purpose**: Marks a catalog entry as disabled while keeping it present in the catalog. This distinguishes unavailable skills from absent ones.

**Data flow**: Consumes `self`, sets `self.enabled = false`, and returns the updated entry.

**Call relations**: Applied by provider catalog builders when the underlying skill loader reports a skill as present but not enabled.


##### `SkillCatalogEntry::hidden_from_prompt`  (lines 164–167)

```
fn hidden_from_prompt(mut self) -> Self
```

**Purpose**: Marks a catalog entry as not prompt-visible. The skill remains in the catalog data model but should be omitted from always-visible prompt listings.

**Data flow**: Consumes `self`, sets `self.prompt_visible = false`, and returns the updated entry.

**Call relations**: Used by providers when a skill disallows implicit invocation, so rendering code can suppress it from prompt-visible catalogs.


##### `SkillCatalogEntry::rendered_path`  (lines 169–173)

```
fn rendered_path(&self) -> &str
```

**Purpose**: Returns the path string that should be shown in rendered skill listings or injected prompt fragments. It prefers an explicit display path and falls back to the main prompt resource id.

**Data flow**: Reads `self.display_path`; if present returns its `&str`, otherwise returns `self.main_prompt.as_str()`; no mutation occurs.

**Call relations**: Consumed by rendering code when constructing human-visible skill lines and injected skill prompt metadata.

*Call graph*: called by 1 (render_skill_line).


##### `SkillCatalog::extend`  (lines 184–189)

```
fn extend(&mut self, other: SkillCatalog)
```

**Purpose**: Merges another catalog into this one while preserving deduplication rules and appending warnings. It is the high-level catalog-composition operation.

**Data flow**: Takes mutable `self` and another `SkillCatalog`; iterates through `other.entries`, forwarding each to `push_entry`, then extends `self.warnings` with `other.warnings`; mutates the receiver in place and returns nothing.

**Call relations**: Used by higher-level orchestration when combining catalogs from multiple providers or snapshots. It delegates duplicate suppression to `push_entry`.

*Call graph*: calls 1 internal fn (push_entry); called by 1 (extend_catalog).


##### `SkillCatalog::push_entry`  (lines 191–201)

```
fn push_entry(&mut self, entry: SkillCatalogEntry)
```

**Purpose**: Adds a single catalog entry unless an entry with the same authority and package id already exists. This enforces the catalog's uniqueness invariant.

**Data flow**: Reads `entry.authority` and `entry.id`, scans `self.entries` for an existing entry with both equal, and either returns early or pushes the new entry onto `self.entries`; mutates the receiver only when the entry is unique.

**Call relations**: Called directly by providers while building catalogs and indirectly through `SkillCatalog::extend` during catalog merges.

*Call graph*: called by 1 (extend).


##### `SkillProviderError::new`  (lines 231–235)

```
fn new(message: impl Into<String>) -> Self
```

**Purpose**: Constructs the lightweight provider error wrapper from any string-like message. It standardizes provider failures around a single message field.

**Data flow**: Accepts `message: impl Into<String>`, converts it into an owned string, stores it in `SkillProviderError { message }`, and returns the error value.

**Call relations**: Used throughout provider implementations whenever list/read/search operations need to return a structured failure.

*Call graph*: called by 8 (read, list, read, list, read, read, search, list); 1 external calls (into).


##### `SkillProviderError::fmt`  (lines 239–241)

```
fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Implements `Display` for provider errors by writing the stored message verbatim. This keeps error formatting simple and predictable.

**Data flow**: Borrows `self.message`, forwards it to the formatter, and returns `std::fmt::Result`; writes only to the formatter output.

**Call relations**: Invoked implicitly when provider errors are logged, wrapped, or interpolated into warning strings.


### State and persistence schemas
These files define shared state, graph, memory-processing, thread-store, and process-status models used by persistence layers and runtime state management.

### `agent-graph-store/src/types.rs`

`data_model` · `cross-cutting type definition`

This file is the data-model definition for thread-spawn edge lifecycle state. Its only production item is `ThreadSpawnEdgeStatus`, a small enum with two variants: `Open` for child threads that are still live or resumable, and `Closed` for children that have been closed from the graph’s perspective. The enum derives `Clone`, `Copy`, `Debug`, `PartialEq`, and `Eq` for ergonomic use in store APIs and tests, and derives both `Serialize` and `Deserialize` so it can move across JSON or other serde-backed boundaries.

A notable design choice is the `#[serde(rename_all = "snake_case")]` attribute. That means the Rust variants `Open` and `Closed` are encoded as the lowercase strings `"open"` and `"closed"`, not as Rust-style variant names. This matters because other files in the subsystem convert this enum into storage-layer status types and may also expose it through APIs; the test here ensures the external representation remains stable.

The test module is intentionally narrow: it serializes both variants to JSON strings and deserializes those strings back into enum values. That gives this file a single responsibility—define the canonical status vocabulary and its serde contract—without embedding any persistence or graph logic.

#### Function details

##### `tests::thread_spawn_edge_status_serializes_as_snake_case`  (lines 20–41)

```
fn thread_spawn_edge_status_serializes_as_snake_case()
```

**Purpose**: Confirms that `ThreadSpawnEdgeStatus` serializes and deserializes using the exact snake_case JSON strings expected by external consumers.

**Data flow**: Serializes `ThreadSpawnEdgeStatus::Open` and `::Closed` with `serde_json::to_string`, compares the outputs to `"open"` and `"closed"`, then deserializes those strings with `serde_json::from_str` and asserts the resulting enum values match the original variants.

**Call relations**: This test is the sole executable check in the file. It protects the serde rename policy so callers elsewhere can rely on stable wire values.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/state/mod.rs`

`data_model` · `main loop`

This module is the top-level index for runtime state in `codex-core`. It declares submodules for `additional_context`, `auto_compact_window`, `service`, `session`, and `turn`, then re-exports the concrete types that other parts of the system use to read or mutate conversational state. There is no behavior in this file itself; its value is in defining the state vocabulary and keeping consumers decoupled from the physical layout of the state implementation.

The exported types show the major state partitions. `SessionState` and `SessionServices` represent long-lived thread/session state and the service dependencies attached to it. `TurnState`, `ActiveTurn`, `RunningTask`, `TaskKind`, `PendingRequestPermissions`, and `MailboxDeliveryPhase` describe in-flight turn execution, task tracking, permission gating, and mailbox progression. `AdditionalContextStore` captures auxiliary context accumulated outside the main transcript, while `AutoCompactWindowSnapshot` exposes the snapshot used by automatic context compaction logic. By centralizing these exports, the module enforces a stable internal import path for stateful code and makes it clear that session-level, turn-level, and compaction-related state are part of one coordinated subsystem.


### `core/src/unified_exec/process_state.rs`

`data_model` · `cross-cutting process state publication during runtime and shutdown`

This file contains the `ProcessState` data model shared by `UnifiedExecProcess` instances. The struct is intentionally small: `has_exited` indicates whether the process should be treated as finished, `exit_code` carries the known numeric exit status if available, and `failure_message` stores a terminal failure reason such as transport or network-approval failure. It derives `Clone`, `Debug`, `Default`, `Eq`, and `PartialEq`, making it cheap to copy through `tokio::sync::watch` and easy to compare in tests or state transitions.

The two methods are pure transition constructors rather than mutating setters. `exited` returns a new state with `has_exited` forced to true and the supplied exit code, while preserving any existing failure message. `failed` also forces `has_exited` to true, preserves the current exit code, and replaces the failure message with the provided string. That split is important in the surrounding process code: a process can fail before or after an exit code is known, and later exit publication should not erase the original failure reason. Because the type is immutable and copied through watch channels, callers always build a new state from the current borrowed snapshot and publish it atomically.

#### Function details

##### `ProcessState::exited`  (lines 9–15)

```
fn exited(&self, exit_code: Option<i32>) -> Self
```

**Purpose**: Builds a new state snapshot representing a process that has exited, preserving any previously recorded failure message.

**Data flow**: Reads `self.failure_message`, takes an `Option<i32>` exit code, and returns a new `ProcessState` with `has_exited: true`, the supplied `exit_code`, and a cloned `failure_message`.

**Call relations**: Used by process runtime code whenever exit is observed or termination is confirmed, so exit publication does not discard an earlier failure cause.


##### `ProcessState::failed`  (lines 17–23)

```
fn failed(&self, message: String) -> Self
```

**Purpose**: Builds a new state snapshot representing a terminal process failure with an attached message.

**Data flow**: Reads `self.exit_code`, takes a failure `String`, and returns a new `ProcessState` with `has_exited: true`, the existing `exit_code`, and `failure_message: Some(message)`.

**Call relations**: Used by process runtime code when transport reads fail, network denial occurs, or other terminal errors must be published before or alongside exit handling.


### `state/src/model/graph.rs`

`data_model` · `cross-cutting; used whenever thread graph edge state is stored, queried, or displayed`

This file contains a single data model, `DirectionalThreadSpawnEdgeStatus`, with the two states `Open` and `Closed`. Although compact, it is carefully derived for multiple integration points: `Debug`, `Clone`, `Copy`, `PartialEq`, and `Eq` support ordinary Rust value semantics; `AsRefStr`, `Display`, and `EnumString` from `strum` make the enum easy to serialize to and parse from textual snake_case values.

The `#[strum(serialize_all = "snake_case")]` attribute is the key detail: both variants map to stable lowercase identifiers (`open`, `closed`) rather than Rust-style variant names. That matters anywhere the status is stored in SQLite, emitted in logs/telemetry, or reconstructed from persisted strings. Because the enum is `Copy`, callers can pass and compare it freely without ownership concerns, which fits its role as a lightweight status flag rather than a rich object. The file intentionally contains no behavior beyond the derived conversions; all semantics about when an edge becomes open or closed live elsewhere in the state subsystem.


### `state/src/model/memories.rs`

`data_model` · `background job scheduling and memory extraction/consolidation workflows`

This file models the memory-processing pipeline in terms of immutable records and claim outcomes. `Stage1Output` captures the persisted result of extracting memory from a single thread rollout: the `ThreadId`, source `rollout_path`, source modification time, raw extracted memory text, rollout summary, optional rollout slug, working directory, optional git branch, and the generation timestamp. The combination preserves both provenance and generated content so freshness can be compared against the source rollout.

`Stage1JobClaimOutcome` enumerates all meaningful results when a worker tries to acquire a per-thread extraction job. Beyond success (`Claimed { ownership_token }`), it distinguishes stale-work avoidance (`SkippedUpToDate`), active lease contention (`SkippedRunning`), temporary retry suppression (`SkippedRetryBackoff`), and permanent automatic retry exhaustion (`SkippedRetryExhausted`). `Stage1JobClaim` packages a successful claim with the associated `ThreadMetadata` and ownership token.

`Stage1StartupClaimParams<'a>` groups the knobs used when scanning for startup claims: scan and claim limits, age and idle thresholds, allowed source list, and lease duration. For phase 2, `Phase2JobClaimOutcome` models a single global consolidation lease, including the claimed `input_watermark` snapshot or skip reasons for retry unavailability, cooldown, and another active worker. The explicit enums are important because they preserve scheduler intent; callers can react differently to freshness, contention, cooldown, and retry policy without inferring meaning from booleans.


### `state/src/model/mod.rs`

`orchestration` · `compile-time model wiring and cross-cutting type access throughout the state crate`

This module file organizes the state subsystem's model layer into focused submodules: agent jobs, backfill state, thread graph status, logs, memory-processing records, thread goals, and thread metadata. Its main job is to flatten those pieces into a coherent API. Public re-exports expose the domain types that other crates and higher layers use directly, including `AgentJob` and related item/status/progress types, `BackfillState` and `BackfillStatus`, `DirectionalThreadSpawnEdgeStatus`, log structs, stage-1 and phase-2 memory claim types, `ThreadGoal` and `ThreadGoalStatus`, and the thread metadata paging/sorting/builder types.

The file also performs an important internal role by re-exporting crate-private storage-oriented helpers: `AgentJobItemRow`, `AgentJobRow`, `ThreadGoalRow`, `ThreadRow`, and conversion utilities such as `anchor_from_item`, `datetime_to_epoch_millis`, `datetime_to_epoch_seconds`, and `epoch_millis_to_datetime`. That pattern lets sibling modules within the crate share row structs and timestamp conversion logic through `model` without making those implementation details part of the public API.

There is no executable logic here; the design choice is namespace control. Public consumers see stable business-level types, while internal modules get a curated set of lower-level row and conversion helpers needed for SQL mapping and persistence.


### `thread-store/src/types.rs`

`data_model` · `cross-cutting`

This file is the thread store’s central data model module. Most of it consists of serde-enabled structs and enums that describe the API surface between higher-level thread orchestration and concrete persistence backends: creation/resume inputs (`CreateThreadParams`, `ResumeThreadParams`), history loading and reading (`LoadThreadHistoryParams`, `ReadThreadParams`, `StoredThreadHistory`), discovery/search (`ListThreadsParams`, `SearchThreadsParams`, `ThreadPage`, `ThreadSearchPage`), turn/item pagination (`ListTurnsParams`, `StoredTurn`, `TurnPage`, `ListItemsParams`, `StoredThreadItem`, `ItemPage`), and lifecycle operations like archive/delete/update metadata.

A key design detail is the distinction between ordinary optional fields and patchable clearable fields. `ClearableField<T>` is `Option<Option<T>>`, where outer `None` means “leave unchanged”, `Some(Some(v))` means “set to v”, and `Some(None)` means “clear the stored value”. The private `optional_option` serde adapter preserves that tri-state over JSON, allowing explicit `null` to round-trip instead of collapsing into omission. `GitInfoPatch` and `ThreadMetadataPatch` implement merge-by-presence semantics rather than overwrite-all semantics, and nested Git patches merge field-by-field. `ThreadMetadataPatch::is_empty` provides a cheap invariant check for no-op updates. The tests focus specifically on these subtle serialization and merge rules, ensuring backward compatibility with missing fields and correct handling of explicit clears.

#### Function details

##### `optional_option::serialize`  (lines 26–35)

```
fn serialize(value: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes a tri-state `Option<Option<T>>` so patch fields can distinguish omission from an explicit `null`. If the outer option is absent it emits no value/`None`; if present, it serializes the inner `Option<T>` directly, preserving either a concrete value or `null`.

**Data flow**: Takes `&Option<Option<T>>` plus a serde `Serializer`. It inspects the outer option: `Some(inner)` forwards `inner.serialize(serializer)`, while `None` calls `serializer.serialize_none()`. It returns the serializer’s `Result<S::Ok, S::Error>` and writes JSON/output through serde.

**Call relations**: Used by serde on patch fields annotated with `with = "optional_option"`, specifically the clearable fields in `GitInfoPatch` and `ThreadMetadataPatch`. It exists so callers serializing patch payloads preserve field-presence semantics required by the merge logic and validated by the tests.

*Call graph*: 1 external calls (serialize_none).


##### `optional_option::deserialize`  (lines 37–43)

```
fn deserialize(deserializer: D) -> Result<Option<Option<T>>, D::Error>
```

**Purpose**: Deserializes patch fields encoded with tri-state semantics into `Option<Option<T>>`. It always wraps the decoded inner `Option<T>` in `Some`, so a present JSON field becomes either `Some(Some(value))` or `Some(None)`.

**Data flow**: Accepts a serde `Deserializer`, invokes `Option::<T>::deserialize(deserializer)`, then maps the result into `Some(decoded_inner_option)`. The returned value is `Result<Option<Option<T>>, D::Error>`; no external state is mutated.

**Call relations**: Paired with `optional_option::serialize` for serde on clearable patch fields. It is exercised indirectly by the JSON round-trip tests, where explicit `null` must become `Some(None)` rather than disappearing.

*Call graph*: 1 external calls (deserialize).


##### `GitInfoPatch::merge`  (lines 464–474)

```
fn merge(&mut self, next: Self)
```

**Purpose**: Combines another Git metadata patch into the current one using field-presence semantics. Only fields explicitly present in `next` replace the current patch state; omitted fields leave the existing pending patch untouched.

**Data flow**: Takes `&mut self` and an owned `next: GitInfoPatch`. For each field (`sha`, `branch`, `origin_url`), it checks whether `next.<field>.is_some()`. If so, it assigns that tri-state value into `self`; otherwise it preserves the current field. It returns `()` and mutates `self` in place.

**Call relations**: Called from `ThreadMetadataPatch::merge` when the incoming thread metadata patch contains nested Git changes. Its role is to preserve the same omission/set/clear semantics inside the nested `git_info` object instead of replacing the whole nested patch wholesale.


##### `ThreadMetadataPatch::merge`  (lines 561–630)

```
fn merge(&mut self, next: Self)
```

**Purpose**: Merges an incoming metadata patch into an existing patch accumulator, preserving the distinction between omitted fields, replacements, and explicit clears. It supports nested patch composition for `git_info` so partial Git updates do not discard previously accumulated Git field edits.

**Data flow**: Consumes `next: ThreadMetadataPatch` and mutates `&mut self`. For each top-level field, it checks whether `next` carries a value (`is_some()` for ordinary `Option<T>` fields, or outer-option presence for `ClearableField<T>` fields); present fields overwrite `self`, absent ones are ignored. For `git_info`, if `next.git_info` is `Some`, it creates `self.git_info` with `GitInfoPatch::default` if needed and then delegates to `GitInfoPatch::merge`. It returns `()` after updating the in-memory patch object.

**Call relations**: This is the core patch-composition routine for metadata updates and is directly validated by `tests::thread_metadata_patch_merge_uses_presence_semantics`. Within the call flow, higher layers can accumulate multiple partial metadata observations before persisting them, and this method ensures later observations only replace fields they explicitly mention.


##### `ThreadMetadataPatch::is_empty`  (lines 632–655)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a metadata patch is a complete no-op. It returns true only when every patchable field, including nested `git_info`, is absent.

**Data flow**: Reads all fields on `&self` and evaluates a conjunction of `is_none()` checks across every optional member. It produces a `bool` and does not mutate state or perform I/O.

**Call relations**: Used by callers and tests to detect legacy or empty patch payloads before attempting an update. `tests::thread_metadata_patch_accepts_missing_fields` relies on it to confirm that deserializing `{}` yields a harmless no-op patch.

*Call graph*: 1 external calls (is_none).


##### `tests::thread_metadata_patch_round_trips_optional_clears`  (lines 691–715)

```
fn thread_metadata_patch_round_trips_optional_clears()
```

**Purpose**: Verifies that clearable top-level metadata fields serialize explicit clears as JSON `null` and deserialize them back into `Some(None)`. This protects the tri-state patch contract for fields like `name` and agent/thread-source metadata.

**Data flow**: Builds a `ThreadMetadataPatch` with several clear requests and default values elsewhere, serializes it with `serde_json::to_value`, asserts the resulting JSON fields are `null`, then deserializes with `serde_json::from_value` and asserts the decoded patch preserves `Some(None)` for each field. It only reads/writes local test values.

**Call relations**: Runs under the test harness as a regression test for the `optional_option` serde adapter on top-level clearable fields. It indirectly exercises both custom serde helpers and the struct field annotations.

*Call graph*: 4 external calls (default, assert_eq!, from_value, to_value).


##### `tests::git_info_patch_round_trips_optional_clears`  (lines 718–747)

```
fn git_info_patch_round_trips_optional_clears()
```

**Purpose**: Checks that nested Git patch fields preserve omission, concrete replacement, and explicit clear semantics through JSON serialization. In particular, omitted `sha` stays absent, `branch` becomes a string, and `origin_url` becomes `null`.

**Data flow**: Constructs a `ThreadMetadataPatch` containing a `GitInfoPatch`, serializes it to JSON, asserts the nested `git_info` object contains only the expected keys and values, then deserializes and compares the reconstructed nested patch against the original tri-state structure. No external state is touched.

**Call relations**: Executed by the test harness to validate the nested patch encoding path. It complements the top-level clear-field test by proving the same semantics hold inside `git_info`.

*Call graph*: 4 external calls (default, assert_eq!, from_value, to_value).


##### `tests::thread_metadata_patch_accepts_missing_fields`  (lines 750–755)

```
fn thread_metadata_patch_accepts_missing_fields()
```

**Purpose**: Confirms backward-compatible deserialization of an empty JSON object into a valid no-op metadata patch. This ensures older or sparse clients can omit all fields without causing errors or accidental updates.

**Data flow**: Deserializes `json!({})` into `ThreadMetadataPatch`, then calls `is_empty()` and asserts the result is true. It operates entirely on local test data.

**Call relations**: Invoked by the test harness as a compatibility test for serde defaults and `ThreadMetadataPatch::is_empty`. It verifies the file’s patch schema tolerates absent fields rather than requiring explicit nulls or values.

*Call graph*: 3 external calls (assert!, json!, from_value).


##### `tests::thread_metadata_patch_merge_uses_presence_semantics`  (lines 758–793)

```
fn thread_metadata_patch_merge_uses_presence_semantics()
```

**Purpose**: Validates that patch merging updates only explicitly present fields, preserves omitted fields, and merges nested Git patches field-by-field. It demonstrates the intended semantics for composing multiple metadata observations.

**Data flow**: Creates an initial mutable `ThreadMetadataPatch` with existing values, merges in a second patch containing a clear for `name`, no update for `preview`, a new `title`, and partial nested Git changes, then asserts the final patch state: cleared `name`, preserved `preview`, added `title`, preserved Git `sha`, updated Git `branch`, and cleared Git `origin_url`. It mutates only local test variables.

**Call relations**: Runs under the test harness and directly exercises `ThreadMetadataPatch::merge`, which in turn delegates nested work to `GitInfoPatch::merge`. It is the main executable specification for the file’s merge-by-presence behavior.

*Call graph*: 2 external calls (default, assert_eq!).


### UI-facing application types
These files define small but shared application event and startup-error contracts used by the terminal UI layer.

### `tui/src/app_event.rs`

`data_model` · `cross-cutting`

This file is the central message schema for the TUI: `AppEvent` is a very large enum whose variants encode nearly every cross-component action, including thread lifecycle operations, command submission, history lookup, startup completion, shutdown, file search, rate-limit refreshes, plugin and marketplace workflows, MCP inventory fetches, transcript consolidation, model/personality/permission updates, Windows sandbox prompts, skills/apps/hooks toggles, feedback submission, status-line customization, and keymap editing. The design keeps widgets decoupled from `App` internals by having them emit typed requests instead of directly mutating global state.

Besides `AppEvent`, the file defines small domain types that parameterize those events: `ThreadGoalSetMode` controls whether a goal draft confirms, replaces, or updates an existing goal; `HistoryLookupResponse` carries a log offset, log id, and optional entry text; `ConsolidationScrollbackReflow` tells transcript consolidation whether terminal scrollback must be rebuilt; `WindowsSandboxEnableMode` distinguishes elevated vs legacy setup; `ConnectorsSnapshot` wraps connector `AppInfo` rows; `RateLimitRefreshOrigin` preserves why a refresh was started so completion handlers can route results correctly; `KeymapEditIntent` distinguishes replacing all bindings, adding alternates, or replacing one specific key; `PermissionProfileSelection`, `ExitMode`, and `FeedbackCategory` capture UI choices that must survive asynchronous handling.

A notable design choice is that many variants carry both request metadata and eventual result payloads, so the app loop can correlate asynchronous completions with the initiating UI card or popup without shared mutable widget state.

#### Function details

##### `PluginLocation::into_request_params`  (lines 100–105)

```
fn into_request_params(self) -> (Option<AbsolutePathBuf>, Option<String>)
```

**Purpose**: Converts the TUI's `PluginLocation` enum into the two optional request fields expected by plugin-install RPC code: either a local marketplace path or a remote marketplace name.

**Data flow**: It consumes `self`. For `PluginLocation::Local { marketplace_path }`, it returns `(Some(marketplace_path), None)`; for `PluginLocation::Remote { marketplace_name }`, it returns `(None, Some(marketplace_name))`. It does not mutate external state.

**Call relations**: This helper is used by `fetch_plugin_install` when the app layer turns a user-selected plugin source into request parameters for the app-server install call. It isolates the enum-to-wire-shape mapping so install code does not need to pattern-match on location variants itself.

*Call graph*: called by 1 (fetch_plugin_install).


### `tui/src/startup_error.rs`

`data_model` · `startup error reporting and recovery decisions`

This file contains a single error type, `LocalStateDbStartupError`, used when the TUI cannot initialize its local SQLite-backed state database. The struct stores two concrete pieces of information: the `PathBuf` of the database file that failed and a free-form `detail` string describing the underlying problem. A `thiserror::Error` derive supplies the formatted display message, embedding the database path directly into the error text so logs and recovery flows can point users at the exact file involved.

The implementation intentionally exposes small accessor methods rather than public fields. `database_path()` returns the stored path as `&Path`, and `state_db_path()` is a compatibility alias that forwards to it. `detail()` returns the underlying message as `&str`. This shape supports startup recovery code that needs to inspect the failing path, decide whether an automatic backup/reset is safe, and present a concise explanation to the user without taking ownership of the stored strings. The type itself is narrowly scoped and immutable after construction, making it a stable carrier for startup diagnostics and remediation decisions.

#### Function details

##### `LocalStateDbStartupError::new`  (lines 15–20)

```
fn new(database_path: PathBuf, detail: String) -> Self
```

**Purpose**: Constructs a new startup error from the failing database path and a descriptive detail message. It packages the two values into the immutable error struct.

**Data flow**: Takes ownership of a `PathBuf` and a `String`, stores them in `Self`, and returns the new `LocalStateDbStartupError`. It writes only the newly created struct.

**Call relations**: This constructor is used by `backup_backs_up_only_failed_database_file` and `backup_replaces_blocking_sqlite_home_file` when those startup-recovery paths need to synthesize a precise initialization failure.

*Call graph*: called by 2 (backup_backs_up_only_failed_database_file, backup_replaces_blocking_sqlite_home_file).


##### `LocalStateDbStartupError::database_path`  (lines 22–24)

```
fn database_path(&self) -> &Path
```

**Purpose**: Returns the path of the database file whose initialization failed. It exposes the stored `PathBuf` as a borrowed `&Path` for inspection without cloning.

**Data flow**: Takes `&self`, reads `self.database_path`, converts it with `as_path()`, and returns `&Path`. It does not mutate any state.

**Call relations**: This accessor is called by `backup_files_for_fresh_start`, `sqlite_home_is_blocking_file`, and `state_db_path` when recovery logic needs the exact filesystem location involved in the startup error.

*Call graph*: called by 3 (backup_files_for_fresh_start, sqlite_home_is_blocking_file, state_db_path); 1 external calls (as_path).


##### `LocalStateDbStartupError::state_db_path`  (lines 26–28)

```
fn state_db_path(&self) -> &Path
```

**Purpose**: Provides a compatibility-named accessor for the failed database path. It exists as a semantic alias to `database_path()`.

**Data flow**: Takes `&self`, delegates directly to `self.database_path()`, and returns the resulting `&Path`. It reads but does not modify the struct.

**Call relations**: This method is a thin wrapper over `database_path`, preserving older call sites or naming expectations while keeping one canonical implementation.

*Call graph*: calls 1 internal fn (database_path).


##### `LocalStateDbStartupError::detail`  (lines 30–32)

```
fn detail(&self) -> &str
```

**Purpose**: Returns the stored explanatory detail string for the startup failure. Callers use it to classify or display the underlying problem.

**Data flow**: Takes `&self`, reads `self.detail`, converts it to `&str` with `as_str()`, and returns that slice. It performs no mutation.

**Call relations**: This accessor is used by `is_auto_backup_recoverable` when deciding whether the startup failure can be handled automatically based on the error text.

*Call graph*: called by 1 (is_auto_backup_recoverable).
