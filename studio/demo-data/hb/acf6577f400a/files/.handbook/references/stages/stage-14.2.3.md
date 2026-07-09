# Patch application engine and patch-execution adapters  `stage-14.2.3`

This stage is the editing engine for the system. It is used during the main work loop when the assistant wants to change files. First, apply_patch_spec defines the “apply_patch” tool: its name, description, and the exact patch format the assistant must use. The parser and streaming_parser read that patch text. The normal parser waits for the whole patch and turns it into clear actions like add, delete, update, or move a file. The streaming parser can understand the patch while it is still arriving, so progress can be shown early.

The invocation code decides whether some command text is truly an apply_patch request, not just an ordinary shell command. The core apply-patch library then performs the actual file edits and records what succeeded or failed. The core handlers and runtime adapters act like safety gates: they validate the request, check policy, ask for user approval if needed, choose the right sandboxed environment, run the edit, and report results. For Git-based patches, git-utils applies them through Git and explains which files applied, skipped, or conflicted.

## Files in this stage

### Tool interface and orchestration
These files define the external apply_patch tool surface and orchestrate a request from freeform input through validation, delegation, and progress reporting.

### `core/src/tools/handlers/apply_patch_spec.rs`

`config` · `tool registration`

This file is like the instruction card for a special editing tool. The project needs a safe, predictable way for an AI model to say, “change this file like so,” without wrapping the edit in ordinary JSON or free text that might be hard to parse. To do that, it builds a `ToolSpec`, meaning a tool description that can be registered with the larger tool system.

The important ingredient is a Lark grammar. A grammar is a set of rules that says what text is valid, much like a form template says which fields must appear and in what order. The grammar text is loaded from the neighboring `apply_patch.lark` file at compile time. This file then uses that grammar as the accepted format for the `apply_patch` tool.

There is one optional twist: some runs may need an environment ID included in the patch. If requested, the function slightly rewrites the grammar so an optional `*** Environment ID: ...` line is allowed near the start. Without this file, the system would not have a clear, reusable specification for exposing file editing as a custom freeform tool.

#### Function details

##### `create_apply_patch_freeform_tool`  (lines 9–27)

```
fn create_apply_patch_freeform_tool(include_environment_id: bool) -> ToolSpec
```

**Purpose**: Builds the official specification for the `apply_patch` tool. Callers use it when they want to offer the model a file-editing tool whose input must follow the patch grammar.

**Data flow**: It receives one choice: whether patches may include an environment ID. It reads the built-in Lark grammar text, optionally inserts the extra environment-ID rule, then packages the final grammar together with the tool name and description. The result is a `ToolSpec::Freeform`, which means the tool accepts raw text in a specific grammar rather than JSON.

**Call relations**: When the broader tool specification setup asks for the apply-patch tool, this function creates the finished tool description. It hands that description to `ToolSpec::Freeform`, which wraps the freeform tool details so the rest of the system can register and present it consistently.

*Call graph*: called by 1 (spec); 1 external calls (Freeform).


### `core/src/tools/handlers/apply_patch.rs`

`orchestration` · `request handling`

This file exists so the assistant can safely edit files by sending a patch, instead of running arbitrary commands. A patch is like a marked-up set of instructions: add this file, delete that file, replace these lines. Without this handler, the system would not know how to verify those instructions, apply them in the right workspace, or tell the user what changed.

The main piece is `ApplyPatchHandler`. It registers the `apply_patch` tool, accepts the raw patch text, parses it, checks which environment it should affect, and verifies the patch against that environment’s filesystem. It then works out whether the patch needs extra write access. If the change can be applied directly, it returns the result. If it must go through the normal tool runtime, it builds an `ApplyPatchRequest`, starts progress events, runs the patch through the tool orchestrator, and finishes with a clear response.

The file also supports streaming progress while the model is still writing the patch. `ApplyPatchArgumentDiffConsumer` reads patch text in small pieces and turns recognizable hunks into “file X is being added/updated/deleted” events. It buffers these updates so the UI is not flooded.

A second entry point, `intercept_apply_patch`, catches shell-like commands that are actually apply-patch commands and routes them through the same safe path.

#### Function details

##### `ApplyPatchHandler::new`  (lines 66–68)

```
fn new(multi_environment: bool) -> Self
```

**Purpose**: Creates an `ApplyPatchHandler` and records whether this turn may choose among multiple environments. This matters because a patch may need to target a specific workspace only when that feature is allowed.

**Data flow**: It receives a true-or-false `multi_environment` setting → stores that setting inside the handler → returns a ready-to-register handler.

**Call relations**: The core tool registration flow calls this when adding built-in utility tools. After that, the returned handler is used whenever the `apply_patch` tool is offered or invoked.

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

**Purpose**: Consumes a newly streamed piece of patch text and may turn it into a progress event. It only does this when the apply-patch streaming feature is enabled for the current turn.

**Data flow**: It receives the current turn, the tool call id, and a text fragment → checks whether streaming patch events are enabled → passes the fragment to `push_delta` → returns a patch progress event if enough useful information is available.

**Call relations**: The tool runtime calls this while the model is still producing the tool argument. It delegates the real parsing and throttling work to `push_delta`, then wraps any result as a protocol event.

*Call graph*: calls 1 internal fn (push_delta).


##### `ApplyPatchArgumentDiffConsumer::finish`  (lines 93–96)

```
fn finish(&mut self) -> Result<Option<EventMsg>, FunctionCallError>
```

**Purpose**: Finishes streaming patch-progress parsing after all patch text has arrived. It gives the system one last chance to send a buffered update.

**Data flow**: It receives no new patch text → asks `finish_update_on_complete` to close the parser and collect any pending event → returns that event wrapped for the protocol, or an error if the patch stream cannot be parsed.

**Call relations**: The tool runtime calls this at the end of argument streaming. It hands the completion work to `finish_update_on_complete` so parsing errors and final buffered updates are handled in one place.

*Call graph*: calls 1 internal fn (finish_update_on_complete).


##### `ApplyPatchArgumentDiffConsumer::push_delta`  (lines 100–121)

```
fn push_delta(&mut self, call_id: String, delta: &str) -> Option<PatchApplyUpdatedEvent>
```

**Purpose**: Parses one more piece of streamed patch text and decides whether to emit a progress update now or hold it briefly. The short delay avoids sending too many nearly identical UI updates.

**Data flow**: It receives a call id and a patch-text fragment → feeds the fragment into the streaming parser → converts any newly understood hunks into file-change messages → either returns an event immediately or stores it as pending if the last event was sent too recently.

**Call relations**: `consume_diff` calls this whenever new tool-argument text arrives. It uses the hunk-to-protocol conversion helper and the current time to produce progress updates at a controlled pace.

*Call graph*: calls 2 internal fn (push_delta, convert_apply_patch_hunks_to_protocol); called by 1 (consume_diff); 1 external calls (now).


##### `ApplyPatchArgumentDiffConsumer::finish_update_on_complete`  (lines 123–135)

```
fn finish_update_on_complete(
        &mut self,
    ) -> Result<Option<PatchApplyUpdatedEvent>, FunctionCallError>
```

**Purpose**: Closes the streaming patch parser and returns the last buffered progress update, if one exists. It turns parser problems into an error message that can be shown to the model.

**Data flow**: It receives the consumer’s current parser state → tells the parser there is no more input → converts any parse failure into a tool error → takes the pending event, updates the send time if needed, and returns the event.

**Call relations**: `finish` calls this when argument streaming is complete. Its result becomes the final patch-progress event, if the consumer had been holding one back because of throttling.

*Call graph*: calls 1 internal fn (finish); called by 1 (finish); 1 external calls (now).


##### `convert_apply_patch_hunks_to_protocol`  (lines 138–160)

```
fn convert_apply_patch_hunks_to_protocol(hunks: &[Hunk]) -> HashMap<PathBuf, FileChange>
```

**Purpose**: Turns parsed patch hunks into the project’s standard file-change format. A hunk is one piece of a patch, such as “add this file” or “replace these lines.”

**Data flow**: It receives a list of parsed hunks → inspects each hunk’s kind and path → builds a map from file path to a protocol `FileChange` describing add, delete, or update → returns that map for progress reporting.

**Call relations**: `push_delta` uses this after the streaming parser recognizes meaningful patch pieces. The converted changes are then placed into a `PatchApplyUpdatedEvent` for the UI or client.

*Call graph*: called by 1 (push_delta); 1 external calls (iter).


##### `hunk_source_path`  (lines 162–168)

```
fn hunk_source_path(hunk: &Hunk) -> &Path
```

**Purpose**: Finds the main source path for any kind of patch hunk. This lets other code treat add, delete, and update hunks in a uniform way.

**Data flow**: It receives one hunk → matches whether it is an add, delete, or update → returns the path stored inside that hunk.

**Call relations**: This is a small local helper for code that needs to describe patch hunks by file path. It keeps the path-picking rule in one place instead of repeating it for every hunk type.


##### `format_update_chunks_for_progress`  (lines 170–200)

```
fn format_update_chunks_for_progress(chunks: &[codex_apply_patch::UpdateFileChunk]) -> String
```

**Purpose**: Builds a simple unified-diff-style text summary for file updates. A unified diff is the familiar format where removed lines start with `-` and added lines start with `+`.

**Data flow**: It receives update chunks → writes optional context headers, old lines, new lines, and an end-of-file marker into one string → returns that string for progress display.

**Call relations**: The hunk conversion path uses this kind of formatting when an update needs to be shown in protocol form. Its output is meant for progress reporting, not for re-parsing as the full original patch.

*Call graph*: 1 external calls (new).


##### `file_paths_for_action`  (lines 202–220)

```
fn file_paths_for_action(action: &ApplyPatchAction) -> Vec<AbsolutePathBuf>
```

**Purpose**: Collects every absolute file path that a patch action may touch. This includes both original paths and move destinations.

**Data flow**: It receives a verified patch action with a current working directory → walks through all planned changes → resolves each relative path against that working directory → returns the absolute paths that may need approval or permission checks.

**Call relations**: `effective_patch_permissions` calls this before calculating sandbox access. The returned paths become the concrete files or destinations used for permission decisions.

*Call graph*: calls 2 internal fn (changes, to_abs_path); called by 1 (effective_patch_permissions); 1 external calls (new).


##### `to_abs_path`  (lines 222–224)

```
fn to_abs_path(cwd: &AbsolutePathBuf, path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves a patch path against the current working directory to produce an absolute path. This removes ambiguity about where the patch will write.

**Data flow**: It receives a base directory and a path from the patch → resolves the patch path against the base → returns the absolute path.

**Call relations**: `file_paths_for_action` calls this for each path mentioned by a patch action. It is the small conversion step that turns patch-local paths into filesystem paths the sandbox can reason about.

*Call graph*: calls 1 internal fn (resolve_path_against_base); called by 1 (file_paths_for_action).


##### `write_permissions_for_paths`  (lines 226–256)

```
fn write_permissions_for_paths(
    file_paths: &[AbsolutePathBuf],
    file_system_sandbox_policy: &codex_protocol::permissions::FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> Option<Additi
```

**Purpose**: Figures out which parent directories need extra write permission before the patch can be applied. It only asks for permissions that the current sandbox policy does not already allow.

**Data flow**: It receives target file paths, the current filesystem sandbox policy, and the working directory → turns each file into its parent directory → filters out directories already writable → builds and normalizes an additional permission profile → returns that profile, or nothing if no extra access is needed.

**Call relations**: `effective_patch_permissions` calls this after it knows the patch’s target paths and current sandbox policy. Its result is passed into the permission-granting flow so the patch can be approved safely when needed.

*Call graph*: calls 2 internal fn (from_read_write_roots, normalize_additional_permissions); called by 1 (effective_patch_permissions); 3 external calls (default, iter, vec!).


##### `apply_patch_payload_command`  (lines 259–264)

```
fn apply_patch_payload_command(payload: &ToolPayload) -> Option<String>
```

**Purpose**: Extracts the raw patch text from an apply-patch tool payload. Hooks use this text as a command-shaped input.

**Data flow**: It receives a generic tool payload → if the payload is the custom freeform apply-patch kind, it clones the input text → otherwise it returns nothing.

**Call relations**: `pre_tool_use_payload` calls this before a tool runs, and related hook code also relies on the same idea when building hook payloads. It is the adapter between the tool’s internal payload shape and hook input.

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

**Purpose**: Computes the real permissions that should apply to this patch after combining the sandbox, session grants, turn grants, and any new write access the patch needs. This is the safety gate before editing files.

**Data flow**: It receives the session, turn, environment id, verified patch action, and working directory → collects target paths → merges already granted permissions → builds the effective sandbox policy → asks for or applies any missing write permissions → returns the target paths, effective extra permissions, and final sandbox policy.

**Call relations**: Both `handle_call` and `intercept_apply_patch` call this after a patch has been verified. They then use its returned policy and permission information when deciding whether to apply directly or delegate to the runtime.

*Call graph*: calls 7 internal fn (file_system_sandbox_policy, apply_granted_turn_permissions, file_paths_for_action, write_permissions_for_paths, effective_file_system_sandbox_policy, merge_permission_profiles, as_path); called by 2 (handle_call, intercept_apply_patch); 2 external calls (granted_session_permissions, granted_turn_permissions).


##### `ApplyPatchHandler::tool_name`  (lines 310–312)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the public name of this tool: `apply_patch`. The registry uses this name to match tool calls to the handler.

**Data flow**: It receives the handler → constructs the plain tool name `apply_patch` → returns it.

**Call relations**: The tool registry calls this as part of registering or identifying the handler. Later, invocations using that name are routed back to this handler.

*Call graph*: calls 1 internal fn (plain).


##### `ApplyPatchHandler::spec`  (lines 314–316)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the tool description that tells the model how `apply_patch` may be called. The description changes depending on whether multiple environments can be selected.

**Data flow**: It reads the handler’s `multi_environment` setting → asks the apply-patch spec builder to create the freeform tool definition → returns that definition.

**Call relations**: The tool registry asks for this spec when advertising available tools. It delegates the exact schema and wording to `create_apply_patch_freeform_tool`.

*Call graph*: calls 1 internal fn (create_apply_patch_freeform_tool).


##### `ApplyPatchHandler::handle`  (lines 318–320)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts handling an `apply_patch` invocation in the asynchronous tool system. It wraps the real work in a future so the caller can await it.

**Data flow**: It receives a `ToolInvocation` → calls `handle_call` with that invocation → pins the future in the form expected by the tool executor interface → returns the future.

**Call relations**: The tool executor framework calls this when the model invokes `apply_patch`. The actual parsing, permission checks, runtime delegation, and output creation happen in `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ApplyPatchHandler::handle_call`  (lines 324–472)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Runs the full apply-patch workflow for a direct `apply_patch` tool call. It validates the patch, selects the environment, checks permissions, applies the change, emits events, and returns the tool result.

**Data flow**: It receives a full tool invocation → extracts the raw patch text → parses and verifies it → resolves the target environment and working directory → computes permissions → either applies the patch directly or sends an `ApplyPatchRequest` through the orchestrator/runtime → returns boxed tool output or an error message for the model.

**Call relations**: `handle` calls this for normal tool invocations. During the flow it calls helpers such as `require_environment_id` and `effective_patch_permissions`, may call the internal apply-patch path, and may hand execution to `ToolOrchestrator` and `ApplyPatchRuntime` while `ToolEmitter` reports begin and finish events.

*Call graph*: calls 11 internal fn (apply_patch, convert_apply_patch_to_protocol, from_text, boxed_tool_output, apply_patch_for_environment, new, effective_patch_permissions, require_environment_id, resolve_tool_environment, new (+1 more)); called by 1 (handle); 5 external calls (parse_patch, verify_apply_patch_args, format!, RespondToModel, trace!).


##### `ApplyPatchHandler::matches_kind`  (lines 476–478)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Checks whether a payload is the freeform custom kind that this handler understands. This prevents the handler from accepting structured payloads meant for some other tool.

**Data flow**: It receives a generic tool payload → tests whether it is `ToolPayload::Custom` → returns true if it can be handled and false otherwise.

**Call relations**: The core tool runtime uses this when deciding whether an invocation belongs to this handler. If it matches, later steps can safely expect raw patch text.

*Call graph*: 1 external calls (matches!).


##### `ApplyPatchHandler::create_diff_consumer`  (lines 480–482)

```
fn create_diff_consumer(&self) -> Option<Box<dyn ToolArgumentDiffConsumer>>
```

**Purpose**: Creates a streaming patch-progress consumer for this tool. This allows the system to show partial patch updates while the model is still producing the patch.

**Data flow**: It receives the handler → creates a default `ApplyPatchArgumentDiffConsumer` with an empty streaming parser and no pending event → returns it boxed behind the common consumer interface.

**Call relations**: The core tool runtime calls this when it wants to watch incoming tool-argument text. The returned consumer’s `consume_diff` and `finish` methods handle the live progress reporting.

*Call graph*: 1 external calls (default).


##### `ApplyPatchHandler::pre_tool_use_payload`  (lines 484–489)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Builds the payload sent to pre-tool-use hooks before an apply-patch call runs. A hook is custom code that can inspect or modify tool use at certain points.

**Data flow**: It receives the invocation → extracts the raw patch command from the payload → wraps it in JSON under `command` with the apply-patch hook tool name → returns that hook payload, or nothing if the payload is not suitable.

**Call relations**: The core runtime calls this before running the tool. It relies on `apply_patch_payload_command` to get the raw patch text that hook code expects.

*Call graph*: calls 1 internal fn (apply_patch_payload_command).


##### `ApplyPatchHandler::with_updated_hook_input`  (lines 491–504)

```
fn with_updated_hook_input(
        &self,
        mut invocation: ToolInvocation,
        updated_input: serde_json::Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Applies changes made by a hook back onto the tool invocation. If a hook rewrites the patch command, this function replaces the invocation’s patch text with the updated version.

**Data flow**: It receives an invocation and updated JSON hook input → extracts the updated command text with `updated_hook_command` → if the original payload was custom patch text, replaces it → returns the modified invocation.

**Call relations**: The hook flow calls this after a pre-tool-use hook has had a chance to edit the input. The returned invocation is what the normal apply-patch execution path then sees.

*Call graph*: calls 1 internal fn (updated_hook_command).


##### `ApplyPatchHandler::post_tool_use_payload`  (lines 506–521)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the payload sent to post-tool-use hooks after an apply-patch call finishes. It includes both what was requested and what response the tool produced.

**Data flow**: It receives the original invocation and the tool output → asks the output for its hook-friendly response → extracts the original patch command → builds JSON containing the tool name, call id, input command, and response → returns it if all pieces are available.

**Call relations**: The core runtime calls this after the tool finishes. It lets hook code observe the result of the same apply-patch action that `handle_call` executed.

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

**Purpose**: Detects when a shell-like command is actually an `apply_patch` command and safely reroutes it through the apply-patch machinery. If the command is not apply-patch, it leaves it alone.

**Data flow**: It receives command words, filesystem context, environment, session, turn, optional diff tracker, call id, and tool name → tries to parse and verify the command as apply-patch → if it is not apply-patch, returns `None` → if it is valid, computes permissions and applies or delegates the patch → returns a function-tool output wrapped in `Some`.

**Call relations**: Exec-like command handling calls this before running a command normally. When interception succeeds, it follows the same permission and runtime path as `handle_call`, including `effective_patch_permissions`, patch conversion, event emission, and orchestrated runtime execution.

*Call graph*: calls 10 internal fn (apply_patch, convert_apply_patch_to_protocol, from_text, apply_patch_for_environment, new, effective_patch_permissions, new, new, plain, from_abs_path); called by 2 (run_exec_like, handle_call); 4 external calls (maybe_parse_apply_patch_verified, format!, RespondToModel, trace!).


##### `require_environment_id`  (lines 632–643)

```
fn require_environment_id(
    parsed_environment_id: Option<&str>,
    allow_environment_id: bool,
) -> Result<Option<String>, FunctionCallError>
```

**Purpose**: Enforces whether a patch is allowed to name a specific environment. This protects simpler turns from silently accepting environment selection when that feature is disabled.

**Data flow**: It receives an optional parsed environment id and a true-or-false flag saying whether environment ids are allowed → rejects the request if an id was supplied but not allowed → otherwise returns the id as an owned string, or returns nothing if no id was supplied.

**Call relations**: `handle_call` calls this right after parsing the patch. Its result guides environment resolution before any filesystem verification or file editing happens.

*Call graph*: called by 1 (handle_call); 1 external calls (RespondToModel).


### `core/src/apply_patch.rs`

`orchestration` · `request handling`

This file is a gatekeeper for file edits. When the model proposes a patch, the system cannot simply write it to disk. It must first ask: is this allowed by the current sandbox rules, the user’s approval settings, and the working directory? Without this step, the assistant could make file changes in places it should not touch, or ask for approval inconsistently.

The main function, `apply_patch`, sends the proposed edit to the safety checker. A sandbox is a set of limits around what files or commands a tool may use, like a fenced work area. The safety checker returns one of three answers. If the patch is safe, this file tells the runtime to apply it. If the patch needs approval, it still passes the work to the runtime, but marks that user approval is required. If the patch is rejected, it returns an error message that can be shown back to the model.

The file also includes a translator, `convert_apply_patch_to_protocol`. The patch library has its own way of describing added, deleted, and updated files. The wider Codex protocol uses another shape for the same information. This function copies the patch into that protocol form so other parts of the system can report or process the file changes consistently.

#### Function details

##### `apply_patch`  (lines 33–74)

```
async fn apply_patch(
    turn_context: &TurnContext,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    action: ApplyPatchAction,
) -> InternalApplyPatchInvocation
```

**Purpose**: This function decides whether a proposed file patch may proceed, must ask the user first, or must be rejected. It is used when an `apply_patch` request is intercepted or handled as part of a tool call.

**Data flow**: It receives the current turn context, the active filesystem sandbox policy, and the patch action itself. It reads the user’s approval policy, permission profile, sandbox settings, working directory, and Windows sandbox level, then passes all of that to the safety checker. The result becomes either a runtime instruction to apply the patch, a runtime instruction that first requires approval, or an error message saying the patch was rejected.

**Call relations**: When `handle_call` or `intercept_apply_patch` sees an `apply_patch` request, they call this function to make the safety decision. This function hands the decision to `assess_patch_safety`; if the patch can continue, it returns a `DelegateToRuntime` value so the runtime can actually perform the filesystem work. If the patch is unsafe, it returns an `Output` error using `RespondToModel`, so the model gets a clear rejection message instead of silently failing.

*Call graph*: calls 2 internal fn (assess_patch_safety, permission_profile); called by 2 (handle_call, intercept_apply_patch); 4 external calls (DelegateToRuntime, Output, format!, RespondToModel).


##### `convert_apply_patch_to_protocol`  (lines 76–100)

```
fn convert_apply_patch_to_protocol(
    action: &ApplyPatchAction,
) -> HashMap<PathBuf, FileChange>
```

**Purpose**: This function translates a patch from the internal patch library’s format into the project’s shared protocol format for file changes. It makes added, deleted, and updated files understandable to the rest of the system.

**Data flow**: It receives an `ApplyPatchAction`, reads each changed path and its change type, and builds a new map from file paths to protocol-level `FileChange` values. Added files carry their new content, deleted files carry the removed content, and updated files carry the text diff and any rename or move target. The returned map is a clean protocol-friendly summary of the patch.

**Call relations**: After `handle_call` or `intercept_apply_patch` has an apply-patch action, they call this function when they need to describe the patch in protocol terms. The function gets the raw change list from the action through `changes`, prepares enough space for the result map, and hands back a converted view that other components can use without knowing the patch library’s internal types.

*Call graph*: calls 1 internal fn (changes); called by 2 (handle_call, intercept_apply_patch); 1 external calls (with_capacity).


### `core/src/tools/runtimes/apply_patch.rs`

`orchestration` · `request handling`

This file is the runtime for the patch-editing tool. A patch is a compact set of text changes, like instructions saying “replace these lines in this file with those lines.” Earlier parts of the system inspect the patch and decide whether it is allowed. This runtime takes over after that: it turns the decision into a real file change, while still respecting approvals and sandbox limits.

The main type, `ApplyPatchRuntime`, keeps a running record of the patch changes that have actually been committed. It also implements the common tool interfaces used by the orchestrator, which is the part of the program that coordinates tool calls. Through those interfaces it says: “I prefer to run in a sandbox if possible,” “if the sandbox blocks me, it is okay to try a higher-permission path,” and “use the patch-specific approval flow, not the generic command approval flow.”

When a patch runs, the runtime gets the filesystem from the current turn environment. This matters because the same code can work for local and remote environments. It builds a filesystem sandbox context when needed, runs `codex_apply_patch::apply_patch`, captures standard output and error text, records the resulting file-change delta, and converts everything into the normal execution-output shape. If the patch failed in a way that looks like the sandbox denied access, it reports a sandbox-denied error so the orchestrator can react appropriately.

#### Function details

##### `ApplyPatchRuntime::new`  (lines 69–71)

```
fn new() -> Self
```

**Purpose**: Creates a fresh patch runtime with no committed changes recorded yet. Code uses this when it is about to handle an `apply_patch` tool call or test the runtime’s behavior.

**Data flow**: Nothing is passed in. The function builds the default `ApplyPatchRuntime`, whose stored patch delta starts empty, and returns it to the caller.

**Call relations**: Higher-level tool handling code, such as the apply-patch interception and call-handling paths, creates this runtime before asking it for approval information or before running a patch. Tests also create it to check approval keys, permission payloads, sandbox working directories, and approval-policy behavior.

*Call graph*: called by 6 (handle_call, intercept_apply_patch, approval_keys_include_environment_id, permission_request_payload_uses_apply_patch_hook_name_and_aliases, sandbox_cwd_uses_patch_action_cwd, wants_no_sandbox_approval_granular_respects_sandbox_flag); 1 external calls (default).


##### `ApplyPatchRuntime::committed_delta`  (lines 73–75)

```
fn committed_delta(&self) -> &AppliedPatchDelta
```

**Purpose**: Returns the runtime’s record of file changes that have been committed so far. This lets other code inspect what the patch runtime has already applied.

**Data flow**: It reads the `committed_delta` stored inside the runtime and gives back a shared reference to it. It does not copy the data and does not change anything.

**Call relations**: This is a small viewing window into the runtime’s internal change log. After `ApplyPatchRuntime::run` appends newly applied changes, callers can use this function to see the accumulated result.


##### `ApplyPatchRuntime::build_guardian_review_request`  (lines 77–87)

```
fn build_guardian_review_request(
        req: &ApplyPatchRequest,
        call_id: &str,
    ) -> GuardianApprovalRequest
```

**Purpose**: Builds the request sent to the Guardian review system when a patch needs human or policy review. It packages the patch, working directory, files, and call id into the shape Guardian expects.

**Data flow**: It takes the patch request and the tool call id. From the request it copies the current directory, affected file paths, and patch text, then returns a `GuardianApprovalRequest::ApplyPatch` value.

**Call relations**: During approval, `ApplyPatchRuntime::start_approval_async` uses this when a Guardian review id is present. The resulting request is handed to `review_approval_request`, which performs the actual review flow.

*Call graph*: called by 2 (start_approval_async, guardian_review_request_includes_patch_context).


##### `ApplyPatchRuntime::file_system_sandbox_context_for_attempt`  (lines 89–106)

```
fn file_system_sandbox_context_for_attempt(
        req: &ApplyPatchRequest,
        attempt: &SandboxAttempt<'_>,
    ) -> Option<FileSystemSandboxContext>
```

**Purpose**: Builds the filesystem sandbox settings for one attempt to apply a patch. A sandbox is a safety boundary that limits what files the patch can touch.

**Data flow**: It receives the patch request and the current sandbox attempt. If the attempt is not sandboxed, it returns nothing. Otherwise it combines the attempt’s permission profile with any extra permissions requested for this patch, then returns a `FileSystemSandboxContext` containing the allowed permissions, working directory, and platform-specific sandbox settings.

**Call relations**: The patch-running path uses this before calling the lower-level patch applier, so the applier knows what filesystem limits to enforce. Tests also check that the context reflects the active attempt rather than some unrelated default.

*Call graph*: calls 1 internal fn (effective_permission_profile); called by 1 (file_system_sandbox_context_uses_active_attempt).


##### `ApplyPatchRuntime::sandbox_preference`  (lines 110–112)

```
fn sandbox_preference(&self) -> SandboxablePreference
```

**Purpose**: Tells the orchestrator that this runtime should use the system’s automatic sandbox choice. In plain terms, the runtime is saying, “sandbox me when that is the right policy, but let the shared tool system decide the exact mode.”

**Data flow**: It reads no request data and returns `SandboxablePreference::Auto`. Nothing inside the runtime changes.

**Call relations**: The orchestrator asks this as part of preparing a tool execution. The answer feeds into the shared sandboxing machinery that decides how restrictive the first execution attempt should be.


##### `ApplyPatchRuntime::escalate_on_failure`  (lines 113–115)

```
fn escalate_on_failure(&self) -> bool
```

**Purpose**: Says that if a sandboxed patch attempt fails, the orchestrator may try again with broader permission when policy allows it. This is useful when a patch is safe but the first sandbox was too strict.

**Data flow**: It takes no extra information and returns `true`. It does not change the runtime.

**Call relations**: The shared tool runner checks this after a failed sandboxed attempt. Combined with sandbox-denied detection in `ApplyPatchRuntime::run`, it helps the orchestrator decide whether asking for more access or retrying makes sense.


##### `ApplyPatchRuntime::approval_keys`  (lines 121–130)

```
fn approval_keys(&self, req: &ApplyPatchRequest) -> Vec<Self::ApprovalKey>
```

**Purpose**: Creates cache keys for patch approval, one per file being changed. These keys let the system remember that a particular file in a particular environment was already approved, instead of asking repeatedly for the same thing.

**Data flow**: It reads the request’s environment id and list of absolute file paths. For each path, it creates an `ApplyPatchApprovalKey` containing that environment id and path, then returns the full list.

**Call relations**: `ApplyPatchRuntime::start_approval_async` calls this before using cached approval. The environment id is included so approval for a file in one workspace is not accidentally reused for a different workspace.

*Call graph*: called by 1 (start_approval_async).


##### `ApplyPatchRuntime::start_approval_async`  (lines 132–181)

```
fn start_approval_async(
        &'a mut self,
        req: &'a ApplyPatchRequest,
        ctx: ApprovalCtx<'a>,
    ) -> BoxFuture<'a, ReviewDecision>
```

**Purpose**: Starts the approval process for a patch and returns the final review decision. It chooses between Guardian review, preapproval, retry approval, and cached normal patch approval.

**Data flow**: It receives the patch request plus approval context such as the session, turn, call id, retry reason, and optional Guardian review id. It gathers approval keys and patch changes, then launches an asynchronous approval task. The task returns a `ReviewDecision`, usually approved or denied, after asking the right approval source.

**Call relations**: The orchestrator calls this when a patch needs permission before execution. If Guardian review is active, it builds a Guardian request and hands it to `review_approval_request`. If permissions were already preapproved and this is not a retry, it immediately approves. If this is a retry, it asks the session for patch approval with the retry reason. Otherwise it wraps the session approval request in `with_cached_approval` so repeated approvals can be reused safely.

*Call graph*: calls 3 internal fn (approval_keys, build_guardian_review_request, with_cached_approval); 2 external calls (pin, review_approval_request).


##### `ApplyPatchRuntime::wants_no_sandbox_approval`  (lines 183–191)

```
fn wants_no_sandbox_approval(&self, policy: AskForApproval) -> bool
```

**Purpose**: Decides whether this patch runtime wants the user to be asked before running without a sandbox. Running without a sandbox means the patch has fewer filesystem safety limits, so the approval policy matters.

**Data flow**: It receives the current approval policy. For `Never`, it returns false. For granular approval, it follows the granular setting for sandbox approval. For on-failure, on-request, and unless-trusted policies, it returns true.

**Call relations**: The orchestrator consults this when a patch might need to run outside the sandbox. This function translates the broad approval policy into the patch runtime’s yes-or-no preference for that specific situation.


##### `ApplyPatchRuntime::exec_approval_requirement`  (lines 197–202)

```
fn exec_approval_requirement(
        &self,
        req: &ApplyPatchRequest,
    ) -> Option<ExecApprovalRequirement>
```

**Purpose**: Returns the approval requirement that was already computed for this patch. This prevents the generic command-execution approval rules from overriding the patch-specific safety decision made earlier.

**Data flow**: It reads `exec_approval_requirement` from the patch request, clones it, wraps it in `Some`, and returns it. It does not change the request or runtime.

**Call relations**: The shared tool orchestration asks for this while deciding whether approval is needed. This runtime deliberately supplies the upstream patch assessment result, so the approval flow matches the patch review rather than treating the patch like an ordinary shell command.


##### `ApplyPatchRuntime::permission_request_payload`  (lines 204–212)

```
fn permission_request_payload(
        &self,
        req: &ApplyPatchRequest,
    ) -> Option<PermissionRequestPayload>
```

**Purpose**: Builds the permission-request description shown or sent when this patch asks for extra access. It labels the request as `apply_patch` and includes the patch text as the command-like input.

**Data flow**: It reads the patch text from the request. It creates a `PermissionRequestPayload` with the apply-patch hook name and a JSON object containing the patch text, then returns it.

**Call relations**: The approval and hook machinery uses this payload when it needs to explain what permission is being requested. By using the apply-patch hook name, it connects the request to patch-specific policy or integrations rather than generic execution handling.

*Call graph*: calls 1 internal fn (apply_patch); 1 external calls (json!).


##### `ApplyPatchRuntime::sandbox_cwd`  (lines 216–218)

```
fn sandbox_cwd(&self, req: &'a ApplyPatchRequest) -> Option<&'a AbsolutePathBuf>
```

**Purpose**: Tells the sandboxing system which directory should be treated as the patch’s working directory. This keeps relative paths in the patch anchored in the same place the patch author intended.

**Data flow**: It receives the patch request and returns a reference to `req.action.cwd`. It does not allocate new data or change anything.

**Call relations**: Before running the tool, the shared sandbox setup asks for this directory. The returned path becomes the sandbox working directory used for the patch attempt.


##### `ApplyPatchRuntime::run`  (lines 220–267)

```
async fn run(
        &mut self,
        req: &ApplyPatchRequest,
        attempt: &SandboxAttempt<'_>,
        _ctx: &ToolCtx,
    ) -> Result<ApplyPatchRuntimeOutput, ToolError>
```

**Purpose**: Actually applies the patch and turns the result into normal tool output. It is the point where an approved patch becomes real file changes.

**Data flow**: It receives the patch request, the current sandbox attempt, and tool context. It notes the start time, gets the right filesystem from the turn environment, builds sandbox settings when needed, and calls the lower-level patch applier with the patch text and working directory. It captures stdout and stderr, turns them into strings, records whether the patch succeeded, appends the resulting file-change delta to the runtime’s committed delta, and returns an `ApplyPatchRuntimeOutput` containing execution output and the accumulated delta. If the failure looks like the sandbox blocked access, it returns a sandbox-denied error instead.

**Call relations**: The orchestrator calls this after approval and sandbox setup are complete. This function hands the actual editing work to `codex_apply_patch::apply_patch`, then reports back in the common execution-output format used by other tools. Its sandbox-denied error is important because the surrounding tool runner can use that signal to decide whether a retry or escalation path is appropriate.

*Call graph*: calls 3 internal fn (append, is_likely_sandbox_denied, new); 10 external calls (new, now, file_system_sandbox_context_for_attempt, from_utf8_lossy, new, clone, apply_patch, Codex, format!, Sandbox).


### Patch parsing pipeline
These files turn raw patch text or invocation syntax into validated structured patch arguments, including incremental parsing support.

### `apply-patch/src/streaming_parser.rs`

`domain_logic` · `while patch text is streaming, then final validation at completion`

A normal patch parser usually waits until it has the whole patch. This file is different: it reads small pieces of text, remembers unfinished lines, and emits the patch hunks it has fully understood so far. That matters when patch text is streamed from another process or model response, because the rest of the system can see progress without waiting for the final byte.

The main type, StreamingPatchParser, works like a careful reader with a bookmark. It keeps a line buffer for text that has arrived but has not yet ended with a newline, a line number for useful error messages, and a state that says where it is in the patch: before the start marker, inside an add/delete/update section, or after the end marker.

The parser recognizes patch headers such as “begin patch,” “add file,” “delete file,” “update file,” “move to,” context markers, and “end patch.” For added files it collects lines that start with “+”. For updated files it builds chunks containing old lines, new lines, and unchanged context lines. It also accepts an optional environment ID near the top of the patch.

A key safety rule is that update sections cannot be empty. The parser checks this before moving to another section or ending the patch, so malformed patches fail early with a clear message.

#### Function details

##### `StreamingPatchParser::environment_id`  (lines 49–51)

```
fn environment_id(&self) -> Option<&str>
```

**Purpose**: Returns the optional environment ID that was read from the patch header. Callers use this when a patch says which environment it is meant for.

**Data flow**: It reads the parser’s saved environment ID, if one has been seen. It returns a borrowed text value when present, or nothing when the patch did not include one. It does not change the parser.

**Call relations**: This is a simple lookup method. After incoming text has been fed through the parser, other code can ask this method whether an environment ID was discovered.


##### `StreamingPatchParser::ensure_update_hunk_is_not_empty`  (lines 53–82)

```
fn ensure_update_hunk_is_not_empty(&self, line: &str) -> Result<(), ParseError>
```

**Purpose**: Checks that the current update-file section actually contains changed or context lines. This prevents an update header from being accepted as a real patch when it has no body.

**Data flow**: It receives the current line being considered, then looks at the parser’s latest hunk and current mode. If the latest update hunk has no chunks, or its newest chunk has no old or new lines, it returns a parse error with a useful line number. If the update has real content, it returns success and changes nothing.

**Call relations**: This guard is used before the parser accepts a new hunk header or the final end marker in StreamingPatchParser::handle_hunk_headers_and_end_patch. StreamingPatchParser::finish also uses it when the final buffered line is an end marker, so incomplete updates are rejected at the end too.

*Call graph*: called by 2 (finish, handle_hunk_headers_and_end_patch); 1 external calls (format!).


##### `StreamingPatchParser::handle_hunk_headers_and_end_patch`  (lines 84–137)

```
fn handle_hunk_headers_and_end_patch(&mut self, trimmed: &str) -> Result<bool, ParseError>
```

**Purpose**: Looks for patch-level control lines: environment ID, end of patch, add file, delete file, and update file. It starts new hunks or closes the patch when one of those lines appears.

**Data flow**: It receives a trimmed line of patch text. If the line is an environment ID, it records it after checking it is present only once and not empty. If the line is an end marker or a new hunk header, it first checks that any current update hunk is not empty, then updates the parser state and adds the right hunk object. It returns true when it consumed the line as a header or end marker, and false when the line is ordinary hunk content.

**Call relations**: StreamingPatchParser::process_line calls this whenever a line might be a structural marker. This keeps the header-recognition rules in one place, while process_line can focus on what is valid inside each current mode.

*Call graph*: calls 1 internal fn (ensure_update_hunk_is_not_empty); called by 1 (process_line); 4 external calls (from, new, new, matches!).


##### `StreamingPatchParser::push_delta`  (lines 139–152)

```
fn push_delta(&mut self, delta: &str) -> Result<Vec<Hunk>, ParseError>
```

**Purpose**: Feeds a new piece of streamed patch text into the parser. It is the main method used while data is still arriving.

**Data flow**: It receives a text fragment, which may contain many lines, one full line, or only part of a line. It adds characters to an internal line buffer until it sees a newline. Each complete line is removed from the buffer, normalized for Windows-style line endings, counted, and passed to StreamingPatchParser::process_line. It returns a clone of the hunks parsed so far, or an error if the new text breaks the patch format.

**Call relations**: This is the streaming entry point for the parser. As each fragment arrives, it delegates complete lines to StreamingPatchParser::process_line and keeps incomplete trailing text for a later call.

*Call graph*: calls 1 internal fn (process_line); called by 1 (push_delta); 1 external calls (take).


##### `StreamingPatchParser::finish`  (lines 154–173)

```
fn finish(&mut self) -> Result<Vec<Hunk>, ParseError>
```

**Purpose**: Finalizes parsing after no more text will arrive. It validates that the patch really ended with the required end marker.

**Data flow**: It first checks whether the line buffer still contains a final line without a newline. If so, it processes that line or treats it as the end marker. Then it verifies that the parser reached the ended state. On success it returns the parsed hunks; on failure it returns an error saying the patch must end with “*** End Patch”.

**Call relations**: This is called by the completion path, noted as finish_update_on_complete in the call graph. It uses StreamingPatchParser::process_line for ordinary final content and StreamingPatchParser::ensure_update_hunk_is_not_empty when the last buffered line is the end marker.

*Call graph*: calls 2 internal fn (ensure_update_hunk_is_not_empty, process_line); called by 1 (finish_update_on_complete); 2 external calls (matches!, take).


##### `StreamingPatchParser::process_line`  (lines 175–408)

```
fn process_line(&mut self, line: &str) -> Result<(), ParseError>
```

**Purpose**: Interprets one complete line according to where the parser currently is in the patch. This is the core state machine: it decides what each line means and whether it is valid.

**Data flow**: It receives one full line. It trims or preserves parts of the line depending on context, then checks the current parser mode. Before the patch starts, it only accepts the begin marker. In add-file mode, it appends “+” lines to the new file contents. In delete-file mode, it only allows the next header or the end marker. In update-file mode, it records move targets, chunk headers, context lines, added lines, removed lines, and end-of-file markers. It updates the parser’s stored hunks and mode, or returns a detailed parse error.

**Call relations**: StreamingPatchParser::push_delta calls this for every completed incoming line, and StreamingPatchParser::finish calls it for a final line without a newline. It calls StreamingPatchParser::handle_hunk_headers_and_end_patch first when a line might start a new section or end the patch.

*Call graph*: calls 1 internal fn (handle_hunk_headers_and_end_patch); called by 2 (finish, push_delta); 4 external calls (from, new, new, format!).


##### `tests::test_streaming_patch_parser_streams_complete_lines_before_end_patch`  (lines 419–480)

```
fn test_streaming_patch_parser_streams_complete_lines_before_end_patch()
```

**Purpose**: Checks that the parser reports hunks as soon as complete lines are available, even before the final end marker arrives. It also checks add, update-with-move, delete, and multiple hunk cases.

**Data flow**: The test creates fresh parsers, feeds them partial patch strings, and compares the returned hunks with expected structured results. It confirms that an incomplete line is not parsed until its newline arrives, while completed hunks appear immediately.

**Call relations**: This test calls the public streaming method on StreamingPatchParser. It supports the bigger streaming flow by proving that callers can safely observe progress before the patch is finished.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_environment_id_mode`  (lines 483–519)

```
fn test_streaming_patch_parser_environment_id_mode()
```

**Purpose**: Checks the optional environment ID feature. It verifies that a valid ID is stored, while duplicate or blank IDs are rejected.

**Data flow**: The test feeds patches containing environment ID lines into new parsers. It then compares parsed hunks and reads back the saved environment ID, or checks that the right parse errors are returned.

**Call relations**: This test exercises the path where StreamingPatchParser::process_line delegates header-like lines to StreamingPatchParser::handle_hunk_headers_and_end_patch, which records or rejects the environment ID.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_large_patch_split_by_character`  (lines 522–610)

```
fn test_streaming_patch_parser_large_patch_split_by_character()
```

**Purpose**: Checks that the parser still works when a large patch arrives one character at a time. This simulates the most fragmented possible stream.

**Data flow**: The test sends each character of a multi-file patch through the parser separately. It records when the number of parsed hunks increases, then confirms the hunk count never goes backward and the final hunk types match the patch.

**Call relations**: This test stresses StreamingPatchParser::push_delta and its line buffer. It proves the parser does not depend on receiving neat line-sized chunks from its caller.

*Call graph*: 4 external calls (new, default, assert!, assert_eq!).


##### `tests::test_streaming_patch_parser_keeps_indented_update_markers_as_context_lines`  (lines 613–649)

```
fn test_streaming_patch_parser_keeps_indented_update_markers_as_context_lines()
```

**Purpose**: Checks that a marker-looking line inside an update is treated as normal content when it is indented with a leading space. This matters because real file content may contain text that resembles patch headers.

**Data flow**: The test feeds an update patch where “*** Update File” appears with a leading space inside the changed content. It expects that text to be stored as an unchanged context line rather than starting a new file update.

**Call relations**: This test protects the distinction made in StreamingPatchParser::process_line between real headers and update content. It shows why preserving the leading character of update lines is important.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_preserves_bare_empty_update_lines`  (lines 652–687)

```
fn test_streaming_patch_parser_preserves_bare_empty_update_lines()
```

**Purpose**: Checks that an empty line inside an update hunk is treated as an empty context line. This keeps the streaming parser compatible with the normal parser’s more forgiving behavior.

**Data flow**: The test sends an update containing a blank line between two context lines. It expects the parsed old and new line lists to include an empty string in that position.

**Call relations**: This test focuses on StreamingPatchParser::process_line in update mode. It guards the rule that a bare empty line can be meaningful file content, not just whitespace to ignore.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_ignores_empty_lines_after_end_of_file`  (lines 690–707)

```
fn test_streaming_patch_parser_ignores_empty_lines_after_end_of_file()
```

**Purpose**: Checks that blank lines after an end-of-file marker inside an update do not cause an error. This allows a little harmless spacing before the patch end marker.

**Data flow**: The test feeds an update hunk with an added line, an end-of-file marker, then an empty line before the patch ends. It expects the update chunk to be accepted and marked as ending at the file end.

**Call relations**: This test covers a special branch in StreamingPatchParser::process_line for update mode after an end-of-file marker. It makes sure only empty lines are ignored there, while other unexpected content would still fail.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_matches_line_ending_behavior`  (lines 710–740)

```
fn test_streaming_patch_parser_matches_line_ending_behavior()
```

**Purpose**: Checks how the streaming parser treats Windows-style line endings. It ensures normal carriage-return-plus-newline endings are stripped correctly, while an extra carriage return that is part of the content is preserved.

**Data flow**: The test feeds two patches with carriage returns. In the normal case, parsed lines contain clean text. In the extra-carriage-return case, the extra character remains in the removed line as expected.

**Call relations**: This test exercises the newline handling in StreamingPatchParser::push_delta before lines are passed to StreamingPatchParser::process_line. It protects compatibility with patches produced on different operating systems.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_finish_processes_final_line_without_newline`  (lines 743–789)

```
fn test_streaming_patch_parser_finish_processes_final_line_without_newline()
```

**Purpose**: Checks that finishing the parser handles a final line even when the stream did not end with a newline. Many text streams can end this way, so the parser must not lose that last line.

**Data flow**: The test feeds patches whose final end marker lacks a trailing newline. It first observes the hunks returned during streaming, then calls finish and expects the same valid hunks back.

**Call relations**: This test targets StreamingPatchParser::finish. It proves finish drains the leftover line buffer and recognizes the end marker correctly.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_finish_requires_end_patch`  (lines 792–807)

```
fn test_streaming_patch_parser_finish_requires_end_patch()
```

**Purpose**: Checks that finish rejects a patch that never ends with the required end marker. Without this, a cut-off patch could be mistaken for a complete one.

**Data flow**: The test feeds a patch that starts adding a file but stops before “*** End Patch”. Streaming returns the partial add hunk, but finish returns an invalid-patch error.

**Call relations**: This test covers the final validation in StreamingPatchParser::finish. It distinguishes progress reporting during streaming from accepting a completed patch.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_rejects_content_after_end_patch`  (lines 810–831)

```
fn test_streaming_patch_parser_rejects_content_after_end_patch()
```

**Purpose**: Checks that non-empty text after the end marker is rejected, while blank whitespace after the end is allowed. This keeps the end marker meaningful without being too strict about trailing blank lines.

**Data flow**: The test feeds one patch with an extra content line after the end marker and expects an error. It feeds another patch with only whitespace after the end marker and expects the parsed add hunk to remain valid.

**Call relations**: This test exercises the ended state in StreamingPatchParser::process_line. It confirms that once the patch is closed, only empty trailing lines are acceptable.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::test_streaming_patch_parser_returns_errors`  (lines 834–943)

```
fn test_streaming_patch_parser_returns_errors()
```

**Purpose**: Checks many malformed patch cases and their exact errors. These cases make sure users get clear feedback when patch text is wrong or incomplete.

**Data flow**: The test creates fresh parsers for bad inputs: missing begin marker, invalid headers, invalid add/delete content, empty update hunks, empty chunks, repeated context markers, and unexpected update lines. Each input is compared against the expected parse error and line number.

**Call relations**: This test covers the error paths across StreamingPatchParser::push_delta, StreamingPatchParser::process_line, StreamingPatchParser::handle_hunk_headers_and_end_patch, and StreamingPatchParser::ensure_update_hunk_is_not_empty. It protects the parser’s safety checks as a group.

*Call graph*: 2 external calls (default, assert_eq!).


### `apply-patch/src/parser.rs`

`domain_logic` · `apply_patch request parsing`

This parser is the front door for the apply-patch format. A patch is just text, but the rest of the program needs a clear list of actions. This file checks that the text starts and ends with the expected patch markers, then breaks the patch into “hunks,” meaning separate file changes. A hunk can add a file, delete a file, or update a file, including moving it to a new path.

The file also defines the main shapes of parsed data. `Hunk` describes the kind of file operation. `UpdateFileChunk` describes one replacement area inside an updated file: optional nearby context, old lines to find, new lines to insert, and whether the change belongs at the end of the file.

One important detail is lenient parsing. Some callers accidentally pass a shell-style heredoc wrapper, like `<<'EOF' ... EOF`, as literal text. In normal shell use, that wrapper would be stripped by the shell. Here, it may arrive untouched. Lenient mode recognizes a small set of these wrappers, removes them, and then parses the real patch inside. Think of it like opening an envelope before reading the letter.

This file does not check the real filesystem. It only decides whether the patch text makes sense and converts it into instructions another part of the program can carry out.

#### Function details

##### `Hunk::resolve_path`  (lines 84–90)

```
fn resolve_path(&self, cwd: &AbsolutePathBuf) -> AbsolutePathBuf
```

**Purpose**: This turns the path inside a hunk into an absolute path, using the current working directory when the patch used a relative path. Someone would use it when they are ready to connect a parsed patch instruction to a real file location.

**Data flow**: It receives a hunk and a current working directory. It first decides which path the hunk refers to: for ordinary add/delete/update actions it uses the hunk path, while for an update with a move destination it resolves the original update path. It then combines that path with the working directory if needed, and returns an absolute path.

**Call relations**: After parsing has produced hunks, later apply logic can call this to find the concrete file path. Inside this method, it asks `Hunk::path` for the path in the add/delete cases, then delegates the final relative-versus-absolute decision to `resolve_path_against_base`.

*Call graph*: calls 2 internal fn (path, resolve_path_against_base).


##### `Hunk::path`  (lines 93–107)

```
fn path(&self) -> &Path
```

**Purpose**: This returns the main path a hunk affects. For a rename-style update, it reports the destination path, because that is the file path the hunk should be considered to affect after the move.

**Data flow**: It receives a hunk and inspects its variant. Add and delete hunks return their stored path. Update hunks return the move destination if there is one; otherwise they return the original update path. Nothing is changed.

**Call relations**: This is a small helper used by `Hunk::resolve_path` when an absolute path is needed. It centralizes the rule for which path represents each kind of hunk, especially the special case of moved files.

*Call graph*: called by 1 (resolve_path).


##### `parse_patch`  (lines 129–136)

```
fn parse_patch(patch: &str) -> Result<ApplyPatchArgs, ParseError>
```

**Purpose**: This is the public parsing entry for patch text. It chooses the parser’s tolerance level and returns structured `ApplyPatchArgs`, which are the parsed instructions used by apply-patch.

**Data flow**: It receives raw patch text. It chooses strict or lenient mode based on the file-level setting, then passes the text to `parse_patch_text`. The result is either parsed patch arguments or a clear parse error.

**Call relations**: This is the function other parts of the apply-patch flow call when they need to understand patch text. It is called by application paths such as `apply_patch`, `maybe_parse_apply_patch`, and related verification or test flows, and it hands the real parsing work to `parse_patch_text`.

*Call graph*: calls 1 internal fn (parse_patch_text); called by 10 (apply_patch, maybe_parse_apply_patch, maybe_parse_apply_patch_verified, test_unified_diff_insert_at_eof, test_unified_diff_last_line_replacement, test_unified_diff, test_unified_diff_first_line_replacement, test_unified_diff_insert_at_eof, test_unified_diff_interleaved_changes, test_unified_diff_last_line_replacement).


##### `parse_patch_text`  (lines 177–195)

```
fn parse_patch_text(patch: &str, mode: ParseMode) -> Result<ApplyPatchArgs, ParseError>
```

**Purpose**: This does the main conversion from patch text into `ApplyPatchArgs`. It checks the outer patch markers, feeds the inner text into the streaming parser, and packages the parsed hunks with the original normalized patch text.

**Data flow**: It receives patch text and a parse mode. First it trims the whole input and splits it into lines. In strict mode it requires the first and last patch markers directly; in lenient mode it may also unwrap a simple heredoc wrapper. It rejoins the accepted lines, sends them through `StreamingPatchParser`, collects hunks and an optional environment ID, and returns an `ApplyPatchArgs` value. If any step fails, it returns a `ParseError`.

**Call relations**: `parse_patch` calls this after choosing the mode. This function uses `check_patch_boundaries_strict` or `check_patch_boundaries_lenient` to guard the outside of the patch before handing the contents to the streaming parser, which understands the hunks themselves.

*Call graph*: calls 2 internal fn (check_patch_boundaries_lenient, check_patch_boundaries_strict); called by 1 (parse_patch); 1 external calls (default).


##### `check_patch_boundaries_strict`  (lines 199–207)

```
fn check_patch_boundaries_strict(lines: &'a [&'a str]) -> Result<&'a [&'a str], ParseError>
```

**Purpose**: This checks that the patch text begins with `*** Begin Patch` and ends with `*** End Patch`. It protects the parser from reading random text as if it were a patch.

**Data flow**: It receives a slice of text lines. It picks out the first and last line, including the empty and one-line edge cases, and asks `check_start_and_end_lines_strict` to validate them. If they are valid, it returns the same line slice unchanged; otherwise it returns a parse error.

**Call relations**: `parse_patch_text` uses this directly in strict mode. `check_patch_boundaries_lenient` also uses it first, because lenient mode still prefers a normal patch when the input already has the right markers.

*Call graph*: calls 1 internal fn (check_start_and_end_lines_strict); called by 2 (check_patch_boundaries_lenient, parse_patch_text).


##### `check_patch_boundaries_lenient`  (lines 216–238)

```
fn check_patch_boundaries_lenient(
    original_lines: &'a [&'a str],
) -> Result<&'a [&'a str], ParseError>
```

**Purpose**: This accepts normal patch text, and also accepts one common mistaken wrapper around patch text: a literal heredoc such as `<<EOF` at the start and `EOF` at the end. It exists so apply-patch can still work when a caller sends what was meant to be shell syntax as plain text.

**Data flow**: It receives the original input lines. First it tries the strict boundary check. If that succeeds, it returns those lines. If strict checking fails, it looks for a supported heredoc opening line, a closing line ending in `EOF`, and enough lines to contain a real patch. When that wrapper is present, it removes the first and last lines and then strictly checks the inner patch. If not, it returns the original strict-mode error.

**Call relations**: `parse_patch_text` calls this when lenient parsing is enabled. This function calls back into `check_patch_boundaries_strict` so that even unwrapped heredoc contents must still be a real apply-patch patch.

*Call graph*: calls 1 internal fn (check_patch_boundaries_strict); called by 1 (parse_patch_text).


##### `check_start_and_end_lines_strict`  (lines 240–258)

```
fn check_start_and_end_lines_strict(
    first_line: Option<&&str>,
    last_line: Option<&&str>,
) -> Result<(), ParseError>
```

**Purpose**: This performs the exact marker check for the first and last patch lines. It also creates helpful error messages that tell the caller whether the beginning or ending marker is wrong.

**Data flow**: It receives optional references to the first and last lines. It trims whitespace around each marker line, then compares them to the required begin and end strings. If both match, it returns success. If the first line is wrong, it returns an error about the first line. Otherwise it returns an error about the last line.

**Call relations**: `check_patch_boundaries_strict` calls this after finding the first and last lines. Its errors travel back through strict or lenient boundary checking and eventually back to `parse_patch_text` or `parse_patch`.

*Call graph*: called by 1 (check_patch_boundaries_strict); 1 external calls (from).


##### `test_parse_patch`  (lines 261–408)

```
fn test_parse_patch()
```

**Purpose**: This test checks the parser’s basic behavior across bad patches, empty patches, add/delete/update hunks, moved files, and update hunks with or without explicit context headers.

**Data flow**: It feeds several patch strings into `parse_patch_text` in strict mode. For each one, it compares the returned parsed hunks or errors with the expected result. The test does not produce runtime output unless an assertion fails.

**Call relations**: This test exercises the main parsing path beneath `parse_patch_text`. It confirms that the lower-level boundary checks and hunk parsing work together for common valid and invalid inputs.

*Call graph*: 1 external calls (assert_eq!).


##### `test_parse_patch_preserves_end_of_file_marker`  (lines 411–432)

```
fn test_parse_patch_preserves_end_of_file_marker()
```

**Purpose**: This test makes sure an update chunk marked as applying at the end of a file keeps that meaning after parsing.

**Data flow**: It builds a patch containing `*** End of File`, passes it to `parse_patch`, and expects an `ApplyPatchArgs` result whose update chunk has `is_end_of_file` set to true. If that flag is lost, the assertion fails.

**Call relations**: This test goes through the public `parse_patch` entry rather than only `parse_patch_text`, so it checks the normal path used by callers. It protects the contract between the text marker and later apply logic that needs to know the change belongs at file end.

*Call graph*: 1 external calls (assert_eq!).


##### `test_parse_patch_accepts_relative_and_absolute_hunk_paths`  (lines 435–477)

```
fn test_parse_patch_accepts_relative_and_absolute_hunk_paths()
```

**Purpose**: This test confirms that hunk paths may be either relative paths, like `relative-add.py`, or absolute paths, like `/tmp/.../file.py`.

**Data flow**: It creates temporary absolute paths, formats them into a patch, and parses the patch in strict mode. It then compares the parsed hunks with the expected paths and line changes.

**Call relations**: This test supports the parsing layer’s path behavior. It checks that `parse_patch_text` preserves the paths written in the patch instead of rejecting absolute paths or rewriting them too early.

*Call graph*: 3 external calls (assert_eq!, format!, tempdir).


##### `test_hunk_resolve_path_accepts_relative_and_absolute_paths`  (lines 480–534)

```
fn test_hunk_resolve_path_accepts_relative_and_absolute_paths()
```

**Purpose**: This test verifies that `Hunk::resolve_path` turns relative paths into paths under the chosen working directory, while leaving already absolute paths alone.

**Data flow**: It creates temporary directories for a working directory and absolute test paths. It builds several add, delete, and update hunks, calls `resolve_path` on each, and compares the result to the expected absolute path.

**Call relations**: This test focuses on `Hunk::resolve_path` and indirectly on `Hunk::path`. It protects the later file-application stage from receiving wrong file locations after parsing.

*Call graph*: 5 external calls (from, new, new, assert_eq!, tempdir).


##### `test_parse_patch_lenient`  (lines 537–623)

```
fn test_parse_patch_lenient()
```

**Purpose**: This test checks the special lenient parsing behavior for heredoc-wrapped patch text. It ensures valid wrappers are accepted in lenient mode but still rejected in strict mode.

**Data flow**: It starts with a valid patch, wraps it in several heredoc styles, and parses each wrapper in both strict and lenient modes. It expects strict mode to reject the wrapper, lenient mode to accept supported wrappers, and malformed or incomplete wrappers to produce clear errors.

**Call relations**: This test exercises `parse_patch_text` with both parse modes and specifically protects `check_patch_boundaries_lenient`. It documents the compatibility behavior added for callers that accidentally pass shell heredoc syntax as literal text.

*Call graph*: 3 external calls (assert_eq!, format!, vec!).


##### `test_parse_patch_environment_id_preamble`  (lines 626–660)

```
fn test_parse_patch_environment_id_preamble()
```

**Purpose**: This test checks that an optional environment ID line after the begin marker is parsed and stored, and that an empty environment ID is rejected.

**Data flow**: It sends one patch with `*** Environment ID: remote` and expects the returned `ApplyPatchArgs` to contain `environment_id: Some("remote")`. It then sends a patch with only spaces after the environment ID marker and expects an invalid-patch error.

**Call relations**: This test runs through `parse_patch_text`, including the streaming parser that reads the preamble. It protects the small but important link between patch text and the environment selection information used by callers.

*Call graph*: 1 external calls (assert_eq!).


### `apply-patch/src/invocation.rs`

`orchestration` · `command/request handling before applying a patch`

This file sits at the doorway between command execution and patch application. Users or models may ask to run `apply_patch` directly, or they may wrap it inside a shell command such as `bash -lc "apply_patch <<'PATCH' ... PATCH"`. This file decides whether the command is one of those supported forms, pulls out the patch body, parses it, and then verifies it against the current filesystem.

The code is deliberately conservative. For shell heredocs, it uses Tree-sitter, a parser library that reads shell text as a structured tree rather than as loose strings. That matters because shell syntax can be tricky. The file only accepts simple top-level forms like `apply_patch <<...` or `cd path && apply_patch <<...`; extra commands before or after are rejected. This is like accepting a package only if the label is exactly where expected, not hidden inside other instructions.

After parsing, verification resolves relative file paths against the working directory, reads existing files for deletes and updates, and builds a map of planned file changes. It also rejects “implicit invocation,” where raw patch text is passed without the `apply_patch` command, so accidental patches are reported as errors instead of silently applied.

#### Function details

##### `classify_shell_name`  (lines 54–59)

```
fn classify_shell_name(shell: &str) -> Option<String>
```

**Purpose**: Turns a shell executable path into a simple lowercase shell name, such as `bash` from `/bin/bash` or `powershell` from `powershell.exe`. This lets later code recognize shells without caring about full paths or file extensions.

**Data flow**: It receives a shell string → treats it like a filesystem path, takes the filename stem, converts it to text, and lowercases it → returns the normalized name if that was possible, or nothing if it could not read a name.

**Call relations**: This is the small cleanup step used by `classify_shell` and `can_skip_flag` before they decide whether an argument list looks like a supported shell command.

*Call graph*: called by 2 (can_skip_flag, classify_shell); 1 external calls (new).


##### `classify_shell`  (lines 61–70)

```
fn classify_shell(shell: &str, flag: &str) -> Option<ApplyPatchShell>
```

**Purpose**: Decides whether a shell name and its command flag represent a supported shell invocation. It recognizes Unix-style shells, PowerShell, and Windows `cmd` only with the expected flags.

**Data flow**: It receives the shell program and the flag that should mean “run this script” → normalizes the shell name and checks the flag → returns the matching shell kind or nothing if the pair is not trusted.

**Call relations**: `parse_shell_script` calls this after it has found a likely shell command. Its answer tells later code which extraction path to use.

*Call graph*: calls 1 internal fn (classify_shell_name); called by 1 (parse_shell_script).


##### `can_skip_flag`  (lines 72–76)

```
fn can_skip_flag(shell: &str, flag: &str) -> bool
```

**Purpose**: Recognizes a harmless extra PowerShell flag, `-NoProfile`, that may appear before the real command flag. This keeps PowerShell support flexible without accepting arbitrary extra flags.

**Data flow**: It receives a shell program and a flag → normalizes the shell name and checks whether the shell is PowerShell and the flag is `-NoProfile` → returns true only for that allowed case.

**Call relations**: `parse_shell_script` uses this when an argument list has four parts instead of three, so it can still accept `powershell -NoProfile -Command ...`.

*Call graph*: calls 1 internal fn (classify_shell_name); called by 1 (parse_shell_script).


##### `parse_shell_script`  (lines 78–92)

```
fn parse_shell_script(argv: &[String]) -> Option<(ApplyPatchShell, &str)>
```

**Purpose**: Looks at a command argument list and determines whether it is a supported shell running a single script string. It extracts both the shell type and the script text.

**Data flow**: It receives the full command arguments → checks either `shell flag script` or the PowerShell `shell skip_flag flag script` shape → returns the shell kind plus script text, or nothing if the shape is not supported.

**Call relations**: `maybe_parse_apply_patch` uses it to find heredoc-style patch commands. `maybe_parse_apply_patch_verified` also uses it early to catch raw patch text hidden as a shell script.

*Call graph*: calls 2 internal fn (can_skip_flag, classify_shell); called by 2 (maybe_parse_apply_patch, maybe_parse_apply_patch_verified).


##### `extract_apply_patch_from_shell`  (lines 94–103)

```
fn extract_apply_patch_from_shell(
    shell: ApplyPatchShell,
    script: &str,
) -> std::result::Result<(String, Option<String>), ExtractHeredocError>
```

**Purpose**: Routes shell script extraction to the parser that can recognize the supported `apply_patch` heredoc form. At present, all supported shell kinds use the same Bash-style extraction logic.

**Data flow**: It receives a shell kind and script text → chooses the extraction routine for that shell → returns the heredoc patch body and optional working directory, or an extraction error.

**Call relations**: `maybe_parse_apply_patch` calls this after `parse_shell_script` identifies a shell script. It hands off to `extract_apply_patch_from_bash` for the actual syntax checking.

*Call graph*: calls 1 internal fn (extract_apply_patch_from_bash); called by 1 (maybe_parse_apply_patch).


##### `maybe_parse_apply_patch`  (lines 106–131)

```
fn maybe_parse_apply_patch(argv: &[String]) -> MaybeApplyPatch
```

**Purpose**: Determines whether a command is an `apply_patch` invocation and, if so, parses the patch into structured arguments. It supports both direct calls and carefully limited shell heredocs.

**Data flow**: It receives command arguments → first checks `apply_patch <body>` or `applypatch <body>` → otherwise checks for a supported shell script and extracts a heredoc body → parses the patch text → returns parsed patch arguments, a parse error, a shell extraction error, or “not apply_patch.”

**Call relations**: This is the main recognizer used by the verified path and by many tests. It relies on `parse_shell_script`, `extract_apply_patch_from_shell`, and `parse_patch` to move from raw command text to structured patch data.

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

**Purpose**: Combines recognition with safety checks, producing a verified patch action only when the command was explicit and the patch can be checked against the filesystem. It prevents raw patch text from being treated as a command by accident.

**Data flow**: It receives command arguments, the absolute current directory, a filesystem interface, and an optional sandbox context → rejects single raw patch bodies and raw patch shell scripts as implicit invocation errors → parses normal invocations → verifies parsed patch arguments → returns a verified action, a specific error, or “not apply_patch.”

**Call relations**: This is the higher-level entry used when the executor is deciding what to do with a command. It calls `maybe_parse_apply_patch` for recognition and `verify_apply_patch_args` when a real patch has been found.

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

**Purpose**: Checks parsed patch instructions against the actual filesystem and turns them into a concrete set of file changes. This is where relative paths become absolute and update/delete operations are backed by existing file contents.

**Data flow**: It receives parsed patch arguments, the current directory, a filesystem interface, and optional sandbox information → computes the effective working directory, then walks each patch hunk → for added files it records new content; for deleted files it reads the existing content; for updated files it computes the new content and a unified diff → returns a verified patch action or a correctness error.

**Call relations**: `maybe_parse_apply_patch_verified` calls this after parsing succeeds. It calls filesystem reading for deletes and `unified_diff_from_chunks` for updates, then packages everything as an `ApplyPatchAction`.

*Call graph*: calls 2 internal fn (read_file_text, from_abs_path); called by 1 (maybe_parse_apply_patch_verified); 6 external calls (new, IoError, Body, CorrectnessError, unified_diff_from_chunks, format!).


##### `extract_apply_patch_from_bash`  (lines 257–387)

```
fn extract_apply_patch_from_bash(
    src: &str,
) -> std::result::Result<(String, Option<String>), ExtractHeredocError>
```

**Purpose**: Safely extracts a heredoc patch body, and possibly a leading `cd` directory, from a very restricted shell script shape. It rejects scripts that contain extra commands or more complicated shell behavior.

**Data flow**: It receives shell script text → parses it with Tree-sitter Bash into a syntax tree → runs a strict query looking only for `apply_patch <<...` or `cd path && apply_patch <<...` as the entire top-level script → returns the heredoc body and optional directory, or a clear extraction error.

**Call relations**: `extract_apply_patch_from_shell` calls this for all currently supported shell kinds. Its result feeds back into `maybe_parse_apply_patch`, which then parses the extracted patch body.

*Call graph*: called by 1 (extract_apply_patch_from_shell); 3 external calls (new, new, new).


##### `tests::wrap_patch`  (lines 403–405)

```
fn wrap_patch(body: &str) -> String
```

**Purpose**: Builds a complete patch string around a smaller patch body for tests. This keeps test cases focused on the part being changed.

**Data flow**: It receives the middle lines of a patch → adds the standard begin and end markers → returns a full patch string.

**Call relations**: Several update-related tests call this before sending the patch to `parse_patch` or the verified invocation path.

*Call graph*: 1 external calls (format!).


##### `tests::strs_to_strings`  (lines 407–409)

```
fn strs_to_strings(strs: &[&str]) -> Vec<String>
```

**Purpose**: Converts a list of string slices into owned `String` values for test command arguments. Rust command argument lists in these tests use owned strings.

**Data flow**: It receives borrowed string values → clones each one into an owned string → returns a vector of strings.

**Call relations**: The shell argument helper functions and literal invocation tests use this to build realistic `argv` arrays.


##### `tests::args_bash`  (lines 412–414)

```
fn args_bash(script: &str) -> Vec<String>
```

**Purpose**: Creates test arguments for running a script through `bash -lc`. This gives tests a consistent way to simulate Bash heredoc commands.

**Data flow**: It receives script text → combines it with `bash` and `-lc` → returns a vector of command arguments.

**Call relations**: Assertion helpers and heredoc tests call this before passing arguments to `maybe_parse_apply_patch`.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::args_powershell`  (lines 416–418)

```
fn args_powershell(script: &str) -> Vec<String>
```

**Purpose**: Creates test arguments for running a script through Windows PowerShell with `-Command`. It checks that PowerShell-style invocation is recognized.

**Data flow**: It receives script text → combines it with `powershell.exe` and `-Command` → returns command arguments.

**Call relations**: The PowerShell heredoc test uses this, then sends the result through the common match assertion helper.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::args_powershell_no_profile`  (lines 420–422)

```
fn args_powershell_no_profile(script: &str) -> Vec<String>
```

**Purpose**: Creates test arguments for PowerShell when `-NoProfile` is included before `-Command`. This tests the one optional flag the production parser allows.

**Data flow**: It receives script text → builds `powershell.exe -NoProfile -Command <script>` → returns command arguments.

**Call relations**: The no-profile PowerShell test uses this to confirm `parse_shell_script` accepts that extra flag.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::args_pwsh`  (lines 424–426)

```
fn args_pwsh(script: &str) -> Vec<String>
```

**Purpose**: Creates test arguments for modern PowerShell, `pwsh`, including `-NoProfile`. This ensures both PowerShell executable names are accepted.

**Data flow**: It receives script text → builds `pwsh -NoProfile -Command <script>` → returns command arguments.

**Call relations**: The `pwsh` heredoc test uses this before calling the shared assertion helper.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::args_cmd`  (lines 428–430)

```
fn args_cmd(script: &str) -> Vec<String>
```

**Purpose**: Creates test arguments for Windows `cmd.exe /c`. This checks that the command recognizer understands the Windows command shell form.

**Data flow**: It receives script text → combines it with `cmd.exe` and `/c` → returns command arguments.

**Call relations**: The `cmd` heredoc-with-`cd` test uses this and then verifies the parsed working directory.

*Call graph*: 1 external calls (strs_to_strings).


##### `tests::heredoc_script`  (lines 432–436)

```
fn heredoc_script(prefix: &str) -> String
```

**Purpose**: Builds a standard test script that runs `apply_patch` with a heredoc containing a simple add-file patch. A caller can provide a prefix such as `cd foo && `.

**Data flow**: It receives a script prefix → places that prefix before `apply_patch <<'PATCH'` and a fixed patch body → returns the full shell script string.

**Call relations**: Most heredoc acceptance and rejection tests use this helper so only the shell prefix changes from test to test.

*Call graph*: 1 external calls (format!).


##### `tests::heredoc_script_ps`  (lines 438–442)

```
fn heredoc_script_ps(prefix: &str, suffix: &str) -> String
```

**Purpose**: Builds a standard heredoc script with both a configurable prefix and suffix. It is used to test that trailing extra commands are rejected.

**Data flow**: It receives prefix and suffix text → wraps the fixed add-file patch between them around the heredoc command → returns the full script string.

**Call relations**: The test for `cd ... && apply_patch ... && echo done` uses this to add a forbidden suffix.

*Call graph*: 1 external calls (format!).


##### `tests::expected_single_add`  (lines 444–449)

```
fn expected_single_add() -> Vec<Hunk>
```

**Purpose**: Returns the expected parsed hunk for the standard test patch that adds file `foo` with `hi`. This avoids repeating the same expected value.

**Data flow**: It takes no input → constructs one add-file hunk → returns it in a vector.

**Call relations**: `assert_match_args` compares parser output against this expected hunk in many heredoc tests.

*Call graph*: 1 external calls (vec!).


##### `tests::assert_match_args`  (lines 451–459)

```
fn assert_match_args(args: Vec<String>, expected_workdir: Option<&str>)
```

**Purpose**: Checks that a command argument list is recognized as an `apply_patch` request with the expected working directory and standard add-file patch.

**Data flow**: It receives command arguments and an expected optional workdir → calls `maybe_parse_apply_patch` → compares the parsed workdir and hunks to expected values, or fails the test.

**Call relations**: Many shell-specific tests call this after building arguments with helpers such as `args_bash`, `args_cmd`, or `args_powershell`.

*Call graph*: calls 1 internal fn (maybe_parse_apply_patch); 2 external calls (assert_eq!, panic!).


##### `tests::assert_match`  (lines 461–464)

```
fn assert_match(script: &str, expected_workdir: Option<&str>)
```

**Purpose**: Convenience helper for Bash tests that should successfully match an `apply_patch` heredoc. It hides the repeated Bash argument setup.

**Data flow**: It receives script text and an expected workdir → wraps the script as `bash -lc` arguments → delegates the actual checking to `assert_match_args`.

**Call relations**: Heredoc tests use this when they only need the standard Bash form.

*Call graph*: 2 external calls (args_bash, assert_match_args).


##### `tests::assert_not_match`  (lines 466–472)

```
fn assert_not_match(script: &str)
```

**Purpose**: Checks that a Bash script is not accepted as an `apply_patch` invocation. This guards against accidentally accepting unsafe or ambiguous shell forms.

**Data flow**: It receives script text → wraps it as `bash -lc` arguments → calls `maybe_parse_apply_patch` and asserts the result is `NotApplyPatch`.

**Call relations**: Negative shell-syntax tests use this for cases like semicolons, pipes, extra commands, or extra arguments.

*Call graph*: 2 external calls (args_bash, assert_matches!).


##### `tests::test_implicit_patch_single_arg_is_error`  (lines 475–489)

```
async fn test_implicit_patch_single_arg_is_error()
```

**Purpose**: Confirms that passing raw patch text as the only command argument is treated as an explicit error, not as a patch to apply.

**Data flow**: It builds one raw patch argument and a temporary working directory → calls the verified parser → expects an `ImplicitInvocation` correctness error.

**Call relations**: This exercises the early raw-patch guard in `maybe_parse_apply_patch_verified`.

*Call graph*: 3 external calls (assert_matches!, tempdir, vec!).


##### `tests::test_implicit_patch_bash_script_is_error`  (lines 492–506)

```
async fn test_implicit_patch_bash_script_is_error()
```

**Purpose**: Confirms that raw patch text inside a shell script argument is also rejected as implicit invocation. This prevents shell wrapping from bypassing the explicit command requirement.

**Data flow**: It builds `bash -lc <raw patch>` arguments and a temporary directory → calls the verified parser → expects an `ImplicitInvocation` error.

**Call relations**: This covers the shell-script raw-patch check inside `maybe_parse_apply_patch_verified`.

*Call graph*: 3 external calls (args_bash, assert_matches!, tempdir).


##### `tests::test_literal`  (lines 509–531)

```
async fn test_literal()
```

**Purpose**: Verifies the direct command form `apply_patch <patch body>`. It proves the simplest supported invocation parses into the expected add-file hunk.

**Data flow**: It builds direct command arguments → calls `maybe_parse_apply_patch` → checks that the parsed hunk adds `foo` with `hi`.

**Call relations**: This directly tests the first branch of `maybe_parse_apply_patch`.

*Call graph*: calls 1 internal fn (maybe_parse_apply_patch); 3 external calls (strs_to_strings, assert_eq!, panic!).


##### `tests::test_literal_applypatch`  (lines 534–556)

```
async fn test_literal_applypatch()
```

**Purpose**: Verifies the alternate direct command name `applypatch`. This keeps compatibility with both accepted command spellings.

**Data flow**: It builds direct `applypatch` arguments → calls `maybe_parse_apply_patch` → checks the same expected add-file hunk.

**Call relations**: This tests the shared direct-invocation command list used by `maybe_parse_apply_patch`.

*Call graph*: calls 1 internal fn (maybe_parse_apply_patch); 3 external calls (strs_to_strings, assert_eq!, panic!).


##### `tests::test_heredoc`  (lines 559–561)

```
async fn test_heredoc()
```

**Purpose**: Checks that a plain Bash heredoc invoking `apply_patch` is accepted.

**Data flow**: It builds the standard heredoc script with no prefix → calls the Bash match helper → expects no working directory override.

**Call relations**: This tests the normal successful path through `parse_shell_script`, `extract_apply_patch_from_bash`, and `parse_patch`.

*Call graph*: 2 external calls (assert_match, heredoc_script).


##### `tests::test_heredoc_non_login_shell`  (lines 564–568)

```
async fn test_heredoc_non_login_shell()
```

**Purpose**: Checks that `bash -c` is accepted as well as `bash -lc`. This allows both common Bash command flags.

**Data flow**: It builds a standard heredoc script and wraps it as `bash -c` arguments → calls the shared match assertion → expects a normal parsed patch.

**Call relations**: This specifically covers the flag handling in `classify_shell`.

*Call graph*: 3 external calls (assert_match_args, heredoc_script, strs_to_strings).


##### `tests::test_heredoc_applypatch`  (lines 571–596)

```
async fn test_heredoc_applypatch()
```

**Purpose**: Checks that the heredoc form also accepts the alternate command name `applypatch`.

**Data flow**: It builds a Bash heredoc using `applypatch` → calls `maybe_parse_apply_patch` → verifies the parsed hunk and absence of workdir.

**Call relations**: This exercises the command-name check inside the Tree-sitter query used by `extract_apply_patch_from_bash`.

*Call graph*: calls 1 internal fn (maybe_parse_apply_patch); 3 external calls (strs_to_strings, assert_eq!, panic!).


##### `tests::test_powershell_heredoc`  (lines 599–602)

```
async fn test_powershell_heredoc()
```

**Purpose**: Checks that a PowerShell `-Command` wrapper can carry the supported heredoc patch form.

**Data flow**: It builds the standard heredoc script → wraps it with PowerShell arguments → verifies it parses as the standard add-file patch.

**Call relations**: This confirms `parse_shell_script` recognizes PowerShell and that extraction is routed through the common heredoc parser.

*Call graph*: 3 external calls (args_powershell, assert_match_args, heredoc_script).


##### `tests::test_powershell_heredoc_no_profile`  (lines 604–610)

```
async fn test_powershell_heredoc_no_profile()
```

**Purpose**: Checks that PowerShell with `-NoProfile` before `-Command` still works. This protects the allowed optional-flag path.

**Data flow**: It builds a heredoc script → wraps it as `powershell.exe -NoProfile -Command` → verifies the parsed patch matches expectations.

**Call relations**: This test relies on `can_skip_flag` allowing exactly that extra PowerShell flag.

*Call graph*: 3 external calls (args_powershell_no_profile, assert_match_args, heredoc_script).


##### `tests::test_pwsh_heredoc`  (lines 612–615)

```
async fn test_pwsh_heredoc()
```

**Purpose**: Checks that `pwsh`, the newer PowerShell executable name, is accepted.

**Data flow**: It builds a heredoc script → wraps it as `pwsh -NoProfile -Command` → verifies the standard parsed patch.

**Call relations**: This covers the `pwsh` branch in shell classification.

*Call graph*: 3 external calls (args_pwsh, assert_match_args, heredoc_script).


##### `tests::test_cmd_heredoc_with_cd`  (lines 618–621)

```
async fn test_cmd_heredoc_with_cd()
```

**Purpose**: Checks that a Windows `cmd.exe /c` script with `cd foo && apply_patch` records `foo` as the workdir.

**Data flow**: It builds a heredoc script with a leading `cd foo && ` → wraps it in `cmd.exe /c` arguments → verifies parsing succeeds and workdir is `foo`.

**Call relations**: This combines `cmd` classification with the heredoc extractor’s `cd`-plus-apply form.

*Call graph*: 3 external calls (args_cmd, assert_match_args, heredoc_script).


##### `tests::test_heredoc_with_leading_cd`  (lines 624–626)

```
async fn test_heredoc_with_leading_cd()
```

**Purpose**: Checks that Bash accepts the safe working-directory form `cd foo && apply_patch`.

**Data flow**: It builds a heredoc script prefixed with `cd foo && ` → calls the Bash match helper → expects the parsed workdir to be `foo`.

**Call relations**: This tests the second accepted Tree-sitter query pattern in `extract_apply_patch_from_bash`.

*Call graph*: 2 external calls (assert_match, heredoc_script).


##### `tests::test_cd_with_semicolon_is_ignored`  (lines 629–631)

```
async fn test_cd_with_semicolon_is_ignored()
```

**Purpose**: Confirms that `cd foo; apply_patch` is rejected. A semicolon means “run the next command regardless,” which is not the strict safe form this parser allows.

**Data flow**: It builds a script using `cd foo; ` before the heredoc → asserts the command is not recognized as apply_patch.

**Call relations**: This protects the requirement that the connector between `cd` and `apply_patch` must be `&&`.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_or_apply_patch_is_ignored`  (lines 634–636)

```
async fn test_cd_or_apply_patch_is_ignored()
```

**Purpose**: Confirms that `cd bar || apply_patch` is rejected. The parser does not allow fallback-style shell logic.

**Data flow**: It builds a script using `cd bar || ` before the heredoc → asserts it does not match.

**Call relations**: This checks that `extract_apply_patch_from_bash` accepts only the strict `cd path && apply_patch` shape.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_pipe_apply_patch_is_ignored`  (lines 639–641)

```
async fn test_cd_pipe_apply_patch_is_ignored()
```

**Purpose**: Confirms that piping from `cd` into `apply_patch` is rejected. A pipe is not a valid way to set the working directory.

**Data flow**: It builds a script using `cd bar | ` before the heredoc → asserts it is not recognized.

**Call relations**: This guards the Tree-sitter query against accepting shell operators other than `&&`.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_single_quoted_path_with_spaces`  (lines 644–646)

```
async fn test_cd_single_quoted_path_with_spaces()
```

**Purpose**: Checks that a single-quoted `cd` path containing spaces is accepted and unquoted correctly.

**Data flow**: It builds `cd 'foo bar' && apply_patch ...` → parses it → expects the workdir value `foo bar`.

**Call relations**: This tests the raw-string capture path in `extract_apply_patch_from_bash`.

*Call graph*: 2 external calls (assert_match, heredoc_script).


##### `tests::test_cd_double_quoted_path_with_spaces`  (lines 649–651)

```
async fn test_cd_double_quoted_path_with_spaces()
```

**Purpose**: Checks that a double-quoted `cd` path containing spaces is accepted.

**Data flow**: It builds `cd "foo bar" && apply_patch ...` → parses it → expects the workdir value `foo bar`.

**Call relations**: This tests the string-content capture path in the heredoc extraction query.

*Call graph*: 2 external calls (assert_match, heredoc_script).


##### `tests::test_echo_and_apply_patch_is_ignored`  (lines 654–656)

```
async fn test_echo_and_apply_patch_is_ignored()
```

**Purpose**: Confirms that `echo foo && apply_patch` is not mistaken for the safe `cd && apply_patch` form.

**Data flow**: It builds a script prefixed with `echo foo && ` → asserts it is not recognized.

**Call relations**: This ensures the extractor specifically requires `cd` before `&&`, not just any command.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_apply_patch_with_arg_is_ignored`  (lines 659–662)

```
async fn test_apply_patch_with_arg_is_ignored()
```

**Purpose**: Confirms that heredoc `apply_patch` with an extra positional argument is rejected. The supported heredoc command takes no normal arguments.

**Data flow**: It builds `apply_patch foo <<'PATCH' ...` → asserts the script is not recognized.

**Call relations**: This protects the strict direct heredoc pattern in `extract_apply_patch_from_bash`.

*Call graph*: 1 external calls (assert_not_match).


##### `tests::test_double_cd_then_apply_patch_is_ignored`  (lines 665–667)

```
async fn test_double_cd_then_apply_patch_is_ignored()
```

**Purpose**: Confirms that chained directory changes like `cd foo && cd bar && apply_patch` are rejected. The parser only accepts one simple optional `cd`.

**Data flow**: It builds a script with two `cd` commands before the heredoc → asserts it is not recognized.

**Call relations**: This keeps `extract_apply_patch_from_bash` from accepting more complex shell command lists.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_two_args_is_ignored`  (lines 670–672)

```
async fn test_cd_two_args_is_ignored()
```

**Purpose**: Confirms that `cd` with two arguments is rejected. The supported form allows exactly one path argument.

**Data flow**: It builds `cd foo bar && apply_patch ...` → asserts it does not match.

**Call relations**: This tests the strict `cd` argument shape in the Tree-sitter query.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_cd_then_apply_patch_then_extra_is_ignored`  (lines 675–678)

```
async fn test_cd_then_apply_patch_then_extra_is_ignored()
```

**Purpose**: Confirms that extra commands after the heredoc invocation are rejected. The patch command must be the whole top-level script.

**Data flow**: It builds `cd bar && apply_patch ... && echo done` → asserts it is not recognized.

**Call relations**: This protects the query anchors in `extract_apply_patch_from_bash`, which require no trailing command.

*Call graph*: 2 external calls (assert_not_match, heredoc_script_ps).


##### `tests::test_echo_then_cd_and_apply_patch_is_ignored`  (lines 681–684)

```
async fn test_echo_then_cd_and_apply_patch_is_ignored()
```

**Purpose**: Confirms that commands before a valid-looking `cd && apply_patch` sequence cause rejection. The file only accepts a single top-level patch command.

**Data flow**: It builds `echo foo; cd bar && apply_patch ...` → asserts it is not recognized.

**Call relations**: This tests the leading anchor behavior in the heredoc extraction query.

*Call graph*: 2 external calls (assert_not_match, heredoc_script).


##### `tests::test_unified_diff_last_line_replacement`  (lines 687–726)

```
async fn test_unified_diff_last_line_replacement()
```

**Purpose**: Checks that replacing the last line of a file produces the correct unified diff and new content. A unified diff is a standard text format showing removed and added lines.

**Data flow**: It creates a temporary file → builds and parses an update patch that changes the final line → calls `unified_diff_from_chunks` → compares the resulting diff, original content, and new content to expected values.

**Call relations**: Although the diff function lives outside this file, this test supports `verify_apply_patch_args`, which depends on that diff result for update hunks.

*Call graph*: calls 1 internal fn (parse_patch); 7 external calls (wrap_patch, assert_eq!, unified_diff_from_chunks, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_insert_at_eof`  (lines 729–765)

```
async fn test_unified_diff_insert_at_eof()
```

**Purpose**: Checks that inserting a line at the end of a file produces the correct diff and final content.

**Data flow**: It creates a temporary file → builds and parses a patch with an end-of-file insertion → calls `unified_diff_from_chunks` → compares the result to the expected diff and content.

**Call relations**: This covers another update case used by `verify_apply_patch_args` when turning patch chunks into verified file changes.

*Call graph*: calls 1 internal fn (parse_patch); 7 external calls (wrap_patch, assert_eq!, unified_diff_from_chunks, format!, write, panic!, tempdir).


##### `tests::test_apply_patch_should_resolve_absolute_paths_in_cwd`  (lines 768–817)

```
async fn test_apply_patch_should_resolve_absolute_paths_in_cwd()
```

**Purpose**: Verifies that relative patch paths are resolved against the provided current directory, not some unrelated process directory.

**Data flow**: It creates a temporary session directory and file → builds a direct update patch for a relative path → calls `maybe_parse_apply_patch_verified` with that directory as cwd → checks that the resulting action points to the correct absolute file and contains the expected diff.

**Call relations**: This tests the path resolution behavior inside `verify_apply_patch_args` through the public verified parser.

*Call graph*: calls 2 internal fn (maybe_parse_apply_patch_verified, from_absolute_path); 4 external calls (assert_eq!, write, tempdir, vec!).


##### `tests::test_apply_patch_resolves_move_path_with_effective_cwd`  (lines 820–871)

```
async fn test_apply_patch_resolves_move_path_with_effective_cwd()
```

**Purpose**: Checks that rename destinations are resolved against the effective working directory, including a `cd` from the shell script.

**Data flow**: It creates a session directory with an `alt` subdirectory and source file → builds a shell heredoc patch that runs after `cd alt` and moves the file → calls `maybe_parse_apply_patch_verified` → checks that both action cwd and move destination are inside `alt`.

**Call relations**: This exercises `maybe_parse_apply_patch_verified`, heredoc workdir extraction, and the move-path logic in `verify_apply_patch_args` together.

*Call graph*: calls 2 internal fn (maybe_parse_apply_patch_verified, from_absolute_path); 8 external calls (wrap_patch, assert_eq!, format!, create_dir_all, write, panic!, tempdir, vec!).


##### `tests::test_unreadable_destinations_still_verify`  (lines 874–899)

```
async fn test_unreadable_destinations_still_verify()
```

**Purpose**: Confirms that adding over, or moving to, a destination that contains unreadable text bytes does not block verification. The verifier does not need to read destination contents for those operations.

**Data flow**: It creates a temporary directory with a binary-looking destination file and a readable source file → tries an add patch and a move patch → calls `maybe_parse_apply_patch_verified` for each → expects both to produce verified actions.

**Call relations**: This protects `verify_apply_patch_args` from doing unnecessary reads of add or move destinations.

*Call graph*: calls 2 internal fn (maybe_parse_apply_patch_verified, from_absolute_path); 4 external calls (assert!, write, tempdir, vec!).


##### `tests::test_delete_symlink_still_verifies`  (lines 903–927)

```
async fn test_delete_symlink_still_verifies()
```

**Purpose**: On Unix systems, checks that deleting a symbolic link can still be verified. A symbolic link is a filesystem entry that points to another file.

**Data flow**: It creates a target file and a symlink to it → builds a delete patch for the link → calls `maybe_parse_apply_patch_verified` → expects a verified action.

**Call relations**: This tests the delete path in `verify_apply_patch_args`, which reads the file text through the filesystem abstraction before recording the delete.

*Call graph*: calls 2 internal fn (maybe_parse_apply_patch_verified, from_absolute_path); 4 external calls (assert!, write, tempdir, vec!).


### Patch execution engines
These files perform the actual patch application work, either through the native patch engine or via git-backed unified-diff application.

### `apply-patch/src/lib.rs`

`domain_logic` · `during apply_patch execution`

This file is the “do the work” layer for applying Codex-style patches. A patch is a small text recipe that says things like “add this file,” “delete that file,” or “replace these lines with those lines.” Without this file, the system could parse patch text but would not actually change files safely or explain what happened.

The main flow is simple. `apply_patch` first asks the parser to understand the patch text. If the patch is malformed, it prints a clear error. If parsing succeeds, `apply_hunks` sends the parsed pieces, called hunks, to the filesystem worker. Each hunk is then applied one by one: added files are written, deleted files are removed, and updated files are read, edited in memory, then written back. Relative paths are resolved against the chosen working directory.

The file is careful about failures. If a later step fails after an earlier file was already changed, it returns an `ApplyPatchFailure` containing a delta: a record of changes that definitely happened. The delta can be “exact” or “inexact.” Inexact means the code cannot fully prove what changed, for example after a write error or when dealing with symlinks or unreadable content. This is like a repair log that says, “Here is what I know I changed, and here is whether I am completely sure.”

#### Function details

##### `ApplyPatchError::from`  (lines 70–75)

```
fn from(err: &std::io::Error) -> Self
```

**Purpose**: Converts a standard input/output error into this crate’s patch-specific error type. This lets the rest of the patch code speak in one shared error language.

**Data flow**: It receives a borrowed `std::io::Error`, copies its kind and message into a new error value, wraps that in `IoError`, and returns `ApplyPatchError::IoError`.

**Call relations**: When `apply_hunks` needs to turn a low-level filesystem or printing problem into a patch failure, it calls this conversion so the caller receives the same kind of error shape as other patch problems.

*Call graph*: called by 1 (apply_hunks); 4 external calls (IoError, kind, new, to_string).


##### `IoError::eq`  (lines 87–89)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Compares two wrapped input/output errors for tests and equality checks. It treats two errors as equal when their human context and displayed source message match.

**Data flow**: It reads the `context` strings and converts each underlying source error to text, then returns true if both pieces match.

**Call relations**: This supports equality for `ApplyPatchError`, which is useful when tests or callers need to compare errors without relying on hidden operating-system error internals.

*Call graph*: 1 external calls (to_string).


##### `ApplyPatchAction::is_empty`  (lines 149–151)

```
fn is_empty(&self) -> bool
```

**Purpose**: Answers whether a parsed patch action would change no files. Callers use this to avoid approving or running a patch that has nothing to do.

**Data flow**: It reads the internal map of planned file changes and returns true if that map has no entries.

**Call relations**: Safety-checking code such as `assess_patch_safety` calls this after parsing an apply_patch command, before deciding how to treat it.

*Call graph*: called by 1 (assess_patch_safety).


##### `ApplyPatchAction::changes`  (lines 154–156)

```
fn changes(&self) -> &HashMap<PathBuf, ApplyPatchFileChange>
```

**Purpose**: Exposes the planned file changes from a parsed patch action. This is used by code that needs to inspect paths, show changes, or decide whether the patch is allowed.

**Data flow**: It receives the action object, reads its internal `changes` map, and returns a shared reference to it without modifying anything.

**Call relations**: Protocol conversion, writable-path checks, and path collection call this to look inside an already parsed `ApplyPatchAction` without taking ownership of it.

*Call graph*: called by 3 (convert_apply_patch_to_protocol, is_write_patch_constrained_to_writable_paths, file_paths_for_action).


##### `ApplyPatchAction::new_add_for_test`  (lines 160–180)

```
fn new_add_for_test(path: &AbsolutePathBuf, content: String) -> Self
```

**Purpose**: Builds a small fake patch action that represents adding one file. It exists only to make tests concise.

**Data flow**: It receives an absolute path and file content, builds a patch text string around the file name, creates a one-entry change map, sets the working directory to the file’s parent, and returns an `ApplyPatchAction`.

**Call relations**: Many tests call this helper when they need a ready-made add-file action for approval, sandbox, or protocol behavior, instead of writing full parsing setup each time.

*Call graph*: calls 2 internal fn (parent, to_path_buf); called by 14 (convert_apply_patch_maps_add_variant, explicit_read_only_subpaths_prevent_auto_approval_for_external_sandbox, explicit_unreadable_paths_prevent_auto_approval_for_external_sandbox, external_sandbox_auto_approves_in_on_request, granular_sandbox_approval_false_rejects_out_of_root_patch, granular_with_all_flags_true_matches_on_request_for_out_of_root_patch, missing_project_dot_codex_config_requires_approval, read_only_policy_rejects_patch_with_read_only_reason, approval_keys_include_environment_id, file_system_sandbox_context_uses_active_attempt (+4 more)); 3 external calls (from, format!, file_name).


##### `AppliedPatchDelta::new`  (lines 191–193)

```
fn new(changes: Vec<AppliedPatchChange>, exact: bool) -> Self
```

**Purpose**: Creates a record of file changes that were actually committed, along with whether that record is complete and reliable.

**Data flow**: It receives a list of committed changes and a boolean named `exact`, stores both, and returns a new `AppliedPatchDelta`.

**Call relations**: Other constructors and tests use this as the basic way to assemble a delta, especially when they need to state whether the delta is exact.


##### `AppliedPatchDelta::empty`  (lines 195–197)

```
fn empty() -> Self
```

**Purpose**: Creates a delta that says no file changes have happened yet. It starts as exact because there is nothing uncertain to report.

**Data flow**: It creates an empty list of changes, marks it exact, and returns that as an `AppliedPatchDelta`.

**Call relations**: `apply_hunks` uses this at the start of patch application, and `ApplyPatchFailure::without_delta` uses it when an error happened before any file mutation.

*Call graph*: called by 2 (without_delta, apply_hunks); 2 external calls (new, new).


##### `AppliedPatchDelta::changes`  (lines 199–201)

```
fn changes(&self) -> &[AppliedPatchChange]
```

**Purpose**: Returns the list of committed file changes stored in a delta. This lets callers inspect what actually happened.

**Data flow**: It reads the internal change list and returns it as a shared slice, without changing the delta.

**Call relations**: Tracking code such as `track_delta` uses this after patch application to update higher-level state from the known file mutations.

*Call graph*: called by 1 (track_delta).


##### `AppliedPatchDelta::is_empty`  (lines 203–205)

```
fn is_empty(&self) -> bool
```

**Purpose**: Answers whether the delta contains no committed file changes. This helps callers skip work when nothing happened.

**Data flow**: It checks the internal change list and returns true if it has no entries.

**Call relations**: State-tracking code such as `tracker_update_for_known_delta` calls this before deciding whether there is any patch result to record.

*Call graph*: called by 1 (tracker_update_for_known_delta).


##### `AppliedPatchDelta::is_exact`  (lines 207–209)

```
fn is_exact(&self) -> bool
```

**Purpose**: Answers whether the delta is a complete and trustworthy description of what changed. A false result means something may have happened that the code cannot prove.

**Data flow**: It reads the `exact` flag and returns it.

**Call relations**: Patch-tracking code calls this when deciding whether it can confidently use the delta, or whether it must treat the result more cautiously.

*Call graph*: called by 2 (tracker_update_for_known_delta, track_delta).


##### `AppliedPatchDelta::append`  (lines 212–215)

```
fn append(&mut self, other: Self)
```

**Purpose**: Adds another later delta onto this one. It preserves the order of changes and keeps the combined record exact only if both parts were exact.

**Data flow**: It receives another delta, appends that delta’s changes to this delta’s list, combines the exactness flags with logical “and,” and updates this delta in place.

**Call relations**: A higher-level `run` flow calls this when patch work is committed in pieces and the caller needs one combined record at the end.

*Call graph*: called by 1 (run).


##### `AppliedPatchDelta::default`  (lines 219–221)

```
fn default() -> Self
```

**Purpose**: Provides the normal default value for a delta: no changes, exactly known.

**Data flow**: It creates and returns the same value as `AppliedPatchDelta::empty`.

**Call relations**: Rust code that asks for a default delta automatically gets the same starting state used by the patch application flow.

*Call graph*: 1 external calls (empty).


##### `ApplyPatchFailure::new`  (lines 259–261)

```
fn new(error: ApplyPatchError, delta: AppliedPatchDelta) -> Self
```

**Purpose**: Creates a patch failure that includes both the error and any file changes that definitely happened before the error was seen.

**Data flow**: It receives an `ApplyPatchError` and an `AppliedPatchDelta`, stores both together, and returns an `ApplyPatchFailure`.

**Call relations**: `apply_hunks` uses this when printing or filesystem work fails, so callers do not lose track of already committed changes.

*Call graph*: called by 1 (apply_hunks).


##### `ApplyPatchFailure::without_delta`  (lines 263–265)

```
fn without_delta(error: ApplyPatchError) -> Self
```

**Purpose**: Creates a patch failure for problems that happened before any file changes were made. This is common for parse errors.

**Data flow**: It receives an error, creates an empty exact delta, combines them, and returns an `ApplyPatchFailure`.

**Call relations**: `apply_patch` calls this when the patch text cannot be parsed or when reporting the parse error itself fails.

*Call graph*: calls 1 internal fn (empty); called by 1 (apply_patch); 1 external calls (new).


##### `ApplyPatchFailure::delta`  (lines 267–269)

```
fn delta(&self) -> &AppliedPatchDelta
```

**Purpose**: Lets callers inspect the committed-change record inside a failure. This is important because a failed patch may still have changed files.

**Data flow**: It reads the stored delta and returns a shared reference to it.

**Call relations**: Tests and recovery code use this after an error to see whether anything was written, deleted, or left uncertain.


##### `ApplyPatchFailure::into_parts`  (lines 271–273)

```
fn into_parts(self) -> (ApplyPatchError, AppliedPatchDelta)
```

**Purpose**: Splits a failure into its two useful pieces: the error and the committed-change delta. This is useful when the caller wants to handle each separately.

**Data flow**: It takes ownership of the failure, extracts its stored error and delta, and returns them as a pair.

**Call relations**: This is the ownership-taking counterpart to `delta`; callers can use it when they are done with the failure wrapper and need the raw pieces.


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

**Purpose**: Applies a raw patch string to the filesystem and writes user-facing success or error messages. This is the main public entry point for doing patch work.

**Data flow**: It receives patch text, a working directory, output streams, a filesystem interface, and an optional sandbox. It parses the patch into hunks; on parse failure it writes a clear message to stderr and returns a failure. On success it passes the hunks to `apply_hunks` and returns the resulting delta.

**Call relations**: Tests call this directly, and production code can use it as the high-level operation. It hands parsing to `parse_patch` and hands actual file mutation to `apply_hunks`.

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

**Purpose**: Applies already parsed patch hunks and prints the final summary or error. It is the bridge between parsed patch data and filesystem changes.

**Data flow**: It starts an empty delta, calls `apply_hunks_to_files` to mutate files, then prints a summary to stdout if successful. If anything fails, it writes the error text to stderr, wraps the error with the delta collected so far, and returns a failure.

**Call relations**: `apply_patch` calls this after parsing. It delegates the actual add, delete, update, and move work to `apply_hunks_to_files`, then uses `print_summary` for the human-readable report.

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

**Purpose**: Performs the actual file operations described by parsed hunks. This is where files are created, deleted, edited, or moved.

**Data flow**: It receives hunks, a working directory, a filesystem, optional sandbox information, and a mutable delta. For each hunk it resolves the path, reads old content when needed, writes new content, removes deleted or moved files, records committed changes in the delta, and returns lists of added, modified, and deleted paths.

**Call relations**: `apply_hunks` calls this as the core worker. It relies on helpers such as `derive_new_contents_from_chunks`, `ensure_not_directory`, `read_optional_file_text_for_delta`, and `remove_failure_was_side_effect_free` to keep the operation accurate and safe.

*Call graph*: calls 8 internal fn (derive_new_contents_from_chunks, ensure_not_directory, note_existing_path_delta_support, read_optional_file_text_for_delta, remove_failure_was_side_effect_free, read_file_text, resolve_path_against_base, from_abs_path); called by 1 (apply_hunks); 5 external calls (new, bail!, is_empty, remove, try_write!).


##### `ensure_not_directory`  (lines 554–568)

```
async fn ensure_not_directory(
    path: &AbsolutePathBuf,
    fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>,
) -> io::Result<()>
```

**Purpose**: Checks that a path is not a directory before code tries to delete it as a file. This prevents a file patch from accidentally removing directories.

**Data flow**: It receives an absolute path, asks the filesystem for metadata, and returns success if the path is not a directory. If it is a directory, it returns an input error.

**Call relations**: `apply_hunks_to_files` calls this before deleting a file or removing the original file during a move.

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

**Purpose**: Checks whether a failed remove operation appears to have left the file untouched. This helps decide whether the delta is still exact.

**Data flow**: It receives a path and the content that was expected to be there. If expected content is available, it rereads the file and returns true only if the content still matches. If there is no expected content, it returns false.

**Call relations**: `apply_hunks_to_files` uses this after a delete or move-remove failure. If the file no longer matches what was expected, the accumulated delta becomes uncertain.

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

**Purpose**: Reads an existing file’s text when possible so the delta can record what was overwritten. Missing files are allowed.

**Data flow**: It receives a path, filesystem, sandbox, and a mutable exactness flag. It first checks whether the path type can be tracked exactly, then tries to read text. It returns the text, returns `None` for not found, and marks the delta inexact for other read problems.

**Call relations**: `apply_hunks_to_files` calls this before adding a file or writing a move destination, so the delta can say whether previous content was overwritten.

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

**Purpose**: Checks whether a path is a normal file that the delta system can describe exactly. Non-files, symlinks, and metadata errors make the delta less certain.

**Data flow**: It receives a path, filesystem, sandbox, and exactness flag. It reads metadata; normal non-symlink files and missing paths keep the flag unchanged, while unusual paths or metadata errors set exactness to false.

**Call relations**: `apply_hunks_to_files` calls this before delete and update operations, and `read_optional_file_text_for_delta` calls it before reading possible overwritten content.

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

**Purpose**: Writes a file, and if the parent directories are missing, creates them and tries again. This makes add-file and move-destination patches work even for new folders.

**Data flow**: It receives a filesystem, absolute path, bytes to write, and optional sandbox. It first tries to write. If the path is missing because parent folders do not exist, it creates those folders recursively and retries the write. It returns success or a contextual error.

**Call relations**: `apply_hunks_to_files` uses this when adding a new file or writing the destination of a moved update.

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

**Purpose**: Calculates what an updated file should look like after applying its patch chunks. It edits text in memory before anything is written back.

**Data flow**: It receives the file path, update chunks, filesystem, and sandbox. It reads the original file text, splits it into lines, computes the needed replacements, applies them, restores a trailing newline if needed, and returns both original and new content.

**Call relations**: `apply_hunks_to_files` calls this before writing an update, and diff-generation code calls it before showing what the update would change.

*Call graph*: calls 5 internal fn (apply_replacements, compute_replacements, read_file_text, as_path, from_abs_path); called by 2 (apply_hunks_to_files, unified_diff_from_chunks_with_context); 1 external calls (new).


##### `compute_replacements`  (lines 700–788)

```
fn compute_replacements(
    original_lines: &[String],
    path: &Path,
    chunks: &[UpdateFileChunk],
) -> std::result::Result<Vec<(usize, usize, Vec<String>)>, ApplyPatchError>
```

**Purpose**: Finds the exact line ranges in a file that each patch chunk should replace. It turns patch instructions into concrete edit positions.

**Data flow**: It receives original lines, the file path for error messages, and update chunks. It searches forward through the file for context and old lines, builds replacement records of start position, old length, and new lines, sorts them, and returns them. If expected text cannot be found, it returns a clear patch error.

**Call relations**: `derive_new_contents_from_chunks` calls this before `apply_replacements`. It uses `seek_sequence` to locate matching text, including special handling for end-of-file newline cases.

*Call graph*: calls 1 internal fn (seek_sequence); called by 1 (derive_new_contents_from_chunks); 4 external calls (new, ComputeReplacements, format!, from_ref).


##### `apply_replacements`  (lines 792–816)

```
fn apply_replacements(
    mut lines: Vec<String>,
    replacements: &[(usize, usize, Vec<String>)],
) -> Vec<String>
```

**Purpose**: Applies prepared line replacements to a list of file lines. It is the final in-memory edit step.

**Data flow**: It receives the original lines and replacement records. It walks replacements from the end of the file toward the start, removes the old lines, inserts the new lines, and returns the edited line list.

**Call relations**: `derive_new_contents_from_chunks` calls this after `compute_replacements` has located all edit positions. Applying edits backward prevents earlier edits from shifting later positions.

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

**Purpose**: Builds a standard unified diff for an update patch using a default amount of surrounding context. A unified diff is the familiar `-old` and `+new` text format used by many tools.

**Data flow**: It receives a path, update chunks, filesystem, and sandbox, then calls the context-aware version with a context radius of one line and returns the resulting file update description.

**Call relations**: Tests call this to verify diff output. It is a convenience wrapper around `unified_diff_from_chunks_with_context`.

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

**Purpose**: Builds a standard unified diff for an update patch, with the caller choosing how many unchanged surrounding lines to include.

**Data flow**: It receives a path, chunks, context size, filesystem, and sandbox. It computes original and new contents with `derive_new_contents_from_chunks`, asks the diff library to compare them line by line, and returns the diff plus both full contents.

**Call relations**: `unified_diff_from_chunks` calls this with the default context. It shares the same update calculation as actual patch application, so previews match what would be written.

*Call graph*: calls 1 internal fn (derive_new_contents_from_chunks); called by 1 (unified_diff_from_chunks); 1 external calls (from_lines).


##### `print_summary`  (lines 857–872)

```
fn print_summary(
    affected: &AffectedPaths,
    out: &mut impl std::io::Write,
) -> std::io::Result<()>
```

**Purpose**: Writes the success message that lists which files were added, modified, and deleted. It uses a short git-like format: `A`, `M`, and `D`.

**Data flow**: It receives grouped affected paths and an output writer. It writes a success header, then one line per added, modified, and deleted path, and returns any write error.

**Call relations**: `apply_hunks` calls this only after file application succeeds, so users get a compact report of completed work.

*Call graph*: called by 1 (apply_hunks); 1 external calls (writeln!).


##### `tests::wrap_patch`  (lines 885–887)

```
fn wrap_patch(body: &str) -> String
```

**Purpose**: Creates a complete patch text around a test body. It saves each test from repeating the begin and end markers.

**Data flow**: It receives the middle body of a patch, adds `*** Begin Patch` before it and `*** End Patch` after it, and returns the full string.

**Call relations**: Most tests call this helper before passing patch text to `apply_patch` or `parse_patch`.

*Call graph*: 1 external calls (format!).


##### `tests::test_add_file_hunk_creates_file_with_contents`  (lines 890–922)

```
async fn test_add_file_hunk_creates_file_with_contents()
```

**Purpose**: Checks that an add-file patch creates the file, writes the expected contents, and prints the right success message.

**Data flow**: It creates a temporary directory, builds an add-file patch, runs `apply_patch`, reads stdout, stderr, and the new file, then asserts that all match expectations.

**Call relations**: This test exercises the public `apply_patch` path and, through it, the add-file branch inside `apply_hunks_to_files`.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 7 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, tempdir).


##### `tests::test_apply_patch_hunks_accept_relative_and_absolute_paths`  (lines 925–994)

```
async fn test_apply_patch_hunks_accept_relative_and_absolute_paths()
```

**Purpose**: Checks that patches can mix relative and absolute paths for add, delete, and update operations.

**Data flow**: It creates several files, builds one patch containing relative and absolute path operations, applies it, then verifies new files, removed files, updated contents, and the printed summary.

**Call relations**: This test drives `apply_patch` through all main hunk types and confirms that path resolution against the working directory works correctly.

*Call graph*: calls 1 internal fn (apply_patch); 7 external calls (new, wrap_patch, assert!, assert_eq!, format!, write, tempdir).


##### `tests::test_delete_file_hunk_removes_file`  (lines 997–1023)

```
async fn test_delete_file_hunk_removes_file()
```

**Purpose**: Checks that a delete-file patch removes an existing file and reports it as deleted.

**Data flow**: It creates a file, builds a delete patch, applies it, then checks stdout, stderr, and that the file no longer exists.

**Call relations**: This test exercises `apply_patch`, especially the delete branch of `apply_hunks_to_files` and the summary printing for deleted files.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert!, assert_eq!, format!, write, tempdir).


##### `tests::test_update_file_hunk_modifies_content`  (lines 1026–1061)

```
async fn test_update_file_hunk_modifies_content()
```

**Purpose**: Checks that an update patch replaces matching lines in an existing file.

**Data flow**: It writes an original file, builds a patch replacing one line, applies it, and verifies the final file content and printed output.

**Call relations**: This test drives `apply_patch` through `derive_new_contents_from_chunks`, `compute_replacements`, and `apply_replacements`.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_update_file_hunk_can_move_file`  (lines 1064–1102)

```
async fn test_update_file_hunk_can_move_file()
```

**Purpose**: Checks that an update patch can also move the file to a new path while changing its contents.

**Data flow**: It creates a source file, builds an update-with-move patch, applies it, then confirms the source is gone, the destination exists, and the summary reports the moved file as modified.

**Call relations**: This test exercises the move branch inside `apply_hunks_to_files`, including writing the destination and removing the original.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 9 external calls (from_utf8, new, wrap_patch, assert!, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_failed_move_returns_committed_destination_delta`  (lines 1106–1157)

```
async fn test_failed_move_returns_committed_destination_delta()
```

**Purpose**: Checks that if a move fails after writing the destination, the failure still reports that committed destination write.

**Data flow**: On Unix, it makes the source directory read-only, applies a move patch that can write the destination but cannot remove the source, then inspects the failure delta and filesystem state.

**Call relations**: This test verifies the partial-failure story in `apply_patch`, especially `ApplyPatchFailure::delta` and the move error path in `apply_hunks_to_files`.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 9 external calls (new, wrap_patch, assert!, assert_eq!, from_mode, create_dir, set_permissions, write, tempdir).


##### `tests::test_multiple_update_chunks_apply_to_single_file`  (lines 1162–1204)

```
async fn test_multiple_update_chunks_apply_to_single_file()
```

**Purpose**: Checks that one file can be updated by multiple separate chunks and still be listed once in the summary.

**Data flow**: It writes a four-line file, builds a patch with two change chunks, applies it, then checks the final content and output.

**Call relations**: This test exercises repeated replacement calculation in `compute_replacements` through the public `apply_patch` call.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_update_file_hunk_interleaved_changes`  (lines 1211–1265)

```
async fn test_update_file_hunk_interleaved_changes()
```

**Purpose**: Checks a more complex update with replacements and an end-of-file addition spread across the file.

**Data flow**: It creates a six-line file, applies a patch that changes two lines and appends one line, then verifies the final file and summary.

**Call relations**: This test stresses `compute_replacements` and `apply_replacements` with non-adjacent edits and end-of-file handling.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_pure_addition_chunk_followed_by_removal`  (lines 1268–1301)

```
async fn test_pure_addition_chunk_followed_by_removal()
```

**Purpose**: Checks that a pure insertion chunk can be combined with a later removal/replacement chunk without corrupting line positions.

**Data flow**: It writes a three-line file, applies a patch that inserts lines and replaces later content, then reads the file and checks the final order.

**Call relations**: This test protects the interaction between `compute_replacements` and backward application in `apply_replacements`.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 7 external calls (new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_update_line_with_unicode_dash`  (lines 1310–1355)

```
async fn test_update_line_with_unicode_dash()
```

**Purpose**: Checks that matching can handle common Unicode dash characters when the patch uses plain ASCII dashes. This prevents visually similar punctuation from making a patch fail.

**Data flow**: It writes a line containing Unicode dash punctuation, applies a patch whose old line uses ordinary hyphens, then verifies that the line was replaced and no error was printed.

**Call relations**: This test reaches `seek_sequence` through `compute_replacements`, confirming that fuzzy text matching works during `apply_patch`.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 8 external calls (from_utf8, new, wrap_patch, assert_eq!, format!, read_to_string, write, tempdir).


##### `tests::test_unified_diff`  (lines 1358–1404)

```
async fn test_unified_diff()
```

**Purpose**: Checks that diff preview output is correct for a file with two separate line replacements.

**Data flow**: It writes a file, parses a patch, extracts update chunks, calls `unified_diff_from_chunks`, and compares the returned diff, original content, and new content to expected values.

**Call relations**: This test covers the diff-preview path, which shares update calculation with real patch application but does not write the file.

*Call graph*: calls 2 internal fn (parse_patch, unified_diff_from_chunks); 6 external calls (wrap_patch, assert_eq!, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_first_line_replacement`  (lines 1407–1445)

```
async fn test_unified_diff_first_line_replacement()
```

**Purpose**: Checks that diff preview output is correct when the first line of a file is replaced.

**Data flow**: It writes a file, parses a patch that changes the first line, calls `unified_diff_from_chunks`, and checks the compact diff result.

**Call relations**: This test guards boundary behavior in `compute_replacements` and diff generation near the start of a file.

*Call graph*: calls 2 internal fn (parse_patch, unified_diff_from_chunks); 6 external calls (wrap_patch, assert_eq!, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_last_line_replacement`  (lines 1448–1487)

```
async fn test_unified_diff_last_line_replacement()
```

**Purpose**: Checks that diff preview output is correct when the last line of a file is replaced.

**Data flow**: It writes a file, parses a patch that changes the final line, calls `unified_diff_from_chunks`, and compares the returned update description to the expected one.

**Call relations**: This test guards end-of-file matching in `compute_replacements` and the unified diff rendering.

*Call graph*: calls 2 internal fn (parse_patch, unified_diff_from_chunks); 6 external calls (wrap_patch, assert_eq!, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_insert_at_eof`  (lines 1490–1526)

```
async fn test_unified_diff_insert_at_eof()
```

**Purpose**: Checks that diff preview output is correct when a patch inserts a line at the end of a file.

**Data flow**: It writes a file, parses an end-of-file insertion patch, calls `unified_diff_from_chunks`, and checks the returned diff and final content.

**Call relations**: This test exercises the pure-addition and end-of-file paths in `compute_replacements` through the diff-preview function.

*Call graph*: calls 2 internal fn (parse_patch, unified_diff_from_chunks); 6 external calls (wrap_patch, assert_eq!, format!, write, panic!, tempdir).


##### `tests::test_unified_diff_interleaved_changes`  (lines 1529–1612)

```
async fn test_unified_diff_interleaved_changes()
```

**Purpose**: Checks that a complex patch produces the right unified diff and also applies correctly to disk.

**Data flow**: It writes a file, parses a patch with interleaved edits, verifies `unified_diff_from_chunks`, then runs `apply_patch` and checks the actual file content.

**Call relations**: This test ties together preview and execution, confirming that `unified_diff_from_chunks` and `apply_patch` agree because both use `derive_new_contents_from_chunks`.

*Call graph*: calls 4 internal fn (apply_patch, parse_patch, unified_diff_from_chunks, from_absolute_path); 8 external calls (new, wrap_patch, assert_eq!, format!, read_to_string, write, panic!, tempdir).


##### `tests::test_apply_patch_fails_on_write_error`  (lines 1616–1642)

```
async fn test_apply_patch_fails_on_write_error()
```

**Purpose**: Checks that write failures produce an inexact delta. This matters because a failed write may still have partially changed a file.

**Data flow**: On Unix, it makes a directory unwritable, tries to add a file there, expects `apply_patch` to fail, restores permissions, and asserts that the failure delta is not exact.

**Call relations**: This test covers the write-error path in `apply_hunks_to_files`, including the code that marks the delta uncertain.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 7 external calls (new, wrap_patch, assert!, from_mode, create_dir, set_permissions, tempdir).


##### `tests::test_unreadable_destinations_return_inexact_delta`  (lines 1645–1671)

```
async fn test_unreadable_destinations_return_inexact_delta()
```

**Purpose**: Checks that overwriting unreadable or non-text destination content makes the delta inexact. The code cannot accurately record overwritten text it cannot read.

**Data flow**: It creates binary destination content, applies patches that overwrite it by add or move, and asserts that each successful delta is marked not exact.

**Call relations**: This test exercises `read_optional_file_text_for_delta` and its exactness behavior through `apply_patch`.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 5 external calls (new, wrap_patch, assert!, write, tempdir).


##### `tests::test_delete_symlink_returns_inexact_delta`  (lines 1675–1697)

```
async fn test_delete_symlink_returns_inexact_delta()
```

**Purpose**: Checks that deleting a symlink is reported with an inexact delta. Symlinks are special filesystem entries, not ordinary file contents.

**Data flow**: On Unix, it creates a target file and a symlink, applies a delete patch to the symlink, and asserts that the returned delta is not exact.

**Call relations**: This test reaches `note_existing_path_delta_support` through the delete branch of `apply_hunks_to_files`.

*Call graph*: calls 2 internal fn (apply_patch, from_absolute_path); 5 external calls (new, wrap_patch, assert!, write, tempdir).


### `git-utils/src/apply.rs`

`io_transport` · `patch application / request handling`

A unified diff is a patch format that says, line by line, how files should change. This file is the bridge between that patch text and a real Git working tree. Without it, callers would have to write patch files themselves, run `git apply` correctly, and guess from raw terminal output what happened.

The main flow starts with `apply_git_patch`. It first finds the repository root, writes the patch text to a temporary file, then builds a `git apply` command. It can run in preflight mode, which is like asking “would this work?” using `git apply --check`, without touching files. It can also reverse a patch, and for real reversions it first stages existing paths as a best-effort way to avoid Git index mismatches.

After Git runs, the file does not just return raw text. It scans both standard output and standard error for known Git messages, using regular expressions, and groups paths into applied, skipped, and conflicted. Think of it like reading a mechanic’s handwritten notes and turning them into three neat checklists.

The file also contains tests that create temporary Git repositories and verify common cases: adding files, conflicts, missing files, reversing patches, dry runs, and quoted path names.

#### Function details

##### `apply_git_patch`  (lines 41–124)

```
fn apply_git_patch(req: &ApplyGitRequest) -> io::Result<ApplyGitResult>
```

**Purpose**: Applies, checks, or reverses a patch in a Git repository. This is the main entry point callers use when they have diff text and want Git to try it safely and report what happened.

**Data flow**: It receives an `ApplyGitRequest` containing a working directory, diff text, and flags for reverse or preflight mode. It finds the Git root, writes the diff to a temporary patch file, optionally stages paths for a real reverse operation, runs the right `git apply` command, parses Git’s output into path lists, and returns an `ApplyGitResult` with the exit code, output text, command string, and categorized paths.

**Call relations**: The tests call this function to exercise real Git behavior. Inside, it coordinates the helper functions: `resolve_git_root` finds where to run Git, `write_temp_patch` creates the patch file, `stage_paths` prepares reverse application when needed, `render_command_for_log` records a readable command, `run_git` executes Git, and `parse_git_apply_output` turns Git’s messages into structured results.

*Call graph*: calls 6 internal fn (parse_git_apply_output, render_command_for_log, resolve_git_root, run_git, stage_paths, write_temp_patch); called by 6 (apply_add_success, apply_modify_conflict, apply_modify_skipped_missing_index, apply_then_revert_success, preflight_blocks_partial_changes, revert_preflight_does_not_stage_index); 3 external calls (new, var, vec!).


##### `resolve_git_root`  (lines 126–142)

```
fn resolve_git_root(cwd: &Path) -> io::Result<PathBuf>
```

**Purpose**: Finds the top-level folder of the Git repository for a given starting directory. This matters because patch paths are normally relative to the repository root, not whatever subfolder the caller happened to be in.

**Data flow**: It receives a path, runs `git rev-parse --show-toplevel` there, and reads Git’s output. If Git succeeds, it returns the repository root path; if not, it returns an input/output error explaining that the directory is not inside a Git repository.

**Call relations**: It is called at the start of `apply_git_patch` so every later Git command runs from a stable, correct location.

*Call graph*: called by 1 (apply_git_patch); 5 external calls (from, from_utf8_lossy, new, other, format!).


##### `write_temp_patch`  (lines 144–149)

```
fn write_temp_patch(diff: &str) -> io::Result<(tempfile::TempDir, PathBuf)>
```

**Purpose**: Writes the patch text into a temporary file so the `git apply` command can read it. Git expects a file path here, so this function turns an in-memory string into something Git can consume.

**Data flow**: It receives diff text, creates a temporary directory, writes the text to `patch.diff` inside that directory, and returns both the directory guard and the patch path. Keeping the directory object alive keeps the file from being deleted too early.

**Call relations**: It is called by `apply_git_patch` before Git is run. The returned path is then included in the command arguments passed to `run_git`.

*Call graph*: called by 1 (apply_git_patch); 2 external calls (write, tempdir).


##### `run_git`  (lines 151–164)

```
fn run_git(cwd: &Path, git_cfg: &[String], args: &[String]) -> io::Result<(i32, String, String)>
```

**Purpose**: Runs the `git` program with chosen configuration flags and arguments. It is the small wrapper that actually crosses from this Rust code into the external Git command-line tool.

**Data flow**: It receives a working directory, optional Git configuration arguments, and normal Git arguments. It starts the Git process, waits for it to finish, converts its output from bytes into strings, and returns the exit code, standard output, and standard error.

**Call relations**: It is called by `apply_git_patch` for both dry-run checks and real patch application. Its raw text output is later handed to `parse_git_apply_output`.

*Call graph*: called by 1 (apply_git_patch); 2 external calls (from_utf8_lossy, new).


##### `quote_shell`  (lines 166–175)

```
fn quote_shell(s: &str) -> String
```

**Purpose**: Formats one command part safely for a human-readable shell command string. It is for logs, not for actually running the command.

**Data flow**: It receives a string. If the string contains only simple shell-safe characters, it returns it unchanged; otherwise it wraps it in single quotes and escapes embedded single quotes.

**Call relations**: It is called by `render_command_for_log`, which uses it on the directory, Git configuration pieces, and Git arguments before building the log string.

*Call graph*: called by 1 (render_command_for_log); 1 external calls (format!).


##### `render_command_for_log`  (lines 177–191)

```
fn render_command_for_log(cwd: &Path, git_cfg: &[String], args: &[String]) -> String
```

**Purpose**: Builds a readable version of the Git command that was or will be run. This helps users and logs show exactly what was attempted.

**Data flow**: It receives the repository directory, Git configuration arguments, and command arguments. It quotes each piece for display, joins them into a `git ...` command, wraps it in a `(cd ... && ...)` form, and returns that string.

**Call relations**: It is called by `apply_git_patch` before running either the preflight or real command. It relies on `quote_shell` so paths with spaces or special characters are shown safely.

*Call graph*: calls 1 internal fn (quote_shell); called by 1 (apply_git_patch); 2 external calls (new, format!).


##### `extract_paths_from_patch`  (lines 194–212)

```
fn extract_paths_from_patch(diff_text: &str) -> Vec<String>
```

**Purpose**: Reads a patch and collects the file paths mentioned in its `diff --git` headers. This is useful when the code needs to know which files a patch concerns before actually applying it.

**Data flow**: It receives patch text, scans each line for `diff --git`, parses the two paths from that header, removes Git’s `a/` and `b/` prefixes, ignores `/dev/null`, deduplicates the results, and returns a sorted list of paths.

**Call relations**: It is used by `stage_paths` to decide which files may need staging before a reverse apply. Several tests call it directly to confirm quoted paths, `/dev/null`, and escaped characters are interpreted correctly.

*Call graph*: calls 2 internal fn (normalize_diff_path, parse_diff_git_paths); called by 4 (stage_paths, extract_paths_handles_quoted_headers, extract_paths_ignores_dev_null_header, extract_paths_unescapes_c_style_in_quoted_headers); 1 external calls (new).


##### `parse_diff_git_paths`  (lines 214–219)

```
fn parse_diff_git_paths(line: &str) -> Option<(String, String)>
```

**Purpose**: Splits the path portion of a `diff --git` line into the old path and new path. It understands that paths may be quoted, so a space inside a filename is not mistaken for a separator.

**Data flow**: It receives the text after `diff --git`, reads one path token, then reads a second path token. If both are present, it returns them as a pair; otherwise it returns nothing.

**Call relations**: It is called by `extract_paths_from_patch` whenever that function finds a `diff --git` header. It delegates the careful token reading to `read_diff_git_token`.

*Call graph*: calls 1 internal fn (read_diff_git_token); called by 1 (extract_paths_from_patch).


##### `read_diff_git_token`  (lines 221–255)

```
fn read_diff_git_token(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> Option<String>
```

**Purpose**: Reads one file path token from a Git diff header. It handles plain paths and quoted paths, including escaped characters inside quotes.

**Data flow**: It receives a character iterator positioned near a path. It skips leading whitespace, detects whether the path is quoted, gathers characters until the token ends, unescapes quoted text when needed, and returns the path string if one was found.

**Call relations**: It is called twice by `parse_diff_git_paths`: once for the old path and once for the new path. When it sees quoted text, it hands the contents to `unescape_c_string`.

*Call graph*: calls 1 internal fn (unescape_c_string); called by 1 (parse_diff_git_paths); 4 external calls (next, peek, new, matches!).


##### `normalize_diff_path`  (lines 257–270)

```
fn normalize_diff_path(raw: &str, prefix: &str) -> Option<String>
```

**Purpose**: Cleans up a raw path from a diff header so it becomes a normal repository-relative path. It also filters out Git’s special `/dev/null` marker, which means a file is being created or deleted rather than referring to a real path.

**Data flow**: It receives a raw path and an expected prefix such as `a/` or `b/`. It trims whitespace, rejects empty values and `/dev/null`, removes the prefix if present, and returns the cleaned path if anything remains.

**Call relations**: It is called by `extract_paths_from_patch` after `parse_diff_git_paths` has separated the two header paths.

*Call graph*: called by 1 (extract_paths_from_patch); 1 external calls (format!).


##### `unescape_c_string`  (lines 272–317)

```
fn unescape_c_string(input: &str) -> String
```

**Purpose**: Turns backslash escape sequences into their real characters. This is needed because Git may print paths in a C-style quoted form, such as `hello\tworld.txt` for a filename containing a tab.

**Data flow**: It receives a string that may contain backslash escapes. It walks character by character, translating known escapes like newline, tab, quotes, backslash, and octal byte values, then returns the decoded string.

**Call relations**: It is used by `read_diff_git_token` for quoted diff headers. The output parser also uses the same behavior inside its local path-cleaning helper when Git reports quoted paths.

*Call graph*: called by 1 (read_diff_git_token); 2 external calls (with_capacity, from_u32).


##### `stage_paths`  (lines 320–342)

```
fn stage_paths(git_root: &Path, diff: &str) -> io::Result<()>
```

**Purpose**: Best-effort stages the existing files mentioned by a patch before a real reverse apply. This helps Git avoid index mismatch problems when undoing changes.

**Data flow**: It receives the repository root and diff text. It extracts paths from the patch, keeps only those that currently exist on disk, runs `git add --` on that list, and returns success even if Git’s staging command itself reports failure.

**Call relations**: It is called by `apply_git_patch` only for real reverse operations, not for preflight checks. It uses `extract_paths_from_patch` to know which files are relevant.

*Call graph*: calls 1 internal fn (extract_paths_from_patch); called by 1 (apply_git_patch); 5 external calls (new, join, new, new, symlink_metadata).


##### `parse_git_apply_output`  (lines 347–589)

```
fn parse_git_apply_output(
    stdout: &str,
    stderr: &str,
) -> (Vec<String>, Vec<String>, Vec<String>)
```

**Purpose**: Reads Git’s patch-application messages and turns them into three clear groups: applied files, skipped files, and conflicted files. This saves callers from having to understand many different Git error and warning phrases.

**Data flow**: It receives standard output and standard error from Git, combines them, and scans line by line. It matches known messages such as clean application, conflicts, rejected hunks, missing index entries, binary patch failures, and skipped patches, then returns three sorted path lists with conflicts taking priority over applied or skipped.

**Call relations**: It is called by `apply_git_patch` after Git finishes, and one test calls it directly to check quoted path decoding. Its regular expression patterns are built with `regex_ci` so matching ignores letter case.

*Call graph*: called by 2 (apply_git_patch, parse_output_unescapes_quoted_paths); 2 external calls (new, new).


##### `regex_ci`  (lines 591–593)

```
fn regex_ci(pat: &str) -> Regex
```

**Purpose**: Creates a case-insensitive regular expression. This keeps Git message matching flexible when capitalization differs.

**Data flow**: It receives a pattern string, adds the case-insensitive marker, compiles it, and returns the compiled regular expression. If the pattern is invalid, it panics because that would be a programmer error in a hard-coded pattern.

**Call relations**: It supports the pattern definitions used by `parse_git_apply_output`, where many Git output phrases are recognized.

*Call graph*: 2 external calls (new, format!).


##### `tests::env_lock`  (lines 602–605)

```
fn env_lock() -> &'static Mutex<()>
```

**Purpose**: Provides a shared lock for tests that touch process-wide environment or Git state. The lock makes those tests run one at a time where needed.

**Data flow**: It creates a global mutex, which is a lock that allows only one holder at a time, the first time it is requested. Later calls return the same lock.

**Call relations**: The integration-style tests call this before creating repositories and running Git commands, reducing the chance that parallel tests interfere with each other.

*Call graph*: 1 external calls (new).


##### `tests::run`  (lines 607–618)

```
fn run(cwd: &Path, args: &[&str]) -> (i32, String, String)
```

**Purpose**: Runs a command inside a test repository and captures its result. It is a test helper for invoking Git setup commands and checks.

**Data flow**: It receives a working directory and a list of command arguments. It starts the command, captures its exit code, standard output, and standard error, converts output to strings, and returns all three.

**Call relations**: Test setup and verification functions call this helper, especially `tests::init_repo`, `tests::apply_modify_conflict`, `tests::apply_then_revert_success`, and `tests::revert_preflight_does_not_stage_index`.

*Call graph*: 2 external calls (from_utf8_lossy, new).


##### `tests::init_repo`  (lines 620–628)

```
fn init_repo() -> tempfile::TempDir
```

**Purpose**: Creates a temporary Git repository for tests. This lets each test run against a fresh sandbox instead of depending on the developer’s real repository.

**Data flow**: It creates a temporary directory, runs `git init`, configures a minimal username and email for commits, and returns the temporary directory object that keeps the repository alive.

**Call relations**: Most patch-application tests call this before calling `apply_git_patch`. It uses `tests::run` to execute the Git setup commands.

*Call graph*: 2 external calls (run, tempdir).


##### `tests::read_file_normalized`  (lines 630–634)

```
fn read_file_normalized(path: &Path) -> String
```

**Purpose**: Reads a test file and normalizes Windows-style line endings to Unix-style line endings. This keeps assertions stable across operating systems.

**Data flow**: It receives a file path, reads the file into a string, replaces `\r\n` with `\n`, and returns the normalized text.

**Call relations**: The apply-and-revert tests call this after patch operations to confirm the file contents changed, or did not change, as expected.

*Call graph*: 1 external calls (read_to_string).


##### `tests::extract_paths_handles_quoted_headers`  (lines 637–641)

```
fn extract_paths_handles_quoted_headers()
```

**Purpose**: Checks that path extraction works when Git diff headers quote filenames containing spaces. This protects support for common filenames like `hello world.txt`.

**Data flow**: It builds a small diff with quoted paths, passes it to `extract_paths_from_patch`, and asserts that the returned list contains the unquoted filename once.

**Call relations**: The test runner calls this test. It exercises `extract_paths_from_patch`, which in turn relies on the lower-level diff path parsing helpers.

*Call graph*: calls 1 internal fn (extract_paths_from_patch); 1 external calls (assert_eq!).


##### `tests::extract_paths_ignores_dev_null_header`  (lines 644–648)

```
fn extract_paths_ignores_dev_null_header()
```

**Purpose**: Checks that path extraction ignores Git’s `/dev/null` marker. This matters for new or deleted files, where one side of the diff is not a real file path.

**Data flow**: It builds a diff whose old side points at `a/dev/null` and whose new side is `ok.txt`, runs `extract_paths_from_patch`, and asserts that only `ok.txt` is returned.

**Call relations**: The test runner calls this test to protect the filtering done by `normalize_diff_path` through the public path extraction function.

*Call graph*: calls 1 internal fn (extract_paths_from_patch); 1 external calls (assert_eq!).


##### `tests::extract_paths_unescapes_c_style_in_quoted_headers`  (lines 651–655)

```
fn extract_paths_unescapes_c_style_in_quoted_headers()
```

**Purpose**: Checks that escaped characters in quoted diff paths are decoded correctly. This protects filenames containing special characters such as tabs.

**Data flow**: It builds a diff with a quoted path containing `\t`, calls `extract_paths_from_patch`, and asserts that the result contains an actual tab character in the filename.

**Call relations**: The test runner calls this test. It exercises the path extraction chain, including `read_diff_git_token` and `unescape_c_string`.

*Call graph*: calls 1 internal fn (extract_paths_from_patch); 1 external calls (assert_eq!).


##### `tests::parse_output_unescapes_quoted_paths`  (lines 658–664)

```
fn parse_output_unescapes_quoted_paths()
```

**Purpose**: Checks that Git error output with quoted, escaped paths is reported as the real filename. This keeps user-facing skipped-path lists accurate.

**Data flow**: It passes a simulated Git error message to `parse_git_apply_output`. It then asserts that no paths were applied or conflicted, and that the skipped list contains the decoded path.

**Call relations**: The test runner calls this test directly against the output parser, without running Git.

*Call graph*: calls 1 internal fn (parse_git_apply_output); 1 external calls (assert_eq!).


##### `tests::apply_add_success`  (lines 667–683)

```
fn apply_add_success()
```

**Purpose**: Verifies that applying a patch which creates a new file succeeds. It covers the simplest successful patch path.

**Data flow**: It locks the test environment, creates a temporary repository, builds a new-file diff, calls `apply_git_patch`, and checks that Git returned success and the file now exists.

**Call relations**: The test runner calls this test. It uses `tests::env_lock` and `tests::init_repo`, then exercises the main `apply_git_patch` flow.

*Call graph*: calls 1 internal fn (apply_git_patch); 4 external calls (assert!, assert_eq!, env_lock, init_repo).


##### `tests::apply_modify_conflict`  (lines 686–706)

```
fn apply_modify_conflict()
```

**Purpose**: Verifies that a patch reports failure when it conflicts with local changes. This confirms the code does not pretend a conflicting edit applied cleanly.

**Data flow**: It creates a repository, commits a seed file, changes that file locally, then tries to apply a patch that changes the same line differently. It calls `apply_git_patch` and asserts that Git returns a non-zero exit code.

**Call relations**: The test runner calls this test. It uses the repository helpers and Git command helper, then checks the main patch application function under a conflict case.

*Call graph*: calls 1 internal fn (apply_git_patch); 5 external calls (assert_ne!, env_lock, init_repo, run, write).


##### `tests::apply_modify_skipped_missing_index`  (lines 709–723)

```
fn apply_modify_skipped_missing_index()
```

**Purpose**: Verifies behavior when a patch tries to modify a file Git does not know about. This is a common failure mode for patches that do not match the repository.

**Data flow**: It creates an empty temporary repository, builds a diff that modifies `ghost.txt`, calls `apply_git_patch`, and asserts that Git returns a non-zero exit code.

**Call relations**: The test runner calls this test. It uses `tests::env_lock` and `tests::init_repo`, then exercises `apply_git_patch` on a missing-file scenario.

*Call graph*: calls 1 internal fn (apply_git_patch); 3 external calls (assert_ne!, env_lock, init_repo).


##### `tests::apply_then_revert_success`  (lines 726–759)

```
fn apply_then_revert_success()
```

**Purpose**: Verifies that a patch can be applied and then reversed successfully. This protects the special reverse-apply path, including its staging step.

**Data flow**: It creates and commits a file, applies a patch that changes its content, confirms the new content, then calls `apply_git_patch` again with reverse mode and confirms the original content is restored.

**Call relations**: The test runner calls this test. It uses Git setup helpers, `apply_git_patch` for both forward and reverse operations, and `tests::read_file_normalized` to check file contents.

*Call graph*: calls 1 internal fn (apply_git_patch); 6 external calls (assert_eq!, env_lock, init_repo, read_file_normalized, run, write).


##### `tests::revert_preflight_does_not_stage_index`  (lines 762–804)

```
fn revert_preflight_does_not_stage_index()
```

**Purpose**: Verifies that a reverse preflight check does not stage files or change the working tree. Dry runs must be safe and leave no hidden Git index changes behind.

**Data flow**: It creates a repository, applies and commits a change, records the staged-file list, runs `apply_git_patch` in reverse preflight mode, then confirms the staged-file list and file contents are unchanged.

**Call relations**: The test runner calls this test. It specifically checks the branch in `apply_git_patch` where reverse mode and preflight mode combine, ensuring `stage_paths` is not used there.

*Call graph*: calls 1 internal fn (apply_git_patch); 6 external calls (assert_eq!, env_lock, init_repo, read_file_normalized, run, write).


##### `tests::preflight_blocks_partial_changes`  (lines 807–846)

```
fn preflight_blocks_partial_changes()
```

**Purpose**: Verifies that preflight mode prevents partial changes when a multi-file patch would fail. This ensures the safety check really checks the whole patch before any file is modified.

**Data flow**: It creates a repository and builds a patch with one valid new file and one invalid modification. It first runs `apply_git_patch` in preflight mode and confirms no file was created, then runs without preflight and confirms the logged command no longer contains `--check`.

**Call relations**: The test runner calls this test. It exercises the preflight branch of `apply_git_patch` and compares it with the normal apply branch.

*Call graph*: calls 1 internal fn (apply_git_patch); 4 external calls (assert!, assert_ne!, env_lock, init_repo).
