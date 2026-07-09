# Protocol schema and wire-format verification  `stage-23.1.1`

This stage is a safety net for the system’s “language on the wire” — the exact JSON messages different parts of the app send to each other. It is not part of startup or shutdown. Instead, it is behind-the-scenes support that makes sure later changes do not silently break compatibility.

The tests in common_tests.rs check one small but important rule: when the server builds a response, which pieces become the JSON-RPC result and which pieces stay in a higher-level wrapper. Think of it like making sure a package is split correctly between the box and the label.

The files v2/remote_control_tests.rs and v2/tests.rs check the v2 protocol itself. They verify serialization and deserialization, meaning turning in-memory data into JSON and back again. They lock down tricky cases such as missing versus null fields, empty objects, old compatibility behavior, enum value mapping, and feature gates for experimental APIs.

Finally, schema_fixtures.rs compares checked-in schema files with freshly generated ones. That confirms the published TypeScript and JSON schema descriptions still match the real protocol exactly.

## Files in this stage

### Protocol conversion basics
These tests establish the core response-conversion behavior that underpins higher-level protocol wire-format expectations.

### `app-server-protocol/src/protocol/common_tests.rs`

`test` · `test execution`

The file is a small protocol test module that exercises two distinct serialization paths exposed by `ClientResponsePayload::into_jsonrpc_parts_and_payload`. It imports the surrounding protocol module via `super::*`, uses `anyhow::Result` so each test can use `?`, and compares produced JSON with `serde_json::json` plus `pretty_assertions::assert_eq` for readable failures. The first test covers the `ThreadArchive` variant and verifies the dual-output contract: converting the payload with a concrete `RequestId::Integer(7)` must preserve that request id, emit an empty JSON object as the JSON-RPC `result`, and also return an auxiliary payload that can later be turned back into a typed `ClientResponse::ThreadArchive` tied to the same request id. The second test covers `InterruptConversation`, which is intentionally JSON-RPC-only: conversion must still preserve the request id and serialize the abort reason as `{ "abortReason": "interrupted" }`, but the optional payload channel must be `None`. Together these tests document an important protocol distinction: some response variants participate in both JSON-RPC and internal client-response reconstruction, while others are represented only as plain JSON-RPC results with no follow-on typed payload.

#### Function details

##### `client_response_payload_returns_jsonrpc_parts_and_client_response`  (lines 8–25)

```
fn client_response_payload_returns_jsonrpc_parts_and_client_response() -> Result<()>
```

**Purpose**: Verifies that a `ClientResponsePayload::ThreadArchive` conversion produces all three expected pieces: the original request id, the JSON-RPC result body, and an auxiliary payload that reconstructs into a typed `ClientResponse::ThreadArchive`.

**Data flow**: The test constructs `ClientResponsePayload::ThreadArchive(v2::ThreadArchiveResponse {})` and passes `RequestId::Integer(7)` into `into_jsonrpc_parts_and_payload`. It receives a tuple of `(request_id, result, payload)`, asserts that the returned id is still integer 7 and that the JSON result is an empty object, then consumes the optional payload with `and_then(|payload| payload.into_client_response(RequestId::Integer(7)))`. From that reconstructed client response it extracts the embedded `request_id`, asserts it is also integer 7, and returns `Ok(())`; if the payload is absent or of the wrong variant, the test aborts with `panic!`.

**Call relations**: This is a standalone unit test invoked by Rust’s test harness. Its role is to exercise the branch where `into_jsonrpc_parts_and_payload` emits both JSON-RPC data and a follow-up payload, and then to validate the downstream reconstruction path through `into_client_response` under the expected `ThreadArchive` case.

*Call graph*: 4 external calls (ThreadArchive, Integer, assert_eq!, panic!).


##### `interrupt_conversation_payload_stays_jsonrpc_only`  (lines 28–44)

```
fn interrupt_conversation_payload_stays_jsonrpc_only() -> Result<()>
```

**Purpose**: Verifies that `ClientResponsePayload::InterruptConversation` serializes into JSON-RPC output only and does not produce any auxiliary client-response payload.

**Data flow**: The test builds `ClientResponsePayload::InterruptConversation(v1::InterruptConversationResponse { abort_reason: TurnAbortReason::Interrupted })` and converts it with `RequestId::Integer(8)`. It checks that the returned request id remains integer 8, that the JSON result exactly matches an object containing `"abortReason": "interrupted"`, and that the optional payload is `None`. It then returns `Ok(())`.

**Call relations**: This test is also run directly by the test harness. It covers the contrasting conversion path where `into_jsonrpc_parts_and_payload` should stop at JSON-RPC serialization and intentionally omit any typed payload, documenting that interrupt responses are not expected to flow through the client-response reconstruction mechanism.

*Call graph*: 4 external calls (InterruptConversation, Integer, assert!, assert_eq!).


### V2 wire-format regression tests
These tests progressively lock down the v2 protocol’s serialization rules, from focused remote-control cases to the full cross-feature regression suite.

### `app-server-protocol/src/protocol/v2/remote_control_tests.rs`

`test` · `test-time protocol regression checks`

This test file exercises a narrow but important slice of the remote-control protocol contract. It verifies that `RemoteControlClientsListParams` serializes optional pagination and ordering fields as explicit JSON `null` values rather than omitting them, which matters for clients and servers that distinguish absent from null. It also confirms the inverse direction: camelCase JSON fields such as `environmentId` and lowercase enum values like `"asc"` deserialize into the Rust struct and `RemoteControlClientsListOrder::Asc` correctly.

The final test checks that `RemoteControlClientsRevokeResponse`, an empty marker struct, serializes as `{}` rather than `null` or some tagged representation. Together these tests protect the serde annotations in `remote_control.rs`, especially around `rename_all = "camelCase"`, nullable option handling, and zero-field response objects. There is no helper logic here beyond direct `serde_json::to_value`/`from_value` assertions, so each test acts as an executable specification for one wire-format invariant.

#### Function details

##### `remote_control_clients_list_params_serialize_nullable_optional_fields`  (lines 6–22)

```
fn remote_control_clients_list_params_serialize_nullable_optional_fields()
```

**Purpose**: Verifies that `RemoteControlClientsListParams` emits nullable optional fields as explicit `null` entries in JSON. This protects the exact request shape expected by clients and servers.

**Data flow**: Constructs a `RemoteControlClientsListParams` with `environment_id` set and `cursor`, `limit`, and `order` all `None`; serializes it with `serde_json::to_value`; and asserts the result equals a JSON object containing `environmentId` plus `cursor: null`, `limit: null`, and `order: null`.

**Call relations**: Run by the Rust test harness as a unit test. It does not delegate to project helpers beyond serde and assertion macros; its role is to pin the serialization contract for list params.

*Call graph*: 1 external calls (assert_eq!).


##### `remote_control_clients_list_params_deserialize_camel_case_fields`  (lines 25–41)

```
fn remote_control_clients_list_params_deserialize_camel_case_fields()
```

**Purpose**: Checks that camelCase JSON input and lowercase enum strings deserialize into the Rust list-params type correctly. It confirms both field renaming and enum decoding.

**Data flow**: Feeds a JSON object with `environmentId`, `cursor`, `limit`, and `order: "asc"` into `serde_json::from_value::<RemoteControlClientsListParams>` and asserts the decoded struct contains the expected string values, numeric limit, and `RemoteControlClientsListOrder::Asc`.

**Call relations**: Executed by the test harness to validate the inbound wire format. It complements the serialization test by covering the reverse direction of the same schema.

*Call graph*: 1 external calls (assert_eq!).


##### `remote_control_clients_revoke_response_serializes_as_empty_object`  (lines 44–50)

```
fn remote_control_clients_revoke_response_serializes_as_empty_object()
```

**Purpose**: Ensures the empty revoke-response marker struct serializes to `{}`. This prevents accidental schema drift for a response with no payload fields.

**Data flow**: Constructs `RemoteControlClientsRevokeResponse {}`, serializes it with `serde_json::to_value`, and asserts the result is exactly an empty JSON object.

**Call relations**: Run as a unit test for the revoke endpoint’s response schema. It guards against serde behavior changes that might otherwise encode an empty struct unexpectedly.

*Call graph*: 1 external calls (assert_eq!).


### `app-server-protocol/src/protocol/v2/tests.rs`

`test` · `test-time protocol regression and compatibility verification`

This file is the main protocol conformance test suite for the v2 module. It defines three small path helpers at the top, then a large set of unit tests that serialize and deserialize protocol structs, compare conversion results against core types, and verify backward-compatibility behavior. The tests are intentionally concrete: they assert exact JSON field names, null-vs-omitted semantics, enum spellings, alias acceptance, and default values. Examples include `ThreadListCwdFilter` accepting either a single string or an array, `Turn.items_view` defaulting to `Full` for legacy payloads, double-option fields preserving explicit `null` for `serviceTier`, and removed fields like `forceRemoteSync` being ignored on plugin requests.

A major theme is compatibility between API-layer types and core protocol/config types. Tests round-trip `AskForApproval`, sandbox policies, permission profiles, MCP elicitation schemas, thread items, plugin metadata, and remote-control payloads. Another theme is experimental API gating: several tests call `ExperimentalApi::experimental_reason` to ensure nested fields and variants trigger the correct feature gate strings. The suite also checks path handling carefully, including absolute-path enforcement and syntax preservation across platforms. Overall, this file is less about algorithmic logic than about pinning the exact external contract of the app-server protocol so schema changes, serde annotation tweaks, or conversion regressions are caught immediately.

#### Function details

##### `absolute_path_string`  (lines 48–51)

```
fn absolute_path_string(path: &str) -> String
```

**Purpose**: Builds a normalized absolute path string for tests from a possibly relative fragment. It ensures test JSON uses host-appropriate absolute path formatting.

**Data flow**: Accepts `&str path`, prefixes it with `/` after trimming any leading slash, converts it through `test_path_buf`, then returns the displayed path as a `String`.

**Call relations**: Used by many tests that need stable JSON path literals without manually branching on platform formatting. It is a local helper and does not participate in production code paths.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `absolute_path`  (lines 53–56)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an `AbsolutePathBuf` test value from a path fragment. It is the typed counterpart to `absolute_path_string`.

**Data flow**: Takes `&str path`, normalizes it to start with `/`, passes it to `test_path_buf`, converts the result to an absolute path via `.abs()`, and returns the `AbsolutePathBuf`.

**Call relations**: Called by many tests that need typed absolute paths for protocol structs, including filesystem, sandbox, thread resume, and permission tests. `test_absolute_path` is a thin wrapper around it.

*Call graph*: called by 8 (additional_file_system_permissions_populates_entries_for_legacy_roots, fs_copy_params_round_trip_with_recursive_directory_copy, fs_create_directory_params_round_trip_with_default_recursive, fs_read_file_params_round_trip, fs_write_file_params_round_trip_with_base64_data, sandbox_policy_deserializes_legacy_workspace_write_full_access_field, test_absolute_path, thread_resume_response_round_trips_initial_turns_page); 2 external calls (test_path_buf, format!).


##### `test_absolute_path`  (lines 58–60)

```
fn test_absolute_path() -> AbsolutePathBuf
```

**Purpose**: Provides one fixed absolute path fixture used by process-spawn tests. It avoids repeating the same literal setup.

**Data flow**: Takes no input and returns `absolute_path("readable")`.

**Call relations**: Used by the process spawn tests to keep expected structs concise. It delegates entirely to `absolute_path`.

*Call graph*: calls 1 internal fn (absolute_path); called by 2 (process_spawn_params_distinguish_omitted_null_and_value_limits, process_spawn_params_round_trips_without_sandbox_policy).


##### `thread_sources_round_trip_as_scalar_labels`  (lines 63–84)

```
fn thread_sources_round_trip_as_scalar_labels()
```

**Purpose**: Verifies that `ThreadSource` serializes as a plain string label, deserializes back, and round-trips through the core thread-source type. It covers built-in and feature-string variants.

**Data flow**: Iterates over several `(ThreadSource, label)` pairs, serializes each source to JSON, asserts the scalar string matches the expected label, deserializes it back to `ThreadSource`, converts the source into `codex_protocol::protocol::ThreadSource`, and asserts converting back with `ThreadSource::from` reproduces the original value.

**Call relations**: Run by the test harness to validate the custom string-based serde and core conversion logic in `thread_data.rs`. It exercises both directions of the boundary conversion.

*Call graph*: 3 external calls (Feature, assert_eq!, to_value).


##### `approvals_reviewer_serializes_auto_review_and_accepts_legacy_guardian_subagent`  (lines 87–108)

```
fn approvals_reviewer_serializes_auto_review_and_accepts_legacy_guardian_subagent()
```

**Purpose**: Checks canonical serialization and legacy alias deserialization for `ApprovalsReviewer`. It ensures compatibility with older `guardian_subagent` payloads while emitting `auto_review`.

**Data flow**: Serializes `ApprovalsReviewer::User` and `AutoReview` to strings and asserts the exact JSON text. Then it loops over `user`, `auto_review`, and `guardian_subagent`, deserializes each string into `ApprovalsReviewer`, computes the expected enum, and asserts equality.

**Call relations**: This test protects the custom serde aliasing and schema intent defined in `shared.rs`. It is especially important because the enum has a manual `JsonSchema` implementation and compatibility semantics.

*Call graph*: 3 external calls (assert_eq!, format!, from_str).


##### `turn_defaults_legacy_missing_items_view_to_full`  (lines 111–124)

```
fn turn_defaults_legacy_missing_items_view_to_full()
```

**Purpose**: Ensures legacy turn payloads that omit `itemsView` still deserialize with `TurnItemsView::Full`. This preserves backward compatibility for older stored or upstream data.

**Data flow**: Deserializes a JSON turn object lacking `itemsView` into `Turn` and asserts the resulting `turn.items_view` equals `TurnItemsView::Full`.

**Call relations**: Executed as a regression test for the `#[serde(default)]` behavior on `Turn.items_view` in `thread_data.rs`.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `thread_turns_list_params_accepts_items_view`  (lines 127–139)

```
fn thread_turns_list_params_accepts_items_view()
```

**Purpose**: Verifies that `ThreadTurnsListParams` accepts the `itemsView` field and decodes it into the enum. It confirms the request schema for paginated turn listing.

**Data flow**: Deserializes a JSON object containing `threadId`, `cursor`, `limit`, `sortDirection`, and `itemsView: "notLoaded"` into `ThreadTurnsListParams`, then asserts the thread id and parsed `items_view` value.

**Call relations**: Covers the request-side serde contract for turn listing in `thread.rs`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `thread_resume_params_accept_turns_page_bootstrap`  (lines 142–162)

```
fn thread_resume_params_accept_turns_page_bootstrap()
```

**Purpose**: Checks that `ThreadResumeParams` can carry an `initialTurnsPage` bootstrap request. It validates nested deserialization of pagination options.

**Data flow**: Deserializes JSON with `threadId` and nested `initialTurnsPage` fields into `ThreadResumeParams`, then asserts `thread_id` and the fully populated `ThreadResumeInitialTurnsPageParams` value.

**Call relations**: Protects the experimental resume bootstrap shape defined in `thread.rs`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `thread_resume_response_round_trips_initial_turns_page`  (lines 165–219)

```
fn thread_resume_response_round_trips_initial_turns_page()
```

**Purpose**: Verifies that `ThreadResumeResponse` serializes and deserializes an embedded `initialTurnsPage` correctly. It also checks the surrounding thread payload shape.

**Data flow**: Constructs a full `ThreadResumeResponse` with a nested `Thread`, path values from `absolute_path`, and a populated `TurnsPage`; serializes it to JSON; asserts the `initialTurnsPage` subobject matches the expected camelCase structure; deserializes back; and asserts full equality.

**Call relations**: Exercises the response schema in `thread.rs`, including `TurnsPage` and several shared protocol types. It uses `absolute_path` to build typed cwd values.

*Call graph*: calls 1 internal fn (absolute_path); 4 external calls (new, new, assert_eq!, to_value).


##### `thread_turns_items_list_round_trips`  (lines 222–257)

```
fn thread_turns_items_list_round_trips()
```

**Purpose**: Checks serialization of turn-item list params and response payloads. It confirms cursor fields and tagged `ThreadItem` encoding.

**Data flow**: Constructs `ThreadTurnsItemsListParams`, serializes and compares JSON; then constructs `ThreadTurnsItemsListResponse` with a `ThreadItem::ContextCompaction`, serializes it, and asserts the exact JSON shape including `backwardsCursor`.

**Call relations**: Validates the paginated item-listing protocol in `thread.rs`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `thread_list_params_accepts_single_cwd`  (lines 260–271)

```
fn thread_list_params_accepts_single_cwd()
```

**Purpose**: Ensures `ThreadListParams.cwd` accepts a single string and decodes it as `ThreadListCwdFilter::One`. It also checks the default for `use_state_db_only`.

**Data flow**: Deserializes JSON containing only `cwd: "/workspace"` into `ThreadListParams`, then asserts `cwd` is `Some(One(...))` and `use_state_db_only` is false.

**Call relations**: Covers the untagged cwd filter shape in `thread.rs` and its default boolean behavior.

*Call graph*: 3 external calls (assert!, assert_eq!, json!).


##### `thread_list_params_accepts_multiple_cwds`  (lines 274–287)

```
fn thread_list_params_accepts_multiple_cwds()
```

**Purpose**: Ensures `ThreadListParams.cwd` also accepts an array of strings and decodes it as `ThreadListCwdFilter::Many`. This preserves the dual-form filter contract.

**Data flow**: Deserializes JSON with `cwd` as an array of two paths into `ThreadListParams` and asserts the resulting enum is `Many` with both strings preserved.

**Call relations**: Pairs with the single-cwd test to cover both branches of the untagged enum.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `thread_list_params_accepts_state_db_only_flag`  (lines 290–297)

```
fn thread_list_params_accepts_state_db_only_flag()
```

**Purpose**: Checks that the `useStateDbOnly` flag deserializes to `true` when present. It protects the scan-vs-state-db selection flag on thread listing.

**Data flow**: Deserializes JSON containing `useStateDbOnly: true` into `ThreadListParams` and asserts the boolean field is true.

**Call relations**: Validates the explicit opt-in flag in the thread listing request schema.

*Call graph*: 2 external calls (assert!, json!).


##### `collab_agent_state_maps_interrupted_status`  (lines 300–308)

```
fn collab_agent_state_maps_interrupted_status()
```

**Purpose**: Verifies conversion from core agent status to the API collaboration agent state for the interrupted case. It ensures the mapping preserves status and leaves message empty.

**Data flow**: Converts `CoreAgentStatus::Interrupted` via `CollabAgentState::from` and asserts the resulting struct has `status: Interrupted` and `message: None`.

**Call relations**: Exercises a conversion defined elsewhere in the v2 module; this file uses it as a regression check.

*Call graph*: 1 external calls (assert_eq!).


##### `external_agent_config_plugins_details_round_trip`  (lines 311–342)

```
fn external_agent_config_plugins_details_round_trip()
```

**Purpose**: Checks deserialization of a migration item carrying plugin-install details. It validates nested legacy plugin migration payload structure.

**Data flow**: Deserializes a JSON `ExternalAgentConfigMigrationItem` with `itemType: PLUGINS`, a cwd string, and nested `details.plugins`, then asserts the resulting Rust struct including `MigrationDetails` and `PluginsMigration` contents.

**Call relations**: Protects compatibility for external-agent config import payloads.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `external_agent_config_import_params_accept_legacy_plugin_details`  (lines 345–380)

```
fn external_agent_config_import_params_accept_legacy_plugin_details()
```

**Purpose**: Ensures the top-level import params accept the same legacy plugin details shape inside `migrationItems`. It validates the batch wrapper around migration items.

**Data flow**: Deserializes JSON into `ExternalAgentConfigImportParams` with one migration item and asserts the resulting nested structs match the expected values.

**Call relations**: Complements the previous test by covering the enclosing request type rather than the item alone.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `command_execution_request_approval_localization_rejects_relative_additional_permission_paths`  (lines 383–413)

```
fn command_execution_request_approval_localization_rejects_relative_additional_permission_paths()
```

**Purpose**: Verifies that relative filesystem paths are rejected when API additional permissions are localized into core permission profiles. This prevents unsafe or ambiguous path handling.

**Data flow**: Deserializes `CommandExecutionRequestApprovalParams` from JSON containing a relative read path, extracts `additional_permissions`, attempts `CoreAdditionalPermissionProfile::try_from`, expects an error, and asserts the error kind is `InvalidInput`.

**Call relations**: Tests the boundary between API permission payloads and core/native path validation.

*Call graph*: 3 external calls (try_from, assert_eq!, json!).


##### `permissions_request_approval_uses_request_permission_profile`  (lines 416–489)

```
fn permissions_request_approval_uses_request_permission_profile()
```

**Purpose**: Checks that permissions-request approval payloads deserialize into the API request-permission profile and convert cleanly into the core profile. It covers both network and filesystem permissions.

**Data flow**: Builds platform-specific absolute path strings, deserializes `PermissionsRequestApprovalParams`, asserts parsed cwd, environment id, and `RequestPermissionProfile` contents, then converts `params.permissions` with `CoreRequestPermissionProfile::try_from` and asserts the resulting core network and filesystem permissions.

**Call relations**: Exercises both serde and conversion logic for the newer request-permission profile path.

*Call graph*: 3 external calls (assert_eq!, cfg!, json!).


##### `permissions_request_approval_rejects_macos_permissions`  (lines 492–520)

```
fn permissions_request_approval_rejects_macos_permissions()
```

**Purpose**: Ensures unsupported `macos` permission fields are rejected during deserialization. This prevents clients from sending stale schema fields silently.

**Data flow**: Attempts to deserialize `PermissionsRequestApprovalParams` from JSON containing a `macos` object, expects an error, and asserts the error message mentions the unknown field.

**Call relations**: Acts as a negative compatibility test for strict request schema enforcement.

*Call graph*: 2 external calls (assert!, json!).


##### `additional_file_system_permissions_preserves_canonical_entries`  (lines 523–570)

```
fn additional_file_system_permissions_preserves_canonical_entries()
```

**Purpose**: Verifies that canonical filesystem sandbox entries survive conversion from core to API and back without loss. It covers special paths, glob patterns, access modes, and glob depth.

**Data flow**: Constructs a `CoreFileSystemPermissions` with explicit `entries` and `glob_scan_max_depth`, converts it to `AdditionalFileSystemPermissions::from`, asserts the API representation including `entries`, then converts back with `CoreFileSystemPermissions::try_from` and asserts equality with the original core value.

**Call relations**: Tests the canonical entry-based permission representation rather than legacy read/write roots.

*Call graph*: calls 1 internal fn (from); 3 external calls (new, assert_eq!, vec!).


##### `additional_file_system_permissions_populates_entries_for_legacy_roots`  (lines 573–612)

```
fn additional_file_system_permissions_populates_entries_for_legacy_roots()
```

**Purpose**: Checks that legacy read/write root permissions are mirrored into canonical `entries` when converted to the API type. This preserves compatibility while exposing the newer normalized form.

**Data flow**: Creates absolute read-only and read-write roots with `absolute_path`, builds core permissions via `from_read_write_roots`, converts to `AdditionalFileSystemPermissions`, computes legacy API path strings with `LegacyAppPathString::from_abs_path`, asserts both legacy `read`/`write` fields and synthesized `entries`, then converts back to core and asserts equality.

**Call relations**: Covers the compatibility bridge between legacy root lists and canonical sandbox entries.

*Call graph*: calls 3 internal fn (from, absolute_path, from_abs_path); 3 external calls (from_read_write_roots, assert_eq!, vec!).


##### `additional_file_system_permissions_rejects_zero_glob_scan_depth`  (lines 615–623)

```
fn additional_file_system_permissions_rejects_zero_glob_scan_depth()
```

**Purpose**: Ensures `globScanMaxDepth` cannot be zero when deserializing filesystem permissions. This protects the `NonZeroUsize` invariant.

**Data flow**: Attempts to deserialize `AdditionalFileSystemPermissions` from JSON with `globScanMaxDepth: 0` and expects deserialization to fail.

**Call relations**: Regression test for numeric validation encoded in the type definition.

*Call graph*: 1 external calls (json!).


##### `legacy_current_working_directory_special_path_deserializes_as_project_roots`  (lines 626–643)

```
fn legacy_current_working_directory_special_path_deserializes_as_project_roots()
```

**Purpose**: Verifies that the legacy special-path kind `current_working_directory` is accepted and normalized to `project_roots`. It also checks canonical reserialization.

**Data flow**: Deserializes a `FileSystemSpecialPath` from JSON `{ "kind": "current_working_directory" }`, asserts it becomes `ProjectRoots { subpath: None }`, then serializes it back and asserts the canonical JSON uses `project_roots` with `subpath: null`.

**Call relations**: Protects backward compatibility for renamed special-path identifiers.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `permissions_request_approval_response_uses_granted_permission_profile_without_macos`  (lines 646–710)

```
fn permissions_request_approval_response_uses_granted_permission_profile_without_macos()
```

**Purpose**: Checks that approval responses use the granted-permission profile shape and convert into core additional permissions without any macOS-specific fields. It mirrors the request-side test for responses.

**Data flow**: Deserializes `PermissionsRequestApprovalResponse` from JSON containing network and filesystem permissions, asserts the API `GrantedPermissionProfile`, then converts it with `CoreAdditionalPermissionProfile::try_from` and asserts the resulting core permissions.

**Call relations**: Validates the response-side permission conversion boundary.

*Call graph*: 3 external calls (assert_eq!, cfg!, json!).


##### `permissions_request_approval_response_defaults_scope_to_turn`  (lines 713–721)

```
fn permissions_request_approval_response_defaults_scope_to_turn()
```

**Purpose**: Ensures the permission grant scope defaults to `Turn` and `strict_auto_review` defaults to `None` when omitted. This locks down response defaults.

**Data flow**: Deserializes `PermissionsRequestApprovalResponse` from minimal JSON with empty `permissions`, then asserts `scope == PermissionGrantScope::Turn` and `strict_auto_review == None`.

**Call relations**: Covers defaulting behavior on the approval response schema.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `permissions_request_approval_response_accepts_strict_auto_review`  (lines 724–732)

```
fn permissions_request_approval_response_accepts_strict_auto_review()
```

**Purpose**: Checks that the optional `strictAutoReview` field is accepted and preserved. It validates an additional response flag without affecting defaults.

**Data flow**: Deserializes `PermissionsRequestApprovalResponse` from JSON containing `strictAutoReview: true` and asserts the field becomes `Some(true)`.

**Call relations**: Complements the default-scope test by covering the explicit optional flag path.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `permission_profile_selection_uses_id_string`  (lines 735–779)

```
fn permission_profile_selection_uses_id_string()
```

**Purpose**: Verifies that several request types represent permission profile selection as a plain string id. This ensures the API uses profile identifiers rather than embedded policy objects.

**Data flow**: Deserializes `ThreadStartParams`, `TurnStartParams`, `CommandExecParams`, `ThreadResumeParams`, and `ThreadForkParams` from JSON containing permission/profile id strings, then asserts each corresponding field stores the expected string.

**Call relations**: Cross-cuts multiple request schemas to pin a shared design choice around permission profile references.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `thread_path_params_deserialize_empty_path_as_none`  (lines 782–806)

```
fn thread_path_params_deserialize_empty_path_as_none()
```

**Purpose**: Ensures empty string path values are treated as absent for resume and fork params, while non-empty paths are preserved. This matches the documented semantics in `thread.rs`.

**Data flow**: Deserializes `ThreadResumeParams` and `ThreadForkParams` from JSON with `path: ""` and asserts `path == None`; then deserializes a resume payload with a non-empty path and asserts it becomes `Some(PathBuf(...))`.

**Call relations**: Tests the custom `deserialize_empty_path_as_none` helper wired into thread path fields.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `fs_get_metadata_response_round_trips_minimal_fields`  (lines 809–833)

```
fn fs_get_metadata_response_round_trips_minimal_fields()
```

**Purpose**: Checks exact JSON encoding and decoding for the minimal filesystem metadata response. It validates camelCase field names and numeric timestamps.

**Data flow**: Constructs `FsGetMetadataResponse`, serializes it, asserts the JSON object fields, deserializes back, and asserts equality.

**Call relations**: Part of the filesystem protocol regression coverage.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `fs_read_file_response_round_trips_base64_data`  (lines 836–852)

```
fn fs_read_file_response_round_trips_base64_data()
```

**Purpose**: Verifies that file-read responses carry base64 data under `dataBase64` and round-trip cleanly. It protects the binary-content wire format.

**Data flow**: Constructs `FsReadFileResponse`, serializes to JSON, asserts the exact field name and value, deserializes back, and asserts equality.

**Call relations**: Covers the response half of the fs/readFile protocol.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `fs_read_file_params_round_trip`  (lines 855–871)

```
fn fs_read_file_params_round_trip()
```

**Purpose**: Checks request serialization and deserialization for reading a file by absolute path. It ensures path fields use the expected string representation.

**Data flow**: Constructs `FsReadFileParams` with `absolute_path`, serializes it, asserts the JSON path string, deserializes back, and asserts equality.

**Call relations**: Uses the local absolute-path helper to validate the fs/readFile request schema.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, to_value).


##### `fs_create_directory_params_round_trip_with_default_recursive`  (lines 874–892)

```
fn fs_create_directory_params_round_trip_with_default_recursive()
```

**Purpose**: Verifies create-directory params preserve an explicit `recursive: null` when the optional field is unset. This distinguishes null from omission in the wire contract.

**Data flow**: Constructs `FsCreateDirectoryParams` with `recursive: None`, serializes it, asserts JSON contains `recursive: null`, deserializes back, and asserts equality.

**Call relations**: Covers nullable optional behavior for filesystem mutation params.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, to_value).


##### `fs_write_file_params_round_trip_with_base64_data`  (lines 895–913)

```
fn fs_write_file_params_round_trip_with_base64_data()
```

**Purpose**: Checks write-file request encoding for absolute path plus base64 payload. It protects the binary write request schema.

**Data flow**: Constructs `FsWriteFileParams`, serializes to JSON, asserts `path` and `dataBase64`, deserializes back, and asserts equality.

**Call relations**: Filesystem request regression test.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, to_value).


##### `fs_copy_params_round_trip_with_recursive_directory_copy`  (lines 916–936)

```
fn fs_copy_params_round_trip_with_recursive_directory_copy()
```

**Purpose**: Verifies copy params serialize source, destination, and recursive flag correctly. It covers directory-copy request shape.

**Data flow**: Constructs `FsCopyParams` with two absolute paths and `recursive: true`, serializes to JSON, asserts the exact object, deserializes back, and asserts equality.

**Call relations**: Another filesystem request schema test using the path helper.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, to_value).


##### `thread_shell_command_params_round_trip`  (lines 939–957)

```
fn thread_shell_command_params_round_trip()
```

**Purpose**: Checks the thread shell-command request schema, especially preserving the raw shell command string. It validates the unsandboxed shell-command API payload.

**Data flow**: Constructs `ThreadShellCommandParams`, serializes it, asserts `threadId` and `command`, deserializes back, and asserts equality.

**Call relations**: Covers the thread shell-command types defined in `thread.rs`.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `thread_shell_command_response_round_trip`  (lines 960–969)

```
fn thread_shell_command_response_round_trip()
```

**Purpose**: Ensures the empty shell-command response serializes as `{}` and deserializes back. It protects the marker response shape.

**Data flow**: Constructs `ThreadShellCommandResponse {}`, serializes to JSON, asserts `{}`, deserializes back, and asserts equality.

**Call relations**: Pairs with the shell-command params test for the response side.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `fs_changed_notification_round_trips`  (lines 972–996)

```
fn fs_changed_notification_round_trips()
```

**Purpose**: Verifies the filesystem change notification schema, including watch id and changed absolute paths. It protects event-stream payload formatting.

**Data flow**: Constructs `FsChangedNotification` with a watch id and two absolute paths, serializes it, asserts the JSON object and path strings, deserializes back, and asserts equality.

**Call relations**: Notification schema regression test for filesystem watching.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `command_exec_params_default_optional_streaming_flags`  (lines 999–1026)

```
fn command_exec_params_default_optional_streaming_flags()
```

**Purpose**: Checks default values for omitted command-exec streaming and timeout-related booleans. It ensures deserialization fills in the intended defaults.

**Data flow**: Deserializes `CommandExecParams` from minimal JSON containing command, timeout, and cwd, then asserts the resulting struct has false/default values for tty, streaming flags, output-cap flags, and other omitted optionals.

**Call relations**: Protects defaulting behavior in the command execution request schema.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `command_exec_params_round_trips_disable_timeout`  (lines 1029–1067)

```
fn command_exec_params_round_trips_disable_timeout()
```

**Purpose**: Verifies command-exec params preserve the `disableTimeout` flag and nullable optional fields during round-trip serialization. It distinguishes disabling timeout from specifying a timeout value.

**Data flow**: Constructs `CommandExecParams` with `disable_timeout: true`, serializes it, asserts the JSON includes `disableTimeout: true` and explicit nulls for nullable fields, deserializes back, and asserts equality.

**Call relations**: Covers one branch of command execution limit semantics.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `process_spawn_params_round_trips_without_sandbox_policy`  (lines 1070–1099)

```
fn process_spawn_params_round_trips_without_sandbox_policy()
```

**Purpose**: Checks process-spawn params serialize correctly when no sandbox policy exists on this older/lower-level API. It validates required and nullable fields.

**Data flow**: Constructs `ProcessSpawnParams` using `test_absolute_path`, serializes it, asserts the JSON object, deserializes back, and asserts equality.

**Call relations**: Uses the fixed path helper and covers the process API distinct from command/exec.

*Call graph*: calls 1 internal fn (test_absolute_path); 3 external calls (assert_eq!, to_value, vec!).


##### `process_spawn_params_distinguish_omitted_null_and_value_limits`  (lines 1102–1158)

```
fn process_spawn_params_distinguish_omitted_null_and_value_limits()
```

**Purpose**: Ensures `ProcessSpawnParams` preserves the three-way distinction for optional limits: omitted, explicit null, and explicit numeric value. This is a subtle but important wire-format invariant.

**Data flow**: Builds a base JSON object and deserializes it to assert omitted limits become `None`; deserializes a variant with `outputBytesCap: null` and `timeoutMs: null` to assert `Some(None)`; then deserializes a variant with numeric values to assert `Some(Some(...))` for both fields.

**Call relations**: Regression test for double-option semantics on process spawn limits.

*Call graph*: calls 1 internal fn (test_absolute_path); 3 external calls (assert_eq!, json!, vec!).


##### `command_exec_params_round_trips_disable_output_cap`  (lines 1161–1200)

```
fn command_exec_params_round_trips_disable_output_cap()
```

**Purpose**: Verifies command-exec params preserve the `disableOutputCap` flag and related nullable fields. It distinguishes disabling the cap from setting a numeric cap.

**Data flow**: Constructs `CommandExecParams` with `disable_output_cap: true`, serializes it, asserts the JSON shape, deserializes back, and asserts equality.

**Call relations**: Complements the disable-timeout test for the other execution limit flag.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `command_exec_params_round_trips_env_overrides_and_unsets`  (lines 1203–1248)

```
fn command_exec_params_round_trips_env_overrides_and_unsets()
```

**Purpose**: Checks that command-exec environment overrides serialize as a string-or-null map and round-trip correctly. It covers both setting and unsetting environment variables.

**Data flow**: Constructs `CommandExecParams` with an `env: HashMap<String, Option<String>>`, serializes it, asserts JSON contains string values and `null` for unset variables, deserializes back, and asserts equality.

**Call relations**: Protects the environment override contract for command execution.

*Call graph*: 4 external calls (from, assert_eq!, to_value, vec!).


##### `command_exec_write_round_trips_close_only_payload`  (lines 1251–1271)

```
fn command_exec_write_round_trips_close_only_payload()
```

**Purpose**: Verifies the stdin-write request can represent a close-only operation with no data payload. It checks explicit null encoding for `deltaBase64`.

**Data flow**: Constructs `CommandExecWriteParams` with `delta_base64: None` and `close_stdin: true`, serializes it, asserts the JSON object, deserializes back, and asserts equality.

**Call relations**: Covers one control-path request in the command execution API.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `command_exec_terminate_round_trips`  (lines 1274–1290)

```
fn command_exec_terminate_round_trips()
```

**Purpose**: Checks the terminate request schema for command execution. It ensures the process id field is named and encoded correctly.

**Data flow**: Constructs `CommandExecTerminateParams`, serializes it, asserts the JSON object, deserializes back, and asserts equality.

**Call relations**: Simple regression test for the terminate control request.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `command_exec_params_round_trip_with_size`  (lines 1293–1337)

```
fn command_exec_params_round_trip_with_size()
```

**Purpose**: Verifies PTY size information round-trips inside command-exec params. It covers the nested terminal-size object.

**Data flow**: Constructs `CommandExecParams` with `tty: true` and a `size` struct, serializes it, asserts the nested `rows`/`cols` JSON, deserializes back, and asserts equality.

**Call relations**: Covers terminal-oriented command execution requests.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `command_exec_resize_round_trips`  (lines 1340–1364)

```
fn command_exec_resize_round_trips()
```

**Purpose**: Checks the resize request schema for an existing command-exec PTY. It validates the nested size object and process id field.

**Data flow**: Constructs `CommandExecResizeParams`, serializes it, asserts the JSON object, deserializes back, and asserts equality.

**Call relations**: Regression test for PTY resize control messages.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `command_exec_output_delta_round_trips`  (lines 1367–1390)

```
fn command_exec_output_delta_round_trips()
```

**Purpose**: Verifies the streamed command-exec output delta notification schema. It protects stream enum encoding, base64 delta field naming, and cap flag behavior.

**Data flow**: Constructs `CommandExecOutputDeltaNotification`, serializes it, asserts the JSON object, deserializes back, and asserts equality.

**Call relations**: Notification-side counterpart to command execution request tests.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `process_control_params_round_trip`  (lines 1393–1447)

```
fn process_control_params_round_trip()
```

**Purpose**: Checks three lower-level process control request types in one test: write stdin, resize PTY, and kill. It validates their exact JSON shapes.

**Data flow**: Constructs `ProcessWriteStdinParams`, `ProcessResizePtyParams`, and `ProcessKillParams`; serializes each; asserts the expected JSON; deserializes each back; and asserts equality.

**Call relations**: Groups related process-control schema checks for the process API.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `process_notifications_round_trip`  (lines 1450–1494)

```
fn process_notifications_round_trip()
```

**Purpose**: Verifies process output and exit notifications serialize and deserialize correctly. It covers both streaming deltas and terminal exit summaries.

**Data flow**: Constructs `ProcessOutputDeltaNotification` and `ProcessExitedNotification`, serializes each, asserts the exact JSON objects, deserializes back, and asserts equality.

**Call relations**: Notification regression coverage for the process subsystem.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `command_execution_output_delta_round_trips`  (lines 1497–1520)

```
fn command_execution_output_delta_round_trips()
```

**Purpose**: Checks the item-scoped command execution output delta notification used in thread item streams. It ensures text deltas and item identifiers are preserved.

**Data flow**: Constructs `CommandExecutionOutputDeltaNotification`, serializes it, asserts the JSON object, deserializes back, and asserts equality.

**Call relations**: Covers the thread/item-level command output event distinct from raw process notifications.

*Call graph*: 2 external calls (assert_eq!, to_value).


##### `sandbox_policy_round_trips_external_sandbox_network_access`  (lines 1523–1538)

```
fn sandbox_policy_round_trips_external_sandbox_network_access()
```

**Purpose**: Verifies `SandboxPolicy::ExternalSandbox` converts to and from the core sandbox policy while preserving network access mode. It checks one branch of sandbox conversion logic.

**Data flow**: Constructs a v2 `SandboxPolicy::ExternalSandbox`, converts it with `to_core`, asserts the core enum value, converts back with `SandboxPolicy::from`, and asserts equality with the original v2 value.

**Call relations**: Exercises conversion logic defined elsewhere in the protocol module.

*Call graph*: calls 1 internal fn (from); 1 external calls (assert_eq!).


##### `sandbox_policy_round_trips_read_only_network_access`  (lines 1541–1556)

```
fn sandbox_policy_round_trips_read_only_network_access()
```

**Purpose**: Checks round-trip conversion for the read-only sandbox policy with boolean network access. It validates another sandbox variant.

**Data flow**: Constructs `SandboxPolicy::ReadOnly`, converts to core, asserts the core value, converts back, and asserts equality.

**Call relations**: Companion test to the external-sandbox conversion case.

*Call graph*: calls 1 internal fn (from); 1 external calls (assert_eq!).


##### `ask_for_approval_granular_round_trips_request_permissions_flag`  (lines 1559–1582)

```
fn ask_for_approval_granular_round_trips_request_permissions_flag()
```

**Purpose**: Verifies that the granular approval policy preserves the `request_permissions` flag through conversion to and from the core type. This guards a newer field in the granular config.

**Data flow**: Constructs `AskForApproval::Granular` with explicit booleans, converts it to core with `to_core`, asserts the embedded `CoreGranularApprovalConfig`, converts back with `AskForApproval::from`, and asserts equality.

**Call relations**: Directly exercises the conversion functions in `shared.rs`.

*Call graph*: calls 1 internal fn (from); 1 external calls (assert_eq!).


##### `ask_for_approval_granular_defaults_missing_optional_flags_to_false`  (lines 1585–1605)

```
fn ask_for_approval_granular_defaults_missing_optional_flags_to_false()
```

**Purpose**: Ensures omitted optional granular approval flags deserialize as `false`. It protects backward-compatible defaults for newer booleans.

**Data flow**: Deserializes `AskForApproval` from JSON containing only some granular fields, then asserts the resulting enum has `skill_approval: false` and `request_permissions: false` while preserving provided values.

**Call relations**: Covers serde defaulting behavior for the granular approval variant.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `ask_for_approval_granular_is_marked_experimental`  (lines 1608–1623)

```
fn ask_for_approval_granular_is_marked_experimental()
```

**Purpose**: Checks that the granular approval variant is tagged with the expected experimental gate string while non-granular variants are not. It validates metadata generated by the `ExperimentalApi` derive.

**Data flow**: Calls `ExperimentalApi::experimental_reason` on a granular `AskForApproval` value and on `AskForApproval::OnRequest`, then asserts the first returns `Some("askForApproval.granular")` and the second returns `None`.

**Call relations**: Tests experimental gating metadata rather than serde or conversion behavior.

*Call graph*: 2 external calls (experimental_reason, assert_eq!).


##### `config_granular_approval_policy_is_marked_experimental`  (lines 1626–1662)

```
fn config_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Ensures a `Config` containing granular approval policy reports the granular experimental gate. It checks nested experimental propagation.

**Data flow**: Constructs a `Config` with `approval_policy: Some(AskForApproval::Granular { ... })`, calls `ExperimentalApi::experimental_reason`, and asserts the returned reason string.

**Call relations**: Validates that nested experimental fields bubble up through larger config objects.

*Call graph*: 3 external calls (new, experimental_reason, assert_eq!).


##### `config_approvals_reviewer_is_marked_experimental`  (lines 1665–1695)

```
fn config_approvals_reviewer_is_marked_experimental()
```

**Purpose**: Checks that setting `approvals_reviewer` in `Config` triggers the expected experimental gate string. It protects field-level gating metadata.

**Data flow**: Constructs a `Config` with `approvals_reviewer: Some(ApprovalsReviewer::AutoReview)`, calls `ExperimentalApi::experimental_reason`, and asserts it returns `Some("config/read.approvalsReviewer")`.

**Call relations**: Another experimental metadata regression test.

*Call graph*: 3 external calls (new, experimental_reason, assert_eq!).


##### `config_requirements_granular_allowed_approval_policy_is_marked_experimental`  (lines 1698–1725)

```
fn config_requirements_granular_allowed_approval_policy_is_marked_experimental()
```

**Purpose**: Ensures granular approval policies inside `ConfigRequirements.allowed_approval_policies` are marked experimental. It checks gating through collection fields.

**Data flow**: Constructs `ConfigRequirements` with a vector containing one granular approval policy, calls `ExperimentalApi::experimental_reason`, and asserts the granular gate string.

**Call relations**: Covers nested experimental propagation through requirement lists.

*Call graph*: 3 external calls (experimental_reason, assert_eq!, vec!).


##### `client_request_thread_start_granular_approval_policy_is_marked_experimental`  (lines 1728–1746)

```
fn client_request_thread_start_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Checks that a `ClientRequest::ThreadStart` carrying granular approval policy is marked experimental. It validates gating at the top-level request enum.

**Data flow**: Constructs a `ClientRequest::ThreadStart` with integer request id and `ThreadStartParams` containing granular approval policy, calls `ExperimentalApi::experimental_reason`, and asserts the granular gate string.

**Call relations**: Ensures request-envelope experimental detection sees nested thread-start fields.

*Call graph*: 4 external calls (default, experimental_reason, Integer, assert_eq!).


##### `client_request_thread_resume_granular_approval_policy_is_marked_experimental`  (lines 1749–1768)

```
fn client_request_thread_resume_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Checks the same experimental propagation for `ClientRequest::ThreadResume`. It validates the resume request path.

**Data flow**: Constructs a `ClientRequest::ThreadResume` with granular approval policy in params, calls `experimental_reason`, and asserts the expected string.

**Call relations**: Companion to the thread-start request gating test.

*Call graph*: 4 external calls (default, experimental_reason, Integer, assert_eq!).


##### `client_request_thread_fork_granular_approval_policy_is_marked_experimental`  (lines 1771–1790)

```
fn client_request_thread_fork_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Checks experimental propagation for `ClientRequest::ThreadFork` with granular approval policy. It covers the fork request path.

**Data flow**: Constructs a `ClientRequest::ThreadFork` carrying granular approval policy, calls `experimental_reason`, and asserts the granular gate string.

**Call relations**: Another top-level request gating regression test.

*Call graph*: 4 external calls (default, experimental_reason, Integer, assert_eq!).


##### `client_request_turn_start_granular_approval_policy_is_marked_experimental`  (lines 1793–1814)

```
fn client_request_turn_start_granular_approval_policy_is_marked_experimental()
```

**Purpose**: Checks experimental propagation for `ClientRequest::TurnStart` with granular approval policy. It covers turn-start requests specifically.

**Data flow**: Constructs a `ClientRequest::TurnStart` with empty input and granular approval policy, calls `experimental_reason`, and asserts the expected string.

**Call relations**: Completes the set of request-envelope gating tests for approval policy.

*Call graph*: 5 external calls (default, new, experimental_reason, Integer, assert_eq!).


##### `mcp_server_elicitation_response_round_trips_rmcp_result`  (lines 1817–1841)

```
fn mcp_server_elicitation_response_round_trips_rmcp_result()
```

**Purpose**: Verifies conversion between RMCP elicitation results and the v2 MCP elicitation response type. It ensures action, content, and metadata survive both directions.

**Data flow**: Constructs an `rmcp::model::CreateElicitationResult`, converts it to `McpServerElicitationRequestResponse::from`, asserts the v2 struct, converts back with `rmcp::model::CreateElicitationResult::from`, and asserts equality with the original RMCP value.

**Call relations**: Exercises conversion logic for the MCP elicitation bridge.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert_eq!, json!).


##### `mcp_server_elicitation_request_from_core_url_request`  (lines 1844–1862)

```
fn mcp_server_elicitation_request_from_core_url_request()
```

**Purpose**: Checks conversion from a core URL-based elicitation request into the v2 MCP request enum. It validates the URL branch of the conversion.

**Data flow**: Constructs `CoreElicitationRequest::Url`, converts it with `McpServerElicitationRequest::try_from`, unwraps success, and asserts the resulting v2 enum variant and fields.

**Call relations**: Covers one accepted input shape for MCP elicitation conversion.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (assert_eq!).


##### `mcp_server_elicitation_request_from_core_form_request`  (lines 1865–1900)

```
fn mcp_server_elicitation_request_from_core_form_request()
```

**Purpose**: Checks conversion from a core form-based elicitation request into the v2 MCP request enum, including schema parsing. It validates the form branch and schema decoding.

**Data flow**: Constructs `CoreElicitationRequest::Form` with a JSON schema, converts it via `try_from`, separately deserializes the expected schema into `McpElicitationSchema`, and asserts the resulting v2 request matches the expected form variant.

**Call relations**: Exercises the more complex MCP elicitation conversion path that parses structured schema content.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (assert_eq!, json!, from_value).


##### `mcp_elicitation_schema_matches_mcp_2025_11_25_primitives`  (lines 1903–1997)

```
fn mcp_elicitation_schema_matches_mcp_2025_11_25_primitives()
```

**Purpose**: Verifies that the v2 MCP elicitation schema type accepts and preserves the supported primitive schema forms from the MCP 2025-11-25 shape. It covers string, integer, boolean, and legacy titled enum properties.

**Data flow**: Deserializes a JSON schema object into `McpElicitationSchema` and asserts the resulting nested Rust structure, including schema URI, object type, ordered properties map, primitive schema variants, defaults, formats, and required fields.

**Call relations**: Acts as a detailed executable spec for the accepted MCP form-schema subset.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `mcp_server_elicitation_request_rejects_null_core_form_schema`  (lines 2000–2010)

```
fn mcp_server_elicitation_request_rejects_null_core_form_schema()
```

**Purpose**: Ensures a core form elicitation request with `requested_schema: null` is rejected. This prevents invalid form requests from silently converting.

**Data flow**: Constructs `CoreElicitationRequest::Form` with `requested_schema: JsonValue::Null`, attempts `McpServerElicitationRequest::try_from`, and asserts the result is an error.

**Call relations**: Negative test for MCP form-schema validation.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert!, json!).


##### `mcp_server_elicitation_request_rejects_invalid_core_form_schema`  (lines 2013–2028)

```
fn mcp_server_elicitation_request_rejects_invalid_core_form_schema()
```

**Purpose**: Ensures invalid nested schema content in a core form elicitation request is rejected during conversion. It protects the schema parser against unsupported object-valued properties.

**Data flow**: Constructs `CoreElicitationRequest::Form` with an invalid property schema, attempts conversion with `try_from`, and asserts the result is an error.

**Call relations**: Companion negative test to the null-schema case.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (assert!, json!).


##### `mcp_server_elicitation_response_serializes_nullable_content`  (lines 2031–2046)

```
fn mcp_server_elicitation_response_serializes_nullable_content()
```

**Purpose**: Checks that MCP elicitation responses serialize absent `content` and `meta` as explicit nulls. It protects the exact response wire shape.

**Data flow**: Constructs `McpServerElicitationRequestResponse` with `content: None` and `meta: None`, serializes it, and asserts the JSON object contains `content: null` and `_meta: null`.

**Call relations**: Response-side serialization regression test for MCP elicitation.

*Call graph*: 1 external calls (assert_eq!).


##### `mcp_server_status_serializes_absent_server_info_as_null`  (lines 2049–2076)

```
fn mcp_server_status_serializes_absent_server_info_as_null()
```

**Purpose**: Verifies that MCP server status responses serialize missing `serverInfo` as `null`. It protects nullable nested object behavior.

**Data flow**: Constructs `ListMcpServerStatusResponse` with one `McpServerStatus` whose `server_info` is `None`, serializes it, and asserts the JSON object contains `serverInfo: null` plus empty collections for tools/resources.

**Call relations**: Covers one branch of MCP server status serialization.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `mcp_server_status_updated_accepts_missing_thread_id`  (lines 2079–2103)

```
fn mcp_server_status_updated_accepts_missing_thread_id()
```

**Purpose**: Ensures the MCP server status-updated notification accepts an omitted `threadId` and normalizes it to `None`, then serializes back as `null`. This preserves compatibility for notifications not tied to a thread.

**Data flow**: Deserializes `McpServerStatusUpdatedNotification` from JSON lacking `threadId`, asserts the resulting struct has `thread_id: None`, then serializes it back and asserts `threadId: null` appears in JSON.

**Call relations**: Tests optional-thread association behavior for MCP status notifications.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `mcp_server_status_serializes_absent_server_info_metadata_as_null`  (lines 2106–2147)

```
fn mcp_server_status_serializes_absent_server_info_metadata_as_null()
```

**Purpose**: Checks that optional metadata fields inside present `serverInfo` objects serialize as nulls. It validates nested nullable fields in MCP server info.

**Data flow**: Constructs `ListMcpServerStatusResponse` with `server_info: Some(McpServerInfo { title: None, description: None, icons: None, website_url: None, ... })`, serializes it, and asserts those nested fields appear as `null`.

**Call relations**: Complements the absent-server-info test by covering the present-but-partially-null case.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `sandbox_policy_round_trips_workspace_write_access`  (lines 2150–2171)

```
fn sandbox_policy_round_trips_workspace_write_access()
```

**Purpose**: Verifies round-trip conversion for the workspace-write sandbox policy, including writable roots and tmp exclusions. It covers the most parameterized sandbox variant.

**Data flow**: Constructs `SandboxPolicy::WorkspaceWrite`, converts to core with `to_core`, asserts the core value, converts back with `SandboxPolicy::from`, and asserts equality.

**Call relations**: Completes the sandbox conversion coverage alongside read-only and external-sandbox tests.

*Call graph*: calls 1 internal fn (from); 2 external calls (assert_eq!, vec!).


##### `sandbox_policy_deserializes_legacy_read_only_full_access_field`  (lines 2174–2189)

```
fn sandbox_policy_deserializes_legacy_read_only_full_access_field()
```

**Purpose**: Ensures legacy `readOnly.access.fullAccess` payloads are accepted and ignored when deserializing the modern read-only sandbox policy. This preserves backward compatibility with removed fields.

**Data flow**: Deserializes `SandboxPolicy` from JSON containing a legacy nested `access` object and `networkAccess`, then asserts the resulting policy is simply `ReadOnly { network_access: true }`.

**Call relations**: Compatibility test for removed legacy sandbox subfields.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `sandbox_policy_deserializes_legacy_workspace_write_full_access_field`  (lines 2192–2214)

```
fn sandbox_policy_deserializes_legacy_workspace_write_full_access_field()
```

**Purpose**: Ensures legacy `workspaceWrite.readOnlyAccess.fullAccess` payloads are accepted and ignored. It preserves compatibility for the workspace-write variant.

**Data flow**: Builds an absolute writable root with `absolute_path`, deserializes `SandboxPolicy` from JSON containing legacy `readOnlyAccess`, and asserts the resulting modern `WorkspaceWrite` policy fields.

**Call relations**: Companion compatibility test for the workspace-write sandbox variant.

*Call graph*: calls 1 internal fn (absolute_path); 2 external calls (assert_eq!, json!).


##### `sandbox_policy_rejects_legacy_read_only_restricted_access_field`  (lines 2217–2228)

```
fn sandbox_policy_rejects_legacy_read_only_restricted_access_field()
```

**Purpose**: Checks that removed legacy restricted-access payloads are rejected rather than silently interpreted. This prevents ambiguous downgrade behavior.

**Data flow**: Attempts to deserialize `SandboxPolicy` from JSON containing `readOnly.access.type: restricted`, expects an error, and asserts the error message mentions `readOnly.access`.

**Call relations**: Negative compatibility test for unsupported legacy sandbox fields.

*Call graph*: 2 external calls (assert!, json!).


##### `sandbox_policy_rejects_legacy_workspace_write_restricted_read_access_field`  (lines 2231–2246)

```
fn sandbox_policy_rejects_legacy_workspace_write_restricted_read_access_field()
```

**Purpose**: Checks that removed restricted `readOnlyAccess` payloads are rejected for workspace-write policies. It mirrors the read-only negative test.

**Data flow**: Attempts to deserialize `SandboxPolicy` from JSON containing `workspaceWrite.readOnlyAccess.type: restricted`, expects an error, and asserts the message mentions `workspaceWrite.readOnlyAccess`.

**Call relations**: Companion negative test for workspace-write legacy field rejection.

*Call graph*: 2 external calls (assert!, json!).


##### `automatic_approval_review_deserializes_aborted_status`  (lines 2249–2266)

```
fn automatic_approval_review_deserializes_aborted_status()
```

**Purpose**: Verifies that guardian approval reviews accept the `aborted` status and deserialize optional fields as `None`. It protects a specific review-state enum branch.

**Data flow**: Deserializes `GuardianApprovalReview` from JSON with `status: "aborted"` and null optional fields, then asserts the resulting struct fields.

**Call relations**: Regression test for guardian/auto-review protocol types.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `guardian_approval_review_action_round_trips_command_shape`  (lines 2269–2291)

```
fn guardian_approval_review_action_round_trips_command_shape()
```

**Purpose**: Checks the tagged command action shape for guardian approval review actions. It validates both deserialization and reserialization of the command variant.

**Data flow**: Creates a JSON object for a command action, deserializes it into `GuardianApprovalReviewAction`, asserts the enum variant and fields including absolute cwd, then serializes back and asserts the original JSON.

**Call relations**: Covers one action variant in the guardian review protocol.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `network_requirements_deserializes_legacy_fields`  (lines 2294–2320)

```
fn network_requirements_deserializes_legacy_fields()
```

**Purpose**: Ensures legacy network requirement fields (`allowedDomains`, `deniedDomains`, `allowUnixSockets`) still deserialize into the modern struct. It preserves backward compatibility for older config payloads.

**Data flow**: Deserializes `NetworkRequirements` from JSON containing only legacy fields and asserts the resulting struct has those legacy vectors populated while canonical fields remain `None`.

**Call relations**: Compatibility test for network requirement schema evolution.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `network_requirements_serializes_canonical_and_legacy_fields`  (lines 2323–2379)

```
fn network_requirements_serializes_canonical_and_legacy_fields()
```

**Purpose**: Checks that `NetworkRequirements` serializes both canonical map-based fields and legacy list-based fields together when populated. This supports mixed-version consumers.

**Data flow**: Constructs a `NetworkRequirements` with canonical booleans, ports, domain/unix-socket maps, and legacy allow/deny lists, serializes it, and asserts the full JSON object including both representations.

**Call relations**: Serialization-side counterpart to the legacy deserialization test.

*Call graph*: 3 external calls (from, assert_eq!, vec!).


##### `core_turn_item_into_thread_item_converts_supported_variants`  (lines 2382–2643)

```
fn core_turn_item_into_thread_item_converts_supported_variants()
```

**Purpose**: Exhaustively verifies conversion from core `TurnItem` variants into API `ThreadItem` variants for the supported cases. It covers user messages, agent messages, reasoning, web search, image view, file changes, and MCP tool calls.

**Data flow**: Constructs multiple core `TurnItem` values with nested content and metadata, converts each via `ThreadItem::from`, and asserts the resulting API enum variant and fields, including text concatenation for agent messages, memory citation field renaming, patch change flattening, MCP result boxing, and duration conversion from `Duration` to milliseconds.

**Call relations**: This is one of the broadest conversion tests in the suite, exercising many `From` implementations defined across the v2 module.

*Call graph*: 14 external calls (from_millis, from, new, assert_eq!, AgentMessage, FileChange, ImageView, McpToolCall, Reasoning, UserMessage (+4 more)).


##### `user_input_into_core_preserves_image_detail`  (lines 2646–2670)

```
fn user_input_into_core_preserves_image_detail()
```

**Purpose**: Checks that API `UserInput` image variants preserve `ImageDetail` when converted into core user input. It covers both remote and local image forms.

**Data flow**: Constructs `UserInput::Image` and `UserInput::LocalImage`, calls `.into_core()` on each, and asserts the resulting `CoreUserInput` variants retain the same URL/path and `detail` value.

**Call relations**: Regression test for user-input conversion fidelity.

*Call graph*: 1 external calls (assert_eq!).


##### `skills_list_params_serialization_uses_force_reload`  (lines 2673–2694)

```
fn skills_list_params_serialization_uses_force_reload()
```

**Purpose**: Verifies `SkillsListParams` omits fields when empty/default and emits `forceReload` when true. It protects the request schema for skill discovery.

**Data flow**: Serializes one `SkillsListParams` with empty `cwds` and `force_reload: false` and asserts `{}`; serializes another with one cwd and `force_reload: true` and asserts JSON contains `cwds` and `forceReload`.

**Call relations**: Covers serde defaults and skip rules in `plugin.rs`.

*Call graph*: 1 external calls (assert_eq!).


##### `skills_extra_roots_set_params_serialization_uses_extra_roots`  (lines 2697–2707)

```
fn skills_extra_roots_set_params_serialization_uses_extra_roots()
```

**Purpose**: Checks that `SkillsExtraRootsSetParams` serializes its absolute path list under `extraRoots`. It validates the request field naming and path encoding.

**Data flow**: Constructs `SkillsExtraRootsSetParams` with one absolute path from `absolute_path`, serializes it, and asserts the JSON object contains `extraRoots` with the expected path string.

**Call relations**: Simple serialization test for the extra-roots API.

*Call graph*: 1 external calls (assert_eq!).


##### `skills_extra_roots_set_params_rejects_relative_roots`  (lines 2710–2715)

```
fn skills_extra_roots_set_params_rejects_relative_roots()
```

**Purpose**: Ensures relative paths are rejected when deserializing `SkillsExtraRootsSetParams`. This protects the absolute-path invariant on extra skill roots.

**Data flow**: Attempts to deserialize `SkillsExtraRootsSetParams` from JSON containing `"relative/path"` and asserts the result is an error.

**Call relations**: Negative test for path validation in the skills API.

*Call graph*: 2 external calls (assert!, json!).


##### `plugin_source_serializes_local_git_and_remote_variants`  (lines 2718–2758)

```
fn plugin_source_serializes_local_git_and_remote_variants()
```

**Purpose**: Verifies tagged serialization for all `PluginSource` variants. It ensures local paths, git metadata, and remote-only sources use the expected JSON shapes.

**Data flow**: Builds a platform-specific `AbsolutePathBuf`, serializes `PluginSource::Local`, `PluginSource::Git`, and `PluginSource::Remote`, and asserts each JSON object’s `type` tag and associated fields.

**Call relations**: Covers the discriminated union schema for plugin source metadata.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `marketplace_add_params_serialization_uses_optional_ref_name_and_sparse_paths`  (lines 2761–2789)

```
fn marketplace_add_params_serialization_uses_optional_ref_name_and_sparse_paths()
```

**Purpose**: Checks `MarketplaceAddParams` serialization with absent and present optional git fields. It validates explicit null handling for `refName` and `sparsePaths`.

**Data flow**: Serializes one `MarketplaceAddParams` with `None` optionals and asserts null-valued fields; serializes another with concrete `ref_name` and `sparse_paths` and asserts those values appear in camelCase JSON.

**Call relations**: Serialization regression test for marketplace add requests.

*Call graph*: 1 external calls (assert_eq!).


##### `marketplace_upgrade_params_serialization_uses_optional_marketplace_name`  (lines 2792–2819)

```
fn marketplace_upgrade_params_serialization_uses_optional_marketplace_name()
```

**Purpose**: Verifies `MarketplaceUpgradeParams` serializes and deserializes the optional marketplace selector correctly. It covers both omitted and explicit values.

**Data flow**: Serializes `MarketplaceUpgradeParams { marketplace_name: None }` and asserts `marketplaceName: null`; deserializes `{}` and asserts `None`; serializes a value with `Some("debug")` and asserts the string field.

**Call relations**: Covers nullable optional behavior for marketplace upgrade requests.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_marketplace_entry_serializes_remote_only_path_as_null`  (lines 2822–2838)

```
fn plugin_marketplace_entry_serializes_remote_only_path_as_null()
```

**Purpose**: Ensures remote-only marketplace entries serialize `path` as `null` rather than omitting it. This distinguishes remote catalogs from local files explicitly.

**Data flow**: Constructs `PluginMarketplaceEntry` with `path: None`, serializes it, and asserts the JSON object contains `path: null` plus empty plugin list and null interface.

**Call relations**: Regression test for marketplace entry response shape.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_interface_serializes_local_paths_and_remote_urls_separately`  (lines 2841–2892)

```
fn plugin_interface_serializes_local_paths_and_remote_urls_separately()
```

**Purpose**: Checks that `PluginInterface` keeps local asset paths and remote asset URLs in separate fields during serialization. It validates the dual-source media metadata design.

**Data flow**: Builds a platform-specific absolute icon path, constructs `PluginInterface` with both local and remote asset fields, serializes it, and asserts the JSON object contains distinct `composerIcon`, `composerIconUrl`, `logo`, `logoUrl`, `screenshots`, and `screenshotUrls` fields.

**Call relations**: Covers a nuanced response schema in `plugin.rs`.

*Call graph*: calls 1 internal fn (try_from); 5 external calls (from, new, assert_eq!, cfg!, vec!).


##### `plugin_list_params_ignore_removed_force_remote_sync_field`  (lines 2895–2907)

```
fn plugin_list_params_ignore_removed_force_remote_sync_field()
```

**Purpose**: Ensures the removed `forceRemoteSync` field is ignored when deserializing `PluginListParams`. This preserves compatibility with older clients.

**Data flow**: Deserializes `PluginListParams` from JSON containing `cwds: null` and `forceRemoteSync: true`, then asserts the resulting struct only contains `cwds: None` and `marketplace_kinds: None`.

**Call relations**: Compatibility test for removed plugin-list request fields.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_list_params_serializes_marketplace_kind_filter`  (lines 2910–2934)

```
fn plugin_list_params_serializes_marketplace_kind_filter()
```

**Purpose**: Verifies serialization of the marketplace-kind filter enum values in `PluginListParams`. It checks the exact kebab-case strings for all variants.

**Data flow**: Constructs `PluginListParams` with a vector of all `PluginListMarketplaceKind` variants, serializes it, and asserts the JSON array contains `local`, `vertical`, `workspace-directory`, `shared-with-me`, and `created-by-me-remote`.

**Call relations**: Covers enum wire-format stability for plugin listing filters.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_installed_params_serializes_install_suggestion_names`  (lines 2937–2955)

```
fn plugin_installed_params_serializes_install_suggestion_names()
```

**Purpose**: Checks serialization of `installSuggestionPluginNames` in `PluginInstalledParams`. It validates the mention-surface install suggestion field.

**Data flow**: Constructs `PluginInstalledParams` with two suggestion names, serializes it, and asserts the JSON object contains the expected camelCase array field.

**Call relations**: Serialization regression test for installed-plugin listing params.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_read_params_serialization_uses_install_source_fields`  (lines 2958–3006)

```
fn plugin_read_params_serialization_uses_install_source_fields()
```

**Purpose**: Verifies `PluginReadParams` supports both local marketplace path and remote marketplace name selectors, while ignoring removed sync fields. It covers both serialization and deserialization paths.

**Data flow**: Builds a platform-specific marketplace path, serializes params with `marketplace_path: Some(...)`, asserts JSON fields, deserializes JSON containing `forceRemoteSync` and a local path, asserts the struct, then deserializes a remote-marketplace variant and asserts that branch.

**Call relations**: Covers the dual-source selector design for plugin reads.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `plugin_install_params_serialization_omits_force_remote_sync`  (lines 3009–3058)

```
fn plugin_install_params_serialization_omits_force_remote_sync()
```

**Purpose**: Checks the same local-vs-remote selector behavior for `PluginInstallParams` and confirms removed `forceRemoteSync` is ignored. It protects install request compatibility.

**Data flow**: Builds a marketplace path, serializes local install params and asserts JSON, deserializes local and remote JSON payloads containing `forceRemoteSync`, and asserts the resulting structs ignore that removed field.

**Call relations**: Companion test to plugin-read params for the install endpoint.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `plugin_skill_read_params_serialization_uses_remote_plugin_id`  (lines 3061–3075)

```
fn plugin_skill_read_params_serialization_uses_remote_plugin_id()
```

**Purpose**: Verifies the remote plugin skill-read request uses `remotePluginId` and related camelCase fields. It protects the remote skill content lookup schema.

**Data flow**: Constructs `PluginSkillReadParams`, serializes it, and asserts the JSON object contains `remoteMarketplaceName`, `remotePluginId`, and `skillName`.

**Call relations**: Simple serialization test for remote skill reads.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_share_params_and_response_serialization_use_camel_case_fields`  (lines 3078–3257)

```
fn plugin_share_params_and_response_serialization_use_camel_case_fields()
```

**Purpose**: Checks a wide range of plugin sharing request and response types for exact camelCase field names, enum spellings, and nullable option handling. It covers save, update-targets, list, checkout, and delete payloads.

**Data flow**: Builds platform-specific plugin and marketplace paths, serializes multiple sharing structs (`PluginShareSaveParams`, `PluginShareSaveResponse`, `PluginShareUpdateTargetsParams`, `PluginShareUpdateTargetsResponse`, `PluginShareCheckoutParams`, `PluginShareCheckoutResponse`, `PluginShareDeleteParams`), deserializes `PluginShareListParams` from `{}`, and asserts each JSON shape exactly.

**Call relations**: This is the main regression test for the plugin sharing protocol surface in `plugin.rs`.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `plugin_share_list_response_serializes_share_items`  (lines 3260–3306)

```
fn plugin_share_list_response_serializes_share_items()
```

**Purpose**: Verifies the list-shared-plugins response shape, including nested `PluginSummary` and nullable local path. It protects the response schema for shared plugin listings.

**Data flow**: Constructs `PluginShareListResponse` with one `PluginShareListItem` containing a remote `PluginSummary`, serializes it, and asserts the nested JSON object including `remotePluginId`, `source`, install/auth policy enums, and `localPluginPath: null`.

**Call relations**: Response-side sharing schema regression test.

*Call graph*: 1 external calls (assert_eq!).


##### `plugin_summary_defaults_missing_availability_to_available`  (lines 3309–3325)

```
fn plugin_summary_defaults_missing_availability_to_available()
```

**Purpose**: Ensures `PluginSummary.availability` defaults to `Available` when omitted and that other optional fields default to `None`. This preserves compatibility with older payloads.

**Data flow**: Deserializes `PluginSummary` from JSON lacking `availability`, `localVersion`, and `shareContext`, then asserts `availability == PluginAvailability::Available` and the omitted optionals are `None`.

**Call relations**: Covers serde defaults in the plugin summary model.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `plugin_availability_deserializes_enabled_alias`  (lines 3328–3336)

```
fn plugin_availability_deserializes_enabled_alias()
```

**Purpose**: Checks that the upstream alias `ENABLED` deserializes as `PluginAvailability::Available` and reserializes canonically as `AVAILABLE`. It protects compatibility with upstream service responses.

**Data flow**: Deserializes `PluginAvailability` from JSON string `"ENABLED"`, asserts the enum value is `Available`, serializes it back, and asserts the canonical JSON string `"AVAILABLE"`.

**Call relations**: Regression test for the aliasing behavior documented in `plugin.rs`.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `plugin_uninstall_params_serialization_omits_force_remote_sync`  (lines 3339–3381)

```
fn plugin_uninstall_params_serialization_omits_force_remote_sync()
```

**Purpose**: Ensures uninstall params serialize only `pluginId` and ignore removed `forceRemoteSync` on input. It covers both marketplace-style and remote-plugin-style ids.

**Data flow**: Serializes `PluginUninstallParams` for two different plugin id formats and asserts the JSON object each time; deserializes JSON containing `forceRemoteSync` for both ids and asserts the resulting structs ignore that field.

**Call relations**: Compatibility test for uninstall request schema evolution.

*Call graph*: 1 external calls (assert_eq!).


##### `marketplace_remove_response_serializes_nullable_installed_root`  (lines 3384–3415)

```
fn marketplace_remove_response_serializes_nullable_installed_root()
```

**Purpose**: Checks that marketplace remove responses serialize `installedRoot` as either a path string or `null`. It validates nullable path behavior in the response.

**Data flow**: Builds a platform-specific absolute path, serializes `MarketplaceRemoveResponse` once with `Some(installed_root)` and once with `None`, and asserts the corresponding JSON objects.

**Call relations**: Response schema regression test for marketplace removal.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `marketplace_upgrade_response_serializes_camel_case_fields`  (lines 3418–3446)

```
fn marketplace_upgrade_response_serializes_camel_case_fields()
```

**Purpose**: Verifies the marketplace upgrade response uses the expected camelCase field names and nested error objects. It protects the batch-upgrade result schema.

**Data flow**: Builds a platform-specific upgraded root path, constructs `MarketplaceUpgradeResponse` with selected marketplaces, upgraded roots, and one error, serializes it, and asserts the exact JSON object.

**Call relations**: Serialization test for marketplace upgrade results.

*Call graph*: calls 1 internal fn (try_from); 3 external calls (from, assert_eq!, cfg!).


##### `codex_error_info_serializes_http_status_code_in_camel_case`  (lines 3449–3462)

```
fn codex_error_info_serializes_http_status_code_in_camel_case()
```

**Purpose**: Checks that structured `CodexErrorInfo` variants serialize nested `httpStatusCode` in camelCase. It validates one of the richer error payload shapes.

**Data flow**: Constructs `CodexErrorInfo::ResponseTooManyFailedAttempts { http_status_code: Some(401) }`, serializes it, and asserts the tagged JSON object contains `httpStatusCode`.

**Call relations**: Regression test for error enum serialization in `shared.rs`.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_error_info_serializes_cyber_policy_in_camel_case`  (lines 3465–3470)

```
fn codex_error_info_serializes_cyber_policy_in_camel_case()
```

**Purpose**: Ensures the simple `CyberPolicy` error variant serializes as the camelCase string `cyberPolicy`. It protects enum casing.

**Data flow**: Serializes `CodexErrorInfo::CyberPolicy` and asserts the resulting JSON string.

**Call relations**: Simple enum serialization test for shared error types.

*Call graph*: 1 external calls (assert_eq!).


##### `codex_error_info_serializes_active_turn_not_steerable_turn_kind_in_camel_case`  (lines 3473–3486)

```
fn codex_error_info_serializes_active_turn_not_steerable_turn_kind_in_camel_case()
```

**Purpose**: Checks serialization of the nested `turnKind` field inside `ActiveTurnNotSteerable`. It validates both outer and inner camelCase naming.

**Data flow**: Constructs `CodexErrorInfo::ActiveTurnNotSteerable { turn_kind: NonSteerableTurnKind::Review }`, serializes it, and asserts the JSON object contains `turnKind: "review"`.

**Call relations**: Covers the nested enum serialization path in shared error reporting.

*Call graph*: 1 external calls (assert_eq!).


##### `dynamic_tool_response_serializes_content_items`  (lines 3489–3510)

```
fn dynamic_tool_response_serializes_content_items()
```

**Purpose**: Verifies serialization of a dynamic tool response containing one text content item. It protects the tagged content-item schema.

**Data flow**: Constructs `DynamicToolCallResponse` with one `InputText` content item and `success: true`, serializes it, and asserts the JSON object including the tagged `contentItems` entry.

**Call relations**: Regression test for dynamic tool output payloads.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `dynamic_tool_response_serializes_text_and_image_content_items`  (lines 3513–3543)

```
fn dynamic_tool_response_serializes_text_and_image_content_items()
```

**Purpose**: Checks serialization of mixed text and image dynamic tool content items. It validates multiple tagged variants in one response.

**Data flow**: Constructs `DynamicToolCallResponse` with `InputText` and `InputImage` items, serializes it, and asserts the JSON array contains both tagged objects with the expected fields.

**Call relations**: Companion test to the single-item dynamic tool response case.

*Call graph*: 3 external calls (assert_eq!, to_value, vec!).


##### `thread_start_params_preserve_explicit_null_service_tier`  (lines 3546–3560)

```
fn thread_start_params_preserve_explicit_null_service_tier()
```

**Purpose**: Ensures `ThreadStartParams.service_tier` preserves explicit `null` distinctly from omission. This protects the double-option semantics for clearing overrides.

**Data flow**: Deserializes `ThreadStartParams` from JSON with `serviceTier: null`, asserts `service_tier == Some(None)`, serializes back and asserts the field is present as JSON null, then serializes `ThreadStartParams::default()` and asserts the field is omitted.

**Call relations**: Regression test for the custom double-option serde helpers used in thread params.

*Call graph*: 5 external calls (default, assert_eq!, json!, from_value, to_value).


##### `thread_lifecycle_responses_default_missing_optional_fields`  (lines 3563–3609)

```
fn thread_lifecycle_responses_default_missing_optional_fields()
```

**Purpose**: Checks that thread start/resume/fork responses default several optional fields when omitted in JSON. It protects backward compatibility for older response payloads.

**Data flow**: Builds one JSON response object missing fields like `instructionSources`, `parentThreadId`, `activePermissionProfile`, and `initialTurnsPage`, deserializes it into `ThreadStartResponse`, `ThreadResumeResponse`, and `ThreadForkResponse`, then asserts the omitted fields default to empty vectors or `None` as appropriate.

**Call relations**: Covers response-side defaulting behavior across three related thread lifecycle types.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `turn_start_params_preserve_explicit_null_service_tier`  (lines 3612–3651)

```
fn turn_start_params_preserve_explicit_null_service_tier()
```

**Purpose**: Ensures `TurnStartParams.service_tier` also preserves explicit null distinctly from omission. It mirrors the thread-start service-tier semantics.

**Data flow**: Deserializes `TurnStartParams` from JSON with `serviceTier: null`, asserts `Some(None)`, serializes back and checks the field is present as null, then serializes a manually constructed params value with `service_tier: None` and asserts the field is omitted.

**Call relations**: Companion double-option test for turn-start requests.

*Call graph*: 5 external calls (assert_eq!, json!, from_value, to_value, vec!).


##### `thread_settings_update_params_preserve_explicit_null_service_tier`  (lines 3654–3676)

```
fn thread_settings_update_params_preserve_explicit_null_service_tier()
```

**Purpose**: Checks explicit-null preservation for `ThreadSettingsUpdateParams.service_tier`. It validates the same clear-vs-omit semantics on settings updates.

**Data flow**: Deserializes `ThreadSettingsUpdateParams` from JSON with `serviceTier: null`, asserts `Some(None)`, serializes back and checks for JSON null, then serializes a default-like value with `service_tier: None` and asserts omission.

**Call relations**: Completes the service-tier double-option coverage across thread lifecycle/update requests.

*Call graph*: 5 external calls (default, assert_eq!, json!, from_value, to_value).


##### `thread_settings_update_params_preserve_field_level_experimental_gates`  (lines 3679–3722)

```
fn thread_settings_update_params_preserve_field_level_experimental_gates()
```

**Purpose**: Verifies that specific experimental fields on `ThreadSettingsUpdateParams` report the correct gate strings independently. It checks permissions, granular approval policy, and collaboration mode.

**Data flow**: Constructs three `ThreadSettingsUpdateParams` values, each setting one experimental field, calls `ExperimentalApi::experimental_reason` on each, and asserts the returned gate string matches the field or nested variant.

**Call relations**: Regression test for field-level experimental metadata on settings updates.

*Call graph*: 2 external calls (default, assert_eq!).


##### `turn_start_params_round_trip_environments`  (lines 3725–3768)

```
fn turn_start_params_round_trip_environments()
```

**Purpose**: Checks that `TurnStartParams.environments` preserves foreign path syntax and triggers the experimental gate when present. It validates nested environment selection payloads.

**Data flow**: Builds a platform-foreign raw cwd string, deserializes it into `LegacyAppPathString`, deserializes `TurnStartParams` containing one environment entry, asserts the parsed environments vector and experimental reason, serializes back, and asserts the JSON `environments` field matches the original syntax-preserving value.

**Call relations**: Covers both serde and experimental gating for turn environment overrides.

*Call graph*: 4 external calls (assert_eq!, json!, from_value, to_value).


##### `turn_start_params_preserve_empty_environments`  (lines 3771–3787)

```
fn turn_start_params_preserve_empty_environments()
```

**Purpose**: Ensures an explicitly empty `environments` array is preserved as `Some(Vec::new())` and still counts as using the experimental field. This distinguishes empty from omitted/null.

**Data flow**: Deserializes `TurnStartParams` from JSON with `environments: []`, asserts the field is `Some(Vec::new())`, checks the experimental reason string, serializes back, and asserts the JSON field is an empty array.

**Call relations**: Companion test to the non-empty environments case.

*Call graph*: 4 external calls (assert_eq!, json!, from_value, to_value).


##### `turn_start_params_treat_null_or_omitted_environments_as_default`  (lines 3790–3813)

```
fn turn_start_params_treat_null_or_omitted_environments_as_default()
```

**Purpose**: Checks that null or omitted `environments` both mean the default behavior and do not trigger experimental gating. It protects the tri-state semantics of the field.

**Data flow**: Deserializes two `TurnStartParams` values, one with `environments: null` and one with the field omitted, asserts both have `environments: None`, and asserts `ExperimentalApi::experimental_reason` returns `None` for both.

**Call relations**: Completes the environments-field semantics coverage by testing the non-opt-in cases.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `realtime_append_text_defaults_role_to_user`  (lines 3816–3831)

```
fn realtime_append_text_defaults_role_to_user()
```

**Purpose**: Ensures `ThreadRealtimeAppendTextParams.role` defaults to `ConversationTextRole::User` when omitted. It protects a convenience default in the realtime API.

**Data flow**: Deserializes `ThreadRealtimeAppendTextParams` from JSON containing only `threadId` and `text`, then asserts the resulting struct has `role: ConversationTextRole::User`.

**Call relations**: Regression test for defaulting behavior in the realtime request schema.

*Call graph*: 2 external calls (assert_eq!, json!).


### Schema fixture verification
These tests finalize the stage by checking that generated TypeScript and JSON schema artifacts remain synchronized with the vendored fixtures.

### `app-server-protocol/tests/schema_fixtures.rs`

`test` · `test execution and schema fixture verification`

This test file is the enforcement layer for schema fixture drift. The two top-level tests cover TypeScript and JSON separately. The TypeScript test reads the vendored `schema/typescript` subtree and compares it against an in-memory tree produced by `generate_typescript_schema_fixture_subtree_for_tests`; the JSON test uses a temporary directory, runs the real JSON generator into it, then compares that generated subtree against vendored `schema/json` fixtures.

The comparison logic lives in `assert_schema_trees_match`. It first compares the sorted path lists from the two `BTreeMap`s; if the file sets differ, it renders a unified diff of the path lists and panics with an instruction to run `just write-app-server-schema`. If the file sets match, it compares each file’s bytes and, on mismatch, renders a unified line diff of the decoded contents for a more actionable failure.

`schema_root` is careful about Bazel runfiles: instead of assuming directories resolve reliably, it locates known fixture files (`schema/typescript/index.ts` and the JSON bundle), walks up to their parents, and asserts both derivations agree on the same schema root. `read_tree` is a small wrapper that adds context around subtree reads.

#### Function details

##### `typescript_schema_fixtures_match_generated`  (lines 12–21)

```
fn typescript_schema_fixtures_match_generated() -> Result<()>
```

**Purpose**: Checks that vendored TypeScript schema fixtures exactly match the current in-memory TypeScript schema generation output.

**Data flow**: Resolves the schema root, reads the vendored `typescript` subtree into a `BTreeMap`, generates a fresh TypeScript fixture tree in memory, and passes both maps to `assert_schema_trees_match`. It returns success only if both file paths and contents match.

**Call relations**: This is one of the two top-level test entrypoints. It orchestrates fixture loading and delegates all detailed comparison logic to `assert_schema_trees_match`.

*Call graph*: calls 3 internal fn (assert_schema_trees_match, read_tree, schema_root); 1 external calls (generate_typescript_schema_fixture_subtree_for_tests).


##### `json_schema_fixtures_match_generated`  (lines 24–28)

```
fn json_schema_fixtures_match_generated() -> Result<()>
```

**Purpose**: Checks that vendored JSON schema fixtures match the output of the real JSON schema generator with experimental API disabled.

**Data flow**: Calls `assert_schema_fixtures_match_generated` with the `json` label and a closure that runs `generate_json_with_experimental(output_dir, false)`. It returns that helper’s result.

**Call relations**: This top-level test is a thin wrapper around the generic fixture-generation assertion helper.

*Call graph*: calls 1 internal fn (assert_schema_fixtures_match_generated).


##### `assert_schema_fixtures_match_generated`  (lines 30–51)

```
fn assert_schema_fixtures_match_generated(
    label: &'static str,
    generate: impl FnOnce(&Path) -> Result<()>,
) -> Result<()>
```

**Purpose**: Generates one labeled schema subtree into a temporary directory and compares it against the vendored fixture subtree under the repository schema root.

**Data flow**: Resolves the schema root, reads the vendored subtree for `label`, creates a temporary directory, generates fresh schema files into `temp_dir/label` via the supplied closure, reads the generated subtree back, and compares the two trees with `assert_schema_trees_match`. It returns `Ok(())` if they match.

**Call relations**: The JSON test uses this helper to exercise the actual on-disk generator path while reusing the common tree comparison logic.

*Call graph*: calls 3 internal fn (assert_schema_trees_match, read_tree, schema_root); called by 1 (json_schema_fixtures_match_generated); 1 external calls (tempdir).


##### `assert_schema_trees_match`  (lines 53–105)

```
fn assert_schema_trees_match(
    label: &str,
    fixture_tree: &BTreeMap<PathBuf, Vec<u8>>,
    generated_tree: &BTreeMap<PathBuf, Vec<u8>>,
) -> Result<()>
```

**Purpose**: Compares two schema fixture trees first by relative file set and then by per-file contents, producing unified diffs on failure.

**Data flow**: Takes two `BTreeMap<PathBuf, Vec<u8>>` trees, derives ordered display-string path lists from their keys, and if those differ, computes a line diff and panics. Otherwise it iterates each fixture file, fetches the generated bytes by path, skips exact matches, and for mismatches decodes both sides lossily to UTF-8, computes a unified diff, and panics with a file-specific message. It returns `Ok(())` only when every path and file matches.

**Call relations**: Both top-level tests and the generic generation helper funnel through this function, making it the central assertion engine for schema fixture drift.

*Call graph*: called by 2 (assert_schema_fixtures_match_generated, typescript_schema_fixtures_match_generated); 3 external calls (from_utf8_lossy, from_lines, panic!).


##### `schema_root`  (lines 107–134)

```
fn schema_root() -> Result<PathBuf>
```

**Purpose**: Finds the repository schema root by resolving known fixture files through Bazel/cargo resource lookup and walking up from those files.

**Data flow**: Uses `find_resource!` to locate `schema/typescript/index.ts`, derives its grandparent as `schema_root`, then resolves the JSON schema bundle and derives its grandparent as `json_root`. It asserts the two roots are equal and returns the shared `PathBuf`.

**Call relations**: Both test flows call this before reading fixtures so they can work reliably in environments where directory resolution is unreliable.

*Call graph*: called by 2 (assert_schema_fixtures_match_generated, typescript_schema_fixtures_match_generated); 2 external calls (ensure!, find_resource!).


##### `read_tree`  (lines 136–143)

```
fn read_tree(root: &Path, label: &str) -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: Reads one labeled schema subtree from a root path and adds contextual error text naming the subtree and root.

**Data flow**: Accepts `root` and `label`, calls `read_schema_fixture_subtree`, and wraps any error with a formatted message including the root path. It returns the resulting `BTreeMap` on success.

**Call relations**: This helper is used by both top-level tests and the generic generation assertion helper to keep subtree reads consistent and well-contextualized.

*Call graph*: called by 2 (assert_schema_fixtures_match_generated, typescript_schema_fixtures_match_generated); 1 external calls (read_schema_fixture_subtree).
