# Exec-mode and scripted session startup  `stage-9.2`

This stage is the startup and run-to-finish path for non-interactive use: when the tool is asked to do one job, complete it, and exit, rather than open a live chat screen. You can think of it as the “single trip” mode of the system.

The main driver is exec/src/lib.rs. It takes the command-line options the user supplied and turns them into a full session setup. It starts the app server inside the same process, builds the request that will be sent to the model, runs the event loop (the repeating cycle that processes events until the job is done), and then prints the final result. It also prepares structured JSONL output, which means one JSON record per line for easy logging or scripting, and includes small adapter helpers so shared core settings fit this exec mode cleanly.

tui/src/session_resume.rs supports cases where this one-shot run resumes or forks from an earlier saved session. It finds key saved details such as the thread ID, working folder, and model choice. It prefers the central state database when possible, but can fall back to reading local JSONL history files. If the saved folder differs from the current one, it asks the user which to use.

## Files in this stage

### Session resume resolution
Determines the saved-session metadata needed before startup so exec can resume or fork the correct thread with the right cwd and model.

### `tui/src/session_resume.rs`

`domain_logic` · `resume/fork preparation`

This module bridges app-server thread lifecycle data with older local rollout metadata that still matters before a selected thread has been resumed. It defines small deserialization structs for rollout records: `SessionMetadata` captures the original thread ID and cwd from `session_meta`, `TurnContextResumeState` captures later cwd/model updates from `turn_context`, and `RawRecord` is the generic envelope used while scanning the JSONL file. The accumulated result is stored in `RolloutResumeState`, which keeps optional thread ID, cwd, and model.

The public helpers all follow the same preference order. `resolve_session_thread_id` uses an already-known UUID string when supplied; otherwise it reads the rollout file and extracts the saved thread ID. `read_session_model` and the internal `read_session_cwd` first consult `StateRuntime::get_thread(thread_id)` and only fall back to rollout parsing when state-db metadata is unavailable. `resolve_cwd_for_resume_or_fork` then compares the current cwd with the historical cwd using normalization-aware path matching; if prompting is allowed and the paths differ, it runs the TUI cwd-selection prompt and returns either the chosen cwd or an explicit exit outcome.

`read_rollout_resume_state` is tolerant by design. It streams the rollout file line by line with `open_rollout_line_reader`, skips blank lines and malformed JSON, ignores records without payloads, captures the first `session_meta` thread ID/cwd, and lets later `turn_context` records overwrite cwd and model so the latest context wins. If the file contains no parseable records at all, it returns an `io::Error::other` describing the rollout as empty. Tests cover latest-turn-context precedence, fallback to session metadata, and malformed-line skipping.

#### Function details

##### `resolve_session_thread_id`  (lines 54–65)

```
async fn resolve_session_thread_id(
    path: &Path,
    id_str_if_uuid: Option<&str>,
) -> Option<ThreadId>
```

**Purpose**: Determines the thread ID for a saved session from either an already-known UUID string or rollout metadata.

**Data flow**: Takes a rollout path and optional `id_str_if_uuid`; if the string is present, attempts `ThreadId::from_string` and returns the parsed ID on success. Otherwise it awaits `read_rollout_resume_state(path)`, ignores errors, and returns the `thread_id` field from the parsed state.

**Call relations**: The resume picker’s accept path calls this when a selected row has a path but no already-populated thread ID.

*Call graph*: calls 2 internal fn (from_string, read_rollout_resume_state); called by 1 (handle_key).


##### `read_session_model`  (lines 67–84)

```
async fn read_session_model(
    state_db_ctx: Option<&StateRuntime>,
    thread_id: ThreadId,
    path: Option<&Path>,
) -> Option<String>
```

**Purpose**: Finds the model associated with a thread, preferring state-db metadata and falling back to rollout metadata.

**Data flow**: Accepts optional `StateRuntime`, `ThreadId`, and optional rollout path. If state DB is present and `get_thread(thread_id)` returns metadata with `model`, it returns that immediately. Otherwise it requires `path`, reads rollout resume state, ignores errors, and returns the parsed `model` field.

**Call relations**: Other session-state reconstruction code calls this when it needs the model before or alongside resuming a thread.

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

**Purpose**: Determines which cwd should be used when resuming or forking a session, optionally prompting the user if the saved cwd differs from the current cwd.

**Data flow**: Reads the historical cwd via `read_session_cwd`; if none exists, returns `ResolveCwdOutcome::Continue(None)`. If prompting is allowed and `cwds_differ(current_cwd, history_cwd)` is true, it awaits `cwd_prompt::run_cwd_selection_prompt` and maps `Current`, `Session`, or `Exit` into `ResolveCwdOutcome`. Otherwise it returns `Continue(Some(history_cwd))` directly.

**Call relations**: Resume/fork flows call this before launching the resumed session so cwd mismatches can be resolved interactively.

*Call graph*: calls 3 internal fn (run_cwd_selection_prompt, cwds_differ, read_session_cwd); called by 2 (resume_target_session, run_ratatui_app); 2 external calls (to_path_buf, Continue).


##### `read_session_cwd`  (lines 114–138)

```
async fn read_session_cwd(
    state_db_ctx: Option<&StateRuntime>,
    thread_id: ThreadId,
    path: Option<&Path>,
) -> Option<PathBuf>
```

**Purpose**: Finds the saved cwd for a thread from state DB or rollout metadata, warning when rollout parsing fails.

**Data flow**: If state DB is available and `get_thread(thread_id)` succeeds, returns `metadata.cwd`. Otherwise it requires `path`, awaits `read_rollout_resume_state`, returns `state.cwd` on success, and on error logs a warning including the rollout path and returns `None`.

**Call relations**: Used internally by `resolve_cwd_for_resume_or_fork` as the source of historical cwd information.

*Call graph*: calls 1 internal fn (read_rollout_resume_state); called by 1 (resolve_cwd_for_resume_or_fork); 1 external calls (warn!).


##### `cwds_differ`  (lines 140–142)

```
fn cwds_differ(current_cwd: &Path, session_cwd: &Path) -> bool
```

**Purpose**: Compares the current cwd and saved session cwd using normalized path semantics.

**Data flow**: Passes both paths to `path_utils::paths_match_after_normalization` and returns the negated result.

**Call relations**: Used before prompting so equivalent paths with superficial differences do not trigger unnecessary cwd selection.

*Call graph*: called by 2 (rebuild_config_for_resume_or_fallback, resolve_cwd_for_resume_or_fork); 1 external calls (paths_match_after_normalization).


##### `read_rollout_resume_state`  (lines 144–188)

```
async fn read_rollout_resume_state(path: &Path) -> io::Result<RolloutResumeState>
```

**Purpose**: Streams a rollout JSONL file and extracts the latest resumable thread metadata from `session_meta` and `turn_context` records.

**Data flow**: Opens a line reader with `open_rollout_line_reader`, initializes default `RolloutResumeState`, and tracks whether any parseable record was seen. For each non-empty line, it tries to deserialize `RawRecord`; malformed lines are skipped. Records without payload are skipped. The first `session_meta` payload that deserializes into `SessionMetadata` sets `thread_id` and initializes `cwd` if not already set. Every `turn_context` payload that deserializes into `TurnContextResumeState` overwrites `cwd` and `model`. At EOF it returns the accumulated state if any record was seen, otherwise returns `io::Error::other("rollout at ... is empty")`.

**Call relations**: This is the fallback metadata reader used by thread-ID, cwd, and model resolution when state-db data is unavailable.

*Call graph*: called by 6 (read_session_cwd, read_session_model, resolve_session_thread_id, rollout_resume_state_falls_back_to_session_meta, rollout_resume_state_prefers_latest_turn_context, rollout_resume_state_skips_malformed_lines); 4 external calls (other, open_rollout_line_reader, format!, default).


##### `tests::rollout_line`  (lines 196–206)

```
fn rollout_line(
        timestamp: &str,
        item_type: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value
```

**Purpose**: Builds one synthetic rollout JSON object for tests.

**Data flow**: Accepts timestamp, item type, and payload JSON, wraps them in a `serde_json::json!` object with keys `timestamp`, `type`, and `payload`, and returns it.

**Call relations**: The rollout parsing tests use it to assemble realistic JSONL fixtures.

*Call graph*: 1 external calls (json!).


##### `tests::write_rollout_lines`  (lines 208–215)

```
fn write_rollout_lines(path: &Path, lines: &[serde_json::Value]) -> std::io::Result<()>
```

**Purpose**: Writes a sequence of rollout JSON objects to a file as newline-delimited JSON.

**Data flow**: Serializes each `serde_json::Value` to a string, appends `\n`, accumulates the text in a `String`, and writes it to the supplied path with `std::fs::write`.

**Call relations**: Used by the rollout parsing tests to create temporary rollout files.

*Call graph*: 3 external calls (new, to_string, write).


##### `tests::rollout_resume_state_prefers_latest_turn_context`  (lines 218–256)

```
async fn rollout_resume_state_prefers_latest_turn_context() -> std::io::Result<()>
```

**Purpose**: Verifies that later `turn_context` records override earlier cwd/model values while preserving the original thread ID from `session_meta`.

**Data flow**: Creates a temp rollout file containing one `session_meta` and two `turn_context` records, reads it with `read_rollout_resume_state`, and asserts that the returned state contains the thread ID plus the cwd/model from the last `turn_context`.

**Call relations**: This test documents the parser’s latest-context-wins behavior.

*Call graph*: calls 2 internal fn (new, read_rollout_resume_state); 5 external calls (new, assert_eq!, json!, rollout_line, write_rollout_lines).


##### `tests::rollout_resume_state_falls_back_to_session_meta`  (lines 259–284)

```
async fn rollout_resume_state_falls_back_to_session_meta() -> std::io::Result<()>
```

**Purpose**: Verifies that when no `turn_context` exists, the parser still returns thread ID and cwd from `session_meta`.

**Data flow**: Writes a rollout file containing only a `session_meta` record, reads it, and asserts that thread ID and cwd are populated while model remains `None`.

**Call relations**: This covers the fallback path where only initial session metadata is available.

*Call graph*: calls 2 internal fn (new, read_rollout_resume_state); 5 external calls (new, assert_eq!, json!, rollout_line, write_rollout_lines).


##### `tests::rollout_resume_state_skips_malformed_lines`  (lines 287–310)

```
async fn rollout_resume_state_skips_malformed_lines() -> std::io::Result<()>
```

**Purpose**: Verifies that malformed JSON lines do not abort rollout parsing when valid records are also present.

**Data flow**: Writes one valid serialized rollout line followed by malformed JSON, reads the file with `read_rollout_resume_state`, and asserts that the valid thread ID and cwd were still recovered.

**Call relations**: This test documents the parser’s intentionally tolerant line-by-line behavior.

*Call graph*: calls 2 internal fn (new, read_rollout_resume_state); 7 external calls (new, assert_eq!, format!, json!, to_string, write, rollout_line).


### Exec runtime orchestration
Runs the non-interactive exec flow from CLI-derived setup through app-server startup, prompt construction, event-loop execution, and final output emission.

### `exec/src/lib.rs`

`orchestration` · `startup, session bootstrap, request handling, shutdown`

This file is the operational core of the exec crate. It starts by defining small local state types: `InitialOperation` distinguishes a normal user turn from a review run, `StdinPromptBehavior` controls how stdin is interpreted, `RequestIdSequencer` generates monotonically increasing integer JSON-RPC request IDs, and `ExecRunArgs` bundles the fully prepared runtime inputs passed from startup into the session runner. `run_main` is the top-level orchestrator: it unpacks `Cli`, resolves color and tracing behavior, parses `-c` overrides, canonicalizes cwd, loads bootstrap config twice when necessary to fetch cloud config before resolving OSS defaults, builds `ConfigOverrides`, and then constructs the final `Config` with a retry path for `AutoReview` configurations that reject the synthetic headless approval policy. It enforces exec-policy and login restrictions, initializes OTEL/tracing, state DB, environment management, and the in-process app-server client arguments.

`run_exec_session` then chooses either human or JSONL output, validates OSS provider readiness, builds the initial prompt or review request, optionally rejects execution outside a git repo, starts or resumes a thread, synthesizes a `SessionConfiguredEvent` directly from thread start/resume responses to avoid waiting for streamed bootstrap events, and sends either `turn/start` or `review/start`. Its main loop multiplexes Ctrl-C interrupts with server events, auto-rejects unsupported interactive server requests, filters notifications to the active thread/turn, backfills missing `turn.items` via `thread/read` when non-ephemeral delivery dropped item events, and asks the event processor whether shutdown should begin. The file also includes concrete protocol-mapping helpers for thread lifecycle params, permission/sandbox selection, resume lookup across state DB and `thread/list`, prompt decoding from UTF-8/UTF-16 with BOM handling, and review-target construction. A key invariant throughout is stdout cleanliness: only final message output or JSONL events go to stdout; diagnostics and fatal setup errors go to stderr, often followed by immediate process exit.

#### Function details

##### `RequestIdSequencer::new`  (lines 192–194)

```
fn new() -> Self
```

**Purpose**: Constructs the local request-ID generator used for app-server RPCs during a single exec session. It initializes the sequence at integer ID 1.

**Data flow**: Takes no arguments and creates `RequestIdSequencer { next: 1 }`. It does not read external state and returns the initialized struct.

**Call relations**: Called when `run_exec_session` is about to begin issuing `thread/start`, `turn/start`, interrupt, unsubscribe, and backfill requests, so all subsequent client requests can use stable incrementing IDs.

*Call graph*: called by 1 (run_exec_session).


##### `RequestIdSequencer::next`  (lines 196–200)

```
fn next(&mut self) -> RequestId
```

**Purpose**: Allocates the next integer `RequestId` and advances the internal counter. This is the only mutating behavior on the sequencer.

**Data flow**: Reads `self.next`, stores it in a local `id`, increments `self.next`, and returns `RequestId::Integer(id)`. The only state mutation is the increment of the internal counter.

**Call relations**: Used throughout the session flow whenever exec sends a typed request after startup, including shutdown unsubscribe and turn-completion backfill reads; it provides unique IDs for those delegated client calls.

*Call graph*: called by 2 (maybe_backfill_turn_completed_items, request_shutdown); 1 external calls (Integer).


##### `exec_root_span`  (lines 221–228)

```
fn exec_root_span() -> tracing::Span
```

**Purpose**: Creates the root tracing span for an exec invocation with reserved fields for thread and turn IDs. The span is later parented from incoming trace context when available.

**Data flow**: Takes no inputs and returns a `tracing::Span` named `codex.exec` with `otel.kind="internal"` and empty `thread.id` / `turn.id` fields ready to be recorded later.

**Call relations**: Built by `run_main` before session startup so the rest of the run can be instrumented under a single span, with thread and turn identifiers filled in once the app-server responds.

*Call graph*: called by 1 (run_main); 1 external calls (info_span!).


##### `exec_stderr_env_filter`  (lines 230–236)

```
fn exec_stderr_env_filter() -> EnvFilter
```

**Purpose**: Builds the tracing filter used for stderr logging, defaulting to an exec-specific filter that suppresses OTEL exporter self-noise. It prefers `RUST_LOG` when present.

**Data flow**: Reads process environment through `EnvFilter::try_from_default_env`; if absent or invalid, falls back to `EXEC_DEFAULT_LOG_FILTER`, and finally to a plain `error` filter. Returns the resulting `EnvFilter`.

**Call relations**: Called during `run_main` while constructing the tracing subscriber's formatting layer so stderr diagnostics remain minimal and do not pollute headless command output.

*Call graph*: called by 1 (run_main); 1 external calls (try_from_default_env).


##### `run_main`  (lines 238–580)

```
async fn run_main(cli: Cli, arg0_paths: Arg0DispatchPaths) -> anyhow::Result<()>
```

**Purpose**: Performs full CLI startup for `codex exec`: parse-derived option normalization, config loading, policy enforcement, telemetry/tracing setup, app-server client bootstrap, and delegation into the session runner. It is the main library entrypoint used by the binary.

**Data flow**: Consumes `Cli` and `Arg0DispatchPaths`. It reads CLI flags, environment-derived color support, filesystem state (`cwd`, codex home, config files), cloud config bundle storage, login/auth settings, and telemetry environment. It transforms those into `ConfigOverrides`, a final `Config`, OTEL/tracing layers, `StateDbHandle`, `EnvironmentManager`, and `InProcessClientStartArgs`, then invokes `run_exec_session`. On many fatal setup errors it writes a concrete message to stderr and exits the process; otherwise it returns `anyhow::Result<()>`.

**Call relations**: Invoked by `main` after arg0 dispatch and top-level CLI parsing. It delegates config retry logic to `build_exec_config`, bootstrap TOML loading to `load_bootstrap_config_or_exit`, and the actual thread/turn lifecycle to `run_exec_session`; all earlier work exists to prepare those calls with fully resolved runtime state.

*Call graph*: calls 18 internal fn (default, find_codex_home, resolve_oss_provider, install_sqlite_telemetry, record_process_start, from_codex_home, from_env, from_optional_paths, build_exec_config, exec_root_span (+8 more)); 22 external calls (default, new, anyhow!, removed_full_auto_warning, cloud_config_bundle_loader_for_storage, check_execpolicy_for_warnings, resolve_bootstrap_auth_keyring_backend_kind, init_state_db, enforce_login_restrictions, set_parent_from_context (+12 more)).


##### `build_exec_config`  (lines 582–615)

```
async fn build_exec_config(
    overrides: ConfigOverrides,
    preserve_headless_approval_policy: bool,
    build_config: BuildConfig,
) -> std::io::Result<Config>
```

**Purpose**: Builds the final `Config` while compensating for a headless-only approval-policy override that is invalid when the resolved reviewer is `AutoReview`. It retries without the synthetic `approval_policy = never` in that specific case.

**Data flow**: Accepts `ConfigOverrides`, a `preserve_headless_approval_policy` flag, and a `build_config` closure. It first tries `build_config(overrides.clone())`; depending on success/failure and the resolved `approvals_reviewer`, it may call the closure again with `approval_policy: None`. It returns the chosen `Config` or preserves the original I/O error when retry does not justify replacing it.

**Call relations**: Used only by `run_main` after assembling CLI and harness overrides. Its retry path exists because exec defaults to non-interactive approvals, but auto-review configurations must retain their configured approval policy instead of the synthetic headless one.

*Call graph*: called by 1 (run_main); 1 external calls (clone).


##### `load_bootstrap_config_or_exit`  (lines 618–655)

```
async fn load_bootstrap_config_or_exit(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_kv_overrides: Vec<(String, codex_config::TomlValue)>,
    loader_overrides: LoaderOverrides,
```

**Purpose**: Loads layered `config.toml` state needed during early startup and terminates the process with a formatted error if loading fails. It is intentionally bootstrap-focused and returns the TOML-layer result rather than a full `Config`.

**Data flow**: Takes codex home, optional cwd, parsed CLI key/value overrides, `LoaderOverrides`, strictness, and a `CloudConfigBundleLoader`. It calls `load_config_toml_with_layer_stack`; on success it returns `ConfigTomlLoadResult`. On failure it inspects whether the error wraps `ConfigLoadError`, formats source-aware diagnostics when possible, prints to stderr, and exits.

**Call relations**: Called by `run_main` first without cloud config and sometimes again with cloud config available, because OSS provider resolution may require a second bootstrap pass after auth/base-url settings are known.

*Call graph*: calls 1 internal fn (load_config_toml_with_layer_stack); called by 1 (run_main); 2 external calls (eprintln!, exit).


##### `run_exec_session`  (lines 657–1039)

```
async fn run_exec_session(args: ExecRunArgs) -> anyhow::Result<()>
```

**Purpose**: Runs one non-interactive exec session against the in-process app-server: choose output mode, start or resume a thread, send the initial turn or review request, process streamed events, and determine exit status. This is the runtime loop after all startup preparation is complete.

**Data flow**: Consumes `ExecRunArgs`, reading config, prompt/review inputs, image paths, output schema path, git repo state, and app-server startup args. It constructs an `EventProcessor`, may validate OSS provider readiness, resolves the initial operation into `UserInput` items or a `ReviewRequest`, starts `InProcessAppServerClient`, sends `thread/start` or `thread/resume`, synthesizes `SessionConfiguredEvent`, sends `turn/start` or `review/start`, then loops over Ctrl-C and `client.next_event()`. It mutates `error_seen`, request IDs, and event-processor state; writes warnings/final output through the processor; may send interrupt, thread-read backfill, and unsubscribe requests; and exits with code 1 if a fatal turn/server error was observed.

**Call relations**: Called by `run_main` once startup has produced a complete `ExecRunArgs`. Inside, it delegates request construction to thread param helpers, resume lookup to `resolve_resume_thread_id`, protocol bootstrap mapping to the `session_configured_from_*` helpers, notification filtering to `should_process_notification`, backfill to `maybe_backfill_turn_completed_items`, unsupported server-request handling to `handle_server_request`, and shutdown unsubscribe to `request_shutdown`.

*Call graph*: calls 20 internal fn (start, new, build_review_request, create_with_ansi, new, handle_server_request, lagged_event_warning_message, load_output_schema, maybe_backfill_turn_completed_items, request_shutdown (+10 more)); called by 1 (run_main); 18 external calls (new, TurnStarted, new, anyhow!, system_bwrap_warning, user_facing_hint, get_git_repo_root, ensure_oss_provider_ready, eprintln!, error! (+8 more)).


##### `thread_start_params_from_config`  (lines 1041–1063)

```
fn thread_start_params_from_config(config: &Config) -> ThreadStartParams
```

**Purpose**: Builds `ThreadStartParams` from the resolved exec configuration, including model/provider, cwd, workspace roots, approval settings, and either a permission-profile selection or a legacy sandbox mode. It encodes the startup thread as a user-originated thread.

**Data flow**: Reads fields from `&Config`: model, provider ID, cwd, workspace roots, approval policy, reviewer, effective permission profile, active permission profile, bypass-hook-trust, and ephemeral flag. It computes `permissions` via `permissions_selection_from_config`; if absent, it computes `sandbox` from the effective permission profile and cwd. It returns a populated `ThreadStartParams` with `thread_source: Some(ThreadSource::User)` and defaults for unspecified fields.

**Call relations**: Used by `run_exec_session` when starting a fresh thread. It delegates small pieces of translation to `permissions_selection_from_config`, `sandbox_mode_from_permission_profile`, `approvals_reviewer_override_from_config`, and `thread_config_overrides_from_config`.

*Call graph*: calls 3 internal fn (approvals_reviewer_override_from_config, permissions_selection_from_config, thread_config_overrides_from_config); called by 1 (run_exec_session); 1 external calls (default).


##### `thread_resume_params_from_config`  (lines 1065–1086)

```
fn thread_resume_params_from_config(config: &Config, thread_id: String) -> ThreadResumeParams
```

**Purpose**: Builds `ThreadResumeParams` for resuming an existing thread while applying the current exec configuration's model, cwd, approval, permission, and config overrides. It mirrors thread-start behavior but includes the target thread ID.

**Data flow**: Consumes `&Config` and a `thread_id: String`. It reads the same config fields as thread-start, computes `permissions` and fallback `sandbox`, and returns `ThreadResumeParams` containing the supplied thread ID plus current lifecycle overrides.

**Call relations**: Called by `run_exec_session` only on the resume path after `resolve_resume_thread_id` has identified a thread to continue. It shares the same helper translations as `thread_start_params_from_config`.

*Call graph*: calls 3 internal fn (approvals_reviewer_override_from_config, permissions_selection_from_config, thread_config_overrides_from_config); called by 1 (run_exec_session); 1 external calls (default).


##### `thread_config_overrides_from_config`  (lines 1088–1092)

```
fn thread_config_overrides_from_config(config: &Config) -> Option<HashMap<String, Value>>
```

**Purpose**: Extracts exec-specific thread config overrides that must be sent as arbitrary JSON config values. Currently this only preserves hook-trust bypass.

**Data flow**: Reads `config.bypass_hook_trust`; if true, returns `Some(HashMap<String, Value>)` containing `"bypass_hook_trust": true`, otherwise returns `None`.

**Call relations**: Used by both thread lifecycle param builders so start and resume requests carry the same hook-trust override when the CLI/config enabled it.

*Call graph*: called by 2 (thread_resume_params_from_config, thread_start_params_from_config).


##### `permissions_selection_from_config`  (lines 1094–1099)

```
fn permissions_selection_from_config(config: &Config) -> Option<String>
```

**Purpose**: Converts the active permission profile, when present, into the string identifier expected by app-server thread lifecycle APIs. It suppresses legacy sandbox translation when a profile is active.

**Data flow**: Reads `config.permissions.active_permission_profile()`. If present, maps it through `permission_profile_id_from_active_profile`; otherwise returns `None`.

**Call relations**: Called by both thread-start and thread-resume param builders to decide whether to send a profile selection string or fall back to explicit sandbox mode.

*Call graph*: called by 2 (thread_resume_params_from_config, thread_start_params_from_config).


##### `permission_profile_id_from_active_profile`  (lines 1101–1103)

```
fn permission_profile_id_from_active_profile(active: ActivePermissionProfile) -> String
```

**Purpose**: Extracts the stable profile ID string from an `ActivePermissionProfile`. It intentionally ignores any other metadata on the active profile wrapper.

**Data flow**: Consumes `ActivePermissionProfile` by value and returns its `id` field as `String`.

**Call relations**: Used as the mapping step inside `permissions_selection_from_config`; it isolates the exact selection semantics for tests and future callers.


##### `sandbox_mode_from_permission_profile`  (lines 1105–1128)

```
fn sandbox_mode_from_permission_profile(
    permission_profile: &PermissionProfile,
    cwd: &Path,
) -> Option<codex_app_server_protocol::SandboxMode>
```

**Purpose**: Derives the legacy app-server sandbox mode from a core `PermissionProfile` and cwd when no active permission-profile selection is being sent. The mapping preserves distinctions between disabled, external, and managed profiles.

**Data flow**: Reads the provided `PermissionProfile` and `cwd`. For `Disabled`, returns `DangerFullAccess`; for `External`, returns `None`; for `Managed`, inspects filesystem and network sandbox policies to choose `DangerFullAccess`, `WorkspaceWrite`, or `ReadOnly`. It returns `Option<codex_app_server_protocol::SandboxMode>`.

**Call relations**: Called by both thread lifecycle param builders only when `permissions_selection_from_config` returned `None`, providing backward-compatible sandbox semantics for older or profile-less configurations.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, network_sandbox_policy).


##### `approvals_reviewer_override_from_config`  (lines 1130–1134)

```
fn approvals_reviewer_override_from_config(
    config: &Config,
) -> Option<codex_app_server_protocol::ApprovalsReviewer>
```

**Purpose**: Converts the resolved core approvals reviewer into the app-server protocol enum wrapper expected on thread lifecycle requests. It always returns `Some(...)`.

**Data flow**: Reads `config.approvals_reviewer`, converts it with `Into`, and wraps it in `Some`.

**Call relations**: Used by both thread-start and thread-resume param builders so the app-server sees the same reviewer mode that exec resolved locally.

*Call graph*: called by 2 (thread_resume_params_from_config, thread_start_params_from_config).


##### `send_request_with_response`  (lines 1136–1151)

```
async fn send_request_with_response(
    client: &InProcessAppServerClient,
    request: ClientRequest,
    method: &str,
) -> Result<T, String>
```

**Purpose**: Sends a typed client request to the in-process app-server and annotates any error with the RPC method name. It centralizes the common request/response pattern used throughout exec.

**Data flow**: Takes `&InProcessAppServerClient`, a `ClientRequest`, and a method label. It awaits `client.request_typed(request)` and returns `Result<T, String>`, converting transport/protocol errors into either the raw string or `"{method}: {err}"`.

**Call relations**: This helper is the common outbound RPC path for `run_exec_session`, `resolve_resume_thread_id`, `maybe_backfill_turn_completed_items`, and `request_shutdown`, reducing repeated error formatting around app-server calls.

*Call graph*: calls 1 internal fn (request_typed); called by 2 (resolve_resume_thread_id, run_exec_session).


##### `session_configured_from_thread_start_response`  (lines 1153–1174)

```
fn session_configured_from_thread_start_response(
    response: &ThreadStartResponse,
    config: &Config,
) -> Result<SessionConfiguredEvent, String>
```

**Purpose**: Builds a local `SessionConfiguredEvent` from a `ThreadStartResponse`, using the response as the authoritative bootstrap payload instead of waiting for a streamed session-configured event. It preserves response-derived review policy and thread metadata.

**Data flow**: Reads fields from `ThreadStartResponse` plus the effective permission profile from `&Config`, then forwards them into `session_configured_from_thread_response`. Returns `Result<SessionConfiguredEvent, String>`.

**Call relations**: Called by `run_exec_session` immediately after `thread/start` succeeds so config summary output and tracing can proceed without startup latency from waiting on later notifications.

*Call graph*: calls 1 internal fn (session_configured_from_thread_response); called by 1 (run_exec_session).


##### `session_configured_from_thread_resume_response`  (lines 1176–1197)

```
fn session_configured_from_thread_resume_response(
    response: &ThreadResumeResponse,
    config: &Config,
) -> Result<SessionConfiguredEvent, String>
```

**Purpose**: Builds a local `SessionConfiguredEvent` from a `ThreadResumeResponse` using the same bootstrap shortcut as thread start. It adapts resumed-thread metadata into the core event shape expected by output processors.

**Data flow**: Reads session/thread IDs, parent/source/name/path, model/provider/service tier, approval settings, active permission profile, cwd, and reasoning effort from `ThreadResumeResponse`, combines them with the config's effective permission profile, and returns the mapped `SessionConfiguredEvent` or a validation error string.

**Call relations**: Used by `run_exec_session` on the resume path after `thread/resume`, parallel to the thread-start helper.

*Call graph*: calls 1 internal fn (session_configured_from_thread_response); called by 1 (run_exec_session).


##### `review_target_to_api`  (lines 1199–1206)

```
fn review_target_to_api(target: ReviewTarget) -> ApiReviewTarget
```

**Purpose**: Converts the core `ReviewTarget` enum used by exec CLI logic into the app-server protocol's `ReviewTarget` enum. The mapping is variant-for-variant.

**Data flow**: Consumes a `ReviewTarget` and returns the corresponding `ApiReviewTarget`, preserving branch names, commit SHA/title, or custom instructions.

**Call relations**: Called by `run_exec_session` only when the initial operation is a review, just before sending `ClientRequest::ReviewStart`.

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

**Purpose**: Performs the actual field-by-field conversion from app-server thread lifecycle response data into a core `SessionConfiguredEvent`, validating string IDs into typed `SessionId` and `ThreadId`. It is the shared implementation behind both start and resume bootstrap mapping.

**Data flow**: Accepts explicit scalar and optional fields for session/thread IDs, parent thread, source, name, rollout path, model/provider/service tier, approval settings, permission profile data, cwd, and reasoning effort. It parses IDs with `SessionId::from_string` and `ThreadId::from_string`, propagates parse failures as descriptive `String`s, and returns a fully populated `SessionConfiguredEvent` with `forked_from_id`, `initial_messages`, and `network_proxy` set to `None`.

**Call relations**: Called by both `session_configured_from_thread_start_response` and `session_configured_from_thread_resume_response` so the two response types share identical validation and event construction.

*Call graph*: calls 2 internal fn (from_string, from_string); called by 2 (session_configured_from_thread_resume_response, session_configured_from_thread_start_response).


##### `lagged_event_warning_message`  (lines 1260–1262)

```
fn lagged_event_warning_message(skipped: usize) -> String
```

**Purpose**: Formats the warning shown when the in-process event stream reports dropped events due to lag. The message is explicit about the number of skipped events.

**Data flow**: Takes `skipped: usize` and returns a formatted `String` mentioning the dropped count.

**Call relations**: Used by `run_exec_session` when it receives `InProcessServerEvent::Lagged`, before logging and forwarding the warning to the active event processor.

*Call graph*: called by 1 (run_exec_session); 1 external calls (format!).


##### `should_process_notification`  (lines 1264–1322)

```
fn should_process_notification(
    notification: &ServerNotification,
    thread_id: &str,
    turn_id: &str,
) -> bool
```

**Purpose**: Filters app-server notifications down to those relevant to the primary thread and active turn, while still allowing global config/deprecation warnings through. It prevents unrelated thread activity from polluting exec output.

**Data flow**: Reads a `ServerNotification` plus the current `thread_id` and `turn_id`. It pattern-matches notification variants and returns `true` only for globally relevant warnings or notifications whose embedded thread/turn identifiers match the active session, with special handling for optional turn IDs on hook events and optional thread IDs on warnings.

**Call relations**: Called inside the main event loop in `run_exec_session` after optional backfill. Only notifications passing this predicate are handed to the selected `EventProcessor`.

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

**Purpose**: Repairs `TurnCompleted` notifications that arrive with empty `turn.items` by issuing a final `thread/read` against rollout-backed history. This lets exec recover final messages and reconcile in-progress items that may have been dropped under backpressure.

**Data flow**: Takes the thread's `ephemeral` flag, client handle, mutable request-ID sequencer, and mutable `ServerNotification`. It first checks `should_backfill_turn_completed_items`; if the notification is a qualifying `TurnCompleted`, it sends `thread/read` with `include_turns: true`, looks up the matching turn via `turn_items_for_thread`, and mutates `payload.turn.items` in place when found. On request failure it logs a warning and leaves the notification unchanged.

**Call relations**: Invoked by `run_exec_session` before notification filtering/processing so downstream event processors see the best available terminal turn payload. It delegates the eligibility check and turn-item extraction to dedicated helpers.

*Call graph*: calls 3 internal fn (next, should_backfill_turn_completed_items, turn_items_for_thread); called by 1 (run_exec_session); 1 external calls (warn!).


##### `should_backfill_turn_completed_items`  (lines 1369–1378)

```
fn should_backfill_turn_completed_items(
    thread_ephemeral: bool,
    notification: &ServerNotification,
) -> bool
```

**Purpose**: Determines whether a `TurnCompleted` notification is eligible for item backfill. The rule is intentionally conservative: only non-ephemeral threads with empty terminal item lists qualify.

**Data flow**: Reads `thread_ephemeral` and a `ServerNotification`. It returns `true` only when the notification is `ServerNotification::TurnCompleted`, `thread_ephemeral` is false, and `payload.turn.items.is_empty()`.

**Call relations**: Used exclusively by `maybe_backfill_turn_completed_items` to avoid unnecessary `thread/read` calls and to skip ephemeral threads that cannot safely recover rollout-backed history.

*Call graph*: called by 1 (maybe_backfill_turn_completed_items).


##### `turn_items_for_thread`  (lines 1380–1389)

```
fn turn_items_for_thread(
    thread: &AppServerThread,
    turn_id: &str,
) -> Option<Vec<AppServerThreadItem>>
```

**Purpose**: Extracts the item list for a specific turn from an app-server thread snapshot. It is a simple lookup helper used during turn-completion backfill.

**Data flow**: Reads `&AppServerThread` and `turn_id: &str`, scans `thread.turns` for a matching turn ID, and returns `Some(turn.items.clone())` or `None`.

**Call relations**: Called by `maybe_backfill_turn_completed_items` after a successful `thread/read` to splice recovered items into the terminal notification.

*Call graph*: called by 1 (maybe_backfill_turn_completed_items).


##### `all_thread_source_kinds`  (lines 1391–1404)

```
fn all_thread_source_kinds() -> Vec<ThreadSourceKind>
```

**Purpose**: Returns the complete set of thread source kinds that exec considers when searching for resumable threads. This broad list ensures resume can find threads created by exec itself and related subagent flows.

**Data flow**: Takes no inputs and returns a `Vec<ThreadSourceKind>` containing CLI, VS Code, Exec, AppServer, multiple subagent variants, and Unknown.

**Call relations**: Used by `resolve_resume_thread_id` when issuing `thread/list` requests so searches are not accidentally narrowed to only one source kind.

*Call graph*: called by 1 (resolve_resume_thread_id); 1 external calls (vec!).


##### `latest_thread_cwd`  (lines 1406–1413)

```
async fn latest_thread_cwd(thread: &AppServerThread) -> PathBuf
```

**Purpose**: Determines the most accurate cwd for a thread by preferring the latest `TurnContext` entry from its rollout file when available, falling back to the thread's stored cwd otherwise. This avoids mismatches when cwd changed during the thread's lifetime.

**Data flow**: Reads `thread.path` and `thread.cwd`. If a rollout path exists and `parse_latest_turn_context_cwd` returns a cwd, it returns that path; otherwise it clones and returns `thread.cwd` as `PathBuf`.

**Call relations**: Called by `resolve_resume_thread_id` while filtering candidate threads by cwd, especially for `--last` and named-session searches.

*Call graph*: calls 1 internal fn (parse_latest_turn_context_cwd); called by 1 (resolve_resume_thread_id).


##### `parse_latest_turn_context_cwd`  (lines 1415–1430)

```
async fn parse_latest_turn_context_cwd(path: &Path) -> Option<PathBuf>
```

**Purpose**: Scans a rollout JSONL file from the end to find the most recent `TurnContext` item and extract its cwd. It tolerates blank lines and unrelated or malformed JSONL entries.

**Data flow**: Takes a rollout `&Path`, asynchronously reads the file to string, iterates lines in reverse, trims and skips empties, attempts to deserialize each line as `RolloutLine`, and returns `Some(item.cwd)` for the first `RolloutItem::TurnContext` found. Any read or parse failure on individual lines is ignored; total failure yields `None`.

**Call relations**: Used only by `latest_thread_cwd` to refine cwd matching during resume lookup.

*Call graph*: called by 1 (latest_thread_cwd); 1 external calls (read_to_string).


##### `cwds_match`  (lines 1432–1434)

```
fn cwds_match(current_cwd: &Path, session_cwd: &Path) -> bool
```

**Purpose**: Compares the current cwd and a candidate session cwd using normalized path semantics rather than raw string equality. This avoids false mismatches from path formatting differences.

**Data flow**: Reads two `&Path` values and returns the boolean result of `path_utils::paths_match_after_normalization`.

**Call relations**: Called by `resolve_resume_thread_id` whenever resume lookup needs to restrict candidates to the current working directory unless `--all` was requested.

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

**Purpose**: Finds the thread ID to resume based on `resume` CLI arguments, using a layered strategy across recent-thread listing, exact UUID/session ID handling, state DB title lookup, metadata lookup by name, and finally paginated server-side search. It also enforces cwd scoping unless `--all` is set.

**Data flow**: Consumes the app-server client, resolved `Config`, optional `StateDbHandle`, and `ResumeArgs`. It first computes optional model-provider filters via `resume_lookup_model_providers`. For `--last`, it pages through `thread/list` sorted by `UpdatedAt`, computes each candidate's latest cwd via `latest_thread_cwd`, and returns the first matching thread ID. For named resumes, it treats a UUID-looking session ID as already-resolved, otherwise queries state DB exact-title lookup, then `find_thread_meta_by_name_str`, then paginated `thread/list` search by term and exact thread name match. It returns `anyhow::Result<Option<String>>`.

**Call relations**: Called by `run_exec_session` only on the resume subcommand before deciding whether to send `thread/resume` or fall back to `thread/start`. It delegates provider filtering, cwd comparison, rollout cwd extraction, and outbound RPCs to dedicated helpers.

*Call graph*: calls 5 internal fn (all_thread_source_kinds, cwds_match, latest_thread_cwd, resume_lookup_model_providers, send_request_with_response); called by 1 (run_exec_session); 3 external calls (parse_str, Integer, find_thread_meta_by_name_str).


##### `resume_lookup_model_providers`  (lines 1551–1560)

```
fn resume_lookup_model_providers(
    config: &Config,
    args: &crate::cli::ResumeArgs,
) -> Option<Vec<String>>
```

**Purpose**: Determines whether resume lookup should be restricted to the current model provider. Only `--last` lookups are narrowed this way.

**Data flow**: Reads `config.model_provider_id` and `ResumeArgs`. Returns `Some(vec![provider_id])` when `args.last` is true; otherwise returns `None`.

**Call relations**: Used by `resolve_resume_thread_id` to shape `thread/list` queries. The narrower filter helps `--last` prefer the most recent thread for the current provider without affecting explicit named-session searches.

*Call graph*: called by 1 (resolve_resume_thread_id); 1 external calls (vec!).


##### `canceled_mcp_server_elicitation_response`  (lines 1562–1569)

```
fn canceled_mcp_server_elicitation_response() -> Result<Value, String>
```

**Purpose**: Builds the serialized JSON response payload that tells the server an MCP elicitation request was canceled. Exec uses this instead of surfacing interactive elicitation to the user.

**Data flow**: Constructs `McpServerElicitationRequestResponse { action: Cancel, content: None, meta: None }`, serializes it to `serde_json::Value`, and returns `Result<Value, String>` with a formatted serialization error on failure.

**Call relations**: Called by `handle_server_request` when the app-server asks for MCP elicitation input; the resulting JSON is passed to `resolve_server_request`.

*Call graph*: called by 1 (handle_server_request); 1 external calls (to_value).


##### `request_shutdown`  (lines 1571–1585)

```
async fn request_shutdown(
    client: &InProcessAppServerClient,
    request_ids: &mut RequestIdSequencer,
    thread_id: &str,
) -> Result<(), String>
```

**Purpose**: Requests thread unsubscription during graceful shutdown so the app-server can stop sending events for the active thread. It wraps the unsubscribe RPC and discards the typed response body.

**Data flow**: Takes the client, mutable request-ID sequencer, and active `thread_id`. It builds `ClientRequest::ThreadUnsubscribe` with a fresh request ID, sends it through `send_request_with_response::<ThreadUnsubscribeResponse>`, and maps success to `Ok(())`.

**Call relations**: Called by `run_exec_session` when the event processor returns `CodexStatus::InitiateShutdown`, typically after terminal turn completion or failure.

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

**Purpose**: Sends a successful response to a server-initiated request and annotates transport errors with the method name. It is the positive-response counterpart to request rejection.

**Data flow**: Consumes the client, `request_id`, serialized response `Value`, and method label. It awaits `client.resolve_server_request` and returns `Result<(), String>` with a formatted failure message if the response could not be delivered.

**Call relations**: Used by `handle_server_request` for the one supported automatic server-request path in exec mode: canceling MCP elicitation requests.

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

**Purpose**: Rejects a server-initiated request with a generic JSON-RPC application error explaining why exec mode does not support it. It standardizes the rejection code and formatting.

**Data flow**: Takes the client, `request_id`, method label, and human-readable reason. It constructs `JSONRPCErrorError { code: -32000, message: reason, data: None }`, sends it via `client.reject_server_request`, and returns `Result<(), String>` with method-qualified transport errors.

**Call relations**: Called by `handle_server_request` for all unsupported interactive approval/input/auth/attestation request variants.

*Call graph*: calls 1 internal fn (reject_server_request); called by 1 (handle_server_request).


##### `server_request_method_name`  (lines 1618–1628)

```
fn server_request_method_name(request: &ServerRequest) -> String
```

**Purpose**: Extracts the JSON-RPC method name string from a `ServerRequest` for logging and rejection messages. It falls back to `unknown` if serialization or field extraction fails.

**Data flow**: Serializes `&ServerRequest` to `serde_json::Value`, reads the `method` field as a string if present, and returns that string or `"unknown"`.

**Call relations**: Used at the start of `handle_server_request` so all rejection/error paths can mention the concrete method name without duplicating per-variant literals.

*Call graph*: called by 1 (handle_server_request); 1 external calls (to_value).


##### `handle_server_request`  (lines 1630–1762)

```
async fn handle_server_request(
    client: &InProcessAppServerClient,
    request: ServerRequest,
    error_seen: &mut bool,
)
```

**Purpose**: Processes server-initiated requests that arrive during exec mode, auto-canceling MCP elicitation and rejecting all other interactive or unsupported request types. It also marks the session as errored if request handling itself fails.

**Data flow**: Takes the client, a `ServerRequest`, and mutable `error_seen`. It derives the method name, matches the request variant, and either builds a cancel payload via `canceled_mcp_server_elicitation_response` then calls `resolve_server_request`, or calls `reject_server_request` with a variant-specific reason mentioning the relevant thread/conversation ID. If the chosen action returns `Err`, it sets `*error_seen = true` and logs a warning.

**Call relations**: Invoked by `run_exec_session` whenever `client.next_event()` yields `InProcessServerEvent::ServerRequest`. It is intentionally narrow: exec mode does not surface interactive approvals or user-input prompts, so this function terminates those branches immediately.

*Call graph*: calls 4 internal fn (canceled_mcp_server_elicitation_response, reject_server_request, resolve_server_request, server_request_method_name); called by 1 (run_exec_session); 2 external calls (format!, warn!).


##### `load_output_schema`  (lines 1764–1788)

```
fn load_output_schema(path: Option<PathBuf>) -> Option<Value>
```

**Purpose**: Reads an optional JSON output schema file from disk and parses it into `serde_json::Value`. Invalid paths or invalid JSON are treated as fatal CLI errors.

**Data flow**: Consumes `Option<PathBuf>`. If `None`, returns `None`. If `Some(path)`, reads the file to string, parses it as JSON, and returns `Some(Value)` on success. Read or parse failures print a path-specific message to stderr and exit the process.

**Call relations**: Called by `run_exec_session` when constructing the initial user turn for both fresh and resumed sessions, so `turn/start` can include `output_schema` when requested.

*Call graph*: called by 1 (run_exec_session); 3 external calls (eprintln!, read_to_string, exit).


##### `PromptDecodeError::fmt`  (lines 1798–1813)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats prompt-decoding failures into actionable user-facing messages that explain the detected encoding problem and suggest converting input to UTF-8. The wording differs for invalid UTF-8, invalid UTF-16, and unsupported UTF-32 BOMs.

**Data flow**: Reads the enum variant and writes a descriptive string into the provided formatter. It returns the standard formatting result.

**Call relations**: Used implicitly when `read_prompt_from_stdin` reports decoding failures to stderr after `decode_prompt_bytes` returns an error.

*Call graph*: 1 external calls (write!).


##### `decode_prompt_bytes`  (lines 1816–1844)

```
fn decode_prompt_bytes(input: &[u8]) -> Result<String, PromptDecodeError>
```

**Purpose**: Decodes stdin prompt bytes into a `String`, supporting UTF-8 with optional BOM and UTF-16LE/BE with BOM while explicitly rejecting UTF-32 BOMs. It preserves plain UTF-8 behavior for unmarked input.

**Data flow**: Takes `&[u8]`, strips a UTF-8 BOM if present, checks for UTF-32LE/BE BOMs and returns `UnsupportedBom` errors, checks for UTF-16LE/BE BOMs and delegates to `decode_utf16`, otherwise attempts `std::str::from_utf8`. It returns `Result<String, PromptDecodeError>`.

**Call relations**: Called by `read_prompt_from_stdin` after reading raw stdin bytes. Its explicit BOM handling is what lets exec accept common text-file encodings while still failing clearly on unsupported ones.

*Call graph*: calls 1 internal fn (decode_utf16); called by 1 (read_prompt_from_stdin); 1 external calls (from_utf8).


##### `decode_utf16`  (lines 1846–1861)

```
fn decode_utf16(
    input: &[u8],
    encoding: &'static str,
    decode_unit: fn([u8; 2]) -> u16,
) -> Result<String, PromptDecodeError>
```

**Purpose**: Decodes BOM-stripped UTF-16 byte input using the supplied endianness decoder and validates both byte alignment and UTF-16 correctness. It is the shared implementation for UTF-16LE and UTF-16BE prompt decoding.

**Data flow**: Consumes the raw byte slice, an encoding label, and a `decode_unit` function. It rejects odd-length input with `InvalidUtf16`, converts each 2-byte chunk into `u16`, then calls `String::from_utf16`, mapping any decoding failure to `InvalidUtf16 { encoding }`.

**Call relations**: Used only by `decode_prompt_bytes` after BOM detection chooses UTF-16LE or UTF-16BE.

*Call graph*: called by 1 (decode_prompt_bytes); 1 external calls (from_utf16).


##### `read_prompt_from_stdin`  (lines 1863–1908)

```
fn read_prompt_from_stdin(behavior: StdinPromptBehavior) -> Option<String>
```

**Purpose**: Reads prompt text from stdin according to one of three CLI behaviors: required when piped, forced, or optional append-only context. It also emits user guidance and exits on missing/empty/undecodable input when stdin is required.

**Data flow**: Reads terminal status from `stdin().is_terminal()` and branches on `StdinPromptBehavior`. Depending on behavior, it may print guidance, return `None` immediately for optional-terminal stdin, or read all stdin bytes into a buffer. It decodes bytes via `decode_prompt_bytes`, trims to detect empty content, and returns `Some(String)` or exits with a stderr message on fatal cases.

**Call relations**: Called by `resolve_prompt` and `resolve_root_prompt`. Those higher-level helpers decide whether stdin is the primary prompt or extra context; this function performs the actual terminal detection, byte reading, and decoding.

*Call graph*: calls 1 internal fn (decode_prompt_bytes); called by 2 (resolve_prompt, resolve_root_prompt); 4 external calls (new, eprintln!, stdin, exit).


##### `prompt_with_stdin_context`  (lines 1910–1917)

```
fn prompt_with_stdin_context(prompt: &str, stdin_text: &str) -> String
```

**Purpose**: Combines a positional prompt with piped stdin by wrapping the stdin text in a `<stdin>...</stdin>` block appended after a blank line. It ensures the closing tag is on its own line even when stdin lacked a trailing newline.

**Data flow**: Takes `prompt: &str` and `stdin_text: &str`, formats `"{prompt}\n\n<stdin>\n{stdin_text}"`, conditionally appends a newline if `stdin_text` did not end with one, then appends `</stdin>`. Returns the combined `String`.

**Call relations**: Used by `resolve_root_prompt` when a root positional prompt is present and stdin is also piped, preserving both sources of user input in a structured way.

*Call graph*: called by 1 (resolve_root_prompt); 1 external calls (format!).


##### `resolve_prompt`  (lines 1919–1934)

```
fn resolve_prompt(prompt_arg: Option<String>) -> String
```

**Purpose**: Resolves a prompt argument into concrete text, treating `-` as forced stdin and absence of a positional prompt as legacy 'read stdin if piped' behavior. It guarantees a string result or terminates earlier in stdin-reading helpers.

**Data flow**: Consumes `Option<String>`. If it is `Some(p)` and not `"-"`, returns `p`. Otherwise it chooses `StdinPromptBehavior::Forced` for explicit `-` or `RequiredIfPiped` for `None`, calls `read_prompt_from_stdin`, and returns the resulting string.

**Call relations**: Called by `run_exec_session` for resume prompts, by `resolve_root_prompt` for fallback behavior, and by `build_review_request` for custom review instructions.

*Call graph*: calls 1 internal fn (read_prompt_from_stdin); called by 3 (build_review_request, resolve_root_prompt, run_exec_session); 2 external calls (matches!, unreachable!).


##### `resolve_root_prompt`  (lines 1936–1947)

```
fn resolve_root_prompt(prompt_arg: Option<String>) -> String
```

**Purpose**: Resolves the top-level exec prompt, with special support for appending piped stdin as additional context when a positional prompt is already present. This preserves legacy `codex exec prompt < file` semantics.

**Data flow**: Consumes `Option<String>`. If it is a non-dash prompt, it attempts `read_prompt_from_stdin(StdinPromptBehavior::OptionalAppend)`; when stdin text exists, it combines both via `prompt_with_stdin_context`, otherwise returns the prompt unchanged. If the argument is `None` or `"-"`, it delegates to `resolve_prompt`.

**Call relations**: Used by `run_exec_session` on the normal non-resume path to build the initial user text item.

*Call graph*: calls 3 internal fn (prompt_with_stdin_context, read_prompt_from_stdin, resolve_prompt); called by 1 (run_exec_session).


##### `build_review_request`  (lines 1949–1977)

```
fn build_review_request(args: &ReviewArgs) -> anyhow::Result<ReviewRequest>
```

**Purpose**: Constructs a `ReviewRequest` from `ReviewArgs`, enforcing that exactly one review target mode is selected and trimming custom prompt instructions. It supports uncommitted changes, base branch, commit, or custom instructions.

**Data flow**: Reads `ReviewArgs` fields in priority order: `uncommitted`, `base`, `commit` plus optional title, then `prompt`. For custom prompts it resolves stdin-aware prompt text via `resolve_prompt`, trims whitespace, and rejects empties. It returns `Ok(ReviewRequest { target, user_facing_hint: None })` or an `anyhow` error describing the missing/invalid target.

**Call relations**: Called by `run_exec_session` when the CLI selected the `review` subcommand, before converting the resulting core target with `review_target_to_api` for `review/start`.

*Call graph*: calls 1 internal fn (resolve_prompt); called by 1 (run_exec_session); 1 external calls (bail!).
