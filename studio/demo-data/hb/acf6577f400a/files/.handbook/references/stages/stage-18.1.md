# Core shared protocol and domain types  `stage-18.1`

This stage is shared behind-the-scenes support. It is the project’s common dictionary: the names, message shapes, settings, and status labels that many crates use so they do not invent different versions of the same idea. The main protocol files define stable IDs for threads and sessions, safe agent and tool names, user input, conversation items, client requests, agent events, account data, approvals, permissions, errors, model info, MCP data, dynamic tools, command categories, memory citations, and network decisions. Config files describe user-visible settings and defaults. Plugin, tool, and skill files define how add-ons are named, described, discovered, filtered, and shown. Execution and network policy files describe allowed, blocked, or approval-needed actions and the reason codes used when something is refused. State, thread-store, and graph files define how conversations, spawned threads, memories, and process results are saved and reported. The TUI, cloud task, and startup error types give user interfaces and services the same event and error vocabulary. Together, these files act like standard forms that every department fills out the same way.

## Files in this stage

### Protocol crate foundation
These files establish the protocol crate’s shared identifiers, low-level value types, and crate-wide module surface before higher-level schemas build on them.

### `protocol/src/thread_id.rs`

`data_model` · `cross-cutting`

`ThreadId` is a small wrapper around a UUID, which is a widely used kind of unique identifier. Its job is to stop the rest of the system from passing around loose strings when it really means “the ID of a thread.” That matters because plain strings are easy to mix up, mistype, or serialize inconsistently.

The file gives the system three main abilities. First, it can create a fresh thread ID using a version 7 UUID, which is designed to be unique and roughly time-ordered. Second, it can read an ID back from text and reject invalid text instead of silently accepting bad data. Third, it teaches common tools how to treat `ThreadId`: how to print it, convert it to and from JSON, describe it in a JSON schema, and expose it to TypeScript as a string.

A helpful analogy is a labeled badge. The UUID is the badge number, but `ThreadId` is the badge type that says, “this number belongs to a thread.” That extra label helps the code stay honest while still letting outside systems see a simple string.

#### Function details

##### `ThreadId::new`  (lines 18–22)

```
fn new() -> Self
```

**Purpose**: Creates a brand-new thread ID. Code uses this when it is starting a new thread and needs a unique name for it.

**Data flow**: Nothing is passed in. The function asks the UUID library to make a new version 7 UUID, wraps that value inside `ThreadId`, and returns the new ID.

**Call relations**: This is the starting point whenever tests or runtime code need a fresh thread identifier. `ThreadId::default` also uses it, so code that asks for a default thread ID gets a real new ID rather than an empty placeholder.

*Call graph*: called by 465 (collab_resume_begin_maps_to_item_started_resume_agent, collab_resume_end_maps_to_item_completed_resume_agent, ignores_user_message_item_lifecycle_events, preserves_user_message_client_id_from_legacy_event, rebuilds_sleep_item_from_persisted_completion, command_execution_started_helper_emits_once, complete_command_execution_item_emits_declined_once_for_pending_command, guardian_assessment_aborted_emits_completed_review_payload, guardian_assessment_completed_emits_review_payload, guardian_assessment_started_uses_event_turn_id_fallback (+15 more)); 1 external calls (now_v7).


##### `ThreadId::from_string`  (lines 24–28)

```
fn from_string(s: &str) -> Result<Self, uuid::Error>
```

**Purpose**: Turns text into a `ThreadId`, but only if the text is a valid UUID. This is useful when an ID comes from JSON, a database, an API request, or a test fixture.

**Data flow**: A string slice goes in. The function asks the UUID library to parse it. If parsing succeeds, the UUID is wrapped in `ThreadId`; if parsing fails, the UUID parsing error comes back.

**Call relations**: Other conversion paths rely on this function so parsing rules stay in one place. It is used wherever the system receives a thread ID as plain text and needs to turn it into the safer internal type.

*Call graph*: called by 318 (thread_id, compaction_event_ingests_custom_fact, subagent_events_use_inherited_connection_unless_turn_connection_is_explicit, subagent_thread_started_other_serializes_explicit_parent_thread_id, subagent_thread_started_thread_spawn_serializes_thread_lineage, conversation_id_serializes_as_plain_string, serialize_get_conversation_summary, serialize_server_request, rollback_response_rebuilds_pathless_thread_from_stored_history, source_kind_matches_distinguishes_subagent_variants (+15 more)); 1 external calls (parse_str).


##### `ThreadId::try_from`  (lines 42–44)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: Provides a standard Rust conversion from text into `ThreadId` that can fail. Someone would use this when they want normal conversion syntax but still want invalid UUID strings to be rejected.

**Data flow**: Text goes in, either directly or as an owned `String` depending on the conversion being used. The function passes that text to `ThreadId::from_string`; the result is either a valid `ThreadId` or a parsing error.

**Call relations**: This is a convenience layer over `ThreadId::from_string`. Callers in tests and reconstruction code can use Rust’s `try_from` pattern while still sharing the same validation behavior.

*Call graph*: called by 10 (reconstructs_collab_spawn_end_item_with_model_metadata, reconstructs_interrupted_send_input_as_completed_collab_call, test_model_client_session, fixed_thread_id, try_from, try_from, get_phase2_input_selection, stage1_output_from_row_if_thread_enabled, generic_url_target, suggestion_target); 1 external calls (from_string).


##### `String::from`  (lines 48–50)

```
fn from(value: ThreadId) -> Self
```

**Purpose**: Converts a `ThreadId` back into ordinary text. This is useful when the ID needs to be stored, sent over an API, or compared as a string.

**Data flow**: A `ThreadId` goes in. The function formats it as its UUID text form and returns that `String`.

**Call relations**: This complements the parsing functions. After the system has used the safer `ThreadId` type internally, this conversion lets it hand the value back to places that expect plain text.

*Call graph*: 1 external calls (to_string).


##### `ThreadId::default`  (lines 54–56)

```
fn default() -> Self
```

**Purpose**: Provides the default value for `ThreadId`, and that default is a fresh real ID. It avoids using a fake all-zero UUID as a fallback.

**Data flow**: Nothing is passed in. The function calls `ThreadId::new` and returns the newly generated ID.

**Call relations**: Any code that asks Rust for a default `ThreadId` is routed through normal ID creation. The test in this file checks that this path does not produce the nil, or all-zero, UUID.

*Call graph*: called by 59 (app_server_event_sink_uses_listener_fifo_for_goal_updates_and_clears, record_initial_history_reconstructs_typed_inter_agent_message, record_initial_history_resumed_aborted_turn_without_id_clears_active_turn_for_compaction_accounting, record_initial_history_resumed_bare_turn_context_does_not_hydrate_previous_turn_settings, record_initial_history_resumed_bare_turn_context_does_not_seed_reference_context_item, record_initial_history_resumed_does_not_seed_reference_context_item_after_compaction, record_initial_history_resumed_hydrates_previous_turn_settings_from_lifecycle_turn_with_missing_turn_context_id, record_initial_history_resumed_replaced_incomplete_compacted_turn_clears_reference_context_item, record_initial_history_resumed_rollback_drops_incomplete_user_turn_compaction_metadata, record_initial_history_resumed_rollback_skips_only_user_turns (+15 more)); 1 external calls (new).


##### `ThreadId::fmt`  (lines 60–62)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Defines how a `ThreadId` is printed for humans or logs. It prints as the underlying UUID string.

**Data flow**: The function receives a `ThreadId` and a formatter, which is Rust’s object for building formatted text. It writes the UUID’s normal text form into that formatter and returns whether formatting succeeded.

**Call relations**: This supports `.to_string()` and other display-style formatting. The string conversion and serializer depend on this kind of text representation being stable and ordinary.

*Call graph*: 1 external calls (fmt).


##### `ThreadId::serialize`  (lines 66–71)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Teaches Serde, the Rust serialization library, how to write a `ThreadId` into formats like JSON. It stores the ID as a simple string, not as an object with internal fields.

**Data flow**: A `ThreadId` and a serializer go in. The function gives the UUID’s text form to the serializer. The output is whatever serialized representation the chosen format produces, such as a JSON string.

**Call relations**: This is used whenever protocol messages containing thread IDs are sent, saved, or compared in serialized form. It keeps the public wire format simple while preserving the safer internal type.

*Call graph*: 1 external calls (collect_str).


##### `ThreadId::deserialize`  (lines 75–82)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Teaches Serde how to read a `ThreadId` from serialized data. It expects a string and rejects it if it is not a valid UUID.

**Data flow**: Serialized input goes in through a deserializer. The function first reads a `String`, then parses that string as a UUID. On success it returns a `ThreadId`; on failure it reports a deserialization error.

**Call relations**: This is the receiving-side partner to `ThreadId::serialize`. When JSON or another serialized format enters the system, this function turns the plain string back into the checked internal type.

*Call graph*: 2 external calls (deserialize, parse_str).


##### `ThreadId::schema_name`  (lines 86–88)

```
fn schema_name() -> String
```

**Purpose**: Gives schema-generation tools the name `ThreadId` for this type. A schema is a machine-readable description of what data should look like.

**Data flow**: Nothing is passed in. The function returns the fixed name `ThreadId` as a string.

**Call relations**: Schema generation calls this when documenting or validating protocol shapes. The name helps generated documentation and tooling refer to this type clearly.


##### `ThreadId::json_schema`  (lines 90–92)

```
fn json_schema(generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Describes `ThreadId` in JSON Schema as a string. This matches how the ID is actually serialized.

**Data flow**: A schema generator goes in. Instead of exposing the internal UUID field, the function reuses the schema for `String` and returns that schema.

**Call relations**: This works with `ThreadId::schema_name` to keep generated protocol schemas simple. Outside clients see that a thread ID is sent as text, just like the JSON serializer produces.

*Call graph*: 1 external calls (json_schema).


##### `tests::test_thread_id_default_is_not_zeroes`  (lines 99–102)

```
fn test_thread_id_default_is_not_zeroes()
```

**Purpose**: Checks that the default `ThreadId` is a real generated ID, not the all-zero UUID. This protects against accidentally using a meaningless placeholder as a thread identifier.

**Data flow**: The test creates a default `ThreadId`, reads its internal UUID, and compares it with the UUID library’s nil value. The test passes only if they are different.

**Call relations**: This test exercises `ThreadId::default`, which in turn uses `ThreadId::new`. It acts as a small safety check for code paths that rely on default thread IDs being usable.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_ne!).


### `protocol/src/session_id.rs`

`data_model` · `cross-cutting: whenever sessions are created, converted, serialized, or read from protocol data`

A session needs a stable label so different parts of the system can agree which conversation or run they are talking about. This file provides that label as `SessionId`. Internally it stores a UUID, which is a widely used unique identifier. To the outside world, though, it behaves like a plain string, because strings are easy to put in logs, JSON messages, TypeScript types, and API schemas.

The main type is a small wrapper around a UUID. New session IDs are made with UUID version 7, which is designed to be unique and roughly time-ordered. The file also teaches Rust how to turn a `SessionId` into text, parse it back from text, serialize and deserialize it through Serde, and describe it for JSON Schema as a string. In practical terms, this is the plumbing that lets the same ID travel safely between Rust code, JSON APIs, and TypeScript clients.

One important detail is that `SessionId` can convert to and from `ThreadId` without changing the underlying UUID. That means some parts of the protocol can treat a thread and a session as related views of the same identifier when needed. The tests check that default IDs are real generated IDs, not all-zero placeholders, and that conversion through `ThreadId` preserves the value.

#### Function details

##### `SessionId::new`  (lines 20–24)

```
fn new() -> Self
```

**Purpose**: Creates a fresh session identifier. Use this when the system starts a new session and needs a unique name for it.

**Data flow**: It takes no input. It asks the UUID library to make a new version 7 UUID, then wraps that UUID in a `SessionId`. The result is a new `SessionId` value ready to store, compare, print, or send over the protocol.

**Call relations**: This is the source of new session IDs. It is called by setup and test flows such as `websocket_harness_with_provider_options`, `config_summary_entries_include_runtime_workspace_roots`, and event-sending tests when they need a realistic session identity.

*Call graph*: called by 5 (websocket_harness_with_provider_options, config_summary_entries_include_runtime_workspace_roots, test_send_event_as_notification, test_send_event_as_notification_with_meta, test_send_event_as_notification_with_meta_and_thread_id); 1 external calls (now_v7).


##### `SessionId::from_string`  (lines 26–30)

```
fn from_string(s: &str) -> Result<Self, uuid::Error>
```

**Purpose**: Builds a `SessionId` from text. Use this when an ID arrives from JSON, a log, a stored value, or another string-based source.

**Data flow**: It receives a string slice. It asks the UUID library to parse that string as a UUID. If parsing succeeds, it wraps the UUID in `SessionId`; if the text is not a valid UUID, it returns the parsing error.

**Call relations**: This is the main text-to-session conversion helper. It is used by flows like `session_configured_from_thread_response` and `serialize_event`, where session IDs need to be reconstructed from their string form.

*Call graph*: called by 2 (session_configured_from_thread_response, serialize_event); 1 external calls (parse_str).


##### `SessionId::try_from`  (lines 44–46)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: Provides a standard Rust conversion path from a string-like value into a `SessionId`, with failure if the text is not a valid UUID.

**Data flow**: It receives text, forwards that text to `SessionId::from_string`, and returns either the parsed `SessionId` or the UUID parsing error unchanged.

**Call relations**: This function exists so generic Rust conversion code can say “try to make a `SessionId` from this string” without knowing the parsing details. It delegates the real work to `SessionId::from_string`.

*Call graph*: 1 external calls (from_string).


##### `String::from`  (lines 50–52)

```
fn from(value: SessionId) -> Self
```

**Purpose**: Turns a `SessionId` into an ordinary `String`. Use this when code needs to pass the ID to something that expects plain text.

**Data flow**: It receives a `SessionId`, formats it using its string representation, and returns that text as a `String`. The original identifier value is consumed by the conversion.

**Call relations**: This supports standard Rust `From` conversion in the outward direction: from a typed session ID to plain text. It relies on the display formatting behavior defined for `SessionId`.

*Call graph*: 1 external calls (to_string).


##### `SessionId::from`  (lines 56–58)

```
fn from(value: ThreadId) -> Self
```

**Purpose**: Creates a `SessionId` from a `ThreadId` while keeping the exact same underlying UUID. This is useful when a thread identity should also be treated as a session identity.

**Data flow**: It receives a `ThreadId`, reads its UUID, and puts that UUID into a new `SessionId`. No new ID is generated and no text parsing happens.

**Call relations**: This conversion is used in session and subagent setup flows such as `make_session_and_context`, `session_configured_produces_thread_started_event`, and `stream_stage_one_prompt`. The test `converts_to_and_from_thread_id` also uses it to prove the conversion does not change the identity.

*Call graph*: called by 8 (new, emit_subagent_session_started_includes_fork_lineage_from_session_configuration, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, resumed_subagent_session_keeps_inherited_session_id, session_configured_produces_thread_started_event, stream_stage_one_prompt, converts_to_and_from_thread_id).


##### `ThreadId::from`  (lines 62–64)

```
fn from(value: SessionId) -> Self
```

**Purpose**: Creates a `ThreadId` from a `SessionId` while preserving the same UUID. This lets code move back from the session view of an ID to the thread view.

**Data flow**: It receives a `SessionId`, copies out its UUID, and returns a `ThreadId` containing that UUID. The identity remains the same; only the wrapper type changes.

**Call relations**: This is the reverse of `SessionId::from` for `ThreadId`. Together, they let session-oriented and thread-oriented parts of the protocol share the same identifier without inventing a new one.


##### `SessionId::default`  (lines 68–70)

```
fn default() -> Self
```

**Purpose**: Provides the default way to make a `SessionId`, which is to create a fresh one. This keeps default construction safe instead of producing an empty or placeholder ID.

**Data flow**: It takes no input. It calls `SessionId::new` and returns the newly generated ID.

**Call relations**: This is used when Rust code asks for a default `SessionId`. The test `tests::test_session_id_default_is_not_zeroes` calls it to confirm the default is a real generated UUID, not the all-zero UUID.

*Call graph*: called by 1 (test_session_id_default_is_not_zeroes); 1 external calls (new).


##### `SessionId::fmt`  (lines 74–76)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Defines how a `SessionId` appears as text when printed or formatted. This makes logs, error messages, and string conversions show the UUID clearly.

**Data flow**: It receives a `SessionId` and a formatter. It forwards formatting to the inner UUID, so the output is the usual UUID string form.

**Call relations**: This formatting behavior is used anywhere `SessionId` is turned into text, including the `String::from` conversion and serializer behavior that collects the ID as a string.

*Call graph*: 1 external calls (fmt).


##### `SessionId::serialize`  (lines 80–85)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Tells Serde, the Rust serialization library, to write a `SessionId` as a string. This is what makes the ID appear naturally in JSON and other serialized formats.

**Data flow**: It receives a `SessionId` and a serializer. It gives the UUID’s text form to the serializer, which produces the final serialized output for the chosen format.

**Call relations**: This is used whenever protocol data containing a `SessionId` is sent or stored through Serde. It ensures outside systems see a simple string rather than Rust’s internal wrapper structure.

*Call graph*: 1 external calls (collect_str).


##### `SessionId::deserialize`  (lines 89–96)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Tells Serde how to read a `SessionId` back from serialized data. It expects the incoming value to be a string containing a valid UUID.

**Data flow**: It receives a deserializer, reads a `String` from it, and tries to parse that string as a UUID. If parsing works, it returns a `SessionId`; if not, it turns the UUID parsing failure into a Serde error.

**Call relations**: This is the counterpart to `SessionId::serialize`. It is used when JSON or another serialized format is read back into Rust protocol types and the plain string must become a strongly typed `SessionId` again.

*Call graph*: 2 external calls (deserialize, parse_str).


##### `SessionId::schema_name`  (lines 100–102)

```
fn schema_name() -> String
```

**Purpose**: Gives the JSON Schema name for this type. JSON Schema is a machine-readable description of what valid JSON data should look like.

**Data flow**: It takes no input and returns the fixed name `SessionId` as a string.

**Call relations**: Schema generation code calls this when it needs a human-readable type name for `SessionId` in generated API or protocol documentation.


##### `SessionId::json_schema`  (lines 104–106)

```
fn json_schema(generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Describes a `SessionId` in JSON Schema as a string. This matches how the ID is actually serialized over the wire.

**Data flow**: It receives a schema generator and asks the existing `String` schema logic to produce the schema. The result is a schema saying that this value is represented as text.

**Call relations**: This keeps generated schemas aligned with serialization. Since `SessionId::serialize` writes a string, this function hands off to the string schema generator instead of exposing the internal UUID wrapper.

*Call graph*: 1 external calls (json_schema).


##### `tests::test_session_id_default_is_not_zeroes`  (lines 114–117)

```
fn test_session_id_default_is_not_zeroes()
```

**Purpose**: Checks that the default `SessionId` is a real generated ID, not the all-zero UUID. This protects against accidentally using a meaningless placeholder as a session identity.

**Data flow**: It creates a default `SessionId`, compares its inner UUID with the nil UUID, and passes only if they are different.

**Call relations**: This test calls `SessionId::default`, which in turn calls `SessionId::new`. It verifies the expected behavior of default construction.

*Call graph*: calls 1 internal fn (default); 1 external calls (assert_ne!).


##### `tests::converts_to_and_from_thread_id`  (lines 120–125)

```
fn converts_to_and_from_thread_id()
```

**Purpose**: Checks that converting between `ThreadId` and `SessionId` preserves the same identity. This guards the assumption that these two ID types can share one UUID safely.

**Data flow**: It creates a new `ThreadId`, converts it into a `SessionId`, converts that back into a `ThreadId`, and checks that the final value equals the original.

**Call relations**: This test exercises the conversion functions `SessionId::from` and `ThreadId::from`. It confirms that no new UUID is generated and no value is lost during the round trip.

*Call graph*: calls 2 internal fn (from, new); 1 external calls (assert_eq!).


### `protocol/src/agent_path.rs`

`data_model` · `cross-cutting: used whenever agent paths are created, loaded, displayed, serialized, or resolved`

Agents in this project live in a tree, much like folders on a computer. This file wraps a plain text path in an `AgentPath` type so the rest of the system does not have to guess whether a path is valid. A valid normal path starts at `/root`, and each child name must be simple: lowercase letters, digits, and underscores only. There is also a special path, `/morpheus`, which is allowed even though it is not under `/root`.

The main value of this file is safety and consistency. Without it, one part of the system might accept `/root/Worker`, another might accept `/root/../other`, and a third might treat an empty string as meaningful. That would make agent lookup, message routing, and storage unreliable.

`AgentPath` can create the root and Morpheus paths, check whether a path is root, return the final name in the path, join a child name onto a parent path, and resolve either relative references like `worker` or absolute references like `/root/other`. It also teaches Rust and serialization tools how to treat an `AgentPath` as a string when saving, loading, displaying, or passing it across boundaries. The small validation helpers at the bottom are the gatekeepers that reject bad names early.

#### Function details

##### `AgentPath::root`  (lines 22–24)

```
fn root() -> Self
```

**Purpose**: Creates the standard root agent path, `/root`. Code uses this when it needs the top of the agent tree.

**Data flow**: No input is needed. The function takes the built-in root path text and wraps it as an `AgentPath`. The result is a ready-to-use path for the root agent.

**Call relations**: Many parts of the system call this when they need a safe starting point for agent lookup, messaging, listing, tests, or recovery. It does not delegate to validation because `/root` is a fixed known-good value.

*Call graph*: called by 38 (list_agents, encrypted_inter_agent_communication_clears_existing_last_task_message, ensure_v2_agent_loaded_reloads_registered_unloaded_agent, list_agent_subtree_thread_ids_includes_anonymous_and_closed_descendants, multi_agent_v2_completion_ignores_dead_direct_parent, multi_agent_v2_completion_queues_message_for_direct_parent, resume_agent_from_rollout_does_not_reopen_v2_descendants, send_inter_agent_communication_without_turn_queues_message_without_triggering_turn, spawn_agent_can_fork_parent_thread_history_with_sanitized_items, spawn_agent_fork_last_n_turns_keeps_only_recent_turns (+15 more)).


##### `AgentPath::morpheus`  (lines 26–28)

```
fn morpheus() -> Self
```

**Purpose**: Creates the special Morpheus agent path, `/morpheus`. This is separate from the normal `/root/...` agent tree.

**Data flow**: No input is needed. The function takes the built-in Morpheus path text and wraps it as an `AgentPath`. The result is a valid special path.

**Call relations**: It is used by the Morpheus path test to confirm that this special path behaves like a normal `AgentPath` where appropriate, while not being mistaken for root.

*Call graph*: called by 1 (morpheus_has_expected_name).


##### `AgentPath::from_string`  (lines 30–33)

```
fn from_string(path: String) -> Result<Self, String>
```

**Purpose**: Turns a plain string into an `AgentPath`, but only if the string follows the project’s path rules. This is the main checkpoint for accepting stored or incoming path text.

**Data flow**: It receives a `String`. It asks `validate_absolute_path` whether the text is allowed. If validation passes, it wraps the same string in `AgentPath`; if not, it returns a clear error message.

**Call relations**: Higher-level code calls this when restoring or filtering agents from stored path strings. The conversion helpers also route through it, so there is one shared validation path instead of many slightly different ones.

*Call graph*: calls 1 internal fn (validate_absolute_path); called by 2 (resume_thread_subagent_restores_stored_nickname_and_role, multi_agent_v2_list_agents_filters_by_relative_path_prefix).


##### `AgentPath::as_str`  (lines 35–37)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the path as ordinary text without copying it. This is useful when other code needs to compare, print, store, or pass the path onward.

**Data flow**: It receives an existing `AgentPath`. It borrows the inner string slice and returns that borrowed view. Nothing is changed or allocated.

**Call relations**: Other convenience methods, such as display formatting, dereferencing, root checks, and name extraction, all call this so they read the path in the same simple way.

*Call graph*: called by 8 (agent_id_for_path, release_reserved_agent_path, forward_child_completion_to_parent, as_ref, deref, fmt, is_root, name).


##### `AgentPath::is_root`  (lines 39–41)

```
fn is_root(&self) -> bool
```

**Purpose**: Checks whether this path is exactly `/root`. Code uses this when root needs special treatment.

**Data flow**: It reads the path through `as_str`, compares it with the fixed root path text, and returns `true` or `false`. The original path is unchanged.

**Call relations**: The `name` method calls this because root’s name is handled specially. Other agent-tree logic can also use it to decide whether a path is the top of the tree.

*Call graph*: calls 1 internal fn (as_str); called by 2 (agent_matches_prefix, name).


##### `AgentPath::name`  (lines 43–52)

```
fn name(&self) -> &str
```

**Purpose**: Returns the last visible name in the path, such as `researcher` from `/root/researcher`. For `/root`, it returns `root`.

**Data flow**: It reads the current path. If the path is root, it returns the reserved root segment. Otherwise, it splits the path around `/` and returns the final non-empty segment, falling back to `root` only as a safety fallback.

**Call relations**: It builds on `is_root` and `as_str`. Callers use it when they need a human-friendly or local name for an agent rather than the full absolute path.

*Call graph*: calls 2 internal fn (as_str, is_root).


##### `AgentPath::join`  (lines 54–57)

```
fn join(&self, agent_name: &str) -> Result<Self, String>
```

**Purpose**: Creates a child path below the current agent path. For example, joining `worker` onto `/root/researcher` produces `/root/researcher/worker`.

**Data flow**: It receives the current path and a proposed child agent name. It first validates that the child name is safe, then formats parent and child with a slash between them, and finally creates a new validated `AgentPath`. On failure, it returns an error message.

**Call relations**: This is the normal way to grow the agent tree one child at a time. It relies on `validate_agent_name` for the new segment and on `from_string` to ensure the final full path is valid too.

*Call graph*: calls 1 internal fn (validate_agent_name); 2 external calls (from_string, format!).


##### `AgentPath::resolve`  (lines 59–72)

```
fn resolve(&self, reference: &str) -> Result<Self, String>
```

**Purpose**: Turns a path reference into a full `AgentPath`, using the current path as the base for relative references. This lets callers accept both `worker` and `/root/other` safely.

**Data flow**: It receives the current path and a reference string. Empty references are rejected. The exact `/root` reference becomes the root path. References starting with `/` are treated as absolute and validated directly. Other references are checked as relative segments, appended to the current path, and turned into a new `AgentPath`.

**Call relations**: This function sits between user-like input and the strict `AgentPath` type. It calls `validate_relative_reference` for relative text, uses `try_from` for absolute text, and uses `root` for the special root case.

*Call graph*: calls 1 internal fn (validate_relative_reference); 4 external calls (from_string, root, try_from, format!).


##### `AgentPath::try_from`  (lines 86–88)

```
fn try_from(value: &str) -> Result<Self, Self::Error>
```

**Purpose**: Provides Rust’s standard fallible conversion into `AgentPath`. “Fallible” means the conversion can fail if the text is not a valid path.

**Data flow**: It receives path text and passes it to `from_string`. If validation succeeds, the output is an `AgentPath`; if validation fails, the output is the validation error.

**Call relations**: Many tests and agent workflows use this conversion when they already have path text. Internally it keeps all path checking centralized by handing off to `from_string`.

*Call graph*: called by 29 (interrupted_subagent_activity_removes_missing_thread_watch, encrypted_inter_agent_communication_clears_existing_last_task_message, ensure_v2_agent_loaded_reloads_registered_unloaded_agent, send_inter_agent_communication_without_turn_queues_message_without_triggering_turn, spawn_agent_can_fork_parent_thread_history_with_sanitized_items, spawn_agent_fork_last_n_turns_keeps_only_recent_turns, agent_path, input_queue_drains_mailbox_in_delivery_order, input_queue_notifies_mailbox_subscribers, input_queue_tracks_pending_trigger_turn_mail (+15 more)); 1 external calls (from_string).


##### `String::from`  (lines 92–94)

```
fn from(value: AgentPath) -> Self
```

**Purpose**: Converts an `AgentPath` back into a plain `String`. This is useful for storage, serialization, or APIs that expect ordinary text.

**Data flow**: It receives an owned `AgentPath`, takes out its inner string, and returns that string. The `AgentPath` value is consumed in the process.

**Call relations**: Serialization support uses this pattern because the path should travel over the wire or into files as a simple string, while the Rust code can still keep the safer `AgentPath` wrapper internally.


##### `AgentPath::from_str`  (lines 100–102)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Lets code parse an `AgentPath` from a string slice using Rust’s standard parsing pattern. This is convenient for code that calls `.parse()`.

**Data flow**: It receives borrowed text, sends it through `try_from`, and returns either a valid `AgentPath` or an error message. The input text is not changed.

**Call relations**: This is another doorway into the same validation rules. Instead of duplicating checks, it delegates to `try_from`.

*Call graph*: 1 external calls (try_from).


##### `AgentPath::as_ref`  (lines 106–108)

```
fn as_ref(&self) -> &str
```

**Purpose**: Lets an `AgentPath` be borrowed as a plain string reference in generic Rust code. This avoids unnecessary copying.

**Data flow**: It receives an `AgentPath` by reference, calls `as_str`, and returns a borrowed string view. No data is changed.

**Call relations**: It is a small adapter for Rust traits. Any code that accepts something “as a string reference” can use `AgentPath` through this method.

*Call graph*: calls 1 internal fn (as_str).


##### `AgentPath::deref`  (lines 114–116)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets an `AgentPath` behave like a string slice in places where Rust’s dereference rules apply. This makes the wrapper easier to use without exposing invalid construction.

**Data flow**: It receives a borrowed `AgentPath`, calls `as_str`, and returns a borrowed `str`. The path stays unchanged.

**Call relations**: Like `as_ref`, this is a convenience bridge. It hands off to `as_str` so all string views come from the same source.

*Call graph*: calls 1 internal fn (as_str).


##### `AgentPath::fmt`  (lines 120–122)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how an `AgentPath` is printed for users, logs, and formatted strings. It prints exactly the path text.

**Data flow**: It receives the path and a formatter, reads the path through `as_str`, and writes that text into the formatter. The result reports whether writing succeeded.

**Call relations**: This supports Rust’s display formatting, such as putting an `AgentPath` inside a formatted message. It delegates the actual write to the formatter after getting the string view.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `validate_agent_name`  (lines 125–147)

```
fn validate_agent_name(agent_name: &str) -> Result<(), String>
```

**Purpose**: Checks one agent name segment, such as `researcher`, before it is allowed into a path. It blocks empty names, reserved names, slashes, uppercase letters, and other unsupported characters.

**Data flow**: It receives one proposed agent name. It runs a series of checks: not empty, not `root`, not `.` or `..`, no `/`, and only lowercase letters, digits, or underscores. It returns success if all checks pass, otherwise a specific error message.

**Call relations**: Both full-path validation and relative-reference validation call this for each segment. `join` also calls it before appending a new child name, so unsafe names are rejected at the edge.

*Call graph*: called by 3 (join, validate_absolute_path, validate_relative_reference); 1 external calls (format!).


##### `validate_absolute_path`  (lines 149–171)

```
fn validate_absolute_path(path: &str) -> Result<(), String>
```

**Purpose**: Checks whether a full path is allowed as an absolute agent path. This protects the system from paths that do not start in the expected place.

**Data flow**: It receives path text. It immediately accepts the special `/morpheus` path. Otherwise, it requires the text to start with `/`, then requires the first segment to be `root`, rejects a trailing slash, and validates every later segment as an agent name. It returns either success or a clear error.

**Call relations**: `from_string` calls this before any plain string can become an `AgentPath`. It uses `validate_agent_name` so each child segment follows the same naming rules as joined paths.

*Call graph*: calls 1 internal fn (validate_agent_name); called by 1 (from_string).


##### `validate_relative_reference`  (lines 173–181)

```
fn validate_relative_reference(reference: &str) -> Result<(), String>
```

**Purpose**: Checks a relative path reference, such as `worker/helper`, before it is appended to a current path. It makes sure the reference cannot sneak in unsafe segments.

**Data flow**: It receives relative reference text. It rejects a trailing slash, then splits the reference into segments and validates each segment with `validate_agent_name`. It returns success or the first error it finds.

**Call relations**: `resolve` calls this when the reference does not start with `/`. This keeps relative navigation simple and safe: no empty trailing segment, no `..`, and no invalid agent names.

*Call graph*: calls 1 internal fn (validate_agent_name); called by 1 (resolve).


##### `tests::root_has_expected_name`  (lines 189–194)

```
fn root_has_expected_name()
```

**Purpose**: Checks that the root path is created correctly and reports itself as root. This protects the special root behavior from accidental changes.

**Data flow**: The test creates `AgentPath::root`, reads its string form, asks for its name, and checks whether it is root. The expected results are `/root`, `root`, and `true`.

**Call relations**: It calls the public root-related methods the way normal code would. If any of those basics change unexpectedly, this test fails early.

*Call graph*: calls 1 internal fn (root); 2 external calls (assert!, assert_eq!).


##### `tests::morpheus_has_expected_name`  (lines 197–202)

```
fn morpheus_has_expected_name()
```

**Purpose**: Checks that the special Morpheus path has the right text and name, but is not treated as the root path.

**Data flow**: The test creates `AgentPath::morpheus`, reads its string form and final name, and checks that `is_root` is false. The expected text is `/morpheus` and the expected name is `morpheus`.

**Call relations**: It exercises the Morpheus constructor and the shared name/root logic. This confirms the special path fits into the type without becoming part of the root tree.

*Call graph*: calls 1 internal fn (morpheus); 2 external calls (assert!, assert_eq!).


##### `tests::join_builds_child_paths`  (lines 205–210)

```
fn join_builds_child_paths()
```

**Purpose**: Checks that joining a valid child name onto root creates the expected child path. This verifies the basic tree-building behavior.

**Data flow**: The test starts with `/root`, joins `researcher`, then reads the resulting path and name. It expects `/root/researcher` and `researcher`.

**Call relations**: It calls `root` and then the public `join` method. This covers the common flow of creating a child agent path from a parent path.

*Call graph*: calls 1 internal fn (root); 1 external calls (assert_eq!).


##### `tests::resolve_supports_relative_and_absolute_references`  (lines 213–223)

```
fn resolve_supports_relative_and_absolute_references()
```

**Purpose**: Checks that `resolve` accepts both relative and absolute references and turns them into the right full paths.

**Data flow**: The test creates a current path `/root/researcher`. It resolves `worker` and expects `/root/researcher/worker`; it also resolves `/root/other` and expects `/root/other`.

**Call relations**: It uses `try_from` to create expected paths and compares them with `resolve` results. This confirms the two main branches inside `resolve`: relative append and absolute validation.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (assert_eq!).


##### `tests::invalid_names_and_paths_are_rejected`  (lines 226–239)

```
fn invalid_names_and_paths_are_rejected()
```

**Purpose**: Checks that bad names and bad paths produce the expected error messages. This is important because callers rely on these rejections to keep agent paths safe.

**Data flow**: The test tries to join an uppercase name, parse a path that does not start at `/root` or `/morpheus`, and resolve a reference containing `..`. Each attempt should return a specific error instead of an `AgentPath`.

**Call relations**: This test indirectly exercises `validate_agent_name`, `validate_absolute_path`, and `validate_relative_reference` through the public methods. It confirms the guardrails work from the outside, not just as private helpers.

*Call graph*: 1 external calls (assert_eq!).


### `protocol/src/tool_name.rs`

`data_model` · `cross-cutting`

This file gives the protocol a single, reliable way to talk about tool names. A tool is something the system can call, such as a shell command helper, a browser helper, or an external MCP tool. Some tools have only a simple name. Others come from a namespace, which is like a label on a drawer that says which collection the tool belongs to. Without this type, different parts of the system might join, compare, or print tool names differently, which could cause the wrong tool to be called or displayed.

The main type, `ToolName`, stores two pieces of text: the tool’s actual `name`, and an optional `namespace`. It can be created in three ways: with an explicitly optional namespace, as a plain un-namespaced name, or as a namespaced name. The file also teaches Rust how to print a `ToolName`, how to sort tool names, and how to convert ordinary strings into plain tool names.

One important detail is sorting. Namespaced and plain names are compared in a deliberate form so the system can put tool names in a stable order. That matters for predictable output, tests, and any place where tool lists must not jump around randomly.

#### Function details

##### `ToolName::new`  (lines 15–20)

```
fn new(namespace: Option<String>, name: impl Into<String>) -> Self
```

**Purpose**: Creates a `ToolName` when the caller already has a namespace that may or may not exist. This is useful when parsing or building tool calls from data where the namespace is optional.

**Data flow**: It receives an optional namespace and a name-like value. It turns the name into a `String`, keeps the namespace as given, and returns a new `ToolName` containing both pieces.

**Call relations**: Higher-level code such as `from_parts` and `build_tool_call` calls this when it has separated a tool name into its namespace part and its actual name. This function is the final small assembly step that packages those parts into the shared `ToolName` shape.

*Call graph*: called by 2 (from_parts, build_tool_call); 1 external calls (into).


##### `ToolName::plain`  (lines 22–27)

```
fn plain(name: impl Into<String>) -> Self
```

**Purpose**: Creates a tool name with no namespace. Use this for built-in or simple tools where the name alone is enough.

**Data flow**: It receives a name-like value, turns it into a `String`, sets the namespace to `None`, and returns the finished `ToolName`.

**Call relations**: Many tests and tool-definition paths call this when they need a straightforward tool name. It is the common shortcut for code that does not need to think about namespaces.

*Call graph*: called by 73 (augment_tool_definition_appends_typed_declaration, augment_tool_definition_includes_property_descriptions_as_comments, code_mode_only_description_includes_nested_tools, blocking_tool, danger_full_access_tool_attempts_do_not_enforce_managed_network, guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip, rejects_escalated_permissions_when_policy_not_on_request (+15 more)); 1 external calls (into).


##### `ToolName::namespaced`  (lines 29–34)

```
fn namespaced(namespace: impl Into<String>, name: impl Into<String>) -> Self
```

**Purpose**: Creates a tool name that belongs to a namespace. This is used when the same short tool name might exist in different tool collections, or when external tools need to stay clearly labeled.

**Data flow**: It receives a namespace and a name. It turns both into owned strings, wraps the namespace in `Some`, and returns a `ToolName` that keeps the two parts separate.

**Call relations**: Code that builds descriptions, canonical names, MCP-related tool names, and publication payloads calls this when it needs to preserve where a tool came from. This keeps namespaced tools distinct instead of flattening everything into one plain string too early.

*Call graph*: called by 32 (code_mode_only_description_groups_namespace_instructions_once, code_mode_only_description_omits_empty_namespace_sections, code_mode_only_description_renders_shared_mcp_types_once, canonical_tool_name, tool_name, image_generation_publication_is_finalized_by_core, mcp_post_tool_use_payload_uses_prefixed_tool_name_args_and_result, mcp_updated_input_rewrites_builtin_like_tool_names_as_mcp, tool_name, tool_name (+15 more)); 1 external calls (into).


##### `ToolName::fmt`  (lines 38–43)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Defines how a `ToolName` appears when it is printed or converted to display text. This matters for logs, user-facing descriptions, and serialized-looking output.

**Data flow**: It reads the `ToolName`. If there is a namespace, it writes the namespace followed directly by the tool name; if there is no namespace, it writes only the name. The output goes into Rust’s formatting system.

**Call relations**: This is called automatically whenever code formats a `ToolName` for display. It does not decide when names are shown; it only provides the shared rule for turning one into text.

*Call graph*: 2 external calls (write_str, write!).


##### `ToolName::cmp`  (lines 47–57)

```
fn cmp(&self, other: &Self) -> Ordering
```

**Purpose**: Defines the full ordering rule for sorting two tool names. This gives the system stable, repeatable ordering instead of relying on ad hoc comparisons.

**Data flow**: It reads both tool names, turns each into a comparison shape, and compares those shapes. Plain names compare by their name alone, while namespaced names compare first by namespace and then by the inner name. It returns whether this tool name comes before, after, or equal to the other one.

**Call relations**: Rust’s sorting and ordered collection machinery uses this method when it needs to order `ToolName` values. `ToolName::partial_cmp` also delegates directly to it so there is only one comparison rule.

*Call graph*: called by 1 (partial_cmp).


##### `ToolName::partial_cmp`  (lines 61–63)

```
fn partial_cmp(&self, other: &Self) -> Option<Ordering>
```

**Purpose**: Provides the optional comparison hook Rust expects for values that can be ordered. For `ToolName`, every pair can always be compared, so this simply wraps the full comparison result.

**Data flow**: It receives another `ToolName`, calls `ToolName::cmp` to get the ordering, wraps that answer in `Some`, and returns it.

**Call relations**: This sits on top of `ToolName::cmp`. Code using general comparison features may call this, and it ensures those features follow the exact same ordering rule as normal sorting.

*Call graph*: calls 1 internal fn (cmp).


##### `ToolName::from`  (lines 73–75)

```
fn from(name: &str) -> Self
```

**Purpose**: Converts ordinary text into a plain, un-namespaced `ToolName`. This lets callers pass simple strings where a `ToolName` is expected without writing extra construction code.

**Data flow**: It receives text, passes it to `ToolName::plain`, and returns the resulting `ToolName` with no namespace.

**Call relations**: This is used by Rust’s standard conversion system. When other code asks to turn a string-like value into a `ToolName`, this function routes that conversion through the plain-name constructor so the behavior stays consistent.

*Call graph*: 1 external calls (plain).


### `protocol/src/exec_output.rs`

`util` · `command execution output collection`

When the system runs a shell command, the command writes bytes, not guaranteed readable text. Most modern tools use UTF-8, but Windows shells and older programs may use legacy code pages such as CP866 or Windows-1252. If those bytes are read as the wrong encoding, users can see nonsense characters. This file is the project’s “translator” for that output.

It provides small containers for command output. `StreamOutput` stores text for one stream, such as standard output or standard error, plus a note if the text was cut off after too many lines. `ExecToolCallOutput` combines the full result of a command: exit code, stdout, stderr, combined output, how long it ran, and whether it timed out.

The main conversion path starts with raw bytes. The code first checks whether they are already valid UTF-8. If not, it asks a character-encoding detector to guess the likely encoding, then decodes the bytes. There is one important special case: short Windows-1252 text containing “smart quotes” can be mistaken for IBM866 Cyrillic text. The file includes a careful check for that pattern so quotes and dashes are shown as users expect, without wrongly changing real Cyrillic output.

#### Function details

##### `StreamOutput::new`  (lines 22–27)

```
fn new(text: String) -> Self
```

**Purpose**: Creates a new text stream result from a string. It starts with no truncation note, meaning the caller is saying this output has not been cut off.

**Data flow**: A text string goes in. The function wraps it in a `StreamOutput` object and sets `truncated_after_lines` to empty. The result is a ready-to-use stream record for stdout, stderr, or combined command output.

**Call relations**: Many parts of the command-running flow call this when they need to build output records, such as after executing a user shell command, mapping an execution result, or reporting the end of an execution. It is the simple constructor other code uses before adding the stream to a larger command result.

*Call graph*: called by 15 (make_exec_output, includes_timed_out_message, execute_user_shell_command, run, map_exec_result, emit_exec_end_for_unified_exec, emit_failed_exec_end_for_unified_exec, check_for_sandbox_denial_with_text, formats_basic_record, uses_aggregated_output_over_streams (+5 more)).


##### `StreamOutput::from_utf8_lossy`  (lines 31–36)

```
fn from_utf8_lossy(&self) -> StreamOutput<String>
```

**Purpose**: Turns a stream of raw bytes into a stream of readable text, while keeping the same truncation note. Despite the name, it uses the smarter encoding detection in this file rather than only doing basic UTF-8 replacement.

**Data flow**: A `StreamOutput` containing bytes goes in. The byte content is passed to `bytes_to_string_smart`, which tries to decode it correctly. The function returns a new `StreamOutput` containing a `String`, with `truncated_after_lines` copied unchanged.

**Call relations**: This is the bridge between byte-based process output and text-based command output. When callers have collected raw output, this function hands the bytes to `bytes_to_string_smart` and returns a stream that the rest of the system can display or store as text.

*Call graph*: calls 1 internal fn (bytes_to_string_smart).


##### `ExecToolCallOutput::default`  (lines 50–59)

```
fn default() -> Self
```

**Purpose**: Builds an empty, successful-looking command result. This is useful as a safe starting value before real command data is filled in.

**Data flow**: No input is needed. The function creates empty stdout, stderr, and combined-output streams, sets the exit code to 0, the duration to zero, and `timed_out` to false. The result is a complete `ExecToolCallOutput` with neutral default values.

**Call relations**: Code that needs an initial execution result can call this instead of filling every field by hand. It uses `StreamOutput::new` for the empty text streams, so the same stream structure is used consistently throughout command execution.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `bytes_to_string_smart`  (lines 63–74)

```
fn bytes_to_string_smart(bytes: &[u8]) -> String
```

**Purpose**: Converts arbitrary command-output bytes into a Rust `String` as accurately as possible. It solves the common problem where shell output is not valid UTF-8, especially on Windows.

**Data flow**: A slice of bytes goes in. If it is empty, the function returns an empty string. If it is already valid UTF-8, it returns that text directly. Otherwise it asks `detect_encoding` for the likely character encoding, then passes the bytes and encoding to `decode_bytes`. The output is readable text, or a best-effort replacement if perfect decoding is not possible.

**Call relations**: This is the main decoding function used when process output is collected, including through `spawn_process_output`, `collect_spawn_process_output`, and `StreamOutput::from_utf8_lossy`. It coordinates the lower-level steps: first deciding what encoding the bytes seem to use, then decoding them.

*Call graph*: calls 2 internal fn (decode_bytes, detect_encoding); called by 3 (spawn_process_output, collect_spawn_process_output, from_utf8_lossy); 2 external calls (new, from_utf8).


##### `detect_encoding`  (lines 97–116)

```
fn detect_encoding(bytes: &[u8]) -> &'static Encoding
```

**Purpose**: Guesses which character encoding was used for a byte stream. It also corrects one known bad guess where Windows smart punctuation can be mistaken for Cyrillic IBM866 text.

**Data flow**: Raw bytes go in. The function feeds them to an encoding detector, which returns a likely encoding. If the detector says IBM866, the function checks whether the bytes instead look like Windows-1252 punctuation around ordinary ASCII words. If so, it returns Windows-1252; otherwise it returns the detector’s guess.

**Call relations**: `bytes_to_string_smart` calls this after discovering the bytes are not valid UTF-8. `detect_encoding` may call `looks_like_windows_1252_punctuation` to guard against a specific real-world misread, then hands the chosen encoding back so decoding can continue.

*Call graph*: calls 1 internal fn (looks_like_windows_1252_punctuation); called by 1 (bytes_to_string_smart); 1 external calls (new).


##### `decode_bytes`  (lines 118–126)

```
fn decode_bytes(bytes: &[u8], encoding: &'static Encoding) -> String
```

**Purpose**: Decodes bytes using a chosen character encoding, while falling back safely if that decoding reports errors. This keeps bad or unexpected bytes from breaking the output display.

**Data flow**: Raw bytes and an encoding choice go in. The function asks the encoding library to decode the bytes. If the library reports decoding errors, the function falls back to a lossy UTF-8 conversion, which replaces unreadable parts rather than failing. The output is always a `String`.

**Call relations**: `bytes_to_string_smart` calls this after `detect_encoding` has chosen an encoding. It is the final step in turning raw command output into text that can be returned to users.

*Call graph*: called by 1 (bytes_to_string_smart); 2 external calls (decode, from_utf8_lossy).


##### `looks_like_windows_1252_punctuation`  (lines 141–161)

```
fn looks_like_windows_1252_punctuation(bytes: &[u8]) -> bool
```

**Purpose**: Checks whether a byte stream looks like ordinary ASCII text decorated with Windows-1252 smart punctuation, such as curly quotes or long dashes. This prevents those punctuation marks from being displayed as unrelated Cyrillic letters.

**Data flow**: A byte slice goes in. The function scans each byte. If it sees bytes outside the narrow pattern it is looking for, it returns false. It requires at least one allowed Windows-1252 punctuation byte and at least one ASCII letter. If both are present and nothing disqualifies the stream, it returns true.

**Call relations**: `detect_encoding` calls this only when the detector guessed IBM866. This helper acts like a second opinion: if the bytes match the known smart-punctuation pattern, `detect_encoding` switches to Windows-1252 before decoding.

*Call graph*: calls 1 internal fn (is_windows_1252_punct); called by 1 (detect_encoding).


##### `is_windows_1252_punct`  (lines 163–165)

```
fn is_windows_1252_punct(byte: u8) -> bool
```

**Purpose**: Answers whether one byte is one of the known Windows-1252 smart punctuation bytes handled by this file. It is a small allowlist check used to avoid guessing too broadly.

**Data flow**: One byte goes in. The function checks whether it appears in the fixed list of Windows-1252 punctuation byte values. It returns true for those known punctuation bytes and false for everything else.

**Call relations**: `looks_like_windows_1252_punctuation` calls this while scanning a byte stream. By keeping the punctuation rule narrow, it helps the larger encoding-detection path fix the smart-quotes case without damaging legitimate Cyrillic output.

*Call graph*: called by 1 (looks_like_windows_1252_punctuation).


### `protocol/src/lib.rs`

`other` · `compile-time module setup and cross-cutting imports`

This file does not contain business logic itself. Instead, it acts like the table of contents and public reception desk for the protocol crate, which is the part of the project that defines shared message shapes, identifiers, permissions, approvals, model information, tool names, and related communication rules. Without this file, the rest of the codebase would not have a clean way to find or import those pieces.

The `pub mod` lines make whole modules available to other crates, such as authentication, approvals, configuration types, protocol messages, permissions, and user input requests. The plain `mod` lines keep some smaller building blocks private to this crate, while the `pub use` lines re-export selected types like `AgentPath`, `SessionId`, `ThreadId`, and `ToolName`. Re-exporting means outside code can use these important names from one convenient place instead of needing to know the exact internal file where each one lives.

In everyday terms, this file is like a building directory: it does not do the work happening in each office, but it labels the offices and decides which doors visitors can use. That matters because protocol code is usually shared between many parts of a system, so a stable, organized public surface helps keep those parts speaking the same language.


### Core protocol schemas
These files define the main reusable protocol data models for configuration, permissions, content, tools, commands, and account-facing payloads that feed into the top-level session protocol.

### `protocol/src/permissions.rs`

`domain_logic` · `config load, sandbox setup, and runtime permission checks`

This file is the rulebook for sandbox permissions. A sandbox is a controlled area where the agent can work without freely touching the whole machine. The file describes both network access and filesystem access in plain policy objects: some policies allow full access, some allow only reading, and some allow writing only inside workspace roots. It also supports explicit "deny" rules, including glob patterns, which are path patterns such as `**/*.env`.

A key job here is deciding which rule wins for a path. The code resolves special tokens like "project roots" or "temporary directory" into real paths, then chooses the most specific matching entry. For example, a workspace may be writable, but its `.git` folder can still be read-only. This is like giving someone a key to an office but locking the filing cabinet.

The file also bridges between this newer detailed filesystem policy and an older `SandboxPolicy` format used by existing runtimes. When the old format cannot express a rule safely, the code marks that direct runtime enforcement is needed. Symlinks, missing protected directories, and Git pointer files receive special care so that the sandbox does not accidentally open a hidden route around the rules.

#### Function details

##### `is_protected_metadata_name`  (lines 35–39)

```
fn is_protected_metadata_name(name: &OsStr) -> bool
```

**Purpose**: Checks whether a filename is one of the workspace metadata names that Codex treats as sensitive: `.git`, `.agents`, or `.codex`.

**Data flow**: It receives a filename, compares it with the protected-name list, and returns true if it matches one of them.

**Call relations**: Other metadata-protection helpers use the same protected-name concept when deciding whether a write should be blocked.


##### `is_protected_metadata_directory_name`  (lines 41–44)

```
fn is_protected_metadata_directory_name(name: &OsStr) -> bool
```

**Purpose**: Checks whether a directory name is one of the protected Codex-controlled metadata directories, `.agents` or `.codex`.

**Data flow**: It receives a filename-like value, compares it with those two directory names, and returns a yes-or-no answer.

**Call relations**: It is a small public helper for callers that need to treat Codex metadata directories specially without including `.git` pointer-file behavior.

*Call graph*: 1 external calls (new).


##### `forbidden_agent_metadata_write`  (lines 48–77)

```
fn forbidden_agent_metadata_write(
    path: &Path,
    cwd: &Path,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
) -> Option<&'static str>
```

**Purpose**: Decides whether an agent write should be stopped because it targets protected workspace metadata under a writable root.

**Data flow**: It takes the target path, current working directory, and filesystem policy. It resolves the target, checks whether it falls under `.git`, `.agents`, or `.codex` inside a writable root, honors any explicit write exception, and returns the protected metadata name when the write should be blocked.

**Call relations**: This is the early warning gate before execution. It relies on path resolution, metadata-root detection, explicit-write checks, and the policy's write decision so callers can reject dangerous writes before they happen.

*Call graph*: calls 4 internal fn (can_write_path_with_cwd, has_explicit_write_entry_for_metadata_path, metadata_child_of_writable_root, resolve_candidate_path); 1 external calls (matches!).


##### `NetworkSandboxPolicy::is_enabled`  (lines 91–93)

```
fn is_enabled(self) -> bool
```

**Purpose**: Answers whether network access is allowed by this network policy.

**Data flow**: It receives the policy value and returns true only for the enabled variant.

**Call relations**: Sandbox setup and compatibility code call this when converting a high-level permission profile into concrete network behavior.

*Call graph*: called by 10 (spawn_debug_sandbox_child, should_install_network_seccomp, bwrap_network_mode, network_access_from_policy, from, to_legacy_sandbox_policy, compatibility_workspace_write_policy, should_require_platform_sandbox, dynamic_network_policy_for_network, should_apply_network_block); 1 external calls (matches!).


##### `FileSystemAccessMode::can_read`  (lines 127–129)

```
fn can_read(self) -> bool
```

**Purpose**: Answers whether this access mode allows reading.

**Data flow**: It receives an access mode and returns false only for deny; both read and write imply read permission.

**Call relations**: Policy resolution code uses this when collecting readable roots and deciding whether an entry grants enough access.

*Call graph*: called by 1 (access_covers); 1 external calls (matches!).


##### `FileSystemAccessMode::can_write`  (lines 131–133)

```
fn can_write(self) -> bool
```

**Purpose**: Answers whether this access mode allows writing.

**Data flow**: It receives an access mode and returns true only for write.

**Call relations**: Write checks, writable-root collection, and legacy conversion use this as the simple test for write authority.

*Call graph*: called by 1 (access_covers); 1 external calls (matches!).


##### `FileSystemSpecialPath::project_roots`  (lines 167–169)

```
fn project_roots(subpath: Option<PathBuf>) -> Self
```

**Purpose**: Builds the special path token that means the current project root, optionally with a subpath such as `.git`.

**Data flow**: It receives an optional subpath and returns a `ProjectRoots` special-path value containing it.

**Call relations**: Workspace-write policies use this to describe permissions relative to the active project without hard-coding one absolute directory.


##### `FileSystemSpecialPath::unknown`  (lines 171–176)

```
fn unknown(path: impl Into<String>, subpath: Option<PathBuf>) -> Self
```

**Purpose**: Builds a placeholder for a future special path token that this runtime does not understand yet.

**Data flow**: It receives the unknown token text and an optional subpath, stores both, and returns an `Unknown` value.

**Call relations**: Deserialization and compatibility paths use this so newer config files can be loaded by older runtimes and then ignored safely instead of failing outright.

*Call graph*: 1 external calls (into).


##### `FileSystemSandboxEntry::from`  (lines 186–191)

```
fn from(value: FileSystemSandboxEntry<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts a sandbox entry that uses absolute paths into one that uses URI-style paths for transport or serialization.

**Data flow**: It receives an entry, converts only the path representation, keeps the same access mode, and returns the converted entry.

**Call relations**: This supports moving permission data across protocol boundaries where file paths may be represented as URIs.


##### `FileSystemSandboxEntry::try_from`  (lines 197–202)

```
fn try_from(value: FileSystemSandboxEntry<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts a URI-style sandbox entry back into one with absolute filesystem paths.

**Data flow**: It receives a URI-based entry, tries to turn the path into an absolute path, keeps the access mode, and returns either the converted entry or an I/O error.

**Call relations**: Protocol receivers use this when turning serialized permission data back into local filesystem rules.


##### `ReadDenyMatcher::new`  (lines 257–266)

```
fn new(file_system_sandbox_policy: &FileSystemSandboxPolicy, cwd: &Path) -> Option<Self>
```

**Purpose**: Builds a runtime checker for read-deny rules, choosing safety over permissiveness if a glob pattern is malformed.

**Data flow**: It receives a filesystem policy and current directory, builds internal exact-path and glob matchers when deny rules exist, and returns `None` if there is nothing to check.

**Call relations**: Test helpers and runtime read checks call this when they want malformed deny patterns to fail closed, meaning reads are denied rather than accidentally allowed.

*Call graph*: called by 1 (is_read_denied); 2 external calls (build, unreachable!).


##### `ReadDenyMatcher::try_new`  (lines 273–282)

```
fn try_new(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
    ) -> Result<Option<Self>, String>
```

**Purpose**: Builds a read-deny matcher but reports malformed glob patterns as errors.

**Data flow**: It receives a policy and current directory, attempts to compile deny patterns, and returns either an optional matcher or a readable error string.

**Call relations**: Host-side expansion code uses this before execution so a bad pattern can stop setup instead of silently changing what paths may be touched.

*Call graph*: called by 1 (resolve_windows_deny_read_paths); 1 external calls (build).


##### `ReadDenyMatcher::build`  (lines 284–321)

```
fn build(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
        invalid_glob_behavior: InvalidDenyReadGlobBehavior,
    ) -> Result<Option<Self>, String>
```

**Purpose**: Does the shared work of constructing the read-deny matcher.

**Data flow**: It reads deny roots and deny glob patterns from the policy, resolves them against the current directory, builds exact candidates and glob matchers, records malformed patterns according to the requested behavior, and returns the matcher or an error.

**Call relations**: Both public constructors call this. It gathers policy information through `get_unreadable_roots_with_cwd` and `get_unreadable_globs_with_cwd`, then delegates pattern compilation to `build_glob_matcher`.

*Call graph*: calls 4 internal fn (get_unreadable_globs_with_cwd, get_unreadable_roots_with_cwd, has_denied_read_restrictions, build_glob_matcher); 2 external calls (new, format!).


##### `ReadDenyMatcher::is_read_denied`  (lines 324–350)

```
fn is_read_denied(&self, path: &Path) -> bool
```

**Purpose**: Checks whether a particular path is blocked by read-deny rules.

**Data flow**: It receives a path, builds both normalized and canonical candidate spellings, compares them with denied roots, then tests glob matchers. It returns true if any rule blocks the path, or if the matcher was built from an invalid pattern in fail-closed mode.

**Call relations**: Runtime collection code calls this when deciding whether a file read should be allowed. It uses canonical candidates so symlink aliases cannot trivially bypass a deny rule.

*Call graph*: calls 1 internal fn (normalized_and_canonical_candidates); called by 1 (collect_existing_glob_matches).


##### `FileSystemPath::from`  (lines 377–385)

```
fn from(value: FileSystemPath<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts a filesystem path description from absolute-path form into URI form.

**Data flow**: It receives a path enum, converts concrete paths to URIs, leaves glob patterns and special tokens unchanged, and returns the converted enum.

**Call relations**: This supports serialization of permission paths for protocol messages.

*Call graph*: calls 1 internal fn (from_abs_path).


##### `FileSystemPath::try_from`  (lines 391–399)

```
fn try_from(value: FileSystemPath<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts a URI-based filesystem path description back into absolute-path form.

**Data flow**: It receives a path enum, converts URI paths into absolute paths when possible, leaves glob patterns and special tokens unchanged, and returns either the converted enum or an I/O error.

**Call relations**: This is the reverse of `FileSystemPath::from` and is used when received protocol data must become local permission rules.


##### `project_roots_glob_pattern`  (lines 404–406)

```
fn project_roots_glob_pattern(subpath: &Path) -> String
```

**Purpose**: Marks a glob pattern as being relative to project roots rather than to one concrete directory.

**Data flow**: It receives a subpath pattern, prefixes it with a special `codex-project-roots://` marker, and returns the marked pattern string.

**Call relations**: Pattern-compilation code calls this when it needs project-root-relative deny patterns that can later be expanded for each workspace root.

*Call graph*: called by 1 (compile_scoped_filesystem_pattern); 1 external calls (format!).


##### `read_only_file_system_entries`  (lines 408–415)

```
fn read_only_file_system_entries() -> Vec<FileSystemSandboxEntry>
```

**Purpose**: Creates the basic entry list for a read-only filesystem policy.

**Data flow**: It produces one entry: the filesystem root is readable.

**Call relations**: `FileSystemSandboxPolicy::read_only` calls this to build the default restricted read-only policy.

*Call graph*: called by 1 (read_only); 1 external calls (vec!).


##### `FileSystemSandboxPolicy::default`  (lines 418–420)

```
fn default() -> Self
```

**Purpose**: Makes the default filesystem policy read-only.

**Data flow**: It takes no inputs and returns the same policy as `read_only`.

**Call relations**: Many setup and test paths rely on this conservative default so missing configuration does not imply write access.

*Call graph*: called by 8 (file_system_sandbox_context_uses_active_attempt, default_exec_approval_requirement_keeps_prompt_when_granular_allows_sandbox_approval, default_exec_approval_requirement_rejects_sandbox_prompt_when_granular_disables_it, extension_tool_receives_turn_environment_sandbox, view_image_tool_applies_local_sandbox_read_denies, default_policy_with_unreadable_glob, default_policy_with_unreadable_glob, unreadable_glob_policy_includes_canonicalized_static_prefix); 1 external calls (read_only).


##### `FileSystemSandboxPolicy::read_only`  (lines 424–426)

```
fn read_only() -> Self
```

**Purpose**: Builds a restricted policy that allows reading the disk but not writing it.

**Data flow**: It creates read-only root entries and wraps them in a restricted sandbox policy.

**Call relations**: Configuration defaults and parent permission profiles use this when the agent should inspect files but not modify them.

*Call graph*: calls 1 internal fn (read_only_file_system_entries); called by 2 (extensible_builtin_parent_profile, read_only); 1 external calls (restricted).


##### `FileSystemSandboxPolicy::unrestricted`  (lines 428–434)

```
fn unrestricted() -> Self
```

**Purpose**: Builds a policy that grants full filesystem access.

**Data flow**: It returns a policy marked unrestricted with no per-path entries.

**Call relations**: Full-access profiles and compatibility conversion use this when the sandbox should not limit filesystem reads or writes.

*Call graph*: called by 15 (managed_full_disk_with_restricted_network_reports_external_sandbox, windows_restricted_token_rejects_network_only_restrictions, exec_server_params_use_path_uri_and_env_policy_overlay_contract, full_disk_write_full_network_returns_unwrapped_command, full_disk_write_proxy_only_keeps_full_filesystem_but_unshares_network, managed_proxy_preflight_argv_is_wrapped_for_full_access_policy, to_sandbox_policy, file_system_sandbox_policy, disabled_permission_profile_ignores_runtime_network_policy, permission_profile_from_runtime_permissions_preserves_unrestricted_managed_network (+5 more)); 1 external calls (new).


##### `FileSystemSandboxPolicy::external_sandbox`  (lines 436–442)

```
fn external_sandbox() -> Self
```

**Purpose**: Builds a policy that says filesystem control is handled by something outside this policy object.

**Data flow**: It returns an external-sandbox kind with no local filesystem entries.

**Call relations**: Runtime setup and legacy conversion use this when another sandbox mechanism is expected to enforce access.

*Call graph*: called by 4 (external_sandbox_auto_approves_in_on_request, file_system_sandbox_policy, permission_profile_from_runtime_permissions_preserves_external_sandbox, from); 1 external calls (new).


##### `FileSystemSandboxPolicy::restricted`  (lines 444–450)

```
fn restricted(entries: Vec<FileSystemSandboxEntry>) -> Self
```

**Purpose**: Builds a restricted filesystem policy from explicit path rules.

**Data flow**: It receives entries, stores them with restricted kind, and leaves optional glob scan depth unset.

**Call relations**: Most policy constructors and tests use this as the common way to create a detailed allow-and-deny rule set.

*Call graph*: called by 138 (requested_permissions_trust_project_uses_permission_profile_intent, permission_profile_override_keeps_memories_root_out_of_legacy_projection, permission_profile_override_preserves_split_write_roots, compile_permission_profile, workspace_write_permission_profile_with_private_denials, managed_cwd_write_profile_has_filesystem_restrictions, managed_full_disk_write_profile_has_no_filesystem_restrictions, managed_unresolvable_write_profile_has_filesystem_restrictions, writable_windows_policy_without_sandbox_backend_still_requires_approval, windows_elevated_allows_split_restricted_read_policies (+15 more)).


##### `FileSystemSandboxPolicy::has_root_access`  (lines 452–461)

```
fn has_root_access(&self, predicate: impl Fn(FileSystemAccessMode) -> bool) -> bool
```

**Purpose**: Checks whether a restricted policy grants a chosen kind of access at the filesystem root.

**Data flow**: It receives a test function, scans root special-path entries, and returns true if any root entry passes that test.

**Call relations**: Full-disk read and write checks call this as their first question: does the policy start with broad root access?

*Call graph*: called by 2 (has_full_disk_read_access, has_full_disk_write_access); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::has_denied_read_restrictions`  (lines 463–469)

```
fn has_denied_read_restrictions(&self) -> bool
```

**Purpose**: Checks whether a restricted policy contains any explicit deny entries.

**Data flow**: It scans entries only when the policy is restricted and returns true if any entry has deny access.

**Call relations**: Read-deny matcher construction and full-read detection use this to know whether extra blocking rules exist.

*Call graph*: called by 3 (unsandboxed_execution_allowed, has_full_disk_read_access, build); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::from_legacy_sandbox_policy_preserving_deny_entries`  (lines 471–493)

```
fn from_legacy_sandbox_policy_preserving_deny_entries(
        sandbox_policy: &SandboxPolicy,
        cwd: &Path,
        existing: &Self,
    ) -> Self
```

**Purpose**: Rebuilds a filesystem policy from an older sandbox policy while keeping existing deny rules.

**Data flow**: It converts the legacy policy for the current directory, copies over glob scan depth, then appends deny entries from the existing policy that are not already present.

**Call relations**: Configuration application uses this when the allow side is refreshed from legacy settings but read-deny restrictions must survive.

*Call graph*: called by 2 (apply, legacy_bridge_preserves_explicit_deny_entries); 2 external calls (from_legacy_sandbox_policy_for_cwd, matches!).


##### `FileSystemSandboxPolicy::preserve_deny_read_restrictions_from`  (lines 497–528)

```
fn preserve_deny_read_restrictions_from(&mut self, existing: &Self)
```

**Purpose**: Copies read-deny restrictions from an old policy into this policy.

**Data flow**: It looks for deny entries in the existing policy. If the new policy is unrestricted, it turns it into a restricted full-write policy so denies can still be enforced, then copies depth and missing deny entries.

**Call relations**: This is used when replacing permissions would otherwise accidentally drop explicit private-read blocks.

*Call graph*: 3 external calls (restricted, matches!, vec!).


##### `FileSystemSandboxPolicy::has_write_narrowing_entries`  (lines 537–556)

```
fn has_write_narrowing_entries(&self) -> bool
```

**Purpose**: Detects whether any rule limits an otherwise broad write permission.

**Data flow**: It scans restricted entries and returns true for read or deny rules that actually carve away write access, ignoring rules that are shadowed by an equal-target write rule.

**Call relations**: `has_full_disk_write_access` calls this to avoid saying the disk is fully writable when a child path or pattern is read-only or denied.

*Call graph*: called by 1 (has_full_disk_write_access); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::has_same_target_write_override`  (lines 560–566)

```
fn has_same_target_write_override(&self, entry: &FileSystemSandboxEntry) -> bool
```

**Purpose**: Checks whether a write rule for the exact same target overrides a narrower-looking rule.

**Data flow**: It receives an entry, searches for a higher-precedence write entry that points at the same path target, and returns true if one exists.

**Call relations**: `has_write_narrowing_entries` uses this to avoid treating a shadowed read or deny rule as a real reduction in write access.


##### `FileSystemSandboxPolicy::workspace_write`  (lines 570–627)

```
fn workspace_write(
        writable_roots: &[AbsolutePathBuf],
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> Self
```

**Purpose**: Builds the standard policy for workspace editing: read broadly, write project roots and selected temporary locations, and protect metadata.

**Data flow**: It receives extra writable roots and temporary-directory exclusions, creates root read access, adds project-root and temp write entries, adds requested write roots, then adds read-only carveouts for `.git`, `.agents`, and `.codex` unless explicitly overridden.

**Call relations**: Legacy conversion and workspace-write permission profiles call this to produce the detailed filesystem rules behind the familiar workspace-write mode.

*Call graph*: calls 4 internal fn (restricted, append_default_read_only_path_if_no_explicit_rule, append_default_read_only_project_root_subpath_if_no_explicit_rule, default_read_only_subpaths_for_writable_root); called by 8 (extensible_builtin_parent_profile, test_writable_roots_constraint, write_permissions_for_paths_keep_dirs_outside_workspace_root, write_permissions_for_paths_skip_dirs_already_writable_under_workspace_root, ignores_missing_writable_roots, mounts_dev_before_writable_dev_binds, workspace_write_with, from); 3 external calls (project_roots, iter, vec!).


##### `FileSystemSandboxPolicy::from_legacy_sandbox_policy_for_cwd`  (lines 636–663)

```
fn from_legacy_sandbox_policy_for_cwd(sandbox_policy: &SandboxPolicy, cwd: &Path) -> Self
```

**Purpose**: Converts an older sandbox policy into the newer filesystem policy for a specific current directory.

**Data flow**: It first performs the basic conversion, then for workspace-write policies adds default protected metadata paths for the current workspace and any extra writable roots.

**Call relations**: Session setup, agent spawning, and compatibility paths call this when old configuration must be represented with the newer per-path policy model.

*Call graph*: calls 3 internal fn (append_default_read_only_path_if_no_explicit_rule, default_read_only_subpaths_for_writable_root, from_absolute_path); called by 19 (exec_one_off_command_inner, can_set_legacy_sandbox_policy, set_legacy_sandbox_policy, file_system_policy_with_unreadable_glob, session_configuration_apply_permission_profile_preserves_existing_deny_read_entries, session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update, non_legacy_file_system_sandbox_policy, build_agent_spawn_config_uses_turn_context_values, spawn_agent_reapplies_runtime_sandbox_after_role_config, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command (+9 more)); 1 external calls (from).


##### `FileSystemSandboxPolicy::has_full_disk_read_access`  (lines 666–674)

```
fn has_full_disk_read_access(&self) -> bool
```

**Purpose**: Answers whether filesystem reads are effectively unrestricted.

**Data flow**: It returns true for unrestricted or external sandbox policies. For restricted policies, it requires readable root access and no deny-read restrictions.

**Call relations**: Sandbox argument builders and readable-root collectors call this to decide whether they need to pass any read allowlist at all.

*Call graph*: calls 2 internal fn (has_denied_read_restrictions, has_root_access); called by 7 (add_helper_runtime_permissions, create_filesystem_args, get_readable_roots_with_cwd, include_platform_defaults, semantic_signature, with_additional_readable_roots, has_full_disk_read_access).


##### `FileSystemSandboxPolicy::has_full_disk_write_access`  (lines 677–685)

```
fn has_full_disk_write_access(&self) -> bool
```

**Purpose**: Answers whether filesystem writes are effectively unrestricted.

**Data flow**: It returns true for unrestricted or external sandbox policies. For restricted policies, it requires write access at root and no rules that narrow that write access.

**Call relations**: Execution setup, prompts, legacy conversion, and write checks call this to detect full-write mode.

*Call graph*: calls 2 internal fn (has_root_access, has_write_narrowing_entries); called by 10 (patch_rejection_reason, create_bwrap_command_args, create_filesystem_args, sandbox_prompt_from_policy, can_write_path_with_cwd, get_writable_roots_with_cwd, semantic_signature, to_legacy_sandbox_policy, ensure_linux_bubblewrap_is_supported, should_require_platform_sandbox).


##### `FileSystemSandboxPolicy::include_platform_defaults`  (lines 688–699)

```
fn include_platform_defaults(&self) -> bool
```

**Purpose**: Decides whether platform-default readable paths should be added to a restricted policy.

**Data flow**: It returns true only when full read access is absent, the policy is restricted, and it contains a readable `Minimal` special-path entry.

**Call relations**: Filesystem sandbox builders and semantic comparison use this to preserve the meaning of minimal access profiles.

*Call graph*: calls 1 internal fn (has_full_disk_read_access); called by 3 (create_filesystem_args, semantic_signature, include_platform_defaults); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::resolve_access_with_cwd`  (lines 701–719)

```
fn resolve_access_with_cwd(&self, path: &Path, cwd: &Path) -> FileSystemAccessMode
```

**Purpose**: Finds the effective access mode for one path under this policy.

**Data flow**: It resolves the candidate path against the current directory, finds all resolved entries that contain it, chooses the most specific rule with tie-breaking by access precedence, and returns read, write, or deny.

**Call relations**: Read and write convenience checks call this. It is the central path-decision function for detailed filesystem policies.

*Call graph*: calls 2 internal fn (resolved_entries_with_cwd, resolve_candidate_path); called by 3 (can_read_path_with_cwd, can_write_path_with_cwd, granted_file_system_entry_within_request).


##### `FileSystemSandboxPolicy::can_read_path_with_cwd`  (lines 721–723)

```
fn can_read_path_with_cwd(&self, path: &Path, cwd: &Path) -> bool
```

**Purpose**: Answers whether a path may be read under this policy.

**Data flow**: It receives a path and current directory, resolves the path's access mode, and returns whether that mode permits reading.

**Call relations**: Permission-expansion and Windows sandbox helpers use this when adding readable roots or checking effective read access.

*Call graph*: calls 1 internal fn (resolve_access_with_cwd); called by 3 (windows_policy_has_root_read_access, add_helper_runtime_permissions, with_additional_readable_roots).


##### `FileSystemSandboxPolicy::can_write_path_with_cwd`  (lines 725–733)

```
fn can_write_path_with_cwd(&self, path: &Path, cwd: &Path) -> bool
```

**Purpose**: Answers whether a path may be written under this policy, including protected metadata checks.

**Data flow**: It resolves the path's access mode. If it is not write, it returns false. If full-disk write is active, it returns true. Otherwise, it denies writes to protected metadata unless explicitly allowed.

**Call relations**: Write-root expansion, compatibility policy building, and `forbidden_agent_metadata_write` rely on this final write decision.

*Call graph*: calls 3 internal fn (has_full_disk_write_access, is_metadata_write_denied, resolve_access_with_cwd); called by 4 (with_additional_writable_roots, forbidden_agent_metadata_write, compatibility_workspace_write_policy, protected_metadata_names_for_writable_root).


##### `FileSystemSandboxPolicy::is_metadata_write_denied`  (lines 735–755)

```
fn is_metadata_write_denied(&self, path: &Path, cwd: &Path) -> bool
```

**Purpose**: Checks whether a write is blocked specifically because it targets protected metadata inside a writable root.

**Data flow**: It resolves the target, detects whether it is under `.git`, `.agents`, or `.codex` below a writable root, and returns true unless an explicit write entry covers that metadata path.

**Call relations**: `can_write_path_with_cwd` calls this after normal write permission succeeds, adding the extra metadata safety layer.

*Call graph*: calls 3 internal fn (has_explicit_write_entry_for_metadata_path, metadata_child_of_writable_root, resolve_candidate_path); called by 1 (can_write_path_with_cwd); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::materialize_project_roots_with_cwd`  (lines 762–787)

```
fn materialize_project_roots_with_cwd(mut self, cwd: &Path) -> Self
```

**Purpose**: Turns project-root-relative entries into concrete paths based on the current directory.

**Data flow**: It walks entries, replaces `ProjectRoots` special paths with absolute paths from `cwd`, and rewrites project-root-marked glob patterns into absolute glob patterns.

**Call relations**: Callers use this when a permission profile must keep the same project-root meaning even if the process later changes directories.

*Call graph*: calls 4 internal fn (parse_project_roots_glob_pattern, resolve_file_system_path, resolve_project_roots_glob_pattern, from_absolute_path); 1 external calls (as_ref).


##### `FileSystemSandboxPolicy::materialize_project_roots_with_workspace_roots`  (lines 791–845)

```
fn materialize_project_roots_with_workspace_roots(
        mut self,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Expands project-root-relative entries into one concrete entry for each known workspace root.

**Data flow**: It receives workspace roots, replaces project-root special entries and marked glob patterns with per-root concrete entries, and preserves entries that are already concrete or unrelated.

**Call relations**: Workspace-aware setup uses this when more than one project root should receive the same symbolic permission rule.

*Call graph*: calls 1 internal fn (parse_project_roots_glob_pattern); 2 external calls (with_capacity, iter).


##### `FileSystemSandboxPolicy::with_materialized_project_roots_for_workspace_roots`  (lines 849–862)

```
fn with_materialized_project_roots_for_workspace_roots(
        mut self,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Adds concrete workspace-root entries while keeping the original symbolic entries too.

**Data flow**: It clones and materializes the policy for the provided roots, then appends any generated entries that are not already present.

**Call relations**: This is useful when a policy should work both with symbolic project-root interpretation and with runtimes that need concrete paths.


##### `FileSystemSandboxPolicy::with_additional_readable_roots`  (lines 864–885)

```
fn with_additional_readable_roots(
        mut self,
        cwd: &Path,
        additional_readable_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Adds extra readable roots when they are not already readable.

**Data flow**: It receives current directory and extra roots, skips work if full read access exists, checks each root's current read access, and appends read entries only for missing access.

**Call relations**: Permission setup uses this to extend read access without duplicating rules already covered by broader entries.

*Call graph*: calls 2 internal fn (can_read_path_with_cwd, has_full_disk_read_access).


##### `FileSystemSandboxPolicy::with_additional_writable_roots`  (lines 887–904)

```
fn with_additional_writable_roots(
        mut self,
        cwd: &Path,
        additional_writable_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Adds extra writable roots when they are not already writable.

**Data flow**: It receives extra roots, checks each one with the current policy, and appends write entries only for paths that are not already writable.

**Call relations**: Runtime setup uses this to grant additional write locations while respecting existing effective access.

*Call graph*: calls 1 internal fn (can_write_path_with_cwd).


##### `FileSystemSandboxPolicy::with_additional_legacy_workspace_writable_roots`  (lines 912–942)

```
fn with_additional_legacy_workspace_writable_roots(
        mut self,
        additional_writable_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Adds writable roots using legacy workspace-write rules, including metadata protection.

**Data flow**: It receives extra roots, adds exact write entries if missing, then adds default read-only protected metadata subpaths for each new root.

**Call relations**: Legacy compatibility code uses this when it needs the old behavior, where explicit roots and their metadata carveouts are added even if symbolic project roots already cover them.

*Call graph*: calls 2 internal fn (append_default_read_only_path_if_no_explicit_rule, default_read_only_subpaths_for_writable_root); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::needs_direct_runtime_enforcement`  (lines 944–964)

```
fn needs_direct_runtime_enforcement(
        &self,
        network_policy: NetworkSandboxPolicy,
        cwd: &Path,
    ) -> bool
```

**Purpose**: Decides whether the newer filesystem policy cannot safely be represented by the older sandbox runtime.

**Data flow**: It tries to convert to the legacy policy, compares semantic signatures with what the legacy runtime would actually enforce, and separately checks protected metadata names.

**Call relations**: Platform sandbox setup calls this to know whether it must enforce `FileSystemSandboxPolicy` directly instead of relying only on the older `SandboxPolicy` bridge.

*Call graph*: calls 4 internal fn (semantic_signature, to_legacy_sandbox_policy, legacy_runtime_file_system_policy_for_cwd, protected_metadata_names_need_direct_runtime_enforcement); called by 1 (ensure_legacy_landlock_mode_supports_policy); 1 external calls (matches!).


##### `FileSystemSandboxPolicy::is_semantically_equivalent_to`  (lines 968–970)

```
fn is_semantically_equivalent_to(&self, other: &Self, cwd: &Path) -> bool
```

**Purpose**: Checks whether two policies mean the same thing for a current directory, ignoring entry order.

**Data flow**: It computes a semantic signature for both policies and compares those signatures.

**Call relations**: Tests and enforcement classification use this to avoid treating harmless reordering as a real permission difference.

*Call graph*: calls 1 internal fn (semantic_signature); 1 external calls (semantic_signature).


##### `FileSystemSandboxPolicy::get_readable_roots_with_cwd`  (lines 973–987)

```
fn get_readable_roots_with_cwd(&self, cwd: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Lists the explicit readable roots for this policy after resolving special paths.

**Data flow**: It returns an empty list for full-read policies. Otherwise it resolves entries, keeps entries that effectively allow reading, deduplicates paths, and returns them.

**Call relations**: Sandbox argument builders and semantic comparison call this when they need concrete readable roots.

*Call graph*: calls 3 internal fn (has_full_disk_read_access, resolved_entries_with_cwd, dedup_absolute_paths); called by 3 (create_filesystem_args, semantic_signature, readable_roots_for_cwd); 1 external calls (new).


##### `FileSystemSandboxPolicy::get_writable_roots_with_cwd`  (lines 991–1103)

```
fn get_writable_roots_with_cwd(&self, cwd: &Path) -> Vec<WritableRoot>
```

**Purpose**: Lists writable roots and the read-only subpaths carved out inside them.

**Data flow**: It returns an empty list for full-write policies. Otherwise it resolves writable entries, deduplicates effective roots, computes protected metadata names and read-only carveouts, preserves important symlink spellings, and returns `WritableRoot` records.

**Call relations**: Sandbox builders, prompts, compatibility checks, and metadata-enforcement comparison use this to turn high-level rules into mountable writable areas.

*Call graph*: calls 3 internal fn (has_full_disk_write_access, resolved_entries_with_cwd, dedup_absolute_paths); called by 6 (patch_rejection_reason, create_filesystem_args, sandbox_prompt_from_policy, semantic_signature, protected_metadata_names_need_direct_runtime_enforcement, compatibility_workspace_write_policy); 1 external calls (new).


##### `FileSystemSandboxPolicy::get_unreadable_roots_with_cwd`  (lines 1106–1128)

```
fn get_unreadable_roots_with_cwd(&self, cwd: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Lists explicit path roots that should be unreadable.

**Data flow**: It resolves deny entries, keeps only those that are effectively unreadable, avoids materializing a whole-root deny that would erase narrower read allows, deduplicates paths, and returns them.

**Call relations**: Sandbox builders, read-deny text display, semantic comparison, and `ReadDenyMatcher::build` use this to enforce exact deny roots.

*Call graph*: calls 3 internal fn (resolved_entries_with_cwd, dedup_absolute_paths, from_absolute_path); called by 5 (create_filesystem_args, denied_reads_text, semantic_signature, build, resolve_windows_deny_read_paths); 2 external calls (new, matches!).


##### `FileSystemSandboxPolicy::get_unreadable_globs_with_cwd`  (lines 1131–1151)

```
fn get_unreadable_globs_with_cwd(&self, cwd: &Path) -> Vec<String>
```

**Purpose**: Lists unreadable glob patterns resolved against the current directory.

**Data flow**: It scans restricted deny entries that are glob patterns, makes relative patterns absolute against `cwd`, sorts and deduplicates them, and returns strings.

**Call relations**: Sandbox builders and read-deny matcher construction call this to enforce pattern-based read blocks.

*Call graph*: called by 7 (create_bwrap_command_args, create_filesystem_args, denied_reads_text, semantic_signature, build, build_seatbelt_unreadable_glob_policy, resolve_windows_deny_read_paths); 2 external calls (new, matches!).


##### `FileSystemSandboxPolicy::to_legacy_sandbox_policy`  (lines 1153–1266)

```
fn to_legacy_sandbox_policy(
        &self,
        network_policy: NetworkSandboxPolicy,
        cwd: &Path,
    ) -> io::Result<SandboxPolicy>
```

**Purpose**: Converts the detailed filesystem policy plus network policy into the older `SandboxPolicy` format when possible.

**Data flow**: It examines policy kind, network setting, full-write status, workspace-root writes, temporary-directory writes, and extra writable roots. It returns a matching legacy policy or an error when the detailed policy asks for writes the legacy model cannot express safely.

**Call relations**: `needs_direct_runtime_enforcement` uses this as the bridge test: if conversion fails or loses meaning, direct enforcement is required.

*Call graph*: calls 5 internal fn (has_full_disk_write_access, is_enabled, dedup_absolute_paths, resolve_file_system_special_path, from_absolute_path); called by 1 (needs_direct_runtime_enforcement); 2 external calls (new, new).


##### `FileSystemSandboxPolicy::resolved_entries_with_cwd`  (lines 1268–1281)

```
fn resolved_entries_with_cwd(&self, cwd: &Path) -> Vec<ResolvedFileSystemEntry>
```

**Purpose**: Resolves policy entries into concrete absolute path entries for a current directory.

**Data flow**: It converts `cwd` to an absolute path when possible, resolves each entry's path if it can be concrete, and returns resolved path-plus-access records.

**Call relations**: Most path-based operations call this before comparing policy entries to actual filesystem paths.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 6 (get_readable_roots_with_cwd, get_unreadable_roots_with_cwd, get_writable_roots_with_cwd, resolve_access_with_cwd, has_explicit_write_entry_for_metadata_path, metadata_child_of_writable_root).


##### `FileSystemSandboxPolicy::semantic_signature`  (lines 1283–1293)

```
fn semantic_signature(&self, cwd: &Path) -> FileSystemSemanticSignature
```

**Purpose**: Builds a normalized summary of what a policy means for a current directory.

**Data flow**: It records broad read/write flags, platform-default behavior, sorted readable roots, writable roots, unreadable roots, and unreadable globs.

**Call relations**: Policy equivalence and direct-enforcement checks use this so they compare behavior rather than raw entry order.

*Call graph*: calls 9 internal fn (get_readable_roots_with_cwd, get_unreadable_globs_with_cwd, get_unreadable_roots_with_cwd, get_writable_roots_with_cwd, has_full_disk_read_access, has_full_disk_write_access, include_platform_defaults, sorted_absolute_paths, sorted_writable_roots); called by 2 (is_semantically_equivalent_to, needs_direct_runtime_enforcement).


##### `NetworkSandboxPolicy::from`  (lines 1297–1303)

```
fn from(value: &SandboxPolicy) -> Self
```

**Purpose**: Creates the new network policy from an older sandbox policy.

**Data flow**: It asks the legacy policy whether it has full network access and returns enabled or restricted accordingly.

**Call relations**: Session and agent setup call this when translating legacy configuration into the split network/filesystem permission model.

*Call graph*: called by 14 (exec_one_off_command_inner, can_set_legacy_sandbox_policy, set_legacy_sandbox_policy, apply, session_configuration_apply_preserves_profile_file_system_policy_on_cwd_only_update, session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update, build_agent_spawn_config_uses_turn_context_values, spawn_agent_reapplies_runtime_sandbox_after_role_config, from_legacy_sandbox_policy, from_legacy_sandbox_policy (+4 more)); 1 external calls (has_full_network_access).


##### `FileSystemSandboxPolicy::from`  (lines 1307–1330)

```
fn from(value: &SandboxPolicy) -> Self
```

**Purpose**: Creates the new filesystem policy from an older sandbox policy.

**Data flow**: It maps full access to unrestricted, external sandbox to external, read-only to root read, and workspace-write to the detailed workspace-write policy.

**Call relations**: Legacy conversion paths and runtime-policy reconstruction use this as the basic bridge into the newer permission model.

*Call graph*: calls 4 internal fn (external_sandbox, restricted, unrestricted, workspace_write); called by 2 (from_legacy_sandbox_policy, legacy_runtime_file_system_policy_for_cwd); 1 external calls (vec!).


##### `resolve_file_system_path`  (lines 1333–1342)

```
fn resolve_file_system_path(
    path: &FileSystemPath,
    cwd: Option<&AbsolutePathBuf>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Turns a filesystem path description into an absolute path when that is possible.

**Data flow**: It returns concrete path entries directly, ignores glob patterns, and resolves special paths such as project roots or temp directories using the optional current directory.

**Call relations**: Project-root materialization and entry resolution call this as the common special-path resolver.

*Call graph*: calls 1 internal fn (resolve_file_system_special_path); called by 2 (materialize_project_roots_with_cwd, resolve_entry_path); 1 external calls (clone).


##### `resolve_entry_path`  (lines 1344–1354)

```
fn resolve_entry_path(
    path: &FileSystemPath,
    cwd: Option<&AbsolutePathBuf>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves a policy entry path into the concrete path used for prefix matching.

**Data flow**: It treats the special root token as the filesystem root for the current directory, otherwise delegates to `resolve_file_system_path`.

**Call relations**: `resolved_entries_with_cwd` uses this to prepare entries for access decisions.

*Call graph*: calls 1 internal fn (resolve_file_system_path).


##### `parse_project_roots_glob_pattern`  (lines 1356–1360)

```
fn parse_project_roots_glob_pattern(pattern: &str) -> Option<&Path>
```

**Purpose**: Recognizes glob patterns that were marked as project-root-relative.

**Data flow**: It receives a pattern string, strips the special prefix if present, and returns the remaining subpath as a path.

**Call relations**: Materialization functions use this to expand symbolic glob patterns for a current directory or a list of workspace roots.

*Call graph*: called by 2 (materialize_project_roots_with_cwd, materialize_project_roots_with_workspace_roots).


##### `resolve_project_roots_glob_pattern`  (lines 1362–1366)

```
fn resolve_project_roots_glob_pattern(subpath: &Path, root: &AbsolutePathBuf) -> String
```

**Purpose**: Turns a project-root-relative glob subpath into an absolute glob pattern for one root.

**Data flow**: It receives a subpath and root, resolves the subpath against the root, and returns the path as a string.

**Call relations**: Project-root materialization calls this after detecting the special glob prefix.

*Call graph*: calls 2 internal fn (as_path, resolve_path_against_base); called by 1 (materialize_project_roots_with_cwd).


##### `resolve_candidate_path`  (lines 1368–1374)

```
fn resolve_candidate_path(path: &Path, cwd: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Converts a path being checked into an absolute path candidate.

**Data flow**: It returns the path directly if it is absolute, or joins it to an absolute current directory if it is relative. It returns `None` if the current directory cannot be made absolute.

**Call relations**: Access resolution and protected-metadata checks use this before comparing a user-supplied path with policy entries.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 3 (is_metadata_write_denied, resolve_access_with_cwd, forbidden_agent_metadata_write); 1 external calls (is_absolute).


##### `file_system_paths_share_target`  (lines 1382–1400)

```
fn file_system_paths_share_target(left: &FileSystemPath, right: &FileSystemPath) -> bool
```

**Purpose**: Checks whether two policy path descriptions refer to the same exact target for same-specificity conflict handling.

**Data flow**: It compares concrete paths, special paths, stable special-path-to-absolute matches, and identical glob patterns, returning false for unlike or unresolved targets.

**Call relations**: Write-narrowing and default read-only append helpers use this to decide whether an explicit rule already covers a target.

*Call graph*: calls 2 internal fn (special_path_matches_absolute_path, special_paths_share_target).


##### `special_paths_share_target`  (lines 1404–1426)

```
fn special_paths_share_target(left: &FileSystemSpecialPath, right: &FileSystemSpecialPath) -> bool
```

**Purpose**: Compares two special path tokens that can be judged without a current directory.

**Data flow**: It receives two special paths and returns true when they are the same stable token or the same project-root/unknown token with the same subpath data.

**Call relations**: `file_system_paths_share_target` uses this for special-path entries.

*Call graph*: called by 1 (file_system_paths_share_target).


##### `special_path_matches_absolute_path`  (lines 1433–1442)

```
fn special_path_matches_absolute_path(
    value: &FileSystemSpecialPath,
    path: &AbsolutePathBuf,
) -> bool
```

**Purpose**: Checks whether a stable special path token names the same location as an absolute path.

**Data flow**: It recognizes only cwd-independent meanings, such as filesystem root and `/tmp`, and returns whether the absolute path matches.

**Call relations**: `file_system_paths_share_target` uses this when comparing a special path with a concrete path.

*Call graph*: calls 1 internal fn (as_path); called by 1 (file_system_paths_share_target); 1 external calls (new).


##### `resolved_entry_precedence`  (lines 1446–1449)

```
fn resolved_entry_precedence(entry: &ResolvedFileSystemEntry) -> (usize, FileSystemAccessMode)
```

**Purpose**: Ranks resolved entries so access resolution can choose the winning rule.

**Data flow**: It receives a resolved entry and returns a pair: path specificity measured by component count, then access-mode precedence.

**Call relations**: `resolve_access_with_cwd` uses this ranking so more specific paths win, and ties prefer deny over write over read according to the enum ordering.


##### `absolute_root_path_for_cwd`  (lines 1451–1459)

```
fn absolute_root_path_for_cwd(cwd: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Finds the filesystem root that contains the current directory.

**Data flow**: It walks the current directory's ancestors to the last ancestor, converts it to an absolute path, and returns it.

**Call relations**: Root special-path resolution and unreadable-root filtering use this when they need the real root path for the current platform.

*Call graph*: calls 2 internal fn (as_path, from_absolute_path).


##### `normalized_and_canonical_candidates`  (lines 1461–1480)

```
fn normalized_and_canonical_candidates(path: &Path) -> Vec<PathBuf>
```

**Purpose**: Builds the path spellings used to compare read-deny rules safely.

**Data flow**: It starts with the lexical absolute form when possible, then adds the canonical filesystem target if it exists, avoiding duplicates.

**Call relations**: `ReadDenyMatcher::is_read_denied` uses these candidates so both symlink paths and their real targets can match deny rules.

*Call graph*: calls 2 internal fn (push_unique, from_absolute_path); called by 1 (is_read_denied); 3 external calls (canonicalize, to_path_buf, new).


##### `push_unique`  (lines 1482–1486)

```
fn push_unique(candidates: &mut Vec<PathBuf>, candidate: PathBuf)
```

**Purpose**: Adds a path to a list only if it is not already present.

**Data flow**: It receives a mutable vector and a candidate path, checks for equality with existing items, and appends only new values.

**Call relations**: `normalized_and_canonical_candidates` uses this to keep candidate lists small and duplicate-free.

*Call graph*: called by 1 (normalized_and_canonical_candidates).


##### `build_glob_matcher`  (lines 1488–1497)

```
fn build_glob_matcher(pattern: &str) -> Result<GlobMatcher, String>
```

**Purpose**: Compiles a glob pattern into a matcher with Codex's expected path-pattern behavior.

**Data flow**: It receives a pattern string, configures glob parsing so `*` and `?` do not cross path separators and unclosed `[` is literal, then returns a matcher or an error message.

**Call relations**: `ReadDenyMatcher::build` calls this for each deny-read glob pattern.

*Call graph*: called by 1 (build); 1 external calls (new).


##### `resolve_file_system_special_path`  (lines 1499–1535)

```
fn resolve_file_system_special_path(
    value: &FileSystemSpecialPath,
    cwd: Option<&AbsolutePathBuf>,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves special path tokens such as project roots, `TMPDIR`, and `/tmp` into concrete absolute paths when possible.

**Data flow**: It receives a special path and optional current directory. Some tokens cannot resolve directly, project roots use `cwd`, temp dir uses the `TMPDIR` environment variable, and slash-tmp returns `/tmp` only if it exists.

**Call relations**: Path resolution and legacy conversion call this whenever symbolic policy entries need concrete paths.

*Call graph*: calls 2 internal fn (from_absolute_path, resolve_path_against_base); called by 2 (to_legacy_sandbox_policy, resolve_file_system_path); 2 external calls (from, var_os).


##### `dedup_absolute_paths`  (lines 1537–1554)

```
fn dedup_absolute_paths(
    paths: Vec<AbsolutePathBuf>,
    normalize_effective_paths: bool,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Removes duplicate absolute paths, optionally after normalizing their effective filesystem spelling.

**Data flow**: It receives paths and a flag, normalizes each path when requested, tracks seen path buffers, and returns the first unique version of each.

**Call relations**: Readable-root, writable-root, unreadable-root, legacy conversion, and default-metadata helpers use this to avoid duplicate sandbox entries.

*Call graph*: calls 1 internal fn (normalize_effective_absolute_path); called by 5 (get_readable_roots_with_cwd, get_unreadable_roots_with_cwd, get_writable_roots_with_cwd, to_legacy_sandbox_policy, default_read_only_subpaths_for_writable_root); 2 external calls (new, with_capacity).


##### `sorted_absolute_paths`  (lines 1556–1559)

```
fn sorted_absolute_paths(mut paths: Vec<AbsolutePathBuf>) -> Vec<AbsolutePathBuf>
```

**Purpose**: Sorts absolute paths into stable order.

**Data flow**: It receives a vector of absolute paths, sorts by the underlying path text, and returns it.

**Call relations**: Semantic signatures and writable-root sorting use this so comparisons are not affected by entry order.

*Call graph*: called by 2 (semantic_signature, sorted_writable_roots).


##### `sorted_writable_roots`  (lines 1561–1570)

```
fn sorted_writable_roots(mut roots: Vec<WritableRoot>) -> Vec<WritableRoot>
```

**Purpose**: Normalizes writable-root ordering for stable comparison.

**Data flow**: It sorts each root's read-only subpaths, sorts and deduplicates protected metadata names, then sorts the roots themselves by path.

**Call relations**: `semantic_signature` uses this to compare policies by meaning instead of construction order.

*Call graph*: calls 1 internal fn (sorted_absolute_paths); called by 1 (semantic_signature); 1 external calls (take).


##### `normalize_effective_absolute_path`  (lines 1572–1591)

```
fn normalize_effective_absolute_path(path: AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Normalizes an absolute path using the longest existing ancestor while preserving symlink path components where intended.

**Data flow**: It walks ancestors of the raw path, tries to canonicalize an existing ancestor in a symlink-preserving way, rejoins the missing suffix, and returns the first successful normalized absolute path or the original path.

**Call relations**: `dedup_absolute_paths` uses this when effective path aliases should collapse to one root.

*Call graph*: calls 2 internal fn (from_absolute_path, to_path_buf); called by 1 (dedup_absolute_paths); 2 external calls (canonicalize_preserving_symlinks, symlink_metadata).


##### `default_read_only_subpaths_for_writable_root`  (lines 1593–1630)

```
fn default_read_only_subpaths_for_writable_root(
    writable_root: &AbsolutePathBuf,
    protect_missing_dot_codex: bool,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Finds metadata paths inside a writable root that should be read-only by default.

**Data flow**: It checks for `.git`, `.agents`, and `.codex`, follows Git pointer files to their real git directory when needed, optionally protects missing `.codex`, deduplicates the results, and returns the subpaths.

**Call relations**: Workspace-write construction, legacy conversion, and adding legacy writable roots call this to keep sensitive metadata out of normal write access.

*Call graph*: calls 4 internal fn (dedup_absolute_paths, is_git_pointer_file, resolve_gitdir_from_file, join); called by 5 (from_legacy_sandbox_policy_for_cwd, with_additional_legacy_workspace_writable_roots, workspace_write, legacy_runtime_file_system_policy_for_cwd, legacy_workspace_write_projection_accepts_relative_cwd); 1 external calls (new).


##### `legacy_runtime_file_system_policy_for_cwd`  (lines 1639–1711)

```
fn legacy_runtime_file_system_policy_for_cwd(
    sandbox_policy: &SandboxPolicy,
    cwd: &Path,
) -> FileSystemSandboxPolicy
```

**Purpose**: Reconstructs what the older sandbox runtime would actually enforce for a current directory.

**Data flow**: It converts non-workspace policies directly. For workspace-write, it rebuilds read root, workspace write, temp writes, extra writable roots, and only the concrete metadata protections legacy runtime would add.

**Call relations**: `needs_direct_runtime_enforcement` compares this with the desired new policy to detect rules that the older runtime cannot express.

*Call graph*: calls 5 internal fn (from, restricted, append_default_read_only_path_if_no_explicit_rule, default_read_only_subpaths_for_writable_root, from_absolute_path); called by 4 (needs_direct_runtime_enforcement, legacy_projection_runtime_enforcement_ignores_entry_order, missing_symbolic_metadata_carveouts_need_direct_runtime_enforcement, split_only_nested_carveouts_need_direct_runtime_enforcement); 1 external calls (vec!).


##### `append_default_read_only_project_root_subpath_if_no_explicit_rule`  (lines 1713–1723)

```
fn append_default_read_only_project_root_subpath_if_no_explicit_rule(
    entries: &mut Vec<FileSystemSandboxEntry>,
    subpath: impl Into<PathBuf>,
)
```

**Purpose**: Adds a read-only project-root subpath rule unless the user already wrote an explicit rule for the same target.

**Data flow**: It receives entries and a subpath, wraps the subpath in a project-root special path, and delegates to the generic default-entry appender.

**Call relations**: `workspace_write` uses this to add symbolic `.git`, `.agents`, and `.codex` protections without overriding user intent.

*Call graph*: calls 1 internal fn (append_default_read_only_entry_if_no_explicit_rule); called by 1 (workspace_write); 2 external calls (into, project_roots).


##### `append_default_read_only_path_if_no_explicit_rule`  (lines 1725–1730)

```
fn append_default_read_only_path_if_no_explicit_rule(
    entries: &mut Vec<FileSystemSandboxEntry>,
    path: AbsolutePathBuf,
)
```

**Purpose**: Adds a read-only concrete path rule unless an explicit rule already targets it.

**Data flow**: It receives entries and an absolute path, wraps the path in a `FileSystemPath::Path`, and delegates to the generic default-entry appender.

**Call relations**: Workspace-write and legacy conversion use this for concrete protected metadata paths.

*Call graph*: calls 1 internal fn (append_default_read_only_entry_if_no_explicit_rule); called by 4 (from_legacy_sandbox_policy_for_cwd, with_additional_legacy_workspace_writable_roots, workspace_write, legacy_runtime_file_system_policy_for_cwd).


##### `append_default_read_only_entry_if_no_explicit_rule`  (lines 1732–1747)

```
fn append_default_read_only_entry_if_no_explicit_rule(
    entries: &mut Vec<FileSystemSandboxEntry>,
    path: FileSystemPath,
)
```

**Purpose**: Adds a default read-only entry only when no existing entry targets the same location.

**Data flow**: It scans existing entries with `file_system_paths_share_target`; if none match, it pushes a read entry for the given path.

**Call relations**: The project-root and concrete-path append helpers use this to protect metadata while respecting explicit configuration.

*Call graph*: called by 2 (append_default_read_only_path_if_no_explicit_rule, append_default_read_only_project_root_subpath_if_no_explicit_rule).


##### `has_explicit_resolved_path_entry`  (lines 1749–1754)

```
fn has_explicit_resolved_path_entry(
    entries: &[ResolvedFileSystemEntry],
    path: &AbsolutePathBuf,
) -> bool
```

**Purpose**: Checks whether a resolved entry list already contains a specific path.

**Data flow**: It receives resolved entries and a path, scans for exact path equality, and returns a boolean.

**Call relations**: Writable-root construction uses this to avoid adding default read-only carveouts that an explicit resolved rule already covers.

*Call graph*: 1 external calls (iter).


##### `metadata_path_name`  (lines 1756–1761)

```
fn metadata_path_name(name: &OsStr) -> Option<&'static str>
```

**Purpose**: Returns the protected metadata name if a path component is `.git`, `.agents`, or `.codex`.

**Data flow**: It receives a path component name, compares it with the protected-name list, and returns the matching static name or `None`.

**Call relations**: `metadata_child_of_writable_root` uses this to identify protected first components inside writable roots.


##### `metadata_child_of_writable_root`  (lines 1763–1779)

```
fn metadata_child_of_writable_root(
    policy: &FileSystemSandboxPolicy,
    target: &Path,
    cwd: &Path,
) -> Option<(AbsolutePathBuf, &'static str)>
```

**Purpose**: Detects whether a target path is inside protected metadata below a writable root.

**Data flow**: It resolves writable entries for the current directory, strips each writable root from the target, checks the first remaining component for a protected metadata name, and returns the metadata path and name.

**Call relations**: Both early write blocking and policy write checks use this to apply the `.git`, `.agents`, and `.codex` safety rule.

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

**Purpose**: Computes which protected metadata names should remain blocked for a writable root.

**Data flow**: It tests `.git`, `.agents`, and `.codex` under the effective root and raw writable-root aliases. If none of those paths are writable under the policy, it records the metadata name.

**Call relations**: `get_writable_roots_with_cwd` uses this to tell downstream sandboxes which top-level metadata names need special protection.

*Call graph*: 3 external calls (new, iter, vec!).


##### `protected_metadata_names_need_direct_runtime_enforcement`  (lines 1806–1834)

```
fn protected_metadata_names_need_direct_runtime_enforcement(
    policy: &FileSystemSandboxPolicy,
    legacy_policy: &SandboxPolicy,
    cwd: &Path,
) -> bool
```

**Purpose**: Checks whether protected metadata-name behavior is missing from the older legacy runtime representation.

**Data flow**: It compares writable roots from the new policy with writable roots from the legacy policy and returns true when a protected metadata name is not covered by a legacy read-only subpath.

**Call relations**: `needs_direct_runtime_enforcement` calls this before semantic comparison because metadata-name protections are partly outside the older sandbox contract.

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

**Purpose**: Checks whether a protected metadata path has an explicit write rule that should override the default block.

**Data flow**: It resolves entries, then looks for a writable entry that both covers the target and is itself inside the protected metadata path.

**Call relations**: Protected-metadata write checks call this so users can deliberately grant write access to `.git`, `.agents`, or `.codex` when configured.

*Call graph*: calls 1 internal fn (resolved_entries_with_cwd); called by 2 (is_metadata_write_denied, forbidden_agent_metadata_write).


##### `is_git_pointer_file`  (lines 1852–1855)

```
fn is_git_pointer_file(path: &AbsolutePathBuf) -> bool
```

**Purpose**: Checks whether a path is a `.git` file that may point to a real Git directory elsewhere.

**Data flow**: It tests that the path is a file and its filename is `.git`, then returns a boolean.

**Call relations**: `default_read_only_subpaths_for_writable_root` uses this for worktrees and submodules where `.git` is a pointer file rather than a directory.

*Call graph*: calls 1 internal fn (as_path); called by 1 (default_read_only_subpaths_for_writable_root); 1 external calls (new).


##### `resolve_gitdir_from_file`  (lines 1857–1914)

```
fn resolve_gitdir_from_file(dot_git: &AbsolutePathBuf) -> Option<AbsolutePathBuf>
```

**Purpose**: Reads a `.git` pointer file and resolves the Git directory it points to.

**Data flow**: It reads the file, expects `gitdir: <path>`, trims and validates the target, resolves it relative to the `.git` file's parent, checks that it exists, logs errors on failure, and returns the resolved path when valid.

**Call relations**: Default protected-subpath detection calls this so the real Git metadata directory can be made read-only too.

*Call graph*: calls 2 internal fn (as_path, resolve_path_against_base); called by 1 (default_read_only_subpaths_for_writable_root); 2 external calls (error!, read_to_string).


##### `tests::symlink_dir`  (lines 1929–1931)

```
fn symlink_dir(original: &Path, link: &Path) -> std::io::Result<()>
```

**Purpose**: Creates a directory symlink for Unix-only tests.

**Data flow**: It receives the original directory and link path, calls the operating system symlink function, and returns the I/O result.

**Call relations**: Symlink-focused tests call this to build realistic filesystem layouts.

*Call graph*: 1 external calls (symlink).


##### `tests::unknown_special_paths_are_ignored_by_legacy_bridge`  (lines 1934–1965)

```
fn unknown_special_paths_are_ignored_by_legacy_bridge() -> std::io::Result<()>
```

**Purpose**: Verifies that unknown future special paths do not break legacy conversion.

**Data flow**: It builds a policy with an unknown write special path, converts it to a legacy policy, and checks that the result safely becomes read-only.

**Call relations**: This protects forward compatibility for configuration written by newer Codex versions.

*Call graph*: calls 1 internal fn (restricted); 3 external calls (new, assert_eq!, vec!).


##### `tests::writable_roots_proactively_protect_missing_dot_codex`  (lines 1969–1992)

```
fn writable_roots_proactively_protect_missing_dot_codex()
```

**Purpose**: Verifies that a workspace root protects `.codex` even before the directory exists.

**Data flow**: It creates a temporary workspace, builds a project-root write policy, asks for writable roots, and checks that `.codex` appears as a read-only subpath.

**Call relations**: This test covers the metadata-protection path used by `get_writable_roots_with_cwd`.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::legacy_workspace_write_projection_preserves_symbolic_project_root`  (lines 1995–2038)

```
fn legacy_workspace_write_projection_preserves_symbolic_project_root()
```

**Purpose**: Verifies that legacy workspace-write conversion keeps symbolic project-root entries.

**Data flow**: It creates a legacy workspace-write policy, converts it, and compares the full expected entry list including symbolic metadata carveouts.

**Call relations**: This guards the bridge implemented by `FileSystemSandboxPolicy::from` and `workspace_write`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::legacy_current_working_directory_special_path_deserializes_as_project_roots`  (lines 2041–2059)

```
fn legacy_current_working_directory_special_path_deserializes_as_project_roots() -> serde_json::Result<()>
```

**Purpose**: Verifies that the old `current_working_directory` special-path name still loads as `project_roots`.

**Data flow**: It deserializes JSON with the old name, checks the resulting value, then serializes it back and checks the modern name.

**Call relations**: This keeps older config files compatible with the renamed special path.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::writable_roots_skip_default_dot_codex_when_explicit_user_rule_exists`  (lines 2063–2109)

```
fn writable_roots_skip_default_dot_codex_when_explicit_user_rule_exists()
```

**Purpose**: Verifies that an explicit write rule for `.codex` overrides the default protection.

**Data flow**: It builds a workspace-write policy plus an explicit `.codex` write entry, then checks writable-root metadata names, read-only subpaths, and direct write permission.

**Call relations**: This exercises the explicit-rule exceptions in metadata-protection logic.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 3 external calls (new, assert!, vec!).


##### `tests::filesystem_policy_blocks_protected_metadata_path_writes_by_default`  (lines 2112–2141)

```
fn filesystem_policy_blocks_protected_metadata_path_writes_by_default()
```

**Purpose**: Verifies that `.git`, `.agents`, and `.codex` are not writable by default inside a writable root.

**Data flow**: It creates a root write policy, checks write decisions for protected metadata paths, then checks writable-root metadata protection output.

**Call relations**: This test covers both direct write checks and downstream writable-root construction.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::legacy_workspace_write_projection_accepts_relative_cwd`  (lines 2144–2218)

```
fn legacy_workspace_write_projection_accepts_relative_cwd()
```

**Purpose**: Verifies that legacy conversion works even when the current directory is relative.

**Data flow**: It builds expected absolute paths from the process current directory plus a relative workspace, converts a legacy policy, and checks metadata protections and forbidden writes.

**Call relations**: This guards `from_legacy_sandbox_policy_for_cwd` and relative-path resolution.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_for_cwd, default_read_only_subpaths_for_writable_root, from_absolute_path); 5 external calls (new, assert!, assert_eq!, current_dir, vec!).


##### `tests::effective_runtime_roots_preserve_symlinked_paths`  (lines 2222–2269)

```
fn effective_runtime_roots_preserve_symlinked_paths()
```

**Purpose**: Verifies that writable roots and carveouts preserve important symlink path spellings.

**Data flow**: It creates a real directory and symlinked root, adds a denied subpath, and checks unreadable roots and writable-root read-only subpaths.

**Call relations**: This tests the symlink-sensitive behavior in writable and unreadable root collection.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::project_roots_special_path_preserves_symlinked_root`  (lines 2273–2340)

```
fn project_roots_special_path_preserves_symlinked_root()
```

**Purpose**: Verifies that project-root special paths keep a symlinked current directory as the visible root.

**Data flow**: It creates a symlinked workspace with blocked and metadata directories, builds a policy, and checks readable, unreadable, and writable-root outputs.

**Call relations**: This protects the project-root resolution path used during sandbox setup.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::writable_roots_preserve_symlinked_protected_subpaths`  (lines 2344–2380)

```
fn writable_roots_preserve_symlinked_protected_subpaths()
```

**Purpose**: Verifies that a protected metadata symlink itself is kept as the read-only subpath.

**Data flow**: It makes `.codex` a symlink to another directory, builds a writable-root policy, and checks that the read-only subpath is `.codex`, not just the symlink target.

**Call relations**: This guards downstream sandbox behavior that must mask the user-visible symlink inode.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::writable_roots_preserve_explicit_symlinked_carveouts_under_symlinked_roots`  (lines 2384–2426)

```
fn writable_roots_preserve_explicit_symlinked_carveouts_under_symlinked_roots()
```

**Purpose**: Verifies that explicit deny carveouts under symlinked roots keep their logical path.

**Data flow**: It creates a symlinked root and a denied symlinked child, then checks the writable root and read-only subpath list.

**Call relations**: This covers the raw-carveout preservation branch in `get_writable_roots_with_cwd`.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::writable_roots_preserve_explicit_symlinked_carveouts_that_escape_root`  (lines 2430–2473)

```
fn writable_roots_preserve_explicit_symlinked_carveouts_that_escape_root()
```

**Purpose**: Verifies that a denied symlink inside a root is protected even when it points outside the root.

**Data flow**: It creates a root with a symlink to an outside directory, denies the symlink path, and checks that the read-only subpath is the symlink path, not the outside target.

**Call relations**: This prevents symlink escapes from weakening carveout enforcement.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::writable_roots_preserve_explicit_symlinked_carveouts_that_alias_root`  (lines 2477–2507)

```
fn writable_roots_preserve_explicit_symlinked_carveouts_that_alias_root()
```

**Purpose**: Verifies that a symlink inside a root pointing back to the root can still be carved out.

**Data flow**: It creates an alias symlink, denies it, and checks that the writable root reports the alias path as read-only.

**Call relations**: This covers a subtle symlink loop-like case in writable-root carveout handling.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (new, assert_eq!, create_dir_all, symlink_dir, vec!).


##### `tests::tmpdir_special_path_preserves_symlinked_tmpdir`  (lines 2511–2581)

```
fn tmpdir_special_path_preserves_symlinked_tmpdir()
```

**Purpose**: Verifies that the `TMPDIR` special path preserves a symlinked temporary directory.

**Data flow**: It runs in a subprocess with a test environment variable, sets `TMPDIR` to a symlink, builds a policy, and checks unreadable and writable-root outputs.

**Call relations**: This guards `resolve_file_system_special_path` and writable-root behavior for environment-based temp directories.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 10 external calls (new, assert!, assert_eq!, new, create_dir_all, symlink_dir, current_exe, set_var, var_os, vec!).


##### `tests::resolve_access_with_cwd_uses_most_specific_entry`  (lines 2584–2631)

```
fn resolve_access_with_cwd_uses_most_specific_entry()
```

**Purpose**: Verifies that the most specific matching path rule wins.

**Data flow**: It builds a policy with workspace write, read-only docs, denied private docs, and writable nested public docs, then checks effective access at each level.

**Call relations**: This directly tests `resolve_access_with_cwd` and entry precedence.

*Call graph*: calls 2 internal fn (restricted, resolve_path_against_base); 3 external calls (new, assert_eq!, vec!).


##### `tests::split_only_nested_carveouts_need_direct_runtime_enforcement`  (lines 2634–2663)

```
fn split_only_nested_carveouts_need_direct_runtime_enforcement()
```

**Purpose**: Verifies that nested read-only carveouts require direct enforcement when legacy sandboxing cannot express them.

**Data flow**: It builds a workspace-write policy with a read-only child path and checks that direct runtime enforcement is required.

**Call relations**: This covers `needs_direct_runtime_enforcement` and the legacy runtime comparison.

*Call graph*: calls 3 internal fn (restricted, legacy_runtime_file_system_policy_for_cwd, resolve_path_against_base); 4 external calls (new, new_workspace_write_policy, assert!, vec!).


##### `tests::legacy_projection_runtime_enforcement_ignores_entry_order`  (lines 2666–2690)

```
fn legacy_projection_runtime_enforcement_ignores_entry_order()
```

**Purpose**: Verifies that policy entry order does not affect semantic equivalence or enforcement classification.

**Data flow**: It builds a legacy runtime policy, reverses its entries, and checks semantic equivalence and direct-enforcement results.

**Call relations**: This guards the normalized semantic-signature comparison.

*Call graph*: calls 2 internal fn (restricted, legacy_runtime_file_system_policy_for_cwd); 4 external calls (new, new, assert!, assert_eq!).


##### `tests::missing_symbolic_metadata_carveouts_need_direct_runtime_enforcement`  (lines 2693–2717)

```
fn missing_symbolic_metadata_carveouts_need_direct_runtime_enforcement()
```

**Purpose**: Verifies that symbolic metadata protections need direct enforcement when legacy runtime cannot represent missing paths.

**Data flow**: It builds both profile and legacy runtime projections for workspace-write and checks that direct enforcement is required.

**Call relations**: This protects the special handling for metadata names and missing `.codex` paths.

*Call graph*: calls 2 internal fn (from_legacy_sandbox_policy_for_cwd, legacy_runtime_file_system_policy_for_cwd); 3 external calls (new, new, assert!).


##### `tests::root_write_with_read_only_child_is_not_full_disk_write`  (lines 2720–2749)

```
fn root_write_with_read_only_child_is_not_full_disk_write()
```

**Purpose**: Verifies that root write plus a read-only child is not treated as full disk write.

**Data flow**: It builds that policy, checks full-write status, checks child access, checks direct enforcement, and expects legacy conversion to fail.

**Call relations**: This guards `has_write_narrowing_entries`, `has_full_disk_write_access`, and legacy conversion safety.

*Call graph*: calls 2 internal fn (restricted, resolve_path_against_base); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::root_deny_does_not_materialize_as_unreadable_root`  (lines 2752–2783)

```
fn root_deny_does_not_materialize_as_unreadable_root()
```

**Purpose**: Verifies that a root deny does not get exported as an unreadable root when a narrower read allow exists.

**Data flow**: It builds root deny plus readable docs, checks docs access and readable roots, and confirms unreadable roots are empty.

**Call relations**: This protects the filtering behavior in `get_unreadable_roots_with_cwd`.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_path_against_base); 5 external calls (new, assert!, assert_eq!, canonicalize_preserving_symlinks, vec!).


##### `tests::duplicate_root_deny_prevents_full_disk_write_access`  (lines 2786–2811)

```
fn duplicate_root_deny_prevents_full_disk_write_access()
```

**Purpose**: Verifies that an explicit root deny defeats a root write grant at the same target.

**Data flow**: It builds root write and root deny entries, checks that full write is false, and checks root access resolves to deny.

**Call relations**: This covers access-mode conflict precedence.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::same_specificity_write_override_keeps_full_disk_write_access`  (lines 2814–2839)

```
fn same_specificity_write_override_keeps_full_disk_write_access()
```

**Purpose**: Verifies that a same-target write entry can override a read entry for full-write detection.

**Data flow**: It builds root write plus both read and write entries for the same child path, then checks full-write status and resolved child access.

**Call relations**: This guards `has_same_target_write_override` and conflict precedence.

*Call graph*: calls 2 internal fn (restricted, resolve_path_against_base); 4 external calls (new, assert!, assert_eq!, vec!).


##### `tests::with_additional_readable_roots_skips_existing_effective_access`  (lines 2842–2857)

```
fn with_additional_readable_roots_skips_existing_effective_access()
```

**Purpose**: Verifies that adding readable roots does not duplicate access already granted.

**Data flow**: It builds a project-root read policy, tries to add the current root as readable, and checks that the policy is unchanged.

**Call relations**: This tests `with_additional_readable_roots`.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert_eq!, from_ref, vec!).


##### `tests::with_additional_writable_roots_skips_existing_effective_access`  (lines 2860–2875)

```
fn with_additional_writable_roots_skips_existing_effective_access()
```

**Purpose**: Verifies that adding writable roots skips paths already writable through project-root access.

**Data flow**: It builds a project-root write policy, tries to add the current root as writable, and checks that the policy is unchanged.

**Call relations**: This tests `with_additional_writable_roots`.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert_eq!, from_ref, vec!).


##### `tests::with_additional_writable_roots_adds_new_root`  (lines 2878–2907)

```
fn with_additional_writable_roots_adds_new_root()
```

**Purpose**: Verifies that a truly new writable root is appended.

**Data flow**: It builds a project-root write policy, adds a separate extra root, and checks the expected new write entry.

**Call relations**: This covers the positive path in `with_additional_writable_roots`.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert_eq!, from_ref, vec!).


##### `tests::materialize_project_roots_with_workspace_roots_expands_exact_and_glob_entries`  (lines 2910–2991)

```
fn materialize_project_roots_with_workspace_roots_expands_exact_and_glob_entries()
```

**Purpose**: Verifies that project-root special paths and marked glob patterns expand for every workspace root.

**Data flow**: It builds symbolic write, symbolic read, and symbolic glob deny entries, materializes them for two roots, and checks the full expanded entry list.

**Call relations**: This tests `materialize_project_roots_with_workspace_roots` and project-root glob expansion.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 3 external calls (new, assert_eq!, vec!).


##### `tests::materialize_project_roots_with_cwd_expands_symbolic_glob_entries`  (lines 2994–3016)

```
fn materialize_project_roots_with_cwd_expands_symbolic_glob_entries()
```

**Purpose**: Verifies that a project-root-marked glob can be materialized using the current directory.

**Data flow**: It builds a deny glob with the project-root marker, materializes with a temp current directory, and checks the absolute glob pattern.

**Call relations**: This tests `materialize_project_roots_with_cwd`.

*Call graph*: calls 1 internal fn (restricted); 3 external calls (new, assert_eq!, vec!).


##### `tests::with_additional_legacy_workspace_writable_roots_protects_metadata`  (lines 3019–3057)

```
fn with_additional_legacy_workspace_writable_roots_protects_metadata()
```

**Purpose**: Verifies that adding legacy writable roots also adds protected metadata carveouts.

**Data flow**: It creates an extra root with `.git`, adds it through the legacy helper, and checks that the result includes both write root and read-only `.git` entry.

**Call relations**: This tests `with_additional_legacy_workspace_writable_roots`.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (new, assert_eq!, create_dir_all, from_ref, vec!).


##### `tests::file_system_access_mode_orders_by_conflict_precedence`  (lines 3060–3063)

```
fn file_system_access_mode_orders_by_conflict_precedence()
```

**Purpose**: Verifies the intended ordering of access modes for conflict resolution.

**Data flow**: It checks that write outranks read and deny outranks write.

**Call relations**: This protects the enum ordering used by `resolved_entry_precedence`.

*Call graph*: 1 external calls (assert!).


##### `tests::legacy_bridge_preserves_explicit_deny_entries`  (lines 3066–3091)

```
fn legacy_bridge_preserves_explicit_deny_entries()
```

**Purpose**: Verifies that legacy policy rebuilding does not drop existing deny entries.

**Data flow**: It builds an existing policy with a denied path, rebuilds from a legacy workspace-write policy, and checks that the denied path remains.

**Call relations**: This tests `from_legacy_sandbox_policy_preserving_deny_entries`.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_preserving_deny_entries, restricted, try_from); 4 external calls (new, new_workspace_write_policy, assert!, vec!).


##### `tests::preserving_deny_entries_keeps_unrestricted_policy_enforceable`  (lines 3094–3113)

```
fn preserving_deny_entries_keeps_unrestricted_policy_enforceable()
```

**Purpose**: Verifies that preserving deny entries turns an unrestricted replacement into an enforceable restricted policy.

**Data flow**: It creates an existing deny-glob policy with scan depth, starts with unrestricted replacement, preserves denies, and compares the expected restricted full-write-plus-deny policy.

**Call relations**: This tests `preserve_deny_read_restrictions_from`.

*Call graph*: calls 2 internal fn (restricted, unrestricted); 3 external calls (assert_eq!, unreadable_glob_entry, vec!).


##### `tests::deny_policy`  (lines 3115–3122)

```
fn deny_policy(path: &Path) -> FileSystemSandboxPolicy
```

**Purpose**: Builds a small test policy that denies one absolute path.

**Data flow**: It receives a path, converts it to an absolute path, wraps it in a deny entry, and returns a restricted policy.

**Call relations**: Read-deny tests use this fixture to avoid repeating policy construction.

*Call graph*: calls 1 internal fn (restricted); 1 external calls (vec!).


##### `tests::unreadable_glob_entry`  (lines 3124–3129)

```
fn unreadable_glob_entry(pattern: String) -> FileSystemSandboxEntry
```

**Purpose**: Builds a test deny entry from a glob pattern.

**Data flow**: It receives a pattern string and returns a filesystem sandbox entry with deny access.

**Call relations**: Read-deny tests and helper policies use this fixture for glob-based denials.


##### `tests::default_policy_with_unreadable_glob`  (lines 3131–3135)

```
fn default_policy_with_unreadable_glob(pattern: String) -> FileSystemSandboxPolicy
```

**Purpose**: Builds a default read-only test policy with one extra unreadable glob.

**Data flow**: It starts from the default policy, appends a deny glob entry, and returns the policy.

**Call relations**: Glob read-deny tests use this to focus on matcher behavior.

*Call graph*: calls 1 internal fn (default); 1 external calls (unreadable_glob_entry).


##### `tests::is_read_denied`  (lines 3137–3144)

```
fn is_read_denied(
        path: &Path,
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
    ) -> bool
```

**Purpose**: Convenience helper for testing whether a path is denied by a policy.

**Data flow**: It builds a `ReadDenyMatcher` from the policy and current directory, then asks it whether the path is denied; if no matcher exists, it returns false.

**Call relations**: The read-deny test cases call this to exercise `ReadDenyMatcher::new` and `ReadDenyMatcher::is_read_denied`.

*Call graph*: calls 1 internal fn (new).


##### `tests::exact_path_and_descendants_are_denied`  (lines 3147–3162)

```
fn exact_path_and_descendants_are_denied()
```

**Purpose**: Verifies that an exact deny root blocks both that directory and its children.

**Data flow**: It creates a denied directory and nested file, builds a deny policy, and checks that those paths are denied while an unrelated path is not.

**Call relations**: This tests exact-root matching in `ReadDenyMatcher`.

*Call graph*: 5 external calls (new, assert!, deny_policy, create_dir_all, write).


##### `tests::canonical_target_matches_denied_symlink_alias`  (lines 3166–3179)

```
fn canonical_target_matches_denied_symlink_alias()
```

**Purpose**: Verifies that a symlink alias to a denied directory is also denied.

**Data flow**: It creates a real directory, a symlink alias, and a file, denies the real directory, and checks that reading through the alias is denied.

**Call relations**: This tests canonical candidate matching in read-deny logic.

*Call graph*: 6 external calls (new, assert!, deny_policy, symlink_dir, create_dir_all, write).


##### `tests::literal_patterns_and_globs_are_denied`  (lines 3182–3197)

```
fn literal_patterns_and_globs_are_denied()
```

**Purpose**: Verifies that exact deny roots and glob deny patterns both work in the same policy.

**Data flow**: It creates a literal denied directory and a text file matched by a glob, then checks both are denied.

**Call relations**: This covers combined root and glob matching in `ReadDenyMatcher`.

*Call graph*: 7 external calls (new, assert!, format!, deny_policy, unreadable_glob_entry, create_dir_all, write).


##### `tests::glob_patterns_deny_matching_paths`  (lines 3200–3212)

```
fn glob_patterns_deny_matching_paths()
```

**Purpose**: Verifies that a simple glob pattern denies matching paths.

**Data flow**: It creates a path like `private/secret1.txt`, adds a `secret?.txt` deny glob, and checks that the file is denied.

**Call relations**: This tests pattern compilation and matching.

*Call graph*: 6 external calls (new, assert!, format!, default_policy_with_unreadable_glob, create_dir_all, write).


##### `tests::glob_patterns_do_not_cross_path_separators`  (lines 3215–3236)

```
fn glob_patterns_do_not_cross_path_separators()
```

**Purpose**: Verifies that `*`, `?`, and character classes do not match across directory separators.

**Data flow**: It creates matching, nested, short, and letter-containing filenames, applies a glob, and checks only the intended same-directory numeric filename is denied.

**Call relations**: This protects the `literal_separator` behavior configured in `build_glob_matcher`.

*Call graph*: 6 external calls (new, assert!, format!, default_policy_with_unreadable_glob, create_dir_all, write).


##### `tests::globstar_patterns_deny_root_and_nested_matches`  (lines 3239–3255)

```
fn globstar_patterns_deny_root_and_nested_matches()
```

**Purpose**: Verifies that `**` glob patterns match both root-level and nested files.

**Data flow**: It creates `.env` files at root and nested locations plus a nonmatching notes file, applies a `**/*.env` deny glob, and checks the expected denials.

**Call relations**: This tests globstar behavior in deny-read patterns.

*Call graph*: 6 external calls (new, assert!, format!, default_policy_with_unreadable_glob, create_dir_all, write).


##### `tests::unclosed_character_classes_match_literal_brackets`  (lines 3258–3268)

```
fn unclosed_character_classes_match_literal_brackets()
```

**Purpose**: Verifies that an unclosed `[` in a glob pattern is treated as a literal bracket.

**Data flow**: It creates a file named `[`, adds a glob ending in `[`, and checks that only that file is denied.

**Call relations**: This protects the `allow_unclosed_class` behavior in `build_glob_matcher`.

*Call graph*: 5 external calls (new, assert!, format!, default_policy_with_unreadable_glob, write).


### `protocol/src/models.rs`

`data_model` · `cross-cutting`

Think of this file as the project’s common dictionary. It names the objects that travel through Codex: user messages, assistant responses, tool calls, shell command requests, permission profiles, images, web searches, and compaction records. Many of these objects are serialized, meaning they are turned into JSON for storage or network/API calls, and deserialized back into Rust types when received.

A large part of the file keeps old and new permission formats working together. Codex can run commands inside a sandbox, which is a safety boundary that limits file and network access. This file describes whether that sandbox is managed by Codex, disabled, or supplied by an outside caller, and it translates older sandbox settings into the newer profile model.

Another major part describes conversation items. It records plain text, images, reasoning summaries, function calls, local shell calls, MCP tool results, and metadata such as turn IDs. It also prepares local images for model prompts and replaces unreadable or unsupported images with clear text placeholders instead of failing silently.

The file also centralizes special wire behavior, such as tool output being either a plain string or structured content items. That keeps callers from each inventing slightly different JSON shapes.

#### Function details

##### `SandboxPermissions::requires_escalated_permissions`  (lines 49–51)

```
fn requires_escalated_permissions(self) -> bool
```

**Purpose**: Answers whether a command is asking to run fully outside the sandbox. Callers use this as a safety check before allowing stronger permissions.

**Data flow**: It receives one sandbox-permission choice, compares it with the escalated option, and returns true only for that exact choice. It does not change anything.

**Call relations**: Command execution and sandbox-planning code call this before deciding whether to bypass normal restrictions or preserve denied reads.

*Call graph*: called by 4 (exec_env_for_sandbox_permissions, managed_network_for_sandbox_permissions, sandbox_override_for_first_attempt, sandbox_permissions_preserving_denied_reads); 1 external calls (matches!).


##### `SandboxPermissions::requests_sandbox_override`  (lines 55–57)

```
fn requests_sandbox_override(self) -> bool
```

**Purpose**: Answers whether a command asked for any permission behavior different from the default. This lets UI and event code show that a command made a special request.

**Data flow**: It receives a permission choice, checks whether it is not the default choice, and returns a boolean. Nothing is modified.

**Call relations**: Shell event builders call it when recording command events so they can mark commands that requested extra sandbox treatment.

*Call graph*: called by 3 (exec_command_event, shell_event_with_prefix_rule, exec_command_event); 1 external calls (matches!).


##### `SandboxPermissions::uses_additional_permissions`  (lines 61–63)

```
fn uses_additional_permissions(self) -> bool
```

**Purpose**: Answers whether a command wants to stay sandboxed but temporarily widen access. This distinguishes limited extra access from full escalation.

**Data flow**: It receives one permission value, compares it with the additional-permissions option, and returns true only in that case.

**Call relations**: Permission-granting code calls it when applying approved turn permissions or inferring what permissions were granted.

*Call graph*: called by 2 (apply_granted_turn_permissions, implicit_granted_permissions); 1 external calls (matches!).


##### `FileSystemPermissions::try_from`  (lines 88–97)

```
fn try_from(value: FileSystemPermissions<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts file-system permissions written with URI-style paths into permissions using absolute local paths. This is needed when JSON-friendly paths come back into runtime code.

**Data flow**: It takes permission entries containing path URIs, tries to convert every entry into an absolute path, keeps the glob depth setting, and returns either converted permissions or an I/O error.

**Call relations**: It supports boundary crossings where protocol data must become local filesystem data before sandbox enforcement.


##### `FileSystemPermissions::default`  (lines 101–106)

```
fn default() -> Self
```

**Purpose**: Creates an empty file-system permission set. This is the safe starting point: no entries and no glob scanning depth.

**Data flow**: It takes no input, creates an empty list and no depth limit, and returns the new permission object.

**Call relations**: Normalization code uses this when dropping empty nested permission profiles.

*Call graph*: called by 1 (normalize_additional_permissions_drops_empty_nested_profiles); 1 external calls (new).


##### `FileSystemPermissions::is_empty`  (lines 112–114)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether there are no file-system permission entries. Callers can use this to avoid treating an empty permission block as meaningful access.

**Data flow**: It reads the entries list and returns true if that list has no items.

**Call relations**: It is a small helper for code that needs to tell empty permissions from explicit read or write grants.


##### `FileSystemPermissions::from_read_write_roots`  (lines 116–137)

```
fn from_read_write_roots(
        read: Option<Vec<PathType>>,
        write: Option<Vec<PathType>>,
    ) -> Self
```

**Purpose**: Builds modern file-system permission entries from older separate read-root and write-root lists. This keeps older configuration shapes useful.

**Data flow**: It receives optional read paths and optional write paths, turns each path into a permission entry with the matching access mode, and returns one combined permission object.

**Call relations**: Many permission-request and sandbox-context paths call it when turning legacy root lists into the current entry-based model.

*Call graph*: called by 39 (request_permissions_response_materializes_session_cwd_grants_before_recording, write_permissions_for_paths, file_system_permissions, file_system_sandbox_context_uses_active_attempt, preapproved_additional_permissions_escalate_intercepted_exec, shell_request_escalation_execution_is_explicit, extension_tool_uses_granted_turn_permissions, remote_request_permissions_grant_unblocks_later_remote_exec, normalized_directory_write_permissions, partial_request_permissions_grants_do_not_preapprove_new_permissions (+15 more)); 1 external calls (new).


##### `FileSystemPermissions::explicit_path_entries`  (lines 139–144)

```
fn explicit_path_entries(&self) -> impl Iterator<Item = (&PathType, FileSystemAccessMode)>
```

**Purpose**: Iterates only over direct path-based permissions, ignoring glob patterns and special symbolic paths. This helps callers that specifically need concrete filesystem paths.

**Data flow**: It reads each permission entry, keeps entries whose path is a normal path, and yields the path plus its access mode.

**Call relations**: It is used as a filtering view over the broader permission model when concrete paths are required.


##### `FileSystemPermissions::legacy_read_write_roots`  (lines 146–152)

```
fn legacy_read_write_roots(&self) -> Option<LegacyReadWriteRoots<PathType>>
```

**Purpose**: Attempts to express current permissions in the older read-list/write-list format. It only succeeds when nothing in the permissions is too new for that format.

**Data flow**: It reads the permission entries, asks the private legacy converter to validate and split them, and returns optional read and write root lists.

**Call relations**: It delegates to `as_legacy_permissions`, which is also used by serialization to decide whether old JSON can be emitted.

*Call graph*: calls 1 internal fn (as_legacy_permissions).


##### `FileSystemPermissions::as_legacy_permissions`  (lines 154–180)

```
fn as_legacy_permissions(&self) -> Option<LegacyFileSystemPermissions<PathType>>
```

**Purpose**: Checks whether file-system permissions can safely be represented in the old format. It rejects newer features such as glob depth, glob entries, special paths, or explicit denies.

**Data flow**: It scans all entries, separates read paths from write paths, and returns a legacy object if every entry is compatible; otherwise it returns none.

**Call relations**: Both `legacy_read_write_roots` and custom serialization rely on this to avoid losing meaning when using the older shape.

*Call graph*: called by 2 (legacy_read_write_roots, serialize); 1 external calls (new).


##### `FileSystemPermissions::serialize`  (lines 214–227)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Writes file-system permissions to JSON in the simplest compatible shape. It uses the old read/write shape when possible and the full canonical shape when needed.

**Data flow**: It receives the permission object, tries the legacy conversion, then serializes either that legacy form or the full entries-plus-depth form.

**Call relations**: Serde, the Rust JSON serialization framework, calls this whenever these permissions are sent over the wire or stored.

*Call graph*: calls 1 internal fn (as_legacy_permissions).


##### `FileSystemPermissions::deserialize`  (lines 234–250)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads file-system permissions from either the new canonical JSON shape or the older read/write shape. This protects compatibility with stored data and older clients.

**Data flow**: It receives JSON data, lets Serde parse it as one of the supported shapes, then returns a unified `FileSystemPermissions` value.

**Call relations**: Serde calls it during config, rollout, or protocol loading; it uses `from_read_write_roots` for legacy data.

*Call graph*: 2 external calls (from_read_write_roots, deserialize).


##### `NetworkPermissions::is_empty`  (lines 259–261)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a network permission override says nothing. An absent setting means there is no network change requested.

**Data flow**: It reads the optional enabled flag and returns true when that flag is missing.

**Call relations**: It is a simple helper for permission overlay logic that needs to ignore empty network blocks.


##### `AdditionalPermissionProfile::is_empty`  (lines 273–275)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a per-command or granted permission overlay contains no file or network section. This prevents empty wrappers from being mistaken for real grants.

**Data flow**: It reads the optional network and file-system fields and returns true only if both are absent.

**Call relations**: Tests and permission-normalization paths use this to distinguish no overlay from an explicit, even if nested-empty, overlay.


##### `SandboxEnforcement::from_legacy_sandbox_policy`  (lines 293–299)

```
fn from_legacy_sandbox_policy(sandbox_policy: &SandboxPolicy) -> Self
```

**Purpose**: Translates an older sandbox policy into the newer idea of who enforces the sandbox. This is part of the bridge from old configuration to permission profiles.

**Data flow**: It receives a legacy sandbox policy and returns managed, disabled, or external enforcement based on the policy kind.

**Call relations**: Configuration application, one-off command execution, and agent-spawn setup call it before building modern permission profiles.

*Call graph*: called by 12 (exec_one_off_command_inner, can_set_legacy_sandbox_policy, set_legacy_sandbox_policy, apply, session_configuration_apply_permission_profile_preserves_existing_deny_read_entries, session_configuration_apply_preserves_profile_file_system_policy_on_cwd_only_update, session_configuration_apply_retargets_legacy_workspace_root_on_cwd_update, build_agent_spawn_config_uses_turn_context_values, spawn_agent_reapplies_runtime_sandbox_after_role_config, from_legacy_sandbox_policy (+2 more)).


##### `ManagedFileSystemPermissions::from`  (lines 321–337)

```
fn from(value: ManagedFileSystemPermissions<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts managed file-system permissions from local absolute paths into URI-style paths. This makes the data safe to send through protocol JSON.

**Data flow**: It takes either restricted entries or unrestricted access, converts each path entry when restricted, and returns the same permission meaning with URI paths.

**Call relations**: It supports protocol boundaries where local runtime permission data must be represented in client-friendly path form.


##### `ManagedFileSystemPermissions::try_from`  (lines 345–361)

```
fn try_from(value: ManagedFileSystemPermissions<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts managed file-system permissions from URI-style paths back into local absolute paths. This is needed before the runtime can enforce paths on disk.

**Data flow**: It takes URI-based permissions, converts every restricted entry into an absolute path, preserves unrestricted access as-is, and returns an error if any path conversion fails.

**Call relations**: It is the reverse of the URI conversion used when protocol data returns to runtime enforcement code.


##### `ManagedFileSystemPermissions::from_sandbox_policy`  (lines 365–378)

```
fn from_sandbox_policy(file_system_sandbox_policy: &FileSystemSandboxPolicy) -> Self
```

**Purpose**: Builds the managed permission form from a runtime file-system sandbox policy. It keeps the profile model aligned with the lower-level sandbox model.

**Data flow**: It reads whether the sandbox policy is restricted or unrestricted, copies entries and scan depth for restricted policies, and returns the matching managed permission variant.

**Call relations**: Permission-profile constructors call it for read-only, workspace-write, materialized roots, and runtime-policy conversion.

*Call graph*: called by 4 (from_runtime_permissions_with_enforcement, materialize_project_roots_with_workspace_roots, read_only, workspace_write_with); 1 external calls (unreachable!).


##### `ManagedFileSystemPermissions::to_sandbox_policy`  (lines 380–392)

```
fn to_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Turns managed profile permissions back into the runtime sandbox policy that enforcement code understands.

**Data flow**: It reads the managed variant, clones restricted entries and depth into a sandbox policy, or returns an unrestricted sandbox policy.

**Call relations**: Permission-profile methods call it when they need to hand file-system rules to sandbox execution or legacy conversion.

*Call graph*: calls 1 internal fn (unrestricted).


##### `PermissionProfile::try_from`  (lines 443–455)

```
fn try_from(value: PermissionProfile<PathUri>) -> Result<Self, Self::Error>
```

**Purpose**: Converts a permission profile using URI paths into one using absolute local paths. This prepares protocol data for runtime use.

**Data flow**: It receives a URI-based profile, converts the file-system part when the profile is managed, leaves disabled and external profiles structurally unchanged, and returns an error on bad paths.

**Call relations**: It is used when permission profiles cross from serialized/client form back into local execution form.


##### `ActivePermissionProfile::new`  (lines 479–484)

```
fn new(id: impl Into<String>) -> Self
```

**Purpose**: Creates metadata naming the permission profile currently in effect. This is for display and traceability, not enforcement.

**Data flow**: It receives an identifier, converts it into a string, sets no parent profile, and returns the metadata object.

**Call relations**: `ActivePermissionProfile::read_only` calls it for the built-in read-only profile, and callers can use it for user-defined profile IDs.

*Call graph*: 1 external calls (into).


##### `ActivePermissionProfile::read_only`  (lines 486–488)

```
fn read_only() -> Self
```

**Purpose**: Creates active-profile metadata for the built-in read-only profile. This gives clients a stable label to show.

**Data flow**: It takes no input, passes the reserved read-only profile ID to `new`, and returns the metadata.

**Call relations**: It is a convenience wrapper over `ActivePermissionProfile::new` for the common safest built-in profile.

*Call graph*: 1 external calls (new).


##### `PermissionProfile::default`  (lines 492–500)

```
fn default() -> Self
```

**Purpose**: Creates the default permission profile: managed sandboxing, no file entries, and restricted network. This is a conservative baseline.

**Data flow**: It takes no input and returns a managed profile with empty restricted file-system permissions and restricted network access.

**Call relations**: Tool-listing and setup tests rely on this default when no special profile is supplied.

*Call graph*: called by 14 (list_all_tools_accepts_canonical_namespaced_tool_names, list_all_tools_adds_server_metadata_to_cached_tools, list_all_tools_applies_legacy_mcp_prefix_by_default, list_all_tools_blocks_while_client_is_pending_without_cached_tool_info_snapshot, list_all_tools_does_not_block_when_cached_tool_info_snapshot_is_empty, list_all_tools_uses_cached_tool_info_snapshot_when_client_startup_fails, list_all_tools_uses_cached_tool_info_snapshot_while_client_is_pending, list_available_server_infos_uses_cache_while_client_is_pending, no_local_runtime_fails_local_stdio_but_keeps_local_http_server, shutdown_cancels_pending_tool_listing (+4 more)); 1 external calls (new).


##### `PermissionProfile::read_only`  (lines 505–511)

```
fn read_only() -> Self
```

**Purpose**: Builds the built-in read-only permission profile. It lets Codex read but not freely write files, with network access restricted.

**Data flow**: It creates a read-only file-system sandbox policy, converts it into managed profile permissions, attaches restricted network policy, and returns the profile.

**Call relations**: Configuration, rollback, sandbox execution, and many tests call it when they need the safest built-in permission mode.

*Call graph*: calls 2 internal fn (from_sandbox_policy, read_only); called by 153 (rollback_response_rebuilds_pathless_thread_from_stored_history, cancellation_expiration_keeps_process_alive_until_terminated, timeout_or_cancellation_reports_cancellation_without_timeout_exit_code, windows_sandbox_exec_request, requested_permissions_trust_project_uses_permission_profile_intent, summary_from_stored_thread_preserves_millisecond_precision, default, try_from, derive_permission_profile, load_config_with_layer_stack (+15 more)).


##### `PermissionProfile::workspace_write`  (lines 518–525)

```
fn workspace_write() -> Self
```

**Purpose**: Builds the built-in workspace-write profile. This lets Codex write in workspace areas while keeping network access restricted.

**Data flow**: It calls `workspace_write_with` with no extra roots and default exclusion flags, then returns that profile.

**Call relations**: Sandbox-mode derivation and permission-profile selection call it for the common editable-project mode.

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

**Purpose**: Builds a workspace-write profile with explicit writable roots and network behavior. This is the configurable version of the workspace preset.

**Data flow**: It receives writable roots, network policy, and temporary-directory exclusion flags, asks the sandbox policy layer to build file rules, converts those rules into managed permissions, and returns a profile.

**Call relations**: Configuration loading and sandbox approval tests call it when workspace-write needs custom roots or flags.

*Call graph*: calls 2 internal fn (from_sandbox_policy, workspace_write); called by 33 (deserialize_allowed_sandbox_modes, remote_sandbox_config_first_match_overrides_top_level, derive_permission_profile, builtin_permission_profile, windows_restricted_token_allows_workspace_write_profiles, granular_sandbox_approval_false_rejects_out_of_root_patch, granular_with_all_flags_true_matches_on_request_for_out_of_root_patch, missing_project_dot_codex_config_requires_approval, restrictive_workspace_write_profile, restrictive_workspace_write_profile (+15 more)).


##### `PermissionProfile::materialize_project_roots_with_workspace_roots`  (lines 549–569)

```
fn materialize_project_roots_with_workspace_roots(
        self,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Replaces symbolic workspace-root permissions with actual project root paths. This makes a profile ready for real enforcement.

**Data flow**: It consumes a profile, and if it is managed, converts its file-system rules through sandbox-policy materialization using the provided workspace roots; other profile kinds pass through unchanged.

**Call relations**: It bridges profile definitions that mention symbolic roots with runtime policies that need concrete paths.

*Call graph*: calls 1 internal fn (from_sandbox_policy).


##### `PermissionProfile::from_runtime_permissions`  (lines 571–586)

```
fn from_runtime_permissions(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        network_sandbox_policy: NetworkSandboxPolicy,
    ) -> Self
```

**Purpose**: Builds a permission profile from the lower-level runtime file and network sandbox policies. This lets old runtime settings be viewed as the newer profile model.

**Data flow**: It reads the file-system policy kind to infer enforcement, then delegates to the more explicit conversion function with the network policy included.

**Call relations**: Config loading and many sandbox tests call it when turning runtime permission pieces into one profile.

*Call graph*: called by 65 (requested_permissions_trust_project_uses_permission_profile_intent, load_config_with_layer_stack, permission_profile_override_keeps_memories_root_out_of_legacy_projection, workspace_write_permission_profile_with_private_denials, managed_cwd_write_profile_has_filesystem_restrictions, managed_full_disk_write_profile_has_no_filesystem_restrictions, managed_unresolvable_write_profile_has_filesystem_restrictions, writable_windows_policy_without_sandbox_backend_still_requires_approval, windows_elevated_allows_split_restricted_read_policies, windows_elevated_rejects_reopened_writable_descendants (+15 more)); 1 external calls (from_runtime_permissions_with_enforcement).


##### `PermissionProfile::from_runtime_permissions_with_enforcement`  (lines 588–609)

```
fn from_runtime_permissions_with_enforcement(
        enforcement: SandboxEnforcement,
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        network_sandbox_policy: NetworkSandboxPolic
```

**Purpose**: Builds a permission profile from runtime sandbox policies plus an explicit enforcement choice. This preserves subtle cases like unrestricted files but restricted network.

**Data flow**: It receives enforcement, file-system policy, and network policy, then returns external, disabled, or managed profile form according to the combination.

**Call relations**: It is the central constructor used by legacy conversion, config application, one-off command setup, and permission projection.

*Call graph*: calls 1 internal fn (from_sandbox_policy); called by 23 (managed_full_disk_with_restricted_network_reports_external_sandbox, exec_one_off_command_inner, load_config_with_layer_stack, can_set_legacy_sandbox_policy, set_legacy_sandbox_policy, permission_profile_override_preserves_split_write_roots, apply, set_permission_profile_projection, record_context_updates_and_set_reference_context_item_persists_split_file_system_policy_to_rollout, session_configuration_apply_permission_profile_preserves_existing_deny_read_entries (+13 more)).


##### `PermissionProfile::from_legacy_sandbox_policy`  (lines 611–617)

```
fn from_legacy_sandbox_policy(sandbox_policy: &SandboxPolicy) -> Self
```

**Purpose**: Converts an old `SandboxPolicy` into a modern permission profile. This keeps older callers and stored settings compatible.

**Data flow**: It receives the legacy policy, derives enforcement, file-system policy, and network policy from it, then delegates to the explicit runtime conversion.

**Call relations**: Round-trip tests call it directly, and production paths use the same pattern when migrating legacy sandbox settings.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy, from, from); called by 2 (permission_profile_round_trip_preserves_disabled_sandbox, permission_profile_round_trip_preserves_external_sandbox); 1 external calls (from_runtime_permissions_with_enforcement).


##### `PermissionProfile::from_legacy_sandbox_policy_for_cwd`  (lines 619–625)

```
fn from_legacy_sandbox_policy_for_cwd(sandbox_policy: &SandboxPolicy, cwd: &Path) -> Self
```

**Purpose**: Converts an old sandbox policy into a permission profile while taking the current working directory into account. This matters because some legacy policies are relative to where the session runs.

**Data flow**: It receives a legacy policy and a directory, derives cwd-aware file-system rules plus network and enforcement settings, then returns the modern profile.

**Call relations**: Turn submission, session settings, and thread-resume code call it when applying older sandbox settings to an active session.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); called by 6 (submit_turn_with_policies, deserialize, apply_thread_settings_to_session, display_permission_profile_from_thread_response, thread_session_state_from_thread_resume_response, apply_thread_settings); 1 external calls (from_runtime_permissions_with_enforcement).


##### `PermissionProfile::enforcement`  (lines 627–633)

```
fn enforcement(&self) -> SandboxEnforcement
```

**Purpose**: Reports who is responsible for sandbox enforcement for this profile. This is useful for execution setup and UI summaries.

**Data flow**: It reads the profile variant and returns managed, disabled, or external enforcement.

**Call relations**: Sandbox-context builders and permission projection code call it before deciding how to execute commands.

*Call graph*: called by 4 (set_permission_profile_projection, file_system_sandbox_context, with_managed_mitm_ca_readable_root, effective_permission_profile).


##### `PermissionProfile::file_system_sandbox_policy`  (lines 635–641)

```
fn file_system_sandbox_policy(&self) -> FileSystemSandboxPolicy
```

**Purpose**: Extracts the runtime file-system sandbox policy represented by a permission profile. This is the shape that sandbox enforcement code understands.

**Data flow**: It reads the profile: managed profiles convert their file-system permissions, disabled profiles become unrestricted, and external profiles become an external-sandbox marker.

**Call relations**: Sandbox mode calculation, trust checks, and runtime permission conversion call it whenever file access rules are needed.

*Call graph*: calls 2 internal fn (external_sandbox, unrestricted); called by 13 (sandbox_policy_mode, permission_profile_trusts_project, sandbox_mode_requirement_for_permission_profile, profile_has_managed_filesystem_restrictions, permission_profile_policy_tag, file_system_sandbox_policy, sandbox_mode_from_permission_profile, from_permission_profile, to_runtime_permissions, add_dir_warning_message (+3 more)).


##### `PermissionProfile::network_sandbox_policy`  (lines 643–648)

```
fn network_sandbox_policy(&self) -> NetworkSandboxPolicy
```

**Purpose**: Extracts the network sandbox policy from a permission profile. Disabled profiles imply network enabled because there is no sandbox.

**Data flow**: It reads the profile and returns its stored network policy for managed or external profiles, or enabled network for disabled profiles.

**Call relations**: Network proxy setup, sandbox spawning, and runtime permission conversion call it to decide whether network access is allowed.

*Call graph*: called by 11 (sandbox_policy_mode, network_proxy_spec_for_active_permission_profile, spawn_command_under_linux_sandbox, network_sandbox_policy, sandbox_mode_from_permission_profile, from_permission_profile, to_runtime_permissions, sandbox_mode_from_permission_profile, preset_matches_current, legacy_compatible_permission_profile (+1 more)).


##### `PermissionProfile::to_legacy_sandbox_policy`  (lines 650–667)

```
fn to_legacy_sandbox_policy(&self, cwd: &Path) -> io::Result<SandboxPolicy>
```

**Purpose**: Attempts to represent the modern permission profile as an old `SandboxPolicy`. This supports older APIs and summaries that still use the legacy type.

**Data flow**: It receives a current working directory, converts managed profiles through the file-system sandbox policy, maps disabled to full access, and maps external profiles to the legacy external form.

**Call relations**: Compatibility and summary code call it when they must speak the older sandbox-policy language.

*Call graph*: called by 4 (turn_permission_fields, compatibility_sandbox_policy_for_permission_profile, legacy_compatible_permission_profile, summarize_permission_profile).


##### `PermissionProfile::to_runtime_permissions`  (lines 669–674)

```
fn to_runtime_permissions(&self) -> (FileSystemSandboxPolicy, NetworkSandboxPolicy)
```

**Purpose**: Splits a permission profile into the file-system and network policies used by command execution. This is a convenience for runtime setup.

**Data flow**: It reads the profile, calls the file-system and network extraction helpers, and returns the two policies as a pair.

**Call relations**: Execution request builders, sandbox contexts, and thread permission application call it before launching or configuring work.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, network_sandbox_policy); called by 12 (build_exec_request, resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides, new, set_permission_profile_projection, file_system_sandbox_context, sandbox_exec_request, apply_permission_profile_to_current_thread, should_warn_about_system_bwrap, with_managed_mitm_ca_readable_root (+2 more)).


##### `PermissionProfile::from`  (lines 718–743)

```
fn from(value: LegacyPermissionProfile<PathType>) -> Self
```

**Purpose**: Converts a tagged deserialized permission profile into the main `PermissionProfile` enum. This separates JSON parsing details from the runtime type.

**Data flow**: It receives a tagged profile value, matches its kind, and returns the corresponding managed, disabled, or external profile.

**Call relations**: Custom deserialization uses this after Serde has recognized the tagged JSON shape.


##### `PermissionProfile::deserialize`  (lines 757–765)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads permission profiles from JSON in either the modern tagged shape or an older rollout shape. This keeps stored histories and older data readable.

**Data flow**: It lets Serde parse the incoming JSON as tagged or legacy, converts whichever form was found, and returns a unified permission profile.

**Call relations**: Serde calls it whenever a `PermissionProfile` is loaded from protocol JSON, config, or stored rollout data.

*Call graph*: 1 external calls (deserialize).


##### `NetworkPermissions::from`  (lines 769–773)

```
fn from(value: NetworkSandboxPolicy) -> Self
```

**Purpose**: Converts a runtime network sandbox policy into a simple optional enabled flag. This is mainly for permission overlay formats.

**Data flow**: It reads whether the runtime network policy is enabled and stores that boolean in `NetworkPermissions`.

**Call relations**: Permission conversion code uses it when projecting runtime network state into protocol-friendly permission data.

*Call graph*: calls 1 internal fn (is_enabled).


##### `FileSystemPermissions::from`  (lines 777–793)

```
fn from(value: &FileSystemSandboxPolicy) -> Self
```

**Purpose**: Converts a runtime file-system sandbox policy into the simpler file-system permissions structure. Unrestricted or external policies become a root write entry.

**Data flow**: It reads the sandbox policy kind, copies restricted entries or creates an all-root write marker, converts glob depth to a non-zero value if present, and returns permissions.

**Call relations**: Permission projection code uses it when representing runtime sandbox policy as protocol-level permissions.

*Call graph*: 1 external calls (vec!).


##### `FileSystemSandboxPolicy::from`  (lines 797–801)

```
fn from(value: &FileSystemPermissions) -> Self
```

**Purpose**: Converts protocol-level file-system permissions into a restricted runtime sandbox policy. This gives enforcement code the rule set it expects.

**Data flow**: It receives file-system permissions, copies entries into a restricted policy, copies the glob depth, and returns the policy.

**Call relations**: This conversion is used when permission overlays or serialized permission data must become sandbox rules.

*Call graph*: calls 1 internal fn (restricted).


##### `plaintext_agent_message_content`  (lines 867–878)

```
fn plaintext_agent_message_content(content: &[AgentMessageInputContent]) -> Option<String>
```

**Purpose**: Returns readable text from an agent message only if every part is plain text. If any part is encrypted, it refuses to pretend the whole message is readable.

**Data flow**: It receives content parts, collects text parts, stops with none if encrypted content appears, joins text with newlines, and returns none for empty text.

**Call relations**: Transcript, thread-section, and visible-message builders call it when deciding what can safely be shown as local plaintext.

*Call graph*: called by 3 (collect_guardian_transcript_entries, build_current_thread_section, push_visible_message); 2 external calls (with_capacity, len).


##### `ResponseItem::is_user_message`  (lines 1122–1124)

```
fn is_user_message(&self) -> bool
```

**Purpose**: Checks whether a response item is a normal message from the user. This is a quick filter for conversation processing.

**Data flow**: It reads the item variant and role field, returning true only for a message whose role is exactly `user`.

**Call relations**: Callers use it when separating user input messages from tool calls, assistant messages, and other response items.

*Call graph*: 1 external calls (matches!).


##### `ResponseItem::turn_id`  (lines 1127–1131)

```
fn turn_id(&self) -> Option<&str>
```

**Purpose**: Reads the non-empty turn ID attached to a response item, if it has one. A turn ID links items back to a conversation turn.

**Data flow**: It asks for the item metadata, reads the optional turn ID, filters out empty strings, and returns a borrowed string if present.

**Call relations**: `stamp_turn_id_if_missing` calls it before deciding whether a new turn ID needs to be added.

*Call graph*: calls 1 internal fn (metadata); called by 1 (stamp_turn_id_if_missing).


##### `ResponseItem::stamp_turn_id_if_missing`  (lines 1134–1144)

```
fn stamp_turn_id_if_missing(&mut self, turn_id: &str)
```

**Purpose**: Adds a turn ID to an item only when the item can carry metadata and does not already have a non-empty turn ID. This avoids overwriting existing attribution.

**Data flow**: It receives a mutable item and a turn ID string, ignores empty IDs or already-stamped items, creates metadata if needed, and stores the turn ID.

**Call relations**: It uses `turn_id` and `metadata_mut`; tests exercise it on messages and compaction triggers.

*Call graph*: calls 2 internal fn (metadata_mut, turn_id).


##### `ResponseItem::clear_metadata`  (lines 1147–1151)

```
fn clear_metadata(&mut self)
```

**Purpose**: Removes response metadata before sending an item to a provider that does not accept it. This keeps provider requests clean.

**Data flow**: It receives a mutable item, finds its metadata slot if the variant has one, and sets that slot to none.

**Call relations**: Provider-facing cleanup code calls it as a final sanitation step before serialization.

*Call graph*: calls 1 internal fn (metadata_mut).


##### `ResponseItem::metadata`  (lines 1153–1172)

```
fn metadata(&self) -> Option<&ResponseItemMetadata>
```

**Purpose**: Provides read-only access to metadata for every response-item variant that supports it. It hides the repetitive matching over many enum cases.

**Data flow**: It receives a response item, matches variants with metadata fields, and returns a reference to metadata if present.

**Call relations**: `turn_id` calls it so turn-ID lookup works uniformly across message, tool, search, and compaction items.

*Call graph*: called by 1 (turn_id).


##### `ResponseItem::metadata_mut`  (lines 1174–1193)

```
fn metadata_mut(&mut self) -> Option<&mut Option<ResponseItemMetadata>>
```

**Purpose**: Provides mutable access to the metadata slot for response-item variants that support it. This lets code stamp or clear metadata without duplicating variant matches.

**Data flow**: It receives a mutable response item, returns a mutable reference to the optional metadata field when available, or none for unsupported variants.

**Call relations**: `stamp_turn_id_if_missing` and `clear_metadata` call it when they need to change metadata.

*Call graph*: called by 2 (clear_metadata, stamp_turn_id_if_missing).


##### `BaseInstructions::default`  (lines 1206–1210)

```
fn default() -> Self
```

**Purpose**: Creates the default base instructions sent to the model. These are the system-level instructions that shape model behavior in a thread.

**Data flow**: It takes no input, copies the bundled default markdown prompt into a string, and returns a `BaseInstructions` object.

**Call relations**: Thread creation, persistence tests, and default configuration paths call it whenever no custom base instructions are supplied.

*Call graph*: called by 12 (get_conversation_summary_by_thread_id_reads_pathless_store_thread, thread_delete_with_non_local_thread_store_does_not_create_local_persistence, seed_pathless_store_thread, thread_unarchive_preserves_pathless_store_metadata, default, attach_thread_persistence, shutdown_complete_does_not_append_to_thread_store_after_shutdown, find_locates_rollout_file_written_by_recorder, persist_reports_filesystem_error_and_retries_buffered_items, recorder_materializes_on_flush_with_pending_items (+2 more)).


##### `format_allow_prefixes`  (lines 1217–1254)

```
fn format_allow_prefixes(prefixes: Vec<Vec<String>>) -> Option<String>
```

**Purpose**: Turns allowed command prefixes into a short readable bullet list. It prevents giant policy lists from flooding messages by sorting and truncating them.

**Data flow**: It receives command-prefix token lists, sorts them by simplicity, renders up to a fixed count, trims the byte size on a character boundary, and adds a truncation marker if needed.

**Call relations**: Execution-policy amendment and approval-text code call it to show users which command prefixes are allowed.

*Call graph*: called by 5 (record_execpolicy_amendment_message, approved_command_prefixes_text, format_allow_prefixes_limits_output, render_command_prefix_list_limits_output_to_max_prefixes, render_command_prefix_list_sorts_by_len_then_total_len_then_alphabetical); 1 external calls (format!).


##### `prefix_combined_str_len`  (lines 1256–1258)

```
fn prefix_combined_str_len(prefix: &[String]) -> usize
```

**Purpose**: Calculates the total text length of all tokens in a command prefix. This helps sort shorter, simpler prefixes before longer ones.

**Data flow**: It receives a prefix token slice, sums each token’s string length, and returns the total.

**Call relations**: `format_allow_prefixes` uses it as one of the sorting tie-breakers before rendering policy text.


##### `render_command_prefix`  (lines 1260–1267)

```
fn render_command_prefix(prefix: &[String]) -> String
```

**Purpose**: Formats one command prefix as a JSON-like list of quoted tokens. Quoting makes spaces and special characters clear to humans.

**Data flow**: It receives command tokens, serializes each token as a JSON string when possible, joins them with commas, and wraps them in brackets.

**Call relations**: `format_allow_prefixes` calls it for each prefix that will appear in the final bullet list.

*Call graph*: 1 external calls (format!).


##### `should_serialize_reasoning_content`  (lines 1269–1276)

```
fn should_serialize_reasoning_content(content: &Option<Vec<ReasoningItemContent>>) -> bool
```

**Purpose**: Decides whether optional reasoning content should be skipped during serialization. The rule avoids serializing some reasoning-text content while preserving other cases.

**Data flow**: It receives optional reasoning content, checks whether any item is explicit reasoning text, and returns the skip decision used by Serde.

**Call relations**: Serde uses it through the `ResponseItem::Reasoning` field annotation when writing response items.


##### `local_image_error_placeholder`  (lines 1278–1289)

```
fn local_image_error_placeholder(
    path: &std::path::Path,
    error: impl std::fmt::Display,
) -> ContentItem
```

**Purpose**: Creates a text message explaining that Codex could not read or process a local image. This gives the model and user a visible explanation instead of silently dropping the image.

**Data flow**: It receives an image path and an error, formats them into a human-readable string, and returns that string as an input-text content item.

**Call relations**: Local image preparation calls it for read, encode, decode, size, and other processing failures.

*Call graph*: 1 external calls (format!).


##### `image_open_tag_text`  (lines 1299–1301)

```
fn image_open_tag_text() -> String
```

**Purpose**: Returns the generic opening image tag text. This tag is used in plain text around image references.

**Data flow**: It takes no input and returns the constant `<image>` as an owned string.

**Call relations**: UI and parsing tests use it when checking how unnamed image labels are represented.

*Call graph*: called by 1 (skips_unnamed_image_label_text).


##### `image_close_tag_text`  (lines 1303–1305)

```
fn image_close_tag_text() -> String
```

**Purpose**: Returns the generic closing image tag text. This gives callers one source for the closing image marker.

**Data flow**: It takes no input and returns the constant `</image>` as an owned string.

**Call relations**: Image parsing and tests use it alongside local image tagging helpers.


##### `local_image_label_text`  (lines 1307–1309)

```
fn local_image_label_text(label_number: usize) -> String
```

**Purpose**: Builds the visible label for a numbered local image, such as `[Image #2]`. Labels let text refer to attached local images clearly.

**Data flow**: It receives a label number, formats it into the standard label string, and returns it.

**Call relations**: Local image tag builders, attachment relabeling, and edit-handling code call it to keep image numbering consistent.

*Call graph*: called by 12 (local_image_open_tag_text_with_path, attach_image, relabel_local_images, apply_external_edit_drops_missing_attachments, apply_external_edit_limits_duplicates_to_occurrences, apply_external_edit_rebuilds_text_and_attachments, apply_external_edit_renumbers_image_placeholders, clear_for_ctrl_c_preserves_image_draft_state, deleting_reordered_image_one_renumbers_text_in_place, set_text_content_reattaches_images_without_placeholder_metadata (+2 more)); 1 external calls (format!).


##### `local_image_open_tag_text_with_path`  (lines 1311–1315)

```
fn local_image_open_tag_text_with_path(label_number: usize, path: &std::path::Path) -> String
```

**Purpose**: Builds an opening tag for a local image that includes both its numbered label and file path. This preserves where the image came from.

**Data flow**: It receives a label number and path, creates the label, formats the path for display, and returns the full opening tag string.

**Call relations**: `local_image_content_items` calls it when wrapping a local image with text markers.

*Call graph*: calls 1 internal fn (local_image_label_text); called by 1 (local_image_content_items); 2 external calls (display, format!).


##### `is_local_image_open_tag_text`  (lines 1317–1320)

```
fn is_local_image_open_tag_text(text: &str) -> bool
```

**Purpose**: Checks whether a text string looks like a local-image opening tag. This helps parse previously constructed user messages.

**Data flow**: It receives text, checks for the local-image prefix and suffix, and returns a boolean.

**Call relations**: User-message parsing calls it to recognize image attachment markers embedded in text.

*Call graph*: called by 1 (parse_user_message).


##### `is_local_image_close_tag_text`  (lines 1322–1324)

```
fn is_local_image_close_tag_text(text: &str) -> bool
```

**Purpose**: Checks whether a text string is the local-image closing tag. Currently local image closing uses the same closing marker as generic images.

**Data flow**: It receives text and delegates to the generic image-close check.

**Call relations**: User-message parsing calls it while matching local image tag pairs.

*Call graph*: calls 1 internal fn (is_image_close_tag_text); called by 1 (parse_user_message).


##### `is_image_open_tag_text`  (lines 1326–1328)

```
fn is_image_open_tag_text(text: &str) -> bool
```

**Purpose**: Checks whether text is exactly the generic image opening tag. This is a small parser helper.

**Data flow**: It receives text, compares it to `<image>`, and returns true or false.

**Call relations**: User-message parsing calls it when recognizing image sections.

*Call graph*: called by 1 (parse_user_message).


##### `is_image_close_tag_text`  (lines 1330–1332)

```
fn is_image_close_tag_text(text: &str) -> bool
```

**Purpose**: Checks whether text is exactly the generic image closing tag. This is used for both generic and local image closing markers.

**Data flow**: It receives text, compares it to `</image>`, and returns a boolean.

**Call relations**: User-message parsing and `is_local_image_close_tag_text` call it to recognize image boundaries.

*Call graph*: called by 2 (parse_user_message, is_local_image_close_tag_text).


##### `invalid_image_error_placeholder`  (lines 1334–1345)

```
fn invalid_image_error_placeholder(
    path: &std::path::Path,
    error: impl std::fmt::Display,
) -> ContentItem
```

**Purpose**: Creates a text message saying a local file was found but is not a valid image. This is more specific than a generic read failure.

**Data flow**: It receives a path and error, formats them into an explanation, and returns an input-text content item.

**Call relations**: Local image preparation calls it when image decoding says the file data is invalid.

*Call graph*: 1 external calls (format!).


##### `unsupported_image_error_placeholder`  (lines 1347–1355)

```
fn unsupported_image_error_placeholder(path: &std::path::Path, mime: &str) -> ContentItem
```

**Purpose**: Creates a text message saying the local image format is unsupported. This tells the user which MIME type caused the problem.

**Data flow**: It receives a path and MIME type, formats a clear unsupported-image message, and returns it as input text.

**Call relations**: Local image preparation calls it when the image loader recognizes a format Codex cannot attach.

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

**Purpose**: Turns local image bytes into prompt content items, with optional labeling. It also converts failures into readable placeholder text.

**Data flow**: It receives a path, file bytes, optional label number, and requested detail level; it chooses resize or original mode, loads the image for prompting, and returns image content or an error placeholder.

**Call relations**: User-input conversion calls this when local images should be processed before being sent to the model.

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

**Purpose**: Builds the actual content-item sequence for a prepared image URL. With a label, it wraps the image between opening and closing text tags.

**Data flow**: It receives a path, image data URL, optional label number, and detail setting; it returns text-open, image, and text-close items when labeled, or just the image item when unlabeled.

**Call relations**: Local image processing and deferred image preparation call it after bytes have been turned into a data URL.

*Call graph*: calls 1 internal fn (local_image_open_tag_text_with_path); called by 1 (local_image_content_items_with_label_number); 1 external calls (with_capacity).


##### `ResponseItem::from`  (lines 1421–1470)

```
fn from(item: ResponseInputItem) -> Self
```

**Purpose**: Converts input items into full response items. This lets user inputs and tool outputs enter the same conversation-history format used elsewhere.

**Data flow**: It receives a `ResponseInputItem`, maps each variant to the matching `ResponseItem`, fills fields such as metadata and IDs with defaults, and converts MCP tool output into function-call output payloads.

**Call relations**: Response-building code and tests call it when moving from input-side protocol objects to stored or provider-facing response items.

*Call graph*: called by 2 (response_item_from_user_input, response_input_message_conversion_preserves_phase).


##### `ResponseInputItem::from`  (lines 1540–1542)

```
fn from(items: Vec<UserInput>) -> Self
```

**Purpose**: Creates a user message input item from a list of user input parts. It uses normal image processing by default.

**Data flow**: It receives user input values, calls `from_user_input` with local-image processing enabled, and returns a message input item.

**Call relations**: Compaction, image tests, and user-input conversion paths call it as the standard conversion entry.

*Call graph*: called by 8 (run_compact_task_inner_impl, image_user_input_preserves_requested_detail, local_image_non_image_adds_placeholder, local_image_read_error_adds_placeholder, local_image_unsupported_image_format_adds_placeholder, local_image_user_input_preserves_requested_detail, mixed_remote_and_local_images_share_label_sequence, serializes_image_user_input_without_tags); 1 external calls (from_user_input).


##### `ResponseInputItem::from_user_input`  (lines 1546–1595)

```
fn from_user_input(
        items: Vec<UserInput>,
        local_image_preparation: LocalImagePreparation,
    ) -> Self
```

**Purpose**: Converts typed user input into the content items that can be sent to a model. It supports text, remote images, local images, and skips inputs injected later by other code.

**Data flow**: It receives user inputs plus a choice to process or defer local image preparation, reads local files when needed, labels images in sequence, and returns a user-role message with content items.

**Call relations**: The `From<Vec<UserInput>>` implementation and response-building paths call it when preparing a turn’s user message.

*Call graph*: called by 1 (response_item_from_user_input).


##### `function_call_output_content_items_to_text`  (lines 1663–1683)

```
fn function_call_output_content_items_to_text(
    content_items: &[FunctionCallOutputContentItem],
) -> Option<String>
```

**Purpose**: Extracts a plain-text preview from structured tool output. It intentionally drops images and encrypted content because those cannot be faithfully represented as simple text.

**Data flow**: It receives structured output items, collects non-blank input-text values, joins them with newlines, and returns none if there is no text.

**Call relations**: Logging, legacy output paths, call handlers, and `FunctionCallOutputBody::to_text` call it when they need a human-readable string.

*Call graph*: called by 9 (into_text, log_preview, handle_call, handle_call, handle_call, expect_text_output, to_text, function_call_output_content_items_to_text_ignores_blank_text_and_images, function_call_output_content_items_to_text_joins_text_segments); 1 external calls (iter).


##### `FunctionCallOutputContentItem::from`  (lines 1688–1700)

```
fn from(item: crate::dynamic_tools::DynamicToolCallOutputContentItem) -> Self
```

**Purpose**: Converts dynamic-tool output items into the protocol’s function-call output item format. This lets dynamically defined tools reuse the same response shape.

**Data flow**: It receives a dynamic text or image item, maps text directly, maps images to input-image items, and applies the default image detail.

**Call relations**: Dynamic tool code uses this conversion before packaging tool results for the model.


##### `FunctionCallOutputBody::to_text`  (lines 1727–1732)

```
fn to_text(&self) -> Option<String>
```

**Purpose**: Best-effort conversion of a tool output body into plain text. It is useful for logs and old interfaces that cannot display structured output.

**Data flow**: It receives either text or structured items; text is cloned directly, while structured items are passed through the lossy text extractor.

**Call relations**: Callers needing previews call it, and it delegates structured extraction to `function_call_output_content_items_to_text`.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text).


##### `FunctionCallOutputBody::default`  (lines 1736–1738)

```
fn default() -> Self
```

**Purpose**: Creates an empty text tool-output body. This gives the payload a harmless default value.

**Data flow**: It takes no input and returns the text variant containing an empty string.

**Call relations**: Default construction for `FunctionCallOutputPayload` uses it when no body has been supplied.

*Call graph*: 2 external calls (Text, new).


##### `FunctionCallOutputPayload::from_text`  (lines 1742–1747)

```
fn from_text(content: String) -> Self
```

**Purpose**: Builds a function-call output payload from plain text. This is the common path for simple tool results.

**Data flow**: It receives a string, stores it as the text body, leaves success unset, and returns the payload.

**Call relations**: Dynamic tool calls, response item conversion, guardian history seeding, and tests call it for string-only outputs.

*Call graph*: called by 9 (dynamic_tool_call_round_trip_sends_text_content_items_to_model, custom_tool_call_output, record_items_truncates_custom_tool_call_output_content, ensure_call_outputs_present, seed_guardian_parent_history, external_context_pollution_items_exclude_local_tool_calls, to_response_item, azure_responses_request_includes_store_and_reasoning_ids, serializes_success_as_plain_string); 1 external calls (Text).


##### `FunctionCallOutputPayload::from_content_items`  (lines 1749–1754)

```
fn from_content_items(content_items: Vec<FunctionCallOutputContentItem>) -> Self
```

**Purpose**: Builds a function-call output payload from structured content items such as text, images, or encrypted content.

**Data flow**: It receives a list of content items, stores them as the body, leaves success unset, and returns the payload.

**Call relations**: Image-output handling, encrypted output handling, and size-estimation tests call it when output is not just text.

*Call graph*: called by 12 (encrypted_function_output_uses_plaintext_byte_estimate, image_data_url_payload_does_not_dominate_custom_tool_call_output_estimate, image_data_url_payload_does_not_dominate_function_call_output_estimate, non_base64_image_urls_are_unchanged, non_image_base64_data_url_is_unchanged, original_detail_images_are_capped_at_max_patch_count, original_detail_images_scale_with_dimensions, original_detail_webp_images_scale_with_dimensions, image_output, to_response_item (+2 more)); 1 external calls (ContentItems).


##### `FunctionCallOutputPayload::text_content`  (lines 1756–1761)

```
fn text_content(&self) -> Option<&str>
```

**Purpose**: Returns the text content if this payload is plain text. It avoids pretending structured output is a string.

**Data flow**: It reads the body and returns a string reference for the text variant, or none for content items.

**Call relations**: Callers use it when they specifically need borrowed plain text from a tool result.


##### `FunctionCallOutputPayload::text_content_mut`  (lines 1763–1768)

```
fn text_content_mut(&mut self) -> Option<&mut String>
```

**Purpose**: Returns mutable access to plain text output when the payload is text. This allows in-place edits only for text bodies.

**Data flow**: It reads the mutable body and returns a mutable string reference for the text variant, or none for structured content.

**Call relations**: Post-processing code can use it to alter simple text outputs without touching structured item payloads.


##### `FunctionCallOutputPayload::content_items`  (lines 1770–1775)

```
fn content_items(&self) -> Option<&[FunctionCallOutputContentItem]>
```

**Purpose**: Returns structured output items if this payload contains them. This is how image outputs and other item arrays are inspected.

**Data flow**: It reads the body and returns a slice of content items for the structured variant, or none for plain text.

**Call relations**: Image URL extraction code calls it when looking for images inside tool outputs.

*Call graph*: called by 1 (output_image_urls).


##### `FunctionCallOutputPayload::content_items_mut`  (lines 1777–1782)

```
fn content_items_mut(&mut self) -> Option<&mut Vec<FunctionCallOutputContentItem>>
```

**Purpose**: Returns mutable access to structured content items when the payload uses that form. It avoids modifying plain text as if it were a list.

**Data flow**: It reads the mutable body and returns the item vector for structured output, or none for text output.

**Call relations**: Post-processing code can use it to rewrite or filter structured tool output items.


##### `FunctionCallOutputPayload::serialize`  (lines 1789–1797)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Writes a tool-output payload to JSON using the provider’s expected shape: either a string or an array. Internal success metadata is not written.

**Data flow**: It reads the payload body, serializes text as a JSON string or content items as a JSON array, and returns the serializer result.

**Call relations**: Serde calls it when response input or response items containing tool output are sent or stored.

*Call graph*: 1 external calls (serialize_str).


##### `FunctionCallOutputPayload::deserialize`  (lines 1801–1810)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads a tool-output payload from JSON that may be either a string or an array of content items. It restores only the wire body, not internal success metadata.

**Data flow**: It deserializes the incoming value as a `FunctionCallOutputBody`, wraps it in a payload, sets success to none, and returns it.

**Call relations**: Serde calls it when tool output comes back from stored history or protocol JSON.

*Call graph*: 1 external calls (deserialize).


##### `CallToolResult::from_result`  (lines 1814–1819)

```
fn from_result(result: Result<Self, String>) -> Self
```

**Purpose**: Turns a Rust `Result` from an MCP tool call into a `CallToolResult`. Errors become structured error results instead of panics.

**Data flow**: It receives either a successful tool result or an error string; successes pass through, and errors are converted with `from_error_text`.

**Call relations**: MCP tool-call handling can use it to normalize fallible tool execution into protocol output.

*Call graph*: 1 external calls (from_error_text).


##### `CallToolResult::from_error_text`  (lines 1821–1831)

```
fn from_error_text(text: String) -> Self
```

**Purpose**: Creates an MCP tool result that clearly represents an error message. This gives downstream code a consistent error shape.

**Data flow**: It receives error text, wraps it as a JSON text content item, marks `is_error` true, and returns the result.

**Call relations**: `from_result` calls it when a tool execution returns an error string.

*Call graph*: 1 external calls (vec!).


##### `CallToolResult::success`  (lines 1833–1835)

```
fn success(&self) -> bool
```

**Purpose**: Reports whether an MCP tool result should be treated as successful. Only an explicit `is_error: true` counts as failure.

**Data flow**: It reads the optional error flag and returns false only when that flag is true.

**Call relations**: `as_function_call_output_payload` calls it to attach internal success metadata to converted tool output.

*Call graph*: called by 1 (as_function_call_output_payload).


##### `CallToolResult::as_function_call_output_payload`  (lines 1837–1878)

```
fn as_function_call_output_payload(&self) -> FunctionCallOutputPayload
```

**Purpose**: Converts an MCP tool result into the function-call output payload shape sent back to the model. It preserves images as structured items when possible.

**Data flow**: It first prefers non-null structured content as serialized text, otherwise serializes raw content, tries to convert MCP text/image content into structured output items, records success, and returns a payload.

**Call relations**: `into_function_call_output_payload` delegates to it, and response-item conversion uses that path for MCP tool outputs.

*Call graph*: calls 2 internal fn (success, convert_mcp_content_to_items); called by 1 (into_function_call_output_payload); 3 external calls (ContentItems, Text, to_string).


##### `CallToolResult::into_function_call_output_payload`  (lines 1880–1882)

```
fn into_function_call_output_payload(self) -> FunctionCallOutputPayload
```

**Purpose**: Consumes an MCP tool result and converts it into a function-call output payload. It is the ownership-taking wrapper for the borrowed conversion.

**Data flow**: It receives the result by value, calls `as_function_call_output_payload`, and returns the converted payload.

**Call relations**: Conversion from `ResponseInputItem::McpToolCallOutput` calls it before storing the result as a normal function-call output.

*Call graph*: calls 1 internal fn (as_function_call_output_payload).


##### `convert_mcp_content_to_items`  (lines 1885–1950)

```
fn convert_mcp_content_to_items(
    contents: &[serde_json::Value],
) -> Option<Vec<FunctionCallOutputContentItem>>
```

**Purpose**: Tries to convert MCP content JSON into structured function-call output items. It only switches to structured output when at least one image is present.

**Data flow**: It receives JSON content values, parses each as MCP text or image, builds text or image items, creates data URLs for image bytes when needed, applies image detail metadata, and returns none if no image was seen.

**Call relations**: `CallToolResult::as_function_call_output_payload` calls it so multimodal MCP results can reach the model as images instead of opaque JSON text.

*Call graph*: called by 3 (as_function_call_output_payload, convert_mcp_content_to_items_builds_data_urls_when_missing_prefix, convert_mcp_content_to_items_preserves_data_urls); 4 external calls (len, with_capacity, format!, to_string).


##### `FunctionCallOutputPayload::fmt`  (lines 1957–1965)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a function-call output payload for logging, display, or simple string checks. Text is shown directly; structured items are shown as JSON.

**Data flow**: It receives a formatter, writes the text body as-is or serializes content items to JSON and writes that string.

**Call relations**: Rust’s display formatting calls it when code treats a payload like a printable string.

*Call graph*: 2 external calls (write_str, to_string).


##### `tests::plaintext_agent_message_content_rejects_mixed_encrypted_content`  (lines 1988–1999)

```
fn plaintext_agent_message_content_rejects_mixed_encrypted_content()
```

**Purpose**: Checks that plaintext extraction refuses messages containing encrypted parts. This protects against accidentally showing incomplete or private content.

**Data flow**: It builds mixed plaintext and encrypted content, calls the extractor, and asserts that the result is none.

**Call relations**: The test directly exercises `plaintext_agent_message_content`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::response_input_message_conversion_preserves_phase`  (lines 2002–2023)

```
fn response_input_message_conversion_preserves_phase()
```

**Purpose**: Checks that converting an input message into a response item keeps the message phase. This preserves commentary versus final-answer information.

**Data flow**: It builds an assistant input message with a commentary phase, converts it, and compares the full response item.

**Call relations**: The test calls `ResponseItem::from` for the message conversion path.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert_eq!, vec!).


##### `tests::response_item_metadata_round_trips_and_stamps_turn_ids`  (lines 2026–2058)

```
fn response_item_metadata_round_trips_and_stamps_turn_ids() -> Result<()>
```

**Purpose**: Checks that response-item metadata survives JSON round trips and that missing turn IDs are stamped correctly. This guards conversation-turn attribution.

**Data flow**: It serializes and deserializes metadata-bearing items, tries stamping existing, empty, missing, and unsupported cases, and asserts the expected turn IDs.

**Call relations**: The test exercises `turn_id`, `stamp_turn_id_if_missing`, and metadata serialization behavior.

*Call graph*: 6 external calls (assert_eq!, response_item_metadata, response_item_with_metadata, from_value, json!, to_value).


##### `tests::response_item_with_metadata`  (lines 2060–2070)

```
fn response_item_with_metadata(metadata: Option<ResponseItemMetadata>) -> ResponseItem
```

**Purpose**: Builds a small user message response item for metadata tests. It keeps those tests readable.

**Data flow**: It receives optional metadata, inserts it into a fixed user message with one text content item, and returns the item.

**Call relations**: The metadata round-trip test calls this helper to create test items.

*Call graph*: 1 external calls (vec!).


##### `tests::response_item_metadata`  (lines 2072–2076)

```
fn response_item_metadata(turn_id: &str) -> ResponseItemMetadata
```

**Purpose**: Builds metadata containing a chosen turn ID for tests. This avoids repeating the struct construction.

**Data flow**: It receives a turn ID string, copies it into metadata, and returns the metadata object.

**Call relations**: The response-item metadata test calls this helper for expected and input values.


##### `tests::image_detail_roundtrips_all_wire_values`  (lines 2079–2106)

```
fn image_detail_roundtrips_all_wire_values() -> Result<()>
```

**Purpose**: Checks that image detail settings serialize and deserialize with the expected JSON names. This protects compatibility with provider wire values.

**Data flow**: It parses and writes image detail values, parses an input-image content item, and asserts the expected Rust values.

**Call relations**: The test covers `ImageDetail` and `ContentItem::InputImage` serialization behavior.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `tests::sandbox_permissions_helpers_match_documented_semantics`  (lines 2109–2141)

```
fn sandbox_permissions_helpers_match_documented_semantics()
```

**Purpose**: Checks that sandbox-permission helper methods return the documented booleans. This protects command-permission decisions.

**Data flow**: It runs all sandbox permission variants through the helper methods and compares them with expected truth values.

**Call relations**: The test directly exercises the three `SandboxPermissions` helper methods.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::convert_mcp_content_to_items_preserves_data_urls`  (lines 2144–2159)

```
fn convert_mcp_content_to_items_preserves_data_urls()
```

**Purpose**: Checks that MCP image content already using a data URL is not wrapped again. This avoids corrupting image output.

**Data flow**: It builds image JSON with a data URL, converts it, and asserts the image URL is unchanged.

**Call relations**: The test directly calls `convert_mcp_content_to_items`.

*Call graph*: calls 1 internal fn (convert_mcp_content_to_items); 2 external calls (assert_eq!, vec!).


##### `tests::response_item_parses_image_generation_call`  (lines 2162–2182)

```
fn response_item_parses_image_generation_call()
```

**Purpose**: Checks that image-generation response items parse when a revised prompt is present. This keeps provider image-generation events usable.

**Data flow**: It deserializes example JSON and compares it with the expected `ImageGenerationCall` item.

**Call relations**: The test exercises `ResponseItem` deserialization.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::response_item_parses_image_generation_call_without_revised_prompt`  (lines 2185–2204)

```
fn response_item_parses_image_generation_call_without_revised_prompt()
```

**Purpose**: Checks that image-generation response items also parse when the revised prompt is omitted. This supports partial provider payloads.

**Data flow**: It deserializes JSON without `revised_prompt` and asserts the field becomes none.

**Call relations**: The test exercises optional-field behavior in `ResponseItem` deserialization.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::additional_permission_profile_is_empty_when_all_fields_are_none`  (lines 2207–2209)

```
fn additional_permission_profile_is_empty_when_all_fields_are_none()
```

**Purpose**: Checks that a default additional-permission profile counts as empty. This guards overlay cleanup.

**Data flow**: It creates the default profile, calls `is_empty`, and asserts true.

**Call relations**: The test directly exercises `AdditionalPermissionProfile::is_empty`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::additional_permission_profile_is_not_empty_when_field_is_present_but_nested_empty`  (lines 2212–2218)

```
fn additional_permission_profile_is_not_empty_when_field_is_present_but_nested_empty()
```

**Purpose**: Checks that a present permission section counts as meaningful even if its nested value says little. This preserves explicit user intent.

**Data flow**: It creates a profile with a network section but no enabled value, calls `is_empty`, and asserts false.

**Call relations**: The test directly exercises `AdditionalPermissionProfile::is_empty`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::permission_profile_round_trip_preserves_glob_scan_max_depth`  (lines 2221–2240)

```
fn permission_profile_round_trip_preserves_glob_scan_max_depth()
```

**Purpose**: Checks that permission profiles preserve glob scan depth through runtime conversion. This protects deny rules that depend on controlled glob scanning.

**Data flow**: It creates a restricted sandbox policy with a deny glob and depth, converts it to a profile, and compares the extracted policy with the original.

**Call relations**: The test calls `PermissionProfile::from_runtime_permissions` and `file_system_sandbox_policy`.

*Call graph*: calls 2 internal fn (from_runtime_permissions, restricted); 2 external calls (assert_eq!, vec!).


##### `tests::permission_profile_deserializes_legacy_rollout_shape`  (lines 2243–2280)

```
fn permission_profile_deserializes_legacy_rollout_shape() -> Result<()>
```

**Purpose**: Checks that old rollout JSON for permission profiles still loads correctly. This protects stored conversation history.

**Data flow**: It deserializes legacy-shaped JSON with network and file-system fields and compares it with the expected managed profile.

**Call relations**: The test exercises custom `PermissionProfile::deserialize` legacy handling.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `tests::permission_profile_presets_match_legacy_defaults`  (lines 2283–2294)

```
fn permission_profile_presets_match_legacy_defaults()
```

**Purpose**: Checks that built-in read-only and workspace-write profiles match legacy sandbox defaults. This prevents silent permission behavior changes.

**Data flow**: It creates each modern preset and compares it with conversion from the matching legacy policy.

**Call relations**: The test calls `PermissionProfile::read_only`, `workspace_write`, and legacy conversion.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::permission_profile_round_trip_preserves_disabled_sandbox`  (lines 2297–2315)

```
fn permission_profile_round_trip_preserves_disabled_sandbox() -> Result<()>
```

**Purpose**: Checks that full-access legacy sandbox policy becomes and remains a disabled permission profile. This avoids accidentally re-sandboxing full-access sessions.

**Data flow**: It converts danger-full-access to a profile, converts back to legacy and runtime permissions, and asserts all forms match full access.

**Call relations**: The test calls `PermissionProfile::from_legacy_sandbox_policy` and `to_legacy_sandbox_policy`.

*Call graph*: calls 1 internal fn (from_legacy_sandbox_policy); 2 external calls (assert_eq!, tempdir).


##### `tests::disabled_permission_profile_ignores_runtime_network_policy`  (lines 2318–2326)

```
fn disabled_permission_profile_ignores_runtime_network_policy()
```

**Purpose**: Checks that disabled enforcement wins over a restricted network policy. If there is no sandbox, network is treated as enabled.

**Data flow**: It builds a profile from disabled enforcement plus unrestricted files and restricted network, then asserts the profile is disabled.

**Call relations**: The test exercises `PermissionProfile::from_runtime_permissions_with_enforcement`.

*Call graph*: calls 2 internal fn (from_runtime_permissions_with_enforcement, unrestricted); 1 external calls (assert_eq!).


##### `tests::permission_profile_from_runtime_permissions_preserves_external_sandbox`  (lines 2329–2349)

```
fn permission_profile_from_runtime_permissions_preserves_external_sandbox()
```

**Purpose**: Checks that an external filesystem sandbox remains external in the profile model. This respects callers that enforce isolation outside Codex.

**Data flow**: It converts an external sandbox policy into a profile and compares both normal and explicit-enforcement conversion results.

**Call relations**: The test calls `PermissionProfile::from_runtime_permissions` and the explicit enforcement converter.

*Call graph*: calls 2 internal fn (from_runtime_permissions, external_sandbox); 1 external calls (assert_eq!).


##### `tests::permission_profile_from_runtime_permissions_preserves_unrestricted_managed_network`  (lines 2352–2374)

```
fn permission_profile_from_runtime_permissions_preserves_unrestricted_managed_network()
```

**Purpose**: Checks that unrestricted managed filesystem access with restricted network is not misrepresented as an external sandbox. This preserves split file/network meaning.

**Data flow**: It builds a profile from unrestricted filesystem, restricted network, and external enforcement input, then asserts the result is managed and runtime permissions round-trip.

**Call relations**: The test exercises `from_runtime_permissions_with_enforcement` and `to_runtime_permissions`.

*Call graph*: calls 2 internal fn (from_runtime_permissions_with_enforcement, unrestricted); 1 external calls (assert_eq!).


##### `tests::permission_profile_round_trip_preserves_external_sandbox`  (lines 2377–2402)

```
fn permission_profile_round_trip_preserves_external_sandbox() -> Result<()>
```

**Purpose**: Checks that legacy external-sandbox policies round-trip through permission profiles. This preserves compatibility for externally enforced sessions.

**Data flow**: It converts a legacy external sandbox to a profile, converts back to legacy and runtime permissions, and asserts all expected forms.

**Call relations**: The test calls `PermissionProfile::from_legacy_sandbox_policy`, `to_legacy_sandbox_policy`, and `to_runtime_permissions`.

*Call graph*: calls 1 internal fn (from_legacy_sandbox_policy); 2 external calls (assert_eq!, tempdir).


##### `tests::file_system_permissions_with_glob_scan_depth_uses_canonical_json`  (lines 2405–2434)

```
fn file_system_permissions_with_glob_scan_depth_uses_canonical_json() -> Result<()>
```

**Purpose**: Checks that permissions with glob scan depth serialize in the new canonical shape, not the old read/write shape. The old shape cannot express that depth.

**Data flow**: It builds permissions with a path entry and non-zero depth, serializes them to JSON, checks which fields appear, and deserializes back.

**Call relations**: The test exercises `FileSystemPermissions::serialize` and `deserialize`.

*Call graph*: calls 1 internal fn (try_from); 7 external calls (new, from, assert!, assert_eq!, cfg!, to_value, vec!).


##### `tests::file_system_permissions_rejects_zero_glob_scan_depth`  (lines 2437–2443)

```
fn file_system_permissions_rejects_zero_glob_scan_depth()
```

**Purpose**: Checks that zero is rejected for glob scan depth. A non-zero type is used because zero would be meaningless for the limit.

**Data flow**: It tries to deserialize JSON with depth zero and expects an error.

**Call relations**: The test exercises Serde deserialization for `FileSystemPermissions`.

*Call graph*: 1 external calls (json!).


##### `tests::convert_mcp_content_to_items_builds_data_urls_when_missing_prefix`  (lines 2446–2461)

```
fn convert_mcp_content_to_items_builds_data_urls_when_missing_prefix()
```

**Purpose**: Checks that raw base64 MCP image data is turned into a proper data URL. This makes the image usable by model APIs.

**Data flow**: It builds image JSON with base64 data and MIME type, converts it, and asserts the generated data URL.

**Call relations**: The test directly calls `convert_mcp_content_to_items`.

*Call graph*: calls 1 internal fn (convert_mcp_content_to_items); 2 external calls (assert_eq!, vec!).


##### `tests::convert_mcp_content_to_items_returns_none_without_images`  (lines 2464–2471)

```
fn convert_mcp_content_to_items_returns_none_without_images()
```

**Purpose**: Checks that MCP content with only text stays in the plain serialized path. Structured item output is only needed for images.

**Data flow**: It builds text-only MCP content, converts it, and asserts the result is none.

**Call relations**: The test directly calls `convert_mcp_content_to_items`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::function_call_output_content_items_to_text_joins_text_segments`  (lines 2474–2490)

```
fn function_call_output_content_items_to_text_joins_text_segments()
```

**Purpose**: Checks that text segments in structured output are joined while images are ignored. This verifies the intended lossy preview behavior.

**Data flow**: It creates text-image-text items, converts them to text, and asserts the two text lines are joined.

**Call relations**: The test directly calls `function_call_output_content_items_to_text`.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text); 2 external calls (assert_eq!, vec!).


##### `tests::function_call_output_content_items_to_text_ignores_blank_text_and_images`  (lines 2493–2509)

```
fn function_call_output_content_items_to_text_ignores_blank_text_and_images()
```

**Purpose**: Checks that blank text, images, and encrypted content do not produce a fake text preview. This avoids misleading logs.

**Data flow**: It creates only blank or non-text items, converts them, and asserts there is no text result.

**Call relations**: The test directly calls `function_call_output_content_items_to_text`.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text); 2 external calls (assert_eq!, vec!).


##### `tests::function_call_output_body_to_text_returns_plain_text_content`  (lines 2512–2516)

```
fn function_call_output_body_to_text_returns_plain_text_content()
```

**Purpose**: Checks that a text output body converts to that same text. This covers the simple preview path.

**Data flow**: It builds a text body, calls `to_text`, and compares the returned string.

**Call relations**: The test exercises `FunctionCallOutputBody::to_text`.

*Call graph*: 2 external calls (assert_eq!, Text).


##### `tests::function_call_output_body_to_text_uses_content_item_fallback`  (lines 2519–2532)

```
fn function_call_output_body_to_text_uses_content_item_fallback()
```

**Purpose**: Checks that structured output uses the content-item text extractor. This protects preview behavior for mixed text and image results.

**Data flow**: It builds structured content with text and image, calls `to_text`, and asserts only the text remains.

**Call relations**: The test exercises `FunctionCallOutputBody::to_text` and its helper.

*Call graph*: 3 external calls (assert_eq!, ContentItems, vec!).


##### `tests::function_call_deserializes_optional_namespace`  (lines 2535–2556)

```
fn function_call_deserializes_optional_namespace()
```

**Purpose**: Checks that function-call items can include an optional namespace. This supports namespaced tools such as MCP tools.

**Data flow**: It deserializes function-call JSON with a namespace and compares it with the expected response item.

**Call relations**: The test exercises `ResponseItem` deserialization for function calls.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `tests::render_command_prefix_list_sorts_by_len_then_total_len_then_alphabetical`  (lines 2559–2580)

```
fn render_command_prefix_list_sorts_by_len_then_total_len_then_alphabetical()
```

**Purpose**: Checks that allowed command prefixes are displayed in a stable, simple-first order. This makes approval messages easier to read.

**Data flow**: It builds unsorted prefixes, formats them, and compares the exact bullet-list order.

**Call relations**: The test calls `format_allow_prefixes`, which uses the prefix length helpers.

*Call graph*: calls 1 internal fn (format_allow_prefixes); 2 external calls (assert_eq!, vec!).


##### `tests::render_command_prefix_list_limits_output_to_max_prefixes`  (lines 2583–2592)

```
fn render_command_prefix_list_limits_output_to_max_prefixes()
```

**Purpose**: Checks that only the maximum number of command prefixes is rendered and that truncation is marked. This prevents huge messages.

**Data flow**: It creates more prefixes than the limit, formats them, and checks the truncation marker and line count.

**Call relations**: The test calls `format_allow_prefixes`.

*Call graph*: calls 1 internal fn (format_allow_prefixes); 2 external calls (assert_eq!, eprintln!).


##### `tests::format_allow_prefixes_limits_output`  (lines 2595–2612)

```
fn format_allow_prefixes_limits_output()
```

**Purpose**: Checks that rendered command-prefix text stays under the byte budget plus truncation marker. This protects prompts and UI from oversized policy text.

**Data flow**: It builds many long allowed prefixes through an execution policy, formats them, and asserts the output length bound.

**Call relations**: The test calls `format_allow_prefixes` with prefixes obtained from `codex_execpolicy`.

*Call graph*: calls 1 internal fn (format_allow_prefixes); 3 external calls (assert!, empty, format!).


##### `tests::serializes_success_as_plain_string`  (lines 2615–2627)

```
fn serializes_success_as_plain_string() -> Result<()>
```

**Purpose**: Checks that successful plain text tool output serializes as a JSON string. This matches the provider wire format.

**Data flow**: It builds a function-call output item from text, serializes it, parses the JSON, and asserts `output` is the plain string.

**Call relations**: The test calls `FunctionCallOutputPayload::from_text` and exercises custom serialization.

*Call graph*: calls 1 internal fn (from_text); 3 external calls (assert_eq!, from_str, to_string).


##### `tests::serializes_failure_as_string`  (lines 2630–2644)

```
fn serializes_failure_as_string() -> Result<()>
```

**Purpose**: Checks that failed plain text tool output still serializes as a JSON string. The internal success flag should not change the wire body shape.

**Data flow**: It builds a payload with text and `success: false`, serializes it, and asserts the JSON output field is the text.

**Call relations**: The test exercises `FunctionCallOutputPayload::serialize`.

*Call graph*: 4 external calls (assert_eq!, Text, from_str, to_string).


##### `tests::serializes_image_outputs_as_array`  (lines 2647–2689)

```
fn serializes_image_outputs_as_array() -> Result<()>
```

**Purpose**: Checks that MCP results containing images serialize as an array of structured content items. This lets the model receive images, not only JSON text.

**Data flow**: It builds an MCP result with caption and image, converts it to a payload, checks content items and success, serializes it, and asserts output is an array.

**Call relations**: The test exercises `CallToolResult::into_function_call_output_payload`, `content_items`, and payload serialization.

*Call graph*: 6 external calls (assert!, assert_eq!, panic!, from_str, to_string, vec!).


##### `tests::serializes_custom_tool_image_outputs_as_array`  (lines 2692–2711)

```
fn serializes_custom_tool_image_outputs_as_array() -> Result<()>
```

**Purpose**: Checks that custom tool outputs with images also serialize as structured arrays. This keeps custom tools consistent with function-call outputs.

**Data flow**: It builds a custom tool output payload from image items, serializes it, and asserts the output field is an array.

**Call relations**: The test calls `FunctionCallOutputPayload::from_content_items`.

*Call graph*: calls 1 internal fn (from_content_items); 4 external calls (assert!, from_str, to_string, vec!).


##### `tests::serializes_encrypted_function_output_content_as_array`  (lines 2714–2740)

```
fn serializes_encrypted_function_output_content_as_array() -> Result<()>
```

**Purpose**: Checks that encrypted function output content serializes as a structured array item. This preserves opaque encrypted data without flattening it to text.

**Data flow**: It builds encrypted content items, serializes the response input item to JSON, and compares the exact JSON structure.

**Call relations**: The test calls `FunctionCallOutputPayload::from_content_items` and custom serialization.

*Call graph*: calls 1 internal fn (from_content_items); 3 external calls (assert_eq!, to_value, vec!).


##### `tests::preserves_existing_image_data_urls`  (lines 2743–2769)

```
fn preserves_existing_image_data_urls() -> Result<()>
```

**Purpose**: Checks that MCP image data already in data-URL form is preserved through payload conversion. This prevents double-prefixing.

**Data flow**: It builds an MCP image result with a data URL, converts it, extracts content items, and compares the preserved URL.

**Call relations**: The test exercises `CallToolResult::into_function_call_output_payload` and `convert_mcp_content_to_items` indirectly.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


##### `tests::preserves_original_detail_metadata_on_mcp_images`  (lines 2772–2801)

```
fn preserves_original_detail_metadata_on_mcp_images() -> Result<()>
```

**Purpose**: Checks that MCP image metadata requesting original detail is preserved. This keeps image quality choices from being lost.

**Data flow**: It builds an MCP image with `codex/imageDetail` set to original, converts it, and asserts the resulting image detail.

**Call relations**: The test exercises image metadata parsing inside `convert_mcp_content_to_items`.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


##### `tests::preserves_standard_detail_metadata_on_mcp_images`  (lines 2804–2833)

```
fn preserves_standard_detail_metadata_on_mcp_images() -> Result<()>
```

**Purpose**: Checks that standard image detail metadata such as high is preserved for MCP images. This guards expected quality settings.

**Data flow**: It builds an MCP image with detail metadata, converts it, and asserts the resulting structured image item.

**Call relations**: The test exercises image metadata parsing inside `convert_mcp_content_to_items`.

*Call graph*: 3 external calls (assert_eq!, panic!, vec!).


##### `tests::deserializes_array_payload_into_items`  (lines 2836–2864)

```
fn deserializes_array_payload_into_items() -> Result<()>
```

**Purpose**: Checks that a JSON array output payload deserializes into structured content items and serializes back the same way. This protects multimodal tool output storage.

**Data flow**: It parses an array with text and image items, checks the payload body and success flag, then compares serialization with the expected items.

**Call relations**: The test exercises `FunctionCallOutputPayload::deserialize` and `serialize`.

*Call graph*: 3 external calls (assert_eq!, from_str, vec!).


##### `tests::deserializes_encrypted_array_payload_into_items`  (lines 2867–2888)

```
fn deserializes_encrypted_array_payload_into_items() -> Result<()>
```

**Purpose**: Checks that encrypted output arrays deserialize into structured content items. This keeps encrypted payloads round-trippable.

**Data flow**: It parses an encrypted-content array, checks the payload body and success flag, and verifies serialization returns the array.

**Call relations**: The test exercises `FunctionCallOutputPayload::deserialize` and `serialize`.

*Call graph*: 3 external calls (assert_eq!, from_str, vec!).


##### `tests::deserializes_compaction_alias`  (lines 2891–2904)

```
fn deserializes_compaction_alias() -> Result<()>
```

**Purpose**: Checks that the old `compaction_summary` type name still parses as the current compaction item. This keeps older stored data readable.

**Data flow**: It deserializes alias JSON and compares the resulting response item.

**Call relations**: The test exercises `ResponseItem` deserialization alias behavior.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::deserializes_context_compaction`  (lines 2907–2920)

```
fn deserializes_context_compaction() -> Result<()>
```

**Purpose**: Checks that context compaction items deserialize with optional encrypted content. This supports compacted conversation context records.

**Data flow**: It parses context-compaction JSON and compares the resulting response item.

**Call relations**: The test exercises `ResponseItem` deserialization.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::serializes_compaction_trigger_without_payload`  (lines 2923–2933)

```
fn serializes_compaction_trigger_without_payload() -> Result<()>
```

**Purpose**: Checks that a compaction trigger with no metadata serializes as just its type. This keeps the wire payload minimal.

**Data flow**: It creates a compaction trigger, serializes it to JSON, and compares the exact object.

**Call relations**: The test exercises `ResponseItem` serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::serializes_stamped_compaction_trigger_metadata`  (lines 2936–2950)

```
fn serializes_stamped_compaction_trigger_metadata() -> Result<()>
```

**Purpose**: Checks that turn metadata can be stamped onto compaction triggers and serialized. This keeps compaction events attributable to a turn.

**Data flow**: It stamps a turn ID on a trigger, serializes it, and compares the expected metadata JSON.

**Call relations**: The test exercises `ResponseItem::stamp_turn_id_if_missing` and serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::deserializes_compaction_trigger_without_payload`  (lines 2953–2960)

```
fn deserializes_compaction_trigger_without_payload() -> Result<()>
```

**Purpose**: Checks that a bare compaction trigger JSON object can be read. This supports compact trigger events with no extra fields.

**Data flow**: It deserializes trigger JSON and compares the resulting response item.

**Call relations**: The test exercises `ResponseItem` deserialization.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::deserializes_legacy_ghost_snapshot_as_other`  (lines 2963–2978)

```
fn deserializes_legacy_ghost_snapshot_as_other() -> Result<()>
```

**Purpose**: Checks that an old unknown ghost-snapshot item is safely parsed as `Other`. This prevents old data from breaking readers.

**Data flow**: It deserializes legacy JSON with an unknown type and asserts the result is `ResponseItem::Other`.

**Call relations**: The test exercises the catch-all `ResponseItem` deserialization branch.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::roundtrips_web_search_call_actions`  (lines 2981–3068)

```
fn roundtrips_web_search_call_actions() -> Result<()>
```

**Purpose**: Checks parsing and serialization of web-search call actions. This covers search, open-page, find-in-page, and partial events.

**Data flow**: It loops over example JSON cases, deserializes each, compares expected fields, serializes back, and accounts for skipped ID fields.

**Call relations**: The test exercises `ResponseItem::WebSearchCall` and `WebSearchAction` serialization behavior.

*Call graph*: 4 external calls (assert_eq!, from_str, to_value, vec!).


##### `tests::serializes_image_user_input_without_tags`  (lines 3071–3091)

```
fn serializes_image_user_input_without_tags() -> Result<()>
```

**Purpose**: Checks that remote image user input becomes an image content item without local-image tags. Remote images do not need local file labels.

**Data flow**: It converts a remote image user input and asserts the resulting message content contains only the image item.

**Call relations**: The test calls `ResponseInputItem::from`.

*Call graph*: calls 1 internal fn (from); 3 external calls (assert_eq!, panic!, vec!).


##### `tests::image_user_input_preserves_requested_detail`  (lines 3094–3116)

```
fn image_user_input_preserves_requested_detail() -> Result<()>
```

**Purpose**: Checks that remote image input preserves the requested detail level. This keeps user image-quality intent.

**Data flow**: It converts a remote image with original detail and asserts the resulting content item has original detail.

**Call relations**: The test calls `ResponseInputItem::from`.

*Call graph*: calls 1 internal fn (from); 3 external calls (assert_eq!, panic!, vec!).


##### `tests::tool_search_call_roundtrips`  (lines 3119–3161)

```
fn tool_search_call_roundtrips() -> Result<()>
```

**Purpose**: Checks that tool-search call items deserialize and serialize with their arguments intact. This supports tool discovery flows.

**Data flow**: It parses a tool-search call JSON object, compares the response item, serializes it, and compares JSON.

**Call relations**: The test exercises `ResponseItem::ToolSearchCall` serialization behavior.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::tool_search_output_roundtrips`  (lines 3164–3233)

```
fn tool_search_output_roundtrips() -> Result<()>
```

**Purpose**: Checks that tool-search output input items convert to response items and serialize correctly. This preserves discovered tool lists.

**Data flow**: It builds a tool-search output with tool JSON, converts it to a response item, and compares both conversion and serialized input JSON.

**Call relations**: The test exercises `ResponseItem::from` for `ToolSearchOutput` and `ResponseInputItem` serialization.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::tool_search_server_items_allow_null_call_id`  (lines 3236–3283)

```
fn tool_search_server_items_allow_null_call_id() -> Result<()>
```

**Purpose**: Checks that server-side tool-search calls and outputs can have a null call ID. This supports providers that do not supply one.

**Data flow**: It deserializes call and output JSON with null call IDs and compares the resulting response items.

**Call relations**: The test exercises optional call-ID handling in `ResponseItem` deserialization.

*Call graph*: 2 external calls (assert_eq!, from_str).


##### `tests::mixed_remote_and_local_images_share_label_sequence`  (lines 3286–3336)

```
fn mixed_remote_and_local_images_share_label_sequence() -> Result<()>
```

**Purpose**: Checks that remote and local images share one numbering sequence. This makes labels match the order users supplied images.

**Data flow**: It creates a remote image and a local image file, converts both, and asserts the local image is labeled as the second image.

**Call relations**: The test calls `ResponseInputItem::from` and local image tag helpers.

*Call graph*: calls 1 internal fn (from); 6 external calls (assert!, assert_eq!, panic!, write, tempdir, vec!).


##### `tests::local_image_open_tag_preserves_path`  (lines 3339–3347)

```
fn local_image_open_tag_preserves_path()
```

**Purpose**: Checks that local image opening tags include the path exactly as displayed, even with special characters. This preserves user-visible file identity.

**Data flow**: It builds a tag for a path containing special characters and compares the exact string.

**Call relations**: The test directly exercises `local_image_open_tag_text_with_path`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::local_image_user_input_preserves_requested_detail`  (lines 3350–3374)

```
fn local_image_user_input_preserves_requested_detail() -> Result<()>
```

**Purpose**: Checks that local image input preserves requested image detail. This matters when users ask to send the original image.

**Data flow**: It writes a tiny PNG, converts it as local image input with original detail, and asserts the resulting image item has original detail.

**Call relations**: The test calls `ResponseInputItem::from` and local image processing.

*Call graph*: calls 1 internal fn (from); 5 external calls (assert!, panic!, write, tempdir, vec!).


##### `tests::local_image_read_error_adds_placeholder`  (lines 3377–3408)

```
fn local_image_read_error_adds_placeholder() -> Result<()>
```

**Purpose**: Checks that a missing local image becomes a readable placeholder message. This avoids dropping the user’s intended attachment silently.

**Data flow**: It points to a missing file, converts local image input, and asserts the content is one text item mentioning the path and read issue.

**Call relations**: The test calls `ResponseInputItem::from`, which uses `local_image_error_placeholder`.

*Call graph*: calls 1 internal fn (from); 5 external calls (assert!, assert_eq!, panic!, tempdir, vec!).


##### `tests::local_image_non_image_adds_placeholder`  (lines 3411–3442)

```
fn local_image_non_image_adds_placeholder() -> Result<()>
```

**Purpose**: Checks that a local file with a non-image MIME type becomes an unsupported-image placeholder. This gives a clear explanation to the user.

**Data flow**: It writes a JSON file, converts it as a local image, and asserts the placeholder mentions the unsupported MIME type and path.

**Call relations**: The test calls `ResponseInputItem::from` and local image processing.

*Call graph*: calls 1 internal fn (from); 6 external calls (assert!, assert_eq!, panic!, write, tempdir, vec!).


##### `tests::local_image_unsupported_image_format_adds_placeholder`  (lines 3445–3475)

```
fn local_image_unsupported_image_format_adds_placeholder() -> Result<()>
```

**Purpose**: Checks that an unsupported image format such as SVG produces a specific placeholder. This gives users a precise failure reason.

**Data flow**: It writes an SVG file, converts it as local image input, and compares the exact unsupported-format placeholder text.

**Call relations**: The test calls `ResponseInputItem::from`, which reaches `unsupported_image_error_placeholder` through image loading.

*Call graph*: calls 1 internal fn (from); 6 external calls (assert_eq!, format!, panic!, write, tempdir, vec!).


### `protocol/src/account.rs`

`data_model` · `cross-cutting account data exchange`

This file is a small shared vocabulary for account information. Its main job is to say, in one place, what kinds of plans and provider accounts exist, and how those names should look when they travel over the wire as JSON. That matters because account data crosses boundaries: from authentication code, to provider-specific account checks, to app-facing protocol messages. If the spelling or grouping of a plan changed in one place but not another, features could appear or disappear for the wrong users.

The central type is PlanType, an enum, meaning a fixed list of possible plan values such as Free, Plus, Team, Business, Enterprise, and a fallback Unknown for plan names the program does not recognize yet. It also defines ProviderAccount, which describes where account access came from: an API key, a ChatGPT account with an email and plan, or Amazon Bedrock with a credential source. AmazonBedrockCredentialSource records whether those credentials are managed by Codex or by AWS.

The helper methods on PlanType answer practical product questions, such as “is this plan team-like?” or “is this a workspace account?” The conversion code bridges authentication-layer plan names into this protocol-layer PlanType. The tests protect the exact JSON spellings and grouping rules, especially for longer usage-based plan names where a small typo would break communication.

#### Function details

##### `PlanType::is_team_like`  (lines 55–57)

```
fn is_team_like(self) -> bool
```

**Purpose**: This answers whether a plan should be treated like a team plan. It is useful when different plan names should unlock the same team-style behavior.

**Data flow**: It starts with one PlanType value. It compares that value against the team-family options, Team and SelfServeBusinessUsageBased. It returns true if the plan belongs to that family, and false otherwise; it does not change any data.

**Call relations**: Other code can call this when it needs a simple yes-or-no answer instead of repeating the same plan list everywhere. Inside, it uses Rust's matches! check, which is just a compact way to ask whether a value is one of a few listed cases.

*Call graph*: 1 external calls (matches!).


##### `PlanType::is_business_like`  (lines 59–61)

```
fn is_business_like(self) -> bool
```

**Purpose**: This answers whether a plan should be treated like a business plan. It lets the rest of the system group the regular business plan and its usage-based version together.

**Data flow**: It receives one PlanType value. It checks whether that value is Business or EnterpriseCbpUsageBased. It returns true for those two cases and false for all others, without modifying anything.

**Call relations**: Callers use this as a shared rule for business-plan behavior. The function hands the actual comparison to Rust's matches! macro, which keeps the rule short and explicit.

*Call graph*: 1 external calls (matches!).


##### `PlanType::is_workspace_account`  (lines 63–73)

```
fn is_workspace_account(self) -> bool
```

**Purpose**: This answers whether a plan represents a workspace-style account rather than an individual account. Workspace plans include team, business, enterprise, and education-style plans.

**Data flow**: It takes a PlanType value as input. It compares it with the set of plans considered workspace accounts: Team, SelfServeBusinessUsageBased, Business, EnterpriseCbpUsageBased, Enterprise, and Edu. It returns true if the plan is in that set and false otherwise.

**Call relations**: This is the shared shortcut for any code that needs to decide whether account behavior should follow workspace rules. It uses Rust's matches! macro to keep the full list in one clear place.

*Call graph*: 1 external calls (matches!).


##### `PlanType::from`  (lines 86–100)

```
fn from(plan: KnownPlan) -> Self
```

**Purpose**: This converts a known authentication-layer plan into the account protocol's PlanType. It is the bridge between the plan names used during sign-in or authentication and the plan names exposed through account protocol data.

**Data flow**: It receives a KnownPlan value from the authentication module. It maps each known authentication plan to the matching PlanType value, such as KnownPlan::Free to PlanType::Free or KnownPlan::Enterprise to PlanType::Enterprise. The result is a protocol-friendly PlanType; nothing else is changed.

**Call relations**: This conversion is used when account information moves out of authentication code and into the account data model defined here. It prevents callers from hand-writing their own mapping and possibly forgetting a plan or choosing the wrong protocol name.


##### `tests::usage_based_plan_types_use_expected_wire_names`  (lines 111–140)

```
fn usage_based_plan_types_use_expected_wire_names()
```

**Purpose**: This test makes sure important plan names turn into the exact JSON text expected by other parts of the system. It especially protects long usage-based plan names, where spelling and underscores must match exactly.

**Data flow**: The test starts with selected PlanType values and serializes them to JSON strings. It also starts with JSON strings and deserializes them back into PlanType values. It checks that both directions produce the expected result.

**Call relations**: This test supports the serialization rules declared on PlanType. It uses equality checks to catch accidental changes that would break communication with clients or services expecting names like self_serve_business_usage_based or enterprise_cbp_usage_based.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::plan_family_helpers_group_usage_based_variants_with_existing_plans`  (lines 143–151)

```
fn plan_family_helpers_group_usage_based_variants_with_existing_plans()
```

**Purpose**: This test confirms that the helper methods group newer usage-based plans with the older plan families they behave like. It protects product logic that depends on those families.

**Data flow**: The test calls is_team_like and is_business_like on several PlanType values. It compares each returned true or false value with the expected grouping. No persistent data is changed.

**Call relations**: This test directly backs the family-checking helpers on PlanType. It makes sure team-like and business-like rules stay intentional when plan names are added or adjusted.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::workspace_account_helper_includes_usage_based_workspace_plans`  (lines 154–168)

```
fn workspace_account_helper_includes_usage_based_workspace_plans()
```

**Purpose**: This test verifies that all workspace-style plans are recognized as workspace accounts, including usage-based variants. It also checks that an individual plan, Pro, is not treated as a workspace.

**Data flow**: The test feeds several PlanType values into is_workspace_account. It checks that workspace plans return true and that Pro returns false. The only output is the test pass or failure.

**Call relations**: This test protects the shared workspace-account rule. If someone later changes is_workspace_account and accidentally drops one of these plans, this test is meant to fail and point out the mistake.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::auth_plan_type_converts_to_account_plan_type`  (lines 171–184)

```
fn auth_plan_type_converts_to_account_plan_type()
```

**Purpose**: This test checks that authentication plan values become the expected account PlanType values. It also verifies that an unknown authentication plan safely becomes PlanType::Unknown instead of pretending to be a known plan.

**Data flow**: The test builds authentication-layer plan values, converts them with PlanType::from, and compares the converted result with the expected PlanType. Known plans keep their meaning, while an unknown string becomes Unknown.

**Call relations**: This test protects the bridge between the authentication module and this account protocol model. It ensures callers can rely on PlanType::from to produce safe, app-facing account plan values.

*Call graph*: 1 external calls (assert_eq!).


### `protocol/src/approvals.rs`

`data_model` · `request handling`

This file is mostly a set of data shapes for approval and review workflows. When an agent wants to do something that may be risky, the system needs to describe that action clearly, send it to a client or reviewer, and receive a decision back. Without these shared shapes, one part of the system might say “approve this command” while another part does not know which command, which folder, which network host, or which choices to show the user.

The file covers several kinds of review. Command approvals describe the command, its working directory, optional network details, and possible longer-term rule changes. Patch approvals describe proposed file edits. Guardian assessment types describe a safety review, including the action being reviewed, its risk level, status, and final allow-or-deny outcome. Elicitation types describe requests for extra user input, either through a form or a URL.

A useful analogy is a permission slip. The action is written on the slip, the reviewer can see why it matters, and the allowed responses are printed on the bottom. Some helper methods fill in missing older fields so newer and older clients can still talk to each other. The file also includes tests that check important JSON message shapes stay stable.

#### Function details

##### `ExecPolicyAmendment::new`  (lines 45–47)

```
fn new(command: Vec<String>) -> Self
```

**Purpose**: Creates a proposed command-policy change from a list of command words. This is used when the system wants to suggest, “commands starting with these words can be allowed in the future.”

**Data flow**: It receives a list of strings, such as the words that make up the beginning of a command. It stores that list inside an ExecPolicyAmendment. The result is a small object that can be sent as part of an approval request.

**Call relations**: This is a simple constructor for the approval data model. Other code can use it when preparing an approval request that includes a proposed exec policy amendment, before that request is shown to a user or client.


##### `ExecPolicyAmendment::command`  (lines 49–51)

```
fn command(&self) -> &[String]
```

**Purpose**: Returns the command prefix stored in an ExecPolicyAmendment without giving ownership of it away. Someone would use this to inspect what command prefix is being proposed.

**Data flow**: It reads the command list already stored in the ExecPolicyAmendment. It does not change anything. It returns a borrowed view of that list so callers can look at it safely.

**Call relations**: This accessor supports code that needs to read an amendment after it has been created or received. It does not call into other parts of the approval flow; it simply exposes the stored command prefix.


##### `ExecPolicyAmendment::from`  (lines 55–57)

```
fn from(command: Vec<String>) -> Self
```

**Purpose**: Converts a plain list of command words into an ExecPolicyAmendment. This makes it easier to build the amendment from existing command-token data.

**Data flow**: It receives a vector of strings. It wraps that vector in the ExecPolicyAmendment structure. The output is the same information, now labeled as a proposed policy amendment.

**Call relations**: This is used through Rust’s standard conversion pattern, so code can turn a Vec<String> into an ExecPolicyAmendment without calling the constructor directly. It sits at the edge of the data model and does not trigger approval behavior by itself.


##### `ExecApprovalRequestEvent::effective_approval_id`  (lines 268–272)

```
fn effective_approval_id(&self) -> String
```

**Purpose**: Finds the identifier that should be used for this approval decision. If a separate approval ID exists, it uses that; otherwise it falls back to the command’s call ID.

**Data flow**: It reads the approval_id field and the call_id field from the request. If approval_id has a value, it returns a copy of that value. If not, it returns a copy of call_id. The request itself is not changed.

**Call relations**: The command approval handlers handle_exec_approval and handle_exec_approval_now call this when they need one reliable ID to track the user’s answer. This matters because normal command approvals and intercepted subcommand approvals identify themselves slightly differently.

*Call graph*: called by 2 (handle_exec_approval, handle_exec_approval_now).


##### `ExecApprovalRequestEvent::effective_available_decisions`  (lines 274–286)

```
fn effective_available_decisions(&self) -> Vec<ReviewDecision>
```

**Purpose**: Figures out which approval choices should be shown for a command request. It uses the explicit choices if they were sent, or reconstructs the older default choices when that newer field is missing.

**Data flow**: It reads available_decisions first. If that field is present, it returns a copy of those choices. If it is missing, it reads the network context, proposed policy amendments, and additional permission request, then asks the default decision logic to build the choice list.

**Call relations**: handle_exec_approval_now calls this while preparing an approval prompt. When newer senders provide exact choices, this function preserves them. When older senders do not, it hands off to default_available_decisions so clients still get sensible approve-or-abort options.

*Call graph*: called by 1 (handle_exec_approval_now); 1 external calls (default_available_decisions).


##### `ExecApprovalRequestEvent::default_available_decisions`  (lines 288–321)

```
fn default_available_decisions(
        network_approval_context: Option<&NetworkApprovalContext>,
        proposed_execpolicy_amendment: Option<&ExecPolicyAmendment>,
        proposed_network_policy_
```

**Purpose**: Builds the fallback list of choices for older approval requests that did not include an explicit decision list. The choices depend on what kind of permission is being requested.

**Data flow**: It receives optional information about network access, proposed command-policy changes, proposed network-policy changes, and extra filesystem permissions. For network requests, it offers approve, approve for session, possibly a network policy amendment, and abort. For extra permission requests, it offers approve or abort. For ordinary command requests, it offers approve, possibly approve with a command-policy amendment, and abort.

**Call relations**: effective_available_decisions uses this when an approval request does not already say which decisions are available. This keeps older protocol messages working while still letting newer messages provide an exact ordered list.

*Call graph*: 1 external calls (vec!).


##### `ElicitationRequest::message`  (lines 346–350)

```
fn message(&self) -> &str
```

**Purpose**: Returns the human-readable message from an elicitation request, whether the request is a form or a URL. This gives callers one simple way to get the text to show to the user.

**Data flow**: It looks at which kind of ElicitationRequest it has. For both Form and Url variants, it extracts the message field. It returns a borrowed string and does not modify the request.

**Call relations**: This is a convenience method for code that displays or logs elicitation prompts. It hides the difference between the form-shaped and URL-shaped requests when all the caller needs is the message.


##### `tests::guardian_assessment_action_deserializes_command_shape`  (lines 400–417)

```
fn guardian_assessment_action_deserializes_command_shape()
```

**Purpose**: Checks that a JSON object describing a shell command can be read into the GuardianAssessmentAction command form correctly. This protects the protocol shape expected by clients and reviewers.

**Data flow**: The test builds a JSON value with a type of command, a source, a command string, and a working directory. It deserializes that JSON into a GuardianAssessmentAction. Then it compares the result with the exact Rust value expected.

**Call relations**: This test uses JSON construction, JSON deserialization, and equality checking to guard the command-review message format. If someone changes the field names or representation by accident, this test should fail.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


##### `tests::guardian_assessment_action_round_trips_execve_shape`  (lines 421–450)

```
fn guardian_assessment_action_round_trips_execve_shape()
```

**Purpose**: Checks that an execve-style guardian action can be read from JSON and written back to the same JSON shape. Execve means a lower-level program launch with a program path and argument list.

**Data flow**: The test starts with JSON containing an execve action, including the program, argument list, and working directory. It deserializes the JSON into a GuardianAssessmentAction, serializes it back to JSON, and checks that nothing changed. It also checks that the Rust value has the expected fields.

**Call relations**: This Unix-only test protects the wire format for intercepted process launches. It uses JSON construction, deserialization, serialization, and equality checks so the guardian review protocol stays compatible with clients expecting this exact shape.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


### `protocol/src/auth.rs`

`data_model` · `authentication flows and account-plan interpretation`

This file is a small vocabulary for authentication and account status. Outside systems may send plan names as raw text, and that text is not always perfectly uniform: for example, an enterprise plan might arrive as "enterprise" or "hc". This file turns those strings into safer Rust values so the rest of the program does not have to guess or repeat the same string checks.

The main idea is similar to sorting mail at the front desk. Known labels go into named bins, while unfamiliar labels are still kept instead of being thrown away. `PlanType` can be either a known plan or an unknown string, which lets the program keep working even if a server introduces a new plan name before this code knows about it.

`KnownPlan` lists the plans the code already understands. It can provide a human-friendly display name, the exact raw value used in protocol data, and whether the plan represents a workspace-style account such as Team, Business, Enterprise, or Education.

The file also defines `RefreshTokenFailedError`, an error value used when refreshing an authentication token fails. It records both a broad reason, such as expired or revoked, and a message suitable for reporting or logging. A small test checks that old or alternate plan names still deserialize correctly.

#### Function details

##### `PlanType::from_raw_value`  (lines 13–30)

```
fn from_raw_value(raw: &str) -> Self
```

**Purpose**: This turns a raw plan name string into a structured `PlanType`. It recognizes known plan names and aliases, while preserving unknown values so new server-side plans do not break the client.

**Data flow**: It receives a text value, lowercases it so capitalization does not matter, and compares it with the plan names this file knows about. If it matches, the output is a known plan value; if it does not match, the output keeps the original text inside an unknown plan value.

**Call relations**: This is the front-door translator for plan strings. Internally it creates either the known-plan form or the unknown-plan form, so later code can work with a clear category instead of repeatedly checking raw text.

*Call graph*: 2 external calls (Known, Unknown).


##### `KnownPlan::display_name`  (lines 54–68)

```
fn display_name(self) -> &'static str
```

**Purpose**: This gives a plan a readable name for people. It is useful anywhere the program needs to show a plan in logs, settings, or user-facing text instead of using protocol-style names like `prolite`.

**Data flow**: It receives one known plan value and maps it directly to a fixed display string. Nothing is changed elsewhere; the result is just the friendly name for that plan.

**Call relations**: After some other part of the system has identified a plan as known, this function provides the human-readable label. It does not call out to other helpers; it is a simple lookup table in code.


##### `KnownPlan::raw_value`  (lines 70–84)

```
fn raw_value(self) -> &'static str
```

**Purpose**: This returns the exact protocol spelling for a known plan. It is useful when the program needs to send or compare the compact server-facing value rather than a display label.

**Data flow**: It receives one known plan value and returns the matching fixed raw string, such as `free`, `team`, or `enterprise_cbp_usage_based`. It does not modify any state.

**Call relations**: This is the reverse side of plan interpretation: once code has a structured plan, this function can turn it back into the standard raw form expected by other protocol code.


##### `KnownPlan::is_workspace_account`  (lines 86–96)

```
fn is_workspace_account(self) -> bool
```

**Purpose**: This answers whether a known plan belongs to a workspace-style account. That distinction matters because team, business, enterprise, and education accounts often behave differently from individual plans.

**Data flow**: It receives one known plan value and checks whether it is one of the workspace account plans. The output is a simple true-or-false answer.

**Call relations**: Code that needs to branch between individual-account behavior and workspace-account behavior can call this after a plan has been identified. Inside, it uses Rust's pattern-matching shortcut to test the plan against the workspace list.

*Call graph*: 1 external calls (matches!).


##### `RefreshTokenFailedError::new`  (lines 107–112)

```
fn new(reason: RefreshTokenFailedReason, message: impl Into<String>) -> Self
```

**Purpose**: This builds a standard error value for a failed token refresh. It keeps both the machine-friendly reason and the human-readable message together.

**Data flow**: It receives a failure reason and some message-like input. It converts the message into a stored string, then returns a `RefreshTokenFailedError` containing both pieces of information.

**Call relations**: This constructor is called by refresh-token paths and failure-classification code when they need to report that refreshing authentication did not succeed. It packages the failure so callers such as `refresh_token`, `next`, and related tests can pass around one clear error value.

*Call graph*: called by 4 (refresh_failure_is_scoped_to_the_matching_auth_snapshot, refresh_token, next, classify_refresh_token_failure); 1 external calls (into).


##### `tests::plan_type_deserializes_raw_aliases`  (lines 130–140)

```
fn plan_type_deserializes_raw_aliases()
```

**Purpose**: This test proves that alternate raw plan names still turn into the correct known plans. In particular, it checks compatibility for `hc` as Enterprise and `education` as Edu.

**Data flow**: It feeds small JSON strings into deserialization, which means converting JSON text into Rust values. It then compares the result with the expected known plan values and fails the test if they differ.

**Call relations**: This test protects the plan parsing behavior from accidental changes. It calls assertion helpers to confirm that the aliases accepted by the serialized data model keep working.

*Call graph*: 1 external calls (assert_eq!).


### `protocol/src/capabilities.rs`

`data_model` · `cross-cutting protocol data exchange`

This file is a small shared contract between parts of the system. It does not perform actions itself. Instead, it defines the exact shape of data used when a user selects a root that gives access to one or more capabilities.

The main type, `SelectedCapabilityRoot`, is like a label on a storage box. It has a stable `id`, supplied by the platform that let the user make the selection, and a `location`, which tells the rest of the system where that selected root can actually be found.

The location is represented by `CapabilityRootLocation`. Right now there is one supported kind: `Environment`. That means the selected root is a path inside a particular execution environment. An execution environment is the place where code or tools run, and the `environment_id` says which one to look in. The `path` says where inside it to start.

The file also marks these types so they can be converted to and from common data formats such as JSON, used to produce JSON schemas, and exported as TypeScript definitions. This matters because different parts of the product, possibly written in different languages, need to agree exactly on field names and structure. Without this file, those parts could disagree about what a selected capability root looks like.


### `protocol/src/config_types.rs`

`config` · `config load and runtime option updates`

This file is a shared dictionary for Codex configuration. It gives names and shapes to settings that may come from config files, command-line choices, JSON messages, or generated TypeScript types. Without this file, different parts of the system could disagree about simple but important things, such as what “read-only sandbox” means, how to spell a service tier, or whether a profile name is safe to use as a filename.

Most of the file is made of Rust enums and structs. An enum is a fixed list of allowed choices, like “disabled”, “cached”, or “live” for web search. A struct groups related fields, like the country, region, and city for web search location. Many types can be serialized and deserialized, meaning they can be turned into config text or JSON and read back again.

A few pieces add safety rules. `ProfileV2Name` only accepts plain names made of letters, numbers, underscores, and dashes, which helps prevent someone from passing a path like `../secret`. `ModelProviderAuthInfo` sets safe defaults for running a command that returns an authentication token. Web search configs can be layered together, where a newer value overrides an older one only when it is present. Collaboration modes work the same way: a partial “mask” can change selected fields while leaving the rest untouched.

#### Function details

##### `ProfileV2Name::as_str`  (lines 103–105)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the stored profile name as plain text. This lets other code read the validated name without taking ownership of it.

**Data flow**: It starts with a `ProfileV2Name` that already passed validation. It reads the inner string and returns it as a borrowed string slice, without changing anything.

**Call relations**: This is the basic reader for profile names. `ProfileV2Name::deref` calls it so a profile name can be treated like a normal string when needed.

*Call graph*: called by 1 (deref).


##### `ProfileV2NameParseError::fmt`  (lines 114–120)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Creates the human-readable error message shown when someone passes an invalid profile name. The message explains that the value must be a plain name, such as `work`.

**Data flow**: It reads the invalid value stored in the error, writes a clear message into the formatter, and returns the formatting result.

**Call relations**: This is used by Rust’s display system when the error needs to be printed for a person. It relies on the standard `write!` formatting helper.

*Call graph*: 1 external calls (write!).


##### `ProfileV2Name::from_str`  (lines 128–140)

```
fn from_str(value: &str) -> Result<Self, Self::Err>
```

**Purpose**: Checks whether a profile name is safe and turns it into a `ProfileV2Name`. It rejects empty names and names containing anything except letters, numbers, underscores, and dashes.

**Data flow**: It receives raw text from outside the program. If the text is empty or contains unsafe characters such as slashes or dots, it returns a parse error holding that value. Otherwise it stores the text in a new validated profile-name object.

**Call relations**: This is the gatekeeper for profile names. Code that parses command-line or config input can use it to avoid treating arbitrary paths as profile files.


##### `ProfileV2Name::deref`  (lines 146–148)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets a `ProfileV2Name` be used like a regular string in places that expect string-like access. This is a convenience after the name has already been validated.

**Data flow**: It receives a reference to the profile-name object, calls `ProfileV2Name::as_str`, and returns the same borrowed text.

**Call relations**: It builds directly on `ProfileV2Name::as_str`. This makes the type easier to pass around without weakening its validation rule.

*Call graph*: calls 1 internal fn (as_str).


##### `ProfileV2Name::fmt`  (lines 152–154)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Prints a validated profile name as its plain text value. This is used when the name needs to appear in logs, messages, or formatted strings.

**Data flow**: It reads the inner string and writes it to the formatter. The profile name itself is not changed.

**Call relations**: This plugs `ProfileV2Name` into Rust’s normal display formatting system.


##### `ApprovalsReviewer::schema_name`  (lines 175–177)

```
fn schema_name() -> String
```

**Purpose**: Gives the JSON schema name for the approval-reviewer setting. A JSON schema is a machine-readable description of valid config values.

**Data flow**: It takes no runtime input and returns the fixed schema name `ApprovalsReviewer`.

**Call relations**: Schema generation code calls this when documenting or validating configuration that chooses who reviews approval requests.


##### `ApprovalsReviewer::json_schema`  (lines 179–184)

```
fn json_schema(_generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Builds the JSON schema for the approval-reviewer setting, including the accepted string values and a description. It documents both the current values and the legacy `guardian_subagent` spelling.

**Data flow**: It ignores the schema generator input, lists the accepted strings, passes them with a plain-language description to `string_enum_schema_with_description`, and returns the resulting schema object.

**Call relations**: This is called by schema generation. It delegates the common work of building a string-enum schema to `string_enum_schema_with_description`.

*Call graph*: calls 1 internal fn (string_enum_schema_with_description).


##### `ShellEnvironmentPolicy::default`  (lines 234–243)

```
fn default() -> Self
```

**Purpose**: Creates the default policy for which environment variables a shell command should receive. By default it inherits all parent environment variables, skips built-in secret filtering, adds nothing, restricts nothing, and does not use a shell profile.

**Data flow**: It takes no input. It creates empty lists and an empty map for exclusions, insertions, and include-only filters, then returns a complete default policy.

**Call relations**: This default is used by several configuration-building and test paths, including flows that build agent spawn settings and environment-variable behavior.

*Call graph*: called by 7 (from_approval_and_profile, populate_env_inserts_thread_id, populate_env_omits_thread_id_when_missing, test_core_inherit_defaults_keep_sensitive_vars, build_agent_spawn_config_uses_turn_context_values, create_env_from_core_vars, create_env_from_core_vars); 2 external calls (new, new).


##### `string_enum_schema_with_description`  (lines 246–262)

```
fn string_enum_schema_with_description(values: &[&str], description: &str) -> Schema
```

**Purpose**: Creates a JSON schema for a setting whose valid values are a fixed list of strings. It also attaches a description so generated docs are useful to humans.

**Data flow**: It receives a list of allowed strings and a description. It builds a schema object marked as a string, stores the description, stores the allowed values, and returns the finished schema.

**Call relations**: This helper is used by `ApprovalsReviewer::json_schema` so that custom enum schema code stays small and consistent.

*Call graph*: called by 1 (json_schema); 3 external calls (new, default, Object).


##### `WebSearchLocation::merge`  (lines 330–337)

```
fn merge(&self, other: &Self) -> Self
```

**Purpose**: Combines two web search locations, treating the second one as an overlay. Any location field present in the overlay wins; missing overlay fields fall back to the original.

**Data flow**: It reads `country`, `region`, `city`, and `timezone` from both location objects. For each field, it chooses the overlay value if it exists, otherwise the base value, and returns a new merged location.

**Call relations**: This is used by `WebSearchToolConfig::merge` when both configs include location details. It is the field-by-field merge step for nested location settings.


##### `WebSearchToolConfig::merge`  (lines 349–363)

```
fn merge(&self, other: &Self) -> Self
```

**Purpose**: Combines two web search tool configurations, with the second one overriding only the fields it actually sets. This allows defaults and user overrides to be layered cleanly.

**Data flow**: It reads context size, allowed domains, and location from the base and overlay configs. It chooses overlay values when present, keeps base values when the overlay is missing them, and merges nested locations field by field when both exist.

**Call relations**: This is the larger merge operation for web search tool settings. It calls `WebSearchLocation::merge` for the location part so the same overlay rule applies inside that nested object.


##### `WebSearchUserLocation::from`  (lines 402–410)

```
fn from(location: WebSearchLocation) -> Self
```

**Purpose**: Converts the project’s internal web search location format into the user-location format expected by the web search API configuration. It marks the location as approximate.

**Data flow**: It receives a `WebSearchLocation`, moves over its country, region, city, and timezone fields, sets the type to `Approximate`, and returns a `WebSearchUserLocation`.

**Call relations**: This conversion is used by `WebSearchConfig::from` when turning a tool-specific config into the broader web search config shape.


##### `WebSearchConfig::from`  (lines 414–424)

```
fn from(config: WebSearchToolConfig) -> Self
```

**Purpose**: Converts `WebSearchToolConfig` into `WebSearchConfig`, which is the shape used for web search requests. It maps allowed domains, location, and context size into the request-facing names.

**Data flow**: It receives a tool config. If allowed domains are present, it wraps them in `WebSearchFilters`; if location is present, it converts it into `WebSearchUserLocation`; it copies the context size into `search_context_size`; then it returns the new config.

**Call relations**: This function sits between local configuration and request configuration. It uses `WebSearchUserLocation::from` for the location conversion.


##### `ServiceTier::request_value`  (lines 442–447)

```
fn request_value(self) -> &'static str
```

**Purpose**: Returns the service-tier string that should be sent in a model request. It maps the user-facing `Fast` tier to the request value `priority` and `Flex` to `flex`.

**Data flow**: It receives a service-tier enum value and returns the matching static string. Nothing is changed.

**Call relations**: Request-building code can call this when it needs the exact value expected by the backend service.


##### `ServiceTier::from_request_value`  (lines 449–455)

```
fn from_request_value(value: &str) -> Option<Self>
```

**Purpose**: Parses a service-tier string from request or config form back into a `ServiceTier`. It accepts both `fast` and `priority` for the fast tier.

**Data flow**: It receives text. If the text is `fast` or `priority`, it returns `Fast`; if it is `flex`, it returns `Flex`; otherwise it returns nothing.

**Call relations**: This is called by an `apply` flow when turning incoming configuration into typed settings. It protects the rest of the code from unknown service-tier strings.

*Call graph*: called by 1 (apply).


##### `ModelProviderAuthInfo::timeout`  (lines 496–498)

```
fn timeout(&self) -> Duration
```

**Purpose**: Turns the configured authentication-command timeout from milliseconds into a `Duration`, which is Rust’s standard time-span type. Callers use this when deciding how long to wait for a token command.

**Data flow**: It reads the non-zero millisecond value from the config, converts it into a duration, and returns that duration.

**Call relations**: Code that runs a provider authentication command can call this before spawning or waiting on the command.

*Call graph*: 2 external calls (from_millis, get).


##### `ModelProviderAuthInfo::refresh_interval`  (lines 500–502)

```
fn refresh_interval(&self) -> Option<Duration>
```

**Purpose**: Turns the configured token refresh interval into an optional time span. A value of zero means proactive refresh is disabled.

**Data flow**: It reads `refresh_interval_ms`. If the number is non-zero, it converts it into a duration and returns it wrapped in `Some`; if it is zero, it returns `None`.

**Call relations**: Token-caching code can use this to decide whether to refresh a provider token on a timer or only after an authentication failure.

*Call graph*: 1 external calls (new).


##### `default_provider_auth_timeout_ms`  (lines 505–510)

```
fn default_provider_auth_timeout_ms() -> NonZeroU64
```

**Purpose**: Provides the default timeout for a provider authentication command. The default is 5,000 milliseconds and is guaranteed to be non-zero.

**Data flow**: It passes the default timeout number and the field name to `non_zero_u64`, then returns the validated non-zero value.

**Call relations**: Serde, the config loading library, calls this as the default for `ModelProviderAuthInfo.timeout_ms` when the user does not set one.

*Call graph*: calls 1 internal fn (non_zero_u64).


##### `default_provider_auth_refresh_interval_ms`  (lines 512–514)

```
fn default_provider_auth_refresh_interval_ms() -> u64
```

**Purpose**: Provides the default interval for proactively refreshing a cached provider token. The default is 300,000 milliseconds, or five minutes.

**Data flow**: It takes no input and returns the fixed default number of milliseconds.

**Call relations**: Serde uses this as the default for `ModelProviderAuthInfo.refresh_interval_ms` when that field is missing from configuration.


##### `non_zero_u64`  (lines 516–521)

```
fn non_zero_u64(value: u64, field_name: &str) -> NonZeroU64
```

**Purpose**: Converts a plain unsigned number into a non-zero number type, and crashes immediately if the supplied default is accidentally zero. This is a safeguard for constants that must never be zero.

**Data flow**: It receives a number and the name of the config field it belongs to. If the number is non-zero, it returns the non-zero wrapper; if it is zero, it panics with a field-specific message.

**Call relations**: `default_provider_auth_timeout_ms` calls this to prove its timeout default is valid before using it in configuration.

*Call graph*: called by 1 (default_provider_auth_timeout_ms); 2 external calls (new, panic!).


##### `default_provider_auth_cwd`  (lines 523–533)

```
fn default_provider_auth_cwd() -> AbsolutePathBuf
```

**Purpose**: Chooses the default working directory for a provider authentication command. It tries to resolve `.` as an absolute path, and falls back to the process’s current directory if needed.

**Data flow**: It first asks `AbsolutePathBuf` to deserialize `.` into an absolute path. If that works, it returns that path. If not, it asks the operating system for the current directory; if even that fails, it panics because the default cannot be safely resolved.

**Call relations**: Serde uses this as the default for `ModelProviderAuthInfo.cwd`. `is_default_provider_auth_cwd` also calls it when deciding whether a path is the default and can be skipped during schema serialization.

*Call graph*: calls 2 internal fn (current_dir, deserialize); called by 1 (is_default_provider_auth_cwd); 2 external calls (panic!, new).


##### `is_default_provider_auth_cwd`  (lines 535–537)

```
fn is_default_provider_auth_cwd(path: &AbsolutePathBuf) -> bool
```

**Purpose**: Checks whether a provider authentication working directory is the default value. This is used so generated schemas or serialized config can omit the field when it has the default.

**Data flow**: It receives a path, computes the default provider-auth working directory, compares the two, and returns true if they match.

**Call relations**: It calls `default_provider_auth_cwd`. The `ModelProviderAuthInfo.cwd` schema annotation uses this as its skip condition.

*Call graph*: calls 1 internal fn (default_provider_auth_cwd).


##### `ModeKind::display_name`  (lines 601–608)

```
fn display_name(self) -> &'static str
```

**Purpose**: Returns the friendly name for a collaboration mode, suitable for showing to a user. For example, `Plan` becomes `Plan` and `PairProgramming` becomes `Pair Programming`.

**Data flow**: It receives a mode value and returns the matching static display string.

**Call relations**: User-facing messaging, including `request_user_input_unavailable_message`, calls this when it needs to mention a mode in readable text.

*Call graph*: called by 1 (request_user_input_unavailable_message).


##### `ModeKind::is_tui_visible`  (lines 610–612)

```
fn is_tui_visible(self) -> bool
```

**Purpose**: Reports whether a collaboration mode should be shown in the terminal user interface. Only `Plan` and `Default` are visible choices.

**Data flow**: It receives a mode, checks whether it is `Plan` or `Default`, and returns true or false.

**Call relations**: The `mask_for_kind` flow calls this when deciding which modes can appear as selectable terminal UI options.

*Call graph*: called by 1 (mask_for_kind); 1 external calls (matches!).


##### `ModeKind::allows_request_user_input`  (lines 614–616)

```
fn allows_request_user_input(self) -> bool
```

**Purpose**: Reports whether this collaboration mode allows the assistant to ask the user for input. Currently only `Plan` mode allows that.

**Data flow**: It receives a mode, checks whether it is `Plan`, and returns true or false.

**Call relations**: This is a policy check for features that may request user input. Callers can use it before offering or performing that behavior.

*Call graph*: 1 external calls (matches!).


##### `CollaborationMode::settings_ref`  (lines 629–631)

```
fn settings_ref(&self) -> &Settings
```

**Purpose**: Returns a borrowed reference to the settings inside a collaboration mode. It is a small internal helper that keeps other methods from repeating direct field access.

**Data flow**: It receives a collaboration mode and returns a reference to its `settings` field without copying or changing it.

**Call relations**: `CollaborationMode::model`, `CollaborationMode::reasoning_effort`, `CollaborationMode::with_updates`, and `CollaborationMode::apply_mask` call this before reading or copying settings.

*Call graph*: called by 4 (apply_mask, model, reasoning_effort, with_updates).


##### `CollaborationMode::model`  (lines 633–635)

```
fn model(&self) -> &str
```

**Purpose**: Returns the model name used by this collaboration mode. This lets other code ask, “Which model should this session use?”

**Data flow**: It gets the settings through `settings_ref`, reads the model string, and returns it as borrowed text.

**Call relations**: `thread_config_snapshot` calls this when recording or reporting the current thread configuration.

*Call graph*: calls 1 internal fn (settings_ref); called by 1 (thread_config_snapshot).


##### `CollaborationMode::reasoning_effort`  (lines 637–639)

```
fn reasoning_effort(&self) -> Option<ReasoningEffort>
```

**Purpose**: Returns the reasoning-effort setting for this collaboration mode, if one is set. Reasoning effort is a model option that controls how much reasoning work the model should use.

**Data flow**: It gets the settings through `settings_ref`, clones the optional reasoning-effort value, and returns it. The collaboration mode itself is unchanged.

**Call relations**: `thread_config_snapshot` calls this alongside `model` to capture the model-related settings for a session.

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

**Purpose**: Creates a new collaboration mode with selected settings changed. Any input left as `None` keeps the old value, while optional fields can also be explicitly cleared.

**Data flow**: It reads the current settings, then builds new settings. A supplied model replaces the old model; a supplied effort value either sets or clears reasoning effort; supplied developer instructions either set or clear instructions. It returns a new collaboration mode with the same mode kind.

**Call relations**: This is called by `with_model`, which needs to adjust model-related settings without rebuilding the whole collaboration mode by hand. It uses `settings_ref` to read the original values.

*Call graph*: calls 1 internal fn (settings_ref); called by 1 (with_model).


##### `CollaborationMode::apply_mask`  (lines 673–689)

```
fn apply_mask(&self, mask: &CollaborationModeMask) -> Self
```

**Purpose**: Applies a partial collaboration-mode override, called a mask, to an existing collaboration mode. Fields present in the mask replace old values; fields missing from the mask leave old values alone.

**Data flow**: It reads the current mode and settings, reads the mask, chooses mask values when they are present, and returns a new collaboration mode. The mask’s `name` is ignored because it is only a label for the mask.

**Call relations**: This is the main layering operation for collaboration-mode presets or overrides. It calls `settings_ref` to start from the current settings.

*Call graph*: calls 1 internal fn (settings_ref).


##### `tests::apply_mask_can_clear_optional_fields`  (lines 717–743)

```
fn apply_mask_can_clear_optional_fields()
```

**Purpose**: Checks that applying a collaboration-mode mask can intentionally clear optional fields such as reasoning effort and developer instructions. This protects the difference between “leave unchanged” and “set to empty”.

**Data flow**: It creates a mode with optional fields filled in, creates a mask where those fields are explicitly `Some(None)`, applies the mask, and compares the result to the expected mode with those fields cleared.

**Call relations**: This test exercises `CollaborationMode::apply_mask` and confirms its behavior for nested optional values.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::mode_kind_deserializes_alias_values_to_default`  (lines 746–752)

```
fn mode_kind_deserializes_alias_values_to_default()
```

**Purpose**: Checks that old or alternate collaboration-mode names still load as `Default`. This keeps existing config files working after names have changed.

**Data flow**: It loops over alias strings such as `code` and `pair_programming`, turns each into JSON text, deserializes it into `ModeKind`, and asserts that the result is `Default`.

**Call relations**: This test protects the serde alias rules on `ModeKind`, which matter during config or JSON loading.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `tests::approvals_reviewer_serializes_auto_review_and_accepts_legacy_guardian_subagent`  (lines 755–777)

```
fn approvals_reviewer_serializes_auto_review_and_accepts_legacy_guardian_subagent()
```

**Purpose**: Checks that approval-reviewer values serialize to the expected strings and that the old `guardian_subagent` name is still accepted. This preserves compatibility while standardizing on `auto_review`.

**Data flow**: It serializes `User` and `AutoReview` and checks the resulting JSON strings. Then it deserializes `user`, `auto_review`, and `guardian_subagent`, and compares each to the expected enum value.

**Call relations**: This test protects the custom naming and alias behavior of `ApprovalsReviewer`, including the legacy spelling documented in its schema.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `tests::profile_v2_name_rejects_paths_and_empty_names`  (lines 780–795)

```
fn profile_v2_name_rejects_paths_and_empty_names()
```

**Purpose**: Checks that profile names cannot be empty and cannot look like paths. This is important because profile names are used to choose config files under a fixed directory.

**Data flow**: It tries to parse `../foo` and an empty string as profile names. In both cases it expects a `ProfileV2NameParseError` containing the rejected value.

**Call relations**: This test directly exercises `ProfileV2Name::from_str` and documents the safety rule that prevents reading arbitrary files through profile selection.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::tui_visible_collaboration_modes_match_mode_kind_visibility`  (lines 798–808)

```
fn tui_visible_collaboration_modes_match_mode_kind_visibility()
```

**Purpose**: Checks that the hard-coded list of terminal-visible collaboration modes matches the visibility rule on each mode. This keeps the UI list and the mode policy from drifting apart.

**Data flow**: It compares the visible-mode constant to the expected `[Default, Plan]` list, checks that each listed mode reports visible, and checks that hidden modes report not visible.

**Call relations**: This test exercises `ModeKind::is_tui_visible` and the `TUI_VISIBLE_COLLABORATION_MODES` constant together.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::web_search_location_merge_prefers_overlay_values`  (lines 811–833)

```
fn web_search_location_merge_prefers_overlay_values()
```

**Purpose**: Checks that merging web search locations prefers values from the overlay while preserving base values where the overlay is empty. This verifies the layering behavior used for location settings.

**Data flow**: It builds a base location and an overlay location with some fields missing, merges them, and compares the result to the expected combination.

**Call relations**: This test directly exercises `WebSearchLocation::merge`, especially the per-field fallback rule.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::web_search_tool_config_merge_prefers_overlay_values`  (lines 836–870)

```
fn web_search_tool_config_merge_prefers_overlay_values()
```

**Purpose**: Checks that merging web search tool configs prefers overlay values where present and keeps base values otherwise. It also verifies that nested location values are merged instead of blindly replaced.

**Data flow**: It builds a base tool config and an overlay tool config, including nested locations. It merges them and compares the result to the expected config with overlay context size, preserved allowed domains, and merged location fields.

**Call relations**: This test exercises `WebSearchToolConfig::merge`, including its use of `WebSearchLocation::merge` for nested location data.

*Call graph*: 2 external calls (assert_eq!, vec!).


### `protocol/src/dynamic_tools.rs`

`data_model` · `serialization and deserialization of dynamic tool definitions and tool-call messages`

Dynamic tools are extra abilities the system can learn about while it is running, rather than only at compile time. This file is the protocol contract for those tools: it says what a tool description looks like, what a tool call request contains, and what a tool response can return. These Rust types are also set up for JSON serialization, JSON schema generation, and TypeScript export, so the backend and frontend can agree on the same shapes.

The main idea is simple: a tool can be a single function, or it can live inside a namespace, which is like a folder that groups related tools under one name. A function has a name, a human-readable description, an input schema describing what arguments it accepts, and a flag saying whether its full loading can be delayed.

A key job of this file is backward compatibility. Older sessions stored tools in a flatter format, with fields such as `namespace` and `exposeToContext`. Newer code expects an explicit `type` field and namespace objects. The normalization code acts like a translator: it detects whether the incoming data is old or new, rejects a confusing mix of both, and converts old entries into the current structure. Without this, users might lose the ability to resume older sessions after the protocol changed.

#### Function details

##### `normalize_dynamic_tool_specs`  (lines 88–131)

```
fn normalize_dynamic_tool_specs(
    values: Vec<JsonValue>,
) -> Result<Vec<DynamicToolSpec>, serde_json::Error>
```

**Purpose**: This function accepts raw JSON tool definitions and turns them into the current `DynamicToolSpec` format. It exists so the system can read both modern tool descriptions and older saved descriptions, while refusing a mixed format that would be ambiguous.

**Data flow**: It receives a list of JSON values. First it checks whether the list looks like the legacy format, the current format, or an invalid mixture of both. If everything is already current, it deserializes each JSON value directly into a `DynamicToolSpec`. If the input is legacy, it reads each item as a legacy tool, converts old fields into the new function shape, and then groups tools by namespace. The output is either a clean list of current tool specs or a JSON error explaining why conversion failed.

**Call relations**: This is the central translator for dynamic tool definitions. It is used when dynamic tools are parsed from command-line or other arguments, and also by the custom deserializer in this file. When it finds old namespace-style entries, it hands them to `group_dynamic_tools_by_namespace` so related tools become one namespace object instead of separate flat records.

*Call graph*: calls 1 internal fn (group_dynamic_tools_by_namespace); called by 2 (parse_dynamic_tools_arg, deserialize_dynamic_tool_specs); 1 external calls (custom).


##### `group_dynamic_tools_by_namespace`  (lines 133–159)

```
fn group_dynamic_tools_by_namespace(
    tools: Vec<(Option<String>, DynamicToolFunctionSpec)>,
) -> Vec<DynamicToolSpec>
```

**Purpose**: This function collects legacy tool functions into the newer namespace structure. It keeps standalone tools standalone, and puts tools with the same namespace name into one shared namespace group.

**Data flow**: It receives pairs of optional namespace name plus function specification. For each pair, if there is no namespace, it adds the function directly to the result. If there is a namespace, it either appends the function to an existing namespace entry or creates a new namespace entry with that name. The output is an ordered list of current dynamic tool specs, mixing standalone functions and namespace groups as needed.

**Call relations**: This function is a helper used by `normalize_dynamic_tool_specs` during legacy conversion. The normalizer first translates each old record into a function plus optional namespace; this function then does the folder-like grouping step before handing the cleaned structure back.

*Call graph*: called by 1 (normalize_dynamic_tool_specs); 8 external calls (new, new, with_capacity, Function, Function, Namespace, unreachable!, vec!).


##### `deserialize_dynamic_tool_specs`  (lines 161–173)

```
fn deserialize_dynamic_tool_specs(
    deserializer: D,
) -> Result<Option<Vec<DynamicToolSpec>>, D::Error>
```

**Purpose**: This function plugs the normalization step into Serde, Rust’s common JSON serialization and deserialization library. It lets any larger struct field read dynamic tool specs while automatically accepting both old and new formats.

**Data flow**: It receives a deserializer, which is Serde’s stream of incoming data. It first tries to read an optional list of raw JSON values. If the field is missing or null, it returns `None`. If there is a list, it passes that list through `normalize_dynamic_tool_specs`; a successful conversion becomes `Some(list)`, and any conversion problem is turned into the deserializer’s error type.

**Call relations**: This function is called by Serde when a struct field is annotated to use it for dynamic tool specs. It delegates the real compatibility work to `normalize_dynamic_tool_specs`, so callers get already-normalized tool definitions without needing to know whether the source data was legacy or current.

*Call graph*: calls 1 internal fn (normalize_dynamic_tool_specs); 1 external calls (deserialize).


### `protocol/src/error.rs`

`domain_logic` · `cross-cutting`

When something goes wrong in Codex, many parts of the system need the same answer to three questions: what happened, can we try again, and what should the user see? This file provides those answers. It defines the main CodexErr error type, plus smaller error types for network failures, response-stream failures, retry exhaustion, usage limits, missing environment variables, sandbox problems, and unexpected server replies. Without this file, each caller would have to invent its own error wording and retry rules, which would make behavior inconsistent and confusing.

The file also translates internal errors into protocol-facing information. That means a detailed Rust error can become a CodexErrorInfo value or an ErrorEvent that clients can send over the protocol. Think of it like a customer-service desk: it receives messy reports from many departments, classifies them, decides whether retrying makes sense, and writes a message that a person can act on.

Some logic is user-experience focused. Long messages are shortened before display. Sandbox command failures prefer useful stdout or stderr text. Usage-limit errors produce different advice depending on plan type, workspace credit state, and reset time. Unexpected HTTP responses try to extract a clean JSON error message, and they special-case Cloudflare block pages so users get a clearer explanation.

#### Function details

##### `CodexErr::from`  (lines 167–169)

```
fn from(_: CancelErr) -> Self
```

**Purpose**: Turns a cancellation signal into the standard Codex error for an aborted turn. This lets code using a cancellation helper report the same user-facing failure as the rest of the system.

**Data flow**: A CancelErr comes in, but its details are not needed. The function converts it directly into CodexErr::TurnAborted. The result is a normal Codex error that other error-handling code can classify and display.

**Call relations**: This is an automatic conversion used when cancellation-aware code returns an error. Instead of making every caller translate CancelErr by hand, Rust can call this conversion and hand the result to the common CodexErr flow.


##### `CodexErr::is_retryable`  (lines 173–210)

```
fn is_retryable(&self) -> bool
```

**Purpose**: Answers whether an operation that failed with this error should be tried again automatically. It separates temporary problems, like network trouble, from permanent or user-action-required problems, like missing credentials or usage limits.

**Data flow**: A CodexErr goes in. The function checks which kind of error it is and returns true for errors that may succeed later, or false for errors where retrying would likely waste time or repeat the same failure.

**Call relations**: Higher-level loops can ask this function before deciding to retry a turn or request. It does not call other helpers; it acts as the central retry policy for CodexErr.


##### `CodexErr::downcast_ref`  (lines 215–217)

```
fn downcast_ref(&self) -> Option<&T>
```

**Purpose**: Keeps older code working by letting callers ask, 'Is this error actually a specific concrete type?' It mimics a common feature from a previous generic error wrapper.

**Data flow**: The current CodexErr and a requested target type go in. The function views the error as a general 'any type' value and returns a reference if the requested type matches, otherwise nothing.

**Call relations**: Existing callers that used downcast_ref can keep using the same style after CodexErr became the concrete error type. It is a compatibility bridge rather than part of the main error decision flow.


##### `CodexErr::to_codex_protocol_error`  (lines 220–247)

```
fn to_codex_protocol_error(&self) -> CodexErrorInfo
```

**Purpose**: Converts an internal CodexErr into a smaller, client-facing error category. This lets protocol clients react to errors without knowing every internal Rust error variant.

**Data flow**: A detailed CodexErr goes in. The function matches it to a CodexErrorInfo category, sometimes including an HTTP status code taken from the error. A structured protocol error category comes out.

**Call relations**: CodexErr::to_error_event calls this when building an ErrorEvent for clients. It also calls CodexErr::http_status_code_value when the protocol category should carry the related HTTP status.

*Call graph*: calls 1 internal fn (http_status_code_value); called by 1 (to_error_event).


##### `CodexErr::to_error_event`  (lines 249–259)

```
fn to_error_event(&self, message_prefix: Option<String>) -> ErrorEvent
```

**Purpose**: Builds the protocol event that tells a client an error happened. It combines readable text with a structured error category.

**Data flow**: A CodexErr and an optional message prefix go in. The function turns the error into text, prepends the prefix if present, asks for the protocol error category, and returns an ErrorEvent containing both.

**Call relations**: This is the handoff point from internal error handling to protocol messaging. It calls CodexErr::to_codex_protocol_error so the event carries both human-readable wording and machine-readable classification.

*Call graph*: calls 1 internal fn (to_codex_protocol_error); 1 external calls (format!).


##### `CodexErr::http_status_code_value`  (lines 261–270)

```
fn http_status_code_value(&self) -> Option<u16>
```

**Purpose**: Extracts an HTTP status code from errors that came from HTTP communication. This helps other layers report whether a failure was, for example, forbidden, overloaded, or unavailable.

**Data flow**: A CodexErr goes in. If it contains an HTTP status code directly or through a reqwest network error, the function converts that status to a plain number. If there is no HTTP status, it returns nothing.

**Call relations**: CodexErr::to_codex_protocol_error uses this when building protocol error categories that include status codes. Other parts of the system, including from_codex_err and notify_stream_error, also call it when they need the numeric status.

*Call graph*: called by 3 (from_codex_err, notify_stream_error, to_codex_protocol_error).


##### `ConnectionFailedError::fmt`  (lines 279–281)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Creates the readable text for a failed network connection. This is what users or logs see when a request could not connect.

**Data flow**: A ConnectionFailedError containing the original reqwest error goes in. The function writes 'Connection failed' plus the underlying error details into the formatter. The output is a display string.

**Call relations**: Rust calls this formatting function whenever ConnectionFailedError is turned into text, including when CodexErr::ConnectionFailed is displayed.

*Call graph*: 1 external calls (write!).


##### `ResponseStreamFailed::fmt`  (lines 291–301)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Creates the readable text for a response stream that broke while being read. It includes the request id when available, which helps trace the failing server request.

**Data flow**: A ResponseStreamFailed value goes in with a source network error and maybe a request id. The function writes a sentence describing the stream-read failure and appends the request id if present.

**Call relations**: Rust uses this when ResponseStreamFailed is displayed, including through CodexErr::ResponseStreamFailed. It is part of making streaming failures understandable in logs and client messages.

*Call graph*: 1 external calls (write!).


##### `UnexpectedResponseError::display_body`  (lines 320–331)

```
fn display_body(&self) -> String
```

**Purpose**: Chooses the best short explanation from an unexpected server response body. It prefers a clean JSON error message, falls back to trimmed body text, and avoids showing huge pages or payloads.

**Data flow**: An UnexpectedResponseError with a raw body string goes in. The function first tries to extract a JSON error message, then checks for empty text, then truncates long text with an ellipsis. A display-ready body message comes out.

**Call relations**: UnexpectedResponseError::fmt calls this when it needs the body portion of the final error message. This function calls extract_error_message first, and uses truncate_with_ellipsis if the fallback body is too long.

*Call graph*: calls 2 internal fn (extract_error_message, truncate_with_ellipsis); called by 1 (fmt).


##### `UnexpectedResponseError::extract_error_message`  (lines 333–345)

```
fn extract_error_message(&self) -> Option<String>
```

**Purpose**: Looks inside a server response body for a standard JSON error message. This gives users a cleaner message than dumping the whole JSON response.

**Data flow**: The raw response body goes in. The function tries to parse it as JSON, looks for error.message, trims it, and returns it only if it is not empty. If any step fails, it returns nothing.

**Call relations**: UnexpectedResponseError::display_body calls this before using fallback text. It is the first attempt to turn a server response into a helpful human sentence.

*Call graph*: called by 1 (display_body).


##### `UnexpectedResponseError::friendly_message`  (lines 347–375)

```
fn friendly_message(&self) -> Option<String>
```

**Purpose**: Detects one specific confusing case: a Cloudflare block page. When that happens, it returns a clearer explanation that access was blocked, usually because of region restrictions.

**Data flow**: An unexpected response goes in. The function checks whether the status is forbidden and whether the body mentions Cloudflare and blocking. If so, it builds a message with useful details like URL, cf-ray, request id, and authorization error fields. Otherwise it returns nothing.

**Call relations**: UnexpectedResponseError::fmt asks this function first. If it returns a message, that friendly text is used instead of the more generic unexpected-status message.

*Call graph*: called by 1 (fmt); 1 external calls (format!).


##### `UnexpectedResponseError::fmt`  (lines 379–403)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Creates the full readable text for an unexpected HTTP response. It includes the status, a useful body message, and extra tracing details when present.

**Data flow**: An UnexpectedResponseError goes in. The function first asks for a friendly special-case message. If none exists, it builds a generic message from the status and display body, then appends fields such as URL, cf-ray, request id, and identity error details.

**Call relations**: Rust calls this whenever UnexpectedResponseError is displayed, including through CodexErr::UnexpectedStatus. It coordinates friendly_message and display_body to produce the final text.

*Call graph*: calls 2 internal fn (display_body, friendly_message); 2 external calls (format!, write!).


##### `truncate_with_ellipsis`  (lines 408–420)

```
fn truncate_with_ellipsis(text: &str, max_bytes: usize) -> String
```

**Purpose**: Shortens long text to a byte limit and adds '...' at the end. It is careful not to cut a multi-byte character in half, which would make invalid text.

**Data flow**: A text string and maximum byte count go in. If the text already fits, it is returned unchanged. Otherwise the cut point is moved back to a safe character boundary, the text is sliced, and an ellipsis is appended.

**Call relations**: UnexpectedResponseError::display_body calls this when a raw response body is too long to show in full. It keeps error messages readable without corrupting characters.

*Call graph*: called by 1 (display_body).


##### `truncate_text`  (lines 422–427)

```
fn truncate_text(content: &str, policy: TruncationPolicy) -> String
```

**Purpose**: Applies the selected truncation rule to a piece of text. The rule can be based on bytes or on a token budget, where tokens are chunks of text used by language models.

**Data flow**: A content string and a TruncationPolicy go in. For a byte policy, the function shortens the middle by character count. For a token policy, it shortens using the token-budget helper and returns the shortened text.

**Call relations**: get_error_message_ui calls this before showing error text in the user interface. It delegates the actual shortening to shared string utilities.

*Call graph*: called by 1 (get_error_message_ui); 2 external calls (truncate_middle_chars, truncate_middle_with_token_budget).


##### `RetryLimitReachedError::fmt`  (lines 436–446)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Creates the readable text for a request that failed too many times. It includes the last HTTP status and, if available, the request id.

**Data flow**: A RetryLimitReachedError goes in with a status and optional request id. The function writes a message saying the retry limit was exceeded and appends the request id when present.

**Call relations**: Rust uses this when RetryLimitReachedError is displayed, including through CodexErr::RetryLimit. That text can appear in logs, protocol events, or user-facing errors.

*Call graph*: 1 external calls (write!).


##### `UsageLimitReachedError::fmt`  (lines 459–553)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Creates the user-facing message shown when the user or workspace has hit a usage limit. It tries to give practical next steps instead of just saying 'limit reached.'

**Data flow**: A UsageLimitReachedError goes in with optional plan information, reset time, rate-limit details, promo text, and workspace-limit type. The function chooses the most specific message it can, such as adding credits, asking an owner, upgrading a plan, buying more credits, or waiting until reset.

**Call relations**: Rust calls this whenever UsageLimitReachedError is displayed, including through CodexErr::UsageLimitReached. Its wording feeds into normal error strings and UI messages.

*Call graph*: 2 external calls (format!, write!).


##### `retry_suffix`  (lines 556–563)

```
fn retry_suffix(resets_at: Option<&DateTime<Utc>>) -> String
```

**Purpose**: Builds the ending sentence for messages where the only advice is to try again later or at a known reset time.

**Data flow**: An optional reset timestamp goes in. If a timestamp exists, the function formats it for local display and returns 'Try again at ...'. If not, it returns 'Try again later.'

**Call relations**: Usage-limit message building uses this style of wording when there is no alternative action to offer. It calls format_retry_timestamp when a reset time is available.

*Call graph*: calls 1 internal fn (format_retry_timestamp); 1 external calls (format!).


##### `retry_suffix_after_or`  (lines 565–572)

```
fn retry_suffix_after_or(resets_at: Option<&DateTime<Utc>>) -> String
```

**Purpose**: Builds the ending phrase for messages that offer another action first, then say the user can also wait. For example, upgrade now, or try again at a reset time.

**Data flow**: An optional reset timestamp goes in. If present, it formats the timestamp and returns 'or try again at ...'. If absent, it returns 'or try again later.'

**Call relations**: Usage-limit messages use this when the main message suggests an action like switching model, upgrading, or asking an admin. It calls format_retry_timestamp when it has an exact reset time.

*Call graph*: calls 1 internal fn (format_retry_timestamp); 1 external calls (format!).


##### `format_retry_timestamp`  (lines 574–585)

```
fn format_retry_timestamp(resets_at: &DateTime<Utc>) -> String
```

**Purpose**: Turns a UTC reset time into a local, friendly time string. If the reset is today, it shows only the time; otherwise it includes the date and year.

**Data flow**: A UTC DateTime goes in. The function converts it and the current time to the local timezone, compares their dates, and formats either a same-day time or a full date with an ordinal day suffix like 'st' or 'th'.

**Call relations**: retry_suffix and retry_suffix_after_or call this to make reset times readable. It calls now_for_retry to know what 'today' means and day_suffix to format dates nicely.

*Call graph*: calls 2 internal fn (day_suffix, now_for_retry); called by 2 (retry_suffix, retry_suffix_after_or); 2 external calls (with_timezone, format!).


##### `day_suffix`  (lines 587–597)

```
fn day_suffix(day: u32) -> &'static str
```

**Purpose**: Returns the English suffix for a day of the month, such as 'st' for 1 or 'th' for 11. This makes formatted dates read naturally.

**Data flow**: A day number goes in. The function checks the special 11 through 13 case, then uses the final digit to choose 'st', 'nd', 'rd', or 'th'. The suffix string comes out.

**Call relations**: format_retry_timestamp calls this when it needs to show a full date for a reset time. It is a small helper for friendlier usage-limit messages.

*Call graph*: called by 1 (format_retry_timestamp).


##### `now_for_retry`  (lines 605–613)

```
fn now_for_retry() -> DateTime<Utc>
```

**Purpose**: Provides the current time for retry-time formatting. In tests, it can return a fixed time so date formatting is predictable.

**Data flow**: No input is needed. In test builds, the function first checks whether a test override exists and returns it. Otherwise it returns the real current UTC time.

**Call relations**: format_retry_timestamp calls this to compare the reset time with 'now.' The test-only override lets error message tests avoid depending on the actual clock.

*Call graph*: called by 1 (format_retry_timestamp); 1 external calls (now).


##### `EnvVarError::fmt`  (lines 625–631)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Creates the readable text for a missing environment variable. It can include extra instructions that tell the user how to fix the problem.

**Data flow**: An EnvVarError goes in with a variable name and optional instructions. The function writes a message naming the missing variable, then appends the instructions if they exist.

**Call relations**: Rust uses this whenever EnvVarError is displayed, including through CodexErr::EnvVar. It turns a configuration problem into a message a user can act on.

*Call graph*: 1 external calls (write!).


##### `get_error_message_ui`  (lines 634–668)

```
fn get_error_message_ui(e: &CodexErr) -> String
```

**Purpose**: Produces the error text that is safe and useful to show in the user interface. It gives special treatment to sandbox command failures so users see the command output rather than a generic wrapper message.

**Data flow**: A CodexErr goes in. If it is a denied sandbox command, the function chooses aggregated output first, then stderr and stdout, then a fallback exit-code message. If it is a sandbox timeout, it reports the timeout duration. For all other errors, it uses the normal error text. Finally it truncates the message to the UI byte limit and returns it.

**Call relations**: UI-facing code can call this instead of directly displaying CodexErr. It calls truncate_text so large command output or server messages do not overwhelm the interface.

*Call graph*: calls 1 internal fn (truncate_text); 3 external calls (format!, to_string, Bytes).


### `protocol/src/mcp.rs`

`data_model` · `cross-cutting protocol conversion and serialization`

The Model Context Protocol, or MCP, is a way for external servers to tell Codex what tools they offer and what resources they can read. This file is the shared dictionary Codex uses for those MCP ideas inside its own protocol. Without it, different parts of Codex could disagree about what a “tool” or “resource” looks like, and generated TypeScript or JSON schema definitions might drift away from the Rust types.

Most of the file is made of plain data types. For example, a Tool has a name, optional title and description, an input schema, and optional metadata. A Resource describes something readable, such as a file-like item with a URI, name, optional size, and MIME type. These types are designed to serialize cleanly to JSON and to generate TypeScript and JSON Schema, so Rust code and client-side code can speak the same language.

The file also includes adapter helpers. These accept “wire-shaped” MCP JSON, meaning JSON as it arrives from an MCP server or another MCP library, and convert it into Codex’s friendly protocol types. The adapters tolerate both camelCase names like inputSchema and snake_case names like input_schema. One important detail is resource size parsing: it keeps valid large 64-bit sizes, including negative values, but safely drops numbers too large to fit.

#### Function details

##### `RequestId::fmt`  (lines 21–26)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This makes a request ID printable as text. A request ID can be either a string or a number, and this function decides how to display whichever form it has.

**Data flow**: It receives a RequestId and a formatter, which is Rust’s destination for formatted text. If the ID is a string, it writes that string directly. If the ID is an integer, it formats the number. The result is either success or a formatting error from the output destination.

**Call relations**: This is used whenever normal Rust formatting asks a RequestId to turn itself into text, such as for logs, messages, or debugging output. For string IDs it hands the text to the formatter’s string-writing routine; for integer IDs it lets the integer formatting code do the work.

*Call graph*: 1 external calls (write_str).


##### `deserialize_lossy_opt_i64`  (lines 171–187)

```
fn deserialize_lossy_opt_i64(deserializer: D) -> Result<Option<i64>, D::Error>
```

**Purpose**: This reads an optional JSON number and tries to turn it into an optional 64-bit signed integer. It is deliberately forgiving: numbers that cannot fit are treated as missing instead of crashing the whole conversion.

**Data flow**: It receives a JSON deserializer positioned at a value that may be absent or may be a number. It first reads that value as an optional JSON number. If the number is already a signed 64-bit integer, it keeps it. If it is an unsigned 64-bit integer, it tries to fit it into a signed 64-bit integer. If the value is absent, fractional, or too large, the output is None.

**Call relations**: This helper is used by the private ResourceSerde adapter when reading a resource’s size field. It relies on serde’s deserialization to read the raw JSON number, then uses integer conversion to avoid silently narrowing or wrapping large values.

*Call graph*: 2 external calls (deserialize, try_from).


##### `Tool::from`  (lines 210–231)

```
fn from(value: ToolSerde) -> Self
```

**Purpose**: This converts the private, flexible ToolSerde adapter shape into the public Tool type used by the Codex protocol. It is a clean handoff from “JSON we accepted” to “data structure the rest of Codex expects.”

**Data flow**: It receives a ToolSerde value containing the tool’s name, optional display fields, input and output schemas, annotations, icons, and metadata. It unpacks those fields and builds a Tool with the same information. Nothing is changed except the wrapper type.

**Call relations**: This function is called after MCP-shaped JSON has already been deserialized into ToolSerde. In the larger flow, Tool::from_mcp_value reads raw JSON into ToolSerde, then hands it here to produce the final Tool.


##### `Resource::from`  (lines 256–279)

```
fn from(value: ResourceSerde) -> Self
```

**Purpose**: This converts the private, flexible ResourceSerde adapter shape into the public Resource type. It preserves the resource details after the JSON-specific cleanup has already happened.

**Data flow**: It receives a ResourceSerde value with fields such as name, URI, optional MIME type, optional size, icons, and metadata. It moves those fields into a Resource. The result is the public resource representation used elsewhere in the protocol.

**Call relations**: This sits between loose incoming MCP JSON and Codex’s stable Resource type. Resource::from_mcp_value first deserializes JSON into ResourceSerde, including the special size parsing, then uses this conversion to finish the handoff.


##### `ResourceTemplate::from`  (lines 299–316)

```
fn from(value: ResourceTemplateSerde) -> Self
```

**Purpose**: This converts the private ResourceTemplateSerde adapter shape into the public ResourceTemplate type. A resource template describes a pattern for resources a server can provide.

**Data flow**: It receives a ResourceTemplateSerde value with a URI template, name, and optional title, description, MIME type, and annotations. It copies those pieces into a ResourceTemplate and returns it. The content stays the same; only the type changes.

**Call relations**: This is the final step after resource-template JSON has been accepted in the adapter form. ResourceTemplate::from_mcp_value deserializes the raw JSON, then hands the adapter value here so callers receive the public protocol type.


##### `Tool::from_mcp_value`  (lines 320–322)

```
fn from_mcp_value(value: serde_json::Value) -> Result<Self, serde_json::Error>
```

**Purpose**: This turns raw MCP JSON for a tool into Codex’s Tool type. Callers use it when they have JSON from an MCP source and want a strongly shaped protocol value.

**Data flow**: It receives a serde_json::Value, which is a generic JSON value. It tries to deserialize that JSON into ToolSerde, a private shape that accepts field-name variations such as inputSchema and input_schema. If that succeeds, it converts the adapter into Tool and returns it. If the JSON is missing required fields or has the wrong types, it returns a JSON error.

**Call relations**: This is called by protocol_tool_from_rmcp_tool when another part of the system is adapting tool data from an MCP library into the Codex protocol. Inside this function, the raw JSON is first parsed into ToolSerde and then passed through Tool::from.

*Call graph*: called by 1 (protocol_tool_from_rmcp_tool).


##### `Resource::from_mcp_value`  (lines 326–328)

```
fn from_mcp_value(value: serde_json::Value) -> Result<Self, serde_json::Error>
```

**Purpose**: This turns raw MCP JSON for a resource into Codex’s Resource type. It is especially careful with the resource size field, which can be a large JSON number.

**Data flow**: It receives a generic JSON value. It deserializes it into ResourceSerde, accepting field-name variations like mimeType and mime_type and using the forgiving size parser. Then it converts that adapter value into a Resource. On valid input it returns the Resource; on invalid required fields it returns a JSON error.

**Call relations**: This is used by resource_from_rmcp when resource data is adapted from an MCP library. It is also used by the test in this file to prove that large, negative, and too-large size values behave as intended.

*Call graph*: called by 2 (resource_from_rmcp, resource_size_deserializes_without_narrowing).


##### `ResourceTemplate::from_mcp_value`  (lines 332–334)

```
fn from_mcp_value(value: serde_json::Value) -> Result<Self, serde_json::Error>
```

**Purpose**: This turns raw MCP JSON for a resource template into Codex’s ResourceTemplate type. It lets incoming JSON use either common MCP camelCase names or snake_case aliases for selected fields.

**Data flow**: It receives a generic JSON value. It tries to deserialize that JSON into ResourceTemplateSerde, which accepts names like uriTemplate and uri_template. If parsing succeeds, it converts the adapter into ResourceTemplate and returns it; otherwise it returns a JSON error.

**Call relations**: This is the public conversion entry for resource-template JSON in this file. It follows the same pattern as the tool and resource converters: parse into a tolerant private adapter, then convert into the stable public protocol type.


##### `tests::resource_size_deserializes_without_narrowing`  (lines 344–371)

```
fn resource_size_deserializes_without_narrowing()
```

**Purpose**: This test checks that resource sizes are read safely and accurately. It protects against bugs where a large JSON number might be accidentally shrunk, wrapped, or rejected incorrectly.

**Data flow**: It builds three example JSON resources. The first has a large unsigned size that still fits in a signed 64-bit integer, and the test expects that exact value. The second has a negative size, and the test expects it to be preserved. The third has the largest unsigned 64-bit value, which is too big for a signed 64-bit integer, and the test expects the parsed size to become None.

**Call relations**: During test runs, this function calls Resource::from_mcp_value with each example resource. It then uses assertions to compare the parsed size against the expected result, confirming that the adapter helper for optional 64-bit sizes behaves correctly.

*Call graph*: calls 1 internal fn (from_mcp_value); 2 external calls (assert_eq!, json!).


### `protocol/src/memory_citation.rs`

`data_model` · `cross-cutting`

This file is a small data definition shared by different parts of the system. It does not run logic itself. Instead, it says what information must be carried when the system wants to cite stored memory or source context.

A `MemoryCitation` is like a bibliography entry for the system’s memory. It contains two lists: detailed citation entries, and rollout IDs that identify related runs or versions. Each `MemoryCitationEntry` points to one concrete place: a path, a starting line, an ending line, and a short note.

The extra derive annotations make this data easy to move between languages and tools. It can be converted to and from JSON using Serde, described as a JSON Schema for validation or documentation, and exported as a TypeScript type so frontend or API clients can use the same structure. The `camelCase` setting means fields like `line_start` become `lineStart` in JSON, matching common web API style.

Without this file, different parts of the project might invent incompatible ways to describe citations, making memory references harder to validate, display, or exchange across Rust, JSON, and TypeScript boundaries.


### `protocol/src/network_policy.rs`

`data_model` · `request handling`

When the project needs to decide whether some network access should happen, it needs a small, reliable packet of information: what the decision was, where that decision came from, and any extra details such as the host, port, reason, or approval protocol. This file defines that packet as `NetworkPolicyDecisionPayload`.

The struct is designed to be read from serialized data, such as JSON. The `serde` settings say that incoming field names use `camelCase`, which is common in JSON, while Rust code uses its usual style internally. Some fields are always expected, like the decision itself and its source. Others are optional, because not every decision needs a host, port, reason, or protocol attached.

A small helper method, `is_ask_from_decider`, answers one important question: “Is this specifically a request to ask for approval, coming from the policy decider?” That matters because the rest of the system may treat that case differently, for example by building a user-facing network approval context. In everyday terms, this file is like a standardized form for a security checkpoint: it records the verdict, who gave it, and any notes needed to explain or act on it.

#### Function details

##### `NetworkPolicyDecisionPayload::is_ask_from_decider`  (lines 19–21)

```
fn is_ask_from_decider(&self) -> bool
```

**Purpose**: This function checks whether the payload means “ask for approval” and whether that request came from the network policy decider. It is a convenience check for code that only cares about that exact situation.

**Data flow**: It reads the payload’s `decision` and `source` fields. If the decision is `Ask` and the source is `Decider`, it returns `true`; otherwise it returns `false`. It does not change the payload or any outside state.

**Call relations**: When `network_approval_context_from_payload` is turning a decision payload into an approval context, it calls this helper to recognize the special case where the decider is asking for permission. This method does the narrow yes-or-no test, and the caller decides what to build from that answer.

*Call graph*: called by 1 (network_approval_context_from_payload).


### `protocol/src/openai_models.rs`

`data_model` · `cross-cutting: config load, model listing, request building, and tests`

Codex needs many parts of the system to agree on what a model can do: whether it accepts images, which reasoning levels it supports, which shell tools it may use, how large its context window is, and how it should appear in a model picker. This file is the common contract for that information. It is like a menu shared by the kitchen, waiter, and customer: everyone sees the same model names, options, and limits.

Most of the file is made of data types that can be turned into JSON and TypeScript definitions, so Rust services and front-end clients can speak the same language. It also includes careful defaults for older payloads. For example, if older model data does not mention input modalities, the code assumes both text and images are supported. That keeps newer clients from breaking when talking to older services.

The behavior here is small but important. It converts backend model records into UI presets, chooses safe compaction limits based on context windows, builds model instructions with optional personality text, filters models based on authentication mode, and hides unknown future selector values instead of failing. Without this file, model selection and request building would drift between components, causing missing models, bad defaults, or rejected requests.

#### Function details

##### `ReasoningEffort::as_str`  (lines 54–64)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the exact text value used to represent a reasoning effort in JSON, logs, and requests. This keeps built-in values like `high` and future custom values from being renamed accidentally.

**Data flow**: It takes a `ReasoningEffort` value already in memory, matches it to its wire-format text, and returns that text as a borrowed string. Nothing is changed.

**Call relations**: The display and serialization code call this when they need a reasoning effort to leave Rust as plain text.

*Call graph*: called by 2 (fmt, serialize).


##### `ReasoningEffort::fmt`  (lines 68–70)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Lets a reasoning effort be printed as readable text. This is what makes formatting or logging a value show `medium` instead of a Rust enum debug form.

**Data flow**: It receives the effort and a formatter, asks `as_str` for the correct text, and writes that text into the formatter. The output is the formatter result.

**Call relations**: Rust's formatting machinery calls this when code displays a `ReasoningEffort`; it delegates the actual wording to `ReasoningEffort::as_str`.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `ReasoningEffort::schema_name`  (lines 74–76)

```
fn schema_name() -> String
```

**Purpose**: Provides the name used for this type in generated JSON schemas. A JSON schema is a machine-readable description of valid JSON data.

**Data flow**: It takes no model data and returns the fixed schema name `ReasoningEffort`. Nothing else changes.

**Call relations**: Schema generation tools call this while producing shared API/type documentation.


##### `ReasoningEffort::json_schema`  (lines 78–93)

```
fn json_schema(_generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Describes reasoning effort as an open, non-empty string in generated schemas. This matters because servers may advertise new effort names before this client knows them.

**Data flow**: It receives a schema generator, builds a schema object that says the JSON value must be a string of at least one character, and returns that schema.

**Call relations**: Schema generation calls this instead of treating reasoning effort as a closed list. That matches `from_str`, which accepts custom future values.

*Call graph*: 3 external calls (new, default, Object).


##### `ReasoningEffort::serialize`  (lines 97–102)

```
fn serialize(&self, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Turns a reasoning effort into the string that should appear in JSON or other serialized data. Serialization means converting in-memory data into a format that can be sent or stored.

**Data flow**: It receives a `ReasoningEffort`, asks `as_str` for its wire value, and gives that string to the serializer. The result is serialized output or an error from the serializer.

**Call relations**: Serde, the Rust serialization library, calls this whenever model metadata containing a reasoning effort is sent across process or service boundaries.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (serialize_str).


##### `ReasoningEffort::deserialize`  (lines 106–112)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads a reasoning effort from incoming text. It accepts known values and custom future values, but rejects an empty string.

**Data flow**: It reads a string from the deserializer, parses it with `FromStr`, and returns a `ReasoningEffort` or a readable parsing error.

**Call relations**: Serde calls this when model metadata arrives from JSON. It hands the interpretation of the text to `ReasoningEffort::from_str`.

*Call graph*: 1 external calls (deserialize).


##### `ReasoningEffort::from_str`  (lines 118–129)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Converts raw text like `low`, `high`, or `max` into a `ReasoningEffort`. Unknown non-empty text is preserved as `Custom` so newer server values do not break older clients.

**Data flow**: It receives a string slice, checks it against known names, rejects an empty string, and returns either a known variant or a custom value containing the original text.

**Call relations**: Deserialization and tests rely on this as the central rule for accepting reasoning effort text.

*Call graph*: 1 external calls (Custom).


##### `default_input_modalities`  (lines 160–162)

```
fn default_input_modalities() -> Vec<InputModality>
```

**Purpose**: Supplies the backward-compatible default list of user input types a model can accept: text and images. This protects older model payloads that were created before modality metadata existed.

**Data flow**: It takes no input and returns a new vector containing `Text` and `Image`. It does not read or change external state.

**Call relations**: Serde uses this default when `input_modalities` is missing. Many model and prompt tests also call it to build realistic model metadata.

*Call graph*: called by 43 (preset_to_info, drop_last_n_user_turns_clears_reference_context_for_mixed_developer_context_bundles, drop_last_n_user_turns_ignores_session_prefix_user_messages, drop_last_n_user_turns_preserves_prefix, drop_last_n_user_turns_trims_context_updates_above_rolled_back_turn, for_prompt_strips_images_when_model_does_not_support_images, normalization_retains_local_shell_outputs, normalize_adds_missing_output_for_custom_tool_call, normalize_adds_missing_output_for_custom_tool_call_panics_in_debug, normalize_adds_missing_output_for_function_call (+15 more)); 1 external calls (vec!).


##### `deserialize_optional_model_selector`  (lines 305–314)

```
fn deserialize_optional_model_selector(deserializer: D) -> Result<Option<T>, D::Error>
```

**Purpose**: Reads an optional selector field, such as tool mode or multi-agent version, while safely ignoring unknown future values. This prevents one unfamiliar server value from breaking the whole model catalog.

**Data flow**: It tries to read an optional string. If no string is present, it returns `None`; if a string is present, it attempts to deserialize that string into the requested selector type and returns `Some` only when that succeeds.

**Call relations**: Serde uses this helper for optional model selector fields on `ModelInfo`, so request-building code sees either a known value or no value.

*Call graph*: 3 external calls (deserialize, String, from_value).


##### `TruncationPolicyConfig::bytes`  (lines 323–328)

```
fn bytes(limit: i64) -> Self
```

**Purpose**: Creates a truncation policy measured in bytes. A truncation policy tells the system when stored or sent content must be shortened.

**Data flow**: It receives a numeric limit, pairs it with the `Bytes` mode, and returns a new `TruncationPolicyConfig`.

**Call relations**: Model-building code and many tests call this when they need a model configuration with byte-based limits.

*Call graph*: called by 19 (preset_to_info, remote_model_with_auto_review_override, model_switch_to_smaller_model_updates_token_context_window, test_model_info, test_remote_model, remote_model_friendly_personality_instructions_with_feature, user_turn_personality_remote_model_template_includes_update_message, remote_models_apply_remote_base_instructions, remote_models_get_model_info_uses_longest_matching_prefix, remote_models_long_model_slug_is_sent_with_custom_reasoning (+9 more)).


##### `TruncationPolicyConfig::tokens`  (lines 330–335)

```
fn tokens(limit: i64) -> Self
```

**Purpose**: Creates a truncation policy measured in tokens. Tokens are the chunks of text a model counts for its context limit.

**Data flow**: It receives a numeric limit, pairs it with the `Tokens` mode, and returns a new `TruncationPolicyConfig`.

**Call relations**: Configuration override and model helper code call this when token-based limits are needed.

*Call graph*: called by 2 (with_config_overrides, model_with_shell_type).


##### `default_effective_context_window_percent`  (lines 342–344)

```
fn default_effective_context_window_percent() -> i64
```

**Purpose**: Provides the default percentage of a model's context window that Codex treats as usable for input. The remaining space is reserved for prompts, tools, and model output.

**Data flow**: It takes no input and returns the fixed value `95`. Nothing else changes.

**Call relations**: Serde uses this default when older `ModelInfo` payloads omit the field.


##### `ModelInfo::resolved_context_window`  (lines 429–431)

```
fn resolved_context_window(&self) -> Option<i64>
```

**Purpose**: Chooses the best available context window value for a model. The context window is how much text and tool data can fit in one model request.

**Data flow**: It reads `context_window` first; if that is missing, it falls back to `max_context_window`. It returns the chosen number or `None` if neither exists.

**Call relations**: Context-window lookup, request input building, and auto-compaction logic call this when they need the model's effective size limit.

*Call graph*: called by 3 (model_context_window, build_stage_one_input_message, auto_compact_token_limit).


##### `ModelInfo::auto_compact_token_limit`  (lines 433–444)

```
fn auto_compact_token_limit(&self) -> Option<i64>
```

**Purpose**: Calculates the token threshold where Codex should automatically compact, or shorten, conversation history. It keeps the threshold safely below the model's full context window.

**Data flow**: It reads the resolved context window and any configured compaction limit. If a context window exists, it caps the configured limit at 90 percent of that window; otherwise it returns the configured limit as-is.

**Call relations**: This builds on `resolved_context_window` and is used by code deciding when a conversation has grown too large.

*Call graph*: calls 1 internal fn (resolved_context_window).


##### `ModelInfo::supports_personality`  (lines 446–450)

```
fn supports_personality(&self) -> bool
```

**Purpose**: Reports whether this model has enough instruction-template data to support personality-specific behavior. Personality here means optional style choices such as friendly or pragmatic.

**Data flow**: It checks whether `model_messages` exists and asks it whether personality support is complete. It returns true or false without changing the model.

**Call relations**: `ModelPreset::from` calls this while turning backend model data into picker-friendly model presets.

*Call graph*: called by 1 (from).


##### `ModelInfo::get_model_instructions`  (lines 452–471)

```
fn get_model_instructions(&self, personality: Option<Personality>) -> String
```

**Purpose**: Builds the final instruction text to send to a model, optionally inserting personality-specific wording. If no usable template exists, it falls back to the model's base instructions.

**Data flow**: It reads the model's message template, personality variables, requested personality, and base instructions. With a template, it replaces the `{{ personality }}` placeholder with the matching personality message or an empty string; without a template, it returns the base instructions and logs a warning if a personality was requested.

**Call relations**: Request-building code can call this when preparing system or developer instructions for a remote model. It relies on `ModelMessages::get_personality_message` through the model message object.

*Call graph*: 1 external calls (warn!).


##### `ModelMessages::has_personality_placeholder`  (lines 483–488)

```
fn has_personality_placeholder(&self) -> bool
```

**Purpose**: Checks whether an instruction template contains the special placeholder where personality text should be inserted.

**Data flow**: It reads the optional instruction template. If present, it searches for `{{ personality }}`; if absent, it returns false.

**Call relations**: `ModelMessages::supports_personality` uses this as the first requirement for saying a model can support personality instructions.

*Call graph*: called by 1 (supports_personality).


##### `ModelMessages::supports_personality`  (lines 490–496)

```
fn supports_personality(&self) -> bool
```

**Purpose**: Determines whether the model message template is ready for personality support. It requires both a placeholder and a complete set of personality messages.

**Data flow**: It checks for the placeholder and then checks whether the attached variables include all required personality strings. It returns a boolean.

**Call relations**: `ModelInfo::supports_personality` calls this when higher-level model metadata needs a simple yes-or-no answer.

*Call graph*: calls 1 internal fn (has_personality_placeholder).


##### `ModelMessages::get_personality_message`  (lines 498–502)

```
fn get_personality_message(&self, personality: Option<Personality>) -> Option<String>
```

**Purpose**: Finds the text snippet that should be inserted for a requested personality. It returns nothing if the variables are missing or do not contain the requested text.

**Data flow**: It reads optional instruction variables, asks them for the matching personality message, and returns that optional string.

**Call relations**: `ModelInfo::get_model_instructions` uses this path when filling an instruction template.


##### `ModelInstructionsVariables::is_complete`  (lines 513–517)

```
fn is_complete(&self) -> bool
```

**Purpose**: Checks whether all personality text options are present. This is used to decide whether personality support can be advertised confidently.

**Data flow**: It reads the default, friendly, and pragmatic message fields and returns true only if all three are present.

**Call relations**: `ModelMessages::supports_personality` calls this after confirming the template has a personality placeholder.


##### `ModelInstructionsVariables::get_personality_message`  (lines 519–529)

```
fn get_personality_message(&self, personality: Option<Personality>) -> Option<String>
```

**Purpose**: Returns the exact personality text for a requested style. A request for `None` personality deliberately returns an empty string, while no requested personality uses the default text.

**Data flow**: It receives an optional personality choice. Friendly and pragmatic return their configured strings, `Personality::None` returns an empty string, and no personality returns the default string.

**Call relations**: `ModelMessages::get_personality_message` delegates to this when assembling model instructions.

*Call graph*: 1 external calls (new).


##### `ModelInfoUpgrade::from`  (lines 539–544)

```
fn from(upgrade: &ModelUpgrade) -> Self
```

**Purpose**: Converts a richer `ModelUpgrade` record into the smaller upgrade shape used in `ModelInfo`. This keeps only the target model and migration text.

**Data flow**: It reads the upgrade id and optional migration markdown, clones them, fills missing markdown with an empty string, and returns a `ModelInfoUpgrade`.

**Call relations**: Rust conversion code can use this when backend or catalog upgrade data must be expressed in the `ModelInfo` format.


##### `ModelPreset::from`  (lines 555–584)

```
fn from(info: ModelInfo) -> Self
```

**Purpose**: Turns backend-facing `ModelInfo` into a simpler `ModelPreset` used for model pickers and local configuration. It preserves user-facing details while reshaping fields into the older preset format.

**Data flow**: It consumes a `ModelInfo`, reads fields such as slug, display name, reasoning options, visibility, upgrade, service tiers, and modalities, computes personality support, and returns a new `ModelPreset`.

**Call relations**: Model list building and tests call this conversion after receiving model metadata, before filtering or marking defaults for the UI.

*Call graph*: calls 1 internal fn (supports_personality); called by 3 (build_available_models_picks_default_after_hiding_hidden_models, model_preset_preserves_availability_nux, model_preset_supports_fast_mode_from_service_tiers).


##### `ModelPreset::supports_fast_mode`  (lines 588–596)

```
fn supports_fast_mode(&self) -> bool
```

**Purpose**: Checks whether a preset offers fast mode. It supports both the newer service-tier list and the older additional-speed-tier field.

**Data flow**: It scans the preset's service tiers for the fast service tier id, then scans legacy speed tiers for `fast`. It returns true if either path says fast mode is available.

**Call relations**: UI and model-selection code can call this when deciding whether to show or request fast processing.


##### `ModelInfo::supports_service_tier`  (lines 600–604)

```
fn supports_service_tier(&self, service_tier: &str) -> bool
```

**Purpose**: Checks whether a backend model explicitly supports a requested service tier. Service tiers are named request options such as faster processing.

**Data flow**: It receives a tier id string, scans the model's service tier list, and returns true if any tier has the same id.

**Call relations**: `ModelInfo::service_tier_for_request` uses this to avoid sending unsupported tier names in requests.


##### `ModelInfo::service_tier_for_request`  (lines 606–611)

```
fn service_tier_for_request(&self, service_tier: Option<String>) -> Option<String>
```

**Purpose**: Decides whether a requested service tier should actually be sent to the backend. It omits the special default marker and any tier the model does not support.

**Data flow**: It receives an optional requested tier. If the value is missing, is the special default request value, or is unsupported, it returns `None`; otherwise it returns the tier string.

**Call relations**: Request-building code calls this before building a responses request, so the backend receives only meaningful, supported service tier overrides.

*Call graph*: called by 1 (build_responses_request).


##### `ModelPreset::filter_by_auth`  (lines 618–623)

```
fn filter_by_auth(models: Vec<ModelPreset>, chatgpt_mode: bool) -> Vec<ModelPreset>
```

**Purpose**: Filters model presets according to the user's authentication mode. ChatGPT mode can show all models, while API mode shows only models marked as API-supported.

**Data flow**: It consumes a list of presets and a boolean saying whether ChatGPT mode is active. It keeps every model in ChatGPT mode, or only `supported_in_api` models otherwise, and returns the filtered list.

**Call relations**: Available-model-building code calls this before presenting model choices to users.

*Call graph*: called by 2 (expected_visible_models, build_available_models).


##### `ModelPreset::mark_default_by_picker_visibility`  (lines 628–637)

```
fn mark_default_by_picker_visibility(models: &mut [ModelPreset])
```

**Purpose**: Ensures exactly one model preset is marked as the default choice. It prefers the first model visible in the picker, falling back to the first model if none are visible.

**Data flow**: It receives a mutable slice of presets, clears every `is_default` flag, then sets one chosen preset's flag to true if any preset exists.

**Call relations**: Model-list building and expected-model tests call this after filtering so the UI has a clear default selection.

*Call graph*: called by 3 (expected_visible_models, list_models_uses_chatgpt_remote_catalog_as_source_of_truth, build_available_models); 2 external calls (first_mut, iter_mut).


##### `tests::test_model`  (lines 647–688)

```
fn test_model(spec: Option<ModelMessages>) -> ModelInfo
```

**Purpose**: Builds a complete sample `ModelInfo` for tests. This avoids repeating a long list of required model fields in every test case.

**Data flow**: It receives optional model messages, fills the rest of the model fields with stable test values and defaults, and returns the constructed `ModelInfo`.

**Call relations**: Many tests call this helper, then override only the fields relevant to the behavior being checked.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); 2 external calls (new, vec!).


##### `tests::personality_variables`  (lines 690–696)

```
fn personality_variables() -> ModelInstructionsVariables
```

**Purpose**: Creates a complete set of sample personality messages for tests. It gives tests known text for default, friendly, and pragmatic personalities.

**Data flow**: It takes no input and returns `ModelInstructionsVariables` with all three personality message fields populated.

**Call relations**: Personality-related tests call this helper before checking instruction assembly and message lookup.


##### `tests::reasoning_effort_accepts_known_and_custom_values`  (lines 699–721)

```
fn reasoning_effort_accepts_known_and_custom_values()
```

**Purpose**: Verifies that reasoning effort parsing and serialization work for both known values and future custom values. This protects backward and forward compatibility.

**Data flow**: It creates a custom effort, deserializes `max`, serializes the custom value, parses known and custom strings, and asserts that all results match expectations.

**Call relations**: This test exercises `ReasoningEffort::from_str`, `ReasoningEffort::deserialize`, `ReasoningEffort::serialize`, and display formatting together.

*Call graph*: 3 external calls (assert_eq!, Custom, to_string).


##### `tests::reasoning_effort_rejects_empty_values`  (lines 724–729)

```
fn reasoning_effort_rejects_empty_values()
```

**Purpose**: Checks that an empty reasoning effort string is not accepted. Empty text would be ambiguous and unsafe as a model-advertised option.

**Data flow**: It tries to parse an empty string and asserts that the expected error message is returned.

**Call relations**: This directly protects the validation rule inside `ReasoningEffort::from_str`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::reasoning_effort_json_schema_is_an_open_string`  (lines 732–752)

```
fn reasoning_effort_json_schema_is_an_open_string()
```

**Purpose**: Confirms the generated schema describes reasoning effort as any non-empty string, not a fixed list. This matches the custom-value behavior.

**Data flow**: It builds a schema generator, asks `ReasoningEffort` for its schema, and compares the result to the expected string schema.

**Call relations**: This test guards `ReasoningEffort::json_schema` against becoming too restrictive.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::get_model_instructions_uses_template_when_placeholder_present`  (lines 755–764)

```
fn get_model_instructions_uses_template_when_placeholder_present()
```

**Purpose**: Checks that model instructions use the template and insert the requested personality text. This proves the happy path for personality-aware instructions.

**Data flow**: It builds a test model with a template containing the personality placeholder, requests friendly instructions, and asserts that `friendly` was inserted.

**Call relations**: This test exercises `ModelInfo::get_model_instructions` with complete personality variables from `tests::personality_variables`.

*Call graph*: 3 external calls (assert_eq!, personality_variables, test_model).


##### `tests::get_model_instructions_always_strips_placeholder`  (lines 767–817)

```
fn get_model_instructions_always_strips_placeholder()
```

**Purpose**: Verifies that the personality placeholder is removed even when no matching personality text exists. This prevents raw template markers from leaking into model instructions.

**Data flow**: It builds models with partial or missing personality variables, asks for several personality choices, and asserts that the output contains either the available text or a blank replacement.

**Call relations**: This test stresses `ModelInfo::get_model_instructions` and the personality lookup path for incomplete templates.

*Call graph*: 2 external calls (assert_eq!, test_model).


##### `tests::get_model_instructions_falls_back_when_template_is_missing`  (lines 820–833)

```
fn get_model_instructions_falls_back_when_template_is_missing()
```

**Purpose**: Checks that base instructions are used when a model has no instruction template. This keeps models usable even without newer message metadata.

**Data flow**: It builds a model with no template, requests a friendly personality, and asserts that the returned instructions are the base string.

**Call relations**: This test covers the fallback branch in `ModelInfo::get_model_instructions`.

*Call graph*: 2 external calls (assert_eq!, test_model).


##### `tests::get_personality_message_returns_default_when_personality_is_none`  (lines 836–842)

```
fn get_personality_message_returns_default_when_personality_is_none()
```

**Purpose**: Confirms that no explicit personality choice uses the configured default personality message. This distinguishes no choice from choosing `Personality::None`.

**Data flow**: It creates complete personality variables, asks for a message with no personality argument, and checks that the default text is returned.

**Call relations**: This test focuses on `ModelInstructionsVariables::get_personality_message` through the shared helper data.

*Call graph*: 2 external calls (assert_eq!, personality_variables).


##### `tests::get_personality_message`  (lines 845–907)

```
fn get_personality_message()
```

**Purpose**: Tests personality message selection across complete and partial variable sets. It documents which cases return text, an empty string, or no value.

**Data flow**: It builds several `ModelInstructionsVariables` examples, requests friendly, pragmatic, none, and default messages, then asserts each returned option.

**Call relations**: This is the main behavior test for `ModelInstructionsVariables::get_personality_message`.

*Call graph*: 2 external calls (assert_eq!, personality_variables).


##### `tests::model_info_defaults_availability_nux_to_none_when_omitted`  (lines 910–950)

```
fn model_info_defaults_availability_nux_to_none_when_omitted()
```

**Purpose**: Verifies that omitted newer `ModelInfo` fields get safe defaults during JSON deserialization. This protects compatibility with older server payloads.

**Data flow**: It deserializes a JSON model missing several optional fields, then checks defaults such as no availability message, default web search type, and no tool mode.

**Call relations**: This test exercises serde defaults declared on `ModelInfo` fields, including modality and optional metadata behavior.

*Call graph*: 4 external calls (assert!, assert_eq!, from_value, json!).


##### `tests::model_info_deserializes_known_tool_mode`  (lines 953–966)

```
fn model_info_deserializes_known_tool_mode()
```

**Purpose**: Checks that a known tool mode string from JSON becomes the correct typed `ToolMode` value. This proves selector deserialization works for recognized values.

**Data flow**: It serializes a test model to JSON, inserts `code_mode_only` as `tool_mode`, deserializes it back, and asserts the typed value is present.

**Call relations**: This test covers `deserialize_optional_model_selector` for a known `ToolMode`.

*Call graph*: 4 external calls (assert_eq!, test_model, String, to_value).


##### `tests::model_info_treats_unknown_tool_mode_as_omitted`  (lines 969–987)

```
fn model_info_treats_unknown_tool_mode_as_omitted()
```

**Purpose**: Verifies that an unknown future tool mode is ignored instead of causing model metadata loading to fail. It also checks that the unknown value is not written back out.

**Data flow**: It inserts an unfamiliar tool mode string into serialized model JSON, deserializes the model, checks that `tool_mode` is `None`, serializes again, and confirms the field is absent.

**Call relations**: This test guards the forward-compatible behavior provided by `deserialize_optional_model_selector`.

*Call graph*: 5 external calls (assert!, assert_eq!, test_model, String, to_value).


##### `tests::model_info_treats_unknown_multi_agent_version_as_omitted`  (lines 990–1003)

```
fn model_info_treats_unknown_multi_agent_version_as_omitted()
```

**Purpose**: Checks that an unknown future multi-agent version is ignored safely. This lets older clients read model catalogs from newer servers.

**Data flow**: It inserts an unfamiliar `multi_agent_version` string into model JSON, deserializes it, and asserts that the resulting field is `None`.

**Call relations**: This test applies the same selector helper behavior to `MultiAgentVersion`.

*Call graph*: 4 external calls (assert_eq!, test_model, String, to_value).


##### `tests::resolved_context_window_prefers_context_window`  (lines 1006–1014)

```
fn resolved_context_window_prefers_context_window()
```

**Purpose**: Verifies that `context_window` takes priority over `max_context_window` when both are present. The more direct configured value wins.

**Data flow**: It builds a test model with both fields set and asserts that `resolved_context_window` returns the `context_window` value.

**Call relations**: This protects the precedence rule inside `ModelInfo::resolved_context_window`.

*Call graph*: 2 external calls (assert_eq!, test_model).


##### `tests::resolved_context_window_falls_back_to_max_context_window`  (lines 1017–1026)

```
fn resolved_context_window_falls_back_to_max_context_window()
```

**Purpose**: Checks that `max_context_window` is used when `context_window` is missing, and that the auto-compaction limit is derived from it. This keeps models with only a maximum limit usable.

**Data flow**: It builds a model with no `context_window` and a `max_context_window`, then asserts the resolved window and the 90 percent compaction limit.

**Call relations**: This test connects `ModelInfo::resolved_context_window` and `ModelInfo::auto_compact_token_limit`.

*Call graph*: 2 external calls (assert_eq!, test_model).


##### `tests::model_preset_preserves_availability_nux`  (lines 1029–1051)

```
fn model_preset_preserves_availability_nux()
```

**Purpose**: Ensures converting `ModelInfo` to `ModelPreset` keeps the availability message and service-tier defaults. It also checks legacy fast mode support.

**Data flow**: It builds a model with an availability message, fast legacy tier, and default fast service tier, converts it to a preset, and asserts those details remain available.

**Call relations**: This test exercises `ModelPreset::from` and `ModelPreset::supports_fast_mode` together.

*Call graph*: calls 1 internal fn (from); 5 external calls (new, assert!, assert_eq!, test_model, vec!).


##### `tests::model_preset_supports_fast_mode_from_service_tiers`  (lines 1054–1065)

```
fn model_preset_supports_fast_mode_from_service_tiers()
```

**Purpose**: Checks that fast mode is detected from the newer `service_tiers` list. This protects the newer path as the legacy speed-tier field is phased out.

**Data flow**: It builds a model with a fast service tier, converts it to a preset, and asserts that the preset reports fast mode support.

**Call relations**: This test covers `ModelPreset::from` followed by `ModelPreset::supports_fast_mode`.

*Call graph*: calls 1 internal fn (from); 3 external calls (assert!, test_model, vec!).


##### `tests::service_tier_for_request_omits_explicit_default_tier`  (lines 1068–1083)

```
fn service_tier_for_request_omits_explicit_default_tier()
```

**Purpose**: Verifies that the special default service-tier request value is not sent as an override. The backend can apply defaults without receiving a fake tier name.

**Data flow**: It builds a model with fast service tier support, asks for the special default request value, and asserts that no request tier is returned.

**Call relations**: This test protects the default-marker branch in `ModelInfo::service_tier_for_request`.

*Call graph*: 3 external calls (assert_eq!, test_model, vec!).


##### `tests::service_tier_for_request_filters_unsupported_tiers`  (lines 1086–1106)

```
fn service_tier_for_request_filters_unsupported_tiers()
```

**Purpose**: Checks that only supported service tiers are allowed into a request. Unsupported names and missing choices are omitted.

**Data flow**: It builds a model supporting fast, then tries fast, an unsupported string, and no tier. It asserts that only fast is returned.

**Call relations**: This test exercises both `ModelInfo::service_tier_for_request` and its helper `ModelInfo::supports_service_tier`.

*Call graph*: 3 external calls (assert_eq!, test_model, vec!).


##### `tests::service_tier_for_request_does_not_apply_catalog_default`  (lines 1109–1121)

```
fn service_tier_for_request_does_not_apply_catalog_default()
```

**Purpose**: Verifies that the catalog's default service tier is not automatically sent on requests. A request override is sent only when the user or caller explicitly asks for one.

**Data flow**: It builds a model with a default fast tier but passes no requested tier, then asserts that the request tier remains `None`.

**Call relations**: This test protects the boundary between catalog defaults and request-specific overrides in `ModelInfo::service_tier_for_request`.

*Call graph*: 3 external calls (assert_eq!, test_model, vec!).


### `protocol/src/parse_command.rs`

`data_model` · `cross-cutting`

This file is a small but important vocabulary file. When a user or tool provides a command, the rest of the system needs a simple way to say what that command appears to do. Instead of passing around only raw text like `cat README.md` or `grep TODO src`, this file defines `ParsedCommand`, an enum, which is a type that can be one of several named choices.

The choices describe the main command patterns the system cares about. `Read` means the command looks like it reads one specific file, and it stores the original command text, a human-friendly name, and the file path. `ListFiles` means the command lists directory contents, with an optional path. `Search` means the command searches for text, with an optional query and optional path. `Unknown` keeps the original command when the system cannot confidently classify it.

The file also marks this type as serializable and deserializable, meaning it can be turned into data formats like JSON and read back again. It also supports JSON schema and TypeScript generation, so other languages or external tools can use the same structure safely. In everyday terms, this file is the project’s standard form for a “parsed command receipt.” Without it, different parts of the system might describe the same command in inconsistent ways.


### `protocol/src/user_input.rs`

`data_model` · `request handling and protocol serialization`

This file is part of the shared protocol: the agreed language used when different parts of the system exchange user input. Its main type, `UserInput`, says that a user message is not always just plain text. It may be text with marked spans, an already encoded image, a local image path that will later be turned into an encoded image, a selected skill, or a structured mention such as an app or plugin reference.

The `TextElement` type is for special items embedded inside a text message. Instead of rewriting the text, it records a `ByteRange`, meaning a start and end position inside the UTF-8 text bytes. This is like putting sticky notes on exact positions in a document: the document stays the same, but the system knows that a certain span should be treated specially. A text element may also carry a readable placeholder for display.

`MAX_USER_INPUT_TEXT_CHARS` sets a conservative limit so one message cannot consume too much of the model's available context. The file also derives serialization, schema, and TypeScript support, which means these shapes can be safely sent over APIs, documented as JSON, and mirrored in frontend code.

#### Function details

##### `TextElement::new`  (lines 63–68)

```
fn new(byte_range: ByteRange, placeholder: Option<String>) -> Self
```

**Purpose**: Creates a new marker for a special span inside a text message. Use it when code already knows the byte positions of the span and optionally has display text for it.

**Data flow**: It receives a `ByteRange`, which says where the element sits in the parent text, and an optional placeholder string. It stores both values in a new `TextElement` and returns that value without changing anything else.

**Call relations**: This is the basic constructor used when some other part of the system wants to attach rich-input metadata to text. It does not call other project functions; it simply packages the range and placeholder so later serialization, rendering, or history storage can use them.


##### `TextElement::map_range`  (lines 75–83)

```
fn map_range(&self, map: F) -> Self
```

**Purpose**: Returns a copy of a text element whose byte range has been moved or adjusted. This is useful when the surrounding text has changed but the same logical special element should still be tracked.

**Data flow**: It starts with an existing `TextElement` and receives a small mapping function. It passes the current `ByteRange` into that function, uses the returned range in a new `TextElement`, and copies the existing placeholder unchanged.

**Call relations**: This fits into flows where text is transformed and ranges must be updated to match the new text. The caller supplies the range-changing rule; this function applies it and hands back a new element ready for the updated text.


##### `TextElement::set_placeholder`  (lines 85–87)

```
fn set_placeholder(&mut self, placeholder: Option<String>)
```

**Purpose**: Changes the optional display placeholder stored on a text element. Use it when the system learns or updates the human-readable label for a marked span.

**Data flow**: It receives a mutable `TextElement` and a new optional placeholder. It replaces the old placeholder with the new one and returns nothing, because the change is made directly to the existing object.

**Call relations**: This is used after a text element already exists and needs its display label changed. It does not hand work off to other functions; it directly updates the stored metadata that later readers will see.


##### `TextElement::_placeholder_for_conversion_only`  (lines 95–97)

```
fn _placeholder_for_conversion_only(&self) -> Option<&str>
```

**Purpose**: Returns only the stored placeholder, if one exists, for special conversion code that does not have access to the original text. The name and hidden documentation warn that most code should not use this as the normal way to display a placeholder.

**Data flow**: It reads the `placeholder` field from the `TextElement`. If a placeholder string is stored, it returns a borrowed view of that string; if not, it returns nothing. It does not try to look inside the parent text.

**Call relations**: This exists for conversion between equivalent protocol types, where the source text buffer is unavailable. In ordinary display or processing flows, callers are expected to use `TextElement::placeholder` instead, because that can fall back to the marked text span.


##### `TextElement::placeholder`  (lines 99–103)

```
fn placeholder(&'a self, text: &'a str) -> Option<&'a str>
```

**Purpose**: Finds the best display text for a text element. It first uses the element's explicit placeholder, and if there is none, it tries to use the actual substring from the parent text at the stored byte range.

**Data flow**: It receives the `TextElement` and the full parent text. It checks whether the element has a stored placeholder. If yes, it returns that. If not, it uses the element's start and end byte positions to borrow that slice from the text, returning nothing if the range is not valid for the string.

**Call relations**: This is the normal helper for code that wants to show or persist a readable label for a marked text span. It connects the metadata stored in `TextElement` with the actual text buffer supplied by the caller.


##### `ByteRange::from`  (lines 115–120)

```
fn from(range: std::ops::Range<usize>) -> Self
```

**Purpose**: Converts Rust's standard `start..end` range into this protocol's `ByteRange` type. This makes it convenient for internal code to create protocol-friendly ranges.

**Data flow**: It receives a standard range with a start and end number. It copies those two numbers into a new `ByteRange`, where `start` is inclusive and `end` is exclusive, then returns it.

**Call relations**: This is used when code already has a normal Rust range but needs the explicit protocol type used by `TextElement`. It performs a simple conversion and does not call other project logic.


### `protocol/src/items.rs`

`data_model` · `cross-cutting: active whenever turns are recorded, replayed, serialized, or converted for older event consumers`

A conversation with the agent is not just plain chat text. A single turn can include typed user input, images, assistant reasoning, file patches, tool calls, web searches, generated images, and system-added hook prompts. This file gives each of those things a clear shape, like labeled forms in a folder, so they can be saved, sent over APIs, shown in a UI, and converted between Rust, JSON, TypeScript, and schema formats.

The central type is `TurnItem`, an enum, meaning “one of several possible kinds.” Each variant wraps a more specific item, such as `UserMessageItem`, `AgentMessageItem`, or `McpToolCallItem`. Most structs mainly store facts: an id, content, status, paths, results, or errors.

A second job of this file is compatibility. The project has an older event stream format called `EventMsg`. Many `as_legacy_event` or `as_legacy_events` methods turn the newer structured items back into those older events. Without this bridge, newer conversation records could not be consumed by older UI or logging code.

The file also has special support for hook prompts. These are hidden or system-generated prompt fragments tagged with a hook run id. They are serialized as small XML snippets so they can travel through model message content and later be recognized and rebuilt safely.

#### Function details

##### `ContextCompactionItem::new`  (lines 229–233)

```
fn new() -> Self
```

**Purpose**: Creates a new context-compaction item with a fresh unique id. A context compaction item marks that the conversation history has been shortened or summarized so the agent can keep working within its context limit.

**Data flow**: It takes no input. It asks the UUID library for a new random id, stores that id in a `ContextCompactionItem`, and returns the new item.

**Call relations**: Compaction tasks call this when they finish compacting context and need to record that fact as a turn item. Later, the item can be converted into an older event with `ContextCompactionItem::as_legacy_event`.

*Call graph*: called by 3 (run_compact_task_inner_impl, run_remote_compact_task_inner_impl, run_remote_compact_task_inner_impl); 1 external calls (new_v4).


##### `ContextCompactionItem::as_legacy_event`  (lines 235–237)

```
fn as_legacy_event(&self) -> EventMsg
```

**Purpose**: Turns a context-compaction turn item into the older event format. This lets older code be told, “the context was compacted,” even though the newer system stores it as a turn item.

**Data flow**: It reads the item but does not need any of its fields. It creates and returns an `EventMsg::ContextCompacted` event.

**Call relations**: This is used through `TurnItem::as_legacy_events` when a stored context-compaction item needs to be replayed or emitted to older event listeners.

*Call graph*: 1 external calls (ContextCompacted).


##### `ContextCompactionItem::default`  (lines 241–243)

```
fn default() -> Self
```

**Purpose**: Provides the standard default way to make a context-compaction item. It simply creates a fresh item rather than an empty placeholder.

**Data flow**: It takes no input, calls the constructor, and returns the newly created item with a unique id.

**Call relations**: This supports Rust’s `Default` pattern, so other code can ask for a default `ContextCompactionItem` and still get a valid, uniquely identified item.

*Call graph*: 1 external calls (new).


##### `UserMessageItem::new`  (lines 247–253)

```
fn new(content: &[UserInput]) -> Self
```

**Purpose**: Creates a new stored user message from one or more pieces of user input. The input can include text, remote images, or local images.

**Data flow**: It receives a slice of `UserInput` values. It copies those inputs into the item, assigns a fresh unique id, leaves the optional client id empty, and returns the new `UserMessageItem`.

**Call relations**: Parsing, prompt recording, pending-input inspection, and tests use this when they need to turn raw user input into the standard turn-item shape. The resulting item can later be converted to a legacy user-message event.

*Call graph*: called by 7 (parse_user_message, inspect_pending_input, record_user_prompt_and_emit_turn_item, item_completed_event_defaults_missing_completed_at_ms, item_started_event_from_non_web_search_emits_no_legacy_events, item_started_event_requires_started_at_ms, user_message_item_legacy_event_preserves_image_details); 2 external calls (to_vec, new_v4).


##### `UserMessageItem::as_legacy_event`  (lines 255–267)

```
fn as_legacy_event(&self) -> EventMsg
```

**Purpose**: Converts a structured user message into the older `UserMessageEvent` format. This is important because old consumers expect separate fields for text, image URLs, local image paths, image detail settings, and text-element ranges.

**Data flow**: It reads the item’s client id and content. It builds a combined text message, extracts remote images, local images, image detail settings, and adjusted text elements, then returns one `EventMsg::UserMessage` containing those legacy fields.

**Call relations**: `TurnItem::as_legacy_events` calls this when replaying or emitting a user message to older event-based code. It relies on the helper methods in this same impl block to split the structured content into legacy pieces.

*Call graph*: calls 6 internal fn (image_details, image_urls, local_image_details, local_image_paths, message, text_elements); 1 external calls (UserMessage).


##### `UserMessageItem::message`  (lines 269–278)

```
fn message(&self) -> String
```

**Purpose**: Builds the plain text version of a user message. It keeps text input and ignores non-text input, such as images.

**Data flow**: It reads the item’s content list. For every text chunk it takes the text, for every non-text chunk it contributes an empty string, then joins everything into one string and returns it.

**Call relations**: `UserMessageItem::as_legacy_event` calls this because the legacy user-message event has one flat `message` field instead of a mixed list of content parts.

*Call graph*: called by 1 (as_legacy_event).


##### `UserMessageItem::text_elements`  (lines 280–306)

```
fn text_elements(&self) -> Vec<TextElement>
```

**Purpose**: Collects special marked ranges inside the user’s text and adjusts them so they point into the combined message string. A text element is a tagged span of text, such as a placeholder or reference, with byte positions.

**Data flow**: It walks through each text chunk, keeps track of how many bytes of earlier text came before it, shifts each element’s byte range by that offset, and returns the adjusted list. Non-text inputs are skipped.

**Call relations**: `UserMessageItem::as_legacy_event` calls this while building the older user-message event. This keeps old consumers from seeing wrong positions after several text chunks have been joined together.

*Call graph*: calls 1 internal fn (new); called by 1 (as_legacy_event); 1 external calls (new).


##### `UserMessageItem::image_urls`  (lines 308–316)

```
fn image_urls(&self) -> Vec<String>
```

**Purpose**: Extracts the remote image URLs attached to a user message. This gives legacy code the image list it expects.

**Data flow**: It reads the mixed content list, keeps only `UserInput::Image` entries, copies their image URLs, and returns those URLs as a list.

**Call relations**: `UserMessageItem::as_legacy_event` calls this when translating a modern mixed-content user message into the older event shape.

*Call graph*: called by 1 (as_legacy_event).


##### `UserMessageItem::image_details`  (lines 318–328)

```
fn image_details(&self) -> Vec<Option<ImageDetail>>
```

**Purpose**: Extracts optional detail settings for remote images. The detail setting tells the model or UI how much image detail was requested, when that information exists.

**Data flow**: It reads remote image inputs, collects their optional detail values, removes unnecessary trailing default values, and returns the cleaned list.

**Call relations**: `UserMessageItem::as_legacy_event` uses this beside `image_urls` so each remote image can carry its detail setting in the older event format.

*Call graph*: calls 1 internal fn (trim_trailing_default_image_details); called by 1 (as_legacy_event).


##### `UserMessageItem::local_image_paths`  (lines 330–338)

```
fn local_image_paths(&self) -> Vec<std::path::PathBuf>
```

**Purpose**: Extracts paths for images that come from the local filesystem rather than a URL. This lets older event consumers know which local images were attached.

**Data flow**: It scans the content list, keeps only local-image inputs, clones their paths, and returns the paths as a list.

**Call relations**: `UserMessageItem::as_legacy_event` calls this while splitting modern user input into the separate fields used by the legacy event.

*Call graph*: called by 1 (as_legacy_event).


##### `UserMessageItem::local_image_details`  (lines 340–350)

```
fn local_image_details(&self) -> Vec<Option<ImageDetail>>
```

**Purpose**: Extracts optional detail settings for local images. It mirrors `image_details`, but for images referenced by a local path.

**Data flow**: It reads local-image inputs, collects their optional detail values, trims unnecessary trailing default entries, and returns the result.

**Call relations**: `UserMessageItem::as_legacy_event` uses this with `local_image_paths` so local images keep their detail information when converted to the older format.

*Call graph*: calls 1 internal fn (trim_trailing_default_image_details); called by 1 (as_legacy_event).


##### `trim_trailing_default_image_details`  (lines 353–360)

```
fn trim_trailing_default_image_details(
    mut details: Vec<Option<ImageDetail>>,
) -> Vec<Option<ImageDetail>>
```

**Purpose**: Removes unneeded default image-detail entries from the end of a list. This keeps serialized legacy events smaller and matches older behavior where missing trailing detail values meant “use the default.”

**Data flow**: It receives a list of optional image detail values. While the last entry is `None`, it removes it, then returns the shortened list.

**Call relations**: Both remote-image and local-image detail extraction call this before handing detail lists to legacy user-message events.

*Call graph*: called by 2 (image_details, local_image_details); 1 external calls (matches!).


##### `HookPromptItem::from_fragments`  (lines 363–370)

```
fn from_fragments(id: Option<&String>, fragments: Vec<HookPromptFragment>) -> Self
```

**Purpose**: Builds a hook-prompt item from already parsed prompt fragments. It reuses an existing id when one is supplied, or creates a new id when needed.

**Data flow**: It receives an optional id and a list of `HookPromptFragment` values. It chooses the supplied id or generates a fresh one, stores the fragments, and returns the item.

**Call relations**: Hook-prompt parsing code calls this after it has recognized hook prompt fragments inside message content. It is the final step that turns raw fragments into a proper turn item.

*Call graph*: called by 2 (parse_visible_hook_prompt_message, parse_hook_prompt_message).


##### `HookPromptFragment::from_single_hook`  (lines 374–379)

```
fn from_single_hook(text: impl Into<String>, hook_run_id: impl Into<String>) -> Self
```

**Purpose**: Creates one hook-prompt fragment from text and the id of the hook run that produced it. This is a convenient helper for callers and tests that only have one fragment to make.

**Data flow**: It accepts text and a hook-run id in any string-like form. It converts both into owned strings and returns a `HookPromptFragment` containing them.

**Call relations**: Tests use this to build sample fragments before checking that hook prompts can be serialized and parsed back correctly. Other code can use it whenever one hook result needs to become prompt content.

*Call graph*: 1 external calls (into).


##### `build_hook_prompt_message`  (lines 382–403)

```
fn build_hook_prompt_message(fragments: &[HookPromptFragment]) -> Option<ResponseItem>
```

**Purpose**: Turns hook-prompt fragments into a model-facing user message. Each fragment is wrapped as XML so it can be recognized later as hook-generated content instead of normal user text.

**Data flow**: It receives a list of fragments, ignores fragments with blank hook-run ids, serializes the rest into XML text content, and returns a `ResponseItem::Message` if anything valid remains. If no valid fragments are present, it returns `None`.

**Call relations**: The turn-running flow uses this when it needs to send hook prompt content into the model. Tests and rollout rebuilding code also use it to confirm that hook prompts survive a round trip through response items.

*Call graph*: called by 6 (rebuilds_hook_prompt_items_from_rollout_response_items, test_hook_prompt_raw_response_emits_item_completed, detects_hook_prompt_fragment_and_roundtrips_escaping, parses_hook_prompt_message_as_distinct_turn_item, run_turn, hook_prompt_roundtrips_multiple_fragments); 2 external calls (iter, new_v4).


##### `parse_hook_prompt_message`  (lines 405–424)

```
fn parse_hook_prompt_message(
    id: Option<&String>,
    content: &[ContentItem],
) -> Option<HookPromptItem>
```

**Purpose**: Recognizes a whole message as a hook-prompt message and rebuilds the structured hook-prompt item. It only succeeds if every content item is input text that can be parsed as a hook prompt fragment.

**Data flow**: It receives an optional message id and a list of content items. It parses each item as a hook-prompt fragment; if any item is not suitable, it returns `None`. If parsing succeeds and at least one fragment exists, it returns a `HookPromptItem`.

**Call relations**: Response-handling code calls this when deciding whether a model message should become a special hook-prompt turn item rather than an ordinary visible message. It delegates individual XML parsing to `parse_hook_prompt_fragment` and item creation to `HookPromptItem::from_fragments`.

*Call graph*: calls 1 internal fn (from_fragments); called by 3 (handle_response_item, maybe_emit_hook_prompt_item_completed, hook_prompt_roundtrips_multiple_fragments); 1 external calls (iter).


##### `parse_hook_prompt_fragment`  (lines 426–434)

```
fn parse_hook_prompt_fragment(text: &str) -> Option<HookPromptFragment>
```

**Purpose**: Parses one XML hook-prompt snippet into a structured fragment. This is how the system recognizes hidden hook prompt text after it has been carried through ordinary message content.

**Data flow**: It receives a text string, trims whitespace, tries to read it as `<hook_prompt>` XML, and checks that the hook-run id is not blank. On success it returns a `HookPromptFragment`; otherwise it returns `None`.

**Call relations**: Hook-prompt message parsing, visible prompt parsing, contextual-fragment checks, rollout helpers, and tests call this whenever they need to detect whether a piece of text is actually hook-prompt metadata.

*Call graph*: called by 4 (is_contextual_user_fragment, parse_visible_hook_prompt_message, rollout_hook_prompt_texts, hook_prompt_parses_legacy_single_hook_run_id).


##### `serialize_hook_prompt_fragment`  (lines 436–445)

```
fn serialize_hook_prompt_fragment(text: &str, hook_run_id: &str) -> Option<String>
```

**Purpose**: Converts one hook-prompt fragment into XML text. XML escaping protects special characters like `&` so the text can be parsed back safely.

**Data flow**: It receives fragment text and a hook-run id. If the id is blank it returns `None`; otherwise it builds a small XML object and returns the serialized string if serialization succeeds.

**Call relations**: `build_hook_prompt_message` uses this for each valid fragment before putting it into a model-facing response message.

*Call graph*: 1 external calls (to_string).


##### `AgentMessageItem::new`  (lines 448–455)

```
fn new(content: &[AgentMessageContent]) -> Self
```

**Purpose**: Creates a new assistant-message item from assistant-authored content. It starts without phase metadata or memory citation information.

**Data flow**: It receives a slice of assistant message content, copies it into a new item, assigns a fresh unique id, sets optional fields to `None`, and returns the item.

**Call relations**: Code that constructs assistant turn items can use this as the standard constructor. The item can later be emitted to older event listeners through `AgentMessageItem::as_legacy_events`.

*Call graph*: 2 external calls (to_vec, new_v4).


##### `AgentMessageItem::as_legacy_events`  (lines 457–468)

```
fn as_legacy_events(&self) -> Vec<EventMsg>
```

**Purpose**: Converts assistant message content into older agent-message events. Each text content block becomes one legacy event.

**Data flow**: It reads the assistant message content, phase, and memory citation. For each text block it creates an `EventMsg::AgentMessage` carrying the text and optional metadata, then returns the list.

**Call relations**: `TurnItem::as_legacy_events` calls this when an assistant message turn item needs to be replayed in the older event stream.


##### `ReasoningItem::as_legacy_events`  (lines 472–491)

```
fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>
```

**Purpose**: Converts stored assistant reasoning into older reasoning events. It can include only summaries, or also the raw reasoning text when the caller explicitly allows it.

**Data flow**: It receives a boolean saying whether raw reasoning should be shown. It always turns each summary string into an `AgentReasoning` event; if allowed, it also turns each raw entry into an `AgentReasoningRawContent` event. It returns all events in order.

**Call relations**: `TurnItem::as_legacy_events` calls this for reasoning items. The boolean lets the wider system respect settings that hide or show raw reasoning.

*Call graph*: 3 external calls (new, AgentReasoning, AgentReasoningRawContent).


##### `WebSearchItem::as_legacy_event`  (lines 495–501)

```
fn as_legacy_event(&self) -> EventMsg
```

**Purpose**: Turns a completed web-search item into the older web-search-end event. This preserves the search id, query, and action that was taken.

**Data flow**: It reads the item’s id, query, and action, clones them as needed, and returns an `EventMsg::WebSearchEnd`.

**Call relations**: `TurnItem::as_legacy_events` calls this when replaying a web search to older event consumers.

*Call graph*: 2 external calls (clone, WebSearchEnd).


##### `ImageGenerationItem::as_legacy_event`  (lines 505–513)

```
fn as_legacy_event(&self) -> EventMsg
```

**Purpose**: Turns an image-generation result into the older image-generation-end event. This carries the status, result, optional revised prompt, and optional saved file path.

**Data flow**: It reads all fields from the item, copies them into an `ImageGenerationEndEvent`, and returns it wrapped as an `EventMsg`.

**Call relations**: `TurnItem::as_legacy_events` uses this so image-generation turn items can still appear in the older event stream.

*Call graph*: 1 external calls (ImageGenerationEnd).


##### `FileChangeItem::as_legacy_begin_event`  (lines 517–524)

```
fn as_legacy_begin_event(&self, turn_id: String) -> EventMsg
```

**Purpose**: Creates the older “patch apply started” event for a file change. A patch is a proposed or applied edit to files.

**Data flow**: It receives a turn id, reads the file-change item’s id, approval flag, and change map, and returns a `PatchApplyBegin` event. If `auto_approved` is missing, it treats it as false.

**Call relations**: Code that needs to announce the start of a file patch can call this directly. `TurnItem::as_legacy_events` usually emits the end event, while this method is available for begin-style event flows.

*Call graph*: 1 external calls (PatchApplyBegin).


##### `FileChangeItem::as_legacy_end_event`  (lines 526–537)

```
fn as_legacy_end_event(&self, turn_id: String) -> Option<EventMsg>
```

**Purpose**: Creates the older “patch apply finished” event when a file change has a final status. If the file change is not finished yet, there is no end event to produce.

**Data flow**: It receives a turn id and checks the item’s status. If no status exists, it returns `None`. Otherwise it fills in output text, error text, success flag, changed files, and status, then returns a `PatchApplyEnd` event.

**Call relations**: `TurnItem::as_legacy_events` calls this for file-change items and includes the event only when this method says the change has enough information to be considered ended.

*Call graph*: 1 external calls (PatchApplyEnd).


##### `McpToolCallItem::as_legacy_begin_event`  (lines 541–552)

```
fn as_legacy_begin_event(&self) -> EventMsg
```

**Purpose**: Creates the older event that announces the start of an MCP tool call. MCP means Model Context Protocol, a way for the agent to call external tools through named servers.

**Data flow**: It reads the server name, tool name, arguments, resource URI, and plugin id. If the arguments value is JSON null, it omits arguments; otherwise it includes them. It returns an `McpToolCallBegin` event.

**Call relations**: Tool-call flows can use this when they need to tell older listeners that an MCP tool invocation has begun. The matching finish path is `McpToolCallItem::as_legacy_end_event`.

*Call graph*: 2 external calls (is_null, McpToolCallBegin).


##### `McpToolCallItem::as_legacy_end_event`  (lines 554–573)

```
fn as_legacy_end_event(&self) -> Option<EventMsg>
```

**Purpose**: Creates the older event that reports the result of an MCP tool call. It only emits an event when there is a result or error and a duration.

**Data flow**: It examines the item’s result and error. A result becomes success, an error message becomes failure, and if neither exists it returns `None`. It also requires a duration; if present, it builds and returns an `McpToolCallEnd` event with invocation details and outcome.

**Call relations**: `TurnItem::as_legacy_events` calls this for MCP tool-call items. This prevents incomplete in-progress tool calls from being reported as finished.

*Call graph*: 2 external calls (is_null, McpToolCallEnd).


##### `TurnItem::id`  (lines 577–592)

```
fn id(&self) -> String
```

**Purpose**: Returns the unique id for any kind of turn item. This gives callers one simple way to identify an item without first checking which variant it is.

**Data flow**: It receives a `TurnItem`, matches on its variant, clones the inner item’s id, and returns that string.

**Call relations**: Any code that stores, displays, updates, or compares turn items can call this instead of writing separate id-access logic for every item type.


##### `TurnItem::as_legacy_events`  (lines 594–617)

```
fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>
```

**Purpose**: Converts any turn item into zero, one, or several older event messages. This is the main compatibility bridge from the newer turn-item model to the older event stream.

**Data flow**: It receives a turn item and a setting for whether raw agent reasoning should be shown. It matches the item’s kind, calls the appropriate conversion helper, builds a simple event directly for image views, or returns an empty list for item kinds that have no legacy equivalent.

**Call relations**: Replay and event-emission paths use this when they need to feed modern stored turn items into older consumers. It delegates most work to the specific item’s own conversion method.

*Call graph*: 3 external calls (new, new, vec!).


##### `tests::hook_prompt_roundtrips_multiple_fragments`  (lines 626–639)

```
fn hook_prompt_roundtrips_multiple_fragments()
```

**Purpose**: Checks that multiple hook-prompt fragments can be converted into a message and parsed back without losing information. This protects the XML wrapping and parsing behavior.

**Data flow**: It creates two sample fragments, builds a hook-prompt message from them, extracts the message content, parses it back into a hook-prompt item, and asserts that the parsed fragments equal the originals.

**Call relations**: This test exercises `HookPromptFragment::from_single_hook`, `build_hook_prompt_message`, and `parse_hook_prompt_message` together, proving the full round trip works.

*Call graph*: calls 2 internal fn (build_hook_prompt_message, parse_hook_prompt_message); 3 external calls (assert_eq!, panic!, vec!).


##### `tests::hook_prompt_parses_legacy_single_hook_run_id`  (lines 642–655)

```
fn hook_prompt_parses_legacy_single_hook_run_id()
```

**Purpose**: Checks that the parser still understands the older single-fragment hook-prompt XML shape. This helps keep older saved or streamed data readable.

**Data flow**: It passes a literal `<hook_prompt>` XML string into the parser, receives a fragment, and asserts that the text and hook-run id match the expected values.

**Call relations**: This test directly protects `parse_hook_prompt_fragment`, especially its compatibility with legacy XML containing one hook-run id.

*Call graph*: calls 1 internal fn (parse_hook_prompt_fragment); 1 external calls (assert_eq!).


### `protocol/src/protocol.rs`

`data_model` · `cross-cutting`

This is the protocol contract for a Codex session. Think of it like the forms and receipts used at a service desk: the client submits a request form, and the agent sends back receipts as work starts, streams, asks for permission, runs tools, finishes, or fails. Without this file, the UI, server, agent, history files, tests, and TypeScript-generated client types would not agree on what a “turn started”, “tool call ended”, or “approval denied” message looks like.

The file is mostly data shapes: Rust structs and enums that can be serialized to JSON, deserialized from JSON, documented as JSON Schema, and exported as TypeScript types. It also contains small helper methods that make those shapes easier and safer to use. Examples include converting old event formats into newer item events, checking whether a sandbox allows writing to a path, formatting token usage for humans, and recovering session metadata from saved rollout history.

Several areas meet here: user submissions, realtime voice conversations, approval policies, sandbox permissions, MCP tool calls, patch application, token accounting, review output, thread goals, multi-agent collaboration, and resumed-session history. Because this file sits at the boundary between many components, it is deliberately backward-compatible in many places so old saved sessions and older clients can still be read.

#### Function details

##### `TurnEnvironmentSelections::new`  (lines 126–134)

```
fn new(
        legacy_fallback_cwd: AbsolutePathBuf,
        environments: Vec<TurnEnvironmentSelection>,
    ) -> Self
```

**Purpose**: Builds a turn’s environment selection record from a fallback working directory and a list of named environments. This is used when a turn may run in one or more configured workspaces.

**Data flow**: It receives an absolute fallback directory and environment entries. It stores both values unchanged in a new TurnEnvironmentSelections object and returns it.

**Call relations**: Session setup, review runs, internal agent spawning, and tests call this when they need to package environment choices before applying them to a turn.

*Call graph*: called by 30 (collect_resume_override_mismatches_includes_service_tier, build_environment_override, run_review_on_session, spawn_internal, absolute_cwd_update_with_turn_environment_is_allowed, empty_turn_environments_clear_primary_environment, environment_settings_preserve_explicit_primary_cwd, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, make_session_configuration_for_tests (+15 more)).


##### `GitSha::new`  (lines 143–145)

```
fn new(sha: &str) -> Self
```

**Purpose**: Wraps a Git commit hash string in the GitSha type. This makes commit hashes distinct from ordinary strings in protocol data.

**Data flow**: It receives a string slice, copies it into an owned String, places it inside GitSha, and returns the wrapper.

**Call relations**: Git metadata collection and tests call this when thread or repository information needs to carry the current commit hash.

*Call graph*: called by 8 (thread_list_includes_git_info, thread_metadata_update_can_clear_stored_git_fields, test_git_info_serialization, stored_thread, branch_remote_and_distance, collect_git_info, get_head_commit_hash, backfill_sessions_preserves_existing_git_branch_and_fills_missing_git_fields).


##### `RealtimeVoice::wire_name`  (lines 244–266)

```
fn wire_name(self) -> &'static str
```

**Purpose**: Returns the exact lowercase voice name that should be sent over the realtime conversation protocol. It prevents callers from guessing or misspelling voice names.

**Data flow**: It receives a RealtimeVoice enum value and maps it to a fixed string such as alloy, cove, or marin.

**Call relations**: Realtime conversation code can use this when translating the internal enum into the name expected by the backend service.


##### `RealtimeVoicesList::builtin`  (lines 280–308)

```
fn builtin() -> Self
```

**Purpose**: Returns the built-in voice catalog for realtime conversations. It includes separate voice lists and defaults for two realtime protocol versions.

**Data flow**: It creates two ordered voice lists, sets one default voice for each version, and returns the complete RealtimeVoicesList.

**Call relations**: Realtime voice validation, default selection, and voice-list requests call this when the system needs the supported voices without fetching them elsewhere.

*Call graph*: called by 4 (thread_realtime_list_voices, default_realtime_voice, validate_realtime_voice, realtime_conversation_list_voices); 1 external calls (vec!).


##### `Op::from`  (lines 666–674)

```
fn from(value: Vec<UserInput>) -> Self
```

**Purpose**: Lets a plain list of user input items be turned into a normal user-input operation. This is a convenience for callers that only have user input and no extra settings.

**Data flow**: It receives a vector of UserInput items, wraps it in Op::UserInput, and fills optional schema, metadata, context, and thread settings with empty defaults.

**Call relations**: Any code that starts from raw user input can rely on this conversion instead of manually filling every field of Op::UserInput.

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

**Purpose**: Creates a plain text message from one agent to another. It records who sent it, who should receive it, other recipients, the content, and whether it should trigger a new turn.

**Data flow**: It receives sender and recipient paths, extra recipients, message text, and a trigger flag. It returns an InterAgentCommunication with no encrypted content and no metadata.

**Call relations**: Multi-agent coordination code uses this when agents send normal messages, completion notifications, or task handoffs to each other.

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

**Purpose**: Creates an encrypted inter-agent message. The visible content is left empty because the real payload is stored in the encrypted field.

**Data flow**: It receives sender and recipient paths, extra recipients, encrypted text, and a trigger flag. It returns an InterAgentCommunication with encrypted_content set and content empty.

**Call relations**: Encrypted communication tests and tool-message conversion use this when the message payload must be preserved without exposing its text.

*Call graph*: called by 4 (encrypted_inter_agent_communication_clears_existing_last_task_message, communication_from_tool_message, serializes_inter_agent_communications_for_memory, queued_encrypted_inter_agent_communication_renders_message_envelope); 1 external calls (new).


##### `InterAgentCommunication::to_response_input_item`  (lines 730–738)

```
fn to_response_input_item(&self) -> ResponseInputItem
```

**Purpose**: Turns an inter-agent message into a model input item that can be saved or replayed as assistant commentary. This preserves the communication as structured JSON text.

**Data flow**: It serializes the communication to JSON, wraps that text as output content, marks the phase as commentary, and returns a ResponseInputItem.

**Call relations**: This is used when inter-agent delivery metadata needs to enter the same input stream as other conversation items.

*Call graph*: 1 external calls (vec!).


##### `InterAgentCommunication::to_model_input_item`  (lines 740–770)

```
fn to_model_input_item(&self) -> ResponseItem
```

**Purpose**: Turns an inter-agent communication into the ResponseItem form the model understands. It handles both plain text and encrypted payloads.

**Data flow**: It reads the communication fields. For encrypted messages it builds a visible envelope plus encrypted content; for plain messages it uses the content text directly. It returns a ResponseItem::AgentMessage.

**Call relations**: History recording calls this when it needs to store inter-agent communication as model-visible agent-message history.

*Call graph*: called by 1 (record_inter_agent_communication); 2 external calls (to_string, vec!).


##### `InterAgentCommunication::is_message_content`  (lines 772–774)

```
fn is_message_content(content: &[ContentItem]) -> bool
```

**Purpose**: Checks whether a list of content items contains a serialized inter-agent communication. It is a quick yes/no wrapper around the parser.

**Data flow**: It receives content items, tries to parse them with from_message_content, and returns true only when parsing succeeds.

**Call relations**: Instruction-detection code uses this to recognize messages that are actually agent-to-agent protocol payloads.

*Call graph*: called by 1 (is_inter_agent_instruction_content); 1 external calls (from_message_content).


##### `InterAgentCommunication::from_message_content`  (lines 776–783)

```
fn from_message_content(content: &[ContentItem]) -> Option<Self>
```

**Purpose**: Tries to recover an InterAgentCommunication from a single text content item. This is how saved JSON text is turned back into structured communication data.

**Data flow**: It accepts content items. If there is exactly one input-text or output-text item, it parses that text as JSON; otherwise it returns None.

**Call relations**: Turn-boundary and inter-agent detection code call this when reading model or history content that may contain an embedded communication.

*Call graph*: called by 1 (is_trigger_turn_boundary); 1 external calls (from_str).


##### `Op::kind`  (lines 787–816)

```
fn kind(&self) -> &'static str
```

**Purpose**: Returns a stable short name for each client operation. This is useful for logging, routing, metrics, and debugging.

**Data flow**: It inspects the Op variant and returns a fixed lowercase string such as user_input, shutdown, or exec_approval.

**Call relations**: Code that handles submissions can call this to describe the operation without exposing the whole payload.


##### `GranularApprovalConfig::allows_sandbox_approval`  (lines 888–890)

```
fn allows_sandbox_approval(self) -> bool
```

**Purpose**: Reports whether sandbox-related command approval prompts are allowed. This lets policy text and approval routing respect the user’s fine-grained setting.

**Data flow**: It receives the config by value and returns the sandbox_approval boolean.

**Call relations**: Approval-instruction generation calls this while explaining which approval flows are enabled.

*Call graph*: called by 1 (granular_instructions).


##### `GranularApprovalConfig::allows_rules_approval`  (lines 892–894)

```
fn allows_rules_approval(self) -> bool
```

**Purpose**: Reports whether prompts caused by approval rules are allowed. It exposes the rules flag through a clear method.

**Data flow**: It receives the config and returns the rules boolean.

**Call relations**: Approval-instruction generation uses this along with the other granular checks.

*Call graph*: called by 1 (granular_instructions).


##### `GranularApprovalConfig::allows_skill_approval`  (lines 896–898)

```
fn allows_skill_approval(self) -> bool
```

**Purpose**: Reports whether skill-script approval prompts are allowed. Skills are optional capabilities, and this says whether their approval prompts may be shown.

**Data flow**: It receives the config and returns the skill_approval boolean.

**Call relations**: Approval-instruction generation calls this when describing skill-related permission behavior.

*Call graph*: called by 1 (granular_instructions).


##### `GranularApprovalConfig::allows_request_permissions`  (lines 900–902)

```
fn allows_request_permissions(self) -> bool
```

**Purpose**: Reports whether the request_permissions tool may ask the user for permission. This supports fine-grained control over permission prompts.

**Data flow**: It receives the config and returns the request_permissions boolean.

**Call relations**: Approval-instruction generation calls this when deciding whether to mention request-permissions prompts.

*Call graph*: called by 1 (granular_instructions).


##### `GranularApprovalConfig::allows_mcp_elicitations`  (lines 904–906)

```
fn allows_mcp_elicitations(self) -> bool
```

**Purpose**: Reports whether MCP elicitation prompts are allowed. An elicitation is a tool server asking the user for extra information.

**Data flow**: It receives the config and returns the mcp_elicitations boolean.

**Call relations**: Approval-instruction generation calls this to decide whether MCP user prompts are available.

*Call graph*: called by 1 (granular_instructions).


##### `NetworkAccess::is_enabled`  (lines 922–924)

```
fn is_enabled(self) -> bool
```

**Purpose**: Answers whether a network access setting means outbound network traffic is allowed.

**Data flow**: It receives a NetworkAccess value and returns true only for Enabled.

**Call relations**: Sandbox policy checks use this when converting an external sandbox’s network setting into a yes/no answer.

*Call graph*: 1 external calls (matches!).


##### `WritableRoot::is_path_writable`  (lines 1000–1018)

```
fn is_path_writable(&self, path: &Path) -> bool
```

**Purpose**: Checks whether a specific path may be written under a writable root. It protects read-only carve-outs and sensitive metadata folders inside otherwise writable areas.

**Data flow**: It receives a filesystem path. It first verifies the path is inside the writable root, rejects it if it is under any read-only subpath, rejects it if it begins with a protected metadata name, and otherwise returns true.

**Call relations**: Sandbox permission checks and tests call this when deciding whether a command should be allowed to write to a path.

*Call graph*: calls 1 internal fn (path_contains_protected_metadata_name); 1 external calls (starts_with).


##### `WritableRoot::path_contains_protected_metadata_name`  (lines 1020–1032)

```
fn path_contains_protected_metadata_name(&self, path: &Path) -> bool
```

**Purpose**: Detects whether a path tries to create or replace a protected metadata directory directly under a writable root. This blocks risky names such as workspace control folders unless explicitly allowed.

**Data flow**: It receives a path, makes it relative to the root, looks at the first path component, and compares that component to the protected metadata names.

**Call relations**: WritableRoot::is_path_writable calls this as its final safety check before allowing a write.

*Call graph*: called by 1 (is_path_writable); 1 external calls (strip_prefix).


##### `SandboxPolicy::from_str`  (lines 1038–1040)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a sandbox policy from JSON text. This allows policies to be read from strings in configuration or tests.

**Data flow**: It receives a string and asks serde_json to deserialize it into SandboxPolicy, returning either the policy or a JSON error.

**Call relations**: This is the standard FromStr implementation used by callers that parse legacy sandbox policy text.

*Call graph*: 1 external calls (from_str).


##### `FileSystemSandboxPolicy::from_str`  (lines 1046–1048)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a filesystem sandbox policy from JSON text. It provides the same string-parsing convenience for the newer filesystem policy type.

**Data flow**: It receives JSON text and deserializes it into FileSystemSandboxPolicy or returns a JSON error.

**Call relations**: Configuration and tests can use this through Rust’s FromStr pattern.

*Call graph*: 1 external calls (from_str).


##### `NetworkSandboxPolicy::from_str`  (lines 1054–1056)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a network sandbox policy from JSON text. This keeps network policy parsing consistent with filesystem and legacy sandbox parsing.

**Data flow**: It receives JSON text and deserializes it into NetworkSandboxPolicy or returns a JSON error.

**Call relations**: Callers that accept policies as strings can use this implementation directly.

*Call graph*: 1 external calls (from_str).


##### `SandboxPolicy::new_read_only_policy`  (lines 1061–1065)

```
fn new_read_only_policy() -> Self
```

**Purpose**: Creates the default read-only sandbox policy with network access disabled. This is a safe baseline for command execution.

**Data flow**: It takes no input and returns SandboxPolicy::ReadOnly with network_access set to false.

**Call relations**: Tests and setup code call this when they need a simple restrictive policy.


##### `SandboxPolicy::new_workspace_write_policy`  (lines 1070–1077)

```
fn new_workspace_write_policy() -> Self
```

**Purpose**: Creates the default workspace-write sandbox policy. It allows writes in the workspace and common temporary locations, but no network access.

**Data flow**: It takes no input and returns SandboxPolicy::WorkspaceWrite with no extra roots, network disabled, and default temporary-directory behavior enabled.

**Call relations**: Callers use this as the standard policy when the agent may edit the current project but should not write anywhere else.

*Call graph*: 1 external calls (vec!).


##### `SandboxPolicy::has_full_disk_read_access`  (lines 1079–1081)

```
fn has_full_disk_read_access(&self) -> bool
```

**Purpose**: Reports whether the legacy sandbox policy permits reading the whole disk. In this legacy model, every policy returns true for full read access.

**Data flow**: It ignores the policy variant and returns true.

**Call relations**: Permission checks and tests use this when comparing legacy sandbox semantics.


##### `SandboxPolicy::has_full_disk_write_access`  (lines 1083–1090)

```
fn has_full_disk_write_access(&self) -> bool
```

**Purpose**: Reports whether the policy allows writing anywhere on disk. This distinguishes unrestricted or externally managed cases from read-only and workspace-write cases.

**Data flow**: It checks the policy variant and returns true for DangerFullAccess and ExternalSandbox, false for ReadOnly and WorkspaceWrite.

**Call relations**: Write-permission checks use this before falling back to checking specific writable roots.


##### `SandboxPolicy::has_full_network_access`  (lines 1092–1099)

```
fn has_full_network_access(&self) -> bool
```

**Purpose**: Reports whether the policy allows unrestricted outbound network access. This is used to decide whether network calls need sandboxing or approval.

**Data flow**: It checks the policy variant and the stored network flag, returning true only when that variant says network is allowed.

**Call relations**: Tests and policy conversion code use this when preserving legacy network behavior.


##### `SandboxPolicy::get_writable_roots_with_cwd`  (lines 1104–1192)

```
fn get_writable_roots_with_cwd(&self, cwd: &Path) -> Vec<WritableRoot>
```

**Purpose**: Builds the list of directories where writes are allowed for a policy, tailored to the current working directory. It also marks important subfolders as read-only even inside writable roots.

**Data flow**: It receives the current directory. For unrestricted, external, or read-only policies it returns no scoped writable roots. For workspace-write it combines configured roots, the current directory, /tmp on Unix when allowed, and TMPDIR when allowed, then attaches read-only protected subpaths for each root.

**Call relations**: Sandbox write checks, tests, and legacy policy comparisons call this to understand where file edits are permitted.

*Call graph*: calls 1 internal fn (from_absolute_path); 5 external calls (from, new, cfg!, error!, var_os).


##### `EventMsg::from`  (lines 1636–1638)

```
fn from(event: SubAgentActivityEvent) -> Self
```

**Purpose**: Wraps collaboration and sub-agent event payloads into the larger EventMsg enum. This makes those events easy to emit with Rust’s standard conversion pattern.

**Data flow**: It receives a specific collaboration or sub-agent event type and returns the matching EventMsg variant containing that event.

**Call relations**: Event-producing code can hand off these event structs and let From choose the correct protocol message wrapper.

*Call graph*: 11 external calls (CollabAgentInteractionBegin, CollabAgentInteractionEnd, CollabAgentSpawnBegin, CollabAgentSpawnEnd, CollabCloseBegin, CollabCloseEnd, CollabResumeBegin, CollabResumeEnd, CollabWaitingBegin, CollabWaitingEnd (+1 more)).


##### `CodexErrorInfo::affects_turn_status`  (lines 1711–1728)

```
fn affects_turn_status(&self) -> bool
```

**Purpose**: Decides whether a particular error should mark the current turn as failed when history is replayed. Some errors are informational or apply outside the active turn.

**Data flow**: It receives an error kind and returns false for rollback failure and non-steerable-turn errors, true for the errors that should make a turn look failed.

**Call relations**: ErrorEvent::affects_turn_status delegates to this when the error has structured Codex error information.


##### `ItemStartedEvent::as_legacy_events`  (lines 1745–1760)

```
fn as_legacy_events(&self, _: bool) -> Vec<EventMsg>
```

**Purpose**: Creates old-style begin events from a newer item-started event. This keeps older clients working while the protocol uses newer item events.

**Data flow**: It inspects the TurnItem. For web search, image generation, file changes, and MCP tool calls it returns the matching legacy begin event; for other items it returns an empty list.

**Call relations**: EventMsg::as_legacy_events calls this when translating modern events for legacy UI history.

*Call graph*: 2 external calls (new, vec!).


##### `default_item_completed_at_ms`  (lines 1775–1777)

```
fn default_item_completed_at_ms() -> i64
```

**Purpose**: Supplies a default completion timestamp for older saved events that did not store one. This preserves backward compatibility with old rollout files.

**Data flow**: It takes no input and returns 0.

**Call relations**: Serde deserialization uses this when ItemCompletedEvent is missing completed_at_ms.


##### `ItemCompletedEvent::as_legacy_events`  (lines 1784–1792)

```
fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>
```

**Purpose**: Creates old-style completion events from a newer item-completed event. It bridges new history data to clients that still expect specific tool end events.

**Data flow**: It inspects the completed TurnItem. File changes use their special patch-end conversion; other items ask the TurnItem to produce legacy events.

**Call relations**: EventMsg::as_legacy_events calls this during legacy event translation.

*Call graph*: 1 external calls (as_legacy_events).


##### `AgentMessageContentDeltaEvent::as_legacy_events`  (lines 1804–1806)

```
fn as_legacy_events(&self, _: bool) -> Vec<EventMsg>
```

**Purpose**: Defines that agent message streaming deltas do not produce legacy events. Older event streams did not have a matching event for this item delta.

**Data flow**: It receives the delta event and returns an empty vector.

**Call relations**: EventMsg::as_legacy_events calls this when it sees an AgentMessageContentDelta event.

*Call graph*: 1 external calls (new).


##### `ReasoningContentDeltaEvent::as_legacy_events`  (lines 1829–1831)

```
fn as_legacy_events(&self, _: bool) -> Vec<EventMsg>
```

**Purpose**: Defines that summarized reasoning text deltas do not produce legacy events. This avoids leaking or duplicating stream fragments in old formats.

**Data flow**: It receives the delta event and returns an empty vector.

**Call relations**: EventMsg::as_legacy_events calls this for reasoning-summary delta events.

*Call graph*: 1 external calls (new).


##### `ReasoningRawContentDeltaEvent::as_legacy_events`  (lines 1846–1848)

```
fn as_legacy_events(&self, _: bool) -> Vec<EventMsg>
```

**Purpose**: Defines that raw reasoning deltas do not produce legacy events. Raw reasoning streaming is kept out of the old event bridge.

**Data flow**: It receives the delta event and returns an empty vector.

**Call relations**: EventMsg::as_legacy_events calls this for raw reasoning delta events.

*Call graph*: 1 external calls (new).


##### `EventMsg::as_legacy_events`  (lines 1852–1867)

```
fn as_legacy_events(&self, show_raw_agent_reasoning: bool) -> Vec<EventMsg>
```

**Purpose**: Routes modern event messages to their legacy equivalents when such equivalents exist. This is the central bridge from new protocol events to older UI events.

**Data flow**: It receives an EventMsg and a flag about showing raw reasoning. For item start, item completion, and selected deltas it delegates to the event’s conversion method; otherwise it returns no legacy events.

**Call relations**: History and UI compatibility layers use this to seed or replay older event streams from newer rollout data.

*Call graph*: 1 external calls (new).


##### `ErrorEvent::affects_turn_status`  (lines 1886–1890)

```
fn affects_turn_status(&self) -> bool
```

**Purpose**: Decides whether this concrete error event should make the active turn look failed. If no structured error info is present, it assumes the error affects the turn.

**Data flow**: It reads codex_error_info. If present, it asks CodexErrorInfo::affects_turn_status; if absent, it returns true.

**Call relations**: Error handling calls this when replaying or updating turn state after an error.

*Call graph*: called by 1 (handle_error).


##### `TokenUsageInfo::new_or_append`  (lines 2018–2042)

```
fn new_or_append(
        info: &Option<TokenUsageInfo>,
        last: &Option<TokenUsage>,
        model_context_window: Option<i64>,
    ) -> Option<Self>
```

**Purpose**: Creates or updates aggregate token usage information from the latest usage report. Tokens are pieces of text counted by the model for billing and context limits.

**Data flow**: It receives optional existing usage info, optional latest usage, and an optional context-window size. If both usage inputs are absent it returns None; otherwise it starts from existing or empty totals, appends the latest usage if present, updates the context window if provided, and returns the new info.

**Call relations**: Token tracking code calls this when new model usage arrives or when context-window metadata changes.

*Call graph*: called by 4 (new, update_token_info, token_usage_info_new_or_append_preserves_context_window_when_not_provided, token_usage_info_new_or_append_updates_context_window_when_provided); 1 external calls (default).


##### `TokenUsageInfo::append_last_usage`  (lines 2044–2047)

```
fn append_last_usage(&mut self, last: &TokenUsage)
```

**Purpose**: Adds one turn’s token usage into the running total and records it as the most recent usage.

**Data flow**: It receives a TokenUsage. It adds each count to total_token_usage and replaces last_token_usage with a clone of the received value.

**Call relations**: TokenUsageInfo::new_or_append calls this when a latest usage report is available.

*Call graph*: calls 1 internal fn (add_assign); 1 external calls (clone).


##### `TokenUsageInfo::fill_to_context_window`  (lines 2049–2062)

```
fn fill_to_context_window(&mut self, context_window: i64)
```

**Purpose**: Marks usage as filling the entire context window. This is useful when the system knows the context is full but does not have detailed token categories.

**Data flow**: It receives a context-window size, calculates how many tokens were newly added compared with the previous total, then sets total usage to the full window and last usage to the calculated delta.

**Call relations**: TokenUsageInfo::full_context_window uses this to build a complete full-window usage snapshot.

*Call graph*: 1 external calls (default).


##### `TokenUsageInfo::full_context_window`  (lines 2064–2072)

```
fn full_context_window(context_window: i64) -> Self
```

**Purpose**: Creates a token usage snapshot that represents a completely full context window.

**Data flow**: It receives a context-window size, creates an empty TokenUsageInfo with that window, fills it to the window size, and returns it.

**Call relations**: Code that explicitly sets token usage to full calls this helper.

*Call graph*: called by 1 (set_token_usage_full); 1 external calls (default).


##### `RateLimitReachedType::from_str`  (lines 2107–2116)

```
fn from_str(value: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a backend rate-limit reason from its wire string. This turns text like workspace_owner_credits_depleted into a typed enum value.

**Data flow**: It receives a string, matches known names to enum variants, and returns an error message for unknown names.

**Call relations**: Deserialization or parsing code can use this when converting account-limit strings into protocol values.

*Call graph*: 1 external calls (format!).


##### `TokenUsage::is_zero`  (lines 2150–2152)

```
fn is_zero(&self) -> bool
```

**Purpose**: Reports whether a token usage record has no total tokens. This helps summaries hide empty usage data.

**Data flow**: It reads total_tokens and returns true when it is exactly zero.

**Call relations**: Session summary code calls this before displaying or interpreting usage.

*Call graph*: called by 1 (session_summary).


##### `TokenUsage::cached_input`  (lines 2154–2156)

```
fn cached_input(&self) -> i64
```

**Purpose**: Returns the cached input-token count, never below zero. Cached input tokens are prompt tokens the model provider says were reused.

**Data flow**: It reads cached_input_tokens and clamps negative values up to zero.

**Call relations**: Metrics and display calculations call this before separating cached and non-cached input.

*Call graph*: called by 3 (emit_guardian_token_usage_histograms, emit_token_usage_metrics, non_cached_input).


##### `TokenUsage::non_cached_input`  (lines 2158–2160)

```
fn non_cached_input(&self) -> i64
```

**Purpose**: Calculates input tokens that were not cached. This is useful for display and metrics because cached tokens may cost or behave differently.

**Data flow**: It subtracts cached_input from input_tokens and clamps the result to zero.

**Call relations**: Metrics code and blended_total call this to compute user-visible usage.

*Call graph*: calls 1 internal fn (cached_input); called by 3 (emit_guardian_token_usage_histograms, blended_total, new).


##### `TokenUsage::blended_total`  (lines 2163–2165)

```
fn blended_total(&self) -> i64
```

**Purpose**: Computes the main display total: non-cached input plus output tokens. This gives a simpler number than raw provider totals.

**Data flow**: It gets non-cached input, adds non-negative output tokens, clamps the result to zero, and returns it.

**Call relations**: FinalOutput formatting uses this as the total shown to users.

*Call graph*: calls 1 internal fn (non_cached_input); called by 1 (new).


##### `TokenUsage::tokens_in_context_window`  (lines 2167–2169)

```
fn tokens_in_context_window(&self) -> i64
```

**Purpose**: Returns the token count that occupies the model’s context window. The context window is the model’s working memory for a conversation.

**Data flow**: It reads and returns total_tokens.

**Call relations**: Context-window remaining calculations call this as their used-token input.

*Call graph*: called by 1 (percent_of_context_window_remaining).


##### `TokenUsage::percent_of_context_window_remaining`  (lines 2181–2192)

```
fn percent_of_context_window_remaining(&self, context_window: i64) -> i64
```

**Purpose**: Estimates what percentage of the user-controllable context window remains. It subtracts a fixed baseline for system prompts and tools so the display reflects space the user can still affect.

**Data flow**: It receives the full context-window size. If the window is too small it returns 0; otherwise it subtracts the baseline from both window and used tokens, computes remaining percent, clamps it between 0 and 100, rounds, and returns it.

**Call relations**: UI or status code can call this to show how close the conversation is to filling the model’s memory.

*Call graph*: calls 1 internal fn (tokens_in_context_window).


##### `TokenUsage::add_assign`  (lines 2195–2201)

```
fn add_assign(&mut self, other: &TokenUsage)
```

**Purpose**: Adds another token usage record into this one field by field. It is a simple accumulator.

**Data flow**: It receives another TokenUsage and adds each of that record’s counts to the matching count in self.

**Call relations**: TokenUsageInfo::append_last_usage calls this when adding the latest turn to the session total.

*Call graph*: called by 1 (append_last_usage).


##### `FinalOutput::from`  (lines 2210–2212)

```
fn from(token_usage: TokenUsage) -> Self
```

**Purpose**: Wraps token usage in a FinalOutput object. This supports Rust’s standard conversion style.

**Data flow**: It receives TokenUsage and returns FinalOutput containing it.

**Call relations**: Callers can convert token usage into final output without manually naming the field.


##### `FinalOutput::fmt`  (lines 2216–2242)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats final token usage as a human-readable sentence. It includes cached input and reasoning output only when those counts are present.

**Data flow**: It reads token usage, computes display totals, formats numbers with separators, and writes the final string into the formatter.

**Call relations**: Anything that prints FinalOutput uses this Display implementation.

*Call graph*: 1 external calls (write!).


##### `McpToolCallEndEvent::is_success`  (lines 2369–2374)

```
fn is_success(&self) -> bool
```

**Purpose**: Determines whether an MCP tool call succeeded. MCP is a tool-server protocol, and this checks both transport-level and tool-level errors.

**Data flow**: It reads the result. If the result is Ok and its is_error flag is not true, it returns true; otherwise it returns false.

**Call relations**: MCP tool-call handling calls this when deciding how to present or process a completed tool call.

*Call graph*: called by 1 (handle_mcp_tool_call_end).


##### `InitialHistory::scan_rollout_items`  (lines 2432–2438)

```
fn scan_rollout_items(&self, mut predicate: impl FnMut(&RolloutItem) -> bool) -> bool
```

**Purpose**: Searches resumed or forked history for any rollout item matching a caller-provided test. New or cleared sessions have no stored items to scan.

**Data flow**: It receives a predicate function. It runs that predicate over resumed or forked rollout items and returns true if any item matches.

**Call relations**: History inspection code uses this to answer questions such as whether prior user turns exist.

*Call graph*: called by 1 (initial_history_has_prior_user_turns).


##### `InitialHistory::forked_from_id`  (lines 2440–2454)

```
fn forked_from_id(&self) -> Option<ThreadId>
```

**Purpose**: Finds the thread id that a session was forked from, if it can be inferred from history. Forking means starting a new thread from an existing conversation.

**Data flow**: It inspects session metadata in resumed or forked rollout items and returns the stored fork source id when present.

**Call relations**: Thread-forking setup calls this when building a new thread from initial history.

*Call graph*: called by 1 (fork_thread_with_initial_history).


##### `InitialHistory::session_cwd`  (lines 2456–2462)

```
fn session_cwd(&self) -> Option<PathBuf>
```

**Purpose**: Finds the original working directory recorded in initial history. This helps resumed or forked sessions recover where they were running.

**Data flow**: It checks resumed or forked rollout items and delegates to session_cwd_from_items; new and cleared histories return None.

**Call relations**: Session reconstruction uses this when it needs a working directory from saved history.

*Call graph*: calls 1 internal fn (session_cwd_from_items).


##### `InitialHistory::get_rollout_items`  (lines 2464–2470)

```
fn get_rollout_items(&self) -> Vec<RolloutItem>
```

**Purpose**: Returns the saved rollout items inside initial history. New or cleared sessions produce an empty list.

**Data flow**: It clones the stored resumed or forked items and returns them, or returns an empty vector for new and cleared histories.

**Call relations**: Resume loading, turn-state snapshots, and history truncation call this when they need the raw saved items.

*Call graph*: called by 3 (load_thread_from_resume_source_or_send_internal, snapshot_turn_state, truncate_before_nth_user_message); 1 external calls (new).


##### `InitialHistory::get_event_msgs`  (lines 2472–2495)

```
fn get_event_msgs(&self) -> Option<Vec<EventMsg>>
```

**Purpose**: Extracts saved event messages from resumed or forked history. These can be sent to a UI to seed visible history.

**Data flow**: It filters rollout items for EventMsg entries, clones those messages, and returns them in a vector; new and cleared histories return None.

**Call relations**: Session creation uses this to include initial messages in a SessionConfigured event.

*Call graph*: called by 1 (new).


##### `InitialHistory::get_base_instructions`  (lines 2497–2512)

```
fn get_base_instructions(&self) -> Option<BaseInstructions>
```

**Purpose**: Finds base model instructions saved in session metadata. These are the core instructions used when reconstructing a session.

**Data flow**: It scans resumed or forked session metadata and returns the first stored BaseInstructions value it finds.

**Call relations**: Resume and fork logic can call this to restore the session’s original instruction baseline.


##### `InitialHistory::get_dynamic_tools`  (lines 2514–2528)

```
fn get_dynamic_tools(&self) -> Option<Vec<DynamicToolSpec>>
```

**Purpose**: Finds dynamic tool definitions saved in session metadata. Dynamic tools are tools supplied at runtime rather than built into the app.

**Data flow**: It scans resumed or forked session metadata and returns the first dynamic_tools list it finds.

**Call relations**: Resume and fork setup use this to restore runtime tool availability.


##### `InitialHistory::get_multi_agent_version`  (lines 2530–2540)

```
fn get_multi_agent_version(&self) -> Option<MultiAgentVersion>
```

**Purpose**: Recovers which multi-agent protocol version applies to initial history. This matters when replaying conversations with sub-agents.

**Data flow**: It passes resumed or forked rollout items to multi_agent_version_from_items, including the resumed thread id when available.

**Call relations**: Multi-agent version resolution calls this during session reconstruction.

*Call graph*: calls 1 internal fn (multi_agent_version_from_items); called by 1 (resolve_multi_agent_version).


##### `InitialHistory::get_resumed_session_sources`  (lines 2542–2545)

```
fn get_resumed_session_sources(&self) -> Option<(SessionSource, Option<ThreadSource>)>
```

**Purpose**: Returns the session source and optional thread source for resumed history. The source says where the session came from, such as CLI, VS Code, or sub-agent.

**Data flow**: It gets resumed session metadata, clones the source fields, and returns them as a pair. Non-resumed histories return None.

**Call relations**: Resume code calls this when restoring analytics and thread-origin information.

*Call graph*: calls 1 internal fn (get_resumed_session_meta); called by 1 (resume_thread_with_history).


##### `InitialHistory::get_resumed_thread_source`  (lines 2547–2550)

```
fn get_resumed_thread_source(&self) -> Option<ThreadSource>
```

**Purpose**: Returns only the thread source from resumed session metadata, if present.

**Data flow**: It gets resumed session metadata and clones its thread_source field.

**Call relations**: Resume-related code can use this shortcut when it only needs thread-source classification.

*Call graph*: calls 1 internal fn (get_resumed_session_meta).


##### `InitialHistory::get_resumed_parent_thread_id`  (lines 2552–2555)

```
fn get_resumed_parent_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the parent thread id from resumed session metadata, if present. This links resumed sub-agent threads back to their parent.

**Data flow**: It gets resumed session metadata and returns the parent_thread_id field.

**Call relations**: Resume-related code uses this when restoring thread hierarchy.

*Call graph*: calls 1 internal fn (get_resumed_session_meta).


##### `InitialHistory::get_resumed_session_meta`  (lines 2557–2567)

```
fn get_resumed_session_meta(&self) -> Option<&SessionMeta>
```

**Purpose**: Finds the session metadata line inside resumed history. It deliberately ignores new, cleared, and forked history for this helper.

**Data flow**: It scans resumed rollout items, returns a reference to the first SessionMeta it finds, or None.

**Call relations**: The resumed-session source, thread-source, and parent-thread-id helpers all call this.

*Call graph*: called by 3 (get_resumed_parent_thread_id, get_resumed_session_sources, get_resumed_thread_source).


##### `session_cwd_from_items`  (lines 2570–2575)

```
fn session_cwd_from_items(items: &[RolloutItem]) -> Option<PathBuf>
```

**Purpose**: Finds a working directory in a list of rollout items. It looks for the session metadata entry that stores cwd.

**Data flow**: It scans the items and returns the cwd from the first SessionMeta item, or None if no metadata item exists.

**Call relations**: InitialHistory::session_cwd calls this for resumed and forked histories.

*Call graph*: called by 1 (session_cwd); 1 external calls (iter).


##### `ThreadSource::as_str`  (lines 2605–2612)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the string label for a thread source. Feature-owned thread sources use their feature label directly.

**Data flow**: It matches the ThreadSource variant and returns user, subagent, memory_consolidation, or the stored feature string.

**Call relations**: ThreadSource::fmt calls this when displaying a thread source.

*Call graph*: called by 1 (fmt).


##### `ThreadSource::fmt`  (lines 2616–2618)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a thread source as its protocol string. This lets it be printed or converted to text consistently.

**Data flow**: It calls as_str and writes that string into the formatter.

**Call relations**: String conversion and logging use this Display implementation.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `ThreadSource::try_from`  (lines 2624–2626)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: Converts a String into a ThreadSource. It delegates to the same parsing rules used for string slices.

**Data flow**: It receives an owned String, parses it, and returns either a ThreadSource or an error string.

**Call relations**: Serde uses this because ThreadSource is represented as a string on the wire.


##### `String::from`  (lines 2630–2632)

```
fn from(value: ThreadSource) -> Self
```

**Purpose**: Converts a ThreadSource back into an owned String. This supports the wire format where thread sources are plain strings.

**Data flow**: It receives a ThreadSource, formats it with to_string, and returns the resulting String.

**Call relations**: Serde uses this when serializing ThreadSource values.

*Call graph*: 1 external calls (to_string).


##### `ThreadSource::from_str`  (lines 2638–2645)

```
fn from_str(value: &str) -> Result<Self, Self::Err>
```

**Purpose**: Parses a thread source from a string. Known labels become built-in variants; any other label becomes a feature-owned source.

**Data flow**: It matches user, subagent, and memory_consolidation specially, and wraps all other strings in ThreadSource::Feature.

**Call relations**: TryFrom<String> and deserialization rely on this parser.

*Call graph*: 1 external calls (Feature).


##### `SessionSource::fmt`  (lines 2676–2687)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a session source as a compact string. This makes source labels stable for logs, metadata, and display.

**Data flow**: It matches the source variant and writes labels such as cli, vscode, internal_memory_consolidation, or subagent_review.

**Call relations**: Display formatting for SessionSource is used wherever session origins are printed or converted to strings.

*Call graph*: 2 external calls (write_str, write!).


##### `SessionSource::from_startup_arg`  (lines 2691–2706)

```
fn from_startup_arg(value: &str) -> Result<Self, &'static str>
```

**Purpose**: Parses a startup argument into a SessionSource. It normalizes whitespace and case, rejects empty values, and maps app-server aliases to MCP.

**Data flow**: It receives a string, trims and lowercases it, maps known names to built-in variants, wraps unknown names as Custom, or returns an error for empty input.

**Call relations**: Startup code calls this when turning command-line or process configuration into protocol metadata.

*Call graph*: 1 external calls (Custom).


##### `SessionSource::is_internal`  (lines 2708–2710)

```
fn is_internal(&self) -> bool
```

**Purpose**: Reports whether the session was created by an internal system process. Internal sessions are not ordinary user-facing root sessions.

**Data flow**: It checks whether the source is SessionSource::Internal and returns a boolean.

**Call relations**: Code that treats internal work differently can use this simple classification.

*Call graph*: 1 external calls (matches!).


##### `SessionSource::is_non_root_agent`  (lines 2712–2717)

```
fn is_non_root_agent(&self) -> bool
```

**Purpose**: Reports whether the session belongs to a non-root agent, either internal or sub-agent. This distinguishes helper agents from the main user thread.

**Data flow**: It returns true for Internal and SubAgent sources, false for normal client sources.

**Call relations**: Multi-agent and session-management code can use this to adjust behavior for child agents.

*Call graph*: 1 external calls (matches!).


##### `SessionSource::get_nickname`  (lines 2719–2726)

```
fn get_nickname(&self) -> Option<String>
```

**Purpose**: Returns the nickname of a spawned sub-agent, if this source has one. Nicknames are optional user-facing labels.

**Data flow**: It checks for a ThreadSpawn sub-agent source and clones its agent_nickname; all other sources return None.

**Call relations**: UI and collaboration status code can call this when showing sub-agent identity.


##### `SessionSource::get_agent_role`  (lines 2728–2735)

```
fn get_agent_role(&self) -> Option<String>
```

**Purpose**: Returns the role of a spawned sub-agent, if this source has one. Roles describe what the sub-agent is meant to do.

**Data flow**: It checks for a ThreadSpawn sub-agent source and clones its agent_role; all other sources return None.

**Call relations**: Collaboration and display code use this to label spawned agents.


##### `SessionSource::get_agent_path`  (lines 2737–2744)

```
fn get_agent_path(&self) -> Option<AgentPath>
```

**Purpose**: Returns the canonical path of a spawned sub-agent, if present. Agent paths identify agents in the multi-agent tree.

**Data flow**: It checks for a ThreadSpawn sub-agent source and clones its agent_path; other sources return None.

**Call relations**: Multi-agent routing and event reporting can use this to recover the agent’s address.


##### `SessionSource::restriction_product`  (lines 2746–2756)

```
fn restriction_product(&self) -> Option<Product>
```

**Purpose**: Maps a session source to a product used for product restrictions, when possible. Normal Codex sources count as Codex, custom sources may map to ChatGPT, Codex, or Atlas, and sub-agents/internal sessions do not guess.

**Data flow**: It matches built-in sources directly or asks Product::from_session_source_name for custom strings. It returns None for internal and sub-agent sources.

**Call relations**: SessionSource::matches_product_restriction calls this before checking whether a restriction applies.

*Call graph*: calls 1 internal fn (from_session_source_name); called by 1 (matches_product_restriction).


##### `SessionSource::matches_product_restriction`  (lines 2758–2763)

```
fn matches_product_restriction(&self, products: &[Product]) -> bool
```

**Purpose**: Checks whether this session source is allowed by a list of product restrictions. An empty restriction list means everything is allowed.

**Data flow**: It receives a product list. If the list is empty it returns true; otherwise it gets the source’s restriction product and asks that product whether it is in the list.

**Call relations**: Restriction checks use this when deciding whether product-scoped behavior applies to a session.

*Call graph*: calls 1 internal fn (restriction_product); 1 external calls (is_empty).


##### `SessionSource::parent_thread_id`  (lines 2765–2776)

```
fn parent_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the parent thread id for sub-agent thread-spawn sessions. Other session sources do not have a parent thread here.

**Data flow**: It delegates to SubAgentSource::parent_thread_id for sub-agent sources and returns None otherwise.

**Call relations**: Thread hierarchy code uses this to link child agent sessions to their parent.


##### `SubAgentSource::fmt`  (lines 2780–2794)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a sub-agent source as a string label. Thread-spawn sources include the parent thread and depth in the label.

**Data flow**: It matches the sub-agent source and writes labels such as review, compact, memory_consolidation, or thread_spawn_<id>_d<depth>.

**Call relations**: SessionSource::fmt uses this when formatting sub-agent session sources.

*Call graph*: 2 external calls (write_str, write!).


##### `SubAgentSource::kind`  (lines 2798–2806)

```
fn kind(&self) -> &str
```

**Purpose**: Returns a short category name for a sub-agent source. Unlike Display, it does not include specific parent ids or depth.

**Data flow**: It matches the variant and returns review, compact, thread_spawn, memory_consolidation, or the stored Other string.

**Call relations**: Sub-agent naming code calls this to produce stable source categories.

*Call graph*: called by 1 (subagent_source_name).


##### `SubAgentSource::parent_thread_id`  (lines 2808–2818)

```
fn parent_thread_id(&self) -> Option<ThreadId>
```

**Purpose**: Returns the parent thread id for a thread-spawn sub-agent. Other sub-agent source types do not carry a parent thread id.

**Data flow**: It matches ThreadSpawn and returns its parent_thread_id, otherwise None.

**Call relations**: SessionSource::parent_thread_id delegates to this for sub-agent sources.


##### `InternalSessionSource::fmt`  (lines 2822–2826)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats an internal session source as text. Currently it supports memory consolidation.

**Data flow**: It writes memory_consolidation into the formatter for the only internal source variant.

**Call relations**: SessionSource::fmt uses this when displaying internal sessions.

*Call graph*: 1 external calls (write_str).


##### `multi_agent_version_from_items`  (lines 2829–2852)

```
fn multi_agent_version_from_items(
    items: &[RolloutItem],
    thread_id: Option<ThreadId>,
) -> Option<MultiAgentVersion>
```

**Purpose**: Finds the applicable multi-agent protocol version from rollout history. It prefers the newest matching session metadata, then falls back to turn context entries.

**Data flow**: It receives rollout items and an optional thread id. It scans backward for matching SessionMeta with a version, and if none is found scans backward for a TurnContext version.

**Call relations**: InitialHistory::get_multi_agent_version calls this during resume or fork reconstruction.

*Call graph*: called by 1 (get_multi_agent_version); 1 external calls (iter).


##### `SessionMeta::default`  (lines 2911–2931)

```
fn default() -> Self
```

**Purpose**: Creates an empty SessionMeta value with safe default fields. This is useful for tests and for gradually filling metadata.

**Data flow**: It sets ids to defaults, strings and paths to empty values, source to its default, and optional fields to None.

**Call relations**: Thread creation and tests use this as a starting point for session metadata.

*Call graph*: calls 1 internal fn (default); called by 6 (read_summary_from_rollout_preserves_agent_nickname, read_summary_from_rollout_preserves_forked_from_id, read_summary_from_rollout_returns_empty_preview_when_no_user_message, session_meta_item, session_meta_normalizes_legacy_dynamic_tools, create_thread); 3 external calls (new, new, default).


##### `ResponseItem::from`  (lines 2964–2974)

```
fn from(value: CompactedItem) -> Self
```

**Purpose**: Turns a compacted-history item into an assistant message response item. This lets compacted summaries re-enter model history as normal assistant text.

**Data flow**: It receives a CompactedItem, takes its message text, wraps it as output text in a ResponseItem::Message, and returns it.

**Call relations**: History reconstruction can use this conversion when replacing long history with a compact summary.

*Call graph*: 1 external calls (vec!).


##### `TurnContextItem::permission_profile`  (lines 3029–3044)

```
fn permission_profile(&self) -> PermissionProfile
```

**Purpose**: Returns the effective permission profile for a turn. If a modern profile is already stored, it uses that; otherwise it rebuilds one from legacy sandbox fields.

**Data flow**: It checks permission_profile. If present, it clones and returns it. If absent, it derives filesystem, enforcement, and network settings from the legacy sandbox policy and current directory, then builds a PermissionProfile.

**Call relations**: Filesystem reconstruction and turn-context application call this when replaying saved context.

*Call graph*: called by 2 (filesystem_from_turn_context_item, apply_turn_context).


##### `TruncationPolicy::from`  (lines 3055–3060)

```
fn from(config: crate::openai_models::TruncationPolicyConfig) -> Self
```

**Purpose**: Converts an OpenAI model truncation config into this protocol’s truncation policy. Truncation limits can be measured in bytes or tokens.

**Data flow**: It receives a config with mode and limit, then returns Bytes(limit) or Tokens(limit) depending on the mode.

**Call relations**: Configuration code uses this when turning model settings into the protocol type used by truncation helpers.

*Call graph*: 2 external calls (Bytes, Tokens).


##### `TruncationPolicy::token_budget`  (lines 3064–3072)

```
fn token_budget(&self) -> usize
```

**Purpose**: Returns the policy’s limit expressed as approximate tokens. Tokens are model text units; byte limits are converted approximately.

**Data flow**: It returns the stored token count for token policies, or converts byte count to approximate tokens for byte policies.

**Call relations**: Model output sizing and function-output truncation call this when they need a token budget.

*Call graph*: called by 2 (model_output_max_tokens, truncate_function_output_items_with_policy); 2 external calls (approx_tokens_from_byte_count, try_from).


##### `TruncationPolicy::byte_budget`  (lines 3074–3081)

```
fn byte_budget(&self) -> usize
```

**Purpose**: Returns the policy’s limit expressed as approximate bytes. This helps code that truncates raw text by byte length.

**Data flow**: It returns the stored byte count for byte policies, or converts token count to approximate bytes for token policies.

**Call relations**: Text and tool-output truncation code calls this when it needs a byte budget.

*Call graph*: called by 3 (formatted_truncate_text, formatted_truncate_text_content_items_with_policy, truncate_function_output_items_with_policy); 1 external calls (approx_bytes_for_tokens).


##### `TruncationPolicy::mul`  (lines 3087–3096)

```
fn mul(self, multiplier: f64) -> Self::Output
```

**Purpose**: Scales a truncation policy by a floating-point multiplier. This allows callers to reserve a fraction or multiple of an existing budget.

**Data flow**: It receives a policy and multiplier, multiplies the stored limit, rounds up, and returns the same kind of policy with the scaled limit.

**Call relations**: Any code adjusting truncation budgets can use this arithmetic operator.

*Call graph*: 2 external calls (Bytes, Tokens).


##### `ReviewOutputEvent::default`  (lines 3172–3179)

```
fn default() -> Self
```

**Purpose**: Creates an empty review result. This is useful when a review completes without findings or before real results are available.

**Data flow**: It returns ReviewOutputEvent with an empty findings list, empty correctness and explanation strings, and confidence score 0.0.

**Call relations**: Review-related code and tests can use this as a neutral starting value.

*Call graph*: 2 external calls (default, new).


##### `McpAuthStatus::fmt`  (lines 3465–3473)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats an MCP authentication status for people to read. MCP is the Model Context Protocol for external tools.

**Data flow**: It maps the enum to labels like Unsupported, Not logged in, Bearer token, or OAuth and writes the label to the formatter.

**Call relations**: Display code uses this whenever MCP auth status is shown in text.

*Call graph*: 1 external calls (write_str).


##### `Product::to_app_platform`  (lines 3493–3499)

```
fn to_app_platform(self) -> &'static str
```

**Purpose**: Maps a product enum to the app-platform string used by downstream systems. For example, ChatGPT becomes chat.

**Data flow**: It receives a Product and returns chat, codex, or atlas.

**Call relations**: Product integration code can use this when sending product identity to platform services.


##### `Product::from_session_source_name`  (lines 3501–3509)

```
fn from_session_source_name(value: &str) -> Option<Self>
```

**Purpose**: Tries to recognize a product from a session-source name. It accepts chatgpt, codex, and atlas after trimming and lowercasing.

**Data flow**: It receives a string, normalizes it, and returns the matching Product or None.

**Call relations**: SessionSource::restriction_product calls this for custom session sources.

*Call graph*: called by 1 (restriction_product).


##### `Product::matches_product_restriction`  (lines 3511–3513)

```
fn matches_product_restriction(&self, products: &[Product]) -> bool
```

**Purpose**: Checks whether this product is allowed by a product restriction list. An empty list means no restriction.

**Data flow**: It receives a product list and returns true when the list is empty or contains this product.

**Call relations**: Session-source restriction checks use this after mapping a source to a product.

*Call graph*: 2 external calls (contains, is_empty).


##### `SessionConfiguredEvent::deserialize`  (lines 3658–3725)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Customizes how session-configured events are read from JSON so older saved sessions still load. Older rollouts stored sandbox_policy instead of permission_profile.

**Data flow**: It deserializes an internal wire shape, chooses permission_profile if present, otherwise converts legacy sandbox_policy using cwd, errors if neither exists, fills thread_id from session_id when absent, and returns SessionConfiguredEvent.

**Call relations**: Serde calls this whenever SessionConfiguredEvent is deserialized from saved history or incoming JSON.

*Call graph*: calls 1 internal fn (from_legacy_sandbox_policy_for_cwd); 2 external calls (deserialize, missing_field).


##### `validate_thread_goal_objective`  (lines 3742–3752)

```
fn validate_thread_goal_objective(value: &str) -> Result<(), String>
```

**Purpose**: Validates the text objective for a long-running thread goal. It prevents empty goals and overly large goal text.

**Data flow**: It receives a string. It returns an error if the string is empty or exceeds the maximum character count; otherwise it returns Ok.

**Call relations**: Thread-goal creation and update handlers call this before accepting a goal.

*Call graph*: called by 2 (set_thread_goal, handle_create); 1 external calls (format!).


##### `ReviewDecision::to_opaque_string`  (lines 3821–3836)

```
fn to_opaque_string(&self) -> &'static str
```

**Purpose**: Returns a privacy-safe label for an approval decision. It avoids exposing details such as specific policy amendments while still preserving decision category.

**Data flow**: It receives a ReviewDecision and maps it to a fixed string like approved, denied, timed_out, or approved_with_network_policy_allow.

**Call relations**: Telemetry or logging code can use this when it needs decision information without personal or sensitive details.


##### `tests::feature_thread_source_serializes_as_its_app_owned_label`  (lines 4142–4151)

```
fn feature_thread_source_serializes_as_its_app_owned_label() -> Result<()>
```

**Purpose**: Tests that feature-owned thread sources serialize as their feature label and deserialize back correctly.

**Data flow**: It creates a ThreadSource::Feature, converts it to JSON, reads it back, and asserts both directions preserve the label.

**Call relations**: The Rust test runner calls this to protect the ThreadSource wire format.

*Call graph*: 2 external calls (Feature, assert_eq!).


##### `tests::session_meta_normalizes_legacy_dynamic_tools`  (lines 4154–4204)

```
fn session_meta_normalizes_legacy_dynamic_tools() -> Result<()>
```

**Purpose**: Tests that old dynamic-tool JSON is normalized into the current grouped dynamic-tool shape.

**Data flow**: It builds SessionMeta JSON with legacy dynamic tools, deserializes it, and compares the resulting dynamic_tools field to the expected modern structure.

**Call relations**: The test runner uses this to ensure old rollout metadata remains readable.

*Call graph*: calls 1 internal fn (default); 4 external calls (assert_eq!, json!, from_value, to_value).


##### `tests::sorted_writable_roots`  (lines 4206–4221)

```
fn sorted_writable_roots(roots: Vec<WritableRoot>) -> Vec<(PathBuf, Vec<PathBuf>)>
```

**Purpose**: Helper for tests that turns writable roots into sorted plain paths. Sorting makes assertions stable regardless of input order.

**Data flow**: It receives WritableRoot values, converts roots and read-only subpaths to PathBufs, sorts subpaths and roots, and returns pairs.

**Call relations**: Filesystem sandbox tests call this before comparing expected and actual writable roots.


##### `tests::sandbox_policy_allows_read`  (lines 4223–4225)

```
fn sandbox_policy_allows_read(policy: &SandboxPolicy, _path: &Path, _cwd: &Path) -> bool
```

**Purpose**: Test helper that asks whether a legacy sandbox policy allows reading a path. In this legacy model it just checks full disk read access.

**Data flow**: It receives a policy, path, and cwd, ignores the path and cwd, and returns policy.has_full_disk_read_access().

**Call relations**: Sandbox semantic comparison tests call this for each probe path.

*Call graph*: 1 external calls (has_full_disk_read_access).


##### `tests::sandbox_policy_allows_write`  (lines 4227–4236)

```
fn sandbox_policy_allows_write(policy: &SandboxPolicy, path: &Path, cwd: &Path) -> bool
```

**Purpose**: Test helper that asks whether a legacy sandbox policy allows writing a path. It checks full write access first, then scoped writable roots.

**Data flow**: It receives a policy, path, and cwd. If full write access is allowed it returns true; otherwise it builds writable roots for cwd and checks whether any root accepts the path.

**Call relations**: Sandbox semantic comparison tests call this when verifying legacy-to-new policy conversion.

*Call graph*: 2 external calls (get_writable_roots_with_cwd, has_full_disk_write_access).


##### `tests::session_source_from_startup_arg_maps_known_values`  (lines 4239–4248)

```
fn session_source_from_startup_arg_maps_known_values()
```

**Purpose**: Tests that known startup source names map to the expected SessionSource variants.

**Data flow**: It parses vscode and app-server and asserts they become VSCode and Mcp.

**Call relations**: The test runner calls this to protect startup-source parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::inter_agent_communication_response_input_item_preserves_commentary_phase`  (lines 4251–4272)

```
fn inter_agent_communication_response_input_item_preserves_commentary_phase()
```

**Purpose**: Tests that inter-agent communication converted to a response input item is marked as commentary.

**Data flow**: It builds a communication, converts it, and asserts the result is an assistant message containing serialized JSON with commentary phase.

**Call relations**: The test runner calls this to prevent regressions in inter-agent history formatting.

*Call graph*: calls 1 internal fn (root); 2 external calls (assert_eq!, vec!).


##### `tests::queued_encrypted_inter_agent_communication_renders_message_envelope`  (lines 4275–4301)

```
fn queued_encrypted_inter_agent_communication_renders_message_envelope()
```

**Purpose**: Tests that encrypted inter-agent communication creates the expected model-visible envelope plus encrypted payload.

**Data flow**: It builds an encrypted communication, converts it to a model input item, and asserts the author, recipient, envelope text, and encrypted content match expectations.

**Call relations**: The test runner calls this to ensure encrypted messages are represented safely and consistently.

*Call graph*: calls 2 internal fn (root, new_encrypted); 2 external calls (new, assert_eq!).


##### `tests::session_source_from_startup_arg_normalizes_custom_values`  (lines 4304–4313)

```
fn session_source_from_startup_arg_normalizes_custom_values()
```

**Purpose**: Tests that custom startup source strings are trimmed and lowercased.

**Data flow**: It parses atlas and a spaced mixed-case Atlas string and asserts both become Custom("atlas").

**Call relations**: The test runner calls this to protect normalization behavior for custom sources.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_source_restriction_product_defaults_non_subagent_sources_to_codex`  (lines 4316–4337)

```
fn session_source_restriction_product_defaults_non_subagent_sources_to_codex()
```

**Purpose**: Tests that normal non-sub-agent sources default to the Codex product for restriction checks.

**Data flow**: It asks restriction_product for CLI, VSCode, Exec, MCP, and Unknown and asserts each returns Codex.

**Call relations**: The test runner calls this to keep product-restriction defaults stable.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_source_restriction_product_does_not_guess_subagent_products`  (lines 4340–4350)

```
fn session_source_restriction_product_does_not_guess_subagent_products()
```

**Purpose**: Tests that sub-agent and internal sessions do not guess a product restriction identity.

**Data flow**: It checks a review sub-agent and memory-consolidation internal source and asserts restriction_product returns None.

**Call relations**: The test runner calls this to protect sub-agent restriction behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_source_restriction_product_maps_custom_sources_to_products`  (lines 4353–4370)

```
fn session_source_restriction_product_maps_custom_sources_to_products()
```

**Purpose**: Tests that custom source names matching product names map to those products.

**Data flow**: It checks chatgpt, ATLAS, codex, and atlas-dev and asserts only recognized product names map to Product values.

**Call relations**: The test runner calls this to verify custom-source product matching.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::session_source_matches_product_restriction`  (lines 4373–4388)

```
fn session_source_matches_product_restriction()
```

**Purpose**: Tests the full product-restriction matching behavior for session sources.

**Data flow**: It checks matching, non-matching, default Codex, unknown custom source, and empty-restriction cases using assertions.

**Call relations**: The test runner calls this to protect restriction logic used by session gating.

*Call graph*: 1 external calls (assert!).


##### `tests::sandbox_policy_probe_paths`  (lines 4390–4403)

```
fn sandbox_policy_probe_paths(policy: &SandboxPolicy, cwd: &Path) -> Vec<PathBuf>
```

**Purpose**: Builds a stable set of paths to probe when comparing sandbox policies. It includes cwd, writable roots, and read-only subpaths.

**Data flow**: It receives a policy and cwd, collects relevant paths, sorts and deduplicates them, and returns the list.

**Call relations**: assert_same_sandbox_policy_semantics calls this for both expected and actual policies.

*Call graph*: 2 external calls (get_writable_roots_with_cwd, vec!).


##### `tests::assert_same_sandbox_policy_semantics`  (lines 4405–4441)

```
fn assert_same_sandbox_policy_semantics(
        expected: &SandboxPolicy,
        actual: &SandboxPolicy,
        cwd: &Path,
    )
```

**Purpose**: Asserts that two sandbox policies behave the same for read, write, and network access. This is a test-only semantic comparison.

**Data flow**: It compares full-access flags, builds probe paths from both policies, then checks read and write answers match for every path.

**Call relations**: Legacy sandbox bridge tests call this after converting between old and new policy forms.

*Call graph*: 2 external calls (assert_eq!, sandbox_policy_probe_paths).


##### `tests::external_sandbox_reports_full_access_flags`  (lines 4444–4456)

```
fn external_sandbox_reports_full_access_flags()
```

**Purpose**: Tests full-access reporting for external sandbox policies. External sandboxes are assumed to control disk access outside Codex.

**Data flow**: It builds restricted-network and enabled-network external policies, then asserts disk write is full and network follows the network setting.

**Call relations**: The test runner calls this to protect external sandbox semantics.

*Call graph*: 1 external calls (assert!).


##### `tests::read_only_reports_network_access_flags`  (lines 4459–4467)

```
fn read_only_reports_network_access_flags()
```

**Purpose**: Tests that read-only sandbox policies report network access according to their network flag.

**Data flow**: It checks the default read-only policy has no network and an explicit network-enabled read-only policy does.

**Call relations**: The test runner calls this to protect read-only network reporting.

*Call graph*: 2 external calls (new_read_only_policy, assert!).


##### `tests::granular_approval_config_mcp_elicitation_flag_is_field_driven`  (lines 4470–4491)

```
fn granular_approval_config_mcp_elicitation_flag_is_field_driven()
```

**Purpose**: Tests that MCP elicitation approval behavior follows the mcp_elicitations field exactly.

**Data flow**: It builds configs with that field true and false and asserts the helper returns matching booleans.

**Call relations**: The test runner calls this to protect granular approval settings.

*Call graph*: 1 external calls (assert!).


##### `tests::granular_approval_config_skill_approval_flag_is_field_driven`  (lines 4494–4515)

```
fn granular_approval_config_skill_approval_flag_is_field_driven()
```

**Purpose**: Tests that skill approval behavior follows the skill_approval field exactly.

**Data flow**: It builds configs with skill_approval true and false and asserts the helper returns matching booleans.

**Call relations**: The test runner calls this to protect skill approval settings.

*Call graph*: 1 external calls (assert!).


##### `tests::granular_approval_config_request_permissions_flag_is_field_driven`  (lines 4518–4539)

```
fn granular_approval_config_request_permissions_flag_is_field_driven()
```

**Purpose**: Tests that request-permissions approval behavior follows its field exactly.

**Data flow**: It builds configs with request_permissions true and false and asserts the helper returns matching booleans.

**Call relations**: The test runner calls this to protect request-permissions approval settings.

*Call graph*: 1 external calls (assert!).


##### `tests::granular_approval_config_defaults_missing_optional_flags_to_false`  (lines 4542–4560)

```
fn granular_approval_config_defaults_missing_optional_flags_to_false()
```

**Purpose**: Tests that newly added optional granular approval fields default to false when missing from JSON.

**Data flow**: It deserializes JSON without optional fields and asserts the resulting config fills those fields with false.

**Call relations**: The test runner calls this to preserve backward compatibility with older config JSON.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::restricted_file_system_policy_reports_full_access_from_root_entries`  (lines 4563–4582)

```
fn restricted_file_system_policy_reports_full_access_from_root_entries()
```

**Purpose**: Tests full disk access detection for restricted filesystem policies that mention the filesystem root.

**Data flow**: It builds root read and root write policies and asserts their full read/write flags and platform-default behavior.

**Call relations**: The test runner calls this to protect new filesystem sandbox semantics.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert!, vec!).


##### `tests::restricted_file_system_policy_treats_root_with_carveouts_as_scoped_access`  (lines 4585–4636)

```
fn restricted_file_system_policy_treats_root_with_carveouts_as_scoped_access()
```

**Purpose**: Tests that a root write policy with a denied subpath is treated as scoped rather than full access.

**Data flow**: It creates a temp workspace, builds a root-write policy with a blocked path, and asserts readable, unreadable, and writable roots reflect the carve-out.

**Call relations**: The test runner calls this to ensure deny carve-outs reduce effective access.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_path_against_base); 5 external calls (new, assert!, assert_eq!, canonicalize_preserving_symlinks, vec!).


##### `tests::restricted_file_system_policy_derives_effective_paths`  (lines 4639–4706)

```
fn restricted_file_system_policy_derives_effective_paths()
```

**Purpose**: Tests that restricted filesystem policy expands special project-root and minimal entries into concrete paths.

**Data flow**: It creates a temp workspace with metadata folders, builds a policy with project-root write and a denied secret path, and asserts readable/unreadable/writable roots include the expected protected paths.

**Call relations**: The test runner calls this to verify symbolic filesystem permissions resolve correctly.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_path_against_base); 6 external calls (new, assert!, assert_eq!, canonicalize_preserving_symlinks, create_dir_all, vec!).


##### `tests::restricted_file_system_policy_treats_read_entries_as_read_only_subpaths`  (lines 4709–4753)

```
fn restricted_file_system_policy_treats_read_entries_as_read_only_subpaths()
```

**Purpose**: Tests that read-only entries inside a writable area become read-only subpaths.

**Data flow**: It builds a policy where project roots are writable but docs is read-only and docs/public is writable, then compares sorted writable roots to the expected carve-outs.

**Call relations**: The test runner calls this to protect mixed read/write filesystem policy behavior.

*Call graph*: calls 3 internal fn (restricted, from_absolute_path, resolve_path_against_base); 5 external calls (new, assert!, assert_eq!, canonicalize_preserving_symlinks, vec!).


##### `tests::file_system_policy_rejects_legacy_bridge_for_non_workspace_writes`  (lines 4756–4783)

```
fn file_system_policy_rejects_legacy_bridge_for_non_workspace_writes()
```

**Purpose**: Tests that converting new filesystem policies back to legacy sandbox policy fails when writes are outside the workspace.

**Data flow**: It builds a policy with an external writable path, tries to convert it to the legacy policy, and asserts the error explains the unsupported write.

**Call relations**: The test runner calls this to make sure unsupported legacy conversions fail loudly.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (new, assert!, cfg!, vec!).


##### `tests::legacy_sandbox_policy_semantics_survive_split_bridge`  (lines 4786–4822)

```
fn legacy_sandbox_policy_semantics_survive_split_bridge()
```

**Purpose**: Tests that converting legacy sandbox policy to split filesystem/network policy and back preserves behavior.

**Data flow**: It creates several legacy policy variants, converts each through the bridge, and compares read, write, and network semantics.

**Call relations**: The test runner calls this to protect compatibility while moving from one combined sandbox type to separate policies.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_for_cwd, from, resolve_path_against_base); 3 external calls (new, assert_same_sandbox_policy_semantics, vec!).


##### `tests::item_started_event_from_web_search_emits_begin_event`  (lines 4825–4846)

```
fn item_started_event_from_web_search_emits_begin_event()
```

**Purpose**: Tests that a new item-started web search event produces the old WebSearchBegin event.

**Data flow**: It builds an ItemStartedEvent with a WebSearch item, converts to legacy events, and asserts one matching begin event appears.

**Call relations**: The test runner calls this to protect legacy UI compatibility for web search starts.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, WebSearch, panic!).


##### `tests::item_started_event_from_non_web_search_emits_no_legacy_events`  (lines 4849–4862)

```
fn item_started_event_from_non_web_search_emits_no_legacy_events()
```

**Purpose**: Tests that item-started events for ordinary user messages do not create legacy begin events.

**Data flow**: It builds an ItemStartedEvent with a UserMessage item and asserts legacy conversion returns an empty list.

**Call relations**: The test runner calls this to prevent unwanted duplicate legacy events.

*Call graph*: calls 2 internal fn (new, new); 2 external calls (assert!, UserMessage).


##### `tests::item_started_event_from_image_generation_emits_begin_event`  (lines 4865–4885)

```
fn item_started_event_from_image_generation_emits_begin_event()
```

**Purpose**: Tests that an image-generation item start produces the old ImageGenerationBegin event.

**Data flow**: It builds an ItemStartedEvent with an ImageGeneration item and checks the legacy event call id.

**Call relations**: The test runner calls this to protect legacy image-generation start events.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, ImageGeneration, panic!).


##### `tests::item_started_event_from_file_change_emits_patch_begin_event`  (lines 4888–4921)

```
fn item_started_event_from_file_change_emits_patch_begin_event()
```

**Purpose**: Tests that a file-change item start produces the old PatchApplyBegin event.

**Data flow**: It builds a file-change item with an added file, converts it, and asserts call id, turn id, auto-approval, and changed file data are preserved.

**Call relations**: The test runner calls this to protect legacy patch-start events.

*Call graph*: calls 1 internal fn (new); 5 external calls (from, assert!, assert_eq!, FileChange, panic!).


##### `tests::item_started_event_from_mcp_tool_call_emits_begin_event`  (lines 4924–4958)

```
fn item_started_event_from_mcp_tool_call_emits_begin_event()
```

**Purpose**: Tests that an MCP tool-call item start produces the old McpToolCallBegin event.

**Data flow**: It builds an MCP tool-call item, converts it, and asserts server, tool, app resource URI, and plugin id are preserved.

**Call relations**: The test runner calls this to protect legacy MCP tool-call start events.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, McpToolCall, json!, panic!).


##### `tests::item_completed_event_from_image_generation_emits_end_event`  (lines 4961–4990)

```
fn item_completed_event_from_image_generation_emits_end_event()
```

**Purpose**: Tests that a completed image-generation item produces the old ImageGenerationEnd event.

**Data flow**: It builds a completed image-generation item, converts it, and asserts status, revised prompt, result data, and saved path are preserved.

**Call relations**: The test runner calls this to protect legacy image-generation completion events.

*Call graph*: calls 1 internal fn (new); 4 external calls (assert_eq!, ImageGeneration, test_path_buf, panic!).


##### `tests::item_completed_event_from_file_change_emits_patch_end_event`  (lines 4993–5028)

```
fn item_completed_event_from_file_change_emits_patch_end_event()
```

**Purpose**: Tests that a completed file-change item produces the old PatchApplyEnd event.

**Data flow**: It builds a completed file-change item, converts it, and asserts call id, turn id, output text, success status, and changed files are preserved.

**Call relations**: The test runner calls this to protect legacy patch-completion events.

*Call graph*: calls 1 internal fn (new); 6 external calls (from, new, assert!, assert_eq!, FileChange, panic!).


##### `tests::item_completed_event_from_mcp_tool_call_emits_end_event`  (lines 5031–5072)

```
fn item_completed_event_from_mcp_tool_call_emits_end_event()
```

**Purpose**: Tests that a completed MCP tool-call item produces the old McpToolCallEnd event.

**Data flow**: It builds a successful MCP tool-call item with duration and result, converts it, and asserts metadata and success detection are correct.

**Call relations**: The test runner calls this to protect legacy MCP tool-call completion events.

*Call graph*: calls 1 internal fn (new); 7 external calls (from_millis, assert!, assert_eq!, McpToolCall, json!, panic!, vec!).


##### `tests::item_started_event_requires_started_at_ms`  (lines 5075–5086)

```
fn item_started_event_requires_started_at_ms()
```

**Purpose**: Tests that started_at_ms is required when deserializing ItemStartedEvent.

**Data flow**: It serializes an event, removes started_at_ms from the JSON, and asserts deserialization fails.

**Call relations**: The test runner calls this to enforce the item-started event contract.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert!, UserMessage, to_value).


##### `tests::item_completed_event_defaults_missing_completed_at_ms`  (lines 5089–5101)

```
fn item_completed_event_defaults_missing_completed_at_ms()
```

**Purpose**: Tests that missing completed_at_ms in old ItemCompletedEvent JSON defaults to 0.

**Data flow**: It serializes an event, removes completed_at_ms, deserializes it, and asserts the field is 0.

**Call relations**: The test runner calls this to protect backward compatibility with old rollout files.

*Call graph*: calls 2 internal fn (new, new); 3 external calls (assert_eq!, UserMessage, to_value).


##### `tests::rollback_failed_error_does_not_affect_turn_status`  (lines 5103–5109)

```
fn rollback_failed_error_does_not_affect_turn_status()
```

**Purpose**: Tests that rollback failure errors do not mark the current turn as failed.

**Data flow**: It builds an ErrorEvent with ThreadRollbackFailed and asserts affects_turn_status returns false.

**Call relations**: The test runner calls this to protect turn-status replay behavior.

*Call graph*: 1 external calls (assert!).


##### `tests::active_turn_not_steerable_error_does_not_affect_turn_status`  (lines 5112–5120)

```
fn active_turn_not_steerable_error_does_not_affect_turn_status()
```

**Purpose**: Tests that non-steerable active-turn errors do not mark the current turn as failed.

**Data flow**: It builds an ErrorEvent for a non-steerable review turn and asserts affects_turn_status returns false.

**Call relations**: The test runner calls this to protect turn-status handling for rejected steering.

*Call graph*: 1 external calls (assert!).


##### `tests::generic_error_affects_turn_status`  (lines 5123–5129)

```
fn generic_error_affects_turn_status()
```

**Purpose**: Tests that generic Codex errors do mark the current turn as failed.

**Data flow**: It builds an ErrorEvent with CodexErrorInfo::Other and asserts affects_turn_status returns true.

**Call relations**: The test runner calls this to keep ordinary error replay behavior intact.

*Call graph*: 1 external calls (assert!).


##### `tests::realtime_conversation_started_event_uses_realtime_session_id`  (lines 5132–5145)

```
fn realtime_conversation_started_event_uses_realtime_session_id()
```

**Purpose**: Tests the JSON shape for realtime conversation start events.

**Data flow**: It builds a started event with a realtime session id and version, serializes it, and compares the JSON to the expected field names and values.

**Call relations**: The test runner calls this to protect realtime event wire compatibility.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::realtime_voice_list_is_stable`  (lines 5148–5179)

```
fn realtime_voice_list_is_stable()
```

**Purpose**: Tests that the built-in realtime voice list and defaults stay unchanged unless intentionally updated.

**Data flow**: It calls RealtimeVoicesList::builtin and compares it to the exact expected v1 and v2 voice lists.

**Call relations**: The test runner calls this to catch accidental voice-list changes.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::user_input_text_serializes_empty_text_elements`  (lines 5182–5199)

```
fn user_input_text_serializes_empty_text_elements() -> Result<()>
```

**Purpose**: Tests that text user input keeps an explicit empty text_elements list in JSON.

**Data flow**: It builds a text UserInput with no text elements, serializes it, and compares the JSON.

**Call relations**: The test runner calls this to protect UI text-element serialization.

*Call graph*: 3 external calls (new, assert_eq!, to_value).


##### `tests::user_message_event_serializes_empty_metadata_vectors`  (lines 5202–5223)

```
fn user_message_event_serializes_empty_metadata_vectors() -> Result<()>
```

**Purpose**: Tests which empty fields are kept when serializing a user-message event.

**Data flow**: It builds a UserMessageEvent with empty local_images and text_elements, serializes it, and asserts the expected JSON remains.

**Call relations**: The test runner calls this to keep user-message JSON stable.

*Call graph*: 4 external calls (default, new, assert_eq!, to_value).


##### `tests::user_message_event_deserializes_without_image_detail_fields`  (lines 5226–5245)

```
fn user_message_event_deserializes_without_image_detail_fields() -> Result<()>
```

**Purpose**: Tests that older user-message JSON without image detail fields still deserializes.

**Data flow**: It deserializes JSON containing images and local_images but no detail arrays, then asserts the missing detail fields become empty vectors.

**Call relations**: The test runner calls this to preserve backward compatibility for message history.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::user_message_item_legacy_event_preserves_image_details`  (lines 5248–5281)

```
fn user_message_item_legacy_event_preserves_image_details()
```

**Purpose**: Tests that converting a user-message item to a legacy event preserves image detail hints.

**Data flow**: It builds a user-message item with remote and local images, converts it to a legacy UserMessage event, and asserts image URLs, local paths, client id, and detail hints are preserved.

**Call relations**: The test runner calls this to protect image replay and history editing behavior.

*Call graph*: calls 1 internal fn (new); 3 external calls (from, assert_eq!, panic!).


##### `tests::turn_aborted_event_deserializes_without_turn_id`  (lines 5284–5301)

```
fn turn_aborted_event_deserializes_without_turn_id() -> Result<()>
```

**Purpose**: Tests that old turn_aborted events without turn_id still load.

**Data flow**: It deserializes JSON with only type and reason and asserts the resulting event has turn_id None and the expected reason.

**Call relations**: The test runner calls this to protect backward compatibility with old abort events.

*Call graph*: 4 external calls (assert_eq!, json!, panic!, from_value).


##### `tests::turn_context_item_deserializes_without_network`  (lines 5304–5317)

```
fn turn_context_item_deserializes_without_network() -> Result<()>
```

**Purpose**: Tests that old turn-context items without network information still deserialize.

**Data flow**: It deserializes a minimal TurnContextItem JSON and asserts optional network, filesystem policy, and comp_hash fields are None.

**Call relations**: The test runner calls this to keep older rollout files readable.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::multi_agent_version_uses_newest_present_session_meta_value`  (lines 5320–5350)

```
fn multi_agent_version_uses_newest_present_session_meta_value() -> Result<()>
```

**Purpose**: Tests that multi-agent version lookup uses the newest available version even if later metadata omits the field.

**Data flow**: It builds two session metadata rollout items for the same thread, one with a version and one without, then asserts lookup returns the stored version.

**Call relations**: The test runner calls this to protect multi-agent history reconstruction.

*Call graph*: calls 1 internal fn (from_string); 2 external calls (default, assert_eq!).


##### `tests::turn_context_item_serializes_network_when_present`  (lines 5353–5408)

```
fn turn_context_item_serializes_network_when_present() -> Result<()>
```

**Purpose**: Tests that turn-context network and filesystem sandbox information serialize when present.

**Data flow**: It builds a TurnContextItem with network allow/deny domains and a restricted filesystem policy, serializes it, and checks the JSON fields.

**Call relations**: The test runner calls this to protect turn-context persistence for permissions.

*Call graph*: calls 1 internal fn (restricted); 4 external calls (assert_eq!, test_path_buf, to_value, vec!).


##### `tests::serialize_event`  (lines 5413–5460)

```
fn serialize_event() -> Result<()>
```

**Purpose**: Tests the JSON nesting and field names for a top-level Event containing SessionConfigured.

**Data flow**: It builds a SessionConfigured event, serializes it, and compares against the expected JSON shape.

**Call relations**: The test runner calls this to protect the public event wire format.

*Call graph*: calls 3 internal fn (read_only, from_string, from_string); 6 external calls (new, default, assert_eq!, test_path_buf, json!, SessionConfigured).


##### `tests::deserialize_legacy_session_configured_event_uses_sandbox_policy`  (lines 5463–5480)

```
fn deserialize_legacy_session_configured_event_uses_sandbox_policy() -> Result<()>
```

**Purpose**: Tests that old SessionConfigured JSON with sandbox_policy but no permission_profile still loads.

**Data flow**: It deserializes legacy JSON and asserts the permission_profile is derived as read-only.

**Call relations**: The test runner calls this to verify the custom deserializer’s backward-compatible path.

*Call graph*: 4 external calls (assert_eq!, test_path_buf, json!, from_value).


##### `tests::vec_u8_as_base64_serialization_and_deserialization`  (lines 5483–5498)

```
fn vec_u8_as_base64_serialization_and_deserialization() -> Result<()>
```

**Purpose**: Tests that command output byte chunks are encoded as base64 strings in JSON and decoded back.

**Data flow**: It serializes an ExecCommandOutputDeltaEvent with raw bytes, compares the JSON string, deserializes it, and asserts the original event is recovered.

**Call relations**: The test runner calls this to protect binary command-output transport.

*Call graph*: 4 external calls (assert_eq!, from_str, to_string, vec!).


##### `tests::serialize_mcp_startup_update_event`  (lines 5501–5518)

```
fn serialize_mcp_startup_update_event() -> Result<()>
```

**Purpose**: Tests the JSON shape for an MCP startup update event, especially failed status.

**Data flow**: It builds an Event with McpStartupUpdate failed status, serializes it, and checks type, server, state, and error fields.

**Call relations**: The test runner calls this to protect MCP startup event serialization.

*Call graph*: 3 external calls (assert_eq!, McpStartupUpdate, to_value).


##### `tests::serialize_mcp_startup_complete_event`  (lines 5521–5541)

```
fn serialize_mcp_startup_complete_event() -> Result<()>
```

**Purpose**: Tests the JSON shape for the aggregate MCP startup completion event.

**Data flow**: It builds an event with ready, failed, and cancelled server lists, serializes it, and checks the expected values.

**Call relations**: The test runner calls this to protect MCP startup summary serialization.

*Call graph*: 4 external calls (assert_eq!, McpStartupComplete, to_value, vec!).


##### `tests::token_usage_info_new_or_append_updates_context_window_when_provided`  (lines 5544–5562)

```
fn token_usage_info_new_or_append_updates_context_window_when_provided()
```

**Purpose**: Tests that token usage updates replace the stored context-window size when a new size is provided.

**Data flow**: It starts with usage info containing one context-window size, appends latest usage with another size, and asserts the new size is stored.

**Call relations**: The test runner calls this to protect token-usage context-window updates.

*Call graph*: calls 1 internal fn (new_or_append); 2 external calls (assert_eq!, default).


##### `tests::token_usage_info_new_or_append_preserves_context_window_when_not_provided`  (lines 5565–5584)

```
fn token_usage_info_new_or_append_preserves_context_window_when_not_provided()
```

**Purpose**: Tests that token usage updates keep the old context-window size when no new size is provided.

**Data flow**: It starts with usage info containing a context-window size, appends latest usage without a new size, and asserts the old size remains.

**Call relations**: The test runner calls this to protect token-usage metadata preservation.

*Call graph*: calls 1 internal fn (new_or_append); 2 external calls (assert_eq!, default).


### Plugin and tool contracts
These files define shared plugin identifiers, manifests, discovery metadata, and normalized tool definitions used across loading, marketplace, and client-facing tool exposure.

### `plugin/src/plugin_id.rs`

`data_model` · `cross-cutting`

Plugins need a stable identifier so different parts of the system can agree on which plugin they mean. This file is the small rulebook for that identifier. It says that a plugin ID has two parts: the plugin name and the marketplace name. In text form, they are joined with an `@`, like an address label that says both “what package” and “which store.”

The file also protects the rest of the system from bad plugin names. Each part must be non-empty and may only contain ASCII letters, digits, underscores, and hyphens. That matters because the same pieces are used in places like cache layout, where unsafe characters could create confusing or dangerous paths.

`PluginId::new` builds an ID from two already-separated strings, after checking both. `PluginId::parse` takes the combined text form, splits it at the last `@`, and then reuses the same validation. Using the last `@` makes the format clear while still giving one consistent split point. `PluginId::as_key` turns the structured form back into the shared text key. If anything is wrong, the file returns a clear `PluginIdError` explaining what failed.

#### Function details

##### `PluginId::new`  (lines 16–24)

```
fn new(plugin_name: String, marketplace_name: String) -> Result<Self, PluginIdError>
```

**Purpose**: Builds a `PluginId` from a plugin name and marketplace name that are already separate. It refuses to create the ID unless both parts use the safe, expected character set.

**Data flow**: It receives two strings: one for the plugin and one for the marketplace. It sends each string through the segment validator; if either one is empty or contains disallowed characters, it returns an error. If both pass, it returns a new `PluginId` containing those exact two strings.

**Call relations**: This is the central gatekeeper used whenever code already has separate plugin and marketplace names. Cache refresh code, plugin selection parsing, marketplace detail reading, and related tests call on it so they all apply the same naming rules instead of each inventing their own.

*Call graph*: calls 1 internal fn (validate_plugin_segment); called by 36 (parse_plugin_selection, refresh_curated_plugin_cache, refresh_non_curated_plugin_cache_with_mode, read_plugin_detail_for_marketplace_plugin, refresh_curated_plugin_cache_leaves_api_curated_plugin_when_api_manifest_missing, refresh_curated_plugin_cache_migrates_full_sha_cache_version_to_short_version, refresh_curated_plugin_cache_reinstalls_missing_api_curated_plugin, refresh_curated_plugin_cache_reinstalls_missing_configured_plugin_with_current_short_version, refresh_curated_plugin_cache_removes_cache_for_plugin_removed_from_marketplace, refresh_curated_plugin_cache_replaces_existing_local_version_with_short_sha_version (+15 more)).


##### `PluginId::parse`  (lines 26–43)

```
fn parse(plugin_key: &str) -> Result<Self, PluginIdError>
```

**Purpose**: Reads the compact text form of a plugin ID, such as `plugin@marketplace`, and turns it into a structured `PluginId`. It gives a helpful error if the text is missing either side or uses invalid characters.

**Data flow**: It receives one text key. It splits that text at the last `@`, checks that both resulting pieces are present, then passes them to `PluginId::new` for the real safety checks. On success it returns a `PluginId`; on failure it returns an error message that includes the original key for context.

**Call relations**: This is used in places that start with stored or user-facing plugin keys, such as loading plugins, uninstall responses, migration details, telemetry, and plugin selection. After it splits the key, it hands the pieces to `PluginId::new` so parsed IDs follow the same rules as IDs built directly.

*Call graph*: called by 19 (sample_plugin_metadata, extract_plugin_migration_details, emit_plugin_toggle_events, plugin_uninstall_response, parse_plugin_selection, is_tool_suggest_fallback_plugin, installed_plugin_name_for_marketplace, load_plugin, merge_configured_plugins_with_remote_installed, plugin_id (+9 more)); 3 external calls (new, format!, Invalid).


##### `PluginId::as_key`  (lines 45–47)

```
fn as_key(&self) -> String
```

**Purpose**: Turns a structured `PluginId` back into its standard text form, `plugin@marketplace`. This is useful when other parts of the system need a single stable string to store, compare, log, or send onward.

**Data flow**: It reads the `plugin_name` and `marketplace_name` fields from the existing `PluginId`. It joins them with an `@` in the middle and returns the resulting string. It does not change the ID.

**Call relations**: Code that needs the shared text label, such as telemetry metadata creation, uninstall logic, or conversion from a plugin ID into another representation, calls this after a valid `PluginId` already exists.

*Call graph*: called by 3 (from_plugin_id, plugin_telemetry_metadata_from_root, uninstall_plugin_id); 1 external calls (format!).


##### `validate_plugin_segment`  (lines 51–64)

```
fn validate_plugin_segment(segment: &str, kind: &str) -> Result<(), String>
```

**Purpose**: Checks one piece of a plugin ID, either the plugin name or the marketplace name. It makes sure the piece is not empty and only contains characters that are safe and predictable.

**Data flow**: It receives the text segment to check and a plain-language label saying what kind of segment it is. It first rejects empty text, then scans each character and rejects anything outside ASCII letters, digits, `_`, and `-`. It returns success when the segment is safe, or a readable error message when it is not.

**Call relations**: This is the low-level checker used by `PluginId::new`. Because `PluginId::parse` also goes through `PluginId::new`, both directly built IDs and parsed text keys rely on this same validation rule.

*Call graph*: called by 1 (new); 1 external calls (format!).


### `plugin/src/manifest.rs`

`data_model` · `plugin loading and manifest resolution`

A plugin manifest is like a label and table of contents for a plugin. It says what the plugin is called, what version it is, what it can provide, and where to find its pieces, such as skills, apps, MCP servers, hooks, icons, logos, and screenshots. This file does not read the manifest from disk by itself. Instead, it defines the in-memory Rust types used after parsing.

The important idea is that resource locations are generic. The same manifest shape can hold plain file paths while the host is loading a plugin, or a more controlled locator after a package has been resolved. That is why `PluginManifest<Resource>` and the related types are parameterized by `Resource`: the manifest can keep the same structure while the meaning of “where this file lives” changes.

The file also separates basic plugin metadata from optional user-facing interface metadata. The interface section includes things like display name, descriptions, developer name, website links, brand color, and images. Hooks are special because they can either be listed as resource paths or included directly inline as hook definitions.

Without this file, different parts of the plugin system would not have a shared contract for what a manifest contains, and resource references would be harder to safely transform during plugin loading.

#### Function details

##### `PluginManifestInterface::default`  (lines 53–70)

```
fn default() -> Self
```

**Purpose**: Creates an empty interface metadata section with no optional text, links, images, or prompts filled in. This is useful when a plugin has no user-facing interface details yet, but the rest of the code still wants a complete value to work with.

**Data flow**: Nothing is passed in. The function builds a `PluginManifestInterface` where every optional field is set to missing, and every list-like field, such as capabilities and screenshots, is an empty list. The result is returned as a ready-to-use default interface object.

**Call relations**: This default is used when code or tests need a blank interface value, including the `environment_descriptor_binds_every_manifest_resource` flow. Internally it creates fresh empty lists for fields that can contain multiple values, so callers can later add items without sharing old state.

*Call graph*: called by 1 (environment_descriptor_binds_every_manifest_resource); 1 external calls (new).


##### `PluginManifest::display_name`  (lines 75–82)

```
fn display_name(&self) -> &str
```

**Purpose**: Chooses the name that should be shown to people. It prefers the friendly display name from the optional interface section, but falls back to the manifest’s required package name when no good display name is present.

**Data flow**: It reads the manifest’s optional interface metadata. If there is a display name, it trims extra spaces from the beginning and end, then checks that it is not empty. If that cleaned display name is usable, it returns it; otherwise it returns the manifest’s main `name` field. Nothing in the manifest is changed.

**Call relations**: This is a small read-only helper for any part of the system that needs a human-facing plugin name. It keeps callers from having to repeat the same fallback rules themselves.


##### `PluginManifest::try_map_resources`  (lines 84–166)

```
fn try_map_resources(
        self,
        mut map: impl FnMut(Resource) -> Result<Mapped, Error>,
    ) -> Result<PluginManifest<Mapped>, Error>
```

**Purpose**: Converts every resource reference inside a manifest from one representation to another. For example, plugin loading may start with file paths and then turn them into safer, authority-bound locators before exposing the manifest elsewhere.

**Data flow**: It takes ownership of a manifest and receives a mapping function. For each resource field, such as skills, MCP servers, apps, hook paths, icons, logos, and screenshots, it runs that mapping function. Ordinary metadata like names, descriptions, keywords, website links, and inline hook definitions are copied through unchanged. If every resource conversion succeeds, it returns a new manifest with the same information but with mapped resource values. If any conversion fails, it stops and returns that error.

**Call relations**: This function is called by `from_environment` when a manifest needs to be rebound from one resource form into another. While rebuilding hook declarations, it keeps inline hooks as inline data and rebuilds path-based hooks as path lists, using the `Inline` and `Paths` variants to preserve which kind of hook declaration the manifest originally had.

*Call graph*: called by 1 (from_environment); 2 external calls (Inline, Paths).


### `plugin/src/lib.rs`

`data_model` · `cross-cutting`

This file is like the index desk for the plugin package. Other parts of the system do not need to know which smaller module defines plugin loading, plugin IDs, manifests, or providers; they can import the important pieces from here. That keeps the plugin area easier to use and harder to misuse.

It also defines a few simple shared data shapes. `AppConnectorId` is a named wrapper around a string that identifies an app connection. `AppDeclaration` describes an app exposed by a plugin: its name, connector ID, and optional category. `PluginCapabilitySummary` is a compact description of what a plugin can do, such as whether it has skills, which MCP servers it provides, and which app connectors it declares. MCP means “Model Context Protocol,” a way for tools or servers to expose capabilities to the larger system. `PluginHookSource` records where hook definitions came from on disk. A hook is configuration that tells the system to run plugin-provided behavior at certain events. `PluginTelemetryMetadata` packages plugin identity and capability information for analytics or reporting.

The important behavior here is small but useful: the file can deduplicate app connector IDs while preserving their first-seen order, and it can turn trusted plugin identity or a valid capability summary into telemetry metadata. If this file were missing, many plugin-related modules would lose their common vocabulary and import point.

#### Function details

##### `app_connector_ids_from_declarations`  (lines 38–49)

```
fn app_connector_ids_from_declarations(
    app_declarations: impl IntoIterator<Item = &'a AppDeclaration>,
) -> Vec<AppConnectorId>
```

**Purpose**: This function takes a group of app declarations and returns the unique app connector IDs they mention. It keeps the first occurrence order, so the result is stable and readable instead of being randomly arranged.

**Data flow**: It receives any iterable collection of `AppDeclaration` references. It walks through each declaration, checks whether that connector ID has already been seen, and only copies it into the output list the first time it appears. The result is a vector of distinct `AppConnectorId` values, with duplicates removed and the input declarations left unchanged.

**Call relations**: This is a helper for code that has collected app declarations and needs the cleaner list of connector IDs, for example when building a capability summary. Inside, it creates a list for the answer and a set for remembering what has already appeared; no other project function is shown as directly calling it in the provided graph.

*Call graph*: 2 external calls (new, new).


##### `PluginTelemetryMetadata::from_plugin_id`  (lines 81–87)

```
fn from_plugin_id(plugin_id: &PluginId) -> Self
```

**Purpose**: This constructor makes a minimal telemetry metadata record from a known plugin ID. It is useful when the system knows which plugin is involved but does not have, or does not need, the richer capability summary.

**Data flow**: It receives a borrowed `PluginId`. It clones that ID into a new `PluginTelemetryMetadata` value, leaves `remote_plugin_id` empty, and leaves `capability_summary` empty. The output is a standalone metadata object that can be stored or sent without borrowing the original ID.

**Call relations**: This function is used when telemetry metadata is being built from installed plugin information or from a plugin root on disk. In those flows, the caller already has a valid plugin identity, so this function provides the simple base record without trying to inspect capabilities.

*Call graph*: called by 2 (installed_plugin_telemetry_metadata, plugin_telemetry_metadata_from_root); 1 external calls (clone).


##### `PluginCapabilitySummary::telemetry_metadata`  (lines 91–99)

```
fn telemetry_metadata(&self) -> Option<PluginTelemetryMetadata>
```

**Purpose**: This function tries to turn a plugin capability summary into telemetry metadata. It only succeeds if the summary’s `config_name` is a valid plugin ID, because telemetry needs a trustworthy identifier.

**Data flow**: It reads the summary’s `config_name` and asks `PluginId::parse` to validate and convert it into a `PluginId`. If parsing fails, it returns `None`, meaning no safe metadata can be made. If parsing succeeds, it returns metadata containing the parsed plugin ID, no remote plugin ID, and a copy of the capability summary.

**Call relations**: This is the bridge from a human-facing capability summary to analytics-ready plugin metadata. It hands the config name to the plugin ID parser first, so invalid names are stopped before telemetry metadata is produced.

*Call graph*: calls 1 internal fn (parse).


### `tools/src/tool_definition.rs`

`data_model` · `tool definition and loading`

A tool needs a clear label before the rest of the system can safely use it. This file provides that label in the form of `ToolDefinition`, a small data structure that records a tool’s name, human-readable description, input schema, optional output schema, and whether the full definition should be loaded later. A schema is a machine-readable description of what data should look like, like a form that says which fields are allowed and what type each field should be.

The `input_schema` says what information callers must provide when using the tool. The `output_schema` says what shape the answer may have, but it is optional because some tools can defer that detail until later. The `defer_loading` flag marks that delayed state explicitly.

The two helper methods are small but useful. One lets code take an existing tool definition and give it a different name without rebuilding the whole object. The other turns a normal definition into a deferred one by removing the output schema and setting the defer flag. This is like putting a placeholder card in a catalog: enough information exists to recognize the tool, but the heavier details can be fetched only when needed.

#### Function details

##### `ToolDefinition::renamed`  (lines 16–19)

```
fn renamed(mut self, name: String) -> Self
```

**Purpose**: This function takes an existing tool definition and returns the same definition with a new name. It is useful when the system wants to reuse a tool’s details but expose it under a different label.

**Data flow**: It receives a `ToolDefinition` object and a replacement name. It changes only the `name` field, leaves the description and schemas as they were, and returns the updated object.

**Call relations**: This is a convenience step for code that is preparing tool definitions for use elsewhere. Instead of building a fresh definition from scratch, that code can call this method when only the public name needs to change.


##### `ToolDefinition::into_deferred`  (lines 21–25)

```
fn into_deferred(mut self) -> Self
```

**Purpose**: This function turns a full tool definition into a deferred one, meaning the system keeps basic information now and postpones loading the output details. This can save work when complete tool information is not needed immediately.

**Data flow**: It receives a `ToolDefinition` object. It removes the `output_schema` by setting it to none, marks `defer_loading` as true, and returns the changed definition.

**Call relations**: This fits into flows that prepare tool lists without fully loading every detail up front. Later parts of the system can see the defer flag and know that more information may need to be loaded before the tool is used completely.


### `tools/src/tool_discovery.rs`

`domain_logic` · `request handling`

This file is a small translation layer for “discoverable tools.” In this project, a tool can be an app connector, which comes from the app server protocol, or a plugin, which is described locally by this file. The rest of the system often wants to treat both kinds the same way: show a name, read an ID, decide what kind it is, and prepare a list that can be sent back to a client.

The file defines simple labels for tool kinds, such as connector or plugin, and possible actions, such as install or enable. It then wraps connectors and plugins in one shared enum called `DiscoverableTool`. Think of this like putting different kinds of items into the same display case so the storefront can list them together.

Two helper functions do the main work. One removes plugins from the install-request list when the client is the text user interface client, `codex-tui`; other clients get the full list unchanged. The other turns the internal tool objects into `RequestPluginInstallEntry` records, which are easier to serialize, meaning convert into a format that can be sent over an API. This matters because install flows need a clean, predictable list of choices, without leaking internal object details.

#### Function details

##### `DiscoverableTool::tool_type`  (lines 38–43)

```
fn tool_type(&self) -> DiscoverableToolType
```

**Purpose**: This returns whether a discoverable tool is a connector or a plugin. It lets other code label a tool correctly without needing to know how the tool is stored inside.

**Data flow**: It starts with one `DiscoverableTool`. If the tool contains connector information, it returns the connector label. If it contains plugin information, it returns the plugin label. It does not change the tool.

**Call relations**: This is a small accessor used when code needs a plain category for a mixed list of tools. It sits beside the other `DiscoverableTool` accessors so callers can ask simple questions without opening up the enum themselves.


##### `DiscoverableTool::id`  (lines 45–50)

```
fn id(&self) -> &str
```

**Purpose**: This returns the stable ID for a tool, no matter whether the tool is a connector or a plugin. Code uses this ID to refer to the exact tool later, for example during an install request.

**Data flow**: It receives a shared reference to a `DiscoverableTool`. It looks inside the wrapper, reads the connector ID or plugin ID, and returns it as borrowed text. Nothing is copied or modified.

**Call relations**: The function is called by `build_request_plugin_install_meta` when that code needs to build install metadata. In that larger flow, this method supplies the identifier that ties a user-visible choice back to the underlying tool.

*Call graph*: called by 1 (build_request_plugin_install_meta).


##### `DiscoverableTool::name`  (lines 52–57)

```
fn name(&self) -> &str
```

**Purpose**: This returns the human-friendly name for a tool, whether it is a connector or a plugin. It is used when a tool needs to be shown or described to a user.

**Data flow**: It receives a `DiscoverableTool`, checks which kind it contains, reads the matching `name` field, and returns that text by reference. The original tool is left unchanged.

**Call relations**: The function is called by `build_request_plugin_install_meta`. In that flow, it provides the display name that can appear in install prompts, search results, or other user-facing metadata.

*Call graph*: called by 1 (build_request_plugin_install_meta).


##### `DiscoverableTool::install_url`  (lines 59–64)

```
fn install_url(&self) -> Option<&str>
```

**Purpose**: This returns an install web address when the tool has one. In this file, only connectors can provide an install URL; plugins return no URL here.

**Data flow**: It receives a `DiscoverableTool`. For a connector, it reads the optional `install_url` field and returns it as optional borrowed text. For a plugin, it returns `None`, meaning there is no URL available through this method.

**Call relations**: The function is called by `build_request_plugin_install_meta` when install metadata needs to include a direct install link if one exists. It also encodes an important rule for the rest of the system: plugin installs are not represented by connector-style install URLs here.

*Call graph*: called by 1 (build_request_plugin_install_meta).


##### `DiscoverableTool::from`  (lines 74–76)

```
fn from(value: DiscoverablePluginInfo) -> Self
```

**Purpose**: This converts a specific tool record into the shared `DiscoverableTool` wrapper. That lets later code work with connectors and plugins through one common type.

**Data flow**: It takes either connector information from `AppInfo` or plugin information from `DiscoverablePluginInfo`. It places that value in a boxed wrapper, which means the larger data is stored behind a pointer, and then returns a `DiscoverableTool` marked as either `Connector` or `Plugin`.

**Call relations**: This conversion is used when code gathers tools from different sources and wants to put them into one list. The call graph records it creating the connector or plugin variant, so later accessors such as `id`, `name`, and `tool_type` can treat the result uniformly.

*Call graph*: 3 external calls (new, Connector, Plugin).


##### `filter_request_plugin_install_discoverable_tools_for_client`  (lines 79–91)

```
fn filter_request_plugin_install_discoverable_tools_for_client(
    discoverable_tools: Vec<DiscoverableTool>,
    app_server_client_name: Option<&str>,
) -> Vec<DiscoverableTool>
```

**Purpose**: This decides which discoverable tools a particular client is allowed to see for plugin-install requests. Its special rule is that the `codex-tui` client should not receive plugin entries in this flow.

**Data flow**: It takes a list of discoverable tools and an optional client name. If the client is not `codex-tui`, it returns the list exactly as received. If the client is `codex-tui`, it walks through the list, keeps connectors, removes plugins, and returns the filtered list.

**Call relations**: This function belongs in the install-list preparation path. Before a response is shown or sent to a client, this step can narrow the choices so the text user interface only sees the kinds of tools it is expected to handle.


##### `collect_request_plugin_install_entries`  (lines 120–146)

```
fn collect_request_plugin_install_entries(
    discoverable_tools: &[DiscoverableTool],
) -> Vec<RequestPluginInstallEntry>
```

**Purpose**: This turns internal discoverable tool objects into simple install-list entries that can be serialized and sent to a client. It makes connectors and plugins look like one consistent list while preserving the details that matter for each kind.

**Data flow**: It receives a borrowed slice of `DiscoverableTool` values. For each connector, it copies the ID, name, and description, labels it as a connector, and fills plugin-only fields with empty or false values. For each plugin, it copies the plugin ID, name, description, skill flag, server names, and connector IDs. It returns a new vector of `RequestPluginInstallEntry` records and does not modify the original tools.

**Call relations**: This function is used after tools have been discovered and possibly filtered. It calls the normal iterator machinery to walk the list, then hands back a clean response-shaped collection that can be placed inside `ListAvailablePluginsToInstallResult` or similar API output.

*Call graph*: 1 external calls (iter).


### `core/src/mention_syntax.rs`

`util` · `cross-cutting`

This file is a small bridge between the core part of the project and a shared utility module. The project has special “sigils,” meaning marker characters or short prefixes, that tell the system when text is mentioning a plugin or a tool. Rather than making every core file know the deeper package path where those markers are defined, this file republishes them under `core/src/mention_syntax.rs`.

Think of it like a reception desk forwarding visitors to the right office. The real definitions live in `codex_utils_plugins::mention_syntax`, but core code can ask this local file for `PLUGIN_TEXT_MENTION_SIGIL` and `TOOL_MENTION_SIGIL`. That keeps imports simpler and gives the core crate a stable, readable place for mention-syntax constants.

If this file disappeared, any core code depending on these local exports would need to import the constants directly from the utility package. That would make the code a little more tightly tied to the utility package’s internal layout and harder to adjust later.


### Configuration and policy types
These files capture broadly reused configuration, execution-policy, network-proxy, and cloud-task contract types shared across subsystems.

### `cloud-tasks-client/src/api.rs`

`data_model` · `cross-cutting`

This file is like the menu and order form for the cloud tasks part of the project. It does not actually contact the cloud itself. Instead, it defines the shapes of the information that moves between the app and a cloud backend, and it defines the promises a backend must keep.

The data types describe common things the rest of the program needs to understand: a task ID, a task summary, whether a task is pending or applied, a summary of changed files, the outcome of applying a patch, and the text or assistant messages attached to a task. These types matter because different parts of the program need to agree exactly on what a “task” means. Without this shared agreement, listing tasks, showing diffs, applying changes, or creating new tasks would all need custom glue code and could easily disagree.

The `CloudBackend` trait is the main contract. A trait is a Rust interface: it says “any backend must provide these actions.” Those actions include listing tasks, fetching summaries and diffs, reading messages, checking whether a patch would apply cleanly, applying it for real, and creating new tasks. Most operations return a boxed future, meaning the answer may arrive later because cloud or disk work is asynchronous. The file also defines one common error type so failures can be reported in a consistent way.

#### Function details

##### `TaskText::default`  (lines 124–133)

```
fn default() -> Self
```

**Purpose**: This creates an empty `TaskText` value for cases where no prompt, messages, turn information, or attempt details are available yet. It gives the rest of the code a safe starting point instead of forcing every caller to fill in each field by hand.

**Data flow**: Nothing is passed in. The function builds a `TaskText` with no prompt, an empty message list, no turn ID, no sibling turn IDs, no attempt placement, and an attempt status of `Unknown`. The result is a complete but blank task-text record that callers can use immediately.

**Call relations**: Rust calls this when code asks for the default value of `TaskText`. Inside, it creates fresh empty vectors for the message lists, so each default `TaskText` starts with its own empty collections rather than sharing data with anything else.

*Call graph*: 1 external calls (new).


### `config/src/types.rs`

`config` · `config load and cross-cutting runtime settings`

This file is mostly a catalog of configuration types. Think of it like a form template: it says which boxes a user can fill in, what each box means, and what value Codex should assume when the box is left blank. Without this file, different parts of Codex could disagree about things like notification settings, telemetry export, memory behavior, sandbox permissions, plugin tool policy, or terminal UI preferences.

Most types here are simple structs and enums. A struct groups related settings, such as all TUI settings or all memory settings. An enum lists a small set of allowed choices, such as which notification method to use. The file also tells Serde, the Rust library used for reading and writing data, how these settings appear in TOML or JSON files. It uses JSON Schema support too, so tools can describe and validate config files.

A few small functions apply safe defaults or convert from “raw user config” into “effective config.” For example, memory settings are loaded as optional values, then turned into concrete values with defaults and safety limits. This matters because configuration is user-controlled: Codex should accept missing values gracefully, but it should also avoid extreme values that could slow down startup or behave unexpectedly.

#### Function details

##### `default_enabled`  (lines 58–60)

```
fn default_enabled() -> bool
```

**Purpose**: Provides the common default value for settings that should be turned on unless the user says otherwise. It keeps many config fields from having to repeat the same default rule.

**Data flow**: No input is needed. The function always returns `true`, which Serde can use when a config field is missing.

**Call relations**: This is used through Serde default annotations on several config fields. When Codex reads a config file and an enabled-style setting is absent, this function supplies the assumed value.


##### `SessionPickerViewMode::as_str`  (lines 72–77)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns a session picker layout choice into the plain text name used for display or serialization-like output. It keeps the spelling of these names in one place.

**Data flow**: It receives a `SessionPickerViewMode` value, either comfortable or dense. It matches that value and returns the corresponding text: `comfortable` or `dense`.

**Call relations**: The display formatter for `SessionPickerViewMode` calls this function when it needs printable text, so the human-facing wording follows the same mapping every time.

*Call graph*: called by 1 (fmt).


##### `SessionPickerViewMode::fmt`  (lines 81–83)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Lets a session picker layout be printed as readable text. This is what makes formatting with normal Rust display tools produce `comfortable` or `dense` instead of a debug-style enum name.

**Data flow**: It receives the layout value and a formatter, asks `as_str` for the correct text, then writes that text into the formatter. The result is either success or a formatting error from the output destination.

**Call relations**: This function is called automatically by Rust formatting when code displays a `SessionPickerViewMode`. It delegates the actual name choice to `SessionPickerViewMode::as_str`.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `AuthKeyringBackendKind::default`  (lines 127–133)

```
fn default() -> Self
```

**Purpose**: Chooses the default way Codex stores authentication data in the operating system keyring. The default is different on Windows because Codex prefers a secrets-file approach there, while other platforms store the payload directly.

**Data flow**: It reads the compile-time operating system setting through Rust’s `cfg!` macro. If the build target is Windows, it returns `Secrets`; otherwise it returns `Direct`.

**Call relations**: This default is relied on during authentication and remote-control setup paths, including tests that check recovery after authorization changes. It gives those flows a consistent storage choice when the user has not configured one.

*Call graph*: called by 92 (list_remote_control_clients_recovers_auth_after_unauthorized, list_remote_control_clients_retries_unauthorized_only_once, remote_control_handle_discards_pairing_response_after_auth_change, remote_control_handle_recovers_auth_before_refreshing_pairing, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_start_allows_missing_auth_when_enabled, remote_control_waits_for_account_id_before_enrolling, connect_remote_control_websocket_recovers_after_unauthorized_enrollment, connect_remote_control_websocket_recovers_after_unauthorized_refresh, connect_remote_control_websocket_requires_chatgpt_auth (+15 more)); 1 external calls (cfg!).


##### `UriBasedFileOpener::get_scheme`  (lines 172–180)

```
fn get_scheme(&self) -> Option<&str>
```

**Purpose**: Returns the URI scheme for a configured editor or file opener. A URI scheme is the prefix in links like `vscode://...` that tells the operating system which app should open the link.

**Data flow**: It receives the selected opener. For VS Code, Cursor, Windsurf, and similar choices, it returns the matching scheme text; for `None`, it returns no scheme.

**Call relations**: Code that wants to build a clickable editor link can call this function to find the right scheme. If it gets no scheme back, it knows URI-based opening has been disabled.


##### `ToolSuggestDisabledTool::plugin`  (lines 247–252)

```
fn plugin(id: impl Into<String>) -> Self
```

**Purpose**: Builds a disabled-tool entry for a plugin by filling in the correct type tag. This avoids callers having to remember the exact enum value for plugin tools.

**Data flow**: It receives an ID in any value that can become a string. It converts that ID into a `String` and returns a `ToolSuggestDisabledTool` marked as a plugin.

**Call relations**: The disabled install request flow calls this helper when it needs to record that a suggested plugin should be treated as disabled. The helper packages the ID into the standard config shape.

*Call graph*: called by 1 (disabled_install_request); 1 external calls (into).


##### `ToolSuggestDisabledTool::connector`  (lines 254–259)

```
fn connector(id: impl Into<String>) -> Self
```

**Purpose**: Builds a disabled-tool entry for a connector by filling in the correct type tag. It is the connector counterpart to the plugin helper.

**Data flow**: It receives an ID, converts it into a string, and returns a `ToolSuggestDisabledTool` marked as a connector.

**Call relations**: The disabled install request flow calls this helper when it needs to record that a suggested connector should be disabled. The rest of the system can then treat it like any other disabled-tool config entry.

*Call graph*: called by 1 (disabled_install_request); 1 external calls (into).


##### `ToolSuggestDisabledTool::normalized`  (lines 261–267)

```
fn normalized(&self) -> Option<Self>
```

**Purpose**: Cleans up a disabled-tool entry before it is used or stored. It trims extra spaces from the ID and rejects entries with an empty ID.

**Data flow**: It reads the current tool type and ID. It trims whitespace from the ID; if anything remains, it returns a new cleaned entry, and if the ID is blank, it returns nothing.

**Call relations**: This is a small safety step for code that accepts disabled-tool records from user input or config. It prevents meaningless entries, such as an all-spaces ID, from flowing further into tool suggestion logic.


##### `MemoriesConfig::default`  (lines 331–346)

```
fn default() -> Self
```

**Purpose**: Defines the effective default behavior for Codex memories. Memories are saved context from past work that can help future sessions, and this function says how that feature behaves when the user has not customized it.

**Data flow**: No input is needed. It returns a complete `MemoriesConfig` with booleans, size limits, age limits, rate-limit thresholds, and no custom model names.

**Call relations**: The main config creation path and startup memory configuration tests rely on this function. It is also used by `MemoriesConfig::from` as the baseline before applying user-supplied overrides.

*Call graph*: called by 2 (startup_test_memories_config, new_config).


##### `MemoriesConfig::from`  (lines 350–392)

```
fn from(toml: MemoriesToml) -> Self
```

**Purpose**: Turns the raw memory settings read from the config file into a complete, safe memory configuration. It fills in missing values and clamps some numbers into allowed ranges so one bad setting cannot create unreasonable behavior.

**Data flow**: It receives `MemoriesToml`, where every field may be missing. It starts from `MemoriesConfig::default`, replaces defaults with any user-provided values, limits numeric settings to safe minimums and maximums, and returns a finished `MemoriesConfig`.

**Call relations**: Tests call this conversion to confirm that count and rate-limit settings are clamped correctly. In normal use, the larger config-loading code uses it after reading TOML so the rest of Codex can work with definite values instead of many optional ones.

*Call graph*: called by 2 (memories_config_clamps_count_limits_to_nonzero_values, memories_config_clamps_rate_limit_remaining_threshold); 1 external calls (default).


##### `OtelConfig::default`  (lines 573–583)

```
fn default() -> Self
```

**Purpose**: Defines the default telemetry settings for OTEL, short for OpenTelemetry, a standard way to collect logs, metrics, and traces. The defaults avoid logging user prompts and only enable the built-in Statsig metrics exporter.

**Data flow**: No input is needed. It creates empty maps for extra attributes and trace state, sets the environment to `dev`, disables general and trace exporters, and sets metrics export to Statsig.

**Call relations**: The main config creation path calls this when building effective settings. User-provided OTEL config can then override these defaults where needed.

*Call graph*: called by 1 (new_config); 1 external calls (new).


##### `Notifications::default`  (lines 594–596)

```
fn default() -> Self
```

**Purpose**: Sets terminal UI notifications to enabled by default. This means users get notifications unless they explicitly turn them off or provide a custom notification command list.

**Data flow**: No input is needed. It returns the `Enabled(true)` form of the `Notifications` enum.

**Call relations**: Serde uses this through defaulted notification settings when reading TUI config. The rest of the TUI can then see a clear notification preference even if the config file omitted it.

*Call graph*: 1 external calls (Enabled).


##### `NotificationMethod::fmt`  (lines 609–615)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Prints the configured terminal notification method as plain text. The method can be automatic, OSC 9 terminal notification escape codes, or BEL, the traditional terminal bell.

**Data flow**: It receives the notification method and a formatter. It writes `auto`, `osc9`, or `bel` into the formatter and returns the formatting result.

**Call relations**: Rust formatting calls this whenever code displays a `NotificationMethod`. That keeps log messages, UI text, or generated output using the same lowercase names as the config.

*Call graph*: 1 external calls (write!).


##### `NotificationCondition::fmt`  (lines 629–634)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Prints when notifications should be sent: only while the terminal is unfocused, or always. This gives the setting a clean human-readable form.

**Data flow**: It receives the notification condition and a formatter. It writes either `unfocused` or `always`, then returns the formatter’s result.

**Call relations**: Rust formatting calls this automatically when the condition is displayed. It keeps presentation code from duplicating the text mapping.

*Call graph*: 1 external calls (write!).


##### `default_true`  (lines 775–777)

```
fn default_true() -> bool
```

**Purpose**: Provides a shared default of `true` for TUI settings that should be on unless the user disables them. Examples include animations and startup tooltips.

**Data flow**: No input is needed. The function always returns `true`.

**Call relations**: This is used by Serde default annotations while reading TUI config. If a matching field is missing from the config file, this function supplies the default value.


##### `PluginMcpServerConfig::default`  (lines 865–873)

```
fn default() -> Self
```

**Purpose**: Creates the default policy for an MCP server contributed by a plugin. MCP means Model Context Protocol, a way for tools and external services to expose capabilities to Codex.

**Data flow**: No input is needed. It returns a config where the server is enabled, no default approval mode is set, there are no allow or deny lists, and the per-tool settings map is empty.

**Call relations**: This default is used when plugin MCP server policy is missing or needs to start from a clean baseline. Later config layers can add tool-specific approval or enablement rules.

*Call graph*: 1 external calls (new).


##### `SandboxSettings::from`  (lines 920–927)

```
fn from(sandbox_workspace_write: SandboxWorkspaceWrite) -> Self
```

**Purpose**: Converts Codex’s workspace-write sandbox config into the app-server protocol’s sandbox settings. A sandbox is a safety boundary that limits what spawned tools can write to or access.

**Data flow**: It receives `SandboxWorkspaceWrite`, including writable paths and booleans for network access and temporary-directory exclusions. It moves those values into the protocol type, wrapping the booleans in `Some` to show they were explicitly set.

**Call relations**: This is the handoff point between local config types and the app-server protocol type. Code preparing settings for the app server can call this conversion instead of manually copying each field.


##### `ShellEnvironmentPolicy::from`  (lines 950–977)

```
fn from(toml: ShellEnvironmentPolicyToml) -> Self
```

**Purpose**: Turns raw shell environment policy from the config file into the effective policy used when Codex starts shell-like tools. The environment is the set of variables a process sees, such as `PATH` or API keys.

**Data flow**: It receives `ShellEnvironmentPolicyToml`, where each setting may be absent. It chooses defaults, converts exclude and include-only strings into case-insensitive environment-variable patterns, keeps any variables the user wants to set, and returns a complete `ShellEnvironmentPolicy`.

**Call relations**: This conversion is used after config loading and before spawning tools. It gives process-launching code a ready-to-use rulebook for which environment variables to inherit, remove, add, or limit.


### `execpolicy-legacy/src/exec_call.rs`

`data_model` · `cross-cutting`

An `ExecCall` is the project’s plain record of a command someone wants to run. It has two parts: the program name, such as `cp` or `head`, and a list of arguments, such as file names or flags. This matters because execution policy code needs to reason about commands before or while they run. Without a shared shape like this, each caller might describe commands differently, making tests and policy checks harder to trust.

The file also adds a convenience constructor, `ExecCall::new`, so code can build one from ordinary string slices without manually converting every piece into owned strings. That is mostly about reducing noise and mistakes in callers, especially tests.

Finally, it teaches Rust how to display an `ExecCall` as a command-line-looking string: first the program, then each argument separated by a space. This is useful for logs, error messages, or test output. One important detail is that this display form is simple and human-readable; it does not add shell-style quoting. So it is best understood as “a readable summary,” not a safe command to paste into a shell.

#### Function details

##### `ExecCall::new`  (lines 12–17)

```
fn new(program: &str, args: &[&str]) -> Self
```

**Purpose**: Creates a new `ExecCall` from a program name and a list of argument words. It exists so callers can describe a command in one short, clear step instead of manually building the struct field by field.

**Data flow**: It receives a borrowed program string and a borrowed list of argument strings. It copies the program into its own `String`, copies each argument into its own `String`, and returns a complete `ExecCall` containing those owned values. It does not change anything outside itself.

**Call relations**: The test code calls this repeatedly when setting up examples such as `cp` and `head` commands. In that larger flow, the tests use this constructor as the clean doorway for making command records that can then be compared against expected policy behavior.

*Call graph*: called by 28 (test_cp_multiple_files, test_cp_no_args, test_cp_one_arg, test_cp_one_file, test_head_invalid_n_as_0, test_head_invalid_n_as_float, test_head_invalid_n_as_negative_int, test_head_invalid_n_as_nonint_float, test_head_no_args, test_head_one_file_no_flags (+15 more)).


##### `ExecCall::fmt`  (lines 21–27)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Turns an `ExecCall` into a readable single-line command description. This is used whenever Rust formatting asks to display the value as text.

**Data flow**: It reads the stored program name and arguments. It writes the program first, then writes each argument after a space, into the formatter supplied by Rust’s display system. The output is text; if writing to the formatter fails, that formatting error is returned.

**Call relations**: This function is called indirectly by Rust’s normal display machinery, for example when an `ExecCall` is formatted with `{}`. Inside, it hands each text piece to the standard `write!` formatting tool, which does the actual writing into the destination formatter.

*Call graph*: 1 external calls (write!).


### `execpolicy-legacy/src/valid_exec.rs`

`data_model` · `policy evaluation and command approval`

When this project decides whether an `exec()` call should be allowed, it needs a clean way to describe the result: “yes, this command is valid, and here is exactly what was accepted.” This file provides that description.

The main type is `ValidExec`. It is like a stamped approval form for a command. It stores the program, matched flags, matched options, ordinary arguments, and an optional list of trusted full paths to try instead of relying on the user’s `PATH`. That matters because a bare command like `ls` can point to different files depending on the environment, while `/bin/ls` is more predictable.

The smaller types describe the pieces that matched the policy. `MatchedArg` records a positional argument, including where it appeared. `MatchedOpt` records an option with a value, such as an option declared by policy. `MatchedFlag` records a flag that has no separate value. Arguments and option values are checked against an `ArgType`, which is the project’s way of saying what kind of value is acceptable. If the value does not fit, construction fails instead of producing an unsafe approval record.

The file also includes a helper to ask whether the accepted command might write files, based on the argument and option types. This lets later code treat potentially file-changing commands more carefully.

#### Function details

##### `ValidExec::new`  (lines 21–29)

```
fn new(program: &str, args: Vec<MatchedArg>, system_path: &[&str]) -> Self
```

**Purpose**: Creates a new approved-command record for a program, its already-matched positional arguments, and any safer system paths that should be tried first. It starts with no matched flags or options, because those can be filled in separately as policy checking discovers them.

**Data flow**: It receives a program name, a list of matched arguments, and a slice of trusted path strings. It copies those borrowed text values into owned strings, creates empty lists for flags and options, and returns a complete `ValidExec` value ready to be passed around or serialized.

**Call relations**: This is the constructor used when the policy code has enough information to say a command is valid. It does not validate each argument itself; it expects the `MatchedArg` values it receives to have already been checked when they were built.

*Call graph*: 1 external calls (vec!).


##### `ValidExec::might_write_files`  (lines 33–36)

```
fn might_write_files(&self) -> bool
```

**Purpose**: Answers the safety question: could this approved command write to files? It helps later code quickly identify commands that may change the filesystem.

**Data flow**: It reads the matched options and positional arguments stored inside the `ValidExec`. For each one, it asks its `ArgType` whether that kind of value might refer to file writing. It returns `true` as soon as any option or argument looks write-capable, otherwise it returns `false`.

**Call relations**: After a command has been accepted, other parts of the system can call this method before deciding how cautious to be. It relies on the argument type information captured earlier by `MatchedArg::new` and `MatchedOpt::new`.


##### `MatchedArg::new`  (lines 47–54)

```
fn new(index: usize, r#type: ArgType, value: &str) -> Result<Self>
```

**Purpose**: Builds a record for one positional command argument, but only if the value matches the expected kind of argument. This prevents invalid user input from being recorded as policy-approved.

**Data flow**: It receives the argument’s position, the expected `ArgType`, and the actual text value. It asks the `ArgType` to validate the value. If validation fails, it returns an error; if validation succeeds, it stores the position, type, and copied value in a new `MatchedArg`.

**Call relations**: This function is called while observed command arguments are being resolved against policy patterns. It is the point where a raw argument from a command line becomes a trusted matched argument, or is rejected before it can be included in a `ValidExec`.

*Call graph*: calls 1 internal fn (validate); called by 1 (resolve_observed_args_with_patterns).


##### `MatchedOpt::new`  (lines 69–76)

```
fn new(name: &str, value: &str, r#type: ArgType) -> Result<Self>
```

**Purpose**: Builds a record for an option that has a value, such as a policy-declared option, after checking that the supplied value is allowed. It keeps the option name, value, and expected value type together.

**Data flow**: It receives an option name, the option’s text value, and an `ArgType` describing what that value should look like. It validates the value through the type. On failure it returns an error; on success it copies the name and value into a new `MatchedOpt` and returns it.

**Call relations**: This function is used during policy checking when an option from the command line appears to match a policy rule. It hands back a safe, validated option record that can later be stored inside `ValidExec` or inspected for file-writing risk.

*Call graph*: calls 1 internal fn (validate); called by 1 (check).


##### `MatchedOpt::name`  (lines 78–80)

```
fn name(&self) -> &str
```

**Purpose**: Returns the name of a matched option as borrowed text. This lets callers inspect the option name without copying it.

**Data flow**: It reads the `name` field inside the `MatchedOpt` and returns a reference to that same string. Nothing is changed or newly allocated.

**Call relations**: This is a small convenience method for code that needs to compare or display a matched option’s name while keeping the full `MatchedOpt` record intact.


##### `MatchedFlag::new`  (lines 90–94)

```
fn new(name: &str) -> Self
```

**Purpose**: Creates a record for a flag that matched the policy. A flag is an option-like command-line item that does not carry a separate value.

**Data flow**: It receives the flag name as text, copies it into an owned string, and returns a new `MatchedFlag`. There is no value to validate because flags are just present or absent.

**Call relations**: Policy-checking code can use this when it recognizes an allowed flag. The resulting record can be stored in the `flags` list of a `ValidExec`, alongside matched options and arguments.


### `execpolicy/src/decision.rs`

`data_model` · `policy parsing`

This file gives the rest of the system a shared vocabulary for deciding whether a command is safe to run. Instead of passing around loose strings like "allow" or "forbidden", the code uses the `Decision` enum, which is a fixed list of valid choices. That prevents spelling mistakes or unknown values from silently changing security behavior.

The three choices are simple. `Allow` means the command can run without asking again. `Prompt` means the system should ask the user for approval, unless the broader approval setting says prompting is never allowed. `Forbidden` means the command is blocked outright.

The file also supports serialization and deserialization, which means these decisions can be converted to and from stored or transmitted formats such as JSON. The `camelCase` setting controls how the names appear in those outside formats.

The important guardrail is `Decision::parse`. When policy text says what should happen, this function accepts only the exact words the system understands. If it sees anything else, it returns an error instead of guessing. For a security-related policy, that is like a door lock refusing an unfamiliar key rather than trying to make it fit.

#### Function details

##### `Decision::parse`  (lines 19–26)

```
fn parse(raw: &str) -> Result<Self>
```

**Purpose**: Turns a raw text value into a valid `Decision`. It is used when reading policy rules so the system can reject unknown decision words instead of treating them as meaningful.

**Data flow**: It receives a string such as `allow`, `prompt`, or `forbidden`. It compares that text against the three accepted policy outcomes. If the text matches, it returns the matching `Decision`; if not, it returns an `InvalidDecision` error containing the unknown text.

**Call relations**: When network rule parsing needs to understand the decision written in a rule, `parse_network_rule_decision` calls this function. If the decision text is valid, this function hands back the structured value the rest of the policy code can trust; if it is not valid, it hands back an error so the bad rule can be rejected.

*Call graph*: called by 1 (parse_network_rule_decision); 1 external calls (InvalidDecision).


### `network-proxy/src/reasons.rs`

`data_model` · `cross-cutting, especially when rejecting or reporting blocked proxy requests`

When a proxy says “no” to a network request, it is not enough to simply fail. The rest of the system, and often the person debugging it, needs to know why. This file is a small shared vocabulary for those explanations.

Each constant is a fixed text label for a specific kind of refusal. For example, one label means a request was denied by policy, another means the proxy is disabled, another means the requested method is not allowed, and another means a Unix socket connection is unsupported. These strings are written in a machine-friendly style, such as `policy_denied`, so they can be safely reused in structured logs, counters, status messages, or API responses.

The value of this file is consistency. Without it, different parts of the proxy might spell the same reason in different ways, such as `not allowed`, `not_allowed`, or `denied_by_policy`. That would make searching logs harder and could break any tooling that expects exact reason names. Think of it like a small phrasebook: every part of the proxy points to the same approved wording instead of making up its own.


### Skills and extension models
These files define the shared in-memory and extension-facing schemas for skills catalogs, loaded skills, and related selection metadata.

### `core-skills/src/model.rs`

`data_model` · `skill loading and per-turn skill use`

A “skill” here is a reusable capability declared by a SKILLS.md file. This file is the shared vocabulary for that system. It says what information a loaded skill carries, such as its name, description, optional user-interface details, tool dependencies, policy rules, location on disk, scope, and plugin identity.

It also describes the result of loading skills. A SkillLoadOutcome is like a shipping manifest: it contains the skills that were found, any loading errors, which skill files are disabled, and private lookup tables that help the rest of the program find related roots, documents, scripts, and file systems.

One important detail is that skills may come from different execution environments. The file therefore keeps a map from each skill path to the ExecutorFileSystem that can read it. An ExecutorFileSystem is an abstraction over file access, so code can read from the normal local disk or from another environment without caring which one it is.

HostLoadedSkills wraps a loaded outcome for one turn of work and gives callers a safe way to read the text of a skill through the same file system that loaded it. Finally, filter_skill_load_outcome_for_product trims an already-loaded set of skills so only skills allowed for a specific product remain, while also cleaning up the related lookup maps so they stay consistent.

#### Function details

##### `SkillMetadata::allows_implicit_invocation`  (lines 29–34)

```
fn allows_implicit_invocation(&self) -> bool
```

**Purpose**: This answers whether a skill may be chosen automatically without the user naming it directly. If the skill has no policy, or the policy does not say otherwise, the function treats the skill as allowed.

**Data flow**: It reads the skill’s optional policy. If the policy includes allow_implicit_invocation, that value is used; if the policy or field is missing, the result becomes true. Nothing is changed.

**Call relations**: This is used when deciding whether a loaded skill can be considered for automatic use. SkillLoadOutcome::is_skill_allowed_for_implicit_invocation combines this policy answer with the separate enabled-or-disabled check.


##### `SkillMetadata::matches_product_restriction_for_product`  (lines 36–49)

```
fn matches_product_restriction_for_product(
        &self,
        restriction_product: Option<Product>,
    ) -> bool
```

**Purpose**: This checks whether a skill is allowed for a given product, such as when the same skill system is shared by multiple products. It lets unrestricted skills through and only blocks skills whose policy names products that do not match the requested product.

**Data flow**: It takes an optional product restriction and reads the skill’s policy. If there is no policy, or the policy has no product list, the skill matches. If products are listed, the provided product must exist and match that list. The function returns a yes-or-no answer and does not modify the skill.

**Call relations**: This is the per-skill test used by filter_skill_load_outcome_for_product. That larger function applies this check to the main skill list and the implicit-skill lookup maps so the whole load result matches the selected product.


##### `SkillLoadOutcome::is_skill_enabled`  (lines 104–106)

```
fn is_skill_enabled(&self, skill: &SkillMetadata) -> bool
```

**Purpose**: This tells whether a particular loaded skill is currently enabled. It does that by checking whether the skill’s SKILLS.md path appears in the outcome’s disabled path set.

**Data flow**: It receives a skill and reads the outcome’s disabled_paths collection. If the skill’s path is absent from that set, it returns true; if present, it returns false. It does not change the outcome.

**Call relations**: This is the basic enabled check used by SkillLoadOutcome::is_skill_allowed_for_implicit_invocation. Other higher-level code can rely on that combined check when deciding which skills may be used automatically.

*Call graph*: called by 1 (is_skill_allowed_for_implicit_invocation).


##### `SkillLoadOutcome::is_skill_allowed_for_implicit_invocation`  (lines 108–110)

```
fn is_skill_allowed_for_implicit_invocation(&self, skill: &SkillMetadata) -> bool
```

**Purpose**: This answers the practical question: may this skill be automatically selected right now? A skill must be enabled and its own policy must allow implicit invocation.

**Data flow**: It receives a skill, first checks whether that skill is enabled in this outcome, then asks the skill metadata whether implicit invocation is allowed. It returns true only when both answers are true. It changes nothing.

**Call relations**: This function brings together outcome-level state and skill-level policy. SkillLoadOutcome::allowed_skills_for_implicit_invocation uses it to build the list that downstream skill-selection code can consider.

*Call graph*: calls 1 internal fn (is_skill_enabled); 1 external calls (allows_implicit_invocation).


##### `SkillLoadOutcome::allowed_skills_for_implicit_invocation`  (lines 112–118)

```
fn allowed_skills_for_implicit_invocation(&self) -> Vec<SkillMetadata>
```

**Purpose**: This produces a list of skills that are safe to consider for automatic use. It filters out disabled skills and skills whose policy says they should not be invoked implicitly.

**Data flow**: It reads the outcome’s full skills list. For each skill, it applies the combined implicit-invocation check, clones the skills that pass, and returns them as a new vector. The original outcome is not changed.

**Call relations**: This is called after skill loading is being finalized and when available skills are being built. It gives those later steps a cleaned-up list instead of making them repeat the enablement and policy rules.

*Call graph*: called by 2 (finalize_skill_outcome, build_available_skills).


##### `SkillLoadOutcome::skills_with_enabled`  (lines 120–124)

```
fn skills_with_enabled(&self) -> impl Iterator<Item = (&SkillMetadata, bool)>
```

**Purpose**: This gives callers every loaded skill together with a simple enabled-or-disabled flag. It is useful for display or catalog views where disabled skills should still be shown, but marked clearly.

**Data flow**: It reads the full skills list and, for each skill, checks whether its path is disabled. It returns an iterator that yields the original skill reference plus a boolean. It does not clone the skills or change the outcome.

**Call relations**: Catalog-building code calls this when it needs a complete view of skills, not just the enabled ones. The function keeps that catalog code from needing to know how disabled paths are stored internally.

*Call graph*: called by 1 (catalog_from_outcome).


##### `SkillLoadOutcome::file_system_for_skill`  (lines 126–132)

```
fn file_system_for_skill(
        &self,
        skill: &SkillMetadata,
    ) -> Option<Arc<dyn ExecutorFileSystem>>
```

**Purpose**: This looks up the file system that should be used to read a given skill. That matters because not every skill necessarily comes from the local disk.

**Data flow**: It takes a skill, uses the skill’s SKILLS.md path as the lookup key, and asks the internal SkillFileSystemsByPath map for the matching ExecutorFileSystem. It returns a shared reference-counted file-system object if one exists, or none if no special file system is recorded.

**Call relations**: HostLoadedSkills::read_skill_text relies on this lookup before reading a skill file. If this function finds a matching file system, reading happens through that environment; otherwise the reader falls back to the local file system.

*Call graph*: calls 1 internal fn (get).


##### `HostLoadedSkills::new`  (lines 143–145)

```
fn new(outcome: Arc<SkillLoadOutcome>) -> Self
```

**Purpose**: This creates a HostLoadedSkills wrapper around a loaded skill outcome for one turn of work. The wrapper keeps the loaded skills and their file-system mappings together.

**Data flow**: It receives a shared SkillLoadOutcome and stores it inside a new HostLoadedSkills value. The outcome is not copied deeply; it is shared through Arc, a thread-safe shared pointer.

**Call relations**: Turn setup and review-thread setup call this when they need to pass loaded skills into later work. Tests around supplied executor file systems and installed extensions also use it to verify that host-loaded skills keep the correct reading context.

*Call graph*: called by 4 (spawn_review_thread, make_turn_context, skill_loading_and_reads_use_the_supplied_executor_file_system, installed_extension_uses_host_loaded_skills).


##### `HostLoadedSkills::outcome`  (lines 147–149)

```
fn outcome(&self) -> &SkillLoadOutcome
```

**Purpose**: This exposes the wrapped SkillLoadOutcome so callers can inspect the loaded skills, errors, disabled paths, and related metadata. It returns a borrowed view rather than giving ownership away.

**Data flow**: It reads the shared pointer stored in HostLoadedSkills and returns a reference to the underlying SkillLoadOutcome. Nothing is cloned or changed.

**Call relations**: This is the simple access point for code that already has HostLoadedSkills and needs to look at the loaded result. It sits beside read_skill_text, which is the access point for reading the actual skill file contents.


##### `HostLoadedSkills::read_skill_text`  (lines 151–158)

```
async fn read_skill_text(&self, skill: &SkillMetadata) -> io::Result<String>
```

**Purpose**: This reads the text of a skill’s SKILLS.md file using the file system associated with that skill. It preserves the environment the skill came from, instead of blindly reading from the local machine.

**Data flow**: It receives a skill, looks up the skill’s file system in the loaded outcome, and falls back to the local file system if no specific mapping exists. It converts the absolute path into a path URI, asks the file system to read the text asynchronously, and returns either the file contents or an I/O error.

**Call relations**: Callers use this when they need the body of a host-loaded skill during a turn. It depends on the file-system mapping kept in SkillLoadOutcome and on path conversion before handing the read request to the ExecutorFileSystem.

*Call graph*: calls 1 internal fn (from_abs_path).


##### `SkillFileSystemsByPath::new`  (lines 167–171)

```
fn new(values: HashMap<AbsolutePathBuf, Arc<dyn ExecutorFileSystem>>) -> Self
```

**Purpose**: This builds the internal lookup table that connects skill file paths to the file systems that can read them. It is a small packaging step used after skills have been discovered.

**Data flow**: It receives a HashMap from absolute skill paths to shared ExecutorFileSystem objects. It wraps that map in Arc, a shared pointer, and returns a SkillFileSystemsByPath value. The wrapped map can then be cheaply cloned as a whole.

**Call relations**: Skill loading code calls this after collecting file-system mappings from skill roots. Later, SkillLoadOutcome::file_system_for_skill uses the resulting wrapper to find the correct reader for a skill.

*Call graph*: called by 1 (load_skills_from_roots); 1 external calls (new).


##### `SkillFileSystemsByPath::get`  (lines 173–175)

```
fn get(&self, path: &AbsolutePathBuf) -> Option<Arc<dyn ExecutorFileSystem>>
```

**Purpose**: This retrieves the file system recorded for one skill path. It returns a shared clone of the file-system pointer so the caller can use it without taking it out of the map.

**Data flow**: It receives an absolute path and checks the internal map. If the path is present, it clones the Arc pointer to the ExecutorFileSystem and returns it; if not, it returns none. The map itself is unchanged.

**Call relations**: SkillLoadOutcome::file_system_for_skill calls this as its private lookup step. That keeps the rest of the code from touching the map layout directly.

*Call graph*: called by 1 (file_system_for_skill).


##### `SkillFileSystemsByPath::retain_paths`  (lines 177–185)

```
fn retain_paths(&mut self, paths: &HashSet<AbsolutePathBuf>)
```

**Purpose**: This shrinks the file-system lookup table so it only contains paths that are still relevant. It is used after skills are filtered, so stale file-system entries do not remain attached to removed skills.

**Data flow**: It receives a set of paths to keep. It walks the current map, copies only entries whose path is in that set, wraps the new map in a fresh Arc, and replaces the old shared map inside this object.

**Call relations**: filter_skill_load_outcome_for_product uses this after removing skills that do not match a product restriction. It keeps the hidden file-system mapping aligned with the visible skill list.

*Call graph*: 1 external calls (new).


##### `SkillFileSystemsByPath::fmt`  (lines 189–193)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This controls how SkillFileSystemsByPath appears in debug output. Instead of printing file-system objects themselves, it prints only the number of stored entries.

**Data flow**: It receives a formatter and writes a debug structure named SkillFileSystemsByPath with one field, len, containing the map size. It returns the formatter result and does not change the mapping.

**Call relations**: This is used automatically by Rust’s debug-printing machinery because SkillFileSystemsByPath implements fmt::Debug. It helps developers inspect load outcomes without dumping large or opaque file-system objects.

*Call graph*: 1 external calls (debug_struct).


##### `filter_skill_load_outcome_for_product`  (lines 196–241)

```
fn filter_skill_load_outcome_for_product(
    mut outcome: SkillLoadOutcome,
    restriction_product: Option<Product>,
) -> SkillLoadOutcome
```

**Purpose**: This takes a loaded set of skills and removes anything not allowed for a given product. It also cleans the supporting lookup tables so the remaining outcome is internally consistent.

**Data flow**: It receives a SkillLoadOutcome and an optional product restriction. It keeps only skills whose policy matches the product, collects their paths, trims the file-system map and skill-root mappings to those paths, removes unused roots, and filters the implicit-skill maps by the same product rule. It returns the modified outcome.

**Call relations**: This function runs after skills have already been loaded and policy metadata is available. It uses each skill’s product-matching rule, updates the private maps that other readers depend on, and hands back an outcome that later selection and reading code can treat as product-specific.

*Call graph*: 1 external calls (new).


### `ext/skills/src/catalog.rs`

`data_model` · `cross-cutting during skill listing, rendering, reading, and searching`

A “skill” here is a reusable package of instructions or resources that Codex can show, read, or search. This file is the catalog’s set of labels and forms: it says how to name a skill, how to say who owns it, how to point at its main prompt file, and how to combine entries from multiple sources without showing duplicates.

The key idea is that callers should not guess where a skill lives by parsing strings. Instead, each skill has an authority, meaning the source that owns it and must be asked to read it. A resource can also carry an environment path when its contents belong to a specific execution environment. This is like a library card catalog: the card tells you which library branch owns the book, not just the book title.

`SkillCatalogEntry` is the visible card for one skill. It stores the name, description, optional short description, optional display path, dependencies, and flags for whether the skill is enabled or visible in prompts. `SkillCatalog` is a merged list for one turn, with warnings collected along the way. When entries are added, duplicates with the same authority and package id are skipped.

The file also defines simple result and error types for reading and searching skill resources. That lets different skill providers report information in the same shape.

#### Function details

##### `SkillSourceKind::custom`  (lines 20–22)

```
fn custom(kind: impl Into<String>) -> Self
```

**Purpose**: Creates a custom kind of skill source when the built-in source labels do not fit. This gives extensions a safe way to name their own source category.

**Data flow**: It receives any value that can be turned into text. It converts that value into a `String` and wraps it as the `Custom` source kind. The result is a `SkillSourceKind` ready to be stored in a skill authority.

**Call relations**: This is a constructor-style helper. Other code can use it before building a `SkillAuthority`, so later catalog and read paths can route the skill through the right owner.

*Call graph*: 2 external calls (into, Custom).


##### `SkillSourceKind::as_str`  (lines 24–31)

```
fn as_str(&self) -> &str
```

**Purpose**: Turns a skill source kind into the text label used for display or formatting. Built-in kinds become fixed words such as `host`, while custom kinds use their stored text.

**Data flow**: It reads the source kind already stored in `self`. It matches the variant and returns a borrowed text slice: a fixed label for known kinds or the custom string for custom kinds. It does not change anything.

**Call relations**: This is used by `SkillSourceKind::fmt` when Rust needs to print or format a source kind. It keeps the display wording in one place.

*Call graph*: called by 1 (fmt).


##### `SkillSourceKind::fmt`  (lines 35–37)

```
fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Defines how a skill source kind appears when it is printed as text. This matters for logs, messages, and any formatted output that includes the source kind.

**Data flow**: It receives the source kind and a formatter, asks `SkillSourceKind::as_str` for the right text, and writes that text into the formatter. The output is the normal formatting result that says whether writing succeeded.

**Call relations**: Rust calls this through the standard `Display` formatting path. It delegates the actual label choice to `SkillSourceKind::as_str`, so display output stays consistent.

*Call graph*: calls 1 internal fn (as_str).


##### `SkillAuthority::new`  (lines 48–53)

```
fn new(kind: SkillSourceKind, id: impl Into<String>) -> Self
```

**Purpose**: Builds a skill authority, which identifies who owns a skill and must be asked to list or read it. This keeps routing information explicit instead of hidden inside file paths or package names.

**Data flow**: It takes a source kind and an id value. The id is converted into a `String`, then stored with the kind in a new `SkillAuthority`. The returned authority can be attached to catalog entries or used for read/list routing.

**Call relations**: Catalog-building and provider code call this when turning discovered skills or resources into catalog entries, and tests use it to make sample entries. Later flows use the authority to know which provider owns the skill.

*Call graph*: called by 7 (list, catalog_entry_from_skill, read, catalog_entry_from_resource, from_authority, into_authority, test_entry); 1 external calls (into).


##### `SkillResourceId::new`  (lines 69–74)

```
fn new(id: impl Into<String>) -> Self
```

**Purpose**: Creates a plain resource id for a file or item inside a skill package. Use this when the resource is identified by an opaque id and is not tied to a specific environment path.

**Data flow**: It takes an id-like value, converts it into a `String`, and stores it with no environment path attached. The result is a `SkillResourceId` that can be put into a catalog entry or read request.

**Call relations**: Catalog creation and request handling call this when they need to point at a skill’s main prompt or another resource. It is the simple path used when no environment-owned filesystem location is needed.

*Call graph*: called by 4 (catalog_entry_from_skill, catalog_entry_from_resource, handle, test_entry); 1 external calls (into).


##### `SkillResourceId::environment`  (lines 76–88)

```
fn environment(
        id: impl Into<String>,
        environment_id: impl Into<String>,
        path: AbsolutePathBuf,
    ) -> Self
```

**Purpose**: Creates a resource id that is also tied to a specific execution environment and absolute path. This is used when the content belongs to an environment rather than being freely readable as an ordinary host file.

**Data flow**: It receives a resource id, an environment id, and an absolute path. It converts the two ids into strings, stores the path with them, and returns a `SkillResourceId` containing both the public id and the hidden environment location.

**Call relations**: Skill catalog creation uses this when a discovered skill resource is owned by an environment. Later read logic can inspect the environment path and route the read to the correct place.

*Call graph*: called by 1 (catalog_entry_from_skill); 1 external calls (into).


##### `SkillResourceId::as_str`  (lines 90–92)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the public text id for a skill resource. This lets display or rendering code show the resource id without learning how the resource object is stored inside.

**Data flow**: It reads the `id` field inside the resource and returns it as a borrowed string slice. It does not reveal or modify any attached environment path.

**Call relations**: This is a small accessor used wherever code needs the visible id. In this file, `SkillCatalogEntry::rendered_path` relies on it as a fallback when no separate display path is set.


##### `SkillResourceId::environment_path`  (lines 94–98)

```
fn environment_path(&self) -> Option<(&str, &AbsolutePathBuf)>
```

**Purpose**: Reveals the attached environment id and absolute path, if this resource was created for an environment-owned file. It is limited to the crate so outside callers cannot casually depend on this internal routing detail.

**Data flow**: It checks whether the resource has environment information. If it does, it returns the environment id and path by reference; if not, it returns nothing. The resource itself is not changed.

**Call relations**: Read or routing code inside the same crate can use this to decide whether a resource should be fetched from an execution environment. It supports the environment-aware resource path created by `SkillResourceId::environment`.


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

**Purpose**: Creates the standard catalog card for one skill with the required information filled in. It starts the entry in the common default state: enabled and visible in prompts.

**Data flow**: It receives a package id, authority, name, description, and main prompt resource. It converts the name and description into strings, sets optional fields to empty, sets dependencies to none, and marks the entry as enabled and prompt-visible. The result is a complete `SkillCatalogEntry` that can be further customized.

**Call relations**: Code that discovers skills calls this when turning raw skill data or resources into catalog entries, and tests use it for sample entries. Follow-up builder methods can add a short description, display path, dependencies, or visibility changes.

*Call graph*: called by 4 (catalog_entry_from_skill, catalog_entry_from_skill, catalog_entry_from_resource, test_entry); 1 external calls (into).


##### `SkillCatalogEntry::with_short_description`  (lines 144–147)

```
fn with_short_description(mut self, short_description: Option<String>) -> Self
```

**Purpose**: Adds or clears the short description on a catalog entry. This supports compact displays that need a shorter summary than the full description.

**Data flow**: It takes an existing entry and an optional string. It stores that optional short description on the entry and returns the updated entry. The original value is replaced.

**Call relations**: This is part of the builder-style setup after `SkillCatalogEntry::new`. Callers can chain it while constructing a catalog entry before the entry is inserted into a catalog.


##### `SkillCatalogEntry::with_display_path`  (lines 149–152)

```
fn with_display_path(mut self, display_path: impl Into<String>) -> Self
```

**Purpose**: Sets a friendly path to show for the skill instead of showing the raw resource id. This helps the catalog present clearer information to users.

**Data flow**: It takes an existing entry and a path-like value, converts the value into a `String`, stores it as `display_path`, and returns the updated entry.

**Call relations**: This is another builder-style customization used after creating an entry. Later, `SkillCatalogEntry::rendered_path` will prefer this display path when rendering catalog lines.

*Call graph*: 1 external calls (into).


##### `SkillCatalogEntry::with_dependencies`  (lines 154–157)

```
fn with_dependencies(mut self, dependencies: Option<SkillDependencies>) -> Self
```

**Purpose**: Attaches dependency information to a catalog entry, or leaves it absent. Dependencies describe extra requirements the skill may need.

**Data flow**: It takes an existing entry and optional dependency data. It stores that value in the entry and returns the updated entry. No validation or loading happens here; it only records the information.

**Call relations**: Callers use this during catalog construction after `SkillCatalogEntry::new`. The dependency data can later be shown or used by other skill logic.


##### `SkillCatalogEntry::disabled`  (lines 159–162)

```
fn disabled(mut self) -> Self
```

**Purpose**: Marks a catalog entry as not enabled. The entry can still exist in the catalog, but the flag tells later code it should not be treated as active.

**Data flow**: It takes an entry, changes its `enabled` flag from true to false, and returns the updated entry. All other fields stay the same.

**Call relations**: This builder-style method is used while preparing an entry. Later catalog consumers can read the flag and decide whether to show, skip, or restrict the skill.


##### `SkillCatalogEntry::hidden_from_prompt`  (lines 164–167)

```
fn hidden_from_prompt(mut self) -> Self
```

**Purpose**: Marks a skill so it should not be included in prompt-visible listings. This is useful for skills that exist for lookup or internal use but should not be advertised in the prompt.

**Data flow**: It takes an entry, changes its `prompt_visible` flag to false, and returns the updated entry. The skill’s identity and other metadata are unchanged.

**Call relations**: This is called during entry construction when a provider knows the skill should stay out of prompt rendering. Later prompt-building code can read the flag before including the entry.


##### `SkillCatalogEntry::rendered_path`  (lines 169–173)

```
fn rendered_path(&self) -> &str
```

**Purpose**: Chooses the path text that should be shown for a catalog entry. It prefers a friendly display path, but falls back to the main prompt resource id when no display path was provided.

**Data flow**: It reads the entry’s optional `display_path`. If present, it returns that text; otherwise, it asks the `main_prompt` resource for its id with `as_str`. The entry is not changed.

**Call relations**: Rendering code calls this when building a visible skill line. It hides the fallback rule so renderers do not need to duplicate it.

*Call graph*: called by 1 (render_skill_line).


##### `SkillCatalog::extend`  (lines 184–189)

```
fn extend(&mut self, other: SkillCatalog)
```

**Purpose**: Merges another skill catalog into this one. It adds new entries without duplicating the same authority-and-package pair, and it keeps any warnings from the other catalog.

**Data flow**: It receives another catalog. For each entry in that catalog, it passes the entry to `SkillCatalog::push_entry`, which decides whether to keep it. Then it appends the other catalog’s warnings to this catalog’s warning list. The current catalog is changed in place.

**Call relations**: Higher-level catalog merging code calls this when combining results from multiple skill sources. It relies on `SkillCatalog::push_entry` for the duplicate check.

*Call graph*: calls 1 internal fn (push_entry); called by 1 (extend_catalog).


##### `SkillCatalog::push_entry`  (lines 191–201)

```
fn push_entry(&mut self, entry: SkillCatalogEntry)
```

**Purpose**: Adds one catalog entry unless the same authority and package id are already present. This prevents the merged catalog from showing the same skill twice from the same owner.

**Data flow**: It receives one entry and scans the existing entries. If it finds an entry with the same authority and id, it drops the new one. Otherwise, it appends the new entry to the catalog. The catalog may or may not grow by one item.

**Call relations**: `SkillCatalog::extend` uses this for each incoming entry during catalog merging. Other code can also call it directly when adding entries one at a time.

*Call graph*: called by 1 (extend).


##### `SkillProviderError::new`  (lines 231–235)

```
fn new(message: impl Into<String>) -> Self
```

**Purpose**: Creates a simple error value with a human-readable message from a skill provider. Providers use this when listing, reading, or searching a skill fails.

**Data flow**: It receives a message-like value, converts it into a `String`, and stores it in a new `SkillProviderError`. The result can be returned inside a `SkillProviderResult` failure.

**Call relations**: Provider list, read, and search code call this when they need to report a problem in the common error shape defined by this file. Formatting later uses `SkillProviderError::fmt` to show the message.

*Call graph*: called by 8 (read, list, read, list, read, read, search, list); 1 external calls (into).


##### `SkillProviderError::fmt`  (lines 239–241)

```
fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Defines how a provider error appears when printed. It shows just the stored message, keeping error output straightforward.

**Data flow**: It receives the error and a formatter, reads the error’s message, and writes that message into the formatter. It returns the formatter’s success or failure result.

**Call relations**: Rust’s standard display and error-reporting paths call this when code prints a `SkillProviderError`. It makes the error usable with normal error handling tools.


### State and persistence schemas
These files define shared state, graph, memory-processing, thread-store, and process-status models used by persistence layers and runtime state management.

### `agent-graph-store/src/types.rs`

`data_model` · `cross-cutting`

This file is a small but important vocabulary file. The graph store needs a clear way to describe the life state of a directional edge where one agent thread spawned another. In plain terms, it answers: “Is this child thread still available, or is it finished from the graph’s point of view?”

The main type is `ThreadSpawnEdgeStatus`, an enum, which means a value that can be one of a fixed set of choices. Here there are only two choices: `Open` and `Closed`. This prevents the rest of the code from passing around loose strings like "open" or "done" and accidentally disagreeing about spelling or meaning.

The file also teaches the type how to be converted to and from stored data using Serde, a Rust library for serialization, meaning turning in-memory values into formats such as JSON and back again. The `snake_case` setting means `Open` becomes the text `"open"`, and `Closed` becomes `"closed"`. That matters because graph data may be written to disk, sent over an API, or compared in tests, and everyone needs the same wording.

A test at the bottom checks that this outside-facing spelling stays stable. Without this file, other parts of the graph store would lack a safe, shared way to represent whether spawned thread links are active or closed.

#### Function details

##### `tests::thread_spawn_edge_status_serializes_as_snake_case`  (lines 20–41)

```
fn thread_spawn_edge_status_serializes_as_snake_case()
```

**Purpose**: This test checks that `ThreadSpawnEdgeStatus` is written and read as lowercase JSON words: `"open"` and `"closed"`. It protects the public data format from accidental changes.

**Data flow**: The test starts with the two enum values, `Open` and `Closed`, and asks JSON serialization to turn them into text. It compares the results against the exact strings expected, then does the reverse: it reads those strings back and checks that they become the correct enum values again. Nothing permanent is changed; the output is simply a pass or fail result from the test.

**Call relations**: When the test suite runs, Rust’s test runner calls this function. Inside, it uses assertion checks to compare the actual JSON text and parsed values with the expected ones, so any mismatch is reported immediately.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/state/mod.rs`

`data_model` · `cross-cutting`

This file does not contain the state logic itself. Instead, it works like a table of contents and a reception desk for the `state` part of the codebase. The real work is split into nearby files: one tracks extra context, one records automatic compaction window information, one provides session services, one stores session-wide state, and one tracks the currently active turn of work.

Without this file, other parts of the project would need to know the exact internal file layout of the state system. That would make the code harder to read and easier to break when files are reorganized. By re-exporting key names such as `SessionState`, `ActiveTurn`, `TurnState`, and `SessionServices`, this file gives the rest of the application a stable, simple way to talk about state.

In plain terms, this file says: “Here are the important state building blocks, and here is where you can get them.” It also keeps the individual state files private to this area while still allowing selected types to be used elsewhere inside the crate. That boundary matters because session state is central to the program: it records what is happening now, what is waiting, what permissions are pending, and what background tasks are running.


### `core/src/unified_exec/process_state.rs`

`data_model` · `process execution and completion tracking`

When a tool starts another program, it needs to remember how that program ended. Did it finish normally? Did it return an exit code? Did something go wrong before or during execution? This file provides that memory in the form of `ProcessState`.

`ProcessState` is deliberately small. It stores three pieces of information: `has_exited`, which says whether the process is no longer running; `exit_code`, which is the numeric result programs often return to say success or failure; and `failure_message`, which is a human-readable explanation when something went wrong. The exit code is optional because sometimes a process may fail in a way that does not produce one.

The two methods work like simple state transitions. Rather than changing the existing value in place, they return a new `ProcessState` based on the old one. Calling `exited` marks the process as finished and records an exit code while keeping any previous failure message. Calling `failed` marks the process as finished and records a failure message while keeping any previous exit code. This is like updating a status card: one action fills in the “finished” and “exit code” boxes, another fills in the “problem description” box.

#### Function details

##### `ProcessState::exited`  (lines 9–15)

```
fn exited(&self, exit_code: Option<i32>) -> Self
```

**Purpose**: Marks a process state as finished and records the process exit code, if one is available. This is used when the system has learned that the process is no longer running.

**Data flow**: It starts with an existing `ProcessState` and receives an optional number for the exit code. It builds a new state where `has_exited` is set to true, `exit_code` is set to the supplied value, and any existing failure message is copied forward. The result is a new `ProcessState`; the original one is not changed.

**Call relations**: This function is part of the process state update flow. When other execution code detects that a process has ended, it can call this method to turn the old status into a completed status while preserving any failure explanation already attached.


##### `ProcessState::failed`  (lines 17–23)

```
fn failed(&self, message: String) -> Self
```

**Purpose**: Marks a process state as finished because something went wrong, and stores a readable failure message. This gives later code a clear explanation to show or log.

**Data flow**: It starts with an existing `ProcessState` and receives a text message describing the failure. It builds a new state where `has_exited` is set to true, the existing exit code is kept, and `failure_message` is replaced with the new message. The result is a new `ProcessState`; the original one is not changed.

**Call relations**: This function is used when the execution flow needs to record an error outcome. It complements `ProcessState::exited`: one records normal completion details, while this one records the reason the process should be treated as failed.


### `state/src/model/graph.rs`

`data_model` · `cross-cutting`

This file is a small piece of the project’s data vocabulary. Somewhere else in the system, relationships are modeled as a graph: pieces of state are connected by edges, like dots connected by arrows. A “directional thread-spawn edge” is one of those arrow-like connections, and this file defines the status that can be attached to it.

There are only two possible statuses. `Open` means the edge is still active or available. `Closed` means it has been finished, ended, or is no longer active. This is similar to marking a task in a notebook as either still open or crossed off.

The enum also derives helper behavior from the `strum` library. That means the status can be turned into readable text, displayed, and parsed from text using `snake_case` names such as `open` and `closed`. This matters when the status needs to be stored, logged, shown to people, or read back from serialized data.

Without this file, other parts of the graph model would not have a clear shared way to say whether this kind of edge is open or closed.


### `state/src/model/memories.rs`

`data_model` · `memory extraction and consolidation scheduling`

This file is mostly a vocabulary file. It does not do the work of extracting or consolidating memories itself. Instead, it defines the pieces of information that other code passes around while doing that work.

The system appears to build memories in stages. In stage 1, it extracts memory from a single conversation thread or rollout. `Stage1Output` is the saved result of that extraction: which thread it came from, where the source file lived, when the source was last updated, the raw memory text, a summary, the working directory, the Git branch if known, and when the memory was generated.

Because several workers might try to process the same thread, the file also defines claim results. A claim is like taking a numbered ticket at a service counter: if you get the ticket, you own the job for now; if not, the result explains why. `Stage1JobClaimOutcome` covers cases such as already up to date, another worker is running, retry backoff, or retries exhausted. `Stage1JobClaim` pairs a successfully claimed job with the thread metadata needed to process it.

`Stage1StartupClaimParams` holds the knobs used when claiming jobs during startup, such as how many threads to scan, how old they may be, and how long a lease lasts. Finally, `Phase2JobClaimOutcome` describes the same kind of claim decision for the global phase-2 consolidation job, where extracted memories are combined or refreshed as a larger workspace.


### `state/src/model/mod.rs`

`data_model` · `cross-cutting`

This file does not define new behavior itself. Instead, it acts like an index page for the project’s state data models: the Rust structs and enums that describe things the system stores or passes around, such as agent jobs, logs, thread metadata, thread goals, graph edges, and backfill progress.

Without this file, other parts of the codebase would need to know the exact internal file where each type lives. That would make imports more scattered and make future reorganizing harder. By re-exporting names like `AgentJob`, `LogEntry`, `ThreadMetadata`, and `BackfillState`, this file gives callers a stable, tidy doorway into the state layer.

It also separates public and internal access. The `pub use` lines expose types meant for broader use across the project. The `pub(crate) use` lines expose lower-level row types and helper conversion functions only inside this Rust crate. In plain terms, outside code gets the clean finished objects, while nearby internal code can still use the raw database-shaped pieces and date conversion helpers when needed.

An everyday analogy is a library help desk: the books are stored in many rooms, but visitors ask at one desk instead of wandering through every hallway.


### `thread-store/src/types.rs`

`data_model` · `cross-cutting: used whenever thread persistence APIs create, read, list, search, resume, or update stored threads`

This file is mostly a catalog of data structures: the named bundles of information that move into and out of the thread store. A “thread” here is a saved conversation, with its history, timestamps, working directory, model details, Git details, permissions, and optional archive state. Without these shared types, different parts of the system could disagree about what information is needed to save or reopen a thread, much like departments using different forms for the same customer record.

The file defines request types, such as creating a thread, resuming one, listing threads, searching thread content, listing turns, listing items inside a turn, and updating metadata. It also defines response types, such as stored thread summaries, pages of search results, pages of turns, and stored history.

A key idea in this file is patching metadata safely. Some fields need three meanings: “do not change this,” “set this to a value,” and “clear this value.” The `ClearableField<T>` type represents that. The small `optional_option` helper teaches JSON serialization how to preserve the difference between a missing field and a field explicitly set to `null`.

The merge methods let the system combine partial updates without accidentally erasing data that was not mentioned. Tests at the bottom protect this subtle behavior, especially around JSON round trips and nested Git metadata patches.

#### Function details

##### `optional_option::serialize`  (lines 26–35)

```
fn serialize(value: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: This helper writes a field with two layers of optional meaning into JSON or another serialized format. It exists so the system can tell the difference between “field was not included” and “field was included as null, so clear it.”

**Data flow**: It receives a value shaped like `Option<Option<T>>`. If the outer value is present, it serializes the inner value, which may be a real value or `null`. If the outer value is missing, it writes the field as absent/none through the serializer. The output is serialized data that preserves the intended patch meaning.

**Call relations**: Serde, the serialization library, calls this helper for fields marked with `with = "optional_option"`, such as clearable thread names and Git fields. When there is no outer value, it hands off to the serializer’s `serialize_none` behavior so omitted patch fields stay omitted.

*Call graph*: 1 external calls (serialize_none).


##### `optional_option::deserialize`  (lines 37–43)

```
fn deserialize(deserializer: D) -> Result<Option<Option<T>>, D::Error>
```

**Purpose**: This helper reads a clearable patch field back from JSON or another serialized format. It turns an included value, including `null`, into a patch instruction rather than losing the fact that the field was present.

**Data flow**: It receives serialized input for one field. It first deserializes that input as a normal optional value. Then it wraps the result in an outer `Some`, meaning “this field appeared in the input.” The result is `Some(Some(value))` for a real value or `Some(None)` for an explicit clear request.

**Call relations**: Serde calls this for clearable fields during decoding. It relies on the standard deserializer’s `deserialize` behavior, then adds the extra outer layer needed by the patch system.

*Call graph*: 1 external calls (deserialize).


##### `GitInfoPatch::merge`  (lines 464–474)

```
fn merge(&mut self, next: Self)
```

**Purpose**: This combines a newer Git metadata patch into an existing Git metadata patch. It keeps old instructions unless the newer patch explicitly says something about that field.

**Data flow**: It takes the current patch as mutable state and receives another patch. For each Git field, such as commit SHA, branch, or origin URL, it checks whether the newer patch included that field. If it did, the current instruction is replaced, including instructions to clear a value. If it did not, the current instruction stays as it was.

**Call relations**: This is used by `ThreadMetadataPatch::merge` when a thread metadata update contains nested Git information. The outer metadata merge delegates to this method so Git fields follow the same “only mentioned fields change” rule.


##### `ThreadMetadataPatch::merge`  (lines 561–630)

```
fn merge(&mut self, next: Self)
```

**Purpose**: This combines a newer thread metadata patch into an existing one without treating missing fields as deletions. It is used when several partial observations or updates need to be folded into one safe update.

**Data flow**: It starts with an existing metadata patch and receives a second patch. For each ordinary field, if the second patch includes a value, that value replaces the current one. If the second patch leaves a field out, the current value is kept. For clearable fields, an explicit `Some(None)` is kept as a real instruction to clear. For Git metadata, it creates a Git patch if needed and then merges the nested fields.

**Call relations**: This method is the main patch-combining tool in the file. When it reaches nested Git metadata, it hands that part to `GitInfoPatch::merge` so Git updates obey the same presence-based rules as the rest of the thread metadata.


##### `ThreadMetadataPatch::is_empty`  (lines 632–655)

```
fn is_empty(&self) -> bool
```

**Purpose**: This checks whether a metadata patch contains no requested changes at all. Callers can use it to skip unnecessary update work.

**Data flow**: It reads every field in the patch. If every field is missing, it returns `true`, meaning there is nothing to apply. If any field is present, even a clear request, it returns `false`.

**Call relations**: The test for accepting missing fields uses this method to confirm that an empty JSON object becomes an empty patch. Internally, the method relies on each field’s standard `is_none` check.

*Call graph*: 1 external calls (is_none).


##### `tests::thread_metadata_patch_round_trips_optional_clears`  (lines 691–715)

```
fn thread_metadata_patch_round_trips_optional_clears()
```

**Purpose**: This test proves that clear requests in thread metadata survive a JSON write-and-read cycle. That matters because an explicit `null` must mean “clear this field,” not “forget this instruction.”

**Data flow**: It builds a metadata patch where several clearable fields are set to `Some(None)`. It serializes the patch to JSON and checks that those fields appear as `null`. Then it deserializes the JSON back into a patch and checks that the clear requests are still present.

**Call relations**: This test exercises the `optional_option` serialization and deserialization helpers through real `ThreadMetadataPatch` fields. It uses JSON conversion and equality checks to make sure the external representation and internal meaning match.

*Call graph*: 4 external calls (default, assert_eq!, from_value, to_value).


##### `tests::git_info_patch_round_trips_optional_clears`  (lines 718–747)

```
fn git_info_patch_round_trips_optional_clears()
```

**Purpose**: This test proves that Git metadata patches correctly preserve both set and clear instructions when converted to and from JSON. It protects the nested patch behavior for fields like branch and origin URL.

**Data flow**: It creates a thread metadata patch containing a Git patch. The Git patch leaves the SHA untouched, sets the branch to `main`, and clears the origin URL. It serializes the patch, checks that only the intended Git fields appear, then deserializes it and checks that the original patch meaning is restored.

**Call relations**: This test covers `optional_option` inside `GitInfoPatch`, nested within `ThreadMetadataPatch`. It relies on JSON serialization, JSON deserialization, default values, and equality checks to verify the nested clear/set behavior.

*Call graph*: 4 external calls (default, assert_eq!, from_value, to_value).


##### `tests::thread_metadata_patch_accepts_missing_fields`  (lines 750–755)

```
fn thread_metadata_patch_accepts_missing_fields()
```

**Purpose**: This test makes sure old or minimal JSON patches with no fields are still accepted. That helps preserve compatibility when clients send only the fields they know about.

**Data flow**: It starts with an empty JSON object and deserializes it as a `ThreadMetadataPatch`. Then it asks the patch whether it is empty. The expected result is that deserialization succeeds and the patch reports no requested changes.

**Call relations**: This test directly supports `ThreadMetadataPatch::is_empty` and the default behavior of missing patch fields. It uses JSON parsing and an assertion to confirm that absent fields are treated as no-ops.

*Call graph*: 3 external calls (assert!, json!, from_value).


##### `tests::thread_metadata_patch_merge_uses_presence_semantics`  (lines 758–793)

```
fn thread_metadata_patch_merge_uses_presence_semantics()
```

**Purpose**: This test proves that merging patches only changes fields that are explicitly present in the newer patch. It protects against accidental data loss when a partial update omits a field.

**Data flow**: It begins with a patch containing an old name, preview, and Git information. Then it merges in a second patch that clears the name, omits the preview, adds a title, changes the Git branch, and clears the Git origin URL. After the merge, it checks that the name was cleared, the preview was preserved, the title was added, and Git fields were updated only where requested.

**Call relations**: This test exercises `ThreadMetadataPatch::merge`, including its delegation to `GitInfoPatch::merge` for nested Git metadata. The equality checks confirm the intended before-and-after story for presence-based patch merging.

*Call graph*: 2 external calls (default, assert_eq!).


### UI-facing application types
These files define small but shared application event and startup-error contracts used by the terminal UI layer.

### `tui/src/app_event.rs`

`data_model` · `cross-cutting during UI event handling`

The terminal UI is made of many smaller pieces, such as chat widgets, pickers, popups, status lines, and background tasks. Those pieces should not directly reach into the main App object to change everything themselves. Instead, they send an AppEvent, which is like dropping a clearly labeled request into a central mailbox. The main app loop reads the request and decides what to do.

Most of this file is a large enum, AppEvent. An enum is a type that can be one of many named choices. Each choice describes one kind of thing that can happen: start a new session, look up message history, refresh rate limits, show plugin details, install or remove a plugin, open a browser URL, update model settings, submit feedback, or quit the application. Many events carry the exact information needed to complete the action, such as a thread ID, file path, request ID, plugin name, or success-or-error result.

The file also defines small supporting types that make events clearer. For example, ExitMode says whether to shut down cleanly first or exit immediately, RateLimitRefreshOrigin explains why account limits are being refreshed, and PluginLocation says whether a plugin comes from a local marketplace path or a remote marketplace name. Without this file, UI components would need tight, brittle connections to app internals instead of speaking through one shared, explicit language.

#### Function details

##### `PluginLocation::into_request_params`  (lines 100–105)

```
fn into_request_params(self) -> (Option<AbsolutePathBuf>, Option<String>)
```

**Purpose**: This function turns a plugin source into the pair of fields expected by the plugin install request. It makes sure a local plugin source becomes a local path, while a remote plugin source becomes a marketplace name.

**Data flow**: It takes a PluginLocation value as input. If the value is Local, it extracts the marketplace path and returns it in the first slot with no remote name. If the value is Remote, it extracts the marketplace name and returns it in the second slot with no local path. The output is a pair: optional local path, optional remote marketplace name.

**Call relations**: When the app is preparing to install a plugin, fetch_plugin_install calls this helper to translate the UI-level idea of where the plugin came from into the lower-level request shape used by the install call. This keeps the install flow from repeating the same local-versus-remote branching logic.

*Call graph*: called by 1 (fetch_plugin_install).


### `tui/src/startup_error.rs`

`data_model` · `startup`

When the terminal UI starts, it needs a local SQLite database to store state. If that database cannot be initialized, the program needs more than a vague “startup failed” message. It needs to know which file caused the problem and what went wrong, so it can tell the user, decide whether the problem can be fixed automatically, or back up the bad file and start fresh.

This file provides a small error type called `LocalStateDbStartupError`. Think of it like a labeled incident report: it contains the location of the database file and a short explanation of the failure. The `thiserror` annotation gives it a ready-made display message, so it can be printed as a normal error: “failed to initialize sqlite local db at ...”. SQLite is the small embedded database stored in a local file.

The rest of the file is simple access methods. Other parts of the program can ask for the database path, ask for the same path using the older or alternate name `state_db_path`, or ask for the detailed explanation. This keeps startup and recovery code from having to parse an error string; it can read the structured information directly.

#### Function details

##### `LocalStateDbStartupError::new`  (lines 15–20)

```
fn new(database_path: PathBuf, detail: String) -> Self
```

**Purpose**: Creates a new startup database error from the path of the failed SQLite file and a plain-text explanation of the failure. Code uses this when it has detected that the local state database could not be initialized.

**Data flow**: It receives a database file path and a detail message. It stores both inside a new `LocalStateDbStartupError`. The result is an error value that can later be displayed to a user or inspected by recovery code.

**Call relations**: This constructor is used in flows that test or exercise recovery from failed database startup, such as backing up only the failed database file or replacing a blocking file in the SQLite home area. It is the point where the raw failure information becomes the structured error object used by the rest of the startup recovery logic.

*Call graph*: called by 2 (backup_backs_up_only_failed_database_file, backup_replaces_blocking_sqlite_home_file).


##### `LocalStateDbStartupError::database_path`  (lines 22–24)

```
fn database_path(&self) -> &Path
```

**Purpose**: Returns the path to the SQLite database file that failed to start. This lets other code find the exact file involved without digging through an error message.

**Data flow**: It reads the stored `PathBuf`, which is an owned file path, and returns it as a borrowed `Path`, meaning callers can look at the path without taking ownership or changing it. Nothing inside the error is modified.

**Call relations**: Recovery and cleanup code calls this when it needs the failed database location, for example when deciding which files to back up for a fresh start or checking whether a blocking file is in the way. `state_db_path` also calls this method so both names point to the same stored path.

*Call graph*: called by 3 (backup_files_for_fresh_start, sqlite_home_is_blocking_file, state_db_path); 1 external calls (as_path).


##### `LocalStateDbStartupError::state_db_path`  (lines 26–28)

```
fn state_db_path(&self) -> &Path
```

**Purpose**: Returns the same failed database path as `database_path`, using a name that describes it as the app’s state database. This is useful for callers that think in terms of “state database” rather than “database file.”

**Data flow**: It takes the existing error object, calls `database_path`, and passes that borrowed path straight back to the caller. It does not create a new path and does not change the error.

**Call relations**: This method is a small alias layered on top of `database_path`. When code asks for the state database path, it delegates to the main path accessor so there is only one source of truth for the stored file location.

*Call graph*: calls 1 internal fn (database_path).


##### `LocalStateDbStartupError::detail`  (lines 30–32)

```
fn detail(&self) -> &str
```

**Purpose**: Returns the detailed reason why the local SQLite database failed to initialize. Recovery code can use this text to decide whether the error looks automatically fixable.

**Data flow**: It reads the stored detail string and returns it as a borrowed string slice. The caller gets the explanation text without copying it or changing the error.

**Call relations**: Automatic backup and recovery logic calls this when checking whether a startup failure is recoverable. In that larger flow, the error supplies the evidence, and the recovery code decides what action, if any, is safe to take.

*Call graph*: called by 1 (is_auto_backup_recoverable).
