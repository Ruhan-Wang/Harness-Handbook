# Windows sandbox provisioning and process-launch internals  `stage-14.2.6`

This stage is the Windows-only machinery that prepares a locked-down user account and actually starts commands inside it. It sits between setup and the main work of running a sandboxed process.

At the top, lib.rs is the public front door. unified_exec chooses how to run a command: either the newer elevated path, which talks to a separate helper process with framed IPC (a message stream with clear packet boundaries), or the legacy path, which launches the process directly with restricted tokens. setup.rs and identity.rs make sure the sandbox account and its saved credentials exist, are still valid, and match the requested permissions.

Several files build the safety rules. token.rs creates restricted Windows security tokens, acl.rs edits access-control lists (the allow/deny rules on files and objects), deny_read_acl.rs blocks reads from chosen paths, audit.rs checks risky writable locations, hide_users.rs keeps sandbox accounts less visible, and firewall.rs plus wfp filter specs limit networking.

Finally, spawn_prep.rs, process.rs, desktop.rs, proc_thread_attr.rs, conpty, runner_client, runner_pipe, elevated_impl, and stdio_bridge handle launch details: private desktops, terminal support, pipes, helper handshakes, and connecting the sandboxed program’s input and output back to the app.

## Files in this stage

### Public execution entrypoints
These files define the crate-facing and TUI-facing entrypoints that choose a sandbox execution mode and expose the common API surface.

### `windows-sandbox-rs/src/lib.rs`

`orchestration` · `crate initialization, API surface, and process launch paths`

This file is primarily the crate façade. At the top it defines `WindowsSandboxCancellationToken`, a clonable wrapper around `Arc<dyn Fn() -> bool + Send + Sync>` used by capture backends to poll for cancellation without committing to a specific async/runtime primitive. The crate then conditionally declares many Windows-only modules and re-exports a large public API: ACL helpers, capability SID functions, setup entry points, IPC frame types, helper materialization, identity functions, logging, token creation, and both legacy and elevated sandbox execution functions.

Inside the Windows-only `windows_impl` submodule, the file also contains the legacy capture backend that launches a process directly with restricted tokens and inherited pipes rather than through the elevated command-runner IPC path. `wait_for_process` supports timeout-only waiting or timeout-plus-cancellation polling in 50 ms slices. `setup_stdio_pipes` creates inheritable stdin/stdout/stderr pipes with the correct handle inheritance flags for child process startup.

`run_windows_sandbox_capture_with_filesystem_overrides` is the main legacy implementation: it prepares a spawn context, rejects permission profiles that require elevated deny-read semantics, computes capability roots and security tokens, applies ACL rules, creates the child process with redirected stdio, drains stdout/stderr on background threads, waits for exit/timeout/cancellation, terminates the process if needed, joins readers, logs success/failure, and returns a `CaptureResult`. `run_windows_sandbox_capture` is a convenience wrapper with no extra deny overrides, and `run_windows_sandbox_legacy_preflight` applies ACL setup ahead of time for workspace-write sessions. Non-Windows builds export stub functions that simply error.

#### Function details

##### `WindowsSandboxCancellationToken::new`  (lines 19–23)

```
fn new(is_cancelled: impl Fn() -> bool + Send + Sync + 'static) -> Self
```

**Purpose**: Constructs a cancellation token from an arbitrary predicate closure. This lets callers plug in their own cancellation state without exposing synchronization details to the sandbox crate.

**Data flow**: It takes any `'static` closure implementing `Fn() -> bool + Send + Sync`, wraps it in an `Arc`, stores it in `WindowsSandboxCancellationToken`, and returns the new token.

**Call relations**: It is used by callers and tests to create tokens consumed later by `is_cancelled`, `wait_for_process`, and elevated cancellation polling. The token itself is intentionally lightweight and cloneable.

*Call graph*: called by 1 (legacy_capture_cancellation_is_not_reported_as_timeout); 1 external calls (new).


##### `WindowsSandboxCancellationToken::is_cancelled`  (lines 26–28)

```
fn is_cancelled(&self) -> bool
```

**Purpose**: Evaluates the stored cancellation predicate and reports whether cancellation has been requested. It is the uniform polling API used by sandbox execution code.

**Data flow**: It takes `&self`, invokes the boxed closure stored in `is_cancelled`, and returns the resulting `bool`. No state is mutated.

**Call relations**: It is called by waiting and cancellation helper code in both legacy and elevated backends. This method is the only behavior exposed by the token after construction.


##### `WindowsSandboxCancellationToken::fmt`  (lines 32–35)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Implements `Debug` for the cancellation token without exposing the internal closure. The output is intentionally non-exhaustive.

**Data flow**: It takes `&self` and a formatter, creates a debug struct named `WindowsSandboxCancellationToken`, marks it non-exhaustive, and returns the formatter result.

**Call relations**: This is used implicitly by Rust formatting and diagnostics. It avoids leaking closure internals while still making the type printable in logs or test failures.

*Call graph*: 1 external calls (debug_struct).


##### `windows_impl::wait_for_process`  (lines 379–415)

```
fn wait_for_process(
        process: HANDLE,
        timeout_ms: Option<u64>,
        cancellation: Option<&WindowsSandboxCancellationToken>,
    ) -> WaitOutcome
```

**Purpose**: Waits for a child process to exit, time out, or be cancelled, using either a single blocking wait or a polling loop depending on whether a cancellation token is present. It abstracts the wait policy for the legacy backend.

**Data flow**: It takes a process `HANDLE`, optional timeout in milliseconds, and an optional cancellation token reference. Without cancellation it converts the timeout to a `u32` or `INFINITE`, calls `WaitForSingleObject` once, and returns `WaitOutcome::TimedOut` on `WAIT_TIMEOUT` or `Exited` otherwise. With cancellation it computes an optional deadline, loops checking `cancellation.is_cancelled()`, waits in at-most-50-ms slices, returns `Cancelled` if the token fires, `TimedOut` if the deadline expires, or `Exited` once `WaitForSingleObject` reports completion.

**Call relations**: It is called by `windows_impl::run_windows_sandbox_capture_with_filesystem_overrides` after the child process has been launched. Its polling behavior mirrors the elevated backend's cancellation responsiveness while staying in the legacy direct-process model.

*Call graph*: 3 external calls (from_millis, now, WaitForSingleObject).


##### `windows_impl::setup_stdio_pipes`  (lines 417–443)

```
fn setup_stdio_pipes() -> io::Result<PipeHandles>
```

**Purpose**: Creates three anonymous pipes for child stdin, stdout, and stderr and marks the correct ends inheritable for process creation. It packages the raw Win32 handle setup needed before launching the child.

**Data flow**: It allocates six `HANDLE` variables, calls `CreatePipe` three times, and then calls `SetHandleInformation` to mark the child's stdin read end and stdout/stderr write ends as inheritable. On any Win32 failure it converts `GetLastError()` into an `io::Error`; on success it returns the three `(read, write)` handle pairs.

**Call relations**: It is used only by `windows_impl::run_windows_sandbox_capture_with_filesystem_overrides` before `create_process_as_user`. The returned handles are then split between parent and child responsibilities.

*Call graph*: 5 external calls (from_raw_os_error, null_mut, GetLastError, SetHandleInformation, CreatePipe).


##### `windows_impl::run_windows_sandbox_capture`  (lines 453–477)

```
fn run_windows_sandbox_capture(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
        codex_home: &Path,
        command: Vec<String>,
        cwd: &Path
```

**Purpose**: Provides the simple legacy capture API without explicit filesystem deny overrides. It forwards all work to the more general override-aware implementation.

**Data flow**: It takes permission profile, workspace roots, `codex_home`, command, cwd, environment map, timeout, cancellation token, and desktop flag, then calls `run_windows_sandbox_capture_with_filesystem_overrides` with empty additional deny-read and deny-write slices and returns its `CaptureResult`.

**Call relations**: This is the public convenience entry point for the legacy backend. It exists so most callers do not need to pass empty override lists explicitly.

*Call graph*: 1 external calls (run_windows_sandbox_capture_with_filesystem_overrides).


##### `windows_impl::run_windows_sandbox_capture_with_filesystem_overrides`  (lines 480–678)

```
fn run_windows_sandbox_capture_with_filesystem_overrides(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
        codex_home: &Path,
        command: Vec<S
```

**Purpose**: Runs a command under the legacy Windows sandbox backend using restricted tokens, ACL preparation, redirected stdio pipes, timeout/cancellation handling, and in-memory output capture. It is the main non-elevated execution path in the crate root.

**Data flow**: It takes the full launch configuration plus additional deny-read and deny-write path slices. The function converts override paths from `AbsolutePathBuf` to `Vec<PathBuf>`, prepares a common spawn context with `prepare_legacy_spawn_context`, extracts permissions/current dir/log dir/write-capability mode, and rejects profiles that require elevated deny-read semantics or restricted read-only access. It computes capability roots with `legacy_session_capability_roots`, prepares security tokens/SIDs with `prepare_legacy_session_security`, grants null-device access for workspace-write mode, and applies ACL rules with `apply_legacy_session_acl_rules`. It then creates stdio pipes via `setup_stdio_pipes`, launches the child with `create_process_as_user`, closes the parent-side handles that should not remain open, spawns two reader threads that repeatedly `ReadFile` stdout and stderr into `Vec<u8>`, waits for process completion via `wait_for_process`, and either reads the exit code or terminates the process on timeout/cancellation. After closing process/thread/token handles and joining reader threads, it receives the buffered stdout/stderr from channels, maps timeout to exit code `192` (`128 + 64`), logs success or failure, and returns `CaptureResult { exit_code, stdout, stderr, timed_out }`.

**Call relations**: This function is called by the simpler `run_windows_sandbox_capture` wrapper and serves callers that still use the legacy backend. It orchestrates spawn preparation, ACL application, process creation, waiting, forced termination, and output collection by delegating to many lower-level modules.

*Call graph*: calls 8 internal fn (log_failure, log_success, create_process_as_user, allow_null_device_for_workspace_write, apply_legacy_session_acl_rules, legacy_session_capability_roots, prepare_legacy_session_security, prepare_legacy_spawn_context); 11 external calls (bail!, format!, matches!, spawn, is_empty, iter, setup_stdio_pipes, wait_for_process, CloseHandle, GetExitCodeProcess (+1 more)).


##### `windows_impl::run_windows_sandbox_legacy_preflight`  (lines 680–717)

```
fn run_windows_sandbox_legacy_preflight(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
        codex_home: &Path,
        cwd: &Path,
        env_map: &H
```

**Purpose**: Performs the ACL preflight needed for legacy workspace-write sessions without actually launching a process. It is a preparatory step that ensures capability-based ACLs are in place.

**Data flow**: It takes a permission profile, workspace roots, `codex_home`, cwd, and environment map. The function tries to resolve `ResolvedWindowsSandboxPermissions`; unsupported profiles simply return `Ok(())`. If the permissions do not use write capabilities for the cwd it also returns early. Otherwise it ensures `codex_home` exists, computes capability roots from the cwd/env, derives write-root capability SID strings with `root_capability_sids`, and applies ACL rules with `apply_legacy_session_acl_rules` using only those write-root SIDs and no readonly SID.

**Call relations**: It is called by higher-level preflight code before a legacy session may be launched. Its role is narrower than full capture: it only prepares filesystem ACL state and exits.

*Call graph*: calls 5 internal fn (try_from_permission_profile_for_workspace_roots, ensure_codex_home_exists, apply_legacy_session_acl_rules, legacy_session_capability_roots, root_capability_sids); 1 external calls (to_path_buf).


##### `windows_impl::tests::workspace_profile`  (lines 727–734)

```
fn workspace_profile(network_policy: NetworkSandboxPolicy) -> PermissionProfile
```

**Purpose**: Builds a workspace-write `PermissionProfile` with a specified network policy for use in tests. It centralizes the exact profile construction used by the network-block assertions.

**Data flow**: It takes a `NetworkSandboxPolicy` and returns `PermissionProfile::workspace_write_with(&[], network_policy, false, false)`. No external state is read or written.

**Call relations**: It is a local test helper used by the network-block tests below. By constructing profiles in one place, the tests stay focused on permission interpretation rather than profile syntax.

*Call graph*: calls 1 internal fn (workspace_write_with).


##### `windows_impl::tests::should_apply_network_block`  (lines 736–743)

```
fn should_apply_network_block(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Resolves a permission profile into Windows sandbox permissions and asks whether network blocking should be applied. It is a test helper for policy interpretation.

**Data flow**: It takes a `PermissionProfile`, converts it with `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots(permission_profile, &[])`, unwraps the result, and returns `should_apply_network_block()` from the resolved permissions.

**Call relations**: It is used by the three network-policy tests to avoid repeating resolution boilerplate. This helper keeps the assertions focused on expected boolean outcomes.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots).


##### `windows_impl::tests::applies_network_block_when_access_is_disabled`  (lines 746–750)

```
fn applies_network_block_when_access_is_disabled()
```

**Purpose**: Asserts that a workspace-write profile with restricted network policy results in network blocking. It verifies one expected permission interpretation.

**Data flow**: The test constructs a restricted workspace profile via `workspace_profile(NetworkSandboxPolicy::Restricted)`, passes it to `should_apply_network_block`, and asserts that the result is true.

**Call relations**: It depends on the two local test helpers above. This test documents the intended mapping from restricted network policy to sandbox enforcement.

*Call graph*: 1 external calls (assert!).


##### `windows_impl::tests::skips_network_block_when_access_is_allowed`  (lines 753–757)

```
fn skips_network_block_when_access_is_allowed()
```

**Purpose**: Asserts that a workspace-write profile with enabled network policy does not trigger network blocking. It verifies the permissive branch of policy interpretation.

**Data flow**: The test constructs an enabled workspace profile, evaluates it with `should_apply_network_block`, and asserts that the result is false.

**Call relations**: It complements the restricted-policy test and uses the same local helpers. Together they pin down the expected behavior of `should_apply_network_block()`.

*Call graph*: 1 external calls (assert!).


##### `windows_impl::tests::applies_network_block_for_read_only`  (lines 760–762)

```
fn applies_network_block_for_read_only()
```

**Purpose**: Asserts that a read-only permission profile still results in network blocking. This captures a policy rule independent of workspace-write mode.

**Data flow**: The test creates `PermissionProfile::read_only()`, passes it to `should_apply_network_block`, and asserts that the result is true.

**Call relations**: It extends the network-policy coverage beyond workspace-write profiles. The test ensures read-only mode remains treated as network-restricted.

*Call graph*: 1 external calls (assert!).


##### `windows_impl::tests::legacy_preflight_skips_profiles_without_managed_filesystem_permissions`  (lines 765–781)

```
fn legacy_preflight_skips_profiles_without_managed_filesystem_permissions()
```

**Purpose**: Verifies that legacy preflight is a no-op for permission profiles that do not map to managed filesystem permissions. Unsupported profiles should not fail preflight.

**Data flow**: The test iterates over `PermissionProfile::Disabled` and `PermissionProfile::External { network: Restricted }`, calls `run_windows_sandbox_legacy_preflight` with empty roots and trivial paths/env, and asserts that each call succeeds.

**Call relations**: It directly exercises the early-return branch in `run_windows_sandbox_legacy_preflight` when permission resolution fails or is irrelevant. This keeps preflight tolerant for unsupported profile kinds.

*Call graph*: 3 external calls (new, new, run_windows_sandbox_legacy_preflight).


##### `stub::run_windows_sandbox_capture`  (lines 804–816)

```
fn run_windows_sandbox_capture(
        _permission_profile: &PermissionProfile,
        _workspace_roots: &[AbsolutePathBuf],
        _codex_home: &Path,
        _command: Vec<String>,
        _cwd:
```

**Purpose**: Provides the non-Windows stub for the legacy capture API. It makes unsupported-platform behavior explicit at runtime.

**Data flow**: It accepts the full legacy capture argument list but ignores all inputs and immediately returns an error via `bail!` stating that the Windows sandbox is only available on Windows.

**Call relations**: This function is exported only on non-Windows targets. It is the terminal implementation for callers that compile against the crate cross-platform.

*Call graph*: 1 external calls (bail!).


##### `stub::run_windows_sandbox_legacy_preflight`  (lines 818–826)

```
fn run_windows_sandbox_legacy_preflight(
        _permission_profile: &PermissionProfile,
        _workspace_roots: &[AbsolutePathBuf],
        _codex_home: &Path,
        _cwd: &Path,
        _env_ma
```

**Purpose**: Provides the non-Windows stub for legacy ACL preflight. Like the capture stub, it fails immediately on unsupported platforms.

**Data flow**: It accepts the preflight arguments, ignores them, and returns a `bail!` error indicating that the Windows sandbox is only available on Windows.

**Call relations**: It is the non-Windows counterpart to `windows_impl::run_windows_sandbox_legacy_preflight`. No further work is delegated.

*Call graph*: 1 external calls (bail!).


### `windows-sandbox-rs/src/unified_exec/mod.rs`

`orchestration` · `session spawn dispatch`

This module is intentionally small: it exposes a single request struct, `WindowsSandboxSessionRequest<'a>`, that bundles all fully resolved launch inputs needed by either backend. The struct carries the permission profile, workspace roots, codex-home path, command vector, cwd, environment map, selected `WindowsSandboxLevel`, proxy enforcement flag, timeout, optional read/write root overrides, deny-path overrides, TTY and stdin-open flags, and whether to use a private desktop.

The main dispatcher, `spawn_windows_sandbox_session_for_level`, chooses the elevated backend whenever proxy enforcement is enabled or the configured sandbox level is `WindowsSandboxLevel::Elevated`; otherwise it chooses the legacy backend. The two remaining public functions are thin forwarding wrappers that preserve a stable module-level API while delegating directly into `backends::legacy` and `backends::elevated`. In tests, several shared backend helpers are re-exported from `windows_common` so the test module can exercise them without reaching into private backend paths. The design keeps backend selection logic centralized while leaving all token, ACL, process, and IPC details in sibling modules.

#### Function details

##### `spawn_windows_sandbox_session_for_level`  (lines 45–87)

```
async fn spawn_windows_sandbox_session_for_level(
    request: WindowsSandboxSessionRequest<'_>,
) -> Result<SpawnedProcess>
```

**Purpose**: Selects the appropriate Windows sandbox backend for a fully specified request and awaits the resulting session spawn.

**Data flow**: Consumes a `WindowsSandboxSessionRequest<'_>`. It reads `proxy_enforced` and `windows_sandbox_level`; if either requires the elevated path, it forwards all relevant fields into `spawn_windows_sandbox_session_elevated_for_permission_profile(...).await`, otherwise it forwards the legacy-compatible subset into `spawn_windows_sandbox_session_legacy(...).await`. It returns the resulting `Result<SpawnedProcess>` unchanged.

**Call relations**: This is the module's main public dispatcher. It sits above both backend wrapper functions and encodes the policy that proxy enforcement forces the elevated backend regardless of the nominal sandbox level.

*Call graph*: calls 2 internal fn (spawn_windows_sandbox_session_elevated_for_permission_profile, spawn_windows_sandbox_session_legacy); 1 external calls (matches!).


##### `spawn_windows_sandbox_session_legacy`  (lines 90–119)

```
async fn spawn_windows_sandbox_session_legacy(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    codex_home: &Path,
    command: Vec<String>,
    cwd: &Path,
```

**Purpose**: Public wrapper that forwards a legacy-compatible launch request into the legacy backend implementation.

**Data flow**: Accepts the legacy backend's argument set—permission profile, workspace roots, codex home, command, cwd, env map, timeout, deny-path overrides, TTY flag, stdin-open flag, and desktop choice—and simply awaits `backends::legacy::spawn_windows_sandbox_session_legacy(...)`, returning its `Result<SpawnedProcess>`.

**Call relations**: It is called by `spawn_windows_sandbox_session_for_level` when the request does not require elevation. Its role is API surface stabilization rather than adding logic of its own.

*Call graph*: calls 1 internal fn (spawn_windows_sandbox_session_legacy); called by 1 (spawn_windows_sandbox_session_for_level).


##### `spawn_windows_sandbox_session_elevated_for_permission_profile`  (lines 122–159)

```
async fn spawn_windows_sandbox_session_elevated_for_permission_profile(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    codex_home: &Path,
    command: Vec<Str
```

**Purpose**: Public wrapper that forwards a full elevated launch request into the elevated backend implementation.

**Data flow**: Accepts the elevated backend's full argument set, including proxy enforcement and read/write root overrides, then awaits `backends::elevated::spawn_windows_sandbox_session_elevated_for_permission_profile(...)` and returns the resulting `Result<SpawnedProcess>`.

**Call relations**: It is called by `spawn_windows_sandbox_session_for_level` whenever elevation is required. Like the legacy wrapper, it mainly exposes the backend through the module's public API.

*Call graph*: calls 1 internal fn (spawn_windows_sandbox_session_elevated_for_permission_profile); called by 1 (spawn_windows_sandbox_session_for_level).


### `windows-sandbox-rs/src/unified_exec/backends/elevated.rs`

`orchestration` · `sandbox session spawn and runner handshake`

This backend is used when the Windows sandbox must run through the elevated command-runner path, either because the sandbox level explicitly requests it or because proxy enforcement requires it. The file first resolves permission inputs into `ResolvedWindowsSandboxPermissions`, then asks `prepare_elevated_spawn_context_for_permissions` to build the elevated environment: sandbox home, capability SID strings, credentials, and optional log directory. From that it constructs an `ipc_framed::SpawnRequest` carrying command, cwd, env, permission profile, workspace roots, codex-home paths, capability SIDs, timeout, TTY mode, stdin-open flag, and desktop choice.

Runner startup is intentionally offloaded to `spawn_runner_transport_task`, which wraps the blocking handshake in `tokio::task::spawn_blocking`. If the first handshake fails with stale sandbox credentials, the backend refreshes credentials with `refresh_logon_sandbox_creds` and retries once. After a successful transport handshake, the code converts the transport into read/write files and wires them into the shared Windows IPC helpers: a blocking frame writer, a stdin-to-`Message::Stdin` encoder, a stdout reader that decodes `Message::Output` and `Message::Exit`, and an optional resize closure for TTY sessions. Termination is implemented by sending a framed `Message::Terminate`. Finally, everything is wrapped into a `ProcessDriver` and normalized into a `SpawnedProcess` via `finish_driver_spawn`, which also closes stdin immediately when streaming input was disabled.

#### Function details

##### `spawn_runner_transport_task`  (lines 30–48)

```
async fn spawn_runner_transport_task(
    codex_home: PathBuf,
    cwd: PathBuf,
    sandbox_creds: SandboxCreds,
    logs_base_dir: Option<PathBuf>,
    spawn_request: SpawnRequest,
) -> Result<Runne
```

**Purpose**: Runs the blocking runner transport handshake on a dedicated blocking thread and converts join failures into `anyhow` errors.

**Data flow**: Takes owned `PathBuf`s for `codex_home` and `cwd`, `SandboxCreds`, optional `logs_base_dir`, and a `SpawnRequest`. It moves them into `tokio::task::spawn_blocking`, calls `spawn_runner_transport(&codex_home, &cwd, &sandbox_creds, logs_base_dir.as_deref(), spawn_request)`, awaits the blocking task, maps task-join failure into an `anyhow` error string, and returns the resulting `RunnerTransport`.

**Call relations**: This helper is called by `spawn_windows_sandbox_session_elevated_for_permission_profile` for the initial runner handshake and for the stale-credentials retry path. It isolates the synchronous transport setup from the async orchestration function.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 1 external calls (spawn_blocking).


##### `spawn_windows_sandbox_session_elevated_for_permission_profile`  (lines 51–196)

```
async fn spawn_windows_sandbox_session_elevated_for_permission_profile(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    codex_home: &Path,
    command: Vec<Str
```

**Purpose**: Builds and launches an elevated Windows sandbox session backed by the runner IPC protocol. It resolves permissions, prepares elevated context, retries on stale credentials, and returns a live `SpawnedProcess` abstraction.

**Data flow**: Receives the full launch request: permission profile, workspace roots, codex home, command, cwd, mutable environment map, proxy flag, timeout, root overrides, deny-path overrides, TTY flag, stdin-open flag, and desktop choice. It converts deny-path overrides into owned `PathBuf` vectors, resolves permissions, prepares elevated spawn context, and assembles a `SpawnRequest`. It then attempts `spawn_runner_transport_task`; if the error matches `is_stale_sandbox_creds_error`, it refreshes credentials and retries once. After obtaining the transport, it splits it into pipe files, creates Tokio channels for stdin/stdout/stderr and exit, starts the shared pipe writer/stdin writer/stdout reader helpers, builds a terminate closure that sends `Message::Terminate`, optionally builds a resize closure for TTY mode, wraps everything in `ProcessDriver`, and returns `finish_driver_spawn(...)`.

**Call relations**: This is the elevated backend entrypoint invoked by the higher-level unified-exec dispatcher. It orchestrates permission resolution and spawn preparation before delegating stream framing to `windows_common` helpers and transport creation to `spawn_runner_transport_task`.

*Call graph*: calls 10 internal fn (is_stale_sandbox_creds_error, refresh_logon_sandbox_creds, try_from_permission_profile_for_workspace_roots, prepare_elevated_spawn_context_for_permissions, spawn_runner_transport_task, finish_driver_spawn, make_runner_resizer, start_runner_pipe_writer, start_runner_stdin_writer, start_runner_stdout_reader); called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 6 external calls (new, clone, to_path_buf, clone, iter, to_vec).


### `windows-sandbox-rs/src/unified_exec/backends/legacy.rs`

`orchestration` · `sandbox session spawn, process supervision, and teardown`

This file contains the direct-process backend used when the sandbox can run without the elevated runner. Its top-level flow first prepares a legacy spawn context, rejects unsupported cases up front (restricted read-only mode and deny-read overrides), computes capability roots, prepares legacy token/security state, allows null-device access when workspace-write capabilities are in use, and applies ACL rules to relevant filesystem paths.

Process creation is split by `tty`. For TTY sessions, `spawn_legacy_process` calls `spawn_conpty_process_as_user`, captures the ConPTY handle for later resizing, starts one output reader thread on the PTY output pipe, and starts an input writer task that normalizes LF to CRLF. For non-TTY sessions, it calls `spawn_process_with_pipes`, requires separate stderr handles/channels, starts independent stdout and stderr reader threads, and combines them under a join thread. Input writing is handled by a blocking Tokio task that drains a Tokio channel and writes all bytes to the Windows handle with `WriteFile`, closing the handle when done.

A detached wait thread enforces optional timeout via `WaitForSingleObject`; on timeout it calls `TerminateProcess`. That thread also drops ConPTY ownership, closes the token handle, and calls `finalize_exit`, which waits for process completion, joins output readers, sends the exit code, closes remaining process/thread handles, and logs success or failure. The returned `ProcessDriver` includes a terminator closure and, for TTY sessions, a resizer closure that calls `ResizePseudoConsole`.

#### Function details

##### `spawn_legacy_process`  (lines 59–139)

```
fn spawn_legacy_process(
    h_token: HANDLE,
    command: &[String],
    cwd: &Path,
    env_map: &HashMap<String, String>,
    use_private_desktop: bool,
    tty: bool,
    stdin_open: bool,
    std
```

**Purpose**: Launches the actual sandboxed process under the legacy backend, choosing either ConPTY or ordinary pipes based on `tty`. It packages all handles and background workers needed for later supervision.

**Data flow**: Accepts a restricted token handle, command/cwd/env, desktop and TTY flags, stdin-open flag, stdout/stderr broadcast senders, a stdin `mpsc::Receiver<Vec<u8>>`, and optional log directory. In TTY mode it calls `spawn_conpty_process_as_user`, extracts PTY input/output handles, starts `spawn_output_reader` for PTY output and `spawn_input_writer` with newline normalization, and returns `LegacyProcessHandles` containing the process info, ConPTY handle/owner, writer task, and token handle. In non-TTY mode it calls `spawn_process_with_pipes`, validates that separate stderr plumbing exists, starts stdout and stderr readers plus a join thread, starts `spawn_input_writer` without normalization, and returns the assembled handle bundle including any desktop object.

**Call relations**: This helper is called only by `spawn_windows_sandbox_session_legacy` after security preparation succeeds. It delegates the OS-specific spawn mechanics to either `spawn_conpty_process_as_user` or `spawn_process_with_pipes` and standardizes their outputs for the rest of the backend.

*Call graph*: calls 4 internal fn (spawn_conpty_process_as_user, spawn_process_with_pipes, spawn_input_writer, spawn_output_reader); called by 1 (spawn_windows_sandbox_session_legacy); 2 external calls (bail!, spawn).


##### `spawn_output_reader`  (lines 141–148)

```
fn spawn_output_reader(
    output_read: HANDLE,
    output_tx: broadcast::Sender<Vec<u8>>,
) -> std::thread::JoinHandle<()>
```

**Purpose**: Starts a thread that reads bytes from a Windows handle and republishes each chunk onto a Tokio broadcast channel.

**Data flow**: Takes a raw `HANDLE` and a `broadcast::Sender<Vec<u8>>`, then calls `read_handle_loop(output_read, move |chunk| { let _ = output_tx.send(chunk.to_vec()); })`. Each incoming borrowed chunk is copied into an owned `Vec<u8>` before broadcast.

**Call relations**: It is used by `spawn_legacy_process` for PTY output and for non-TTY stdout/stderr pipes. Its role is to bridge blocking Windows handle reads into the channel-based `ProcessDriver` interface.

*Call graph*: calls 1 internal fn (read_handle_loop); called by 1 (spawn_legacy_process).


##### `spawn_input_writer`  (lines 150–176)

```
fn spawn_input_writer(
    input_write: Option<HANDLE>,
    mut writer_rx: mpsc::Receiver<Vec<u8>>,
    normalize_newlines: bool,
) -> tokio::task::JoinHandle<()>
```

**Purpose**: Starts a blocking task that drains stdin chunks from a Tokio channel and writes them to an optional Windows handle, optionally normalizing TTY newlines.

**Data flow**: Accepts an `Option<HANDLE>`, an `mpsc::Receiver<Vec<u8>>`, and a `normalize_newlines` flag. Inside `spawn_blocking`, it tracks `previous_was_cr`, repeatedly receives chunks with `blocking_recv`, skips writes entirely if the handle is absent, optionally transforms bytes through `normalize_windows_tty_input`, and writes them with `write_all_handle`. On write failure it breaks the loop, and at the end closes the input handle with `CloseHandle` if one existed.

**Call relations**: It is called by `spawn_legacy_process` in both TTY and non-TTY branches. It delegates actual partial-write handling to `write_all_handle` and is the sink behind the session's stdin channel.

*Call graph*: called by 1 (spawn_legacy_process); 1 external calls (spawn_blocking).


##### `write_all_handle`  (lines 178–200)

```
fn write_all_handle(handle: HANDLE, mut bytes: &[u8]) -> Result<()>
```

**Purpose**: Performs a complete write of a byte slice to a Windows handle, retrying until all bytes are consumed or an error occurs.

**Data flow**: Takes a raw `HANDLE` and a borrowed byte slice. It loops while bytes remain, calling `WriteFile` with the current slice and a mutable `written` count. If `WriteFile` fails it returns an `anyhow` error containing `GetLastError`; if it reports success but writes zero bytes it bails; otherwise it advances the slice by the number of bytes written and eventually returns `Ok(())`.

**Call relations**: This is the low-level write primitive used only by `spawn_input_writer`. It encapsulates the partial-write semantics of `WriteFile` so the higher-level writer task can treat each stdin chunk as all-or-nothing.

*Call graph*: 5 external calls (anyhow!, bail!, null_mut, GetLastError, WriteFile).


##### `finalize_exit`  (lines 203–243)

```
fn finalize_exit(
    exit_tx: oneshot::Sender<i32>,
    process_handle: Arc<StdMutex<Option<HANDLE>>>,
    thread_handle: HANDLE,
    output_join: std::thread::JoinHandle<()>,
    logs_base_dir: Opti
```

**Purpose**: Completes process shutdown bookkeeping after the wait thread decides the process is done or has been terminated. It publishes the exit code, closes handles, joins output readers, and records success/failure logs.

**Data flow**: Receives the exit-code oneshot sender, an `Arc<Mutex<Option<HANDLE>>>` for the process handle, the thread handle, the output-reader join handle, optional log directory, and the original command vector. It locks the process handle, waits indefinitely with `WaitForSingleObject`, reads the exit code with `GetExitCodeProcess`, joins the output thread, sends the exit code over the oneshot, closes the thread handle if valid, takes and closes the process handle if still present, and finally calls `log_success` for exit code 0 or `log_failure` with `exit code {exit_code}` otherwise.

**Call relations**: It is invoked from the detached supervision thread created by `spawn_windows_sandbox_session_legacy` after timeout handling, ConPTY cleanup, and token-handle cleanup. It is the final teardown step before the session's exit receiver resolves.

*Call graph*: calls 2 internal fn (log_failure, log_success); 6 external calls (join, send, format!, CloseHandle, GetExitCodeProcess, WaitForSingleObject).


##### `resize_conpty_handle`  (lines 245–269)

```
fn resize_conpty_handle(hpc: &Arc<StdMutex<Option<HANDLE>>>, size: TerminalSize) -> Result<()>
```

**Purpose**: Resizes an active ConPTY pseudo-console to the requested terminal dimensions.

**Data flow**: Takes an `Arc<StdMutex<Option<HANDLE>>>` holding the ConPTY handle and a `TerminalSize`. It locks the mutex, errors if the lock is poisoned or the handle has already been cleared, then calls `ResizePseudoConsole` with a `COORD { X: cols as i16, Y: rows as i16 }`. It returns `Ok(())` on HRESULT 0 and an `anyhow` error otherwise.

**Call relations**: This helper is wrapped into the `ProcessDriver.resizer` closure by `spawn_windows_sandbox_session_legacy` only for TTY sessions. It gives callers a backend-neutral resize API while preserving ConPTY-specific state internally.

*Call graph*: 2 external calls (anyhow!, ResizePseudoConsole).


##### `spawn_windows_sandbox_session_legacy`  (lines 272–443)

```
async fn spawn_windows_sandbox_session_legacy(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    codex_home: &Path,
    command: Vec<String>,
    cwd: &Path,
```

**Purpose**: Top-level legacy backend entrypoint that prepares security, launches the process, supervises timeout/termination, and returns a unified `SpawnedProcess`.

**Data flow**: Accepts the full legacy launch request: permission profile, workspace roots, codex home, command, cwd, mutable env map, timeout, deny-path overrides, TTY flag, stdin-open flag, and desktop choice. It calls `prepare_legacy_spawn_context`, rejects unsupported permission combinations, converts deny-write overrides to `PathBuf`s, computes capability roots, prepares token/security state, enables null-device access if needed, and applies ACL rules. It then creates stdin/stdout/stderr/exit channels, calls `spawn_legacy_process`, and on spawn failure closes `security.h_token` before returning the error. On success it wraps the process handle and optional ConPTY handle in `Arc<Mutex<Option<HANDLE>>>`, spawns a supervision thread that waits with timeout, terminates on timeout, clears the ConPTY handle, drops ConPTY ownership, closes the token handle, and calls `finalize_exit`. It also builds a terminator closure that calls `TerminateProcess`, optionally builds a resizer closure via `resize_conpty_handle`, constructs a `ProcessDriver`, and returns `finish_driver_spawn(driver, stdin_open)`.

**Call relations**: This is the backend entrypoint called by the unified-exec dispatcher for non-elevated sessions. It orchestrates all helpers in this file plus the spawn-preparation and ACL/token modules to produce the same session abstraction as the elevated backend.

*Call graph*: calls 7 internal fn (allow_null_device_for_workspace_write, apply_legacy_session_acl_rules, legacy_session_capability_roots, prepare_legacy_session_security, prepare_legacy_spawn_context, spawn_legacy_process, finish_driver_spawn); called by 1 (spawn_windows_sandbox_session_legacy); 9 external calls (clone, new, new, new, bail!, spawn, is_empty, iter, CloseHandle).


### `tui/src/windows_sandbox.rs`

`domain_logic` · `permission setup and sandbox readiness handling`

This module is a thin adapter around configuration and the `codex_windows_sandbox` crate while setup still runs in the local TUI process. `level_from_config` is the cross-platform decision function: it inspects `config.permissions.windows_sandbox_mode` first, mapping explicit TOML values to `WindowsSandboxLevel::{Elevated, RestrictedToken}`. If no explicit mode is set, it falls back to feature flags, preferring `Feature::WindowsSandboxElevated`, then `Feature::WindowsSandbox`, and otherwise disabling sandboxing. That precedence means explicit config overrides feature defaults.

The remaining helpers are platform-gated. On Windows, `sandbox_setup_is_complete` is re-exported directly from `codex_windows_sandbox`; on non-Windows builds, a stub always returns `false`, making readiness checks safely pessimistic. `run_elevated_setup` resolves a `PermissionProfile` plus workspace roots into concrete sandbox permissions and invokes the external elevated setup routine with `proxy_enforced: false` and default root overrides. `elevated_setup_failure_details` and `elevated_setup_failure_metric_name` inspect an `anyhow::Error` for structured setup-failure information, extracting a sanitized code/message pair for telemetry and distinguishing user-canceled helper launches from generic failures.

`grant_read_root_non_elevated` performs strict local validation before refreshing sandbox setup with one extra readable root: the path must be absolute, exist, and be a directory. It canonicalizes the path before passing it onward and returns that canonical path, ensuring callers and downstream setup logic operate on a normalized directory identity.

#### Function details

##### `level_from_config`  (lines 23–35)

```
fn level_from_config(config: &Config) -> WindowsSandboxLevel
```

**Purpose**: Determines the effective Windows sandbox level from explicit configuration and feature flags.

**Data flow**: It reads `config.permissions.windows_sandbox_mode` and `config.features`. Explicit `Elevated` maps to `WindowsSandboxLevel::Elevated`, explicit `Unelevated` maps to `RestrictedToken`. If no explicit mode is set, it checks whether `Feature::WindowsSandboxElevated` or `Feature::WindowsSandbox` is enabled and returns the corresponding level; otherwise it returns `Disabled`.

**Call relations**: This function is consulted broadly by runtime flows that need to know the active sandbox policy, including startup, command dispatch, permission UI, and setup-required checks.

*Call graph*: called by 11 (run, propagate_windows_sandbox_turn_context, handle_event, open_permissions_popup, permission_mode_actions, builtin_command_flags, dispatch_command, elevated_windows_sandbox_setup_required, maybe_prompt_windows_sandbox_enable, new (+1 more)).


##### `sandbox_setup_is_complete`  (lines 41–43)

```
fn sandbox_setup_is_complete(_codex_home: &Path) -> bool
```

**Purpose**: Reports whether Windows sandbox setup has already been completed for the given Codex home, or always false on non-Windows builds.

**Data flow**: On Windows targets this name re-exports the implementation from `codex_windows_sandbox`. On non-Windows targets, the local stub ignores `_codex_home` and returns `false`.

**Call relations**: This helper gives higher-level code a uniform symbol to call regardless of platform, with non-Windows builds taking the conservative no-setup-complete path.


##### `run_elevated_setup`  (lines 46–67)

```
fn run_elevated_setup(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
    codex_home: &Path,
) -> a
```

**Purpose**: Builds resolved sandbox permissions from the current permission profile and invokes the elevated Windows sandbox setup flow.

**Data flow**: It takes a `PermissionProfile`, workspace roots, command working directory, environment map, and Codex home path. It first calls `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots` to derive concrete permissions, then passes those permissions plus the other inputs into `codex_windows_sandbox::run_elevated_setup` inside a `SandboxSetupRequest` with `proxy_enforced: false` and `SetupRootOverrides::default()`. It returns `anyhow::Result<()>`.

**Call relations**: This Windows-only helper is the TUI-owned bridge into the external elevated setup implementation while setup still happens locally rather than over RPC.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 2 external calls (run_elevated_setup, default).


##### `elevated_setup_failure_details`  (lines 70–76)

```
fn elevated_setup_failure_details(err: &anyhow::Error) -> Option<(String, String)>
```

**Purpose**: Extracts a telemetry-friendly failure code and sanitized message from an elevated setup error when structured setup metadata is present.

**Data flow**: It takes `&anyhow::Error`, calls `codex_windows_sandbox::extract_setup_failure`, and if that succeeds returns `Some((failure.code.as_str().to_string(), sanitize_setup_metric_tag_value(&failure.message)))`. If no structured setup failure is embedded, it returns `None`.

**Call relations**: This helper is used by error-reporting paths that want richer metrics or logs for elevated setup failures without exposing raw unsanitized messages.

*Call graph*: 2 external calls (extract_setup_failure, sanitize_setup_metric_tag_value).


##### `elevated_setup_failure_metric_name`  (lines 79–90)

```
fn elevated_setup_failure_metric_name(err: &anyhow::Error) -> &'static str
```

**Purpose**: Chooses the metric name to emit for an elevated setup error, distinguishing user cancellation from other failures.

**Data flow**: It inspects the provided `anyhow::Error` with `extract_setup_failure`. If a structured failure exists and its code is `SetupErrorCode::OrchestratorHelperLaunchCanceled`, it returns `"codex.windows_sandbox.elevated_setup_canceled"`; otherwise it returns `"codex.windows_sandbox.elevated_setup_failure"`.

**Call relations**: This helper complements `elevated_setup_failure_details` in telemetry/reporting flows by collapsing detailed failure information into one of two metric buckets.

*Call graph*: 1 external calls (extract_setup_failure).


##### `grant_read_root_non_elevated`  (lines 93–122)

```
fn grant_read_root_non_elevated(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
    codex_home: &Pa
```

**Purpose**: Validates and grants one additional readable directory root through the non-elevated sandbox refresh path.

**Data flow**: It takes the current `PermissionProfile`, workspace roots, command cwd, environment map, Codex home, and a candidate `read_root`. It first validates that `read_root` is absolute, exists, and is a directory, returning `anyhow::bail!` errors otherwise. It then canonicalizes the directory with `dunce::canonicalize`, calls `run_setup_refresh_with_extra_read_roots` with a one-element vector containing that canonical path and `proxy_enforced` set to false, and returns the canonicalized `PathBuf` on success.

**Call relations**: This Windows-only helper is used when the running TUI needs to extend sandbox read access without going through the elevated setup path, and its preflight checks ensure downstream setup receives a normalized, valid directory.

*Call graph*: 7 external calls (exists, is_absolute, is_dir, bail!, run_setup_refresh_with_extra_read_roots, canonicalize, vec!).


### Provisioning state and security primitives
These files establish setup-time state, identity, errors, and the low-level ACL and token machinery used to provision sandbox credentials and permissions.

### `windows-sandbox-rs/src/setup_error.rs`

`data_model` · `error reporting and metrics emission`

This file is the error model for setup orchestration and the elevated helper. `SetupErrorCode` enumerates both orchestrator-side failures (payload serialization, elevation checks, helper launch, stale or missing reports) and helper-side failures (user provisioning, DPAPI, firewall, ACL locking, and unknown fallback). `as_str` provides stable snake_case identifiers intended for metric tags.

`SetupErrorReport` is the serialized on-disk form written to `CODEX_HOME/.sandbox/setup_error.json`, while `SetupFailure` is the in-memory error type exposed through `anyhow`. The helper constructors make it easy to create structured failures directly (`SetupFailure::new`, `failure`) or reconstruct them from a persisted report (`from_report`). `extract_failure` lets tests and callers recover the typed failure from an `anyhow::Error`.

The file also owns report-file I/O. `setup_error_path` centralizes the location, `clear_setup_error_report` removes stale reports while treating missing files as success, `write_setup_error_report` ensures the sandbox directory exists and writes pretty JSON, and `read_setup_error_report` returns `Ok(None)` when the file is absent but adds path context to real read/parse failures.

Finally, metric sanitization is intentionally privacy-aware. `sanitize_setup_metric_tag_value` first redacts username path segments from the message using `USERNAME` and `USER`, replacing matching path components with `<user>`, then passes the result through the generic metric-tag sanitizer. The redaction logic preserves separators and handles both Windows and non-Windows case sensitivity rules.

#### Function details

##### `SetupErrorCode::as_str`  (lines 78–111)

```
fn as_str(self) -> &'static str
```

**Purpose**: Maps each structured setup error code to its stable snake_case string representation. These strings are intended for logs, display, and metric tags.

**Data flow**: Reads `self`, matches every enum variant, and returns the corresponding `&'static str` literal.

**Call relations**: Display formatting and metrics code rely on this mapping whenever a structured setup failure needs a stable textual code.


##### `SetupFailure::new`  (lines 127–132)

```
fn new(code: SetupErrorCode, message: impl Into<String>) -> Self
```

**Purpose**: Constructs a typed setup failure from a code and message. It is the primary in-memory error constructor.

**Data flow**: Takes a `SetupErrorCode` and any `message` convertible into `String`, converts the message with `Into<String>`, stores both fields in `SetupFailure`, and returns it.

**Call relations**: Many setup and helper paths construct failures through this method directly or indirectly via `failure` and `from_report`.

*Call graph*: called by 11 (configure_offline_sandbox_network, configure_rule, ensure_offline_outbound_block, ensure_offline_proxy_allowlist, validate_local_policy_modify_result, provision_and_hide_sandbox_users, real_main, ensure_local_group, ensure_local_user, prepare_setup_marker (+1 more)); 1 external calls (into).


##### `SetupFailure::from_report`  (lines 134–136)

```
fn from_report(report: SetupErrorReport) -> Self
```

**Purpose**: Reconstructs a typed setup failure from a persisted JSON error report. It bridges on-disk helper reports back into in-memory errors.

**Data flow**: Takes `SetupErrorReport`, extracts its `code` and `message`, forwards them to `SetupFailure::new`, and returns the resulting `SetupFailure`.

**Call relations**: `report_helper_failure` uses this when a helper wrote a structured `setup_error.json` report.

*Call graph*: called by 1 (report_helper_failure); 1 external calls (new).


##### `SetupFailure::metric_message`  (lines 138–140)

```
fn metric_message(&self) -> String
```

**Purpose**: Produces a sanitized version of the failure message suitable for use as a metric tag. It removes sensitive home-path details before generic tag sanitization.

**Data flow**: Reads `self.message`, passes it to `sanitize_setup_metric_tag_value`, and returns the sanitized `String`.

**Call relations**: Metrics emission code calls this on structured failures before attaching the message as a tag.

*Call graph*: calls 1 internal fn (sanitize_setup_metric_tag_value).


##### `SetupFailure::fmt`  (lines 144–146)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a setup failure for human-readable display as `<code>: <message>`. It gives `anyhow` and logs a concise textual representation.

**Data flow**: Reads `self.code.as_str()` and `self.message`, writes them into the formatter with `write!`, and returns the formatting result.

**Call relations**: This implementation is used automatically whenever `SetupFailure` is displayed or wrapped inside `anyhow::Error`.

*Call graph*: 1 external calls (write!).


##### `failure`  (lines 151–153)

```
fn failure(code: SetupErrorCode, message: impl Into<String>) -> anyhow::Error
```

**Purpose**: Convenience constructor that wraps a `SetupFailure` inside `anyhow::Error`. It is the standard way setup code returns structured failures through `anyhow` APIs.

**Data flow**: Takes a `SetupErrorCode` and message, constructs `SetupFailure::new(code, message)`, wraps it with `anyhow::Error::new`, and returns the `anyhow::Error`.

**Call relations**: Setup orchestration code calls this in many failure branches so callers can still use `anyhow::Result` while preserving typed setup failure information.

*Call graph*: calls 1 internal fn (new); called by 4 (report_helper_failure, run_elevated_provisioning_setup, run_setup_exe, verify_setup_completed); 1 external calls (new).


##### `extract_failure`  (lines 155–157)

```
fn extract_failure(err: &anyhow::Error) -> Option<&SetupFailure>
```

**Purpose**: Attempts to recover a typed `SetupFailure` from an `anyhow::Error`. It is mainly used by tests and structured error handling.

**Data flow**: Takes `&anyhow::Error`, calls `downcast_ref::<SetupFailure>()`, and returns `Option<&SetupFailure>`.

**Call relations**: Tests use this to assert exact setup failure codes and messages after helper-report decoding or completion checks.

*Call graph*: called by 2 (report_helper_failure_ignores_setup_error_report_when_clear_failed, report_helper_failure_uses_setup_error_report_when_clear_succeeded).


##### `setup_error_path`  (lines 159–161)

```
fn setup_error_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the canonical path to the helper-to-orchestrator setup error report file. It centralizes the `setup_error.json` location.

**Data flow**: Takes `codex_home: &Path`, appends `.sandbox` and `setup_error.json`, and returns the resulting `PathBuf`.

**Call relations**: All report-file I/O helpers call this before reading, writing, or deleting the report.

*Call graph*: called by 3 (clear_setup_error_report, read_setup_error_report, write_setup_error_report); 1 external calls (join).


##### `clear_setup_error_report`  (lines 163–170)

```
fn clear_setup_error_report(codex_home: &Path) -> Result<()>
```

**Purpose**: Deletes any existing setup error report, treating a missing file as success. It is used to avoid confusing stale helper reports with fresh failures.

**Data flow**: Takes `codex_home`, computes the report path with `setup_error_path`, calls `fs::remove_file`, returns `Ok(())` on success or `NotFound`, and otherwise returns the filesystem error annotated with `with_context("remove <path>")`.

**Call relations**: Setup orchestrator launch paths call this before and after helper execution to manage report freshness.

*Call graph*: calls 1 internal fn (setup_error_path); called by 2 (run_setup_exe, run_setup_refresh_inner); 1 external calls (remove_file).


##### `write_setup_error_report`  (lines 172–180)

```
fn write_setup_error_report(codex_home: &Path, report: &SetupErrorReport) -> Result<()>
```

**Purpose**: Writes a structured setup error report to disk for the orchestrator to consume after helper failure. It ensures the sandbox directory exists first.

**Data flow**: Takes `codex_home` and `&SetupErrorReport`, creates `codex_home/.sandbox` with `create_dir_all`, computes the report path with `setup_error_path`, serializes the report with `serde_json::to_vec_pretty`, writes the bytes with `fs::write`, and returns `Ok(())` or a contextualized error.

**Call relations**: Tests call this directly, and the elevated helper side uses the same function when persisting structured failure reports.

*Call graph*: calls 1 internal fn (setup_error_path); called by 2 (report_helper_failure_ignores_setup_error_report_when_clear_failed, report_helper_failure_uses_setup_error_report_when_clear_succeeded); 4 external calls (join, create_dir_all, write, to_vec_pretty).


##### `read_setup_error_report`  (lines 182–192)

```
fn read_setup_error_report(codex_home: &Path) -> Result<Option<SetupErrorReport>>
```

**Purpose**: Reads and parses the structured setup error report if it exists. It distinguishes absence from actual read or parse failures.

**Data flow**: Takes `codex_home`, computes the report path with `setup_error_path`, reads bytes with `fs::read`, returns `Ok(None)` on `NotFound`, otherwise parses `SetupErrorReport` from JSON with `serde_json::from_slice`, and returns `Ok(Some(report))` or a contextualized error.

**Call relations**: `report_helper_failure` calls this after a helper exits nonzero to recover a structured failure when available.

*Call graph*: calls 1 internal fn (setup_error_path); called by 1 (report_helper_failure); 1 external calls (read).


##### `sanitize_setup_metric_tag_value`  (lines 195–197)

```
fn sanitize_setup_metric_tag_value(value: &str) -> String
```

**Purpose**: Sanitizes a setup error message for metric-tag use by first redacting home-path usernames and then applying generic metric-tag sanitization. It is the public metrics-facing sanitizer.

**Data flow**: Takes `value: &str`, calls `redact_home_paths(value)`, passes the result to `sanitize_metric_tag_value`, and returns the sanitized string.

**Call relations**: `SetupFailure::metric_message` and metrics emission code call this before attaching setup messages to telemetry.

*Call graph*: calls 1 internal fn (redact_home_paths); called by 2 (metric_message, emit_wfp_setup_metric); 1 external calls (sanitize_metric_tag_value).


##### `redact_home_paths`  (lines 199–214)

```
fn redact_home_paths(value: &str) -> String
```

**Purpose**: Collects likely local usernames from the environment and redacts matching path segments in a message. It prepares setup messages for safe metric export.

**Data flow**: Takes `value: &str`, initializes an empty `Vec<String>`, conditionally pushes non-empty `USERNAME` and `USER` environment values while avoiding case-insensitive duplicates, then calls `redact_username_segments(value, &usernames)` and returns the result.

**Call relations**: This private helper is only used by `sanitize_setup_metric_tag_value`.

*Call graph*: calls 1 internal fn (redact_username_segments); called by 1 (sanitize_setup_metric_tag_value); 2 external calls (new, var).


##### `redact_username_segments`  (lines 216–256)

```
fn redact_username_segments(value: &str, usernames: &[String]) -> String
```

**Purpose**: Replaces any path segment equal to one of the supplied usernames with `<user>`, preserving separators and non-path text. It is the core redaction algorithm.

**Data flow**: Takes `value: &str` and `usernames: &[String]`. If the username list is empty it returns `value.to_string()`. Otherwise it splits the string into path-like segments and separator characters on `\` and `/`, compares each segment against the usernames using case-insensitive matching on Windows and exact matching elsewhere, replaces matching segments with `<user>`, then reconstructs and returns the redacted string.

**Call relations**: This helper is called by `redact_home_paths` and directly by tests that validate redaction behavior.

*Call graph*: called by 4 (redact_home_paths, sanitize_tag_value_leaves_unknown_segments, sanitize_tag_value_redacts_multiple_occurrences, sanitize_tag_value_redacts_username_segments); 4 external calls (new, new, cfg!, take).


##### `tests::sanitize_tag_value_redacts_username_segments`  (lines 264–272)

```
fn sanitize_tag_value_redacts_username_segments()
```

**Purpose**: Verifies that username path segments are replaced with `<user>` in multiple path prefixes. It checks the basic redaction behavior.

**Data flow**: Builds a username list and a message containing two user-home paths, calls `redact_username_segments`, and asserts the expected redacted string.

**Call relations**: This test directly exercises the segment-replacement logic in `redact_username_segments`.

*Call graph*: calls 1 internal fn (redact_username_segments); 2 external calls (assert_eq!, vec!).


##### `tests::sanitize_tag_value_leaves_unknown_segments`  (lines 275–280)

```
fn sanitize_tag_value_leaves_unknown_segments()
```

**Purpose**: Verifies that path segments not matching any supplied username are left unchanged. It checks that redaction is selective rather than blanket.

**Data flow**: Builds a single-username list and a message with no matching username segment, calls `redact_username_segments`, and asserts the original message is returned.

**Call relations**: This test covers the non-matching branch in `redact_username_segments`.

*Call graph*: calls 1 internal fn (redact_username_segments); 2 external calls (assert_eq!, vec!).


##### `tests::sanitize_tag_value_redacts_multiple_occurrences`  (lines 283–288)

```
fn sanitize_tag_value_redacts_multiple_occurrences()
```

**Purpose**: Verifies that repeated occurrences of the same username segment are all redacted. It checks that the algorithm scans the full string rather than stopping after one replacement.

**Data flow**: Builds a username list and a message containing the same username in two paths, calls `redact_username_segments`, and asserts both occurrences become `<user>`.

**Call relations**: This test validates repeated-match handling in `redact_username_segments`.

*Call graph*: calls 1 internal fn (redact_username_segments); 2 external calls (assert_eq!, vec!).


### `windows-sandbox-rs/src/setup.rs`

`orchestration` · `setup refresh, provisioning, and elevated helper launch`

This file is the main setup orchestrator for the Windows sandbox. It defines path conventions (`sandbox_dir`, `sandbox_bin_dir`, `sandbox_secrets_dir`, marker and secrets file locations), request/override structs, serialized payload types, and the logic that launches the external setup helper either elevated or non-elevated. The top-level refresh functions first try to resolve a `PermissionProfile` into `ResolvedWindowsSandboxPermissions`; unsupported profiles are intentionally skipped rather than treated as errors. Supported requests are converted into an `ElevationPayload` containing usernames, cwd, codex home, read/write roots, deny lists, proxy/firewall settings, telemetry settings, and mode flags.

A large portion of the file is devoted to root computation and filtering. Read roots come from helper binaries, optional Windows platform defaults, readable policy roots, writable roots when full-disk read is granted, and selected `USERPROFILE` children. Write roots are canonicalized, deduplicated, expanded if they point at the whole user profile, then filtered to remove sensitive profile exclusions, SSH-config dependency roots, and anything under `CODEX_HOME`, `.sandbox`, `.sandbox-bin`, or `.sandbox-secrets`. This prevents capability write access from reaching sandbox control state or user secrets.

Network identity is derived from permissions plus `proxy_enforced`, producing offline/online behavior and optional loopback proxy allowlists parsed from environment variables. Helper launch paths clear stale `setup_error.json`, run the helper, and on failure prefer a structured report from that file over a generic exit-code error. `run_setup_exe` handles both direct execution and UAC elevation via `ShellExecuteExW`, while `verify_setup_completed` ensures the helper did not exit successfully before writing the expected setup artifacts. The extensive tests focus on root filtering, proxy parsing, helper lookup, and error-report precedence.

#### Function details

##### `sandbox_dir`  (lines 71–73)

```
fn sandbox_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Returns the root directory under `CODEX_HOME` where sandbox control state is stored. This is the canonical `.sandbox` location used throughout setup and ACL code.

**Data flow**: Takes `codex_home: &Path`, appends `.sandbox` with `join`, and returns the resulting `PathBuf`.

**Call relations**: Many setup and ACL paths call this to locate logs, markers, deny-read state, and protected directories. Other path helpers build on it.

*Call graph*: called by 8 (sync_persistent_deny_read_acls, require_logon_sandbox_creds, filter_sensitive_write_roots, run_elevated_provisioning_setup, run_elevated_setup, run_setup_exe, run_setup_refresh_inner, setup_marker_path); 1 external calls (join).


##### `sandbox_bin_dir`  (lines 75–77)

```
fn sandbox_bin_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Returns the directory under `CODEX_HOME` that stores helper binaries used by the sandbox. It identifies a write-protected subtree.

**Data flow**: Takes `codex_home: &Path`, appends `.sandbox-bin`, and returns the `PathBuf`.

**Call relations**: This helper is mainly used by write-root filtering to ensure capability writes never include helper binaries.

*Call graph*: called by 1 (filter_sensitive_write_roots); 1 external calls (join).


##### `sandbox_secrets_dir`  (lines 79–81)

```
fn sandbox_secrets_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Returns the directory under `CODEX_HOME` that stores sandbox secrets such as user credentials. It marks another write-protected subtree.

**Data flow**: Takes `codex_home: &Path`, appends `.sandbox-secrets`, and returns the `PathBuf`.

**Call relations**: It is used by secret-file path helpers and by sensitive write-root filtering.

*Call graph*: called by 2 (filter_sensitive_write_roots, sandbox_users_path); 1 external calls (join).


##### `setup_marker_path`  (lines 83–85)

```
fn setup_marker_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the setup marker JSON file that records completed provisioning state. The marker is used to verify setup completion and detect drift.

**Data flow**: Takes `codex_home: &Path`, calls `sandbox_dir(codex_home)`, appends `setup_marker.json`, and returns the resulting path.

**Call relations**: Marker-loading code uses this helper to find the persisted setup marker under the sandbox directory.

*Call graph*: calls 1 internal fn (sandbox_dir); called by 1 (load_marker).


##### `sandbox_users_path`  (lines 87–89)

```
fn sandbox_users_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the JSON file containing sandbox user records and encrypted passwords. It centralizes the location of persisted sandbox credentials.

**Data flow**: Takes `codex_home: &Path`, calls `sandbox_secrets_dir(codex_home)`, appends `sandbox_users.json`, and returns the path.

**Call relations**: Credential-loading and cleanup code uses this helper whenever it needs to read or remove the sandbox users file.

*Call graph*: calls 1 internal fn (sandbox_secrets_dir); called by 4 (load_users, remove_sandbox_users_file, remove_sandbox_users_file_deletes_existing_file, remove_sandbox_users_file_ignores_missing_file).


##### `run_setup_refresh`  (lines 108–134)

```
fn run_setup_refresh(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
    codex_home: &Path,
    pro
```

**Purpose**: Performs a non-elevating setup refresh for a permission profile when that profile is enforceable by the Windows sandbox. Unsupported profiles are silently skipped.

**Data flow**: Takes a permission profile, workspace roots, command cwd, environment map, codex home, and `proxy_enforced`. It attempts to resolve permissions with `try_from_permission_profile_for_workspace_roots`; if resolution fails it returns `Ok(())`, otherwise it constructs a `SandboxSetupRequest` and passes it with default overrides to `run_setup_refresh_inner`.

**Call relations**: This is the common refresh entry used by callers that want setup state updated opportunistically. It delegates all real payload construction and helper execution to `run_setup_refresh_inner`.

*Call graph*: calls 2 internal fn (try_from_permission_profile_for_workspace_roots, run_setup_refresh_inner); 1 external calls (default).


##### `run_setup_refresh_with_overrides`  (lines 136–141)

```
fn run_setup_refresh_with_overrides(
    request: SandboxSetupRequest<'_>,
    overrides: SetupRootOverrides,
) -> Result<()>
```

**Purpose**: Runs setup refresh using an already-built request plus explicit root overrides. It is the direct override-capable wrapper around the inner refresh implementation.

**Data flow**: Takes `SandboxSetupRequest` and `SetupRootOverrides`, forwards both unchanged to `run_setup_refresh_inner`, and returns its result.

**Call relations**: Credential orchestration uses this when it has already resolved permissions and computed custom root sets. It exists to bypass the profile-resolution step in `run_setup_refresh`.

*Call graph*: calls 1 internal fn (run_setup_refresh_inner); called by 1 (require_logon_sandbox_creds).


##### `run_setup_refresh_with_extra_read_roots`  (lines 143–178)

```
fn run_setup_refresh_with_extra_read_roots(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
    code
```

**Purpose**: Runs setup refresh while augmenting the computed readable roots with additional caller-supplied paths. It is used when setup needs temporary extra read access beyond the permission profile.

**Data flow**: Takes a permission profile, workspace roots, cwd, env map, codex home, extra read roots, and `proxy_enforced`. It resolves permissions, returns `Ok(())` if unsupported, computes baseline read roots with `gather_read_roots`, extends them with `extra_read_roots`, constructs a `SandboxSetupRequest`, and calls `run_setup_refresh_inner` with overrides that set the full read-root list, disable automatic platform-default re-addition, and force an empty write-root override.

**Call relations**: This wrapper is used by callers that need a split policy for setup refresh. It delegates root gathering to `gather_read_roots` and execution to `run_setup_refresh_inner`.

*Call graph*: calls 3 internal fn (try_from_permission_profile_for_workspace_roots, gather_read_roots, run_setup_refresh_inner); 1 external calls (new).


##### `run_setup_refresh_inner`  (lines 180–266)

```
fn run_setup_refresh_inner(
    request: SandboxSetupRequest<'_>,
    overrides: SetupRootOverrides,
) -> Result<()>
```

**Purpose**: Builds a refresh payload, launches the setup helper without elevation, and translates helper failures into structured setup errors when possible. It is the core implementation behind all refresh entry points.

**Data flow**: Takes a `SandboxSetupRequest` and `SetupRootOverrides`. It first rejects non-enforceable permissions, computes `(read_roots, write_roots)` via `build_payload_roots`, computes deny lists via `build_payload_deny_read_paths` and `build_payload_deny_write_paths`, derives `SandboxNetworkIdentity` and `OfflineProxySettings`, constructs an `ElevationPayload` with `refresh_only: true`, serializes it to JSON bytes and base64, finds the helper executable with `find_setup_exe`, computes log paths, clears any stale setup error report, spawns the helper with `Command::new(...).status()` and null stdio, logs launch and failure notes, and on non-success uses `report_helper_failure` to prefer a structured `setup_error.json` report. On success it clears the error report again and returns `Ok(())`.

**Call relations**: All refresh wrappers funnel into this function. It delegates root computation, proxy extraction, helper lookup, logging, and failure decoding to specialized helpers before performing the actual helper process launch.

*Call graph*: calls 11 internal fn (current_log_file_path, log_note, from_permissions, build_payload_deny_read_paths, build_payload_deny_write_paths, build_payload_roots, find_setup_exe, offline_proxy_settings_from_env, report_helper_failure, sandbox_dir (+1 more)); called by 3 (run_setup_refresh, run_setup_refresh_with_extra_read_roots, run_setup_refresh_with_overrides); 7 external calls (null, bail!, new, format!, to_vec, current_dir, var).


##### `SetupMarker::version_matches`  (lines 282–284)

```
fn version_matches(&self) -> bool
```

**Purpose**: Checks whether a persisted setup marker was written by the current setup schema version. It is a simple compatibility gate.

**Data flow**: Reads `self.version`, compares it to `SETUP_VERSION`, and returns the boolean result.

**Call relations**: Marker validation code uses this to decide whether existing setup artifacts can be reused or must be regenerated.


##### `SetupMarker::request_mismatch_reason`  (lines 286–306)

```
fn request_mismatch_reason(
        &self,
        network_identity: SandboxNetworkIdentity,
        offline_proxy_settings: &OfflineProxySettings,
    ) -> Option<String>
```

**Purpose**: Explains whether an existing setup marker's stored offline firewall settings differ from the currently desired request. It only reports drift when the sandbox should use the offline identity.

**Data flow**: Takes a `SandboxNetworkIdentity` and `&OfflineProxySettings`. If the identity does not use offline mode it returns `None`. Otherwise it compares `self.proxy_ports` and `self.allow_local_binding` against the desired settings; if both match it returns `None`, else it returns a formatted string describing stored versus desired values.

**Call relations**: Setup drift-detection code calls this after loading a marker to decide whether a refresh is needed. It depends on `uses_offline_identity` to suppress irrelevant proxy drift for online identity.

*Call graph*: calls 1 internal fn (uses_offline_identity); 1 external calls (format!).


##### `SandboxUsersFile::version_matches`  (lines 324–326)

```
fn version_matches(&self) -> bool
```

**Purpose**: Checks whether the persisted sandbox users file matches the current setup schema version. It guards reuse of stored credentials.

**Data flow**: Reads `self.version`, compares it to `SETUP_VERSION`, and returns a boolean.

**Call relations**: Credential-loading code uses this to reject stale or incompatible sandbox user records.


##### `is_elevated`  (lines 329–359)

```
fn is_elevated() -> Result<bool>
```

**Purpose**: Determines whether the current process is running with administrator membership sufficient for elevated setup operations. It uses Windows SID APIs rather than shell heuristics.

**Data flow**: Allocates the Administrators group SID with `AllocateAndInitializeSid`, checks current-token membership with `CheckTokenMembership`, frees the SID with `FreeSid`, and returns `Ok(true/false)` based on the membership flag. If SID allocation or membership checking fails, it returns an `anyhow` error containing the Win32 error code.

**Call relations**: Both elevated setup entry points call this before deciding whether to require or request elevation. It delegates the actual privilege check to Win32 security APIs.

*Call graph*: called by 2 (run_elevated_provisioning_setup, run_elevated_setup); 5 external calls (anyhow!, null_mut, AllocateAndInitializeSid, CheckTokenMembership, FreeSid).


##### `canonical_existing`  (lines 361–371)

```
fn canonical_existing(paths: &[PathBuf]) -> Vec<PathBuf>
```

**Purpose**: Filters a path list down to existing paths and canonicalizes each one when possible. It normalizes root lists before they are sent to setup or used for filtering.

**Data flow**: Takes `&[PathBuf]`, iterates over each path, drops non-existent entries, canonicalizes existing ones with `dunce::canonicalize` falling back to the original path on canonicalization failure, collects the results, and returns `Vec<PathBuf>`.

**Call relations**: Most root-gathering and override-processing helpers call this before deduplication or payload assembly so setup only sees concrete existing paths.

*Call graph*: called by 5 (build_payload_roots, effective_write_roots_for_permissions, gather_full_read_roots_for_permissions, gather_read_roots, gather_write_roots_for_permissions); 1 external calls (iter).


##### `profile_read_roots`  (lines 373–390)

```
fn profile_read_roots(user_profile: &Path) -> Vec<PathBuf>
```

**Purpose**: Enumerates top-level readable entries under a user profile while excluding configured sensitive directories such as `.ssh` and cloud credential folders. It avoids granting broad profile-root access directly.

**Data flow**: Takes `user_profile: &Path`, attempts `std::fs::read_dir`; on failure it returns a single-element vector containing the profile root itself. On success it maps entries to `(file_name, path)`, filters out names matching `USERPROFILE_ROOT_EXCLUSIONS` case-insensitively, collects the remaining child paths, and returns them.

**Call relations**: This helper is used when expanding or gathering profile-related read roots. Other filtering helpers build on its notion of which top-level profile entries are safe to expose.

*Call graph*: called by 4 (expand_user_profile_root_for, gather_full_read_roots_for_permissions, profile_read_roots_excludes_configured_top_level_entries, profile_read_roots_falls_back_to_profile_root_when_enumeration_fails); 2 external calls (read_dir, vec!).


##### `gather_helper_read_roots`  (lines 392–396)

```
fn gather_helper_read_roots(codex_home: &Path) -> Vec<PathBuf>
```

**Purpose**: Ensures the helper binary directory exists and returns it as a mandatory readable root. This guarantees the elevated helper can access its own support binaries.

**Data flow**: Takes `codex_home: &Path`, computes `helper_bin_dir(codex_home)`, attempts to create it with `create_dir_all`, wraps it in a one-element vector, and returns that vector.

**Call relations**: Both full-read and restricted-read root gathering include this helper root, and override-based payload construction preserves it explicitly.

*Call graph*: calls 1 internal fn (helper_bin_dir); called by 3 (build_payload_roots, gather_full_read_roots_for_permissions, gather_read_roots); 2 external calls (create_dir_all, vec!).


##### `gather_full_read_roots_for_permissions`  (lines 398–421)

```
fn gather_full_read_roots_for_permissions(
    command_cwd: &Path,
    permissions: &ResolvedWindowsSandboxPermissions,
    env_map: &HashMap<String, String>,
    codex_home: &Path,
) -> Vec<PathBuf>
```

**Purpose**: Builds the broader legacy read-root set used when the permission profile grants full-disk read access. It preserves platform defaults and writable roots as readable.

**Data flow**: Takes command cwd, resolved permissions, env map, and codex home. It starts with `gather_helper_read_roots`, appends `WINDOWS_PLATFORM_DEFAULT_READ_ROOTS`, appends filtered `USERPROFILE` children if the environment variable exists, pushes `command_cwd`, appends each writable root from `permissions.writable_roots_for_cwd(command_cwd, env_map)`, canonicalizes existing paths with `canonical_existing`, and returns the result.

**Call relations**: This function is called by `gather_read_roots` when `has_full_disk_read_access` is true. It combines helper, platform, profile, cwd, and writable-root inputs into one payload-ready list.

*Call graph*: calls 4 internal fn (writable_roots_for_cwd, canonical_existing, gather_helper_read_roots, profile_read_roots); called by 2 (gather_read_roots, full_read_roots_preserve_legacy_platform_defaults); 3 external calls (new, to_path_buf, var).


##### `gather_read_roots`  (lines 423–448)

```
fn gather_read_roots(
    command_cwd: &Path,
    permissions: &ResolvedWindowsSandboxPermissions,
    env_map: &HashMap<String, String>,
    codex_home: &Path,
) -> Vec<PathBuf>
```

**Purpose**: Computes the readable roots that should be sent to setup for a given permission set and cwd. It switches between restricted-read and full-read behavior based on the resolved permissions.

**Data flow**: Takes command cwd, permissions, env map, and codex home. If `permissions.has_full_disk_read_access()` is true, it returns `gather_full_read_roots_for_permissions(...)`. Otherwise it starts with `gather_helper_read_roots`, optionally appends `WINDOWS_PLATFORM_DEFAULT_READ_ROOTS` when `permissions.include_platform_defaults()` is true, appends `permissions.readable_roots_for_cwd(command_cwd)`, canonicalizes existing paths with `canonical_existing`, and returns the vector.

**Call relations**: This is the main read-root computation used by setup refresh and payload building. It delegates policy-specific queries to `ResolvedWindowsSandboxPermissions` and broad-read handling to `gather_full_read_roots_for_permissions`.

*Call graph*: calls 6 internal fn (has_full_disk_read_access, include_platform_defaults, readable_roots_for_cwd, canonical_existing, gather_full_read_roots_for_permissions, gather_helper_read_roots); called by 4 (build_payload_roots, run_setup_refresh_with_extra_read_roots, gather_read_roots_includes_helper_bin_dir, workspace_write_roots_remain_readable).


##### `gather_write_roots_for_permissions`  (lines 450–468)

```
fn gather_write_roots_for_permissions(
    permissions: &ResolvedWindowsSandboxPermissions,
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
) -> Vec<PathBuf>
```

**Purpose**: Computes canonical, deduplicated writable roots from resolved permissions for a specific cwd and environment. It strips non-existent paths and preserves first-seen order among canonicalized roots.

**Data flow**: Takes permissions, command cwd, and env map. It collects `root.root` from `permissions.writable_roots_for_cwd(command_cwd, env_map)`, canonicalizes existing paths with `canonical_existing`, then inserts each into a `HashSet` to deduplicate while pushing unique roots into an output vector, which it returns.

**Call relations**: This helper feeds `effective_write_roots_for_permissions` when no explicit write-root override is supplied.

*Call graph*: calls 2 internal fn (writable_roots_for_cwd, canonical_existing); called by 1 (effective_write_roots_for_permissions); 2 external calls (new, new).


##### `effective_write_roots_for_setup`  (lines 470–484)

```
fn effective_write_roots_for_setup(
    permissions: &ResolvedWindowsSandboxPermissions,
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
    codex_home: &Path,
    write_roots_override:
```

**Purpose**: Thin wrapper that computes the final filtered write roots used by setup payload construction. It exists to give setup code a semantically named entry point.

**Data flow**: Takes permissions, cwd, env map, codex home, and an optional write-root override slice, forwards them to `effective_write_roots_for_permissions`, and returns the resulting vector.

**Call relations**: `build_payload_roots` calls this to obtain write roots before assembling the final read/write payload pair.

*Call graph*: calls 1 internal fn (effective_write_roots_for_permissions); called by 1 (build_payload_roots).


##### `effective_write_roots_for_permissions`  (lines 486–503)

```
fn effective_write_roots_for_permissions(
    permissions: &ResolvedWindowsSandboxPermissions,
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
    codex_home: &Path,
    write_roots_ove
```

**Purpose**: Applies all write-root normalization and safety filters to either caller-supplied overrides or permission-derived writable roots. It is the definitive write-root filtering pipeline.

**Data flow**: Takes permissions, cwd, env map, codex home, and optional override roots. It chooses roots from `canonical_existing(override)` when overrides are present or from `gather_write_roots_for_permissions` otherwise, then passes the list through `expand_user_profile_root`, `filter_user_profile_root`, `filter_user_profile_root_exclusions`, `filter_ssh_config_dependency_roots`, and finally `filter_sensitive_write_roots`, returning the filtered vector.

**Call relations**: This function is used by setup payload construction, elevated spawn preparation, capability-root derivation, and world-writable checks. It delegates each stage of normalization and exclusion to focused helpers.

*Call graph*: calls 7 internal fn (canonical_existing, expand_user_profile_root, filter_sensitive_write_roots, filter_ssh_config_dependency_roots, filter_user_profile_root, filter_user_profile_root_exclusions, gather_write_roots_for_permissions); called by 5 (apply_capability_denies_for_world_writable_for_permissions, run_windows_sandbox_capture_for_permission_profile, effective_write_roots_for_setup, legacy_session_capability_roots, prepare_elevated_spawn_context_for_permissions).


##### `SandboxNetworkIdentity::from_permissions`  (lines 548–557)

```
fn from_permissions(
        permissions: &ResolvedWindowsSandboxPermissions,
        proxy_enforced: bool,
    ) -> Self
```

**Purpose**: Chooses whether the sandbox should run with the offline or online identity based on network policy and explicit proxy enforcement. Offline identity is used whenever networking is restricted or externally forced off.

**Data flow**: Takes resolved permissions and `proxy_enforced: bool`. It returns `Offline` if `proxy_enforced` is true or `permissions.network_policy().is_enabled()` is false; otherwise it returns `Online`.

**Call relations**: Setup refresh, elevated setup, and credential orchestration call this before deriving firewall/proxy settings. It depends on `ResolvedWindowsSandboxPermissions::network_policy` for the policy check.

*Call graph*: calls 1 internal fn (network_policy); called by 3 (require_logon_sandbox_creds, run_elevated_setup, run_setup_refresh_inner).


##### `SandboxNetworkIdentity::uses_offline_identity`  (lines 559–561)

```
fn uses_offline_identity(self) -> bool
```

**Purpose**: Reports whether a `SandboxNetworkIdentity` value represents the offline identity. It is a convenience predicate used in drift and proxy-setting logic.

**Data flow**: Matches `self` against `Self::Offline` and returns the boolean result.

**Call relations**: This predicate is used by `SetupMarker::request_mismatch_reason` and `offline_proxy_settings_from_env` to gate offline-only behavior.

*Call graph*: called by 2 (request_mismatch_reason, offline_proxy_settings_from_env); 1 external calls (matches!).


##### `offline_proxy_settings_from_env`  (lines 578–594)

```
fn offline_proxy_settings_from_env(
    env_map: &HashMap<String, String>,
    network_identity: SandboxNetworkIdentity,
) -> OfflineProxySettings
```

**Purpose**: Extracts the subset of proxy-related environment settings that matter for offline sandbox firewall configuration. It ignores proxy variables entirely when the online identity is selected.

**Data flow**: Takes `env_map` and a `SandboxNetworkIdentity`. If `uses_offline_identity()` is false, it returns `OfflineProxySettings { proxy_ports: vec![], allow_local_binding: false }`. Otherwise it computes `proxy_ports` with `proxy_ports_from_env(env_map)` and sets `allow_local_binding` when `CODEX_NETWORK_ALLOW_LOCAL_BINDING` exists in the map with value `"1"`.

**Call relations**: Setup payload builders call this after choosing network identity so the helper can configure firewall exceptions only when needed.

*Call graph*: calls 2 internal fn (uses_offline_identity, proxy_ports_from_env); called by 3 (require_logon_sandbox_creds, run_elevated_setup, run_setup_refresh_inner); 1 external calls (vec!).


##### `proxy_ports_from_env`  (lines 596–606)

```
fn proxy_ports_from_env(env_map: &HashMap<String, String>) -> Vec<u16>
```

**Purpose**: Parses loopback proxy ports from a fixed set of proxy environment variables and returns them sorted and deduplicated. It ignores non-loopback proxies and malformed values.

**Data flow**: Takes `env_map`, iterates over `PROXY_ENV_KEYS`, looks up each key, passes any value to `loopback_proxy_port_from_url`, inserts successful ports into a `BTreeSet`, then collects the set into a sorted `Vec<u16>`.

**Call relations**: This helper is only used by `offline_proxy_settings_from_env` to derive firewall allowlist ports from environment variables.

*Call graph*: calls 1 internal fn (loopback_proxy_port_from_url); called by 1 (offline_proxy_settings_from_env); 1 external calls (new).


##### `loopback_proxy_port_from_url`  (lines 608–627)

```
fn loopback_proxy_port_from_url(url: &str) -> Option<u16>
```

**Purpose**: Extracts a nonzero port from a proxy URL only when the host is a recognized loopback address. It supports `localhost`, `127.0.0.1`, and IPv6 `::1` forms, including credentials in the authority.

**Data flow**: Takes `url: &str`, trims it, splits on `://` to isolate the authority, strips any path and optional `user@` prefix, then parses either bracketed IPv6 `[::1]:port` or host:port. It returns `Some(port)` only for loopback hosts with a nonzero `u16` port; otherwise it returns `None`.

**Call relations**: `proxy_ports_from_env` calls this for each proxy variable value to decide whether that variable contributes a firewall allowlist port.

*Call graph*: called by 1 (proxy_ports_from_env).


##### `quote_arg`  (lines 629–663)

```
fn quote_arg(arg: &str) -> String
```

**Purpose**: Quotes a single command-line argument using Windows escaping rules suitable for passing a base64 payload through `ShellExecuteExW`. It preserves literal backslashes and embedded quotes correctly.

**Data flow**: Takes `arg: &str`, returns it unchanged if no quoting is needed, otherwise builds a quoted string by scanning characters, counting backslashes, doubling them before quotes or at the end, escaping embedded quotes, and surrounding the result with double quotes.

**Call relations**: `run_setup_exe` uses this when constructing the elevated helper's parameter string for `ShellExecuteExW`.

*Call graph*: called by 1 (run_setup_exe); 1 external calls (from).


##### `find_setup_exe`  (lines 665–672)

```
fn find_setup_exe() -> PathBuf
```

**Purpose**: Locates the setup helper executable, preferring a packaged resource adjacent to the current executable and falling back to a bare filename. It abstracts deployment layout differences.

**Data flow**: Attempts `std::env::current_exe()`, passes that path to `find_setup_exe_for_current_exe`, and if a packaged helper is found returns it; otherwise it returns `PathBuf::from(SETUP_EXE_FILENAME)`.

**Call relations**: Both refresh and elevated helper launch paths call this before spawning the setup helper. It delegates package-relative lookup to `find_setup_exe_for_current_exe`.

*Call graph*: calls 1 internal fn (find_setup_exe_for_current_exe); called by 2 (run_setup_exe, run_setup_refresh_inner); 2 external calls (from, current_exe).


##### `find_setup_exe_for_current_exe`  (lines 674–676)

```
fn find_setup_exe_for_current_exe(exe: &Path) -> Option<PathBuf>
```

**Purpose**: Resolves the setup helper path relative to the current executable's packaged layout. It encapsulates the resource-directory lookup policy.

**Data flow**: Takes `exe: &Path`, calls `bundled_executable_path_for_exe(exe, SETUP_EXE_FILENAME)`, and returns the resulting `Option<PathBuf>`.

**Call relations**: This helper is used by `find_setup_exe` and directly by a test that verifies package resource lookup.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); called by 2 (find_setup_exe, setup_exe_lookup_checks_package_resource_dir_for_bin_exe).


##### `report_helper_failure`  (lines 678–695)

```
fn report_helper_failure(
    codex_home: &Path,
    cleared_report: bool,
    exit_code: Option<i32>,
) -> anyhow::Error
```

**Purpose**: Converts a helper process failure into the most informative structured error available, preferring a freshly written `setup_error.json` report when safe to trust it. It is the bridge between helper exit status and orchestrator-facing errors.

**Data flow**: Takes `codex_home`, a `cleared_report` flag, and an optional exit code. It formats a generic exit-detail string. If `cleared_report` is false, it immediately returns `failure(OrchestratorHelperExitNonzero, exit_detail)`. Otherwise it calls `read_setup_error_report(codex_home)` and returns either `anyhow::Error::new(SetupFailure::from_report(report))`, a generic nonzero-exit failure when no report exists, or a report-read failure when reading the report itself fails.

**Call relations**: Both `run_setup_refresh_inner` and `run_setup_exe` call this after a helper exits unsuccessfully. It delegates report parsing to `read_setup_error_report` and structured error construction to `SetupFailure::from_report`/`failure`.

*Call graph*: calls 3 internal fn (from_report, failure, read_setup_error_report); called by 2 (run_setup_exe, run_setup_refresh_inner); 2 external calls (new, format!).


##### `verify_setup_completed`  (lines 697–706)

```
fn verify_setup_completed(codex_home: &Path) -> Result<()>
```

**Purpose**: Checks that the helper actually produced the expected setup artifacts after reporting success. It guards against false-positive helper exits.

**Data flow**: Takes `codex_home`, calls `sandbox_setup_is_complete(codex_home)`, returns `Ok(())` if true, otherwise returns `failure(OrchestratorHelperIncomplete, ...)`.

**Call relations**: `run_setup_exe` calls this after both elevated and non-elevated helper execution paths succeed at the process level.

*Call graph*: calls 2 internal fn (sandbox_setup_is_complete, failure); called by 2 (run_setup_exe, setup_completion_requires_ready_artifacts).


##### `run_setup_exe`  (lines 708–819)

```
fn run_setup_exe(
    payload: &ElevationPayload,
    needs_elevation: bool,
    codex_home: &Path,
) -> Result<()>
```

**Purpose**: Launches the setup helper either directly or via UAC elevation, waits for completion, and validates the resulting setup state. It is the shared helper-execution engine for full setup and provisioning-only setup.

**Data flow**: Takes an `ElevationPayload`, `needs_elevation`, and `codex_home`. It serializes the payload to JSON, base64-encodes it, clears any stale setup error report, and branches: if `needs_elevation` is false, it spawns the helper with `Command`, hidden window flags, and null stdio, checks exit status, calls `report_helper_failure` on nonzero exit, verifies setup completion, clears the error report, and returns. If `needs_elevation` is true, it converts the exe path, quoted payload, and `runas` verb to UTF-16, fills `SHELLEXECUTEINFOW` with `SEE_MASK_NOCLOSEPROCESS`, calls `ShellExecuteExW`, maps `ERROR_CANCELLED` specially, waits for the process with `WaitForSingleObject`, reads the exit code with `GetExitCodeProcess`, closes the process handle, reports helper failure on nonzero exit, verifies setup completion, clears the error report, and returns `Ok(())` on success.

**Call relations**: This function is called by `run_elevated_setup` and `run_elevated_provisioning_setup`. It delegates helper lookup, argument quoting, report clearing, failure decoding, and completion verification to dedicated helpers.

*Call graph*: calls 9 internal fn (log_note, find_setup_exe, quote_arg, report_helper_failure, sandbox_dir, verify_setup_completed, clear_setup_error_report, failure, to_wide); called by 2 (run_elevated_provisioning_setup, run_elevated_setup); 7 external calls (null, new, format!, to_string, zeroed, CloseHandle, GetLastError).


##### `run_elevated_setup`  (lines 821–866)

```
fn run_elevated_setup(
    request: SandboxSetupRequest<'_>,
    overrides: SetupRootOverrides,
) -> Result<()>
```

**Purpose**: Builds a full setup payload from resolved permissions and launches the setup helper, requesting elevation only when the current process is not already elevated. It is the main full-provisioning entry point.

**Data flow**: Takes a `SandboxSetupRequest` and `SetupRootOverrides`. It rejects unenforceable permissions, ensures `sandbox_dir(codex_home)` exists, computes read/write roots and deny lists via `build_payload_roots`, `build_payload_deny_read_paths`, and `build_payload_deny_write_paths`, derives network identity and offline proxy settings, constructs an `ElevationPayload` with telemetry settings and `refresh_only: false`, determines `needs_elevation` by negating `is_elevated()`, and passes the payload to `run_setup_exe`.

**Call relations**: Credential orchestration calls this when full setup may be required. It delegates all root and proxy computation to helpers and all process-launch behavior to `run_setup_exe`.

*Call graph*: calls 8 internal fn (from_permissions, build_payload_deny_read_paths, build_payload_deny_write_paths, build_payload_roots, is_elevated, offline_proxy_settings_from_env, run_setup_exe, sandbox_dir); called by 1 (require_logon_sandbox_creds); 4 external calls (bail!, global_statsig_metrics_settings, var, create_dir_all).


##### `run_elevated_provisioning_setup`  (lines 868–905)

```
fn run_elevated_provisioning_setup(codex_home: &Path, real_user: &str) -> Result<()>
```

**Purpose**: Runs a provisioning-only setup flow that creates sandbox users and related baseline state without filesystem root payloads. It requires the caller to already be elevated.

**Data flow**: Takes `codex_home` and `real_user`. It ensures `sandbox_dir(codex_home)` exists, checks `is_elevated()` and returns `OrchestratorElevationRequired` if false, constructs an `ElevationPayload` with empty read/write/deny roots, empty proxy settings, telemetry settings, `mode: ProvisionOnly`, and `refresh_only: false`, then calls `run_setup_exe` with `needs_elevation` forced to false.

**Call relations**: This entry point is used for provisioning-only scenarios where elevation must already be present. It shares helper execution with `run_setup_exe` but bypasses permission-derived root computation.

*Call graph*: calls 4 internal fn (is_elevated, run_setup_exe, sandbox_dir, failure); 4 external calls (to_path_buf, new, global_statsig_metrics_settings, create_dir_all).


##### `build_payload_roots`  (lines 907–946)

```
fn build_payload_roots(
    request: &SandboxSetupRequest<'_>,
    overrides: &SetupRootOverrides,
) -> (Vec<PathBuf>, Vec<PathBuf>)
```

**Purpose**: Computes the final read-root and write-root lists sent to the setup helper, applying overrides and all profile/user-profile/sensitive-path filtering. It is the central payload root assembler.

**Data flow**: Takes a `SandboxSetupRequest` and `SetupRootOverrides`. It computes `write_roots` via `effective_write_roots_for_setup`. For read roots, if an explicit override exists it starts from `gather_helper_read_roots`, optionally adds platform defaults depending on `read_roots_include_platform_defaults`, extends with the override list, and canonicalizes existing paths; otherwise it calls `gather_read_roots`. It then passes read roots through `expand_user_profile_root`, `filter_user_profile_root`, `filter_user_profile_root_exclusions`, and `filter_ssh_config_dependency_roots`, removes any read root that is also present in the write-root set, and returns `(read_roots, write_roots)`.

**Call relations**: Both refresh and elevated setup payload builders call this before constructing `ElevationPayload`. It delegates write-root computation and each filtering stage to specialized helpers.

*Call graph*: calls 8 internal fn (canonical_existing, effective_write_roots_for_setup, expand_user_profile_root, filter_ssh_config_dependency_roots, filter_user_profile_root, filter_user_profile_root_exclusions, gather_helper_read_roots, gather_read_roots); called by 5 (run_elevated_setup, run_setup_refresh_inner, build_payload_roots_preserves_helper_roots_when_read_override_is_provided, build_payload_roots_replaces_full_read_policy_when_read_override_is_provided, effective_write_roots_match_payload_filtering_for_overrides).


##### `build_payload_deny_write_paths`  (lines 948–964)

```
fn build_payload_deny_write_paths(
    request: &SandboxSetupRequest<'_>,
    explicit_deny_write_paths: Option<Vec<PathBuf>>,
) -> Vec<PathBuf>
```

**Purpose**: Combines explicit deny-write paths with deny paths derived from permission-based allow/deny computation. It ensures setup receives both caller carveouts and policy-protected children.

**Data flow**: Takes a `SandboxSetupRequest` and optional explicit deny-write paths. It computes `AllowDenyPaths` with `compute_allow_paths_for_permissions`, canonicalizes each explicit deny path with `canonicalize_path`, extends that vector with the computed `allow_deny_paths.deny` set, and returns the combined `Vec<PathBuf>`.

**Call relations**: Refresh and elevated setup both call this when building helper payloads. It delegates policy-derived deny computation to `compute_allow_paths_for_permissions`.

*Call graph*: calls 1 internal fn (compute_allow_paths_for_permissions); called by 2 (run_elevated_setup, run_setup_refresh_inner).


##### `build_payload_deny_read_paths`  (lines 966–970)

```
fn build_payload_deny_read_paths(explicit_deny_read_paths: Option<Vec<PathBuf>>) -> Vec<PathBuf>
```

**Purpose**: Returns the explicit deny-read paths exactly as configured, without canonicalization. This preserves lexical spellings so the ACL layer can reason about reparse-point aliases.

**Data flow**: Takes `Option<Vec<PathBuf>>`, unwraps it to an empty vector when absent, and returns the resulting vector unchanged.

**Call relations**: Both setup payload builders call this for deny-read paths. Unlike deny-write handling, it intentionally performs no additional computation.

*Call graph*: called by 2 (run_elevated_setup, run_setup_refresh_inner).


##### `expand_user_profile_root`  (lines 972–977)

```
fn expand_user_profile_root(roots: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Expands any root equal to the current `USERPROFILE` into its top-level children. It avoids granting broad profile-root access directly when a more granular expansion is possible.

**Data flow**: Takes `roots: Vec<PathBuf>`, reads `USERPROFILE` from the environment, and if present calls `expand_user_profile_root_for(roots, Path::new(&user_profile))`; otherwise it returns the input roots unchanged.

**Call relations**: Both read-root and write-root filtering pipelines call this before removing the profile root itself.

*Call graph*: calls 1 internal fn (expand_user_profile_root_for); called by 2 (build_payload_roots, effective_write_roots_for_permissions); 2 external calls (new, var).


##### `expand_user_profile_root_for`  (lines 979–993)

```
fn expand_user_profile_root_for(roots: Vec<PathBuf>, user_profile: &Path) -> Vec<PathBuf>
```

**Purpose**: Replaces any root matching a specific user-profile path with the profile's readable child entries, then deduplicates by canonical path key. It is the testable core of profile-root expansion.

**Data flow**: Takes `roots` and `user_profile`. It computes the canonical key for the profile, iterates over roots, replacing any root whose canonical key matches the profile key with `profile_read_roots(user_profile)` and leaving others unchanged, then sorts by canonical key and deduplicates adjacent entries with the same canonical key before returning the expanded vector.

**Call relations**: This helper is called by `expand_user_profile_root` and directly by tests. It delegates child enumeration to `profile_read_roots`.

*Call graph*: calls 2 internal fn (canonical_path_key, profile_read_roots); called by 1 (expand_user_profile_root); 1 external calls (new).


##### `filter_user_profile_root`  (lines 995–1002)

```
fn filter_user_profile_root(mut roots: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Removes any root equal to the current `USERPROFILE` itself. It is used after expansion so payloads contain children rather than the broad profile root.

**Data flow**: Takes `roots: Vec<PathBuf>`, reads `USERPROFILE`, computes its canonical key, retains only roots whose canonical key differs from that profile key, and returns the filtered vector. If `USERPROFILE` is unavailable, it returns the input unchanged.

**Call relations**: Both read-root and write-root pipelines call this after profile-root expansion.

*Call graph*: calls 1 internal fn (canonical_path_key); called by 2 (build_payload_roots, effective_write_roots_for_permissions); 2 external calls (new, var).


##### `filter_user_profile_root_exclusions`  (lines 1004–1011)

```
fn filter_user_profile_root_exclusions(mut roots: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Removes roots that fall under configured sensitive top-level user-profile exclusions such as `.ssh`, `.aws`, and `.docker`. It prevents setup payloads from granting access to known secret-bearing directories.

**Data flow**: Takes `roots: Vec<PathBuf>`, reads `USERPROFILE`, and retains only roots for which `is_user_profile_root_exclusion(root, user_profile)` is false. If `USERPROFILE` is unavailable, it returns the input unchanged.

**Call relations**: This helper is part of both read-root and write-root filtering pipelines and delegates the actual exclusion test to `is_user_profile_root_exclusion`.

*Call graph*: called by 2 (build_payload_roots, effective_write_roots_for_permissions); 2 external calls (new, var).


##### `is_user_profile_root_exclusion`  (lines 1013–1031)

```
fn is_user_profile_root_exclusion(root: &Path, user_profile: &Path) -> bool
```

**Purpose**: Checks whether a path lies under the current user profile and its first child segment matches one of the configured excluded top-level names. It performs the case-insensitive exclusion test used by profile filtering.

**Data flow**: Takes `root` and `user_profile`, computes canonical path keys for both, derives the profile prefix, strips that prefix from the root key, extracts the first non-empty child segment, and returns true if that child matches any entry in `USERPROFILE_ROOT_EXCLUSIONS` case-insensitively.

**Call relations**: This predicate is used by `filter_user_profile_root_exclusions` and directly by tests that validate exclusion behavior.

*Call graph*: calls 1 internal fn (canonical_path_key); 1 external calls (format!).


##### `filter_ssh_config_dependency_roots`  (lines 1033–1041)

```
fn filter_ssh_config_dependency_roots(mut roots: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Removes roots that correspond to files or directories referenced by SSH config under the user profile. It prevents writable or readable payload roots from accidentally exposing SSH keys and included config trees.

**Data flow**: Takes `roots: Vec<PathBuf>`, reads `USERPROFILE`, computes dependency paths with `ssh_config_dependency_paths(user_profile)`, retains only roots for which `is_ssh_config_dependency_root(root, user_profile, &dependency_paths)` is false, and returns the filtered vector. If `USERPROFILE` is unavailable, it returns the input unchanged.

**Call relations**: Both read-root and write-root filtering pipelines call this after profile-root filtering. It delegates dependency discovery to `ssh_config_dependency_paths` and matching to `is_ssh_config_dependency_root`.

*Call graph*: calls 1 internal fn (ssh_config_dependency_paths); called by 2 (build_payload_roots, effective_write_roots_for_permissions); 2 external calls (new, var).


##### `is_ssh_config_dependency_root`  (lines 1043–1056)

```
fn is_ssh_config_dependency_root(
    root: &Path,
    user_profile: &Path,
    dependency_paths: &[PathBuf],
) -> bool
```

**Purpose**: Determines whether a root shares the same top-level user-profile child as any SSH config dependency path. This broad child-name comparison lets the filter block entire sensitive roots, not just exact files.

**Data flow**: Takes `root`, `user_profile`, and a slice of dependency paths. It derives the root's top-level child name with `user_profile_child_name`; if absent it returns false. Otherwise it returns true when any dependency path yields the same child name case-insensitively.

**Call relations**: This predicate is used by `filter_ssh_config_dependency_roots` and directly by tests. It relies on `user_profile_child_name` for normalized child extraction.

*Call graph*: calls 1 internal fn (user_profile_child_name); 1 external calls (iter).


##### `user_profile_child_name`  (lines 1058–1068)

```
fn user_profile_child_name(path: &Path, user_profile: &Path) -> Option<String>
```

**Purpose**: Extracts the first path segment under the user profile from a given path, using canonical path keys. It is a normalization helper for profile-relative filtering.

**Data flow**: Takes `path` and `user_profile`, computes canonical keys, strips the profile prefix from the path key, splits the remainder on `/`, returns the first non-empty segment as `Some(String)`, or `None` if the path is not under the profile.

**Call relations**: This helper is only used by `is_ssh_config_dependency_root` to compare roots and dependency paths at the top-level child granularity.

*Call graph*: calls 1 internal fn (canonical_path_key); called by 1 (is_ssh_config_dependency_root); 1 external calls (format!).


##### `filter_sensitive_write_roots`  (lines 1070–1093)

```
fn filter_sensitive_write_roots(mut roots: Vec<PathBuf>, codex_home: &Path) -> Vec<PathBuf>
```

**Purpose**: Removes write roots that would grant capability write access to `CODEX_HOME` itself or any sandbox control subdirectory. It enforces tamper resistance for sandbox state and helper binaries.

**Data flow**: Takes `roots: Vec<PathBuf>` and `codex_home`. It computes canonical keys and prefixes for `codex_home`, `sandbox_dir(codex_home)`, `sandbox_bin_dir(codex_home)`, and `sandbox_secrets_dir(codex_home)`, then retains only roots whose canonical key is not equal to or nested under any of those protected locations. It returns the filtered vector.

**Call relations**: This is the final stage of `effective_write_roots_for_permissions`. Tests also call it directly to verify that expanded profile roots still cannot include protected Codex directories.

*Call graph*: calls 4 internal fn (canonical_path_key, sandbox_bin_dir, sandbox_dir, sandbox_secrets_dir); called by 1 (effective_write_roots_for_permissions); 1 external calls (format!).


##### `tests::canonical_windows_platform_default_roots`  (lines 1126–1131)

```
fn canonical_windows_platform_default_roots() -> Vec<PathBuf>
```

**Purpose**: Builds the canonicalized form of the hard-coded Windows platform default read roots for assertions. It keeps tests independent of path spelling differences.

**Data flow**: Iterates over `WINDOWS_PLATFORM_DEFAULT_READ_ROOTS`, canonicalizes each path when possible, falls back to `PathBuf::from(path)` otherwise, collects the results, and returns them.

**Call relations**: Several tests use this helper when asserting whether platform defaults were included or excluded from computed read roots.


##### `tests::setup_completion_requires_ready_artifacts`  (lines 1134–1143)

```
fn setup_completion_requires_ready_artifacts()
```

**Purpose**: Verifies that helper success is not enough unless the expected setup artifacts actually exist. It checks the failure code returned by `verify_setup_completed`.

**Data flow**: Creates a temporary codex home, calls `verify_setup_completed`, captures the error, extracts the structured failure, and asserts the code is `OrchestratorHelperIncomplete`.

**Call relations**: This test directly exercises the post-helper validation guard in `verify_setup_completed`.

*Call graph*: calls 1 internal fn (verify_setup_completed); 2 external calls (new, assert_eq!).


##### `tests::permissions_for`  (lines 1145–1154)

```
fn permissions_for(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
    ) -> ResolvedWindowsSandboxPermissions
```

**Purpose**: Resolves a permission profile with workspace roots for use in setup tests. It is a small test-only convenience wrapper.

**Data flow**: Takes a permission profile and workspace roots, calls `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots`, unwraps success with `expect`, and returns the resolved permissions.

**Call relations**: Many setup tests use this helper before calling root-gathering or payload-building functions.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots).


##### `tests::workspace_roots_for`  (lines 1156–1158)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Creates a one-element workspace-root vector from an absolute path for tests. It reduces repeated conversion boilerplate.

**Data flow**: Converts `root: &Path` to `AbsolutePathBuf` and returns it inside a `Vec`.

**Call relations**: Multiple tests call this before resolving permissions.

*Call graph*: 1 external calls (vec!).


##### `tests::workspace_write_profile`  (lines 1160–1171)

```
fn workspace_write_profile(
        writable_roots: &[AbsolutePathBuf],
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> PermissionProfile
```

**Purpose**: Constructs a workspace-write permission profile with configurable writable roots and tmpdir exclusions for tests. It centralizes test profile creation.

**Data flow**: Takes writable roots, network policy, and tmpdir exclusion flags, calls `PermissionProfile::workspace_write_with`, and returns the resulting profile.

**Call relations**: Tests use this helper to generate profiles for write-root and deny-path scenarios.

*Call graph*: calls 1 internal fn (workspace_write_with).


##### `tests::report_helper_failure_uses_setup_error_report_when_clear_succeeded`  (lines 1174–1200)

```
fn report_helper_failure_uses_setup_error_report_when_clear_succeeded()
```

**Purpose**: Checks that helper failure reporting prefers a structured `setup_error.json` report when the orchestrator successfully cleared stale reports before launch. It validates report precedence.

**Data flow**: Writes a `SetupErrorReport` under a temporary codex home, calls `report_helper_failure` with `cleared_report = true`, extracts the resulting `SetupFailure`, and asserts it matches the report contents.

**Call relations**: This test exercises the successful-report-read branch in `report_helper_failure`.

*Call graph*: calls 2 internal fn (extract_failure, write_setup_error_report); 3 external calls (new, assert_eq!, report_helper_failure).


##### `tests::report_helper_failure_ignores_setup_error_report_when_clear_failed`  (lines 1203–1229)

```
fn report_helper_failure_ignores_setup_error_report_when_clear_failed()
```

**Purpose**: Checks that a potentially stale `setup_error.json` is ignored when the orchestrator could not clear reports before launch. It validates the safety guard against reusing old helper reports.

**Data flow**: Writes a `SetupErrorReport`, calls `report_helper_failure` with `cleared_report = false`, extracts the resulting `SetupFailure`, and asserts it is the generic `OrchestratorHelperExitNonzero` failure rather than the report contents.

**Call relations**: This test targets the early stale-report bypass branch in `report_helper_failure`.

*Call graph*: calls 2 internal fn (extract_failure, write_setup_error_report); 3 external calls (new, assert_eq!, report_helper_failure).


##### `tests::setup_refresh_skips_profiles_without_managed_filesystem_permissions`  (lines 1232–1266)

```
fn setup_refresh_skips_profiles_without_managed_filesystem_permissions()
```

**Purpose**: Verifies that refresh entry points quietly no-op for unsupported profiles instead of failing. It covers both the plain and extra-read-roots refresh wrappers.

**Data flow**: Creates temporary workspace and codex-home paths, iterates over `PermissionProfile::Disabled` and `PermissionProfile::External`, and asserts that both `run_setup_refresh` and `run_setup_refresh_with_extra_read_roots` return success.

**Call relations**: This test validates the `let Ok(permissions) = ... else { return Ok(()); }` behavior in the refresh wrappers.

*Call graph*: 7 external calls (new, new, create_dir_all, run_setup_refresh, run_setup_refresh_with_extra_read_roots, vec!, workspace_roots_for).


##### `tests::loopback_proxy_url_parsing_supports_common_forms`  (lines 1269–1282)

```
fn loopback_proxy_url_parsing_supports_common_forms()
```

**Purpose**: Verifies that loopback proxy URL parsing accepts common IPv4, localhost, and IPv6-with-credentials forms. It checks the positive parsing cases.

**Data flow**: Calls `loopback_proxy_port_from_url` with representative URLs and asserts the expected ports are returned.

**Call relations**: This test directly exercises the accepted branches in `loopback_proxy_port_from_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::setup_exe_lookup_checks_package_resource_dir_for_bin_exe`  (lines 1285–1300)

```
fn setup_exe_lookup_checks_package_resource_dir_for_bin_exe()
```

**Purpose**: Verifies that setup helper lookup resolves a packaged helper from the resource directory adjacent to the main executable. It checks deployment-layout awareness.

**Data flow**: Creates a fake package layout with `bin/codex.exe` and `resources/codex-windows-sandbox-setup.exe`, calls `find_setup_exe_for_current_exe`, and asserts the returned path is the resource helper path.

**Call relations**: This test targets the package-relative lookup logic delegated through `bundled_executable_path_for_exe`.

*Call graph*: calls 1 internal fn (find_setup_exe_for_current_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::loopback_proxy_url_parsing_rejects_non_loopback_and_zero_port`  (lines 1303–1310)

```
fn loopback_proxy_url_parsing_rejects_non_loopback_and_zero_port()
```

**Purpose**: Verifies that proxy URL parsing rejects non-loopback hosts, zero ports, and strings without a URL scheme. It checks the negative parsing cases.

**Data flow**: Calls `loopback_proxy_port_from_url` with invalid inputs and asserts each returns `None`.

**Call relations**: This test covers the rejection branches in `loopback_proxy_port_from_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::proxy_ports_from_env_dedupes_and_sorts`  (lines 1313–1330)

```
fn proxy_ports_from_env_dedupes_and_sorts()
```

**Purpose**: Checks that proxy ports extracted from environment variables are deduplicated and sorted, and that non-loopback proxies are ignored. It validates the aggregate parsing behavior.

**Data flow**: Builds an environment map with duplicate loopback proxies and one non-loopback proxy, calls `proxy_ports_from_env`, and asserts the result is the sorted unique vector `[1081, 8080]`.

**Call relations**: This test exercises `proxy_ports_from_env` together with `loopback_proxy_port_from_url`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::offline_proxy_settings_ignore_proxy_env_when_online_identity_selected`  (lines 1333–1351)

```
fn offline_proxy_settings_ignore_proxy_env_when_online_identity_selected()
```

**Purpose**: Verifies that proxy environment variables do not affect setup payloads when the online identity is selected. It checks the early-return branch in offline proxy extraction.

**Data flow**: Builds an environment map containing proxy and local-binding variables, calls `offline_proxy_settings_from_env` with `SandboxNetworkIdentity::Online`, and asserts the result has empty ports and `allow_local_binding = false`.

**Call relations**: This test targets the identity gate in `offline_proxy_settings_from_env`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::offline_proxy_settings_capture_proxy_ports_and_local_binding_for_offline_identity`  (lines 1354–1376)

```
fn offline_proxy_settings_capture_proxy_ports_and_local_binding_for_offline_identity()
```

**Purpose**: Verifies that offline identity captures loopback proxy ports and the local-binding flag from the environment. It checks the positive extraction path.

**Data flow**: Builds an environment map with loopback proxy URLs and `CODEX_NETWORK_ALLOW_LOCAL_BINDING=1`, calls `offline_proxy_settings_from_env` with `Offline`, and asserts the expected `OfflineProxySettings` value.

**Call relations**: This test exercises `offline_proxy_settings_from_env` and its delegation to `proxy_ports_from_env`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::setup_marker_request_mismatch_reason_ignores_proxy_drift_for_online_identity`  (lines 1379–1397)

```
fn setup_marker_request_mismatch_reason_ignores_proxy_drift_for_online_identity()
```

**Purpose**: Verifies that marker drift detection ignores stored-versus-desired proxy differences when the online identity is in use. It prevents unnecessary refreshes for online sandboxes.

**Data flow**: Constructs a `SetupMarker` and desired `OfflineProxySettings`, calls `request_mismatch_reason` with `SandboxNetworkIdentity::Online`, and asserts the result is `None`.

**Call relations**: This test covers the early-return branch in `SetupMarker::request_mismatch_reason`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::setup_marker_request_mismatch_reason_reports_offline_firewall_drift`  (lines 1400–1421)

```
fn setup_marker_request_mismatch_reason_reports_offline_firewall_drift()
```

**Purpose**: Verifies that marker drift detection reports a detailed mismatch string when offline firewall settings have changed. It checks the formatted drift message.

**Data flow**: Constructs a `SetupMarker` and differing desired `OfflineProxySettings`, calls `request_mismatch_reason` with `Offline`, and asserts the returned string matches the expected formatted description.

**Call relations**: This test exercises the mismatch-reporting branch in `SetupMarker::request_mismatch_reason`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::profile_read_roots_excludes_configured_top_level_entries`  (lines 1424–1444)

```
fn profile_read_roots_excludes_configured_top_level_entries()
```

**Purpose**: Verifies that `profile_read_roots` omits configured sensitive top-level profile entries while keeping ordinary files and directories. It checks case-insensitive exclusion behavior.

**Data flow**: Creates a temporary user profile containing allowed entries and excluded directories such as `.ssh`, `.tsh`, and `.AWS`, calls `profile_read_roots`, collects the result into a set, and asserts only the allowed entries remain.

**Call relations**: This test directly validates the filtering logic inside `profile_read_roots`.

*Call graph*: calls 1 internal fn (profile_read_roots); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::profile_read_roots_falls_back_to_profile_root_when_enumeration_fails`  (lines 1447–1454)

```
fn profile_read_roots_falls_back_to_profile_root_when_enumeration_fails()
```

**Purpose**: Verifies that `profile_read_roots` returns the profile root itself when directory enumeration fails. It checks the fallback behavior for missing or unreadable profiles.

**Data flow**: Creates a missing profile path, calls `profile_read_roots`, and asserts the result is a single-element vector containing that path.

**Call relations**: This test covers the error fallback branch in `profile_read_roots`.

*Call graph*: calls 1 internal fn (profile_read_roots); 2 external calls (new, assert_eq!).


##### `tests::is_user_profile_root_exclusion_blocks_configured_children`  (lines 1457–1491)

```
fn is_user_profile_root_exclusion_blocks_configured_children()
```

**Purpose**: Verifies that profile exclusion detection matches configured sensitive children under the user profile but not unrelated paths. It checks nested-path handling.

**Data flow**: Creates a temporary user profile with ordinary and excluded child paths, calls `is_user_profile_root_exclusion` on several examples, and asserts the expected true/false outcomes.

**Call relations**: This test directly exercises the canonical-key and first-child matching logic in `is_user_profile_root_exclusion`.

*Call graph*: 3 external calls (new, assert!, create_dir_all).


##### `tests::is_ssh_config_dependency_root_blocks_config_dependencies`  (lines 1494–1537)

```
fn is_ssh_config_dependency_root_blocks_config_dependencies()
```

**Purpose**: Verifies that roots corresponding to SSH config dependencies are recognized and blocked while unrelated roots are not. It checks dependency discovery plus top-level-child matching.

**Data flow**: Creates a user profile with `.ssh/config` referencing an identity file and included config, computes dependency paths with `ssh_config_dependency_paths`, calls `is_ssh_config_dependency_root` on several roots, and asserts the expected results.

**Call relations**: This test validates the interaction between SSH dependency discovery and root filtering logic.

*Call graph*: 5 external calls (new, assert!, create_dir_all, write, ssh_config_dependency_paths).


##### `tests::expand_user_profile_root_for_replaces_profile_root_with_children`  (lines 1540–1558)

```
fn expand_user_profile_root_for_replaces_profile_root_with_children()
```

**Purpose**: Verifies that expanding a profile root replaces it with its child entries while preserving unrelated roots. It checks the core profile-root expansion behavior.

**Data flow**: Creates a temporary user profile with child directories and another unrelated root, calls `expand_user_profile_root_for` on a vector containing the profile root and the unrelated root, collects the result into a set, and asserts it equals the expected children plus the unrelated root.

**Call relations**: This test directly exercises `expand_user_profile_root_for` and its use of `profile_read_roots`.

*Call graph*: 5 external calls (new, assert_eq!, create_dir_all, expand_user_profile_root_for, vec!).


##### `tests::expanded_write_roots_still_drop_protected_codex_home`  (lines 1561–1577)

```
fn expanded_write_roots_still_drop_protected_codex_home()
```

**Purpose**: Verifies that even after expanding a user profile root, protected Codex home paths are still removed from write roots. It checks the interaction between profile expansion and sensitive-root filtering.

**Data flow**: Creates a user profile containing `CodexHome` and `Documents`, expands the profile root with `expand_user_profile_root_for`, removes the profile root itself and excluded children, passes the result through `filter_sensitive_write_roots`, and asserts only `Documents` remains.

**Call relations**: This test validates that `filter_sensitive_write_roots` still protects Codex state after earlier expansion/filtering stages.

*Call graph*: 7 external calls (new, assert_eq!, create_dir_all, canonical_path_key, expand_user_profile_root_for, filter_sensitive_write_roots, vec!).


##### `tests::gather_read_roots_includes_helper_bin_dir`  (lines 1580–1594)

```
fn gather_read_roots_includes_helper_bin_dir()
```

**Purpose**: Verifies that computed read roots always include the helper binary directory. It checks the mandatory helper-root behavior.

**Data flow**: Creates temporary codex-home and workspace paths, resolves a read-only permission profile, calls `gather_read_roots`, canonicalizes `helper_bin_dir(codex_home)`, and asserts the helper path is present in the result.

**Call relations**: This test exercises `gather_read_roots` and its delegation to `gather_helper_read_roots`.

*Call graph*: calls 3 internal fn (read_only, helper_bin_dir, gather_read_roots); 7 external calls (new, new, assert!, canonicalize, create_dir_all, permissions_for, workspace_roots_for).


##### `tests::workspace_write_roots_remain_readable`  (lines 1597–1620)

```
fn workspace_write_roots_remain_readable()
```

**Purpose**: Verifies that writable roots are also included in the readable root set for workspace-write scenarios. It preserves the legacy expectation that writable locations remain readable.

**Data flow**: Creates codex-home, workspace, and an extra writable root, resolves a workspace-write profile, calls `gather_read_roots`, canonicalizes the writable root, and asserts it is present in the read-root list.

**Call relations**: This test covers the path where `gather_read_roots` includes writable roots through permission-derived readable roots.

*Call graph*: calls 1 internal fn (gather_read_roots); 9 external calls (new, new, assert!, canonicalize, create_dir_all, vec!, permissions_for, workspace_roots_for, workspace_write_profile).


##### `tests::build_payload_roots_preserves_helper_roots_when_read_override_is_provided`  (lines 1623–1667)

```
fn build_payload_roots_preserves_helper_roots_when_read_override_is_provided()
```

**Purpose**: Verifies that explicit read-root overrides replace policy-derived readable roots but still preserve helper roots and optionally platform defaults. It checks override semantics.

**Data flow**: Creates codex-home, workspace, and a readable root, resolves a read-only profile, calls `build_payload_roots` with a read-root override and `read_roots_include_platform_defaults = true`, canonicalizes expected helper/workspace/readable paths, and asserts helper and readable roots are present, cwd is absent, write roots are empty, and all canonical platform defaults are included.

**Call relations**: This test directly exercises the override branch in `build_payload_roots`.

*Call graph*: calls 3 internal fn (read_only, helper_bin_dir, build_payload_roots); 9 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, vec!, permissions_for, workspace_roots_for).


##### `tests::build_payload_roots_replaces_full_read_policy_when_read_override_is_provided`  (lines 1670–1714)

```
fn build_payload_roots_replaces_full_read_policy_when_read_override_is_provided()
```

**Purpose**: Verifies that explicit read-root overrides suppress automatic inclusion of platform defaults when the corresponding flag is false. It checks the stricter override mode.

**Data flow**: Creates codex-home, workspace, and a readable root, resolves a read-only profile, calls `build_payload_roots` with a read-root override and `read_roots_include_platform_defaults = false`, and asserts helper and readable roots are present, cwd is absent, write roots are empty, and canonical platform defaults are absent.

**Call relations**: This test covers the same override branch in `build_payload_roots` with platform-default inclusion disabled.

*Call graph*: calls 3 internal fn (read_only, helper_bin_dir, build_payload_roots); 9 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, vec!, permissions_for, workspace_roots_for).


##### `tests::effective_write_roots_match_payload_filtering_for_overrides`  (lines 1717–1773)

```
fn effective_write_roots_match_payload_filtering_for_overrides()
```

**Purpose**: Verifies that direct effective-write-root computation matches the write roots embedded in payload construction when overrides are supplied. It also checks that protected Codex paths are removed.

**Data flow**: Creates codex-home, workspace, extra root, and sandbox root, resolves a workspace-write profile, builds an override list including allowed and forbidden roots, computes `effective_write_roots_for_setup`, computes payload roots via `build_payload_roots`, canonicalizes expected and forbidden paths, and asserts the two write-root results match, include workspace and extra root, and exclude codex-home and sandbox root.

**Call relations**: This test validates consistency between `effective_write_roots_for_setup` and `build_payload_roots`.

*Call graph*: calls 1 internal fn (build_payload_roots); 12 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, effective_write_roots_for_setup, sandbox_dir, vec!, permissions_for (+2 more)).


##### `tests::effective_write_roots_use_runtime_workspace_roots_for_workspace_root`  (lines 1776–1804)

```
fn effective_write_roots_use_runtime_workspace_roots_for_workspace_root()
```

**Purpose**: Verifies that effective write-root computation resolves symbolic workspace-root permissions to the actual runtime workspace root. It checks workspace-root materialization through the setup filtering pipeline.

**Data flow**: Creates codex-home, workspace root, and nested command cwd, resolves a workspace-write profile, calls `effective_write_roots_for_setup` without overrides, and asserts the result is the canonical workspace root.

**Call relations**: This test exercises `effective_write_roots_for_setup` together with permission resolution and write-root filtering.

*Call graph*: 8 external calls (new, new, assert_eq!, create_dir_all, effective_write_roots_for_setup, permissions_for, workspace_roots_for, workspace_write_profile).


##### `tests::payload_deny_write_paths_merge_explicit_and_protected_children`  (lines 1807–1848)

```
fn payload_deny_write_paths_merge_explicit_and_protected_children()
```

**Purpose**: Verifies that deny-write payload construction merges explicit deny paths with deny paths derived from protected children such as `.git` and `.codex` under writable roots. It checks deny-path aggregation.

**Data flow**: Creates codex-home, workspace, extra writable root, protected child directories, and an explicit deny path, resolves a workspace-write profile, builds a `SandboxSetupRequest`, calls `build_payload_deny_write_paths`, and asserts the resulting set contains the canonical protected children plus the explicit deny path.

**Call relations**: This test directly exercises `build_payload_deny_write_paths` and its delegation to `compute_allow_paths_for_permissions`.

*Call graph*: 9 external calls (new, new, assert_eq!, create_dir_all, build_payload_deny_write_paths, vec!, permissions_for, workspace_roots_for, workspace_write_profile).


##### `tests::full_read_roots_preserve_legacy_platform_defaults`  (lines 1851–1872)

```
fn full_read_roots_preserve_legacy_platform_defaults()
```

**Purpose**: Verifies that full-read root gathering still includes the legacy Windows platform default roots. It checks backward-compatible behavior for broad-read profiles.

**Data flow**: Creates codex-home and workspace, resolves a read-only profile, calls `gather_full_read_roots_for_permissions`, and asserts all canonical platform default roots are present.

**Call relations**: This test directly validates `gather_full_read_roots_for_permissions`.

*Call graph*: calls 2 internal fn (read_only, gather_full_read_roots_for_permissions); 6 external calls (new, new, assert!, create_dir_all, permissions_for, workspace_roots_for).


##### `tests::build_payload_deny_read_paths_preserves_explicit_paths`  (lines 1875–1885)

```
fn build_payload_deny_read_paths_preserves_explicit_paths()
```

**Purpose**: Verifies that deny-read payload construction preserves explicit path spellings for both existing and missing paths. It checks the no-canonicalization design choice.

**Data flow**: Creates an existing file path and a missing future path, calls `build_payload_deny_read_paths(Some(vec![...]))`, and asserts the returned vector exactly matches the input order and spelling.

**Call relations**: This test targets the intentionally trivial behavior of `build_payload_deny_read_paths`.

*Call graph*: 3 external calls (new, assert_eq!, write).


### `windows-sandbox-rs/src/identity.rs`

`domain_logic` · `sandbox setup validation and credential acquisition before launch`

This file bridges persistent setup artifacts and runtime process launch. It defines an internal `SandboxIdentity` and the public `SandboxCreds`, then provides helpers to inspect setup readiness and decode stored credentials. Setup state is split across a marker file and a users file; `sandbox_setup_is_complete` checks both for existence and version compatibility. `load_marker` and `load_users` read JSON from paths derived by `setup_marker_path` and `sandbox_users_path`, returning `Ok(None)` on missing files or parse/read failures while emitting `debug_log` diagnostics instead of hard errors.

Passwords are stored encrypted and base64-encoded. `decode_password` base64-decodes the stored blob, decrypts it with DPAPI via `dpapi::unprotect`, and converts the result to UTF-8. `select_identity` combines marker validation, users-file validation, network-mode selection (`offline` vs `online` record), and password decoding into an optional runtime identity.

The main entry point, `require_logon_sandbox_creds`, computes the exact read/write roots needed for the current command, derives the desired `SandboxNetworkIdentity` from permissions and proxy enforcement, and compares that against the setup marker's recorded request. If setup is missing, version-mismatched, or proxy/network settings differ, it logs why setup is required and runs `run_elevated_setup` with explicit root overrides. Regardless of whether elevated setup was needed, it always runs `run_setup_refresh_with_overrides` afterward to refresh ACLs for the current roots. If credentials still cannot be selected, it returns a hard error instructing the caller to rerun setup with elevation. `refresh_logon_sandbox_creds` is the stale-credential recovery path: it deletes the users file and reruns the full credential requirement flow.

#### Function details

##### `sandbox_setup_is_complete`  (lines 42–48)

```
fn sandbox_setup_is_complete(codex_home: &Path) -> bool
```

**Purpose**: Performs a coarse readiness check for sandbox setup artifacts under `codex_home`. It verifies that both the setup marker and users file exist and match the current setup version.

**Data flow**: It takes `codex_home`, calls `load_marker` and checks `version_matches()` on the returned marker, then calls `load_users` and checks `version_matches()` on the returned users file. It returns `true` only if both checks succeed; otherwise it returns `false`.

**Call relations**: It is called by setup-verification code that wants a quick readiness signal without performing full runtime validation. Unlike `require_logon_sandbox_creds`, it does not inspect proxy settings or refresh ACLs.

*Call graph*: called by 1 (verify_setup_completed); 1 external calls (matches!).


##### `load_marker`  (lines 50–73)

```
fn load_marker(codex_home: &Path) -> Result<Option<SetupMarker>>
```

**Purpose**: Reads and parses the sandbox setup marker JSON file, degrading parse and read failures into `None` while emitting debug diagnostics. This keeps callers resilient to missing or corrupted setup state.

**Data flow**: It takes `codex_home`, computes the marker path with `setup_marker_path`, and attempts `fs::read_to_string`. Missing files become `Ok(None)`; successful reads are parsed as `SetupMarker` with `serde_json::from_str`, returning `Some(marker)` on success. Parse failures and non-NotFound read failures are logged with `debug_log` and converted to `Ok(None)`.

**Call relations**: It is used by both `sandbox_setup_is_complete`, `select_identity`, and `require_logon_sandbox_creds`. Its tolerant behavior lets higher-level logic decide whether to trigger setup rather than failing immediately on malformed state.

*Call graph*: calls 2 internal fn (debug_log, setup_marker_path); called by 2 (require_logon_sandbox_creds, select_identity); 2 external calls (format!, read_to_string).


##### `load_users`  (lines 75–98)

```
fn load_users(codex_home: &Path) -> Result<Option<SandboxUsersFile>>
```

**Purpose**: Reads and parses the sandbox users JSON file containing online/offline account records. Like `load_marker`, it treats missing or malformed state as absent and logs debug details.

**Data flow**: It takes `codex_home`, computes the users-file path with `sandbox_users_path`, and reads it as a string. A missing file returns `Ok(None)` immediately; other read failures are debug-logged and also return `Ok(None)`. Successful reads are parsed as `SandboxUsersFile`; parse success returns `Ok(Some(users))`, while parse failure logs and returns `Ok(None)`.

**Call relations**: It is called by `sandbox_setup_is_complete` and `select_identity`. This helper isolates the file-format boundary so credential selection can focus on version and network-mode logic.

*Call graph*: calls 2 internal fn (debug_log, sandbox_users_path); called by 1 (select_identity); 2 external calls (format!, read_to_string).


##### `remove_sandbox_users_file`  (lines 100–111)

```
fn remove_sandbox_users_file(codex_home: &Path, reason: &str) -> Result<()>
```

**Purpose**: Deletes the persisted sandbox users file, typically to force regeneration after stale or invalid credentials are detected. Missing files are treated as already-clean state.

**Data flow**: It takes `codex_home` and a textual reason, computes the users-file path with `sandbox_users_path`, logs a debug message naming the file being deleted, and calls `fs::remove_file`. Successful deletion and `NotFound` both return `Ok(())`; other filesystem errors are returned with path context.

**Call relations**: It is used by `refresh_logon_sandbox_creds` as the first step in stale-credential recovery, and is covered by tests for both existing and missing files. The debug log preserves the reason for deletion without surfacing it to normal logs.

*Call graph*: calls 2 internal fn (debug_log, sandbox_users_path); called by 3 (refresh_logon_sandbox_creds, remove_sandbox_users_file_deletes_existing_file, remove_sandbox_users_file_ignores_missing_file); 2 external calls (format!, remove_file).


##### `decode_password`  (lines 113–120)

```
fn decode_password(record: &SandboxUserRecord) -> Result<String>
```

**Purpose**: Decodes and decrypts a stored sandbox password from a `SandboxUserRecord`. It converts the persisted base64+DPAPI representation into a plain Rust `String`.

**Data flow**: It takes a user record, base64-decodes `record.password`, decrypts the resulting bytes with `dpapi::unprotect`, converts the decrypted bytes from UTF-8 into a `String`, and returns that string. Any decode, decrypt, or UTF-8 conversion failure is propagated as an error.

**Call relations**: It is called only by `select_identity` after the correct online/offline user record has been chosen. This keeps cryptographic decoding separate from setup-state selection logic.

*Call graph*: calls 1 internal fn (unprotect); called by 1 (select_identity); 1 external calls (from_utf8).


##### `select_identity`  (lines 122–143)

```
fn select_identity(
    network_identity: SandboxNetworkIdentity,
    codex_home: &Path,
) -> Result<Option<SandboxIdentity>>
```

**Purpose**: Selects the appropriate sandbox account record for the requested network identity and returns decrypted credentials if setup artifacts are present and version-compatible. It returns `None` when setup state is absent or incompatible.

**Data flow**: It takes a `SandboxNetworkIdentity` and `codex_home`, loads the marker and users file, and requires both to exist and report `version_matches()`. It then chooses either `users.offline` or `users.online` based on the requested network identity, decrypts the chosen password with `decode_password`, and returns `Ok(Some(SandboxIdentity { username, password }))`; any missing/incompatible setup state yields `Ok(None)`.

**Call relations**: It is called by `require_logon_sandbox_creds` both before and after setup execution. It depends on `load_marker`, `load_users`, and `decode_password` to collapse persistent setup state into runtime credentials.

*Call graph*: calls 3 internal fn (decode_password, load_marker, load_users); called by 1 (require_logon_sandbox_creds).


##### `require_logon_sandbox_creds`  (lines 146–248)

```
fn require_logon_sandbox_creds(
    permissions: &ResolvedWindowsSandboxPermissions,
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
    codex_home: &Path,
    read_roots_override: Opti
```

**Purpose**: Ensures that valid sandbox logon credentials exist for the current permission set and filesystem roots, running elevated setup if necessary and always refreshing ACLs for the current request. It is the main credential-acquisition entry point used before sandbox launch.

**Data flow**: It takes resolved permissions, command cwd, environment map, `codex_home`, optional read/write root overrides, deny-path overrides, and a proxy-enforced flag. The function computes `needed_read` and `needed_write` roots from overrides or `gather_read_roots`/`gather_write_roots_for_permissions`, derives `SandboxNetworkIdentity::from_permissions`, and computes desired offline proxy settings from the environment. It then loads the setup marker and checks for version or request mismatches; if the marker is missing, incompatible, or the selected identity cannot be loaded, it records a setup reason, logs that setup is required, and calls `run_elevated_setup` with a `SandboxSetupRequest` plus `SetupRootOverrides` containing the exact roots and deny lists. Afterward it retries `select_identity`. Regardless of whether elevated setup ran, it calls `run_setup_refresh_with_overrides` to refresh ACLs for the current roots. Finally it converts the selected identity into public `SandboxCreds` or returns an error if credentials are still unavailable.

**Call relations**: It is called by elevated capture and other spawn-preparation paths whenever a sandboxed process must log on as a sandbox user. It orchestrates marker/users loading, identity selection, setup triggering, and ACL refresh, delegating root computation to setup helpers and persistence checks to `load_marker`/`select_identity`.

*Call graph*: calls 8 internal fn (load_marker, select_identity, log_note, from_permissions, offline_proxy_settings_from_env, run_elevated_setup, run_setup_refresh_with_overrides, sandbox_dir); called by 3 (run_windows_sandbox_capture_for_permission_profile, refresh_logon_sandbox_creds, prepare_elevated_spawn_context_for_permissions); 2 external calls (to_vec, format!).


##### `refresh_logon_sandbox_creds`  (lines 251–276)

```
fn refresh_logon_sandbox_creds(
    permissions: &ResolvedWindowsSandboxPermissions,
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
    codex_home: &Path,
    read_roots_override: Opti
```

**Purpose**: Forces regeneration of sandbox credentials after a login failure by deleting the persisted users file and rerunning the normal credential requirement flow. It is the stale-credential recovery path.

**Data flow**: It takes the same arguments as `require_logon_sandbox_creds`, calls `remove_sandbox_users_file(codex_home, "sandbox user login failed")`, then immediately calls `require_logon_sandbox_creds` with the original arguments and returns its `SandboxCreds` result.

**Call relations**: It is invoked by higher-level launch code when a runner transport failure is recognized as stale sandbox credentials. Its only job is to invalidate cached user records and delegate back to the main credential-acquisition routine.

*Call graph*: calls 2 internal fn (remove_sandbox_users_file, require_logon_sandbox_creds); called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile).


##### `tests::remove_sandbox_users_file_deletes_existing_file`  (lines 286–295)

```
fn remove_sandbox_users_file_deletes_existing_file()
```

**Purpose**: Verifies that deleting the sandbox users file removes an existing file from disk. It covers the successful deletion branch.

**Data flow**: The test creates a temporary `codex_home`, computes the users-file path, creates parent directories, writes a dummy file, calls `remove_sandbox_users_file`, and asserts that the file no longer exists.

**Call relations**: It directly exercises `remove_sandbox_users_file` with a present file. This test ensures stale-credential recovery can actually clear persisted user state.

*Call graph*: calls 2 internal fn (remove_sandbox_users_file, sandbox_users_path); 4 external calls (new, assert!, create_dir_all, write).


##### `tests::remove_sandbox_users_file_ignores_missing_file`  (lines 298–304)

```
fn remove_sandbox_users_file_ignores_missing_file()
```

**Purpose**: Verifies that deleting the sandbox users file succeeds even when the file is absent. It covers the `NotFound` branch.

**Data flow**: The test creates a temporary `codex_home`, computes the expected users-file path, calls `remove_sandbox_users_file` without creating the file, and asserts that the path still does not exist.

**Call relations**: It validates the idempotent cleanup behavior relied on by `refresh_logon_sandbox_creds`. This prevents stale-credential recovery from failing just because the users file was already missing.

*Call graph*: calls 2 internal fn (remove_sandbox_users_file, sandbox_users_path); 2 external calls (new, assert!).


### `windows-sandbox-rs/src/acl.rs`

`domain_logic` · `sandbox setup, ACL enforcement, and permission repair`

This file is the low-level ACL manipulation core for the Windows sandbox implementation. It wraps Win32 security APIs such as `GetSecurityInfo`, `GetNamedSecurityInfoW`, `SetEntriesInAclW`, `SetNamedSecurityInfoW`, and `SetSecurityInfo`, translating them into `anyhow::Result`-based Rust helpers. The code works directly with raw `ACL` pointers, ACE headers, SID pointers (`*mut c_void`), and manually managed security descriptors that must be released with `LocalFree`.

A major design choice is to separate read-only inspection from mutation. Inspection helpers iterate ACEs with `GetAclInformation` and `GetAce`, skip `INHERIT_ONLY_ACE` entries because they do not apply to the current object, and compare ACE SIDs with `EqualSid`. `dacl_mask_allows` additionally maps generic access bits through a `GENERIC_MAPPING` before testing masks, which avoids false negatives when ACEs use generic file rights. Mutation helpers first avoid unnecessary rewrites by checking whether the desired ACE is already present, then build `EXPLICIT_ACCESS_W` entries and merge them into a new DACL with `SetEntriesInAclW`. Error paths consistently free allocated DACL/security-descriptor memory before returning. The file also includes special handling for the `NUL` device as a kernel object so redirected stdio remains usable under restricted tokens.

#### Function details

##### `fetch_dacl_handle`  (lines 62–97)

```
fn fetch_dacl_handle(path: &Path) -> Result<(*mut ACL, *mut c_void)>
```

**Purpose**: Opens a filesystem path for `READ_CONTROL` and retrieves its DACL and backing security descriptor via the handle-based security API.

**Data flow**: Accepts a `&Path`, converts it to UTF-16 with `to_wide`, opens the path with `CreateFileW` using backup semantics so directories work, then calls `GetSecurityInfo` for `DACL_SECURITY_INFORMATION`. It returns `Ok((p_dacl, p_sd))` on success, where `p_sd` must later be freed with `LocalFree`; on failure it closes the handle and returns an `anyhow` error describing the path and Win32 status code.

**Call relations**: Used by `path_mask_allows` and `ensure_allow_mask_aces_with_inheritance_impl` as the shared DACL-fetch primitive before either inspecting or modifying ACL state.

*Call graph*: calls 1 internal fn (to_wide); called by 2 (ensure_allow_mask_aces_with_inheritance_impl, path_mask_allows); 5 external calls (anyhow!, null_mut, CloseHandle, GetSecurityInfo, CreateFileW).


##### `dacl_mask_allows`  (lines 101–161)

```
fn dacl_mask_allows(
    p_dacl: *mut ACL,
    psids: &[*mut c_void],
    desired_mask: u32,
    require_all_bits: bool,
) -> bool
```

**Purpose**: Scans a DACL for non-inherit-only allow ACEs matching any of the supplied SIDs and tests whether they grant the requested access mask.

**Data flow**: Takes a raw `ACL` pointer, a slice of SID pointers, a desired mask, and a `require_all_bits` flag. It reads ACL size information, iterates ACEs, filters to `ACCESS_ALLOWED_ACE_TYPE`, skips inherit-only ACEs, computes the ACE SID pointer from the ACE layout, compares against the provided SIDs, maps generic rights to concrete file rights with `MapGenericMask`, and returns `true` if either all requested bits or any requested bit is present according to the flag; otherwise it returns `false`.

**Call relations**: Called by `path_mask_allows` for path-based checks and by `ensure_allow_mask_aces_with_inheritance_impl` to avoid adding redundant allow ACEs.

*Call graph*: called by 2 (ensure_allow_mask_aces_with_inheritance_impl, path_mask_allows); 7 external calls (is_null, zeroed, null_mut, EqualSid, GetAce, GetAclInformation, MapGenericMask).


##### `path_mask_allows`  (lines 164–178)

```
fn path_mask_allows(
    path: &Path,
    psids: &[*mut c_void],
    desired_mask: u32,
    require_all_bits: bool,
) -> Result<bool>
```

**Purpose**: Convenience wrapper that fetches a path’s DACL, checks it with `dacl_mask_allows`, and frees the returned security descriptor.

**Data flow**: Accepts a path, SID slice, desired mask, and `require_all_bits`. It calls `fetch_dacl_handle`, passes the returned DACL into `dacl_mask_allows`, frees the security descriptor with `LocalFree` if non-null, and returns `Result<bool>`.

**Call relations**: Used by higher-level audit code to test whether a path is world-writable without exposing raw ACL pointer management to callers.

*Call graph*: calls 2 internal fn (dacl_mask_allows, fetch_dacl_handle); called by 1 (path_has_world_write_allow); 1 external calls (LocalFree).


##### `dacl_has_write_allow_for_sid`  (lines 180–219)

```
fn dacl_has_write_allow_for_sid(p_dacl: *mut ACL, psid: *mut c_void) -> bool
```

**Purpose**: Checks whether a DACL already contains an applicable allow ACE for one SID that includes `FILE_GENERIC_WRITE`.

**Data flow**: Takes a DACL pointer and SID pointer, reads ACL metadata, iterates ACEs, filters to allow ACEs that are not inherit-only, extracts the ACE SID, compares it with `EqualSid`, and returns `true` if the ACE mask includes `FILE_GENERIC_WRITE`.

**Call relations**: Used by `add_allow_ace` as a fast pre-check to skip rewriting the DACL when the target SID already has write-capable access.

*Call graph*: called by 1 (add_allow_ace); 6 external calls (is_null, zeroed, null_mut, EqualSid, GetAce, GetAclInformation).


##### `dacl_has_write_deny_for_sid`  (lines 221–264)

```
fn dacl_has_write_deny_for_sid(p_dacl: *mut ACL, psid: *mut c_void) -> bool
```

**Purpose**: Checks whether a DACL already contains an applicable deny ACE for one SID that blocks write-like or delete-like operations.

**Data flow**: Accepts a DACL pointer and SID pointer, computes a composite deny-write mask including generic write, write data, append, EA, attributes, delete, and delete-child rights, then scans deny ACEs for a matching SID and overlapping mask bits. It returns `true` on the first match, otherwise `false`.

**Call relations**: Reached through `DenyAceKind::already_present` when `add_deny_ace` is deciding whether a write-deny ACE needs to be added.

*Call graph*: called by 1 (already_present); 6 external calls (is_null, zeroed, null_mut, EqualSid, GetAce, GetAclInformation).


##### `dacl_has_read_deny_for_sid`  (lines 266–302)

```
fn dacl_has_read_deny_for_sid(p_dacl: *mut ACL, psid: *mut c_void) -> bool
```

**Purpose**: Checks whether a DACL already contains an applicable deny ACE for one SID that blocks read access.

**Data flow**: Accepts a DACL pointer and SID pointer, builds a deny-read mask from `FILE_GENERIC_READ | GENERIC_READ_MASK`, scans deny ACEs that are not inherit-only, compares ACE SIDs to the target SID, and returns whether any matching ACE denies those read bits.

**Call relations**: Reached through `DenyAceKind::already_present` when `add_deny_ace` is handling the read-deny case.

*Call graph*: called by 1 (already_present); 6 external calls (is_null, zeroed, null_mut, EqualSid, GetAce, GetAclInformation).


##### `ensure_allow_mask_aces_with_inheritance_impl`  (lines 307–376)

```
fn ensure_allow_mask_aces_with_inheritance_impl(
    path: &Path,
    sids: &[*mut c_void],
    allow_mask: u32,
    inheritance: u32,
) -> Result<bool>
```

**Purpose**: Ensures each supplied SID has an allow ACE with a specific mask and inheritance flags on a filesystem path, adding only the missing entries.

**Data flow**: Takes a path, SID slice, allow mask, and inheritance flags. It fetches the current DACL, builds a `Vec<EXPLICIT_ACCESS_W>` only for SIDs that `dacl_mask_allows` says do not already have the full mask, merges those entries into a new ACL with `SetEntriesInAclW`, writes the new DACL back with `SetNamedSecurityInfoW`, frees any allocated ACL/security-descriptor memory, and returns `Ok(true)` if at least one ACE was added, `Ok(false)` if nothing was needed, or an error if ACL merge/write fails.

**Call relations**: This is the real implementation behind the public allow-ensuring wrappers; `ensure_allow_mask_aces_with_inheritance` delegates directly to it.

*Call graph*: calls 3 internal fn (dacl_mask_allows, fetch_dacl_handle, to_wide); called by 1 (ensure_allow_mask_aces_with_inheritance); 6 external calls (new, anyhow!, null_mut, LocalFree, SetEntriesInAclW, SetNamedSecurityInfoW).


##### `ensure_allow_mask_aces_with_inheritance`  (lines 383–390)

```
fn ensure_allow_mask_aces_with_inheritance(
    path: &Path,
    sids: &[*mut c_void],
    allow_mask: u32,
    inheritance: u32,
) -> Result<bool>
```

**Purpose**: Public unsafe wrapper that exposes the inheritance-aware allow-ACE ensuring operation.

**Data flow**: Passes its path, SID slice, allow mask, and inheritance flags straight through to `ensure_allow_mask_aces_with_inheritance_impl` and returns the resulting `Result<bool>`.

**Call relations**: Called by `ensure_allow_mask_aces` to provide the lower-level variant where callers choose inheritance explicitly.

*Call graph*: calls 1 internal fn (ensure_allow_mask_aces_with_inheritance_impl); called by 1 (ensure_allow_mask_aces).


##### `ensure_allow_mask_aces`  (lines 397–408)

```
fn ensure_allow_mask_aces(
    path: &Path,
    sids: &[*mut c_void],
    allow_mask: u32,
) -> Result<bool>
```

**Purpose**: Ensures each supplied SID has an allow ACE with the requested mask using standard container and object inheritance.

**Data flow**: Accepts a path, SID slice, and allow mask, then calls `ensure_allow_mask_aces_with_inheritance` with `CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE` and returns its result.

**Call relations**: Acts as the common public helper for inherited filesystem allow ACEs and is used by `ensure_allow_write_aces`.

*Call graph*: calls 1 internal fn (ensure_allow_mask_aces_with_inheritance); called by 1 (ensure_allow_write_aces).


##### `ensure_allow_write_aces`  (lines 415–417)

```
fn ensure_allow_write_aces(path: &Path, sids: &[*mut c_void]) -> Result<bool>
```

**Purpose**: Ensures each supplied SID has the file-access mask defined by `WRITE_ALLOW_MASK` on the target path.

**Data flow**: Takes a path and SID slice, forwards them to `ensure_allow_mask_aces` with the constant `WRITE_ALLOW_MASK`, and returns whether any ACEs were added.

**Call relations**: Provides a semantic convenience wrapper for callers that want the crate’s standard write-capable allow set rather than an arbitrary mask.

*Call graph*: calls 1 internal fn (ensure_allow_mask_aces).


##### `add_allow_ace`  (lines 423–483)

```
fn add_allow_ace(path: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: Adds an inherited allow ACE granting read, write, and execute rights to one SID on a path if a write-capable allow ACE is not already present.

**Data flow**: Accepts a path and SID pointer, fetches the named object’s DACL with `GetNamedSecurityInfoW`, checks `dacl_has_write_allow_for_sid`, and if absent constructs one `EXPLICIT_ACCESS_W` with `SET_ACCESS` and inherited RXW permissions. It merges that ACE into a new DACL, writes it back with `SetNamedSecurityInfoW`, frees temporary ACL/security-descriptor allocations, and returns `Ok(true)` if it added access, `Ok(false)` if access already existed or the write-back path did not mark an addition, or an error if the initial security query failed.

**Call relations**: Used by legacy ACL-application flows that need to grant a capability or user SID write-capable access to a path.

*Call graph*: calls 2 internal fn (dacl_has_write_allow_for_sid, to_wide); called by 1 (apply_legacy_session_acl_rules); 7 external calls (anyhow!, zeroed, null_mut, LocalFree, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW).


##### `add_deny_write_ace`  (lines 489–491)

```
fn add_deny_write_ace(path: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: Adds an inherited deny ACE that blocks write-like operations for one SID on a path.

**Data flow**: Takes a path and SID pointer and forwards them to `add_deny_ace` with `DenyAceKind::Write`, returning the resulting `Result<bool>`.

**Call relations**: Called by multiple higher-level enforcement paths, including world-writable audit remediation and workspace protection logic, as the write-deny convenience entrypoint.

*Call graph*: calls 1 internal fn (add_deny_ace); called by 3 (apply_capability_denies_for_world_writable_for_permissions, apply_legacy_session_acl_rules, protect_workspace_subdir).


##### `DenyAceKind::mask`  (lines 500–514)

```
fn mask(self) -> u32
```

**Purpose**: Maps a deny-ACE kind to the exact access mask that should be denied.

**Data flow**: Consumes `self` and returns a `u32` mask: read denies use `FILE_GENERIC_READ | GENERIC_READ_MASK`, while write denies include generic write plus write-data, append, EA, attributes, delete, and delete-child bits.

**Call relations**: Used inside `add_deny_ace` to populate `EXPLICIT_ACCESS_W.grfAccessPermissions` for the deny ACE being created.

*Call graph*: called by 1 (add_deny_ace).


##### `DenyAceKind::already_present`  (lines 516–521)

```
fn already_present(self, p_dacl: *mut ACL, psid: *mut c_void) -> bool
```

**Purpose**: Checks whether the corresponding deny ACE already exists for a SID in a given DACL.

**Data flow**: Accepts `self`, a DACL pointer, and a SID pointer, dispatching to either `dacl_has_read_deny_for_sid` or `dacl_has_write_deny_for_sid` and returning that boolean result.

**Call relations**: Called by `add_deny_ace` before mutating the DACL so duplicate deny ACEs are not added.

*Call graph*: calls 2 internal fn (dacl_has_read_deny_for_sid, dacl_has_write_deny_for_sid); called by 1 (add_deny_ace).


##### `add_deny_ace`  (lines 524–578)

```
fn add_deny_ace(path: &Path, psid: *mut c_void, kind: DenyAceKind) -> Result<bool>
```

**Purpose**: Shared implementation for adding inherited read- or write-deny ACEs to a path when the deny is not already present.

**Data flow**: Accepts a path, SID pointer, and `DenyAceKind`. It fetches the current DACL with `GetNamedSecurityInfoW`, checks `kind.already_present`, and if absent builds a trustee and `EXPLICIT_ACCESS_W` using `DENY_ACCESS`, `kind.mask()`, and inherited flags. It merges the deny ACE with `SetEntriesInAclW`, writes the new DACL with `SetNamedSecurityInfoW`, frees temporary allocations, and returns whether a deny ACE was added.

**Call relations**: This is the common mutation path behind both `add_deny_read_ace` and `add_deny_write_ace`.

*Call graph*: calls 3 internal fn (already_present, mask, to_wide); called by 2 (add_deny_read_ace, add_deny_write_ace); 7 external calls (anyhow!, zeroed, null_mut, LocalFree, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW).


##### `add_deny_read_ace`  (lines 589–591)

```
fn add_deny_read_ace(path: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: Adds an inherited deny ACE that blocks read access for one SID on a path.

**Data flow**: Takes a path and SID pointer and delegates to `add_deny_ace` with `DenyAceKind::Read`, returning the resulting `Result<bool>`.

**Call relations**: Used by callers that need explicit read denial; it relies on `add_deny_ace` for ordering and inheritance behavior.

*Call graph*: calls 1 internal fn (add_deny_ace).


##### `revoke_ace`  (lines 593–643)

```
fn revoke_ace(path: &Path, psid: *mut c_void)
```

**Purpose**: Removes ACEs associated with a SID from a path’s DACL using `REVOKE_ACCESS` semantics, ignoring failures after the initial query.

**Data flow**: Accepts a path and SID pointer, fetches the current DACL, constructs an `EXPLICIT_ACCESS_W` with zero permissions and access mode `4` (`REVOKE_ACCESS`), merges it into a new DACL with `SetEntriesInAclW`, attempts to write the result back with `SetNamedSecurityInfoW`, and frees any allocated ACL/security-descriptor memory. It returns no value and silently exits on query failure.

**Call relations**: Invoked by higher-level deny-read synchronization code when previously applied ACEs need to be removed.

*Call graph*: calls 1 internal fn (to_wide); called by 2 (apply_deny_read_acls, sync_persistent_deny_read_acls); 6 external calls (zeroed, null_mut, LocalFree, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW).


##### `allow_null_device`  (lines 649–710)

```
fn allow_null_device(psid: *mut c_void)
```

**Purpose**: Grants a SID read/write/execute access to the `NUL` device object so redirected stdio continues to work under restricted tokens.

**Data flow**: Accepts a SID pointer, opens `\\.\NUL` with enough rights to read and modify its DACL, retrieves the kernel-object DACL with `GetSecurityInfo`, constructs a non-inherited `EXPLICIT_ACCESS_W` granting generic read/write/execute, merges it with `SetEntriesInAclW`, writes it back with `SetSecurityInfo`, frees temporary allocations, and closes the device handle. If opening or querying fails, it returns early without error reporting.

**Call relations**: Called during sandboxed process setup so capability or sandbox-user SIDs can interact with the null device used for stdout/stderr redirection.

*Call graph*: calls 1 internal fn (to_wide); called by 4 (run_windows_sandbox_capture_for_permission_profile, allow_null_device_for_workspace_write, apply_legacy_session_acl_rules, prepare_elevated_spawn_context_for_permissions); 8 external calls (zeroed, null_mut, CloseHandle, LocalFree, GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo, CreateFileW).


### `windows-sandbox-rs/src/token.rs`

`domain_logic` · `sandbox token construction and Windows security setup`

This file is the core Windows security-token utility layer for the sandbox. It wraps a set of low-level `windows_sys` calls to inspect process tokens, construct restricted tokens, and prepare them so sandboxed processes can still create IPC objects. The code works heavily with raw `HANDLE`s and SID pointers, so most functions are `unsafe` and document ownership expectations explicitly.

The SID helpers cover three cases: creating the well-known Everyone SID (`world_sid`), converting string SIDs via `ConvertStringSidToSidW`, and owning such allocations through `LocalSid`, whose `Drop` frees the SID with `LocalFree`. Token inspection helpers query `TokenGroups` to find the logon SID, including a fallback through `TokenLinkedToken`, and query `TokenUser` to copy the token's user SID. `get_current_token_for_restriction` opens the current process token with all rights needed for duplication and adjustment.

Token creation flows through `create_token_with_caps_from`. It requires at least one capability SID, gathers the logon SID and Everyone SID, builds a `SID_AND_ATTRIBUTES` array in a deliberate order (capabilities, extra restricting SIDs, logon, everyone), and calls `CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`. After creation it installs a permissive default DACL granting `GENERIC_ALL` to logon/everyone/capability SIDs so sandboxed processes can create pipes and similar objects, then re-enables `SeChangeNotifyPrivilege`. Thin wrappers expose readonly and workspace-write variants, with optional inclusion of the token user SID for elevated sandbox accounts.

#### Function details

##### `set_default_dacl`  (lines 56–107)

```
fn set_default_dacl(h_token: HANDLE, sids: &[*mut c_void]) -> Result<()>
```

**Purpose**: Builds and applies a default DACL on a token that grants broad access to a supplied set of SID principals. This is specifically used so restricted sandbox processes can create IPC objects without access-denied failures.

**Data flow**: Takes a token `HANDLE` and a slice of raw SID pointers. If the slice is empty it returns success immediately. Otherwise it maps each SID into an `EXPLICIT_ACCESS_W`, calls `SetEntriesInAclW` to allocate a new ACL, wraps that ACL pointer in a `TokenDefaultDaclInfo`, and passes it to `SetTokenInformation(TokenDefaultDacl)`. On failure it reads `GetLastError`, frees the ACL with `LocalFree` if allocated, and returns an `anyhow` error; on success it still frees the ACL allocation before returning `Ok(())`.

**Call relations**: It is called only from `create_token_with_caps_from` after `CreateRestrictedToken` succeeds. Its role is post-processing the new token so later child-process creation and pipe setup work under the restricted security context.

*Call graph*: called by 1 (create_token_with_caps_from); 8 external calls (anyhow!, is_empty, iter, null_mut, GetLastError, LocalFree, SetEntriesInAclW, SetTokenInformation).


##### `world_sid`  (lines 109–128)

```
fn world_sid() -> Result<Vec<u8>>
```

**Purpose**: Allocates and returns the binary bytes of the well-known Everyone SID. The returned `Vec<u8>` can then be passed to Win32 APIs via its mutable pointer.

**Data flow**: Performs the standard two-call `CreateWellKnownSid` pattern: first with a null output pointer to discover the required size, then with a `Vec<u8>` buffer of that size to populate the SID. If the second call fails it returns an `anyhow` error containing `GetLastError`; otherwise it returns the filled byte vector.

**Call relations**: It is used when constructing restricted tokens and anywhere else the code needs an Everyone SID in raw form. In this file, `create_token_with_caps_from` depends on it to add Everyone as a restricting SID and DACL principal.

*Call graph*: called by 2 (path_has_world_write_allow, create_token_with_caps_from); 4 external calls (anyhow!, null_mut, vec!, CreateWellKnownSid).


##### `convert_string_sid_to_sid`  (lines 132–140)

```
fn convert_string_sid_to_sid(s: &str) -> Option<*mut c_void>
```

**Purpose**: Converts a textual SID such as `S-1-...` into a Win32-allocated SID pointer. The function leaves ownership with the caller, who must free it with `LocalFree`.

**Data flow**: Accepts a Rust `&str`, converts it to a wide string with `to_wide`, calls the imported `ConvertStringSidToSidW`, and returns `Some(*mut c_void)` on success or `None` on failure. It initializes the output pointer to null before the call.

**Call relations**: This is the raw conversion primitive used by `LocalSid::from_string`. Higher-level code prefers the `LocalSid` wrapper so the allocation is automatically released.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (from_string); 1 external calls (null_mut).


##### `LocalSid::from_string`  (lines 148–152)

```
fn from_string(sid: &str) -> Result<Self>
```

**Purpose**: Creates an owning `LocalSid` wrapper from a textual SID string. It turns conversion failure into a descriptive `anyhow` error.

**Data flow**: Takes `&str`, calls `convert_string_sid_to_sid`, and if a non-null SID pointer is returned wraps it in `LocalSid { psid }`. If conversion fails it returns `Err(anyhow!("invalid SID string: ..."))`.

**Call relations**: This constructor is the safe-ish entrypoint used by higher-level sandbox setup code when capability or ACL SIDs are configured as strings. It delegates all parsing/allocation to `convert_string_sid_to_sid` and relies on `Drop` for cleanup.

*Call graph*: calls 1 internal fn (convert_string_sid_to_sid); called by 5 (spawn_ipc_process, run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_legacy_session_security, root_capability_sids).


##### `LocalSid::as_ptr`  (lines 154–156)

```
fn as_ptr(&self) -> *mut c_void
```

**Purpose**: Exposes the wrapped SID pointer for passing into Win32 APIs that require raw SID addresses.

**Data flow**: Reads `self.psid` and returns it unchanged as `*mut c_void`. It does not transfer ownership or mutate state.

**Call relations**: This accessor supports callers that need to feed a `LocalSid` into token-creation or ACL APIs while keeping ownership with the wrapper.


##### `LocalSid::drop`  (lines 160–166)

```
fn drop(&mut self)
```

**Purpose**: Releases the SID allocation owned by `LocalSid` using `LocalFree`. It prevents leaks from `ConvertStringSidToSidW` allocations.

**Data flow**: On drop, checks whether `self.psid` is non-null and, if so, calls `LocalFree(self.psid as HLOCAL)`. It writes no Rust-visible state beyond object destruction.

**Call relations**: This destructor is the cleanup half of `LocalSid::from_string`. It is triggered automatically when higher-level sandbox setup code lets a `LocalSid` go out of scope.

*Call graph*: 2 external calls (is_null, LocalFree).


##### `get_current_token_for_restriction`  (lines 171–192)

```
fn get_current_token_for_restriction() -> Result<HANDLE>
```

**Purpose**: Opens the current process token with the access rights required to duplicate and adjust it into a restricted primary token.

**Data flow**: Computes a `desired` access mask combining duplicate, query, assign-primary, adjust-default, adjust-session-id, and adjust-privileges rights. It calls the imported `OpenProcessToken(GetCurrentProcess(), desired, &mut h)` and returns the resulting `HANDLE` on success or an `anyhow` error with `GetLastError` on failure.

**Call relations**: This is the starting point for flows that derive sandbox tokens from the current process token. In this file it is used by `create_readonly_token_with_cap`, and elsewhere by desktop/ACL preparation code that needs the current token.

*Call graph*: called by 4 (grant_desktop_access, allow_null_device_for_workspace_write, prepare_legacy_session_security, create_readonly_token_with_cap); 2 external calls (anyhow!, GetCurrentProcess).


##### `get_logon_sid_bytes`  (lines 194–277)

```
fn get_logon_sid_bytes(h_token: HANDLE) -> Result<Vec<u8>>
```

**Purpose**: Extracts the logon SID from a token, copying it into owned bytes. It also falls back to a linked token when the SID is not present on the original token.

**Data flow**: Accepts a token `HANDLE` and first runs an inner scanner over `TokenGroups`: it queries the required buffer size, fills a `Vec<u8>`, manually accounts for alignment of the trailing `SID_AND_ATTRIBUTES` array, and searches for an entry whose attributes include `SE_GROUP_LOGON_ID`. When found, it uses `GetLengthSid` and `CopySid` to return an owned SID byte vector. If not found, it queries token class 19 (`TokenLinkedToken`), reads the linked token handle from the returned buffer, scans that token the same way, closes the linked handle with `CloseHandle`, and returns the copied SID or an error if neither token contains one.

**Call relations**: It is a prerequisite for restricted-token creation because the logon SID is always appended to the restricting SID list. `create_token_with_caps_from` calls it directly, and other security setup code uses it when granting desktop or device access.

*Call graph*: called by 3 (grant_desktop_access, allow_null_device_for_workspace_write, create_token_with_caps_from); 6 external calls (anyhow!, null_mut, read_unaligned, vec!, CloseHandle, GetTokenInformation).


##### `get_user_sid_bytes`  (lines 279–317)

```
fn get_user_sid_bytes(h_token: HANDLE) -> Result<Vec<u8>>
```

**Purpose**: Copies the token's primary user SID into an owned byte buffer. This is used when the restricted token should also be constrained by the token user identity.

**Data flow**: Queries `TokenUser` size, allocates a `Vec<u8>`, fills it with `GetTokenInformation`, reads a `TOKEN_USER` structure from the buffer, obtains the SID length with `GetLengthSid`, allocates an output vector of that size, and copies the SID with `CopySid`. It returns detailed `anyhow` errors for zero sizes, failed queries, zero SID length, or failed copies.

**Call relations**: It is called by the `*_with_caps_and_user_from` wrappers before they delegate to `create_token_with_caps_from`. Those wrappers use the returned bytes to supply an extra restricting SID pointer.

*Call graph*: called by 2 (create_readonly_token_with_caps_and_user_from, create_workspace_write_token_with_caps_and_user_from); 7 external calls (anyhow!, null_mut, read_unaligned, vec!, CopySid, GetLengthSid, GetTokenInformation).


##### `enable_single_privilege`  (lines 319–348)

```
fn enable_single_privilege(h_token: HANDLE, name: &str) -> Result<()>
```

**Purpose**: Looks up one named privilege and enables it on a token. The implementation is used to restore `SeChangeNotifyPrivilege` after creating a restricted token.

**Data flow**: Takes a token `HANDLE` and privilege name `&str`, converts the name to UTF-16 with `to_wide`, resolves its `LUID` via `LookupPrivilegeValueW`, fills a zeroed `TOKEN_PRIVILEGES` with one enabled privilege entry, and calls `AdjustTokenPrivileges`. It checks both the API return value and the post-call `GetLastError`, returning `Ok(())` only when both indicate success.

**Call relations**: This is a post-processing helper called only by `create_token_with_caps_from`. It exists because the restricted-token flags disable privileges broadly, but the sandbox still needs directory traversal semantics provided by `SeChangeNotifyPrivilege`.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (create_token_with_caps_from); 7 external calls (anyhow!, zeroed, null, null_mut, GetLastError, AdjustTokenPrivileges, LookupPrivilegeValueW).


##### `create_readonly_token_with_cap`  (lines 352–359)

```
fn create_readonly_token_with_cap(
    psid_capability: *mut c_void,
) -> Result<(HANDLE, *mut c_void)>
```

**Purpose**: Convenience wrapper that derives a readonly restricted token from the current process token using a single capability SID.

**Data flow**: Calls `get_current_token_for_restriction()` to open the base token, passes that handle and the capability SID pointer to `create_readonly_token_with_cap_from`, closes the base handle with `CloseHandle`, and returns the resulting `(HANDLE, *mut c_void)` pair.

**Call relations**: This wrapper is used when callers want the common current-process case without manually opening a base token. It delegates all actual token construction to `create_readonly_token_with_cap_from`.

*Call graph*: calls 2 internal fn (create_readonly_token_with_cap_from, get_current_token_for_restriction); called by 1 (prepare_legacy_session_security); 1 external calls (CloseHandle).


##### `create_readonly_token_with_cap_from`  (lines 365–371)

```
fn create_readonly_token_with_cap_from(
    base_token: HANDLE,
    psid_capability: *mut c_void,
) -> Result<(HANDLE, *mut c_void)>
```

**Purpose**: Creates a readonly restricted token from a supplied base token and one capability SID, preserving the capability pointer in the return value.

**Data flow**: Accepts a base token `HANDLE` and a capability SID pointer, calls `create_token_with_caps_from(base_token, &[psid_capability], &[])`, and returns the new token handle together with the original capability pointer.

**Call relations**: It is the implementation behind `create_readonly_token_with_cap`. Its only job is adapting the single-capability API shape to the general multi-capability constructor.

*Call graph*: calls 1 internal fn (create_token_with_caps_from); called by 1 (create_readonly_token_with_cap).


##### `create_workspace_write_token_with_caps_from`  (lines 377–382)

```
fn create_workspace_write_token_with_caps_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Creates a restricted token that includes one or more capability SIDs for workspace-write scenarios, without adding the token user SID as an extra restricting SID.

**Data flow**: Takes a base token handle and a slice of capability SID pointers, then directly returns the result of `create_token_with_caps_from(base_token, psid_capabilities, &[])`.

**Call relations**: This is a thin semantic wrapper over the shared constructor, used by legacy session security setup when write-capability roots are represented as capability SIDs.

*Call graph*: calls 1 internal fn (create_token_with_caps_from); called by 1 (prepare_legacy_session_security).


##### `create_workspace_write_token_with_caps_and_user_from`  (lines 391–398)

```
fn create_workspace_write_token_with_caps_and_user_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Creates a workspace-write restricted token that includes capability SIDs and also restricts by the base token's user SID. This is intended for elevated backends where the token user is the dedicated sandbox account.

**Data flow**: Reads the base token's user SID bytes via `get_user_sid_bytes`, takes a mutable pointer into that buffer, and passes the capability SID slice plus a one-element extra-restricting-SID slice to `create_token_with_caps_from`. It returns the new token handle.

**Call relations**: This wrapper extends the shared constructor with one extra restricting SID. It is chosen by callers that need the sandbox account's user SID to participate in access checks.

*Call graph*: calls 2 internal fn (create_token_with_caps_from, get_user_sid_bytes).


##### `create_readonly_token_with_caps_from`  (lines 404–409)

```
fn create_readonly_token_with_caps_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Creates a readonly restricted token from a base token and multiple capability SIDs.

**Data flow**: Accepts a base token handle and a slice of capability SID pointers, then forwards them to `create_token_with_caps_from` with no extra restricting SIDs.

**Call relations**: This is another semantic wrapper around the common constructor, used when readonly access is represented by multiple capability SIDs rather than a single one.

*Call graph*: calls 1 internal fn (create_token_with_caps_from).


##### `create_readonly_token_with_caps_and_user_from`  (lines 418–425)

```
fn create_readonly_token_with_caps_and_user_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Creates a readonly restricted token that includes capability SIDs and the base token's user SID as an additional restricting SID.

**Data flow**: Obtains owned user SID bytes from `get_user_sid_bytes(base_token)`, converts the buffer to a raw SID pointer, and calls `create_token_with_caps_from(base_token, psid_capabilities, &[psid_user])`. It returns the resulting token handle.

**Call relations**: Like the workspace-write variant, this wrapper exists for elevated-account scenarios. It delegates all heavy lifting to `get_user_sid_bytes` and `create_token_with_caps_from`.

*Call graph*: calls 2 internal fn (create_token_with_caps_from, get_user_sid_bytes).


##### `create_token_with_caps_from`  (lines 427–483)

```
fn create_token_with_caps_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
    extra_restricting_sids: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Constructs the actual restricted token used by the sandbox, combining capability SIDs with mandatory restricting SIDs and token post-processing. It is the central token-creation routine in this file.

**Data flow**: Takes a base token handle, a non-empty slice of capability SID pointers, and a slice of extra restricting SID pointers. It errors immediately if no capabilities are provided. It then copies the base token's logon SID via `get_logon_sid_bytes`, creates the Everyone SID via `world_sid`, allocates a `Vec<SID_AND_ATTRIBUTES>` sized for capabilities + extras + logon + everyone, and fills it in that exact order. It calls `CreateRestrictedToken` with `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`, then builds a DACL SID list containing logon, everyone, and all capabilities, applies it with `set_default_dacl`, enables `SeChangeNotifyPrivilege` with `enable_single_privilege`, and returns the new token `HANDLE`.

**Call relations**: All public token-construction wrappers funnel into this function. It is the point where SID discovery, restricted-token creation, DACL setup, and privilege restoration are combined into one coherent sandbox token build step.

*Call graph*: calls 4 internal fn (enable_single_privilege, get_logon_sid_bytes, set_default_dacl, world_sid); called by 5 (create_readonly_token_with_cap_from, create_readonly_token_with_caps_and_user_from, create_readonly_token_with_caps_from, create_workspace_write_token_with_caps_and_user_from, create_workspace_write_token_with_caps_from); 8 external calls (with_capacity, anyhow!, is_empty, iter, len, null, vec!, CreateRestrictedToken).


### `windows-sandbox-rs/src/deny_read_acl.rs`

`domain_logic` · `sandbox setup / ACL application`

This file implements the low-level path preparation and one-shot ACL application logic for deny-read sandbox rules. Its central design choice is to preserve two views of a denied path: the exact lexical path the policy named, and, for existing paths, the canonicalized target returned by path normalization. That dual representation prevents bypass through reparse points while still allowing future missing paths to be materialized and denied under the originally configured spelling.

`plan_deny_read_acl_paths` builds the ordered path list, deduplicating with a normalized string key produced by `lexical_path_key`. The key lowercases, converts backslashes to slashes, and trims trailing separators, so equivalent Windows spellings collapse to one entry. `apply_deny_read_acls` then walks the planned list, creating missing paths as directories before applying the deny ACE. This is intentional: a sandboxed process should not be able to create a previously absent denied path and immediately read it before ACLs exist.

The function tracks which ACEs were newly added during the current call. If any later path fails during directory creation or ACE insertion, it revokes only those newly added ACEs and returns the original error, avoiding partial deny state from a failed one-shot setup. The returned vector is the deduplicated set of paths actually targeted during this invocation, regardless of whether an ACE was newly inserted or already present.

#### Function details

##### `plan_deny_read_acl_paths`  (lines 18–28)

```
fn plan_deny_read_acl_paths(paths: &[PathBuf]) -> Vec<PathBuf>
```

**Purpose**: Builds the concrete path list that should receive deny-read ACLs from a policy-supplied slice of paths. For each input it preserves the original lexical path and, if the path already exists, also includes its canonicalized target path.

**Data flow**: It takes a slice of `PathBuf` inputs, iterates in order, and feeds each candidate through `push_planned_path` with a shared `HashSet` of normalized keys. Existing paths are additionally passed through `canonicalize_path`; the function returns a `Vec<PathBuf>` containing unique planned ACL targets in insertion order.

**Call relations**: This is the planning phase used by `apply_deny_read_acls` before any filesystem mutation occurs. The canonical-target inclusion is also exercised directly by the canonicalization-focused test to verify that existing paths expand into both lexical and resolved forms.

*Call graph*: calls 2 internal fn (push_planned_path, canonicalize_path); called by 2 (apply_deny_read_acls, plan_includes_existing_canonical_targets); 2 external calls (new, new).


##### `push_planned_path`  (lines 30–34)

```
fn push_planned_path(planned: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf)
```

**Purpose**: Conditionally appends a path to an output list only if its normalized lexical key has not been seen yet. It is the shared deduplication helper for both planning and applied-path reporting.

**Data flow**: It receives mutable references to the destination `Vec<PathBuf>` and `HashSet<String>`, plus a candidate `PathBuf`. It computes the key with `lexical_path_key`; if insertion into `seen` succeeds, it pushes the original `PathBuf` into `planned`, otherwise it leaves both collections unchanged.

**Call relations**: Both `plan_deny_read_acl_paths` and `apply_deny_read_acls` route path accumulation through this helper so they use identical equivalence rules. It does not delegate beyond key generation, making it the single gate for duplicate suppression.

*Call graph*: calls 1 internal fn (lexical_path_key); called by 2 (apply_deny_read_acls, plan_deny_read_acl_paths).


##### `lexical_path_key`  (lines 36–41)

```
fn lexical_path_key(path: &Path) -> String
```

**Purpose**: Normalizes a path into a case-insensitive, separator-normalized string key suitable for Windows-style lexical deduplication. It intentionally ignores canonical filesystem identity and focuses on equivalent textual spellings.

**Data flow**: It reads a `&Path`, converts it with `to_string_lossy`, replaces backslashes with forward slashes, trims trailing `/`, lowercases ASCII characters, and returns the resulting `String`. It writes no external state.

**Call relations**: This helper underpins deduplication in `push_planned_path` and is also reused by persistent ACL reconciliation code in another file so stored and newly applied paths compare under the same lexical rules.

*Call graph*: called by 2 (push_planned_path, sync_persistent_deny_read_acls); 1 external calls (to_string_lossy).


##### `apply_deny_read_acls`  (lines 51–80)

```
fn apply_deny_read_acls(paths: &[PathBuf], psid: *mut c_void) -> Result<Vec<PathBuf>>
```

**Purpose**: Applies deny-read ACEs to all planned paths for a sandbox principal, creating missing directories first and rolling back newly added ACEs if any step fails. It is the transactional-ish execution layer over the path plan.

**Data flow**: It accepts desired `paths` and an unsafe raw SID pointer `psid`. It first derives `planned` paths via `plan_deny_read_acl_paths`, then for each path: creates the directory tree if absent, calls `add_deny_read_ace`, records paths whose ACE was newly added, and accumulates a deduplicated `applied` list via `push_planned_path`. On any error it iterates `added_in_this_call` and invokes `revoke_ace` for rollback, then returns the error; otherwise it returns `Ok(Vec<PathBuf>)` of all targeted paths.

**Call relations**: This function is invoked by persistent-state synchronization when a sandbox session needs deny-read ACLs enforced. It delegates planning to `plan_deny_read_acl_paths`, uses the ACL layer for insertion and rollback, and serves as the boundary where filesystem creation and ACL mutation actually happen.

*Call graph*: calls 3 internal fn (revoke_ace, plan_deny_read_acl_paths, push_planned_path); called by 1 (sync_persistent_deny_read_acls); 2 external calls (new, new).


##### `tests::plan_preserves_missing_paths`  (lines 91–99)

```
fn plan_preserves_missing_paths()
```

**Purpose**: Verifies that planning does not discard a missing path just because it cannot be canonicalized through existence. The test protects the invariant that future denied paths remain represented lexically.

**Data flow**: It creates a temporary directory, constructs a non-existent child path, calls the planner with a one-element slice, and asserts that the returned vector contains exactly that original path. It only reads temporary filesystem state and performs no persistent writes.

**Call relations**: This test exercises the missing-path branch of `plan_deny_read_acl_paths`, specifically the absence of canonical-target expansion when `exists()` is false.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::plan_includes_existing_canonical_targets`  (lines 102–118)

```
fn plan_includes_existing_canonical_targets()
```

**Purpose**: Checks that an existing path expands into both its original lexical spelling and its canonicalized target. This confirms the anti-aliasing behavior around reparse-point or normalized access paths.

**Data flow**: It creates a temp file, calls `plan_deny_read_acl_paths`, collects the result into a `HashSet<PathBuf>`, builds an expected set from the original path plus `dunce::canonicalize`, and asserts equality. The test writes one file to establish existence before planning.

**Call relations**: This test directly validates the canonicalization branch inside `plan_deny_read_acl_paths`, ensuring the planner emits both forms for existing objects.

*Call graph*: calls 1 internal fn (plan_deny_read_acl_paths); 5 external calls (new, assert_eq!, canonicalize, write, from_ref).


### `windows-sandbox-rs/src/audit.rs`

`domain_logic` · `sandbox preflight and ACL hardening`

This module is the sandbox’s defensive audit pass against unexpectedly permissive filesystem ACLs. It first builds a prioritized candidate list of directories to inspect: the command CWD, TEMP/TMP, user-profile roots, PATH entries, and finally broad system roots like `C:/` and `C:/Windows`. Candidate collection canonicalizes paths and deduplicates them so later scans and logs are stable.

The audit itself is intentionally bounded. `audit_everyone_writable` checks immediate children of the CWD first to catch workspace issues quickly, then scans each candidate root and one directory level beneath it. It skips symlinks/reparse points, caps per-directory enumeration and total checked items, and aborts after a short wall-clock limit. ACL readability failures are treated as non-world-writable but logged at debug level. Paths are deduplicated by a canonical path key before being added to the flagged list.

If anything is flagged, the remediation path persists capability SID state under `codex_home`, determines which capability SIDs are active for the current permission mode, skips flagged paths that are inside approved writable roots, and applies write-deny ACEs to the remaining paths. Failures to apply denies are logged but do not abort the overall setup. The result is a best-effort hardening pass rather than a strict blocker.

#### Function details

##### `unique_push`  (lines 38–44)

```
fn unique_push(set: &mut HashSet<PathBuf>, out: &mut Vec<PathBuf>, p: PathBuf)
```

**Purpose**: Canonicalizes a candidate path and appends it to an output list only if it has not already been seen.

**Data flow**: Takes a mutable `HashSet<PathBuf>`, mutable `Vec<PathBuf>`, and a candidate `PathBuf`. If `canonicalize()` succeeds and the canonical path is newly inserted into the set, it clones that canonical path into the output vector; otherwise it does nothing.

**Call relations**: Used exclusively by `gather_candidates` to keep the candidate scan order deterministic while removing duplicates.

*Call graph*: called by 1 (gather_candidates); 1 external calls (canonicalize).


##### `gather_candidates`  (lines 46–81)

```
fn gather_candidates(cwd: &Path, env: &std::collections::HashMap<String, String>) -> Vec<PathBuf>
```

**Purpose**: Builds the ordered list of filesystem roots that the world-writable audit should inspect.

**Data flow**: Accepts the command CWD and an environment map. It initializes a dedupe set and output vector, then pushes the CWD, TEMP/TMP from the provided map or process environment, `USERPROFILE`, `PUBLIC`, each non-empty PATH entry split with Windows path semantics, and finally `C:/` and `C:/Windows`; each insertion goes through `unique_push` so only canonical existing paths survive.

**Call relations**: Called by `audit_everyone_writable` during the broader scan and directly by the unit test that verifies PATH splitting behavior.

*Call graph*: calls 1 internal fn (unique_push); called by 2 (audit_everyone_writable, gathers_path_entries_by_list_separator); 7 external calls (new, new, to_path_buf, from, new, split_paths, var_os).


##### `path_has_world_write_allow`  (lines 83–93)

```
fn path_has_world_write_allow(path: &Path) -> Result<bool>
```

**Purpose**: Checks whether the Everyone/World SID has any write-like allow bits on a path.

**Data flow**: Creates a `LocalSid` for the world SID via `world_sid()`, converts it to a raw SID pointer, builds a write mask from `FILE_WRITE_DATA`, `FILE_APPEND_DATA`, `FILE_WRITE_EA`, and `FILE_WRITE_ATTRIBUTES`, and calls `path_mask_allows` with `require_all_bits = false`. It returns `Result<bool>`.

**Call relations**: Used internally by the audit closure in `audit_everyone_writable` as the ACL predicate for flagging paths.

*Call graph*: calls 2 internal fn (path_mask_allows, world_sid).


##### `audit_everyone_writable`  (lines 95–218)

```
fn audit_everyone_writable(
    cwd: &Path,
    env: &std::collections::HashMap<String, String>,
    logs_base_dir: Option<&Path>,
) -> Result<Vec<PathBuf>>
```

**Purpose**: Performs a time- and size-bounded scan for world-writable directories and logs either the flagged paths or a success summary.

**Data flow**: Accepts the command CWD, environment map, and optional log directory. It records start time, tracks flagged paths, seen canonical keys, and a checked counter, defines a closure that wraps `path_has_world_write_allow` with debug logging on ACL-read errors, scans immediate CWD child directories first, then scans candidate roots and one level of children while enforcing item and time limits, skipping symlinks and selected noisy Windows subdirectories. It logs a detailed failure note with all flagged paths or a success note with counts and duration, and returns the flagged `Vec<PathBuf>`.

**Call relations**: Invoked by `apply_world_writable_scan_and_denies_for_permissions` as the discovery phase before any deny ACEs are applied.

*Call graph*: calls 3 internal fn (gather_candidates, log_note, canonical_path_key); called by 1 (apply_world_writable_scan_and_denies_for_permissions); 7 external calls (from_secs, new, now, new, new, format!, read_dir).


##### `apply_world_writable_scan_and_denies_for_permissions`  (lines 220–245)

```
fn apply_world_writable_scan_and_denies_for_permissions(
    codex_home: &Path,
    cwd: &Path,
    env_map: &std::collections::HashMap<String, String>,
    permissions: &ResolvedWindowsSandboxPermiss
```

**Purpose**: Runs the world-writable audit and, if anything is flagged, attempts best-effort deny remediation for the active permission configuration.

**Data flow**: Accepts `codex_home`, CWD, environment map, resolved permissions, and optional log directory. It calls `audit_everyone_writable`; if the returned list is empty it exits successfully, otherwise it calls `apply_capability_denies_for_world_writable_for_permissions` and logs any remediation failure without propagating it.

**Call relations**: This is the public orchestration entry for the audit/remediation sequence, sequencing discovery first and deny application second.

*Call graph*: calls 3 internal fn (apply_capability_denies_for_world_writable_for_permissions, audit_everyone_writable, log_note); 1 external calls (format!).


##### `apply_capability_denies_for_world_writable_for_permissions`  (lines 247–312)

```
fn apply_capability_denies_for_world_writable_for_permissions(
    codex_home: &Path,
    flagged: &[PathBuf],
    permissions: &ResolvedWindowsSandboxPermissions,
    cwd: &Path,
    env_map: &std::c
```

**Purpose**: Persists capability SID state, determines the active capability SIDs for the current permission mode, and applies write-deny ACEs to flagged paths outside approved writable roots.

**Data flow**: Accepts `codex_home`, the flagged paths, resolved permissions, CWD, environment map, and optional log directory. It returns early on an empty flagged list, ensures `codex_home` exists, loads or creates capability SIDs, writes them to the capability SID file as JSON, exits early if the permissions are not enforceable by the Windows sandbox, then computes either workspace-write capability SIDs and effective write roots or the readonly capability SID. For each flagged path not contained in any active workspace write root, it calls `add_deny_write_ace` for each active SID and logs success or failure per path.

**Call relations**: Called only after a non-empty audit result; it is the remediation engine behind `apply_world_writable_scan_and_denies_for_permissions`.

*Call graph*: calls 7 internal fn (add_deny_write_ace, cap_sid_file, load_or_create_cap_sids, log_note, is_enforceable_by_windows_sandbox, uses_write_capabilities_for_cwd, effective_write_roots_for_permissions); called by 1 (apply_world_writable_scan_and_denies_for_permissions); 7 external calls (is_empty, new, format!, to_string, create_dir_all, write, vec!).


##### `tests::gathers_path_entries_by_list_separator`  (lines 321–349)

```
fn gathers_path_entries_by_list_separator()
```

**Purpose**: Verifies that PATH entries separated by semicolons are split into distinct audit candidates, including paths with spaces.

**Data flow**: Creates a temporary directory tree with three subdirectories, constructs an environment map containing a semicolon-separated PATH string, calls `gather_candidates`, canonicalizes the expected directories, and asserts each appears in the candidate list.

**Call relations**: Exercises `gather_candidates` directly to pin down Windows PATH parsing behavior used by the audit scan.

*Call graph*: calls 1 internal fn (gather_candidates); 5 external calls (new, assert!, format!, create_dir_all, tempdir).


### `windows-sandbox-rs/src/hide_users.rs`

`domain_logic` · `sandbox setup and first sandbox-user login`

This file contains two user-facing operations. `hide_newly_created_users` updates the Winlogon `SpecialAccounts\UserList` registry key under `HKEY_LOCAL_MACHINE`, writing a `REG_DWORD` value of `0` for each username so those accounts are hidden from the Windows logon screen. The function is intentionally best-effort: an empty username list is ignored, and any top-level failure is logged with `log_note` rather than returned.

The second operation, `hide_current_user_profile_dir`, is meant to run inside the command-runner after the sandbox user has actually logged in, because Windows only creates a profile directory on first logon. It reads `USERPROFILE`, checks that the directory exists, and then calls `hide_directory` to add `FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM`. Logging is one-time-ish by design: success is logged only when attributes actually changed, not when the directory was already hidden.

The lower-level helpers encapsulate Win32 details. `create_userlist_key` creates or opens the registry path with `KEY_WRITE`, converting Rust strings to UTF-16 via `to_wide` and formatting Win32 status codes with `format_last_error`. `hide_users_in_winlogon` iterates usernames, writes each registry value, logs per-user failures, and always closes the registry handle. `hide_directory` reads current file attributes, errors on `INVALID_FILE_ATTRIBUTES`, computes the new attribute mask, and only calls `SetFileAttributesW` when a change is needed.

#### Function details

##### `hide_newly_created_users`  (lines 26–36)

```
fn hide_newly_created_users(usernames: &[String], log_base: &Path)
```

**Purpose**: Attempts to hide a batch of newly created sandbox usernames from the Windows logon UI. It treats the operation as best-effort and only logs failures.

**Data flow**: It takes a slice of usernames and a log directory path. If the username slice is empty it returns immediately; otherwise it calls `hide_users_in_winlogon`, and if that returns an error it formats a note and writes it to the sandbox log. It returns no value and does not propagate errors.

**Call relations**: This is the top-level batch API for account hiding. It delegates all registry work to `hide_users_in_winlogon` and exists to keep setup flows resilient even when hiding fails.

*Call graph*: calls 2 internal fn (hide_users_in_winlogon, log_note); 1 external calls (format!).


##### `hide_current_user_profile_dir`  (lines 43–74)

```
fn hide_current_user_profile_dir(log_base: &Path)
```

**Purpose**: Hides the current process user's profile directory by setting hidden/system attributes once the directory exists. It is intended to run as the sandbox user after first logon has materialized the profile.

**Data flow**: It takes a log directory path, reads `USERPROFILE` from the process environment, converts it to a `PathBuf`, and returns early if the variable is absent or the directory does not exist. It then calls `hide_directory`; on `Ok(true)` it logs that the profile directory was hidden, on `Ok(false)` it does nothing, and on `Err` it logs the failure with the directory path.

**Call relations**: This function is called from command-runner-side flows where the sandbox user context is active. It delegates the actual attribute manipulation to `hide_directory` and intentionally suppresses errors into logs.

*Call graph*: calls 2 internal fn (hide_directory, log_note); 3 external calls (from, format!, var_os).


##### `hide_users_in_winlogon`  (lines 76–105)

```
fn hide_users_in_winlogon(usernames: &[String], log_base: &Path) -> anyhow::Result<()>
```

**Purpose**: Writes per-user `UserList` registry values that hide accounts from the Winlogon UI. It logs individual write failures but still attempts all usernames.

**Data flow**: It takes a username slice and log directory path, opens or creates the `USERLIST_KEY_PATH` registry key via `create_userlist_key`, then for each username converts it to UTF-16 with `to_wide`, prepares a `u32` value of `0`, and calls `RegSetValueExW` with `REG_DWORD`. Nonzero status codes are formatted and logged per username. After the loop it closes the registry key with `RegCloseKey` and returns `Ok(())` unless key creation itself failed.

**Call relations**: It is called only by `hide_newly_created_users`. This function contains the per-user iteration and partial-failure behavior, while `create_userlist_key` encapsulates the registry-open step.

*Call graph*: calls 3 internal fn (create_userlist_key, log_note, to_wide); called by 1 (hide_newly_created_users); 5 external calls (new, format!, size_of_val, RegCloseKey, RegSetValueExW).


##### `create_userlist_key`  (lines 107–130)

```
fn create_userlist_key() -> anyhow::Result<HKEY>
```

**Purpose**: Creates or opens the Winlogon `SpecialAccounts\UserList` registry key with write access. It converts Win32 status failures into contextual `anyhow` errors.

**Data flow**: It takes no arguments, converts the constant registry path to UTF-16 with `to_wide`, initializes an `HKEY` output variable, and calls `RegCreateKeyExW` against `HKEY_LOCAL_MACHINE` with `REG_OPTION_NON_VOLATILE` and `KEY_WRITE`. On success it returns the opened `HKEY`; on failure it returns an error string containing the status code and formatted system error.

**Call relations**: It is a private helper used by `hide_users_in_winlogon` before any per-user registry writes occur. By isolating key creation, it keeps the caller focused on value updates and logging.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (hide_users_in_winlogon); 3 external calls (anyhow!, null_mut, RegCreateKeyExW).


##### `hide_directory`  (lines 133–158)

```
fn hide_directory(path: &Path) -> anyhow::Result<bool>
```

**Purpose**: Sets the hidden and system attributes on a directory if they are not already present, and reports whether it changed anything. It is the low-level filesystem primitive behind profile-directory hiding.

**Data flow**: It takes a directory path, converts it to UTF-16 with `to_wide`, and calls `GetFileAttributesW`. If attributes cannot be read it fetches `GetLastError`, formats the error, and returns an `anyhow` failure. Otherwise it ORs in `FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM`; if the result equals the original attributes it returns `Ok(false)`, and if not it calls `SetFileAttributesW`, returning `Ok(true)` on success or a formatted error on failure.

**Call relations**: It is called only by `hide_current_user_profile_dir`. The boolean return lets the caller suppress repetitive success logs when the directory was already hidden.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (hide_current_user_profile_dir); 4 external calls (anyhow!, GetLastError, GetFileAttributesW, SetFileAttributesW).


### `windows-sandbox-rs/src/bin/setup_main/win/setup_runtime_bin.rs`

`domain_logic` · `setup refresh`

This module contains a single targeted helper used only during refresh-style setup. It locates the per-user runtime cache directory where the desktop app copies bundled Windows binaries before launching `codex.exe`: `%LOCALAPPDATA%\OpenAI\Codex\bin`, with a fallback derived from `%USERPROFILE%\AppData\Local` if `LOCALAPPDATA` is unset. If that directory does not exist, the helper exits quietly.

When the directory is present, it checks whether the sandbox users group PSID already has `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE` on the directory using `path_mask_allows`. ACL inspection failures are treated as soft refresh errors: the function appends a formatted message to the caller-owned `refresh_errors` vector, logs a continuing warning through the parent module’s `log_line`, and proceeds as though access were missing. If access is absent, it logs that it is granting read/execute, then calls `ensure_allow_mask_aces_with_inheritance` with both object and container inheritance flags so the permission propagates through the runtime tree. Grant failures are likewise appended to `refresh_errors` and logged rather than immediately aborting. This design matches the broader refresh semantics in `run_setup_full`, where multiple ACL repairs are attempted and only summarized as a hard failure at the end.

#### Function details

##### `ensure_codex_app_runtime_bin_readable`  (lines 13–92)

```
fn ensure_codex_app_runtime_bin_readable(
    sandbox_group_psid: *mut c_void,
    refresh_errors: &mut Vec<String>,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Repairs read/execute access for the sandbox group on the cached Codex runtime binary directory if needed.

**Data flow**: It takes the sandbox-group PSID, a mutable `Vec<String>` of refresh errors, and a log sink. It resolves the LocalAppData path, derives `OpenAI\Codex\bin`, returns early if the environment or directory is absent, checks the current ACL mask for read/execute, logs and records any inspection failure, grants inherited read/execute ACEs when access is missing, and records/logs any grant failure before returning `Ok(())`.

**Call relations**: This helper is called only from `run_setup_full` when `payload.refresh_only` is true, complementing the delegated read-root ACL refresh with a repair for the desktop runtime cache.

*Call graph*: called by 1 (run_setup_full); 5 external calls (ensure_allow_mask_aces_with_inheritance, path_mask_allows, format!, var_os, log_line).


### `windows-sandbox-rs/src/bin/setup_main/win/firewall.rs`

`io_transport` · `setup network configuration`

This module encapsulates all firewall-specific setup behind COM calls to `INetFwPolicy2`, `INetFwRules`, and `INetFwRule3`. It defines stable internal rule names and friendly descriptions for three block rules: a non-loopback outbound block, a loopback UDP block, and a loopback TCP block whose remote-port scope can be narrowed to the complement of allowed proxy ports. The central design choice is fail-closed behavior: when transitioning into proxy-only mode, it first installs broad loopback blocks and only then narrows TCP ports; when transitioning back to unrestricted local binding, it removes legacy overlapping rules so stale exceptions do not remain.

Both public entrypoints initialize COM apartment threading, create the firewall policy object, verify via `LocalPolicyModifyState` that local rule edits actually take effect for all active profiles, and then mutate the rules collection. `ensure_block_rule` is idempotent: it looks up an existing rule by stable name, creates one if absent, and always reapplies all fields. `configure_rule` writes description, direction, action, enabled state, profiles, protocol, remote scope, and `LocalUserAuthorizedList`, then reads back the user scope to ensure the expected offline SID was actually stored. Errors are consistently wrapped as `SetupFailure` with firewall-specific codes so callers can distinguish COM initialization, policy ineffectiveness, rule creation, and verification failures.

#### Function details

##### `ensure_offline_proxy_allowlist`  (lines 55–154)

```
fn ensure_offline_proxy_allowlist(
    offline_sid: &str,
    proxy_ports: &[u16],
    allow_local_binding: bool,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Configures loopback-only firewall behavior for the offline sandbox user, optionally allowing only specific proxy ports or removing loopback restrictions when local binding is allowed.

**Data flow**: It takes the offline SID string, a slice of allowed proxy ports, the `allow_local_binding` flag, and a log sink. It builds a `LocalUserAuthorizedList` SDDL string, initializes COM, opens the firewall policy and rules collection, optionally removes legacy/proxy loopback rules when local binding is enabled, otherwise ensures UDP and broad TCP loopback block rules exist, removes the legacy allow rule, optionally narrows the TCP block to the complement of allowed proxy ports, uninitializes COM, and returns success or a structured firewall failure.

**Call relations**: This function is called from `configure_offline_sandbox_network` before the broader non-loopback outbound block is installed. Internally it relies on policy-effectiveness checks, rule removal, block-rule creation, and port-complement calculation.

*Call graph*: calls 1 internal fn (new); called by 1 (configure_offline_sandbox_network); 4 external calls (new, format!, CoInitializeEx, CoUninitialize).


##### `ensure_offline_outbound_block`  (lines 156–206)

```
fn ensure_offline_outbound_block(offline_sid: &str, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Installs the per-user firewall rule that blocks all non-loopback outbound traffic for the offline sandbox account.

**Data flow**: It takes the offline SID string and log sink, constructs the same local-user SDDL scope, initializes COM, opens the firewall policy and rules collection, verifies local policy effectiveness, ensures the non-loopback block rule exists with protocol `ANY` and the configured remote-address literal, uninitializes COM, and returns a `Result<()>`.

**Call relations**: This is the second firewall step invoked by `configure_offline_sandbox_network`. It delegates actual rule creation/update to `ensure_block_rule` after the policy check.

*Call graph*: calls 1 internal fn (new); called by 1 (configure_offline_sandbox_network); 4 external calls (new, format!, CoInitializeEx, CoUninitialize).


##### `remove_rule_if_present`  (lines 208–224)

```
fn remove_rule_if_present(
    rules: &INetFwRules,
    internal_name: &str,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Deletes a named firewall rule if it already exists and logs the removal.

**Data flow**: It receives the `INetFwRules` collection, an internal rule name, and a log sink. It converts the name to `BSTR`, probes `rules.Item`, removes the rule if found, logs a timestamped removal line, and otherwise returns success without modification.

**Call relations**: This helper is used during proxy/local-binding transitions inside `ensure_offline_proxy_allowlist` to clean up overlapping or legacy rules without treating absence as an error.

*Call graph*: calls 1 internal fn (log_line); 4 external calls (from, Item, Remove, format!).


##### `ensure_local_policy_rules_take_effect`  (lines 226–235)

```
fn ensure_local_policy_rules_take_effect(policy: &INetFwPolicy2) -> Result<()>
```

**Purpose**: Queries Windows Firewall policy state to ensure local rule modifications are effective.

**Data flow**: It takes an `INetFwPolicy2`, invokes the COM vtable method `LocalPolicyModifyState` into a mutable `NET_FW_MODIFY_STATE`, and passes both the HRESULT and returned state into `validate_local_policy_modify_result`.

**Call relations**: Both public firewall entrypoints call this before mutating rules so setup fails early when Group Policy or partial-profile coverage would make local edits ineffective.

*Call graph*: calls 1 internal fn (validate_local_policy_modify_result); 3 external calls (default, as_raw, vtable).


##### `validate_local_policy_modify_result`  (lines 237–270)

```
fn validate_local_policy_modify_result(
    result: windows::core::HRESULT,
    modify_state: NET_FW_MODIFY_STATE,
) -> Result<()>
```

**Purpose**: Interprets the `LocalPolicyModifyState` HRESULT and modify-state enum and converts ineffective-policy cases into setup failures.

**Data flow**: It takes the raw COM `HRESULT` and `NET_FW_MODIFY_STATE`. If the HRESULT is an error it returns `HelperFirewallPolicyAccessFailed`; if it is not exactly `S_OK` it returns `HelperFirewallPolicyIneffective`; if the modify state is not `NET_FW_MODIFY_STATE_OK` it also returns `HelperFirewallPolicyIneffective`; otherwise it returns success.

**Call relations**: This validator is called by `ensure_local_policy_rules_take_effect` and directly by tests that exercise effective, group-policy-override, and partial-profile cases.

*Call graph*: calls 1 internal fn (new); called by 3 (ensure_local_policy_rules_take_effect, local_policy_modify_state_rejects_ineffective_policy, local_policy_modify_state_rejects_partial_profile_coverage); 3 external calls (is_err, new, format!).


##### `ensure_block_rule`  (lines 272–327)

```
fn ensure_block_rule(
    rules: &INetFwRules,
    spec: &BlockRuleSpec<'_>,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Creates or updates a single firewall block rule described by `BlockRuleSpec` and logs the final configured scope.

**Data flow**: It takes the rules collection, a rule spec, and a log sink. It looks up an existing rule by internal name and casts it to `INetFwRule3`, or creates a new `NetFwRule`, sets its name, fully configures it before adding it, then always reapplies configuration to keep the operation idempotent, logs protocol/remote-address/remote-port/user-scope details, and returns success.

**Call relations**: This is the main mutation primitive used by both public firewall setup functions. It delegates field assignment and verification to `configure_rule`.

*Call graph*: calls 2 internal fn (configure_rule, log_line); 5 external calls (from, Add, Item, format!, CoCreateInstance).


##### `configure_rule`  (lines 329–390)

```
fn configure_rule(rule: &INetFwRule3, spec: &BlockRuleSpec<'_>) -> Result<()>
```

**Purpose**: Writes all non-name properties for a firewall rule and verifies that the expected offline SID was persisted in the local-user scope.

**Data flow**: It takes an `INetFwRule3` and a `BlockRuleSpec`, sets description, outbound direction, block action, enabled state, all profiles, network scope, and `LocalUserAuthorizedList`, then reads back `LocalUserAuthorizedList`, converts it to a string, and checks that it contains `spec.offline_sid`. It returns a verification failure if the read-back does not match.

**Call relations**: This function is called only by `ensure_block_rule`, both before adding a new rule and again afterward for idempotent updates.

*Call graph*: calls 2 internal fn (configure_rule_network_scope, new); called by 1 (ensure_block_rule); 10 external calls (from, LocalUserAuthorizedList, SetAction, SetDescription, SetDirection, SetEnabled, SetLocalUserAuthorizedList, SetProfiles, new, format!).


##### `configure_rule_network_scope`  (lines 392–420)

```
fn configure_rule_network_scope(rule: &INetFwRule3, spec: &BlockRuleSpec<'_>) -> Result<()>
```

**Purpose**: Applies protocol, remote-address, and optional remote-port scope to a firewall rule.

**Data flow**: It takes an `INetFwRule3` and a `BlockRuleSpec`, sets the protocol, writes either the provided remote-address literal or `*`, and if `remote_ports` is present writes that port expression as well. It returns any COM setter failure as a structured setup error.

**Call relations**: This helper is called from `configure_rule` and is also exercised directly by tests that validate the production address and port literals against Firewall COM.

*Call graph*: called by 1 (configure_rule); 4 external calls (from, SetProtocol, SetRemoteAddresses, SetRemotePorts).


##### `blocked_loopback_tcp_remote_ports`  (lines 422–453)

```
fn blocked_loopback_tcp_remote_ports(proxy_ports: &[u16]) -> Option<String>
```

**Purpose**: Builds the comma-separated complement of allowed proxy ports across the TCP port range for use in the loopback TCP block rule.

**Data flow**: It takes a slice of `u16` proxy ports, filters out zero, sorts and deduplicates them, then walks from port 1 through `u16::MAX`, emitting blocked single ports or ranges via `port_range_string` for every gap not explicitly allowed. It returns `None` only if no blocked ranges remain; otherwise it returns the joined range string.

**Call relations**: This helper is used when configuring the narrowed loopback TCP block rule and is covered by the COM-acceptance test for production rule scopes.

*Call graph*: calls 1 internal fn (port_range_string); called by 1 (production_firewall_rule_network_scopes_are_accepted_by_firewall_com); 2 external calls (new, from).


##### `port_range_string`  (lines 455–461)

```
fn port_range_string(start: u32, end: u32) -> String
```

**Purpose**: Formats either a single port or an inclusive port range in the syntax expected by Firewall COM.

**Data flow**: It takes `start` and `end` as `u32`; if they are equal it returns the decimal port string, otherwise it returns `start-end`.

**Call relations**: This is a small formatting helper used only by `blocked_loopback_tcp_remote_ports`.

*Call graph*: called by 1 (blocked_loopback_tcp_remote_ports); 1 external calls (format!).


##### `log_line`  (lines 463–467)

```
fn log_line(log: &mut dyn Write, msg: &str) -> Result<()>
```

**Purpose**: Writes a timestamped firewall log line to the provided writer.

**Data flow**: It takes a mutable `Write` sink and message string, prepends the current UTC timestamp, writes one line, and returns any I/O error directly.

**Call relations**: This local logger is used by `ensure_block_rule` and `remove_rule_if_present` so firewall mutations leave an audit trail in the setup log.

*Call graph*: called by 2 (ensure_block_rule, remove_rule_if_present); 2 external calls (now, writeln!).


##### `tests::configured_remote_address_literals_are_accepted_by_firewall_com`  (lines 478–507)

```
fn configured_remote_address_literals_are_accepted_by_firewall_com()
```

**Purpose**: Verifies that the hard-coded remote-address literals used by production rules are accepted by Firewall COM.

**Data flow**: It initializes COM, creates temporary `INetFwRule3` objects, attempts to set and read back each candidate remote-address string, uninitializes COM, and asserts that every candidate succeeds.

**Call relations**: This test guards against shipping invalid address-scope literals that would make runtime firewall setup fail.

*Call graph*: 3 external calls (assert!, CoInitializeEx, CoUninitialize).


##### `tests::production_firewall_rule_network_scopes_are_accepted_by_firewall_com`  (lines 510–571)

```
fn production_firewall_rule_network_scopes_are_accepted_by_firewall_com()
```

**Purpose**: Verifies that the exact protocol/address/port combinations used by production block rules are accepted by Firewall COM.

**Data flow**: It initializes COM, constructs representative `BlockRuleSpec` values including a computed blocked-port complement, creates temporary firewall rule objects, applies `configure_rule_network_scope` to each, uninitializes COM, and asserts success for all specs.

**Call relations**: This test directly exercises the network-scope configuration helper with the same shapes used by the real setup flow.

*Call graph*: calls 1 internal fn (blocked_loopback_tcp_remote_ports); 3 external calls (assert!, CoInitializeEx, CoUninitialize).


##### `tests::local_policy_modify_state_accepts_effective_policy`  (lines 574–576)

```
fn local_policy_modify_state_accepts_effective_policy()
```

**Purpose**: Checks that an `S_OK` result with `NET_FW_MODIFY_STATE_OK` is treated as effective policy.

**Data flow**: It calls `validate_local_policy_modify_result` with the effective combination and asserts that the result is `Ok`.

**Call relations**: This is the positive-path unit test for the policy validator.

*Call graph*: 1 external calls (assert!).


##### `tests::local_policy_modify_state_rejects_ineffective_policy`  (lines 579–590)

```
fn local_policy_modify_state_rejects_ineffective_policy()
```

**Purpose**: Checks that a Group Policy override state is rejected as ineffective.

**Data flow**: It calls `validate_local_policy_modify_result` with `S_OK` and `NET_FW_MODIFY_STATE_GP_OVERRIDE`, extracts the resulting `SetupFailure`, and asserts the error code is `HelperFirewallPolicyIneffective`.

**Call relations**: This test covers one of the fail-fast policy checks used before firewall rule mutation.

*Call graph*: calls 1 internal fn (validate_local_policy_modify_result); 1 external calls (assert_eq!).


##### `tests::local_policy_modify_state_rejects_partial_profile_coverage`  (lines 593–604)

```
fn local_policy_modify_state_rejects_partial_profile_coverage()
```

**Purpose**: Checks that `S_FALSE` partial-profile coverage is rejected even when the modify state itself is OK.

**Data flow**: It calls `validate_local_policy_modify_result` with `S_FALSE` and `NET_FW_MODIFY_STATE_OK`, extracts the `SetupFailure`, and asserts the ineffective-policy error code.

**Call relations**: This test covers the validator branch that rejects non-uniform profile applicability.

*Call graph*: calls 1 internal fn (validate_local_policy_modify_result); 1 external calls (assert_eq!).


### `windows-sandbox-rs/src/wfp/filter_specs.rs`

`data_model` · `request handling`

This file is a compact data-definition module for WFP rule construction. It imports the specific WFP layer GUID constants for IPv4/IPv6 connect authorization and resource assignment, the Winsock protocol numbers for ICMP and ICMPv6, and the `GUID` type used as stable filter keys. The core model consists of `ConditionSpec`, an internal enum describing the supported condition shapes (`User`, `Protocol(u8)`, and `RemotePort(u16)`), and `FilterSpec`, a struct bundling a filter’s unique GUID, human-readable name and description, target WFP layer, and the slice of conditions that should be attached when materializing the filter. `FILTER_SPECS` is a static slice of concrete filter definitions. It includes paired IPv4/IPv6 rules for blocking ICMP at both connect and resource-assignment layers, plus port-based outbound blocks for DNS on ports 53 and 853 and SMB on ports 445 and 139. Every listed filter includes the `User` condition, indicating the rules are scoped to the sandbox account rather than globally. A notable design note is the explicit omission of NAME_RESOLUTION_CACHE filters because validation returned `FWP_E_OUT_OF_BOUNDS`; that comment captures an implementation constraint future maintainers would otherwise miss. The GUIDs are hard-coded to keep filter identity stable across runs and updates.


### Spawn preparation and elevated runner plumbing
These files bridge resolved sandbox permissions into launch-ready state and implement the elevated helper-runner transport used for privileged execution paths.

### `windows-sandbox-rs/src/spawn_prep.rs`

`orchestration` · `spawn preparation before process creation`

This file assembles all pre-launch state for sandboxed execution. `SpawnContext` captures resolved permissions, cwd, log directory, and whether writable-root capabilities are needed; `ElevatedSpawnContext` carries the sandbox base path, logs directory, acquired sandbox credentials, and capability SID strings; `LegacySessionSecurity` packages the restricted token and capability SID objects used by the legacy ACL-based path.

`prepare_spawn_context_common` resolves the permission profile against runtime workspace roots, normalizes environment variables (`NUL`, pager, optional PATH inheritance, optional Git safe.directory injection), ensures `CODEX_HOME` and `.sandbox` exist, starts logging, and computes whether write capabilities are required. `prepare_legacy_spawn_context` adds the offline-network environment rewrite when the resolved permissions disable networking.

For the legacy token path, `prepare_legacy_session_security` either creates a read-only restricted token from the stored readonly capability SID or computes per-root capability SIDs and creates a workspace-write token carrying those capabilities. `legacy_session_capability_roots` and `root_capability_sids` derive the active writable roots and their SID strings, filtering through the same effective-write-root logic used by setup.

`apply_legacy_session_acl_rules` is the main ACL mutator: it computes allow/deny paths, ensures explicit deny-write carveouts exist before launch, grants allow ACEs to either the readonly SID or the most specific matching root capability, applies deny-write ACEs to overlapping root capabilities, persists deny-read ACL state, allows access to the null device for all relevant SIDs, and protects `.codex`/agents directories when the command cwd is itself a writable workspace root. `prepare_elevated_spawn_context_for_permissions` mirrors the environment setup, computes effective write roots and deny paths, ensures sandbox credentials/setup via `require_logon_sandbox_creds`, chooses capability SIDs, and pre-allows the null device for the selected capability.

#### Function details

##### `prepare_spawn_context_common`  (lines 82–120)

```
fn prepare_spawn_context_common(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    codex_home: &Path,
    cwd: &Path,
    env_map: &mut HashMap<String, String>,
```

**Purpose**: Builds the shared spawn context used by both legacy and elevated launch paths. It resolves permissions, normalizes the environment, ensures sandbox directories exist, starts logging, and records whether write capabilities are needed.

**Data flow**: Takes a permission profile, workspace roots, codex home, cwd, mutable environment map, command argv, and `SpawnPrepOptions`. It resolves permissions with `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots`, mutates `env_map` via `normalize_null_device_env`, `ensure_non_interactive_pager`, optional `inherit_path_env`, and optional `inject_git_safe_directory`, ensures `codex_home` exists, creates `codex_home/.sandbox`, sets `logs_base_dir` to that path, calls `log_start(command, logs_base_dir)`, computes `uses_write_capabilities` from `permissions.uses_write_capabilities_for_cwd(cwd, env_map)`, and returns `SpawnContext` containing the resolved permissions and derived state.

**Call relations**: This is the common foundation for `prepare_legacy_spawn_context` and is also exercised directly by tests. It delegates permission resolution and each environment/setup side effect to specialized helpers.

*Call graph*: calls 7 internal fn (ensure_non_interactive_pager, inherit_path_env, normalize_null_device_env, log_start, try_from_permission_profile_for_workspace_roots, ensure_codex_home_exists, inject_git_safe_directory); called by 2 (prepare_legacy_spawn_context, common_spawn_env_keeps_network_env_unchanged); 3 external calls (join, to_path_buf, create_dir_all).


##### `prepare_legacy_spawn_context`  (lines 122–144)

```
fn prepare_legacy_spawn_context(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    codex_home: &Path,
    cwd: &Path,
    env_map: &mut HashMap<String, String>,
```

**Purpose**: Builds the legacy spawn context and applies the offline-network environment rewrite when the resolved permissions require network blocking. It is the legacy-path wrapper around the common preparation logic.

**Data flow**: Takes the same inputs as `prepare_spawn_context_common`, calls that helper to obtain `SpawnContext`, checks `common.permissions.should_apply_network_block()`, conditionally mutates `env_map` with `apply_no_network_to_env`, and returns the context.

**Call relations**: Legacy session launch and capture flows call this before token creation and process spawn. It delegates all shared setup to `prepare_spawn_context_common` and only adds the network-blocking branch.

*Call graph*: calls 2 internal fn (apply_no_network_to_env, prepare_spawn_context_common); called by 3 (legacy_spawn_env_applies_offline_network_rewrite, spawn_windows_sandbox_session_legacy, run_windows_sandbox_capture_with_filesystem_overrides).


##### `prepare_legacy_session_security`  (lines 146–181)

```
fn prepare_legacy_session_security(
    uses_write_capabilities: bool,
    codex_home: &Path,
    cwd: &Path,
    capability_roots: impl IntoIterator<Item = PathBuf>,
) -> Result<LegacySessionSecurity
```

**Purpose**: Creates the restricted token and capability SID state needed for a legacy sandbox session. It chooses between a single readonly capability and per-root writable capabilities.

**Data flow**: Takes `uses_write_capabilities`, `codex_home`, `cwd`, and an iterator of capability roots. It loads stored capability SID strings with `load_or_create_cap_sids`. In the write-capability branch, it computes `write_root_sids` with `root_capability_sids`, bails if none exist, obtains a base token with `get_current_token_for_restriction`, collects raw SID pointers from the root SIDs, creates a restricted token with `create_workspace_write_token_with_caps_from`, closes the base token, and returns a `LegacySessionSecurity` containing the new token and root SIDs. In the readonly branch, it parses the readonly SID string into `LocalSid`, creates a readonly restricted token with `create_readonly_token_with_cap`, and returns `LegacySessionSecurity` containing the token, readonly SID object, readonly SID string, and an empty write-root SID list.

**Call relations**: Legacy spawn and capture paths call this after deciding whether write capabilities are needed and computing capability roots. It delegates SID loading, SID parsing, and token creation to the token/capability modules.

*Call graph*: calls 6 internal fn (load_or_create_cap_sids, root_capability_sids, from_string, create_readonly_token_with_cap, create_workspace_write_token_with_caps_from, get_current_token_for_restriction); called by 2 (spawn_windows_sandbox_session_legacy, run_windows_sandbox_capture_with_filesystem_overrides); 3 external calls (new, bail!, CloseHandle).


##### `legacy_session_capability_roots`  (lines 183–204)

```
fn legacy_session_capability_roots(
    permissions: &ResolvedWindowsSandboxPermissions,
    current_dir: &Path,
    env_map: &HashMap<String, String>,
    codex_home: &Path,
) -> Vec<PathBuf>
```

**Purpose**: Computes the root paths whose capability SIDs should be active for a legacy session. It uses effective write-root filtering when the permissions require writable capabilities.

**Data flow**: Takes resolved permissions, current directory, environment map, and codex home. It computes `allow_paths` from `compute_allow_paths_for_permissions(...).allow`. If `permissions.uses_write_capabilities_for_cwd(current_dir, env_map)` is true, it passes those allow paths as an override into `effective_write_roots_for_permissions` and returns the filtered result; otherwise it returns the raw allow paths.

**Call relations**: Legacy spawn, capture, and preflight code call this before generating root capability SIDs. It delegates allow/deny computation and effective write-root filtering to shared helpers.

*Call graph*: calls 3 internal fn (compute_allow_paths_for_permissions, uses_write_capabilities_for_cwd, effective_write_roots_for_permissions); called by 5 (legacy_capability_roots_use_effective_write_roots, legacy_session_capability_roots_use_runtime_workspace_roots_for_workspace_root, spawn_windows_sandbox_session_legacy, run_windows_sandbox_capture_with_filesystem_overrides, run_windows_sandbox_legacy_preflight).


##### `root_capability_sids`  (lines 206–222)

```
fn root_capability_sids(
    codex_home: &Path,
    cwd: &Path,
    allow_paths: impl IntoIterator<Item = PathBuf>,
) -> Result<Vec<RootCapabilitySid>>
```

**Purpose**: Converts a set of writable root paths into concrete capability SID objects and strings, deduplicated by canonical path. It produces the per-root SID inventory used by tokens and ACLs.

**Data flow**: Takes `codex_home`, `cwd`, and an iterator of allowed root paths. It collects roots into a vector, sorts them by `canonicalize_path`, deduplicates adjacent canonical duplicates, then for each root computes a SID string with `workspace_write_cap_sid_for_root`, parses it into `LocalSid::from_string`, wraps the root, SID object, and SID string into `RootCapabilitySid`, and returns the vector.

**Call relations**: This helper is used by both legacy and elevated spawn preparation, as well as tests and preflight checks. It delegates SID-string derivation to the capability module and SID parsing to `LocalSid`.

*Call graph*: calls 2 internal fn (workspace_write_cap_sid_for_root, from_string); called by 5 (prepare_elevated_spawn_context_for_permissions, prepare_legacy_session_security, legacy_deny_path_includes_nested_active_root_sid, root_capability_sids_only_include_active_roots, run_windows_sandbox_legacy_preflight); 2 external calls (into_iter, with_capacity).


##### `matching_root_capability`  (lines 224–232)

```
fn matching_root_capability(
    path: &Path,
    root_sids: &'a [RootCapabilitySid],
) -> Option<&'a RootCapabilitySid>
```

**Purpose**: Finds the most specific writable-root capability whose root contains a given path. It chooses the capability SID that should receive an allow ACE for that path.

**Data flow**: Takes `path` and a slice of `RootCapabilitySid`, filters to roots where `workspace_write_root_contains_path(&root_sid.root, path)` is true, selects the maximum by `workspace_write_root_specificity(&root_sid.root)`, and returns `Option<&RootCapabilitySid>`.

**Call relations**: `apply_legacy_session_acl_rules` uses this when granting allow ACEs in workspace-write mode so nested writable roots win over broader parents.

*Call graph*: called by 1 (apply_legacy_session_acl_rules); 1 external calls (iter).


##### `deny_root_capabilities_for_path`  (lines 234–247)

```
fn deny_root_capabilities_for_path(
    path: &Path,
    root_sids: &'a [RootCapabilitySid],
) -> Vec<&'a RootCapabilitySid>
```

**Purpose**: Determines which writable-root capabilities should receive a deny-write ACE for a protected path. It narrows to overlapping roots when possible and falls back to all roots otherwise.

**Data flow**: Takes `path` and a slice of `RootCapabilitySid`, collects all roots where `workspace_write_root_overlaps_path(&root_sid.root, path)` is true, and returns that subset if non-empty; otherwise it returns references to all root SIDs.

**Call relations**: `apply_legacy_session_acl_rules` uses this when applying deny-write ACEs so protected paths are denied to every relevant capability, including nested active roots.

*Call graph*: called by 2 (apply_legacy_session_acl_rules, legacy_deny_path_includes_nested_active_root_sid); 1 external calls (iter).


##### `allow_null_device_for_workspace_write`  (lines 249–264)

```
fn allow_null_device_for_workspace_write(is_workspace_write: bool)
```

**Purpose**: Ensures the current logon SID can access the null device when workspace-write mode is active. It is a compatibility fix for sandboxed processes that expect `NUL` to be usable.

**Data flow**: Takes `is_workspace_write: bool`. If false, it returns immediately. Otherwise it obtains the current token with `get_current_token_for_restriction`, extracts the logon SID bytes with `get_logon_sid_bytes`, casts the bytes to a PSID pointer, calls `allow_null_device(psid)`, and closes the token handle with `CloseHandle`.

**Call relations**: Legacy spawn and capture flows call this as an extra compatibility step when using workspace-write capabilities. It delegates SID extraction and null-device ACL mutation to lower-level helpers.

*Call graph*: calls 3 internal fn (allow_null_device, get_current_token_for_restriction, get_logon_sid_bytes); called by 2 (spawn_windows_sandbox_session_legacy, run_windows_sandbox_capture_with_filesystem_overrides); 1 external calls (CloseHandle).


##### `apply_legacy_session_acl_rules`  (lines 267–345)

```
fn apply_legacy_session_acl_rules(
    permissions: &ResolvedWindowsSandboxPermissions,
    codex_home: &Path,
    current_dir: &Path,
    env_map: &HashMap<String, String>,
    additional_deny_read_p
```

**Purpose**: Applies filesystem ACL allow/deny rules for a legacy sandbox session based on resolved permissions, explicit carveouts, and the active capability SIDs. It is the main ACL mutation routine before launching a legacy sandboxed process.

**Data flow**: Takes resolved permissions, codex home, current dir, env map, slices of additional deny-read and deny-write paths, and `LegacyAclSids`. It computes `AllowDenyPaths` from `compute_allow_paths_for_permissions`, ensures each explicit deny-write path exists by creating directories when missing, inserts those paths into the deny set, then in an unsafe block grants allow ACEs: either every allowed path gets `add_allow_ace` for the readonly SID, or each allowed path gets an allow ACE for the most specific matching root capability from `matching_root_capability`. It then applies `add_deny_write_ace` for each deny path against every relevant root capability from `deny_root_capabilities_for_path`. If deny-read paths were supplied, it persists deny-read ACL state with `sync_persistent_deny_read_acls`, using either the readonly SID string or each root capability SID string. It calls `allow_null_device` for every write-root SID and optional readonly SID. Finally, if write-root capabilities exist and the current dir is itself the root of a writable workspace capability, it canonicalizes the cwd and protects `.codex` and agents directories via `protect_workspace_codex_dir` and `protect_workspace_agents_dir`. It returns `Ok(())` or propagates contextual filesystem/setup errors.

**Call relations**: Legacy session launch, capture, and preflight flows call this after token and capability preparation. It delegates path computation, ACE application, persistent deny-read syncing, and workspace-directory protection to specialized modules.

*Call graph*: calls 11 internal fn (add_allow_ace, add_deny_write_ace, allow_null_device, compute_allow_paths_for_permissions, sync_persistent_deny_read_acls, canonicalize_path, deny_root_capabilities_for_path, matching_root_capability, is_command_cwd_root, protect_workspace_agents_dir (+1 more)); called by 3 (spawn_windows_sandbox_session_legacy, run_windows_sandbox_capture_with_filesystem_overrides, run_windows_sandbox_legacy_preflight); 3 external calls (is_empty, bail!, create_dir_all).


##### `prepare_elevated_spawn_context_for_permissions`  (lines 348–443)

```
fn prepare_elevated_spawn_context_for_permissions(
    permissions: ResolvedWindowsSandboxPermissions,
    codex_home: &Path,
    cwd: &Path,
    env_map: &mut HashMap<String, String>,
    command: &[
```

**Purpose**: Prepares the environment, setup state, sandbox credentials, and capability SID list needed for the elevated sandbox spawn path. It coordinates setup refresh/provisioning with the final capability selection used at launch time.

**Data flow**: Takes resolved permissions, codex home, cwd, mutable env map, command argv, optional read/write-root overrides, deny-read and deny-write overrides, and `proxy_enforced`. It mutates `env_map` with `normalize_null_device_env`, `ensure_non_interactive_pager`, `inherit_path_env`, and `inject_git_safe_directory`; ensures `codex_home/.sandbox` exists via `ensure_codex_home_exists`; starts logging; computes `uses_write_capabilities`; computes `AllowDenyPaths` from `compute_allow_paths_for_permissions`; derives candidate write roots and deny-write paths; if write capabilities are needed, computes `effective_write_roots_for_permissions` and uses them as the setup write-root override; calls `require_logon_sandbox_creds` with the resolved permissions, overrides, deny paths, and proxy flag to ensure setup/users are ready; loads capability SID strings with `load_or_create_cap_sids`; chooses either the first effective write-root SID list from `root_capability_sids` or the readonly SID from stored caps; parses the selected SID into `LocalSid`, calls `allow_null_device` for that SID, and returns `ElevatedSpawnContext { sandbox_base, logs_base_dir, sandbox_creds, cap_sids }`.

**Call relations**: The elevated session spawn path calls this before process creation. It delegates environment normalization, write-root filtering, credential/setup orchestration, capability SID derivation, and null-device ACL adjustment to shared helpers.

*Call graph*: calls 14 internal fn (allow_null_device, compute_allow_paths_for_permissions, load_or_create_cap_sids, ensure_non_interactive_pager, inherit_path_env, normalize_null_device_env, require_logon_sandbox_creds, log_start, uses_write_capabilities_for_cwd, ensure_codex_home_exists (+4 more)); called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 5 external calls (join, is_empty, new, bail!, vec!).


##### `tests::workspace_profile`  (lines 464–476)

```
fn workspace_profile(
        network_policy: NetworkSandboxPolicy,
        writable_roots: &[AbsolutePathBuf],
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> Permissi
```

**Purpose**: Constructs a workspace-write permission profile with configurable network policy and tmpdir exclusions for spawn-preparation tests. It reduces repeated profile-building boilerplate.

**Data flow**: Takes network policy, writable roots, and tmpdir exclusion flags, calls `PermissionProfile::workspace_write_with`, and returns the resulting profile.

**Call relations**: Several tests use this helper before resolving permissions or preparing spawn contexts.

*Call graph*: calls 1 internal fn (workspace_write_with).


##### `tests::workspace_roots_for`  (lines 478–480)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Builds a one-element workspace-root vector from an absolute path for tests. It keeps test setup concise.

**Data flow**: Converts `root: &Path` into `AbsolutePathBuf` and returns it inside a `Vec`.

**Call relations**: Tests use this helper before calling permission resolution or spawn-preparation functions.

*Call graph*: 1 external calls (vec!).


##### `tests::should_apply_network_block`  (lines 482–489)

```
fn should_apply_network_block(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Resolves a permission profile and returns whether it should trigger the offline-network environment rewrite. It is a test-only convenience wrapper.

**Data flow**: Takes a permission profile, resolves it with `ResolvedWindowsSandboxPermissions::try_from_permission_profile_for_workspace_roots(permission_profile, &[])`, unwraps success, calls `.should_apply_network_block()`, and returns the boolean.

**Call relations**: The first two tests use this helper to assert network-blocking decisions without constructing full spawn contexts.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots).


##### `tests::no_network_env_rewrite_applies_for_workspace_write`  (lines 492–496)

```
fn no_network_env_rewrite_applies_for_workspace_write()
```

**Purpose**: Verifies that the default workspace-write profile requests network blocking. It checks the restricted-network default.

**Data flow**: Calls `should_apply_network_block(&PermissionProfile::workspace_write())` and asserts the result is true.

**Call relations**: This test exercises the network-policy interpretation in `ResolvedWindowsSandboxPermissions` through the test helper.

*Call graph*: 1 external calls (assert!).


##### `tests::no_network_env_rewrite_skips_when_network_access_is_allowed`  (lines 499–506)

```
fn no_network_env_rewrite_skips_when_network_access_is_allowed()
```

**Purpose**: Verifies that a workspace-write profile with enabled network access does not request the offline-network rewrite. It checks the enabled-network branch.

**Data flow**: Builds a workspace profile with `NetworkSandboxPolicy::Enabled`, calls `should_apply_network_block`, and asserts the result is false.

**Call relations**: This test validates the opposite branch of the network-blocking predicate.

*Call graph*: 1 external calls (assert!).


##### `tests::legacy_spawn_env_applies_offline_network_rewrite`  (lines 509–534)

```
fn legacy_spawn_env_applies_offline_network_rewrite()
```

**Purpose**: Verifies that legacy spawn preparation rewrites the environment for offline networking when the permissions require it. It checks the side effects on proxy-related environment variables.

**Data flow**: Creates temporary codex-home and cwd directories, an empty environment map, and workspace roots, calls `prepare_legacy_spawn_context` with `PermissionProfile::workspace_write()`, then asserts `SBX_NONET_ACTIVE=1` and `HTTP_PROXY=http://127.0.0.1:9` are present in `env_map`.

**Call relations**: This test exercises `prepare_legacy_spawn_context` and its conditional call to `apply_no_network_to_env`.

*Call graph*: calls 2 internal fn (workspace_write, prepare_legacy_spawn_context); 4 external calls (new, new, assert_eq!, workspace_roots_for).


##### `tests::common_spawn_env_keeps_network_env_unchanged`  (lines 537–566)

```
fn common_spawn_env_keeps_network_env_unchanged()
```

**Purpose**: Verifies that the common spawn-preparation path does not itself rewrite network environment variables. It checks that only the legacy wrapper adds offline-network mutation.

**Data flow**: Creates temporary codex-home and cwd directories, initializes `env_map` with an existing `HTTP_PROXY`, calls `prepare_spawn_context_common` with Git safe-directory injection enabled, asserts `context.uses_write_capabilities` is true, and checks that `SBX_NONET_ACTIVE` is absent and `HTTP_PROXY` remains unchanged.

**Call relations**: This test directly exercises `prepare_spawn_context_common` and contrasts its behavior with `prepare_legacy_spawn_context`.

*Call graph*: calls 2 internal fn (workspace_write, prepare_spawn_context_common); 5 external calls (from, new, assert!, assert_eq!, workspace_roots_for).


##### `tests::legacy_session_capability_roots_use_runtime_workspace_roots_for_workspace_root`  (lines 569–602)

```
fn legacy_session_capability_roots_use_runtime_workspace_roots_for_workspace_root()
```

**Purpose**: Verifies that legacy capability-root computation resolves symbolic workspace-root permissions to the actual runtime workspace root. It checks the integration with effective write-root filtering.

**Data flow**: Creates codex-home, workspace root, and nested command cwd, resolves a workspace-write profile with runtime workspace roots, calls `legacy_session_capability_roots`, and asserts the result is the canonical workspace root.

**Call relations**: This test exercises `legacy_session_capability_roots` and its delegation to `effective_write_roots_for_permissions` when write capabilities are active.

*Call graph*: calls 2 internal fn (try_from_permission_profile_for_workspace_roots, legacy_session_capability_roots); 6 external calls (new, new, assert_eq!, create_dir_all, workspace_profile, workspace_roots_for).


##### `tests::root_capability_sids_only_include_active_roots`  (lines 605–639)

```
fn root_capability_sids_only_include_active_roots()
```

**Purpose**: Verifies that root capability SID generation only includes currently active writable roots and not stale or generic workspace capability SIDs. It checks canonical deduplication and per-root SID derivation.

**Data flow**: Creates codex-home, workspace, active root, and stale root, precomputes SID strings for each root and the generic workspace capability, calls `root_capability_sids` with only workspace and active root, collects the returned SID strings, and asserts the active and workspace-root SIDs are present while the stale and generic workspace capability SIDs are absent.

**Call relations**: This test directly validates `root_capability_sids` and its use of `workspace_write_cap_sid_for_root`.

*Call graph*: calls 3 internal fn (load_or_create_cap_sids, workspace_write_cap_sid_for_root, root_capability_sids); 5 external calls (new, assert!, assert_eq!, create_dir_all, vec!).


##### `tests::legacy_deny_path_includes_nested_active_root_sid`  (lines 642–675)

```
fn legacy_deny_path_includes_nested_active_root_sid()
```

**Purpose**: Verifies that deny-write targeting for a protected path includes both the enclosing workspace root capability and any nested active writable root capability that overlaps the path. It checks overlap-based deny selection.

**Data flow**: Creates codex-home, workspace, a protected `.codex` directory, a nested writable root inside it, and an unrelated root, computes root capability SIDs, calls `deny_root_capabilities_for_path(&protected_dir, &root_sids)`, collects SID strings, and asserts the workspace and nested-root SIDs are included while the unrelated SID is not.

**Call relations**: This test directly exercises `deny_root_capabilities_for_path` and the overlap logic used by `apply_legacy_session_acl_rules`.

*Call graph*: calls 3 internal fn (workspace_write_cap_sid_for_root, deny_root_capabilities_for_path, root_capability_sids); 5 external calls (new, assert!, assert_eq!, create_dir_all, vec!).


##### `tests::legacy_capability_roots_use_effective_write_roots`  (lines 678–715)

```
fn legacy_capability_roots_use_effective_write_roots()
```

**Purpose**: Verifies that legacy capability-root computation uses the filtered effective write roots rather than raw writable roots, excluding protected Codex paths. It checks consistency with setup write-root filtering.

**Data flow**: Creates codex-home, workspace, active root, and sandbox root, resolves a workspace-write profile whose writable roots include active root plus forbidden Codex paths, calls `legacy_session_capability_roots`, canonicalizes expected and forbidden paths, and asserts workspace and active root are present while codex-home and sandbox root are absent.

**Call relations**: This test validates that `legacy_session_capability_roots` delegates to `effective_write_roots_for_permissions` in workspace-write mode.

*Call graph*: calls 2 internal fn (try_from_permission_profile_for_workspace_roots, legacy_session_capability_roots); 7 external calls (new, new, assert!, create_dir_all, vec!, workspace_profile, workspace_roots_for).


### `windows-sandbox-rs/src/elevated_impl.rs`

`orchestration` · `sandbox process launch and output capture`

This file defines the request object for elevated capture, then splits behavior into a Windows-only implementation and a non-Windows stub. `ElevatedSandboxProfileCaptureRequest` bundles everything the elevated backend needs in one struct: the `PermissionProfile`, workspace roots, command/cwd/env, timeout and cancellation, desktop mode, proxy policy, and explicit filesystem override lists for read/write allow and deny roots.

On Windows, the main routine first resolves `ResolvedWindowsSandboxPermissions` from the permission profile and workspace roots, converts deny overrides from `AbsolutePathBuf` to plain `PathBuf`, and normalizes the environment for Windows execution (`/dev/null` → `NUL`, pager defaults, inherited `PATH`, Git safe-directory injection). It ensures a writable `.sandbox` log/home area under `codex_home`, logs command start, and obtains sandbox logon credentials via `require_logon_sandbox_creds`, with a retry path through `refresh_logon_sandbox_creds` if the runner reports stale credentials.

Before launch it computes capability SIDs: either per-write-root capability SIDs for workspace-write mode or the readonly capability SID otherwise, and grants the chosen SID access to the null device. It then builds an IPC `SpawnRequest`, starts the runner transport, optionally spawns a polling cancellation thread that writes a `Message::Terminate` frame, and enters a framed-message loop. `SpawnReady` is ignored, `Output` frames are base64-decoded and appended to stdout/stderr buffers by `OutputStream`, `Exit` ends successfully, and `Error` or any unexpected message aborts. After cleanup it logs success/failure based on exit code and returns `CaptureResult` with collected bytes and timeout state.

#### Function details

##### `windows_impl::spawn_cancel_writer`  (lines 67–95)

```
fn spawn_cancel_writer(
        pipe_write: &File,
        cancellation: Option<crate::WindowsSandboxCancellationToken>,
    ) -> Result<Option<(std::thread::JoinHandle<()>, Arc<AtomicBool>)>>
```

**Purpose**: Starts an auxiliary thread that watches an optional `WindowsSandboxCancellationToken` and, once cancellation is requested, sends a framed terminate message to the runner pipe. If no token is supplied, it returns `None` and no thread is created.

**Data flow**: It takes a writable `File` handle for the IPC pipe and an optional cancellation token. The function clones the file handle, allocates an `Arc<AtomicBool>` completion flag, and spawns a thread that polls `cancellation.is_cancelled()` every 50 ms using `park_timeout`; on cancellation it writes a `FramedMessage { version: 1, message: Message::Terminate { ... } }` to the pipe. It returns `Ok(Some((JoinHandle, done_flag)))` for later shutdown coordination, or `Ok(None)` when cancellation is absent.

**Call relations**: It is invoked only by `windows_impl::run_windows_sandbox_capture_for_permission_profile` after the runner transport has been established and before the IPC read loop begins. Its sole downstream action is writing the terminate frame into the same runner IPC channel so the helper can stop cooperatively instead of being killed externally.

*Call graph*: 5 external calls (clone, new, new, try_clone, spawn).


##### `windows_impl::run_windows_sandbox_capture_for_permission_profile`  (lines 99–282)

```
fn run_windows_sandbox_capture_for_permission_profile(
        request: ElevatedSandboxProfileCaptureRequest<'_>,
    ) -> Result<CaptureResult>
```

**Purpose**: Runs a command through the elevated Windows sandbox backend by preparing permissions and credentials, launching the command-runner helper over framed IPC, and collecting stdout/stderr until exit. It is the core elevated capture implementation used on Windows.

**Data flow**: It consumes an `ElevatedSandboxProfileCaptureRequest`, destructures all fields, derives `ResolvedWindowsSandboxPermissions`, converts deny override slices into owned `Vec<PathBuf>`, and mutates `env_map` with Windows-safe defaults. It creates/uses `codex_home/.sandbox` for logs and helper state, logs command start, and obtains `SandboxCreds`. It reads or creates capability SID state, computes either readonly or per-write-root capability SIDs, converts the first SID string into `LocalSid`, and grants that SID null-device access. It then builds a `SpawnRequest` containing command, cwd, cloned env, cloned permission profile, workspace roots, sandbox home paths, capability SIDs, timeout, and desktop settings. After spawning the runner transport—retrying once with refreshed credentials if the first failure matches stale-credential detection—it reads framed messages from the pipe, base64-decodes output payloads into `stdout`/`stderr` byte buffers, and stops on `Exit`, `Error`, EOF, decode failure, or unexpected message. Finally it stops the cancellation thread if present, drops the write pipe, logs success or failure from the exit code, and returns `CaptureResult { exit_code, stdout, stderr, timed_out }`.

**Call relations**: This function is the public Windows export from the file and is called by higher-level elevated sandbox execution paths. It delegates environment shaping to `normalize_null_device_env`, `ensure_non_interactive_pager`, `inherit_path_env`, and `inject_git_safe_directory`; setup/credential work to `require_logon_sandbox_creds` and possibly `refresh_logon_sandbox_creds`; capability and ACL preparation to `load_or_create_cap_sids`, `workspace_write_cap_sid_for_root`, `effective_write_roots_for_permissions`, `LocalSid::from_string`, and `allow_null_device`; transport startup to `spawn_runner_transport`; cancellation support to `spawn_cancel_writer`; and framed IPC parsing to `read_frame`, `decode_bytes`, and message matching.

*Call graph*: calls 12 internal fn (allow_null_device, load_or_create_cap_sids, ensure_non_interactive_pager, inherit_path_env, normalize_null_device_env, require_logon_sandbox_creds, log_start, try_from_permission_profile_for_workspace_roots, ensure_codex_home_exists, inject_git_safe_directory (+2 more)); 2 external calls (bail!, vec!).


##### `stub::run_windows_sandbox_capture_for_permission_profile`  (lines 304–308)

```
fn run_windows_sandbox_capture_for_permission_profile(
        _request: ElevatedSandboxProfileCaptureRequest<'_>,
    ) -> Result<CaptureResult>
```

**Purpose**: Provides the non-Windows placeholder for the elevated capture API. It exists so the crate compiles cross-platform while making it explicit that this backend is Windows-only.

**Data flow**: It accepts the same request type as the Windows implementation but ignores it entirely. The function immediately returns an error via `bail!` stating that the Windows sandbox is only available on Windows.

**Call relations**: This version is exported only when the target OS is not Windows. It does not delegate further work and serves as the terminal branch for unsupported platforms.

*Call graph*: 1 external calls (bail!).


### `windows-sandbox-rs/src/elevated/mod.rs`

`orchestration` · `startup`

This module file is a structural entry point for the `elevated` portion of the Windows sandbox crate. It does not contain executable logic; instead, it declares three crate-visible submodules: `ipc_framed`, `runner_client`, and `runner_pipe`. Together, those names indicate the elevated subsystem is split into transport framing, client-side coordination, and named-pipe or pipe-based process communication concerns. By placing these declarations in `mod.rs` and marking them `pub(crate)`, the crate exposes the elevated subsystem internally while keeping it hidden from external consumers. The file’s main role is to define the namespace boundary and compilation unit layout so other crate modules can refer to `crate::elevated::...` components consistently. This separation is especially useful in a sandboxing context where elevated helpers often require distinct IPC protocols and process-launch paths from ordinary execution. There are no invariants or state transitions in this file itself; the design choice here is organizational: keep elevated-runner plumbing cohesive and explicitly internal to the crate.


### `windows-sandbox-rs/src/elevated/runner_client.rs`

`orchestration` · `elevated runner startup and handshake`

This file is the parent-side driver for the elevated runner process. It owns the logic for spawning `codex-command-runner.exe` with `CreateProcessWithLogonW`, connecting the two named pipes used for framed IPC, sending the initial `SpawnRequest`, and waiting for a `SpawnReady` acknowledgment. The public transport surface is `RunnerTransport`, which wraps the write and read pipe `File`s and exposes helpers for the startup handshake.

A key concern here is avoiding hangs and leaked helper processes. `connect_pipe_with_timeout` performs each blocking pipe connection on a helper thread, duplicates that thread’s handle back to the parent, and waits up to `RUNNER_PIPE_CONNECT_TIMEOUT`. If the timeout expires, it attempts `CancelSynchronousIo` on the specific helper thread; if cancellation cannot be confirmed, it still returns a timeout error and relies on later pipe-handle cleanup to unwind the blocked connect. `try_take_completed_connect_result` handles the race where the helper thread may have just finished as the timeout fires.

After process creation, `spawn_runner_transport` keeps the runner process handle alive through both pipe connection and framed startup. Any failure in spawning, connecting, sending the request, or receiving `spawn_ready` triggers aggressive cleanup: terminate the runner process if it exists, close raw handles, and drop partially built transport state. `wait_for_complete_frame` uses `PeekNamedPipe` polling to ensure a full frame is buffered before `read_frame`, preventing indefinite blocking while waiting for the runner’s first response. The file also defines `RunnerLogonError` and a classifier helper that recognizes stale sandbox credentials specifically by `ERROR_LOGON_FAILURE`.

#### Function details

##### `RunnerLogonError::fmt`  (lines 59–61)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a runner logon failure as a human-readable message containing the Win32 error code. It gives the custom error type a stable display string.

**Data flow**: It reads `self.code` and writes `"CreateProcessWithLogonW failed: {code}"` into the provided formatter, returning the formatter result. It mutates no external state.

**Call relations**: This method is used implicitly when `RunnerLogonError` is wrapped into `anyhow::Error` and later displayed by callers or logs.

*Call graph*: 1 external calls (write!).


##### `is_stale_sandbox_creds_error`  (lines 71–74)

```
fn is_stale_sandbox_creds_error(err: &anyhow::Error) -> bool
```

**Purpose**: Detects whether an `anyhow::Error` originated from a runner logon failure specifically caused by invalid credentials. It distinguishes stale sandbox credentials from other launch failures.

**Data flow**: It takes a borrowed `anyhow::Error`, attempts `downcast_ref::<RunnerLogonError>()`, checks whether the embedded code equals `ERROR_LOGON_FAILURE`, and returns a boolean. It reads no global state.

**Call relations**: This classifier is called by elevated session startup code higher up the stack to decide whether a launch failure should trigger credential refresh or a different recovery path.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile).


##### `RunnerTransport::send_spawn_request`  (lines 77–85)

```
fn send_spawn_request(&mut self, request: SpawnRequest) -> Result<()>
```

**Purpose**: Wraps a `SpawnRequest` in the framed protocol envelope and writes it to the runner’s outbound pipe. It is the first message sent after pipe connection succeeds.

**Data flow**: It takes mutable access to `self` and an owned `SpawnRequest`, constructs a `FramedMessage` with the current `IPC_PROTOCOL_VERSION` and `Message::SpawnRequest`, then writes it to `self.pipe_write` via `write_frame`, returning the resulting `Result<()>`.

**Call relations**: This method is called during `spawn_runner_transport` after both named pipes are connected. It delegates serialization and framing to the IPC module.

*Call graph*: calls 1 internal fn (write_frame); 1 external calls (new).


##### `RunnerTransport::read_spawn_ready`  (lines 87–98)

```
fn read_spawn_ready(&mut self) -> Result<()>
```

**Purpose**: Waits for and validates the runner’s initial acknowledgment frame. It accepts only `SpawnReady`, converts runner-side `Error` frames into local errors, and rejects any other message type.

**Data flow**: It takes mutable access to `self`, first calls `wait_for_complete_frame` on `self.pipe_read` with the startup timeout, then reads one frame with `read_frame`. If EOF occurs it returns an error about the pipe closing early; otherwise it pattern-matches the message and returns `Ok(())` for `SpawnReady`, an `anyhow` error containing the runner message for `Error`, or an `anyhow` error describing the unexpected variant.

**Call relations**: This method is the second half of the startup handshake in `spawn_runner_transport`, immediately following `send_spawn_request`.

*Call graph*: calls 2 internal fn (read_frame, wait_for_complete_frame); 1 external calls (anyhow!).


##### `RunnerTransport::into_files`  (lines 100–102)

```
fn into_files(self) -> (File, File)
```

**Purpose**: Consumes the transport wrapper and returns the underlying write and read pipe files. It hands ownership of the established IPC channel to later stages.

**Data flow**: It takes ownership of `self` and returns a tuple `(File, File)` containing `pipe_write` and `pipe_read`. No additional transformation occurs.

**Call relations**: Callers use this after startup succeeds and they want direct access to the connected pipe files rather than the handshake-oriented wrapper.


##### `try_take_completed_connect_result`  (lines 105–124)

```
fn try_take_completed_connect_result(
    connect_thread: &mut Option<thread::JoinHandle<()>>,
    connect_result_rx: &mpsc::Receiver<Result<()>>,
    thread_handle: HANDLE,
    pipe_label: &str,
) ->
```

**Purpose**: Checks whether the helper thread performing a blocking pipe connect has already finished and, if so, retrieves its reported result. It resolves timeout races without blocking indefinitely.

**Data flow**: It takes mutable access to the optional join handle, the receiver carrying the connect result, the duplicated helper thread `HANDLE`, and a pipe label. It polls the thread with `WaitForSingleObject(..., 0)`; if the thread is still running it returns `Ok(None)`. If finished, it joins the thread if present, receives the reported `Result<()>` from the channel, and returns `Ok(Some(result))`, or an error if the thread exited before sending.

**Call relations**: This helper is used only inside `connect_pipe_with_timeout` on timeout paths and race windows where the helper thread may have completed just as cancellation logic begins.

*Call graph*: calls 1 internal fn (recv); called by 1 (connect_pipe_with_timeout); 1 external calls (WaitForSingleObject).


##### `connect_pipe_with_timeout`  (lines 126–236)

```
fn connect_pipe_with_timeout(
    h_pipe: HANDLE,
    expected_runner_pid: u32,
    pipe_label: &str,
) -> Result<()>
```

**Purpose**: Connects one server-side named pipe to the runner process with a bounded wait and cancellation strategy. It isolates the blocking `ConnectNamedPipe` call on a helper thread so the parent can time out safely.

**Data flow**: It takes a pipe handle, expected runner PID, and pipe label. It spawns a named helper thread that duplicates its own thread handle back to the parent, then calls `connect_pipe` and sends the result over a channel. The parent receives the duplicated thread handle, waits up to `RUNNER_PIPE_CONNECT_TIMEOUT` for the result, joins the thread on normal completion, uses `try_take_completed_connect_result` to resolve races, attempts `CancelSynchronousIo` on timeout, closes the duplicated thread handle, and returns either the connect result or a contextual timeout/cancellation error.

**Call relations**: This function is called twice by `spawn_runner_transport`, once for each pipe direction. It delegates the actual pipe handshake and PID verification to `connect_pipe` from `runner_pipe`.

*Call graph*: calls 1 internal fn (try_take_completed_connect_result); 7 external calls (anyhow!, format!, sync_channel, new, CloseHandle, GetLastError, CancelSynchronousIo).


##### `spawn_runner_transport`  (lines 238–368)

```
fn spawn_runner_transport(
    codex_home: &Path,
    cwd: &Path,
    sandbox_creds: &SandboxCreds,
    log_dir: Option<&Path>,
    spawn_request: SpawnRequest,
) -> Result<RunnerTransport>
```

**Purpose**: Creates the named pipes, launches the elevated runner process under sandbox credentials, completes pipe connection and framed startup, and returns a ready-to-use transport. It is the main parent-side entrypoint for elevated runner startup.

**Data flow**: It takes `codex_home`, `cwd`, sandbox credentials, optional log directory, and a `SpawnRequest`. It generates pipe names with `pipe_pair`, creates server pipes with `create_named_pipe`, resolves the runner executable with `find_runner_exe`, builds a quoted command line and UTF-16 strings, initializes `STARTUPINFOW` and `PROCESS_INFORMATION`, temporarily sets process error mode, calls `CreateProcessWithLogonW`, and on success records the runner PID. It then connects both pipes via `connect_pipe_with_timeout`, closes the thread handle from process creation, converts connected pipe handles into `File`s, sends the spawn request and waits for spawn-ready through `RunnerTransport`, terminates and cleans up the runner on any failure, closes the process handle once startup is fully complete, and returns the transport.

**Call relations**: This is the orchestration hub for the elevated path. It ties together pipe creation, helper executable lookup, Win32 process creation, timeout-managed pipe connection, and the framed IPC handshake methods on `RunnerTransport`.

*Call graph*: calls 4 internal fn (create_named_pipe, find_runner_exe, pipe_pair, to_wide); 9 external calls (from_raw_handle, format!, null, zeroed, CloseHandle, GetLastError, SetErrorMode, CreateProcessWithLogonW, TerminateProcess).


##### `wait_for_complete_frame`  (lines 370–414)

```
fn wait_for_complete_frame(pipe_read: &File, timeout: Duration) -> Result<()>
```

**Purpose**: Polls a named pipe until an entire framed message is buffered or a timeout expires. It prevents `read_frame` from blocking on a partial startup response.

**Data flow**: It takes a borrowed `File` and a timeout `Duration`, obtains the raw pipe handle, computes a deadline, and loops calling `PeekNamedPipe` into a 4-byte length buffer. If four bytes are available it decodes the frame length, checks for overflow when adding the header size, and returns success once `total_available` covers the whole frame; otherwise it sleeps for `RUNNER_SPAWN_READY_POLL_INTERVAL` until the deadline, returning contextual errors on `PeekNamedPipe` failure or timeout.

**Call relations**: This helper is called only by `RunnerTransport::read_spawn_ready` before `read_frame`, specifically for the startup handshake where bounded waiting is important.

*Call graph*: called by 1 (read_spawn_ready); 8 external calls (as_raw_handle, now, anyhow!, null_mut, sleep, from_le_bytes, GetLastError, PeekNamedPipe).


##### `tests::stale_sandbox_creds_error_recognizes_logon_failures`  (lines 425–434)

```
fn stale_sandbox_creds_error_recognizes_logon_failures()
```

**Purpose**: Verifies that only `ERROR_LOGON_FAILURE` is classified as stale sandbox credentials, while other runner launch errors are not. It protects the error-classification contract used by higher-level recovery logic.

**Data flow**: It constructs two `anyhow::Error` values wrapping `RunnerLogonError` with different codes, maps them through `is_stale_sandbox_creds_error`, and asserts the resulting boolean array equals `[true, false]`.

**Call relations**: This test directly exercises `is_stale_sandbox_creds_error` against representative `RunnerLogonError` values.

*Call graph*: 1 external calls (assert_eq!).


### `windows-sandbox-rs/src/elevated/runner_pipe.rs`

`io_transport` · `elevated runner IPC setup`

This file contains the parent-side named-pipe primitives used to establish IPC with the elevated command runner. It is narrowly focused on Windows pipe setup and security. `find_runner_exe` resolves the helper executable path, preferring the materialized helper under `.sandbox-bin` while preserving a fallback strategy encapsulated elsewhere.

`pipe_pair` generates a unique base pipe name using a random `u128` nonce and returns two related names suffixed with `-in` and `-out`, giving the parent separate channels for writing to and reading from the runner. `create_named_pipe` then creates one server-side pipe with a DACL that grants generic all access only to the sandbox user. To do that, it resolves the sandbox username to SID bytes, converts those bytes back into a SID string, embeds that SID into an SDDL string of the form `D:(A;;GA;;;SID)`, converts the SDDL into a security descriptor, and passes it through `SECURITY_ATTRIBUTES` to `CreateNamedPipeW`. The temporary security descriptor is always freed with `LocalFree`.

`connect_pipe` performs the actual server-side connection handshake. It tolerates the `ERROR_PIPE_CONNECTED` case where the client connected before `ConnectNamedPipe` ran, then calls `GetNamedPipeClientProcessId` and rejects the connection if the client PID does not match the runner process the parent just spawned. That PID check is an important integrity guard against another local process racing to connect to the pipe first.

#### Function details

##### `find_runner_exe`  (lines 43–45)

```
fn find_runner_exe(codex_home: &Path, log_dir: Option<&Path>) -> PathBuf
```

**Purpose**: Resolves the filesystem path of the elevated command runner executable. It delegates helper selection and materialization policy to the helper-launch subsystem.

**Data flow**: It takes `codex_home` and an optional log directory, passes them with `HelperExecutable::CommandRunner` to `resolve_helper_for_launch`, and returns the resulting `PathBuf`. It performs no additional transformation.

**Call relations**: This helper is called by `spawn_runner_transport` before process creation so the parent knows which runner binary to launch.

*Call graph*: calls 1 internal fn (resolve_helper_for_launch); called by 1 (spawn_runner_transport).


##### `pipe_pair`  (lines 48–53)

```
fn pipe_pair() -> (String, String)
```

**Purpose**: Generates a unique pair of named-pipe paths for one runner session. The two names share a random base and differ only by direction suffix.

**Data flow**: It seeds a `SmallRng` from entropy, generates a random `u128` nonce, formats a base string under `\\.\pipe\codex-runner-{nonce:x}`, appends `-in` and `-out`, and returns the two `String`s.

**Call relations**: This function is used by `spawn_runner_transport` to allocate fresh pipe names before creating the server-side pipe handles.

*Call graph*: called by 1 (spawn_runner_transport); 2 external calls (from_entropy, format!).


##### `create_named_pipe`  (lines 56–103)

```
fn create_named_pipe(name: &str, access: u32, sandbox_username: &str) -> io::Result<HANDLE>
```

**Purpose**: Creates a server-side named pipe whose security descriptor allows only the sandbox user to connect. It is the security-sensitive pipe-construction primitive for the elevated path.

**Data flow**: It takes the pipe name, desired access flags, and sandbox username. It resolves the username to SID bytes with `resolve_sid`, converts those bytes to a SID string with `string_from_sid_bytes`, formats an SDDL DACL granting `GA` to that SID, converts the SDDL to a security descriptor with `ConvertStringSecurityDescriptorToSecurityDescriptorW`, fills a `SECURITY_ATTRIBUTES` pointing at that descriptor, creates the pipe with `CreateNamedPipeW`, frees the descriptor with `LocalFree`, and returns either the `HANDLE` or an `io::Error` derived from the relevant Win32 error code.

**Call relations**: This function is called by `spawn_runner_transport` for both the inbound and outbound server pipes before the runner process is launched.

*Call graph*: calls 3 internal fn (resolve_sid, string_from_sid_bytes, to_wide); called by 1 (spawn_runner_transport); 7 external calls (from_raw_os_error, format!, null_mut, GetLastError, LocalFree, ConvertStringSecurityDescriptorToSecurityDescriptorW, CreateNamedPipeW).


##### `connect_pipe`  (lines 110–135)

```
fn connect_pipe(h: HANDLE, expected_runner_pid: u32) -> io::Result<()>
```

**Purpose**: Waits for a client to connect to a server-side named pipe and verifies that the client process is the expected runner. It closes the race where an unrelated process could connect first.

**Data flow**: It takes a pipe `HANDLE` and expected runner PID, calls `ConnectNamedPipe`, tolerates the specific already-connected error code 535, then queries the connected client PID with `GetNamedPipeClientProcessId`. It returns success only if that PID equals `expected_runner_pid`; otherwise it returns an `io::Error`, using `PermissionDenied` for PID mismatch.

**Call relations**: This function is invoked indirectly by `spawn_runner_transport` through `connect_pipe_with_timeout`, which wraps it in a helper thread and timeout/cancellation logic.

*Call graph*: 7 external calls (from_raw_os_error, new, format!, null_mut, GetLastError, ConnectNamedPipe, GetNamedPipeClientProcessId).


### Process launch and interactive I/O internals
These files handle the concrete Windows process creation details, desktop and startup attributes, ConPTY support, and stdio bridging for sandboxed sessions.

### `windows-sandbox-rs/src/process.rs`

`io_transport` · `process launch and output capture`

This file centers on launching a process under a supplied user token with Windows-specific startup configuration. `CreatedProcess` packages the returned `PROCESS_INFORMATION`, the startup info actually used, and the `LaunchDesktop` guard that keeps any private desktop alive for the child. `make_env_block` converts a `HashMap<String, String>` into the double-NUL-terminated UTF-16 environment block format required by `CreateProcessAsUserW`, sorting variables case-insensitively first to match Windows expectations.

`create_process_as_user` is the main unsafe entry point. It converts argv into a Windows command line, materializes the environment block, prepares desktop selection, and then branches on whether explicit stdio handles were supplied. In the explicit-stdio branch it builds `STARTUPINFOEXW`, marks the provided handles inheritable, constructs a `ProcThreadAttributeList`, installs the inherited handle list, and sets `EXTENDED_STARTUPINFO_PRESENT`. In the default-stdio branch it uses plain `STARTUPINFOW` and `ensure_inheritable_stdio` to inherit the current console handles. Both branches call `CreateProcessAsUserW`, log a detailed diagnostic message on failure, and return a simplified `anyhow!` error outward.

`spawn_process_with_pipes` layers anonymous pipe creation and cleanup around that primitive, carefully closing the parent or child ends depending on success, `StdinMode`, and `StderrMode`. `read_handle_loop` then provides asynchronous draining of a pipe handle until EOF, invoking a caller callback for each chunk and closing the handle in the reader thread.

#### Function details

##### `make_env_block`  (lines 39–56)

```
fn make_env_block(env: &HashMap<String, String>) -> Vec<u16>
```

**Purpose**: Converts an environment map into the UTF-16, double-NUL-terminated block format expected by Windows process creation APIs. It also sorts entries in a Windows-friendly order.

**Data flow**: Takes `&HashMap<String, String>`, clones entries into a vector of `(String, String)`, sorts by uppercase key then original key, formats each pair as `key=value`, converts each string with `to_wide`, removes the trailing NUL from each converted string, appends an entry terminator `0`, and finally appends a second trailing `0`. It returns the assembled `Vec<u16>` environment block.

**Call relations**: This helper is called before process creation in both standard and ConPTY-related launch paths. Its output is passed directly as the `lpEnvironment` buffer to `CreateProcessAsUserW`.

*Call graph*: calls 1 internal fn (to_wide); called by 2 (spawn_conpty_process_as_user, create_process_as_user); 2 external calls (new, format!).


##### `ensure_inheritable_stdio`  (lines 58–73)

```
fn ensure_inheritable_stdio(si: &mut STARTUPINFOW) -> Result<()>
```

**Purpose**: Marks the current process's standard handles inheritable and copies them into a `STARTUPINFOW` structure. It prepares the plain-startup path where no custom pipe handles are supplied.

**Data flow**: Takes `&mut STARTUPINFOW`, iterates over `STD_INPUT_HANDLE`, `STD_OUTPUT_HANDLE`, and `STD_ERROR_HANDLE`, fetches each with `GetStdHandle`, validates that it is neither null nor `INVALID_HANDLE_VALUE`, sets `HANDLE_FLAG_INHERIT` via `SetHandleInformation`, then sets `STARTF_USESTDHANDLES` and writes the three handles into `si`. It returns `Ok(())` or an `anyhow` error containing the failing Win32 error code.

**Call relations**: It is only used by `create_process_as_user` in the branch where the caller did not provide explicit stdio handles. That branch delegates stdio preparation here before invoking `CreateProcessAsUserW`.

*Call graph*: called by 1 (create_process_as_user); 3 external calls (anyhow!, SetHandleInformation, GetStdHandle).


##### `create_process_as_user`  (lines 78–199)

```
fn create_process_as_user(
    h_token: HANDLE,
    argv: &[String],
    cwd: &Path,
    env_map: &HashMap<String, String>,
    logs_base_dir: Option<&Path>,
    stdio: Option<(HANDLE, HANDLE, HANDLE)
```

**Purpose**: Launches a child process under a supplied primary token, with optional custom stdio handles and optional private-desktop routing. It is the core Windows spawn primitive for the sandbox.

**Data flow**: Inputs are the token handle, argv slice, cwd path, environment map, optional log directory, optional `(stdin, stdout, stderr)` handles, and a private-desktop flag. It builds a quoted command line with `argv_to_command_line`, converts strings and cwd to UTF-16 with `to_wide`, builds the environment block with `make_env_block`, prepares desktop state with `LaunchDesktop::prepare`, zero-initializes `PROCESS_INFORMATION`, then branches: with `stdio`, it fills `STARTUPINFOEXW`, marks the supplied handles inheritable, creates a `ProcThreadAttributeList`, installs the inherited handle list, and calls `CreateProcessAsUserW` with `EXTENDED_STARTUPINFO_PRESENT`; without `stdio`, it fills `STARTUPINFOW`, calls `ensure_inheritable_stdio`, and launches without extended startup info. On failure it reads `GetLastError`, formats a detailed debug message including cwd, command, env length, startup flags, and creation flags, writes that via `logging::debug_log`, and returns an `anyhow` error; on success it returns `CreatedProcess` containing the process info, startup info, and desktop guard.

**Call relations**: This function is invoked by `spawn_process_with_pipes` and by higher-level sandbox execution flows that already have token and environment state prepared. It delegates desktop setup, environment formatting, stdio inheritance, and optional attribute-list construction to helpers before making the final Win32 process creation call.

*Call graph*: calls 6 internal fn (prepare, debug_log, ensure_inheritable_stdio, make_env_block, argv_to_command_line, to_wide); called by 2 (spawn_process_with_pipes, run_windows_sandbox_capture_with_filesystem_overrides); 10 external calls (anyhow!, format!, zeroed, null, null_mut, new, vec!, GetLastError, SetHandleInformation, CreateProcessAsUserW).


##### `spawn_process_with_pipes`  (lines 227–326)

```
fn spawn_process_with_pipes(
    h_token: HANDLE,
    argv: &[String],
    cwd: &Path,
    env_map: &HashMap<String, String>,
    stdin_mode: StdinMode,
    stderr_mode: StderrMode,
    use_private_de
```

**Purpose**: Creates anonymous pipes for child stdio, launches the child with those handles, and returns the parent-side handles needed to feed stdin and read stdout/stderr. It encapsulates the handle choreography and cleanup rules around pipe-based spawning.

**Data flow**: Takes token, argv, cwd, env map, `StdinMode`, `StderrMode`, private-desktop flag, and optional log directory. It allocates stdin and stdout pipes unconditionally and a stderr pipe only when `StderrMode::Separate`, cleaning up already-created handles if any `CreatePipe` call fails. It chooses the child's stderr handle as either `out_w` or `err_w`, calls `create_process_as_user` with `(in_r, out_w, stderr_handle)`, closes all pipe handles on spawn failure, and on success closes the child-side ends in the parent (`in_r`, `out_w`, and maybe `err_w`), optionally closes `in_w` when stdin should be closed, and returns `PipeSpawnHandles` with the process info, optional writable stdin handle, stdout read handle, optional stderr read handle, and retained desktop guard.

**Call relations**: This is the higher-level convenience wrapper used by legacy process-spawn code that wants captured output. It delegates actual child creation to `create_process_as_user` after preparing inheritable pipe handles.

*Call graph*: calls 1 internal fn (create_process_as_user); called by 1 (spawn_legacy_process); 5 external calls (anyhow!, matches!, null_mut, CloseHandle, CreatePipe).


##### `read_handle_loop`  (lines 329–355)

```
fn read_handle_loop(handle: HANDLE, mut on_chunk: F) -> std::thread::JoinHandle<()>
```

**Purpose**: Starts a background thread that continuously reads bytes from a Windows handle until EOF or read failure, forwarding each chunk to a callback. It is the streaming side of pipe-based output capture.

**Data flow**: Takes a `HANDLE` and an `FnMut(&[u8])` callback. It spawns a thread, allocates an 8 KiB stack buffer, repeatedly calls `ReadFile` into that buffer, stops when `ReadFile` fails or returns zero bytes, invokes `on_chunk` with the valid slice for each successful read, and finally closes the handle with `CloseHandle`; the function returns the thread `JoinHandle<()>` immediately.

**Call relations**: This helper is called by output-reader orchestration after `spawn_process_with_pipes` returns readable pipe handles. It delegates all actual I/O to the spawned thread so the caller can continue coordinating process execution.

*Call graph*: called by 1 (spawn_output_reader); 1 external calls (spawn).


### `windows-sandbox-rs/src/desktop.rs`

`io_transport` · `process launch setup`

This file encapsulates the Windows desktop object setup used when a sandboxed process should run on an isolated desktop instead of the default interactive one. `LaunchDesktop` is the public wrapper: it either points startup info at `Winsta0\Default` or creates a `PrivateDesktop` and exposes the fully qualified desktop name as a mutable UTF-16 pointer suitable for Win32 process startup structures.

`PrivateDesktop::create` generates a random desktop name, converts it to UTF-16, and calls `CreateDesktopW` with a locally defined `DESKTOP_ALL_ACCESS` mask assembled from the individual desktop rights constants. On failure it logs the Win32 error and returns an `anyhow` error. On success it immediately calls `grant_desktop_access`; if ACL setup fails, it closes the desktop handle before propagating the error.

`grant_desktop_access` obtains the current token intended for restriction, extracts the logon SID bytes, closes the token handle, builds a single `EXPLICIT_ACCESS_W` trustee pointing at that SID, creates a DACL with `SetEntriesInAclW`, and applies it to the desktop object with `SetSecurityInfo`. It frees the ACL buffer with `LocalFree` regardless of `SetSecurityInfo` success. `PrivateDesktop` implements `Drop` to close the desktop handle, so `LaunchDesktop` keeps the desktop alive simply by owning the private desktop object for the duration of process startup and execution.

#### Function details

##### `LaunchDesktop::prepare`  (lines 63–77)

```
fn prepare(use_private_desktop: bool, logs_base_dir: Option<&Path>) -> Result<Self>
```

**Purpose**: Constructs the desktop-launch context for a child process, either targeting the default desktop or creating a new private desktop and startup name. It is the public entry for callers preparing Win32 startup info.

**Data flow**: It takes a `use_private_desktop` flag and optional log directory path. If the flag is true, it calls `PrivateDesktop::create`, formats `Winsta0\{name}`, converts that string with `to_wide`, and returns a `LaunchDesktop` holding the private desktop plus UTF-16 startup name; otherwise it returns a `LaunchDesktop` with no private desktop and a UTF-16 `Winsta0\Default` name.

**Call relations**: This function is invoked by both direct process creation and ConPTY-based launch paths when they need a desktop name for `STARTUPINFO`. It delegates actual desktop object creation and ACL setup to `PrivateDesktop::create` only when isolation is requested.

*Call graph*: calls 2 internal fn (create, to_wide); called by 2 (spawn_conpty_process_as_user, create_process_as_user); 1 external calls (format!).


##### `LaunchDesktop::startup_info_desktop`  (lines 79–81)

```
fn startup_info_desktop(&self) -> *mut u16
```

**Purpose**: Exposes the stored desktop name buffer as a mutable UTF-16 pointer for Win32 APIs. It is a thin adapter from Rust-owned storage to the raw pointer shape expected by startup structures.

**Data flow**: It reads `self.startup_name`, takes its internal pointer with `as_ptr`, casts it to `*mut u16`, and returns it. It does not allocate or mutate state.

**Call relations**: Callers use this after `LaunchDesktop::prepare` when filling process startup structures; it depends on the `LaunchDesktop` instance staying alive so the backing buffer remains valid.


##### `PrivateDesktop::create`  (lines 90–125)

```
fn create(logs_base_dir: Option<&Path>) -> Result<Self>
```

**Purpose**: Creates a uniquely named desktop object and grants the current logon SID full access to it. It wraps Win32 desktop creation with cleanup and debug logging on failure.

**Data flow**: It takes an optional log directory, seeds a `SmallRng`, generates a random `u128` suffix for the desktop name, converts the name to UTF-16, and calls `CreateDesktopW`. If the returned handle is zero it reads `GetLastError`, logs a formatted message, and returns an error; otherwise it calls `grant_desktop_access`, closes the desktop on ACL failure, and on success returns `PrivateDesktop { handle, name }`.

**Call relations**: This constructor is called only from `LaunchDesktop::prepare` when private-desktop mode is enabled. It delegates security descriptor modification to `grant_desktop_access` and relies on `Drop` for eventual handle cleanup.

*Call graph*: calls 3 internal fn (grant_desktop_access, debug_log, to_wide); called by 1 (prepare); 8 external calls (from_entropy, anyhow!, format!, null, null_mut, GetLastError, CloseDesktop, CreateDesktopW).


##### `grant_desktop_access`  (lines 128–186)

```
fn grant_desktop_access(handle: isize, logs_base_dir: Option<&Path>) -> Result<()>
```

**Purpose**: Builds and applies a DACL granting the current logon SID full access to the newly created desktop object. This makes the desktop usable by the intended sandboxed logon session.

**Data flow**: It accepts the desktop handle and optional log directory. It obtains a token via `get_current_token_for_restriction`, extracts mutable SID bytes with `get_logon_sid_bytes`, closes the token handle, constructs a one-entry `EXPLICIT_ACCESS_W` array whose trustee points at the SID buffer, calls `SetEntriesInAclW` to allocate an updated ACL, applies that ACL with `SetSecurityInfo`, frees the ACL buffer with `LocalFree` if non-null, and returns `Ok(())` or an `anyhow` error after logging failures.

**Call relations**: This unsafe helper is called by `PrivateDesktop::create` immediately after desktop creation. It is the security-setup phase that turns a raw desktop handle into one accessible by the sandbox principal.

*Call graph*: calls 3 internal fn (debug_log, get_current_token_for_restriction, get_logon_sid_bytes); called by 1 (create); 7 external calls (anyhow!, format!, null_mut, CloseHandle, LocalFree, SetEntriesInAclW, SetSecurityInfo).


##### `PrivateDesktop::drop`  (lines 189–195)

```
fn drop(&mut self)
```

**Purpose**: Closes the owned desktop handle when the private desktop object is dropped. It provides RAII cleanup for the Win32 desktop resource.

**Data flow**: It mutably borrows `self`, checks whether `self.handle` is nonzero, and calls `CloseDesktop` inside an unsafe block. It returns no value and ignores close errors.

**Call relations**: This destructor runs automatically when the `LaunchDesktop` owning the private desktop goes out of scope, ensuring desktop handles are not leaked on normal or error paths.

*Call graph*: 1 external calls (CloseDesktop).


### `windows-sandbox-rs/src/proc_thread_attr.rs`

`io_transport` · `process launch setup`

This file provides a single RAII-style wrapper, `ProcThreadAttributeList`, around the opaque Windows `LPPROC_THREAD_ATTRIBUTE_LIST` structure used with `STARTUPINFOEXW`. The wrapper owns the raw backing memory as a `Vec<u8>` because the Win32 API requires the caller to first query the required byte size, then allocate a buffer of exactly that size, then initialize the list in place. `new` performs that two-step initialization and converts Win32 failures into `io::Error` using `GetLastError`.

A subtle but important design choice is the `handle_list: Option<Vec<HANDLE>>` field. When `set_handle_list` installs `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, Windows stores a pointer to the caller-provided handle array rather than copying it immediately into Rust-owned storage. Keeping the vector inside the struct guarantees the pointed-to memory remains alive until process creation finishes and the attribute list is dropped. `set_pseudoconsole` similarly writes the pseudoconsole handle attribute using the constant attribute ID for `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`.

`as_mut_ptr` centralizes the cast from the byte buffer to `LPPROC_THREAD_ATTRIBUTE_LIST`, and `Drop` always calls `DeleteProcThreadAttributeList` on that pointer. The invariant is that any successfully constructed instance has an initialized attribute list in `buffer`, and any installed handle list must outlive the list itself.

#### Function details

##### `ProcThreadAttributeList::new`  (lines 19–41)

```
fn new(attr_count: u32) -> io::Result<Self>
```

**Purpose**: Allocates and initializes a Windows process/thread attribute list for a specified number of attributes. It performs the required Win32 size-probe call before creating the backing buffer.

**Data flow**: Takes `attr_count` as the number of attributes the caller intends to store. It first calls `InitializeProcThreadAttributeList` with a null pointer to obtain the required byte size, allocates `buffer: Vec<u8>` of that size, then calls the initializer again on the real buffer; on failure it reads `GetLastError` and returns `io::Error`, and on success returns `ProcThreadAttributeList { buffer, handle_list: None }`.

**Call relations**: This constructor is used by higher-level process spawning code before attaching extended startup attributes. After creation, callers typically populate the list through `set_handle_list` or `set_pseudoconsole`, and later pass `as_mut_ptr` into `STARTUPINFOEXW`.

*Call graph*: 5 external calls (from_raw_os_error, null_mut, vec!, GetLastError, InitializeProcThreadAttributeList).


##### `ProcThreadAttributeList::as_mut_ptr`  (lines 43–45)

```
fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST
```

**Purpose**: Exposes the internal byte buffer as the Win32 attribute-list pointer type expected by process creation APIs. It is the single cast point from Rust-owned storage to `LPPROC_THREAD_ATTRIBUTE_LIST`.

**Data flow**: Reads `self.buffer.as_mut_ptr()` and casts it to `LPPROC_THREAD_ATTRIBUTE_LIST`. It does not mutate logical state and returns the raw pointer for FFI calls.

**Call relations**: This helper is invoked internally whenever the wrapper needs to pass the list to Win32: both attribute update methods use it before calling `UpdateProcThreadAttribute`, and `drop` uses it before calling `DeleteProcThreadAttributeList`.

*Call graph*: called by 3 (drop, set_handle_list, set_pseudoconsole).


##### `ProcThreadAttributeList::set_pseudoconsole`  (lines 47–66)

```
fn set_pseudoconsole(&mut self, hpc: isize) -> io::Result<()>
```

**Purpose**: Adds the pseudoconsole handle attribute to an initialized attribute list so a child process can be attached to a ConPTY session. It writes the `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` entry using the supplied handle value.

**Data flow**: Takes `hpc: isize`, obtains the list pointer via `as_mut_ptr`, casts the handle to `*mut c_void`, and calls `UpdateProcThreadAttribute` with the pseudoconsole attribute ID and a payload size equal to `size_of::<HANDLE>()`. It returns `Ok(())` on success or an `io::Error` built from `GetLastError` on failure.

**Call relations**: This method is called by process-launch paths that need ConPTY integration. It delegates the actual attribute installation to `UpdateProcThreadAttribute` after obtaining the raw list pointer from `as_mut_ptr`.

*Call graph*: calls 1 internal fn (as_mut_ptr); 4 external calls (from_raw_os_error, null_mut, GetLastError, UpdateProcThreadAttribute).


##### `ProcThreadAttributeList::set_handle_list`  (lines 68–91)

```
fn set_handle_list(&mut self, handles: Vec<HANDLE>) -> io::Result<()>
```

**Purpose**: Installs the explicit inherited-handle list used by `CreateProcessAsUserW` with extended startup info. It also preserves the handle array inside the struct so the Win32 attribute continues to reference valid memory.

**Data flow**: Consumes `handles: Vec<HANDLE>`, stores it into `self.handle_list`, then borrows that stored vector mutably, obtains the attribute-list pointer via `as_mut_ptr`, and calls `UpdateProcThreadAttribute` with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, the vector's raw pointer, and the byte size of the slice. It returns `Ok(())` on success; if the internal option is unexpectedly empty it returns `io::Error::other`, and if Win32 rejects the update it returns an OS error from `GetLastError`.

**Call relations**: This is used by the process-spawning code path that passes custom stdio pipe handles to a child. It depends on `as_mut_ptr` for the list pointer and exists specifically to support the extended-startup branch in process creation.

*Call graph*: calls 1 internal fn (as_mut_ptr); 6 external calls (from_raw_os_error, other, size_of_val, null_mut, GetLastError, UpdateProcThreadAttribute).


##### `ProcThreadAttributeList::drop`  (lines 95–99)

```
fn drop(&mut self)
```

**Purpose**: Releases Win32-managed bookkeeping associated with an initialized attribute list when the Rust wrapper goes out of scope. It completes the RAII contract started by `new`.

**Data flow**: Reads the internal buffer pointer through `as_mut_ptr` and passes it to `DeleteProcThreadAttributeList`. It returns no value and writes no Rust-visible state, but frees native resources associated with the list.

**Call relations**: This destructor runs automatically after callers finish process creation and the wrapper leaves scope. It relies on `as_mut_ptr` to recover the native pointer and delegates cleanup to the Win32 API.

*Call graph*: calls 1 internal fn (as_mut_ptr); 1 external calls (DeleteProcThreadAttributeList).


### `windows-sandbox-rs/src/conpty/mod.rs`

`io_transport` · `sandbox process launch`

This module isolates the Windows pseudoconsole plumbing needed to launch sandboxed processes with a PTY. The central type, `ConptyInstance`, owns an optional `PsuedoCon`, the writable input pipe handle, the readable output pipe handle, and an optional `LaunchDesktop` that keeps any private desktop alive for the process lifetime. Its `Drop` implementation closes the raw pipe handles if they are valid and then drops the pseudoconsole object.

There are two usage levels. `create_conpty` is a lower-level constructor that creates a `RawConPty` with caller-specified dimensions and returns a `ConptyInstance` holding the extracted handles. `spawn_conpty_process_as_user` is the main high-level entrypoint: it quotes and joins `argv` into a Windows command line, builds a UTF-16 environment block from the provided map, initializes `STARTUPINFOEXW` with invalid stdio handles and an optional private desktop, creates a default 80x24 ConPTY, allocates a `ProcThreadAttributeList`, attaches the pseudoconsole handle through `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, and finally calls `CreateProcessAsUserW` with `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT`. On failure it reports the numeric Win32 error, formatted message, cwd, command line, and environment-block length, which is especially useful when debugging token or desktop issues. On success it returns both the `PROCESS_INFORMATION` and the still-owned `ConptyInstance` so the caller can hand off or extract the PTY pipe handles.

#### Function details

##### `ConptyInstance::drop`  (lines 43–53)

```
fn drop(&mut self)
```

**Purpose**: Closes the ConPTY backing pipe handles and drops the pseudoconsole when the instance is destroyed.

**Data flow**: It reads `input_write` and `output_read`, closes each with `CloseHandle` if nonzero and not `INVALID_HANDLE_VALUE`, then takes and drops the optional `PsuedoCon`. It returns no value.

**Call relations**: This destructor runs automatically after callers finish with a spawned PTY session or a standalone created ConPTY, preventing handle leaks.

*Call graph*: 1 external calls (CloseHandle).


##### `ConptyInstance::raw_handle`  (lines 57–61)

```
fn raw_handle(&self) -> Option<HANDLE>
```

**Purpose**: Returns the raw pseudoconsole handle if the instance still owns one.

**Data flow**: It reads the optional `pseudoconsole`, maps it through `raw_handle()`, casts that to `HANDLE`, and returns `Option<HANDLE>`.

**Call relations**: This accessor exposes the underlying pseudoconsole handle for callers that need to inspect or pass it onward without taking ownership.


##### `ConptyInstance::take_input_write`  (lines 63–65)

```
fn take_input_write(&mut self) -> HANDLE
```

**Purpose**: Transfers ownership of the PTY input pipe’s write handle out of the instance.

**Data flow**: It replaces `self.input_write` with `0` and returns the previous `HANDLE`.

**Call relations**: Callers use this when they want to manage the PTY input stream handle themselves after creation or spawn.

*Call graph*: 1 external calls (replace).


##### `ConptyInstance::take_output_read`  (lines 67–69)

```
fn take_output_read(&mut self) -> HANDLE
```

**Purpose**: Transfers ownership of the PTY output pipe’s read handle out of the instance.

**Data flow**: It replaces `self.output_read` with `0` and returns the previous `HANDLE`.

**Call relations**: Callers use this when they want to manage the PTY output stream handle themselves after creation or spawn.

*Call graph*: 1 external calls (replace).


##### `create_conpty`  (lines 77–87)

```
fn create_conpty(cols: i16, rows: i16) -> Result<ConptyInstance>
```

**Purpose**: Creates a standalone ConPTY with caller-specified dimensions and returns an owning wrapper around its handles.

**Data flow**: It takes terminal column and row counts, constructs a `RawConPty`, extracts the pseudoconsole and pipe handles with `into_handles`, converts the pipe handles into raw `HANDLE`s, stores them in a new `ConptyInstance`, and returns it.

**Call relations**: This lower-level constructor is available for callers that need a ConPTY without immediately spawning a process through the higher-level helper.

*Call graph*: calls 1 internal fn (new).


##### `spawn_conpty_process_as_user`  (lines 93–158)

```
fn spawn_conpty_process_as_user(
    h_token: HANDLE,
    argv: &[String],
    cwd: &Path,
    env_map: &HashMap<String, String>,
    use_private_desktop: bool,
    logs_base_dir: Option<&Path>,
) ->
```

**Purpose**: Launches a process under a supplied user token with a ConPTY attached and optional private desktop isolation.

**Data flow**: It takes a user token handle, argument vector, working directory, environment map, desktop-isolation flag, and optional logs directory. It quotes and joins the arguments into a command line, converts it and the cwd to UTF-16, builds an environment block, prepares `STARTUPINFOEXW`, prepares a `LaunchDesktop`, creates a default `RawConPty`, wraps it in `ConptyInstance`, allocates and populates a `ProcThreadAttributeList` with the pseudoconsole handle, calls `CreateProcessAsUserW`, and returns `(PROCESS_INFORMATION, ConptyInstance)` on success or a detailed `anyhow!` error on failure.

**Call relations**: This is the main shared PTY spawn path and is called by `spawn_legacy_process` when a sandboxed command needs terminal semantics.

*Call graph*: calls 4 internal fn (new, prepare, make_env_block, to_wide); called by 1 (spawn_legacy_process); 7 external calls (anyhow!, zeroed, null, null_mut, new, GetLastError, CreateProcessAsUserW).


### `utils/pty/src/win/procthreadattr.rs`

`generated` · `Windows process creation setup`

This small vendored helper encapsulates the awkward Win32 `PROC_THREAD_ATTRIBUTE_LIST` lifecycle behind a safe-ish Rust struct. The underlying storage is just a `Vec<u8>`, but `with_capacity` follows the required two-call Win32 pattern: first call `InitializeProcThreadAttributeList` with a null pointer to discover the required byte count, then allocate a buffer of exactly that size, and finally call the initializer again with the real pointer. Failures are converted into `anyhow::Error` via `ensure!` and `IoError::last_os_error()`.

Once allocated, `as_mut_ptr` exposes the buffer as an `LPPROC_THREAD_ATTRIBUTE_LIST` for Win32 APIs. `set_pty` uses `UpdateProcThreadAttribute` to install the `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` attribute, passing the `HPCON` pseudoconsole handle and its size. This is the key step that causes a subsequently created process to attach to the ConPTY instance.

The struct owns cleanup as well: `Drop` always calls `DeleteProcThreadAttributeList` on the current pointer. The design keeps all pointer casting and manual buffer sizing localized to one file, so the rest of the Windows spawn code can treat pseudoconsole attribute setup as a normal Rust object rather than a sequence of raw Win32 calls.

#### Function details

##### `ProcThreadAttributeList::with_capacity`  (lines 37–60)

```
fn with_capacity(num_attributes: DWORD) -> Result<Self, Error>
```

**Purpose**: Allocates and initializes a process-thread attribute list capable of holding a specified number of attributes. It performs the standard Win32 size-discovery call before allocating the backing buffer.

**Data flow**: Takes `num_attributes: DWORD`, calls `InitializeProcThreadAttributeList(null_mut(), ...)` to fill `bytes_required`, allocates a `Vec<u8>` with that capacity and unsafely sets its length, casts the buffer pointer to `LPPROC_THREAD_ATTRIBUTE_LIST`, calls `InitializeProcThreadAttributeList` again on the real buffer, and returns `Ok(Self { data })` or an `anyhow::Error` if initialization failed.

**Call relations**: This constructor is called by Windows pseudoconsole spawn code before setting attributes such as the attached PTY handle.

*Call graph*: called by 1 (spawn_command); 3 external calls (with_capacity, ensure!, null_mut).


##### `ProcThreadAttributeList::as_mut_ptr`  (lines 62–64)

```
fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST
```

**Purpose**: Returns the backing buffer as a mutable Win32 attribute-list pointer. It is the low-level accessor used by both mutation and cleanup code.

**Data flow**: Borrows `&mut self`, casts `self.data.as_mut_slice().as_mut_ptr()` to `LPPROC_THREAD_ATTRIBUTE_LIST`, and returns that pointer.

**Call relations**: This helper is used internally by `set_pty` and `Drop` so pointer conversion logic is not duplicated.

*Call graph*: called by 2 (drop, set_pty).


##### `ProcThreadAttributeList::set_pty`  (lines 66–84)

```
fn set_pty(&mut self, con: HPCON) -> Result<(), Error>
```

**Purpose**: Associates a pseudoconsole handle with the attribute list so a subsequently created process will attach to that ConPTY. It writes the `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` attribute.

**Data flow**: Takes `con: HPCON`, obtains the attribute-list pointer via `as_mut_ptr()`, calls `UpdateProcThreadAttribute` with the pseudoconsole attribute constant, the handle value, and `mem::size_of::<HPCON>()`, and returns `Ok(())` or an `anyhow::Error` built from `last_os_error()` if the update fails.

**Call relations**: Windows spawn code calls this after `with_capacity` and before process creation to bind the child to a ConPTY session.

*Call graph*: calls 1 internal fn (as_mut_ptr); 2 external calls (ensure!, null_mut).


##### `ProcThreadAttributeList::drop`  (lines 88–90)

```
fn drop(&mut self)
```

**Purpose**: Releases the Win32 attribute-list resources when the wrapper is dropped. It ensures the corresponding `DeleteProcThreadAttributeList` cleanup always runs.

**Data flow**: Borrows `&mut self`, obtains the raw pointer with `as_mut_ptr()`, passes it to `DeleteProcThreadAttributeList`, and returns `()`.

**Call relations**: Rust invokes this automatically when the attribute-list wrapper goes out of scope, completing the lifecycle started by `with_capacity`.

*Call graph*: calls 1 internal fn (as_mut_ptr).


### `windows-sandbox-rs/src/stdio_bridge.rs`

`io_transport` · `interactive session I/O forwarding and shutdown drain`

This file is the outer stdio adapter used when a sandbox session should behave like a normal child process attached to the caller's console. The main async entrypoint, `forward_sandbox_session_stdio`, takes a `codex_utils_pty::SpawnedProcess`, wraps its `session` in an `Arc`, and starts three background forwarding threads: one reads from this process's `stdin` and pushes byte chunks into the session's writer channel, while two others consume the session's `stdout_rx` and `stderr_rx` Tokio channels and write those chunks to `std::io::stdout()` and `std::io::stderr()`.

A oneshot channel is used to detect local stdin EOF. When the input thread finishes, an async task calls `session.close_stdin()` so the sandboxed child sees end-of-input. Exit handling races the child exit receiver against `tokio::signal::ctrl_c()`: on Ctrl-C, the code requests sandbox termination and then still waits for the real exit code, defaulting to `-1` if the channel closes unexpectedly. After exit, it aborts the stdin-close helper task and waits up to five seconds for stdout/stderr forwarders to drain remaining tail output, intentionally avoiding indefinite hangs from rare EOF issues. The helper threads are detached by dropping their `JoinHandle`s immediately; they continue running independently.

#### Function details

##### `forward_sandbox_session_stdio`  (lines 12–64)

```
async fn forward_sandbox_session_stdio(spawned: SpawnedProcess) -> i32
```

**Purpose**: Connects the caller's console streams to a sandbox session and waits for the session to finish. It also translates local EOF and Ctrl-C into sandbox-side stdin closure and termination requests.

**Data flow**: Consumes a `SpawnedProcess`, extracting its `session`, `stdout_rx`, `stderr_rx`, and `exit_rx`. It creates a oneshot pair for stdin EOF notification, spawns one input-forwarding thread and two output-forwarding threads, then spawns an async task that waits for stdin EOF and calls `session.close_stdin()`. It selects between the process exit receiver and `tokio::signal::ctrl_c()`, possibly calling `session.request_terminate()`, then waits briefly for output drain and returns the final `i32` exit code, using `-1` if the exit channel yields no code.

**Call relations**: This is the file's top-level API. It drives both helper spawners unconditionally when a sandbox session is being attached to stdio, and its control flow is centered on coordinating their lifetime with the session exit path.

*Call graph*: calls 2 internal fn (spawn_input_forwarder, spawn_output_forwarder); 11 external calls (clone, new, from_secs, channel, stderr, stdin, stdout, current, select!, spawn (+1 more)).


##### `spawn_input_forwarder`  (lines 66–94)

```
fn spawn_input_forwarder(
    mut input: R,
    writer_tx: mpsc::Sender<Vec<u8>>,
    stdin_eof_tx: oneshot::Sender<()>,
) -> std::thread::JoinHandle<()>
```

**Purpose**: Starts a blocking thread that reads bytes from a `Read` source and forwards them into the sandbox session's stdin channel. It reports EOF exactly once through a oneshot sender when the loop ends.

**Data flow**: Takes a generic `R: Read + Send + 'static`, an `mpsc::Sender<Vec<u8>>`, and a `oneshot::Sender<()>`. Inside the thread it repeatedly reads up to 8 KiB into a fixed buffer, clones the read slice into a `Vec<u8>`, and sends it with `blocking_send`. It retries interrupted reads, logs other I/O errors to stderr, stops on EOF or channel closure, then sends the EOF notification and returns via thread completion.

**Call relations**: It is invoked only by `forward_sandbox_session_stdio` to watch the parent process's stdin. Its sole downstream effect is feeding the session writer channel and triggering the async stdin-close task once input ends.

*Call graph*: called by 1 (forward_sandbox_session_stdio); 1 external calls (spawn).


##### `spawn_output_forwarder`  (lines 96–122)

```
fn spawn_output_forwarder(
    tokio_runtime: tokio::runtime::Handle,
    output_rx: mpsc::Receiver<Vec<u8>>,
    mut writer: W,
) -> (std::thread::JoinHandle<()>, oneshot::Receiver<()>)
```

**Purpose**: Starts a blocking thread that drains a Tokio `mpsc::Receiver<Vec<u8>>` and writes each chunk to a blocking `Write` sink. It also exposes a oneshot completion signal so callers can wait for output draining.

**Data flow**: Accepts a Tokio runtime `Handle`, an `mpsc::Receiver<Vec<u8>>`, and a generic `W: Write + Send + 'static`. The thread uses `tokio_runtime.block_on(output_rx.recv())` to synchronously receive chunks, writes each chunk with `write_all`, flushes after every chunk, logs write/flush failures to stderr, and sends `()` on a oneshot sender when the receive loop ends or breaks. It returns both the thread `JoinHandle` and the completion receiver.

**Call relations**: It is called twice by `forward_sandbox_session_stdio`, once for stdout and once for stderr. The returned completion receivers are used during post-exit draining so the wrapper can give buffered output a chance to reach the console.

*Call graph*: called by 1 (forward_sandbox_session_stdio); 2 external calls (channel, spawn).
