# Exec-mode and scripted session startup  `stage-9.2`

This stage is about starting a one-shot, non-interactive Codex run. Instead of opening a long-running text interface, it prepares one session, feeds in the prompt or resume information, runs the work, and finishes. It is mainly used by scripts, automation, or commands like codex exec, where output must be predictable.

exec/src/lib.rs is the main driver for this mode. It gathers instructions from command-line flags, config files, standard input, and saved session data. It can start a new request, continue an old session, or run a review. It also arranges output so that normal results can be read safely by other programs, for example as structured JSONL, which means one JSON record per line.

tui/src/session_resume.rs supports the resume path. It works out which saved conversation to use, which folder it belonged to, and which model should continue it. If the saved folder is not the user’s current folder, it asks what to do. Together, these pieces make sure a scripted run starts with the right context and can proceed without an interactive work loop.

## Files in this stage

### Session resume resolution
Determines the saved-session metadata needed before startup so exec can resume or fork the correct thread with the right cwd and model.

### `tui/src/session_resume.rs`

`orchestration` · `session resume or fork setup`

When a user resumes a previous session, the app needs more than just the chat history. It also needs to know things like the conversation’s thread ID, which folder the session was working in, and which model was last used. Normally this information comes from the app server’s state database. But before that server has fully resumed a thread, the text UI may need to recover the same details from a local rollout file, which is a line-by-line saved record of earlier session events.

This file acts like a small “lost-and-found desk” for resume data. It first asks the newer, more reliable state database. If that is unavailable or missing data, it reads the rollout file and looks for useful records. Older session metadata can provide the original thread ID and folder. Later turn-context records can override the folder and model, because they represent the most recent working state.

The most visible behavior is around the current working directory, or cwd, meaning the folder commands run from. If the saved session folder differs from the user’s current folder, this file can open a prompt in the text UI and let the user choose which folder to continue with. Without this file, resumed sessions could silently use the wrong folder, lose track of their model, or fail to reconnect a local rollout file to the right thread.

#### Function details

##### `resolve_session_thread_id`  (lines 54–65)

```
async fn resolve_session_thread_id(
    path: &Path,
    id_str_if_uuid: Option<&str>,
) -> Option<ThreadId>
```

**Purpose**: This function finds the thread ID to resume. If the caller already has a UUID-shaped ID string, it tries to turn that directly into a thread ID; otherwise it looks inside the rollout file.

**Data flow**: It receives a path to a rollout file and, optionally, an ID string. If the string is present, it parses it. If not, it reads the rollout resume state and takes the thread ID found there. It returns either a usable thread ID or nothing if no valid ID can be found.

**Call relations**: When key handling needs to resume a selected item, it calls this function to settle the identity question first. This function either uses ThreadId parsing for the direct case or hands off to read_rollout_resume_state when it must recover the ID from saved local records.

*Call graph*: calls 2 internal fn (from_string, read_rollout_resume_state); called by 1 (handle_key).


##### `read_session_model`  (lines 67–84)

```
async fn read_session_model(
    state_db_ctx: Option<&StateRuntime>,
    thread_id: ThreadId,
    path: Option<&Path>,
) -> Option<String>
```

**Purpose**: This function finds which model was associated with a saved thread. It prefers the app server’s state database and falls back to the rollout file only if needed.

**Data flow**: It receives an optional state database connection, a thread ID, and an optional rollout path. It first asks the state database for the thread metadata and returns its model if present. If that fails or has no model, it reads the rollout file and returns the model recorded in the latest relevant saved turn context. If neither source has a model, it returns nothing.

**Call relations**: Code that needs to describe or rebuild session state calls this function when it needs the model name. The function keeps those callers from having to know whether the answer came from the app server state or from the older local rollout record.

*Call graph*: calls 1 internal fn (read_rollout_resume_state); called by 2 (infer_session_for_thread_notification, session_state_for_thread_read).


##### `resolve_cwd_for_resume_or_fork`  (lines 86–112)

```
async fn resolve_cwd_for_resume_or_fork(
    tui: &mut Tui,
    state_db_ctx: Option<&StateRuntime>,
    current_cwd: &Path,
    thread_id: ThreadId,
    path: Option<&Path>,
    action: CwdPromptActi
```

**Purpose**: This function decides which folder should be used when resuming or forking a session. If the saved folder and current folder differ, it can ask the user which one they want.

**Data flow**: It receives the text UI, optional state database, the current folder, the thread ID, optional rollout path, the type of cwd action, and whether prompting is allowed. It reads the saved session folder. If there is no saved folder, it says to continue without choosing one. If prompting is allowed and the folders differ, it shows a selection prompt and returns the user’s choice or an exit signal. If no prompt is needed, it returns the saved session folder.

**Call relations**: The resume and main UI startup paths call this before continuing with an old or forked conversation. It relies on read_session_cwd to find the saved folder, cwds_differ to compare paths fairly, and run_cwd_selection_prompt to involve the user when the choice could matter.

*Call graph*: calls 3 internal fn (run_cwd_selection_prompt, cwds_differ, read_session_cwd); called by 2 (resume_target_session, run_ratatui_app); 2 external calls (to_path_buf, Continue).


##### `read_session_cwd`  (lines 114–138)

```
async fn read_session_cwd(
    state_db_ctx: Option<&StateRuntime>,
    thread_id: ThreadId,
    path: Option<&Path>,
) -> Option<PathBuf>
```

**Purpose**: This function finds the saved working folder for a thread. It checks the main state database first, then falls back to the rollout file if necessary.

**Data flow**: It receives an optional state database connection, a thread ID, and an optional rollout path. If database metadata exists, it returns the cwd from that metadata. Otherwise it reads the rollout file and returns the cwd found there. If the rollout cannot be read, it logs a warning and returns nothing.

**Call relations**: resolve_cwd_for_resume_or_fork calls this as its first step, because it cannot compare or prompt about folders until it knows the saved one. This function hides the two-source lookup from the higher-level resume flow.

*Call graph*: calls 1 internal fn (read_rollout_resume_state); called by 1 (resolve_cwd_for_resume_or_fork); 1 external calls (warn!).


##### `cwds_differ`  (lines 140–142)

```
fn cwds_differ(current_cwd: &Path, session_cwd: &Path) -> bool
```

**Purpose**: This function answers a simple question: do these two folder paths really point to different places? It compares paths after normalization, so harmless spelling differences do not count as a real difference.

**Data flow**: It receives the current folder path and the saved session folder path. It passes them through a path comparison helper that normalizes paths first, then returns true only when they do not match.

**Call relations**: The resume folder prompt uses this function to avoid bothering the user when paths only look different on the surface. Configuration rebuild logic also calls it when deciding whether the resumed session’s folder needs special treatment.

*Call graph*: called by 2 (rebuild_config_for_resume_or_fallback, resolve_cwd_for_resume_or_fork); 1 external calls (paths_match_after_normalization).


##### `read_rollout_resume_state`  (lines 144–188)

```
async fn read_rollout_resume_state(path: &Path) -> io::Result<RolloutResumeState>
```

**Purpose**: This function reads a rollout file and extracts the resume details hidden inside it: thread ID, working folder, and model. It is the fallback source used when the app server state is not available or not complete.

**Data flow**: It receives a path to a rollout file. It opens the file as a line reader, skips blank lines, ignores malformed JSON lines, and looks at recognized record types. A session metadata record can supply the thread ID and original folder. Turn-context records can update the folder and model, with later records winning because the file is read in order. It returns the collected resume state, or an input/output error if the file could not be opened or had no usable records at all.

**Call relations**: The thread ID, model, and cwd lookup functions all call this when they need to recover data from local rollout history. The tests call it directly to prove that it prefers the newest turn context, falls back to session metadata, and tolerates bad lines.

*Call graph*: called by 6 (read_session_cwd, read_session_model, resolve_session_thread_id, rollout_resume_state_falls_back_to_session_meta, rollout_resume_state_prefers_latest_turn_context, rollout_resume_state_skips_malformed_lines); 4 external calls (other, open_rollout_line_reader, format!, default).


##### `tests::rollout_line`  (lines 196–206)

```
fn rollout_line(
        timestamp: &str,
        item_type: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value
```

**Purpose**: This test helper builds one fake rollout record in the same general shape as the real saved records. It keeps the tests short and focused on behavior instead of JSON construction details.

**Data flow**: It receives a timestamp, a record type, and a payload value. It wraps them into a JSON object that looks like one line of a rollout file. The result is a JSON value ready to be serialized by the test writer helper.

**Call relations**: The rollout resume tests use this helper to create session metadata and turn-context records. It feeds test data into tests::write_rollout_lines, which then writes those records to a temporary rollout file.

*Call graph*: 1 external calls (json!).


##### `tests::write_rollout_lines`  (lines 208–215)

```
fn write_rollout_lines(path: &Path, lines: &[serde_json::Value]) -> std::io::Result<()>
```

**Purpose**: This test helper writes fake rollout records to disk as newline-separated JSON. That gives the parser a realistic file to read during tests.

**Data flow**: It receives a file path and a list of JSON values. It serializes each value to one JSON string, adds a newline after each, and writes the combined text to the path. It returns success or a file-writing error.

**Call relations**: The rollout resume tests call this after building records with tests::rollout_line. Once the file exists, the tests call read_rollout_resume_state to check how the real parser behaves.

*Call graph*: 3 external calls (new, to_string, write).


##### `tests::rollout_resume_state_prefers_latest_turn_context`  (lines 218–256)

```
async fn rollout_resume_state_prefers_latest_turn_context() -> std::io::Result<()>
```

**Purpose**: This test checks that the rollout reader uses the most recent turn-context record for folder and model. That matters because a session can move or change context after its original metadata was written.

**Data flow**: It creates a temporary rollout file containing original session metadata, then two later turn-context records. It reads the file through read_rollout_resume_state and checks that the thread ID comes from the metadata while the cwd and model come from the latest turn context.

**Call relations**: This test exercises the main fallback parser directly. It uses the helper functions to build realistic rollout lines, then confirms that read_rollout_resume_state treats later turn-context data as the current state.

*Call graph*: calls 2 internal fn (new, read_rollout_resume_state); 5 external calls (new, assert_eq!, json!, rollout_line, write_rollout_lines).


##### `tests::rollout_resume_state_falls_back_to_session_meta`  (lines 259–284)

```
async fn rollout_resume_state_falls_back_to_session_meta() -> std::io::Result<()>
```

**Purpose**: This test checks that session metadata alone is enough to recover the thread ID and folder. That protects older or simpler rollout files that do not contain later turn-context records.

**Data flow**: It creates a temporary rollout file with only one session metadata record. It reads that file through read_rollout_resume_state and verifies that the returned state contains the metadata’s thread ID and cwd, while the model remains absent.

**Call relations**: This test calls the same rollout parser used by resume code. It proves the fallback path still works when the richer, newer turn-context information is missing.

*Call graph*: calls 2 internal fn (new, read_rollout_resume_state); 5 external calls (new, assert_eq!, json!, rollout_line, write_rollout_lines).


##### `tests::rollout_resume_state_skips_malformed_lines`  (lines 287–310)

```
async fn rollout_resume_state_skips_malformed_lines() -> std::io::Result<()>
```

**Purpose**: This test checks that one bad line in a rollout file does not ruin the whole resume attempt. That is important because saved log-like files can sometimes contain partial or damaged records.

**Data flow**: It writes one valid rollout metadata line followed by malformed JSON. It then reads the file through read_rollout_resume_state and verifies that the valid data is still recovered instead of failing because of the bad trailing line.

**Call relations**: This test targets the parser’s tolerance behavior. It confirms that read_rollout_resume_state skips malformed lines and still returns useful state when at least one valid record was seen.

*Call graph*: calls 2 internal fn (new, read_rollout_resume_state); 7 external calls (new, assert_eq!, format!, json!, to_string, write, rollout_line).


### Exec runtime orchestration
Runs the non-interactive exec flow from CLI-derived setup through app-server startup, prompt construction, event-loop execution, and final output emission.

### `exec/src/lib.rs`

`entrypoint` · `startup through main execution loop and shutdown`

This file is the bridge between a user typing `codex exec ...` and the in-process Codex app server that actually runs the agent. Its first job is setup: read command-line flags, find configuration, choose the model or local OSS provider, enforce login rules, start logging and telemetry, and create the app-server client. Then it starts or resumes a thread, sends either a user prompt or a review request, and watches the server's event stream until the turn finishes.

A key rule shapes the whole file: stdout must stay clean. In normal mode, only the final answer should appear there; in JSON mode, stdout must be valid JSON lines. Warnings, setup messages, and errors go to stderr instead, so shell scripts can safely capture the answer.

The file also deals with headless-command realities. It can read prompts from stdin, including piped files with byte-order marks, reject unsupported interactive approval requests, cancel tool elicitations, respond to Ctrl-C by interrupting the turn, and backfill missing final items if the event stream dropped intermediate updates. Think of it as the conductor for a one-shot train trip: it checks tickets and route rules, starts or resumes the train, relays signals, filters messages for the right passenger, and shuts everything down cleanly at the end.

#### Function details

##### `RequestIdSequencer::new`  (lines 192–194)

```
fn new() -> Self
```

**Purpose**: Creates a fresh counter for request IDs sent to the app server. Each request needs a unique label so replies can be matched back to the request that caused them.

**Data flow**: It takes no input, starts the next ID at 1, and returns a new `RequestIdSequencer` ready to hand out IDs.

**Call relations**: At the start of an exec session, `run_exec_session` creates one sequencer and keeps using it whenever it sends requests to the in-process app server.

*Call graph*: called by 1 (run_exec_session).


##### `RequestIdSequencer::next`  (lines 196–200)

```
fn next(&mut self) -> RequestId
```

**Purpose**: Returns the next request ID and advances the counter. This is like taking the next numbered ticket from a dispenser before asking the server for something.

**Data flow**: It reads the current counter value, wraps it as an integer request ID, increments the stored counter, and returns the wrapped ID.

**Call relations**: The session loop uses this through helpers such as `maybe_backfill_turn_completed_items` and `request_shutdown` whenever another app-server request needs a fresh ID.

*Call graph*: called by 2 (maybe_backfill_turn_completed_items, request_shutdown); 1 external calls (Integer).


##### `exec_root_span`  (lines 221–228)

```
fn exec_root_span() -> tracing::Span
```

**Purpose**: Creates the top-level tracing span for a `codex exec` run. A tracing span is a named envelope for logs and timing data, useful when debugging or collecting telemetry.

**Data flow**: It takes no input and returns a span named for exec, with empty slots for the thread ID and turn ID that will be filled in later.

**Call relations**: `run_main` creates this span after configuration and telemetry setup, then runs the whole exec session inside it so later logs belong to the same operation.

*Call graph*: called by 1 (run_main); 1 external calls (info_span!).


##### `exec_stderr_env_filter`  (lines 230–236)

```
fn exec_stderr_env_filter() -> EnvFilter
```

**Purpose**: Chooses which log messages are allowed to appear on stderr. By default it keeps noisy telemetry internals quiet unless the user explicitly asks for more logging.

**Data flow**: It first tries to read logging settings from the environment. If that fails, it uses the file's conservative default filter, and if even that fails it falls back to showing errors only.

**Call relations**: `run_main` uses this when building the stderr logging layer, so diagnostic output does not corrupt stdout.

*Call graph*: called by 1 (run_main); 1 external calls (try_from_default_env).


##### `run_main`  (lines 238–580)

```
async fn run_main(cli: Cli, arg0_paths: Arg0DispatchPaths) -> anyhow::Result<()>
```

**Purpose**: Runs the whole `codex exec` command from command-line input to finished session. This is the main entry used by the executable layer.

**Data flow**: It receives parsed CLI arguments and paths to helper executables, reads config and cloud settings, resolves models and permissions, sets up auth, telemetry, logging, state storage, and the in-process app server environment, then passes a packed `ExecRunArgs` object to `run_exec_session`. It returns success or an error, and for some user-facing setup failures it prints to stderr and exits immediately.

**Call relations**: This is the top-level coordinator. It calls setup helpers such as `load_bootstrap_config_or_exit`, `build_exec_config`, `exec_root_span`, and `exec_stderr_env_filter`, then hands off the actual conversation flow to `run_exec_session`.

*Call graph*: calls 18 internal fn (default, find_codex_home, resolve_oss_provider, install_sqlite_telemetry, record_process_start, from_codex_home, from_env, from_optional_paths, build_exec_config, exec_root_span (+8 more)); 22 external calls (default, new, anyhow!, removed_full_auto_warning, cloud_config_bundle_loader_for_storage, check_execpolicy_for_warnings, resolve_bootstrap_auth_keyring_backend_kind, init_state_db, enforce_login_restrictions, set_parent_from_context (+12 more)).


##### `build_exec_config`  (lines 582–615)

```
async fn build_exec_config(
    overrides: ConfigOverrides,
    preserve_headless_approval_policy: bool,
    build_config: BuildConfig,
) -> std::io::Result<Config>
```

**Purpose**: Builds the final configuration while respecting a special exec-mode default: headless runs normally should not pause to ask for approvals. It also backs off that default when auto-review approval behavior needs to be preserved.

**Data flow**: It receives config overrides, a flag saying whether to preserve the headless approval choice, and a config-building function. It tries to build with the exec defaults, may retry without the forced approval policy, and returns the chosen config or the original error.

**Call relations**: `run_main` uses this after preparing all config inputs. It exists so approval behavior is chosen carefully before any session is started.

*Call graph*: called by 1 (run_main); 1 external calls (clone).


##### `load_bootstrap_config_or_exit`  (lines 618–655)

```
async fn load_bootstrap_config_or_exit(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_kv_overrides: Vec<(String, codex_config::TomlValue)>,
    loader_overrides: LoaderOverrides,
```

**Purpose**: Loads the early, partial configuration needed before the full config can be built. If the config is invalid, it prints a readable error and stops the process.

**Data flow**: It receives the Codex home path, current working directory, command-line config overrides, loader options, strictness, and cloud config loader. It calls the config loader, returns the loaded TOML-layer result on success, or formats the failure for stderr and exits.

**Call relations**: `run_main` calls this during startup, before it knows enough to build the complete runtime configuration.

*Call graph*: calls 1 internal fn (load_config_toml_with_layer_stack); called by 1 (run_main); 2 external calls (eprintln!, exit).


##### `run_exec_session`  (lines 657–1039)

```
async fn run_exec_session(args: ExecRunArgs) -> anyhow::Result<()>
```

**Purpose**: Runs one actual exec session: start or resume a thread, send the prompt or review request, process server events, handle interrupts, and print final output. This is the core execution loop.

**Data flow**: It receives all prepared runtime arguments. It creates the right event processor for human or JSON output, checks local OSS readiness if needed, builds the initial operation, starts the app-server client, starts or resumes a thread, sends a turn or review request, then loops over server events until completion or shutdown. It may write warnings to stderr, print final output through the event processor, shut down the client, and exit with code 1 if a fatal turn error occurred.

**Call relations**: `run_main` hands control to this after setup. Inside, it uses many small helpers for thread parameters, prompt resolution, review conversion, resume lookup, notification filtering, server-request rejection, event backfill, and shutdown.

*Call graph*: calls 20 internal fn (start, new, build_review_request, create_with_ansi, new, handle_server_request, lagged_event_warning_message, load_output_schema, maybe_backfill_turn_completed_items, request_shutdown (+10 more)); called by 1 (run_main); 18 external calls (new, TurnStarted, new, anyhow!, system_bwrap_warning, user_facing_hint, get_git_repo_root, ensure_oss_provider_ready, eprintln!, error! (+8 more)).


##### `thread_start_params_from_config`  (lines 1041–1063)

```
fn thread_start_params_from_config(config: &Config) -> ThreadStartParams
```

**Purpose**: Turns the resolved Codex config into the app-server parameters needed to start a new thread. It makes sure model, working directory, permissions, sandbox, and small config overrides travel with the request.

**Data flow**: It reads fields from `Config`, chooses either a named permission profile or an older sandbox mode, and returns a `ThreadStartParams` value filled for the app server.

**Call relations**: `run_exec_session` calls this whenever it needs a fresh thread. It relies on `permissions_selection_from_config`, `sandbox_mode_from_permission_profile`, `approvals_reviewer_override_from_config`, and `thread_config_overrides_from_config` to translate specific parts.

*Call graph*: calls 3 internal fn (approvals_reviewer_override_from_config, permissions_selection_from_config, thread_config_overrides_from_config); called by 1 (run_exec_session); 1 external calls (default).


##### `thread_resume_params_from_config`  (lines 1065–1086)

```
fn thread_resume_params_from_config(config: &Config, thread_id: String) -> ThreadResumeParams
```

**Purpose**: Builds the app-server parameters needed to resume an existing thread with the current exec settings. This lets a resumed run still inherit today's model, directory, and permission choices.

**Data flow**: It receives the current config and the thread ID to resume, reads the same policy and runtime fields used for new threads, and returns a `ThreadResumeParams` request body.

**Call relations**: `run_exec_session` calls this after `resolve_resume_thread_id` finds a thread. It shares the same translation helpers used by `thread_start_params_from_config`.

*Call graph*: calls 3 internal fn (approvals_reviewer_override_from_config, permissions_selection_from_config, thread_config_overrides_from_config); called by 1 (run_exec_session); 1 external calls (default).


##### `thread_config_overrides_from_config`  (lines 1088–1092)

```
fn thread_config_overrides_from_config(config: &Config) -> Option<HashMap<String, Value>>
```

**Purpose**: Extracts small thread-level config switches that need to be sent explicitly to the app server. Currently it sends the bypass-hook-trust flag when that option is enabled.

**Data flow**: It reads `config.bypass_hook_trust`. If true, it returns a map containing that setting; otherwise it returns nothing.

**Call relations**: Both thread-start and thread-resume parameter builders call this so the app server sees the same hook-trust choice in either path.

*Call graph*: called by 2 (thread_resume_params_from_config, thread_start_params_from_config).


##### `permissions_selection_from_config`  (lines 1094–1099)

```
fn permissions_selection_from_config(config: &Config) -> Option<String>
```

**Purpose**: Finds the active named permission profile, if one is selected. A permission profile is a named bundle of rules about what the agent may read, write, or run.

**Data flow**: It reads the permissions section of the config, asks for the active profile, converts it to its ID string if present, and returns that ID or nothing.

**Call relations**: The thread parameter builders call this first. If it returns a profile ID, they send that instead of manually translating to a sandbox mode.

*Call graph*: called by 2 (thread_resume_params_from_config, thread_start_params_from_config).


##### `permission_profile_id_from_active_profile`  (lines 1101–1103)

```
fn permission_profile_id_from_active_profile(active: ActivePermissionProfile) -> String
```

**Purpose**: Pulls the plain ID string out of an active permission profile. This is the value the app server needs when selecting a profile by name.

**Data flow**: It receives an `ActivePermissionProfile`, reads its `id` field, and returns that string.

**Call relations**: It is used as the conversion step inside `permissions_selection_from_config` when a profile exists.


##### `sandbox_mode_from_permission_profile`  (lines 1105–1128)

```
fn sandbox_mode_from_permission_profile(
    permission_profile: &PermissionProfile,
    cwd: &Path,
) -> Option<codex_app_server_protocol::SandboxMode>
```

**Purpose**: Converts a detailed permission profile into a simpler sandbox mode for older app-server fields. A sandbox is the protective boundary that limits file and network access.

**Data flow**: It receives a permission profile and current working directory. Disabled permissions become full access, external profiles do not become a sandbox value, and managed profiles are inspected to choose full access, workspace write, or read-only based on file and network rules.

**Call relations**: The thread start and resume builders use this only when they are not sending a named permission profile. It is the compatibility bridge from rich permissions to simpler server settings.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, network_sandbox_policy).


##### `approvals_reviewer_override_from_config`  (lines 1130–1134)

```
fn approvals_reviewer_override_from_config(
    config: &Config,
) -> Option<codex_app_server_protocol::ApprovalsReviewer>
```

**Purpose**: Converts the configured approvals reviewer into the app-server format. The approvals reviewer controls who, if anyone, can review sensitive actions.

**Data flow**: It reads `config.approvals_reviewer`, converts it to the protocol type, wraps it in `Some`, and returns it.

**Call relations**: Both thread parameter builders call this so new and resumed threads use the configured reviewer choice.

*Call graph*: called by 2 (thread_resume_params_from_config, thread_start_params_from_config).


##### `send_request_with_response`  (lines 1136–1151)

```
async fn send_request_with_response(
    client: &InProcessAppServerClient,
    request: ClientRequest,
    method: &str,
) -> Result<T, String>
```

**Purpose**: Sends a typed request to the in-process app server and turns the typed response back into the caller's expected Rust type. It also adds the method name to errors so failures are easier to understand.

**Data flow**: It receives a client, a request, and a human-readable method name. It sends the request through the client, tries to decode the response as the requested type, and returns either the decoded response or a string error.

**Call relations**: `run_exec_session` uses this for start, resume, turn, review, interrupt, and read requests. `resolve_resume_thread_id` also uses it while searching thread lists.

*Call graph*: calls 1 internal fn (request_typed); called by 2 (resolve_resume_thread_id, run_exec_session).


##### `session_configured_from_thread_start_response`  (lines 1153–1174)

```
fn session_configured_from_thread_start_response(
    response: &ThreadStartResponse,
    config: &Config,
) -> Result<SessionConfiguredEvent, String>
```

**Purpose**: Turns a successful thread-start response into the older `SessionConfiguredEvent` shape used by the output processors. This avoids waiting for a separate streamed startup event.

**Data flow**: It receives the thread-start response and current config, extracts IDs, model, policy, directory, and permission details, then delegates to the shared session-mapping function.

**Call relations**: `run_exec_session` calls this immediately after starting a thread so it can print the effective session configuration and tag telemetry.

*Call graph*: calls 1 internal fn (session_configured_from_thread_response); called by 1 (run_exec_session).


##### `session_configured_from_thread_resume_response`  (lines 1176–1197)

```
fn session_configured_from_thread_resume_response(
    response: &ThreadResumeResponse,
    config: &Config,
) -> Result<SessionConfiguredEvent, String>
```

**Purpose**: Turns a successful thread-resume response into the `SessionConfiguredEvent` shape used by the rest of exec. It gives resumed sessions the same bootstrap information as new ones.

**Data flow**: It receives the resume response and config, extracts thread/session fields and policy details, then delegates to the shared session-mapping function.

**Call relations**: `run_exec_session` calls this after resuming a thread, parallel to the start-thread path.

*Call graph*: calls 1 internal fn (session_configured_from_thread_response); called by 1 (run_exec_session).


##### `review_target_to_api`  (lines 1199–1206)

```
fn review_target_to_api(target: ReviewTarget) -> ApiReviewTarget
```

**Purpose**: Converts exec's internal review target into the app-server protocol's review target. The meaning stays the same; only the type changes.

**Data flow**: It receives a review target such as uncommitted changes, base branch, commit, or custom instructions, and returns the matching API target with the same data.

**Call relations**: `run_exec_session` calls this when sending a `review/start` request after `build_review_request` has interpreted the CLI review arguments.

*Call graph*: called by 1 (run_exec_session).


##### `session_configured_from_thread_response`  (lines 1212–1258)

```
fn session_configured_from_thread_response(
    session_id: &str,
    thread_id: &str,
    parent_thread_id: Option<&str>,
    thread_source: Option<codex_protocol::protocol::ThreadSource>,
    thread
```

**Purpose**: Builds a complete `SessionConfiguredEvent` from raw thread response fields. It also validates that session and thread IDs are in the expected format.

**Data flow**: It receives explicit fields for IDs, names, paths, model, policies, permissions, working directory, and reasoning effort. It parses string IDs into strong ID types, returns an error if parsing fails, and otherwise returns the assembled session event.

**Call relations**: The start-response and resume-response converters both call this so all session bootstrap events are built consistently.

*Call graph*: calls 2 internal fn (from_string, from_string); called by 2 (session_configured_from_thread_resume_response, session_configured_from_thread_start_response).


##### `lagged_event_warning_message`  (lines 1260–1262)

```
fn lagged_event_warning_message(skipped: usize) -> String
```

**Purpose**: Creates the warning text shown when the in-process event stream fell behind and dropped events. This tells the user that some progress details may be missing.

**Data flow**: It receives the number of skipped events and returns a formatted warning string.

**Call relations**: `run_exec_session` calls this when the client reports a lagged event stream, then logs and forwards the warning to the event processor.

*Call graph*: called by 1 (run_exec_session); 1 external calls (format!).


##### `should_process_notification`  (lines 1264–1322)

```
fn should_process_notification(
    notification: &ServerNotification,
    thread_id: &str,
    turn_id: &str,
) -> bool
```

**Purpose**: Decides whether a server notification belongs to the thread and turn this exec run is responsible for. This prevents unrelated background or sub-thread events from polluting the output.

**Data flow**: It receives a notification plus the current thread ID and turn ID. It allows global warnings and config notices, checks thread and turn IDs for turn-specific messages, and returns true only for messages exec should show.

**Call relations**: `run_exec_session` calls this for every server notification before handing it to the human or JSON event processor.

*Call graph*: called by 1 (run_exec_session).


##### `maybe_backfill_turn_completed_items`  (lines 1324–1365)

```
async fn maybe_backfill_turn_completed_items(
    thread_ephemeral: bool,
    client: &InProcessAppServerClient,
    request_ids: &mut RequestIdSequencer,
    notification: &mut ServerNotification,
)
```

**Purpose**: Repairs a final turn-completed notification if its item list is empty because earlier item events were dropped. It reads the saved thread history and copies the final turn items back into the notification.

**Data flow**: It receives whether the thread is ephemeral, the app-server client, request ID counter, and a mutable notification. If backfill is safe and needed, it sends a `thread/read` request, finds the matching turn, and updates the notification's item list; on failure it only logs a warning.

**Call relations**: `run_exec_session` calls this before processing each notification. It uses `should_backfill_turn_completed_items`, `RequestIdSequencer::next`, `send_request_with_response`, and `turn_items_for_thread`.

*Call graph*: calls 3 internal fn (next, should_backfill_turn_completed_items, turn_items_for_thread); called by 1 (run_exec_session); 1 external calls (warn!).


##### `should_backfill_turn_completed_items`  (lines 1369–1378)

```
fn should_backfill_turn_completed_items(
    thread_ephemeral: bool,
    notification: &ServerNotification,
) -> bool
```

**Purpose**: Checks whether a turn-completed notification is eligible for backfilling. Backfill is only safe for non-ephemeral threads with saved history.

**Data flow**: It receives the thread's ephemeral flag and a notification. It returns true only if the notification is a turn completion, the thread is not ephemeral, and the completion currently has no items.

**Call relations**: `maybe_backfill_turn_completed_items` calls this before doing any extra server read.

*Call graph*: called by 1 (maybe_backfill_turn_completed_items).


##### `turn_items_for_thread`  (lines 1380–1389)

```
fn turn_items_for_thread(
    thread: &AppServerThread,
    turn_id: &str,
) -> Option<Vec<AppServerThreadItem>>
```

**Purpose**: Finds the saved items for one turn inside a thread history. These items are what exec may copy into a sparse turn-completed event.

**Data flow**: It receives a thread object and a turn ID, searches the thread's turns for that ID, and returns a cloned item list if found.

**Call relations**: `maybe_backfill_turn_completed_items` calls this after `thread/read` succeeds.

*Call graph*: called by 1 (maybe_backfill_turn_completed_items).


##### `all_thread_source_kinds`  (lines 1391–1404)

```
fn all_thread_source_kinds() -> Vec<ThreadSourceKind>
```

**Purpose**: Returns the full set of thread source categories that resume lookup should search. A source category says where a thread originally came from, such as CLI, VS Code, exec, or sub-agent.

**Data flow**: It takes no input and returns a vector containing every relevant `ThreadSourceKind` value.

**Call relations**: `resolve_resume_thread_id` uses this while listing threads so resume-by-last or resume-by-name is not limited to only one source type.

*Call graph*: called by 1 (resolve_resume_thread_id); 1 external calls (vec!).


##### `latest_thread_cwd`  (lines 1406–1413)

```
async fn latest_thread_cwd(thread: &AppServerThread) -> PathBuf
```

**Purpose**: Determines the latest working directory for a thread. It prefers the newest turn context in the rollout file, falling back to the thread's stored directory.

**Data flow**: It receives a thread. If the thread has a history file path and that file contains a recent turn context with a directory, it returns that directory; otherwise it returns the thread's `cwd`.

**Call relations**: `resolve_resume_thread_id` uses this when deciding whether a candidate thread belongs to the current directory. It delegates file parsing to `parse_latest_turn_context_cwd`.

*Call graph*: calls 1 internal fn (parse_latest_turn_context_cwd); called by 1 (resolve_resume_thread_id).


##### `parse_latest_turn_context_cwd`  (lines 1415–1430)

```
async fn parse_latest_turn_context_cwd(path: &Path) -> Option<PathBuf>
```

**Purpose**: Reads a thread rollout file and finds the most recent saved working directory. A rollout file is a line-by-line record of thread events.

**Data flow**: It receives a path, reads the file as text, walks lines from the bottom upward, parses JSON lines until it finds a turn-context item, and returns that item's directory. If reading or parsing does not find one, it returns nothing.

**Call relations**: `latest_thread_cwd` calls this as its more accurate source of a thread's current directory.

*Call graph*: called by 1 (latest_thread_cwd); 1 external calls (read_to_string).


##### `cwds_match`  (lines 1432–1434)

```
fn cwds_match(current_cwd: &Path, session_cwd: &Path) -> bool
```

**Purpose**: Compares two working-directory paths after normalizing them. This avoids false mismatches caused by small path spelling differences.

**Data flow**: It receives the current directory and a session directory, delegates normalized comparison to path utilities, and returns true if they refer to the same place.

**Call relations**: `resolve_resume_thread_id` uses this to avoid resuming a thread from a different project unless the user asked to search all directories.

*Call graph*: called by 1 (resolve_resume_thread_id); 1 external calls (paths_match_after_normalization).


##### `resolve_resume_thread_id`  (lines 1436–1549)

```
async fn resolve_resume_thread_id(
    client: &InProcessAppServerClient,
    config: &Config,
    state_db: Option<&StateDbHandle>,
    args: &crate::cli::ResumeArgs,
) -> anyhow::Result<Option<Strin
```

**Purpose**: Finds which thread should be resumed for the `resume` command. It supports resuming the last matching thread, a UUID-like ID, an exact title from the state database, or a searched thread name.

**Data flow**: It receives the app-server client, config, optional state database, and resume arguments. Depending on the arguments, it lists recent threads page by page, checks directories, tries direct UUID parsing, searches the local state database, and finally searches server thread lists by name. It returns the selected thread ID or `None` if no match is found.

**Call relations**: `run_exec_session` calls this before deciding whether to send `thread/resume` or start a new thread. It uses helpers for provider filtering, source kinds, latest directories, path matching, and app-server requests.

*Call graph*: calls 5 internal fn (all_thread_source_kinds, cwds_match, latest_thread_cwd, resume_lookup_model_providers, send_request_with_response); called by 1 (run_exec_session); 3 external calls (parse_str, Integer, find_thread_meta_by_name_str).


##### `resume_lookup_model_providers`  (lines 1551–1560)

```
fn resume_lookup_model_providers(
    config: &Config,
    args: &crate::cli::ResumeArgs,
) -> Option<Vec<String>>
```

**Purpose**: Chooses whether resume lookup should be limited to the current model provider. For `--last`, it narrows the search to the active provider; other lookup modes search more broadly.

**Data flow**: It receives config and resume arguments. If `last` is true, it returns a one-item provider list from the current config; otherwise it returns nothing.

**Call relations**: `resolve_resume_thread_id` calls this before listing threads so last-thread lookup behaves predictably for the active provider.

*Call graph*: called by 1 (resolve_resume_thread_id); 1 external calls (vec!).


##### `canceled_mcp_server_elicitation_response`  (lines 1562–1569)

```
fn canceled_mcp_server_elicitation_response() -> Result<Value, String>
```

**Purpose**: Builds the standard response that cancels an MCP server elicitation. MCP here means a tool/server integration asking the user for extra input; exec mode is non-interactive, so it cancels instead of prompting.

**Data flow**: It creates a response object with action `Cancel`, converts it to JSON, and returns that JSON or an encoding error string.

**Call relations**: `handle_server_request` calls this when the app server asks for MCP elicitation, then resolves the server request with the cancel response.

*Call graph*: called by 1 (handle_server_request); 1 external calls (to_value).


##### `request_shutdown`  (lines 1571–1585)

```
async fn request_shutdown(
    client: &InProcessAppServerClient,
    request_ids: &mut RequestIdSequencer,
    thread_id: &str,
) -> Result<(), String>
```

**Purpose**: Asks the app server to unsubscribe exec from the current thread. This is the polite shutdown path when the output processor says it is done.

**Data flow**: It receives the client, request ID counter, and thread ID. It creates a `thread/unsubscribe` request with the next ID, sends it, and returns success once the server acknowledges.

**Call relations**: `run_exec_session` calls this when event processing requests shutdown, such as after final output has been produced.

*Call graph*: calls 1 internal fn (next); called by 1 (run_exec_session).


##### `resolve_server_request`  (lines 1587–1597)

```
async fn resolve_server_request(
    client: &InProcessAppServerClient,
    request_id: RequestId,
    value: serde_json::Value,
    method: &str,
) -> Result<(), String>
```

**Purpose**: Sends a successful answer back to a pending request that the server made to the client. In exec mode this is mainly used for automatic cancellation responses.

**Data flow**: It receives the client, server request ID, JSON value to return, and method name. It asks the client to resolve the request and returns either success or a formatted error.

**Call relations**: `handle_server_request` uses this for MCP elicitation requests after creating a cancel response.

*Call graph*: calls 1 internal fn (resolve_server_request); called by 1 (handle_server_request).


##### `reject_server_request`  (lines 1599–1616)

```
async fn reject_server_request(
    client: &InProcessAppServerClient,
    request_id: RequestId,
    method: &str,
    reason: String,
) -> Result<(), String>
```

**Purpose**: Rejects a server request with a JSON-RPC error. JSON-RPC is a request/response protocol; this sends a structured error instead of a result.

**Data flow**: It receives the client, request ID, method name, and rejection reason. It wraps the reason in a protocol error object, sends it to the client, and returns success or a formatted failure.

**Call relations**: `handle_server_request` uses this for interactive approvals, user-input requests, dynamic tools, token refresh, attestation, and similar features that exec mode cannot support.

*Call graph*: calls 1 internal fn (reject_server_request); called by 1 (handle_server_request).


##### `server_request_method_name`  (lines 1618–1628)

```
fn server_request_method_name(request: &ServerRequest) -> String
```

**Purpose**: Extracts a readable method name from a server request for error messages. If it cannot find one, it uses `unknown`.

**Data flow**: It receives a server request, serializes it to JSON, looks for a `method` string, and returns that string or a fallback.

**Call relations**: `handle_server_request` calls this once before deciding how to answer the request, so rejections mention the relevant method.

*Call graph*: called by 1 (handle_server_request); 1 external calls (to_value).


##### `handle_server_request`  (lines 1630–1762)

```
async fn handle_server_request(
    client: &InProcessAppServerClient,
    request: ServerRequest,
    error_seen: &mut bool,
)
```

**Purpose**: Answers requests that the app server sends back to exec while a turn is running. Because exec is headless, it cancels or rejects anything that would require interactive user input.

**Data flow**: It receives the client, a server request, and a mutable error flag. It identifies the request type, either resolves MCP elicitation with a cancel response or rejects unsupported approvals and prompts with clear reasons. If answering fails, it marks an error and logs a warning.

**Call relations**: `run_exec_session` calls this whenever the in-process event stream yields a server request instead of a notification.

*Call graph*: calls 4 internal fn (canceled_mcp_server_elicitation_response, reject_server_request, resolve_server_request, server_request_method_name); called by 1 (run_exec_session); 2 external calls (format!, warn!).


##### `load_output_schema`  (lines 1764–1788)

```
fn load_output_schema(path: Option<PathBuf>) -> Option<Value>
```

**Purpose**: Reads an optional JSON schema file that constrains the agent's final output shape. A schema is a machine-readable description of what valid JSON output should look like.

**Data flow**: It receives an optional path. If there is no path, it returns nothing. If there is a path, it reads the file, parses it as JSON, returns the JSON value on success, or prints an error and exits if reading or parsing fails.

**Call relations**: `run_exec_session` calls this when preparing a normal user turn or resume prompt, before sending `turn/start`.

*Call graph*: called by 1 (run_exec_session); 3 external calls (eprintln!, read_to_string, exit).


##### `PromptDecodeError::fmt`  (lines 1798–1813)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Turns prompt-decoding errors into helpful messages for users. The messages explain what encoding problem was found and suggest converting input to UTF-8.

**Data flow**: It receives a decode error variant and a formatter, writes the matching human-readable message, and returns the formatting result.

**Call relations**: This display implementation is used when `read_prompt_from_stdin` reports failures from `decode_prompt_bytes`.

*Call graph*: 1 external calls (write!).


##### `decode_prompt_bytes`  (lines 1816–1844)

```
fn decode_prompt_bytes(input: &[u8]) -> Result<String, PromptDecodeError>
```

**Purpose**: Converts raw stdin bytes into a Rust string while detecting common text encodings. It accepts UTF-8 and UTF-16 with byte-order marks, rejects UTF-32, and gives clear errors for invalid text.

**Data flow**: It receives a byte slice, strips a UTF-8 byte-order mark if present, checks for UTF-32 and UTF-16 markers, delegates UTF-16 decoding when needed, or parses the rest as UTF-8. It returns decoded text or a `PromptDecodeError`.

**Call relations**: `read_prompt_from_stdin` calls this after reading all stdin bytes so piped prompts become text safely.

*Call graph*: calls 1 internal fn (decode_utf16); called by 1 (read_prompt_from_stdin); 1 external calls (from_utf8).


##### `decode_utf16`  (lines 1846–1861)

```
fn decode_utf16(
    input: &[u8],
    encoding: &'static str,
    decode_unit: fn([u8; 2]) -> u16,
) -> Result<String, PromptDecodeError>
```

**Purpose**: Decodes UTF-16 text from raw bytes. UTF-16 stores text in two-byte units, so this function checks that the byte count is valid before converting.

**Data flow**: It receives bytes, an encoding label, and a function for turning each two-byte chunk into a number. It rejects odd byte counts, converts chunks into UTF-16 units, and returns the decoded string or an invalid-UTF-16 error.

**Call relations**: `decode_prompt_bytes` calls this for UTF-16 little-endian or big-endian input after seeing the matching byte-order mark.

*Call graph*: called by 1 (decode_prompt_bytes); 1 external calls (from_utf16).


##### `read_prompt_from_stdin`  (lines 1863–1908)

```
fn read_prompt_from_stdin(behavior: StdinPromptBehavior) -> Option<String>
```

**Purpose**: Reads the prompt text from stdin according to the mode chosen by the caller. It supports required piped prompts, forced stdin prompts, and optional extra context appended to a positional prompt.

**Data flow**: It checks whether stdin is a terminal, decides whether to read or exit based on the behavior, reads all bytes, decodes them with `decode_prompt_bytes`, and returns text if non-empty. Empty required input or read/decode errors are printed to stderr and exit the process.

**Call relations**: `resolve_prompt` uses this for missing or `-` prompts. `resolve_root_prompt` also uses it to optionally append piped context to a normal prompt.

*Call graph*: calls 1 internal fn (decode_prompt_bytes); called by 2 (resolve_prompt, resolve_root_prompt); 4 external calls (new, eprintln!, stdin, exit).


##### `prompt_with_stdin_context`  (lines 1910–1917)

```
fn prompt_with_stdin_context(prompt: &str, stdin_text: &str) -> String
```

**Purpose**: Combines a positional prompt with extra stdin text in a clearly marked block. The markers help the model tell which part came from piped input.

**Data flow**: It receives the original prompt and stdin text, builds a string containing the prompt, a `<stdin>` section, the stdin contents, and a closing marker, adding a newline if needed.

**Call relations**: `resolve_root_prompt` calls this when the user supplied a prompt argument and also piped additional input.

*Call graph*: called by 1 (resolve_root_prompt); 1 external calls (format!).


##### `resolve_prompt`  (lines 1919–1934)

```
fn resolve_prompt(prompt_arg: Option<String>) -> String
```

**Purpose**: Finds the actual prompt text when a prompt is required. It uses the provided argument unless it is missing or exactly `-`, in which case it reads stdin.

**Data flow**: It receives an optional prompt argument. A normal string is returned directly; `-` forces stdin; no argument requires piped stdin. It returns the final prompt or exits through `read_prompt_from_stdin` if no valid prompt is available.

**Call relations**: `run_exec_session` calls this for resume prompts, `resolve_root_prompt` uses it for stdin-only root prompts, and `build_review_request` uses it for custom review instructions.

*Call graph*: calls 1 internal fn (read_prompt_from_stdin); called by 3 (build_review_request, resolve_root_prompt, run_exec_session); 2 external calls (matches!, unreachable!).


##### `resolve_root_prompt`  (lines 1936–1947)

```
fn resolve_root_prompt(prompt_arg: Option<String>) -> String
```

**Purpose**: Resolves the top-level exec prompt, with one extra convenience: if a prompt argument exists and stdin is also piped, stdin becomes additional context instead of replacing the prompt.

**Data flow**: It receives an optional prompt argument. A normal prompt may be combined with optional stdin context; `-` or no argument is delegated to `resolve_prompt`. It returns the final text to send to the model.

**Call relations**: `run_exec_session` calls this for the usual `codex exec` path when no subcommand supplies its own prompt.

*Call graph*: calls 3 internal fn (prompt_with_stdin_context, read_prompt_from_stdin, resolve_prompt); called by 1 (run_exec_session).


##### `build_review_request`  (lines 1949–1977)

```
fn build_review_request(args: &ReviewArgs) -> anyhow::Result<ReviewRequest>
```

**Purpose**: Turns review command-line options into a structured review request. It ensures the user clearly picked what should be reviewed.

**Data flow**: It receives review arguments. It chooses one target from uncommitted changes, base branch, commit, or custom instructions read from the prompt path/stdin. It returns a `ReviewRequest`, or an error if no valid target was supplied or custom instructions are empty.

**Call relations**: `run_exec_session` calls this when the selected command is `Review`, then later converts the target with `review_target_to_api` before sending `review/start`.

*Call graph*: calls 1 internal fn (resolve_prompt); called by 1 (run_exec_session); 1 external calls (bail!).
