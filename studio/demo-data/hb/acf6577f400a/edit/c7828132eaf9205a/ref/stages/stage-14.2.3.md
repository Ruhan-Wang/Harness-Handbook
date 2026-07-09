# Patch application engine and patch-execution adapters  `stage-14.2.3`

This stage is the system’s “edit installer.” It takes a text patch — a recipe that says which lines to add, remove, or change — checks that it is well formed and safe, and then carries it out through the normal tool and approval machinery. It sits in the main work path when the system needs to change files.

The apply-patch library does the core job. Its parser and streaming parser read patch text, even as it arrives piece by piece, and turn it into structured change blocks. The invocation code also understands command-style forms, including shell wrappers, and checks them against the current files. The library then computes the replacements, updates the filesystem, produces diff output, and keeps track of what succeeded if a later step fails.

Around that engine are adapters. The tool spec describes what the apply_patch command is allowed to look like. The tool handler parses requests, verifies them, derives permissions, emits progress updates, and prepares hook data. The bridge in core decides whether to reject, auto-convert into lower-level file edits, or send the request to runtime, possibly needing approval. The runtime adapter finally executes the vetted operation inside the sandbox. A git helper offers an alternate path using git apply for unified diffs.

## Files in this stage

### Tool interface and orchestration
These files define the external apply_patch tool surface and orchestrate a request from freeform input through validation, delegation, and progress reporting.

### `core/src/tools/handlers/apply_patch_spec.rs`

`config` · `tool registration and schema advertisement`

This file contains the model-facing specification for `apply_patch`. Rather than a JSON function schema, it exposes a `ToolSpec::Freeform` whose format is a Lark grammar loaded from the adjacent `apply_patch.lark` file at compile time via `include_str!`. The single factory function, `create_apply_patch_freeform_tool`, optionally rewrites the grammar's `start` rule when multi-environment support is enabled: it inserts an optional `environment_id` production and defines that production as a line beginning with `*** Environment ID: ` followed by a filename token and newline.

The returned `FreeformTool` always uses the same tool name and description, explicitly telling models not to wrap the patch in JSON. Its `FreeformToolFormat` fixes `type` to `grammar`, `syntax` to `lark`, and supplies the chosen grammar definition string. This design keeps the runtime parser and the model-visible syntax tightly aligned while allowing a small, targeted grammar variation based on turn capabilities.

#### Function details

##### `create_apply_patch_freeform_tool`  (lines 9–27)

```
fn create_apply_patch_freeform_tool(include_environment_id: bool) -> ToolSpec
```

**Purpose**: Builds the freeform tool specification for `apply_patch`, optionally extending the grammar to accept an environment-id header.

**Data flow**: It takes `include_environment_id: bool`, chooses either the raw embedded grammar or a modified version with an inserted `environment_id` rule, then returns `ToolSpec::Freeform(FreeformTool { ... })` containing the fixed name/description and a `FreeformToolFormat` with the selected grammar definition.

**Call relations**: Called by `ApplyPatchHandler::spec` so the runtime advertises syntax that matches whether multi-environment patch targeting is enabled.

*Call graph*: called by 1 (spec); 1 external calls (Freeform).


### `core/src/tools/handlers/apply_patch.rs`

`orchestration` · `tool invocation, patch verification, approval/runtime execution, and streaming progress`

This file is the main execution engine for patch application. `ApplyPatchHandler` exposes the tool under the freeform name `apply_patch`, optionally allowing explicit environment selection. Its `handle_call` path accepts only `ToolPayload::Custom`, parses the raw patch text with `codex_apply_patch`, optionally validates an embedded environment id, resolves the target `TurnEnvironment`, converts its cwd to a host-native `AbsolutePathBuf`, and verifies the patch against the selected filesystem plus sandbox context. Once verified, it computes affected absolute paths and any extra write permissions needed outside the current sandbox using `effective_patch_permissions`, which merges granted session/turn permissions with the turn’s base filesystem policy.

Execution then splits in two. If `apply_patch::apply_patch` returns `InternalApplyPatchInvocation::Output`, the patch can be completed immediately and the textual result is returned. If it returns `DelegateToRuntime`, the file converts changes into protocol `FileChange` values, emits begin/finish events through `ToolEmitter`, constructs an `ApplyPatchRequest`, and runs `ApplyPatchRuntime` through `ToolOrchestrator`, preserving committed deltas even on failure. The same core flow is reused by `intercept_apply_patch` for exec-like command interception.

The file also defines `ApplyPatchArgumentDiffConsumer`, which incrementally parses streamed patch text with `StreamingPatchParser` and emits throttled `PatchApplyUpdatedEvent`s every 500ms at most, buffering the latest pending event until completion. Helper functions convert parsed hunks into protocol changes, format update hunks as unified-diff-like progress text, collect both source and move-destination paths for approval accounting, and synthesize hook payloads before and after tool use. Important constraints are enforced explicitly: unsupported payload kinds, malformed/non-apply_patch input, unavailable environment selection, and host-incompatible cwd projections all become model-visible errors.

#### Function details

##### `ApplyPatchHandler::new`  (lines 66–68)

```
fn new(multi_environment: bool) -> Self
```

**Purpose**: Constructs an `ApplyPatchHandler` configured for either single-environment or multi-environment turns.

**Data flow**: It takes a `bool` flag, stores it in the handler's `multi_environment` field, and returns the new struct. No external state is read or mutated.

**Call relations**: Called by higher-level tool registration code such as `add_core_utility_tools` to choose whether environment ids may appear in patch input.

*Call graph*: called by 1 (add_core_utility_tools).


##### `ApplyPatchArgumentDiffConsumer::consume_diff`  (lines 79–91)

```
fn consume_diff(
        &mut self,
        turn: &TurnContext,
        call_id: String,
        diff: &str,
    ) -> Option<EventMsg>
```

**Purpose**: Consumes a streamed patch-text delta and, when the feature flag is enabled, converts it into an optional patch-progress event.

**Data flow**: It reads the turn's feature set, the `call_id`, and the incoming diff chunk. If `Feature::ApplyPatchStreamingEvents` is disabled it returns `None`; otherwise it forwards the chunk to `push_delta` and wraps any resulting `PatchApplyUpdatedEvent` as `EventMsg::PatchApplyUpdated`.

**Call relations**: Invoked by the tool framework while arguments stream in. It delegates parsing/throttling to `push_delta` and suppresses all output when the feature gate is off.

*Call graph*: calls 1 internal fn (push_delta).


##### `ApplyPatchArgumentDiffConsumer::finish`  (lines 93–96)

```
fn finish(&mut self) -> Result<Option<EventMsg>, FunctionCallError>
```

**Purpose**: Finalizes streamed patch parsing and emits any buffered final progress event.

**Data flow**: It consumes no new diff text; instead it asks `finish_update_on_complete` to close the parser, then maps any returned patch event into `EventMsg::PatchApplyUpdated`. Parse-finalization errors become `FunctionCallError` values.

**Call relations**: Called by the framework after argument streaming ends. It is the terminal counterpart to `consume_diff`.

*Call graph*: calls 1 internal fn (finish_update_on_complete).


##### `ApplyPatchArgumentDiffConsumer::push_delta`  (lines 100–121)

```
fn push_delta(&mut self, call_id: String, delta: &str) -> Option<PatchApplyUpdatedEvent>
```

**Purpose**: Feeds incremental patch text into the streaming parser, converts newly recognized hunks into protocol changes, and rate-limits emitted updates.

**Data flow**: It takes a `call_id` and raw patch-text `delta`, pushes the delta into `self.parser`, ignores parser errors and empty hunk batches by returning `None`, converts parsed hunks into a `HashMap<PathBuf, FileChange>`, and builds a `PatchApplyUpdatedEvent`. It reads and updates `self.last_sent_at` and `self.pending`: if the last send was within the 500ms buffer interval it stores the newest event in `pending`; otherwise it clears pending, records the current time, and returns the event immediately.

**Call relations**: Used by `consume_diff` for each streamed chunk. It depends on `convert_apply_patch_hunks_to_protocol` to translate parser output into UI/protocol-facing change summaries.

*Call graph*: calls 2 internal fn (push_delta, convert_apply_patch_hunks_to_protocol); called by 1 (consume_diff); 1 external calls (now).


##### `ApplyPatchArgumentDiffConsumer::finish_update_on_complete`  (lines 123–135)

```
fn finish_update_on_complete(
        &mut self,
    ) -> Result<Option<PatchApplyUpdatedEvent>, FunctionCallError>
```

**Purpose**: Completes the streaming parser, surfaces parse errors, and flushes the last buffered patch-progress event if one exists.

**Data flow**: It calls `self.parser.finish()`, mapping parser failures into `RespondToModel` errors. Then it takes `self.pending`, updates `self.last_sent_at` if an event was flushed, and returns `Ok(Some(event))` or `Ok(None)`.

**Call relations**: Called only by `finish`. It ensures buffered updates are not lost when the final chunk arrived inside the throttling window.

*Call graph*: calls 1 internal fn (finish); called by 1 (finish); 1 external calls (now).


##### `convert_apply_patch_hunks_to_protocol`  (lines 138–160)

```
fn convert_apply_patch_hunks_to_protocol(hunks: &[Hunk]) -> HashMap<PathBuf, FileChange>
```

**Purpose**: Transforms parsed patch hunks into protocol-level file-change summaries keyed by source path.

**Data flow**: It iterates over a slice of `Hunk`, derives each hunk's source path, maps add/delete/update variants into `FileChange::Add`, `FileChange::Delete`, or `FileChange::Update`, and collects the pairs into a `HashMap<PathBuf, FileChange>`. Update hunks use formatted chunk text and preserve any move destination.

**Call relations**: Called by `ApplyPatchArgumentDiffConsumer::push_delta` to turn parser output into event payloads suitable for clients.

*Call graph*: called by 1 (push_delta); 1 external calls (iter).


##### `hunk_source_path`  (lines 162–168)

```
fn hunk_source_path(hunk: &Hunk) -> &Path
```

**Purpose**: Returns the primary path associated with any parsed patch hunk variant.

**Data flow**: It pattern-matches a `Hunk` and returns a borrowed `&Path` from the variant's `path` field. It performs no allocation or mutation.

**Call relations**: Used by `convert_apply_patch_hunks_to_protocol` to normalize path extraction across add, delete, and update hunks.


##### `format_update_chunks_for_progress`  (lines 170–200)

```
fn format_update_chunks_for_progress(chunks: &[codex_apply_patch::UpdateFileChunk]) -> String
```

**Purpose**: Renders update-file chunks into a compact unified-diff-like string for progress reporting.

**Data flow**: It takes a slice of `UpdateFileChunk`, appends chunk headers (`@@` plus optional context), prefixes old lines with `-`, new lines with `+`, appends newlines throughout, and emits `*** End of File` markers when `is_end_of_file` is set. The return value is the accumulated `String`.

**Call relations**: Called from `convert_apply_patch_hunks_to_protocol` when building `FileChange::Update` progress payloads.

*Call graph*: 1 external calls (new).


##### `file_paths_for_action`  (lines 202–220)

```
fn file_paths_for_action(action: &ApplyPatchAction) -> Vec<AbsolutePathBuf>
```

**Purpose**: Collects all absolute filesystem paths touched by a verified patch action, including rename destinations.

**Data flow**: It reads the action's cwd and iterates over `action.changes()`. For each changed path it resolves the source path against cwd and pushes it into a vector; for update changes with `move_path`, it also resolves and includes the destination path. It returns the accumulated `Vec<AbsolutePathBuf>`.

**Call relations**: Called by `effective_patch_permissions` to determine which paths need approval and permission accounting.

*Call graph*: calls 2 internal fn (changes, to_abs_path); called by 1 (effective_patch_permissions); 1 external calls (new).


##### `to_abs_path`  (lines 222–224)

```
fn to_abs_path(cwd: &AbsolutePathBuf, path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves a patch-relative path against the action cwd into an absolute path wrapper.

**Data flow**: It takes the cwd and a `&Path`, calls `AbsolutePathBuf::resolve_path_against_base`, wraps the result in `Some`, and returns it.

**Call relations**: A tiny helper used by `file_paths_for_action` for both source and move-destination path resolution.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 1 (file_paths_for_action).


##### `write_permissions_for_paths`  (lines 226–256)

```
fn write_permissions_for_paths(
    file_paths: &[AbsolutePathBuf],
    file_system_sandbox_policy: &codex_protocol::permissions::FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> Option<Additi
```

**Purpose**: Computes an additional-permissions profile granting write access only for touched directories that are not already writable under the current sandbox policy.

**Data flow**: It takes affected absolute file paths, the effective filesystem sandbox policy, and cwd. It maps each file to its parent directory (or itself if parentless), filters out directories already writable according to `can_write_path_with_cwd`, deduplicates them with `BTreeSet`, converts them into protocol path values, and if any remain builds an `AdditionalPermissionProfile` with `FileSystemPermissions::from_read_write_roots`. The profile is normalized and returned as `Some`; if no extra writes are needed or conversion fails, it returns `None`.

**Call relations**: Called by `effective_patch_permissions` after path collection. Its output feeds `apply_granted_turn_permissions` so runtime execution can request only the missing write roots.

*Call graph*: calls 2 internal fn (from_read_write_roots, normalize_additional_permissions); called by 1 (effective_patch_permissions); 3 external calls (default, iter, vec!).


##### `apply_patch_payload_command`  (lines 259–264)

```
fn apply_patch_payload_command(payload: &ToolPayload) -> Option<String>
```

**Purpose**: Extracts the raw freeform patch text from a tool payload for hook integration.

**Data flow**: It pattern-matches `ToolPayload`; for `Custom { input }` it clones and returns the input string, otherwise it returns `None`.

**Call relations**: Used by `pre_tool_use_payload` and indirectly by post-tool hook generation to preserve the exact patch command text.

*Call graph*: called by 1 (pre_tool_use_payload).


##### `effective_patch_permissions`  (lines 266–307)

```
async fn effective_patch_permissions(
    session: &Session,
    turn: &TurnContext,
    environment_id: &str,
    action: &ApplyPatchAction,
    cwd: &AbsolutePathBuf,
) -> (
    Vec<AbsolutePathBuf>
```

**Purpose**: Derives the touched paths, merged effective permissions, and resulting filesystem sandbox policy for a verified patch in a specific environment.

**Data flow**: Inputs are the session, turn, environment id, verified `ApplyPatchAction`, and cwd. It computes touched file paths, asynchronously reads granted session and turn permissions for the environment, merges them, derives the effective filesystem sandbox policy from the turn base policy plus grants, computes any extra write permissions needed for the touched paths, and passes those through `apply_granted_turn_permissions`. It returns a tuple of `(file_paths, effective_additional_permissions, file_system_sandbox_policy)`.

**Call relations**: Called by both `ApplyPatchHandler::handle_call` and `intercept_apply_patch` before actual patch execution. It is the shared permission-accounting step for direct tool calls and intercepted shell commands.

*Call graph*: calls 7 internal fn (file_system_sandbox_policy, apply_granted_turn_permissions, file_paths_for_action, write_permissions_for_paths, effective_file_system_sandbox_policy, merge_permission_profiles, as_path); called by 2 (handle_call, intercept_apply_patch); 2 external calls (granted_session_permissions, granted_turn_permissions).


##### `ApplyPatchHandler::tool_name`  (lines 310–312)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the registered plain tool name `apply_patch`.

**Data flow**: It constructs and returns a `ToolName` from a fixed string literal, with no side effects.

**Call relations**: Queried by the tool registry so this executor can be exposed under the correct name.

*Call graph*: calls 1 internal fn (plain).


##### `ApplyPatchHandler::spec`  (lines 314–316)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the freeform grammar-based tool specification for patch input, optionally including environment-id syntax.

**Data flow**: It reads `self.multi_environment`, passes that flag into the spec factory, and returns the resulting `ToolSpec`.

**Call relations**: Called during tool registration/introspection; it delegates schema construction to `create_apply_patch_freeform_tool`.

*Call graph*: calls 1 internal fn (create_apply_patch_freeform_tool).


##### `ApplyPatchHandler::handle`  (lines 318–320)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the executor trait to the async patch-handling implementation by boxing the future from `handle_call`.

**Data flow**: It consumes a `ToolInvocation`, creates a pinned boxed future around `self.handle_call(invocation)`, and returns it.

**Call relations**: This is the trait entrypoint invoked by the tool framework; all substantive work is delegated to `ApplyPatchHandler::handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ApplyPatchHandler::handle_call`  (lines 324–472)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Parses, verifies, authorizes, and executes a freeform patch tool invocation, either inline or through the apply-patch runtime/orchestrator.

**Data flow**: From `ToolInvocation` it reads session, turn, diff tracker, call id, tool name, and payload. It requires `ToolPayload::Custom`, parses the patch text, validates optional environment selection, resolves the target environment and cwd, verifies the patch against the filesystem and sandbox, computes effective permissions, and then either returns immediate textual output from `apply_patch::apply_patch` or constructs protocol changes, emits begin/finish events, runs `ApplyPatchRuntime` via `ToolOrchestrator`, and wraps the final text in `ApplyPatchToolOutput` and `boxed_tool_output`. It writes externally through filesystem patch application, event emission, and possibly approval/runtime side effects.

**Call relations**: Called by `ApplyPatchHandler::handle`. It is the main direct-tool execution path and shares permission logic with `intercept_apply_patch`; on the delegated branch it coordinates `ToolEmitter`, `ToolEventCtx`, `ApplyPatchRequest`, `ToolOrchestrator`, and `ApplyPatchRuntime`.

*Call graph*: calls 11 internal fn (apply_patch, convert_apply_patch_to_protocol, from_text, boxed_tool_output, apply_patch_for_environment, new, effective_patch_permissions, require_environment_id, resolve_tool_environment, new (+1 more)); called by 1 (handle); 5 external calls (parse_patch, verify_apply_patch_args, format!, RespondToModel, trace!).


##### `ApplyPatchHandler::matches_kind`  (lines 476–478)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Declares that this runtime accepts only custom/freeform payloads.

**Data flow**: It inspects the provided `ToolPayload` and returns `true` only for `ToolPayload::Custom { .. }`.

**Call relations**: Used by the core runtime before dispatch so JSON function payloads are rejected before reaching patch parsing.

*Call graph*: 1 external calls (matches!).


##### `ApplyPatchHandler::create_diff_consumer`  (lines 480–482)

```
fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Provides a streaming argument consumer that can parse partial patch text into progress events.

**Data flow**: It allocates a default `ApplyPatchArgumentDiffConsumer`, boxes it as a `dyn ToolArgumentDiffConsumer`, and returns it inside `Some`.

**Call relations**: The tool framework calls this when it wants incremental argument-diff handling for `apply_patch`; the returned consumer drives `PatchApplyUpdated` events.

*Call graph*: 1 external calls (default).


##### `ApplyPatchHandler::pre_tool_use_payload`  (lines 484–489)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Builds the hook payload sent before tool execution, preserving the raw patch text as a command-shaped input.

**Data flow**: It reads `invocation.payload`, extracts the patch string with `apply_patch_payload_command`, and if present returns `PreToolUsePayload` containing `HookToolName::apply_patch()` and JSON `{ "command": <patch> }`.

**Call relations**: Invoked by hook infrastructure before execution. It depends on `apply_patch_payload_command` to ignore unsupported payload kinds.

*Call graph*: calls 1 internal fn (apply_patch_payload_command).


##### `ApplyPatchHandler::with_updated_hook_input`  (lines 491–504)

```
fn with_updated_hook_input(
        &self,
        mut invocation: ToolInvocation,
        updated_input: serde_json::Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Applies hook-modified command input back onto a tool invocation by replacing the freeform patch payload.

**Data flow**: It takes a mutable `ToolInvocation` and a JSON value, extracts the updated patch string via `updated_hook_command`, and if the invocation currently has `ToolPayload::Custom` replaces its `input` with the new patch text. It returns the updated invocation or a `FunctionCallError` if the hook payload is invalid.

**Call relations**: Used in the hook round-trip after pre-tool hooks have had a chance to rewrite the patch command.

*Call graph*: calls 1 internal fn (updated_hook_command).


##### `ApplyPatchHandler::post_tool_use_payload`  (lines 506–521)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the hook payload emitted after tool execution, pairing the original patch command with the tool's serialized response.

**Data flow**: It reads the invocation call id and payload plus the `ToolOutput`, asks the output for a post-tool-use response, re-extracts the patch command, and returns a `PostToolUsePayload` containing hook name, tool-use id, JSON command input, and the response payload.

**Call relations**: Called by hook infrastructure after execution. It complements `pre_tool_use_payload` and depends on the output object supporting `post_tool_use_response` for this invocation.

*Call graph*: calls 2 internal fn (apply_patch, post_tool_use_response); 1 external calls (json!).


##### `intercept_apply_patch`  (lines 525–630)

```
async fn intercept_apply_patch(
    command: &[String],
    cwd: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
    turn_environment: TurnEnvironment,
    session: Arc<Session>,
    turn: Arc<Turn
```

**Purpose**: Detects and executes `apply_patch` commands embedded in exec-like command arrays, reusing the same verification, permission, and runtime logic as the direct tool handler.

**Data flow**: Inputs are a command argv slice, cwd, filesystem, target environment, session/turn context, optional diff tracker, call id, and tool name. It verifies whether the argv represents a valid apply_patch command under the current sandbox; if not parseable as apply_patch it returns `Ok(None)`. For verified patches it computes effective permissions, executes inline or delegates through `ApplyPatchRuntime` and `ToolOrchestrator`, emits begin/finish events, and returns `Ok(Some(FunctionToolOutput))`. Correctness errors become `RespondToModel` failures.

**Call relations**: Called by exec-like command handling (`run_exec_like`) and also referenced from the direct handler path. It is the interception counterpart to `ApplyPatchHandler::handle_call`, sharing the same delegated runtime flow.

*Call graph*: calls 10 internal fn (apply_patch, convert_apply_patch_to_protocol, from_text, apply_patch_for_environment, new, effective_patch_permissions, new, new, plain, from_abs_path); called by 2 (run_exec_like, handle_call); 4 external calls (maybe_parse_apply_patch_verified, format!, RespondToModel, trace!).


##### `require_environment_id`  (lines 632–643)

```
fn require_environment_id(
    parsed_environment_id: Option<&str>,
    allow_environment_id: bool,
) -> Result<Option<String>, FunctionCallError>
```

**Purpose**: Validates whether an environment id parsed from patch input is allowed in the current turn configuration.

**Data flow**: It takes an optional parsed environment id and a boolean `allow_environment_id`. If an id is present while selection is disallowed, it returns a `RespondToModel` error; otherwise it returns `Ok(Some(id.to_string()))` or `Ok(None)`.

**Call relations**: Called by `ApplyPatchHandler::handle_call` before environment resolution. It isolates the policy check that gates multi-environment patch targeting.

*Call graph*: called by 1 (handle_call); 1 external calls (RespondToModel).


### `core/src/apply_patch.rs`

`domain_logic` · `tool-call interception and runtime delegation`

This module wraps patch application in the same approval model used by other tools. `InternalApplyPatchInvocation` distinguishes two execution modes: `Output`, used when the call should terminate immediately with a `FunctionCallError`, and `DelegateToRuntime`, used when the runtime should realize the patch through the selected environment filesystem. The delegated form carries an `ApplyPatchRuntimeInvocation` containing the original `ApplyPatchAction`, whether the approval was automatic, and the `ExecApprovalRequirement` the runtime should enforce.

`apply_patch` is the policy gate. It calls `assess_patch_safety` with the patch action, the current turn’s approval policy, permission profile, filesystem sandbox policy, patch cwd, and Windows sandbox level. If the result is `SafetyCheck::AutoApprove`, it delegates to runtime with `ExecApprovalRequirement::Skip` and marks `auto_approved` as the inverse of `user_explicitly_approved`, preserving whether the user had already approved the action. If the result is `AskUser`, it still delegates, but with `ExecApprovalRequirement::NeedsApproval` so the runtime can handle prompting and cached approvals consistently with shell execution. If the result is `Reject`, it returns `Output(Err(FunctionCallError::RespondToModel(...)))` with a concrete `patch rejected: ...` message.

`convert_apply_patch_to_protocol` is a pure adapter that walks `ApplyPatchAction::changes()` and converts each `ApplyPatchFileChange` into the protocol `FileChange` enum, preserving add/delete contents and update diffs plus optional move paths while keying the result by owned `PathBuf`.

#### Function details

##### `apply_patch`  (lines 33–74)

```
async fn apply_patch(
    turn_context: &TurnContext,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    action: ApplyPatchAction,
) -> InternalApplyPatchInvocation
```

**Purpose**: Evaluates an `ApplyPatchAction` against the current turn’s approval and sandbox policy and decides whether to reject it immediately or hand it to the runtime with the correct approval requirement.

**Data flow**: Takes `&TurnContext`, `&FileSystemSandboxPolicy`, and an owned `ApplyPatchAction`. It reads approval policy, permission profile, action cwd, and Windows sandbox level, passes them to `assess_patch_safety`, then maps `SafetyCheck::AutoApprove` to `InternalApplyPatchInvocation::DelegateToRuntime` with `ExecApprovalRequirement::Skip`, `SafetyCheck::AskUser` to `DelegateToRuntime` with `NeedsApproval`, and `SafetyCheck::Reject { reason }` to `Output(Err(FunctionCallError::RespondToModel(format!("patch rejected: {reason}"))))`.

**Call relations**: Tool-call handlers invoke this when they detect an `apply_patch` request. It delegates all policy analysis to `assess_patch_safety` and leaves actual patch execution to the runtime when delegation is chosen.

*Call graph*: calls 2 internal fn (assess_patch_safety, permission_profile); called by 2 (handle_call, intercept_apply_patch); 4 external calls (DelegateToRuntime, Output, format!, RespondToModel).


##### `convert_apply_patch_to_protocol`  (lines 76–100)

```
fn convert_apply_patch_to_protocol(
    action: &ApplyPatchAction,
) -> HashMap<PathBuf, FileChange>
```

**Purpose**: Converts an internal `ApplyPatchAction` into the protocol-level `HashMap<PathBuf, FileChange>` representation used by downstream runtime or reporting code.

**Data flow**: Reads `action.changes()`, preallocates a `HashMap` sized to the number of changes, matches each `ApplyPatchFileChange`, clones the relevant content/diff/move-path fields into the corresponding `FileChange::{Add,Delete,Update}` variant, inserts each under `path.to_path_buf()`, and returns the completed map.

**Call relations**: Callers use this after deciding to process or delegate a patch so they can expose the patch in the protocol’s file-change schema.

*Call graph*: calls 1 internal fn (changes); called by 2 (handle_call, intercept_apply_patch); 1 external calls (with_capacity).


### `core/src/tools/runtimes/apply_patch.rs`

`domain_logic` · `request handling`

This file defines the concrete runtime for the `apply_patch` tool and the request/output types that surround it. `ApplyPatchRequest` packages everything needed to execute a patch: the selected `TurnEnvironment`, the `ApplyPatchAction` containing patch text and cwd, the absolute file list used for approval caching, a `changes` map used when prompting for approval, and approval-policy fields such as `ExecApprovalRequirement`, optional `AdditionalPermissionProfile`, and a `permissions_preapproved` shortcut. `ApplyPatchRuntime` itself is stateful only in one place: it accumulates an `AppliedPatchDelta` in `committed_delta`, appending each run’s delta so callers can inspect the total set of committed edits across retries/escalations.

The runtime participates in two framework traits. As `Sandboxable`, it prefers automatic sandboxing and explicitly allows escalation after failure. As `Approvable`, it overrides the normal exec-approval path because patch approval is decided upstream by patch-safety assessment; it derives cache keys from `(environment_id, path)`, can route approval through Guardian review when a review id is present, honors preapproved permissions only on the first attempt, and otherwise requests patch approval from the session, optionally through `with_cached_approval`. For execution, `run` builds a `FileSystemSandboxContext` from the active `SandboxAttempt`, invokes `codex_apply_patch::apply_patch` against the turn environment filesystem, captures stdout/stderr bytes into strings, converts success/failure into an `ExecToolCallOutput`, appends the returned or partial delta, and upgrades likely sandbox-denial failures into a structured `SandboxErr::Denied`. A notable invariant is that even failed patch attempts may contribute a delta via `failure.into_parts().1`, preserving partial filesystem effects for downstream accounting.

#### Function details

##### `ApplyPatchRuntime::new`  (lines 69–71)

```
fn new() -> Self
```

**Purpose**: Constructs a fresh runtime with no accumulated patch delta. It is the standard entry for creating the stateful executor instance used by the orchestrator or tests.

**Data flow**: Takes no arguments beyond the implicit type context, delegates to `Default` for `ApplyPatchRuntime`, and returns a value whose `committed_delta` starts empty. It does not read or write external state.

**Call relations**: Called by higher-level tool dispatch such as `handle_call` and `intercept_apply_patch`, and by tests that verify approval, sandbox cwd, and permission payload behavior. It does not orchestrate anything itself beyond creating the runtime object later consumed by approval and execution flows.

*Call graph*: called by 6 (handle_call, intercept_apply_patch, approval_keys_include_environment_id, permission_request_payload_uses_apply_patch_hook_name_and_aliases, sandbox_cwd_uses_patch_action_cwd, wants_no_sandbox_approval_granular_respects_sandbox_flag); 1 external calls (default).


##### `ApplyPatchRuntime::committed_delta`  (lines 73–75)

```
fn committed_delta(&self) -> &AppliedPatchDelta
```

**Purpose**: Exposes the runtime’s accumulated `AppliedPatchDelta` as a shared reference. This lets callers inspect all patch effects recorded so far without cloning.

**Data flow**: Reads `self.committed_delta` and returns `&AppliedPatchDelta`. It performs no transformation and does not mutate runtime state.

**Call relations**: Used as an accessor after one or more runs to observe the runtime’s persistent delta state. It is a leaf helper around the state that `run` updates.


##### `ApplyPatchRuntime::build_guardian_review_request`  (lines 77–87)

```
fn build_guardian_review_request(
        req: &ApplyPatchRequest,
        call_id: &str,
    ) -> GuardianApprovalRequest
```

**Purpose**: Builds the patch-specific `GuardianApprovalRequest` payload sent when approval is delegated to Guardian review. The request includes the call id, cwd, touched files, and raw patch text so the reviewer sees full patch context.

**Data flow**: Consumes `req` and `call_id` by reading `req.action.cwd`, `req.file_paths`, and `req.action.patch`, cloning those values into a `GuardianApprovalRequest::ApplyPatch` with `id` set from `call_id`. It returns the assembled enum value and writes no state.

**Call relations**: Invoked from `start_approval_async` only when the approval context already carries a `guardian_review_id`, meaning approval should be resolved through the Guardian review path instead of the normal session patch-approval prompt. Tests also call it to verify the review payload contains the expected patch context.

*Call graph*: called by 2 (start_approval_async, guardian_review_request_includes_patch_context).


##### `ApplyPatchRuntime::file_system_sandbox_context_for_attempt`  (lines 89–106)

```
fn file_system_sandbox_context_for_attempt(
        req: &ApplyPatchRequest,
        attempt: &SandboxAttempt<'_>,
    ) -> Option<FileSystemSandboxContext>
```

**Purpose**: Translates the current generic `SandboxAttempt` plus request-specific extra permissions into the concrete filesystem sandbox context expected by the patch executor. It suppresses sandbox context entirely when the attempt explicitly runs with `SandboxType::None`.

**Data flow**: Reads `attempt.sandbox` and returns `None` immediately for unsandboxed execution. Otherwise it combines `attempt.permissions` with `req.additional_permissions` via `effective_permission_profile`, then constructs and returns `Some(FileSystemSandboxContext)` carrying the effective permissions, the attempt’s sandbox cwd, and Windows/landlock flags copied from the attempt.

**Call relations**: Used by `run` to derive the exact filesystem restrictions passed into `codex_apply_patch::apply_patch`. Tests exercise it to confirm the active attempt, not some static request property, determines the sandbox context.

*Call graph*: calls 1 internal fn (effective_permission_profile); called by 1 (file_system_sandbox_context_uses_active_attempt).


##### `ApplyPatchRuntime::sandbox_preference`  (lines 110–112)

```
fn sandbox_preference(&self) -> SandboxablePreference
```

**Purpose**: Declares that this runtime prefers automatic sandbox selection by the framework. It does not force a specific sandbox mode itself.

**Data flow**: Reads no inputs other than `self` and returns the constant `SandboxablePreference::Auto`. It has no side effects.

**Call relations**: Consumed by the generic sandboxing/orchestration layer when deciding how to execute the tool. It is part of the runtime’s trait contract rather than local control flow.


##### `ApplyPatchRuntime::escalate_on_failure`  (lines 113–115)

```
fn escalate_on_failure(&self) -> bool
```

**Purpose**: Signals that a failed sandboxed patch attempt should be eligible for escalation and retry. This is important because patch application may fail solely due to sandbox restrictions.

**Data flow**: Returns the constant boolean `true` and does not inspect or mutate any state.

**Call relations**: Read by the surrounding sandbox orchestration logic after failures to decide whether to attempt a less restrictive execution path. It complements `run`, which specifically classifies likely sandbox denials.


##### `ApplyPatchRuntime::approval_keys`  (lines 121–130)

```
fn approval_keys(&self, req: &ApplyPatchRequest) -> Vec<Self::ApprovalKey>
```

**Purpose**: Computes the cache keys used to reuse prior patch approvals on a per-environment, per-file basis. Including `environment_id` prevents approvals from leaking across different turn environments even for the same path.

**Data flow**: Reads `req.turn_environment.environment_id` and iterates over `req.file_paths`, cloning each absolute path into an `ApplyPatchApprovalKey { environment_id, path }`. It returns a `Vec<ApplyPatchApprovalKey>` and does not mutate runtime state.

**Call relations**: Called by `start_approval_async` before entering the cached-approval path. Its output feeds `with_cached_approval`, which decides whether the user must be prompted again for the same environment/file combination.

*Call graph*: called by 1 (start_approval_async).


##### `ApplyPatchRuntime::start_approval_async`  (lines 132–181)

```
fn start_approval_async(
        &'a mut self,
        req: &'a ApplyPatchRequest,
        ctx: ApprovalCtx<'a>,
    ) -> BoxFuture<'a, ReviewDecision>
```

**Purpose**: Implements the full asynchronous approval decision tree for patch execution, including Guardian review, preapproved permissions, retry prompts with reasons, and cached patch approval requests. It is the patch-specific override that ensures the orchestrator uses patch approval semantics instead of generic exec approval.

**Data flow**: Reads the request, approval context, session, turn, call id, retry reason, optional guardian review id, and cloned `changes`. It first computes approval keys from `approval_keys`; if a Guardian review id exists, it builds a `GuardianApprovalRequest` with `build_guardian_review_request` and awaits `review_approval_request`. Otherwise, if `permissions_preapproved` is true and there is no retry reason, it returns `ReviewDecision::Approved` immediately. If there is a retry reason, it asks the session for patch approval with that reason and awaits the returned receiver, defaulting on channel failure. In the normal first-attempt path, it wraps the same session approval request in `with_cached_approval` keyed as `apply_patch`, returning the resulting `ReviewDecision`.

**Call relations**: Invoked by the generic approval framework whenever this tool needs an approval decision before execution or escalation. Depending on context, it delegates either to Guardian review or to `session.request_patch_approval`, and uses `with_cached_approval` only for the non-retry, non-Guardian path so repeated approvals can be skipped safely.

*Call graph*: calls 3 internal fn (approval_keys, build_guardian_review_request, with_cached_approval); 2 external calls (pin, review_approval_request).


##### `ApplyPatchRuntime::wants_no_sandbox_approval`  (lines 183–191)

```
fn wants_no_sandbox_approval(&self, policy: AskForApproval) -> bool
```

**Purpose**: Determines whether the runtime should ask for approval before running without a sandbox under the current `AskForApproval` policy. The logic treats most interactive or failure-based policies as requiring approval, while respecting granular sandbox-specific configuration.

**Data flow**: Consumes an `AskForApproval` enum and pattern-matches it. It returns `false` for `Never`, delegates `Granular` to `granular_config.allows_sandbox_approval()`, and returns `true` for `OnFailure`, `OnRequest`, and `UnlessTrusted`.

**Call relations**: Used by the approval/sandbox orchestration layer when deciding whether an unsandboxed retry needs explicit user approval. Tests cover the granular-policy branch to ensure sandbox flags are honored.


##### `ApplyPatchRuntime::exec_approval_requirement`  (lines 197–202)

```
fn exec_approval_requirement(
        &self,
        req: &ApplyPatchRequest,
    ) -> Option<ExecApprovalRequirement>
```

**Purpose**: Overrides the generic exec approval requirement with the patch-specific requirement already computed upstream. This prevents the orchestrator from substituting the global exec policy for a tool whose approval was assessed by patch-safety logic.

**Data flow**: Reads `req.exec_approval_requirement`, clones it, wraps it in `Some`, and returns it. It does not mutate any state.

**Call relations**: Queried by the generic approval framework before execution. Its role is to redirect approval handling back to the patch-specific path represented by `start_approval_async`.


##### `ApplyPatchRuntime::permission_request_payload`  (lines 204–212)

```
fn permission_request_payload(
        &self,
        req: &ApplyPatchRequest,
    ) -> Option<PermissionRequestPayload>
```

**Purpose**: Builds the structured permission-request payload shown when the system needs to ask for elevated permissions for this tool. It identifies the tool using the `apply_patch` hook name and includes the patch text as the command-like input.

**Data flow**: Reads `req.action.patch`, constructs a `PermissionRequestPayload` with `tool_name` set from `HookToolName::apply_patch()` and `tool_input` set to JSON `{ "command": req.action.patch }`, and returns it inside `Some`. It writes no state.

**Call relations**: Consumed by the sandbox/approval UI path when a permission prompt must describe what `apply_patch` is trying to do. Tests verify that the hook name and aliasing are correct.

*Call graph*: calls 1 internal fn (apply_patch); 1 external calls (json!).


##### `ApplyPatchRuntime::sandbox_cwd`  (lines 216–218)

```
fn sandbox_cwd(&self, req: &'a ApplyPatchRequest) -> Option<&'a AbsolutePathBuf>
```

**Purpose**: Supplies the working directory that sandbox setup should treat as the tool’s cwd. For patch application, this is exactly the cwd embedded in the `ApplyPatchAction`.

**Data flow**: Reads `req.action.cwd` and returns `Some(&AbsolutePathBuf)` referencing that path. It performs no allocation or mutation.

**Call relations**: Called by the generic tool runtime framework while preparing sandbox attempts. Tests verify that it points at the patch action’s cwd rather than some other environment path.


##### `ApplyPatchRuntime::run`  (lines 220–267)

```
async fn run(
        &mut self,
        req: &ApplyPatchRequest,
        attempt: &SandboxAttempt<'_>,
        _ctx: &ToolCtx,
    ) -> Result<ApplyPatchRuntimeOutput, ToolError>
```

**Purpose**: Executes the patch against the turn environment filesystem under the current sandbox attempt, captures textual output, records the resulting delta, and converts sandbox-denied failures into a structured tool error. It is the core operational path of the file.

**Data flow**: Reads the request’s turn environment, patch text, cwd, and optional extra permissions, plus the active `SandboxAttempt`. It records `Instant::now()`, obtains the filesystem from `req.turn_environment.environment`, derives an optional `FileSystemSandboxContext` via `file_system_sandbox_context_for_attempt`, and passes patch/cwd/output buffers/filesystem/sandbox into `codex_apply_patch::apply_patch`. After awaiting the result, it decodes stdout and stderr from collected bytes, computes `failed` and `exit_code`, extracts either the successful delta or the partial delta from the failure, and appends that delta into `self.committed_delta`. It then builds an `ExecToolCallOutput` with stdout, stderr, concatenated aggregated output, elapsed duration, and `timed_out: false`. If the run failed and `is_likely_sandbox_denied` says the output matches a sandbox denial for the current sandbox type, it returns `Err(ToolError::Codex(CodexErr::Sandbox(SandboxErr::Denied { ... })))`; otherwise it returns `Ok(ApplyPatchRuntimeOutput { exec_output, delta: self.committed_delta.clone() })`.

**Call relations**: Invoked by the generic tool execution framework after approval and sandbox selection are complete. It delegates actual patch application to `codex_apply_patch::apply_patch`, uses `file_system_sandbox_context_for_attempt` to align execution with the chosen attempt, and feeds failure classification back into the orchestrator so escalation-on-failure can distinguish sandbox denials from ordinary patch errors.

*Call graph*: calls 3 internal fn (append, is_likely_sandbox_denied, new); 10 external calls (new, now, file_system_sandbox_context_for_attempt, from_utf8_lossy, new, clone, apply_patch, Codex, format!, Sandbox).


### Patch parsing pipeline
These files turn raw patch text or invocation syntax into validated structured patch arguments, including incremental parsing support.

### `apply-patch/src/streaming_parser.rs`

`domain_logic` · `incremental patch parsing during tool input streaming`

This module defines `StreamingPatchParser`, a stateful line-oriented parser for the apply-patch format. The parser stores a partial `line_buffer`, a monotonically increasing `line_number`, and a `StreamingParserState` containing the current mode, accumulated `Vec<Hunk>`, and optional `environment_id`. Modes track whether parsing has not started, is between hunks, is inside add/delete/update hunks, or has already seen `*** End Patch`.

`push_delta` accepts arbitrary text fragments, appends characters until newline boundaries, strips a single trailing `\r` from completed lines, increments the line counter, and feeds each complete line into `process_line`. `finish` handles a final unterminated line, allows a trailing `*** End Patch` without newline, and rejects inputs that never reached `EndedPatch`.

`process_line` is the core state machine. In `StartedPatch`, only environment ID lines, hunk headers, or end-patch are accepted. Add-file hunks collect only `+` lines into a single `contents` string. Delete-file hunks accept no body. Update-file hunks support an optional leading `*** Move to:` before any chunks, explicit `@@` or `@@ context` chunk headers, bare empty lines as context, ordinary context/add/remove lines, and `*** End of File` markers that set `UpdateFileChunk::is_end_of_file`. The parser carefully distinguishes true hunk headers from indented lines that merely look like markers, and it validates that update hunks are not empty and that empty chunks are rejected before another header or EOF. After `*** End Patch`, only whitespace-only trailing lines are tolerated.

The extensive tests cover streaming by partial lines and single characters, environment ID handling, CRLF behavior, EOF markers, final-line-without-newline handling, and many exact error cases.

#### Function details

##### `StreamingPatchParser::environment_id`  (lines 49–51)

```
fn environment_id(&self) -> Option<&str>
```

**Purpose**: Returns the parsed environment ID, if one has been seen in the patch preamble.

**Data flow**: It reads `self.state.environment_id`, converts the internal `Option<String>` to `Option<&str>` with `as_deref`, and returns that borrowed view without mutation.

**Call relations**: This accessor is used after parsing completes so wrapper code such as `parse_patch_text` can include the environment ID in `ApplyPatchArgs`.


##### `StreamingPatchParser::ensure_update_hunk_is_not_empty`  (lines 53–82)

```
fn ensure_update_hunk_is_not_empty(&self, line: &str) -> Result<(), ParseError>
```

**Purpose**: Validates that the current update hunk has at least one non-empty chunk before another header or patch end is accepted.

**Data flow**: It inspects the last accumulated hunk and current parser mode. If the last hunk is an `UpdateFile` with no chunks, it returns `InvalidHunkError` using the stored update hunk start line; if the last chunk exists but both `old_lines` and `new_lines` are empty, it returns either an end-of-patch-specific or unexpected-line-specific error based on the supplied `line`. Otherwise it returns `Ok(())`.

**Call relations**: This guard is called from `handle_hunk_headers_and_end_patch` whenever a new header or `*** End Patch` would terminate the current update hunk, and from `finish` when the final unterminated line is the end marker.

*Call graph*: called by 2 (finish, handle_hunk_headers_and_end_patch); 1 external calls (format!).


##### `StreamingPatchParser::handle_hunk_headers_and_end_patch`  (lines 84–137)

```
fn handle_hunk_headers_and_end_patch(&mut self, trimmed: &str) -> Result<bool, ParseError>
```

**Purpose**: Recognizes top-level control lines—environment ID, hunk headers, and end-patch—and updates parser state accordingly.

**Data flow**: It takes a trimmed line, checks for an environment ID only while in `StartedPatch`, validates uniqueness and non-emptiness, and stores it in `self.state.environment_id`. It also recognizes `END_PATCH_MARKER`, add/delete/update hunk headers, calls `ensure_update_hunk_is_not_empty` before transitioning away from an update hunk, pushes the corresponding `Hunk` variant into `self.state.hunks`, updates `self.state.mode`, and returns `Ok(true)` when it consumed the line; otherwise `Ok(false)`.

**Call relations**: This helper is invoked from `process_line` in several modes to centralize header recognition. It is the mechanism by which the parser transitions between hunk bodies and top-level patch structure.

*Call graph*: calls 1 internal fn (ensure_update_hunk_is_not_empty); called by 1 (process_line); 4 external calls (from, new, new, matches!).


##### `StreamingPatchParser::push_delta`  (lines 139–152)

```
fn push_delta(&mut self, delta: &str) -> Result<Vec<Hunk>, ParseError>
```

**Purpose**: Consumes an arbitrary text fragment, emits completed lines into the parser state machine, and returns the hunks parsed so far.

**Data flow**: It iterates over `delta.chars()`, appending non-newline characters to `self.line_buffer`. On each `\n`, it takes the buffered line, strips one trailing `\r` if present, increments `self.line_number`, and passes the line to `process_line`. After processing all characters it returns a clone of `self.state.hunks`.

**Call relations**: This is the incremental ingestion API used by higher-level streaming code and tests. It delegates all syntax decisions to `process_line` while preserving partial-line state across calls.

*Call graph*: calls 1 internal fn (process_line); called by 1 (push_delta); 1 external calls (take).


##### `StreamingPatchParser::finish`  (lines 154–173)

```
fn finish(&mut self) -> Result<Vec<Hunk>, ParseError>
```

**Purpose**: Finalizes parsing after the last input fragment, processing any unterminated final line and enforcing that the patch ended correctly.

**Data flow**: If `self.line_buffer` is non-empty, it takes that line, increments `line_number`, and either treats a trimmed end marker specially or sends the line through `process_line`. It then checks that `self.state.mode` is `EndedPatch`; if not, it returns `InvalidPatchError` for a missing end marker. On success it returns a clone of the accumulated hunks.

**Call relations**: Called after the last `push_delta` by wrapper code such as `parse_patch_text` or streaming completion logic. It complements `push_delta` by handling the common case where the final line lacks a trailing newline.

*Call graph*: calls 2 internal fn (ensure_update_hunk_is_not_empty, process_line); called by 1 (finish_update_on_complete); 2 external calls (matches!, take).


##### `StreamingPatchParser::process_line`  (lines 175–408)

```
fn process_line(&mut self, line: &str) -> Result<(), ParseError>
```

**Purpose**: Implements the parser state machine for every complete line of patch input.

**Data flow**: It receives a raw line, derives `trimmed` and sometimes `trim_end()` variants, and branches on `self.state.mode`. Depending on mode it may validate the begin marker, delegate header recognition to `handle_hunk_headers_and_end_patch`, append add-file contents, reject invalid delete-file bodies, parse update-file move directives and chunk headers, append context/add/remove lines into `UpdateFileChunk` vectors, mark EOF chunks, or emit precise `InvalidPatchError` / `InvalidHunkError` values with `self.line_number`. It mutates parser mode, hunk vectors, chunk contents, and environment ID as needed and otherwise returns `Ok(())`.

**Call relations**: This is the central parser routine called by both `push_delta` and `finish`. It relies on `handle_hunk_headers_and_end_patch` for shared header transitions and embodies all line-level grammar and validation rules.

*Call graph*: calls 1 internal fn (handle_hunk_headers_and_end_patch); called by 2 (finish, push_delta); 4 external calls (from, new, new, format!).


##### `tests::test_streaming_patch_parser_streams_complete_lines_before_end_patch`  (lines 419–480)

```
fn test_streaming_patch_parser_streams_complete_lines_before_end_patch()
```

**Purpose**: Verifies that partial input only affects parser output once complete lines arrive and that multiple hunk types stream correctly.

**Data flow**: It creates fresh parsers, feeds patch fragments in pieces, inspects the `Vec<Hunk>` returned by `push_delta`, and asserts that only completed lines contribute to visible parsed hunks.

**Call relations**: This test exercises the incremental contract of `push_delta`, especially buffering behavior across fragmented input.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_environment_id_mode`  (lines 483–519)

```
fn test_streaming_patch_parser_environment_id_mode()
```

**Purpose**: Checks successful environment ID capture and rejection of duplicate or empty environment ID declarations.

**Data flow**: It pushes patches containing valid, repeated, and blank `*** Environment ID:` lines, then asserts either parsed hunks plus `environment_id()` output or the exact `InvalidPatchError`.

**Call relations**: This test targets the environment-ID branch inside `handle_hunk_headers_and_end_patch` and the accessor used after parsing.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_large_patch_split_by_character`  (lines 522–610)

```
fn test_streaming_patch_parser_large_patch_split_by_character()
```

**Purpose**: Stress-tests character-by-character streaming on a large mixed patch and ensures hunk counts only grow monotonically.

**Data flow**: It iterates over every character of a long patch, calling `push_delta` with one-character strings, tracking returned hunk counts, and asserting both monotonic growth and the final sequence of hunk operation kinds.

**Call relations**: This test validates that the parser is safe for highly fragmented streamed tool input and that intermediate snapshots remain consistent.

*Call graph*: 4 external calls (new, default, assert!, assert_eq!).


##### `tests::test_streaming_patch_parser_keeps_indented_update_markers_as_context_lines`  (lines 613–649)

```
fn test_streaming_patch_parser_keeps_indented_update_markers_as_context_lines()
```

**Purpose**: Ensures that lines beginning with a space and then a marker-looking string are treated as update context, not as new hunk headers.

**Data flow**: It parses an update hunk containing a context line ` *** Update File: b.txt`, then asserts that this text is preserved in both `old_lines` and `new_lines` of the current chunk rather than splitting the hunk.

**Call relations**: This test covers a subtle branch in `process_line` where raw line prefixes, not trimmed content alone, determine whether a line is diff content or a structural marker.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_preserves_bare_empty_update_lines`  (lines 652–687)

```
fn test_streaming_patch_parser_preserves_bare_empty_update_lines()
```

**Purpose**: Verifies that a completely empty line inside an update hunk is preserved as an empty context line.

**Data flow**: It parses an update patch with a blank line between two context lines and asserts that both `old_lines` and `new_lines` contain `String::new()` at the corresponding position.

**Call relations**: This test documents the parser’s lenient handling of bare empty lines in update hunks, matching the non-streaming parser behavior.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_ignores_empty_lines_after_end_of_file`  (lines 690–707)

```
fn test_streaming_patch_parser_ignores_empty_lines_after_end_of_file()
```

**Purpose**: Checks that blank lines after `*** End of File` do not invalidate the current update hunk before patch end.

**Data flow**: It parses a patch containing an EOF marker followed by an empty line and asserts successful parsing with `is_end_of_file: true` on the chunk.

**Call relations**: This test exercises the update-mode logic that permits empty lines after EOF markers but still requires the next non-empty line to be a new chunk header or patch end.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_matches_line_ending_behavior`  (lines 710–740)

```
fn test_streaming_patch_parser_matches_line_ending_behavior()
```

**Purpose**: Confirms that CRLF input is normalized correctly while preserving embedded carriage returns that are part of actual line content.

**Data flow**: It feeds patches using `\r\n` line endings, including one line ending with an extra literal `\r` before newline, and asserts the resulting chunk contents preserve only the intended embedded carriage return.

**Call relations**: This test validates the `push_delta` logic that strips at most one trailing `\r` from each completed line.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_finish_processes_final_line_without_newline`  (lines 743–789)

```
fn test_streaming_patch_parser_finish_processes_final_line_without_newline()
```

**Purpose**: Ensures `finish` correctly handles a final patch line that was never terminated by `\n`.

**Data flow**: It pushes patches whose last line lacks a newline, then calls `finish` and asserts successful final hunk output for both add-file and update-file cases.

**Call relations**: This test covers the handoff between `push_delta` buffering and `finish` finalization.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_finish_requires_end_patch`  (lines 792–807)

```
fn test_streaming_patch_parser_finish_requires_end_patch()
```

**Purpose**: Verifies that finalization fails when the patch never reaches `*** End Patch`.

**Data flow**: It pushes an incomplete patch, calls `finish`, and asserts the specific `InvalidPatchError` about the missing last line marker.

**Call relations**: This test targets the final mode check in `finish`.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_rejects_content_after_end_patch`  (lines 810–831)

```
fn test_streaming_patch_parser_rejects_content_after_end_patch()
```

**Purpose**: Checks that non-whitespace content after `*** End Patch` is rejected while trailing blank/whitespace-only lines are allowed.

**Data flow**: It parses one patch with extra text after the end marker and another with only whitespace after it, asserting failure in the first case and success in the second.

**Call relations**: This test exercises the `EndedPatch` branch of `process_line`.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_returns_errors`  (lines 834–943)

```
fn test_streaming_patch_parser_returns_errors()
```

**Purpose**: Covers a broad set of malformed inputs and pins the exact parser diagnostics and line numbers.

**Data flow**: It constructs many invalid patches—bad first line, invalid hunk headers, add/delete body errors, empty update hunks, empty chunks, misplaced markers, and malformed update content—feeds them through `push_delta`, and asserts exact `ParseError` values.

**Call relations**: This is the comprehensive negative test suite for the state machine, validating the error branches in `process_line`, `handle_hunk_headers_and_end_patch`, and `ensure_update_hunk_is_not_empty`.

*Call graph*: 2 external calls (default, assert_eq!).


### `apply-patch/src/parser.rs`

`domain_logic` · `patch parsing before application`

This module is the front door for patch parsing. It declares the marker constants for the patch language, the `ParseError` enum used across parsing, the `Hunk` enum for add/delete/update operations, and `UpdateFileChunk` for the per-chunk contents of update hunks. `Hunk::path()` deliberately reports the move destination for rename-style update hunks, while `resolve_path()` resolves either relative or absolute paths against a provided `AbsolutePathBuf` working directory.

The main parser entrypoint, `parse_patch`, selects strict versus lenient boundary handling via the compile-time `PARSE_IN_STRICT_MODE` flag, currently forcing lenient mode. `parse_patch_text` trims the incoming text, splits it into lines, validates the outer `*** Begin Patch` / `*** End Patch` framing, reconstructs normalized patch text with `\n`, and then feeds that text into `StreamingPatchParser`. The streaming parser performs the real grammar validation and hunk construction; this wrapper extracts the final hunks and optional environment ID and packages them into `ApplyPatchArgs` with `workdir: None`.

The strict boundary helpers enforce exact first/last markers after trimming surrounding whitespace. Lenient mode first tries strict parsing unchanged, then recognizes heredoc wrappers like `<<EOF`, `<<'EOF'`, or `<<"EOF"` with a closing line ending in `EOF`, strips those wrapper lines, and re-runs strict validation on the inner patch. Tests in this file pin down empty patches, empty update hunks, move hunks, omitted initial `@@` headers, EOF markers, absolute paths, path resolution, heredoc leniency, and environment ID validation.

#### Function details

##### `Hunk::resolve_path`  (lines 84–90)

```
fn resolve_path(&self, cwd: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: Computes the absolute filesystem path affected by a hunk relative to a supplied current working directory.

**Data flow**: It reads `self` and a base `cwd: &AbsolutePathBuf`. For update hunks it uses the original update path field, while add/delete hunks use `Hunk::path()`; it then passes that path into `AbsolutePathBuf::resolve_path_against_base` and returns the resolved absolute path.

**Call relations**: This helper is used when later application logic needs a concrete filesystem target. Internally it depends on `Hunk::path()` for non-update cases and delegates final normalization to the absolute-path utility crate.

*Call graph*: calls 2 internal fn (path, resolve_path_against_base).


##### `Hunk::path`  (lines 93–107)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the logical path associated with a hunk, preferring the move destination for rename/update hunks.

**Data flow**: It pattern-matches on `self`. `AddFile` and `DeleteFile` return their stored `path`; `UpdateFile` returns `move_path` when present, otherwise the original `path`, and yields a borrowed `&Path`.

**Call relations**: This is the canonical path accessor for callers that care about the file’s post-patch identity. `Hunk::resolve_path()` calls it for add/delete hunks, while update hunks bypass it when they need the source path instead.

*Call graph*: called by 1 (resolve_path).


##### `parse_patch`  (lines 129–136)

```
fn parse_patch(patch: &str) -> Result<ApplyPatchArgs, ParseError>
```

**Purpose**: Public convenience entrypoint that parses a patch string into `ApplyPatchArgs` using the crate’s configured strictness mode.

**Data flow**: It accepts `patch: &str`, selects `ParseMode::Lenient` or `ParseMode::Strict` from the `PARSE_IN_STRICT_MODE` constant, and forwards both to `parse_patch_text`. It returns either parsed `ApplyPatchArgs` or a `ParseError`.

**Call relations**: This is the parser API used by patch-application code and parser-focused tests. It exists mainly to hide the internal `ParseMode` choice and route all callers through `parse_patch_text`.

*Call graph*: calls 1 internal fn (parse_patch_text); called by 10 (apply_patch, maybe_parse_apply_patch, maybe_parse_apply_patch_verified, test_unified_diff_insert_at_eof, test_unified_diff_last_line_replacement, test_unified_diff, test_unified_diff_first_line_replacement, test_unified_diff_insert_at_eof, test_unified_diff_interleaved_changes, test_unified_diff_last_line_replacement).


##### `parse_patch_text`  (lines 177–195)

```
fn parse_patch_text(patch: &str, mode: ParseMode) -> Result<ApplyPatchArgs, ParseError>
```

**Purpose**: Validates patch framing, normalizes the text, streams it through the incremental parser, and assembles the final `ApplyPatchArgs` value.

**Data flow**: It takes raw patch text plus a `ParseMode`. After `trim()` and `lines()` collection, it chooses either strict or lenient boundary checking to obtain the slice containing actual patch lines. It joins those lines with `\n`, constructs a default `StreamingPatchParser`, feeds the normalized patch via `push_delta`, finalizes with `finish`, reads `environment_id()` from the parser, and returns `ApplyPatchArgs { hunks, patch, workdir: None, environment_id }`.

**Call relations**: This function is the core bridge between outer text validation and the streaming grammar parser. `parse_patch` invokes it, and it in turn delegates framing checks to the boundary helpers and structural parsing to `StreamingPatchParser`.

*Call graph*: calls 2 internal fn (check_patch_boundaries_lenient, check_patch_boundaries_strict); called by 1 (parse_patch); 1 external calls (default).


##### `check_patch_boundaries_strict`  (lines 199–207)

```
fn check_patch_boundaries_strict(lines: &'a [&'a str]) -> Result<&'a [&'a str], ParseError>
```

**Purpose**: Extracts the first and last lines from a candidate patch and enforces exact begin/end markers.

**Data flow**: It receives a borrowed slice of line slices, derives `first_line` and `last_line` for empty, single-line, or multi-line inputs, calls `check_start_and_end_lines_strict`, and on success returns the original line slice unchanged.

**Call relations**: This is the baseline framing validator used directly by `parse_patch_text` in strict mode and as the first attempt inside lenient mode before heredoc fallback.

*Call graph*: calls 1 internal fn (check_start_and_end_lines_strict); called by 2 (check_patch_boundaries_lenient, parse_patch_text).


##### `check_patch_boundaries_lenient`  (lines 216–238)

```
fn check_patch_boundaries_lenient(
    original_lines: &'a [&'a str],
) -> Result<&'a [&'a str], ParseError>
```

**Purpose**: Accepts either a normal patch or a heredoc-wrapped patch argument and returns the inner patch lines when valid.

**Data flow**: It takes the original line slice and first tries `check_patch_boundaries_strict`; if that succeeds it returns immediately. Otherwise it preserves the original parse error, checks for a first line equal to `<<EOF`, `<<'EOF'`, or `<<"EOF"`, a last line ending in `EOF`, and at least four total lines; if those conditions hold it slices out the inner lines and re-validates them strictly, otherwise it returns the original strict error.

**Call relations**: Used only by `parse_patch_text` in lenient mode. Its control flow is intentionally conservative: heredoc stripping is a fallback, not the primary parse path, so ordinary malformed patches still report the original strict framing error when no wrapper pattern matches.

*Call graph*: calls 1 internal fn (check_patch_boundaries_strict); called by 1 (parse_patch_text).


##### `check_start_and_end_lines_strict`  (lines 240–258)

```
fn check_start_and_end_lines_strict(
    first_line: Option<&&str>,
    last_line: Option<&&str>,
) -> Result<(), ParseError>
```

**Purpose**: Produces the specific invalid-patch error for missing or incorrect outer patch markers.

**Data flow**: It accepts optional references to the first and last lines, trims surrounding whitespace on each when present, compares them against `BEGIN_PATCH_MARKER` and `END_PATCH_MARKER`, and returns `Ok(())` only when both match. Otherwise it constructs `InvalidPatchError` with either the first-line or last-line diagnostic string.

**Call relations**: This is the lowest-level framing check called by `check_patch_boundaries_strict`. It centralizes the exact error messages that tests and CLI behavior rely on.

*Call graph*: called by 1 (check_patch_boundaries_strict); 1 external calls (from).


##### `test_parse_patch`  (lines 261–408)

```
fn test_parse_patch()
```

**Purpose**: Exercises the parser across malformed framing, empty patches, add/delete/update hunks, move hunks, hunk sequencing, and omitted initial context headers.

**Data flow**: It feeds multiple literal patch strings into `parse_patch_text` in strict mode and compares returned `ApplyPatchArgs` or `ParseError` values against explicit expected structures and messages.

**Call relations**: This test directly validates the top-level parser wrapper rather than the streaming parser internals, ensuring the public parse behavior matches the documented patch format.

*Call graph*: 1 external calls (assert_eq!).


##### `test_parse_patch_preserves_end_of_file_marker`  (lines 411–432)

```
fn test_parse_patch_preserves_end_of_file_marker()
```

**Purpose**: Verifies that an `*** End of File` marker is preserved as `is_end_of_file: true` in the parsed update chunk.

**Data flow**: It constructs a patch string containing an update hunk followed by `*** End of File`, calls `parse_patch`, and asserts that the returned `ApplyPatchArgs` contains one `UpdateFileChunk` with `new_lines` set and `is_end_of_file` enabled.

**Call relations**: This test covers the integration between the parser wrapper and `StreamingPatchParser` for EOF-sensitive hunks.

*Call graph*: 1 external calls (assert_eq!).


##### `test_parse_patch_accepts_relative_and_absolute_hunk_paths`  (lines 435–477)

```
fn test_parse_patch_accepts_relative_and_absolute_hunk_paths()
```

**Purpose**: Confirms that parsed hunk paths preserve both relative paths and already-absolute filesystem paths.

**Data flow**: It creates temporary absolute paths, interpolates them into a patch string alongside a relative add path, parses in strict mode, and asserts that the resulting `Hunk` values contain the expected `PathBuf`s unchanged.

**Call relations**: This test documents that parsing itself does not reject or rewrite absolute paths; later resolution logic decides how to interpret them.

*Call graph*: 3 external calls (assert_eq!, format!, tempdir).


##### `test_hunk_resolve_path_accepts_relative_and_absolute_paths`  (lines 480–534)

```
fn test_hunk_resolve_path_accepts_relative_and_absolute_paths()
```

**Purpose**: Checks that `Hunk::resolve_path` joins relative paths to the provided cwd and leaves absolute paths untouched.

**Data flow**: It builds a temporary cwd plus separate absolute paths, constructs representative add/delete/update hunks, calls `resolve_path` for each, and compares the returned `AbsolutePathBuf` to the expected joined or preserved path.

**Call relations**: This test targets the `Hunk` helper methods rather than parsing, validating the path invariant relied on by filesystem application code.

*Call graph*: 5 external calls (from, new, new, assert_eq!, tempdir).


##### `test_parse_patch_lenient`  (lines 537–623)

```
fn test_parse_patch_lenient()
```

**Purpose**: Verifies heredoc leniency behavior for accepted wrappers, rejected mismatched quotes, and missing closing patch markers.

**Data flow**: It prepares a valid patch and several heredoc-wrapped variants, parses each under both strict and lenient modes, and asserts either successful `ApplyPatchArgs` reconstruction or the exact expected `InvalidPatchError`.

**Call relations**: This test specifically exercises the fallback path in `check_patch_boundaries_lenient`, proving that lenient mode broadens accepted input without changing strict-mode behavior.

*Call graph*: 3 external calls (assert_eq!, format!, vec!).


##### `test_parse_patch_environment_id_preamble`  (lines 626–660)

```
fn test_parse_patch_environment_id_preamble()
```

**Purpose**: Ensures the optional environment ID preamble is captured when non-empty and rejected when blank.

**Data flow**: It parses one patch containing `*** Environment ID: remote` and another with only whitespace after the marker, asserting either a populated `environment_id` in `ApplyPatchArgs` or an `InvalidPatchError`.

**Call relations**: This test covers parser support for the environment preamble that is actually interpreted by `StreamingPatchParser` and surfaced through `parse_patch_text`.

*Call graph*: 1 external calls (assert_eq!).


### `apply-patch/src/invocation.rs`

`domain_logic` · `request handling`

This module recognizes whether an argv vector corresponds to an explicit `apply_patch` invocation and, if so, turns it into verified `ApplyPatchAction` data. It first classifies shell executables by basename (`bash`, `zsh`, `sh`, `powershell`, `pwsh`, `cmd`) and accepted flags, including optional PowerShell `-NoProfile`. `parse_shell_script` extracts the embedded script from shell argv forms, and `extract_apply_patch_from_shell` currently routes all supported shells through a conservative Tree-sitter Bash parser. The core parser, `maybe_parse_apply_patch`, accepts either direct `apply_patch <patch>` / `applypatch <patch>` argv or shell heredoc forms like `apply_patch <<'EOF' ... EOF` and `cd <path> && apply_patch <<'EOF' ... EOF`; anything else becomes `NotApplyPatch`, while shell or patch parsing failures are preserved distinctly. `maybe_parse_apply_patch_verified` adds correctness checks that reject implicit raw patch bodies passed without an explicit `apply_patch` command, then verifies parsed args against an absolute cwd and an `ExecutorFileSystem`. Verification resolves relative paths against either the provided cwd or a shell-extracted workdir, reads existing file contents for delete/update hunks, computes unified diffs for updates, resolves move destinations against the effective cwd, and returns either a fully populated `ApplyPatchAction` or a structured correctness/I/O error. The embedded tests cover shell classification, heredoc matching strictness, quoted `cd` paths, ignored malformed shell forms, EOF diff generation, cwd-relative resolution, move-path rebasing, and verification behavior for unreadable destinations and symlink deletes.

#### Function details

##### `classify_shell_name`  (lines 54–59)

```
fn classify_shell_name(shell: &str) -> Option<String>
```

**Purpose**: Normalizes a shell executable path to a lowercase basename without extension. It is the first step in recognizing supported shell wrappers around `apply_patch`.

**Data flow**: Takes a shell path string, constructs a `Path`, extracts `file_stem`, converts it to UTF-8 if possible, lowercases it with `to_ascii_lowercase`, and returns `Option<String>`. Invalid or stemless paths yield `None`.

**Call relations**: This helper is called by both `classify_shell` and `can_skip_flag`. It isolates path normalization so shell recognition logic can match on simple names.

*Call graph*: called by 2 (can_skip_flag, classify_shell); 1 external calls (new).


##### `classify_shell`  (lines 61–70)

```
fn classify_shell(shell: &str, flag: &str) -> Option<ApplyPatchShell>
```

**Purpose**: Maps a normalized shell name plus its execution flag to an `ApplyPatchShell` variant when the argv shape is one of the supported shell-script forms. It encodes the accepted shell/flag combinations.

**Data flow**: Accepts a shell path and flag string, calls `classify_shell_name`, and matches the lowercase name plus flag: Unix shells require `-lc` or `-c`, PowerShell variants require `-Command` case-insensitively, and `cmd` requires `/c`. It returns `Some(ApplyPatchShell)` on a recognized combination or `None` otherwise.

**Call relations**: This helper is used by `parse_shell_script` after argv destructuring. It centralizes shell-type recognition for later heredoc extraction.

*Call graph*: calls 1 internal fn (classify_shell_name); called by 1 (parse_shell_script).


##### `can_skip_flag`  (lines 72–76)

```
fn can_skip_flag(shell: &str, flag: &str) -> bool
```

**Purpose**: Recognizes optional shell flags that may appear before the actual script-execution flag and should be ignored for parsing purposes. Currently this only supports PowerShell `-NoProfile`.

**Data flow**: Takes a shell path and candidate flag, normalizes the shell name with `classify_shell_name`, and returns `true` only when the shell is `pwsh` or `powershell` and the flag equals `-noprofile` case-insensitively. Otherwise it returns `false`.

**Call relations**: This helper is called by `parse_shell_script` when matching four-argument shell invocations. It allows the parser to accept PowerShell argv with an extra profile-suppression flag.

*Call graph*: calls 1 internal fn (classify_shell_name); called by 1 (parse_shell_script).


##### `parse_shell_script`  (lines 78–92)

```
fn parse_shell_script(argv: &[String]) -> Option<(ApplyPatchShell, &str)>
```

**Purpose**: Extracts the embedded script string from supported shell argv layouts and identifies the shell family used to run it. It converts raw argv into `(ApplyPatchShell, &str)` when possible.

**Data flow**: Accepts `&[String]` and pattern-matches either `[shell, flag, script]` or `[shell, skip_flag, flag, script]`. In the three-argument case it calls `classify_shell`; in the four-argument case it first checks `can_skip_flag` and then calls `classify_shell`. On success it returns the shell enum plus a borrowed `&str` view of the script argument; otherwise `None`.

**Call relations**: This helper is used by both `maybe_parse_apply_patch` and `maybe_parse_apply_patch_verified`. It is the shared argv-shape recognizer for shell-wrapped patch invocations.

*Call graph*: calls 2 internal fn (can_skip_flag, classify_shell); called by 2 (maybe_parse_apply_patch, maybe_parse_apply_patch_verified).


##### `extract_apply_patch_from_shell`  (lines 94–103)

```
fn extract_apply_patch_from_shell(
    shell: ApplyPatchShell,
    script: &str,
) -> std::result::Result<(String, Option<String>), ExtractHeredocError>
```

**Purpose**: Dispatches shell-script extraction to the concrete parser for the recognized shell family. At present all supported shells reuse the Bash/Tree-sitter extraction logic.

**Data flow**: Accepts an `ApplyPatchShell` and script string, matches the shell variant, and calls `extract_apply_patch_from_bash(script)` for Unix, PowerShell, and Cmd. It returns either `(patch_body, optional_workdir)` or an `ExtractHeredocError`.

**Call relations**: This helper is called by `maybe_parse_apply_patch` after `parse_shell_script` succeeds. It exists as an abstraction point for future shell-specific parsers even though all variants currently share one implementation.

*Call graph*: calls 1 internal fn (extract_apply_patch_from_bash); called by 1 (maybe_parse_apply_patch).


##### `maybe_parse_apply_patch`  (lines 106–131)

```
fn maybe_parse_apply_patch(argv: &[String]) -> MaybeApplyPatch
```

**Purpose**: Determines whether argv explicitly invokes `apply_patch` and, if so, parses it into structured patch args or a precise parse error. It distinguishes direct invocation, shell heredoc invocation, malformed patch bodies, and definitely unrelated commands.

**Data flow**: Accepts `&[String]` and first checks for direct two-argument forms `[cmd, body]` where `cmd` is `apply_patch` or `applypatch`; those bodies are parsed with `parse_patch` into `MaybeApplyPatch::Body` or `PatchParseError`. Otherwise it calls `parse_shell_script`; if that succeeds, it extracts the heredoc body and optional workdir with `extract_apply_patch_from_shell`, parses the body with `parse_patch`, and if successful mutates `source.workdir` to the extracted workdir before returning `Body`. A `CommandDidNotStartWithApplyPatch` shell error is downgraded to `NotApplyPatch`, other shell extraction failures become `ShellParseError`, and unrecognized argv shapes become `NotApplyPatch`.

**Call relations**: This is the main parser entry point used by `maybe_parse_apply_patch_verified` and many unit tests. It delegates shell-shape recognition and heredoc extraction, then delegates patch syntax parsing to `parse_patch`.

*Call graph*: calls 3 internal fn (extract_apply_patch_from_shell, parse_shell_script, parse_patch); called by 5 (maybe_parse_apply_patch_verified, assert_match_args, test_heredoc_applypatch, test_literal, test_literal_applypatch); 3 external calls (Body, PatchParseError, ShellParseError).


##### `maybe_parse_apply_patch_verified`  (lines 135–160)

```
async fn maybe_parse_apply_patch_verified(
    argv: &[String],
    cwd: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&codex_exec_server::FileSystemSandboxContext>,
) -> Mayb
```

**Purpose**: Adds correctness and filesystem verification on top of syntactic `apply_patch` parsing. It rejects implicit raw patch bodies and returns either a verified action, a shell parse error, a correctness error, or `NotApplyPatch`.

**Data flow**: Takes argv, an absolute cwd, an `ExecutorFileSystem`, and optional sandbox context. It first checks two implicit-invocation cases: a single argv element that itself parses as a patch body, or a shell script argument that parses directly as a patch body; either yields `MaybeApplyPatchVerified::CorrectnessError(ImplicitInvocation)`. Otherwise it calls `maybe_parse_apply_patch`; `Body(args)` is passed to `verify_apply_patch_args`, `ShellParseError` is preserved, `PatchParseError` is converted into `CorrectnessError`, and `NotApplyPatch` is returned unchanged.

**Call relations**: This function is the public verified entry point re-exported by the crate and used by tests. It sits above `maybe_parse_apply_patch` and below consumers that need a filesystem-checked `ApplyPatchAction`.

*Call graph*: calls 4 internal fn (maybe_parse_apply_patch, parse_shell_script, verify_apply_patch_args, parse_patch); called by 4 (test_apply_patch_resolves_move_path_with_effective_cwd, test_apply_patch_should_resolve_absolute_paths_in_cwd, test_delete_symlink_still_verifies, test_unreadable_destinations_still_verify); 2 external calls (CorrectnessError, ShellParseError).


##### `verify_apply_patch_args`  (lines 162–235)

```
async fn verify_apply_patch_args(
    args: ApplyPatchArgs,
    cwd: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&codex_exec_server::FileSystemSandboxContext>,
) -> MaybeApp
```

**Purpose**: Resolves parsed patch hunks against the filesystem and produces an `ApplyPatchAction` describing concrete absolute-path changes. It verifies readability and computes update diffs before any patch is applied.

**Data flow**: Consumes `ApplyPatchArgs`, absolute cwd, filesystem, and optional sandbox. It computes `effective_cwd` by joining any parsed `workdir` onto the provided cwd, then iterates over each `Hunk`. `AddFile` hunks become `ApplyPatchFileChange::Add` entries keyed by resolved absolute path. `DeleteFile` hunks read existing file text through `ExecutorFileSystem::read_file_text`; read failures become `CorrectnessError(IoError { context: "Failed to read ..." })`, while successes become `Delete { content }`. `UpdateFile` hunks call `unified_diff_from_chunks` to derive `unified_diff` and new content; failures become correctness errors, and successes become `Update { unified_diff, move_path: resolved optional destination, new_content }`. After all hunks are processed it returns `MaybeApplyPatchVerified::Body(ApplyPatchAction { changes, patch, cwd: effective_cwd })`.

**Call relations**: This verifier is called only by `maybe_parse_apply_patch_verified`. It delegates diff computation to `unified_diff_from_chunks` and filesystem reads to the injected `ExecutorFileSystem`.

*Call graph*: calls 2 internal fn (read_file_text, from_abs_path); called by 1 (maybe_parse_apply_patch_verified); 6 external calls (new, IoError, Body, CorrectnessError, unified_diff_from_chunks, format!).


##### `extract_apply_patch_from_bash`  (lines 257–387)

```
fn extract_apply_patch_from_bash(
    src: &str,
) -> std::result::Result<(String, Option<String>), ExtractHeredocError>
```

**Purpose**: Conservatively parses a shell script with Tree-sitter Bash to extract an `apply_patch` heredoc body and optional leading `cd` workdir only when the entire script matches one of two allowed top-level forms. It is intentionally strict to avoid misinterpreting arbitrary shell code as a patch invocation.

**Data flow**: Accepts the raw script source, lazily initializes a static `Query` over the Bash grammar that matches either a lone redirected `apply_patch` command or `cd <path> && apply_patch` with a heredoc, then creates a `Parser`, loads the Bash language, parses the source into a syntax tree, and runs the query over the root node. For each match it scans captures named `heredoc`, `cd_path`, and `cd_raw_string`, decoding UTF-8 text from source bytes, trimming the heredoc's trailing newline, and stripping surrounding single quotes from raw-string cd paths. If a match yields a heredoc body it returns `(body, optional_cd_path)`; if parsing fails it returns the corresponding `ExtractHeredocError`, and if no allowed form matches it returns `CommandDidNotStartWithApplyPatch`.

**Call relations**: This helper is called by `extract_apply_patch_from_shell` for all currently supported shell families. It is the core syntax recognizer that enforces the module's conservative shell-matching policy.

*Call graph*: called by 1 (extract_apply_patch_from_shell); 3 external calls (new, new, new).


##### `tests::wrap_patch`  (lines 403–405)

```
fn wrap_patch(body: &str) -> String
```

**Purpose**: Builds a complete patch string by surrounding a supplied body with `*** Begin Patch` and `*** End Patch`. It keeps test fixtures concise.

**Data flow**: Takes a patch body string slice, interpolates it into the wrapper format, and returns the resulting `String`.

**Call relations**: This helper is used by multiple unit tests in the module when constructing patch text for parsing or verification.

*Call graph*: 1 external calls (format!).


##### `tests::strs_to_strings`  (lines 407–409)

```
fn strs_to_strings(strs: &[&str]) -> Vec<String>
```

**Purpose**: Converts a slice of `&str` into owned `String` values for argv fixtures. It reduces repetitive `.to_string()` calls in tests.

**Data flow**: Maps each input string slice through `ToString::to_string` and collects the results into `Vec<String>`.

**Call relations**: This helper underpins the shell-argv fixture builders and several direct parsing tests.


##### `tests::args_bash`  (lines 412–414)

```
fn args_bash(script: &str) -> Vec<String>
```

**Purpose**: Constructs a `bash -lc <script>` argv vector for heredoc parsing tests. It standardizes the Unix shell fixture shape.

**Data flow**: Takes a script string slice and returns `vec!["bash", "-lc", script]` converted to owned strings via `strs_to_strings`.

**Call relations**: Used by assertion helpers and multiple heredoc tests to exercise the Bash shell-wrapper path.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::args_powershell`  (lines 416–418)

```
fn args_powershell(script: &str) -> Vec<String>
```

**Purpose**: Constructs a `powershell.exe -Command <script>` argv vector for shell-wrapper tests. It exercises PowerShell classification while still using the shared heredoc parser.

**Data flow**: Builds the three-element argv slice and converts it to `Vec<String>` with `strs_to_strings`.

**Call relations**: Used by PowerShell heredoc tests.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::args_powershell_no_profile`  (lines 420–422)

```
fn args_powershell_no_profile(script: &str) -> Vec<String>
```

**Purpose**: Constructs a `powershell.exe -NoProfile -Command <script>` argv vector to test optional skip-flag handling. It specifically covers `can_skip_flag` behavior.

**Data flow**: Builds the four-element argv slice and converts it to owned strings with `strs_to_strings`.

**Call relations**: Used by the no-profile PowerShell heredoc test.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::args_pwsh`  (lines 424–426)

```
fn args_pwsh(script: &str) -> Vec<String>
```

**Purpose**: Constructs a `pwsh -NoProfile -Command <script>` argv vector for PowerShell Core parsing tests. It covers both shell-name normalization and skip-flag handling.

**Data flow**: Builds the argv slice and converts it to `Vec<String>` via `strs_to_strings`.

**Call relations**: Used by the `pwsh` heredoc test.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::args_cmd`  (lines 428–430)

```
fn args_cmd(script: &str) -> Vec<String>
```

**Purpose**: Constructs a `cmd.exe /c <script>` argv vector for shell-wrapper parsing tests. It exercises the Cmd classification branch.

**Data flow**: Builds the three-element argv slice and converts it to owned strings with `strs_to_strings`.

**Call relations**: Used by the cmd heredoc-with-cd test.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::heredoc_script`  (lines 432–436)

```
fn heredoc_script(prefix: &str) -> String
```

**Purpose**: Builds a canonical heredoc shell script containing an `apply_patch` invocation, optionally prefixed by caller-supplied shell text such as `cd foo && `. It is the main positive/negative fixture generator for shell parsing tests.

**Data flow**: Interpolates the provided prefix before `apply_patch <<'PATCH'`, inserts a simple add-file patch body, and returns the full script string.

**Call relations**: Used by many heredoc matching and non-matching tests, often through `assert_match` or `assert_not_match`.

*Call graph*: 1 external calls (format!).


##### `tests::heredoc_script_ps`  (lines 438–442)

```
fn heredoc_script_ps(prefix: &str, suffix: &str) -> String
```

**Purpose**: Builds a heredoc script with both a prefix and suffix around the `apply_patch` invocation. It is used to test rejection of extra trailing commands.

**Data flow**: Formats a script string containing the prefix, the canonical heredoc patch body, and the suffix appended after the heredoc terminator.

**Call relations**: Used by the test that ensures `cd ... && apply_patch ... && echo done` does not match.

*Call graph*: 1 external calls (format!).


##### `tests::expected_single_add`  (lines 444–449)

```
fn expected_single_add() -> Vec<Hunk>
```

**Purpose**: Returns the parsed `Hunk` vector expected from the canonical single-file add patch used in many parsing tests. It avoids repeating the same hunk literal.

**Data flow**: Constructs and returns `vec![Hunk::AddFile { path: "foo", contents: "hi\n" }]`.

**Call relations**: Used by `assert_match_args` to compare parsed results against the canonical expected hunk list.

*Call graph*: 1 external calls (vec!).


##### `tests::assert_match_args`  (lines 451–459)

```
fn assert_match_args(args: Vec<String>, expected_workdir: Option<&str>)
```

**Purpose**: Asserts that a given argv vector parses as `MaybeApplyPatch::Body` with the canonical single-add hunk and an expected optional workdir. It is the core positive assertion helper for shell parsing tests.

**Data flow**: Calls `maybe_parse_apply_patch(&args)`, pattern-matches the result as `Body(ApplyPatchArgs { hunks, workdir, .. })`, and asserts `workdir.as_deref()` equals the expected workdir and `hunks` equals `expected_single_add()`. Any other parse result triggers `panic!` with the unexpected value.

**Call relations**: Used by `assert_match` and many direct shell-wrapper tests. It sits directly on top of the parser under test.

*Call graph*: calls 1 internal fn (maybe_parse_apply_patch); 2 external calls (assert_eq!, panic!).


##### `tests::assert_match`  (lines 461–464)

```
fn assert_match(script: &str, expected_workdir: Option<&str>)
```

**Purpose**: Convenience wrapper that asserts a Bash heredoc script matches and yields the expected workdir. It hides argv construction for positive Bash tests.

**Data flow**: Builds Bash argv with `args_bash(script)` and forwards it to `assert_match_args` with the expected workdir.

**Call relations**: Used by several positive heredoc tests involving plain or `cd`-prefixed Bash scripts.

*Call graph*: 2 external calls (args_bash, assert_match_args).


##### `tests::assert_not_match`  (lines 466–472)

```
fn assert_not_match(script: &str)
```

**Purpose**: Asserts that a Bash heredoc-like script is rejected as `NotApplyPatch`. It is the negative counterpart to `assert_match`.

**Data flow**: Builds Bash argv with `args_bash(script)`, calls `maybe_parse_apply_patch`, and uses `assert_matches!` to require `MaybeApplyPatch::NotApplyPatch`.

**Call relations**: Used by the many strictness tests that ensure malformed or extra-command shell scripts are ignored.

*Call graph*: 2 external calls (args_bash, assert_matches!).


##### `tests::test_implicit_patch_single_arg_is_error`  (lines 475–489)

```
async fn test_implicit_patch_single_arg_is_error()
```

**Purpose**: Verifies that a raw patch body passed as the only argv element is treated as an implicit invocation correctness error rather than silently parsed. It protects the explicit-command contract.

**Data flow**: Constructs a one-element argv vector containing a valid patch body, creates a temp directory and absolute cwd, calls `maybe_parse_apply_patch_verified`, and asserts the result is `MaybeApplyPatchVerified::CorrectnessError(ApplyPatchError::ImplicitInvocation)`.

**Call relations**: This async unit test exercises the early implicit-invocation guard in `maybe_parse_apply_patch_verified`.

*Call graph*: 3 external calls (assert_matches!, tempdir, vec!).


##### `tests::test_implicit_patch_bash_script_is_error`  (lines 492–506)

```
async fn test_implicit_patch_bash_script_is_error()
```

**Purpose**: Verifies that a shell script argument consisting solely of a raw patch body is also rejected as an implicit invocation. It covers the shell-script variant of the same correctness rule.

**Data flow**: Builds Bash argv whose script string is itself a valid patch body, creates a temp cwd, calls `maybe_parse_apply_patch_verified`, and asserts the same `ImplicitInvocation` correctness error.

**Call relations**: This test complements the single-arg implicit invocation test by exercising the `parse_shell_script` branch.

*Call graph*: 3 external calls (args_bash, assert_matches!, tempdir).


##### `tests::test_literal`  (lines 509–531)

```
async fn test_literal()
```

**Purpose**: Checks direct `apply_patch <patch>` parsing for the canonical command name. It validates the simplest non-shell invocation path.

**Data flow**: Builds a two-element argv vector with `apply_patch` and a valid add-file patch body, calls `maybe_parse_apply_patch`, pattern-matches `Body`, and asserts the parsed hunks equal a single `Hunk::AddFile` for `foo` with `hi\n` contents. Any other result panics.

**Call relations**: This unit test directly exercises the direct-command branch of `maybe_parse_apply_patch`.

*Call graph*: calls 1 internal fn (maybe_parse_apply_patch); 3 external calls (strs_to_strings, assert_eq!, panic!).


##### `tests::test_literal_applypatch`  (lines 534–556)

```
async fn test_literal_applypatch()
```

**Purpose**: Checks direct parsing for the alternate command name `applypatch`. It ensures both accepted command spellings behave identically.

**Data flow**: Builds argv with `applypatch` and a valid patch body, calls `maybe_parse_apply_patch`, and asserts the parsed hunks match the canonical single-add expectation.

**Call relations**: This test complements `test_literal` by covering the alternate accepted command token.

*Call graph*: calls 1 internal fn (maybe_parse_apply_patch); 3 external calls (strs_to_strings, assert_eq!, panic!).


##### `tests::test_heredoc`  (lines 559–561)

```
async fn test_heredoc()
```

**Purpose**: Verifies that a plain Bash heredoc `apply_patch` script is recognized and parsed successfully. It is the baseline shell-wrapper positive case.

**Data flow**: Builds the canonical heredoc script with no prefix and passes it to `assert_match` expecting no workdir.

**Call relations**: This test uses the shared positive assertion helper over the Bash shell path.

*Call graph*: 2 external calls (assert_match, heredoc_script).


##### `tests::test_heredoc_non_login_shell`  (lines 564–568)

```
async fn test_heredoc_non_login_shell()
```

**Purpose**: Verifies that `bash -c` is accepted in addition to `bash -lc`. It covers the alternate Unix shell flag recognized by `classify_shell`.

**Data flow**: Builds the canonical heredoc script, constructs argv `['bash', '-c', script]`, and passes it to `assert_match_args` expecting no workdir.

**Call relations**: This test specifically exercises the `-c` branch in shell classification.

*Call graph*: 3 external calls (assert_match_args, heredoc_script, strs_to_strings).


##### `tests::test_heredoc_applypatch`  (lines 571–596)

```
async fn test_heredoc_applypatch()
```

**Purpose**: Verifies that the alternate command name `applypatch` is recognized inside a heredoc shell script. It extends alternate-name support to shell parsing.

**Data flow**: Builds Bash argv containing a heredoc script whose command token is `applypatch`, calls `maybe_parse_apply_patch`, pattern-matches `Body`, and asserts `workdir == None` and the parsed hunks equal the canonical single-add hunk.

**Call relations**: This test directly exercises shell parsing without the assertion helper because it checks both hunks and workdir explicitly.

*Call graph*: calls 1 internal fn (maybe_parse_apply_patch); 3 external calls (strs_to_strings, assert_eq!, panic!).


##### `tests::test_powershell_heredoc`  (lines 599–602)

```
async fn test_powershell_heredoc()
```

**Purpose**: Verifies that a PowerShell `-Command` wrapper is accepted and parsed through the shared heredoc extractor. It covers shell-name normalization for `powershell.exe`.

**Data flow**: Builds the canonical heredoc script, wraps it with `args_powershell`, and passes the argv to `assert_match_args` expecting no workdir.

**Call relations**: This test exercises the PowerShell classification branch while still relying on the Bash-based heredoc parser.

*Call graph*: 3 external calls (args_powershell, assert_match_args, heredoc_script).


##### `tests::test_powershell_heredoc_no_profile`  (lines 604–610)

```
async fn test_powershell_heredoc_no_profile()
```

**Purpose**: Verifies that PowerShell invocations with `-NoProfile` are accepted. It specifically covers the optional skip-flag logic.

**Data flow**: Builds the canonical heredoc script, wraps it with `args_powershell_no_profile`, and asserts successful parsing with no workdir.

**Call relations**: This test targets the `can_skip_flag` path in `parse_shell_script`.

*Call graph*: 3 external calls (args_powershell_no_profile, assert_match_args, heredoc_script).


##### `tests::test_pwsh_heredoc`  (lines 612–615)

```
async fn test_pwsh_heredoc()
```

**Purpose**: Verifies that `pwsh -NoProfile -Command` is accepted and parsed. It covers PowerShell Core naming plus skip-flag handling.

**Data flow**: Builds the canonical heredoc script, wraps it with `args_pwsh`, and asserts successful parsing with no workdir.

**Call relations**: This test complements the Windows PowerShell tests with the `pwsh` executable name.

*Call graph*: 3 external calls (args_pwsh, assert_match_args, heredoc_script).


##### `tests::test_cmd_heredoc_with_cd`  (lines 618–621)

```
async fn test_cmd_heredoc_with_cd()
```

**Purpose**: Verifies that a `cmd.exe /c` wrapper containing `cd foo && apply_patch <<...` is recognized and yields `workdir = Some("foo")`. It covers the Cmd shell classification branch plus workdir extraction.

**Data flow**: Builds a heredoc script prefixed with `cd foo && `, wraps it with `args_cmd`, and asserts successful parsing with expected workdir `foo`.

**Call relations**: This test exercises both shell classification for Cmd and the `cd`-capture branch of the Tree-sitter query.

*Call graph*: 3 external calls (args_cmd, assert_match_args, heredoc_script).


##### `tests::test_heredoc_with_leading_cd`  (lines 624–626)

```
async fn test_heredoc_with_leading_cd()
```

**Purpose**: Verifies that a Bash heredoc script prefixed by `cd foo &&` is recognized and records the workdir. It is the positive Unix counterpart to the cmd test.

**Data flow**: Builds the prefixed heredoc script and passes it to `assert_match` expecting `Some("foo")`.

**Call relations**: This test uses the shared positive helper to cover the `cd` variant of the Bash query.

*Call graph*: 2 external calls (assert_match, heredoc_script).


##### `tests::test_cd_with_semicolon_is_ignored`  (lines 629–631)

```
async fn test_cd_with_semicolon_is_ignored()
```

**Purpose**: Ensures `cd foo; apply_patch ...` does not match because only `&&` is allowed between `cd` and `apply_patch`. It enforces the strict connector rule.

**Data flow**: Builds a heredoc script prefixed with `cd foo; ` and asserts `maybe_parse_apply_patch` returns `NotApplyPatch` via `assert_not_match`.

**Call relations**: This negative test exercises the query's refusal to match semicolon-separated commands.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_or_apply_patch_is_ignored`  (lines 634–636)

```
async fn test_cd_or_apply_patch_is_ignored()
```

**Purpose**: Ensures `cd bar || apply_patch ...` is ignored. It prevents alternate shell control-flow operators from being misinterpreted as the supported `cd && apply_patch` form.

**Data flow**: Builds a heredoc script prefixed with `cd bar || ` and asserts non-match with `assert_not_match`.

**Call relations**: This test covers another negative connector case in the shell query.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_pipe_apply_patch_is_ignored`  (lines 639–641)

```
async fn test_cd_pipe_apply_patch_is_ignored()
```

**Purpose**: Ensures `cd bar | apply_patch ...` is ignored. It prevents pipeline syntax from matching the strict allowed form.

**Data flow**: Builds a heredoc script prefixed with `cd bar | ` and asserts `NotApplyPatch`.

**Call relations**: This is another negative strictness test for shell parsing.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_single_quoted_path_with_spaces`  (lines 644–646)

```
async fn test_cd_single_quoted_path_with_spaces()
```

**Purpose**: Verifies that a single-quoted `cd 'foo bar' && apply_patch ...` path is captured correctly. It covers raw-string path extraction and quote stripping.

**Data flow**: Builds the prefixed heredoc script and asserts successful parsing with expected workdir `foo bar`.

**Call relations**: This test exercises the `cd_raw_string` capture handling in `extract_apply_patch_from_bash`.

*Call graph*: 2 external calls (assert_match, heredoc_script).


##### `tests::test_cd_double_quoted_path_with_spaces`  (lines 649–651)

```
async fn test_cd_double_quoted_path_with_spaces()
```

**Purpose**: Verifies that a double-quoted `cd "foo bar" && apply_patch ...` path is captured correctly. It covers string-content path extraction.

**Data flow**: Builds the prefixed heredoc script and asserts successful parsing with expected workdir `foo bar`.

**Call relations**: This test exercises the `cd_path` capture branch for quoted strings.

*Call graph*: 2 external calls (assert_match, heredoc_script).


##### `tests::test_echo_and_apply_patch_is_ignored`  (lines 654–656)

```
async fn test_echo_and_apply_patch_is_ignored()
```

**Purpose**: Ensures a script beginning with `echo foo &&` before `apply_patch` does not match. It enforces that only the allowed top-level forms are recognized.

**Data flow**: Builds a heredoc script prefixed with `echo foo && ` and asserts `NotApplyPatch`.

**Call relations**: This negative test validates that unrelated leading commands prevent a match.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_apply_patch_with_arg_is_ignored`  (lines 659–662)

```
async fn test_apply_patch_with_arg_is_ignored()
```

**Purpose**: Ensures `apply_patch foo <<'PATCH' ...` is ignored because the heredoc form must not include extra positional arguments. It enforces the exact command shape.

**Data flow**: Constructs a script string with an extra `foo` argument before the heredoc redirect and asserts non-match with `assert_not_match`.

**Call relations**: This test covers the query's restriction to a bare command name before the heredoc redirect.

*Call graph*: 1 external calls (assert_not_match).


##### `tests::test_double_cd_then_apply_patch_is_ignored`  (lines 665–667)

```
async fn test_double_cd_then_apply_patch_is_ignored()
```

**Purpose**: Ensures `cd foo && cd bar && apply_patch ...` is ignored. It prevents multi-command prefixes from matching the single-`cd` allowed form.

**Data flow**: Builds the doubly-prefixed heredoc script and asserts `NotApplyPatch`.

**Call relations**: This negative test validates the whole-script strictness of the Tree-sitter query.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_two_args_is_ignored`  (lines 670–672)

```
async fn test_cd_two_args_is_ignored()
```

**Purpose**: Ensures `cd foo bar && apply_patch ...` is ignored because only one positional `cd` argument is allowed. It enforces the exact `cd` argument shape.

**Data flow**: Builds the invalid `cd`-with-two-args heredoc script and asserts non-match.

**Call relations**: This test covers the query's restriction on `cd` argument count.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_then_apply_patch_then_extra_is_ignored`  (lines 675–678)

```
async fn test_cd_then_apply_patch_then_extra_is_ignored()
```

**Purpose**: Ensures trailing commands after a valid-looking `cd && apply_patch` heredoc cause the whole script to be ignored. It enforces that the matched statement be the only top-level statement.

**Data flow**: Builds a script with prefix `cd bar && ` and suffix ` && echo done` using `heredoc_script_ps`, then asserts `NotApplyPatch`.

**Call relations**: This negative test targets the query anchors that forbid trailing commands.

*Call graph*: 2 external calls (assert_not_match, heredoc_script_ps).


##### `tests::test_echo_then_cd_and_apply_patch_is_ignored`  (lines 681–684)

```
async fn test_echo_then_cd_and_apply_patch_is_ignored()
```

**Purpose**: Ensures preceding commands before `cd ... && apply_patch` prevent a match. It validates the query anchors that forbid leading top-level statements.

**Data flow**: Builds a script prefixed with `echo foo; cd bar && ` and asserts non-match.

**Call relations**: This test complements the trailing-command rejection case by covering leading-command rejection.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_unified_diff_last_line_replacement`  (lines 687–726)

```
async fn test_unified_diff_last_line_replacement()
```

**Purpose**: Verifies unified-diff generation for replacing the last line of a file. It checks EOF-sensitive diff formatting.

**Data flow**: Creates a temp file `last.txt` with three lines, builds and parses an update patch replacing `baz` with `BAZ`, extracts the update chunks, computes an absolute path, calls `unified_diff_from_chunks`, and asserts the returned `ApplyPatchFileUpdate` equals the expected unified diff, original content, and new content.

**Call relations**: This async unit test exercises the verifier-side diff computation used by `verify_apply_patch_args`.

*Call graph*: calls 1 internal fn (parse_patch); 7 external calls (wrap_patch, assert_eq!, unified_diff_from_chunks, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_insert_at_eof`  (lines 729–765)

```
async fn test_unified_diff_insert_at_eof()
```

**Purpose**: Verifies unified-diff generation for inserting a line at end-of-file. It covers the `*** End of File` chunk semantics.

**Data flow**: Creates a temp file `insert.txt`, builds and parses an update patch that appends `quux`, extracts chunks, computes the absolute path, calls `unified_diff_from_chunks`, and asserts the returned diff and contents match the expected EOF insertion result.

**Call relations**: This test complements the last-line replacement case by covering pure EOF insertion.

*Call graph*: calls 1 internal fn (parse_patch); 7 external calls (wrap_patch, assert_eq!, unified_diff_from_chunks, format!, write, panic!, tempdir).


##### `tests::test_apply_patch_should_resolve_absolute_paths_in_cwd`  (lines 768–817)

```
async fn test_apply_patch_should_resolve_absolute_paths_in_cwd()
```

**Purpose**: Verifies that verification resolves relative patch paths against the provided cwd and reads the correct file contents from that directory. It guards against accidentally resolving relative paths elsewhere.

**Data flow**: Creates a temp session directory and a file `source.txt` inside it, builds direct `apply_patch` argv updating that relative path, calls `maybe_parse_apply_patch_verified` with the session directory as absolute cwd, and asserts the result is `MaybeApplyPatchVerified::Body` containing an `ApplyPatchAction` whose `changes` map keys the session file path and whose update change contains the expected unified diff and new content.

**Call relations**: This test exercises the verified parsing path end-to-end, including cwd-relative resolution and diff computation.

*Call graph*: calls 2 internal fn (maybe_parse_apply_patch_verified, from_absolute_path); 4 external calls (assert_eq!, write, tempdir, vec!).


##### `tests::test_apply_patch_resolves_move_path_with_effective_cwd`  (lines 820–871)

```
async fn test_apply_patch_resolves_move_path_with_effective_cwd()
```

**Purpose**: Verifies that when a shell heredoc includes `cd <worktree> && apply_patch`, both the source path and `*** Move to:` destination are resolved against that effective cwd. It checks move-path rebasing under shell-extracted workdirs.

**Data flow**: Creates a temp session directory with subdirectory `alt`, writes `old.txt` there, builds a patch that updates and moves it to `renamed.txt`, wraps that patch in a Bash script prefixed by `cd alt &&`, and calls `maybe_parse_apply_patch_verified` with the session directory as cwd. It extracts the resulting `ApplyPatchAction`, asserts `action.cwd` equals the `alt` directory, looks up the source-path change in `action.changes()`, and asserts the `Update` variant's `move_path` equals `alt/renamed.txt`.

**Call relations**: This test specifically exercises the interaction between shell workdir extraction in `maybe_parse_apply_patch` and path resolution in `verify_apply_patch_args`.

*Call graph*: calls 2 internal fn (maybe_parse_apply_patch_verified, from_absolute_path); 8 external calls (wrap_patch, assert_eq!, format!, create_dir_all, write, panic!, tempdir, vec!).


##### `tests::test_unreadable_destinations_still_verify`  (lines 874–899)

```
async fn test_unreadable_destinations_still_verify()
```

**Purpose**: Verifies that verification succeeds even when an add destination or move destination already exists as unreadable binary data. Verification should describe the intended change without requiring destination text readability.

**Data flow**: Creates a temp directory, writes unreadable bytes to `binary.dat`, prepares one add-file argv targeting that path and one move/update argv moving `source.txt` to that path, and for each argv calls `maybe_parse_apply_patch_verified` with the temp cwd. It asserts each result matches `MaybeApplyPatchVerified::Body(_)`.

**Call relations**: This test covers a permissive verification edge case in `verify_apply_patch_args`, especially around destination overwrite handling.

*Call graph*: calls 2 internal fn (maybe_parse_apply_patch_verified, from_absolute_path); 4 external calls (assert!, write, tempdir, vec!).


##### `tests::test_delete_symlink_still_verifies`  (lines 903–927)

```
async fn test_delete_symlink_still_verifies()
```

**Purpose**: Verifies that deleting a symlink still passes verification. The verifier should describe the delete action even if later delta exactness during application may be inexact.

**Data flow**: On Unix, creates a temp directory, writes a target file, creates a symlink `link.txt` to it, builds direct `apply_patch` argv deleting `link.txt`, calls `maybe_parse_apply_patch_verified`, and asserts the result is `MaybeApplyPatchVerified::Body(_)`.

**Call relations**: This test exercises verification behavior for symlink deletes, complementing application-time tests in `lib.rs` that track exactness.

*Call graph*: calls 2 internal fn (maybe_parse_apply_patch_verified, from_absolute_path); 4 external calls (assert!, write, tempdir, vec!).


### Patch execution engines
These files perform the actual patch application work, either through the native patch engine or via git-backed unified-diff application.

### `apply-patch/src/lib.rs`

`domain_logic` · `request handling`

This crate root defines the public patch-application data model and the functions that actually mutate files. `ApplyPatchError`, `IoError`, `ApplyPatchArgs`, `ApplyPatchFileChange`, `MaybeApplyPatchVerified`, `ApplyPatchAction`, `AppliedPatchDelta`, `AppliedPatchChange`, `AppliedPatchFileChange`, and `ApplyPatchFailure` capture parse/verification errors, intended actions, and the exact-or-inexact textual mutations that were definitely committed before success or failure. `apply_patch` parses raw patch text with `parse_patch`, prints human-readable parse errors to stderr, and delegates to `apply_hunks`. `apply_hunks` applies parsed hunks through `apply_hunks_to_files`, prints a git-style summary on success, and wraps any failure together with the accumulated delta. The file-application loop resolves each hunk path against an absolute cwd, reads prior contents when needed, writes added or updated files, removes deleted or moved sources, and carefully downgrades delta exactness when metadata or content cannot be read reliably or when a write/remove may have had side effects before failing. Update hunks are transformed by `derive_new_contents_from_chunks`, which reads the original file, splits it into lines, computes replacement spans with `compute_replacements` using `seek_sequence`, and applies them in reverse order with `apply_replacements`. Unified diffs are generated from original and derived contents via `similar::TextDiff`. Helper functions enforce non-directory deletes, retry writes after creating missing parent directories, and detect whether failed removals were side-effect free. The extensive tests cover add/delete/update/move behavior, mixed relative and absolute paths, multi-chunk updates, EOF insertions, Unicode punctuation matching, unified-diff formatting, partial-failure delta reporting, and inexactness for unreadable destinations or symlink deletes.

#### Function details

##### `ApplyPatchError::from`  (lines 70–75)

```
fn from(err: &std::io::Error) -> Self
```

**Purpose**: Converts a borrowed `std::io::Error` into an owned `ApplyPatchError::IoError` with generic context. It preserves the original error kind and message while avoiding lifetime issues.

**Data flow**: Accepts `&std::io::Error`, constructs a new owned `std::io::Error` from `err.kind()` and `err.to_string()`, wraps it in `IoError { context: "I/O error" }`, and returns `ApplyPatchError::IoError`.

**Call relations**: This conversion is used by `apply_hunks` when turning write-to-stdout/stderr failures or downcasted I/O failures into the crate's error type.

*Call graph*: called by 1 (apply_hunks); 4 external calls (IoError, kind, new, to_string).


##### `IoError::eq`  (lines 87–89)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Defines equality for `IoError` based on context string and rendered source error text rather than exact `std::io::Error` identity. This makes tests stable across reconstructed I/O errors.

**Data flow**: Compares `self.context` to `other.context` and `self.source.to_string()` to `other.source.to_string()`, returning a boolean.

**Call relations**: This method underlies `PartialEq` for `IoError`, enabling equality assertions on higher-level error values in tests.

*Call graph*: 1 external calls (to_string).


##### `ApplyPatchAction::is_empty`  (lines 149–151)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether a verified patch action contains no file changes. It is a simple convenience query over the internal changes map.

**Data flow**: Reads `self.changes.is_empty()` and returns the boolean result without mutation.

**Call relations**: This method is used by downstream safety-assessment logic outside this file to detect no-op patch actions.

*Call graph*: called by 1 (assess_patch_safety).


##### `ApplyPatchAction::changes`  (lines 154–156)

```
fn changes(&self) -> &HashMap<PathBuf, ApplyPatchFileChange>
```

**Purpose**: Exposes the verified patch action's absolute-path change map for inspection. It provides read-only access to the planned file mutations.

**Data flow**: Returns `&HashMap<PathBuf, ApplyPatchFileChange>` referencing `self.changes`.

**Call relations**: This accessor is used by downstream protocol conversion and policy checks, and by tests that inspect verified actions.

*Call graph*: called by 3 (convert_apply_patch_to_protocol, is_write_patch_constrained_to_writable_paths, file_paths_for_action).


##### `ApplyPatchAction::new_add_for_test`  (lines 160–180)

```
fn new_add_for_test(path: &AbsolutePathBuf, content: String) -> Self
```

**Purpose**: Constructs a synthetic single-file add action for tests without going through parsing. It fabricates both the patch text and the internal change map from an absolute path and content.

**Data flow**: Accepts an absolute path and content string, extracts the filename and parent directory, formats a minimal patch string referencing that filename, builds a `HashMap` mapping the full path to `ApplyPatchFileChange::Add { content }`, and returns `ApplyPatchAction { changes, cwd: parent, patch }`.

**Call relations**: This helper is used only by tests in other parts of the system that need a ready-made `ApplyPatchAction` fixture.

*Call graph*: calls 2 internal fn (parent, to_path_buf); called by 14 (convert_apply_patch_maps_add_variant, explicit_read_only_subpaths_prevent_auto_approval_for_external_sandbox, explicit_unreadable_paths_prevent_auto_approval_for_external_sandbox, external_sandbox_auto_approves_in_on_request, granular_sandbox_approval_false_rejects_out_of_root_patch, granular_with_all_flags_true_matches_on_request_for_out_of_root_patch, missing_project_dot_codex_config_requires_approval, read_only_policy_rejects_patch_with_read_only_reason, approval_keys_include_environment_id, file_system_sandbox_context_uses_active_attempt (+4 more)); 3 external calls (from, format!, file_name).


##### `AppliedPatchDelta::new`  (lines 191–193)

```
fn new(changes: Vec<AppliedPatchChange>, exact: bool) -> Self
```

**Purpose**: Creates an `AppliedPatchDelta` from an ordered list of committed changes and an exactness flag. It is the internal constructor for delta values.

**Data flow**: Consumes a `Vec<AppliedPatchChange>` and `bool exact`, stores them in `Self { changes, exact }`, and returns the new delta.

**Call relations**: Used internally by `empty` and by tests that assert exact delta contents.


##### `AppliedPatchDelta::empty`  (lines 195–197)

```
fn empty() -> Self
```

**Purpose**: Constructs an empty, exact delta representing no committed changes. It is the default starting state before patch application begins.

**Data flow**: Calls `AppliedPatchDelta::new(Vec::new(), true)` and returns the result.

**Call relations**: Used by `ApplyPatchFailure::without_delta`, `apply_hunks`, and the `Default` impl.

*Call graph*: called by 2 (without_delta, apply_hunks); 2 external calls (new, new).


##### `AppliedPatchDelta::changes`  (lines 199–201)

```
fn changes(&self) -> &[AppliedPatchChange]
```

**Purpose**: Returns the ordered list of committed file changes recorded in the delta. It preserves application order for downstream consumers.

**Data flow**: Returns a slice reference `&[AppliedPatchChange]` over `self.changes`.

**Call relations**: Used by downstream tracking logic outside this file to inspect committed mutations.

*Call graph*: called by 1 (track_delta).


##### `AppliedPatchDelta::is_empty`  (lines 203–205)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether the delta contains no committed changes. It is a convenience query over the internal change list.

**Data flow**: Returns `self.changes.is_empty()`.

**Call relations**: Used by downstream tracker logic to distinguish no-op deltas from partial or full mutations.

*Call graph*: called by 1 (tracker_update_for_known_delta).


##### `AppliedPatchDelta::is_exact`  (lines 207–209)

```
fn is_exact(&self) -> bool
```

**Purpose**: Reports whether the delta is known to exactly describe all committed textual mutations. It distinguishes precise deltas from best-effort ones after unreadable files or uncertain failures.

**Data flow**: Returns the stored `self.exact` boolean.

**Call relations**: Used by downstream tracker logic and tests that assert exactness behavior.

*Call graph*: called by 2 (tracker_update_for_known_delta, track_delta).


##### `AppliedPatchDelta::append`  (lines 212–215)

```
fn append(&mut self, other: Self)
```

**Purpose**: Appends another committed delta to this one while preserving aggregate exactness. It supports accumulation across multiple patch-application phases.

**Data flow**: Extends `self.changes` with `other.changes` and updates `self.exact` by logical-AND with `other.exact`.

**Call relations**: Used by higher-level orchestration outside this file when combining deltas from multiple operations.

*Call graph*: called by 1 (run).


##### `AppliedPatchDelta::default`  (lines 219–221)

```
fn default() -> Self
```

**Purpose**: Provides the default empty exact delta. It makes `AppliedPatchDelta` usable with generic default-based APIs.

**Data flow**: Delegates to `AppliedPatchDelta::empty()` and returns that value.

**Call relations**: This trait impl is used implicitly where a default delta is needed.

*Call graph*: 1 external calls (empty).


##### `ApplyPatchFailure::new`  (lines 259–261)

```
fn new(error: ApplyPatchError, delta: AppliedPatchDelta) -> Self
```

**Purpose**: Constructs a patch-application failure from an error and the delta committed before that error was observed. It is the main failure wrapper constructor.

**Data flow**: Consumes an `ApplyPatchError` and `AppliedPatchDelta`, stores them in `Self { error, delta }`, and returns the failure.

**Call relations**: Used by `apply_hunks` when wrapping either summary-print failures or filesystem/application failures.

*Call graph*: called by 1 (apply_hunks).


##### `ApplyPatchFailure::without_delta`  (lines 263–265)

```
fn without_delta(error: ApplyPatchError) -> Self
```

**Purpose**: Constructs a failure with an empty exact delta for errors that occur before any file mutation could have happened. It is used for parse-time and early stderr-write failures.

**Data flow**: Calls `AppliedPatchDelta::empty()` and `ApplyPatchFailure::new(error, empty_delta)` to produce the failure.

**Call relations**: Used by `apply_patch` when parse errors occur before hunk application begins.

*Call graph*: calls 1 internal fn (empty); called by 1 (apply_patch); 1 external calls (new).


##### `ApplyPatchFailure::delta`  (lines 267–269)

```
fn delta(&self) -> &AppliedPatchDelta
```

**Purpose**: Returns the committed delta associated with a failure. It lets callers inspect what definitely changed before the error.

**Data flow**: Returns `&AppliedPatchDelta` referencing `self.delta`.

**Call relations**: Used by tests and downstream callers that need partial-commit information after failure.


##### `ApplyPatchFailure::into_parts`  (lines 271–273)

```
fn into_parts(self) -> (ApplyPatchError, AppliedPatchDelta)
```

**Purpose**: Consumes the failure and returns its error and delta separately. It is useful when callers want ownership of both pieces.

**Data flow**: Moves out `self.error` and `self.delta` and returns them as a tuple.

**Call relations**: Available to downstream consumers; not used internally in this file.


##### `apply_patch`  (lines 277–313)

```
async fn apply_patch(
    patch: &str,
    cwd: &AbsolutePathBuf,
    stdout: &mut impl std::io::Write,
    stderr: &mut impl std::io::Write,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&File
```

**Purpose**: Parses raw patch text, prints parse diagnostics to stderr on failure, and applies the resulting hunks on success. It is the main public entry point for patch application.

**Data flow**: Accepts patch text, absolute cwd, mutable stdout/stderr writers, filesystem, and optional sandbox. It calls `parse_patch`; on `InvalidPatchError` or `InvalidHunkError` it writes a human-readable message to stderr and returns `ApplyPatchFailure::without_delta(ParseError)`. On successful parse it extracts `source.hunks` and delegates to `apply_hunks`, returning that result.

**Call relations**: This is the primary public API used by the standalone executable and many tests. It sits above parsing and below the actual hunk-application engine in `apply_hunks`.

*Call graph*: calls 3 internal fn (without_delta, apply_hunks, parse_patch); called by 14 (test_add_file_hunk_creates_file_with_contents, test_apply_patch_fails_on_write_error, test_apply_patch_hunks_accept_relative_and_absolute_paths, test_delete_file_hunk_removes_file, test_delete_symlink_returns_inexact_delta, test_failed_move_returns_committed_destination_delta, test_multiple_update_chunks_apply_to_single_file, test_pure_addition_chunk_followed_by_removal, test_unified_diff_interleaved_changes, test_unreadable_destinations_return_inexact_delta (+4 more)); 2 external calls (ParseError, writeln!).


##### `apply_hunks`  (lines 316–348)

```
async fn apply_hunks(
    hunks: &[Hunk],
    cwd: &AbsolutePathBuf,
    stdout: &mut impl std::io::Write,
    stderr: &mut impl std::io::Write,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&F
```

**Purpose**: Applies already-parsed hunks, prints a success summary on stdout, and wraps any failure together with the accumulated committed delta. It is the parsed-hunk counterpart to `apply_patch`.

**Data flow**: Accepts a hunk slice, cwd, stdout/stderr writers, filesystem, and sandbox. It initializes `delta = AppliedPatchDelta::empty()`, calls `apply_hunks_to_files`, and on success passes the returned `AffectedPaths` to `print_summary`; summary-write failures are wrapped with the current delta. On application failure it writes the error message to stderr, converts the underlying error into `ApplyPatchError` either by downcasting to `std::io::Error` or wrapping it in `IoError { context: msg, source: std::io::Error::other(error) }`, and returns `ApplyPatchFailure::new(error, delta)`.

**Call relations**: Called by `apply_patch` after parsing succeeds. It delegates filesystem mutation to `apply_hunks_to_files` and user-facing output to `print_summary`.

*Call graph*: calls 5 internal fn (empty, from, new, apply_hunks_to_files, print_summary); called by 1 (apply_patch); 3 external calls (IoError, other, writeln!).


##### `apply_hunks_to_files`  (lines 362–552)

```
async fn apply_hunks_to_files(
    hunks: &[Hunk],
    cwd: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
    delta: &mut AppliedPatchDelta,
) -> a
```

**Purpose**: Performs the actual filesystem mutations for each parsed hunk while recording affected paths and committed delta information. It is the core mutation loop of the patch engine.

**Data flow**: Accepts hunks, cwd, filesystem, sandbox, and a mutable `AppliedPatchDelta`. It rejects an empty hunk list with `No files were modified.`. For each hunk it resolves the absolute path and user-facing patch path. `AddFile` reads any overwritten destination text with `read_optional_file_text_for_delta`, writes the new file with `write_file_with_missing_parent_retry`, records an `AppliedPatchChange::Add`, and pushes the patch path into `added`. `DeleteFile` notes delta-support metadata, reads existing text if possible, rejects directories via `ensure_not_directory`, removes the file, downgrades exactness if removal may have had side effects, records a `Delete` change when content was readable, and pushes the patch path into `deleted`. `UpdateFile` derives original and new contents with `derive_new_contents_from_chunks`; for moves it resolves the destination against cwd, reads any overwritten destination text, writes the destination, tentatively records an add, removes the source, then rewrites that delta entry into an `Update { move_path, old_content, overwritten_move_content, new_content }`; for in-place updates it writes the new contents directly and records an `Update` change. Any write failure marks `delta.exact = false` before returning the error. On success it returns `AffectedPaths { added, modified, deleted }`.

**Call relations**: This internal async function is called only by `apply_hunks`. It delegates path/content helpers to `derive_new_contents_from_chunks`, `ensure_not_directory`, `read_optional_file_text_for_delta`, `note_existing_path_delta_support`, `remove_failure_was_side_effect_free`, and `write_file_with_missing_parent_retry`.

*Call graph*: calls 8 internal fn (derive_new_contents_from_chunks, ensure_not_directory, note_existing_path_delta_support, read_optional_file_text_for_delta, remove_failure_was_side_effect_free, read_file_text, resolve_path_against_base, from_abs_path); called by 1 (apply_hunks); 5 external calls (new, bail!, is_empty, remove, try_write!).


##### `ensure_not_directory`  (lines 554–568)

```
async fn ensure_not_directory(
    path: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> io::Result<()>
```

**Purpose**: Rejects delete or move-source operations when the target path is a directory. It prevents file-oriented patch hunks from operating on directories.

**Data flow**: Converts the absolute path to `PathUri`, fetches metadata through `ExecutorFileSystem::get_metadata`, and returns an `io::ErrorKind::InvalidInput` error with message `path is a directory` if `metadata.is_directory` is true; otherwise returns `Ok(())`.

**Call relations**: Called by `apply_hunks_to_files` before deleting files or removing move sources.

*Call graph*: calls 1 internal fn (from_abs_path); called by 1 (apply_hunks_to_files); 2 external calls (new, get_metadata).


##### `remove_failure_was_side_effect_free`  (lines 570–584)

```
async fn remove_failure_was_side_effect_free(
    path: &AbsolutePathBuf,
    expected_content: Option<&str>,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> bool
```

**Purpose**: Best-effort checks whether a failed remove operation left the file contents unchanged. It helps decide whether delta exactness can be preserved after a removal error.

**Data flow**: Accepts a path, optional expected content, filesystem, and sandbox. If expected content is present, it rereads the file text and returns `true` only if the read succeeds and the content still matches; if no expected content is available it returns `false`.

**Call relations**: Used by `apply_hunks_to_files` when a delete or move-source removal fails after earlier reads, to decide whether `delta.exact` should remain true.

*Call graph*: calls 2 internal fn (read_file_text, from_abs_path); called by 1 (apply_hunks_to_files).


##### `read_optional_file_text_for_delta`  (lines 586–602)

```
async fn read_optional_file_text_for_delta(
    path: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
    exact: &mut bool,
) -> Option<String>
```

**Purpose**: Reads existing destination text for delta tracking while tolerating missing files and downgrading exactness on unreadable paths. It is used before overwriting add or move destinations.

**Data flow**: Calls `note_existing_path_delta_support` to update exactness based on metadata, converts the path to `PathUri`, and attempts `read_file_text`. A successful read returns `Some(content)`, `NotFound` returns `None`, and any other error sets `*exact = false` and returns `None`.

**Call relations**: Called by `apply_hunks_to_files` before add-file writes and move-destination writes.

*Call graph*: calls 3 internal fn (note_existing_path_delta_support, read_file_text, from_abs_path); called by 1 (apply_hunks_to_files).


##### `note_existing_path_delta_support`  (lines 604–617)

```
async fn note_existing_path_delta_support(
    path: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
    exact: &mut bool,
)
```

**Purpose**: Updates the delta exactness flag based on whether an existing path is a regular non-symlink file whose contents can be tracked precisely. It marks exactness false for directories, symlinks, and metadata errors other than not-found.

**Data flow**: Converts the path to `PathUri`, fetches metadata, and leaves `exact` unchanged only when metadata says the path is a regular file and not a symlink or when the path is absent. Any other metadata shape or error sets `*exact = false`.

**Call relations**: Called by both `apply_hunks_to_files` and `read_optional_file_text_for_delta` before content reads or overwrites.

*Call graph*: calls 1 internal fn (from_abs_path); called by 2 (apply_hunks_to_files, read_optional_file_text_for_delta); 1 external calls (get_metadata).


##### `write_file_with_missing_parent_retry`  (lines 619–653)

```
async fn write_file_with_missing_parent_retry(
    fs: &dyn ExecutorFileSystem,
    path_abs: &AbsolutePathBuf,
    contents: Vec<u8>,
    sandbox: Option<&FileSystemSandboxContext>,
) -> anyhow::Resu
```

**Purpose**: Writes a file, creating missing parent directories on a first `NotFound` failure. It smooths over add and move operations that target paths in not-yet-created directories.

**Data flow**: Converts the absolute path to `PathUri` and first attempts `fs.write_file`. If it succeeds, returns `Ok(())`. If it fails with `io::ErrorKind::NotFound`, it computes the parent path, creates that directory recursively with `fs.create_directory`, then retries `write_file`; both operations add contextual error messages mentioning the target path. Any other initial write error is returned with `Failed to write file ...` context.

**Call relations**: Called by `apply_hunks_to_files` for add-file writes and move-destination writes. It encapsulates the create-parent-and-retry pattern.

*Call graph*: calls 2 internal fn (parent, from_abs_path); 2 external calls (create_directory, write_file).


##### `derive_new_contents_from_chunks`  (lines 662–695)

```
async fn derive_new_contents_from_chunks(
    path_abs: &AbsolutePathBuf,
    chunks: &[UpdateFileChunk],
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> std::res
```

**Purpose**: Reads the original file and computes the full new file contents implied by update chunks without writing anything. It is the shared engine behind in-place updates, moves, and unified-diff generation.

**Data flow**: Accepts an absolute path, update chunks, filesystem, and sandbox. It reads the original file text, wrapping read failures in `ApplyPatchError::IoError` with `Failed to read file to update ...` context. It splits the original contents on `\n` into `Vec<String>`, removes the trailing empty element if present to align line counts with diff behavior, computes replacement spans with `compute_replacements`, applies them with `apply_replacements`, ensures the resulting line vector ends with an empty string so the final content has a trailing newline, joins lines back with `\n`, and returns `AppliedPatch { original_contents, new_contents }`.

**Call relations**: Called by `apply_hunks_to_files` for update hunks and by `unified_diff_from_chunks_with_context` for diff generation. It delegates matching logic to `compute_replacements` and splice application to `apply_replacements`.

*Call graph*: calls 5 internal fn (apply_replacements, compute_replacements, read_file_text, as_path, from_abs_path); called by 2 (apply_hunks_to_files, unified_diff_from_chunks_with_context); 1 external calls (new).


##### `compute_replacements`  (lines 700–788)

```
fn compute_replacements(
    original_lines: &[String],
    path: &Path,
    chunks: &[UpdateFileChunk],
) -> std::result::Result<Vec<(usize, usize, Vec<String>)>, ApplyPatchError>
```

**Purpose**: Translates parsed update chunks into concrete replacement operations over the original file's line vector. It is responsible for locating context and old-line sequences, including EOF-sensitive fallback behavior.

**Data flow**: Accepts original lines, the file path for error messages, and update chunks. It maintains a `line_index` cursor and an output vector of `(start_index, old_len, new_lines)` replacements. For chunks with `change_context`, it uses `seek_sequence` to find that context line at or after `line_index`, advancing the cursor or returning `ComputeReplacements("Failed to find context ...")`. For pure additions (`old_lines.is_empty()`), it schedules insertion at EOF or before a trailing empty line. For replacement/removal chunks, it searches for `old_lines` with `seek_sequence`; if not found and the pattern ends with an empty string sentinel, it retries without that trailing empty line and similarly trims `new_lines`' trailing empty line. On success it records the replacement and advances `line_index`; on failure it returns `ComputeReplacements("Failed to find expected lines in ...")`. Finally it sorts replacements by start index and returns them.

**Call relations**: Called only by `derive_new_contents_from_chunks`. It depends on `seek_sequence::seek_sequence` for fuzzy location of context and old-line patterns.

*Call graph*: calls 1 internal fn (seek_sequence); called by 1 (derive_new_contents_from_chunks); 4 external calls (new, ComputeReplacements, format!, from_ref).


##### `apply_replacements`  (lines 792–816)

```
fn apply_replacements(
    mut lines: Vec<String>,
    replacements: &[(usize, usize, Vec<String>)],
) -> Vec<String>
```

**Purpose**: Applies computed replacement spans to a line vector to produce the updated file contents. It performs the actual splice logic after matching is complete.

**Data flow**: Consumes a mutable `Vec<String>` of original lines and a slice of replacements. It iterates over replacements in reverse order, removes `old_len` lines starting at `start_idx`, then inserts each `new_segment` line at the same position in order. It returns the modified line vector.

**Call relations**: Called only by `derive_new_contents_from_chunks` after `compute_replacements` has produced sorted replacement spans.

*Call graph*: called by 1 (derive_new_contents_from_chunks).


##### `unified_diff_from_chunks`  (lines 826–833)

```
async fn unified_diff_from_chunks(
    path_abs: &AbsolutePathBuf,
    chunks: &[UpdateFileChunk],
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> std::result::Re
```

**Purpose**: Computes a one-line-context unified diff and resulting contents for update chunks. It is the convenience wrapper used by most callers.

**Data flow**: Accepts path, chunks, filesystem, and sandbox, then delegates to `unified_diff_from_chunks_with_context` with `context = 1` and returns its result.

**Call relations**: Used by verification code in `invocation.rs` and by multiple tests. It is a thin wrapper over the more general context-parameterized function.

*Call graph*: calls 1 internal fn (unified_diff_from_chunks_with_context); called by 5 (test_unified_diff, test_unified_diff_first_line_replacement, test_unified_diff_insert_at_eof, test_unified_diff_interleaved_changes, test_unified_diff_last_line_replacement).


##### `unified_diff_from_chunks_with_context`  (lines 835–853)

```
async fn unified_diff_from_chunks_with_context(
    path_abs: &AbsolutePathBuf,
    chunks: &[UpdateFileChunk],
    context: usize,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSand
```

**Purpose**: Computes a unified diff with configurable context radius from update chunks without mutating the filesystem. It pairs the diff text with original and resulting file contents.

**Data flow**: Calls `derive_new_contents_from_chunks` to obtain original and new contents, constructs a `similar::TextDiff` from those strings, renders a unified diff with the requested context radius, and returns `ApplyPatchFileUpdate { unified_diff, original_content, content }`.

**Call relations**: Called by `unified_diff_from_chunks`. It shares the same content-derivation engine used by actual patch application.

*Call graph*: calls 1 internal fn (derive_new_contents_from_chunks); called by 1 (unified_diff_from_chunks); 1 external calls (from_lines).


##### `print_summary`  (lines 857–872)

```
fn print_summary(
    affected: &AffectedPaths,
    out: &mut impl std::io::Write,
) -> std::io::Result<()>
```

**Purpose**: Writes a git-style summary of added, modified, and deleted files after successful patch application. It is the user-facing success output formatter.

**Data flow**: Accepts `AffectedPaths` and a mutable writer, writes `Success. Updated the following files:` followed by one `A path`, `M path`, or `D path` line for each path in the corresponding vectors, and returns `std::io::Result<()>`.

**Call relations**: Called by `apply_hunks` after `apply_hunks_to_files` succeeds. It is the final stdout step of successful application.

*Call graph*: called by 1 (apply_hunks); 1 external calls (writeln!).


##### `tests::wrap_patch`  (lines 885–887)

```
fn wrap_patch(body: &str) -> String
```

**Purpose**: Builds a complete patch string from a body for unit tests in this module. It keeps test fixtures concise and readable.

**Data flow**: Interpolates the supplied body between `*** Begin Patch` and `*** End Patch` and returns the resulting `String`.

**Call relations**: Used throughout the module's tests when constructing patch text.

*Call graph*: 1 external calls (format!).


##### `tests::test_add_file_hunk_creates_file_with_contents`  (lines 890–922)

```
async fn test_add_file_hunk_creates_file_with_contents()
```

**Purpose**: Verifies that an add-file hunk creates the file, writes the expected contents, and prints the correct success summary with no stderr output. It is the baseline add-path application test.

**Data flow**: Creates a temp directory and target path, builds an add-file patch, allocates stdout/stderr buffers, calls `apply_patch`, then decodes the buffers and asserts stdout equals `Success...\nA <path>\n`, stderr is empty, and the created file contains `ab\ncd\n`.

**Call relations**: This async unit test exercises the full public `apply_patch` entry point on the add-file path.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 7 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, tempdir).


##### `tests::test_apply_patch_hunks_accept_relative_and_absolute_paths`  (lines 925–994)

```
async fn test_apply_patch_hunks_accept_relative_and_absolute_paths()
```

**Purpose**: Verifies that add, delete, and update hunks work with both relative and absolute file paths in the same patch. It also checks the summary preserves the patch's original path spelling.

**Data flow**: Creates a temp directory and several files, builds a patch containing relative and absolute add/delete/update hunks, runs `apply_patch`, then asserts the resulting filesystem state for all six files and checks stdout lists relative paths as relative and absolute paths as absolute in the expected order, with empty stderr.

**Call relations**: This test exercises path resolution and summary formatting across mixed path styles.

*Call graph*: calls 1 internal fn (apply_patch); 7 external calls (new, wrap_patch, assert!, assert_eq!, format!, write, tempdir).


##### `tests::test_delete_file_hunk_removes_file`  (lines 997–1023)

```
async fn test_delete_file_hunk_removes_file()
```

**Purpose**: Verifies that a delete-file hunk removes the target file and prints the correct delete summary. It is the baseline delete-path application test.

**Data flow**: Creates a temp file, builds a delete patch, runs `apply_patch`, decodes stdout/stderr, asserts stdout lists `D <path>`, stderr is empty, and the file no longer exists.

**Call relations**: This test covers the delete branch of `apply_hunks_to_files` through the public API.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert!, assert_eq!, format!, write, tempdir).


##### `tests::test_update_file_hunk_modifies_content`  (lines 1026–1061)

```
async fn test_update_file_hunk_modifies_content()
```

**Purpose**: Verifies that an update-file hunk rewrites file contents in place and prints the correct modified summary. It is the baseline update-path application test.

**Data flow**: Creates a temp file with `foo\nbar\n`, builds an update patch replacing `bar` with `baz`, runs `apply_patch`, decodes stdout/stderr, asserts stdout lists `M <path>`, stderr is empty, and the file now contains `foo\nbaz\n`.

**Call relations**: This test exercises the in-place update branch of `apply_hunks_to_files`.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_update_file_hunk_can_move_file`  (lines 1064–1102)

```
async fn test_update_file_hunk_can_move_file()
```

**Purpose**: Verifies that an update hunk with `*** Move to:` writes the destination, removes the source, and reports the destination as modified. It covers move semantics.

**Data flow**: Creates source and destination paths, writes source contents, builds a move/update patch, runs `apply_patch`, decodes stdout/stderr, asserts stdout lists `M <dest>`, stderr is empty, source no longer exists, and destination contains the updated content.

**Call relations**: This test exercises the move branch inside update handling.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 9 external calls (from_utf8, new, wrap_patch, assert!, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_failed_move_returns_committed_destination_delta`  (lines 1106–1157)

```
async fn test_failed_move_returns_committed_destination_delta()
```

**Purpose**: Verifies that if a move writes the destination successfully but fails removing the source, the returned failure includes a committed delta describing the destination write. It checks partial-commit reporting for move failures.

**Data flow**: On Unix, creates locked source and writable destination directories, writes the source file, removes write permission from the source directory, builds a move patch, and runs `apply_patch`, expecting an error. After restoring permissions, it asserts stderr mentions failure to remove the original source, `failure.delta()` equals an exact delta containing one `AppliedPatchChange::Add` for the destination with `line2\n`, and the source and destination files contain the expected old/new contents respectively.

**Call relations**: This test exercises failure handling in `apply_hunks_to_files` and `apply_hunks`, especially the move-source removal error path.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 9 external calls (new, wrap_patch, assert!, assert_eq!, from_mode, create_dir, set_permissions, write, tempdir).


##### `tests::test_multiple_update_chunks_apply_to_single_file`  (lines 1162–1204)

```
async fn test_multiple_update_chunks_apply_to_single_file()
```

**Purpose**: Verifies that multiple update chunks within one hunk can modify separate regions of a file and still produce a single modified summary entry. It checks chunk sequencing and summary deduplication by hunk.

**Data flow**: Creates a four-line file, builds an update patch with two separate `@@` chunks, runs `apply_patch`, decodes stdout/stderr, asserts stdout lists one `M <path>` line, stderr is empty, and the file contents reflect both replacements.

**Call relations**: This test exercises `compute_replacements` and `apply_replacements` across multiple chunks in one file.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_update_file_hunk_interleaved_changes`  (lines 1211–1265)

```
async fn test_update_file_hunk_interleaved_changes()
```

**Purpose**: Verifies a more complex update hunk containing replacements in different regions plus an EOF append. It checks that non-adjacent edits are all applied correctly and summarized once.

**Data flow**: Creates a six-line file, builds a patch replacing `b`, replacing `e`, and appending `g` at EOF, runs `apply_patch`, decodes stdout/stderr, asserts the expected single modified summary and empty stderr, and checks the final file contents include all three edits.

**Call relations**: This test stresses `compute_replacements` with interleaved chunk types and EOF handling.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_pure_addition_chunk_followed_by_removal`  (lines 1268–1301)

```
async fn test_pure_addition_chunk_followed_by_removal()
```

**Purpose**: Verifies that a pure-addition chunk followed by a later removal/replacement chunk applies correctly without panicking or misordering edits. It covers a historically tricky replacement ordering case.

**Data flow**: Creates a three-line file, builds a patch whose first chunk adds two lines and whose second chunk replaces two existing lines, runs `apply_patch`, and asserts the final file contents equal the expected merged result.

**Call relations**: This test specifically exercises replacement ordering in `compute_replacements` and reverse application in `apply_replacements`.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 7 external calls (new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_update_line_with_unicode_dash`  (lines 1310–1355)

```
async fn test_update_line_with_unicode_dash()
```

**Purpose**: Verifies that a patch authored with ASCII punctuation can match and replace a line containing typographic Unicode dash characters. It protects fuzzy matching behavior expected by the parser/matcher stack.

**Data flow**: Creates a file whose comment contains EN DASH and NON-BREAKING HYPHEN, builds a patch using plain ASCII hyphens in the old line, runs `apply_patch`, and asserts the file now contains the replacement line, stdout lists the file as modified, and stderr is empty.

**Call relations**: This test exercises the matching behavior used by `compute_replacements` through the public application path.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_unified_diff`  (lines 1358–1404)

```
async fn test_unified_diff()
```

**Purpose**: Verifies unified-diff generation for a multi-chunk update. It checks that the diff text, original content, and new content all match expectations.

**Data flow**: Creates a four-line file, builds and parses a two-chunk update patch, extracts the chunks, computes the absolute path, calls `unified_diff_from_chunks`, and asserts the returned `ApplyPatchFileUpdate` equals the expected diff and contents.

**Call relations**: This test exercises the diff-generation API independently of filesystem mutation.

*Call graph*: calls 2 internal fn (parse_patch, unified_diff_from_chunks); 6 external calls (wrap_patch, assert_eq!, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_first_line_replacement`  (lines 1407–1445)

```
async fn test_unified_diff_first_line_replacement()
```

**Purpose**: Verifies unified-diff generation when replacing the first line of a file. It covers start-of-file diff formatting.

**Data flow**: Creates a three-line file, builds and parses a patch replacing `foo` with `FOO`, extracts chunks, calls `unified_diff_from_chunks`, and asserts the returned diff and contents match the expected first-line replacement output.

**Call relations**: This test complements the last-line and EOF insertion diff tests.

*Call graph*: calls 2 internal fn (parse_patch, unified_diff_from_chunks); 6 external calls (wrap_patch, assert_eq!, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_last_line_replacement`  (lines 1448–1487)

```
async fn test_unified_diff_last_line_replacement()
```

**Purpose**: Verifies unified-diff generation when replacing the last line of a file. It covers end-of-file replacement formatting.

**Data flow**: Creates a three-line file, builds and parses a patch replacing `baz` with `BAZ`, extracts chunks, calls `unified_diff_from_chunks`, and asserts the expected diff and contents.

**Call relations**: This test exercises the same API as the first-line replacement test but at EOF.

*Call graph*: calls 2 internal fn (parse_patch, unified_diff_from_chunks); 6 external calls (wrap_patch, assert_eq!, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_insert_at_eof`  (lines 1490–1526)

```
async fn test_unified_diff_insert_at_eof()
```

**Purpose**: Verifies unified-diff generation for appending a line at EOF. It covers `*** End of File` handling in diff output.

**Data flow**: Creates a three-line file, builds and parses an EOF insertion patch, extracts chunks, calls `unified_diff_from_chunks`, and asserts the expected diff and resulting contents.

**Call relations**: This test complements the replacement diff tests with a pure insertion case.

*Call graph*: calls 2 internal fn (parse_patch, unified_diff_from_chunks); 6 external calls (wrap_patch, assert_eq!, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_interleaved_changes`  (lines 1529–1612)

```
async fn test_unified_diff_interleaved_changes()
```

**Purpose**: Verifies unified-diff generation and actual application for interleaved multi-chunk changes in one file. It checks consistency between diff computation and mutation.

**Data flow**: Creates a six-line file, builds and parses a patch replacing `b`, replacing `e`, and appending `g`, extracts chunks, computes `unified_diff_from_chunks`, and asserts the expected diff and contents. It then runs `apply_patch` with the same patch and asserts the file contents match the diff-derived result.

**Call relations**: This test bridges the diff-generation and application paths to ensure they agree on the resulting content.

*Call graph*: calls 4 internal fn (apply_patch, parse_patch, unified_diff_from_chunks, from_absolute_path); 8 external calls (new, wrap_patch, assert_eq!, format!, read_to_string, write, panic!, tempdir).


##### `tests::test_apply_patch_fails_on_write_error`  (lines 1616–1642)

```
async fn test_apply_patch_fails_on_write_error()
```

**Purpose**: Verifies that a write failure during patch application yields a failure whose delta is marked inexact. It covers the `try_write!` exactness downgrade path.

**Data flow**: On Unix, creates a locked directory with no write permission, builds an add-file patch targeting that directory, runs `apply_patch` expecting an error, restores permissions, and asserts `!failure.delta().is_exact()`.

**Call relations**: This test exercises write-error handling in `apply_hunks_to_files`, specifically the macro path that marks exactness false before returning.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 7 external calls (new, wrap_patch, assert!, from_mode, create_dir, set_permissions, tempdir).


##### `tests::test_unreadable_destinations_return_inexact_delta`  (lines 1645–1671)

```
async fn test_unreadable_destinations_return_inexact_delta()
```

**Purpose**: Verifies that overwriting unreadable binary destinations succeeds but yields an inexact delta because prior textual contents could not be captured. It covers add and move-destination overwrite cases.

**Data flow**: Creates a temp directory, writes `source.txt`, computes cwd, and for each of two patches—adding `binary.dat` and moving `source.txt` to `binary.dat`—writes unreadable bytes to `binary.dat`, runs `apply_patch`, and asserts the returned delta is not exact.

**Call relations**: This test exercises `read_optional_file_text_for_delta` and metadata-based exactness downgrades during successful application.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 5 external calls (new, wrap_patch, assert!, write, tempdir).


##### `tests::test_delete_symlink_returns_inexact_delta`  (lines 1675–1697)

```
async fn test_delete_symlink_returns_inexact_delta()
```

**Purpose**: Verifies that deleting a symlink succeeds but yields an inexact delta because the path is not a regular non-symlink file. It covers exactness semantics for symlink deletes.

**Data flow**: On Unix, creates a target file and symlink, builds a delete patch for the symlink, runs `apply_patch`, and asserts the returned delta is not exact.

**Call relations**: This test exercises `note_existing_path_delta_support` on symlink metadata during the delete path.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 5 external calls (new, wrap_patch, assert!, write, tempdir).


### `git-utils/src/apply.rs`

`domain_logic` · `patch application / preflight validation`

This file wraps `git apply` as a concrete patch-application service. The main API, `apply_git_patch`, accepts an `ApplyGitRequest` containing the repository working directory, diff text, and flags for revert and preflight. It first resolves the repository root with `git rev-parse --show-toplevel`, writes the diff into a temporary `patch.diff`, and keeps the temp directory alive for the duration of the command. For non-preflight reverts it stages existing paths referenced by the patch before applying, which avoids index/worktree mismatches when reversing changes.

Command construction is explicit: the normal path uses `git apply --3way`, optionally `-R`, and may prepend extra `-c key=value` pairs from the `CODEX_APPLY_GIT_CFG` environment variable. Preflight instead runs `git apply --check` and never mutates the worktree. Both paths render a shell-like command string for logs and parse stdout/stderr into `applied_paths`, `skipped_paths`, and `conflicted_paths`, deduplicated and sorted.

The parser is substantial: it recognizes many `git apply` status and error formats, tracks the last path mentioned by `Checking patch ...`, unquotes C-style escaped paths, and enforces precedence `conflicted > applied > skipped`. Supporting helpers parse `diff --git` headers, normalize `/dev/null` cases, and unescape quoted path tokens so staging and diagnostics work with spaces, tabs, and quoted filenames.

#### Function details

##### `apply_git_patch`  (lines 41–124)

```
fn apply_git_patch(req: &ApplyGitRequest) -> io::Result<ApplyGitResult>
```

**Purpose**: Executes the full patch-application workflow: locate repo root, write the diff to a temp file, optionally stage paths for revert, run `git apply` or `git apply --check`, and return structured results.

**Data flow**: Consumes `ApplyGitRequest { cwd, diff, revert, preflight }`. It resolves `git_root`, writes `diff` to a temp patch file, optionally calls `stage_paths` when reverting for real, builds git config overrides from `CODEX_APPLY_GIT_CFG`, renders a log command string, runs git via `run_git`, parses stdout/stderr with `parse_git_apply_output`, sorts/deduplicates the three path vectors, and returns `ApplyGitResult` containing exit code, parsed paths, raw stdout/stderr, and the rendered command.

**Call relations**: This is the file’s public entrypoint and orchestrates all helpers in the module. Tests invoke it directly for add, conflict, missing-index, revert, and preflight scenarios.

*Call graph*: calls 6 internal fn (parse_git_apply_output, render_command_for_log, resolve_git_root, run_git, stage_paths, write_temp_patch); called by 6 (apply_add_success, apply_modify_conflict, apply_modify_skipped_missing_index, apply_then_revert_success, preflight_blocks_partial_changes, revert_preflight_does_not_stage_index); 3 external calls (new, var, vec!).


##### `resolve_git_root`  (lines 126–142)

```
fn resolve_git_root(cwd: &Path) -> io::Result<PathBuf>
```

**Purpose**: Finds the top-level repository directory for a working directory using `git rev-parse --show-toplevel`.

**Data flow**: Runs `git rev-parse --show-toplevel` in `cwd`, inspects the exit code, and on success trims stdout into a `PathBuf`. On nonzero exit it constructs an `io::Error` containing the exit code and stderr text.

**Call relations**: Called first by `apply_git_patch` so all subsequent git commands and path staging operate from the repository root rather than an arbitrary subdirectory.

*Call graph*: called by 1 (apply_git_patch); 5 external calls (from, from_utf8_lossy, new, other, format!).


##### `write_temp_patch`  (lines 144–149)

```
fn write_temp_patch(diff: &str) -> io::Result<(tempfile::TempDir, PathBuf)>
```

**Purpose**: Creates a temporary directory and writes the unified diff text into `patch.diff` inside it.

**Data flow**: Takes `&str diff`, creates a `tempfile::TempDir`, joins `patch.diff`, writes the diff bytes to disk, and returns `(TempDir, PathBuf)`.

**Call relations**: Used by `apply_git_patch` before invoking `git apply`; the returned tempdir is intentionally kept alive until the function returns.

*Call graph*: called by 1 (apply_git_patch); 2 external calls (write, tempdir).


##### `run_git`  (lines 151–164)

```
fn run_git(cwd: &Path, git_cfg: &[String], args: &[String]) -> io::Result<(i32, String, String)>
```

**Purpose**: Runs the `git` binary with optional `-c` config fragments and arbitrary arguments, returning exit code plus decoded stdout/stderr.

**Data flow**: Consumes `cwd`, `git_cfg`, and `args`; builds a `std::process::Command`, appends all config parts and args, executes it in `cwd`, converts stdout/stderr from bytes with `String::from_utf8_lossy`, and returns `(code, stdout, stderr)` where missing status codes become `-1`.

**Call relations**: This is the low-level process runner used by `apply_git_patch` for both preflight and real apply paths.

*Call graph*: called by 1 (apply_git_patch); 2 external calls (from_utf8_lossy, new).


##### `quote_shell`  (lines 166–175)

```
fn quote_shell(s: &str) -> String
```

**Purpose**: Produces a shell-safe representation of one argument for logging.

**Data flow**: Checks whether all characters are simple ASCII shell-safe characters; if so returns the string unchanged, otherwise wraps it in single quotes and escapes embedded single quotes.

**Call relations**: Used only by `render_command_for_log` to make the logged command readable and copy-pastable.

*Call graph*: called by 1 (render_command_for_log); 1 external calls (format!).


##### `render_command_for_log`  (lines 177–191)

```
fn render_command_for_log(cwd: &Path, git_cfg: &[String], args: &[String]) -> String
```

**Purpose**: Formats the git invocation as a shell-like `(cd ... && git ...)` string for diagnostics and logs.

**Data flow**: Quotes `cwd`, each config fragment, and each argument with `quote_shell`, joins them into a command line, and returns the formatted string.

**Call relations**: Called by `apply_git_patch` in both preflight and real-apply branches so callers can inspect the exact command shape.

*Call graph*: calls 1 internal fn (quote_shell); called by 1 (apply_git_patch); 2 external calls (new, format!).


##### `extract_paths_from_patch`  (lines 194–212)

```
fn extract_paths_from_patch(diff_text: &str) -> Vec<String>
```

**Purpose**: Extracts all file paths mentioned in `diff --git` headers from a unified diff, normalized and deduplicated.

**Data flow**: Iterates trimmed diff lines, keeps only those starting with `diff --git `, parses the two header paths with `parse_diff_git_paths`, normalizes each side with `normalize_diff_path` (`a/`, `b/`, `/dev/null` handling), inserts them into a `BTreeSet`, and returns the sorted collected paths.

**Call relations**: Used by `stage_paths` to determine which files might need staging before a revert. Tests also exercise quoted and escaped header handling through this function.

*Call graph*: calls 2 internal fn (normalize_diff_path, parse_diff_git_paths); called by 4 (stage_paths, extract_paths_handles_quoted_headers, extract_paths_ignores_dev_null_header, extract_paths_unescapes_c_style_in_quoted_headers); 1 external calls (new).


##### `parse_diff_git_paths`  (lines 214–219)

```
fn parse_diff_git_paths(line: &str) -> Option<(String, String)>
```

**Purpose**: Parses the two path tokens that follow `diff --git` in a header line.

**Data flow**: Creates a peekable char iterator over the line, reads the first and second tokens with `read_diff_git_token`, and returns them as `(String, String)` if both are present.

**Call relations**: A helper for `extract_paths_from_patch`; it delegates token-level quoting and escaping rules to `read_diff_git_token`.

*Call graph*: calls 1 internal fn (read_diff_git_token); called by 1 (extract_paths_from_patch).


##### `read_diff_git_token`  (lines 221–255)

```
fn read_diff_git_token(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Option<String>
```

**Purpose**: Reads one possibly quoted path token from a `diff --git` header, preserving escaped content and decoding quoted C-style strings.

**Data flow**: Consumes leading whitespace from the peekable iterator, detects optional opening quote (`'` or `"`), then accumulates characters until the matching quote or next whitespace. Inside quoted mode it preserves backslash escapes in the intermediate buffer, then returns either the raw token or `unescape_c_string(&out)` for quoted tokens. If no token is present, it returns `None`.

**Call relations**: Used twice by `parse_diff_git_paths` to parse both sides of a diff header.

*Call graph*: calls 1 internal fn (unescape_c_string); called by 1 (parse_diff_git_paths); 4 external calls (next, peek, new, matches!).


##### `normalize_diff_path`  (lines 257–270)

```
fn normalize_diff_path(raw: &str, prefix: &str) -> Option<String>
```

**Purpose**: Normalizes one raw diff-header path by removing side prefixes and filtering out null-file markers.

**Data flow**: Trims the input, rejects empty strings, `/dev/null`, and `<prefix>dev/null`, strips the provided side prefix if present, rejects an empty remainder, and returns the normalized path string.

**Call relations**: Called by `extract_paths_from_patch` for both the `a/` and `b/` sides of each parsed header.

*Call graph*: called by 1 (extract_paths_from_patch); 1 external calls (format!).


##### `unescape_c_string`  (lines 272–317)

```
fn unescape_c_string(input: &str) -> String
```

**Purpose**: Decodes common C-style backslash escapes used in quoted git path output.

**Data flow**: Walks the input string character by character, copying ordinary characters and translating escapes such as `\n`, `\t`, quotes, backslash, and up to three-digit octal sequences into Unicode scalar values when possible. It returns the decoded `String`.

**Call relations**: Used when parsing quoted diff-header tokens and when unquoting paths extracted from `git apply` output.

*Call graph*: called by 1 (read_diff_git_token); 2 external calls (with_capacity, from_u32).


##### `stage_paths`  (lines 320–342)

```
fn stage_paths(git_root: &Path, diff: &str) -> io::Result<()>
```

**Purpose**: Best-effort stages only the patch-referenced files that currently exist on disk, to prepare for non-preflight revert application.

**Data flow**: Extracts candidate paths from the diff with `extract_paths_from_patch`, joins each against `git_root`, keeps only those whose `symlink_metadata` succeeds, and if any remain runs `git add -- <paths...>` in `git_root`. It ignores the command’s exit status and always returns `Ok(())` unless process spawning itself fails.

**Call relations**: Called only by `apply_git_patch` when `revert` is true and `preflight` is false. Its intentionally non-fatal behavior reflects the comment that staging is only a best-effort compatibility step.

*Call graph*: calls 1 internal fn (extract_paths_from_patch); called by 1 (apply_git_patch); 5 external calls (new, join, new, new, symlink_metadata).


##### `parse_git_apply_output`  (lines 347–589)

```
fn parse_git_apply_output(
    stdout: &str,
    stderr: &str,
) -> (Vec<String>, Vec<String>, Vec<String>)
```

**Purpose**: Parses stdout and stderr from `git apply` into three deduplicated path groups: applied, skipped, and conflicted.

**Data flow**: Combines non-empty stdout/stderr with newlines, iterates trimmed lines, and matches them against a large set of lazily compiled case-insensitive regexes. It tracks `last_seen_path` from `Checking patch ...`, inserts normalized/unquoted paths into `BTreeSet`s via the nested `add` helper, updates precedence as lines imply success, conflict, or skip states, then removes lower-priority classifications in a final pass and returns three vectors.

**Call relations**: Used by `apply_git_patch` for both preflight and real apply. It is the module’s main interpretation layer for git’s human-oriented diagnostics.

*Call graph*: called by 2 (apply_git_patch, parse_output_unescapes_quoted_paths); 2 external calls (new, new).


##### `regex_ci`  (lines 591–593)

```
fn regex_ci(pat: &str) -> Regex
```

**Purpose**: Compiles a case-insensitive regex pattern and panics immediately if the pattern is invalid.

**Data flow**: Prefixes the pattern with `(?i)`, calls `Regex::new`, and unwraps with a panic message on failure.

**Call relations**: Used only to initialize the static regexes inside `parse_git_apply_output`.

*Call graph*: 2 external calls (new, format!).


##### `tests::env_lock`  (lines 602–605)

```
fn env_lock() -> &'static Mutex<()>
```

**Purpose**: Provides a global mutex used by tests that mutate process-wide git-related environment or rely on serialized git command execution.

**Data flow**: Initializes a `OnceLock<Mutex<()>>` on first use and returns a shared reference to the mutex.

**Call relations**: Acquired by integration-style tests before invoking `apply_git_patch` to avoid cross-test interference.

*Call graph*: 1 external calls (new).


##### `tests::run`  (lines 607–618)

```
fn run(cwd: &Path, args: &[&str]) -> (i32, String, String)
```

**Purpose**: Runs an arbitrary command in a repository directory and returns exit code plus decoded stdout/stderr for test setup and assertions.

**Data flow**: Builds a `Command` from `args[0]` and `args[1..]`, executes it in `cwd`, and converts outputs to owned UTF-8-lossy strings.

**Call relations**: Used by test helpers and scenarios to initialize repositories, commit files, and inspect git state around `apply_git_patch`.

*Call graph*: 2 external calls (from_utf8_lossy, new).


##### `tests::init_repo`  (lines 620–628)

```
fn init_repo() -> tempfile::TempDir
```

**Purpose**: Creates a temporary git repository with minimal user identity configured for commits.

**Data flow**: Creates a tempdir, runs `git init`, `git config user.email`, and `git config user.name` in the root, then returns the tempdir.

**Call relations**: Shared setup helper for the patch-application tests.

*Call graph*: 2 external calls (run, tempdir).


##### `tests::read_file_normalized`  (lines 630–634)

```
fn read_file_normalized(path: &Path) -> String
```

**Purpose**: Reads a file and normalizes CRLF to LF so content assertions are platform-stable.

**Data flow**: Reads the file to string and replaces `\r\n` with `\n`.

**Call relations**: Used by tests that verify file contents after apply and revert operations.

*Call graph*: 1 external calls (read_to_string).


##### `tests::extract_paths_handles_quoted_headers`  (lines 637–641)

```
fn extract_paths_handles_quoted_headers()
```

**Purpose**: Verifies that quoted `diff --git` headers with spaces produce the expected normalized path.

**Data flow**: Builds a diff string with quoted header paths, calls `extract_paths_from_patch`, and asserts the resulting vector.

**Call relations**: Exercises the header parser and normalization helpers.

*Call graph*: calls 1 internal fn (extract_paths_from_patch); 1 external calls (assert_eq!).


##### `tests::extract_paths_ignores_dev_null_header`  (lines 644–648)

```
fn extract_paths_ignores_dev_null_header()
```

**Purpose**: Checks that `/dev/null`-style paths are excluded when extracting patch paths.

**Data flow**: Constructs a diff involving `a/dev/null`, calls `extract_paths_from_patch`, and asserts only the real file path remains.

**Call relations**: Covers `normalize_diff_path` behavior for null-file markers.

*Call graph*: calls 1 internal fn (extract_paths_from_patch); 1 external calls (assert_eq!).


##### `tests::extract_paths_unescapes_c_style_in_quoted_headers`  (lines 651–655)

```
fn extract_paths_unescapes_c_style_in_quoted_headers()
```

**Purpose**: Ensures quoted diff-header paths with C-style escapes are decoded correctly.

**Data flow**: Creates a diff whose quoted header contains `\t`, calls `extract_paths_from_patch`, and asserts the resulting path contains a literal tab.

**Call relations**: Exercises `read_diff_git_token` and `unescape_c_string` together.

*Call graph*: calls 1 internal fn (extract_paths_from_patch); 1 external calls (assert_eq!).


##### `tests::parse_output_unescapes_quoted_paths`  (lines 658–664)

```
fn parse_output_unescapes_quoted_paths()
```

**Purpose**: Verifies that quoted paths in `git apply` error output are unescaped before classification.

**Data flow**: Passes a synthetic stderr line to `parse_git_apply_output` and asserts the skipped-path vector contains the decoded filename.

**Call relations**: Targets the nested path-unquoting logic inside the output parser.

*Call graph*: calls 1 internal fn (parse_git_apply_output); 1 external calls (assert_eq!).


##### `tests::apply_add_success`  (lines 667–683)

```
fn apply_add_success()
```

**Purpose**: Checks that applying a patch which adds a new file succeeds and creates the file.

**Data flow**: Initializes a repo, builds an add-file diff, calls `apply_git_patch`, and asserts exit code 0 plus file existence.

**Call relations**: End-to-end success test for the main apply path.

*Call graph*: calls 1 internal fn (apply_git_patch); 4 external calls (assert!, assert_eq!, env_lock, init_repo).


##### `tests::apply_modify_conflict`  (lines 686–706)

```
fn apply_modify_conflict()
```

**Purpose**: Checks that applying a patch conflicting with local unstaged edits returns a nonzero exit code.

**Data flow**: Seeds and commits a file, edits it locally, applies a conflicting patch via `apply_git_patch`, and asserts the exit code is nonzero.

**Call relations**: Exercises the `--3way` conflict path and parser under failure.

*Call graph*: calls 1 internal fn (apply_git_patch); 5 external calls (assert_ne!, env_lock, init_repo, run, write).


##### `tests::apply_modify_skipped_missing_index`  (lines 709–723)

```
fn apply_modify_skipped_missing_index()
```

**Purpose**: Verifies that modifying a file absent from the index fails as expected.

**Data flow**: Initializes a repo, constructs a patch against a nonexistent tracked file, runs `apply_git_patch`, and asserts a nonzero exit code.

**Call relations**: Covers skip/error handling for missing-index scenarios.

*Call graph*: calls 1 internal fn (apply_git_patch); 3 external calls (assert_ne!, env_lock, init_repo).


##### `tests::apply_then_revert_success`  (lines 726–759)

```
fn apply_then_revert_success()
```

**Purpose**: Ensures a patch can be applied and then successfully reverted back to the original content.

**Data flow**: Creates and commits a file, applies a forward patch, verifies content, then calls `apply_git_patch` again with `revert = true` and checks the file returns to its original text.

**Call relations**: Exercises both normal apply and revert logic, including the staging step before revert.

*Call graph*: calls 1 internal fn (apply_git_patch); 6 external calls (assert_eq!, env_lock, init_repo, read_file_normalized, run, write).


##### `tests::revert_preflight_does_not_stage_index`  (lines 762–804)

```
fn revert_preflight_does_not_stage_index()
```

**Purpose**: Confirms that revert preflight uses `--check` only and does not stage files or modify the working tree.

**Data flow**: Creates and commits a repo state, applies and commits a forward patch, snapshots cached diff state, runs `apply_git_patch` with `revert = true, preflight = true`, then compares staged state and file contents before and after.

**Call relations**: Validates the branch in `apply_git_patch` that skips `stage_paths` during preflight.

*Call graph*: calls 1 internal fn (apply_git_patch); 6 external calls (assert_eq!, env_lock, init_repo, read_file_normalized, run, write).


##### `tests::preflight_blocks_partial_changes`  (lines 807–846)

```
fn preflight_blocks_partial_changes()
```

**Purpose**: Checks that preflight prevents partial application of a mixed-validity multi-file patch and that non-preflight does not use `--check`.

**Data flow**: Builds a diff with one valid add and one invalid modify, runs `apply_git_patch` once with `preflight = true` and once without, then asserts file absence and command-string contents accordingly.

**Call relations**: Covers the distinction between dry-run validation and real apply command construction.

*Call graph*: calls 1 internal fn (apply_git_patch); 4 external calls (assert!, assert_ne!, env_lock, init_repo).
