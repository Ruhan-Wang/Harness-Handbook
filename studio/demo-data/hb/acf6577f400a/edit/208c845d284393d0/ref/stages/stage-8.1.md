# App-server and daemon transport bring-up  `stage-8.1`

This stage is the system’s “bring the server to life and open the doors” step. It sits between startup and normal work. Its job is to launch or find the app-server, connect callers to it, and set up the ways messages can travel in and out.

On the daemon side, app-server-daemon/src/lib.rs is the conductor. It decides how to start, probe, and stop background processes. The backend files define and implement the PID-file method, which uses saved process IDs to manage detached server and updater programs safely. client.rs is the daemon’s low-level probe tool, talking JSON-RPC over a local socket to check whether the server is ready. remote_control_client.rs turns remote control on or off and waits for status updates. The doctor check inspects this setup without changing anything.

On the server side, app-server/src/lib.rs boots the runtime, while transport.rs, outgoing_message.rs, and initialize_processor.rs manage connections, route replies and notifications, and make sure each client finishes its hello handshake before full use. The transport package provides stdio, Unix-socket, and network WebSocket paths, plus WebSocket auth rules. The remote-control files add enrollment, reconnect, and session tracking. Finally, the client and TUI facades give CLI and terminal UI code one simple way to talk to the server, whether it runs inside the same process or in the background.

## Files in this stage

### Daemon lifecycle and process backends
These files define the daemon's top-level orchestration, its managed app-server process backend, and the low-level probing client used to supervise server readiness.

### `app-server-daemon/src/lib.rs`

`orchestration` · `startup, bootstrap, restart/stop, remote-control transitions, updater coordination`

This is the top-level orchestration layer for app-server lifecycle management. It defines the public command/status/output types serialized to callers, validates platform support, and exposes entry functions such as `run`, `bootstrap`, `set_remote_control`, and `run_pid_update_loop`. The internal `Daemon` struct materializes all derived paths from `CODEX_HOME`: control socket, main and updater pid files, operation lock, settings file, and managed Codex binary path.

Most lifecycle methods follow the same pattern: acquire the daemon-wide operation lock, load persisted `DaemonSettings`, probe the control socket, and reconcile that probe result with PID-backed ownership checks. `start` avoids duplicate launches by first probing the socket and then checking whether a managed backend is already starting or running. `restart` and `stop` explicitly reject unmanaged app-server instances. `bootstrap_locked` persists settings, starts the main PID backend, ensures the updater loop is restarted cleanly, and waits for readiness before returning a richer bootstrap payload.

Readiness is polled through `client::probe` until `START_TIMEOUT`; on failure, `app_server_not_ready_context` appends both the managed binary path/version and the tail of the managed stderr log. Remote-control toggling persists settings first, then either sends live enable/disable RPCs when nothing changed or restarts the managed backend when the persisted mode changed. Unix-only restart helpers support updater-driven refreshes by comparing the running app-server version to the managed binary version and optionally re-execing the updater after a validated restart. The file also contains small pure helpers for status mapping, restart decisions, and daemon operation locking via `flock`.

#### Function details

##### `probe_app_server_version`  (lines 79–81)

```
async fn probe_app_server_version(socket_path: &Path) -> Result<String>
```

**Purpose**: Public convenience wrapper that probes a socket and returns only the app-server version string. It hides the internal `ProbeInfo` struct from callers.

**Data flow**: Accepts a socket path, awaits `client::probe`, extracts `.app_server_version`, and returns that string.

**Call relations**: This is a thin public API over the lower-level client probe path, used when callers only need passive version discovery.

*Call graph*: calls 1 internal fn (probe).


##### `RemoteControlMode::is_enabled`  (lines 131–133)

```
fn is_enabled(self) -> bool
```

**Purpose**: Converts the enum-style remote-control mode into a boolean flag. It is the internal bridge between command semantics and persisted settings.

**Data flow**: Reads `self` and returns `true` for `Enabled`, `false` for `Disabled`.

**Call relations**: Only remote-control-setting orchestration uses this helper when deciding whether the desired mode differs from the saved configuration.

*Call graph*: called by 1 (set_remote_control_locked); 1 external calls (matches!).


##### `run`  (lines 190–193)

```
async fn run(command: LifecycleCommand) -> Result<LifecycleOutput>
```

**Purpose**: Public lifecycle entrypoint for start/restart/stop/version commands. It enforces platform support and delegates to a `Daemon` built from the current environment.

**Data flow**: Calls `ensure_supported_platform`, constructs `Daemon::from_environment()`, then awaits `daemon.run(command)` and returns its `LifecycleOutput`.

**Call relations**: This is the main external API for lifecycle commands; all command-specific branching happens inside `Daemon::run`.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `bootstrap`  (lines 195–198)

```
async fn bootstrap(options: BootstrapOptions) -> Result<BootstrapOutput>
```

**Purpose**: Public entrypoint that initializes daemon-managed app-server state, including updater setup and persisted settings. It is stricter and richer than a plain start.

**Data flow**: Checks platform support, constructs a `Daemon` from environment, and delegates to `daemon.bootstrap(options)`, returning `BootstrapOutput`.

**Call relations**: External callers use this when they want the daemon fully bootstrapped rather than merely started. The heavy lifting occurs in `Daemon::bootstrap` and `Daemon::bootstrap_locked`.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `ensure_remote_control_started`  (lines 200–205)

```
async fn ensure_remote_control_started() -> Result<RemoteControlStartOutput>
```

**Purpose**: Public entrypoint that guarantees the daemon is running in remote-control-enabled mode, either by bootstrapping or by updating existing daemon state. It returns whichever output shape corresponds to the path taken.

**Data flow**: Checks platform support, builds a `Daemon`, and delegates to `Daemon::ensure_remote_control_started`, returning a `RemoteControlStartOutput` enum.

**Call relations**: This is the top-level API used before waiting for remote-control readiness. Internally it may trigger bootstrap or a normal start path.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `ensure_remote_control_ready`  (lines 207–212)

```
async fn ensure_remote_control_ready() -> Result<RemoteControlReadyOutput>
```

**Purpose**: Public entrypoint that both ensures the daemon is started with remote control enabled and waits for the app-server’s remote-control connection status. It combines daemon lifecycle and protocol-level readiness.

**Data flow**: Checks platform support, builds a `Daemon`, and delegates to `Daemon::ensure_remote_control_ready`, returning `RemoteControlReadyOutput`.

**Call relations**: This wraps the daemon-start guarantee and then the remote-control RPC handshake, bridging orchestration in this file with transport logic in `remote_control_client.rs`.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `enable_remote_control_on_socket`  (lines 214–226)

```
async fn enable_remote_control_on_socket(
    socket_path: &Path,
    connect_timeout: Duration,
    connect_retry_delay: Duration,
) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Public helper for enabling remote control on an already-known socket path with caller-specified connect retry timing. It bypasses daemon path discovery and lifecycle management.

**Data flow**: Checks platform support, then forwards `socket_path`, `connect_timeout`, and `connect_retry_delay` to `remote_control_client::enable_remote_control_with_connect_retry`, returning the resulting `RemoteControlReadyStatus`.

**Call relations**: This is a direct transport-oriented API for callers that already know the socket path and only need remote-control enablement with retries.

*Call graph*: calls 2 internal fn (ensure_supported_platform, enable_remote_control_with_connect_retry).


##### `set_remote_control`  (lines 228–231)

```
async fn set_remote_control(mode: RemoteControlMode) -> Result<RemoteControlOutput>
```

**Purpose**: Public entrypoint for toggling persisted remote-control mode and reconciling any running managed backend with that new setting.

**Data flow**: Checks platform support, constructs a `Daemon`, and delegates to `Daemon::set_remote_control(mode)`, returning `RemoteControlOutput`.

**Call relations**: This is the external wrapper around the more detailed `set_remote_control_locked` orchestration.

*Call graph*: calls 2 internal fn (from_environment, ensure_supported_platform).


##### `run_pid_update_loop`  (lines 233–236)

```
async fn run_pid_update_loop() -> Result<()>
```

**Purpose**: Public entrypoint for the hidden updater-loop process. It validates platform support and hands control to the updater subsystem.

**Data flow**: Checks platform support and awaits `update_loop::run()`, returning its `Result<()>`.

**Call relations**: This is the daemon-facing hook used when the managed binary launches the updater subcommand selected by the PID backend.

*Call graph*: calls 2 internal fn (ensure_supported_platform, run).


##### `ensure_supported_platform`  (lines 244–248)

```
fn ensure_supported_platform() -> Result<()>
```

**Purpose**: Rejects daemon lifecycle operations on non-Unix platforms. On Unix it is a no-op.

**Data flow**: On Unix it returns `Ok(())`; on non-Unix it returns an `anyhow!` error explaining that lifecycle support is Unix-only.

**Call relations**: Every public lifecycle API calls this first so unsupported platforms fail early before any environment or filesystem work.

*Call graph*: called by 7 (bootstrap, enable_remote_control_on_socket, ensure_remote_control_ready, ensure_remote_control_started, run, run_pid_update_loop, set_remote_control); 1 external calls (anyhow!).


##### `Daemon::from_environment`  (lines 260–274)

```
fn from_environment() -> Result<Self>
```

**Purpose**: Builds a fully configured `Daemon` by deriving all state paths from `CODEX_HOME`. It centralizes path layout conventions for socket, pid files, settings, lock file, and managed binary.

**Data flow**: Finds `CODEX_HOME`, derives the control socket path via `app_server_control_socket_path`, constructs the daemon state directory under `app-server-daemon`, joins fixed filenames for pid/update pid/lock/settings, computes `managed_codex_bin`, and returns a populated `Daemon`.

**Call relations**: All public entrypoints create their `Daemon` through this constructor, ensuring consistent path derivation across lifecycle operations and updater logic.

*Call graph*: calls 1 internal fn (managed_codex_bin); called by 6 (bootstrap, ensure_remote_control_ready, ensure_remote_control_started, run, set_remote_control, update_once); 2 external calls (app_server_control_socket_path, find_codex_home).


##### `Daemon::run`  (lines 276–292)

```
async fn run(&self, command: LifecycleCommand) -> Result<LifecycleOutput>
```

**Purpose**: Dispatches a lifecycle command to the corresponding daemon method, acquiring the daemon-wide operation lock for mutating commands. Version queries skip the lock.

**Data flow**: Matches on `LifecycleCommand`. For `Start`, `Restart`, and `Stop`, it acquires the operation lock and then awaits the corresponding method; for `Version`, it directly calls `version`. It returns the resulting `LifecycleOutput`.

**Call relations**: This is the internal command dispatcher behind the public `run` API. It serializes mutating operations so concurrent daemon commands do not race.

*Call graph*: calls 5 internal fn (acquire_operation_lock, restart, start, stop, version).


##### `Daemon::start`  (lines 294–330)

```
async fn start(&self) -> Result<LifecycleOutput>
```

**Purpose**: Starts the managed app-server if needed, or reports that it is already running. It distinguishes between a live socket, a managed backend still starting, and a truly absent server.

**Data flow**: Loads settings, probes the socket; if probe succeeds, it returns `AlreadyRunning` output with backend ownership determined by `running_backend`. If probe fails but a managed backend instance is starting/running, it waits until ready and returns `AlreadyRunning` with PID backend. Otherwise it verifies the managed binary exists, starts the managed backend, waits for readiness, and returns `Started` output including the optional spawned pid.

**Call relations**: Called from command dispatch and remote-control-start orchestration. It combines passive socket probing, PID backend ownership checks, backend startup, and readiness polling.

*Call graph*: calls 8 internal fn (ensure_managed_codex_bin, load_settings, output, running_backend, running_backend_instance, start_managed_backend, wait_until_ready, probe); called by 2 (ensure_remote_control_started, run).


##### `Daemon::restart`  (lines 332–357)

```
async fn restart(&self) -> Result<LifecycleOutput>
```

**Purpose**: Restarts the managed app-server, but refuses to touch an unmanaged server already listening on the socket. It always ensures the managed binary exists before launching the replacement.

**Data flow**: Loads settings, probes the socket, and if the socket is live while `running_backend` says no managed backend owns it, returns an unmanaged-server error. Otherwise it checks the managed binary, stops any running managed backend instance, starts a new managed backend, waits until ready, and returns `Restarted` output with the new optional pid and app-server version.

**Call relations**: Invoked by command dispatch. It reuses the same backend detection and readiness helpers as `start`, but with an unconditional stop/start sequence when a managed backend exists.

*Call graph*: calls 8 internal fn (ensure_managed_codex_bin, load_settings, output, running_backend, running_backend_instance, start_managed_backend, wait_until_ready, probe); called by 1 (run); 1 external calls (anyhow!).


##### `Daemon::try_restart_if_running`  (lines 360–403)

```
async fn try_restart_if_running(
        &self,
        mode: RestartMode,
        updater_refresh_mode: UpdaterRefreshMode,
        managed_codex_bin: &Path,
    ) -> Result<RestartIfRunningOutcome>
```

**Purpose**: Unix-only helper used by updater logic to conditionally restart a running managed app-server, optionally only when the managed binary version changed. It also optionally re-execs the updater after a successful validated restart.

**Data flow**: Opens the operation lock file and tries to lock it non-blockingly; lock contention returns `Busy`. It loads settings and checks for a running managed backend. If one exists, it probes the socket, optionally reads the managed binary version, computes a `RestartDecision`, and either returns `NotReady`, `AlreadyCurrent`, or performs stop/start/wait and returns `Restarted`. If no managed backend exists but the socket is live, it errors as unmanaged; otherwise it returns `NotRunning`. Finally, if `should_reexec_updater` says so, it re-execs the updater binary.

**Call relations**: This method is called from updater code rather than normal CLI lifecycle paths. It ties together operation locking, backend ownership checks, version comparison via `restart_decision`, and updater refresh policy via `should_reexec_updater`.

*Call graph*: calls 11 internal fn (load_settings, open_operation_lock_file, running_backend_instance, start_managed_backend_with_bin, wait_until_ready, probe, managed_codex_version, restart_decision, should_reexec_updater, try_lock_file (+1 more)); 1 external calls (anyhow!).


##### `Daemon::stop`  (lines 405–433)

```
async fn stop(&self) -> Result<LifecycleOutput>
```

**Purpose**: Stops the managed app-server if one is running, reports `NotRunning` if nothing managed is active, and rejects stopping an unmanaged server that merely happens to own the socket.

**Data flow**: Loads settings, checks `running_backend_instance`; if present, stops it and returns `Stopped` output. If no managed backend exists but probing the socket succeeds, it returns an unmanaged-server error. Otherwise it returns `NotRunning` output with no backend or app-server version.

**Call relations**: Called from command dispatch. It relies on PID backend ownership checks to avoid interfering with non-daemon-managed app-server instances.

*Call graph*: calls 4 internal fn (load_settings, output, running_backend_instance, probe); called by 1 (run); 1 external calls (anyhow!).


##### `Daemon::version`  (lines 435–446)

```
async fn version(&self) -> Result<LifecycleOutput>
```

**Purpose**: Reports version/status information for a currently reachable app-server without changing daemon state. It also indicates whether the running server appears to be daemon-managed.

**Data flow**: Loads settings, probes the socket, computes the optional backend kind via `running_backend`, and returns `Running` output populated with the probed app-server version.

**Call relations**: This is the read-only branch of command dispatch. It combines transport probing with backend ownership detection but does not acquire the operation lock.

*Call graph*: calls 4 internal fn (load_settings, output, running_backend, probe); called by 1 (run).


##### `Daemon::wait_until_ready`  (lines 448–463)

```
async fn wait_until_ready(&self) -> Result<client::ProbeInfo>
```

**Purpose**: Polls the control socket until the app-server responds to probes or startup times out. On timeout it enriches the final error with daemon binary and stderr-log context.

**Data flow**: Computes a deadline `START_TIMEOUT` in the future, repeatedly calls `client::probe`, and on success returns the `ProbeInfo`. Probe failures before the deadline are ignored after a short sleep; the final failure after the deadline is wrapped with the string from `app_server_not_ready_context`.

**Call relations**: Startup, restart, bootstrap, remote-control mode changes, and updater-triggered restarts all use this as the canonical readiness gate after launching or relaunching the managed backend.

*Call graph*: calls 2 internal fn (app_server_not_ready_context, probe); called by 5 (bootstrap_locked, restart, set_remote_control_locked, start, try_restart_if_running); 2 external calls (now, sleep).


##### `Daemon::app_server_not_ready_context`  (lines 465–473)

```
async fn app_server_not_ready_context(&self) -> String
```

**Purpose**: Builds a multi-part diagnostic string explaining what binary the daemon tried to run and what recent stderr output it produced. This context is attached to readiness failures.

**Data flow**: Starts with a message naming the socket path, mutably appends daemon binary path/version information via `append_daemon_app_server_context`, then appends stderr tail information via `backend::append_stderr_log_tail_context`, and returns the final string.

**Call relations**: Only `wait_until_ready` calls this when startup probing ultimately fails. It bridges daemon metadata with backend log diagnostics.

*Call graph*: calls 2 internal fn (append_daemon_app_server_context, append_stderr_log_tail_context); called by 1 (wait_until_ready); 1 external calls (format!).


##### `Daemon::append_daemon_app_server_context`  (lines 475–484)

```
async fn append_daemon_app_server_context(&self, context: &mut String)
```

**Purpose**: Appends the managed app-server binary path and best-effort version to an existing diagnostic string. Missing version information is rendered as `unknown` rather than failing.

**Data flow**: Reads `self.managed_codex_bin`, awaits `managed_codex_version_best_effort`, substitutes `unknown` on `None`, and mutates the provided `context` string with a formatted block.

**Call relations**: This is the first half of readiness-failure context assembly, preceding stderr-tail attachment.

*Call graph*: calls 1 internal fn (managed_codex_version_best_effort); called by 1 (app_server_not_ready_context); 1 external calls (format!).


##### `Daemon::bootstrap`  (lines 486–489)

```
async fn bootstrap(&self, options: BootstrapOptions) -> Result<BootstrapOutput>
```

**Purpose**: Acquires the daemon operation lock and performs bootstrap under exclusive access. It is the locking wrapper around `bootstrap_locked`.

**Data flow**: Awaits `acquire_operation_lock`, keeps the returned file alive for the duration, then delegates to `bootstrap_locked(options)` and returns its `BootstrapOutput`.

**Call relations**: The public `bootstrap` API calls this method so bootstrap cannot race other lifecycle mutations.

*Call graph*: calls 2 internal fn (acquire_operation_lock, bootstrap_locked).


##### `Daemon::ensure_remote_control_started`  (lines 491–508)

```
async fn ensure_remote_control_started(&self) -> Result<RemoteControlStartOutput>
```

**Purpose**: Ensures the daemon is running in a bootstrapped, remote-control-enabled configuration. If already bootstrapped, it updates remote-control mode and starts normally; otherwise it performs a fresh bootstrap with remote control enabled.

**Data flow**: Acquires the operation lock, loads settings, checks `is_bootstrapped`, and if true first calls `set_remote_control_locked(Enabled)` then `start`, wrapping the result in `RemoteControlStartOutput::Start`. If not bootstrapped, it calls `bootstrap_locked` with `remote_control_enabled: true` and wraps the result in `RemoteControlStartOutput::Bootstrap`.

**Call relations**: This method is the daemon-side precursor to remote-control readiness checks. `ensure_remote_control_ready` calls it before invoking protocol-level enablement.

*Call graph*: calls 6 internal fn (acquire_operation_lock, bootstrap_locked, is_bootstrapped, load_settings, set_remote_control_locked, start); called by 1 (ensure_remote_control_ready); 2 external calls (Bootstrap, Start).


##### `Daemon::ensure_remote_control_ready`  (lines 510–518)

```
async fn ensure_remote_control_ready(&self) -> Result<RemoteControlReadyOutput>
```

**Purpose**: Combines daemon startup/bootstrapping with a remote-control enable RPC and returns both results together. It is the highest-level remote-control orchestration path in this file.

**Data flow**: Awaits `ensure_remote_control_started`, then calls `remote_control_client::enable_remote_control(&self.socket_path)`, and returns `RemoteControlReadyOutput { daemon, remote_control }`.

**Call relations**: The public `ensure_remote_control_ready` API delegates here. This method bridges lifecycle orchestration in `lib.rs` with protocol interactions in `remote_control_client.rs`.

*Call graph*: calls 2 internal fn (ensure_remote_control_started, enable_remote_control).


##### `Daemon::set_remote_control`  (lines 520–523)

```
async fn set_remote_control(&self, mode: RemoteControlMode) -> Result<RemoteControlOutput>
```

**Purpose**: Acquires the daemon operation lock and applies a remote-control mode change under exclusive access. It is the locking wrapper around `set_remote_control_locked`.

**Data flow**: Awaits `acquire_operation_lock`, then delegates to `set_remote_control_locked(mode)` and returns the resulting `RemoteControlOutput`.

**Call relations**: The public `set_remote_control` API uses this wrapper so settings changes and any resulting restart cannot race other daemon operations.

*Call graph*: calls 2 internal fn (acquire_operation_lock, set_remote_control_locked).


##### `Daemon::set_remote_control_locked`  (lines 525–582)

```
async fn set_remote_control_locked(
        &self,
        mode: RemoteControlMode,
    ) -> Result<RemoteControlOutput>
```

**Purpose**: Persists the desired remote-control mode and reconciles any running managed backend with that setting. Depending on current state, it may no-op, send live enable/disable RPCs, or restart the managed backend.

**Data flow**: Loads previous settings, clones them, computes the desired boolean via `mode.is_enabled()`, and checks for a running managed backend instance. If no managed backend exists but the socket is live, it errors as unmanaged. If the saved setting already matches the desired mode, it optionally waits for readiness and sends a live enable/disable RPC when a backend is running, then returns an `AlreadyEnabled`/`AlreadyDisabled` output. If the setting changed, it updates and saves settings, and if a backend is running it ensures the managed binary exists, stops the backend, restarts it with the new settings, waits until ready, and returns `Enabled`/`Disabled` output including the new app-server version; otherwise it returns output with no app-server version.

**Call relations**: This method is used both by explicit remote-control commands and by `ensure_remote_control_started`. It ties together settings persistence, backend ownership checks, optional live RPCs, and restart orchestration.

*Call graph*: calls 12 internal fn (ensure_managed_codex_bin, load_settings, remote_control_output, running_backend_instance, start_managed_backend, wait_until_ready, is_enabled, already_remote_control_status, probe, disable_remote_control (+2 more)); called by 2 (ensure_remote_control_started, set_remote_control); 1 external calls (anyhow!).


##### `Daemon::bootstrap_locked`  (lines 584–624)

```
async fn bootstrap_locked(&self, options: BootstrapOptions) -> Result<BootstrapOutput>
```

**Purpose**: Performs full daemon bootstrap: persist settings, ensure no conflicting unmanaged server is running, restart the managed app-server, restart the updater loop, and wait for readiness. It returns the richer bootstrap-specific output payload.

**Data flow**: Ensures the managed binary exists, constructs `DaemonSettings` from the requested options, probes the socket and rejects unmanaged live servers, saves settings, stops any existing managed backend instance, starts the main PID backend, constructs the updater backend, stops it if already starting/running, starts it, waits until the app-server is ready, reads the managed binary version best-effort, and returns a populated `BootstrapOutput`.

**Call relations**: Called by both bootstrap entrypoints: direct bootstrap and remote-control-start when the daemon is not yet bootstrapped. It is the only place that coordinates both the main app-server backend and the updater backend together.

*Call graph*: calls 9 internal fn (backend_paths, ensure_managed_codex_bin, managed_codex_version_best_effort, running_backend, running_backend_instance, wait_until_ready, pid_backend, pid_update_loop_backend, probe); called by 2 (bootstrap, ensure_remote_control_started); 3 external calls (clone, anyhow!, env!).


##### `Daemon::running_backend`  (lines 626–631)

```
async fn running_backend(&self, settings: &DaemonSettings) -> Result<Option<BackendKind>>
```

**Purpose**: Reports whether a managed backend instance appears active, but collapses the concrete backend object into the public `BackendKind` enum. It is a small ownership-query adapter.

**Data flow**: Awaits `running_backend_instance(settings)` and maps `Some(_)` to `Some(BackendKind::Pid)`, otherwise `None`.

**Call relations**: Start, restart, version, and bootstrap ownership checks use this when they only need to report or compare backend kind rather than operate on the backend object.

*Call graph*: calls 1 internal fn (running_backend_instance); called by 4 (bootstrap_locked, restart, start, version).


##### `Daemon::running_backend_instance`  (lines 633–642)

```
async fn running_backend_instance(
        &self,
        settings: &DaemonSettings,
    ) -> Result<Option<backend::PidBackend>>
```

**Purpose**: Constructs the PID backend for the current settings and asks whether it is starting or running. If so, it returns the backend object for further operations.

**Data flow**: Builds a backend with `backend::pid_backend(self.backend_paths(settings))`, awaits `backend.is_starting_or_running()`, and returns `Some(backend)` on true or `None` on false.

**Call relations**: This is the daemon’s canonical managed-backend ownership check. Many lifecycle methods call it before deciding whether to stop, restart, or report a managed server.

*Call graph*: calls 2 internal fn (backend_paths, pid_backend); called by 7 (bootstrap_locked, restart, running_backend, set_remote_control_locked, start, stop, try_restart_if_running).


##### `Daemon::start_managed_backend`  (lines 644–647)

```
async fn start_managed_backend(&self, settings: &DaemonSettings) -> Result<Option<u32>>
```

**Purpose**: Starts the managed backend using the daemon’s configured managed Codex binary path. It is a convenience wrapper over the more general binary-selecting variant.

**Data flow**: Forwards `settings` and `&self.managed_codex_bin` to `start_managed_backend_with_bin` and returns the optional spawned pid.

**Call relations**: Normal start, restart, and remote-control mode changes use this helper when they do not need to override the binary path.

*Call graph*: calls 1 internal fn (start_managed_backend_with_bin); called by 3 (restart, set_remote_control_locked, start).


##### `Daemon::start_managed_backend_with_bin`  (lines 649–657)

```
async fn start_managed_backend_with_bin(
        &self,
        settings: &DaemonSettings,
        managed_codex_bin: &Path,
    ) -> Result<Option<u32>>
```

**Purpose**: Starts the managed backend using an explicitly supplied Codex binary path. This supports updater-driven restarts against a newly resolved binary.

**Data flow**: Builds backend paths with `backend_paths_with_bin(settings, managed_codex_bin)`, constructs a PID backend from them, calls `backend.start()`, and returns the optional pid.

**Call relations**: Used by the normal start wrapper and by updater-triggered restart logic that wants to launch a specific managed binary.

*Call graph*: calls 2 internal fn (backend_paths_with_bin, pid_backend); called by 2 (start_managed_backend, try_restart_if_running).


##### `Daemon::is_bootstrapped`  (lines 659–662)

```
async fn is_bootstrapped(&self, settings: &DaemonSettings) -> Result<bool>
```

**Purpose**: Determines bootstrap state by checking whether the updater-loop backend is starting or running. In this design, updater presence is the marker that bootstrap has completed.

**Data flow**: Constructs the updater backend from current settings and awaits `updater.is_starting_or_running()`, returning that boolean.

**Call relations**: Remote-control-start orchestration uses this to decide whether it can reuse existing daemon state or must perform a full bootstrap.

*Call graph*: calls 2 internal fn (backend_paths, pid_update_loop_backend); called by 1 (ensure_remote_control_started).


##### `Daemon::ensure_managed_codex_bin`  (lines 664–677)

```
fn ensure_managed_codex_bin(&self) -> Result<()>
```

**Purpose**: Validates that the managed standalone Codex binary exists at the expected fixed path. On failure it returns a detailed installation guidance message.

**Data flow**: Checks `self.managed_codex_bin.is_file()`. If true, returns `Ok(())`; otherwise formats an error that includes the missing path and installer instructions.

**Call relations**: Any lifecycle path that might launch or relaunch the managed backend calls this first so failures are actionable before process-management work begins.

*Call graph*: called by 4 (bootstrap_locked, restart, set_remote_control_locked, start); 3 external calls (display, is_file, anyhow!).


##### `Daemon::managed_codex_version_best_effort`  (lines 685–687)

```
async fn managed_codex_version_best_effort(&self) -> Option<String>
```

**Purpose**: Attempts to read the managed binary’s version string without letting failures abort the caller. It is used only for informational output and diagnostics.

**Data flow**: On Unix, awaits `managed_codex_version(&self.managed_codex_bin)` and converts success to `Some(version)` and failure to `None`; on non-Unix it always returns `None`.

**Call relations**: Output builders and readiness diagnostics call this when they want version metadata but can tolerate missing or unreadable binaries.

*Call graph*: calls 1 internal fn (managed_codex_version); called by 3 (append_daemon_app_server_context, bootstrap_locked, output).


##### `Daemon::backend_paths`  (lines 689–691)

```
fn backend_paths(&self, settings: &DaemonSettings) -> BackendPaths
```

**Purpose**: Builds the standard `BackendPaths` bundle for the daemon’s configured managed binary. It is a convenience wrapper over the binary-selecting variant.

**Data flow**: Forwards `settings` and `&self.managed_codex_bin` to `backend_paths_with_bin` and returns the resulting `BackendPaths`.

**Call relations**: Most backend construction in this file uses this helper so path assembly stays centralized.

*Call graph*: calls 1 internal fn (backend_paths_with_bin); called by 3 (bootstrap_locked, is_bootstrapped, running_backend_instance).


##### `Daemon::backend_paths_with_bin`  (lines 693–704)

```
fn backend_paths_with_bin(
        &self,
        settings: &DaemonSettings,
        managed_codex_bin: &Path,
    ) -> BackendPaths
```

**Purpose**: Assembles the full set of backend paths and flags for a chosen managed binary. This is the single place where daemon state is translated into backend constructor inputs.

**Data flow**: Reads `managed_codex_bin`, `self.pid_file`, `self.update_pid_file`, and `settings.remote_control_enabled`, clones/to-path-bufs them into a new `BackendPaths` struct, and returns it.

**Call relations**: Backend creation for both normal lifecycle operations and updater-driven restarts flows through this helper.

*Call graph*: called by 2 (backend_paths, start_managed_backend_with_bin); 2 external calls (to_path_buf, clone).


##### `Daemon::load_settings`  (lines 706–708)

```
async fn load_settings(&self) -> Result<DaemonSettings>
```

**Purpose**: Loads persisted daemon settings from disk. It hides the concrete settings file path from callers.

**Data flow**: Awaits `DaemonSettings::load(&self.settings_file)` and returns the resulting settings object.

**Call relations**: Nearly every lifecycle method begins by calling this so decisions about remote-control mode are based on persisted state.

*Call graph*: calls 1 internal fn (load); called by 7 (ensure_remote_control_started, restart, set_remote_control_locked, start, stop, try_restart_if_running, version).


##### `Daemon::acquire_operation_lock`  (lines 710–723)

```
async fn acquire_operation_lock(&self) -> Result<tokio::fs::File>
```

**Purpose**: Obtains the daemon-wide operation lock that serializes mutating lifecycle commands. It retries for up to `OPERATION_LOCK_TIMEOUT` before failing.

**Data flow**: Opens the operation lock file, computes a deadline, repeatedly calls the local `try_lock_file`, sleeps between attempts, and returns the open file on success. If the deadline passes, it returns an error naming the lock path.

**Call relations**: Start, restart, stop, bootstrap, and remote-control-setting operations all use this lock to prevent concurrent daemon mutations.

*Call graph*: calls 2 internal fn (open_operation_lock_file, try_lock_file); called by 4 (bootstrap, ensure_remote_control_started, run, set_remote_control); 3 external calls (anyhow!, now, sleep).


##### `Daemon::open_operation_lock_file`  (lines 725–746)

```
async fn open_operation_lock_file(&self) -> Result<tokio::fs::File>
```

**Purpose**: Ensures the daemon state directory exists and opens the operation lock file for writing. It does not itself acquire the flock.

**Data flow**: Checks the parent directory of `self.operation_lock_file`, creates it recursively if present, then opens or creates the lock file with write access and returns the async file handle.

**Call relations**: Both blocking lock acquisition and updater-side nonblocking lock attempts start by calling this helper.

*Call graph*: called by 2 (acquire_operation_lock, try_restart_if_running); 3 external calls (parent, new, create_dir_all).


##### `Daemon::output`  (lines 748–766)

```
async fn output(
        &self,
        status: LifecycleStatus,
        backend: Option<BackendKind>,
        pid: Option<u32>,
        app_server_version: Option<String>,
    ) -> LifecycleOutput
```

**Purpose**: Builds the standard `LifecycleOutput` payload returned by start/restart/stop/version commands. It fills in common daemon metadata consistently.

**Data flow**: Accepts status, optional backend, optional pid, and optional app-server version; reads `self.managed_codex_bin`, `self.socket_path`, and best-effort managed binary version; inserts the crate version from `env!`; and returns a populated `LifecycleOutput`.

**Call relations**: Lifecycle methods call this after they have determined command-specific status and version information, so output formatting stays centralized.

*Call graph*: calls 1 internal fn (managed_codex_version_best_effort); called by 4 (restart, start, stop, version); 2 external calls (clone, env!).


##### `Daemon::remote_control_output`  (lines 768–783)

```
fn remote_control_output(
        &self,
        status: RemoteControlStatus,
        backend: Option<BackendKind>,
        remote_control_enabled: bool,
        app_server_version: Option<String>,
```

**Purpose**: Builds the standard `RemoteControlOutput` payload for remote-control mode changes. It mirrors the lifecycle output builder but with remote-control-specific fields.

**Data flow**: Accepts status, optional backend, desired boolean `remote_control_enabled`, and optional app-server version; reads `self.socket_path` and crate version; and returns a `RemoteControlOutput`.

**Call relations**: Only `set_remote_control_locked` uses this helper to produce consistent responses across no-op and restart-required mode changes.

*Call graph*: called by 1 (set_remote_control_locked); 2 external calls (clone, env!).


##### `remote_control_status`  (lines 786–791)

```
fn remote_control_status(mode: RemoteControlMode) -> RemoteControlStatus
```

**Purpose**: Maps a desired remote-control mode to the corresponding success status enum. It is used when a mode change actually takes effect.

**Data flow**: Returns `RemoteControlStatus::Enabled` for `Enabled` and `RemoteControlStatus::Disabled` for `Disabled`.

**Call relations**: Remote-control-setting orchestration uses this after persisting or applying a real mode change.

*Call graph*: called by 1 (set_remote_control_locked).


##### `already_remote_control_status`  (lines 793–798)

```
fn already_remote_control_status(mode: RemoteControlMode) -> RemoteControlStatus
```

**Purpose**: Maps a desired remote-control mode to the corresponding already-in-that-state status enum. It is used for idempotent requests.

**Data flow**: Returns `RemoteControlStatus::AlreadyEnabled` for `Enabled` and `RemoteControlStatus::AlreadyDisabled` for `Disabled`.

**Call relations**: Remote-control-setting orchestration uses this when the persisted setting already matches the requested mode.

*Call graph*: called by 1 (set_remote_control_locked).


##### `restart_decision`  (lines 801–815)

```
fn restart_decision(
    mode: RestartMode,
    info: Option<&client::ProbeInfo>,
    managed_version: Option<&str>,
) -> RestartDecision
```

**Purpose**: Computes whether updater-driven restart logic should restart, skip because the running server is already current, or defer because the server is not ready enough to compare versions. It encodes the policy difference between forced and version-conditional restarts.

**Data flow**: Reads `mode`, optional probe info, and optional managed version. If mode is `IfVersionChanged` and no probe info is available, it returns `NotReady`; if both versions are present and equal, it returns `AlreadyCurrent`; otherwise it returns `Restart`.

**Call relations**: Only `Daemon::try_restart_if_running` calls this helper to decide whether an updater-triggered restart is warranted.

*Call graph*: called by 1 (try_restart_if_running).


##### `should_reexec_updater`  (lines 818–824)

```
fn should_reexec_updater(
    updater_refresh_mode: UpdaterRefreshMode,
    outcome: RestartIfRunningOutcome,
) -> bool
```

**Purpose**: Determines whether the updater process should re-exec itself after a restart outcome. Re-exec happens only when the refresh mode requests it and a restart actually occurred.

**Data flow**: Compares `updater_refresh_mode` and `outcome`, returning true only for `ReexecIfManagedBinaryChanged` combined with `Restarted`.

**Call relations**: Updater-driven restart logic uses this after `try_restart_if_running` computes an outcome, so updater refresh is tied to validated successful restarts.

*Call graph*: called by 1 (try_restart_if_running).


##### `try_lock_file`  (lines 843–845)

```
fn try_lock_file(_file: &tokio::fs::File) -> Result<bool>
```

**Purpose**: Attempts a non-blocking flock on the daemon operation lock file. It reports contention as `Ok(false)` and real errors as failures.

**Data flow**: Reads the raw fd from `tokio::fs::File`, calls `libc::flock(fd, LOCK_EX | LOCK_NB)`, returns `Ok(true)` on success, `Ok(false)` on `EWOULDBLOCK`, and otherwise returns an error with daemon-operation context.

**Call relations**: Both blocking operation-lock acquisition and updater-side nonblocking lock checks rely on this primitive.

*Call graph*: called by 2 (acquire_operation_lock, try_restart_if_running); 3 external calls (as_raw_fd, last_os_error, flock).


##### `tests::remote_control_status_uses_camel_case_json`  (lines 869–874)

```
fn remote_control_status_uses_camel_case_json()
```

**Purpose**: Verifies that `RemoteControlStatus` serializes using the intended camelCase JSON representation.

**Data flow**: Serializes `RemoteControlStatus::AlreadyEnabled` with `serde_json::to_string` and asserts the result is `"alreadyEnabled"`.

**Call relations**: This test documents the public JSON contract for remote-control status values.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::updater_reexec_waits_for_validated_restart`  (lines 877–891)

```
fn updater_reexec_waits_for_validated_restart()
```

**Purpose**: Checks that updater re-exec is triggered only for the `Restarted` outcome when refresh mode requests it.

**Data flow**: Maps several `RestartIfRunningOutcome` values through `should_reexec_updater(UpdaterRefreshMode::ReexecIfManagedBinaryChanged, ...)` and asserts only the restarted case yields `true`.

**Call relations**: This test pins down the policy encoded in `should_reexec_updater` for updater-driven refreshes.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::unchanged_updater_never_reexecs`  (lines 894–906)

```
fn unchanged_updater_never_reexecs()
```

**Purpose**: Checks that updater re-exec never occurs when refresh mode is `None`, regardless of restart outcome.

**Data flow**: Maps several outcomes through `should_reexec_updater(UpdaterRefreshMode::None, ...)` and asserts all results are `false`.

**Call relations**: This complements the previous test by covering the disabled-refresh branch.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::restart_decision_preserves_forced_refreshes`  (lines 909–940)

```
fn restart_decision_preserves_forced_refreshes()
```

**Purpose**: Verifies the restart-decision matrix for version-conditional versus forced restarts. Forced mode should restart even when versions match or probe info is absent.

**Data flow**: Constructs a `ProbeInfo` with version `0.1.0`, evaluates `restart_decision` across four combinations of mode/info/version, and asserts the expected sequence of `AlreadyCurrent`, `NotReady`, `Restart`, and `Restart`.

**Call relations**: This test documents the policy consumed by updater-triggered restart orchestration.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::remote_control_start_output_serializes_inner_output_without_tag`  (lines 943–1004)

```
fn remote_control_start_output_serializes_inner_output_without_tag()
```

**Purpose**: Verifies that the untagged `RemoteControlStartOutput` enum serializes exactly like its inner `LifecycleOutput` or `BootstrapOutput`, without an extra discriminator field.

**Data flow**: Builds representative lifecycle and bootstrap outputs, wraps them in `RemoteControlStartOutput::Start` and `::Bootstrap`, serializes both wrapped and unwrapped forms, and asserts equality with the expected JSON objects.

**Call relations**: This test protects the public JSON shape returned by remote-control-start APIs.

*Call graph*: 3 external calls (Bootstrap, Start, assert_eq!).


##### `tests::not_ready_context_reports_daemon_app_server_before_stderr`  (lines 1007–1033)

```
async fn not_ready_context_reports_daemon_app_server_before_stderr()
```

**Purpose**: Checks the exact ordering and formatting of readiness-failure context: daemon binary metadata should appear before managed stderr output.

**Data flow**: Constructs a `Daemon` with temp paths and a missing managed binary, writes a stderr log next to the pid file, calls `app_server_not_ready_context`, and asserts the returned string matches the expected formatted multi-section message.

**Call relations**: This test covers the composition of `append_daemon_app_server_context` and backend stderr-tail context inside readiness diagnostics.

*Call graph*: 3 external calls (new, assert_eq!, write).


### `app-server-daemon/src/backend/mod.rs`

`orchestration` · `startup, restart, readiness error reporting`

This module is the thin adapter layer above the concrete PID backend implementation in `pid.rs`. It re-exports `PidBackend` for internal callers, defines `BackendKind` as the serialized public identifier for the currently supported backend (`Pid`), and packages all filesystem inputs into `BackendPaths`: the managed Codex binary path, the main app-server pid file, the updater pid file, and the remote-control feature flag. The two constructor helpers split one configuration object into the correct `PidBackend` flavor: the normal app-server process uses `pid_file` plus the remote-control setting, while the updater loop uses `update_pid_file` and a different command kind.

The async `append_stderr_log_tail_context` helper is used only for diagnostics. It asks the PID backend to read the tail of the stderr log associated with a pid file, appends formatted lines when present, ignores missing/empty logs, and degrades gracefully by appending an explicit failure message if log inspection itself errors. That design keeps startup/readiness failures informative without making log-tail collection a hard dependency. Overall, this file contains no lifecycle logic itself; it standardizes backend construction and error-context enrichment for the higher-level daemon orchestration in `lib.rs`.

#### Function details

##### `pid_backend`  (lines 24–30)

```
fn pid_backend(paths: BackendPaths) -> PidBackend
```

**Purpose**: Builds the standard PID-managed backend used for the main app-server process. It selects the main pid file and preserves the caller’s remote-control setting.

**Data flow**: Consumes a `BackendPaths` value, reading `codex_bin`, `pid_file`, and `remote_control_enabled`. It passes those fields into `PidBackend::new` and returns the resulting configured backend instance; it does not mutate external state itself.

**Call relations**: This helper is used by daemon flows that need to inspect or launch the managed app-server. In bootstrap, running-backend detection, and explicit startup with a chosen binary, callers use it to centralize how the main backend is instantiated before delegating actual process checks or spawning to `PidBackend` methods.

*Call graph*: calls 1 internal fn (new); called by 3 (bootstrap_locked, running_backend_instance, start_managed_backend_with_bin).


##### `pid_update_loop_backend`  (lines 32–34)

```
fn pid_update_loop_backend(paths: BackendPaths) -> PidBackend
```

**Purpose**: Builds the PID-managed backend variant for the hidden updater loop process. It points the backend at the updater pid file and uses the updater command mode instead of the normal app-server mode.

**Data flow**: Consumes `BackendPaths`, reading `codex_bin` and `update_pid_file`. It forwards those into `PidBackend::new_update_loop` and returns the configured backend object.

**Call relations**: Bootstrap and bootstrap-state checks call this helper when they need to manage the updater separately from the main server. It exists so higher-level code can ask whether the updater is already running, stop it if stale, or start it, without duplicating command-kind selection.

*Call graph*: calls 1 internal fn (new_update_loop); called by 2 (bootstrap_locked, is_bootstrapped).


##### `append_stderr_log_tail_context`  (lines 36–46)

```
async fn append_stderr_log_tail_context(pid_file: &Path, context: &mut String)
```

**Purpose**: Appends recent managed app-server stderr output, if available, to an existing diagnostic string. If log reading fails, it appends a readable failure note instead of propagating that secondary error.

**Data flow**: Takes a pid-file path and a mutable `String` context. It asynchronously reads the stderr log tail via `pid::read_stderr_log_tail`; on `Ok(Some(tail))` it mutates `context` by calling `PidLogTail::append_to_context`, on `Ok(None)` it leaves the string unchanged, and on `Err` it appends a formatted error message.

**Call relations**: The daemon’s readiness-context builder invokes this after adding binary/version information, so startup failures include both daemon-side metadata and the managed process’s recent stderr. It delegates all file-path derivation and tail extraction to the PID backend module.

*Call graph*: calls 1 internal fn (read_stderr_log_tail); called by 1 (app_server_not_ready_context); 1 external calls (format!).


### `app-server-daemon/src/backend/pid.rs`

`domain_logic` · `process startup/shutdown, liveness checks, failure diagnostics`

This file contains the daemon’s core process-management logic. `PidBackend` stores the managed Codex executable path, the pid file, a sibling lock file (`.pid.lock`), and a `PidCommandKind` distinguishing normal app-server launches from the updater loop. Process identity is tracked with `PidRecord { pid, process_start_time }`, not just a raw pid, so reused pids are rejected by comparing `ps -o lstart=` output. `PidFileState` models the observable pid-file states: absent, actively being initialized (`Starting`), or a serialized running record.

Startup is careful and lock-based: `start` creates the pid directory, acquires an advisory flock on the lock file, reserves the pid file with `create_new`, retries through stale files, opens/truncates a `.stderr.log`, spawns a detached child (`setsid` on Unix), records its start time, writes JSON to a temp pid file, and atomically renames it into place. Any failure after spawn attempts cleanup by terminating the child and removing temporary files. Shutdown waits through in-progress reservations, sends SIGTERM first, escalates after a 60-second grace period, and times out after 70 seconds total. For updater processes, forced termination targets the whole process group.

The module also handles subtle pid-file races: empty pid files are interpreted by consulting the lock file, stale records are removed only while holding the reservation lock, and replacement records are preserved if another writer won the race. Finally, it exposes stderr-log helpers that read only the last 4096 bytes and trim partial leading lines so diagnostics show complete recent messages.

#### Function details

##### `PidLogTail::append_to_context`  (lines 51–60)

```
fn append_to_context(&self, context: &mut String)
```

**Purpose**: Formats a captured stderr tail into a human-readable diagnostic block. It prefixes the log path and indents each retained line.

**Data flow**: Reads `self.path` and `self.contents`, then mutates the provided `context` string by appending a header and each line from `contents` with two-space indentation. It returns no value.

**Call relations**: This is the final formatting step after `read_stderr_log_tail` has extracted recent stderr text. The higher-level backend module calls it when enriching startup/readiness error messages.

*Call graph*: 1 external calls (format!).


##### `PidBackend::new`  (lines 78–88)

```
fn new(codex_bin: PathBuf, pid_file: PathBuf, remote_control_enabled: bool) -> Self
```

**Purpose**: Constructs a backend for the main app-server command. It derives the reservation lock path from the pid file and stores whether remote control should be enabled at launch.

**Data flow**: Accepts `codex_bin`, `pid_file`, and `remote_control_enabled`; computes `lock_file` by replacing the pid file extension with `pid.lock`; returns a `PidBackend` with `command_kind` set to `AppServer { remote_control_enabled }`.

**Call relations**: This constructor underpins all normal app-server backend creation, both in production code and tests. Callers use it before invoking liveness checks, startup, or shutdown, and tests inspect the resulting command behavior and lock-file conventions.

*Call graph*: called by 8 (pid_backend, app_server_disabled_remote_control_uses_compatible_args_and_runtime_env, app_server_remote_control_uses_runtime_flag, locked_empty_pid_file_is_treated_as_active_reservation, stale_record_cleanup_preserves_replacement_record, start_retries_stale_empty_pid_file_under_its_own_lock, stop_waits_for_live_reservation_to_resolve, unlocked_empty_pid_file_is_treated_as_stale_reservation); 1 external calls (with_extension).


##### `PidBackend::new_update_loop`  (lines 90–98)

```
fn new_update_loop(codex_bin: PathBuf, pid_file: PathBuf) -> Self
```

**Purpose**: Constructs a backend for the updater loop command. It uses the same pid/lock-file mechanics as the main backend but switches command generation and forced-kill semantics to updater mode.

**Data flow**: Accepts `codex_bin` and updater `pid_file`, derives `lock_file` with the same extension replacement, and returns a `PidBackend` whose `command_kind` is `UpdateLoop`.

**Call relations**: The daemon uses this only for updater bootstrap and updater-running checks. It isolates updater-specific command-line and process-group termination behavior from the main app-server backend.

*Call graph*: called by 1 (pid_update_loop_backend); 1 external calls (with_extension).


##### `PidBackend::is_starting_or_running`  (lines 100–116)

```
async fn is_starting_or_running(&self) -> Result<bool>
```

**Purpose**: Determines whether the backend currently has an active startup reservation or a live managed process. It also opportunistically cleans up stale pid records before answering.

**Data flow**: Reads pid-file state in a loop. `Missing` returns `false`, `Starting` returns `true`, and `Running(record)` triggers `record_is_active`; active records return `true`, while stale ones are reconciled through `refresh_after_stale_record` and then re-evaluated until a stable answer is reached.

**Call relations**: Higher-level daemon code uses this as the canonical liveness probe for managed processes. It delegates state decoding to `read_pid_file_state`, process validation to `record_is_active`, and stale-file cleanup to `refresh_after_stale_record`.

*Call graph*: calls 3 internal fn (read_pid_file_state, record_is_active, refresh_after_stale_record).


##### `PidBackend::start`  (lines 236–238)

```
async fn start(&self) -> Result<Option<u32>>
```

**Purpose**: Starts a detached managed process under pid-file control, publishes its pid record atomically, and returns the spawned pid when a new process was launched. If another valid managed instance already exists, it returns `Ok(None)` instead of starting a duplicate.

**Data flow**: Reads backend paths and command kind, creates the pid directory if needed, acquires the reservation lock, and attempts to reserve the pid file with `create_new`. Existing pid files are inspected under lock; stale records are removed and retried, while active records short-circuit to `None`. It opens/truncates the stderr log, builds a `tokio::process::Command` with command args, null stdin/stdout, redirected stderr, optional environment, and `setsid`, then spawns. After spawn it reads the child’s process start time, serializes a `PidRecord` to JSON, writes it to a temp file, renames it into place, drops the lock, and returns `Some(pid)`. On failures after spawn it kills the child, removes pid/temp files, and returns contextualized errors, sometimes augmented with stderr tail context.

**Call relations**: Daemon startup and bootstrap flows call this to launch either the main app-server or updater. Internally it orchestrates nearly every helper in the file: lock acquisition, pid-file inspection, stderr-log setup, command generation, process identity capture, and cleanup paths.

*Call graph*: calls 8 internal fn (acquire_reservation_lock, command_args, command_env, open_stderr_log, read_pid_file_state_with_lock_held, record_is_active, terminate_process, read_process_start_time); 15 external calls (parent, with_extension, from, null, bail!, new, format!, new, create_dir_all, remove_file (+5 more)).


##### `PidBackend::stop`  (lines 240–275)

```
async fn stop(&self) -> Result<()>
```

**Purpose**: Stops the managed process represented by the pid file, waiting through in-progress startup reservations and escalating from graceful to forced termination if necessary. It treats missing or already-stale records as a successful no-op.

**Data flow**: Loops until shutdown is complete. It first waits for a concrete pid record via `wait_for_pid_start`; `None` means nothing is running. For a record, it validates liveness with `record_is_active`; stale records are reconciled with `refresh_after_stale_record` and retried. For active processes it sends a graceful termination signal, polls until either the record becomes inactive or the timeout expires, escalates with `force_terminate_process` after `STOP_GRACE_PERIOD`, and bails if the process still matches the record after `STOP_TIMEOUT`.

**Call relations**: Called by daemon restart, stop, bootstrap cleanup, and updater replacement flows. It depends on `wait_for_pid_start` to handle the transient empty-pid-file reservation state and on the record-validation helpers to avoid killing unrelated processes that reused the same pid.

*Call graph*: calls 5 internal fn (force_terminate_process, record_is_active, refresh_after_stale_record, terminate_process, wait_for_pid_start); 3 external calls (bail!, now, sleep).


##### `PidBackend::wait_for_pid_start`  (lines 277–294)

```
async fn wait_for_pid_start(&self) -> Result<Option<PidRecord>>
```

**Purpose**: Waits briefly for a pid reservation to transition from an empty/starting state into a concrete running record. It distinguishes between no process, a completed startup, and a reservation that never finished.

**Data flow**: Polls `read_pid_file_state` until `START_TIMEOUT`. `Missing` returns `Ok(None)`, `Running(record)` returns `Ok(Some(record))`, and `Starting` sleeps for `STOP_POLL_INTERVAL` while time remains; if the deadline passes still in `Starting`, it returns an error describing the stuck reservation.

**Call relations**: Only shutdown uses this helper, because stop must not race a concurrent startup that has reserved the pid file but not yet published JSON. It delegates all state interpretation to `read_pid_file_state`.

*Call graph*: calls 1 internal fn (read_pid_file_state); called by 1 (stop); 3 external calls (bail!, now, sleep).


##### `PidBackend::read_pid_file_state`  (lines 296–326)

```
async fn read_pid_file_state(&self) -> Result<PidFileState>
```

**Purpose**: Interprets the externally visible pid-file state, including the special meaning of missing files and empty files. It uses the reservation lock to tell active startup from stale leftovers.

**Data flow**: Attempts to read the pid file as text. A missing file triggers `reservation_lock_is_active`: active lock means `Starting`, otherwise `Missing`. Non-empty contents are parsed as `PidRecord` JSON and returned as `Running(record)`. Empty contents are resolved through `inspect_empty_pid_reservation`, which can classify the reservation as active, stale, or already replaced by a real record.

**Call relations**: This is the main state decoder used by liveness checks and stop-wait logic. It delegates lock inspection and empty-file race handling to dedicated helpers so callers can reason in terms of `PidFileState` instead of raw filesystem conditions.

*Call graph*: calls 2 internal fn (inspect_empty_pid_reservation, reservation_lock_is_active); called by 2 (is_starting_or_running, wait_for_pid_start); 3 external calls (Running, read_to_string, from_str).


##### `PidBackend::read_pid_file_state_with_lock_held`  (lines 328–347)

```
async fn read_pid_file_state_with_lock_held(&self) -> Result<PidFileState>
```

**Purpose**: Reads pid-file state under the assumption that the caller already holds the reservation lock. In that locked context, an empty pid file is treated as stale and removed immediately.

**Data flow**: Reads the pid file text. Missing files return `Missing`; empty contents cause best-effort removal of the pid file and return `Missing`; non-empty contents are parsed as `PidRecord` JSON and returned as `Running(record)`.

**Call relations**: Startup and stale-record cleanup call this only after acquiring the reservation lock, which lets them make stronger assumptions than `read_pid_file_state`. It avoids consulting lock state again because the caller already owns exclusivity.

*Call graph*: called by 2 (refresh_after_stale_record, start); 4 external calls (Running, read_to_string, remove_file, from_str).


##### `PidBackend::refresh_after_stale_record`  (lines 349–360)

```
async fn refresh_after_stale_record(&self, expected: &PidRecord) -> Result<PidFileState>
```

**Purpose**: Reconciles a pid file after the caller has determined that a specific record is stale. It removes the file only if the on-disk record still matches the stale record, preserving any replacement written by another actor.

**Data flow**: Acquires the reservation lock, rereads pid-file state with lock held, compares any `Running(record)` to `expected`, removes the pid file if they are equal, then returns the resulting state (`Missing` or the newer state) after dropping the lock.

**Call relations**: Both liveness checks and shutdown use this after `record_is_active` says a record is dead. Its compare-before-delete behavior is what prevents races from deleting a newer pid record written by a concurrent startup.

*Call graph*: calls 2 internal fn (acquire_reservation_lock, read_pid_file_state_with_lock_held); called by 2 (is_starting_or_running, stop); 1 external calls (remove_file).


##### `PidBackend::acquire_reservation_lock`  (lines 362–383)

```
async fn acquire_reservation_lock(&self) -> Result<fs::File>
```

**Purpose**: Obtains the advisory flock that serializes pid-file reservation and stale-record cleanup. It retries for a bounded time instead of blocking forever.

**Data flow**: Opens or creates the lock file for writing, then repeatedly calls `try_lock_file` until it succeeds or `START_TIMEOUT` elapses. On success it returns the open `fs::File`, whose lifetime holds the lock; on timeout it returns an error naming the lock path.

**Call relations**: This is the synchronization primitive used by startup and stale-record refresh. Callers keep the returned file alive while they inspect or mutate the pid file so other backend instances observe a coherent reservation state.

*Call graph*: calls 1 internal fn (try_lock_file); called by 2 (refresh_after_stale_record, start); 4 external calls (bail!, new, now, sleep).


##### `PidBackend::open_stderr_log`  (lines 386–400)

```
async fn open_stderr_log(&self) -> Result<fs::File>
```

**Purpose**: Opens the stderr log file associated with the pid file, truncating any previous contents so each launch gets a fresh log. The path is derived mechanically from the pid file name.

**Data flow**: Computes the log path with `stderr_log_file_for_pid_file`, then opens it with create/truncate/write options and returns the resulting async file handle. Errors are wrapped with context naming the log path.

**Call relations**: Startup calls this before spawning so the child’s stderr can be redirected into a predictable file. Later diagnostic helpers read from that same derived path.

*Call graph*: calls 1 internal fn (stderr_log_file_for_pid_file); called by 1 (start); 1 external calls (new).


##### `PidBackend::command_args`  (lines 403–413)

```
fn command_args(&self) -> Vec<&'static str>
```

**Purpose**: Builds the exact argv used to launch the managed process. The arguments differ between normal app-server mode, remote-control-enabled mode, and updater-loop mode.

**Data flow**: Reads `self.command_kind` and returns a `Vec<&'static str>`. Main app-server launches always use `app-server --listen unix://`, optionally inserting `--remote-control`; updater launches use the hidden `app-server daemon pid-update-loop` subcommand.

**Call relations**: Only startup uses this helper when constructing the child process. Tests also validate that the chosen command line matches compatibility expectations for remote control and updater behavior.

*Call graph*: called by 1 (start); 1 external calls (vec!).


##### `PidBackend::command_env`  (lines 416–426)

```
fn command_env(&self) -> Option<(&'static str, &'static str)>
```

**Purpose**: Supplies any extra environment variable needed for launch compatibility. Only the non-remote-control app-server mode sets an override to explicitly disable remote control at runtime.

**Data flow**: Examines `self.command_kind` and returns either `Some((REMOTE_CONTROL_DISABLED_ENV_VAR, "1"))` or `None`. It does not mutate process state itself; the caller applies the pair to the spawned command.

**Call relations**: Startup consults this after building argv so older/newer app-server binaries receive the intended remote-control mode even when the CLI flags alone are insufficient.

*Call graph*: called by 1 (start).


##### `PidBackend::terminate_process`  (lines 428–433)

```
fn terminate_process(&self, pid: u32) -> Result<()>
```

**Purpose**: Dispatches graceful termination for the managed process represented by this backend. Today both command kinds use the same SIGTERM helper.

**Data flow**: Reads `self.command_kind` and forwards the provided pid to the free `terminate_process` function, returning its `Result<()>` unchanged.

**Call relations**: Startup uses this for cleanup if it spawned a child but failed to publish a valid pid record, and shutdown uses it as the first-stage graceful stop signal.

*Call graph*: calls 1 internal fn (terminate_process); called by 2 (start, stop).


##### `PidBackend::force_terminate_process`  (lines 435–440)

```
fn force_terminate_process(&self, pid: u32) -> Result<()>
```

**Purpose**: Dispatches forced termination after graceful shutdown has had enough time. Updater mode kills the whole process group, while normal app-server mode kills only the process pid.

**Data flow**: Reads `self.command_kind`; for `AppServer` it calls the free `force_terminate_process`, and for `UpdateLoop` it calls `force_terminate_process_group`. It returns the delegated result.

**Call relations**: Only shutdown calls this, after the grace period expires. The split exists because the updater may have spawned descendants that should be torn down together.

*Call graph*: calls 2 internal fn (force_terminate_process, force_terminate_process_group); called by 1 (stop).


##### `PidBackend::record_is_active`  (lines 442–444)

```
async fn record_is_active(&self, record: &PidRecord) -> Result<bool>
```

**Purpose**: Checks whether a pid record still refers to the same live process that originally wrote it. It hides the platform-specific process identity logic behind a backend method.

**Data flow**: Accepts a `PidRecord` reference and forwards it to `process_matches_record`, returning the resulting boolean wrapped in `Result`.

**Call relations**: Liveness checks, startup duplicate detection, and shutdown polling all use this method before trusting a pid record. It centralizes the pid-plus-start-time validation policy.

*Call graph*: calls 1 internal fn (process_matches_record); called by 3 (is_starting_or_running, start, stop).


##### `read_stderr_log_tail`  (lines 447–453)

```
async fn read_stderr_log_tail(pid_file: &Path) -> Result<Option<PidLogTail>>
```

**Purpose**: Reads the recent stderr output associated with a pid file and packages it with the log path. Missing or empty logs are reported as `None`.

**Data flow**: Derives the stderr log path from the pid file, calls `read_log_tail` with the fixed byte limit `STDERR_LOG_TAIL_BYTES`, and if text is returned wraps it in `PidLogTail { path, contents }`.

**Call relations**: The outer backend module uses this when building readiness failure context. It delegates path derivation and byte-limited file reading to lower-level helpers.

*Call graph*: calls 2 internal fn (read_log_tail, stderr_log_file_for_pid_file); called by 1 (append_stderr_log_tail_context).


##### `stderr_log_file_for_pid_file`  (lines 455–457)

```
fn stderr_log_file_for_pid_file(pid_file: &Path) -> PathBuf
```

**Purpose**: Maps a pid file path to its sibling stderr log path by replacing the extension. This keeps log naming deterministic and colocated with pid state.

**Data flow**: Takes a `&Path` and returns `pid_file.with_extension("stderr.log")` as a new `PathBuf`.

**Call relations**: Both log writing during startup and log reading during diagnostics rely on this shared naming rule so they refer to the same file.

*Call graph*: called by 2 (open_stderr_log, read_stderr_log_tail); 1 external calls (with_extension).


##### `read_log_tail`  (lines 459–495)

```
async fn read_log_tail(path: &Path, byte_limit: u64) -> Result<Option<String>>
```

**Purpose**: Reads at most the last N bytes of a text log file and trims away any partial leading line introduced by seeking into the middle of the file. It returns only complete recent lines, with trailing whitespace removed.

**Data flow**: Opens the file if it exists, returning `None` on `NotFound`. It reads metadata to get length, seeks to `len - byte_limit` (saturating at zero), reads the remainder into bytes, optionally drops bytes through the first newline when the read started mid-file, converts lossily from UTF-8, trims trailing whitespace, and returns `Some(String)` unless the result is empty.

**Call relations**: This is the low-level implementation behind stderr-tail diagnostics. `read_stderr_log_tail` fixes the byte limit and wraps the returned text with path metadata.

*Call graph*: called by 1 (read_stderr_log_tail); 4 external calls (Start, from_utf8_lossy, new, open).


##### `process_exists`  (lines 498–504)

```
fn process_exists(pid: u32) -> bool
```

**Purpose**: Performs a Unix existence check for a pid using `kill(pid, 0)`. It treats permission-denied as evidence that the process exists.

**Data flow**: Converts the `u32` pid to `libc::pid_t`; conversion failure returns `false`. It then calls `libc::kill(pid, 0)` and returns `true` on success or on `EPERM`, otherwise `false`.

**Call relations**: Process-record validation uses this as a cheap first check before attempting to read process start time. It helps distinguish dead processes from inaccessible but live ones.

*Call graph*: called by 1 (process_matches_record); 3 external calls (last_os_error, kill, try_from).


##### `terminate_process`  (lines 552–554)

```
fn terminate_process(_pid: u32) -> Result<()>
```

**Purpose**: Sends SIGTERM to a Unix process, treating an already-missing process as success. It wraps pid conversion and syscall failures with app-server-specific context.

**Data flow**: Converts the `u32` pid to `pid_t`, calls `libc::kill(raw_pid, SIGTERM)`, returns `Ok(())` on success or `ESRCH`, and otherwise returns an error annotated with the pid.

**Call relations**: The backend method of the same name delegates here for actual signal delivery. It is used during normal shutdown and startup cleanup.

*Call graph*: called by 1 (terminate_process); 4 external calls (bail!, last_os_error, kill, try_from).


##### `force_terminate_process`  (lines 557–559)

```
fn force_terminate_process(_pid: u32) -> Result<()>
```

**Purpose**: Sends SIGKILL to a Unix process, again treating `ESRCH` as success. It is the hard-stop counterpart to graceful termination.

**Data flow**: Converts the pid, calls `libc::kill(raw_pid, SIGKILL)`, and returns success on syscall success or missing-process `ESRCH`; other errors are contextualized and returned.

**Call relations**: The backend’s forced-stop dispatcher uses this for normal app-server processes after the grace period expires.

*Call graph*: called by 1 (force_terminate_process); 4 external calls (bail!, last_os_error, kill, try_from).


##### `force_terminate_process_group`  (lines 562–564)

```
fn force_terminate_process_group(_pid: u32) -> Result<()>
```

**Purpose**: Sends SIGKILL to an entire Unix process group rooted at the updater pid. This ensures updater descendants are also terminated.

**Data flow**: Converts the pid, negates it to target the process group in `libc::kill(-raw_pid, SIGKILL)`, and returns success on syscall success or `ESRCH`; other failures are contextualized.

**Call relations**: The backend’s forced-stop dispatcher selects this only for updater mode, reflecting the updater’s detached-session/process-group launch model.

*Call graph*: called by 1 (force_terminate_process); 4 external calls (bail!, last_os_error, kill, try_from).


##### `process_matches_record`  (lines 580–582)

```
async fn process_matches_record(_record: &PidRecord) -> Result<bool>
```

**Purpose**: Verifies that a pid record still identifies the same live process by checking both pid existence and recorded start time. This prevents stale pid files from matching unrelated processes that reused the pid.

**Data flow**: Reads `record.pid` and `record.process_start_time`. It first calls `process_exists`; if false, it returns `false`. Otherwise it reads the current process start time and compares it to the stored string, returning `true` only on equality; if reading start time fails because the process disappeared in the meantime, it returns `false`.

**Call relations**: All backend liveness decisions flow through this helper via `record_is_active`. It depends on `process_exists` and `read_process_start_time` to implement pid reuse protection.

*Call graph*: calls 2 internal fn (process_exists, read_process_start_time); called by 1 (record_is_active).


##### `try_lock_file`  (lines 609–611)

```
fn try_lock_file(_file: &fs::File) -> Result<bool>
```

**Purpose**: Attempts a non-blocking exclusive flock on an already-open file and reports whether the lock was acquired. It distinguishes contention from real locking errors.

**Data flow**: Reads the file descriptor from `fs::File`, calls `libc::flock(fd, LOCK_EX | LOCK_NB)`, returns `Ok(true)` on success, `Ok(false)` on `EWOULDBLOCK`, and otherwise returns an error with lock-specific context.

**Call relations**: Reservation-lock acquisition, lock-state inspection, and empty-reservation inspection all use this primitive. It is the basis for the backend’s cross-process synchronization protocol.

*Call graph*: called by 3 (acquire_reservation_lock, inspect_empty_pid_reservation, reservation_lock_is_active); 4 external calls (as_raw_fd, bail!, last_os_error, flock).


##### `reservation_lock_is_active`  (lines 635–637)

```
async fn reservation_lock_is_active(_path: &Path) -> Result<bool>
```

**Purpose**: Checks whether some other process currently holds the reservation lock file. It does this by trying to acquire the lock itself and inverting the result.

**Data flow**: Opens or creates the lock file for writing, then calls `try_lock_file`. If the lock cannot be acquired because another holder owns it, it returns `true`; if it can be acquired, it returns `false`.

**Call relations**: Pid-file state decoding uses this when the pid file is missing, so a missing file plus active lock is interpreted as `Starting` rather than `Missing`.

*Call graph*: calls 1 internal fn (try_lock_file); called by 1 (read_pid_file_state); 1 external calls (new).


##### `inspect_empty_pid_reservation`  (lines 683–688)

```
async fn inspect_empty_pid_reservation(
    _pid_path: &Path,
    _lock_path: &Path,
) -> Result<EmptyPidReservation>
```

**Purpose**: Resolves the ambiguous case of an empty pid file by consulting the lock and then rereading the pid file under lock. It can classify the reservation as active, stale, or already replaced by a real record.

**Data flow**: Opens the lock file, tries to lock it, and returns `Active` immediately if another process still holds the lock. If it acquires the lock, it rereads the pid file: missing or still-empty contents are treated as stale and may trigger pid-file removal, while non-empty contents are parsed into `EmptyPidReservation::Record(record)`.

**Call relations**: The main pid-file reader delegates empty-file handling here because an empty file can mean either an in-progress startup or a crashed/stale reservation. This helper closes that race safely.

*Call graph*: calls 1 internal fn (try_lock_file); called by 1 (read_pid_file_state); 5 external calls (Record, new, read_to_string, remove_file, from_str).


##### `read_process_start_time`  (lines 691–708)

```
async fn read_process_start_time(pid: u32) -> Result<String>
```

**Purpose**: Obtains a stable textual process start time for a pid by invoking `ps`. The returned string is used as part of the pid record identity.

**Data flow**: Runs `ps -p <pid> -o lstart=` asynchronously, checks for successful exit status, decodes stdout as UTF-8, trims it, rejects empty output, and returns the resulting start-time string.

**Call relations**: Startup uses this immediately after spawning to create a `PidRecord`, and later liveness checks use it to verify that the current process still matches that record.

*Call graph*: called by 2 (start, process_matches_record); 3 external calls (from_utf8, bail!, new).


### `app-server-daemon/src/client.rs`

`io_transport` · `socket probing, protocol initialization, request/response exchange`

This module speaks the app-server control protocol over a Unix socket upgraded to WebSocket. Its central public operations are `connect`, which opens the Unix socket and performs the WebSocket client handshake, and `probe`, which performs a minimal initialize/initialized exchange and extracts the app-server version from the returned user-agent string. The probe path is wrapped in a fixed `CONTROL_SOCKET_RESPONSE_TIMEOUT`, so callers get bounded readiness checks instead of hanging indefinitely.

`initialize` constructs a JSON-RPC `initialize` request with `ClientInfo` identifying the daemon and, optionally, `InitializeCapabilities { experimental_api: true }` when a caller needs remote-control features. It sends the request, then loops reading messages until it finds the matching response id, ignoring unrelated traffic. `send_message` serializes `JSONRPCMessage` values to text WebSocket frames, while `read_message` consumes frames until it sees a text frame and then deserializes it as protocol JSON-RPC, skipping non-text frames entirely.

A small parser, `parse_version_from_user_agent`, extracts the version token after the first `/` in the server’s user-agent string and rejects malformed values. Tests cover both the happy path and malformed input. This file intentionally stays transport-focused: it knows how to connect, initialize, send, receive, and parse version metadata, while higher-level daemon and remote-control modules decide what operations to perform.

#### Function details

##### `probe`  (lines 34–43)

```
async fn probe(socket_path: &Path) -> Result<ProbeInfo>
```

**Purpose**: Performs a bounded readiness probe against the app-server control socket and returns the discovered app-server version. It wraps the full probe sequence in a timeout with socket-specific context.

**Data flow**: Takes a socket path, runs `probe_inner(socket_path)` inside `tokio::time::timeout(CONTROL_SOCKET_RESPONSE_TIMEOUT, ...)`, and returns the resulting `ProbeInfo`. If the timeout elapses, it returns an error mentioning the socket path.

**Call relations**: Many daemon lifecycle paths use this as their passive readiness check before deciding whether to start, stop, restart, or report version information. It delegates the actual protocol exchange to `probe_inner`.

*Call graph*: calls 1 internal fn (probe_inner); called by 9 (bootstrap_locked, restart, set_remote_control_locked, start, stop, try_restart_if_running, version, wait_until_ready, probe_app_server_version); 1 external calls (timeout).


##### `probe_inner`  (lines 45–61)

```
async fn probe_inner(socket_path: &Path) -> Result<ProbeInfo>
```

**Purpose**: Executes the actual probe handshake: connect, initialize without experimental API, send `initialized`, close, and parse the server version from the initialize response.

**Data flow**: Connects to the socket, mutably initializes the websocket with `experimental_api = false`, constructs and sends an `initialized` notification, closes the websocket best-effort, parses `initialize_response.user_agent` into a version string, and returns `ProbeInfo { app_server_version }`.

**Call relations**: Called only by `probe` under timeout control. It reuses the generic `connect`, `initialize`, and `send_message` helpers that remote-control code also builds on.

*Call graph*: calls 4 internal fn (connect, initialize, parse_version_from_user_agent, send_message); called by 1 (probe); 1 external calls (Notification).


##### `connect`  (lines 63–71)

```
async fn connect(socket_path: &Path) -> Result<WebSocketStream<UnixStream>>
```

**Purpose**: Opens the Unix-domain control socket and upgrades it to a WebSocket client connection. It is the shared transport entry point for all control-plane interactions.

**Data flow**: Takes a socket path, asynchronously connects a `codex_uds::UnixStream`, then passes that stream to `tokio_tungstenite::client_async("ws://localhost/", stream)`. It returns the resulting `WebSocketStream<UnixStream>` or contextualized connection/upgrade errors.

**Call relations**: Probe logic and remote-control operations both start here. Higher-level retry logic lives elsewhere; this function performs a single connect-and-upgrade attempt.

*Call graph*: calls 1 internal fn (connect); called by 5 (probe_inner, connect_with_retry, disable_remote_control, enable_remote_control, run_enable_remote_control_scenario); 1 external calls (client_async).


##### `initialize`  (lines 73–116)

```
async fn initialize(
    websocket: &mut WebSocketStream<S>,
    experimental_api: bool,
) -> Result<InitializeResponse>
```

**Purpose**: Sends the JSON-RPC `initialize` request and waits for the matching response, optionally advertising experimental API support. It returns the parsed `InitializeResponse` payload.

**Data flow**: Builds a `JSONRPCMessage::Request` with fixed id `INITIALIZE_REQUEST_ID`, method `initialize`, and serialized `InitializeParams` containing daemon client metadata and optional `InitializeCapabilities`. It sends that request, then repeatedly reads messages under per-read timeout until it sees a `JSONRPCMessage::Response` with the matching id, and finally deserializes `response.result` into `InitializeResponse`.

**Call relations**: Both passive probing and remote-control setup call this helper. It depends on `send_message` and `read_message` for transport and intentionally ignores unrelated messages until the initialize response arrives.

*Call graph*: calls 2 internal fn (read_message, send_message); called by 2 (probe_inner, initialize_client); 5 external calls (default, Request, env!, to_value, timeout).


##### `send_message`  (lines 118–129)

```
async fn send_message(
    websocket: &mut WebSocketStream<S>,
    message: &JSONRPCMessage,
) -> Result<()>
```

**Purpose**: Serializes a protocol message to JSON text and sends it as a WebSocket text frame. It is the write-side primitive for this client module.

**Data flow**: Accepts a mutable websocket and a `JSONRPCMessage` reference, converts the message to a JSON string with `serde_json::to_string`, wraps it in `Message::Text`, sends it through the websocket sink, and returns `Ok(())` on success.

**Call relations**: Initialization, probing, and remote-control request helpers all delegate actual frame transmission here so serialization and tungstenite usage stay centralized.

*Call graph*: called by 8 (initialize, probe_inner, initialize_client, send_remote_control_request, accept_initialized_client, disable_remote_control_retries_without_params_for_older_servers, send_remote_control_status, serve_enable_remote_control_scenario); 3 external calls (send, to_string, Text).


##### `read_message`  (lines 131–146)

```
async fn read_message(websocket: &mut WebSocketStream<S>) -> Result<JSONRPCMessage>
```

**Purpose**: Reads the next JSON-RPC message from the websocket, skipping non-text frames and failing if the socket closes. It is the read-side primitive for control-plane traffic.

**Data flow**: Loops on `websocket.next()`, returning an error if the stream ends. For each frame, it ignores anything except `Message::Text(payload)`, then deserializes the payload into `JSONRPCMessage` and returns it.

**Call relations**: Initialization and remote-control response/status waiters use this helper as their raw message source. Higher-level loops decide which message ids or notification methods matter.

*Call graph*: called by 6 (initialize, read_remote_control_response, accept_initialized_client, disable_remote_control_retries_without_params_for_older_servers, serve_enable_remote_control_scenario, wait_for_remote_control_status); 1 external calls (next).


##### `parse_version_from_user_agent`  (lines 148–158)

```
fn parse_version_from_user_agent(user_agent: &str) -> Result<String>
```

**Purpose**: Extracts the app-server version token from a user-agent string of the form `name/version ...`. It rejects strings missing either the slash separator or the version token.

**Data flow**: Splits the input string once on `'/'`, takes the remainder, then takes the first whitespace-delimited token and validates it is non-empty. It returns that token as an owned `String` or an `anyhow` error.

**Call relations**: Only probe logic uses this parser, after `initialize` returns the server’s user-agent. Tests in this file document the accepted and rejected formats.

*Call graph*: called by 1 (probe_inner).


##### `tests::parses_version_from_codex_user_agent`  (lines 167–175)

```
fn parses_version_from_codex_user_agent()
```

**Purpose**: Confirms that version parsing succeeds on a realistic Codex user-agent string containing additional platform and client metadata.

**Data flow**: Calls `parse_version_from_user_agent` with a representative user-agent string and asserts the returned version is `1.2.3`.

**Call relations**: This test documents the expected happy-path format consumed by `probe_inner`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::rejects_user_agent_without_version`  (lines 178–180)

```
fn rejects_user_agent_without_version()
```

**Purpose**: Confirms that version parsing rejects a user-agent string that omits the `/version` portion.

**Data flow**: Calls `parse_version_from_user_agent` with just the client name and asserts the result is an error.

**Call relations**: This test covers the malformed-input branch of the parser used during probing.

*Call graph*: 1 external calls (assert!).


### `cli/src/doctor/background.rs`

`domain_logic` · `request handling`

This module contributes the `app-server` row to `codex doctor`. Its main function, `background_server_check`, derives the daemon state directory under `CODEX_HOME/app-server-daemon`, records the expected settings and PID file paths, and then resolves the control socket path using `codex_app_server::app_server_control_socket_path`. If socket-path resolution itself fails, the check returns a warning immediately with the accumulated file details and the resolution error.

When a socket path is available, the check records it, calls `socket_status`, and then adds a normalized status label, optional app-server version detail, and a mode string from `server_mode`. Mode is inferred purely from whether `settings.json` exists: `persistent` when present, otherwise `ephemeral`. `socket_status` is intentionally conservative: a missing socket means `NotRunning` and still counts as `Ok`; an existing socket triggers a bounded version probe via `codex_app_server_daemon::probe_app_server_version`; success means `Running(version)`, while any probe error becomes `StaleOrUnreachable(error)` and downgrades the check to `Warning`. `concise_probe_error` trims and sanitizes those probe errors by replacing the concrete socket path with `control socket`, collapsing whitespace, and truncating long messages to 120 characters. The result is a passive diagnostic that distinguishes healthy idle state from stale daemon artifacts without mutating daemon state.

#### Function details

##### `background_server_check`  (lines 27–76)

```
async fn background_server_check(config: &Config) -> DoctorCheck
```

**Purpose**: Builds the doctor row describing background app-server daemon state from existing files and an optional socket probe.

**Data flow**: Reads `config.codex_home`, constructs the daemon state directory, pushes details for settings and PID files via `push_file_detail`, then resolves the control socket path. On socket-path resolution failure it returns a warning `DoctorCheck` with the error detail. Otherwise it records the socket path, awaits `socket_status`, adds `status`, optional `app-server version`, and `mode` details, then returns a `DoctorCheck` whose status and summary come from the `SocketStatus`; warnings also get a remediation suggesting `codex app-server daemon version`.

**Call relations**: It is invoked by the main doctor orchestration after config loads. It delegates file inspection to `push_file_detail`, socket probing to `socket_status`, and mode inference to `server_mode`.

*Call graph*: calls 3 internal fn (new, push_file_detail, socket_status); called by 2 (failed_version_probe_reports_unavailable, not_running_background_server_stays_ok_without_version); 3 external calls (new, app_server_control_socket_path, format!).


##### `push_file_detail`  (lines 78–91)

```
fn push_file_detail(details: &mut Vec<String>, label: &str, path: &Path)
```

**Purpose**: Formats one daemon-related file path as present file, wrong type, missing, or unreadable.

**Data flow**: Checks metadata for the given `path` and pushes `<label>: <path> (file)` when it is a file, `(not a file)` for other existing objects, `(missing)` for `NotFound`, or the raw I/O error otherwise.

**Call relations**: It is used by `background_server_check` for `settings.json`, `app-server.pid`, and `app-server-updater.pid`.

*Call graph*: called by 1 (background_server_check); 2 external calls (format!, metadata).


##### `server_mode`  (lines 93–99)

```
fn server_mode(state_dir: &Path) -> &'static str
```

**Purpose**: Infers whether the daemon is in persistent or ephemeral mode based on the presence of the settings file.

**Data flow**: Checks whether `state_dir/settings.json` is a file and returns `persistent` if so, otherwise `ephemeral`.

**Call relations**: It is called by `background_server_check` after file details are gathered.

*Call graph*: 1 external calls (join).


##### `SocketStatus::check_status`  (lines 108–113)

```
fn check_status(&self) -> CheckStatus
```

**Purpose**: Maps socket-state variants to doctor check severity.

**Data flow**: Returns `CheckStatus::Ok` for `NotRunning` and `Running(_)`, and `CheckStatus::Warning` for `StaleOrUnreachable(_)`.

**Call relations**: Used by `background_server_check` when constructing the final `DoctorCheck`.


##### `SocketStatus::summary`  (lines 115–121)

```
fn summary(&self) -> &'static str
```

**Purpose**: Provides the row summary string corresponding to the socket-state variant.

**Data flow**: Matches the enum and returns one of `background server is not running`, `background server is running`, or `background server socket is stale or unreachable`.

**Call relations**: Used by `background_server_check` as the check summary.


##### `SocketStatus::detail_label`  (lines 123–129)

```
fn detail_label(&self) -> &'static str
```

**Purpose**: Provides the short status label used in the detail list.

**Data flow**: Matches the enum and returns `not running`, `running`, or `stale or unreachable`.

**Call relations**: Used by `background_server_check` for the `status:` detail line.


##### `SocketStatus::app_server_version_detail`  (lines 131–141)

```
fn app_server_version_detail(&self) -> Option<String>
```

**Purpose**: Formats the app-server version detail when available, or an unavailable message when probing failed.

**Data flow**: Returns `None` for `NotRunning`, `Some("app-server version: <version>")` for `Running(version)`, and `Some("app-server version: unavailable (<error>)")` for `StaleOrUnreachable(error)`.

**Call relations**: Called by `background_server_check` after socket probing.

*Call graph*: 1 external calls (format!).


##### `socket_status`  (lines 144–153)

```
async fn socket_status(socket_path: &Path) -> SocketStatus
```

**Purpose**: Determines whether the control socket indicates no daemon, a reachable daemon, or a stale/unreachable daemon artifact.

**Data flow**: Checks `socket_path.exists()`. If absent, returns `SocketStatus::NotRunning`. If present, awaits `codex_app_server_daemon::probe_app_server_version(socket_path)`; success becomes `Running(version)`, and failure becomes `StaleOrUnreachable(concise_probe_error(&err, socket_path))`.

**Call relations**: It is called by `background_server_check` as the only active probe in this module.

*Call graph*: calls 1 internal fn (concise_probe_error); called by 1 (background_server_check); 4 external calls (exists, Running, StaleOrUnreachable, probe_app_server_version).


##### `concise_probe_error`  (lines 155–176)

```
fn concise_probe_error(err: &anyhow::Error, socket_path: &Path) -> String
```

**Purpose**: Sanitizes and truncates daemon probe errors so they are readable and do not repeat the full socket path.

**Data flow**: Converts the socket path to a display string, replaces occurrences of that path in `err.to_string()` with `control socket`, collapses all whitespace runs into single spaces, returns `unknown error` if the result is empty, and otherwise truncates to `MAX_PROBE_ERROR_CHARS` with `...` when necessary.

**Call relations**: It is used only by `socket_status` when a version probe fails.

*Call graph*: called by 1 (socket_status); 3 external calls (display, to_string, format!).


##### `tests::test_config`  (lines 187–193)

```
async fn test_config(codex_home: PathBuf) -> Config
```

**Purpose**: Builds a minimal `Config` rooted at a supplied temporary `CODEX_HOME` for background-server tests.

**Data flow**: Uses `ConfigBuilder::default().codex_home(codex_home).build().await` and unwraps the result.

**Call relations**: Shared helper for the module’s async tests.

*Call graph*: 1 external calls (default).


##### `tests::create_socket_placeholder`  (lines 195–201)

```
fn create_socket_placeholder(config: &Config)
```

**Purpose**: Creates an empty file at the computed control socket path to simulate a stale socket artifact in tests.

**Data flow**: Resolves the socket path from `config.codex_home`, creates its parent directory, and writes an empty file at that path.

**Call relations**: Used by the failed-probe test before calling `background_server_check`.

*Call graph*: 3 external calls (app_server_control_socket_path, create_dir_all, write).


##### `tests::not_running_background_server_stays_ok_without_version`  (lines 204–219)

```
async fn not_running_background_server_stays_ok_without_version()
```

**Purpose**: Verifies that absence of a control socket is treated as a healthy idle state rather than a failure.

**Data flow**: Creates a temp config, runs `background_server_check`, and asserts ok status, `not running` summary/detail, and absence of any app-server version detail.

**Call relations**: Tests the `SocketStatus::NotRunning` path.

*Call graph*: calls 1 internal fn (background_server_check); 4 external calls (assert!, assert_eq!, test_config, tempdir).


##### `tests::running_background_server_reports_app_server_version`  (lines 222–232)

```
fn running_background_server_reports_app_server_version()
```

**Purpose**: Verifies the formatting behavior of the `Running(version)` socket-state variant.

**Data flow**: Constructs `SocketStatus::Running("1.2.3")` directly and asserts its derived check status, summary, detail label, and version detail string.

**Call relations**: Direct unit test for `SocketStatus` helper methods.

*Call graph*: 2 external calls (assert_eq!, Running).


##### `tests::failed_version_probe_reports_unavailable`  (lines 235–258)

```
async fn failed_version_probe_reports_unavailable()
```

**Purpose**: Verifies that an existing but unresponsive/unusable socket becomes a warning with an unavailable-version detail.

**Data flow**: Creates a temp config, writes a socket placeholder, runs `background_server_check`, and asserts warning status, stale/unreachable summary/detail, and an `app-server version: unavailable (...)` detail.

**Call relations**: Tests the `SocketStatus::StaleOrUnreachable` path driven through the full check.

*Call graph*: calls 1 internal fn (background_server_check); 5 external calls (assert!, assert_eq!, create_socket_placeholder, test_config, tempdir).


### Daemon remote-control switching
These files implement the daemon-side JSON-RPC flows that enable, disable, and monitor remote-control mode against the running app-server.

### `app-server-daemon/src/remote_control_client.rs`

`domain_logic` · `remote-control enable/disable requests and readiness waiting`

This module builds on `client.rs` to perform remote-control-specific protocol operations. The public entrypoints are `enable_remote_control`, `disable_remote_control`, and `enable_remote_control_with_connect_retry`. Each opens a websocket to the app-server control socket, performs an initialize handshake with `experimental_api` enabled, sends the appropriate `remoteControl/enable` or `remoteControl/disable` request, and converts the protocol response into the crate-level `RemoteControlReadyStatus`.

A key compatibility feature is `request_remote_control_with_legacy_fallback`: it first sends params `{ ephemeral: true }`, but if the server replies with JSON-RPC error code `-32602` (`INVALID_PARAMS_ERROR_CODE`), it retries the same method with `params: None` for older servers. Response handling is similarly selective: `read_remote_control_response` waits under the standard control-socket timeout, ignores unrelated notifications and messages, treats matching invalid-params errors specially, and surfaces other matching errors as failures.

Enablement may be asynchronous. `enable_remote_control_with_timeout` inspects the initial enable response; if the returned status is still `Connecting`, it calls `wait_for_remote_control_status`, which listens for `remoteControl/status/changed` notifications until a non-connecting state arrives or the ready timeout expires. Timeouts are reported in-band by setting `timed_out = true` on the latest known status rather than failing outright. The file also includes `From` conversions from protocol response/notification types into `RemoteControlReadyStatus`, plus extensive integration-style tests using a temporary Unix listener and websocket server to simulate modern and legacy server behavior.

#### Function details

##### `enable_remote_control`  (lines 37–40)

```
async fn enable_remote_control(socket_path: &Path) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Connects to the app-server socket and enables remote control using the default ready timeout. It returns the resulting connection status, possibly after waiting for asynchronous completion.

**Data flow**: Accepts a socket path, opens a websocket via `client::connect`, passes it to `enable_remote_control_with_timeout` with `REMOTE_CONTROL_READY_TIMEOUT`, and returns the resulting `RemoteControlReadyStatus`.

**Call relations**: Daemon remote-control readiness flows call this when the socket should already be reachable. It delegates all protocol details to the timeout-aware helper.

*Call graph*: calls 2 internal fn (connect, enable_remote_control_with_timeout); called by 2 (ensure_remote_control_ready, set_remote_control_locked).


##### `disable_remote_control`  (lines 42–54)

```
async fn disable_remote_control(socket_path: &Path) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Connects to the app-server socket, initializes the client, sends a disable request with legacy fallback, and returns the resulting status. Unlike enable, it does not wait for later notifications.

**Data flow**: Connects to the socket, runs `initialize_client`, serializes `RemoteControlDisableParams { ephemeral: true }`, sends the request through `request_remote_control_with_legacy_fallback`, closes the websocket best-effort, converts the `RemoteControlDisableResponse` into `RemoteControlReadyStatus`, and returns it.

**Call relations**: Daemon remote-control-setting logic calls this when a running managed backend should be disabled live without a restart. Tests also invoke it directly against a simulated server.

*Call graph*: calls 3 internal fn (connect, initialize_client, request_remote_control_with_legacy_fallback); called by 2 (set_remote_control_locked, disable_remote_control_retries_without_params_for_older_servers); 2 external calls (from, to_value).


##### `enable_remote_control_with_connect_retry`  (lines 56–64)

```
async fn enable_remote_control_with_connect_retry(
    socket_path: &Path,
    connect_timeout: Duration,
    connect_retry_delay: Duration,
) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Enables remote control but first retries socket connection until a caller-specified deadline. This is useful when the app-server may still be coming up.

**Data flow**: Accepts socket path plus connect timeout and retry delay, obtains a websocket from `connect_with_retry`, then delegates to `enable_remote_control_with_timeout` with the standard ready timeout.

**Call relations**: The public `enable_remote_control_on_socket` API uses this helper to combine transport readiness retry with remote-control enablement.

*Call graph*: calls 2 internal fn (connect_with_retry, enable_remote_control_with_timeout); called by 1 (enable_remote_control_on_socket).


##### `enable_remote_control_with_timeout`  (lines 66–87)

```
async fn enable_remote_control_with_timeout(
    websocket: &mut WebSocketStream<S>,
    ready_timeout: Duration,
) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Performs the full remote-control enable flow on an existing websocket and optionally waits for a later status notification if the initial response says `Connecting`.

**Data flow**: Initializes the client, sends `remoteControl/enable` through `request_remote_control_with_legacy_fallback` using `{ ephemeral: true }`, converts the response into `RemoteControlReadyStatus`, and if that status is `Connecting` calls `wait_for_remote_control_status` with the supplied timeout. It then closes the websocket and returns the final/latest status.

**Call relations**: Both direct enablement and connect-retry enablement delegate here, and tests call it directly against an in-process websocket server.

*Call graph*: calls 3 internal fn (initialize_client, request_remote_control_with_legacy_fallback, wait_for_remote_control_status); called by 3 (enable_remote_control, enable_remote_control_with_connect_retry, run_enable_remote_control_scenario); 3 external calls (close, from, to_value).


##### `initialize_client`  (lines 89–101)

```
async fn initialize_client(websocket: &mut WebSocketStream<S>) -> Result<()>
```

**Purpose**: Performs the protocol handshake required before remote-control RPCs: initialize with experimental API enabled, then send the `initialized` notification.

**Data flow**: Accepts a mutable websocket, awaits `client::initialize(websocket, true)`, constructs a JSON-RPC `initialized` notification, sends it with `client::send_message`, and returns success or a contextualized send error.

**Call relations**: Both enable and disable flows call this before issuing remote-control requests, because those methods rely on experimental API capability negotiation.

*Call graph*: calls 2 internal fn (initialize, send_message); called by 2 (disable_remote_control, enable_remote_control_with_timeout); 1 external calls (Notification).


##### `send_remote_control_request`  (lines 103–121)

```
async fn send_remote_control_request(
    websocket: &mut WebSocketStream<S>,
    request_id: RequestId,
    method: &str,
    params: Option<serde_json::Value>,
) -> Result<()>
```

**Purpose**: Constructs and sends a JSON-RPC request for a remote-control method with a caller-specified id and optional params. It adds method-specific send context to failures.

**Data flow**: Builds `JSONRPCMessage::Request(JSONRPCRequest { id, method: method.to_string(), params, trace: None })`, sends it via `client::send_message`, and returns `Ok(())` or an error mentioning the method name.

**Call relations**: The legacy-fallback request helper uses this for both the initial parameterized request and the fallback parameterless retry.

*Call graph*: calls 1 internal fn (send_message); called by 1 (request_remote_control_with_legacy_fallback); 1 external calls (Request).


##### `request_remote_control_with_legacy_fallback`  (lines 123–159)

```
async fn request_remote_control_with_legacy_fallback(
    websocket: &mut WebSocketStream<S>,
    method: &str,
    params: serde_json::Value,
) -> Result<T>
```

**Purpose**: Sends a remote-control request with modern params first, then transparently retries without params if the server reports `Invalid params`. It returns the parsed success payload or an explicit error if both forms are rejected.

**Data flow**: Sends the request with `Some(params)` using the fixed `REMOTE_CONTROL_REQUEST_ID`, reads the response via `read_remote_control_response`, and on `Success` returns the parsed value. On `InvalidParams`, it resends the same method with `params: None`, rereads the response, and either returns the parsed success value or errors if the fallback also yields `InvalidParams`.

**Call relations**: Both enable and disable operations rely on this helper to remain compatible with older app-server versions that do not accept the newer `ephemeral` parameter object.

*Call graph*: calls 2 internal fn (read_remote_control_response, send_remote_control_request); called by 2 (disable_remote_control, enable_remote_control_with_timeout); 1 external calls (anyhow!).


##### `connect_with_retry`  (lines 161–183)

```
async fn connect_with_retry(
    socket_path: &Path,
    connect_timeout: Duration,
    connect_retry_delay: Duration,
) -> Result<WebSocketStream<codex_uds::UnixStream>>
```

**Purpose**: Retries websocket connection attempts until a deadline, sleeping between failures. It converts repeated connection failures into a readiness-style error naming the socket path.

**Data flow**: Computes a deadline from `connect_timeout`, loops calling `client::connect(socket_path)`, returns the websocket on success, sleeps `connect_retry_delay` after failures before the deadline, and on the final failure returns that error with added context.

**Call relations**: Only `enable_remote_control_with_connect_retry` uses this helper, separating transport retry policy from the remote-control protocol flow.

*Call graph*: calls 1 internal fn (connect); called by 1 (enable_remote_control_with_connect_retry); 2 external calls (now, sleep).


##### `read_remote_control_response`  (lines 185–223)

```
async fn read_remote_control_response(
    websocket: &mut WebSocketStream<S>,
    request_id: &RequestId,
    method: &str,
) -> Result<RemoteControlRpcResponse<T>>
```

**Purpose**: Waits for the JSON-RPC response corresponding to a specific remote-control request id and method. It ignores unrelated notifications, recognizes invalid-params errors specially, and parses successful results into the caller’s response type.

**Data flow**: Repeatedly reads messages under `client::CONTROL_SOCKET_RESPONSE_TIMEOUT`. A matching `Response` is deserialized from `response.result` into `T` and returned as `RemoteControlRpcResponse::Success`. A matching `Error` with code `INVALID_PARAMS_ERROR_CODE` returns `InvalidParams`; other matching errors become `anyhow!` failures. Notifications carrying remote-control status changes are ignored, as are unrelated messages.

**Call relations**: The legacy-fallback helper depends on this function to distinguish retryable invalid-params failures from successful responses and hard errors.

*Call graph*: calls 2 internal fn (read_message, remote_control_status_notification); called by 1 (request_remote_control_with_legacy_fallback); 3 external calls (anyhow!, Success, timeout).


##### `wait_for_remote_control_status`  (lines 225–257)

```
async fn wait_for_remote_control_status(
    websocket: &mut WebSocketStream<S>,
    mut latest: RemoteControlReadyStatus,
    ready_timeout: Duration,
) -> Result<RemoteControlReadyStatus>
```

**Purpose**: After an enable response reports `Connecting`, waits for later status-change notifications until a non-connecting state arrives or the ready timeout expires. Timeout is reported in-band on the latest known status.

**Data flow**: Accepts a websocket, an initial `latest` status, and a timeout duration. It computes a deadline, repeatedly waits for the next message with the remaining time, ignores non-notification and unrelated notification messages, updates `latest` from any `remoteControl/status/changed` notification, and returns once `latest.status` is no longer `Connecting`. If the timeout expires first, it sets `latest.timed_out = true` and returns it.

**Call relations**: Only the enable flow uses this helper, because disable returns its immediate RPC result. It depends on `remote_control_status_notification` to recognize relevant notifications.

*Call graph*: calls 2 internal fn (read_message, remote_control_status_notification); called by 1 (enable_remote_control_with_timeout); 3 external calls (from, now, timeout).


##### `remote_control_status_notification`  (lines 259–267)

```
fn remote_control_status_notification(
    notification: &JSONRPCNotification,
) -> Option<RemoteControlStatusChangedNotification>
```

**Purpose**: Recognizes and parses the specific notification method used for remote-control status updates. Unrelated notifications or unparsable params are ignored.

**Data flow**: Checks whether `notification.method` equals `remoteControl/status/changed`; if not, returns `None`. Otherwise it clones `notification.params`, returns `None` if absent, and attempts `serde_json::from_value` into `RemoteControlStatusChangedNotification`, returning `Some` on success.

**Call relations**: Both response-reading and status-waiting loops use this helper to filter out asynchronous status notifications from other protocol traffic.

*Call graph*: called by 2 (read_remote_control_response, wait_for_remote_control_status); 1 external calls (from_value).


##### `RemoteControlReadyStatus::from`  (lines 304–317)

```
fn from(notification: RemoteControlStatusChangedNotification) -> Self
```

**Purpose**: Converts a `RemoteControlEnableResponse` into the crate-level readiness status type, dropping protocol fields the daemon does not expose and initializing `timed_out` to false.

**Data flow**: Consumes `RemoteControlEnableResponse`, extracts `status`, `server_name`, and `environment_id`, ignores `installation_id`, and returns `RemoteControlReadyStatus { ..., timed_out: false }`.

**Call relations**: Enable flows call this conversion immediately after parsing the RPC response so later waiting logic can update the same status structure.


##### `tests::enable_remote_control_uses_connected_enable_response_without_later_notification`  (lines 339–366)

```
async fn enable_remote_control_uses_connected_enable_response_without_later_notification() -> Result<()>
```

**Purpose**: Verifies that when the enable RPC itself already reports `Connected`, the client returns that status without requiring a later notification.

**Data flow**: Builds an `EnableScenario` whose initial and enable statuses are `Connected`, runs it through `run_enable_remote_control_scenario`, and asserts the returned `RemoteControlReadyStatus` matches the connected response with `timed_out = false`.

**Call relations**: This test exercises the branch in `enable_remote_control_with_timeout` that skips waiting when the immediate response is already terminal.

*Call graph*: 4 external calls (from_millis, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::enable_remote_control_waits_for_connected_notification`  (lines 369–395)

```
async fn enable_remote_control_waits_for_connected_notification() -> Result<()>
```

**Purpose**: Verifies that when the enable RPC reports `Connecting`, the client waits for a later `Connected` notification and returns that updated status.

**Data flow**: Creates a scenario with `Connecting` in the enable response and a later `Connected` notification, runs it, and asserts the final returned status reflects the notification’s connected state and environment id.

**Call relations**: This test covers the `wait_for_remote_control_status` path used by asynchronous enablement.

*Call graph*: 4 external calls (from_secs, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::enable_remote_control_reports_connecting_after_timeout`  (lines 398–421)

```
async fn enable_remote_control_reports_connecting_after_timeout() -> Result<()>
```

**Purpose**: Verifies that if no terminal status notification arrives before the ready timeout, the client returns the latest `Connecting` status with `timed_out = true` instead of failing.

**Data flow**: Runs a scenario whose enable response is `Connecting` and sends no later notification, using a short timeout, then asserts the returned status remains `Connecting` with `timed_out` set.

**Call relations**: This test documents the in-band timeout reporting behavior of `wait_for_remote_control_status`.

*Call graph*: 4 external calls (from_millis, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::enable_remote_control_returns_errored_enable_response`  (lines 424–447)

```
async fn enable_remote_control_returns_errored_enable_response() -> Result<()>
```

**Purpose**: Verifies that a terminal `Errored` status returned directly by the enable RPC is surfaced as-is, without waiting for notifications.

**Data flow**: Runs a scenario whose enable response is `Errored` and asserts the returned `RemoteControlReadyStatus` matches that response with `timed_out = false`.

**Call relations**: This test covers another non-waiting branch of `enable_remote_control_with_timeout`.

*Call graph*: 4 external calls (from_millis, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::enable_remote_control_retries_without_params_for_older_servers`  (lines 450–473)

```
async fn enable_remote_control_retries_without_params_for_older_servers() -> Result<()>
```

**Purpose**: Verifies compatibility fallback for older servers that reject the modern `{ ephemeral: true }` params object on enable requests.

**Data flow**: Runs a scenario configured to reject ephemeral params with `INVALID_PARAMS_ERROR_CODE`, causing the client to resend `remoteControl/enable` without params, then asserts the final returned status is successful and connected.

**Call relations**: This test directly validates `request_remote_control_with_legacy_fallback` in the enable path.

*Call graph*: 4 external calls (from_millis, remote_control_status, run_enable_remote_control_scenario, assert_eq!).


##### `tests::disable_remote_control_retries_without_params_for_older_servers`  (lines 476–539)

```
async fn disable_remote_control_retries_without_params_for_older_servers() -> Result<()>
```

**Purpose**: Verifies the same invalid-params fallback behavior for disable requests against a simulated websocket server.

**Data flow**: Creates a temporary Unix listener, serves an initialized websocket session that first rejects `remoteControl/disable` with params and then accepts a fallback request without params, calls `disable_remote_control`, waits for the server task, and asserts the returned status is `Disabled`.

**Call relations**: This test exercises the full disable flow, including `initialize_client`, request fallback, and response conversion.

*Call graph*: calls 5 internal fn (read_message, send_message, disable_remote_control, from, bind); 9 external calls (new, accept_initialized_client, remote_control_status, Error, Response, assert_eq!, panic!, to_value, spawn).


##### `tests::run_enable_remote_control_scenario`  (lines 549–562)

```
async fn run_enable_remote_control_scenario(
        scenario: EnableScenario,
    ) -> Result<RemoteControlReadyStatus>
```

**Purpose**: Test harness that spins up a temporary websocket server implementing a scripted enable scenario and runs the client against it.

**Data flow**: Creates a temp socket path and Unix listener, spawns `serve_enable_remote_control_scenario(listener, scenario)`, connects a websocket with `client::connect`, calls `enable_remote_control_with_timeout` using the scenario’s timeout, waits for the server task, and returns the resulting status.

**Call relations**: Multiple enable-related tests share this helper so they can vary only the scripted server behavior.

*Call graph*: calls 3 internal fn (connect, enable_remote_control_with_timeout, bind); 3 external calls (new, serve_enable_remote_control_scenario, spawn).


##### `tests::serve_enable_remote_control_scenario`  (lines 564–622)

```
async fn serve_enable_remote_control_scenario(
        listener: UnixListener,
        scenario: EnableScenario,
    ) -> Result<()>
```

**Purpose**: Implements the server side of the scripted enable scenarios used in tests. It validates client requests, optionally simulates legacy invalid-params behavior, and emits configured responses/notifications.

**Data flow**: Accepts and initializes a websocket client, optionally sends an initial status notification, reads and validates the `remoteControl/enable` request, optionally sends an invalid-params error and validates the fallback request, sends the configured enable response, optionally sends a later status notification, or sleeps briefly if none is configured.

**Call relations**: This helper is spawned by `run_enable_remote_control_scenario` and drives the client through the exact branches each test wants to cover.

*Call graph*: calls 3 internal fn (read_message, send_message, from); 9 external calls (from_millis, accept_initialized_client, send_remote_control_status, Error, Response, assert_eq!, panic!, to_value, sleep).


##### `tests::accept_initialized_client`  (lines 624–662)

```
async fn accept_initialized_client(
        mut listener: UnixListener,
    ) -> Result<WebSocketStream<codex_uds::UnixStream>>
```

**Purpose**: Accepts a websocket connection from the client and validates the initialize handshake expected before remote-control RPCs. It then returns the ready websocket for further scripted interaction.

**Data flow**: Accepts a Unix stream, upgrades it with `accept_async`, reads the initialize request, asserts request id/method and `experimentalApi = true`, sends a synthetic initialize response, reads the subsequent `initialized` notification, asserts its method, and returns the websocket.

**Call relations**: Both enable and disable test servers use this helper to share handshake validation logic before exercising remote-control requests.

*Call graph*: calls 3 internal fn (read_message, send_message, accept); 5 external calls (Response, assert_eq!, panic!, json!, accept_async).


##### `tests::send_remote_control_status`  (lines 664–679)

```
async fn send_remote_control_status(
        websocket: &mut WebSocketStream<S>,
        status: RemoteControlStatusChangedNotification,
    ) -> Result<()>
```

**Purpose**: Sends a `remoteControl/status/changed` notification over a websocket in tests. It is a small helper for scripted server behavior.

**Data flow**: Serializes the provided `RemoteControlStatusChangedNotification` into JSON params, wraps it in a `JSONRPCMessage::Notification` with the fixed method name, sends it via `client::send_message`, and returns success/failure.

**Call relations**: The scripted enable server uses this helper to emit initial or later status notifications consumed by the client’s waiting logic.

*Call graph*: calls 1 internal fn (send_message); 2 external calls (Notification, to_value).


##### `tests::remote_control_status`  (lines 681–691)

```
fn remote_control_status(
        status: RemoteControlConnectionStatus,
        environment_id: Option<&str>,
    ) -> RemoteControlStatusChangedNotification
```

**Purpose**: Constructs a test `RemoteControlStatusChangedNotification` with fixed server and installation identifiers and a caller-specified status/environment id.

**Data flow**: Accepts a `RemoteControlConnectionStatus` and optional environment id string, fills in constant `server_name` and `installation_id`, maps the environment id to `Option<String>`, and returns the notification struct.

**Call relations**: Enable and disable tests use this helper to build consistent synthetic protocol payloads for responses and notifications.


### Server bootstrap and connection routing
These files bring up the app-server runtime itself, initialize connections, and manage outbound delivery across in-process and external transports.

### `app-server/src/lib.rs`

`orchestration` · `startup, request handling, graceful shutdown`

This crate root defines the app server’s startup pipeline and the shared control structures that tie transport, request processing, and graceful shutdown together. It declares most subsystem modules, re-exports transport/auth entry types, and contains the concrete runtime loop in `run_main_with_transport_options`.

Startup begins by applying debug-only loader overrides, parsing CLI config overrides, locating Codex home, constructing exec runtime paths and an `EnvironmentManager`, and creating a `ConfigManager`. The code eagerly preloads config once to discover cloud/thread config loaders, then reloads the effective config with strict/non-strict fallback behavior. It accumulates `ConfigWarningNotification` values from config parse failures, exec-policy parse warnings, disabled project layers, startup warnings, sandbox warnings, and SQLite recovery.

The file also initializes OpenTelemetry, tracing subscribers, feedback/logging layers, and the SQLite-backed state database with corruption recovery that moves damaged files aside and retries initialization. Transport startup supports stdio, Unix socket, websocket, or no local transport, plus optional remote control gated by managed requirements and state DB availability.

Runtime execution is split into two async tasks: an outbound router task that owns per-connection writers and an inbound processor task that owns `ConnectionState`, dispatches JSON-RPC through `MessageProcessor`, mirrors per-session flags into outbound state, broadcasts remote-control status, attaches thread listeners, and performs graceful drain on shutdown signals. `ShutdownState` encodes the invariant that the first signal requests a drain and a second forceable signal skips waiting. Tests cover log-format parsing and the debug-only test config override path.

#### Function details

##### `configured_thread_config_loader`  (lines 136–141)

```
fn configured_thread_config_loader(config: &Config) -> Arc<dyn ThreadConfigLoader>
```

**Purpose**: Builds the concrete `ThreadConfigLoader` implementation implied by the loaded `Config`. It selects a remote loader only when `experimental_thread_config_endpoint` is configured; otherwise it returns a no-op loader.

**Data flow**: Reads `config.experimental_thread_config_endpoint` from the provided `&Config` → matches `Some(endpoint)` vs `None` → returns `Arc<dyn ThreadConfigLoader>` wrapping either `RemoteThreadConfigLoader::new(endpoint)` or `NoopThreadConfigLoader`.

**Call relations**: This is invoked during startup by `run_main_with_transport_options` after an initial config preload, so the `ConfigManager` can swap in the discovered thread-config source before the main config load proceeds.

*Call graph*: calls 1 internal fn (new); called by 1 (run_main_with_transport_options); 1 external calls (new).


##### `shutdown_signal`  (lines 187–208)

```
async fn shutdown_signal() -> IoResult<ShutdownSignal>
```

**Purpose**: Waits asynchronously for an OS shutdown signal and classifies it as either forceable or graceful-only. On Unix it distinguishes Ctrl-C/SIGTERM from SIGHUP; on non-Unix it only listens for Ctrl-C.

**Data flow**: Reads process signal streams from Tokio signal APIs → races them with `tokio::select!` → returns `IoResult<ShutdownSignal>` indicating `Forceable` or, on Unix, `GracefulOnly`.

**Call relations**: The processor loop in `run_main_with_transport_options` awaits this only when graceful signal handling is enabled and shutdown has not already been forced, using the result to update `ShutdownState`.

*Call graph*: 4 external calls (hangup, terminate, select!, ctrl_c).


##### `ShutdownState::requested`  (lines 211–213)

```
fn requested(&self) -> bool
```

**Purpose**: Reports whether graceful shutdown has already been initiated.

**Data flow**: Reads `self.requested` from `ShutdownState` → returns the boolean unchanged.

**Call relations**: Used inside the main processor loop to gate whether it should keep watching running-turn count changes during a drain.


##### `ShutdownState::forced`  (lines 215–217)

```
fn forced(&self) -> bool
```

**Purpose**: Reports whether shutdown has escalated from graceful drain to forced termination.

**Data flow**: Reads `self.forced` from `ShutdownState` → returns the boolean unchanged.

**Call relations**: The processor loop checks this to stop listening for additional shutdown signals and to decide whether to skip orderly cleanup at exit.


##### `ShutdownState::on_signal`  (lines 219–238)

```
fn on_signal(
        &mut self,
        signal: ShutdownSignal,
        connection_count: usize,
        running_turn_count: usize,
    )
```

**Purpose**: Consumes a newly received shutdown signal and updates drain state. The first signal starts graceful restart logging; a later forceable signal upgrades the state to forced shutdown.

**Data flow**: Takes the incoming `ShutdownSignal` plus current `connection_count` and `running_turn_count` → if shutdown was already requested, only flips `self.forced` for a forceable signal; otherwise sets `self.requested = true`, clears `last_logged_running_turn_count`, and emits an informational log describing the drain conditions.

**Call relations**: Called by the processor task in `run_main_with_transport_options` whenever `shutdown_signal()` resolves. It does not perform shutdown itself; it only mutates state that `ShutdownState::update` later interprets.

*Call graph*: 2 external calls (info!, matches!).


##### `ShutdownState::update`  (lines 240–266)

```
fn update(&mut self, running_turn_count: usize, connection_count: usize) -> ShutdownAction
```

**Purpose**: Evaluates whether the current drain state should continue waiting or finish shutdown now. It also rate-limits progress logs so repeated loop iterations do not spam identical messages.

**Data flow**: Reads `self.requested`, `self.forced`, and `last_logged_running_turn_count` together with current `running_turn_count` and `connection_count` → returns `ShutdownAction::Noop` if no shutdown or still draining, or `ShutdownAction::Finish` if forced or no assistant turns remain; updates `last_logged_running_turn_count` when the wait count changes and emits the corresponding log message.

**Call relations**: At the top of each processor-loop iteration in `run_main_with_transport_options`, this decides whether to cancel transport acceptance and broadcast `OutboundControlEvent::DisconnectAll`.

*Call graph*: 1 external calls (info!).


##### `config_warning_from_error`  (lines 269–283)

```
fn config_warning_from_error(
    summary: impl Into<String>,
    err: &std::io::Error,
) -> ConfigWarningNotification
```

**Purpose**: Converts a configuration load `std::io::Error` into a protocol-level `ConfigWarningNotification`, preserving file/range metadata when the underlying cause is a `ConfigLoadError`.

**Data flow**: Accepts a summary string and an `&std::io::Error` → calls `config_error_location` to extract optional `(path, range)` → builds and returns `ConfigWarningNotification { summary, details: Some(err.to_string()), path, range }`.

**Call relations**: Used by `run_main_with_transport_options` when non-strict config loading fails and startup falls back to defaults, so the client still receives a concrete warning.

*Call graph*: calls 1 internal fn (config_error_location); called by 1 (run_main_with_transport_options); 2 external calls (into, to_string).


##### `config_error_location`  (lines 285–295)

```
fn config_error_location(err: &std::io::Error) -> Option<(String, AppTextRange)>
```

**Purpose**: Extracts source-file location information from an I/O error that wraps `codex_config::ConfigLoadError`.

**Data flow**: Reads `err.get_ref()`, downcasts the inner error to `ConfigLoadError`, then reads its `config_error().path` and `config_error().range` → converts the core range with `app_text_range` → returns `Option<(String, AppTextRange)>`.

**Call relations**: This is a helper only for `config_warning_from_error`, isolating the downcast-and-convert logic from the warning construction path.

*Call graph*: called by 1 (config_warning_from_error); 1 external calls (get_ref).


##### `exec_policy_warning_location`  (lines 297–317)

```
fn exec_policy_warning_location(err: &ExecPolicyError) -> (Option<String>, Option<AppTextRange>)
```

**Purpose**: Maps an `ExecPolicyError` into optional path/range metadata suitable for a startup warning. It only produces a text range for parse-policy errors that carry source locations.

**Data flow**: Matches on `&ExecPolicyError` → for `ParsePolicy { path, source }`, reads `source.location()` and, if present, constructs an `AppTextRange` from the parser location; otherwise returns the policy path without a range; all other variants return `(None, None)`.

**Call relations**: Called by `run_main_with_transport_options` after `check_execpolicy_for_warnings` reports a warning-worthy parse failure, so the resulting `ConfigWarningNotification` can point back to the offending policy file.

*Call graph*: called by 1 (run_main_with_transport_options).


##### `app_text_range`  (lines 319–330)

```
fn app_text_range(range: &CoreTextRange) -> AppTextRange
```

**Purpose**: Converts the core config text-range type into the app-server protocol text-range type.

**Data flow**: Reads `range.start.line`, `range.start.column`, `range.end.line`, and `range.end.column` from `&CoreTextRange` → constructs and returns `AppTextRange` with corresponding `AppTextPosition` values.

**Call relations**: Used by `config_error_location` and conceptually mirrors the manual conversion done in `exec_policy_warning_location`.


##### `project_config_warning`  (lines 332–372)

```
fn project_config_warning(config: &Config) -> Option<ConfigWarningNotification>
```

**Purpose**: Builds a single startup warning summarizing project-local config layers that were discovered but disabled because the project is not trusted.

**Data flow**: Iterates `config.config_layer_stack.get_layers(...)` including disabled layers → filters for `ConfigLayerSource::Project` entries with a `disabled_reason` → accumulates `(folder, reason)` pairs → if any exist, formats a multiline summary and returns `Some(ConfigWarningNotification)` with no path/range; otherwise returns `None`.

**Call relations**: During startup, `run_main_with_transport_options` calls this after config load and appends the resulting warning to the list sent to clients and logs.

*Call graph*: called by 1 (run_main_with_transport_options); 3 external calls (new, concat!, format!).


##### `LogFormat::from_env_value`  (lines 375–380)

```
fn from_env_value(value: Option<&str>) -> Self
```

**Purpose**: Parses the `LOG_FORMAT` environment variable into the internal `LogFormat` enum. Only the case-insensitive token `json` selects structured logging; everything else falls back to the default formatter.

**Data flow**: Accepts `Option<&str>` → trims and lowercases the string when present → returns `LogFormat::Json` for exactly `json`, otherwise `LogFormat::Default`.

**Call relations**: This parser is used by `log_format_from_env`, and its behavior is validated by the unit tests in this file.

*Call graph*: called by 1 (log_format_from_env).


##### `log_format_from_env`  (lines 383–386)

```
fn log_format_from_env() -> LogFormat
```

**Purpose**: Reads the process environment and resolves the desired stderr log format.

**Data flow**: Calls `std::env::var(LOG_FORMAT_ENV_VAR).ok()` to get an optional string → passes `as_deref()` into `LogFormat::from_env_value` → returns the selected `LogFormat`.

**Call relations**: Called once during startup by `run_main_with_transport_options` to choose between plain-text and JSON tracing subscriber layers.

*Call graph*: calls 1 internal fn (from_env_value); called by 1 (run_main_with_transport_options); 1 external calls (var).


##### `run_main`  (lines 388–407)

```
async fn run_main(
    arg0_paths: Arg0DispatchPaths,
    cli_config_overrides: CliConfigOverrides,
    loader_overrides: LoaderOverrides,
    strict_config: bool,
    default_analytics_enabled: bool,
```

**Purpose**: Provides the default app-server entry path for normal callers. It fixes the transport/session/auth/runtime defaults and delegates all real work to the more configurable runtime function.

**Data flow**: Accepts dispatch paths, CLI overrides, loader overrides, strict-config flag, and analytics default → supplies `AppServerTransport::Stdio`, `SessionSource::VSCode`, default websocket auth settings, and `AppServerRuntimeOptions::default()` → awaits and returns the `IoResult<()>` from `run_main_with_transport_options`.

**Call relations**: This is the public convenience wrapper above `run_main_with_transport_options`, used when the caller wants the standard stdio-based server behavior.

*Call graph*: calls 2 internal fn (default, run_main_with_transport_options); 1 external calls (default).


##### `AppServerRuntimeOptions::default`  (lines 423–429)

```
fn default() -> Self
```

**Purpose**: Defines the runtime defaults for plugin startup, remote-control startup mode, and signal-handler installation.

**Data flow**: Constructs and returns `AppServerRuntimeOptions { plugin_startup_tasks: PluginStartupTasks::Start, remote_control_startup_mode: RemoteControlStartupMode::ResolvePersisted, install_shutdown_signal_handler: true }`.

**Call relations**: Used by `run_main` to populate the standard runtime behavior without requiring the caller to specify each option.

*Call graph*: called by 1 (run_main).


##### `run_main_with_transport_options`  (lines 433–1180)

```
async fn run_main_with_transport_options(
    arg0_paths: Arg0DispatchPaths,
    cli_config_overrides: CliConfigOverrides,
    loader_overrides: LoaderOverrides,
    strict_config: bool,
    default_a
```

**Purpose**: Bootstraps the entire app server, starts transports and background tasks, runs the main processor/outbound loops, and performs orderly or forced shutdown. It is the file’s central orchestration function.

**Data flow**: Consumes startup inputs including dispatch paths, CLI/config overrides, strictness, analytics default, transport selection, session source, websocket auth settings, and runtime options. It first applies debug-only test config overrides, creates MPSC channels for transport events, outgoing envelopes, and outbound control, parses CLI key/value overrides, resolves Codex home and exec runtime paths, and builds `EnvironmentManager` and `ConfigManager`. It preloads config to install cloud/thread loaders, then loads the effective config with fallback to defaults in non-strict mode while collecting `ConfigWarningNotification`s. Next it initializes OpenTelemetry, startup locks for Unix sockets, and the SQLite state DB via `init_sqlite_state_db_with_fresh_start_on_corruption`; optionally reruns config after personality migration; checks exec-policy and project-config warnings; installs tracing/feedback/log DB/OTel layers; and computes remote-control policy.

It then starts the selected local transport acceptor(s), creates an `AuthManager`, validates remote-control viability, starts remote control, and spawns two tasks. The outbound task owns `HashMap<ConnectionId, OutboundConnectionState>` and reacts to `OutboundControlEvent::{Opened,Closed,DisconnectAll}` plus outgoing envelopes routed by `route_outgoing_envelope`. The processor task owns `HashMap<ConnectionId, ConnectionState>`, a `MessageProcessor`, cleanup tasks, thread-created and running-turn subscriptions, and remote-control status watching. Its select loop handles shutdown signals, transport open/close/message events, cleanup completions, remote-control status changes, and thread creation broadcasts. For requests it updates per-connection outbound mirrors (`initialized`, `experimental_api_enabled`, opted-out notifications), sends initialize notifications on first successful initialization, and invokes `connection_initialized`. On connection close it shuts the RPC gate, schedules processor cleanup, and exits in single-client mode when the last connection disappears. On graceful shutdown completion it cancels transport acceptance, disconnects clients, drains RPC gates/background tasks/threads unless forced, then joins all tasks, cancels acceptors, shuts down OTel, and returns `Ok(())`.

**Call relations**: This function is called by `run_main` and serves as the top-level driver for nearly every helper in the file: config warning builders, thread-loader selection, SQLite recovery, log-format selection, analytics transport mapping, and debug-only loader override handling. It also coordinates external subsystems such as transport acceptors, remote control, `MessageProcessor`, `ConfigManager`, and telemetry.

*Call graph*: calls 27 internal fn (app_server_startup_lock_path, policy_from_settings, analytics_rpc_transport, analytics_events_client_from_config, new, config_warning_from_error, configured_thread_config_loader, new, exec_policy_warning_location, init_sqlite_state_db_with_fresh_start_on_corruption (+15 more)); called by 1 (run_main); 33 external calls (clone, new, new, default, from_default_env, new, new, new, new, default (+15 more)).


##### `init_sqlite_state_db_with_fresh_start_on_corruption`  (lines 1196–1267)

```
async fn init_sqlite_state_db_with_fresh_start_on_corruption(
    config: &Config,
) -> anyhow::Result<StateDbInitResult>
```

**Purpose**: Initializes the rollout/state SQLite runtime, but if the database appears corrupted or blocked by a file where the DB directory should be, it moves the damaged files into a backup folder and retries from a clean slate.

**Data flow**: Reads `config` to call `rollout_state_db::try_init(config).await` in a loop. On success, it derives an optional `SqliteRecoveryNotice` from accumulated `RecoveredSqliteDatabase` entries, emits warning logs for recovered databases, and returns `StateDbInitResult { state_db: Some(handle), recovery_notice }`. On failure, it determines the affected database path from the corruption error or default state DB path, checks `codex_state::is_sqlite_corruption_error` and `sqlite_home_is_blocking_file`, tracks attempted backups in a `HashSet` to avoid infinite retries, logs warnings, calls `codex_state::backup_runtime_db_for_fresh_start`, records backup metadata, and loops to retry initialization. Non-corruption failures are returned as errors.

**Call relations**: Called during startup by `run_main_with_transport_options` before remote control and processor startup. It delegates warning emission to `emit_state_db_backup_warning`, path sanity checks to `sqlite_home_is_blocking_file`, and user-facing notice formatting to `sqlite_recovery_notice`.

*Call graph*: calls 3 internal fn (emit_state_db_backup_warning, sqlite_home_is_blocking_file, sqlite_recovery_notice); called by 1 (run_main_with_transport_options); 8 external calls (new, new, anyhow!, backup_runtime_db_for_fresh_start, is_sqlite_corruption_error, runtime_db_path_for_corruption_error, format!, try_init).


##### `sqlite_home_is_blocking_file`  (lines 1269–1274)

```
fn sqlite_home_is_blocking_file(database_path: &Path) -> bool
```

**Purpose**: Detects a specific filesystem misconfiguration where the parent directory of the SQLite database path exists as a regular file, preventing DB creation.

**Data flow**: Takes a `&Path` for the database file → reads its parent path and filesystem metadata → returns `true` when the parent exists and `metadata.is_file()`.

**Call relations**: Used by `init_sqlite_state_db_with_fresh_start_on_corruption` as an additional recovery trigger even when the initialization error is not classified as SQLite corruption.

*Call graph*: called by 1 (init_sqlite_state_db_with_fresh_start_on_corruption); 1 external calls (parent).


##### `sqlite_recovery_notice`  (lines 1276–1294)

```
fn sqlite_recovery_notice(
    recovered_databases: &[RecoveredSqliteDatabase],
) -> Option<SqliteRecoveryNotice>
```

**Purpose**: Formats a client-visible recovery notice summarizing which SQLite databases were moved aside and where their backups were stored.

**Data flow**: Accepts a slice of `RecoveredSqliteDatabase` → returns `None` if empty; otherwise iterates the entries, formats each as `Database path` plus `Backup folder`, joins them with blank lines, and returns `Some(SqliteRecoveryNotice { details })`.

**Call relations**: Called by `init_sqlite_state_db_with_fresh_start_on_corruption` after successful reinitialization so startup can surface a single warning notification to clients.

*Call graph*: called by 1 (init_sqlite_state_db_with_fresh_start_on_corruption); 2 external calls (is_empty, iter).


##### `emit_state_db_backup_warning`  (lines 1296–1304)

```
fn emit_state_db_backup_warning(message: &str)
```

**Purpose**: Emits SQLite recovery warnings through tracing, and falls back to raw stderr when tracing has not yet been initialized.

**Data flow**: Accepts a warning message string slice → logs it with `warn!` → checks `tracing::dispatcher::has_been_set()` and, if no subscriber exists yet, also writes the message to stderr with `eprintln!`.

**Call relations**: This helper is used exclusively by `init_sqlite_state_db_with_fresh_start_on_corruption` so recovery diagnostics are visible both before and after tracing setup.

*Call graph*: called by 1 (init_sqlite_state_db_with_fresh_start_on_corruption); 3 external calls (eprintln!, has_been_set, warn!).


##### `test_user_config_file_from_env`  (lines 1306–1316)

```
fn test_user_config_file_from_env() -> Option<std::path::PathBuf>
```

**Purpose**: Reads a debug-only environment variable that points the app server at an alternate user config file for tests or local debugging.

**Data flow**: In debug builds, reads `CODEX_APP_SERVER_TEST_USER_CONFIG_FILE` via `std::env::var_os`, filters out empty values, and converts the result into `Option<PathBuf>`; in non-debug builds it always returns `None`.

**Call relations**: Called at the start of `run_main_with_transport_options`, then fed into `loader_overrides_with_test_user_config_file` to mutate loader behavior only in debug builds.

*Call graph*: called by 1 (run_main_with_transport_options); 1 external calls (var_os).


##### `loader_overrides_with_test_user_config_file`  (lines 1318–1341)

```
fn loader_overrides_with_test_user_config_file(
    mut loader_overrides: LoaderOverrides,
    test_user_config_file: Option<std::path::PathBuf>,
) -> IoResult<LoaderOverrides>
```

**Purpose**: Applies the debug-only test user config path to `LoaderOverrides`, validating that the supplied path is absolute before installing it.

**Data flow**: Takes mutable `LoaderOverrides` plus an optional `PathBuf` → in debug builds, if a path is present, converts it with `AbsolutePathBuf::from_absolute_path`, returning `InvalidInput` on failure; logs the chosen path and writes it into `loader_overrides.user_config_path`; in non-debug builds it ignores the extra argument → returns the possibly modified `LoaderOverrides`.

**Call relations**: Used by `run_main_with_transport_options` before any config loading occurs, and directly exercised by the debug-only unit test to verify override behavior.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (run_main_with_transport_options, debug_test_user_config_file_overrides_loader_path); 1 external calls (warn!).


##### `analytics_rpc_transport`  (lines 1343–1350)

```
fn analytics_rpc_transport(transport: &AppServerTransport) -> AppServerRpcTransport
```

**Purpose**: Maps the server’s transport mode into the analytics enum used for RPC transport attribution.

**Data flow**: Matches `&AppServerTransport` → returns `AppServerRpcTransport::Stdio` for stdio and `AppServerRpcTransport::Websocket` for Unix socket, websocket, or transport-off modes.

**Call relations**: Called during `MessageProcessor` construction inside `run_main_with_transport_options` so analytics events can record the effective RPC transport category.

*Call graph*: called by 1 (run_main_with_transport_options).


##### `tests::log_format_from_env_value_matches_json_values_case_insensitively`  (lines 1364–1368)

```
fn log_format_from_env_value_matches_json_values_case_insensitively()
```

**Purpose**: Verifies that `LogFormat::from_env_value` recognizes `json` regardless of case or surrounding whitespace.

**Data flow**: Supplies several string variants to `LogFormat::from_env_value` and asserts each result equals `LogFormat::Json`.

**Call relations**: This unit test protects the parsing behavior relied on by `log_format_from_env` during startup logging initialization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::log_format_from_env_value_defaults_for_non_json_values`  (lines 1371–1379)

```
fn log_format_from_env_value_defaults_for_non_json_values()
```

**Purpose**: Verifies that absent, empty, or non-`json` values all select the default log formatter.

**Data flow**: Calls `LogFormat::from_env_value` with `None`, empty string, and unrelated strings, then asserts each result is `LogFormat::Default`.

**Call relations**: This test complements the positive parsing test and documents the intentionally narrow acceptance criteria for JSON logging.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::debug_test_user_config_file_overrides_loader_path`  (lines 1383–1395)

```
fn debug_test_user_config_file_overrides_loader_path()
```

**Purpose**: Checks that the debug-only helper installs an absolute test config path into `LoaderOverrides.user_config_path`.

**Data flow**: Builds a temporary absolute path, passes it with `LoaderOverrides::default()` into `loader_overrides_with_test_user_config_file`, unwraps the result, and asserts the stored path equals `AbsolutePathBuf::from_absolute_path(path)`.

**Call relations**: This test directly exercises `loader_overrides_with_test_user_config_file`, validating the debug-only startup override path used by `run_main_with_transport_options`.

*Call graph*: calls 1 internal fn (loader_overrides_with_test_user_config_file); 3 external calls (assert_eq!, default, temp_dir).


### `app-server/src/outgoing_message.rs`

`io_transport` · `request handling and async callbacks`

This file defines the transport-facing envelope types and the mutable machinery behind outbound communication. `ConnectionRequestId` uniquely identifies an incoming client request by `(ConnectionId, RequestId)`. `RequestContext` stores the tracing `Span` and optional parent `W3cTraceContext` for an in-flight incoming request until its final response or error is sent; this lets later response writes inherit the request span and expose trace context to downstream work. `OutgoingEnvelope` distinguishes targeted writes from broadcasts and optionally carries a oneshot used to signal write completion.

`OutgoingMessageSender` owns four key pieces of state: an atomic counter for server-initiated request IDs, the mpsc sender to the transport layer, a mutex-protected map from outbound server request IDs to pending callbacks plus original request metadata, and a mutex-protected map from unresolved incoming requests to `RequestContext`. It also emits analytics for requests, responses, notifications, aborts, and permission-approval outcomes. The API covers registering/clearing request contexts, sending server requests to all or selected connections, replaying pending thread-scoped requests to reconnecting clients, resolving or aborting pending callbacks, and sending final responses/errors for incoming requests. Response/error sending removes the stored request context exactly once and instruments the actual channel send with the original request span when available.

`ThreadScopedOutgoingMessageSender` is a convenience wrapper that binds an `OutgoingMessageSender` to a thread ID and a fixed connection set, adding thread-aware cancellation and analytics helpers. The test module validates JSON serialization, targeted routing, request-context cleanup, write-completion waiting, callback forwarding, and thread-scoped pending-request ordering/cancellation.

#### Function details

##### `RequestContext::new`  (lines 58–68)

```
fn new(
        request_id: ConnectionRequestId,
        span: Span,
        parent_trace: Option<W3cTraceContext>,
    ) -> Self
```

**Purpose**: Creates the tracing metadata record for one incoming client request. The record is later stored until the request’s final response or error is emitted.

**Data flow**: Takes a `ConnectionRequestId`, a `tracing::Span`, and an optional parent `W3cTraceContext`, stores them unchanged in a new `RequestContext`, and returns it.

**Call relations**: Constructed by request-processing code when an incoming request begins, then registered in `OutgoingMessageSender` so later response/error sends can recover tracing context.

*Call graph*: called by 4 (process_client_request, process_request, connection_closed_clears_registered_request_contexts, send_response_clears_registered_request_context).


##### `RequestContext::request_trace`  (lines 70–72)

```
fn request_trace(&self) -> Option<W3cTraceContext>
```

**Purpose**: Extracts the effective W3C trace context for the request, preferring the local span’s current context and falling back to the original remote parent trace if needed.

**Data flow**: Reads `self.span`, asks `span_w3c_trace_context` for a serialized trace context, and if that returns `None`, clones and returns `self.parent_trace` instead.

**Call relations**: Used by downstream request handlers that need to propagate the request trace into spawned work or child operations.

*Call graph*: called by 1 (thread_start_inner); 1 external calls (span_w3c_trace_context).


##### `RequestContext::span`  (lines 74–76)

```
fn span(&self) -> Span
```

**Purpose**: Returns a clone of the stored tracing span so callers can instrument async work with the request context.

**Data flow**: Reads `self.span`, clones it, and returns the cloned `Span`.

**Call relations**: Called by request-dispatch code and by outbound send logic when instrumenting response/error writes.

*Call graph*: called by 3 (dispatch_initialized_client_request, run_request_with_context, thread_start_inner); 1 external calls (clone).


##### `RequestContext::record_turn_id`  (lines 78–80)

```
fn record_turn_id(&self, turn_id: &str)
```

**Purpose**: Annotates the request span with the logical turn ID once that ID becomes known. This enriches tracing after request start.

**Data flow**: Takes a `&str` turn ID and records it into the stored span under the field name `turn.id`; it returns unit and mutates only tracing metadata.

**Call relations**: Reached indirectly through `OutgoingMessageSender::record_request_turn_id` when turn creation code wants the request span to carry the resulting turn identifier.

*Call graph*: 1 external calls (record).


##### `ThreadScopedOutgoingMessageSender::new`  (lines 121–131)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        connection_ids: Vec<ConnectionId>,
        thread_id: ThreadId,
    ) -> Self
```

**Purpose**: Builds a thread-bound outbound sender wrapper that targets a fixed set of connections and remembers the owning thread ID.

**Data flow**: Consumes an `Arc<OutgoingMessageSender>`, a `Vec<ConnectionId>`, and a `ThreadId`; wraps the connection IDs in an `Arc<Vec<_>>`, stores all three fields, and returns the wrapper.

**Call relations**: Created by thread-oriented subsystems so they can emit notifications, requests, and responses without repeatedly passing thread and connection routing information.

*Call graph*: called by 18 (command_execution_started_helper_emits_once, complete_command_execution_item_emits_declined_once_for_pending_command, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, test_handle_token_count_event_emits_usage_and_rate_limits, test_handle_token_count_event_without_usage_info, test_handle_turn_complete_emits_completed_without_error, test_handle_turn_complete_emits_error_multiple_turns, test_handle_turn_complete_emits_failed_with_error, test_handle_turn_diff_emits_v2_notification (+8 more)); 1 external calls (new).


##### `ThreadScopedOutgoingMessageSender::send_request`  (lines 133–144)

```
async fn send_request(
        &self,
        payload: ServerRequestPayload,
    ) -> (RequestId, oneshot::Receiver<ClientRequestResult>)
```

**Purpose**: Sends a server-initiated request only to this thread’s subscribed connections and tags the pending callback entry with the thread ID.

**Data flow**: Takes a `ServerRequestPayload`, forwards it to `OutgoingMessageSender::send_request_to_connections` with `Some(self.connection_ids.as_slice())` and `Some(self.thread_id)`, and returns the generated `RequestId` plus oneshot receiver for the eventual client result.

**Call relations**: Used by thread event handling when the server needs a client decision or input tied to a specific thread.

*Call graph*: called by 1 (apply_bespoke_event_handling).


##### `ThreadScopedOutgoingMessageSender::track_effective_permissions_approval_response`  (lines 146–158)

```
fn track_effective_permissions_approval_response(
        &self,
        request_id: RequestId,
        response: RequestPermissionsResponse,
    )
```

**Purpose**: Records analytics for a permissions approval response associated with this thread-scoped sender. It does not send any transport message.

**Data flow**: Accepts a `RequestId` and `RequestPermissionsResponse`, computes the current Unix timestamp in milliseconds via `now_unix_timestamp_ms`, and forwards the event to `analytics_events_client.track_effective_permissions_approval_response`.

**Call relations**: Called by higher-level approval handling after a client response has been interpreted.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms).


##### `ThreadScopedOutgoingMessageSender::send_server_notification`  (lines 160–170)

```
async fn send_server_notification(&self, notification: ServerNotification)
```

**Purpose**: Emits a server notification to this thread’s connection set and records notification analytics. If no connections are attached, it becomes a no-op.

**Data flow**: Takes a `ServerNotification`, clones it for analytics tracking, returns early if `connection_ids` is empty, otherwise delegates to `OutgoingMessageSender::send_server_notification_to_connections` with the stored connection slice.

**Call relations**: Used broadly by thread lifecycle and event translation code to push thread-specific notifications to subscribed clients.

*Call graph*: called by 10 (apply_bespoke_event_handling, complete_command_execution_item, emit_turn_completed_with_status, handle_error_notification, handle_token_count_event, handle_turn_diff, handle_turn_plan_update, maybe_emit_hook_prompt_item_completed, maybe_emit_raw_response_item_completed, start_command_execution_item); 1 external calls (clone).


##### `ThreadScopedOutgoingMessageSender::send_global_server_notification`  (lines 172–174)

```
async fn send_global_server_notification(&self, notification: ServerNotification)
```

**Purpose**: Broadcasts a notification globally rather than restricting it to the thread’s connection set.

**Data flow**: Accepts a `ServerNotification`, forwards it unchanged to `OutgoingMessageSender::send_server_notification`, and returns unit.

**Call relations**: Used in the smaller set of thread flows where an event should reach all clients, not just listeners for the current thread.

*Call graph*: called by 1 (apply_bespoke_event_handling).


##### `ThreadScopedOutgoingMessageSender::abort_pending_server_requests`  (lines 176–191)

```
async fn abort_pending_server_requests(&self)
```

**Purpose**: Cancels all pending server-initiated requests associated with this thread and optionally resolves their waiters with a structured internal error explaining the turn transition.

**Data flow**: Builds a `JSONRPCErrorError` via `internal_error`, attaches JSON `data` containing `reason: TURN_TRANSITION_PENDING_REQUEST_ERROR_REASON`, and passes that error to `OutgoingMessageSender::cancel_requests_for_thread(self.thread_id, Some(error))`.

**Call relations**: Invoked when thread state changes invalidate outstanding client prompts or approvals.

*Call graph*: calls 1 internal fn (internal_error); called by 1 (apply_bespoke_event_handling); 1 external calls (json!).


##### `ThreadScopedOutgoingMessageSender::send_response`  (lines 193–198)

```
async fn send_response(&self, request_id: ConnectionRequestId, response: T)
```

**Purpose**: Forwards a typed response for an incoming client request through the shared outgoing sender while preserving thread-scoped convenience.

**Data flow**: Takes a `ConnectionRequestId` and any `T: Into<ClientResponsePayload>`, delegates to `OutgoingMessageSender::send_response`, and returns unit.

**Call relations**: Used by thread-specific request handlers that need to answer a client request from within thread-oriented code.

*Call graph*: called by 2 (apply_bespoke_event_handling, respond_to_pending_interrupts).


##### `ThreadScopedOutgoingMessageSender::send_error`  (lines 200–206)

```
async fn send_error(
        &self,
        request_id: ConnectionRequestId,
        error: impl Into<JSONRPCErrorError>,
    )
```

**Purpose**: Forwards an error response for an incoming client request through the shared outgoing sender.

**Data flow**: Takes a `ConnectionRequestId` and any error convertible into `JSONRPCErrorError`, delegates to `OutgoingMessageSender::send_error`, and returns unit.

**Call relations**: Used by thread-specific handlers when a request fails after thread-scoped processing has begun.

*Call graph*: called by 2 (apply_bespoke_event_handling, handle_thread_rollback_failed).


##### `OutgoingMessageSender::new`  (lines 210–221)

```
fn new(
        sender: mpsc::Sender<OutgoingEnvelope>,
        analytics_events_client: AnalyticsEventsClient,
    ) -> Self
```

**Purpose**: Initializes the outbound transport state holder with empty callback/context maps and a fresh server-request ID counter.

**Data flow**: Consumes an mpsc `Sender<OutgoingEnvelope>` and an `AnalyticsEventsClient`, creates `AtomicI64(0)`, empty `HashMap`s wrapped in `Mutex`, stores all fields, and returns the sender object.

**Call relations**: Constructed during app-server startup and in tests; other components keep it in an `Arc` and use it as the single outbound coordination point.

*Call graph*: called by 38 (command_execution_started_helper_emits_once, complete_command_execution_item_emits_declined_once_for_pending_command, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, test_handle_token_count_event_emits_usage_and_rate_limits, test_handle_token_count_event_without_usage_info, test_handle_turn_complete_emits_completed_without_error, test_handle_turn_complete_emits_error_multiple_turns, test_handle_turn_complete_emits_failed_with_error, test_handle_turn_diff_emits_v2_notification (+15 more)); 3 external calls (new, new, new).


##### `OutgoingMessageSender::register_request_context`  (lines 223–231)

```
async fn register_request_context(&self, request_context: RequestContext)
```

**Purpose**: Stores tracing context for an incoming request until its final response or error is sent. It warns if an unresolved context for the same `(connection, request)` is replaced.

**Data flow**: Locks `request_contexts`, inserts the provided `RequestContext` keyed by its `ConnectionRequestId`, logs a warning if an old entry existed, and returns unit.

**Call relations**: Called near request start by inbound processing code before asynchronous work begins.

*Call graph*: 1 external calls (warn!).


##### `OutgoingMessageSender::connection_closed`  (lines 233–236)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Drops all unresolved request contexts associated with a disconnected transport connection. This prevents stale tracing state from accumulating after disconnects.

**Data flow**: Locks `request_contexts` and retains only entries whose `connection_id` differs from the closed connection.

**Call relations**: Invoked by connection lifecycle handling when a client disconnects.


##### `OutgoingMessageSender::request_trace_context`  (lines 238–246)

```
async fn request_trace_context(
        &self,
        request_id: &ConnectionRequestId,
    ) -> Option<W3cTraceContext>
```

**Purpose**: Looks up the effective trace context for a still-open incoming request. It is a read-only accessor into the stored request-context map.

**Data flow**: Locks `request_contexts`, finds the `RequestContext` for the supplied `ConnectionRequestId`, calls `RequestContext::request_trace`, and returns the resulting optional `W3cTraceContext`.

**Call relations**: Used by request-processing flows that need to propagate the original request trace into later spawned operations.


##### `OutgoingMessageSender::record_request_turn_id`  (lines 248–257)

```
async fn record_request_turn_id(
        &self,
        request_id: &ConnectionRequestId,
        turn_id: &str,
    )
```

**Purpose**: Adds a `turn.id` attribute to the tracing span for an unresolved incoming request if that request context is still present.

**Data flow**: Locks `request_contexts`, looks up the entry by `ConnectionRequestId`, and if found calls `request_context.record_turn_id(turn_id)`; otherwise it does nothing.

**Call relations**: Called after turn creation so the request span can be enriched before the final response is sent.


##### `OutgoingMessageSender::take_request_context`  (lines 259–265)

```
async fn take_request_context(
        &self,
        request_id: &ConnectionRequestId,
    ) -> Option<RequestContext>
```

**Purpose**: Removes and returns the stored tracing context for an incoming request. This enforces one-time consumption when sending the final response or error.

**Data flow**: Locks `request_contexts`, removes the entry for the given `ConnectionRequestId`, and returns `Option<RequestContext>`.

**Call relations**: Used internally by `send_response_as` and `send_error` so request contexts are cleared exactly when the request is resolved.

*Call graph*: called by 2 (send_error, send_response_as).


##### `OutgoingMessageSender::request_context_count`  (lines 268–270)

```
async fn request_context_count(&self) -> usize
```

**Purpose**: Returns the number of unresolved request contexts currently stored. It exists only for tests.

**Data flow**: Locks `request_contexts`, reads its length, and returns that `usize`.

**Call relations**: Used by tests to verify that sending a response or closing a connection clears stored request contexts.


##### `OutgoingMessageSender::send_request`  (lines 272–280)

```
async fn send_request(
        &self,
        request: ServerRequestPayload,
    ) -> (RequestId, oneshot::Receiver<ClientRequestResult>)
```

**Purpose**: Broadcasts a server-initiated request without thread affinity or connection filtering. It is the simplest entrypoint for outbound server requests.

**Data flow**: Accepts a `ServerRequestPayload`, delegates to `send_request_to_connections(None, request, None)`, and returns the generated request ID plus callback receiver.

**Call relations**: Used by code that wants a client response but does not need thread-scoped routing.

*Call graph*: calls 1 internal fn (send_request_to_connections).


##### `OutgoingMessageSender::next_request_id`  (lines 282–284)

```
fn next_request_id(&self) -> RequestId
```

**Purpose**: Allocates the next monotonically increasing integer request ID for a server-initiated request.

**Data flow**: Atomically increments `next_server_request_id` with relaxed ordering, wraps the previous value in `RequestId::Integer`, and returns it.

**Call relations**: Called only by `send_request_to_connections` before constructing the outbound `ServerRequest`.

*Call graph*: called by 1 (send_request_to_connections); 2 external calls (fetch_add, Integer).


##### `OutgoingMessageSender::send_request_to_connections`  (lines 286–350)

```
async fn send_request_to_connections(
        &self,
        connection_ids: Option<&[ConnectionId]>,
        request: ServerRequestPayload,
        thread_id: Option<ThreadId>,
    ) -> (RequestId, o
```

**Purpose**: Creates a server request, registers its callback waiter, sends it either as a broadcast or to selected connections, and tracks analytics for targeted sends. It also cleans up callback state if transport send fails.

**Data flow**: Takes optional connection IDs, a `ServerRequestPayload`, and optional `ThreadId`; allocates a new request ID, materializes a typed `ServerRequest` with that ID, creates a oneshot channel, stores `PendingCallbackEntry { callback, thread_id, request }` in `request_id_to_callback`, sends either a `Broadcast` envelope or one `ToConnection` envelope per target connection, tracks `track_server_request` for successful targeted sends, removes the callback entry on send failure, and returns the request ID plus receiver.

**Call relations**: This is the core implementation behind both generic and thread-scoped outbound server requests.

*Call graph*: calls 2 internal fn (track_server_request, next_request_id); called by 1 (send_request); 6 external calls (send, clone, request_with_id, Request, channel, warn!).


##### `OutgoingMessageSender::replay_requests_to_connection_for_thread`  (lines 352–371)

```
async fn replay_requests_to_connection_for_thread(
        &self,
        connection_id: ConnectionId,
        thread_id: ThreadId,
    )
```

**Purpose**: Re-sends all still-pending server requests for a thread to a newly interested connection. This supports reconnect or late subscription scenarios.

**Data flow**: Fetches sorted pending requests via `pending_requests_for_thread(thread_id)`, then iterates and sends each as `OutgoingEnvelope::ToConnection { connection_id, message: OutgoingMessage::Request(request), write_complete_tx: None }`, logging warnings on send failure.

**Call relations**: Called by thread subscription/reconnection logic after a connection starts listening to a thread.

*Call graph*: calls 1 internal fn (pending_requests_for_thread); 3 external calls (send, Request, warn!).


##### `OutgoingMessageSender::notify_client_response`  (lines 373–393)

```
async fn notify_client_response(&self, id: RequestId, result: Result)
```

**Purpose**: Resolves a pending server-request callback with a successful client result and emits analytics for the typed server response when appropriate.

**Data flow**: Removes the pending callback entry by request ID using `take_request_callback`; if found, computes completion time, attempts to decode the original request plus raw result into a typed `ServerResponse`, tracks `track_server_response` unless it is a permissions approval response, then sends `Ok(result)` through the stored oneshot callback; if no entry exists or callback send fails, it logs a warning.

**Call relations**: Invoked by inbound transport/request handling when the client answers a server-initiated request.

*Call graph*: calls 3 internal fn (track_server_response, take_request_callback, now_unix_timestamp_ms); 2 external calls (matches!, warn!).


##### `OutgoingMessageSender::notify_client_error`  (lines 395–411)

```
async fn notify_client_error(&self, id: RequestId, error: JSONRPCErrorError)
```

**Purpose**: Resolves a pending server-request callback with a client-side JSON-RPC error and records the request as aborted in analytics.

**Data flow**: Removes the callback entry via `take_request_callback`; if found, logs the client error, tracks `track_server_request_aborted` with the current timestamp and request ID, and sends `Err(error)` through the oneshot callback; otherwise it warns that no callback was found.

**Call relations**: Called when the client responds to a server-initiated request with an error object instead of a result.

*Call graph*: calls 3 internal fn (track_server_request_aborted, take_request_callback, now_unix_timestamp_ms); 2 external calls (clone, warn!).


##### `OutgoingMessageSender::cancel_request`  (lines 413–422)

```
async fn cancel_request(&self, id: &RequestId) -> bool
```

**Purpose**: Cancels one pending server-initiated request by ID and marks it aborted in analytics. It does not notify the waiter unless higher-level code separately handles that.

**Data flow**: Removes the callback entry with `take_request_callback`; if present, tracks `track_server_request_aborted` and returns `true`, otherwise returns `false`.

**Call relations**: Used by cancellation paths that only need to drop pending callback state for a single request.

*Call graph*: calls 3 internal fn (track_server_request_aborted, take_request_callback, now_unix_timestamp_ms).


##### `OutgoingMessageSender::cancel_all_requests`  (lines 424–443)

```
async fn cancel_all_requests(&self, error: Option<JSONRPCErrorError>)
```

**Purpose**: Cancels every pending server-initiated request, records each as aborted, and optionally resolves all waiters with the same error.

**Data flow**: Drains the entire `request_id_to_callback` map under lock into a vector, then for each entry tracks `track_server_request_aborted`; if an error was supplied, clones and sends it through the callback, logging warnings if the receiver is gone.

**Call relations**: Used during broad teardown or reset situations where no pending server request should survive.

*Call graph*: calls 2 internal fn (track_server_request_aborted, now_unix_timestamp_ms); 1 external calls (warn!).


##### `OutgoingMessageSender::take_request_callback`  (lines 445–451)

```
async fn take_request_callback(
        &self,
        id: &RequestId,
    ) -> Option<(RequestId, PendingCallbackEntry)>
```

**Purpose**: Removes and returns the pending callback entry for a server-initiated request. It is the internal primitive behind response, error, and cancellation handling.

**Data flow**: Locks `request_id_to_callback`, removes the map entry for the given `RequestId`, and returns the `(RequestId, PendingCallbackEntry)` pair if present.

**Call relations**: Called by `notify_client_response`, `notify_client_error`, and `cancel_request`.

*Call graph*: called by 3 (cancel_request, notify_client_error, notify_client_response).


##### `OutgoingMessageSender::pending_requests_for_thread`  (lines 453–466)

```
async fn pending_requests_for_thread(
        &self,
        thread_id: ThreadId,
    ) -> Vec<ServerRequest>
```

**Purpose**: Returns all currently pending server requests associated with a given thread, sorted by request ID. This preserves a stable replay order.

**Data flow**: Locks `request_id_to_callback`, filters entries whose `thread_id == Some(thread_id)`, clones their stored `ServerRequest`s into a vector, sorts that vector by `request.id()`, and returns it.

**Call relations**: Used by `replay_requests_to_connection_for_thread` and by tests that verify thread-scoped request tracking.

*Call graph*: called by 1 (replay_requests_to_connection_for_thread).


##### `OutgoingMessageSender::cancel_requests_for_thread`  (lines 468–501)

```
async fn cancel_requests_for_thread(
        &self,
        thread_id: ThreadId,
        error: Option<JSONRPCErrorError>,
    )
```

**Purpose**: Cancels all pending server requests associated with one thread, records analytics, and optionally resolves each waiter with a supplied error.

**Data flow**: Locks `request_id_to_callback`, collects matching request IDs, removes their entries into a vector, then for each entry tracks `track_server_request_aborted`; if an error is provided, clones and sends it through the callback, warning on send failure.

**Call relations**: Called by `ThreadScopedOutgoingMessageSender::abort_pending_server_requests` and other thread-transition cleanup paths.

*Call graph*: calls 2 internal fn (track_server_request_aborted, now_unix_timestamp_ms); 2 external calls (with_capacity, warn!).


##### `OutgoingMessageSender::send_response`  (lines 503–508)

```
async fn send_response(&self, request_id: ConnectionRequestId, response: T)
```

**Purpose**: Sends a typed successful response for an incoming client request by first converting it into `ClientResponsePayload`.

**Data flow**: Accepts a `ConnectionRequestId` and any `T: Into<ClientResponsePayload>`, converts the value with `into()`, delegates to `send_response_as`, and returns unit.

**Call relations**: Used by request handlers and by `send_result` on success.

*Call graph*: calls 1 internal fn (send_response_as); called by 1 (send_result); 1 external calls (into).


##### `OutgoingMessageSender::send_response_as`  (lines 510–551)

```
async fn send_response_as(
        &self,
        request_id: ConnectionRequestId,
        response: ClientResponsePayload,
    )
```

**Purpose**: Serializes a protocol response payload into JSON-RPC result parts, tracks analytics, clears the stored request context, and sends the final response or a serialization error.

**Data flow**: Takes a `ConnectionRequestId` and `ClientResponsePayload`, remembers connection/request IDs for analytics, calls `into_jsonrpc_parts_and_payload`; on success it optionally tracks the typed response payload, removes the request context with `take_request_context`, wraps the JSON result in `OutgoingMessage::Response`, and sends it via `send_outgoing_message_to_connection`; on serialization failure it removes the request context and sends an internal error through `send_error_inner`.

**Call relations**: This is the concrete implementation behind `send_response`; it is also where request-context cleanup happens for successful request completion.

*Call graph*: calls 4 internal fn (internal_error, send_error_inner, send_outgoing_message_to_connection, take_request_context); called by 1 (send_response); 3 external calls (into_jsonrpc_parts_and_payload, Response, format!).


##### `OutgoingMessageSender::send_server_notification`  (lines 553–556)

```
async fn send_server_notification(&self, notification: ServerNotification)
```

**Purpose**: Broadcasts a server notification to all connections. It is a convenience wrapper over the targeted notification API.

**Data flow**: Accepts a `ServerNotification`, delegates to `send_server_notification_to_connections(&[], notification)`, and returns unit.

**Call relations**: Used by many subsystems for global notifications such as account updates or import progress.

*Call graph*: calls 1 internal fn (send_server_notification_to_connections); called by 3 (send_chatgpt_login_completion_notifications, send_completed_import_notification, send_import_progress).


##### `OutgoingMessageSender::send_server_notification_to_connections`  (lines 558–593)

```
async fn send_server_notification_to_connections(
        &self,
        connection_ids: &[ConnectionId],
        notification: ServerNotification,
    )
```

**Purpose**: Sends a notification either as a broadcast or individually to a provided connection list. It logs trace-level metadata and warns on transport failures.

**Data flow**: Takes a connection slice and `ServerNotification`, logs the targeted connection count, wraps the notification in `OutgoingMessage::AppServerNotification`, sends a single `Broadcast` envelope if the slice is empty, otherwise iterates over connection IDs sending one `ToConnection` envelope per target, warning on any send error.

**Call relations**: Called by the global wrapper and by thread-scoped notification helpers.

*Call graph*: called by 1 (send_server_notification); 6 external calls (send, clone, is_empty, AppServerNotification, trace!, warn!).


##### `OutgoingMessageSender::send_server_notification_to_connection_and_wait`  (lines 595–615)

```
async fn send_server_notification_to_connection_and_wait(
        &self,
        connection_id: ConnectionId,
        notification: ServerNotification,
    )
```

**Purpose**: Sends one targeted notification and waits until the transport layer signals that the write completed. This is used when ordering depends on actual flush completion.

**Data flow**: Creates a oneshot pair, sends `OutgoingEnvelope::ToConnection` with `write_complete_tx: Some(write_complete_tx)`, warns on send failure, then awaits the receiver and ignores whether the completion signal arrives successfully.

**Call relations**: Used by code paths that need stronger delivery sequencing than fire-and-forget notifications.

*Call graph*: 6 external calls (send, clone, AppServerNotification, channel, trace!, warn!).


##### `OutgoingMessageSender::send_error`  (lines 617–625)

```
async fn send_error(
        &self,
        request_id: ConnectionRequestId,
        error: impl Into<JSONRPCErrorError>,
    )
```

**Purpose**: Sends a final JSON-RPC error for an incoming client request and clears any stored request tracing context.

**Data flow**: Takes a `ConnectionRequestId` and error convertible into `JSONRPCErrorError`, removes the request context with `take_request_context`, converts the error, and delegates to `send_error_inner`.

**Call relations**: Used by request handlers and by `send_result` on failure.

*Call graph*: calls 2 internal fn (send_error_inner, take_request_context); called by 1 (send_result); 1 external calls (into).


##### `OutgoingMessageSender::send_result`  (lines 627–641)

```
async fn send_result(
        &self,
        request_id: ConnectionRequestId,
        result: std::result::Result<T, E>,
    )
```

**Purpose**: Convenience helper that routes a `Result<T, E>` to either `send_response` or `send_error` for an incoming client request.

**Data flow**: Consumes a `ConnectionRequestId` and `std::result::Result<T, E>`; on `Ok(response)` it forwards to `send_response`, on `Err(error)` it forwards to `send_error`, and returns unit.

**Call relations**: Used widely by request processors to finish a request without manually branching on success versus error.

*Call graph*: calls 2 internal fn (send_error, send_response).


##### `OutgoingMessageSender::send_error_inner`  (lines 643–660)

```
async fn send_error_inner(
        &self,
        request_context: Option<RequestContext>,
        request_id: ConnectionRequestId,
        error: JSONRPCErrorError,
    )
```

**Purpose**: Builds the transport-level `OutgoingMessage::Error` wrapper and sends it to the target connection, optionally under the original request span.

**Data flow**: Accepts an optional `RequestContext`, a `ConnectionRequestId`, and a concrete `JSONRPCErrorError`, wraps them into `OutgoingError { id, error }` and `OutgoingMessage::Error`, then delegates to `send_outgoing_message_to_connection` with message kind `"error"`.

**Call relations**: Internal implementation used by both `send_error` and the serialization-failure branch of `send_response_as`.

*Call graph*: calls 1 internal fn (send_outgoing_message_to_connection); called by 2 (send_error, send_response_as); 1 external calls (Error).


##### `OutgoingMessageSender::send_outgoing_message_to_connection`  (lines 662–683)

```
async fn send_outgoing_message_to_connection(
        &self,
        request_context: Option<RequestContext>,
        connection_id: ConnectionId,
        message: OutgoingMessage,
        message_kin
```

**Purpose**: Performs the actual channel send for a targeted response or error, instrumenting the send future with the request span when available. It is the final transport hop inside this module.

**Data flow**: Builds a `ToConnection` envelope with `write_complete_tx: None`, sends it on the mpsc sender, and if a `RequestContext` was supplied wraps the send future with `Instrument::instrument(request_context.span())`; it logs a warning if the channel send fails.

**Call relations**: Called only by `send_response_as` and `send_error_inner`, centralizing traced targeted sends.

*Call graph*: called by 2 (send_error_inner, send_response_as); 2 external calls (send, warn!).


##### `now_unix_timestamp_ms`  (lines 686–693)

```
fn now_unix_timestamp_ms() -> u64
```

**Purpose**: Returns the current wall-clock Unix timestamp in milliseconds as a `u64`, defaulting safely on conversion failures.

**Data flow**: Reads `SystemTime::now()`, computes duration since `UNIX_EPOCH`, falls back to zero duration on clock errors, converts milliseconds to `u64` with `try_into`, and returns zero on overflow.

**Call relations**: Used by analytics-related methods whenever they need a completion or abort timestamp.

*Call graph*: called by 6 (cancel_all_requests, cancel_request, cancel_requests_for_thread, notify_client_error, notify_client_response, track_effective_permissions_approval_response); 1 external calls (now).


##### `tests::verify_server_notification_serialization`  (lines 729–751)

```
fn verify_server_notification_serialization()
```

**Purpose**: Checks that wrapping an account-login-completed notification in `OutgoingMessage::AppServerNotification` serializes to the expected JSON-RPC notification shape.

**Data flow**: Constructs a `ServerNotification::AccountLoginCompleted`, serializes it with serde, and asserts exact equality with a JSON literal containing `method` and `params`.

**Call relations**: Standalone serialization regression test for notification method naming and payload shape.

*Call graph*: 4 external calls (AccountLoginCompleted, nil, AppServerNotification, assert_eq!).


##### `tests::verify_account_login_completed_notification_serialization`  (lines 754–776)

```
fn verify_account_login_completed_notification_serialization()
```

**Purpose**: Duplicates the account-login-completed serialization assertion as a focused regression test for that notification type.

**Data flow**: Builds the notification, serializes the wrapped outgoing message, and compares it to the expected JSON object.

**Call relations**: Another direct serialization test in the module’s test suite.

*Call graph*: 4 external calls (AccountLoginCompleted, nil, AppServerNotification, assert_eq!).


##### `tests::verify_account_rate_limits_notification_serialization`  (lines 779–823)

```
fn verify_account_rate_limits_notification_serialization()
```

**Purpose**: Verifies JSON serialization for account rate-limit update notifications, including nested rate-limit snapshot fields and enum formatting.

**Data flow**: Constructs `ServerNotification::AccountRateLimitsUpdated` with nested `RateLimitSnapshot` data, serializes it, and asserts equality with the expected JSON structure.

**Call relations**: Regression test for protocol serialization of a more complex notification payload.

*Call graph*: 3 external calls (AccountRateLimitsUpdated, AppServerNotification, assert_eq!).


##### `tests::verify_account_updated_notification_serialization`  (lines 826–845)

```
fn verify_account_updated_notification_serialization()
```

**Purpose**: Verifies serialization of `account/updated` notifications and enum casing for `AuthMode`.

**Data flow**: Creates `ServerNotification::AccountUpdated`, serializes the wrapped outgoing message, and compares it to the expected JSON.

**Call relations**: Part of the notification serialization test set.

*Call graph*: 3 external calls (AccountUpdated, AppServerNotification, assert_eq!).


##### `tests::verify_config_warning_notification_serialization`  (lines 848–869)

```
fn verify_config_warning_notification_serialization()
```

**Purpose**: Checks serialization of config warning notifications, especially field naming and omission behavior.

**Data flow**: Builds `ServerNotification::ConfigWarning`, serializes it, and asserts exact JSON equality.

**Call relations**: Serialization regression coverage for config-related notifications.

*Call graph*: 3 external calls (ConfigWarning, AppServerNotification, assert_eq!).


##### `tests::verify_guardian_warning_notification_serialization`  (lines 872–891)

```
fn verify_guardian_warning_notification_serialization()
```

**Purpose**: Checks serialization of guardian warning notifications.

**Data flow**: Constructs `ServerNotification::GuardianWarning`, serializes the outgoing wrapper, and asserts the expected JSON payload.

**Call relations**: Serialization regression test.

*Call graph*: 3 external calls (GuardianWarning, AppServerNotification, assert_eq!).


##### `tests::verify_model_rerouted_notification_serialization`  (lines 894–919)

```
fn verify_model_rerouted_notification_serialization()
```

**Purpose**: Verifies serialization of model-rerouted notifications, including enum string formatting for reroute reasons.

**Data flow**: Creates `ServerNotification::ModelRerouted`, serializes it, and compares against the expected JSON object.

**Call relations**: Serialization regression test.

*Call graph*: 3 external calls (ModelRerouted, AppServerNotification, assert_eq!).


##### `tests::verify_model_verification_notification_serialization`  (lines 922–943)

```
fn verify_model_verification_notification_serialization()
```

**Purpose**: Verifies serialization of model-verification notifications with a vector of verification enums.

**Data flow**: Builds `ServerNotification::ModelVerification`, serializes it, and asserts equality with the expected JSON array payload.

**Call relations**: Serialization regression test.

*Call graph*: 4 external calls (ModelVerification, AppServerNotification, assert_eq!, vec!).


##### `tests::verify_turn_moderation_metadata_notification_serialization`  (lines 946–968)

```
fn verify_turn_moderation_metadata_notification_serialization()
```

**Purpose**: Verifies serialization of turn moderation metadata notifications carrying arbitrary JSON metadata.

**Data flow**: Constructs `ServerNotification::TurnModerationMetadata` with a JSON metadata object, serializes it, and asserts exact JSON equality.

**Call relations**: Serialization regression test.

*Call graph*: 4 external calls (TurnModerationMetadata, AppServerNotification, assert_eq!, json!).


##### `tests::server_request_response_from_result_decodes_typed_response`  (lines 971–1010)

```
fn server_request_response_from_result_decodes_typed_response()
```

**Purpose**: Checks that a typed `ServerRequest` can decode a raw JSON result back into the correct typed `ServerResponse` variant.

**Data flow**: Builds a `ServerRequest::CommandExecutionRequestApproval`, feeds it a JSON result object, calls `response_from_result`, pattern-matches the returned `ServerResponse`, and asserts the request ID and decoded decision enum.

**Call relations**: Validates the protocol helper relied on by `notify_client_response` for analytics tracking.

*Call graph*: 4 external calls (Integer, assert_eq!, json!, panic!).


##### `tests::send_response_routes_to_target_connection`  (lines 1012–1050)

```
async fn send_response_routes_to_target_connection()
```

**Purpose**: Ensures `send_response` emits a targeted `ToConnection` envelope with the correct connection ID, request ID, and serialized result payload.

**Data flow**: Creates an `OutgoingMessageSender` with a test channel, sends a thread-archive response for a specific `ConnectionRequestId`, receives one envelope from the channel under timeout, pattern-matches it, and asserts routing and payload fields.

**Call relations**: Direct behavioral test of targeted response sending.

*Call graph*: calls 2 internal fn (disabled, new); 7 external calls (ThreadArchive, from_secs, Integer, new, assert_eq!, panic!, timeout).


##### `tests::send_response_clears_registered_request_context`  (lines 1053–1081)

```
async fn send_response_clears_registered_request_context()
```

**Purpose**: Ensures that sending a response removes the stored request context for that request.

**Data flow**: Registers a `RequestContext`, asserts the count is 1, sends a response for the same request ID, then asserts the count dropped to 0.

**Call relations**: Tests the one-time cleanup behavior implemented by `send_response_as` and `take_request_context`.

*Call graph*: calls 3 internal fn (disabled, new, new); 5 external calls (ThreadArchive, Integer, new, assert_eq!, info_span!).


##### `tests::send_error_routes_to_target_connection`  (lines 1084–1116)

```
async fn send_error_routes_to_target_connection()
```

**Purpose**: Ensures `send_error` emits a targeted error envelope with the correct request ID and error payload.

**Data flow**: Creates a sender and channel, sends an internal error for a specific `ConnectionRequestId`, receives one envelope, pattern-matches `OutgoingMessage::Error`, and asserts connection ID, request ID, and error equality.

**Call relations**: Direct behavioral test of targeted error sending.

*Call graph*: calls 3 internal fn (disabled, internal_error, new); 6 external calls (from_secs, Integer, new, assert_eq!, panic!, timeout).


##### `tests::send_server_notification_to_connection_and_wait_tracks_write_completion`  (lines 1119–1161)

```
async fn send_server_notification_to_connection_and_wait_tracks_write_completion()
```

**Purpose**: Verifies that the wait-for-write API attaches a completion sender and does not finish until the transport signals completion.

**Data flow**: Spawns a task calling `send_server_notification_to_connection_and_wait`, receives the outgoing envelope, asserts it is targeted and carries `write_complete_tx`, manually sends the completion signal, then asserts the spawned task completes within timeout.

**Call relations**: Tests the stronger sequencing semantics of the write-completion notification API.

*Call graph*: calls 2 internal fn (disabled, new); 8 external calls (from_secs, ModelRerouted, new, assert!, assert_eq!, panic!, spawn, timeout).


##### `tests::connection_closed_clears_registered_request_contexts`  (lines 1164–1196)

```
async fn connection_closed_clears_registered_request_contexts()
```

**Purpose**: Ensures disconnect cleanup removes only request contexts for the closed connection and leaves others intact.

**Data flow**: Registers two request contexts on different connection IDs, asserts count 2, calls `connection_closed` for one connection, then asserts count 1.

**Call relations**: Behavioral test for connection lifecycle cleanup.

*Call graph*: calls 3 internal fn (disabled, new, new); 4 external calls (Integer, new, assert_eq!, info_span!).


##### `tests::notify_client_error_forwards_error_to_waiter`  (lines 1199–1227)

```
async fn notify_client_error_forwards_error_to_waiter()
```

**Purpose**: Ensures a client error response resolves the pending server-request waiter with `Err(error)`.

**Data flow**: Creates a sender, issues a server request to obtain a waiter, calls `notify_client_error` with an internal error, awaits the waiter under timeout, and asserts it received the same error.

**Call relations**: Tests callback resolution for the error path of server-initiated requests.

*Call graph*: calls 4 internal fn (disabled, internal_error, new, new); 5 external calls (from_secs, new, ApplyPatchApproval, assert_eq!, timeout).


##### `tests::pending_requests_for_thread_returns_thread_requests_in_request_id_order`  (lines 1230–1290)

```
async fn pending_requests_for_thread_returns_thread_requests_in_request_id_order()
```

**Purpose**: Ensures thread-scoped pending requests are filtered by thread and returned sorted by request ID rather than insertion source type.

**Data flow**: Creates a thread-scoped sender, sends three different server request payloads for the same thread, calls `pending_requests_for_thread`, extracts their IDs, and asserts the IDs match the generated request IDs in ascending order.

**Call relations**: Tests the replay-support ordering contract of `pending_requests_for_thread`.

*Call graph*: calls 4 internal fn (disabled, new, new, new); 7 external calls (new, DynamicToolCall, FileChangeRequestApproval, ToolRequestUserInput, assert_eq!, json!, vec!).


##### `tests::cancel_requests_for_thread_cancels_all_thread_requests`  (lines 1293–1351)

```
async fn cancel_requests_for_thread_cancels_all_thread_requests()
```

**Purpose**: Ensures thread-wide cancellation resolves all pending waiters with the supplied error and leaves no pending requests behind.

**Data flow**: Creates a thread-scoped sender, sends two pending requests, calls `cancel_requests_for_thread(thread_id, Some(error))`, awaits both waiters under timeout, asserts both received the error, and finally asserts `pending_requests_for_thread` is empty.

**Call relations**: Behavioral test for thread transition cleanup of pending server requests.

*Call graph*: calls 5 internal fn (disabled, internal_error, new, new, new); 9 external calls (new, from_secs, DynamicToolCall, ToolRequestUserInput, assert!, assert_eq!, json!, timeout, vec!).


### `app-server/src/request_processors/initialize_processor.rs`

`orchestration` · `startup / connection initialization`

This processor owns the server-side logic for the `initialize` request and the follow-up notifications that should be sent once a connection is ready. Its fields combine outbound messaging, analytics, immutable config, a precomputed list of `ConfigWarningNotification`s, and the transport type used for analytics attribution.

The `initialize` method performs several distinct phases. It first rejects duplicate initialization by checking the `ConnectionSessionState`, then extracts capability flags such as `experimental_api`, `request_attestation`, and opted-out notification methods from `InitializeParams`. It validates `client_info.name` as an HTTP header value before mutating any state, because the same string may later be written into process-global originator metadata. It then commits per-connection state by calling `session.initialize(...)` with an `InitializedConnectionSessionState` containing capability flags, client name/version, and notification opt-outs.

For most clients, initialization also attempts to mutate process-global identity: `set_default_originator`, `set_default_client_residency_requirement`, and the shared `USER_AGENT_SUFFIX`. A small allowlist of daemon/backend client names is excluded from this mutation so internal clients do not overwrite user-facing identity. Regardless of whether global mutation succeeds, the processor tracks analytics, builds an `InitializeResponse` containing the computed user agent, `codex_home`, and platform family/OS, and sends it through `OutgoingMessageSender`. If the caller supplied an `AtomicBool`, the method marks outbound readiness immediately; otherwise the caller is expected to send connection-scoped initialize notifications first. Separate helpers broadcast config warnings either to one connection or globally, and another helper records analytics for subsequent initialized requests.

#### Function details

##### `InitializeRequestProcessor::new`  (lines 28–42)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        analytics_events_client: AnalyticsEventsClient,
        config: Arc<Config>,
        config_warnings: Vec<ConfigWarningNotification>,
```

**Purpose**: Constructs the initialization processor and freezes the current config-warning list behind an `Arc` for later notification fan-out.

**Data flow**: Takes an `Arc<OutgoingMessageSender>`, `AnalyticsEventsClient`, `Arc<Config>`, a `Vec<ConfigWarningNotification>`, and `AppServerRpcTransport`; stores them in the struct, wrapping the warnings vector in `Arc::new`; returns the processor.

**Call relations**: Created during server setup so connection initialization and warning notification paths can share the same outbound sender, config, and analytics client.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `InitializeRequestProcessor::initialize`  (lines 44–158)

```
async fn initialize(
        &self,
        connection_id: ConnectionId,
        request_id: RequestId,
        params: InitializeParams,
        session: &ConnectionSessionState,
        // `Some(...
```

**Purpose**: Validates and commits a connection's initialization request, updates selected global client metadata, sends the initialize response, and optionally marks outbound messaging as ready.

**Data flow**: Consumes `connection_id`, `request_id`, `InitializeParams`, a `ConnectionSessionState`, and an optional `&AtomicBool`. It reads session initialization state, capability flags from params, `client_info` name/version, config values such as `codex_home` and residency enforcement, and process-global login client metadata. It validates the client name as a header, writes per-connection state via `session.initialize(...)`, conditionally calls `set_default_originator`, always tracks analytics and sets residency requirement, optionally updates `USER_AGENT_SUFFIX`, computes `user_agent` via `get_codex_user_agent`, sends `InitializeResponse` through `outgoing`, and if `outbound_initialized` is present stores `true` with `Ordering::Release`. It returns `Ok(true)` when it marked outbound readiness itself, `Ok(false)` otherwise, or a JSON-RPC error on duplicate initialization or invalid client metadata.

**Call relations**: This is called by `handle_client_request` for the initialize RPC. It coordinates session-state mutation, analytics, global identity setup, and response sending in one place before later request dispatch can proceed.

*Call graph*: calls 6 internal fn (track_initialize, initialize, initialized, get_codex_user_agent, set_default_client_residency_requirement, set_default_originator); called by 1 (handle_client_request); 5 external calls (from_str, new, clone, format!, warn!).


##### `InitializeRequestProcessor::send_initialize_notifications_to_connection`  (lines 160–172)

```
async fn send_initialize_notifications_to_connection(
        &self,
        connection_id: ConnectionId,
    )
```

**Purpose**: Sends all queued configuration warning notifications to a single newly initialized connection.

**Data flow**: Accepts a `ConnectionId`, iterates over cloned entries from `self.config_warnings`, wraps each in `ServerNotification::ConfigWarning`, and sends them to just that connection via `send_server_notification_to_connections`.

**Call relations**: It is used by the connection-specific initialize-notification path after initialization succeeds when notifications must be scoped to one connection.

*Call graph*: called by 1 (send_initialize_notifications_to_connection); 1 external calls (ConfigWarning).


##### `InitializeRequestProcessor::send_initialize_notifications`  (lines 174–180)

```
async fn send_initialize_notifications(&self)
```

**Purpose**: Broadcasts all queued configuration warning notifications to all connected clients.

**Data flow**: Iterates over cloned `config_warnings`, wraps each as `ServerNotification::ConfigWarning`, and sends each one through the global `send_server_notification` path.

**Call relations**: This helper is used by the broader initialize-notification flow when warnings should be emitted server-wide rather than to a single connection.

*Call graph*: called by 1 (send_initialize_notifications); 1 external calls (ConfigWarning).


##### `InitializeRequestProcessor::track_initialized_request`  (lines 182–190)

```
fn track_initialized_request(
        &self,
        connection_id: ConnectionId,
        request_id: RequestId,
        request: &ClientRequest,
    )
```

**Purpose**: Records analytics for a request that arrived after a connection was successfully initialized.

**Data flow**: Takes `connection_id`, `request_id`, and a borrowed `ClientRequest`, then forwards them to `analytics_events_client.track_request(connection_id.0, request_id, request)`.

**Call relations**: It is called by `dispatch_initialized_client_request` so request analytics are only emitted for requests on initialized sessions.

*Call graph*: calls 1 internal fn (track_request); called by 1 (dispatch_initialized_client_request).


### `app-server/src/transport.rs`

`io_transport` · `outgoing message routing during request handling and notifications`

This module sits at the boundary between higher-level app-server messages and the lower-level `codex_app_server_transport` channels. It re-exports transport types used elsewhere, then adds two local state structs. `ConnectionState` represents inbound/session-side state for a connection: shared atomics for whether outbound initialization and experimental API support are enabled, a shared `RwLock<HashSet<String>>` of opted-out notification methods, and an `Arc<ConnectionSessionState>` for session metadata. `OutboundConnectionState` represents the sending side: the same shared capability/opt-out flags, an `mpsc::Sender<QueuedOutgoingMessage>` writer, and an optional `CancellationToken` used to disconnect queue-backed connections.

The routing logic has three key policies. First, `filter_outgoing_message_for_connection` strips experimental fields from `ServerRequest::CommandExecutionRequestApproval` when the connection has not enabled the experimental API; this preserves backward compatibility while still delivering the request. Second, `should_skip_notification_for_connection` drops `OutgoingMessage::AppServerNotification` values when the notification is experimental and the connection lacks capability, or when the notification method string appears in the connection’s opt-out set. Third, `send_message_to_connection` distinguishes disconnectable buffered transports from stdio-like transports: if `disconnect_sender` exists, it uses `try_send` and disconnects slow or closed connections when the queue is full/closed; otherwise it awaits `send`, allowing stdio to backpressure instead of being dropped.

`route_outgoing_envelope` applies those rules to either a targeted `OutgoingEnvelope::ToConnection` or a `Broadcast`. Broadcast first snapshots eligible initialized connections, then sends clones one by one so a slow disconnectable client can be removed without blocking delivery to others.

#### Function details

##### `ConnectionState::new`  (lines 47–59)

```
fn new(
        _origin: ConnectionOrigin,
        outbound_initialized: Arc<AtomicBool>,
        outbound_experimental_api_enabled: Arc<AtomicBool>,
        outbound_opted_out_notification_methods: A
```

**Purpose**: Constructs the per-connection state shared with message-processing code. It bundles outbound capability flags with a fresh session state object.

**Data flow**: Accepts a `ConnectionOrigin` (unused in the body), shared `Arc<AtomicBool>` flags for initialization and experimental API, a shared `Arc<RwLock<HashSet<String>>>` of opted-out methods, creates `Arc::new(ConnectionSessionState::new())`, and returns `ConnectionState` containing all four fields.

**Call relations**: Used when a new transport connection is created so inbound processing and outbound routing share the same capability/opt-out state. It delegates session initialization to `ConnectionSessionState::new`.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `OutboundConnectionState::new`  (lines 71–85)

```
fn new(
        writer: mpsc::Sender<QueuedOutgoingMessage>,
        initialized: Arc<AtomicBool>,
        experimental_api_enabled: Arc<AtomicBool>,
        opted_out_notification_methods: Arc<RwLock
```

**Purpose**: Constructs the outbound-routing state for one connection, including its writer channel and optional disconnect token. This is the object stored in the routing table.

**Data flow**: Consumes a writer `mpsc::Sender<QueuedOutgoingMessage>`, shared initialization and experimental-api atomics, shared opted-out notification set, and an optional `CancellationToken`; returns `OutboundConnectionState` with those fields stored unchanged.

**Call relations**: Created by transport startup code and extensively by transport tests. Later routing functions consult the stored flags and writer to decide filtering, sending, and disconnection behavior.

*Call graph*: called by 10 (start_uninitialized, broadcast_does_not_block_on_slow_connection, command_execution_request_approval_keeps_additional_permissions_with_capability, command_execution_request_approval_strips_additional_permissions_without_capability, experimental_notifications_are_dropped_without_capability, experimental_notifications_are_preserved_with_capability, to_connection_notification_respects_opt_out_filters, to_connection_notifications_are_dropped_for_opted_out_clients, to_connection_notifications_are_preserved_for_non_opted_out_clients, to_connection_stdio_waits_instead_of_disconnecting_when_writer_queue_is_full).


##### `OutboundConnectionState::can_disconnect`  (lines 87–89)

```
fn can_disconnect(&self) -> bool
```

**Purpose**: Reports whether this connection supports explicit disconnection via a cancellation token. It distinguishes queue-backed remote connections from stdio-like ones.

**Data flow**: Reads `self.disconnect_sender.is_some()` and returns the resulting boolean. No state is mutated.

**Call relations**: Used internally by `send_message_to_connection` to choose between non-blocking `try_send` plus disconnect-on-backpressure and awaited `send` with backpressure.


##### `OutboundConnectionState::request_disconnect`  (lines 91–95)

```
fn request_disconnect(&self)
```

**Purpose**: Triggers connection shutdown if a disconnect token is available. It is the transport-level action taken when a connection is removed or deemed too slow.

**Data flow**: Reads `self.disconnect_sender`; if `Some(token)`, calls `token.cancel()`. It returns `()` and does not alter other fields.

**Call relations**: Called by `disconnect_connection` after removing a connection from the routing map. It encapsulates the actual cancellation side effect.


##### `should_skip_notification_for_connection`  (lines 98–121)

```
fn should_skip_notification_for_connection(
    connection_state: &OutboundConnectionState,
    message: &OutgoingMessage,
) -> bool
```

**Purpose**: Determines whether an outgoing notification should be suppressed for a specific connection based on experimental capability and per-method opt-out preferences. It only applies to notification messages, not requests.

**Data flow**: Accepts `&OutboundConnectionState` and `&OutgoingMessage`. It attempts to read the `opted_out_notification_methods` lock; on lock failure it logs a warning and returns `false`. For `OutgoingMessage::AppServerNotification(notification)`, it first checks `notification.experimental_reason().is_some()` against `experimental_api_enabled.load(Ordering::Acquire)` and returns `true` if experimental notifications are disabled; otherwise it converts the notification to its method string and returns whether that string is present in the opt-out set. Non-notification messages return `false`.

**Call relations**: Called by `send_message_to_connection` before enqueueing a message. It centralizes the per-connection suppression policy so both targeted sends and broadcasts honor the same rules.

*Call graph*: called by 1 (send_message_to_connection); 1 external calls (warn!).


##### `disconnect_connection`  (lines 123–132)

```
fn disconnect_connection(
    connections: &mut HashMap<ConnectionId, OutboundConnectionState>,
    connection_id: ConnectionId,
) -> bool
```

**Purpose**: Removes a connection from the outbound routing table and requests its shutdown. It returns whether a connection was actually removed.

**Data flow**: Takes a mutable `HashMap<ConnectionId, OutboundConnectionState>` and a `ConnectionId`; if `connections.remove(&connection_id)` yields a state, it calls `request_disconnect()` on that state and returns `true`, otherwise returns `false`. It mutates the routing map.

**Call relations**: Used by `send_message_to_connection` when a target is gone, closed, or too slow. It combines map removal with the side effect of cancelling the underlying transport.

*Call graph*: called by 1 (send_message_to_connection).


##### `send_message_to_connection`  (lines 134–172)

```
async fn send_message_to_connection(
    connections: &mut HashMap<ConnectionId, OutboundConnectionState>,
    connection_id: ConnectionId,
    message: OutgoingMessage,
    write_complete_tx: Option<
```

**Purpose**: Applies per-connection filtering and then enqueues one outgoing message to one connection, disconnecting slow queue-backed connections when necessary. It is the core targeted-send primitive.

**Data flow**: Accepts the mutable connection map, a target `ConnectionId`, an `OutgoingMessage`, and an optional oneshot `write_complete_tx`. It looks up the connection, warning and returning `false` if absent. It transforms the message through `filter_outgoing_message_for_connection`, checks `should_skip_notification_for_connection` and returns `false` if the message should be dropped. It clones the writer and wraps the message plus completion sender in `QueuedOutgoingMessage`. If `can_disconnect()` is true, it uses `writer.try_send(...)`: success returns `false`; `Full` logs a warning and disconnects/removes the connection; `Closed` disconnects/removes it. If `can_disconnect()` is false, it awaits `writer.send(...)`; send failure disconnects/removes the connection, success returns `false`.

**Call relations**: Called exclusively by `route_outgoing_envelope` for both direct and broadcast delivery. It delegates message transformation, notification suppression, and connection removal to helper functions so the routing entrypoint stays simple.

*Call graph*: calls 3 internal fn (disconnect_connection, filter_outgoing_message_for_connection, should_skip_notification_for_connection); called by 1 (route_outgoing_envelope); 1 external calls (warn!).


##### `filter_outgoing_message_for_connection`  (lines 174–196)

```
fn filter_outgoing_message_for_connection(
    connection_state: &OutboundConnectionState,
    message: OutgoingMessage,
) -> OutgoingMessage
```

**Purpose**: Rewrites outgoing messages for backward compatibility with clients that have not enabled the experimental API. Currently it strips experimental fields from command-execution approval requests.

**Data flow**: Accepts `&OutboundConnectionState` and an owned `OutgoingMessage`. It reads `experimental_api_enabled` with `Ordering::Acquire`. If the message is `OutgoingMessage::Request(ServerRequest::CommandExecutionRequestApproval { request_id, mut params })` and experimental API is disabled, it calls `params.strip_experimental_fields()`, then reconstructs and returns the request message. All other messages are returned unchanged.

**Call relations**: Called by `send_message_to_connection` before notification suppression and enqueueing. It allows requests to remain deliverable to older clients while hiding fields they do not understand.

*Call graph*: called by 1 (send_message_to_connection); 1 external calls (Request).


##### `route_outgoing_envelope`  (lines 198–237)

```
async fn route_outgoing_envelope(
    connections: &mut HashMap<ConnectionId, OutboundConnectionState>,
    envelope: OutgoingEnvelope,
)
```

**Purpose**: Routes one `OutgoingEnvelope` either to a single connection or to all eligible initialized connections. It is the top-level outbound dispatch function for this module.

**Data flow**: Accepts the mutable connection map and an `OutgoingEnvelope`. For `ToConnection`, it forwards the contained `connection_id`, `message`, and `write_complete_tx` to `send_message_to_connection` and ignores the returned disconnect flag. For `Broadcast`, it first collects a `Vec<ConnectionId>` of connections whose `initialized` flag is true and for which `should_skip_notification_for_connection` is false for the broadcast message, then iterates that snapshot and calls `send_message_to_connection` with `message.clone()` and no completion sender for each target. It mutates the connection map indirectly when sends disconnect/remove connections.

**Call relations**: Called by the transport startup loop when outgoing envelopes arrive from higher layers. It delegates all per-connection filtering, enqueueing, and disconnection behavior to `send_message_to_connection`, while handling the fan-out mechanics for broadcasts.

*Call graph*: calls 1 internal fn (send_message_to_connection); called by 1 (start_uninitialized).


### `app-server/src/in_process.rs`

`orchestration` · `startup, request handling, event delivery, shutdown`

This module builds a transport-local app-server runtime around the existing `MessageProcessor`, outbound routing, and connection/session machinery instead of inventing a separate embedded execution path. Startup is driven by `InProcessStartArgs`, which packages all ambient state normally assembled by stdio/websocket startup: config, auth/environment dependencies, config loaders, feedback/log/state DB handles, session source, initialize parameters, and queue capacity. `start` wraps `start_uninitialized` and performs the initial `initialize` request plus `initialized` notification before returning a ready `InProcessClientHandle`.

The runtime itself is a Tokio task coordinating three bounded channel domains: client commands (`InProcessClientMessage`), processor commands (`ProcessorCommand`), and outbound messages (`OutgoingEnvelope`/`QueuedOutgoingMessage`). It creates a synthetic single connection `IN_PROCESS_CONNECTION_ID`, tracks pending client request IDs in a `HashMap<RequestId, oneshot::Sender<...>>`, and rejects duplicate in-flight IDs with `invalid_request`. Requests are forwarded to the processor with `try_send`; overload becomes a JSON-RPC error response instead of a transport failure so callers do not hang. Notifications may be dropped under saturation, but server requests are never silently lost: if they cannot be queued to the embedder, the runtime sends an overload/internal error back through `OutgoingMessageSender`.

A key design detail is that outbound connection state mirrors normal transport state using `AtomicBool` flags for initialization and experimental API enablement plus an `RwLock<HashSet<_>>` for opted-out notification methods. After each processed request, the runtime snapshots session state back into outbound routing state and emits initialize notifications on the first successful initialization. During teardown it cancels outstanding requests, drains processor/router tasks with bounded timeouts, aborts if necessary, and acknowledges shutdown through a oneshot.

#### Function details

##### `server_notification_requires_delivery`  (lines 104–111)

```
fn server_notification_requires_delivery(notification: &ServerNotification) -> bool
```

**Purpose**: Classifies a small set of server notifications as mandatory-delivery events. These are terminal or state-critical notifications that should block rather than be dropped when the event queue is saturated.

**Data flow**: It reads a borrowed `&ServerNotification`, pattern-matches its variant, and returns `true` only for `TurnCompleted`, `ThreadSettingsUpdated`, and `ExternalAgentConfigImportCompleted`; all other notification variants produce `false`.

**Call relations**: The runtime loop in `start_uninitialized` consults this helper when converting outbound `OutgoingMessage::AppServerNotification` values into `InProcessServerEvent`s. A `true` result causes an awaited `send` for guaranteed delivery, while `false` keeps the non-blocking `try_send` path that may drop under backpressure.

*Call graph*: 1 external calls (matches!).


##### `InProcessClientSender::request`  (lines 204–216)

```
async fn request(&self, request: ClientRequest) -> IoResult<PendingClientRequestResponse>
```

**Purpose**: Submits a typed client request into the runtime and waits for the matching JSON-RPC response envelope. It is the low-level async request path used by the public handle wrapper.

**Data flow**: It takes ownership of a `ClientRequest`, creates a `oneshot` response channel, wraps the request in `InProcessClientMessage::Request { request: Box<ClientRequest>, response_tx }`, and pushes it through `try_send_client_message`. If enqueue succeeds, it awaits the oneshot receiver and returns either the processor's `PendingClientRequestResponse` or an `IoError(BrokenPipe)` if the response channel closes before a reply arrives.

**Call relations**: This method is invoked by `InProcessClientHandle::request`. After enqueueing, the runtime task in `start_uninitialized` records the request ID in its pending-response map, forwards the request to the processor task, and later fulfills the oneshot when a matching outbound response or error arrives from `writer_rx`.

*Call graph*: calls 1 internal fn (try_send_client_message); called by 1 (request); 2 external calls (new, channel).


##### `InProcessClientSender::notify`  (lines 218–220)

```
fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Queues a fire-and-forget client notification for the runtime. It exposes notification submission without waiting for any application-level reply.

**Data flow**: It consumes a `ClientNotification`, wraps it in `InProcessClientMessage::Notification`, and forwards it to `try_send_client_message`. The return value is only an `IoResult<()>`, reflecting queue-full or runtime-closed transport conditions.

**Call relations**: This is called by `InProcessClientHandle::notify`. In the runtime loop, successful delivery becomes a `ProcessorCommand::Notification`; if the processor queue is full, the runtime logs and drops the notification rather than synthesizing a response.

*Call graph*: calls 1 internal fn (try_send_client_message); called by 1 (notify).


##### `InProcessClientSender::respond_to_server_request`  (lines 222–227)

```
fn respond_to_server_request(&self, request_id: RequestId, result: Result) -> IoResult<()>
```

**Purpose**: Sends a successful client-side answer for a pending server request back into the runtime. It is the embedded equivalent of replying to a JSON-RPC request initiated by the server.

**Data flow**: It takes a `RequestId` and JSON `Result`, packages them as `InProcessClientMessage::ServerRequestResponse`, and submits that message through `try_send_client_message`. It returns only transport success/failure.

**Call relations**: This method is reached through `InProcessClientHandle::respond_to_server_request` after the embedder receives `InProcessServerEvent::ServerRequest`. The runtime loop consumes the message and delegates to `OutgoingMessageSender::notify_client_response` so the original server-side waiter inside app-server can resume.

*Call graph*: calls 1 internal fn (try_send_client_message); called by 1 (respond_to_server_request).


##### `InProcessClientSender::fail_server_request`  (lines 229–238)

```
fn fail_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Sends an error reply for a pending server request when the embedder cannot satisfy it. This prevents approval or callback flows from stalling indefinitely.

**Data flow**: It accepts a `RequestId` and `JSONRPCErrorError`, wraps them in `InProcessClientMessage::ServerRequestError`, and pushes the message via `try_send_client_message`. The result reports only queue saturation or closed-runtime transport errors.

**Call relations**: This is called by `InProcessClientHandle::fail_server_request`. In the runtime loop, the message is translated into `OutgoingMessageSender::notify_client_error`, which feeds the error back into the normal app-server request/response path.

*Call graph*: calls 1 internal fn (try_send_client_message); called by 1 (fail_server_request).


##### `InProcessClientSender::try_send_client_message`  (lines 240–252)

```
fn try_send_client_message(&self, message: InProcessClientMessage) -> IoResult<()>
```

**Purpose**: Implements the common non-blocking enqueue policy for all client-to-runtime messages. It converts Tokio channel backpressure and closure into stable `std::io::Error` values.

**Data flow**: It takes an `InProcessClientMessage` and calls `self.client_tx.try_send(message)`. Success returns `Ok(())`; `TrySendError::Full` becomes `IoError(WouldBlock, "in-process app-server client queue is full")`; `TrySendError::Closed` becomes `IoError(BrokenPipe, "in-process app-server runtime is closed")`.

**Call relations**: All outward-facing sender methods delegate here so they share identical transport semantics. The runtime task on the receiving side is created in `start_uninitialized`; once that task exits and drops the receiver, this helper starts returning `BrokenPipe`.

*Call graph*: called by 4 (fail_server_request, notify, request, respond_to_server_request); 2 external calls (try_send, new).


##### `InProcessClientHandle::request`  (lines 276–278)

```
async fn request(&self, request: ClientRequest) -> IoResult<PendingClientRequestResponse>
```

**Purpose**: Public handle method for issuing a client request against the in-process runtime. It preserves the same typed-request / JSON-RPC-result contract exposed by the lower-level sender.

**Data flow**: It takes `&self` plus a `ClientRequest` and forwards directly to `self.client.request(request).await`, returning the nested `IoResult<PendingClientRequestResponse>` unchanged.

**Call relations**: This is the main request API used by callers after `start` returns a ready handle. It is a thin wrapper over `InProcessClientSender::request`, keeping the handle as the primary user-facing object while reusing the sender implementation.

*Call graph*: calls 1 internal fn (request); called by 1 (delete_thread).


##### `InProcessClientHandle::notify`  (lines 284–286)

```
fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Public handle method for sending a client notification into the runtime. It exposes the sender's non-blocking notification path on the main handle type.

**Data flow**: It consumes a `ClientNotification`, forwards it to `self.client.notify(notification)`, and returns the resulting `IoResult<()>` unchanged.

**Call relations**: Callers use this after startup for notification-only protocol messages, including the `initialized` notification sent by `start`. Internally it is just a façade over `InProcessClientSender::notify`.

*Call graph*: calls 1 internal fn (notify).


##### `InProcessClientHandle::respond_to_server_request`  (lines 293–295)

```
fn respond_to_server_request(&self, request_id: RequestId, result: Result) -> IoResult<()>
```

**Purpose**: Public handle method for completing a server-initiated request with a success result. It is intended to be paired with request IDs received from `next_event`.

**Data flow**: It takes a `RequestId` and `Result`, forwards them to `self.client.respond_to_server_request`, and returns the transport-level `IoResult<()>` from that call.

**Call relations**: Embedders call this after observing `InProcessServerEvent::ServerRequest` from `next_event`. The actual routing back into app-server is performed by the sender method and then by the runtime loop.

*Call graph*: calls 1 internal fn (respond_to_server_request).


##### `InProcessClientHandle::fail_server_request`  (lines 301–307)

```
fn fail_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Public handle method for rejecting a server-initiated request with a JSON-RPC error. It gives embedders an explicit failure path instead of leaving requests unanswered.

**Data flow**: It accepts a `RequestId` and `JSONRPCErrorError`, passes them to `self.client.fail_server_request`, and returns the resulting `IoResult<()>` unchanged.

**Call relations**: This is the handle-level counterpart to `respond_to_server_request`, used when the embedder cannot or will not fulfill a `ServerRequest`. The runtime loop converts it into an app-server-visible error response.

*Call graph*: calls 1 internal fn (fail_server_request).


##### `InProcessClientHandle::next_event`  (lines 313–315)

```
async fn next_event(&mut self) -> Option<InProcessServerEvent>
```

**Purpose**: Receives the next server-originated event emitted by the runtime. It is the consumer side of the in-process event stream for server requests, notifications, and lag markers.

**Data flow**: It awaits `self.event_rx.recv()` on the bounded Tokio receiver and returns `Option<InProcessServerEvent>`, where `None` means the runtime has exited and no more events remain.

**Call relations**: The runtime task in `start_uninitialized` pushes `InProcessServerEvent` values into `event_tx` as it drains outbound messages from `writer_rx`. Embedders poll this method during normal operation to service server requests and observe notifications.

*Call graph*: calls 1 internal fn (recv).


##### `InProcessClientHandle::shutdown`  (lines 321–340)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Requests runtime termination and waits, within fixed deadlines, for the background task to stop. It provides bounded graceful shutdown with forced abort as a fallback.

**Data flow**: It consumes `self`, extracts the `runtime_handle`, creates a shutdown oneshot pair, and asynchronously sends `InProcessClientMessage::Shutdown { done_tx }` on the client channel. If that send succeeds it waits up to `SHUTDOWN_TIMEOUT` for the runtime's acknowledgment, then waits up to the same timeout for the runtime task itself; on timeout it aborts the task and awaits its completion before returning `Ok(())`.

**Call relations**: Callers invoke this at teardown. Inside `start_uninitialized`, receipt of the `Shutdown` message stores the ack sender, breaks the main loop, performs cleanup of pending requests and worker tasks, and finally sends the acknowledgment once shutdown work is complete.

*Call graph*: 2 external calls (channel, timeout).


##### `InProcessClientHandle::sender`  (lines 342–344)

```
fn sender(&self) -> InProcessClientSender
```

**Purpose**: Returns a cloneable lightweight sender view detached from event reception and task ownership. This lets other components submit requests or replies without owning the full handle.

**Data flow**: It reads `self.client`, clones the `InProcessClientSender`, and returns that clone. No runtime state is mutated.

**Call relations**: This method is used when a caller needs to hand off command submission capability while retaining the main handle elsewhere. The cloned sender still targets the same `client_tx` channel created in `start_uninitialized`.

*Call graph*: 1 external calls (clone).


##### `start`  (lines 352–372)

```
async fn start(args: InProcessStartArgs) -> IoResult<InProcessClientHandle>
```

**Purpose**: Starts the in-process runtime and completes the protocol handshake so the returned handle is immediately usable. It enforces that initialization succeeds before exposing the runtime to callers.

**Data flow**: It takes `InProcessStartArgs`, clones `args.initialize`, calls `start_uninitialized(args)` to build the runtime, then sends `ClientRequest::Initialize` with `RequestId::Integer(0)` through the returned handle. If the response is a JSON-RPC error, it shuts the runtime down and returns `IoError(InvalidData, ...)`; otherwise it sends `ClientNotification::Initialized` and returns the ready `InProcessClientHandle`.

**Call relations**: This is the public constructor used by production callers and tests. It delegates all runtime assembly to `start_uninitialized`, then uses the handle's own request/notify APIs to drive the same initialize flow an external client would perform.

*Call graph*: calls 1 internal fn (start_uninitialized); called by 9 (start, start_test_client_with_capacity, get_conversation_summary_by_thread_id_reads_pathless_store_thread, mcp_resource_read_returns_error_for_unknown_thread, start_in_process_client, thread_list_includes_store_thread_without_rollout_path, thread_read_loaded_include_turns_reads_store_history_without_rollout_path, thread_turns_list_reads_store_history_without_rollout_path, thread_unarchive_preserves_pathless_store_metadata); 3 external calls (Integer, new, format!).


##### `start_uninitialized`  (lines 374–727)

```
async fn start_uninitialized(args: InProcessStartArgs) -> IoResult<InProcessClientHandle>
```

**Purpose**: Constructs the full in-process runtime graph without performing the initialize handshake. It wires channels, outbound routing, processor execution, request tracking, event fanout, and shutdown cleanup into a single supervising Tokio task.

**Data flow**: It consumes `InProcessStartArgs`, clamps `channel_capacity` to at least 1, resolves the installation ID from `config.codex_home`, creates client and event channels, and spawns the runtime task. Inside that task it creates outbound routing channels, builds shared `AuthManager`, analytics client, and `OutgoingMessageSender`, initializes synthetic outbound connection state for `IN_PROCESS_CONNECTION_ID`, spawns an outbound router that repeatedly calls `route_outgoing_envelope`, constructs `ConfigManager`, and spawns a processor task around `MessageProcessor::new(MessageProcessorArgs { ... rpc_transport: AppServerRpcTransport::InProcess, ... })`. The processor task receives `ProcessorCommand`s, processes requests/notifications, mirrors session flags (`initialized`, experimental API, opted-out notifications) into outbound state, emits initialize notifications on first initialization, listens for thread-created broadcasts to attach listeners, and on exit clears runtime references, cancels login, closes the connection, clears listeners, drains background tasks, and shuts down threads.

The outer runtime loop multiplexes client messages and queued outbound writes. For client requests it enforces unique `RequestId`s in `pending_request_responses`, forwards to the processor queue with `try_send`, and synthesizes overload/internal JSON-RPC errors if forwarding fails. Notifications are forwarded best-effort. Server-request replies/errors from the embedder are passed to `OutgoingMessageSender`. For outbound writes, responses and errors complete the matching pending oneshot; server requests are converted into `InProcessServerEvent::ServerRequest` or failed back to app-server if the event queue is full/closed; notifications are either guaranteed-delivery or best-effort depending on `server_notification_requires_delivery`. On shutdown or channel closure it drops receivers/senders in the right order, cancels all outstanding requests with `internal_error`, resolves any still-pending client oneshots, waits for processor and router tasks with timeouts, aborts if needed, and finally acknowledges shutdown if requested. The function itself returns an `InProcessClientHandle` containing the sender, event receiver, runtime join handle, and an optional test tempdir slot.

**Call relations**: This function is called only by `start`, which adds the initialize handshake on top. Within its spawned tasks it orchestrates the entire call flow between client-facing APIs, `MessageProcessor`, outbound routing, and event delivery, making it the central coordinator for the in-process transport.

*Call graph*: calls 9 internal fn (analytics_events_client_from_config, new, internal_error, new, new, new, new, route_outgoing_envelope, shared_from_config); called by 1 (start); 11 external calls (clone, new, new, new, new, new, new, resolve_installation_id, select!, spawn (+1 more)).


##### `tests::build_test_config`  (lines 747–761)

```
async fn build_test_config(codex_home: &Path) -> Config
```

**Purpose**: Builds a usable `Config` for tests rooted at a temporary `codex_home`. It prefers the builder path but falls back to loading defaults if the builder fails.

**Data flow**: It takes a `&Path`, attempts `ConfigBuilder::default().codex_home(...).build().await`, and returns the resulting `Config` on success. On error it calls `Config::load_default_with_cli_overrides_for_codex_home(codex_home.to_path_buf(), Vec::new()).await` and panics only if that fallback also fails.

**Call relations**: This helper is used by `tests::start_test_client_with_capacity` to prepare the configuration needed for `InProcessStartArgs`. It isolates test setup from the runtime logic under test.

*Call graph*: 4 external calls (to_path_buf, new, load_default_with_cli_overrides_for_codex_home, default).


##### `tests::start_test_client_with_capacity`  (lines 763–800)

```
async fn start_test_client_with_capacity(
        session_source: SessionSource,
        channel_capacity: usize,
    ) -> InProcessClientHandle
```

**Purpose**: Creates and starts a fully initialized in-process client for tests with a caller-specified queue capacity. It assembles realistic dependencies around a temporary home directory and test environment manager.

**Data flow**: It takes a `SessionSource` and `channel_capacity`, creates a `TempDir`, builds a config with `build_test_config`, initializes a rollout state DB, constructs `InProcessStartArgs` with defaults/no-op loaders, `CodexFeedback::new()`, `EnvironmentManager::default_for_tests()`, a fixed `InitializeParams` client identity, and the requested capacity, then awaits `start(args)`. After startup it stores the tempdir in the returned handle's test-only `_test_codex_home` field to keep the directory alive and returns the handle.

**Call relations**: This helper is the common fixture used by the async tests below. It exercises the public `start` path rather than bypassing initialization, so tests validate the same startup contract production callers use.

*Call graph*: calls 5 internal fn (start, default, default_for_tests, new, try_init); 6 external calls (new, new, new, build_test_config, default, default).


##### `tests::start_test_client`  (lines 802–804)

```
async fn start_test_client(session_source: SessionSource) -> InProcessClientHandle
```

**Purpose**: Convenience test fixture that starts a client with the module's default channel capacity. It avoids repeating the standard capacity argument in most tests.

**Data flow**: It takes a `SessionSource`, forwards it together with `DEFAULT_IN_PROCESS_CHANNEL_CAPACITY` to `start_test_client_with_capacity`, awaits the result, and returns the initialized `InProcessClientHandle`.

**Call relations**: This helper is called by tests that care about behavior other than queue sizing. It narrows the setup surface so those tests focus on protocol semantics.

*Call graph*: 1 external calls (start_test_client_with_capacity).


##### `tests::in_process_start_initializes_and_handles_typed_v2_request`  (lines 807–825)

```
async fn in_process_start_initializes_and_handles_typed_v2_request()
```

**Purpose**: Verifies that `start` performs initialization and that a normal typed request can be sent successfully through the in-process transport. It specifically checks that the returned JSON value matches the expected v2 schema.

**Data flow**: The test starts a client with `SessionSource::Cli`, sends `ClientRequest::ConfigRequirementsRead` with request ID 1, unwraps both the transport result and JSON-RPC success result, asserts the payload is a JSON object, deserializes it into `ConfigRequirementsReadResponse`, and then shuts the client down cleanly.

**Call relations**: This test drives the public `start`, `InProcessClientHandle::request`, and `shutdown` APIs end-to-end. Its success depends on the startup handshake in `start` and the request/response routing implemented in `start_uninitialized`.

*Call graph*: 4 external calls (Integer, start_test_client, assert!, from_value).


##### `tests::in_process_start_uses_requested_session_source_for_thread_start`  (lines 828–853)

```
async fn in_process_start_uses_requested_session_source_for_thread_start()
```

**Purpose**: Checks that the `session_source` supplied at startup is propagated into thread metadata created by app-server. It covers both CLI and Exec startup modes.

**Data flow**: For each `(requested_source, expected_source)` pair, the test starts a client, sends `ClientRequest::ThreadStart` with `ephemeral: Some(true)` and request ID 2, unwraps the successful JSON response, deserializes it into `ThreadStartResponse`, asserts `parsed.thread.source == expected_source`, and shuts the client down.

**Call relations**: This test validates that `start_uninitialized` passes `args.session_source` into `MessageProcessorArgs` and that the processor uses it when creating threads. It exercises the full request path rather than inspecting internal state directly.

*Call graph*: 5 external calls (Integer, default, start_test_client, assert_eq!, from_value).


##### `tests::in_process_start_clamps_zero_channel_capacity`  (lines 856–880)

```
async fn in_process_start_clamps_zero_channel_capacity()
```

**Purpose**: Confirms that a requested channel capacity of zero is clamped to a usable minimum instead of making the runtime unusable. It also tolerates transient `WouldBlock` while probing the bounded queue.

**Data flow**: The test starts a client with `channel_capacity` set to 0, then loops sending `ClientRequest::ConfigRequirementsRead` with request ID 4 until it either gets a successful response or a `WouldBlock` transport error, in which case it yields and retries. Once a response arrives, it deserializes it into `ConfigRequirementsReadResponse` and shuts the client down.

**Call relations**: This test targets the `args.channel_capacity.max(1)` behavior in `start_uninitialized` and the non-blocking enqueue semantics of the client sender. The retry loop reflects the module's documented backpressure behavior.

*Call graph*: 5 external calls (Integer, start_test_client_with_capacity, panic!, from_value, yield_now).


##### `tests::guaranteed_delivery_helpers_cover_terminal_server_notifications`  (lines 883–907)

```
fn guaranteed_delivery_helpers_cover_terminal_server_notifications()
```

**Purpose**: Asserts that the helper for mandatory-delivery notifications recognizes terminal notification variants that must not be dropped. It serves as a focused regression test for the delivery policy.

**Data flow**: It constructs representative `ServerNotification::TurnCompleted` and `ServerNotification::ExternalAgentConfigImportCompleted` values with minimal payloads and asserts that `server_notification_requires_delivery` returns `true` for both.

**Call relations**: This unit test directly exercises `server_notification_requires_delivery` without spinning up the runtime. It protects the event-delivery branch in `start_uninitialized` that switches between awaited send and best-effort try_send.

*Call graph*: 1 external calls (assert!).


### Transport listeners and websocket policy
These files provide the concrete stdio, Unix-socket, and websocket listeners plus the authentication policy that guards websocket upgrades.

### `app-server-transport/src/transport/auth.rs`

`domain_logic` · `startup config parsing and websocket upgrade authorization`

This file contains both the CLI/config surface for websocket auth and the runtime verification logic. `AppServerWebsocketAuthArgs` models the command-line flags, while `AppServerWebsocketAuthSettings` and `AppServerWebsocketAuthConfig` normalize them into one of two modes: `CapabilityToken`, sourced either from a token file or a precomputed SHA-256 digest, or `SignedBearerToken`, sourced from a shared-secret file plus optional issuer, audience, and clock-skew settings. `try_into_settings` performs strict cross-flag validation: mode-specific flags are rejected in the wrong mode, token-file and token-hash are mutually exclusive, absolute paths are required, optional issuer/audience strings are trimmed, and malformed SHA-256 hex digests are rejected.

At runtime, `policy_from_settings` reads and trims secrets from disk, hashes capability tokens, validates signed-bearer secret length (minimum 32 bytes), and converts skew to signed `i64`. `authorize_upgrade` is the main request gate: if no auth mode is configured it allows the upgrade; otherwise it extracts a `Bearer` token from the `Authorization` header and either compares SHA-256 digests in constant time or verifies an HS256 JWT. JWT verification intentionally disables library-side exp/nbf/aud checks so the file can apply its own skew-aware validation in `validate_jwt_claims`, including expiration, not-before, issuer, and audience matching for both scalar and array `aud` claims. Errors are collapsed into `WebsocketAuthError` with HTTP 401 and stable messages suitable for websocket upgrade rejection. The embedded tests cover CLI parsing, token hashing, JWT tampering, `alg=none`, missing `exp`, audience arrays, and short shared secrets.

#### Function details

##### `WebsocketAuthError::status_code`  (lines 128–130)

```
fn status_code(&self) -> StatusCode
```

**Purpose**: Exposes the HTTP status code associated with an authorization failure. Callers use it when constructing upgrade rejection responses.

**Data flow**: Borrows `self` and returns the stored `StatusCode`.

**Call relations**: Used by websocket-serving code and tests after `authorize_upgrade` or JWT verification returns an auth error.


##### `WebsocketAuthError::message`  (lines 132–134)

```
fn message(&self) -> &'static str
```

**Purpose**: Returns the static human-readable reason string for an authorization failure. It keeps error reporting separate from transport-specific response formatting.

**Data flow**: Borrows `self` and returns the stored `&'static str` message.

**Call relations**: Consumed by websocket upgrade handlers when turning auth failures into HTTP responses or logs.


##### `AppServerWebsocketAuthArgs::try_into_settings`  (lines 138–219)

```
fn try_into_settings(self) -> anyhow::Result<AppServerWebsocketAuthSettings>
```

**Purpose**: Validates and normalizes CLI websocket-auth flags into a structured settings object. It enforces mode-specific flag combinations and converts raw strings into typed config values.

**Data flow**: Consumes `AppServerWebsocketAuthArgs`, trims optional issuer/audience strings through a local closure, matches on `ws_auth`, validates incompatible or missing flags, converts token/shared-secret paths with `absolute_path_arg`, parses token digests with `sha256_digest_arg`, fills in the default clock skew when needed, and returns `AppServerWebsocketAuthSettings { config }` or an `anyhow` error.

**Call relations**: Called during startup argument processing before runtime policy construction. It delegates path and digest parsing to helper functions in this file.

*Call graph*: calls 2 internal fn (absolute_path_arg, sha256_digest_arg); 1 external calls (bail!).


##### `policy_from_settings`  (lines 222–264)

```
fn policy_from_settings(
    settings: &AppServerWebsocketAuthSettings,
) -> io::Result<WebsocketAuthPolicy>
```

**Purpose**: Builds the runtime `WebsocketAuthPolicy` from normalized settings by loading secrets and preparing verification material. It is the bridge from startup config to request-time authorization.

**Data flow**: Takes `&AppServerWebsocketAuthSettings`, matches on `settings.config`, reads and trims token or shared-secret files with `read_trimmed_secret`, hashes capability tokens with `sha256_digest`, validates signed-bearer secret length, converts clock skew to `i64`, and returns `WebsocketAuthPolicy { mode }` or an `io::Error`.

**Call relations**: Called during transport startup before websocket listeners begin accepting connections. The resulting policy is later consumed by `authorize_upgrade`.

*Call graph*: calls 3 internal fn (read_trimmed_secret, sha256_digest, validate_signed_bearer_secret); called by 2 (capability_token_hash_policy_authorizes_matching_bearer_token, run_main_with_transport_options); 1 external calls (try_from).


##### `is_unauthenticated_non_loopback_listener`  (lines 266–271)

```
fn is_unauthenticated_non_loopback_listener(
    bind_address: SocketAddr,
    policy: &WebsocketAuthPolicy,
) -> bool
```

**Purpose**: Detects the unsafe configuration where a websocket listener is exposed on a non-loopback address without any authentication policy. It supports startup warnings or refusal logic.

**Data flow**: Accepts a `SocketAddr` and `WebsocketAuthPolicy`, checks `bind_address.ip().is_loopback()` and whether `policy.mode` is `None`, and returns a boolean.

**Call relations**: Called by websocket acceptor startup code to decide whether to warn about or reject an unauthenticated externally reachable listener.

*Call graph*: called by 1 (start_websocket_acceptor); 1 external calls (ip).


##### `authorize_upgrade`  (lines 273–304)

```
fn authorize_upgrade(
    headers: &HeaderMap,
    policy: &WebsocketAuthPolicy,
) -> Result<(), WebsocketAuthError>
```

**Purpose**: Authorizes an incoming websocket upgrade request according to the configured auth policy. It is the main runtime gate for websocket access.

**Data flow**: Takes request headers and a `WebsocketAuthPolicy`. If `policy.mode` is `None`, it returns `Ok(())`. Otherwise it extracts a bearer token with `bearer_token_from_headers`; in capability-token mode it hashes the token and compares against the configured digest with `constant_time_eq_32`, and in signed-bearer mode it delegates to `verify_signed_bearer_token`. It returns `Ok(())` on success or `WebsocketAuthError` on failure.

**Call relations**: Called by the websocket upgrade handler for each incoming connection. It delegates token parsing and mode-specific verification to helpers in this file.

*Call graph*: calls 4 internal fn (bearer_token_from_headers, sha256_digest, unauthorized, verify_signed_bearer_token); called by 2 (capability_token_hash_policy_authorizes_matching_bearer_token, websocket_upgrade_handler); 1 external calls (constant_time_eq_32).


##### `verify_signed_bearer_token`  (lines 306–315)

```
fn verify_signed_bearer_token(
    token: &str,
    shared_secret: &[u8],
    issuer: Option<&str>,
    audience: Option<&str>,
    max_clock_skew_seconds: i64,
) -> Result<(), WebsocketAuthError>
```

**Purpose**: Verifies an HS256 bearer JWT and applies custom claim validation rules. It separates cryptographic decoding from semantic claim checks.

**Data flow**: Accepts the raw token string, shared secret bytes, optional issuer and audience, and max clock skew. It decodes claims with `decode_jwt_claims`, validates them with `validate_jwt_claims`, and returns success or a `WebsocketAuthError`.

**Call relations**: Called by `authorize_upgrade` in signed-bearer mode and directly by tests covering JWT behavior.

*Call graph*: calls 2 internal fn (decode_jwt_claims, validate_jwt_claims); called by 6 (authorize_upgrade, signed_bearer_token_verification_accepts_multiple_audiences, signed_bearer_token_verification_accepts_valid_token, signed_bearer_token_verification_rejects_alg_none_tokens, signed_bearer_token_verification_rejects_missing_exp, signed_bearer_token_verification_rejects_tampering).


##### `decode_jwt_claims`  (lines 317–327)

```
fn decode_jwt_claims(token: &str, shared_secret: &[u8]) -> Result<JwtClaims, WebsocketAuthError>
```

**Purpose**: Decodes and verifies the JWT signature using HS256, returning the typed claims payload. It intentionally disables built-in claim validation so the file can apply its own skew-aware rules afterward.

**Data flow**: Takes the token string and shared secret bytes, constructs `Validation::new(Algorithm::HS256)`, clears required claims and disables exp/nbf/aud validation, calls `jsonwebtoken::decode::<JwtClaims>` with `DecodingKey::from_secret`, and returns the decoded `JwtClaims` or an unauthorized error.

**Call relations**: Used only by `verify_signed_bearer_token` as the cryptographic verification step before semantic claim checks.

*Call graph*: called by 1 (verify_signed_bearer_token); 2 external calls (from_secret, new).


##### `validate_jwt_claims`  (lines 329–356)

```
fn validate_jwt_claims(
    claims: &JwtClaims,
    issuer: Option<&str>,
    audience: Option<&str>,
    max_clock_skew_seconds: i64,
) -> Result<(), WebsocketAuthError>
```

**Purpose**: Applies skew-aware expiration, not-before, issuer, and audience checks to decoded JWT claims. It defines the exact acceptance policy for signed websocket bearer tokens.

**Data flow**: Receives `&JwtClaims`, optional expected issuer and audience, and max clock skew seconds. It reads the current UTC unix timestamp, rejects expired tokens using `exp + skew`, rejects not-yet-valid tokens using `nbf - skew`, compares `iss` when configured, checks `aud` with `audience_matches` when configured, and returns `Ok(())` or an unauthorized error.

**Call relations**: Called by `verify_signed_bearer_token` after successful JWT decoding.

*Call graph*: calls 2 internal fn (audience_matches, unauthorized); called by 1 (verify_signed_bearer_token); 1 external calls (now_utc).


##### `audience_matches`  (lines 358–366)

```
fn audience_matches(audience: Option<&JwtAudienceClaim>, expected_audience: &str) -> bool
```

**Purpose**: Checks whether a JWT audience claim matches the configured expected audience, supporting both string and array forms. It encapsulates the claim-shape branching.

**Data flow**: Takes an optional `JwtAudienceClaim` reference and expected audience string, matches on `Single`, `Multiple`, or `None`, and returns a boolean.

**Call relations**: Used only by `validate_jwt_claims` when audience validation is enabled.

*Call graph*: called by 1 (validate_jwt_claims).


##### `bearer_token_from_headers`  (lines 368–386)

```
fn bearer_token_from_headers(headers: &HeaderMap) -> Result<&str, WebsocketAuthError>
```

**Purpose**: Extracts and validates the bearer token from the HTTP `Authorization` header. It rejects missing, malformed, non-Bearer, or empty-token headers with a uniform unauthorized error.

**Data flow**: Accepts `&HeaderMap`, fetches the `AUTHORIZATION` header, converts it to `&str`, splits once on space, checks that the scheme equals `Bearer` case-insensitively, trims the token, and returns the token slice or `WebsocketAuthError`.

**Call relations**: Called by `authorize_upgrade` before any mode-specific token verification occurs.

*Call graph*: calls 1 internal fn (unauthorized); called by 1 (authorize_upgrade); 1 external calls (get).


##### `validate_signed_bearer_secret`  (lines 388–399)

```
fn validate_signed_bearer_secret(path: &Path, shared_secret: &[u8]) -> io::Result<()>
```

**Purpose**: Ensures the shared secret used for signed bearer JWTs is long enough to be acceptable. It prevents weak or accidental short secrets from being used.

**Data flow**: Takes the secret file path and secret bytes, compares `shared_secret.len()` against `MIN_SIGNED_BEARER_SECRET_BYTES`, and returns `Ok(())` or an `io::ErrorKind::InvalidInput` with a path-specific message.

**Call relations**: Called by `policy_from_settings` after reading the shared secret and directly by a unit test.

*Call graph*: called by 2 (policy_from_settings, validate_signed_bearer_secret_rejects_short_secret); 2 external calls (new, format!).


##### `read_trimmed_secret`  (lines 401–419)

```
fn read_trimmed_secret(path: &std::path::Path) -> io::Result<String>
```

**Purpose**: Reads a secret file from disk, trims surrounding whitespace, and rejects empty results. It standardizes secret-file handling for both auth modes.

**Data flow**: Accepts a filesystem path, reads the file to string, wraps read errors with the path, trims whitespace, rejects an empty trimmed string with `InvalidInput`, and returns the trimmed secret as an owned `String`.

**Call relations**: Used by `policy_from_settings` to load capability tokens and signed-bearer shared secrets.

*Call graph*: called by 1 (policy_from_settings); 3 external calls (new, format!, read_to_string).


##### `absolute_path_arg`  (lines 421–423)

```
fn absolute_path_arg(flag_name: &str, path: PathBuf) -> anyhow::Result<AbsolutePathBuf>
```

**Purpose**: Converts a CLI path argument into an `AbsolutePathBuf` with a flag-specific error message. It enforces that websocket auth secret paths are absolute.

**Data flow**: Takes the flag name and a `PathBuf`, calls `AbsolutePathBuf::try_from`, and returns the absolute path or an `anyhow` error annotated with the flag name.

**Call relations**: Called by `AppServerWebsocketAuthArgs::try_into_settings` for token and shared-secret file arguments.

*Call graph*: calls 1 internal fn (try_from); called by 1 (try_into_settings).


##### `sha256_digest_arg`  (lines 425–438)

```
fn sha256_digest_arg(flag_name: &str, value: &str) -> anyhow::Result<[u8; 32]>
```

**Purpose**: Parses a 64-character hex SHA-256 digest string into a `[u8; 32]`. It validates both length and hexadecimal character set.

**Data flow**: Accepts the flag name and raw string, trims whitespace, checks for exactly 64 characters, iterates over byte pairs, converts each nibble with `hex_nibble`, assembles the digest array, and returns it or an `anyhow` error.

**Call relations**: Called by `AppServerWebsocketAuthArgs::try_into_settings` when capability-token auth is configured via a precomputed digest.

*Call graph*: calls 1 internal fn (hex_nibble); called by 1 (try_into_settings); 1 external calls (bail!).


##### `hex_nibble`  (lines 440–447)

```
fn hex_nibble(flag_name: &str, byte: u8) -> anyhow::Result<u8>
```

**Purpose**: Converts a single ASCII hex digit into its numeric nibble value. It is the low-level parser used by SHA-256 digest argument parsing.

**Data flow**: Takes the flag name and one byte, matches decimal, lowercase hex, uppercase hex, or invalid input, and returns the nibble value or a standardized digest-format error.

**Call relations**: Used only by `sha256_digest_arg` while decoding each pair of hex characters.

*Call graph*: called by 1 (sha256_digest_arg); 1 external calls (bail!).


##### `sha256_digest`  (lines 449–453)

```
fn sha256_digest(input: &[u8]) -> [u8; 32]
```

**Purpose**: Computes the SHA-256 digest of arbitrary input bytes and returns it as a fixed-size array. It is used for capability-token hashing.

**Data flow**: Accepts a byte slice, computes `Sha256::digest(input)`, copies the result into a `[u8; 32]`, and returns that array.

**Call relations**: Called by `policy_from_settings` when hashing a token file, by `authorize_upgrade` when hashing an incoming bearer token, and by tests constructing expected digests.

*Call graph*: called by 3 (authorize_upgrade, policy_from_settings, capability_token_hash_policy_authorizes_matching_bearer_token); 1 external calls (digest).


##### `unauthorized`  (lines 455–460)

```
fn unauthorized(message: &'static str) -> WebsocketAuthError
```

**Purpose**: Constructs a standardized unauthorized websocket auth error with HTTP 401 and a static message. It centralizes error creation for all auth failures.

**Data flow**: Takes a static message string and returns `WebsocketAuthError { status_code: StatusCode::UNAUTHORIZED, message }`.

**Call relations**: Used throughout header parsing, capability-token checks, and JWT validation to produce consistent authorization failures.

*Call graph*: called by 3 (authorize_upgrade, bearer_token_from_headers, validate_jwt_claims).


##### `tests::signed_token`  (lines 474–482)

```
fn signed_token(shared_secret: &[u8], claims: serde_json::Value) -> String
```

**Purpose**: Builds a compact HS256 JWT string for unit tests from arbitrary JSON claims. It avoids depending on external token issuers in tests.

**Data flow**: Takes shared-secret bytes and a JSON claims value, base64url-encodes a fixed header and the serialized claims, signs the `header.claims` payload with HMAC-SHA256, base64url-encodes the signature, and returns the final `header.claims.signature` string.

**Call relations**: Used by the JWT verification tests to generate valid and tampered signed tokens.

*Call graph*: 3 external calls (new_from_slice, format!, to_vec).


##### `tests::detects_unauthenticated_non_loopback_listener`  (lines 485–503)

```
fn detects_unauthenticated_non_loopback_listener()
```

**Purpose**: Verifies that non-loopback websocket listeners without auth are detected while loopback or authenticated listeners are not. It protects the startup safety check.

**Data flow**: Constructs default and authenticated policies, parses socket addresses, calls `is_unauthenticated_non_loopback_listener`, and asserts the expected booleans.

**Call relations**: Exercises the listener-safety helper directly as a unit test.

*Call graph*: 2 external calls (default, assert!).


##### `tests::capability_token_args_require_token_file_or_hash`  (lines 506–518)

```
fn capability_token_args_require_token_file_or_hash()
```

**Purpose**: Checks that capability-token mode rejects missing token source flags. It validates CLI argument constraints.

**Data flow**: Builds `AppServerWebsocketAuthArgs` with capability-token mode and no token source, calls `try_into_settings`, captures the error, and asserts that the message mentions both accepted source flags.

**Call relations**: Tests the validation branch inside `AppServerWebsocketAuthArgs::try_into_settings`.

*Call graph*: 2 external calls (default, assert!).


##### `tests::capability_token_args_accept_token_hash`  (lines 521–540)

```
fn capability_token_args_accept_token_hash()
```

**Purpose**: Confirms that a valid hex digest is accepted and normalized into the expected settings structure. It covers the digest-parsing happy path.

**Data flow**: Creates args with capability-token mode and `ab` repeated 32 times, calls `try_into_settings`, and asserts equality with a settings object containing `TokenSha256 { token_sha256: [0xab; 32] }`.

**Call relations**: Exercises `sha256_digest_arg` indirectly through CLI settings parsing.

*Call graph*: 2 external calls (default, assert_eq!).


##### `tests::capability_token_args_reject_multiple_token_sources`  (lines 543–556)

```
fn capability_token_args_reject_multiple_token_sources()
```

**Purpose**: Ensures capability-token mode rejects simultaneous `--ws-token-file` and `--ws-token-sha256`. It protects against ambiguous configuration.

**Data flow**: Builds args containing both token source flags, calls `try_into_settings`, captures the error, and asserts that the message mentions mutual exclusivity.

**Call relations**: Tests the conflicting-source branch in `AppServerWebsocketAuthArgs::try_into_settings`.

*Call graph*: 3 external calls (default, from, assert!).


##### `tests::capability_token_args_reject_malformed_token_hash`  (lines 559–571)

```
fn capability_token_args_reject_malformed_token_hash()
```

**Purpose**: Verifies that malformed token digests are rejected with a digest-format error. It covers invalid hash input handling.

**Data flow**: Creates capability-token args with a non-SHA256 string, calls `try_into_settings`, captures the error, and asserts that the message mentions the required 64-character hex format.

**Call relations**: Exercises `sha256_digest_arg` error handling through the CLI parser.

*Call graph*: 2 external calls (default, assert!).


##### `tests::capability_token_hash_policy_authorizes_matching_bearer_token`  (lines 574–596)

```
fn capability_token_hash_policy_authorizes_matching_bearer_token()
```

**Purpose**: Checks that a capability-token policy authorizes the correct bearer token and rejects an incorrect one. It validates both policy construction and runtime authorization.

**Data flow**: Builds settings with a precomputed token digest, converts them with `policy_from_settings`, constructs headers with matching then non-matching bearer tokens, calls `authorize_upgrade`, and asserts success then HTTP 401 failure.

**Call relations**: Covers the end-to-end capability-token path from settings to request authorization.

*Call graph*: calls 3 internal fn (authorize_upgrade, policy_from_settings, sha256_digest); 3 external calls (new, from_static, assert_eq!).


##### `tests::signed_bearer_args_require_mode_when_mode_specific_flags_are_set`  (lines 599–610)

```
fn signed_bearer_args_require_mode_when_mode_specific_flags_are_set()
```

**Purpose**: Ensures signed-bearer-specific flags are rejected unless `--ws-auth signed-bearer-token` is explicitly selected. It protects CLI ergonomics and correctness.

**Data flow**: Builds args with only `ws_shared_secret_file`, calls `try_into_settings`, captures the error, and asserts that the message says websocket auth flags require an explicit mode.

**Call relations**: Tests the no-mode validation branch in `AppServerWebsocketAuthArgs::try_into_settings`.

*Call graph*: 3 external calls (default, from, assert!).


##### `tests::signed_bearer_args_default_clock_skew_and_trim_optional_claims`  (lines 613–636)

```
fn signed_bearer_args_default_clock_skew_and_trim_optional_claims()
```

**Purpose**: Verifies that signed-bearer settings trim issuer/audience strings and apply the default clock skew when omitted. It covers normalization behavior rather than runtime auth.

**Data flow**: Builds signed-bearer args with an absolute secret path, a padded issuer, and whitespace-only audience, calls `try_into_settings`, and asserts equality with normalized settings containing trimmed issuer, `None` audience, and the default skew constant.

**Call relations**: Exercises the normalization closure and signed-bearer settings branch in `try_into_settings`.

*Call graph*: 3 external calls (default, from, assert_eq!).


##### `tests::signed_bearer_token_verification_rejects_tampering`  (lines 639–657)

```
fn signed_bearer_token_verification_rejects_tampering()
```

**Purpose**: Confirms that modifying a signed JWT payload causes verification to fail. It protects against accepting tampered bearer tokens.

**Data flow**: Generates a valid signed token with future `exp`, mutates part of the encoded payload string, calls `verify_signed_bearer_token`, and asserts that the result is an unauthorized error.

**Call relations**: Directly tests the cryptographic verification path in `verify_signed_bearer_token` and `decode_jwt_claims`.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 3 external calls (signed_token, assert_eq!, json!).


##### `tests::signed_bearer_token_verification_accepts_valid_token`  (lines 660–678)

```
fn signed_bearer_token_verification_accepts_valid_token()
```

**Purpose**: Checks that a correctly signed JWT with matching issuer and audience is accepted. It covers the signed-bearer happy path.

**Data flow**: Builds a token with future `exp`, `iss`, and `aud`, calls `verify_signed_bearer_token` with matching expectations and skew, and expects success.

**Call relations**: Exercises both JWT decoding and semantic claim validation.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 2 external calls (signed_token, json!).


##### `tests::signed_bearer_token_verification_accepts_multiple_audiences`  (lines 681–698)

```
fn signed_bearer_token_verification_accepts_multiple_audiences()
```

**Purpose**: Verifies that JWTs with an array-valued `aud` claim are accepted when one entry matches the expected audience. It covers the alternate audience claim shape.

**Data flow**: Generates a token whose `aud` is an array containing the expected audience, calls `verify_signed_bearer_token`, and expects success.

**Call relations**: Specifically exercises `audience_matches` through `validate_jwt_claims`.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 2 external calls (signed_token, json!).


##### `tests::signed_bearer_token_verification_rejects_alg_none_tokens`  (lines 701–719)

```
fn signed_bearer_token_verification_rejects_alg_none_tokens()
```

**Purpose**: Ensures unsigned `alg=none` JWTs are rejected even if their claims look valid. It guards against a classic JWT vulnerability class.

**Data flow**: Manually constructs a JWT string with `alg: none`, future `exp`, and no signature, calls `verify_signed_bearer_token`, and asserts an unauthorized error.

**Call relations**: Tests that `decode_jwt_claims` with `Algorithm::HS256` does not accept unsigned tokens.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 4 external calls (assert_eq!, format!, json!, to_vec).


##### `tests::signed_bearer_token_verification_rejects_missing_exp`  (lines 722–739)

```
fn signed_bearer_token_verification_rejects_missing_exp()
```

**Purpose**: Checks that JWTs lacking the `exp` claim are rejected. Because `exp` is required by the `JwtClaims` struct, decode should fail.

**Data flow**: Generates a signed token containing only `iss`, calls `verify_signed_bearer_token`, and asserts an unauthorized error.

**Call relations**: Exercises the typed-claims decoding requirement in `decode_jwt_claims`.

*Call graph*: calls 1 internal fn (verify_signed_bearer_token); 3 external calls (signed_token, assert_eq!, json!).


##### `tests::validate_signed_bearer_secret_rejects_short_secret`  (lines 742–750)

```
fn validate_signed_bearer_secret_rejects_short_secret()
```

**Purpose**: Verifies that shared secrets shorter than the minimum length are rejected with `InvalidInput`. It protects the startup validation rule.

**Data flow**: Calls `validate_signed_bearer_secret` with a short byte string and a sample path, captures the `io::Error`, and asserts its kind and message content.

**Call relations**: Directly tests the secret-length validator used by `policy_from_settings`.

*Call graph*: calls 1 internal fn (validate_signed_bearer_secret); 3 external calls (new, assert!, assert_eq!).


### `app-server-transport/src/transport/stdio.rs`

`io_transport` · `request handling for stdio-based app-server sessions`

This file provides the stdio transport entrypoint used when the app-server communicates over line-delimited JSON on standard input and output. `start_stdio_connection` allocates a new connection ID, creates an outbound `mpsc` channel for `QueuedOutgoingMessage`, and immediately emits `TransportEvent::ConnectionOpened` with `ConnectionOrigin::Stdio`. It then spawns two tasks.

The reader task wraps `stdin` in `BufReader`, reads one line at a time, and keeps a one-shot sender for the initialize client name. For each line it opportunistically calls `stdio_initialize_client_name`; on the first successful parse of an `initialize` request it sends `params.client_info.name` through the oneshot and never sends again. Every line is then passed to `forward_incoming_message`, which parses and forwards JSON-RPC input into the processor while sharing the writer channel for replies; if forwarding fails or stdin reaches EOF, the task emits `TransportEvent::ConnectionClosed` and exits. Read errors are logged.

The writer task receives queued outgoing messages, serializes each with `serialize_outgoing_message`, appends a newline, writes to stdout, and completes any optional write-completion oneshot. Serialization failures are silently skipped because `serialize_outgoing_message` returns `None`. A stdout write failure logs and terminates the task. The design assumes newline-delimited JSON-RPC framing and keeps reader/writer lifetimes independent except for the shared outbound channel.

#### Function details

##### `start_stdio_connection`  (lines 24–101)

```
async fn start_stdio_connection(
    transport_event_tx: mpsc::Sender<TransportEvent>,
    stdio_handles: &mut Vec<JoinHandle<()>>,
    initialize_client_name_tx: oneshot::Sender<String>,
) -> IoResul
```

**Purpose**: Starts a stdio-backed transport connection by registering it with the processor and spawning dedicated stdin reader and stdout writer tasks. It is the transport bootstrap for line-delimited JSON-RPC over standard streams.

**Data flow**: Takes the shared `transport_event_tx`, a mutable vector of join handles, and a oneshot sender for initialize client name. It allocates a connection ID and outbound writer channel, sends `TransportEvent::ConnectionOpened`, then spawns a reader task that reads stdin lines, optionally extracts and sends the initialize client name once, and forwards each line via `forward_incoming_message`; on exit it sends `TransportEvent::ConnectionClosed`. It also spawns a writer task that receives `QueuedOutgoingMessage`, serializes each message, appends `\n`, writes to stdout, and signals any `write_complete_tx`.

**Call relations**: Called by higher-level transport startup code when stdio transport is selected. Internally it delegates parsing of initialize metadata to `stdio_initialize_client_name` and message forwarding/serialization to shared transport helpers.

*Call graph*: calls 1 internal fn (stdio_initialize_client_name); 13 external calls (new, clone, send, take, debug!, error!, info!, stdin, stdout, forward_incoming_message (+3 more)).


##### `stdio_initialize_client_name`  (lines 103–113)

```
fn stdio_initialize_client_name(line: &str) -> Option<String>
```

**Purpose**: Extracts `InitializeParams.client_info.name` from a raw JSON-RPC line if that line is an `initialize` request. Non-request, non-initialize, or malformed input yields `None`.

**Data flow**: Parses the input line as `JSONRPCMessage`, pattern-matches for `JSONRPCMessage::Request(JSONRPCRequest { method, params, .. })`, rejects methods other than `"initialize"`, deserializes `params` into `InitializeParams`, and returns `Some(params.client_info.name)` on success.

**Call relations**: Used only by `start_stdio_connection` so the reader task can publish the client name as soon as the initialize request arrives.

*Call graph*: called by 1 (start_stdio_connection).


### `app-server-transport/src/transport/unix_socket.rs`

`io_transport` · `startup and local control-socket connection handling`

This file implements the local control socket transport on top of `codex_uds` and websocket framing. `start_control_socket_acceptor` first calls `prepare_control_socket_path` to create a private parent directory and reject or remove stale paths, then binds a `UnixListener`, wraps the path in `ControlSocketFileGuard`, applies private permissions (`0o600` on Unix), logs the listening path, and spawns the accept loop.

`run_control_socket_acceptor` waits on either shutdown or `listener.accept()`. Recoverable accept errors (`ConnectionAborted`, `ConnectionReset`, `Interrupted`) are logged and ignored; other errors trigger a one-second sleep before retry. Each accepted `UnixStream` is upgraded with `tokio_tungstenite::accept_async`; failed upgrades are warned and dropped. Successful upgrades are split and handed to the shared `run_websocket_connection`, so the Unix socket reuses the same JSON-RPC websocket framing and transport event machinery as TCP websocket listeners.

`prepare_control_socket_path` is careful about stale filesystem state. It probes the path by attempting `UnixStream::connect`: a successful connect means another server is already using the socket; `NotFound` means the path is free; `ConnectionRefused` or an existing stale socket path triggers further checks. If the path exists but is not a stale socket, it returns `AlreadyExists`; otherwise it removes the stale socket file.

The file also defines `acquire_app_server_startup_lock`, which uses `spawn_blocking` plus file locking to serialize concurrent startup attempts, and `ControlSocketFileGuard::drop`, which removes the socket file unless it is already gone.

#### Function details

##### `start_control_socket_acceptor`  (lines 24–44)

```
async fn start_control_socket_acceptor(
    socket_path: AbsolutePathBuf,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    shutdown_token: CancellationToken,
) -> IoResult<JoinHandle<()>>
```

**Purpose**: Prepares, binds, secures, and starts the Unix control socket acceptor task. It is the public bootstrap for local websocket control connections.

**Data flow**: Takes a socket path, transport event sender, and shutdown token; calls `prepare_control_socket_path`, binds a `UnixListener`, constructs `ControlSocketFileGuard`, applies permissions with `set_control_socket_permissions`, logs the listening path, and returns a spawned `JoinHandle<()>` running `run_control_socket_acceptor`.

**Call relations**: Called by transport startup code and tested directly in the Unix socket test module. It delegates path hygiene and runtime accept behavior to helpers in this file.

*Call graph*: calls 5 internal fn (prepare_control_socket_path, run_control_socket_acceptor, set_control_socket_permissions, bind, as_path); 2 external calls (info!, spawn).


##### `run_control_socket_acceptor`  (lines 46–91)

```
async fn run_control_socket_acceptor(
    mut listener: UnixListener,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    shutdown_token: CancellationToken,
    socket_guard: ControlSocketFileGu
```

**Purpose**: Accepts Unix-domain connections until shutdown, upgrades each to a websocket, and hands successful sessions to the shared websocket transport logic.

**Data flow**: Owns the `UnixListener`, cloned `transport_event_tx`, shutdown token, and socket guard. In a loop it selects between shutdown and `listener.accept()`, handling recoverable and non-recoverable accept errors differently. For each accepted stream it spawns a task that runs `accept_async`, splits the websocket stream on success, and calls `run_websocket_connection` with the split halves and transport sender.

**Call relations**: Spawned by `start_control_socket_acceptor`. It reuses `run_websocket_connection` from the generic websocket transport so Unix socket sessions behave like websocket sessions after upgrade.

*Call graph*: calls 1 internal fn (run_websocket_connection); called by 1 (start_control_socket_acceptor); 6 external calls (clone, info!, select!, spawn, accept_async, warn!).


##### `prepare_control_socket_path`  (lines 93–132)

```
async fn prepare_control_socket_path(socket_path: &Path) -> IoResult<()>
```

**Purpose**: Ensures the control socket path is safe to bind by creating its parent directory, detecting active listeners, and removing stale socket files when appropriate.

**Data flow**: Takes a filesystem `Path`, optionally prepares its parent directory with private permissions, then probes the path by attempting `UnixStream::connect`. A successful connect returns `AddrInUse`; `NotFound` returns success immediately; `ConnectionRefused` falls through to stale-path checks; other errors return success only if the path no longer exists. If the path still exists, it uses `codex_uds::is_stale_socket_path` to distinguish stale sockets from non-socket files and either removes the stale socket or returns `AlreadyExists`.

**Call relations**: Called by `start_control_socket_acceptor` before binding. Its decisions determine whether startup proceeds, fails fast because another server is active, or cleans up stale filesystem state.

*Call graph*: calls 1 internal fn (connect); called by 1 (start_control_socket_acceptor); 8 external calls (exists, parent, try_exists, new, is_stale_socket_path, prepare_private_socket_directory, format!, remove_file).


##### `acquire_app_server_startup_lock`  (lines 138–156)

```
async fn acquire_app_server_startup_lock(
    startup_lock_path: AbsolutePathBuf,
) -> IoResult<AppServerStartupLock>
```

**Purpose**: Acquires an exclusive filesystem lock used to serialize app-server startup attempts. It prevents concurrent processes from racing to create listeners and state.

**Data flow**: Takes an absolute lock-file path, prepares the parent directory if needed, then uses `tokio::task::spawn_blocking` to open/create the file with read/write access, call `file.lock()`, and wrap the locked file in `AppServerStartupLock`. Join failures are mapped into `std::io::Error::other`.

**Call relations**: Called by startup orchestration code and tested in the Unix socket test module to ensure waiters block until the first lock is dropped.

*Call graph*: calls 1 internal fn (as_path); 2 external calls (prepare_private_socket_directory, spawn_blocking).


##### `set_control_socket_permissions`  (lines 170–172)

```
async fn set_control_socket_permissions(_socket_path: &Path) -> IoResult<()>
```

**Purpose**: Applies private filesystem permissions to the bound control socket on Unix platforms. On non-Unix builds the alternate definition is a no-op.

**Data flow**: On Unix, converts `CONTROL_SOCKET_MODE` to `std::fs::Permissions` with `PermissionsExt::from_mode` and calls `tokio::fs::set_permissions(socket_path, ...)`, returning the async I/O result.

**Call relations**: Called by `start_control_socket_acceptor` immediately after binding so the socket file is private before clients connect.

*Call graph*: called by 1 (start_control_socket_acceptor); 2 external calls (from_mode, set_permissions).


##### `ControlSocketFileGuard::drop`  (lines 179–189)

```
fn drop(&mut self)
```

**Purpose**: Removes the control socket filesystem node when the acceptor shuts down or the guard is otherwise dropped. It prevents stale socket files from being left behind.

**Data flow**: On drop, calls `std::fs::remove_file` on `self.socket_path`; if removal fails for any reason other than `NotFound`, it logs a warning including the path and error.

**Call relations**: The guard is created in `start_control_socket_acceptor` and held for the lifetime of `run_control_socket_acceptor`, so cleanup happens automatically when the acceptor task exits.

*Call graph*: calls 1 internal fn (as_path); 2 external calls (remove_file, warn!).


### `app-server-transport/src/transport/websocket.rs`

`io_transport` · `listener startup and websocket request handling`

This file contains both listener setup and per-connection websocket framing logic. `start_websocket_acceptor` validates that non-loopback listeners are not started without authentication, binds a `TcpListener`, prints a colored startup banner with websocket and health URLs, builds an Axum router exposing `/readyz` and `/healthz`, rejects any request carrying an `Origin` header, and uses a fallback route to upgrade all other requests to websockets. `websocket_upgrade_handler` authorizes the upgrade using the configured `WebsocketAuthPolicy`; unauthorized clients receive an HTTP error response before upgrade.

Once a websocket is established, `run_websocket_connection` creates a new transport connection ID, allocates a large outbound queue for normal app-server messages plus a smaller control queue for direct websocket control frames, emits `TransportEvent::ConnectionOpened`, and spawns separate inbound and outbound tasks. The outbound loop serializes `QueuedOutgoingMessage` values to JSON text frames and also sends direct control frames such as pong replies. The inbound loop converts concrete Axum or tungstenite message types through the `AppServerWebSocketMessage` trait into a small internal enum, forwards text frames through `forward_incoming_message`, replies to ping frames by enqueueing a pong on the control queue, ignores pongs, drops binary frames with a warning, and terminates on close or receive errors.

The generic trait implementations for `AxumWebSocketMessage` and `TungsteniteWebSocketMessage` let the same connection logic serve both TCP listeners and Unix-socket websocket upgrades. The design keeps websocket framing concerns here while delegating JSON-RPC parsing and outgoing serialization to shared transport helpers.

#### Function details

##### `colorize`  (lines 51–54)

```
fn colorize(text: &str, style: Style) -> String
```

**Purpose**: Applies terminal styling to a string when stderr supports color. It is used only for the human-facing startup banner.

**Data flow**: Takes plain text and an `owo_colors::Style`, conditionally styles the text for `Stream::Stderr`, and returns the resulting `String`.

**Call relations**: Called by `print_websocket_startup_banner` to format labels and URLs.

*Call graph*: called by 1 (print_websocket_startup_banner).


##### `print_websocket_startup_banner`  (lines 57–77)

```
fn print_websocket_startup_banner(addr: SocketAddr)
```

**Purpose**: Prints a colored startup banner showing websocket, readyz, and healthz URLs plus a note about localhost binding or auth requirements.

**Data flow**: Takes the bound `SocketAddr`, formats and colorizes title/labels/URLs, writes several lines to stderr, and branches on `addr.ip().is_loopback()` to print either the SSH port-forwarding note or the auth-required note.

**Call relations**: Called by `start_websocket_acceptor` after binding so operators see the effective listener address and access guidance.

*Call graph*: calls 1 internal fn (colorize); called by 1 (start_websocket_acceptor); 4 external calls (ip, new, eprintln!, format!).


##### `health_check_handler`  (lines 85–87)

```
async fn health_check_handler() -> StatusCode
```

**Purpose**: Returns HTTP 200 for readiness and health endpoints.

**Data flow**: Takes no arguments and returns `StatusCode::OK`.

**Call relations**: Registered by `start_websocket_acceptor` for both `/readyz` and `/healthz` routes.


##### `reject_requests_with_origin_header`  (lines 89–103)

```
async fn reject_requests_with_origin_header(
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode>
```

**Purpose**: Rejects requests that include an `Origin` header, preventing browser-originated websocket requests from being accepted by this listener.

**Data flow**: Inspects the incoming `Request<Body>` headers; if `ORIGIN` is present it logs a warning with method and URI and returns `Err(StatusCode::FORBIDDEN)`, otherwise it forwards the request to the next middleware/handler and returns its `Response`.

**Call relations**: Installed as Axum middleware by `start_websocket_acceptor` so it runs before upgrade handling.

*Call graph*: 3 external calls (run, headers, warn!).


##### `websocket_upgrade_handler`  (lines 105–127)

```
async fn websocket_upgrade_handler(
    websocket: WebSocketUpgrade,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    State(state): State<WebSocketListenerState>,
    headers: HeaderMap,
) ->
```

**Purpose**: Authorizes a websocket upgrade request and, on success, upgrades it into a live app-server websocket connection.

**Data flow**: Receives `WebSocketUpgrade`, peer `SocketAddr`, shared `WebSocketListenerState`, and request headers. It calls `authorize_upgrade`; on failure it logs and returns an HTTP error response. On success it logs the peer address and returns an upgrade response whose callback splits the websocket stream and calls `run_websocket_connection` with the shared transport sender.

**Call relations**: Registered as the router fallback by `start_websocket_acceptor`, so all non-health requests flow through it after origin rejection.

*Call graph*: calls 1 internal fn (authorize_upgrade); 3 external calls (on_upgrade, info!, warn!).


##### `start_websocket_acceptor`  (lines 129–170)

```
async fn start_websocket_acceptor(
    bind_address: SocketAddr,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    shutdown_token: CancellationToken,
    auth_policy: WebsocketAuthPolicy,
) ->
```

**Purpose**: Starts the TCP websocket listener with health endpoints, origin rejection, upgrade authorization, and graceful shutdown. It is the public bootstrap for network websocket transport.

**Data flow**: Takes bind address, transport event sender, shutdown token, and auth policy; rejects invalid non-loopback unauthenticated configurations, binds a `TcpListener`, obtains the actual local address, prints the startup banner, logs the listener URL, builds an Axum `Router` with health routes, fallback upgrade handler, origin-rejection middleware, and shared state, then serves it with graceful shutdown tied to `shutdown_token.cancelled()`. It returns a spawned `JoinHandle<()>` that logs server errors and shutdown.

**Call relations**: Called by transport startup/orchestration code when websocket transport is enabled. It delegates per-request upgrade handling to `websocket_upgrade_handler`.

*Call graph*: calls 2 internal fn (is_unauthenticated_non_loopback_listener, print_websocket_startup_banner); 13 external calls (new, cancelled, new, bind, any, get, serve, new, error!, format! (+3 more)).


##### `run_websocket_connection`  (lines 172–229)

```
async fn run_websocket_connection(
    websocket_writer: impl futures::sink::Sink<M, Error = SinkError> + Send + 'static,
    websocket_reader: impl futures::stream::Stream<Item = Result<M, StreamErro
```

**Purpose**: Runs one websocket-backed transport connection by registering it with the processor and spawning coordinated inbound and outbound loops. It is generic over Axum and tungstenite websocket message types.

**Data flow**: Allocates a new connection ID, creates a large outbound queue for `QueuedOutgoingMessage`, clones it for the reader, creates a disconnect `CancellationToken`, sends `TransportEvent::ConnectionOpened` with `ConnectionOrigin::WebSocket` and a disconnect sender, creates a smaller control queue for direct websocket frames, spawns `run_websocket_outbound_loop` and `run_websocket_inbound_loop`, waits for either task to finish, cancels the disconnect token, aborts the other task, and finally sends `TransportEvent::ConnectionClosed`.

**Call relations**: Called from both `websocket_upgrade_handler` for TCP listeners and `run_control_socket_acceptor` for Unix-socket websocket upgrades, making it the shared per-connection engine.

*Call graph*: calls 2 internal fn (run_websocket_inbound_loop, run_websocket_outbound_loop); called by 1 (run_control_socket_acceptor); 6 external calls (new, clone, send, next_connection_id, select!, spawn).


##### `AxumWebSocketMessage::text`  (lines 249–251)

```
fn text(text: String) -> Self
```

**Purpose**: Constructs an Axum websocket text frame from a JSON string.

**Data flow**: Takes a `String` and returns `AxumWebSocketMessage::Text(text.into())`.

**Call relations**: Used by the generic outbound loop through the `AppServerWebSocketMessage` trait.

*Call graph*: 1 external calls (Text).


##### `AxumWebSocketMessage::pong`  (lines 253–255)

```
fn pong(payload: Bytes) -> Self
```

**Purpose**: Constructs an Axum websocket pong frame carrying the supplied payload.

**Data flow**: Takes `Bytes` and returns `AxumWebSocketMessage::Pong(payload)`.

**Call relations**: Used by the generic inbound loop when replying to ping frames on Axum-backed connections.

*Call graph*: 1 external calls (Pong).


##### `AxumWebSocketMessage::into_incoming`  (lines 257–265)

```
fn into_incoming(self) -> Option<IncomingWebSocketMessage>
```

**Purpose**: Maps Axum websocket frames into the transport's reduced `IncomingWebSocketMessage` enum.

**Data flow**: Consumes an `AxumWebSocketMessage` and returns `Some(...)` for text, binary, ping, pong, and close variants, converting text payloads to owned `String`s.

**Call relations**: Called by `run_websocket_inbound_loop` so the generic loop can process Axum websocket streams without depending on Axum-specific variants.

*Call graph*: 2 external calls (Ping, Text).


##### `TungsteniteWebSocketMessage::text`  (lines 269–271)

```
fn text(text: String) -> Self
```

**Purpose**: Constructs a tungstenite websocket text frame from a JSON string.

**Data flow**: Takes a `String` and returns `TungsteniteWebSocketMessage::Text(text.into())`.

**Call relations**: Used by the generic outbound loop for tungstenite-backed connections such as Unix-socket upgrades.

*Call graph*: 1 external calls (Text).


##### `TungsteniteWebSocketMessage::pong`  (lines 273–275)

```
fn pong(payload: Bytes) -> Self
```

**Purpose**: Constructs a tungstenite websocket pong frame carrying the supplied payload.

**Data flow**: Takes `Bytes` and returns `TungsteniteWebSocketMessage::Pong(payload)`.

**Call relations**: Used by the generic inbound loop when replying to ping frames on tungstenite-backed connections.

*Call graph*: 1 external calls (Pong).


##### `TungsteniteWebSocketMessage::into_incoming`  (lines 277–286)

```
fn into_incoming(self) -> Option<IncomingWebSocketMessage>
```

**Purpose**: Maps tungstenite websocket frames into the reduced internal message enum, ignoring raw frame variants unsupported by the transport layer.

**Data flow**: Consumes a `TungsteniteWebSocketMessage` and returns `Some(...)` for text, binary, ping, pong, and close variants, but returns `None` for `Frame(_)` so the generic loop ignores it.

**Call relations**: Called by `run_websocket_inbound_loop` for tungstenite-backed websocket streams.

*Call graph*: 2 external calls (Ping, Text).


##### `run_websocket_outbound_loop`  (lines 289–328)

```
async fn run_websocket_outbound_loop(
    websocket_writer: impl futures::sink::Sink<M, Error = SinkError> + Send + 'static,
    mut writer_rx: mpsc::Receiver<QueuedOutgoingMessage>,
    mut writer_co
```

**Purpose**: Sends queued app-server messages and direct control frames to the websocket until disconnect or channel closure. It is the writer half of a websocket transport connection.

**Data flow**: Pins the websocket sink and loops selecting over disconnect cancellation, `writer_control_rx.recv()`, and `writer_rx.recv()`. Control messages are sent directly; queued app-server messages are serialized with `serialize_outgoing_message`, wrapped as `M::text(json)`, sent on the websocket, and any `write_complete_tx` is fulfilled. Any send failure or closed channel breaks the loop.

**Call relations**: Spawned by `run_websocket_connection`; it works in tandem with the inbound loop, which may enqueue pong control frames.

*Call graph*: called by 1 (run_websocket_connection); 2 external calls (pin!, select!).


##### `run_websocket_inbound_loop`  (lines 330–388)

```
async fn run_websocket_inbound_loop(
    websocket_reader: impl futures::stream::Stream<Item = Result<M, StreamError>> + Send + 'static,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    write
```

**Purpose**: Reads websocket frames, forwards JSON-RPC text messages into the processor, replies to pings, and terminates on close or receive errors. It is the reader half of a websocket transport connection.

**Data flow**: Pins the websocket stream and loops selecting over disconnect cancellation and `websocket_reader.next()`. For each successful frame it converts via `into_incoming()`: text frames are passed to `forward_incoming_message` and may terminate the loop if forwarding returns false; ping frames are answered by `writer_control_tx.try_send(M::pong(payload))`, with a full control queue causing connection closure; pongs are ignored; close frames break; binary frames log a warning; stream end or receive errors also break.

**Call relations**: Spawned by `run_websocket_connection`. It depends on the outbound loop's control queue to send pong replies without mixing them into normal app-server message ordering.

*Call graph*: called by 1 (run_websocket_connection); 2 external calls (pin!, select!).


### Remote-control transport subsystem
These files implement remote-control desired state, enrollment persistence and HTTP pairing, multiplexed client tracking, and the reconnecting websocket loop.

### `app-server-transport/src/transport/remote_control/mod.rs`

`orchestration` · `startup, runtime control RPCs, pairing operations, and cross-task coordination`

This module is the control-plane hub for remote control. It defines startup configuration (`RemoteControlStartConfig`, `RemoteControlPolicy`, `RemoteControlStartupMode`), the public `RemoteControlHandle`, and the shared state objects that coordinate RPC calls with the background websocket task. The handle keeps two watch channels: `desired_state_tx` for requested enablement and `status_tx` for externally visible connection status. It also carries two semaphores: `desired_state_rpc_lock` serializes user-visible enable/disable/resolve transitions, while `desired_state_persistence_lock` serializes writes that affect persisted enrollment/preference rows.

Enrollment state is wrapped in `RemoteControlEnrollmentState`, which combines a `StdMutex<Option<RemoteControlEnrollment>>` with an async semaphore. Its lease type snapshots the current enrollment, allows mutation while holding the permit, and writes the final value back on `Drop`; this prevents pairing and websocket-connect paths from selecting different servers concurrently.

The handle exposes policy checks, ephemeral and durable enable/disable, pairing start/status, and client-management RPCs. Durable disable persists `remote_control_enabled = false`; ephemeral disable only changes runtime state. Pairing flows are careful: they require desired state to be enabled, derive a persistence key when stdio mode needs one, reuse current or persisted enrollment when possible, refresh tokens before use, recover auth on 401s, reenroll on explicit missing-server conditions, and reject results if the authenticated account changes mid-flight.

`start_remote_control` computes the initial desired state from policy, startup mode, and sqlite availability. It intentionally skips URL normalization when startup is effectively disabled, allowing invalid URLs to exist harmlessly in disabled configurations. When enabled, it precomputes the normalized target, initializes watch channels and shared enrollment state, spawns the `RemoteControlWebsocket` task, wraps it in panic logging, and returns both the join handle and a `RemoteControlHandle` for RPC/control use.

#### Function details

##### `take_remote_control_disabled_env`  (lines 89–95)

```
fn take_remote_control_disabled_env() -> bool
```

**Purpose**: Reads the daemon’s internal environment-variable marker for forced remote-control disablement and removes it immediately.

**Data flow**: Checks `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED` via `std::env::var_os`, compares it to `"1"`, then unsafely removes the variable and returns the resulting boolean.

**Call relations**: Used during process startup before worker threads exist so the daemon can convert a one-shot environment marker into an in-memory startup decision.

*Call graph*: 2 external calls (remove_var, var_os).


##### `RemoteControlEnrollmentState::new`  (lines 136–141)

```
fn new(enrollment: Option<RemoteControlEnrollment>) -> Self
```

**Purpose**: Constructs the shared enrollment holder used by pairing and websocket connection logic.

**Data flow**: Takes an initial `Option<RemoteControlEnrollment>`, stores it behind a `StdMutex`, creates a semaphore with one permit, and returns the assembled state object.

**Call relations**: Created at subsystem startup and in tests to provide a single selected enrollment that multiple async paths can coordinate around.

*Call graph*: called by 5 (start_remote_control, client_management_handle, plain_start_resolves_persisted_remote_control_preference, remote_control_handle_with_current_enrollment, test_current_enrollment); 2 external calls (new, new).


##### `RemoteControlEnrollmentState::lock`  (lines 143–153)

```
async fn lock(&self) -> RemoteControlEnrollmentLease<'_>
```

**Purpose**: Acquires exclusive async access to the current enrollment and returns a lease that snapshots and later writes back the value.

**Data flow**: Awaits the internal semaphore, panicking if it is ever closed, snapshots the current enrollment via `snapshot()`, and returns `RemoteControlEnrollmentLease { state, enrollment, _permit }`.

**Call relations**: Used by pairing and websocket code whenever they need to mutate or replace the selected enrollment without racing each other.

*Call graph*: calls 1 internal fn (snapshot); 2 external calls (acquire, unreachable!).


##### `RemoteControlEnrollmentState::snapshot`  (lines 155–160)

```
fn snapshot(&self) -> Option<RemoteControlEnrollment>
```

**Purpose**: Clones the current enrollment value out of the mutex-protected shared state.

**Data flow**: Locks the internal `StdMutex<Option<RemoteControlEnrollment>>`, recovering from poisoning by taking the inner value, clones the option, and returns it.

**Call relations**: Called by `lock()` to seed the lease with the latest enrollment state.

*Call graph*: called by 1 (lock); 1 external calls (lock).


##### `RemoteControlEnrollmentLease::deref`  (lines 172–174)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Exposes the lease’s local `Option<RemoteControlEnrollment>` snapshot as an immutable reference.

**Data flow**: Returns `&self.enrollment` with no mutation or side effects.

**Call relations**: Lets callers treat the lease like `&Option<RemoteControlEnrollment>` while holding the semaphore permit.


##### `RemoteControlEnrollmentLease::deref_mut`  (lines 178–180)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: Exposes the lease’s local enrollment snapshot as a mutable reference for in-place edits.

**Data flow**: Returns `&mut self.enrollment` so callers can replace or mutate the selected enrollment before drop writes it back.

**Call relations**: Supports pairing and refresh flows that need to update the current enrollment under exclusive access.


##### `RemoteControlEnrollmentLease::drop`  (lines 184–190)

```
fn drop(&mut self)
```

**Purpose**: Commits the lease’s final enrollment value back into shared state when the lease goes out of scope.

**Data flow**: Locks the parent state’s mutex, recovers from poisoning if needed, replaces the stored enrollment with `self.enrollment.take()`, and then releases the semaphore permit as the struct drops.

**Call relations**: This is the write-back mechanism that makes the lease pattern work; callers do not manually commit changes.


##### `RemoteControlUnavailable::fmt`  (lines 197–202)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the error explaining that remote control cannot be enabled because sqlite state is unavailable.

**Data flow**: Writes a fixed human-readable message into the provided formatter.

**Call relations**: Used when converting missing-state-db conditions into user-facing errors.

*Call graph*: 1 external calls (write!).


##### `RemoteControlDisabledByRequirements::fmt`  (lines 211–213)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the error explaining that managed requirements prohibit remote control.

**Data flow**: Writes a fixed message into the formatter.

**Call relations**: Surfaced by policy checks and wrapped by higher-level enable/disable APIs.

*Call graph*: 1 external calls (write!).


##### `RemoteControlEnableError::fmt`  (lines 225–230)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Delegates formatting of enable failures to the wrapped unavailable or managed-disable error.

**Data flow**: Matches `self` and forwards formatting to the contained error type.

**Call relations**: Provides a single display surface for `enable_ephemeral` and internal enable transitions.


##### `RemoteControlHandle::ensure_remote_control_allowed`  (lines 236–241)

```
fn ensure_remote_control_allowed(&self) -> Result<(), RemoteControlDisabledByRequirements>
```

**Purpose**: Checks the configured policy and rejects operations when remote control is disabled by requirements.

**Data flow**: Reads `self.policy` and returns `Ok(())` for `Allowed` or `Err(RemoteControlDisabledByRequirements)` for `DisabledByRequirements`.

**Call relations**: This is the base policy gate used by enable, disable, pairing, and client-management entry points.

*Call graph*: called by 2 (enable_with_preference, ensure_remote_control_allowed_io).


##### `RemoteControlHandle::ensure_remote_control_allowed_io`  (lines 243–246)

```
fn ensure_remote_control_allowed_io(&self) -> io::Result<()>
```

**Purpose**: Converts the policy gate into an `io::Result` suitable for RPC-facing methods.

**Data flow**: Calls `ensure_remote_control_allowed` and maps any error to `io::ErrorKind::PermissionDenied`.

**Call relations**: Used by methods that already return `io::Result`, such as durable disable, pairing, and client-management RPCs.

*Call graph*: calls 1 internal fn (ensure_remote_control_allowed); called by 5 (disable, list_clients, pairing_status, revoke_client, start_pairing).


##### `RemoteControlHandle::enable_ephemeral`  (lines 248–252)

```
fn enable_ephemeral(
        &self,
    ) -> Result<RemoteControlStatusChangedNotification, RemoteControlEnableError>
```

**Purpose**: Requests runtime-only enablement without writing a durable preference row.

**Data flow**: Calls `enable_with_preference(None)` and returns its `RemoteControlStatusChangedNotification` or `RemoteControlEnableError`.

**Call relations**: Public convenience API for temporary enablement; it shares the same state-transition logic as durable enable but skips persistence.

*Call graph*: calls 1 internal fn (enable_with_preference).


##### `RemoteControlHandle::enable_with_preference`  (lines 254–305)

```
fn enable_with_preference(
        &self,
        persistence_preference: Option<bool>,
    ) -> Result<RemoteControlStatusChangedNotification, RemoteControlEnableError>
```

**Purpose**: Transitions desired state to enabled, preserving an existing durable preference when an ephemeral enable arrives over a durable-enabled state.

**Data flow**: Checks policy and state-db availability, warning and returning `Unavailable` if sqlite is absent. It then mutates `desired_state_tx` with `send_if_modified`, upgrading `persistence_preference` from `None` to `Some(true)` if the previous state was already durably enabled, computes whether the state changed, reads current status via `status()`, logs the request, and returns either the existing status if already `Connected`/`Connecting` or a newly published `Connecting` status via `publish_status`.

**Call relations**: Called by `enable_ephemeral` and by durable enable logic in `desired_state.rs`. It is the common runtime state transition beneath both APIs.

*Call graph*: calls 3 internal fn (ensure_remote_control_allowed, publish_status, status); called by 1 (enable_ephemeral); 4 external calls (Unavailable, info!, matches!, warn!).


##### `RemoteControlHandle::disable`  (lines 307–324)

```
async fn disable(
        &self,
        app_server_client_name: Option<&str>,
    ) -> io::Result<RemoteControlStatusChangedNotification>
```

**Purpose**: Performs a durable disable: persists `remote_control_enabled = false` for the current account/scope and transitions runtime state to disabled.

**Data flow**: Checks policy, acquires `desired_state_rpc_lock`, acquires the persistence semaphore via `acquire_persistence_lock`, calls `persist_preference(..., false)`, then calls `transition_disabled()` and returns the resulting status notification.

**Call relations**: This is the RPC-facing durable disable path. It serializes against concurrent enable/resolve operations and ensures persistence is updated before runtime state flips.

*Call graph*: calls 4 internal fn (ensure_remote_control_allowed_io, persist_preference, transition_disabled, acquire_persistence_lock).


##### `RemoteControlHandle::disable_ephemeral`  (lines 326–334)

```
async fn disable_ephemeral(&self) -> RemoteControlStatusChangedNotification
```

**Purpose**: Disables remote control only for the current runtime session without writing a durable preference.

**Data flow**: Acquires `desired_state_rpc_lock`, then the persistence semaphore, and calls `transition_disabled()`; it does not touch sqlite.

**Call relations**: Used when the system needs to stop remote control immediately but should not alter persisted preference.

*Call graph*: calls 2 internal fn (transition_disabled, acquire_persistence_lock).


##### `RemoteControlHandle::transition_disabled`  (lines 336–352)

```
fn transition_disabled(&self) -> RemoteControlStatusChangedNotification
```

**Purpose**: Updates desired state and externally visible status to the disabled state.

**Data flow**: Mutates `desired_state_tx` to `RemoteControlDesiredState::Disabled`, records whether the state changed, reads current status, logs the disable request, and publishes `RemoteControlConnectionStatus::Disabled` through `publish_status`, which also clears `environment_id`.

**Call relations**: Shared terminal step for both durable and ephemeral disable paths.

*Call graph*: calls 2 internal fn (publish_status, status); called by 2 (disable, disable_ephemeral); 1 external calls (info!).


##### `RemoteControlHandle::persist_preference`  (lines 354–376)

```
async fn persist_preference(
        &self,
        app_server_client_name: Option<&str>,
        remote_control_enabled: bool,
    ) -> io::Result<()>
```

**Purpose**: Writes the durable enabled/disabled preference bit for the current account and optional client-name scope into sqlite.

**Data flow**: Requires `state_db`, loads auth from `auth_manager`, normalizes `remote_control_url`, derives the pairing persistence key from `app_server_client_name`, and calls `state_db.set_remote_control_enabled(...)` with the normalized websocket URL, account id, scoped client name, and requested boolean.

**Call relations**: Called by durable disable; durable enable uses a more elaborate path because it may need to create the enrollment row first.

*Call graph*: calls 3 internal fn (pairing_persistence_key, load_remote_control_auth, normalize_remote_control_url); called by 1 (disable).


##### `RemoteControlHandle::status`  (lines 378–380)

```
fn status(&self) -> RemoteControlStatusChangedNotification
```

**Purpose**: Returns the latest published remote-control status snapshot.

**Data flow**: Clones the current value from `status_tx.borrow()` and returns it.

**Call relations**: Used throughout the handle to inspect current connection state and to return status from transition methods.

*Call graph*: called by 5 (enable_with_preference, pairing_status, publish_status, start_pairing, transition_disabled).


##### `RemoteControlHandle::status_receiver`  (lines 382–384)

```
fn status_receiver(&self) -> watch::Receiver<RemoteControlStatusChangedNotification>
```

**Purpose**: Creates a watch receiver subscribed to future remote-control status changes.

**Data flow**: Calls `status_tx.subscribe()` and returns the new `watch::Receiver`.

**Call relations**: Used by callers and tests that need to observe connection-state transitions over time.


##### `RemoteControlHandle::start_pairing`  (lines 386–502)

```
async fn start_pairing(
        &self,
        params: RemoteControlPairingStartParams,
        app_server_client_name: Option<&str>,
    ) -> io::Result<RemoteControlPairingStartResponse>
```

**Purpose**: Starts a pairing flow against the currently selected or newly enrolled backend server, with token refresh and reenrollment recovery.

**Data flow**: Checks policy and that desired state is enabled; otherwise returns `pairing_disabled_error`. It loads auth, reads current status for installation/server name, derives the persistence key, locks `current_enrollment`, and obtains an enrollment via `load_or_enroll_pairing_server(ReuseOrCreate)`. If the token should refresh, it calls `refresh_pairing_enrollment`, reenrolling on `NotFound`. It then sends `StartRemoteControlPairingRequest { manual_code }` through `enrollment.start_pairing()`, retrying after `PermissionDenied` by clearing the token and refreshing, or after `NotFound` by replacing the enrollment. If the final result is still `NotFound` or `PermissionDenied`, it updates local enrollment state appropriately and returns `pairing_unavailable_error`. Before returning success it reloads auth to ensure the account id did not change and rechecks that desired state is still enabled.

**Call relations**: This is the top-level pairing-start RPC. It orchestrates enrollment reuse/creation, token lifecycle, auth recovery, and state validation around the lower-level HTTP pairing call.

*Call graph*: calls 8 internal fn (ensure_remote_control_allowed_io, load_or_enroll_pairing_server, pairing_persistence_key, status, load_remote_control_auth, clear_pairing_server_token, pairing_unavailable_error, refresh_pairing_enrollment); 2 external calls (lock, pairing_disabled_error).


##### `RemoteControlHandle::load_or_enroll_pairing_server`  (lines 504–552)

```
async fn load_or_enroll_pairing_server(
        &self,
        current_enrollment: &mut Option<RemoteControlEnrollment>,
        auth: &mut auth::RemoteControlConnectionAuth,
        installation_id:
```

**Purpose**: Obtains an enrollment for pairing and persists it when a new server had to be created.

**Data flow**: Calls `load_or_enroll_server` to get `(enrollment, created)`. If reused, it publishes the enrollment into shared state and returns it. If newly created, it requires `state_db`, acquires the persistence semaphore, reads the current desired state to extract `persistence_preference` (failing with pairing-disabled if state is no longer enabled), persists the enrollment row via `update_persisted_remote_control_enrollment`, publishes the enrollment into shared state, and returns it.

**Call relations**: Used by both pairing start and pairing status. It is the pairing-specific wrapper that adds persistence semantics on top of generic enrollment selection.

*Call graph*: calls 4 internal fn (load_or_enroll_server, acquire_persistence_lock, update_persisted_remote_control_enrollment, publish_current_enrollment); called by 2 (pairing_status, start_pairing); 1 external calls (pairing_disabled_error).


##### `RemoteControlHandle::load_or_enroll_server`  (lines 554–602)

```
async fn load_or_enroll_server(
        &self,
        current_enrollment: &Option<RemoteControlEnrollment>,
        auth: &mut auth::RemoteControlConnectionAuth,
        installation_id: &str,
```

**Purpose**: Selects an enrollment by reusing the current in-memory one, loading a persisted one, or enrolling a new backend server.

**Data flow**: Normalizes `remote_control_url`, then branches on `selection`. In `ReuseOrCreate`, it first returns the current in-memory enrollment if its `account_id` matches auth; otherwise it requires `state_db` and tries `load_persisted_remote_control_enrollment`, updating `server_name` before reuse. If no reusable enrollment exists or `ReplaceExisting` was requested, it calls `enroll_pairing_server` and returns the new enrollment with `created = true`.

**Call relations**: This is the core enrollment-selection routine beneath pairing and durable enable. Higher-level callers decide whether stale state may be reused or must be replaced.

*Call graph*: calls 3 internal fn (load_persisted_remote_control_enrollment, enroll_pairing_server, normalize_remote_control_url); called by 1 (load_or_enroll_pairing_server).


##### `RemoteControlHandle::pairing_persistence_key`  (lines 604–616)

```
fn pairing_persistence_key(
        &self,
        app_server_client_name: Option<&str>,
    ) -> io::Result<Option<String>>
```

**Purpose**: Resolves and caches the optional client-name key used to scope persisted enrollment/preference rows in stdio mode.

**Data flow**: Reads `pairing_persistence_key_required` and the watch sender’s current value. If a key is required and none is cached, it requires `app_server_client_name`, stores it with `send_replace`, and then returns the cached `Option<String>` clone.

**Call relations**: Called before persistence-sensitive operations so stdio-mode remote control waits until the app-server client name is known and then consistently reuses that scope.

*Call graph*: called by 2 (persist_preference, start_pairing); 2 external calls (borrow, send_replace).


##### `RemoteControlHandle::pairing_status`  (lines 618–716)

```
async fn pairing_status(
        &self,
        params: RemoteControlPairingStatusParams,
    ) -> io::Result<RemoteControlPairingStatusResponse>
```

**Purpose**: Checks whether a pairing code has been claimed, with token refresh and stale-enrollment recovery similar to pairing start.

**Data flow**: Checks policy and enabled desired state, loads auth, reads the cached persistence key, locks `current_enrollment`, and requires an in-memory enrollment for the same account. It reads status for installation/server name, refreshes the token if needed via `refresh_pairing_enrollment` (reenrolling on `NotFound` and then returning pairing-unavailable), converts params into a `RemoteControlPairingStatusCode` with `remote_control_pairing_status_code`, and calls `enrollment.pairing_status(...)`. On `PermissionDenied` it clears the token, refreshes, and retries once. On final `NotFound` or `PermissionDenied` it updates enrollment state and returns pairing-unavailable. Before returning success it rechecks desired state and verifies auth account id stability.

**Call relations**: This is the polling counterpart to `start_pairing`, sharing the same enrollment/token/auth orchestration but targeting the status endpoint.

*Call graph*: calls 8 internal fn (ensure_remote_control_allowed_io, load_or_enroll_pairing_server, status, load_remote_control_auth, clear_pairing_server_token, pairing_unavailable_error, refresh_pairing_enrollment, remote_control_pairing_status_code); 3 external calls (lock, borrow, pairing_disabled_error).


##### `RemoteControlHandle::list_clients`  (lines 718–725)

```
async fn list_clients(
        &self,
        params: RemoteControlClientsListParams,
    ) -> io::Result<RemoteControlClientsListResponse>
```

**Purpose**: Lists remote-control clients for an environment through the backend management API, even if the websocket transport itself is disabled.

**Data flow**: Checks policy with `ensure_remote_control_allowed_io`, then forwards `remote_control_url`, `auth_manager`, and the request params to `clients::list_remote_control_clients` and returns its response.

**Call relations**: Public management RPC entry point; unlike pairing, it does not depend on desired-state enablement or current enrollment.

*Call graph*: calls 2 internal fn (ensure_remote_control_allowed_io, list_remote_control_clients).


##### `RemoteControlHandle::revoke_client`  (lines 727–734)

```
async fn revoke_client(
        &self,
        params: RemoteControlClientsRevokeParams,
    ) -> io::Result<RemoteControlClientsRevokeResponse>
```

**Purpose**: Revokes a remote-control client through the backend management API.

**Data flow**: Checks policy and delegates `remote_control_url`, `auth_manager`, and revoke params to `clients::revoke_remote_control_client`, returning the backend result.

**Call relations**: Companion management RPC to `list_clients`, also independent of websocket desired state.

*Call graph*: calls 2 internal fn (ensure_remote_control_allowed_io, revoke_remote_control_client).


##### `RemoteControlHandle::pairing_disabled_error`  (lines 736–741)

```
fn pairing_disabled_error() -> io::Error
```

**Purpose**: Constructs the standardized error returned when pairing is attempted while remote control is not enabled.

**Data flow**: Creates and returns an `io::Error` with kind `InvalidInput` and a fixed message.

**Call relations**: Used throughout pairing orchestration whenever desired state is disabled or becomes disabled mid-flow.

*Call graph*: 1 external calls (new).


##### `RemoteControlHandle::publish_status`  (lines 743–771)

```
fn publish_status(
        &self,
        connection_status: RemoteControlConnectionStatus,
    ) -> RemoteControlStatusChangedNotification
```

**Purpose**: Applies a new connection-status enum to the status watch channel while preserving server metadata and logging transitions.

**Data flow**: Takes a target `RemoteControlConnectionStatus`, mutates `status_tx` with `send_if_modified`, computes the next snapshot via `remote_control_status_with_connection_status`, records previous/next snapshots when changed, logs the transition, and returns the current status via `status()`.

**Call relations**: Used by enable/disable transitions and by the websocket task’s status publisher to keep observers synchronized on connection state.

*Call graph*: calls 1 internal fn (status); called by 2 (enable_with_preference, transition_disabled); 1 external calls (info!).


##### `enroll_pairing_server`  (lines 774–798)

```
async fn enroll_pairing_server(
    auth_manager: &Arc<AuthManager>,
    auth: &mut auth::RemoteControlConnectionAuth,
    remote_control_target: &protocol::RemoteControlTarget,
    installation_id: &
```

**Purpose**: Enrolls a new backend server, retrying once after auth recovery if the first attempt is unauthorized.

**Data flow**: Calls `enroll_remote_control_server`. On success it returns the enrollment immediately. On `PermissionDenied`, it starts unauthorized recovery through `auth_manager`, waits for auth recovery/change, reloads auth with `load_remote_control_auth`, updates the mutable auth argument, and retries enrollment once. Other errors are returned unchanged.

**Call relations**: Called only from `load_or_enroll_server` when a new enrollment is required. It encapsulates the auth-recovery retry policy for enrollment.

*Call graph*: calls 3 internal fn (load_remote_control_auth, recover_remote_control_auth, enroll_remote_control_server); called by 1 (load_or_enroll_server).


##### `remote_control_pairing_status_code`  (lines 800–819)

```
fn remote_control_pairing_status_code(
    params: &RemoteControlPairingStatusParams,
) -> io::Result<RemoteControlPairingStatusCode>
```

**Purpose**: Validates pairing-status parameters and converts them into the internal enum representing exactly one code type.

**Data flow**: Reads `RemoteControlPairingStatusParams`, returning `PairingCode` when only `pairing_code` is present, `ManualPairingCode` when only `manual_pairing_code` is present, or an `InvalidInput` error when both or neither are supplied.

**Call relations**: Used by `RemoteControlHandle::pairing_status` before constructing the backend request body.

*Call graph*: called by 1 (pairing_status); 3 external calls (ManualPairingCode, PairingCode, new).


##### `refresh_pairing_enrollment`  (lines 821–850)

```
async fn refresh_pairing_enrollment(
    current_enrollment: &mut Option<RemoteControlEnrollment>,
    auth_manager: &Arc<AuthManager>,
    auth: &mut auth::RemoteControlConnectionAuth,
    installati
```

**Purpose**: Refreshes an enrollment’s bearer token with auth recovery on unauthorized and commits the refreshed enrollment back into shared state only if it still matches the selected server.

**Data flow**: Calls `refresh_remote_control_server(auth, installation_id, enrollment)`. On non-permission errors it returns immediately. On `PermissionDenied`, it performs auth recovery, reloads auth, rejects the refresh if the recovered account id differs from `enrollment.account_id`, and retries refresh. After a successful refresh it calls `replace_current_enrollment`; if the current shared enrollment no longer matches, it returns `pairing_unavailable_error` instead of overwriting a newer selection.

**Call relations**: Used by both pairing start and pairing status whenever the token is stale or invalid. It protects against races where another path has already replaced the selected enrollment.

*Call graph*: calls 5 internal fn (load_remote_control_auth, recover_remote_control_auth, refresh_remote_control_server, pairing_unavailable_error, replace_current_enrollment); called by 2 (pairing_status, start_pairing).


##### `clear_pairing_server_token`  (lines 852–862)

```
fn clear_pairing_server_token(
    current_enrollment: &mut Option<RemoteControlEnrollment>,
    enrollment: &mut RemoteControlEnrollment,
) -> io::Result<()>
```

**Purpose**: Invalidates the current enrollment’s bearer token and writes that invalidation back only if the enrollment is still the selected one.

**Data flow**: Mutably clears the token fields on `enrollment` via `clear_server_token`, then calls `replace_current_enrollment`; returns `Ok(())` on success or `pairing_unavailable_error` if the shared selection changed underneath it.

**Call relations**: Called after pairing permission failures so subsequent logic can refresh from a known tokenless state without clobbering a newer enrollment.

*Call graph*: calls 3 internal fn (clear_server_token, pairing_unavailable_error, replace_current_enrollment); called by 2 (pairing_status, start_pairing).


##### `pairing_unavailable_error`  (lines 864–869)

```
fn pairing_unavailable_error() -> io::Error
```

**Purpose**: Constructs the standardized error used when pairing cannot proceed because enrollment/token state is not ready.

**Data flow**: Returns an `io::Error` with kind `InvalidInput` and a fixed message.

**Call relations**: Shared fallback error across pairing orchestration, especially after stale-enrollment or token-invalidity conditions.

*Call graph*: called by 4 (pairing_status, start_pairing, clear_pairing_server_token, refresh_pairing_enrollment); 1 external calls (new).


##### `remote_control_status_with_connection_status`  (lines 871–885)

```
fn remote_control_status_with_connection_status(
    status: &RemoteControlStatusChangedNotification,
    connection_status: RemoteControlConnectionStatus,
) -> RemoteControlStatusChangedNotification
```

**Purpose**: Builds a new status snapshot by replacing only the connection-status field and clearing `environment_id` when transitioning to disabled.

**Data flow**: Reads an existing `RemoteControlStatusChangedNotification` and a target `RemoteControlConnectionStatus`, clones `server_name` and `installation_id`, preserves `environment_id` unless the new status is `Disabled`, and returns the new snapshot.

**Call relations**: Internal helper used by `publish_status` to keep status updates structurally consistent.


##### `publish_current_enrollment`  (lines 887–892)

```
fn publish_current_enrollment(
    current_enrollment: &mut Option<RemoteControlEnrollment>,
    enrollment: &RemoteControlEnrollment,
)
```

**Purpose**: Stores a cloned enrollment into the mutable current-enrollment slot.

**Data flow**: Clones the provided `RemoteControlEnrollment` and assigns it into `*current_enrollment`.

**Call relations**: Used after successful enrollment selection/creation so pairing and websocket paths share the same chosen server.

*Call graph*: called by 1 (load_or_enroll_pairing_server); 1 external calls (clone).


##### `replace_current_enrollment`  (lines 894–906)

```
fn replace_current_enrollment(
    current_enrollment: &mut Option<RemoteControlEnrollment>,
    enrollment: &RemoteControlEnrollment,
) -> bool
```

**Purpose**: Conditionally replaces the shared current enrollment only if it still refers to the same logical server record.

**Data flow**: Compares the existing `current_enrollment` against the provided enrollment with `same_remote_control_enrollment`; if they match, it clones the new enrollment into place and returns `true`, otherwise leaves state unchanged and returns `false`.

**Call relations**: Used by token refresh and token clearing to avoid overwriting a newer enrollment selected by another concurrent path.

*Call graph*: called by 2 (clear_pairing_server_token, refresh_pairing_enrollment); 1 external calls (clone).


##### `same_remote_control_enrollment`  (lines 908–917)

```
fn same_remote_control_enrollment(
    left: &RemoteControlEnrollment,
    right: &RemoteControlEnrollment,
) -> bool
```

**Purpose**: Defines logical equality for enrollment replacement by comparing account, server id, and environment id while ignoring bearer token rotation.

**Data flow**: Reads two `RemoteControlEnrollment` values and returns `true` only when `account_id`, `server_id`, and `environment_id` all match.

**Call relations**: Supports race-safe update semantics in `replace_current_enrollment`.


##### `start_remote_control`  (lines 919–1071)

```
async fn start_remote_control(
    config: RemoteControlStartConfig,
    state_db: Option<Arc<StateRuntime>>,
    auth_manager: Arc<AuthManager>,
    transport_event_tx: mpsc::Sender<TransportEvent>,
```

**Purpose**: Initializes the remote-control subsystem, computes initial desired state, creates shared channels/state, and spawns the background websocket task.

**Data flow**: Consumes startup config, optional state DB, auth manager, transport-event sender, shutdown token, optional client-name receiver, and startup mode. It derives `desired_state` from policy, startup mode, and DB availability; warns if ephemeral enable was requested without sqlite; normalizes the remote-control URL only when initial enablement is active; creates watch channels for desired state and status, semaphores for RPC/persistence serialization, shared enrollment state, and pairing-persistence-key watch state; computes `server_name` from hostname and initial status snapshot; constructs a `RemoteControlStatusPublisher`; logs startup; then spawns a task that builds `RemoteControlWebsocket::new(...)`, runs it, logs normal exit vs unexpected exit, and resumes panics after logging. Finally it returns the join handle plus a fully populated `RemoteControlHandle`.

**Call relations**: This is the subsystem entrypoint called during app-server startup. It wires together all lower-level modules and hands back the control handle used by RPCs and tests.

*Call graph*: calls 4 internal fn (new, normalize_remote_control_url, new, new); 11 external calls (new, clone, new, error!, gethostname, info!, AssertUnwindSafe, resume_unwind, spawn, warn! (+1 more)).


### `app-server-transport/src/transport/remote_control/desired_state.rs`

`domain_logic` · `startup preference resolution and runtime enable/disable RPC handling`

This file is the narrow bridge between persisted enrollment preference in sqlite and the runtime watch-based desired-state channel that drives the websocket task. Its central enum, `RemoteControlDesiredState`, distinguishes three cases that matter operationally: `Unknown` during startup before auth/account scope is known, `Disabled`, and `Enabled { persistence_preference: Option<bool> }`, where `Some(true)` means a durable preference should be written and `None` means runtime-only enablement. That distinction is subtle but important because disabled sessions do not create enrollments and runtime-only toggles intentionally preserve `NULL` in newly created rows.

The helper `desired_state_from_persisted_enrollment` collapses `RemoteControlEnrollmentRecord.remote_control_enabled` into the runtime enum: only an explicit persisted `Some(true)` becomes enabled; `Some(false)`, `None`, or no row all resolve to disabled. `acquire_persistence_lock` wraps the semaphore used to serialize writes that mutate persisted preference/enrollment rows.

`RemoteControlHandle::resolve_persisted_preference` is the startup read path. It first short-circuits managed-policy disablement, then serializes with `desired_state_rpc_lock`, avoids duplicate DB reads once state is no longer `Unknown`, loads auth and normalized target URL, derives the persistence key, fetches the enrollment row, and atomically updates the watch channel only if the state is still `Unknown`.

`RemoteControlHandle::enable` is the durable enable RPC path. It validates policy and DB availability, loads auth, normalizes the target URL, acquires the current enrollment lease, reuses or creates an enrollment, verifies the account did not change mid-flight, persists `remote_control_enabled = true` (creating the row if necessary), publishes the selected enrollment into shared state, flips desired state to enabled with `Some(true)`, publishes the environment id to status watchers, and returns the current status. The account-change check and persistence lock prevent writing enablement for the wrong account or racing with disable/reenrollment flows.

#### Function details

##### `RemoteControlDesiredState::is_enabled`  (lines 29–31)

```
fn is_enabled(self) -> bool
```

**Purpose**: Returns whether the desired state currently represents any enabled mode, regardless of whether that enablement is durable or ephemeral.

**Data flow**: Reads `self` by value and pattern-matches it against `RemoteControlDesiredState::Enabled { .. }`. Produces a `bool` with no side effects.

**Call relations**: Used by higher-level startup and status logic to collapse the richer enum into a simple enabled/disabled decision, especially when deciding whether initial connection setup should proceed.

*Call graph*: 1 external calls (matches!).


##### `acquire_persistence_lock`  (lines 34–36)

```
async fn acquire_persistence_lock(lock: &Semaphore) -> SemaphorePermit<'_>
```

**Purpose**: Asynchronously acquires the semaphore that serializes persistence-affecting remote-control transitions.

**Data flow**: Takes a borrowed `Semaphore`, awaits `acquire()`, and returns the resulting `SemaphorePermit`. If the semaphore were closed, it panics via `unreachable!`, asserting that this lock is never intentionally shut down.

**Call relations**: Called by durable and ephemeral transition paths across the subsystem before they touch persisted enrollment/preference state, so enable/disable, reenrollment, and account-change reconciliation do not interleave writes.

*Call graph*: called by 6 (disable, disable_ephemeral, load_or_enroll_pairing_server, enable, enroll_and_persist_remote_control_server, resolve_desired_state_after_account_change); 1 external calls (acquire).


##### `desired_state_from_persisted_enrollment`  (lines 38–48)

```
fn desired_state_from_persisted_enrollment(
    enrollment: Option<RemoteControlEnrollmentRecord>,
) -> RemoteControlDesiredState
```

**Purpose**: Maps an optional persisted enrollment row into the runtime desired-state enum used by the handle and websocket task.

**Data flow**: Consumes `Option<RemoteControlEnrollmentRecord>`, extracts `remote_control_enabled`, and returns `Enabled { persistence_preference: Some(true) }` only when the stored flag is exactly `Some(true)`; otherwise it returns `Disabled`.

**Call relations**: Invoked when startup or account-change logic needs to interpret sqlite state. It is the canonical translation layer from persisted tri-state preference into the runtime state machine.

*Call graph*: called by 3 (resolve_persisted_preference, resolve_unknown_desired_state, resolve_desired_state_after_account_change).


##### `RemoteControlHandle::resolve_persisted_preference`  (lines 51–94)

```
async fn resolve_persisted_preference(
        &self,
        app_server_client_name: Option<&str>,
    ) -> io::Result<bool>
```

**Purpose**: Resolves the initial desired enablement from persisted enrollment state for the current authenticated account and optional client-name scope.

**Data flow**: Reads policy via `ensure_remote_control_allowed`; if disallowed, returns `Ok(false)` without touching persistence. Otherwise it acquires `desired_state_rpc_lock`, checks `desired_state_tx` and returns the cached enabled bit if state is already known. If still `Unknown`, it reads `state_db`, loads auth from `auth_manager`, normalizes `remote_control_url`, derives the pairing persistence key from `app_server_client_name`, queries `get_remote_control_enrollment`, converts the row with `desired_state_from_persisted_enrollment`, conditionally updates `desired_state_tx` only if still `Unknown`, and returns the final enabled bit from the watch channel.

**Call relations**: This is the handle-side startup resolution path used when callers need to know whether persisted preference enables remote control. It delegates auth loading and URL normalization before the DB lookup, and it is guarded by the RPC lock so concurrent enable/disable RPCs cannot race the initial resolution.

*Call graph*: calls 3 internal fn (load_remote_control_auth, desired_state_from_persisted_enrollment, normalize_remote_control_url); 1 external calls (matches!).


##### `RemoteControlHandle::enable`  (lines 96–170)

```
async fn enable(
        &self,
        app_server_client_name: Option<&str>,
    ) -> io::Result<RemoteControlStatusChangedNotification>
```

**Purpose**: Performs a durable enable request: ensures an enrollment exists for the current account, persists `remote_control_enabled = true`, updates shared enrollment state, and transitions runtime status toward connecting.

**Data flow**: Consumes `&self` plus optional `app_server_client_name`. It validates policy, acquires `desired_state_rpc_lock`, requires `state_db`, loads mutable auth, normalizes the remote-control target, derives the persistence key, snapshots current status, and locks `current_enrollment`. It then calls `load_or_enroll_server` with `ReuseOrCreate` to obtain an enrollment, reloads auth to verify the account id did not change, acquires the persistence semaphore via `acquire_persistence_lock`, tries `set_remote_control_enabled(..., true)`, and if no row was updated calls `update_persisted_remote_control_enrollment` to create one with the enrollment payload. After that it writes the enrollment into shared state with `publish_current_enrollment`, calls `enable_with_preference(Some(true))` to update desired state and status, publishes `environment_id` through `RemoteControlStatusPublisher`, and returns `self.status()`. Errors are translated into `io::Error` kinds appropriate to unavailable DB or managed disablement.

**Call relations**: This method is the durable RPC-facing enable path. It sits above enrollment creation/reuse and below the websocket loop: callers invoke it when the user explicitly enables remote control, and it delegates enrollment persistence and status publication so the background websocket task can connect using the selected server.

*Call graph*: calls 5 internal fn (load_remote_control_auth, acquire_persistence_lock, update_persisted_remote_control_enrollment, normalize_remote_control_url, new); 2 external calls (new, publish_current_enrollment).


### `app-server-transport/src/transport/remote_control/enroll.rs`

`io_transport` · `enrollment, token refresh, pairing RPCs, and persistence updates during connection setup and pairing`

This file contains the HTTP-facing enrollment model and the persistence utilities that let the remote-control subsystem reuse a previously enrolled backend server. `RemoteControlEnrollment` stores the normalized target URLs plus account, environment, server identity, and an optional bearer token with expiry. The token is intentionally transient: persisted rows only keep stable server identity, while `remote_control_token` and `expires_at` live in memory and are refreshed as needed.

The pairing methods (`start_pairing` and `pairing_status`) both refuse to operate when the server token is missing or within a 30-second skew window of expiry. They build reqwest POST requests with bearer auth, read the full body, generate a redacted preview for diagnostics, map HTTP status codes to `io::ErrorKind`, and validate response structure. `start_pairing` additionally verifies that the backend echoed the same `server_id` and `environment_id` as the current enrollment before returning a protocol-level response with Unix timestamp expiry.

Persistence helpers separate stable enrollment identity from runtime token state. `load_persisted_remote_control_enrollment` reconstructs an in-memory `RemoteControlEnrollment` from `StateRuntime`, always with `remote_control_token: None` and `expires_at: None`. `update_persisted_remote_control_enrollment` either upserts a `RemoteControlEnrollmentRecord` or deletes the row, and it enforces that any supplied enrollment belongs to the expected account.

The generic request helper `send_remote_control_server_request` centralizes auth headers, account/install headers, timeout, body previewing, and parse/error formatting for enroll and refresh calls. Supporting utilities redact sensitive JSON fields (`remote_control_token`, `pairing_code`, `manual_pairing_code`) and preserve request-id / cf-ray headers in error messages. The tests exercise token-refresh skew, persistence round-trips keyed by target/account/client name, selective deletion, and parse-error context preservation.

#### Function details

##### `RemoteControlEnrollment::start_pairing`  (lines 49–140)

```
async fn start_pairing(
        &self,
        request: StartRemoteControlPairingRequest,
    ) -> io::Result<RemoteControlPairingStartResponse>
```

**Purpose**: Starts a backend pairing session for an already enrolled remote-control server and returns the pairing codes plus expiry.

**Data flow**: Reads `self` fields including `remote_control_target.pair_url`, `remote_control_token`, `server_id`, and `environment_id`, plus the `StartRemoteControlPairingRequest`. It first rejects stale or missing tokens using `should_refresh_server_token` / `pairing_unavailable_error`, then sends a POST with bearer auth and JSON body, reads headers/status/body, builds a redacted body preview, maps non-success statuses to `io::Error`, deserializes `StartRemoteControlPairingResponse`, verifies returned `server_id` and `environment_id` match the enrollment, parses `expires_at` from RFC3339 to Unix seconds, and returns `RemoteControlPairingStartResponse`.

**Call relations**: Called from `RemoteControlHandle::start_pairing` after enrollment selection and optional token refresh. It is the final backend call in that flow and relies on upstream logic to recover from unauthorized or missing-server cases by refreshing or reenrolling.

*Call graph*: calls 3 internal fn (should_refresh_server_token, preview_remote_control_response_body, build_reqwest_client); 5 external calls (parse, new, other, format!, pairing_unavailable_error).


##### `RemoteControlEnrollment::pairing_status`  (lines 142–203)

```
async fn pairing_status(
        &self,
        request: RemoteControlPairingStatusRequest,
    ) -> io::Result<RemoteControlPairingStatusResponse>
```

**Purpose**: Queries whether a previously issued pairing code or manual pairing code has been claimed.

**Data flow**: Reads the enrollment’s pair-status URL and bearer token plus the `RemoteControlPairingStatusRequest`. It rejects stale/missing tokens, sends a POST request, captures headers/status/body, previews and redacts the body for diagnostics, maps HTTP errors to `PermissionDenied`, `InvalidInput`, or `Other`, deserializes the backend response, and returns a simplified `RemoteControlPairingStatusResponse { claimed }`.

**Call relations**: Invoked by `RemoteControlHandle::pairing_status` once the handle has selected the current enrollment and ensured the desired state is enabled. Upstream logic retries around permission failures by clearing and refreshing the token.

*Call graph*: calls 3 internal fn (should_refresh_server_token, preview_remote_control_response_body, build_reqwest_client); 3 external calls (new, format!, pairing_unavailable_error).


##### `RemoteControlEnrollment::should_refresh_server_token`  (lines 205–212)

```
fn should_refresh_server_token(&self) -> bool
```

**Purpose**: Determines whether the in-memory server bearer token is absent or close enough to expiry that it should be refreshed before use.

**Data flow**: Reads `self.remote_control_token` and `self.expires_at`, compares expiry against `OffsetDateTime::now_utc()` plus a 30-second skew, and returns `true` when the token is missing or expiring soon.

**Call relations**: Used by both pairing methods to fail fast when the token should not be used, pushing refresh responsibility to the higher-level pairing orchestration.

*Call graph*: called by 2 (pairing_status, start_pairing).


##### `RemoteControlEnrollment::clear_server_token`  (lines 214–217)

```
fn clear_server_token(&mut self)
```

**Purpose**: Drops the transient bearer token and expiry from an enrollment while preserving stable server identity.

**Data flow**: Mutably updates `self.remote_control_token` and `self.expires_at` to `None`; returns unit.

**Call relations**: Called when pairing logic receives permission failures and wants to invalidate the cached token before attempting refresh or surfacing pairing-unavailable state.

*Call graph*: called by 1 (clear_pairing_server_token).


##### `load_persisted_remote_control_enrollment`  (lines 220–281)

```
async fn load_persisted_remote_control_enrollment(
    state_db: Option<&StateRuntime>,
    remote_control_target: &RemoteControlTarget,
    account_id: &str,
    app_server_client_name: Option<&str>,
```

**Purpose**: Loads a stable enrollment record from sqlite and reconstructs an in-memory enrollment object without any bearer token.

**Data flow**: Takes optional `StateRuntime`, a `RemoteControlTarget`, `account_id`, and optional `app_server_client_name`. If `state_db` is absent it returns `NotFound`. Otherwise it queries `get_remote_control_enrollment`; on DB error it logs a warning and returns `io::Error::other`. If a row exists it logs reuse and returns `Some(RemoteControlEnrollment)` cloned from the target and row fields with `remote_control_token: None` and `expires_at: None`; if no row exists it logs that fact and returns `Ok(None)`.

**Call relations**: Used by enrollment-preparation paths to reuse persisted server identity before deciding to enroll a new server. It is intentionally token-free so callers must refresh before connecting or pairing.

*Call graph*: called by 2 (load_or_enroll_server, prepare_remote_control_enrollment); 6 external calls (clone, new, other, format!, info!, warn!).


##### `update_persisted_remote_control_enrollment`  (lines 283–348)

```
async fn update_persisted_remote_control_enrollment(
    state_db: Option<&StateRuntime>,
    remote_control_target: &RemoteControlTarget,
    account_id: &str,
    app_server_client_name: Option<&str
```

**Purpose**: Creates, updates, or deletes the sqlite enrollment row for a target/account/client-name scope, optionally storing the durable enabled flag.

**Data flow**: Accepts optional `StateRuntime`, target, account id, optional client name, optional enrollment, and optional `remote_control_enabled`. It errors with `NotFound` if persistence is unavailable. If an enrollment is supplied, it verifies `enrollment.account_id == account_id`, then writes an `RemoteControlEnrollmentRecord` via `upsert_remote_control_enrollment`; otherwise it deletes the matching row via `delete_remote_control_enrollment`. It logs either persistence or clearing and returns `Ok(())`.

**Call relations**: Called from durable enablement, pairing enrollment creation, websocket reenrollment paths, and tests. It is the single persistence primitive for stable enrollment identity plus the tri-state enabled preference.

*Call graph*: called by 12 (load_or_enroll_pairing_server, enable, clearing_persisted_remote_control_enrollment_removes_only_matching_entry, persisted_remote_control_enrollment_round_trips_by_target_and_account, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting (+2 more)); 4 external calls (new, other, format!, info!).


##### `preview_remote_control_response_body`  (lines 350–368)

```
fn preview_remote_control_response_body(body: &[u8]) -> String
```

**Purpose**: Builds a bounded, human-readable response-body preview for logs and error messages while redacting sensitive fields.

**Data flow**: Takes raw response bytes, decodes them lossily as UTF-8, trims whitespace, returns `"<empty>"` for blank bodies, otherwise passes the text through `redact_remote_control_response_body`. If the redacted string exceeds `REMOTE_CONTROL_RESPONSE_BODY_MAX_BYTES`, it truncates at a valid UTF-8 boundary and appends `...`; otherwise it returns the full redacted string.

**Call relations**: Used by enrollment, pairing, client-management, and websocket error-formatting code whenever backend responses need to be surfaced without leaking tokens or pairing codes.

*Call graph*: calls 1 internal fn (redact_remote_control_response_body); called by 6 (list_remote_control_clients, revoke_remote_control_client, pairing_status, start_pairing, send_remote_control_server_request, format_remote_control_websocket_connect_error); 1 external calls (from_utf8_lossy).


##### `redact_remote_control_response_body`  (lines 370–387)

```
fn redact_remote_control_response_body(body: &str) -> String
```

**Purpose**: Redacts known sensitive JSON fields from a response body string when the body parses as a top-level JSON object.

**Data flow**: Parses `body` into `serde_json::Value`; if parsing fails or the value is not an object, it returns the original string unchanged. Otherwise it replaces `remote_control_token`, `pairing_code`, and `manual_pairing_code` values with `"<redacted>"` and serializes the modified JSON back to a string.

**Call relations**: This is an internal helper used only by `preview_remote_control_response_body` so all higher-level error formatting gets consistent redaction.

*Call graph*: called by 1 (preview_remote_control_response_body); 1 external calls (String).


##### `format_headers`  (lines 389–400)

```
fn format_headers(headers: &HeaderMap) -> String
```

**Purpose**: Extracts request correlation headers from an HTTP response and formats them into a compact diagnostic string.

**Data flow**: Reads `x-request-id` or fallback `x-oai-request-id`, plus `cf-ray`, from the provided `HeaderMap`, converting invalid UTF-8 to placeholder text and missing headers to `<none>`. Returns a string like `request-id: ..., cf-ray: ...`.

**Call relations**: Used by the generic server-request helper so enrollment and refresh errors include backend correlation identifiers.

*Call graph*: called by 1 (send_remote_control_server_request); 2 external calls (get, format!).


##### `enroll_remote_control_server`  (lines 402–441)

```
async fn enroll_remote_control_server(
    remote_control_target: &RemoteControlTarget,
    auth: &RemoteControlConnectionAuth,
    installation_id: &str,
    server_name: &str,
) -> io::Result<Remote
```

**Purpose**: Registers this app-server instance with the backend and returns a fresh enrollment containing server identity and bearer token.

**Data flow**: Consumes a normalized target, auth, installation id, and server name. It builds `EnrollRemoteServerRequest` with OS, architecture, crate version, and installation id; sends it through `send_remote_control_server_request`; constructs a `RemoteControlEnrollment` from the response’s server/environment ids and local metadata; then mutably fills `remote_control_token` and `expires_at` via `update_remote_control_server_token` before returning the enrollment.

**Call relations**: Called when no reusable enrollment exists or when a stale one must be replaced. Higher-level orchestration may retry it after auth recovery.

*Call graph*: calls 1 internal fn (update_remote_control_server_token); called by 3 (enroll_remote_control_server_parse_failure_includes_response_body, enroll_pairing_server, enroll_and_persist_remote_control_server); 2 external calls (clone, env!).


##### `refresh_remote_control_server`  (lines 443–480)

```
async fn refresh_remote_control_server(
    auth: &RemoteControlConnectionAuth,
    installation_id: &str,
    enrollment: &mut RemoteControlEnrollment,
) -> io::Result<()>
```

**Purpose**: Refreshes the bearer token for an existing enrollment while asserting that the backend still refers to the same server/environment identity.

**Data flow**: Takes auth, installation id, and mutable enrollment. It builds `RefreshRemoteServerRequest` from `enrollment.server_id`, sends it through `send_remote_control_server_request`, verifies the returned `server_id` and `environment_id` match the existing enrollment, then updates `remote_control_token` and `expires_at` in place via `update_remote_control_server_token`.

**Call relations**: Used before pairing and websocket connection when a persisted enrollment lacks a token or the token is near expiry. Upstream logic handles permission-denied auth recovery and 404-driven reenrollment.

*Call graph*: calls 1 internal fn (update_remote_control_server_token); called by 2 (refresh_pairing_enrollment, prepare_remote_control_enrollment); 2 external calls (other, format!).


##### `send_remote_control_server_request`  (lines 482–540)

```
async fn send_remote_control_server_request(
    url: &str,
    auth: &RemoteControlConnectionAuth,
    installation_id: &str,
    request: &Request,
    action: &str,
    response_kind: &str,
) -> io
```

**Purpose**: Sends a typed JSON POST request to an enrollment/refresh endpoint with auth and standardized error handling.

**Data flow**: Accepts URL, `RemoteControlConnectionAuth`, installation id, a serializable request body, and strings describing the action/response kind. It builds a reqwest client, asks `auth.auth_provider` to populate auth headers, adds account-id and installation-id headers, sends the POST with timeout and JSON body, reads headers/status/body, computes a redacted body preview, maps non-success statuses to `io::ErrorKind`, and deserializes the body into the requested response type.

**Call relations**: This is the shared transport primitive beneath both `enroll_remote_control_server` and `refresh_remote_control_server`, ensuring those flows produce consistent request headers and diagnostics.

*Call graph*: calls 3 internal fn (format_headers, preview_remote_control_response_body, build_reqwest_client); 3 external calls (new, new, format!).


##### `update_remote_control_server_token`  (lines 542–556)

```
fn update_remote_control_server_token(
    enrollment: &mut RemoteControlEnrollment,
    url: &str,
    token: String,
    expires_at: String,
) -> io::Result<()>
```

**Purpose**: Parses a backend token expiry timestamp and stores the token plus parsed expiry into an enrollment.

**Data flow**: Mutably borrows `RemoteControlEnrollment`, parses the RFC3339 `expires_at` string, writes `remote_control_token = Some(token)` and `expires_at = Some(parsed_time)`, and returns `Ok(())` or a parse error wrapped as `io::Error`.

**Call relations**: Used immediately after successful enroll and refresh responses to populate the transient bearer credentials needed for websocket and pairing calls.

*Call graph*: called by 2 (enroll_remote_control_server, refresh_remote_control_server); 1 external calls (parse).


##### `tests::remote_control_state_runtime`  (lines 575–579)

```
async fn remote_control_state_runtime(codex_home: &TempDir) -> Arc<StateRuntime>
```

**Purpose**: Creates a temporary `StateRuntime` for enrollment persistence tests.

**Data flow**: Reads the temp directory path, calls `StateRuntime::init` with a fixed provider string, and returns the initialized runtime wrapped in `Arc`.

**Call relations**: Shared test fixture used by persistence round-trip and deletion tests.

*Call graph*: calls 1 internal fn (init); 1 external calls (path).


##### `tests::remote_control_enrollment_refreshes_server_token_before_expiry`  (lines 582–601)

```
fn remote_control_enrollment_refreshes_server_token_before_expiry()
```

**Purpose**: Verifies the 30-second skew logic used to decide whether a server token should be refreshed.

**Data flow**: Constructs two `RemoteControlEnrollment` values differing only in `expires_at`, then calls `should_refresh_server_token` and asserts that a token expiring in 29 seconds refreshes while one expiring in 31 seconds does not.

**Call relations**: Exercises the token-staleness predicate directly to lock in the pre-expiry refresh boundary.

*Call graph*: calls 1 internal fn (normalize_remote_control_url); 3 external calls (now_utc, assert!, seconds).


##### `tests::preview_remote_control_response_body_redacts_server_token`  (lines 604–617)

```
fn preview_remote_control_response_body_redacts_server_token()
```

**Purpose**: Checks that response-body previews redact all sensitive pairing and token fields while remaining valid JSON.

**Data flow**: Passes a JSON byte string containing `remote_control_token`, `pairing_code`, and `manual_pairing_code` into `preview_remote_control_response_body`, parses the result back into JSON, and compares it against an expected object with `<redacted>` placeholders.

**Call relations**: Protects the logging/error-reporting path from accidental credential leakage.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::persisted_remote_control_enrollment_round_trips_by_target_and_account`  (lines 620–701)

```
async fn persisted_remote_control_enrollment_round_trips_by_target_and_account()
```

**Purpose**: Confirms persisted enrollments are keyed by normalized target URL and account id, not just by one dimension.

**Data flow**: Creates a temp state DB, normalizes two distinct targets, persists two enrollments under the same account and client name, then loads combinations of target/account and asserts that only exact matches return the expected enrollment while a different account returns `None`.

**Call relations**: Validates the persistence helper contract relied on by reuse-or-create enrollment selection.

*Call graph*: calls 2 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url); 3 external calls (new, remote_control_state_runtime, assert_eq!).


##### `tests::clearing_persisted_remote_control_enrollment_removes_only_matching_entry`  (lines 704–785)

```
async fn clearing_persisted_remote_control_enrollment_removes_only_matching_entry()
```

**Purpose**: Ensures deleting one persisted enrollment row does not remove another row for a different target.

**Data flow**: Persists two enrollments under different targets, calls `update_persisted_remote_control_enrollment` with `enrollment: None` for one target, then reloads both targets and asserts only the matching row was removed.

**Call relations**: Covers the delete branch of the persistence helper and its target/account scoping.

*Call graph*: calls 2 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url); 3 external calls (new, remote_control_state_runtime, assert_eq!).


##### `tests::enroll_remote_control_server_parse_failure_includes_response_body`  (lines 788–832)

```
async fn enroll_remote_control_server_parse_failure_includes_response_body()
```

**Purpose**: Verifies that malformed enrollment responses surface the HTTP status, headers, and raw body in the parse error message.

**Data flow**: Starts a local TCP listener, serves an incomplete JSON enrollment response, calls `enroll_remote_control_server`, captures the resulting error, and asserts the formatted message includes the enroll URL, `HTTP 200 OK`, default header placeholders, the exact body, and the serde decode error.

**Call relations**: Locks in the diagnostic quality of the generic request helper used by enrollment.

*Call graph*: calls 2 internal fn (enroll_remote_control_server, normalize_remote_control_url); 8 external calls (bind, accept_http_request, respond_with_json, assert_eq!, unauthenticated_auth_provider, format!, json!, spawn).


##### `tests::accept_http_request`  (lines 834–858)

```
async fn accept_http_request(listener: &TcpListener) -> TcpStream
```

**Purpose**: Minimal test helper that accepts one HTTP request and returns the underlying stream after consuming request headers.

**Data flow**: Accepts a TCP connection with timeout, reads the request line and headers until the blank line, discards them, and returns the `TcpStream` for the caller to write a response.

**Call relations**: Used by the parse-failure test’s ad hoc local server.

*Call graph*: 5 external calls (new, from_secs, new, accept, timeout).


##### `tests::respond_with_json`  (lines 860–871)

```
async fn respond_with_json(mut stream: TcpStream, body: serde_json::Value)
```

**Purpose**: Writes a simple HTTP 200 JSON response on a test TCP stream.

**Data flow**: Serializes the provided JSON value to a string, formats an HTTP response with content length and `connection: close`, writes it to the stream, and flushes.

**Call relations**: Companion helper for local HTTP server behavior in enrollment tests.

*Call graph*: 4 external calls (flush, write_all, to_string, format!).


### `app-server-transport/src/transport/remote_control/client_tracker.rs`

`domain_logic` · `remote-control session handling and connection cleanup`

This file implements the remote-control side of connection lifecycle management. `ClientTracker` owns a `HashMap` of active `(ClientId, StreamId)` pairs to `ClientState`, a compatibility map for legacy clients that omit `stream_id`, a `JoinSet` for outbound worker tasks, and the channels/tokens needed to talk to the main transport and remote-control server-event pipelines. Each `ClientState` stores the assigned `ConnectionId`, a disconnect token, last activity timestamp, last delivered inbound sequence id for deduplication, and a watch sender used to push `PongStatus` updates to the outbound worker.

`handle_message` is the central state machine. It normalizes missing stream ids, treating `initialize` specially for legacy clients, ignores messages with no resolvable stream, deduplicates retried sequenced messages after successful delivery, and treats `initialize` as the only event that can open a new logical connection. Opening a connection allocates a new `ConnectionId`, creates a bounded writer channel, emits `TransportEvent::ConnectionOpened`, spawns `run_client_outbound`, stores client state, and then forwards the initialize message itself. If that second send times out or fails, it rolls back by removing the client, cancelling its worker, and spawning detached close delivery so reconnect is not blocked by the same backpressure.

The outbound worker multiplexes queued server messages and pong-status changes into `QueuedServerEnvelope`s until disconnected. Non-close transport events are sent with a timeout to avoid hanging on a stalled receiver; close events are special-cased and detached through `spawn_connection_closed` so cleanup can continue even if the caller is aborted. Idle clients are swept based on `REMOTE_CONTROL_CLIENT_IDLE_TIMEOUT`, and shutdown cancels all clients then drains the worker join set. Tests cover cancellation, timeout rollback, queue backpressure, legacy stream-id behavior, and sequence-id handling.

#### Function details

##### `ClientTracker::new`  (lines 55–68)

```
fn new(
        server_event_tx: mpsc::Sender<QueuedServerEnvelope>,
        transport_event_tx: mpsc::Sender<TransportEvent>,
        shutdown_token: &CancellationToken,
    ) -> Self
```

**Purpose**: Constructs an empty client tracker with fresh maps, join set, cloned channels, and a child shutdown token. It establishes the state container for remote-control client/session management.

**Data flow**: Takes the server-event sender, transport-event sender, and a parent `CancellationToken`. It initializes empty `HashMap`s and `JoinSet`, clones the senders into the struct, derives `shutdown_token.child_token()`, and returns the new `ClientTracker`.

**Call relations**: Called by remote-control startup code and many tests before any client messages are processed.

*Call graph*: called by 11 (cancelled_outbound_task_emits_connection_closed, close_client_keeps_forwarding_after_caller_is_aborted, close_client_waits_for_transport_event_queue_capacity, incoming_message_timeout_does_not_advance_seq_id, initialize_timeout_closes_open_connection, initialize_with_new_stream_id_opens_new_connection_for_same_client, legacy_initialize_without_stream_id_resets_inbound_seq_id, non_close_transport_event_send_times_out_when_queue_stays_full, shutdown_cancels_blocked_outbound_forwarding, new (+1 more)); 3 external calls (child_token, new, new).


##### `ClientTracker::bookkeep_join_set`  (lines 70–78)

```
async fn bookkeep_join_set(&mut self) -> Option<(ClientId, StreamId)>
```

**Purpose**: Waits for an outbound worker task to finish and returns the corresponding client key. If tasks fail with join errors it skips them and keeps waiting indefinitely.

**Data flow**: Borrows `self` mutably, repeatedly awaits `self.join_set.join_next()`, ignores errored join results, returns the first successful `(ClientId, StreamId)`, and if the join set is exhausted awaits a pending future forever.

**Call relations**: Used by outer bookkeeping loops and tests to learn which client outbound task exited so the tracker can close that client.

*Call graph*: 2 external calls (join_next, pending).


##### `ClientTracker::shutdown`  (lines 80–88)

```
async fn shutdown(&mut self)
```

**Purpose**: Cancels all tracked clients and waits for all outbound worker tasks to finish. It is the orderly teardown path for the remote-control subsystem.

**Data flow**: Mutably borrows the tracker, cancels `self.shutdown_token`, repeatedly clones and closes the next remaining client key until `clients` is empty, then awaits `drain_join_set` to consume all worker completions.

**Call relations**: Called during subsystem shutdown. It delegates per-client cleanup to `close_client` and final worker draining to `drain_join_set`.

*Call graph*: calls 2 internal fn (close_client, drain_join_set); 1 external calls (cancel).


##### `ClientTracker::drain_join_set`  (lines 90–92)

```
async fn drain_join_set(&mut self)
```

**Purpose**: Waits until every spawned outbound worker task has completed. It is a simple internal helper used during shutdown.

**Data flow**: Mutably borrows the tracker and repeatedly awaits `self.join_set.join_next()` until it returns `None`.

**Call relations**: Called only by `shutdown` after all clients have been cancelled.

*Call graph*: called by 1 (shutdown); 1 external calls (join_next).


##### `ClientTracker::handle_message`  (lines 94–242)

```
async fn handle_message(
        &mut self,
        client_envelope: ClientEnvelope,
    ) -> Result<(), Stopped>
```

**Purpose**: Processes one inbound remote-control client envelope, updating client/session state and forwarding transport events as needed. It handles connection establishment, deduplication, pings, and explicit client closure.

**Data flow**: Consumes a `ClientEnvelope`, extracts `client_id`, `stream_id`, `seq_id`, and `event`, derives whether the message is an initialize request and whether the stream id is legacy/missing, normalizes or synthesizes a `StreamId`, and returns early for empty stream ids. For `ClientMessage`, it drops duplicate retried sequence ids after successful delivery, closes an existing client on re-initialize, forwards to an existing connection if present while updating activity and recording delivered seq ids, or opens a new connection on initialize by allocating `next_connection_id`, creating a writer channel and disconnect token, sending `ConnectionOpened`, spawning `run_client_outbound`, inserting `ClientState`, and forwarding the initialize message. If that initial forward fails, it removes the client, cancels it, and detaches a close event. For `Ping`, it either updates activity and sends `PongStatus::Active` through the watch channel or asynchronously emits an immediate `PongStatus::Unknown` server event for unknown clients. `ClientClosed` delegates to `close_client`; chunk and ack events are ignored.

**Call relations**: This is the central entry point called by the remote-control protocol receiver for every client envelope. It delegates to `close_client`, `send_transport_event`, `record_inbound_message_delivery`, `remove_client`, and `spawn_connection_closed`, and it spawns `run_client_outbound` when a new logical connection is opened.

*Call graph*: calls 5 internal fn (close_client, record_inbound_message_delivery, remove_client, send_transport_event, spawn_connection_closed); 9 external calls (child_token, now, spawn, run_client_outbound, clone, matches!, next_connection_id, spawn, channel).


##### `ClientTracker::run_client_outbound`  (lines 244–290)

```
async fn run_client_outbound(
        client_id: ClientId,
        stream_id: StreamId,
        server_event_tx: mpsc::Sender<QueuedServerEnvelope>,
        mut writer_rx: mpsc::Receiver<QueuedOutgoin
```

**Purpose**: Runs the per-client outbound worker that converts queued app-server messages and pong-status updates into remote-control server envelopes. It exits when disconnected, when channels close, or when sending to the server-event queue fails.

**Data flow**: Takes ownership of the client id, stream id, server-event sender, writer receiver, pong-status receiver, and disconnect token. In a loop it `select!`s between disconnect cancellation, receiving a `QueuedOutgoingMessage` from `writer_rx` and wrapping it as `ServerEvent::ServerMessage`, or receiving a changed pong status and wrapping it as `ServerEvent::Pong`. It then `select!`s again between disconnect cancellation and sending a `QueuedServerEnvelope` to `server_event_tx`. On any termination condition it returns `(client_id, stream_id)`.

**Call relations**: Spawned by `handle_message` when a new client connection is opened. Its completion is later observed through `bookkeep_join_set`.

*Call graph*: 1 external calls (select!).


##### `ClientTracker::close_expired_clients`  (lines 292–307)

```
async fn close_expired_clients(
        &mut self,
    ) -> Result<Vec<(ClientId, StreamId)>, Stopped>
```

**Purpose**: Finds clients that have been idle longer than the configured timeout and closes them. It returns the list of expired client keys that were closed.

**Data flow**: Mutably borrows the tracker, captures `Instant::now()`, filters `self.clients` through `remote_control_client_is_alive`, collects expired `(ClientId, StreamId)` keys, closes each via `close_client`, and returns the expired key list or `Stopped` if forwarding a close event fails.

**Call relations**: Called by periodic idle-sweep logic in the remote-control subsystem. It delegates liveness checks to `remote_control_client_is_alive` and actual closure to `close_client`.

*Call graph*: calls 1 internal fn (close_client); 1 external calls (now).


##### `ClientTracker::close_client`  (lines 309–321)

```
async fn close_client(
        &mut self,
        client_key: &(ClientId, StreamId),
    ) -> Result<(), Stopped>
```

**Purpose**: Removes a tracked client, cancels its outbound worker, and forwards a `ConnectionClosed` transport event. It is the common path for explicit close, idle expiry, reinitialize replacement, and shutdown.

**Data flow**: Takes a client key reference, removes the client state with `remove_client`, returns immediately if absent, cancels the client's disconnect token, and awaits `send_transport_event(TransportEvent::ConnectionClosed { ... })`.

**Call relations**: Called by `handle_message`, `close_expired_clients`, and `shutdown`. It relies on `send_transport_event` to apply the special close-delivery semantics.

*Call graph*: calls 2 internal fn (remove_client, send_transport_event); called by 3 (close_expired_clients, handle_message, shutdown).


##### `ClientTracker::remove_client`  (lines 323–333)

```
fn remove_client(&mut self, client_key: &(ClientId, StreamId)) -> Option<ClientState>
```

**Purpose**: Deletes a client from the active maps and cleans up any legacy stream-id alias that points to it. It is the internal state-removal primitive.

**Data flow**: Mutably borrows the tracker and a client key, removes the corresponding `ClientState` from `clients`, checks whether `legacy_stream_ids` maps the same `ClientId` to that `StreamId`, removes that alias if so, and returns the removed state.

**Call relations**: Used by `close_client` for normal teardown and by `handle_message` when rolling back a failed initialize or replacing an existing client on reinitialize.

*Call graph*: called by 2 (close_client, handle_message).


##### `ClientTracker::send_transport_event`  (lines 335–367)

```
async fn send_transport_event(&self, event: TransportEvent) -> Result<(), Stopped>
```

**Purpose**: Forwards a transport event to the main app-server transport queue with timeout protection for non-close events and detached delivery for close events. It converts queue closure or timeout into the local `Stopped` signal.

**Data flow**: Accepts a `TransportEvent`. If it is `ConnectionClosed`, it immediately delegates to `send_connection_closed`. Otherwise it derives a static event name with `transport_event_name`, awaits `self.transport_event_tx.send(event)` under `timeout(REMOTE_CONTROL_TRANSPORT_EVENT_SEND_TIMEOUT, ...)`, and returns `Ok(())` on success or logs a warning and returns `Err(Stopped)` on receiver drop or timeout.

**Call relations**: Called by `handle_message` and `close_client` whenever the tracker needs to notify the main transport layer. It delegates close events to `send_connection_closed`.

*Call graph*: calls 2 internal fn (send_connection_closed, transport_event_name); called by 2 (close_client, handle_message); 3 external calls (send, timeout, warn!).


##### `ClientTracker::record_inbound_message_delivery`  (lines 369–380)

```
fn record_inbound_message_delivery(
        &mut self,
        client_key: &(ClientId, StreamId),
        seq_id: Option<u64>,
    )
```

**Purpose**: Records the last successfully delivered inbound sequence id for a client so retries can be deduplicated. It only advances after the app-server transport queue accepted the message.

**Data flow**: Takes a client key and optional sequence id. If `seq_id` is `Some` and the client still exists, it updates `client.last_inbound_seq_id` to that value; otherwise it does nothing.

**Call relations**: Called by `handle_message` after successful forwarding of inbound client messages, and intentionally not called when forwarding times out or fails.

*Call graph*: called by 1 (handle_message).


##### `ClientTracker::send_connection_closed`  (lines 382–395)

```
async fn send_connection_closed(&self, connection_id: ConnectionId) -> Result<(), Stopped>
```

**Purpose**: Ensures `ConnectionClosed` delivery continues even if the caller is later aborted by awaiting a detached forwarding task. It is the special close-event path used to avoid cleanup loss under cancellation.

**Data flow**: Takes a `ConnectionId`, calls `spawn_connection_closed(connection_id)` to create a task that sends the close event, awaits that join handle, returns the inner result on success, and logs a warning plus returns `Stopped` if the task itself fails.

**Call relations**: Called only by `send_transport_event` when the event being forwarded is `ConnectionClosed`.

*Call graph*: calls 1 internal fn (spawn_connection_closed); called by 1 (send_transport_event); 1 external calls (warn!).


##### `ClientTracker::spawn_connection_closed`  (lines 397–418)

```
fn spawn_connection_closed(
        &self,
        connection_id: ConnectionId,
    ) -> JoinHandle<Result<(), Stopped>>
```

**Purpose**: Spawns a detached task that forwards a `ConnectionClosed` event to the transport queue. This decouples close delivery from the lifetime of the caller performing cleanup.

**Data flow**: Borrows `self` and a `ConnectionId`, logs an info message, clones `transport_event_tx`, spawns an async task that sends `TransportEvent::ConnectionClosed { connection_id }`, maps receiver-drop into a warning and `Stopped`, and returns the `JoinHandle<Result<(), Stopped>>`.

**Call relations**: Used by `send_connection_closed` for normal detached close delivery and by `handle_message` during initialize rollback when it must preserve close delivery without blocking on the same backpressure.

*Call graph*: called by 2 (handle_message, send_connection_closed); 3 external calls (clone, info!, spawn).


##### `transport_event_name`  (lines 421–427)

```
fn transport_event_name(event: &TransportEvent) -> &'static str
```

**Purpose**: Maps a `TransportEvent` variant to a stable short name for structured logging. It keeps timeout/drop warnings readable.

**Data flow**: Takes `&TransportEvent`, matches the variant, and returns one of `connection_opened`, `connection_closed`, or `incoming_message`.

**Call relations**: Used by `send_transport_event` when logging queue-drop or timeout warnings.

*Call graph*: called by 1 (send_transport_event).


##### `remote_control_message_starts_connection`  (lines 429–435)

```
fn remote_control_message_starts_connection(message: &JSONRPCMessage) -> bool
```

**Purpose**: Determines whether a JSON-RPC message should be treated as the start of a remote-control logical connection. Currently only `initialize` requests qualify.

**Data flow**: Accepts `&JSONRPCMessage`, pattern-matches for a request whose method is `initialize`, and returns a boolean.

**Call relations**: Used by `handle_message` to decide whether a message can open a new connection and how to normalize missing stream ids.

*Call graph*: 1 external calls (matches!).


##### `remote_control_client_is_alive`  (lines 437–439)

```
fn remote_control_client_is_alive(client: &ClientState, now: Instant) -> bool
```

**Purpose**: Checks whether a client has been active recently enough to avoid idle expiration. It encapsulates the timeout comparison.

**Data flow**: Takes `&ClientState` and the current `Instant`, computes `now.duration_since(client.last_activity_at)`, compares it against `REMOTE_CONTROL_CLIENT_IDLE_TIMEOUT`, and returns a boolean.

**Call relations**: Used by `close_expired_clients` during periodic idle sweeps.

*Call graph*: 1 external calls (duration_since).


##### `tests::initialize_envelope`  (lines 455–457)

```
fn initialize_envelope(client_id: &str) -> ClientEnvelope
```

**Purpose**: Builds a legacy-style initialize envelope without an explicit stream id for tests. It is a convenience wrapper around the more general helper.

**Data flow**: Takes a client id string and returns `initialize_envelope_with_stream_id(client_id, None)`.

**Call relations**: Used by tests that exercise legacy no-stream-id behavior.

*Call graph*: 1 external calls (initialize_envelope_with_stream_id).


##### `tests::initialize_envelope_with_stream_id`  (lines 459–482)

```
fn initialize_envelope_with_stream_id(
        client_id: &str,
        stream_id: Option<&str>,
    ) -> ClientEnvelope
```

**Purpose**: Constructs a test `ClientEnvelope` carrying an `initialize` JSON-RPC request, optionally with a stream id. It standardizes test setup for opening remote-control connections.

**Data flow**: Accepts a client id and optional stream id string, builds a `ClientEnvelope` with `ClientEvent::ClientMessage` containing a JSON-RPC initialize request, wraps ids in `ClientId`/`StreamId`, sets `seq_id` to `Some(0)`, and returns it.

**Call relations**: Used by many tests as the canonical connection-opening message fed into `handle_message`.

*Call graph*: 4 external calls (Request, Integer, new, json!).


##### `tests::initialized_notification`  (lines 484–489)

```
fn initialized_notification() -> JSONRPCMessage
```

**Purpose**: Creates a simple JSON-RPC `initialized` notification for tests. It is used as a generic follow-up inbound message.

**Data flow**: Returns a `JSONRPCMessage::Notification` with method `initialized` and no params.

**Call relations**: Used by tests that need a non-initialize message after a connection has been opened.

*Call graph*: 1 external calls (Notification).


##### `tests::cancelled_outbound_task_emits_connection_closed`  (lines 492–549)

```
async fn cancelled_outbound_task_emits_connection_closed()
```

**Purpose**: Verifies that when a client's outbound worker is cancelled, bookkeeping can identify the client and closing it emits a `ConnectionClosed` transport event. It covers the worker-exit cleanup path.

**Data flow**: Creates channels and a tracker, opens a client via `handle_message`, captures the emitted `ConnectionOpened` and forwarded initialize, cancels the provided disconnect token, waits for `bookkeep_join_set` to return the client key, calls `close_client`, and asserts that the transport queue receives the matching `ConnectionClosed` event.

**Call relations**: Exercises the interaction among `handle_message`, `run_client_outbound`, `bookkeep_join_set`, and `close_client`.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, from_secs, initialize_envelope, assert_eq!, channel, panic!, timeout).


##### `tests::shutdown_cancels_blocked_outbound_forwarding`  (lines 552–606)

```
async fn shutdown_cancels_blocked_outbound_forwarding()
```

**Purpose**: Ensures tracker shutdown does not hang even when a client's outbound worker is blocked trying to forward to a full server-event queue. It validates cancellation behavior under backpressure.

**Data flow**: Prefills a one-slot server-event queue, opens a client, obtains its writer from the `ConnectionOpened` event, enqueues an outbound message to block forwarding, then awaits `client_tracker.shutdown()` under a timeout and expects it to complete.

**Call relations**: Tests `shutdown`, worker cancellation, and the disconnect-token path in `run_client_outbound`.

*Call graph*: calls 2 internal fn (new, new); 10 external calls (new, from_secs, ConfigWarning, AppServerNotification, initialize_envelope, new, new, channel, panic!, timeout).


##### `tests::non_close_transport_event_send_times_out_when_queue_stays_full`  (lines 609–631)

```
async fn non_close_transport_event_send_times_out_when_queue_stays_full()
```

**Purpose**: Checks that forwarding a non-close transport event fails with `Stopped` when the transport-event queue remains full past the configured timeout. It validates the timeout guard in `send_transport_event`.

**Data flow**: Creates a tracker with a one-slot transport queue, pre-fills that queue, calls `send_transport_event` with an `IncomingMessage`, and asserts that the result is an error.

**Call relations**: Directly exercises the timeout branch of `send_transport_event`.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, initialized_notification, assert!, channel, next_connection_id).


##### `tests::incoming_message_timeout_does_not_advance_seq_id`  (lines 634–693)

```
async fn incoming_message_timeout_does_not_advance_seq_id()
```

**Purpose**: Verifies that if forwarding an inbound message times out, the client's deduplication sequence id is not advanced, allowing a retry to be delivered later. It protects against losing retried messages under backpressure.

**Data flow**: Opens a client with an explicit stream id, pre-fills the transport queue so a follow-up message send fails, sends a retry envelope with `seq_id = Some(1)` and asserts `handle_message` errors, drains the queue, sends the same envelope again, and asserts the retried message is forwarded to the original connection id.

**Call relations**: Exercises `handle_message`, `send_transport_event`, and `record_inbound_message_delivery` together.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, initialize_envelope_with_stream_id, initialized_notification, new, new, assert!, assert_eq!, channel, panic!, next_connection_id).


##### `tests::initialize_timeout_closes_open_connection`  (lines 696–730)

```
async fn initialize_timeout_closes_open_connection()
```

**Purpose**: Ensures that if forwarding the initial initialize message times out after a connection has been opened, the tracker rolls back by emitting a close event without waiting for close delivery in the same blocked context. It validates initialize rollback behavior.

**Data flow**: Creates a tracker with a one-slot transport queue, spawns `handle_message` for an initialize envelope so the queue fills on `ConnectionOpened`, asserts the task returns an error quickly, then reads the queued `ConnectionOpened` and subsequent `ConnectionClosed` events and checks they reference the same connection id.

**Call relations**: Tests the rollback path in `handle_message` that uses `remove_client`, cancellation, and `spawn_connection_closed`.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, initialize_envelope_with_stream_id, assert!, assert_eq!, channel, panic!, spawn).


##### `tests::close_client_waits_for_transport_event_queue_capacity`  (lines 733–795)

```
async fn close_client_waits_for_transport_event_queue_capacity()
```

**Purpose**: Checks that `close_client` waits for transport queue capacity when delivering a close event, rather than dropping it. It validates the awaited detached-close semantics.

**Data flow**: Opens a client, pre-fills the transport queue with two incoming messages, starts `close_client` and confirms it remains pending under a short timeout, drains the queued messages, then awaits `close_client` and asserts the subsequent `ConnectionClosed` event matches the client's connection id.

**Call relations**: Exercises `close_client`, `send_transport_event`, and `send_connection_closed` under queue backpressure.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, initialize_envelope_with_stream_id, initialized_notification, new, new, assert!, assert_eq!, channel, panic!, pin!).


##### `tests::close_client_keeps_forwarding_after_caller_is_aborted`  (lines 798–856)

```
async fn close_client_keeps_forwarding_after_caller_is_aborted()
```

**Purpose**: Verifies that once `close_client` has spawned detached close delivery, aborting the caller task does not prevent the `ConnectionClosed` event from eventually reaching the transport queue. It protects cleanup against task cancellation.

**Data flow**: Opens a client, pre-fills the transport queue, spawns `close_client` in a task and confirms it blocks, aborts that task, drains the prefilled events, then waits for and asserts receipt of the detached `ConnectionClosed` event.

**Call relations**: Specifically tests the detached-task behavior implemented by `spawn_connection_closed` and awaited by `send_connection_closed`.

*Call graph*: calls 1 internal fn (new); 12 external calls (new, from_secs, initialize_envelope_with_stream_id, initialized_notification, new, new, assert!, assert_eq!, channel, panic! (+2 more)).


##### `tests::initialize_with_new_stream_id_opens_new_connection_for_same_client`  (lines 859–892)

```
async fn initialize_with_new_stream_id_opens_new_connection_for_same_client()
```

**Purpose**: Ensures that the same logical client id can open distinct connections when it uses different stream ids. It validates stream-id-based multiplexing.

**Data flow**: Creates a tracker, sends two initialize envelopes for the same client id but different stream ids, reads the two `ConnectionOpened` events, and asserts the resulting connection ids differ.

**Call relations**: Exercises the `(ClientId, StreamId)` keying logic in `handle_message`.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, initialize_envelope_with_stream_id, assert_ne!, channel, panic!).


##### `tests::legacy_initialize_without_stream_id_resets_inbound_seq_id`  (lines 895–937)

```
async fn legacy_initialize_without_stream_id_resets_inbound_seq_id()
```

**Purpose**: Checks the legacy no-stream-id compatibility path, ensuring a fresh initialize resets deduplication so a follow-up message with sequence id 0 is still forwarded. It protects older clients during migration.

**Data flow**: Opens a legacy client with no stream id, captures its connection id, sends a follow-up notification envelope also lacking a stream id and carrying `seq_id = Some(0)`, and asserts that the message is forwarded rather than dropped as a duplicate.

**Call relations**: Exercises the legacy stream-id fallback and sequence-id handling branches in `handle_message`.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, Notification, initialize_envelope, new, assert_eq!, channel, panic!).


### `app-server-transport/src/transport/remote_control/websocket.rs`

`domain_logic` · `remote-control startup, connection management, reconnect loop, and live message transport`

This file is the core remote-control transport driver. `RemoteControlWebsocket` owns configuration, auth state, desired-state watches, current enrollment, persistence hooks, a `ClientTracker`, and a shared `WebsocketState`. The run loop waits for an optional app-server client name, resolves `Unknown` desired state from persisted enrollment, blocks until enabled, then repeatedly connects and runs a websocket session until disabled or shutdown. Connection setup is layered: `connect_remote_control_websocket` first ensures Rustls is initialized, then `prepare_remote_control_enrollment` loads ChatGPT auth, reconciles account changes, loads or creates persisted enrollment, refreshes server tokens when needed, and updates published environment ID.

`WebsocketState` tracks outbound replay state (`BoundedOutboundBuffer`), subscribe cursor, per-stream sequence numbers, completed inbound chunk cursors, and a `ClientSegmentReassembler`. The writer task replays buffered server envelopes after reconnect, assigns contiguous per-stream `seq_id`s, splits oversized server envelopes into transport chunks, enforces a bounded in-flight buffer using a watch channel, and emits periodic ping frames. The reader task enforces pong deadlines, deserializes `ClientEnvelope`s, drops duplicate/replayed/oversized chunks, reassembles segmented client messages, forwards completed events into `ClientTracker`, records subscribe cursors and ACKs, and invalidates chunk state when streams or clients close.

The file also handles nuanced backend failures: explicit websocket 404 bodies indicating a missing remote app server trigger enrollment replacement; generic 404s preserve enrollment; 401/403 websocket failures clear only the server token to force refresh; auth failures during enroll/refresh can invoke auth recovery without spuriously waking reconnect logic. The embedded tests validate these edge cases, plus status publishing semantics, reconnect backoff reset, ping emission, ack semantics, and chunk replay rules.

#### Function details

##### `BoundedOutboundBuffer::new`  (lines 93–100)

```
fn new() -> (Self, watch::Receiver<usize>)
```

**Purpose**: Creates an empty outbound replay buffer plus a watch receiver that tracks how many buffered server envelopes are currently retained. The watch channel is used for backpressure in the writer loop.

**Data flow**: Allocates a `watch::channel(0)` for used-count tracking, initializes `buffer_by_stream` as an empty `HashMap<(ClientId, StreamId), VecDeque<ServerEnvelope>>`, and returns `(BoundedOutboundBuffer, watch::Receiver<usize>)`.

**Call relations**: Constructed by `RemoteControlWebsocket::new` for production state and by many tests that exercise acking, replay, and reader/writer behavior.

*Call graph*: called by 17 (new, outbound_buffer_acks_by_stream_id, outbound_buffer_advances_segmented_acks_by_wire_cursor, outbound_buffer_retains_unacked_messages_until_ack_advances, outbound_buffer_treats_segmentless_acks_as_seq_level_acks, run_server_writer_inner_assigns_contiguous_seq_ids_per_stream, run_server_writer_inner_sends_periodic_ping_frames, run_websocket_reader_inner_times_out_without_pong_frames, websocket_state_allows_replay_after_later_chunk_drops, websocket_state_allows_replay_after_rejected_out_of_order_chunk (+7 more)); 2 external calls (new, channel).


##### `BoundedOutboundBuffer::insert`  (lines 102–111)

```
fn insert(&mut self, server_envelope: &ServerEnvelope)
```

**Purpose**: Adds a sent `ServerEnvelope` to the per-client/per-stream replay buffer and increments the tracked usage count. This preserves messages until the remote side ACKs them.

**Data flow**: Reads the envelope's `client_id` and `stream_id`, clones the envelope into the corresponding `VecDeque`, and updates `used_tx` with `send_modify` to increment the buffered count.

**Call relations**: Used inside the websocket writer after splitting and serializing outbound server events so reconnects can replay unacked messages.

*Call graph*: 2 external calls (send_modify, clone).


##### `BoundedOutboundBuffer::ack`  (lines 113–139)

```
fn ack(
        &mut self,
        client_id: &ClientId,
        stream_id: &StreamId,
        acked_seq_id: u64,
        acked_segment_id: Option<usize>,
    )
```

**Purpose**: Removes buffered server envelopes up to an acknowledged wire cursor for one `(client_id, stream_id)` pair. It supports both whole-message and segmented ACK semantics.

**Data flow**: Takes client/stream identifiers plus `acked_seq_id` and optional `acked_segment_id`, computes an ack cursor where missing segment IDs mean `usize::MAX`, retains only envelopes whose `(seq_id, segment_id)` cursor is greater than the ack cursor, decrements the usage watch count for each removed envelope, and deletes the stream entry if it becomes empty.

**Call relations**: Called from `WebsocketState::record_client_message_delivery` when an inbound client ACK event is successfully delivered.

*Call graph*: called by 1 (record_client_message_delivery); 2 external calls (clone, clone).


##### `BoundedOutboundBuffer::server_envelopes`  (lines 141–145)

```
fn server_envelopes(&self) -> impl Iterator<Item = &ServerEnvelope>
```

**Purpose**: Exposes an iterator over all currently buffered server envelopes across streams. It is used to replay unacked messages after reconnect.

**Data flow**: Reads `buffer_by_stream.values()` and flattens each `VecDeque<ServerEnvelope>` into a single iterator of borrowed envelopes.

**Call relations**: Consumed by the writer startup path before it begins sending newly queued server events.


##### `WebsocketState::observe_client_message`  (lines 157–200)

```
fn observe_client_message(
        &mut self,
        client_envelope: ClientEnvelope,
        wire_size_bytes: usize,
    ) -> ClientSegmentObservation
```

**Purpose**: Applies duplicate, replay, ordering, and size checks to an inbound `ClientEnvelope`, then delegates valid chunk assembly to `ClientSegmentReassembler`. It decides whether a message should be forwarded, held pending, or dropped.

**Data flow**: Takes a `ClientEnvelope` and its wire size, derives an optional chunk key via `client_message_key`, drops messages whose sequence was already completed, drops duplicate/out-of-order chunks according to `should_ignore_chunk`, drops oversized chunk frames and invalidates the stream assembly state when appropriate, otherwise passes the envelope into `client_segment_reassembler.observe(...)` and returns a `ClientSegmentObservation`.

**Call relations**: Called by the reader loop after JSON deserialization and before forwarding to `ClientTracker`; tests also invoke it through a helper to validate chunk-state edge cases.

*Call graph*: calls 3 internal fn (invalidate_stream, observe, should_ignore_chunk); called by 1 (observe_client_message); 2 external calls (client_message_key, warn!).


##### `WebsocketState::record_client_message_delivery`  (lines 202–225)

```
fn record_client_message_delivery(
        &mut self,
        client_envelope: &ClientEnvelope,
        client_message_key: Option<((ClientId, Option<StreamId>), u64)>,
    )
```

**Purpose**: Commits side effects after a client envelope has been successfully handed to the tracker: advancing subscribe cursor, marking chunk sequences complete, and applying ACKs to outbound replay state.

**Data flow**: Reads `client_envelope.cursor` to update `subscribe_cursor`, stores the completed `(client, optional stream) -> seq_id` cursor when provided, and if the event is `ClientEvent::Ack` with both `seq_id` and `stream_id`, forwards the ack cursor into `outbound_buffer.ack(...)`.

**Call relations**: Invoked by the reader loop only after `ClientTracker::handle_message` succeeds, ensuring replay cursors advance only for delivered messages.

*Call graph*: calls 1 internal fn (ack).


##### `WebsocketState::invalidate_client_message_stream`  (lines 227–230)

```
fn invalidate_client_message_stream(&mut self, client_id: &ClientId, stream_id: &StreamId)
```

**Purpose**: Clears the completed inbound chunk cursor for one client stream. This allows future messages on that stream to restart sequence tracking after closure or invalidation.

**Data flow**: Clones the provided `ClientId` and `StreamId` into the composite key and removes that entry from `last_completed_client_chunk_seq_id_by_stream`.

**Call relations**: Used by the reader loop when a stream is closed or swept idle, and by tests validating cursor reset behavior.

*Call graph*: 2 external calls (clone, clone).


##### `WebsocketState::invalidate_client_message_client`  (lines 232–235)

```
fn invalidate_client_message_client(&mut self, client_id: &ClientId)
```

**Purpose**: Clears all completed inbound chunk cursors for a client across streams. It resets replay suppression after a whole-client close.

**Data flow**: Retains only map entries whose stored client ID differs from the provided `client_id`, effectively deleting all cursors for that client.

**Call relations**: Called by the reader loop when a `ClientClosed` event closes the entire client rather than a single stream.


##### `WebsocketState::client_message_key`  (lines 237–251)

```
fn client_message_key(
        client_envelope: &ClientEnvelope,
    ) -> Option<((ClientId, Option<StreamId>), u64)>
```

**Purpose**: Extracts the deduplication/replay key for segmented client messages. Only `ClientMessageChunk` events with a `seq_id` participate.

**Data flow**: Inspects `client_envelope.event` and `client_envelope.seq_id`; for chunk events with a present sequence number it returns `((ClientId, Option<StreamId>), seq_id)`, otherwise `None`.

**Call relations**: Used by the reader loop before observation and by `observe_client_message` itself to coordinate replay suppression and completion tracking.

*Call graph*: called by 1 (run_websocket_reader_inner).


##### `RemoteControlStatusPublisher::new`  (lines 323–325)

```
fn new(tx: watch::Sender<RemoteControlStatusChangedNotification>) -> Self
```

**Purpose**: Wraps a watch sender for `RemoteControlStatusChangedNotification` in a small publisher type. This centralizes status mutation logic and logging.

**Data flow**: Takes a `watch::Sender<RemoteControlStatusChangedNotification>` and stores it in `RemoteControlStatusPublisher`.

**Call relations**: Constructed by startup/orchestration code and by tests that need to observe status transitions.

*Call graph*: called by 4 (enable, start_remote_control, plain_start_resolves_persisted_remote_control_preference, remote_control_status_channel).


##### `RemoteControlStatusPublisher::status`  (lines 327–329)

```
fn status(&self) -> RemoteControlStatusChangedNotification
```

**Purpose**: Returns the current published remote-control status snapshot. It is a cheap read helper around the watch channel.

**Data flow**: Borrows the current watch value and clones the `RemoteControlStatusChangedNotification` out of it.

**Call relations**: Used by the main run loop and connect logic for logging current status before and after connection cycles.

*Call graph*: called by 1 (run); 1 external calls (borrow).


##### `RemoteControlStatusPublisher::publish_status`  (lines 331–355)

```
fn publish_status(&self, connection_status: RemoteControlConnectionStatus)
```

**Purpose**: Updates only the connection-status portion of the published remote-control status and logs transitions. It preserves other fields such as server name and environment ID via `remote_control_status_with_connection_status`.

**Data flow**: Takes a `RemoteControlConnectionStatus`, computes the next notification from the current one, uses `send_if_modified` to avoid redundant updates, and if a change occurred logs previous/next status and environment IDs.

**Call relations**: Called by `RemoteControlWebsocket::run` and `RemoteControlWebsocket::connect` when entering connecting, connected, errored, or disabled states.

*Call graph*: called by 2 (connect, run); 2 external calls (send_if_modified, info!).


##### `RemoteControlStatusPublisher::publish_environment_id`  (lines 357–387)

```
fn publish_environment_id(&self, environment_id: Option<String>)
```

**Purpose**: Updates the published environment ID while leaving the current connection status intact, except when status is already `Disabled`. It suppresses no-op updates and logs changes.

**Data flow**: Takes `Option<String>`, builds a replacement `RemoteControlStatusChangedNotification` with the same status/server/install fields, uses `send_if_modified` to skip duplicates or disabled-state changes, and logs previous versus next environment IDs when modified.

**Call relations**: Used during enrollment preparation and persistence replacement so observers see which environment the websocket is targeting.

*Call graph*: called by 2 (enroll_and_persist_remote_control_server, prepare_remote_control_enrollment); 2 external calls (send_if_modified, info!).


##### `RemoteControlWebsocket::new`  (lines 401–449)

```
fn new(
        config: RemoteControlWebsocketConfig,
        state_db: Option<Arc<StateRuntime>>,
        auth_manager: Arc<AuthManager>,
        channels: RemoteControlChannels,
        shutdown_tok
```

**Purpose**: Constructs the remote-control websocket driver with all channels, shared state, auth watchers, and helper objects initialized. It wires together client tracking, outbound buffering, desired-state watches, and shutdown scoping.

**Data flow**: Consumes config, optional `StateRuntime`, shared `AuthManager`, channel bundle, shutdown token, and desired-state sender; creates a child cancellation token, server-event channel, `ClientTracker`, `BoundedOutboundBuffer`, auth recovery state, auth-change receiver, desired-state receiver, and initial `WebsocketState`; then returns a fully populated `RemoteControlWebsocket`.

**Call relations**: Called by higher-level startup code to create the long-lived remote-control task; tests also instantiate it directly to exercise loop behavior.

*Call graph*: calls 2 internal fn (new, new); called by 3 (start_remote_control, plain_start_resolves_persisted_remote_control_preference, run_remote_control_websocket_loop_shutdown_cancels_reconnect_backoff); 6 external calls (new, child_token, new, new, default, channel).


##### `RemoteControlWebsocket::run`  (lines 455–557)

```
async fn run(
        mut self,
        app_server_client_name_rx: Option<oneshot::Receiver<String>>,
    )
```

**Purpose**: Runs the top-level remote-control websocket lifecycle: wait for client name, resolve unknown preference, wait until enabled, connect, run a connection cycle, and repeat until shutdown. It is the main orchestration loop for this subsystem.

**Data flow**: Consumes `self` and an optional oneshot receiver for app-server client name, logs startup, waits for the client name or shutdown, stores the pairing persistence key, optionally resolves `Unknown` desired state from persisted enrollment, then loops: wait until enabled, connect, run the connection workers, log the end reason, and finally shut down the `ClientTracker` before exiting.

**Call relations**: This is the file's central driver. It delegates to `wait_for_app_server_client_name`, `resolve_unknown_desired_state`, `wait_until_enabled`, `connect`, and `run_connection`, and reacts to disabled/shutdown outcomes from those helpers.

*Call graph*: calls 7 internal fn (publish_status, status, connect, resolve_unknown_desired_state, run_connection, wait_for_app_server_client_name, wait_until_enabled); 5 external calls (child_token, send_replace, info!, matches!, warn!).


##### `RemoteControlWebsocket::wait_for_app_server_client_name`  (lines 559–575)

```
async fn wait_for_app_server_client_name(
        &self,
        app_server_client_name_rx: Option<oneshot::Receiver<String>>,
    ) -> Result<Option<String>, ()>
```

**Purpose**: Waits for an optional app-server client name to arrive, unless shutdown happens first. It normalizes the absence of a receiver into `Ok(None)`.

**Data flow**: If given a `oneshot::Receiver<String>`, it `select!`s between shutdown cancellation and receiver completion, returning `Ok(Some(name))` on success or `Err(())` on cancellation/closed sender. Without a receiver it returns `Ok(None)` immediately.

**Call relations**: Used only by `run` during startup so persistence keys and desired-state resolution can be scoped to the eventual client name.

*Call graph*: called by 1 (run); 1 external calls (select!).


##### `RemoteControlWebsocket::resolve_unknown_desired_state`  (lines 577–643)

```
async fn resolve_unknown_desired_state(
        &mut self,
        app_server_client_name: Option<&str>,
    ) -> bool
```

**Purpose**: Resolves `RemoteControlDesiredState::Unknown` into `Enabled` or `Disabled` by normalizing the remote-control URL, loading auth, and consulting persisted enrollment state. It retries while auth or state access is temporarily unavailable.

**Data flow**: Normalizes `self.remote_control_url` into a `RemoteControlTarget`, stores it, falls back to `Disabled` if URL invalid or no state DB exists, then loops while desired state remains `Unknown`: load remote-control auth, query persisted enrollment by websocket URL/account/client name, convert that enrollment into a desired state with `desired_state_from_persisted_enrollment`, and transition the watch value. On auth/state errors it logs and waits via `wait_for_preference_resolution_retry`.

**Call relations**: Called once from `run` before the main enable/connect loop when startup begins with an unknown preference.

*Call graph*: calls 5 internal fn (load_remote_control_auth, desired_state_from_persisted_enrollment, normalize_remote_control_url, transition_unknown_to, wait_for_preference_resolution_retry); called by 1 (run); 3 external calls (info!, matches!, warn!).


##### `RemoteControlWebsocket::transition_unknown_to`  (lines 645–653)

```
fn transition_unknown_to(&self, desired_state: RemoteControlDesiredState)
```

**Purpose**: Atomically changes desired state only if it is still `Unknown`. This prevents races from overwriting a newer explicit state.

**Data flow**: Uses `desired_state_tx.send_if_modified` to inspect the current state and replace it with the provided `RemoteControlDesiredState` only when the current value matches `Unknown`.

**Call relations**: A small helper used by `resolve_unknown_desired_state` after URL validation or persisted-state lookup.

*Call graph*: called by 1 (resolve_unknown_desired_state).


##### `RemoteControlWebsocket::wait_for_preference_resolution_retry`  (lines 655–661)

```
async fn wait_for_preference_resolution_retry(&mut self) -> bool
```

**Purpose**: Sleeps or exits while waiting to retry desired-state resolution. It wakes early on shutdown or any desired-state change.

**Data flow**: Uses `tokio::select!` over shutdown cancellation, `desired_state_rx.changed()`, and a fixed sleep of `REMOTE_CONTROL_ACCOUNT_ID_RETRY_INTERVAL`, returning `false` only on shutdown and `true` otherwise.

**Call relations**: Used inside the retry loop of `resolve_unknown_desired_state` after transient auth or state lookup failures.

*Call graph*: called by 1 (resolve_unknown_desired_state); 1 external calls (select!).


##### `RemoteControlWebsocket::wait_until_enabled`  (lines 663–668)

```
async fn wait_until_enabled(&mut self) -> bool
```

**Purpose**: Blocks until remote control becomes enabled or shutdown occurs. It is the gate between connection cycles.

**Data flow**: Selects between `shutdown_token.cancelled()` and `desired_state_rx.wait_for(|state| state.is_enabled())`, returning `true` when enablement is observed and `false` on shutdown/watch closure.

**Call relations**: Called by `run` before each connection cycle so the websocket stays dormant while disabled.

*Call graph*: called by 1 (run); 1 external calls (select!).


##### `RemoteControlWebsocket::connect`  (lines 670–830)

```
async fn connect(
        &mut self,
        shutdown_token: &CancellationToken,
        app_server_client_name: Option<&str>,
    ) -> ConnectOutcome
```

**Purpose**: Attempts to establish a websocket connection, handling URL normalization, enrollment preparation, auth-change retries, disabled-state interruption, and reconnect backoff. It returns either a live websocket stream, a disabled outcome, or shutdown.

**Data flow**: Publishes `Connecting`, ensures `remote_control_target` is available or marks status `Errored` for invalid URLs, then loops: snapshot subscribe cursor and current enrollment, build `RemoteControlConnectOptions` and `RemoteControlAuthContext`, race connection work against shutdown and disablement, and on success reset reconnect counters and publish `Connected`. On failure it either uses a short retry for `WouldBlock`, or publishes `Errored`, computes exponential backoff via `next_reconnect_delay`, logs details, and waits for shutdown, disablement, auth change, or timeout before retrying.

**Call relations**: Invoked by `run` for each connection cycle. It delegates the actual handshake and enrollment work to `connect_remote_control_websocket` and reacts to auth-change watch notifications by resetting recovery state and backoff.

*Call graph*: calls 3 internal fn (normalize_remote_control_url, publish_status, next_reconnect_delay); called by 1 (run); 8 external calls (new, snapshot, Connected, borrow, clone, info!, select!, warn!).


##### `RemoteControlWebsocket::run_connection`  (lines 832–875)

```
async fn run_connection(
        &self,
        websocket_connection: WebSocketStream<MaybeTlsStream<TcpStream>>,
        shutdown_token: CancellationToken,
    ) -> ConnectionEndReason
```

**Purpose**: Runs one established websocket session by spawning independent writer and reader workers and waiting for shutdown, disablement, or worker termination. It also coordinates orderly cancellation and join behavior.

**Data flow**: Splits the websocket stream into sink/stream halves, spawns `run_server_writer` and `run_websocket_reader` in a `JoinSet`, waits on shutdown token, desired-state disablement, or the first worker exit, cancels the child shutdown token, joins or aborts remaining workers via `join_connection_workers`, and returns a `ConnectionEndReason`.

**Call relations**: Called by `run` after a successful `connect`; it is the per-connection supervisor for the two worker tasks.

*Call graph*: called by 1 (run); 9 external calls (cancel, clone, join_connection_workers, run_server_writer, run_websocket_reader, split, clone, select!, new).


##### `RemoteControlWebsocket::join_connection_workers`  (lines 877–895)

```
async fn join_connection_workers(
        join_set: &mut tokio::task::JoinSet<()>,
        shutdown_timeout: std::time::Duration,
    )
```

**Purpose**: Waits for all connection workers to stop within a timeout, aborting them if they hang. This prevents reconnect cycles from stalling indefinitely on shutdown.

**Data flow**: Runs `drain_join_set` under `tokio::time::timeout`; if workers finish in time it returns, otherwise it logs a warning with remaining worker count, aborts all tasks, and drains the join set afterward.

**Call relations**: Used by `run_connection` during normal teardown and directly by a unit test that verifies stuck workers are aborted.

*Call graph*: called by 1 (join_connection_workers_aborts_stuck_worker_after_timeout); 4 external calls (abort_all, drain_join_set, timeout, warn!).


##### `RemoteControlWebsocket::drain_join_set`  (lines 897–899)

```
async fn drain_join_set(join_set: &mut tokio::task::JoinSet<()>)
```

**Purpose**: Consumes all remaining task completions from a `JoinSet`. It is a small utility for worker teardown.

**Data flow**: Loops on `join_set.join_next().await` until it returns `None`, discarding task outputs.

**Call relations**: Called by `join_connection_workers` in both the graceful and forced-abort paths.

*Call graph*: 1 external calls (join_next).


##### `RemoteControlWebsocket::run_server_writer`  (lines 901–926)

```
async fn run_server_writer(
        state: Arc<Mutex<WebsocketState>>,
        server_event_rx: Arc<Mutex<mpsc::Receiver<super::QueuedServerEnvelope>>>,
        used_rx: watch::Receiver<usize>,
```

**Purpose**: Wrapper around the outbound writer loop that converts its `io::Result` into warning logs. It distinguishes clean stop from disconnection.

**Data flow**: Invokes `run_server_writer_inner(...)`, awaits the result, and logs either a disconnect warning with the error or a generic stopped warning.

**Call relations**: Spawned by `run_connection` as one of the two per-connection workers.

*Call graph*: 2 external calls (run_server_writer_inner, warn!).


##### `RemoteControlWebsocket::run_server_writer_inner`  (lines 932–1064)

```
async fn run_server_writer_inner(
        state: Arc<Mutex<WebsocketState>>,
        server_event_rx: Arc<Mutex<mpsc::Receiver<super::QueuedServerEnvelope>>>,
        mut used_rx: watch::Receiver<usiz
```

**Purpose**: Sends buffered and newly queued server envelopes over the websocket, assigns per-stream sequence numbers, chunks oversized messages, enforces bounded in-flight buffering, and emits periodic ping frames. It is the outbound transport engine.

**Data flow**: First clones all buffered `ServerEnvelope`s from `state.outbound_buffer` and sends them as JSON text frames. Then it creates a periodic ping interval and locks the shared `server_event_rx`. In the main loop it checks whether buffered usage is below `CHANNEL_CAPACITY`; if full it waits for `used_rx` changes, otherwise it receives a queued server envelope, assigns the next per-stream `seq_id`, wraps it in `ServerEnvelope`, splits it with `split_server_envelope_for_transport`, serializes each resulting envelope, inserts each into the outbound buffer, sends each payload as a text frame, advances `next_seq_id_by_stream`, and signals any `write_complete_tx`.

**Call relations**: Called by the wrapper worker and exercised directly by tests for ping emission and contiguous sequence numbering. It depends on ACK processing in the reader to free buffer capacity.

*Call graph*: calls 1 internal fn (split_server_envelope_for_transport); called by 2 (run_server_writer_inner_assigns_contiguous_seq_ids_per_stream, run_server_writer_inner_sends_periodic_ping_frames); 8 external calls (set_missed_tick_behavior, with_capacity, error!, borrow, to_string, select!, now, interval_at).


##### `RemoteControlWebsocket::run_websocket_reader`  (lines 1066–1086)

```
async fn run_websocket_reader(
        client_tracker: Arc<Mutex<ClientTracker>>,
        state: Arc<Mutex<WebsocketState>>,
        websocket_reader: SplitStream<WebSocketStream<MaybeTlsStream<TcpStr
```

**Purpose**: Wrapper around the inbound reader loop that logs whether the reader stopped cleanly or due to an error. It mirrors the writer wrapper.

**Data flow**: Awaits `run_websocket_reader_inner(...)` and logs either a disconnect warning with the returned error or a generic stopped warning.

**Call relations**: Spawned by `run_connection` as the inbound worker.

*Call graph*: 2 external calls (run_websocket_reader_inner, warn!).


##### `RemoteControlWebsocket::run_websocket_reader_inner`  (lines 1092–1235)

```
async fn run_websocket_reader_inner(
        client_tracker: Arc<Mutex<ClientTracker>>,
        state: Arc<Mutex<WebsocketState>>,
        mut websocket_reader: SplitStream<WebSocketStream<MaybeTlsStr
```

**Purpose**: Processes inbound websocket frames, enforces pong liveness, reassembles segmented client messages, forwards completed envelopes to `ClientTracker`, and updates replay/ack state. It is the inbound transport engine.

**Data flow**: Locks `ClientTracker`, starts an idle-sweep interval and pong deadline, then loops selecting over shutdown, pong timeout, completed client tasks from `bookkeep_join_set`, idle sweeps, and incoming websocket frames. Text frames are deserialized into `ClientEnvelope`; pong frames reset the deadline; binary/unsupported frames are dropped or ignored; close/errors terminate the loop. For valid envelopes it computes a chunk key, calls `WebsocketState::observe_client_message`, forwards only `Forward` observations to `client_tracker.handle_message`, records delivery side effects with `record_client_message_delivery`, and invalidates stream/client chunk state when a `ClientClosed` event is delivered.

**Call relations**: Called by the wrapper worker and directly by a timeout test. It is tightly coupled with `WebsocketState` and `ClientTracker`, and its ACK handling feeds back into writer-side buffering.

*Call graph*: calls 1 internal fn (client_message_key); called by 1 (run_websocket_reader_inner_times_out_without_pong_frames); 9 external calls (new, format!, matches!, pin!, select!, now, interval, sleep, warn!).


##### `set_remote_control_header`  (lines 1238–1251)

```
fn set_remote_control_header(
    headers: &mut tungstenite::http::HeaderMap,
    name: &'static str,
    value: &str,
) -> io::Result<()>
```

**Purpose**: Validates and inserts one HTTP header into a websocket upgrade request. It converts header-construction failures into `io::ErrorKind::InvalidInput`.

**Data flow**: Takes a mutable `HeaderMap`, a static header name, and a string value; parses the value into `HeaderValue`, maps parse errors into `io::Error`, inserts the header, and returns `Ok(())`.

**Call relations**: Used exclusively by `build_remote_control_websocket_request` to populate all required remote-control headers.

*Call graph*: called by 1 (build_remote_control_websocket_request); 2 external calls (insert, from_str).


##### `build_remote_control_websocket_request`  (lines 1253–1301)

```
fn build_remote_control_websocket_request(
    websocket_url: &str,
    enrollment: &RemoteControlEnrollment,
    installation_id: &str,
    subscribe_cursor: Option<&str>,
) -> io::Result<tungstenite
```

**Purpose**: Builds the authenticated websocket handshake request for the remote-control server. It encodes server identity, protocol version, installation ID, optional subscribe cursor, and bearer token into headers.

**Data flow**: Parses `websocket_url` into a client request, mutates its headers with `x-codex-server-id`, base64-encoded `x-codex-name`, `x-codex-protocol-version`, `authorization: Bearer ...`, installation ID, and optional subscribe cursor, and returns the completed `Request<()>`. Missing server token becomes an `io::Error`.

**Call relations**: Called by `connect_remote_control_websocket` after enrollment preparation has produced a current enrollment with a server token.

*Call graph*: calls 1 internal fn (set_remote_control_header); called by 1 (connect_remote_control_websocket); 1 external calls (format!).


##### `next_reconnect_delay`  (lines 1303–1312)

```
fn next_reconnect_delay(reconnect_attempt: &mut u64) -> (std::time::Duration, bool)
```

**Purpose**: Computes the next reconnect delay using exponential backoff capped at a fixed maximum, and resets the attempt counter once the cap is reached. This prevents unbounded growth while still spacing retries.

**Data flow**: Reads and mutates `reconnect_attempt`, computes `backoff(*reconnect_attempt).min(REMOTE_CONTROL_RECONNECT_BACKOFF_CAP)`, determines whether the cap was hit, resets the counter to 0 on cap or increments it otherwise, and returns `(delay, reconnect_backoff_reset)`.

**Call relations**: Used by `RemoteControlWebsocket::connect` when logging and sleeping between failed connection attempts; also covered by a dedicated unit test.

*Call graph*: calls 1 internal fn (backoff); called by 2 (connect, next_reconnect_delay_resets_after_cap).


##### `connect_remote_control_websocket`  (lines 1314–1430)

```
async fn connect_remote_control_websocket(
    remote_control_target: &RemoteControlTarget,
    state_db: Option<&StateRuntime>,
    mut auth_context: RemoteControlAuthContext<'_>,
    current_enrollm
```

**Purpose**: Performs one full remote-control websocket connection attempt: prepare enrollment, build the request, connect with timeout, and translate HTTP/websocket failures into enrollment updates or rich errors. It is the handshake boundary between local state and the remote server.

**Data flow**: Ensures Rustls provider setup, locks `current_enrollment`, calls `prepare_remote_control_enrollment` to load/create/refresh enrollment and auth, clones the resulting enrollment, builds the websocket request, and runs `connect_async` under `REMOTE_CONTROL_WEBSOCKET_CONNECT_TIMEOUT`. On success it returns the websocket stream and response. On HTTP 404 with a specific JSON detail it replaces stale enrollment via `replace_remote_control_enrollment_if_matches`; on generic 404 it logs and preserves enrollment; on 401/403 it clears the server token via `clear_remote_control_server_token_if_matches` and returns an auth-refresh error; otherwise it formats a detailed connection error string.

**Call relations**: Called by `RemoteControlWebsocket::connect` inside its retry loop. It delegates enrollment/auth preparation and may mutate current enrollment in response to backend handshake failures.

*Call graph*: calls 6 internal fn (build_remote_control_websocket_request, clear_remote_control_server_token_if_matches, format_remote_control_websocket_connect_error, prepare_remote_control_enrollment, replace_remote_control_enrollment_if_matches, websocket_response_reports_missing_remote_app_server); called by 6 (connect_remote_control_websocket_includes_http_error_details, connect_remote_control_websocket_invalidates_unauthorized_server_token, connect_remote_control_websocket_recovers_after_unauthorized_enrollment, connect_remote_control_websocket_recovers_after_unauthorized_refresh, connect_remote_control_websocket_requires_chatgpt_auth, connect_remote_control_websocket_requires_sqlite_state_db); 10 external calls (as_ref, lock, other, ensure_rustls_crypto_provider, format!, info!, matches!, timeout, connect_async, warn!).


##### `prepare_remote_control_enrollment`  (lines 1432–1586)

```
async fn prepare_remote_control_enrollment(
    remote_control_target: &RemoteControlTarget,
    state_db: Option<&StateRuntime>,
    auth_context: &mut RemoteControlAuthContext<'_>,
    enrollment: &
```

**Purpose**: Ensures there is a valid in-memory enrollment ready for websocket connection, reconciling auth availability, account changes, persisted enrollment, enrollment creation, and server-token refresh. It is the main pre-connect state machine.

**Data flow**: Requires a `StateRuntime`; without one it clears enrollment and returns `NotFound`. It loads ChatGPT auth, clearing enrollment/environment on permission-denied auth failures. If the current enrollment belongs to a different account, it resolves desired state for the new account, clears in-memory enrollment, and may abort if remote control became disabled. It updates the enrollment's target, publishes environment ID from current or loaded persisted enrollment, loads persisted enrollment when none is present, then calls `enroll_and_persist_remote_control_server` with `ReuseOrCreate`. If the resulting enrollment says its server token should be refreshed, it calls `refresh_remote_control_server`; a 404 triggers replacement enrollment, a permission-denied refresh may invoke `recover_remote_control_auth` and return a retryable error, and other errors propagate.

**Call relations**: Called only by `connect_remote_control_websocket`, but it orchestrates several helpers: persisted-state lookup, desired-state reconciliation after account changes, enrollment creation, and token refresh.

*Call graph*: calls 7 internal fn (load_remote_control_auth, recover_remote_control_auth, load_persisted_remote_control_enrollment, refresh_remote_control_server, publish_environment_id, enroll_and_persist_remote_control_server, resolve_desired_state_after_account_change); called by 1 (connect_remote_control_websocket); 5 external calls (clone, new, other, format!, info!).


##### `resolve_desired_state_after_account_change`  (lines 1588–1631)

```
async fn resolve_desired_state_after_account_change(
    state_db: &StateRuntime,
    remote_control_target: &RemoteControlTarget,
    auth_manager: &Arc<AuthManager>,
    account_id: &str,
    connec
```

**Purpose**: Recomputes durable enabled/disabled preference after the authenticated account changes, but only when the current desired state represents durable enabled persistence. This prevents carrying one account's persisted preference into another account.

**Data flow**: Checks whether `desired_state_tx` currently equals durable enabled with `persistence_preference: Some(true)`; if not, returns immediately. Otherwise it acquires the persistence semaphore, rechecks the state, loads persisted enrollment for the new account from `StateRuntime`, reloads auth to ensure the account did not change again, derives the resolved desired state with `desired_state_from_persisted_enrollment`, and conditionally updates the watch sender.

**Call relations**: Invoked by `prepare_remote_control_enrollment` when it detects that the in-memory enrollment account differs from the current auth account.

*Call graph*: calls 3 internal fn (load_remote_control_auth, acquire_persistence_lock, desired_state_from_persisted_enrollment); called by 1 (prepare_remote_control_enrollment); 2 external calls (new, get_remote_control_enrollment).


##### `websocket_response_reports_missing_remote_app_server`  (lines 1633–1643)

```
fn websocket_response_reports_missing_remote_app_server(
    response: &tungstenite::http::Response<Option<Vec<u8>>>,
) -> bool
```

**Purpose**: Recognizes the specific 404 websocket HTTP response body that means the selected remote app server no longer exists. It distinguishes that case from generic 404s.

**Data flow**: Checks that the response status is 404 and, if a body exists, parses it as JSON and tests whether `detail == "Remote app server not found"`.

**Call relations**: Used by `connect_remote_control_websocket` to decide whether to replace stale enrollment or merely log and preserve it.

*Call graph*: called by 1 (connect_remote_control_websocket); 2 external calls (body, status).


##### `replace_remote_control_enrollment_if_matches`  (lines 1645–1677)

```
async fn replace_remote_control_enrollment_if_matches(
    state_db: Option<&StateRuntime>,
    remote_control_target: &RemoteControlTarget,
    auth_context: RemoteControlEnrollmentAuthContext<'_, '_
```

**Purpose**: Re-enrolls only if the current in-memory enrollment still matches the stale enrollment that triggered replacement. This avoids overwriting newer state after races.

**Data flow**: Requires a state DB, locks `current_enrollment`, compares it to the provided stale `RemoteControlEnrollment` with `same_remote_control_enrollment`, and if they match calls `enroll_and_persist_remote_control_server` with `ReplaceExisting`; otherwise it returns `Ok(())` without changing anything.

**Call relations**: Called from `connect_remote_control_websocket` after a websocket 404 explicitly reports a missing remote app server.

*Call graph*: calls 1 internal fn (enroll_and_persist_remote_control_server); called by 1 (connect_remote_control_websocket); 3 external calls (as_ref, lock, new).


##### `clear_remote_control_server_token_if_matches`  (lines 1679–1692)

```
async fn clear_remote_control_server_token_if_matches(
    current_enrollment: &CurrentRemoteControlEnrollment,
    enrollment: &RemoteControlEnrollment,
) -> io::Result<()>
```

**Purpose**: Clears only the server token on the current enrollment after websocket auth failure, but only if the enrollment still matches the one used for the failed connection. This preserves server identity while forcing token refresh.

**Data flow**: Locks `current_enrollment`, finds a mutable enrollment matching the provided one via `same_remote_control_enrollment`, calls `clear_server_token()` on it, and errors if no matching enrollment is present.

**Call relations**: Used by `connect_remote_control_websocket` when the websocket handshake returns HTTP 401 or 403.

*Call graph*: called by 1 (connect_remote_control_websocket); 2 external calls (as_mut, lock).


##### `enroll_and_persist_remote_control_server`  (lines 1694–1784)

```
async fn enroll_and_persist_remote_control_server(
    remote_control_target: &RemoteControlTarget,
    state_db: &StateRuntime,
    auth_context: RemoteControlEnrollmentAuthContext<'_, '_>,
    enrol
```

**Purpose**: Creates or replaces a remote-control enrollment by calling the backend enroll endpoint, then persists the result under the current desired-state preference. It is the enrollment creation/update primitive.

**Data flow**: Depending on `RemoteControlEnrollmentSelection`, it may return early if an enrollment already exists. It aborts if desired state is not enabled, logs enrollment creation, calls `enroll_remote_control_server`, optionally recovers auth on permission-denied failures, acquires the persistence semaphore, re-reads desired state to obtain `persistence_preference`, persists the new enrollment with `update_persisted_remote_control_enrollment`, publishes the new environment ID, and stores the new enrollment into the mutable `Option<RemoteControlEnrollment>`.

**Call relations**: Called by `prepare_remote_control_enrollment` for initial creation/reuse and by `replace_remote_control_enrollment_if_matches` when stale enrollment must be replaced.

*Call graph*: calls 5 internal fn (recover_remote_control_auth, acquire_persistence_lock, enroll_remote_control_server, update_persisted_remote_control_enrollment, publish_environment_id); called by 2 (prepare_remote_control_enrollment, replace_remote_control_enrollment_if_matches); 4 external calls (new, other, format!, info!).


##### `format_remote_control_websocket_connect_error`  (lines 1786–1805)

```
fn format_remote_control_websocket_connect_error(
    websocket_url: &str,
    err: &tungstenite::Error,
) -> String
```

**Purpose**: Formats a tungstenite connection error into a user-facing string that includes response headers and a body preview for HTTP failures. It preserves backend diagnostics for logs and retries.

**Data flow**: Starts with `failed to connect ...: {err}`; if the error is `tungstenite::Error::Http(response)`, appends formatted headers and, when the body is non-empty, a preview generated by `preview_remote_control_response_body`.

**Call relations**: Used by `connect_remote_control_websocket` for all handshake failures not handled by more specific enrollment/token branches.

*Call graph*: calls 1 internal fn (preview_remote_control_response_body); called by 1 (connect_remote_control_websocket); 1 external calls (format!).


##### `tests::remote_control_enrollment`  (lines 1853–1865)

```
fn remote_control_enrollment(remote_control_token: Option<&str>) -> RemoteControlEnrollment
```

**Purpose**: Builds a test `RemoteControlEnrollment` with optional server token and a one-hour expiry when a token is present. It is the websocket test fixture counterpart to the pairing test helper.

**Data flow**: Normalizes a fixed localhost backend URL, fills fixed account/environment/server fields, maps the optional token into `remote_control_token`, and sets `expires_at` to `now_utc() + 1 hour` only when a token exists.

**Call relations**: Used throughout the test module to seed `current_enrollment` for connect, refresh, and token invalidation scenarios.

*Call graph*: calls 1 internal fn (normalize_remote_control_url).


##### `tests::test_current_enrollment`  (lines 1867–1871)

```
fn test_current_enrollment(
        enrollment: Option<RemoteControlEnrollment>,
    ) -> CurrentRemoteControlEnrollment
```

**Purpose**: Wraps an optional enrollment in the shared `CurrentRemoteControlEnrollment` test state type. It provides the same lockable interface used in production.

**Data flow**: Takes `Option<RemoteControlEnrollment>`, constructs `RemoteControlEnrollmentState::new(enrollment)`, wraps it in `Arc`, and returns it.

**Call relations**: Used by tests that call `connect_remote_control_websocket` or instantiate `RemoteControlWebsocket` directly.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `tests::next_reconnect_delay_resets_after_cap`  (lines 1874–1891)

```
fn next_reconnect_delay_resets_after_cap()
```

**Purpose**: Verifies that reconnect backoff reaches the configured cap, reports a reset, and then restarts from a small delay on the next call.

**Data flow**: Initializes `reconnect_attempt = 9`, calls `next_reconnect_delay` twice, and asserts the first result equals the cap with reset and counter zeroing, while the second result falls back to a small initial delay and increments the counter to 1.

**Call relations**: Directly exercises the reconnect-delay helper in isolation.

*Call graph*: calls 1 internal fn (next_reconnect_delay); 2 external calls (assert!, assert_eq!).


##### `tests::websocket_404_only_reports_explicit_missing_remote_app_server`  (lines 1894–1931)

```
fn websocket_404_only_reports_explicit_missing_remote_app_server()
```

**Purpose**: Checks that only a 404 response body with the exact expected JSON detail is treated as the stale-remote-app-server signal. Other 404 bodies and non-404 statuses must not trigger replacement logic.

**Data flow**: Builds several synthetic HTTP responses with different optional bodies and statuses, calls `websocket_response_reports_missing_remote_app_server`, and asserts the expected boolean for each case.

**Call relations**: Covers the classifier used by `connect_remote_control_websocket` to decide whether to replace enrollment.

*Call graph*: 4 external calls (new, assert!, assert_eq!, builder).


##### `tests::remote_control_status_channel`  (lines 1933–1944)

```
fn remote_control_status_channel() -> (
        RemoteControlStatusPublisher,
        watch::Receiver<RemoteControlStatusChangedNotification>,
    )
```

**Purpose**: Creates a status publisher and receiver pair seeded with a `Connecting` notification. It standardizes status observation setup for tests.

**Data flow**: Creates a `watch::channel` containing `RemoteControlStatusChangedNotification { status: Connecting, server_name: "test-server", installation_id: TEST_INSTALLATION_ID, environment_id: None }` and returns `(RemoteControlStatusPublisher::new(status_tx), status_rx)`.

**Call relations**: Used by many tests that need to inspect status/environment updates during connect and enrollment flows.

*Call graph*: calls 1 internal fn (new); 1 external calls (channel).


##### `tests::enabled_desired_state_sender`  (lines 1946–1951)

```
fn enabled_desired_state_sender() -> watch::Sender<RemoteControlDesiredState>
```

**Purpose**: Builds a watch sender already set to enabled desired state. It simplifies tests that need a permissive desired-state input.

**Data flow**: Creates a `watch::channel(RemoteControlDesiredState::Enabled { persistence_preference: None })` and returns only the sender.

**Call relations**: Passed into `RemoteControlConnectOptions` by connect-related tests.

*Call graph*: 1 external calls (channel).


##### `tests::mark_recovery_auth_change_seen_marks_only_recovery_revision_seen`  (lines 1954–1966)

```
fn mark_recovery_auth_change_seen_marks_only_recovery_revision_seen()
```

**Purpose**: Verifies that marking the auth-change revision seen after recovery clears only the recovery-triggered change. It ensures reconnect loops are not spuriously awakened by recovery's own reload.

**Data flow**: Creates an auth-change watch channel, records the pre-recovery revision, increments the revision once, calls `mark_recovery_auth_change_seen`, and asserts `has_changed()` is false afterward.

**Call relations**: Tests helper behavior imported from the auth module because this websocket reconnect logic depends on correct auth-change semantics.

*Call graph*: calls 1 internal fn (mark_recovery_auth_change_seen); 2 external calls (assert!, channel).


##### `tests::mark_recovery_auth_change_seen_preserves_racing_auth_change`  (lines 1969–1982)

```
fn mark_recovery_auth_change_seen_preserves_racing_auth_change()
```

**Purpose**: Verifies that if another auth change races with recovery, the watch receiver still reports a pending change after marking the recovery revision seen. This preserves legitimate reconnect triggers.

**Data flow**: Creates a watch channel, records the initial revision, increments twice, calls `mark_recovery_auth_change_seen`, and asserts `has_changed()` remains true.

**Call relations**: Complements the previous auth-change test by covering the racing-update case.

*Call graph*: calls 1 internal fn (mark_recovery_auth_change_seen); 2 external calls (assert!, channel).


##### `tests::remote_control_state_runtime`  (lines 1984–1988)

```
async fn remote_control_state_runtime(codex_home: &TempDir) -> Arc<StateRuntime>
```

**Purpose**: Initializes a temporary `StateRuntime` for tests. It provides the sqlite-backed persistence layer required by enrollment logic.

**Data flow**: Takes a `TempDir`, calls `StateRuntime::init(codex_home.path().to_path_buf(), "test-provider")`, awaits it, and returns the resulting `Arc<StateRuntime>`.

**Call relations**: Used by tests that need persisted enrollment lookup or update behavior.

*Call graph*: calls 1 internal fn (init); 1 external calls (path).


##### `tests::remote_control_auth_manager`  (lines 1990–1992)

```
fn remote_control_auth_manager() -> Arc<AuthManager>
```

**Purpose**: Creates a simple authenticated `AuthManager` fixture backed by dummy ChatGPT auth. It avoids filesystem setup for tests that do not need auth reload behavior.

**Data flow**: Calls `CodexAuth::create_dummy_chatgpt_auth_for_testing()` and wraps it with `auth_manager_from_auth(...)`, returning `Arc<AuthManager>`.

**Call relations**: Used by many tests as the default auth source for connect and websocket loop setup.

*Call graph*: calls 2 internal fn (auth_manager_from_auth, create_dummy_chatgpt_auth_for_testing).


##### `tests::remote_control_url_for_listener`  (lines 1994–1999)

```
fn remote_control_url_for_listener(listener: &TcpListener) -> String
```

**Purpose**: Builds a backend base URL string pointing at a local test listener. It standardizes listener-to-URL conversion.

**Data flow**: Reads `listener.local_addr()` and formats `http://{addr}/backend-api/`.

**Call relations**: Used by connect-related tests that stand up raw HTTP listeners.

*Call graph*: 2 external calls (local_addr, format!).


##### `tests::remote_control_auth_dot_json`  (lines 2001–2039)

```
fn remote_control_auth_dot_json(access_token: &str) -> AuthDotJson
```

**Purpose**: Constructs an `AuthDotJson` fixture containing a fake ChatGPT JWT and the supplied access token. It supports auth-recovery tests that reload credentials from disk.

**Data flow**: Builds a fake JWT header and payload with account/user IDs, base64url-encodes them, parses claims with `parse_chatgpt_jwt_claims`, and returns `AuthDotJson` with `AuthMode::Chatgpt`, token data, and `last_refresh: Some(Utc::now())`.

**Call relations**: Used by tests that save auth to a temp codex home and then exercise `AuthManager::shared` reload/recovery behavior.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); 4 external calls (now, format!, json!, to_vec).


##### `tests::connect_remote_control_websocket_includes_http_error_details`  (lines 2042–2114)

```
async fn connect_remote_control_websocket_includes_http_error_details()
```

**Purpose**: Verifies that HTTP handshake failures are surfaced with detailed status, headers, and body preview while preserving current enrollment and published environment ID.

**Data flow**: Starts a local listener that returns HTTP 503 to the websocket GET, constructs state DB, auth manager, current enrollment, and status publisher, calls `connect_remote_control_websocket`, captures the error, and asserts the exact formatted message plus unchanged enrollment and status snapshot.

**Call relations**: Directly exercises the generic HTTP-error branch of `connect_remote_control_websocket`.

*Call graph*: calls 2 internal fn (normalize_remote_control_url, connect_remote_control_websocket); 17 external calls (new, bind, new, accept_http_request, enabled_desired_state_sender, remote_control_auth_manager, remote_control_enrollment, remote_control_state_runtime, remote_control_status_channel, remote_control_url_for_listener (+7 more)).


##### `tests::connect_remote_control_websocket_invalidates_unauthorized_server_token`  (lines 2117–2182)

```
async fn connect_remote_control_websocket_invalidates_unauthorized_server_token()
```

**Purpose**: Checks that a 401 websocket handshake clears only the server token from the current enrollment and returns the specific refresh-before-reconnect error.

**Data flow**: Runs a listener that returns HTTP 401 to the websocket GET, calls `connect_remote_control_websocket` with an enrollment containing a token, then asserts the status remains `Connecting`, the error string requests token refresh, and the current enrollment now matches the original enrollment but with `remote_control_token: None`.

**Call relations**: Covers the 401/403 auth-failure branch in `connect_remote_control_websocket`.

*Call graph*: calls 2 internal fn (normalize_remote_control_url, connect_remote_control_websocket); 14 external calls (new, bind, new, accept_http_request, enabled_desired_state_sender, remote_control_auth_manager, remote_control_enrollment, remote_control_state_runtime, remote_control_status_channel, remote_control_url_for_listener (+4 more)).


##### `tests::connect_remote_control_websocket_recovers_after_unauthorized_enrollment`  (lines 2185–2279)

```
async fn connect_remote_control_websocket_recovers_after_unauthorized_enrollment()
```

**Purpose**: Verifies that a 401 from the enroll endpoint triggers auth recovery and returns a retryable error message without leaving stale auth-change notifications pending.

**Data flow**: Creates a temp auth home with stale auth, starts a listener that returns 401 to `/enroll`, constructs `AuthManager::shared`, saves fresh auth to disk, calls `connect_remote_control_websocket` with no current enrollment, and asserts the returned error includes `; retrying after auth recovery`, the auth manager now exposes `fresh-token`, and `auth_change_rx.has_changed()` is false.

**Call relations**: Exercises the permission-denied recovery path inside `enroll_and_persist_remote_control_server`, reached through `prepare_remote_control_enrollment`.

*Call graph*: calls 4 internal fn (normalize_remote_control_url, connect_remote_control_websocket, default, shared); 15 external calls (new, bind, new, accept_http_request, enabled_desired_state_sender, remote_control_auth_dot_json, remote_control_state_runtime, remote_control_status_channel, remote_control_url_for_listener, respond_with_status_and_headers (+5 more)).


##### `tests::connect_remote_control_websocket_recovers_after_unauthorized_refresh`  (lines 2282–2382)

```
async fn connect_remote_control_websocket_recovers_after_unauthorized_refresh()
```

**Purpose**: Verifies that a 401 from the refresh endpoint triggers auth recovery and returns a retryable error while preserving status/environment publication.

**Data flow**: Creates a temp auth home with stale auth, starts a listener that returns 401 to `/refresh`, constructs a current enrollment lacking a server token, saves fresh auth to disk, calls `connect_remote_control_websocket`, and asserts the returned error includes the refresh URL and retry-after-auth-recovery suffix, the auth manager now exposes `fresh-token`, and the auth-change receiver is not spuriously marked changed.

**Call relations**: Covers the permission-denied refresh branch inside `prepare_remote_control_enrollment`.

*Call graph*: calls 4 internal fn (normalize_remote_control_url, connect_remote_control_websocket, default, shared); 16 external calls (new, bind, new, accept_http_request, enabled_desired_state_sender, remote_control_auth_dot_json, remote_control_enrollment, remote_control_state_runtime, remote_control_status_channel, remote_control_url_for_listener (+6 more)).


##### `tests::connect_remote_control_websocket_requires_sqlite_state_db`  (lines 2385–2421)

```
async fn connect_remote_control_websocket_requires_sqlite_state_db()
```

**Purpose**: Checks that remote control cannot proceed without a sqlite state DB and that current enrollment is cleared in that case.

**Data flow**: Calls `connect_remote_control_websocket` with `state_db: None`, asserts the returned error kind is `NotFound` with the expected message, and verifies `current_enrollment` becomes `None`.

**Call relations**: Exercises the earliest failure branch in `prepare_remote_control_enrollment`.

*Call graph*: calls 2 internal fn (normalize_remote_control_url, connect_remote_control_websocket); 7 external calls (new, enabled_desired_state_sender, remote_control_auth_manager, remote_control_enrollment, remote_control_status_channel, test_current_enrollment, assert_eq!).


##### `tests::connect_remote_control_websocket_requires_chatgpt_auth`  (lines 2424–2486)

```
async fn connect_remote_control_websocket_requires_chatgpt_auth()
```

**Purpose**: Checks that missing ChatGPT auth prevents remote-control websocket connection and clears published environment ID. It validates auth prerequisites.

**Data flow**: Creates an empty `AuthManager::shared`, a state DB, and a current enrollment, pre-publishes an environment ID, calls `connect_remote_control_websocket`, and asserts a `PermissionDenied` error with the expected message, `current_enrollment == None`, and status now has `environment_id: None`.

**Call relations**: Exercises the auth-loading failure branch in `prepare_remote_control_enrollment`.

*Call graph*: calls 4 internal fn (normalize_remote_control_url, connect_remote_control_websocket, default, shared); 8 external calls (new, new, enabled_desired_state_sender, remote_control_enrollment, remote_control_state_runtime, remote_control_status_channel, test_current_enrollment, assert_eq!).


##### `tests::run_remote_control_websocket_loop_shutdown_cancels_reconnect_backoff`  (lines 2489–2540)

```
async fn run_remote_control_websocket_loop_shutdown_cancels_reconnect_backoff()
```

**Purpose**: Verifies that cancelling the shutdown token interrupts reconnect sleep promptly rather than waiting for the full backoff interval.

**Data flow**: Creates a listener URL that will fail to connect, constructs a `RemoteControlWebsocket` with enabled desired state, spawns `run(None)`, sleeps briefly, cancels the shutdown token, and asserts the task joins within a short timeout.

**Call relations**: Exercises the top-level run/connect loop's shutdown responsiveness during reconnect backoff.

*Call graph*: calls 2 internal fn (normalize_remote_control_url, new); 14 external calls (new, new, from_millis, new, bind, remote_control_auth_manager, remote_control_status_channel, remote_control_url_for_listener, test_current_enrollment, channel (+4 more)).


##### `tests::publish_status_if_changed_sends_only_status_changes`  (lines 2543–2627)

```
async fn publish_status_if_changed_sends_only_status_changes()
```

**Purpose**: Checks that status/environment updates are emitted only when values actually change and that disabled status suppresses later environment-only updates.

**Data flow**: Creates a status channel, performs a sequence of `publish_environment_id` and `publish_status` calls, uses short timeouts to assert when no watch change should occur, and checks the exact notification contents after each real change.

**Call relations**: Directly validates `RemoteControlStatusPublisher` semantics used throughout the websocket lifecycle.

*Call graph*: 3 external calls (remote_control_status_channel, assert!, assert_eq!).


##### `tests::run_server_writer_inner_sends_periodic_ping_frames`  (lines 2630–2665)

```
async fn run_server_writer_inner_sends_periodic_ping_frames()
```

**Purpose**: Verifies that the writer loop emits websocket ping frames on its configured interval even when no server events are queued.

**Data flow**: Creates a connected websocket pair, initializes empty state and channels, spawns `run_server_writer_inner` with a short ping interval, waits for the server side to receive a `Ping` frame, then cancels shutdown and asserts clean writer termination.

**Call relations**: Directly exercises the ping branch of the outbound writer loop.

*Call graph*: calls 2 internal fn (new, run_server_writer_inner); 12 external calls (new, new, from_millis, from_secs, new, new, default, connected_websocket_pair, assert!, channel (+2 more)).


##### `tests::join_connection_workers_aborts_stuck_worker_after_timeout`  (lines 2668–2676)

```
async fn join_connection_workers_aborts_stuck_worker_after_timeout()
```

**Purpose**: Checks that worker teardown aborts tasks that do not finish before the timeout. It protects reconnect/shutdown from hanging workers.

**Data flow**: Creates a `JoinSet`, spawns a permanently pending future into it, calls `join_connection_workers` with a short timeout, and asserts the join set is empty afterward.

**Call relations**: Directly tests the teardown helper used by `run_connection`.

*Call graph*: calls 1 internal fn (join_connection_workers); 3 external calls (from_millis, assert!, new).


##### `tests::run_server_writer_inner_assigns_contiguous_seq_ids_per_stream`  (lines 2679–2755)

```
async fn run_server_writer_inner_assigns_contiguous_seq_ids_per_stream()
```

**Purpose**: Verifies that outbound sequence numbers are contiguous per `(client_id, stream_id)` rather than globally shared across streams.

**Data flow**: Creates a websocket pair and writer task, sends three queued server envelopes across two streams, reads three text frames from the server side, deserializes them, and asserts seq IDs are `1` for stream-1, `1` for stream-2, then `2` for stream-1.

**Call relations**: Directly exercises the sequence-assignment logic inside `run_server_writer_inner`.

*Call graph*: calls 2 internal fn (new, run_server_writer_inner); 12 external calls (new, new, from_secs, new, new, new, new, default, connected_websocket_pair, assert_eq! (+2 more)).


##### `tests::run_websocket_reader_inner_times_out_without_pong_frames`  (lines 2758–2795)

```
async fn run_websocket_reader_inner_times_out_without_pong_frames()
```

**Purpose**: Verifies that the reader loop fails with `TimedOut` if no pong frames arrive before the configured deadline.

**Data flow**: Creates a websocket pair, initializes state and `ClientTracker`, runs `run_websocket_reader_inner` with a short pong timeout under an outer timeout, and asserts the returned error kind and message indicate websocket pong timeout.

**Call relations**: Directly covers the liveness timeout branch in the inbound reader loop.

*Call graph*: calls 3 internal fn (new, new, run_websocket_reader_inner); 11 external calls (new, new, from_millis, from_secs, new, new, default, connected_websocket_pair, assert_eq!, channel (+1 more)).


##### `tests::outbound_buffer_acks_by_stream_id`  (lines 2798–2843)

```
fn outbound_buffer_acks_by_stream_id()
```

**Purpose**: Checks that ACKs remove buffered messages only for the matching client and stream, leaving other streams and clients untouched.

**Data flow**: Creates a buffer, inserts three envelopes across two clients and two streams, ACKs one client/stream up to seq 3, collects retained `(client, stream, seq)` tuples, sorts them, and asserts only the unrelated envelopes remain with used count 2.

**Call relations**: Directly validates `BoundedOutboundBuffer::ack` stream scoping.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, server_envelope, assert_eq!).


##### `tests::outbound_buffer_retains_unacked_messages_until_ack_advances`  (lines 2846–2888)

```
fn outbound_buffer_retains_unacked_messages_until_ack_advances()
```

**Purpose**: Checks that ACKing one stream to a lower cursor does not remove later or unrelated messages. It verifies conservative retention.

**Data flow**: Inserts three envelopes, ACKs only client-1/stream-1 through seq 1, then collects and asserts the remaining envelopes and used count.

**Call relations**: Another focused test of `BoundedOutboundBuffer::ack` behavior.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, server_envelope, assert_eq!).


##### `tests::outbound_buffer_advances_segmented_acks_by_wire_cursor`  (lines 2891–2916)

```
fn outbound_buffer_advances_segmented_acks_by_wire_cursor()
```

**Purpose**: Verifies that segmented ACKs with an explicit `segment_id` remove all buffered chunks up to that exact wire cursor.

**Data flow**: Inserts two chunk envelopes with the same seq ID and segment IDs 0 and 1, ACKs `(seq 4, segment 1)`, then asserts no buffered segments remain and used count is zero.

**Call relations**: Covers the segmented-cursor comparison logic in `BoundedOutboundBuffer::ack`.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, server_chunk_envelope, assert_eq!).


##### `tests::outbound_buffer_treats_segmentless_acks_as_seq_level_acks`  (lines 2919–2941)

```
fn outbound_buffer_treats_segmentless_acks_as_seq_level_acks()
```

**Purpose**: Verifies that ACKs without a segment ID are treated as acknowledging the entire sequence number, including all chunks for that seq.

**Data flow**: Inserts two chunk envelopes for seq 4, ACKs seq 4 with `acked_segment_id: None`, and asserts the buffer is emptied and used count becomes zero.

**Call relations**: Complements the explicit-segment ACK test by covering the `usize::MAX` fallback path.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, server_chunk_envelope, assert_eq!).


##### `tests::websocket_state_drops_duplicate_client_chunks_while_pending`  (lines 2944–2978)

```
fn websocket_state_drops_duplicate_client_chunks_while_pending()
```

**Purpose**: Checks that duplicate or out-of-order chunks for a message currently being assembled are dropped rather than forwarded or corrupting assembly state.

**Data flow**: Creates a fresh `WebsocketState`, builds two chunks for the same message, observes the first as `Pending`, then replays the first and second in problematic order and asserts they are dropped, finally confirming the first chunk can start assembly again.

**Call relations**: Directly exercises `WebsocketState::observe_client_message` and the reassembler's duplicate suppression.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, client_chunk_envelope, assert!).


##### `tests::websocket_state_drops_replayed_client_chunks_after_completion`  (lines 2981–3037)

```
fn websocket_state_drops_replayed_client_chunks_after_completion()
```

**Purpose**: Verifies that once a segmented client message has been fully delivered and recorded, replayed chunks for that sequence are dropped.

**Data flow**: Builds a two-chunk JSON-RPC notification, observes the first as pending and the second as forwarding a completed envelope, records delivery with seq cursor 4, then replays the first chunk and asserts it is dropped.

**Call relations**: Covers the completed-sequence replay suppression implemented by `last_completed_client_chunk_seq_id_by_stream`.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, Notification, new, new, default, client_chunk_envelope, observe_client_message, assert!, panic!, to_vec).


##### `tests::websocket_state_allows_replay_before_completed_chunk_delivery`  (lines 3040–3086)

```
fn websocket_state_allows_replay_before_completed_chunk_delivery()
```

**Purpose**: Checks that replay suppression does not activate until delivery is actually recorded. This avoids losing retries when forwarding fails before commit.

**Data flow**: Builds a two-chunk message, observes completion but intentionally does not call `record_client_message_delivery`, then replays the first chunk and asserts it is accepted as `Pending` again.

**Call relations**: Validates the separation between observation/completion and committed delivery state.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Notification, default, client_chunk_envelope, assert!, to_vec).


##### `tests::websocket_state_allows_replay_after_rejected_out_of_order_chunk`  (lines 3089–3115)

```
fn websocket_state_allows_replay_after_rejected_out_of_order_chunk()
```

**Purpose**: Verifies that dropping an out-of-order later chunk does not poison the stream so the correct first chunk can still begin assembly afterward.

**Data flow**: Observes segment 1 before segment 0 and asserts it is dropped, then observes segment 0 and asserts it becomes pending.

**Call relations**: Covers a recovery-friendly edge case in chunk ordering logic.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, client_chunk_envelope, assert!).


##### `tests::websocket_state_allows_replay_after_later_chunk_drops`  (lines 3118–3148)

```
fn websocket_state_allows_replay_after_later_chunk_drops()
```

**Purpose**: Checks that if a later chunk is dropped for invalid content, the earlier pending chunk can still be replayed to restart assembly. This prevents permanent stream poisoning from malformed later chunks.

**Data flow**: Observes a valid first chunk as pending, then an invalid second chunk as dropped, then replays the first chunk and asserts it is pending again.

**Call relations**: Another edge-case test for `observe_client_message` and reassembler invalidation behavior.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, client_chunk_envelope, assert!).


##### `tests::websocket_state_drops_oversized_client_chunk_frames`  (lines 3151–3169)

```
fn websocket_state_drops_oversized_client_chunk_frames()
```

**Purpose**: Verifies that oversized segmented client frames are dropped immediately. This enforces the transport size limit.

**Data flow**: Creates a chunk envelope and calls `state.observe_client_message` with `wire_size_bytes` one byte above `REMOTE_CONTROL_SEGMENT_MAX_BYTES`, asserting the result is `Dropped`.

**Call relations**: Directly covers the oversized-frame guard in `WebsocketState::observe_client_message`.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, default, client_chunk_envelope, assert!).


##### `tests::websocket_state_ignores_oversized_stale_chunks_without_dropping_newer_assembly`  (lines 3172–3230)

```
fn websocket_state_ignores_oversized_stale_chunks_without_dropping_newer_assembly()
```

**Purpose**: Checks that an oversized stale chunk for an older sequence does not invalidate a newer in-progress assembly on the same stream.

**Data flow**: Starts assembly for seq 8, then submits an oversized stale chunk for seq 7 and asserts it is dropped, then submits the second seq-8 chunk and asserts the message completes successfully.

**Call relations**: Validates that oversized-drop invalidation is scoped carefully enough not to break newer assemblies.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Notification, default, client_chunk_envelope, assert!, to_vec).


##### `tests::websocket_state_ignores_oversized_duplicate_chunks_without_dropping_current_assembly`  (lines 3233–3291)

```
fn websocket_state_ignores_oversized_duplicate_chunks_without_dropping_current_assembly()
```

**Purpose**: Checks that an oversized duplicate chunk for the current sequence is dropped without destroying the valid in-progress assembly.

**Data flow**: Starts assembly for seq 8 with chunk 0, submits an oversized duplicate of chunk 0 and asserts drop, then submits chunk 1 and asserts successful completion.

**Call relations**: Covers another subtle oversized-frame edge case in `observe_client_message`.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, Notification, default, client_chunk_envelope, assert!, to_vec).


##### `tests::websocket_state_clears_chunk_cursor_when_stream_is_invalidated`  (lines 3294–3331)

```
fn websocket_state_clears_chunk_cursor_when_stream_is_invalidated()
```

**Purpose**: Verifies that invalidating a stream clears completed-chunk cursor state so lower sequence numbers can be accepted again on a fresh stream lifecycle.

**Data flow**: Starts a pending assembly on client-1/stream-1, calls both `invalidate_client_message_stream` and `client_segment_reassembler.invalidate_stream`, then submits a new chunk with lower seq ID 1 and asserts it is accepted as pending.

**Call relations**: Tests the reset behavior used by the reader loop when streams close or are swept idle.

*Call graph*: calls 1 internal fn (new); 5 external calls (new, new, new, default, assert!).


##### `tests::server_envelope`  (lines 3333–3354)

```
fn server_envelope(
        client_id: &ClientId,
        stream_id: &str,
        seq_id: u64,
        summary: &str,
    ) -> ServerEnvelope
```

**Purpose**: Builds a non-segmented `ServerEnvelope` fixture carrying a config-warning notification. It is used by outbound-buffer tests.

**Data flow**: Takes client ID, stream ID string, seq ID, and summary text; constructs `ServerEvent::ServerMessage` wrapping an `OutgoingMessage::AppServerNotification(ServerNotification::ConfigWarning(...))`, and returns a `ServerEnvelope` with cloned client ID and a new `StreamId`.

**Call relations**: Used by outbound-buffer tests to populate replay state with ordinary server messages.

*Call graph*: 5 external calls (new, ConfigWarning, AppServerNotification, clone, new).


##### `tests::server_chunk_envelope`  (lines 3356–3373)

```
fn server_chunk_envelope(
        client_id: &ClientId,
        stream_id: &str,
        seq_id: u64,
        segment_id: usize,
    ) -> ServerEnvelope
```

**Purpose**: Builds a segmented `ServerEnvelope` fixture with a specific segment ID. It supports ACK tests for chunked outbound messages.

**Data flow**: Takes client ID, stream ID string, seq ID, and segment ID; constructs `ServerEvent::ServerMessageChunk` with fixed counts/sizes and returns a `ServerEnvelope`.

**Call relations**: Used by segmented ACK tests for `BoundedOutboundBuffer`.

*Call graph*: 3 external calls (new, clone, new).


##### `tests::client_chunk_envelope`  (lines 3375–3396)

```
fn client_chunk_envelope(
        client_id: &str,
        stream_id: &str,
        seq_id: u64,
        segment_id: usize,
        segment_count: usize,
        message_size_bytes: usize,
        chu
```

**Purpose**: Builds a `ClientEnvelope` chunk fixture with base64-encoded payload bytes. It standardizes segmented inbound test messages.

**Data flow**: Takes client/stream IDs, sequence and segment metadata, raw chunk bytes, base64-encodes the chunk, and returns a `ClientEnvelope` with `ClientEvent::ClientMessageChunk`, `stream_id: Some(...)`, `seq_id: Some(...)`, and no cursor.

**Call relations**: Used by many chunk-state tests to feed `WebsocketState::observe_client_message`.

*Call graph*: 2 external calls (new, new).


##### `tests::observe_client_message`  (lines 3398–3406)

```
fn observe_client_message(
        state: &mut WebsocketState,
        envelope: ClientEnvelope,
    ) -> ClientSegmentObservation
```

**Purpose**: Convenience wrapper that computes the serialized wire size for a `ClientEnvelope` before passing it into `WebsocketState::observe_client_message`. It keeps tests concise.

**Data flow**: Serializes the provided envelope to bytes to obtain `wire_size_bytes`, then calls `state.observe_client_message(envelope, wire_size_bytes)` and returns the resulting `ClientSegmentObservation`.

**Call relations**: Used by chunk-state tests so they exercise the same size-sensitive path as production code.

*Call graph*: calls 1 internal fn (observe_client_message); 1 external calls (to_vec).


##### `tests::accept_http_request`  (lines 3408–3435)

```
async fn accept_http_request(listener: &TcpListener) -> (TcpStream, String)
```

**Purpose**: Accepts one raw HTTP request from a local listener and returns the underlying stream plus request line. It is a minimal test server helper for websocket/connect tests.

**Data flow**: Accepts a `TcpStream` under a timeout, wraps it in `BufReader`, reads the request line and headers until the blank line, then returns `(reader.into_inner(), trimmed_request_line)`.

**Call relations**: Used by connect-related tests that emulate backend HTTP responses without a full HTTP server.

*Call graph*: 4 external calls (new, new, accept, timeout).


##### `tests::connected_websocket_pair`  (lines 3437–3463)

```
async fn connected_websocket_pair() -> (
        WebSocketStream<MaybeTlsStream<TcpStream>>,
        WebSocketStream<TcpStream>,
    )
```

**Purpose**: Creates an in-memory local websocket client/server pair backed by a temporary TCP listener. It supports direct reader/writer loop tests.

**Data flow**: Binds a local `TcpListener`, spawns a client `connect_async` to `ws://{addr}`, accepts the TCP connection on the server side, upgrades it with `accept_async`, awaits the client handshake, and returns `(client_stream, server_stream)`.

**Call relations**: Used by writer and reader loop tests that need a real websocket framing layer.

*Call graph*: 5 external calls (bind, format!, spawn, accept_async, connect_async).


##### `tests::read_server_text_event`  (lines 3465–3477)

```
async fn read_server_text_event(
        server_stream: &mut WebSocketStream<TcpStream>,
    ) -> serde_json::Value
```

**Purpose**: Reads one text websocket frame from the server side and deserializes it as JSON. It simplifies assertions on outbound writer output.

**Data flow**: Waits under timeout for `server_stream.next()`, asserts the message is `tungstenite::Message::Text`, and parses the text into `serde_json::Value`.

**Call relations**: Used by the contiguous-seq-id writer test.

*Call graph*: 5 external calls (from_secs, next, panic!, from_str, timeout).


##### `tests::respond_with_status_and_headers`  (lines 3479–3498)

```
async fn respond_with_status_and_headers(
        mut stream: TcpStream,
        status: &str,
        headers: &[(&str, &str)],
        body: &str,
    )
```

**Purpose**: Writes a raw HTTP response with arbitrary status, headers, and body to a test TCP stream. It is the low-level response helper for connect tests.

**Data flow**: Formats an HTTP/1.1 response string including content type, content length, connection close, and caller-supplied headers, writes it to the `TcpStream`, and flushes.

**Call relations**: Used by backend-emulation tests that need precise HTTP status/header/body control.

*Call graph*: 3 external calls (flush, write_all, format!).


### Client facades and TUI session layer
These files expose the shared app-server client API, its remote transport implementation, and the higher-level TUI session wrapper built on top of that client.

### `app-server-client/src/lib.rs`

`io_transport` · `startup, request/response handling, event streaming, and shutdown`

This crate root defines the public client abstraction for talking to the app-server. It exposes `AppServerClient` and `AppServerRequestHandle` enums that dispatch to either an embedded in-process runtime or the remote WebSocket/Unix-socket transport implemented in `remote.rs`. The in-process side is fully implemented here: `InProcessClientStartArgs` captures all startup dependencies and caller identity, `configured_thread_config_loader` selects a remote or no-op thread-config loader based on config, and `InProcessAppServerClient::start` launches the embedded runtime plus a worker task that bridges caller commands and runtime events through bounded Tokio channels.

A key design choice is explicit backpressure handling. `forward_in_process_event` classifies events into lossless and best-effort tiers using `event_requires_delivery`/`server_notification_requires_delivery`. Transcript deltas and authoritative completion notifications block until delivered; best-effort events are dropped when the consumer queue is full, incrementing a lag counter and rejecting dropped `ServerRequest`s so the server does not hang waiting for a response. Unsupported in-process `ChatgptAuthTokensRefresh` server requests are proactively rejected in the worker loop.

The file also defines `TypedRequestError`, which preserves the distinction between transport failures, server-side JSON-RPC errors, and response deserialization mismatches for typed request helpers. Public methods on `InProcessAppServerClient`, `InProcessAppServerRequestHandle`, `AppServerRequestHandle`, and `AppServerClient` mostly package commands onto channels, await oneshot responses, and delegate to the appropriate transport. Shutdown is bounded by `SHUTDOWN_TIMEOUT`; if graceful completion stalls, the worker task is aborted to avoid leaking background runtime state. Extensive tests exercise typed requests, backpressure semantics, remote transport integration, duplicate request IDs, and shutdown behavior.

#### Function details

##### `migrate_personality_if_needed`  (lines 98–110)

```
async fn migrate_personality_if_needed(
    codex_home: &Path,
    config_toml: &ConfigToml,
    state_db: Option<StateDbHandle>,
) -> IoResult<bool>
```

**Purpose**: Runs the embedded app-server personality migration and reports whether it changed persisted config.

**Data flow**: Consumes the Codex home path, parsed `ConfigToml`, and optional state DB handle, awaits `maybe_migrate_personality`, maps `Applied` to `Ok(true)` and all skip statuses to `Ok(false)`, and propagates I/O errors.

**Call relations**: Called during startup/config preparation before launching the app-server so callers know whether to reload configuration.

*Call graph*: calls 1 internal fn (maybe_migrate_personality).


##### `AppServerEvent::from`  (lines 128–136)

```
fn from(value: InProcessServerEvent) -> Self
```

**Purpose**: Converts transport-specific in-process events into the transport-agnostic `AppServerEvent` enum.

**Data flow**: Consumes an `InProcessServerEvent`, pattern-matches it, and returns `Lagged`, `ServerNotification`, or `ServerRequest` variants carrying the same payload.

**Call relations**: Used when `AppServerClient::next_event` exposes in-process events through the common client API.

*Call graph*: 2 external calls (ServerNotification, ServerRequest).


##### `event_requires_delivery`  (lines 139–150)

```
fn event_requires_delivery(event: &InProcessServerEvent) -> bool
```

**Purpose**: Determines whether an in-process event belongs to the lossless delivery tier that must not be dropped under backpressure.

**Data flow**: Reads a borrowed `InProcessServerEvent`; for server notifications it delegates to `server_notification_requires_delivery`, otherwise returns false.

**Call relations**: Called by `forward_in_process_event` to choose blocking send versus best-effort `try_send`.

*Call graph*: calls 1 internal fn (server_notification_requires_delivery); called by 1 (forward_in_process_event).


##### `server_notification_requires_delivery`  (lines 163–175)

```
fn server_notification_requires_delivery(notification: &ServerNotification) -> bool
```

**Purpose**: Classifies server notifications that must survive backpressure because dropping them would corrupt transcript state or lose terminal completion signals.

**Data flow**: Reads a borrowed `ServerNotification` and returns `true` for turn/item completion, thread settings updates, external agent config import completion, and transcript/reasoning delta notifications; returns `false` otherwise.

**Call relations**: Shared classification helper used by `event_requires_delivery`, keeping lossless notification policy centralized.

*Call graph*: called by 1 (event_requires_delivery); 1 external calls (matches!).


##### `forward_in_process_event`  (lines 196–262)

```
async fn forward_in_process_event(
    event_tx: &mpsc::Sender<InProcessServerEvent>,
    skipped_events: &mut usize,
    event: InProcessServerEvent,
    mut reject_server_request: F,
) -> ForwardEve
```

**Purpose**: Forwards one in-process runtime event to the consumer queue while enforcing the lossless/best-effort split and surfacing lag markers.

**Data flow**: Consumes the event sender, mutable skipped-event counter, an `InProcessServerEvent`, and a callback for rejecting dropped server requests. It may first flush a `Lagged` marker, then either blockingly `send` must-deliver events or `try_send` best-effort events. On full queues it increments `skipped_events`, logs a warning, rejects dropped `ServerRequest`s via the callback, and returns `ForwardEventResult::Continue`; on closed queues it returns `DisableStream`.

**Call relations**: Used inside the in-process worker loop in `InProcessAppServerClient::start` and directly exercised by backpressure tests.

*Call graph*: calls 1 internal fn (event_requires_delivery); called by 1 (forward_in_process_event_preserves_transcript_notifications_under_backpressure); 3 external calls (send, try_send, warn!).


##### `TypedRequestError::fmt`  (lines 286–306)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats typed request failures with method-qualified diagnostics that distinguish transport, server, and decode errors.

**Data flow**: Reads `self`, writes a human-readable message into the formatter, and includes JSON-RPC error code and optional data for server failures.

**Call relations**: Used implicitly whenever `TypedRequestError` is displayed by callers or tests.

*Call graph*: 1 external calls (write!).


##### `TypedRequestError::source`  (lines 310–316)

```
fn source(&self) -> Option<&(dyn Error + 'static)>
```

**Purpose**: Exposes the underlying source error for transport and deserialize failures while intentionally hiding JSON-RPC server errors as terminal values.

**Data flow**: Reads `self` and returns `Some(&IoError)` for `Transport`, `Some(&serde_json::Error)` for `Deserialize`, and `None` for `Server`.

**Call relations**: Supports standard error chaining for callers inspecting typed request failures.


##### `configured_thread_config_loader`  (lines 359–364)

```
fn configured_thread_config_loader(config: &Config) -> Arc<dyn ThreadConfigLoader>
```

**Purpose**: Chooses the thread-config loader implementation based on whether the config specifies an experimental remote endpoint.

**Data flow**: Reads `config.experimental_thread_config_endpoint`; returns `Arc<RemoteThreadConfigLoader>` when configured or `Arc<NoopThreadConfigLoader>` otherwise.

**Call relations**: Called by `InProcessClientStartArgs::into_runtime_start_args` during in-process startup assembly.

*Call graph*: calls 1 internal fn (new); called by 1 (into_runtime_start_args); 1 external calls (new).


##### `InProcessClientStartArgs::initialize_params`  (lines 368–387)

```
fn initialize_params(&self) -> InitializeParams
```

**Purpose**: Builds the initialize handshake payload from caller-provided client identity and capability settings.

**Data flow**: Reads fields from `self`, constructs `InitializeCapabilities` including optional opt-out notification methods, wraps them in `InitializeParams` with `ClientInfo`, and returns the result.

**Call relations**: Used by `into_runtime_start_args` so the embedded runtime starts with the same initialize metadata a remote client would send.

*Call graph*: called by 1 (into_runtime_start_args).


##### `InProcessClientStartArgs::into_runtime_start_args`  (lines 389–410)

```
fn into_runtime_start_args(self) -> InProcessStartArgs
```

**Purpose**: Converts facade startup arguments into the lower-level `InProcessStartArgs` expected by the embedded app-server runtime.

**Data flow**: Consumes `self`, builds initialize params via `initialize_params`, selects a thread-config loader via `configured_thread_config_loader`, and returns `InProcessStartArgs` carrying through all startup dependencies and settings.

**Call relations**: Called by `InProcessAppServerClient::start` immediately before launching the embedded runtime.

*Call graph*: calls 2 internal fn (initialize_params, configured_thread_config_loader); called by 1 (start).


##### `InProcessAppServerClient::start`  (lines 480–597)

```
async fn start(args: InProcessClientStartArgs) -> IoResult<Self>
```

**Purpose**: Starts the embedded app-server runtime, creates bounded command/event channels, and spawns the worker task that bridges facade calls to runtime operations.

**Data flow**: Consumes `InProcessClientStartArgs`, clamps channel capacity to at least 1, starts the runtime with `codex_app_server::in_process::start`, creates command and event channels, and spawns a worker loop. That loop handles request/notify/resolve/reject/shutdown commands, drains runtime events, rejects unsupported auth-refresh server requests, forwards events through `forward_in_process_event`, and disables event streaming if the consumer disappears. The function returns an initialized `InProcessAppServerClient`.

**Call relations**: This is the in-process transport entrypoint used by production surfaces and tests. All later in-process request and event methods depend on the worker it creates.

*Call graph*: calls 2 internal fn (into_runtime_start_args, start); called by 3 (start_test_client_with_capacity, run_exec_session, widget_forced_chatgpt); 2 external calls (select!, spawn).


##### `InProcessAppServerClient::request_handle`  (lines 599–603)

```
fn request_handle(&self) -> InProcessAppServerRequestHandle
```

**Purpose**: Creates a clonable lightweight request handle that can issue requests through the same worker without owning the event stream.

**Data flow**: Reads `self.command_tx`, clones it, and returns `InProcessAppServerRequestHandle`.

**Call relations**: Used by callers that need concurrent request capability and by `AppServerClient::request_handle` when wrapping the in-process transport.

*Call graph*: 1 external calls (clone).


##### `InProcessAppServerClient::request`  (lines 609–629)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Sends a client request through the in-process worker and awaits the raw JSON-RPC result envelope.

**Data flow**: Consumes a `ClientRequest`, creates a oneshot channel, sends `ClientCommand::Request` over `command_tx`, maps send/receive failures to `BrokenPipe` I/O errors, and returns `IoResult<RequestResult>` from the worker.

**Call relations**: Called directly by callers wanting raw JSON-RPC results and by `request_typed` for typed decoding.

*Call graph*: called by 1 (request_typed); 3 external calls (new, send, channel).


##### `InProcessAppServerClient::request_typed`  (lines 637–655)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Sends a client request and deserializes a successful JSON-RPC result into the caller’s chosen response type.

**Data flow**: Consumes a `ClientRequest`, derives the method name with `request_method_name`, awaits `self.request`, maps transport and server failures into `TypedRequestError`, deserializes the JSON value with `serde_json::from_value`, and returns `Result<T, TypedRequestError>`.

**Call relations**: Convenience wrapper over `request`; used by higher-level code that expects a concrete response type.

*Call graph*: calls 2 internal fn (request, request_method_name); called by 1 (send_request_with_response); 1 external calls (from_value).


##### `InProcessAppServerClient::notify`  (lines 658–678)

```
async fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Sends a client notification through the in-process worker and waits for confirmation that it was forwarded.

**Data flow**: Consumes a `ClientNotification`, creates a oneshot channel, sends `ClientCommand::Notify`, maps channel failures to `BrokenPipe`, and returns the worker’s `IoResult<()>`.

**Call relations**: Used by callers and by the transport-agnostic `AppServerClient::notify` wrapper.

*Call graph*: 2 external calls (send, channel).


##### `InProcessAppServerClient::resolve_server_request`  (lines 684–709)

```
async fn resolve_server_request(
        &self,
        request_id: RequestId,
        result: JsonRpcResult,
    ) -> IoResult<()>
```

**Purpose**: Sends a successful response for a pending server request back through the in-process worker.

**Data flow**: Consumes a request ID and JSON result, creates a oneshot channel, sends `ClientCommand::ResolveServerRequest`, maps channel failures to `BrokenPipe`, and returns the worker’s `IoResult<()>`.

**Call relations**: Used when the caller handles a server request event and wants to resolve it.

*Call graph*: called by 1 (resolve_server_request); 2 external calls (send, channel).


##### `InProcessAppServerClient::reject_server_request`  (lines 712–737)

```
async fn reject_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Sends a JSON-RPC error response for a pending server request back through the in-process worker.

**Data flow**: Consumes a request ID and `JSONRPCErrorError`, creates a oneshot channel, sends `ClientCommand::RejectServerRequest`, maps channel failures to `BrokenPipe`, and returns the worker’s `IoResult<()>`.

**Call relations**: Used when the caller declines or cannot handle a server request event.

*Call graph*: called by 1 (reject_server_request); 2 external calls (send, channel).


##### `InProcessAppServerClient::next_event`  (lines 744–746)

```
async fn next_event(&mut self) -> Option<InProcessServerEvent>
```

**Purpose**: Receives the next in-process server event from the bounded consumer queue.

**Data flow**: Mutably reads `self.event_rx` and awaits `recv()`, returning `Option<InProcessServerEvent>`.

**Call relations**: Called by event-loop code consuming in-process app-server events and by the transport-agnostic wrapper.

*Call graph*: calls 1 internal fn (recv).


##### `InProcessAppServerClient::shutdown`  (lines 752–784)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Attempts graceful shutdown of the in-process worker and runtime, then aborts the worker if it does not finish within the timeout.

**Data flow**: Consumes `self`, drops the event receiver to unblock any pending must-deliver sends, sends `ClientCommand::Shutdown` with a oneshot, waits up to `SHUTDOWN_TIMEOUT` for the command response and then for the worker task itself, aborting the worker on timeout. Returns `IoResult<()>`.

**Call relations**: Called by callers and tests during teardown. It complements `start` and ensures embedded runtime tasks do not leak.

*Call graph*: called by 1 (shutdown); 2 external calls (channel, timeout).


##### `InProcessAppServerRequestHandle::request`  (lines 788–808)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Issues a raw client request through a cloned request handle without requiring ownership of the full client.

**Data flow**: Consumes a `ClientRequest`, creates a oneshot channel, sends `ClientCommand::Request` over the cloned `command_tx`, maps channel failures to `BrokenPipe`, and returns the worker’s raw request result.

**Call relations**: Used by `InProcessAppServerRequestHandle::request_typed` and by callers needing concurrent request handles.

*Call graph*: called by 1 (request_typed); 3 external calls (new, send, channel).


##### `InProcessAppServerRequestHandle::request_typed`  (lines 810–828)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Typed variant of request-handle dispatch for the in-process transport.

**Data flow**: Consumes a `ClientRequest`, derives the method name, awaits `self.request`, maps transport/server failures into `TypedRequestError`, deserializes the JSON result into `T`, and returns it.

**Call relations**: Mirror of `InProcessAppServerClient::request_typed` for cloned request handles.

*Call graph*: calls 2 internal fn (request, request_method_name); 1 external calls (from_value).


##### `AppServerRequestHandle::request`  (lines 832–837)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Dispatches a raw request through either the in-process or remote request-handle implementation.

**Data flow**: Reads `self`, matches the enum variant, forwards the `ClientRequest` to the underlying handle, and returns its `IoResult<RequestResult>`.

**Call relations**: Transport-agnostic wrapper used by higher-level code that should not care which transport is active.


##### `AppServerRequestHandle::request_typed`  (lines 839–847)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Dispatches a typed request through either the in-process or remote request-handle implementation.

**Data flow**: Reads `self`, matches the enum variant, forwards the `ClientRequest` to the underlying typed request method, and returns `Result<T, TypedRequestError>`.

**Call relations**: Widely used by higher-level app-server API helpers throughout the codebase.

*Call graph*: called by 25 (consume_rate_limit_reset_credit_request, fetch_account_rate_limits, fetch_account_token_activity, fetch_all_mcp_server_statuses, fetch_connectors_list, fetch_feedback_upload, fetch_marketplace_add, fetch_marketplace_remove, fetch_marketplace_upgrade, fetch_plugin_detail (+15 more)).


##### `AppServerClient::codex_home`  (lines 851–858)

```
fn codex_home(&self, local_codex_home: &AbsolutePathBuf) -> Option<AppServerPath>
```

**Purpose**: Returns the app-server host’s Codex home path as an `AppServerPath` when known.

**Data flow**: Reads `self` and the local Codex home path. For in-process clients it always wraps the local path with `AppServerPath::from_app_server`; for remote clients it asks the remote transport for its reported Codex home and wraps it if present.

**Call relations**: Used by callers that need host-relative path semantics regardless of transport.

*Call graph*: calls 2 internal fn (from_app_server, display); called by 1 (codex_home_path).


##### `AppServerClient::request`  (lines 860–865)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Dispatches a raw client request through the active transport.

**Data flow**: Reads `self`, matches `InProcess` or `Remote`, forwards the request, and returns the underlying `IoResult<RequestResult>`.

**Call relations**: Transport-agnostic request entrypoint used by higher-level client code.


##### `AppServerClient::request_typed`  (lines 867–875)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Dispatches a typed client request through the active transport.

**Data flow**: Reads `self`, matches the transport variant, forwards to the underlying typed request method, and returns `Result<T, TypedRequestError>`.

**Call relations**: Common typed request entrypoint used by many higher-level app-server operations.

*Call graph*: called by 34 (bootstrap, external_agent_config_detect, external_agent_config_import, fork_thread, logout_account, memory_reset, read_account, reload_user_config, resume_thread, review_start (+15 more)).


##### `AppServerClient::notify`  (lines 877–882)

```
async fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Dispatches a client notification through the active transport.

**Data flow**: Reads `self`, matches the transport variant, forwards the notification, and returns `IoResult<()>`.

**Call relations**: Transport-agnostic wrapper over in-process and remote notification sending.


##### `AppServerClient::resolve_server_request`  (lines 884–893)

```
async fn resolve_server_request(
        &self,
        request_id: RequestId,
        result: JsonRpcResult,
    ) -> IoResult<()>
```

**Purpose**: Resolves a pending server request through the active transport.

**Data flow**: Reads `self`, matches the transport variant, forwards request ID and JSON result, and returns `IoResult<()>`.

**Call relations**: Used by higher-level server-request handling code without transport branching.

*Call graph*: called by 1 (resolve_server_request).


##### `AppServerClient::reject_server_request`  (lines 895–904)

```
async fn reject_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Rejects a pending server request through the active transport.

**Data flow**: Reads `self`, matches the transport variant, forwards request ID and JSON-RPC error, and returns `IoResult<()>`.

**Call relations**: Used by higher-level server-request handling code without transport branching.

*Call graph*: called by 1 (reject_server_request).


##### `AppServerClient::next_event`  (lines 906–911)

```
async fn next_event(&mut self) -> Option<AppServerEvent>
```

**Purpose**: Receives the next app-server event from the active transport, converting in-process events into the common event enum.

**Data flow**: Mutably reads `self`, awaits the underlying transport’s next-event method, and returns `Option<AppServerEvent>`.

**Call relations**: Transport-agnostic event-loop entrypoint.

*Call graph*: called by 1 (next_event).


##### `AppServerClient::shutdown`  (lines 913–918)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Shuts down the active transport client.

**Data flow**: Consumes `self`, matches the transport variant, forwards to the underlying shutdown method, and returns `IoResult<()>`.

**Call relations**: Transport-agnostic teardown entrypoint.

*Call graph*: called by 1 (shutdown).


##### `AppServerClient::request_handle`  (lines 920–925)

```
fn request_handle(&self) -> AppServerRequestHandle
```

**Purpose**: Creates a transport-agnostic clonable request handle for the active client.

**Data flow**: Reads `self`, matches the transport variant, wraps the underlying request handle in `AppServerRequestHandle`, and returns it.

**Call relations**: Used by callers that need to issue requests from multiple tasks without moving the full client.

*Call graph*: called by 1 (request_handle); 2 external calls (InProcess, Remote).


##### `request_method_name`  (lines 930–940)

```
fn request_method_name(request: &ClientRequest) -> String
```

**Purpose**: Extracts the JSON-RPC method name from a serialized client request for diagnostics and typed error messages.

**Data flow**: Reads a borrowed `ClientRequest`, serializes it to `serde_json::Value`, looks up the `method` field as a string, and returns that string or `<unknown>` if extraction fails.

**Call relations**: Used by typed request helpers in both in-process and remote transports when constructing `TypedRequestError` values.

*Call graph*: called by 2 (request_typed, request_typed); 1 external calls (to_value).


##### `tests::build_test_config`  (lines 977–984)

```
async fn build_test_config() -> Config
```

**Purpose**: Builds a test configuration, falling back to default loading if the builder path fails.

**Data flow**: Attempts `ConfigBuilder::default().build().await`; on error it loads default config with empty CLI overrides and returns the resulting `Config`.

**Call relations**: Shared helper for in-process transport tests.

*Call graph*: 3 external calls (new, load_default_with_cli_overrides, default).


##### `tests::build_test_config_for_codex_home`  (lines 986–1000)

```
async fn build_test_config_for_codex_home(codex_home: &Path) -> Config
```

**Purpose**: Builds a test configuration rooted at a specific temporary Codex home, with fallback to default loading for that home.

**Data flow**: Attempts a configured `ConfigBuilder` build using the provided path; on error it loads default config for that Codex home with empty overrides and returns the `Config`.

**Call relations**: Used by test client startup helpers.

*Call graph*: 4 external calls (to_path_buf, new, load_default_with_cli_overrides_for_codex_home, default).


##### `tests::TestClient::deref`  (lines 1010–1012)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets `TestClient` transparently behave like `InProcessAppServerClient` in tests.

**Data flow**: Reads `self` and returns a shared reference to the inner `client` field.

**Call relations**: Supports ergonomic method calls in tests without manually accessing `.client`.


##### `tests::TestClient::shutdown`  (lines 1016–1018)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Convenience wrapper that shuts down the inner in-process test client.

**Data flow**: Consumes `self` and awaits `self.client.shutdown()`.

**Call relations**: Used by tests to tear down the temporary in-process client.

*Call graph*: calls 1 internal fn (shutdown).


##### `tests::start_test_client_with_capacity`  (lines 1021–1057)

```
async fn start_test_client_with_capacity(
        session_source: SessionSource,
        channel_capacity: usize,
    ) -> TestClient
```

**Purpose**: Starts an in-process test client with a temporary Codex home and caller-specified channel capacity.

**Data flow**: Creates a temp dir, builds config for that home, initializes state DB, constructs `InProcessClientStartArgs` with test defaults, starts `InProcessAppServerClient`, and returns a `TestClient` holding both temp dir and client.

**Call relations**: Shared setup helper for many in-process tests.

*Call graph*: calls 4 internal fn (start, default, default_for_tests, new); 7 external calls (new, new, new, build_test_config_for_codex_home, default, init_state_db, default).


##### `tests::start_test_client`  (lines 1059–1061)

```
async fn start_test_client(session_source: SessionSource) -> TestClient
```

**Purpose**: Starts an in-process test client using the default in-process channel capacity.

**Data flow**: Consumes a `SessionSource`, delegates to `start_test_client_with_capacity` with `DEFAULT_IN_PROCESS_CHANNEL_CAPACITY`, and returns the resulting `TestClient`.

**Call relations**: Convenience wrapper used by most in-process tests.

*Call graph*: 1 external calls (start_test_client_with_capacity).


##### `tests::start_test_remote_server`  (lines 1063–1071)

```
async fn start_test_remote_server(handler: F) -> String
```

**Purpose**: Starts a temporary WebSocket test server without auth requirements.

**Data flow**: Consumes a handler closure and delegates to `start_test_remote_server_with_auth` with no expected auth token, returning the server URL string.

**Call relations**: Shared setup helper for remote transport tests.

*Call graph*: 1 external calls (start_test_remote_server_with_auth).


##### `tests::start_test_remote_server_with_auth`  (lines 1073–1109)

```
async fn start_test_remote_server_with_auth(
        expected_auth_token: Option<String>,
        handler: F,
    ) -> String
```

**Purpose**: Starts a temporary WebSocket test server that optionally asserts an expected bearer auth header during handshake.

**Data flow**: Binds a local TCP listener, spawns an accept task, upgrades the accepted stream with `accept_hdr_async`, optionally validates the `Authorization` header, runs the provided handler on the WebSocket stream, and returns the `ws://` URL.

**Call relations**: Used by remote transport tests, including auth-header validation cases.

*Call graph*: 4 external calls (bind, format!, spawn, accept_hdr_async).


##### `tests::expect_remote_initialize`  (lines 1111–1136)

```
async fn expect_remote_initialize(websocket: &mut tokio_tungstenite::WebSocketStream<S>)
```

**Purpose**: Performs the server side of the remote initialize/initialized handshake in tests.

**Data flow**: Reads the next WebSocket message, asserts it is an `initialize` request, writes a JSON-RPC response containing `userAgent` and `codexHome`, then reads and asserts the subsequent `initialized` notification.

**Call relations**: Shared helper used by many remote transport tests.

*Call graph*: 6 external calls (read_websocket_message, write_websocket_message, Response, assert_eq!, panic!, json!).


##### `tests::read_websocket_message`  (lines 1138–1161)

```
async fn read_websocket_message(
        websocket: &mut tokio_tungstenite::WebSocketStream<S>,
    ) -> JSONRPCMessage
```

**Purpose**: Reads the next meaningful JSON-RPC message from a test WebSocket stream, skipping non-text frames.

**Data flow**: Loops over incoming frames, ignores binary/ping/pong/frame variants, parses text frames as `JSONRPCMessage`, and panics on unexpected close or invalid JSON-RPC.

**Call relations**: Used by remote transport test helpers and test server handlers.

*Call graph*: 2 external calls (next, panic!).


##### `tests::write_websocket_message`  (lines 1163–1177)

```
async fn write_websocket_message(
        websocket: &mut tokio_tungstenite::WebSocketStream<S>,
        message: JSONRPCMessage,
    )
```

**Purpose**: Serializes and sends a JSON-RPC message over a test WebSocket stream.

**Data flow**: Consumes a `JSONRPCMessage`, serializes it to a JSON string, wraps it in a text frame, sends it on the WebSocket, and panics on send failure.

**Call relations**: Used by remote transport test helpers and server handlers.

*Call graph*: 3 external calls (send, to_string, Text).


##### `tests::command_execution_output_delta_notification`  (lines 1179–1188)

```
fn command_execution_output_delta_notification(delta: &str) -> ServerNotification
```

**Purpose**: Constructs a sample command-execution output delta notification for backpressure tests.

**Data flow**: Consumes a delta string and returns a `ServerNotification::CommandExecutionOutputDelta` with fixed thread/turn/item IDs.

**Call relations**: Used by event-delivery tests.

*Call graph*: 1 external calls (CommandExecutionOutputDelta).


##### `tests::agent_message_delta_notification`  (lines 1190–1199)

```
fn agent_message_delta_notification(delta: &str) -> ServerNotification
```

**Purpose**: Constructs a sample agent-message delta notification for transcript-delivery tests.

**Data flow**: Consumes a delta string and returns a `ServerNotification::AgentMessageDelta` with fixed IDs.

**Call relations**: Used by event-delivery tests.

*Call graph*: 1 external calls (AgentMessageDelta).


##### `tests::item_completed_notification`  (lines 1201–1213)

```
fn item_completed_notification(text: &str) -> ServerNotification
```

**Purpose**: Constructs a sample item-completed notification carrying an agent message item.

**Data flow**: Consumes a text string and returns `ServerNotification::ItemCompleted` with fixed IDs and an `AgentMessage` item containing that text.

**Call relations**: Used by transcript/completion delivery tests.

*Call graph*: 1 external calls (ItemCompleted).


##### `tests::turn_completed_notification`  (lines 1215–1229)

```
fn turn_completed_notification() -> ServerNotification
```

**Purpose**: Constructs a sample completed-turn notification for delivery tests.

**Data flow**: Returns `ServerNotification::TurnCompleted` with fixed thread/turn IDs and a completed protocol turn object.

**Call relations**: Used by transcript/completion delivery tests.

*Call graph*: 2 external calls (TurnCompleted, new).


##### `tests::test_remote_connect_args`  (lines 1231–1243)

```
fn test_remote_connect_args(websocket_url: String) -> RemoteAppServerConnectArgs
```

**Purpose**: Builds a standard set of remote connection arguments for tests.

**Data flow**: Consumes a WebSocket URL string and returns `RemoteAppServerConnectArgs` with test client identity, experimental API enabled, no auth token, and fixed channel capacity.

**Call relations**: Shared helper for remote transport tests.

*Call graph*: 1 external calls (new).


##### `tests::typed_request_roundtrip_works`  (lines 1246–1256)

```
async fn typed_request_roundtrip_works()
```

**Purpose**: Verifies that an in-process typed request can be sent and decoded successfully.

**Data flow**: Starts a test client, issues `ConfigRequirementsRead` via `request_typed`, asserts success by type-checking the decoded response, and shuts down the client.

**Call relations**: Integration test for in-process typed request plumbing.

*Call graph*: 2 external calls (start_test_client, Integer).


##### `tests::typed_request_reports_json_rpc_errors`  (lines 1259–1276)

```
async fn typed_request_reports_json_rpc_errors()
```

**Purpose**: Verifies that in-process typed requests surface JSON-RPC failures as `TypedRequestError::Server` with method-qualified messages.

**Data flow**: Starts a test client, issues a `ThreadRead` for a missing thread, expects an error, asserts the formatted message prefix, and shuts down.

**Call relations**: Tests typed error mapping for server-side failures.

*Call graph*: 3 external calls (start_test_client, Integer, assert!).


##### `tests::caller_provided_session_source_is_applied`  (lines 1279–1298)

```
async fn caller_provided_session_source_is_applied()
```

**Purpose**: Checks that the session source supplied at client startup is reflected in threads created through the app-server.

**Data flow**: For each tested `SessionSource`, starts a client, issues `ThreadStart`, decodes `ThreadStartResponse`, asserts the protocol thread source matches expectation, and shuts down.

**Call relations**: Integration test for startup identity propagation.

*Call graph*: 4 external calls (start_test_client, Integer, default, assert_eq!).


##### `tests::threads_started_via_app_server_are_visible_through_typed_requests`  (lines 1301–1329)

```
async fn threads_started_via_app_server_are_visible_through_typed_requests()
```

**Purpose**: Verifies that a thread created through the app-server can be read back through another typed request.

**Data flow**: Starts a client, issues `ThreadStart`, then `ThreadRead` for the returned thread ID, asserts the IDs match, and shuts down.

**Call relations**: Integration test for typed request round-tripping against real in-process state.

*Call graph*: 4 external calls (start_test_client, Integer, default, assert_eq!).


##### `tests::tiny_channel_capacity_still_supports_request_roundtrip`  (lines 1332–1343)

```
async fn tiny_channel_capacity_still_supports_request_roundtrip()
```

**Purpose**: Ensures that even the minimum bounded channel capacity still allows normal request/response operation.

**Data flow**: Starts a test client with capacity 1, issues a typed config request, asserts success, and shuts down.

**Call relations**: Regression test for bounded-channel startup and request handling.

*Call graph*: 2 external calls (start_test_client_with_capacity, Integer).


##### `tests::forward_in_process_event_preserves_transcript_notifications_under_backpressure`  (lines 1346–1431)

```
async fn forward_in_process_event_preserves_transcript_notifications_under_backpressure()
```

**Purpose**: Verifies that lag markers are surfaced and must-deliver transcript/completion notifications are preserved even when the consumer queue is saturated.

**Data flow**: Creates a tiny event channel, pre-fills it, forwards a droppable event to accumulate skipped count, then forwards transcript/completion notifications through `forward_in_process_event`, receives the resulting sequence, and asserts the lag marker and must-deliver events arrive in order.

**Call relations**: Direct behavioral test for the backpressure algorithm in `forward_in_process_event`.

*Call graph*: calls 1 internal fn (forward_in_process_event); 12 external calls (from_secs, new, agent_message_delta_notification, command_execution_output_delta_notification, item_completed_notification, turn_completed_notification, ServerNotification, assert!, assert_eq!, channel (+2 more)).


##### `tests::remote_typed_request_roundtrip_works`  (lines 1434–1475)

```
async fn remote_typed_request_roundtrip_works()
```

**Purpose**: Verifies that the remote transport can connect, complete initialize, issue a typed request, and decode the response.

**Data flow**: Starts a temporary remote server, performs initialize handshake, serves an `account/read` response, connects a `RemoteAppServerClient`, asserts reported server version and Codex home, issues `GetAccount`, checks the decoded response, and shuts down.

**Call relations**: Integration test for remote typed request flow.

*Call graph*: calls 1 internal fn (connect); 4 external calls (start_test_remote_server, test_remote_connect_args, Integer, assert_eq!).


##### `tests::remote_unix_socket_typed_request_roundtrip_works`  (lines 1478–1533)

```
async fn remote_unix_socket_typed_request_roundtrip_works()
```

**Purpose**: Verifies the same typed request flow over a Unix-socket WebSocket transport.

**Data flow**: Creates a temporary Unix socket listener, upgrades it to WebSocket, performs initialize handshake, serves an `account/read` response, connects a remote client using `UnixSocket` endpoint args, issues `GetAccount`, asserts the response, and shuts down.

**Call relations**: Integration test for Unix-socket remote transport.

*Call graph*: calls 3 internal fn (connect, bind, from_absolute_path); 12 external calls (new, new, expect_remote_initialize, read_websocket_message, write_websocket_message, Response, Integer, assert_eq!, panic!, to_value (+2 more)).


##### `tests::remote_typed_request_accepts_large_single_frame_response`  (lines 1536–1582)

```
async fn remote_typed_request_accepts_large_single_frame_response()
```

**Purpose**: Checks that the remote transport accepts large single-frame WebSocket responses up to the configured message-size limit.

**Data flow**: Starts a remote test server that returns a large padded JSON response to `account/read`, connects a remote client, issues `GetAccount`, asserts the decoded response ignores the extra padding field, and shuts down.

**Call relations**: Regression test for remote WebSocket size configuration.

*Call graph*: calls 1 internal fn (connect); 4 external calls (start_test_remote_server, test_remote_connect_args, Integer, assert_eq!).


##### `tests::remote_connect_includes_auth_header_when_configured`  (lines 1585–1610)

```
async fn remote_connect_includes_auth_header_when_configured()
```

**Purpose**: Verifies that remote WebSocket connections include the expected bearer auth header when configured.

**Data flow**: Starts an auth-checking test server, connects a remote client with an auth token, relies on the server-side assertion during handshake, and shuts down.

**Call relations**: Integration test for remote auth-header injection.

*Call graph*: calls 1 internal fn (connect); 2 external calls (new, start_test_remote_server_with_auth).


##### `tests::remote_connect_rejects_non_loopback_ws_when_auth_configured`  (lines 1613–1635)

```
async fn remote_connect_rejects_non_loopback_ws_when_auth_configured()
```

**Purpose**: Ensures bearer auth tokens are rejected for insecure non-loopback `ws://` URLs before any connection attempt.

**Data flow**: Attempts to connect a remote client to `ws://example.com` with an auth token, expects an `InvalidInput` error, and asserts the error message explains the transport policy.

**Call relations**: Tests the URL/auth policy enforced by remote connection setup.

*Call graph*: calls 1 internal fn (connect); 4 external calls (new, assert!, assert_eq!, panic!).


##### `tests::remote_auth_token_transport_policy_allows_wss_and_loopback_ws`  (lines 1638–1648)

```
fn remote_auth_token_transport_policy_allows_wss_and_loopback_ws()
```

**Purpose**: Unit-tests the URL policy helper for auth-bearing remote WebSocket connections.

**Data flow**: Parses representative URLs and asserts `websocket_url_supports_auth_token` returns true for `wss://` and loopback `ws://`, false otherwise.

**Call relations**: Direct test of the remote auth transport policy helper.

*Call graph*: 1 external calls (assert!).


##### `tests::remote_duplicate_request_id_keeps_original_waiter`  (lines 1651–1736)

```
async fn remote_duplicate_request_id_keeps_original_waiter()
```

**Purpose**: Verifies that the remote transport rejects duplicate in-flight request IDs locally without disturbing the original waiter.

**Data flow**: Starts a remote server, connects a client, clones a request handle, sends one request with ID 1, waits until the server observes it, sends a second request with the same ID and asserts immediate transport error, then completes the first request and asserts it still succeeds.

**Call relations**: Integration test for duplicate request ID protection in the remote worker.

*Call graph*: calls 1 internal fn (connect); 6 external calls (start_test_remote_server, test_remote_connect_args, Integer, assert_eq!, spawn, channel).


##### `tests::remote_notifications_arrive_over_websocket`  (lines 1739–1771)

```
async fn remote_notifications_arrive_over_websocket()
```

**Purpose**: Checks that remote JSON-RPC notifications are converted into `AppServerEvent::ServerNotification` values.

**Data flow**: Starts a remote server that sends an `AccountUpdated` notification after initialize, connects a client, awaits `next_event`, asserts the event variant, and shuts down.

**Call relations**: Integration test for remote notification delivery.

*Call graph*: calls 1 internal fn (connect); 3 external calls (start_test_remote_server, test_remote_connect_args, assert!).


##### `tests::remote_backpressure_preserves_transcript_notifications`  (lines 1774–1868)

```
async fn remote_backpressure_preserves_transcript_notifications()
```

**Purpose**: Verifies that the remote transport’s event stream preserves transcript/completion notifications and surfaces lag markers under backpressure.

**Data flow**: Starts a remote server that sends a burst of notifications, connects a client with channel capacity 1, receives the first event and then the remaining events, and asserts the sequence contains one lag marker plus the must-deliver transcript/completion notifications.

**Call relations**: Cross-transport behavioral test mirroring the in-process backpressure guarantees.

*Call graph*: calls 1 internal fn (connect); 10 external calls (from_secs, new, start_test_remote_server, test_remote_connect_args, assert!, assert_eq!, matches!, panic!, channel, timeout).


##### `tests::remote_server_request_resolution_roundtrip_works`  (lines 1871–1923)

```
async fn remote_server_request_resolution_roundtrip_works()
```

**Purpose**: Verifies that a remote server request is surfaced to the client and can be resolved back to the server.

**Data flow**: Starts a remote server that sends a JSON-RPC request, connects a client, awaits a `ServerRequest` event, resolves it with an empty JSON object, and asserts the server receives the matching JSON-RPC response.

**Call relations**: Integration test for remote server-request handling.

*Call graph*: calls 1 internal fn (connect); 4 external calls (start_test_remote_server, test_remote_connect_args, panic!, json!).


##### `tests::remote_server_request_received_during_initialize_is_delivered`  (lines 1926–2001)

```
async fn remote_server_request_received_during_initialize_is_delivered()
```

**Purpose**: Ensures server requests arriving before initialize completes are buffered and delivered to the caller after connection setup.

**Data flow**: Starts a remote server that sends a server request before the initialize response, connects a client, awaits the buffered `ServerRequest` event, resolves it, and asserts the server receives the response.

**Call relations**: Tests the pending-event buffering performed during remote initialization.

*Call graph*: calls 1 internal fn (connect); 4 external calls (start_test_remote_server, test_remote_connect_args, panic!, json!).


##### `tests::remote_unknown_server_request_is_rejected`  (lines 2004–2036)

```
async fn remote_unknown_server_request_is_rejected()
```

**Purpose**: Verifies that unknown remote server requests are rejected with JSON-RPC method-not-found errors.

**Data flow**: Starts a remote server that sends an unsupported request method after initialize, connects a client, and relies on the server-side assertion that it receives a `-32601` error response with the expected message.

**Call relations**: Integration test for unknown remote server-request rejection.

*Call graph*: calls 1 internal fn (connect); 2 external calls (start_test_remote_server, test_remote_connect_args).


##### `tests::remote_disconnect_surfaces_as_event`  (lines 2039–2054)

```
async fn remote_disconnect_surfaces_as_event()
```

**Purpose**: Checks that remote connection closure is surfaced to callers as a `Disconnected` event rather than silent stream termination.

**Data flow**: Starts a remote server that closes after initialize, connects a client, awaits `next_event`, asserts it is `AppServerEvent::Disconnected`, and ends.

**Call relations**: Integration test for remote disconnect reporting.

*Call graph*: calls 1 internal fn (connect); 3 external calls (start_test_remote_server, test_remote_connect_args, assert!).


##### `tests::typed_request_error_exposes_sources`  (lines 2057–2084)

```
fn typed_request_error_exposes_sources()
```

**Purpose**: Verifies `TypedRequestError` display formatting and source chaining behavior for each error variant.

**Data flow**: Constructs representative `Transport`, `Server`, and `Deserialize` errors, asserts whether `Error::source` is present, and checks the formatted server error string.

**Call relations**: Unit test for the typed error type.

*Call graph*: 3 external calls (new, assert_eq!, json!).


##### `tests::next_event_surfaces_lagged_markers`  (lines 2087–2112)

```
async fn next_event_surfaces_lagged_markers()
```

**Purpose**: Checks that `InProcessAppServerClient::next_event` can return queued lag markers.

**Data flow**: Constructs a minimal client with a preloaded `Lagged` event in its event channel, awaits `next_event`, asserts the marker is returned, and shuts down.

**Call relations**: Regression test for event-stream behavior on the in-process client.

*Call graph*: 5 external calls (from_secs, assert!, channel, spawn, timeout).


##### `tests::event_requires_delivery_marks_transcript_and_terminal_events`  (lines 2115–2189)

```
fn event_requires_delivery_marks_transcript_and_terminal_events()
```

**Purpose**: Unit-tests the lossless-event classification logic.

**Data flow**: Constructs representative `InProcessServerEvent` values and asserts `event_requires_delivery` returns true for transcript/completion notifications and false for lag markers and command output deltas.

**Call relations**: Direct test of the backpressure classification helper.

*Call graph*: 1 external calls (assert!).


##### `tests::runtime_start_args_forward_environment_manager`  (lines 2192–2242)

```
async fn runtime_start_args_forward_environment_manager()
```

**Purpose**: Verifies that converting startup args into runtime args preserves the shared environment manager and config references.

**Data flow**: Builds test config and environment manager, constructs `InProcessClientStartArgs`, converts them with `into_runtime_start_args`, and asserts pointer equality and remote-environment behavior.

**Call relations**: Unit test for startup argument conversion.

*Call graph*: calls 4 internal fn (default, create_for_tests, new, new); 8 external calls (new, new, build_test_config, default, assert!, assert_eq!, default, current_exe).


##### `tests::runtime_start_args_use_remote_thread_config_loader_when_configured`  (lines 2245–2280)

```
async fn runtime_start_args_use_remote_thread_config_loader_when_configured()
```

**Purpose**: Checks that startup argument conversion selects a remote thread-config loader when the config endpoint is set.

**Data flow**: Builds config with `experimental_thread_config_endpoint`, converts startup args into runtime args, invokes the resulting loader, and asserts it fails with the expected request-failed code.

**Call relations**: Unit test for `configured_thread_config_loader` integration.

*Call graph*: calls 3 internal fn (default, default_for_tests, new); 7 external calls (new, default, new, build_test_config, default, assert_eq!, default).


##### `tests::shutdown_completes_promptly_without_retained_managers`  (lines 2283–2290)

```
async fn shutdown_completes_promptly_without_retained_managers()
```

**Purpose**: Ensures in-process shutdown completes promptly rather than waiting for the full fallback timeout.

**Data flow**: Starts a test client, wraps `shutdown()` in a one-second timeout, and asserts it completes successfully within that bound.

**Call relations**: Regression test for graceful shutdown behavior.

*Call graph*: 3 external calls (from_secs, start_test_client, timeout).


### `app-server-client/src/remote.rs`

`io_transport` · `remote connection setup, request/response handling, event streaming, and shutdown`

This module owns the full lifecycle of a remote app-server connection. `RemoteAppServerConnectArgs` captures endpoint and client identity, and `RemoteAppServerClient::connect` chooses either TCP WebSocket or Unix-socket WebSocket setup before delegating to `connect_with_stream`. Connection setup enforces a security policy for bearer auth tokens: `websocket_url_supports_auth_token` allows them only on `wss://` or loopback `ws://` URLs. Both transport paths configure large WebSocket frame/message limits via `remote_websocket_config`.

The initialize handshake is handled by `initialize_remote_connection`. It sends a JSON-RPC `initialize` request, waits up to `INITIALIZE_TIMEOUT` for the matching response, extracts `userAgent`-derived server version and `codexHome`, buffers any notifications or server requests that arrive during initialization, rejects unknown server requests with `-32601`, and finally sends the `initialized` notification. Those buffered events are stored in `pending_events` so callers can consume them before live stream events.

`connect_with_stream` then spawns the worker task. That task multiplexes command-channel requests and incoming WebSocket messages. Outbound commands serialize JSON-RPC requests/notifications/responses/errors and write them with `write_jsonrpc_message`; duplicate in-flight request IDs are rejected locally. Inbound text frames are parsed as `JSONRPCMessage`: responses/errors resolve pending request waiters, notifications are converted with `app_server_event_from_notification` and delivered to the unbounded event channel, and server requests are either converted to `AppServerEvent::ServerRequest` or rejected as unsupported. Any parse, transport, close, or write failure is surfaced as a `Disconnected` event and also used to fail all pending request waiters. Public request/notify/resolve/reject methods are thin channel wrappers, while `next_event` drains buffered initialize-time events before reading the live channel. Shutdown mirrors the in-process client: send a shutdown command, wait bounded time, then abort the worker if necessary.

#### Function details

##### `RemoteAppServerConnectArgs::initialize_params`  (lines 93–112)

```
fn initialize_params(&self) -> InitializeParams
```

**Purpose**: Builds the initialize handshake payload for a remote connection from the caller’s client identity and capability settings.

**Data flow**: Reads fields from `self`, constructs `InitializeCapabilities` including optional opt-out notification methods, wraps them in `InitializeParams` with `ClientInfo`, and returns the result.

**Call relations**: Called by `RemoteAppServerClient::connect` before transport-specific connection setup.

*Call graph*: called by 1 (connect).


##### `websocket_url_supports_auth_token`  (lines 115–123)

```
fn websocket_url_supports_auth_token(url: &Url) -> bool
```

**Purpose**: Enforces the transport policy for bearer-authenticated remote WebSocket URLs.

**Data flow**: Reads a parsed `Url`, inspects its scheme and host, and returns true only for `wss://` URLs or loopback/localhost `ws://` URLs.

**Call relations**: Used by `connect_websocket_endpoint` to reject insecure non-loopback `ws://` URLs when an auth token is configured.

*Call graph*: called by 1 (connect_websocket_endpoint); 2 external calls (host, scheme).


##### `RemoteAppServerClient::connect`  (lines 164–183)

```
async fn connect(args: RemoteAppServerConnectArgs) -> IoResult<Self>
```

**Purpose**: Connects to a remote app-server endpoint, performs transport-specific setup, and returns a ready client.

**Data flow**: Consumes `RemoteAppServerConnectArgs`, clamps channel capacity to at least 1, builds initialize params, matches the endpoint variant, connects via `connect_websocket_endpoint` or `connect_unix_socket_endpoint`, and delegates to `connect_with_stream`.

**Call relations**: This is the remote transport entrypoint used by production code and many integration tests.

*Call graph*: calls 3 internal fn (initialize_params, connect_unix_socket_endpoint, connect_websocket_endpoint); called by 13 (remote_backpressure_preserves_transcript_notifications, remote_connect_includes_auth_header_when_configured, remote_connect_rejects_non_loopback_ws_when_auth_configured, remote_disconnect_surfaces_as_event, remote_duplicate_request_id_keeps_original_waiter, remote_notifications_arrive_over_websocket, remote_server_request_received_during_initialize_is_delivered, remote_server_request_resolution_roundtrip_works, remote_typed_request_accepts_large_single_frame_response, remote_typed_request_roundtrip_works (+3 more)); 1 external calls (connect_with_stream).


##### `RemoteAppServerClient::server_version`  (lines 185–187)

```
fn server_version(&self) -> Option<&str>
```

**Purpose**: Returns the server version string extracted from the initialize response, if available.

**Data flow**: Reads `self.server_version` and returns it as `Option<&str>` via `as_deref()`.

**Call relations**: Used by callers after connection setup to inspect remote server identity.


##### `RemoteAppServerClient::codex_home`  (lines 189–191)

```
fn codex_home(&self) -> Option<&str>
```

**Purpose**: Returns the remote server’s reported Codex home path, if available.

**Data flow**: Reads `self.codex_home` and returns it as `Option<&str>` via `as_deref()`.

**Call relations**: Used by higher-level wrappers such as `AppServerClient::codex_home`.


##### `RemoteAppServerClient::connect_with_stream`  (lines 193–483)

```
async fn connect_with_stream(
        channel_capacity: usize,
        endpoint: String,
        stream: WebSocketStream<S>,
        initialize_params: InitializeParams,
    ) -> IoResult<Self>
```

**Purpose**: Completes remote client initialization on an already established WebSocket stream and spawns the worker that routes commands and incoming JSON-RPC messages.

**Data flow**: Consumes channel capacity, endpoint label, WebSocket stream, and initialize params. It first runs `initialize_remote_connection`, then creates bounded command and unbounded event channels, spawns a worker loop that tracks pending requests, writes outbound JSON-RPC messages, parses inbound messages, delivers notifications/server requests as `AppServerEvent`s, emits `Disconnected` events on failures, and fails all pending request waiters on exit. It returns a `RemoteAppServerClient` containing buffered initialize-time events and extracted metadata.

**Call relations**: Called only by `connect` after transport-specific stream establishment.

*Call graph*: calls 1 internal fn (initialize_remote_connection); 4 external calls (new, new, select!, spawn).


##### `RemoteAppServerClient::request_handle`  (lines 485–489)

```
fn request_handle(&self) -> RemoteAppServerRequestHandle
```

**Purpose**: Creates a clonable lightweight request handle for issuing remote requests without owning the event stream.

**Data flow**: Reads `self.command_tx`, clones it, and returns `RemoteAppServerRequestHandle`.

**Call relations**: Used by `request` and by higher-level wrappers needing concurrent request handles.

*Call graph*: called by 1 (request); 1 external calls (clone).


##### `RemoteAppServerClient::request`  (lines 491–493)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Sends a raw client request over the remote transport and awaits the JSON-RPC result envelope.

**Data flow**: Consumes a `ClientRequest` and delegates to a fresh `request_handle().request(request)`, returning `IoResult<RequestResult>`.

**Call relations**: Thin convenience wrapper over the request handle; used by `request_typed`.

*Call graph*: calls 1 internal fn (request_handle); called by 1 (request_typed).


##### `RemoteAppServerClient::request_typed`  (lines 495–513)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Sends a remote client request and deserializes a successful JSON-RPC result into the caller’s chosen type.

**Data flow**: Consumes a `ClientRequest`, derives the method name with `request_method_name`, awaits `self.request`, maps transport and server failures into `TypedRequestError`, deserializes the JSON result with `serde_json::from_value`, and returns `Result<T, TypedRequestError>`.

**Call relations**: Typed convenience wrapper used by higher-level remote API calls.

*Call graph*: calls 1 internal fn (request); 2 external calls (request_method_name, from_value).


##### `RemoteAppServerClient::notify`  (lines 515–535)

```
async fn notify(&self, notification: ClientNotification) -> IoResult<()>
```

**Purpose**: Sends a client notification over the remote transport and waits for the worker to confirm it was written.

**Data flow**: Consumes a `ClientNotification`, creates a oneshot channel, sends `RemoteClientCommand::Notify`, maps channel failures to `BrokenPipe`, and returns the worker’s `IoResult<()>`.

**Call relations**: Used by callers and by the transport-agnostic wrapper.

*Call graph*: 2 external calls (send, channel).


##### `RemoteAppServerClient::resolve_server_request`  (lines 537–562)

```
async fn resolve_server_request(
        &self,
        request_id: RequestId,
        result: JsonRpcResult,
    ) -> IoResult<()>
```

**Purpose**: Sends a successful JSON-RPC response for a pending remote server request.

**Data flow**: Consumes a request ID and JSON result, creates a oneshot channel, sends `RemoteClientCommand::ResolveServerRequest`, maps channel failures to `BrokenPipe`, and returns the worker’s `IoResult<()>`.

**Call relations**: Used when callers handle a remote `ServerRequest` event successfully.

*Call graph*: 2 external calls (send, channel).


##### `RemoteAppServerClient::reject_server_request`  (lines 564–589)

```
async fn reject_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> IoResult<()>
```

**Purpose**: Sends a JSON-RPC error response for a pending remote server request.

**Data flow**: Consumes a request ID and `JSONRPCErrorError`, creates a oneshot channel, sends `RemoteClientCommand::RejectServerRequest`, maps channel failures to `BrokenPipe`, and returns the worker’s `IoResult<()>`.

**Call relations**: Used when callers decline or cannot handle a remote `ServerRequest`.

*Call graph*: 2 external calls (send, channel).


##### `RemoteAppServerClient::next_event`  (lines 591–596)

```
async fn next_event(&mut self) -> Option<AppServerEvent>
```

**Purpose**: Returns the next remote app-server event, draining any events buffered during initialize before reading the live event channel.

**Data flow**: Mutably reads `self.pending_events`; if nonempty it pops and returns the front event, otherwise awaits `self.event_rx.recv()`.

**Call relations**: Used by event-loop code and by the transport-agnostic wrapper.

*Call graph*: 2 external calls (recv, pop_front).


##### `RemoteAppServerClient::shutdown`  (lines 598–624)

```
async fn shutdown(self) -> IoResult<()>
```

**Purpose**: Attempts graceful shutdown of the remote worker and WebSocket connection, then aborts the worker if it does not finish within the timeout.

**Data flow**: Consumes `self`, drops the event receiver, sends `RemoteClientCommand::Shutdown` with a oneshot, waits up to `SHUTDOWN_TIMEOUT` for the close result and then for the worker task, aborting the worker on timeout. Returns `IoResult<()>`.

**Call relations**: Called during teardown by callers and tests.

*Call graph*: 2 external calls (channel, timeout).


##### `RemoteAppServerRequestHandle::request`  (lines 628–631)

```
async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>
```

**Purpose**: Converts a typed client request into a JSON-RPC request and sends it through the remote worker.

**Data flow**: Consumes a `ClientRequest`, converts it with `jsonrpc_request_from_client_request`, delegates to `request_json_rpc`, and returns the raw request result.

**Call relations**: Used by `RemoteAppServerRequestHandle::request_typed` and by `RemoteAppServerClient::request`.

*Call graph*: calls 2 internal fn (request_json_rpc, jsonrpc_request_from_client_request); called by 1 (request_typed).


##### `RemoteAppServerRequestHandle::request_json_rpc`  (lines 633–653)

```
async fn request_json_rpc(&self, request: JSONRPCRequest) -> IoResult<RequestResult>
```

**Purpose**: Sends a raw JSON-RPC request through the remote worker and awaits the corresponding result envelope.

**Data flow**: Consumes a `JSONRPCRequest`, creates a oneshot channel, sends `RemoteClientCommand::Request`, maps channel failures to `BrokenPipe`, and returns the worker’s `IoResult<RequestResult>`.

**Call relations**: Core request primitive for the remote request handle.

*Call graph*: called by 1 (request); 3 external calls (new, send, channel).


##### `RemoteAppServerRequestHandle::request_typed`  (lines 655–673)

```
async fn request_typed(&self, request: ClientRequest) -> Result<T, TypedRequestError>
```

**Purpose**: Typed variant of remote request-handle dispatch.

**Data flow**: Consumes a `ClientRequest`, derives the method name, awaits `self.request`, maps transport/server failures into `TypedRequestError`, deserializes the JSON result into `T`, and returns it.

**Call relations**: Mirror of `RemoteAppServerClient::request_typed` for cloned request handles.

*Call graph*: calls 1 internal fn (request); 2 external calls (request_method_name, from_value).


##### `connect_websocket_endpoint`  (lines 676–737)

```
async fn connect_websocket_endpoint(
    websocket_url: String,
    auth_token: Option<String>,
) -> IoResult<(String, WebSocketStream<MaybeTlsStream<TcpStream>>)>
```

**Purpose**: Establishes a remote TCP WebSocket connection with optional bearer auth and configured message-size limits.

**Data flow**: Consumes a WebSocket URL and optional auth token, parses the URL, enforces auth-token transport policy with `websocket_url_supports_auth_token`, builds a client request and optional `Authorization` header, ensures the rustls crypto provider is installed, creates a `WebSocketConfig` via `remote_websocket_config`, connects with `connect_async_with_config` under `CONNECT_TIMEOUT`, and returns the endpoint string plus `WebSocketStream`.

**Call relations**: Called by `RemoteAppServerClient::connect` for `WebSocket` endpoints.

*Call graph*: calls 2 internal fn (remote_websocket_config, websocket_url_supports_auth_token); called by 1 (connect); 7 external calls (from_str, parse, new, ensure_rustls_crypto_provider, format!, timeout, connect_async_with_config).


##### `connect_unix_socket_endpoint`  (lines 739–784)

```
async fn connect_unix_socket_endpoint(
    socket_path: AbsolutePathBuf,
) -> IoResult<(String, WebSocketStream<UnixStream>)>
```

**Purpose**: Establishes a remote Unix-socket connection and upgrades it to WebSocket using a synthetic handshake URL.

**Data flow**: Consumes an absolute socket path, formats an endpoint label, builds a client request from `UDS_WEBSOCKET_HANDSHAKE_URL`, connects the Unix socket under `CONNECT_TIMEOUT`, upgrades it with `client_async_with_config` using `remote_websocket_config`, and returns the endpoint label plus `WebSocketStream<UnixStream>`.

**Call relations**: Called by `RemoteAppServerClient::connect` for `UnixSocket` endpoints.

*Call graph*: calls 3 internal fn (remote_websocket_config, connect, as_path); called by 1 (connect); 3 external calls (format!, timeout, client_async_with_config).


##### `remote_websocket_config`  (lines 786–790)

```
fn remote_websocket_config() -> WebSocketConfig
```

**Purpose**: Builds the WebSocket configuration used for all remote transports, including large frame and message size limits.

**Data flow**: Starts from `WebSocketConfig::default()`, sets both max frame size and max message size to `REMOTE_APP_SERVER_MAX_WEBSOCKET_MESSAGE_SIZE`, and returns the config.

**Call relations**: Shared by both WebSocket and Unix-socket connection setup paths.

*Call graph*: called by 2 (connect_unix_socket_endpoint, connect_websocket_endpoint); 1 external calls (default).


##### `initialize_remote_connection`  (lines 792–934)

```
async fn initialize_remote_connection(
    stream: &mut WebSocketStream<S>,
    endpoint: &str,
    params: InitializeParams,
    initialize_timeout: Duration,
) -> IoResult<(Vec<AppServerEvent>, Opti
```

**Purpose**: Performs the remote initialize/initialized handshake, buffering any notifications or server requests that arrive before initialization completes.

**Data flow**: Consumes a mutable WebSocket stream, endpoint label, initialize params, and timeout. It sends an `initialize` JSON-RPC request via `write_jsonrpc_message`, then loops under `timeout` reading frames. Matching initialize responses extract `server_version` from `userAgent` and `codex_home` from `codexHome`; matching initialize errors become I/O errors; notifications are converted with `app_server_event_from_notification` and buffered; server requests are converted to `AppServerEvent::ServerRequest` or rejected with `-32601`; close/transport/EOF conditions become descriptive I/O errors. After success it sends the `initialized` notification and returns buffered events plus extracted metadata.

**Call relations**: Called by `connect_with_stream` before the worker starts so the client begins in a fully initialized state.

*Call graph*: calls 4 internal fn (app_server_event_from_notification, jsonrpc_notification_from_client_notification, jsonrpc_request_from_client_request, write_jsonrpc_message); called by 1 (connect_with_stream); 13 external calls (try_from, new, next, ServerRequest, Error, Notification, Request, String, new, other (+3 more)).


##### `app_server_event_from_notification`  (lines 936–941)

```
fn app_server_event_from_notification(notification: JSONRPCNotification) -> Option<AppServerEvent>
```

**Purpose**: Attempts to convert a raw JSON-RPC notification into a typed app-server event.

**Data flow**: Consumes a `JSONRPCNotification`, tries `ServerNotification::try_from`, and returns `Some(AppServerEvent::ServerNotification(...))` on success or `None` for unknown notifications.

**Call relations**: Used during initialize-time buffering and live worker notification handling.

*Call graph*: called by 1 (initialize_remote_connection); 2 external calls (try_from, ServerNotification).


##### `deliver_event`  (lines 943–953)

```
fn deliver_event(
    event_tx: &mpsc::UnboundedSender<AppServerEvent>,
    event: AppServerEvent,
) -> IoResult<()>
```

**Purpose**: Sends an app-server event to the remote client’s consumer channel, converting channel closure into an I/O error.

**Data flow**: Consumes the unbounded event sender and an `AppServerEvent`, calls `send`, and returns `Ok(())` or a `BrokenPipe` `IoError` if the consumer channel is closed.

**Call relations**: Used by the remote worker whenever it needs to surface notifications, server requests, or disconnect events.

*Call graph*: 1 external calls (send).


##### `jsonrpc_request_from_client_request`  (lines 955–964)

```
fn jsonrpc_request_from_client_request(request: ClientRequest) -> JSONRPCRequest
```

**Purpose**: Converts a typed `ClientRequest` into the generic JSON-RPC request shape expected by the remote transport.

**Data flow**: Consumes a `ClientRequest`, serializes it to `serde_json::Value`, deserializes that value into `JSONRPCRequest`, and panics if either conversion fails.

**Call relations**: Used by remote request sending and by initialize handshake setup.

*Call graph*: called by 2 (request, initialize_remote_connection); 3 external calls (panic!, from_value, to_value).


##### `jsonrpc_notification_from_client_notification`  (lines 966–977)

```
fn jsonrpc_notification_from_client_notification(
    notification: ClientNotification,
) -> JSONRPCNotification
```

**Purpose**: Converts a typed `ClientNotification` into the generic JSON-RPC notification shape expected by the remote transport.

**Data flow**: Consumes a `ClientNotification`, serializes it to `serde_json::Value`, deserializes that value into `JSONRPCNotification`, and panics if either conversion fails.

**Call relations**: Used when sending the post-initialize `initialized` notification and other remote notifications.

*Call graph*: called by 1 (initialize_remote_connection); 3 external calls (panic!, from_value, to_value).


##### `write_jsonrpc_message`  (lines 979–996)

```
async fn write_jsonrpc_message(
    stream: &mut WebSocketStream<S>,
    message: JSONRPCMessage,
    endpoint: &str,
) -> IoResult<()>
```

**Purpose**: Serializes and writes one JSON-RPC message as a WebSocket text frame with endpoint-qualified error reporting.

**Data flow**: Consumes a mutable WebSocket stream, `JSONRPCMessage`, and endpoint label, serializes the message to a JSON string, sends it as `Message::Text`, and returns `IoResult<()>` with contextualized write errors.

**Call relations**: Used by initialize handshake logic and throughout the remote worker for all outbound messages.

*Call graph*: called by 1 (initialize_remote_connection); 3 external calls (send, to_string, Text).


##### `websocket_close_error_is_already_closed`  (lines 998–1007)

```
fn websocket_close_error_is_already_closed(err: &TungsteniteError) -> bool
```

**Purpose**: Recognizes close errors that indicate the WebSocket was already closed and can be treated as benign during shutdown.

**Data flow**: Reads a borrowed `TungsteniteError`, returns true for `ConnectionClosed`, `AlreadyClosed`, or certain underlying I/O kinds (`BrokenPipe`, `ConnectionReset`, `NotConnected`), and false otherwise.

**Call relations**: Used by the remote worker’s shutdown path to suppress harmless close failures.

*Call graph*: 1 external calls (matches!).


##### `tests::shutdown_tolerates_worker_exit_after_command_is_queued`  (lines 1013–1032)

```
async fn shutdown_tolerates_worker_exit_after_command_is_queued()
```

**Purpose**: Verifies that remote client shutdown succeeds even if the worker exits after receiving the shutdown command but before replying normally.

**Data flow**: Constructs a minimal `RemoteAppServerClient` with a worker that exits after one command, calls `shutdown()`, and asserts it completes successfully.

**Call relations**: Regression test for remote shutdown robustness.

*Call graph*: 3 external calls (new, channel, spawn).


### `tui/src/app_server_session.rs`

`io_transport` · `startup and request handling`

This is the main app-server integration layer for the TUI. `AppServerSession` wraps an `AppServerClient`, tracks monotonically increasing request ids, remembers whether the session is embedded or remote via `ThreadParamsMode`, optionally carries a remote cwd override, caches model metadata discovered during bootstrap, and downgrades capabilities such as `thread/settings/update` when older servers reject them. The module keeps JSON-RPC details out of `App` and `ChatWidget` by exposing typed async methods for account reads, external-agent config detection/import, thread start/resume/fork/list/read/archive/delete/unsubscribe, turn start/interrupt/steer, review start, skills listing, memory reset, goal operations, logout, and server-request resolution/rejection.

A large portion of the file is request shaping. Helpers such as `thread_start_params_from_config`, `thread_resume_params_from_config`, and `thread_fork_params_from_config` derive app-server params from local `Config`, threading through model provider selection, service-tier overrides, approval policy, reviewer, sandbox vs named permission profile selection, cwd handling for embedded vs remote sessions, workspace roots, and optional terminal-visualization developer instructions. `turn_permissions_overrides` similarly decides whether a turn preserves sticky thread permissions, selects an active profile id, or projects a legacy sandbox policy.

The response side maps app-server thread responses into `ThreadSessionState`, parsing `ThreadId`s, preserving fork ancestry, deriving display permission profiles differently for embedded and remote sessions, and attaching cross-session message-history metadata from `codex_message_history`. Bootstrap is optimized to fetch account and model list up front while intentionally deferring rate-limit snapshots so the first frame can render quickly. Tests in this file heavily document edge cases: remote sessions omit cwd unless explicitly overridden, sandbox projection only treats cwd/project-root write access as workspace-write, unsupported `thread/settings/update` errors disable future attempts, and resume/fork/start mappings preserve turns and metadata correctly.

#### Function details

##### `bootstrap_request_error`  (lines 140–142)

```
fn bootstrap_request_error(context: &'static str, err: TypedRequestError) -> color_eyre::Report
```

**Purpose**: Wraps a typed request failure with a fixed bootstrap-specific context string as a `color_eyre::Report`.

**Data flow**: It takes a static context string and a `TypedRequestError`, formats them into an eyre report, and returns that report. It reads no external state and writes none.

**Call relations**: This helper is used by bootstrap/startup RPC paths to normalize error messages before they bubble up to callers such as `bootstrap`, `read_account`, and startup thread creation.

*Call graph*: 1 external calls (eyre!).


##### `is_thread_settings_update_unsupported`  (lines 144–148)

```
fn is_thread_settings_update_unsupported(source: &JSONRPCErrorError) -> bool
```

**Purpose**: Detects whether a JSON-RPC error means the remote server does not support the experimental `thread/settings/update` method.

**Data flow**: It reads `source.code` and `source.message` from a `JSONRPCErrorError`. It returns `true` for method-not-found or invalid-request errors whose message mentions `thread/settings/update`; otherwise `false`.

**Call relations**: This predicate is consulted by `AppServerSession::thread_settings_update` when deciding whether to silently downgrade capability support for the rest of the session instead of surfacing repeated errors.

*Call graph*: called by 1 (thread_settings_update).


##### `ThreadParamsMode::model_provider_from_config`  (lines 190–195)

```
fn model_provider_from_config(self, config: &Config) -> Option<String>
```

**Purpose**: Determines whether thread lifecycle requests should include the local model provider id from config.

**Data flow**: It takes `self` and a `&Config`. In `Embedded` mode it returns `Some(config.model_provider_id.clone())`; in `Remote` mode it returns `None` so the remote server chooses provider context itself.

**Call relations**: This helper is used by all thread lifecycle param builders so start/resume/fork requests consistently omit local provider ids for remote workspaces.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config).


##### `AppServerSession::new`  (lines 215–226)

```
fn new(client: AppServerClient, thread_params_mode: ThreadParamsMode) -> Self
```

**Purpose**: Creates a fresh session facade with default request-id state, no remote cwd override, optimistic thread-settings support, and empty model caches.

**Data flow**: It takes an `AppServerClient` and `ThreadParamsMode`, stores them, initializes `next_request_id` to 1, `remote_cwd_override` to `None`, `thread_settings_update_supported` to `true`, `default_model` to `None`, `available_models` to an empty vector, and the import-completion flag to `false`. It returns the new `AppServerSession`.

**Call relations**: This constructor is used at app startup and in picker/archive helper flows to establish the session object that all later RPC methods operate on.

*Call graph*: called by 6 (run_ratatui_app, start_app_server_for_archive_command, start_app_server_for_picker, fork_last_filters_latest_session_by_cwd_unless_show_all, latest_session_lookup_falls_back_for_rollout_missing_from_state_db, lookup_session_target_by_name_uses_backend_title_search); 2 external calls (new, new).


##### `AppServerSession::with_remote_cwd_override`  (lines 228–231)

```
fn with_remote_cwd_override(mut self, remote_cwd_override: Option<PathBuf>) -> Self
```

**Purpose**: Returns a modified session that carries an explicit remote cwd override for remote thread lifecycle requests.

**Data flow**: It takes ownership of `self` and an `Option<PathBuf>`, writes that option into `self.remote_cwd_override`, and returns the updated session.

**Call relations**: This builder-style method is used when launch context or picker flows know the server-side working directory that should be forwarded on remote sessions.


##### `AppServerSession::remote_cwd_override`  (lines 233–235)

```
fn remote_cwd_override(&self) -> Option<&std::path::Path>
```

**Purpose**: Exposes the configured remote cwd override as an optional borrowed path.

**Data flow**: It reads `self.remote_cwd_override` and returns `Option<&Path>` via `as_deref()`. No mutation occurs.

**Call relations**: Startup-thread spawning and picker flows call this accessor when they need to forward the same override into helper functions without taking ownership.

*Call graph*: called by 3 (spawn_startup_thread_start, run_fork_picker_with_app_server, run_resume_picker_with_launch_context).


##### `AppServerSession::uses_remote_workspace`  (lines 237–239)

```
fn uses_remote_workspace(&self) -> bool
```

**Purpose**: Reports whether this session is operating in remote-workspace mode.

**Data flow**: It pattern-matches `self.thread_params_mode` and returns `true` only for `ThreadParamsMode::Remote`.

**Call relations**: Higher-level orchestration uses this to branch UI and lookup behavior for remote sessions, such as migration prompts and session-target resolution.

*Call graph*: called by 4 (handle_external_agent_config_migration_prompt, lookup_latest_session_target_with_app_server, run_fork_picker_with_app_server, run_resume_picker_with_launch_context); 1 external calls (matches!).


##### `AppServerSession::uses_embedded_app_server`  (lines 241–243)

```
fn uses_embedded_app_server(&self) -> bool
```

**Purpose**: Reports whether the underlying app-server client is in-process rather than remote.

**Data flow**: It pattern-matches `self.client` and returns `true` for `AppServerClient::InProcess(_)`, otherwise `false`.

**Call relations**: This is consulted by migration and environment-sensitive flows that need to know whether the TUI is talking to a local embedded server or a remote one.

*Call graph*: called by 1 (handle_external_agent_config_migration_prompt); 1 external calls (matches!).


##### `AppServerSession::codex_home_path`  (lines 245–250)

```
fn codex_home_path(
        &self,
        local_codex_home: &AbsolutePathBuf,
    ) -> Option<AppServerPath>
```

**Purpose**: Converts a local Codex home path into an app-server path when the client can represent it.

**Data flow**: It takes `&AbsolutePathBuf`, delegates to `self.client.codex_home(local_codex_home)`, and returns `Option<AppServerPath>`.

**Call relations**: Goal-editor and goal-draft flows use this to obtain a path token suitable for app-server file operations without embedding client-specific path logic.

*Call graph*: calls 1 internal fn (codex_home); called by 2 (open_thread_goal_editor, set_thread_goal_draft).


##### `AppServerSession::server_version`  (lines 252–257)

```
fn server_version(&self) -> Option<&str>
```

**Purpose**: Returns the remote app-server version string when connected to a remote server.

**Data flow**: It inspects `self.client`; for `AppServerClient::Remote(client)` it returns `client.server_version()`, otherwise `None`.

**Call relations**: Startup code queries this during `run` to surface or record remote server version information when available.

*Call graph*: called by 1 (run).


##### `AppServerSession::bootstrap`  (lines 259–347)

```
async fn bootstrap(&mut self, config: &Config) -> Result<AppServerBootstrap>
```

**Purpose**: Performs initial account and model discovery needed to configure the TUI before the main loop starts.

**Data flow**: It records `Instant::now()`, calls `read_account`, allocates a request id, sends `ClientRequest::ModelList` with hidden models included, maps returned API models through `model_preset_from_api_model`, chooses a default model from config, server defaults, or the first available model, caches `default_model` and `available_models` on `self`, derives account email/auth mode/status display/plan type/feedback audience/ChatGPT-account presence from `account.account`, and returns an `AppServerBootstrap` containing those fields plus elapsed duration and `requires_openai_auth`.

**Call relations**: This is called during top-level app startup before the first frame. It delegates account fetching to `read_account` and model conversion to `model_preset_from_api_model`, and its output drives initial UI state and later startup rate-limit prefetch decisions.

*Call graph*: calls 3 internal fn (request_typed, next_request_id, read_account); called by 1 (run); 2 external calls (now, plan_type_display_name).


##### `AppServerSession::read_account`  (lines 353–364)

```
async fn read_account(&mut self) -> Result<GetAccountResponse>
```

**Purpose**: Fetches current account information without refreshing auth tokens.

**Data flow**: It allocates a request id, sends `ClientRequest::GetAccount { refresh_token: false }`, and returns the typed `GetAccountResponse` or a wrapped bootstrap-context error.

**Call relations**: Used both by `bootstrap` and lighter-weight login-status checks so callers can inspect auth mode without paying for the full bootstrap sequence.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (bootstrap, get_login_status).


##### `AppServerSession::external_agent_config_detect`  (lines 366–375)

```
async fn external_agent_config_detect(
        &mut self,
        params: ExternalAgentConfigDetectParams,
    ) -> Result<ExternalAgentConfigDetectResponse>
```

**Purpose**: Runs the app-server RPC that detects importable external agent configuration.

**Data flow**: It takes `ExternalAgentConfigDetectParams`, allocates a request id, sends `ClientRequest::ExternalAgentConfigDetect`, awaits the typed response, and returns `ExternalAgentConfigDetectResponse` or a wrapped error.

**Call relations**: Migration-prompt handling calls this before offering Claude Code import actions, delegating all transport details to this method.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (handle_external_agent_config_migration_prompt).


##### `AppServerSession::external_agent_config_import`  (lines 377–406)

```
async fn external_agent_config_import(
        &mut self,
        migration_items: Vec<ExternalAgentConfigMigrationItem>,
    ) -> Result<()>
```

**Purpose**: Starts an external-agent config import while guarding against overlapping imports and races with completion notifications.

**Data flow**: It first atomically sets `external_agent_config_import_completion_pending` to `true` with `swap`; if it was already true, it returns a bail error with `EXTERNAL_AGENT_CONFIG_IMPORT_IN_PROGRESS_MESSAGE`. Otherwise it allocates a request id, sends `ClientRequest::ExternalAgentConfigImport { migration_items }`, and returns `Ok(())` on success. If the request fails, it resets the atomic flag to `false` before returning the error.

**Call relations**: Called by migration UI handling when the user confirms import. It coordinates with `external_agent_config_import_in_progress` and `consume_external_agent_config_import_completion` so the app can track import lifecycle across async notifications.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (handle_external_agent_config_migration_prompt); 3 external calls (store, swap, bail!).


##### `AppServerSession::external_agent_config_import_in_progress`  (lines 408–411)

```
fn external_agent_config_import_in_progress(&self) -> bool
```

**Purpose**: Reports whether an external-agent config import is currently marked as pending completion.

**Data flow**: It atomically reads `external_agent_config_import_completion_pending` with relaxed ordering and returns the boolean.

**Call relations**: Migration UI checks this before starting another import so it can suppress duplicate requests and show the in-progress state.

*Call graph*: called by 1 (handle_external_agent_config_migration_prompt); 1 external calls (load).


##### `AppServerSession::consume_external_agent_config_import_completion`  (lines 413–416)

```
fn consume_external_agent_config_import_completion(&self) -> bool
```

**Purpose**: Clears and returns the pending-import-completion flag in one atomic operation.

**Data flow**: It atomically swaps `external_agent_config_import_completion_pending` to `false` and returns the previous value.

**Call relations**: Server-notification handling calls this when an import completion event arrives, using the returned flag to decide whether there was an outstanding import to finalize.

*Call graph*: called by 1 (handle_server_notification_event); 1 external calls (swap).


##### `AppServerSession::next_event`  (lines 418–420)

```
async fn next_event(&mut self) -> Option<AppServerEvent>
```

**Purpose**: Awaits the next raw event emitted by the underlying app-server client.

**Data flow**: It delegates directly to `self.client.next_event().await` and returns `Option<AppServerEvent>`.

**Call relations**: Higher-level event loops use this as the source of app-server notifications and request events, keeping client-specific polling out of orchestration code.

*Call graph*: calls 1 internal fn (next_event); called by 1 (next_thread_settings_updated).


##### `AppServerSession::start_thread`  (lines 423–426)

```
async fn start_thread(&mut self, config: &Config) -> Result<AppServerStartedThread>
```

**Purpose**: Test-only convenience wrapper that starts a new thread without an explicit session-start source.

**Data flow**: It takes `&Config`, forwards to `start_thread_with_session_start_source(config, None)`, and returns the resulting `AppServerStartedThread`.

**Call relations**: This exists only under `#[cfg(test)]` and delegates all real work to the general start-thread method.

*Call graph*: calls 1 internal fn (start_thread_with_session_start_source).


##### `AppServerSession::start_thread_with_session_start_source`  (lines 428–451)

```
async fn start_thread_with_session_start_source(
        &mut self,
        config: &Config,
        session_start_source: Option<ThreadStartSource>,
    ) -> Result<AppServerStartedThread>
```

**Purpose**: Starts a new app-server thread using config-derived parameters and maps the response into TUI session state.

**Data flow**: It allocates a request id, derives a session config via `session_config_with_effective_service_tier`, builds `ThreadStartParams` with `thread_start_params_from_config`, sends `ClientRequest::ThreadStart`, and converts the `ThreadStartResponse` into `AppServerStartedThread` via `started_thread_from_start_response`.

**Call relations**: Fresh-session startup paths call this, optionally tagging the start source such as clear-mode handoff. It delegates request shaping and response mapping to dedicated helpers.

*Call graph*: calls 6 internal fn (request_typed, next_request_id, session_config_with_effective_service_tier, thread_params_mode, started_thread_from_start_response, thread_start_params_from_config); called by 2 (start_fresh_session_with_summary_hint, start_thread).


##### `AppServerSession::resume_thread`  (lines 453–483)

```
async fn resume_thread(
        &mut self,
        config: Config,
        thread_id: ThreadId,
    ) -> Result<AppServerStartedThread>
```

**Purpose**: Resumes an existing thread, then enriches the resulting session state with the fork parent's title when applicable.

**Data flow**: It takes owned `Config` and `ThreadId`, allocates a request id, derives effective service-tier config, builds `ThreadResumeParams`, sends `ClientRequest::ThreadResume`, optionally looks up the fork parent title via `fork_parent_title_from_app_server(response.thread.forked_from_id.as_deref())`, maps the response through `started_thread_from_resume_response`, writes the fetched title into `started.session.fork_parent_title`, and returns the started thread bundle.

**Call relations**: Used during startup resume, picker selection, and snapshot refresh flows. It delegates request construction and response mapping to helpers, with an extra metadata read to improve fork ancestry display.

*Call graph*: calls 7 internal fn (request_typed, fork_parent_title_from_app_server, next_request_id, session_config_with_effective_service_tier, thread_params_mode, started_thread_from_resume_response, thread_resume_params_from_config); called by 4 (run, attach_live_thread_for_selection, resume_target_session, refresh_snapshot_session_if_needed).


##### `AppServerSession::fork_thread`  (lines 485–514)

```
async fn fork_thread(
        &mut self,
        config: Config,
        thread_id: ThreadId,
    ) -> Result<AppServerStartedThread>
```

**Purpose**: Forks an existing thread into a new thread and maps the fork response into TUI session state.

**Data flow**: It takes owned `Config` and source `ThreadId`, allocates a request id, derives effective service-tier config, builds `ThreadForkParams`, sends `ClientRequest::ThreadFork`, optionally fetches the parent title via `fork_parent_title_from_app_server`, maps the response with `started_thread_from_fork_response`, stores the parent title in the returned session, and returns `AppServerStartedThread`.

**Call relations**: Called by explicit fork actions and side-conversation startup. Like resume, it layers a metadata lookup on top of the basic fork RPC so the UI can label the parent thread.

*Call graph*: calls 7 internal fn (request_typed, fork_parent_title_from_app_server, next_request_id, session_config_with_effective_service_tier, thread_params_mode, started_thread_from_fork_response, thread_fork_params_from_config); called by 3 (run, handle_event, handle_start_side).


##### `AppServerSession::thread_params_mode`  (lines 516–518)

```
fn thread_params_mode(&self) -> ThreadParamsMode
```

**Purpose**: Returns the session's configured thread-parameter mode.

**Data flow**: It reads `self.thread_params_mode` and returns the `ThreadParamsMode` copy.

**Call relations**: Startup-thread spawning and lifecycle methods use this accessor when they need to pass the mode into helper functions without directly reaching into struct fields.

*Call graph*: called by 4 (spawn_startup_thread_start, fork_thread, resume_thread, start_thread_with_session_start_source).


##### `AppServerSession::session_config_with_effective_service_tier`  (lines 520–544)

```
fn session_config_with_effective_service_tier(&self, config: &Config) -> Config
```

**Purpose**: Clones config and normalizes its service-tier fields based on the selected/default model and available model metadata.

**Data flow**: It reads `config.model` or `self.default_model`; if neither exists it returns `config.clone()`. Otherwise it clones the config, calls `service_tier_resolution::service_tier_update_for_core`, and updates `session_config.service_tier` plus clears `session_config.notices.fast_default_opt_out` according to whether the model implies an explicit tier, the default-request sentinel, or no tier. It returns the adjusted `Config`.

**Call relations**: Thread start/resume/fork methods call this before building request params so lifecycle RPCs consistently reflect the effective service-tier policy for the chosen model.

*Call graph*: calls 1 internal fn (service_tier_update_for_core); called by 3 (fork_thread, resume_thread, start_thread_with_session_start_source); 1 external calls (clone).


##### `AppServerSession::fork_parent_title_from_app_server`  (lines 546–569)

```
async fn fork_parent_title_from_app_server(
        &mut self,
        forked_from_id: Option<&str>,
    ) -> Option<String>
```

**Purpose**: Looks up the display name of a fork parent thread, tolerating malformed ids and read failures.

**Data flow**: It takes `Option<&str>` forked-from id. If absent it returns `None`. If present, it parses the string with `ThreadId::from_string`; parse failure logs a warning and returns `None`. On success it calls `thread_read(thread_id, false)` and returns `thread.name` on success, or logs a warning and returns `None` on failure.

**Call relations**: Resume and fork flows call this after receiving a thread response that references a parent thread. It delegates metadata retrieval to `thread_read` and intentionally degrades to `None` rather than failing the whole lifecycle operation.

*Call graph*: calls 2 internal fn (from_string, thread_read); called by 2 (fork_thread, resume_thread); 1 external calls (warn!).


##### `AppServerSession::thread_list`  (lines 571–580)

```
async fn thread_list(
        &mut self,
        params: ThreadListParams,
    ) -> Result<ThreadListResponse>
```

**Purpose**: Fetches a paginated/searchable list of threads from the app server.

**Data flow**: It takes `ThreadListParams`, allocates a request id, sends `ClientRequest::ThreadList`, and returns `ThreadListResponse` or a wrapped lookup error.

**Call relations**: Session lookup, picker page loading, and exact-name search flows call this to enumerate candidate threads.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 4 (lookup_latest_session_target_with_app_server, lookup_session_target_by_name_with_app_server, load_app_server_page, lookup_session_by_exact_name).


##### `AppServerSession::thread_loaded_list`  (lines 587–596)

```
async fn thread_loaded_list(
        &mut self,
        params: ThreadLoadedListParams,
    ) -> Result<ThreadLoadedListResponse>
```

**Purpose**: Lists thread ids currently loaded in app-server memory rather than persisted thread metadata.

**Data flow**: It takes `ThreadLoadedListParams`, allocates a request id, sends `ClientRequest::ThreadLoadedList`, and returns `ThreadLoadedListResponse` or a wrapped error.

**Call relations**: Backfill logic for subagent threads uses this to discover already-loaded threads that predate the TUI connection, then follows up with `thread_read` for full metadata.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (backfill_loaded_subagent_threads).


##### `AppServerSession::thread_read`  (lines 598–616)

```
async fn thread_read(
        &mut self,
        thread_id: ThreadId,
        include_turns: bool,
    ) -> Result<Thread>
```

**Purpose**: Reads metadata for a single thread, optionally including its turns.

**Data flow**: It takes `ThreadId` and `include_turns: bool`, allocates a request id, sends `ClientRequest::ThreadRead` with the thread id stringified, awaits `ThreadReadResponse`, and returns `response.thread`.

**Call relations**: Many flows depend on this primitive, including picker previews, transcript loading, liveness refresh, session-target resolution, and fork-parent title lookup.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 8 (attach_live_thread_for_selection, backfill_loaded_subagent_threads, refresh_agent_picker_thread_liveness, fork_parent_title_from_app_server, lookup_session_target_with_app_server, load_transcript_preview, resolve_session_target, load_session_transcript); 1 external calls (to_string).


##### `AppServerSession::thread_archive`  (lines 618–631)

```
async fn thread_archive(&mut self, thread_id: ThreadId) -> Result<()>
```

**Purpose**: Archives a thread on the app server.

**Data flow**: It takes `ThreadId`, allocates a request id, sends `ClientRequest::ThreadArchive` with the stringified id, ignores the typed response body, and returns `Ok(())` or a wrapped error.

**Call relations**: Archive actions call this as the transport layer for both current-thread archive and archive commands launched from session-management flows.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (archive_current_thread, run_session_archive_action_with_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_delete`  (lines 633–646)

```
async fn thread_delete(&mut self, thread_id: ThreadId) -> Result<()>
```

**Purpose**: Permanently deletes a thread on the app server.

**Data flow**: It takes `ThreadId`, allocates a request id, sends `ClientRequest::ThreadDelete`, discards the typed response, and returns `Ok(())` or a wrapped error.

**Call relations**: Delete-session flows use this as the RPC boundary for destructive thread removal.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (delete_current_thread, run_session_archive_action_with_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_unarchive`  (lines 648–661)

```
async fn thread_unarchive(&mut self, thread_id: ThreadId) -> Result<Thread>
```

**Purpose**: Restores an archived thread and returns its updated metadata.

**Data flow**: It takes `ThreadId`, allocates a request id, sends `ClientRequest::ThreadUnarchive`, awaits `ThreadUnarchiveResponse`, and returns `response.thread`.

**Call relations**: Archive-management flows call this when the user chooses to restore a previously archived session.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (run_session_archive_action_with_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_metadata_update_branch`  (lines 663–683)

```
async fn thread_metadata_update_branch(
        &mut self,
        thread_id: ThreadId,
        branch: String,
    ) -> Result<ThreadMetadataUpdateResponse>
```

**Purpose**: Writes git branch metadata into a thread's stored metadata record.

**Data flow**: It takes `thread_id` and `branch`, allocates a request id, sends `ClientRequest::ThreadMetadataUpdate` with `git_info.branch` set to `Some(Some(branch))`, and returns the typed `ThreadMetadataUpdateResponse`.

**Call relations**: The app event handler invokes this when it discovers a branch from git-action directives and wants persisted thread metadata to match.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (handle_event); 1 external calls (to_string).


##### `AppServerSession::thread_settings_update`  (lines 685–716)

```
async fn thread_settings_update(
        &mut self,
        params: ThreadSettingsUpdateParams,
    ) -> Result<()>
```

**Purpose**: Best-effort updates thread settings on servers that support the experimental method, permanently disabling future attempts after a compatibility failure.

**Data flow**: It first reads `self.thread_settings_update_supported`; if false, it returns `Ok(())` immediately. Otherwise it allocates a request id and sends `ClientRequest::ThreadSettingsUpdate`. On success it returns `Ok(())`. On server errors, it checks `is_thread_settings_update_unsupported`; if true, it writes `false` into `self.thread_settings_update_supported` and returns `Ok(())`. Other errors are wrapped and returned.

**Call relations**: Called by higher-level thread-settings sync code after local model/effort/personality/mode changes. It delegates compatibility classification to `is_thread_settings_update_unsupported` so unsupported remote servers degrade silently after the first rejection.

*Call graph*: calls 2 internal fn (next_request_id, is_thread_settings_update_unsupported); called by 1 (send_thread_settings_update).


##### `AppServerSession::thread_inject_items`  (lines 718–739)

```
async fn thread_inject_items(
        &mut self,
        thread_id: ThreadId,
        items: Vec<ResponseItem>,
    ) -> Result<ThreadInjectItemsResponse>
```

**Purpose**: Injects serialized response items into an existing thread, typically when setting up side conversations.

**Data flow**: It takes `thread_id` and `Vec<ResponseItem>`, serializes each item with `serde_json::to_value`, collecting into a `Vec<serde_json::Value>`, allocates a request id, sends `ClientRequest::ThreadInjectItems`, and returns `ThreadInjectItemsResponse` or an encoding/request error.

**Call relations**: Side-thread setup calls this after forking/creating a thread so selected items can be inserted into the new conversation context.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (handle_start_side); 1 external calls (to_string).


##### `AppServerSession::turn_start`  (lines 742–789)

```
async fn turn_start(
        &mut self,
        thread_id: ThreadId,
        items: Vec<UserInput>,
        cwd: PathBuf,
        approval_policy: AskForApproval,
        approvals_reviewer: codex_pro
```

**Purpose**: Starts a new turn on a thread with explicit input items, cwd, approval settings, permission overrides, model settings, and optional structured-output schema.

**Data flow**: It takes thread id, user input items, cwd, approval policy, reviewer, `TurnPermissionsOverride`, workspace roots, model, optional effort/summary/service tier/collaboration mode/personality/output schema. It computes `(sandbox_policy, permissions)` via `turn_permissions_overrides`, allocates a request id, builds `TurnStartParams` with all supplied fields plus stringified thread id and cloned workspace roots, sends `ClientRequest::TurnStart`, and returns `TurnStartResponse` or a wrapped error.

**Call relations**: This is the main outbound path used by active-thread operation submission when a new turn begins. It delegates permission-shape decisions to `turn_permissions_overrides` and leaves all higher-level command interpretation to callers.

*Call graph*: calls 3 internal fn (request_typed, next_request_id, turn_permissions_overrides); called by 1 (try_submit_active_thread_op_via_app_server); 4 external calls (as_path, into, to_string, to_vec).


##### `AppServerSession::turn_interrupt`  (lines 791–808)

```
async fn turn_interrupt(
        &mut self,
        thread_id: ThreadId,
        turn_id: String,
    ) -> std::result::Result<(), TypedRequestError>
```

**Purpose**: Requests interruption of a specific turn on a thread.

**Data flow**: It takes `thread_id` and `turn_id`, allocates a request id, sends `ClientRequest::TurnInterrupt`, discards the typed response body, and returns `Result<(), TypedRequestError>` without additional wrapping.

**Call relations**: Interrupt flows call this for normal turn cancellation. `startup_interrupt` is a thin specialization built on top of it.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 3 (interrupt_side_thread, try_submit_active_thread_op_via_app_server, startup_interrupt); 1 external calls (to_string).


##### `AppServerSession::startup_interrupt`  (lines 810–815)

```
async fn startup_interrupt(
        &mut self,
        thread_id: ThreadId,
    ) -> std::result::Result<(), TypedRequestError>
```

**Purpose**: Interrupts the startup turn using an empty turn id sentinel.

**Data flow**: It takes `thread_id`, constructs an empty `String` for `turn_id`, and forwards to `turn_interrupt`, returning the same result type.

**Call relations**: Used by startup-specific interrupt paths that target the initial bootstrap turn before a concrete turn id is available.

*Call graph*: calls 1 internal fn (turn_interrupt); called by 2 (interrupt_side_thread, try_submit_active_thread_op_via_app_server); 1 external calls (new).


##### `AppServerSession::turn_steer`  (lines 817–837)

```
async fn turn_steer(
        &mut self,
        thread_id: ThreadId,
        turn_id: String,
        items: Vec<UserInput>,
    ) -> std::result::Result<TurnSteerResponse, TypedRequestError>
```

**Purpose**: Sends steering input to an existing in-flight turn, expecting a specific turn id.

**Data flow**: It takes `thread_id`, `turn_id`, and `Vec<UserInput>`, allocates a request id, builds `TurnSteerParams` with the expected turn id and input items, sends `ClientRequest::TurnSteer`, and returns `TurnSteerResponse` or `TypedRequestError`.

**Call relations**: Active-thread submission logic uses this when the user is steering an existing turn rather than starting a new one.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_set_name`  (lines 839–857)

```
async fn thread_set_name(
        &mut self,
        thread_id: ThreadId,
        name: String,
    ) -> Result<()>
```

**Purpose**: Renames a thread on the app server.

**Data flow**: It takes `thread_id` and `name`, allocates a request id, sends `ClientRequest::ThreadSetName`, discards the typed response, and returns `Ok(())` or a wrapped error.

**Call relations**: Called from app-command submission when the user renames the current thread.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_memory_mode_set`  (lines 859–877)

```
async fn thread_memory_mode_set(
        &mut self,
        thread_id: ThreadId,
        mode: ThreadMemoryMode,
    ) -> Result<()>
```

**Purpose**: Updates the memory mode for a thread.

**Data flow**: It takes `thread_id` and `ThreadMemoryMode`, allocates a request id, sends `ClientRequest::ThreadMemoryModeSet`, ignores the response body, and returns `Ok(())` or a wrapped error.

**Call relations**: Memory-settings update flows call this to persist thread-level memory behavior through the app server.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (update_memory_settings_with_app_server); 1 external calls (to_string).


##### `AppServerSession::memory_reset`  (lines 879–890)

```
async fn memory_reset(&mut self) -> Result<()>
```

**Purpose**: Clears persisted local memory artifacts through the app-server RPC.

**Data flow**: It allocates a request id, sends `ClientRequest::MemoryReset` with no params, discards the typed response, and returns `Ok(())` or a wrapped error.

**Call relations**: Used by the reset-memories action after the user requests a full memory wipe.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (reset_memories_with_app_server).


##### `AppServerSession::thread_goal_get`  (lines 892–906)

```
async fn thread_goal_get(
        &mut self,
        thread_id: ThreadId,
    ) -> Result<ThreadGoalGetResponse>
```

**Purpose**: Fetches the current goal state for a thread.

**Data flow**: It takes `thread_id`, allocates a request id, sends `ClientRequest::ThreadGoalGet`, and returns `ThreadGoalGetResponse` or a wrapped error.

**Call relations**: Goal menu/editor flows call this before rendering or deciding whether to prompt about paused goals.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 4 (maybe_prompt_resume_paused_goal_after_resume, open_thread_goal_editor, open_thread_goal_menu, set_thread_goal_draft); 1 external calls (to_string).


##### `AppServerSession::thread_goal_set`  (lines 908–928)

```
async fn thread_goal_set(
        &mut self,
        thread_id: ThreadId,
        objective: Option<String>,
        status: Option<ThreadGoalStatus>,
        token_budget: Option<Option<i64>>,
    )
```

**Purpose**: Creates or updates a thread goal's objective, status, and optional token budget.

**Data flow**: It takes `thread_id`, optional `objective`, optional `ThreadGoalStatus`, and `token_budget: Option<Option<i64>>`, allocates a request id, sends `ClientRequest::ThreadGoalSet`, and returns `ThreadGoalSetResponse` or a wrapped error.

**Call relations**: Goal draft and goal-status update flows use this as the transport layer for persisting goal changes.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (set_thread_goal_draft, set_thread_goal_status); 1 external calls (to_string).


##### `AppServerSession::thread_goal_clear`  (lines 930–944)

```
async fn thread_goal_clear(
        &mut self,
        thread_id: ThreadId,
    ) -> Result<ThreadGoalClearResponse>
```

**Purpose**: Removes the current goal from a thread.

**Data flow**: It takes `thread_id`, allocates a request id, sends `ClientRequest::ThreadGoalClear`, and returns `ThreadGoalClearResponse` or a wrapped error.

**Call relations**: Called by explicit clear-goal actions and by draft-setting flows that need to remove an existing goal before replacing it.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 2 (clear_thread_goal, set_thread_goal_draft); 1 external calls (to_string).


##### `AppServerSession::logout_account`  (lines 946–957)

```
async fn logout_account(&mut self) -> Result<()>
```

**Purpose**: Logs the current account out through the app server.

**Data flow**: It allocates a request id, sends `ClientRequest::LogoutAccount`, discards the typed response, and returns `Ok(())` or a wrapped error.

**Call relations**: The app event handler invokes this during logout-and-exit flows.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (handle_event).


##### `AppServerSession::thread_unsubscribe`  (lines 959–972)

```
async fn thread_unsubscribe(&mut self, thread_id: ThreadId) -> Result<()>
```

**Purpose**: Stops the TUI from receiving updates for a thread.

**Data flow**: It takes `thread_id`, allocates a request id, sends `ClientRequest::ThreadUnsubscribe`, ignores the response body, and returns `Ok(())` or a wrapped error.

**Call relations**: Used when discarding side threads, shutting down current threads, or replacing startup threads so the app server can stop streaming updates for no-longer-active subscriptions.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 4 (handle_startup_thread_started, start_fresh_session_with_summary_hint, discard_side_thread, shutdown_current_thread); 1 external calls (to_string).


##### `AppServerSession::thread_compact_start`  (lines 974–987)

```
async fn thread_compact_start(&mut self, thread_id: ThreadId) -> Result<()>
```

**Purpose**: Starts server-side compaction for a thread.

**Data flow**: It takes `thread_id`, allocates a request id, sends `ClientRequest::ThreadCompactStart`, discards the response, and returns `Ok(())` or a wrapped error.

**Call relations**: Active-thread command submission calls this when the user requests compaction.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_shell_command`  (lines 989–1007)

```
async fn thread_shell_command(
        &mut self,
        thread_id: ThreadId,
        command: String,
    ) -> Result<()>
```

**Purpose**: Submits a shell command to run in the context of a thread.

**Data flow**: It takes `thread_id` and `command`, allocates a request id, sends `ClientRequest::ThreadShellCommand`, ignores the response body, and returns `Ok(())` or a wrapped error.

**Call relations**: This is used by app-command submission for shell-command operations associated with a thread.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_approve_guardian_denied_action`  (lines 1009–1028)

```
async fn thread_approve_guardian_denied_action(
        &mut self,
        thread_id: ThreadId,
        event: &GuardianAssessmentEvent,
    ) -> Result<()>
```

**Purpose**: Approves one retry of a guardian-denied action by serializing the denial event back to the app server.

**Data flow**: It takes `thread_id` and `&GuardianAssessmentEvent`, serializes the event with `serde_json::to_value`, allocates a request id, sends `ClientRequest::ThreadApproveGuardianDeniedAction`, discards the response body, and returns `Ok(())` or a wrapped error.

**Call relations**: Used when the user selects a recent auto-review denial for approval retry from the TUI.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 2 external calls (to_string, to_value).


##### `AppServerSession::thread_background_terminals_clean`  (lines 1030–1046)

```
async fn thread_background_terminals_clean(
        &mut self,
        thread_id: ThreadId,
    ) -> Result<()>
```

**Purpose**: Requests cleanup of background terminals associated with a thread.

**Data flow**: It takes `thread_id`, allocates a request id, sends `ClientRequest::ThreadBackgroundTerminalsClean`, ignores the response body, and returns `Ok(())` or a wrapped error.

**Call relations**: Active-thread operation submission uses this when cleanup of background terminals is requested.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::thread_rollback`  (lines 1048–1064)

```
async fn thread_rollback(
        &mut self,
        thread_id: ThreadId,
        num_turns: u32,
    ) -> Result<ThreadRollbackResponse>
```

**Purpose**: Rolls back a specified number of turns on a thread.

**Data flow**: It takes `thread_id` and `num_turns`, allocates a request id, sends `ClientRequest::ThreadRollback`, and returns `ThreadRollbackResponse` or a wrapped error.

**Call relations**: Rollback flows call this before the app applies corresponding local transcript rollback semantics.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::review_start`  (lines 1066–1083)

```
async fn review_start(
        &mut self,
        thread_id: ThreadId,
        target: ReviewTarget,
    ) -> Result<ReviewStartResponse>
```

**Purpose**: Starts a review operation for a thread and requests inline delivery of the review output.

**Data flow**: It takes `thread_id` and `ReviewTarget`, allocates a request id, sends `ClientRequest::ReviewStart` with `delivery: Some(ReviewDelivery::Inline)`, and returns `ReviewStartResponse` or a wrapped error.

**Call relations**: Review commands route through this method so the app server begins the review in the format expected by the TUI transcript.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (to_string).


##### `AppServerSession::skills_list`  (lines 1085–1094)

```
async fn skills_list(
        &mut self,
        params: SkillsListParams,
    ) -> Result<SkillsListResponse>
```

**Purpose**: Fetches the current skills inventory from the app server.

**Data flow**: It takes `SkillsListParams`, allocates a request id, sends `ClientRequest::SkillsList`, and returns `SkillsListResponse` or a wrapped error.

**Call relations**: Interactive and startup skills refresh paths use this typed RPC wrapper.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server).


##### `AppServerSession::reload_user_config`  (lines 1096–1112)

```
async fn reload_user_config(&mut self) -> Result<()>
```

**Purpose**: Triggers a user-config reload through the config batch-write RPC without making edits.

**Data flow**: It allocates a request id, sends `ClientRequest::ConfigBatchWrite` with empty `edits`, no file path/version, and `reload_user_config: true`, discards the response body, and returns `Ok(())` or a wrapped error.

**Call relations**: App-command submission uses this when the user requests config reload from within the TUI.

*Call graph*: calls 2 internal fn (request_typed, next_request_id); called by 1 (try_submit_active_thread_op_via_app_server); 1 external calls (new).


##### `AppServerSession::reject_server_request`  (lines 1114–1120)

```
async fn reject_server_request(
        &self,
        request_id: RequestId,
        error: JSONRPCErrorError,
    ) -> std::io::Result<()>
```

**Purpose**: Rejects an inbound server request with a JSON-RPC error payload.

**Data flow**: It takes a `RequestId` and `JSONRPCErrorError`, delegates to `self.client.reject_server_request`, and returns the resulting `std::io::Result<()>`.

**Call relations**: Higher-level request-rejection helpers call this when the TUI declines or cannot satisfy an app-server initiated request.

*Call graph*: calls 1 internal fn (reject_server_request); called by 1 (reject_app_server_request).


##### `AppServerSession::resolve_server_request`  (lines 1122–1128)

```
async fn resolve_server_request(
        &self,
        request_id: RequestId,
        result: serde_json::Value,
    ) -> std::io::Result<()>
```

**Purpose**: Resolves an inbound server request with a JSON result payload.

**Data flow**: It takes a `RequestId` and `serde_json::Value`, delegates to `self.client.resolve_server_request`, and returns `std::io::Result<()>`.

**Call relations**: Used by app-server request resolution paths after the TUI has gathered the necessary user decision or computed result.

*Call graph*: calls 1 internal fn (resolve_server_request); called by 1 (try_resolve_app_server_request).


##### `AppServerSession::shutdown`  (lines 1130–1132)

```
async fn shutdown(self) -> std::io::Result<()>
```

**Purpose**: Shuts down the underlying app-server client connection.

**Data flow**: It consumes `self`, delegates to `self.client.shutdown().await`, and returns `std::io::Result<()>`.

**Call relations**: Called during app teardown and by background page-loader cleanup so the transport is closed cleanly.

*Call graph*: calls 1 internal fn (shutdown); called by 2 (run, spawn_app_server_page_loader).


##### `AppServerSession::request_handle`  (lines 1134–1136)

```
fn request_handle(&self) -> AppServerRequestHandle
```

**Purpose**: Exposes a clonable request handle for spawning independent RPC tasks outside the mutable session borrow.

**Data flow**: It delegates to `self.client.request_handle()` and returns `AppServerRequestHandle`.

**Call relations**: Many background fetch helpers use this to issue RPCs concurrently without holding `&mut AppServerSession`, including startup thread start and plugin/connector/usage fetches.

*Call graph*: calls 1 internal fn (request_handle); called by 29 (run, consume_rate_limit_reset_credit, fetch_connectors_list, fetch_hooks_list, fetch_marketplace_add, fetch_marketplace_remove, fetch_marketplace_upgrade, fetch_mcp_inventory, fetch_plugin_detail, fetch_plugin_install (+15 more)).


##### `AppServerSession::next_request_id`  (lines 1138–1142)

```
fn next_request_id(&mut self) -> RequestId
```

**Purpose**: Allocates the next monotonically increasing integer JSON-RPC request id for this session.

**Data flow**: It reads `self.next_request_id`, increments the stored counter by one, wraps the previous value in `RequestId::Integer`, and returns it.

**Call relations**: Nearly every typed RPC method calls this before constructing its request so ids remain unique within the session.

*Call graph*: called by 35 (bootstrap, external_agent_config_detect, external_agent_config_import, fork_thread, logout_account, memory_reset, read_account, reload_user_config, resume_thread, review_start (+15 more)); 1 external calls (Integer).


##### `start_thread_with_request_handle`  (lines 1145–1164)

```
async fn start_thread_with_request_handle(
    request_handle: AppServerRequestHandle,
    config: Config,
    thread_params_mode: ThreadParamsMode,
    remote_cwd_override: Option<PathBuf>,
) -> Resu
```

**Purpose**: Starts a thread using a detached request handle instead of a mutable session, primarily for startup tasks spawned off the main session object.

**Data flow**: It takes an `AppServerRequestHandle`, owned `Config`, `ThreadParamsMode`, and optional remote cwd override. It sends `ClientRequest::ThreadStart` with a string request id of the form `startup-thread-start-<uuid>`, using `thread_start_params_from_config`, then maps the `ThreadStartResponse` through `started_thread_from_start_response` and returns `AppServerStartedThread`.

**Call relations**: Startup-thread spawning uses this helper when it needs to issue the thread-start RPC concurrently without borrowing the main `AppServerSession` mutably.

*Call graph*: calls 3 internal fn (request_typed, started_thread_from_start_response, thread_start_params_from_config); called by 1 (spawn_startup_thread_start); 2 external calls (String, format!).


##### `status_account_display_from_auth_mode`  (lines 1166–1182)

```
fn status_account_display_from_auth_mode(
    auth_mode: Option<AuthMode>,
    plan_type: Option<codex_protocol::account::PlanType>,
) -> Option<StatusAccountDisplay>
```

**Purpose**: Maps app-server auth mode and optional plan type into the TUI's compact status-line account display model.

**Data flow**: It pattern-matches `auth_mode`. API-key auth becomes `Some(StatusAccountDisplay::ApiKey)`. ChatGPT-like auth modes become `Some(StatusAccountDisplay::ChatGpt { email: None, plan: plan_type.map(plan_type_display_name) })`. Bedrock and `None` return `None`.

**Call relations**: Notification handling uses this when account/auth updates arrive from the server, and tests verify the plan-label remapping behavior.

*Call graph*: called by 2 (handle_server_notification_event, status_account_display_from_auth_mode_uses_remapped_plan_labels).


##### `model_preset_from_api_model`  (lines 1184–1236)

```
fn model_preset_from_api_model(model: ApiModel) -> ModelPreset
```

**Purpose**: Converts an app-server `Model` record into the TUI/core `ModelPreset` structure used by pickers and config logic.

**Data flow**: It consumes `ApiModel`, optionally builds a `ModelUpgrade` from `model.upgrade` and `model.upgrade_info`, maps supported reasoning efforts into `ReasoningEffortPreset` values, maps service tiers into `ModelServiceTier` values, copies display and capability fields, sets `show_in_picker` to `!model.hidden`, wraps availability NUX text when present, and returns a populated `ModelPreset` with `supported_in_api: true`.

**Call relations**: Bootstrap uses this while processing `model/list` results so the rest of the TUI can work with the shared `ModelPreset` type rather than raw app-server model records.


##### `approvals_reviewer_override_from_config`  (lines 1238–1242)

```
fn approvals_reviewer_override_from_config(
    config: &Config,
) -> Option<codex_app_server_protocol::ApprovalsReviewer>
```

**Purpose**: Extracts the configured approvals reviewer and converts it into the app-server protocol type.

**Data flow**: It reads `config.approvals_reviewer`, converts it with `into()`, wraps it in `Some`, and returns it.

**Call relations**: All thread lifecycle param builders call this so start/resume/fork requests consistently carry the current reviewer setting.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config).


##### `config_request_overrides_from_config`  (lines 1244–1286)

```
fn config_request_overrides_from_config(
    config: &Config,
) -> Option<HashMap<String, serde_json::Value>>
```

**Purpose**: Builds the optional config-overrides map that thread lifecycle requests send to the app server.

**Data flow**: It creates a mutable `HashMap<String, serde_json::Value>`, inserts string values for `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `personality`, and `web_search` when present/applicable, inserts boolean `bypass_hook_trust` when enabled, and returns `Some(overrides)`.

**Call relations**: Thread start/resume/fork param builders call this to forward selected local config knobs into app-server thread configuration. Tests document that implicit default personality is omitted while explicit `Personality::None` is preserved.

*Call graph*: called by 4 (config_request_overrides_preserve_implicit_personality_default, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 1 external calls (new).


##### `service_tier_override_from_config`  (lines 1288–1293)

```
fn service_tier_override_from_config(config: &Config) -> Option<Option<String>>
```

**Purpose**: Computes the service-tier request field from config, including the fast-default opt-out sentinel.

**Data flow**: It reads `config.service_tier`; if present it returns `Some(Some(value))`. Otherwise, if `config.notices.fast_default_opt_out == Some(true)`, it returns `Some(Some(SERVICE_TIER_DEFAULT_REQUEST_VALUE.to_string()))`. If neither applies, it returns `None`.

**Call relations**: Lifecycle param builders use this helper so service-tier forwarding is consistent across start, resume, and fork requests.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config).


##### `sandbox_mode_from_permission_profile`  (lines 1295–1318)

```
fn sandbox_mode_from_permission_profile(
    permission_profile: &PermissionProfile,
    cwd: &std::path::Path,
) -> Option<codex_app_server_protocol::SandboxMode>
```

**Purpose**: Projects a rich permission profile into the coarse legacy sandbox mode needed for remote lifecycle requests when no named permission profile id is being sent.

**Data flow**: It takes a `&PermissionProfile` and cwd path. `Disabled` maps to `DangerFullAccess`. `External` maps to `None`. `Managed` inspects file-system and network sandbox policies: full-disk write plus enabled network yields `DangerFullAccess`; write access to cwd/project roots yields `WorkspaceWrite`; otherwise `ReadOnly`. It returns `Option<codex_app_server_protocol::SandboxMode>`.

**Call relations**: Remote lifecycle param tests and request builders rely on this projection when a named permission profile cannot be forwarded, ensuring remote servers still receive an approximate sandbox mode.

*Call graph*: calls 2 internal fn (file_system_sandbox_policy, network_sandbox_policy); called by 2 (thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions, thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions).


##### `permission_profile_id_from_active_profile`  (lines 1320–1322)

```
fn permission_profile_id_from_active_profile(active: ActivePermissionProfile) -> String
```

**Purpose**: Extracts the stable profile id string from an `ActivePermissionProfile`.

**Data flow**: It consumes `ActivePermissionProfile` and returns its `id` field.

**Call relations**: This tiny helper is used by permission-selection and turn-override code so profile-id extraction stays explicit and centralized.

*Call graph*: called by 3 (embedded_turn_permissions_use_active_profile_selection, remote_turn_permissions_preserve_active_profile_selection, turn_permissions_overrides).


##### `turn_permissions_overrides`  (lines 1324–1351)

```
fn turn_permissions_overrides(
    permissions_override: TurnPermissionsOverride,
    cwd: &std::path::Path,
) -> (
    Option<codex_app_server_protocol::SandboxPolicy>,
    Option<String>,
)
```

**Purpose**: Translates a per-turn permission override choice into the pair of app-server fields used by `turn/start`: legacy sandbox policy and named permission profile id.

**Data flow**: It takes a `TurnPermissionsOverride` and cwd path. `Preserve` returns `(None, None)`. `ActiveProfile(active)` returns `(None, Some(permission_profile_id_from_active_profile(active)))`. `LegacySandbox(profile)` converts the profile through `legacy_compatible_permission_profile`, projects it to a legacy sandbox policy for the cwd, converts that into app-server form, and returns `(Some(policy), None)`.

**Call relations**: Called only by `turn_start`, this helper encapsulates the mutually exclusive choice between preserving sticky thread permissions, selecting a named profile, or forcing a legacy sandbox override.

*Call graph*: calls 2 internal fn (permission_profile_id_from_active_profile, legacy_compatible_permission_profile); called by 6 (turn_start, embedded_turn_permissions_select_profile_id_only, embedded_turn_permissions_use_active_profile_selection, legacy_turn_permissions_project_to_sandbox_when_explicitly_overridden, remote_turn_permissions_preserve_active_profile_selection, turn_permissions_preserve_thread_permissions_without_override).


##### `permissions_selection_from_config`  (lines 1353–1365)

```
fn permissions_selection_from_config(
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Option<String>
```

**Purpose**: Determines whether lifecycle requests should send a named active permission profile id from config.

**Data flow**: It takes `&Config` and `ThreadParamsMode`. In `Remote` mode it returns `None`. In `Embedded` mode it reads `config.permissions.active_permission_profile()` and maps it through `permission_profile_id_from_active_profile`.

**Call relations**: Thread start/resume/fork param builders use this to decide whether to send `permissions` or fall back to a projected sandbox mode.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 1 external calls (matches!).


##### `thread_start_params_from_config`  (lines 1367–1402)

```
fn thread_start_params_from_config(
    config: &Config,
    thread_params_mode: ThreadParamsMode,
    remote_cwd_override: Option<&std::path::Path>,
    session_start_source: Option<ThreadStartSource
```

**Purpose**: Builds `ThreadStartParams` from local config, session mode, optional remote cwd override, and optional session-start source.

**Data flow**: It reads config fields for model, workspace roots, approval policy, reviewer, ephemeral flag, and instructions; computes `permissions` via `permissions_selection_from_config`; if no named permissions are sent, computes `sandbox` via `sandbox_mode_from_permission_profile`; computes model provider, service tier, cwd, config overrides, and developer instructions via helper functions; sets `thread_source` to `Some(ThreadSource::User)`; and returns a populated `ThreadStartParams` with remaining fields from `Default::default()`.

**Call relations**: Used by both mutable-session and detached-request-handle thread-start paths. It is the canonical request-shaping function for new-session creation.

*Call graph*: calls 7 internal fn (model_provider_from_config, approvals_reviewer_override_from_config, config_request_overrides_from_config, permissions_selection_from_config, service_tier_override_from_config, thread_cwd_from_config, with_terminal_visualization_instructions); called by 8 (start_thread_with_session_start_source, start_thread_with_request_handle, terminal_visualization_instructions_are_gated_for_all_tui_thread_flows, thread_lifecycle_params_forward_config_overrides_and_service_tier, thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions, thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions, thread_start_params_can_mark_clear_source, thread_start_params_include_cwd_for_embedded_sessions); 1 external calls (default).


##### `thread_resume_params_from_config`  (lines 1404–1437)

```
fn thread_resume_params_from_config(
    config: Config,
    thread_id: ThreadId,
    thread_params_mode: ThreadParamsMode,
    remote_cwd_override: Option<&std::path::Path>,
) -> ThreadResumeParams
```

**Purpose**: Builds `ThreadResumeParams` from config and target thread id, mirroring start-parameter logic for resumed sessions.

**Data flow**: It consumes `Config`, takes `ThreadId`, mode, and optional remote cwd override, computes permissions/sandbox/model provider/service tier/cwd/config overrides/developer instructions similarly to start params, stringifies the thread id, and returns `ThreadResumeParams` with defaults for unspecified fields.

**Call relations**: Resume flows call this before issuing `thread/resume`, ensuring resumed sessions inherit the same config-derived overrides and mode-specific behavior as fresh starts.

*Call graph*: calls 7 internal fn (model_provider_from_config, approvals_reviewer_override_from_config, config_request_overrides_from_config, permissions_selection_from_config, service_tier_override_from_config, thread_cwd_from_config, with_terminal_visualization_instructions); called by 5 (resume_thread, terminal_visualization_instructions_are_gated_for_all_tui_thread_flows, thread_lifecycle_params_forward_config_overrides_and_service_tier, thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions, thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions); 2 external calls (default, to_string).


##### `thread_fork_params_from_config`  (lines 1439–1476)

```
fn thread_fork_params_from_config(
    config: Config,
    thread_id: ThreadId,
    thread_params_mode: ThreadParamsMode,
    remote_cwd_override: Option<&std::path::Path>,
) -> ThreadForkParams
```

**Purpose**: Builds `ThreadForkParams` from config and source thread id, including base/developer instruction overrides and ephemeral/thread-source flags.

**Data flow**: It consumes `Config`, takes `ThreadId`, mode, and optional remote cwd override, computes permissions/sandbox/model provider/service tier/cwd/config overrides, forwards `base_instructions`, computes developer instructions with terminal-visualization gating, sets `ephemeral` and `thread_source`, stringifies the thread id, and returns `ThreadForkParams`.

**Call relations**: Fork flows use this as the canonical request builder, and tests verify that it forwards instruction overrides and mode-specific cwd/provider behavior correctly.

*Call graph*: calls 7 internal fn (model_provider_from_config, approvals_reviewer_override_from_config, config_request_overrides_from_config, permissions_selection_from_config, service_tier_override_from_config, thread_cwd_from_config, with_terminal_visualization_instructions); called by 6 (fork_thread, terminal_visualization_instructions_are_gated_for_all_tui_thread_flows, thread_fork_params_forward_instruction_overrides, thread_lifecycle_params_forward_config_overrides_and_service_tier, thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions, thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions); 2 external calls (default, to_string).


##### `thread_cwd_from_config`  (lines 1478–1489)

```
fn thread_cwd_from_config(
    config: &Config,
    thread_params_mode: ThreadParamsMode,
    remote_cwd_override: Option<&std::path::Path>,
) -> Option<String>
```

**Purpose**: Determines the cwd string to send in lifecycle requests based on embedded vs remote mode.

**Data flow**: It takes `&Config`, `ThreadParamsMode`, and optional remote cwd override. In `Embedded` mode it returns `Some(config.cwd.to_string_lossy().to_string())`. In `Remote` mode it returns the override path string if present, otherwise `None`.

**Call relations**: All lifecycle param builders call this so cwd forwarding is consistent and remote sessions omit local cwd unless an explicit server-side override is known.

*Call graph*: called by 3 (thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config).


##### `started_thread_from_start_response`  (lines 1491–1504)

```
async fn started_thread_from_start_response(
    response: ThreadStartResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<AppServerStartedThread>
```

**Purpose**: Maps a `ThreadStartResponse` into the TUI's `AppServerStartedThread` bundle.

**Data flow**: It takes the typed response plus config and mode, calls `thread_session_state_from_thread_start_response` to build `ThreadSessionState`, and returns `AppServerStartedThread { session, turns: response.thread.turns }`.

**Call relations**: Both session-bound and detached startup thread creation delegate to this helper after the raw RPC succeeds.

*Call graph*: calls 1 internal fn (thread_session_state_from_thread_start_response); called by 2 (start_thread_with_session_start_source, start_thread_with_request_handle).


##### `started_thread_from_resume_response`  (lines 1506–1519)

```
async fn started_thread_from_resume_response(
    response: ThreadResumeResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<AppServerStartedThread>
```

**Purpose**: Maps a `ThreadResumeResponse` into `AppServerStartedThread`.

**Data flow**: It takes the response plus config and mode, calls `thread_session_state_from_thread_resume_response`, and returns the resulting session together with `response.thread.turns`.

**Call relations**: Resume flows use this helper to convert raw app-server data into the TUI's session-state representation.

*Call graph*: calls 1 internal fn (thread_session_state_from_thread_resume_response); called by 2 (resume_thread, resume_response_restores_turns_from_thread_items).


##### `started_thread_from_fork_response`  (lines 1521–1534)

```
async fn started_thread_from_fork_response(
    response: ThreadForkResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<AppServerStartedThread>
```

**Purpose**: Maps a `ThreadForkResponse` into `AppServerStartedThread`.

**Data flow**: It takes the response plus config and mode, calls `thread_session_state_from_thread_fork_response`, and returns the mapped session plus `response.thread.turns`.

**Call relations**: Fork flows delegate response mapping here after the RPC completes.

*Call graph*: calls 1 internal fn (thread_session_state_from_thread_fork_response); called by 1 (fork_thread).


##### `thread_session_state_from_thread_start_response`  (lines 1536–1566)

```
async fn thread_session_state_from_thread_start_response(
    response: &ThreadStartResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<ThreadSessionState, String>
```

**Purpose**: Builds `ThreadSessionState` from a thread-start response, deriving the display permission profile for the new session.

**Data flow**: It reads sandbox, cwd, config, and mode to compute `permission_profile` via `display_permission_profile_from_thread_response`, then forwards all relevant response fields plus config into `thread_session_state_from_thread_response`.

**Call relations**: Called only by `started_thread_from_start_response`, this helper isolates the start-response-specific field extraction before the common session-state mapper.

*Call graph*: calls 2 internal fn (display_permission_profile_from_thread_response, thread_session_state_from_thread_response); called by 1 (started_thread_from_start_response).


##### `thread_session_state_from_thread_resume_response`  (lines 1568–1607)

```
async fn thread_session_state_from_thread_resume_response(
    response: &ThreadResumeResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<ThreadSessionState, String>
```

**Purpose**: Builds `ThreadSessionState` from a resume response, with a special embedded-session fallback for legacy sandbox-only responses.

**Data flow**: It checks whether the mode is `Embedded` and `response.active_permission_profile` is `None`; in that case it reconstructs `PermissionProfile` from `response.sandbox.to_core()` and cwd. Otherwise it uses `display_permission_profile_from_thread_response`. It then forwards all thread/session fields into `thread_session_state_from_thread_response`.

**Call relations**: Used by `started_thread_from_resume_response`. The embedded fallback preserves correct display permissions when older responses lack an active profile id.

*Call graph*: calls 3 internal fn (from_legacy_sandbox_policy_for_cwd, display_permission_profile_from_thread_response, thread_session_state_from_thread_response); called by 1 (started_thread_from_resume_response); 1 external calls (matches!).


##### `thread_session_state_from_thread_fork_response`  (lines 1609–1639)

```
async fn thread_session_state_from_thread_fork_response(
    response: &ThreadForkResponse,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
) -> Result<ThreadSessionState, String>
```

**Purpose**: Builds `ThreadSessionState` from a fork response.

**Data flow**: It derives `permission_profile` with `display_permission_profile_from_thread_response`, then forwards thread ids, names, model settings, cwd, workspace roots, instruction sources, reasoning effort, and config into `thread_session_state_from_thread_response`.

**Call relations**: Called by `started_thread_from_fork_response` as the fork-specific adapter into the common session-state mapper.

*Call graph*: calls 2 internal fn (display_permission_profile_from_thread_response, thread_session_state_from_thread_response); called by 1 (started_thread_from_fork_response).


##### `display_permission_profile_from_thread_response`  (lines 1641–1653)

```
fn display_permission_profile_from_thread_response(
    sandbox: &codex_app_server_protocol::SandboxPolicy,
    cwd: &std::path::Path,
    config: &Config,
    thread_params_mode: ThreadParamsMode,
)
```

**Purpose**: Chooses the permission profile the TUI should display for a thread response, depending on whether the session is embedded or remote.

**Data flow**: It takes app-server `SandboxPolicy`, cwd, config, and mode. In `Embedded` mode it returns `config.permissions.effective_permission_profile()`. In `Remote` mode it converts the sandbox policy to core form and reconstructs a `PermissionProfile` from it for the given cwd.

**Call relations**: All thread-response-to-session-state helpers call this unless resume uses its embedded legacy fallback. It centralizes the distinction between trusting local config for embedded sessions and reconstructing from server sandbox for remote ones.

*Call graph*: calls 2 internal fn (to_core, from_legacy_sandbox_policy_for_cwd); called by 3 (thread_session_state_from_thread_fork_response, thread_session_state_from_thread_resume_response, thread_session_state_from_thread_start_response).


##### `thread_session_state_from_thread_response`  (lines 1659–1712)

```
async fn thread_session_state_from_thread_response(
    thread_id: &str,
    forked_from_id: Option<String>,
    thread_name: Option<String>,
    rollout_path: Option<PathBuf>,
    model: String,
```

**Purpose**: Performs the final mapping from raw thread/session response fields into the TUI's `ThreadSessionState`, including message-history metadata lookup.

**Data flow**: It takes explicit thread/session fields, parses `thread_id` and optional `forked_from_id` strings into `ThreadId`s, constructs a `codex_message_history::HistoryConfig` from `config.codex_home` and `config.history`, asynchronously reads `(log_id, entry_count)` via `history_metadata`, and returns a populated `ThreadSessionState` containing ids, names, model/provider/service tier, approval settings, permission profile, active profile, cwd, workspace roots, instruction source paths, reasoning effort, personality from config, and `MessageHistoryMetadata { log_id, entry_count }`.

**Call relations**: This is the common sink for start/resume/fork response mapping. The specialized helpers gather the right fields and permission-profile interpretation, then delegate here for final state construction.

*Call graph*: calls 2 internal fn (new, from_string); called by 5 (session_configured_populates_history_metadata, session_configured_preserves_fork_source_thread_id, thread_session_state_from_thread_fork_response, thread_session_state_from_thread_resume_response, thread_session_state_from_thread_start_response); 1 external calls (history_metadata).


##### `app_server_rate_limit_snapshots`  (lines 1714–1732)

```
fn app_server_rate_limit_snapshots(
    response: GetAccountRateLimitsResponse,
) -> Vec<RateLimitSnapshot>
```

**Purpose**: Normalizes a rate-limit response into a deduplicated vector of snapshots, combining the top-level snapshot with any per-limit map entries.

**Data flow**: It takes `GetAccountRateLimitsResponse`, stores the top-level `limit_id`, starts a vector with `response.rate_limits`, then extends it with entries from `rate_limits_by_limit_id` except those whose key or nested `snapshot.limit_id` matches the primary limit id. It returns the resulting `Vec<RateLimitSnapshot>`.

**Call relations**: This helper is primarily documented by tests and is used where callers need a flat list of snapshots without duplicate inclusion of the primary top-level limit.

*Call graph*: called by 1 (app_server_rate_limit_snapshots_deduplicates_top_level_limit_from_map); 1 external calls (vec!).


##### `tests::build_config`  (lines 1762–1768)

```
async fn build_config(temp_dir: &TempDir) -> Config
```

**Purpose**: Creates a minimal test `Config` rooted in a temporary Codex home directory.

**Data flow**: It takes `&TempDir`, feeds `temp_dir.path().to_path_buf()` into `ConfigBuilder::default().codex_home(...)`, awaits `build()`, and returns the resulting `Config` or panics on failure.

**Call relations**: Many tests in this module use it to avoid repeating baseline config construction.

*Call graph*: 2 external calls (path, default).


##### `tests::rate_limit_snapshot`  (lines 1770–1785)

```
fn rate_limit_snapshot(limit_id: &str) -> RateLimitSnapshot
```

**Purpose**: Builds a simple `RateLimitSnapshot` fixture with a chosen `limit_id` and otherwise minimal fields.

**Data flow**: It takes `&str`, clones it into `limit_id`, fills a `RateLimitSnapshot` with a default primary window and `None` for optional fields, and returns it.

**Call relations**: Used by the rate-limit deduplication test to create concise fixture data.


##### `tests::app_server_rate_limit_snapshots_deduplicates_top_level_limit_from_map`  (lines 1788–1807)

```
fn app_server_rate_limit_snapshots_deduplicates_top_level_limit_from_map()
```

**Purpose**: Verifies that `app_server_rate_limit_snapshots` keeps the top-level snapshot and excludes duplicate map entries for the same limit id.

**Data flow**: It constructs a `GetAccountRateLimitsResponse` with one top-level snapshot and a map containing both duplicate and distinct ids, calls `app_server_rate_limit_snapshots`, extracts returned limit ids, and asserts the expected order/content.

**Call relations**: This test documents the deduplication rule implemented by `app_server_rate_limit_snapshots`.

*Call graph*: calls 1 internal fn (app_server_rate_limit_snapshots); 3 external calls (from, assert_eq!, rate_limit_snapshot).


##### `tests::thread_settings_update_compat_detects_unsupported_errors`  (lines 1810–1838)

```
fn thread_settings_update_compat_detects_unsupported_errors()
```

**Purpose**: Checks which JSON-RPC error shapes are treated as unsupported `thread/settings/update` capability failures.

**Data flow**: It iterates over a table of `(code, message, expected)` cases, constructs `JSONRPCErrorError` values, calls `is_thread_settings_update_unsupported`, and asserts the expected boolean for each case.

**Call relations**: This test locks down the compatibility-downgrade heuristic used by `AppServerSession::thread_settings_update`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::thread_start_params_include_cwd_for_embedded_sessions`  (lines 1841–1875)

```
async fn thread_start_params_include_cwd_for_embedded_sessions()
```

**Purpose**: Verifies that embedded-session start params include local cwd, workspace roots, active permission profile id, model provider, and user thread source.

**Data flow**: It builds a config with workspace permissions, calls `thread_start_params_from_config` in `Embedded` mode, and asserts expected values for `cwd`, `runtime_workspace_roots`, `sandbox`, `permissions`, `model_provider`, and `thread_source`.

**Call relations**: This test documents the embedded-mode branch of lifecycle request shaping.

*Call graph*: calls 1 internal fn (thread_start_params_from_config); 4 external calls (assert_eq!, default, default, tempdir).


##### `tests::thread_start_params_can_mark_clear_source`  (lines 1878–1890)

```
async fn thread_start_params_can_mark_clear_source()
```

**Purpose**: Checks that a start request can carry `ThreadStartSource::Clear` as its session-start source.

**Data flow**: It builds a config, calls `thread_start_params_from_config` with `Some(ThreadStartSource::Clear)`, and asserts that `params.session_start_source` matches.

**Call relations**: This test covers the clear-UI handoff path encoded in start params.

*Call graph*: calls 1 internal fn (thread_start_params_from_config); 3 external calls (assert_eq!, tempdir, build_config).


##### `tests::embedded_turn_permissions_use_active_profile_selection`  (lines 1893–1907)

```
fn embedded_turn_permissions_use_active_profile_selection()
```

**Purpose**: Verifies that an embedded turn override using an active profile produces only a permission-profile id, not a sandbox policy.

**Data flow**: It builds a cwd and `ActivePermissionProfile`, computes the expected id via `permission_profile_id_from_active_profile`, calls `turn_permissions_overrides`, and asserts `(None, Some(expected_id))`.

**Call relations**: This test documents the active-profile branch of per-turn permission override handling.

*Call graph*: calls 3 internal fn (new, permission_profile_id_from_active_profile, turn_permissions_overrides); 3 external calls (assert_eq!, test_path_buf, ActiveProfile).


##### `tests::embedded_turn_permissions_select_profile_id_only`  (lines 1910–1925)

```
fn embedded_turn_permissions_select_profile_id_only()
```

**Purpose**: Checks that active-profile turn overrides preserve the exact built-in profile id string.

**Data flow**: It constructs a workspace active profile, calls `turn_permissions_overrides`, and asserts that `permissions` equals the built-in workspace profile id while `sandbox_policy` is `None`.

**Call relations**: This is a narrower assertion on the same active-profile override behavior.

*Call graph*: calls 2 internal fn (new, turn_permissions_overrides); 3 external calls (assert_eq!, test_path_buf, ActiveProfile).


##### `tests::turn_permissions_preserve_thread_permissions_without_override`  (lines 1928–1936)

```
fn turn_permissions_preserve_thread_permissions_without_override()
```

**Purpose**: Verifies that `TurnPermissionsOverride::Preserve` leaves both sandbox policy and permission-profile id unset.

**Data flow**: It builds a cwd, calls `turn_permissions_overrides(TurnPermissionsOverride::Preserve, ...)`, and asserts both returned options are `None`.

**Call relations**: This test documents the no-override branch used when a turn should inherit sticky thread permissions unchanged.

*Call graph*: calls 1 internal fn (turn_permissions_overrides); 2 external calls (assert_eq!, test_path_buf).


##### `tests::legacy_turn_permissions_project_to_sandbox_when_explicitly_overridden`  (lines 1939–1954)

```
fn legacy_turn_permissions_project_to_sandbox_when_explicitly_overridden()
```

**Purpose**: Checks that an explicit legacy read-only permission override is projected into a legacy app-server sandbox policy.

**Data flow**: It builds a cwd, calls `turn_permissions_overrides` with `LegacySandbox(PermissionProfile::read_only())`, and asserts that the returned sandbox policy is `ReadOnly { network_access: false }` and `permissions` is `None`.

**Call relations**: This test covers the legacy-sandbox branch of turn permission overrides.

*Call graph*: calls 2 internal fn (read_only, turn_permissions_overrides); 3 external calls (assert_eq!, test_path_buf, LegacySandbox).


##### `tests::remote_turn_permissions_preserve_active_profile_selection`  (lines 1957–1970)

```
fn remote_turn_permissions_preserve_active_profile_selection()
```

**Purpose**: Verifies that active-profile turn overrides also work in remote contexts by forwarding the profile id unchanged.

**Data flow**: It constructs a cwd and custom active profile, computes the expected id, calls `turn_permissions_overrides`, and asserts `(None, Some(expected_id))`.

**Call relations**: This test shows that per-turn active-profile selection is not limited to embedded sessions.

*Call graph*: calls 3 internal fn (new, permission_profile_id_from_active_profile, turn_permissions_overrides); 3 external calls (assert_eq!, test_path_buf, ActiveProfile).


##### `tests::thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions`  (lines 1973–2028)

```
async fn thread_lifecycle_params_omit_cwd_without_remote_override_for_remote_sessions()
```

**Purpose**: Verifies that remote start/resume/fork params omit cwd and model provider when no remote cwd override is supplied, while still forwarding workspace roots and projected sandbox mode.

**Data flow**: It builds a config and thread id, computes expected sandbox and workspace roots, calls all three lifecycle param builders in `Remote` mode with no override, and asserts `cwd == None`, `model_provider == None`, expected roots, expected sandbox, no `permissions`, and user thread source where applicable.

**Call relations**: This test documents the core remote-session shaping rule that local cwd/provider are not forwarded unless explicitly overridden.

*Call graph*: calls 5 internal fn (new, sandbox_mode_from_permission_profile, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 3 external calls (assert_eq!, tempdir, build_config).


##### `tests::sandbox_mode_does_not_project_non_cwd_write_roots_for_remote_sessions`  (lines 2031–2057)

```
fn sandbox_mode_does_not_project_non_cwd_write_roots_for_remote_sessions()
```

**Purpose**: Checks that write access to a non-cwd extra root does not get over-projected to workspace-write sandbox mode.

**Data flow**: It constructs a managed `PermissionProfile` with read root plus write access to an extra path outside cwd, calls `sandbox_mode_from_permission_profile`, and asserts `ReadOnly`.

**Call relations**: This test captures an important safety invariant in sandbox projection for remote sessions.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `tests::sandbox_mode_projects_cwd_write_for_remote_sessions`  (lines 2060–2087)

```
fn sandbox_mode_projects_cwd_write_for_remote_sessions()
```

**Purpose**: Verifies that write access to project roots does project to `WorkspaceWrite` sandbox mode.

**Data flow**: It constructs a managed permission profile with read root and write access to `ProjectRoots`, calls `sandbox_mode_from_permission_profile`, and asserts `WorkspaceWrite`.

**Call relations**: This complements the previous test by documenting the positive case for workspace-write projection.

*Call graph*: 3 external calls (assert_eq!, test_path_buf, vec!).


##### `tests::thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions`  (lines 2090–2133)

```
async fn thread_lifecycle_params_forward_explicit_remote_cwd_override_for_remote_sessions()
```

**Purpose**: Checks that remote lifecycle params forward an explicit server-side cwd override while still omitting model provider and named permissions.

**Data flow**: It builds a config, thread id, and `PathBuf` override, computes expected sandbox, calls start/resume/fork param builders in `Remote` mode with the override, and asserts the forwarded cwd string plus expected sandbox/provider/permissions/thread-source values.

**Call relations**: This test documents the remote override path used when the TUI knows the server-side repository location.

*Call graph*: calls 5 internal fn (new, sandbox_mode_from_permission_profile, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 4 external calls (from, assert_eq!, tempdir, build_config).


##### `tests::thread_lifecycle_params_forward_config_overrides_and_service_tier`  (lines 2136–2186)

```
async fn thread_lifecycle_params_forward_config_overrides_and_service_tier()
```

**Purpose**: Verifies that lifecycle params forward reasoning, summary, verbosity, personality, web-search, bypass-hook-trust, and explicit service-tier config overrides.

**Data flow**: It mutates a test config to set those fields, calls start/resume/fork param builders, constructs the expected JSON override map and service-tier value, and asserts equality for each request type.

**Call relations**: This test locks down the contents of `config_request_overrides_from_config` and `service_tier_override_from_config` as used by lifecycle requests.

*Call graph*: calls 4 internal fn (new, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 4 external calls (from, assert_eq!, tempdir, build_config).


##### `tests::config_request_overrides_preserve_implicit_personality_default`  (lines 2189–2207)

```
async fn config_request_overrides_preserve_implicit_personality_default()
```

**Purpose**: Checks that implicit default personality is omitted from config overrides, while an explicit `none` personality is preserved.

**Data flow**: It builds a config, first leaves `personality = None` and asserts the override map lacks the key, then sets `personality = Some(Personality::None)` and asserts the map contains `"personality": "none"`.

**Call relations**: This test documents a subtle distinction in override generation between absent and explicitly selected personality.

*Call graph*: calls 1 internal fn (config_request_overrides_from_config); 4 external calls (assert!, assert_eq!, tempdir, build_config).


##### `tests::thread_fork_params_forward_instruction_overrides`  (lines 2210–2229)

```
async fn thread_fork_params_forward_instruction_overrides()
```

**Purpose**: Verifies that fork params include explicit base and developer instruction overrides from config.

**Data flow**: It builds a config with `base_instructions` and `developer_instructions`, calls `thread_fork_params_from_config`, and asserts those fields are forwarded.

**Call relations**: This test covers fork-specific instruction forwarding behavior.

*Call graph*: calls 2 internal fn (new, thread_fork_params_from_config); 3 external calls (assert_eq!, tempdir, build_config).


##### `tests::terminal_visualization_instructions_are_gated_for_all_tui_thread_flows`  (lines 2232–2302)

```
async fn terminal_visualization_instructions_are_gated_for_all_tui_thread_flows()
```

**Purpose**: Checks that terminal-visualization instructions are appended to developer instructions only when the corresponding feature flag is enabled, across start/resume/fork flows.

**Data flow**: It builds a config with developer instructions, calls lifecycle param builders before and after enabling `Feature::TerminalVisualizationInstructions`, and asserts the expected developer-instructions strings in each case.

**Call relations**: This test documents the feature-gated behavior of `with_terminal_visualization_instructions` as used by all lifecycle request builders.

*Call graph*: calls 4 internal fn (new, thread_fork_params_from_config, thread_resume_params_from_config, thread_start_params_from_config); 4 external calls (assert_eq!, format!, tempdir, build_config).


##### `tests::resume_response_restores_turns_from_thread_items`  (lines 2305–2426)

```
async fn resume_response_restores_turns_from_thread_items()
```

**Purpose**: Verifies that resume-response mapping preserves turns, fork ancestry, workspace roots, instruction sources, and permission-profile interpretation for both remote and embedded modes.

**Data flow**: It constructs a detailed `ThreadResumeResponse` fixture with one completed turn and a read-only sandbox, calls `started_thread_from_resume_response` in remote and embedded modes, and asserts session fields and returned turns. It also tests an empty `runtime_workspace_roots` case.

**Call relations**: This test exercises the resume-response mapping pipeline, especially `thread_session_state_from_thread_resume_response` and permission-profile fallback behavior.

*Call graph*: calls 3 internal fn (read_only, new, started_thread_from_resume_response); 8 external calls (new, assert_eq!, test_path_buf, default, default, tempdir, build_config, vec!).


##### `tests::remote_thread_response_uses_legacy_sandbox_fallback`  (lines 2429–2447)

```
async fn remote_thread_response_uses_legacy_sandbox_fallback()
```

**Purpose**: Checks that remote thread responses derive display permissions from the returned legacy sandbox policy.

**Data flow**: It builds a read-only sandbox policy for a cwd, calls `display_permission_profile_from_thread_response` in `Remote` mode, and asserts the result is `PermissionProfile::read_only()`.

**Call relations**: This test documents the remote branch of display permission-profile derivation.

*Call graph*: calls 1 internal fn (read_only); 4 external calls (assert_eq!, test_path_buf, tempdir, build_config).


##### `tests::embedded_thread_response_uses_local_config_profile`  (lines 2450–2472)

```
async fn embedded_thread_response_uses_local_config_profile()
```

**Purpose**: Verifies that embedded thread responses display the local configured permission profile rather than trusting the returned sandbox policy.

**Data flow**: It builds a config whose default permissions are read-only, calls `display_permission_profile_from_thread_response` in `Embedded` mode with a `DangerFullAccess` sandbox, and asserts the displayed profile is still read-only.

**Call relations**: This test captures the embedded-session invariant that local config is authoritative for display permissions.

*Call graph*: 5 external calls (assert_eq!, test_path_buf, default, default, tempdir).


##### `tests::session_configured_populates_history_metadata`  (lines 2475–2516)

```
async fn session_configured_populates_history_metadata()
```

**Purpose**: Checks that mapped thread session state includes message-history metadata derived from the configured Codex home history log.

**Data flow**: It builds a config and history config, appends two history entries, calls `thread_session_state_from_thread_response`, extracts `session.message_history`, and asserts nonzero `log_id` and `entry_count == 2`.

**Call relations**: This test documents the side lookup performed by the common session-state mapper to attach cross-session history metadata.

*Call graph*: calls 4 internal fn (new, read_only, new, thread_session_state_from_thread_response); 7 external calls (new, assert_eq!, assert_ne!, append_entry, test_path_buf, tempdir, build_config).


##### `tests::session_configured_preserves_fork_source_thread_id`  (lines 2519–2547)

```
async fn session_configured_preserves_fork_source_thread_id()
```

**Purpose**: Verifies that the common session-state mapper preserves `forked_from_id` when present.

**Data flow**: It builds a config and thread ids, calls `thread_session_state_from_thread_response` with a `forked_from_id` string, and asserts the resulting session contains the parsed parent `ThreadId`.

**Call relations**: This test covers fork ancestry parsing in the common response-to-session-state mapper.

*Call graph*: calls 3 internal fn (read_only, new, thread_session_state_from_thread_response); 5 external calls (new, assert_eq!, test_path_buf, tempdir, build_config).


##### `tests::status_account_display_from_auth_mode_uses_remapped_plan_labels`  (lines 2550–2574)

```
fn status_account_display_from_auth_mode_uses_remapped_plan_labels()
```

**Purpose**: Checks that ChatGPT auth modes map enterprise/business plan variants to the remapped display labels used in status UI.

**Data flow**: It calls `status_account_display_from_auth_mode` with two plan types and asserts the returned `StatusAccountDisplay::ChatGpt` contains `"Enterprise"` and `"Business"` respectively.

**Call relations**: This test documents the plan-label normalization performed by `status_account_display_from_auth_mode`.

*Call graph*: calls 1 internal fn (status_account_display_from_auth_mode); 1 external calls (assert!).
