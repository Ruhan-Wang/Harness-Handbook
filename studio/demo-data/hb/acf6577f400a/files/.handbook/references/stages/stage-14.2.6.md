# Windows sandbox provisioning and process-launch internals  `stage-14.2.6`

This stage is the Windows-only machinery that prepares a safe “guest room” for commands and then starts them inside it. The public entry points choose the right sandbox path: the newer elevated runner or the older legacy runner, while the TUI asks for the requested sandbox level. Setup code creates or refreshes sandbox Windows users, stores and checks their identity, reports setup errors, hides those users from normal Windows screens, and fixes access to bundled runtime tools. Permission code edits Windows access-control lists, which are file permission rules, to allow workspace writes, deny reads to sensitive paths, and reduce risky “Everyone can write” folders. Token and desktop code decide what powers and screen environment the child process gets. Firewall and WFP rule code block or narrow network access. Spawn preparation turns the requested read, write, and network policy into these concrete Windows settings. Process-launch code then creates the command with the right user, environment, pipes, and optional ConPTY fake terminal. The elevated runner uses locked-down named pipes to talk to its child, and the stdio bridge connects the sandboxed program back to the user’s terminal until it exits.

## Files in this stage

### Public execution entrypoints
These files define the crate-facing and TUI-facing entrypoints that choose a sandbox execution mode and expose the common API surface.

### `windows-sandbox-rs/src/lib.rs`

`orchestration` · `cross-cutting; active when sandbox setup or sandboxed command execution is requested`

This file is like the reception desk for the Windows sandbox crate. Most of the real work lives in smaller modules, but this file decides which modules exist on Windows, re-exports the pieces other crates are allowed to use, and supplies the main capture functions. Without it, callers would have to know the crate’s internal layout, and non-Windows builds would fail instead of giving a controlled “not available” error.

The file also defines a small cancellation token. That token is a shared callback: when long-running sandbox work is waiting for a child process, it can ask, “has someone requested that I stop?” This keeps cancellation separate from the sandbox code itself.

On Windows, the `windows_impl` section prepares and runs a command in a restricted environment. It checks the permission profile, prepares security rules, creates pipes for standard input, output, and error, starts the process with a restricted Windows token, waits for it to finish, and collects its output. If the command times out or is cancelled, it terminates the process. It also logs success or failure.

On other operating systems, the `stub` section keeps the API shape the same but returns an error saying the Windows sandbox only works on Windows.

#### Function details

##### `WindowsSandboxCancellationToken::new`  (lines 19–23)

```
fn new(is_cancelled: impl Fn() -> bool + Send + Sync + 'static) -> Self
```

**Purpose**: Creates a cancellation token from a caller-provided yes/no function. Code that is waiting on sandbox work can later call the token to find out whether it should stop early.

**Data flow**: It receives a function that returns `true` when cancellation has been requested. It stores that function inside shared reference-counted storage, so cloned tokens all ask the same question. It returns a new `WindowsSandboxCancellationToken` ready to pass into sandbox capture code.

**Call relations**: This constructor is used by cancellation-focused tests such as `legacy_capture_cancellation_is_not_reported_as_timeout`. In normal flow, the token it creates is passed down to the process-waiting code so the wait can end because of cancellation rather than only because the process exits or times out.

*Call graph*: called by 1 (legacy_capture_cancellation_is_not_reported_as_timeout); 1 external calls (new).


##### `WindowsSandboxCancellationToken::is_cancelled`  (lines 26–28)

```
fn is_cancelled(&self) -> bool
```

**Purpose**: Asks the token whether someone has requested cancellation. This gives long-running sandbox code a simple way to stop politely.

**Data flow**: It reads the stored cancellation callback, calls it, and returns the boolean answer. It does not change the token or the outside world.

**Call relations**: The waiting path uses this kind of check while a sandboxed process is running. That lets the larger capture flow distinguish a user-requested stop from a normal timeout.


##### `WindowsSandboxCancellationToken::fmt`  (lines 32–35)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides a safe debug display for the cancellation token. It identifies the token type without trying to print the hidden callback inside it.

**Data flow**: It receives a Rust debug formatter and writes a non-exhaustive debug structure name into it. The stored cancellation function is deliberately not shown.

**Call relations**: Rust’s debug-printing machinery calls this when someone formats the token with `{:?}`. It uses the formatter’s `debug_struct` helper so logs and test failures can mention the token without exposing implementation details.

*Call graph*: 1 external calls (debug_struct).


##### `windows_impl::wait_for_process`  (lines 379–415)

```
fn wait_for_process(
        process: HANDLE,
        timeout_ms: Option<u64>,
        cancellation: Option<&WindowsSandboxCancellationToken>,
    ) -> WaitOutcome
```

**Purpose**: Waits for a Windows process to finish, while also respecting an optional timeout and optional cancellation token. It turns several possible waiting outcomes into a simple result: exited, timed out, or cancelled.

**Data flow**: It receives a Windows process handle, an optional timeout in milliseconds, and an optional cancellation token. If there is no cancellation token, it performs one Windows wait call for either the timeout or forever. If cancellation is available, it waits in short slices, checking cancellation between waits and stopping when the deadline passes. It returns a `WaitOutcome` telling the caller what happened.

**Call relations**: The main capture routine calls this after starting the sandboxed process. Its answer decides whether the capture flow reads the real exit code or terminates the process because it ran too long or was cancelled.

*Call graph*: 3 external calls (from_millis, now, WaitForSingleObject).


##### `windows_impl::setup_stdio_pipes`  (lines 417–443)

```
fn setup_stdio_pipes() -> io::Result<PipeHandles>
```

**Purpose**: Creates the three communication pipes used to connect the parent program to the sandboxed child process: standard input, standard output, and standard error. A pipe is like a one-way tube for bytes.

**Data flow**: It asks Windows to create three pipe pairs. It marks the pipe ends that the child process must inherit, meaning the child can use them after it starts. If any Windows call fails, it converts the Windows error into a normal Rust I/O error. On success, it returns all six pipe handles.

**Call relations**: The capture flow calls this just before launching the sandboxed process. The returned handles are split between parent and child so the parent can collect output while the child runs with its usual input/output streams connected.

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

**Purpose**: Runs a command through the Windows sandbox capture path using the normal filesystem rules. This is the simpler public entry point for callers that do not need extra read/write deny overrides.

**Data flow**: It receives a permission profile, workspace roots, Codex home path, command, working directory, environment variables, optional timeout, optional cancellation token, and desktop choice. It forwards all of that to the more general capture function with empty extra deny-read and deny-write lists. It returns the captured exit code, output, error output, and timeout flag.

**Call relations**: Callers use this when they want the standard sandbox behavior. Internally, it hands off immediately to `windows_impl::run_windows_sandbox_capture_with_filesystem_overrides`, which contains the full preparation, launch, wait, and collection flow.

*Call graph*: 1 external calls (run_windows_sandbox_capture_with_filesystem_overrides).


##### `windows_impl::run_windows_sandbox_capture_with_filesystem_overrides`  (lines 480–678)

```
fn run_windows_sandbox_capture_with_filesystem_overrides(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
        codex_home: &Path,
        command: Vec<S
```

**Purpose**: Runs a command in the legacy Windows sandbox backend and captures its result. It is the main worker in this file: it prepares permissions, launches the restricted process, waits for it, gathers output, and records success or failure.

**Data flow**: It receives the requested permissions, workspace roots, Codex home, command, working directory, environment map, timeout, cancellation token, extra paths to deny reading or writing, and whether to use a private desktop. It converts override paths, prepares the spawn context, rejects permission combinations this legacy backend cannot enforce, computes capability roots, prepares Windows security tokens and access rules, creates standard I/O pipes, launches the process, and starts reader threads for stdout and stderr. Then it waits. If the process exits, it reads the exit code; if it times out or is cancelled, it terminates the process. Finally it closes Windows handles, gathers captured bytes, logs success or failure, and returns a `CaptureResult`.

**Call relations**: This function is reached either directly by callers needing filesystem overrides or indirectly through `windows_impl::run_windows_sandbox_capture`. It relies on preparation helpers such as `prepare_legacy_spawn_context`, `prepare_legacy_session_security`, `legacy_session_capability_roots`, `allow_null_device_for_workspace_write`, and `apply_legacy_session_acl_rules`, then hands process creation to `create_process_as_user`. After the process finishes, it reports through `log_success` or `log_failure`.

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

**Purpose**: Performs the filesystem permission setup needed before using the legacy sandbox path, without actually running a command. This is a preparation check for cases where write-capability access rules must already be in place.

**Data flow**: It receives a permission profile, workspace roots, Codex home path, current working directory, and environment map. It first tries to resolve the profile into Windows sandbox permissions; unsupported profiles are treated as needing no preflight. If the current directory does not require write capabilities, it also exits successfully. Otherwise it ensures Codex home exists, computes the relevant capability roots and security identifiers, applies the needed access-control rules, and returns success or an error.

**Call relations**: Setup or launch code can call this before legacy sandbox execution. It uses permission resolution to decide whether work is needed, then calls helpers such as `ensure_codex_home_exists`, `legacy_session_capability_roots`, `root_capability_sids`, and `apply_legacy_session_acl_rules` to prepare the filesystem.

*Call graph*: calls 5 internal fn (try_from_permission_profile_for_workspace_roots, ensure_codex_home_exists, apply_legacy_session_acl_rules, legacy_session_capability_roots, root_capability_sids); 1 external calls (to_path_buf).


##### `windows_impl::tests::workspace_profile`  (lines 727–734)

```
fn workspace_profile(network_policy: NetworkSandboxPolicy) -> PermissionProfile
```

**Purpose**: Builds a test permission profile that allows workspace writes while varying the network policy. It keeps several tests from repeating the same setup code.

**Data flow**: It receives a test network policy, passes it into the project’s workspace-write permission profile constructor, and returns the resulting `PermissionProfile`.

**Call relations**: The network-blocking tests call this helper to create profiles with either restricted or enabled network access. It delegates profile construction to `workspace_write_with` so the tests use the same profile-building path as production code.

*Call graph*: calls 1 internal fn (workspace_write_with).


##### `windows_impl::tests::should_apply_network_block`  (lines 736–743)

```
fn should_apply_network_block(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Answers, for a test permission profile, whether Windows sandbox permissions would apply a network block. It turns the permission-resolution step into a simple boolean check for tests.

**Data flow**: It receives a permission profile, resolves it into Windows-specific sandbox permissions using an empty workspace-root list, and asks the resolved permissions whether the network block should be applied. It returns that yes/no answer.

**Call relations**: The network policy tests use this helper before making assertions. It exercises the same permission-resolution function used by sandbox preparation, so the tests check behavior close to the real flow.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots).


##### `windows_impl::tests::applies_network_block_when_access_is_disabled`  (lines 746–750)

```
fn applies_network_block_when_access_is_disabled()
```

**Purpose**: Checks that a workspace-write profile with restricted network access causes the Windows sandbox to block the network.

**Data flow**: It creates a workspace-write profile whose network policy is restricted, asks whether a network block should be applied, and asserts that the answer is true.

**Call relations**: This test protects the intended behavior of permission resolution. If the sandbox ever stopped blocking network access for a restricted workspace profile, this test would fail.

*Call graph*: 1 external calls (assert!).


##### `windows_impl::tests::skips_network_block_when_access_is_allowed`  (lines 753–757)

```
fn skips_network_block_when_access_is_allowed()
```

**Purpose**: Checks that a workspace-write profile with enabled network access does not ask the Windows sandbox to block the network.

**Data flow**: It creates a workspace-write profile whose network policy is enabled, asks whether a network block should be applied, and asserts that the answer is false.

**Call relations**: This test complements the restricted-network test. Together they make sure the network policy switch is honored in both directions.

*Call graph*: 1 external calls (assert!).


##### `windows_impl::tests::applies_network_block_for_read_only`  (lines 760–762)

```
fn applies_network_block_for_read_only()
```

**Purpose**: Checks that read-only sandbox profiles apply the Windows network block. This confirms that read-only mode remains conservative about outside access.

**Data flow**: It creates a read-only permission profile, checks whether the resolved Windows sandbox permissions would block the network, and asserts that they would.

**Call relations**: This test uses the same helper as the workspace network tests. It makes sure read-only permission handling continues to feed into the network-blocking decision correctly.

*Call graph*: 1 external calls (assert!).


##### `windows_impl::tests::legacy_preflight_skips_profiles_without_managed_filesystem_permissions`  (lines 765–781)

```
fn legacy_preflight_skips_profiles_without_managed_filesystem_permissions()
```

**Purpose**: Checks that legacy preflight does nothing, successfully, for permission profiles that the Windows sandbox does not manage as filesystem-restricted profiles.

**Data flow**: It loops over unsupported or externally managed permission profiles, passes each into `run_windows_sandbox_legacy_preflight` with empty roots, simple placeholder paths, and an empty environment, and expects success. The important result is that no unnecessary ACL setup error is produced.

**Call relations**: This test calls the legacy preflight function directly. It protects the early-return behavior where unsupported profiles are not treated as failures, because they do not need this legacy filesystem preparation.

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

**Purpose**: Provides the same capture function on non-Windows builds, but always reports that the feature is unavailable. This lets the crate compile on other operating systems without pretending the sandbox can run there.

**Data flow**: It receives the same inputs as the Windows capture function but ignores them. It immediately returns an error saying the Windows sandbox is only available on Windows.

**Call relations**: On non-Windows targets, the public `run_windows_sandbox_capture` export points here instead of to the real Windows implementation. Callers get a clear runtime error rather than missing symbols or platform-specific compile failures.

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

**Purpose**: Provides the legacy preflight function on non-Windows builds, but always reports that the feature is unavailable.

**Data flow**: It receives the same setup inputs as the Windows preflight function but does not inspect them. It immediately returns an error saying the Windows sandbox is only available on Windows.

**Call relations**: On non-Windows targets, the public legacy preflight export points here. This preserves the library API across platforms while making the platform limitation explicit when someone tries to use it.

*Call graph*: 1 external calls (bail!).


### `windows-sandbox-rs/src/unified_exec/mod.rs`

`orchestration` · `process launch / request handling`

This module is a thin routing layer for Windows sandbox launches. A sandbox is a controlled place to run a command, with limits on what files it can read or write and how it can interact with the system. Without this file, callers would need to know whether to use the older restricted-token path or the newer elevated helper path, and they would have to pass the same long set of settings to the right backend themselves.

The main idea is simple: collect every detail needed to launch the session in one request, then pick the correct backend. The request includes the command to run, the working folder, environment variables, workspace folders, permission rules, timeout, terminal settings, and extra read/write allow or deny lists.

There are two launch styles. The legacy style starts the process directly with Windows restrictions. The elevated style goes through an elevated command runner, which is also used when proxy enforcement is required. This file does not implement those Windows mechanics itself. Instead, it acts like a reception desk: it reads the request, decides which specialist should handle it, and forwards the exact information to that backend. The result is always the same kind of object, a `SpawnedProcess`, so higher-level code can treat both launch paths uniformly.

#### Function details

##### `spawn_windows_sandbox_session_for_level`  (lines 45–87)

```
async fn spawn_windows_sandbox_session_for_level(
    request: WindowsSandboxSessionRequest<'_>,
) -> Result<SpawnedProcess>
```

**Purpose**: Chooses the right Windows sandbox launch path for a fully prepared request. It sends the command to the elevated backend when elevation or proxy enforcement is needed, otherwise it uses the legacy backend.

**Data flow**: It receives a `WindowsSandboxSessionRequest`, which already contains the command, folders, permissions, environment variables, terminal choices, and sandbox level. It checks whether proxy enforcement is on or the requested sandbox level is elevated. Based on that choice, it passes the request fields to the matching spawn function and returns the spawned process or an error.

**Call relations**: This is the main entry point in this file for callers that do not want to choose a backend themselves. During launch, it calls the elevated wrapper when the request needs the elevated runner, or the legacy wrapper when the simpler restricted-token path is enough.

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

**Purpose**: Starts a Windows sandbox session through the legacy backend. This path is for cases where the process can be launched directly with the older Windows restriction approach.

**Data flow**: It receives the permission profile, workspace roots, Codex home path, command, current folder, environment map, timeout, extra deny lists, and terminal/stdin/private-desktop settings. It does not change those settings itself; it forwards them to the legacy backend and returns whatever spawned process or error that backend produces.

**Call relations**: This function is called by `spawn_windows_sandbox_session_for_level` when the request does not require the elevated path. It is a stable public wrapper around the backend-specific legacy implementation, keeping callers insulated from the backend module layout.

*Call graph*: calls 1 internal fn (spawn_windows_sandbox_session_legacy); called by 1 (spawn_windows_sandbox_session_for_level).


##### `spawn_windows_sandbox_session_elevated_for_permission_profile`  (lines 122–159)

```
async fn spawn_windows_sandbox_session_elevated_for_permission_profile(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    codex_home: &Path,
    command: Vec<Str
```

**Purpose**: Starts a Windows sandbox session through the elevated backend. This path is used when the sandbox level asks for elevation or when proxy rules must be enforced.

**Data flow**: It receives the command, permission profile, workspace and Codex paths, environment variables, proxy flag, timeout, optional read/write root overrides, deny lists, and terminal settings. It passes those values to the elevated backend, which performs the actual elevated runner setup, then returns the resulting spawned process or error.

**Call relations**: This function is called by `spawn_windows_sandbox_session_for_level` when the request needs the elevated command-runner path. Like the legacy wrapper, it hides the backend-specific details and gives the rest of the code one consistent way to receive a `SpawnedProcess`.

*Call graph*: calls 1 internal fn (spawn_windows_sandbox_session_elevated_for_permission_profile); called by 1 (spawn_windows_sandbox_session_for_level).


### `windows-sandbox-rs/src/unified_exec/backends/elevated.rs`

`orchestration` · `process spawn and request handling`

This file is the bridge between “we want to run this command safely” and “there is now a live sandboxed process we can talk to.” It is used for the elevated Windows sandbox path, where the program needs special sandbox login credentials and prepared Windows permissions before launching the runner process.

The main flow first translates a user-facing permission profile into concrete Windows sandbox rules. It then prepares an elevated launch context: where the sandbox home directory is, what credentials to use, what environment variables the command should see, and what files or folders should be readable or writable. After that it builds a spawn request, which is a detailed instruction packet for the sandbox runner.

Starting the runner includes a handshake over pipes, meaning the parent process and runner agree on how they will exchange framed messages. If that handshake fails because the sandbox credentials are stale, the file refreshes the credentials and tries once more. This matters because Windows logon credentials can expire or become invalid while the rest of the application is still running.

Once the runner is alive, the file wires up the communication channels: input goes to the runner, output and errors come back, exit status is reported once, and a terminate message can be sent later. If the session uses a terminal, it also installs a resizer so terminal size changes can be forwarded.

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

**Purpose**: This helper starts the sandbox runner transport without blocking the async runtime. In plain terms, it moves a slow, Windows-specific startup handshake onto a worker thread so other async tasks can keep running.

**Data flow**: It receives the real Codex home path, the working directory, sandbox credentials, an optional log directory, and a spawn request. It passes those into the lower-level runner transport startup code on a blocking worker thread. If the worker succeeds, it returns a live RunnerTransport; if the worker task itself fails, it turns that into a clear error saying the runner handshake task failed.

**Call relations**: The main elevated spawn function calls this when it is ready to contact the sandbox runner. This helper hands off to the lower-level transport creation code, then gives the finished communication transport back to the main flow so input, output, and termination wiring can be built around it.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 1 external calls (spawn_blocking).


##### `spawn_windows_sandbox_session_elevated_for_permission_profile`  (lines 51–196)

```
async fn spawn_windows_sandbox_session_elevated_for_permission_profile(
    permission_profile: &PermissionProfile,
    workspace_roots: &[AbsolutePathBuf],
    codex_home: &Path,
    command: Vec<Str
```

**Purpose**: This is the main routine for launching an elevated Windows sandbox session from a permission profile. It prepares permissions and credentials, starts the sandbox runner, and returns a SpawnedProcess object that the caller can interact with like a normal running process.

**Data flow**: It starts with human-level launch inputs: the permission profile, workspace roots, command, working directory, environment variables, sandbox overrides, terminal settings, and timeout. It converts the permission profile into concrete Windows sandbox permissions, prepares an elevated launch context, and builds a spawn request for the runner. It then opens the runner transport, retrying once with refreshed credentials if the old credentials are detected as stale. After the transport is open, it splits the connection into read and write sides, creates channels for stdin, stdout, stderr, exit status, termination, and optional terminal resizing, and returns a SpawnedProcess connected to all of those pieces.

**Call relations**: This function is the central story for this backend. It calls the permission resolver first, then the elevated spawn preparation code, then the transport helper that performs the runner handshake. If credentials are stale, it calls the credential refresh path before trying the transport again. After startup, it delegates pipe writing, stdin forwarding, stdout and stderr reading, terminal resizing, and final process-driver packaging to the shared Windows backend helpers. The supplied call graph records this function as the caller context for the elevated session flow.

*Call graph*: calls 10 internal fn (is_stale_sandbox_creds_error, refresh_logon_sandbox_creds, try_from_permission_profile_for_workspace_roots, prepare_elevated_spawn_context_for_permissions, spawn_runner_transport_task, finish_driver_spawn, make_runner_resizer, start_runner_pipe_writer, start_runner_stdin_writer, start_runner_stdout_reader); called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 6 external calls (new, clone, to_path_buf, clone, iter, to_vec).


### `windows-sandbox-rs/src/unified_exec/backends/legacy.rs`

`orchestration` · `process launch through process teardown`

This file is the “old route” for running a command inside the Windows sandbox. Its job is to take a requested command, prepare a safer Windows security setup for it, start it, stream its input and output, and report when it exits. Without this file, the legacy backend would not be able to run commands at all.

The file supports two styles of process. If the command needs a terminal, it uses ConPTY, Windows’ pseudo-terminal feature, which makes a program think it is talking to a real console. If not, it uses ordinary pipes for standard input, standard output, and standard error. In both cases, the code creates background workers: one side reads bytes coming out of the process and broadcasts them to listeners, while another side writes bytes sent by the caller into the process.

Before the process starts, the main function prepares legacy access-control rules. These are Windows permission rules that try to limit where the process can write. This backend cannot enforce every modern restriction, so it refuses requests that need restricted read access or deny-read overrides.

After launch, another thread waits for the process to finish or times it out and kills it. It then closes Windows handles, releases the terminal owner, joins output-reader threads, sends the exit code, and writes a success or failure log. Think of it as a launch supervisor: it opens the room, connects the microphones, watches the clock, and locks the room afterward.

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

**Purpose**: Starts the actual Windows child process for the legacy backend. It chooses between a terminal-style launch using ConPTY and a pipe-style launch for ordinary non-terminal commands.

**Data flow**: It receives a Windows user token, the command, working directory, environment variables, desktop choice, terminal mode, input/output channels, and optional log location. If terminal mode is requested, it starts the process through ConPTY, starts one output reader, and creates an input writer that normalizes terminal newlines. If terminal mode is not requested, it starts the process with separate pipes, starts readers for stdout and stderr, and creates an input writer for stdin. It returns a bundle of raw Windows process handles, background worker handles, terminal ownership if any, the token, and private desktop ownership if any.

**Call relations**: The main session function calls this after security preparation is complete. This function then hands off to either spawn_conpty_process_as_user or spawn_process_with_pipes to do the low-level Windows launch, and it uses spawn_output_reader and spawn_input_writer to connect the new process to the rest of the program.

*Call graph*: calls 4 internal fn (spawn_conpty_process_as_user, spawn_process_with_pipes, spawn_input_writer, spawn_output_reader); called by 1 (spawn_windows_sandbox_session_legacy); 2 external calls (bail!, spawn).


##### `spawn_output_reader`  (lines 141–148)

```
fn spawn_output_reader(
    output_read: HANDLE,
    output_tx: broadcast::Sender<Vec<u8>>,
) -> std::thread::JoinHandle<()>
```

**Purpose**: Starts a background thread that continuously reads output bytes from a Windows handle and sends them to anyone listening. This is how stdout or stderr from the child process becomes available to the caller.

**Data flow**: It receives a Windows read handle and a broadcast channel. The background reader pulls chunks of bytes from the handle, copies each chunk, and sends it through the channel. It returns the thread handle so the caller can later wait for the reader to finish.

**Call relations**: spawn_legacy_process calls this once for terminal output, or twice for non-terminal output where stdout and stderr are separate. Internally it relies on read_handle_loop, which performs the repeated low-level reading.

*Call graph*: calls 1 internal fn (read_handle_loop); called by 1 (spawn_legacy_process).


##### `spawn_input_writer`  (lines 150–176)

```
fn spawn_input_writer(
    input_write: Option<HANDLE>,
    mut writer_rx: mpsc::Receiver<Vec<u8>>,
    normalize_newlines: bool,
) -> tokio::task::JoinHandle<()>
```

**Purpose**: Starts a background task that writes caller-provided input into the child process. It is the bridge from the program’s input channel to the process’s stdin or terminal input.

**Data flow**: It receives an optional Windows write handle, a channel of byte chunks, and a flag saying whether terminal newline cleanup is needed. As byte chunks arrive, it optionally converts line endings into the form Windows terminal programs expect, then writes all bytes to the handle. When the input channel closes or writing fails, it closes the write handle if one exists.

**Call relations**: spawn_legacy_process creates this task for both ConPTY and pipe-based processes. In terminal mode it uses newline normalization so interactive programs behave naturally; in pipe mode it writes the bytes as-is. The actual complete write is done by write_all_handle.

*Call graph*: called by 1 (spawn_legacy_process); 1 external calls (spawn_blocking).


##### `write_all_handle`  (lines 178–200)

```
fn write_all_handle(handle: HANDLE, mut bytes: &[u8]) -> Result<()>
```

**Purpose**: Writes an entire byte buffer to a Windows handle, retrying until every byte has been accepted. This avoids silently losing part of the caller’s input.

**Data flow**: It receives a Windows handle and a slice of bytes. It calls the Windows WriteFile function, checks how many bytes were written, and keeps going with the remaining bytes until none are left. It returns success if everything was written, or an error if Windows reports a failure or claims success while writing zero bytes.

**Call relations**: This is the low-level helper used by the input-writing path. spawn_input_writer depends on it so that each input chunk sent to the child process is fully delivered before moving to the next chunk.

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

**Purpose**: Finishes the process lifetime after the child has ended or been killed. It collects the exit code, waits for output readers to stop, reports the exit code, closes handles, and writes a success or failure log.

**Data flow**: It receives the one-time exit-code sender, the shared process handle, the process thread handle, the output reader thread, optional log location, and the command. It waits for the process handle, reads the Windows exit code, joins the output-reading thread, sends the exit code to the caller, closes the thread and process handles, and logs the command as successful or failed.

**Call relations**: The wait thread created by spawn_windows_sandbox_session_legacy calls this at the end of the process. It uses Windows wait and exit-code calls to learn what happened, then calls log_success or log_failure so the run is recorded.

*Call graph*: calls 2 internal fn (log_failure, log_success); 6 external calls (join, send, format!, CloseHandle, GetExitCodeProcess, WaitForSingleObject).


##### `resize_conpty_handle`  (lines 245–269)

```
fn resize_conpty_handle(hpc: &Arc<StdMutex<Option<HANDLE>>>, size: TerminalSize) -> Result<()>
```

**Purpose**: Changes the size of a running ConPTY terminal. This lets an interactive command adapt when the user’s terminal window changes size.

**Data flow**: It receives a shared, lock-protected optional ConPTY handle and a requested terminal size in rows and columns. It locks the handle, errors if there is no terminal attached, then calls Windows ResizePseudoConsole with the new dimensions. It returns success or an error message from the resize attempt.

**Call relations**: spawn_windows_sandbox_session_legacy installs this function as the process driver’s resize callback when the process was launched with a terminal. Later, whoever owns the SpawnedProcess can trigger it to resize the underlying Windows pseudo-console.

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

**Purpose**: Creates a complete legacy Windows sandbox session and returns a controllable spawned process. This is the main doorway in this file: it prepares permissions, starts the command, wires input/output, sets up termination, and exposes the result to the caller.

**Data flow**: It receives the permission profile, workspace paths, Codex home path, command, working directory, environment, timeout, extra deny paths, terminal and stdin settings, and desktop setting. It first prepares the command context and rejects features this legacy backend cannot safely support, such as restricted read access and deny-read overrides. It computes legacy capability roots, prepares a restricted token and security identifiers, applies access-control rules, and creates channels for stdin, stdout, stderr, and exit status. It then calls spawn_legacy_process. After launch, it stores the process and terminal handles behind locks, creates a waiter thread that handles timeout and cleanup, builds a terminator callback, builds an optional terminal resizer, and returns a SpawnedProcess through finish_driver_spawn.

**Call relations**: This function is the top-level coordinator for the legacy backend. It calls the spawn-preparation helpers to set up Windows permissions, calls spawn_legacy_process to actually start the command, and passes the finished ProcessDriver to finish_driver_spawn so the rest of the system can interact with the process in a backend-neutral way. The call graph records this as the function reached for legacy Windows sandbox session spawning.

*Call graph*: calls 7 internal fn (allow_null_device_for_workspace_write, apply_legacy_session_acl_rules, legacy_session_capability_roots, prepare_legacy_session_security, prepare_legacy_spawn_context, spawn_legacy_process, finish_driver_spawn); called by 1 (spawn_windows_sandbox_session_legacy); 9 external calls (clone, new, new, new, bail!, spawn, is_empty, iter, CloseHandle).


### `tui/src/windows_sandbox.rs`

`orchestration` · `startup, permission changes, and Windows sandbox setup`

The Windows sandbox is a safety layer that can limit what commands are allowed to touch on the machine. This file exists because parts of that setup still run inside the local TUI process, rather than entirely on a remote app server. In plain terms, it is a small adapter between the user-facing TUI configuration and the Windows-specific sandbox machinery.

First, it translates configuration and feature flags into a simple sandbox level: disabled, restricted, or elevated. That lets the rest of the TUI ask one question — “what sandbox mode are we in?” — without knowing all the details of config files and feature switches.

On Windows, the file also forwards setup work to the `codex_windows_sandbox` library. It can check whether setup is complete, run an elevated setup step, turn setup failures into safe metric labels, and refresh permissions when the user grants an extra read-only folder. On non-Windows systems, the readiness check simply says setup is not complete, because the Windows sandbox does not apply there.

An important detail is that `grant_read_root_non_elevated` is careful before changing permissions: it rejects paths that are not absolute, do not exist, or are not directories. Like a security guard checking an address before adding it to an access list, it validates the folder before asking the sandbox system to allow it.

#### Function details

##### `level_from_config`  (lines 23–35)

```
fn level_from_config(config: &Config) -> WindowsSandboxLevel
```

**Purpose**: This function turns the app’s configuration into one clear Windows sandbox level. It gives the rest of the TUI a simple answer instead of making every caller understand config file values and feature flags.

**Data flow**: It takes the current `Config`. It first looks for an explicit Windows sandbox mode in the permissions settings. If that is present, it uses it. If not, it checks feature flags to decide whether elevated or restricted sandboxing is enabled. It returns a `WindowsSandboxLevel`, such as elevated, restricted-token, or disabled.

**Call relations**: This is the common decision point used by many parts of the TUI flow. Startup, event handling, permission popups, command dispatch, built-in command flags, and elevated setup checks call it when they need to know which sandbox behavior should apply.

*Call graph*: called by 11 (run, propagate_windows_sandbox_turn_context, handle_event, open_permissions_popup, permission_mode_actions, builtin_command_flags, dispatch_command, elevated_windows_sandbox_setup_required, maybe_prompt_windows_sandbox_enable, new (+1 more)).


##### `sandbox_setup_is_complete`  (lines 41–43)

```
fn sandbox_setup_is_complete(_codex_home: &Path) -> bool
```

**Purpose**: This function answers whether the Windows sandbox setup has already been completed for the given Codex home folder. On non-Windows platforms, it always returns `false` because this Windows-specific setup is not available there.

**Data flow**: It receives a path to the Codex home directory. On Windows, this name is re-exported from the Windows sandbox library, so the real check is done there. On non-Windows systems, the input is ignored and the result is simply `false`.

**Call relations**: This wrapper gives the TUI one place to ask about sandbox readiness without scattering operating-system checks throughout the code. When compiled for Windows it hands that question to the sandbox library; otherwise it provides a safe no-op answer.


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

**Purpose**: This function starts the Windows sandbox setup that needs elevated rights. Elevated rights mean the setup may require higher system permission, like an administrator-approved helper, to prepare the sandbox safely.

**Data flow**: It receives the current permission profile, workspace folders, the command’s working directory, environment variables, and the Codex home directory. It converts the permission profile plus workspace roots into the exact sandbox permissions needed. Then it builds a setup request and passes it to the Windows sandbox library. It returns success if setup finishes, or an error if permission resolution or setup fails.

**Call relations**: Callers use this when the chosen sandbox level requires elevated preparation. This function does not do the low-level Windows work itself; it translates TUI-side information into the sandbox library’s setup request, using `try_from_permission_profile_for_workspace_roots`, `run_elevated_setup`, and the default setup-root overrides.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots); 2 external calls (run_elevated_setup, default).


##### `elevated_setup_failure_details`  (lines 70–76)

```
fn elevated_setup_failure_details(err: &anyhow::Error) -> Option<(String, String)>
```

**Purpose**: This function extracts safe, structured details from an elevated sandbox setup error. It is mainly useful for reporting or metrics, where the code wants a stable error code and a cleaned-up message.

**Data flow**: It receives an error. It asks the Windows sandbox library whether that error contains a known setup failure. If not, it returns nothing. If yes, it returns the failure code as text and a sanitized version of the message, meaning the message is cleaned so it is safer to use as a metric tag.

**Call relations**: After elevated setup fails, reporting code can call this helper to turn a raw error into metric-friendly details. It delegates the actual failure extraction and message sanitizing to the Windows sandbox library.

*Call graph*: 2 external calls (extract_setup_failure, sanitize_setup_metric_tag_value).


##### `elevated_setup_failure_metric_name`  (lines 79–90)

```
fn elevated_setup_failure_metric_name(err: &anyhow::Error) -> &'static str
```

**Purpose**: This function chooses the metric name to record for an elevated setup failure. It separates a user-canceled helper launch from other setup failures, so dashboards can tell cancellation apart from real breakage.

**Data flow**: It receives an error. It checks whether the Windows sandbox library can extract a setup failure from it, and whether the failure code means the orchestrator helper launch was canceled. If so, it returns the cancellation metric name. Otherwise, it returns the general elevated setup failure metric name.

**Call relations**: This is used after setup errors when the TUI or telemetry layer needs to record what happened. It relies on the sandbox library to identify known setup failures, then makes the final naming decision locally.

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

**Purpose**: This function adds an extra read-only folder to the Windows sandbox permissions without running the full elevated setup path. It is used when a user grants the sandbox permission to read another folder.

**Data flow**: It receives the current permission profile, workspace roots, command working directory, environment variables, Codex home, and the folder to grant. It first checks that the folder path is absolute, exists, and is a directory. If any check fails, it returns an error. If the path is valid, it canonicalizes it, meaning it resolves it to a clean standard path, then asks the Windows sandbox library to refresh setup with that extra read root. It returns the canonical folder path on success.

**Call relations**: This helper fits into permission-update flows. When the TUI needs to grant read access to a new folder, this function performs the local safety checks, then hands the refreshed permission request to `run_setup_refresh_with_extra_read_roots` in the Windows sandbox library.

*Call graph*: 7 external calls (exists, is_absolute, is_dir, bail!, run_setup_refresh_with_extra_read_roots, canonicalize, vec!).


### Provisioning state and security primitives
These files establish setup-time state, identity, errors, and the low-level ACL and token machinery used to provision sandbox credentials and permissions.

### `windows-sandbox-rs/src/setup_error.rs`

`domain_logic` · `sandbox setup error handling`

Setting up the Windows sandbox needs elevated permissions, creates local users, writes secret files, configures firewall rules, and locks down folders. Many things can fail, and some failures happen in a separate elevated helper process. This file is the common error notebook for that whole setup path.

It starts by listing known setup error codes, such as “failed to create the sandbox directory” or “failed to add the firewall rule.” These codes are stable machine-readable labels, which makes them useful for logs and metrics. A `SetupFailure` pairs one of those codes with a human-readable message, like a labeled incident report.

The file also lets the elevated helper write a structured JSON report at `codex_home/.sandbox/setup_error.json`. The normal, non-elevated process can later read that file and turn it back into a `SetupFailure`. This matters because a helper process may fail after it has already been launched, and without this report the caller would only know that “something failed.”

Finally, it protects privacy when sending error messages as metric tags. Before a message is used in metrics, it replaces path pieces that look like the current username with `<user>`, then applies general metric-tag cleanup. In everyday terms, it keeps the error useful while removing names from paths.

#### Function details

##### `SetupErrorCode::as_str`  (lines 78–111)

```
fn as_str(self) -> &'static str
```

**Purpose**: Turns a setup error code into its stable text label. This is useful when the code needs to appear in logs, display text, JSON-like reports, or metric tags.

**Data flow**: It receives one `SetupErrorCode` value, matches it against the known list of setup failures, and returns the matching lowercase string such as `helper_firewall_rule_verify_failed`. It does not change any stored data.

**Call relations**: This is the bridge from the internal enum value to readable text. `SetupFailure::fmt` relies on it when turning a full failure into a message people can read.


##### `SetupFailure::new`  (lines 127–132)

```
fn new(code: SetupErrorCode, message: impl Into<String>) -> Self
```

**Purpose**: Builds a complete setup failure from a known error code and a message. Other setup code uses it whenever it wants to report a failure in the project’s standard format.

**Data flow**: It takes a `SetupErrorCode` and any message-like value, converts the message into a `String`, and returns a `SetupFailure` holding both pieces. Nothing is written to disk or sent elsewhere.

**Call relations**: This is the main constructor used across setup work, including firewall configuration, sandbox user provisioning, local group setup, and the setup program’s main path. Higher-level helpers also call it through `failure` and `from_report` so all failures end up in the same shape.

*Call graph*: called by 11 (configure_offline_sandbox_network, configure_rule, ensure_offline_outbound_block, ensure_offline_proxy_allowlist, validate_local_policy_modify_result, provision_and_hide_sandbox_users, real_main, ensure_local_group, ensure_local_user, prepare_setup_marker (+1 more)); 1 external calls (into).


##### `SetupFailure::from_report`  (lines 134–136)

```
fn from_report(report: SetupErrorReport) -> Self
```

**Purpose**: Turns a saved setup error report back into a normal `SetupFailure`. This is used when the main process reads an error report written by the elevated helper.

**Data flow**: It takes a `SetupErrorReport`, copies out its code and message, and feeds them into `SetupFailure::new`. The output is a `SetupFailure` that can be returned like any other setup error.

**Call relations**: When `report_helper_failure` finds a helper-written report, it calls this function so the caller sees a normal setup failure rather than raw report data.

*Call graph*: called by 1 (report_helper_failure); 1 external calls (new).


##### `SetupFailure::metric_message`  (lines 138–140)

```
fn metric_message(&self) -> String
```

**Purpose**: Produces a safe version of the failure message for metrics. It keeps the message useful for grouping failures, but removes sensitive username path pieces and applies metric formatting cleanup.

**Data flow**: It reads the `message` inside the `SetupFailure`, passes it through `sanitize_setup_metric_tag_value`, and returns the cleaned string. The original failure is not changed.

**Call relations**: This is used when setup failures are turned into metric fields. It hands the privacy and formatting work to `sanitize_setup_metric_tag_value`.

*Call graph*: calls 1 internal fn (sanitize_setup_metric_tag_value).


##### `SetupFailure::fmt`  (lines 144–146)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Defines how a `SetupFailure` is shown as plain text. The output includes both the machine-readable code and the human-readable message.

**Data flow**: It reads the failure’s code and message, converts the code with `SetupErrorCode::as_str`, and writes text in the form `code: message` into the formatter supplied by Rust’s display system.

**Call relations**: This is called automatically when a `SetupFailure` is displayed, logged, or wrapped into a broader error message. It depends on `SetupErrorCode::as_str` for the code label.

*Call graph*: 1 external calls (write!).


##### `failure`  (lines 151–153)

```
fn failure(code: SetupErrorCode, message: impl Into<String>) -> anyhow::Error
```

**Purpose**: Creates a standard `anyhow::Error` from a setup error code and message. `anyhow::Error` is a general-purpose error wrapper used so different error types can move through the same result pipeline.

**Data flow**: It takes a setup error code and message, builds a `SetupFailure` with them, wraps that failure inside an `anyhow::Error`, and returns the wrapped error.

**Call relations**: Higher-level setup flows such as elevated provisioning, launching the setup executable, reporting helper failure, and verifying completion use this when they need to return a setup-specific failure through the broader error system.

*Call graph*: calls 1 internal fn (new); called by 4 (report_helper_failure, run_elevated_provisioning_setup, run_setup_exe, verify_setup_completed); 1 external calls (new).


##### `extract_failure`  (lines 155–157)

```
fn extract_failure(err: &anyhow::Error) -> Option<&SetupFailure>
```

**Purpose**: Checks whether a general `anyhow::Error` is really one of this file’s `SetupFailure` errors. This lets callers recover the structured code and message after the error has been wrapped.

**Data flow**: It receives a reference to a general error, tries to look inside it for a `SetupFailure`, and returns either a reference to that failure or `None` if the error is some other kind.

**Call relations**: Tests around helper failure reporting use this to confirm that the right structured setup failure was produced, especially when reading or clearing the helper’s report succeeds or fails.

*Call graph*: called by 2 (report_helper_failure_ignores_setup_error_report_when_clear_failed, report_helper_failure_uses_setup_error_report_when_clear_succeeded).


##### `setup_error_path`  (lines 159–161)

```
fn setup_error_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the exact path where the setup error JSON report lives. This keeps all readers and writers using the same location.

**Data flow**: It takes the `codex_home` folder path, appends `.sandbox`, then appends `setup_error.json`, and returns that full path. It does not touch the file system.

**Call relations**: The clear, read, and write functions all call this first, so a report is always removed, saved, and loaded from the same place.

*Call graph*: called by 3 (clear_setup_error_report, read_setup_error_report, write_setup_error_report); 1 external calls (join).


##### `clear_setup_error_report`  (lines 163–170)

```
fn clear_setup_error_report(codex_home: &Path) -> Result<()>
```

**Purpose**: Deletes any old setup error report before a new setup attempt. This prevents a stale failure from being mistaken for the result of the current run.

**Data flow**: It builds the report path with `setup_error_path`, tries to remove that file, and treats “file not found” as success because there is simply nothing to clear. Other delete errors are returned with context that names the path.

**Call relations**: Setup launch and refresh flows call this before running setup work. If clearing succeeds, later error reporting can trust that any report found was written by the latest helper run.

*Call graph*: calls 1 internal fn (setup_error_path); called by 2 (run_setup_exe, run_setup_refresh_inner); 1 external calls (remove_file).


##### `write_setup_error_report`  (lines 172–180)

```
fn write_setup_error_report(codex_home: &Path, report: &SetupErrorReport) -> Result<()>
```

**Purpose**: Saves a structured setup failure report for another process to read later. This is how the elevated helper can explain a failure back to the orchestrating process.

**Data flow**: It takes `codex_home` and a `SetupErrorReport`, makes sure the `.sandbox` folder exists, converts the report to pretty JSON bytes, and writes those bytes to `setup_error.json`. It returns success or an error with path context.

**Call relations**: Helper-failure reporting tests call this to set up realistic report files. In the real flow, it pairs with `read_setup_error_report`, which reads the helper’s written report after the helper exits.

*Call graph*: calls 1 internal fn (setup_error_path); called by 2 (report_helper_failure_ignores_setup_error_report_when_clear_failed, report_helper_failure_uses_setup_error_report_when_clear_succeeded); 4 external calls (join, create_dir_all, write, to_vec_pretty).


##### `read_setup_error_report`  (lines 182–192)

```
fn read_setup_error_report(codex_home: &Path) -> Result<Option<SetupErrorReport>>
```

**Purpose**: Reads the helper’s saved setup error report, if one exists. It allows the caller to learn the real setup failure instead of only seeing that the helper process failed.

**Data flow**: It builds the report path, reads the file if present, and returns `Ok(None)` if the file is missing. If bytes are found, it parses them as a `SetupErrorReport` and returns `Ok(Some(report))`; read or parse problems become errors with file context.

**Call relations**: `report_helper_failure` calls this after the helper exits badly. If a report is available, the caller can turn it into a `SetupFailure`; if not, it falls back to a less specific helper-exit error.

*Call graph*: calls 1 internal fn (setup_error_path); called by 1 (report_helper_failure); 1 external calls (read).


##### `sanitize_setup_metric_tag_value`  (lines 195–197)

```
fn sanitize_setup_metric_tag_value(value: &str) -> String
```

**Purpose**: Cleans a setup error message so it can be safely used as a metric tag. A metric tag is a short label attached to telemetry so failures can be counted and grouped.

**Data flow**: It takes a raw message, first calls `redact_home_paths` to replace username path segments with `<user>`, then passes the result into the shared `sanitize_metric_tag_value` cleanup function. It returns the final metric-safe string.

**Call relations**: `SetupFailure::metric_message` uses this for failure messages, and setup metric emission uses it directly when preparing telemetry.

*Call graph*: calls 1 internal fn (redact_home_paths); called by 2 (metric_message, emit_wfp_setup_metric); 1 external calls (sanitize_metric_tag_value).


##### `redact_home_paths`  (lines 199–214)

```
fn redact_home_paths(value: &str) -> String
```

**Purpose**: Finds the current user names known from environment variables and removes them from path-like text. This helps avoid leaking a person’s Windows or Unix username in metrics.

**Data flow**: It reads the `USERNAME` and `USER` environment variables, ignores empty values, avoids duplicates that differ only by letter case, and passes the collected names plus the original message to `redact_username_segments`. It returns the redacted message.

**Call relations**: This is the privacy step inside `sanitize_setup_metric_tag_value`. It delegates the actual path-segment replacement to `redact_username_segments`.

*Call graph*: calls 1 internal fn (redact_username_segments); called by 1 (sanitize_setup_metric_tag_value); 2 external calls (new, var).


##### `redact_username_segments`  (lines 216–256)

```
fn redact_username_segments(value: &str, usernames: &[String]) -> String
```

**Purpose**: Replaces path pieces that exactly match known usernames with `<user>`. It is careful to only replace whole path segments, not every matching word inside a larger string.

**Data flow**: It receives a text value and a list of usernames. It splits the text around `/` and `\` path separators, checks each segment against the usernames, replaces matching segments with `<user>`, then stitches the text back together with the original separators.

**Call relations**: `redact_home_paths` uses this during metric sanitization. The test functions call it directly to prove it redacts expected path segments, leaves unrelated paths alone, and handles repeated occurrences.

*Call graph*: called by 4 (redact_home_paths, sanitize_tag_value_leaves_unknown_segments, sanitize_tag_value_redacts_multiple_occurrences, sanitize_tag_value_redacts_username_segments); 4 external calls (new, new, cfg!, take).


##### `tests::sanitize_tag_value_redacts_username_segments`  (lines 264–272)

```
fn sanitize_tag_value_redacts_username_segments()
```

**Purpose**: Checks that username-looking path segments are replaced with `<user>`. This protects the privacy behavior from accidental changes.

**Data flow**: It creates a sample message containing Windows paths with `Alice` and `Bob`, calls `redact_username_segments` with those names, and asserts that both names were replaced while the rest of the paths stayed the same.

**Call relations**: This test exercises the core redaction helper directly. It supports the higher-level metric-sanitizing path by proving the username replacement works on realistic Windows-style paths.

*Call graph*: calls 1 internal fn (redact_username_segments); 2 external calls (assert_eq!, vec!).


##### `tests::sanitize_tag_value_leaves_unknown_segments`  (lines 275–280)

```
fn sanitize_tag_value_leaves_unknown_segments()
```

**Purpose**: Checks that the redaction code does not change unrelated path text. This matters because over-redacting would make error messages less useful.

**Data flow**: It creates a sample path that does not include the listed username, calls `redact_username_segments`, and asserts that the returned message exactly matches the original.

**Call relations**: This test guards the helper used by `redact_home_paths`. It confirms that only known username segments are changed.

*Call graph*: calls 1 internal fn (redact_username_segments); 2 external calls (assert_eq!, vec!).


##### `tests::sanitize_tag_value_redacts_multiple_occurrences`  (lines 283–288)

```
fn sanitize_tag_value_redacts_multiple_occurrences()
```

**Purpose**: Checks that the same username is redacted every time it appears. This prevents a message with two paths from leaking the username in the second path.

**Data flow**: It creates a message with two paths containing `Alice`, calls `redact_username_segments`, and asserts that both occurrences become `<user>`.

**Call relations**: This test directly supports the redaction helper used in metric cleanup. It proves the helper scans the whole message, not just the first match.

*Call graph*: calls 1 internal fn (redact_username_segments); 2 external calls (assert_eq!, vec!).


### `windows-sandbox-rs/src/setup.rs`

`orchestration` · `startup and sandbox setup refresh`

Windows cannot safely sandbox a command just by asking nicely; it needs real operating-system setup: special local users, folders for sandbox state, access control lists (Windows file permission rules), and firewall settings. This file builds that setup request and launches the helper program that can apply it, using administrator rights when needed.

The flow is like packing a work order for a locksmith. First, the file decides which sandbox identity should be used: an offline user when networking is blocked or forced through a proxy, or an online user when direct networking is allowed. Then it gathers the folders the sandbox may read or write. It is careful to include helper binaries the sandbox needs, Windows system folders when appropriate, and workspace folders, while excluding sensitive places such as SSH keys, cloud credentials, Codex’s own sandbox state, and other secret-bearing profile folders.

It serializes this plan into a payload, base64-encodes it, and starts `codex-windows-sandbox-setup.exe`. For full setup it may use Windows’ “run as administrator” path; for refreshes it deliberately avoids elevation. It also records and reads structured setup errors so callers get useful failure messages instead of just “the helper failed.” The tests at the bottom lock down the important safety behavior: proxy parsing, path filtering, helper lookup, and error reporting.

#### Function details

##### `sandbox_dir`  (lines 71–73)

```
fn sandbox_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Returns the main hidden folder under Codex home where sandbox state is stored. Other setup code uses this as the shared place for markers, logs, and control files.

**Data flow**: It receives the Codex home path → appends `.sandbox` → returns that full path without touching the disk.

**Call relations**: Many setup paths start here: marker files, logging, elevated setup, refresh setup, credential setup, and write-root filtering all call it when they need the sandbox state directory.

*Call graph*: called by 8 (sync_persistent_deny_read_acls, require_logon_sandbox_creds, filter_sensitive_write_roots, run_elevated_provisioning_setup, run_elevated_setup, run_setup_exe, run_setup_refresh_inner, setup_marker_path); 1 external calls (join).


##### `sandbox_bin_dir`  (lines 75–77)

```
fn sandbox_bin_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Returns the folder under Codex home that holds sandbox helper binaries. This matters because the sandbox should not be allowed to overwrite its own tools.

**Data flow**: It receives the Codex home path → appends `.sandbox-bin` → returns the resulting path.

**Call relations**: The sensitive-write filter calls this while removing protected Codex-controlled folders from writable sandbox roots.

*Call graph*: called by 1 (filter_sensitive_write_roots); 1 external calls (join).


##### `sandbox_secrets_dir`  (lines 79–81)

```
fn sandbox_secrets_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Returns the hidden folder under Codex home where sandbox secrets are kept. This separates secret material from ordinary workspace files.

**Data flow**: It receives the Codex home path → appends `.sandbox-secrets` → returns the resulting path.

**Call relations**: The sandbox user file path is built from this, and the sensitive-write filter uses it to make sure sandboxed commands cannot modify stored secrets.

*Call graph*: called by 2 (filter_sensitive_write_roots, sandbox_users_path); 1 external calls (join).


##### `setup_marker_path`  (lines 83–85)

```
fn setup_marker_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the JSON file that records whether sandbox setup is current. The marker lets later runs avoid unnecessary setup work.

**Data flow**: It receives Codex home → asks `sandbox_dir` for the state folder → appends `setup_marker.json` → returns the file path.

**Call relations**: Marker-loading code calls this when checking whether the installed sandbox setup matches the current expected version and settings.

*Call graph*: calls 1 internal fn (sandbox_dir); called by 1 (load_marker).


##### `sandbox_users_path`  (lines 87–89)

```
fn sandbox_users_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the path to the JSON file that stores sandbox user records. Those records include encrypted passwords for the special sandbox accounts.

**Data flow**: It receives Codex home → asks `sandbox_secrets_dir` for the secrets folder → appends `sandbox_users.json` → returns the file path.

**Call relations**: User-loading and cleanup code call this when reading or removing the saved sandbox account information.

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

**Purpose**: Refreshes sandbox setup for a normal permission profile, when that profile can be enforced by the Windows sandbox. If the profile is not one this subsystem controls, it quietly does nothing.

**Data flow**: It receives a permission profile, workspace roots, command folder, environment variables, Codex home, and proxy setting → converts the profile into resolved Windows sandbox permissions → if successful, builds a setup request and passes it to the inner refresh runner → returns success or a setup error.

**Call relations**: This is a public refresh entry used by higher-level code before sandboxed work. It delegates all real payload building and helper launching to `run_setup_refresh_inner`.

*Call graph*: calls 2 internal fn (try_from_permission_profile_for_workspace_roots, run_setup_refresh_inner); 1 external calls (default).


##### `run_setup_refresh_with_overrides`  (lines 136–141)

```
fn run_setup_refresh_with_overrides(
    request: SandboxSetupRequest<'_>,
    overrides: SetupRootOverrides,
) -> Result<()>
```

**Purpose**: Refreshes setup using an already-built request plus explicit root overrides. It is useful when a caller has a more exact read/write plan than the default permission resolver.

**Data flow**: It receives a sandbox setup request and override settings → forwards both unchanged to the inner refresh routine → returns whatever that routine reports.

**Call relations**: Credential setup calls this path when it needs to refresh sandbox rules with custom roots, while `run_setup_refresh_inner` performs the actual helper invocation.

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

**Purpose**: Refreshes setup while adding extra readable folders to the normal readable set. This is a convenience for cases where the sandbox must temporarily see additional files.

**Data flow**: It receives the profile, workspace roots, command folder, environment, Codex home, extra read roots, and proxy flag → resolves permissions → gathers the usual read roots → appends the extras → calls the inner refresh with explicit read roots and no write roots → returns success or error.

**Call relations**: This public helper feeds `run_setup_refresh_inner`. Tests verify it skips unsupported profiles instead of trying to launch setup.

*Call graph*: calls 3 internal fn (try_from_permission_profile_for_workspace_roots, gather_read_roots, run_setup_refresh_inner); 1 external calls (new).


##### `run_setup_refresh_inner`  (lines 180–266)

```
fn run_setup_refresh_inner(
    request: SandboxSetupRequest<'_>,
    overrides: SetupRootOverrides,
) -> Result<()>
```

**Purpose**: Builds and launches a non-elevated refresh request for the setup helper. Refreshes update sandbox rules but must not trigger a Windows administrator prompt.

**Data flow**: It receives a setup request and root overrides → checks that the requested permissions are enforceable → builds read, write, deny-read, and deny-write paths → chooses online or offline identity and proxy settings → serializes the payload to JSON and base64 → starts the setup helper without elevation → clears or reads structured error reports → returns success or a detailed error.

**Call relations**: All refresh entry points call this. It relies on path-building helpers, network identity helpers, setup-executable lookup, logging, and `report_helper_failure` when the helper exits unsuccessfully.

*Call graph*: calls 11 internal fn (current_log_file_path, log_note, from_permissions, build_payload_deny_read_paths, build_payload_deny_write_paths, build_payload_roots, find_setup_exe, offline_proxy_settings_from_env, report_helper_failure, sandbox_dir (+1 more)); called by 3 (run_setup_refresh, run_setup_refresh_with_extra_read_roots, run_setup_refresh_with_overrides); 7 external calls (null, bail!, new, format!, to_vec, current_dir, var).


##### `SetupMarker::version_matches`  (lines 282–284)

```
fn version_matches(&self) -> bool
```

**Purpose**: Checks whether a saved setup marker was written by the setup version this code expects. This prevents stale sandbox configuration from being trusted after setup rules change.

**Data flow**: It reads the marker’s stored version → compares it with `SETUP_VERSION` → returns true if they match and false otherwise.

**Call relations**: Marker-checking code uses this when deciding whether existing setup can be reused or must be rebuilt.


##### `SetupMarker::request_mismatch_reason`  (lines 286–306)

```
fn request_mismatch_reason(
        &self,
        network_identity: SandboxNetworkIdentity,
        offline_proxy_settings: &OfflineProxySettings,
    ) -> Option<String>
```

**Purpose**: Explains why an existing offline sandbox setup no longer matches the desired proxy firewall settings. It returns no reason when the online identity is used, because those offline firewall settings are irrelevant.

**Data flow**: It receives the chosen network identity and desired offline proxy settings → if the identity is online, returns nothing → otherwise compares stored proxy ports and local-binding permission with the desired values → returns a human-readable mismatch message only when they differ.

**Call relations**: Credential/setup readiness code can call this after loading a marker to decide whether setup must be refreshed because proxy-related firewall rules changed.

*Call graph*: calls 1 internal fn (uses_offline_identity); 1 external calls (format!).


##### `SandboxUsersFile::version_matches`  (lines 324–326)

```
fn version_matches(&self) -> bool
```

**Purpose**: Checks whether the saved sandbox user records belong to the current setup format. This protects callers from using outdated account credentials.

**Data flow**: It reads the saved user file version → compares it with `SETUP_VERSION` → returns true for a match and false otherwise.

**Call relations**: User-loading code uses this after reading `sandbox_users.json` to decide whether the stored sandbox accounts are usable.


##### `is_elevated`  (lines 329–359)

```
fn is_elevated() -> Result<bool>
```

**Purpose**: Detects whether the current process is running with administrator rights. The setup code needs this before deciding whether to ask Windows for elevation.

**Data flow**: It asks Windows to create the built-in Administrators group identifier → checks whether the current process token belongs to that group → frees the Windows identifier → returns true or false, or an error if the Windows calls fail.

**Call relations**: `run_elevated_setup` uses this to decide whether to launch the helper with a UAC prompt, and provisioning setup uses it to require that the caller already be elevated.

*Call graph*: called by 2 (run_elevated_provisioning_setup, run_elevated_setup); 5 external calls (anyhow!, null_mut, AllocateAndInitializeSid, CheckTokenMembership, FreeSid).


##### `canonical_existing`  (lines 361–371)

```
fn canonical_existing(paths: &[PathBuf]) -> Vec<PathBuf>
```

**Purpose**: Keeps only paths that exist and normalizes them to their real filesystem spelling when possible. This reduces duplicate or misleading paths before they are sent to the setup helper.

**Data flow**: It receives a list of paths → drops any path that does not exist → canonicalizes each remaining path, falling back to the original if canonicalization fails → returns the cleaned list.

**Call relations**: Read-root and write-root gatherers call this before building setup payloads, so the helper receives stable folder names.

*Call graph*: called by 5 (build_payload_roots, effective_write_roots_for_permissions, gather_full_read_roots_for_permissions, gather_read_roots, gather_write_roots_for_permissions); 1 external calls (iter).


##### `profile_read_roots`  (lines 373–390)

```
fn profile_read_roots(user_profile: &Path) -> Vec<PathBuf>
```

**Purpose**: Turns a whole Windows user profile into a safer list of top-level readable entries. It avoids common secret folders like `.ssh`, `.aws`, and `.kube`.

**Data flow**: It receives the user profile path → tries to list its immediate children → filters out configured sensitive child names case-insensitively → returns the remaining child paths; if listing fails, it falls back to returning the profile path itself.

**Call relations**: Full-read gathering and user-profile expansion call this when a broad profile path needs to be split into safer pieces. Tests verify both exclusion and fallback behavior.

*Call graph*: called by 4 (expand_user_profile_root_for, gather_full_read_roots_for_permissions, profile_read_roots_excludes_configured_top_level_entries, profile_read_roots_falls_back_to_profile_root_when_enumeration_fails); 2 external calls (read_dir, vec!).


##### `gather_helper_read_roots`  (lines 392–396)

```
fn gather_helper_read_roots(codex_home: &Path) -> Vec<PathBuf>
```

**Purpose**: Ensures the sandbox helper binary directory exists and includes it in readable roots. The sandbox needs to read helper tools even when user files are tightly restricted.

**Data flow**: It receives Codex home → computes the helper binary directory → creates it if needed → returns a one-item list containing that directory.

**Call relations**: Both normal and full read-root gathering use this, and payload building preserves it even when callers provide explicit read-root overrides.

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

**Purpose**: Builds the readable folder list for a policy that allows broad disk reading. It still constructs a concrete set of roots the helper can apply.

**Data flow**: It receives the command folder, resolved permissions, environment, and Codex home → starts with helper and Windows platform folders → adds safe user-profile children if `USERPROFILE` is available → adds the command folder and writable roots → keeps only existing canonical paths → returns the list.

**Call relations**: `gather_read_roots` calls this when permissions say full disk read access is allowed. A test checks that legacy Windows platform roots remain included.

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

**Purpose**: Builds the normal readable folder list for the sandbox from the resolved permission policy. This is the main path for deciding what the sandbox can see.

**Data flow**: It receives the command folder, permissions, environment, and Codex home → if full disk read is allowed, delegates to the full-read gatherer → otherwise starts with helper roots, optionally adds Windows platform folders, adds permission-derived readable roots, canonicalizes existing paths → returns the readable roots.

**Call relations**: Payload building and extra-read refresh call this. Tests verify it includes the helper directory and keeps writable workspace roots readable.

*Call graph*: calls 6 internal fn (has_full_disk_read_access, include_platform_defaults, readable_roots_for_cwd, canonical_existing, gather_full_read_roots_for_permissions, gather_helper_read_roots); called by 4 (build_payload_roots, run_setup_refresh_with_extra_read_roots, gather_read_roots_includes_helper_bin_dir, workspace_write_roots_remain_readable).


##### `gather_write_roots_for_permissions`  (lines 450–468)

```
fn gather_write_roots_for_permissions(
    permissions: &ResolvedWindowsSandboxPermissions,
    command_cwd: &Path,
    env_map: &HashMap<String, String>,
) -> Vec<PathBuf>
```

**Purpose**: Builds the initial writable folder list from the resolved permission policy. It removes duplicate paths after normalizing them.

**Data flow**: It receives permissions, command folder, and environment → asks permissions for writable roots relative to that command → canonicalizes existing paths → keeps the first occurrence of each unique path → returns the deduplicated list.

**Call relations**: `effective_write_roots_for_permissions` calls this when no explicit write-root override is provided.

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

**Purpose**: Provides the final writable roots that should be used in a setup payload. It is a small wrapper with a name that makes the setup use case clear.

**Data flow**: It receives permissions, command folder, environment, Codex home, and optional write-root override → passes them to the shared effective-write-root routine → returns the filtered writable roots.

**Call relations**: `build_payload_roots` calls this before pairing writable roots with readable roots.

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

**Purpose**: Computes the final safe writable roots for sandbox permissions. It starts from requested writable folders, then removes broad or sensitive locations that should never be writable.

**Data flow**: It receives permissions, command folder, environment, Codex home, and optional override roots → uses override roots or permission-derived roots → expands a whole user profile into child entries → removes the profile root, configured secret profile children, SSH config dependency folders, and protected Codex sandbox folders → returns the safe writable list.

**Call relations**: Setup payload construction calls this through `effective_write_roots_for_setup`, and other sandbox-spawn code uses it when applying capability restrictions at runtime.

*Call graph*: calls 7 internal fn (canonical_existing, expand_user_profile_root, filter_sensitive_write_roots, filter_ssh_config_dependency_roots, filter_user_profile_root, filter_user_profile_root_exclusions, gather_write_roots_for_permissions); called by 5 (apply_capability_denies_for_world_writable_for_permissions, run_windows_sandbox_capture_for_permission_profile, effective_write_roots_for_setup, legacy_session_capability_roots, prepare_elevated_spawn_context_for_permissions).


##### `SandboxNetworkIdentity::from_permissions`  (lines 548–557)

```
fn from_permissions(
        permissions: &ResolvedWindowsSandboxPermissions,
        proxy_enforced: bool,
    ) -> Self
```

**Purpose**: Chooses whether the sandbox should use the offline or online Windows account. Offline is used when networking is disabled or when proxy enforcement is active.

**Data flow**: It receives resolved permissions and a proxy-enforced flag → checks the network policy → returns `Offline` if proxy enforcement is on or networking is disabled, otherwise returns `Online`.

**Call relations**: Credential setup, elevated setup, and refresh setup call this before deciding proxy firewall settings and which sandbox account should be prepared.

*Call graph*: calls 1 internal fn (network_policy); called by 3 (require_logon_sandbox_creds, run_elevated_setup, run_setup_refresh_inner).


##### `SandboxNetworkIdentity::uses_offline_identity`  (lines 559–561)

```
fn uses_offline_identity(self) -> bool
```

**Purpose**: Answers whether a chosen network identity is the offline sandbox account. This keeps offline-specific checks readable.

**Data flow**: It receives the identity value → checks whether it is `Offline` → returns true or false.

**Call relations**: Proxy setting extraction and setup-marker mismatch checking call this so they only care about proxy firewall rules for offline sandboxes.

*Call graph*: called by 2 (request_mismatch_reason, offline_proxy_settings_from_env); 1 external calls (matches!).


##### `offline_proxy_settings_from_env`  (lines 578–594)

```
fn offline_proxy_settings_from_env(
    env_map: &HashMap<String, String>,
    network_identity: SandboxNetworkIdentity,
) -> OfflineProxySettings
```

**Purpose**: Extracts the proxy firewall settings needed for an offline sandbox. If the sandbox is online, it intentionally ignores proxy environment variables.

**Data flow**: It receives environment variables and the chosen network identity → if not offline, returns no ports and no local binding → if offline, parses loopback proxy ports and reads `CODEX_NETWORK_ALLOW_LOCAL_BINDING=1` → returns those settings.

**Call relations**: Credential setup, elevated setup, and refresh setup call this when preparing payloads or comparing existing setup.

*Call graph*: calls 2 internal fn (uses_offline_identity, proxy_ports_from_env); called by 3 (require_logon_sandbox_creds, run_elevated_setup, run_setup_refresh_inner); 1 external calls (vec!).


##### `proxy_ports_from_env`  (lines 596–606)

```
fn proxy_ports_from_env(env_map: &HashMap<String, String>) -> Vec<u16>
```

**Purpose**: Finds local proxy ports mentioned in common proxy environment variables. Sorting and deduplication make the resulting firewall request stable.

**Data flow**: It receives an environment map → checks known proxy variable names → parses each value for a loopback proxy port → stores ports in sorted set order → returns a sorted list of unique ports.

**Call relations**: `offline_proxy_settings_from_env` calls this only for offline sandbox identity. Tests cover duplicate and mixed-case proxy variables.

*Call graph*: calls 1 internal fn (loopback_proxy_port_from_url); called by 1 (offline_proxy_settings_from_env); 1 external calls (new).


##### `loopback_proxy_port_from_url`  (lines 608–627)

```
fn loopback_proxy_port_from_url(url: &str) -> Option<u16>
```

**Purpose**: Parses a proxy URL and returns its port only if it points to the local machine. This avoids opening firewall paths for remote proxy hosts.

**Data flow**: It receives a URL string → extracts the authority part after `://` → strips optional user credentials → accepts `localhost`, `127.0.0.1`, or IPv6 `::1` → parses a nonzero port → returns that port or nothing.

**Call relations**: `proxy_ports_from_env` calls this for each proxy environment value. Tests check common valid forms and rejected non-loopback or malformed values.

*Call graph*: called by 1 (proxy_ports_from_env).


##### `quote_arg`  (lines 629–663)

```
fn quote_arg(arg: &str) -> String
```

**Purpose**: Quotes a command-line argument using Windows command-line escaping rules. This is needed so the base64 payload is passed to the helper as one exact argument.

**Data flow**: It receives an argument string → if no quoting is needed, returns it unchanged → otherwise wraps it in quotes and escapes backslashes and quotation marks correctly → returns the safe command-line text.

**Call relations**: `run_setup_exe` uses this when launching the elevated helper through Windows ShellExecute, which expects parameters as a single string.

*Call graph*: called by 1 (run_setup_exe); 1 external calls (from).


##### `find_setup_exe`  (lines 665–672)

```
fn find_setup_exe() -> PathBuf
```

**Purpose**: Locates the setup helper executable. It first looks beside the current packaged executable, then falls back to a plain filename.

**Data flow**: It asks the operating system for the current executable path → tries to resolve the bundled setup helper near it → if found, returns that path → otherwise returns `codex-windows-sandbox-setup.exe`.

**Call relations**: Both refresh and full setup use this before launching the helper. It delegates package-layout knowledge to `find_setup_exe_for_current_exe`.

*Call graph*: calls 1 internal fn (find_setup_exe_for_current_exe); called by 2 (run_setup_exe, run_setup_refresh_inner); 2 external calls (from, current_exe).


##### `find_setup_exe_for_current_exe`  (lines 674–676)

```
fn find_setup_exe_for_current_exe(exe: &Path) -> Option<PathBuf>
```

**Purpose**: Looks up the setup helper relative to a known current executable path. This supports packaged installs where helper binaries live in a resources directory.

**Data flow**: It receives an executable path → asks the helper-materialization module for the bundled path to `codex-windows-sandbox-setup.exe` → returns that path if it exists according to that lookup.

**Call relations**: `find_setup_exe` calls this in normal operation, and a test verifies the expected package resource layout.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); called by 2 (find_setup_exe, setup_exe_lookup_checks_package_resource_dir_for_bin_exe).


##### `report_helper_failure`  (lines 678–695)

```
fn report_helper_failure(
    codex_home: &Path,
    cleared_report: bool,
    exit_code: Option<i32>,
) -> anyhow::Error
```

**Purpose**: Turns a failed setup-helper exit into a useful structured error. If the helper wrote a fresh error report, this function prefers that detailed report.

**Data flow**: It receives Codex home, whether the old report was cleared before launch, and the helper exit code → if clearing failed, returns a generic nonzero-exit error to avoid trusting stale data → otherwise reads `setup_error.json` → returns the helper’s reported failure, a generic exit failure, or a report-read failure.

**Call relations**: Refresh setup and full setup call this whenever the helper exits unsuccessfully. Tests verify both fresh-report and stale-report behavior.

*Call graph*: calls 3 internal fn (from_report, failure, read_setup_error_report); called by 2 (run_setup_exe, run_setup_refresh_inner); 2 external calls (new, format!).


##### `verify_setup_completed`  (lines 697–706)

```
fn verify_setup_completed(codex_home: &Path) -> Result<()>
```

**Purpose**: Checks that a supposedly successful helper run actually left the expected setup artifacts behind. This catches silent or partial helper failures.

**Data flow**: It receives Codex home → asks identity/setup code whether sandbox setup is complete → returns success if complete, otherwise returns a structured incomplete-setup error.

**Call relations**: `run_setup_exe` calls this after helper success. A test confirms missing artifacts are treated as failure.

*Call graph*: calls 2 internal fn (sandbox_setup_is_complete, failure); called by 2 (run_setup_exe, setup_completion_requires_ready_artifacts).


##### `run_setup_exe`  (lines 708–819)

```
fn run_setup_exe(
    payload: &ElevationPayload,
    needs_elevation: bool,
    codex_home: &Path,
) -> Result<()>
```

**Purpose**: Launches the setup helper with the prepared payload, either normally or through Windows administrator elevation. It waits for the helper and validates that setup really completed.

**Data flow**: It receives a payload, a flag saying whether elevation is needed, and Codex home → serializes and base64-encodes the payload → clears old error reports → if no elevation is needed, runs the helper hidden as a child process → if elevation is needed, uses Windows ShellExecute with the `runas` verb and waits for that process → on nonzero exit, reads helper error details → on zero exit, verifies setup completion and clears reports → returns success or a structured error.

**Call relations**: `run_elevated_setup` and provisioning setup call this after building their payloads. It uses executable lookup, argument quoting, logging, helper-failure reporting, and completion verification.

*Call graph*: calls 9 internal fn (log_note, find_setup_exe, quote_arg, report_helper_failure, sandbox_dir, verify_setup_completed, clear_setup_error_report, failure, to_wide); called by 2 (run_elevated_provisioning_setup, run_elevated_setup); 7 external calls (null, new, format!, to_string, zeroed, CloseHandle, GetLastError).


##### `run_elevated_setup`  (lines 821–866)

```
fn run_elevated_setup(
    request: SandboxSetupRequest<'_>,
    overrides: SetupRootOverrides,
) -> Result<()>
```

**Purpose**: Performs the full sandbox setup path for normal use. It builds the complete setup payload and asks for administrator elevation only if the current process does not already have it.

**Data flow**: It receives a setup request and root overrides → checks permission enforceability → creates the sandbox state directory → builds read/write and deny paths → chooses network identity and offline proxy settings → fills an elevation payload with account names, folders, telemetry settings, and user name → checks current elevation → launches the setup helper through `run_setup_exe` → returns success or error.

**Call relations**: Higher-level credential/setup code calls this when the machine needs full sandbox preparation. It combines most helpers in this file into one setup operation.

*Call graph*: calls 8 internal fn (from_permissions, build_payload_deny_read_paths, build_payload_deny_write_paths, build_payload_roots, is_elevated, offline_proxy_settings_from_env, run_setup_exe, sandbox_dir); called by 1 (require_logon_sandbox_creds); 4 external calls (bail!, global_statsig_metrics_settings, var, create_dir_all).


##### `run_elevated_provisioning_setup`  (lines 868–905)

```
fn run_elevated_provisioning_setup(codex_home: &Path, real_user: &str) -> Result<()>
```

**Purpose**: Runs a provisioning-only setup mode for pre-creating sandbox resources. Unlike normal setup, it requires the caller to already be running as administrator.

**Data flow**: It receives Codex home and the real user name → creates the sandbox directory → checks administrator status → if not elevated, returns an elevation-required error → builds a minimal provisioning payload with no read/write roots → runs the helper without requesting elevation → returns success or error.

**Call relations**: This is a specialized entry point for provisioning flows. It shares the same helper launcher as full setup but uses `SetupMode::ProvisionOnly`.

*Call graph*: calls 4 internal fn (is_elevated, run_setup_exe, sandbox_dir, failure); 4 external calls (to_path_buf, new, global_statsig_metrics_settings, create_dir_all).


##### `build_payload_roots`  (lines 907–946)

```
fn build_payload_roots(
    request: &SandboxSetupRequest<'_>,
    overrides: &SetupRootOverrides,
) -> (Vec<PathBuf>, Vec<PathBuf>)
```

**Purpose**: Builds the read and write root lists that go into the setup-helper payload. It also makes sure a folder is not redundantly listed as read-only when it is already writable.

**Data flow**: It receives a setup request and overrides → computes final write roots → uses explicit read roots if supplied, while still preserving helper and optional platform roots, or gathers reads from permissions otherwise → expands and filters user-profile paths and SSH-related sensitive paths → removes any read root that is also a write root → returns `(read_roots, write_roots)`.

**Call relations**: Both refresh and elevated setup call this before creating payloads. Several tests confirm override behavior and matching with effective write roots.

*Call graph*: calls 8 internal fn (canonical_existing, effective_write_roots_for_setup, expand_user_profile_root, filter_ssh_config_dependency_roots, filter_user_profile_root, filter_user_profile_root_exclusions, gather_helper_read_roots, gather_read_roots); called by 5 (run_elevated_setup, run_setup_refresh_inner, build_payload_roots_preserves_helper_roots_when_read_override_is_provided, build_payload_roots_replaces_full_read_policy_when_read_override_is_provided, effective_write_roots_match_payload_filtering_for_overrides).


##### `build_payload_deny_write_paths`  (lines 948–964)

```
fn build_payload_deny_write_paths(
    request: &SandboxSetupRequest<'_>,
    explicit_deny_write_paths: Option<Vec<PathBuf>>,
) -> Vec<PathBuf>
```

**Purpose**: Builds the list of paths that must not be writable even inside otherwise writable roots. This protects nested sensitive folders such as repository metadata or Codex control folders.

**Data flow**: It receives the setup request and optional explicit deny-write paths → computes deny paths implied by the permission policy → canonicalizes explicit deny paths → appends policy deny paths → returns the combined list.

**Call relations**: Refresh and elevated setup include this list in the helper payload so the helper can apply more precise write blocks.

*Call graph*: calls 1 internal fn (compute_allow_paths_for_permissions); called by 2 (run_elevated_setup, run_setup_refresh_inner).


##### `build_payload_deny_read_paths`  (lines 966–970)

```
fn build_payload_deny_read_paths(explicit_deny_read_paths: Option<Vec<PathBuf>>) -> Vec<PathBuf>
```

**Purpose**: Builds the list of paths that must not be readable. It preserves the caller’s spelling instead of canonicalizing, because the access-control layer may need both visible and resolved path forms.

**Data flow**: It receives optional explicit deny-read paths → returns that list or an empty list if none was provided.

**Call relations**: Refresh and elevated setup pass this directly into the setup payload. A test confirms explicit paths, including missing future paths, are preserved.

*Call graph*: called by 2 (run_elevated_setup, run_setup_refresh_inner).


##### `expand_user_profile_root`  (lines 972–977)

```
fn expand_user_profile_root(roots: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Replaces a whole `USERPROFILE` root with its top-level children when possible. This avoids granting broad access to sensitive profile folders by accident.

**Data flow**: It receives a root list → reads the `USERPROFILE` environment variable → if unavailable, returns the list unchanged → otherwise delegates to `expand_user_profile_root_for` → returns the expanded list.

**Call relations**: Payload root building and effective write-root calculation call this before later filters remove secret profile children.

*Call graph*: calls 1 internal fn (expand_user_profile_root_for); called by 2 (build_payload_roots, effective_write_roots_for_permissions); 2 external calls (new, var).


##### `expand_user_profile_root_for`  (lines 979–993)

```
fn expand_user_profile_root_for(roots: Vec<PathBuf>, user_profile: &Path) -> Vec<PathBuf>
```

**Purpose**: Performs user-profile expansion for a specific profile path. This makes the behavior testable without relying on the process environment.

**Data flow**: It receives roots and a user profile path → compares paths using canonical path keys → replaces any root equal to the profile with the profile’s top-level entries → sorts and deduplicates by canonical key → returns the expanded roots.

**Call relations**: `expand_user_profile_root` calls this in production, and tests call it directly to verify profile-root replacement.

*Call graph*: calls 2 internal fn (canonical_path_key, profile_read_roots); called by 1 (expand_user_profile_root); 1 external calls (new).


##### `filter_user_profile_root`  (lines 995–1002)

```
fn filter_user_profile_root(mut roots: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Removes the whole user profile root from a root list. The setup code prefers individual profile children so sensitive top-level folders can be excluded.

**Data flow**: It receives roots → reads `USERPROFILE` → if unavailable, returns roots unchanged → otherwise computes the profile’s canonical key and removes exact matches → returns the filtered list.

**Call relations**: Both read-root payload construction and effective write-root calculation call this after expansion as a safety net.

*Call graph*: calls 1 internal fn (canonical_path_key); called by 2 (build_payload_roots, effective_write_roots_for_permissions); 2 external calls (new, var).


##### `filter_user_profile_root_exclusions`  (lines 1004–1011)

```
fn filter_user_profile_root_exclusions(mut roots: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Removes roots that live under configured sensitive user-profile folders. Examples include SSH, cloud, Kubernetes, Docker, and package-manager credential directories.

**Data flow**: It receives roots → reads `USERPROFILE` → if unavailable, returns roots unchanged → otherwise removes any path identified by `is_user_profile_root_exclusion` → returns the filtered list.

**Call relations**: Read and write root preparation call this to prevent broad profile permissions from exposing credential folders.

*Call graph*: called by 2 (build_payload_roots, effective_write_roots_for_permissions); 2 external calls (new, var).


##### `is_user_profile_root_exclusion`  (lines 1013–1031)

```
fn is_user_profile_root_exclusion(root: &Path, user_profile: &Path) -> bool
```

**Purpose**: Checks whether a path is inside one of the configured sensitive top-level user-profile folders. It is the yes/no test behind profile exclusion filtering.

**Data flow**: It receives a candidate root and user profile path → converts both to comparable canonical keys → finds the first child name under the profile → compares it case-insensitively with the exclusion list → returns true if it should be blocked.

**Call relations**: The profile exclusion filter uses this logic, and tests call it directly to confirm that folders like `.ssh` and `.tsh` are blocked while ordinary folders are not.

*Call graph*: calls 1 internal fn (canonical_path_key); 1 external calls (format!).


##### `filter_ssh_config_dependency_roots`  (lines 1033–1041)

```
fn filter_ssh_config_dependency_roots(mut roots: Vec<PathBuf>) -> Vec<PathBuf>
```

**Purpose**: Removes roots that are referenced by SSH configuration, such as included config files or identity key locations. This prevents sandbox access to SSH secrets even when they sit outside `.ssh`.

**Data flow**: It receives roots → reads `USERPROFILE` → if unavailable, returns roots unchanged → gathers SSH config dependency paths → removes any root whose top-level profile child matches a dependency’s top-level child → returns the filtered list.

**Call relations**: Read and write root preparation call this after general profile exclusions. It uses SSH dependency discovery from another module.

*Call graph*: calls 1 internal fn (ssh_config_dependency_paths); called by 2 (build_payload_roots, effective_write_roots_for_permissions); 2 external calls (new, var).


##### `is_ssh_config_dependency_root`  (lines 1043–1056)

```
fn is_ssh_config_dependency_root(
    root: &Path,
    user_profile: &Path,
    dependency_paths: &[PathBuf],
) -> bool
```

**Purpose**: Checks whether a root corresponds to a top-level user-profile child used by SSH configuration dependencies. This catches paths related to keys or included config files.

**Data flow**: It receives a root, user profile, and dependency paths → extracts the root’s first child under the profile → compares it with each dependency’s first child under the profile → returns true if any match case-insensitively.

**Call relations**: `filter_ssh_config_dependency_roots` uses this predicate while trimming root lists. Tests call it directly with synthetic SSH config dependencies.

*Call graph*: calls 1 internal fn (user_profile_child_name); 1 external calls (iter).


##### `user_profile_child_name`  (lines 1058–1068)

```
fn user_profile_child_name(path: &Path, user_profile: &Path) -> Option<String>
```

**Purpose**: Extracts the first path segment under a user profile. For example, it turns a path under `C:\Users\me\.keys\id` into `.keys`.

**Data flow**: It receives a path and user profile → canonicalizes both into comparable string keys → removes the profile prefix from the path → returns the first non-empty child segment, or nothing if the path is outside the profile.

**Call relations**: `is_ssh_config_dependency_root` uses this for both candidate roots and dependency paths so it can compare top-level profile children.

*Call graph*: calls 1 internal fn (canonical_path_key); called by 1 (is_ssh_config_dependency_root); 1 external calls (format!).


##### `filter_sensitive_write_roots`  (lines 1070–1093)

```
fn filter_sensitive_write_roots(mut roots: Vec<PathBuf>, codex_home: &Path) -> Vec<PathBuf>
```

**Purpose**: Removes Codex-controlled folders from writable roots. This stops sandboxed commands from tampering with sandbox state, helper binaries, or stored secrets.

**Data flow**: It receives writable roots and Codex home → computes canonical keys for Codex home, `.sandbox`, `.sandbox-bin`, and `.sandbox-secrets` plus their descendants → removes any root equal to or inside those protected areas → returns the remaining roots.

**Call relations**: `effective_write_roots_for_permissions` calls this as the final safety filter. It depends on the path helpers for the protected folder locations.

*Call graph*: calls 4 internal fn (canonical_path_key, sandbox_bin_dir, sandbox_dir, sandbox_secrets_dir); called by 1 (effective_write_roots_for_permissions); 1 external calls (format!).


##### `tests::canonical_windows_platform_default_roots`  (lines 1126–1131)

```
fn canonical_windows_platform_default_roots() -> Vec<PathBuf>
```

**Purpose**: Builds the normalized version of the default Windows read roots for assertions. It keeps tests consistent with production canonicalization.

**Data flow**: It reads the constant list of platform roots → canonicalizes each when possible → returns the resulting vector.

**Call relations**: Several tests use this helper when checking whether platform roots are present or absent in generated read-root lists.


##### `tests::setup_completion_requires_ready_artifacts`  (lines 1134–1143)

```
fn setup_completion_requires_ready_artifacts()
```

**Purpose**: Checks that setup is not considered complete when required artifacts are missing. This protects against false success after a helper run.

**Data flow**: It creates a temporary Codex home → calls `verify_setup_completed` → expects an error → checks that the error code is the incomplete-setup code.

**Call relations**: This test exercises the same completion check that `run_setup_exe` uses after the helper exits successfully.

*Call graph*: calls 1 internal fn (verify_setup_completed); 2 external calls (new, assert_eq!).


##### `tests::permissions_for`  (lines 1145–1154)

```
fn permissions_for(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
    ) -> ResolvedWindowsSandboxPermissions
```

**Purpose**: Creates resolved Windows sandbox permissions for tests. It hides the conversion boilerplate so each test can focus on root behavior.

**Data flow**: It receives a permission profile and workspace roots → converts them with the production resolver → returns the resolved permissions or fails the test.

**Call relations**: Many root-building tests call this before invoking read/write root functions.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots).


##### `tests::workspace_roots_for`  (lines 1156–1158)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Wraps one absolute filesystem path as the workspace-root list expected by the permission resolver. It is a small test convenience.

**Data flow**: It receives a root path → converts it to an absolute workspace root type → returns a one-item vector.

**Call relations**: Permission-related tests use this before calling `permissions_for`.

*Call graph*: 1 external calls (vec!).


##### `tests::workspace_write_profile`  (lines 1160–1171)

```
fn workspace_write_profile(
        writable_roots: &[AbsolutePathBuf],
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    ) -> PermissionProfile
```

**Purpose**: Builds a workspace-write permission profile for tests. It lets tests vary writable roots and temporary-directory exclusions without repeating profile construction.

**Data flow**: It receives writable roots and two exclusion flags → creates a workspace-write profile with restricted networking → returns that profile.

**Call relations**: Write-root tests call this, then pass the result to `permissions_for`.

*Call graph*: calls 1 internal fn (workspace_write_with).


##### `tests::report_helper_failure_uses_setup_error_report_when_clear_succeeded`  (lines 1174–1200)

```
fn report_helper_failure_uses_setup_error_report_when_clear_succeeded()
```

**Purpose**: Verifies that a fresh helper error report is used when the helper fails. This ensures users see the real helper-side reason.

**Data flow**: It writes a setup error report in a temporary Codex home → calls `report_helper_failure` with `cleared_report` true → extracts the structured failure → asserts it matches the report contents.

**Call relations**: This test covers the error-report branch used by both refresh and elevated setup after helper failure.

*Call graph*: calls 2 internal fn (extract_failure, write_setup_error_report); 3 external calls (new, assert_eq!, report_helper_failure).


##### `tests::report_helper_failure_ignores_setup_error_report_when_clear_failed`  (lines 1203–1229)

```
fn report_helper_failure_ignores_setup_error_report_when_clear_failed()
```

**Purpose**: Verifies that stale setup reports are ignored when the old report could not be cleared. This prevents misleading errors from previous runs.

**Data flow**: It writes a report that should be considered stale → calls `report_helper_failure` with `cleared_report` false → checks that the returned failure is a generic nonzero-exit error.

**Call relations**: This protects the safety logic inside `report_helper_failure`.

*Call graph*: calls 2 internal fn (extract_failure, write_setup_error_report); 3 external calls (new, assert_eq!, report_helper_failure).


##### `tests::setup_refresh_skips_profiles_without_managed_filesystem_permissions`  (lines 1232–1266)

```
fn setup_refresh_skips_profiles_without_managed_filesystem_permissions()
```

**Purpose**: Checks that refresh setup quietly skips permission profiles this Windows sandbox setup code does not manage. Unsupported profiles should not accidentally launch setup.

**Data flow**: It creates temporary workspace and Codex home paths → tries disabled and external profiles → calls both refresh entry points → expects success without setup work.

**Call relations**: This test covers the early-return behavior in `run_setup_refresh` and `run_setup_refresh_with_extra_read_roots`.

*Call graph*: 7 external calls (new, new, create_dir_all, run_setup_refresh, run_setup_refresh_with_extra_read_roots, vec!, workspace_roots_for).


##### `tests::loopback_proxy_url_parsing_supports_common_forms`  (lines 1269–1282)

```
fn loopback_proxy_url_parsing_supports_common_forms()
```

**Purpose**: Confirms that local proxy URLs in common formats are parsed correctly. This includes localhost, IPv4 loopback, and IPv6 loopback with credentials.

**Data flow**: It passes several proxy URL strings to the parser → compares returned ports with expected values.

**Call relations**: This test directly exercises `loopback_proxy_port_from_url`, which feeds offline firewall proxy settings.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::setup_exe_lookup_checks_package_resource_dir_for_bin_exe`  (lines 1285–1300)

```
fn setup_exe_lookup_checks_package_resource_dir_for_bin_exe()
```

**Purpose**: Verifies that the setup helper can be found in the packaged resources directory when Codex runs from a package bin directory.

**Data flow**: It creates a fake package layout with bin and resources folders → writes fake executable files → calls `find_setup_exe_for_current_exe` → asserts the resource helper path is returned.

**Call relations**: This test protects the helper lookup used by `find_setup_exe` before launching setup.

*Call graph*: calls 1 internal fn (find_setup_exe_for_current_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::loopback_proxy_url_parsing_rejects_non_loopback_and_zero_port`  (lines 1303–1310)

```
fn loopback_proxy_url_parsing_rejects_non_loopback_and_zero_port()
```

**Purpose**: Confirms that proxy parsing rejects remote hosts, zero ports, and strings without a URL scheme. This avoids opening firewall rules for invalid proxy settings.

**Data flow**: It passes invalid or unsafe proxy strings to the parser → expects no port to be returned.

**Call relations**: This directly tests the defensive side of `loopback_proxy_port_from_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::proxy_ports_from_env_dedupes_and_sorts`  (lines 1313–1330)

```
fn proxy_ports_from_env_dedupes_and_sorts()
```

**Purpose**: Checks that proxy ports from environment variables are unique and sorted. Stable output prevents unnecessary setup churn.

**Data flow**: It builds an environment map with duplicate local proxy ports, one different local port, and one remote proxy → calls `proxy_ports_from_env` → expects only sorted local ports.

**Call relations**: This test covers the helper used by `offline_proxy_settings_from_env`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::offline_proxy_settings_ignore_proxy_env_when_online_identity_selected`  (lines 1333–1351)

```
fn offline_proxy_settings_ignore_proxy_env_when_online_identity_selected()
```

**Purpose**: Verifies that online sandboxes ignore offline proxy firewall settings. Proxy environment variables should not affect online identity setup.

**Data flow**: It builds an environment map with proxy and local-binding settings → calls `offline_proxy_settings_from_env` with online identity → expects empty ports and local binding false.

**Call relations**: This test covers the online branch of `offline_proxy_settings_from_env`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::offline_proxy_settings_capture_proxy_ports_and_local_binding_for_offline_identity`  (lines 1354–1376)

```
fn offline_proxy_settings_capture_proxy_ports_and_local_binding_for_offline_identity()
```

**Purpose**: Verifies that offline sandboxes capture proxy ports and the local-binding flag from the environment. These values become firewall setup inputs.

**Data flow**: It builds an environment map with two loopback proxy URLs and `CODEX_NETWORK_ALLOW_LOCAL_BINDING=1` → calls `offline_proxy_settings_from_env` with offline identity → expects both ports and local binding true.

**Call relations**: This test covers the offline branch used by refresh and elevated setup payload construction.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::setup_marker_request_mismatch_reason_ignores_proxy_drift_for_online_identity`  (lines 1379–1397)

```
fn setup_marker_request_mismatch_reason_ignores_proxy_drift_for_online_identity()
```

**Purpose**: Checks that proxy-setting differences do not force a mismatch when the online identity is selected. Offline firewall settings are irrelevant in that case.

**Data flow**: It creates a marker with one set of proxy settings and a desired set with different values → calls `request_mismatch_reason` with online identity → expects no mismatch reason.

**Call relations**: This test protects the online early-return in `SetupMarker::request_mismatch_reason`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::setup_marker_request_mismatch_reason_reports_offline_firewall_drift`  (lines 1400–1421)

```
fn setup_marker_request_mismatch_reason_reports_offline_firewall_drift()
```

**Purpose**: Checks that changed offline proxy firewall settings are reported as a setup mismatch. This tells callers why setup needs refreshing.

**Data flow**: It creates a marker and different desired offline settings → calls `request_mismatch_reason` with offline identity → expects a detailed mismatch message.

**Call relations**: This test covers the comparison path in `SetupMarker::request_mismatch_reason`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::profile_read_roots_excludes_configured_top_level_entries`  (lines 1424–1444)

```
fn profile_read_roots_excludes_configured_top_level_entries()
```

**Purpose**: Verifies that profile read expansion leaves ordinary files and folders but removes configured sensitive folders. This is central to not exposing credentials.

**Data flow**: It creates a temporary profile with allowed and excluded children → calls `profile_read_roots` → compares the returned set with only the allowed entries.

**Call relations**: This test directly checks `profile_read_roots`, which is used by full-read gathering and profile expansion.

*Call graph*: calls 1 internal fn (profile_read_roots); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::profile_read_roots_falls_back_to_profile_root_when_enumeration_fails`  (lines 1447–1454)

```
fn profile_read_roots_falls_back_to_profile_root_when_enumeration_fails()
```

**Purpose**: Checks the fallback behavior when a profile directory cannot be listed. The function should still return something usable instead of failing setup.

**Data flow**: It points at a missing profile directory → calls `profile_read_roots` → expects the missing profile path itself as the only root.

**Call relations**: This covers the error-tolerant branch of `profile_read_roots`.

*Call graph*: calls 1 internal fn (profile_read_roots); 2 external calls (new, assert_eq!).


##### `tests::is_user_profile_root_exclusion_blocks_configured_children`  (lines 1457–1491)

```
fn is_user_profile_root_exclusion_blocks_configured_children()
```

**Purpose**: Verifies that sensitive profile children are recognized even when the root points inside them. Ordinary profile folders and unrelated roots should not be blocked.

**Data flow**: It creates a temporary profile with documents, app data, `.ssh`, `.tsh`, and another root → calls the exclusion predicate on each → checks true only for configured sensitive children.

**Call relations**: This tests the predicate used by `filter_user_profile_root_exclusions`.

*Call graph*: 3 external calls (new, assert!, create_dir_all).


##### `tests::is_ssh_config_dependency_root_blocks_config_dependencies`  (lines 1494–1537)

```
fn is_ssh_config_dependency_root_blocks_config_dependencies()
```

**Purpose**: Verifies that paths referenced by SSH config are treated as sensitive roots. This catches keys or included config files outside the usual `.ssh` folder.

**Data flow**: It writes an SSH config with an identity file and included config → gathers dependency paths → calls the dependency-root predicate on several roots → expects dependency-related roots to be blocked.

**Call relations**: This tests `is_ssh_config_dependency_root`, which is used by SSH dependency filtering.

*Call graph*: 5 external calls (new, assert!, create_dir_all, write, ssh_config_dependency_paths).


##### `tests::expand_user_profile_root_for_replaces_profile_root_with_children`  (lines 1540–1558)

```
fn expand_user_profile_root_for_replaces_profile_root_with_children()
```

**Purpose**: Checks that a whole profile root is replaced by its children while unrelated roots are kept. This supports safer, more precise profile access.

**Data flow**: It creates a temporary profile with child folders and another root → calls `expand_user_profile_root_for` with the profile and other root → compares the resulting set with the children plus other root.

**Call relations**: This test covers the core behavior behind `expand_user_profile_root`.

*Call graph*: 5 external calls (new, assert_eq!, create_dir_all, expand_user_profile_root_for, vec!).


##### `tests::expanded_write_roots_still_drop_protected_codex_home`  (lines 1561–1577)

```
fn expanded_write_roots_still_drop_protected_codex_home()
```

**Purpose**: Verifies that even after expanding a user profile, Codex home is not left writable. This protects sandbox control files from tampering.

**Data flow**: It creates a profile containing Codex home and Documents → expands the profile root → removes the profile root and sensitive exclusions → applies `filter_sensitive_write_roots` → expects only Documents to remain.

**Call relations**: This combines profile expansion with the final sensitive-write-root filter.

*Call graph*: 7 external calls (new, assert_eq!, create_dir_all, canonical_path_key, expand_user_profile_root_for, filter_sensitive_write_roots, vec!).


##### `tests::gather_read_roots_includes_helper_bin_dir`  (lines 1580–1594)

```
fn gather_read_roots_includes_helper_bin_dir()
```

**Purpose**: Checks that readable roots always include the helper binary directory. Without this, sandboxed commands might not be able to run required helper tools.

**Data flow**: It creates temporary Codex and workspace folders → resolves read-only permissions → calls `gather_read_roots` → asserts the canonical helper directory is present.

**Call relations**: This protects the `gather_helper_read_roots` inclusion inside `gather_read_roots`.

*Call graph*: calls 3 internal fn (read_only, helper_bin_dir, gather_read_roots); 7 external calls (new, new, assert!, canonicalize, create_dir_all, permissions_for, workspace_roots_for).


##### `tests::workspace_write_roots_remain_readable`  (lines 1597–1620)

```
fn workspace_write_roots_remain_readable()
```

**Purpose**: Verifies that writable workspace roots are also included in readable roots where needed. A command generally must read files it is allowed to write.

**Data flow**: It creates a workspace and extra writable root → builds workspace-write permissions → calls `gather_read_roots` → asserts the writable root is included.

**Call relations**: This covers read-root behavior for permission-derived writable roots.

*Call graph*: calls 1 internal fn (gather_read_roots); 9 external calls (new, new, assert!, canonicalize, create_dir_all, vec!, permissions_for, workspace_roots_for, workspace_write_profile).


##### `tests::build_payload_roots_preserves_helper_roots_when_read_override_is_provided`  (lines 1623–1667)

```
fn build_payload_roots_preserves_helper_roots_when_read_override_is_provided()
```

**Purpose**: Checks that explicit read-root overrides do not remove required helper roots. It also verifies optional platform defaults are included when requested.

**Data flow**: It creates temporary roots → calls `build_payload_roots` with an explicit readable root and platform-default inclusion → asserts helper and explicit roots are present, command cwd is not added automatically, write roots are empty, and platform defaults are present.

**Call relations**: This tests the override branch of `build_payload_roots`.

*Call graph*: calls 3 internal fn (read_only, helper_bin_dir, build_payload_roots); 9 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, vec!, permissions_for, workspace_roots_for).


##### `tests::build_payload_roots_replaces_full_read_policy_when_read_override_is_provided`  (lines 1670–1714)

```
fn build_payload_roots_replaces_full_read_policy_when_read_override_is_provided()
```

**Purpose**: Checks that explicit read roots replace the normal legacy read set when platform defaults are not requested. This gives callers precise control.

**Data flow**: It creates temporary roots → calls `build_payload_roots` with explicit read roots and no platform defaults → asserts helper and explicit roots are present, command cwd and platform roots are not automatically added, and write roots are empty.

**Call relations**: This protects the precise-override behavior in `build_payload_roots`.

*Call graph*: calls 3 internal fn (read_only, helper_bin_dir, build_payload_roots); 9 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, vec!, permissions_for, workspace_roots_for).


##### `tests::effective_write_roots_match_payload_filtering_for_overrides`  (lines 1717–1773)

```
fn effective_write_roots_match_payload_filtering_for_overrides()
```

**Purpose**: Verifies that the public effective-write-root helper and payload builder apply the same filtering to overridden write roots. This prevents mismatch between setup and runtime behavior.

**Data flow**: It creates workspace, extra, Codex home, and sandbox-root folders → supplies all as write overrides → computes effective write roots and payload write roots → asserts they match and exclude protected Codex folders.

**Call relations**: This connects `effective_write_roots_for_setup`, `build_payload_roots`, and `filter_sensitive_write_roots`.

*Call graph*: calls 1 internal fn (build_payload_roots); 12 external calls (new, new, assert!, assert_eq!, canonicalize, create_dir_all, effective_write_roots_for_setup, sandbox_dir, vec!, permissions_for (+2 more)).


##### `tests::effective_write_roots_use_runtime_workspace_roots_for_workspace_root`  (lines 1776–1804)

```
fn effective_write_roots_use_runtime_workspace_roots_for_workspace_root()
```

**Purpose**: Checks that workspace-write permissions use the runtime workspace root rather than just the command’s subdirectory. This gives the sandbox write access to the intended workspace scope.

**Data flow**: It creates a workspace root with a command subdirectory → builds workspace-write permissions → calls `effective_write_roots_for_setup` → expects the canonical workspace root.

**Call relations**: This tests permission-derived write-root gathering through the effective-write-root path.

*Call graph*: 8 external calls (new, new, assert_eq!, create_dir_all, effective_write_roots_for_setup, permissions_for, workspace_roots_for, workspace_write_profile).


##### `tests::payload_deny_write_paths_merge_explicit_and_protected_children`  (lines 1807–1848)

```
fn payload_deny_write_paths_merge_explicit_and_protected_children()
```

**Purpose**: Verifies that deny-write paths include both caller-specified paths and protected paths computed from permissions. This keeps sensitive nested folders blocked.

**Data flow**: It creates workspace and extra writable roots with protected child folders plus an explicit deny path → builds permissions and a setup request → calls `build_payload_deny_write_paths` → compares the result as a set.

**Call relations**: This tests the merge behavior used by refresh and elevated setup payloads.

*Call graph*: 9 external calls (new, new, assert_eq!, create_dir_all, build_payload_deny_write_paths, vec!, permissions_for, workspace_roots_for, workspace_write_profile).


##### `tests::full_read_roots_preserve_legacy_platform_defaults`  (lines 1851–1872)

```
fn full_read_roots_preserve_legacy_platform_defaults()
```

**Purpose**: Checks that full-read root gathering still includes the default Windows platform folders. This preserves expected compatibility for broad-read policies.

**Data flow**: It creates temporary Codex and workspace folders → resolves read-only permissions → calls `gather_full_read_roots_for_permissions` → asserts all canonical platform defaults are present.

**Call relations**: This directly exercises the full-read gatherer used through `gather_read_roots`.

*Call graph*: calls 2 internal fn (read_only, gather_full_read_roots_for_permissions); 6 external calls (new, new, assert!, create_dir_all, permissions_for, workspace_roots_for).


##### `tests::build_payload_deny_read_paths_preserves_explicit_paths`  (lines 1875–1885)

```
fn build_payload_deny_read_paths_preserves_explicit_paths()
```

**Purpose**: Verifies that deny-read paths are returned exactly as provided, including paths that do not exist yet. This supports access-control planning for future files or path aliases.

**Data flow**: It creates one existing path and one missing path → calls `build_payload_deny_read_paths` with both → expects the same paths in the same order.

**Call relations**: This protects the intentionally simple behavior of `build_payload_deny_read_paths`.

*Call graph*: 3 external calls (new, assert_eq!, write).


### `windows-sandbox-rs/src/identity.rs`

`orchestration` · `before sandbox launch and during credential refresh after login failure`

The Windows sandbox needs a real Windows user account to log in as. This file is the gatekeeper for that identity. It looks in the project’s Codex home folder for setup artifacts: a marker file that says what setup was performed, and a users file that stores the sandbox accounts. Think of these files like a reservation card and a locked key box: the marker says the room was prepared, and the users file holds the key needed to enter it.

The file first checks whether the setup files exist and match the current expected version. If they do, it chooses either the offline or online sandbox account depending on the requested permissions and proxy settings. The saved password is base64-decoded and then decrypted with Windows DPAPI, the Data Protection API, which is Windows’ built-in way to protect secrets on disk.

If anything is missing, outdated, or mismatched, this file asks the setup helper to run again with elevation, meaning administrator-level permission. After that, it always asks the setup helper to refresh file access rules for the current command’s read and write paths. This is important because the sandbox identity may be valid, but the set of folders it is allowed to touch can change from run to run.

It also has a recovery path for failed logins: delete the saved users file and force setup to produce fresh credentials.

#### Function details

##### `sandbox_setup_is_complete`  (lines 42–48)

```
fn sandbox_setup_is_complete(codex_home: &Path) -> bool
```

**Purpose**: This is a quick readiness check for callers that only need to know whether sandbox setup appears to be present and current. It does not do the deeper runtime checks for network and proxy settings.

**Data flow**: It receives the Codex home folder path. It reads the setup marker and users records from disk through helper functions, checks whether both match the expected setup version, and returns true only when both look current. It does not change any files.

**Call relations**: A higher-level setup verification flow calls this when it wants a simple yes-or-no answer. Internally, it relies on the same marker and users files that the later credential-loading path uses more carefully.

*Call graph*: called by 1 (verify_setup_completed); 1 external calls (matches!).


##### `load_marker`  (lines 50–73)

```
fn load_marker(codex_home: &Path) -> Result<Option<SetupMarker>>
```

**Purpose**: This reads the sandbox setup marker file, which records what kind of setup was last completed. If the file is missing, unreadable, or malformed, it quietly reports that no usable marker is available and writes a debug note.

**Data flow**: It receives the Codex home path, turns that into the marker file path, and tries to read JSON text from disk. If the text parses into a setup marker, it returns it. If the file is absent or unusable, it returns no marker instead of stopping the whole program, while logging details for debugging.

**Call relations**: Both the identity-selection path and the main credential-requirement path call this first, because the marker tells them whether the saved setup can be trusted. It hands back the marker data that later code checks for version and request compatibility.

*Call graph*: calls 2 internal fn (debug_log, setup_marker_path); called by 2 (require_logon_sandbox_creds, select_identity); 2 external calls (format!, read_to_string).


##### `load_users`  (lines 75–98)

```
fn load_users(codex_home: &Path) -> Result<Option<SandboxUsersFile>>
```

**Purpose**: This reads the file that contains the sandbox user records. Those records include the usernames and protected passwords for the online and offline sandbox identities.

**Data flow**: It receives the Codex home path, builds the users file path, and reads the JSON file from disk. If reading or parsing succeeds, it returns the users data. If the file is missing, unreadable, or invalid, it logs a debug message when useful and returns no users data.

**Call relations**: The identity-selection function calls this after the setup marker has been accepted. It supplies the raw user record that will later be chosen and decrypted.

*Call graph*: calls 2 internal fn (debug_log, sandbox_users_path); called by 1 (select_identity); 2 external calls (format!, read_to_string).


##### `remove_sandbox_users_file`  (lines 100–111)

```
fn remove_sandbox_users_file(codex_home: &Path, reason: &str) -> Result<()>
```

**Purpose**: This deletes the saved sandbox users file, usually because the stored login details failed and should no longer be trusted. Missing files are treated as already cleaned up, not as an error.

**Data flow**: It receives the Codex home path and a human-readable reason. It logs why the file is being deleted, builds the users file path, and attempts to remove it from disk. On success or if the file was already gone, it returns normally; on other deletion problems, it returns an error with the file path attached.

**Call relations**: The credential refresh flow calls this before asking for credentials again, forcing the later setup path to recreate usable user data. The tests call it directly to prove that it deletes an existing file and ignores an already-missing one.

*Call graph*: calls 2 internal fn (debug_log, sandbox_users_path); called by 3 (refresh_logon_sandbox_creds, remove_sandbox_users_file_deletes_existing_file, remove_sandbox_users_file_ignores_missing_file); 2 external calls (format!, remove_file).


##### `decode_password`  (lines 113–120)

```
fn decode_password(record: &SandboxUserRecord) -> Result<String>
```

**Purpose**: This turns a stored sandbox password back into plain text so it can be used for logon. The password is stored in two protective layers: base64 text encoding and Windows DPAPI encryption.

**Data flow**: It receives one sandbox user record. It decodes the password field from base64 text into bytes, asks DPAPI to decrypt those bytes, then converts the result into a UTF-8 string. The returned value is the usable password, or an error if any step fails.

**Call relations**: The identity-selection function calls this only after it has chosen either the online or offline user record. This keeps password decryption limited to the single identity actually needed for the upcoming sandbox run.

*Call graph*: calls 1 internal fn (unprotect); called by 1 (select_identity); 1 external calls (from_utf8).


##### `select_identity`  (lines 122–143)

```
fn select_identity(
    network_identity: SandboxNetworkIdentity,
    codex_home: &Path,
) -> Result<Option<SandboxIdentity>>
```

**Purpose**: This chooses the correct sandbox account, online or offline, from the saved setup files and returns its username and decrypted password. It refuses to use saved data unless both the marker and users file match the current setup version.

**Data flow**: It receives the desired network identity and the Codex home path. It reads and checks the setup marker, then reads and checks the users file. It selects the matching user record, decrypts that record’s password, and returns a sandbox identity. If the setup files are missing or out of date, it returns no identity rather than using unsafe stale data.

**Call relations**: The main credential function calls this after deciding which network identity is needed. It depends on the marker loader, users loader, and password decoder, and it hands back the internal identity that is later exposed as public sandbox credentials.

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

**Purpose**: This is the main function that guarantees usable sandbox login credentials before a sandbox run. If the saved setup is missing, stale, or does not match the requested permissions, it runs setup and then returns fresh credentials.

**Data flow**: It receives the resolved sandbox permissions, the command working folder, environment variables, Codex home path, optional read and write folder overrides, denied paths, and whether proxy rules are enforced. It works out which folders the sandbox must read or write, chooses the needed network identity, checks whether the existing setup marker matches that request, and tries to load the matching saved identity. If setup is needed, it logs the reason and runs the elevated setup helper. Whether setup was newly run or already present, it refreshes access rules for the current folders. Finally, it returns a public username and password pair, or an error if no valid identity can be produced.

**Call relations**: Sandbox launch preparation calls this when it needs credentials to start a restricted Windows session. It coordinates many other pieces: marker loading, identity selection, network identity choice, proxy-derived settings, elevated setup, and non-elevated access-rule refresh. The refresh function also calls it after deleting stale users.

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

**Purpose**: This is the recovery path for a sandbox login failure. It throws away the saved users file and then runs the normal credential requirement flow again, forcing credentials to be recreated or reselected.

**Data flow**: It receives the same inputs as the main credential function. First it deletes the sandbox users file with a reason saying the login failed. Then it passes all the original permission, folder, environment, and proxy information into the normal credential function. The output is a fresh username and password pair, or an error if refresh cannot succeed.

**Call relations**: The elevated sandbox session launcher calls this after a login attempt fails. It uses the file-deletion helper to invalidate stale credentials, then hands control back to the main credential orchestration function.

*Call graph*: calls 2 internal fn (remove_sandbox_users_file, require_logon_sandbox_creds); called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile).


##### `tests::remove_sandbox_users_file_deletes_existing_file`  (lines 286–295)

```
fn remove_sandbox_users_file_deletes_existing_file()
```

**Purpose**: This test proves that the cleanup helper really deletes a users file when one exists. It protects the recovery path from leaving stale credentials behind.

**Data flow**: It creates a temporary Codex home folder, builds the expected users file path, creates the parent folder, writes a dummy users file, and calls the deletion helper. Afterward, it checks that the file no longer exists.

**Call relations**: This test calls the same deletion helper used by credential refresh. It sets up a small fake filesystem situation so the helper’s normal success path can be checked without touching real sandbox data.

*Call graph*: calls 2 internal fn (remove_sandbox_users_file, sandbox_users_path); 4 external calls (new, assert!, create_dir_all, write).


##### `tests::remove_sandbox_users_file_ignores_missing_file`  (lines 298–304)

```
fn remove_sandbox_users_file_ignores_missing_file()
```

**Purpose**: This test proves that deleting a missing users file is treated as success. That matters because cleanup should be safe to run even when another step already removed the stale file.

**Data flow**: It creates a temporary Codex home folder but does not create the users file. It calls the deletion helper and then checks that the file is still absent. The expected result is no error.

**Call relations**: This test calls the cleanup helper directly to verify its forgiving behavior. That behavior is important for the credential refresh flow, which should not fail just because there was nothing to delete.

*Call graph*: calls 2 internal fn (remove_sandbox_users_file, sandbox_users_path); 2 external calls (new, assert!).


### `windows-sandbox-rs/src/acl.rs`

`domain_logic` · `sandbox permission setup, checks, and cleanup`

Windows protects files, folders, and some devices with an ACL, an access-control list. A DACL is the part of that list that says who is allowed or denied access. Each entry is an ACE, like a line on a guest list: “this user may write” or “this user may not read.” The user or group is identified by a SID, a Windows security identifier.

This file is the sandbox’s low-level toolbox for those permission lists. It can fetch a path’s DACL, scan it to see whether a SID already has a needed permission, add allow entries, add deny entries, revoke entries, and give the sandbox user access to the Windows NUL device used for output redirection.

A key idea is avoiding duplicate work. Before adding a permission, the code usually checks whether a matching ACE already exists. It also ignores “inherit-only” entries, because those apply only to children of a folder, not to the folder or file being checked right now.

Most functions are marked unsafe because they pass raw pointers to Windows APIs. The file is careful to free Windows-allocated security descriptors with LocalFree and to close handles after use. If these calls were wrong, the sandbox could leak resources or, worse, give the sandboxed process too much or too little access.

#### Function details

##### `fetch_dacl_handle`  (lines 62–97)

```
fn fetch_dacl_handle(path: &Path) -> Result<(*mut ACL, *mut c_void)>
```

**Purpose**: Opens an existing file or directory and asks Windows for its DACL, the list of allow and deny rules. Other code uses this when it needs to inspect permissions before deciding whether to change them.

**Data flow**: It receives a filesystem path. It turns that path into the wide-character text format Windows APIs expect, opens the object with permission to read its security information, asks Windows for the DACL and its security descriptor, closes the file handle, and returns pointers to those Windows-owned structures. The caller must later free the returned security descriptor.

**Call relations**: This is the front door for permission inspection in this file. path_mask_allows uses it for a one-off permission check, and ensure_allow_mask_aces_with_inheritance_impl uses it before deciding whether it needs to add new allow entries.

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

**Purpose**: Looks through a DACL and answers: does any of these SIDs already have the requested allowed permission bits? It can require either all requested bits or just any one of them.

**Data flow**: It receives a DACL pointer, a list of SID pointers, a desired permission mask, and a flag saying whether all bits are required. It reads each access entry in the DACL, skips entries that are not allow entries or that only apply to child objects, compares the entry’s SID with the provided SIDs, expands generic Windows permission names into concrete file permissions, and returns true if a matching allow entry is strong enough.

**Call relations**: path_mask_allows calls this after fetching a DACL for a path. ensure_allow_mask_aces_with_inheritance_impl calls it before adding permissions, so it does not rewrite the ACL when the needed allow rule is already present.

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

**Purpose**: Provides a safe-looking path-level wrapper around the lower-level DACL scan. It answers whether a path grants certain permissions to any of the given SIDs.

**Data flow**: It receives a path, SIDs, a desired permission mask, and the “all bits or any bit” choice. It fetches the path’s DACL, asks dacl_mask_allows to inspect it, frees the Windows security descriptor, and returns the yes-or-no result or an error if the DACL could not be fetched.

**Call relations**: Higher-level code such as path_has_world_write_allow uses this when it wants a simple permission question answered for a path. Internally, this function ties together fetch_dacl_handle and dacl_mask_allows and takes care of freeing the Windows allocation afterward.

*Call graph*: calls 2 internal fn (dacl_mask_allows, fetch_dacl_handle); called by 1 (path_has_world_write_allow); 1 external calls (LocalFree).


##### `dacl_has_write_allow_for_sid`  (lines 180–219)

```
fn dacl_has_write_allow_for_sid(p_dacl: *mut ACL, psid: *mut c_void) -> bool
```

**Purpose**: Checks whether one SID already has an allow entry that includes write permission. This is used to avoid adding another write allow entry when one is already effective.

**Data flow**: It receives a DACL pointer and one SID pointer. It reads the DACL entries, keeps only allow entries that apply to the current object, compares each entry’s SID to the requested SID, and returns true if the matching entry includes Windows’ generic file write permission.

**Call relations**: add_allow_ace calls this before changing a path’s ACL. If this check says write access is already present, add_allow_ace skips the more expensive ACL rewrite.

*Call graph*: called by 1 (add_allow_ace); 6 external calls (is_null, zeroed, null_mut, EqualSid, GetAce, GetAclInformation).


##### `dacl_has_write_deny_for_sid`  (lines 221–264)

```
fn dacl_has_write_deny_for_sid(p_dacl: *mut ACL, psid: *mut c_void) -> bool
```

**Purpose**: Checks whether one SID already has a deny entry that blocks writing, appending, changing attributes, or deleting. It helps prevent duplicate deny rules.

**Data flow**: It receives a DACL pointer and a SID pointer. It builds a combined set of write-related deny bits, scans deny entries that apply to the current object, compares SIDs, and returns true if the matching deny entry blocks any of those write-like actions.

**Call relations**: DenyAceKind::already_present calls this when the requested deny type is Write. add_deny_ace then uses that answer to decide whether it needs to add a new deny ACE.

*Call graph*: called by 1 (already_present); 6 external calls (is_null, zeroed, null_mut, EqualSid, GetAce, GetAclInformation).


##### `dacl_has_read_deny_for_sid`  (lines 266–302)

```
fn dacl_has_read_deny_for_sid(p_dacl: *mut ACL, psid: *mut c_void) -> bool
```

**Purpose**: Checks whether one SID already has a deny entry that blocks reading. It is the read-side counterpart to the write-deny check.

**Data flow**: It receives a DACL pointer and a SID pointer. It scans the DACL for deny entries that apply to the current object, compares each entry’s SID with the requested SID, and returns true if a matching entry denies generic read access.

**Call relations**: DenyAceKind::already_present calls this when the requested deny type is Read. add_deny_ace uses the result so read-deny rules are only added when missing.

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

**Purpose**: Makes sure every given SID has an allow entry with a requested permission mask and chosen inheritance behavior. It returns whether it actually had to add anything.

**Data flow**: It receives a path, a list of SIDs, a permission mask, and inheritance flags that say whether child files or folders should receive the rule. It fetches the current DACL, checks each SID with dacl_mask_allows, builds Windows explicit-access entries only for SIDs that are missing the required permission, merges those entries into a new DACL, writes the new DACL back to the path, frees temporary Windows memory, and returns true if new entries were written.

**Call relations**: ensure_allow_mask_aces_with_inheritance is the public wrapper that calls this implementation. This function is where the real work happens: it combines fetching, checking, building ACL entries, and writing the result back to Windows.

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

**Purpose**: Public wrapper for ensuring allow entries with caller-specified inheritance. It exists so other code can ask for a permission rule and control whether that rule flows down to children.

**Data flow**: It receives a path, SIDs, a permission mask, and inheritance flags. It passes them unchanged into ensure_allow_mask_aces_with_inheritance_impl and returns that function’s result.

**Call relations**: ensure_allow_mask_aces calls this with the standard file-and-folder inheritance flags. This wrapper keeps the public unsafe API small while leaving the detailed work in the implementation function.

*Call graph*: calls 1 internal fn (ensure_allow_mask_aces_with_inheritance_impl); called by 1 (ensure_allow_mask_aces).


##### `ensure_allow_mask_aces`  (lines 397–408)

```
fn ensure_allow_mask_aces(
    path: &Path,
    sids: &[*mut c_void],
    allow_mask: u32,
) -> Result<bool>
```

**Purpose**: Ensures allow entries for a set of SIDs using the normal inheritance behavior for folders. In practice, it means the permission can apply not only to the target folder but also to files and folders created underneath it.

**Data flow**: It receives a path, SIDs, and a permission mask. It adds the standard “inherit to child folders” and “inherit to child files” flags, calls ensure_allow_mask_aces_with_inheritance, and returns whether anything was added.

**Call relations**: ensure_allow_write_aces uses this to request a preselected write-capable permission set. This function is the convenience layer for the common inheritable-permission case.

*Call graph*: calls 1 internal fn (ensure_allow_mask_aces_with_inheritance); called by 1 (ensure_allow_write_aces).


##### `ensure_allow_write_aces`  (lines 415–417)

```
fn ensure_allow_write_aces(path: &Path, sids: &[*mut c_void]) -> Result<bool>
```

**Purpose**: Ensures that the given SIDs have the sandbox’s standard write-capable access to a path. This is useful when preparing a workspace or directory that the sandboxed process must be able to use.

**Data flow**: It receives a path and SIDs. It supplies the file’s predefined write-allow mask, delegates to ensure_allow_mask_aces, and returns whether any ACL entry was added.

**Call relations**: This is the simplest “make this writable for these identities” helper in the file. It hands off all checking and writing to ensure_allow_mask_aces.

*Call graph*: calls 1 internal fn (ensure_allow_mask_aces).


##### `add_allow_ace`  (lines 423–483)

```
fn add_allow_ace(path: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: Adds an allow entry that grants read, write, and execute access to one SID on a path, unless write access is already present. This supports older or simpler sandbox setup flows that need one direct allow rule.

**Data flow**: It receives a path and a SID. It reads the path’s current DACL, checks whether the SID already has write access, and if not, creates an explicit allow entry for read/write/execute with inheritance to children. It merges that entry into a new DACL, writes the DACL back to the path, frees temporary Windows memory, and returns whether it added the rule.

**Call relations**: apply_legacy_session_acl_rules calls this during legacy sandbox permission setup. Inside this file, it relies on dacl_has_write_allow_for_sid to avoid unnecessary ACL rewrites and then uses Windows ACL APIs to apply the new rule.

*Call graph*: calls 2 internal fn (dacl_has_write_allow_for_sid, to_wide); called by 1 (apply_legacy_session_acl_rules); 7 external calls (anyhow!, zeroed, null_mut, LocalFree, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW).


##### `add_deny_write_ace`  (lines 489–491)

```
fn add_deny_write_ace(path: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: Adds a deny rule that blocks one SID from writing to a path. It is a small, readable entry point for the write-deny case.

**Data flow**: It receives a path and a SID. It calls add_deny_ace with the Write deny kind and returns whether that lower-level function added a new deny entry.

**Call relations**: Higher-level permission code calls this when it needs to protect workspace subdirectories, enforce world-writable safeguards, or apply legacy session rules. It delegates the shared deny-rule construction to add_deny_ace.

*Call graph*: calls 1 internal fn (add_deny_ace); called by 3 (apply_capability_denies_for_world_writable_for_permissions, apply_legacy_session_acl_rules, protect_workspace_subdir).


##### `DenyAceKind::mask`  (lines 500–514)

```
fn mask(self) -> u32
```

**Purpose**: Translates a deny kind, Read or Write, into the exact Windows permission bits that should be denied. This keeps the meaning of each deny type in one place.

**Data flow**: It receives the enum value. For Read, it returns read-related bits; for Write, it returns write, append, attribute-change, and delete-related bits. It does not change anything outside itself.

**Call relations**: add_deny_ace calls this when building the explicit Windows ACL entry. The enum value chosen by add_deny_read_ace or add_deny_write_ace determines which mask is produced.

*Call graph*: called by 1 (add_deny_ace).


##### `DenyAceKind::already_present`  (lines 516–521)

```
fn already_present(self, p_dacl: *mut ACL, psid: *mut c_void) -> bool
```

**Purpose**: Checks whether the requested read-deny or write-deny rule already exists for a SID. This prevents adding duplicate deny entries.

**Data flow**: It receives the deny kind, a DACL pointer, and a SID pointer. If the kind is Read, it asks dacl_has_read_deny_for_sid; if the kind is Write, it asks dacl_has_write_deny_for_sid. It returns the yes-or-no answer.

**Call relations**: add_deny_ace calls this before constructing a new deny ACE. It routes the shared deny flow to the correct specialized scanner for read or write.

*Call graph*: calls 2 internal fn (dacl_has_read_deny_for_sid, dacl_has_write_deny_for_sid); called by 1 (add_deny_ace).


##### `add_deny_ace`  (lines 524–578)

```
fn add_deny_ace(path: &Path, psid: *mut c_void, kind: DenyAceKind) -> Result<bool>
```

**Purpose**: Adds an inheritable deny entry for either read or write access, unless that deny entry is already present. Deny entries are important because Windows evaluates them so they can override broader allow rules.

**Data flow**: It receives a path, a SID, and a deny kind. It reads the current DACL, checks whether the matching deny rule already exists, builds a trustee for the SID, chooses the right permission mask from the deny kind, creates a deny explicit-access entry, merges it into a new DACL, writes the DACL back to the path, frees Windows allocations, and returns whether it added the rule.

**Call relations**: add_deny_write_ace and add_deny_read_ace are the public, clearer wrappers that call this. Inside, it uses DenyAceKind::already_present for the duplicate check and DenyAceKind::mask for the exact Windows permission bits.

*Call graph*: calls 3 internal fn (already_present, mask, to_wide); called by 2 (add_deny_read_ace, add_deny_write_ace); 7 external calls (anyhow!, zeroed, null_mut, LocalFree, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW).


##### `add_deny_read_ace`  (lines 589–591)

```
fn add_deny_read_ace(path: &Path, psid: *mut c_void) -> Result<bool>
```

**Purpose**: Adds a deny rule that blocks one SID from reading a path. The rule is inheritable, so when it is placed on a directory it can also protect files and directories created below it.

**Data flow**: It receives a path and a SID. It calls add_deny_ace with the Read deny kind and returns whether a new deny entry was added.

**Call relations**: This is the read-deny entry point for callers. It hands the common ACL editing work to add_deny_ace, while making the caller’s intent clear.

*Call graph*: calls 1 internal fn (add_deny_ace).


##### `revoke_ace`  (lines 593–643)

```
fn revoke_ace(path: &Path, psid: *mut c_void)
```

**Purpose**: Removes access entries for one SID from a path. This is used when the sandbox needs to undo or synchronize earlier permission changes.

**Data flow**: It receives a path and a SID. It reads the current DACL, builds a revoke-access entry for that SID, asks Windows to merge that revocation into a new DACL, writes the new DACL back to the path, and frees any temporary Windows memory. It does not return an error; if a Windows call fails, it simply stops or ignores the write failure.

**Call relations**: apply_deny_read_acls and sync_persistent_deny_read_acls call this when maintaining read-deny ACL state. Unlike the add functions, this one is a cleanup-style helper and quietly exits on failure.

*Call graph*: calls 1 internal fn (to_wide); called by 2 (apply_deny_read_acls, sync_persistent_deny_read_acls); 6 external calls (zeroed, null_mut, LocalFree, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW).


##### `allow_null_device`  (lines 649–710)

```
fn allow_null_device(psid: *mut c_void)
```

**Purpose**: Grants a SID access to the Windows NUL device, a special sink/source often used when redirecting standard output or error. Without this, a sandboxed process might fail when its output is redirected to NUL.

**Data flow**: It receives a SID. It opens the special \\.\NUL device with rights to read and change its security information, reads its DACL, builds an allow entry for read/write/execute for that SID, merges it into a new DACL, writes the new DACL back to the device object, frees temporary security data, and closes the device handle.

**Call relations**: Sandbox startup paths such as run_windows_sandbox_capture_for_permission_profile, allow_null_device_for_workspace_write, apply_legacy_session_acl_rules, and prepare_elevated_spawn_context_for_permissions call this when they need output redirection to work under a restricted identity. It uses handle-based Windows security APIs because NUL is a kernel device rather than an ordinary file path.

*Call graph*: calls 1 internal fn (to_wide); called by 4 (run_windows_sandbox_capture_for_permission_profile, allow_null_device_for_workspace_write, apply_legacy_session_acl_rules, prepare_elevated_spawn_context_for_permissions); 8 external calls (zeroed, null_mut, CloseHandle, LocalFree, GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo, CreateFileW).


### `windows-sandbox-rs/src/token.rs`

`domain_logic` · `process launch / sandbox setup`

On Windows, a process runs with a token: a bundle of identity and permission information, like a security badge. This file takes an existing token and creates a more limited badge for sandboxed work. Without this, a sandboxed process could either have too much power, which is unsafe, or too little power, which would make normal things like PowerShell pipelines and inter-process communication fail.

The file works mostly with SIDs, or security identifiers. A SID is Windows’ way of naming a user, group, logon session, or special capability. The code can make common SIDs such as “Everyone,” convert SID strings into Windows SID objects, and copy the current user or logon SID out of a token.

The main path creates a restricted token with one or more capability SIDs. It also adds the current logon SID and the Everyone SID as restricting SIDs, then asks Windows to produce a token with most privileges disabled. After that, it sets a permissive default DACL. A DACL is an access list attached to newly created objects; here it helps sandboxed processes create pipes and other communication objects without being blocked unexpectedly. Finally, it re-enables one harmless but important privilege, SeChangeNotifyPrivilege, which Windows commonly needs for directory traversal.

#### Function details

##### `set_default_dacl`  (lines 56–107)

```
fn set_default_dacl(h_token: HANDLE, sids: &[*mut c_void]) -> Result<()>
```

**Purpose**: Sets the default access list on a token so new objects created by the sandboxed process can be used by the intended SIDs. This prevents confusing access-denied failures when child processes create pipes or other communication objects.

**Data flow**: It receives a token handle and a list of SID pointers. If the list is empty, nothing changes. Otherwise it turns those SIDs into Windows access-list entries granting broad access, asks Windows to build a new DACL from them, attaches that DACL to the token, frees the temporary Windows-allocated memory, and returns success or an error.

**Call relations**: This is used after a restricted token has been created. create_token_with_caps_from calls it to make the new token practical for real sandboxed programs, especially programs that need to create communication objects.

*Call graph*: called by 1 (create_token_with_caps_from); 8 external calls (anyhow!, is_empty, iter, null_mut, GetLastError, LocalFree, SetEntriesInAclW, SetTokenInformation).


##### `world_sid`  (lines 109–128)

```
fn world_sid() -> Result<Vec<u8>>
```

**Purpose**: Creates the Windows SID for the built-in “Everyone” group. This SID is used when the restricted token needs to recognize broadly shared access rules.

**Data flow**: It first asks Windows how many bytes are needed for the Everyone SID, allocates a byte buffer of that size, then asks Windows to fill the buffer. It returns the SID bytes or an error if Windows cannot create it.

**Call relations**: create_token_with_caps_from uses this SID as part of the restricted token’s limiting identity set. Other security checks, such as path_has_world_write_allow, also use it when they need to compare access rules against Everyone.

*Call graph*: called by 2 (path_has_world_write_allow, create_token_with_caps_from); 4 external calls (anyhow!, null_mut, vec!, CreateWellKnownSid).


##### `convert_string_sid_to_sid`  (lines 132–140)

```
fn convert_string_sid_to_sid(s: &str) -> Option<*mut c_void>
```

**Purpose**: Turns a textual SID, such as one read from configuration or generated elsewhere, into the raw Windows SID pointer that Windows security APIs expect.

**Data flow**: It receives a SID string, converts the text into Windows wide-character form, and calls the Windows conversion function. On success it returns a pointer allocated by Windows; on failure it returns nothing. The caller must later free that pointer.

**Call relations**: LocalSid::from_string wraps this lower-level function so the rest of the code can use converted SIDs safely without remembering to free them by hand.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (from_string); 1 external calls (null_mut).


##### `LocalSid::from_string`  (lines 148–152)

```
fn from_string(sid: &str) -> Result<Self>
```

**Purpose**: Creates a LocalSid owner from a SID string. This gives the project a safer Rust wrapper around a Windows-allocated SID.

**Data flow**: It receives text, asks convert_string_sid_to_sid to convert it, and either stores the returned pointer inside a LocalSid or reports that the string was invalid. The result is an object that owns the SID memory.

**Call relations**: Higher-level sandbox setup code calls this when it needs capability or account SIDs for spawning sandboxed processes. It hides the raw conversion step behind a small ownership type.

*Call graph*: calls 1 internal fn (convert_string_sid_to_sid); called by 5 (spawn_ipc_process, run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_legacy_session_security, root_capability_sids).


##### `LocalSid::as_ptr`  (lines 154–156)

```
fn as_ptr(&self) -> *mut c_void
```

**Purpose**: Returns the raw Windows SID pointer stored inside a LocalSid. This is needed because Windows API calls work with raw pointers rather than Rust-owned wrapper objects.

**Data flow**: It reads the stored pointer from the LocalSid and gives it back unchanged. It does not allocate, free, or modify anything.

**Call relations**: Code that has built a LocalSid uses this when passing the SID into token-creation or access-control functions. The LocalSid still owns the memory; this only lends out the address.


##### `LocalSid::drop`  (lines 160–166)

```
fn drop(&mut self)
```

**Purpose**: Frees the Windows memory owned by a LocalSid when the Rust object goes away. This prevents leaking memory allocated by Windows SID conversion.

**Data flow**: When the LocalSid is being destroyed, it checks whether its pointer is non-null. If so, it calls Windows LocalFree on that pointer. Nothing is returned.

**Call relations**: This runs automatically as part of Rust cleanup. It balances the allocation done by convert_string_sid_to_sid and used through LocalSid::from_string.

*Call graph*: 2 external calls (is_null, LocalFree).


##### `get_current_token_for_restriction`  (lines 171–192)

```
fn get_current_token_for_restriction() -> Result<HANDLE>
```

**Purpose**: Opens the current process’s token with the rights needed to create a restricted child token. It is the starting point when the sandbox is based on the currently running process.

**Data flow**: It builds a requested-access mask containing token rights such as duplicate, query, assign, and adjust. It asks Windows to open the current process token with those rights. On success it returns a token handle; on failure it returns an error. The caller must close the handle.

**Call relations**: Sandbox setup code calls this before granting desktop access, preparing legacy session security, or creating a readonly token from the current process. create_readonly_token_with_cap also uses it before handing the token to the shared creation path.

*Call graph*: called by 4 (grant_desktop_access, allow_null_device_for_workspace_write, prepare_legacy_session_security, create_readonly_token_with_cap); 2 external calls (anyhow!, GetCurrentProcess).


##### `get_logon_sid_bytes`  (lines 194–277)

```
fn get_logon_sid_bytes(h_token: HANDLE) -> Result<Vec<u8>>
```

**Purpose**: Finds and copies the logon SID from a token. The logon SID identifies the current sign-in session and is useful for allowing the sandbox to interact with session-owned objects without giving it the full user identity.

**Data flow**: It receives a token handle and asks Windows for the token’s groups. It scans those groups for the special logon-session marker, copies that SID into a Rust byte buffer, and returns it. If the SID is not on the token, it tries the linked token, which Windows may provide for elevated or filtered accounts. If neither has it, it returns an error.

**Call relations**: create_token_with_caps_from uses this SID as one of the restricting SIDs and as part of the default DACL. Desktop and device-access setup code also calls it when it needs to grant access specifically to the current logon session.

*Call graph*: called by 3 (grant_desktop_access, allow_null_device_for_workspace_write, create_token_with_caps_from); 6 external calls (anyhow!, null_mut, read_unaligned, vec!, CloseHandle, GetTokenInformation).


##### `get_user_sid_bytes`  (lines 279–317)

```
fn get_user_sid_bytes(h_token: HANDLE) -> Result<Vec<u8>>
```

**Purpose**: Copies the user SID from a token. This is used when the sandbox token must also include the token’s user identity as an extra restricting SID, especially for a dedicated sandbox account.

**Data flow**: It receives a token handle, asks Windows how large the TokenUser data is, allocates a buffer, and reads the user information into it. It then measures and copies the user SID into its own byte buffer and returns those bytes. If any Windows call fails, it returns an error.

**Call relations**: The token-creation variants with “and_user” call this before delegating to create_token_with_caps_from. That lets those variants add the token user SID while reusing the same core restricted-token builder.

*Call graph*: called by 2 (create_readonly_token_with_caps_and_user_from, create_workspace_write_token_with_caps_and_user_from); 7 external calls (anyhow!, null_mut, read_unaligned, vec!, CopySid, GetLengthSid, GetTokenInformation).


##### `enable_single_privilege`  (lines 319–348)

```
fn enable_single_privilege(h_token: HANDLE, name: &str) -> Result<()>
```

**Purpose**: Enables one named Windows privilege on a token. In this file it is used to restore SeChangeNotifyPrivilege, a common privilege needed for normal directory traversal.

**Data flow**: It receives a token handle and a privilege name. It asks Windows for the internal numeric ID of that privilege, builds a small privilege-change request, and applies it to the token. It returns success only if Windows reports that the privilege was actually adjusted.

**Call relations**: create_token_with_caps_from calls this at the end of token creation. Most privileges are removed for safety, but this one is restored so ordinary file-system navigation does not break.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (create_token_with_caps_from); 7 external calls (anyhow!, zeroed, null, null_mut, GetLastError, AdjustTokenPrivileges, LookupPrivilegeValueW).


##### `create_readonly_token_with_cap`  (lines 352–359)

```
fn create_readonly_token_with_cap(
    psid_capability: *mut c_void,
) -> Result<(HANDLE, *mut c_void)>
```

**Purpose**: Creates a restricted token from the current process using one capability SID. It is a convenience path for older or simpler sandbox setup code that only has a single capability.

**Data flow**: It opens the current process token, passes that token and the capability SID to create_readonly_token_with_cap_from, closes the temporary base token, and returns the new restricted token plus the same capability pointer. If any step fails, it returns an error.

**Call relations**: prepare_legacy_session_security calls this when it needs a readonly sandbox token. This function is a wrapper that takes care of opening and closing the current token before handing off to the shared builder.

*Call graph*: calls 2 internal fn (create_readonly_token_with_cap_from, get_current_token_for_restriction); called by 1 (prepare_legacy_session_security); 1 external calls (CloseHandle).


##### `create_readonly_token_with_cap_from`  (lines 365–371)

```
fn create_readonly_token_with_cap_from(
    base_token: HANDLE,
    psid_capability: *mut c_void,
) -> Result<(HANDLE, *mut c_void)>
```

**Purpose**: Creates a restricted token from an already-open base token using one capability SID. It exists for callers that already have the base token and do not want this function to open the current process token itself.

**Data flow**: It receives a base token handle and one capability SID pointer. It wraps that single SID as a one-item list, calls the shared token builder, and returns the new token together with the original capability pointer.

**Call relations**: create_readonly_token_with_cap calls this after opening the current token. This function then delegates the real work to create_token_with_caps_from.

*Call graph*: calls 1 internal fn (create_token_with_caps_from); called by 1 (create_readonly_token_with_cap).


##### `create_workspace_write_token_with_caps_from`  (lines 377–382)

```
fn create_workspace_write_token_with_caps_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Creates a restricted token that includes several capability SIDs for workspace-write scenarios. Despite the name difference, it uses the same core restricted-token machinery as the readonly variants.

**Data flow**: It receives a base token and a list of capability SID pointers. It passes them to the shared token builder without adding any extra restricting SIDs, and returns the resulting token or an error.

**Call relations**: prepare_legacy_session_security uses this when setting up a token that should be allowed to write in the workspace according to the provided capabilities. The detailed Windows token construction is handled by create_token_with_caps_from.

*Call graph*: calls 1 internal fn (create_token_with_caps_from); called by 1 (prepare_legacy_session_security).


##### `create_workspace_write_token_with_caps_and_user_from`  (lines 391–398)

```
fn create_workspace_write_token_with_caps_and_user_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Creates a restricted workspace-write token that includes both capability SIDs and the token user SID. This is meant for the elevated sandbox backend, where the user may be a dedicated sandbox account rather than the real signed-in user.

**Data flow**: It receives a base token and capability SID pointers. It copies the user SID out of the base token, uses that SID as an extra restricting SID, then calls the shared token builder. The output is a new restricted token or an error.

**Call relations**: This is a specialized wrapper around create_token_with_caps_from. It first calls get_user_sid_bytes so the core builder can include the sandbox account identity in the token’s restriction set.

*Call graph*: calls 2 internal fn (create_token_with_caps_from, get_user_sid_bytes).


##### `create_readonly_token_with_caps_from`  (lines 404–409)

```
fn create_readonly_token_with_caps_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Creates a restricted token from an existing base token using multiple capability SIDs. It is the multi-capability version of the readonly token path.

**Data flow**: It receives a base token and a list of capability SID pointers. It forwards them to the shared token builder with no extra user SID, then returns the new restricted token or an error.

**Call relations**: This function is a thin public entry into create_token_with_caps_from for callers that already have all needed capabilities and do not need the user SID added.

*Call graph*: calls 1 internal fn (create_token_with_caps_from).


##### `create_readonly_token_with_caps_and_user_from`  (lines 418–425)

```
fn create_readonly_token_with_caps_and_user_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Creates a restricted readonly token that includes multiple capability SIDs plus the token user SID. This supports elevated sandbox setups that run under a dedicated sandbox account.

**Data flow**: It receives a base token and capability SID pointers. It copies the user SID from the base token, adds that copied SID to the extra restricting list, and calls the shared token builder. It returns the new restricted token or an error.

**Call relations**: Like the workspace-write “and_user” variant, this function prepares the user SID with get_user_sid_bytes and then relies on create_token_with_caps_from for the actual restricted-token creation.

*Call graph*: calls 2 internal fn (create_token_with_caps_from, get_user_sid_bytes).


##### `create_token_with_caps_from`  (lines 427–483)

```
fn create_token_with_caps_from(
    base_token: HANDLE,
    psid_capabilities: &[*mut c_void],
    extra_restricting_sids: &[*mut c_void],
) -> Result<HANDLE>
```

**Purpose**: Builds the actual restricted Windows token used by the sandbox. This is the central routine that combines capabilities, optional extra SIDs, the logon SID, and the Everyone SID into a safer token.

**Data flow**: It receives a base token, a list of capability SID pointers, and optional extra restricting SID pointers. It rejects an empty capability list, copies the logon SID, creates the Everyone SID, and arranges all SIDs in the order expected by this sandbox design. It then asks Windows to create a restricted token with major privileges disabled, sets the token’s default DACL so created objects are usable, enables SeChangeNotifyPrivilege, and returns the new token handle.

**Call relations**: All public token-creation variants eventually call this function. It in turn calls get_logon_sid_bytes, world_sid, set_default_dacl, and enable_single_privilege to assemble the token and make it usable for sandboxed child processes.

*Call graph*: calls 4 internal fn (enable_single_privilege, get_logon_sid_bytes, set_default_dacl, world_sid); called by 5 (create_readonly_token_with_cap_from, create_readonly_token_with_caps_and_user_from, create_readonly_token_with_caps_from, create_workspace_write_token_with_caps_and_user_from, create_workspace_write_token_with_caps_from); 8 external calls (with_capacity, anyhow!, is_empty, iter, len, null, vec!, CreateRestrictedToken).


### `windows-sandbox-rs/src/deny_read_acl.rs`

`domain_logic` · `sandbox setup and permission synchronization`

This file is about protecting secrets from a sandboxed command. In Windows, file permissions are stored in an ACL, or access control list, which is like a guest list saying who may read, write, or enter a file or folder. This code adds a deny-read ACE, meaning an access control entry that explicitly says “this sandbox identity may not read here.”

The first job is planning. A user may configure a path such as `secret.env`. If that path already exists, it might also have a real resolved location, for example through a shortcut-like Windows feature called a reparse point. So the planner keeps both the written path and the canonical, resolved path. If the path does not exist yet, it still keeps the written path, because the sandbox must not be able to create that path later and then read it.

The second job is applying the plan. For missing denied paths, the code creates directories first, then applies the deny-read rule. This is defensive: it turns “future forbidden place” into a real place with permissions already attached. If any permission update fails, the file revokes every deny rule it added during this call before returning the error. That makes the operation all-or-nothing, like rolling back a failed transaction.

#### Function details

##### `plan_deny_read_acl_paths`  (lines 18–28)

```
fn plan_deny_read_acl_paths(paths: &[PathBuf]) -> Vec<PathBuf>
```

**Purpose**: Builds the exact list of paths that should receive deny-read permissions. It keeps the path as configured, and also adds the resolved real path when the target already exists, so the sandbox cannot bypass the rule by reaching the same object another way.

**Data flow**: It receives a list of paths. For each one, it adds the original path to a planned list if it has not already seen an equivalent spelling. If the path exists on disk, it also asks for the canonical path, meaning the fully resolved real location, and adds that too if it is not a duplicate. It returns the final ordered list of paths to protect.

**Call relations**: This is the planning step used by `apply_deny_read_acls` before any Windows permissions are changed. It relies on `push_planned_path` to avoid duplicates and on `canonicalize_path` when an existing path needs its real resolved target included. The test `tests::plan_includes_existing_canonical_targets` calls it directly to prove that existing paths get both forms.

*Call graph*: calls 2 internal fn (push_planned_path, canonicalize_path); called by 2 (apply_deny_read_acls, plan_includes_existing_canonical_targets); 2 external calls (new, new).


##### `push_planned_path`  (lines 30–34)

```
fn push_planned_path(planned: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf)
```

**Purpose**: Adds one path to a plan only if an equivalent path has not already been added. This prevents the same permission rule from being applied twice just because a path is written with different slashes or letter casing.

**Data flow**: It receives the growing planned path list, a set of already-seen path keys, and a path to consider. It turns the path into a normalized text key using `lexical_path_key`. If that key is new, it records the key and appends the path to the list. If the key was already present, it leaves the list unchanged.

**Call relations**: This is the small deduplication helper used during planning by `plan_deny_read_acl_paths` and again by `apply_deny_read_acls` when building the list of paths that were actually processed. It delegates the question of “what counts as the same path spelling” to `lexical_path_key`.

*Call graph*: calls 1 internal fn (lexical_path_key); called by 2 (apply_deny_read_acls, plan_deny_read_acl_paths).


##### `lexical_path_key`  (lines 36–41)

```
fn lexical_path_key(path: &Path) -> String
```

**Purpose**: Creates a simple comparison key for a path so paths that differ only by slash style, trailing slash, or letter case are treated as the same. This matters on Windows, where paths are usually not case-sensitive and backslashes and forward slashes can both appear.

**Data flow**: It receives a path. It converts it to text, changes backslashes into forward slashes, removes trailing slashes, and lowercases the result. It returns that cleaned-up string as the key used for duplicate checks.

**Call relations**: This helper is called by `push_planned_path` whenever this file needs to avoid adding the same path twice. It is also used by `sync_persistent_deny_read_acls` elsewhere in the project, so persistent deny-read synchronization can compare paths in the same consistent way.

*Call graph*: called by 2 (push_planned_path, sync_persistent_deny_read_acls); 1 external calls (to_string_lossy).


##### `apply_deny_read_acls`  (lines 51–80)

```
fn apply_deny_read_acls(paths: &[PathBuf], psid: *mut c_void) -> Result<Vec<PathBuf>>
```

**Purpose**: Applies deny-read Windows permissions to all planned paths for the sandbox identity. It is careful to create missing paths first and to undo any new deny rules if a later path fails.

**Data flow**: It receives configured paths and a raw SID pointer, which identifies the Windows user or group being denied. First it calls `plan_deny_read_acl_paths` to decide every path that needs protection. For each planned path, it creates the path as a directory if it does not exist, then calls `add_deny_read_ace` to add the deny-read permission. It remembers which paths received a newly added rule. If a later step fails, it calls `revoke_ace` on those newly changed paths and returns the error. If everything succeeds, it returns the deduplicated list of paths it applied or checked.

**Call relations**: This is the action step called by `sync_persistent_deny_read_acls` when the wider system wants deny-read policy reflected in Windows ACLs. It starts with `plan_deny_read_acl_paths`, uses `push_planned_path` to report processed paths without duplicates, hands each path to `add_deny_read_ace`, and calls `revoke_ace` only as rollback after a failure.

*Call graph*: calls 3 internal fn (revoke_ace, plan_deny_read_acl_paths, push_planned_path); called by 1 (sync_persistent_deny_read_acls); 2 external calls (new, new).


##### `tests::plan_preserves_missing_paths`  (lines 91–99)

```
fn plan_preserves_missing_paths()
```

**Purpose**: Checks that a path which does not exist yet is still included in the deny-read plan. This protects against the case where a sandboxed command creates a forbidden file or folder during its run and then tries to read it.

**Data flow**: The test creates a temporary directory and forms a child path that is deliberately missing. It passes that missing path to `plan_deny_read_acl_paths`. The expected result is a one-item list containing exactly that missing path.

**Call relations**: This test exercises the planning behavior directly. It supports the promise that `apply_deny_read_acls` can later materialize missing denied paths before applying permissions.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::plan_includes_existing_canonical_targets`  (lines 102–118)

```
fn plan_includes_existing_canonical_targets()
```

**Purpose**: Checks that an existing path produces a plan containing both the configured path and its canonical resolved path. This matters because a sandbox should not be able to read the same file through an alternate resolved location.

**Data flow**: The test creates a temporary file, writes content to it so it exists, then passes its path to `plan_deny_read_acl_paths`. It independently computes the canonical path and compares sets, not order, to confirm both the original and canonical paths are present.

**Call relations**: This test calls `plan_deny_read_acl_paths`, which in turn calls the path-planning helpers and canonicalization logic. It verifies the behavior that `apply_deny_read_acls` relies on before changing real Windows permissions.

*Call graph*: calls 1 internal fn (plan_deny_read_acl_paths); 5 external calls (new, assert_eq!, canonicalize, write, from_ref).


### `windows-sandbox-rs/src/audit.rs`

`domain_logic` · `sandbox preflight/setup`

On Windows, a folder can sometimes be writable by “Everyone,” meaning almost any local user or process may write there. That is dangerous for a sandbox because the sandbox might be meant to write only in a workspace, but Windows permissions could quietly allow writes somewhere else. This file acts like a preflight safety inspector: before or during sandbox setup, it looks at likely places the process might touch, such as the current working directory, temporary folders, user folders, PATH folders, and a few system roots.

The scan is deliberately fast and shallow. It checks the current directory’s immediate child folders first, then checks a wider list of candidate roots and one level of children. It stops after a short time or after enough items have been checked, so it does not turn startup into a full disk crawl. It also avoids symlinks and some noisy Windows directories.

If it finds world-writable folders, it logs them. Then, when Windows sandbox enforcement is available, it adds deny entries to those folders for the sandbox capability identity. An access control entry, or ACE, is a Windows permission rule; here the added rule says “this sandbox identity may not write here.” The file is careful not to deny writes inside approved workspace write roots, because those are intentionally allowed.

#### Function details

##### `unique_push`  (lines 38–44)

```
fn unique_push(set: &mut HashSet<PathBuf>, out: &mut Vec<PathBuf>, p: PathBuf)
```

**Purpose**: Adds a path to a list only if it can be turned into an absolute, real path and has not already been added. This keeps the scan list tidy and avoids checking the same folder twice under slightly different names.

**Data flow**: It receives a set of already-seen paths, an output list, and a candidate path. It asks the operating system for the path’s canonical form, meaning the cleaned-up absolute location. If that succeeds and the canonical path is new, it records it in the set and appends it to the output list.

**Call relations**: This is a helper used by gather_candidates whenever a possible scan location is discovered. It does not decide which folders matter; it simply makes sure the chosen folders are valid and unique before the audit uses them.

*Call graph*: called by 1 (gather_candidates); 1 external calls (canonicalize).


##### `gather_candidates`  (lines 46–81)

```
fn gather_candidates(cwd: &Path, env: &std::collections::HashMap<String, String>) -> Vec<PathBuf>
```

**Purpose**: Builds the list of folders that the audit should inspect first. It focuses on places most likely to matter for a running process: the current folder, temporary folders, user folders, PATH entries, and basic system roots.

**Data flow**: It starts with the current working directory and an environment map. It reads TEMP, TMP, PATH, and some user-related environment variables, falling back to the real process environment where needed. Each discovered path is normalized and deduplicated through unique_push, and the finished list of candidate folders comes out in priority order.

**Call relations**: audit_everyone_writable calls this after it has already checked the current directory’s immediate children. The test tests::gathers_path_entries_by_list_separator also calls it to confirm PATH is split correctly into separate folders.

*Call graph*: calls 1 internal fn (unique_push); called by 2 (audit_everyone_writable, gathers_path_entries_by_list_separator); 7 external calls (new, new, to_path_buf, from, new, split_paths, var_os).


##### `path_has_world_write_allow`  (lines 83–93)

```
fn path_has_world_write_allow(path: &Path) -> Result<bool>
```

**Purpose**: Checks whether a specific path grants write-like permissions to the Windows Everyone identity. In plain terms, it asks: “Can the general public write here?”

**Data flow**: It receives a path. It creates the Windows security identifier, or SID, for Everyone, then builds a set of write permission bits such as writing data, appending data, changing extended attributes, and changing file attributes. It passes that information to the lower-level ACL checker and returns true or false.

**Call relations**: audit_everyone_writable uses this through a small wrapper that catches errors. The actual permission lookup is handed off to path_mask_allows, while world_sid supplies the Windows identity being tested.

*Call graph*: calls 2 internal fn (path_mask_allows, world_sid).


##### `audit_everyone_writable`  (lines 95–218)

```
fn audit_everyone_writable(
    cwd: &Path,
    env: &std::collections::HashMap<String, String>,
    logs_base_dir: Option<&Path>,
) -> Result<Vec<PathBuf>>
```

**Purpose**: Performs the actual world-writable folder audit and returns the folders that fail the check. It is meant to catch dangerous write access quickly without scanning the whole machine.

**Data flow**: It receives the current working directory, an environment map, and an optional log location. It first scans immediate child directories of the current directory, then scans candidate folders from gather_candidates and one level of children under each. For every folder, it checks whether Everyone has write permission, records each failing path once using a canonical key, logs either success or failure, and returns the list of flagged folders.

**Call relations**: apply_world_writable_scan_and_denies_for_permissions calls this as the first step in the audit-and-protect flow. Inside the scan it relies on gather_candidates to choose likely roots, path_has_world_write_allow to ask Windows about permissions, canonical_path_key to avoid duplicate reports, and logging helpers to record what happened.

*Call graph*: calls 3 internal fn (gather_candidates, log_note, canonical_path_key); called by 1 (apply_world_writable_scan_and_denies_for_permissions); 7 external calls (from_secs, new, now, new, new, format!, read_dir).


##### `apply_world_writable_scan_and_denies_for_permissions`  (lines 220–245)

```
fn apply_world_writable_scan_and_denies_for_permissions(
    codex_home: &Path,
    cwd: &Path,
    env_map: &std::collections::HashMap<String, String>,
    permissions: &ResolvedWindowsSandboxPermiss
```

**Purpose**: Runs the audit and, if risky folders are found, attempts to add protective deny rules for the sandbox capability identity. It is the public wrapper for the full “scan, then protect” operation.

**Data flow**: It receives the Codex home directory, current working directory, environment map, resolved sandbox permissions, and optional log location. It calls audit_everyone_writable to get the flagged folders. If none are found, it returns successfully; if some are found, it asks apply_capability_denies_for_world_writable_for_permissions to add deny rules and logs any failure from that protection step without turning it into a hard failure.

**Call relations**: This function ties together detection and mitigation. A higher-level setup path can call it without needing to know the details of Windows ACLs, capability SIDs, or workspace exceptions.

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

**Purpose**: Adds Windows deny-write permission rules to the flagged world-writable folders for the active sandbox identity, while preserving intentionally allowed workspace writes. This is the mitigation part of the file.

**Data flow**: It receives the Codex home directory, the flagged paths, resolved permissions, the current working directory, the environment map, and optional logging location. It ensures the Codex home exists, loads or creates the capability SIDs, writes them to disk, and checks whether the current permission mode can be enforced through Windows sandbox rules. It then chooses the active sandbox identities: either workspace write capability SIDs for approved write roots, or the readonly capability SID. For each flagged path outside approved workspace roots, it tries to add a deny-write ACE and logs whether that succeeded or failed.

**Call relations**: apply_world_writable_scan_and_denies_for_permissions calls this after the audit finds risky folders. This function coordinates with the capability module to get SIDs, the setup module to compute allowed write roots, and the ACL module to actually change Windows permissions.

*Call graph*: calls 7 internal fn (add_deny_write_ace, cap_sid_file, load_or_create_cap_sids, log_note, is_enforceable_by_windows_sandbox, uses_write_capabilities_for_cwd, effective_write_roots_for_permissions); called by 1 (apply_world_writable_scan_and_denies_for_permissions); 7 external calls (is_empty, new, format!, to_string, create_dir_all, write, vec!).


##### `tests::gathers_path_entries_by_list_separator`  (lines 321–349)

```
fn gathers_path_entries_by_list_separator()
```

**Purpose**: Checks that gather_candidates correctly treats a Windows PATH string as several separate folders, including a folder whose name contains a space. This protects against a subtle bug where PATH entries could be misread as one long path.

**Data flow**: The test creates a temporary directory with three child folders, builds an environment map whose PATH contains those folders separated by semicolons, and calls gather_candidates. It canonicalizes the expected folders and asserts that all three appear in the returned candidate list.

**Call relations**: This test exercises gather_candidates directly. It does not run the full audit or touch Windows ACL rules; it focuses on making sure the candidate-building step sees PATH entries the way Windows users expect.

*Call graph*: calls 1 internal fn (gather_candidates); 5 external calls (new, assert!, format!, create_dir_all, tempdir).


### `windows-sandbox-rs/src/hide_users.rs`

`domain_logic` · `after user creation and during sandbox command execution`

This file exists to make temporary sandbox users less visible on the host machine. When a sandbox creates Windows user accounts, those accounts could otherwise show up on the Windows login screen. Also, once one of those users logs in, Windows creates a profile folder for it under the usual user-profile area, where it may be visible in File Explorer. This file tries to hide both things.

It has two main jobs. First, after new sandbox users are created, it writes entries under Windows’ Winlogon “SpecialAccounts UserList” registry key. In plain terms, the registry is a Windows settings database, and this particular setting tells the login screen not to list specific users. Each username is written with a value of 0, meaning “do not show this account.”

Second, when code is running as a sandbox user, it looks up that user’s USERPROFILE folder. If the folder exists, it adds the Windows HIDDEN and SYSTEM file attributes. That is like putting the folder behind a “do not show in normal browsing” curtain. The operation is best-effort: failures are logged, but they do not stop the rest of the sandbox work. This is important because hiding users is cosmetic and cleanup-oriented, not the core job of running commands safely.

#### Function details

##### `hide_newly_created_users`  (lines 26–36)

```
fn hide_newly_created_users(usernames: &[String], log_base: &Path)
```

**Purpose**: This is the public entry point for hiding newly created sandbox user accounts from the Windows login screen. If there are no usernames, it does nothing; if Windows registry work fails, it records a note instead of crashing the run.

**Data flow**: It receives a list of usernames and a log location. If the list is empty, the story ends there. Otherwise it asks the registry-writing helper to hide those users; if that helper returns an error, it turns the error into a readable log message.

**Call relations**: This function is the safe wrapper around the lower-level registry work. It calls hide_users_in_winlogon to do the actual Windows setting change, and it calls log_note only when that lower-level step fails.

*Call graph*: calls 2 internal fn (hide_users_in_winlogon, log_note); 1 external calls (format!).


##### `hide_current_user_profile_dir`  (lines 43–74)

```
fn hide_current_user_profile_dir(log_base: &Path)
```

**Purpose**: This hides the profile folder of the sandbox user that is currently running. Windows only creates that folder after the user first logs in, so this function is meant to run at command-execution time, when the folder is likely to exist.

**Data flow**: It reads the USERPROFILE environment variable, which points to the current user’s profile folder. If the variable is missing or the folder is not present, it stops quietly. If the folder exists, it asks hide_directory to add hidden/system attributes; when that actually changes the folder, it logs a one-time note, and when it fails, it logs the failure.

**Call relations**: This function sits above the file-attribute helper. It calls hide_directory for the Windows file attribute change, and uses log_note to record either a successful first-time hide or an error.

*Call graph*: calls 2 internal fn (hide_directory, log_note); 3 external calls (from, format!, var_os).


##### `hide_users_in_winlogon`  (lines 76–105)

```
fn hide_users_in_winlogon(usernames: &[String], log_base: &Path) -> anyhow::Result<()>
```

**Purpose**: This writes the Windows login-screen settings that make specific user accounts not appear in the user list. It is lower-level than hide_newly_created_users because it directly opens a registry key and writes values.

**Data flow**: It receives usernames and a log location. First it creates or opens the needed Winlogon registry key. Then, for each username, it converts the name into the wide-character text format expected by Windows, writes a registry value of 0 for that user, and logs any per-user write failure. At the end it closes the registry key and reports overall success if the key could be opened.

**Call relations**: hide_newly_created_users calls this when there are users to hide. This function calls create_userlist_key to get access to the right registry location, then calls the Windows RegSetValueExW function for each username, and finally calls RegCloseKey so the opened registry handle is not left open.

*Call graph*: calls 3 internal fn (create_userlist_key, log_note, to_wide); called by 1 (hide_newly_created_users); 5 external calls (new, format!, size_of_val, RegCloseKey, RegSetValueExW).


##### `create_userlist_key`  (lines 107–130)

```
fn create_userlist_key() -> anyhow::Result<HKEY>
```

**Purpose**: This opens, or creates if missing, the Windows registry key where hidden-login-user settings are stored. Other code needs this key before it can tell Windows which users not to show on the sign-in screen.

**Data flow**: It starts with the fixed registry path for Winlogon’s SpecialAccounts UserList. It converts that path into Windows’ expected wide-character format, asks Windows to create/open the key with write permission, and returns the opened registry handle. If Windows refuses or fails, it returns an error message that includes the Windows error text.

**Call relations**: hide_users_in_winlogon calls this before writing any username values. This function is the single place in the file that uses RegCreateKeyExW, keeping the registry-opening step separate from the loop that writes user entries.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (hide_users_in_winlogon); 3 external calls (anyhow!, null_mut, RegCreateKeyExW).


##### `hide_directory`  (lines 133–158)

```
fn hide_directory(path: &Path) -> anyhow::Result<bool>
```

**Purpose**: This adds the Windows HIDDEN and SYSTEM attributes to a folder, but only if they are not already set. It returns whether it actually changed anything, so callers can avoid noisy repeated logs.

**Data flow**: It receives a filesystem path. It converts the path into the text format Windows APIs expect, reads the folder’s current attributes, and builds a new attribute set that includes HIDDEN and SYSTEM. If those attributes were already present, it returns false. If not, it asks Windows to save the new attributes and returns true when successful; any Windows failure becomes a readable error.

**Call relations**: hide_current_user_profile_dir calls this after finding the current user’s profile folder. This function does the direct Windows file-attribute calls: GetFileAttributesW to read the current state, GetLastError to explain failures, and SetFileAttributesW to apply the hidden/system flags.

*Call graph*: calls 1 internal fn (to_wide); called by 1 (hide_current_user_profile_dir); 4 external calls (anyhow!, GetLastError, GetFileAttributesW, SetFileAttributesW).


### `windows-sandbox-rs/src/bin/setup_main/win/setup_runtime_bin.rs`

`domain_logic` · `Windows sandbox setup`

Codex Desktop copies some Windows runtime binaries into a fixed cache folder under the current user's LocalAppData directory. A sandboxed process may run as a restricted Windows group, so it cannot assume it has the same folder access as the normal user. This file checks that specific cache folder and, if it exists, gives the sandbox group permission to read files and execute programs inside it.

The key Windows idea here is an access control entry, or ACE: a rule on a file or folder saying who may do what. The function first finds LocalAppData, falling back to USERPROFILE/AppData/Local if needed. If it cannot find the folder, or if the expected Codex runtime bin folder is not present, it quietly does nothing. That is intentional because not every install layout needs this folder.

If the folder exists, the code checks whether the sandbox group already has read and execute rights. If the check fails, it records the error and continues as if access is missing. If access is missing, it logs what it is about to do and asks the shared Windows sandbox library to add an inherited allow rule, meaning the permission should apply to files and subfolders too. Any failure is logged and saved for the larger setup routine to report, but the function still returns normally so setup can keep going.

#### Function details

##### `ensure_codex_app_runtime_bin_readable`  (lines 13–92)

```
fn ensure_codex_app_runtime_bin_readable(
    sandbox_group_psid: *mut c_void,
    refresh_errors: &mut Vec<String>,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: This function ensures the Windows sandbox user group can read and execute Codex Desktop's cached runtime binaries. It is used during setup so later sandboxed Codex runs do not fail simply because Windows folder permissions block needed executables.

**Data flow**: It receives a Windows security identifier for the sandbox group, a list where setup warnings can be collected, and a log writer. It looks up the user's LocalAppData path, builds the expected OpenAI/Codex/bin folder path, and skips work if that folder is absent. If the folder exists, it checks whether the sandbox group already has read-and-run access. When access is missing, it writes a log message and tries to add an inherited Windows permission rule for the sandbox group. Errors from checking or changing permissions are turned into human-readable messages, added to the shared error list, and written to the log.

**Call relations**: The broader setup flow calls this from run_setup_full while preparing the Windows sandbox environment. Inside this step, it asks path_mask_allows to inspect the existing folder permissions. If the sandbox group needs access, it hands the folder, group identifier, and permission mask to ensure_allow_mask_aces_with_inheritance, which performs the actual Windows access-control update. It uses log_line to leave a setup trail whenever the permission check or repair needs attention.

*Call graph*: called by 1 (run_setup_full); 5 external calls (ensure_allow_mask_aces_with_inheritance, path_mask_allows, format!, var_os, log_line).


### `windows-sandbox-rs/src/bin/setup_main/win/firewall.rs`

`domain_logic` · `sandbox setup`

This file is the sandbox’s network gatekeeper on Windows. Its job is to set firewall rules for a special “offline” Windows user, identified by a SID, which is Windows’ stable ID for an account. Without these rules, code running as that user could still make outbound network connections, which would break the promise of an offline sandbox.

The file talks to Windows Firewall through COM, the Windows object system used by many system APIs. First it initializes COM, opens the firewall policy, and checks that local firewall edits will actually take effect. That check matters because company or group policy can override local firewall rules; if that happens, this setup fails instead of pretending the sandbox is protected.

It then creates or updates named firewall rules. The names are stable, so running setup again updates the same rules instead of creating duplicates. One rule blocks non-loopback outbound traffic. Other rules control loopback traffic, meaning traffic back to the same machine, like 127.0.0.1. In proxy-only mode, it blocks most loopback TCP ports while leaving selected proxy ports open by blocking the complement of those ports. This is like locking every door in a hallway except the one approved service door.

The file also verifies that each rule really applies to the offline user and writes timestamped log messages when rules are configured or removed.

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

**Purpose**: Sets up the firewall behavior for local proxy access while the sandbox is offline. It either removes loopback-blocking rules when local binding is allowed, or blocks loopback traffic except for the approved proxy ports.

**Data flow**: It receives the offline user SID, a list of proxy ports, a flag saying whether local binding is allowed, and a log writer. It builds a Windows firewall user-scope string from the SID, opens the firewall policy through COM, checks that local rules will work, then adds, updates, or removes the relevant loopback rules. It returns success if the firewall ended in the intended state, or a setup error if Windows refused any step.

**Call relations**: The broader network setup calls this when configuring the offline sandbox. Inside this setup step, it prepares Windows COM, works with the firewall policy and rule collection, and finishes by uninitializing COM so the setup helper leaves the Windows API state clean.

*Call graph*: calls 1 internal fn (new); called by 1 (configure_offline_sandbox_network); 4 external calls (new, format!, CoInitializeEx, CoUninitialize).


##### `ensure_offline_outbound_block`  (lines 156–206)

```
fn ensure_offline_outbound_block(offline_sid: &str, log: &mut dyn Write) -> Result<()>
```

**Purpose**: Creates or updates the main firewall rule that blocks the offline sandbox user from making outbound connections to non-loopback network addresses. This is the core protection that makes the sandbox offline.

**Data flow**: It receives the offline user SID and a log writer. It turns the SID into the firewall’s user-scope format, initializes COM, opens the Windows Firewall policy, checks that rule edits are effective, and installs a block rule for all outbound IP traffic except loopback ranges. It returns success after the rule is configured, or a setup failure with a specific error code if the firewall cannot be changed safely.

**Call relations**: The higher-level offline network configuration calls this as part of sandbox setup. It relies on Windows Firewall COM objects during that setup window and then uninitializes COM before returning.

*Call graph*: calls 1 internal fn (new); called by 1 (configure_offline_sandbox_network); 4 external calls (new, format!, CoInitializeEx, CoUninitialize).


##### `remove_rule_if_present`  (lines 208–224)

```
fn remove_rule_if_present(
    rules: &INetFwRules,
    internal_name: &str,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Deletes an old or unwanted firewall rule if it exists. This keeps stale exceptions from lingering when the sandbox changes modes.

**Data flow**: It receives the firewall rule collection, the internal rule name, and a log writer. It asks Windows Firewall whether a rule with that name exists; if so, it removes it and writes a log line. If the rule is absent, it leaves everything unchanged and returns success.

**Call relations**: The proxy allowlist setup uses this when switching modes so older overlapping rules do not weaken the sandbox. When it removes something, it hands the human-readable audit message to log_line.

*Call graph*: calls 1 internal fn (log_line); 4 external calls (from, Item, Remove, format!).


##### `ensure_local_policy_rules_take_effect`  (lines 226–235)

```
fn ensure_local_policy_rules_take_effect(policy: &INetFwPolicy2) -> Result<()>
```

**Purpose**: Checks whether local Windows Firewall rule changes will actually apply on the current machine. This prevents a false sense of safety when local rules are ignored by policy.

**Data flow**: It receives an open firewall policy object. It asks Windows for the local policy modify state, then passes both the raw Windows result and the reported modify state to a validator. It returns success only if local firewall edits are effective for all current profiles.

**Call relations**: The two public setup functions call this before creating rules. It delegates the judgment of the Windows answer to validate_local_policy_modify_result so the policy-checking rules stay in one place.

*Call graph*: calls 1 internal fn (validate_local_policy_modify_result); 3 external calls (default, as_raw, vtable).


##### `validate_local_policy_modify_result`  (lines 237–270)

```
fn validate_local_policy_modify_result(
    result: windows::core::HRESULT,
    modify_state: NET_FW_MODIFY_STATE,
) -> Result<()>
```

**Purpose**: Interprets Windows’ answer about whether local firewall edits are effective. It turns low-level Windows status values into clear setup success or failure.

**Data flow**: It receives a Windows HRESULT, which is a success-or-error code, and a firewall modify-state value. If the query failed, if the answer only covers some active profiles, or if Windows says local edits are overridden, it returns a setup error. Only a clean success result with an OK modify state becomes success.

**Call relations**: ensure_local_policy_rules_take_effect uses this during real setup. The unit tests also call it directly to prove that effective policy is accepted and group-policy or partial-profile cases are rejected.

*Call graph*: calls 1 internal fn (new); called by 3 (ensure_local_policy_rules_take_effect, local_policy_modify_state_rejects_ineffective_policy, local_policy_modify_state_rejects_partial_profile_coverage); 3 external calls (is_err, new, format!).


##### `ensure_block_rule`  (lines 272–327)

```
fn ensure_block_rule(
    rules: &INetFwRules,
    spec: &BlockRuleSpec<'_>,
    log: &mut dyn Write,
) -> Result<()>
```

**Purpose**: Creates a firewall block rule if it is missing, or updates the existing rule if it is already present. This makes setup repeatable: running it twice should leave one correct rule, not duplicates.

**Data flow**: It receives the firewall rule collection, a rule specification, and a log writer. It looks up the rule by its stable internal name. If found, it casts it to the richer rule interface; if missing, it creates a new Windows Firewall rule, names it, configures it, and adds it. Then it configures the rule again to guarantee every field matches the current desired state and writes a log line describing the result.

**Call relations**: The outbound block setup and proxy-loopback setup use this as their rule creation/update workhorse. It hands the detailed rule fields to configure_rule and sends the final audit message to log_line.

*Call graph*: calls 2 internal fn (configure_rule, log_line); 5 external calls (from, Add, Item, format!, CoCreateInstance).


##### `configure_rule`  (lines 329–390)

```
fn configure_rule(rule: &INetFwRule3, spec: &BlockRuleSpec<'_>) -> Result<()>
```

**Purpose**: Fills in the common settings for a firewall block rule, such as description, direction, action, enabled state, profiles, network scope, and user scope. It also verifies that the rule really targets the intended offline user.

**Data flow**: It receives a Windows firewall rule object and the desired rule specification. It writes the friendly description, marks the rule as outbound, sets the action to block, enables it for all profiles, applies protocol/address/port limits, and sets the authorized local user list. Then it reads the user list back from Windows and checks that the offline SID appears there. It returns an error if any setting fails or the verification does not match.

**Call relations**: ensure_block_rule calls this whenever it creates or updates a rule. configure_rule delegates the network-specific parts to configure_rule_network_scope, then performs the user-scope read-back check before control returns to the rule setup flow.

*Call graph*: calls 2 internal fn (configure_rule_network_scope, new); called by 1 (ensure_block_rule); 10 external calls (from, LocalUserAuthorizedList, SetAction, SetDescription, SetDirection, SetEnabled, SetLocalUserAuthorizedList, SetProfiles, new, format!).


##### `configure_rule_network_scope`  (lines 392–420)

```
fn configure_rule_network_scope(rule: &INetFwRule3, spec: &BlockRuleSpec<'_>) -> Result<()>
```

**Purpose**: Sets the protocol, remote addresses, and optional remote ports for a firewall rule. This decides what kind of network traffic the rule applies to.

**Data flow**: It receives a firewall rule and a rule specification. It writes the protocol number, writes either the supplied remote address range or a wildcard for all addresses, and writes remote ports if the specification includes them. It returns success only if Windows accepts those network-scope values.

**Call relations**: configure_rule calls this while building the complete firewall rule. The production-scope unit test also exercises this part directly to confirm that the address and port strings used by real rules are acceptable to Windows Firewall.

*Call graph*: called by 1 (configure_rule); 4 external calls (from, SetProtocol, SetRemoteAddresses, SetRemotePorts).


##### `blocked_loopback_tcp_remote_ports`  (lines 422–453)

```
fn blocked_loopback_tcp_remote_ports(proxy_ports: &[u16]) -> Option<String>
```

**Purpose**: Builds the list of TCP loopback ports that should be blocked when only certain proxy ports are allowed. In plain terms, it takes the allowed ports and returns everything else.

**Data flow**: It receives a list of proxy ports. It removes zero, sorts the remaining ports, removes duplicates, and walks through the full valid port range from 1 to 65535. For every gap between allowed ports, it creates a blocked range string. It returns a comma-separated list of blocked ranges, or None if there is nothing to block.

**Call relations**: The proxy-only firewall setup uses this idea to narrow the broad loopback TCP block so approved proxy ports remain usable. The production firewall scope test also calls it to build the same kind of port complement used by real setup.

*Call graph*: calls 1 internal fn (port_range_string); called by 1 (production_firewall_rule_network_scopes_are_accepted_by_firewall_com); 2 external calls (new, from).


##### `port_range_string`  (lines 455–461)

```
fn port_range_string(start: u32, end: u32) -> String
```

**Purpose**: Formats one blocked port or a continuous blocked port range in the form Windows Firewall expects.

**Data flow**: It receives a start port and an end port. If they are the same, it returns just that one number as text; otherwise it returns text like “1000-2000”.

**Call relations**: blocked_loopback_tcp_remote_ports calls this while turning gaps between allowed proxy ports into firewall-ready range strings.

*Call graph*: called by 1 (blocked_loopback_tcp_remote_ports); 1 external calls (format!).


##### `log_line`  (lines 463–467)

```
fn log_line(log: &mut dyn Write, msg: &str) -> Result<()>
```

**Purpose**: Writes one timestamped message to the setup log. This gives operators a simple record of firewall changes made during setup.

**Data flow**: It receives a writable log destination and a message. It gets the current UTC time, formats it as a standard timestamp, writes the timestamp and message as one line, and returns any write error to the caller.

**Call relations**: ensure_block_rule uses this after configuring a rule, and remove_rule_if_present uses it after deleting a rule. It is the small shared logging tool for this file’s firewall operations.

*Call graph*: called by 2 (ensure_block_rule, remove_rule_if_present); 2 external calls (now, writeln!).


##### `tests::configured_remote_address_literals_are_accepted_by_firewall_com`  (lines 478–507)

```
fn configured_remote_address_literals_are_accepted_by_firewall_com()
```

**Purpose**: Checks that the hard-coded remote address strings in this file are accepted by the real Windows Firewall COM API. This catches mistakes in firewall address syntax before they break setup.

**Data flow**: The test initializes COM, tries to create temporary firewall rule objects, sets each candidate remote-address string, and asks Windows to read it back. It then uninitializes COM and asserts that every candidate was accepted.

**Call relations**: This test exercises the same Windows Firewall API that production setup uses. It does not add persistent project rules; it focuses on whether Windows accepts the address literals this file relies on.

*Call graph*: 3 external calls (assert!, CoInitializeEx, CoUninitialize).


##### `tests::production_firewall_rule_network_scopes_are_accepted_by_firewall_com`  (lines 510–571)

```
fn production_firewall_rule_network_scopes_are_accepted_by_firewall_com()
```

**Purpose**: Checks that the real network scopes used by the production firewall rules are valid according to Windows Firewall. This includes loopback UDP blocking, loopback TCP blocking with proxy-port exceptions, and non-loopback outbound blocking.

**Data flow**: The test initializes COM, builds representative rule specifications, computes the blocked TCP port ranges for a sample proxy port, creates temporary firewall rule objects, and applies only the network-scope settings. It uninitializes COM and asserts that every production-style scope was accepted.

**Call relations**: This test calls blocked_loopback_tcp_remote_ports to mirror the proxy-port complement logic and calls configure_rule_network_scope to verify the actual Windows-facing scope writer.

*Call graph*: calls 1 internal fn (blocked_loopback_tcp_remote_ports); 3 external calls (assert!, CoInitializeEx, CoUninitialize).


##### `tests::local_policy_modify_state_accepts_effective_policy`  (lines 574–576)

```
fn local_policy_modify_state_accepts_effective_policy()
```

**Purpose**: Confirms that the policy validator accepts the good case: Windows reports success and says local firewall modifications are effective.

**Data flow**: The test passes a successful Windows result and an OK modify state into validate_local_policy_modify_result. It asserts that the result is success.

**Call relations**: This is a direct unit test for the policy-checking rule used by ensure_local_policy_rules_take_effect during real firewall setup.

*Call graph*: 1 external calls (assert!).


##### `tests::local_policy_modify_state_rejects_ineffective_policy`  (lines 579–590)

```
fn local_policy_modify_state_rejects_ineffective_policy()
```

**Purpose**: Confirms that setup fails when Windows says group policy overrides local firewall changes. That protects the sandbox from being configured with rules that will not actually work.

**Data flow**: The test passes a successful query result together with a group-policy override modify state. It expects an error, extracts the project’s setup failure type, and checks that the error code says the firewall policy is ineffective.

**Call relations**: This test calls validate_local_policy_modify_result directly to prove the same guard used in real setup rejects overridden local firewall policy.

*Call graph*: calls 1 internal fn (validate_local_policy_modify_result); 1 external calls (assert_eq!).


##### `tests::local_policy_modify_state_rejects_partial_profile_coverage`  (lines 593–604)

```
fn local_policy_modify_state_rejects_partial_profile_coverage()
```

**Purpose**: Confirms that setup fails when Windows only guarantees the policy answer for some active firewall profiles, not all of them. The sandbox requires protection across the active profiles, not just part of them.

**Data flow**: The test passes the Windows partial-success result together with an otherwise OK modify state. It expects an error, extracts the setup failure, and checks that the error code marks the firewall policy as ineffective.

**Call relations**: This test calls validate_local_policy_modify_result directly to cover the partial-profile case that ensure_local_policy_rules_take_effect must reject during real setup.

*Call graph*: calls 1 internal fn (validate_local_policy_modify_result); 1 external calls (assert_eq!).


### `windows-sandbox-rs/src/wfp/filter_specs.rs`

`data_model` · `sandbox network filter setup`

This file is not code that runs by itself. It is a table of rule descriptions for the Windows Filtering Platform, or WFP, which is Windows’ built-in system for allowing or blocking network activity. Think of it like a checklist handed to a security guard: each entry says which doorway to watch, who the rule applies to, and what kind of traffic should be stopped.

The main data type is `FilterSpec`, which describes one firewall-style rule. Each rule has a stable Windows identifier, a short name, a human-readable description, the WFP layer where the rule should be installed, and a list of conditions. The conditions say what must match before the rule applies: the sandbox user, a network protocol such as ICMP for ping, or a remote port such as 53 for DNS.

`FILTER_SPECS` lists the actual rules. It blocks ICMP for both IPv4 and IPv6, which prevents ping-like traffic. It blocks DNS on port 53 and DNS-over-TLS on port 853, again for both IPv4 and IPv6. It also blocks SMB ports 445 and 139, which are commonly used for Windows file sharing. One comment notes that name-resolution-cache filters were deliberately left out because Windows rejected the simple static versions during validation.


### Spawn preparation and elevated runner plumbing
These files bridge resolved sandbox permissions into launch-ready state and implement the elevated helper-runner transport used for privileged execution paths.

### `windows-sandbox-rs/src/spawn_prep.rs`

`orchestration` · `startup before launching a sandboxed command`

Before a sandboxed command can run, the program has to do several careful setup steps. This file is that staging area. It turns a user-facing permission profile into concrete Windows rules, prepares environment variables, creates or loads special Windows security identifiers called SIDs (labels Windows uses to grant or deny access), and applies file access control rules.

There are two paths here. The “legacy” path runs the command using a restricted token and changes access control lists, or ACLs, on files and folders. An ACL is like a guest list on a folder: it says which identities may read or write there. The “elevated” path prepares credentials for a separate sandbox user and collects the capability SIDs that user should receive.

The file also handles practical details that would otherwise cause confusing failures: it makes sure the Codex home and sandbox log directory exist, sets pager programs to non-interactive behavior, normalizes the Windows null device, optionally inherits PATH, and can add the current folder as a safe Git directory. Network blocking for legacy sessions is enforced by rewriting proxy-related environment variables. Without this file, sandbox launches would be inconsistent: commands might write where they should not, fail to access allowed folders, leak network access, or fail because required temporary/log folders and security labels were missing.

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

**Purpose**: Builds the shared launch context used by sandbox startup paths. It resolves the permission profile, prepares safe environment defaults, creates the sandbox log area, starts logging, and records whether this run needs workspace-write capabilities.

**Data flow**: It receives a permission profile, workspace roots, Codex home path, current directory, environment map, command text, and setup options. It turns the profile into concrete permissions, edits the environment map for safe defaults, ensures needed directories exist, logs the command start, checks whether the current run needs write-capability security, and returns a SpawnContext with those results.

**Call relations**: This is the common first stage for legacy preparation and is also exercised directly by tests. Higher-level code calls it when it wants all ordinary spawn setup but not the legacy-only network rewrite.

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

**Purpose**: Prepares the basic context for the legacy sandbox launch path. It adds one legacy-specific step: if the permission profile says network access should be blocked, it rewrites the environment so common network clients are sent to a dead local proxy.

**Data flow**: It receives the same launch information as the common preparation function. It first gets a SpawnContext from prepare_spawn_context_common, then may mutate the environment map to mark no-network mode and block proxy-based traffic, and finally returns the same context.

**Call relations**: Legacy sandbox launchers call this before they create tokens and ACL rules. It depends on the common setup function for ordinary preparation and then hands a ready SpawnContext back to the legacy session flow.

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

**Purpose**: Creates the Windows security token and capability SIDs needed for a legacy sandbox session. In plain terms, it gives the future process a restricted identity that can only use the allowed file permissions.

**Data flow**: It takes whether write capabilities are needed, the Codex home, current directory, and candidate writable roots. If write capabilities are needed, it creates root-specific capability SIDs and builds a restricted token containing them. If not, it loads the shared read-only capability SID and builds a read-only token. It returns a LegacySessionSecurity object containing the token handle and the SIDs needed later for ACL changes.

**Call relations**: Legacy launch code calls this after it knows what kind of sandbox it is starting. It calls into token and capability helpers, then later apply_legacy_session_acl_rules uses the SIDs it produced to edit file permissions.

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

**Purpose**: Chooses which folders should receive capability SIDs in a legacy session. This matters because a workspace-write sandbox should only get write labels for the effective writable roots, not every path that happened to be allowed.

**Data flow**: It reads resolved permissions, the current directory, environment variables, and Codex home. It computes allowed paths first. If the run uses write capabilities, it narrows and adjusts those paths into effective write roots; otherwise it simply returns the allowed paths.

**Call relations**: Legacy launch and preflight code use this before creating security tokens. Tests check that it chooses runtime workspace roots correctly and excludes internal Codex sandbox folders when appropriate.

*Call graph*: calls 3 internal fn (compute_allow_paths_for_permissions, uses_write_capabilities_for_cwd, effective_write_roots_for_permissions); called by 5 (legacy_capability_roots_use_effective_write_roots, legacy_session_capability_roots_use_runtime_workspace_roots_for_workspace_root, spawn_windows_sandbox_session_legacy, run_windows_sandbox_capture_with_filesystem_overrides, run_windows_sandbox_legacy_preflight).


##### `root_capability_sids`  (lines 206–222)

```
fn root_capability_sids(
    codex_home: &Path,
    cwd: &Path,
    allow_paths: impl IntoIterator<Item = PathBuf>,
) -> Result<Vec<RootCapabilitySid>>
```

**Purpose**: Turns a set of writable root folders into Windows capability SIDs tied to those roots. It also removes duplicate roots so the sandbox does not receive repeated or stale security labels.

**Data flow**: It receives Codex home, current directory, and a list of allowed root paths. It sorts and deduplicates the roots using canonical paths, asks the capability system for the SID string for each root, converts each string into a LocalSid, and returns RootCapabilitySid records containing the root, SID object, and SID text.

**Call relations**: Both legacy and elevated preparation call this when workspace-write mode is active. Tests use it to confirm that only active writable roots become capabilities.

*Call graph*: calls 2 internal fn (workspace_write_cap_sid_for_root, from_string); called by 5 (prepare_elevated_spawn_context_for_permissions, prepare_legacy_session_security, legacy_deny_path_includes_nested_active_root_sid, root_capability_sids_only_include_active_roots, run_windows_sandbox_legacy_preflight); 2 external calls (into_iter, with_capacity).


##### `matching_root_capability`  (lines 224–232)

```
fn matching_root_capability(
    path: &Path,
    root_sids: &'a [RootCapabilitySid],
) -> Option<&'a RootCapabilitySid>
```

**Purpose**: Finds the best write-capability SID for a particular path. If several writable roots contain the path, it picks the most specific one, like choosing the closest matching folder rule rather than a broad parent rule.

**Data flow**: It takes a path and a list of root capability records. It filters to roots that contain the path, compares how specific those roots are, and returns the best matching record if one exists.

**Call relations**: apply_legacy_session_acl_rules uses this when granting access to allowed paths and when deciding whether the current directory is a workspace root that needs extra protection.

*Call graph*: called by 1 (apply_legacy_session_acl_rules); 1 external calls (iter).


##### `deny_root_capabilities_for_path`  (lines 234–247)

```
fn deny_root_capabilities_for_path(
    path: &Path,
    root_sids: &'a [RootCapabilitySid],
) -> Vec<&'a RootCapabilitySid>
```

**Purpose**: Decides which write-capability SIDs should be denied write access to a protected path. It is careful with nested writable roots, so a deny rule reaches every relevant capability that could touch the protected area.

**Data flow**: It receives a path and all root capability records. It finds capabilities whose roots overlap that path. If there are overlaps, it returns only those relevant capabilities; if none overlap, it returns all capabilities so the deny rule is broad enough.

**Call relations**: apply_legacy_session_acl_rules calls this while adding deny-write ACL entries. A test checks the important nested-root case, where both a workspace root and a nested active root must be denied.

*Call graph*: called by 2 (apply_legacy_session_acl_rules, legacy_deny_path_includes_nested_active_root_sid); 1 external calls (iter).


##### `allow_null_device_for_workspace_write`  (lines 249–264)

```
fn allow_null_device_for_workspace_write(is_workspace_write: bool)
```

**Purpose**: Allows the Windows null device for workspace-write sessions. The null device is a special discard target, similar to throwing output into a trash can, and many command-line programs expect it to work.

**Data flow**: It receives a flag saying whether the session uses workspace-write capabilities. If not, it does nothing. If yes, it gets the current token, extracts the logon SID bytes from it, grants that SID access to the null device, and closes the token handle.

**Call relations**: Legacy launch paths call this as a small compatibility step before running commands. It relies on token helpers to find the current logon SID and on ACL helper code to grant null-device access.

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

**Purpose**: Applies the actual file and folder access rules for a legacy sandbox session. It grants access where the sandbox is allowed, denies writes to protected paths, optionally denies reads to sensitive paths, and protects internal workspace folders.

**Data flow**: It receives resolved permissions, important paths, environment variables, extra deny-read and deny-write lists, and the SIDs created for this session. It computes allow and deny paths, creates explicit deny-write directories if needed, adds allow ACL entries for the right SID, adds deny-write ACL entries for relevant write capabilities, syncs persistent deny-read ACLs, grants null-device access, and protects .codex and agent folders when the command starts at the workspace root.

**Call relations**: Legacy launch and preflight flows call this after session security has been prepared. It uses matching_root_capability and deny_root_capabilities_for_path to pick the correct SID for each file rule, and it delegates the low-level ACL edits to ACL helper functions.

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

**Purpose**: Prepares the launch context for the elevated sandbox path, where a separate sandbox user account is used. It sets up environment defaults, computes read/write restrictions, asks for suitable sandbox credentials, and gathers the capability SIDs the process should carry.

**Data flow**: It receives already resolved permissions, paths, the environment map, command text, optional read/write root overrides, deny lists, and whether a proxy enforces networking. It edits the environment, creates the sandbox log area, computes allowed and denied paths, derives effective write roots if workspace-write mode is active, requests sandbox logon credentials with those restrictions, loads capability SID data, chooses either root-specific write capabilities or the read-only capability, grants null-device access, and returns an ElevatedSpawnContext.

**Call relations**: The elevated sandbox launcher calls this as its setup step. It brings together environment helpers, permission calculators, credential setup, capability loading, and null-device ACL setup into one ready-to-launch package.

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

**Purpose**: Creates a workspace-write permission profile for tests. It lets tests quickly vary the network policy and writable-root settings without repeating setup code.

**Data flow**: It receives a network policy, writable roots, and two booleans about temporary-directory exclusions. It passes those values into the permission-profile constructor and returns the resulting test profile.

**Call relations**: Several tests call this helper before resolving permissions or checking capability-root behavior. It keeps the test cases focused on what they are trying to prove.

*Call graph*: calls 1 internal fn (workspace_write_with).


##### `tests::workspace_roots_for`  (lines 478–480)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Builds the workspace-root list used by tests from a single filesystem path. It ensures the test path is treated as an absolute workspace root.

**Data flow**: It receives a path, converts it into an AbsolutePathBuf, wraps it in a one-item vector, and returns that vector.

**Call relations**: Tests use this helper before calling preparation or permission-resolution functions that expect workspace roots in the project’s absolute-path type.

*Call graph*: 1 external calls (vec!).


##### `tests::should_apply_network_block`  (lines 482–489)

```
fn should_apply_network_block(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Checks whether a permission profile resolves to a setup that should block network access. It gives network-related tests a short way to ask the production permission resolver the same question launch code would ask.

**Data flow**: It receives a permission profile, resolves it with no workspace roots, asks the resolved permissions whether network blocking applies, and returns that boolean.

**Call relations**: The network-policy tests call this helper to verify the intended behavior for default workspace-write and explicitly network-enabled profiles.

*Call graph*: calls 1 internal fn (try_from_permission_profile_for_workspace_roots).


##### `tests::no_network_env_rewrite_applies_for_workspace_write`  (lines 492–496)

```
fn no_network_env_rewrite_applies_for_workspace_write()
```

**Purpose**: Verifies that the default workspace-write profile requests network blocking. This protects the expectation that workspace-write sandboxes are offline unless configured otherwise.

**Data flow**: It builds the default workspace-write profile, asks whether network blocking should apply, and asserts that the answer is true.

**Call relations**: This test covers the permission-resolution decision that prepare_legacy_spawn_context later uses to decide whether to rewrite network environment variables.

*Call graph*: 1 external calls (assert!).


##### `tests::no_network_env_rewrite_skips_when_network_access_is_allowed`  (lines 499–506)

```
fn no_network_env_rewrite_skips_when_network_access_is_allowed()
```

**Purpose**: Verifies that network blocking is not applied when the profile explicitly allows network access. This prevents the sandbox from unexpectedly breaking network-allowed commands.

**Data flow**: It builds a workspace-write test profile with network access enabled, asks whether network blocking should apply, and asserts that the answer is false.

**Call relations**: This test complements the default-blocking test and checks the condition used by the legacy spawn preparation path.

*Call graph*: 1 external calls (assert!).


##### `tests::legacy_spawn_env_applies_offline_network_rewrite`  (lines 509–534)

```
fn legacy_spawn_env_applies_offline_network_rewrite()
```

**Purpose**: Checks that legacy spawn preparation actually rewrites the environment for an offline sandbox. It proves that the permission decision becomes concrete environment changes.

**Data flow**: It creates temporary Codex home and current-directory folders, starts with an empty environment map, prepares a legacy workspace-write context, and then asserts that no-network marker and proxy variables were added.

**Call relations**: This test calls prepare_legacy_spawn_context, which calls the common setup and then the network rewrite helper. It verifies the legacy-only behavior that common setup deliberately does not perform.

*Call graph*: calls 2 internal fn (workspace_write, prepare_legacy_spawn_context); 4 external calls (new, new, assert_eq!, workspace_roots_for).


##### `tests::common_spawn_env_keeps_network_env_unchanged`  (lines 537–566)

```
fn common_spawn_env_keeps_network_env_unchanged()
```

**Purpose**: Checks that the shared preparation function does not rewrite network proxy settings. This is important because only the legacy path should apply that particular no-network environment trick.

**Data flow**: It creates temporary folders and an environment map with an existing HTTP proxy, runs prepare_spawn_context_common, then asserts that the no-network marker was not added and the proxy value stayed unchanged. It also checks that the resulting context uses write capabilities.

**Call relations**: This test calls the common preparation function directly. It protects the split between shared setup and legacy-specific network blocking.

*Call graph*: calls 2 internal fn (workspace_write, prepare_spawn_context_common); 5 external calls (from, new, assert!, assert_eq!, workspace_roots_for).


##### `tests::legacy_session_capability_roots_use_runtime_workspace_roots_for_workspace_root`  (lines 569–602)

```
fn legacy_session_capability_roots_use_runtime_workspace_roots_for_workspace_root()
```

**Purpose**: Verifies that legacy capability roots use the actual runtime workspace root when the command runs inside a workspace subdirectory. This keeps write permission attached to the right top-level workspace rather than only the current subfolder.

**Data flow**: It creates temporary Codex and workspace directories, resolves a workspace-write profile, calls legacy_session_capability_roots for a command current directory inside the workspace, and asserts that the returned root is the canonical workspace root.

**Call relations**: This test exercises legacy_session_capability_roots and the permission resolver together. It confirms the launch path will create capability SIDs for the intended workspace root.

*Call graph*: calls 2 internal fn (try_from_permission_profile_for_workspace_roots, legacy_session_capability_roots); 6 external calls (new, new, assert_eq!, create_dir_all, workspace_profile, workspace_roots_for).


##### `tests::root_capability_sids_only_include_active_roots`  (lines 605–639)

```
fn root_capability_sids_only_include_active_roots()
```

**Purpose**: Verifies that root_capability_sids returns SIDs only for roots supplied to the current run. It prevents old or unrelated capability SIDs from being accidentally included.

**Data flow**: It creates temporary Codex, workspace, active-root, and stale-root directories. It computes expected SIDs for several roots, calls root_capability_sids with only the workspace and active root, and asserts that those two are present while the stale and generic workspace capability SIDs are absent.

**Call relations**: This test directly covers root_capability_sids, which both legacy and elevated preparation rely on when workspace-write mode is active.

*Call graph*: calls 3 internal fn (load_or_create_cap_sids, workspace_write_cap_sid_for_root, root_capability_sids); 5 external calls (new, assert!, assert_eq!, create_dir_all, vec!).


##### `tests::legacy_deny_path_includes_nested_active_root_sid`  (lines 642–675)

```
fn legacy_deny_path_includes_nested_active_root_sid()
```

**Purpose**: Verifies that deny-write rules include both a parent workspace capability and a nested active-root capability when a protected path overlaps both. This closes a subtle hole where a nested writable root might otherwise bypass a deny rule.

**Data flow**: It creates a workspace, a protected directory, a nested writable root under that protected area, and an unrelated root. It builds capability records, asks deny_root_capabilities_for_path which SIDs should be denied for the protected directory, and asserts that the workspace and nested SIDs are returned but the unrelated SID is not.

**Call relations**: This test focuses on deny_root_capabilities_for_path, the helper used by apply_legacy_session_acl_rules when adding deny-write ACL entries.

*Call graph*: calls 3 internal fn (workspace_write_cap_sid_for_root, deny_root_capabilities_for_path, root_capability_sids); 5 external calls (new, assert!, assert_eq!, create_dir_all, vec!).


##### `tests::legacy_capability_roots_use_effective_write_roots`  (lines 678–715)

```
fn legacy_capability_roots_use_effective_write_roots()
```

**Purpose**: Verifies that legacy capability roots are based on effective write roots, not every configured writable path. In particular, internal Codex home and sandbox directories should not become writable capabilities for the command.

**Data flow**: It creates temporary workspace, Codex home, active-root, and sandbox-root directories, builds a profile listing several writable roots, resolves permissions, calls legacy_session_capability_roots, and asserts that the workspace and active root are included while Codex home and the sandbox directory are excluded.

**Call relations**: This test protects the behavior of legacy_session_capability_roots and effective_write_roots_for_permissions in the legacy launch flow.

*Call graph*: calls 2 internal fn (try_from_permission_profile_for_workspace_roots, legacy_session_capability_roots); 7 external calls (new, new, assert!, create_dir_all, vec!, workspace_profile, workspace_roots_for).


### `windows-sandbox-rs/src/elevated_impl.rs`

`orchestration` · `command execution`

This file exists so Codex can run a user command with Windows sandbox limits instead of giving it normal full access to the machine. Think of it like sending a worker into a locked room with a written pass: the pass says which folders can be read or written, and the worker reports back with stdout, stderr, and an exit code.

The main request type, ElevatedSandboxProfileCaptureRequest, gathers everything needed for that run: the permission profile, workspace folders, current directory, environment variables, timeout, cancellation token, and optional overrides for readable or writable paths.

On Windows, the main function turns the permission profile into concrete Windows sandbox permissions, prepares the environment, creates a sandbox log area, gets or refreshes sandbox login credentials, and builds capability SIDs. A SID is a Windows security identifier, like a named badge that access-control lists can recognize. The file also grants access to the Windows null device when needed, so redirected input or output can work safely.

It then starts a sandbox runner process and talks to it through framed IPC, meaning messages are sent in clear packets over a pipe. The runner sends output chunks and finally an exit message. This file collects those chunks, watches for cancellation, logs success or failure, and returns a CaptureResult. On non-Windows systems, the same public function exists but immediately reports that Windows sandboxing is unavailable.

#### Function details

##### `windows_impl::spawn_cancel_writer`  (lines 67–95)

```
fn spawn_cancel_writer(
        pipe_write: &File,
        cancellation: Option<crate::WindowsSandboxCancellationToken>,
    ) -> Result<Option<(std::thread::JoinHandle<()>, Arc<AtomicBool>)>>
```

**Purpose**: This helper starts a small background thread that watches for a cancellation request. If cancellation happens, it sends a terminate message to the sandbox runner through the pipe, so the command can be stopped instead of continuing to run.

**Data flow**: It receives the writable end of the runner pipe and an optional cancellation token. If there is no token, it returns nothing to watch. If there is a token, it clones the pipe handle, creates a shared done flag, and starts a thread that checks the token every 50 milliseconds. When cancellation is seen, the thread writes a terminate frame to the runner. The function returns the thread handle and done flag so the caller can cleanly stop the watcher later.

**Call relations**: The main sandbox capture function calls this after the runner has been started and the IPC pipe is available. While the main function reads output and exit messages from the runner, this helper sits beside it as a safety cord. When the main run finishes, the caller sets the done flag, wakes the thread, and joins it so no background thread is left behind.

*Call graph*: 5 external calls (clone, new, new, try_clone, spawn).


##### `windows_impl::run_windows_sandbox_capture_for_permission_profile`  (lines 99–282)

```
fn run_windows_sandbox_capture_for_permission_profile(
        request: ElevatedSandboxProfileCaptureRequest<'_>,
    ) -> Result<CaptureResult>
```

**Purpose**: This is the main Windows implementation for running a command under the sandbox user and collecting its result. It takes a friendly permission profile and turns it into a real sandboxed process run, including setup, execution, output capture, cancellation, logging, and error handling.

**Data flow**: It receives one request containing the command, working directory, environment, permission profile, workspace roots, timeout, cancellation token, and path overrides. First it resolves the permission profile into concrete Windows permissions, cleans and augments the environment, prepares a writable sandbox log/home area, and obtains sandbox credentials. It then loads or creates capability SIDs, grants needed access to the null device, builds a spawn request for the runner, and starts communication with that runner. As framed messages come back, it decodes stdout and stderr chunks into byte buffers, waits for the exit message, records whether the process timed out, logs success or failure, and returns a CaptureResult containing exit code, stdout, stderr, and timeout status.

**Call relations**: This function is the central coordinator for the Windows path. It calls permission resolution, environment preparation, credential setup, capability setup, access-control setup, runner spawning, IPC reading and writing, and logging helpers in sequence. If starting the runner fails because sandbox credentials are stale, it refreshes those credentials and tries once more. During execution it calls the cancellation helper so a caller-requested stop can be forwarded to the runner.

*Call graph*: calls 12 internal fn (allow_null_device, load_or_create_cap_sids, ensure_non_interactive_pager, inherit_path_env, normalize_null_device_env, require_logon_sandbox_creds, log_start, try_from_permission_profile_for_workspace_roots, ensure_codex_home_exists, inject_git_safe_directory (+2 more)); 2 external calls (bail!, vec!).


##### `stub::run_windows_sandbox_capture_for_permission_profile`  (lines 304–308)

```
fn run_windows_sandbox_capture_for_permission_profile(
        _request: ElevatedSandboxProfileCaptureRequest<'_>,
    ) -> Result<CaptureResult>
```

**Purpose**: This is the non-Windows fallback for the same public API. It exists so the crate can compile on other operating systems while clearly saying that this feature only works on Windows.

**Data flow**: It receives the same sandbox capture request shape as the Windows implementation, but it does not inspect or use it. Instead, it immediately returns an error explaining that the Windows sandbox is only available on Windows.

**Call relations**: This function is exported only when the code is built for a non-Windows target. It stands in place of the real Windows implementation, so callers get a clear runtime error instead of missing symbols or accidental unsupported behavior.

*Call graph*: 1 external calls (bail!).


### `windows-sandbox-rs/src/elevated/mod.rs`

`orchestration` · `compile-time module organization`

This is a small module index file. In Rust, a `mod.rs` file works a bit like a table of contents for a folder: it does not do the work itself, but it makes the files inside the folder visible to the rest of the program.

Here, it declares three internal modules: `ipc_framed`, `runner_client`, and `runner_pipe`. The `pub(crate)` wording means these modules can be used anywhere inside this Rust crate, but they are not exposed as part of a public library interface. In plain terms, they are shared building blocks for this project, not something outside users are meant to call directly.

The names suggest this folder is about talking to an elevated runner process: `ipc` means inter-process communication, which is how separate programs or processes exchange messages; `framed` usually means messages are wrapped with clear boundaries so the receiver knows where one message ends and the next begins; `runner_client` likely contains the client-side code that asks the elevated runner to do work; and `runner_pipe` likely uses Windows pipes, a standard way for processes to communicate.

Without this file, those modules would not be connected under the `elevated` namespace, and other parts of the crate would not be able to refer to them through this organized path.


### `windows-sandbox-rs/src/elevated/runner_client.rs`

`io_transport` · `sandbox runner startup and pipe handshake`

This file is the bridge between the main program and a helper process called the runner. The runner is launched under sandbox credentials, meaning it runs as a separate Windows user with limited permissions. Without this file, the program could not reliably start commands inside that sandboxed account, and failed launches could leave behind stray runner processes.

The file first creates a pair of Windows named pipes. A named pipe is like a private phone line between two programs on the same machine. One pipe is used to send messages to the runner, and the other is used to read messages back. It then finds the runner executable, builds a Windows command line, and starts it with `CreateProcessWithLogonW`, which is the Windows call for launching a program as a specific user.

Startup is treated carefully. The code waits for the runner to connect to both pipes, but uses timeouts so a stuck connection does not freeze the parent forever. After the pipes connect, it sends the initial spawn request and waits for a `SpawnReady` reply. If anything goes wrong before that point, it closes pipe handles and terminates the runner process so there is no orphan helper left running.

It also marks logon failures in a recognizable way, so higher-level code can tell when saved sandbox credentials have gone stale.

#### Function details

##### `RunnerLogonError::fmt`  (lines 59–61)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This turns a Windows logon-launch failure into a readable error message. It keeps the raw Windows error code visible so callers can decide what kind of failure happened.

**Data flow**: It receives a `RunnerLogonError` containing a numeric Windows error code and a formatter to write into. It writes a short message that includes that code. The result is text that can be shown in logs or wrapped inside a larger error.

**Call relations**: This is used automatically when `RunnerLogonError` is displayed as an error. `spawn_runner_transport` creates this error when Windows refuses to launch the runner with the supplied sandbox username and password.

*Call graph*: 1 external calls (write!).


##### `is_stale_sandbox_creds_error`  (lines 71–74)

```
fn is_stale_sandbox_creds_error(err: &anyhow::Error) -> bool
```

**Purpose**: This checks whether an error means the saved sandbox login details no longer work. Higher-level code can use this to know when it should recreate or refresh the sandbox user credentials.

**Data flow**: It receives a general error value, looks inside it for a `RunnerLogonError`, and checks whether the stored Windows error code is `ERROR_LOGON_FAILURE`. It returns `true` only for that specific failed-login case, and `false` for other errors.

**Call relations**: It is called by `spawn_windows_sandbox_session_elevated_for_permission_profile` after runner startup fails. That caller can then treat bad credentials differently from ordinary pipe, process, or setup failures.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile).


##### `RunnerTransport::send_spawn_request`  (lines 77–85)

```
fn send_spawn_request(&mut self, request: SpawnRequest) -> Result<()>
```

**Purpose**: This sends the first instruction to the runner telling it what command or session setup it should prepare. It wraps the request in the project’s framed message format so the runner can decode it safely.

**Data flow**: It takes a `SpawnRequest`, adds the current IPC protocol version, labels it as a `SpawnRequest` message, and writes it to the outgoing pipe. The main visible result is bytes sent to the runner; if writing fails, an error comes back.

**Call relations**: During runner startup, `spawn_runner_transport` uses this after both pipes have connected. It hands the finished message to `write_frame`, which does the low-level job of writing one complete framed message to the pipe.

*Call graph*: calls 1 internal fn (write_frame); 1 external calls (new).


##### `RunnerTransport::read_spawn_ready`  (lines 87–98)

```
fn read_spawn_ready(&mut self) -> Result<()>
```

**Purpose**: This waits for the runner to confirm that it received the spawn request and is ready. It protects startup from moving on too early or hanging forever.

**Data flow**: It reads from the incoming pipe. First it waits until a complete framed message is available, then decodes that frame. If the message is `SpawnReady`, it returns success. If the runner reports an error, closes the pipe, or sends an unexpected message, it returns an explanatory error.

**Call relations**: It is used in the startup handshake after `send_spawn_request`. It relies on `wait_for_complete_frame` to avoid blocking forever on a partial message, and then calls `read_frame` to decode the actual message.

*Call graph*: calls 2 internal fn (read_frame, wait_for_complete_frame); 1 external calls (anyhow!).


##### `RunnerTransport::into_files`  (lines 100–102)

```
fn into_files(self) -> (File, File)
```

**Purpose**: This gives back the two pipe files owned by the transport. Someone would use it when they need direct access to the raw read and write streams after startup has completed.

**Data flow**: It consumes the `RunnerTransport`, taking ownership of its write pipe and read pipe. It returns those two `File` objects as a pair, so the caller becomes responsible for using and eventually closing them.

**Call relations**: This is a handoff point after the transport has done its startup job. Instead of sending a protocol message itself, it transfers the connected pipe objects to later code that will continue communication with the runner.


##### `try_take_completed_connect_result`  (lines 105–124)

```
fn try_take_completed_connect_result(
    connect_thread: &mut Option<thread::JoinHandle<()>>,
    connect_result_rx: &mpsc::Receiver<Result<()>>,
    thread_handle: HANDLE,
    pipe_label: &str,
) ->
```

**Purpose**: This checks whether a helper thread that was connecting a pipe has already finished. It is used during timeout handling to avoid cancelling work that actually completed just in time.

**Data flow**: It receives the optional helper thread, a channel where that thread reports its result, the Windows handle for that thread, and a human-readable pipe label. It asks Windows whether the thread has finished. If not, it returns `None`. If it has, it joins the thread, reads the reported result from the channel, and returns it.

**Call relations**: `connect_pipe_with_timeout` calls this when a pipe connection appears to have timed out. The function acts like checking whether someone arrived just as you were about to leave; if the connection already completed, the caller can use that result instead of treating it as a timeout.

*Call graph*: calls 1 internal fn (recv); called by 1 (connect_pipe_with_timeout); 1 external calls (WaitForSingleObject).


##### `connect_pipe_with_timeout`  (lines 126–236)

```
fn connect_pipe_with_timeout(
    h_pipe: HANDLE,
    expected_runner_pid: u32,
    pipe_label: &str,
) -> Result<()>
```

**Purpose**: This waits for the runner process to connect to one named pipe, but only for a limited time. It prevents startup from hanging forever if the runner crashes, never starts, or connects incorrectly.

**Data flow**: It receives a pipe handle, the process ID expected to connect, and a label such as `pipe-in` or `pipe-out`. It starts a helper thread to do the blocking pipe connection. The main thread waits for the result with a timeout. If the connection succeeds, it returns success. If time runs out, it tries to cancel the blocking Windows call and returns a timeout error.

**Call relations**: `spawn_runner_transport` calls this once for each pipe during startup. It uses `try_take_completed_connect_result` in racey moments where the timeout and successful connection may happen almost together, and it calls Windows cancellation and handle-closing functions to clean up safely.

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

**Purpose**: This is the main setup routine for creating a working connection to the sandbox runner. It creates pipes, launches the runner as the sandbox user, waits for both sides to connect, sends the first request, and returns a ready-to-use `RunnerTransport`.

**Data flow**: It takes paths for the project home and working directory, sandbox username and password, an optional log directory, and the initial spawn request. It creates two named pipes, builds the runner command line, converts strings into the wide-character form Windows expects, and launches the runner with those credentials. It then connects both pipes, wraps the raw pipe handles as `File` objects, sends the spawn request, waits for `SpawnReady`, and returns the transport. On failure, it closes handles and may terminate the runner so nothing is left behind.

**Call relations**: This is the central flow in the file. It calls pipe helpers such as `pipe_pair`, `create_named_pipe`, and `find_runner_exe`, Windows launch functions, `connect_pipe_with_timeout` for the pipe handshake, and the `RunnerTransport` methods for the protocol handshake.

*Call graph*: calls 4 internal fn (create_named_pipe, find_runner_exe, pipe_pair, to_wide); 9 external calls (from_raw_handle, format!, null, zeroed, CloseHandle, GetLastError, SetErrorMode, CreateProcessWithLogonW, TerminateProcess).


##### `wait_for_complete_frame`  (lines 370–414)

```
fn wait_for_complete_frame(pipe_read: &File, timeout: Duration) -> Result<()>
```

**Purpose**: This waits until a full framed message is available on the read pipe before trying to decode it. That matters because pipe data can arrive in pieces, and reading too early could block or fail at an awkward point.

**Data flow**: It receives the read pipe and a timeout. It repeatedly peeks at the pipe without consuming data, first checking whether the four-byte message length is present, then checking whether the whole message body has arrived. If the full frame appears before the deadline, it returns success. If the pipe fails or the deadline passes, it returns an error.

**Call relations**: `RunnerTransport::read_spawn_ready` calls this before `read_frame`. It is the waiting room for incoming messages: it does not interpret the message, but it makes sure the complete package is there before the decoder opens it.

*Call graph*: called by 1 (read_spawn_ready); 8 external calls (as_raw_handle, now, anyhow!, null_mut, sleep, from_le_bytes, GetLastError, PeekNamedPipe).


##### `tests::stale_sandbox_creds_error_recognizes_logon_failures`  (lines 425–434)

```
fn stale_sandbox_creds_error_recognizes_logon_failures()
```

**Purpose**: This test proves that only a Windows logon failure is treated as stale sandbox credentials. It guards against accidentally classifying unrelated launch errors as password or account problems.

**Data flow**: It builds two sample errors: one with `ERROR_LOGON_FAILURE` and one with `ERROR_NOT_FOUND`. It runs both through `is_stale_sandbox_creds_error` and checks that the answers are `true` and `false` respectively.

**Call relations**: The test exercises the public credential-error helper used by higher-level sandbox startup code. It does not start a runner or touch real pipes; it focuses only on the error-recognition rule.

*Call graph*: 1 external calls (assert_eq!).


### `windows-sandbox-rs/src/elevated/runner_pipe.rs`

`io_transport` · `elevated runner startup and IPC setup`

This file is part of the elevated Windows sandbox path. When the main program needs a helper process to run commands inside the sandbox, the parent and helper need a safe way to talk. On Windows, this code uses named pipes, which are like private mailbox slots that two processes can open by name.

The important problem here is trust. The parent process is elevated, so it must not accidentally accept messages from some other process pretending to be the runner. This file helps prevent that in three ways. First, it creates hard-to-guess pipe names with random data. Second, it gives each pipe a Windows access rule, called a DACL, that allows only the sandbox user account to connect. A DACL is simply a permission list attached to the pipe. Third, after a process connects, it asks Windows for that client process ID and checks it against the runner process ID the parent expected.

The file also knows how to locate the runner executable before launch. Together, these helpers are the setup plumbing for the communication channel: find the helper program, create two secure pipe endpoints, wait for the runner to connect, then prove the connection came from the right process.

#### Function details

##### `find_runner_exe`  (lines 43–45)

```
fn find_runner_exe(codex_home: &Path, log_dir: Option<&Path>) -> PathBuf
```

**Purpose**: Finds the executable file for the elevated command runner. It prefers the copied helper placed under the sandbox helper area, but can fall back to the older lookup method if needed.

**Data flow**: It receives the project home directory and, optionally, a log directory. It passes those along with the specific helper type, `CommandRunner`, to the shared helper-resolution code. The result is a filesystem path pointing to the runner program that should be launched.

**Call relations**: When `spawn_runner_transport` is preparing to start the elevated runner, it calls this function to learn which executable to launch. This function delegates the real lookup rules to `resolve_helper_for_launch`, so the pipe setup code does not need to know every place the helper might live.

*Call graph*: calls 1 internal fn (resolve_helper_for_launch); called by 1 (spawn_runner_transport).


##### `pipe_pair`  (lines 48–53)

```
fn pipe_pair() -> (String, String)
```

**Purpose**: Creates two unique Windows named-pipe paths: one for input and one for output. These names are used as the private communication channels between the parent and the runner.

**Data flow**: It starts with a fresh random number from the operating system-backed random generator. It formats that number into a pipe name such as a `codex-runner-...` base name, then returns two strings made from that base: one ending in `-in` and one ending in `-out`.

**Call relations**: `spawn_runner_transport` calls this while building the transport for a new runner session. The returned names are later used when creating the server-side pipes and when telling the runner which pipe names to open.

*Call graph*: called by 1 (spawn_runner_transport); 2 external calls (from_entropy, format!).


##### `create_named_pipe`  (lines 56–103)

```
fn create_named_pipe(name: &str, access: u32, sandbox_username: &str) -> io::Result<HANDLE>
```

**Purpose**: Creates one Windows named pipe and attaches permissions so only the sandbox user can connect to it. This is the security gate that keeps unrelated local processes from using the parent-runner channel.

**Data flow**: It receives a pipe name, an access direction such as inbound or outbound, and the sandbox user name. It looks up that user’s Windows SID, which is the stable security identifier Windows uses internally, converts it into text, builds a permission string that grants that user access, and asks Windows to turn that string into a security descriptor. It then creates the named pipe with byte-stream behavior and fixed buffer sizes. On success it returns a Windows handle to the pipe; on failure it returns an I/O error with the Windows error code. It also frees the temporary security descriptor after the pipe is created.

**Call relations**: `spawn_runner_transport` calls this after pipe names have been generated. This function relies on `resolve_sid`, `string_from_sid_bytes`, and `to_wide` to translate Rust strings and user names into the Windows forms needed by the operating system calls. It then hands back a pipe handle that later code can wait on and use for communication.

*Call graph*: calls 3 internal fn (resolve_sid, string_from_sid_bytes, to_wide); called by 1 (spawn_runner_transport); 7 external calls (from_raw_os_error, format!, null_mut, GetLastError, LocalFree, ConvertStringSecurityDescriptorToSecurityDescriptorW, CreateNamedPipeW).


##### `connect_pipe`  (lines 110–135)

```
fn connect_pipe(h: HANDLE, expected_runner_pid: u32) -> io::Result<()>
```

**Purpose**: Waits for the runner process to connect to a named pipe, then verifies that the connected client is really the expected runner. This prevents a wrong or malicious process from slipping into the communication channel.

**Data flow**: It receives an already-created pipe handle and the process ID of the runner that the parent expects. It calls Windows to wait for a client connection. If Windows reports that the client connected just before the wait call, it accepts that normal race condition. It then asks Windows for the connected client’s process ID. If the ID matches the expected runner ID, it returns success. If the pipe fails or the client process ID is different, it returns an error.

**Call relations**: This is the final handshake step after the parent has created a server-side pipe and launched the runner. It calls Windows pipe APIs directly: `ConnectNamedPipe` to wait for the connection and `GetNamedPipeClientProcessId` to identify who connected. The function does not hand off to another project function; its job is to turn the low-level Windows result into a clear success or failure for the caller.

*Call graph*: 7 external calls (from_raw_os_error, new, format!, null_mut, GetLastError, ConnectNamedPipe, GetNamedPipeClientProcessId).


### Process launch and interactive I/O internals
These files handle the concrete Windows process creation details, desktop and startup attributes, ConPTY support, and stdio bridging for sandboxed sessions.

### `windows-sandbox-rs/src/process.rs`

`io_transport` · `process launch and output capture`

Windows process launching has many sharp edges: arguments must be turned into one command-line string, environment variables must be packed in a special format, input and output handles must be safe for the child process to inherit, and some restricted processes need an explicit desktop to start correctly. This file gathers those details in one place.

The central path is `create_process_as_user`. It takes a Windows user token, command arguments, a working folder, environment variables, optional standard input/output handles, and desktop settings. It prepares everything in the form Windows expects, then calls `CreateProcessAsUserW`, the Windows function that starts a process as another user. If something fails, it records useful debugging details.

The file also supports pipe-based launching. Think of pipes like hoses connected to the child process: one hose can feed input in, and others can carry output and errors back out. `spawn_process_with_pipes` creates those hoses, gives the correct ends to the child, closes the ends the parent should not keep, and returns the handles the caller needs.

Finally, `read_handle_loop` starts a background thread that keeps reading from one of those output handles until the child closes it.

#### Function details

##### `make_env_block`  (lines 39–56)

```
fn make_env_block(env: &HashMap<String, String>) -> Vec<u16>
```

**Purpose**: This function turns a normal map of environment variables into the special block of text that Windows expects when starting a process. Without this conversion, the new process would not receive its intended environment correctly.

**Data flow**: It receives key-value pairs such as `PATH` and `TEMP`. It sorts them in a Windows-friendly order, converts each `key=value` string into wide characters, meaning UTF-16 text used by many Windows APIs, separates entries with zero characters, and ends the whole block with an extra zero. It returns that finished UTF-16 environment block.

**Call relations**: When a process is about to be started, `create_process_as_user` calls this to prepare the child’s environment. A related ConPTY launch path also calls it, so both normal and console-backed launches can pass environment variables to Windows in the required shape.

*Call graph*: calls 1 internal fn (to_wide); called by 2 (spawn_conpty_process_as_user, create_process_as_user); 2 external calls (new, format!).


##### `ensure_inheritable_stdio`  (lines 58–73)

```
fn ensure_inheritable_stdio(si: &mut STARTUPINFOW) -> Result<()>
```

**Purpose**: This function makes the current process’s standard input, standard output, and standard error handles available to a child process. It is used when the caller has not supplied custom pipes or handles.

**Data flow**: It receives a mutable Windows startup information structure. It asks Windows for the current standard handles, marks each one as inheritable so the child can use it, then writes those handles into the startup information and sets the flag that says standard handles are being provided. On success it changes the startup information in place; on failure it returns an error.

**Call relations**: `create_process_as_user` calls this in the simpler launch path where no custom standard input/output handles were provided. It hands Windows startup information that is ready for `CreateProcessAsUserW`, so the child process connects to the same console streams as the parent.

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

**Purpose**: This is the main process-launching function. It starts a new Windows process using a supplied user token, which is a Windows handle proving which user/security context the child should run as.

**Data flow**: It receives the user token, command arguments, working directory, environment map, optional logging directory, optional standard input/output/error handles, and a choice about using a private desktop. It turns the arguments into a Windows command line, converts paths and environment data into Windows UTF-16 form, prepares the launch desktop, fills in Windows startup structures, and calls `CreateProcessAsUserW`. If custom handles are supplied, it also builds a limited inherited-handle list so the child gets only the intended handles. It returns a `CreatedProcess` containing the Windows process information, startup information, and desktop guard; if launch fails, it logs details and returns an error.

**Call relations**: Higher-level code calls this when it needs a sandboxed command to actually begin running. `spawn_process_with_pipes` calls it after creating pipe handles, while another sandbox capture flow calls it directly. Inside, it relies on helpers such as `make_env_block`, `ensure_inheritable_stdio`, desktop preparation, command-line formatting, and error logging before handing the final request to Windows.

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

**Purpose**: This function starts a process whose input and output are connected to anonymous pipes, so the parent program can write to the child and read what it prints. It is useful when the sandbox needs to capture output instead of letting it go straight to the parent console.

**Data flow**: It receives the same basic launch details as `create_process_as_user`, plus choices for whether stdin should stay open and whether stderr should be merged with stdout or kept separate. It creates pipe pairs for stdin and stdout, and optionally stderr. It passes the child-side pipe ends into `create_process_as_user`, then closes the child-side handles in the parent so ownership is clean. It returns the process information plus the parent-side handles for writing input and reading output. If anything fails, it closes any handles it already opened before returning the error.

**Call relations**: `spawn_legacy_process` calls this when it wants a traditional pipe-based child process. This function does the setup work, delegates the actual Windows process creation to `create_process_as_user`, and then hands back only the handles the caller should keep using.

*Call graph*: calls 1 internal fn (create_process_as_user); called by 1 (spawn_legacy_process); 5 external calls (anyhow!, matches!, null_mut, CloseHandle, CreatePipe).


##### `read_handle_loop`  (lines 329–355)

```
fn read_handle_loop(handle: HANDLE, mut on_chunk: F) -> std::thread::JoinHandle<()>
```

**Purpose**: This function starts a background reader for a Windows handle, usually the read end of a pipe connected to a child process’s output. It lets the rest of the program keep running while output is collected piece by piece.

**Data flow**: It receives a handle and a callback function called `on_chunk`. It starts a new thread, repeatedly reads up to 8192 bytes from the handle, and passes each non-empty chunk of bytes to the callback. When reading fails or reaches end-of-file, it stops the loop and closes the handle. It returns the thread handle so the caller can track or join that background work.

**Call relations**: `spawn_output_reader` calls this after a process has been launched with readable output handles. This function takes over the low-level reading loop and hands each piece of output upward through the callback.

*Call graph*: called by 1 (spawn_output_reader); 1 external calls (spawn).


### `windows-sandbox-rs/src/desktop.rs`

`domain_logic` · `process launch setup`

On Windows, a “desktop” is not just the visible screen background. It is also a container for windows, menus, input hooks, and other user-interface objects. Putting an untrusted program on a separate desktop is like giving it its own locked room: it can draw windows there, but it is less able to interfere with windows on the user’s normal desktop.

This file prepares that room before a sandboxed process is launched. If private desktop mode is off, it simply points the new process at the standard desktop, `Winsta0\Default`. If private desktop mode is on, it creates a new desktop with a random name, gives the current logon session permission to use it, and returns the desktop name in the format Windows expects during process startup.

A key detail is permissions. Creating the desktop is not enough; the restricted process must still be allowed to create windows and interact with objects on that desktop. The `grant_desktop_access` helper edits the desktop’s access list, which is Windows’ record of who may do what. If anything fails, the file writes debug logs when possible and returns an error instead of launching into a broken desktop.

The private desktop is automatically closed when its owner object is dropped, so callers do not have to remember to clean it up manually.

#### Function details

##### `LaunchDesktop::prepare`  (lines 63–77)

```
fn prepare(use_private_desktop: bool, logs_base_dir: Option<&Path>) -> Result<Self>
```

**Purpose**: This prepares the desktop setting that will be passed to Windows when starting the sandboxed process. It either creates a new private desktop for isolation or selects the normal default desktop.

**Data flow**: It receives a yes-or-no choice for private desktop use and an optional folder for debug logs. If private mode is requested, it asks `PrivateDesktop::create` to make a new desktop, then builds a Windows-style desktop name like `Winsta0\<private-name>`. If private mode is not requested, it builds `Winsta0\Default`. The result is a `LaunchDesktop` object that keeps any private desktop alive and stores the startup name in Windows’ wide-character string format.

**Call relations**: This is called during process creation by `spawn_conpty_process_as_user` and `create_process_as_user`, before the child process is started. When private mode is needed, it hands the hard work to `PrivateDesktop::create`; otherwise it only converts the default desktop name with `to_wide`.

*Call graph*: calls 2 internal fn (create, to_wide); called by 2 (spawn_conpty_process_as_user, create_process_as_user); 1 external calls (format!).


##### `LaunchDesktop::startup_info_desktop`  (lines 79–81)

```
fn startup_info_desktop(&self) -> *mut u16
```

**Purpose**: This gives callers the raw desktop-name pointer that Windows needs in its process startup settings. It is the bridge between the safe Rust object and the low-level Windows API field.

**Data flow**: It reads the already-prepared desktop name stored inside `LaunchDesktop`. It returns a mutable pointer to that wide-character buffer, without changing the object. The caller can place that pointer into Windows startup information so the child process opens on the chosen desktop.

**Call relations**: After `LaunchDesktop::prepare` has built the desktop choice, process-launch code can call this when filling in Windows startup data. It does not call other project functions; it simply exposes the prepared value in the form Windows expects.


##### `PrivateDesktop::create`  (lines 90–125)

```
fn create(logs_base_dir: Option<&Path>) -> Result<Self>
```

**Purpose**: This creates a brand-new private Windows desktop and makes it usable by the restricted process. It is used when the sandbox wants stronger separation from the normal user desktop.

**Data flow**: It takes an optional log folder. It generates a random desktop name, converts that name into Windows’ wide-character format, and calls `CreateDesktopW` to make the desktop with full desktop permissions. If creation fails, it logs the Windows error and returns an error. If creation succeeds, it calls `grant_desktop_access` to set the access rules. If that permission step fails, it closes the desktop and returns the error. On success, it returns a `PrivateDesktop` containing the desktop handle and name.

**Call relations**: `LaunchDesktop::prepare` calls this when private desktop mode is enabled. This function talks directly to Windows to create the desktop, uses `grant_desktop_access` to fix permissions, and uses `debug_log` when Windows reports a problem.

*Call graph*: calls 3 internal fn (grant_desktop_access, debug_log, to_wide); called by 1 (prepare); 8 external calls (from_entropy, anyhow!, format!, null, null_mut, GetLastError, CloseDesktop, CreateDesktopW).


##### `grant_desktop_access`  (lines 128–186)

```
fn grant_desktop_access(handle: isize, logs_base_dir: Option<&Path>) -> Result<()>
```

**Purpose**: This gives the current logon session permission to use the newly created private desktop. Without this step, the sandboxed process might be pointed at a desktop that exists but cannot actually create or use windows there.

**Data flow**: It receives the desktop handle and an optional log folder. It gets the current process token, extracts the logon session identifier from it, and closes the token handle when done. It then builds a Windows access-control entry granting full desktop access to that logon session. It asks Windows to turn that entry into an access list, applies that list to the desktop, frees the temporary access-list memory, and returns success. If either Windows permission call fails, it logs the failure and returns an error.

**Call relations**: `PrivateDesktop::create` calls this immediately after creating the desktop. It relies on token helpers, `get_current_token_for_restriction` and `get_logon_sid_bytes`, to identify who should receive access, and it relies on Windows security APIs to apply the updated permissions.

*Call graph*: calls 3 internal fn (debug_log, get_current_token_for_restriction, get_logon_sid_bytes); called by 1 (create); 7 external calls (anyhow!, format!, null_mut, CloseHandle, LocalFree, SetEntriesInAclW, SetSecurityInfo).


##### `PrivateDesktop::drop`  (lines 189–195)

```
fn drop(&mut self)
```

**Purpose**: This cleans up the private desktop when the `PrivateDesktop` object goes away. It prevents the Windows desktop handle from being leaked.

**Data flow**: It reads the stored Windows desktop handle. If the handle is nonzero, it calls Windows’ `CloseDesktop` function. It does not return a value, and it ignores close errors because cleanup is happening during object destruction.

**Call relations**: Rust calls this automatically when the `PrivateDesktop` inside `LaunchDesktop` is dropped. It is the final cleanup step for desktops created by `PrivateDesktop::create`.

*Call graph*: 1 external calls (CloseDesktop).


### `windows-sandbox-rs/src/proc_thread_attr.rs`

`io_transport` · `process startup setup and cleanup`

When Windows starts a process, some advanced options cannot be passed as simple arguments. They must be packed into a special “process/thread attribute list,” which is like an envelope of extra instructions handed to Windows at process creation time. This file builds and owns that envelope.

The main type, `ProcThreadAttributeList`, keeps the raw byte buffer that Windows requires. Creating it is a two-step Windows ritual: first ask Windows how large the buffer must be, then allocate that many bytes and initialize it for real. If Windows reports a problem, the file turns that into a normal Rust `io::Error` so callers can handle it cleanly.

After creation, the caller can add two kinds of instructions. `set_pseudoconsole` attaches a Windows pseudoconsole, which is a terminal-like object used to run console programs behind the scenes. `set_handle_list` tells Windows exactly which operating-system handles the child process is allowed to inherit. The handle list is stored inside the struct so the memory stays alive while the attribute list may still need it.

Finally, when the struct is dropped, it calls the matching Windows cleanup function. This matters because the attribute list is a native Windows resource; without cleanup, the program could leak operating-system memory or leave process-startup state in a bad shape.

#### Function details

##### `ProcThreadAttributeList::new`  (lines 19–41)

```
fn new(attr_count: u32) -> io::Result<Self>
```

**Purpose**: Creates a new Windows process/thread attribute list with room for a requested number of attributes. Callers use this before starting a child process that needs special startup options.

**Data flow**: It receives the number of attributes the caller plans to add. It first asks Windows how many bytes are needed, allocates a byte buffer of that size, then asks Windows to initialize that buffer as an attribute list. On success it returns a `ProcThreadAttributeList` with an empty stored handle list; on failure it returns an `io::Error` built from Windows’ last error code.

**Call relations**: This is the starting point for the flow in this file. After a caller has this object, they can call `set_pseudoconsole` or `set_handle_list` to fill it with startup instructions, and later pass its pointer to process-creation code elsewhere.

*Call graph*: 5 external calls (from_raw_os_error, null_mut, vec!, GetLastError, InitializeProcThreadAttributeList).


##### `ProcThreadAttributeList::as_mut_ptr`  (lines 43–45)

```
fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST
```

**Purpose**: Gives Windows APIs access to the underlying attribute list memory. It is a small bridge from the safe Rust struct to the raw pointer shape expected by Windows.

**Data flow**: It reads the struct’s internal byte buffer and converts the buffer’s address into the Windows `LPPROC_THREAD_ATTRIBUTE_LIST` pointer type. It does not allocate, copy, or change the buffer; it only exposes its address in the form Windows requires.

**Call relations**: This helper is used whenever the file needs to talk to Windows about the attribute list. `set_pseudoconsole` and `set_handle_list` use it before updating the list, and `drop` uses it before asking Windows to delete the list.

*Call graph*: called by 3 (drop, set_handle_list, set_pseudoconsole).


##### `ProcThreadAttributeList::set_pseudoconsole`  (lines 47–66)

```
fn set_pseudoconsole(&mut self, hpc: isize) -> io::Result<()>
```

**Purpose**: Adds a pseudoconsole to the attribute list so a new child process can be connected to that console-like object. This is useful for running command-line programs through a controlled terminal interface.

**Data flow**: It receives a pseudoconsole handle value. It gets the raw attribute-list pointer, then calls Windows’ `UpdateProcThreadAttribute` with the special pseudoconsole attribute key and the handle value. If Windows accepts the update, it returns `Ok(())`; if Windows rejects it, it returns an `io::Error` based on the Windows error code.

**Call relations**: This function is called after `ProcThreadAttributeList::new` has created the list and before the list is handed to process-creation code. It relies on `as_mut_ptr` to reach the native Windows buffer, then hands the real update work to Windows’ `UpdateProcThreadAttribute` function.

*Call graph*: calls 1 internal fn (as_mut_ptr); 4 external calls (from_raw_os_error, null_mut, GetLastError, UpdateProcThreadAttribute).


##### `ProcThreadAttributeList::set_handle_list`  (lines 68–91)

```
fn set_handle_list(&mut self, handles: Vec<HANDLE>) -> io::Result<()>
```

**Purpose**: Adds the exact set of handles that a child process may inherit. A handle is an operating-system reference to something like a file, pipe, or console; limiting inheritance helps keep the child process from receiving access it should not have.

**Data flow**: It receives a vector of Windows handles and stores that vector inside the struct. Then it gets the raw attribute-list pointer and passes Windows a pointer to the stored handle array plus the array’s byte size. If the Windows update succeeds, the attribute list now contains the handle-inheritance instruction; if it fails, the function returns an `io::Error`.

**Call relations**: Like `set_pseudoconsole`, this is used after the list has been created and before starting the child process. It calls `as_mut_ptr` to get the Windows-facing pointer, then asks `UpdateProcThreadAttribute` to attach the handle-list attribute.

*Call graph*: calls 1 internal fn (as_mut_ptr); 6 external calls (from_raw_os_error, other, size_of_val, null_mut, GetLastError, UpdateProcThreadAttribute).


##### `ProcThreadAttributeList::drop`  (lines 95–99)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the Windows attribute list when the Rust object goes away. This prevents native Windows resources from being left behind.

**Data flow**: It takes the existing struct during destruction, gets the raw pointer to its internal attribute list, and passes that pointer to Windows’ `DeleteProcThreadAttributeList`. It does not return a value; its effect is cleanup.

**Call relations**: This runs automatically when `ProcThreadAttributeList` falls out of use. It calls `as_mut_ptr` to find the native list, then hands cleanup to `DeleteProcThreadAttributeList`, completing the lifecycle that began in `ProcThreadAttributeList::new`.

*Call graph*: calls 1 internal fn (as_mut_ptr); 1 external calls (DeleteProcThreadAttributeList).


### `windows-sandbox-rs/src/conpty/mod.rs`

`io_transport` · `process launch and terminal I/O setup`

Some programs behave differently when they are connected to a real terminal instead of plain input and output streams. On Windows, ConPTY is the operating system feature that provides this “pretend console.” This file hides the awkward Windows setup needed to use it.

The main job is to build a ConPTY with two pipe ends: one pipe lets the parent send keyboard input to the child process, and the other lets the parent read the child’s screen output. Think of it like setting up an intercom: one wire carries what you type in, and another carries what the program says back.

The file also knows how to start a sandboxed process with that ConPTY attached. To do that, it builds a Windows command line, prepares the environment variables, optionally prepares a private desktop, creates the ConPTY, places the ConPTY handle into a special process-startup attribute list, and then calls Windows’ `CreateProcessAsUserW` to launch the child under a supplied user token.

`ConptyInstance` owns the ConPTY and pipe handles. Its cleanup code closes the remaining pipe handles when the instance is dropped, which prevents handle leaks. The `take_*` methods deliberately hand pipe ownership to someone else by removing the handle from the instance so it will not be closed twice.

#### Function details

##### `ConptyInstance::drop`  (lines 43–53)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the operating-system handles owned by a `ConptyInstance` when it is no longer needed. This matters because Windows handles are finite resources, and leaking them can leave pipes or pseudo-terminals open after the process using them is gone.

**Data flow**: It starts with a `ConptyInstance` that may still own an input pipe handle, an output pipe handle, and a ConPTY object. It checks whether each pipe handle looks valid, closes any valid ones with Windows’ `CloseHandle`, then takes and drops the ConPTY object. After this, those resources are released unless they were previously handed off with a `take_*` method.

**Call relations**: This runs automatically when Rust drops a `ConptyInstance`, including instances created by `create_conpty` or `spawn_conpty_process_as_user`. It directly hands the final cleanup step to the Windows `CloseHandle` call for the pipe handles.

*Call graph*: 1 external calls (CloseHandle).


##### `ConptyInstance::raw_handle`  (lines 57–61)

```
fn raw_handle(&self) -> Option<HANDLE>
```

**Purpose**: Returns the raw Windows handle for the ConPTY, if the instance still owns one. Callers use this when they need to pass the pseudo-console handle into lower-level Windows setup code.

**Data flow**: It reads the optional ConPTY object stored inside the instance. If it is present, it extracts its raw operating-system handle and returns it; if the ConPTY has already been removed, it returns nothing.

**Call relations**: This is a small access point for code that needs the underlying Windows handle. In this file, `spawn_conpty_process_as_user` gets the raw handle directly from the ConPTY object before storing it, while this method provides the same kind of access for other callers.


##### `ConptyInstance::take_input_write`  (lines 63–65)

```
fn take_input_write(&mut self) -> HANDLE
```

**Purpose**: Hands the writable input pipe handle to another owner. This is used when another part of the program will be responsible for writing user input into the child process’s terminal.

**Data flow**: It starts with the input-write handle stored in the instance. It replaces that stored handle with zero, then returns the original handle to the caller. Afterward, the instance no longer treats that handle as something it should close.

**Call relations**: This supports the larger ConPTY flow by letting code outside this file take over the child process’s input pipe. It uses Rust’s `replace` operation so ownership is moved cleanly and the cleanup code will not close the same handle later.

*Call graph*: 1 external calls (replace).


##### `ConptyInstance::take_output_read`  (lines 67–69)

```
fn take_output_read(&mut self) -> HANDLE
```

**Purpose**: Hands the readable output pipe handle to another owner. This is used when another part of the program will be responsible for reading terminal output from the child process.

**Data flow**: It starts with the output-read handle stored in the instance. It swaps that stored value to zero and returns the original handle. From then on, the instance no longer owns that output handle and will not close it during cleanup.

**Call relations**: This fits the ConPTY setup by allowing the terminal output stream to be passed to whatever code will monitor or forward the child process’s output. Like `take_input_write`, it relies on `replace` to prevent double-closing the handle.

*Call graph*: 1 external calls (replace).


##### `create_conpty`  (lines 77–87)

```
fn create_conpty(cols: i16, rows: i16) -> Result<ConptyInstance>
```

**Purpose**: Creates a standalone ConPTY and returns it wrapped in a `ConptyInstance`. This is the lower-level building block for callers that need a pseudo-terminal but do not want this file to start a process for them.

**Data flow**: It receives a requested terminal size as columns and rows. It asks the ConPTY helper library to create a raw ConPTY with backing pipes, splits that raw object into the pseudo-console and its input/output pipe handles, converts those pipe handles into raw Windows handles, and returns a `ConptyInstance` that owns them.

**Call relations**: This function calls the ConPTY library’s `new` constructor to do the actual Windows pseudo-terminal creation. It is separate from `spawn_conpty_process_as_user` so other process-launch paths can reuse the same terminal-creation primitive.

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

**Purpose**: Starts a new process as a specified Windows user and attaches it to a ConPTY. This is the main entry point when the sandbox wants a terminal-backed process, such as for interactive command-line tools.

**Data flow**: It receives a user token, command arguments, a working directory, environment variables, and desktop options. It turns the argument list into a Windows-safe command line, builds a Windows environment block, prepares startup information, optionally prepares a private desktop, creates an 80 by 24 ConPTY, and places the ConPTY handle into a special startup attribute list. It then calls `CreateProcessAsUserW`. On success, it returns the new process information together with the `ConptyInstance`; on failure, it returns an error message with the Windows error, working directory, command, and environment size.

**Call relations**: This function is called by `spawn_legacy_process` when that launch path needs a PTY-backed process. Inside, it delegates environment formatting to `make_env_block`, string conversion to `to_wide`, desktop preparation to `LaunchDesktop::prepare`, ConPTY creation to the ConPTY library’s `new`, and final process creation to the Windows API. The returned `ConptyInstance` keeps the terminal resources alive after the child process starts.

*Call graph*: calls 4 internal fn (new, prepare, make_env_block, to_wide); called by 1 (spawn_legacy_process); 7 external calls (anyhow!, zeroed, null, null_mut, new, GetLastError, CreateProcessAsUserW).


### `utils/pty/src/win/procthreadattr.rs`

`io_transport` · `Windows command spawning`

On Windows, starting a program inside a pseudo-terminal is not just a matter of launching the program. Windows needs a special “process thread attribute list,” which is a small block of system-owned setup data passed in when the child process is created. Think of it like an envelope of instructions handed to Windows at process launch time. This file builds and cleans up that envelope.

The main type, ProcThreadAttributeList, owns the memory for that Windows attribute list. Creating it is awkward because the Windows API first has to be asked how much memory it needs, then that exact amount of memory must be allocated, and then the API is called again to initialize it. This wrapper hides that two-step dance.

Once the list exists, set_pty adds the important instruction: connect the new process to a specific pseudo-console handle, called an HPCON. A handle is an operating-system reference to something Windows owns, in this case the pseudo-terminal. The file also includes cleanup code so Windows is told to delete the attribute list when the Rust object is dropped. This matters because the code uses raw Windows pointers, where forgetting cleanup or passing the wrong pointer can cause leaks or process-launch failures.

#### Function details

##### `ProcThreadAttributeList::with_capacity`  (lines 37–60)

```
fn with_capacity(num_attributes: DWORD) -> Result<Self, Error>
```

**Purpose**: Creates a new Windows process attribute list with room for a chosen number of attributes. It is used before starting a child process so Windows has a properly prepared place to store launch instructions.

**Data flow**: It receives the number of attributes the caller wants. It asks Windows how many bytes are needed, allocates a byte buffer of that size, then asks Windows to initialize that buffer as a process attribute list. If Windows reports failure, it returns an error; otherwise it returns a ProcThreadAttributeList that owns the prepared memory.

**Call relations**: When spawn_command is preparing to launch a process, it calls this function to create the attribute list. This function stays focused on making the list valid; later steps, such as attaching the pseudo-terminal, add the actual launch instruction.

*Call graph*: called by 1 (spawn_command); 3 external calls (with_capacity, ensure!, null_mut).


##### `ProcThreadAttributeList::as_mut_ptr`  (lines 62–64)

```
fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST
```

**Purpose**: Gives the Windows API a raw mutable pointer to the attribute list memory. This is needed because the Windows functions do not understand Rust’s safe Vec wrapper directly.

**Data flow**: It reads the internal byte buffer owned by ProcThreadAttributeList and converts the start of that buffer into the pointer type Windows expects. It does not create new data; it simply exposes the existing memory in the form required by the operating system.

**Call relations**: set_pty calls this when updating the list with the pseudo-console instruction. drop also calls it when handing the list back to Windows for cleanup.

*Call graph*: called by 2 (drop, set_pty).


##### `ProcThreadAttributeList::set_pty`  (lines 66–84)

```
fn set_pty(&mut self, con: HPCON) -> Result<(), Error>
```

**Purpose**: Adds the instruction that the new process should use a particular Windows pseudo-console. This is the step that actually connects the future child process to the terminal-like session.

**Data flow**: It receives an HPCON, which is a Windows handle referring to a pseudo-console. It gets a raw pointer to the attribute list, passes that pointer and the console handle to Windows, and asks Windows to store the pseudo-console attribute there. If Windows rejects the update, it returns an error; otherwise the list is ready to be used during process creation.

**Call relations**: After an attribute list has been created, this function is called to put the pseudo-terminal connection into it. It relies on as_mut_ptr to hand the list to the Windows API in the required raw-pointer form.

*Call graph*: calls 1 internal fn (as_mut_ptr); 2 external calls (ensure!, null_mut).


##### `ProcThreadAttributeList::drop`  (lines 88–90)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the Windows attribute list when the Rust object goes out of scope. This prevents the low-level Windows setup data from being left behind.

**Data flow**: When the ProcThreadAttributeList is no longer needed, Rust automatically calls this function. It converts the owned buffer into the raw pointer Windows expects and tells Windows to delete the attribute list contents. Nothing is returned; the cleanup happens as a side effect.

**Call relations**: This is called automatically by Rust’s ownership system rather than by normal application code. It uses as_mut_ptr to pass the correct memory address to Windows during cleanup.

*Call graph*: calls 1 internal fn (as_mut_ptr).


### `windows-sandbox-rs/src/stdio_bridge.rs`

`io_transport` · `active during a Windows sandbox session, from process start until exit`

A sandboxed process cannot automatically read from this wrapper process’s keyboard input or write directly back to its screen. This file acts like a set of temporary pipes between the outside terminal and the sandbox session. Without it, an interactive sandboxed command could sit waiting for input that never arrives, or produce output that the user never sees.

The main function starts three background forwarding jobs. One reads this process’s standard input, meaning what the user types or what another command pipes in, and sends those bytes into the sandbox. Two others read the sandbox’s standard output and standard error, meaning normal messages and error messages, and write them back to this process’s terminal streams.

It also watches for two important endings. If outside input reaches end-of-file, it closes the sandbox child’s input too, like telling the child program “there is no more to read.” If the user presses Ctrl-C, it asks the sandbox session to terminate, instead of leaving the child running. After the sandbox exits, it waits briefly for any final output to drain, but only up to five seconds so the wrapper does not hang forever because of a stuck pipe.

#### Function details

##### `forward_sandbox_session_stdio`  (lines 12–64)

```
async fn forward_sandbox_session_stdio(spawned: SpawnedProcess) -> i32
```

**Purpose**: Runs the whole input/output bridge for one sandbox session. It forwards terminal input into the sandbox, forwards sandbox output back to the terminal, reacts to Ctrl-C, and finally returns the sandboxed process’s exit code.

**Data flow**: It receives a SpawnedProcess, which contains the sandbox session plus channels for its output and exit status. It starts helper threads for stdin, stdout, and stderr, then waits until either the sandbox reports an exit code or the user presses Ctrl-C. On input end, it closes the sandbox child’s stdin; on Ctrl-C, it requests termination. Before returning, it gives stdout and stderr up to five seconds to finish writing any remaining data, then returns the exit code or -1 if the exit result could not be read.

**Call relations**: This is the coordinator for the file. It calls spawn_input_forwarder when it needs a thread to copy outside input into the sandbox, and it calls spawn_output_forwarder twice, once for normal output and once for error output. The helper threads do the blocking reading and writing work while this async function waits for session exit, Ctrl-C, and final output draining.

*Call graph*: calls 2 internal fn (spawn_input_forwarder, spawn_output_forwarder); 11 external calls (clone, new, from_secs, channel, stderr, stdin, stdout, current, select!, spawn (+1 more)).


##### `spawn_input_forwarder`  (lines 66–94)

```
fn spawn_input_forwarder(
    mut input: R,
    writer_tx: mpsc::Sender<Vec<u8>>,
    stdin_eof_tx: oneshot::Sender<()>,
) -> std::thread::JoinHandle<()>
```

**Purpose**: Starts a background thread that copies bytes from some input source into the sandbox child’s stdin channel. It is used so slow or blocking terminal reads do not freeze the async control flow.

**Data flow**: It takes an input reader, a sending channel connected to the sandbox writer, and a one-time signal used to announce end-of-input. The thread repeatedly reads chunks of up to 8 KB. Each chunk is sent into the sandbox. If reading reaches end-of-file, sending fails, or an unrecoverable read error happens, the loop stops. At the end, it sends the one-time signal so the main bridge can close stdin for the sandbox child.

**Call relations**: forward_sandbox_session_stdio calls this once for this process’s stdin. The thread it creates feeds user input into the sandbox while the main function continues watching for process exit or Ctrl-C. When the thread notices input is finished, it notifies the main function through the one-shot signal.

*Call graph*: called by 1 (forward_sandbox_session_stdio); 1 external calls (spawn).


##### `spawn_output_forwarder`  (lines 96–122)

```
fn spawn_output_forwarder(
    tokio_runtime: tokio::runtime::Handle,
    output_rx: mpsc::Receiver<Vec<u8>>,
    mut writer: W,
) -> (std::thread::JoinHandle<()>, oneshot::Receiver<()>)
```

**Purpose**: Starts a background thread that copies output chunks from the sandbox to a chosen output stream, such as stdout or stderr. It keeps terminal writing separate from the async session watcher.

**Data flow**: It receives a Tokio runtime handle, a channel that yields output chunks from the sandbox, and a writer. The new thread waits for chunks from the channel, writes each chunk fully to the writer, and flushes so the user sees the text promptly. If writing or flushing fails, it prints an error and stops. When the channel closes or the thread stops, it sends a done signal back to the caller.

**Call relations**: forward_sandbox_session_stdio calls this twice: one thread writes sandbox stdout to this process’s stdout, and another writes sandbox stderr to this process’s stderr. The returned done signal lets the main bridge wait briefly after the sandbox exits, giving final output a chance to appear before the wrapper returns.

*Call graph*: called by 1 (forward_sandbox_session_stdio); 2 external calls (channel, spawn).
