# Protocol schema and wire-format verification  `stage-23.1.1`

This stage is a behind-the-scenes safety check for the project’s communication rules. It does not run the app’s main work. Instead, it makes sure the messages sent between the app server and its clients keep the same shape over time. That “wire format” is the agreed JSON layout used on the network, like a shared form both sides know how to fill in.

The common protocol tests check how client response data becomes JSON-RPC response parts. JSON-RPC is a simple request-and-response message style using JSON. These tests confirm when a response should also create an internal client response object, and when it should remain only a plain JSON-RPC result.

The version 2 remote-control tests focus on remote-control messages, checking that Rust data structures turn into exactly the expected JSON and can be read back correctly. The broader version 2 protocol tests cover app-server messages, older accepted JSON shapes, and conversions to and from core Codex protocol types.

Finally, the schema fixture test compares generated protocol schemas with the checked-in copies, catching accidental protocol changes.

## Files in this stage

### Protocol conversion basics
These tests establish the core response-conversion behavior that underpins higher-level protocol wire-format expectations.

### `app-server-protocol/src/protocol/common_tests.rs`

`test` · `test suite`

This is a small test file for the protocol layer, the part of the system that shapes messages sent between the app server and its clients. The main question it checks is: when the server has a typed response object, how should that become a JSON-RPC response? JSON-RPC is a common message format where each reply has an id and a JSON result.

The file covers two important cases. First, a thread archive response should preserve the original request id, produce an empty JSON result, and also be convertible into a richer internal `ClientResponse`. That richer response is useful when the system wants to treat the message as a typed event rather than just raw JSON.

Second, an interrupt conversation response should also preserve its request id and produce the expected JSON result, including the abort reason. But unlike the thread archive case, it should not create an extra client response payload. In other words, this response should remain just the normal JSON-RPC reply.

These tests matter because protocol conversion bugs are easy to miss but can break communication between server and client. They act like a customs checkpoint: each outgoing response must have the right id, the right JSON shape, and the right follow-up behavior.

#### Function details

##### `client_response_payload_returns_jsonrpc_parts_and_client_response`  (lines 8–25)

```
fn client_response_payload_returns_jsonrpc_parts_and_client_response() -> Result<()>
```

**Purpose**: This test checks that a thread archive response is split into the correct JSON-RPC pieces and can still become a typed client response. It protects the rule that this kind of response is both a normal JSON-RPC result and something the client-response layer can understand by name.

**Data flow**: It starts with a `ThreadArchive` response and a request id of `7`. The conversion turns that into three things: the same request id, an empty JSON result, and an optional payload. The test then turns that optional payload back into a `ClientResponse` and verifies that the response is specifically a thread archive response with the same request id.

**Call relations**: The Rust test runner calls this function during automated tests. Inside the test, it creates a thread archive payload, asks the protocol conversion code to break it into JSON-RPC-style parts, and uses equality checks to confirm the conversion kept the id and produced the expected JSON. If the optional payload cannot become the expected client response, the test deliberately fails.

*Call graph*: 4 external calls (ThreadArchive, Integer, assert_eq!, panic!).


##### `interrupt_conversation_payload_stays_jsonrpc_only`  (lines 28–44)

```
fn interrupt_conversation_payload_stays_jsonrpc_only() -> Result<()>
```

**Purpose**: This test checks that an interrupt conversation response becomes only a JSON-RPC response and does not create an extra typed client response payload. It protects the rule that interruption replies report their abort reason in JSON but do not continue through the client-response path.

**Data flow**: It starts with an `InterruptConversation` response whose abort reason is `Interrupted`, plus a request id of `8`. The conversion produces the same request id, a JSON result containing `abortReason: "interrupted"`, and no optional payload. The test verifies all three outcomes.

**Call relations**: The Rust test runner calls this function as part of the protocol tests. The test builds an interrupt response, sends it through the same conversion path used by real protocol code, then checks that the JSON result is correct and that the extra payload slot is empty.

*Call graph*: 4 external calls (InterruptConversation, Integer, assert!, assert_eq!).


### V2 wire-format regression tests
These tests progressively lock down the v2 protocol’s serialization rules, from focused remote-control cases to the full cross-feature regression suite.

### `app-server-protocol/src/protocol/v2/remote_control_tests.rs`

`test` · `test suite`

This is a small test file for the remote-control part of the protocol. Its job is to make sure the JSON seen outside the program matches the Rust structures used inside the program. That matters because a protocol is like a contract: if one side sends `environmentId` but the other side expects `environment_id`, or if missing optional values disappear instead of becoming `null`, clients can break even though the Rust code still compiles.

The tests focus on two remote-control messages. First, they check `RemoteControlClientsListParams`, the input used when asking for a list of remote-control clients. The file confirms that Rust’s snake_case field `environment_id` becomes the camelCase JSON field `environmentId`, and that optional fields such as cursor, limit, and order are serialized as explicit `null` values when empty. It also checks the reverse direction: JSON with camelCase field names and an order value like `asc` becomes the right Rust struct and enum value.

Second, it checks `RemoteControlClientsRevokeResponse`. This response has no fields, so the test makes sure it is still sent as an empty JSON object, `{}`, rather than some other shape like `null`. These tests act as guardrails around small details that are easy to change by accident but important for compatibility.

#### Function details

##### `remote_control_clients_list_params_serialize_nullable_optional_fields`  (lines 6–22)

```
fn remote_control_clients_list_params_serialize_nullable_optional_fields()
```

**Purpose**: This test proves that list-client request parameters serialize to the expected JSON when optional fields are not set. It specifically protects the choice to send those empty optional values as `null` instead of leaving them out.

**Data flow**: It starts with a `RemoteControlClientsListParams` Rust value containing an environment id and no cursor, limit, or order. The value is converted into JSON. The test then compares that JSON with the expected object containing `environmentId` and three explicit `null` fields; if they differ, the test fails.

**Call relations**: During the test run, the Rust test harness runs this function as an independent check. Inside it, the final decision is handed to `assert_eq!`, which compares the produced JSON with the expected JSON and reports a clear failure if the protocol shape changed.

*Call graph*: 1 external calls (assert_eq!).


##### `remote_control_clients_list_params_deserialize_camel_case_fields`  (lines 25–41)

```
fn remote_control_clients_list_params_deserialize_camel_case_fields()
```

**Purpose**: This test checks that incoming JSON using the protocol’s camelCase field names can be read into the correct Rust data structure. It protects compatibility with clients that send fields such as `environmentId` and values such as `asc`.

**Data flow**: It begins with a JSON object that looks like a real request from outside the program. That JSON is deserialized, meaning it is translated into a `RemoteControlClientsListParams` Rust value. The test compares the result with the exact Rust value expected: the environment id as text, the cursor and limit filled in, and the order converted into the `Asc` enum value.

**Call relations**: The test harness calls this function while running the project’s tests. The function uses `assert_eq!` at the end to confirm that the deserialized Rust value matches the expected one, catching mistakes in field naming or enum value mapping.

*Call graph*: 1 external calls (assert_eq!).


##### `remote_control_clients_revoke_response_serializes_as_empty_object`  (lines 44–50)

```
fn remote_control_clients_revoke_response_serializes_as_empty_object()
```

**Purpose**: This test makes sure an empty revoke response is still represented as an empty JSON object. That matters because clients may expect `{}` as the response shape, not `null` or some omitted value.

**Data flow**: It creates an empty `RemoteControlClientsRevokeResponse` Rust value and converts it to JSON. The output is compared with `{}`. If serialization ever changes to produce a different JSON shape, the comparison fails.

**Call relations**: The Rust test harness runs this function as one protocol compatibility check. The function relies on `assert_eq!` to compare the actual serialized response with the required empty object shape.

*Call graph*: 1 external calls (assert_eq!).


### `app-server-protocol/src/protocol/v2/tests.rs`

`test` · `test/CI`

The protocol is the shared language between the app server and its clients. If one field name changes, a missing value is treated differently, or an old client sends a now-legacy shape, real users can see broken conversations, failed approvals, bad file paths, or unusable plugins. This test file protects that contract.

Most tests build a protocol value, serialize it to JSON, and compare it with the public API shape. Many also deserialize JSON back into Rust values to prove the round trip works. Others check compatibility rules, such as accepting old field names, defaulting missing fields, rejecting unsafe relative paths, and marking experimental features with the right warning reason.

The file covers many protocol areas: threads and turns, permission requests, filesystem calls, command and process streaming, sandbox policies, MCP server messages, network rules, conversation items, skills, plugins, marketplace sharing, error details, dynamic tools, service tiers, environments, and realtime text input. The small path helper functions keep path tests portable across operating systems. Think of this file as a customs checklist at the border between the server and every client: it makes sure every package is labeled, shaped, and accepted exactly as agreed.

#### Function details

##### `absolute_path_string`  (lines 48–51)

```
fn absolute_path_string(path: &str) -> String
```

**Purpose**: Builds a test-only absolute path and returns it as a display string. Tests use it when they need the JSON form of an absolute path.

**Data flow**: It receives a path fragment, makes sure it starts with a slash, passes it through the test path helper, and returns the resulting path as text.

**Call relations**: Individual tests call this helper when building expected JSON. It relies on the shared test path builder so path text matches the current platform.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `absolute_path`  (lines 53–56)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Builds a test-only absolute path object. Tests use it when they need the Rust value form of an absolute path.

**Data flow**: It receives a path fragment, normalizes it into an absolute-looking path, converts it through the test path helper, and returns an AbsolutePathBuf.

**Call relations**: Filesystem, sandbox, thread, and permission tests call this helper to avoid repeating path setup. It hands those tests a safe absolute path value.

*Call graph*: called by 8 (additional_file_system_permissions_populates_entries_for_legacy_roots, fs_copy_params_round_trip_with_recursive_directory_copy, fs_create_directory_params_round_trip_with_default_recursive, fs_read_file_params_round_trip, fs_write_file_params_round_trip_with_base64_data, sandbox_policy_deserializes_legacy_workspace_write_full_access_field, test_absolute_path, thread_resume_response_round_trips_initial_turns_page); 2 external calls (test_path_buf, format!).


##### `test_absolute_path`  (lines 58–60)

```
fn test_absolute_path() -> AbsolutePathBuf
```

**Purpose**: Provides one standard absolute path used by process-spawn tests. It avoids repeating the same sample path in several places.

**Data flow**: It takes no input, asks absolute_path for the path named readable, and returns that absolute path object.

**Call relations**: The process spawn tests call this helper when they need a consistent current working directory. It delegates all path construction to absolute_path.

*Call graph*: calls 1 internal fn (absolute_path); called by 2 (process_spawn_params_distinguish_omitted_null_and_value_limits, process_spawn_params_round_trips_without_sandbox_policy).


##### `thread_sources_round_trip_as_scalar_labels`  (lines 63–84)

```
fn thread_sources_round_trip_as_scalar_labels()
```

**Purpose**: Checks that thread source values are encoded as simple JSON strings and can be decoded back. This protects the public labels clients see.

**Data flow**: It tries several thread source variants, serializes each to JSON, compares the JSON string label, deserializes it, and also checks conversion through the core protocol type.

**Call relations**: The test runner calls this test. It exercises serde JSON conversion and core-protocol conversion for ThreadSource.

*Call graph*: 3 external calls (Feature, assert_eq!, to_value).


##### `approvals_reviewer_serializes_auto_review_and_accepts_legacy_guardian_subagent`  (lines 87–108)

```
fn approvals_reviewer_serializes_auto_review_and_accepts_legacy_guardian_subagent()
```

**Purpose**: Checks how approval reviewer choices appear in JSON, including an old name that must still be accepted. This keeps older clients from breaking.

**Data flow**: It serializes current reviewer values, then deserializes user, auto_review, and the legacy guardian_subagent label, expecting the legacy label to map to AutoReview.

**Call relations**: The test runner calls this test. It depends on the protocol type's serializer and deserializer to enforce compatibility.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `turn_defaults_legacy_missing_items_view_to_full`  (lines 111–124)

```
fn turn_defaults_legacy_missing_items_view_to_full()
```

**Purpose**: Makes sure old turn JSON without an itemsView field still means a full item list. This protects stored or older responses from changing meaning.

**Data flow**: It feeds a legacy turn JSON object into deserialization and checks that the resulting turn has items_view set to Full.

**Call relations**: The test runner calls this test during protocol compatibility checks. It exercises Turn deserialization defaults.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `thread_turns_list_params_accepts_items_view`  (lines 127–139)

```
fn thread_turns_list_params_accepts_items_view()
```

**Purpose**: Checks that requests for listing turns can ask whether turn items are loaded. This lets clients request lighter or fuller responses.

**Data flow**: It deserializes JSON containing threadId and itemsView, then checks that the thread id and parsed view option match the request.

**Call relations**: The test runner calls this test. It validates the request type used before the server lists thread turns.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `thread_resume_params_accept_turns_page_bootstrap`  (lines 142–162)

```
fn thread_resume_params_accept_turns_page_bootstrap()
```

**Purpose**: Checks that resuming a thread can include initial turn-page options. This lets a client resume and request a first page of turns in one payload.

**Data flow**: It deserializes resume JSON with initialTurnsPage settings and checks that limit, sort direction, and item view are preserved.

**Call relations**: The test runner calls this test. It validates ThreadResumeParams before resume orchestration would use it.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `thread_resume_response_round_trips_initial_turns_page`  (lines 165–219)

```
fn thread_resume_response_round_trips_initial_turns_page()
```

**Purpose**: Checks that a thread resume response can include an initial page of turns and survive JSON round trip. This protects pagination data sent at resume time.

**Data flow**: It builds a full response, serializes it, checks the initialTurnsPage JSON, then deserializes the value and compares it with the original response.

**Call relations**: The test runner calls this test. It uses absolute_path to construct path fields and exercises response serialization and deserialization.

*Call graph*: calls 1 internal fn (absolute_path); 4 external calls (new, new, assert_eq!, to_value).


##### `thread_turns_items_list_round_trips`  (lines 222–257)

```
fn thread_turns_items_list_round_trips()
```

**Purpose**: Checks the JSON shape for listing items inside a specific turn. This protects the paging contract for individual turn contents.

**Data flow**: It builds request parameters and a response with one context-compaction item, serializes both, and compares them to the expected JSON.

**Call relations**: The test runner calls this test. It focuses on the thread-turn item listing request and response types.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `thread_list_params_accepts_single_cwd`  (lines 260–271)

```
fn thread_list_params_accepts_single_cwd()
```

**Purpose**: Checks that thread listing can filter by one working directory. This supports a convenient client shortcut.

**Data flow**: It deserializes JSON with cwd as one string and checks that the filter becomes the One variant and the state-db-only flag remains false.

**Call relations**: The test runner calls this test. It validates ThreadListParams deserialization for a single directory filter.

*Call graph*: 3 external calls (assert!, assert_eq!, json!).


##### `thread_list_params_accepts_multiple_cwds`  (lines 274–287)

```
fn thread_list_params_accepts_multiple_cwds()
```

**Purpose**: Checks that thread listing can filter by several working directories. This lets clients ask for conversations across multiple projects.

**Data flow**: It deserializes JSON where cwd is an array and checks that the filter becomes the Many variant with the same directory strings.

**Call relations**: The test runner calls this test. It covers the alternate array form of the same thread-list filter.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `thread_list_params_accepts_state_db_only_flag`  (lines 290–297)

```
fn thread_list_params_accepts_state_db_only_flag()
```

**Purpose**: Checks that thread listing can request only the state database. This protects a flag used to avoid other sources of thread data.

**Data flow**: It deserializes JSON with useStateDbOnly set to true and checks that the boolean is true in the parsed parameters.

**Call relations**: The test runner calls this test. It validates one optional flag in ThreadListParams.

*Call graph*: 2 external calls (assert!, json!).


##### `collab_agent_state_maps_interrupted_status`  (lines 300–308)

```
fn collab_agent_state_maps_interrupted_status()
```

**Purpose**: Checks that an interrupted core agent status becomes the app protocol's interrupted collaboration state. This keeps collaborative UI state accurate.

**Data flow**: It converts CoreAgentStatus::Interrupted into CollabAgentState and compares the result with the expected status and no message.

**Call relations**: The test runner calls this test. It exercises the conversion from core protocol status into the v2 app protocol type.

*Call graph*: 1 external calls (assert_eq!).


##### `external_agent_config_plugins_details_round_trip`  (lines 311–342)

```
fn external_agent_config_plugins_details_round_trip()
```

**Purpose**: Checks that plugin migration details from an external agent config deserialize correctly. This supports importing settings from other tools.

**Data flow**: It deserializes JSON describing a plugin migration item, including a marketplace and plugin name, and compares it with the expected Rust value.

**Call relations**: The test runner calls this test. It verifies the migration item type and nested details used by external config import.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `external_agent_config_import_params_accept_legacy_plugin_details`  (lines 345–380)

```
fn external_agent_config_import_params_accept_legacy_plugin_details()
```

**Purpose**: Checks that import parameters still accept the older plugin-details shape. This keeps legacy import data usable.

**Data flow**: It deserializes a migrationItems array containing plugin details and compares the parsed import parameters with the expected structure.

**Call relations**: The test runner calls this test. It covers the wrapper request type around the same migration item format.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `command_execution_request_approval_localization_rejects_relative_additional_permission_paths`  (lines 383–413)

```
fn command_execution_request_approval_localization_rejects_relative_additional_permission_paths()
```

**Purpose**: Checks that extra filesystem permissions in a command approval cannot use relative paths. This is a safety rule because permissions must name exact absolute locations.

**Data flow**: It deserializes an approval request containing a relative read path, extracts additional permissions, tries to convert them to core permissions, and expects an invalid-input error.

**Call relations**: The test runner calls this test. It uses the core permission converter as the final safety check after API deserialization.

*Call graph*: 3 external calls (try_from, assert_eq!, json!).


##### `permissions_request_approval_uses_request_permission_profile`  (lines 416–489)

```
fn permissions_request_approval_uses_request_permission_profile()
```

**Purpose**: Checks that a permission request uses the request-permission profile shape and converts to the core protocol correctly. This protects the approval flow for adding network and filesystem access.

**Data flow**: It builds JSON with network and read/write path permissions, deserializes it, checks the v2 representation, then converts it to the core permission profile and compares the result.

**Call relations**: The test runner calls this test. It bridges the app-server protocol request type to the core protocol permission model.

*Call graph*: 3 external calls (assert_eq!, cfg!, json!).


##### `permissions_request_approval_rejects_macos_permissions`  (lines 492–520)

```
fn permissions_request_approval_rejects_macos_permissions()
```

**Purpose**: Checks that Mac-specific permission fields are not accepted in this request. This prevents clients from sending unsupported permission categories.

**Data flow**: It tries to deserialize JSON containing a macos permission block and expects an error that reports an unknown field.

**Call relations**: The test runner calls this test. It relies on strict deserialization of PermissionsRequestApprovalParams.

*Call graph*: 2 external calls (assert!, json!).


##### `additional_file_system_permissions_preserves_canonical_entries`  (lines 523–570)

```
fn additional_file_system_permissions_preserves_canonical_entries()
```

**Purpose**: Checks that the newer canonical filesystem permission entries are preserved. This matters for special paths, glob patterns, and deny rules that cannot be represented by simple read/write roots.

**Data flow**: It builds core permissions with a root write entry and an env-file deny glob, converts them to v2 permissions, checks the entries, then converts back to core and compares.

**Call relations**: The test runner calls this test. It exercises conversion in both directions between core filesystem permissions and v2 API permissions.

*Call graph*: calls 1 internal fn (from); 3 external calls (new, assert_eq!, vec!).


##### `additional_file_system_permissions_populates_entries_for_legacy_roots`  (lines 573–612)

```
fn additional_file_system_permissions_populates_entries_for_legacy_roots()
```

**Purpose**: Checks that older read/write root fields still populate the newer entries list. This keeps old clients compatible while exposing the newer canonical form.

**Data flow**: It builds core permissions from read and write roots, converts to v2 permissions, checks both legacy fields and entries, then converts back to core.

**Call relations**: The test runner calls this test. It uses absolute_path and LegacyAppPathString to compare path values in both old and new forms.

*Call graph*: calls 3 internal fn (from, absolute_path, from_abs_path); 3 external calls (from_read_write_roots, assert_eq!, vec!).


##### `additional_file_system_permissions_rejects_zero_glob_scan_depth`  (lines 615–623)

```
fn additional_file_system_permissions_rejects_zero_glob_scan_depth()
```

**Purpose**: Checks that a glob scan depth of zero is rejected. A nonzero depth is required so the limit has a meaningful value.

**Data flow**: It tries to deserialize filesystem permissions with globScanMaxDepth set to 0 and expects deserialization to fail.

**Call relations**: The test runner calls this test. It exercises validation built into AdditionalFileSystemPermissions.

*Call graph*: 1 external calls (json!).


##### `legacy_current_working_directory_special_path_deserializes_as_project_roots`  (lines 626–643)

```
fn legacy_current_working_directory_special_path_deserializes_as_project_roots()
```

**Purpose**: Checks that an old special path name for the current working directory maps to the newer project-roots concept. This preserves old saved permission data.

**Data flow**: It deserializes the legacy special path JSON, checks the Rust value is ProjectRoots with no subpath, then checks that serialization uses the new name.

**Call relations**: The test runner calls this test. It validates backward compatibility and canonical output for FileSystemSpecialPath.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `permissions_request_approval_response_uses_granted_permission_profile_without_macos`  (lines 646–710)

```
fn permissions_request_approval_response_uses_granted_permission_profile_without_macos()
```

**Purpose**: Checks that approval responses use the granted-permission profile shape and exclude unsupported Mac permissions. This protects the data returned after a user grants access.

**Data flow**: It deserializes a response with network and file permissions, checks the v2 granted profile, then converts it to the core additional-permission profile and compares it.

**Call relations**: The test runner calls this test. It connects the response type to the core permission model used after approval.

*Call graph*: 3 external calls (assert_eq!, cfg!, json!).


##### `permissions_request_approval_response_defaults_scope_to_turn`  (lines 713–721)

```
fn permissions_request_approval_response_defaults_scope_to_turn()
```

**Purpose**: Checks that a permission grant response defaults to turn scope. This means missing scope only grants access for the current turn, not longer.

**Data flow**: It deserializes a response with empty permissions and checks that scope is Turn and strict auto-review is absent.

**Call relations**: The test runner calls this test. It validates safe defaults in PermissionsRequestApprovalResponse.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `permissions_request_approval_response_accepts_strict_auto_review`  (lines 724–732)

```
fn permissions_request_approval_response_accepts_strict_auto_review()
```

**Purpose**: Checks that approval responses can carry the strictAutoReview flag. This lets clients ask for tighter automatic review behavior.

**Data flow**: It deserializes a response with strictAutoReview true and checks that the parsed field is Some(true).

**Call relations**: The test runner calls this test. It covers an optional response field used by the permission approval flow.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `permission_profile_selection_uses_id_string`  (lines 735–779)

```
fn permission_profile_selection_uses_id_string()
```

**Purpose**: Checks that permission profiles are selected by simple string identifiers in several request types. This avoids embedding full permission profiles where only an ID is expected.

**Data flow**: It deserializes thread start, turn start, command exec, thread resume, and thread fork JSON with permission profile strings and checks each parsed field.

**Call relations**: The test runner calls this test. It validates a shared convention across several client request types.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `thread_path_params_deserialize_empty_path_as_none`  (lines 782–806)

```
fn thread_path_params_deserialize_empty_path_as_none()
```

**Purpose**: Checks that an empty path string means no path for resume and fork requests. This keeps clients that send empty strings from accidentally creating invalid paths.

**Data flow**: It deserializes resume and fork JSON with an empty path and checks they become None, then checks a real path becomes Some(PathBuf).

**Call relations**: The test runner calls this test. It exercises custom path deserialization on thread lifecycle request types.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `fs_get_metadata_response_round_trips_minimal_fields`  (lines 809–833)

```
fn fs_get_metadata_response_round_trips_minimal_fields()
```

**Purpose**: Checks the JSON shape for filesystem metadata responses. This protects clients that inspect whether a path is a file, directory, or symlink and when it changed.

**Data flow**: It builds a metadata response, serializes it to JSON with camelCase fields, deserializes it back, and compares the result.

**Call relations**: The test runner calls this test. It validates the fs/getMetadata response contract.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `fs_read_file_response_round_trips_base64_data`  (lines 836–852)

```
fn fs_read_file_response_round_trips_base64_data()
```

**Purpose**: Checks that file-read responses carry file bytes as base64 text. Base64 is used so arbitrary binary data can travel through JSON safely.

**Data flow**: It builds a response with base64 data, serializes it, compares the JSON, deserializes it, and checks equality.

**Call relations**: The test runner calls this test. It validates the fs/readFile response type.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `fs_read_file_params_round_trip`  (lines 855–871)

```
fn fs_read_file_params_round_trip()
```

**Purpose**: Checks the JSON shape for reading a file path. This protects the client-to-server request format for file reads.

**Data flow**: It builds params with an absolute path, serializes them to JSON, compares the path string, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It uses absolute_path to create the path under test.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, to_value).


##### `fs_create_directory_params_round_trip_with_default_recursive`  (lines 874–892)

```
fn fs_create_directory_params_round_trip_with_default_recursive()
```

**Purpose**: Checks the JSON shape for creating a directory when recursive is unspecified. This preserves the difference between a missing decision and a chosen true or false.

**Data flow**: It builds create-directory params with recursive set to None, serializes to JSON where recursive is null, deserializes, and compares.

**Call relations**: The test runner calls this test. It uses absolute_path for the directory path.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, to_value).


##### `fs_write_file_params_round_trip_with_base64_data`  (lines 895–913)

```
fn fs_write_file_params_round_trip_with_base64_data()
```

**Purpose**: Checks the JSON shape for writing binary file data. Base64 text is used so bytes fit safely inside JSON.

**Data flow**: It builds write-file params with an absolute path and base64 data, serializes, compares JSON, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It uses absolute_path for the destination path.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, to_value).


##### `fs_copy_params_round_trip_with_recursive_directory_copy`  (lines 916–936)

```
fn fs_copy_params_round_trip_with_recursive_directory_copy()
```

**Purpose**: Checks the JSON shape for copying a path recursively. This protects directory-copy requests.

**Data flow**: It builds copy params with source, destination, and recursive true, serializes them, compares JSON, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It uses absolute_path for both source and destination paths.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, to_value).


##### `thread_shell_command_params_round_trip`  (lines 939–957)

```
fn thread_shell_command_params_round_trip()
```

**Purpose**: Checks the JSON shape for sending a shell command to a thread. This protects a small request used to run command text in a thread context.

**Data flow**: It builds params with a thread id and command string, serializes them, compares JSON, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It validates ThreadShellCommandParams.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `thread_shell_command_response_round_trip`  (lines 960–969)

```
fn thread_shell_command_response_round_trip()
```

**Purpose**: Checks that the shell-command response is an empty JSON object. This confirms the response carries no extra data.

**Data flow**: It builds the empty response, serializes it to {}, deserializes it, and checks equality.

**Call relations**: The test runner calls this test. It validates ThreadShellCommandResponse.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `fs_changed_notification_round_trips`  (lines 972–996)

```
fn fs_changed_notification_round_trips()
```

**Purpose**: Checks the notification sent when watched filesystem paths change. This protects file-watch updates for clients.

**Data flow**: It builds a notification with a watch id and changed paths, serializes it to JSON, compares the path strings, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It uses absolute path helper output in the expected JSON.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `command_exec_params_default_optional_streaming_flags`  (lines 999–1026)

```
fn command_exec_params_default_optional_streaming_flags()
```

**Purpose**: Checks default values for command execution streaming flags. This ensures old or simple requests do not accidentally enable streaming or TTY behavior.

**Data flow**: It deserializes command JSON with only command, timeout, and cwd, then compares the parsed params with expected false flags and empty optional fields.

**Call relations**: The test runner calls this test. It validates CommandExecParams defaults.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `command_exec_params_round_trips_disable_timeout`  (lines 1029–1067)

```
fn command_exec_params_round_trips_disable_timeout()
```

**Purpose**: Checks that command execution can explicitly disable timeouts. This is important for long-running commands.

**Data flow**: It builds params with disable_timeout true, serializes them, checks JSON, deserializes, and compares with the original.

**Call relations**: The test runner calls this test. It exercises CommandExecParams serialization around timeout fields.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `process_spawn_params_round_trips_without_sandbox_policy`  (lines 1070–1099)

```
fn process_spawn_params_round_trips_without_sandbox_policy()
```

**Purpose**: Checks the newer process-spawn request shape when no sandbox policy field exists. This protects process startup messages.

**Data flow**: It builds process-spawn params with a command, handle, cwd, and defaults, serializes them, compares JSON, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It uses test_absolute_path for the current working directory.

*Call graph*: calls 1 internal fn (test_absolute_path); 3 external calls (assert_eq!, to_value, vec!).


##### `process_spawn_params_distinguish_omitted_null_and_value_limits`  (lines 1102–1158)

```
fn process_spawn_params_distinguish_omitted_null_and_value_limits()
```

**Purpose**: Checks that process-spawn output and timeout limits distinguish omitted fields, explicit null, and numeric values. This matters because those three cases mean default, disabled, and set limit.

**Data flow**: It deserializes three JSON shapes: no limits, null limits, and numeric limits. It compares each result with the expected nested option values.

**Call relations**: The test runner calls this test. It uses test_absolute_path and focuses on ProcessSpawnParams limit semantics.

*Call graph*: calls 1 internal fn (test_absolute_path); 3 external calls (assert_eq!, json!, vec!).


##### `command_exec_params_round_trips_disable_output_cap`  (lines 1161–1200)

```
fn command_exec_params_round_trips_disable_output_cap()
```

**Purpose**: Checks that command execution can explicitly disable output size limits. This supports commands that may produce lots of output.

**Data flow**: It builds params with streaming output and disable_output_cap true, serializes them, checks JSON, deserializes, and compares.

**Call relations**: The test runner calls this test. It validates CommandExecParams output-cap fields.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `command_exec_params_round_trips_env_overrides_and_unsets`  (lines 1203–1248)

```
fn command_exec_params_round_trips_env_overrides_and_unsets()
```

**Purpose**: Checks command environment overrides, additions, and removals. A null environment value means unset this variable.

**Data flow**: It builds params with env entries containing strings and nulls, serializes to JSON, compares the map, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It validates the environment map inside CommandExecParams.

*Call graph*: 4 external calls (from, assert_eq!, to_value, vec!).


##### `command_exec_write_round_trips_close_only_payload`  (lines 1251–1271)

```
fn command_exec_write_round_trips_close_only_payload()
```

**Purpose**: Checks the request for closing a command's standard input without sending more bytes. This supports interactive process control.

**Data flow**: It builds write params with no data and close_stdin true, serializes them, compares JSON, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It validates CommandExecWriteParams.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `command_exec_terminate_round_trips`  (lines 1274–1290)

```
fn command_exec_terminate_round_trips()
```

**Purpose**: Checks the request used to terminate a running command. This protects the process id field name.

**Data flow**: It builds terminate params, serializes them to JSON, compares the processId field, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It validates CommandExecTerminateParams.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `command_exec_params_round_trip_with_size`  (lines 1293–1337)

```
fn command_exec_params_round_trip_with_size()
```

**Purpose**: Checks command execution with a terminal size. This matters for TTY commands whose layout depends on rows and columns.

**Data flow**: It builds params with tty true and a size, serializes them, checks nested rows and cols JSON, deserializes, and compares.

**Call relations**: The test runner calls this test. It validates terminal-size support in CommandExecParams.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `command_exec_resize_round_trips`  (lines 1340–1364)

```
fn command_exec_resize_round_trips()
```

**Purpose**: Checks the request for resizing a running command terminal. This keeps interactive terminal resizing messages stable.

**Data flow**: It builds resize params with a process id and terminal size, serializes them, compares JSON, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It validates CommandExecResizeParams.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `command_exec_output_delta_round_trips`  (lines 1367–1390)

```
fn command_exec_output_delta_round_trips()
```

**Purpose**: Checks streamed command output notifications. A delta is a small chunk of output, encoded as base64 so bytes stay safe in JSON.

**Data flow**: It builds an output-delta notification, serializes it, compares process id, stream, delta, and cap flag, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It validates CommandExecOutputDeltaNotification.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `process_control_params_round_trip`  (lines 1393–1447)

```
fn process_control_params_round_trip()
```

**Purpose**: Checks the newer process-control request shapes for writing stdin, resizing a pseudo-terminal, and killing a process. This protects interactive process control.

**Data flow**: It builds each control request, serializes it to JSON, compares the expected fields, deserializes it, and checks equality.

**Call relations**: The test runner calls this test. It covers ProcessWriteStdinParams, ProcessResizePtyParams, and ProcessKillParams together.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `process_notifications_round_trip`  (lines 1450–1494)

```
fn process_notifications_round_trip()
```

**Purpose**: Checks process output and exit notifications. This protects the messages clients receive while a spawned process runs and finishes.

**Data flow**: It builds an output-delta notification and an exited notification, serializes each, compares JSON fields, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It validates ProcessOutputDeltaNotification and ProcessExitedNotification.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `command_execution_output_delta_round_trips`  (lines 1497–1520)

```
fn command_execution_output_delta_round_trips()
```

**Purpose**: Checks streamed output attached to a command-execution item inside a conversation turn. This keeps UI updates for command output stable.

**Data flow**: It builds a notification with thread, turn, item, and text delta, serializes it, compares JSON, deserializes, and checks equality.

**Call relations**: The test runner calls this test. It validates item-level command execution output notifications.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `sandbox_policy_round_trips_external_sandbox_network_access`  (lines 1523–1538)

```
fn sandbox_policy_round_trips_external_sandbox_network_access()
```

**Purpose**: Checks that external sandbox policies preserve network-access settings when converted to and from the core protocol. This protects sandbox configuration.

**Data flow**: It builds a v2 external sandbox policy, converts it to the core policy, checks the result, converts back to v2, and checks equality.

**Call relations**: The test runner calls this test. It exercises SandboxPolicy conversion methods.

*Call graph*: calls 1 internal fn (from); 1 external calls (assert_eq!).


##### `sandbox_policy_round_trips_read_only_network_access`  (lines 1541–1556)

```
fn sandbox_policy_round_trips_read_only_network_access()
```

**Purpose**: Checks that read-only sandbox policies preserve their network-access flag through core conversion. This keeps sandbox behavior predictable.

**Data flow**: It builds a v2 read-only policy, converts it to core, compares, converts back, and compares again.

**Call relations**: The test runner calls this test. It validates one SandboxPolicy variant's conversion path.

*Call graph*: calls 1 internal fn (from); 1 external calls (assert_eq!).


##### `ask_for_approval_granular_round_trips_request_permissions_flag`  (lines 1559–1582)

```
fn ask_for_approval_granular_round_trips_request_permissions_flag()
```

**Purpose**: Checks that granular approval policy preserves the request-permissions flag through core conversion. This protects fine-grained approval settings.

**Data flow**: It builds a granular v2 policy, converts it to core config, compares all booleans, converts back, and checks equality.

**Call relations**: The test runner calls this test. It exercises AskForApproval conversion between v2 and core types.

*Call graph*: calls 1 internal fn (from); 1 external calls (assert_eq!).


##### `ask_for_approval_granular_defaults_missing_optional_flags_to_false`  (lines 1585–1605)

```
fn ask_for_approval_granular_defaults_missing_optional_flags_to_false()
```

**Purpose**: Checks that missing granular approval flags default to false. This gives old or partial JSON a safe, predictable meaning.

**Data flow**: It deserializes granular approval JSON missing some flags and compares the result with all missing flags set to false.

**Call relations**: The test runner calls this test. It validates AskForApproval deserialization defaults.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `ask_for_approval_granular_is_marked_experimental`  (lines 1608–1623)

```
fn ask_for_approval_granular_is_marked_experimental()
```

**Purpose**: Checks that granular approval is reported as experimental, while ordinary approval is not. This helps clients warn users about unstable features.

**Data flow**: It asks the experimental API helper for a reason on granular approval and on on-request approval, then compares the reasons.

**Call relations**: The test runner calls this test. It exercises the ExperimentalApi trait for AskForApproval.

*Call graph*: 2 external calls (experimental_reason, assert_eq!).


##### `config_granular_approval_policy_is_marked_experimental`  (lines 1626–1662)

```
fn config_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Checks that a config containing granular approval is marked experimental. This prevents experimental settings from being silently accepted.

**Data flow**: It builds a Config with a granular approval policy and asks for its experimental reason, expecting askForApproval.granular.

**Call relations**: The test runner calls this test. It validates experimental detection on Config.

*Call graph*: 3 external calls (new, experimental_reason, assert_eq!).


##### `config_approvals_reviewer_is_marked_experimental`  (lines 1665–1695)

```
fn config_approvals_reviewer_is_marked_experimental()
```

**Purpose**: Checks that setting the approvals reviewer to automatic review in config is marked experimental. This protects a newer review feature.

**Data flow**: It builds a Config with approvals_reviewer set to AutoReview and checks the experimental reason string.

**Call relations**: The test runner calls this test. It exercises experimental detection for Config reviewer settings.

*Call graph*: 3 external calls (new, experimental_reason, assert_eq!).


##### `config_requirements_granular_allowed_approval_policy_is_marked_experimental`  (lines 1698–1725)

```
fn config_requirements_granular_allowed_approval_policy_is_marked_experimental()
```

**Purpose**: Checks that allowing granular approval in config requirements is also marked experimental. This catches experimental use even in policy allow-lists.

**Data flow**: It builds ConfigRequirements with a granular approval policy in allowed_approval_policies and checks the experimental reason.

**Call relations**: The test runner calls this test. It validates experimental detection on ConfigRequirements.

*Call graph*: 3 external calls (experimental_reason, assert_eq!, vec!).


##### `client_request_thread_start_granular_approval_policy_is_marked_experimental`  (lines 1728–1746)

```
fn client_request_thread_start_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Checks that a thread-start client request using granular approval is marked experimental. This catches experimental use at the request boundary.

**Data flow**: It builds a ClientRequest::ThreadStart with granular approval params and checks the experimental reason.

**Call relations**: The test runner calls this test. It exercises experimental detection for a thread start request.

*Call graph*: 4 external calls (default, experimental_reason, Integer, assert_eq!).


##### `client_request_thread_resume_granular_approval_policy_is_marked_experimental`  (lines 1749–1768)

```
fn client_request_thread_resume_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Checks that a thread-resume request using granular approval is marked experimental. This keeps resume-time settings under the same gate.

**Data flow**: It builds a ClientRequest::ThreadResume with granular approval params and checks the experimental reason.

**Call relations**: The test runner calls this test. It validates experimental detection for thread resume requests.

*Call graph*: 4 external calls (default, experimental_reason, Integer, assert_eq!).


##### `client_request_thread_fork_granular_approval_policy_is_marked_experimental`  (lines 1771–1790)

```
fn client_request_thread_fork_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Checks that a thread-fork request using granular approval is marked experimental. This protects fork-time approval configuration.

**Data flow**: It builds a ClientRequest::ThreadFork with granular approval params and checks the experimental reason.

**Call relations**: The test runner calls this test. It validates experimental detection for thread fork requests.

*Call graph*: 4 external calls (default, experimental_reason, Integer, assert_eq!).


##### `client_request_turn_start_granular_approval_policy_is_marked_experimental`  (lines 1793–1814)

```
fn client_request_turn_start_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Checks that a turn-start request using granular approval is marked experimental. This catches per-turn experimental approval settings.

**Data flow**: It builds a ClientRequest::TurnStart with granular approval params and checks the experimental reason.

**Call relations**: The test runner calls this test. It validates experimental detection for turn start requests.

*Call graph*: 5 external calls (default, new, experimental_reason, Integer, assert_eq!).


##### `mcp_server_elicitation_response_round_trips_rmcp_result`  (lines 1817–1841)

```
fn mcp_server_elicitation_response_round_trips_rmcp_result()
```

**Purpose**: Checks conversion between the app protocol's MCP elicitation response and the RMCP library result type. Elicitation means a tool asks the user for extra input.

**Data flow**: It builds an RMCP result, converts it to the v2 response, compares fields, converts back to RMCP, and checks equality.

**Call relations**: The test runner calls this test. It exercises bidirectional conversion for MCP elicitation responses.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert_eq!, json!).


##### `mcp_server_elicitation_request_from_core_url_request`  (lines 1844–1862)

```
fn mcp_server_elicitation_request_from_core_url_request()
```

**Purpose**: Checks conversion of a core MCP URL elicitation request into the app protocol. This supports requests like asking a user to finish sign-in in a browser.

**Data flow**: It builds a core URL request, tries to convert it to v2, and compares the resulting URL request fields.

**Call relations**: The test runner calls this test. It validates TryFrom conversion for one core elicitation request variant.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (assert_eq!).


##### `mcp_server_elicitation_request_from_core_form_request`  (lines 1865–1900)

```
fn mcp_server_elicitation_request_from_core_form_request()
```

**Purpose**: Checks conversion of a core MCP form elicitation request into the app protocol. This supports user prompts that need structured answers.

**Data flow**: It builds a core form request with a JSON schema, converts it to v2, separately parses the expected schema, and compares the full request.

**Call relations**: The test runner calls this test. It validates TryFrom conversion and schema parsing for form elicitations.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (assert_eq!, json!, from_value).


##### `mcp_elicitation_schema_matches_mcp_2025_11_25_primitives`  (lines 1903–1997)

```
fn mcp_elicitation_schema_matches_mcp_2025_11_25_primitives()
```

**Purpose**: Checks that the MCP elicitation schema type accepts the primitive fields expected by the MCP specification version named in the test. This protects structured user-input forms.

**Data flow**: It deserializes a JSON schema with string, integer, boolean, and enum properties, then compares the detailed typed schema result.

**Call relations**: The test runner calls this test. It exercises McpElicitationSchema and its primitive property variants.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `mcp_server_elicitation_request_rejects_null_core_form_schema`  (lines 2000–2010)

```
fn mcp_server_elicitation_request_rejects_null_core_form_schema()
```

**Purpose**: Checks that a form elicitation with a null schema is rejected. A form request needs a real schema so the client knows what to ask.

**Data flow**: It builds a core form request whose requested_schema is null, tries to convert it to v2, and expects an error.

**Call relations**: The test runner calls this test. It validates error behavior in McpServerElicitationRequest conversion.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert!, json!).


##### `mcp_server_elicitation_request_rejects_invalid_core_form_schema`  (lines 2013–2028)

```
fn mcp_server_elicitation_request_rejects_invalid_core_form_schema()
```

**Purpose**: Checks that invalid form schemas are rejected. This prevents clients from receiving forms they cannot render safely.

**Data flow**: It builds a core form request whose property uses an unsupported object type, converts it, and expects an error.

**Call relations**: The test runner calls this test. It exercises schema validation during MCP request conversion.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert!, json!).


##### `mcp_server_elicitation_response_serializes_nullable_content`  (lines 2031–2046)

```
fn mcp_server_elicitation_response_serializes_nullable_content()
```

**Purpose**: Checks that an MCP elicitation response serializes absent content as explicit null. This keeps the JSON shape predictable for decline or cancel actions.

**Data flow**: It builds a decline response with no content or metadata, serializes it, and compares the JSON including null fields.

**Call relations**: The test runner calls this test. It validates McpServerElicitationRequestResponse serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_server_status_serializes_absent_server_info_as_null`  (lines 2049–2076)

```
fn mcp_server_status_serializes_absent_server_info_as_null()
```

**Purpose**: Checks that MCP server status includes serverInfo as null when a server is not ready. This helps clients distinguish absent information from missing fields.

**Data flow**: It builds a status response with one server whose server_info is None, serializes it, and compares the JSON.

**Call relations**: The test runner calls this test. It validates ListMcpServerStatusResponse serialization.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `mcp_server_status_updated_accepts_missing_thread_id`  (lines 2079–2103)

```
fn mcp_server_status_updated_accepts_missing_thread_id()
```

**Purpose**: Checks that MCP server status update notifications can omit threadId. This supports global or legacy status updates.

**Data flow**: It deserializes a notification without threadId, compares the parsed value with thread_id None, then serializes it and checks threadId becomes null.

**Call relations**: The test runner calls this test. It validates McpServerStatusUpdatedNotification compatibility.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `mcp_server_status_serializes_absent_server_info_metadata_as_null`  (lines 2106–2147)

```
fn mcp_server_status_serializes_absent_server_info_metadata_as_null()
```

**Purpose**: Checks that optional metadata inside MCP serverInfo serializes as null when absent. This gives clients a stable object shape.

**Data flow**: It builds a status response with server info that has only name and version, serializes it, and checks all optional metadata fields are null.

**Call relations**: The test runner calls this test. It validates nested McpServerInfo serialization in server status responses.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `sandbox_policy_round_trips_workspace_write_access`  (lines 2150–2171)

```
fn sandbox_policy_round_trips_workspace_write_access()
```

**Purpose**: Checks that workspace-write sandbox policies preserve all flags through core conversion. This protects the policy that allows writes only in selected workspace areas.

**Data flow**: It builds a v2 workspace-write policy, converts it to core, compares, converts back, and checks equality.

**Call relations**: The test runner calls this test. It exercises SandboxPolicy conversion for workspace-write mode.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert_eq!, vec!).


##### `sandbox_policy_deserializes_legacy_read_only_full_access_field`  (lines 2174–2189)

```
fn sandbox_policy_deserializes_legacy_read_only_full_access_field()
```

**Purpose**: Checks that an old read-only sandbox field saying fullAccess is ignored. This keeps old JSON compatible when the field no longer matters.

**Data flow**: It deserializes readOnly policy JSON with a legacy access fullAccess object and checks the resulting policy only uses network_access.

**Call relations**: The test runner calls this test. It validates legacy-tolerant SandboxPolicy deserialization.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `sandbox_policy_deserializes_legacy_workspace_write_full_access_field`  (lines 2192–2214)

```
fn sandbox_policy_deserializes_legacy_workspace_write_full_access_field()
```

**Purpose**: Checks that an old workspace-write readOnlyAccess fullAccess field is ignored. This keeps older clients compatible with the newer sandbox shape.

**Data flow**: It deserializes workspaceWrite JSON with writable roots and a legacy fullAccess field, then compares the resulting policy.

**Call relations**: The test runner calls this test. It uses absolute_path for the writable root and validates SandboxPolicy compatibility.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, json!).


##### `sandbox_policy_rejects_legacy_read_only_restricted_access_field`  (lines 2217–2228)

```
fn sandbox_policy_rejects_legacy_read_only_restricted_access_field()
```

**Purpose**: Checks that a removed restricted access field is rejected for read-only sandbox policy. This prevents unsafe or unsupported old semantics from being accepted.

**Data flow**: It tries to deserialize readOnly JSON with a restricted access object and expects an error mentioning readOnly.access.

**Call relations**: The test runner calls this test. It validates strict rejection in SandboxPolicy deserialization.

*Call graph*: 2 external calls (assert!, json!).


##### `sandbox_policy_rejects_legacy_workspace_write_restricted_read_access_field`  (lines 2231–2246)

```
fn sandbox_policy_rejects_legacy_workspace_write_restricted_read_access_field()
```

**Purpose**: Checks that a removed restricted read access field is rejected for workspace-write sandbox policy. This prevents ambiguous old rules from slipping through.

**Data flow**: It tries to deserialize workspaceWrite JSON with restricted readOnlyAccess and expects an error mentioning workspaceWrite.readOnlyAccess.

**Call relations**: The test runner calls this test. It validates SandboxPolicy rejection of unsupported legacy shapes.

*Call graph*: 2 external calls (assert!, json!).


##### `automatic_approval_review_deserializes_aborted_status`  (lines 2249–2266)

```
fn automatic_approval_review_deserializes_aborted_status()
```

**Purpose**: Checks that automatic approval review can report an aborted status. This supports review runs that stop before producing a decision.

**Data flow**: It deserializes review JSON with status aborted and null optional fields, then compares the resulting GuardianApprovalReview.

**Call relations**: The test runner calls this test. It validates GuardianApprovalReview deserialization.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `guardian_approval_review_action_round_trips_command_shape`  (lines 2269–2291)

```
fn guardian_approval_review_action_round_trips_command_shape()
```

**Purpose**: Checks the JSON shape for a guardian review action describing a shell command. This lets automatic review reason about exactly what command would run.

**Data flow**: It deserializes a command action JSON, compares the typed value, serializes it again, and checks it matches the original JSON.

**Call relations**: The test runner calls this test. It validates GuardianApprovalReviewAction command serialization and deserialization.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `network_requirements_deserializes_legacy_fields`  (lines 2294–2320)

```
fn network_requirements_deserializes_legacy_fields()
```

**Purpose**: Checks that older network requirement fields still deserialize. This keeps policy data using allowedDomains, deniedDomains, and allowUnixSockets usable.

**Data flow**: It deserializes legacy network requirement JSON and compares it with a NetworkRequirements value where only legacy fields are set.

**Call relations**: The test runner calls this test. It validates backward compatibility for NetworkRequirements.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `network_requirements_serializes_canonical_and_legacy_fields`  (lines 2323–2379)

```
fn network_requirements_serializes_canonical_and_legacy_fields()
```

**Purpose**: Checks that network requirements serialize both newer canonical fields and older compatibility fields. This helps old and new clients read the same policy.

**Data flow**: It builds a NetworkRequirements value with ports, domain maps, unix socket maps, and legacy arrays, then serializes and compares all JSON fields.

**Call relations**: The test runner calls this test. It validates complete NetworkRequirements serialization.

*Call graph*: 3 external calls (from, assert_eq!, vec!).


##### `core_turn_item_into_thread_item_converts_supported_variants`  (lines 2382–2643)

```
fn core_turn_item_into_thread_item_converts_supported_variants()
```

**Purpose**: Checks conversion from core conversation turn items into app protocol thread items. This is central to showing conversation history correctly in clients.

**Data flow**: It builds core user, agent, reasoning, web search, image view, file change, and MCP tool-call items, converts each to ThreadItem, and compares the expected v2 item.

**Call relations**: The test runner calls this test. It exercises many From conversions that bridge stored/core turn data into API-visible thread items.

*Call graph*: 14 external calls (from_millis, from, new, assert_eq!, AgentMessage, FileChange, ImageView, McpToolCall, Reasoning, UserMessage (+4 more)).


##### `user_input_into_core_preserves_image_detail`  (lines 2646–2670)

```
fn user_input_into_core_preserves_image_detail()
```

**Purpose**: Checks that image detail settings survive conversion from v2 user input into core user input. This keeps image quality/detail choices intact.

**Data flow**: It converts remote-image and local-image v2 inputs with ImageDetail::Original into core inputs and compares the results.

**Call relations**: The test runner calls this test. It validates UserInput::into_core for image variants.

*Call graph*: 1 external calls (assert_eq!).


##### `skills_list_params_serialization_uses_force_reload`  (lines 2673–2694)

```
fn skills_list_params_serialization_uses_force_reload()
```

**Purpose**: Checks the JSON shape for listing skills, including when forceReload is used. This protects clients that refresh skill discovery.

**Data flow**: It serializes empty/default params and params with a cwd plus force_reload true, comparing each JSON output.

**Call relations**: The test runner calls this test. It validates SkillsListParams serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `skills_extra_roots_set_params_serialization_uses_extra_roots`  (lines 2697–2707)

```
fn skills_extra_roots_set_params_serialization_uses_extra_roots()
```

**Purpose**: Checks that setting extra skill roots uses the extraRoots JSON field. This protects the API for adding skill search locations.

**Data flow**: It builds params with one absolute extra root, serializes them, and compares the JSON path array.

**Call relations**: The test runner calls this test. It uses the absolute path helper output in the expected JSON.

*Call graph*: 1 external calls (assert_eq!).


##### `skills_extra_roots_set_params_rejects_relative_roots`  (lines 2710–2715)

```
fn skills_extra_roots_set_params_rejects_relative_roots()
```

**Purpose**: Checks that extra skill roots must be absolute paths. This avoids ambiguous or unsafe relative search roots.

**Data flow**: It tries to deserialize params with a relative extraRoots entry and expects an error.

**Call relations**: The test runner calls this test. It validates path checking in SkillsExtraRootsSetParams.

*Call graph*: 2 external calls (assert!, json!).


##### `plugin_source_serializes_local_git_and_remote_variants`  (lines 2718–2758)

```
fn plugin_source_serializes_local_git_and_remote_variants()
```

**Purpose**: Checks the JSON shapes for plugin sources: local path, git repository, and remote-only. This protects plugin listing and install metadata.

**Data flow**: It creates each PluginSource variant, serializes it, and compares the expected type tag and fields.

**Call relations**: The test runner calls this test. It uses platform-aware absolute paths for the local source.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `marketplace_add_params_serialization_uses_optional_ref_name_and_sparse_paths`  (lines 2761–2789)

```
fn marketplace_add_params_serialization_uses_optional_ref_name_and_sparse_paths()
```

**Purpose**: Checks marketplace-add request JSON for optional git ref and sparse path settings. Sparse paths mean only selected subdirectories are used.

**Data flow**: It serializes params without optional values and with both optional values, comparing the JSON each time.

**Call relations**: The test runner calls this test. It validates MarketplaceAddParams serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `marketplace_upgrade_params_serialization_uses_optional_marketplace_name`  (lines 2792–2819)

```
fn marketplace_upgrade_params_serialization_uses_optional_marketplace_name()
```

**Purpose**: Checks marketplace-upgrade request JSON when a marketplace name is omitted or provided. This protects both upgrade-all and upgrade-one requests.

**Data flow**: It serializes params with None and Some marketplace_name, and also checks that an empty JSON object deserializes to None.

**Call relations**: The test runner calls this test. It validates MarketplaceUpgradeParams serialization and defaults.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_marketplace_entry_serializes_remote_only_path_as_null`  (lines 2822–2838)

```
fn plugin_marketplace_entry_serializes_remote_only_path_as_null()
```

**Purpose**: Checks that a remote-only plugin marketplace entry serializes its path as null. This distinguishes remote marketplaces from local files.

**Data flow**: It builds a PluginMarketplaceEntry with no path, serializes it, and compares the JSON including null path and interface.

**Call relations**: The test runner calls this test. It validates PluginMarketplaceEntry serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_interface_serializes_local_paths_and_remote_urls_separately`  (lines 2841–2892)

```
fn plugin_interface_serializes_local_paths_and_remote_urls_separately()
```

**Purpose**: Checks that plugin interface metadata keeps local image paths and remote image URLs in separate fields. This prevents confusing file paths with web URLs.

**Data flow**: It builds PluginInterface metadata with local composer icon and remote URLs, serializes it, and compares all camelCase fields.

**Call relations**: The test runner calls this test. It uses platform-aware absolute paths and validates PluginInterface serialization.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (from, new, assert_eq!, cfg!, vec!).


##### `plugin_list_params_ignore_removed_force_remote_sync_field`  (lines 2895–2907)

```
fn plugin_list_params_ignore_removed_force_remote_sync_field()
```

**Purpose**: Checks that a removed forceRemoteSync field is ignored when listing plugins. This keeps old clients from failing after the field was removed.

**Data flow**: It deserializes plugin-list JSON containing forceRemoteSync and checks that only the supported fields remain at default values.

**Call relations**: The test runner calls this test. It validates backward-compatible PluginListParams deserialization.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_list_params_serializes_marketplace_kind_filter`  (lines 2910–2934)

```
fn plugin_list_params_serializes_marketplace_kind_filter()
```

**Purpose**: Checks that plugin listing can filter by marketplace kind. This lets clients request local, vertical, workspace, shared, or created-by-me remote marketplaces.

**Data flow**: It serializes PluginListParams with several marketplace kinds and compares the expected string labels.

**Call relations**: The test runner calls this test. It validates PluginListParams serialization for marketplaceKinds.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_installed_params_serializes_install_suggestion_names`  (lines 2937–2955)

```
fn plugin_installed_params_serializes_install_suggestion_names()
```

**Purpose**: Checks that installed-plugin requests can include plugin names used for install suggestions. This supports recommendation-related filtering.

**Data flow**: It serializes params with two suggestion plugin names and compares the JSON array.

**Call relations**: The test runner calls this test. It validates PluginInstalledParams serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_read_params_serialization_uses_install_source_fields`  (lines 2958–3006)

```
fn plugin_read_params_serialization_uses_install_source_fields()
```

**Purpose**: Checks plugin-read parameters for both local marketplace paths and remote marketplace names. This protects how clients choose where to read a plugin from.

**Data flow**: It serializes local-source params, deserializes legacy JSON with forceRemoteSync ignored, and deserializes remote-source params, comparing all results.

**Call relations**: The test runner calls this test. It validates PluginReadParams serialization and compatibility.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `plugin_install_params_serialization_omits_force_remote_sync`  (lines 3009–3058)

```
fn plugin_install_params_serialization_omits_force_remote_sync()
```

**Purpose**: Checks plugin-install parameters and confirms the removed forceRemoteSync field is ignored. This keeps old install requests working.

**Data flow**: It serializes local install params, deserializes local JSON with forceRemoteSync ignored, and deserializes remote install JSON with that field ignored.

**Call relations**: The test runner calls this test. It validates PluginInstallParams serialization and backward compatibility.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `plugin_skill_read_params_serialization_uses_remote_plugin_id`  (lines 3061–3075)

```
fn plugin_skill_read_params_serialization_uses_remote_plugin_id()
```

**Purpose**: Checks the JSON shape for reading a skill from a remote plugin. This protects the fields used to locate remote plugin skills.

**Data flow**: It serializes params with remote marketplace name, remote plugin id, and skill name, then compares the JSON.

**Call relations**: The test runner calls this test. It validates PluginSkillReadParams serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_share_params_and_response_serialization_use_camel_case_fields`  (lines 3078–3257)

```
fn plugin_share_params_and_response_serialization_use_camel_case_fields()
```

**Purpose**: Checks many plugin-sharing request and response shapes. This protects remote sharing, target permissions, checkout, listing, and deletion field names.

**Data flow**: It serializes save, save response, update targets, update response, checkout params, checkout response, delete params, and deserializes list params, comparing each JSON shape.

**Call relations**: The test runner calls this test. It validates the plugin sharing API as a group, using platform-aware absolute paths where needed.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `plugin_share_list_response_serializes_share_items`  (lines 3260–3306)

```
fn plugin_share_list_response_serializes_share_items()
```

**Purpose**: Checks the JSON shape for a response listing shared plugins. This protects how remote plugin summaries and local checkout paths are presented.

**Data flow**: It builds a share-list response with one remote plugin summary and no local path, serializes it, and compares the nested JSON.

**Call relations**: The test runner calls this test. It validates PluginShareListResponse and PluginSummary serialization together.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_summary_defaults_missing_availability_to_available`  (lines 3309–3325)

```
fn plugin_summary_defaults_missing_availability_to_available()
```

**Purpose**: Checks that old plugin summaries without availability default to available. This keeps older server or cache data usable.

**Data flow**: It deserializes a plugin summary JSON missing availability, localVersion, and shareContext, then checks their default parsed values.

**Call relations**: The test runner calls this test. It validates PluginSummary deserialization defaults.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `plugin_availability_deserializes_enabled_alias`  (lines 3328–3336)

```
fn plugin_availability_deserializes_enabled_alias()
```

**Purpose**: Checks that the old availability label ENABLED is accepted as AVAILABLE. This preserves compatibility with older plugin data.

**Data flow**: It deserializes the string ENABLED into PluginAvailability, checks it becomes Available, then serializes it back as AVAILABLE.

**Call relations**: The test runner calls this test. It validates alias handling in PluginAvailability.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `plugin_uninstall_params_serialization_omits_force_remote_sync`  (lines 3339–3381)

```
fn plugin_uninstall_params_serialization_omits_force_remote_sync()
```

**Purpose**: Checks plugin-uninstall parameters and confirms the removed forceRemoteSync field is ignored. This protects old uninstall requests.

**Data flow**: It serializes uninstall params for local-style and remote-style plugin ids, and deserializes JSON that includes forceRemoteSync, expecting the same params.

**Call relations**: The test runner calls this test. It validates PluginUninstallParams serialization and backward compatibility.

*Call graph*: 1 external calls (assert_eq!).


##### `marketplace_remove_response_serializes_nullable_installed_root`  (lines 3384–3415)

```
fn marketplace_remove_response_serializes_nullable_installed_root()
```

**Purpose**: Checks that marketplace-remove responses include installedRoot as either a path or null. This tells clients whether a local installed root existed.

**Data flow**: It serializes a response with an installed root and one without, comparing the JSON in both cases.

**Call relations**: The test runner calls this test. It validates MarketplaceRemoveResponse serialization with platform-aware absolute paths.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `marketplace_upgrade_response_serializes_camel_case_fields`  (lines 3418–3446)

```
fn marketplace_upgrade_response_serializes_camel_case_fields()
```

**Purpose**: Checks the JSON shape for marketplace-upgrade responses. This protects selected marketplace names, upgraded roots, and error details.

**Data flow**: It builds an upgrade response with one selected marketplace, one upgraded root, and one error, serializes it, and compares camelCase JSON fields.

**Call relations**: The test runner calls this test. It validates MarketplaceUpgradeResponse serialization.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `codex_error_info_serializes_http_status_code_in_camel_case`  (lines 3449–3462)

```
fn codex_error_info_serializes_http_status_code_in_camel_case()
```

**Purpose**: Checks that a too-many-failed-attempts error includes httpStatusCode in camelCase. This protects client error parsing.

**Data flow**: It serializes the error info variant with status code 401 and compares the nested JSON object.

**Call relations**: The test runner calls this test. It validates CodexErrorInfo serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_error_info_serializes_cyber_policy_in_camel_case`  (lines 3465–3470)

```
fn codex_error_info_serializes_cyber_policy_in_camel_case()
```

**Purpose**: Checks the JSON label for the cyber policy error. This keeps the public error string stable.

**Data flow**: It serializes the CyberPolicy error info variant and compares it with the expected cyberPolicy string.

**Call relations**: The test runner calls this test. It validates one CodexErrorInfo unit variant.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_error_info_serializes_active_turn_not_steerable_turn_kind_in_camel_case`  (lines 3473–3486)

```
fn codex_error_info_serializes_active_turn_not_steerable_turn_kind_in_camel_case()
```

**Purpose**: Checks the JSON shape for an active-turn-not-steerable error. This tells clients why a turn cannot be changed.

**Data flow**: It serializes the error with turn_kind Review and compares the nested camelCase JSON.

**Call relations**: The test runner calls this test. It validates CodexErrorInfo serialization with NonSteerableTurnKind.

*Call graph*: 1 external calls (assert_eq!).


##### `dynamic_tool_response_serializes_content_items`  (lines 3489–3510)

```
fn dynamic_tool_response_serializes_content_items()
```

**Purpose**: Checks dynamic tool responses containing text output items. Dynamic tools can return content that later becomes model input.

**Data flow**: It serializes a successful dynamic tool response with one inputText item and compares the JSON.

**Call relations**: The test runner calls this test. It validates DynamicToolCallResponse serialization.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `dynamic_tool_response_serializes_text_and_image_content_items`  (lines 3513–3543)

```
fn dynamic_tool_response_serializes_text_and_image_content_items()
```

**Purpose**: Checks dynamic tool responses containing both text and image items. This protects mixed content returned by tools.

**Data flow**: It serializes a successful response with an inputText item and an inputImage item, then compares the JSON array.

**Call relations**: The test runner calls this test. It validates multiple DynamicToolCallOutputContentItem variants.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `thread_start_params_preserve_explicit_null_service_tier`  (lines 3546–3560)

```
fn thread_start_params_preserve_explicit_null_service_tier()
```

**Purpose**: Checks that thread-start params preserve the difference between omitted serviceTier and explicit null. Explicit null means the client intentionally clears or overrides the value.

**Data flow**: It deserializes JSON with serviceTier null and checks it becomes Some(None), serializes it and sees null, then compares default params where the field is omitted.

**Call relations**: The test runner calls this test. It validates nested option behavior in ThreadStartParams.

*Call graph*: 5 external calls (default, assert_eq!, json!, from_value, to_value).


##### `thread_lifecycle_responses_default_missing_optional_fields`  (lines 3563–3609)

```
fn thread_lifecycle_responses_default_missing_optional_fields()
```

**Purpose**: Checks that thread start, resume, and fork responses default newly optional fields when older JSON omits them. This keeps older responses readable.

**Data flow**: It deserializes the same response JSON into three lifecycle response types and checks default instruction sources, parent thread id, active permission profile, and initial turns page.

**Call relations**: The test runner calls this test. It validates compatibility defaults across thread lifecycle responses.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `turn_start_params_preserve_explicit_null_service_tier`  (lines 3612–3651)

```
fn turn_start_params_preserve_explicit_null_service_tier()
```

**Purpose**: Checks that turn-start params preserve explicit null serviceTier separately from omission. This lets clients intentionally set no service tier for one turn.

**Data flow**: It deserializes params with serviceTier null, checks Some(None), serializes and confirms null, then serializes params with no override and confirms the field is absent.

**Call relations**: The test runner calls this test. It validates nested option behavior in TurnStartParams.

*Call graph*: 5 external calls (assert_eq!, json!, from_value, to_value, vec!).


##### `thread_settings_update_params_preserve_explicit_null_service_tier`  (lines 3654–3676)

```
fn thread_settings_update_params_preserve_explicit_null_service_tier()
```

**Purpose**: Checks that thread settings updates preserve explicit null serviceTier separately from omission. This protects settings update intent.

**Data flow**: It deserializes update params with serviceTier null, checks Some(None), serializes it as null, then checks a default update omits the field.

**Call relations**: The test runner calls this test. It validates ThreadSettingsUpdateParams serialization and deserialization.

*Call graph*: 5 external calls (default, assert_eq!, json!, from_value, to_value).


##### `thread_settings_update_params_preserve_field_level_experimental_gates`  (lines 3679–3722)

```
fn thread_settings_update_params_preserve_field_level_experimental_gates()
```

**Purpose**: Checks that experimental warnings are attached to specific thread settings fields. This prevents experimental settings from being enabled without notice.

**Data flow**: It builds settings updates for permissions, granular approval, and collaboration mode, asking each for an experimental reason and comparing the expected strings.

**Call relations**: The test runner calls this test. It exercises ExperimentalApi behavior for ThreadSettingsUpdateParams.

*Call graph*: 2 external calls (default, assert_eq!).


##### `turn_start_params_round_trip_environments`  (lines 3725–3768)

```
fn turn_start_params_round_trip_environments()
```

**Purpose**: Checks that turn-start params can include per-environment working directories and that this feature is marked experimental. This supports running turns across named environments.

**Data flow**: It deserializes params with one environment, checks the parsed environment list, checks the experimental reason, serializes, and compares the environments JSON.

**Call relations**: The test runner calls this test. It validates TurnStartParams environment handling and experimental gating.

*Call graph*: 4 external calls (assert_eq!, json!, from_value, to_value).


##### `turn_start_params_preserve_empty_environments`  (lines 3771–3787)

```
fn turn_start_params_preserve_empty_environments()
```

**Purpose**: Checks that an explicit empty environments array is preserved and still counts as using the experimental environments feature. This keeps client intent visible.

**Data flow**: It deserializes params with environments as an empty array, checks it becomes Some(empty vector), checks the experimental reason, then serializes it back as an empty array.

**Call relations**: The test runner calls this test. It validates the empty-list case for TurnStartParams environments.

*Call graph*: 4 external calls (assert_eq!, json!, from_value, to_value).


##### `turn_start_params_treat_null_or_omitted_environments_as_default`  (lines 3790–3813)

```
fn turn_start_params_treat_null_or_omitted_environments_as_default()
```

**Purpose**: Checks that null or omitted environments mean the default behavior and do not trigger the experimental gate. This distinguishes no feature use from an explicit environment list.

**Data flow**: It deserializes one payload with environments null and one without the field, checks both become None, and checks neither has an experimental reason.

**Call relations**: The test runner calls this test. It validates default handling for TurnStartParams environments.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `realtime_append_text_defaults_role_to_user`  (lines 3816–3831)

```
fn realtime_append_text_defaults_role_to_user()
```

**Purpose**: Checks that realtime appended text defaults to the user role when no role is provided. This gives simple clients the expected conversation role automatically.

**Data flow**: It deserializes append-text params with thread id and text only, then compares the parsed value with role set to ConversationTextRole::User.

**Call relations**: The test runner calls this test. It validates ThreadRealtimeAppendTextParams deserialization defaults.

*Call graph*: 2 external calls (assert_eq!, json!).


### Schema fixture verification
These tests finalize the stage by checking that generated TypeScript and JSON schema artifacts remain synchronized with the vendored fixtures.

### `app-server-protocol/tests/schema_fixtures.rs`

`test` · `test run`

The app-server protocol has schema files in two forms: TypeScript files and JSON schema files. These are like written contracts that say what messages the app server can send and receive. This file makes sure those written contracts are not stale. It reads the schema fixtures already stored in the repository, generates fresh versions from the current Rust code, and compares the two trees file by file.

There are two main tests. One checks the TypeScript schema fixtures, using an in-memory generator. The other checks the JSON schema fixtures by generating them into a temporary folder first. Both tests then use the same comparison helper.

The comparison is strict. First it checks that the same files exist on both sides. Then it checks that every file has exactly the same bytes. If anything differs, the test prints a readable unified diff, which is the familiar “before versus after” patch-style view. The error message also tells the developer to run `just write-app-server-schema` to refresh the checked-in fixtures.

A small but important detail is how the test finds the schema directory. In Bazel test runs, directories can be hard to locate directly, so the file resolves known schema files first and then walks up to the shared schema root. This makes the test work in more build environments.

#### Function details

##### `typescript_schema_fixtures_match_generated`  (lines 12–21)

```
fn typescript_schema_fixtures_match_generated() -> Result<()>
```

**Purpose**: This is the test that verifies the checked-in TypeScript schema fixture files match the TypeScript schema that the current code would generate. It catches forgotten fixture updates after protocol changes.

**Data flow**: It starts by finding the schema fixture root on disk. It reads the existing `typescript` fixture subtree from that root, asks the protocol crate to generate a fresh TypeScript schema subtree in memory, and then passes both trees to the shared comparison function. If they match, the test returns success; if not, the comparison function stops the test with a clear diff.

**Call relations**: As a top-level test, it drives the TypeScript side of the fixture check. It calls `schema_root` to locate the fixture directory, `read_tree` to load the checked-in files, `generate_typescript_schema_fixture_subtree_for_tests` to produce the fresh expected output, and `assert_schema_trees_match` to do the final strict comparison.

*Call graph*: calls 3 internal fn (assert_schema_trees_match, read_tree, schema_root); 1 external calls (generate_typescript_schema_fixture_subtree_for_tests).


##### `json_schema_fixtures_match_generated`  (lines 24–28)

```
fn json_schema_fixtures_match_generated() -> Result<()>
```

**Purpose**: This is the test that verifies the checked-in JSON schema fixture files match freshly generated JSON schema output. It keeps the repository’s JSON version of the protocol contract in sync with the generator.

**Data flow**: It supplies the label `json` and a small generator callback to the shared fixture-checking helper. That helper then finds the stored fixtures, generates fresh JSON schema files, compares the two, and returns success or fails the test.

**Call relations**: This test is a thin wrapper around `assert_schema_fixtures_match_generated`. It exists because JSON schema generation writes files into a directory, so the shared helper creates a temporary output location and runs the JSON generator there.

*Call graph*: calls 1 internal fn (assert_schema_fixtures_match_generated).


##### `assert_schema_fixtures_match_generated`  (lines 30–51)

```
fn assert_schema_fixtures_match_generated(
    label: &'static str,
    generate: impl FnOnce(&Path) -> Result<()>,
) -> Result<()>
```

**Purpose**: This helper performs the common “read stored fixtures, generate fresh files, compare them” workflow for schema formats that generate into a directory. In this file it is used for the JSON schema test.

**Data flow**: It receives a label, such as `json`, and a generation function. It finds the schema root, reads the existing fixture files for that label, creates a temporary directory, asks the generator to write fresh files there, reads those generated files back, and sends both file trees to the comparison function. It returns success if everything matches, or an error if setup or reading fails; mismatches cause the comparison to panic with a diff.

**Call relations**: `json_schema_fixtures_match_generated` calls this helper instead of repeating the same setup steps. Inside the workflow, it relies on `schema_root` to locate repository fixtures, `read_tree` to load both old and newly generated files, `tempdir` to create a safe throwaway output folder, and `assert_schema_trees_match` to decide whether the generated output is acceptable.

*Call graph*: calls 3 internal fn (assert_schema_trees_match, read_tree, schema_root); called by 1 (json_schema_fixtures_match_generated); 1 external calls (tempdir).


##### `assert_schema_trees_match`  (lines 53–105)

```
fn assert_schema_trees_match(
    label: &str,
    fixture_tree: &BTreeMap<PathBuf, Vec<u8>>,
    generated_tree: &BTreeMap<PathBuf, Vec<u8>>,
) -> Result<()>
```

**Purpose**: This function compares two schema file trees and explains any difference in a developer-friendly way. It is the final gate that decides whether the checked-in fixtures are up to date.

**Data flow**: It receives a label plus two maps: one for the stored fixture files and one for freshly generated files. First it turns each map’s paths into ordered lists and checks whether the same file names exist on both sides. If the file sets differ, it builds a unified diff and fails the test. If the file names match, it compares each file’s contents. Matching files are skipped; differing files are converted to readable text when possible, diffed, and reported in a failure message. If no differences are found, it returns success.

**Call relations**: Both schema tests eventually call this function: the TypeScript test calls it directly, and the JSON test reaches it through `assert_schema_fixtures_match_generated`. It uses `TextDiff::from_lines` to produce useful patch-style output and `panic!` to fail the test immediately when the repository fixtures do not match generated output.

*Call graph*: called by 2 (assert_schema_fixtures_match_generated, typescript_schema_fixtures_match_generated); 3 external calls (from_utf8_lossy, from_lines, panic!).


##### `schema_root`  (lines 107–134)

```
fn schema_root() -> Result<PathBuf>
```

**Purpose**: This function finds the directory that contains the checked-in schema fixtures. It does this in a way that works even in Bazel test environments, where asking for a directory directly may not be reliable.

**Data flow**: It resolves a known TypeScript fixture file, `schema/typescript/index.ts`, then walks up two directory levels to get the common schema root. It also resolves a known JSON fixture file and walks up from there. It checks that both routes lead to the same root directory, then returns that path. If either file cannot be found, or the two roots disagree, it returns an error.

**Call relations**: The TypeScript test and the shared JSON helper both call this before reading fixtures. It uses the `find_resource!` macro to locate known test resources and `ensure!` to guard against accidentally comparing files from inconsistent schema locations.

*Call graph*: called by 2 (assert_schema_fixtures_match_generated, typescript_schema_fixtures_match_generated); 2 external calls (ensure!, find_resource!).


##### `read_tree`  (lines 136–143)

```
fn read_tree(root: &Path, label: &str) -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: This small helper reads one schema fixture subtree, such as `typescript` or `json`, into memory. It wraps the lower-level reader with a clearer error message that says what label and root path were being read.

**Data flow**: It receives a root directory and a label. It asks `read_schema_fixture_subtree` to collect the files under that labeled schema subtree into an ordered map from relative path to file bytes. If reading fails, it adds context showing which subtree and root were involved; otherwise it returns the populated map.

**Call relations**: The TypeScript test uses this to load the checked-in TypeScript fixtures, and the shared JSON helper uses it to load both the checked-in JSON fixtures and the newly generated JSON output. It is the bridge between files on disk and the in-memory maps that `assert_schema_trees_match` can compare.

*Call graph*: called by 2 (assert_schema_fixtures_match_generated, typescript_schema_fixtures_match_generated); 1 external calls (read_schema_fixture_subtree).
